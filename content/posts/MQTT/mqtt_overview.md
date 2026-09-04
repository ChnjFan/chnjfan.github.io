+++
title = "一篇文章讲清 MQTT 5.0：从连接、会话到消息交付"
description = "从一次完整的客户端生命周期理解 MQTT 5.0，并对照 MQTT 3.1.1 看清协议的能力与边界。"
date = "2026-09-03"
aliases = ["mqtt-overviw"]
author = "ChnjFan"
tags = [
    "MQTT",
]
categories = [
    "MQTT",
]
+++

## MQTT 不只是发布/订阅

假设有一台设备持续上报温度。仪表盘需要实时展示，告警服务只关心越界读数，数据平台则负责长期存储。

如果设备分别连接这三个服务，它就必须知道每个服务的地址、在线状态和通信协议。以后新增一个消费者，设备端也要跟着修改。MQTT 把发布和消费分开：设备只向某个 Topic 发布消息，消费者只订阅自己关心的 Topic，Broker 负责匹配和分发。

很多人因此把 MQTT 概括成“轻量级发布/订阅协议”。但只记住发布/订阅，很容易把 QoS、会话、遗嘱消息和保留消息混在一起。消息能不能送达、断线后能不能恢复、是否可能重复，以及谁能看到设备的最后状态，都取决于连接、会话、订阅和消息交付状态如何配合。



### Broker 让通信双方不再彼此认识

在 MQTT 中，设备、手机 App、后端服务，甚至另一个 Broker，都可以作为 Client 接入。Client 通过网络连接与 Broker 通信，同一个 Client 也可以同时发布和订阅消息。“发布者”和“订阅者”只是某次通信中的角色，并不是两类互斥的程序。

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260903151920876.webp)

设备发布的是 Topic Name `devices/42/telemetry` 和一段 Payload。仪表盘、告警服务、数据平台会提前向 Broker 提交各自的 Topic Filter。只要 Filter 匹配这个 Topic Name，Broker 就会把消息安排投递给对应的 Client。

这种模型带来了三种解耦：

- 空间上，发布者不需要知道订阅者的地址、数量，也不关心它们用什么语言实现。
- 时间上，只要会话、QoS 和 Broker 策略允许，订阅者不必和发布者同时在线。
- 处理上，发布者发出 PUBLISH 之后，不需要等待每个消费者完成自己的业务逻辑。

但“解耦”不等于“无条件可靠”。设备用 QoS 0 上报遥测时，网络中断可能直接导致消息丢失；订阅者没有可恢复会话时，断线期间的消息也不一定会等它回来。MQTT 没有替业务系统默认选择这些取舍，而是把它们作为协议能力暴露出来。


### 一条消息有两段路

理解 QoS 时，最好不要把 MQTT 想成“发布者直接把消息推给订阅者”。更准确的模型是两段独立的协议交付：发布 Client 先把消息交给 Broker，Broker 再向每个匹配订阅的 Client 投递各自的副本。

{{<mermaid>}}
sequenceDiagram
    participant P as 发布 Client
    participant B as Broker
    participant S as 订阅 Client

    P->>B: ① PUBLISH / QoS 确认链
    Note over P,B: 发布端与 Broker 独立完成交付

    B->>S: ② PUBLISH / QoS 确认链
    Note over B,S: Broker 与订阅端独立完成交付
{{</mermaid>}}

QoS 1、QoS 2 里的确认、重发和 Packet Identifier，都要放回这两段链路里分别看。它们约束的是相邻 MQTT 端点之间的交付过程，并不会自动把数据库写入、外部 HTTP 调用，或者业务侧的幂等处理变成同一笔事务。

这也能解释几个常见现象：

- 设备只发布了一次，多个非共享订阅者仍然会各自收到一份副本；
- 发布端收到 PUBACK，只说明 Broker 确认了这一段交付，不代表所有订阅端都已经完成业务处理；
- Broker 向不同订阅者投递同一条消息时，最终使用的 QoS 也可能受各自订阅条件影响。


### Topic 是分类名称，不是传统队列

Topic Name 是发布消息时携带的分类名称，例如：

```
devices/42/telemetry
```

Topic Filter 是订阅时使用的匹配表达式，例如：

```
devices/+/telemetry   匹配任意设备的 telemetry
devices/#             匹配 devices 下的多层主题
```

它们看起来像文件路径，但不是文件系统路径；也不要把 Topic 理解成一个天然存在的队列。MQTT 定义的是 Topic Name 和 Topic Filter 如何匹配，以及 Broker 如何把消息分发给匹配的订阅。

所以，看到一个 Topic 时，应该先问“哪些订阅会匹配它”，而不是先问“这个队列里积压了多少消息”。

至于消息是否会保留给未来的订阅者、离线 Client 回来后能不能继续接收、多个消费者能不能分摊负载，分别由 Retained Message、Session 和 Shared Subscription 这些机制决定。后面章节会单独展开。


### MQTT 负责运输，不替应用解释内容

MQTT 的 Application Message 包含 Topic Name、Payload、QoS，以及 MQTT 5.0 Properties。对 MQTT 来说，Payload 只是一段二进制数据。它可以是 JSON、Protobuf、图片切片，也可以是应用自己定义的编码。

MQTT 5.0 提供了 Payload Format Indicator 和 Content Type，可以补充说明“这是文本还是二进制”“大致是什么格式”。但协议不会替应用校验字段，不处理 Schema 演进，也不定义业务语义。

所以，下面这些问题都不属于 MQTT 协议本身要解决的范围：Payload 里有哪些字段，Schema 怎么升级；收到消息后写数据库或调用外部系统时，事务一致性怎么保证；业务去重键和幂等策略怎么设计；谁可以连接，谁可以发布或订阅哪些 Topic；敏感数据要使用哪种 TLS、凭据和访问控制方案。

MQTT 定义的是 Client/Server 之间的发布/订阅消息传输协议。它要求底层网络提供有序、无损、双向的字节流；TCP/IP、TLS 和 WebSocket 都可以承载 MQTT。但应用 Payload 的格式，仍然由应用自己决定。


### 先分清四类状态，后面的特性才不会混淆

理解 MQTT 时我们可以先想一想：这个状态由谁保存，什么时候会失效？

| 状态 | 典型内容 | 主要关联对象 | 何时可能消失 |
| --- | --- | --- | --- |
| 网络连接 | TCP/TLS/WebSocket 通道、当前收发字节 | 两个端点 | 断网、超时或关闭连接 |
| MQTT 连接状态 | CONNECT、CONNACK、认证等当前交换 | 当前连接 | 连接结束 |
| 会话状态 | 订阅、未确认 QoS 消息、离线投递状态 | ClientID 与协议端点 | Session Expiry 到期或被清理 |
| 应用状态 | 设备配置、订单、业务去重记录 | 应用系统 | 由业务自行决定 |


后面讲到的功能，基本都能放回这张表里看。Keep Alive 关心网络连接还活着没有；Clean Start 和 Session Expiry 管理的是会话；QoS 处理未确认的协议交付；Retain 和 Will 是为未来订阅者或异常断线安排消息；数据库事务仍然属于应用状态。

本文以 MQTT 5.0 为主线，必要时对照 MQTT 3.1.1。下一章会从这张状态地图进入字节流：CONNECT、SUBSCRIBE、PUBLISH 这些动作，最终在网络上传输的都是 MQTT Control Packet。


## 所有交互最终都变成 MQTT Control Packet

上一章把 MQTT 拆成了连接、会话、订阅和交付状态。现在把视角收回到网络层：这些状态变化，最后是怎么出现在字节流里的？

答案是 MQTT Control Packet。

连接、订阅、发布、确认、心跳和断开，都不只是概念上的动作。它们在网络上传输时，都会变成有固定格式、固定方向和固定先后关系的控制报文。

先建立一个整体印象：MQTT 5.0 一共定义了 15 种控制报文。它们不是 15 套彼此无关的格式，而是共用同一个报文格式，在不同交互阶段承担不同职责。


### 控制报文的格式

每个 MQTT Control Packet 都有 Fixed Header。有些报文还会带 Variable Header 和 Payload，而且顺序固定：

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260903154122151.webp)


这个图不要理解成“每个报文都有三段”。例如，PINGREQ 和 PINGRESP 只有 Fixed Header；CONNACK 有 Fixed Header 和 Variable Header；PUBLISH 的 Payload 是应用消息本体；SUBSCRIBE 的 Payload 是待订阅的 Topic Filter 列表；CONNECT 的 ClientID、Will、用户名和密码位于 Payload。

Fixed Header 的第一个字节把 8 个 bit 分成两部分：

```
高 4 位：Control Packet Type
低 4 位：该报文类型的 Flags
```

以 PUBLISH 为例，低 4 位用来携带 DUP、QoS 和 RETAIN。SUBSCRIBE、UNSUBSCRIBE、PUBREL 的低位则有规定的固定取值。其他控制报文如果带了不合法的 Flags，在 MQTT 5.0 中会被视为 Malformed Packet。

第一个字节之后是 Remaining Length。它表示当前控制报文在 Fixed Header 之后还剩多少字节。这个长度字段本身使用 1 到 4 字节的可变长整数编码：短报文不需要浪费固定 4 字节，较大的报文也能扩展到 268,435,455 字节。

这里最容易误会的是，Remaining Length 不是整个报文长度。它不包含 Fixed Header 里的“类型 + Flags”字节，也不包含自己占用的编码字节。

### 15 种报文，其实只服务于四类动作

硬背报文名很累。按连接生命周期来看，会清楚很多：

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260903154806553.webp)

| 类别 | 报文 | 方向 | 解决的问题 |
|---|---|---|---|
| 连接 | CONNECT、CONNACK | Client → Server；Server → Client | 建立 MQTT 连接、返回结果、协商能力 |
| 认证 | AUTH | 双向 | MQTT 5.0 的多轮增强认证 |
| 发布 | PUBLISH | 双向 | 发送 Application Message |
| QoS 1 确认 | PUBACK | 双向 | 确认一条 QoS 1 PUBLISH |
| QoS 2 确认 | PUBREC、PUBREL、PUBCOMP | 双向 | 完成 QoS 2 的四步交付 |
| 订阅 | SUBSCRIBE、SUBACK | Client → Server；Server → Client | 创建订阅并返回每个 Filter 的结果 |
| 退订 | UNSUBSCRIBE、UNSUBACK | Client → Server；Server → Client | 删除订阅并返回结果 |
| 保活 | PINGREQ、PINGRESP | Client → Server；Server → Client | 在无业务流量时确认连接仍存活 |
| 断开 | DISCONNECT | MQTT 5.0 中双向 | 正常结束连接，或说明关闭原因 |

其中 AUTH 是 MQTT 5.0 新增的报文；其他核心报文在 MQTT 3.1.1 中已经存在。MQTT 5.0 的变化不是“新增了一批基础动作”，而是让更多动作可以携带明确的失败原因、协商结果和扩展属性。


### Packet Identifier 是一次协议交换的关联键

QoS 1、QoS 2、订阅和退订，都不是“发出去就结束”的操作。发送方发出请求后，还要等后续确认报文回来。为了把确认报文和之前的请求对应起来，部分控制报文会携带 Packet Identifier。

{{<mermaid>}}
sequenceDiagram
    participant C as Client
    participant B as Broker

    C->>B: PUBLISH, Packet Identifier = 42
    B-->>C: PUBACK, Packet Identifier = 42
    Note over C,B: 42 关联这一轮 QoS 1 交付

    C->>B: SUBSCRIBE, Packet Identifier = 43
    B-->>C: SUBACK, Packet Identifier = 43
    Note over C,B: 43 关联这一轮订阅请求
{{</mermaid>}}

Packet Identifier 是一个 2 字节、非零的协议字段。它只用于关联一次协议交换，不是 ClientID，也不是全局唯一的消息 ID，更不是业务订单号。一次确认链结束后，这个 Identifier 可以在后续交互中再次使用。

它出现的报文也有规律：

- QoS 大于 0 的 PUBLISH；
- PUBACK、PUBREC、PUBREL、PUBCOMP；
- SUBSCRIBE、SUBACK；
- UNSUBSCRIBE、UNSUBACK。

QoS 0 的 PUBLISH 不需要确认，所以不带 Packet Identifier。到 QoS 章节时，这个差别会成为状态机复杂度的分界线。


### Properties 是 MQTT 5.0 的扩展插槽

在 MQTT 3.1.1 里，很多失败场景只能拿到很粗的返回码。客户端可能知道“订阅失败了”或“连接被拒绝了”，但不一定能分清原因：是权限不足、报文太大、服务端不支持共享订阅，还是资源限额已经用完。

MQTT 5.0 在不同控制报文的规定位置加入了 Properties。每个 Property 都有自己的标识符、数据类型，以及允许出现的报文范围。例如：

- `Session Expiry Interval` 出现在连接或断开相关报文中；
- `Message Expiry Interval` 属于 PUBLISH 或 Will；
- `Receive Maximum` 和 `Maximum Packet Size` 用于协商资源边界；
- `Topic Alias` 用于减少重复 `Topic Name` 的传输；
- `Response Topic` 与 `Correlation Data` 支持请求—响应模式；
- `User Property` 用于传递 MQTT 不定义语义的键值对。

