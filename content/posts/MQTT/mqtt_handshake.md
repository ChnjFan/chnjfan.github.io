+++
title = "第一次握手：CONNECT/CONNACK 与版本协商"
description = "追踪一次连接从 TCP 到 CONNACK 的完整链路与版本协商"
date = "2026-08-14"
aliases = ["MQTT-handshake"]
author = "ChnjFan"
tags = [
    "paho.mqtt.cpp",
    "MQTT",
]
categories = [
    "MQTT",
]
+++


客户端调用 `connect()` 之后发送了 CONNECT 报文，等收到 CONNACK 之后才真正上线。虽然这段路不长，但校验逻辑、版本逻辑、会话逻辑全在这条路上。

用户在客户端中调用 `cli->connect(connOpts)`，以为只是发个 CONNECT 报文，其实中间有三步要走：

- **参数校验**。结构体魔术字 `struct_id` 是否正确、`will` 的 QoS 合不合法、`username`/`password` 是不是合法 UTF-8、v3 的 clean session 和 v5 的 clean start 是否写反，任何一项不满足，CONNECT 在发出之前就被拦下。
- **报文构造**。将结构体字段翻译成报文的字节序列，协议名、版本级别、Connect Flags、keepalive、clientID 一个都不能少。
- **版本协商**。如果没指定版本就先按 3.1.1 试，Broker 拒绝就降级到 3.1 再来一次。

本文将沿着 `MQTTClient.c` 同步客户端、`MQTTAsync.c` 异步客户端、`MQTTPacketOut.c` 报文构造和 CONNACK 报文处理逐段拆解，解答 MQTT 协议握手协商中的疑惑：

- 了解 `connect()` 的完整调用链长什么样，同步和异步客户端在连接前都各自做了哪些校验？
- CONNECT 报文在代码里是怎么一段段构造出来的，又是怎么跟 Wireshark 抓包出来的字节对应？
- 版本协商是怎么做的？CONNACK 里的返回值码和 session present 标志决定了什么？ 

这里先给出结论：

- paho.mqtt.cpp 的 `connect()` 最终调用的 paho.mqtt.c 库中的同步连接 `MQTTClient_connectAll` 或异步连接 `MQTTAsync_connect`，这两个函数的参数校验基本一致，结构体魔术字（"MQTC"）、`struct_version` 范围、`will` 结构、UTF-8、版本互斥、`cleansession`/`cleanstart` 只许二选一。
- 构造报文是「算长度 → 写字段 → 发送」三步：`MQTTPacket_send_connect` 先算总字节数，再逐字段写，最后交 `MQTTPacket_send` 发送。
- 版本协商是「先 4 后 3」：未指定版本时（`MQTTVERSION_DEFAULT`），同步库先带 `MQTTVersion=4` 连一次，CONNACK 拒绝或连接失败则降级 3 再连。收到的 CONNACK 带 session present 标志，决定这次连接是续接旧会话还是开新会话。


## connect 与参数校验

### 同步阻塞与异步入队

paho.mqtt.cpp 的 `connect()` 只是对外封装的接口，真正调用的是 paho.mqtt.c 库中的两个接口：

- 同步 `MQTTClient_connect` 和 `MQTTClient_connectAll`：阻塞到 CONNACK 回来或超时，返回一个 `MQTTResponse`；
- 异步 `MQTTAsync_connect`：把 CONNECT 命令塞进命令队列，由 sendThread 取出执行，结果通过 onSuccess/onFailure 回调（或 token）通知。

同步连接函数进来之后就是很长的校验链，我们把最容易踩坑的地方捞出来看看：

