# antigravity-bus

[English](README.md) | 简体中文

[![CI](https://github.com/karzanOnline/antigravity-bus/actions/workflows/ci.yml/badge.svg)](https://github.com/karzanOnline/antigravity-bus/actions/workflows/ci.yml)

`antigravity-bus` 是一个专为 Antigravity 打造的本地优先可观测性总线。

它为一种极其特定但日益常见的工作流而生：当一个 Agent 将代码实现工作委托给 Antigravity 后，需要一种可靠的方式来观察运行状态、收集产物，并通过审查或编排逻辑来实现工作流闭环。

本项目并非官方的 Antigravity 集成。它是一个独立的开发者工具，可将本地的 Antigravity 状态转化为机器可读的快照数据。

## 项目状态

- 当前阶段：早期 MVP
- 支持的操作系统：macOS
- 运行环境要求：Node.js 20+
- 集成方式：本地进程检测、扩展服务器观察，以及本地主进程的聊天派发

当前的 MVP 版本专注于一个核心承诺：如果 Antigravity 正在你的机器上运行，`antigravity-bus` 就应该能帮你发现它，检测它的本地痕迹，并持久化一个下游工具可以消费的稳定快照。

## 为什么需要它

启动一个 Agent 很容易。监控它却很难。

如果你需要一个真正的委托闭环，你需要回答如下问题：

- Antigravity 当前是否正在运行？
- 它是关联到哪一个工作区的？
- 它是否在本地生成了新的文件产物？
- 自从上一次轮询之后，本地状态是否发生了变化？
- 别的独立进程在不读取屏幕（screen-scraping）的前提下能否拿到这些状态？

`antigravity-bus` 首推并专注解决的就是这层可观测性的问题。

## 功能特性

- 从宿主机发现本地的 Antigravity 语言服务器进程
- 提取如 `pid`、`workspace_id`、`extension_server_port` 以及防 CSRF 标识等运行时参数
- 从 `~/Library/Application Support/Antigravity` 下的 SQLite 库读取 Antigravity 本地状态
- 解析产物（artifact）和管理器状态二进制对象（blobs），生成具有防守边界的、友好的代码审查摘要
- 输出针对单个目标工作区的快照 JSON
- 利用 Antigravity 内部的 CSRF 同源防御接口侦测本地的扩展服务器
- 订阅状态聚合主题（如活动级联 active cascades、轨迹摘要 trajectory summaries）
- 标准化产生轻量级监管状态（如 `idle`，`running`，`waiting` 或 `done`）
- 评估基于特定工作区的验收检查，帮助监控循环及早阻断未完工交付
- 将只增不减的变更事件(append-only change events)写入日志，供下游 review 循环或主管进程消费
- 使用官方 CLI 的同款 `launch.start(...)` 入口点，通过 Antigravity 的 `*-main.sock` 发送聊天提示（Prompts）

## 非目标方向

在这个阶段，`antigravity-bus` **不会** 尝试做以下事情：

- 替代 Antigravity UI
- 伪装成一个全功能的远程控制层
- 保证无损解码每一种内部状态内容
- 把本地状态上传到云端后端
- 在 macOS 数据模型稳定之前尝试支持 Linux 或 Windows

保持狭窄的开发范围是有意为之。该项目必须要首当其冲地在底层作为可观测性原语足够可靠，然后才会向上层发展成为更丰富的监管（supervisor）能力。

## 架构

该 CLI 目前由五个本地数据源共同组装快照：

1. 运行中进程的系统线索记录
2. Antigravity SQLite 状态数据库
3. 本地构建的文件产物 (Local artifact files)
4. 近期产生的语言服务器日志
5. 扩展服务器（Extension-server）的各类主题数据订阅

上面这所有的信息将被平铺合并为一个具有如下顶层结构字段快照：

- `generatedAt`
- `cwd`
- `activeWorkspaceId`
- `antigravity`
- `workspaceInstance`
- `extensionServer`
- `supervisor`
- `userStatusAvailable`
- `authStatusAvailable`
- `recentLogSignals`
- `tasks`

快照刻意将追踪信息分为以下类型以作区分：

- 具体的运行时状态 -> 位于 `supervisor.state`
- 审查交付时闭环状况 -> 位于 `supervisor.acceptance.state`

产生在尚未完全完工的环境下会有意想不到的情况，区分状态的颗粒度尤其关键。例如：可能 agent 还在 `running`，但因为缺少关键依赖后置项，产生的代码（比如只有前端更新而缺乏实际后端接口调用）已被闭环确认体系直接捕获验证未过而判定其 `failed`。

针对更详细复杂的架构内部模型分解拆分剖释，建议参阅说明文档：[docs/architecture.md](./docs/architecture.md)。

## 环境要求

- 宿主系统必须是 macOS 并且使用在本地成功安装至少运行过一次的原版 Antigravity 环境
- 你的环境装有 Node.js 20 或者更新一点的大版本
- `PATH` 中内置或者提供了正常可执行的 `sqlite3`

如果验证上述提到的条件你可以用：

```bash
sqlite3 --version
```

## 安装

### 通过源码拉取使用

```bash
git clone https://github.com/karzanOnline/antigravity-bus.git
cd antigravity-bus
```

现在早期的核心原型库里，是没有任何额外依赖进行组建调用的，可以直接执行。

### 作为 CLI 命令行级安装项（即开即用的全局包）

等随后发布到正式版的 npm，您可以直接全局注册运行，或直接挂着 `npx` 使用：

```bash
npm install -g antigravity-bus
antigravity-bus --help
```

```bash
npx antigravity-bus --help
```

## 快速上手

### 被动捕获查找存活的 Antigravity 实例情况

```bash
antigravity-bus discover
```

### 给针对具体的唯一工作空间获取全部环境特征快照

```bash
antigravity-bus snapshot --cwd /absolute/path/to/workspace
```

### 以轮询机制监听数据追踪变更事件日志和保存落盘动作

```bash
antigravity-bus watch \
  --cwd /absolute/path/to/workspace \
  --interval 4000 \
  --out-dir /absolute/path/to/output
```

### 尝试从受控端对主程序向内部提交并发送触发级对话的机制指令

```bash
antigravity-bus dispatch \
  --cwd /absolute/path/to/workspace \
  --prompt "做到哪里" \
  --wait-for-completion \
  --auto-remediate \
  --wait-ms 5000
```

你依然可以直接依靠 npm 配置的脚本来拉起启动方法:

```bash
npm run discover
npm run snapshot -- --cwd /absolute/path/to/workspace
npm run watch -- --cwd /absolute/path/to/workspace
npm run dispatch -- --cwd /absolute/path/to/workspace --prompt "做到哪里" --wait-for-completion --auto-remediate
```

如果不愿意在你的系统中配置全局命令，直接使用原生 `node ./src/index.mjs` 去映射使用就好。

## CLI 终端调用接口说明

### `discover`

在机器中罗列检索本地全部可发现探测状态下的 Antigravity Language Server 相关后台守护进程活动清单内容记录。

用法示例：

```bash
node ./src/index.mjs discover
```

提供包含有一连串数组返回 `instances` 的 JSON 回馈数据结构展现。

### `snapshot`

汇集成型生成针对某单个作用目标范围下的相关参数组合，它将包含了诸如后台进程侦察、本地文件配置与活动代码状态及对应的主日志还有与内部拓展级连接交互接口的详细记录统归汇为单一系统状态展示快照资料结果。

传参：

- `--cwd <path>`: 用户归一化处理指定的绝对或相对路径以此匹配对应的应用对象配置路径工作台。

用法示例：

```bash
node ./src/index.mjs snapshot --cwd /Users/example/project
```

### `watch`

长周期的建立在时间片上的刷新追踪程序指令集任务快照及各类受监管变量日志数据信息的更新变化并留档。

参数设定：

- `--cwd <path>`: 重点监视的目标工作环境物理地址映射
- `--interval <ms>`: 多久时间段（以毫秒级计单位）做下一次采样频率探测，默认为 `4000`
- `--out-dir <path>`: 数据沉淀存储落地的指定输出接收口路径会更新在里面的 `latest.json` 用来覆盖实时同步和保存只做累添加更新机制记录在案的 `events.jsonl` 中。

用法示例：

```bash
node ./src/index.mjs watch \
  --cwd /Users/example/project \
  --interval 4000 \
  --out-dir /tmp/antigravity-bus
```

### `dispatch`

将指令通过发送寄件推送到预留配对挂上的系统伴生拓展代理桥接渠道排队缓冲期等待。基于此直接由它借助于当前存在的原生态主系统框架代办发文且带回具体的反馈证明已成为官方指定的推荐使用路径方法机制。

设定项：

- `--cwd <path>`: 选用的目标工作目录
- `--prompt <text>`: 回送要求到对应环境的具体提示请求沟通字段信息
- `--mode <mode>`: 当前对话频道属性或种类标签状态类型定义，常置为默认 `agent`
- `--add-file <path>`: 给发送动作任务补充带上传递额外指文件信息的材料地址
- `--wait-ms <ms>`: 系统会阻塞进程直至达到指定的时长从而用来去确认该命令是否有接包响应该时间期限段落
- `--bridge-dir <path>`: 自定义并替换内部原设系统自带监控排件收揽存储目录项，如不覆盖原缺省是走默认处于资源管理器支持目录下专属应用 `~/Library/Application Support/Antigravity/antigravity-bus-bridge`
- `--wait-for-completion`: 发出该状态码会不断反复保持对后台系统闭环进展信息的轮流监听，来明确最后真实的落实判定反馈结项宣告
- `--completion-timeout-ms <ms>`: 到达预估的最顶级阻断容忍界线就直接报限放弃终止挂起检测轮次，一般是定限 `120000` (120 秒)
- `--auto-approve`: 加入这个标记当一旦监听到在中间的进程处于卡住状态呈现有要求等待用户配合选择权限开启通过选项即会激活调用自适应处置对答方案模块强行解除，例如常见的诸如针对变更源码操作要求等命令级别放行选项进行拦截回覆提交。比如去激活包含命令 `antigravity.acceptAgentStep` 或执行类似 `notification.acceptPrimaryAction` 进行确应过检
- `--approval-timeout-ms <ms>`: 应对尝试执行解锁授权处理等待系统消解响应时的留出的宽限余地，默认 `30000` (30 秒)
- `--auto-remediate`: 结合上面等闭环流程倘遭查出结果为返回完成状况并标识属于包含失效成分并定义判定为结果 `failed` 时产生出相应的回退处理修复逻辑并将系统自身指明原因的修正指示作为问题点提交回程序自身去重启下一周期的运作处理修缮步骤工作流处理事务机制请求提交动作。
- `--max-remediations <n>`: 这个次数被定名为为了解决因上步骤引发失败状况进而限制能自主开展进行无尽闭环自我救治尝试抢修机制次数上限设置值处理阈度，默认为 `1` 次以阻止宕机内耗死循环
- `--supervisor-loop-timeout-ms <ms>`: 为在多轮次下执行自洽循环重整修护提供保障系统不受极端长距离运行锁止死角卡住定下最严安全保命限定退出强制阻绝值防爆防沉迷设定默认为等价执行在 `300000` (300 秒)的时间周期范围后必定跳出

用法示例：

```bash
node ./src/index.mjs dispatch \
  --cwd /Users/example/project \
  --prompt "做到哪里" \
  --wait-for-completion \
  --auto-approve \
  --auto-remediate \
  --wait-ms 5000
```

### `ipc-dispatch`

依靠旧版原先走传统 socket 并发出 `launch.start(...)` 命令进行传输交流接口。建议仅作为技术留底研究或特殊功能场景补缺测试验证而备存。目前原因已定因它不能完美达到提供可靠无损稳定传递保障及无法给操作赋予确认收到信息记录状态回复响应处理。

入参限定：

- `--cwd <path>`: 所涉及的相关业务空间目标目录配置信息项
- `--prompt <text>`: 指引命令词文传递的特定字符信息
- `--mode <mode>`: 当前的工作模式，默认 `agent`
- `--profile <name>`: 自定义的 Antigravity 文件描述档案 Profile
- `--add-file <path>`: 选带跟从一起传入附加配置文档列表信息
- `--wait-ms <ms>`: 下发任务发出后的追踪观察延迟轮次保留监听系统时机点设置参数
- `--wait-for-new-cascade`: 用以约束判断要务必明确探测感知确真包含建立挂钩连体指令行动才算算该投送请求行动算是实着落地建立通信的判定识别关卡限制。

用法示例：

```bash
node ./src/index.mjs ipc-dispatch \
  --cwd /Users/example/project \
  --prompt "Continue the task" \
  --wait-for-new-cascade \
  --wait-ms 5000
```

## 随附的桥接扩展 (Companion Bridge Extension)

`antigravity-bus` 目前也一并附带分发了一个体积很小的系统扩展，路径在 [bridge-extension/package.json](/Users/caozheng/cowork-flie/antigravity-bus/bridge-extension/package.json)。该桥接扩展专门用于轮询并侦听本地收件箱（inbox），在宿主空间上代填类似 `antigravity.sendPromptToAgentPanel` 级别的 Runtime 指令，并在处理完毕记录后回馈包含具体细节内容的寄出包裹（outbox）供监听使用。

Bridge 的目录结构如下：

- `~/Library/Application Support/Antigravity/antigravity-bus-bridge/workers/<workerId>/inbox`
- `~/Library/Application Support/Antigravity/antigravity-bus-bridge/workers/<workerId>/outbox`
- `~/Library/Application Support/Antigravity/antigravity-bus-bridge/workers/<workerId>/status.json`

为了兼容旧的观察方式，扩展还会把最近一个 worker 的状态镜像到：

- `~/Library/Application Support/Antigravity/antigravity-bus-bridge/status.json`

打包生成该扩展安装包：

```bash
npm run bridge:pack
```

在系统项目的根目录里就会产生一份叫 `antigravity-bus-bridge.vsix` 的扩展资源文件，然后手动安装进你的 Antigravity 中即可：

```bash
antigravity --install-extension /absolute/path/to/antigravity-bus-bridge.vsix
```

一旦就绪，在接下来和 Agent 打交道时，你可以：

```bash
npm run dispatch -- --cwd /absolute/path/to/workspace --prompt "Continue the task"
```

## 输出数据模型 (Output Model)

使用 `snapshot` 指令生成的返回信息其样式大致如下所示：

```json
{
  "generatedAt": "2026-04-08T13:17:41.726Z",
  "cwd": "/absolute/workspace",
  "activeWorkspaceId": "file_absolute_workspace",
  "antigravity": {
    "appSupportDir": "/Users/example/Library/Application Support/Antigravity",
    "stateDbPath": "/Users/example/Library/Application Support/Antigravity/User/globalStorage/state.vscdb",
    "running": true,
    "instances": []
  },
  "workspaceInstance": null,
  "extensionServer": {
    "available": false,
    "healthy": false,
    "state": "idle",
    "activeCascadeIds": [],
    "topicSignals": []
  },
  "supervisor": {
    "state": "idle",
    "activeCascadeIds": [],
    "healthy": false,
    "acceptance": {
      "state": "unknown",
      "taskOutputDetected": false,
      "checks": [],
      "failedChecks": []
    }
  },
  "userStatusAvailable": true,
  "authStatusAvailable": true,
  "recentLogSignals": [],
  "tasks": []
}
```

利用 `watch` 命令记录所得到的文件：

- `latest.json`
- `events.jsonl`

每次周期性地抓探后 `latest.json` 将遭到全量的数据层覆写更新替代掉。 `events.jsonl` 只有在被标定的归一结果有不同状态转换时才会将新纪录追加到文件的末尾。

各单一变化纪录当中通常含括附着一份指明针对审查结果是否完备闭合信息的标识标签属性配置叫做 `acceptanceState` 这个指示参数能够使下一阶段系统对应执行判定不再单凭依靠重新遍历庞大的 `snapshot` 快照进行。

当捕获存在有 `acceptance.state` 标识为 `failed` 这个错误未闭合情况结果后，快照数据本身便保存了能构建更明确且具强制力恢复指令 (remediation prompt) 的充分信息，指示重新执行修补请求：

- 发现有错误产生从而在竣工验收判定终止阶段识别报错
- 将产生的具体缺失细节反馈给处理的 Agent
- 要求明确补上缺漏的后端接口或者触发相应的重绘动作
- 随后监管轮询将着眼判断下步 `acceptance.state` 能否摆脱 `failed`

当使用比如具有阻塞式长轮询等待参数 `--wait-for-completion` 时，如果进程遇阻进入被称为 `waiting` 的状态然后被停止，那么在这个终止回调反馈的数据里面就会更精确集成的附带含有精缩记录 `topicSignals` 与对应的审核凭证队列详情信息 `approvals`，方便发起端第一时间知晓系统处于什么样导致的终止场景情况来判定接下来：

- 是否是没有任何阻碍全平滑跑完全部节点的完美执行终结
- 是否是仅产生对话记录且未对工作区进行任何实质性文件修改的纯问答闭环 (`completed_chat_only`)
- 是否是失败的确认并且应当触发修复逻辑
- 或者遇到审批放行机制并已经全部交由内设机器人判定或仍需要人工干预判定导致被硬性阻死从而叫停进程

样例请前往参考 [examples/sample-snapshot.json](./examples/sample-snapshot.json)。

## 数据来源

处于初建期 MVP 阶段，主要的数据提取基于物理映射抓取所得：

- 借助本地级的 `ps` 系统查询
- 从 `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb` 底部分析提取。
- 已存入文件产物的参考和追踪代码。
- 原生在一段时间内的语言服务后端系统日志抓取体系。
- 被设定绑定服务扩展对具体工作区发送主题端口的数据侦听快照捕获。

这样完全依靠不需要向外发送与联网分析而是彻底独立进行提取分析并且基于本地应用第一系统的做法是为了让它更加受控且易追溯并以此保障在不稳定期的底座安全过度。

## 隐私和安全保护 (Privacy And Safety)

`antigravity-bus` 所读取获取的应用操作信息层面上不可避免地会有记录展现如下隐私细节层：

- 底层绝对路径资源映射
- 工作台特定的 Workspace IDs
- 产品部署或者产物的具体文件构造命名
- 代码部分内容片断或者带有执行上下文参数
- 特权及带有令牌相关和权限检查特征信息表现资料属性说明。

程序自身工具完全不对它们向服务器端进行自动上报传输以及对外部互联网连接进行云扩散，但作为获取汇总加工呈现提纯浓缩的数据结构成果产品——Snapshots 会赤裸地暴露出核心敏感细节。所以在你要展示公开托管或者任何其他对外分享等协作者共享操作之前，必须谨记妥善审查审问并确认其是否具备外发条件以屏蔽关键信息的暴露操作。

务必在使用该套组件之前查证此项说明文档： [SECURITY.md](./SECURITY.md) 。

## 测试体系

该代码工程框架包含了简单的基础 Node.js 原生的支持核心功能的单元测试检查来防止退行和破坏性退步：

- 参数的识别检查
- 进程信息抽取处理器的安全转化和重组
- 数据结构输出打印内容分离测试
- 配置执行产生效果及档案落盘效应检测保存结果判断
- 获取并记录的各种动作和任务写入操作写入事件检测等

利用以下命令就可调用：

```bash
npm test
```

以上的这些执行设计的初衷是为了使它们可以不受到必须绑定实体或特定的 Antigravity 原生正在工作的配置所带来的环境阻断烦恼，保证可以在无论是持续构建配置 CI 系统或其他任何人本地独立的参与开发等各种状况均可以独立安全没有麻烦干扰地被启动测试通过。

## 参与开发

此项目是极其轻量以及精简掉非必须包引用的特殊存在。

基本的工作命令：

```bash
npm test
node ./src/index.mjs discover
node ./src/index.mjs snapshot --cwd /absolute/path/to/workspace
```

贡献与约定参与规范存在于 [CONTRIBUTING.md](./CONTRIBUTING.md) 之中能够发掘出有关详情和规范要求参考指南。

常规项目的部署释出校验法则参考指南在这里： [docs/release-checklist.md](./docs/release-checklist.md) 。

如何将资源正式对公众正式公开服务，发布相关的指引及 npm 发行等指引在如下文档包含： [docs/npm-publish.md](./docs/npm-publish.md) 。

## 发展线路 (Roadmap)

- 加入更功能完备的对象提取和状态获取解析支持，用于轨迹分析与产品构件解析提取
- 当系统经理态势等不足以涵盖关联所有追踪归属和具体判定分析等功能时的能力识别增强支持与增强
- 引入使用内部 Connect-RPC 作为通信信息流通道，当现有的本地层基本跑通趋于十分稳定无误的时候
- 有条件和时间允许的情况下考虑在之上搭建更丰富更高维的 supervisor 业务高级别应用封装操作接口（API）
- 若时间和系统精力允许则为其适配相应的 Linux 或者针对 Windows 添加相应的适配环境接口

## 开源协议

MIT License。具体参看 [LICENSE](./LICENSE) 。
