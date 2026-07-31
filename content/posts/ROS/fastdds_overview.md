+++
title = "FastDDS 源码阅读指南：架构、分层与核心模块"
description = "理解 FastDDS 的分层设计、线程模型和内存管理，为深入源码做准备"
date = "2026-07-31"
aliases = ["DDS"]
author = "ChnjFan"
tags = [
    "ROS",
    "DDS",
]
+++

跑通 FastDDS 的 Hello World 之后，你打开代码仓库准备读源码，发现 `src/cpp/` 下躺着几十个目录、几万行 C++ 代码。从哪开始？

这篇文章画一张源码地图。读完之后，你会知道一个 `write()` 调用在代码里经历了哪些函数、每个模块在仓库的哪里、模块之间怎么协作。

## 代码仓库结构

克隆 FastDDS 仓库后，先别急着读代码。花 5 分钟搞清楚目录结构，后面的阅读过程会少很多迷茫。

### 顶层目录

```
Fast-DDS/
├── include/         # 公开头文件，对外 API 的入口
├── src/cpp/         # 所有实现代码，读源码的主战场
├── examples/        # 官方示例，配合源码阅读的参照物
├── test/            # 单元测试和集成测试
├── tools/           # 命令行工具（fastddsgen 等）
└── utils/           # 被其他模块复用的工具代码
```

读源码时，`include/` 和 `src/cpp/` 要对照着看。`include/` 里的头文件定义了类的公开接口，`src/cpp/` 里的 `.cpp` 文件是具体实现。

### 核心模块

`src/cpp/` 是 FastDDS 的核心实现，按职责划分为以下模块：

| 目录 | 职责 | 对应层 |
|------|------|--------|
| `fastdds/domain/` | DomainParticipant 的创建、管理、生命周期 | DDS 层 |
| `fastdds/publisher/` | Publisher 和 DataWriter | DDS 层 |
| `fastdds/subscriber/` | Subscriber 和 DataReader | DDS 层 |
| `fastdds/builtin/` | 内置服务（日志、统计） | DDS 层 |
| `rtps/` | RTPS 协议实现（核心） | RTPS 层 |
| `rtps/transport/` | 传输层（UDP、TCP、共享内存） | 传输层 |
| `utils/` | 工具类（时间、线程池、日志、文件锁） | 基础设施 |

### 命名空间

FastDDS 的代码按层划分命名空间：

- `eprosima::fastdds::dds` — DDS 层的公开接口（DataWriter、DomainParticipant 等）
- `eprosima::fastdds::rtps` — RTPS 协议层（Writer、Reader、HistoryCache 等）

读源码时，通过命名空间就能判断当前代码属于哪一层。上层代码调用下层代码，下层通过回调通知上层，方向不会反过来。

### 推荐的入手顺序

不要从 `main()` 开始一行行读。按这个顺序效率高很多：

1. 先读 `include/` 里的头文件，理解每个类的公开接口和数据结构
2. 再看 `examples/` 里的 HelloWorld 示例，知道这些接口怎么组合使用
3. 然后从 `DataWriter::write()` 开始，顺着调用链往下追
4. 遇到 RTPS 层的类（`rtps/Writer`、`rtps/HistoryCache`），停下来理解它的职责
5. 最后看 `rtps/transport/`，理解数据怎么离开网卡

## 分层架构

<img src="https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260731171422530.png" style="zoom: 33%;" />

