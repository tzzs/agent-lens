# 实测简报 · Qoder 与 OpenCode 本地数据（§17 第 3 项）

- 日期：2026-09-21　机器：darwin/arm64
- 脚本：`probe-qoder.mjs`（通用：格式判定 + SQLite 只读打开 + JSONL 普查）、`probe-opencode.mjs`（SQLite 表/列/粒度）、`probe-capabilities.mjs`（能力普查）
- 只读约束全程遵守；SQLite 打开前后核对 `-wal/-shm` 是否被本次读新建。

---

## 一、Qoder —— 是 JSONL，不是 SQLite；且它是 **Claude Code 的分叉**

`~/.qoder` 存在：**4,845 文件 / 0 个 SQLite / 971 个 JSON(L)**。数据布局**与 Claude Code 同构**：

```
~/.qoder/projects/<cwd-slug>/<session-uuid>.jsonl     ← 会话正文（采样 38 文件 / 14,742 记录）
~/.qoder/logs/runs/<ts>-<rand>-p<pid>/qodercli.log     ← 结构化运行日志 keys=ts,seq,level,type,data
~/.qoder/logs/sessions/<cwd-slug>/<uuid>/…
```
- `cwd-slug` 里出现 `-Users-tanzz--qoder-worktrees-app-623469-picko` → **Qoder 也用 git worktree**，Claude 报告 §三 的 worktree 归组问题对 Qoder 同样成立。

### 1.1 记录结构与 Claude Code 几乎逐字段相同（`probe-qoder.mjs` 普查）

- 记录 type：assistant 6,285 / active-leaf 4,196 / user 3,196 / attachment 452 / file-history-snapshot 246 / runtime-config 85 / last-prompt 74 / workspace-directories 67 / worktree-state 18 / system 16
- 顶层 key：`type, sessionId, timestamp, uuid, parentUuid, isSidechain, cwd, userType, entrypoint, version, message, gitBranch, requestTokenAnchor, leafUuid, agentId, parent_tool_use_id, promptId, sourceToolAssistantUUID, toolUseResult`
- model：`qfmodel`（本机当前模型）6,357 / `auto` 4 / **`<synthetic>` 1**（占位记录同样存在，须排除）
- **session 边界：单文件含 >1 sessionId 的文件 = 0 → 与 Claude 一样"一文件一 session"。**

> 结论：**Qoder Adapter 可直接复用 Claude Code Adapter 的绝大部分规则**（宿主 `entrypoint`、subagent `isSidechain`、worktree 归组、`<synthetic>` 排除、tool_result≠用户轮次）。它是"第二个 Adapter"成本最低的来源。

### 1.2 Qoder 的两个独有扩展（事件模型未覆盖）

1. **计费扩展字段**：`usage` 里除 `input_tokens/cache_read_input_tokens/cache_creation_input_tokens/output_tokens`（**Anthropic 命名，cache 读=`cache_read_input_tokens`**）外，还有 **`credits, original_credits, billable, service_tier, inference_geo, iterations, speed, context_usage_ratio`**。
   > §3.1 无 credits/billable 列；§8 的"subscription 计费口径"目前只是产品概念，**没有落库字段**。Qoder 真实给出 credit 账目 → 事件模型需为 credits 类计费预留列或规范化 metadata。
2. **`requestTokenAnchor`（6,280）+ `usage.request_id`**：实测 **带 usage 记录 2,585 条、每条 request_id 唯一、0 组重复、0 缺失**。
   > 即 **Claude Code 的"多 block 重复 usage"陷阱在 Qoder 不出现**（同一响应未拆成多条重复携带 usage）。AgentLens 对 Qoder **不需要 `GROUP BY request_id 取 max`**，但仍应把 `request_id` 作 event fingerprint 的一部分（口径统一，防未来漂移）。

### 1.3 Qoder 能力（`probe-capabilities.mjs qoder`）：与 Claude 全谱一致

```
MCP:  mcp__ 工具引用≈87  mcp_instructions=11  deferred_tools=33
compaction: 44   hook 事件引用: 77（如 PostToolUse:Edit×11 / PostToolUse:Write×6）
subagent: isSidechain=3,361   skill_listing/invoked_skills=108   Task/Agent 工具=24
```
→ Qoder 记录 **MCP server 名 / compaction / hook / subagent / skill**，能力枚举（§3.3）对 Qoder **完全够用**，与 Claude 同构。

---

## 二、OpenCode —— 是 SQLite；只读可开且**不产生** `-wal/-shm`

数据根 **不在** `~/.opencode`、`~/.config/opencode`（那两处是安装目录：node_modules/skills）。真正的遥测库：

