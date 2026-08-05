+++
title = "Fast-DDS 源码解析（一）：从 hello_world 到分层架构"
description = "你已经跑通了 HelloWorld，打开 src/cpp/ 看到两个大目录——fastdds/ 和 rtps/，这系列文章帮你建立阅读源码的第一张地图。"
date = "2026-08-03"
aliases = ["DDS"]
author = "ChnjFan"
tags = [
    "DDS",
]
+++

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260803171101125.png)

{{< notice tip >}}
FastDDS 是 OMG DDS 标准的 C++ 实现，也是 ROS 2 默认的中间件。分成 DDS API 层和 RTPS 协议层，两层从头文件到实现目录都是分开的。

打开源码你会发现两个主目录：
- `fastdds/` 是 DDS 层，面向发布-订阅模型，提供 `DomainParticipant`、`DataWriter`、`DataReader` 这些高层实体；
- `rtps/` 是协议层，管理发现、可靠传输、消息编解码和网络通信。

每个 DDS 实体（如 DomainParticipant）对应一个 Impl 类，Impl 再持有底层的 RTPS 对象。从 hello_world 示例的 20 行 API 调用出发，可以追踪到 DDS 层实体创建、RTPS 层参与者初始化和传输层启动，一次调用穿透整个架构。

本系列共 7 篇，按架构分层从顶到底走读源码，每篇都以官方的 example 示例代码为入口，讲解一个具体的模块。
{{< /notice >}}


## 这个系列要做什么

Fast-DDS 的官方文档把 API 用法、QoS 配置和部署指南写得挺全。但如果你设了 `RELIABLE` QoS 数据还是偶尔丢，或者 Discovery 明明互相发现了、端点匹配却慢了好几秒，或者 `write()` 返回 `RETCODE_OK` 而你并不确定数据是不是真到了对端，那文档帮不了太多。它给的是接口契约，不解释代码里实际发生了什么。

这个系列从官方 examples 入手，按架构分层读源码，看每个子系统为什么这样设计、做了哪些取舍。

