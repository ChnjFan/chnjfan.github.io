+++
title = "基于 Boost.Beast 构建 C++ HTTP 服务器 —— IMServer GateServer 实战"
description = "从零构建一个生产级 C++ HTTP 网关：多线程 io_context 池、异步连接管理、路径路由分发、JSON 协议转换、gRPC 后端集成。"
date = "2026-07-04"
aliases = ["boost.beast", "http server"]
author = "ChnjFan"
tags = [
    "C++",
    "Network",
    "HTTP",
]
categories = [
    "基础技术",
]
+++

## 项目背景和整体架构

IMServer 是一个多服务即时消息后端，根据 B 站大佬**@恋恋风辰zack**的项目实战课程实现，由五个独立进程组成：

| 服务               | 职责                                                         |
| ------------------ | ------------------------------------------------------------ |
| **GateServer**     | HTTP 网关，面向客户端提供 REST API（注册、登录、验证码等）   |
| **ChatServer**     | TCP 长连接服务，核心 IM 消息路由                             |
| **StatusServer**   | gRPC 服务，用户在线状态与 ChatServer 负载均衡                |
| **VerifyServer**   | Node.js 服务，邮件验证码生成与发送                           |
| **ResourceServer** | 资源服务，聊天中的图片、音频、视频以及用户头像等资源文件上传和下载 |

### GateServer 在系统中的位置

本文聚焦于 **GateServer** —— 它是客户端 HTTP 请求的唯一入口，负责接收 REST API 调用、校验参数、转发到后端 gRPC 服务、返回 JSON 结果。

![20260706150111942.svg](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260706150111942.svg)

### 为什么选择 Boost.Beast

C++ HTTP 框架不少，Crow、Drogon、oatpp、cpp-httplib 都是热门选择。GateServer 选择 Boost.Beast 的原因：

- **与现有技术栈统一**：项目中 ChatServer 使用 Boost.Asio 处理 TCP 长链接，不需要再拉一套新框架。
- **粒度控制**：Beast 不强制路由/中间件模式，可以按自己的需求设计分发逻辑。
- **协议理解更深入**：手动管理 request/response 生命周期，真正理解 HTTP 协议细节。

代价是你需要自己处理连接管理、超时、路由分发等「脏活」—— 但这也正是实战教学的价值所在。

## 服务启动与 io_context 池

### 服务入口

GateServer 的启动流程：

```cpp
int main() {
    auto port = std::stoi(ConfigMgr::getInstance()["GateServer"]["Port"]);

    try {
        net::io_context io_context{1};
        boost::asio::signal_set signals(io_context, SIGINT, SIGTERM);
        auto pool = AsioIOServicePool::getInstance();

        signals.async_wait([&io_context, &pool](auto error, int signal_number) {
            if (error) return;
            io_context.stop();
            pool->stop();
        });

        std::make_shared<GateServer>(io_context, port)->start();
        std::cout << "GateServer started on port: " << port << std::endl;
        io_context.run();
    } catch (std::exception& e) {
        std::cerr << e.what() << std::endl;
        return EXIT_FAILURE;
    }
}
```

服务主线程主要负责监听信号和网络事件，`io_context{1}` 负责监听服务中断信号 `SIGINT/SIGTERM`，释放多线程 `io_context` 池后优雅退出服务。

`AsioIOServicePool` 内部的多线程 `io_context` 池处理监听连接 IO，`accept` 和网络事件处理解耦，避免新连接到来时线程被数据处理阻塞。

### io_context 线程池

`AsioIOServicePool` 是整个 HTTP 服务器的并发核心：

```cpp
AsioIOServicePool::AsioIOServicePool(std::size_t size)
    : ioServices_(size), works_(size), nextIndex_(0) {
    for (std::size_t i = 0; i < size; i++) {
        works_[i] = std::make_unique<Work>(ioServices_[i].get_executor());
    }
    for (std::size_t i = 0; i < size; i++) {
        threads_.emplace_back([this, i]() {
            ioServices_[i].run();
        });
    }
}
```

线程池大小默认为 `hardware_concurrency() - 1`（为主线程留一个核），每个 io_context 配一个独立的 `executor_work_guard`。**work_guard 的作用**是防止 `io_context::run()` 在没有待处理事件时直接返回，如果所有 io_context 瞬间无事可做，线程池就全部退出了。

连接到来时，acceptor 通过轮询策略将新连接分发到某个 io_context：

