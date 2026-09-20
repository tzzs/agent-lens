# AgentLens · 方案 v2

> 定位不变：**The Activity Monitor for AI Agents** —— 零侵入发现本机 Agent，读取它们已有的本地日志，统一成事件，回答"这台机器上的 Agent 到底干了什么、花了多少、花在哪"。
>
> 本文档取代 `plan.md` 作为实施依据。`plan.md` 保留为原始思路存档。
> v2 相对 v1 的改动集中在：事件分层、确定性 ID 与幂等、Adapter 契约（含格式漂移）、Pricing 外部依赖、隐私开关、以及**优先级重排**（Project 视图与 Session Timeline 提前，Token/Cost 降为及格线）。
>
> **v2.1（2026-09-21）：已按 `docs/research/claude-code.md` 的实测修订。** 实测样本 92 个 JSONL / 68,314 条记录，推翻了 v2 关于 usage 剥离的假设，并新增三条会导致数字根本性错误的规则（`requestId` 去重、`entrypoint` 身份拆分、worktree 项目归组）。
> **v2.2：ccusage 对账通过（口径四字段 0.0% 偏差），同时据此收缩了 §1 的差异化主张** —— ccusage 已覆盖 18 个 Agent CLI 并有 per-project 报表，重心因此移到 Session / Capability / 规范化实体三件事。被修订处均标注「实测」。

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

### M2 · Codex + 抽象证伪（2–3 天）
Codex 与 Claude Code 差异最大（rollout 文件、无 skill 概念、session 边界不同）。目的**不是加支持，是逼 Event Schema 改第二轮**。改完 Schema 冻结，此后只允许加枚举值、不允许改结构。

### M3 · Cost + doctor（2–3 天）
Pricing 快照与 `pricing update`、三种计费口径（§8）、`doctor`（§11）、`agentlens status`。
**新增硬性验收（对账副产品）**：`reconcile-ccusage.mjs` 升级为回归测试 —— 同一窗口 AgentLens 的 token 与成本必须与 `ccusage claude daily -j -O -z UTC` 零偏差；成本锚点取本机实测的 **$667.96 / 30 天**。ccusage 只作 devDependency 级别的测试工具，不进产品依赖。
> doctor 不延后：它决定第一批用户是否相信数字。而对账 CI 是"我们相信数字"的机器化版本。

### M4 · Web：Overview + Session Timeline + Capability + Project（4–6 天）
顺序按 §1 收缩后的主张：Session 与 Capability 先于 Project，Project 先于 Agent 页 —— 前者是 ccusage 完全没有的层。此阶段同时引入隐私开关（`--no-content`）。

### M5 · Qoder / OpenCode / WorkBuddy（3–5 天）
真正验证 Adapter 架构是否通用。若此时仍需改 Schema，说明 M2 的证伪没做够——这是本计划唯一允许的"返工信号"。

### M6 · watch 常驻 + 实时看板（2–3 天）
SSE 增量、MCP 插件的 `capabilities()` 静态清单（`skills`/`mcp` 命令的"装了但没用过"视角）。

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
