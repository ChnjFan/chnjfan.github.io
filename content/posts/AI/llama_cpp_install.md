+++
title = "llama.cpp 学习笔记（一）：构建、跑通 Qwen3-8B"
description = "在 M4 Mac mini（16GB）上从源码编译 llama.cpp，一条命令运行 Qwen3-8B 量化版，用 llama-cli 对话、用 llama-server 起 OpenAI 兼容 API，实测生成约 19.3 tok/s。"
date = "2026-08-04"
aliases = ["AI", "LLM"]
author = "ChnjFan"
tags = [
    "AI",
]
categories = [
    "AI",
]
+++


这是用 llama.cpp 源码拆解大模型推理引擎的系列开篇。使用 Mac mini（M4/16GB）从源码构建 llama.cpp，运行 Qwen3-8B 量化版，默认参数（40960 上下文）实测生成速度 19.3 tok/s。

- 执行：`llama-cli -hf unsloth/Qwen3-8B-GGUF:UD-Q4_K_XL`，`-hf` 自动从 HuggingFace 下载模型到缓存目录下，然后创建一个 CLI 对话。
- 执行：`llama-server -hf unsloth/Qwen3-8B-GGUF:UD-Q4_K_XL` 后运行服务，并提供 Web 页面 `http://127.0.0.1:8080/` 访问。

本文给出推理引擎全景图：GGUF 加载、计算图构建、KV cache、采样，每个环节对应仓库里哪个模块，后续每篇拆一个。

---

## 引言

用了一段时间大模型的 API 后，我们通过输入文本然后得到结果，中间发生了什么不知道。调用方能接触到的只有结果：响应快不快，上下文能有多长，模型要不要选量化版。而这些结果，都是另一台机器上跑着的推理引擎决定的。

如果要搞懂模型的推理过程，llama.cpp 是个合适的学习标本：LM Studio 和 Ollama 底层用的就是它。

本地跑一个大模型需要什么配置？在 Mac mini（M4，16GB 统一内存）上，我用 llama.cpp 构建并运行了 Qwen3-8B 的量化版本，llama-cli 在默认参数下给出的生成速度是 19.3 token/s。那么问题来了：
- Qwen3-8B 约有 80 亿参数，按 FP16 算，光权重就要 16GB 左右，正好到我这台机器的内存上限。那它是怎么跑起来的？量化之后模型文件只有 5.14GB，这种「压缩」对引擎来说意味着什么？
- 19.3 token/s 算快还是算慢？这个数字由什么决定，CPU、GPU、内存，还是模型本身？如果想让它更快，我能动哪些地方？

这些问题是这个系列的主线，都能在 llama.cpp 里追踪到具体的代码：权重怎么存、怎么加载，计算图怎么建，KV cache 怎么是设计，下一个 token 怎么被采样出来。

这篇文章先给出可复现的构建和运行步骤，后面所有讨论都以它为基线。然后画一张推理引擎的全景图，标出每个环节在仓库里的位置。最后是系列路线图。

{{< notice tip >}}
这个系列的文章是关于 llama.cpp 的学习笔记，文中有我实际踩过的弯路，或是暂时没搞懂的地方。所有的性能数据都是源于本地这台丐版 Mac mini。
如果只想要一个本地部署的模型，可以直接使用 LM Studio 或 Ollama。
{{< /notice >}}


## 为什么是 llama.cpp

推理引擎不止 llama.cpp。vLLM 和 SGLang 是生产服务化的主流，TensorRT-LLM 是 NVIDIA 官方的深度优化路线，Apple 平台上的原生选项则是 MLX。

如果你的机器配置一般，目标又是读源码搞懂推理原理，那对 C++ 工程师来说 llama.cpp 就是一个不错的选择。

llama.cpp 完整推理链在一个项目里。数据流从进入模型文件到生成 token，中间每一层都能在这个仓库里找到对应代码：

```
llama.cpp/
├── ggml/          # 张量库：张量、计算图、量化格式，以及全部计算后端
├── src/           # llama 核心：模型加载、上下文、KV cache、采样、语法约束
├── common/        # 工具共用库：参数解析、采样封装、chat template 处理
├── tools/         # 可执行工具：cli、server、quantize、llama-bench、perplexity、imatrix…
├── conversion/    # HuggingFace 模型转 GGUF 的脚本
├── include/       # 对外 C API（llama.h）
└── docs/          # 文档
```

llama.cpp 把 GGUF 解析、量化、计算图构建、多后端执行、采样、HTTP 服务全部收在一个仓库里，问题追到底不用换地方。

此外 llama.cpp 项目非常活跃，项目中的文档、issue 和 PR 讨论本身就是很好的学习材料。

