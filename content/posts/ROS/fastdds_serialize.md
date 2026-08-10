+++
title = "Fast-DDS 源码解析（三）：从 IDL 到字节流"
description = "write() 的参数是 void*，类型信息去哪了？从 fastddsgen 生成的四类文件讲起，拆解 TopicDataType 契约、CDR 编码与 Dynamic Types"
date = "2026-08-07"
aliases = ["DDS-serialize"]
author = "ChnjFan"
tags = [
    "Fast-DDS",
]
categories = [
    "DDS",
]
+++

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260807232615576.png)

{{< notice tip >}}
- `write()` 的参数是 `void*`，但类型信息没有丢失：`register_type()` 时存入 Participant 类型表，创建 DataWriter 时被 `find_type()` 找回，写入时通过 `TopicDataType` 接口完成序列化。
- fastddsgen 生成四类文件：数据类型本体、CDR 序列化适配、框架接口适配、类型元数据，四层职责分离。
- `TopicDataType` 是框架与类型的唯一契约：静态生成的类型和 Dynamic Types 走同一个接口，框架不区分两者。
- `@extensibility(APPENDABLE)` 注解改变线上编码：XCDRv2 下的 dheader 让旧版本读者能安全跳过新版本追加的成员。
{{< /notice >}}

## write() 接收 void*，框架如何序列化

看看 hello_world 示例中发布消息的接口：

```cpp
bool PublisherApp::publish()
{
    //... Wait for the data endpoints discovery
    if (!is_stopped())
    {
        hello_.index(hello_.index() + 1);
        ret = (RETCODE_OK == writer_->write(&hello_));
    }
    return ret;
}
```

自定义的数据 `HelloWorld` 通过 `DataWriter::write` 发送，我们再来看看这个函数的声明：

```cpp
/**
* Write data to the topic.
*
* @param data Pointer to the data
* @return RETCODE_OK if the data is correctly sent or a ReturnCode related to
*                       the specific error otherwise.
*/
FASTDDS_EXPORTED_API ReturnCode_t write(const void* const data);
```

函数的参数是 `void*` 类型，类型信息在函数调用时完全丢失，框架拿到的是一个无类型的指针。它怎么知道这块内存里是 `HelloWorld` 还是别的什么结构？又该按什么规则把它变成字节流？

答案就在实体创建中，我们在构造 `PublisherApp` 的时候通过五步创建了 Participant、Publisher、DataWriter、Topic 和 TypeSupport。这里的 `TypeSupport` 就是框架保存用户发送数据的关键信息结构。

```cpp
// examples/cpp/hello_world/PublisherApp.cpp 精简构造函数
PublisherApp::PublisherApp(
        const CLIParser::publisher_config& config,
        const std::string& topic_name)
    : participant_(nullptr)
    //... 初始化其他成员
    , type_(new HelloWorldPubSubType())
{
    // 1. 创建 participant
    // 2. 注册数据类型
    type_.register_type(participant_);
    // 3. 创建 Publisher
    // 4. 创建 Topic
    TopicQos topic_qos = TOPIC_QOS_DEFAULT;
    participant_->get_default_topic_qos(topic_qos);
    topic_ = participant_->create_topic(topic_name,
                                        type_.get_type_name(),
                                        topic_qos);
    // 5. 创建 DataWriter
}
```

在注册类型对象时，我们将 `HelloWorldPubSubType` 类型注册到了 `participant_` 中。之后在创建 Topic 时绑定了类型对象的标识；创建 `DataWriter` 时先检查 `topic` 的数据类型是否在 `participant_` 注册过，然后将类型对象保存在 `DataWriterImpl` 中。

```cpp
DataWriter* PublisherImpl::create_datawriter(
        Topic* topic,
        const DataWriterQos& qos,
        DataWriterListener* listener,
        const StatusMask& mask,
        std::shared_ptr<fastdds::rtps::IPayloadPool> payload_pool)
{
    //Look for the correct type registration
    TypeSupport type_support = participant_->find_type(topic->get_type_name());
    if (type_support.empty())
    {
        return nullptr;
    }
    //...
    DataWriterImpl* impl = create_datawriter_impl(type_support,
         topic, qos, listener, payload_pool);
    return create_datawriter(topic, impl, mask);
}
```

所以 `DataWriterImpl` 知道自己要序列化的数据类型是什么，`write()` 调用中直接通过保存的类型序列化数据：

```cpp
// src/cpp/fastdds/publisher/DataWriterImpl.cpp（perform_create_new_change，精简）
ReturnCode_t DataWriterImpl::perform_create_new_change(
        ChangeKind_t change_kind,
        const void* const data,
        WriteParams& wparams,
        const InstanceHandle_t& handle)
{
    SerializedPayload_t payload;
    if (!was_loaned)
    {
        // ...Initialize payload to null state
        bool should_serialize = (change_kind == ALIVE);
        if (should_serialize)
        {
            // ...Request payload from pool and proceed with serialization
            // 序列化发送的数据 data
            if (!type_->serialize_ctx(type_support_context_,
                     data, payload, data_representation_))
            {
                payload_pool_->release_payload(payload);
                return RETCODE_ERROR;
            }
        }
    }
}
```

`type_` 就是注册的类型对象，`void*` 类型的数据 `data` 在这里被序列化之后放入 `payload` 后进入 History 缓存等待发送。

