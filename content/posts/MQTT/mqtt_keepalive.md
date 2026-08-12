+++
title = "保活心跳：PINGREQ/PINGRESP 与 1.5 倍超时"
description = ""
date = "2026-08-12"
aliases = ["MQTT-keepalive"]
author = "ChnjFan"
tags = [
    "paho.mqtt.cpp",
    "MQTT",
]
categories = [
    "MQTT",
]
+++

当我们写完了 TCP 服务器后，客户端成功建立了连接，以为这样就万事大吉。直到某天凌晨客户端悄悄断线，服务端却一直显示这些客户端「在线」，TCP 连接看起来还活着，但谁也收不到任何字节了。

这就是 TCP 的半连接（half-open）问题：客户端进程消失、网线被拔、防火墙静默丢包时，服务端 TCP 栈永远等不到数据，`recv` 一直阻塞，数据接收不到也不报错，连接「看着活着」其实已经死了。TCP 自己有个 keepalive 机制，但默认 2 小时才触发一次，对绝大多数业务太慢；而且它只探测链路能不能收发字节，不管应用层还活不活着。

MQTT 实现应用层的 keepalive 机制，通过心跳包来进行保活，这也是应用层常用的解决方案。客户端周期性发 PINGREQ 报文，Broker 必须回复 PINGRESP 报文。PINGRESP 没在约定时间内回来，客户端就认定连接断开，主动走断连流程。在实际使用 MQTT 的 keepalive 时，不免会产生这样的疑问：🤔

- PINGREQ 什么时候发？是每 keepalive 秒发一次，还是另有触发时机？
- PINGRESP 多久没回来算"死"？超时阈值怎么定？
- 连接死了之后，断线怎么兜底、`connection_lost` 怎么触发？

这篇文章顺着 keepalive 属性从 API 到后台线程的传递路径，逐段拆 Paho 里的心跳实现，回答这三个问题。最后会点出两个容易忽略的坑：v5 的 `SERVER_KEEP_ALIVE` 改了心跳值却不改轮询间隔、`keepalive = 0`
会直接关掉断连检测。


## keepalive 属性传递：从 API 到后台线程

keepalive 在 paho.mqtt.cpp 里是一个整数值（单位秒），从 `connect_options` 一路传到 paho.mqtt.c 库的 `MQTTAsync_connectOptions`，最后保存到客户端结构体 `Clients` 中。

```cpp
// include/mqtt/connect_options.h
void set_keep_alive_interval(int keepAliveInterval) {
    opts_.keepAliveInterval = keepAliveInterval;
}
void set_keep_alive_interval(const std::chrono::duration<Rep, Period>& interval) {
    set_keep_alive_interval((int)to_seconds_count(interval));
}
// include/mqtt/connect_options.h
auto keep_alive_interval(const std::chrono::duration<Rep, Period>& interval)
     -> self& {
    opts_.set_keep_alive_interval(interval);
}
```

构造器的 `connect_options_builder::keep_alive_interval` 调用连接属性 `connect_options::set_keep_alive_interval`，或者直接调用连接属性的函数设置，最终传递下去的 `keepAliveInterval` 单位都是秒。

`opts_` 就是 paho.mqtt.c 库的 `MQTTAsync_connectOptions` 结构体，默认值定义在初始化宏 `MQTTAsync_connectOptions_initializer` 中。

```c
// paho.mqtt.c/src/MQTTAsync.h:1390
#define MQTTAsync_connectOptions_initializer {\
     {'M', 'Q', 'T', 'C'}, 8, 60, 1, 65535, ... \
}
// MQTTAsync_connectOptions_initializer5 :  ... 60, 0, ...   （v5 非 WS）
// MQTTAsync_connectOptions_initializer_ws : ... 45, 1, ...  （v3.1.1 WebSocket）
// MQTTAsync_connectOptions_initializer5_ws: ... 45, 0, ...  （v5 WebSocket）
```

第三个字段就是 `keepAliveInterval`：非 WebSocket 默认 60 秒，WebSocket 默认 45 秒。WebSocket 用更短的默认值，是为了避开很多 Web 服务器约 60 秒的无活动超时，避免连接被基础设施切断。

