+++
title = "FastDDS 快速上手：从源码编译到第一个 Hello World"
description = "一篇带你从零编译安装 FastDDS、跑通发布/订阅示例、理解核心概念和 QoS 策略的中文指南"
date = "2026-07-30"
aliases = ["DDS"]
author = "ChnjFan"
tags = [
    "ROS",
    "DDS",
]
+++

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260731163135855.png)

ROS 2 的底层通信默认就是 FastDDS 在干活。

但当你需要绕过 ROS 的抽象层，直接控制 QoS、调整可靠性策略、或者在不装 ROS 的嵌入式设备上跑 DDS 通信时，ROS 2 的封装反而成了阻碍。

这篇文章带你从零开始，在 30 分钟内独立跑通第一个 FastDDS 发布/订阅程序。

## FastDDS 是什么？

数据分发服务（DDS）是采用**数据为中心的发布订阅（DCPS）模型**的通信协议，用于分布式应用程序之间的通信与系统集成。通过定义 API 与通信行为和服务质量 QoS，使得数据生产者能够高效地将信息分配给数据消费者。

跟 MQTT 不同，DDS 没有 broker。参与者之间通过多播自动发现对方，数据直接走 UDP 传输。这意味着没有单点故障，延迟也更低，因此用于机器人和智能驾驶的通信中。

Fast DDS 是 C++ 实现的 DDS 开源库，是 ROS 2 的默认中间件。

当你需要精细控制 QoS 策略、在不装 ROS 的嵌入式设备上跑 DDS 通信、或者排查 ROS 2 底层的通信问题时，直接面对 FastDDS 就成了绕不开的一步。

## 从源码编译安装

这篇文章基于 Ubuntu 22.04。如果你用的是 20.04，步骤一样，但要注意默认的 CMake 版本是 3.16，刚好够用。更老的系统需要手动升级 CMake。

### 安装依赖

```bash
sudo apt update
sudo apt install -y \
    git \
    cmake \
    g++ \
    python3-pip \
    libasio-dev \
    libtinyxml2-dev \
    libssl-dev
```

`libasio-dev` 是网络和底层 IO 的C++库，提供异步模型，`libtinyxml2-dev` 用来解析 XML 配置文件，`libssl-dev` 是 OpenSSL 提供用于 TLS 和 SSL 协议的工具包，也是通用的加密库。

### 编译 Foonathan memory

Foonathan memory 是一个轻量级 C++ 内存库，解决了一些 STL 分配器模型的缺陷。

```bash
git clone https://github.com/eProsima/foonathan_memory_vendor.git
mkdir foonathan_memory_vendor/build
cd foonathan_memory_vendor/build
cmake .. -DCMAKE_INSTALL_PREFIX=/usr/local -DBUILD_SHARED_LIBS=ON
cmake --build . --target install
```

### 编译 FastCDR

FastCDR 是 FastDDS 的序列化库，必须先装。

```bash
git clone https://github.com/eProsima/Fast-CDR.git
cd Fast-CDR
mkdir build && cd build
cmake .. -DCMAKE_INSTALL_PREFIX=/usr/local
sudo cmake --build . --target install
```

`-DCMAKE_INSTALL_PREFIX=/usr/local` 指定安装路径。用 `/usr/local` 是因为 ROS 2 的 FastDDS 也装在这里，路径统一可以避免后续找不到库的麻烦。

### 编译 FastDDS

安装完成所有的依赖后，开始安装 FastDDS，并且编译 examples 示例代码。

```bash
git clone https://github.com/eProsima/Fast-DDS.git
cd Fast-DDS
git checkout v2.14.2
mkdir build && cd build
cmake .. -DCMAKE_INSTALL_PREFIX=/usr/local -DCOMPILE_EXAMPLES=ON
sudo cmake --build . --target install
```

`git checkout v2.14.2` 切到最新的稳定版。如果你直接编 `main` 分支，有可能遇到还没修完的 bug。

### 更新动态库缓存

```bash
sudo ldconfig
```

这一步经常忘。不跑的话，编译你自己的程序时会报 `error while loading shared libraries: libfastrtps.so.xxx: cannot open shared object file`。

### 验证安装

```bash
fastddsgen -version
```

输出版本号就说明装好了。

## 核心概念速览

理解 DCPS 模型的概念是学习 FastDDS 代码的基础。在 DCPS 模型中为通信系统开发定义了四个基本元素：Publisher、Subscriber、Topic 和 Domain。

### 对象层级

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260731102604550.png)

