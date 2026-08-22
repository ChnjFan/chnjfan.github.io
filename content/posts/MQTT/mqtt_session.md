+++
title = "会话：clean session 真正清理了什么"
description = "分清连接与会话，看懂 v3/v5 的会话清理语义"
date = "2026-08-15"
aliases = ["MQTT-session"]
author = "ChnjFan"
tags = [
    "paho.mqtt.cpp",
    "MQTT",
]
categories = [
    "MQTT",
]
+++

MQTT 里最容易被名字骗的两个概念：「clean session」和「会话」。

你在 C++ 客户端里写 `connOpts.set_clean_session(false)`，想着「保留会话、断线重连不用重订阅」，结果发现重连后消息还是对不上。配了 `set_clean_session(true)` 清掉旧会话，却发现一点用都没有。

更隐蔽的坑：升级到 MQTT 5.0 之后，clean_session() 这个函数失效但却不告诉你，行为悄悄发生了变化。

问题出在哪？**连接 ≠ 会话**。连接是 TCP + MQTT 握手的那条通道，会话是 Broker 侧保存的「状态」，包含订阅列表、未确认的 QoS 1/2 消息、离线队列。断线断开的是连接，不一定会清理会话。`session present` 标志就是服务端告诉客户端这次 CONNACK 是不是续接旧会话。

v3 和 v5 把「清理」拆成了两个概念。v3 的 **clean session** 一个开关管全部：`true` 表示「断开即清」，`false` 表示「服务端保留会话」。v5 拆成 **clean start**（连接时要不要清）和 **Session Expiry Interval**（断开后会话存活多久，默认 0 = 立即过期）。

Paho 用「版本条件写入 + 强制互斥」来防止踩坑，但一些处理也让用户无法感知。`set_clean_session()` 只在版本 < 5 时写入，`set_clean_start()` 只在版本 >= 5 时写入；`set_mqtt_version()` 切版本时会把另一个标志清零，所以「配了但没生效」通常是版本不对应，而且不报错。

沿 `connect_options.cpp`（C++ 配置）→ `MQTTAsyncUtils.c`（CONNACK 后的清理判定与 `cleanSession` 实现）→ 报文字节（Connect Flags bit1），逐层拆解 clean session / clean start 到底在「清理」什么、v3 和 v5 的语义怎么对应、为什么「配了像没配」却不报错。

会话清理在四个地方调用：连接成功时（cleansession || cleanstart）、连接成功但 `sessionPresent == 0`、断开时（`cleansession || (v5 && sessionExpiry == 0)`），以及 v5 会话在服务端过期后。

客户端通过 `MQTTAsync_cleanSession` 清空会话，主要清空在途消息列表、消息 ID 归零、释放 pending 响应、清掉持久化的在途消息，订阅是服务端会话的一部分，客户端本地不存订阅列表。


## 会话保留与清除

「会话」是 MQTT 里最容易和「连接」混淆的概念。连接是 TCP + 握手的通道，会话是 Broker 挂在 `clientID` 上的状态：

- 订阅列表，包含哪些 topic、什么 QoS
- 未确认的 QoS 1/2 在途消息
- 离线队列（`clean session = false` 断开期间 Broker 积攒的消息）
- v5 会话过期计时器

客户端本地也有一份「会话状态」，在途消息列表（等待确认的 QoS 1/2）、消息 ID 计数、pending 响应。Broker 清订阅和队列，客户端清在途消息。

判断「这次连接是不是续接旧会话」，靠 CONNACK 的 `session present` 标志，值为 1 说明 Broker 连接了旧会话，0 表示新建会话。


### clean session：一个开关管理会话

v3（3.1/3.1.1）的 `clean session` 使用一个布尔值覆盖全部场景：

- `true`：连接时要求 Broker 丢弃该 clientID 的旧会话并建新会话；断开时立即清理，订阅、队列全部作废，重连必须重新订阅；
- `false`：Broker 保留会话，断线期间继续保留离线消息（队列策略决定），重连后 session present=1，服务端会把离线消息递给你。


