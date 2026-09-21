# 实测报告 · subagent 启发式归属的准确率（M1 ⑤）

- 日期：2026-09-21　机器：darwin/arm64　样本：本机 `~/.claude/projects` 全量 JSONL（无抽样，全普查）
- 脚本：`docs/research/probe-subagent-attribution.mjs`（只读；`node docs/research/probe-subagent-attribution.mjs [--verbose]`）
- 隐私：本文只含计数、形态、比例与 sha256 截断的标识符。**没有任何**消息正文、prompt、工具入参、家目录真实路径。
- 安全：只读 `*.jsonl` 与 `*.meta.json`；**未**打开任何 `.db`/`.sqlite`（WAL 边车事故的教训写进了脚本头）；被拒绝的目录读会记为 `blocked`，与"不存在"严格区分。本次 `blocked = none`。
  - 运行时打印的 `ExperimentalWarning: SQLite is an experimental feature` **不是**开了数据库：脚本只 `import` 了适配器源码，而 `@agentlens/collector` 的 barrel 在模块顶层 `import { DatabaseSync } from 'node:sqlite'`；`new DatabaseSync(...)` 只存在于函数体内，探针从未调用（`sqlite-source.ts:59`、`storage/db.ts:13`）。全进程只用了 `readFile`/`readdir`/`stat`，无任何写、删、改名、chmod 调用。

## 0. 结论一句话

`§4.4 行 8` 的前提**不成立**：日志里**确实存在** `agentId ↔ tool_use.id` 外键，只是它不在侧链记录上，而在**父链那条 `tool_result` 上**（`tool_use_id` + `toolUseResult.agentId` 同记录成对出现），本机 **36/36** 侧链命中。启发式在它真正会运行的场景里 36/36 全对，但在**当前落盘形态下它根本不运行**（`subagent.start` 的 `parent_event_id` 36/36 为 NULL）。因此正确处置不是"调启发式"，而是**用外键，启发式降为兜底，兜不住时 NULL**。

## 1. 启发式到底在测什么（读代码，不猜）

`adapters/claude-code/src/state.ts::linkSidechain()` 的真实规则：同一 `sessionId` 的 `Agent`/`Task` 候选里，取满足 `rawSeq <= 当前 && timestamp <= 当前` 且 `rawSeq` 最大者；无候选 → `parent_eventId = null`。使用的证据只有**时间戳 + 文件内序号**，没有任何 id 比对。`sidechain.sessionId` 与 `agentEntries` 都活在**按 `source.id` 分片**的 `ScanState` 里（`stateFor(ctx.source.id)`）——这一条是下面 §3 的关键。

探针通过 `import` 直接调用真实的 `discover()` / `parse()` / `normalize()`，`parent_event_id` 全部出自真实代码；本地只写"证据采集"（外键、时间窗），不复述规则。每轮运行各自维护 `event_id → tool_use.id` 反查表（`deriveEventId` 掺了 `sourceId`+`rawSeq`，跨轮比较 id 无意义），比对一律在 `tool_use.id` 层做；反查失败会打成 `unknown:<hash>`，该行**不计入准确率**而不是蒙一次。

## 2. 真实形态：侧链是**独立文件**，不在 session 文件里

| 观察 | 数值 |
|---|---|
| `discover()` 发现的源 | 93 = 56 session 文件 + 36 侧链文件 + `history.jsonl` |
| 侧链文件路径形态 | `<project>/<session>/subagents/agent-<agentId>.jsonl` |
| 侧链 sidecar | `<…>/subagents/agent-<agentId>.meta.json`，36/36 存在 |
| session 文件内 `isSidechain=true` 记录 | **0**（"内联侧链"形态在本机版本已不存在） |
| 侧链文件内记录总数 | **2,484**，其中 `isSidechain=true` 2,484、带 `agentId` 2,484（**100%**；探针直接打印此行） |
| 侧链文件是否保留父 `sessionId` | 36/36 保留（session 归属没坏，坏的只是**链接**） |
| `Agent`/`Task` 调用 | 42 个（`run_in_background=true` 6 个）；39 个被某条外键点名，3 个既无侧链文件也无外键（**3 个全是后台任务**） |
| 一个 spawn 对多条链 / 一个 agentId 对多条外键 | 0 / 0（本机 1:1，resume 复用未出现） |

