+++
title = "Fast-DDS 源码解析（四）：Discovery 从陌生到匹配"
description = "从 hello_world 的等待匹配出发，拆解 Discovery 的两阶段机制：SPDP 周期通告与租约、SEDP 端点匹配条件，以及 Discovery Server 的中心化取舍"
date = "2026-08-10"
aliases = ["DDS-discovery"]
author = "ChnjFan"
tags = [
    "Fast-DDS",
]
categories = [
    "DDS",
]
+++

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260810115306855.png)

{{< notice tip >}}
- Discovery 分两阶段：SPDP 通过周期通告与租约完成参与者互相发现，SEDP 完成端点匹配，`on_publication_matched` 是匹配完成的信号。
- Discovery 本身复用 pub/sub 机制：每个参与者自带 builtin 的 announcer/detector 端点，在 metatraffic 通道上交换参与者与端点的描述数据。
- 租约机制用「沉默即离线」判定参与者下线：通告默认每 3 秒一次，租约默认 20 秒，超期未收到通告即判定远端参与者离线。
- 端点匹配需同时满足四个条件：Topic name 相同、类型兼容、topic kind 一致、QoS 兼容；两端独立判断，无中心仲裁。
- Discovery Server 模式用中心化数据库替代组播广播，以单点风险为代价，解决 SIMPLE 模式随节点数平方增长的流量问题。
{{< /notice >}}

## matched 之前发生了什么

我们在 hello_world 示例中的看到的发送逻辑是这样的：

```cpp
// examples/cpp/hello_world/PublisherApp.cpp
bool PublisherApp::publish()
{
    // 等待至少一个 Subscriber 匹配
    std::unique_lock<std::mutex> matched_lock(mutex_);
    cv_.wait(matched_lock, [&]() {
        return ((matched_ >= expected_matches_) || is_stopped());
    });

    if (!is_stopped())
    {
        hello_.index(hello_.index() + 1);
        ret = (RETCODE_OK == writer_->write(&hello_));
    }
    return ret;
}
```

Publisher 创建完成后并不立即发送，而是阻塞在条件变量上，等待 `matched_` 达到预期值。当 Subscriber 端的 `DataReader` 与发布端的 `DataWriter` 完成配对时触发 `on_publication_matched` 回调来修改 `matched_`。

RELIABLE 模式下没有匹配到 Reader 也可以直接发送数据，数据会保存在 History 缓存中。示例选择等待，关键问题是从两个进程启动，到 `on_publication_matched` 回调被调用，这中间网络上发生了什么？

两个进程刚启动时互不相识。Publisher 不知道 Subscriber 存在，不知道它的 IP 和端口，不知道它订阅了什么 Topic，Subscriber 对 Publisher 也是一样。它们唯一的共同信息是配置在同一个 domain id，同样的 metatraffic 组播地址。从「完全陌生」到「端点配对」，Fast-DDS 要走完两个阶段：

1. **参与者发现**。网络上的参与者互相宣告自己的存在，交换基本信息 GUID、locator、租约等，由 **SPDP**（Simple Participant Discovery Protocol）完成。这个阶段结束后，Publisher 的进程知道「网络上有一个参与者，它在哪台机器的哪个端口上」。
2. **端点匹配**。 参与者进一步交换各自端点的信息 Topic、类型、QoS 等，Writer 和 Reader 按匹配规则配对，这个阶段由 **SEDP**（Simple Endpoint Discovery Protocol）完成。这个阶段结束后，`DataWriter` 知道了远端 `DataReader` 的地址和通信参数，`on_publication_matched` 触发，hello_world 发布数据的等待结束。

两个阶段在代码里对应 `src/cpp/rtps/builtin/discovery/` 下的两组类：`participant/` 目录的 PDP（Participant Discovery Protocol）和 `endpoint/` 目录的 EDP（Endpoint Discovery Protocol）。

在深入这两个协议之前，先提出一个前置问题：Discovery 的报文走什么通道？发现和用户数据用的是同一套收发机制吗？


## Discovery 的基础设施：builtin 端点

### Discovery 走什么通道

我们先来看一个容易混淆的问题，Discovery 报文和用户数据是通过一个通道发送接收的吗？

不是。在 `RTPSParticipantAttributes` 的 `builtin` 中保存了两套独立的 Locator 列表：

