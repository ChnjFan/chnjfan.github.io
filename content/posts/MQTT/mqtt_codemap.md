+++
title = "从字节到状态机：Paho 分层代码地图"
description = "搞懂 MQTT 三种版本与 Paho 的四层结构，拿到整条阅读地图"
date = "2026-08-13"
aliases = ["MQTT-codemap"]
author = "ChnjFan"
tags = [
    "paho.mqtt.cpp",
    "MQTT",
]
categories = [
    "MQTT",
]
+++

打开 Paho 源码仓库，第一反应通常是：这从哪看起？一个 `connect()` 调用的背后到底发生了什么？`paho.mqtt.c/src/` 中有四五十个源码文件，还有一层封装的 C++ 库。MQTT 本身又有 3 个并存的协议版本、十几种报文，随便挑个文件读，很容易迷失在细节里。

这是《逐字节读懂 MQTT：Paho 客户端源码精读》系列的第一篇，这篇主要回答三个问题：

- MQTT 三个版本（3.1 / 3.1.1 / 5.0）的差异在哪？报文类型有多少种？
- Paho 源码怎么分层？`connect()` 到网络字节流之间隔着什么？
- `paho.mqtt.c` 和 `paho.mqtt.cpp` 什么关系？该读哪个？

本文先看 MQTT 协议的版本和报文，再对文件进行分类，最后讲出两个库之间的关系并给出这个系列文章的路线。

先给结论：

- **版本差异不是语法糖**。 MQTT 5.0 相比 3.1/3.1.1 是整套机制升级：报文从 14 种变 15 种（新增 AUTH），多了属性系统和原因码，会话、遗嘱、断连语义全部重做。在读源码时一定要清楚当前流程对应的版本，在代码中 `if (MQTTVersion >= 5)` 分支将贯穿全文。
- **Paho 四层结构**。Packet 层做字节编解码，Protocol 层维护协议状态机，Client 层暴露 API 并管理线程/回调，Network 层处理 socket/TLS/WebSocket。接收的报文从网络到用户的应用回调，依次穿过这四层。
- **两个库是封装关系**，不是两套实现。paho.mqtt.cpp 的 `async_client` 内部直接持有 C 库的 `MQTTAsync` 句柄，绝大部分逻辑在 C 库。读懂 C 库，C++ 层的接口基本都能看懂。


## MQTT 协议的三个版本与报文类型

在深入之前，先定下这套源码的基准版本，后续所有行号、行为都以此为准：
- paho.mqtt.c 1.3.16
- paho.mqtt.cpp 1.6.0

两个库都支持 MQTT 3.1、3.1.1、5.0 三个版本。

### 三个版本：名字都在报文里

MQTT 协议三个版本，版本号直接写在 CONNECT 报文里（协议名 + 协议级别两个字段）：

| 协议版本 | CONNECT 报文协议名 | 协议级别 | 备注 |
|---|---|---|---|
| MQTT 3.1 | `MQIsdp` | 3 | 最老，现在基本只在兼容场景出现 |
| MQTT 3.1.1 | `MQTT` | 4 | 最广泛部署的一代，clean session 时代 |
| MQTT 5.0 | `MQTT` | 5 | 属性系统、原因码、会话过期等整套新机制 |

就算没有读过源码，你也可能遇到过这条链路：客户端说「我是 MQTT 5 的客户端」，Broker 回 CONNACK 接受或拒绝。如果协议级别不匹配就会被拒绝，这是版本协商的底层逻辑。

### 15 种报文类型

MQTT 报文类型由一个 4 位的 `type` 字段决定。Paho 的 C 库把枚举值保存在 `MQTTPacket.h` 中：

```c
enum msgTypes
{
	CONNECT = 1, CONNACK, PUBLISH, PUBACK, PUBREC, PUBREL,
	PUBCOMP, SUBSCRIBE, SUBACK, UNSUBSCRIBE, UNSUBACK,
	PINGREQ, PINGRESP, DISCONNECT, AUTH
};
```

报文类型 3.1/3.1.1 有 14 种，5.0 新增 AUTH 变成 15 种。按功能分组：
- **连接组**：`CONNECT(1)` / `CONNACK(2)` / `DISCONNECT(14)` 用来建立连接、建连应答和断连；
- **发布组**：`PUBLISH(3)` 加上 QoS 1/2 的确认报文 `PUBACK(4)` / `PUBREC(5)` / `PUBREL(6)` / `PUBCOMP(7)`；
- **订阅组**：`SUBSCRIBE(8)` / `SUBACK(9)` / `UNSUBSCRIBE(10)` / `UNSUBACK(11)`；
- **心跳组**：`PINGREQ(12)` / `PINGRESP(13)`；
- **v5 新增**：`AUTH(15)` 增强鉴权，比如 SASL 多次握手。

