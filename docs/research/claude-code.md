# 实测报告 · Claude Code 本地日志（§17 第 1、2 项）

- 日期：2026-09-21　机器：darwin/arm64　Claude Code 版本区间：`2.1.149 → 2.1.275`
- 样本：`~/.claude/projects/` 全量 **92 个 JSONL / 255.8 MB / 68,314 条记录 / parseErr=0**
- 脚本：`probe-claude-code.mjs`（全量普查）、`-2`（attachment/usage 重复）、`-3`（去重口径量化）、`-4`（用户消息形态/hook/cwd）
- 所有数字均可重跑复现。

---

## 一、头号结论：v2 §4.4 的核心假设被证伪，但暴露了一个更严重的问题

### ❌ 假设 1「Claude Code 会剥离 usage 字段」—— 不成立

按文件 mtime 年龄分桶统计 assistant 记录携带 `message.usage` 的比例：

| 文件年龄 | 文件数 | assistant 记录 | 带 usage | 比例 |
|---|---|---|---|---|
| 1–6h | 9 | 3,911 | 3,911 | **100%** |
| 6–24h | 5 | 945 | 945 | **100%** |
| 1–7d | 36 | 6,591 | 6,591 | **100%** |
| 7–30d | 29 | 7,618 | 7,618 | **100%** |
| >30d | 13 | 978 | 978 | **100%** |

**没有任何时间窗口上的衰减。** 该假设来自 ccusage 社区对 `--include-partial-messages` 的讨论，它针对的是 *streaming partial* 记录，不是最终落盘的 assistant 记录。对本机版本（2.1.x）而言，事后冷扫描与常驻 watch **拿到的 usage 数据一致**。

> 直接影响：M1 不再需要"字符数降级估算"这条兜底路径作为主设计；`usage_source` 三态仍保留（用于其他 Agent 与未来版本），但 Claude Code 分支可标 `reported`。

### ⛔ 新发现的风险 1（严重度：致命）：一次 API 响应拆成多条记录，`usage` 重复携带 → 逐条求和虚高 **1.87×**

assistant 记录带 `requestId` 与 `apiBlockIndex`：**一次 API 响应的每个 content block（text / tool_use / thinking）各写一条 assistant 记录，且都携带同一份 usage。**

- distinct `requestId` = 10,330；其中 **6,883 个请求是多 block**
- 多 block 请求中 **6,545 个（95.1%）各 block 的 usage 完全相同**，338 个仅 `output_tokens` 逐 block 递增

样本：
```
req_011Cf1t4  block0: in=8,out=1,cacheRead=40551,cacheCreate=4164
              block1: 同上   block2: 同上
              block3: out=404（其余相同）
```

本机全量历史两种口径对比（单位 tokens）：

| 口径 | input | output | cache_read | cache_creation | 合计 |
|---|---|---|---|---|---|
| 逐条求和（错误） | 747K | 16.05M | 4,924.58M | 102.26M | **5,043.64M** |
| 按 requestId 取 max（正确） | 273K | 7.04M | 2,650.11M | 42.18M | **2,699.61M** |
| 虚高倍数 | 2.74× | 2.28× | 1.86× | 2.42× | **1.87×** |

**正确聚合规则：`GROUP BY requestId` → input/cache 类字段取组内 max（实测组内相同），output 取组内 max。**
- `requestId` 缺失：**52 条**（0.26%）→ 回退用 `(session_id, uuid)` 作组键，退化为单条。
- 该规则必须是 `packages/event-model` 的一等公民（`generation.end` 事件挂 requestId 并作为 `event.id` fingerprint 的一部分），不能留在 Adapter 里当私有逻辑。
- **这是"数字悄悄错"最典型的形态**：错了 87%，而且方向是虚高，用户只要和 ccusage 对一次就会发现我们是错的。

### ⛔ 新发现的风险 2：真实数据缺失来自**文件级保留策略**，不是字段剥离

`~/.claude/projects/` 有 32 个项目目录，其中 **6 个（18.75%）已无任何 JSONL**，且恰好是主工作区（`agentx`、`picko`、`skillbox`、`storops`、`air-relay`），而它们的 worktree 子目录仍有文件。

