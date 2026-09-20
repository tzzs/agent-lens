# 实测报告 · Codex 本地日志（§17 第 2 项）

- 日期：2026-09-21　机器：darwin/arm64　Codex 版本区间：`0.93.0 → 0.155.0-alpha.9.2`
- 样本：`~/.codex/sessions/**/rollout-*.jsonl` + `~/.codex/archived_sessions/**/rollout-*.jsonl` 全量
  **379 个 JSONL / 571.4 MB / 221,416 条记录 / parseErr=0**
- 脚本：`probe-codex.mjs`（全量普查）、`probe-codex-2.mjs`（usage 粒度/去重/合成/按天）、`reconcile-codex-ccusage.mjs`（对账）
- 所有数字均可重跑复现。目录布局：`sessions/YYYY/MM/DD/rollout-<日期>T<时间>-<ULID>.jsonl`。

---

## 一、被测试与证伪的假设

### ❌ 假设 1「Codex 沿用 Claude Code 的 `requestId` 多 block 重复 usage」——**不成立**

实测（`probe-codex-2.mjs` ③）：Codex 的 usage **不存在"一次 API 响应拆成多条记录、每条重复携带同一份"** 的形态。
- 主格式（旧）是 `event_msg.payload.type === 'token_count'`，每次生成一条，无 `requestId` 概念。
- 新格式 `token_usage_record`（14 条）中，同一 `(thread_id, response_id)` 出现 >1 次的组 = **0**。

**但 Codex 有一个更危险、且 Claude Code 里不存在的陷阱 ↓**

### ⛔ 头号风险（严重度：致命）：usage 有**三种粒度嵌套**，误取 cumulative 字段求和 → 虚高 **~1971×**

每条 `token_count.payload.info` 同时携带**两个**对象：
- `last_token_usage`：**本次调用（per-call）** —— 应求和的就是它。
- `total_token_usage`：**整个线程的累计运行值（cumulative）** —— 求和它是灾难。

另有 `model_context_window`。新格式 `token_usage_record` 更把粒度做到三层：`usage`（per-call）/ `turn_token_usage`（每轮累计）/ `thread_token_usage`（整线程累计）。

全量历史两种口径对比（`probe-codex-2.mjs` ①，单位 tokens，`Σ` 指对全部 usage 记录求和）：

| 字段 | Σ last（正确） | Σ total（累计，错误） |
|---|---|---|
| input_tokens | 5.44B | 10,657.40B |
| cached_input_tokens | 5.25B | 10,414.63B |
| cache_write_input_tokens | 0 | 0 |
| output_tokens | 11.88M | 17.51B |
| reasoning_output_tokens | 2.89M | 2.74B |
| **合计（含缓存输入+输出）** | **≈10.70B** | **≈31,767B** |

**误用累计字段 = 虚高 1971×。** 这不是"多算 87%"，是"多算三个数量级"——只要选错字段，数字立刻荒谬。

**逐文件自证（`probe-codex-2.mjs` ②）**：对 >5 条 usage 的 270 个文件，`Σ last_token_usage ≈ 末条 total_token_usage` 的有 218 个（80.7%），比值上界 1.995。剩余偏差来自"线程被 resume / 子线程并入"，进一步印证 **`last` 才是 per-call、`total` 是累计**。

> 规则：Codex token 一律取 `last_token_usage`（旧）/ `usage`（新）逐条求和；`total_*`/`turn_*`/`thread_*` 三个累计字段**只能作展示快照，绝不能进 SUM**。这条必须是 `event-model` 一等规则，和 Claude 的 `requestId` 去重并列。

### ⚠️ 次级风险：subagent 线程与 `ccusage` 的口径分歧（虚高 +77%）

`probe-codex.mjs` ④：379 文件里 **257 个 `thread_source=subagent`**、103 个 user、18 个无、1 个 guardian_review。子线程有**独立 token_count**，其成本已含各自文件里；但**社区基准 ccusage 明显不计子线程**（见 §五）：全量 `Σlast` 相对 ccusage **虚高 +77%（cacheRead +78%）**，而排除 subagent 后逐字段基本对齐。
> Adapter 必须显式决定"子线程是否并入其父 session 计量"，并把该选择做成可复现口径，否则"今天花了多少"会因是否计 subagent 相差近一倍。

### ⛔ 风险：`ccusage` 的"正确"含隐藏口径差（net input vs cached）