### clean Start + Session Expiry Interval

MQTT 5.0 把一个开关拆成时间和连接两个维度：

- **Clean Start**（Connect Flags bit1）：只在连接时清一次。1 = 丢弃旧会话开新会话；0 = 尝试续接旧会话。
- **Session Expiry Interval**（CONNECT 属性，单位秒）：会话断开后存活多久。0 = 断开即过期（行为 ≈ v3 的 `clean session=true`）；0xFFFFFFFF = 永不过期；N 秒 = 断开后 N 秒内重连还能续接，这期间 Broker 替你保存订阅和离线队列。

在 v5 版本中，如果想要保留会话，只设 `clean start = 0` 还不够，session expiry 默认是 0，断开瞬间会话照样过期。


### 会话清理的时机

会话清理不只是在断连后才发生，代码中在四处进行了清理判断：

#### 连接成功时

```c
// paho.mqtt.c/src/MQTTAsyncUtils.c:2016-2027
static int MQTTAsync_completeConnection(MQTTAsyncs* m, Connack* connack)
{
    if (m->c->connect_state == WAIT_FOR_CONNACK)
    {
        if ((rc = connack->rc) == MQTTASYNC_SUCCESS)
        {
            if (m->c->cleansession || m->c->cleanstart)
                rc = MQTTAsync_cleanSession(m->c);  // 设置新建会话创建前要清理
            else if (m->c->MQTTVersion >= MQTTVERSION_3_1_1 
                    && connack->flags.bits.sessionPresent == 0)
            {// 服务端返回没有旧会话，所以客户端要清理
                rc = MQTTAsync_cleanSession(m->c);
            }
            
        }
    }
}
```

`clean start / clean session = true` 时，无论服务端有没有旧会话，本地在途状态一律清空，服务端在处理 CONNECT 时也会清。

客户端声明保留会话，但 CONNACK 说服务端没有旧会话可以连接，所以本地也要清理在途消息，避免两边状态不一致。


#### 连接断开时

```c
// paho.mqtt.c/src/MQTTAsyncUtils.c
void MQTTAsync_closeSession(Clients* client, 
            enum MQTTReasonCodes reasonCode, MQTTProperties* props)
{
    MQTTAsync_closeOnly(client, reasonCode, props);

    if (client->cleansession ||
         (client->MQTTVersion >= MQTTVERSION_5 && client->sessionExpiry == 0))
        MQTTAsync_cleanSession(client);
}
```

连接断开时，如果 v3 版本的 `cleansession == true` 说明需要清空会话；v5 版本判断会话过期时间，如果 `sessionExpiry == 0` 表示断开立即清空会话。


#### 服务端侧清会话

MQTT 5.0 在 session expiry 到期后，Broker 自己清掉会话的订阅与队列，并不会通知客户端，直到下一次连接时从 `session present=0` 发现。

所以如果设置了 session expiry 之后，连接断开后客户端会一直保留会话状态，直到下一次重新连接时如果 Broker 返回了 `sessionPresent == 0` 才会清空。如果客户端对象销毁，那么所有的资源都会被释放。


#### 主动清理会话

客户端主动发送一个 `clean start=1` 的相同 ClientID 连接就会把服务端的旧会话顶掉，例如运维操作踢掉残留的旧会话。

{{< notice tip >}}
v5 中**断线重连**想**续接会话**，必须在「断开后 N 秒内」连上，N 就是你连接时设的 Session Expiry。过期后重连 `session present = 0` 不会报错，但是订阅和消息队列都没有了。诊断方法：在 `completeConnection` 或 `connected` 回调里看 session present，为 0 时需要主动重新订阅。
{{< /notice >}}


## 版本条件写入与强制互斥

### 版本条件写入：条件不满足，直接不写

paho.mqtt.cpp 的 `connect_options` 对两个标志的 setter 都是通过版本进行过滤，错误的配置直接忽略。

