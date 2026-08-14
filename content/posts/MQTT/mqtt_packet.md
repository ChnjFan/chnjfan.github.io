+++
title = "报文的结构：固定头、剩余长度与 UTF-8"
description = "看懂任意 MQTT 报文的字节构成，手拼一个 CONNECT"
date = "2026-08-14"
aliases = ["MQTT-packet"]
author = "ChnjFan"
tags = [
    "paho.mqtt.cpp",
    "MQTT",
]
categories = [
    "MQTT",
]
+++

用 Wireshark 抓过 MQTT 流量之后，多半盯着报文列表发过呆：第一条 CONNECT 开头是 `0x10 0x43` 加一串看起来随机的字节，第二条 PUBLISH 开头是 `0x32`。你大概知道第一个字节代表报文类型，但 `0x10` 和 `0x32` 是什么关系？`0x43` 是哪来的？如果一条消息很大，剩余长度超过 127 是怎么塞进一个字节的？

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260813201240941.png)

再进一步，如果 Topic 中带有中文字符，客户端怎么知道字符串在哪里结束？Broker 如何知道是否合法？

这些答案都在**固定头**（Fixed Header）里。MQTT 所有报文共享同一个头结构「类型 + 标志位 + 剩余长度」，后面的载荷部分根据报文类型来设置。本文将沿着 `MQTTPacket.c` 的编解码函数逐个拆解，最后拼出完整的 CONNECT 报文。这里先给出结论：

- **第一个字节**：高 4 位是报文类型，低 4 位是标志位。CONNECT 报文类型是 1，左移 4 位就是 `0x10`。低 4 位只有在 PUBLISH 里才有含义（DUP/QoS/RETAIN），其它报文类型的标志位是保留位，3.1.1+ 收到非零值算协议错误。
- **剩余长度**：可变长编码，每个字节 7 位有效数据 + 最高位表示后面是否还有数据，最多 4 字节可以表示 256MB 长度。`MQTTPacket_encode` 中实现了剩余长度的编码逻辑。
- **MQTT 字符串**：2 字节大端长度 + UTF-8 字节组成。Paho 用 `MQTTLenString` 结构来保存，源码 `utf-8.c` 负责校验合法性。


## 固定头与剩余长度

### 第一个字节：类型在高 4 位，标志在低 4 位

MQTT 报文的第一个字节是固定头的"身份字节"，8 个 bit 分为两部分：

```
bit 7 6 5 4 │ bit 3 2 1 0
     Type   │   Flags
```

高 4 位是报文类型，低 4 位是标志位。内存布局上「类型在高位」，所以类型值要左移 4 位才能得到最终字节，这就是为什么 `CONNECT`（type=1）的字节是 `0x10` 而不是 `0x01`。`PUBLISH` 是 `0x30`（type=3）、`PUBACK` 是 `0x40`（type=4）。代码里的结构长这样：

```c
typedef union
{
	/*unsigned*/ char byte;	/**< the whole byte */
	struct
	{
		bit retain : 1;		/**< retained flag bit */
		unsigned int qos : 2;	/**< QoS value, 0, 1 or 2 */
		bit dup : 1;			/**< DUP flag bit */
		unsigned int type : 4;	/**< message type nibble */
	} bits;
} Header;
```

`Header` 在 `MQTTPacket.h` 里只是一个字节，语义上再拆成 `type`/`flags` 两个 4 位。

其中标志位只有在 PUBLISH 里才有实际含义，`bit3` 是 DUP（重发标记），`bit2-1` 是 QoS 级别（0/1/2），`bit0` 是 RETAIN。其它 14 种报文的标志位都是协议保留位：

- MQTT 3.1/3.1.1 要求它们必须为 0，收到非零值视为协议错误
- MQTT 5.0 对几个报文（CONNACK 的 session present、SUBACK 等）放宽了部分位，但总体上「非 PUBLISH 的 flags 默认全 0」仍成立