```cpp
// include/fastdds/rtps/attributes/RTPSParticipantAttributes.hpp（精简）
class BuiltinAttributes
{
public:
    LocatorList_t metatrafficUnicastLocatorList;     // Discovery 报文的单播地址
    LocatorList_t metatrafficMulticastLocatorList;   // Discovery 报文的组播地址
    //... 其他成员
};

class RTPSParticipantAttributes
{
public:
    // 用于用户数据
    LocatorList_t defaultUnicastLocatorList;
    LocatorList_t defaultMulticastLocatorList;
    BuiltinAttributes builtin;
    //... 其他成员
};
```

**metatraffic**（元数据流量）是 Discovery 专用通道：参与者发现、端点匹配、活性检测的报文都在这里传输，与用户数据通道分开。两套通道各有自己的端口和地址配置。


### Discovery 本身就是一个 pub/sub 应用

Discovery 的数据用什么方式收发？

答案可能有点绕，Discovery 复用了它要发现的同一套机制。每个 RTPS 参与者创建时，除了用户可见的实体，还会在内部创建一组 builtin 端点。builtin writer 负责发布「我这个参与者存在，信息如下」，builtin reader 负责订阅其他参与者的同类信息。Discovery 就是这些 builtin 端点之间的 pub/sub。

SIMPLE 模式的 PDP 端点定义中能看到这个结构：

```cpp
// src/cpp/rtps/builtin/discovery/participant/simple/SimplePDPEndpoints.hpp（精简）
struct SimplePDPEndpoints : public PDPEndpoints
{
    BuiltinEndpointSet_t builtin_endpoints() const override
    {
        return DISC_BUILTIN_ENDPOINT_PARTICIPANT_ANNOUNCER   // 宣告者：builtin writer
             | DISC_BUILTIN_ENDPOINT_PARTICIPANT_DETECTOR;   // 探测者：builtin reader
    }
    // 内部持有一对 writer/reader 及其 history、listener
    BuiltinReader<StatelessReader> reader;
    BuiltinWriter<PDPStatelessWriter> writer;
};
```

从命名中我们就能看出来，announcer（宣告者）发布参与者信息，detector（探测者）接收其他参与者的宣告。SEDP 阶段还有另一对端点用于端点信息的发布/订阅，结构相同。

这些端点和用户创建的 `DataWriter`/`DataReader` 走同一套 RTPS 机制：有 GUID、有 History、有 QoS，区别在于它们由框架自动创建和管理，用户不可见。

builtin 端点通常配置为 `RELIABLE` + `TRANSIENT_LOCAL`，保证发现信息可靠送达、后加入者能收到。


### BuiltinProtocols：总入口

`BuiltinProtocols` 类用来管理 Discovery 的所有内置协议：

```cpp
// src/cpp/rtps/builtin/BuiltinProtocols.h（精简）
class BuiltinProtocols
{
    friend class RTPSParticipantImpl;

public:
    bool initBuiltinProtocols(RTPSParticipantImpl* p_part,
                            BuiltinAttributes& attributes);
    void enable();

    BuiltinAttributes m_att;
    RTPSParticipantImpl* mp_participantImpl;
    PDP* mp_PDP;        // 参与者发现协议
    WLP* mp_WLP;        // Writer 保活协议（本篇不展开）
    fastdds::dds::builtin::TypeLookupManager* typelookup_manager_;  // 类型查询

    LocatorList_t m_metatrafficMulticastLocatorList;
    LocatorList_t m_metatrafficUnicastLocatorList;
    LocatorList_t m_initialPeersList;
    LocatorList_t m_DiscoveryServers;
    // ...
};
```

`RTPSParticipantImpl` 构造期间调用 `initBuiltinProtocols()` 初始化，创建 PDP/EDP 对象和 builtin 端点；参与者启用链的最后一步 `part->enable()` 最终调用 `RTPSParticipantImpl::enable()`，启动 Discovery 广播。

```cpp
void RTPSParticipantImpl::enable()
{
    mp_builtinProtocols->enable();

    //Start reception
    for (auto& receiver : m_receiverResourcelist)
    {
        receiver.Receiver->RegisterReceiver(receiver.mp_receiver);
    }
}
```

回顾我们在之前文章提到的 Participant 创建的调用链，现在可以补上最后一环：`DomainParticipantImpl::enable()` → `part->enable()` → `BuiltinProtocols::enable()` → announcer 开始工作，第一个 Discovery 报文发出。


### Proxy Data：Discovery 交换的数据结构

builtin 端点发布和订阅的内容是三种 proxy data：