最后再次说明，如果你的目标是学大规模分布式 serving（比如 PagedAttention 式的显存管理、多机多卡的请求调度），vLLM 或 SGLang 更合适。llama.cpp 的 `tools/server` 虽然也实现了 continuous batching，但它的设计目标是单机和边缘场景。这个系列不做框架对比，只把 llama.cpp 这一个项目拆透。


## 源码构建并跑通 Qwen3-8B

这篇文章是我在本地 Mac 设备上搭建的过程，其他平台的构建方式可以参考官方文档[本地构建 llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md)。

### 前置条件

- macOS 和 Xcode Command Line Tools（提供编译器和 Metal SDK）
- CMake（brew install cmake）
- 约 10GB 磁盘空间，留给构建产物和模型文件

### 获取源码并构建

```bash
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
cmake -B build
cmake --build build --config Release -j8
```

在 MacOS 系统上不需要增加任何编译选项，Metal 默认处于启用状态。使用 Metal 可以在 GPU 上运行计算。

使用 `-DGGML_METAL=OFF` cmake 选项关闭，或者在运行时通过 `--n-gpu-layers 0` 命令行参数禁用 GPU 推理。

怎么确认构建成功：看 `build/bin/` 下是否出现 llama-cli、llama-server、llama-bench、llama-quantize 这几个可执行文件。后面所有文章用到的工具都在这个目录里。


### 运行命令下载并运行模型

这里以我下载的 Qwen3-8B 为例，更多的模型可以在 [llama.app 官网](https://llama.app/)或者 [huggingface](https://huggingface.co/models?library=gguf&sort=trending) 中获取。

```bash
./build/bin/llama-cli -hf unsloth/Qwen3-8B-GGUF:UD-Q4_K_XL
```

`-hf` 参数的格式是 `<用户>/<仓库>[:量化名]`（`common/arg.cpp` 中定义）。llama.cpp 会调用 HuggingFace API 查询仓库的文件列表，按量化名匹配文件并下载；不带量化名时默认找 Q4_K_M，找不到就退回仓库里的第一个文件。

下载的文件放在 HuggingFace 标准缓存目录，默认是 `~/.cache/huggingface/hub/`（`common/hf-cache.cpp` 中定义），修改环境变量 `LLAMA_CACHE` 可以覆盖路径。缓存是内容寻址的：真实文件在 `blobs/` 下按哈希命名，`snapshots/` 里放符号链接，所以同一个模型第二次运行不会重新下载。

我下载的文件是 `Qwen3-8B-UD-Q4_K_XL.gguf`。启动后，llama-cli 发现 GGUF 里内嵌了 chat template，自动进入对话模式。这个行为在 `common/arg.cpp` 里是显式的默认值："auto enabled if chat template is available"。

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260804212659271.png)


### 用 llama-server 跑同一个模型

```bash
./build/bin/llama-server -hf unsloth/Qwen3-8B-GGUF:UD-Q4_K_XL
```

服务默认监听 8080 端口（`common/common.h`），浏览器打开 http://localhost:8080 是一个内置 Web UI，可以直接对话。

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260804214350209.png)

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260804214247717.png)

`llama-server` 自带 continuous batching 和 OpenAI 兼容接口，内部实现我会在系列后面单独一篇里讲。


## 读懂第一次运行的输出

我们把日志级别开到最大（`-lv 5`），引擎从打开文件到吐出第一个 token 的完整过程就都在日志里了。为了抓日志，我用 `llama-completion` 输入提示词后生成 4 个 token 就停止。

```bash
./build/bin/llama-completion -hf unsloth/Qwen3-8B-GGUF:UD-Q4_K_XL \
    -p "hi" -n 4 -c 2048 -st -lv 5
```

### 加载模型文件和元数据

模型加载器做的第一件事是把 GGUF 的元数据全部读出来：

```
llama_model_loader: - kv   0:  general.architecture str = qwen3
llama_model_loader: - kv   7:  qwen3.block_count    u32 = 36
llama_model_loader: - kv  12:  qwen3.attention.head_count_kv u32 = 8
llama_model_loader: - kv  25:  tokenizer.chat_template str = {%- if tools %}...
llama_model_loader: - kv  28:  quantize.imatrix.file str = Qwen3-8B-GGUF/imatrix_...
```

架构名决定后面用哪套模型实现；超参数决定计算图和 KV cache 的形状；tokenizer 和 chat template 让引擎知道怎么把文字切成 token、怎么组织对话；最后一行记录了量化时使用的 imatrix 校准文件。

还有一行值得注意：

```
print_info: file size = 4.78 GiB (5.01 BPW)
```

