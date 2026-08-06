+++
title = "Fast-DDS 源码解析（二）：实体模型与生命周期"
description = "Fast-DDS 用容器和工厂组织实体，创建、启用、删除，每一步都有前置检查"
date = "2026-08-06"
aliases = ["DDS-entity"]
author = "ChnjFan"
tags = [
    "DDS",
]
+++

{{< notice tip >}}
Fast-DDS 的实体（Entity）按 DDS 规范的容器模型组织：`DomainParticipant` 包含 `Publisher`/`Subscriber`/`Topic`，`Publisher` 包含 `DataWriter`，`Subscriber` 包含 `DataReader`。每个容器同时是被包含实体的工厂。

**QoS 默认值**沿包含层次继承。创建实体时传入 `XXX_QOS_DEFAULT`，会回落到父级容器的默认值；XML profile 在每层默认值上叠加。

**创建与启用分离**。create 只构造对象，enable 才让实体参与通信，`autoenable_created_entities` 控制两者的时机。

删除受前置条件约束。`delete_contained_entities()` 先全量检查所有被包含实体是否可删，全部通过才执行删除，避免中间状态。
{{< /notice >}}

## 实体创建的问题

在上一篇中我们从 `hello_world` 示例中梳理了实体创建的方式，从使用 `DomainParticipantFactory` 工厂创建 Participant，再依次创建 `Publisher`、`Topic` 和 `DataWriter`。