用户调用 `connect()` 后，`MQTTAsync_connect` 把值存进 `Clients` 结构体：

```c
// paho.mqtt.c/src/MQTTAsync.c
int MQTTAsync_connect(MQTTAsync handle, const MQTTAsync_connectOptions* options)
{
    //...
    m->c->keepAliveInterval
         = m->c->savedKeepAliveInterval
         = options->keepAliveInterval;
	setRetryLoopInterval(options->keepAliveInterval);
}
```

这里我们看到 `options` 中的值被赋值了两份，`keepAliveInterval` 是心跳检测用的当前值；`savedKeepAliveInterval` 是「用户最初请求的值」的备份，这份备份在后续处理 v5 的 `SERVER_KEEP_ALIVE` 时至关重要，我们在踩坑边界会讲到。

`setRetryLoopInterval` 用 keepalive 推导出重试循环的轮询间隔：

```c
// paho.mqtt.c/src/MQTTAsyncUtils.c:2700-2710
static int retryLoopIntervalms = 5000;   // 默认 5000ms
void setRetryLoopInterval(int keepalive)
{
    retryLoopIntervalms = (keepalive*1000) / 10;   // keepAlive 的 1/10
    if (retryLoopIntervalms < 100)
        retryLoopIntervalms = 100;                 // 下限 100ms
    else if (retryLoopIntervalms > 5000)
        retryLoopIntervalms = 5000;                // 上限 5000ms
}
```

轮询间隔被限制在 100ms 到 5000ms 之间。默认 60 秒 keepalive 算出 6 秒，被上限截到 5 秒。所以默认后台线程实际上每 5 秒检查一次心跳，而不是 60 秒。这里还要区分 keepalive 是检测阈值，轮询间隔 `retryLoopIntervalms` 是检测频率，两者不是一回事。

{{< notice tip >}}
`keepAliveInterval` 和 `retryLoopIntervalms` 是两个独立变量，只在连接时由 `setRetryLoopInterval` 同步一次。后面 v5 的 `SERVER_KEEP_ALIVE` 只改前者不改后者，就是这个「两份状态」埋下的雷。

如果服务端将 keepalive 改小（如改为 5 秒），`retryLoopIntervalms` 仍是基于原值（如 60s→5000ms），轮询变慢，PINGREQ 发送不及时，可能导致服务端认为客户端掉线。
{{< /notice >}}


## 连接存活检测与 PINGREQ 触发条件

### 连接存活检测：retry 循环在做什么

上一节我们计算出了 `retryLoopIntervalms`，谁在用它？异步客户端有一个后台线程 receiveThread 定期调用 `MQTTAsync_retry` 判断是否要进行连接存活检查，同步客户端中用 `MQTTClient_retry`，检查逻辑相同。以异步为例：

```c
static void MQTTAsync_retry(void)
{
    static START_TIME_TYPE last = START_TIME_ZERO;
    START_TIME_TYPE now;

    now = MQTTTime_now();
    if (MQTTTime_difftime(now, last) >= (DIFF_TIME_TYPE)(retryLoopIntervalms))
    {// 每 retryLoopIntervalms 执行一次
        last = MQTTTime_now();
        MQTTProtocol_keepalive(now);    // 心跳检测
        MQTTProtocol_retry(now, 1, 0);  // QoS 重试超时报文
    }
    else
        MQTTProtocol_retry(now, 0, 0);  // 仅处理待发送队列
}
```

每 `retryLoopIntervalms`（默认 5 秒）跑一次完整的心跳检测 `MQTTProtocol_keepalive`，其他时间只做 QoS 重发检查。进入心跳检测后，遍历所有已连接的客户端，逐个判断要不要发 PINGREQ、已发的 PINGREQ 有没有超时：

```c
// paho.mqtt.c/src/MQTTProtocolClient.c（精简结构）
void MQTTProtocol_keepalive(START_TIME_TYPE now)
{
    ListNextElement(bstate->clients, &current);
    while (current)
    {
        Clients* client = (Clients*)(current->content);
        ListNextElement(bstate->clients, &current);

        if (client->connected == 0 || client->keepAliveInterval == 0)
            continue;   // keepalive=0 直接跳过整个检测

        //... 四个分支判断超时或者要不要发 PINGREQ
    }
}
```