关于 FastDDS 系列文章的几点说明：
- 不是协议规范讲解。 DDS 和 RTPS 的 OMG 规范加起来超过一千页，这个系列不会逐条翻译规范。涉及协议行为时，只讲与源码实现直接相关的部分，并标注对应的规范章节。
- 不是 API 教程。 假设你已经知道 DomainParticipant、DataWriter、DataReader 是什么，能跑通基本的 pub/sub。如果还没用过 Fast-DDS，建议先跟一遍官方的 [Hello World 示例](https://fast-dds.docs.eprosima.com/en/latest/fastdds/getting_started/simple_app/simple_app.html)。
- 每篇从一个可运行的 example 开始。 先建立可观察行为，再带着"这背后怎么实现的"进入源码。所有代码引用基于当前 v3.x 版本，文中会标注具体文件路径。

本系列共 7 篇，按架构分层组织：

| 篇 | 主题 | 对应代码区域 |
|---|---|---|
| 一 | 架构总览与代码地图（本篇） | 顶层结构 |
| 二 | 实体模型与生命周期 | `fastdds/domain/`, `fastdds/publisher/`, `fastdds/subscriber/` |
| 三 | 类型系统与序列化 | `fastdds/xtypes/`, Fast-CDR |
| 四 | Discovery：从陌生到匹配 | `rtps/builtin/` |
| 五 | 数据读写全路径 | `rtps/writer/`, `rtps/reader/`, `rtps/history/` |
| 六 | 传输层与 Data Sharing | `rtps/transport/`, `rtps/DataSharing/` |
| 七 | QoS 体系与流控 | `fastdds/core/policy/`, `rtps/flowcontrol/` |

顺序阅读体验最佳，但每篇独立成文，可以按兴趣跳读。

## 先跑起来：hello_world 示例

在读源码之前，先看看代码跑起来是什么样。我们从 `examples/cpp/hello_world` 开始：一个 Publisher 周期性发送 HelloWorld 消息，一个 Subscriber 接收并打印。

### 数据类型：从 IDL 生成 C++ 代码

Fast-DDS 的数据类型用 IDL（Interface Definition Language）定义。hello_world 的 IDL 只有四行：

```idl
// examples/cpp/hello_world/HelloWorld.idl
@extensibility(APPENDABLE)
struct HelloWorld
{
    unsigned long index;
    string message;
};
```

`@extensibility(APPENDABLE)` 是 XTypes 规范中的注解，表示这个类型允许在后续版本中追加字段而不破坏兼容性。这个注解会影响序列化时的编码方式，我们在第三篇讲类型系统时展开。

IDL 文件通过 `fastddsgen` 工具生成 C++ 代码。生成的 `HelloWorld.hpp` 是一个普通的 C++ 类：

```cpp
class HelloWorld
{
public:
    void index(uint32_t _index)  { m_index = _index; }
    uint32_t index() const       { return m_index; }

    void message(const std::string& _message) { m_message = _message; }
    const std::string& message() const        { return m_message; }

private:
    uint32_t m_index{0};
    std::string m_message;
};
```

`HelloWorld` 没有继承任何基类，没有虚函数，就是一个带 getter/setter 的数据容器。序列化逻辑不在这个文件里，而是在配套的 `HelloWorldCdrAux.ipp` 和 `HelloWorldPubSubTypes.hpp` 中，由代码生成工具产出。数据类型本身不依赖 Fast-DDS，序列化适配是单独的一层。

### 发布端创建实体

打开 `PublisherApp.cpp`，构造函数里是 Fast-DDS 创建实体的典型流程：

```cpp
// examples/cpp/hello_world/PublisherApp.cpp 精简构造函数
PublisherApp::PublisherApp(
        const CLIParser::publisher_config& config,
        const std::string& topic_name)
{
    // 1. 创建 participant
    auto factory = DomainParticipantFactory::get_instance();
    participant_ = factory->create_participant_with_default_profile(
                                        nullptr,
                                        StatusMask::none());

    // 2. 注册数据类型
    type_.register_type(participant_);

    // 3. 创建 Publisher
    PublisherQos pub_qos = PUBLISHER_QOS_DEFAULT;
    participant_->get_default_publisher_qos(pub_qos);
    publisher_ = participant_->create_publisher(pub_qos, nullptr,
                                    StatusMask::none());

    // 4. 创建 Topic
    TopicQos topic_qos = TOPIC_QOS_DEFAULT;
    participant_->get_default_topic_qos(topic_qos);
    topic_ = participant_->create_topic(topic_name,
                                        type_.get_type_name(),
                                        topic_qos);

    // 5. 创建 DataWriter
    DataWriterQos writer_qos = DATAWRITER_QOS_DEFAULT;
    writer_qos.history().depth = 5;
    publisher_->get_default_datawriter_qos(writer_qos);
    writer_ = publisher_->create_datawriter(topic_,
                                             writer_qos, this,
                                             StatusMask::all());
}
```

五步对应的实体层级关系是：

```
DomainParticipantFactory（全局单例）
 └── DomainParticipant（一个进程通常一个）
      ├── Topic（定义"传什么"）
      └── Publisher（定义"谁发"）
           └── DataWriter（绑定 Topic + Publisher，真正写数据）
```

注意几个细节：

每个实体创建前都先调 `get_default_xxx_qos()` 拿默认值，再按需修改。这里只改了一项：`writer_qos.history().depth = 5`，把 History 缓存深度从默认的 1 改成 5。默认值从哪来、QoS 怎么层层继承，我们在第二篇详细讲解。

再看 Listener 和 StatusMask 的传参。`create_datawriter` 的第三个参数 `this` 表示 `PublisherApp` 自己充当 Listener，第四个参数 `StatusMask::all()` 表示订阅所有状态变化。而 `create_participant` 和 `create_publisher` 传的是 `nullptr` 和 `StatusMask::none()`，不关心这些实体的状态回调。只在真正需要响应事件的实体上挂 Listener。

还有 `create_participant_with_default_profile` 这个方法名，说明 Fast-DDS 支持通过 XML 配置文件设定默认行为。示例目录下有一个 `hello_world_profile.xml`，可以通过环境变量 `FASTDDS_DEFAULT_PROFILES_FILE` 加载。XML 配置解析是 `xmlparser` 模块的工作，本系列不单独展开，后续涉及 QoS 时会提到。

### 数据发布：write() 之前和之后

实体创建完毕后，Publisher 进入发送循环：

```cpp
bool PublisherApp::publish()
{
    // 等待至少一个 Subscriber 匹配
    std::unique_lock<std::mutex> matched_lock(mutex_);
    cv_.wait(matched_lock, [&]() {
        return ((matched_ >= expected_matches_) || is_stopped());
    });

    if (!is_stopped()) {
        hello_.index(hello_.index() + 1);
        ret = (RETCODE_OK == writer_->write(&hello_));
    }
    return ret;
}
```

`writer_->write(&hello_)` 是整个 Publisher 最核心的一行。它接收一个 `void*`，指向要发送的数据对象。调用之后，Fast-DDS 内部会依次经过序列化、写入 History 缓存、根据 QoS 决定是否立即发送、选择传输通道、构造 RTPS 报文、交给操作系统网络栈。这条路径在第五篇「数据读写全路径」中会详细介绍。

在 `write()` 之前，代码用条件变量等待 `matched_ >= expected_matches_`。`matched_` 在 `on_publication_matched` 回调中更新：

```cpp
void PublisherApp::on_publication_matched(
        DataWriter* /*writer*/,
        const PublicationMatchedStatus& info)
{
    if (info.current_count_change == 1) {
        matched_ = static_cast<int16_t>(info.current_count);
        cv_.notify_one();   // 唤醒发送循环
    } else if (info.current_count_change == -1) {
        matched_ = static_cast<int16_t>(info.current_count);
    }
}
```

当订阅端的 `DataReader` 和发布端 `DataWriter` 完成端点匹配后，Fast-DDS 的 Discovery 机制会触发这个回调，至于怎么完成端点匹配和触发回调，我们在第四篇「Discovery：从陌生到匹配」中介绍。

### 订阅端接收数据：不同的数据流向

Subscriber 的实体创建与 Publisher 完全对称，只是把 `Publisher` 换成 `Subscriber`，`DataWriter` 换成 `DataReader`：

```cpp
// ListenerSubscriberApp.cpp（构造函数，精简）
auto factory = DomainParticipantFactory::get_instance();
participant_ = factory->create_participant_with_default_profile(
    nullptr, StatusMask::none());
type_.register_type(participant_);

subscriber_ = participant_->create_subscriber(sub_qos,
                 nullptr,
                 StatusMask::none());
topic_ = participant_->create_topic(topic_name,
            type_.get_type_name(),
            topic_qos);
reader_ = subscriber_->create_datareader(topic_,
             reader_qos, this, StatusMask::all());
```

数据接收通过 `on_data_available` 回调完成：

```cpp
void ListenerSubscriberApp::on_data_available(DataReader* reader)
{
    SampleInfo info;
    while ((!is_stopped()) 
        && (RETCODE_OK == reader->take_next_sample(&hello_, &info)))
    {
        if ((info.instance_state == ALIVE_INSTANCE_STATE) && info.valid_data)
        {
            received_samples_++;
            std::cout << "Message: '" << hello_.message()
                      << "' with index: '" << hello_.index()
                      << "' RECEIVED" << std::endl;
        }
    }
}
```

`take_next_sample()` 和 `write()` 的数据方向相反：它从 `DataReader` 的 History 缓存中取出下一条数据，反序列化到用户提供的对象中。`SampleInfo` 携带元信息，包括实例状态、时间戳、来源 GUID 等。

`take_next_sample` 取走后数据从缓存中移除；还有一个 `read` 接口则是读走数据但保留缓存。

缓存行为通过 History QoS 控制。


## 提出问题：create_participant() 之后发生了什么

上一节我们看到，hello_world 的 `Publisher` 和 `Subscriber` 都以同一行代码开始：

```cpp
participant_ = factory->create_participant_with_default_profile(nullptr,
                    StatusMask::none());
```

这行代码返回一个 `DomainParticipant*`，看起来只是 `new` 了一个对象。但实际上，它触发了一整条跨层调用链，最终在 RTPS 层创建了一个网络参与者、分配了 GUID、初始化了传输通道。接下来我们来追踪这条链。

### Factory 创建 DDS 层对象

`create_participant_with_default_profile` 内部调用了工厂函数来创建：

```cpp
// src/cpp/fastdds/domain/DomainParticipantFactory.cpp
DomainParticipant* DomainParticipantFactory::create_participant(
        DomainId_t did,
        const DomainParticipantQos& qos,
        DomainParticipantListener* listener,
        const StatusMask& mask)
{
    load_profiles();  // 加载 XML 配置文件（如果有的话）

    // ... 解析 qos 得到 pqos（传入 PARTICIPANT_QOS_DEFAULT 时用 Factory 默认值）...

    DomainParticipant* dom_part = new DomainParticipant(mask);
    DomainParticipantImpl* dom_part_impl =
        new DomainParticipantImpl(dom_part, did, pqos, listener);

    // ... 注册到 Factory 的内部 map ...

    if (factory_qos_.entity_factory().autoenable_created_entities)
    {
        dom_part->enable();  // 关键：触发 RTPS 层创建
    }

    return dom_part;
}
```

到这里，我们看到创建了两个对象：

- `DomainParticipant` 是用户拿到的公共 API 对象。继承自 `Entity`，提供 QoS 管理、StatusMask、StatusCondition。
- `DomainParticipantImpl` 是实现对象，用户看不到，持有所有内部状态，是真正干活的类。

注意 `autoenable_created_entities` 条件控制 `enable` 的时机。DDS 规范允许"先创建、后启用"的两阶段模式，你可以先创建一批实体，配置好之后再统一 enable。默认情况下 autoenable 为 true，所以 `enable()` 会立即被调用。

### enable() 跨越 DDS/RTPS 边界

`DomainParticipant::enable()` 委托给 `DomainParticipantImpl::enable()`，这是整个调用链中最关键的一跳：

```cpp
// src/cpp/fastdds/domain/DomainParticipantImpl.cpp
ReturnCode_t DomainParticipantImpl::enable()
{
    assert(get_rtps_participant() == nullptr);  // 确保只 enable 一次

    // 1. 将 DDS 层 QoS 转换为 RTPS 层属性
    fastdds::rtps::RTPSParticipantAttributes rtps_attr;
    utils::set_attributes_from_qos(rtps_attr, qos_);
    rtps_attr.participantID = participant_id_;

    // 2. 调用 RTPS 层，创建 RTPSParticipant
    RTPSParticipant* part = RTPSDomain::createParticipant(
        domain_id_,
        false,              // enabled = false，稍后手动 enable
        rtps_attr,
        &rtps_listener_);   // DDS 层注册的 RTPS 事件监听器

    // 3. 保存 RTPS 对象指针，建立桥接
    rtps_participant_ = part;
    guid_ = part->getGuid();    // DDS 层实体标识（InstanceHandle）直接来自 RTPS GUID
    handle_ = guid_;

    // 4. 级联 enable 已创建的 Topic、Publisher、Subscriber
    // ...
    // 5. 启用 RTPS 参与者（启动 Discovery 等）
    part->enable();
    return RETCODE_OK;
}
```

DDS 层的 QoS 是面向应用开发者，而 RTPS 层的属性 `RTPSParticipantAttributes` 则是面向协议行为。这两套类型面向不同的抽象层级，通过 `enable` 将 DDS 层和 RTPS 层连接起来。

`rtps_listener_` 监听器是 `DomainParticipantImpl` 内部类 `MyRTPSParticipantListener` 的实例，实现了 RTPS 层的 `RTPSParticipantListener` 接口。
当 RTPS 层发现了新参与者、完成了认证、或者检测到参与者离线时，回调通过这个监听器传回 DDS 层，再转发给用户的 `DomainParticipantListener`。RTPS 层不知道 DDS 层的存在，DDS 层通过这个适配器接收 RTPS 事件。

`RTPSDomain::createParticipant` 的第二个参数传了 false，说明了 `RTPSParticipant` 支持两阶段启动。等 DDS 层把 Topic、Publisher、Subscriber 都级联 enable 之后，最后才调 `part->enable()` 启动 RTPS 参与者。这样 Discovery 报文发出去时，本地的端点已经就绪。


### RTPS 层创建参与者

`RTPSDomain::createParticipant` 是一个静态入口，它先尝试 Discovery Server 的自动配置，失败就走通用路径：

```cpp
// src/cpp/rtps/domain/RTPSDomain.cpp
RTPSParticipant* RTPSDomain::createParticipant(
        uint32_t domain_id,
        bool enabled,
        const RTPSParticipantAttributes& attrs,
        RTPSParticipantListener* listen)
{
    // 尝试 Discovery Server 自动配置
    RTPSParticipant* part = create_client_server_participant(domain_id, enabled,
                                                             attrs, listen);

    if (!part) {   // 通用路径
        part = RTPSDomainImpl::get_instance()->create_participant(domain_id, enabled,
                                                                attrs, listen);
    }

    return part;
}
```

`RTPSDomainImpl::create_participant` 才是真正创建 RTPS 参与者的地方。

```cpp
// src/cpp/rtps/domain/RTPSDomain.cpp（RTPSDomainImpl::create_participant，精简）
RTPSParticipant* RTPSDomainImpl::create_participant(
        uint32_t domain_id,
        bool enabled,
        const RTPSParticipantAttributes& attrs,
        RTPSParticipantListener* listen)
{
    // 1. 分配参与者 ID
    if (!prepare_participant_id(PParam.participantID, ID))
    {
        return nullptr;
    }

    // 2. 生成 GUID 前缀
    GuidPrefix_t guidP;
    guid_prefix_create(get_id_for_prefix(ID), guidP);

    // 3. 创建对外接口对象 RTPSParticipant 和内部实现 RTPSParticipantImpl
    RTPSParticipant* p = new RTPSParticipant(nullptr);
    RTPSParticipantImpl* pimpl = nullptr;
    pimpl = new RTPSParticipantImplType(domain_id, PParam, PParam.prefix,
                                         guidP, p, listen);

    // 4. 检查初始化是否成功（包括网络资源分配）
    if (!pimpl->is_initialized())
    {
        delete pimpl;
        return nullptr;
    }
}
```

其中 `RTPSParticipantImplType` 的构造函数是整条链路中最重要的操作，它在内部完成了：
- **网络资源初始化**：创建发送通道，根据配置绑定 UDP/TCP 端口
- **GUID 生成**：128 位全局唯一标识，前缀标识参与者，后缀标识端点
- **History 和缓存初始化**：为 builtin 端点（SPDP、SEDP）准备数据结构
- **线程资源分配**：事件线程、监听线程的创建

具体的创建细节我们在第四篇「Discovery：从陌生到匹配」和第六篇「传输层与 Data Sharing」详细展开。这里只需要记住：`RTPSParticipantImpl` 的构造完成时，这个进程在 RTPS 网络中已经"存在"了，它有了身份（GUID）、有了通信能力（传输通道），执行 `enable()` 后就开始广播自己的存在。

### 完整的构建调用链

将 `create_participant` 构建调用链完整地串联起来：

```
用户代码
  factory->create_participant_with_default_profile()
    │
    ▼
DDS 层 ── DomainParticipantFactory::create_participant()
    │       new DomainParticipant()          ← 公共 API 壳
    │       new DomainParticipantImpl()      ← 实现对象
    │       dom_part->enable()
    │         │
    │         ▼
    │       DomainParticipantImpl::enable()
    │         set_attributes_from_qos()      ← QoS 翻译
    │         RTPSDomain::createParticipant()
    │         rtps_participant_ = part       ← 建立桥接
    │         part->enable()                 ← 启动 Discovery
    │
    ▼
RTPS 层 ── RTPSDomainImpl::create_participant()
              new RTPSParticipant()          ← RTPS 公共壳
              new RTPSParticipantImpl()      ← RTPS 实现
                ├── GUID 生成
                ├── 传输通道初始化
                ├── builtin 端点创建
                └── 线程资源分配
```

追踪完构造链路，你可能会问：为什么不直接在 `DomainParticipant` 里全部构造完？

因为 DDS 和 RTPS 是两个独立的 OMG 规范，解决不同的问题。
- DDS 规范定义应用开发者看到的编程模型：实体层级、QoS 策略、Listener 模式、数据读写 API。它不关心数据在网络上怎么传输。
- RTPS 规范定义线上协议：报文格式、Discovery 协议、可靠性机制、心跳和确认。它不关心用户用什么编程语言、怎么组织代码。

Fast-DDS 的代码结构对应了这个分离。DDS 层在 `src/cpp/fastdds/`，RTPS 层在 `src/cpp/rtps/`，两层通过 Impl 类中的指针（如 `rtps_participant_`）和适配器（如 `MyRTPSParticipantListener`）连接。

这个分层有一个实际好处：**RTPS 层可以独立使用**。

如果你不需要 DDS 的实体模型和 QoS 体系，可以直接用 `RTPSDomain::createParticipant()` 和 `RTPSWriter`/`RTPSReader` 操作 RTPS 协议。`examples/cpp/rtps/` 目录下就有这样的示例。DDS 层是 RTPS 层之上的封装，不是唯一的入口。

### 一个值得记住的模式：Impl

这条调用链里出现了 Fast-DDS 中反复使用的组织模式：

```
Public 类（用户可见）→ Impl 类（内部实现）→ 下一层的对象
```

`DomainParticipant` → `DomainParticipantImpl` → `RTPSParticipant`

这个模式贯穿整个代码库，后面读任何一个子系统，都可以用同样的方式定位用户 API、实现类和底层 RTPS 对象。

现在我们知道代码跨了哪些层，接下来看这些代码放在仓库的哪个位置。25 万行的代码库，该从哪里看起？


## 代码地图：顶层目录结构

Fast-DDS 的实现代码约 25 万行（src/cpp/，不含测试和生成代码）。但目录组织直接对应了架构分层，知道哪一层在哪个目录，25 万行就变成了几个可以分别读的区块。

### 顶层目录

```
Fast-DDS/
├── include/fastdds/       # 公共头文件（用户可见的 API）
│   ├── dds/               #   DDS API 层
│   ├── rtps/              #   RTPS 协议层
│   ├── statistics/        #   统计监控
│   └── utils/             #   工具类
│
├── src/cpp/               # 实现代码（~248K 行）
│   ├── fastdds/           #   DDS API 层实现（~76K 行）
│   ├── rtps/              #   RTPS 协议层实现（~90K 行）
│   ├── security/          #   DDS Security 插件
│   ├── statistics/        #   统计监控实现
│   ├── utils/             #   共享工具（线程、共享内存、集合）
│   └── xmlparser/         #   XML 配置解析
│
├── examples/cpp/          # 官方示例（本系列的入口）
├── test/                  # 测试
│   ├── unittest/          #   单元测试
│   ├── blackbox/          #   黑盒集成测试
│   ├── performance/       #   性能测试
│   └── dds/               #   DDS 层专项测试
│
├── tools/                 # 命令行工具
│   ├── fastdds/           #   fastdds CLI（discovery、shm 等）
│   └── fds/               #   Fast DDS Server
│
├── thirdparty/            # 第三方依赖（asio、tinyxml2、fastcdr 等）
├── cmake/                 # 构建脚本
└── fuzz/                  # Fuzzing 测试
```

`include/fastdds/` 和 `src/cpp/` 的内部结构都按 `dds/` 和 `rtps/` 两层协议分层。

DDS 层是面向用户的 API 封装，RTPS 层是协议行为的实现，后者有更多的状态机、定时器、报文处理和网络 I/O，因此库中大部分的代码在 RTPS 层。

### 公共头文件：用户看到什么

`include/fastdds/dds/` 是 DDS API 层的公共头文件。打开它，目录名就是 DDS 规范的实体模型：

```
include/fastdds/dds/
├── core/          # Entity 基类、ReturnCode、StatusMask、QoS 策略基类
├── domain/        # DomainParticipant、DomainParticipantFactory、DomainParticipantQos
├── publisher/     # Publisher、DataWriter、DataWriterQos、DataWriterListener
├── subscriber/    # Subscriber、DataReader、DataReaderQos、SampleInfo
├── topic/         # Topic、TypeSupport、ContentFilteredTopic
├── builtin/       # Builtin Topic 数据类型（ParticipantBuiltinTopicData 等）
├── rpc/           # Requester/Replier（DDS-RPC）
├── xtypes/        # Dynamic Types（动态类型支持）
└── log/           # 日志
```

`include/fastdds/rtps/` 是 RTPS 协议层的公共头文件。注意它的子目录命名与 DDS 层不同——它按 RTPS 协议的功能模块组织：

```
include/fastdds/rtps/
├── participant/   # RTPSParticipant、RTPSParticipantListener
├── writer/        # RTPSWriter 接口
├── reader/        # RTPSReader 接口
├── history/       # History 缓存接口
├── common/        # 基础类型（Guid、Locator、CacheChange、CDRMessage_t）
├── attributes/    # RTPS 层属性结构（RTPSParticipantAttributes、WriterAttributes）
├── builtin/       # Builtin 协议（Discovery 相关）
├── messages/      # RTPS 消息定义
├── transport/     # TransportInterface 抽象
├── flowcontrol/   # 流控接口
└── interfaces/    # 跨层接口定义
```

RTPS 层的头文件也是公共 API。用户可以绕过 DDS 实体模型，直接操作 `RTPSParticipant`、`RTPSWriter`、`RTPSReader`，`examples/cpp/rtps/` 目录下就有这样的示例。

所以 RTPS 层的头文件必须保持 API 稳定性，不能随意改动。


### 实现代码：两层各自的内部结构

`src/cpp/fastdds/` 是 DDS 层的实现。它的子目录与 `include/fastdds/dds/` 基本对应：

```
src/cpp/fastdds/
├── domain/        # DomainParticipantImpl、DomainParticipantFactory 实现
├── publisher/     # PublisherImpl、DataWriterImpl、DataWriterHistory
├── subscriber/    # SubscriberImpl、DataReaderImpl、DataReaderHistory
├── topic/         # TopicProxyFactory、ContentFilter、DDSSQLFilter
├── core/          # Entity、QoS 策略实现、Condition、WaitSet
├── builtin/       # TypeLookupService 等 builtin 功能的 DDS 层封装
├── xtypes/        # Dynamic Types 实现
├── rpc/           # DDS-RPC 实现
├── log/           # 日志实现
└── utils/         # DDS 层工具
```

`src/cpp/rtps/` 是 RTPS 层的实现，也是代码量最大的部分：

```
src/cpp/rtps/
├── participant/   # RTPSParticipantImpl（最重的类之一）
├── writer/        # StatefulWriter、StatelessWriter 等 Writer 实现
├── reader/        # StatefulReader、StatelessReader 等 Reader 实现
├── history/       # WriterHistory、ReaderHistory、TopicPayloadPool
├── builtin/       # SPDP、SEDP、WLP（Discovery 协议实现）
├── messages/      # RTPS 报文构造与解析（CDRMessage）
├── transport/     # UDP、TCP、SharedMemory 传输实现
├── DataSharing/   # Data Sharing（零拷贝）实现
├── flowcontrol/   # 流控实现
├── network/       # 网络发送/接收资源
├── common/        # 基础类型实现
├── attributes/    # 属性结构实现
├── domain/        # RTPSDomain、RTPSDomainImpl（RTPS 层工厂）
├── persistence/   # 持久化（Durability TRANSIENT）
├── resources/     # 资源管理（事件线程等）
├── security/      # RTPS 层安全接口
└── exceptions/    # 异常定义
```

### 横切模块

有几个模块横跨 DDS 层和 RTPS 层：

`src/cpp/security/` 实现 DDS Security 规范，包括认证（authentication）、访问控制（accesscontrol）、加密（cryptography）和安全日志（logging）。它以插件形式挂载，DDS 层通过 QoS 配置启用，RTPS 层在报文中执行加密和签名。

`src/cpp/statistics/` 实现 Fast-DDS 的运行时统计和监控。它同时有 DDS 层和 RTPS 层的子目录（`statistics/fastdds/` 和 `statistics/rtps/`），因为统计数据从 RTPS 层采集，通过 DDS 层发布。编译时需要开启 `FASTDDS_STATISTICS` 宏。

`src/cpp/xmlparser/` 解析 XML 配置文件，将配置映射到 DDS 层的 QoS 结构。它只与 DDS 层交互，不接触 RTPS 层。


### 阅读建议

如果你刚开始读 Fast-DDS 源码，可以从 `include/fastdds/dds/` 开始，这里是你作为用户接触到的所有 API。每个头文件都有完整的类注释和 Doxygen 文档。

1. 通过 API 找到对应的 Impl 类，它在 `src/cpp/fastdds/` 的同名子目录下。比如 `include/fastdds/dds/domain/DomainParticipant.hpp` 对应 `src/cpp/fastdds/domain/DomainParticipantImpl.hpp`。
2. 顺着 Impl 类中的 RTPS 指针，跳到 `include/fastdds/rtps/` 和 `src/cpp/rtps/`。比如 `DomainParticipantImpl` 持有 `rtps_participant_`，类型是 `RTPSParticipant*`。
3. 从 example 的 API 调用出发追踪，比漫无目的地浏览目录高效得多。

下一节，我们把代码目录和第三节的调用链结合起来，正式讨论 Fast-DDS 的两层架构设计。


## 核心设计：DDS/RTPS 两层架构

上一节看到了代码地图中最明显的结构：无论头文件还是实现，都分成 `dds/` 和 `rtps/`。这一节解释为什么这样分。这个分层来自两个 OMG 规范的分工，不只是代码组织习惯。

### 两个独立的协议标准

Fast-DDS 实现了两个相互独立的 OMG 标准。

**DDS**（Data Distribution Service）定义应用开发者看到的编程模型：实体层级（Participant → Publisher/Subscriber → Writer/Reader）、Topic 抽象、二十多种 QoS 策略、Listener/WaitSet 事件模型、`write()`/`take()` 数据操作。它解决的问题是"用户用什么 API、以什么语义收发数据"。

**RTPS**（Real-Time Publish-Subscribe）定义线上协议：报文格式（DATA、HEARTBEAT、ACKNACK、SPDP、SEDP 等子消息类型）、无中心 Discovery 协议、可靠性握手、心跳与租约机制。它解决的问题是"数据在网络上以什么格式、什么时序传输，节点如何互相发现"。

两个规范各自独立演进，中间只通过一个约定衔接：DDS 规范声明"DDS 实现应使用 RTPS 作为默认线协议"，RTPS 规范不关心上层用什么 API。这个分工映射到代码上，就是 `dds/` 和 `rtps/` 两个目录。

DDS 层和 RTPS 层的实体存在清晰的对应关系：

| DDS 层（面向应用） | RTPS 层（面向协议） | 关系 |
|---|---|---|
| `DomainParticipant` | `RTPSParticipant` | 1:1，DDS Participant 持有 RTPS Participant |
| `Publisher` + `DataWriter` | `RTPSWriter` | DataWriter 对应一个 RTPSWriter；Publisher 在 RTPS 层没有对应物 |
| `Subscriber` + `DataReader` | `RTPSReader` | DataReader 对应一个 RTPSReader；Subscriber 在 RTPS 层没有对应物 |
| `Topic` | `TopicDescription` | Topic 的 name/type_name 在 RTPS 层退化为一个描述结构 |
| `DataWriterQos` / `DataReaderQos` | `WriterQos` / `ReaderQos` + `WriterAttributes` / `ReaderAttributes` | QoS 拆分为"匹配信息"和"行为配置" |

`Publisher` 和 `Subscriber` 在 RTPS 层没有对应物。这两个实体是 DDS 规范为了分组管理引入的，一个 `Publisher` 管多个 `DataWriter`，协议层不需要它们。DDS 层的实体模型服务于编程便利，RTPS 层只保留协议必需的概念。

两层的基类也不同：

```cpp
// DDS 层基类：Entity
// include/fastdds/dds/core/Entity.hpp
class Entity
{
    StatusMask status_mask_;        // 订阅哪些状态变化
    StatusCondition status_condition_;  // WaitSet 集成
    bool enable_;                   // 两阶段启用
};

// RTPS 层基类：Endpoint
// include/fastdds/rtps/Endpoint.hpp
class Endpoint
{
    RTPSParticipantImpl* mp_RTPSParticipant;  // 所属参与者
    const GUID_t m_guid;            // 全局唯一标识
    EndpointAttributes m_att;       // 端点属性，含单播/组播地址列表
    // ...
};
```

`Entity` 关心的是"用户怎么感知这个对象的状态"，`Endpoint` 关心的是「这个对象在网络上是什么、在哪里」。

### 独立使用 RTPS 层

`include/fastdds/rtps/` 下的头文件也是 Fast-DDS 的公共 API。RTPS 层不是 DDS 层的私有实现细节，它可以独立使用。

`examples/cpp/rtps/` 目录下的示例就绕过了 DDS 实体模型，直接操作 RTPS API：

```cpp
// examples/cpp/rtps/WriterApp.cpp（精简）
WriterApp::WriterApp(
        const CLIParser::rtps_config& config,
        const std::string& topic_name)
{
    // 1. 直接创建 RTPS Participant
    RTPSParticipantAttributes part_attr;
    part_attr.builtin.discovery_config.discoveryProtocol = DiscoveryProtocol::SIMPLE;
    rtps_participant_ = RTPSDomain::createParticipant(0, part_attr);

    // 2. 手动创建 History（DDS 层会自动创建，这里要自己管）
    HistoryAttributes hatt;
    hatt.payloadMaxSize = 255;
    writer_history_ = new WriterHistory(hatt);

    // 3. 直接创建 RTPS Writer
    WriterAttributes writer_att;
    writer_att.endpoint.reliabilityKind = RELIABLE;
    writer_att.endpoint.durabilityKind = TRANSIENT_LOCAL;
    rtps_writer_ = RTPSDomain::createRTPSWriter(
        rtps_participant_, writer_att, writer_history_, this);

    // 4. 手动注册端点以参与 Discovery
    TopicDescription topic_desc;
    topic_desc.type_name = "HelloWorld";
    topic_desc.topic_name = topic_name;
    rtps_participant_->register_writer(rtps_writer_, topic_desc, writer_qos);
}
```

对比 hello_world 示例，差异很明显：

- DDS 层用户调 `publisher->create_datawriter(topic, qos)` 完成。
- RTPS 层用户要自己创建 History、自己指定 Attributes、自己调 `register_writer` 注册端点参与 Discovery，甚至自己写序列化代码（示例中手写了 `fastcdr::serialize<HelloWorld>` 特化）。

RTPS API 给了更细粒度的控制，代价是更多的手动管理。大多数应用场景不需要这一层，但它的存在说明 DDS 层是 RTPS 层之上的便利封装，不是唯一入口。这也意味着读源码时不能假设 RTPS 层的代码只被 DDS 层调用，它必须作为独立组件自洽。


### 分层带来了什么

回到最初的问题：为什么不把所有代码放在一起？

1. DDS 层和 RTPS 层可以各自演进。Dynamic Types（`fastdds/xtypes/`）和 DDS-RPC（`fastdds/rpc/`）完全在 DDS 层实现，RTPS 层对此无感知。反过来，RTPS 层新增传输方式（如 Data Sharing）或优化 Discovery 协议时，DDS 层的 API 签名不需要变化。
2. 两层之间靠 QoS 翻译衔接。`DomainParticipantImpl::enable()` 中的 `utils::set_attributes_from_qos()` 把 DDS QoS 转换为 RTPS Attributes。这个翻译函数就是两层的契约边界，DDS 层承诺用户设置的 QoS 会被正确翻译，RTPS 层承诺收到的 Attributes 会被执行。bug 排查也可以沿这条边界切分：如果行为不符合 QoS 预期，先看翻译是否正确，再看 RTPS 层是否正确执行。
3. `test/` 目录的组织也反映了这个分层：`test/dds/` 测试 DDS 层行为，`test/unittest/rtps/` 测试 RTPS 层组件，`test/blackbox/` 做端到端集成。两层可以各自独立测试，不需要总是启动完整的 pub/sub 链路。

有两类模块横跨两层，读代码时需要注意：

`src/cpp/statistics/` 同时有 `fastdds/` 和 `rtps/` 子目录，统计数据（消息计数、延迟、心跳次数等）在 RTPS 层采集，通过 DDS 层的特殊 Topic 发布出来，供外部监控工具订阅。编译时通过 `FASTDDS_STATISTICS` 宏控制，开启后 `DomainParticipantImpl` 会被替换为 `statistics::dds::DomainParticipantImpl`。

`src/cpp/security/` 实现 DDS Security 规范，DDS 层通过 `DomainParticipantQos` 中的 Security QoS 配置启用安全插件，RTPS 层在报文发送前执行加密和签名、接收后执行解密和验证。安全逻辑需要同时接触两层的对象，所以它不属于任何一层。

这两个模块是分层中的例外，但都是 RTPS 层产生数据或执行操作，DDS 层负责配置和暴露。


### 架构全景

把前几节的信息汇总，Fast-DDS 的分层架构能清晰表达：

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260803123037540.png)

