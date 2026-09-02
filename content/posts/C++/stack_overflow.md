+++
title = "从 Core dump 到反汇编：定位 Release C++ 程序的递归栈溢出"
description = "以 Linux x86-64 上的递归栈溢出为例，说明如何用 Core dump、GDB、反汇编和调用约定还原 Release 程序的递归条件与参数。"
date = "2026-09-01"
aliases = ["Cpp-stack-overflow"]
author = "ChnjFan"
tags = [
    "C++",
    "故障定位",
    "底层原理",
]
categories = [
    "基础技术",
]
+++

## 从一次进程异常重启说起

我在一台 Linux 设备上排查过一次 C++ 进程异常重启。这个进程由守护程序负责监测和拉起，日志里记录的终止信号是 `SIGSEGV`，线程栈总大小为 128KB。用 GDB 打开 Core dump 后，调用栈里反复出现同一个函数名，其他栈帧却只有地址，看不到对应的源码行和局部变量。

问题出在正则匹配上。当时的场景可以简化为：使用类似 `(1)*` 的正则表达式匹配 255 个连续的 `1`。每匹配到一个字符，程序就递归处理后面的输入。这个过程不是逻辑上永远无法结束的无限递归，只要栈空间足够，处理完 255 个字符后，递归就会正常终止。但在这台设备上，程序还没有走到终止条件，128KB 的线程栈就先用完了。

重复出现的函数名给了我一个排查方向，但还不足以直接确认根因。现场使用的是 Release 二进制，没有完整的符号和调试信息，接下来还要回答几个问题：

- `SIGSEGV` 是否确实由栈耗尽引起，而不是普通的非法内存访问？
- 为什么递归函数还能显示名字，其他栈帧却没有符号？
- 下一次递归是由哪条机器指令发起的？
- 调用递归函数之前检查了什么条件，又传入了哪些参数？
- 这些参数为什么会让递归一直持续到栈空间不足？

后面的定位就从这些问题开始。为了把 Core dump、GDB 和反汇编之间的关系讲清楚，我会先实现一个简化的匹配器，用它复现同类故障。这个示例只模拟与本次问题有关的递归过程，不代表实际正则引擎的源码。

