---
title: "搭建 Linux C/C++ 开发环境"
date: 2026-11-19T00:00:00+08:00
description: "从安装开发工具到编译、运行和调试第一个程序，逐步搭建 C++ 开发环境。"
tags: [c/c++]
---

毕业后，我先在一家通信公司做网络设备的协议开发，后来去了机器人公司做嵌入式设备。两份工作里，我用的都是项目上已经搭好的开发环境。等到想自己在 Github 做个新的开源项目，才发现我还没掌握怎么从零搭环境。

搭环境值得花时间，一套好用的测试框架和 CI/CD 流水线能省下不少重复操作。这次我想搭一套适用于 Linux 的 C++ 项目模板，参考的是 [A Modern C Development Environment](https://interrupt.memfault.com/blog/a-modern-c-dev-env)。当然我们也可以直接让大模型为你直接生成，但是在这篇文章中，我想亲自动手实现一下🤡。

如果你也想开始一个新项目，打开编辑器却不知道从哪一步开始，可以跟着这个例子搭一遍。

---

## 使用 Docker 搭建开发环境

在嵌入式或 C/C++ 开发工作中，不同项目可能需要不同版本的编译器和工具。如果把编译器和工具都装在同一台机器上，切换项目时很容易碰到版本冲突，这一点在 C/C++ 着实令人头疼。所以项目开发中我们更倾向使用 Docker 容器来运行所有内容。

其他人拿到项目后，使用 Docker 可以用相同的环境编译和运行程序。CI 流水线也可以用同一个镜像，和本地开发用同一套工具。

### 创建项目和 Dockerfile

新建 `demo` 目录，并在里面初始化 Git 仓库。

```bash
mkdir demo
cd demo
git init
```

安装 [Docker](https://www.docker.com/products/docker-desktop/) 后，在项目中新建一个 `Dockerfile`：

```dockerfile
# Dockerfile
ARG base_tag=ubuntu22.04
ARG base_img=mcr.microsoft.com/vscode/devcontainers/base:${base_tag}

FROM --platform=linux/amd64 ${base_img} AS builder-install

RUN apt-get update --fix-missing && apt-get -y upgrade
RUN apt-get install -y --no-install-recommends \
    apt-utils \
    curl \
    cmake \
    build-essential \
    libgtest-dev \
    gcc \
    g++-multilib \
    locales \
    make \
    gcovr \
    wget \
    && rm -rf /var/lib/apt/lists/*
```

这里的配置指定了基础镜像，并且安装了后续需要的软件包，在构建镜像时如果发现缺少了某个内容，直接在安装列表中添加即可。

- 对于基础镜像 `base_tag` 最好使用固定标签，而不是 `latest` 这种动态标签（默认指向最新版本）。不同的基础镜像 apt 包版本差异很大，固定标签可以让 Dockerfile 构建保持一致，避免因为某个源更新或者包版本变化导致构建失效。
- 开发平台 `--plateform` 也要指定（这里是 `linux/amd64`），有些工具在特定架构中并没有发行包，例如 ARM 架构的 Mac 系统。

本文将要搭建一个包含 vscode 的开发环境，所以 `base_img` 配置了支持 [vscode 开发容器](https://code.visualstudio.com/docs/devcontainers/containers)的镜像。

配置好 Dockerfile 之后可以执行下面命令构建镜像：

```bash
docker build -f Dockerfile -t demo-builder:latest .
```

> 第一次执行时可能会很耗时，创建好之后就会缓存，只有在列表中添加新包之后才会重新安装。

如果经常要构建镜像，可以把这条命令放进 `Makefile`。

```makefile
# Makefile
project_name=demo
builder-build :
	docker build -f Dockerfile -t $(project_name)-builder:latest .
```

现在只需要执行 `make builder-build` 就可以构建镜像。

构建成功后就可以进入容器，看看构建时设置的软件包是否安装成功：

```bash
docker run --rm -it demo-builder:latest /bin/bash
gcc --version
cmake --version
```

## 在 VS Code 中打开开发容器

在 VS Code 中安装 Dev Containers 扩展，然后创建 `.devcontainer/devcontainer.json`，告诉 vscode 将新构建的容器作为开发环境。

```json
{
  "name": "C++",
  "build": {
    "dockerfile": "../Dockerfile"
  },
  "customizations": {
    "vscode": {
      "settings": {
        "terminal.integrated.defaultProfile.linux": "bash",
        "extensions.verifySignature": false
      },
      "extensions": ["ms-vscode.cpptools", "ms-vscode.cmake-tools", "cschlosser.doxdocgen"]
    }
  }
}
```

保存后重新加载 VS Code 窗口，按提示在容器中重新打开项目。首次启动要等容器和扩展准备好，之后就可以通过 vscode 连接到你的 Linux 容器，并且所有的工具都会安装好。

## 最小项目结构

示例用 CMake 构建，包含一个 `demo` 库和一个示例程序。库提供一个返回 `Hello, World!` 的函数。

```text
demo/
├── .devcontainer/
│   └── devcontainer.json
├── include/
│   └── demo/
│       └── demo.h
├── src/
│   ├── CMakeLists.txt
│   ├── demo.cpp
├── app/
│   ├── CMakeLists.txt
│   └── main.cpp
├── CMakeLists.txt
├── Dockerfile
└── Makefile
```

```cpp
#include "demo/demo.h"
std::string demo() {
	return "Hello, World!";
}
```

打开远程实例的终端后执行 cmake 构建项目。

```bash
vscode ➜ /workspaces/project_demo (master) $ cmake -B build
-- The CXX compiler identification is GNU 11.4.0
-- Detecting CXX compiler ABI info
-- Detecting CXX compiler ABI info - done
-- Check for working CXX compiler: /usr/bin/c++ - skipped
-- Detecting CXX compile features
-- Detecting CXX compile features - done
-- Configuring done
-- Generating done
-- Build files have been written to: /workspaces/project_demo/build
vscode ➜ /workspaces/project_demo (master) $ cmake --build build
[ 25%] Building CXX object src/CMakeFiles/demo_lib.dir/demo.cpp.o
[ 50%] Linking CXX static library libdemo_lib.a
[ 50%] Built target demo_lib
[ 75%] Building CXX object app/CMakeFiles/demo.dir/main.cpp.o
[100%] Linking CXX executable demo
[100%] Built target demo
```

## 代码格式化和静态代码分析

C/C++ 代码的灵活性也伴随着大量潜在的陷阱，所以我们在项目中添加基础的静态代码分析，帮助我们发现明显的错误。

我们可以使用 clang-tidy 和 clang-format 工具分析和格式化项目代码。将 `.clang-format` 和 `.clang-tidy` 放到项目的根目录，任何集成开发工具都能自动识别。

这里的 `.clang-format` 我们直接使用 Google 编码风格，并且调整了缩进。

```text
---
Language: Cpp
BasedOnStyle: Google
IndentWidth: 4
UseTab: Never
IndentAccessModifiers: false
...
```

### 在构建镜像中安装

为 `.clang-format` 和 `.clang-tidy` 配置文件安装兼容的版本，可以直接在 Dockerfile 中手动安装：

```dockerfile
ARG base_tag=ubuntu22.04
ARG llvm_version=16
RUN apt-get update --fix-missing && apt-get -y upgrade
RUN apt-get install -y --no-install-recommends \
    gnupg2 \
    gnupg-agent \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl --fail --silent --show-error --location https://apt.llvm.org/llvm-snapshot.gpg.key | apt-key add -
RUN . /etc/os-release \
    && echo "deb https://apt.llvm.org/${VERSION_CODENAME}/ llvm-toolchain-${VERSION_CODENAME}-${llvm_version} main" > /etc/apt/sources.list.d/llvm.list

RUN apt-get update --fix-missing && apt-get -y upgrade
RUN apt-get install -y --no-install-recommends \
    clang-format-${llvm_version} \
    clang-tidy-${llvm_version} \
    && rm -rf /var/lib/apt/lists/*

RUN ln -s /usr/bin/clang-format-${llvm_version} /usr/local/bin/clang-format
RUN ln -s /usr/bin/clang-tidy-${llvm_version} /usr/local/bin/clang-tidy
```

然后在 VS Code 中输入指令 `Rebuild Contianer` 重新构建容器，我们就可以在容器中使用clang-tidy 和 clang-format，并且可以在 VS Code 配置文件 `.vscode/settings.json` 保存文件自动格式化。

```json
{
  "[c]": {
    "editor.formatOnSave": true,
    "editor.defaultFormatter": "ms-vscode.cpptools"
  },
  "[cpp]": {
    "editor.formatOnSave": true,
    "editor.defaultFormatter": "ms-vscode.cpptools"
  },
  "C_Cpp.default.compileCommands": "${workspaceFolder}/build/compile_commands.json",
  "cmake.configureOnOpen": true
}
```