从用户代码到网络，经过四个抽象层级。每一层只与相邻层交互：DDS 公共类不知道 Transport 的存在，RTPS 层不知道 Publisher 的存在。

现在我们知道两层是什么、为什么分开、在代码中怎么组织。接下来看两层之间的连接具体怎么实现：`DomainParticipantImpl` 里的 `rtps_participant_` 指针怎么建立，事件怎么跨层回传，这个模式在 `DataWriter`/`DataReader` 层是否一致。


## Impl 模式与 DDS 到 RTPS 的连接

前面我们追踪了 `create_participant()` 的调用链，看到 `DomainParticipantImpl` 持有 `RTPSParticipant*`，通过 `MyRTPSParticipantListener` 接收 RTPS 事件。这个模式不只是 Participant 的设计，Fast-DDS 中每一个 DDS 实体都这样组织。这一节把整个模式展开，后面走读源码时会反复用到。

### 三层对象：Public、Impl、RTPS

Fast-DDS 中的每个 DDS 实体由三个对象组成：

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260803160013961.png)

以 `DataWriter` 为例。

```cpp
// include/fastdds/dds/publisher/DataWriter.hpp
class DataWriter : public DomainEntity
{
    // ... 公共方法声明 ...
private:
    DataWriterImpl* impl_;   // 所有工作都委托给它
};

// src/cpp/fastdds/publisher/DataWriter.cpp
ReturnCode_t DataWriter::write(const void* const data)
{
    return impl_->write(data);
}
```