```cpp
// src/cpp/rtps/builtin/data/ParticipantProxyData.hpp（精简）
class ParticipantProxyData : public ParticipantBuiltinTopicData
{
public:
    ProtocolVersion_t m_protocol_version;       // 协议版本
    fastcdr::string_255 machine_id;             // 机器标识
    BuiltinEndpointSet_t m_available_builtin_endpoints;  // 对方有哪些 builtin 端点
    NetworkConfigSet_t m_network_configuration; // 网络配置
    Count_t m_manual_liveliness_count;
    // 继承自 ParticipantBuiltinTopicData：
    //   GUID、metatraffic locator 列表、lease duration 等
};
```

`ParticipantProxyData` 描述了一个完整的通信参与者：它是谁（GUID）、在哪里（locator）、支持什么（builtin 端点集合）、多久算失联（lease duration）。

基类 `ParticipantBuiltinTopicData` 说明这个数据结构对应了 DDS 规范里的 Builtin Topic，理论上用户可以通过订阅 builtin topic 直接观察 Discovery 数据。

另外两种 proxy data 在 SEDP 阶段使用：`WriterProxyData` 和 `ReaderProxyData` 描述单个端点的信息 GUID、locator、Topic name、type name、QoS 等。


### 用 DDS 发现 DDS

Fast-DDS 没有为 Discovery 设计一套独立的收发机制，而是让 Discovery 成为 RTPS 的第一个应用。announcer/detector 就是普通的 RTPS Writer/Reader，发现报文就是普通的 RTPS DATA 消息，走我们之前文章讲过的端点创建流程，以及后续要讲的 History 和传输层。

这个选择的好处是机制复用，可靠性、心跳、重传这些能力不需要为 Discovery 单独实现一遍；代价是 Discovery 依赖自己尚未完全建立的基础设施，所以 builtin 端点的创建顺序和初始化时序在 RTPSParticipantImpl 构造中需要仔细排列。


## SPDP：参与者发现协议

上一节我们了解了 Discovery 报文发送的**通道和机制**，这一节我们看 announcer 具体怎么工作，参与者信息怎么广播出去，远端的 detector 收到后做什么，以及「多久没消息算掉线」的租约机制。

怎么知道网络上还有其他参与者？怎么知道某个参与者掉线了？前者靠**周期通告**，后者靠**租约**。


### announceParticipantState：通告

本地参与者的通告从 `BuiltinProtocols::enable` 中调用的 `PDPSimple::announceParticipantState()` 开始：

```cpp
// src/cpp/rtps/builtin/discovery/participant/PDPSimple.cpp（精简）
void PDPSimple::announceParticipantState(bool new_change, bool dispose)
{
    if (enabled_)
    {
        new_change |= m_hasChangedLocalPDP.exchange(false);
        // ...
        auto endpoints = dynamic_cast<SimplePDPEndpoints*>(builtin_endpoints_.get());
        // 把本地 ParticipantProxyData 序列化后写入 announcer 的 History
        WriterHistory& history = *(endpoints->writer.history_);
        PDP::announceParticipantState(history, new_change, dispose, wp);
        // 经 metatraffic locator 周期发往组播/单播地址
        endpoints->writer.writer_->send_periodic_announcement();
    }
}
```

这段逻辑把本地 `ParticipantProxyData` 写入 writer 的 History 中，剩下的发送工作由 RTPS 层完成。报文以组播方式发往 metatraffic 组播地址，同一 domain 的所有参与者都在监听这个地址；同时也会发往配置的初始对端列表 `initialPeersList` 的单播地址，覆盖无法使用组播的网络环境。

在 RTPS 报文层面，这条通告是一个 DATA 子消息，key 是参与者的 GUID，规范里记作 DATA(p)。


### 什么时候通告：初始发送 + 周期重发

通告的时机由两部分组成。

**启动时初始消息的发送**。`InitialAnnouncementConfig` 控制参与者在刚启动时发送通告：

```cpp
// include/fastdds/rtps/attributes/RTPSParticipantAttributes.hpp
struct InitialAnnouncementConfig
{
    /// Number of initial announcements with specific period (default 5)
    uint32_t count = 5u;
    /// Specific period for initial announcements (default 100ms)
    dds::Duration_t period = { 0, 100000000u };   // 100ms
};
```

默认启动后以 100ms 间隔连发 5 次，目的是降低首次发现的延迟。其实发送了 6 次，因为初始化的时候先发了 1 条，然后每隔 100ms 又发送了一次。如果只靠周期通告，最坏情况下新加入者要等一个完整周期（3 秒）才能被别人发现；启动后立即发送多次可以把首次发现的窗口压缩到几百毫秒。代价是启动瞬间多一点报文，对绝大多数部署可以忽略。