Properties 不是一个“想放什么就放什么”的键值对容器。某个属性能不能出现、能不能重复、可以放在哪类报文里，都由规范规定。比如 `Will Properties` 属于 CONNECT 的 Will 部分，不是任意 PUBLISH 都能附带的字段。

后文不会按属性编号逐个背。它们会跟着问题出现：连接时讲会话过期和能力协商，发布时讲消息过期和 `Topic Alias`，订阅时讲 `Subscription Identifier`，最后再汇总成一张 MQTT 5.0 属性地图。

### Reason Code 让“失败”终于可被解释

MQTT 5.0 还为多种响应报文增加了 Reason Code。

{{<mermaid>}}
sequenceDiagram
    participant C as Client
    participant B as Broker

    C->>B: SUBSCRIBE devices/+/telemetry
    B-->>C: SUBACK<br/>Reason Code: Granted QoS 1

    C->>B: SUBSCRIBE $share/workers/devices/+/telemetry
    B-->>C: SUBACK<br/>Reason Code: Shared Subscriptions not supported
{{</mermaid>}}

在 MQTT 5.0 中，CONNACK、PUBACK、PUBREC、PUBREL、PUBCOMP、DISCONNECT 和 AUTH 都会携带一个 Reason Code。

SUBACK 和 UNSUBACK 稍有不同：它们会针对请求里的每个 Topic Filter，分别返回一个 Reason Code。

Reason Code 的取值也有基本约定：成功通常使用小于 `0x80` 的值，失败使用大于或等于 `0x80` 的值。Reason String 可以补充一些面向用户的诊断信息，方便日志排查，但应用程序不应该把它当成稳定协议来解析。真正适合写进程序分支判断的，是标准化的 Reason Code。


### 报文结构只是地图，不是阅读终点

到这里，你已经可以把抓包里最常见的 MQTT 报文放回四类动作：建立连接、发布交付、管理订阅、维持或结束连接。

但报文本身只能告诉我们“网络上传了什么”，还不能解释状态从哪里来。比如：CONNECT 为什么要携带 Clean Start 和 Session Expiry？CONNACK 里的 Session Present 到底说明了什么？为什么连接成功后，旧订阅有时仍然有效，有时又必须重新创建？

下一章从 CONNECT → CONNACK 开始，讲 MQTT 如何建立一条连接，以及它如何在连接建立时决定会话是否延续。


## CONNECT 不只是登录，还在协商整条连接

TCP 连接建立成功，并不等于 MQTT 已经连接成功。TCP、TLS 或 WebSocket 只是提供一条可以传输字节的通道；在这条通道上，MQTT Client 还必须先发送 CONNECT，Broker 再用 CONNACK 明确回答是否接受连接。

只有收到成功的 CONNACK，Client 才真正进入 MQTT 已连接状态。

{{<mermaid>}}
sequenceDiagram
    participant C as Client
    participant B as Broker

    C->>B: 建立 TCP / TLS / WebSocket 通道
    C->>B: CONNECT<br/>ClientID、会话意图、认证信息、限制、Will
    B-->>C: CONNACK<br/>结果、Session Present、服务端能力与限制
    Note over C,B: 只有成功的 CONNACK 之后，才可进行正常发布与订阅
{{</mermaid>}}

把 CONNECT 理解成“登录请求”并不算错，只是少了一层协议含义。它不只是提交身份信息，还会在连接建立时完成几项关键协商：

1. 标识这次连接属于哪个 Client；
2. 表达是否尝试恢复旧会话；
3. 告诉对端自己能接收什么、希望对端遵守哪些限制；
4. 注册认证信息与异常断线后的 Will。


### ClientID：会话的名字，不是安全身份

ClientID 用来标识 MQTT Client。Broker 会用它判断这次连接是否可能关联到已有会话，也会用它隔离不同 Client 的订阅、未确认消息等状态。

但 ClientID 不是用户名，也不是可信身份凭据。只要缺少额外的认证和授权约束，任何能伪造 ClientID 的 Client，都可能尝试接管同名会话，或者造成连接冲突。

所以这三件事要分开看：

| 概念 | 回答的问题 | 常见来源 |
|---|---|---|
| ClientID | 这是谁的协议会话？ | CONNECT Payload |
| 身份认证 | 它是否证明了自己的身份？ | TLS 证书、用户名密码、增强认证 |
| 授权 | 它能发布或订阅哪些 Topic？ | Broker ACL、外部身份系统、产品策略 |

ClientID 的命名方案属于应用设计。设备序列号、随机 UUID、用户与终端的组合，都可以是合理选择。关键是不要把“名字唯一”误认为“身份可信”。


### CONNECT 同时携带多类意图

从字段看，CONNECT 很长；从功能看，可以拆成几组：

| 意图 | CONNECT 中的代表字段或属性 | 它要解决的问题 |
|---|---|---|
| 协议匹配 | Protocol Name、Protocol Version | 双方是否说同一种 MQTT 版本    |
| 会话意图 | ClientID、Clean Start、Session Expiry Interval | 这次要新建会话，还是尝试恢复旧会话 |
| 连接存活 | Keep Alive | 长时间没有业务消息时，如何检测连接失效 |
| 身份与认证 | User Name、Password、Authentication Method/Data | Broker 如何识别和验证 Client |
| 交付与资源限制 | Receive Maximum、Maximum Packet Size、Topic Alias Maximum | Client 愿意接收多少在途消息、多大的报文 |
| 异常断线行为 | Will Flag、Will QoS、Will Retain、Will Properties | Client 非正常消失后，Broker 应如何替它发布消息 |

其中，Clean Start 和 Session Expiry 决定会话如何延续。它们很容易和“当前网络连接是否刚建立”混在一起，下一章会单独展开。

Keep Alive 也不是“每隔 N 秒必须发一个 PINGREQ”。它表示 Client 在连接上允许的最长静默间隔。只要正常的 MQTT 控制报文还在流动，就不一定需要额外 Ping。具体的超时判定，以及 PINGREQ/PINGRESP 的行为，会放到连接管理章节再讲。


### CONNACK 回答三个问题

Broker 收到 CONNECT 后，会用 CONNACK 至少回答三件事：

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260903163624266.webp)

首先判断连接是否成功。MQTT 5.0 用 Reason Code 表示成功或失败。失败原因可以包括认证失败、ClientID 不合法、服务端暂不可用、超出连接速率限制等。

其次是 Session Present。它回答的是：Broker 端是否真的存在旧会话，并且这次连接是否恢复了它。这个值不是 Client 单方面设置的开关。Client 可以请求尝试恢复旧会话，但 Broker 未必有可恢复的会话。因此，应用不能只看自己在 CONNECT 里发了什么，还要检查 CONNACK 返回了什么。

最后告知服务端的能力和限制。MQTT 5.0 允许 Broker 在连接阶段直接告诉 Client 最大允许 QoS、是否支持 Retained Message、是否支持通配符订阅、共享订阅和 Subscription Identifier、可接受的最大 Packet Size、允许的可靠消息在途数量、可接受的 Topic Alias 范围、是否由服务端指定 Keep Alive，以及是否建议切换到另一个 Server。这样一来，Client 不必先发起一次可能失败的操作，再用失败结果去试探 Broker 是否支持某项可选能力。

还要注意，很多限制是双向分别声明的。Client 在 CONNECT 中声明“我能承受什么”，Broker 在 CONNACK 中声明“我允许什么、我能承受什么”。例如双方都可以通过 Receive Maximum 限制自己愿意同时接收多少条 QoS 大于 0 的未完成交付。它不是某一方单独设置的全局并发开关。

### MQTT 5.0 的增强认证是一段报文交互

用户名和密码适合一次性认证。但有些场景需要挑战/响应、多步协商，或者在连接存续期间重新认证。MQTT 5.0 为这类场景增加了 AUTH。

{{<mermaid>}}
sequenceDiagram
    participant C as Client
    participant B as Broker

    C->>B: CONNECT<br/>Authentication Method + Authentication Data
    B-->>C: AUTH<br/>Continue Authentication + challenge
    C->>B: AUTH<br/>Continue Authentication + response
    B-->>C: CONNACK<br/>Success

    Note over C,B: 可重复多轮；认证失败时 Broker 可拒绝连接并关闭通道
{{</mermaid>}}

`Authentication Method` 用来指定双方采用哪种认证机制，`Authentication Data` 则承载该机制需要的数据。

MQTT 只定义这段交换使用什么报文框架，不规定必须使用 OAuth、SASL，还是某种企业身份协议。因此，增强认证也不能替代 TLS。

- AUTH 解决的是认证交互如何在 MQTT 连接内传递；
- TLS 解决的是传输保密性、完整性，以及通常意义上的服务端身份验证；
- Broker 的授权策略则决定认证成功后的 Client 可以操作哪些 Topic。


### MQTT 3.1.1 与 5.0：连接阶段最大的变化

| 主题 | MQTT 3.1.1 | MQTT 5.0 |
|---|---|---|
| 协议版本号 | Level 4 | Level 5 |
| 会话控制 | 一个 Clean Session 开关 | Clean Start + Session Expiry Interval |
| 连接失败信息 | 较粗粒度的 CONNACK 返回码 | 更细的 Reason Code、可选 Reason String |
| 能力与限制 | 通常依赖产品文档，或在失败后试探 | CONNACK 可声明多项能力和资源限制 |
| 多轮认证 | 无 AUTH 报文 | CONNECT、CONNACK、AUTH 可组成认证对话 |
| 服务端引导 | 缺少标准化重定向信息 | 可通过 Server Reference 提供替代服务端 |

MQTT 5.0 没有改变“Client 发送 CONNECT，Broker 返回 CONNACK”这个框架。它真正补上的，是会话时间、故障解释、资源协商和扩展认证这些连接阶段原本不够明确的部分。

收到成功的 CONNACK 后，Client 不能立刻假设“我之前的订阅还在”“未确认消息会自动恢复”，或者“重连已经完成”。它真正需要判断的是：这次连接，接上的是一个全新的会话，还是同一个 ClientID 之前留下的会话？


## 连接会断，会话可以继续存在

“自动重连后为什么还收不到消息？”这类问题，很多时候不是连接没有建起来，而是把连接和会话当成了同一件事。

连接是一条当前可用的网络通道；会话是围绕 ClientID 保存的协议状态，可以跨越多次连接继续存在。

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260903171813139.webp)

TCP 断开、Wi‑Fi 切换、设备重启，或者 Broker 主动关闭连接，都会结束当前 Network Connection。但只要会话没有被清理或过期，后续使用同一 ClientID 建立的新连接，仍然可能接上原来的状态。


### 会话到底保存什么

“Broker 记住订阅”只是会话的一部分。从协议视角看，会话相关状态至少包括几类内容：

| 状态 | 示例 | 为什么需要跨连接保存 |
|---|---|---|
| 订阅 | `devices/42/commands` 的 Topic Filter、请求 QoS、订阅选项 | 重连后不必重复声明同一份订阅 |
| 未完成的 QoS 交付 | 已发未确认的 PUBLISH、PUBREC/PUBREL 阶段的消息 | 让中断的 QoS 1/2 流程能够继续 |
| 离线期间待交付的消息 | 与持久会话匹配的消息 | 订阅 Client 回来后仍有机会接收 |
| 会话配置 | Session Expiry、Subscription Identifier 等 | 让 Broker 知道状态应保留多久、怎样解释 |

Client 自己也要保存这些交付流程对应的本地状态。否则 Broker 虽然还记得旧会话，Client 却已经忘了哪些 Packet Identifier 仍在等待确认，重连后仍然无法正确续接。

所以，“使用持久会话”不只是改 Broker 配置。如果 Client 进程可能重启，客户端库的持久化能力、ClientID 的稳定性，以及 Broker 的会话存储策略，都要一起考虑。

### MQTT 5.0 把“清理”拆成了两个问题

MQTT 3.1.1 用一个 Clean Session 同时回答两个问题：这次连接开始时，要不要丢弃旧会话？这次连接结束后，要不要继续保留会话？

简单场景下，这样做够用。但它无法表达“本次先恢复旧会话，断开后只保留 30 分钟”这种需求。

MQTT 5.0 把它拆成两个字段：

- `Clean Start`：本次连接开始时，是否从一个全新的会话开始；
- `Session Expiry Interval`：网络连接结束后，会话还应保留多久。

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260903193641511.webp)

图中有两个关键点：

- Clean Start = 0 只是告诉 Broker 客户端想复用旧会话。它不保证一定能恢复。旧会话可能已经被 Broker 删除，也可能已经过期；还有一种情况是，这个 ClientID 之前根本没有成功建立过会话。
- 恢复结果以 Session Present 为准。客户端不能只看自己在 CONNECT 里填了什么参数，还要检查 CONNACK。Session Present = 1 才表示 Broker 找到了旧会话并恢复；否则客户端就应该按新会话处理，比如重新订阅、重建本地状态。


### Session Expiry 是会话的保留时间，不是连接超时

`Session Expiry Interval` 的单位是秒。它规定的是网络连接结束之后，Broker 还能把这个会话保留多久。连接断开以后，只要会话还没过期，客户端下次用同一个 ClientID 连接时，就还有机会恢复订阅关系和未完成的 QoS 状态。