这里注意 `keepAliveInterval` 被设置 0 之后直接 `continue` 跳过心跳检测。这也是一个踩坑点，先记下来。


### 发送 PINGREQ 的两个触发条件

`MQTTProtocol_keepalive` 中分支中有两个发送 PINGREQ 的触发条件，分别从「发送方视角」和「接收方视角」判断链路是否空闲过久。

如果距上次发送数据超过 `keepAliveInterval` 还没动静，就得发 PINGREQ 主动探测了。

```c
// MQTTProtocolClient.c: MQTTProtocol_keepalive（精简分支）
else if (MQTTTime_difftime(now, client->net.lastSent) >=
        (DIFF_TIME_TYPE)(client->keepAliveInterval * 1000))
{
    if (Socket_noPendingWrites(client->net.socket))
    {
        if (MQTTPacket_send_pingreq(&client->net, client->clientID) 
                != TCPSOCKET_COMPLETE)
        {
            MQTTProtocol_closeSession(client, 1); // 发送失败，直接断线
        }
        else
        {
            client->ping_due = 0;
            client->net.lastPing = now;
            client->ping_outstanding = 1; // 标记"已发出、等回复"
        }
    }
    else if (client->ping_due == 0)
    {// socket 有数据没写完，先记个 ping_due，下次再试
        client->ping_due = 1;
        client->ping_due_time = now;
    }
}
```

如果距上次接收数据超过 `keepAliveInterval`，需要主动发 PINGREQ 问对面还活着没。

```c
// MQTTProtocolClient.c: MQTTProtocol_keepalive（精简分支）
else if (MQTTTime_difftime(now, client->net.lastReceived) >=
        (DIFF_TIME_TYPE)(client->keepAliveInterval * 1000))
{
    if (Socket_noPendingWrites(client->net.socket))
    {
        if (MQTTPacket_send_pingreq(&client->net, client->clientID) 
                != TCPSOCKET_COMPLETE)
        {
            MQTTProtocol_closeSession(client, 1);
        }
        else
        {
            client->ping_due = 0;
            client->net.lastPing = now;
            client->ping_outstanding = 1;
        }
    }
}
```

两个分支的共同点 `Socket_noPendingWrites`，只有 socket 上没有待写数据时才发 PINGREQ。逻辑很简单，socket 还在写业务数据，说明链路活着，不用额外探测；而且 PINGREQ 报文优先级低，不能插在业务数据中间。如果 socket 正忙的话，就把 `ping_due = 1` 和 `ping_due_time` 记下来，下次轮询再说。

`MQTTPacket_send_pingreq` 构造的报文很轻：固定头 0xC0 + 剩余长度 0x00，一个只有 2 字节的包。


## PINGRESP 超时判定与失败全链路

### PINGRESP 超时判定：1.5 倍 keepAlive

PINGREQ 报文发出去之后将 `ping_outstanding` 状态置为 1。下一次轮询进入 `MQTTProtocol_keepalive` 的检查分支后，判断 PINGRESP 有没有在 1.5 倍 keepalive 内回来。

```c
// MQTTProtocolClient.c: MQTTProtocol_keepalive（精简分支 A）
if (client->ping_outstanding == 1)
{
    if (MQTTTime_difftime(now, client->net.lastPing) >=
            (DIFF_TIME_TYPE)(client->keepAliveInterval * 1500) &&
        MQTTTime_difftime(now, client->net.lastReceived) >=
            (DIFF_TIME_TYPE)(client->keepAliveInterval * 1500))
    {// PINGRESP 没在 keepalive 内回来，且也没有新数据到达
        MQTTProtocol_closeSession(client, 1);   // PINGRESP 超时，断线
    }
}
```

两个条件的含义：

- `lastPing` ≥ 1.5×keepAlive：PINGREQ 发出去已经很久，没收到对应 PINGRESP。
- `lastReceived` ≥ 1.5×keepAlive：同时最近也没收到任何数据。

