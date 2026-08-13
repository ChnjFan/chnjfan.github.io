+++
title = "断线之后：connection_lost 与状态清理"
description = ""
date = "2026-08-13"
aliases = ["MQTT-disconn"]
author = "ChnjFan"
tags = [
    "paho.mqtt.cpp",
    "MQTT",
]
categories = [
    "MQTT",
]
+++

`automatic_reconnect` 解决了「连接断了怎么连回来」，但有个更基础的问题：断连这件事，代码到底怎么感知到的？

用户注册了 `connection_lost` 回调，以为断线就一定会触发。直到某天日志里发现：连接确实断了、也确实重连了，可 `connection_lost` 一次都没调用。你怀疑库有 bug，其实是你搞错了回调的触发条件。

MQTT 断线有三条完全不同的路径，它们触发的回调组合、对会话的清理方式也不一样：

- 客户端主动断连：用户调 `disconnect()` 后向服务端发 DISCONNECT 报文断连
- 服务端主动断连：只有 MQTT 5.0 支持 Broker 下发 DISCONNECT（带原因码和属性），3.1.1 的 Broker 直接关闭 TCP 连接
- 意外断线：keepalive 超时、TCP 错误、对端崩溃

沿上面这三条路径看源码：`connection_lost` 到底什么时候触发、三种断线怎么区分、断线后会话会不会被清理。

主动断连调用 `checkDisconnect`，而其他断线路径最终都会调用 `nextOrClose`，所以本文会先讲清它的两个关键判断依据，再逐条路径梳理。这里先给出结论预告：

1. `connection_lost` 是否调用取决于进入 `nextOrClose` 之前 `connected` 状态是否被清零。
2. 三种路径的回调组合完全不同：主动断连调用 `on_success`；服务端 DISCONNECT 调用 `disconnected`（v5）+ `on_failure`；意外断线才触发 `connection_lost`。
3. 会话清理由 `closeOnly`（只关 socket，保留会话）和 `closeSession`（按 clean session / Session Expiry 清理）决定，多 URI 故障切换时走 `closeOnly` 保留会话。


## 主动断连：disconnect

用户调用 `disconnect()` 后，最终进入 `MQTTAsync_disconnect1`。它做的第一件事不是发报文，而是清掉「用户还想保持连接」的意图：

```c
// MQTTAsyncUtils.c:2713-2762（精简）
int MQTTAsync_disconnect1(MQTTAsync handle,
         const MQTTAsync_disconnectOptions* options, int internal)
{
    // 用户主动断连时，清除自动重连标志，防止自动重连
    if (!internal)
        m->shouldBeConnected = 0;

    if (m->c->connected == 0) // 已断开时直接返回
        return MQTTASYNC_DISCONNECTED;

    // 创建 DISCONNECT 命令
    dis = malloc(sizeof(MQTTAsync_queuedCommand));
    memset(dis, '\0', sizeof(MQTTAsync_queuedCommand));
    dis->client = m;

    if (options) { /*... 保存回调和参数 */ }

    // 设置命令类型
    dis->command.type = DISCONNECT;
    dis->command.details.dis.internal = internal;

    // 加入命令队列（插入头部）
    rc = MQTTAsync_addCommand(dis, sizeof(dis));
    return rc;
}
```

`shouldBeConnected = 0` 我们在「自动重连」中讲过，自动重连靠它来判断是否进行重连。这里被清零，意味着这次断连是用户主动行为，不需要进行重连。


### 命令执行：修改连接状态检查断连

sendThread 取出命令执行时，把连接的状态置为「正在断连」，然后直接调用断连检查：

```c
// paho.mqtt.c/src/MQTTAsyncUtils.c（节选）
static int MQTTAsync_processCommand(void)
{
    //... 处理其他命令
    else if (command->command.type == DISCONNECT)
    {
        if (command->client->c->connect_state != NOT_IN_PROGRESS
            || command->client->c->connected != 0)
        {
            if (command->client->c->connect_state != NOT_IN_PROGRESS)
            {
                // 连接还在建立中就想断连 报 OPERATION_INCOMPLETE
                data.code = MQTTASYNC_OPERATION_INCOMPLETE;
                (*(command->client->connect.onFailure))(
                    command->client->connect.context, &data);
            }
            command->client->c->connect_state = DISCONNECTING;   // 标记"正在断连"
            MQTTAsync_checkDisconnect(command->client, &command->command);
        }
    }
}
```