{{<mermaid>}}
timeline
    title Session Expiry 的时间语义
    连接存活 : 会话正在使用
    连接断开 : 开始计算 Session Expiry
    断开后 10 分钟内重连 : 可尝试恢复同一会话
    超过 Session Expiry : Broker 删除会话状态
{{</mermaid>}}

常见取值：

| Session Expiry Interval | 含义 |
| --- | --- |
| `0` | 网络连接结束时，会话立即结束 |
| 正整数 `N` | 连接断开后，最多保留 `N` 秒 |
| `0xFFFFFFFF` | 会话不会因时间到期而自动删除 |

取 0 不表示当前连接无法使用订阅或 QoS，只表示连接一旦结束，Broker 不再为重连保留会话。

Client 还可以在 MQTT 5.0 的 DISCONNECT 中请求调整会话过期时间。这样就能表达"平时保留较短时间，计划维护前延长恢复窗口"这类意图。不过 Broker 仍可能基于管理策略限制实际资源使用。

### MQTT 3.1.1 与 5.0 的对应关系

| 目标 | MQTT 3.1.1 | MQTT 5.0 |
| --- | --- | --- |
| 每次都建立全新会话 | `Clean Session = 1` | `Clean Start = 1` 且 `Session Expiry Interval = 0` |
| 尝试延续旧会话 | `Clean Session = 0` | `Clean Start = 0` |
| 断开后保留有限时间 | 无标准化时长 | `Session Expiry Interval = N` |
| 不因时间自动过期 | `Clean Session = 0` 的常见语义 | `Session Expiry Interval = 0xFFFFFFFF` |
| 判断本次是否恢复成功 | CONNACK 的 Session Present | CONNACK 的 Session Present |

其中，`Clean Start = 1` 且 `Session Expiry Interval = 0`，与 MQTT 3.1.1 的 `Clean Session = 1` 在会话清理语义上对应。

### 重连后检查 Session Present

健壮的 Client 不该把"TCP 又连上了"当作恢复完成，而应根据 CONNACK 走不同分支：

{{<mermaid>}}
flowchart TD
    A["重建网络连接并发送 CONNECT"] --> B["收到成功 CONNACK"]
    B --> C{"Session Present = 1？"}

    C -->|是| D["恢复会话相关状态<br/>继续未完成 QoS 交付<br/>保留已有订阅"]
    C -->|否| E["丢弃无法续接的旧会话状态"]
    E --> F["按应用策略重新订阅<br/>重新初始化必要的交付状态"]
{{</mermaid>}}

这说明了一个常见误区：

> Clean Start = 0，所以我不需要重新订阅。

只有当 Session Present = 1 时，这句话才成立。若返回 0，Client 必须把旧会话视为没有恢复，按自己的策略重新创建订阅和业务状态。


### 会话保留不是"消息永远不丢"

会话只能保留协议允许保存的状态：

- QoS 0 消息本身不具备可靠交付流程
- Message Expiry 到期后，消息失去交付价值
- Broker 可能有队列大小、磁盘、连接数和管理配额限制
- 应用进程重启后，若 Client 没有保存必要本地状态，也无法完整续接交付
- 会话恢复不等于业务处理结果恢复

会话回答的是："这个 Client 回来时，Broker 和 Client 能否继续此前尚未完成的协议关系？"它不是数据库，也不是业务事务日志。


## 订阅把 Topic Filter 变成 Broker 的路由状态

发布者发送完整的 Topic Name，比如 `devices/42/telemetry`，指向一条具体消息的分类。订阅者提交的是可以匹配多个主题的 Topic Filter，比如 `devices/+/telemetry`，描述"我想接收哪些分类的消息"。Broker 收到 SUBSCRIBE 后，把 Topic Filter、请求 QoS 和订阅选项加入会话状态；此后每当 PUBLISH 到达，Broker 用 Topic Name 去匹配这些规则。

### Topic Name 与 Topic Filter

Topic 用 `/` 分隔层级。以设备遥测为例：

```
devices/42/telemetry
devices/42/status
devices/43/telemetry
```

Topic Filter 在 Topic 基础上加了两个通配符：

| 通配符 | 名称 | 规则 | 示例 |
| --- | --- | --- | --- |
| `+` | 单层通配符 | 匹配恰好一个完整层级 | `devices/+/telemetry` |
| `#` | 多层通配符 | 匹配零个或多个后续层级，必须放在末尾 | `devices/#` |


{{<mermaid>}}
flowchart TD
    T["发布 Topic Name<br/>devices/42/telemetry"]

    T --> A["devices/42/telemetry<br/>精确匹配"]
    T --> B["devices/+/telemetry<br/>+ 匹配 42"]
    T --> C["devices/#<br/># 匹配 42/telemetry"]
    T -.不匹配.-> D["devices/42/status"]
    T -.不匹配.-> E["devices/+/status"]
{{</mermaid>}}

几条规则最好在设计 Topic 时就记住：

- `+` 必须独占一个层级。`device+` 不是合法的单层通配用法。
- `#` 要么独占一个层级，要么紧跟在 `/` 之后，并且必须是 Filter 的最后一个字符。
- 通配符只能出现在 Topic Filter 里，不能出现在发布用的 Topic Name 中。
- Topic Name 与 Topic Filter 都是 UTF-8 字符串。Broker 不会替应用做大小写转换、Unicode 归一化或"相近字符"修正。
- 以 `$` 开头的 Topic 有特殊的匹配边界：以 `#` 或 `+` 开头的通配 Filter 不会匹配 `$` 开头的主题。这也是 `$SYS/...` 不会自然落入普通 `#` 订阅的原因。

Filter 的匹配语义是协议的一部分，但 Topic 结构本身不是 MQTT 规范操心的事。所以一旦 Topic 结构定下来再改，订阅规则、ACL 和消费者代码往往得一起动。

## 订阅成功不只是"发出去"就算数

一次订阅至少要经过三步：

1. Client 构造并发送 SUBSCRIBE；
2. Broker 解析、校验，创建或更新订阅；
3. Broker 返回 SUBACK，告知每个 Topic Filter 的最终结果。

{{<mermaid>}}
sequenceDiagram
    participant C as Client
    participant B as Broker

    C->>B: SUBSCRIBE<br/>Packet Identifier = 17<br/>devices/+/telemetry, QoS 1
    B->>B: 校验权限、Filter 与服务端能力
    B-->>C: SUBACK<br/>Packet Identifier = 17<br/>Granted QoS 1
    Note over C,B: 收到 SUBACK 后，订阅才被 Broker 接受
{{</mermaid>}}

一个 SUBSCRIBE 可以携带多个 Topic Filter。SUBACK 则按相同顺序，为每个 Filter 返回一个 Reason Code。所以同一个请求里，部分成功、部分失败很常见：

```
请求：
  devices/+/telemetry       QoS 1
  $share/workers/devices/#  QoS 1
  admin/#                   QoS 2

返回：
  Granted QoS 1
  Shared Subscriptions not supported
  Not authorized
```

别只看"SUBSCRIBE 调用没报错"就以为全成功了，得等 SUBACK 逐项检查每个 Filter 的结果。

QoS 也是协商出来的，不是要多少给多少。Client 请求 QoS 2，Broker 可以只授予 QoS 1。后续投递时，Broker 不会使用高于授予值的 QoS。

### 订阅选项决定"怎么投递"

MQTT 5.0 给每个 Topic Filter 加了 Subscription Options。这些选项不改变匹配规则，只影响 Broker 投递消息的方式：

| 选项 | 回答的问题 | 常见用途 |
| --- | --- | --- |
| Requested QoS | 这份订阅最高接受什么 QoS | 在可靠性与开销间取舍 |
| No Local | 是否接收自己发布的匹配消息 | 避免桥接或回环场景自收自发 |
| Retain As Published | 转发时是否保留原始 RETAIN 标记 | 让消费者区分状态快照与普通实时消息 |
| Retain Handling | 创建或更新订阅时是否发送保留消息 | 控制重订阅后是否再次收到已有状态 |

Retain Handling 最容易被误解。它控制的是订阅建立时 Broker 如何处理已有的 Retained Message：

| Retain Handling 值 | 行为 |
| --- | --- |
| `0` | 每次订阅时都发送匹配的保留消息 |
| `1` | 只有新建订阅时发送；更新已有订阅时不重发 |
| `2` | 不因这次订阅发送保留消息 |

它不会删除保留消息，也不影响后续新发布消息的正常投递。Retained Message 本身的生命周期和语义，后面会单独讲。


### Subscription Identifier：这条消息因何而来

一个 Client 可能同时订阅了两份 Filter：

```
devices/42/#
devices/+/telemetry
```

收到 `devices/42/telemetry` 时，两条都匹配。如果应用需要区分"这条消息是走哪条业务规则进来的"，光看 Topic Name 分不出来。

MQTT 5.0 的解法是：Client 在 SUBSCRIBE 里给订阅设一个非零的 Subscription Identifier，Broker 投递匹配消息时，在 PUBLISH Properties 里把这个 Identifier 带回来。

{{<mermaid>}}
sequenceDiagram
    participant C as Client
    participant B as Broker

    C->>B: SUBSCRIBE<br/>Subscription Identifier = 10<br/>devices/+/telemetry
    B-->>C: SUBACK

    B->>C: PUBLISH devices/42/telemetry<br/>Subscription Identifier = 10
    Note over C: 按订阅来源走不同业务处理分支
{{</mermaid>}}

注意，Subscription Identifier 标识的是订阅规则，不是 PUBLISH 的唯一 ID，也不能代替 QoS 使用的 Packet Identifier。


### Shared Subscription：让消费者分摊处理

普通订阅是广播语义，多个 Client 订阅同一个 Filter，每条匹配消息都会分别投递给每个 Client。

Shared Subscription 则不同：多个 Client 加入同一消费组，一条消息只投递给其中一个。Filter 格式是：

```
$share/{ShareName}/{filter}
```

例如：`$share/workers/devices/+/telemetry`。


{{<mermaid>}}
flowchart LR
    P["设备<br/>PUBLISH devices/42/telemetry"] --> B["Broker"]
    B --> G["共享订阅组 workers"]

    G --> W1["Worker A"]
    G --> W2["Worker B"]
    G --> W3["Worker C"]

    G -.每条匹配消息仅选择一个会话.-> W1
{{</mermaid>}}

Shared Subscription 的核心语义很简单：一条匹配的消息只发给组内一个 Session，不是所有成员。

它适合多个 Worker 并行处理遥测、任务或命令，但有几个边界要清楚：

- Broker 自己决定每条消息选哪个成员。MQTT 不承诺轮询、公平性或任何固定分配算法。
- 多个消费者并行处理时，跨 Client 的消息顺序没法保证。
- 按 MQTT 5.0 规范，创建或加入 Shared Subscription 时不会向该 Session 发送已有的 Retained Message。

所以，Shared Subscription 本质上是"竞争消费"，不是完整的任务队列。任务重试、失败转移、死信队列和业务幂等性，得靠 Broker 产品能力或应用架构自己补。

### 退订与会话结束

UNSUBSCRIBE 用 Topic Filter 删除订阅，Broker 通过 UNSUBACK 返回逐项结果。

持久会话里，订阅不会因为网络暂时断开而自动消失。只会在以下情况被移除：

- Client 明确发送 UNSUBSCRIBE；
- Session 被 Clean Start 清理；
- Session Expiry 到期；
- Broker 按资源或管理策略终止会话。

所以，"断线后没有重新 SUBSCRIBE，但仍然在收消息"不一定是异常，很可能只是成功恢复了之前的会话。

现在 Broker 已经知道哪些会话想接收什么消息了。下一章进入真正的交付链：PUBLISH、QoS 0/1/2、确认报文、重发与 DUP 如何共同决定一条消息可能丢失、可能重复，还是在协议层完成恰好一次交付。

## QoS 是逐跳交付，不是业务事务

QoS 是 MQTT 最常被误读的功能。

很多人把它理解成一道选择题：

- QoS 0：可能丢
- QoS 1：不会丢
- QoS 2：绝不重复

这组说法方向没错，但漏了最关键的一点：QoS 只管一个发送方和一个接收方之间的 MQTT 交付流程。

一条消息从发布 Client 到 Broker，再从 Broker 到每个订阅 Client，至少经过两段独立的交付。每一段都各自选择并执行 QoS 流程。


{{<mermaid>}}
flowchart LR
    P["发布 Client<br/>QoS 2"] -->|"① 独立的 QoS 流程"| B["Broker"]
    B -->|"② 可按订阅条件以 QoS 1 投递"| S1["订阅 Client A"]
    B -->|"③ 可按订阅条件以 QoS 0 投递"| S2["订阅 Client B"]
{{</mermaid>}}


所以，发布者用 QoS 2 把消息交给 Broker，不代表每个订阅者都能以 QoS 2 收到；更不代表订阅者写数据库、调支付接口、执行业务逻辑时也能保证恰好一次。