公共类 `DataWriter` 的 `write()` 方法体只有一行，所有的实现都委托给 `DataWriterImpl`。

```cpp
// src/cpp/fastdds/publisher/DataWriterImpl.hpp（关键成员）
class DataWriterImpl
{
    // RTPS 层的 Writer（通过 PublisherImpl 创建时注入）
    fastdds::rtps::RTPSWriter* rtps_writer_;
    // DDS 层的 History 封装（包装 RTPS WriterHistory）
    std::unique_ptr<DataWriterHistory> history_;
    // 用户注册的 Listener
    DataWriterListener* listener_ = nullptr;
    // RTPS 事件适配器（内部类实例）
    InnerDataWriterListener writer_listener_;
    // QoS、定时器、状态计数器 ...
};
```

### 为什么要加一层 Impl

直接在 Public 类里写逻辑不行吗？这个分离解决的是 API 稳定性问题。

`include/fastdds/dds/` 下的头文件是公共 API，一旦发布就不能随意改动，改动类的成员变量会破坏 ABI（Application Binary Interface），导致用户重新编译甚至重新链接。但实现细节需要频繁演进：加一个缓存、改一个定时器策略、调整一个锁的粒度。

Impl 类把不稳定的实现细节藏在 `src/cpp/` 里。Public 类的头文件只暴露方法签名，不暴露内部状态。Fast-DDS 可以在不改变 Public 头文件的前提下任意修改 Impl 的内部结构。这是 Pimpl（Pointer to Implementation）模式的变体，但 Fast-DDS 的 Impl 除了隐藏实现，还承担了跨层桥接的职责。