这个分组展现了 MQTT 的报文设计规律：**除了 `PUBLISH` 是双向数据报文**，其余全是「请求」和「应答」的配对。CONNECT→CONNACK、PINGREQ→PINGRESP、SUBSCRIBE→SUBACK，QoS 2 则是 PUBREC→PUBREL→PUBCOMP 三步握手。读编解码代码时你会看到，每个报文都要实现「发出去」和「收回来」两个方向。


### v5 改变的本质：属性、原因码、AUTH

MQTT 5.0 版本不是增加了几个字段那么简单，它的变化集中在三个方面：
- **属性系统**（properties）：几乎所有报文都能携带一组 property，包含主题别名、会话过期、`RECEIVE_MAXIMUM` 流控、`SERVER_KEEP_ALIVE`、`Server Reference` 等。Paho 为此新增了 `MQTTProperties.c` 文件。
- **原因码**（reason code）：应答报文的「成功/失败」从布尔类型变成了可解释的原因码。比如断连的 `0x8E` Session taken over、`0x87` Not authorized，定义在 `MQTTReasonCodes.c` 中。
- **AUTH 报文**：鉴权从「连接时一次握手」变成可以多轮协商。

这些改变让 v5 的断连、会话、订阅语义全部升级，也解释了为什么 Paho 源码里到处是 `if (MQTTVersion >= MQTTVERSION_5)`，遇到这样就是 v3 和 v5 行为的差异。

{{< notice tip >}}
顺便说一句：3.1.1 和 5.0 是当前实际部署的两个版本，3.1 只在旧设备兼容里出现。本系列默认把「v3」当 3.1.1 讲，涉及 3.1 的差异会在对应篇目点出。
{{< /notice >}}


## 四层代码地图

Paho 的 C 库源码不是一堆平铺的文件。顺着「字节 → 协议 → API → 传输」的职责可以分为四层，外加一批支撑工具：

| 层 | 职责 | 代表文件（`paho.mqtt.c/src/`） |
|---|---|---|
| **Packet 层** | 报文字节编解码：解析固定头、剩余长度、按类型序列化/反序列化 | `MQTTPacket.c` / `MQTTPacketOut.c`、`MQTTProperties.c`（v5 属性）、`MQTTReasonCodes.c`（v5 原因码）、`utf-8.c`（字符串校验） |
| **Protocol 层** | 协议状态机：keepalive、QoS 消息流、消息 ID、会话状态 | `MQTTProtocolClient.c` / `MQTTProtocolOut.c`、`Messages.c`、`Clients.c` |
| **Client 层** | API 与并发：对外接口、命令队列、线程、回调分发 | `MQTTAsync.c` / `MQTTAsyncUtils.c`（异步）、`MQTTClient.c`（同步）、`MQTTPersistence.c`（持久化） |
| **Network 层** | 传输：socket 读写、TLS、WebSocket、代理隧道、收发缓冲 | `Socket.c` / `SocketBuffer.c`、`SSLSocket.c`、`WebSocket.c`、`Proxy.c` |
| **支撑工具** | 线程、链表、日志、内存、哈希树 | `Thread.c`、`LinkedList.c`、`Log.c`、`Heap.c`、`Tree.c`、`MQTTTime.c` |

请求从 API 向下走到网络，报文从网络向上走到回调，Packet 层夹在中间做翻译。`connect()` 是客户端 API 的动作，CONNECT 是协议层的报文，Packet 层则负责将协议层的报文转换成网络字节流，将字节流还原为报文。

### 报文的收发路线

以客户端收到一条 PUBLISH 消息为例，看它怎么从网络字节传递到你的 `message_arrived` 回调：

```
网络字节流
│
1. Network 层：SocketBuffer 把字节收进缓冲（处理 partial read）
│
2. Packet 层：MQTTPacket_Factory()（MQTTPacket.c:105）
│   读固定头 → 解码剩余长度 → 按 type 反序列化 → 返回 PUBLISH 结构体
│
3. Protocol 层：MQTTAsync_cycle 的条件分支按 type 分派
│   → MQTTProtocol_handleXxx() 更新状态机（QoS 确认、消息 ID、在途列表）
│
4. Client 层：MQTTAsync_deliverMessage()（MQTTAsyncUtils.c:2613）
    → 用户 message_arrived 回调
```