```c
// paho.mqtt.c/src/MQTTClient.c:1782-1868（connectAll 校验链节选）
MQTTResponse MQTTClient_connectAll(MQTTClient handle,
        MQTTClient_connectOptions* options,
		MQTTProperties* connectProperties, MQTTProperties* willProperties)
{
    //...
    // 判空检查
    if (options == NULL || m == NULL || m->c == NULL)
    {
        rc.reasonCode = MQTTCLIENT_NULL_PARAMETER;
        goto exit;
    }
    // 结构体魔术字检查
    if (strncmp(options->struct_id, "MQTC", 4) != 0 
        || options->struct_version < 0 || options->struct_version > 8)
    {
        rc.reasonCode = MQTTCLIENT_BAD_STRUCTURE;
        goto exit;
    }

    if (options->will) // will 结构校验
    {
        if (strncmp(options->will->struct_id, "MQTW", 4) != 0 
            || (options->will->struct_version != 0 
                && options->will->struct_version != 1))
        {
            rc.reasonCode = MQTTCLIENT_BAD_STRUCTURE;
            goto exit;
        }
        if (options->will->qos < 0 || options->will->qos > 2)
        {// QoS 只能是 0/1/2
            rc.reasonCode = MQTTCLIENT_BAD_QOS;
            goto exit;
        }
        if (options->will->topicName == NULL)
        {// will topic 不能为空
            rc.reasonCode = MQTTCLIENT_NULL_PARAMETER;
            goto exit;
        } else if (strlen(options->will->topicName) == 0)
        {
            rc.reasonCode = MQTTCLIENT_0_LEN_WILL_TOPIC;
            goto exit;
        }
    }
    // UTF-8 校验字符串正确性
    if ((options->username && !UTF8_validateString(options->username)) ||
        (options->password && !UTF8_validateString(options->password)))
    {
        rc.reasonCode = MQTTCLIENT_BAD_UTF8_STRING;
        goto exit;
    }

    if (options->MQTTVersion != MQTTVERSION_DEFAULT &&
            (options->MQTTVersion < MQTTVERSION_3_1 
            || options->MQTTVersion > MQTTVERSION_5))
    {// 版本必须是 0/3/4/5
        rc.reasonCode = MQTTCLIENT_BAD_MQTT_VERSION;
        goto exit;
    }

    if (options->MQTTVersion >= MQTTVERSION_5)
    {// v5 不允许设置 cleansession
        if (options->cleansession != 0)
        {
            rc.reasonCode = MQTTCLIENT_BAD_MQTT_OPTION;
            goto exit;
        }
    }
    else if (options->cleanstart != 0)
    {// v3 不允许设置 cleanstart
        rc.reasonCode = MQTTCLIENT_BAD_MQTT_OPTION;
        goto exit;
    }

    //... 连接逻辑
}
```

异步连接 `MQTTAsync_connect` 的校验链几乎逐条对应，再额外增加了几条版本相关的，比如客户端在创建时设置了 MQTT 版本，connect 时想升级到 v5 会返回 `MQTTASYNC_WRONG_MQTT_VERSION`；用 v3 选项结构（`struct_version < 6`）却想带 v5 专属字段（`onSuccess5`、`connectProperties` 等），直接 `MQTTASYNC_BAD_MQTT_OPTION`。

```c
// paho.mqtt.c/src/MQTTAsync.c（精简）
int MQTTAsync_connect(MQTTAsync handle, const MQTTAsync_connectOptions* options)
{
    //... 其他校验
    if (options->MQTTVersion < MQTTVERSION_5 && options->struct_version >= 6)
    {
        if (options->cleanstart != 0 || options->onFailure5 || options->onSuccess5
                || options->connectProperties || options->willProperties)
        {
            rc = MQTTASYNC_BAD_MQTT_OPTION;
            goto exit;
        }
    }
}
```

### 为什么需要这么多校验

把校验链读一遍会发现校验的方向很统一，绝大多数「连接失败」不是网络问题，而是选项自相矛盾。Paho 库宁愿通过几十行代码在发包前拦住，也不愿意发一个注定被 Broker 拒绝的 CONNECT。

- clean session / clean start 互斥：`cleansession` 是 v3 的概念，`cleanstart` 是 v5 的概念，为了版本兼容两个字段会在客户端结构里同时存在，但如果用户同时设置这两个字段，库会直接返回错误 `BAD_MQTT_OPTION`。
- `will` 的 QoS 越界：`will->qos = 3` 不会连上才出问题，而是 `MQTTCLIENT_BAD_QOS` 直接拒绝，will 结构同样有魔术字 `"MQTW"` 校验。所以 paho.mqtt.cpp 库中都是直接用 `MQTTAsync_willOptions_initializer` 这类初始化宏来设置默认配置，避免结构体出错。
- 异步版本锁：异步客户端 `create` 时版本就定了，比如 3.1.1，后续 `connect()` 想切到 v5 会得到 `WRONG_MQTT_VERSION` 错误码。版本选择要在客户端创建时就决策好，而不是连接时。