**稳态时的周期重发**。`PDP` 持有一个定时事件：

```cpp
class PDP : public fastdds::statistics::rtps::IProxyQueryable
{
private:
    //!TimedEvent to periodically resend the local RTPSParticipant information.
    TimedEvent* resend_participant_info_event_;
};
```

默认周期由 `DiscoverySettings::leaseDuration_announcementperiod` 控制，默认 3 秒。这个定时器是在租约有效期内发送保活消息，告诉其他节点端点自己的活跃状态。

通过抓包看看 hello_world 示例 Publisher 启动发送和周期重发的报文：

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260809210052278.png)


### 接收：PDPListener 的处理链

远端参与者收到通告后的处理入口是 builtin reader 的监听器 `PDPListener`，它实现 RTPS 层的 `ReaderListener` 接口，入口方法是 `PDPListener::on_new_cache_change_added`，有新的 cache change 到达 History 时被调用。处理链分三步：

```
PDPListener::on_new_cache_change_added()
  │  反序列化 DATA(p) → ParticipantProxyData
  ▼
check_discovery_conditions(pdata)
  │  检查是否接受这个参与者（domain、协议版本等）
  ▼
process_alive_data(old_data, new_data, ...)
  │  新参与者：创建远端 ParticipantProxyData，记录到已发现列表
  │  已知参与者：更新信息，续租约
  ▼
on_participant_discovery 回调 → 用户的 DomainParticipantListener
```

我们在第一篇讲 Listener 适配器 的时候提到，RTPS 层事件通过 `MyRTPSParticipantListener` 适配器传回 DDS 层，再到达用户的 `DomainParticipantListener::on_participant_discovery()`。


### 租约：沉默即离线

发现容易，检测离线难。分布式系统里，一个参与者停止宣告可能是三种情况：进程崩溃了、网络断了、或者只是报文丢了。

SPDP 用**租约**（lease）统一处理：不区分原因，只看「多久没有消息」。

**宣告端**默认每 3 秒发一次通告，相当于「续租请求」。**接收端**为每个已发现的远端参与者维护一个独立的租约定时器，保存在 `ParticipantProxyData` 中：

```cpp
// src/cpp/rtps/builtin/data/ParticipantProxyData.hpp（精简）
class ParticipantProxyData : public ParticipantBuiltinTopicData
{
    // ...
    TimedEvent* lease_duration_event;      // 该远端参与者的租约定时器
    bool should_check_lease_duration;
    std::chrono::microseconds lease_duration_;   // 租约时长
};
```

每次收到该参与者的通告就重置定时器。

定时器到期，默认 `ConstantDiscoverySettings::leaseDuration` = 20 秒内没有收到任何通告，判定该参与者离线，从已发现列表移除，并触发 `on_participant_discovery` DISPOSED 状态回调。这个参与者名下的所有端点也被删除。

我们在 `RTPSDomain::createParticipant` 入口看到过两个参数值得注意：

```cpp
if (attrs.builtin.discovery_config.leaseDuration < dds::c_TimeInfinite &&
        attrs.builtin.discovery_config.leaseDuration <=
        attrs.builtin.discovery_config.leaseDuration_announcementperiod)
{
    EPROSIMA_LOG_ERROR(RTPS_PARTICIPANT,
            "RTPSParticipant Attributes: LeaseDuration should be >= leaseDuration "
            "announcement period");
    return nullptr;
}
```

这里判断了**租约必须大于通告周期**，否则正常的心跳间隔就会被误判为离线。默认配置 3 秒通告 / 20 秒租约，连续丢失约 6 次通告才会判定离线。这是一个保守的配置，漏报的代价就是将活着的参与者中断通信，误报延迟的代价只是离线检测慢一点。需要更快检测离线的场景可以调小两个参数，代价是 Discovery 流量增加。


### 租约的设计逻辑

**租约**是分布式系统中经典的**活性检测模式**，它的核心取舍是：

- **不需要显式的离线通知**。进程崩溃、断电、网络分区都不会留下「我走了」的消息，租约机制不依赖任何节点的告别消息。
- **检测延迟有下界**。最坏情况要等满一个租约周期（默认 20 秒）才能确认离线，这是沉默即离线模式的代价。
- **流量与延迟成反比**。通告周期越短、租约越短，离线检测越快，Discovery 流量越大。

SPDP 完成后，每个参与者手里有一份「网络上有谁」的名单。但名单上只有参与者，Publisher 的 `DataWriter` 和 Subscriber 的 `DataReader` 还没对上号。


