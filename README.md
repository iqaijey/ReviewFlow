# ReviewFlow

一个 macOS 桌面端的 AI 代码评审工具：放入项目文件夹，解析 Git 改动，用 AI 做多角度 Review，把问题整理成清单，并可在确认后生成补丁修复。

本文分两部分：

- **[第一部分：使用说明](#第一部分使用说明给人看)**：给人看。从安装、配置到日常评审与修复的完整操作。
- **[第二部分：AI Agent 操作手册](#第二部分ai-agent-操作手册给-ai-读)**：给 AI 读。其他 AI Agent（Claude Code、Codex、OpenCode 等）通过 MCP 或本机 HTTP 操作 ReviewFlow 时的接口约定、标准流程和工具索引。Agent 接入后会自行读取，不需要你转交。

---

# 第一部分：使用说明（给人看）

## 安装

- **安装包**：打开 `dmgs/` 里的 DMG，把 ReviewFlow 拖进「应用程序」。构建是 ad-hoc 签名，首次打开如被 Gatekeeper 拦截，请在 Finder 里右键 → 打开。
- **源码运行**：见下文[运行](#运行)。

## 快速上手

1. **配置 AI**：进入「AI 设置」，在「接入方式」里选一种后端（OpenAI 兼容 API、OpenCode、Kimi CLI、Codex CLI），按提示填写，点「测试连接」，通过后点「保存」。各后端的差异见[AI 接入](#ai-接入)。
2. **打开项目**：点「选择项目」选择一个 Git 仓库；也可以在 ⌘K 命令面板里打开最近项目，或用 `npm start -- /path/to/project` 直接打开。
3. **确认改动来源**：在「改动总览」顶部选择要评审的改动：未提交改动（默认）、已暂存、未暂存、仅未跟踪、分支 / ref 对比、指定提交。下面会列出改动文件和 diff，⌘R 重新扫描。
4. **发起评审**：进入「多角度 Review」的「整体分析」，按需选择评审预设、噪声档位、是否「对比上次评审」，确认预计调用次数和费用后点「开始 AI 分析」（⌘Enter）。运行中可点「运行详情」查看进度、暂停、继续或终止。
5. **处理问题清单**：评审结束后，结果下方是问题清单（见下一节）。

## 处理问题清单

每条问题带严重度、类别和文件位置，点位置可跳到「改动总览」对应的代码。每行的按钮：

| 按钮 | 作用 |
| --- | --- |
| 生成修复补丁 | 让 AI 生成补丁并打开预览窗口。只有预检通过（`git apply --check` 能干净应用）才能点「应用」。补丁只写工作区，不暂存、不提交。只支持 API 和 Codex 后端 |
| 查看补丁 | 补丁已生成但还没应用时出现。关掉预览窗口或重启应用后，从这里重新打开；目标文件已变化时会提示重新生成 |
| 重新生成补丁 | 已有未应用补丁时，原来的「生成修复补丁」按钮会变成这个 |
| 撤销补丁 | 补丁已应用时出现，确认后把文件改回去（文件在应用后又被改过则拒绝撤销） |
| 复核此问题 | 让 AI 针对这一条判断是否已修复（已修复 / 仍存在 / 部分修复 / 已过时），并更新状态 |
| 复制修复任务 | 生成一份交接提示词和命令，交给你自己的编码 Agent 去改；OpenCode / Kimi 后端用这个代替补丁 |
| 标记已修复 / 不处理… / 重新打开 | 手动改状态。「不处理」需要选原因（误报、有意为之、别处已处理、其他） |

推荐流程：**生成修复补丁 → 预览 → 应用 → 复核此问题**。复核结论为已修复时会自动标记。

- 多次标记「不处理」的同类问题会归纳成「规则建议」，可以预览后追加到项目的 `.reviewflow.md`，之后的评审会把这条规则交给 AI 参考，减少同类误报。
- 清单右上角的「复制修复任务」可以把勾选的（或全部未关闭的）问题一次交接出去；「清空问题清单」会删除本项目的全部问题和已保存的补丁，评审历史不受影响。

## 其他功能怎么用

- **逐文件分析**：「多角度 Review」切到「逐文件」，对单个文件做分析，结果会缓存。
- **历史与追问**：「多角度 Review」切到「历史」，可以搜索、置顶、重命名、删除评审记录，勾选两条做双栏对比，或者对某条记录继续追问。
- **逐句解析**：在「改动总览」里点改动行、拖动行号或点类名选中代码，点「解析选区」（⌘E）。
- **完整讲解**：「完整讲解」页点「开始完整讲解」，逐块讲解当前改动。
- **需求方案**：「需求方案」页导入 PRD 和设计稿（文件或链接），生成技术方案；打开「评审时参照方案」后，评审会对照方案检查需求符合度。
- **快捷键**：按 `?` 查看全部；⌘K 打开命令面板。

## 让其他 AI Agent 操作 ReviewFlow

其他 AI Agent 可以通过 MCP 或本机 HTTP 操作 ReviewFlow，界面能做的它都能做。

1. 打开「AI 设置 → 外部 Agent 接口」，确认开关已打开、状态显示「运行中」。
2. 点「复制 MCP 配置」，粘贴到你的 Agent 配置里，然后重启 Agent。复制出的是 Claude Code（`.mcp.json`）等通用的 `mcpServers` 格式；OpenCode 和 Codex 的格式不同，按下面的示例改写。
3. 直接用自然语言下指令，例如「用 reviewflow 评审 /path/to/project 的未提交改动，把高严重度问题生成补丁给我看」。

ReviewFlow 没开时，Agent 第一次调用会自动启动它。Agent 的操作会实时反映到界面上（问题清单、历史、方案、设置都会自动刷新）。

Claude Code 等使用 `mcpServers` 格式（`.mcp.json`）：

```json
{
  "mcpServers": {
    "reviewflow": {
      "command": "/Applications/ReviewFlow.app/Contents/MacOS/ReviewFlow",
      "args": ["/Applications/ReviewFlow.app/Contents/Resources/app.asar/main/agentApi/mcpBridge.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

OpenCode（`opencode.json`）：

```json
{
  "mcp": {
    "reviewflow": {
      "type": "local",
      "command": [
        "/Applications/ReviewFlow.app/Contents/MacOS/ReviewFlow",
        "/Applications/ReviewFlow.app/Contents/Resources/app.asar/main/agentApi/mcpBridge.js"
      ],
      "environment": { "ELECTRON_RUN_AS_NODE": "1" },
      "enabled": true
    }
  }
}
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.reviewflow]
command = "/Applications/ReviewFlow.app/Contents/MacOS/ReviewFlow"
args = ["/Applications/ReviewFlow.app/Contents/Resources/app.asar/main/agentApi/mcpBridge.js"]
env = { ELECTRON_RUN_AS_NODE = "1" }
```

**安全须知**

- Agent 拥有和界面相同的全部权限，而且调用时**不会再弹确认**，包括应用补丁、清空清单、读取明文 API Key。只接入你信任的 Agent；不用时在设置里关掉开关。
- 接口只监听 `127.0.0.1`（默认端口 47821，被占用时改用随机端口），每个请求都要带令牌；浏览器网页发来的请求（带 `Origin`）和非本机 `Host` 一律拒绝。
- 端口与令牌保存在 `~/Library/Application Support/auto-review/agent-api.json`（权限 0600）。怀疑令牌泄露时，在设置里点「重新生成令牌」，MCP 接入会自动用新令牌，HTTP 脚本需要换成新令牌。

## 功能详解


### 改动来源

- 未提交改动、已暂存、未暂存、仅未跟踪文件。
- 分支或任意 ref 对比，支持 `A..B` 与 `A...B` 写法（后者以 merge-base 为起点）。
- 指定提交：提交连续时合并为一份净改动；不连续时按提交逐个拼接展示（同一文件可能出现多次），界面会给出对应提示。
- 排除规则：设置里的默认排除列表包含 `package-lock.json`、`yarn.lock`、`pnpm-lock.yaml`、`Podfile.lock`、`Cargo.lock`、`go.sum`、`*.min.js`、`*.map`，可自行修改；项目内还可用 `.reviewflow.md` 追加（见下文）。
- 上限：最多展示 200 个文件，单个新增文件最多读取 500 KB，单个改动块最多 3000 行。超出时「改动总览」会显示提示，列出被省略或被截断的文件。

### 评审

- 多角度维度：改动概述、安全性、结构问题、影响面、逻辑严谨性、臃肿与冗余、可扩展性、可复用性，也可自定义；可存为评审预设（仅保存本机）。
- 噪声档位：安静、均衡、详尽，分别控制低影响问题和风格建议的输出量。
- 多模型评审：选择至少 2 个模型各评审一次，再汇总。
- 改动较大时自动分批；批次结果过多时分层合并，最后做综合。
- 运行中可在「运行详情」里暂停和继续（暂停进度只保存在本次运行中，退出应用后无法继续）；失败时已完成的批次会保留，可「从失败处重试」。
- 可选「对比上次评审」，让结论追加「与上次对比」一节。

### 问题清单

- 每条问题带严重度、类别和文件位置，点击可跳转到「改动总览」对应位置；支持按严重度等条件筛选。
- 再次评审时，AI 会逐条复核遗留问题，结论为：已修复、仍存在、部分修复、已过时。
- 标记「不处理」时可填写原因；对应问题可生成规则建议，预览并确认后才会追加到 `.reviewflow.md`。

### 修复闭环

- 流程：生成补丁，预览，确认后应用到工作区，需要时撤销（同样需要确认），再对单条问题复核。
- 只有 API 后端和只读沙箱的 Codex 后端支持生成补丁和复核。应用前会校验目标文件没有变化，文件变化后需要重新生成。
- 其他后端（OpenCode、Kimi CLI）提供「复制修复任务」，生成一份交接提示词和可自行运行的命令。生成补丁和复核只走 API 或只读沙箱的 Codex，ReviewFlow 不会替你运行可写入的修复 Agent；「复制修复任务」只生成提示词和供你自行运行的命令。另外，OpenCode / Kimi 作为评审后端时由各自 CLI 执行，ReviewFlow 无法为它们强制只读隔离。
- 补丁只写入工作区，从不暂存或提交。

### 历史与追问

- 每次评审的历史带来源信息；支持置顶、重命名、搜索（标题、正文、文件路径、模型）、删除，勾选两条记录可双栏对比。
- 对历史记录继续追问，对话会持久化，回答可重新生成。
- 逐文件分析结果会保存。只有该文件的 diff 和所有影响提示词的设置都没变，且后端配置能被可靠识别（API 后端，以及配置可识别的 Codex）时，才会自动复用；OpenCode / Kimi 的结果只作为「上次结果」保留，不会自动复用。

### 逐句解析

在「改动总览」中点击改动行、拖动行号或点击类名先选择，再点「解析选区」（⌘E），AI 解释所选代码的含义与意图。代码文本可直接框选复制。

### 需求方案

在「需求方案」页导入 PRD 和设计稿，支持文件，也支持粘贴链接导入（PRD 网页链接、设计稿图片直链或网页，网页会整页截图）。打开「评审时参照方案」后，评审会参照当前方案。

### 效率

- 开始前显示预计调用次数与 token；在「AI 设置」配置每百万 token 的输入/输出单价后，可估算费用。
- ⌘K 命令面板：切换页面、开始或停止分析、导出、重新扫描、切换改动来源、打开最近项目。
- 快捷键（按 `?` 查看完整列表）：⌘1 到 ⌘6 切换页面，⌘R 重新扫描，⌘Enter 开始或停止分析，⌘⇧E 导出 Markdown，⌘F 搜索改动，j / k 切换文件，[ / ] 切换改动块，n 跳到下一个未读文件。
- 工作区恢复：重新打开项目时恢复上次的界面状态。

## AI 接入


| 接入方式 | 说明 |
| --- | --- |
| OpenAI 兼容 API | 填写地址和 Key。支持生成补丁与复核 |
| OpenCode | 调用本地 OpenCode |
| Kimi CLI | 调用本地 Kimi CLI |
| Codex CLI | 以 `--sandbox read-only` 运行，prompt 通过 stdin 传入。支持生成补丁与复核 |

OpenCode 和 Kimi CLI 没有强制的只读沙箱，所以修复功能不对它们开放。

## 项目级评审规范（.reviewflow.md）


在被评审项目的根目录放置 `.reviewflow.md`，写入评审规范、编码约定或架构约束，评审会把它作为「项目评审规范」注入提示词。方案生成也会使用这些规则。

- 子目录里也可以放 `.reviewflow.md`，只对该目录下的文件生效。注入时根文件在前，更深层的在后。
- 注入预算：只有根文件对被评审文件生效时为 4000 字；被评审的文件所在父目录里也有 `.reviewflow.md` 时为 8000 字（按每个批次或文件实际生效的规则分别决定）。超出时靠后的深层规则先被截断，并带有截断标记。
- 规则文件中的 ` ```reviewflow-ignore ` 围栏代码块用于追加排除 glob，每行一条，`#` 开头为注释，以 `!` 开头表示重新纳入。这些块只作用于根文件，并会从注入文本中移除。
- 在「改动总览」点「生效规则」可查看当前文件实际生效的规则文件、是否被截断和最终注入文本。
- 规则建议只有在预览并确认后才会追加到文件。

注意：规则文件的内容会作为提示词的一部分发送给你选择的 AI 后端，并不只在本机读取。不要在其中写入密钥或不想外发的内容。

## 数据与隐私


- 评审历史、问题清单、追问对话、缓存和需求方案都保存在应用的 userData 目录，不会上传到 ReviewFlow 的服务器。
- API Key 保存在 userData 下的 `settings.json`，文件权限为 0600，界面中不会完整显示。它没有放进 macOS 钥匙串，原因是 ad-hoc 签名的构建每次更新后都会触发钥匙串访问弹窗。
- 评审时，diff、项目规则和需求方案会发送给你当前选择的 AI 后端（API 服务或本机 CLI 所连接的服务）。

## 运行


```bash
npm install
npm start                    # 或 npm start -- /path/to/project 直接打开项目
```

隔离的手动运行（不碰日常的数据目录）：

```bash
REVIEWFLOW_USER_DATA_DIR=/tmp/reviewflow-dev npm start -- /path/to/project
```

## 打包（macOS arm64）


```bash
npm run pack   # 产物在 dist/，DMG 会归拢到 dmgs/
```

无签名（ad-hoc），首次打开如被 Gatekeeper 拦截请右键 → 打开。

## 开发与测试


```bash
npm run check       # 语法检查
npm run typecheck   # tsc --noEmit，主进程与渲染进程各检查一次
npm test            # 单元测试（node --test tests/unit/）
npm run smoke       # 冒烟测试
```

`npm run smoke` 会启动真实的 Electron，对一个临时 Git 仓库操作，AI 请求全部打到本地 mock 服务，并通过 `REVIEWFLOW_USER_DATA_DIR` 使用隔离的数据目录。它依赖完整的本机 `node_modules`，不适合放进 CI。

## 技术


Electron，无前端框架，主进程 CommonJS + 渲染进程原生 ES Module，零运行时依赖。

---

# 第二部分：AI Agent 操作手册（给 AI 读）

完整手册在 [`main/agentApi/AGENT_GUIDE.md`](main/agentApi/AGENT_GUIDE.md)，随应用一起打包。内容包括连接方式、调用约定、长任务、错误处理、数据模型、标准流程、行为守则和工具索引。

Agent 不需要你手动转交，接入后可以自己读到：

- **MCP**：握手时的说明会要求 Agent 首次使用前先调用 `agent_guide`。这个工具返回手册全文，末尾附当前版本全部工具的索引。读手册不需要 ReviewFlow 在运行，也不会启动它。
- **HTTP**：`GET /v1/guide`（带令牌）返回同样的 Markdown。
- 也可以把 `AGENT_GUIDE.md` 的内容直接贴给 Agent。
