# AgentLens · 方案 v2

> 定位不变：**The Activity Monitor for AI Agents** —— 零侵入发现本机 Agent，读取它们已有的本地日志，统一成事件，回答"这台机器上的 Agent 到底干了什么、花了多少、花在哪"。
>
> 本文档取代 `plan.md` 作为实施依据。`plan.md` 保留为原始思路存档。
> v2 相对 v1 的改动集中在：事件分层、确定性 ID 与幂等、Adapter 契约（含格式漂移）、Pricing 外部依赖、隐私开关、以及**优先级重排**（Project 视图与 Session Timeline 提前，Token/Cost 降为及格线）。
>
> **v2.1（2026-09-21）：已按 `docs/research/claude-code.md` 的实测修订。** 实测样本 92 个 JSONL / 68,314 条记录，推翻了 v2 关于 usage 剥离的假设，并新增三条会导致数字根本性错误的规则（`requestId` 去重、`entrypoint` 身份拆分、worktree 项目归组）。
> **v2.2：ccusage 对账通过（口径四字段 0.0% 偏差），同时据此收缩了 §1 的差异化主张** —— ccusage 已覆盖 18 个 Agent CLI 并有 per-project 报表，重心因此移到 Session / Capability / 规范化实体三件事。被修订处均标注「实测」。
> **v2.3（2026-09-21）：实测第二轮见 §18。** Codex / Qoder / OpenCode / WorkBuddy 的测量证伪了 §3.1 的「去重是全局不变量」、§4.1 的「一文件一 session」与 §8 的「日志里没有成本字段」三条，并发现只读打开 WAL 模式的第三方库会产生写入副作用。M2 的 Schema 第二轮修订因此提前，落地清单在 §18 末尾。

---

## 0. 名称

v1 倾向 `AgentScope`，但该名称已被阿里开源的多 Agent 框架占用（GitHub 高星），发布后会有检索与商标冲突成本。

**决定：产品名 `AgentLens`，CLI 命令 `agentlens`（保留短别名 `agl`），仓库名已是 `agent-lens`，无需改动。**

---

## 1. 产品边界（第一性原理）

```
Observe what already happened.   ← 我们做这个
Instrument what is about to happen.  ← Langfuse / Phoenix 做这个
```

### 明确不做（MVP 及之后相当一段时间）

| 不做 | 原因 |
|---|---|
| Evaluation / Dataset / Prompt 管理 | 属于 Langfuse 领域，且需要 SDK 埋点，违背零侵入前提 |
| 要求用户安装 SDK / 配置上报 Key | 直接摧毁"一条命令启动"的体验 |
| Replay（录像式回放） | 依赖内容层全量留存 + 时序还原，成本高、验证晚 |
| Team / Cloud / 多机同步 | Schema 未冻结前做分布式是负债 |
| GPU / 电力 / 碳排放成本 | 数据源不可得，属于叙事而非功能 |
| Adapter 作为 npm 插件市场分发 | 等 Adapter 数量 > 5 且 Schema 冻结后再设计边界 |
| PostgreSQL / ClickHouse / Redis / OTel Collector | 单机 SQLite 足够，过早引入运维复杂度 |

### 差异化主张（实测修正后，必须守住）

> ⚠️ **v2 初稿这里写错了。** 原文称"ccusage 是 per-tool、我们是 cross-tool"。实测 `ccusage@20.0.23` 反驳了它：顶层 `ccusage daily` 已跨 **18 个 Agent CLI** 聚合，且 `claude daily -i` 已有 per-project 成本报表。证据见 `docs/research/claude-code.md` §六。

因此主张收缩为三条，且**整个产品的重心压在这三条上**：

1. **Session / Timeline**：一次会话里到底发生了什么。ccusage 完全没有会话粒度，只有日报数字。
2. **Capability 维度**：哪个 skill / MCP / **hook** / 子 Agent 消耗了什么。ccusage 完全没有能力维度（实测本机 10,878 次 hook 触发、981 次 MCP 调用，在它的世界里不存在）。
3. **规范化实体**：跨 Agent 归到同一 canonical project（含 worktree 合并）、**宿主拆分（desktop vs cli）**、subagent 成本归属。ccusage 在这三点上都是错的或空的——实测它把 96.8% 的 Claude Desktop 用量记在 Claude Code 名下，且每个 worktree 单列为一个项目。

> **Token/Cost 日报是 ccusage 的强势区，不是我们的卖点。** 但必须做（否则无法自证采集正确），并且要把"与 ccusage 同窗口对账零偏差"变成 CI 上的正确性证据 —— 我们已经用实测拿到这个结果（`docs/research/claude-code.md` §五）。

---

## 1.5 实测带来的三处结构性变更（优先读）

`docs/research/claude-code.md` 的结论，三条都影响正确性而非体验：

1. **聚合口径必须是"按请求去重"**。一次 API 响应会按 content block 拆成多条记录并重复携带同一份 usage（本机 6,883/10,330 个请求是多 block）。逐条求和使 token **虚高 1.87×**。`request_id` 因此成为 `events` 的一等列，去重规则下沉到 `event-model`，不允许各 Adapter 自行处理。
2. **`entrypoint` 是身份维度，不是 metadata**。`~/.claude/projects` 里 **94.6% 的记录来自 Claude Desktop 的 local agent mode**，只有 5.4% 是 CLI，两者共用同一套日志格式。不拆分的话"我今天用 Claude Code 花了多少"必然给出离谱答案。
3. **能力枚举漏了 hook**。实测 hook 触发 **10,878 次**，是本机数量最大的能力类别（远超 skill 调用），且自带 `durationMs` / `exitCode` —— 这正是 v1 §22 想要的 "Tool overhead" 的唯一数据源。

另外两条降级/升级：
- v2 §4.4 假设的「Claude Code 剥离 usage」**不成立**（100% 保留至 >30 天），"字符数降级估算"从主设计降为兜底。
- 真正的历史缺口来自**上游文件保留策略**：本机 32 个项目目录中 6 个的 JSONL 已被清空。所以"扫到了全部历史"这个前提不成立，UI 必须明示覆盖度。

**4. 竞品边界修正（对账时的意外发现）。** `ccusage@20.0.23` 已跨 18 个 Agent CLI 聚合、且有 Agent 内的 per-project 成本报表。所以"跨 Agent 统计"和"Project 视图"都不再是独占卖点 —— §1 的主张已据此收缩，重心转到 Session/Capability/规范化实体三件事上。详见 `docs/research/claude-code.md` §六。

**对账结果（已完成）**：口径 B（按 `requestId` 分组取 max）与 ccusage 在同窗口 **四个字段偏差均为 0.0%**，逐日 15 天全部 1.00x。naive 逐条求和为 **+80.2%**。分组键必须用 `requestId` 而非 `message.id`（后者会让 input 少 16.2%），且必须取 max 而非首块（`output_tokens` 是累积值）。证据：`docs/research/reconcile-result.txt`。

---

## 2. 核心数据关系

```
Machine
 └── Agent (claude-code / codex / qoder / opencode / workbuddy / ...)
      └── Host (实测必要：claude-code CLI 与 claude-desktop local-agent-mode 共用一套日志)
           └── Source (一个日志文件 / 一个 SQLite 表)
                └── Session
                     ├── Project (由 canonical repo root 归组，跨 Agent/宿主共享)
                     ├── Model / Provider
                     └── Generation (request_id 去重单位) ── Event
                            ├── Metric（指标：token、时长、状态）  ← 统计只扫这层
                            └── Payload（内容：消息体、工具输入输出）← 可选留存
                                  Event.capability → {type, name}   ← tool|skill|mcp|plugin|connector|command|subagent|hook
```

**关键：Project 不属于 Agent，Project 是跨 Agent 的一等公民。** 这是 v1 结构图里被埋没、但产品价值最高的一点。

---

## 3. 事件模型（v2 最重要的一处修正）

v1 把 token、cost 和消息内容暗示放在同一张 `events` 表。这会让统计查询扫过几十 GB 文本，也让"不想存内容"的用户无路可走。v2 强制分层：

### 3.1 指标层 `events`（永远采集）

分析型表，**刻意不做范式化**，允许 JSON metadata。

```
events
─────────────────────────────────────────────
id                TEXT PK   -- 确定性 fingerprint，见 §4
schema_version    INTEGER   -- 本 schema 版本
agent_id          TEXT      -- 'claude-code'
host_id           TEXT      -- 实测：同一 Agent 可有多个宿主（'claude-code' | 'claude-desktop'）
source_id         TEXT      -- FK sources
session_id        TEXT      -- FK sessions
project_id        TEXT      -- FK projects
parent_event_id   TEXT      -- subagent / 嵌套调用树 / hook → 被 hook 的工具
request_id        TEXT      -- 实测：token 去重键（一次 API 响应共享），缺失时回退 event id
timestamp         INTEGER   -- ms epoch
ingested_at       INTEGER

type              TEXT      -- 见 §3.3
subtype           TEXT

model_rowid       INTEGER   -- FK models（provider + name + tier）

-- usage（原始 token，不落 cost）
input_tokens            INTEGER
output_tokens           INTEGER
cache_read_tokens       INTEGER
cache_write_tokens      INTEGER
reasoning_tokens        INTEGER
usage_source      TEXT    -- 'reported' | 'estimated' | 'missing'

-- capability
capability_type   TEXT    -- tool|skill|mcp|plugin|connector|command|subagent|hook  ← hook 为实测新增
capability_name   TEXT
capability_provider TEXT  -- MCP server 名 / hook 的 'PreToolUse:Bash' / skill 的 'userSettings'

duration_ms       INTEGER
status            TEXT    -- ok|error|unknown
error_fingerprint TEXT    -- 归并同类错误

-- 溯源
raw_seq           INTEGER   -- 源内行号/记录序
raw_offset        INTEGER   -- 字节偏移
content_ref       TEXT      -- 指向 payloads，可为 NULL
metadata          TEXT      -- JSON
```

索引（只建这四条，其余交给扫描）：

```sql
CREATE INDEX idx_events_ts      ON events(timestamp);
CREATE INDEX idx_events_agent   ON events(agent_id, timestamp);
CREATE INDEX idx_events_project ON events(project_id, timestamp);
CREATE INDEX idx_events_session ON events(session_id, raw_seq);
CREATE INDEX idx_events_request ON events(request_id);
```