- **Domain** 是逻辑隔离的通信空间。不同 Domain 之间的参与者互相看不到，就像两个平行世界。Domain ID 是一个整数，相同 ID 的参与者才能感知彼此进行通信。
- **Participant** 是一个 DDS 通信实体。一个进程通常只创建一个 Participant，它是所有 Publisher 和 Subscriber 的母体。
- **Publisher** 和 **Subscriber** 是数据流向的抽象。Publisher 负责发数据，Subscriber 负责收数据。它们本身不直接碰数据，而是通过下属的 DataWriter 和 DataReader 来干活。
- **Topic** 是数据的逻辑通道，由名称和数据类型唯一标识。发布者写了一个叫 `"HelloWorldTopic"` 的 Topic，订阅者也得监听同名且同类型的 Topic，双方才能匹配上。
- **DataWriter** 和 **DataReader** 是真正执行读写的对象。QoS 策略挂在它们上面，控制可靠性、历史深度、持久性等行为。

### 去中心化发现

DDS 和 MQTT 最大的架构差异是没有 broker。参与者通过多播自动交换彼此的信息：谁在线、发布了哪些 Topic、QoS 是什么。这个过程叫 PDP（Participant Discovery Protocol），之后还有 EDP（Endpoint Discovery Protocol）来匹配 DataWriter 和 DataReader。

这意味着没有单点故障。一台机器挂了，其他机器之间的通信不受影响。但这也意味着网络环境必须支持多播，否则参与者互相发现不了。

### 数据类型

FastDDS 的数据类型通过 IDL（Interface Definition Language）定义，然后用 `fastddsgen` 工具生成 C++ 代码。

典型的 IDL 文件结构：

```idl
struct HelloWorld
{
    unsigned long index;
    string message;
};
```

`fastddsgen` 会为这个结构生成序列化/反序列化代码，以及一个 `HelloWorldPubSubType` 类。你在创建 DataWriter 和 DataReader 的时候需要把这个类型注册进去，这样 FastDDS 才知道怎么编解码数据。

### QoS 策略速览

QoS（Quality of Service）控制 DDS 通信的行为。最常用的几个：

| 策略 | 默认值 | 作用 |
|------|--------|------|
| Reliability | BEST_EFFORT | 是否保证数据不丢 |
| Durability | VOLATILE | 是否为晚来的订阅者保留历史数据 |
| History | KEEP_LAST(1) | 保留最近 N 条数据 |
| Deadline | 无穷大 | 数据的最大发布间隔 |

DataWriter 和 DataReader 的 QoS 必须兼容才能匹配。比如 Writer 设了 RELIABLE，Reader 设了 BEST_EFFORT，双方不会建立连接。后面的 QoS 配置实验会动手验证这一点。

## 第一个示例：HelloWorld 发布/订阅

### 配置 CMake 项目

DDS 项目依赖 Fast DDS 和 Fast CDR 库。

```cmake
cmake_minimum_required(VERSION 3.20)

project(DDSHelloWorld)

# Find requirements
if(NOT fastcdr_FOUND)
    find_package(fastcdr 2 REQUIRED)
endif()

if(NOT fastdds_FOUND)
    find_package(fastdds 3 REQUIRED)
endif()

# Set C++11
include(CheckCXXCompilerFlag)
if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_COMPILER_IS_CLANG OR
        CMAKE_CXX_COMPILER_ID MATCHES "Clang")
    check_cxx_compiler_flag(-std=c++11 SUPPORTS_CXX11)
    if(SUPPORTS_CXX11)
        add_compile_options(-std=c++11)
    else()
        message(FATAL_ERROR "Compiler doesn't support C++11")
    endif()
endif()

message(STATUS "Configuring HelloWorld publisher/subscriber example...")
file(GLOB DDS_HELLOWORLD_SOURCES_CXX "src/*.cxx")
```

### 构建 Topic 数据类型

使用 Fast DDS-Gen 可以通过接口描述语言（IDL）文件中定义的数据类型生成源代码。

```idl
// HelloWorld.idl
struct HelloWorld
{
    unsigned long index;
    string message;
};
```

`fastddsgen` 工具可以生成 TOPIC 的 C++定义，也可以同时生成功能示例代码。

```bash
fastddsgen HelloWorld.idl
fastddsgen -example CMake HelloWorld.idl
```

生成的文件包括：

```
HelloWorld.hpp                      HelloWorld 类型定义。
HelloWorldPubSubTypes.cxx           Fast DDS 用于支持 HelloWorld 类型的接口。
HelloWorldPubSubTypes.hpp           HelloWorldPubSubTypes.cxx 的头文件。
HelloWorldCdrAux.ipp                HelloWorld 类型的序列化与反序列化代码。
HelloWorldCdrAux.hpp                HelloWorldCdrAux.ipp 的头文件。
HelloWorldTypeObjectSupport.cxx     TypeObject 表示的注册代码。
HelloWorldTypeObjectSupport.hpp     HelloWorldTypeObjectSupport.cxx 的头文件。
```

### Publisher