BPW 是 bits per weight，每个参数平均占多少位。FP16 是 16 BPW，这个文件是 5.01 BPW。开头那个「8B 模型怎么装进 16GB 内存」的问题，答案就在这里：权重被压缩到了原来的三分之一。


### 决定权重放在哪

接下来 llama.cpp 将分配模型权重到指定硬件设备中。

```
llama_prepare_model_devices: using device MTL0 (Apple M4) - 10922 MiB free
load_tensors: offloading output layer to GPU
load_tensors: offloading 35 repeating layers to GPU
load_tensors: offloaded 37/37 layers to GPU
load_tensors:          CPU model buffer size =     0.00 MiB
load_tensors:         MTL0 model buffer size =     0.00 MiB
```

可以看到 37 层权重全部放到 GPU（36 个 transformer 层加输出层）。

奇怪的是两个 buffer 都是 0.00 MiB。权重不占内存吗？肯定是占用的，但不是「拷贝进 GPU 缓冲区」的方式。Apple Silicon 是统一内存架构，CPU 和 GPU 共享同一块物理内存。llama.cpp 用 `mmap` 把 GGUF 文件映射到进程，Metal 直接通过读映射出来的地址获取到数据。这也解释了为什么 5GB 的模型加载只花了约 1 秒。


### 创建上下文，分配 KV cache

```
llama_context: n_ctx      = 2048
print_info:    n_ctx_train = 40960
llama_context: n_ctx_seq (2048) < n_ctx_train (40960) 
                    -- the full capacity of the model will not be utilized
llama_context: flash_attn = auto
...
resolve_fused_ops: Flash Attention enabled
llama_kv_cache: size = 288.00 MiB 
        (2048 cells, 36 layers, 1/1 seqs), K (f16): 144.00 MiB, V (f16): 144.00 MiB
```

上下文长度 `n_ctx` 是我们在命令行参数中显式指定的 2048，模型训练时的上下文是 40960。

Flash Attention 在 Metal 上自动启用了。

**注意力机制**要求每个已处理的 token 在每一层都留下一份 Key 和 Value 状态，供后续 token attend。Qwen3-8B 用了 GQA：32 个注意力头共享 8 组 KV，每个头维度 128，存成 f16：

```
每 token 每层：2 (K+V) × 8 头 × 128 维 × 2 字节 = 4 KB
每 token 全部 36 层：4 KB × 36 = 144 KB
2048 个 token：144 KB × 2048 = 288 MiB   和日志一致
```

KV cache 随上下文长度线性增长，想要 40960 的满上下文，KV 就要 5.6GB，接近权重本身的大小。我们在一开始执行 `llama-cli` 使用默认参数，引擎取模型的训练上下文 40960（`common/common.h:451`），KV cache 实际分配约 5.6GiB。也就是说，19.3 tok/s 是在 4.78GiB 权重加 5.6GiB KV 的内存布局下跑出来的。

GQA 通过共享 8 组 KV 把开销砍到了四分之一，这是模型设计为推理成本做出的让步。


### 为计算预留空间

```
llama_context:   CPU  output buffer size =     0.58 MiB
sched_reserve:   MTL0 compute buffer size =   312.75 MiB
```

compute buffer 是前向计算中所有中间张量（激活值）的缓冲区，按最坏情况预留。日志里能看到，引擎按 1、16、512 个 token 的批次各试算过一次。

output buffer 放 logits：词表大小 `n_vocab` 151936 × 4 字节 ≈ 0.58 MiB，引擎每生成一个 token 都要产出一组这样的打分。


### 运行后的两个速度

计时汇总把推理拆成了两段：

```
prompt eval time = 171.63 ms/9 tokens (19.07 ms per token, 52.44 tokens per second)
       eval time = 380.48 ms/7 runs   (54.35 ms per token, 18.40 tokens per second)
```

prompt eval（pp）是处理输入的阶段，一次处理一批 token，是计算密集型；eval（tg）是逐 token 生成，每生成一个 token 都要把全部权重读一遍，是内存带宽密集型。

两者的速度差（52 -> 18 tok/s）是两种完全不同的瓶颈。到目前为止能够看出生成 token 的性能由「**权重体积**和**内存带宽**」决定。

`graphs reused = 6` 说明 Metal 计算图被缓存复用了，每生成一个 token 走的是同一张图。

```
sampler chain: logits -> ?penalties -> ?dry -> ?top-n-sigma -> top-k -> 
                ?typical -> top-p -> min-p -> ?xtc -> temp-ext -> dist
```

sampler chain 是采样器的流水线。logits 依次经过一串过滤器得到最终分布，`?` 前缀表示该环节按当前参数关闭。top-k、top-p、min-p、temperature 都在这里。