> **聚合不变量（实测，最高优先级）**：token 一律按 `MAX(...) GROUP BY request_id` 汇总，**绝不允许对 events 直接 `SUM`**。`generation.end` 每请求只应有一条承载 usage 的行（Adapter 去重），但查询层仍必须用 `request_id` 兜底，防止某个 Adapter 漏做去重时数字静默翻倍。§7 查询器与 M1 的验收测试都要覆盖这条。

### 3.2 内容层 `payloads`（可关、可 TTL）

```
payloads
─────────────────────────────────────────────
event_id      TEXT PK  -- 1:1 with events
kind          TEXT     -- user_message|assistant_message|tool_input|tool_output|reasoning
role          TEXT
text          TEXT     -- zlib 压缩存储
bytes         INTEGER
truncated     INTEGER  -- 超过单条上限时截断并标记
```

- 单条上限默认 32 KB；表级默认保留 30 天；`--no-content` 全局关闭。
- **Timeline 与 Replay 属于内容层；usage / cost / capability 全部只依赖指标层。** 因此关闭内容层后，Token、Cost、Agent、Project、Capability 统计完全不受影响。

### 3.3 事件类型（冻结为枚举，扩展走 subtype）

```
session.start / session.end
message.user / message.assistant
tool.start / tool.end / tool.result            ← tool.result 实测必须独立
generation.start / generation.end              -- 一次模型调用，token 挂这里，带 request_id
skill.invoke
mcp.invoke
plugin.invoke
connector.invoke
command.execute                                ← 斜杠命令 / shell
subagent.start / subagent.end
hook.fire                                      ← 实测新增，本机最大能力类别
context.compact                                -- 压缩/截断，解释成本突变的关键
error
```

两条实测强制的区分：

- **`message.user` ≠ 所有 user 记录。** Claude Code 的 11,861 条 user 记录里 **93.2%（11,058）是 `tool_result`**，真实用户输入只有 559 条（`distinct promptId` = 559）。只有纯文本/带图片的才是 `message.user`，`tool_result` 必须映射为 `tool.result`。否则 Session 页的"用户轮次"和 Timeline 会虚高约 18 倍。
- **`context.compact` 有真实数据源**：`system/compact_boundary`（本机 16 条）。同族的 `system/api_error`(63)、`system/turn_duration`(46)、`system/stop_hook_summary`(425) 分别映射到 `error` / `duration_ms` / `hook.fire`。

`skill.invoke` 的识别尤其关键：实测 skill 激活有 4 条互不重叠的路径（`Skill` 工具仅 15 次，而 `invoked_skills` attachment、`isMeta` 注入、`<command-name>` 各自独立贡献），只数工具调用会低估到几乎为零。详见 `docs/research/claude-code.md` §2.4。

### 3.4 OTel 对齐

字段语义尽量对齐 OTel GenAI 语义约定（`gen_ai.provider.name` / `gen_ai.request.model` / `gen_ai.usage.input_tokens` …），映射表写在 `packages/event-model/otel-map.ts`。目的不是"支持 OTel"，而是：
1. 给 Schema 命名一个外部一致性依据；
2. 让 §12 的 Langfuse/Phoenix 导出退化为纯映射，而不是第二套模型。

---

## 4. ID、去重与增量（v1 完全缺失，v2 视为地基）

### 4.1 确定性 ID

| 实体 | 规则 |
|---|---|
| `agent_id` | Adapter 声明的短 slug（`claude-code`） |
| `host_id` | 实测必需：`(agent_id, entrypoint)` → `claude-code` / `claude-desktop`。同一份日志里两种宿主混写，不拆分会让"用了多少 Claude Code"完全失真 |
| `source_id` | `hash(agent_id + absolute_path)`，inode 变更则重挂新路径但保留历史 |
| `project_id` | `hash(canonical_repo_root(cwd))`，见下方三步归一化 |
| `session_id` | `agent_id + native_session_id`；原生缺失时用 `hash(source_id + first_record_uuid)`；再缺失则 `source_id + 时间分桶`（30 min gap 切新 session）。实测 Claude Code **每条记录都带 sessionId 且一文件一 session**，兜底规则只对尚无原生 ID 的 Agent 生效 |
| `event.id` | fingerprint = `hash(source_id + raw_seq + type + occurred_at + role/name)` |
| `request_id` | 原生字段直取；缺失时回退 `(session_id, 首条 record 的 uuid)`。实测缺失率 0.26% |

**`project_id` 的三步归一化（实测：仅靠 git root 会把一个项目炸成 N 个）**

本机 25 个高频 cwd 中 8 个是 worktree，且存在"worktree + 子目录"嵌套，另有第三方工具（Orca）产生的 `~/orca-workspaces/<repo>-<name>` 形态：

```
1. git common-dir 解析：读 .git 的 gitdir: 指针 → 取 --git-common-dir 的父目录作为主仓库根
   （worktree 的 git root 就是 worktree 自身，绝对不能用它）
2. 路径规则兜底：截断 /.claude/worktrees/<x> 及其后的子目录
3. 可配置归并表 ~/.agentlens/projects.toml：前缀/正则 → 规范名
   （处理 Orca 等无法用固定规则识别的外部工具，以及同一仓库多副本 checkout）
```

`cwd` 只存在于消息/attachment 类记录（实测 51,984 条有、16,330 条无，缺失者全是宿主元数据记录）→ **项目归组必须从消息记录取 cwd，不能假设首条记录带 cwd**。

### 4.2 幂等写入

- 全部走 `INSERT OR IGNORE`（event.id 为主键）。
- 重放安全：任意时刻对同一 source 从 offset 0 重扫，DB 结果不变。**这条必须有测试。**
- `sources.last_offset` 只在整批事务提交后推进。解析中途崩溃 → 下次从原 offset 重来。

### 4.3 `sources` 表与增量器

```
sources
─────────────────────────────────────────────
id            TEXT PK
agent_id      TEXT
path          TEXT
kind          TEXT      -- jsonl | sqlite | ndir
inode         INTEGER
size          INTEGER
mtime_ms      INTEGER
last_offset   INTEGER
parser_version INTEGER   -- 见 §5.3
session_id_hint TEXT
status        TEXT      -- active|gone|error
last_error    TEXT
scan_started_at / scan_finished_at / rows_ingested
```

JSONL 增量：`stat` → 比对 `(inode, size, mtime)` → `size >= last_offset` 则从 `last_offset` 读增量字节 → 按 `\n` 切分 → **只消费完整行，尾部残行不推进 offset**。

SQLite 源（Qoder/OpenCode 可能是）：不能用 offset。改用 `rowid`/`last_insert_rowid` 高水位 + 表名记录在 `sources` 的扩展列。

文件被轮转/截断（`size < last_offset` 或 inode 变了）→ 标记该 source 为 `rotated`，新路径新建 source 行，历史事件保留。

### 4.4 实测修正：精度风险的真正位置

v2 初稿在此处断言「Claude Code 会在会话结束后数分钟剥离 usage 字段，历史 Token 系统性偏低」。**该断言已被实测推翻**，而真实风险在别处。样本：`~/.claude/projects` 全量 92 文件 / 68,314 记录 / 255.8 MB，版本区间 2.1.149→2.1.275，脚本与分桶数据见 `docs/research/claude-code.md`。

| # | 实测结论 | 严重度 | 已写入的对策 |
|---|---|---|---|
| 1 | usage **100% 保留**（含 >30 天文件），冷扫描与 watch 等价 | — | 撤下"字符估算"主路径；`usage_source` 仅作兜底与其他 Agent 用 |
| 2 | 一次 API 响应按 content block 拆多条记录并**重复携带同一 usage** → 逐条求和 **虚高 1.87×**（cache_read 4.92B vs 真实 2.65B） | 🔴 致命 | `request_id` 入表 + §3.1 聚合不变量 + M1 对账 |
| 3 | **`94.6%` 记录来自 Claude Desktop**（`entrypoint` 分布 49,204 : 2,780），与 CLI 共用日志格式 | 🔴 致命 | `host_id` 身份维度 + CLI/Web 默认可按宿主过滤 |
| 4 | 真实历史缺口来自**上游文件保留**：本机 6/32 项目目录 JSONL 已被清空 | 🟠 高 | 覆盖度必须可见：`doctor` 报告"目录存在但无文件"，UI 标注"历史不完整"；`~/.claude/history.jsonl`（含 `{display,timestamp,project,sessionId}`）作为"会话存在性"补救源 |
| 5 | 日志**无任何成本字段**（`costUSD` 出现 0 次） | 🟠 高 | 成本全由 §8 Pricing 自算；缺价 → `NULL` 而非 `$0` |
| 6 | `model = '<synthetic>'` 占位记录（恰为每文件约 1 条、四个 token 字段全 0） | 🟡 中 | 映射为 `status=error` 诊断事件，**不产生 usage**，否则每 session 多一次幽灵调用 |
| 7 | 归组陷阱：子目录 cwd、worktree cwd、Orca 外部 worktree | 🟠 高 | §4.1 三步归一化 + `projects.toml` |
| 8 | subagent 入口工具名是 **`Agent`**（非 `Task`），侧链带 `agentId` + **独立 requestId/usage**（实测子链 46.75M tokens，占 1.7%），但**无 agentId↔tool_use.id 外键** | 🟡 中 | 子链成本可精确归因；父链接用"同 session 内时间最近的前序 `Agent` 调用"启发式，且允许 `parent_event_id = NULL` 并计入 doctor |
| 9 | 跨 2.1.x 记录类型已明显漂移（19 种类型，噪声占 24.6%） | 🟠 高 | §5.3 白名单 + unknown 兜底 + fixtures |

> 方法论上得到的最重要教训：**"数字悄悄错"的主要来源不是采不到，而是聚合口径。** 第 2 项若未实测发现，第一版上线即会被用户拿 ccusage 对出 87% 的偏差，且方向是虚高——这是最能直接摧毁信任的一种错误。因此 §15 M1 的硬性验收「同一时间区间与 ccusage 对账」**已于 2026-09-21 通过**（四字段 0.0% 偏差，见 §1.5 与 `docs/research/claude-code.md` §五），并已升格为 M3 的 CI 回归项。

---

## 5. Adapter 契约

### 5.1 接口