整条链路是：IDL 定义类型 → 代码生成 → 注册绑定 → 写入序列化。本文就是按照这个路线梳理一遍。


## fastddsgen 生成的四类文件

对 `HelloWorld.idl` 运行 `fastddsgen`，一个只有两个字段的结构体生成了 8 个文件：

```
                                HelloWorld.hpp 
                                HelloWorldCdrAux.hpp
HelloWorld.idl        →         HelloWorldCdrAux.ipp
                                HelloWorldPubSubTypes.hpp
                                HelloWorldPubSubTypes.cxx
                                HelloWorldTypeObjectSupport.hpp
                                HelloWorldTypeObjectSupport.cxx
```

这 8 个文件按职责分成四类，每一类解决一个独立的问题。

### 数据类型本体（HelloWorld.hpp ）

这个文件我们在第一篇已经看过，一个不继承任何基类的纯 C++ 类，getter/setter 加两个成员变量。

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

这里要强调的是它没有包含任何 Fast-DDS 库的头文件，也不继承框架基类。
分层从这里开始：数据类型只依赖序列化库，不依赖中间件。应用代码可以放心地用它，存进容器、写单元测试、做业务逻辑，都不需要拖着 Fast-DDS 一起。


### CDR 序列化适配（HelloWorldCdrAux.hpp/.ipp）

序列化逻辑在这对文件里，而不是数据类里。它们为 Fast-CDR 库提供模板特化。头文件里只有两样东西：

```cpp
// examples/cpp/hello_world/HelloWorldCdrAux.hpp
// 序列化后的最大尺寸
constexpr uint32_t HelloWorld_max_cdr_typesize {268UL};
// key 的最大尺寸（无 key 类型为 0）
constexpr uint32_t HelloWorld_max_key_cdr_typesize {0UL};

namespace eprosima {
namespace fastcdr {
void serialize_key(eprosima::fastcdr::Cdr& scdr, const HelloWorld& data);
}}
```

`HelloWorldCdrAux.ipp` 里是三个模板特化：`serialize`、`deserialize`、`calculate_serialized_size`。

我们先看 `serialize`：

```cpp
template<>
eProsima_user_DllExport void serialize(
        eprosima::fastcdr::Cdr& scdr,
        const HelloWorld& data)
{
    eprosima::fastcdr::Cdr::state current_state(scdr);
    scdr.begin_serialize_type(current_state,
            eprosima::fastcdr::CdrVersion::XCDRv2 == scdr.get_cdr_version() ?
            eprosima::fastcdr::EncodingAlgorithmFlag::DELIMIT_CDR2 :
            eprosima::fastcdr::EncodingAlgorithmFlag::PLAIN_CDR);

    scdr << eprosima::fastcdr::MemberId(0) << data.index()
        << eprosima::fastcdr::MemberId(1) << data.message();
    scdr.end_serialize_type(current_state);
}
```

`begin_serialize_type` 根据 CDR 版本选择编码算法：XCDRv2 用 `DELIMIT_CDR2`，XCDRv1 用 `PLAIN_CDR`。

每个成员序列化时带着自己的编号 `MemberId(0)`、`MemberId(1)`。成员不只靠声明顺序识别，而是有了显式身份。这是 XTypes 体系的基础，类型在后续迭代中成员可以被追加、重排（MUTABLE 扩展性下），编号保证它们仍能被正确识别。

`scdr << data.index()` 把具体的编码工作交给 Fast-CDR 的 `Cdr` 类。生成代码只负责「按什么结构、什么顺序」序列化，每个值怎么变成字节由 Fast-CDR 实现。

再看 `deserialize` 生成的代码：

```cpp
template<>
eProsima_user_DllExport void deserialize(
        eprosima::fastcdr::Cdr& cdr,
        HelloWorld& data)
{
    cdr.deserialize_type(
            // 选择编码算法
            eprosima::fastcdr::CdrVersion::XCDRv2 == cdr.get_cdr_version() ?
            eprosima::fastcdr::EncodingAlgorithmFlag::DELIMIT_CDR2 :
            eprosima::fastcdr::EncodingAlgorithmFlag::PLAIN_CDR,
            [&data](eprosima::fastcdr::Cdr& dcdr,
                     const eprosima::fastcdr::MemberId& mid) -> bool
            {
                bool ret_value = true;
                switch (mid.id)
                {
                    case 0:
                        dcdr >> data.index();
                        break;
                    case 1:
                        dcdr >> data.message();
                        break;
                    default:
                        ret_value = false;
                        break;
                }
                return ret_value;
            });
}
```

生成的代码把一个回调 lambda 传给 Fast-CDR，解析字节流时每读到一个成员就按 MemberId 回调 lambda，`default` 分支对未知成员返回 `false`，Fast-CDR 会根据编码规则跳过这些字节。


### 框架接口适配（HelloWorldPubSubTypes.hpp/.cxx）

前两类文件都在解决「类型是什么」和「怎么序列化」，但是 Fast-DDS 框架还不认识它们。第三类文件将上面两类包装成框架的接口：