## SEDP：端点匹配协议

SPDP 结束后，每个参与者手里有一份远端参与者名单。但名单上只有「网络上有谁」，并没有「我的 DataWriter 能和谁的 DataReader 通信」的信息。这就是第二阶段 **SEDP**（Simple Endpoint Discovery Protocol）的工作。


### 端点信息的交换

SEDP 的机制与 SPDP 类似，还是 builtin 端点之间的 pub/sub，只是交换的内容不同。每个参与者除了 SPDP 的 announcer/detector，还有两对 SEDP 端点：

```cpp
// src/cpp/rtps/builtin/discovery/endpoint/EDPSimple.cpp（端点位标志，节选）
DISC_BUILTIN_ENDPOINT_PUBLICATION_ANNOUNCER    // 发布本端 Writer 信息
DISC_BUILTIN_ENDPOINT_PUBLICATION_DETECTOR     // 接收远端 Writer 信息
DISC_BUILTIN_ENDPOINT_SUBSCRIPTION_ANNOUNCER   // 发布本端 Reader 信息
DISC_BUILTIN_ENDPOINT_SUBSCRIPTION_DETECTOR    // 接收远端 Reader 信息
```

发布的内容是 `WriterProxyData` 「DATA(w) 报文」和 `ReaderProxyData` 「DATA(r) 报文」，每个端点一张「名片」：GUID、locator（怎么联系）、Topic name 和 type name（说什么）、QoS（怎么说）。SPDP 的 `ParticipantProxyData` 里那个 `m_available_builtin_endpoints` 字段在这里派上用场：收到远端参与者信息时，本端通过它知道对方支持哪些 SEDP 端点，从而决定把端点名片发给谁。

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260809222416672.png)

### 匹配条件：valid_matching

名片交换完成后，配对判断在 `EDP::valid_matching` 里。接下来以 Writer 视角对照远端 Reader 的名片看完整的判断链：

```cpp
// src/cpp/rtps/builtin/discovery/endpoint/EDP.cpp（valid_matching，精简）
bool EDP::valid_matching(
        const WriterProxyData* wdata,
        const ReaderProxyData* rdata,
        MatchingFailureMask& reason,
        fastdds::dds::PolicyMask& incompatible_qos)
{
    reason.reset();
    incompatible_qos.reset();
    // 条件一：Topic name 必须相同
    if (wdata->topic_name != rdata->topic_name)
    {
        reason.set(MatchingFailureMask::different_topic);
        return false;
    }

    if ((wdata->has_type_information() && wdata->type_information.assigned()) &&
            (rdata->has_type_information() && rdata->type_information.assigned()))
    {// 条件二：类型兼容，双方都携带 TypeIdentifier（XTypes）
        if (!is_same_type(wdata->type_information.type_information,
                         rdata->type_information.type_information))
        {
            reason.set(MatchingFailureMask::different_typeinfo);
            return false;
        }
    }
    else
    {
        if (wdata->type_name != rdata->type_name)
        {
            reason.set(MatchingFailureMask::inconsistent_topic);
            return false;
        }
    }
    // 条件三：Topic kind 一致（有 key / 无 key）
    if (wdata->topic_kind != rdata->topic_kind)
    {
        reason.set(MatchingFailureMask::inconsistent_topic);
        return false;
    }
    // 条件四：QoS 兼容性（offered/requested 规则）
    if ( wdata->reliability.kind == dds::BEST_EFFORT_RELIABILITY_QOS
            && rdata->reliability.kind == dds::RELIABLE_RELIABILITY_QOS)
    //Writer 只能尽力而为，Reader 要求可靠，不兼容
    {
        incompatible_qos.set(fastdds::dds::RELIABILITY_QOS_POLICY_ID);
    }
    // ... Durability、Deadline、Ownership 等策略的逐项检查 ...
    return matched;
}
```

**Topic name** 是最直观的过滤条件，不同的 Topic 端点永远不匹配。

类型兼容这里有两个层次的判断。如果双方都携带 `TypeIdentifier`，用 `is_same_type` 比较类型标识的结构是否相同。如果没有携带则退化为比较 Type name 字符串，主要名字相同就认为兼容，结构由用户来保证。

Topic kind 一致判断，有 key 的类型和无 key 的类型不能混配，两者的 History 缓存组织和实例语义完全不同。

