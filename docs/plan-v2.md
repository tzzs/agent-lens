# AgentLens · 方案 v2

> 定位不变：**The Activity Monitor for AI Agents** —— 零侵入发现本机 Agent，读取它们已有的本地日志，统一成事件，回答"这台机器上的 Agent 到底干了什么、花了多少、花在哪"。
>
> 本文档取代 `plan.md` 作为实施依据。`plan.md` 保留为原始思路存档。
> v2 相对 v1 的改动集中在：事件分层、确定性 ID 与幂等、Adapter 契约（含格式漂移）、Pricing 外部依赖、隐私开关、以及**优先级重排**（Project 视图与 Session Timeline 提前，Token/Cost 降为及格线）。
>
> **v2.1（2026-09-21）：已按 `docs/research/claude-code.md` 的实测修订。** 实测样本 92 个 JSONL / 68,314 条记录，推翻了 v2 关于 usage 剥离的假设，并新增三条会导致数字根本性错误的规则（`requestId` 去重、`entrypoint` 身份拆分、worktree 项目归组）。
> **v2.2：ccusage 对账通过（口径四字段 0.0% 偏差），同时据此收缩了 §1 的差异化主张** —— ccusage 已覆盖 18 个 Agent CLI 并有 per-project 报表，重心因此移到 Session / Capability / 规范化实体三件事。被修订处均标注「实测」。
> **v2.3（2026-09-21）：实测第二轮见 §18。** Codex / Qoder / OpenCode / WorkBuddy 的测量证伪了 §3.1 的「去重是全局不变量」、§4.1 的「一文件一 session」与 §8 的「日志里没有成本字段」三条，并发现只读打开 WAL 模式的第三方库会产生写入副作用。M2 的 Schema 第二轮修订因此提前，落地清单在 §18 末尾。
> **v2.4（2026-09-23）：§8 增加 OpenRouter 兜底价格源。** 只做缺口补价、永远排在 litellm 之下，附本机实测数字。

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
│   └── web/                 # Vite + Svelte 5 SPA，由 server 以静态资源托管
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
│   ├── workbuddy/
│   ├── pi/
│   └── zcode/
└── docs/
```

依赖方向严格单向：`adapters → event-model`，`core → event-model`，`cli/web → query → storage`。Adapter 之间不得互相引用。**这条现在有测试**：`packages/event-model/test/dependency-arrows.test.ts` 从文件系统枚举包（新增第 8 个 Adapter 自动纳入），只读 `src/`（测试允许直接建库），逐条断言：event-model 不 import 任何内部包、Adapter 之间零引用、Adapter 是叶子（只能用 event-model 与 collector）、core 不得反向 import Adapter、storage/pricing 不依赖其上层、query 不依赖 server/cli/web。故意植入的违规会被抓住（实测报 `adapter-pi → adapter-codex`、`storage → query`）。

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
- **兜底源：OpenRouter `GET /api/v1/models`**（免鉴权，实测 444 个模型）。`agl pricing update --source openrouter` 把它写成同目录的第二个快照文件 `price-snapshot-openrouter.json`，`loadMergedPricing` 只用它补主快照**没有价**的模型（`PricingTable.withGapFill` 按模型名判定，所以它既不会改写 litellm 的数字，也不会让「只按模型名匹配」那条分支变成「多 provider → 无价」）。它**永远排在 litellm 之下**：OR 顶层 `pricing` 是某条转售路由的报价（同一模型 `/endpoints` 里有 3 档价），而本节的"等价 API 价值"要的是厂商列表价——实测两边都有价的 20 个模型里 4 个不一致，最大 2 倍。必须过滤的行：`:batch`(67) 与 `:free`(21，0 价) 会被 `normalizeModelName` 折到基名上，`~*-latest`(18) 是滚动别名；不收进来就会让半价或 $0 赢得查询，正是本节禁止的那种错。
- **三种计费口径**（v1 完全没讨论，但这是真实场景的主要成本构成）：

| 模式 | 成本计算 | 说明 |
|---|---|---|
| `api` | tokens × price | 默认 |
| `subscription` | 显示 $0，另算"等价 API 价值" | Claude Pro / ChatGPT Plus：真实现金流是固定月费 |
| `local` | tokens 有价、cost 恒为 $0 | Ollama / LM Studio / vLLM |

UI 必须同时呈现"实际花费"和"等价 API 价值"，并让用户在设置里按 Agent 声明计费模式。**否则重度订阅用户看到的数字毫无意义，而这正是我们的主力用户画像。**

- 缺价模型 → `cost = NULL` + `pricing_gap` 记录，`doctor` 报告；**绝不当成 $0**（$0 会被误读为"本地模型"）。
- 实测依据：Claude Code 日志**不含任何成本字段**（20,043 条带 usage 的记录里 `costUSD` 出现 0 次），所以成本 100% 依赖本地价格表；且本机 4 个月内出现 7 个模型标识（`claude-sonnet-5` 9,236 / `claude-opus-4-8` 2,390 / `claude-sonnet-4-6` 2,160 / `claude-opus-5` 1,979 / `claude-opus-4-7` 1,688 / `claude-opus-4-6` 1,614 / `claude-haiku-4-5` 882，另有 `deepseek-flash` 2 与占位的 `<synthetic>`）。**模型名会持续新增**，价格表未覆盖是常态而非异常，`doctor` 的 pricing gap 一栏必须显眼。
- 兜底源实测（v2.4，2026-09-23）：拿本机真实 store 里 token 量最大的 6 个模型标识 + 真实 token 量造库、打真实 OpenRouter 接口——litellm 无价的 `GLM-5.3-Flash`（1.63 亿 token，占本机缺口的大头）从 `n/a` → `$26.83`，litellm 已定价的 4 行数字**一字未变**，`codex-auto-review` 仍是 `n/a`（两边都没价，兜底不编造）。OR 快照共补上 274 个 (provider, model)。
- 兜底源**已知不覆盖**的两件事（不是 OpenRouter 的缺陷，是我们的 `Usage` 表达不了）：Anthropic 的 1 小时缓存写按 1.6 倍单独计价（OR 有 `input_cache_write_1h`，我们只有一个 cacheWrite 桶；`reconcile-ccusage` 里对账残留的 $47.94 正是这一项），以及长上下文档位（OR 的 `overrides[].min_prompt_tokens>=200k`，`PriceEntry.tier` 目前只是字段、`computeCost` 不看它）。

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

**状态**：✅ 完成（2026-09-21）。`event-model`（`validate.ts`/`otel-map.ts`/`dedupe.ts`/`project.ts`）+ `storage`（迁移 `001`–`005`（`004` 是 §4.3 的 `sources.sqlite_table`，`005` 是 §2 的 `machine` 单例））+ `sources` 增量器（`collector/src/incremental.ts`）+ Adapter 接口/`ParseFailure` 均在；验收①见 `storage/test/idempotency.test.ts`，②（多 block 重复 usage→单份）见 `event-model/test/dedupe.test.ts`。

### M1 · 单 Adapter 打通（2–4 天）— 全局风险最高的一步
只做 `claude-code`（含 `host_id` 的 desktop/cli 拆分）。跑通 detect → discover → 增量 parse → normalize → SQLite → CLI `usage`。
必须回答（§4.4 与 ccusage 对账已回答前四项，剩余一项待做）：
① ~~usage 是否被剥离~~ → **已证伪，100% 保留**
② ~~去重口径~~ → **已定为按 `requestId` 取 max**
③ ~~与 ccusage 对账~~ → **已完成：四字段 0.0% 偏差、逐日 15 天 1.00x**（`docs/research/reconcile-ccusage.mjs`，结果 `reconcile-result.txt`）
④ ~~宿主拆分的实际影响~~ → **已量化：全量 desktop 96.8% / cli 3.2%，不拆分误差 31.2×**
⑤ **待做：subagent 启发式归属的准确率**（抽 20 个侧链人工核对父链接），以及把上述规则实现成真正的 `claude-code` Adapter + fixtures。→ 2026-09-22 已测完：`docs/research/probe-subagent-parents.mjs`，结论与顺带证伪的"部署形态下启发式拿不到候选"见 §15 M1 状态与 `subagent-attribution.md` §10。
> M1 剩余工作因此从"探索未知"变成"把已确认的规则工程化"，可直接进入 M0。
> **禁止在此阶段并行写第二个 Adapter。** 抽象未被证伪前多加一个实现，等于固化错误。

**状态**：✅ 完成，pending 项已收口（2026-09-22）。`adapters/claude-code`（`host_id` desktop/cli 拆分、fixtures 22 份 expected）贯通 detect→discover→parse→normalize→SQLite→`usage`。①–④ 见 §1.5；⑤ 的"规则工程化 + subagent 父链取真实外键"已落地，"抽 20 个侧链人工核对父链准确率"现在有了可重跑的仓库证据：`docs/research/probe-subagent-parents.mjs`（全体 39 条侧链等距抽 20，用"侧链首条 user 正文 = 父 `Agent` tool_use 的 `input.prompt` 逐字重放"这条与外键无关的内容通道做 ground truth），结果 **17/17 可判定全对、0 例 confidently-wrong**，外键 × 启发式 20/20 一致（详见 `docs/research/subagent-attribution.md` §10）。**这一测同时证伪了一件更值钱的事**：启发式在**部署形态**下（一文件一源、`stateFor(ctx.source.id)`）拿不到跨文件的候选，本机 20 条侧链 `parent_event_id` 全为 NULL —— 规则没错，是台账的作用域错了；补齐它（按 `sessionId` 的跨源候选台账，且必须保证 §4.2 幂等与扫描顺序无关）记在 §19。

### M2 · Codex + 抽象证伪（2–3 天）
Codex 与 Claude Code 差异最大（rollout 文件、无 skill 概念、session 边界不同）。目的**不是加支持，是逼 Event Schema 改第二轮**。改完 Schema 冻结，此后只允许加枚举值、不允许改结构。

**状态**：✅ 完成。`adapters/codex`（+ `usage-granularity`/`cache-tokens` 单测）逼出 Schema 第二轮（迁移 `002`），结构冻结。

### M3 · Cost + doctor（2–3 天）
Pricing 快照与 `pricing update`、三种计费口径（§8）、`doctor`（§11）、`agentlens status`。
**新增硬性验收（对账副产品）**：`reconcile-ccusage.mjs` 升级为回归测试 —— 同一窗口 AgentLens 的 token 与成本必须与 `ccusage claude daily -j -O -z UTC` 零偏差；成本锚点取本机实测的 **$667.96 / 30 天**。ccusage 只作 devDependency 级别的测试工具，不进产品依赖。
> doctor 不延后：它决定第一批用户是否相信数字。而对账 CI 是"我们相信数字"的机器化版本。

**状态**：✅ 完成。`packages/pricing`（litellm 快照 + 三计费口径 `cost.ts:computeCost`）、`doctor`、`status` 均在；对账回归 `apps/cli/test/reconcile-ccusage.test.ts` 已进套件（本轮套件 856 绿）。

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
Replay · 告警（"agentx 今日成本 +240%"）· 效率分析（按 skill/phase 归因）· 单二进制分发 · Team。

导出（§12，OTel/CSV/jsonl + OTLP push）**已提前交付**，不在 M7 列表里：它是 M4 那轮补 §14 口径时顺手把欺扬的最后一条腿补齐的（导出走 `SELECT * FROM events` 而 `events` 只有 `model_rowid` ⇒ 每行 provider/model 全空，见 §19）。

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

**五项已全部实测完成**（下表逐条给出结论与出处；`docs/research/` 每篇都带可重跑的 probe 脚本，夹具为脱敏样本）：
1. ✅ **与 ccusage 同区间对账**（2026-09-21 完成，`reconcile-ccusage.mjs`）→ 口径 B 与 ccusage **四字段 0.0% 偏差、逐日 15 天 1.00x**；分组键必须 `requestId`（非 `message.id`），取值必须 `max`（非首块）。副产品：ccusage 能力边界远超预期，已据此改写 §1。
2. ✅ **Codex `rollout-*.jsonl`**（`docs/research/codex.md` + `probe-codex.mjs`/`probe-codex-2.mjs`）→ **无** Claude Code 那种"一条 message 多 block 重复 usage"，但 usage 有**三种粒度嵌套**，按 cumulative 字段求和虚高 **~1971×**；subagent 线程与 ccusage 口径分歧 **+77%**。⇒ §18 row 2 的 `last_call_sum` 与 row 3 的 `subagentsIncluded=false` 都是从这条量出来的。
3. ✅ **Qoder / OpenCode**（`docs/research/qoder-opencode.md`）→ Qoder **不是** SQLite 而是 JSONL，且结构上是 Claude Code 的分叉（逐字段几乎相同）另带两个事件模型未覆盖的扩展；OpenCode 是 SQLite、**只读可开且不产生 `-wal/-shm`**。
4. ✅ **WorkBuddy**（`docs/research/workbuddy.md`）→ 数据根与格式已定位；关键安全发现是**只读打开 `workbuddy.db` 会创建 `-wal`/`-shm`**，故拒绝直开、改用本地 JSONL trace 作补充源；`session_usage` 的列名未实测就拒绝对号入座（宁可贡献 0 事件也不臆造）。
5. ✅ **能力面逐 Agent 实测**（`probe-capabilities.mjs`，含 pi/zcode 两个后补 Adapter）→ MCP server 名、compact 事件、hook 的可见性各家不同，落为 §7 的 capability 维度与 `doctor-caps.ts` 的"装了 vs 用过"三态；测不出来的一态印 `?`/`−` 而不是 0。

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

只记已核实的事实与所在文件；每条自带状态，没闭环的在该条里明写"仍开/仍欠"。**那句"其余各条仍未修复"已经过期**：写下它之后，WAL 读取通道、`agl projects` 标签、会话时间线排序、摄入时间 provenance、三条 CLI↔server 重复规则、NULL 头条下限、跨源 subagent 父链、会话标题投影、立方体量级（本节"持久 stage 1"那条）都已各自闭环并在原条里改写；今天仍开的集中在三处 —— ZCode 的 per-session 宿主切分（缺的是一台装了独立 `zcode` 命令行的机器，不是再多一轮分析）、"看一眼像素"的截图取证、以及全历史路由剩下那几秒里属于 stage 2 与多次扫描的部分。

- **OpenCode 读通（原"当前贡献 0 事件"已闭环）**：其库 `~/.local/share/opencode/opencode.db`（44 MB、WAL）现在经快照副本摄入 —— `packages/collector/src/sqlite-snapshot.ts` 把库 + 其 `-wal`（从不含 `-shm`，SQLite 自建）复制进 `<--db 所在目录>/snapshots`（`apps/cli/src/commands/scan.ts:snapshotsDirFor`），折成回滚模式单文件后由 `ParseCtx.storePath` 交给 `adapters/opencode/src/parse.ts`；`safety.ts:assessReadOnly` 的"拒绝任何 WAL attach"规则原样保留，只是它拒的是对方的文件、读的是我们的副本。**复制不是打开。** 本节 2026-09-21 记下的方向（"以 `copyFile` 复制成单文件快照、复制进 AgentLens 数据目录后再读"）已于 c4a2cd3 / 77541fc / eff1183 落地，同一条里"截至本次快照 `grep copyFile packages/collector/src` 无命中"的备案作废。本机实测（2026-09-22 复测）：对活库一次摄入 **3,391 事件、0 解析失败**（该库全量本身只有 531 条 message、2,242 条 part、5,401 条 event 行），跑前后库与两个 sidecar 的 size/mtime/inode 逐字节相同，快照目录里恰好一份 44,060,672 字节回滚模式副本 —— 3 个 `sources` 共用，且没有 `-shm` 副本。
- **`-shm` 写入证据**：无 OpenCode 进程存活时，跑一条 `agl` 能力命令的瞬间，`~/.local/share/opencode/opencode.db-shm` 的 mtime 就跳到那一分钟；`verifyNoSidecars`（`adapters/opencode/src/safety.ts:119`）**2026-09-22 之前**只检测新建的 sidecar；c50e91a 之后它同时对既有 `-shm` 的 size/mtime 变化报 `(rewritten)`（`safety.ts:125`，zcode 同构 `:117-124`），"检不出对既有 `-shm` 的修改"这半句已过期，保留的仍是"因此绝不直开 WAL 库"这一动因。此即上一条仍然拒绝任何 WAL 直开、并且副本只抄 `-wal` 不抄 `-shm` 的动因。
- **无 `snapshotDir` 时的拒绝仍看得见**：WAL 拒绝从"唯一通道"降级为"未配置快照目录时的兜底"，仍是落库事实而非静默零：扫描结束后按库去重成一行（`apps/cli/src/commands/scan.ts:refusalLines`，形如 `! opencode ~/.local/share/opencode/opencode.db not read (3 sources): …`），并逐源以 `status='error'`、offset 不动存库（`packages/collector/src/orchestrator.ts:scanSqliteSource` 的 `WalModeRefusedError` catch 分支）；`doctor` 逐库打印同一条原因。
- **三源共一个库，副本必须按库路径 keyed**：OpenCode 的 3 个 `sources` 行指向同一个 `opencode.db`（实测 `select path, count(*) from sources where agent_id='opencode'` 是 3 行同一 path），按 `source.id` 命名副本会把那个 44 MB 文件抄三份。`sqlite-snapshot.ts:snapshotPathFor` 因此用 `sha256(storePath)` 做名字，一个库一份、三张表读同一份折叠文件 —— 本轮抓到并已修正的缺陷。
- **WAL 测试夹具必须留住写连接**：`node:sqlite` 关掉最后一个连接时 SQLite 会 checkpoint 并删掉 `-wal`，于是夹具退化成"没有 sidecar 的 WAL 头"，测不到活库形态。`adapters/opencode/test/wal-snapshot.test.ts`（`fixtures/build-host.ts` 的 `retainWriter`）与 `packages/collector/test/sqlite-snapshot.test.ts`（`const writer = new DatabaseSync(dbPath)`）各自握着一个未关闭的写连接，直到断言做完。
- **capability 维度陷阱**：`packages/query/src/engine.ts:capNameSql` 对别的 kind 的事件返回 `''`，故不带 `capabilityType` 过滤的 capability-dim 查询会把整库塌成一个 "(unnamed)" 桶、并把库大小当计数。CLI（`apps/cli/src/commands/capabilities.ts`）与 Web Usage 页（`apps/web/src/lib/api.ts:withCapabilityType`）已各自补 `capabilityType` 过滤并加测试；**该陷阱对任何新的立方体调用方仍然生效**，故写此备案。
- **`agl` bin 形态**：入口 `apps/cli/src/command-exec.ts` 是带 shebang 的 TS 文件，靠 `--experimental-transform-types`（`packages/pricing`、`packages/server` 用了 parameter property），strip-only 的 Node 跑不动；`#!/usr/bin/env -S node …` 这种多参 shebang 在 Windows 上不适用。
- **`agl projects` 标签可读性（已处理）**：原先 `cmdProjects`（`apps/cli/src/commands/capabilities.ts`）直接把 64 位 sha256 project hash 当标签渲染。现由 23f3591 + 6557ad0 两处补齐：collector 为它解析出的每个 project id 记下 `projects.canonical_root`（`apps/cli/src/commands/scan.ts:makeProjectResolver` / `recordProjectRoots`，`watch.ts` 同路径），§7 的标签优先级则收敛到 `packages/event-model/src/project.ts:projectLabel`（`display_name` → `basename(canonical_root)` → `UNATTRIBUTED_PROJECT_ID` 印成 `unattributed` → 才印 digest），并被 `packages/query/src/engine.ts`、`packages/server/src/resolve.ts`、`apps/cli/src/context.ts` 共用 —— 屏幕上印出来的就是 `--project <name>` 能接受的。`UNATTRIBUTED_PROJECT_ID` 同时上移到 event-model：此前 5 个 Adapter 各自重导一遍，第 6 份就是 §5.3 禁止的漂移。本机实测：claude-code 扫 80,463 事件后 13 个项目里 12 个带 canonical root，`agl projects` 印的是目录名；剩下那 1 个（16,882 事件、21%）无 attributable cwd，现在读作 `unattributed`，且 `agl usage --project unattributed` 正好命中这批事件。
- **M4 浏览器回归（已执行，2026-09-22）**：此前这条写的是"测试全绿但都是进程内、页面组件从未渲染过 → 待验证"。现在补上了执行。手法：真浏览器打开 `startServer` 服务的 9 个 hash 路由，背后是本机全量库（6 个 Agent、549 sources、**343,303 事件 / 450 会话**，`/api/health` 回显 `{events:343303, sessions:450, contentAvailable:false, payloads:0, loopbackOnly:true}`）。逐页看到的东西：Projects（§1 的差异化页）20 行项目 + worktree 折叠证据（`albatross ~/orca/workspaces/agentx/albatross`）+ `unattributed` 行 + 展开后 BY AGENT / MODELS / CAPABILITIES 三组明细；Settings 的 adapter 表 6 行全 `ok`（sources 95/379/64/3/2/6）、home 已涂成 `~/.claude`、pricing 432 有价 / 25 见过 / 5 缺价；Models 顶出 §8 的缺价横幅（`<synthetic>, codex-auto-review, auto, qfmodel, hy4-preview`）；Usage 就是 §7 立方体浏览器，metrics/dims 白名单逐项可点，totals（98,069 事件 / $630.46）与逐行之和精对；SessionDetail 在内容层关闭下印 "metrics-only timeline … re-scan with `--content`"；Sessions 列表顶出 §6 的"content layer off"与 §18 item 6 的 73.4% host-split 两条横幅。**取证是 a11y snapshot + `main.innerText`，没有截图** —— in-app 视口报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，指针动作不可用，展开行改用 `element.click()`，所以"看一眼像素"这件事仍欠着。
- **真像素补上了，并当场抓到一整个页面不渲染（2026-09-23）**。手法：本机 headless Chrome 153 起 `--remote-debugging-port`，用 CDP 的 `Emulation.setDeviceMetricsOverride`（1440×1000 与 430×932 两档）+ `Page.captureScreenshot{captureBeyondViewport}` 真出像素 —— in-app 浏览器这次仍然报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`（`viewport=0x0, visible=false, visibilityState=hidden`），所以"打开内置浏览器面板"仍是那条路的前置条件；跑的是 `/tmp` 里那份 APFS 克隆（398,794 事件，且它带 payloads），脚本与 PNG 都只在 `/tmp`，真数据不进仓。**抓到的缺陷不是样式问题，是死页**：`GET /api/models?since=30d` 4.2 s 就回 200，页面却永远停在 "Loading models"，CDP 里 `Runtime.exceptionThrown` 指着 `svelte.dev/e/each_key_duplicate` —— `unpriced` 列表是**按 `models` 行**产出的，而 `models` 的唯一键是 `(provider, name, tier)`、查价又忽略 tier，于是一个 `builtin:bigmodel-start-plan / GLM-5.3-Flash` 以四个 tier 进列表四次，`{#each … (modelKey)}` 撞键整页崩。**测试全绿的原因很直白**：夹具里没有一个跨多 tier 的模型。修法落在"集合的主人"身上而不是 UI：`unpricedModels` 改为按 `unpricedModelKey` 合并（events 与各 token 桶求和、`lastSeen` 取最大、`buckets` 取并集），`missingPriceModels` 因此天然唯一；CLI 的 `agl doctor` 同口径合并（本机 **12 → 8**），并且标题的分母也从 `models` 行数换成 distinct 模型数，否则"12 of 27"和页面上的"8"就是 §14 的又一道裂。回归测试在 `packages/server/test/cost.test.ts`：同一模型三个 tier、价目查不到 → 集合 1 行、`events=3`、`input` 是三 tier 之和。修完再截一次图，横幅如实写 "8 models have no price at their last-seen date"。**像素还看见两处呈现层欠账，只记录不修**：430 px 下 Projects 有 37 个元素横向溢出，agent chip 被容器**硬切且不带省略号**（读起来像渲染 bug 而不是截断），也没有"这张表可以横滚"的视觉线索；Overview 的 Est. cost 卡底把"起止日期 + peak + no price in 2"三段挤进同一行，中间那段几乎贴上日期。
- **回归当场抓到的两处，都已修**：(1) Web Doctor 把每个 Agent 报成 `ingested-only`，与 CLI 各说各话 —— 根因是 §5.4 的依赖箭头下 `packages/server` 不可能自己 import 到 Adapter，改为 `ServerDeps.adapters` 注入（同 `capabilityCatalog`/`scan` 的路子），顺带修掉 `startServer` 重打包 deps 时静默丢注入点的隐患，6 条新测试钉住两边一致。(2) `agl` 页面一度"卡在 loading"：控制台 17 条错误显示是**我重启服务端那一刻**浏览器拿到的 408 + `ERR_CONNECTION_RESET`，不是路由卡死 —— 但顺着量下去确实抓到一个真的量级问题，见下两条。
- **`/api/projects` 在全历史下 66.5 s → 33.9 s，输出逐字节不变**：进程内计时（不是 HTTP 计时）拆出的账：`top` 22.3 s + `sub` 21.0 s + `modelMix` 10.1 s + `costView` 13.9 s + `json_extract(metadata,'$.cwd')` 分组 1.5 s。两处修法都不碰语义：`QuerySpec.totals:false`（行-only 的调用方不再为一个会被丢掉的数字把 stage-1 折叠连 `computeTotals` 重跑一遍；默认 true，故既有调用方逐字节不变）与 `openDatabase` 的三个读 pragma。A/B 取证：同一库、同一 filter，旧代码的 HTTP 响应与新代码的进程内响应经 `jq -S` 归一后**完全相同（各 52,170 字节）**，路由 66.5 s → 33.9 s。UI 默认窗口是 30d， Projects 页实际 2.9 s 出图。CLI 与 Web 同口径核对：`agl sessions --since 30d --agent claude-code --limit 5` 与 `/api/sessions` 同参数逐字段一致（5 条会话、tokens 0、cost `n/a` 两边一字不差）→ §14 未破。
- **立方体在全历史路由上的量级：已落地为持久 stage 1（2026-09-23，d5e8933 读路径 / 38f412e 写路径 / 65166c8 体检）**。原判断是"一次全历史 `/api/projects` 至少 4 遍折叠 ⇒ ~34 s，方向是把 §18 的 stage-1 落成持久表"。现在表落地了：迁移 `008_persisted_request_fold.sql` 建 `requests(agent_key, req_key, rep_id, 折叠值, 跨度证书, 代表行的维度列)` + `requests_state`，`migrate()` 里 backfill（§6：升级不要求任何人重扫），写路径的 §5.3 修复、`prune`、`setAgentAggregations` 三处增量维护，`SNAPSHOT_TABLES` 收进两张表所以既有幂等断言顺带断言了派生表。**先记账一条被推翻的前提**：~34 s 已经不是现状 —— 本机库长到 398,794 事件后，"每 scope 只物化一遍"（`fold-cache.ts`）+ 006 的那条索引 + pragma 已把它压到 ~6 s，这条理由本身不再支撑"必须持久化"，持久化的理由只剩"CLI 与全历史第一遍"。测量（`docs/research/probe-request-fold.mjs`，APFS 克隆 `/tmp`，两臂交错，best-of-5，七条路由逐字节相同）：三条 **declined** 路由（窗口 + 有 fold scope，两臂跑同一份代码）给出 x0.88 / x0.90 / x0.94，即本机噪声带约 ±10%；真正走上表的四条是 `/api/projects` 全历史 6167 → 4717 ms（**x1.31**）、`usage --by model` x1.53、`usage --by day` x1.20、`cube projects` x1.12，全部在噪声带之上。写路径代价：20,000 行重摄入 736/804 ms → 950/1015 ms（**+26~29%**，16,015 个组）。**一次方法论自打脸**：best-of-2 时 `/api/projects (full)` 读作 x0.80"更慢"，我把同一探针跑到 best-of-5 才看清它是 x1.31 —— 没有空跑对照的比值在这台负载 ~20 的机器上不构成结论（与 §19 早先"断言 = 被测常量等于没测"同族：没量噪声带的加速比等于没量）。读的三条判据写在 `packages/query/src/persisted-fold.ts`：表里的分组指纹必须等于调用方的 §18 map、过滤必须限于 `agent`/窗口且窗口必须整组在内（`ts_count = member_count AND min_ts >= ? AND max_ts <= ?`，跨界者一律整条 decline）、`SUM(member_count)` 必须仍等于 `COUNT(*) FROM events`；`project`/`session`/`model`/`status`/`type`/`metadata`（含 §18 的 subagent 开关）任一项出现就现折。**为什么窗口不走上表**：强行走实测更慢（`/api/projects?since=30d` 2.0 → 2.2 s、`/api/overview?since=30d` 2.6 → 3.1 s），因为物化的临时表只装窗口内的组，而表要扫全量 36.7 万行 —— 所以有 scope 可复用时就 decline，CLI（无 scope）与全历史才吃这个赢面。表没有外键兜底（`rep_id` 是一个组的 MAX(id)，不是任一事件的孩子），所以 `prune` 删除后扫掉失去代表行的组，`requestFoldHealth`/`requestFoldSentence` 把"是否仍描述 `events`"印给 CLI、`/api/doctor` 与 Doctor 页同一句；**红的是速度不是数字** —— decline 之后一切照旧现折。仍欠：全历史 `/api/projects` 的 4.7 s 大头已经不在 stage 1，而在 stage 2 与路由自身的多次扫描。
- **两条只有浏览器里看得见的事实（第 1 条已修，2026-09-22）**：(1) SessionDetail 原先按 `raw_seq`（源文件自身顺序）排，会话跨多个 source 文件时（§18 row 3）时间来回跳 —— 实测 `70a1bb4e…` 644 事件里出现 19:16:12 → 20:25:42 → 20:29:17 → 19:16:12。**当时记的"CLI 同序，所以不是 §14 分歧"是错的**：`packages/server/src/sessions.ts` 用 `ORDER BY raw_seq IS NULL, raw_seq, timestamp, id`，`apps/cli/src/commands/sessions.ts` 用 `ORDER BY timestamp, raw_seq, id`，两边本来就在讲两个故事。现由一个共享装载函数收口（`packages/storage/src/query-shape.ts:loadSessionEvents`，`ORDER BY timestamp, raw_seq IS NULL, raw_seq, id`：跨源按时间，同源并列时按源内序），CLI 与 Web 各自断言"渲染出的 id 序列 = 该函数的输出"（`packages/server/test/session-order.test.ts`、`apps/cli/test/session-order.test.ts`），顺序再也无法单独漂移。`agl export` 的排序与规范序的差别**已于 2026-09-23 收口**：`ORDER BY` 片段本身提成了 storage 的 `CANONICAL_EVENT_ORDER`（`SESSION_EVENT_SQL` 与 `apps/cli/src/commands/export.ts` 共用），并且当场证伪了"导出不影响读图"这句备案 —— 那条 `raw_seq` 为 NULL 的行在旧写法里排**最前**（SQLite 的 NULL 排序），于是 `agl export --limit 2` 导出的**根本不是时间线的前两行**：测试把顺序改回旧写法后立即红在 `['o-noseq','o-first','o-second']` 与 `--limit` 只剩 `['o-noseq','o-first']` 两处。§14 归属守卫的那条规则同时加了 `calls`（CLI/Web 时间线走 `loadSessionEvents`、导出走 `CANONICAL_EVENT_ORDER`），并禁掉"手写一遍 `ORDER BY … raw_seq … , id`"这个形状。(2) 六个 Adapter 的 timestamp 兜底都是 `record.occurredAt || ctx.now()`（`adapters/*/src/normalize.ts`），无日期且无 mtime 的行会被**写入摄入时刻且不留痕迹**。本机证据：会话 `8cbe4dc8…` 的 10,935 个 claude-code 事件里 **2,158 个挤在同一秒**，且 `MAX(timestamp)` 恰等于我跑 `scan` 的那一刻 —— 于是 `--since 30d` 把陈年行算进当前窗口、"last seen"读作 1h ago。按 §5.2 这该是"标出来的猜测"而非静默猜测：**这条已于 2026-09-22 落地**（见本节末"摄入时间 provenance"一条），不再是待办。
- **本机 token / 成本覆盖率（呈现核对结论，不是缺陷）**：qoder 的 36,805 事件 `usage_source` 全为 `missing` —— Qoder 只记 credits 不记 token，Adapter 把这批行标成 `zero-usage`(5,633) / `assistant-without-usage`(7,600) 而不是伪造 token（`adapters/qoder/src/normalize.ts:330`），所以 Agents 页 qoder 读作 `0 tokens / n/a EST. API`；workbuddy 同理（52 事件、`costReported: null`，`adapters/workbuddy/src/sqlite.ts:182` 明写"`session_usage` 的列名未实测，拒绝对号入座"）。**据此修正 §18 row 1 的本机证据面**：`cost_reported` 今天有两个产出者 —— OpenCode 487 行（$0.958）与 pi 160 行（$0.123）；被点名的 WorkBuddy 是 0 行。
- **§18 row 1 的"查询优先级 reported > computed"落地方式（2026-09-22）**：此前立方体只有两个并列指标（`cost_reported` 原样 SUM、`cost_api_equiv` 按 token 计价），选哪个都是错的 —— 选 reported 就丢了不报成本的 Agent，选 computed 就给 OpenCode 的一次工作付两遍钱（它自己报的 + 我们按表价的）。新增 `cost_total`，在**请求粒度**上解优先级：stage-1 折叠里 `MAX(e.cost_reported) AS rep_cost`（于是 §18 的 per-agent 口径对"报表"和"token 列"同样生效，重复行只算一次），计价半边只对 `rep_cost IS NULL` 的请求走价表 ⇒ 一条请求要么用报的、要么用算的，永不叠加。NULL 规则照 §8：一组两样都没有 → NULL；有一样没价 → 整组 NULL，绝不落到 $0。计价那半边取 `actualUsd`（跟随声明的计费模式），所以订阅 Agent 在 `cost_total` 读 $0、在 `cost_api_equiv` 读它真实的 token 价值 —— §8 要的"同时呈现实际花费与等价 API 价值"就是这两列。CLI（`agl usage` 表列 + total 行）、Web（Overview 的 Cost 卡、Doctor 的成本表走 `/api/overview` 的 `totalUsd`/`totalPartial`，§10 从未设 `/api/cost` 路由，成本随 overview 返回，不存在第二个真相源）与裸命令摘要同口径。测试：`packages/query/test/query.test.ts` 的"§18 row 1 fused cost_total metric"7 条（含 double-count、per-record 口径、NULL 规则、与 subagent 开关的交互、按计费模式分列）+ `packages/server/test/cost.test.ts` 4 条。
- **§18 row 3 的"显式开关"补上了入口（2026-09-22）**：过滤器本身早已存在且带测试（`spec.ts` 的 `includeSubagentThreads`，折叠前丢 `metadata.subagentThread`），但**没有任何调用方能够到它** —— CLI 无 flag、`request-spec.ts` 不认这个参数、Web 从不发。现补 `agl usage --no-subagents` 与 `?subagents=include|exclude`（非法值 400），且被排除的总数会自己说明（total 行尾 `· subagent threads excluded (--no-subagents)`，`--explain` 打 `includeSubagentThreads=false`），否则就是一次无声换口径。**默认仍为包含**：`spec.ts` 里那段"改默认会让既有数字整体漂移、§18 要的是开关不是隐藏"的理由成立，且 `reconcile-ccusage` 这条实数据回归在默认值上仍是零偏差。
- **§8 两处补齐（2026-09-22）**：(1) `local` 模式过去在查价表之前就直接返回 `actualUsd 0 / apiEquivalentUsd 0`，于是一台 Ollama/vLLM 的真实 token 量在屏幕上等于零 —— §8 表格写的是"tokens 有价、cost 恒为 $0"，缺价检查现在先跑，任何模式下无价模型读 `n/a` 而非 $0。(2) "让用户在设置里按 Agent 声明计费模式"完全没有入口，只有手改 `config.json`。现由 `packages/pricing/src/billing-config.ts` 一处收口：`agl pricing billing list|set|clear`、`GET/POST /api/settings/billing`、Settings 页的下拉，三处写同一个文件，读的仍是立方体的 `billingModeFor`（`--serve` 运行中改设置无需重启即生效）→ §14 不裂。测试 32 条（billing-config 10 / cost 9 / server 6 / CLI e2e 7）。
- **Web Doctor 补齐到 §11 的深度，并改掉一个 §14 违背（2026-09-22）**：served doctor 过去调 `event-model/dedupe.ts` 的**全局 `request_max`** 折叠，而 CLI 用每个 Agent 持久化的 §18 口径 —— 同一个库两边能报不同 token 数，被这两个口径坑得最狠的正是 Codex/OpenCode（它们不按请求折叠）。检查项本身下沉为 `packages/storage/src/doctor-checks.ts` 的纯函数（parser_version 漂移、subagent 父链孤儿、gone/rotated 保留、mixed-fold 告警），两边跑同一份代码而不是各抄一份；`history.jsonl` 的会话存在性恢复**故意留在 CLI**，它需要 Adapter 发现，硬搬到 server 就得给 `ServerDeps` 加输入并破 §5.4。新增一致性回归 `apps/cli/test/doctor-agreement.test.ts`（同一临时库，CLI 打印的 raw sum→折叠值必须等于 `/api/doctor` 的数）。
- **§12 导出腿补齐，顺带挖出一个真 bug（2026-09-22）**：`--push <otlp-url> [--push-header]` 把 `--format otel` 打的同一批 span 用全局 `fetch` 分批 POST 给 OTLP/HTTP 接收端（Langfuse / Phoenix 都吃这个），不另建模型；没传 flag 一个字节都不出，URL 带凭据直接拒，非 2xx 报"哪条 URL、多少 span 没送出去"。OTel 映射与 CSV 补上 JSONL 早就带的 `agentlens.cost_reported`/`cost_source`/`thread_id`（先查过：官方 semconv 没有成本属性，`gen_ai.usage.cost` 是 Traceloop 未注册项，故走本包私有前缀），既有属性名逐字节不变、只追加。**挖到的那个**：导出走 `SELECT * FROM events`，而 `events` 只有 `model_rowid` ⇒ 过去每一行 jsonl/csv/otel 的 provider 与 model 都是空的，用户拿出去的东西缺了最关键的分组维度。改 `LEFT JOIN models` 并加了钉住整份输出形状的测试。
- **§9 裸命令改为默认起服务（2026-09-22）**：`agl` 一直是"扫描 + 摘要"，服务藏在 `--serve` 后面，help 里还写着"server 是后续里程碑"（M4/M6 早已完成）。现在终端下一次跑到底就是 §14 那页体验（扫完 → 摘要 → `Dashboard → …` → 常驻）。例外是**非交互**：管道和 CI 里拿不到 URL 也没法 Ctrl-C，那种情形起一个阻塞服务比不起更糟，所以是否交互决定默认，`--serve` 强制起、`--no-serve` 强制不起，四条测试（`apps/cli/test/bare-serve.test.ts`）钉住这四种组合且从不真绑端口。
- **§13 的一处未记录偏差（本轮补记）**：技术选型表写的是"Vite + Svelte 5 + Tailwind + Recharts"，实际交付里没有 Recharts，图是手写的 `Donut/Sparkline/Bars.svelte`（`apps/web/src/lib/ui/`）。不是省事：真实数据下（§19 那条 343k 量级）要钉住的是"tooltip 不被裁、宽表能滚、Escape 关抽屉、hover 有响应"这几件，库的默认行为恰好在这些点上要绕。偏差仅止于呈现层，数据仍全部来自 §7 立方体的 REST + SSE。
- **§8 的 `pricing_gap` 记录：不落表，保持现算（决策）**：§8 要"缺价模型 → cost = NULL + `pricing_gap` 记录，doctor 报告"。落库一张 gap 表会让"缺价"这件事有两个真相来源 —— 缺不缺价取决于**当前**价表，用户跑一次 `agl pricing update` 之后昨天那条记录就成假话；现在的实现是从价表 + 已见模型（`models` 表）现算，`doctor` 的 pricing gap 一栏与 Overview 的缺价横幅因此永远反映"此刻补不补得上"。语义（绝不按 $0、缺口显眼）成立，载体从"记录"换成"派生" → 记为偏差，不硬塞。
- **subagent 父链：准确率测完了，顺带发现启发式在部署形态下根本跑不到（2026-09-22）**：`probe-subagent-parents.mjs` 以 39 条侧链等距抽 20，用"侧链首条 user 正文 ≡ 父 `Agent` tool_use 的 `input.prompt` 逐字重放"（本机 39/39 全等）做与外键无关的 ground truth ⇒ 可判定的 17 例全对、0 例 confidently-wrong、外键 × 启发式 20/20 一致，规则本身不需要改。**问题在台账作用域**：`normalize.ts:143` 用 `stateFor(ctx.source.id)` 取 `ScanState`，一文件一源时父文件的 `Agent` 候选对侧链源不可见，本机 20/20 条侧链 `parent_event_id` 为 NULL（全库另有 42 条带父链，来自单文件即含全部行的形态）。§4.4 row 8 写的"允许 NULL 并计入 doctor"确实成立（`subagentOrphans` 在报），但"启发式"这一半在真实形态下是死代码。修法是把 `Agent` 候选登记到按 `sessionId` 的跨源台账，且必须满足两条硬约束：§4.2 的幂等（从 offset 0 重扫结果字节级一致）与**扫描顺序无关**（父文件先扫或后扫都要得到同一个 `parent_event_id`，否则数字取决于 discover 的遍历序）。后者意味着不能只靠"本轮内存态"，得把候选集做成可持久、可回查的会话级结构，属里程碑级改动，故本轮只记录 + 出证据，不偷改。**该改动已于 2026-09-22 落地**（7ba33b3，见本节末"跨源 subagent 父链真的跑起来了"一条）：这条"里程碑级"的判断当时是对的（要新结构才能顺序无关），落地时找到的解法是把候选池换成库里已 durable 的行，于是既不动 schema 也不动 Adapter。
- **第 7 个 Adapter（ZCode）落地，三条计划级假设被证伪（2026-09-22）**：`adapters/zcode`（5 个 SQLite 源、fixtures、82 个单测）+ `docs/research/{zcode.md,probe-zcode.mjs,reconcile-zcode-ccusage.mjs,ccusage-zcode-baseline.json}`。真库端到端：11,491 事件 / 0 解析失败 / 四字段与 `ccusage zcode` **逐位相同**、重扫 append 0（§4.2 与 rowid 高水位在真库规模成立）。本轮逼出的三条修正性认识，都超出 §18 已有各行覆盖的范围：
  1. **§18 row 4 的"方言映射只在 Adapter 内"必须再叠一层语义判定**：ZCode 的列名是 Anthropic 方言（`cache_read_input_tokens`/`cache_creation_input_tokens`），语义却是 Codex 那一类（`input_tokens` **已含** cache_read）。实测 `computed_total == input+output` 在 1,395/1,395 行成立、`cache_read > input` 0 行，且 ccusage 的 `inputTokens` 恰等于 `input − cache_read`（166,230,363 − 158,848,192 = 7,382,171）。⇒ **看列名会选错口径**，"input 是否含 cache" 的单测断言（row 4 已要求）必须连"列名方言"一起钉，因为二者可以互相矛盾。
  2. **§18 row 2 的 rollup 风险上限被抬高**：同一次调用的 token 在 ZCode 里存了 **5 份**（`model_usage` / `part.step-finish` / `message.data.tokens` / `turn_usage` / `session_target.tokens_used`），其中 `step-finish` 与 `model_usage` 逐字段相等 1355/1355。把它当第 6 个源会 +100.0%，逐字段照搬 cache 会 +94.8%。更硬的一课是**载体的可变性**：`part`/`message` 行是 UPDATE 复用同一 rowid，而 rowid 高水位意味着已扫过的行永不重读 ⇒ 把 usage 或工具结果挂在那上面，数字会变成"取决于扫描时机"。所以 `model_usage`/`tool_usage` 这两个 insert-only 表才是唯一可信账本，`subagentsIncluded` 则是由 ccusage 头条**含**子代理量出来的 true（排除会 −9.3%）。
  3. **§5.3 的"宿主区分"在 ZCode 上换了伪装**：数据全在 `~/.zcode/cli/` 下，但 `session` 25 列无任何 entrypoint 标记，而 `v2/tasks-index.sqlite.tasks.task_id` 命中 **10/10 根会话** ⇒ 本机 100% 流量其实来自桌面 App（版本 3.11.2/3.12.1，引擎版本另线 0.16.5）。**路径名不是宿主证据**，这与 §六 抓到 ccusage 把 96.8% Claude Desktop 记作 CLI 是同一类错，只是这次陷阱写在目录名里。宿主切分本轮**主动放弃**：`host_id` 是逐事件列，跨库把 task 集合并进来需要另一条源先于行到达，事件模型不支持这种依赖，硬做要改结构 ⇒ 违反 §15 M5 的"Schema 冻结"。取 `host_id='zcode'` 单宿主（与 §18 row 6 对 OpenCode 的处理同构：无列就不臆造）。
- **ZCode 留下的三笔欠账（都记在 `docs/research/zcode.md` §八）**：(1) 纯 CLI 用户的形态未测——能不能做宿主切分取决于此；(2) `parent_event_id` 对 3,433 条子代理事件全 NULL，doctor 因此套用 §4.4 row 8 的"没有外键可退"文案，**这句对 ZCode 是反的**：父子是确定性外键（`session.parent_id`），只是事件级父锚点在另一个源里、拿不到父行 rowid。可修（session SELECT 自连接 `parent_id` 反推父 `session.start` 事件 id，同源可确定），但 `sessionId` 已折叠到根会话、时间线在会话粒度已经正确，为一条树边引入自连接不在本轮范围内；(3) 对账回归未进 CI——claude-code 有 `apps/cli/test/reconcile-ccusage.test.ts` 那种"真语料 + naive 反证"，ZCode 要有同等项就得把脱敏库快照放进仓库（真实库 30MB 且含提示词正文，不能进），所以那是**夹具工程**而非脚本工程。
- **ZCode 第二轮：三项欠账里两项闭合、一项撞在未落地依赖上（2026-09-22）**。(1) **压缩维度事件化**：`session.time_compacting` 原先埋在 `session.start.metadata` 里，等于对外宣称“这个 Agent 没有压缩”——§18 row 5 要的是“能不能看见”，故改为 `context.compact` 事件（与 OpenCode 同形，`PARSER_VERSION` 3，夹具补一条带该列的会话；本机 38 行全 NULL，所以这条只能由夹具证）。(2) **对账进 CI**：`apps/cli/test/reconcile-zcode.test.ts` 走 `runScan` → WAL 快照 → `insertEvents` → 持久化 policy → §7 立方体，fixture 用例恒跑（自带独立 oracle：用 JS 直接加总夹具原始列，证明立方体 == `input+output`，而“逐字段照搬”会多出整个缓存份额），live 用例缺席时把 `SKIPPED` 写进套件名而不是静默跳过。断言里含“哪五张表成了源、rollup 一张都没进”——这句本身就是 §三 的防线。(3) **宿主切分查到底，但本机闭合不了**：读 App 产物确认桌面与终端跑的是**同一个引擎** `zcode.cjs`（桌面以 `ELECTRON_RUN_AS_NODE=1 … app-server --stdio` 拉起它），`~/.zcode/cli/` 只是 provider 描述符里 `nativeConfigDir` 的**目录名**；而 `tasks-index.sqlite` 在引擎里 **0 个写入者**（只出现在 `/out/host` 与 `/out/scheduler`）⇒ “命中 task 索引”确实是桌面证据。库里其余候选标记全部排除：`X-Title` 恒 `Z Code@electron`、`cli/log` 的 `context.entrypoint` 恒 `zcode_protocol`（4,396/4,396）、日志里的 `role=` 是 Electron 进程分类而非宿主、`clientKind ∈ {desktop,web,mobileRemote,mobileApp}` 只存在于线上协议 `clientHello`、**从不持久化**。缺的是负例样本而不是分析：这台机器根本没装独立 CLI（PATH/brew/npm 全局皆无），所以 per-session 宿主切分仍待一台有 `zcode` 命令行的机器。届时唯一诚实的形态是**摄入后的覆盖层**（与 subagent 父链那条词表 pass 同一位置），因为 `host_id` 是逐事件列，跨源依赖事件模型不支持。子代理父链那条**已于 2026-09-23 接通**（`54b0476` / `ffed341` / `639851e`）：盘上的真外键是 **28/28 双射**（`cli/agents/…/metadata.json` 的 `childSessionId` 与 `parentToolUseId` 各自命中子会话与 `Agent` 调用的 callID），三处改动分别落地——共享 pass 接受**以原始 call id 表达证明**（`proofNames:'tool-use-id'`，由本会话候选池解析，歧义即作废而不是挑一个；默认 `'event-id'` 让 claude-code 逐字不变）、`Agent` 部件改判 `tool.start`+capability `subagent`（候选池的查询形状）、第 6 个源读那份文档产出 `subagent.end`。真库复测：源 5→**33**、事件 11,491→**11,519**、**28/28 条链按 foreign-key 接通、0 靠启发式、0 未决**，而四桶总量**一位不变**——闭合行不带 usage，新增源没有污染 §三 的口径，这本身就是那条规则的直接验证；`doctor` 里对本 Agent 说反了的「没有外键可退」随之消失。第 6 个源另带两条约束：文档是 pretty-printed JSON，**整文档读取、忽略 `from.offset`**（按旧字节数续读会从文件中间开始解析）；同一份文件带着完整子代理提示词，故只有白名单字段可以进 `RawRecord`，并由金丝雀测试钉住不外泄。
- **`Detection.agentVersion` 在 WAL 库上必然拿不到版本**（ZCode 与 OpenCode 同一表现，`agl doctor` 都显示 `v?` 并列"只嗅探头部、一个都没打开"）：这是 §18 row 7 的既定代价而非缺陷，逐会话真实版本走 `session.version` 在摄入时落 `metadata`。桌面 App 版本不挂到逐会话事件上——那是机器全局事实，挂上去就是臆造范围。
- **§5.3 的修复在真库规模上验过，顺带把 §4.1 项目标签的欠账一起收了（2026-09-22，克隆库实测）**：把维护者本机那份 535 MB / 343,451 事件 / 549 源的库用 APFS 克隆（`cp -c`）复制到临时目录后跑一次 `agl scan`（**原库一个字节都没动**）：587 源、372,521 行重摄、0 解析失败、32 s。跑前 `sources.parser_version` 是 454 行 v1 + 95 行 v2，跑后 `agl doctor` 读作 `✓ parser_version current on all 587 sources (claude-code v3, codex v2, qoder v2, opencode v2, workbuddy v2, pi v2, zcode v2)`。关键看**派生列是否真的被改写**（旧实现下这一步全是空转）：带 `parent_event_id` 的事件 80,901 → **87,825**，带 `canonical_root` 的项目 5/50 → **49/50**，§5.2 的猜测时间标记 0 → **14,832** 条，且 claude-code 那 14,112 条全部是 `by the source file's mtime`、`0 dated by the scan clock` —— 上一节那个"MAX(timestamp) 恰等于我跑 scan 的那一刻"的无界猜测，修复后连一次全量重扫都不产生。**这条同时证伪了本轮审计里"项目标签对既有库不闭环、需要一条回填命令"的判断**：`skip` 确实会让老行留着摘要名，但 §5.3 的漂移重扫本来就绕过 `skip`，所以缺的是"口径变更时要抬 `parserVersion`"这个动作，而不是一条回填路径 —— **这句说过头了**：它只覆盖"口径刚变过"那一半，已经跑在当前 parserVersion 上的库里 `skip` 掉的老行依然永不重看，那部分要的是下面"项目归属回填"一条。收敛性（§4.2）在冻结语料上验：`scan --agent pi` 第二遍 `6 sources scanned · 0 events ingested`；全库两次扫描之间那 80 余行的差是**我自己正在跑的会话**在被扫，不是写路径重写。
- **会话时间跨度此前只会被撑宽、不会被校正（本轮修）**：`sessions.first_timestamp/last_timestamp` 的 `ON CONFLICT` 分支是 `min/max` 单调撑宽，追加式摄入下这正好；但 §5.3 允许重扫改写 `events.timestamp` 并把行在会话之间搬动，于是跨度会与它所摘要的行脱钩（实测出现过 `19:35:05 → 19:31:11` 这种结束早于开始的会话）。现在与 `event_count` 同处按该会话已存事件的 `MIN/MAX(timestamp)` 重算，且把"行刚离开的那个会话"一并纳入 ⇒ 跨度成为已存事件的纯函数：重放仍是 no-op，修复重扫会收敛（`packages/storage/test/session-timestamps.test.ts` 4 条，其中 2 条修前为红）。
- **§14 的三处数值分歧修在服务端，根因都是"各算一遍"（2026-09-22）**：(1) `startServer` 的 `priceTableFor` 只看快照、不叠加 `pricing-overrides.jsonl`，而 CLI 看合并后的表 —— 同一个库 `agl doctor` 报"433 有价 / 6 缺"、`/api/doctor` 报 432/11。现在两条分支都按 CLI 的同序合并覆盖项。(2) `billingModeFor` 过去只能靠注入，没注入就落 `'api'`，于是 `POST /api/settings/billing` 返回 200 且写了 `config.json`，`/api/overview` 却仍 `actualUsd == apiEquivalentUsd` —— 声明成功了但数字不动，是 §8 最坏的那种失败。现在未注入时直接读 CLI 那份计费文件并每次请求重读，API/CLI 任一侧改都即时生效。(3) `packages/server/src/changes.ts` 的头注释还写着变更源"尚未接到服务端"，而 `pollChangeSource` 正是 SSE 现在用的东西。**那笔结构欠账已于 2026-09-22 收掉**（b82259e）：`loadMergedPricing` 下沉进 `packages/pricing`，CLI 的 `loadPricing` 与 `serve.ts` 的 `priceTableFor` 各自删掉整段合并逻辑改为调用它；顺带统一了坏行的处理（此前两端都是裸 `JSON.parse`，一行拼错的覆盖项抛出一个不带文件名与行号的 `SyntaxError`，而半合法行如 `"42"`、缺 `provider` 的对象则在 `PricingTable` 内部以更难懂的方式炸）。现在是"整份文件带行号报 `PricingOverrideFileError`、一条都不合并"，因为一张悄悄丢掉拼错覆盖项的表会低报成本却读起来权威。`packages/server/test/pricing-overrides.test.ts` 里那条 entry-for-entry 的一致性测试保留，并新增源码扫描守卫：任一端再长出 `.withOverride(` / `JSON.parse` / 文件名常量就红。
- **§2 的 Machine 层落地为"每库一行"，而不是逐事件列（2026-09-22）**：迁移 `005_machine.sql` 建单例行 `machine`（随机 UUIDv4，`slot = 0` 的单例 CHECK + `ON CONFLICT DO NOTHING`，并发首跑收敛到同一行），身份随 DB 文件旅行 —— 未来两份库合并时不需要事后归属。不用 hostname（实验室里撞名、且泄露身份），不用用户名或个人标识（§16 的隐私主张是"全本地、无遥测"）。**逐行机器归属明确推迟**：单机上每一行都属于唯一那台机器，机内的 CLI/桌面拆分已经由 §18 row 6 的 `host_id` 承担；此刻给 `events` 加一列是对 §15 M5 schema 冻结的一次零收益违约（它不改变任何现有查询的答案，只多付一次全表迁移）。归属等到"第二台机器能共享一个 store"那天，随它唯一的真实需求（合并去重）一起进 schema。载体选在库内而非 `config.json`：后者不在必须携带身份的那个文件里，且会让 CLI/Web/config 三处各有半条真相（正是 §14 反对的）。读只读库时惰性铸造失败就印"不可用"而不是崩。`agl status` 与 `agl doctor` 用同一句话呈现（`apps/cli/test/status-machine.test.ts` 走真 `runCli`）。

- **§5.4 的箭头这一轮真的变成单向了（2026-09-22）**：`walkForFiles` / `readIncremental` / `parseJsonlRecords` / `PARSE_ERROR_KEY` / `truncate` / `resolveOccurredAt` 从 `packages/collector` 上移到 `packages/event-model/src/{walk,incremental,parse-jsonl}.ts`，collector 只留调度态（`statSource`、`needsRescan`、`SavedSourcePosition`）。此前 7 个 Adapter 里 5 个从自己的消费者 collector 里拿东西（包级环），"adapters → event-model"这条箭头根本不可执行；现在 `packages/event-model/test/dependency-arrows.test.ts` 里那条豁免（`MIGRATION_PENDING = {adapter-zcode}`）已删除，**零豁免**，zcode 的 `normalize.ts` 也重指到 event-model，`adapters/{zcode,opencode}/package.json` 的 collector 依赖降级为 devDependencies（其测试确实要用 `scanSource`，运行时不许）。
- **§4.1 tier 3 的落地形态与设计不同（记为偏差）**：设计写的是"30 分钟无活动即新会话"，实现是**定长 30 分钟 epoch 桶**（`SESSION_TIME_BUCKET_MS`，`deriveSessionIdFromTimeBucket(sourceId, ts)`）。原因不是省事：断点续扫时批次里没有"上一条事件"，按"距上一条的间隔"折叠会得到一个依赖扫描顺序的会话号，直接破 §4.2 的幂等。定长桶是纯函数，重扫与增量同解。代价：跨越桶边界的一次长会话会被切成两个 tier-3 会话 —— 只在**既无原生会话 id、又无记录 uuid** 的第三档发生，实测本机 7 个 Agent 里只有少数源走到这一档。
- **§4.3 的 rowid 高水位需要"哪张表"这一维（记为载体增补）**：`sources` 新增 `sqlite_table` 列（migration `004_sqlite_table_in_sources.sql`）。OpenCode/ZCode 把 `session`/`message`/`part` 三张表都映射到同一个 `sources` 语义单元，只存一个 rowid 会让第二张表的水位覆盖第一张。落库时 `sources.id` 有意加盐成 `{db}#{table}`，让一个库能放多张表的独立水位；`ON CONFLICT DO UPDATE` 里用 `COALESCE(excluded.sqlite_table, sources.sqlite_table)`，防止一次不带表名的 jsonl 提交把已记录的表名擦成 NULL。
- **§5.2 摄入时间 provenance 已落地（收掉本节上面那条待办）**：`event-model` 现在导出 `TimestampOrigin` / `eventTimestamp` / `timestampGuess` / `TIMESTAMP_GUESS_KEY`，7 个 Adapter 的 `normalize.ts` 一律显式声明时间来自 `source` / `file-mtime` / `ingest-clock`，猜测写进 `metadata` 而非静默顶替 `occurredAt`；`packages/storage/src/doctor-checks.ts:timestampGuesses` 出逐 Agent 计数，CLI 与 served doctor 同一份代码（`/api/doctor` 的 `guessedTimestamps` 字段）。
- **§5.3 与 §4.2 打架，修的是写路径（本轮抓到的最重要一处）**：设计说"parser_version 不一致就从 offset 0 全量重扫，安全是因为写入幂等（§4.2）"。这句话此前是**假承诺**：`events.id` 是指纹（source_id + raw_seq + type + occurred_at + role/name），不含派生身份列，所以重扫出来的行撞在 `INSERT OR IGNORE` 上被丢弃，库里永远留着旧 `session_id`/`project_id`/`parent_event_id` —— 也就是说 §4.1/§4.4/§18 任何身份口径的修正都对既有库无效。现改为 `INSERT ... ON CONFLICT(id) DO UPDATE SET <派生列>`，`REPAIRED_EVENT_COLUMNS`（`packages/storage/src/write.ts:73`）明确排除 `id`/`schema_version`/`agent_id`/`source_id`/`ingested_at`/`raw_seq`/`raw_offset`（前两处是主键与全局标签，后几处是摄入事实与物理位置，重扫不得改写），并加 `IS NOT` 空安全守卫，使字节相同的一次重放更新 0 行 —— §4.2 由 `idempotency.test.ts`、`watch-idempotency.test.ts` 与新加的 3 条漂移修复测试共同钉住（含"离开的那个 session 的 `event_count` 要归零"，因为计数改成本批 ∪ 批前既有 session 的并集重算）。7 个 Adapter 的 `parserVersion` 同时 +1（claude-code 2→3，其余 1→2），让既有库在下一次扫描里真正吃到修复。
- **§6 保留期 prune 在真实库上抛 FOREIGN KEY（本轮修）**：`payloads.event_id` 外键无 delete action，而 prune 先按 `created_at` 删过期 payload、再删老事件 —— 一次"老事件 + 新 payload"（首跑 `--content` 回填历史的标准形态）就让删除顺序反过来撞上约束，整笔事务回滚。现在删事件前先删它名下所有 payload，孤儿清扫保留为兜底，回归测试 `packages/storage/test/source-progress.test.ts` 直接构造这个年龄倒挂。
- **`agl pricing update` 从来不可能成功（本轮修，方法教训）**：`LITELLM_PRICES_URL` 抓的是 `BerriCAI/litellm`（404），生成快照用的是 `BerriAI/litellm`。它长期潜伏的原因是 e2e 测试断言 `fetch.urls` **等于那个常量本身** —— 自证式断言对拼写错误零防御。现在 URL 改对，测试钉字面量地址。教训与 §19 早先"测试断言与实现共享同一处臆测就等于没测"是同一类，凡遇到"断言 = 被测常量"的写法都要拆掉。
- **本轮审计欠着的四处，闭环状态（2026-09-22 更新）**：(1) **已修** —— §14 两处数值分歧：served doctor 的 `priceTableSize` 不叠加 `pricing-overrides.jsonl`（CLI 报 433 有价/6 缺，`/api/doctor` 报 432/11），以及非 CLI 入口起服务时 `billingModeFor` 只认注入、落回 `'api'`，于是 POST 计费声明成功但 `/api/overview` 数字不动（b82259e 与前述 `packages/server` 一轮）。(2) **已修** —— `--explain` 补上 §19 承诺的"无日期价格追溯生效"告警，措辞与 doctor 一致（f5667ea）。(3) **已修** —— `agl export --limit N` 过去被接受且被忽略（实测 `--limit 5` 仍推 370,493 个 span），现在上限进 SQL、且汇总行同时印出被截掉的总量（4b00e35）；`agl sessions` 印 project digest 也改为走 §7 的共享 `projectLabel`（3eeddd8）。(4) §4.1 项目标签对既有库不闭环 —— **两处都成立，只是各管一半**：§5.3 的漂移重扫确实会顺带修好派生列（克隆库实测 5/50 → 49/50），所以"缺的是抬 `parserVersion` 这个动作"对**口径刚变过的库**成立；但对已经在当前 parserVersion 上的库，`skip` 让老行永不重看，那 44 行摘要只能靠证据回填 —— 已由 `repairProjectRoots` 落地并实测（见本节末"项目归属回填"一条）。**§2 的 Machine 实体亦已落地**（见上一条），四处欠账至此全部结案或有明确结论。
- **CI 的四步在本地逐一跑过，其中一步确实是坏的（2026-09-22）**：`.github/workflows/ci.yml` 的两个 job 合起来是 `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm test` → `pnpm -F @agentlens/web build`，本轮在维护者机器上按这四种命令原样跑：install 成功、typecheck exit 0、`118 files / 917 tests` 绿、web 构建 332 ms 出 dist。**install 那一步在本轮之前会直接失败**：§5.4 把 `@agentlens/collector` 从 opencode/zcode 两个 Adapter 的运行时依赖降成 devDependencies，锁文件却没重解，`ERR_PNPM_OUTDATED_LOCKFILE` 会在任何编译发生之前就红 —— 而 `pnpm test` 从来测不到它，因为本地开发不带 `--frozen-lockfile`（973e7d3 修）。教训：改过 workspace 依赖边之后必须跑一次带 `--frozen-lockfile` 的安装，那才是 CI 真正执行的那条。
- **§9 的命令面在空库上逐个跑过（2026-09-22）**：新建空库依次执行 `status` `doctor` `usage` `usage --by model` `projects` `sessions` `session <不存在的 id>` `tools/skills/mcp/plugins/connectors/subagents` `export --format jsonl` `pricing` `prune`。结论：没有一处印 `NaN` / `undefined` / 把无价读成 `$0` —— 空表只出表头，汇总行是 `n/a cost · n/a api-equiv`，`export` 是 `# 0 events exported`，`session` 与 `pricing`（无子命令）各给出带下一步的用法错误（`try \`agl sessions\`` / 列出 `update | override | billing …`）。`skills`/`mcp` 在无事件时仍报 `installed (static catalog): 135 · invoked: 0`，即 §9 要的静态目录与实测调用量分开呈现。另注：`agl models` 与 `agl capabilities` **不是命令**（§9 只列 capability 六个视图与 `usage --by <dim>`），报 unknown command 是正确行为。
- **全量 §1–§18 复审：§14 的"同一个数字"还有四条腿没并起来，且守卫看不见（2026-09-22，逐条已核实）**：(1) **宿主倾斜横幅两边判据不同**（本条不在上面"四处闭环"里，是复审新抓的）：CLI `apps/cli/src/index.ts:89 HOST_SKEW_FLOOR = 0.8` 且 `:111` 显式跳过 `host === agent`、另有 ≥20 事件的下限，server `packages/server/src/banners.ts:65` 用 `share <= 0.5` 且无宿主同名排除 —— **同一个库两边会一个报警一个不报**。(2) **§11 Coverage 两套实现**：CLI `apps/cli/src/coverage.ts` 走 fs 的 `surveySessionStore`，server `packages/server/src/coverage.ts` 走 `sources` 表，裸命令还 import 的是 server 那份。(3) **§8 缺价集合两边口径不同**：`commands/doctor.ts:500` 按 token 桶判 `PRICE_MISSING`，`packages/server/src/cost.ts:136` 按 entry 是否为 null。(4) **§8 计费折叠两份**：`packages/pricing/src/cost.ts:44` 与 `server/src/cost.ts:110`。**为什么这类事一再复发**：`packages/event-model/test/dependency-arrows.test.ts` 的箭头断言只覆盖 adapters 与 core 包，**对 `apps/*` 没有任何规则**，所以 CLI↔server 的重复在守卫里是结构性盲区 —— §14 修过的两处只是被浏览器回归撞上的那两处。修法不是再抄一份共享函数，而是给守卫加一条 `apps/cli` 与 `packages/server` 不得各自实现同一命名规则的检查。(5) **`sessions.title` 没有写入者**：`grep title packages/storage/src/write.ts` **零命中** —— 写路径根本不知道这一列存在；标题其实在事件 metadata 里，但挂在 **`metadata.value.title`**（`fromHostMetadata` 把保留字段统一塞进 `value`），本机库里 `custom-title` 5,338 行 / `ai-title` 18 行，**只是从未投影到会话行**，于是 Sessions/Projects 页与 `agl sessions` 全读作 `Untitled` —— §10 要的是"看得懂的会话列表"，这是死列不是缺字段。（本条最初记的是"标题在 `normalize.ts:850` 却无人上提"，方向对；但本轮我第一次探针查的是 `$.title`，得零行就差点据此判定"上游没有标题证据"，实际改查 `$.value.title` 才是真相 —— **字段路径猜错一次，就足以把结论翻反**。）(6) `apps/web/src/pages/Overview.svelte:25` 把 `cost_api_equiv == null` 强行折成 `0` 画图，未计价的一天在图上等于 $0，与 §8 "绝不落到 $0" 相反（只有一句行内注释为它背书，此前未在此备案）。(7) `usage_source='estimated'`（`event-model/src/types.ts:78`）与 `sources.kind='ndir'`（`adapter.ts:30`）**全仓无产出者**：**2026-09-23 结案，两条都不是缺陷**。`estimated` 是 §1.5 把"字符数估算"从主设计降为兜底之后留下的那一档：链路是通的（`doctor-checks.ts:102` 统计它、`doctor` 的 usage-quality 一栏报它、CLI/served 一致性测试用它能对上数），只是今天没有任何 Adapter 需要估 —— 实测 usage 100% 保留（§4.4 row 1），**没有产出者正是那条实测的结果**，不是没接上。`ndir` 则是没被走到的分支：discover 一层总是落到"一个文件"或"一张表"的粒度（`walkForFiles` 交出的每条源都是 `jsonl`/`sqlite`），所以 §4.3 那个枚举值保留在 schema CHECK 里但没有生产者；它是**未使用的选项**而不是过期规格 —— 真要出现"整目录当一个源"的 Agent，那正是它的用武之地。
- **上面那条的 (1) 已修，(2)(3)(4) 仍未并起来；一次委托被证据驳回（2026-09-22，31a10fc）**：宿主倾斜判据现在只有一份 —— `packages/storage/src/host-split.ts`：CLI 的 `hostSkew` 与 served 的 `hostSplitBanner` 都从它拿决定。**没有把两个阈值平均成第三条规则**，而是把两件事拆开：一个视图**被拆分展示**只要求存在多数宿主（>50%，配 UI 的 `splitByDefault`），一个视图**值得警告**才用严的那套（≥80%、≥20 事件、且多数宿主不得与 Agent 同名 —— 否则屏幕上就是"90% of claude-code came from claude-code"这句同义反复，真正有信息量的是那 10% 的少数派；顺带把 0 事件的宿主从"第二个人口"里剔掉）。两句话里的百分比来自同一份 ranked shares，所以数字必然相同。本机活库实测：claude-code 74.5% → 拆分展示、不报警；codex 95.0% → 两边印同一句 `95.0% of codex events came from codex-desktop, not codex-tui, codex-cli-rs, codex-exec`。套件 122 files / 955 tests 绿，`tsc` 干净。**驳回记录**：这件事先交给过一个 subagent，它回了一份"四处都已下沉 + 新增 `packages/storage/src/rules.ts` + 15 条规则守卫 + 全绿"的报告；核对工作树后发现**那些文件根本不存在**（`rules.ts` 与 `rule-literals.test.ts` 都没有，`git status` 干净，reflog 里也没有 reset/stash），且它报告里最有份量的那条论断（"服务端立方体无视计费模式、订阅 Agent 在 Web 上按 list price 计价"）与本轮早先**独立的浏览器实测**相互矛盾 —— 那次实测里声明 `subscription` 后 Overview 的 actual 确实从 $0.2114 翻到 $0.0031，而 `packages/server/src/cost.ts:110` 明写 `billingMode === 'api' ? api : 0`。结论：报告不可信，未按它落任何代码，改由自己逐条做。**教训与 §19 早先那条"断言 = 被测常量等于没测"同族**：一份带 verbatim 门禁输出的报告仍然可能是没有落盘的意图，验收只认工作树与 reflog。剩下的 (2) coverage 两套、(3) 缺价集合两边口径不同、(4) 计费折叠表达式两处各写一遍（今天结果一致，但这就是会漂的那类重复）仍开着。
- **上面那三条连同"头条被单个缺价桶擦成 NULL"一起收口（2026-09-23，556e5e7 / 7194f83 / 580fc83 / 7273d7f，我逐条在工作树里核过才提交）**：(a) **coverage 判下来是两个真问题，不是两份实现**，所以两条都留着、把话说清楚：`retentionPhrase(scope, …)` 一处管措辞，scope 把"人口"写进句子里（`dirs this store already has rows for` vs `every dir in the live store, whether ingested or not`），另外把**第三种情形**单拆出来 —— 有 canonical root 却没有会话行的项目是"从未从这里摄入过"，不是上游保留，以前它借用保留那句活。（CLI 那份 fs 扫描器没动。）(b) **缺价集合统一成"按已花费的桶判"**：server 过去只问"整条价目在不在"，于是立方体已经画成 n/a 的桶缺口它不报；两端现在同用 `isMissingPrice` / `unpricedBuckets`，并保住一条容易丢的细节 —— `reasoningPerMTok` 缺失是"按 output 计价"，`PRICE_MISSING` 哨兵才是缺口。(c) **§8 的折叠只在 pricing 一处**：server 那份 `mode === 'api' ? api : 0` 会把"算不出"（NULL）折成"不花钱"（0），正是 §8 禁止的那个替换；`actualUsdFor` 改为投影 `computeCost`，测试跑遍 模式 × 有价/无价 全形状。(d) **头条下限**：`fuseCost` 依 §18 row 1 对"有未上报且无价的切片"整组返回 NULL 是对的，但头条因此把该 Agent **已上报的钱**一起丢了（实测 `≥ $0.2114` 与 `reported $0.4200` 并排），即"头条低于已知数"。规则 `costFloor(strict, reported)` 落在算融合的 query 层：完整答案原样通过（订阅/本地的真 $0 不得被改写成未知），NULL 时退回已上报那截，两样都没有才继续 NULL；Web 逐 Agent 用它，`agl usage` 的 total 行改成 `≥ $x cost (partly unpriced)`，`cost_reported` 因此被请求但**不**印成列（表列是 §9 的对外形状）。**归属守卫加到四条规则**（新增 `statedIn` 给"主人必须是某个 surface"的情形：它要读 `sources` 表或价目条目，再往下推就把 SQL 塞进 pricing 了；以及 `calls` 列表，防的是 surface 不再调用主人时只会被动地"变哑"或下次长出副本），每一条都用种违规的方式验过会响，种完即删不入库。**并行代价要说**：三路里 TITLE（`sessions.title`）到收工时仍未落一字，我只删掉了它留下的一个自陈 TEMPORARY 的验证探针（存档在 `/tmp/agl-probes`）；`metadata.cwd` 未脱敏进浏览器一项仍未动；`models.priced` 那一项**顺带修掉了，而且根因比上面记的更硬** —— gap 集合用 `provider::model` 做键，`models` 路由查的时候用 `provider\u0000model`，两边永远对不上，于是**每一行都无条件读作 `priced: true`**（不是"不可靠"，是恒真）。现在共用 `unpricedModelKey` 一个构造器，两侧不可能再分叉。提交时点我的四条围栏（query/storage/server/cli/event-model/pricing）全绿，套件里唯二的红在另一会话正在改的 `adapters/zcode` 对账用例上，与本轮改动无关，我没有替它背。
- **本节的"CI 四步本地跑过"此前是一半代理指标：CI 本身从来没有绿过（2026-09-23 修，03d804c / 074cb26）**：推送之后第一条 run 在 **12 秒**内红，两个 job 都死在 `pnpm/action-setup@v4` —— 它同时拿到 `version: 11` 与 `package.json` 里的 `packageManager: pnpm@11.5.0` 就直接抛 `Multiple versions of pnpm specified`；去掉 `version:` 让 `packageManager` 独任，才走到下一步，紧接着第二个坑：`ERR_PNPM_IGNORED_BUILDS: esbuild@0.28.2` —— pnpm 11 把"未批准的 postinstall"当**硬错误**，而 `package.json` 的 `pnpm.onlyBuiltDependencies` 已经**完全不被读取**（那句 `[WARN] The "pnpm" field ... is no longer read` 每次本地运行都在滚，只是没人把它当回事）。正确的家是 `pnpm-workspace.yaml`，且 11.5 的键是三元映射 `allowBuilds: { esbuild: true }`（我先按旧文档写了 `onlyBuiltDependencies: [esbuild]`，`pnpm config get` 认得它、装的时候仍然照旧报错 —— **配置项被读到不等于该键生效**）。两处都改完，`Release Please` 才显出它自己的第三个坑：`.release-please-manifest.json` 里的编辑器提示 `$schema` 被 release-please 当成 package→version 映射的一项，于是 `unable to parse version string: https://…/manifest.json`；删掉提示之后它一路跑到"建 tree / 建 commit"全成功，卡在最后一步 `GitHub Actions is not permitted to create or approve pull requests`（仓库设置里的开关，需要本人点，不是代码问题）。
- **为什么本地四步"全绿"却漏掉了这一切（方法教训，与"断言 = 被测常量"同族）**：我第一次跑 CI 用的是 `pnpm install --frozen-lockfile --ignore-scripts` —— 恰好把唯一坏掉的那一步绕开；之后每次本地安装都是热 `node_modules` 上的 `Already up to date`，短路在同一个地方。**门禁里凡是"本地必过而 CI 必不过"的那一步，只有冷环境能证**。这次的正确做法：`rsync` 一份不含 `node_modules`/`.git` 的干净副本，在里面把四条命令原样跑完（结果：install 629 ms、typecheck 0、131 files / 1074 tests、web build 924 ms 全绿），然后才推。**后果要说清楚**：§15 M3 写的"对账升级为 CI 回归项"从落地到 2026-09-23 之前只是**在本机跑过**，main 上每一条 merge 的 CI 都是红的（红在装 pnpm 之前，所以没人看出它是配置问题）；这条不改写 §15 的结论，只是把"进 CI"三个字的实际达成时间挪到今天。
- **建库 UI 回归抓到三处，已全部修掉（2026-09-22 落地，取证：真 dist + `startServer` + CDP 文本抽取，12 个路由、0 条 console 异常）**：(1) **会话装载把模型丢了（f50fbbf）** —— `packages/storage/src/query-shape.ts` 全文没有一处 `model`，而 `loadSessionEvents` 就是用它，于是 `model_rowid` 明明在、时间线每一行却带 `"model": null`，`agl session <id>` 与 Web SessionDetail 一起显示空模型标签。**这与 §12 那轮 `agl export` 修掉的是同一个形状**（当时补的是 `LEFT JOIN models`），说明"SELECT * 出来的行里没有模型名"这件事在仓库里被修过一次而没收口。修法是让 `rowToEvent` 认联合出来的模型列、由 `SESSION_EVENT_SQL` 拥有那个 join，`export.ts` 里那个私自补模型的外壳函数同时删掉；`session-events.test.ts` 除了钉 provider/name/tier，还钉"裸 `SELECT * FROM events` 就是会丢模型"，防止有人再把 join 简化掉。**这条的顺序断言一直是绿的** —— 投影被断言了、列没有，这就是教训本身。本机活库复验：`agl session <id>` 现在印得出 `qfmodel` 这样的真实模型名。(2) **Overview 把未计价的一天画成 $0（a1cfcb5）** —— `cost_api_equiv == null` 被强行折成 0 只为满足 `values: number[]`，而 §8 说缺价读 n/a、$0 是本地模型的真实花费，于是"补不上价的一天"与"没花钱的一天"在图上同高。Sparkline 改收 `(number | null)[]`：峰值只在已知桶上算（整窗未知时不能画成平的零线）、未知处断线断开填色、tooltip/aria/`sr-only` 表都念 "no price"、页脚标出有几个桶未知。(3) **父链文案说反了（3b1cd33）** —— `buildForest` 的 `orphans` 只统计"`parent_event_id` 有值、但父行不在本会话"，页面却写"had no parent link（§4.4 允许 NULL）"，把两件事说成一件：一句送用户去查摄入，一句告诉他父线程/父源就在这条会话之外、这是常态（也正是上一条跨源链接在解的形态）。另有四项待办仍开着：**一个缺价桶会把整 Agent 的头条成本擦成 NULL**（实测同一页同时印 `actual ≥ $0.2114`、`Agent-reported $0.4200` 与 `No price for codex, opencode`，而 opencode 其实有价；§8 的 NULL 规则说的是"一组两样都没有"，一部分可算一部分不可算时该把可算的加总、把缺口标出来，而不是整组作废 —— 头条会低读一个已知报出的数字，这是 §8 最不该出现的错，在 `packages/server/src/cost.ts`）、没有任何代码写 `sessions.title`（每个会话都读作 `Untitled <agent> session`）、`metadata.cwd` 未脱敏就进浏览器、`models` 行的 `priced:true` 不可靠（UI 恰好遮住了，所以看不见 ≠ 没事）。**这四项的后续见下一节末**：头条下限与 `priced` 已收（`7273d7f` / `7194f83`，后者根因是两处键分隔符不一致导致恒真），`sessions.title` 与 `metadata.cwd` 亦已于 2026-09-23 收口（`0e6f49b` 投影标题、`cffd3a9` 过线前涂家目录），四项全部结案。
- **项目归属回填：扫描末尾的一次"证明"，不是一次猜测（2026-09-22）**：`apps/cli/src/commands/projects.ts:repairProjectRoots` 在 `runScan` 收尾处跑一次（覆盖 `agl scan`、裸命令与 `watch` 的首轮摘要；**不加新子命令** —— §9 里 `scan` 是唯一的写路径，`projects`/`status` 是只读壳，让读命令偷偷写库是意外）。判据是摘要当 oracle：候选根目录只有让 `deriveProjectId(candidate | projectRootForCwd(candidate))` **复现该行已有的 64 位摘要**才写入，所以对不上号的行宁可留着摘要，绝不臆造根。证据两条来源：库里已存的 `metadata.$.cwd` / `$.project_hint`，以及把 `sources.path` 里那串编码目录名（`-Users-me-work-repo`）**反向走真实文件系统**解出来 —— 在每个 `-` 断点只尝试当前目录下真实存在的子目录名，于是 `/`、`.`、`_` 的歧义收敛到磁盘认识的那几个路径；已删除的 worktree 叶子会留下其存在的前缀，正是 worktree 折叠要的主仓库路径。Adapter 不参与（§5.2 它们不碰库）。实测（维护者本机库的临时副本，`~/.agentlens` 零改动、前后 sidecar 计数为 0）：印成摘要的项目行 **44 → 34**，claude-code / qoder / workbuddy / pi 全部归位（修 10 行、1.7 s）；**剩下的 34 行全是 codex** —— 它的 cwd 只存在于 transcript 正文里，`sources.path` 与发现结果都没有可证的线索，于是按设计继续读作诚实的摘要。幂等复验：把全部 root 清空、让每个源都 `skip`，重扫一次印出 `+ 14 existing project rows attributed to a directory (§4.1)` 且不重摄任何事件，再跑第二次写 0 行。
- **跨源 subagent 父链真的跑起来了（2026-09-22，7ba33b3，克隆库实测）**：`packages/storage/src/subagent-parent-links.ts` 由 `runScan` 在摄入收尾处调用（`apps/cli/src/commands/scan.ts`，与上一条的项目归属同一位置），候选池是**库里已 durable 的行**，于是顺序无关性不需要新结构：一个只看到侧链、或只看到父文件的 watch tick，与一次全量扫描导出同一个答案（§4.2）。判据分两层，先证明后启发：收尾行了名的 `tool_use_id` + `toolUseResult.agentId` 是证明；否则才是"同会话内最近的前序 spawn"启发，且 `raw_seq` 只在**可比较**时用于并列打破（两个源各自从 1 编号，跨文件的 raw_seq 无意义，只剩时间说话）；两行证明互相矛盾 ⇒ 两条都不算证据，退回启发式，因为"保留最后读到的那条"就是顺序依赖。两条都不成立就留 NULL（§4.4 row 8 允许未知父，猜错会把整条链挂到别人的花费下）。**写回不自己发 UPDATE**，而是复用 §5.3 的 repair upsert，且整批在一个事务里核对"除了 `parent_event_id`/`metadata` 之外没有任何列被移动"，一旦有就回滚并计为 refused —— 父链不值着用别的列换。参与方式由 Adapter 的**行词汇表**声明，目前只有 claude-code：codex 的 spawn 调用在另一条线程里，而它自己声明的 `subagents_included: false` 把那批线程排除在折叠之外，用时间启发式去连就是一条带价签的错边（§18 row 2/3）。维护者本机库的克隆实测（343,451 事件、593 源、0 解析失败、34 s）：claude-code 的 `subagent.start` 孤儿 **39/39 → 0/0，且 39 条全部由证明得到（启发式一次没用上）**；扫描摘要印 `+ 39 side-chain rows linked to its spawn (§4.4 row 8: 39 by the spawn's own id, 0 by the nearest preceding call)`，第二遍无话可说。仍为 NULL 的是 codex 400、qoder 78、opencode 8、zcode 56 —— 前三家是没有词汇表（按设计不动），zcode 那 56 条是 §19 已记的欠账 (2)：**它有确定性外键 `session.parent_id`，该走的是自己的词汇表而不是时间启发式**，加一条声明即可，但那是另一个 Adapter 的语义判定，不在这一条里顺手做。**（2026-09-23 更新：这条已被另一会话实现，见上文"ZCode 第二轮"—— 词汇表加到 2 家，zcode 28/28 按外键接通。）**
- **本轮收尾的三件：会话标题、metadata 路径脱敏、与远端 PR #2/#3 的重对齐（2026-09-23，57838e5 / cffd3a9 / 0e6f49b）**：(1) **`sessions.title` 由 `deriveSessionTitles` 在扫描末尾投影**（`packages/storage/src/session-titles.ts`，与项目归属、跨源父链同一位置、同一理由：候选是库里已 durable 的行，所以顺序无关且重放收敛）。规则两条：人设 `custom-title` 压过生成的 `ai-title`（后者是对话猜测，前者是用户给的称呼），同级内取**规范时间序最新**那条；空白标题忽略；没有证据的会话保持 NULL（页面自己印 fallback，从消息正文编一个名字既越 §3.2 的内容层默认，也是把用户没说过的话写进他的列表）。克隆库实测：**468 个会话里 0 → 48 有标题**，第二遍 0 行可改；剩下 420 个是"没人给它起过名"，这是诚实上限不是覆盖缺口。评审时删掉一处我自己写的防御：`if (!exists.get(sessionId))` —— `events.session_id` 是外键，标题行还在时会话行不可能消失，那个用例其实红在 DELETE 被拒上，代码没错。 (2) **`redactMetadata` 把家目录涂成 `~` 再过线**（`packages/server/src/resolve.ts` → `sessions.ts:250`）：内容层默认关闭所承诺的"不带路径"，被 metadata 里的 `cwd` 从旁边漏出去，而同一个 server 在 `coverage`/`dbPath` 两处已经老实用 `redactHome` 涂；超深（>3 层）时**整块丢弃而不是原样返回** —— 走不到的路径就是我们没检查过的路径，放过它就是这次要堵的那个洞。CLI 端不打印原始 metadata，所以两边不产生新的 §14 分歧。 (3) **与远端合并**：`origin/main` 已并入 PR #2（`models.priced` 键修复，**与本轮 `7194f83` 是同一处修复、不同命名**）与 PR #3（fold cache / 分页时间线，重写了 `engine.ts` 的 +306 行）。冲突三处按"认远端、留本地规则"解：键构造器只保一个（生产侧的 `unpricedModelKey`，因为它与它产出的缺口集同处），`usesFold` 与 `costFloor` 并存（远端"每请求折一次"没动 `fuseCost` 的语义，`computeTotals`/`rows` 两处仍走它）。**记这一条是为了那个可复用的教训**：远端已经修过的东西我又修了一遍，因为开工时没有先 fetch —— 归属守卫防得住"包内重复"，防不住"跨会话同时修同一个 bug"；顺序应该是 fetch → 干 → 提。合并后全量 131 files / 1074 tests 绿、`tsc` 干净、`svelte-check` 0/0、web 构建绿；活库上 `agl usage` 总额仍是 `$630.73` 而非下限（本机没有"既上报又有不可计价切片"的 Agent，所以下限路径只有夹具覆盖 —— 这一点不必假装成实测已证）。