```cpp
// paho.mqtt.cpp/src/connect_options.cpp:256-264
// Clean sessions only apply to MQTT v3, so force it there if set.
void connect_options::set_clean_session(bool clean)
{
    if (opts_.MQTTVersion < MQTTVERSION_5)
        opts_.cleansession = to_int(clean);
}

// Clean start only apply to MQTT v5, so force it there if set.
void connect_options::set_clean_start(bool cleanStart)
{
    if (opts_.MQTTVersion >= MQTTVERSION_5)
        opts_.cleanstart = to_int(cleanStart);
}
```

`set_clean_session(true)` 在 v5 版本下整个赋值语句都被跳过，不会报错、不抛异常、不写日志，`cleansession` 保持原值。反过来 v3 下调用 `set_clean_start()` 也是一样被过滤，因为 v3 的协议里根本没有 Clean Start，只有 Clean Session。


### 强制互斥：切版本时反向清零

如果只做「条件写入」，还有一条路径会被遗漏：用户先用 v3 版本设置了 `cleansession`，再调用 `set_mqtt_version(5)` 切到 v5。此时 v5 版本下 `cleansession` 字段没有任何意义，如果不清空要么被 paho.mqtt.c 拦截，要么会造成行为混乱。所以在 `set_mqtt_version` 时进行了判断清零：

```c
// paho.mqtt.cpp/src/connect_options.cpp:309-314
void connect_options::set_mqtt_version(int mqttVersion)
{
    opts_.MQTTVersion = mqttVersion;

    if (mqttVersion < MQTTVERSION_5)
        opts_.cleanstart = 0;     // 切到 v3：清掉 v5 标志
    else
        opts_.cleansession = 0;   // 切到 v5：清掉 v3 标志
}
```

### connect 时的兜底

`async_client::connect` 在调用 `MQTTAsync_connect` 前还有一次兜底判断，再次强制互斥清零：

```cpp
token_ptr async_client::connect(connect_options opts,
         void* userContext, iaction_listener& cb)
{
    // Remember the requested protocol version
    mqttVersion_ = opts.opts_.MQTTVersion;

    // The C lib is very picky about version and clean start/session
    if (opts.opts_.MQTTVersion < 5)
        opts.opts_.cleanstart = 0;
    else
        opts.opts_.cleansession = 0;

    //... 创建 token、MQTTAsync_connect
}
```

这里主要防止用户绕过 setter 直接操作 `opts_`，因为这个成员是 public，或者构造 `connect_options` 后又被其他地方修改。

加上 paho.mqtt.c 的 `BAD_MQTT_OPTION` 校验，这两个状态在版本之间的互斥有三层防护：setter 过滤 → connect 兜底 → C 库拒绝。设计选择是在源头尽量不产生脏状态，万一产生了，connect 时兜住，再不济 C 库报错。

{{< notice tip >}}
1. `set_clean_session()`/`set_clean_start()` 不生效且无报错，第一反应查版本，v5 没有 clean session 语义，v3 没有 clean start 语义。不需要在 setter 中 debug。
2. **v5 的「保留会话」要设置两处状态**。v5 想保留会话必须 `clean_start(false) + session_expiry_interval(N)`。只设其中一个都是「看起来对、但行为错」。
3. 初始化顺序建议先 `set_mqtt_version` 设置版本，再设 clean 标志，跟库的过滤逻辑相同。
{{< /notice >}}


## 本地会话清理

### cleanSession 在清理什么

前面几节反复出现 `MQTTAsync_cleanSession`，现在我们完整拆开，看看 cleanSession 到底在清理什么。

```c
// paho.mqtt.c/src/MQTTAsyncUtils.c:2580-2599（节选）
static int MQTTAsync_cleanSession(Clients* client)
{
#if !defined(NO_PERSISTENCE)
    rc = MQTTAsync_unpersistInflightMessages(client);   // 移除持久化的在途消息
#endif
    MQTTProtocol_emptyMessageList(client->inboundMsgs); // 清空入站在途消息
    MQTTProtocol_emptyMessageList(client->outboundMsgs);// 清空出站在途消息
    client->msgID = 0;                                  // 消息 ID 归零
    if ((found = ListFindItem(MQTTAsync_handles, client, clientStructCompare))
         != NULL)
    {
        MQTTAsyncs* m = (MQTTAsyncs*)(found->content);
        MQTTAsync_NULLPublishResponses(m);             // 释放 pending 发布响应
        MQTTAsync_freeResponses(m);                    // 清空响应列表
    }
    //...
}
```