> 结论：**首次扫描的"历史全貌"天然不完整**，Dashboard 必须把"已发现 N 个会话 / 受上游保留策略影响，历史不可恢复"作为一等提示，而不是假装扫到了全部。
> 补救源：`~/.claude/history.jsonl`（本机 81 KB，字段 `{display, pastedContents, timestamp, project, sessionId}`）保留了**跨项目的用户输入索引**，可在 JSONL 已删的情况下恢复"会话存在性 + 首条输入 + 项目归属"。

### ⛔ 新发现的风险 3：日志里**完全没有成本字段**

20,043 条带 usage 的 assistant 记录中 `costUSD` / `total_cost_usd` / `totalTokens` 出现次数均为 **0**。
> 一切成本必须由本地 Pricing Engine 计算 —— v2 §8 的分层设计得到验证，但也意味着"价格表缺失 = 该 Agent 成本不可用"，`doctor` 必须显式暴露。

实测模型分布（Pricing 需覆盖）：
```
claude-sonnet-5 9236 | claude-opus-4-8 2390 | claude-sonnet-4-6 2160 | claude-opus-5 1979
claude-opus-4-7 1688 | claude-opus-4-6 1614 | claude-haiku-4-5-20251001 882
<synthetic> 92 | deepseek-flash 2
```

### ⛔ 新发现的风险 4：`<synthetic>` 占位记录必须排除

恰好 **92 条 = 文件数**，`model = "<synthetic>"`，四个 token 字段全为 0，message 携带 `diagnostics/container/stop_details/context_management`。若不过滤，每个 session 都会多出约 1 次"幽灵模型调用"，导致调用数与错误数虚高。
> 规则：`model == '<synthetic>'` → 记为 `status=error` 的诊断事件，**不产生 usage**。

---

## 二、§17 第 2 项：session 边界 / subagent / skill 的实际表达

### 2.1 Session 边界：极简，**文件 = session**

- 每条记录都带 `sessionId`（67,829/68,314）；**92 个文件中 0 个含多个 sessionId** → 文件名 UUID 即 sessionId，无需启发式切分。
- v2 §4.1 里"30 分钟 gap 切新 session"的兜底对 Claude Code **不需要**（保留给其他 Agent）。
- 树结构：`uuid` + `parentUuid`（有 parent 51,876 / 无 16,438）+ `leafUuid`（3,683 条，用于分支）。
- 每条记录带 `cwd`、`gitBranch`、`version`、`entrypoint`（各 51,984 条）；缺失 16,330 条**全部是元数据类记录**（`last-prompt`/`custom-title`/`bridge-session` 等），因此**项目归组必须从消息记录取 cwd，不能取首条记录**。

### 2.2 ⚠️ 致命归属问题：`~/.claude/projects` 同时承载两个宿主

```
entrypoint: claude-desktop 49,204 (94.6%)  |  cli 2,780 (5.4%)
```

Claude Desktop 的 local agent mode 与 Claude Code CLI **共用同一套 `~/.claude/projects` 日志格式**，且 Desktop 的 cwd 落在 `~/Library/Application Support/Claude/local-agent-mode-sessions/...`。

> v1/v2 都隐含假设"这个目录 = Claude Code CLI"，**错了 94.6% 的记录来源**。
> 处置：`entrypoint` 必须提升为采集维度，并在 `agents` 表分成两个身份（`claude-code` / `claude-desktop-agent`）或至少支持按 entrypoint 过滤。否则"我今天用 Claude Code 花了多少"这个最基础的问题会给出离谱答案。这也顺带解释了 v1 §15 里 "Qoder database locked" 之外的另一类困惑。

### 2.3 Subagent（子 Agent）：归属与成本都可精确还原

- 侧链记录：`isSidechain=true` 共 **2,484 条**（assistant 1,282 / user 879 / attachment 323），全部带 **`agentId`**（如 `ac4d1b4260ba42381`）。
- 侧链 assistant 记录 **100% 携带独立 usage 与独立 requestId** → 子链 token 可精确归因，与主链不重复计数。
- 本机子链合计 **46.75M tokens（占全量 1.7%）**。
- _spawn 入口是 `Agent` 工具（**不是 v1 假设的 `Task`**）：`input = {description, subagent_type, prompt, run_in_background}`，实测 `subagent_type` 取值如 `general-purpose`、`claude-code-guide`。
- **局限**：日志中未见 `agentId` ↔ 触发它的 `Agent` tool_use.id 的显式外键（侧链首条记录 `parentUuid = null`）。→ `parent_event_id` 需用启发式：按 `agentId` 分组，取组内最早时间戳，匹配同 session 内时间上最近的前序 `Agent` tool_use。此规则需在 fixtures 里锁定，并在 UI 上允许"归属未知"。

