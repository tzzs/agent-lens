# 实测简报 · WorkBuddy 本地数据（§17 第 4 项）

- 日期：2026-09-21　机器：darwin/arm64　脚本：`probe-qoder.mjs`（复用于格式判定 + SQLite 只读打开）、`probe-capabilities.mjs`
- 结论先行：**WorkBuddy 在本机已安装**，数据根为 `~/.workbuddy`；主存储是 **SQLite（WAL 模式）**。

---

## 一、数据根位置

| 候选 | 存在 | 内容 |
|---|---|---|
| `~/.workbuddy` | ✅ | **主数据根**：6,289 文件 / 4 个 SQLite / 755 JSON(L) / 34 个既存 `-wal/-shm` |
| `~/Library/Application Support/workbuddy` | ✅（空壳） | 仅 `pending-telemetry/*.reported` 两个 0 字节文件 |
| `~/Library/Application Support/WorkBuddy` | ✅（空壳） | 同上（大小写重复目录） |

`~/.workbuddy` 下的运行形态：`binaries/{node,python}`（自带运行时）、`logs/`（daemon/main/renderer + `logs/<date>/…`）、`connectors-marketplace/connectors/*`（连接器市场，如 `fazhi-law/skills/…`）、`security/threat-database/`、若干 `*.db` 与 `trace_*.json`。

---

## 二、⚠️ 关键安全发现：只读打开 `workbuddy.db` **创建了 `-wal`/`-shm`**

`probe-qoder.mjs` 在只读打开前后比对该库的 sidecar 文件：

```
workbuddy.db    open=OK(ro)   新建 wal/shm = ⚠️ workbuddy.db-wal, workbuddy.db-shm
```

- 打开前：`workbuddy.db-wal` / `workbuddy.db-shm` **不存在**。
- 以 `new DatabaseSync(p, {open:true, readOnly:true})` 打开并读取 `sqlite_master` 后：两文件**出现**。
- 同目录其它 SQLite（`threat-*.db`、`edge-sync-mapping-v3/v4.db`）只读打开则**未新建**任何 sidecar。

**判定**：WorkBuddy 主库为 **WAL journal 模式**，且当前**没有活动写入者持有连接**（`-wal/-shm` 原本不存在）。SQLite 对 WAL 库建立**任何**连接（即便 `readOnly`）都需在**同目录创建 `-shm`/`-wal`** 共享内存映射——只要目录可写，就会落盘。

**处置**：按任务红线（"若出现 `-wal/-shm` 立即上报并停止触碰该文件"）——**本报告后未再打开 `workbuddy.db`**，其 `session_usage` 表的 token 列命名**未能进一步实测**（这是"读不到"，不是"不存在"，二者不混淆）。已出现的 sidecar 文件**不删除、不改权限**（源目录只读证据）。

**对 AgentLens 的硬影响**：
1. **只读打开一个 WAL 库并非零副作用**——会在被采集 App 的目录里产生 `-wal/-shm`，可能干扰 App 自身的 checkpoint/退出判断，且要求目录可写。
2. 若要真正零副作用，需 `PRAGMA query_only` + `SQLITE_OPEN_READONLY` 仍不足；可选方案（择一验证，勿在采集器里默认尝试）：`?immutable=1`（假定文件不再变，放弃 WAL 一致性读）、或**由 App 侧导出快照**、或**接受 sidecar 并纳入 doctor 告警**。→ 必须在 §5.2"Adapter 不修改源文件"与 §4.3 SQLite 增量策略里为 WAL 源单列一节。v1 §15 的"Qoder database locked"在这里以另一种形态复现：**不是锁死，而是被我们的连接唤起了 sidecar 文件**。

---

## 三、`workbuddy.db` 结构（仅读 `sqlite_master`/`PRAGMA table_info`，未再查询数据）

10 张表：
```
sessions, session_usage, workspaces, automations, automation_runs,
automation_delivery_outbox, automation_runtime_state, buddy_snapshots,
migration_meta, __workbuddy_drizzle_migrations
```
- **稳定 session 键**：`sessions.id`、`sessions.session_settings`、`sessions.project_id`、`sessions.user_id`、`sessions.expert_id`、`sessions.expert_runtime_identity`、`sessions.buddy_snapshot_id`；**用量表 `session_usage.session_id`**（外键回 sessions）。
  > session 是**原生一等实体**（不像 Codex 需父链推断），也**存在 project_id 直连**——项目归组可能比 Claude/Codex 更直接（待可安全读取时验证 project_id 是否为 canonical repo）。

---

## 四、本地 JSONL trace（可安全读取的补充源）

`~/.workbuddy` 下的 `projects/*.jsonl`（本机仅 2 文件 / 52 记录，量极小，是本地执行 trace）：
- 记录 type：function_call 15 / function_call_result 15 / reasoning 12 / message 6 / file-history-snapshot 2 / ai-title 2
- 顶层 key：`id, timestamp, type, cwd, sessionId, providerData, parentId, callId, name, status, content, arguments, output, rawContent, role, __codebuddyLocal, isSnapshotUpdate, snapshot, aiTitle`
- **cache 命名**：usage = `input_tokens, output_tokens, total_tokens, cache_read_input_tokens`（**Anthropic 式 `cache_read_input_tokens`，无 cache_write/cache_creation 字段**）。
- `__codebuddyLocal` 标记 + `sessionId`（50/52 有）→ **WorkBuddy 疑为 CodeBuddy 系衍生**，字段风格既非 Claude 的 uuid/isSidechain，也非 Codex 的 rollout。
- 能力（`probe-capabilities.mjs workbuddy`，仅 55 记录样本）：**未见 mcp / compaction / hook / subagent 标记**。连接器能力（connector）体现在 `connectors-marketplace/` 目录（静态安装），但会话日志是否记录 connector 调用**样本过小不可判定**。

---

## 五、净结论与未决项

| 结论 | 严重度 | 备注 |
|---|---|---|
| WorkBuddy 已安装，主存储 SQLite（WAL） | — | 数据根 `~/.workbuddy` |
| **只读打开 `workbuddy.db` 会新建 `-wal/-shm`** | 🔴 高（采集安全性） | 已停止触碰；需为 WAL 源单列策略 |
| sessions / session_usage 是原生一等实体（含 project_id/expert_id） | 🟢 有利 | session 边界无需启发式 |
| `session_usage` token/cache 列命名**未实测**（因上条风险）| 🟠 未知 | 记为"读不到"，非"不存在"；后续用安全方案补测 |
| JSONL trace cache 命名 `cache_read_input_tokens`（无 cache_write）| 🟡 中 | 第四套 cache 命名信号；映射表须容缺 |
| mcp/hook/compact 在本地 trace 中缺席（样本 55 条）| 🟡 中 | 主数据在 SQLite，能力普查须在可安全读 DB 后重做 |

> 一句话：WorkBuddy 是"SQLite + WAL + 原生 session 表"的形态，**与四种 JSONL/无锁库都不同**，并首次暴露"**只读采集 WAL 库并非零副作用**"这一采集器级风险。M5 接 WorkBuddy 前，必须先解决"如何在不唤起 `-wal/-shm` 的前提下读 WAL 库"。