### checkDisconnect：等在途消息，然后关会话

等到所有的 QoS 1/2 在途消息都走完，再关闭连接调用回调。MQTT 协议要求客户端在断连前完成未确认的 QoS 消息流，否则消息可能两边对不上：

```c
// MQTTAsyncUtils.c:965-1002
void MQTTAsync_checkDisconnect(MQTTAsync handle, MQTTAsync_command* command)
{
    // 等待在途消息完成或超时
    if (m->c->outboundMsgs->count == 0 ||
        MQTTTime_elapsed(command->start_time)
            >= (ELAPSED_TIME_TYPE)command->details.dis.timeout)
    {
        int was_connected = m->c->connected;

        // 关闭会话（发送 DISCONNECT 包 + 关闭 socket）
        MQTTAsync_closeSession(m->c, command->details.dis.reasonCode,
                                &command->properties);

        // 根据断连类型调用不同回调
        if (command->details.dis.internal)  // 内部断连（如自动重连换 URI）
        {
            // 调用 connectionLost 回调
            if (m->cl && was_connected) {
                (*(m->cl))(m->clContext, NULL);
            }
            // 启动重连
            MQTTAsync_startConnectRetry(m);
        }
        else  // 用户主动断连
        {
            // 调用 onSuccess 回调
            if (command->onSuccess)
                (*(command->onSuccess))(command->context, &data);
            else if (command->onSuccess5)
                (*(command->onSuccess5))(command->context, &data);
        }
    }
}
```

注意 `was_connected` 在这里被保存时，`connected` 还是 1，因为真正把 `connected` 清成 0 的是接下来 `closeSession` 内部的 `closeOnly`。


### closeSession 与 closeOnly：是否清理会话

`closeSession` 比 `closeOnly` 多了一层清理会话的逻辑，清理连接直接调用 `closeOnly`：

```c
// paho.mqtt.c/src/MQTTAsyncUtils.c:2456-2497（节选）
static void MQTTAsync_closeOnly(Clients* client,
                enum MQTTReasonCodes reasonCode, MQTTProperties* props)
{
    client->good = 0;
    ... // 清 ping 状态
    if (client->net.socket > 0)
    {
        MQTTProtocol_checkPendingWrites();
        if (client->connected 
            && MQTTAsync_Socket_noPendingWrites(client->net.socket))
        {// 真正发出 DISCONNECT 报文
            MQTTPacket_send_disconnect(client, reasonCode, props);
        }
        //... WebSocket / SSL / Socket 关闭
        client->net.socket = 0;
    }
    client->connected = 0; // 到这里 connected 才归零
    client->connect_state = NOT_IN_PROGRESS;
}

void MQTTAsync_closeSession(Clients* client,
         enum MQTTReasonCodes reasonCode, MQTTProperties* props)
{
    MQTTAsync_closeOnly(client, reasonCode, props);
    if (client->cleansession ||
        (client->MQTTVersion >= MQTTVERSION_5 && client->sessionExpiry == 0))
        MQTTAsync_cleanSession(client);    // 条件满足才清本地会话
}
```

两个函数的分工：
- `closeOnly`：只关闭传输层，向服务端发 DISCONNECT 报文，关闭 WebSocket/SSL/TCP、connected = 0。不会清理会话状态。
- `closeSession`：在 `closeOnly` 基础上，若 `cleansession` 为 `true`（v3）或 `sessionExpiry == 0`（v5），再清本地会话。



用户主动断连只会调用 `onSuccess` 回调，这里我们修改一下 `async_subscribe` 用例：

```cpp
// paho.mqtt.cpp/examples/async_subscribe.cpp
void callback::on_success(const mqtt::token& tok) override {
    if (tok.get_type() == mqtt::token::Type::DISCONNECT)
        std::cout << "[on_success] Disconnect successful" << std::endl;
}

try {
    std::cout << "\nDisconnecting from the MQTT server..." << std::flush;
    cli.disconnect(nullptr, cb)->wait();    // 增加断连时的回调参数
    std::cout << "OK" << std::endl;
}
catch (const mqtt::exception& exc) {
    std::cerr << exc << std::endl;
    return 1;
}
```

执行用例后输入 q 主动断连退出，只会调用 `on_success`，不会调 `connection_lost`：

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260813105011319.png)