```cpp
// examples/cpp/hello_world/HelloWorldPubSubTypes.hpp（生成代码，精简）
class HelloWorldPubSubType : public eprosima::fastdds::dds::TopicDataType
{
public:
    typedef ::HelloWorld type;

    bool serialize(const void* const data, SerializedPayload_t& payload,
                   DataRepresentationId_t data_representation) override;
    bool deserialize(SerializedPayload_t& payload, void* data) override;
    uint32_t calculate_serialized_size(const void* const data,
                   DataRepresentationId_t data_representation) override;
    bool compute_key(const void* const data, InstanceHandle_t& ihandle,
                   bool force_md5 = false) override;
    void* create_data() override;
    void delete_data(void* data) override;
    // ...
};
```

`HelloWorldPubSubType` 继承自 `TopicDataType`，`TopicDataType` 是 Fast-DDS 提供的抽象基类（接口类），用来连接用户自定义类型和 DDS 中间件。

我们先看看 `serialize` 的实现，来解答 Fast-DDS 中的 `void* data` 是如何识别为 `HelloWorld` 类型的。

```cpp
// examples/cpp/hello_world/HelloWorldPubSubTypes.cxx（生成代码，精简）
bool HelloWorldPubSubType::serialize(
        const void* const data,
        SerializedPayload_t& payload,
        DataRepresentationId_t data_representation)
{
    // 直接将 data 转换为 Helloworld，只有当前文件知道具体类型
    const ::HelloWorld* p_type =
            static_cast<const ::HelloWorld*>(data);

    // 用 payload 的缓冲区构造 FastBuffer 和 Cdr 序列化器
    eprosima::fastcdr::FastBuffer fastbuffer(
        reinterpret_cast<char*>(payload.data), payload.max_size);
    eprosima::fastcdr::Cdr ser(
        fastbuffer, eprosima::fastcdr::Cdr::DEFAULT_ENDIAN,
        data_representation == DataRepresentationId_t::XCDR_DATA_REPRESENTATION
            ? eprosima::fastcdr::CdrVersion::XCDRv1
            : eprosima::fastcdr::CdrVersion::XCDRv2);
    payload.encapsulation = 
        ser.endianness() == eprosima::fastcdr::Cdr::BIG_ENDIANNESS ? CDR_BE : CDR_LE;
    ser.set_encoding_flag(
        data_representation == DataRepresentationId_t::XCDR_DATA_REPRESENTATION ?
        eprosima::fastcdr::EncodingAlgorithmFlag::PLAIN_CDR  :
        eprosima::fastcdr::EncodingAlgorithmFlag::DELIMIT_CDR2);

    try
    {
        // 写入封装头（字节序标记）
        ser.serialize_encapsulation();
        // 触发第二类的 serialize 模板特化
        ser << *p_type;
        ser.set_dds_cdr_options({0, 0});
    }
    catch (eprosima::fastcdr::exception::Exception& /*exception*/)
    {
        return false;
    }

    payload.length = static_cast<uint32_t>(ser.get_serialized_data_length());
    return true;
}
```

这个函数串连起了整个序列化路径：
1. 恢复类型信息：`void*` 在这里被 `static_cast` 还原成 `HelloWorld*`
2. 构造序列化器、写入封装头、调用第二类的模板特化完成实际编码、记录长度。

`data_representation` 参数决定用 XCDR v1 还是 v2。

文件开头还有一个兼容性守卫：

```cpp
#if !defined(FASTDDS_GEN_API_VER) || (FASTDDS_GEN_API_VER != 3)
#error Generated HelloWorld is not compatible with current installed Fast DDS. ...
#endif
```

fastddsgen 和 Fast-DDS 之间的接口版本检查，生成代码与库版本不匹配时直接编译报错，而不是运行时崩溃。


### 类型元数据（HelloWorldTypeObjectSupport.hpp/.cxx）

类型元数据是为了让远端节点知道类型是什么样。

```cpp
// examples/cpp/hello_world/HelloWorldTypeObjectSupport.hpp（生成代码，注释）
/**
 * @brief Register HelloWorld related TypeIdentifier.
 *        Fully-descriptive TypeIdentifiers are directly registered.
 *        Hash TypeIdentifiers require to fill the TypeObject information
 *        and hash it, consequently, the TypeObject is indirectly registered as well.
 */
eProsima_user_DllExport void register_HelloWorld_type_identifier(
        eprosima::fastdds::dds::TypeIdentifierPair& type_ids);
```

XTypes 规范定义类型的完整结构描述  TypeObject 和它的摘要标识 TypeIdentifier。这类文件在 `register_type` 时把类型的结构描述注册进全局表，之后 Discovery 过程中端点可以互相协商「我们说的是不是同一个类型」。

### 四类文件的依赖关系

```
HelloWorld.hpp（数据类型本体，零依赖）
      ▲
      │ 序列化适配引用数据类型
HelloWorldCdrAux.hpp/.ipp（CDR 模板特化，依赖 Fast-CDR）
      ▲
      │ 框架适配调用序列化特化
HelloWorldPubSubTypes.hpp/.cxx（TopicDataType 子类，依赖 Fast-DDS）
      ▲
      │ 注册时调用类型元数据注册
HelloWorldTypeObjectSupport.hpp/.cxx（TypeObject，依赖 Fast-DDS xtypes）
```


## TopicDataType：框架与类型的契约