> 顺带修正 §2.3 的读法：`docs/research/claude-code.md` 记的"2,484 条侧链记录 / 92 个文件"里的 2,484 正是这 36 个**独立文件**的记录数（当时递归 glob 把它们和 session 文件混在一起数了）。"一个文件 = 一个 session"这条结论没受影响，但**"侧链和父链在同一个源里"没有成立**。

## 3. 可用证据（从强到弱）

1. **内联外键（最强，本机全覆盖）**：父链那条 `type=user` 记录里，`message.content[].tool_result.tool_use_id` 就是那次 `Agent` 调用的 id，同记录 `toolUseResult.agentId` 就是它启动的侧链 → `agentId → tool_use.id` 的**真外键**。命中 **36/36**。`normalize.ts` 早已在这条记录上算出 `subagent.end`，之前只是**没去看那个 `tool_use_id`**。
2. **`meta.json.toolUseId`**：23/36 侧链有（新版才写；`agentType` 36/36 有）。作为 discover 层的补充信号有价值，但覆盖不全，不能当唯一依据。
3. **时间窗包含**（侧链首条 ts 落在 `[Agent 调用 ts, 其 tool_result ts]`）：30/36 唯一命中；6/36 有 ≥2 个窗口同时开着（最极端一条：7 个前序调用、3 个窗口同时开）。
4. `SubagentStart`/`SubagentStop` hook：本次样本里 **0 条**带 `toolUseID`，不构成可用信号（§2.5 记的 5 条与父链接无关）。

## 4. 准确率

N = **36** 条侧链（本机全体，超过任务要求的 20，且无抽样偏差）。人工核对＝把 §3.1 的外键与 §3.3 的时间窗当作**独立证据**，去比启发式给出的父。

| 场景 | 启发式产出 | 与外键一致 | 与外键矛盾 | 无法判定 |
|---|---|---|---|---|
| **Mode A｜部署形态**（每文件一个源，真实 `discover`+`normalize`） | `subagent.start` 36/36 = **NULL**（从未命中） | — | — | 36/36 |
| **Mode A｜`subagent.end`**（修复前） | 36/36 NULL | 0 | 0 | 36 |
| **Mode A｜`subagent.end`**（修复后，见 §6） | 36/36 外键精确 | **36** | **0** | 0 |
| **Mode B｜反事实内联形态**（父文件与其侧链按**真实时间戳**合成一个流，启发式第一次有候选可用） | 36/36 命中 | **36/36 = 100%** | **0** | 0 |

Mode B 就是这条规则被设计出来时服务的形态（旧版本内联侧链，也是 fixture 的形态）。**它没有算错过**：0 错 / 36 对，按 rule of three，95% 置信下错误率上界 ≈ **8.3%**（≤3/36）。但注意这 8.3% 全部来自"平行子任务"这一类：

- (a) 时间窗唯一确定：**30/36 = 83.3%**，且 30/30 与外键一致；
- (b) **两个以上 `Agent` 调用窗口重叠：6/36 = 16.7%** —— 启发式在这 6 条上**恰好也对**（本机侧链首条记录总在其真实父之后、下一条 spawn 之前），但这是**顺序侥幸**：这类样本里时间窗已无法区分父，规则拿不出任何独立证据；
- (c) 无前序 `Agent` 调用：**0/36**；(d) 有前序但窗口都不含首条时间戳：**0/36**（未观测到后台任务造成 (d)，因为后台 spawn 干脆没有侧链文件）。

**"跨父重叠并不罕见"这条被证实**：42 次 spawn 里 6 次显式 `run_in_background`，16.7% 的侧链出生在重叠窗口中。所以"启发式 100% 准确"不能外推成"启发式安全"。

## 5. 每侧链明细（`--verbose` 输出，标识符已 sha256 截断）