### 事件上行：Listener 适配器

数据和控制流向下穿透（用户 → Public → Impl → RTPS），事件流则需要向上回传（RTPS → Impl → Public → 用户 Listener）。这通过 Impl 类中的**内部 Listener 适配器**完成。

`DataWriterImpl` 内部定义了 `InnerDataWriterListener`，它实现 RTPS 层的 `WriterListener` 接口：

```cpp
// src/cpp/fastdds/publisher/DataWriterImpl.hpp
class InnerDataWriterListener : public fastdds::rtps::WriterListener
{
    public:
        void on_writer_matched(RTPSWriter* writer,
                                 const MatchingInfo& info) override;
        void on_writer_change_received_by_all(RTPSWriter* writer,
                                             CacheChange_t* change) override;
        void on_liveliness_lost(RTPSWriter* writer,
                                 const LivelinessLostStatus& status) override;
        void on_reader_discovery(RTPSWriter* writer, ReaderDiscoveryStatus reason,
                        const GUID_t& reader_guid,
                        const SubscriptionBuiltinTopicData* reader_info) override;
        // ...
    private:
        DataWriterImpl* data_writer_;
} writer_listener_;
```

当 RTPS 层检测到「所有可靠 Reader 都确认了这条消息」时就会调用 `on_writer_change_received_by_all()`。这个适配器方法内部完成三件事：
1. 更新 DDS 层的状态计数器（如 `PublicationMatchedStatus`）
2. 检查 `StatusMask`，判断用户是否订阅了这个事件
3. 如果订阅了，调用用户的 `DataWriterListener::on_publication_matched()` 或触发 `StatusCondition`