此外还有上一篇「报文的结构：固定头、剩余长度与 UTF-8」提到的 UTF-8 校验字符串类型；`MQTTVersion` 的取值决定了下一步构造报文时的协议名和级别。


## CONNECT 报文构造与发送

校验通过后，连接请求进入报文构造。核心函数 `MQTTPacket_send_connect` 分三步：算总长度、逐字段写、发送。

```c
// paho.mqtt.c/src/MQTTPacketOut.c:48-72（节选）
int MQTTPacket_send_connect(Clients* client, int MQTTVersion,
        MQTTProperties* connectProperties, MQTTProperties* willProperties)
{
    Connect packet;
    //...
    packet.header.byte = 0;
    packet.header.bits.type = CONNECT;      // 第一字节：type=1 → 0x10

    /* 先算报文总长度，一次 malloc */
    len = ((MQTTVersion == MQTTVERSION_3_1) ? 12 : 10)   // 3.1 可变头多 2 字节
          + (int)strlen(client->clientID) + 2;
    if (client->will)
        len += (int)strlen(client->will->topic) + 2 + client->will->payloadlen + 2;
    if (client->username)
        len += (int)strlen(client->username) + 2;
    if (client->password)
        len += client->passwordlen + 2;
    if (MQTTVersion >= MQTTVERSION_5)
    {
        len += MQTTProperties_len(connectProperties);   // v5 属性也要算进长度
        if (client->will)
            len += MQTTProperties_len(willProperties);
    }
    ptr = buf = malloc(len);
    //...
}
```

注意 `(MQTTVersion == MQTTVERSION_3_1) ? 12 : 10`，3.1 的可变头固定部分比 3.1.1/5.0 多 2 字节。3.1 的协议名是 `MQIsdp`（2+6=8 字节）+ 级别 1 字节 + flags 1 字节 + keepalive 2 字节 = 12，而 3.1.1 / 5.0 的协议名 `MQTT`（2+4=6）→ 10。

接下来逐字段写报文内容：

```c
// paho.mqtt.c/src/MQTTPacketOut.c:74-120（节选）
int MQTTPacket_send_connect(Clients* client, int MQTTVersion,
        MQTTProperties* connectProperties, MQTTProperties* willProperties)
{
    //... 计算完报文长度申请内存

    if (MQTTVersion == MQTTVERSION_3_1)
    {
        writeUTF(&ptr, "MQIsdp");                       // 协议名（含 2 字节长度）
        writeChar(&ptr, (char)MQTTVERSION_3_1);         // 级别 3
    }
    else if (MQTTVersion == MQTTVERSION_3_1_1 || MQTTVersion == MQTTVERSION_5)
    {
        writeUTF(&ptr, "MQTT");                         // 协议名
        writeChar(&ptr, (char)MQTTVersion);             // 级别 4 或 5
    }
    else
        goto exit;                                      // 版本不识别，直接失败

    packet.flags.all = 0;
    if (MQTTVersion >= MQTTVERSION_5)   // 两个字段都保存在 cleanstart 同一 bit
        packet.flags.bits.cleanstart = client->cleanstart;  // v5：Clean Start
    else
        packet.flags.bits.cleanstart = client->cleansession; // v3：Clean Session
    packet.flags.bits.will = (client->will) ? 1 : 0;
    if (packet.flags.bits.will)
    {   // 遗嘱消息 Qos 和保留标记
        packet.flags.bits.willQoS = client->will->qos;
        packet.flags.bits.willRetain = client->will->retained;
    }
    if (client->username)  packet.flags.bits.username = 1;
    if (client->password)  packet.flags.bits.password = 1;

    writeChar(&ptr, packet.flags.all);                  // Connect Flags
    writeInt(&ptr, client->keepAliveInterval);          // Keep Alive（秒）
    if (MQTTVersion >= MQTTVERSION_5)
        MQTTProperties_write(&ptr, connectProperties);  // v5 属性段
    writeUTF(&ptr, client->clientID);                   // Client Identifier
    if (client->will) { /* will topic + payload（v5 先写 will properties） */ }
    if (client->username) writeUTF(&ptr, client->username);
    if (client->password) writeData(&ptr, client->password, client->passwordlen);

    rc = MQTTPacket_send(&client->net, packet.header, buf, len, 1, MQTTVersion);
}
```

