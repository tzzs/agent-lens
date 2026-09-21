# 实测简报 · Pi 本地数据

- 日期：2026-09-22　机器：darwin/arm64　脚本：`probe-pi.mjs`
- 结论先行：**Pi（badlogic/pi-mono 的 `pi` CLI agent）在本机已安装**，数据根为 `~/.pi/agent`；会话轨迹是**纯 JSONL**（无 SQLite），且 **usage 自带原生 cost**。版本线索：`settings.json#lastChangelogVersion = 0.85.1`。

---

## 一、数据根位置

| 路径 | 内容 |
|---|---|
| `~/.pi/agent/sessions/<项目目录名>/*.jsonl` | **会话轨迹（唯一采集源）**，本机 6 文件 / 358 记录 |
| `~/.pi/agent/settings.json` | 配置：`lastChangelogVersion, defaultProvider, defaultModel, defaultThinkingLevel, theme` |
| `~/.pi/agent/skills/<name>/` | 技能静态安装面（本机 62 项） |
| `~/.pi/agent/extensions/*.ts` | 扩展（TypeScript 文件即扩展，本机 3 项） |
| `~/.pi/agent/models-store.json` | 自定义 provider 注册表（本机仅 `deepseek`） |
| `~/.pi/agent/auth.json` | 凭据 —— **不读取内容**，adapter 与探针都不碰 |
| `~/.pi/skills` | 另一级技能目录（旧布局，adapter 不采集，避免与 agent 级重复计数） |

会话目录名是 cwd 的可逆编码（`/a/b` → `--a-b--`），但项目归组仍走 cwd 三步规范化，不以目录名为准。

## 二、记录格式（358 条全量普查）

每行一个 JSON 记录。顶层 type：`message` 339 / `model_change` 7 / `session` 6 / `thinking_level_change` 6。
除 `session` 头外，所有记录携带 `{id(8hex), timestamp(ISO), parentId}`（352/358 有 parentId，头记录无），构成**一棵消息树**（分支/重放会产生多叶，但每条 assistant 记录都是真实 API 调用，token 各自独立——全树求和即真实消耗）。

1. **`session` 头**（每文件恰 1 条、恒为首行，实测 6/6）：
   `{type:"session", version:3, id:<uuid>, timestamp:<ISO>, cwd:<绝对路径>}`
   —— 全文件**只有头携带 `cwd` 和会话原生 id**；文件名 `<iso>_<uuid>.jsonl` 的 uuid 实测与头 id 一致（6/6）。
2. **`message` / role=user**：`{content:[{type:"text",text}]}`。
3. **`message` / role=assistant**（160 条）：
   `{content:[…], api, provider, model, usage, stopReason, timestamp(epochMs), responseId?, errorMessage?}`
   - content part 三种：`{type:"text",text}` / `{type:"thinking",thinking,thinkingSignature}` / `{type:"toolCall",id,name,arguments}`。
   - `stopReason` 词表：`toolUse` 140 / `stop` 14 / `aborted` 5 / `error` 1；error/aborted 携带 `errorMessage`，usage 全 0。
   - `responseId`：155/160 有（缺的正是 5 条 aborted/error）。
4. **`message` / role=toolResult**（158 条）：
   `{toolCallId, toolName, content:[{type:"text",text}], isError, timestamp, details?}`
   —— `toolCallId` 与 assistant 的 `toolCall.id` 一一配对（bash 92 调用 = 92 结果）。
5. **`model_change`**：`{provider, modelId}`；**`thinking_level_change`**：`{thinkingLevel}`。产品元数据，无 token。

## 三、usage / cost 语义（关键验证）

assistant 记录 `usage = {input, output, cacheRead, cacheWrite, totalTokens, cost}`，实测 160/160：

- **`totalTokens == input+output+cacheRead+cacheWrite`** → 四桶**互斥**（Anthropic 式：`input` 不含缓存命中），与 Codex 的包含式 `input_tokens` 相反。
- **`cost = {input, output, cacheRead, cacheWrite, total}`（USD），且 `total == 四分项之和`** → **Pi 自带原生成本**（pi-ai 内置价格表算出）。这是继 OpenCode/WorkBuddy 后第三家 `costSource:'reported'` 的 agent；`totalTokens`/`cost` 分项是派生 roll-up，token 侧只取四桶、不取 `totalTokens`（§18 row 2 的累计量陷阱）。
- 无 reasoning token 计数字段（thinking 只有文本），`reasoningTokens` 记"未上报"而非测量 0。
- 样本 provider 仅 `deepseek`（api `openai-completions`），但 `provider`/`model` 逐条自带，映射不依赖 provider 词表。

**聚合判定**：一条 assistant 记录 = 一次 API 响应，usage 只出现在这一条上，无跨记录重复 → 按 `responseId` 分组的 **`request_max`** 在"重复"与"不重复"两种解读下都精确（无 responseId 的 5 条 usage 全 0，requestId NULL 落 per-event 不影响合计）。`subagentsIncluded: true`：轨迹无任何 subagent 标记，无行可排除。

## 四、能力普查

- 静态安装面可枚举：`skills/*`（目录即技能，62 项）→ `type:'skill'`；`extensions/*.ts` → `type:'plugin'`。
- 会话轨迹内：工具词表仅 `bash/read/edit/write`，**未见 MCP / hook / compaction / subagent / skill 调用标记**（358 条样本）。skill 被调用时是否以 user 消息注入的形式出现，样本不可判定 → normalize 不猜，未知形态一律 `unknown`。

## 五、净结论

| 结论 | 严重度 | 备注 |
|---|---|---|
| Pi = 纯 JSONL，无 SQLite → **无 WAL 副作用问题** | 🟢 | 比 WorkBuddy/OpenCode 采集面干净 |
| usage 四桶互斥 + 自带原生 cost | 🟢 | `costSource:'reported'`；映射见 §三 |
| session 头是唯一的 cwd/会话 id 载体 | 🟡 | 头缺失时回退文件名 uuid，并记 diagnostic |
| 消息树可分支（parentId 图） | 🟡 | 分支上的 assistant 都是真实调用，全部计数 |
| thinking 无 token 计数 | 🟡 | `reasoning_tokens_absent` 标记 |
| 样本仅 6 文件 / 单一 provider | 🟡 | 版本升级/漂移由 parserVersion + unknown 计数兜底 |