`MyRTPSParticipantListener` 也是同样的模式，只是它适配的是 `RTPSParticipantListener` 接口，处理参与者发现、认证、离线等事件。


### 完整的事件回路

把下行调用和上行事件合在一起，一次 `write()` 的完整生命周期涉及的对象关系是：

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260803161702127.png)

事件的翻译发生在 Impl 层：RTPS 层的 `MatchingInfo`（只有 matched/unmatched 和 GUID）被翻译成 DDS 层的 `PublicationMatchedStatus`（包含 current_count、total_count 等规范字段）。两层的事件类型不同，Impl 负责在中间做转换。

到这里，Fast-DDS 的架构骨架已经完整。


## 系列导读：后续每篇去哪里

本篇建立了一张代码地图。剩下的六篇会沿着这张地图逐层深入。

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260803162615309.png)

**篇二：实体模型与生命周期**
- 入口 example：`hello_world`
- 核心源码：`src/cpp/fastdds/domain/DomainParticipantFactory.cpp`、`DomainParticipantImpl.cpp`、`src/cpp/fastdds/publisher/PublisherImpl.cpp`
- 要回答的问题：实体创建的顺序约束从哪来？`delete_contained_entities()` 的析构顺序为什么重要？QoS 默认值的继承链（Factory → Participant → Publisher → DataWriter）是怎么实现的？两阶段启用（create + enable）在什么场景下有用？
- 设计焦点：工厂单例、实体树的所有权模型、RAII 与手动释放的边界

