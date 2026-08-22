+++
title = "自动重连：退避、抖动与传输层自愈"
description = ""
date = "2026-08-12"
aliases = ["MQTT-retryconn"]
author = "ChnjFan"
tags = [
    "paho.mqtt.cpp",
    "MQTT",
]
categories = [
    "MQTT",
]
+++

应用层连接断了，第一时间想的往往不是「为什么断」，而是「赶紧重连」。`automatic_reconnect` 就是 Paho 给客户端准备的方案：断线后自动把连接建回来，不用你写重试循环。

但开了开关之后，事情没那么简单。设备断线后多久会重连？重试间隔固定还是越来越长？重连成功后，之前的订阅还收得到消息吗？不假思索地打开 `automatic_reconnect`，大概率会在某个凌晨被「设备在线却收不到消息」的工单叫醒。

这篇文章顺着自动重连的实现路径，回答三个问题：

- 自动重连由什么状态控制？为什么主动 `disconnect()` 之后它不会再连回来？
- 重试间隔怎么算？指数退避和随机抖动在代码里长什么样？
- 重连成功后恢复了什么？为什么「传输层连上了」不等于「会话层恢复了」？

沿着 `startConnectRetry` 状态机 → 重连命令入队 → 重连成功后的回调处理这条线，逐段拆解 Paho 的实现。先给结论：

- 自动重连由 `shouldBeConnected`（用户意图）和 `retrying`（重连中）两个标志控制，**只有异常断开才触发**；主动 `disconnect()` 会清零 `shouldBeConnected`，确保不会重连。
- 重试间隔是「**指数退避 + 随机抖动**」：1s → 2s → 4s → … 翻倍到上限，再在 ±20% 区间内抖动，避免一群设备同时断线后同步重连造成惊群。
- **重连只修复传输层**：连接会重新建立，但订阅列表、离线消息是否还在取决于会话层，`clean session=true` 时每次重连都是「一张白纸」。


## 开启方式与重连状态机

### automatic_reconnect 默认关闭

自动重连默认是关的。`MQTTAsync_connectOptions` 的初始化宏里 `automaticReconnect = 0`，如果你不显式打开，断线后就停在断开状态，什么都不会发生：

```c
// paho.mqtt.c/src/MQTTAsync.h:1390
#define MQTTAsync_connectOptions_initializer { \
 {'M', 'Q', 'T', 'C'}, 8, 60, 1, 65535, ... , 0, 1, 60 ... \
}
```

`automaticReconnect` 字段在宏里默认是 0，`minRetryInterval` 是 1，`maxRetryInterval` 是 60。

在 paho.mqtt.cpp 里用 builder 打开，或显示指定退避区间：

```cpp
auto connOpts = mqtt::connect_options_builder()
                    .clean_session()
                    .automatic_reconnect()  // 默认 min=1s, max=60s
                    .finalize();
// 显示指定退避区间
mqtt::connect_options_builder()
        .automatic_reconnect(1s, 60s)   // minRetryInterval=1s, maxRetryInterval=60s
```


### 重连状态机：startConnectRetry

自动重连的真正入口是 `MQTTAsync_startConnectRetry`，它在连接失败或断开时被调用，负责计算下一次重连要等多久。

```c
// paho.mqtt.c/src/MQTTAsyncUtils.c
void MQTTAsync_startConnectRetry(MQTTAsyncs* m)
{
    if (m->automaticReconnect && m->shouldBeConnected)
    {
        m->lastConnectionFailedTime = MQTTTime_start_clock();
        if (m->retrying) // 已在重连中，指数退避：1s → 2s → 4s → 8s → ... → 60s（上限）
            m->currentIntervalBase = min(m->currentIntervalBase * 2,
                                         m->maxRetryInterval);
        else { // 首次重连：从最小间隔开始
            m->currentIntervalBase = m->minRetryInterval;
            m->retrying = 1; // 标记进入重连状态
        }
        // 加入随机抖动，避免多客户端同时重连
        m->currentInterval = MQTTAsync_randomJitter(m->currentIntervalBase,
                                        m->minRetryInterval, m->maxRetryInterval);
    }
}
```