`FK` = 外键给出的父（`tool_use.id` 哈希）；`start(部署)` = 真实 `normalize` 在现网形态下给出的 `subagent.start.parent_event_id`；`end(修复后)` = 同一次运行 `subagent.end` 的父；`start(内联)` = Mode B 反事实下的启发式产出。三列一致即"信号互相印证"。

| # | chain file | agentId | recs | FK (tool_use) | meta.json FK | start parent (deployed) | end parent (deployed) | start parent (inline stream) | window class | signals agree |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | dfd088ddbb | e7c6062c | 34 | 7ac12a | yes | NULL | 7ac12a | 7ac12a | a unique window | yes |
| 2 | 4361e52156 | be05a441 | 46 | 23e053 | yes | NULL | 23e053 | 23e053 | a unique window | yes |
| 3 | 1c9c032fbe | c534c901 | 64 | 5b0019 | yes | NULL | 5b0019 | 5b0019 | a unique window | yes |
| 4 | c891104d50 | 5f4b8a59 | 104 | 2325f6 | yes | NULL | 2325f6 | 2325f6 | a unique window | yes |
| 5 | 7d9cb97b96 | 17791a6c | 192 | a57dcb | yes | NULL | a57dcb | a57dcb | a unique window | yes |
| 6 | a559309fac | 4a41c7d5 | 42 | 5cb190 | yes | NULL | 5cb190 | 5cb190 | a unique window | yes |
| 7 | 96809bd79d | c70b3283 | 103 | e8e17f | yes | NULL | e8e17f | e8e17f | a unique window | yes |
| 8 | 59c263d354 | ae97a356 | 3 | 5293ba | yes | NULL | 5293ba | 5293ba | a unique window | yes |
| 9 | 1de05b1df6 | 13330418 | 23 | 59b30f | yes | NULL | 59b30f | 59b30f | a unique window | yes |
| 10 | 387fb7bfc4 | f957c326 | 60 | 1a20a9 | yes | NULL | 1a20a9 | 1a20a9 | b overlapping windows | yes |
| 11 | 5d285c159a | 5ba5cca0 | 34 | 768b02 | yes | NULL | 768b02 | 768b02 | a unique window | yes |
| 12 | 81b34a1fbf | 42b4dab1 | 10 | bca04f | yes | NULL | bca04f | bca04f | a unique window | yes |
| 13 | b1d9ccf61e | 2618b218 | 16 | e32595 | no | NULL | e32595 | e32595 | a unique window | yes |
| 14 | 695b1c1120 | 7332b678 | 90 | 053876 | yes | NULL | 053876 | 053876 | a unique window | yes |
| 15 | a8e8fd526b | 0ce48613 | 101 | ada664 | yes | NULL | ada664 | ada664 | a unique window | yes |
| 16 | fb2a42abe4 | 3f50de9f | 69 | d099b9 | no | NULL | d099b9 | d099b9 | b overlapping windows | yes |
| 17 | ba4e9b2db4 | 533db0d8 | 37 | ae792a | no | NULL | ae792a | ae792a | a unique window | yes |
| 18 | ec24ababee | 559fecef | 18 | ba10e7 | no | NULL | ba10e7 | ba10e7 | a unique window | yes |
| 19 | c758ebb8c3 | 199f99c0 | 79 | 79d9a7 | no | NULL | 79d9a7 | 79d9a7 | a unique window | yes |
| 20 | 5b1000a834 | ffe2f6da | 60 | a66cd6 | no | NULL | a66cd6 | a66cd6 | b overlapping windows | yes |
| 21 | 571640a88e | d9b42148 | 98 | d53b9f | no | NULL | d53b9f | d53b9f | a unique window | yes |
| 22 | 057908d621 | 75edcdd0 | 24 | fcc592 | no | NULL | fcc592 | fcc592 | a unique window | yes |
| 23 | 5ba2d23faa | 187491c8 | 98 | 3cc0c7 | no | NULL | 3cc0c7 | 3cc0c7 | a unique window | yes |
| 24 | 9cab44a3f5 | 5cfcf2d9 | 112 | 47db54 | no | NULL | 47db54 | 47db54 | a unique window | yes |
| 25 | e757263453 | 166c59a9 | 102 | b0a43e | no | NULL | b0a43e | b0a43e | b overlapping windows | yes |
| 26 | 25624d4129 | b70fccd6 | 56 | 42c461 | no | NULL | 42c461 | 42c461 | a unique window | yes |
| 27 | a3668c2736 | 02a904b5 | 73 | 87cfc8 | no | NULL | 87cfc8 | 87cfc8 | a unique window | yes |
| 28 | 95f21ff2ff | 018ebe9e | 69 | 3ab11c | yes | NULL | 3ab11c | 3ab11c | b overlapping windows | yes |
| 29 | bdeb57e1d6 | 2c9bd1e0 | 50 | dd09cd | yes | NULL | dd09cd | dd09cd | a unique window | yes |
| 30 | ad0dedbfe9 | 04370e9e | 92 | 1362d0 | yes | NULL | 1362d0 | 1362d0 | a unique window | yes |
| 31 | 00b05d9a24 | e39a8afa | 76 | 1d658a | yes | NULL | 1d658a | 1d658a | a unique window | yes |
| 32 | d63189bd6e | f78127a1 | 208 | 920d61 | yes | NULL | 920d61 | 920d61 | a unique window | yes |
| 33 | fc2dff6a0e | 8420e083 | 47 | 6cf665 | yes | NULL | 6cf665 | 6cf665 | b overlapping windows | yes |
| 34 | 8c56810a10 | 556c8287 | 97 | 61eb83 | yes | NULL | 61eb83 | 61eb83 | a unique window | yes |
| 35 | a03881db08 | 325cbdd6 | 20 | 819bd6 | yes | NULL | 819bd6 | 819bd6 | a unique window | yes |
| 36 | e927fb859f | fa50ab4a | 77 | bedcc8 | yes | NULL | bedcc8 | bedcc8 | a unique window | yes |