```
~/.local/share/opencode/opencode.db   SQLite  41.8MB（旁有既存 -wal 2.8MB / -shm 1.7MB）
```

### 2.1 只读可开性（关键）✅

`new DatabaseSync(db, {open:true, readOnly:true})` **成功**；22 张表可读；打开前后核对 **本次未新建任何 `-wal/-shm`**（这些 sidecar 是 App 自己既存的文件，非我们创建）。→ **OpenCode 可安全只读采集**，v1 §15「database locked」隐患在 OpenCode 上**不复现**。

### 2.2 表与 session 稳定性

```
session(10) message(531) part(2242) project(4) project_directory(2) workspace
event / event_sequence / permission / todo / session_input / session_message
session_share / session_context_epoch / account / credential / __drizzle_migrations …
```
- **稳定 session UUID**：`session.id`（如 `ses_1dd287108ffe…`，ULID），并带 `project_id`、**`parent_id`（子会话/ subagent 链）**、`agent`、`title`、`directory`、`slug`、`time_compacting`、`time_archived`。→ 无需启发式切 session。

### 2.3 token / 成本：**session 表有专用聚合列，且原生带 cost**

`session` 列：`cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, model(JSON), metadata`
样本：`cost=0.11701, tokens_input=45024, tokens_cache_read=193792, tokens_cache_write=0, reasoning=860`；另一行 `tokens_cache_read=1,981,824`。
- **cache 命名**：`tokens_cache_read` / `tokens_cache_write`（又不同于 Claude 的 `cache_read_input_tokens` 与 Codex 的 `cached_input_tokens`）。
- **成本字段存在**：`session.cost` 是**会话级原生成本**；且 `message.data` 与 `part.data(step-finish)` 内含**每条 message / 每生成步的 `cost`+`tokens`**。
  > ⚠️ 这**证伪了 §8「一切成本必须本地计算、日志里根本没有 cost」**（该断言的实测依据仅来自 Claude）。OpenCode 直接给出上游 cost，AgentLens 应能"原样采纳 reported cost"而非强行重算 → 事件模型 §3.1 缺 `cost_native`/`cost_source` 类列。
- per-record 类型（`part.data`）：`tool`(read 60/bash 31/glob 23/grep 16/edit 5/write 1/**task 3**) / reasoning / step-start / step-finish / text / patch / snapshot，带 `callID/state`。`message.data`：role/agent/parentID/mode/modelID/providerID/**cost**/**tokens**/finish/tools。
- compaction：靠 `session.time_compacting` 时间戳表达（无独立事件行）；`permission` 列/表承载审批。sample 内**未见 `mcp__` / hook 事件**。

### 2.4 OpenCode 事件模型落差

- 事件模型是**逐事件行式**（events 表）；OpenCode 的 `session` 行是**预聚合 rollup**（tokens/cost 已合计）。Adapter 若只读 `session` 会**丢失 per-generation 粒度**（Timeline/Capability 拿不到），若读 `part.data` 才能重建事件。**两全做法：session 表用于快速日报对账，part 表用于事件重建** —— 但 §3.1 目前无"某 rollup 来源"与 reported-cost 落点。
- cache 命名第三次不同（`tokens_cache_*`）→ §3.4 OTel 映射表必须按 Agent 三套命名分支，不能假设统一 `cache_read_input_tokens`。

---

## 三、净结论（对 §3.1 / §3.3 / §8）

| 观察 | 影响 |
|---|---|
| Qoder=Claude 分叉，一文件一 session，含 worktree/isSidechain/skill/hook | Qoder Adapter 近乎复用 Claude；能力枚举对 Qoder 充分 |
| **Claude 的 request_id 重复 usage 陷阱在 Qoder/Codex 均不复现（实测 0 组）** | 去重规则按 Agent 生效，不得全局强加；仍保留 request_id 作 fingerprint |
| Qoder usage 带 `credits/billable/context_usage_ratio` | §3.1 缺 credits 列；§8 subscription 口径需落库支撑 |
| OpenCode 是 SQLite，只读可开且不建 sidecar | 采集安全；增量须走行级高水位（§4.3 已预见）|
| OpenCode `session.cost` + per-part cost **原生存在** | **推翻"日志无成本"**；事件模型需 reported-cost 通道（`cost`/`cost_source`）|
| cache 字段三套命名：`cache_read_input_tokens`(Claude/Qoder) / `cached_input_tokens`(Codex) / `tokens_cache_read`(OpenCode) | §3.4 映射须 per-Agent；input 是否含 cached 也 per-Agent |
| OpenCode subagent 用 `session.parent_id`；compaction 用 `time_compacting` | §3.3 subagent/compact 概念成立，但来源结构各异，归属规则分 Agent |
