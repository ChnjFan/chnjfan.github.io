+++
title = "ROS - 机器人操作系统概述"
description = ""
date = "2026-07-13"
aliases = ["ROS"]
author = "ChnjFan"
tags = [
    "ROS",
]
+++

ROS 是一个开源的机器人操作系统，为构建、部署、运行和维护机器人应用提供框架、工具和库。

ROS 并非传统意义上的操作系统，而是一套工具和库，可帮助开发者借助多种平台和编程语言开发机器人。它的框架更像是实现机器人不同部件之间通信的“底层架构”，包含消息传递、标准接口，还支持多种编程语言和平台。

## 安装 ROS 和 turtlesim

### 环境设置

安装教程以 Ubuntu 为例，首先设置系统区域并更新软件源。

```bash
locale  # check for UTF-8
sudo apt update && sudo apt install locales
sudo locale-gen en_US en_US.UTF-8
sudo update-locale LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
export LANG=en_US.UTF-8
locale  # verify settings

sudo apt install software-properties-common
sudo add-apt-repository universe

# 为各类 ROS 仓库提供密钥和 apt 源配置
sudo apt update && sudo apt install curl -y
export ROS_APT_SOURCE_VERSION=$(curl -s https://api.github.com/repos/ros-infrastructure/ros-apt-source/releases/latest | grep -F "tag_name" | awk -F'"' '{print $4}')
curl -L -o /tmp/ros2-apt-source.deb "https://github.com/ros-infrastructure/ros-apt-source/releases/download/${ROS_APT_SOURCE_VERSION}/ros2-apt-source_${ROS_APT_SOURCE_VERSION}.$(. /etc/os-release && echo ${UBUNTU_CODENAME:-${VERSION_CODENAME}})_all.deb"
sudo dpkg -i /tmp/ros2-apt-source.deb
```

### 安装 ROS

安装开发工具包

```bash
sudo apt update && sudo apt install ros-dev-tools
```

新手推荐安装桌面版，在 base 包的基础上增加了 demo 等教程。

```bash
sudo apt install ros-rolling-desktop
# 激活环境
source /opt/ros/rolling/setup.bash
# 测试 demo 运行一个发布者
ros2 run demo_nodes_cpp talker
# 在另外一个终端运行监听器
ros2 run demo_nodes_py listener
```

### Turtlesim - ROS 模拟器

Turtlesim 是一款用于学习 ROS 2 的轻量级模拟器。它以最基础的形式展示了 ROS 2 的功能，让你了解后续在实际机器人或机器人仿真中会进行的操作。

```bash
sudo apt install ros-rolling-turtlesim
# 返回 turtlesim 的可执行文件列表
ros2 pkg executables turtlesim
# 启动
ros2 run turtlesim turtlesim_node
```

在新的终端建立一个新节点来控制原来的节点：

```bash
ros2 run turtlesim turtle_teleop_key
```

### rqt - 图形化管理界面

rqt 是一款适用于 ROS 2 的图形用户界面（GUI）工具。在 rqt 中完成的所有操作都可以在命令行中实现，但 rqt 提供了更易用的方式来操作 ROS 2 组件。

```bash
sudo apt update
sudo apt install ros-rolling-rqt ros-rolling-rqt-common-plugins
# 运行
rqt
```

## 节点 Node

ROS 中的 Node 负责单一的模块化功能，例如控制车轮的电机或发布激光测距仪的传感器数据。每个 Node 可以通过 topic、service、action 或者 action 与其他 Node 收发数据。

<img src="https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260713101537934.gif" alt="20260713101537934.gif" style="zoom:67%;" />

一个完整的机器人系统是有多个协同工作的节点组成。在 ROS2 中，一个可执行文件（C++ 程序、Python 程序等）可以包含一个或多个节点。

通过 `node list` 子命令来查看当前正在运行的节点的名称/

```bash
ros2 run turtlesim turtlesim_node
ros2 node list
```

### 重映射

重映射允许你将节点名称、话题名称、服务名称等默认节点属性重新分配为自定义值。

```bash
ros2 run turtlesim turtlesim_node --ros-args --remap __node:=my_turtle
```

通过重映射来定义节点名称后，使用 `ros2 node info` 就可以查看具体节点的信息。

```bash
ros2 node info <node_name>
```

`ros2 node info` 会返回订阅者、发布者、服务和动作的列表，即与该节点交互的 ROS 图连接。

```bash
fan@fan-ThinkPad-X1-Carbon-7th:~$ ros2 node info /turtlesim
/turtlesim
  Subscribers:
    /parameter_events: rcl_interfaces/msg/ParameterEvent
    /turtle1/cmd_vel: geometry_msgs/msg/Twist
  Publishers:
    /parameter_events: rcl_interfaces/msg/ParameterEvent
    /rosout: rcl_interfaces/msg/Log
    /turtle1/color_sensor: turtlesim_msgs/msg/Color
    /turtle1/pose: turtlesim_msgs/msg/Pose
  Service Servers:
    /clear: std_srvs/srv/Empty
    /kill: turtlesim_msgs/srv/Kill
    /reset: std_srvs/srv/Empty
    /spawn: turtlesim_msgs/srv/Spawn
    /turtle1/set_pen: turtlesim_msgs/srv/SetPen
    /turtle1/teleport_absolute: turtlesim_msgs/srv/TeleportAbsolute
    /turtle1/teleport_relative: turtlesim_msgs/srv/TeleportRelative
    /turtlesim/describe_parameters: rcl_interfaces/srv/DescribeParameters
    /turtlesim/get_parameter_types: rcl_interfaces/srv/GetParameterTypes
    /turtlesim/get_parameters: rcl_interfaces/srv/GetParameters
    /turtlesim/get_type_description: type_description_interfaces/srv/GetTypeDescription
    /turtlesim/list_parameters: rcl_interfaces/srv/ListParameters
    /turtlesim/set_parameters: rcl_interfaces/srv/SetParameters
    /turtlesim/set_parameters_atomically: rcl_interfaces/srv/SetParametersAtomically
  Service Clients:

  Action Servers:
    /turtle1/rotate_absolute: turtlesim_msgs/action/RotateAbsolute
  Action Clients:
```

## 话题 Topic

ROS2 将复杂系统拆分为多个模块化节点，Topic 充当节点之间交换消息的总线。

一个节点可以向任意数量的主题发布数据，同时也可以订阅任意数量的主题。主题是数据在节点之间以及系统不同部分之间传输的主要方式之一。

<img src="https://raw.githubusercontent.com/ChnjFan/img-bed/master/img/20260713103023002.gif" alt="Topic-MultiplePublisherandMultipleSubscriber" style="zoom: 67%;" />

使用 `rqt_graph` 可以看到当前节点中通信的 Topic。

```bash
ros2 run rqt_graph rqt_graph
```