```ts
interface AgentAdapter {
  readonly id: string
  readonly displayName: string
  /** 支持的源格式版本，用于 §5.3 漂移检测 */
  readonly parserVersion: number

  detect(ctx: HostContext): Promise<Detection>        // 是否存在 + 版本 + 数据根目录
  discover(ctx: HostContext): AsyncIterable<SourceSpec>
  parse(source: SourceSpec, from: ByteOffset, ctx: ParseCtx): AsyncIterable<RawRecord>
  normalize(record: RawRecord, ctx: NormalizeCtx): Promise<AgentEvent[] | ParseFailure>
  capabilities?(ctx: HostContext): Promise<CapabilityCatalog[]>
  // 实测：静态清单确实可得，是"装了但没用过"视角的前提。Claude Code 的清单来源有四——
  // ~/.claude/skills/*、plugins/installed_plugins.json、attachment.skill_listing{names,skillCount}、
  // attachment.deferred_tools_delta{pendingMcpServers,needsAuthMcpServers,failedMcpServers}
}
```

`detect()` 返回 Agent 版本号，供 §5.3 判断"是否遇到了没见过的版本"。

### 5.2 三条硬规则

1. **不静默失败。** `normalize` 要么产出事件，要么产出 `ParseFailure{ reason, raw_line, offset }`；后者写入 `parse_errors` 表并计入 `doctor`。数字悄悄变小是最致命的信任崩塌。
2. **Adapter 不写 DB、不查 DB、不猜价格。** 纯函数式转换，全部可单测。落库、去重、计价只在 core。
3. **Adapter 不修改源文件。** 只读打开；SQLite 源以 `mode=ro` 打开（v1 里"Qoder database locked"就是这个问题的预告）。

### 5.3 格式漂移防护

- `sources.parser_version` 与 Adapter 当前 `parserVersion` 不一致 → 重新全量扫该 source（依赖 §4.2 幂等）。
- 未知 Agent 版本 / 未知 `type` 值 → 不抛异常，落成 `type='unknown'` + 原始 JSON 进 metadata，并在 `doctor` 报告里列出行数。
- **记录类型白名单**：实测 Claude Code 单版本就有 19 种记录类型，其中 13 种是宿主元数据（`bridge-session`/`atis-latch`/`custom-title`/`pr-link`/`queue-operation`/`mode`/`agent-name`/`file-history-*`/`permission-mode`/`last-prompt`/`frame-link`/`artifact-*`/`ai-title`，合计占 24.6%）。Adapter 用显式白名单分派，未列入者进 `unknown` 而非报错。其中 `pr-link`、`custom-title`/`ai-title`、`mode` 有产品价值（会话标题、PR 关联、模式轨迹），应作为 `subtype` 保留而非丢弃。
- 每个 Adapter 维护 `fixtures/` 目录：真实脱敏样本 → 期望事件快照。CI 跑快照回归。这是唯一能低成本对抗上游改格式的手段。**fixtures 必须跨版本采集**（本机日志已横跨 2.1.149→2.1.275，工具名 `Task`→`Agent` 之类的改名就是漂移证据）。

### 5.4 目录结构

```
agent-lens/
├── apps/
│   ├── cli/                 # agentlens
│   └── web/                 # SvelteKit SPA，由 server 以静态资源托管
├── packages/
│   ├── event-model/         # Schema + OTel 映射 + 校验     ← 单一事实源
│   ├── storage/             # SQLite schema / migrations / 查询
│   ├── collector/           # 发现、增量、watch、调度
│   ├── pricing/             # 价格快照 + cost 计算
│   ├── query/               # 聚合立方体（见 §7）
│   └── server/              # Hono HTTP + SSE
├── adapters/
│   ├── claude-code/
│   ├── codex/
│   ├── qoder/
│   ├── opencode/
│   └── workbuddy/
└── docs/
```

依赖方向严格单向：`adapters → event-model`，`core → event-model`，`cli/web → query → storage`。Adapter 之间不得互相引用。

---

## 6. 存储与 SQLite

- 单文件：`~/.agentlens/agentlens.db`，WAL 模式，`PRAGMA foreign_keys=ON`。
- 迁移：编号 SQL 文件 + `schema_migrations` 表；启动时自动迁移，且**迁移前自动备份 DB**。
- 不做过度范式化：metadata 用 JSON 列；SQLite 3.38+ 的 `json_extract` 足够查询。
- 保留策略：`payloads` 按 TTL 清理；`events` 默认永久；提供 `agentlens prune --older-than 90d`。
- 容量实测校准（本机约 4 个月、单 Agent 家族）：源日志 **255.8 MB / 68,314 记录 / 92 session** → 指标层约 **7 MB/4 个月**（按 300 B/事件估），**内容层才是体积来源**（实测日志内含完整文件内容与 system prompt，单文件最大 22 MB，`prompt_snapshot`/`attachment.file` 是大头）。
- 结论：指标层不需要任何归档设计；`payloads` 的 TTL + 默认关闭（`--no-content`）+ 单条截断是**唯一必要的**容量控制。10 万事件/天量级下 SQLite 无压力。

---

## 7. 聚合模型：一个立方体，而不是一堆报表

统计层不要为每个页面写一条 SQL，而是实现一个受约束的分组查询器：

```ts
query({
  metrics:  ['tokens_input','tokens_output','cost_total','events','sessions','duration'],
  dims:     ['agent','project','model','capability_type','capability_name','day'],
  filter:   { since:'7d', agent:['claude-code','codex'] },
  order:    'metric:cost_total:desc',
  limit:    20
})
```

维度集合（v1 的清单予以保留，实测补两项）：
`time · agent · host · project · session · model · provider · capability_type · capability_name · tool · skill · mcp · plugin · connector · command · subagent · hook · status`

`host` 与 `hook` 为 §1.5 实测后新增。所有 token/cost 度量内部一律走 `MAX(...) GROUP BY request_id` 再汇总（§3.1 聚合不变量），调用方不需要也不能自己决定去重方式。

CLI 与 Web 共用这一个查询器——这是"任意切分"能力的全部成本所在，也是 v1 第六节真正的落地形式。**CLI 的每个子命令都必须是它的一层薄壳**，否则两端数字会漂。

---

## 8. Cost Engine

```
usage (tokens, 分层)  →  PricingTable.lookup(model, occurred_at)  →  CostBreakdown
```

- `models` 表存 `(provider, model, tier)` + 分价：input / output / cacheRead / cacheWrite / reasoning，**价格带生效日期区间**（模型会改价，历史成本必须可复现）。
- 价格数据来源：**不手工维护**。上游取 `litellm` 的 `model_prices_and_context_window.json`，构建时生成快照进包，运行时可 `agentlens pricing update` 刷新，用户可用 `pricing override` 覆写。
- **三种计费口径**（v1 完全没讨论，但这是真实场景的主要成本构成）：

| 模式 | 成本计算 | 说明 |
|---|---|---|
| `api` | tokens × price | 默认 |
| `subscription` | 显示 $0，另算"等价 API 价值" | Claude Pro / ChatGPT Plus：真实现金流是固定月费 |
| `local` | tokens 有价、cost 恒为 $0 | Ollama / LM Studio / vLLM |

UI 必须同时呈现"实际花费"和"等价 API 价值"，并让用户在设置里按 Agent 声明计费模式。**否则重度订阅用户看到的数字毫无意义，而这正是我们的主力用户画像。**

- 缺价模型 → `cost = NULL` + `pricing_gap` 记录，`doctor` 报告；**绝不当成 $0**（$0 会被误读为"本地模型"）。
- 实测依据：Claude Code 日志**不含任何成本字段**（20,043 条带 usage 的记录里 `costUSD` 出现 0 次），所以成本 100% 依赖本地价格表；且本机 4 个月内出现 7 个模型标识（`claude-sonnet-5` 9,236 / `claude-opus-4-8` 2,390 / `claude-sonnet-4-6` 2,160 / `claude-opus-5` 1,979 / `claude-opus-4-7` 1,688 / `claude-opus-4-6` 1,614 / `claude-haiku-4-5` 882，另有 `deepseek-flash` 2 与占位的 `<synthetic>`）。**模型名会持续新增**，价格表未覆盖是常态而非异常，`doctor` 的 pricing gap 一栏必须显眼。

---

## 9. CLI

Unix-like，默认可疑地少：`agentlens` 裸命令 = 扫描 + 起服务 + 开浏览器。

```bash
agentlens                      # 首次：发现 → 扫描 → 打印摘要 → 打开 dashboard
agentlens scan [--agent X]     # 手动增量扫描
agentlens watch                # 常驻
agentlens status               # Agent 发现情况 + 今日概览
agentlens doctor               # §11，第一版就要有
agentlens usage  [--agent --project --model --since --by <dim>]
agentlens sessions [--agent --project --limit]
agentlens session <id>         # Timeline（含内容层，缺失时降级为纯指标时间线）
agentlens tools|skills|mcp|plugins|connectors|subagents   # 统一走 capability 查询
agentlens projects             # 跨 Agent 项目视图
agentlens export --format otel|jsonl|csv
agentlens pricing update|override
agentlens prune
```

`usage` 的 `--by` 直接映射 §7 的 dims，所以任何维度组合都免费获得，不需要为新维度加子命令。

输出示例（`agentlens projects`，这是最能体现差异化的一个）：

```
Project            Agents              Sessions  Tokens     Cost(est)
─────────────────────────────────────────────────────────────────────
agentx             claude-code,codex       72   8.2M       $6.42
  ├── claude-code                            41   5.1M       $4.10
  └── codex                                  31   3.1M       $2.32
skillbox           qoder,opencode           34   5.1M       $1.87
```

---

## 10. Web UI

不是"Observability Platform"，是 **Agent Activity Center**。左侧导航：

```
Overview
Agents · Projects · Sessions
Usage: Tokens · Cost
Capabilities: Tools · Skills · MCP · Plugins · Connectors · Subagents
Settings: Adapters · Pricing · Data Sources · Privacy
```

页面优先级（= 实施顺序，按 §1 收缩后的主张重排：Session 与 Capability 才是差异，Agent 页最简）：