`lastReceived >= 1.5×keepAlive` 为了避免正在接收一个大文件或者大包，PINGRESP 可能被堵在后面的情况出现，只要 `lastReceived` 还在 1.5 倍内，就说明链路其实还活跃，不算超时。

考虑到网络延迟和 Broker 处理耗时的开销，超时阈值是 1.5 倍 keepAlive（keepAliveInterval * 1500 毫秒）。

另一种边界情况是 PINGREQ 因为 socket 忙没发出去（`ping_due == 1`），此时不检查 `ping_outstanding`，而是看从 `ping_due_time` 起 1.5 倍 keepalive 内有没有成功发出去：

```c
// MQTTProtocolClient.c: MQTTProtocol_keepalive（精简分支 B）
else if (client->ping_due == 1 &&
    MQTTTime_difftime(now, client->ping_due_time) >=
        (DIFF_TIME_TYPE)(client->keepAliveInterval * 1500))
{
    if (MQTTTime_difftime(now, client->ping_due_time) <=
        MQTTTime_difftime(now, client->net.lastReceived))
    {
        MQTTProtocol_closeSession(client, 1);   // PINGREQ 一直没真正发出
    }
}
```

即使 PINGREQ 因为 socket 忙没发出去，只要 1.5 倍 keepalive 内既没发出去、也没有新数据到达，同样判断连接已死，避免永远在等一个发不出去的 ping。


### keepalive 的失败链路

keepalive 判断超时后调用 `MQTTProtocol_closeSession`，直接转交给异步客户端的断线处理 `nextOrClose`：

```c
// paho.mqtt.c/src/MQTTAsyncUtils.c:2774-2777
void MQTTProtocol_closeSession(Clients* c, int sendwill)
{
    nextOrClose((MQTTAsync)c->context, MQTTASYNC_DISCONNECTED,
                "MQTTProtocol_closeSession");
}
```

`nextOrClose` 是断线路径的统一出口，后续文章会完整展开。仅 keepalive 而言，整条链路是：

```
receiveThread 轮询检测（MQTTAsync_retry 每 retryLoopIntervalms）
│
└──→ MQTTProtocol_keepalive()
        │
        ├── 分支 A/B：ping_outstanding==1 且 PINGRESP 超时？
        │       └──→ MQTTProtocol_closeSession()
        │               └──→ connection_lost 回调
        │                       └──→ async_client::on_connection_lost
        │                               └──→ 你的 callback::connection_lost(cause)
        │
        └── 分支 C/D：距上次发送/接收 ≥ keepAlive？
                └──→ 发 PINGREQ，置 ping_outstanding=1
```

这条路径和 TCP 层的 keepalive 并行工作：TCP keepalive 通常 2 小时才触发，MQTT keepalive 默认 60 秒、可配置，所以实际断线检测几乎总是 MQTT 层先兜底。

{{< notice tip >}}
超时判定是在 paho.mqtt.c 库中的「内部事务」，`connection_lost` 只是通知用户已经发生了超时，在通知里做任何事都不能改变已经超时的事实。
{{< /notice >}}

## 踩坑边界

### SERVER_KEEP_ALIVE：改了心跳，却没改轮询间隔

MQTT v5 允许 Broker 在 CONNACK 里用 `SERVER_KEEP_ALIVE` 属性覆盖客户端的 keepalive。Paho 连接成功后的处理如下：

```c
// paho.mqtt.c/src/MQTTClient.c:1483-1498（v5 连接成功时）
static int MQTTAsync_completeConnection(MQTTAsyncs* m, Connack* connack)
{
    if (m->c->connect_state == WAIT_FOR_CONNACK) {
        if ((rc = connack->rc) == MQTTASYNC_SUCCESS) {
            //... 清理标记、会话

            if (MQTTProperties_hasProperty(&connack->properties,
                                            MQTTPROPERTY_CODE_SERVER_KEEP_ALIVE))
            {
                int server_keep_alive = (int)MQTTProperties_getNumericValue(
                        &connack->properties, MQTTPROPERTY_CODE_SERVER_KEEP_ALIVE);
                if (server_keep_alive != -999999)
                {
                    m->c->keepAliveInterval = server_keep_alive;    // 更新了当前值
                }
            }
            else if (m->c->keepAliveInterval != m->c->savedKeepAliveInterval)
            {
                /* 本次 CONNACK 没带 SERVER_KEEP_ALIVE，但之前改过复位到用户原值 */
                m->c->keepAliveInterval = m->c->savedKeepAliveInterval;
            }
        }
    }
}
```