两个关键状态：
- `shouldBeConnected`：用户调 `connect()` 后置 1，用户调 `disconnect()` 主动断开后置 0。它表达的是「用户希望保持连接」的意图。只有它仍为 1，重连才会启动，所以主动断开后不会重连。
- `retrying`：首次失败从 `minRetryInterval` 开始指数级退避，直到 `maxRetryInterval`。

注意 `currentInterval` 不是直接把 `currentIntervalBase` 拿去用，而是再经过 `MQTTAsync_randomJitter` 抖动：

```c
int MQTTAsync_randomJitter(int currentIntervalBase, int minInterval, int maxInterval)
{
    const int max_sleep = (int)(min(maxInterval, currentIntervalBase) * 1.2);
    const int min_sleep = (int)(max(minInterval, currentIntervalBase) / 1.2);

    if (min_sleep >= max_sleep) // shouldn't happen, but just in case
    {
        return min_sleep;
    }

    {
        int r;
        int range = max_sleep - min_sleep + 1;
        const int buckets = RAND_MAX / range;
        const int limit = buckets * range;

        do
        {
            r = rand();
        } while (r >= limit);

        {
            const int randResult = r / buckets;
            return min_sleep + randResult;
        }
    }
}
```

这段代码详细的说明在：[如何生成指定范围内的随机整数](http://stackoverflow.com/questions/2509679/how-to-generate-a-random-number-from-within-a-range)

`currentInterval` 通过 `MQTTAsync_randomJitter` 计算在 `[base/1.2, base×1.2]` 区间内随机抖动，避免多个客户端同时断线后同步重连造成的惊群。

最终等待时间在 `[base/1.2, base×1.2]` 内随机取值。为什么加抖动？一批设备同时掉线时，会用相同的退避节奏重连形成「同步重连」，所有设备的负载同时压到 broker 上。随机抖动把这些峰值打散。

一个值得注意的细节：`MQTTAsync_startConnectRetry` 这里只计算下一次重连的等待时间，本身不发起重连。真正的「把连接请求塞回去」发生在重试循环里。


## 重连命令如何入队

`MQTTAsync_startConnectRetry` 只算了「等多久」，谁来发起真正的重连？答案是在发送线程 `MQTTAsync_sendThread` 里的定时检查。

### sendThread 主循环

发送线程的主循环逻辑很简单：先处理命令队列里已有的命令，然后等 1 秒，再检查一次超时：

```cpp
// paho.mqtt.c/src/MQTTAsyncUtils.c:（sendThread 主循环节选）
while (!MQTTAsync_tostop)
{
    // 先处理队列中已有的命令
    while (command_count > 0)
    {
        if (MQTTAsync_processCommand() == 0)
            break;                      // 没有命令可处理，进入等待
        ...command_count = MQTTAsync_commands->count;
    }
    if ((rc = Thread_wait_evt(send_evt, timeout)) != 0 && rc != ETIMEDOUT)
        ...
    timeout = 1000;                     // 后续等待 1 秒
    MQTTAsync_checkTimeouts();          // 每 1 秒检查一次
}
```

### checkTimeouts：真正的重连触发器

`MQTTAsync_checkTimeouts` 每 1 秒被 sendThread 调一次，但函数内部还有一个 3 秒节流，两次实际执行之间至少隔 3 秒。然后遍历所有客户端，对处于重连状态（`automaticReconnect && retrying`）的客户端做判断：

```cpp
static void MQTTAsync_checkTimeouts(void)
{
    if (MQTTTime_difftime(now, last) < (DIFF_TIME_TYPE)3000)
        goto exit;
    while (ListNextElement(MQTTAsync_handles, &current))
    {
        //... 检查断连
        if (m->automaticReconnect && m->retrying)
        {
            if (m->reconnectNow 
                || MQTTTime_elapsed(
                    m->lastConnectionFailedTime) 
                    > (ELAPSED_TIME_TYPE)(m->currentInterval * 1000))
            {
                // 把 connect 命令插到队列头部
                MQTTAsync_queuedCommand* conn = 
                    malloc(sizeof(MQTTAsync_queuedCommand));
                memset(conn, '\0', sizeof(MQTTAsync_queuedCommand));
                conn->client = m;
                conn->command = m->connect;
                if (m->c->MQTTVersion == MQTTVERSION_DEFAULT)
                    conn->command.details.conn.MQTTVersion = 0;
                // 如果注册了 updateConnectOptions，在这里回调，可以刷新 token/密码
                if (m->updateConnectOptions) { /**/ }
                MQTTAsync_addCommand(conn, sizeof(m->connect));// 插入队列头
                m->reconnectNow = 0;
            }
        }
    }
}
```

这里有三个值得注意的点：
- **复用首次连接的完整命令**。`conn->command = m->connect`，重连用的就是首次 `connect()` 时保存的完整连接命令，包括 clean_session、keepAliveInterval、will 等参数。所以「重连时自动带上和首次一样的配置」是靠这个结构体保存实现的。
- **版本 DEFAULT 时重置版本号**。`MQTTVERSION_DEFAULT(0)` 意味着「先试 3.1.1，失败回退 3.1」。如果重连时不清零，可能会沿用上次协商的版本；这里显式重置为 0，让每次重连都重新走一遍版本协商。
- **`updateConnectOptions` 回调用来刷新凭证**。重连经常发生在长时间运行之后，用户名/密码/token 可能已过期。`MQTTAsync_checkTimeouts` 在添加重连命令前回调 `updateConnectOptions`，让用户有机会替换凭证，回调里分配的新 username/password 会被替换进 m->c。如果你的 token 会过期，这是处理凭证续期的入口。

一旦命令插入队列头，sendThread 下一轮循环就会把它取出来执行，走正常的连接流程（发送 CONNECT → 等 CONNACK）。


{{< notice tip >}}
重连命令会插到队列头优先执行。但如果你在 `connection_lost` 回调里又手动调 `connect()`，就多塞了一条连接命令进去，跟自动重连竞争执行。两个办法只能选一个：要么用自动重连，要么在 connection_lost 里手动连接。
{{< /notice >}}


## 重连成功后发生了什么

接收到服务端的 CONNACK 后，receiveThread 调用 `MQTTAsync_completeConnection` 完成状态收尾：

```c
// MQTTAsyncUtils.c（精简）
static int MQTTAsync_completeConnection(MQTTAsyncs* m, Connack* connack)
{
    if (m->c->connect_state == WAIT_FOR_CONNACK) {
        if ((rc = connack->rc) == MQTTASYNC_SUCCESS) { // 连接成功
            // 1. 清除重连标志，下次失败从 minRetryInterval 重新开始
            m->retrying = 0;
            // 2. 更新连接状态
            m->c->connected = 1;
            m->c->good = 1;
            m->c->connect_state = NOT_IN_PROGRESS;
            // 3. 清理会话（clean session 或 sessionPresent=0）
            if (m->c->cleansession || m->c->cleanstart)
                MQTTAsync_cleanSession(m->c);
			else if (m->c->MQTTVersion >= MQTTVERSION_3_1_1
                     && connack->flags.bits.sessionPresent == 0)
                MQTTAsync_cleanSession(m->c);
            // 4. 重发断连期间堆积的消息
            if (m->c->outboundMsgs->count > 0) {
                // 重置所有消息的 lastTouch
                // regardless=1 表示无视重试间隔立即重试
                MQTTProtocol_retry(zero, 1, 1);
            }

            //... MQTTv5 服务端可能覆盖 keepalive

            // 唤醒 sendThread
            Thread_signal_evt(send_evt);
        }
    }
}
```

这里有两个值得注意的细节：
1. `retrying = 0`：重连成功后退出「重连中」状态，`currentIntervalBase` 的翻倍计数也就此归零，下次断线会从 `minRetryInterval` 重新开始退避。
2. **本地会话状态清理**：不仅是 broker 端有 clean session 语义，客户端本地也会清理，`cleansession`/`cleanstart` 为 `true` 时直接清；即使没设，只要 v3.1.1+ 且 CONNACK 的标志位 `sessionPresent == 0`（该字段表示 broker 端没有旧会话），客户端也把自己的本地状态清掉，避免残留。

随后触发用户回调。注意 `connected` 回调的 `cause` 参数会告诉你这次是首次连接还是自动重连：

```c
// MQTTAsyncUtils.c:2148-2199（receiveThread 处理 CONNACK 的后续）
rc = MQTTAsync_completeConnection(m, connack);
if (rc == MQTTASYNC_SUCCESS)
{
    // 1.调用 onSuccess / onSuccess5 回调
    if (m->connect.onSuccess) {
        data.alt.connect.serverURI = ...;
        data.alt.connect.MQTTVersion = ...;
        data.alt.connect.sessionPresent = sessionPresent;
        (*(m->connect.onSuccess))(m->connect.context, &data);
        m->connect.onSuccess = NULL;  // 清空，防止重复调用
        m->connect.onFailure = NULL;
    }
    else if (m->connect.onSuccess5) {
        // ... v5 类似，但包含 properties 和 reasonCode
    }

    // 2. 调用 connected 回调
    if (m->connected) {
        char* reason = onSuccess ? "connect onSuccess called"
                                : "automatic reconnect";
        (*(m->connected))(m->connected_context, reason);
        //                                      ^^^^^^^
        //   自动重连时 reason = "automatic reconnect"
        //   首次连接时 reason = "connect onSuccess called"
    }

    // 3. MQTT v5: 应用服务端返回的 RECEIVE_MAXIMUM，更新最大处理消息数
    if (m->c->MQTTVersion >= MQTTVERSION_5)
    {
        if (MQTTProperties_hasProperty(&connack->properties,
                                 MQTTPROPERTY_CODE_RECEIVE_MAXIMUM))
        {
            int recv_max = (int)MQTTProperties_getNumericValue(
                    &connack->properties, MQTTPROPERTY_CODE_RECEIVE_MAXIMUM);
            if (m->c->maxInflightMessages > recv_max)
                m->c->maxInflightMessages = recv_max;
        }
    }
}
```

`on_success` 和 `connected` 的区别：前者携带连接结果详情（URI、版本、sessionPresent，用于判断「broker 端还有没有我的旧会话」）；后者是「连接已就绪」的事件钩子，cause 为 "automatic reconnect" 时说明这是自动重连完成的，通常在这里做订阅恢复等业务初始化。

自动重连解决的是传输层：TCP 链路重建、MQTT 握手完成。但业务上下文在会话层，断线期间 broker 是否还替你保留会话，取决于 clean session / clean start 怎么设。这就是长连接系统最常见的问题：

- 重连成功后，broker 端要是已经没有你的会话（sessionPresent == false），订阅列表就是空的，`message_arrived` 不会被触发，连接看着正常，实际消息一个都收不到。
- 自动重连 + `clean session=true`：每次重连 broker 都给你一个全新会话，订阅和离线消息全部归零。想保留离线消息，就不能用 clean session。
- 正确的做法通常是在 `connected()` 回调里重新订阅，或者先检查 `on_success` 里的 `sessionPresent` 再决定要不要恢复订阅。


## 总结

自动重连的完整链路：

```
断线（keepalive 超时 / TCP 错误）
│
└──→ startConnectRetry：shouldBeConnected 为 1 才启动
│       退避 currentIntervalBase 翻倍 + 抖动 currentInterval
│
└──→ sendThread 每 1s 调 checkTimeouts（内部 3s 节流）
│       到点 → 把 m->connect 命令插入队列头（可先回调 updateConnectOptions 刷新凭证）
│
└──→ 重连成功：completeConnection 置 retrying=0
        → onSuccess（sessionPresent）/ connected（cause="automatic reconnect"）
        → v5 应用 RECEIVE_MAXIMUM
        → 订阅是否恢复，看 clean session 与会话是否过期
```

回看开头问题的结论：
- 重连由 `shouldBeConnected` + `retrying` 两个标志控制，主动 `disconnect()` 不会触发重连；
- 重试间隔是指数退避 + 随机抖动（±20%），防惊群；
- 重连只修复传输层，订阅/离线消息是否还在由会话层决定，`clean session=true` 时每次重连都是新的会话。