1. **Overview**：Tokens / Cost / Sessions / Events 四张卡 + 时间趋势 + Agent 与 Project 双饼图。顶部两条常驻横幅（实测必要）：宿主拆分（`claude-desktop` vs `cli`）与**历史覆盖度**（有目录但无会话文件的项目数）。
2. **Session 详情**：瀑布式 Timeline（消息 / 工具 / skill / mcp / hook / 子 Agent / compact），节点展开 input/output/tokens/duration/raw event。← 差异化第一位，也是"Wow"来源；内容层关闭时降级为指标时间线
3. **Capability 页**：横向对比"哪个 skill / MCP / **hook** / 子 Agent 被谁用得多、耗时多少、失败几次"。ccusage 完全没有这一层。
4. **Project 详情**：跨 Agent 归组（含 worktree 合并）、模型分布、能力分布、近期 sessions。
5. **Agent 详情**：sessions/tokens/cost/tool/skill/mcp 计数 + 下钻。做到能用即可。

技术：Vite + Svelte 5（或 React，团队一致即可）+ Tailwind + Recharts。数据走 REST（§7 查询器）+ SSE 推送增量。

---

## 11. doctor（第一版必须有）

信任类工具的成败在于"用户是否相信你的数字"，`doctor` 就是这份信任的出口：

```
Agents
✓ claude-code        v2.1.275   ~/.claude/projects/**/*.jsonl   54 files / 173MB
✓ claude-desktop     same store, entrypoint=claude-desktop      38 files   ← 宿主拆分后才是真数字
✓ codex              v0.46      ~/.codex/sessions/**/rollout-*.jsonl   318 files
! qoder              SQLite opened read-only, 2 tables unreadable
- opencode           not detected

Parsing
events 128,402 · parse_errors 37 (0.03%) · unknown types 12 rows

Usage quality（实测口径，不再是"估算比例"）
reported 99.7% · missing 0.3% (52 records without request_id, counted individually)
✓ request_id dedup active: raw sum 5,043.6M → 2,699.6M (-46.5% inflation avoided)

Coverage
! 6 project dirs exist but contain no session files (upstream retention)
  → history is incomplete; 41 sessions known only from ~/.claude/history.jsonl

Capabilities
skills installed 62 · invoked 9        ← "装了但没用过"是留存理由之一
hooks fired 10,878 · failures 83 (PostToolUseFailure)
mcp servers: 9 attached, 1 needs-auth, 0 failed   ← deferred_tools_delta

Pricing
✓ 148 models priced
! 3 models missing price (claude-opus-5, deepseek-flash, ...)  → cost shown as "n/a"

Permissions
✓ ~/.claude readable
✗ ~/.qoder/... locked
```

---

## 12. 与 Langfuse / Phoenix 的关系

```
Adapters → Unified Events → SQLite → CLI/Web
                         └→ Export (OTel / JSONL / Langfuse ingest)
```

我们负责"采集 + 统一"，高级分析与企业可观测交给它们。导出实现为 §3.4 的 OTel 映射之上的一个薄 writer，不另建模型。**这也是 Event Schema 必须尽早冻结的技术原因：导出的对外契约一旦发布就不能再改。**

---

## 13. 技术选型

v1 通篇未写，v2 先定，因为它是 M0 的前提。

| 层 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript / Node 22+ | Adapter 迭代速度是产品增长瓶颈；各家 JSONL 的社区解析代码以 JS/TS 为主；前后端同构 |
| 包管理 | pnpm workspace | 对应 §5.4 的 monorepo |
| CLI | commander + 自绘表格 | 少依赖，输出可控 |
| 存储 | `node:sqlite`（Node 22+ 内置），回退 `better-sqlite3` | 优先零原生依赖 |
| 增量/监听 | chokidar | watch 模式 |
| Server | Hono + 静态 SPA 托管 | 启动即开 localhost |
| 实时 | SSE | 比 WebSocket 简单，单向够用 |
| Web | Vite + Svelte 5 + Tailwind + Recharts | 第一版图表不需要更重 |
| 测试 | vitest + fixtures 快照 | §5.3 的核心防线 |
| 分发 | esbuild 单文件 → npm `npx agentlens`；后续 brew tap | §14 的"一条命令" |

**长期演进判断**：Rust 在分发（单二进制）与内存上更优，但会拖慢 Adapter 数量爬坡。路径是：TS 跑通 → Schema 冻结 → 若热路径（大文件扫描）确实成为瓶颈，只重写 `collector` 为原生模块，`event-model` 与 Adapter 契约保持不变。

---

## 14. 目标体验

```bash
$ npx agentlens

AgentLens

Scanning local agents...
✓ claude-code ✓ codex ✓ qoder ✓ opencode

92 sessions · 2.70B tokens · 按去重口径 · $— est. cost（缺价模型 n/a）
12,821 tool calls · 10,878 hook fires · 981 MCP calls · 9 skill invocations

数字量级取自本机实测（§4.4），刻意不用"漂亮的整数"：cache_read 占绝对主导，
skill 计数远比 v1 预期的 1,923 小，而 hook 才是被用最多的能力。

⚠ 6 project dirs have no session files left (upstream retention) — history is incomplete.
⚠ 94% of ~/.claude records came from claude-desktop, not the CLI. Shown split by default.

Dashboard → http://localhost:7317
```

> 首屏横幅的内容由实测决定：用户第一眼要看到的是**覆盖度**与**宿主拆分**，而不是原计划的"数字是估算"。

---

## 15. 里程碑

每阶段都有**明确的证伪目标**，不是"做完一堆功能"。

### M0 · 契约先行（1–2 天）
产出：`packages/event-model`（§3 Schema + 校验 + OTel 映射）、**`request_id` 去重聚合器（§3.1 不变量）**、§4.1 的 project 三步归一化（git common-dir + worktree 规则 + `projects.toml`）、`packages/storage`（建表 + 迁移 + §4.2 幂等测试）、`sources` 增量器（§4.3）+ 单测、Adapter 接口（§5.1）与 `ParseFailure` 类型、pnpm workspace 骨架。
验收：① 对一个假造 JSONL，重扫两次 → DB 状态字节级一致；② 一条"多 block 重复 usage"的假造记录，聚合结果等于单份 usage（**去重必须有独立单测**）。
> 不写任何真实 Adapter。

**状态**：✅ 完成（2026-09-21）。`event-model`（`validate.ts`/`otel-map.ts`/`dedupe.ts`/`project.ts`）+ `storage`（迁移 `001`–`003`）+ `sources` 增量器（`collector/src/incremental.ts`）+ Adapter 接口/`ParseFailure` 均在；验收①见 `storage/test/idempotency.test.ts`，②（多 block 重复 usage→单份）见 `event-model/test/dedupe.test.ts`。

### M1 · 单 Adapter 打通（2–4 天）— 全局风险最高的一步
只做 `claude-code`（含 `host_id` 的 desktop/cli 拆分）。跑通 detect → discover → 增量 parse → normalize → SQLite → CLI `usage`。
必须回答（§4.4 与 ccusage 对账已回答前四项，剩余一项待做）：
① ~~usage 是否被剥离~~ → **已证伪，100% 保留**
② ~~去重口径~~ → **已定为按 `requestId` 取 max**
③ ~~与 ccusage 对账~~ → **已完成：四字段 0.0% 偏差、逐日 15 天 1.00x**（`docs/research/reconcile-ccusage.mjs`，结果 `reconcile-result.txt`）
④ ~~宿主拆分的实际影响~~ → **已量化：全量 desktop 96.8% / cli 3.2%，不拆分误差 31.2×**
⑤ **待做：subagent 启发式归属的准确率**（抽 20 个侧链人工核对父链接），以及把上述规则实现成真正的 `claude-code` Adapter + fixtures。
> M1 剩余工作因此从"探索未知"变成"把已确认的规则工程化"，可直接进入 M0。
> **禁止在此阶段并行写第二个 Adapter。** 抽象未被证伪前多加一个实现，等于固化错误。

**状态**：✅ 完成，一处 pending。`adapters/claude-code`（`host_id` desktop/cli 拆分、fixtures 57）贯通 detect→discover→parse→normalize→SQLite→`usage`。①–④ 见 §1.5；⑤ 的"规则工程化 + subagent 父链取真实外键"已落地，**"抽 20 个侧链人工核对父链准确率"无仓库证据 → pending**。

### M2 · Codex + 抽象证伪（2–3 天）
Codex 与 Claude Code 差异最大（rollout 文件、无 skill 概念、session 边界不同）。目的**不是加支持，是逼 Event Schema 改第二轮**。改完 Schema 冻结，此后只允许加枚举值、不允许改结构。

**状态**：✅ 完成。`adapters/codex`（+ `usage-granularity`/`cache-tokens` 单测）逼出 Schema 第二轮（迁移 `002`），结构冻结。

### M3 · Cost + doctor（2–3 天）
Pricing 快照与 `pricing update`、三种计费口径（§8）、`doctor`（§11）、`agentlens status`。
**新增硬性验收（对账副产品）**：`reconcile-ccusage.mjs` 升级为回归测试 —— 同一窗口 AgentLens 的 token 与成本必须与 `ccusage claude daily -j -O -z UTC` 零偏差；成本锚点取本机实测的 **$667.96 / 30 天**。ccusage 只作 devDependency 级别的测试工具，不进产品依赖。
> doctor 不延后：它决定第一批用户是否相信数字。而对账 CI 是"我们相信数字"的机器化版本。

**状态**：✅ 完成。`packages/pricing`（litellm 快照 + 三计费口径 `cost.ts:computeCost`）、`doctor`、`status` 均在；对账回归 `apps/cli/test/reconcile-ccusage.test.ts` 已进套件（本次 552 绿）。

### M4 · Web：Overview + Session Timeline + Capability + Project（4–6 天）
顺序按 §1 收缩后的主张：Session 与 Capability 先于 Project，Project 先于 Agent 页 —— 前者是 ccusage 完全没有的层。此阶段同时引入隐私开关（`--no-content`）。

**状态**：✅ 完成（2026-09-22 浏览器回归）。`apps/web` 九个页面（Overview / Sessions / SessionDetail / Capabilities / Projects / Usage / Doctor / Settings / Agents / Models）+ `packages/server`（Hono + SSE）+ 内容层默认关（`--content` 显式开）全部在真实浏览器里对**本机全量库**（6 个 Agent、549 sources、343,303 事件、450 会话）渲染过一遍，方法与逐页发现见 §19。回归过程抓到并修掉两处：Web Doctor 与 CLI 各说各话（Adapter 改为注入，见 §19）、`/api/projects` 全历史一次请求 66.5 s → 33.9 s 且输出逐字节不变（见 §19）。仍开着的两条是 §19 里的时间线排序与摄入时刻时间戳，未修不隐瞒。