{{< notice note >}}
本篇文章中提到的契约是指接口约定的双向义务，双方各有一条义务：
- 类型实现方的义务：想要传输数据就要实现 `serialize`、`deserialize` 等虚函数，并且行为要符合预期。
- 框架的义务：只要虚函数实现，框架就能完成序列化、缓存和传输等功能，不需要知道类型的内部结构。

契约比接口多强调了这种双向性，不只是「框架要求类型做什么」，还有「框架据此承诺什么」。比较接近的是 LSP 里氏替换原则，任何 `TopicDataType` 的子类都必须遵守基类的行为约定，框架才能无差别地使用它们。
{{< /notice >}}

上一节我们看到 `HelloWorldPubSubType` 继承自 `TopicDataType`。`TopicDataType` 就是框架对外提供的接口类，是框架与类型之间的全部契约，描述了框架对「一个可以传输的类型」的全部要求。

### TopicDataType：契约的内容

```cpp
// include/fastdds/dds/topic/TopicDataType.hpp（接口，精简）
class TopicDataType
{
public:
    virtual ~TopicDataType() = default;

    // 序列化核心 
    virtual bool serialize(const void* const data, SerializedPayload_t& payload,
                           DataRepresentationId_t data_representation);
    virtual bool deserialize(SerializedPayload_t& payload, void* data);
    virtual uint32_t calculate_serialized_size(const void* const data,
                           DataRepresentationId_t data_representation);

    // 样本内存管理 
    virtual void* create_data() = 0;
    virtual void delete_data(void* data);

    // 实例标识 
    virtual bool compute_key(const void* const data, InstanceHandle_t& ihandle,
                           bool force_md5 = false);

    // 类型特征（影响内存策略）
    virtual bool is_bounded() const;
    virtual bool is_plain(DataRepresentationId_t data_representation) const;

    // 类型元数据注册（XTypes）
    virtual void register_type_object_representation();
    // ...
};
```

`serialize`/`deserialize` 我们在上一节已经看过。`calculate_serialized_size` 在发送前计算序列化后的字节数，用于预分配 payload 内存空间。

`create_data()` 是纯虚函数，每个类型必须告诉框架怎么创建一个空的数据样本。`DataReader` 收到数据时，框架用 `create_data()` 分配样本对象，调用 `deserialize()` 填充数据后再交给用户的回调；用户执行 `take()` 之后，框架用 `delete_data()` 回收。

HelloWorld 数据结构中没有 key，有 key 的类型会在 IDL 中标注 @key 的成员。`compute_key()` 把 key 字段序列化成 InstanceHandle。InstanceHandle 决定数据样本属于哪个「实例」，影响 History 缓存的组织方式。

`is_bounded()` 返回类型序列化后的大小是否有上界，`is_plain()` 返回类型的内存布局是否和序列化布局一致。在 `DataWriterImpl::enable()` 中 bounded 或 plain 的类型可以把可动态扩容的 `PREALLOCATED_WITH_REALLOC` 内存模式降级为只能固定分配的 `PREALLOCATED`。

```cpp
// src/cpp/fastdds/publisher/DataWriterImpl.cpp（enable，精简）
// When the user requested PREALLOCATED_WITH_REALLOC, but we know the type cannot
// grow, we translate the policy into bare PREALLOCATED
if (PREALLOCATED_WITH_REALLOC_MEMORY_MODE == pool_config_.memory_policy &&
        (type_->is_bounded_ctx(type_support_context_) ||
        type_->is_plain_ctx(type_support_context_, data_representation_)))
{
    pool_config_.memory_policy = PREALLOCATED_MEMORY_MODE;
}
```

`register_type_object_representation()` 注册 TypeObject，用于 Discovery 中的类型协商。

每个虚函数还有一个 `_ctx` 后缀的变体（如 `serialize_ctx`），接收一个类型上下文对象，用于 Dynamic Types 这类需要在运行时携带额外信息的场景。普通生成类型用不到上下文，默认实现转发给无上下文版本。


### TypeSupport：契约的载体

`TypeSupport` 类继承自 `std::shared_ptr<TopicDataType>`，本质上封装了 `TopicDataType` 的智能指针，向 `DomainRTPSParticipant` 提供访问接口，是 DDS 用来收发自定义消息的类型载体。

```cpp
// include/fastdds/dds/topic/TypeSupport.hpp
class TypeSupport : public std::shared_ptr<TopicDataType>
{
public:
    using Base = std::shared_ptr<TopicDataType>;

    FASTDDS_EXPORTED_API ReturnCode_t register_type(
            DomainParticipant* participant) const;
    FASTDDS_EXPORTED_API ReturnCode_t register_type(
            DomainParticipant* participant, std::string type_name) const;
    // ...
};
```

`TypeSupport` 可以像指针一样传递、判空和比较，同一个类型对象可以被多个 Participant 注册、被多个实体引用，生命周期自动管理。

```cpp
type_ = new HelloWorldPubSubType();   // TypeSupport 的成员（隐式构造）
type_.register_type(participant_);

// src/cpp/fastdds/topic/TypeSupport.cpp
ReturnCode_t TypeSupport::register_type(DomainParticipant* participant) const
{
    return participant->register_type(*this, get_type_name());
}
```

### 注册链路闭环

`DomainParticipantImpl::register_type` 是注册类型的实际执行者：

