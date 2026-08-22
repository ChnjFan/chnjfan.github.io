+++
title = "实现一个能跑 CONNECT 的 MQTT Broker 后，我理解了什么"
description = "从零实现一个最小 MQTT Broker（Jianm），解析 CONNECT 报文并回复 CONNACK 的实践复盘：变长编码的流式解析、asio 异步回调链的思维转变、CONNECT 作为会话起点的状态管理，以及最小实现如何暴露文档不会告诉你的设计细节。"
date = "2026-08-22"
aliases = ["MQTT-broker-connect"]
author = "ChnjFan"
tags = [
    "MQTT",

]
categories = [
    "MQTT",
]
+++

**Jianm** 是我从零开始写的一个最小 MQTT Broker，名字取自中文的「**建木**」，这是「山海经」中连接天地的神树，恰如 broker 在 MQTT 协议中的角色，连接各种设备。Gihub 的[代码仓库](https://github.com/ChnjFan/Jianm)在这里，欢迎讨论、提 issue，觉得有帮助的话也欢迎 star ⭐。

本文是「从零实现 MQTT Broker」系列的第一篇，会随着代码的演进而持续更新。建议收藏或订阅系列文章，以便跟踪后续内容。

最初写 Jianm 的目的很简单，我想真正搞清楚 MQTT 协议在 broker 端是怎么跑起来的，而不是停留在「固定头 + 可变头 + 有效载荷」的文档层面。我给自己定的最小目标是：能收到客户端的 CONNECT 包，解析它，然后回一个 CONNACK。

这个目标看起来够小了，但当我把这三件事串起来之后，才发现每一层都有我此前没想清楚的地方。

## 协议解析：变长编码比想象中棘手

MQTT 的报文格式不复杂，第一个字节是固定头，之后是 Remaining Length，再后面是可变头和载荷。我最初的设想是，从 TCP 里把数据读出来，放到缓冲区，然后按字段偏移量一个个读就行。

**问题出在 Remaining Length 上**。MQTT 用 1 到 4 个字节变长编码表示剩余长度，每个字节的低 7 位是数据，最高位是继续位（continuation bit），表示后面还有没有更多字节。解码逻辑本身不复杂：

```cpp
size_t Packet::decodeRemainingLength(const std::vector<uint8_t> &buffer) {
    size_t length = 0, multiplier = 1;
    for (size_t i = 1; i <= 4; ++i) {
        uint8_t byte = buffer[i];
        length += (byte & 0x7F) * multiplier;
        multiplier *= 128;
        if (!(byte & 0x80)) break;  // 最高位为 0，结束
    }
    return length;
}
```

真正麻烦的是：TCP 是字节流协议，我无法保证一次 `read` 就能拿到完整的报文，也有可能两个包一起过来。可能只读到了固定头的第一字节，也可能读到了固定头加 Remaining Length 的前两个字节但还没读完。这意味着我必须按字节递归地读，先读 2 字节（固定头 + Remaining Length 第一字节），再逐字节读 Remaining Length，直到遇到最高位为 0 的字节，才算知道「后面还有多少数据要读」。

```cpp
void Channel::asyncRemainingLen(size_t offset) {
    if (buffer_[offset - 1] & 0x80) {
        // 继续位为 1，还需要再读一个字节
        asyncReadSome(offset, offset + 1, [this, self, offset](...) {
            asyncRemainingLen(offset + 1);  // 递归
        });
        return;
    }
    // 终于拿到了完整的 Remaining Length，开始读 payload
    int remainingLength = protocol::Packet::decodeRemainingLength(buffer_);
    asyncReadPayload(offset, remainingLength);
}
```

这让我意识到，协议解析不是「拿到完整数据后再处理」，而是「**边收边解析，解析到哪里就再读多少**」。这种流式处理的思维方式，在看文档很容易忽略，写代码时却绕不过去。

## 异步架构：asio 的「异步」不只是非阻塞

选 asio 是因为它是 C++ 里比较成熟的异步 IO 框架，可以在跨平台中使用。但真正用起来才发现，asio 教给我的核心不是「怎么用 async_read」，而是「**一个请求的生命周期怎么在回调链里流转**」。

一个 CONNECT 报文的处理路径是这样的：

```
Server::async_accept → Channel::start
    → asyncReadHead（读固定头）
    → asyncRemainingLen（读变长长度）
    → asyncReadPayload（读完整载荷）
    → MessageMgr::messageHandle（解析并放入队列）
    → SessionMgr::workerLoop（取出并分发到 handler）
    → Session::connect（创建/更新 session）
    → Channel::asyncSend（回 CONNACK）
```

每一步都是异步的，每一步都通过回调链把控制权交出去。整个流程没有一处阻塞调用，`io_context` 单线程就能处理多个连接并发。

但这也带来了一个我没预料到的代价：调试困难。当处理链从 accept 一直延伸到回包，中间任何一环出问题，栈信息都是碎片化的，你看到的不是线性调用栈，而是散落在各个 lambda 里的断点。我后来加了一层 `JM_LOG_TRACE` 在每个回调入口打日志，才勉强把完整的处理路径还原出来。

异步解决的是并发问题，但它把「时间上的顺序」转化成了「**逻辑上的回调链**」，这是有认知成本的。

## 会话管理：CONNECT 不是一次性事件

我最初把 CONNECT 当作一个普通请求：收到、解析、回 CONNACK、结束。但实际实现时很快发现，CONNECT 之后 broker 内部状态变了，多了一个 session，这个 session 在后续的 PUBLISH、SUBSCRIBE、PINGREQ 里都要用到。

所以 CONNECT 的处理分成了两步。第一步在协议层：`MessageMgr` 收到 CONNECT 后，先校验报文合法性，再生成 client_id（如果没有），然后把消息塞进一个线程安全的队列。第二步在会话层：`SessionMgr` 启动了一个工作线程，循环从队列取消息，根据消息类型分发到对应的 handler。

```cpp
void SessionMgr::workerLoop() {
    while (running_.load()) {
        handleRequest();  // 取消息 → 分发 → 执行 handler
    }
}
```

Session 本身是一个状态机：`CONNECTING → CONNECTED → ACTIVE`。CONNECT 报文里携带的 clean_session、keep_alive、will topic/message、username/password 都会被读进 Session 对象，后续的认证和消息路由都依赖这些信息。

```cpp
ReturnCode Session::connect(const shared_ptr<ConnMessage> &connMsg) {
    clientID_ = request.payload.client_id;
    isCleanSession_ = (request.bits.clean_session == 1);
    keepalive_ = request.payload.keep_alive;
    if (request.bits.will == 1) {
        willQos_ = request.bits.will_qos;
        willRetain_ = (request.bits.will_retain == 1);
        willTopic_ = request.payload.will_topic;
        willMessage_ = request.payload.will_message;
    }
    username_ = request.payload.username;
    password_ = request.payload.password;
    state_ = SessionState::CONNECTED;
    return ReturnCode::SUCCESS;
}
```

这让我理解了为什么 MQTT 规范里 CONNECT 的 Flag 位设计得那么紧凑，它不是普通的请求，而是整个会话的起点，所有后续行为的上下文都在这里初始化。

## 做完之后我理解了什么

一个能跑 CONNECT 的最小实现，代码量不大（大约 2700 行），但它把我以前模糊的三个概念变成了具体的代码：

**协议是状态机，不只是报文格式。** MQTT 文档画的是报文结构图，但真正实现时要处理的是「读到了多少、还差多少、下一步该读什么」的状态转移。

**异步是编程模型，不只是性能工具。** 单线程 `io_context` 确实能处理高并发，但它要求你重新组织代码结构，从「先做 A，再做 B」变成「做 A，等完成后再做 B」，这个思维转变比 API 本身更难。

**最小实现的价值在于暴露设计点。** 如果不真的写一遍，我可能永远不会意识到 CONNECT 报文里的 Flag 位需要被存进 session、变长编码需要流式解析、异步回调链需要日志来追踪。这些不是文档会告诉你的，是编码中遇到的问题教会我的。

下一步是 PUBLISH 和 SUBSCRIBE，那是另一个量级的故事了。