Codex 的 `input_tokens` **包含** `cached_input_tokens`（Anthropic 语义相反：Claude 的 `input_tokens` 不含缓存）。ccusage 把 `cached_input_tokens→cacheRead`、`(input-cached)→净input`。任何自研聚合若不还原这层，input 与 cache_read 会重复计一份缓存。详见 §五。

### ⛔ 风险 4：格式在 Codex 内部**自身漂移**

`event_msg.token_count`（42,896 条）与顶层 `token_usage_record`（14 条，provider `agentx`、日期 ≥2026-09-15、带 `response_id`）**并存**，且顶层记录类型除 session_meta/response_item/event_msg/turn_context 外还有 `compacted`（222）、`world_state`（189）、`inter_agent_communication_metadata`（423）。→ §5.3 白名单 + unknown 兜底对 Codex 同样必要。

### ⛔ 风险 5：占位/synthetic 记录（新格式）

`token_usage_record` 中 `response_id ∈ {r1, resp_1}` 且四项 usage ≤1 的占位记录 = **12 条**；旧 `token_count` 四项全 0 = 224 条（`probe-codex-2.mjs` ④）。需与 Claude 的 `<synthetic>` 同样排除，否则每线程多计幽灵调用。

---

## 二、结构普查

### 2.1 顶层记录类型（`probe-codex.mjs` ①）

```
response_item 110,406 | event_msg 105,870 | turn_context 3,913
inter_agent_communication_metadata 423 | session_meta 379 | compacted 222
world_state 189 | token_usage_record 14
```
真实语义藏在 `payload.type`：
- `response_item.payload.type`：function_call 29,780 / function_call_output 29,777 / message 19,645 / reasoning 17,696 / custom_tool_call 6,167 / custom_tool_call_output 6,167 / agent_message 423 / web_search_call 283 / tool_search_call 229 / tool_search_output 229 / image_generation_call 9 / compaction 1
- `event_msg.payload.type`：token_count 42,896 / item_completed 33,527 / thread_goal_updated 22,577 / task_started 3,190 / task_complete 3,141 / thread_settings_applied 507 / turn_aborted 32

### 2.2 `session_meta.payload` 字段（出现率基于 379 文件）

```
100%: session_id, id, timestamp, cwd, originator, cli_version, source,
      model_provider, base_instructions, history_mode
 95.3%: thread_source   87.1%: git   68.3%: subagent_history_start_ordinal
 51.2%: parent_thread_id 51.7%: multi_agent_version 36.7%: agent_nickname
 26.4%: forked_from_id   24.5%: dynamic_tools  19.8%: agent_role  14.5%: agent_path
```
→ **`cwd` / `git` 在 session_meta 首条即有**（不同于 Claude"须从消息记录取 cwd"），项目归组可直接取 session_meta。

### 2.3 宿主（`originator`）与来源

```
originator: Codex Desktop 343 | codex-tui 15 | codex_exec 13 | codex_cli_rs 8
thread_source: subagent 257 | user 103 | (none) 18 | guardian_review 1
model_provider: openai 364 | agentx 15
```
> **`host_id` 对 Codex 同样必要**：4 种 originator（Desktop / tui / exec / cli_rs）共用一套 rollout 格式。若把整个目录记作"Codex CLI"，与 Claude Desktop 的问题同构。`agentx` 是自定义 provider（deepseek-flash 走它），Pricing 需覆盖。

### 2.4 模型标识（`turn_context.model`）

```
gpt-5.5 1719 | codex-auto-review 1291 | gpt-5.2-codex 610 | gpt-5.6-sol 273
deepseek-flash 15 | gpt-5.4 3 | gpt-5.1-codex-mini 1 | gpt-5.4-mini 1
```
`codex-auto-review` 是自动审查子 Agent 的模型名（subagent 线程），非真实用户模型，需在归因时区分。仅 3 个文件跨多模型。

### 2.5 token 字段命名（**与 Claude 不同，重点**）

`token_count.info.{last,total}_token_usage` 与新格式 `usage` 统一为六字段：
```
input_tokens, cached_input_tokens, cache_write_input_tokens,
output_tokens, reasoning_output_tokens, total_tokens
```
- **cache 读**：Codex 叫 `cached_input_tokens`（Claude 是 `cache_read_input_tokens`）。
- **cache 写**：Codex 叫 `cache_write_input_tokens`（Claude 是 `cache_creation_input_tokens`）。
- **reasoning**：`reasoning_output_tokens`，是**独立的 per-call 值，非累计**（与 output 一样在 `last_*` 里给出本次量）。
- `input_tokens` **含** `cached_input_tokens`（Claude 相反）。
→ 事件模型 §3.1 的四列 cache 命名映射表必须按 Agent 分支，`input` 是否含缓存也须按 Agent 标注。