### M5 · Qoder / OpenCode / WorkBuddy（3–5 天）
真正验证 Adapter 架构是否通用。若此时仍需改 Schema，说明 M2 的证伪没做够——这是本计划唯一允许的"返工信号"。

**状态**：✅ 完成。`adapters/{qoder,opencode,workbuddy}` 全部有实现与测试；上一版"OpenCode 真实库为 WAL、被 collector 拒绝直开、当前贡献 0 事件"已闭环（c4a2cd3 / 77541fc / eff1183）：collector 把 WAL 库复制成回滚模式快照后经 `ParseCtx.storePath` 交给 Adapter（`packages/collector/src/sqlite-snapshot.ts`，机制见 §18 row 7，实测数字见 §19），拒绝直开的守卫仍对准对方的真实文件。

### M6 · watch 常驻 + 实时看板（2–3 天）
SSE 增量、MCP 插件的 `capabilities()` 静态清单（`skills`/`mcp` 命令的"装了但没用过"视角）。

**状态**：✅ 完成。`collector/src/watch.ts`（`node:fs.watch` + 每轮 discover）、`server/src/sse.ts`（SSE）、`capabilities()` 静态清单（`doctor-caps.ts`）均在；`watch.e2e.test.ts`/`watch-idempotency.test.ts` 钉住。

### M7 及以后
Replay · 导出（OTel/Langfuse）· 告警（"agentx 今日成本 +240%"）· 效率分析（按 skill/phase 归因）· 单二进制分发 · Team。

---

## 16. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| **聚合口径错误（多 block 重复 usage）** | 数字虚高 80%（30 天窗口）～87%（全量），方向是"多算钱" | ✅ 已定位并对账通过：`request_id` 去重入 Schema + M3 CI 回归 + 单测 |
| **宿主混淆（Desktop 与 CLI 共用日志）** | 最基础的问题都答错 | 🔴 已定位：`host_id` 一等维度 + 默认分栏 |
| 上游日志格式漂移 | 数字悄悄变小/变大，信任崩塌 | `schema_version` + 类型白名单 + fixtures 跨版本 + 不静默失败 + `doctor` |
| 上游文件保留导致历史缺失 | 首扫结果被误认为"全貌" | 覆盖度入 `doctor`；UI 明示不完整；`history.jsonl` 补救会话存在性 |
| 价格表未覆盖新模型 | 成本显示 n/a（实测 4 个月出现 7 个模型标识） | 快照 + update + override + `doctor` 显式 gap（禁止当 $0） |
| worktree / 外部工具目录使项目分裂 | Project 视图（差异化卖点）失效 | §4.1 三步归一化 + `projects.toml` 归并表 |
| subagent 父链接无外键 | Timeline 树形结构出错 | 时间启发式 + 允许归属未知 + M1 人工抽检 20 例 |
| 内容层撑爆磁盘 | 上百 GB DB | payloads TTL + 单条截断 + `--no-content`；`prompt_snapshot`/`file` 类默认不存 |
| SQLite 源被占用（Qoder） | 采不到数据 | `mode=ro`，失败降级并计入 doctor |
| **竞品边界误判**（实测：ccusage 已跨 18 CLI + 有 per-project 报表） | 差异化主张落空，变成"另一个 token 报表" | §1 主张已收缩到 Session/Capability/规范化实体；开工前重跑 `ccusage --help` 与 `ccusage daily` 复核，每季一次 |
| 单靠 Token/Cost 打不过 ccusage | 产品没有存在理由 | 不做卖点；改为对账 CI 锚点（M3），把力气放在它没有的层 |
| Adapter 迭代被分发绑死 | 每次改动都要发版 | npm 分发优先，单二进制推迟到 Schema 冻结后 |
| 隐私顾虑（读全部本地日志） | 无法推广到团队 | 全本地、无遥测、`--no-content`、`prune`；实测确认日志含完整文件内容与 system prompt，**内容层默认关闭是必要而非可选** |

---

## 17. 待实测确认清单

**Claude Code（§1、§2）已于 2026-09-21 完成，结论见 `docs/research/claude-code.md`。** 原第 1、2 项的结果：usage 未剥离（假设证伪）；真正的一号风险是 `requestId` 多 block 重复计数（+87%）与 Desktop/CLI 宿主混淆（94.6% vs 5.4%）；session 边界为"一文件一 session"无需启发式；subagent 入口是 `Agent` 工具且侧链可独立计费；skill 有 4 条激活路径。

剩余待实测：
1. ✅ **与 ccusage 同区间对账**（2026-09-21 完成，`reconcile-ccusage.mjs`）→ 口径 B 与 ccusage **四字段 0.0% 偏差、逐日 15 天 1.00x**；分组键必须 `requestId`（非 `message.id`），取值必须 `max`（非首块）。副产品：ccusage 能力边界远超预期，已据此改写 §1。
2. 🟡 Codex `rollout-*.jsonl`：记录结构、session 边界、cache token 字段命名、是否存在同类重复计数
3. 🟡 Qoder / OpenCode：是否 SQLite、是否有稳定 session UUID、只读可开性
4. 🟡 WorkBuddy：数据根目录与格式
5. 🟢 其他 Agent 是否记录 MCP server 名 / compact 事件 / hook 类能力

> 每项各产出一篇 `docs/research/<agent>.md`（含脱敏样本 + 可重跑的 probe 脚本），作为对应 Adapter 的 fixtures 来源。第 1 项在 M1 结束前不得跳过。

---

## 18. 实测第二轮（2026-09-21，Codex / Qoder / OpenCode / WorkBuddy）

证据：`docs/research/codex.md`、`qoder-opencode.md`、`workbuddy.md`，脚本 `probe-codex{,-2}.mjs`、`probe-qoder.mjs`、`probe-opencode.mjs`、`probe-capabilities.mjs`、`reconcile-codex-ccusage.mjs`。样本量：Codex 379 文件 / 221,416 记录 / 571 MB；Qoder 4,845 文件 / 14,742 记录 / 38 session；OpenCode SQLite 22 表（session 10 / message 531 / part 2,242）；WorkBuddy SQLite 10 表。

这一轮**证伪了 §3/§4/§8 的四条假设**，M2 的"逼 Schema 改第二轮"因此提前。结论按严重度：

| # | 实测结论 | 对方案的影响 | 落地（2026-09-21） |
|---|---|---|---|
| 1 | 🔴 **§8「日志里没有成本字段」只对 Claude 家族成立**。OpenCode 原生带 `session.cost` 与逐消息/逐 step 成本；WorkBuddy `session_usage` 同样带成本。 | `events` 增列 `cost_reported REAL` + `cost_source TEXT('reported'\|'computed'\|'none')`。查询优先级：reported > computed；两者都无 → NULL，仍不得当 $0。 | ✅ 迁移 `002` 加 `cost_reported`/`cost_source` 入 `events`，`storage/src/write.ts` 落库 |
| 2 | 🔴 **`request_id` 去重是 Claude/Qoder 特有形态，不是全局不变量**。同一测在 Codex/Qoder 均未复现"一次响应拆多条重复 usage"（Qoder 每个 request_id 恰好一条 usage；Codex 0 组重复）。Codex 的同类陷阱更狠：usage 有三层粒度（每次调用的 `last`/`usage` + 累积的 `total`/`turn`/`thread`），误用累积字段虚高 **约 1,971×**；正确口径是只累加每次调用的 `last_token_usage`，且按 ccusage 对账须**排除 subagent 线程**（逐字段偏差 cacheRead +2.3% / total +1.8%）。 | 去重口径改为**Adapter 声明**：`Adapter.aggregation = { mode: 'request_max' \| 'per_record_sum' \| 'last_call_sum', subagentsIncluded: boolean }`。`'request_max'` 仍是 Claude/Qoder 默认，查询立方体按 agent 分流；MAX-per-request 的兜底保留（漏声明时按最保守口径）。 | ✅ `AggregationPolicy` 入 `agents` 表（迁移 `003_aggregation_policy_per_agent.sql`），查询期由 `loadAgentAggregations` 回读、立方体按 agent 分流 |
| 3 | 🟠 **§4.1「一个文件一个 session」只对 Claude/Qoder 成立**。Codex 是 file=thread，`session_id` 跨文件（379 个文件里 280 个共享 session，其中 257 个是 subagent 线程）；OpenCode/WorkBuddy 用关系型 session + `parent_id`。 | `events` 增列 `thread_id TEXT`（源内线程/文件粒度）与 `session_id`（产品粒度）双键；`sources.session_id_hint` 保留；subagent 是否计入总量成为显式开关（默认排除，与 ccusage 对齐）。 | ✅ 迁移 `002` 加 `thread_id` + `idx_events_thread`，`subagents_included` 随 `003` 入 `agents` |
| 4 | 🟠 **cache token 命名有 4 种方言**，且 Codex 的 `input_tokens` **已包含** cached（与 Claude 相反）：Claude/Qoder `cache_read_input_tokens`/`cache_creation_input_tokens`；Codex `cached_input_tokens`/`cache_write_input_tokens`；OpenCode `tokens_cache_read`/`tokens_cache_write`。 | 方言映射只允许存在于 Adapter 内，`events` 列名冻结；每个 Adapter 必须单测断言"input 是否含 cache"，否则 cost 会双计。 | ✅ 方言映射只在各 Adapter 内、`events` 列名冻结，cache-是否含入 input 各有单测（`codex/test/cache-tokens.test.ts` 等） |
| 5 | 🟡 **能力枚举不通用**：`hook.fire` 只有 Claude/Qoder 有（Codex 实测 0 条）；`context.compact`/`subagent`/`mcp.invoke` 概念都在，但源结构各异（Codex `compacted`/`dynamic_tools`/`thread_source`；OpenCode `time_compacting`/`parent_id`）。 | 枚举保留，但 UI 与 `doctor` 必须按 Agent 声明"该能力是否存在"（`capabilities.supports`），不得默认 hook 列有数。 | ✅ `doctor-caps.ts` 以静态 `capabilities()` 清单比对 invoked，无数据源时不印 0 |
| 6 | 🟡 **`host_id` 推广成功**：Codex 的 `originator` 分布 Desktop 343 / tui / exec / cli_rs，与 Claude 的 `entrypoint` 同构。 | 无需改结构，Adapter 各自提供 `entrypoint→host_id` 归一表。 | ✅ 各 Adapter 提供 entrypoint→`host_id` 归一（`identities.test.ts` 钉住） |
| 7 | 🔴 **只读打开 SQLite 并非绝对安全**：Qoder 是 JSONL（Claude Code 分支，非 SQLite）；OpenCode 只读打开干净、不产生 sidecar；**WorkBuddy 的 `workbuddy.db`（WAL 模式）在 `readOnly:true` 下仍创建了 `-wal`/`-shm`**。 | 规则：Adapter 打开前必须检查 `-wal` 存在性；WAL 模式的第三方库默认**拒绝直开**，改走该 Agent 的导出/JSONL 通道，并把"因写入副作用而跳过"记进 `doctor`。这条是硬约束，宁可少采一路也不能碰别人的库。 | ✅ "拒绝直开"保留为 Adapter 侧硬约束（`sqlite-source.ts:journalModeOf` 读 DB 头 18/19 字节见 WAL 即拒，`adapters/opencode/src/safety.ts:assessReadOnly` 同规则），但读取通道落地为**快照副本**而非该 Agent 的导出/JSONL（c4a2cd3 / 77541fc / eff1183）：`collector/src/sqlite-snapshot.ts` 把库连同 `-wal`（绝不含 `-shm`）`copyFileSync` 进 `<--db 所在目录>/snapshots`，用 `PRAGMA journal_mode = DELETE` 折成回滚模式单文件，再经 `ParseCtx.storePath` 交给 `adapter.parse`（`adapters/opencode/src/parse.ts`）——**复制不是打开**，守卫仍拒绝对方的真文件。副本按 `sha256(storePath)` 命名 ⇒ 一个库只有一份（OpenCode 的 3 个 `sources` 指向同一库），`<copy>.sig` 缓存 `size:mtimeMs` 以跳过未变的库，两次都没抄稳则抛 `SnapshotError`。无 `snapshotDir` 时拒绝照旧是落库事实（`status='error'` + 原因、offset 不动）并由 `refusalLines`/`doctor` 打印，§5.2 的"不静默失败"成立。OpenCode 真实库因此不再 0 事件（见 §19） |