| QoS | 名称 | MQTT 确认链 | 允许的协议结果 | 典型代价 |
| --- | --- | --- | --- | --- |
| 0 | At most once | 无确认 | 消息可能丢失 | 最低 |
| 1 | At least once | PUBLISH → PUBACK | 消息可能重复 | 中等 |
| 2 | Exactly once | PUBLISH → PUBREC → PUBREL → PUBCOMP | 在这段 MQTT 交付中避免重复交给接收方 | 最高 |

选 QoS 不是比"哪个最好"，而是看这条消息丢失、重复和额外状态成本分别能不能接受。


### QoS 0：发出后不等待确认

QoS 0 的 PUBLISH 不带 Packet Identifier，接收方也不会返回 MQTT 层确认。

{{<mermaid>}}
sequenceDiagram
    participant S as Sender
    participant R as Receiver

    S->>R: PUBLISH<br/>QoS 0, DUP = 0
    Note over S,R: 无 PUBACK；网络或连接出错时不通过 MQTT 重传
{{</mermaid>}}

它适合"下一条数据会覆盖上一条"的场景，比如高频温度、位置或 CPU 使用率。某一次采样丢了，等下一次就行。

但要注意，QoS 0 不意味着底层网络不会出错，只是 MQTT 不会为这条消息保留确认和恢复状态。连接中断、接收端不可用或 Broker 拒绝消息时，别指望 QoS 0 的协议流程能帮你挽回。


### QoS 1：接收方确认"我接管了这条消息"

QoS 1 给 PUBLISH 分配一个 Packet Identifier。发送方收到对应的 PUBACK 之前，都把这条消息当作未完成。

{{<mermaid>}}
sequenceDiagram
    participant S as Sender
    participant R as Receiver

    S->>R: PUBLISH<br/>QoS 1, Packet Identifier = 42, DUP = 0
    R->>R: 接受消息并启动后续投递
    R-->>S: PUBACK<br/>Packet Identifier = 42
    Note over S: 收到 PUBACK 后，42 可被复用
{{</mermaid>}}

PUBACK 只表示接收方接管了这条消息，不要求它先完成数据库写入、下游 HTTP 调用或所有订阅者的业务处理。

重复是怎么来的？看这个场景：

1. 接收方收到 PUBLISH，已经处理或转发了消息；
2. 接收方发出 PUBACK；
3. PUBACK 在网络中丢了，连接随后中断；
4. 发送方不知道，仍认为这条 PUBLISH 未确认；
5. 会话恢复后，发送方重新发了一遍。

{{<mermaid>}}
sequenceDiagram
    participant S as Sender
    participant R as Receiver

    S->>R: PUBLISH<br/>QoS 1, id = 42, DUP = 0
    R--xS: PUBACK id = 42 丢失
    Note over S,R: 网络连接中断
    S->>R: PUBLISH<br/>QoS 1, id = 42, DUP = 1
    R-->>S: PUBACK id = 42
{{</mermaid>}}

`DUP = 1` 的意思是"这可能是重发"，并不能证明应用已经处理过这条业务消息。业务系统如果扛不住重复处理，得自己准备幂等键、去重表或状态机。

这就是 QoS 1 的"至少一次"：只要会话和必要状态能恢复，发送方就会继续尝试完成 MQTT 交付。代价是接收方可能再次收到同一条消息。

### QoS 2：把一次交付拆成两步

QoS 2 的目标是防止接收方重复接管同一条消息。为此，确认被拆成了两个阶段。

{{<mermaid>}}
sequenceDiagram
    participant S as Sender
    participant R as Receiver

    S->>R: PUBLISH<br/>QoS 2, id = 42, DUP = 0
    R->>R: 记录 id = 42，接受消息
    R-->>S: PUBREC id = 42

    S->>R: PUBREL id = 42
    R->>R: 完成 QoS 2 协议交付
    R-->>S: PUBCOMP id = 42

    Note over S,R: 收到 PUBCOMP 后，双方可释放相关状态
{{</mermaid>}}

四个报文的职责：

| 报文 | 发送方的含义 | 接收方应保留的状态 |
| --- | --- | --- |
| PUBLISH | "这是新的 QoS 2 消息" | 记录 Packet Identifier，避免重复接管 |
| PUBREC | "我已接收并接管它" | 等待发送方进入释放阶段 |
| PUBREL | "请完成这次交付" | 可以完成 QoS 2 协议流程 |
| PUBCOMP | "这一轮完成" | 双方释放对应状态 |

关键在于：接收方收到重复的 PUBLISH、但还没收到对应 PUBREL 时，会再次返回 PUBREC，而不会把同一消息重复交给后续接收方。

一旦发送方发出了 PUBREL，就不能再回头重发原始 PUBLISH；此时需要完成的是 PUBREL → PUBCOMP 的后半段。

### QoS 2 仍然不是端到端"业务恰好一次"

别这么说：

> QoS 2 可以确保订单只被创建一次。

QoS 2 能保证的只是：在发送方与接收方之间，这条消息不会因 QoS 2 协议重发而被重复交付。

它覆盖不了这些情况：

- Broker 到订阅 Client 是另一段独立的 QoS 交付；
- 消费者写完数据库后、发送 MQTT 确认前崩溃了；
- 一条 MQTT 消息可能触发多个外部系统；
- 重复的业务请求可能来自不同 ClientID、不同 Topic 或不同应用重试；
- 消息内容本身没有天然的业务唯一键。

QoS 2 的成本也不只是多两个报文。双方都要保存更多中间状态，Broker 要为每个匹配订阅分别管理交付流程。对于高频遥测，把 QoS 2 当默认选择往往得不偿失。

### 重传发生在会话恢复，不是随意重发

MQTT 5.0 对重传有一条边界，很容易被客户端库的"自动重试"行为掩盖：

Client 以 Clean Start = 0 重连，且 CONNACK 表示旧会话存在时，双方必须用原 Packet Identifier 重新发送尚未完成的 QoS 大于 0 的 PUBLISH 和 PUBREL。

{{<mermaid>}}
flowchart TD
    A["连接中断时存在未确认 QoS 1/2 消息"] --> B["重连：Clean Start = 0"]
    B --> C{"CONNACK.Session Present = 1？"}

    C -->|是| D["恢复会话<br/>重发未确认 PUBLISH / PUBREL<br/>沿用原 Packet Identifier"]
    C -->|否| E["旧会话未恢复<br/>不能按原协议状态直接续接"]
{{</mermaid>}}

这就是上一章反复强调 Session Present 的原因：没有恢复同一个会话，QoS 的中间状态就没有共同基础。

Client 库常见的退避、定时重连和断线检测属于实现策略。MQTT 规范管的是会话真正恢复后如何继续未完成交付，不是规定每隔多少秒重发一次 PUBLISH。

如果 PUBACK 或 PUBREC 返回失败 Reason Code，发送方应把对应 PUBLISH 视为已结束，不再重传。至于是否记录失败、告警、降级或交给业务补偿，是应用层的事。


### QoS 与顺序：有规则，但范围比想象中窄

MQTT 5.0 默认要求 Broker 把非共享订阅的 Topic 当作 Ordered Topic 处理：同一发布 Client、同一 Topic、同一 QoS，Broker 向消费者转发时应保持接收顺序。

但这不意味着消费者看到的永远是严格递增的业务序列。重连和重发可能让消费者收到类似：

```
1, 2, 3, 2, 3, 4
```

后两个 2、3 是此前消息的重复投递。Shared Subscription 由多个 Client 并行处理时，跨消费者的处理顺序更没法保证。

所以，如果业务需要严格序号、全局顺序或按设备单调递增，得把业务序列号放进 Payload，并明确消费者在乱序、重复和延迟到达时怎么处理。

QoS 讲的是"这一跳如何把消息交出去"。下一章处理另一类时间问题：Retained Message 为后来订阅者保留最后状态，Will Message 为异常断线安排一条代理发布，Message Expiry 决定一条旧消息何时不再值得投递。

## Retain、Will 和 Expiry：三个不同的时间问题

Retained Message、Will Message 和 Expiry 经常被混成"Broker 以后再发一条消息"。

其实它们回答的是三个不同的问题：

| 机制 | 保留或安排的是什么 | 面向谁 | 触发时机 |
| --- | --- | --- | --- |
| Retained Message | 某个 Topic 的最后状态 | 未来新建的订阅 | 新订阅匹配该 Topic 时 |
| Will Message | Client 异常断线后的代理发布 | 当前或未来匹配的订阅者 | 连接异常结束后 |
| Message Expiry | 一条消息还能否继续投递 | Broker 与匹配订阅者 | 存活时间耗尽后 |

先把它们分开，才能正确设计设备在线状态、配置快照和离线消息。

### Retained Message：让后来者立即看到最后状态

普通 PUBLISH 只发给当时匹配且可投递的订阅。仪表盘如果等设备发布状态之后才上线，默认不会知道设备当前温度或在线状态。

设置 RETAIN = 1，就是告诉 Broker：这条消息除了正常转发，还要作为该 Topic 的最后状态保存下来。


{{<mermaid>}}
sequenceDiagram
    participant D as 设备 Client
    participant B as Broker
    participant U as 新上线仪表盘

    D->>B: PUBLISH devices/42/status<br/>Payload: online, RETAIN = 1
    B->>B: 保存该 Topic 的最新 Retained Message

    U->>B: SUBSCRIBE devices/42/status
    B-->>U: PUBLISH devices/42/status<br/>Payload: online, RETAIN = 1
{{</mermaid>}}

每个 Topic 最多保留一条 Retained Message。新的 retained PUBLISH 会替换旧值，所以它适合表达"现在是什么状态"，不适合保存历史。

例如：

```
devices/42/status       online / offline
devices/42/config        当前配置快照
devices/42/telemetry     通常不保留，只传输实时读数
```

几个容易踩坑的边界：

- `RETAIN = 0` 的普通 PUBLISH 不会清除同 Topic 已有的保留消息。
- 以 `RETAIN = 1` 发布零字节 Payload，会删除同 Topic 已保存的 Retained Message；未来订阅者不再收到它。
- Retained Message 属于 Broker 的保留状态，不属于某个 Client 的 Session。会话结束不会自动删除保留消息。

前面讲过的 Retain Handling 决定"本次订阅建立时是否下发已有 Retained Message"，它不会改变 Broker 中保留状态本身。

### Will Message：Broker 替失联 Client 说最后一句话

Will 不是 Client 断线后自己发出的消息。

它是 Client 在 CONNECT 时提前登记给 Broker 的一条消息。如果 Client 后续异常消失，Broker 就代替它把这条消息发布到指定 Topic。

{{<mermaid>}}
sequenceDiagram
    participant D as 设备 Client
    participant B as Broker
    participant S as 状态订阅者

    D->>B: CONNECT<br/>Will Topic: devices/42/status<br/>Will Payload: offline
    Note over B: Broker 保存 Will

    D--xB: 网络失败或未正常断开
    B->>B: 满足 Will 发布条件
    B->>S: PUBLISH devices/42/status<br/>Payload: offline
{{</mermaid>}}

Will 的典型用途是设备在线状态：

1. 设备连接成功后，主动发布 retained 的 online；
2. 在 CONNECT 中注册 offline 的 Will；
3. 如果设备异常掉线，Broker 代替设备发布 offline；
4. 新订阅者通过 retained 状态立即看到最后结果。

Will 可以独立设置 QoS 与 Retain。所以 offline Will 也可以是 retained 的，不仅通知当前订阅者，也更新以后新订阅者看到的设备状态。

但正常断开时，Broker 会丢弃这条 Will，不会发布。


{{<mermaid>}}
flowchart TD
    A["网络连接结束"] --> B{"Client 是否以<br/>DISCONNECT Normal disconnection 结束？"}

    B -->|是| C["删除 Will，不发布"]
    B -->|否| D{"Session 在 Will Delay 前恢复？"}

    D -->|是| E["不发布 Will"]
    D -->|否| F{"Will Delay 已到<br/>或 Session 已结束？"}

    F -->|是| G["Broker 发布 Will"]
    F -->|否| H["继续等待"]
{{</mermaid>}}

异常情形包括：网络错误、Keep Alive 超时、Client 直接关闭网络连接，或者 Broker 没收到正常 DISCONNECT 就关闭了连接。

MQTT 5.0 还允许 Client 在 DISCONNECT 中用 Disconnect with Will Message 原因码，明确要求 Broker 发布 Will。这适合"客户端知道自己要退出，但仍希望对外表达离线"的场景，跟正常断开不一样。

## Will Delay 用来屏蔽短暂断网

MQTT 3.1.1 中，异常断线后 Will 会立即发布。MQTT 5.0 增加了 Will Delay Interval，单位是秒，默认值是 0，即不延迟。设置非零值后，如果 Will Delay 小于 Session Expiry，Client 在延迟期间重连，Will 就不会发出去。这样短暂的网络抖动就不会被当成"设备离线"广播出去。


{{<mermaid>}}
timeline
    title Will Delay 与会话恢复
    设备异常断线 : Broker 开始等待 Will Delay
    断线后 5 秒 : 设备使用同一会话重连 : 不发布 Will
    另一种情况 : Will Delay 到期 : Broker 发布 offline Will
    特殊情况 : Session 先到期 : Broker 立即发布 Will
{{</mermaid>}}