QoS 兼容性是这是四个条件里最复杂的，遵循 offered/requested 规则：**Writer 提供的能力必须满足 Reader 的要求**。代码里那个 reliability 就是最典型的例子，`BEST_EFFORT` 的 Writer 满足不了 `RELIABLE` 的 Reader，Reader 要求可靠重传，Writer 提供不了，但反过来可以：RELIABLE 的 Writer 配 BEST_EFFORT 的 Reader 没问题。

Durability、Deadline、LatencyBudget 等策略各有自己的兼容规则。不兼容时，冲突的具体策略被记入 incompatible_qos 掩码，触发 on_offered_incompatible_qos（Writer 侧）或 on_requested_incompatible_qos（Reader 侧）回调，用户能知道是哪个策略协商不一致。


### 配对与回调

`valid_matching` 通过后，`EDP::pairingWriter` 把远端 Reader 的信息登记到本地 Writer：

```cpp
// src/cpp/rtps/builtin/discovery/endpoint/EDP.cpp（pairingWriter，精简）
bool EDP::pairingWriter(
        RTPSWriter* W,
        const GUID_t& participant_guid,
        const WriterProxyData& wdata)
{
    // 遍历所有已发现参与者的所有 Reader
    for (; pit != mp_PDP->ParticipantProxiesEnd(); ++pit)
    {
        for (auto& pair : *(*pit)->m_readers)
        {
            ReaderProxyData* rdatait = pair.second;
            MatchingFailureMask no_match_reason;
            fastdds::dds::PolicyMask incompatible_qos;
            bool valid = valid_matching(&wdata, rdatait,
                                         no_match_reason, incompatible_qos);
            valid = valid && user_valid_matching(*rdatait, wdata); // 用户自定义过滤

            if (valid)
            {
                // ... 安全检查（如启用 security）...
                // 把远端 Reader 登记为本地 Writer 的匹配对象
                // → RTPSWriter 记录 ReaderProxy（locator、期望的可靠性行为等）
                if (writer->matched_reader_add_edp(*rdatait))
                {
                    WriterListener* listener = writer->get_listener();
                    if (nullptr != listener)
                    {
                        MatchingInfo info;
                        info.status = MATCHED_MATCHING;
                        info.remoteEndpointGuid = reader_guid;
                        listener->on_writer_matched(writer, info);
                    }
                }
            }
        }
    }
    return true;
}
```

配对完成后，本地 `RTPSWriter` 知道了远端 Reader 的存在和位置。

RTPS 层的匹配事件经 `InnerDataWriterListener` 转换为 `PublicationMatchedStatus`，触发 `DataWriterListener::on_publication_matched()`。hello_world 里 `matched_` 计数更新、条件变量被唤醒、`publish()` 的等待结束。

Reader 侧完全对称：`pairingReader` 用远端 Writer 的名片做同样的判断，成功后触发 `on_subscription_matched`。

我们通过调用栈来看看 hello_world 示例中 EDP 匹配 Reader 后触发 `PublisherApp::on_publication_matched` 的流程：

```
EDP::pairing_reader_proxy_with_any_local_writer() 收到远端 Reader 的 DATA(r)
  │  反序列化 DATA(r) → ReaderProxyData
  ▼
valid_matching(rdatait)
  │  检查 reader 是否匹配（topic、QoS 等）
  ▼
InnerDataWriterListener::on_writer_matched()
  │  update_publication_matched_status() 更新匹配状态
  ▼
on_publication_matched 回调 → 用户的 DataWriterListener
```


### 端点下线

端点的生命周期绑定在参与者上。SPDP 判定某个远端参与者租约到期离线时，它的 `ParticipantProxyData` 被移除，名下所有端点的名片随之失效，本地与这些端点的配对全部解除，`on_publication_matched`/`on_subscription_matched` 收到 `current_count_change == -1` 的通知。hello_world 的回调里处理过这个分支（"Publisher unmatched"）。


### 无中心仲裁的匹配

端点匹配是双向独立判断的，没有中心节点仲裁。

Writer 端根据收到的 Reader 名片自行判断，Reader 端根据收到的 Writer 名片自行判断，两端执行的是同一套 `valid_matching` 规则，输入是同一份名片数据，所以结论必然一致，不需要第三方确认。

这是去中心化设计的典型设计：把一致性建立在「相同的规则 + 相同的数据」上，而不是建立在协调者上。代价是两端完成配对的时间点可能不同，取决于各自收到名片的时机，所以 DDS 规范允许 matched 计数短暂不对称，最终收敛。


## Discovery Server：从广播到中心化