**逐行核对小结**：36/36 的"外键父"与"内联流启发式父"一致（`signals agree` 无一行 `NO`）；`start(部署)` 列 36 行全 NULL 是现网形态的结构性后果（§7），不是"猜错"；meta.json 缺外键的 13 行（#13、#16–27）里，内联外键与时间窗依然一致，说明 §3.1 比 §3.2 更可靠。表内 `recs` 最小的两行（#8=3、#12=10）与最大的 #32=208 都被同一条规则正确归属，长度不影响结论。

## 6. 已改动的代码（证据驱动，仅限链接部分）

改动理由就是 §3.1/§4：一条**证明**（外键）压过一条**猜测**（最近前序），且现网 `subagent.end` 在 36/36 上本可以精确、却写着 NULL。

- `adapters/claude-code/src/state.ts`
  - `SidechainLink.parentSource: 'heuristic' | 'foreign-key' | null`；
  - 新增 `confirmSidechainParent()`：用外键升级已存链接（`startEventId` 可为 null，覆盖"侧链在另一个源里、本文件从未发出 `subagent.start`"这一现网主流情形）；
  - `ToolCallRef` 增可选 `subagentType`（取自 `input.subagent_type`，即能力名，不是正文）。
- `adapters/claude-code/src/normalize.ts`
  - `sidechainClose(s, resultToolUseIds)`：先 `state.toolCall(tool_use_id)`，命中 `capability.type === 'subagent'` 即认定外键；否则退回 `state.sidechain()`（启发式结果）；
  - `subagent.start` / `subagent.end` metadata 统一带 `parent_source`（`foreign-key` / `heuristic` / `none`），`parent_heuristic` 变为"真的是猜的"才为 true；
  - `PARSER_VERSION` 1 → 2（§5.3：映射规则变了必须触发全量重扫，否则旧 `parent_event_id` 会留着 NULL）。
- 新 fixture + 测试：
  - `agent-subagent-fk-override.jsonl`：启发式只能猜中较早的 `tu-fk-wrong`，而 `tu-fk-true` 的 result 用外键证明父是后者 → 断言 `start.parent_source='heuristic'`、`end.parent_source='foreign-key'` 且 `end.parentEventId === 真实 spawn.id`（钉住"证明优先于猜测"的优先级）；
  - `agent-subagent-fk-separate-source.jsonl`：现网形态（侧链记录在别的源，本流没有 `subagent.start`）→ 断言 `subagent.end` 仍精确挂上；
  - `agent-subagent-chain.jsonl` 补断言（外键与启发式同源、结论一致），孤儿链用例补 `parent_source='none'`。