### 2.4 Skill：真实激活路径有 **4 条**，只数工具调用会严重低估

| 来源 | 实测计数 | 结构 |
|---|---|---|
| `Skill` 工具调用 | 15 | `input.skill = "anthropic-skills:skill-creator"`（带命名空间） |
| `attachment.invoked_skills` | 1 | `skills[] = {name, path, content}`，`path="userSettings:grill-with-docs"` |
| `isMeta` user 注入 | 多条 | 正文以 `"Base directory for this skill: <path>"` 开头 |
| `<command-name>` 斜杠命令 | 33 | 既含 `/model` `/compact` `/init` `/goal` 等内置命令，也含 `/apple-design:apple-design` `/design:design-system` 等 skill |

> v1 §14 里 "1,923 Skill Calls" 那种预期数字，若 Adapter 只统计 `Skill` 工具（本机 15 次）会低估到几乎为零。**必须以 `invoked_skills` + isMeta 注入 + command-name 三源合并**，且 `path` 里的 `userSettings:` / 插件命名空间用于区分 skill 来源（用户级 / 插件级 / 内置）。

斜杠命令的完整取值（本机）：`/model 16`、`/product-management:product-brainstorming 3`、`/apple-design:apple-design 2`、`/init 2`、`/compact 2`、`/exit 2`、`/goal 2`、`/effort 1`、`/writing-great-skills 1`、`/design:design-system 1`、`/grill-with-docs 1`。

### 2.5 全新能力类型：**hook**（v1/v2 能力枚举完全没有，而它是本机数量最大的能力）

`attachment.type = hook_success` 共 **10,878 条**（远超全部 skill 调用，也超过 Bash 之外的任何工具）：

```
字段: { hookName, hookEvent, toolUseID, content, stdout, stderr, exitCode, command, durationMs }
hookName: PreToolUse:Bash 2763 | PostToolUse:Bash 2718 | PostToolUse:Edit 732 | PreToolUse:Edit 716
          PreToolUse:Read 584 | PostToolUse:Read 584 | Stop 212 | SessionStart:startup 139 ...
hookEvent: PreToolUse 5209 | PostToolUse 5142 | SessionStart 360 | Stop 212
           PostToolUseFailure 83 | SubagentStart 5 | SubagentStop 5
非零 exitCode: 0 条
另有 system/stop_hook_summary 425 条
```

价值：① `durationMs` 让"Agent 慢在哪"能归因到 hook（hook  overhead 是真实成本，v1 §22 提到的 "Tool overhead" 终于有了数据源）；② `PostToolUseFailure` 83 与 `SubagentStart/Stop` 5 是现成的错误与子链信号；③ `hookName` 带 `PreToolUse:Bash` 形式 → 天然可挂到被 hook 的工具事件上。

### 2.6 其他高价值数据源（v1/v2 均未预见）

| attachment / record | 计数 | 用途 |
|---|---|---|
| `total_tokens_reminder` | 6,220 | **上下文占用时间序列**（text 里含 token 数）→ "为什么这么贵"最直接的证据链，v1 §22 第三阶段的落地数据源 |
| `deferred_tools_delta` | 227 | `pendingMcpServers / needsAuthMcpServers / failedMcpServers / addedNames / removedNames` → **doctor 的 MCP 健康数据来源** |
| `mcp_instructions_delta` | 171 | MCP server 指令挂载/卸载 |
| `skill_listing` | 114 | `{names, skillCount, isInitial}` → **`capabilities()` 静态清单**（装了但没用过） |
| `agent_listing_delta` | 44 | 可用 subagent 类型清单 |
| `remote_session_change` | 96 | `{url, commit, pr}` → **session ↔ commit/PR 关联** |
| `edited_text_file` / `file` | 87 / 70 | 文件改动证据（内容层） |
| `plan_mode` / `plan_mode_exit` / `plan_file_reference` | 27/21/14 | 计划模式状态机 + 计划正文 |
| `auto_mode` / `command_permissions` | 67/23 | 权限模式（`permission-mode` 记录另有 209 条） |
| `prompt_snapshot` | 96 | 完整 system prompt（体积大，须归内容层且默认不存） |
| `system/api_error` | 63 | 错误事件 |
| `system/turn_duration` | 46 | 轮次耗时 |
| `system/compact_boundary` | 16 | **证实 v2 §3.3 新增的 `context.compact` 是必要的** |
| `system/away_summary`, `local_command` | 14 / 9 | 辅助 |