落地顺序（M2′，先改契约再写 Adapter）：`event-model` 加列与 `aggregation` 声明 → `storage` 迁移 `002_entity_refinement.sql`（新增列，不改既有列语义，幂等测试继续通过）→ `query` 立方体按 agent 分流聚合口径 → `adapters/codex`。Schema 改完即冻结，此后只加枚举值不改结构。


---

## 19. 落地偏差记录（实现期回填，不改上文的设计结论）

只记录**已实现代码与 §13/§18 计划不一致**的地方及理由。计划本身保持原样，便于回溯当时为什么这样选。

### 13 技术选型的实际落地

| 计划 | 实际 | 理由 |
|---|---|---|
| CLI 用 commander | 手写 200 行参数解析（`apps/cli/src/args.ts`） | 子命令只有 12 个、无嵌套、无插件机制；引入 commander 换来的是 `--by`/`--since` 这类自定义语义之上的第二套抽象 |
| 存储 `node:sqlite`，回退 `better-sqlite3` | 只有 `node:sqlite`，无回退路径 | 回退分支要求原生依赖与双套 prepared-statement 代码路径；"零原生依赖"本身就是选它的理由，保留回退等于放弃这个理由 |
| 监听用 chokidar | `node:fs.watch` + 每轮重新 discover | 只需要"目录里出现新文件"这一件事，而 §4.3 的 `skip/append/rotated` 判定本来就是幂等的，靠轮询也能收敛；chokidar 的递归与去抖在单目录粒度上是多余复杂度 |
| esbuild 单文件分发 | 未实现（仍以 pnpm workspace + `node` 直跑 TS） | §15 明确把单二进制放在 M7，不属于本轮范围 |

### 18 row 2 的落地比计划更严

计划写的是"`request_max` 是默认，漏声明时按最保守口径兜底"。实际实现里 `AgentAdapter.aggregation` 是**必填字段**，且 `agentlens scan` 在任何一行落库前对已探测到的 Adapter 做契约校验，缺失即报错终止：

- 兜底成 `request_max` 对 Codex 这类累积粒度日志是**放大**而不是保守（误用累积字段虚高约 1,971×），"最保守口径"这个说法在 row 2 自身的数据下不成立；
- 沉默的 Adapter 才是真风险：它照样能跑通、照样出数字，只是全错。让"忘记声明"变成不可编译/不可运行，比写一条兜底规则便宜。

同时 `aggregation_mode` / `subagents_included` 随迁移 `003` 落到 `agents` 表，由 `scan` 在该 Agent 首行写入前持久化，查询立方体读取**入库时**的口径而非运行时 Adapter。这样即使某个 Adapter 后续改了口径或被人删掉，历史行的折叠规则仍然确定。

### 8 Cost Engine 的一处数据修正

`packages/pricing/src/default-snapshot.json` 早期是手写的，实测偏差约 50%（`claude-sonnet-5` 写成 $3/$15，真实 $2/$10），会污染所有成本数字。现在由 `pnpm -F @agentlens/pricing generate:snapshot` 从 litellm 快照生成，并把 `effective_from` 统一置为 epoch：

- 好处是任何历史窗口都有价可查，不会因为日期早于快照首日而整段显示 n/a；
- 代价是**今天的价格被回溯套用**，`--explain` 与 `doctor` 需要把这一点显式说给用户，而不是假装是当期价格。要精确到历史价，用 `agentlens pricing override` 覆盖，不要改生成器。

### 落地发现（2026-09-21，2026-09-22 回填）

只记已核实的事实与所在文件；两条待办（WAL 读取通道、`agl projects` 标签）已于 2026-09-22 闭环并据此改写，其余各条**仍未修复**。