抓包时看第一个字节的低 4 位，可以判断是不是 PUBLISH、以及 QoS 是多少：`0x32` = PUBLISH + QoS 1（`0x30 | 0x02`），`0x3A` = PUBLISH + QoS 1 + DUP（`0x30 | 0x08 | 0x02`）。


### 剩余长度：1 到 4 字节的可变长编码

第一个字节之后是剩余长度（Remaining Length）：固定头之后还剩多少字节。它不用固定 4 字节，而是 1-4 字节的可变长编码：

- 每个字节用 7 位存数据，最高位（`0x80`）表示「后面还有字节」
- 1 字节最多 127，2 字节最多 16383，3 字节最多 2097151，4 字节最多 268435455（256 MB）
- 超过 4 字节就是非法报文

剩余长度通过 `MQTTPacket_encode` 计算：

```c
// paho.mqtt.c/src/MQTTPacket.c:302-317
int MQTTPacket_encode(char* buf, size_t length)
{
    int rc = 0;
    do
    {
        char d = length % 128;      // 取低 7 位
        length /= 128;              // 剩下的右移"128 进制"一位
        if (length > 0)
            d |= 0x80;              // 还有后续字节 → 置最高位
        if (buf)
            buf[rc++] = d;          // 输出一个字节
        else
            rc++;
    } while (length > 0);
    return rc;
}
```

通过几个例子来理解编码格式：

| 长度 | 字节序列 | 说明 |
|---|---|---|
| 0 | `0x00` | 无载荷（如 PINGREQ） |
| 127 | `0x7F` | 1 字节上限 |
| 128 | `0x80 0x01` | `128 % 128 = 0`，最高位置 1；`128 / 128 = 1` 进下一字节 |
| 16383 | `0xFF 0x7F` | 2 字节上限 |
| 268435455 | `0xFF 0xFF 0xFF 0x7F` | 4 字节上限 |

Paho 实现解码按照从字节流中每次读取一个字节来解析，如果最高位是 1 就继续向后读，否则就停止解析，如果超过了 4 字节报错非法报文。

```c
// paho.mqtt.c/src/MQTTPacket.c:1081-1099
int MQTTPacket_VBIdecode(int (*getcharfn)(char*, int), unsigned int* value)
{
    char c;
    int multiplier = 1;
    int len = 0;
#define MAX_NO_OF_REMAINING_LENGTH_BYTES 4

    *value = 0;
    do
    {
        if (++len > MAX_NO_OF_REMAINING_LENGTH_BYTES)
            return MQTTPACKET_READ_ERROR;   // 超过 4 字节非法数据
        (*getcharfn)(&c, 1);
        *value += (c & 127) * multiplier;   // 当前 7 位，乘上 128 的幂
        multiplier *= 128;
    } while ((c & 128) != 0);               // 最高位为 1 就继续读
    return len;
}
```

Paho 提供了两个解码函数：`MQTTPacket_decode`（`MQTTPacket.c:330`）从 socket 直接读，`MQTTPacket_decodeBuf`（`MQTTPacket.c:1121`）从内存 buffer 读。

`MQTTPacket_decode` 用于 `MQTTPacket_Factory` 收包，边读边解码：先读一个字节判断剩余长度占几字节，再读够整包。`MQTTPacket_decodeBuf` 用于报文已经在内存里的场景，比如 WebSocket 或代理隧道转发。


`MQTTPacket_decode` 的关键在于「先知道长度才能把整包读出来」：它按需逐字节读，等最高位为 0 才确定剩余长度占了几字节，然后 `read()` 凑齐payload。

{{< notice tip >}}
剩余长度编码有个「0 陷阱」：`0x80 0x00` 这种多余的前导零字节虽然按照存储算法上等于 0，但按规范是非法的，编码必须用最短形式。Paho 的解码循环遇到 `0x80` 会继续读下一个字节，读到 0 结束，算出长度 128×0+0=0。不会崩溃或异常，但严格校验的 Broker 会拒绝这类报文。自己构造报文时也别这么写。
{{< /notice >}}