```cpp
// src/cpp/fastdds/domain/DomainParticipantImpl.cpp
ReturnCode_t DomainParticipantImpl::register_type(
        const TypeSupport type,
        const std::string& type_name)
{
    if (type_name.size() <= 0) return RETCODE_BAD_PARAMETER;
    // 先注册类型元数据（幂等操作），把 TypeIdentifier 写进 TopicDataType
    // hello_world 最终调用 register_HelloWorld_type_identifier
    type.get()->register_type_object_representation();

    TypeSupport t = find_type(type_name);
    if (!t.empty())
    {
        if (t == type) return RETCODE_OK;// 同一个类型重复注册
        // 同名但不同类型：拒绝
        return RETCODE_PRECONDITION_NOT_MET;
    }
    std::lock_guard<std::mutex> lock(mtx_types_);
    types_.insert(std::make_pair(type_name, type));// 存入类型表

    return RETCODE_OK;
}
```

注册类型时有三个细节需要说明：

**先注册了 `TypeObject` 再去查是否有重复类型**。源码中的注释解释了原因：`register_type_object_representation()` 会把 TypeIdentifier 写入底层 `TopicDataType` 对象本身。如果先查重再注册元数据，同一个底层类型对象 `TopicDataType` 新建两个 `TypeSupport` 实例时：
- 第一次注册完成后注册表内的类型带有完整的 TypeIdentifier
- 第二个实例还没写入标识，两者标识不一致，第二次注册就会失败

必须先初始化写入类型标识，再去注册中心比对，不然相同底层类型的多个 `TypeSupport` 标识对不上，注册报错。

**同名同类型是合法的**。Publisher 和 Subscriber 在同一进程里各自 `register_type` 同一个类型（hello_world 的两个进程各自注册，或同进程同时跑 pub/sub），第二次注册返回 `RETCODE_OK` 不会冲突。

**同名不同类型被拒绝**。类型名是 Topic 匹配的一部分，同名但结构不同的类型会造成线上歧义，框架在注册时直接拒绝报错。

`types_` 就是类型存入的地方，通过 `find_type` 根据类型名取出来。

```cpp
TypeSupport type_support = participant_->find_type(topic->get_type_name());
```

取出的 `TypeSupport` 被交给 `DataWriterImpl` 的成员 `type_` 持有，`write()` 时调用它的 `serialize_ctx()`。

到这里整个类型注册的链路闭环：

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260807112354524.png)


### 总结

回头看契约设计的核心：框架只依赖 `TopicDataType` 接口，从不接触具体类型。`write()` 的 `void*` 参数、`create_data()` 的 `void*` 参数、类型表里存的 `shared_ptr<TopicDataType>`，在框架的视角中没有任何 `HelloWorld`。

这种设计带来两个直接结果：
1. 类型来源不受限：fastddsgen 生成的类型、手动实现接口的类型、运行时动态构建的类型，在框架眼里没有区别。
2. 序列化策略不受限：CDR 只是约定的选择，`TopicDataType` 的实现者可以用任何编码，只要收发两端一致即可。


## CDR 编码：@extensibility 改变了什么

`HelloWorld.idl `里那行 `@extensibility(APPENDABLE)` 到底改变了什么？要回答它，得先看 CDR 编码的基本规则，再看 Fast-DDS 支持的两种编码版本。

### CDR 的基本规则

**CDR**（Common Data Representation）的核心规则很朴素：成员按顺序序列化，每个值对齐到自己的自然边界。对齐的意思是：一个 4 字节的整数必须放在 4 字节整数倍的位置上，如果当前位置不满足，就插入填充字节。

HelloWorld 只有 uint32 和 string 两种成员，对齐恰好都满足，看不出填充。换一个类型就明显了：

```idl
struct Padded {
    octet a;           // 1 字节
    unsigned long b;   // 4 字节，需要 4 字节对齐
};
```

`a` 之后要插入 3 个填充字节，`b` 才能放在 4 字节边界上。序列化结果比字段本身多出 3 字节。对齐规则的细节包括 XCDR v1 和 v2 的差异会在后续专门讨论 Fast-CDR 的番外篇展开，这里只需要知道"有填充存在"，读字节布局时才不会对不上数。

每个 RTPS DATA 报文的 payload 还有一个 4 字节的封装头，标识**字节序**和**编码算法**：

```cpp
// src/cpp/fastcdr/Cdr.cpp（serialize_encapsulation，精简）
encapsulation = (encoding_flag_ | endianness_);
(*this) << encapsulation;
```

编码算法标志定义在 Fast-CDR：

```cpp
typedef enum : uint8_t
{
    PLAIN_CDR = 0x0,
    PL_CDR = 0x2,
    PLAIN_CDR2 = 0x6,
    DELIMIT_CDR2 = 0x8,
    PL_CDR2 = 0xa
} EncodingAlgorithmFlag;
```

接收端读封装头就知道后面的字节流该用哪种算法解析。


### HelloWorld 的字节布局

用第一条消息（index=1，message="Hello world"）实际看一下两种编码的字节布局。

**XCDRv1**（PLAIN_CDR）：

```
偏移    内容                                字节数
0-3     封装头：00 01 | 00 00（CDR 小端）      4
4-7     index = 1：01 00 00 00               4
8-11    字符串长度 = 12（含结尾 \0）            4
12-23   "Hello world\0"                     12
                                         合计：24 字节
```

