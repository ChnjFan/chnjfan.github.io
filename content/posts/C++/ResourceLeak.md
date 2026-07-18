+++
title = "Redis 连接池资源泄露问题"
description = "Redis 连接池资源泄露问题定位与解决"
date = "2026-07-08"
aliases = ["AI", "LLM", "RAG"]
author = "ChnjFan"
tags = [
    "C++",
    "内存泄露",
]
+++

## 故障背景

在对 IM 服务端做压力测试，对服务端通过阶梯式建立客户端连接并发送消息，跑了一段时间用例后发现服务端的 Redis 不可用，通过 redis-cli 连接上打印 `INFO clients` 发现连接数已经达到最大值。