- **OpenCode 读通（原"当前贡献 0 事件"已闭环）**：其库 `~/.local/share/opencode/opencode.db`（44 MB、WAL）现在经快照副本摄入 —— `packages/collector/src/sqlite-snapshot.ts` 把库 + 其 `-wal`（从不含 `-shm`，SQLite 自建）复制进 `<--db 所在目录>/snapshots`（`apps/cli/src/commands/scan.ts:snapshotsDirFor`），折成回滚模式单文件后由 `ParseCtx.storePath` 交给 `adapters/opencode/src/parse.ts`；`safety.ts:assessReadOnly` 的"拒绝任何 WAL attach"规则原样保留，只是它拒的是对方的文件、读的是我们的副本。**复制不是打开。** 本节 2026-09-21 记下的方向（"以 `copyFile` 复制成单文件快照、复制进 AgentLens 数据目录后再读"）已于 c4a2cd3 / 77541fc / eff1183 落地，同一条里"截至本次快照 `grep copyFile packages/collector/src` 无命中"的备案作废。本机实测（2026-09-22 复测）：对活库一次摄入 **3,391 事件、0 解析失败**（该库全量本身只有 531 条 message、2,242 条 part、5,401 条 event 行），跑前后库与两个 sidecar 的 size/mtime/inode 逐字节相同，快照目录里恰好一份 44,060,672 字节回滚模式副本 —— 3 个 `sources` 共用，且没有 `-shm` 副本。
- **`-shm` 写入证据**：无 OpenCode 进程存活时，跑一条 `agl` 能力命令的瞬间，`~/.local/share/opencode/opencode.db-shm` 的 mtime 就跳到那一分钟；`verifyNoSidecars`（`adapters/opencode/src/safety.ts:104`）只检测**新建**的 sidecar，检不出对既有 `-shm` 的修改。此即上一条仍然拒绝任何 WAL 直开、并且副本只抄 `-wal` 不抄 `-shm` 的动因。
- **无 `snapshotDir` 时的拒绝仍看得见**：WAL 拒绝从"唯一通道"降级为"未配置快照目录时的兜底"，仍是落库事实而非静默零：扫描结束后按库去重成一行（`apps/cli/src/commands/scan.ts:refusalLines`，形如 `! opencode ~/.local/share/opencode/opencode.db not read (3 sources): …`），并逐源以 `status='error'`、offset 不动存库（`packages/collector/src/orchestrator.ts:scanSqliteSource` 的 `WalModeRefusedError` catch 分支）；`doctor` 逐库打印同一条原因。
- **三源共一个库，副本必须按库路径 keyed**：OpenCode 的 3 个 `sources` 行指向同一个 `opencode.db`（实测 `select path, count(*) from sources where agent_id='opencode'` 是 3 行同一 path），按 `source.id` 命名副本会把那个 44 MB 文件抄三份。`sqlite-snapshot.ts:snapshotPathFor` 因此用 `sha256(storePath)` 做名字，一个库一份、三张表读同一份折叠文件 —— 本轮抓到并已修正的缺陷。
- **WAL 测试夹具必须留住写连接**：`node:sqlite` 关掉最后一个连接时 SQLite 会 checkpoint 并删掉 `-wal`，于是夹具退化成"没有 sidecar 的 WAL 头"，测不到活库形态。`adapters/opencode/test/wal-snapshot.test.ts`（`fixtures/build-host.ts` 的 `retainWriter`）与 `packages/collector/test/sqlite-snapshot.test.ts`（`const writer = new DatabaseSync(dbPath)`）各自握着一个未关闭的写连接，直到断言做完。
- **capability 维度陷阱**：`packages/query/src/engine.ts:capNameSql` 对别的 kind 的事件返回 `''`，故不带 `capabilityType` 过滤的 capability-dim 查询会把整库塌成一个 "(unnamed)" 桶、并把库大小当计数。CLI（`apps/cli/src/commands/capabilities.ts`）与 Web Usage 页（`apps/web/src/lib/api.ts:withCapabilityType`）已各自补 `capabilityType` 过滤并加测试；**该陷阱对任何新的立方体调用方仍然生效**，故写此备案。
- **`agl` bin 形态**：入口 `apps/cli/src/command-exec.ts` 是带 shebang 的 TS 文件，靠 `--experimental-transform-types`（`packages/pricing`、`packages/server` 用了 parameter property），strip-only 的 Node 跑不动；`#!/usr/bin/env -S node …` 这种多参 shebang 在 Windows 上不适用。
- **`agl projects` 标签可读性（已处理）**：原先 `cmdProjects`（`apps/cli/src/commands/capabilities.ts`）直接把 64 位 sha256 project hash 当标签渲染。现由 23f3591 + 6557ad0 两处补齐：collector 为它解析出的每个 project id 记下 `projects.canonical_root`（`apps/cli/src/commands/scan.ts:makeProjectResolver` / `recordProjectRoots`，`watch.ts` 同路径），§7 的标签优先级则收敛到 `packages/event-model/src/project.ts:projectLabel`（`display_name` → `basename(canonical_root)` → `UNATTRIBUTED_PROJECT_ID` 印成 `unattributed` → 才印 digest），并被 `packages/query/src/engine.ts`、`packages/server/src/resolve.ts`、`apps/cli/src/context.ts` 共用 —— 屏幕上印出来的就是 `--project <name>` 能接受的。`UNATTRIBUTED_PROJECT_ID` 同时上移到 event-model：此前 5 个 Adapter 各自重导一遍，第 6 份就是 §5.3 禁止的漂移。本机实测：claude-code 扫 80,463 事件后 13 个项目里 12 个带 canonical root，`agl projects` 印的是目录名；剩下那 1 个（16,882 事件、21%）无 attributable cwd，现在读作 `unattributed`，且 `agl usage --project unattributed` 正好命中这批事件。
- **M4 浏览器回归（已执行，2026-09-22）**：此前这条写的是"测试全绿但都是进程内、页面组件从未渲染过 → 待验证"。现在补上了执行。手法：真浏览器打开 `startServer` 服务的 9 个 hash 路由，背后是本机全量库（6 个 Agent、549 sources、**343,303 事件 / 450 会话**，`/api/health` 回显 `{events:343303, sessions:450, contentAvailable:false, payloads:0, loopbackOnly:true}`）。逐页看到的东西：Projects（§1 的差异化页）20 行项目 + worktree 折叠证据（`albatross ~/orca/workspaces/agentx/albatross`）+ `unattributed` 行 + 展开后 BY AGENT / MODELS / CAPABILITIES 三组明细；Settings 的 adapter 表 6 行全 `ok`（sources 95/379/64/3/2/6）、home 已涂成 `~/.claude`、pricing 432 有价 / 25 见过 / 5 缺价；Models 顶出 §8 的缺价横幅（`<synthetic>, codex-auto-review, auto, qfmodel, hy4-preview`）；Usage 就是 §7 立方体浏览器，metrics/dims 白名单逐项可点，totals（98,069 事件 / $630.46）与逐行之和精对；SessionDetail 在内容层关闭下印 "metrics-only timeline … re-scan with `--content`"；Sessions 列表顶出 §6 的"content layer off"与 §18 item 6 的 73.4% host-split 两条横幅。**取证是 a11y snapshot + `main.innerText`，没有截图** —— in-app 视口报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，指针动作不可用，展开行改用 `element.click()`，所以"看一眼像素"这件事仍欠着。
- **回归当场抓到的两处，都已修**：(1) Web Doctor 把每个 Agent 报成 `ingested-only`，与 CLI 各说各话 —— 根因是 §5.4 的依赖箭头下 `packages/server` 不可能自己 import 到 Adapter，改为 `ServerDeps.adapters` 注入（同 `capabilityCatalog`/`scan` 的路子），顺带修掉 `startServer` 重打包 deps 时静默丢注入点的隐患，6 条新测试钉住两边一致。(2) `agl` 页面一度"卡在 loading"：控制台 17 条错误显示是**我重启服务端那一刻**浏览器拿到的 408 + `ERR_CONNECTION_RESET`，不是路由卡死 —— 但顺着量下去确实抓到一个真的量级问题，见下两条。
- **`/api/projects` 在全历史下 66.5 s → 33.9 s，输出逐字节不变**：进程内计时（不是 HTTP 计时）拆出的账：`top` 22.3 s + `sub` 21.0 s + `modelMix` 10.1 s + `costView` 13.9 s + `json_extract(metadata,'$.cwd')` 分组 1.5 s。两处修法都不碰语义：`QuerySpec.totals:false`（行-only 的调用方不再为一个会被丢掉的数字把 stage-1 折叠连 `computeTotals` 重跑一遍；默认 true，故既有调用方逐字节不变）与 `openDatabase` 的三个读 pragma。A/B 取证：同一库、同一 filter，旧代码的 HTTP 响应与新代码的进程内响应经 `jq -S` 归一后**完全相同（各 52,170 字节）**，路由 66.5 s → 33.9 s。UI 默认窗口是 30d， Projects 页实际 2.9 s 出图。CLI 与 Web 同口径核对：`agl sessions --since 30d --agent claude-code --limit 5` 与 `/api/sessions` 同参数逐字段一致（5 条会话、tokens 0、cost `n/a` 两边一字不差）→ §14 未破。
- **立方体在 343k 事件下的量级（未修，M7 候选）**：一条 §18 stage-1 折叠 = 对 343,303 行按 `(agent_id, 64 字符 request key)` 建临时 B-tree，且 `MAX(e.id)` 要比较 64 字符文本 —— 实测 2.86 s/遍；stage-2 用 `e.id = r.rep_id` 回填维度再 2.57 s（`EXPLAIN QUERY PLAN` 是 `SEARCH e USING INDEX sqlite_autoindex_events_1`，计划已是最优，pragma 调到 1.7× 就到顶了）。一次全历史 `/api/projects` 至少 4 遍折叠，故仍 ~34 s。方向是把 §18 的 stage-1 落成持久表（`requests(agent_key, req_key, rep_id, tokens…, 维度列)`，写路径增量维护），token 类路由从"扫 343k 现折"变成"扫 ~250k 预折叠行"；那要动 §6 schema 与 §4.2 幂等，属里程碑级，不在 M4 验收里 → 记录，不硬塞。
- **两条只有浏览器里看得见的事实（第 1 条已修，2026-09-22）**：(1) SessionDetail 原先按 `raw_seq`（源文件自身顺序）排，会话跨多个 source 文件时（§18 row 3）时间来回跳 —— 实测 `70a1bb4e…` 644 事件里出现 19:16:12 → 20:25:42 → 20:29:17 → 19:16:12。**当时记的"CLI 同序，所以不是 §14 分歧"是错的**：`packages/server/src/sessions.ts` 用 `ORDER BY raw_seq IS NULL, raw_seq, timestamp, id`，`apps/cli/src/commands/sessions.ts` 用 `ORDER BY timestamp, raw_seq, id`，两边本来就在讲两个故事。现由一个共享装载函数收口（`packages/storage/src/query-shape.ts:loadSessionEvents`，`ORDER BY timestamp, raw_seq IS NULL, raw_seq, id`：跨源按时间，同源并列时按源内序），CLI 与 Web 各自断言"渲染出的 id 序列 = 该函数的输出"（`packages/server/test/session-order.test.ts`、`apps/cli/test/session-order.test.ts`），顺序再也无法单独漂移。`agl export` 的排序与规范序仍差在 `raw_seq` 为 NULL 的并列位置上（导出不影响读图，未动）。(2) 六个 Adapter 的 timestamp 兜底都是 `record.occurredAt || ctx.now()`（`adapters/*/src/normalize.ts`），无日期且无 mtime 的行会被**写入摄入时刻且不留痕迹**。本机证据：会话 `8cbe4dc8…` 的 10,935 个 claude-code 事件里 **2,158 个挤在同一秒**，且 `MAX(timestamp)` 恰等于我跑 `scan` 的那一刻 —— 于是 `--since 30d` 把陈年行算进当前窗口、"last seen"读作 1h ago。按 §5.2 这该是"标出来的猜测"而非静默猜测：待办是给这类事件打 metadata 标记并让 doctor 报计数。
- **本机 token / 成本覆盖率（呈现核对结论，不是缺陷）**：qoder 的 36,805 事件 `usage_source` 全为 `missing` —— Qoder 只记 credits 不记 token，Adapter 把这批行标成 `zero-usage`(5,633) / `assistant-without-usage`(7,600) 而不是伪造 token（`adapters/qoder/src/normalize.ts:330`），所以 Agents 页 qoder 读作 `0 tokens / n/a EST. API`；workbuddy 同理（52 事件、`costReported: null`，`adapters/workbuddy/src/sqlite.ts:182` 明写"`session_usage` 的列名未实测，拒绝对号入座"）。**据此修正 §18 row 1 的本机证据面**：`cost_reported` 今天有两个产出者 —— OpenCode 487 行（$0.958）与 pi 160 行（$0.123）；被点名的 WorkBuddy 是 0 行。
- **§18 row 1 的"查询优先级 reported > computed"落地方式（2026-09-22）**：此前立方体只有两个并列指标（`cost_reported` 原样 SUM、`cost_api_equiv` 按 token 计价），选哪个都是错的 —— 选 reported 就丢了不报成本的 Agent，选 computed 就给 OpenCode 的一次工作付两遍钱（它自己报的 + 我们按表价的）。新增 `cost_total`，在**请求粒度**上解优先级：stage-1 折叠里 `MAX(e.cost_reported) AS rep_cost`（于是 §18 的 per-agent 口径对"报表"和"token 列"同样生效，重复行只算一次），计价半边只对 `rep_cost IS NULL` 的请求走价表 ⇒ 一条请求要么用报的、要么用算的，永不叠加。NULL 规则照 §8：一组两样都没有 → NULL；有一样没价 → 整组 NULL，绝不落到 $0。计价那半边取 `actualUsd`（跟随声明的计费模式），所以订阅 Agent 在 `cost_total` 读 $0、在 `cost_api_equiv` 读它真实的 token 价值 —— §8 要的"同时呈现实际花费与等价 API 价值"就是这两列。CLI（`agl usage` 表列 + total 行）、Web（Overview 的 Cost 卡、Doctor 的成本表、`/api/cost` 的 `totalUsd`/`totalPartial`）与裸命令摘要同口径。测试：`packages/query/test/query.test.ts` 的"§18 row 1 fused cost_total metric"7 条（含 double-count、per-record 口径、NULL 规则、与 subagent 开关的交互、按计费模式分列）+ `packages/server/test/cost.test.ts` 4 条。
- **§18 row 3 的"显式开关"补上了入口（2026-09-22）**：过滤器本身早已存在且带测试（`spec.ts` 的 `includeSubagentThreads`，折叠前丢 `metadata.subagentThread`），但**没有任何调用方能够到它** —— CLI 无 flag、`request-spec.ts` 不认这个参数、Web 从不发。现补 `agl usage --no-subagents` 与 `?subagents=include|exclude`（非法值 400），且被排除的总数会自己说明（total 行尾 `· subagent threads excluded (--no-subagents)`，`--explain` 打 `includeSubagentThreads=false`），否则就是一次无声换口径。**默认仍为包含**：`spec.ts` 里那段"改默认会让既有数字整体漂移、§18 要的是开关不是隐藏"的理由成立，且 `reconcile-ccusage` 这条实数据回归在默认值上仍是零偏差。
- **§8 两处补齐（2026-09-22）**：(1) `local` 模式过去在查价表之前就直接返回 `actualUsd 0 / apiEquivalentUsd 0`，于是一台 Ollama/vLLM 的真实 token 量在屏幕上等于零 —— §8 表格写的是"tokens 有价、cost 恒为 $0"，缺价检查现在先跑，任何模式下无价模型读 `n/a` 而非 $0。(2) "让用户在设置里按 Agent 声明计费模式"完全没有入口，只有手改 `config.json`。现由 `packages/pricing/src/billing-config.ts` 一处收口：`agl pricing billing list|set|clear`、`GET/POST /api/settings/billing`、Settings 页的下拉，三处写同一个文件，读的仍是立方体的 `billingModeFor`（`--serve` 运行中改设置无需重启即生效）→ §14 不裂。测试 32 条（billing-config 10 / cost 9 / server 6 / CLI e2e 7）。
- **Web Doctor 补齐到 §11 的深度，并改掉一个 §14 违背（2026-09-22）**：served doctor 过去调 `event-model/dedupe.ts` 的**全局 `request_max`** 折叠，而 CLI 用每个 Agent 持久化的 §18 口径 —— 同一个库两边能报不同 token 数，被这两个口径坑得最狠的正是 Codex/OpenCode（它们不按请求折叠）。检查项本身下沉为 `packages/storage/src/doctor-checks.ts` 的纯函数（parser_version 漂移、subagent 父链孤儿、gone/rotated 保留、mixed-fold 告警），两边跑同一份代码而不是各抄一份；`history.jsonl` 的会话存在性恢复**故意留在 CLI**，它需要 Adapter 发现，硬搬到 server 就得给 `ServerDeps` 加输入并破 §5.4。新增一致性回归 `apps/cli/test/doctor-agreement.test.ts`（同一临时库，CLI 打印的 raw sum→折叠值必须等于 `/api/doctor` 的数）。
- **§12 导出腿补齐，顺带挖出一个真 bug（2026-09-22）**：`--push <otlp-url> [--push-header]` 把 `--format otel` 打的同一批 span 用全局 `fetch` 分批 POST 给 OTLP/HTTP 接收端（Langfuse / Phoenix 都吃这个），不另建模型；没传 flag 一个字节都不出，URL 带凭据直接拒，非 2xx 报"哪条 URL、多少 span 没送出去"。OTel 映射与 CSV 补上 JSONL 早就带的 `agentlens.cost_reported`/`cost_source`/`thread_id`（先查过：官方 semconv 没有成本属性，`gen_ai.usage.cost` 是 Traceloop 未注册项，故走本包私有前缀），既有属性名逐字节不变、只追加。**挖到的那个**：导出走 `SELECT * FROM events`，而 `events` 只有 `model_rowid` ⇒ 过去每一行 jsonl/csv/otel 的 provider 与 model 都是空的，用户拿出去的东西缺了最关键的分组维度。改 `LEFT JOIN models` 并加了钉住整份输出形状的测试。
- **§9 裸命令改为默认起服务（2026-09-22）**：`agl` 一直是"扫描 + 摘要"，服务藏在 `--serve` 后面，help 里还写着"server 是后续里程碑"（M4/M6 早已完成）。现在终端下一次跑到底就是 §14 那页体验（扫完 → 摘要 → `Dashboard → …` → 常驻）。例外是**非交互**：管道和 CI 里拿不到 URL 也没法 Ctrl-C，那种情形起一个阻塞服务比不起更糟，所以是否交互决定默认，`--serve` 强制起、`--no-serve` 强制不起，四条测试（`apps/cli/test/bare-serve.test.ts`）钉住这四种组合且从不真绑端口。
- **§13 的一处未记录偏差（本轮补记）**：技术选型表写的是"Vite + Svelte 5 + Tailwind + Recharts"，实际交付里没有 Recharts，图是手写的 `Donut/Sparkline/Bars.svelte`（`apps/web/src/lib/ui/`）。不是省事：真实数据下（§19 那条 343k 量级）要钉住的是"tooltip 不被裁、宽表能滚、Escape 关抽屉、hover 有响应"这几件，库的默认行为恰好在这些点上要绕。偏差仅止于呈现层，数据仍全部来自 §7 立方体的 REST + SSE。
- **§8 的 `pricing_gap` 记录：不落表，保持现算（决策）**：§8 要"缺价模型 → cost = NULL + `pricing_gap` 记录，doctor 报告"。落库一张 gap 表会让"缺价"这件事有两个真相来源 —— 缺不缺价取决于**当前**价表，用户跑一次 `agl pricing update` 之后昨天那条记录就成假话；现在的实现是从价表 + 已见模型（`models` 表）现算，`doctor` 的 pricing gap 一栏与 Overview 的缺价横幅因此永远反映"此刻补不补得上"。语义（绝不按 $0、缺口显眼）成立，载体从"记录"换成"派生" → 记为偏差，不硬塞。
- **第 7 个 Adapter（ZCode）落地，三条计划级假设被证伪（2026-09-22）**：`adapters/zcode`（5 个 SQLite 源、fixtures、82 个单测）+ `docs/research/{zcode.md,probe-zcode.mjs,reconcile-zcode-ccusage.mjs,ccusage-zcode-baseline.json}`。真库端到端：11,491 事件 / 0 解析失败 / 四字段与 `ccusage zcode` **逐位相同**、重扫 append 0（§4.2 与 rowid 高水位在真库规模成立）。本轮逼出的三条修正性认识，都超出 §18 已有各行覆盖的范围：
  1. **§18 row 4 的"方言映射只在 Adapter 内"必须再叠一层语义判定**：ZCode 的列名是 Anthropic 方言（`cache_read_input_tokens`/`cache_creation_input_tokens`），语义却是 Codex 那一类（`input_tokens` **已含** cache_read）。实测 `computed_total == input+output` 在 1,395/1,395 行成立、`cache_read > input` 0 行，且 ccusage 的 `inputTokens` 恰等于 `input − cache_read`（166,230,363 − 158,848,192 = 7,382,171）。⇒ **看列名会选错口径**，"input 是否含 cache" 的单测断言（row 4 已要求）必须连"列名方言"一起钉，因为二者可以互相矛盾。
  2. **§18 row 2 的 rollup 风险上限被抬高**：同一次调用的 token 在 ZCode 里存了 **5 份**（`model_usage` / `part.step-finish` / `message.data.tokens` / `turn_usage` / `session_target.tokens_used`），其中 `step-finish` 与 `model_usage` 逐字段相等 1355/1355。把它当第 6 个源会 +100.0%，逐字段照搬 cache 会 +94.8%。更硬的一课是**载体的可变性**：`part`/`message` 行是 UPDATE 复用同一 rowid，而 rowid 高水位意味着已扫过的行永不重读 ⇒ 把 usage 或工具结果挂在那上面，数字会变成"取决于扫描时机"。所以 `model_usage`/`tool_usage` 这两个 insert-only 表才是唯一可信账本，`subagentsIncluded` 则是由 ccusage 头条**含**子代理量出来的 true（排除会 −9.3%）。
  3. **§5.3 的"宿主区分"在 ZCode 上换了伪装**：数据全在 `~/.zcode/cli/` 下，但 `session` 25 列无任何 entrypoint 标记，而 `v2/tasks-index.sqlite.tasks.task_id` 命中 **10/10 根会话** ⇒ 本机 100% 流量其实来自桌面 App（版本 3.11.2/3.12.1，引擎版本另线 0.16.5）。**路径名不是宿主证据**，这与 §六 抓到 ccusage 把 96.8% Claude Desktop 记作 CLI 是同一类错，只是这次陷阱写在目录名里。宿主切分本轮**主动放弃**：`host_id` 是逐事件列，跨库把 task 集合并进来需要另一条源先于行到达，事件模型不支持这种依赖，硬做要改结构 ⇒ 违反 §15 M5 的"Schema 冻结"。取 `host_id='zcode'` 单宿主（与 §18 row 6 对 OpenCode 的处理同构：无列就不臆造）。