## 字符串：2 字节长度 + UTF-8

### MQTT 字符串的字节格式

MQTT 里的字符串（topic、clientID、username、password 等）不是 C 字符串那样「以 \0 结尾」，而是一个固定格式：

```
0-1 字节：长度（大端，2 字节，单位是字节数）
2~  字节：UTF-8 编码的内容
```

以 `async_publish` 示例中发布的 topic `hello` 为例，在报文里是 `00 05 68 65 6c 6c 6f`（长度 5 + 5 个ASCII 字节）。注意长度使用大端（高字节在前）存储。

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260813215348904.png)

长度只占 2 字节，所以 MQTT 字符串最长 65535 字节，这是协议规定的上限，超出的 topic/clientID 在编码时就会被截断。


### MQTTLenString：长度 + 指针

内存中用 `MQTTLenString` 表示字符串，定义在 `MQTTProperties.h` 中：

```c
// paho.mqtt.c/src/MQTTProperties.h:88-93
typedef struct
{
    int len;      /**< the length of the string */
    char* data;   /**< pointer to the string data */
} MQTTLenString;
```

字段是 `len` + 指针 `data`，不是 `char[n]` 数组。好处是零拷贝：收包时 `data` 直接指向接收缓冲里字符串的起始位置，`len` 标记边界，不需要为每个字符串做 `malloc` + 拷贝。代价是不保证以 `\0` 结尾，用 `strlen`、`printf %s` 当 C 字符串处理可能越界读。

编码方向，把 `{len, data}` 落成报文字节：

```c
// paho.mqtt.c/src/MQTTPacket.c:1023-1027
void writeMQTTLenString(char** pptr, MQTTLenString lenstring)
{
    writeInt(pptr, lenstring.len);   // 2 字节大端长度
    memcpy(*pptr, lenstring.data, lenstring.len);  // 内容紧跟着
    *pptr += lenstring.len;
}
```

解码方向，`MQTTLenStringRead` 先确认缓冲里还剩足够字节，读完长度后再用「字符串终点 ≤ 缓冲终点」兜底，防止报文被截断时越界：

```c
// paho.mqtt.c/src/MQTTPacket.c:1031-1049
int MQTTLenStringRead(MQTTLenString* lenstring, char** pptr, char* enddata)
{
    int len = -1;
    if (enddata - (*pptr) > 1)   // 够读 2 字节长度？
    {
        lenstring->len = readInt(pptr);          // 读长度，pptr 偏移 2 字节
        if (&(*pptr)[lenstring->len] <= enddata) // 内容没超出缓冲？
        {
            lenstring->data = (char*)*pptr;      // 零拷贝：直接指过去
            *pptr += lenstring->len;
            len = 2 + lenstring->len;
        }
    }
    return len;
}
```

注意 `enddata` 贯穿整个 Packet 层的解码，所有变长字段都是通过「指针推进 + 终点不越界」的方式读写，读源码看到 `enddata` 就知道是防截断用的。

{{< notice tip >}}
零拷贝指针直接指向内存固然快，但是 C 程序中的内存泄露、野指针和内存重复释放也是令人头疼的问题。我们在使用这种方式编程时，一定要有一套统一的内存释放规则，避免多处释放或者忘记释放内存。
{{< /notice >}}

### UTF-8 校验：为什么必须有这一层

报文里写「UTF-8」不只是声明，3.1.1+ 规范要求收发双方校验：topic 等**字符串必须是合法 UTF-8**，且不能包含 U+0000（NUL）、代理区 U+D800~U+DFFF、以及超过 U+10FFFF 的编码。这些字符会破坏订阅匹配和显示，所以协议直接禁止。

Paho 在 `utf-8.c` 中校验，实现「逐字符判定字节数 + 查合法范围表」：