反过来发送一条 PUBLISH 报文：

```
用户 publish() API（Client 层）
│
命令队列（sendThread 取出）
│
MQTTProtocolOut / MQTTPacketOut 构造报文（Protocol + Packet 层）
│
MQTTPacket_send()（MQTTPacket.c:195）写网络
│
SocketBuffer 写出（Network 层）
```

这里记住这两个方向的链路，后续每篇文章都是对链路中的细节进行深入解析。

### 地图用法：按异常定位文件

有了代码地图之后，我们遇到 MQTT 传输问题时，按故障现象定位到文件。

- 如果报文字节不对/粘包/剩余长度错误，定位到 Packet 层，看 `MQTTPacket.c` 的编解码；
- 消息重复 / 丢消息 / 消息 ID 混乱，定位 Protocol 层，看 QoS 状态机与在途队列；
- 回调不触发 / 卡死 / 顺序错乱，定位 Client 层，看命令队列与线程；
- 连不上 / 握手失败 / 某个环境才断线，定位 Network 层，加 TLS、WebSocket、代理参数排查。


## 双库关系、阅读路线与系列地图

### 双库的封装关系

paho.mqtt.cpp 不是「另写一套 MQTT 客户端」，而是 paho.mqtt.c 的 C++ 封装。

```cpp
// paho.mqtt.cpp/include/mqtt/async_client.h:44,162
#include "MQTTAsync.h"        // 直接包含 C 库头文件

class async_client {
    MQTTAsync cli_;           // C 库句柄，类成员
    ...
};
```

整个 C++ 层的工作可以概括成三类：

- **RAII 与状态包装**：把 C 库的句柄和错误码封装成对象与异常，`connect()` 失败抛 `mqtt::exception` 而不是返回错误码；
- **token 机制**：把 C 库的「操作入队 + 回调」包装成可 `wait()` 的 `token`，同步等待操作的完成；
- **回调适配**：C 库的回调是「函数指针 + context」，C++ 层注册自己的静态分发函数，再转发到用户的虚函数：

```cpp
// async_client.h:199-202（C 库回调的静态入口）
static void on_message_arrived(void* context, char* topicName, int topicLen,
                               MQTTAsync_message* msg);
static void on_delivery_complete(void* context, MQTTAsync_token tok);
static int on_update_connection(void* context, MQTTAsync_connectData* cdata);
```

所以当你调用 `async_client::connect()` 时，C++ 层内部通过组装 `MQTTAsync_connectOptions` → 调 C 库 `MQTTAsync_connect()` 实现连接，后面的连接流程全部在 C 库里跑。


### 阅读路线与系列地图

阅读源码时可以根据 `example` 示例出发，了解如何使用 Paho 库，再按照调用链路深入下去。本系列每篇都会给出关键函数和文件名，可以快速定位到文件位置。

| 阶段 | 篇目 |
|---|---|
| 一：连接与会话 | 1 代码地图（本篇）→ 2 报文编解码 → 3 CONNECT/CONNACK → 4 会话 |
| 二：消息与 QoS | 5 QoS 状态机 → 6 保留消息与遗嘱 |
| 三：订阅 | 7 订阅与路由 |
| 四：连接管理 | 8 保活心跳 → 9 自动重连 → 10 断线之后 |
| 五：网络与传输 | 11 非阻塞 Socket 与事件循环 → 12 TLS、WebSocket、代理 |
| 六：持久化与并发 | 13 会话持久化 → 14 同步 vs 异步线程模型 → 15 C++ 封装视角 |
| 七：收束 | 16 MQTT 5.0 属性、原因码与协议演进 |


## 小结

回到开头的三个结论：

- 三个版本差异是整套机制的分岔（15 种报文、属性、原因码），代码里的 `MQTTVersion` 分支就是版本坐标；
- 四层结构 Packet → Protocol → Client → Network 是代码地图，报文的收发是两条方向相反的路径；
- C++ 库是 C 库的封装，`async_client` 直接持有 `MQTTAsync` 句柄，读源码以 C 库为主。

下一步从地图的最底层「报文」本身开始，拆开 `MQTTPacket.c` 的字节编解码，你可以亲手拼出一个 CONNECT 报文。