注意中间没有 `setRetryLoopInterval(...)` 调用。`keepAliveInterval` 会被服务端覆盖，但后台轮询间隔 `retryLoopIntervalms` 还是连接时的旧值。

举个例子：服务端把 keepalive 改成 5 秒，但客户端原值是 60 秒，轮询间隔 5 秒，轮询频率没变，PINGREQ 的发送时机就会偏慢，可能让服务端误判客户端掉线。

{{< notice tip >}}
踩坑提醒：v5 连接时检查 CONNACK 是否带回了 `SERVER_KEEP_ALIVE`。如果服务端改了 keepalive，而你的业务对断线检测时机敏感，这个不一致需要自己兜底。
{{< /notice >}}

这段代码中还有我们之前提到的 `savedKeepAliveInterval` 字段，在 v5 版本中如果本次连接时的 CONNACK 没有携带 `SERVER_KEEP_ALIVE`，但是 `keepAliveInterval` 被上一次服务器修改了，这时候要将 `keepAliveInterval` 恢复到第一次连接时保存的 `savedKeepAliveInterval` 值。

{{< notice note >}}
问题：如果服务端只在第一次连接时返回 `SERVER_KEEP_ALIVE`，重连时不返回，怎么办？
- 第 1 次连接: 服务端返回 `SERVER_KEEP_ALIVE = 5s` → `keepAliveInterval = 5s`
- 第 2 次连接: 服务端没有返回 → 应该用什么值？

服务端如果想覆盖 keepalive，每次连接都应该返回 `SERVER_KEEP_ALIVE`。如果没有返回，说明服务端不想覆盖，应该恢复为用户原始设置。
{{< /notice >}}


### keepAliveInterval = 0：完全禁用断连检测

回到 `MQTTProtocol_keepalive` 开头的 `continue`：

```c
if (client->connected == 0 || client->keepAliveInterval == 0)
    continue;
```

从客户端角度来看，keepalive 设为 0 时不发 PINGREQ，也不检测 PINGRESP 超时，客户端无法感知服务端是否还活着。

服务端的行为则看 broker 怎么实现，可能连接会永久保持，也可能会有自己的超时策略，或者直接拒绝 keepalive 为 0 的客户端。

除非你完全理解后果并且在应用层自己实现了心跳机制，否则不要设置 0。

{{< notice tip >}}
keepalive=0 不是「不关心心跳」，而是主动放弃了断连检测。在服务器不支持心跳的场景下可能要自己实现心跳检测，否则不要设置 0。
{{< /notice >}}

## 总结

keepalive 的全局链路可以用一句话概括：它是挂在 `MQTTAsync_retry` 中的一个空闲检测器，socket 空闲超过 keepalive 就发 PINGREQ，PINGRESP 在 1.5 倍 keepalive 内没回来、也没有新数据到达，就判定链路已死。收发两个方向都能触发，所有检测都看 `Socket_noPendingWrites`，如果有数据在发送就认为连接活跃。

回看开头三个问题的结论：

- PINGREQ 只在「距上次收发超过 keepalive 且 socket 空闲」时发；
- PINGRESP 超时判定 1.5 倍 keepalive，用 `lastReceived` 避免正在收大包的情况；
- `SERVER_KEEP_ALIVE` 只更新 `keepAliveInterval` 不重算轮询间隔，keepalive=0 直接关掉断连检测。

本篇中提到了心跳判死会调用 `nextOrClose`，那之后会发生什么？自动重连如何在退避中把连接请求塞回队列，以及为什么「传输层自愈」不等于「会话层恢复」。这些问题我们会在「自动重连」中继续探讨。