```c
// paho.mqtt.c/src/utf-8.c:76-119（节选）
static const char* UTF8_char_validate(int len, const char* data)
{
    int charlen = 2;
    /* 先定这个字符占几个字节 */
    if ((data[0] & 128) == 0)      charlen = 1;   // 0xxxxxxx → 1 字节
    else if ((data[0] & 0xF0) == 0xF0) charlen = 4;  // 11110xxx → 4 字节
    else if ((data[0] & 0xE0) == 0xE0) charlen = 3;  // 1110xxxx → 3 字节
                                                   // 其余 110xxxxx → 2 字节

    if (charlen > len) goto exit;  // 声称的字节数超过了实际长度
    /* 用合法范围表逐字节核对，比如代理区、超范围编码都会被拒 */
    for (i = 0; i < ARRAY_SIZE(valid_ranges); ++i) { /*...*/ }
}
```

`UTF8_validateString` 在创建客户端、连接、订阅、取消订阅、发布这 5 个流程的入口校验 clientId、username、password、topic 的 UTF-8 编码合法性，校验失败认为报文非法，返回错误。


## 亲手拼出一个 CONNECT

我们把前面的内容串起来，拼一个最简单的 MQTT 3.1.1 CONNECT 报文：`clientID = "paho_test"`、`keepalive = 60`、`clean session = true`，无 will、无用户名密码。

**第一步：算载荷**。 3.1.1 的 CONNECT 载荷只有一项 clientID：

```
载荷 = UTF-8 字符串 "paho_test" = 2 字节长度 + 9 字节内容 = 11 字节
```

**第二步：算可变头**。 3.1.1 的 CONNECT 可变头四段：

```
协议名 "MQTT"       → 00 04 'M' 'Q' 'T' 'T'          （2+4 = 6 字节）
协议级别 4          → 04                             （1 字节）
Connect Flags      → 02      （bit1 clean session） （1 字节）
Keep Alive = 60    → 00 3C                          （2 字节）
```

可变头共 `6+1+1+2 = 10` 字节，载荷 11 字节，所以**剩余长度** = 21 = `0x15`（小于 127，1 字节就够）。

**第三步：拼固定头**。 第一字节 `0x10`（type=1 左移 4 位，flags 全 0），第二字节剩余长度 `0x15`。

完整的 23 字节报文：

```
10 15 00 04 4D 51 54 54 04 02 00 3C 00 09 70 61 68 6F 5F 74 65 73 74
│  │   └──────┬──────┘  │  │  │  │  └──────┬──────┘  └──────┬──────┘
└  └     协议名 "MQTT"   │  │  │  keepalive │        clientID "paho_test"（9 字节）
固定头                   └级─└flags          └功能全在低 4 位、字符串全在
(1+1字节)                                     "2 字节长度 + UTF-8" 里
```

通过 `nc` 命令向 Broker 发送报文来验证：

```bash
# 中间字节省略自行填充
printf '\x10\x15\...' | nc 127.0.0.1 1883
```

报文成功发送并收到 Broker 的 CONNACK 连接成功的报文。

![](https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260813233632349.png)

MQTT 5.0 的 CONNECT 在可变头里多了一段 properties（keepalive 之后、载荷之前）。


## 总结

回看开头的三个结论：

1. 第一字节 = `类型 << 4 | flags`，所以 CONNECT 是 `0x10`；低 4 位只有 PUBLISH 有含义；
2. 剩余长度是 128 进制的可变长编码，1 到 4 字节、上限 256MB，编解码函数 `MQTTPacket_encode` / `MQTTPacket_VBIdecode`；
3. 字符串 = 2 字节大端长度 + UTF-8，`MQTTLenString` 用「长度 + 指针」零拷贝承载，utf-8.c 负责 3.1.1+ 的合法性校验。

现在你能看懂任意 MQTT 报文的第一个字节和长度字段了。下一篇「第一次握手：CONNECT/CONNACK 与版本协商」将拼好的 CONNECT 报文发出去，追踪从 C++ 的 `connect()` 到 Broker 回 CONNACK 的完整链路：参数校验、CONNECT 报文构造、TCP 发送、以及客户端与 Broker 之间的版本协商逻辑。