```cpp
AsioIOServicePool::IOService& AsioIOServicePool::getIOService() {
    auto& service = ioServices_[nextIndex_++];
    if (nextIndex_ == ioServices_.size()) {
        nextIndex_ = 0;
    }
    return service;
}
```

{{< notice tip >}}

这里的轮询是无锁的（单生产者），因为只有在主线程的 acceptor 会调用 `getIOService()`。每个 io_context 独立运行在自己的线程上，内部的事件循环天然线程安全。

{{< /notice >}}

### 整体并发模型

![20260706150235712.svg](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260706150235712.svg)

每个连接的生命周期（read → handle → write）都在同一个 io_context 上完成，天然避免了跨线程数据竞争。

## 连接接受与生命周期管理

### GateServer：Acceptor 封装

GateServer 类本身只负责监听网络连接，核心就是一个 `tcp::acceptor`：

```cpp
class GateServer : public std::enable_shared_from_this<GateServer> {
public:
    GateServer(net::io_context& ioContext, const unsigned short& port);
    void start();
private:
    tcp::acceptor acceptor_;
    net::io_context& ioContext_;
};
```

构造时直接绑定端口：

```cpp
GateServer::GateServer(net::io_context &ioContext, const unsigned short &port)
    : acceptor_(ioContext, tcp::endpoint(tcp::v4(), port))
    , ioContext_(ioContext) {
}
```

### async_accept 递归监听

`start()` 是 GateServer 的核心异步操作：

```cpp
void GateServer::start() {
    auto self = shared_from_this();
    auto& io_context = AsioIOServicePool::getInstance()->getIOService();
    auto connection = std::make_shared<HttpConnection>(io_context);

    acceptor_.async_accept(connection->getSocket(), [self, connection](auto ec) {
        try {
            if (ec) {
                self->start();  // 出错也要继续监听
                return;
            }
            connection->start();  // 开始处理这个连接
            self->start();        // 继续接受下一个连接
        } catch (const std::exception& e) {
            std::cerr << e.what() << std::endl;
        }
    });
}
```

**这个模式有几个值得注意的细节**：

1. **`shared_from_this()` 保活**：lambda 捕获了 `self`（GateServer 的 shared_ptr），确保在异步等待期间 GateServer 不会被析构。这是异步编程中对象生命周期管理的标准做法。

2. **连接在 accept 前就创建**：`HttpConnection` 在 `async_accept` 调用前就构造好了，它的 socket 由 acceptor 直接接入。这避免了新连接到来时还需要先创建对象再转移 socket 的额外开销。

3. **`start()` 递归调用**：accept 完成后立即再次调用 `start()` 进入下一轮异步等待。由于是异步操作，这不是真正的递归栈，而是事件驱动的链式注册。

4. **跨 io_context 分发**：acceptor 在主 io_context 上运行，但 `connection->start()` 中的 `async_read` 会在线程池的 io_context 上执行（因为 HttpConnection 是用线程池的 io_context 构造的）。这是 Boost.Asio 的隐式 `io_context::post` 行为。

接受连接的全生命周期：



## HTTP 请求处理流程

### HttpConnection 数据结构

每个连接对应一个 `HttpConnection` 对象，它封装了 HTTP 通信状态：

```cpp
class HttpConnection : public std::enable_shared_from_this<HttpConnection> {
public:
    explicit HttpConnection(boost::asio::io_context& io_context);
    void start();
    tcp::socket& getSocket() { return socket_; }

private:
    void checkDeadline();
    void writeResponse();
    void handleRequest();

    tcp::socket socket_;
    beast::flat_buffer buffer_{8192};          // 8KB 接收缓冲
    http::request<http::dynamic_body> request_;
    http::response<http::dynamic_body> response_;
    net::steady_timer deadline_{               // 60秒超时定时器
    	socket_.get_executor(),
    	std::chrono::seconds(60)
    };
    UrlParser urlParser_;
};
```

### 异步读取请求

`start()` 方法的职责是发起一次异步 HTTP 读取：

```cpp
void HttpConnection::start() {
    auto self = shared_from_this();
    http::async_read(socket_, buffer_, request_,
        [self](const boost::system::error_code& ec, size_t bytes_transfer) {
            try {
                if (ec) {
                    std::cout << "http read error: " << ec.what() << std::endl;
                    return;
                }
                boost::ignore_unused(bytes_transfer);
                self->handleRequest();   // 解析完成，处理业务
                self->checkDeadline();   // 重置超时定时器
            } catch (std::exception& e) {
                std::cout << e.what() << std::endl;
            }
    });
}
```

{{< notice note >}}