### 2.6 成本字段：**无**

结构化检索 `*cost*`/`*usd*`/`price` 键 = **0 次命中**（`probe-codex.mjs` ⑦）。与 Claude 一致：日志不含成本，一切成本须本地 Pricing 计算；但 ccusage 能对 Codex 出价（§五），说明价格表可得。

---

## 三、session 边界 / 能力表达

### 3.1 Session 边界：**文件 = thread，不等于 session；一个 session 可跨多文件**

- `session_meta.payload.id`（= thread_id）：**与文件 1:1**（379 文件 379 distinct id，0 文件含 >1 thread_id）。
- `session_meta.payload.session_id`（父会话）：**280 个 distinct，其中 11 个出现在 >1 文件**（`probe-codex.mjs` ④）。子线程 `parent_thread_id`（194 个 session_meta 有）与 `forked_from_id`（100）指向父线程，但共享父 `session_id`。
> 结论：**Codex 不是"一文件一 session"**（这与 Claude 相反）。正确切分：`thread_id`=采集/去重单位（=文件），`session_id`=产品口径的"会话"（跨父+子+分叉）。v2 §4.1 的"一文件一 session"兜底对 Codex 会**把一次会话的父子链拆成多个 session**，或反向把 resume 折叠错。必须双 ID。

### 3.2 能力：tool / MCP / subagent / compaction / **hook 不存在**（`probe-capabilities.mjs codex`）

- **工具（`function_call`）**：exec_command 20,919 / write_stdin 4,018 / wait_agent 1,119 / update_plan 905 / view_image 252 / send_message 235 / shell_command 196 / spawn_agent 143 / close_agent 42 … ；**`custom_tool_call`：apply_patch 2,987 / exec 3,180**（Codex 用 `custom_tool_call` 而非 tool_use 承载 apply_patch）。
- **MCP server 名**：**没有 `mcp__<server>__<tool>` 形态**（精确 function_call 名前缀匹配 = 0）。Codex 的"外部能力/服务器"经 `session_meta.dynamic_tools[].name` 命名空间承载：`codex_app 93 / plugin_management 6 / read_thread_terminal 1 / load_workspace_dependencies 1`，另有 `tool_search_call 229`（动态工具发现）。
  > `capability_provider`（MCP server 名）对 Codex 要**从 `dynamic_tools` 命名空间解析**，不能靠 `mcp__` 前缀——这与 Claude 的解析规则完全不同。事件模型 `mcp.invoke` 概念成立，但**来源不同**。
- **compaction（上下文压缩）**：**有独立记录类型 `compacted`（222 条）** + `response_item.compaction`（1）。`compacted.payload.replacement_history` 是压缩后的历史快照。→ **证实 §3.3 `context.compact` 必要且各 Agent 都有数据源**。
- **subagent**：`thread_source=subagent`（257 文件）+ `parent_thread_id` + `agent_message`（423）+ `inter_agent_communication_metadata`（423）+ `spawn_agent/wait_agent/close_agent/interrupt_agent/list_agents` 工具。**没有** Claude 的 `isSidechain` 布尔位——机制不同（线程级而非记录级）。→ `subagent.start/end` 成立，但归属键是 `parent_thread_id`/`forked_from_id`，非 `agentId↔tool_use.id` 启发式。
- **hook**：**0 条 hook 事件**。Codex 支持 `~/.codex/hooks.json` 配置，但**会话日志不落 hook 记录**（`probe-capabilities.mjs` 里"hook" 仅命中 3 处配置/正文文本）。
  > ⚠️ 直接影响 §1.5「能力枚举加 hook」：hook 是 **Claude/Qoder 专属可观测项，Codex 侧恒为 0**。能力枚举保留 hook 没问题，但 Dashboard 不能假设各 Agent 都有 hook——否则 Codex 用户会看到"0 hook"而困惑。
- 其他高价值：`world_state`（189，含 `agents_md` 项目指令、环境、时区）、`thread_goal_updated`（22,577，Goals 目标态）、`task_started/complete`（每轮 turn_id、时间戳）、`turn_aborted`（32，错误/中断信号）。`base_instructions` 含完整 system prompt（内容层，默认不存）。

---

## 四、对方案的净结论（§4.4 格式）