SIMPLE 模式工作方式：每个参与者向 `metatraffic` 组播地址周期通告自己，同时监听所有其他参与者的通告；每个参与者维护所有远端的 `ParticipantProxyData` 和端点名片；匹配时遍历所有已知端点，`pairingWriter` 里那个对「所有参与者的所有 Reader」的双重循环。

这套机制在小规模网络下可以很好地工作，但开销随节点数增长越来越大：

- **通告流量**。N 个参与者，每个参与者每 3 秒通告一次，每条通告被其余 N-1 个参与者接收处理。总流量与 N² 成正比。
- **内存**。每个参与者保存全量远端信息：N-1 个参与者画像加上网络中所有端点的名片。
- **匹配计算**。端点数量增长后，每次新增端点都要与所有远端端点做一遍 `valid_matching`。

另外还有一个环境限制：SIMPLE 模式依赖组播。跨子网、跨机房、某些云环境和容器网络里，组播要么不可用要么需要额外配置，此时 SIMPLE 模式要靠手工维护 `initialPeersList`，节点多了就失去可管理性。

### Server 模式的角色分工

Discovery Server 的思路是引入一个中心节点，把「所有人广播给所有人」变成「客户端与服务器单播交换」：
- **Server** 持有一个发现数据库（`DiscoveryDataBase`），记录所有注册到它的客户端的参与者和端点信息。客户端的发现数据发给 Server，由 Server 转发给需要这些信息的其他客户端。
- **Client** 只与配置的 Server 通信（单播），不参与组播通告，也不直接监听其他客户端。

`discovery_server` 示例演示了完整的 publisher、subscriber 和 server 的拓扑结构。

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260810104911680.png)

Server 端的配置：

```cpp
// examples/cpp/discovery_server/ServerApp.cpp（精简）
ServerApp::ServerApp(
        const CLIParser::server_config& config)
{
    // 配置参与者为 server，使用自定义传输
    DomainParticipantQos pqos;
    pqos.name("DS-Server");
    pqos.transport().use_builtin_transports = false;

    // 监听地址：Server 必须有一个固定的可达地址
    eprosima::fastdds::rtps::Locator listening_locator;
    eprosima::fastdds::rtps::IPLocator::setPhysicalPort(listening_locator,
                                                        config.listening_port);
    // server 也可以作为 client 连接其他节点
    eprosima::fastdds::rtps::Locator connection_locator;    
    eprosima::fastdds::rtps::IPLocator::setPhysicalPort(connection_locator,
                                                        config.connection_port);

    std::shared_ptr<fastdds::rtps::TransportDescriptorInterface> descriptor;

    switch (config.transport_kind)
    {
        //... 设置协议类型、描述信息和 IP 地址
    }

    // Add descriptor
    pqos.transport().user_transports.push_back(descriptor);

    // 设置 Server 参与者
    pqos.wire_protocol().builtin.discovery_config.discoveryProtocol =
            eprosima::fastdds::rtps::DiscoveryProtocol::SERVER;

    // Set SERVER's listening locator for PDP
    pqos.wire_protocol()
        .builtin.metatrafficUnicastLocatorList
        .push_back(listening_locator);

    if (config.is_also_client)
    {
        // 本机也可作为客户端，把远程服务器地址加到客户端的服务器清单中
        pqos.wire_protocol()
            .builtin.discovery_config.m_DiscoveryServers
            .push_back(connection_locator);
    }

    // 创建 Participant
    participant_ = 
        DomainParticipantFactory::get_instance()->create_participant(0, pqos, this);
}
```

Client 端的配置：

```cpp
// examples/cpp/discovery_server/ClientPublisherApp.cpp（精简）
ClientPublisherApp::ClientPublisherApp(
        const CLIParser::client_publisher_config& config)
{
    // Configure Participant QoS
    DomainParticipantQos pqos;
    pqos.name("DS-Client_pub");
    pqos.transport().use_builtin_transports = false;

    // Create DS locator
    eprosima::fastdds::rtps::Locator server_locator;
    eprosima::fastdds::rtps::IPLocator::setPhysicalPort(server_locator, server_port);
    std::shared_ptr<fastdds::rtps::TransportDescriptorInterface> descriptor;

    switch (config.transport_kind)
    {
        //... 设置协议类型、描述信息和 IP 地址
    }

    // 协议角色：CLIENT
    pqos.wire_protocol().builtin.discovery_config.discoveryProtocol =
            eprosima::fastdds::rtps::DiscoveryProtocol::CLIENT;

    // 添加服务端地址，告诉 Client 去哪里找 Server
    pqos.wire_protocol()
        .builtin.discovery_config.m_DiscoveryServers
        .push_back(server_locator);
    //... 构建参与者
}
```