**篇三：类型系统与序列化**
- 入口 example：`hello_world`（生成的类型代码）+ `xtypes`（动态类型）
- 核心源码：`include/fastdds/dds/topic/TypeSupport.hpp`、`src/cpp/fastdds/xtypes/`、Fast-CDR 库（独立仓库）
- 要回答的问题：`fastddsgen` 生成了哪些文件、各自的作用？CDR 编码的基本规则？XCDR v1 和 v2 的区别？`@extensibility(APPENDABLE)` 在序列化层面改变了什么？Dynamic Types 如何在不生成代码的情况下完成类型注册和序列化？
- 设计焦点：数据类型与序列化逻辑的分离、TypeSupport 的注册机制、类型信息在 Discovery 中的传播

**篇四：Discovery：从陌生到匹配**
- 入口 example：`discovery_server`（Server 模式）+ `hello_world`（Simple 模式对比）
- 核心源码：`src/cpp/rtps/builtin/`（`PDPSimple`、`EDP`、`BuiltinProtocols`）、`include/fastdds/rtps/builtin/`
- 要回答的问题：SPDP 报文多久发一次、怎么判断参与者离线？SEDP 端点匹配的条件是什么（Topic name、type name、QoS 兼容性）？Discovery Server 把广播变成了什么？租约（lease）机制的参数怎么影响发现速度和网络开销？
- 设计焦点：无中心发现的状态机、租约与心跳的分布式共识、Server 模式的中心化取舍