两个细节：

1. **Connect Flags** 位字段与协议的精确对应。`cleanstart`（v5）和 `cleansession`（v3）在报文里落在同一个 bit（bit1），但是语义不同。`will`/`willRetain`/`username`/`password` 各占一位，`willQoS` 占两位。`writeChar(&ptr, packet.flags.all)` 之前通过 `packet.flags.all = 0` 清空。
2. `MQTTVersion` 是「实际使用的版本」。调用方传入的是经过协商的版本，不会是 `MQTTVERSION_DEFAULT(0)`，所以这里判断版本不识别的兜底逻辑实际不会出现。

最后一行 `MQTTPacket_send()` 调用是 Packet 层发送报文的核心实现，通过序列化固定头与剩余长度，并且写入网络，一条完整的连接请求就此出发。


{{< notice tip >}}
`writeUTF` 在写 `clientID` 的时候用 `strlen` 计算长度，如果 `clientID` 字符串长度超过了 65535，写 2 字节大端长度时会溢出成错误值。业务侧生成 `clientID` 这些字符串的时候应该做长度保护，否则构造出的报文异常。
{{< /notice >}}


## 版本协商与 CONNACK

### 版本协商：先 3.1.1，不行就 3.1

发送 CONNECT 前，要定下「用哪个协议版本」。如果用户没有显式设置版本，`MQTTVersion = MQTTVERSION_DEFAULT(0)` 时就会触发版本协商。

在同步客户端中直接尝试两次：

```c
// paho.mqtt.c/src/MQTTClient.c:1728-1734
static MQTTResponse MQTTClient_connectURI(MQTTClient handle,
        MQTTClient_connectOptions* options, const char* serverURI,
		MQTTProperties* connectProperties, MQTTProperties* willProperties)
{
    //...
    if (MQTTVersion == MQTTVERSION_DEFAULT)
    {
        rc = MQTTClient_connectURIVersion(handle, options, serverURI,
                4, start, millisecsTimeout,
                connectProperties, willProperties);
        if (rc.reasonCode != MQTTCLIENT_SUCCESS)
        {// 3.1.1 连接失败，开始尝试 3.1 版本
            rc = MQTTClient_connectURIVersion(handle, options, serverURI, 
                    3, start, millisecsTimeout,
                    connectProperties, willProperties);
        }
    }
    else    // 用户显式设置了版本号
        rc = MQTTClient_connectURIVersion(handle, options, serverURI,
                MQTTVersion, start, millisecsTimeout,
                connectProperties, willProperties);
}
```

异步客户端中连接命令重试时逐次降级，sendThread 取出 CONNECT 命令时查看版本：

```c
// MQTTAsyncUtils.c:1366-1374 — processCommand 处理 CONNECT
static int MQTTAsync_processCommand(void)
{
    // ... 从命令队列中读取命令
    if (command->command.type == CONNECT)
    {
        if (command->client->c->MQTTVersion == MQTTVERSION_DEFAULT)
            {
                if (command->command.details.conn.MQTTVersion
                        == MQTTVERSION_DEFAULT) // 还没试过先用 v3.1.1
                    command->command.details.conn.MQTTVersion = MQTTVERSION_3_1_1;
                else if (command->command.details.conn.MQTTVersion
                        == MQTTVERSION_3_1_1) // 已经试过 v3.1.1 且失败降级到 v3.1
                    command->command.details.conn.MQTTVersion = MQTTVERSION_3_1;
            }
            else    // 用户指定了版本
                command->command.details.conn.MQTTVersion 
                    = command->client->c->MQTTVersion;
        //... MQTTProtocol_connect
    }
}
```

完整的协商流程如下：

```
用户调用 connect() → MQTTVersion == MQTTVERSION_DEFAULT ?
                    ├─ 是 → 进入协商流程
                    │       │
                    │       ▼
                    │   第1次：发 CONNECT (version=4, 即 v3.1.1)
                    │       ├─ 收到 CONNACK rc=0 → ✅ 连接成功 (v3.1.1)
                    │       └─ 收到 CONNACK rc!=0 或超时
                    │           │
                    │           ▼
                    │       第2次：发 CONNECT (version=3, 即 v3.1)
                    │           ├─ 收到 CONNACK rc=0 → ✅ 连接成功 (v3.1)
                    │           └─ 收到 CONNACK rc!=0 或超时 → ❌ 连接失败
                    │
                    └─ 否 → 用指定版本（v3 / v3.1.1 / v5）
                            ├─ 成功 → ✅
                            └─ 失败 → ❌ 不降级，直接失败
```