MCP 工具调用合计 **981 次**，命名一律 `mcp__<server>__<tool>`（如 `mcp__Claude_Browser__navigate`、`mcp__plugin_build-ios-apps_xcodebuildmcp__tap`）→ `plugin` 与 `mcp` 的区分可从 `mcp__plugin_<x>_` 前缀解析。

### 2.7 `message.user` 必须拆分：真实用户轮次只有 ~1/18

11,861 条 user 记录的形态分布：

```
array:tool_result  11,058 (93.2%)   ← 工具结果，不是用户说话
string:plain          559           ← 真实用户输入
string:other-xml       89
array:text             61
string:local-command   43
string:command-name    33
array:image+text       14+
distinct promptId 合计 559 ≈ 真实用户轮次
```

> 规则：**只有 `string:plain` / 带图片的 user 记录才是 `message.user`**；`array:tool_result` 必须映射为 `tool.end`（或 `tool.result`）事件。否则 Sessions 页面的"用户轮次"和 Timeline 会虚高 18 倍。`userType` 恒为 `external`，不可用于区分。

### 2.8 记录类型白名单（噪声占比 24.6%）

```
assistant 20,043 | attachment 19,506 | user 11,861 | last-prompt 3,683 | bridge-session 2,645
atis-latch 2,568 | custom-title 2,561 | pr-link 1,423 | queue-operation 1,106 | mode 1,010
system 574 | agent-name 496 | file-history-snapshot 285 | permission-mode 209
file-history-delta 200 | frame-link 107 | artifact-autoreact-ledger 20 | artifact-comment-monitor 9 | ai-title 8
```

后 13 类基本是宿主元数据（其中 `pr-link`、`custom-title`/`ai-title`、`mode` 有产品价值：会话标题、PR 关联、模式轨迹）。**Adapter 需显式白名单，未列入者落 `type='unknown'` + 原始 JSON 进 metadata**（v2 §5.3 契约得到正面验证：类型集在 2.1.149→2.1.275 之间已明显漂移，`Agent` 工具名就是证据之一）。

---

## 三、对项目归组（`project_id`）的实测修正

高频 cwd 前 25：

```
11,662  ~/workspaces/cable-info
 6,259  ~/workspaces/passo
 6,001  ~/workspaces/skillbox/.claude/worktrees/pr-3-conflict-resolution-a432e1
 4,905  ~/workspaces/vsce-thrift-support/.claude/worktrees/blissful-goodall-979518
 3,541  ~/workspaces/remote-ssh-pluse/.claude/worktrees/vscode-config-statusbar-issues-dc7f00
 3,210  ~/workspaces/picko/.claude/worktrees/remote-control-74fbf3
 1,450  ~/workspaces/cable-info/.claude/worktrees/app-review-architecture-optimization-227ace
 1,057  ~/workspaces/agentx/.claude/worktrees/tool-optimization-features-0da45f
 1,012  ~/workspaces/skillbox/.claude/worktrees/.../apps/web/src      ← worktree + 子目录
```

实测 25 个高频 cwd 中 **8 个含 `/.claude/worktrees/`**，且存在"worktree + 子目录"双重嵌套；另有 Orca 等第三方工具产生的 `~/orca-workspaces/agentx-albatross` 形态（不在 `.claude/worktrees` 下，无法用固定路径规则识别）。目录名反解结果：32 个项目目录中 6 个已空（见 §一 风险 2）。

> 仅靠 v2 §4.1 的 "git root 优先"**不足以归组**：worktree 的 git root 就是 worktree 自身，会把一个项目炸成 N 个项目。必须叠加：
> 1. 读 `.git` 内的 `gitdir:` 指针，用 **`--git-common-dir` 的父目录**（主仓库根）而非 worktree 根；
> 2. 路径规则兜底：截断 `/.claude/worktrees/<x>`；
> 3. **可配置的项目归并表**（`~/.agentlens/projects.toml`：正则/前缀 → 规范名），处理 Orca 这类外部工具。
>
> 这一条升级后，v1 §19 想要的"同一项目被多 Agent 同时开发"才真正成立——实测本项目历史上确实横跨 4 个仓库副本形态。

