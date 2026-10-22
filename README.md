# ReviewFlow

一个 macOS 桌面端的 AI 代码评审工具：放入项目文件夹，解析 Git 改动，用 AI 做多角度 Review，把问题整理成清单，并可在确认后生成补丁修复。

本文分两部分：

- **[第一部分：使用说明](#第一部分使用说明给人看)**：给人看。从安装、配置到日常评审与修复的完整操作。
- **[第二部分：AI Agent 操作手册](#第二部分ai-agent-操作手册给-ai-读)**：给 AI 读。其他 AI Agent（Claude Code、Codex、OpenCode 等）通过 MCP 或本机 HTTP 操作 ReviewFlow 时的接口约定、标准流程和工具索引。可以把这一部分直接交给 Agent。

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

> 本部分写给通过 MCP 或 HTTP 操作 ReviewFlow 的 AI Agent。读完即可完成：拉取改动、评审、处理问题清单、生成并应用补丁、复核、追问、管理需求方案和设置。

## A1. 你在操作什么

ReviewFlow 是用户本机的 macOS 代码评审应用。你调用的每个工具都在用户的**真实数据和真实工作区**上执行，效果与用户在界面上点击相同，界面会同步刷新。工具名就是应用内部 IPC 通道名把 `:` 换成 `_`（例如 `checklist:setStatus` → `checklist_setStatus`），另有少量为 Agent 准备的组合工具（`review_start`、`file_analyze`、`changes_summary`、`app_openProject`、`settings_getSecret`、`agent_waitJob`、`agent_listJobs`）。

## A2. 连接

- **MCP（推荐）**：stdio，换行分隔的 JSON-RPC 2.0，支持 `initialize`、`tools/list`、`tools/call`、`ping`。协议版本 `2025-06-18` / `2025-03-26` / `2024-11-05`。应用未运行时首次 `tools/call` 会自动启动应用（最多等 60 秒）。
- **HTTP**：
  1. 读取 `~/Library/Application Support/auto-review/agent-api.json`（设置了 `REVIEWFLOW_USER_DATA_DIR` 时在该目录），拿到 `url` 和 `token`。`url` 为 `null` 表示应用没在运行或接口已关闭；`enabled: false` 表示用户关闭了接口，不要尝试绕过。
  2. 每个请求带 `Authorization: Bearer <token>`，不要带 `Origin` 头。
  3. `GET /v1/health` 健康检查；`GET /v1/tools` 返回全部工具及参数 JSON Schema；`POST /v1/tools/<工具名>`，`Content-Type: application/json`，请求体是参数对象。
  4. 成功返回 `{"ok": true, "result": ...}`，失败返回 `{"ok": false, "error": "..."}`。

## A3. 调用约定

- 参数一律是 JSON 对象，字段见各工具的 `inputSchema`。
- `folder` 是项目根目录的**绝对路径**（Git 仓库），几乎所有工具都需要。
- 改动来源参数（`changes_summary`、`review_start`、`file_analyze`、`git_getChanges` 通用）：`mode` 取 `uncommitted`（默认）/ `staged` / `unstaged` / `untracked` / `branch` / `ref` / `commits`；`branch`、`ref` 需要 `base`（可写 `A..B`、`A...B`），`commits` 需要 `commits` 数组。不传 `mode` 时按 `base` / `commits` 自动推断。
- 破坏性工具必须显式传 `"confirmed": true`：`fix_applyPatch`、`fix_revertPatch`、`checklist_clear`、`rules_append`。
- `runId`、`requestId` 可以不传，会自动生成；返回值里会带上。
- 优先用组合工具：评审用 `review_start`，不要自己 `git_getChanges` 再把整份 `files` 传给 `ai_analyzeOverview`；看改动用 `changes_summary`，它不含 diff 正文，`git_getChanges` 可能非常大。

## A4. 长任务（表中标 ⏱ 的工具）

评审、生成补丁、复核、追问、生成方案等可能持续几分钟。这些工具接受 `waitSec`（默认 50，最大 600）：

- 在 `waitSec` 内完成：直接返回结果。
- 没完成：返回 `{"state": "running", "jobId": "...", "runId": "...", "tool": "...", "elapsedSec": n, "hint": "..."}`。判断依据是返回值里有 `state: "running"`。之后调用 `agent_waitJob({"jobId": "...", "waitSec": 50})` 继续等，可以反复调用，直到拿到结果或报错。
- 终止：`ai_cancel({"runId": "..."})`。暂停：`ai_pause`；继续：`ai_resume({"runId": "..."})`（同样是长任务）。
- 同一个 `runId` 的任务还在运行时再次发起会报 409；不要重复发起，改用 `agent_waitJob`。
- 任务记录只在应用本次运行期间保留（最多 1 小时、100 个）。应用重启后 `jobId` 失效，但评审结果已写入历史，可以用 `review_list` / `review_get` 找回。
- MCP 客户端的单次工具超时较短（例如 60 秒）时，保持 `waitSec` ≤ 50。

## A5. 错误

- MCP：`tools/call` 返回 `isError: true`，`content[0].text` 是错误信息（中文）。
- HTTP 状态码：400 参数或业务错误、401 令牌错误（重新读取 `agent-api.json`）、403 带了 `Origin` 或 Host 不对、404 工具或任务不存在、409 同一 runId 正在运行、415 Content-Type 不是 JSON。
- 常见业务错误及处理：
  - 「修复生成和复核仅支持 API 或只读 Codex」：当前后端是 OpenCode / Kimi。改用 `fix_handoffPrompt` 交接，或经用户同意后用 `settings_save` 切换后端。
  - 「文件已变化，请重新生成补丁」：重新调用 `fix_generatePatch`。
  - 「问题已更新，请刷新清单后重试」：`expectedUpdatedAt` 过期，先 `checklist_list` 再重试。
  - 「当前改动来源下没有改动文件」：换 `mode` / `base`，或告诉用户没有可评审的改动。
  - 「外部 Agent 接口已在「AI 设置」中关闭」：告诉用户，不要绕过。

## A6. 数据模型

**Finding（问题清单条目）**，`review_start` 返回的 `findings` 是精简版（`id`、`status`、`severity`、`category`、`text`、`location`），`checklist_list` 返回完整版：

| 字段 | 取值 |
| --- | --- |
| `id` | 字符串，所有问题相关工具用它定位 |
| `status` | `pending` 待处理、`partial` 部分修复、`fixed` 已修复、`outdated` 已过时、`wontfix` 不处理 |
| `severity` | `高` / `中` / `低` / `null` |
| `category` | `安全` / `正确性` / `性能` / `可维护性` / `需求符合度` / `其他` |
| `location` | `{ path, side: "new"\|"old", startLine, endLine, anchor }` 或 `null`；没有位置的问题不能生成补丁或复核 |
| `updatedAt` | 时间戳，作为 `checklist_setStatus` 的 `expectedUpdatedAt` 做乐观锁 |
| `verification` | 最近一次复核：`{ verdict, note, ... }`，`verdict` 取 `已修复` / `仍存在` / `部分修复` / `已过时` |
| `dismissal` | 不处理原因：`{ reason, note }`，`reason` 取 `false_positive` / `intentional` / `handled_elsewhere` / `other` |

「未关闭」的问题指 `status` 为 `pending` 或 `partial`。

**补丁**：`fix_generatePatch` 返回 `{ patchId, diff, files: [{path, additions, deletions}], check: { ok, error }, stats }`。只有 `check.ok === true` 的补丁能应用。

## A7. 标准流程

**评审当前改动**

1. `changes_summary({"folder": F})`：确认有改动、看规模。
2. 可选：`ai_estimate({"folder": F, "kind": "overview", "snapshotId": <上一步的 snapshotId>})` 预估费用，费用较高时先问用户。
3. `review_start({"folder": F})`，可加 `noiseLevel`（`quiet`/`balanced`/`detailed`）、`presetId`、`compareWithLast`、`models`（多模型，至少 2 个，如 `[{"backend":"api"},{"backend":"codex"}]`）、`kind: "full"`（完整讲解）。
4. 返回 `markdown`（评审正文）、`reviewId`、`findings`。返回 `paused` 或 `failed` 时可以用 `ai_resume({"runId"})` 继续。

**修复一条问题**

1. `checklist_list({"folder": F})`，选一条未关闭且有 `location` 的问题。
2. `fix_generatePatch({"folder": F, "findingId": ID})`，检查 `check.ok` 和 `diff`。不满意可以带 `extraInstruction` 重新生成。
3. 用户授权后：`fix_applyPatch({"folder": F, "patchId": P, "confirmed": true})`。
4. `fix_verifyFinding({"folder": F, "findingId": ID})`。`verdict` 为 `已修复` 时状态会自动更新。
5. 要回退：`fix_revertPatch({"folder": F, "patchId": P, "confirmed": true})`。已保存的补丁用 `fix_listPatches` 查看，用 `fix_openPatch` 重新预检。

**不用补丁，由你自己改代码**：直接编辑文件，然后 `fix_verifyFinding` 复核；或者 `checklist_setStatus({"folder": F, "id": ID, "status": "fixed"})`。

**标记不处理**：`checklist_setStatus({"folder": F, "id": ID, "status": "wontfix", "dismissal": {"reason": "intentional", "note": "..."}})`。

**把规则写进 .reviewflow.md**：`checklist_ruleSuggestions` → `rules_previewAppend({"folder", "suggestionId", "snippet"})`，把 `resultingText` 给用户看 → `rules_append({"folder", "previewId", "confirmed": true})`。

**对评审结果追问**：`chat_create({"folder", "reviewId"})` 得到对话 `id` → `chat_send({"folder", "threadId": id, "question": "..."})`。

**需求方案**：`plan_create({"folder", "title", "prdText"})` → 可选 `plan_addImage({"folder", "planId", "filePath"})` → `plan_generate({"folder", "planId"})` → `plan_setActive({"folder", "planId"})`，之后 `review_start` 默认参照该方案（`usePlan: false` 可关闭）。

**让用户在界面上看到**：`app_openProject({"folder": F})` 把窗口切到该项目。

## A8. 行为守则

- **先问再做**：`fix_applyPatch`、`fix_revertPatch`、`checklist_clear`、`checklist_save`（整体覆盖）、`rules_append`、`review_delete`、`plan_delete`、`settings_save`、`preset_import`、`icon_apply` / `icon_reset`、`update_download` 都会改用户数据或工作区。除非用户已经明确授权，否则先说明要做什么，得到同意再调用。
- **花钱前先说**：评审、生成补丁、复核、追问、生成方案都会调用用户配置的 AI 后端并产生费用。大规模评审先用 `ai_estimate` 告知用户。
- **保护密钥**：`settings_getSecret` 返回明文 API Key，只在确有必要时调用，不要输出、记录或转发其中的密钥。普通读取用 `settings_get`（已脱敏）。
- **补丁不提交**：补丁只写工作区，ReviewFlow 从不暂存或提交。是否提交由用户决定。
- **需要人操作的工具**：`dialog_selectFolder`、`icon_pick`，以及不带 `filePath` 的 `preset_export` / `preset_import` / `review_export`，会弹出系统对话框，等用户在界面上操作。能传 `filePath` 时就传。
- **不要停用用户的界面功能**：`watch_stop` 会关掉界面的文件监听自动刷新，没有必要不要调用。
- **以返回值为准**：不要假设操作成功，检查返回的 `check.ok`、`verdict`、`persistenceWarnings`、`coverageNotices`，有警告时如实告诉用户。

## A9. 工具索引

⏱ 表示长任务，支持 `waitSec`。完整参数见 `tools/list` 或 `GET /v1/tools` 返回的 `inputSchema`。

| 工具 | 说明 | 必填参数 |
| --- | --- | --- |
| `changes_summary` | 列出改动文件摘要（路径、状态、增删行数），不含 diff 正文；需要正文用 git_getChanges。 | folder |
| `review_start` ⏱ | 推荐入口：按改动来源拉取 diff 并发起一次评审（kind=review 多角度评审 / full 完整讲解），完成后自动保存历史并合并问题清单。耗时较长，见 waitSec。 | folder |
| `review_save` | 直接写入一条评审历史 | folder |
| `review_updateStats` | 更新历史记录的统计信息 | folder, id, stats |
| `review_list` | 评审历史列表 | folder |
| `review_get` | 读取一条评审历史全文 | folder, id |
| `review_delete` | 删除一条评审历史 | folder, id |
| `review_rename` | 重命名评审历史 | folder, id, title |
| `review_setPinned` | 置顶或取消置顶评审历史 | folder, id, pinned |
| `review_export` | 导出文本为 md/html；传 filePath 直接写文件，否则弹出保存对话框 | content |
| `file_analyze` ⏱ | 对单个改动文件做 AI 分析（结果会缓存）。 | folder, path |
| `checklist_list` | 问题清单 | folder |
| `checklist_save` | 整体覆盖保存问题清单 | folder, items |
| `checklist_setStatus` | 修改一条问题的状态；wontfix 需带 dismissal | folder, id, status |
| `checklist_clear` | 清空本项目问题清单（并删除其补丁） | folder, confirmed |
| `checklist_ruleSuggestions` | 由「不处理」归纳出的规则建议 | folder |
| `checklist_dismissRuleSuggestion` | 忽略一条规则建议 | folder, id |
| `fix_generatePatch` ⏱ | 为一条问题生成修复补丁（只预览，不改文件）；仅 api/codex 后端支持 | folder, findingId |
| `fix_applyPatch` | 把补丁应用到工作区（不暂存不提交） | folder, patchId, confirmed |
| `fix_revertPatch` | 撤销已应用的补丁 | folder, patchId, confirmed |
| `fix_listPatches` | 本项目已保存的补丁 | folder |
| `fix_openPatch` | 读取未应用补丁的 diff 并按当前工作区重新预检 | folder, patchId |
| `fix_verifyFinding` ⏱ | 让 AI 复核一条问题是否已修复，并更新清单 | folder, findingId |
| `fix_handoffPrompt` | 生成交给其他编码 Agent 的修复任务提示词 | folder, findingIds |
| `rules_previewAppend` | 预览把规则追加到 .reviewflow.md 的结果，返回 previewId | folder, suggestionId, snippet |
| `rules_append` | 按 previewId 追加规则到 .reviewflow.md | folder, previewId, confirmed |
| `rules_effective` | 指定文件实际生效的 .reviewflow.md 规则 | folder, paths |
| `chat_list` | 追问对话列表 | folder |
| `chat_get` | 读取一个追问对话 | folder, id |
| `chat_create` | 基于评审历史新建追问对话 | folder, reviewId |
| `chat_send` ⏱ | 在追问对话里发送问题并得到回答 | folder, threadId, question |
| `fileAnalysis_list` | 某个快照下各文件已缓存的分析结果 | folder, snapshotId |
| `ai_analyzeOverview` ⏱ | 底层评审接口，需要 git_getChanges 的 files；一般用 review_start | folder, files |
| `ai_analyzeOverviewMulti` ⏱ | 底层多模型评审接口；一般用 review_start 并传 models | folder, files, models |
| `ai_explainChange` ⏱ | 逐句解析：解释选中的改动代码 | folder, filePath |
| `ai_analyzeFile` ⏱ | 底层单文件分析接口；一般用 file_analyze | folder, file |
| `ai_explainFull` ⏱ | 底层完整讲解接口；一般用 review_start 并传 kind=full | folder, files |
| `ai_estimate` | 预估调用次数、token 与费用 | folder, kind |
| `ai_testConnection` | 用给定设置测试 AI 后端连通性（字段同 settings_save） | — |
| `ai_listModels` | 用给定设置拉取可用模型列表（字段同 settings_save） | — |
| `ai_getCurrentRun` | 当前运行中的 AI 任务 | — |
| `ai_listRuns` | 全部 AI 运行记录（本次启动内） | — |
| `ai_getRunPrompt` | 查看某次运行发送的提示词 | runId |
| `ai_cancel` | 终止 AI 运行 | runId |
| `ai_pause` | 暂停 AI 运行（分批评审可暂停） | runId |
| `ai_resume` ⏱ | 继续已暂停的运行 | runId |
| `ai_explainFollowUp` ⏱ | 对逐句解析结果追问 | folder, question |
| `ai_reviewFollowUp` ⏱ | 对评审结果追问（需传 files） | folder, files, question |
| `git_getChanges` | 拉取改动及完整 diff（可能很大）；返回的 snapshotId 可用于 ai_estimate、fileAnalysis_list | folder |
| `git_getBranches` | 分支列表 | folder |
| `git_getCommits` | 最近提交列表 | folder |
| `plan_list` | 需求方案列表 | folder |
| `plan_create` | 新建需求方案（导入 PRD 文本） | folder |
| `plan_addImage` | 为方案添加设计稿；传 filePath 或 base64 | folder, planId |
| `plan_removeImage` | 移除方案设计稿 | folder, planId, name |
| `plan_detail` | 方案详情 | folder, planId |
| `plan_generate` ⏱ | 根据 PRD 与设计稿生成技术方案 | folder, planId |
| `plan_delete` | 删除方案 | folder, planId |
| `plan_setActive` | 设置评审时参照的方案；planId 传 null 取消启用 | folder, planId |
| `plan_getActive` | 当前启用的方案 | folder |
| `plan_fetchPrdUrl` | 抓取网页 PRD 文本 | url |
| `plan_fetchDesignUrl` | 抓取设计稿图片或网页截图 | url |
| `settings_getSecret` | 读取完整设置，包含明文 API Key。 | — |
| `settings_get` | 读取设置（API Key 脱敏；明文用 settings_getSecret） | — |
| `settings_save` | 保存设置（只传要改的字段）。常用字段：backend(api/opencode/kimi/codex)、baseUrl、apiKey、clearApiKey、model、opencodeModel、kimiModel、codexModel、customPrompt、customDimensions、reasoningEffort、noiseLevel、timeoutMin、excludePatterns、pricing、presets | — |
| `preset_export` | 导出评审预设为 JSON；传 filePath 直接写文件，否则弹出保存对话框 | — |
| `preset_import` | 导入评审预设；传 filePath 直接读文件，否则弹出打开对话框 | — |
| `agent_waitJob` | 继续等待一个长任务（review_start、fix_generatePatch 等返回的 jobId）。 | jobId |
| `agent_listJobs` | 列出本次应用运行期间由外部 Agent 发起的长任务及状态。 | — |
| `app_openProject` | 让 ReviewFlow 窗口切换到指定项目（与在界面里打开项目相同）。 | folder |
| `app_getInitialFolder` | 启动参数里传入的项目路径 | — |
| `app_getVersion` | 应用版本号 | — |
| `recent_list` | 最近打开的项目 | — |
| `recent_add` | 加入最近项目 | folder |
| `watch_start` | 让界面监听该目录的文件变化 | folder |
| `watch_stop` | 停止文件监听 | — |
| `icon_pick` | 弹出系统对话框让用户选择图标图片（需用户在界面操作） | — |
| `icon_apply` | 把指定图片设为应用图标 | imagePath |
| `icon_reset` | 恢复默认应用图标 | — |
| `icon_current` | 当前自定义图标信息 | — |
| `dialog_selectFolder` | 弹出选择文件夹对话框（需用户在界面操作） | — |
| `update_check` | 检查新版本 | — |
| `update_download` ⏱ | 下载新版本 DMG 并打开 | dmgUrl |