成员一个接一个排布，没有任何额外结构。

**XCDRv2**（DELIMIT_CDR2）：

```
偏移    内容                                字节数
0-3     封装头：00 09 | 00 00（DELIMIT 小端）  4
4-7     dheader = 20（类型内容总长度）          4
8-11    index = 1                            4
12-15   字符串长度 = 12                       4
16-27   "Hello world\0"                     12
                                         合计：28 字节
```

偏移 4-7 多了一个 **dheader**（delimiter header），记录后面类型内容的总字节数。多花 4 个字节记录类型边界的描述，Reader 不用知道类型定义就能知道这个类型的字节流在哪里结束。


### dheader 的写入与跳过

dheader 的写入在 Fast-CDR 里是个「先占位、后回填」的过程：

```cpp
// Fast-CDR: src/cpp/Cdr.cpp
Cdr& Cdr::xcdr2_begin_serialize_type(Cdr::state& current_state,
                                     EncodingAlgorithmFlag type_encoding)
{
    if (EncodingAlgorithmFlag::PLAIN_CDR2 != type_encoding)
    {
        uint32_t dheader {0};
        serialize(dheader);    // 先写 0 占位
    }
    // ...
}

Cdr& Cdr::xcdr2_end_serialize_type(const Cdr::state& current_state)
{
    if (EncodingAlgorithmFlag::PLAIN_CDR2 != current_encoding_)
    {
        auto last_offset = offset_;
        set_state(current_state);                    // 回到 dheader 位置
        serialize(static_cast<uint32_t>(member_serialized_size));  // 回填真实长度
        jump(member_serialized_size);                // 跳回末尾
    }
    // ...
}
```

读取端的 dheader 可以支持跳过未知成员：

```cpp
// Fast-CDR: src/cpp/Cdr.cpp（xcdr2_deserialize_type，精简）
Cdr& Cdr::xcdr2_deserialize_type(
        EncodingAlgorithmFlag type_encoding,
        std::function<bool (Cdr&, const MemberId&)> functor)
{
    if (EncodingAlgorithmFlag::PLAIN_CDR2 != type_encoding)
    {
        uint32_t dheader {0};
        deserialize(dheader);   // 先读类型内容的总长度

        Cdr::state current_state(*this);
        current_encoding_ = type_encoding;

        if (EncodingAlgorithmFlag::PL_CDR2 == current_encoding_)
        {
            //... 
        }
        else
        { // DELIMIT_CDR2 处理分支
            next_member_id_ = MemberId(0);
            // 按序读取成员，直到内容读完或回调返回 false
            while (offset_ - current_state.offset_ < dheader 
                    && functor(*this, next_member_id_))
            {
                ++next_member_id_.id;
            }
            size_t jump_size = dheader - (offset_ - current_state.offset_);
            jump(jump_size);

            next_member_id_ = current_state.next_member_id_;
        }

        current_encoding_ = current_state.previous_encoding_;
    }
    // ... PLAIN_CDR2 处理
    return *this;
}
```

现在可以完整回答 APPENDABLE 的兼容性问题了。假设类型演进过程中，新版本追加了第三个成员：

```idl
struct HelloWorld {
    unsigned long index;      // MemberId(0)
    string message;           // MemberId(1)
    unsigned long timestamp;  // MemberId(2)，新版本追加
};
```

新 Writer 发送的消息带着 `timestamp`，dheader = 28。旧 Reader（只认识成员 0 和 1）的反序列化过程：

1. 读 dheader = 28，知道类型内容有 28 字节
2. 回调依次处理成员 0、1，消费了 20 字节
3. 回调遇到成员 2，生成代码的 switch 落入 `default` 分支，返回 false，循环终止
4. `jump_size = 28 - 20 = 8`，跳过 8 字节正好是 `timestamp` 的长度

旧 Reader 解析时忽略了不认识的成员，dheader 提供了内容长度才能让 Reader 在解析时知道要跳过数据中多少长度，这就是 APPENDABLE 在 XCDRv2 下的实现本质。

XCDRv1 把 APPENDABLE 类型编码为 `PLAIN_CDR`，没有 dheader，兼容性只能依赖新增成员只追加在末尾的约定上。XCDRv2 的 dheader 把这个约定变成了结构保证。

XTypes 还有第三种扩展性 `MUTABLE`，允许成员任意增删重排。对应 `PL_CDR2` 编码，每个成员带独立的头部，未知成员按头部记录的尺寸逐个跳过，代价是更多的头部开销。


### DataRepresentationQosPolicy：版本协商

一个 Writer 用 XCDRv1 编码但是 Reader 却只懂 XCDRv2，通信就会失败，数据写入端 `DataWriter` 和读取端 `DataReader` 必须协商确定双方要用哪一种数据表示格式才能正确进行通信。

整套格式协商规则由 `DataRepresentationQosPolicy` 来管理，内部是一个支持列表，声明当前端点使用哪些数据表达方式。

Writer 侧在 `enable` 时确定实际使用的版本：