ChatServer 的 TCP 使用自定义二进制协议（4 字节 header + body），需要手动处理粘包/拆包（TLV 数据结构根据长度拆包）。而 `http::async_read` 是 Beast 提供的高级 API，它能根据 Content-Length 或 Transfer-Encoding 自动读取完整的 HTTP 请求 —— 这是使用 HTTP 层协议最大的便利。

{{< /notice >}}

### 请求分发

`handleRequest()` 根据 HTTP 方法分发到 LogicSystem 进行业务处理：

```cpp
void HttpConnection::handleRequest() {
    response_.version(request_.version());
    response_.keep_alive(false);  // 每个请求关闭连接

    if (request_.method() == http::verb::get) {
        urlParser_.parse(request_.target());
        if (!LogicSystem::getInstance()->handleGet(urlParser_.getPath(), shared_from_this())) {
            response_.result(http::status::not_found);
            response_.set(http::field::content_type, "text/plain");
            beast::ostream(response_.body()) << "url not found\r\n";
            writeResponse();
            return;
        }
        response_.result(http::status::ok);
        response_.set(http::field::server, "GateServer");
        writeResponse();
    }
    else if (request_.method() == http::verb::post) {
        if (!LogicSystem::getInstance()->handlePost(request_.target(), shared_from_this())) {
            response_.result(http::status::not_found);
            // ... 同 GET 的错误处理
        }
        response_.result(http::status::ok);
        response_.set(http::field::server, "GateServer");
        writeResponse();
    }
}
```

可以看到 GET 和 POST 的分发策略略有不同：

- **GET**：先解析 URL（提取路径 + query 参数），再按路径分发
- **POST**：直接用完整 target 路径分发（POST 参数在 body 中）

### 写入响应与超时控制

响应写入后执行 half-close 只关发送端，主要还是通过客户端 close 关闭连接：

```cpp
void HttpConnection::writeResponse() {
    auto self = shared_from_this();
    response_.content_length(response_.body().size());
    http::async_write(socket_, response_,
        [self](const boost::system::error_code& ec, size_t bytes_transfer) {
            if (ec) {
                std::cout << "Socket is shutdown: " << ec.what() << std::endl;
            } else {
                self->socket_.shutdown(tcp::socket::shutdown_send);
            }
            self->deadline_.cancel();  // 关闭 socket 时取消定时器
    });
}

void HttpConnection::checkDeadline() {
    auto self = shared_from_this();
    deadline_.async_wait([self](const boost::system::error_code& ec) {
        if (!ec) {
            self->socket_.close();  // 超时直接关闭
        }
    });
}
```

**超时机制的设计意图**：60 秒内如果没有完成请求-响应循环，定时器触发关闭 socket。

{{< notice note >}}

TIME_WAIT 状态：TCP 连接的四次挥手中，哪一方主动发送 FIN 报文关闭连接时，需要在 TIME_WAIT 状态下等待 2MSL 后才能真正关闭连接，保证被动关闭方能收到最后一次 ACK 报文，防止旧连接残留报文干扰新连接。

在高并发短链接场景中，如果服务端主动关闭连接，就会有大量堆积 TIME_WAIT 状态的连接占用文件描述符，无法接受新连接造成服务不可用。因此应该由客户端主动关闭连接。

{{< /notice >}}

## 路由分发与业务处理

### LogicSystem 路径-回调映射

`LogicSystem` 是一个 **CRTP 单例**，内部核心逻辑主要是维护 GET 操作和 POST 操作处理逻辑的映射表：

```cpp
class LogicSystem : public Singleton<LogicSystem> {
public:
    bool handleGet(const std::string& path, const std::shared_ptr<HttpConnection>& connection);
    void registerGet(const std::string& path, const HttpRequestCallback& handler);
    bool handlePost(const std::string& path, const std::shared_ptr<HttpConnection>& connection);
    void registerPost(const std::string& path, const HttpRequestCallback& handler);

private:
    std::unordered_map<std::string, HttpRequestCallback> postHandlers_;
    std::unordered_map<std::string, HttpRequestCallback> getHandlers_;
};
```

handler 签名为 `std::function<void(shared_ptr<HttpConnection>)>`，接收一个 `shared_ptr<HttpConnection>` 参数 —— 通过它可以直接操作 `connection->response_` 写回响应。**LogicSystem 不需要管理连接的生命周期**，只需要完成业务逻辑，连接管理由 `HttpConnection` 负责。

### Handler 注册

所有业务 handler 在 `LogicSystem` 构造函数中注册：