---

## 四、对方案的净结论

| v2 原判断 | 实测结果 | 处置 |
|---|---|---|
| Claude Code 剥离 usage，历史 token 偏低 | **证伪**：100% 保留至 >30d | 删除"字符估算降级"作为主设计；`usage_source` 保留 |
| 成本可由日志直读 | 无 `costUSD`/`totalTokens` 字段 | Pricing 必须自算；缺价 → `NULL` + doctor |
| 主要精度风险是采集不到 | **真正的精度风险是多 block 重复计数（+87%）** | 新增 `requestId` 去重为 event-model 一等规则 |
| 历史数据完整 | 6/32 项目目录 JSONL 已被清理 | UI 需明示覆盖不完整；`history.jsonl` 作补救源 |
| 能力类型 = tool/skill/mcp/plugin/connector/command/subagent | **漏了 hook（本机最大能力类别，10,878 次）** | 能力枚举加 `hook`，含 duration/exitCode |
| subagent 由 `Task` 工具触发 | 工具名为 `Agent`；有 `agentId` 但无显式父外键 | 更名 + 启发式归属 + fixtures 锁定 |
| skill = `Skill` 工具调用 | 4 条来源，工具调用仅 15 次 | 三源合并，命名空间区分用户级/插件级 |
| `~/.claude/projects` = Claude Code CLI | **94.6% 记录来自 Claude Desktop** | `entrypoint` 提升为维度/身份 |
| git root 足够归组项目 | worktree 使 git root 本身分裂 | 加 common-dir 解析 + 归并表 |
| 需要 `context.compact` 事件 | 确认存在 `compact_boundary` | 保留 |
| Adapter 需 unknown 兜底 | 19 种记录类型、跨 2.1.x 已漂移 | 保留并加白名单 fixtures |

---

## 五、ccusage 对账（§17 第 1 项）—— 口径已确认一致

工具：`ccusage@20.0.23`，本地装于 `docs/research/node_modules`（仅用于对账，不进产品依赖）。
基线：`ccusage claude daily -j -b -O -z UTC --since 20260822 --until 20260921` → `ccusage-baseline.json`
比对：`node reconcile-ccusage.mjs`（输出存 `reconcile-result.txt`），同窗口 / 同 UTC / 排除 `<synthetic>`。
窗口内 assistant+usage 记录 11,260 条 / 5 个模型 / 缺 requestId 2 条。

| 口径 | input | output | cache_read | cache_create | 合计 |
|---|---|---|---|---|---|
| **ccusage 基线** | 18K | 4.18M | 2.022B | 24.49M | **2.051B** |
| A naive 逐条求和 | 28K | 8.96M | 3.629B | 56.95M | 3.695B |
| **B requestId 取 max** | 18K | 4.18M | 2.022B | 24.49M | **2.051B** |
| C requestId 取首块 | 18K | 4.11M | 2.022B | 24.49M | 2.051B |
| D message.id 取 max | 15K | 4.18M | 2.022B | 24.49M | 2.051B |

```
相对 ccusage 偏差
A naive        input +60.5%  output +114.4%  cache_read +79.5%  cache_create +132.5%  总量 +80.2%
B reqId-max    input   0.0%  output     0.0%  cache_read    0.0%  cache_create    0.0%  总量   0.0%
C reqId-first  全 0.0%，仅 output -1.5%
D msgId-max    全 0.0%，仅 input  -16.2%
```

**逐日比对 15 天，B / ccusage 全部 1.00x**（naive 在 1.65x–2.62x 之间波动）。

### 判定