{{< notice note >}}
实体是什么？
[FastDDS 文档：数据分发服务层](https://fast-dds.docs.eprosima.com/en/latest/fastdds/library_overview/library_overview.html#dds-layer)中描述 DDS 实体是任何支持服务质量 QoS 配置且实现了监听器的对象。
我们目前看到的 `DomainParticipant`/`Publisher`/`Subscriber`/`Topic` 甚至是底层的 `DataReader` 都继承自 `Entity`。
{{< /notice >}}

下面我们再看看析构函数是怎么释放我们创建的这些实体的。

```cpp
PublisherApp::~PublisherApp()
{
    if (nullptr != participant_)
    {
        participant_->delete_contained_entities();
        DomainParticipantFactory::get_instance()->delete_participant(participant_);
    }
}
```

析构函数中，先删除了 Participant 内的所有实体，再删 Participant 本身。但是 `delete_contained_entities()` 和 `delete_participant()` 都可能返回失败 `RETCODE_PRECONDITION_NOT_MET`。

为什么会出现删除实体失败？什么情况下会删除失败？要搞清楚这些，得先看 Fast-DDS 的实体之间是什么关系。

本篇主要讲清楚两件事：**实体模型**和**生命周期**。

1. **实体模型**。DDS 规范用两个概念描述各个实体之间的关系：容器（container）和工厂（factory）。`DomainParticipant` 是其他实体的容器，同时也是创建它们的工厂；`Publisher` 又是 `DataWriter` 的容器和工厂，这层包含关系决定了谁能删除谁。实体之间还有另一层关联：QoS 默认值沿包含层次从父级传向子级，`get_default_datawriter_qos()` 返回的值不是凭空来的。
2. **生命周期**。每个实体经历 created、enabled、in use、deleted 四个阶段。创建有前置条件（类型必须注册、QoS 必须合法），创建和启用是两个分离的动作，删除有前置条件（借出的资源必须归还）。每个阶段的约束在代码里都有对应的检查。

此外，本篇不展开 QoS 各策略的语义和它们在 RTPS 层的行为，我们在最后一篇「QoS 体系与流控」专门讨论。

## 容器与工厂：实体的包含关系

### 包含和工厂两个概念

[FastDDS 文档](https://fast-dds.docs.eprosima.com/en/latest/fastdds/getting_started/definitions.html#the-dcps-conceptual-model)中描述了这样一段话：

> The DomainParticipant acts as a container for other DCPS Entities, acts as a factory for Publisher, Subscriber and Topic Entities, and provides administrative services in the domain.

`DomainParticipant` 包含（contain）其他实体，对它们的生命周期负责。这些实体只能通过 `DomainParticipant` 的工厂函数 `create_xxx()` 方法产生，不能自己 `new`。

包含关系是递归的。`DomainParticipant.hpp` 中 `contains_entity` 的注释描述：

```cpp
/**
 * This operation checks whether or not the given handle represents an Entity 
 * that was created from the DomainParticipant.
 *
 * @param a_handle InstanceHandle of the entity to look for.
 * @param recursive The containment applies recursively. That is, it applies
 * both to entities (TopicDescription, Publisher, or Subscriber) created directly
 * using the DomainParticipant as well as entities created using a contained
 * Publisher, or Subscriber as the factory, and so forth. (default: true)
 * @return True if entity is contained. False otherwise.
 */
FASTDDS_EXPORTED_API bool contains_entity(
        const InstanceHandle_t& a_handle,
        bool recursive = true) const;
```

也就是说 `Publisher` 和 `Subscriber` 也是容器：`Publisher` 包含 `DataWriter`，`Subscriber` 包含 `DataReader`。完整的包含层次（containment hierarchy）是：

```
DomainParticipantFactory（单例，Participant 的工厂）
 └── DomainParticipant（容器 + 工厂）
      ├── Topic（被包含实体，可被多个端点共享）
      ├── Publisher（容器 + 工厂）
      │    └── DataWriter
      └── Subscriber（容器 + 工厂）
           └── DataReader
```

注意 `Topic` 属于 `DomainParticipant`，不属于某个 `Publisher` 或 `Subscriber`，因为同一个 `Topic` 可以同时被 `Writer` 和 `Reader` 使用。这个共享机制后面讲。


### Participant 工厂单例

在上面完整的包含层次中，位于最顶层的是 `DomainParticipantFactory`，一个全局单例，所有 `Participant` 都由它创建：

```cpp
// src/cpp/fastdds/domain/DomainParticipantFactory.cpp
DomainParticipantFactory* DomainParticipantFactory::get_instance()
{
    return get_shared_instance().get();
}

std::shared_ptr<DomainParticipantFactory>
DomainParticipantFactory::get_shared_instance()
{
    // Note we need a custom deleter, since the destructor is protected.
    static std::shared_ptr<DomainParticipantFactory> instance(
        new DomainParticipantFactory(),
        [](DomainParticipantFactory* p)
        {
            delete p;
        });
    return instance;
}
```

`DomainParticipantFactory` 内部用一个 map 来管理所有创建的 Participant，按照 DomainID 进行分组。

```cpp
// DomainParticipantFactory.hpp（成员，简化）
std::map<DomainId_t, std::vector<DomainParticipantImpl*>> participants_;
```

到这里我们可以看出，同一个进程只有一个 `DomainParticipantFactory` 单例，并且可以在多个 Domain 下创建多个 Participant。调用 `delete_participant(participant_)` 删除实体的时候，按照 `participant_` 中的 DomainID 在表中查询到对应的数组，然后遍历数组删除实体。

```cpp
// src/cpp/fastdds/domain/DomainParticipantFactory.cpp（简化删除流程）
ReturnCode_t DomainParticipantFactory::delete_participant(
        DomainParticipant* part)
{
    std::lock_guard<std::mutex> guard(mtx_participants_);
    // 实体还有 Publisher, Subscriber 或 Topic 不能删除
    if (part->has_active_entities())
        return RETCODE_PRECONDITION_NOT_MET;
    // 根据 DomainID 找到该 Domain 下的实体
    VectorIt vit = participants_.find(part->get_domain_id());
    // 遍历删除传参的实体
    for (PartVectorIt pit = vit->second.begin(); pit != vit->second.end();)
    {
        if ((*pit)->get_participant() == part
                || (*pit)->get_participant()->guid() == part->guid())
        {
            (*pit)->disable();  // 通过 disable 删除，对应上一篇中的 enable 创建
            delete (*pit);
            PartVectorIt next_it = vit->second.erase(pit); // vector 操作迭代器失效问题
            pit = next_it;
            break;
        } else {
            ++pit;
        }
    }

    return RETCODE_OK;
}
```

### 容器怎么持有被包含实体

`DomainParticipantImpl` 用三个 map 分别持有三类被包含实体：

```cpp
// src/cpp/fastdds/domain/DomainParticipantImpl.hpp（成员，简化）
std::map<Publisher*, PublisherImpl*> publishers_;
std::map<Subscriber*, SubscriberImpl*> subscribers_;
std::map<std::string, TopicProxyFactory*> topics_;   // key 是 topic name
```

`Publisher` 按照 topic name 分组持有 `DataWriter`：

```cpp
// src/cpp/fastdds/publisher/PublisherImpl.hpp（成员，简化）
std::map<std::string, std::vector<DataWriterImpl*>> writers_;
```

我们在上面的数据结构中就能看出，同一个 `Publisher` 可以在同一个 Topic 上创建多个 `DataWriter`，比如同一个 Topic 需要不同的 QoS 传输数据。按 topic name 聚合后，找出某个 topic 上的全部 writer 只需要一次 map 查找。


### Public 与 Impl 的双向绑定

创建实体时，容器会把 Public 对象和 Impl 对象互相绑定。以 `create_publisher` 为例：

```cpp
// src/cpp/fastdds/domain/DomainParticipantImpl.cpp（create_publisher，精简）
Publisher* DomainParticipantImpl::create_publisher(
        const PublisherQos& qos,
        PublisherImpl** impl,
        PublisherListener* listener,
        const StatusMask& mask)
{
    PublisherImpl* pubimpl = create_publisher_impl(qos, listener);
    Publisher* pub = new Publisher(pubimpl, mask);
    pubimpl->user_publisher_ = pub;
    pubimpl->rtps_participant_ = get_rtps_participant();

    InstanceHandle_t pub_handle;
    create_instance_handle(pub_handle);
    pubimpl->handle_ = pub_handle;

    //将发布者容器注册到 map 中
    std::lock_guard<std::mutex> lock(mtx_pubs_);
    publishers_by_handle_[pub_handle] = pub;
    publishers_[pub] = pubimpl;

    return pub;
}
```

`Publisher` 内部持有 `impl_` 指针，这也是我们经常提到的 Impl 设计模式，将所有方法都委托给 `impl_`。`PublisherImpl` 反过来也持有 `user_publisher_` 指针。

双向绑定让两边可以互相找到对方：Public 收到用户调用时找 Impl 干活，Impl 需要回调用户 Listener 时找 Public。

容器通过两个 map 注册被包含实体：`publishers_by_handle_` 按 `InstanceHandle_t` 索引，用于按 handle 查询容器的操作，`publishers_` 按 Public 指针索引用于遍历和删除。


### Topic 的引用计数：共享的被包含实体

在被包含实体中，只有 `Topic` 会被多个端点共享，同一个 `Topic` 可能同时被若干 `DataWriter` 和 `DataReader` 引用。

Fast-DDS 用引用计数管理它的生命周期：

```cpp
// src/cpp/fastdds/publisher/PublisherImpl.cpp（create_datawriter，精简）
DataWriter* PublisherImpl::create_datawriter(
        Topic* topic,
        const DataWriterQos& qos,
        DataWriterListener* listener,
        const StatusMask& mask,
        std::shared_ptr<fastdds::rtps::IPayloadPool> payload_pool)
{
    //... 数据类型、QoS、过滤器前置检查
    DataWriterImpl* impl = create_datawriter_impl(
        type_support, topic, qos, listener, payload_pool);
    return create_datawriter(topic, impl, mask);
}

DataWriter* PublisherImpl::create_datawriter(
        Topic* topic,
        DataWriterImpl* impl,
        const StatusMask& mask)
{
    // 引用计数 +1
    topic->get_impl()->reference();

    DataWriter* writer = new DataWriter(impl, mask);
    impl->user_datawriter_ = writer;    // impl 持有 public

    {// public 管理 impl
        std::lock_guard<std::mutex> lock(mtx_writers_);
        writers_[topic->get_name()].push_back(impl);
    }

    return writer;
}
```

每创建一个使用该 `Topic` 的 `DataWriter` 或 `DataReader`，引用计数加一，删除时减一。计数为 0 时 `Topic` 才被真正销毁。

`delete_contained_entities()` 必须先把所有引用 `Topic` 的实体删除引用计数才能归零， `Topic` 才能被真正销毁。

### :confused: 为什么不直接使用智能指针？

直接使用 `std::shared_ptr` 管理 `Topic` 不是更方便，为什么还有自己实现引用计数？

我猜测跟 [DDS 规范](https://www.omg.org/spec/DDS/1.4/PDF/)中提到实体在删除操作前必须检查前置条件有关。

```
The deletion of a DataReader is not allowed if it has any outstanding loans as a 
result of a call to read, take, or one of the variants thereof.
If the delete_datareader operation is called on a DataReader with one or more 
outstanding loans, it will return PRECONDITION_NOT_MET.
```

实体在使用中删除操作必须失败并返回 `RETCODE_PRECONDITION_NOT_MET`，而不是偷偷析构。DDS 中的实体释放都有一系列的前置检查，如果检查失败就不能释放，防止出现空悬指针。


## QoS 默认值继承链

在上一篇的 `hello_world` 示例中，创建 `DataWriter` 前设置了本地消息缓存深度：

```cpp
DataWriterQos writer_qos = DATAWRITER_QOS_DEFAULT;
writer_qos.history().depth = 5;
publisher_->get_default_datawriter_qos(writer_qos);
writer_ = publisher_->create_datawriter(topic_, writer_qos, this, StatusMask::all());
```

`get_default_datawriter_qos()` 返回的默认值从哪来？如果我在创建 `Publisher` 之后改了它的默认 `DataWriterQos`，之后创建的 `DataWriter` 会受影响吗？

### DATAWRITER_QOS_DEFAULT

先看 `DATAWRITER_QOS_DEFAULT` 是什么：

```cpp
// include/fastdds/dds/publisher/qos/DataWriterQos.hpp
FASTDDS_EXPORTED_API extern const DataWriterQos DATAWRITER_QOS_DEFAULT;
FASTDDS_EXPORTED_API extern const DataWriterQos DATAWRITER_QOS_USE_TOPIC_QOS;
// src/cpp/fastdds/publisher/qos/DataWriterQos.cpp
const DataWriterQos DATAWRITER_QOS_DEFAULT;    // 默认构造的全局常量
const DataWriterQos DATAWRITER_QOS_USE_TOPIC_QOS;
```

它就是一个默认构造的全局 `const` 对象。Fast-DDS 用**地址比较**来判断用户传入的是不是默认配置。

```cpp
PublisherImpl::PublisherImpl(
        DomainParticipantImpl* p,
        const PublisherQos& qos,
        PublisherListener* listen)
    : participant_(p)
    , qos_(&qos == &PUBLISHER_QOS_DEFAULT ?
             participant_->get_default_publisher_qos() : qos)
    //...
```

调用 `create_publisher(PUBLISHER_QOS_DEFAULT, ...)` 时，传入的引用恰好绑定到全局常量 `PUBLISHER_QOS_DEFAULT`，`&qos == &PUBLISHER_QOS_DEFAULT` 成立，于是 `Publisher` 的 QoS 回落到 `DomainParticipant` 的默认值。


### 默认值的解析

`DataWriter` 的默认值解析发生在 `DataWriterImpl` 构造时：

```cpp
// src/cpp/fastdds/publisher/DataWriterImpl.cpp
DataWriterImpl::DataWriterImpl(PublisherImpl* p, TypeSupport type, Topic* topic,
                               const DataWriterQos& qos, ...)
    : publisher_(p)
    , type_(type)
    , topic_(topic)
    , qos_(get_datawriter_qos_from_settings(qos))   // 在这里解析
    // ...

DataWriterQos
DataWriterImpl::get_datawriter_qos_from_settings(const DataWriterQos& qos)
{
    DataWriterQos return_qos;
    if (&DATAWRITER_QOS_DEFAULT == &qos)
    {
        return_qos = publisher_->get_default_datawriter_qos();
    }
    else if (&DATAWRITER_QOS_USE_TOPIC_QOS == &qos)
    {
        return_qos = publisher_->get_default_datawriter_qos();
        publisher_->copy_from_topic_qos(return_qos, topic_->get_qos());
    }
    else
    {
        return_qos = qos;
    }
    return return_qos;
}
```

三个分支代表了三种用法：
- 设置默认 QoS 值 `DATAWRITER_QOS_DEFAULT` 创建 `DataWriterQos`，直接使用 `Publisher` 的默认 DataWriter QoS。
- 设置使用 Topic 的默认值 `DATAWRITER_QOS_USE_TOPIC_QOS`，就会在 `Publisher` 的默认 DataWriter QoS 上复制 `Topic` 的 QoS 一部分字段。
- 用户指定了 QoS 直接返回。

注意解析的时机：只在构造 `DataWriter` 时发生一次，结果存进 `qos_` 成员。之后 `Publisher` 的默认值再怎么变，这个 `DataWriter` 的 QoS 不受影响。


### 默认值存在哪

每个容器实体的 Impl 都持有子实体的默认 QoS 成员。`PublisherImpl` 持有 `default_datawriter_qos_`，`DomainParticipantImpl` 持有 `default_pub_qos_`、`default_sub_qos_`、`default_topic_qos_`。

读取默认 QoS 就是直接返回成员：

```cpp
// src/cpp/fastdds/publisher/PublisherImpl.cpp
const DataWriterQos& PublisherImpl::get_default_datawriter_qos() const
{
    return default_datawriter_qos_;
}
```

修改通过 `set_default_datawriter_qos()`：

```cpp
ReturnCode_t PublisherImpl::set_default_datawriter_qos(const DataWriterQos& qos)
{
    if (&qos == &DATAWRITER_QOS_DEFAULT)    // 传入哨兵值 = 重置为出厂默认
    {
        reset_default_datawriter_qos();
        return RETCODE_OK;
    }

    ReturnCode_t ret_val = DataWriterImpl::check_qos(qos);
    if (RETCODE_OK != ret_val)
    {
        return ret_val;
    }
    DataWriterImpl::set_qos(default_datawriter_qos_, qos, true);
    return RETCODE_OK;
}
```

传入 `DATAWRITER_QOS_DEFAULT` 表示「重置为出厂默认」；修改默认值前先做 `check_qos` 校验，不合法的 QoS 进不了默认值。

这里需要注意，我们在构造 `DataWriterImpl` 时已经设置好了 `qos_` 成员，所以 `set_default_datawriter_qos` 只影响之后创建的 `DataWriter`。


### XML profile 的注入点

`default_datawriter_qos_` 的初始值是哪里来的？回到 `PublisherImpl` 构造函数的函数体：

```cpp
PublisherImpl::PublisherImpl(
        DomainParticipantImpl* p,
        const PublisherQos& qos,
        PublisherListener* listen)
    //... 其他成员初始化
    , default_datawriter_qos_(DATAWRITER_QOS_DEFAULT)
{
    xmlparser::PublisherAttributes pub_attr;
    XMLProfileManager::getDefaultPublisherAttributes(pub_attr);
    utils::set_qos_from_attributes(default_datawriter_qos_, pub_attr);
}
```

我们在上面说过，每个实体的默认 QoS 成员都是由容器实体保存。所以 `default_datawriter_qos_` 由 `PublisherImpl` 保存。

初始化列表先把 `default_datawriter_qos_` 设为全局默认值，构造函数体再把 XML 中默认 profile 的配置叠加上去。

示例 `hello_world` 目录下的 `hello_world_profile.xml` 就定义了 `DataWriter` 的默认 QoS 配置。

```xml
<data_writer profile_name="hello_world_datawriter_profile" is_default_profile="true">
    <qos>
        <durability><kind>TRANSIENT_LOCAL</kind></durability>
        <reliability><kind>RELIABLE</kind></reliability>
    </qos>
    <topic>
        <historyQos><kind>KEEP_LAST</kind><depth>100</depth></historyQos>
        <!-- ... -->
    </topic>
</data_writer>
```

XML 是在 `DomainParticipantFactory::create_participant()` 的入口处调用 `load_profiles()` 加载的。


### 完整的继承链

我们把整条 QoS 默认值的继承链串起来：

```
DATAWRITER_QOS_DEFAULT（全局常量，depth=1，BEST_EFFORT，VOLATILE）
    │
    ▼  PublisherImpl 构造时叠加
XML 默认 profile（如果加载了 profile 文件）
    │
    ▼  存入成员
PublisherImpl::default_datawriter_qos_
    │                          ▲
    │                          │ set_default_datawriter_qos()（影响之后创建的实体）
    ▼  创建 DataWriter 时，传入 DATAWRITER_QOS_DEFAULT 触发解析
DataWriterImpl::get_datawriter_qos_from_settings()
    │
    ▼  用户也可以显式传入自己的 QoS（跳过继承）
DataWriterImpl::qos_（构造时固定）
```

`DomainParticipant` 到 `Publisher`/`Subscriber`/`Topic` 的继承同理，只是哨兵值换成了 `PUBLISHER_QOS_DEFAULT`、`SUBSCRIBER_QOS_DEFAULT`、`TOPIC_QOS_DEFAULT`。


### 回头看 hello_world：一个容易踩的顺序问题

有了这些知识后，我们再回头看看 `hello_world` 的示例代码，就会发现一个问题：

```cpp
DataWriterQos writer_qos = DATAWRITER_QOS_DEFAULT;
writer_qos.history().depth = 5;                     // 1. 设置 depth=5
publisher_->get_default_datawriter_qos(writer_qos); // 2. 整体覆盖
```

`get_default_datawriter_qos(DataWriterQos&)` 这个重载的实现是整体赋值：

```cpp
ReturnCode_t Publisher::get_default_datawriter_qos(DataWriterQos& qos) const
{
    qos = impl_->get_default_datawriter_qos();   // 覆盖，不是合并
    return RETCODE_OK;
}
```

我们直接在这个示例中做个实验。

在终端设置 `FASTDDS_DEFAULT_PROFILES_FILE` 加载路径，让 FastDDS 加载 hello_world 示例设置的默认 QoS 配置。

```bash
export FASTDDS_DEFAULT_PROFILES_FILE=<your_example_path>/hello_world_profile.xml
```

`hello_world_profile.xml` 中设置了 `historyQos`，但是代码中的意图是 `history().depth` 设置为 5。

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260805190216298.png)

运行后发现，Subscriber 在发送完第 15 条消息之后上线了，但是依然能够收到前 15 条消息。

如果示例是在默认值基础上把 depth 改成 5，正确的顺序应该反过来：

```cpp
DataWriterQos writer_qos;
publisher_->get_default_datawriter_qos(writer_qos);  // 先拿默认值
writer_qos.history().depth = 5;                      // 再定制
writer_ = publisher_->create_datawriter(topic_, writer_qos, this, StatusMask::all());
```

修改之后我们编译后再运行一次，Subscriber 在 Publisher 发送第 14 条消息后上线，只获取到最后 5 条消息。

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260805190540091.png)


## 创建与启用：从 create 到 enable

在上一节我们看到 `create_datawriter()` 在构造 `DataWriterImpl` 时解析了 QoS，但构造完成时这个 DataWriter 在 RTPS 网络中还不存在。真正创建 RTPS 资源的是 `enable()`。

### create 只做构造，enable 才接入协议

`DataWriterImpl` 构造函数的初始化列表里没有初始化这些 RTPS 对象，只是准备了 GUID 的基础结构。

```cpp
DataWriterImpl::DataWriterImpl(
        PublisherImpl* p,
        TypeSupport type,
        Topic* topic,
        const DataWriterQos& qos,
        const fastdds::rtps::EntityId_t& entity_id,
        DataWriterListener* listen)
    : publisher_(p)
    , type_(type)
    , topic_(topic)
    , qos_(get_datawriter_qos_from_settings(qos))
    , listener_(listen)
    , history_()
#pragma warning (disable : 4355 )
    , writer_listener_(this)
    , deadline_duration_us_(qos_.deadline().period.to_ns() * 1e-3)
    , lifespan_duration_us_(qos_.lifespan().duration.to_ns() * 1e-3)
{
    guid_ = { publisher_->get_participant_impl()->guid().guidPrefix, entity_id};
}
```

`DataWriterImpl::enable()` 将 DDS QoS 翻译成 RTPS 层的 `WriterAttributes` 端点配置。

```cpp
// src/cpp/fastdds/publisher/DataWriterImpl.cpp（enable，精简）
ReturnCode_t DataWriterImpl::enable()
{
    assert(writer_ == nullptr); // 确保只 enable 一次

    WriterAttributes w_att;
    {
        std::lock_guard<std::mutex> qos_guard(qos_mutex_);
        // QoS → RTPS 属性翻译（节选）
        w_att.endpoint.durabilityKind = qos_.durability().durabilityKind();
        w_att.endpoint.reliabilityKind = 
            qos_.reliability().kind == RELIABLE_RELIABILITY_QOS ?
                                        RELIABLE : BEST_EFFORT;
        w_att.mode = qos_.publish_mode().kind == SYNCHRONOUS_PUBLISH_MODE 
            ? SYNCHRONOUS_WRITER : ASYNCHRONOUS_WRITER;
        // ... 二十多个字段的翻译
    }

    // 创建内存池、History 缓存
    auto pool = get_payload_pool();
    create_history(pool, change_pool);
    // 创建 RTPS 层的 Writer 数据发送端实体
    RTPSWriter* writer =  RTPSDomain::createRTPSWriter(
        publisher_->rtps_participant(),
        guid_.entityId,
        w_att,
        history_.get(),
        static_cast<WriterListener*>(&writer_listener_));

    // REGISTER THE WRITER
    fastdds::rtps::TopicDescription topic_desc;
    topic_desc.topic_name = topic_->get_name();
    topic_desc.type_name = topic_->get_type_name();
    publisher_->get_participant_impl()->fill_type_information(type_,
        topic_desc.type_information);

    PublicationBuiltinTopicData publication_data;
    get_publication_builtin_topic_data(publication_data);
    // 注册端点，参与 Discovery，SEDP 将它通告给远端
    ReturnCode_t register_writer_code = 
        publisher_->rtps_participant()->register_writer(
            writer_, topic_desc, publication_data);
    return register_writer_code;
}
```

`enable()` 主要完成了三件事：
- **创建 RTPS 端点**。`createRTPSWriter` 在这一步分配网络资源。
- **建立 History 和内存池**，数据缓冲的基础设施。
- **注册进 Discovery**。`register_writer` 之后，远端 Reader 就能发现这个 Writer。


### enable 的前置条件：父容器必须先启用

公共类 `DataWriter::enable()` 在委托给 Impl 之前有一个检查条件：

```cpp
// src/cpp/fastdds/publisher/DataWriter.cpp
ReturnCode_t DataWriter::enable()
{
    if (enable_)
    {
        return RETCODE_OK;    // 幂等：已启用直接返回
    }

    if (false == impl_->get_publisher()->is_enabled())
    {
        return RETCODE_PRECONDITION_NOT_MET;    // 父容器未启用，拒绝
    }

    ReturnCode_t ret_code = impl_->enable();
    enable_ = RETCODE_OK == ret_code;
    return ret_code;
}
```

`enable_` 标志位来自基类 `Entity`，`Entity` 基类持有这个生命周期状态。

`enable` 是幂等的，如果已经开启成功也要返回成功。

启用有层级约束：`Publisher` 没启用，`DataWriter` 就不能启用。这条约束沿着包含层次向上递推，一直到 `Participant`。


### 默认行为与两阶段模式

用户通常不用手动调 `enable()`，因为 `EntityFactoryQosPolicy` 默认自动启用：

```cpp
// include/fastdds/dds/core/policy/QosPolicies.hpp
class EntityFactoryQosPolicy
{
public:
    /**
     * Specifies whether the entity acting as a factory automatically enables
     * the instances it creates. By default, True.
     */
    bool autoenable_created_entities;

    EntityFactoryQosPolicy()
        : autoenable_created_entities(true)
    {
    }
};
```

这个策略在每个容器里的 QoS 中都存在，创建子实体时，容器检查这个标志决定是否立即 enable。`create_publisher` 的代码：

```cpp
// src/cpp/fastdds/domain/DomainParticipantImpl.cpp（create_publisher，精简）
PublisherImpl* pubimpl = create_publisher_impl(qos, listener);
Publisher* pub = new Publisher(pubimpl, mask);
// ... 注册到 map ...

bool enabled = get_rtps_participant() != nullptr;    // Participant 已启用？

if (enabled && qos_.entity_factory().autoenable_created_entities)
{
    pub->enable();    // 两个条件都满足才启用
}
```

注意 `enabled` 这个局部变量，如果 `Participant` 自己还没启用，RTPS 层参与者还没创建，这里会跳过 `enable`，`Publisher` 处于「已创建未启用」状态。

那这些被跳过的实体什么时候启用？答案在 `DomainParticipantImpl::enable()`。

```cpp
// src/cpp/fastdds/domain/DomainParticipantImpl.cpp（enable，精简）
ReturnCode_t DomainParticipantImpl::enable()
{
    if (qos_.entity_factory().autoenable_created_entities)
    {
        // 先启用所有暂存的 Topic
        {
            std::lock_guard<std::mutex> lock(mtx_topics_);

            for (auto topic : topics_)
            {
                topic.second->enable_topic();
            }
        }
        // 再启用所有暂存的 Publisher，级联到 DataWriter
        {
            std::lock_guard<std::mutex> lock(mtx_pubs_);
            for (auto pub : publishers_)
            {
                pub.second->rtps_participant_ = part;
                pub.second->user_publisher_->enable();
            }
        }

        // subscribers 类似
    }

    part->enable(); // 最后启动 RTPS 参与者（Discovery 开始广播）

    return RETCODE_OK;
}
```

级联是逐层的，`PublisherImpl::enable()` 也会启用它下面所有已创建的 `DataWriter`：

```cpp
// src/cpp/fastdds/publisher/PublisherImpl.cpp（enable，精简）
ReturnCode_t PublisherImpl::enable()
{
    if (qos_.entity_factory().autoenable_created_entities)
    {
        std::lock_guard<std::mutex> lock(mtx_writers_);
        for (auto topic_writers : writers_)
        {
            for (DataWriterImpl* dw : topic_writers.second)
            {
                dw->user_datawriter_->enable();
            }
        }
    }
    // ...
}
```

整个 `enable` 的调用链是：Participant enable → 创建 RTPS 参与者 → 依次启用 Topic → 启用 Publisher，级联启用其下所有 DataWriter（创建 RTPS 端点、注册 Discovery）→ 启用 Subscriber，级联启用 DataReader → 最后 part->enable() 启动 RTPS 参与者。最后一步才启动 Discovery 广播，保证本地端点在对外可见之前已经全部就绪。


### 为什么要两阶段创建和启动

`create` 和 `enable` 分离解决了什么问题？考虑这样一个场景：应用要创建一组相互关联的实体，比如一个 Publisher 下有多个 DataWriter。如果创建即启用，第一个实体启用时就开始参与 Discovery，而此时其他实体还没创建，远端可能看到一个「半成品」的端点集合。

两阶段模式允许应用先把实体全部创建好、配置好，此时没有任何网络行为。再调用一次 **enable()** 统一启用。**autoenable_created_entities = false** 就是为这个场景准备的。默认值 true 则照顾了最常见的需求：创建即可用，少写一行代码。

这个设计也解释了 QoS 在构造时解析并固定，所以在 enable 之前修改容器的默认 QoS，不会影响已创建未启用的实体。想改已创建实体的配置，要么删了重建，要么用 `set_qos()`。


## 销毁的前置条件与删除顺序

回到开头应用的析构函数释放 participant：

```cpp
participant_->delete_contained_entities();
DomainParticipantFactory::get_instance()->delete_participant(participant_);
```

这两步都可能返回 `RETCODE_PRECONDITION_NOT_MET`。

### Participant 不能带着实体被删除

`delete_participant()` 的第一步是检查 Participant 是否还包含实体：

```cpp
// src/cpp/fastdds/domain/DomainParticipantFactory.cpp
ReturnCode_t DomainParticipantFactory::delete_participant(DomainParticipant* part)
{
    // ...
    if (part->has_active_entities())
    {
        return RETCODE_PRECONDITION_NOT_MET;
    }
    // ... 从 Factory 的 map 中移除，disable 并 delete
}

bool DomainParticipantImpl::has_active_entities()
{
    if (!publishers_.empty()) return true;
    if (!subscribers_.empty()) return true;
    if (!topics_.empty()) return true;
    return false;
}
```

三个容器的 map 只要有一个非空，就说明存在活跃的实体。

所以正确的删除顺序是：先 `delete_contained_entities()` 清空所有被包含实体，再 `delete_participant()`。hello_world 的析构函数就是这个顺序。

如果反过来或者忘了删实体，`delete_participant()` 会拒绝执行，Participant 连同它的所有资源继续存在。这是框架在防止出现悬空指针，Participant 一旦被删，它包含的 `Publisher`、`DataWriter` 手里的 `participant_` 指针就全部失效。


### delete_contained_entities：先全量检查，再批量执行

`DomainParticipantImpl::delete_contained_entities()` 销毁实体也是经历了两个阶段：

```cpp
// src/cpp/fastdds/domain/DomainParticipantImpl.cpp（delete_contained_entities，精简）
ReturnCode_t DomainParticipantImpl::delete_contained_entities()
{
    bool can_be_deleted = true;

    // ── 第一阶段：只检查，不删除 ──
    std::lock_guard<std::mutex> lock_subscribers(mtx_subs_);
    for (auto subscriber : subscribers_)
    {
        can_be_deleted = subscriber.second->can_be_deleted();
        if (!can_be_deleted)
        {
            return RETCODE_PRECONDITION_NOT_MET;    // 任何一个删不了，整体放弃
        }
    }

    //... publisher 一样

    // ── 第二阶段：全部可删，才真正执行 ──
    for (auto& subscriber : subscribers_)
    {
        subscriber.first->delete_contained_entities();   // 级联删除 DataReader
    }
    // ... 从 map 中移除并 delete 每个 SubscriberImpl ...
    // ... 从 map 中移除并 delete 每个 PublisherImpl ...

    // 最后删除 Topic
    // ... delete topics_ 中的每个 TopicProxyFactory ...

    return RETCODE_OK;
}
```

为什么先全量检查？如果边检查边删除，假设一个 Participant 下有三个 Publisher，前两个删完了，第三个因为前置条件不满足删不掉，此时处于一种删了一半的中间状态，用户代码很难从中间状态恢复。

要么所有实体都满足删除条件全部删除，要么什么都不删返回 `RETCODE_PRECONDITION_NOT_MET`，实体集合保持原样。这是一种用两遍遍历换取的原子性语义。


### 销毁的前置条件

`can_be_deleted()` 逐级下探到每个端点的 `check_delete_preconditions()`。以 `DataWriter` 为例：

```cpp
// src/cpp/fastdds/publisher/PublisherImpl.cpp
bool PublisherImpl::can_be_deleted()
{
    bool can_be_deleted = true;
    std::lock_guard<std::mutex> lock(mtx_writers_);
    for (auto topic_writers : writers_)
    {
        for (DataWriterImpl* dw : topic_writers.second)
        {
            can_be_deleted = can_be_deleted 
                && (dw->check_delete_preconditions() == RETCODE_OK);
            if (!can_be_deleted)
            {
                return can_be_deleted;
            }
        }
    }
    return can_be_deleted;
}

// src/cpp/fastdds/publisher/DataWriterImpl.cpp
ReturnCode_t DataWriterImpl::check_delete_preconditions()
{
    if (loans_ && !loans_->is_empty())
    {
        return RETCODE_PRECONDITION_NOT_MET;
    }
    return RETCODE_OK;
}
```

目前 DataWriter 的前置条件只有一条：没有未归还的 loan。

什么是 loan？`DataWriter::loan_sample()` 允许用户直接从 Writer 的 payload 池里借一块内存，原地构造数据后再 write()，省去一次数据拷贝：

```cpp
void* sample = nullptr;
writer->loan_sample(sample,
     DataWriter::LoanInitializationKind::NO_LOAN_INITIALIZATION);
// 直接在 sample 指向的内存里构造数据 ...
writer->write(sample);    // 归还 loan 并发送
```

loan 期间 payload 的所有权在用户手里。如果此时 Writer 被删除、payload 池被销毁，用户手里的指针就悬空了。所以只要 `loans_` 集合非空，有借出去还没归还的内存，Writer 就拒绝删除。`DataReader` 侧同理（read/take 也有 loan 语义）。


### 删除顺序与 Topic 引用计数

`delete_contained_entities()` 在第二阶段的删除顺序是 subscriber → publisher → topic，和创建顺序相反。

```cpp
// src/cpp/fastdds/publisher/PublisherImpl.cpp（delete_contained_entities，精简）
while (writer_iterator != writers_.end())
{
    DataWriterImpl* writer_impl = *it;
    writer_impl->set_listener(nullptr);               // 1. 先摘除 listener
    it = writer_iterator->second.erase(it);
    // ...
    writer_impl->get_topic()->get_impl()->dereference();  // 2. Topic 引用计数 -1
    delete (writer_impl);                             // 3. 再删除
}
```

每删一个 `DataWriter`，它引用的 Topic 计数减一。所有 subscriber 和 publisher 删完，Topic 的计数归零，最后删除 Topic 才能成功。

`writer_impl->set_listener(nullptr)` 删除实体前先摘除 listener，防止删除过程中触发的状态变化，比如端点下线导致的 unmatched 事件回调到用户的 listener，那时实体可能已经处于半销毁状态。


### 删除路径的设计逻辑

把整条删除路径串起来：

```
delete_contained_entities() 先删除包含的实体
 ├─ 阶段一：遍历所有 Subscriber/Publisher → can_be_deleted()
 │           → 每个端点 check_delete_preconditions()（loan 等）
 │           任何一个失败 → RETCODE_PRECONDITION_NOT_MET（什么都不删）
 └─ 阶段二：全部通过
      ├─ 删 Subscriber（级联删 DataReader）
      ├─ 删 Publisher（级联删 DataWriter，Topic 计数递减）
      └─ 删 Topic（计数已归零）

delete_participant()
 └─ has_active_entities()?  ──非空──→ RETCODE_PRECONDITION_NOT_MET（拒绝）
       │ 空
       ▼
    移除、disable、delete ParticipantImpl
```


## 总结实体的生命周期

我们把所有的内容总结成一张图，每个实体都经历了四个阶段，每个阶段都有边界检查：

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260806102404845.png)