{{< notice tip >}}
主动断连时 `disconnect()` 的 `on_success` 表示「**断连流程完成了**」，连接已关、该发的报文已发，不是「连接还活着时」的通知。所以主动断连不会触发 `connection_lost`。如果你想区分「我主动断的」和「它自己断的」，`disconnect()->wait()` 正常返回就是前者，`connection_lost` 被调用就是后者。

如果连接还在建立中（`connect_state != NOT_IN_PROGRESS`）就调 `disconnect()`，会收到 `MQTTASYNC_OPERATION_INCOMPLETE` 的 `on_failure` 失败回调，而不是正常断连。
{{< /notice >}}


## 服务端 DISCONNECT

DISCONNECT 报文在 MQTT 3.1.1 里只能由客户端发给 Broker；Broker 想断连客户端，只能直接把 TCP 连接关掉。直到 MQTT 5.0，Broker 才有资格主动下发 DISCONNECT 报文，并且能携带原因码和属性，比如 `0x8E` Session taken over、`0x87` Not authorized。

所以服务端 DISCONNECT 这条路径，只在 v5 下存在，v3.1.1 下「被踢」实际表现为意外断线，我们在下一节讲。


### 接收线程的处理

服务端主动断连客户端时，接收线程 `MQTTAsync_cycle` 读出 DISCONNECT 报文，按以下顺序处理：

1. 调用 `disconnected` 回调（v5 专用，通过 `set_disconnected_handler` 注册）；
2. 把 `m->c->connected` 置 0；
3. 调用 `nextOrClose` 做清理和重连。

```c
thread_return_type WINAPI MQTTAsync_receiveThread(void* n)
{
    //... 省略循环框架
    // 从 socket 中读出报文
    pack = MQTTAsync_cycle(&sock, timeout, &rc);
    if (rc == SOCKET_ERROR)
    {   // socket 异常关闭走意外断线路径（见下一节）
        nextOrClose(m, rc, "socket error");
    }
    else if (pack)
    {
        //... 其他报文
        else if (pack->header.bits.type == DISCONNECT)
        {
            Ack* disc = (Ack*)pack;
            int discrc = disc->rc;  // 服务端下发的原因码

            // 1. 调用 disconnected 回调（v5 专用，用户通过 set_disconnected_handler 注册）
            if (m->disconnected)
                (*(m->disconnected))(m->disconnected_context,
                                     &disc->properties, disc->rc);

            // 2. 释放报文资源
            MQTTProtocol_handleDisconnects(pack, m->c->net.socket);

            // 3. 标记不再连接，防止回送 DISCONNECT
            m->c->connected = 0;

            // 4. 进入统一的清理 + 重连裁决
            nextOrClose(m, discrc, "Received disconnect");
        }
    }
}
```

这里的关键细节：`m->c->connected = 0` 发生在调用 `nextOrClose` **之前**。这里注释也明确指出不能回复 DISCONNECT 报文给 Broker，所以直接将 `connected` 置 0 后再进入 `nextOrClose`。

`disconnected` 是 v5 的 `set_disconnected_handler` 注册的回调，回调函数签名：

```cpp
void on_disconnected(const mqtt::properties& props, mqtt::ReasonCode reason);
```

它拿到的是 Broker 的原因码和属性，这是唯一能让用户知道「为什么被踢」的通道。


### 为什么 connection_lost 不触发

通过 `nextOrClose` 来看看为什么 connection_lost 不会触发，注意 `was_connected` 如何影响回调：

```c
// MQTTAsyncUtils.c:1642-1731（精简）
static void nextOrClose(MQTTAsyncs* m, int rc, char* message)
{
    int was_connected = m->c->connected;    // 快照入口时的连接状态
    int more_to_try = 0;
    int connectionLost_called = 0;

    //... 检查是否配置了多个 URI、且还有下一个可以尝试
    if (!more_to_try)
    {
        // 没有更多 URI：关闭 socket + 按条件清理订阅/在途消息
        MQTTAsync_closeSession(m->c, MQTTREASONCODE_SUCCESS, NULL);

        // 通知应用层连接失败（携带原因码）
        if (m->connect.onFailure)
            (*(m->connect.onFailure))(m->connect.context, &data);
        else if (m->connect.onFailure5)
            (*(m->connect.onFailure5))(m->connect.context, &data);

        // 若 connectionLost 还没调用过，且入口时确实是连接状态，补调一次
        if (connectionLost_called == 0 && m->cl && was_connected)
            (*(m->cl))(m->clContext, NULL);

        // 尝试自动重连（内部会检查 shouldBeConnected）
        MQTTAsync_startConnectRetry(m);
    }
}
```