- DDS 层：实现 DDS 通信中间件并向用户提供 OMG DDS 标准 API，支持部署一个或多个 DDS Domain，在同一个 Domain 下的 `DomainParticipant` 通过向主题发布或订阅消息来交换数据。
- RTPS 协议层：实现[实时发布-订阅（RTPS）协议](https://www.omg.org/spec/DDSI-RTPS/2.2)，将「发布订阅」抽象成真实的网络数据包，是传输层的抽象层。
- 传输层：可以使用 UDP、TCP 和共享内存 SHM 传输协议。
- 基础设施层：提供工具类。

### 数据分发服务 DDS 层

数据分发服务（DDS）层实现 OMG DDS 标准中定义的发布-订阅通信模型。它构建在 RTPS 之上，为应用开发者提供高层次、面向业务的 API。

DDS 层将所有支持服务质量（QoS）策略、监听器和状态条件的对象都抽象为 `Entity`。

`Entity` 定义在 `include/fastdds/Entity.hpp`，是所有 DDS 实例的抽象基类，只要某个业务对象需要配置 QoS、绑定事件监听、记录运行状态，都必须继承这个 `Entity` 抽象类，统一复用这套基础能力。

- QoS：每个 `Entity` 的行为可以通过一组配置策略进行设置，用户可以创建 QoS 类实例来根据需求修改行为策略。
- Listener：监听器用来接收程序执行过程中出现的事件通知。

DDS 层中的核心 `Entity` 包括：

- `DomainParticipant`：通过 DomainID 来标识所在域，创建和管理发布者、订阅者和主题；
- `Publisher`：发布者通过 `DataWriter` 发布指定主题的数据，`DataWriter` 将数据生成一条变更记录写入 `DataWriterHistory`，随后这些变更记录发送给指定主题的 `DataReader`。
- `Subscriber`：订阅者通过 `DataReader` 接收主题数据，接收的数据存入 `DataReaderHistory`。

### 实时发布订阅传输协议 RTPS 层

RTPS 层的实体和 DDS 层一一对应：`DomainParticipant` ↔ `RTPSParticipant`，`DataWriter` ↔ `RTPSWriter`，`DataReader` ↔ `RTPSReader`。DDS 层是面向用户的抽象，RTPS 层是面向网络的实现。

- `RTPSDomain`：DDS Domain 在 RTPS 层的映射；
- `RTPSParticipant`：RTPS 层创建和配置其他实体；
- `RTPSWriter`：读取 `DataWriterHistory` 中写入的变更记录，并将其传输给所有匹配的 `RTPSReader`。
- `RTPSReader`：消息接收实体，将 RTPSWriter 报告的更改写入 `DataReaderHistory`。

## write() 的完整调用链

### 调用方向

数据发送的方向是**从上到下**：

```
DataWriter::write()
  → RTPSWriter::send()
    → HistoryCache::add_change()
    → RTPSWriter::send_through_all_channels()
      → TransportInterface::send()
        → UDPTransport::Send()
```

数据接收的方向是**从下到上**：

```
UDP 接收线程收到数据
  → TransportInterface::Receive()
    → RTPSReader::process_data()
      → HistoryCache::add_change()
        → DataReader::DataReader 的回调 on_data_available()
```

<img src="https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260731171104799.png" style="zoom: 50%;" />

两个方向不会在同一个线程里发生。发送走用户线程，接收走传输层自带的接收线程。它们之间通过 HistoryCache 的读写锁协调。

### 层与层之间的边界

每一层通过接口类隔离，这是 FastDDS 源码里最值得学习的设计模式：

- **TransportInterface** — 传输层的抽象基类，定义了 `Send()` 和 `Receive()` 接口。UDP、TCP、共享内存分别实现它。RTPS 层只跟 TransportInterface 交互，不关心底层协议
- **RTPSWriter / RTPSReader** — RTPS 层的协议实体，封装了序列号管理、ACK/NACK 重传、心跳等协议细节。DDS 层通过它们发送和接收数据，但不直接操作传输层
- **DataWriter / DataReader** — DDS 层的公开接口，用户代码直接跟它们交互。它们内部持有对应的 RTPSWriter 和 RTPSReader

这种设计意味着你可以替换任意一层而不影响其他层。想加一种新的传输方式？实现 TransportInterface 就行。想改协议细节？只动 RTPS 层，DDS 层不用改。

### 源码阅读时的分层意识

读源码时，时刻问自己：**当前代码在哪一层？它在调用哪一层的接口？**

如果你在 `fastdds/publisher/DataWriter.cpp` 里看到了 `rtps::RTPSWriter` 的调用，这是正常的——DDS 层调用 RTPS 层。但如果你在 `rtps/transport/UDPTransport.cpp` 里看到了 `dds::DataWriter` 的调用，这就值得停下来搞清楚为什么——因为正常的调用方向不应该反过来。