回到文章一开始提到的两个问题：

- **实体模型**。DDS 规范用容器（container）和工厂（factory）两个概念组织实体：`DomainParticipant` 包含 `Publisher`/`Subscriber`/`Topic` 并充当它们的工厂，`Publisher` 和 `Subscriber` 又分别是 `DataWriter` 和 `DataReader` 的容器和工厂。代码里容器用 map 持有被包含实体，Public 与 Impl 双向绑定，Topic 用引用计数支持多端点共享。QoS 默认值沿这棵包含层次传递，靠哨兵值地址比较识别「使用默认值」的请求，XML profile 在每层的默认值上叠加。
- **生命周期**。创建和启用分离，`create` 只做对象构造和 QoS 解析，`enable` 才创建 RTPS 资源并注册进 Discovery；`autoenable_created_entities` 默认把两步合成一步，但两阶段模式始终可用。删除受前置条件约束：loan 未归还的端点删不掉，带着实体的 `Participant` 删不掉；`delete_contained_entities()` 用全量预检保证「要么全删、要么不删」，用与创建相反的顺序逐层解除引用。

这篇反复出现的**两阶段模式**：两阶段启用（create → enable）、两阶段删除（预检 → 执行）。共同的动机是把「配置/检查」和「生效/执行」分开，不会出现中间状态。