```cpp
// 实现发布者的 HelloWorldPublisher 类
class HelloWorldPublisher
{
private:
    HelloWorld hello_;                  // 实际发送的数据，write() 会序列化它
    DomainParticipant* participant_;    // DDS 对象实例，工厂模式创建
    Publisher* publisher_;
    Topic* topic_;
    DataWriter* writer_;                // 挂着 PubListener，感知订阅者上下线，发送数据
    TypeSupport type_;                  // 管理数据类型的注册，FastDDS 需要它来完成序列化

    // 监听器挂到 DataWriter 上，用来感知订阅者的上下线
    // 只有 matched_ > 0 时才发数据，避免对空写数据
    class PubListener : public DataWriterListener
    {
    public:
        PubListener();
        ~PubListener() override;
        // 有新的 DataReader 监听发布主题
        void on_publication_matched(DataWriter*, const PublicationMatchedStatus& info) override;

        std::atomic_int matched_;

    } listener_;

public:

    HelloWorldPublisher();
    virtual ~HelloWorldPublisher();
    bool init();
    bool publish();
    void run(uint32_t samples);
};
```

通过继承 `DataWriterListener` 并重写 `on_publication_matched` 可以监听数据发布后的订阅状态。

```cpp
void HelloWorldPublisher::PubListener::on_publication_matched(
    DataWriter*,
    const PublicationMatchedStatus& info) override
{
    if (info.current_count_change == 1) {
        matched_ = info.total_count;
        std::cout << "Publisher matched." << std::endl;
    } else if (info.current_count_change == -1) {
        matched_ = info.total_count;
        std::cout << "Publisher unmatched." << std::endl;
    } else {
        std::cout << info.current_count_change
                << " is not a valid value for PublicationMatchedStatus current count change." << std::endl;
    }
}
```

`PublicationMatchedStatus` 告诉发布者关于订阅者匹配状态的变化。其中，`info.current_count_change` 是最有用的字段：+1 表示有新订阅者上线，-1 表示有订阅者断开，0 表示没有变化。`info.total_count` 是当前匹配的订阅者总数。

`HelloWorldPublisher` 类的构造函数和析构函数定义如下：

```cpp
HelloWorldPublisher::HelloWorldPublisher()
    : participant_(nullptr)
    , publisher_(nullptr)
    , topic_(nullptr)
    , writer_(nullptr)
    , type_(new HelloWorldPubSubType()) { }

virtual HelloWorldPublisher::~HelloWorldPublisher()
{
    if (writer_ != nullptr) {
        publisher_->delete_datawriter(writer_);
    } if (publisher_ != nullptr) {
        participant_->delete_publisher(publisher_);
    } if (topic_ != nullptr) {
        participant_->delete_topic(topic_);
    }
    DomainParticipantFactory::get_instance()->delete_participant(participant_);
}
```

构造函数将类的私有数据成员初始化为 `nullptr`，但 `TypeSupport` 对象除外，该对象被初始化为 `HelloWorldPubSubType` 类的实例。

类的析构函数会移除这些数据成员，从而清理系统内存。

构造发布者实例后，通过 `init` 初始化成员，主要包括：
1. 初始化 `HelloWorld` 类型成员内容；
2. 为 DomainParticipant 配置 QoS 并通过 `DomainParticipantFactory` 工厂创建通信实体；
3. 将 IDL 数据类型注册到 DomainParticipant 中；
4. 创建发布数据的 TOPIC；
5. 创建发布者 Publisher；
6. 使用监听器 PubListener 创建 DataWriter。

```cpp
//!Initialize the publisher
bool HelloWorldPublisher::init()
{
    hello_.index(0);
    hello_.message("HelloWorld");

    DomainParticipantQos participantQos;
    participantQos.name("Participant_publisher");
    participant_ = DomainParticipantFactory::get_instance()->create_participant(0, participantQos);
    if (participant_ == nullptr) {
        return false;
    }

    // Register the Type
    type_.register_type(participant_);

    // Create the publications Topic
    topic_ = participant_->create_topic("HelloWorldTopic", "HelloWorld", TOPIC_QOS_DEFAULT);
    if (topic_ == nullptr) {
        return false;
    }

    // Create the Publisher, use default qos
    publisher_ = participant_->create_publisher(PUBLISHER_QOS_DEFAULT, nullptr);
    if (publisher_ == nullptr) {
        return false;
    }

    // Create the DataWriter
    writer_ = publisher_->create_datawriter(topic_, DATAWRITER_QOS_DEFAULT, &listener_);
    if (writer_ == nullptr) {
        return false;
    }
    return true;
}
```

`publish` 通过监听器记录是否存在匹配的 DataReader 来决定是否发布数据。