Will 的实际发布时间，是 Will Delay 到期和 Session 结束这两者里先发生的那个。所以 Will Delay 不是绝对延迟：如果 Session Expiry 比 Will Delay 更短，会话先结束，Broker 就会提前发布 Will。

## Message Expiry

Message Expiry Interval 是 MQTT 5.0 给 PUBLISH 加的生存期。发布者可以告诉 Broker：这条消息只在接下来的 N 秒内有意义。

比如"设备当前告警"的推送，60 秒后可能还有价值；而"第 1234 次瞬时采样"，5 秒后大概就不值得再投递了。


{{<mermaid>}}
sequenceDiagram
    participant P as Publisher
    participant B as Broker
    participant S as 离线订阅 Client

    P->>B: PUBLISH<br/>Message Expiry Interval = 60s
    B->>B: 等待可向 S 投递

    Note over B: 60 秒到期前未能开始向 S 投递
    B->>B: 删除为 S 保存的这份消息
{{</mermaid>}}

Broker 向订阅 Client 转发时，会扣除消息已经在 Broker 里等待的时间，把剩余寿命带给接收方。如果消息过期前 Broker 还没开始向某个匹配订阅者投递，就必须删除为该订阅者保留的副本。

这与 Session Expiry 完全不同：

| 概念 | 倒计时对象 | 到期后发生什么 |
| --- | --- | --- |
| Session Expiry | Client 的会话 | Broker 丢弃订阅和未完成交付等会话状态 |
| Message Expiry | 一条 Application Message | Broker 不再继续为该订阅者投递该消息 |
| Will Delay | 已登记的 Will | 达到时间后由 Broker 发布 Will |

Will 也可以携带 Message Expiry Interval。不过计时从 Broker 实际发布 Will 时开始：CONNECT 里设置的 Will Properties 在发布时变成 Will 消息的寿命，不是从设备最初连接时就开始消耗。

三个机制组合时，先想清楚你要表达什么。以 `devices/42/status` 为例：

{{<mermaid>}}
flowchart LR
    A["设备成功上线"] --> B["发布 retained: online"]
    B --> C["Broker 保存最新状态"]

    D["设备异常断线"] --> E["等待 Will Delay"]
    E --> F["发布 retained Will: offline"]
    F --> C

    C --> G["新订阅者立即收到最后状态"]
{{</mermaid>}}

这里 Retained 的 online/offline 表达的是设备的最新状态；Will 解决的是"设备来不及自己发布 offline"；Will Delay 解决的是"短暂断网是否算离线"；Message Expiry 则用于那些过了有效期就不值得再投递的消息。

不要把 Retained Message 当作历史队列，也不要把 Will 当作严格实时的故障检测。它们都依赖 Broker 对连接结束的判断、配置的延迟时间和会话状态。

下一章回到连接本身：Keep Alive 怎么发现静默失联，DISCONNECT 怎么区分正常与异常关闭，以及重连后哪些状态真的能继续。


## Keep Alive、断开与重连共同管理连接生命周期

连接成功之后，最常见的误解是：只要设置了 Keep Alive，MQTT 就会自动重连并恢复所有状态。

这句话其实混了三件事：Keep Alive 只管发现连接是否长期静默；DISCONNECT 是说明连接为什么结束；至于客户端是否重连、什么时候重连、用什么策略重连，那是另一回事。MQTT 对前两者有明确协议定义，但自动重连的退避、抖动和最大重试次数，主要是客户端库和应用自己的实现策略。

### Keep Alive 不是"每 N 秒发一次心跳"

Client 在 CONNECT 中声明 Keep Alive，单位是秒。它的意思是：Client 发完一个 MQTT Control Packet，到下一次开始发 MQTT Control Packet 之间，允许间隔的最长时间。

只要 Client 正常发布、订阅或确认消息，这些控制报文本身就说明连接还活着，不用额外发 PINGREQ。

{{<mermaid>}}
sequenceDiagram
    participant C as Client
    participant B as Broker

    C->>B: PUBLISH
    Note over C,B: 正常业务报文重置静默计时

    C->>B: PUBACK
    Note over C,B: 仍有 MQTT 流量，不需要 Ping

    Note over C,B: 长时间没有任何 MQTT Control Packet
    C->>B: PINGREQ
    B-->>C: PINGRESP
{{</mermaid>}}

没有其他 MQTT Control Packet 可发时，Client 得在 Keep Alive 时间内发一个 PINGREQ，Broker 收到后回复 PINGRESP。

Keep Alive 设为 0 时，这套定时机制就关闭了，Client 不用按任何周期发控制报文。

### Broker 怎么判断 Client 失联

假设有效 Keep Alive 为 60 秒：

{{<mermaid>}}
timeline
    title Keep Alive = 60 秒
    0 秒 : Client 发送最后一个 MQTT Control Packet
    60 秒前 : Client 应开始发送下一个 Control Packet；无业务流量时发送 PINGREQ
    90 秒 : Broker 仍未收到任何 Client Control Packet
    90 秒后 : Broker 必须像网络失败一样关闭连接
{{</mermaid>}}

Broker 的判定窗口是有效 Keep Alive 的 1.5 倍。这里的"有效值"可能不是 Client 最初发送的值，如果 Broker 在 CONNACK 中返回了 Server Keep Alive，Client 得改用服务端指定的值。

Client 也可以主动发 PINGREQ 检查 Broker 是否还可达。合理时间内没收到 PINGRESP，Client 就该关闭当前网络连接，当作连接失败处理。"合理时间"具体是多少，规范没固定，取决于网络状况、设备功耗和业务时效要求。

Keep Alive 能发现静默失联，但 Broker 也可能主动关闭连接，比如服务端维护、资源限制、认证过期或协议错误。

### DISCONNECT 让关闭原因不再靠猜

MQTT 5.0 中，Client 和 Broker 都可以发送 DISCONNECT。它是当前网络连接上最后一个 MQTT Control Packet，发完之后发送方就得关闭连接。


{{<mermaid>}}
sequenceDiagram
    participant C as Client
    participant B as Broker

    C->>B: DISCONNECT<br/>Reason Code: Normal disconnection
    Note over C: 不再发送任何 MQTT Control Packet
    C--xB: 关闭网络连接
    Note over B: 丢弃当前 Connection 的 Will，不发布
{{</mermaid>}}


正常 DISCONNECT 不只是"礼貌地说再见"：

- Broker 知道这不是异常失联；
- Broker 会删除当前连接关联的 Will，不发布它；
- Client 可以在 DISCONNECT 中调整后续的 Session Expiry Interval；
- Reason Code、Reason String 和 User Property 可以补充断开原因。

MQTT 5.0 还允许 Broker 用 DISCONNECT 说明关闭原因，比如协议错误、配额超限、服务端维护，或建议 Client 使用另一个服务端。

有一点要注意：Client 在 CONNECT 中若声明 Session Expiry 为 0，就不能在之后的 DISCONNECT 中把它改成非零值。会话是否应当可恢复，不能在最后一刻从"立即删除"改成"请保留"。

### 异常关闭走的是另一条路径

Broker 通常把这些情况当作网络失败：

- I/O 错误或网络故障；Keep Alive 超时；
- Client 直接关闭网络连接，没发正常 DISCONNECT；
- Broker 没收到 Client 正常 DISCONNECT 就关闭了连接。


{{<mermaid>}}
flowchart TD
    A["当前 MQTT 连接结束"] --> B{"Client 是否发送<br/>DISCONNECT Normal disconnection？"}

    B -->|是| C["删除 Will<br/>进入会话过期计时"]
    B -->|否| D["按网络失败处理"]

    D --> E{"注册了 Will？"}
    E -->|否| F["进入会话过期计时"]
    E -->|是| G["按 Will Delay / Session Expiry 判断"]
    G --> H["发布或取消 Will"]
    H --> F
{{</mermaid>}}

异常关闭不会自动删除会话。Session Expiry 大于零时，Broker 仍可能保留订阅和 QoS 未完成状态，等同一 ClientID 重连。Will 的发布规则跟前面讲过的 Will Delay 与 Session Expiry 关系一样。

### 重连是应用的事，恢复才是协议的事

MQTT 规范不要求 Client 自动重连，也没规定重试间隔得是 1 秒、指数退避还是带随机抖动。客户端库提供的 `automatic_reconnect`、最大重试次数和抖动策略，都是实现选择。协议规定的是重新建立网络连接并完成 CONNECT/CONNACK 之后，双方怎么解释旧会话。


{{<mermaid>}}
flowchart TD
    A["检测到连接失败"] --> B["应用或客户端库决定是否重连"]
    B --> C["建立新的网络连接"]
    C --> D["发送 CONNECT"]
    D --> E{"CONNACK 成功？"}

    E -->|否| F["根据 Reason Code 决定重试、告警或停止"]
    E -->|是| G{"Session Present = 1？"}

    G -->|是| H["恢复订阅与未完成 QoS 交付"]
    G -->|否| I["按应用策略重新订阅并初始化状态"]
{{</mermaid>}}

连接失败通常分两种情况：

- Broker 暂时不可用或网络不可达，应用可以退避后重试；
- 认证失败、协议版本不匹配或权限不足，盲目快速重试一般没用，得先处理配置或凭据问题。

MQTT 5.0 的 Reason Code 让 Client 能分清这两种情况，但具体怎么重试还是应用自己决定。


### Server Reference：Broker 建议迁移，Client 自己决定

Broker 可以在 CONNACK 或 DISCONNECT 中返回这些信息：
- `Use another server` 建议临时切换；
- `Server moved` 建议永久切换；
- `Server Reference` 提供候选服务端位置。


{{<mermaid>}}
sequenceDiagram
    participant C as Client
    participant A as 当前 Broker
    participant N as 新 Broker

    A-->>C: DISCONNECT<br/>Server moved + Server Reference
    C->>C: 校验并应用迁移策略
    C->>N: 建立新连接并发送 CONNECT
{{</mermaid>}}


Server Reference 是标准化的引导，不是强制重定向，Client 可以忽略它。生产系统还得验证新服务端地址是否符合自身安全策略，不能把任意下发的地址直接当可信目标。

### 连接管理的边界

到这里，有几个容易混淆的结论值得理清：

- Keep Alive 发现的是"Client 长时间没有发送 MQTT 控制报文"，不保证网络质量；
- PINGRESP 只证明当前连接当时还能交互，不保证下一秒不会断；
- DISCONNECT 能解释关闭原因，但无法保证对端一定收到；
- 自动重连不是 MQTT 协议承诺；
- Session 恢复取决于重连后的 CONNACK，不是"我已经重新连上 TCP"就行；
- Will 用于表达异常断线后的状态，不是严格实时的故障检测系统。

下一章从这些具体机制抽出来，集中整理 MQTT 5.0 的 Properties：为什么它们出现在 CONNECT、CONNACK、PUBLISH、SUBSCRIBE 和 DISCONNECT 的不同位置，以及它们怎么把协议扩展为可协商、可诊断、可控流的系统。


## MQTT 5.0 Properties 让协议变得可协商、可诊断、可扩展

MQTT 5.0 最明显的变化，是许多控制报文都可以携带 Properties。如果把它们看成一长串字段清单，很容易越读越散。换个角度理解，Properties 让 MQTT 在保留原有发布/订阅架构的基础上，多了几种新能力。


{{<mermaid>}}
flowchart TD
    P["MQTT 5.0 Properties"]

    P --> D["可诊断<br/>Reason Code / Reason String"]
    P --> R["可协商资源<br/>Receive Maximum / Packet Size"]
    P --> M["可表达消息语义<br/>Expiry / Content Type / Alias"]
    P --> X["可扩展应用模式<br/>Request-Response / User Property"]
    P --> C["可声明能力<br/>QoS、Retain、订阅功能是否可用"]
{{</mermaid>}}


Properties 不是任意位置都能塞的键值对。每个属性都规定了：可以出现在哪些 Control Packet 中；是 Client、Broker 还是双方都能发送；能否重复；该由谁解释它的含义。

前面内容已经在具体场景中介绍了 Session Expiry、Will Delay、Subscription Identifier、Reason Code 和 Server Reference。这一章补齐其余关键能力，并把它们放回统一地图。



### Reason Code 与 Reason String：把失败说清楚

MQTT 3.1.1 中，许多操作只有粗粒度的成功或失败。MQTT 5.0 让 CONNACK、各类 QoS 确认、SUBACK、UNSUBACK、DISCONNECT 和 AUTH 都能携带 Reason Code。

{{<mermaid>}}
sequenceDiagram
    participant C as Client
    participant B as Broker

    C->>B: PUBLISH QoS 1
    B-->>C: PUBACK<br/>Reason Code: Success

    C->>B: PUBLISH QoS 1
    B-->>C: PUBACK<br/>Reason Code: Quota exceeded
{{</mermaid>}}

Reason Code 适合程序逻辑判断，这次操作是成功、权限不足、报文过大、配额耗尽，还是某项能力不被支持。Reason String 是面向用户的补充诊断信息，适合日志、异常消息和排障界面，业务代码不该把它当稳定协议来解析。比如根据 `Quota exceeded` 做限流或告警是正确的做法，而判断 Reason String 是否包含 "quota" 就很脆弱。

