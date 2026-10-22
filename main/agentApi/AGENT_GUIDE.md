# ReviewFlow AI Agent 操作手册

> 写给通过 MCP 或 HTTP 操作 ReviewFlow 的 AI Agent。读完即可完成：拉取改动、评审、处理问题清单、生成并应用补丁、复核、追问、管理需求方案和设置。

## A1. 你在操作什么

ReviewFlow 是用户本机的 macOS 代码评审应用。你调用的每个工具都在用户的**真实数据和真实工作区**上执行，效果与用户在界面上点击相同，界面会同步刷新。工具名就是应用内部 IPC 通道名把 `:` 换成 `_`（例如 `checklist:setStatus` → `checklist_setStatus`），另有少量为 Agent 准备的组合工具（`review_start`、`file_analyze`、`changes_summary`、`app_openProject`、`settings_getSecret`、`agent_waitJob`、`agent_listJobs`、`agent_guide`）。本手册可随时通过 `agent_guide` 工具或 `GET /v1/guide` 重新获取，末尾的工具索引由应用按当前版本实时生成。

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
