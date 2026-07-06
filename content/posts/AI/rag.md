+++
title = "RAG - 检索增强生成"
description = "通过 LangChain 学习 RAG 技术和实战使用"
date = "2026-07-06"
aliases = ["AI", "LLM", "RAG"]
author = "ChnjFan"
tags = [
    "AI",
    "RAG",
]
categories = [
    "AI",
]
+++

## 什么是 RAG

RAG = Retrieval-Augmented Generation，**检索增强生成**，是大模型补全外部知识的主流架构。

LLM 的知识来源于训练数据，而训练数据是有时间窗口和范围的，因此对于最新的知识或者公司内部的私有数据 LLM 无从得知。LLM 缺少这些数据时就会产生**幻觉**，一本正经的输出看似专业但完全编造的内容。

RAG 技术就是从外部私有的知识库中**检索**出用户问题相关的资料，将检索结果作为**增强**的上下文，和用户问题一起发送给 LLM，**生成**基于真实资料的回答。

### RAG 概念的提出与发展

| 论文 | 年份 | 核心贡献 |
|------|------|---------|
| **RAG Original** — *Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks* | 2020 | RAG 奠基论文 (Lewis et al., Facebook) |
| **REALM** — *REALM: Retrieval-Augmented Language Model Pre-Training* | 2020 | Google，检索增强预训练 |
| **Dense Passage Retrieval (DPR)** | 2020 | Facebook，稠密向量检索 |
| **Self-RAG** | 2023 | 自适应检索，按需检索 |
| **Corrective RAG (CRAG)** | 2024 | 检索后纠错机制 |

RAG 概念最早由 Facebook（现 Meta）在 2020 年的研究中提出，主要提出预训练的大型模型在知识密集型任务上的局限性，通过 RAG 的微调方法将外部文档检索的内容作为参考投喂给模型，让模型基于这些内容生成回答。

### RAG 的局限性

RAG 只是一种让大模型基于真实、可更新的知识来回答问题的技术方案，它也存在局限性：

- 检索不准确：向量相似度不等于语义逻辑匹配，可能召回无关、错误的文档导致模型曲解文档内容。
- 幻觉无法根除：即使有参考文档，模型仍可能脑补不存在的内容。
- RAG 知识库维护成本高：文档切片、向量化、增量更新、去重和清洗需要持续运维。

### LangChain 环境

创建并激活 python 虚拟环境

```shell
pip install uv
uv venv
source .venv/bin/activate
```

添加 LangChain 核心依赖项

```shell
uv add langchain langchain-text-splitters bs4 requests
```

生成的配置如下：

```toml
[project]
name = "chat-agent"
version = "0.1.0"
dependencies = [
    "bs4>=0.0.2",
    "langchain>=1.3.11",
    "langchain-text-splitters>=1.1.2",
    "requests>=2.34.2",
]
```

RAG 应用 按顺序执行检索和生成，使用 [LangSmith](https://docs.langchain.com/langsmith/observability) 会为每个查询记录追踪信息，以便你查看检索结果、工具调用情况和模型响应。

```shell
export LANGSMITH_TRACING="true"
export LANGSMITH_API_KEY="..."
```

## RAG 的整体工作流程

RAG 工作流程总体分为**索引建立阶段**和 **Agent 查询阶段**。

### 建立索引

建立索引的过程，就是将各种非结构化的文档 chunk 转变为数值（向量）形式保存。将这些数值表示形式与文档片段的映射关系存储在VectorStore中，就能在用户提问时，将用户输入的内容用相同方式转换为数值表示形式发送查询，高效检索到相关内容。

索引建立通常分为四个步骤进行：

1. 加载文档：将数据源加载到 [Document](https://reference.langchain.com/python/langchain-core/documents/base/Document?_gl=1*iwcv21*_gcl_au*MTExNzc5Nzk4OS4xNzgzMzQwNjA1*_ga*MTA0Njk0NDU3My4xNzgzMzQwNjA2*_ga_47WX3HKKY2*czE3ODMzNTA4MDQkbzMkZzEkdDE3ODMzNTE0MTYkajU0JGwwJGgw) 对象中。

2. :fire:文档拆分：使用[文档分割器](https://docs.langchain.com/oss/python/integrations/splitters)将大型Document拆分为更小的 Chunk 片段。