每一项都在清理「等待确认」的状态：

- **在途消息**（inbound/outbound）：QoS 1/2 报文发出后还没等到 ACK 的消息。出站在途消息是发了 PUBLISH 等 PUBACK/PUBCOMP；入站在途消息是 Broker 发来的 PUBLISH 等我们回确认。
- `msgID = 0`：消息 ID 计数器归零。不清的话，复用旧 ID 可能匹配到残留状态。
- **pending 响应**：异步库内部为「等 ACK」设计的结构（QoS 2 的 PUBREC/PUBCOMP 流程需要）。释放后，连接状态回到「什么都没发生过」。
- **持久化在途消息**：如果开了持久化，磁盘上的在途记录一并抹掉。

注意客户端本地不会存储「**订阅列表**」，订阅只存在于 Broker 侧会话里，本地客户端只有在途消息队列。所以客户端本地能清的只有「等确认的状态」，订阅靠 Broker 侧清理。不持久化会话时，重连后一切等待确认的状态都只能从头来。


### 报文中的差异

v3/v5 在报文中的差异只有一个 bit，Connect Flags 的位。

```
connect_options.cpp           C++:  version 过滤 → opts_.cleansession / .cleanstart
    ↓
MQTTPacketOut.c:91-98         报文:  v5 → bits.cleanstart = client->cleanstart
                                    v3 → bits.cleanstart = client->cleansession
    ↓
 报文结构：                     CONNECT 第 7 个字节（Connect Flags），bit1
```

`cleansession`、`cleanstart` 和 `session present`（CONNACK 里的标志）三个名词在不同层出现，但语义都是 CONNECT 中 Connect Flags 的一位。

`cleansession`/`cleanstart` 是 CONNECT Connect Flags 的 bit1，`session present` 是 CONNACK flags 的 bit0，它们在不同报文的不同位上，但是共同描述了「会话从哪开始/是否续接」

我们把本篇容易踩坑的地方汇总成一张表：

| 你以为的配置 | 实际发生 | 诊断 |
|---|---|---|
| v5 + `set_clean_session(true)` | 静默无效，字段根本没写入 | `cleansession` 在 v5 无语义 |
| v5 + 只设 `clean_start(false)` | 连接时尝试续接，但断开立即过期 | 缺 `session_expiry_interval` |
| v5 + `clean_start(true)` | 每次连接都建新会话，旧订阅/队列作废 | 预期内，但重订阅别忘 |
| v3 + `set_clean_start(true)` | 静默无效 | clean start 是 v5 概念 |
| 复用会话前 Session Expiry 已过期 | session present=0，无任何报错 | 在 `connected` 回调里查 session present |

以后统一排查故障先确认 MQTT 的版本，然后对照上面的表看哪个状态没有设置。


## 总结

回看开头的三个结论：

1. 「清理」有四个触发场景：连接成功、session present=0 对账、断开、v5 服务端过期。
2. 本地 `cleanSession` 清的是等待确认的状态（在途消息、msgID、pending 响应、持久化记录），订阅列表在 Broker 侧清理。
3. 「版本条件写入 + 强制互斥 + connect 兜底」三层防线让配置错误不报错但也不生效。

阶段一到这里收尾：「**报文的结构：固定头、剩余长度与 UTF-8**」教会你看报文字节，「**第一次握手：CONNECT/CONNACK 与版本协商**」带你完成协议握手流程，本篇讲清连接之后「会话」这层状态。下一篇进入系列最核心的部分「QoS 状态机：从 PUBLISH 到 PUBCOMP」，了解清楚「在途消息」到底怎么流转、消息 ID 怎么分配、QoS 1 重发和 QoS 2 的四步握手在代码里长什么样。

