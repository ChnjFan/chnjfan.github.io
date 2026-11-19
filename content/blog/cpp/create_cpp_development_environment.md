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

## 使用 Docker 开发环境

在嵌入式或 C/C++ 开发工作中，有时需要安装许多工具或者编译器。在开发不同项目时很容易会遇到版本冲突的问题，这一点在 C/C++ 着实令人头疼。所以项目开发中我们更倾向使用 Docker 容器来运行所有内容。

使用 Docker 可以让其他人也能快速编译并运行起你的项目，此外 CI 流水线也可以使用跟你相同的环境。

### 开始一个新项目

首先让我们创建一个新项目：

```bash
mkdir project_demo
cd project_demo
git init
```

安装完 [Docker](https://www.docker.com/products/docker-desktop/) 之后就可以在项目中新建一个 Dockerfile 文件：

```dockerfile
# Dockerfile
ARG base_tag=bullseye
ARG base_img=mcr.microsoft.com/vscode/devcontainers/base:dev-${base_tag}

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

这里的配置指定了基础镜像，并且安装了后续需要的软件包，在构建镜像时如果发现缺少了某个内容，直接在安装列表中添加即可。需要说明的是：

- 对于基础镜像 `base_tag` 最好使用固定标签，而不是 `latest` 这种动态标签（默认指向最新版本）。不同的基础镜像 apt 包版本差异很大，固定标签可以让 Dockerfile 构建保持一致，避免因为某个源更新或者包版本变化导致构建失效。
- 开发平台 `--plateform` 也要指定（这里是 `linux/amd64`），有些工具在特定架构中并没有发行包，例如 ARM 架构的 Mac 系统。

本文将要搭建一个包含 vscode 的开发环境，所以 `base_img` 配置了支持 [vscode 开发容器](https://code.visualstudio.com/docs/devcontainers/containers)的镜像。

配置好 Dockerfile 之后可以执行下面命令构建镜像：

```bash
docker build -f Dockerfile -t project_demo-builder:latest .
```

> 第一次执行时可能会很耗时，创建好之后就会缓存，只有在列表中添加新包之后才会重新安装。

当然我们也可以将冗长的 Docker 命令写进 Makefile

```makefile
project_name=project_demo

builder-build :
	docker build -f Dockerfile -t $(project_name)-builder:latest .
```

现在只需要执行 `make builder-build ` 就可以构建镜像。