v3.1.1 降级到 v3.1 几乎总是因为 Broker 是 2014 年之前的旧实现只支持 v3.1 版本。注意版本协商只影响协议名和级别字段，不会修改会话或 QoS 等高层的语义。v5 不会做版本协商，想用 v5 版本必须显式指定。


### CONNACK：一次握手的落幕

CONNECT 成功发出去，Broker 就会回 CONNACK：

```
0x20 02 [flags] [return code] [v5 Properties]
```

- `0x20`：CONNACK 报文类型 2 左移 4 位。
- flags 的低 1 位是 session present，值为 1 表示 Broker 中存在旧会话，3.1.1+ 才有此位，3.1 的 CONNACK 此位恒 0。
- return code 的值为 0 表示接受连接，1-5 分别是不接受的协议版本 / 客户端标识被拒 / 服务不可用 / 用户密码错 / 未授权。
- v5 版本还会携带 Properties 返回给客户端，包含服务端的 Keep Alive、Reason String、Auth Data 等。

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260814172526711.png)

异步客户端的 receiveThread 读到 CONNACK 报文后交给 `MQTTAsync_completeConnection` 处理。

```c
//paho.mqtt.c/src/MQTTAsyncUtils.c:MQTTAsync_receiveThread (精简)
thread_return_type WINAPI MQTTAsync_receiveThread(void* n)
{
	while (!MQTTAsync_tostop)
    {
        pack = MQTTAsync_cycle(&sock, timeout, &rc);
        if (pack->header.bits.type == CONNACK)
        {
            Connack* connack = (Connack*)pack;
            rc = MQTTAsync_completeConnection(m, connack);
            if (rc == MQTTASYNC_SUCCESS)
            {
                if (m->connect.onSuccess) { /* on_success 回调 */ }
                if (m->connected)
                {   // connected 回调
                    char* reason = (onSuccess) 
                        ? "connect onSuccess called" 
                        : "automatic reconnect";
                    (*(m->connected))(m->connected_context, reason);
                }
                if (m->c->MQTTVersion >= MQTTVERSION_5)
                {
                    //... v5 会返回消息在传队列的大小
                }
            }
            else
            {// Broker 返回错误
                nextOrClose(m, rc, "CONNACK return code");
            }
            MQTTPacket_freeConnack(connack);
        }
    }
}
```

返回码 0 时，将 `connected` 标记置为 1 表示连接已建立，按 `sessionPresent` 决定是否清理本地会话，触发 `onSuccess` / `connected` 回调。

如果返回错误，`MQTTAsync_completeConnection` 直接返回具体的原因码，然后由 `nextOrClose` 进行降级处理或关闭连接。

同步客户端中没有回调，`MQTTClient_connectAll` 里用 `MQTTClient_waitfor(CONNACK)` 来阻塞等待 CONNACK，期间把 keepalive 之外的报文都跳过，直到等来握手应答或超时。


## 总结

到此我们已经走完了 `connect()` 调用后的参数校验、报文构造和版本协商的整个握手流程，数据流向：

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260814173335453.png)

- 连接入口中，同步/异步共用一套校验链，检查结构体魔术字、struct_version、will、UTF-8、clean session/clean start 互斥、版本范围，所有的错误在发包前就被拦截；
- `MQTTPacket_send_connect` 分三步构造：算长度、写字段、发送。3.1 头部比 3.1.1 多 2 字节。
- 版本协商 DEFAULT 时「先 3.1.1、失败回退 3.1」，CONNACK 的 session present 与返回码决定会话是否复用。

在最后接收到 CONNACK 里的 session present，我们将在下一篇「会话：clean session 真正清理了什么」中用源码来回答：clean session / clean start 到底清理了什么、为什么 v5 用 session expiry 取代了它、以及为什么 `cleansession` 和 `cleanstart` 在连接入口被强制互斥。