```cpp
//!Send a publication
bool HelloWorldPublisher::publish()
{
    if (listener_.matched_ > 0) {
        hello_.index(hello_.index() + 1);
        writer_->write(&hello_);
        return true;
    }
    return false;
}
```

指定发布操作的次数来运行发布者：

```cpp
//!Run the Publisher
void run(uint32_t samples)
{
    uint32_t samples_sent = 0;
    while (samples_sent < samples) {
        if (publish()) {
            samples_sent++;
            std::cout << "Message: " << hello_.message() << " with index: " << hello_.index()
                        << " SENT" << std::endl;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1000));
    }
}
```

最后，`HelloWorldPublisher` 在 `main` 函数中完成初始化并运行。

```cpp
int main(int argc, char** argv)
{
    std::cout << "Starting publisher." << std::endl;
    uint32_t samples = 10;

    HelloWorldPublisher* mypub = new HelloWorldPublisher();
    if(mypub->init()) {
        mypub->run(samples);
    }

    delete mypub;
    return 0;
}
```

在 `CMakeList.txt` 中添加构建可执行文件所需的所有源文件，并将可执行文件与库链接在一起。

```cmake
add_executable(DDSHelloWorldPublisher src/HelloWorldPublisher.cpp ${DDS_HELLOWORLD_SOURCES_CXX})
target_link_libraries(DDSHelloWorldPublisher fastdds fastcdr)
```

### Subscriber

订阅者有一部分实现与发布者相同，这一节只介绍了不同的实现。

```cpp
class HelloWorldSubscriber
{
private:
    DomainParticipant* participant_;
    Subscriber* subscriber_;    // 负责创建和配置 DataReader
    DataReader* reader_;        // 挂着 SubListener，数据到达时触发 on_data_available
    Topic* topic_;
    TypeSupport type_;

    class SubListener : public DataReaderListener
    {
    public:
        SubListener();
        ~SubListener() override;
        void on_subscription_matched(
                DataReader*,
                const SubscriptionMatchedStatus& info) override;
        void on_data_available(DataReader* reader) override;
        HelloWorld hello_;
        std::atomic_int samples_;
    }
    listener_;

public:

    HelloWorldSubscriber();
    virtual ~HelloWorldSubscriber();
    bool init();
    void run(uint32_t samples);
};
```

订阅监听器的第一个重写回调是 `on_subscription_matched`，它与 DataWriter 监听器的 `on_publication_matched` 回调功能类似。

第二个重写的回调是 `on_data_available`，回调中获取 DataReader 可以访问的下一个接收数据 `SampleInfo` 进行处理。其中 `SampleInfo` 对象用来判断数据是否已经被读取，每次读取都会增加接收计数器。

```cpp
void on_data_available(DataReader* reader) override
{
    SampleInfo info;
    if (reader->take_next_sample(&hello_, &info) == eprosima::fastdds::dds::RETCODE_OK) {
        if (info.valid_data) {
            samples_++;
            std::cout << "Message: " << hello_.message() << " with index: " << hello_.index()
                      << " RECEIVED." << std::endl;
        }
    }
}
```

订阅者与发布者构造函数和初始化类似，使用默认的 QoS 级别，区别是创建 subscriber 和 datareader。

```cpp
//!Initialize the subscriber
bool HelloWorldSubscriber::init()
{
    // ... 与发布者相同，初始化 DomainParticipant、Topic

    // Create the Subscriber
    subscriber_ = participant_->create_subscriber(SUBSCRIBER_QOS_DEFAULT, nullptr);
    if (subscriber_ == nullptr) {
        return false;
    }

    // Create the DataReader
    reader_ = subscriber_->create_datareader(topic_, DATAREADER_QOS_DEFAULT, &listener_);
    if (reader_ == nullptr) {
        return false;
    }

    return true;
}
```

`run` 确保订阅者一直运行接收所有的数据，具体数据接收处理在 `on_data_available` 中。

```cpp
//!Run the Subscriber
void HelloWorldSubscriber::run(uint32_t samples)
{
    while (listener_.samples_ < samples) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}
```

在 `CMakeList.txt` 中增加订阅者执行程序。

```cmake
add_executable(DDSHelloWorldSubscriber src/HelloWorldSubscriber.cpp ${DDS_HELLOWORLD_SOURCES_CXX})
target_link_libraries(DDSHelloWorldSubscriber fastdds fastcdr)
```

## 编译运行并验证

项目准备好后构建、编译并运行订阅者和发布者应用程序。

```bash
cmake ..
cmake --build .
./DDSHelloWorldSubscriber
./DDSHelloWorldPublisher
```

先启动订阅者，再启动发布者。订阅者终端应该打印 Message: HelloWorld with index: N RECEIVED.，index 从 1 到 10。发布者终端打印 Publisher matched. 后开始逐条发送。

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260731123226374.png)