- 结果：`adapters/claude-code` 74 tests 全绿，22 个既有快照**一字未改**（外键与启发式在 fixture 里同解，故无回归）；全库 `vitest run` 仅 `apps/cli/test/doctor*.e2e`/`commands.e2e` 有失败，内容是 `detect` 的 temp-root 路径与 capability 目录文案（他人在飞的 `apps/cli` 改动），与本改动无关。

## 7. 仍然剩下的不确定性（诚实边界）

`subagent.start` 在现网形态下**依旧是 36/36 NULL**。原因不在启发式的排序，而在 `ScanState` **按 source 分片**：父文件登记的 `agentEntries` 侧链文件看不见。要在 `subagent.start` 上也精确，需要下面任一改动，都**超出本次授权范围**（会动到状态生命周期/发现层，且 `packages/**`、`apps/**` 正被其他 agent 修改），故只记录不实施：

1. **跨源共享"会话级链接台账"**（把 `agentEntries` + `sidechains` 从 `stateFor(source.id)` 挪到模块级、按 `sessionId` 键）：session 文件路径排序天然先于其 `<session>/subagents/` 目录（`'.'(46) < '/'(47)`），全量扫描时父调用先登记，`subagent.start` 即可拿到外键；风险：只扫尾一个源（watch 增量）时台账可能为空 → 退回 NULL（**保守方向正确，不会猜错**）；需要重扫安全（§4.2）单测背书。
2. **在 `discover()` 里读 `agent-<agentId>.meta.json`**（23/36 带 `toolUseId`）：能把侧链源显式标注其父 `tool_use_id`，覆盖率不如方案 1 且随版本漂移（13/36 缺字段）。
3. UI/Timeline 兜底：侧链事件带 `metadata.agent_id` 且 36/36 与父同 `session_id`，可先按 `(session_id, agent_id)` 聚成一束，挂到 `subagent.end` 的父下——**这条现在就能用**，因为 `subagent.end` 已精确。

## 8. doctor 应该怎么报（给 M3 的硬要求）

现状 `apps/cli/src/commands/doctor.ts::renderSubagentLinkage()` 只数 `parent_event_id IS NULL`，措辞是"无外键可依"——这句话现在**既过时又不准确**。请按 `metadata.parent_source` 拆成三档并报，缺任一档都要说"没有该档数据"而不是当 0：

```
claude-code: subagent events 72 · 外键证明 36 (50.0%) · 启发式猜测 0 (0.0%) · 归属未知 36 (50.0%)
  → 归属未知的 36 条全是 subagent.start：侧链记录与父调用不在同一个源（§4.4 行 8 的真实失败形态）
  → 这些 token 与成本照常计数，只有时间线树的位置未知
  → 本机测得：外键可用率 36/36，启发式在有候选时 36/36 对，16.7% 侧链生于重叠窗口（rule-of-three 上界 8.3%）
     脚本 docs/research/probe-subagent-attribution.mjs
```

即：**"猜的"必须和"确证的"和"不知道的"三者分列**，`heuristic` 与 `none` 都要计入 §11 的健康度告警，任何一档都不得为了"树看起来完整"而补一个看起来合理的父。

## 9. 复现

```bash
node docs/research/probe-subagent-attribution.mjs            # 汇总
node docs/research/probe-subagent-attribution.mjs --verbose   # 每侧链一行（哈希）
./node_modules/.bin/vitest run adapters/claude-code           # 链接规则回归
```

本机数字（93 源 = 56 session + 36 侧链 + `history.jsonl`、36 侧链、42 spawn、2,484 侧链记录、36/36 外键、30/6/0/0 时间窗分类）已于改码后重跑核验，两次输出的逐行表**完全一致**；换机器请重跑而不是沿用本文数字。