`Request Problem Information` 让 Client 告诉 Broker 是否需要返回诊断信息。这对资源受限设备很有用：不需要额外文字或属性时，可以减少不必要的报文开销。


### Receive Maximum：限制可靠消息的在途数量

QoS 1 和 QoS 2 都需要等待确认，发送方可能同时持有很多"已发送、未完成"的消息。Receive Maximum 用来限制接收方愿意同时处理多少条这类消息。

{{<mermaid>}}
flowchart LR
    A["Sender 可发送 QoS 1/2 消息"] --> B{"未确认数量<br/>小于 Receive Maximum？"}

    B -->|是| C["发送下一条 PUBLISH"]
    C --> D["等待 PUBACK / PUBREC"]
    D --> E["确认到达，释放一个名额"]
    E --> B

    B -->|否| F["暂停发送新的 QoS 1/2 PUBLISH<br/>继续处理其他控制报文"]
{{</mermaid>}}

这不是通用的消息反压机制：

- 它只约束 QoS 大于 0 的未完成 PUBLISH；
- 不直接限制 QoS 0；
- 不限制订阅、心跳、DISCONNECT 等其他控制报文；
- 两个方向分别协商：Client 可以限制 Broker 向自己发送的在途消息，Broker 也可以限制 Client 向自己发送的在途消息。

它解决的是"可靠消息积压会占用多少内存与状态"，不是"每秒最多发多少字节"。真正的吞吐控制还得结合应用限流、Broker 配额和网络条件。


### Maximum Packet Size：先声明自己接不下多大的报文

**Maximum Packet Size** 解决的是另一类资源问题：**单个 Control Packet 最大能有多大**。

{{<mermaid>}}
sequenceDiagram
    participant C as Client
    participant B as Broker

    C->>B: CONNECT<br/>Maximum Packet Size = 64 KB
    B-->>C: CONNACK

    B->>B: 准备向 Client 转发更大的 PUBLISH
    B->>B: 超过 Client 声明的上限
    Note over B: 不能直接发送超限报文
{{</mermaid>}}

它与 Receive Maximum 的区别是：

| 属性 | 限制什么 | 典型风险 |
| --- | --- | --- |
| Receive Maximum | 同时有多少条 QoS 1/2 消息未完成 | 在途状态过多 |
| Maximum Packet Size | 单个 MQTT Control Packet 有多大 | 内存分配过大、嵌入式设备无法解析 |

Client 和 Broker 都可以声明自身限制。一个部署了大内存 Broker 的系统，仍可能服务于只能处理几十 KB 报文的设备；这时"Broker 能接收大 Payload"不代表它能原样转发给所有 Client。

### Topic Alias：用连接内编号缩短重复 Topic

高频消息反复携带很长的 Topic Name，协议开销会很明显。MQTT 5.0 的 Topic Alias 允许发送方在当前连接、当前发送方向内，用一个非零整数替代重复 Topic。

{{<mermaid>}}
sequenceDiagram
    participant C as Client
    participant B as Broker

    C->>B: PUBLISH<br/>Topic: factory/line/7/device/42/telemetry<br/>Topic Alias: 1
    Note over C,B: 在这条 Client → Broker 连接上建立 1 对应的 Topic

    C->>B: PUBLISH<br/>Topic Alias: 1<br/>省略完整 Topic Name
    Note over B: 根据当前连接的映射还原 Topic
{{</mermaid>}}

Topic Alias 有四个边界：

- 映射只在当前网络连接有效，重连后必须重新建立；
- Client → Broker 与 Broker → Client 的 Alias 空间相互独立；
- 发送方只能使用接收方声明愿意接受的 Alias 范围；
- Alias 不是 Topic 的永久 ID，不用于 SUBSCRIBE，也不能在未建立映射时直接引用。

它适合长 Topic、高频小 Payload 的设备；对低频消息或短 Topic，节省的字节通常不值得增加状态管理复杂度。

### Payload Format 与 Content Type：说明消息格式，但不替应用解析

PUBLISH 和 Will Properties 中可以携带：

- `Payload Format Indicator`：Payload 是未指定字节，还是 UTF-8 文本；
- `Content Type`：例如 `application/json`、`application/protobuf` 或应用自定义类型。

{{<mermaid>}}
flowchart LR
    A["PUBLISH Payload"] --> B["Payload Format Indicator<br/>文本 / 未指定字节"]
    A --> C["Content Type<br/>application/json"]
    B --> D["帮助接收方选择解析路径"]
    C --> D
{{</mermaid>}}

这些属性是元数据，不是 Schema Registry：

- MQTT 不会检查 JSON 是否符合业务字段定义；
- Broker 通常不理解你的 Protobuf 版本；
- `Content Type` 也不会自动完成序列化、反序列化或兼容性迁移。

适合让多语言、多消费者系统明确消息的大致格式，但业务契约仍应由应用维护。

### Request / Response：把常见模式标准化

发布/订阅并不排斥请求—响应。MQTT 5.0 允许请求方在 PUBLISH 中携带：

- `Response Topic`：希望响应者将结果发布到哪里；
- `Correlation Data`：供响应者原样带回、关联本次请求的二进制数据。

{{<mermaid>}}
sequenceDiagram
    participant Q as 请求 Client
    participant B as Broker
    participant R as 响应 Client

    Q->>B: PUBLISH devices/42/commands<br/>Response Topic: replies/q1<br/>Correlation Data: 8f3a
    B->>R: 转发命令请求

    R->>B: PUBLISH replies/q1<br/>Correlation Data: 8f3a
    B->>Q: 转发响应
{{</mermaid>}}

MQTT 只定义如何携带响应地址与关联数据，不定义：

- 响应是否一定到达；
- 一次请求有几个响应；
- 超时多久；
- 是否允许重试；
- 响应者如何选择。

`Response Information` 允许 Broker 在连接阶段提供与响应 Topic 构造有关的配置提示。它适合减少 Client 的预配置，但不是远程调用框架。

### User Property：可转发的元数据，不是隐形协议层

User Property 是允许重复的 UTF-8 键值对，出现在多数 MQTT 5.0 控制报文中。PUBLISH 与 Will 上的 User Property 会随消息转发。

```
trace-id = 2f9c...
schema-version = 3
origin = edge-gateway-7
```

它适合传递追踪标识、Schema 版本、来源标记等辅助信息。但 MQTT 不定义这些键的语义，也不会替你验证一致性。

使用时应避免两个极端：

- 不要把 User Property 当作秘密传输通道，它与 Payload 一样需要安全策略保护。
- 不要把关键业务字段只放在 User Property 中，导致旧客户端或跨协议桥接场景丢失必要语义。

### 服务端能力声明让 Client 少靠"试错"

Broker 可以在 CONNACK 中声明部分可选功能是否支持，例如：

- `Maximum QoS`；
- `Retain Available`；
- `Wildcard Subscription Available`；
- `Subscription Identifier Available`；
- `Shared Subscription Available`。

这使 Client 能在发送不支持的操作前调整行为，而不是等到 SUBACK 或 DISCONNECT 才发现问题。

增强认证、`Assigned Client Identifier`、`Server Keep Alive` 与 `Server Reference` 也属于同一设计思路：Broker 在标准协议中表达自己的能力、限制或建议，Client 再结合自身策略决定如何响应。

MQTT 5.0 Properties 的价值，不是让一条 PUBLISH 变得更复杂，而是让轻量协议也能表达现实系统里的资源边界、诊断信息、消息寿命和协作模式。

下一章把前面分散介绍的机制放进一个完整场景：设备上线、状态保留、遥测分发、共享消费、远程命令、异常掉线和会话恢复如何在同一套 Topic 设计中协作。


## 一个完整的设备场景

前面分别讲了会话、订阅、QoS、Retain、Will 和 Properties。现在把它们放进同一个系统，才能看到这些功能并不是孤立选项。

下面的 Topic 仅用于说明，不是通用命名规范。

{{<mermaid>}}
flowchart LR
    D["设备 42<br/>ClientID: device-42"] -->|"telemetry / status / replies"| B["MQTT Broker"]

    B --> UI["仪表盘"]
    B --> W["$share/analytics/<br/>遥测 Worker 组"]
    C["控制台"] -->|"commands"| B
    B --> C
{{</mermaid>}}

这个系统需要处理四类消息：

| 目的 | Topic 示例 | 建议机制 | 原因 |
| --- | --- | --- | --- |
| 实时遥测 | `devices/42/telemetry` | QoS 0、非 retained | 新读数通常会覆盖旧读数 |
| 在线状态 | `devices/42/status` | retained、Will、可选 Will Delay | 后来者需要立即知道最后状态 |
| 远程命令 | `devices/42/commands` | QoS 1、Message Expiry | 命令不应轻易丢失，也不应无限期执行 |
| 命令响应 | `clients/console-1/replies` | Response Topic、Correlation Data | 多个并发命令需要正确关联结果 |

### 设备上线：连接、会话与在线状态

设备使用稳定的 ClientID `device-42` 连接，并尝试恢复此前会话。

{{<mermaid>}}
sequenceDiagram
    participant D as 设备 42
    participant B as Broker
    participant U as 仪表盘

    D->>B: CONNECT<br/>ClientID: device-42<br/>Clean Start: 0<br/>Session Expiry: 10 分钟<br/>Will: offline, retained
    B-->>D: CONNACK<br/>Session Present: 0

    D->>B: SUBSCRIBE devices/42/commands
    B-->>D: SUBACK

    D->>B: PUBLISH devices/42/status<br/>Payload: online, RETAIN = 1
    B-->>U: PUBLISH devices/42/status<br/>Payload: online, RETAIN = 1
{{</mermaid>}}

这里的关键不是"设备连上后发一条 online"，而是三层状态各自承担不同职责：

- ClientID 把本次连接与设备会话关联；
- Session Expiry = 10 分钟表示设备短暂掉线时，Broker 可以保留订阅与未完成 QoS 交付；
- CONNECT 中登记的 Will 是设备无法自己发 offline 时的后备方案；
- retained 的 online 是供以后新订阅者读取的状态快照。

Session Present = 0 表示这次没有恢复旧会话，因此设备需要重新订阅命令 Topic。若返回 1，此前保留的订阅仍然有效，设备不应重复假设它们已经丢失。

10 分钟只是示例。设置多长取决于设备常见离线时间、Broker 资源预算与业务可接受的恢复窗口。

### 遥测：广播给仪表盘，竞争消费给 Worker

设备每秒发布一次遥测数据：

```
Topic: devices/42/telemetry
QoS: 0
Payload: {"temperature": 25.6, "seq": 8142}
```

仪表盘订阅 `devices/+/telemetry`。分析 Worker 组订阅 `$share/analytics/devices/+/telemetry`。

{{<mermaid>}}
sequenceDiagram
    participant D as 设备 42
    participant B as Broker
    participant U as 仪表盘
    participant W1 as Worker A
    participant W2 as Worker B

    D->>B: PUBLISH devices/42/telemetry<br/>QoS 0, seq = 8142
    B->>U: PUBLISH devices/42/telemetry
    B->>W1: PUBLISH devices/42/telemetry
    Note over B,W2: 下一条遥测可改投给 Worker B
{{</mermaid>}}

仪表盘的普通订阅是广播语义：每个匹配 Client 都得到副本。Worker 使用共享订阅：每条匹配消息只投递给 analytics 组中的一个会话。

选择 QoS 0 的前提是单个采样丢失可以接受，下一条采样很快会到达。如果分析 Worker 处理的不是实时指标，而是必须完整入库的计量数据，就得重新评估 QoS、会话持久化、消息过期和应用层去重，而不是机械地把 QoS 提升到 2。

Payload 中加入 `seq` 是业务层选择。它帮助仪表盘或数据平台发现缺号、重复或乱序；MQTT 的 QoS 不能替它构造业务序列语义。

### 远程命令：用 QoS 1 搭配请求/响应

控制台要让设备执行一次校准，并得到结果。

{{<mermaid>}}
sequenceDiagram
    participant C as 控制台
    participant B as Broker
    participant D as 设备 42

    C->>B: PUBLISH devices/42/commands<br/>QoS 1<br/>Response Topic: clients/console-1/replies<br/>Correlation Data: cmd-847
    B->>D: PUBLISH devices/42/commands<br/>QoS 1

    D->>D: 执行或拒绝命令
    D->>B: PUBLISH clients/console-1/replies<br/>Correlation Data: cmd-847<br/>Payload: success / failure
    B->>C: PUBLISH clients/console-1/replies
{{</mermaid>}}

这里有两条不同的"成功"：

1. QoS 1 的 PUBACK：Broker 或设备已经接受这条 MQTT 消息；
2. `clients/console-1/replies` 上的业务响应：设备实际执行命令后的结果。

前者不等于后者。设备可能接受了消息，却因设备状态、参数错误或本地资源不足而无法完成校准。

对于"只在短时间内有效"的命令，可以设置 `Message Expiry Interval`。例如，若 30 秒后再执行"打开阀门"已经没有意义，过期时间能让 Broker 不再继续为离线设备保留这条命令。

仍然需要业务幂等。控制台可以将 `cmd-847` 同时放入 Payload 作为命令 ID；设备应记录已执行的命令，而不是只依赖 MQTT 的 Packet Identifier 或 QoS 1。