hello_world 示例中没有设置 `discoveryProtocol`，默认 SIMPLE 模式，靠组播互相发现。而在 discovery_server 示例中显式指定了角色，Client 通过 `m_DiscoveryServers` 列表定位 Server。

`DiscoveryProtocol` 枚举的完整取值：

```cpp
// include/fastdds/rtps/attributes/RTPSParticipantAttributes.hpp
enum class DiscoveryProtocol
{
    NONE,          // 禁用 Discovery
    SIMPLE,        // 默认：组播广播
    CLIENT,        // Discovery Server 客户端
    SERVER,        // Discovery Server 服务端
    BACKUP,        // 可持久化的 Server（故障恢复场景）
    SUPER_CLIENT   // 行为类似 CLIENT，但能像 SIMPLE 一样连接其他端点
};
```

Server 模式不是独立的实现，而是 PDP/EDP 的另一组变体：`PDPClient`/`PDPServer` 替换 `PDPSimple`，`EDPClient`/`EDPServer` 替换 `EDPSimple`，由 `discoveryProtocol` 在创建参与者时配置。

在创建参与者时通过 `create_client_server_participant` 接口分支开始，支持通过环境变量自动配置 Server/Client 角色。


### 中心化的取舍

Server 模式换来三样东西：
- **流量收敛**：客户端不再向全网广播，通告只发给 Server，Server 按需转发；
- **内存收敛**：客户端只保存与自己相关的发现信息；
- **摆脱组播依赖**：Client 到 Server 是普通单播，跨网段部署不再需要组播支持。

代价同样明确。
- Server 成为单点，当 Server 不可达时，新的发现无法完成（已建立的通信不受影响，因为数据路径不经过 Server）。
- 生产部署需要考虑 Server 的高可用，Fast-DDS 支持多 Server 冗余，多个 Server 之间同步各自的 `DiscoveryDataBase`，Client 配置多个 Server 地址，任一可达即可。
- 数据库同步是 Server 模式里最复杂的部分，本系列会单独用一篇文章讲解。
- 此外还有发现路径的延迟：Client 的发现信息要经 Server 中转一跳才能到达对端，比 SIMPLE 模式的直达组播多一跳。

选型粗略来说：单机或少量节点的局域网，SIMPLE 模式最简单；节点数量大、网络不支持组播、或需要控制 Discovery 流量时，Server 模式是标准答案。


## 总结：Discovery 全景

把整篇的机制收拢成一张图。Discovery 是两个阶段、两种模式的组合：

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260810112904597.png)


hello_world 的 `matched_` 条件变量被唤醒，背后是这样一条完整链路：

1. 两个进程启动，`BuiltinProtocols::enable()` 启动各自的 announcer/detector
2. Publisher 和 Subscriber 通过 SPDP 互相发现：初始突发 + 周期通告，对方从陌生名单变成已知的 `ParticipantProxyData`
3. SEDP 交换端点名片：Publisher 的 DataWriter 信息和 Subscriber 的 DataReader 信息到达对端
4. `valid_matching` 四项检查通过：Topic name 相同、类型一致、topic kind 一致、QoS 兼容
5. 双方各自完成配对，`on_publication_matched` 经适配器链传回用户代码，`publish()` 的等待结束

本篇中值得注意的三个设计模式：

**自举**。Discovery 没有独立的收发机制，它就是 RTPS 的第一个应用，builtin 端点用 pub/sub 交换发现数据。可靠性、心跳、重传全部复用，代价是初始化必须注意时序。

**租约**。离线检测不依赖任何显式通知，只依赖「沉默」。每个远端参与者一个独立定时器，通告续期、超期移除。这是分布式活性检测的经典模式，固有代价是检测延迟有下界（一个租约周期）。

**无中心仲裁**。SIMPLE 模式下端点匹配由两端独立判断，一致性建立在「相同规则 + 相同数据」上，不需要协调者。Discovery Server 引入中心节点是为了解决扩展性，但匹配的判断逻辑没有变，Server 只负责转发数据，不做裁决。

配对完成后，Writer 内部的 Reader 列表就位。现在 `write()` 的数据终于有了明确的接收方：序列化后的 payload 从 History 缓存出发，经由传输层发往远端；远端的 Reader 接收、反序列化、放进自己的 History，等待用户 `take()`。下一篇进入数据面，走一遍这条完整的路径，第二篇 `enable()` 里创建的内存池和 History、第三篇的序列化，都会在数据流动中出现。