```cpp
// LogicSystem.cpp:49
LogicSystem::LogicSystem() {
    registerGet("/get_test", [](std::shared_ptr<HttpConnection> connection) {
        beast::ostream(connection->response_.body()) << "receive get_test request.\r\n";
        UrlParams urlParams = connection->urlParser_.getParams();
        for (auto& [param, value] : urlParams) {
            beast::ostream(connection->response_.body()) << "Param " << param << "=" << value << "\r\n";
        }
    });

    registerPost("/get_verify_code", [](std::shared_ptr<HttpConnection> connection) {
        auto bodyString = boost::beast::buffers_to_string(connection->request_.body().data());
        // ... JSON 解析，调用 gRPC ...
    });
    // user_register、reset_passwd、user_login 等 handler 同理...
}
```

{{< notice info >}}

**设计考量**：这种「构造时注册全部路由」的方式适合路由表固定的场景。如果需要动态注册路由（如运行时加载插件），可以暴露 `registerGet/Post` 接口给外部调用。

{{< /notice >}}

### GET 请求示例：/get_test

最简单的 handler，演示 URL 参数解析：

```shell
GET /get_test?name=alice&age=25 HTTP/1.1
```

会被 `UrlParser` 拆解为：

- path = `/get_test`
- params = `{name: "alice", age: "25"}`

响应：

```shell
receive get_test request.
Param name=alice
Param age=25
```

### POST 请求示例：获取验证码

```cpp
registerPost("/get_verify_code", [](std::shared_ptr<HttpConnection> connection) {
    auto bodyString = boost::beast::buffers_to_string(connection->request_.body().data());
    connection->response_.set(http::field::content_type, "application/json");

    Json::Value root, srcRoot;
    if (Json::Reader reader; !reader.parse(bodyString, srcRoot)) {
        root["error"] = static_cast<int32_t>(ErrorCodes::ERROR_REQUEST_JSON);
        boost::beast::ostream(connection->response_.body()) << root.toStyledString();
        return;
    }

    auto email = srcRoot["email"].asString();
    GetVerifyRsp response = VerifyGrpcClient::getInstance()->GetVerifyCode(email);

    root["error"] = response.error();
    root["email"] = email;
    boost::beast::ostream(connection->response_.body()) << root.toStyledString();
});
```

GateServer 使用 JsonCpp 处理 JSON 协议。HTTP body 到 JSON 的转换分为两步：

```cpp
// 1. Beast buffer 转 std::string
auto bodyString = boost::beast::buffers_to_string(connection->request_.body().data());

// 2. JsonCpp 解析
Json::Value srcRoot;
Json::Reader reader;
if (!reader.parse(bodyString, srcRoot)) {
    // 解析失败，返回错误
}
```

JSON 响应的构造则反过来：

```cpp
connection->response_.set(http::field::content_type, "application/json");
Json::Value root;
root["error"] = 0;
root["email"] = "alice@example.com";
boost::beast::ostream(connection->response_.body()) << root.toStyledString();
```

`beast::ostream` 是 Beast 提供的流式接口，可以方便地向 `dynamic_body` 写入内容。

## 总结 

GateServer 的 HTTP 实现虽然代码量不大，但涵盖了异步网络编程中的**对象生命周期管理**（shared_ptr 保活）、**多核利用**（io_context 池）、**协议处理**（Beast 自动解析 HTTP）、**业务解耦**（路由映射表 + handler 回调）、**超时控制**（steady_timer）。

**不足之处：**

1. 不支持 Keep-Alive，当前每次请求完成后直接 `shutdown_send` 关闭连接（`keep_alive(false)`），下一个 HTTP 请求必须重建 TCP 连接。在浏览器场景下（一个页面发多个 API 请求）效率很低。在资源服务中使用 HTTP 上传文件时，如果文件很大会有多个 API 请求对文件分片后同时上报，如果每次都重新建链效率很低。
2. gRPC 和 MySQL 的同步调用会阻塞 io_context 线程。虽然多线程池可以部分缓解（一个线程阻塞不影响其他线程），但线程数有限。
    - 使用协程将同步阻塞调用包装成异步协程，不占用线程；
    - 使用专门的业务线程池处理耗时任务。
3. 路由能力有限，当前路由时精确匹配，不支持路径参数（`/user/:id`）、通配符、中间件（认证、日志、限流）。
    - 引入正则/前缀树路由，支持参数提取；
    - 增加 pre-handler 中间件链（如 Token 校验）；
    - 考虑引入拦截器模式：preHandle → handler → postHandle
