+++
title = "深入理解 C++ 单例模式：从 CRTP 到 std::call_once"
description = "采用 CRTP 实现的 C++ 单例模式"
date = "2026-07-04"
aliases = ["boost.beast", "http server"]
author = "ChnjFan"
tags = [
    "C++",
    "模式设计",
]
categories = [
    "基础技术",
]
+++


{{< notice info >}}
以 [IMServer](https://github.com/ChnjFan/IMServer) 项目中的 `Singleton<T>` 模板为例，拆解奇异递归模板（CRTP）与线程安全懒加载的实现细节。
{{< /notice >}}

## 为什么需要单例？

在一个多服务端的即时消息系统中，有些资源全局只需要**一个**实例：

| 类 | 职责 | 为什么必须唯一 |
|---|---|---|
| `RedisMgr` | Redis 连接池 | 多实例意味着重复的连接和浪费的句柄 |
| `AsioIOServicePool` | Asio IO 服务池 | 线程池应当全局共享而非各自为政 |
| `ChatLogicSystem` | 消息逻辑分发中心 | 多个分发中心会导致消息路由混乱 |
| `UserMgr` | 在线用户映射表 | uid → Session 的映射必须全局一致 |
| `LogicSystem` | HTTP 路由分发 | 注册两份 handler 会引发回调冲突 |
| `ThreadPool` | 全局 CPU 线程池 | 重复创建线程池浪费系统资源 |

如果每次用一个 `new` 来创建，或者写在全局变量里，要么泄漏、要么初始化顺序不可控。**单例模式**正是解决"全局唯一、按需创建、自动销毁"这三个需求的利器。


## `Singleton.h` 完整实现

先来看 IMServer 中 `src/base/Singleton.h` 的代码：

```cpp
#ifndef IMSERVER_SINGLETON_H
#define IMSERVER_SINGLETON_H

#include <memory>
#include <mutex>

template<typename T>
class Singleton {
public:
    // 删除拷贝构造和拷贝赋值，杜绝复制单例的可能
    Singleton(const Singleton&) = delete;
    Singleton& operator=(const Singleton&) = delete;

    static std::shared_ptr<T> getInstance() {
        static std::once_flag onceToInit;
        std::call_once(onceToInit, [&]() {
            // make_shared 无法调用私有构造函数，
            // 因此使用 new T 构造，再交给 shared_ptr 管理
            instance_ = std::shared_ptr<T>(new T);
        });
        return instance_;
    }

protected:
    Singleton() = default;

    static std::shared_ptr<T> instance_;
};

template<typename T>
std::shared_ptr<T> Singleton<T>::instance_ = nullptr;

#endif // IMSERVER_SINGLETON_H
```

不到 40 行，却集成了三个关键设计点：**CRTP**、**友元授权**、**线程安全懒加载**。我们逐一拆解。


## 核心机制 I：奇异递归模板（CRTP）

### 什么是 CRTP？

CRTP（Curiously Recurring Template Pattern）是 C++ 中一种静态多态技法——**一个类继承自一个以自身为模板参数的基类**：

```cpp
class RedisMgr : public Singleton<RedisMgr> { ... };
//                      ^^^^^^^^^^^^^^^^
//                      模板参数正是派生类自身
```

这种"自己继承了自己当参数"的写法看起来"奇异"，却能带来强大的编译期多态能力。

CRTP 是编译期多态，不靠虚函数，没有 vtable 的开销；基类通过 `static_cast` 安全向下转型，调用派生类自定义接口；模板实例化时类型已知，转型安全（继承约束保证）。

适合统一基类封装流程，派生类填充细节。

### 为什么不用传统的虚函数？

经典的做法是用虚函数实现单例基类：

```cpp
class SingletonBase {
public:
    virtual ~SingletonBase() = default;
    static SingletonBase* getInstance();  // 返回基类指针
};

class RedisMgr : public SingletonBase { ... };
```

这样调用者拿到的是 `SingletonBase*`，每次使用都要 `dynamic_cast<RedisMgr*>`，不仅有运行时开销，还丢失了类型信息。

**CRTP 让基类"认识"派生类：**

```cpp
template<typename T>
class Singleton {
    static std::shared_ptr<T> getInstance();  // 直接返回派生类指针
};
```

`T` 就是派生类本身，所以 `getInstance()` 返回的是**精确类型**，完全在编译期确定，零开销。

单例类采用 CRTP：

```cpp
// src/base/RedisMgr.h
class RedisMgr : public Singleton<RedisMgr> {
    friend class Singleton<RedisMgr>;  // 见第四节
    // ...
};
```

调用方使用时类型完全透明：

```cpp
// 拿到的是 shared_ptr<RedisMgr>，不是 Singleton<RedisMgr>
auto redis = RedisMgr::getInstance();
redis->set("token_abc", "online");
```


## 核心机制 II：友元授权打开私有构造

{{< notice question >}}
既然构造函数是 `private` 的，基类怎么创建派生类实例？
{{< /notice >}}

`Singleton<T>` 的构造函数是 `protected`，派生类当然可以默认继承，但问题在于**调用链**：

1. 外部调用 `RedisMgr::getInstance()`
2. 该方法继承自 `Singleton<RedisMgr>`
3. 在 `getInstance()` 内部执行 `new T`（即 `new RedisMgr`）
4. 但 `Singleton<RedisMgr>` 并不是 `RedisMgr` 的友元——**基类模板无权访问派生类的私有构造函数。**

这就是 `friend class Singleton<T>` 存在的原因：

```cpp
class RedisMgr : public Singleton<RedisMgr> {
    friend class Singleton<RedisMgr>;  // 显式授权
private:
    RedisMgr() = default;              // 外部无法直接构造
};
```

| 访问者 | 能否构造 `RedisMgr`？ | 原因 |
|---|---|---|
| 外部代码 `RedisMgr r;` | ❌ | 构造函数私有 |
| `new RedisMgr()` | ❌ | 构造函数私有 |
| `Singleton<RedisMgr>::getInstance()` | ✅ | 被声明为友元 |
| `RedisMgr::getInstance()` | ✅ | 继承自友元基类 |

**基类和派生类配合形成了一道"只有我能创建自己"的封装壁垒。**

{{< notice tip >}}
**常见错误**：忘记在派生类中加 `friend class Singleton<T>`。编译时会在 `getInstance()` 内部的 `new T` 处报 `error: calling a private constructor` —— 加友元即可解决。
{{< /notice >}}


## 核心机制 III：`std::call_once` 实现线程安全懒加载

### 为什么加一个 `std::once_flag`？

IMServer 是高并发系统 —— `ChatLogicSystem` 可能在多个工作线程中首次被访问。最简单的"检查-加锁"模式存在双重检查锁定的复杂性：

```cpp
// ❌ 经典的双重检查锁定 —— 在 C++11 前存在内存序问题
static T* getInstance() {
    if (!instance_) {
        std::lock_guard<std::mutex> lock(mtx);
        if (!instance_) {
            instance_ = new T;
        }
    }
    return instance_;
}
```

C++11 之后，标准库提供了更优雅的方案：

```cpp
static std::shared_ptr<T> getInstance() {
    static std::once_flag onceToInit;      // 每个 T 类型一个 flag（函数内 static）
    std::call_once(onceToInit, [&]() {
        instance_ = std::shared_ptr<T>(new T);
    });
    return instance_;
}
```

**保证**：无论多少个线程同时首次调用 `getInstance()`，lambda 内的初始化代码**有且仅会执行一次**，其他线程会阻塞等待完成后再返回。

### why `shared_ptr` 而不是裸指针？

项目中用 `std::shared_ptr<T>` 管理实例，有两个好处：

1. **自动生命周期**：进程退出时 `shared_ptr` 被销毁，`T` 的析构函数会被调用（比如 `RedisMgr` 关闭连接、`ThreadPool` 停止线程）。
2. **持有安全**：调用方拿到的是一个引用计数的智能指针，不用担心某个单例被意外析构后悬空。

### 为什么不用 `make_shared`？

代码注释已经解释了：`make_shared` 无法调用私有构造函数，单例模式都将构造函数放在 `private` 中。

`make_shared<T>(args...)` 是自由函数，不是友元，当 `T` 的构造函数私有时会编译失败。而 `std::shared_ptr<T>(new T)` 中 `new T` 发生在基类友元函数内部，可以访问私有构造函数。

---

## 与 Meyer's Singleton 的对比

在 C++11 之后，最"教科书式"的单例写法是 **Meyer's Singleton**——利用函数内局部 `static` 变量的初始化语义：

```cpp
// Meyer's Singleton —— 最简写法
class RedisMgr {
public:
    static RedisMgr& getInstance() {
        static RedisMgr instance;  // C++11 保证线程安全的初始化
        return instance;
    }

    RedisMgr(const RedisMgr&) = delete;
    RedisMgr& operator=(const RedisMgr&) = delete;

private:
    RedisMgr() = default;
};
```

看起来更简洁，那为什么 IMServer 没有采用这种写法？两种方案的关键差异如下：

### 对比维度

| 维度 | Meyer's Singleton | IMServer 的 `Singleton<T>` (CRTP) |
|---|---|---|
| **代码量** | 每个单例类写一遍 `static instance` + 删除拷贝 | 继承基类 + 一行友元，**复用框架** |
| **重复代码** | N 个单例 = N 份几乎相同的 `getInstance()` | N 个单例 = 0 份重复，逻辑集中在基类 |
| **返回类型** | 引用 `T&`（无所有权语义） | `shared_ptr<T>`（引用计数，自动析构） |
| **线程安全** | ✅ C++11 标准保证 `static` 局部变量初始化线程安全 | ✅ `std::call_once` 显式保证 |
| **可测试性** | 难以 mock/替换（硬编码 `static` 实例） | 可通过 `shared_ptr` 注入替换 |
| **初始化顺序** | 首次调用时构造（懒加载） | 首次调用时构造（懒加载） |
| **跨类一致性** | 每个类自己实现，风格可能漂移 | 强制统一，代码审查只需看基类 |

### 核心差异：复用 vs 内聚

Meyer's Singleton 的问题不在于"能不能用"，而在于**规模化时的重复成本**。IMServer 有 7 个单例类，如果每个都手写一遍：

```cpp
// 7 个类里各写一遍这样的代码 👇
static RedisMgr& getInstance() {
    static RedisMgr instance;
    return instance;
}
// ... 拷贝到 AsioIOServicePool、ChatLogicSystem、UserMgr ...
```

一旦需要修改初始化逻辑（比如加日志、改锁策略、换智能指针），就要改 7 处。CRTP 模板把这份逻辑**上提到基类**，改一处即可覆盖全部。

### 另一个细节：`shared_ptr` vs 引用

Meyer's 返回裸引用 `T&`，调用方无法持有"所有权"——单例的生命周期完全由静态存储期决定，进程退出时才析构。而 IMServer 返回 `shared_ptr<T>`：

```cpp
// Meyer's —— 拿到引用，无法控制生命周期
RedisMgr& redis = RedisMgr::getInstance();

// IMServer —— 拿到 shared_ptr，引用计数管理
auto redis = RedisMgr::getInstance();
```

在高并发场景下，`shared_ptr` 让调用方可以安全地持有实例（比如跨异步回调传递），而不担心单例在自己使用时被析构。代价是轻微的引用计数开销，但对于单例这种低频访问的场景完全可以忽略。

### 什么时候该用 Meyer's？

- 项目只有 **1-2 个**单例，不值得引入模板基类
- 追求**极简代码**，不需要 `shared_ptr` 语义
- 类的构造函数是 **public** 的（不需要友元授权）

### 什么时候该用 CRTP 模板？

- 项目有 **多个** 单例类，需要统一风格
- 需要 **`shared_ptr` 所有权语义**
- 构造函数是 **private** 的，需要友元协作
- 未来可能**统一修改**初始化逻辑（如加监控、换分配器）

{{< notice tip >}}
**一句话总结**：Meyer's Singleton 是"每个类自己写"，CRTP Singleton 是"写一次，所有类复用"。IMServer 选择了后者，因为 7 个单例类的规模足以让复用收益超过模板的复杂度成本。
{{< /notice >}}

## IMServer 中的完整使用案例

### 场景一：获取 Redis 连接池

```cpp
// src/ChatServer/core/ChatLogicSystem.cpp
auto redisMgr = RedisMgr::getInstance();
redisMgr->hset("user_online_" + uid, "token", token);
```

### 场景二：路由 HTTP 请求

```cpp
// src/GateServer/HttpConnection.cpp
auto logic = LogicSystem::getInstance();
logic->postHandlers_[url] = [](const HttpConnectionPtr& conn) {
    // 注册回调...
};
```

### 场景三：分发持久化的逻辑消息

```cpp
// src/ChatServer/net/Session.cpp —— TCP Session 收到消息后
auto chatLogic = ChatLogicSystem::getInstance();
chatLogic->postMsgToQueue(msgNode);
```

### 场景四：查询在线用户 Session

```cpp
// src/ChatServer/core/ChatLogicSystem::dealChatLogin()
auto userMgr = UserMgr::getInstance();
userMgr->onlineUsers_[uid] = session;  // 登录时登记
```

可以看出，整个 IMServer 的消息链路可以总结为：

```shell
HTTP Session ──→ LogicSystem::getInstance()──→ 路由分发
TCP  Session ──→ ChatLogicSystem::getInstance()──→ 消息队列
                                 ↓
                RedisMgr::getInstance() / UserInfoCache::getInstance()
```


## 总结

IMServer 的 `Singleton.h` 用 **40 行代码**封装了三个强大的 C++ 范式：

| 机制 | 实现 | 作用 |
|---|---|---|
| **CRTP** | `class T : public Singleton<T>` | 编译期多态，基类认识派生类，返回精确类型 |
| **友元授权** | `friend class Singleton<T>` | 基类能 `new T()`，外部无法直接构造 |
| **线程安全** | `std::call_once` | 多线程下懒初始化，无竞态、无手动加锁 |

这种设计让单例类的声明变得非常简洁——派生类只需继承 + 声明一个友元，即可获得全局唯一、线程安全、懒加载、自动回收的能力，无需在业务逻辑中重复编写框架代码。

> 📁 源码位置：`src/base/Singleton.h`

