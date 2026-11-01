---
title: "使用 Bloaty 分析 C++ 编译产物体积"
date: 2026-10-31T00:00:00+08:00
description: "从机器人设备的 Flash 容量限制出发，使用 Bloaty 分析 C++ 编译产物的体积。"
tags: ["tools"]
---

在机器人软件开发中，低成本设备的 Flash 容量往往有限，而且在 AI 算力基建吃掉大量存储产能的今天，存储设备价格逐渐攀升，叠加行业的不断内卷，让我们不得把注意力放在低成本设备上。

我们需要先搞清楚 C++ 编译产物中哪些部分占用空间较多，再决定从哪里着手优化。本文以开源项目 [Jianm](https://github.com/ChnjFan/Jianm) 为例，记录使用 Bloaty 进行初步体积分析的方法。

---

在嵌入式 Linux 中，烧录进 Flash 中的固件除了应用程序外，还可能包含内核、共享库和配置文件。因此，本文分析应用程序的 ELF 文件，只是固件体积的一部分。应用程序文件的大小不能直接当作整个固件的大小。

本文先分析 Jianm 的 C++ 可执行文件，目标是找到主要的体积来源，不展开具体的优化改造。

## 安装 Bloaty

本次实测环境如下。Bloaty 已在该环境中完成构建，能够正常列出支持的分析维度。

| 项目 | 版本或信息 |
| --- | --- |
| 操作系统 | Ubuntu 20.04 |
| 架构 | x86_64 |
| C++ 编译器 | g++ (Ubuntu 9.4.0-1ubuntu1~20.04.2) 9.4.0 |
| CMake | 3.16.3 |
| Bloaty | v1.1 |

本文固定使用 Bloaty 的 `v1.1` 标签，便于记录和复现实验。

### 安装构建依赖

```bash
sudo apt update
sudo apt install -y build-essential cmake git pkg-config \
  protobuf-compiler libprotobuf-dev
```

Bloaty 需要 CMake 和 Protobuf 编译器，其他依赖可以通过仓库的子模块获取，详见 [v1.1 官方构建说明](https://github.com/google/bloaty/blob/v1.1/README.md#building-bloaty)。这里同时安装系统的 Protobuf 编译器和开发库。

### 获取源码并构建

在工作目录中执行：

```bash
git clone --branch v1.1 --recursive https://github.com/google/bloaty.git bloaty-v1.1
cd bloaty-v1.1

cmake -S . -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_TESTING=OFF
cmake --build build --target bloaty --parallel 2
```

`--recursive` 用于获取子模块依赖。构建时使用 2 个并行任务，生成的可执行文件为 `build/bloaty`。

### 安装到用户目录并检查

```bash
install -Dm755 build/bloaty "$HOME/.local/bin/bloaty"
export PATH="$HOME/.local/bin:$PATH"

bloaty --help
bloaty --list-sources
```

这里的 `export` 只影响当前终端。如果新终端找不到 `bloaty`，可以重新执行该行，或者使用完整路径 `"$HOME/.local/bin/bloaty"`。

`--help` 用来查看参数，`--list-sources` 用来查看支持的分析维度。本次运行的输出中包含以下几项，后续分析会用到它们：

| 分析维度 | 用途 |
| --- | --- |
| `sections` | 按 ELF 节 (Section) 查看体积分布 |
| `compileunits` | 按编译单元 (Compilation Unit) 查看体积对应的源文件，需要调试信息 |
| `symbols` | 按符号 (Symbol) 查看体积分布 |

## 准备 Jianm 编译产物

[Jianm 的构建说明](https://github.com/ChnjFan/Jianm/blob/main/README.md#build) 要求 CMake ≥ 3.16、C++17 编译器和 Asio ≥ 1.18。这里固定使用 Asio 1.18.2，并在 CMake 中指定其头文件目录。spdlog 已随 Jianm 源码提供。

### 获取示例源码和 Asio

```bash
sudo apt install -y binutils file

mkdir -p "$HOME/bloaty-lab"
cd "$HOME/bloaty-lab"

git clone --depth 1 --branch asio-1-18-2 \
  https://github.com/chriskohlhoff/asio.git asio-1.18.2
git clone https://github.com/ChnjFan/Jianm.git
git -C Jianm checkout --detach f1591e2131dd69491b8d96513317b03677ea8744
```

固定 Jianm 的源码提交，确保后续分析使用同一份代码。Asio 仅通过头文件使用，无需安装到系统目录。

### 构建带调试信息的优化版本

在 `$HOME/bloaty-lab` 目录中执行：

```bash
cmake -S Jianm -B Jianm/build-bloaty \
  -DCMAKE_CXX_COMPILER=/usr/bin/g++ \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DCMAKE_CXX_FLAGS_RELWITHDEBINFO="-O2 -g -DNDEBUG" \
  -DCMAKE_EXE_LINKER_FLAGS="-Wl,--build-id" \
  -DJIANM_BUILD_TESTS=OFF \
  -DASIO_INCLUDE_DIR="$PWD/asio-1.18.2/asio/include"

cmake --build Jianm/build-bloaty --target jianm --parallel 2
```

这里显式使用 `-O2 -g -DNDEBUG`，在启用优化的同时保留调试信息，便于后续按编译单元分析。关闭测试构建后，只生成本文需要的应用程序及其依赖。链接时启用构建标识 (Build ID)，供 Bloaty 校验分析对象与调试信息是否匹配。

### 生成去除符号的分析副本

```bash
cd "$HOME/bloaty-lab/Jianm"

strip --strip-all \
  -o build-bloaty/bin/jianm.stripped \
  build-bloaty/bin/jianm
```

原始产物 `jianm` 保留调试信息，`jianm.stripped` 用于统计去除符号后的文件体积。后续通过 Bloaty 的 `--debug-file` 参数读取原始产物中的调试信息，定位副本中的源码和符号。具体用法见 [官方说明](https://github.com/google/bloaty/blob/v1.1/README.md#debugging-stripped-binaries)。

这里将去除符号的 ELF 文件作为应用程序体积的分析对象。最终 Flash 占用还取决于实际打包方式、文件系统压缩以及共享库等内容。

### 检查分析对象

在 Jianm 源码目录中执行：

```bash
git rev-parse HEAD
file build-bloaty/bin/jianm build-bloaty/bin/jianm.stripped
stat -c '%n: %s bytes' \
  build-bloaty/bin/jianm \
  build-bloaty/bin/jianm.stripped
```

本次使用的 Jianm 提交为 `f1591e2131dd69491b8d96513317b03677ea8744`。`file` 确认两个文件均为 x86-64、动态链接的 ELF，且 Build ID 相同：

```text
6a962c6c188870b156e91b01a90b4a8126c6b19c
```

文件大小如下：

| 文件 | 字节数 | 换算后的大小 |
| --- | ---: | ---: |
| `jianm`，保留调试信息 | 34,883,088 | 约 33.27 MiB |
| `jianm.stripped`，去除符号 | 674,840 | 约 659.02 KiB |

两者相差 34,208,248 字节，其中包含调试信息、符号表等被剥离的内容。这个差额反映了剥离操作对文件大小的影响，不能据此判断业务代码本身的体积变化。后续始终统计 `jianm.stripped`，通过原始 `jianm` 提供定位所需的信息。

## 先按节查看整体分布

```bash
bloaty build-bloaty/bin/jianm.stripped \
  --debug-file=build-bloaty/bin/jianm \
  -d sections -n 0 -s file -w
```

主要参数的作用如下：

| 参数 | 作用 |
| --- | --- |
| `--debug-file=...` | 从同一次构建的原始文件读取符号和调试信息 |
| `-d sections` | 按 ELF 节统计体积分布 |
| `-n 0` | 显示全部行，不将小项折叠为 Others |
| `-s file` | 按文件体积排序 |
| `-w` | 完整显示较长的名称 |

本次输出如下：

```text
    FILE SIZE        VM SIZE
 --------------  --------------
  71.2%   469Ki  71.6%   469Ki    .text
   8.5%  56.3Ki   8.6%  56.3Ki    .eh_frame
   4.7%  30.9Ki   4.7%  30.8Ki    .rela.dyn
   4.1%  27.0Ki   4.1%  26.9Ki    .rodata
   2.8%  18.5Ki   2.8%  18.4Ki    .gcc_except_table
   1.9%  12.3Ki   1.9%  12.3Ki    .data.rel.ro
   1.4%  9.36Ki   1.4%  9.30Ki    .eh_frame_hdr
   1.3%  8.44Ki   1.3%  8.38Ki    .dynstr
   0.9%  6.20Ki   0.9%  6.14Ki    .dynsym
   0.7%  4.40Ki   0.7%  4.34Ki    .rela.plt
   0.5%  3.36Ki   0.0%       0    [Unmapped]
   0.5%  2.97Ki   0.4%  2.91Ki    .plt
   0.4%  2.95Ki   0.4%  2.89Ki    .plt.sec
   0.3%  1.66Ki   0.2%  1.60Ki    .got
   0.1%     859   0.1%     859    [LOAD #2 [R]]
   0.1%     764   0.1%     700    .data
   0.1%     608   0.1%     544    .dynamic
   0.1%     588   0.1%     524    .gnu.version
   0.1%     560   0.1%     496    .gnu.version_r
   0.1%     408   0.1%     344    .gnu.hash
   0.1%     367   0.0%       0    .shstrtab
   0.0%     192   0.0%       0    [ELF Headers]
   0.0%     176   0.0%      32    .init_array
   0.0%     144   0.0%      80    .plt.got
   0.0%     107   0.0%       0    .comment
   0.0%     100   0.0%      36    .note.gnu.build-id
   0.0%      96   0.0%      32    .note.ABI-tag
   0.0%      96   0.0%      32    .note.gnu.property
   0.0%      92   0.0%      28    .interp
   0.0%      91   0.0%      27    .init
   0.0%      77   0.0%      13    .fini
   0.0%      72   0.0%       8    .fini_array
   0.0%       8   0.0%       8    [LOAD #3 [RX]]
   0.0%       3   0.0%       3    [LOAD #4 [R]]
   0.0%       0   0.3%  2.25Ki    .bss
   0.0%       0   0.0%      80    .tbss
   0.0%       0   0.0%       4    [LOAD #5 [RW]]
 100.0%   659Ki 100.0%   655Ki    TOTAL
```

### 分清 FILE SIZE 与 VM SIZE

根据 [Bloaty 的说明](https://github.com/google/bloaty/blob/v1.1/README.md#running-bloaty)，`FILE SIZE` 表示文件体积，`VM SIZE` 表示二进制文件加载到内存时对应的大小。

关注部署文件的体积时，先看 `FILE SIZE`。`VM SIZE` 不包含程序运行时不断变化的堆、栈等全部内存开销，不能当作进程的峰值内存占用。

本次 `.bss` 的 `FILE SIZE` 为 0，而 `VM SIZE` 为 2.25 KiB。这类零初始化数据需要内存空间，但文件中不需要存储对应长度的零字节；相关定义见 [ELF 节说明](https://gabi.xinuos.com/elf/03-sheader.html)。

### 根据结果选择下一步

`.text` 主要存放代码，本次统计约 469 KiB，占文件体积的 71.2%。因此，我会先继续查看这些代码对应哪些编译单元和符号。

另外，`.eh_frame`、`.eh_frame_hdr` 和 `.gcc_except_table` 合计约 84 KiB，占比约 12.7%，值得记录。这些节与栈展开、异常处理相关，具体说明见 [GCC 代码生成说明](https://gcc.gnu.org/onlinedocs/gcc/Code-Gen-Options.html)。先把这些信息记为后续调查线索，是否能减少其体积，还要结合程序和依赖的实际需求判断。

当前结果描述的是一个动态链接的应用程序，尚未计入它使用的共享库。最终固件分析还需要将实际打包进去的其他文件纳入统计。

## 继续定位代码来自哪里

先聚焦占比最高的 `.text`，通过组合分析维度分别查看编译单元和符号。

### 按编译单元分析

```bash
bloaty build-bloaty/bin/jianm.stripped \
  --debug-file=build-bloaty/bin/jianm \
  -d sections,compileunits \
  --source-filter='^\.text$' \
  -n 20 -s file -w
```

`sections,compileunits` 先按节分组，再在节内按编译单元分组；过滤条件仅保留 `.text` 对应的范围。`-n 20` 保留每层前 20 项，其余合并显示。

编译单元通常对应参与编译的 `.cpp` 文件。模板实例化和头文件内联代码可能归到使用它们的编译单元中，因此看到某个 `.cpp` 较大后，还需要继续看符号。

本次结果中，所有路径都以 `/media/sf_Shared/Jianm/` 开头。下面省略这个公共前缀，列出主要的编译单元；百分比均相对于 `.text`：

| 编译单元 | FILE SIZE | 占 `.text` 的比例 |
| --- | ---: | ---: |
| `src/main.cpp` | 115 KiB | 24.6% |
| `src/common/Logger.cpp` | 112 KiB | 24.0% |
| `src/broker/BrokerEngine.cpp` | 47.2 KiB | 10.1% |
| `src/management/AdminSession.cpp` | 29.2 KiB | 6.2% |
| `src/net/TcpTransport.cpp` | 25.0 KiB | 5.3% |
| `src/broker/Handlers.cpp` | 23.0 KiB | 4.9% |
| `src/common/ConfigMgr.cpp` | 18.7 KiB | 4.0% |
| `src/broker/TopicTree.cpp` | 15.9 KiB | 3.4% |
| `src/protocol/Codec.cpp` | 15.0 KiB | 3.2% |

`main.cpp` 和 `Logger.cpp` 合计占 `.text` 的 48.6%，值得优先查看。不过，`main.cpp` 的 115 KiB 包括这个编译单元生成的其他代码，不能理解为 `main()` 函数本身有这么大。

从该提交的 [构建配置](https://github.com/ChnjFan/Jianm/blob/f1591e2131dd69491b8d96513317b03677ea8744/CMakeLists.txt) 可以确认，spdlog 以头文件形式使用，并采用随库提供的 fmt。

[main.cpp](https://github.com/ChnjFan/Jianm/blob/f1591e2131dd69491b8d96513317b03677ea8744/src/main.cpp) 引用了日志和 Asio 相关代码，[Logger.cpp](https://github.com/ChnjFan/Jianm/blob/f1591e2131dd69491b8d96513317b03677ea8744/src/common/Logger.cpp) 则包含异步日志、控制台输出和文件输出的初始化。还需要结合符号确认体积来源，不能直接把这两个编译单元的全部占用都算作日志开销。

这份报告还包含 `[section .text]`，大小为 6.56 KiB。它表示在当前分析维度下没有进一步归到具体编译单元的部分，不能将它当成一个额外的业务模块。

### 按完整符号分析

```bash
bloaty build-bloaty/bin/jianm.stripped \
  --debug-file=build-bloaty/bin/jianm \
  -d sections,fullsymbols \
  --source-filter='^\.text$' \
  -n 30 -s file -w
```

`fullsymbols` 显示还原后的完整 C++ 符号名，包括参数等信息，便于区分重载和模板实例。

两条命令都统计 `.text`，筛选后的 `TOTAL` 及百分比以这部分内容为基准，不能与前一张完整文件报告的百分比直接比较。组合维度与过滤的用法见 [Bloaty 的分层分析说明](https://github.com/google/bloaty/blob/v1.1/README.md#hierarchical-profiles) 和 [过滤说明](https://github.com/google/bloaty/blob/v1.1/README.md#source-filter)。

下面摘取本次输出中的部分条目。为便于阅读，符号省略了部分模板参数和函数参数，体积与百分比保留原始输出值；完整名称可通过上面的命令查看。

| 符号或条目（名称简写） | FILE SIZE | 占 `.text` 的比例 |
| --- | ---: | ---: |
| `[998 Others]` | 352 KiB | 75.2% |
| `fmt::v12::detail::format_dragon(...)` | 9.84 KiB | 2.1% |
| `[section .text]` | 8.08 KiB | 1.7% |
| `jianm::net::TcpTransport::~TcpTransport()` | 7.95 KiB | 1.7% |
| `jianm::broker::TopicTree::remove(...)` | 4.93 KiB | 1.0% |
| `fmt::v12::detail::write<...>(...)` | 4.59 KiB | 1.0% |
| `jianm::broker::BrokerEngine::Impl::Impl(...)` | 4.43 KiB | 0.9% |
| `spdlog::pattern_formatter::handle_flag_<null_scoped_padder>(...)` | 4.33 KiB | 0.9% |
| `spdlog::pattern_formatter::handle_flag_<scoped_padder>(...)` | 4.33 KiB | 0.9% |
| `jianm::common::logger_init(...)` | 4.18 KiB | 0.9% |
| `asio::detail::reactive_socket_send_op<...>::do_complete(...)` | 3.99 KiB | 0.9% |

其中，`fmt::v12::detail::format_dragon(...)` 是本次报告中最大的具名符号，但也只占 `.text` 的 2.1%。榜单中还出现了其他 fmt 格式化符号，以及 spdlog 的日志格式处理和异步日志相关符号。这些结果支持将日志与格式化依赖列为优先调查对象。

同时，`[998 Others]` 占 75.2%，表示当前行数限制下未逐项显示的符号合计占用的体积。不能把它视为一个巨大的函数，也不能仅凭榜单中的几个符号估算某个依赖的全部占用。需要查看完整列表时，将 `-n 30` 改为 `-n 0` 即可。

符号报告中的 `[section .text]` 为 8.08 KiB，与编译单元报告中的 6.56 KiB 不同。两种分析维度能识别并归类的范围有所差异，这些未归类条目应分别阅读，不能相加。

## 整理本次分析得到的线索

经过这次分析，我把后续调查重点整理为下面几项。这里记录的是已有数据支持的方向，实际能减少多少体积，需要后续修改和重新构建来验证。

| 调查对象 | 本次证据 | 后续需要确认的问题 |
| --- | --- | --- |
| 日志与格式化依赖 | `Logger.cpp` 占 `.text` 的 24.0%；符号榜出现多项 spdlog 和 fmt 代码 | 当前需要哪些日志输出与格式化能力？相关符号的完整分布如何？ |
| 入口编译单元引入的代码 | `main.cpp` 占 `.text` 的 24.6% | 其中哪些属于入口逻辑，哪些来自头文件、模板或内联代码？ |
| 网络与业务代码 | `BrokerEngine.cpp` 占 10.1%，`TcpTransport.cpp` 占 5.3%；传输对象的析构符号约 7.95 KiB | 较大符号承担了哪些功能、引入了哪些依赖？ |
| 栈展开与异常处理相关信息 | `.eh_frame`、`.eh_frame_hdr`、`.gcc_except_table` 合计约 84 KiB | 程序及依赖对这些信息有哪些需求？ |

本文到初步定位为止。后续如果做了修改，应保持工具链、构建参数、剥离方式和分析维度一致，再比较新旧产物，避免把调试信息或构建条件变化当作代码优化效果。

这次使用 Bloaty 的过程可以复用到其他 C++ 程序：准备带调试信息的产物和去除符号的副本，先用 `sections` 确认整体分布，再用 `compileunits` 和 `fullsymbols` 把关注的部分逐步定位到源码与符号。每一步都先明确统计对象和百分比的基准，再决定下一步查看什么。