| # | 实测结论 | 严重度 | 处置 |
|---|---|---|---|
| 1 | usage 无 Claude 式"同响应多 block 重复"（0 组） | — | `requestId` 去重规则**不适用 Codex**；事件模型需支持"无 request_id"分支 |
| 2 | usage 三层粒度；误用 cumulative（`total`/`turn`/`thread`）求和 **虚高 ~1971×** | 🔴 致命 | 规则：只 SUM `last_token_usage`/`usage`；累计字段仅入 metadata 展示 |
| 3 | 257/379 文件是 subagent，全量 Σlast 相对 ccusage **+77%** | 🔴 致命 | 显式 subagent 计量策略（默认对齐 ccusage 排除，UI 可切换"含子链"）|
| 4 | Codex `input_tokens` **含** cached（与 Claude 反）| 🟠 高 | per-Agent 的 cache 语义标注；否则 cache_read 双计 |
| 5 | cache 命名 `cached_input_tokens`/`cache_write_input_tokens`；`reasoning_output_tokens` per-call | 🟠 高 | §3.4 映射表按 Agent 分支，不得复用 Claude 字段名 |
| 6 | 一 session 跨多文件（thread=文件，session=父链）| 🟠 高 | §4.1 session_id 拆成 `thread_id`(源粒度)+`session_id`(产品粒度)双键 |
| 7 | originator 4 种宿主共用 rollout 格式（Desktop 343 占绝对多数）| 🟠 高 | `host_id` 维度推广到 Codex |
| 8 | 无成本字段（0 命中）| 🟡 中 | Pricing 自算（ccusage 已能出 Codex 价，§五）|
| 9 | MCP 无 `mcp__` 调用，改由 `dynamic_tools` 命名空间 | 🟡 中 | `capability_provider` 解析规则分 Agent；`mcp.invoke` 来源不同 |
| 10 | hook 事件恒为 0 | 🟡 中 | 能力枚举保留 hook，但 UI 不得假设各 Agent 皆有 |
| 11 | `compacted`(222)/`thread_source`/`world_state` 等新类型；token_count 与 token_usage_record 并存 | 🟠 高 | §5.3 白名单 + unknown 兜底 + 跨版本 fixtures |
| 12 | 新格式占位 `r1/resp_1`（12 条）+ 旧格式零值（224 条）| 🟡 中 | synthetic 排除规则推广到 Codex |

---

## 五、ccusage 对账（§17 第 2 项）——口径已确认可对齐

工具：`ccusage@20.0.23`（`docs/research/node_modules/.bin/ccusage`，仅对账用；实测 `ccusage --help` **已支持 `codex` 子命令**）。基线：
`ccusage codex daily -j -O -z UTC --since 20260201 --until 20260921` → `ccusage-codex-baseline.json`
（41 天，离线价表 cost 合计 **$2153.22**）。
比对：`node reconcile-codex-ccusage.mjs ccusage-codex-baseline.json`。

| 口径 | cacheReadΔ | 净inputΔ | outputΔ | reasoningΔ | 合计Δ |
|---|---|---|---|---|---|
| A Σlast 全部（含 subagent） | +78.2% | +54.4% | +60.5% | +45.4% | +77.2% |
| **B Σlast 排除 subagent** | **+2.3%** | **−10.7%** | **−2.0%** | **−3.7%** | **+1.8%** |
| C Σcumulative 末值 全部 | +106.0% | +74.0% | +82.2% | +64.1% | +104.7% |

### 判定

1. ✅ **正确口径 = `Σ last_token_usage`（per-call）且排除 subagent 线程**（口径 B），逐字段与 ccusage 偏差 **≤11%**、cacheRead 仅 **+2.3%**、总合计 **+1.8%**。M2 对 Codex 的 token 口径成立。
2. **ccusage 不计 subagent**（A→B 的巨大落差即证据）→ 这是"含/不含子链"的产品口径分歧点，AgentLens 必须二选一并标注，不能默默对齐 ccusage 的一半。
3. **净 input 残差 −10.7%**：来自 ccusage 对 resume session 的 cumulative 基数还原与 Codex `input` 含缓存的边界；量级小但需写进 fixtures。
4. **绝不能对 cumulative 字段求和**（口径 C 虚高一倍，且 §一 显示全量 1971×）。
5. ccusage 的 Codex 成本 **$2153.22/41 天**（离线价表）→ M3 Pricing 须能在同窗口产出可比数字，作为 Codex 侧回归锚点。