总结服务端发送 DISCONNECT 后触发的回调：

- `disconnected`：一定触发，携带原因码和属性来获取客户端「被踢」的原因
- `on_failure`：触发，原因码就是服务端传递的
- `connection_lost`：不触发，因为 `connected` 已经在调用 `nextOrClose` 之前被置 0

`connection_lost` 只表达「连接在正常通信的情况下被不明原因中断」，而服务器主动断连属于「主动告知有原因的中断」，`on_failure` 是 token 级别的回调，表达客户端某个具体操作失败。所以服务端主动断连走 `disconnected` + `on_failure` 的回调组合。

{{< notice tip >}}
用户想在 v5 下感知「被踢」，通过 `set_disconnected_handler` 注册 `disconnected` 回调，并在里面看原因码，尤其是 `0x8E`（Session taken over，同一 clientID 在别处连接了）和 `0x87`（Not authorized）。这两个原因码基本说明连接对象或鉴权出了问题，只靠 `on_failure` 不够，`disconnected` 才会传入属性。

被踢之后 `shouldBeConnected` 仍是 1，所以自动重连会启动。如果你的 Broker 在踢人的同时拒绝你的再次连接（比如鉴权被吊销），重连会按指数退避一直重试到 `maxRetryInterval`。
{{< /notice >}}


## 意外断线：两条触发源，同一个出口

意外断线的触发源在系列前文都出现过：

- **keepalive 超时**：`MQTTProtocol_keepalive` 判断连接超时后通过 `MQTTProtocol_closeSession` 关闭会话，内部调用了 `nextOrClose`
- **收发数据出错**：接收线程从 `MQTTAsync_cycle` 拿到 `SOCKET_ERROR`，说明 TCP 连接已经关闭，调用 `nextOrClose(m, rc, "socket error")`

两条触发源有个共同点：进入 `nextOrClose` 时，`connected` 还是 1。keepalive 判死发生在后台检查线程，它只是「判定」连接死了，还没来得及改状态；socket 错误分支更是连「读包」都没完成。于是 `nextOrClose` 开头那句 `was_connected = m->c->connected` 得到 1，与上一节服务端主动断连的路径形成鲜明对比。

后面的行为与「服务端 DISCONNECT」路径基本相同，只是 `was_connected` 不同、多一个 `connection_lost`：

```c
// MQTTAsyncUtils.c: nextOrClose（回调逻辑）
if (connectionLost_called == 0 && m->cl && was_connected)
    (*(m->cl))(m->clContext, NULL);
```

`connectionLost_called` 标记注意，在多 URI 分支中已经调用 `connection_lost` 回调后会置 1，防止多次重复调用。

我们通过执行示例 `async_subscribe` 来验证意外断线回调和重连机制，在运行期间断连客户端网络，会触发 `connection_lost` 回调并开始自动重连，客户端网络恢复后重连成功：

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260813103737375.png)


## 核心结论

到这里我们已经梳理了断线的三条路径，对比三条路径总结出以下表格：

| 维度 | 主动断连 | 服务端 DISCONNECT（v5） | 意外断线 |
|---|---|---|---|
| 触发方 | 本端 `disconnect()` | Broker 下发 DISCONNECT | keepalive 超时 / socket 错误 |
| 出口函数 | `checkDisconnect` | `nextOrClose` | `nextOrClose` |
| 进入出口时 `connected` | 1（`checkDisconnect` 里保存） | 已提前置 0 | 仍为 1 |
| `was_connected` | 1 | **0** | **1** |
| `connection_lost` | 不触发（走 `on_success`） | **不触发** | **触发（恰一次）** |
| 成功/失败回调 | `on_success`（断连完成） | `on_failure`（带原因码） | `on_failure` |
| `disconnected`（v5） | 不触发 | 触发（原因码 + 属性） | 不触发 |
| 会话清理 | `closeSession` | `closeOnly`（多 URI）或 `closeSession` | `closeOnly`（多 URI）或 `closeSession` |
| `shouldBeConnected` | 0 | 仍为 1 | 仍为 1 |
| 自动重连 | 不启动 | 启动 | 启动 |


连接管理的三条路径讲完，接下来回到底层：`SOCKET_ERROR` 是怎么被读出来的？`Socket_noPendingWrites`、partial write 背后的事件循环长什么样？下一篇「非阻塞 Socket 与事件循环」回到网络层拆这些。