```cpp
// src/cpp/fastdds/publisher/DataWriterImpl.cpp（enable，精简）
ReturnCode_t DataWriterImpl::enable()
{

    {
        std::lock_guard<std::mutex> qos_guard(qos_mutex_);

        // Set Datawriter's DataRepresentationId taking into account the QoS.
        data_representation_ = qos_.representation().m_value.empty()
                || XCDR_DATA_REPRESENTATION == qos_.representation().m_value.at(0)
                        ? XCDR_DATA_REPRESENTATION : XCDR2_DATA_REPRESENTATION;
    }
}
```

默认取列表第一项，列表为空时默认 XCDR v1。这个值最终传进 `HelloWorldPubSubType::serialize()` 决定构造 Cdr 时用哪个版本、设置哪个编码标志。

Writer 和 Reader 的表示列表是否兼容，在端点匹配阶段检查，我们在下一篇 Discovery 详细讲解。


## Fast-CDR：独立的序列化引擎


最后再次说明一下编码库的代码目录。Fast-CDR 是一个独立于 Fast-DDS 的库，核心组件包括：

| 组件 | 源码位置 | 职责 |
|---|---|---|
| `Cdr` | `Fast-CDR/src/cpp/Cdr.cpp` | 序列化引擎：按版本分派编码算法（本节看到的 `xcdr1_*`/`xcdr2_*` 函数族） |
| `CdrSizeCalculator` | `Fast-CDR/src/cpp/CdrSizeCalculator.cpp` | 序列化前计算尺寸，供 payload 预分配 |
| `FastBuffer` | `Fast-CDR/src/cpp/FastBuffer.cpp` | 缓冲区抽象，管理读写位置 |

Fast-DDS 通过模板特化把用户类型接入 DDS 中间件，DDS 本身对用户类型一无所知。

对齐规则的完整细节（XCDR v1/v2 的对齐差异、成员头格式、CdrSizeCalculator 怎么把对齐算进尺寸）值得单独一篇，本系列会安排番外篇专门讨论 Fast-CDR。


## Dynamic Types：不生成代码的类型定义方式

前面我们讲了这么多都有一个前提，类型在编译期间就已经通过 IDL 确定，fastddsgen 生成代码后编译进程序。

但是有些场景无法在编译期间就能确定数据类型，比如插件系统中的消息类型由当前的插件在运行时定义，或者消息类型是由配置决定的。

Fast-DDS 定义了 Dynamic Types，类型在运行时用 API 来构建，不经过代码生成。


### 用 API 构建类型

我们来看 `xtypes` 示例中是如何在运行时创建一个跟 `HelloWorld` IDL 版本中一样的结构。

```cpp
DynamicType::_ref_type PublisherApp::create_type(
        bool use_xml_type)
{
    DynamicTypeBuilder::_ref_type struct_builder;
    if (use_xml_type) {
        // XML 中加载
    } else {
        // 描述类型 HelloWorld 结构体
        TypeDescriptor::_ref_type type_descriptor {
            traits<TypeDescriptor>::make_shared()
        };
        type_descriptor->kind(TK_STRUCTURE);
        type_descriptor->name("HelloWorld");
        struct_builder = 
            DynamicTypeBuilderFactory::get_instance()->create_type(type_descriptor);

        // 成员：index
        MemberDescriptor::_ref_type index_member_descriptor {
            traits<MemberDescriptor>::make_shared()
        };
        index_member_descriptor->name("index");
        index_member_descriptor->type(
            DynamicTypeBuilderFactory::get_instance()->get_primitive_type(TK_UINT32)
        );
        if (RETCODE_OK != struct_builder->add_member(index_member_descriptor))
            throw std::runtime_error("Error adding index member");

        // Add message member
        MemberDescriptor::_ref_type message_member_descriptor {
            traits<MemberDescriptor>::make_shared()
        };
        message_member_descriptor->name("message");
        message_member_descriptor->type(
            DynamicTypeBuilderFactory::get_instance()->create_string_type(
                static_cast<uint32_t>(LENGTH_UNLIMITED))->build()
        );
        if (RETCODE_OK != struct_builder->add_member(message_member_descriptor))
            throw std::runtime_error("Error adding message member");
    }

    // 构建类型
    return struct_builder->build();
}
```

对照着 `HelloWorld.idl` 来看这个构建过程：`TypeDescriptor` 对应 `struct HelloWorld`，两个 `MemberDescriptor` 对应两个字段，成员按添加顺序获得 MemberId 0 和 1。

类型定义也可以写在 XML 里，运行时用 `get_dynamic_type_builder_from_xml_by_name` 创建类型。例如 xtypes 示例目录下的 `xtypes_complete_profile.xml` 文件中定义的类型：

```xml
<types>
    <type>
        <struct name="HelloWorld">
            <member name="index" type="uint32"/>
            <member name="message" type="string"/>
        </struct>
    </type>
</types>
```

### 接入框架：同一个契约

构建出的 `DynamicType` 怎么交给框架？答案跟 `HelloWorldPubSubType` 一样，通过包装成 `TopicDataType` 实现：

```cpp
PublisherApp::PublisherApp(
        const CLIParser::config& config,
        const std::string& topic_name)
{
    // Create the type
    DynamicType::_ref_type dynamic_type = create_type(config.use_xml);
    // Set up the data type with initial values
    hello_ = DynamicDataFactory::get_instance()->create_data(dynamic_type);
    hello_->set_uint32_value(hello_->get_member_id_by_name("index"), 0);
    hello_->set_string_value(
        hello_->get_member_id_by_name("message"), "Hello xtypes world");

    // DynamicPubSubType 继承自 TopicDataType
    // 我们前面讲过 TypeSupport 继承自 std::shared_ptr<TopicDataType>
    TypeSupport type(new DynamicPubSubType(dynamic_type));
    if (RETCODE_OK != type.register_type(participant_))
        throw std::runtime_error("Type registration failed");
    //...
}
```