**篇五：数据读写全路径**
- 入口 example：`delivery_mechanisms`（不同可靠性/持久性组合）
- 核心源码：`src/cpp/rtps/writer/`（`StatefulWriter`、`StatelessWriter`）、`src/cpp/rtps/reader/`（`StatefulReader`、`StatelessReader`）、`src/cpp/rtps/history/`、`src/cpp/rtps/messages/`
- 要回答的问题：`write()` 之后数据经过哪些缓冲区？`BEST_EFFORT` 和 `RELIABLE` 的代码路径差异在哪？HEARTBEAT/ACKNACK 握手怎么驱动重传？`take()` 和 `read()` 对 History 缓存的不同操作？Stateful 和 Stateless 的区别是什么？
- 设计焦点：History 作为读写两侧的核心缓冲、RTPS 消息驱动的状态机、ChangeKind（ALIVE/DISPOSE/UNREGISTER）的语义

**篇六：传输层与 Data Sharing**
- 入口 example：`delivery_mechanisms`（配置不同 transport）
- 核心源码：`src/cpp/rtps/transport/`（UDP、TCP、SharedMemory）、`src/cpp/rtps/DataSharing/`、`include/fastdds/rtps/transport/TransportInterface.hpp`
- 要回答的问题：Transport 的抽象接口是什么、怎么做到可插拔？同一台机器上的两个进程怎么自动切换到共享内存？Data Sharing 的零拷贝是怎么实现的（payload pool + 共享内存通知）？多个 transport 共存时的选择策略？
- 设计焦点：`TransportDescriptor` 的声明式配置、Locator 作为地址抽象、零拷贝路径的内存管理

**篇七：QoS 体系与流控**
- 入口 example：`flow_control`（流控）+ `content_filter`（过滤）
- 核心源码：`src/cpp/fastdds/core/policy/`、`src/cpp/rtps/flowcontrol/`、`src/cpp/fastdds/topic/DDSSQLFilter/`
- 要回答的问题：二十多种 QoS 策略在代码中怎么组织？哪些 QoS 是 immutable 的、为什么？FlowController 的令牌桶算法怎么限制发送速率？Content Filter 在 Reader 侧还是 Writer 侧执行、对带宽的影响是什么？
- 设计焦点：QoS 从声明到执行的穿透路径、策略模式在 QoS 体系中的应用、过滤下推的性能取舍

### 阅读方法

建议每篇按同样的节奏读：
1. 跑 example，观察行为，记录疑问。
2. 读本篇的源码走读，跟着调用链理解实现。
3. 自己打断点验证——在关键路径上设断点（如 `DataWriterImpl::write()`、`StatefulWriter::unsent_change_added_to_history()`、`EDP::pairingReader()`），跑 example 观察调用栈。这比纯读代码的理解深度高一个量级。
4. 回到文章末尾的设计讨论，对照实现思考"如果是我会怎么设计"。

### 写在最后

从 `hello_world` 的 20 行 API 调用出发，我们追踪了 `create_participant()` 跨越 DDS 和 RTPS 两层的完整调用链，建立了代码地图，理解了 Public → Impl → RTPS 的三层对象模式和事件回传机制。

读到这里你已经有了**目录地图**、**分层模型**和一套读**源码的导航规则**，你知道每一层在哪里、怎么连接、从哪里切入。

下一篇我们从实体模型开始，来看这些对象是怎么被创建、配置、启用和销毁，QoS 默认值怎么沿着实体树层层继承。