### 异常掉线：Will、会话和重连各管一段

现在假设设备 Wi‑Fi 突然中断。

{{<mermaid>}}
sequenceDiagram
    participant D as 设备 42
    participant B as Broker
    participant U as 仪表盘

    D--xB: 网络中断
    Note over B: Keep Alive 超时或检测到 I/O 错误
    Note over B: 开始 Will Delay；保留会话状态

    alt 设备在 Will Delay 内恢复同一会话
        D->>B: CONNECT, Clean Start = 0
        B-->>D: CONNACK, Session Present = 1
        Note over B,U: 不发布 offline Will
    else Will Delay 到期或 Session 先结束
        B->>U: PUBLISH devices/42/status<br/>Payload: offline, RETAIN = 1
    end
{{</mermaid>}}

这条链路里：

- Keep Alive 或 I/O 错误负责发现当前连接已经失效；
- Will Delay 防止短暂网络抖动立刻被展示成"设备离线"；
- retained Will 将最后状态更新为 offline；
- Session Expiry 决定命令订阅和未完成 QoS 交付还能保留多久；
- Session Present 决定重连后能否继续旧会话。

如果设备恢复得足够快，Broker 不发布 offline；如果设备长时间离线，仪表盘和后来连接的 Client 都会读取到 retained 的 offline 状态。

### 这套设计依赖哪些协议外条件

这个例子展示的是 MQTT 能表达的协作关系，不是完整生产方案。至少还需要补齐：

- TLS、设备身份认证与按 Topic 的授权规则；
- ClientID 冲突时的接管策略；
- Client 与 Broker 的会话持久化能力；
- 命令 ID、设备侧幂等记录与审计；
- 共享 Worker 的失败重试、死信和业务补偿；
- Topic 命名、Payload Schema 和版本演进；
- 监控连接数、会话数量、在途消息、丢弃与授权失败。

一个好的 MQTT 设计，不是把所有可选能力都打开，而是让每种状态都有明确归属：

| 需求 | 归属 |
| --- | --- |
| 最新状态 | Retain |
| 异常离线 | Will |
| 短暂断线后的协议恢复 | Session |
| 逐跳可靠交付 | QoS |
| 命令结果关联 | Response Topic + Correlation Data |
| 业务去重与事务 | 应用系统 |

下一章以这些边界收束全文：MQTT 到底保证什么、不保证什么，以及设计和排障时最常见的十个误解。

## MQTT 能保证什么，不能保证什么

读完协议细节后，最容易出现另一个问题：把某一项能力的保证范围扩大成整个系统的保证。

MQTT 很擅长处理连接不稳定、发布者与订阅者解耦、逐跳消息交付和会话恢复；但它不会自动替应用完成事务、存储、安全治理和业务去重。

判断一个需求是否属于 MQTT，最简单的方法是先看责任落在哪一层。

{{<mermaid>}}
flowchart TD
    R["系统中的可靠性需求"]

    R --> M["MQTT 协议<br/>QoS、Session、Retain、Will"]
    R --> B["Broker 与部署<br/>持久化、ACL、配额、集群"]
    R --> C["客户端实现<br/>重连、落盘、超时、回调"]
    R --> A["业务应用<br/>幂等、事务、Schema、审计"]
{{</mermaid>}}

下面这些边界，几乎覆盖了 MQTT 设计和排障中的大多数误解。

### QoS 1 不等于"业务只会执行一次"

QoS 1 保证的是相邻 MQTT 端点之间至少一次交付。PUBACK 丢失、连接中断和会话恢复，都可能让接收方再次看到同一条消息。

- MQTT 层：至少一次接收
- 业务层：仍需决定如何避免重复扣费、重复写库或重复发通知

若一条消息会触发不可逆操作，应在 Payload 中携带业务唯一 ID，并让消费者实现幂等。

### QoS 2 不等于"端到端事务"

QoS 2 避免同一 Application Message 在一段 QoS 2 MQTT 交付中被重复接管。它不覆盖：

- 发布 Client 到 Broker 与 Broker 到订阅 Client 的两段独立交付；
- 数据库提交与 MQTT 确认之间的崩溃窗口；
- 消息触发多个下游服务；
- 业务请求来自不同 Client、不同 Topic 或不同时间的重复发送。

需要跨数据库、消息和外部调用实现一致性时，仍需事务外盒、幂等消费者、补偿机制或业务状态机。

### Retained Message 不等于历史消息队列

Broker 为每个 Topic 保存的是最后一条 retained 状态，不是一串历史记录。

- Retain 适合：设备当前状态、当前配置、最新版本号
- Retain 不适合：审计日志、完整遥测历史、待处理任务列表

发送零字节 retained PUBLISH 会清除该 Topic 的保留状态；Session 结束也不会自动清除 Retained Message。

### Session 不等于永久可靠存储

Session 可以保留订阅、QoS 未完成状态和待投递消息，但仍受以下条件约束：

- Session Expiry；
- Broker 的磁盘、内存与管理配额；
- Broker 重启、故障恢复与集群策略；
- Client 本地是否保留了可续接的 QoS 状态；
- Message Expiry 是否已经到期。

"设置了 Clean Start = 0"不是可靠性方案的终点，它只是请求 Broker 尝试恢复会话，最终仍要看 CONNACK 的 Session Present。

### Keep Alive 不等于自动重连

Keep Alive 负责发现 Client 长时间没有发送 MQTT Control Packet；它不定义：

- 是否重连；
- 重连等待多久；
- 是否指数退避；
- 如何避免大量设备同时重连；
- 凭据失效时是否停止重试；
- 重连成功后如何恢复业务状态。

这些属于 Client 库和应用策略。协议只定义重新 CONNECT 后，如何根据 CONNACK 与 Session Present 续接或重建会话。

### ClientID 不等于安全身份

ClientID 是协议会话的标识符，不是认证凭据。

- ClientID 回答：这是哪个会话？
- 认证回答：它是否真的是这个 Client？
- 授权回答：它能操作哪些 Topic？

生产系统通常需要 TLS、设备证书或令牌、Broker ACL，以及对 ClientID 冲突和会话接管的明确处理策略。

### 用户名密码不等于安全通信

MQTT 可以携带 `User Name` 和 `Password`，也支持增强认证，但协议不自动提供传输保密性。

敏感数据、凭据和可被伪造的控制命令，应结合 TLS、证书校验和最小权限授权设计。认证成功也不代表有权订阅所有 Topic；授权仍是 Broker 或外部身份系统的责任。

### Topic 不等于队列，Shared Subscription 也不等于任务系统

普通订阅是广播语义：每个匹配订阅会得到自己的副本。Shared Subscription 让一条匹配消息只投递给组内一个 Session，但 MQTT 不承诺：

- Worker 选择一定轮询或公平；
- 失败任务自动转移给另一个 Worker；
- 处理顺序全局一致；
- Worker 业务失败后有死信队列；
- 多次投递不会触发重复业务执行。

Shared Subscription 是竞争消费的协议模式，不是完整的任务调度与补偿系统。

### Payload 有 Content Type，不等于有业务契约

MQTT 5.0 的 `Payload Format Indicator` 和 `Content Type` 可以告诉接收方"这像是 UTF-8 文本"或"这可能是 JSON"，但不会替应用：

- 校验字段；
- 演进 Schema；
- 处理缺失字段；
- 校验签名；
- 管理版本兼容。

对于多个团队或多种语言的消费者，Payload Schema、版本字段和兼容策略应作为独立接口契约维护。

### MQTT 5.0 可协商，不等于所有 Broker 都开放所有能力

Broker 可以声明不支持 Retain、共享订阅、通配符订阅或 `Subscription Identifier`，也可以限制最大 QoS、报文大小和在途可靠消息数量。

Client 应在 CONNACK、SUBACK、各类确认和 DISCONNECT 中处理 Reason Code，而不是假设"支持 MQTT 5.0"就代表所有可选功能都可用。

### 用一张表完成设计检查

| 你真正需要的结果 | MQTT 可提供的能力 | 仍需补齐的部分 |
| --- | --- | --- |
| 设备状态可被后来者立即读取 | Retain | 状态 Topic 设计、过期或清除策略 |
| 异常断线通知 | Will、Will Delay | 离线判定阈值、监控告警 |
| 短暂断线后继续交付 | Session、QoS 1/2 | Client 本地持久化、Broker 资源规划 |
| 避免重复业务执行 | QoS 1/2 可降低协议层问题 | 幂等键、去重与事务设计 |
| 多 Worker 分摊处理 | Shared Subscription | 失败重试、死信与业务补偿 |
| 远程命令获得响应 | Response Topic、Correlation Data | 超时、命令 ID、权限与审计 |
| 安全连接与 Topic 隔离 | 认证、TLS、授权能力 | 凭据生命周期、ACL、密钥管理 |

MQTT 的核心价值，不是替系统消灭所有分布式问题，而是把它们拆成明确可配置的协议问题：

- 连接是否仍在？
- 会话是否还在？
- 谁应接收消息？
- 这一跳要多可靠？
- 这条消息多久后失效？
- 异常断线时谁来发布最后状态？

当这些问题分别由 Keep Alive、Session、Subscription、QoS、Expiry 和 Will 回答时，MQTT 就不再是一组零散 API，而是一套可推演的状态协议。

## 附录 A：MQTT 5.0 控制报文速查表

MQTT 5.0 的 Control Packet Type 使用固定头高 4 位编码：0 保留且禁止使用，1～15 对应下表中的 15 种报文。

| 类型值 | 报文 | 方向 | Packet Identifier | 主要作用 | 典型后续报文 |
| --- | --- | --- | --- | --- | --- |
| 1 | CONNECT | Client → Server | 否 | 建立 MQTT 连接，提交 ClientID、会话意图、认证、Will 与能力限制 | CONNACK，或 AUTH |
| 2 | CONNACK | Server → Client | 否 | 返回连接结果、Session Present、服务端能力与限制 | 正常业务报文，或连接关闭 |
| 3 | PUBLISH | 双向 | QoS 1/2 时需要 | 传输 Application Message | QoS 0：无；QoS 1：PUBACK；QoS 2：PUBREC |
| 4 | PUBACK | 双向 | 是 | 确认 QoS 1 PUBLISH | 无 |
| 5 | PUBREC | 双向 | 是 | QoS 2 的第一步确认 | PUBREL |
| 6 | PUBREL | 双向 | 是 | 请求完成 QoS 2 交付 | PUBCOMP |
| 7 | PUBCOMP | 双向 | 是 | QoS 2 交付完成 | 无 |
| 8 | SUBSCRIBE | Client → Server | 是 | 创建或更新一个或多个订阅 | SUBACK |
| 9 | SUBACK | Server → Client | 是 | 返回每个 Topic Filter 的授权 QoS 或失败原因 | 无 |
| 10 | UNSUBSCRIBE | Client → Server | 是 | 删除一个或多个订阅 | UNSUBACK |
| 11 | UNSUBACK | Server → Client | 是 | 返回每个退订请求的结果 | 无 |
| 12 | PINGREQ | Client → Server | 否 | 在连接空闲时检查 Broker 是否仍可响应 | PINGRESP |
| 13 | PINGRESP | Server → Client | 否 | 回应 PINGREQ | 无 |
| 14 | DISCONNECT | 双向 | 否 | 表示连接将关闭，并说明原因或附带属性 | 关闭网络连接 |
| 15 | AUTH | 双向 | 否 | MQTT 5.0 增强认证或重新认证 | AUTH 或 CONNACK |

### 固定头 Flags 速记

固定头的低 4 位不是所有报文都可自由使用：

| 报文 | Flags |
| --- | --- |
| PUBLISH | DUP + QoS + RETAIN，随消息语义变化 |
| PUBREL、SUBSCRIBE、UNSUBSCRIBE | 固定为 0010 |
| 其余控制报文 | 固定为 0000 |

接收到不符合规定的 Flags，在 MQTT 5.0 中属于 Malformed Packet。

### Packet Identifier 与 ClientID 的区别

| 字段 | 作用范围 | 用途 |
| --- | --- | --- |
| ClientID | 跨连接、跨会话 | 标识协议会话 |
| Packet Identifier | 一次未完成的协议交换 | 关联 PUBLISH 确认链、订阅和退订请求 |
| Correlation Data | 应用请求—响应 | 关联业务层请求与响应 |
| 业务消息 ID | 应用自行定义 | 实现幂等、审计和去重 |

Packet Identifier 不是全局唯一 ID。QoS 确认链完成、订阅结果返回或退订完成后，对应数值可以被重新使用。

### 如何快速读抓包

{{<mermaid>}}
flowchart LR
    A["看到 PUBLISH"] --> B{"QoS 值？"}
    B -->|0| C["不期待 MQTT 确认"]
    B -->|1| D["寻找同 Packet Identifier 的 PUBACK"]
    B -->|2| E["寻找 PUBREC → PUBREL → PUBCOMP"]

    F["看到 SUBSCRIBE"] --> G["寻找同 Packet Identifier 的 SUBACK"]
    H["看到 PINGREQ"] --> I["寻找 PINGRESP"]
    J["看到 DISCONNECT"] --> K["读取 Reason Code，再检查连接关闭"]
{{</mermaid>}}