在框架视角中，动态类型和生成类型没有任何区别。序列化引擎只认 `TopicDataType`，不关心类型是编译期生成的还是运行时构建的。

差别在数据操作侧。静态类型的数据是 `HelloWorld` 对象，成员访问是编译期绑定的 `hello_.index()`；动态类型的数据是 `DynamicData`，成员访问通过运行时查询：

```cpp
// examples/cpp/xtypes/PublisherApp.cpp（精简）
uint32_t PublisherApp::get_uint32_value(
        const DynamicData::_ref_type data,
        const std::string& member_name)
{
    uint32_t ui32 {0};
    // 按成员名查 MemberId，再读写值
    if (RETCODE_OK != 
        data->get_uint32_value(ui32, data->get_member_id_by_name(member_name)))
    {
        auto error_msg = "Error getting " + member_name + " value";
        throw std::runtime_error(error_msg);
    }

    return ui32;
}
```

### 类型信息传播：complete 与 minimal

我们使用静态类型的结构定义在两端各自生成的代码里，通信两端知道类型是什么。但是动态类型的结构只在构建的一端，那么另一端是怎么知道的？

答案在我们讲过的生成的第四类代码文件 `TypeObject` 中。无论静态还是动态类型，都可以注册自己的结构描述，例如 xtypes 示例中注册类型时调用 `register_type_object_representation()`。

Discovery 过程中，端点把类型标识 TypeIdentifier 放进 SEDP 报文，远端根据标识判断这个 Topic 的类型自己认不认识、兼不兼容。

TypeObject 有两种粒度的配置，xtypes 示例的两个 profile 文件正好各演示一种：

```xml
<!-- xtypes_complete_profile.xml -->
<property>
    <name>fastdds.type_propagation</name>
    <value>enabled</value>               <!-- 传播完整 TypeObject -->
</property>

<!-- xtypes_minimal_profile.xml -->
<property>
    <name>fastdds.type_propagation</name>
    <value>minimal_bandwidth</value>     <!-- 只传播最小 TypeObject -->
</property>
```

- **complete**(`enabled`) 传播完整的类型结构：每个成员的名字、类型、注解都可传递。对端可以精确对比两个类型的差异，支持工具 introspect 类型结构。代价是 Discovery 报文更大。
- **minimal**(`minimal_bandwidth`) 只传播最小信息：成员的 ID、类型和关键标志，名字等描述性信息省略。Discovery 开销小，但类型兼容性判断的能力也弱一些。

这是一个典型的带宽换信息的取舍。对大多数静态类型应用，两端类型定义一致，默认配置就够用；动态类型场景中类型可能每个节点不同，才需要认真选择传播策略。

本篇没有说明 XTypes 规范中 TypeObject 的完整数据模型（嵌套类型、注解、别名等），以及远端按 TypeIdentifier 主动查询完整 TypeObject 的 RPC 机制 TypeLookup Service。如果有机会后面会通过单独的文章来讲解，这里先建立认知：类型结构是数据，`TopicDataType` 是契约，`TypeObject` 是结构描述在线上传输和 Discovery 的载体。


## 从 IDL 到字节流的全景

把整条路径串成一张图：

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260807230236346.png)

`write()` 的 `void*` 为什么能被正确序列化？因为类型信息从来没有丢失，它在 `register_type()` 时以 `TypeSupport` 的形式存入 Participant 的类型表，创建 `DataWriter` 时被 `find_type()` 找回并绑定到端点，写入时通过 `TopicDataType` 接口完成 `void*` 到具体类型的还原。

这篇反复出现的设计模式有两个：

- **分层分离**。`fastddsgen` 生成四类文件，类型本体、序列化逻辑、框架适配、类型元数据各占一层，每层只依赖下一层。数据类型不依赖中间件，序列化引擎不认识用户类型，框架只认接口。
- **契约模式**。`TopicDataType` 是框架与类型之间的唯一契约。这个契约让类型来源完全开放：生成代码、手写实现、运行时动态构建，三条路在框架眼里没有区别。Dynamic Types 不是框架的扩展功能，而是契约模式的自然结果。


还有一个贯穿编码层的机制值得记住：扩展性注解决定编码算法。FINAL → PLAIN，APPENDABLE → DELIMIT（XCDRv2 下的 dheader），MUTABLE → 参数列表。类型演进的兼容性不是靠约定维持的，而是编码结构本身提供的保证。

在本篇中我们提到了类型信息在注册时通过 `register_type_object_representation()` 把 TypeObject 存进了全局表。这份类型描述在 Discovery 阶段会被写进 SEDP 报文，让远端节点判断「这个 Topic 传的类型我能不能接收」。但 Discovery 还要解决更基础的问题：两个进程启动之后怎么发现对方的存在，端点匹配的条件是什么。我们将在下一篇中探索控制面 SPDP 协议和 SEDP 协议。