从打开文件到第一个 token：读元数据 → 分配设备、映射权重 → 创建上下文和 KV cache → 预留计算缓冲 → 处理 prompt → 逐个采样。每一行日志背后都是一个明确的模块。

下一节把这些环节和源码目录对上号，画出整个系列的全景图。


## 推理引擎全景：从加载文件到 token

在上一节我们通过日志已经把引擎的启动过程走了一遍，但有些环节在日志里看不到，比如 tokenize 和计算图构建。这一节把这些缺的环节补上，画一张完整的全景图，每个环节都标出它对应仓库里的具体文件。后面每一篇都会沿着这张图展开。

整个过程分三个阶段：一次性的加载、一次性的上下文初始化、以及每个 token 都要走的循环。

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260804232431701.png)

| 环节 | 位置 | 职责 | 对应篇目 |
| --- | --- | --- | --- |
| GGUF 读取 | `src/llama-model-loader.cpp` | 解析元数据、定位张量、校验 | GGUF 篇 |
| mmap 与权重放置 | `src/llama-mmap.cpp` | 文件映射，权重零拷贝进统一内存 | 模型加载篇 |
| 架构分发 | `src/llama-arch.cpp` | 135 条架构注册表，决定走哪套实现 | 模型加载篇 |
| 模型对象 | `src/llama-model.cpp` | 超参数、张量布局、层结构 | 模型加载篇 |
| 架构实现 | `src/models/`（137 个文件） | 每种模型一个文件，定义该架构的前向计算 | 计算图篇 |
| 上下文 | `src/llama-context.cpp` | n_ctx、批次、运行参数 | 计算图篇 |
| KV cache | `src/llama-kv-cache.cpp` 及 `iswa`/`dsa`/`dsv4` 变体 | 存取每层每 token 的 K/V 状态 | KV cache 篇 |
| 计算图基础设施 | `src/llama-graph.cpp` | 图构建的公共骨架和调度 | 计算图篇 |
| 张量与算子 | `ggml/` | tensor、算子、量化格式，不含任何模型语义 | ggml 篇 |
| 后端执行 | `ggml/src/ggml-metal/`（含 `.metal` shader）、`ggml/src/ggml-cpu/` | 在具体硬件上执行计算图 | 后端与性能篇 |
| 采样 | `src/llama-sampler.cpp`、`src/llama-grammar.cpp` | logits 到 token，含语法约束 | 采样篇 |
| 分词与对话 | `src/llama-vocab.cpp`、`src/llama-chat.cpp` | token 编解码、chat template 渲染 | GGUF 篇 |
| 对外接口 | `include/llama.h` | 全部能力的 C API | — |

## 写在最后

读到这里我们已经能够回答出 8B 模型为什么可以装进 16GB 内存，是因为量化把权重压到了 5.01 BPW。而且「量化」不是单一压缩率，UD-Q4_K_XL 内部混合五种存储类型，关键的张量被保留在更高精度。每种格式内部是如何编码的、精度损失换来了多少困惑度（PPL）？这些我们留到后续学习量化时再来回答。

Token 生成速度大致等于内存带宽除以每个 token 要读的权重字节数。这解释了 19.3 tok/s 为什么接近这台机器的上限，也解释了 prompt 处理速度和生成速度为什么是两个数字。graph 复用、KV 读取、采样开销都会让真实值偏离理想值，后续性能篇会把生成速度拆成可以逐项计算的部分。

还能不能更快？这需要我们把上面给的两个问题搞清楚后再回头看看这个问题能否解答。

如果你也在自己的机器上构建了 llama.cpp，建议把启动日志和计时输出留着。后面的文章会反复拿这些数字对照：对得上的地方，说明机制理解对了；对不上的地方更值得看，多半有一个还没搞清楚的机制藏在里面。

下一篇从 GGUF 文件开始：你下载的那个 5.14GB 的文件，头部到底写了什么，张量数据怎么排布，一个 HuggingFace 上的原始模型要经过什么才能变成 llama.cpp 能加载的样子。


---

GGUF 张量类型解析脚本 [gguf_types.py](https://github.com/ChnjFan/CodeGuide/blob/main/AI/Code/gguf_types.py)

```bash
python3 gguf_types.py <模型.gguf>             # 只输出张量类型分布
python3 gguf_types.py <模型.gguf> "general."  # 顺带打印指定前缀的元数据
```

这个脚本只读 GGUF 的头部（元数据区 + 张量记录区），不会去读张量数据本身，更不会去修改文件。类型编号表对应 `ggml/include/ggml.h` 的 `ggml_type` 枚举。