CONNACK、SUBACK、PUBACK/PUBREC 与 DISCONNECT 中的 Reason Code，通常比单看报文名称更能解释"为什么连接、订阅或发布没有按预期继续"。

## 附录 B：MQTT 5.0 Properties 速查表

Properties 由"属性标识符 + 属性值"组成。大多数 MQTT 5.0 Control Packet 都有 Properties 区域；PINGREQ 与 PINGRESP 没有。Will Properties 位于 CONNECT 的 Payload 中。

除特别标注外，每个属性在同一个允许的位置最多出现一次。把不允许的属性放进某种报文，或使用错误的数据类型，属于 Malformed Packet。

### 消息与 Will Properties

| ID | 属性 | 类型 | 允许位置 | 缺省或限制 | 用途 |
| --- | --- | --- | --- | --- | --- |
| 0x01 | Payload Format Indicator | Byte | PUBLISH、Will | 缺省为未指定字节 | 声明 Payload 是未指定字节还是 UTF-8 文本 |
| 0x02 | Message Expiry Interval | Four Byte Integer | PUBLISH、Will | 缺省为不过期 | 指定 Application Message 的剩余有效期 |
| 0x03 | Content Type | UTF-8 String | PUBLISH、Will | 缺省无 | 描述内容类型，如 application/json |
| 0x08 | Response Topic | UTF-8 String | PUBLISH、Will | 缺省无 | 为请求消息指定响应发布目标 |
| 0x09 | Correlation Data | Binary Data | PUBLISH、Will | 缺省无 | 由响应者带回，用于关联请求与响应 |
| 0x0B | Subscription Identifier | Variable Byte Integer | SUBSCRIBE、PUBLISH | 值不得为 0 | 标识是哪项订阅导致了消息投递；PUBLISH 可携带多个 |

### 连接、会话与认证

| ID | 属性 | 类型 | 允许位置 | 缺省或限制 | 用途 |
| --- | --- | --- | --- | --- | --- |
| 0x11 | Session Expiry Interval | Four Byte Integer | CONNECT、CONNACK、DISCONNECT | CONNECT 未设置时为 0 | 指定网络连接结束后会话保留多久 |
| 0x12 | Assigned Client Identifier | UTF-8 String | CONNACK | 仅 Broker 发送 | 服务端为零长度 ClientID 分配实际 ClientID |
| 0x13 | Server Keep Alive | Two Byte Integer | CONNACK | 缺省时使用 Client 发送的 Keep Alive | 覆盖 Client 提议的 Keep Alive |
| 0x15 | Authentication Method | UTF-8 String | CONNECT、CONNACK、AUTH | 缺省为不使用增强认证 | 指定增强认证机制 |
| 0x16 | Authentication Data | Binary Data | CONNECT、CONNACK、AUTH | 缺省无 | 承载认证机制定义的数据 |
| 0x18 | Will Delay Interval | Four Byte Integer | Will | 缺省为 0 | 异常断线后，延迟发布 Will |
| 0x1C | Server Reference | UTF-8 String | CONNACK、DISCONNECT | 缺省无 | 建议 Client 使用另一个 Broker |

Session Expiry Interval 可以由 Client 在 DISCONNECT 中调整；Broker 不能通过 DISCONNECT 发送该属性。

### 诊断与应用扩展

| ID | 属性 | 类型 | 允许位置 | 缺省或限制 | 用途 |
| --- | --- | --- | --- | --- | --- |
| 0x17 | Request Problem Information | Byte | CONNECT | 缺省为 1 | Client 是否希望接收部分诊断信息 |
| 0x19 | Request Response Information | Byte | CONNECT | 缺省为 0 | Client 是否请求 Broker 返回 Response Information |
| 0x1A | Response Information | UTF-8 String | CONNACK | 缺省无 | Broker 提供的请求—响应构造提示 |
| 0x1F | Reason String | UTF-8 String | CONNACK、各类 ACK、SUBACK、UNSUBACK、DISCONNECT、AUTH | 缺省无 | 面向人类的诊断文字，不应被程序逻辑解析 |
| 0x26 | User Property | UTF-8 String Pair | 除 Ping 外的大多数 Properties 区域与 Will | 可重复 | 应用或实现自定义的键值元数据 |

User Property 可以重复出现，同一个 key 也可以出现多次。其语义由发送方和接收方约定，MQTT 不赋予它统一业务含义。

### 资源限制、能力协商与 Topic Alias

| ID | 属性 | 类型 | 允许位置 | 缺省或限制 | 用途 |
| --- | --- | --- | --- | --- | --- |
| 0x21 | Receive Maximum | Two Byte Integer | CONNECT、CONNACK | 缺省为 65535；不得为 0 | 限制可同时接收的未完成 QoS 1/2 PUBLISH 数量 |
| 0x22 | Topic Alias Maximum | Two Byte Integer | CONNECT、CONNACK | 缺省为 0 | 声明愿意接受的最大 Topic Alias |
| 0x23 | Topic Alias | Two Byte Integer | PUBLISH | 值不得为 0 | 在当前连接、当前方向内用数字简称 Topic Name |
| 0x24 | Maximum QoS | Byte | CONNACK | 缺省为 QoS 2 | Broker 支持的最高发布 QoS |
| 0x25 | Retain Available | Byte | CONNACK | 缺省为 1 | Broker 是否接受 retained PUBLISH |
| 0x27 | Maximum Packet Size | Four Byte Integer | CONNECT、CONNACK | 缺省为协议最大报文大小 | 声明可接受的单个 Control Packet 上限 |
| 0x28 | Wildcard Subscription Available | Byte | CONNACK | 缺省为 1 | Broker 是否支持 +、# Filter |
| 0x29 | Subscription Identifier Available | Byte | CONNACK | 缺省为 1 | Broker 是否支持 Subscription Identifier |
| 0x2A | Shared Subscription Available | Byte | CONNACK | 缺省为 1 | Broker 是否支持 $share/... |

### 使用时的四条检查规则

{{<mermaid>}}
flowchart TD
    A["准备发送一个 Property"] --> B{"该报文允许此属性？"}
    B -->|否| X["不要发送：属于协议错误"]
    B -->|是| C{"类型和值是否合法？"}
    C -->|否| X
    C -->|是| D{"是否允许重复？"}
    D -->|否，且已存在| X
    D -->|是| E["发送，并按接收方声明的限制控制大小"]
{{</mermaid>}}

1. 先看"允许位置"，不要因为某属性有用就放进任意报文。
2. 再看属性是连接双向协商、Broker 单向声明，还是随消息转发。
3. 将 Receive Maximum、Maximum Packet Size 与 Topic Alias Maximum 视为接收方边界，而不是发送方偏好。
4. 将 Reason Code 用于程序判断，将 Reason String 与 User Property 视为需要双方约定的附加信息。

## 附录 C：MQTT 3.1.1 与 MQTT 5.0 对照表

MQTT 5.0 没有推翻 MQTT 3.1.1 的发布/订阅核心：Topic、QoS 0/1/2、Retained Message、Will、Keep Alive 和 Session Present 都仍然存在。

它主要补齐了五类能力：有限时长会话、消息寿命、更细的失败信息、资源与能力协商，以及可扩展的应用模式。

### 连接与会话

| 主题 | MQTT 3.1.1 | MQTT 5.0 | 升级影响 |
| --- | --- | --- | --- |
| Protocol Level | 4 | 5 | Client 必须在 CONNECT 中明确选择版本 |
| 会话开始 | Clean Session | Clean Start | 都控制是否丢弃已有会话 |
| 会话结束后的保留 | Clean Session = 0 时保留，无标准化有限时长 | Session Expiry Interval 可设为 0、有限秒数或永不过期 | 可准确表达短暂离线恢复窗口 |
| 会话恢复结果 | CONNACK Session Present | 同样使用 Session Present | 两个版本都不能只看 Client 请求，必须看 CONNACK |
| 断开时调整会话 | 无 | Client 可在 DISCONNECT 中调整 Session Expiry | 适合显式缩短或维持后续会话 |
| 服务端分配 ClientID | 支持有限场景 | Assigned Client Identifier 可回传实际分配结果 | Client 可稳定获得 Broker 分配的 ID |

Clean Start = 1 且 Session Expiry Interval = 0，在会话清理语义上对应 MQTT 3.1.1 的 Clean Session = 1。

### 报文与错误反馈

| 主题 | MQTT 3.1.1 | MQTT 5.0 | 升级影响 |
| --- | --- | --- | --- |
| 控制报文数量 | 14 种 | 15 种，新增 AUTH | 增强认证增加独立报文 |
| CONNACK 结果 | 少量连接返回码 | 更细粒度 Reason Code | 可区分认证、配额、版本、限流等失败 |
| QoS 确认 | PUBACK/PUBREC 等不携带通用失败原因 | 各类确认可携带 Reason Code | 发布失败可被协议层解释 |
| SUBACK/UNSUBACK | 基本的 QoS 或退订确认 | 每个 Topic Filter 有更丰富 Reason Code | 能区分权限、共享订阅、通配符等失败 |
| DISCONNECT | 仅 Client → Server；无可选字段 | Client 与 Server 双向；可携带原因、诊断与 Server Reference | 更容易定位断开与实现迁移 |
| Reason String | 无 | 可选的人类可读诊断信息 | 只用于日志，不应作为业务解析协议 |

### 消息、订阅与交付

| 主题 | MQTT 3.1.1 | MQTT 5.0 | 升级影响 |
| --- | --- | --- | --- |
| QoS 0/1/2 | 支持 | 保持相同核心交付模型 | QoS 语义没有被替换 |
| Retained Message | 支持 | 保持支持，并增加相关能力声明 | 仍然是一条最新状态，不是历史队列 |
| Will | 支持，异常断线后立即发布 | 增加 Will Delay、Will Properties、Will Message Expiry | 可屏蔽短暂网络抖动 |
| Message Expiry | 无 | Message Expiry Interval | 可避免过期命令或旧消息继续投递 |
| Payload 元数据 | 无协议字段 | Payload Format Indicator、Content Type | 便于消费者选择解析路径 |
| Topic Alias | 无 | 连接内 Topic 简称 | 高频、长 Topic 场景可减少开销 |
| 订阅选项 | 仅请求 QoS | 增加 No Local、Retain As Published、Retain Handling | 可精细控制回环和保留消息投递 |
| Subscription Identifier | 无 | 可标记消息由哪项订阅匹配而来 | 方便一个 Client 管理多条业务订阅 |
| Shared Subscription | 规范未定义；部分 Broker 有扩展 | 标准化 `$share/{group}/{filter}` | 多消费者竞争消费可跨 Broker 互操作 |
| Request / Response | 应用自行约定 Topic | Response Topic、Correlation Data、Response Information | 请求—响应关系有标准字段承载 |

### 能力、资源与安全

| 主题 | MQTT 3.1.1 | MQTT 5.0 | 升级影响 |
| --- | --- | --- | --- |
| 在途 QoS 限制 | 无标准化协商 | Receive Maximum | 可限制可靠消息占用的状态 |
| 单包大小限制 | 无双向协商字段 | Maximum Packet Size | 低资源 Client 可明确拒绝大报文 |
| Broker 功能声明 | 主要依赖产品文档或错误结果 | Maximum QoS、Retain/Wildcard/Shared Subscription Available 等 | Client 可在操作前调整行为 |
| 认证 | User Name / Password 字段 | 保留基础认证，新增 AUTH 增强认证 | 可支持挑战—响应与重新认证 |
| 自定义元数据 | 需要放进 Payload | User Property | 可携带键值元数据，但语义仍由应用定义 |
| 服务端迁移 | 非标准化 | Server Reference、Use another server、Server moved | Broker 可建议 Client 临时或永久迁移 |

### 升级并不是"连接后自动兼容"

MQTT 3.1.1 与 MQTT 5.0 不是在同一条连接上自动混用的 wire format。Client 在 CONNECT 中指定 Protocol Level；Broker 若同时支持两种版本，会据此采用对应的报文格式和语义。

{{<mermaid>}}
flowchart TD
    C["Client 发起 CONNECT"] --> V{"Protocol Level"}

    V -->|4| M31["按 MQTT 3.1.1 语义通信<br/>无 Properties、无 AUTH"]
    V -->|5| M50["按 MQTT 5.0 语义通信<br/>Properties、Reason Code、能力协商"]
    V -->|不支持| X["CONNACK 拒绝并关闭连接"]
{{</mermaid>}}

升级时至少要验证：

1. Broker、Client SDK 和所有桥接组件是否都支持 MQTT 5.0。
2. 旧 Client 连接到支持多版本的 Broker 时，是否仍按 3.1.1 语义运行。
3. 业务是否错误依赖 MQTT 5.0 Properties，例如 Topic Alias、Response Topic 或 Reason Code。
4. Clean Session 到 Clean Start + Session Expiry 的迁移是否改变离线消息与订阅恢复行为。
5. Broker 是否实际开放共享订阅、Retain、通配符和最大 QoS 等可选能力。

MQTT 5.0 的价值不在于"版本更高"，而在于把 MQTT 3.1.1 中由产品文档、约定和失败后猜测承担的部分，尽可能移到了协议的可表达范围内。