1. ✅ **口径 B（`GROUP BY requestId` → 各字段取 `MAX`）就是正确且与社区一致的口径，四个字段零偏差。M1 的对账门槛通过。**
2. **不能用 `message.id` 分组**：D 的 input 少 16.2%（组数 5,944 vs requestId 5,945）→ **一个 message.id 可横跨多个 requestId**（重试/续写），合并会折叠掉不同请求的 input。分组键必须是 `requestId`。
3. **必须取 max 而非首块**：C 的 output 少 1.5% → `output_tokens` 在同一 requestId 的各 block 间是**累积值**。
4. `<synthetic>` token 全 0，**不影响 token 对账**，但会污染"调用次数/错误数/session 事件数"，排除规则依然必要。
5. 全量复核（`--all`）：B = 2.700B，与 §一 独立普查一致；naive/B = 1.87×。

### 副产品：宿主拆分的金额意义

```
全量历史(口径 B): claude-desktop 9,471 requests → 2.613B tokens  96.8%
                 cli               825 requests → 86.60M tokens   3.2%
                 → 不拆宿主时 "Claude Code CLI 用量" 被高估 31.2×
30 天窗口:        claude-desktop 5,943 requests → 2.051B (100.0%)
                 cli               2 requests   →    6K (  0.0%)
```

> `entrypoint` 的**记录数占比（94.6%/5.4%）与 token 占比（96.8%/3.2%）不是一回事**（CLI 侧记录更短）。近 30 天本机 CLI 侧几乎为零。"哪个宿主花的钱"必须默认切分。

### 对账锚点

ccusage 该窗口成本 **$667.96**（`-O` 离线缓存价表）→ M3 的 Pricing Engine 必须能在同窗口产出可比数字，这本身是极好的回归锚点。

---

## 六、⚠️ 对方案最大的冲击：ccusage 的能力边界远超方案假设

对账的意外发现，直接改写 v2 §1 的差异化主张。实测 `ccusage@20.0.23`：

1. **它已经不是 per-tool 工具。** 顶层 `ccusage daily` 输出含 `Agent` 列（`All` + 逐 Agent 行），子命令覆盖
   `claude / codex / opencode / amp / droid / codebuff / hermes / pi / goose / kilo / copilot / gemini / antigravity / kimi / qwen / openclaw / grok / zcode`
   —— **18 个 Agent CLI，比 v1 计划的 5 个还多**。（本机只有 Claude 有数据，故日报只出现一行，但命令集是现成的。）
2. **已有 per-project 报表**：`ccusage claude daily -i` 按 `Project: <名>` 分组输出 token 与成本。
   但实测**每个 worktree 单列为一个项目**（`topics-…`/`control-…`/`issues-…`/`perform…` 全是 worktree 名），且该维度是 **Agent 内**的（顶层 `daily` 有 Agent 列、无 Project 列）。
3. 还有 `--mode auto|calculate|display`、`--debug` 价格差异、`statusline`（hook 集成）、`blocks`（计费块）、`--timezone`、配置文件、项目别名。

### 收缩后仍然成立的差异

| 能力 | ccusage | AgentLens |
|---|---|---|
| 跨 Agent token/cost 日报 | ✅ 已有（18 CLI） | **无优势** |
| 单 Agent 内 per-project | ✅ 已有 | 仅 worktree 归一化更强 |
| **跨 Agent × 同一 canonical project** | ❌（两维度在不同命令里） | ✅ |
| **Session 粒度 / Timeline / 内容** | ❌ 完全没有（只有日报数字） | ✅ |
| **Capability（tool/skill/mcp/hook/subagent/plugin）** | ❌ 完全没有 | ✅ |
| **宿主区分 desktop vs cli** | ❌ **没有**，实测把 96.8% 的 Desktop 用量记作 Claude Code | ✅ |
| 去重口径正确性 | ✅ 与实测一致 | 复用为 CI 锚点，非竞争点 |
| Web UI / 可查询 SQLite / 导出 | ❌（CLI 文本报表为主） | ✅ |

### 结论

> v2 §1 写的「ccusage 是 per-tool、我们是 cross-tool」**是错的，必须撤回**。
> 立足点收缩为三件事，并且整个产品的重心应当压到这三件上：
> **① Session / Timeline —— 一次会话里到底发生了什么**
> **② Capability —— 哪个 skill / MCP / hook / 子 Agent 消耗了什么**
> **③ 规范化实体 —— canonical project 跨 Agent 归组、host 拆分、subagent 归属**
>
> Token/Cost 日报是 ccusage 的强势区：我们**必须做**（否则无法自证采集正确），但**不作为卖点**，并把"与 ccusage 对账一致"转成 CI 上的正确性证据。