- **ZCode 留下的三笔欠账（都记在 `docs/research/zcode.md` §八）**：(1) 纯 CLI 用户的形态未测——能不能做宿主切分取决于此；(2) `parent_event_id` 对 3,433 条子代理事件全 NULL，doctor 因此套用 §4.4 row 8 的"没有外键可退"文案，**这句对 ZCode 是反的**：父子是确定性外键（`session.parent_id`），只是事件级父锚点在另一个源里、拿不到父行 rowid。可修（session SELECT 自连接 `parent_id` 反推父 `session.start` 事件 id，同源可确定），但 `sessionId` 已折叠到根会话、时间线在会话粒度已经正确，为一条树边引入自连接不在本轮范围内；(3) 对账回归未进 CI——claude-code 有 `apps/cli/test/reconcile-ccusage.test.ts` 那种"真语料 + naive 反证"，ZCode 要有同等项就得把脱敏库快照放进仓库（真实库 30MB 且含提示词正文，不能进），所以那是**夹具工程**而非脚本工程。
- **`Detection.agentVersion` 在 WAL 库上必然拿不到版本**（ZCode 与 OpenCode 同一表现，`agl doctor` 都显示 `v?` 并列"只嗅探头部、一个都没打开"）：这是 §18 row 7 的既定代价而非缺陷，逐会话真实版本走 `session.version` 在摄入时落 `metadata`。桌面 App 版本不挂到逐会话事件上——那是机器全局事实，挂上去就是臆造范围。