文章中的源码地址在 [GitHub 仓库](https://github.com/ChnjFan/CodeGuide/tree/main/C%2B%2B/source/stack_overflow)中。


## 构造一个可复现的递归栈溢出

### 将实际问题缩小成一个匹配模型

示例只处理一种模式：`(1)*`。`(1)` 用来匹配字符 `1`，后面的 `*` 表示这个分组可以重复零次或多次。

先忽略正则引擎里的其他逻辑，这段匹配过程大致可以写成下面的伪代码：

```c
match_repeat(input, position):
    if position == input.length:
        return true

    if input[position] != '1':
        return false

    return match_repeat(input, position + 1)
```

输入中有 255 个连续的 `1`，所以 `position` 会从 0 一直增加到 255。直到第 256 次进入 `match_repeat()`，程序才会命中终止条件。

不过，递归层数和栈内存占用不能直接画等号。一次函数调用除了参数，还可能在栈上保存返回地址、寄存器、局部变量和匹配状态。最终用了多少栈，要看编译器实际生成的代码。

示例把分组匹配和重复匹配拆成了两个函数，调用关系如下：

```
match_repeat(position)
    └── match_group(position)
            └── match_repeat(position + 1)
```

只要当前位置还是字符 `1`，这条调用链就会继续加深。后面构建 Release 版本时，我会保留 `match_repeat()` 的动态符号，把 `match_group()` 作为内部函数处理。经过 strip 后，GDB 仍能显示反复出现的 `match_repeat()`，但无法显示 `match_group()` 的名字。这样得到的调用栈会更接近当时的现场。

### 让每一层保存匹配状态

如果每层递归只处理一个位置参数，又没有多少局部状态，编译器生成的栈帧可能很小。即使递归 255 层，也未必能用完 128KB 栈。

真实的正则匹配器可能还要保存捕获分组、输入位置和回溯状态。为了让故障能在 128KB 栈上稳定复现，示例会让每层 `match_repeat()` 都保留一份固定大小的 `MatchFrame`，里面记录当前输入位置和 32 个捕获槽位：

```cpp
struct CaptureSlot {
    const char* begin;
    const char* end;
};

struct MatchFrame {
    const char* input_begin;
    const char* current;
    const char* input_end;
    std::size_t depth;
    CaptureSlot captures[32];
};
```

这里的 32 个槽位只是为了稳定复现，并不是对实际正则引擎数据结构的还原。我把数量设为 32，是为了让 255 个字符形成的调用链能在 128KB 线程栈上触发溢出。因此，这个设置只能用来演示定位过程，不能拿它估算现场中每层栈帧的实际大小。

每次进入 `match_repeat()`，程序都会先初始化当前层的匹配状态，再调用 `match_group()`：

```cpp
extern "C" __attribute__((noinline, visibility("default")))
bool match_repeat(const char* input,
                  std::size_t position,
                  std::size_t length) {
    MatchFrame frame{};
    frame.input_begin = input;
    frame.current = input + position;
    frame.input_end = input + length;
    frame.depth = position;

    for (CaptureSlot& capture : frame.captures) {
        capture.begin = frame.current;
        capture.end = frame.current;
    }

    if (position == length) {
        keep_frame_alive(frame);
        return true;
    }

    const bool matched = match_group(input, position, length);
    keep_frame_alive(frame);
    return matched;
}
```

`match_group()` 会检查当前位置是否为字符 `1`。如果匹配成功，就将位置加一，再调用 `match_repeat()` 处理剩余输入：

```cpp
__attribute__((noinline, visibility("hidden")))
bool match_group(const char* input,
                 std::size_t position,
                 std::size_t length) {
    if (position >= length || input[position] != '1') {
        return false;
    }

    const bool matched = match_repeat(input, position + 1, length);
    keep_result_alive(matched);
    return matched;
}
```

`keep_frame_alive()` 和 `keep_result_alive()` 使用编译器屏障，防止优化器删掉示例中刻意保留的局部状态，并让这些状态一直存活到递归调用返回。它们只用于稳定复现故障，不参与实际的匹配逻辑：

```cpp
__attribute__((noinline))
void keep_frame_alive(const MatchFrame& frame) {
    asm volatile("" : : "m"(frame) : "memory");
}

__attribute__((noinline))
void keep_result_alive(bool result) {
    asm volatile("" : : "r"(result) : "memory");
}
```

这段空内联汇编不会执行任何匹配操作。内存操作数和 `memory` clobber 只是提醒编译器，这些状态可能会被外部观察，因此不能将它们删除，也不能把它们的生命周期缩短到递归调用之前。


### 将工作线程的栈限制为 128KB

主程序通过 `pthread_attr_setstacksize()` 将工作线程的栈大小设为 128KB：

```cpp
constexpr std::size_t kThreadStackSize = 128 * 1024;

pthread_attr_t attributes;
pthread_attr_init(&attributes);

const int set_stack_result =
    pthread_attr_setstacksize(&attributes, kThreadStackSize);
if (set_stack_result != 0) {
    // 实际代码会记录错误并退出。
}

pthread_t worker;
pthread_create(&worker, &attributes, run_match, &arguments);
pthread_attr_destroy(&attributes);
pthread_join(worker, nullptr);
```

`pthread_attr_setstacksize()` 修改的是线程属性对象。之后使用这个属性创建线程时，线程会采用指定的栈大小。128KB 高于 Linux 的 `PTHREAD_STACK_MIN`，也是 x86-64 Linux 常见 4KB 页大小的整数倍，可以避免栈大小参数本身不合法。线程栈的大小在线程创建时确定，具体限制可参考 [`pthread_attr_setstacksize(3)`](https://man7.org/linux/man-pages/man3/pthread_attr_setstacksize.3.html)。

工作线程启动后，示例再通过 `pthread_getattr_np()` 和 `pthread_attr_getstack()` 读取并打印实际的栈地址和大小。这样可以确认线程最终拿到了多大的栈，而不是只检查创建前设置的属性值：

```cpp
pthread_attr_t attributes;
pthread_getattr_np(pthread_self(), &attributes);

void* stack_address = nullptr;
std::size_t stack_size = 0;
pthread_attr_getstack(&attributes, &stack_address, &stack_size);

std::fprintf(stderr,
             "actual_stack_address=%p actual_stack_size=%zu bytes\n",
             stack_address,
             stack_size);
```

输入默认由 255 个 `1` 组成，也可以通过命令行传入较短的字符串，作为对照：

```cpp
const std::string input =
    argc > 1 ? argv[1] : std::string(255, '1');
```


### 使用 Release 优化，同时保留递归调用

示例使用 `-O2` 编译，尽量接近 Release 程序。为了让递归调用和栈帧更容易复现、观察，构建时还加入了几个选项：

```bash
-O2 -g -fno-omit-frame-pointer -fno-optimize-sibling-calls
```

这些选项分别负责：

| 选项 | 用途 |
|---|---|
| `-O2` | 生成经过优化的机器代码，避免用 `-O0` 模拟 Release 现场 |
| `-g` | 在未 strip 的产物中生成调试信息，供构建检查使用；正式分析时不用这份产物 |
| `-fno-omit-frame-pointer` | 尽量保留帧指针，让后续栈展开更稳定，但不能保证所有函数都使用帧指针 |
| `-fno-optimize-sibling-calls` | 关闭兄弟调用和尾调用优化，避免递归被改写成不增加栈深度的跳转 |


GCC 在 `-O2` 下会启用兄弟调用和尾递归优化，所以这里显式关闭了这项优化。关于 `-fno-omit-frame-pointer` 的限制，以及不同优化等级默认开启的选项，可以查看 [GCC 优化选项文档](https://gcc.gnu.org/onlinedocs/gcc/Optimize-Options.html)。

这些设置只用于稳定复现调用链。修复实际问题时，不能把关闭编译优化当作解决递归栈溢出的办法。

匹配代码会编译到共享库 `libmatcher.so`。链接时使用下面的版本脚本，只把 `match_repeat` 保留为对外可见的动态符号：

```
MATCHER_1.0 {
    global:
        match_repeat;
    local:
        *;
};
```

完整构建命令已经写入示例的 `Makefile`。脚本使用 Linux x86-64、GCC、glibc/POSIX Threads 和 GNU binutils。换成 Clang、musl 或其他版本的工具链后，编译器生成的单层栈帧可能不同，最终触发溢出的递归深度也可能变化。

构建示例：

```bash
make
```

构建过程会先生成 `build/unstripped`，再把文件复制到 `build/release` 并执行：

```bash
strip --strip-unneeded build/release/recursive_match
strip --strip-unneeded build/release/libmatcher.so
```

按照 [GNU strip 文档](https://sourceware.org/binutils/docs/binutils/strip.html)的定义，`--strip-unneeded` 会移除调试信息，以及重定位过程不再需要的符号。动态链接仍然需要的符号则会保留下来。

版本脚本把 `match_repeat` 保留为对外可见的动态符号，而内部的 `match_group` 不会保留这个名称。再经过 strip 后，GDB 仍能从动态符号中显示 `match_repeat`，却无法把内部函数的地址还原为源码名称；后文会直接从这个地址开始反汇编。

虽然构建目录保留了未 strip 的文件，后面的故障定位只使用 `build/release` 中的可执行文件和共享库。未 strip 产物只用于核对构建前后的差异，不会用来补充真实现场已经缺失的信息。


### 运行前确认 Core dump 配置

先在准备启动程序的 shell 中放开 Core 文件大小限制，并查看系统当前的 Core 保存方式：

```bash
ulimit -c unlimited
cat /proc/sys/kernel/core_pattern
```

`RLIMIT_CORE` 限制 Core 文件的大小，`core_pattern` 决定 Core 的文件名，或者指定接收 Core 数据的用户态程序。有些使用 systemd 的系统会把 Core 交给 `systemd-coredump`，所以当前目录里没有名为 `core` 的文件，并不代表 Core 没有生成。

Linux 生成 Core 的条件、`core_pattern` 的配置方式以及 systemd 的处理逻辑，可以参考 [`core(5)`](https://man7.org/linux/man-pages/man5/core.5.html)。

这次验证使用 Ubuntu 桌面版。为了让内核直接把 Core 写到当前目录，我临时停止并禁用了 Apport，再修改 `core_pattern`。这些命令会改变整台测试机的崩溃处理方式，不应直接用于生产设备；操作前还应记录机器原有的 Apport 状态和 `core_pattern`，测试结束后按原值恢复：

```bash
# 停止并禁用apport
sudo systemctl stop apport
sudo systemctl disable apport

# 修改core_pattern，直接输出 core.%p.%e
sudo sh -c 'echo "core.%p.%e" > /proc/sys/kernel/core_pattern'

# 校验
cat /proc/sys/kernel/core_pattern
# 输出 core.%p.%e
# 执行程序
# 恢复
sudo systemctl enable --now apport
sudo sh -c 'echo "|/usr/share/apport/apport -p%p -s%s -c%c -d%d -P%P -u%u -g%g -F%F -- %E" > /proc/sys/kernel/core_pattern'
```

进入编译后生成的目录运行程序：

```bash
cd build/release
./recursive_match
```

程序会先打印输入长度、配置的线程栈大小，以及工作线程实际获得的栈范围。在 Linux x86-64 环境中：

```
core_soft_limit=18446744073709551615 bytes
pattern=(1)* input_length=255 requested_stack_size=131072 bytes
actual_stack_address=0x7176a1325000 actual_stack_size=131072 bytes
Segmentation fault (core dumped)
```

这里的 `18446744073709551615` 是64位无符号整数的最大值。示例把 `rlim_t` 转成无符号整数打印，所以这个值对应 `RLIM_INFINITY`，表示当前 shell 没有限制 Core 文件大小，并不是系统准备写出一个同样大小的文件。`RLIMIT_CORE` 的定义可以参考 [`getrlimit(2)`](https://man7.org/linux/man-pages/man2/getrlimit.2.html)。

栈地址每次启动都可能受 ASLR 影响而变化。后面分析的 `core.5524.recursive_match` 来自另一次执行，所以其中的栈地址与这里打印的地址不同；判断栈边界时只使用同一个 Core 内部的 `RSP`、`si_addr` 和 Program Header，不能混用两次运行的地址。

这里主要检查三点：

- 输入长度是 255；
- 工作线程实际获得了 131072 字节的栈；
- 程序没有打印 `matched=true`，而是在递归结束前收到 `SIGSEGV` 退出。

为了确认程序不是对所有输入都会崩溃，再传入一个较短的字符串：

```bash
./recursive_match 1111111111111111111111111111111111111111111111111111111111111111
```

这个字符串包含 64 个 `1`，递归深度较小。在同一套 Ubuntu x86-64 环境中，它实际能够正常到达终止条件：

```text
core_soft_limit=18446744073709551615 bytes
pattern=(1)* input_length=64 requested_stack_size=131072 bytes
actual_stack_address=0x7e6f78c3e000 actual_stack_size=131072 bytes
matched=true
```

长输入崩溃、短输入正常，只能说明故障和输入引起的调用深度有关。仅凭这组对照，还不能确认 `SIGSEGV` 一定发生在栈边界。

下一章会只使用 strip 后的可执行文件和共享库打开 Core，再把重复调用、`RSP` 和线程栈映射放在一起分析，判断这次异常是否确实属于递归栈溢出。


## 从 Core dump 判断是不是栈溢出

程序收到 `SIGSEGV`，只能说明它访问了未映射或无权访问的内存。空指针、越界读写、释放后使用，以及损坏的函数指针，都可能触发同一个信号。

调用栈里反复出现同一个函数，也不能马上断定是递归栈溢出。如果栈内存已经被破坏，GDB 可能沿着错误的返回地址继续展开，最终得到一条看起来很异常的调用栈。

因此，不能只看调用栈“像不像递归”，还要检查几项证据能否对得上：

- 崩溃线程中是否存在大量尚未返回的重复调用；
- 在栈向低地址增长的 x86-64 Linux 上，栈指针寄存器 `RSP` 是否已经接近线程栈的低地址边界；
- 引发 `SIGSEGV` 的访问地址是否落在栈边界之外或保护区内；
- `RIP` 是否停在分配新栈帧或继续发起递归调用的指令附近。

这些现象放在一起，才能把“疑似递归”推进到“可能是递归耗尽了线程栈”。

### 使用匹配的二进制加载 Core

分析 Core 时，需要使用崩溃进程对应的可执行文件和共享库。文件名一样，不代表文件内容也一样。即使源码没有修改，重新编译也可能改变指令地址和装载布局。

对于上一章生成的示例，可以这样启动 GDB：

```bash
gdb ./recursive_match ./core.5524.recursive_match
```

如果匹配的共享库保存在其他目录，可以在 GDB 中设置搜索路径：

```gdb
set solib-search-path /path/to/matching-libraries
```

Core 加载完成后，先检查 GDB 当前使用的文件：

```gdb
info files
info sharedlibrary
```

`info files` 会列出当前使用的可执行文件、Core 文件和符号文件，`info sharedlibrary` 则用于检查共享库是否已经找到，以及 GDB 是否成功读取了对应符号。具体行为可参考 [GDB 对可执行文件和 Core 文件的说明](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Files.html)。

GDB 从 Core 中读取进程终止时保存的寄存器和内存状态，再结合可执行文件与共享库还原代码地址。如果它提示共享库缺失、版本不匹配，或者某些内存地址无法访问，不应直接跳过这些警告。一旦共享库版本不对，同一个地址偏移可能会落到完全不同的指令上。后面的反汇编即使看起来能够解释，也可能分析的是另一份代码。

### SIGSEGV 只是定位起点

Core 加载成功后，GDB 通常会显示程序收到的信号、当前线程和发生异常的指令位置：

```gdb
Core was generated by `./recursive_match'.
Program terminated with signal SIGSEGV, Segmentation fault.
#0  0x00007a4902e76194 in match_repeat () from libmatcher.so
[Current thread is 1 (Thread 0x7a4902e746c0 (LWP 5525))]
```

先查看崩溃现场的几个关键寄存器，以及 `RIP` 指向的指令：

```gdb
(gdb) info registers rip rsp rbp
rip            0x7a4902e76194      0x7a4902e76194 <match_repeat+52>
rsp            0x7a4902e54e00      0x7a4902e54e00
rbp            0x7a4902e55040      0x7a4902e55040
(gdb) x/i $rip
=> 0x7a4902e76194 <match_repeat+52>:    rep stos %rax,%es:(%rdi)
```

在 x86-64 中：

- `RIP` 是程序发生异常时的指令地址；
- `RSP` 是当前栈指针；
- `RBP` 可能被编译器用作帧指针，但优化后的函数不一定始终使用它。

`info registers` 显示的是当前选中栈帧对应的寄存器状态。对于最内层的第 0 帧，这些值来自程序崩溃时保存的现场。切换到外层栈帧后，GDB 显示的可能是根据栈展开信息恢复出的值，也可能因信息不足而无法恢复。具体行为可参考 [GDB 手册中的“Registers”部分](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Registers.html)。

如果 Core 中保存了额外的信号信息，还可以检查 `$_siginfo`：

```gdb
(gdb) ptype $_siginfo
type = struct siginfo {
    int si_signo;
    int si_errno;
    int si_code;
    union {
        ...
    } _sifields;
}
(gdb) p $_siginfo
$1 = {si_signo = 11, si_errno = 0, si_code = 2,
    _sigfault = {si_addr = 0x7a4902e54e00, _addr_lsb = 0,
    ...
```

在常见的 GNU/Linux 目标上，`$_siginfo` 通常对应 `siginfo_t`，**其中的 `si_addr` 记录触发段错误的内存地址**。不过，字段布局可能随目标平台和 GDB 版本变化，所以应先用 `ptype` 确认结构，再读取对应字段。例如：

```gdb
(gdb) p/x $_siginfo._sifields._sigfault.si_addr
$2 = 0x7a4902e54e00
```

并不是所有 Core 都包含这项信息，有些 GDB 版本也无法提供 `$_siginfo`。如果它为空或字段无法读取，只能说明这条证据缺失，不能据此否定或确认栈溢出。字段的具体用法可以参考 [GDB 对额外信号信息的说明](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Signals.html)。


### 找到真正崩溃的线程

示例程序由工作线程执行递归匹配，主线程则停在 `pthread_join()` 中等待。单独执行一次 `bt`，只能看到当前选中线程的调用栈，因此要先检查所有线程：

```gdb
(gdb) info threads
  Id   Target Id                        Frame
* 1    Thread 0x7a4902e746c0 (LWP 5525) 0x00007a4902e76194 in match_repeat ()
  2    Thread 0x7a4902d37740 (LWP 5524) 0x00007a4902698e51 in ...

(gdb) thread apply all bt 20
Thread 2 (Thread 0x7a4902d37740 (LWP 5524)):
#0  0x00007a4902698e51 in __futex_abstimed_wait_com...
...
Thread 1 (Thread 0x7a4902e746c0 (LWP 5525)):
#0  0x00007a4902e76194 in match_repeat () from libmatcher.so
#1  0x00007a4902e7624d in ?? () from libmatcher.so
...
```

在 `info threads` 的输出中，左侧带 `*` 的是当前线程。加载 Core 后，GDB 通常会选中触发信号的线程，但这个标记不能代替调用栈分析。仍然要检查各线程当时执行到了哪里，确认哪一个线程真正发生了异常。如果当前选中的不是异常线程，可以用 `thread <线程编号>` 切换。

查看异常线程的调用栈：

```gdb
(gdb) bt
#0  0x00007a4902e76194 in match_repeat () from libmatcher.so
#1  0x00007a4902e7624d in ?? () from libmatcher.so
#2  0x00007a4902e761f0 in match_repeat () from libmatcher.so
#3  0x00007a4902e7624d in ?? () from libmatcher.so
#4  0x00007a4902e761f0 in match_repeat () from libmatcher.so
#5  0x00007a4902e7624d in ?? () from libmatcher.so
#6  0x00007a4902e761f0 in match_repeat () from libmatcher.so
#7  0x00007a4902e7624d in ?? () from libmatcher.so
#8  0x00007a4902e761f0 in match_repeat () from libmatcher.so
#9  0x00007a4902e7624d in ?? () from libmatcher.so
```

`match_repeat()` 在同一条调用链中反复出现，说明前一次调用还没有返回，程序就进入了下一层。几个可见的 `match_repeat()` 之间还夹着名称无法解析的栈帧，这与示例程序的调用关系相符：`match_repeat()` 先调用内部函数 `match_group()`，`match_group()` 再进入下一层 `match_repeat()`。

GDB 把第 0 帧作为程序当前执行的位置，后面的栈帧依次是它的调用者。`thread apply all bt` 和栈帧编号的具体规则可以参考 [GDB 手册中的“Backtrace”部分](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Backtrace.html)。

重复栈帧说明程序存在递归调用的特征，但还不能排除栈内存已经损坏。返回地址被越界写覆盖后，GDB 也可能展开出一条错误的调用栈，常见表现包括：

- 地址突然跳到不可执行的内存区域；
- 调用链在中途断开；
- 相邻栈帧的栈地址不再按合理方向变化；
- 多个栈帧出现相同或明显异常的栈地址。

接下来还要核对这些栈帧中的返回地址，确认它们是否真的落在有效 `call` 指令之后。只有调用关系和机器指令能够对应起来，重复栈帧才能作为递归证据继续使用。


### 把 RSP 放回线程栈映射中

确认崩溃线程后，先读取它的栈指针：

```gdb
(gdb) p/x $rsp
$3 = 0x7a4902e54e00
(gdb) info registers rsp
rsp            0x7a4902e54e00      0x7a4902e54e00
```

再查看 Core 中保存的内存映射：

```
(gdb) info proc mappings
Mapped address spaces:

          Start Addr           End Addr       Size     Offset objfile
      0x7a4902e75000     0x7a4902e76000     0x1000        0x0 libmatcher.so
      0x7a4902e76000     0x7a4902e77000     0x1000     0x1000 libmatcher.so
      0x7a4902e77000     0x7a4902e78000     0x1000     0x2000 libmatcher.so
      0x7a4902e78000     0x7a4902e79000     0x1000     0x2000 libmatcher.so
      0x7a4902e79000     0x7a4902e7a000     0x1000     0x3000 libmatcher.so
      ...
```

GDB 可以从一部分 GNU/Linux Core 中还原进程的内存映射，但这取决于目标平台和 Core 实际保存的内容。Core 中的信息也可能少于运行中的进程，具体限制可以参考 [GDB 手册中的“Process Information”](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Process-Information.html)。

如果 `info proc mappings` 不可用，还可以在 GDB 外查看 Core 的 ELF Program Header：

```bash
readelf -lW core.5524.recursive_match
```

```
Elf file type is CORE (Core file)
Entry point 0x0
There are 50 program headers, starting at offset 64

Program Headers:
  Type    Offset   VirtAddr           PhysAddr           FileSiz  MemSiz   Flg Align
  LOAD    0x07a000 0x00007a4902e54000 0x0000000000000000 0x000000 0x001000     0x1000
  LOAD    0x07a000 0x00007a4902e55000 0x0000000000000000 0x020000 0x020000 RW  0x1000
  LOAD    0x09a000 0x00007a4902e75000 0x0000000000000000 0x001000 0x001000 R   0x1000
```

进程仍在运行时，可以从 `/proc/<pid>/maps` 查看内存映射。不过，不能只搜索 `[stack]`。这个标记指的是主线程栈；Linux 4.5 移除了其他线程使用的 `[stack:<tid>]` 标记，工作线程的栈可能只显示为一段匿名的可读写映射。

更稳妥的做法是先取得目标线程的 `RSP`，再判断这个地址落在哪一段映射中。`/proc/<pid>/maps` 的格式和不同内核版本的差异，可以参考 [proc_pid_maps(5)](https://man7.org/linux/man-pages/man5/proc_pid_maps.5.html)。

在 x86-64 上，栈向低地址方向增长。函数继续调用、栈帧不断分配时，`RSP` 会逐渐减小。按照这个关系，可以粗略估算当前活动栈的深度，以及栈指针到低地址边界的距离：

```text
当前活动深度约为：stack_high - RSP
距离低地址边界约为：RSP - stack_low
```

这个估算有一个前提：`RSP` 仍位于可用的栈范围内。线程启动时，栈上已经存在运行库留下的调用帧，映射中也可能包含对齐空间。System V AMD64 ABI 还允许叶子函数使用 `RSP` 以下的 red zone。

因此，`stack_high - RSP` 更适合用来判断栈指针是否接近边界，不能直接当作精确的业务栈使用率。x86-64 的栈帧布局可以参考 [System V AMD64 ABI](https://gitlab.com/x86-psABIs/x86-64-ABI/blob/master/x86-64-ABI/low-level-sys-info.tex)。

这次复现生成的 Core 中，`readelf` 显示了两段紧邻的 `LOAD`：

| 地址范围 | 大小 | 权限 | 含义 |
|---|---:|---|---|
| `0x7a4902e54000–0x7a4902e55000` | 4KB | 无 | 工作线程栈低地址一侧的保护页 |
| `0x7a4902e55000–0x7a4902e75000` | 128KB | `RW` | 工作线程可读写的栈区域 |

第二段的大小可以直接由首尾地址相减得到：

```
0x7a4902e75000 - 0x7a4902e55000
    = 0x20000
    = 131072 bytes
    = 128KB
```

这和示例程序为工作线程设置的栈大小一致。Core 中保存的是 `RSP = 0x7a4902e54e00`，这个地址已经不在 `0x7a4902e55000–0x7a4902e75000` 的可读写范围内，而是进入了前面的无权限页面：

```
0x7a4902e55000 - 0x7a4902e54e00
    = 0x200
    = 512 bytes
```

也就是说，崩溃现场的栈指针已经越过可用栈的低地址边界512字节。此时再用“还剩多少栈”描述现场已经没有意义，因为新的栈帧已经进入保护页。

此时的 `RBP` 是 `0x7a4902e55040`，仍在可读写栈区域内，距离低地址边界只有64字节。RBP 与 RSP 相差 0x240，也就是576字节。这和当前函数需要为局部匹配状态留出较大栈帧的行为能够对应起来：进入这一层之前，栈顶已经非常靠近边界；函数继续扩展栈帧后，`RSP` 跨进了保护页。


### 将故障地址与当前指令对应起来

栈指针越界之后，还要确认这次 `SIGSEGV` 访问的是否正是这段地址。Core 中的 `$_siginfo` 显示：

```gdb
si_signo = 11
si_code  = 2
si_addr  = 0x7a4902e54e00
```

在 Linux 的 `SIGSEGV` 信息中，`si_code` 为 `SEGV_ACCERR` 表示目标地址存在映射，但本次访问不符合该映射的权限。在这个环境中，该常量的值为 2；具体定义应以目标系统的头文件和 [`sigaction(2)`](https://man7.org/linux/man-pages/man2/sigaction.2.html) 为准。

这里的 `si_addr` 与 `RSP` 完全相同，而且落在前面识别出的无权限保护页中。这说明处理器访问的正是越过栈边界后的地址，不是空指针，也不是与线程栈无关的堆地址。

程序发生异常时，`RIP` 指向下面这条指令：

```asm
0x7a4902e76194 <match_repeat+52>:    rep stos %rax,%es:(%rdi)
```

`rep stos` 会重复向 `RDI` 指向的内存写入数据。示例源码中的 `MatchFrame frame{}` 需要将当前层的匹配状态初始化为零，编译器用这条批量写入指令完成初始化。

故障地址刚好等于越界后的 `RSP`。结合当前指令可以确认，程序在初始化新一层递归的局部对象时写入了保护页。

到这里，几项信息已经能够互相印证：

1. 调用栈中存在大量尚未返回的 `match_repeat()` 和内部函数栈帧；
2. 工作线程的可用栈大小确实是 128 KB；
3. `RSP` 已经越过可用栈的低地址边界 512 字节；
4. `si_addr` 与越界后的 `RSP` 相同，并且位于无权限保护页中；
5. `RIP` 停在初始化新一层局部匹配状态的写内存指令上。

根据这些证据，可以确认这个复现程序的 `SIGSEGV` 是递归调用链不断加深、最终写入线程栈保护页造成的。这个判断来自 Core 中的地址、寄存器和指令，而不只是因为调用栈里出现了重复函数名。


## 用 GDB 反汇编递归条件和参数

上一章已经确认，程序在初始化新一层递归栈帧时写入了保护页，最终触发 `SIGSEGV`。现在还剩两个问题：

- 程序满足什么条件时会继续递归？
- 进入下一层时，参数发生了什么变化？

GDB 已经加载了 Core、匹配的可执行文件和 libmatcher.so，因此可以直接反汇编 Core 中的运行时地址，不必再手动换算共享库的装载基址。


### 从异常线程的调用栈确定分析入口

先切换到发生异常的线程，再查看前几层调用栈，后面的分析主要围绕三个地址展开：

```
(gdb) bt
#0  0x00007a4902e76194 in match_repeat ()  # 当前崩溃位置
#1  0x00007a4902e7624d in ?? () 
#2  0x00007a4902e761f0 in match_repeat ()  # match_repeat() 中的返回位置
#3  0x00007a4902e7624d in ?? ()            # 名称不可见函数中的返回位置
```

`match_repeat()` 的名称仍然可见，可以直接让 GDB 反汇编这个函数：

```gdb
(gdb) disassemble /r match_repeat
```

`/r `会在汇编指令旁显示对应的机器码字节。除了阅读控制流，后面需要核对指令地址和边界时，这些原始字节也能派上用场。


### 在 match_repeat() 中找到第一个调用点

`match_repeat()` 的完整反汇编比较长，可以先从调用栈中的返回地址入手。查看 `0x7a4902e761f0` 附近的指令：

```asm
(gdb) x/8i 0x7a4902e761e0
0x7a4902e761e0 <match_repeat+128>: cmp    %r9,%rsi
0x7a4902e761e3 <match_repeat+131>: je     0x7a4902e7620d
0x7a4902e761e5 <match_repeat+133>: mov    %r8,%rdi
0x7a4902e761e8 <match_repeat+136>: mov    %r9,%rdx
0x7a4902e761eb <match_repeat+139>: call   0x7a4902e76230
0x7a4902e761f0 <match_repeat+144>: mov    %rbx,%rdi
```

`0x7a4902e761eb` 的 `call` 跳到了 `0x7a4902e76230`。调用结束后，程序会从下一条指令 `0x7a4902e761f0` 继续执行。这个地址正好出现在调用栈的第 2 帧：

```gdb
#2  0x7a4902e761f0 in match_repeat()
```

这说明第 2 帧保存的确实是调用 `0x7a4902e76230` 后的返回位置。调用栈中的地址能够和真实的 `call` 指令对应起来，不是错误栈展开产生的随机结果。

`0x7a4902e76230` 虽然没有函数名，但地址已经足够继续分析。

### 直接反汇编名称不可见的内部函数

先从调用目标开始查看一段指令 `x/16i 0x7a4902e76230`，可以看到不可见函数的 `ret` 指令地址，这样就可以确定这段短函数的分析范围。再用 `disassemble /r` 输出完整指令和机器码：

```asm
(gdb) disassemble /r 0x7a4902e76230,0x7a4902e76257
Dump of assembler code from 0x7a4902e76230 to 0x7a4902e76257:
   0x00007a4902e76230:  31 c0              xor    %eax,%eax
   0x00007a4902e76232:  48 39 d6           cmp    %rdx,%rsi
   0x00007a4902e76235:  73 06              jae    0x7a4902e7623d
   0x00007a4902e76237:  80 3c 37 31        cmpb   $0x31,(%rdi,%rsi,1)
   0x00007a4902e7623b:  74 03              je     0x7a4902e76240
   0x00007a4902e7623d:  c3                 ret
   0x00007a4902e7623e:  66 90              xchg   %ax,%ax
   0x00007a4902e76240:  55                 push   %rbp
   0x00007a4902e76241:  48 83 c6 01        add    $0x1,%rsi
   0x00007a4902e76245:  48 89 e5           mov    %rsp,%rbp
   0x00007a4902e76248:  e8 13 fe ff ff     call   0x7a4902e76060 <match_repeat@plt>
   0x00007a4902e7624d:  0f b6 f8           movzbl %al,%edi
   0x00007a4902e76250:  e8 fb fe ff ff     call   0x7a4902e76150
   0x00007a4902e76255:  5d                 pop    %rbp
   0x00007a4902e76256:  c3                 ret
End of assembler dump.
```

即使不知道这个函数在源码中的名称，也可以从指令看出它的作用：检查当前位置的字符，更新位置参数，然后再次调用 `match_repeat()`。这些行为已经能确定它在递归调用链中的位置。

为了方便后文描述，下面把这段代码称为“内部匹配函数”。在示例源码中，它对应 `match_group()`。


### 用 call 后的返回地址验证调用链

为了确认调用栈中的两个地址确实来自这两次函数调用，可以分别查看 `call` 及其下一条指令：

```asm
(gdb) x/2i 0x7a4902e761eb
0x7a4902e761eb <match_repeat+139>: call   0x7a4902e76230
0x7a4902e761f0 <match_repeat+144>: mov    %rbx,%rdi

(gdb) x/2i 0x7a4902e76248
0x7a4902e76248: call   0x7a4902e76060 <match_repeat@plt>
0x7a4902e7624d: movzbl %al,%edi
```

两条 call 后面的地址正是调用栈中反复交替出现的两个地址：`match_repeat()` 中的 `0x7a4902e761f0` 和内部匹配函数中的 `0x7a4902e7624d`。

由此可以确定调用关系：

```
match_repeat()
    └── 0x7a4902e76230 处的内部匹配函数
            └── match_repeat()
```

此时，递归关系已经不只是调用栈呈现出的形状。两个返回地址都能找到对应的 `call` 指令，调用目标也能互相连接。

### 根据 x86-64 调用约定确定参数

示例中的函数接收三个参数：

```cpp
bool match_repeat(const char* input, std::size_t position, std::size_t length);
```

按照 x86-64 System V 调用约定，前三个指针或整数参数依次通过下面三个寄存器传递：

| 寄存器 | 参数 |
|---|---|
| `RDI` | `input` |
| `RSI` | `position` |
| `RDX` | `length` |

但不能直接把崩溃时的 `RDI`、`RSI` 和 `RDX` 当作函数入口参数。`info registers` 显示的是程序发生异常时的寄存器状态，编译器可能已经在函数内部改写或复用了这些寄存器。

反汇编函数入口到故障指令之间的代码：

```asm
(gdb) disassemble 
Dump of assembler code for function match_repeat:
   0x00007a4902e76160 <+0>:     endbr64
   0x00007a4902e76164 <+4>:     push   %rbp
   0x00007a4902e76165 <+5>:     mov    %rdi,%r8
   0x00007a4902e76168 <+8>:     mov    $0x44,%ecx
   0x00007a4902e7616d <+13>:    mov    %rdx,%r9
   0x00007a4902e76170 <+16>:    mov    %rsp,%rbp
   0x00007a4902e76173 <+19>:    push   %rbx
   0x00007a4902e76174 <+20>:    lea    -0x240(%rbp),%rbx
   0x00007a4902e7617b <+27>:    mov    %rbx,%rdi
   0x00007a4902e7617e <+30>:    sub    $0x238,%rsp
   0x00007a4902e76185 <+37>:    mov    %fs:0x28,%rax
   0x00007a4902e7618e <+46>:    mov    %rax,-0x18(%rbp)
   0x00007a4902e76192 <+50>:    xor    %eax,%eax
=> 0x00007a4902e76194 <+52>:    rep stos %rax,%es:(%rdi)
```

函数入口先把两个参数 `RDI = input` 和 `RDX = length` 分别保存到了寄存器 `r8` 和 `r9`。从入口到故障位置，`RSI` 没有被修改，因此它仍然表示 `position`。`RDI` 则在 `0x7a4902e7617b` 被改成局部对象的地址，供后面的 `rep stos` 初始化栈内存。也就是说，崩溃时的 `RDI` 已经不是输入指针。

切回第0帧，读取相关寄存器：

```gdb
(gdb) info registers rdi rsi rdx r8 r9
rdi            0x7a4902e54e00      134453999783424
rsi            0xd0                208
rdx            0xff                255
r8             0x618ed058b2b0      107266008724144
r9             0xff                255
```

结合前面的入口指令，可以恢复当前递归层的原始参数：

```
input    = 0x618ed058b2b0
position = 208
length   = 255
```

此时，RDI 的值 `0x7a4902e54e00` 是局部对象的初始化地址。它与 `RSP`、`si_addr` 完全相同，并且已经落入栈保护页。


### 检查 Core 中保存的实际输入

恢复出输入指针后，可以直接查看它指向的内存：

```
(gdb) x/s $r8
0x618ed058b2b0: '1' <repeats 200 times>...

(gdb) x/256cb $r8
0x618ed058b2b0: 49 '1'  49 '1'  49 '1'  ...
...
0x618ed058b3a8: 49 '1'  49 '1'  49 '1'  49 '1'
0x618ed058b3ac: 49 '1'  49 '1'  49 '1'  0 '\000'

(gdb) x/bx $r8+$r9
0x618ed058b3af: 0x00
```

Core 中保存的输入确实由 255 个连续的字符 1 组成。


### 从 match_repeat() 还原终止条件

回到 match_repeat() 调用内部函数之前的位置：

```asm
(gdb)  x/8i 0x7a4902e761e0
   0x7a4902e761e0 <match_repeat+128>:   cmp    %r9,%rsi
   0x7a4902e761e3 <match_repeat+131>:   je     0x7a4902e7620d <match_repeat+173>
   0x7a4902e761e5 <match_repeat+133>:   mov    %r8,%rdi
   0x7a4902e761e8 <match_repeat+136>:   mov    %r9,%rdx
   0x7a4902e761eb <match_repeat+139>:   call   0x7a4902e76230
   0x7a4902e761f0 <match_repeat+144>:   mov    %rbx,%rdi
   0x7a4902e761f3 <match_repeat+147>:   call   0x7a4902e76140
   0x7a4902e761f8 <match_repeat+152>:   mov    -0x18(%rbp),%rdx
```

前面已经确定了这些寄存器的含义，`r8 = input`，`r9 = length`，`rsi = position`。这里可以看出来 `cmp` 用来判断 `position == length`，如果索引跟长度相同时，跳转到下面的这条路径：

```asm
0x7a4902e7620d:  mov    %rbx,%rdi
0x7a4902e76210:  mov    $0x1,%eax
```

`EAX` 被设为 1，说明 `position == length` 是正常结束条件，此时函数返回 `true`。

如果还没有到达输入末尾，程序会继续准备内部匹配函数需要的参数，随后调用位于 `0x7a4902e76230` 的内部函数。这段控制流可以还原为：

```cpp
if (position == length) {
    return true;
}

return internal_match(input, position, length);
```


### 从内部函数还原递归条件

再次反汇编内部函数：

```asm
(gdb) disassemble /r 0x7a4902e76230,0x7a4902e76257
Dump of assembler code from 0x7a4902e76230 to 0x7a4902e76257:
   0x00007a4902e76230:  31 c0              xor    %eax,%eax
   0x00007a4902e76232:  48 39 d6           cmp    %rdx,%rsi
   0x00007a4902e76235:  73 06              jae    0x7a4902e7623d
   0x00007a4902e76237:  80 3c 37 31        cmpb   $0x31,(%rdi,%rsi,1)
   0x00007a4902e7623b:  74 03              je     0x7a4902e76240
   0x00007a4902e7623d:  c3                 ret
   0x00007a4902e7623e:  66 90              xchg   %ax,%ax
   0x00007a4902e76240:  55                 push   %rbp
   0x00007a4902e76241:  48 83 c6 01        add    $0x1,%rsi
   0x00007a4902e76245:  48 89 e5           mov    %rsp,%rbp
   0x00007a4902e76248:  e8 13 fe ff ff     call   0x7a4902e76060 <match_repeat@plt>
   0x00007a4902e7624d:  0f b6 f8           movzbl %al,%edi
   0x00007a4902e76250:  e8 fb fe ff ff     call   0x7a4902e76150
   0x00007a4902e76255:  5d                 pop    %rbp
   0x00007a4902e76256:  c3                 ret
End of assembler dump.
```

`xor %eax,%eax` 函数先将返回值设为 `false`，接着执行指令 `cmp %rdx,%rsi` 比较 position 和 length，`jae 0x7a4902e7623d` 如果 `position >= length` 程序直接跳转到 `ret` 指令并且返回之前写入 `EAX` 的 0。

如果当前位置仍在输入范围内，程序 `cmpb $0x31,(%rdi,%rsi,1)` 继续检查对应的字符，立即数 `0x31` 是字符 `1` 的 ASCII 编码，所以这里比较 `input[position] == '1'`。如果字符不是 `1` 这接下来执行指令 `ret` 返回，否则跳转到 `0x7a4902e76240` 后将入参 `position+1` 后继续递归调用 `match_repeat`。

把这些分支合在一起，可以得到下面的等价伪代码：

```cpp
bool internal_match(const char* input, std::size_t position, std::size_t length) {
    if (position >= length) {
        return false;
    }

    if (input[position] != '1') {
        return false;
    }

    return match_repeat(input, position + 1, length);
}
```

### 计算每轮递归的栈开销

最后查看几个 `match_repeat()` 栈帧的位置：

```gdb
(gdb) frame 0
(gdb) info frame
Stack level 0, frame at 0x7a4902e55050:

(gdb) frame 2
(gdb) info frame
Stack level 2, frame at 0x7a4902e552b0:
```

相邻两个 match_repeat() 栈帧相差：`0x7a4902e552b0 - 0x7a4902e55050 = 0x260`。`0x260` 等于 608 字节。这表示在当前构建中，一轮完整的递归调用链会继续消耗 608 字节栈空间。

## 复盘：从异常信号收束到递归根因

这次定位没有把“调用栈里函数名重复出现”直接当成结论，而是让几类证据逐一对应：

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260902094141715.webp)

1. 使用与 Core 完全匹配的可执行文件和共享库加载现场，确认异常线程的调用栈中，`match_repeat()` 与名称不可见的内部函数交替出现；
2. 将 `RSP` 放回 Core 的 `LOAD` 映射后，发现它已经越过 128 KB 可读写线程栈的低地址边界，进入保护页；`si_addr` 与这个地址相同；
3. `RIP` 停在初始化当前层 `MatchFrame` 的写内存指令上，说明触发 `SIGSEGV` 的正是新栈帧对保护页的写入；
4. 对两个返回地址和对应的 `call` 指令进行核对，确认这不是栈损坏后被 GDB 错误展开出的伪调用链；
5. 根据 x86-64 System V 调用约定恢复参数，再读取 Core 中的输入，得到 `position = 208`、`length = 255`，以及由 255 个连续字符 `1` 组成的输入。

反汇编给出了最后一块因果关系：`match_repeat()` 只有在 `position == length` 时才正常结束；内部匹配函数只有在 `position < length` 且 `input[position] == '1'` 时，才把 `position` 加一后再次调用 `match_repeat()`。崩溃时的 `208 < 255`，当前位置又是 `1`，所以递归分支仍然成立，尚未到达终止条件。

因此，这不是逻辑上永远无法退出的无限递归，而是输入长度、每层保存的匹配状态和线程栈大小共同造成的**有限但过深的递归**。在这次构建中，两个相邻 `match_repeat()` 栈帧相差约 608 字节；这个数字只适用于本文的 GCC、优化选项和示例结构，不能直接套用到实际正则引擎。它足以解释为什么 128 KB 栈在处理完 255 个字符前先触及保护页。

Release 二进制中只看到 `match_repeat()` 的名字也不影响这条判断：它是刻意保留的动态符号，内部函数名称则已不可见。名称不可见时，仍可以从运行时地址反汇编、检查 `call` 的返回地址、按调用约定恢复参数。对这类故障而言，函数名只是入口；真正能确认根因的是调用关系、寄存器、内存映射和机器指令能够互相印证。
