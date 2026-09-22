# 实测简报 · ZCode 本地数据

- 日期：2026-09-22　机器：darwin/arm64　脚本：`probe-zcode.mjs`（`node docs/research/probe-zcode.mjs [dataRoot]`，默认 `$ZCODE_HOME` 或 `~/.zcode`）
- 结论先行：**ZCode 在本机已安装并留下完整会话数据**，数据根 `~/.zcode`（755 文件 / 约 400MB）。采集源是 **`cli/db/db.sqlite`（WAL，30.0MB）**——一个把用量埋点做到 40 列的自描述库；`session`/`message`/`part` 三表是 **OpenCode 形状**（`adapters/opencode` 的映射可复用），另附 `model_usage`/`turn_usage`/`tool_usage` 三张聚合表。
- 本轮最重要的两条：**同一次调用的 token 在这份数据里存了 5 份**（§三），以及 **`message.data.cost` 恒为 0**（§四，编码套餐计费，映射成 `cost_reported` 会把 1.68 亿 token 报成 $0）。
- 版本线索：引擎 `schema_migration.app_version = 0.16.5`（22 条迁移）；桌面 App `3.11.2 → 3.12.1`（rollout 请求头 `x-zcode-app-version`，两条都有）。**两套版本号不是一条线**，漂移检测要分开记。

---

## 一、数据根与采集源

| 路径 | 内容 | 是否采集 |
|---|---|---|
| `~/.zcode/cli/db/db.sqlite` | **会话 + 用量主库**（WAL，30.0MB，`-wal` 0B / `-shm` 32KB） | ✅ 唯一 token 源 |
| `~/.zcode/v2/tasks-index.sqlite` | 桌面 App 的任务索引（WAL，0.3MB + `-wal` 3.9MB），`tasks(10)` | ⚠️ 本轮不采（§二 宿主结论） |
| `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl` | 结构化运行日志 8 文件 / 27,001 行（`level`/`module`/`event`，info 26,845 / warn 483 / error 73） | ❌ 日志，非账本 |
| `~/.zcode/cli/rollout/model-io-<session>.jsonl` | 逐请求**完整**请求/响应体，仅 3 会话 / 96 条 | ❌ 见 §六（部分覆盖 + 含 Cookie/验证码头） |
| `~/.zcode/cli/artifacts/<sess>/call_*-tool-result-*.json` | 工具输出落盘文件（565 个 json） | ❌ 内容层之外 |
| `~/.zcode/cli/agents/<sess>/agent_<id>/{metadata.json,output.txt,task.output}` | 子代理运行产物，`metadata.json` 18 键含 `parentToolUseId`/`childSessionId`/`totalTokens` | ❌ 第 5 份 rollup（§三） |
| `~/.zcode/cli/plugins/` | 能力静态面：`installed_plugins.json{version,plugins}`、`marketplaces/{claude,zcode}-plugins-official`、`data/` 8 个 `*@zcode-plugins-official`（browser-use、computer-use、document-skills、github、lark-cli、mimosa、skill-creator、zcode-guide） | ✅ `capabilities()` |
| `~/.zcode/cli/memories/projects/<name>-<12hex>/memory` | 项目记忆目录 | ❌ |
| `~/.zcode/v2/{credentials,provider_config,bot-*}.json` | 凭据 —— **不读取内容**，探针与适配器都不碰 | ❌ |
| `~/Library/Application Support/ZCode/session/` | 桌面 Electron 的浏览器 profile（Cookies/GPUCache/IndexedDB），**不是**会话数据 | ❌ |

**两个 `.sqlite` 都是 WAL** ⇒ §18 row 7 硬约束生效：`probe-zcode.mjs` 与本适配器一律**先复制（含 `-wal`，从不含 `-shm`）到快照目录、`PRAGMA journal_mode=DELETE` 折成回滚模式，再打开副本**。实测探测前后源库 `size:mtime` 逐字节相同。

### 活动窗口

`message` / `model_usage` / `tool_usage` 的时间范围完全一致：**2026-09-12 20:29:07 → 2026-09-13 21:15:51 UTC**（38 会话 / 1,395 请求 / 1,851 工具调用）。`cli/log/` 里有 9-20 的文件，但 9-13 21:15 之后再无 `model.request.*` / `tool.call.*` 事件——那之后的日志只有 memory_sample 与心跳。**本机数据是一次 25 小时的高强度使用**，不是长期采样，样本代表性有限（对账够用，趋势分析不够）。

---

## 二、宿主切分：`cli/` 这个路径名是陷阱

`session` 表 25 列，**没有任何 entrypoint / origin / platform 列**（与 OpenCode 同样诚实处理）。唯一可用的旁证在另一个库：

```
v2/tasks-index.sqlite.tasks.task_id  →  cli/db/db.sqlite.session.id     10/10 命中，0 孤儿
根会话（parent_id IS NULL, task_type=interactive）= 10，其中属于桌面 tasks 的 = 10，CLI-only = 0
子代理会话（parent_id 非空, task_type=subagent_child）= 28
```

即：**本机 100% 的流量由桌面 App（3.11.2/3.12.1）产生，而数据全部躺在名为 `cli/` 的目录里**——和 Claude Desktop 把 96.8% 的量记在 `~/.claude` 下是同一类坑。据此判定：

1. **禁止**因为路径里有 `cli` 就写 `host_id = 'zcode-cli'`。那正是 §六 差异化主张要打脸的错误。
2. v1 取 `host_id = 'zcode'`（单宿主，不臆造切分），把桌面关联留作**已知缺口**：跨库把 `tasks-index` 的 task_id 集合并进来需要第二条 `sqlite` 源，而 `host_id` 是每条事件上的列、无法等另一条源的行先到——事件模型不支持这种跨源依赖，硬做就要改结构，违反 §15 M5「Schema 冻结」。
3. `tasks` 表另带 `provider='glm'`、`model='builtin:bigmodel-start-plan/GLM-5.3-Flash'`、`mode='yolo'`、`title`、`workspace_path` —— 若将来做宿主切分，这是唯一可用外键；本轮只在简报里备案。

### 二·补：2026-09-22 把这条查到底了（读 `/Applications/ZCode.app` 的产物，未运行任何 ZCode 进程）

| 问题 | 结论（证据） |
|---|---|
| `cli/` 是宿主吗？ | **不是**。App 内 provider 描述符写死 `nativeConfigDir:".zcode/cli"`（`Contents/Resources/app.asar` 内 `/out/host/index.js`），它只是配置目录名。 |
| 桌面与 CLI 是两个程序吗？ | **同一个引擎产物**。`Contents/Resources/glm/zcode.cjs`（11.2 MB，`.node-bundle-meta.json` 记 `source:"apps/zcode-cli/packages/cli/dist/zcode.cjs"`、`runtime:"electron-node"`），桌面端用 `{command: process.execPath, args:["app-server","--stdio"], env:{ELECTRON_RUN_AS_NODE:"1"}}` 把它作为子进程拉起。所以"桌面流量"与"CLI 流量"写的是同一套表。 |
| `tasks-index` 归属能当宿主证据吗？ | **能，且是强证据**：`getTasksIndexDatabasePath` / `INSERT INTO tasks` / `runTasksDatabaseMigrations` 只出现在 `/out/host/index.js` 与 `/out/scheduler/index.js`（路径 = `~/.zcode/v2/tasks-index.sqlite`），在引擎 `zcode.cjs` 里 **0 命中**（它唯一的 `tasks-index` 出现是 RPC 作用域字面量 `"controller/tasks-index"`）。实时日志同向：`[pid:70116] [main] … [pid:70771] [zcode-task-index-syncer] 清理 task index`。⇒ 引擎不写这张表，只有桌面宿主写。 |
| **库里还有别的宿主标记吗？** | 全部排除：`X-Title` 恒为 `Z Code@electron`（`zcode.cjs` 里 `sourceTitle:"electron"` 写死）、`cli/log` 的 `context.entrypoint` 恒为 `zcode_protocol`（4,396/4,396）、日志里的 `role=utility_host` 是 Electron **进程分类**（`{utility_host,gpu,host,agent,main,renderer}`）且从不落到行上、`clientKind ∈ {desktop,web,mobileRemote,mobileApp}` 只存在于 `clientHello` 线上协议、**从不持久化**。 |
| 那 rollout 能区分吗？ | 不能。`model-io-*.jsonl` 由**引擎**写（`zcode.cjs` 的 `appendFileSync`，`modelIoFullRetentionEnabled:false` 解释了为何只有 3/38 会话有），桌面只读它（`readTrajectoryFileTail`）。`x-zcode-app-version` 是拉起者的版本，本机只有 3 个会话带。 |

**判定**：per-session 宿主切分在现有磁盘证据下做不到，缺的不是分析，而是样本——这台机器根本没装独立 CLI**（`which zcode` 无、`/usr/local/bin`、`/opt/homebrew/bin`、npm 全局均无，只有 `~/ZCode-3.11.2-mac-arm64.dmg`）。要在真机上补的观测只有一条：**在装有命令行 `zcode` 的机器上跑一个会话，看它是否留下 `tasks-index` 行**。若不留，则 `tasks-index` 命中即桌面、不命中即 CLI，届时唯一可行的落地形态是**摄入后的覆盖层**（与 `packages/storage/src/subagent-parent-links.ts` 同一模式：从已持久化的行反推，而不是在 `normalize` 里跨源猜），因为 `host_id` 是逐事件列。本轮 `host_id='zcode'` 保持不变。旁证第二路（`v2/logs` 里非转发的 `[renderer]`/`[main][browser-use]` 行点名 `session.id`，本机 10/10 命中）只作核对用：桌面日志只留 9 天，会滚掉。


---

## 三、⚠️ 同一次调用的 token 存了 5 份（本 Adapter 的头号地雷）

| # | 位置 | 基数 | 粒度 | 与 `model_usage` 的关系（实测） |
|---|---|---|---|---|
| 1 | **`model_usage` 表** | 1,395 | 一次模型调用 = 一行 | 基准；`COUNT(*) = COUNT(DISTINCT id) = COUNT(DISTINCT logical_request_id) = 1395`，`attempt_index` 全为 0 |
| 2 | `part` 里 `data.type='step-finish'` | 1,355 | 一次调用一步 | `tokens.total/input` 与 `finish_reason` **逐行相等 1355/1355**；差的 40 行是 error/cancelled |
| 3 | `message.data.tokens`（+ `.cost`） | 1,414 assistant | 一条助手消息 | 同值（`{total,input,output,reasoning,cache:{read,write}}`） |
| 4 | `turn_usage` 表 | 89 | 一个 turn 的 rollup | `SUM(computed_total_tokens)=167,547,131` vs 同 turn 的 `model_usage` 之和 `167,541,215`；per-turn input/output 精确相等 80/89 |
| 5 | `session_target.tokens_used` / `cli/agents/*/metadata.json.totalTokens` | 1 / 若干 | 目标级 / 子代理级 rollup | 例：某 target `tokens_used=2,021,795`，是其会话内调用的求和 |

**规则：token 只从 `model_usage` 读，usage 只挂在 `generation.end` 一条事件上。** 2/3/4/5 号副本一律不进 `usage`；需要留证据的（`turn_usage`、`session_target`）写进 `metadata.rollup`，与 `adapters/opencode` 对 `session.cost/tokens` 的处理同构（§18 row 1）。理由：`part`/`message` 行是 **UPDATE 复用同一 rowid**（step-finish 在请求结束时才写入对应 part，message.data 事后被改写），而 rowid 高水位恢复意味着**已扫过的行不会被重读**——把 usage 挂在那上面会随扫描时机得失不等；`model_usage` 是 insert-only，且每请求一行、自带 `logical_request_id`。

## 四、token 口径与对账锚点

`model_usage` 的列名是 **Anthropic/Claude 方言**（`cache_creation_input_tokens` / `cache_read_input_tokens`，§18 row 4 的第 5 种方言家族），但**语义是 Codex 那一类：`input` 已包含 `cache_read`**。

```
全表求和： input 166,230,363  output 1,363,621  reasoning 0  cache_creation 0  cache_read 158,848,192
          provider_total 167,593,984   computed_total 167,593,984
恒等式：   computed_total == input+output                    1395/1395  ← 成立
          computed_total == input+output+cache_read         40/1395    ← 恰为 cache_read=0 的那些行
          computed_total == 四桶相加                          40/1395    ← 同上
          cache_read <= input                              1395/1395
```

⇒ 映射必须**减去**缓存：**`inputTokens = input_tokens − cache_read_input_tokens − cache_creation_input_tokens`**（非负兜底），`cacheRead/Write` 各自成桶。`provider_total_tokens`、`computed_total_tokens` 是 rollup，**永不求和**。`reasoning_tokens` 本机恒 0（`raw_usage_json` 里也没有该字段，列名是 `inputTokens/outputTokens/totalTokens/cacheReadTokens/cacheWriteTokens`）。思考桶恒 0 不等于没思考：同一库里 928 条 reasoning part 共 3,265,454 字符，只是 GLM 不按 token 上报（详见 §八·2）。

### 对账（`ccusage@20.0.23`，独立工具，口径互不商量）

把 `ZCODE_HOME` 指向折好滚回模式的**副本**后运行 `ccusage zcode daily -j -O -z UTC`（不碰对方真库）：

| 字段 | ccusage | 本适配器目标值 | 推导 |
|---|---|---|---|
| `inputTokens` | **7,382,171** | 7,382,171 | `166,230,363 − 158,848,192`，逐位相同 ⇒ 减法口径成立 |
| `cacheReadTokens` | **158,848,192** | 158,848,192 | 直取 |
| `outputTokens` | **1,363,621** | 1,363,621 | 直取 |
| `totalTokens` | **167,593,984** | 167,593,984 | = `computed_total` 全表求和（含 367 条 subagent 行） |
| `totalCost` | 0.0，`missingPricing:true`，`unpricedModels:["GLM-5.3-Flash"]` | — | 见下 |

**MUST 断言这四条**（`reconcile-zcode-ccusage.mjs` + 快照基线，同 claude/codex 惯例）。`subagentsIncluded: true` 是由这张表**量出来的**：ccusage 的 zcode 头条含子代理，排除它们会少算 15,657,611 token（9.3%）。

### cost：字段在，但恒为 0

`message.data.cost` 在 1,414 条助手消息上 **max=0、sum=0**，`step-finish.cost` 同为 0，而 `provider_id` 是 `builtin:bigmodel-start-plan` / `account:bigmodel-start-plan`（智谱 BigModel 编码套餐）。**套餐计费下 `cost:0` 的含义是"不按 token 计价"，不是"免费"** ⇒ 适配器**不得**把它写进 `costReported`（那等于宣称 $0 用了 1.68 亿 token，正是 §18 row 1 禁止的假零）。规则：`costReported = null`、`costSource = 'none'`，交给价格层算等价 API 成本。

价格覆盖缺口（独立证据）：`packages/pricing/src/default-snapshot.json` 有 `zai.glm-4.7`、`zai.glm-4.7-flash`、`zai.glm-5`，**没有 `GLM-5.3-Flash`**；ccusage 同样报 `unpricedModels`。

代码级复核（2026-09-23）把这条从"这台机器采样到 0"升级成"写入方式就是 0"：引擎里 `cost:0` 是 7 处字面量、schema 把 `cost` 定为必填非负数，且不存在按量计价的写入路径（详见 §八·3）。⇒ 本机 zcode 的 cost 会是 NULL，这是正确结果，不是 bug；`doctor` 要能把它讲成"未定价"而不是"零成本"。

## 五、维度词表（全部实测，白名单照此写）

- `query_source`：`main_turn` 1,018（151.9M tok）/ `subagent` 367（15.7M）/ `session_title` 8 / `goal_summary_title` 1 / `target_completion_verification` 1 —— **后三类是模型自发的后台调用**，与用户轮次无关，但 token 是真花的，保留在账上并在 subtype/metadata 里标注。
- `agent`：`zcode-agent` 1,028 / `zcode-general-purpose` 303 / `zcode-Explore` 64；`mode`：`yolo` 1,377 / `plan` 18；`task_type`：`interactive` 1,028 / `subagent_child` 367。
- `status`：`completed` 1,365 / `error` 28 / `cancelled` 2；`finish_reason`：`tool-calls` 1,287 / `stop` 78 / NULL 30。
- `error_type`：`rate_limited` 25 / `unknown` 3 / `cancelled` 2 / `timeout` 1 / `network_error` 1（error/cancelled 行的 token 全为 0，`input_zero=30` 与之吻合）。
- 模型只有一种：`GLM-5.3-Flash`，`variant`：`max` 1,363 / `low` 23 / `disabled` 9 ⇒ `ModelRef{provider: provider_id, name: model_id, tier: variant}`。
- **`trace_id` 绝不能当请求键**：1,395 行只有 10 个不同 `trace_id`，最大的一个跨 499 行 / **15 个会话**。请求键是 `logical_request_id`（= 助手 `message.id`，`msg_…`；`id` 列是 `usage_model_<query_source>_<msgId>_<attempt>`）。
- 子代理归属是**确定性外键**，不需要 Claude 式时间启发：`query_source='subagent'` ⟺ `session.parent_id IS NOT NULL`，实测 367/367 完全一致；`agents/*/metadata.json.parentToolUseId` 还能指回派生它的那次 `Agent` 工具调用。
- `message.data.semantics`（1,603 条全覆盖）：`origin` ∈ `real_user`/`agent_runtime`/`system`，`kind` 分布：`assistant_response` 1,385 / `todo_reminder` 94 / `user_prompt` 89 / `timeline_event` 29 / `background_notification` 5 / `system_reminder` 1，另带 `uiVisibility`/`providerVisibility`/`transcriptVisibility`。
  - ⚠️ **按 `role` 映射会把用户轮次虚报 2.12×**：`role='user'` 有 189 条，其中真实用户输入只有 89 条，其余 100 条是 todo/system/background 注入。规则：`origin='real_user'` → `message.user`；`assistant_response` → `message.assistant`；其余 4 类 → `type='unknown'` + `subtype=kind`（§5.3 保留 subtype 而非丢弃，Timeline 看得见注入，Turn 计数不被污染）。
  - ⚠️ **同一条规则必须同时管住 `part` 的内容行**：那 100 条注入消息各自带着 **1 条自己的 `text` part**（94+5+1=100，实测）。若 part 侧仍按"父消息 role"分派，内容层就在 message 层的 2.12× 之上再翻一倍。实现里两处共用 `semantics` 判定，`fixtures` 与测试各钉一条。
- `part.data.type`：`tool` 1,851 / `step-start` 1,385 / `step-finish` 1,355 / `text` 1,004 / `reasoning` 928 / `timeline` 29 / `file` 4；`part.data` 最大 185,959 B（read/write 类工具的整页正文都在这）⇒ 内容层沿用 OpenCode 的 `FILE_BODY_*_TOOLS` 排除表与 4KiB/32KiB 截断。
- 能力面（比 Claude 多一列）：`tool_usage` 除 `tool_name` 外带 `read_only` / `destructive` / `side_effect_scope ∈ {system 672, workspace 593, none 464, session 99, network 19, userInteraction 4}`（合计 1,851 = 全表；写这份简报时把 none/userInteraction 各记少 1，已按重测改正，词表不变） / `exit_code` / `output_bytes` / `truncated` / `duration_ms`。`approval_status` 恒 `none`（yolo 模式）。工具名是 **Claude Code 方言**（Bash/Edit/Read/Write/TodoWrite/Agent/WebFetch/Skill/AskUserQuestion/ExitPlanMode/TaskOutput/TaskStop）+ `mcp__server__tool` 两级与 `mcp__plugin_<plugin>_<server>__<tool>` 三级并存。
- **工具结果只从 `tool_usage` 读，不读 `part` 里的 tool state**：`part` 行 rowid 会被 UPDATE 复用（pending→completed），增量扫描重读不到；`tool_usage` 是 insert-only，且 1,851 行的 `tool_call_id` 与 `part.data.callID` **1:1 完全对齐**（实测 `eq=1851/1851`）。⇒ `part.tool` 出 `tool.start`（能力 + 入参），`tool_usage` 出 `tool.end`/`tool.result`（状态、耗时、退出码、副作用分类）。

## 六、rollout / 日志通道：为什么都不采

`cli/rollout/model-io-*.jsonl` 每行一次调用（`type='model_io'`，含 `requestId/attempt/model/request/response/sessionId/querySource/startedAt/turnId`，usage 在 `response.providerMetadata.anthropic.usage`）。三条实测理由排除它：

1. **覆盖不全**：38 个会话只有 3 个有 rollout 文件；`sess_e03c6cb0` 在 `model_usage` 里有 172 行，rollout 只有 75 条 ⇒ 受 `v2/setting.json` 的 `modelIoFullRetentionEnabled` 控制，是开关型详细日志。
2. **id 空间不同**：rollout 的 `requestId` 是 provider 侧 id，**0/96 命中** `logical_request_id` ⇒ 与主库对账只能靠会话+时间窗，天然不可靠；用它当请求键会绕过主库的 1:1 保证。
3. **时间戳方言不同**：rollout 是 ISO 字符串、`attempt` 从 1 起；主库是 epoch ms、`attempt_index` 从 0 起。加上正文含完整 prompt、`Cookie`/`set-cookie`、`x-aliyun-captcha-verify-param` —— **隐私成本远大于收益**（token 已在主库里逐字段相等）。

`cli/log/*.jsonl` 同理：它有 `core.runtime/model.request.*`、`adapters.model/model.request.completed` 1,427 条，但只带 `durationMs`/`status`，不带 token；与主库争不了口径，本轮不采（error 可见性已由 `model_usage.error_*` 覆盖）。

## 七、事件映射定稿（`adapters/zcode`）

| 源（`kind:'sqlite'`，id 盐 = `{db}#{table}`） | 事件 |
|---|---|
| `session`（38） | `session.start`（title/mode/version/rollup 进 metadata）；子代理会话再出 `subagent.start`；`time_compacting` 非空出 `context.compact`（本机 0 条，§17 第 5 项的答案：ZCode 与 OpenCode 一样只用会话时间戳表达压缩）；`time_archived` 非空才出 `session.end`（本机 0 条） |
| `message`（1,603） | 按 §五 的 `semantics` 规则；`data.error` 出 `error` 事件；**不带 usage**（副本 #3） |
| `part`（6,556） | `step-start`→`generation.start`；`tool`→`tool.start`（`Agent`→`subagent.start`，`Skill`→`skill.invoke`，`mcp__*`→`mcp.invoke`）；`text`/`reasoning`→内容事件（**按 §五 的 `semantics` 分派，不看 role**）；`step-finish`→`unknown`+`subtype='step-finish'`+`metadata.duplicate_of='model_usage'`（**不产 usage**，留漂移证据，且 subtype 保持短枚举、出处写在 metadata 里才可 grep）；`timeline`/`file`→`unknown`+subtype |
| `model_usage`（1,395） | `generation.end`：唯一 usage 载体，`requestId=logical_request_id`，`threadId=turn_id`，`metadata.subagentThread` 由 `session.parent_id` 决定，`status/error_type/error_code` + `deriveErrorFingerprint`，`duration_ms`/`time_to_first_token_ms` 进 metadata |
| `tool_usage`（1,851） | `tool.end` + `tool.result`：`parentEventId` 由 `tool_call_id` 反查 `part.tool` 的事件 id；带 `exit_code`/`output_bytes`/`side_effect_scope`/`read_only`/`destructive` |

- **`turn_usage` / `session_target` / `agents/*/metadata.json` 不是源**（rollup，§三）。
- 宿主：`host_id = 'zcode'`（§二）。项目：`session.directory`/`session.path` 喂 `ctx.resolveProject`（本机 2 个目录 = cable-info 35 + picko 3 会话），native `project_id`（`proj_users-tanzz-workspaces-cable-info`）记进 metadata 供对账，不参与归一化（§4.1 三步归一仍是权威）。
- `ParserVersion`：初版 1，`context.compact` 事件化后升 2/3（v2 是仓库级 identity/provenance 变更，v3 是本条）；`aggregation = { mode: 'per_record_sum', subagentsIncluded: true }` —— `mode` 的依据是"`model_usage` 每请求恰一行、每行只说这一次调用"（`request_max` 在此算术等价，但声明要说清粒度，且未来出现重试行时 `per_record_sum` 不会把真实花费折没）。
- **`session` 表并不与 OpenCode 同构**（本文开头"三表是 OpenCode 形状"那句只对 `message`/`part` 成立）：ZCode 的 `session` **没有** `mode`/`agent`/`model`/`cost`/`tokens_*` 列。三个后果都已在实现里处理：(a) 模式要从 `permission` 这个 JSON 列里取（`{"mode":"yolo"}`，38/38）；(b) 由 session 行产出的 `subagent.start` **叫不出子代理的种类**（`zcode-Explore` / `zcode-general-purpose` 只存在于逐请求的 `model_usage.agent`），故 capability 名固定为 `subagent`、provider 标 `session.parent_id`，不臆造；(c) `session.start` 的 `metadata.rollup` 没有 cost/token 可带，只能放 `summary_*` 那几个（本机全 NULL）计数器。
- 版本：`Detection.agentVersion` 取 `schema_migration.app_version`（取不到时回落 `session.version`）。本机两个库都是 WAL ⇒ 探测期开不了库，`agl doctor` 如实显示 `v?` 并列出"5 个 SQLite 源只嗅探头部、一个都没打开"——这与 OpenCode 在同一台机器上的表现**逐字一致**（§18 row 7 的既定代价，不是 zcode 的缺陷）；逐会话真实版本 `0.16.5` 在摄入时由 `session.version` 落到 `session.start.metadata`。桌面 App 的版本（`3.11.2`/`3.12.1`）只属于那台机器上那个 App，挂到逐会话事件上就是臆造的范围 ⇒ **不采**，只在本文备案。

## 八、待实测确认（2026-09-22 第二轮：三项已推进，三项仍待样本）

1. ✅ **纯 CLI 用户的形态——已查到底，本机无法闭合**（证据与判定见 §二·补）：桌面与 CLI 跑的是同一个引擎产物 `zcode.cjs`，`~/.zcode/cli/` 只是 `nativeConfigDir` 的名字；`tasks-index.sqlite` 在引擎里 **0 个写入者**，所以"命中 task 索引"确实是桌面证据。但这台机器**根本没装独立 CLI**（PATH/brew/npm 全局全无，只有 `~/ZCode-3.11.2-mac-arm64.dmg`），故负例（终端创建的会话到底写什么）拿不到。要补的观测只有一条：在装有命令行 `zcode` 的机器上跑一个会话，看它是否留 `tasks` 行。
2. ✅ **`variant='disabled'` 与 `reasoning_tokens` 恒 0 的关系——已量（`probe-zcode.mjs` §6b）**：上游**根本不上报思考 token**（`model_usage.reasoning_tokens>0` 0 行、`message.data.tokens.reasoning` 1,414 条全 0、`raw_usage_json` 里连 `reasoning`/`thinking` 字样都 0 命中），但**思考内容海量存在**：928 条 `part.type='reasoning'`、合计 **3,265,454 字符**，单条最长 183,165 字符。`variant` 确实在控制它——`disabled` 的 9 个请求带 0 条 reasoning part，`max` 1,363 个请求里 916 个有，`low` 23 里 12 有。每条 reasoning 自带 `{start,end}` 毫秒时间戳。
   **⇒ 对 ZCode+GLM，"思考量"只能用字符与时长度量，不能用 token**；适配器把 `reasoningTokens` 映射为 0 是诚实的（`computed == input+output` 全表成立，没有把思考算两遍），但 UI/doctor 若按"reasoning token = 0 即没思考"呈现就会说谎——这正是 §18 row 5 要求"测不出来的一态不印 0"的那一类。
3. ✅ **`cost` 会不会变非零——已用引擎代码定论：不会，它是恒 0 的死字段**。`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`（11,227,632 B）里 `cost:0` 字面量赋值恰 **7 处**（step-finish、assistant message 的 `data` 构造器、session_fork、timeline_event、history import 等），**没有任何按套餐/按量分叉的写入者**；schema 侧 `cost` 是 `number().nonnegative()` **必填**，所以引擎每次必须交出一个数，它交出的就是 `0`。全库 `payg` / `pay_as_you_go` / `perToken` / `inputPrice` **0 命中**，真实计费模式枚举只有 `accountType ∈ {zai, bigmodel}` × `mode ∈ {start-plan, individual-coding-plan, team-coding-plan, off-peak}`（无按量档）。⇒ **原来这条待测项"换按量账号会不会非零"根本不成立：换了账号也还是 0**。钱在 ZCode 里只活在另一条网络通道（`/v1/credits`、`/v1/report`、`zcode-plan/billing/current`，以及 OpenRouter 形状的 Gateway 客户端自带 `total_cost/market_cost/pricing`），本地 `message`/`part`/`model_usage` 三张表没有任何一列镜像它（`model_usage` 的建表 DDL 里 cost/price 列数为 0）。**决定**：适配器**不加** `cost_source='reported'` 分支——那是没有证据的死代码。仍未验证的只剩 `off-peak` 与 Gateway provider 是否用户可选、`/v1/report` 对套餐账号是否可达，都不影响"本地恒 0"的结论。
4. `session_task_link`/`workflow_*`/`dwf_*` 五张表本机全空（自动化/off-peak 功能），启用后是不是第 6 份用量口径；`off_peak_tasks` 在桌面库里已有表结构。
5. ✅ **子代理父链已接通（2026-09-23，`54b0476` + `ffed341` + `639851e`）**。当时记的"卡在跨包决定上"三处都已落地：
   - 共享模块接受**以原始 call id 表达证明**（`SubagentLinkVocabulary.proofNames:'tool-use-id'`），由本会话的候选池解析，且要求唯一命中——一个 raw id 指向两个 spawn 时按"无证明"作废，而不是挑一个；默认值 `'event-id'` 保持 claude-code 逐字不变。
   - `Agent` 部件从 `subagent.start` 改判为 **`tool.start` + capability `subagent`**（那正是候选池的查询形状），链的标记仍是子会话自己的 `subagent.start`——spawn 与 chain 是两个事实，不再抢同一个事件类型。
   - 第 6 个源 `cli/agents/<父会话>/agent_<id>/metadata.json` 产出闭合的 `subagent.end`：整文档读取（pretty-printed JSON 没有行边界，`from.offset` 被有意忽略、`nextOffset` 是实际消费字节数），**只取白名单字段**——同一份文件带着完整子代理提示词与 `profileSnapshot`，隐私测试用金丝雀钉住"任何一行事件里都不许出现"；它的 `totalTokens`/`usage` 是 §三 的第 5 份副本，只进 `metadata.rollup`，事件自身 `usage` 为 null。
   - **真库复测**：33 个源（5 张表 + 28 份文档）、11,519 事件、**28 条链全部按 `foreign-key` 接通，0 条靠启发式、0 条未决**，`doctor` 那句对 ZCode 说反了的"没有外键可退"随之消失；对账总量仍是 167,593,984 一位不差（新增源没带进任何 token）。
   仍开着的只有一件：`off-peak` / 自动化启用后会不会出现别的父子形态（§八·4）。

6. ✅ **对账回归已进 CI**：`apps/cli/test/reconcile-zcode.test.ts` 把 §15 M3 那条"产品路径自己复现 ccusage"升成回归项，走 `runScan` → WAL 快照 → `insertEvents` → 持久化 `aggregation_policy` → §7 立方体，**不重实现任何分帧/折叠/计价**。两个语料同一条路：**fixture 用例恒跑**（合成 WAL 库 + 常驻写连接，托管 CI 也能跑，并自带独立 oracle——用 JS 直接加总夹具的原始列，验证立方体等于 `input+output` 而"逐字段照搬"会多出缓存那一整份）；**live 用例**在 `~/.zcode` 存在时比对基线的四字段与**逐日**拆分、`includeSubagentThreads:false` 恰减 15,657,611、`cost_source='reported'` 恒 0 行，缺席时在套件名里显式写 `SKIPPED`，不静默。"哪五张表成了源、rollup 一张都没进"本身就是断言。

## 九、端到端对账（已执行，2026-09-22，真库 +  shipped 适配器）

`ZCODE_HOME` 指向 `~/.zcode/cli/db/db.sqlite` 的**副本**（含 `-wal`、不含 `-shm`），`agl scan` 写进一个临时 AgentLens 库，再用 `node docs/research/reconcile-zcode-ccusage.mjs ccusage-zcode-baseline.json --agentlens-db <db>` 判定：

| 项 | 结果 |
|---|---|
| 摄入 | 5 个 SQLite 源、**11,491 事件、0 解析失败**；`sources` 5 行全 `active` |
| 四桶 vs ccusage 基线 | `input 7,382,171` / `cacheRead 158,848,192` / `output 1,363,621` / 合计 `167,593,984` ⇒ **逐位相同，偏差 0（0.0000%）** |
| 承载 usage 的行 | 1,395 行 = 1,395 个不同 `request_id`（1:1，无重复计数） |
| 成本 | `cost_reported` 行数 **0**、`cost_source` 全 `none` ⇒ 恒 0 的套餐 `cost` 没被当成 $0 发布；`agl projects` 读作 `n/a`（未定价），ccusage 同窗亦 `unpricedModels: GLM-5.3-Flash` |
| 五种口径对照 | A 逐字段照搬 **+94.8%** · B 减缓存（采纳）**命中** · C 再读 `turn_usage` **+100.0%** · D 再读 `step-finish` 副本 **+100.0%** · E 排除 subagent **−9.3%** |
| 项目归组 | 2 个项目、0 条 `unattributed`：`cable-info` 9 会话 158.4M、`picko` 1 会话 9.2M（`agl projects` 直接印目录名，§4.1 通路正常） |
| 粒度 | `session_id` 10 个（根会话）· `thread_id` 38 个（含子代理）⇒ 产品粒度与源粒度按 §18 row 3 分开 |
| 能力四维 | `tool` 11 种名 / `subagent` 3 / `mcp` 5 / `skill` 3（`mcp.invoke` 6、`skill.invoke` 2 条事件），无一维被伪报为 0 |
| 状态 | `generation.end` 1,365 `ok` + 30 `error`（error 行 token 为 0，与库里 `input_zero=30` 一致） |
| 幂等 | 第二次 `scan`：zcode 五个源各 `append 0`，总量不变（11,491 / 167,593,984 / 1,395）⇒ §4.2 + rowid 高水位在真库规模上成立 |
| 副作用 | 全程 `~/.zcode` 的 `size`/`mtime` 逐字节不变（脚本每次自检并打印 ✅），WAL 拒开由 `doctor` 如实列出 |

`unknown` 事件 1,617 条的 subtype 分布（`step-finish` 1,355 / `todo_reminder` 188 / `timeline_event` 29 / `timeline` 29 / `background_notification` 10 / `file` 4 / `system_reminder` 2）——注意 `todo_reminder` 的 188 = 94 条 message 行 + 94 条自带 text part，正是 §五 那条"注入有两个载体"的实测形状；`message.user` 只有 178 条而非按 role 直映的 378 条，2.12× 的虚报被规则挡在外面。

**同轮两处补做**（2026-09-22 第二轮）：`session.time_compacting` 从"埋在 `session.start.metadata` 里的一个字段"改成 `context.compact` 事件（与 OpenCode 同形，`PARSER_VERSION` 3；本机 0 行有值，所以这条只有夹具能证），并落了 §15 M3 形态的回归门 `apps/cli/test/reconcile-zcode.test.ts`——fixture 用例恒跑、live 用例自我跳过，两者走同一条 `runScan` → 快照 → `insertEvents` → 持久化 policy → §7 立方体的产品路径。

**第三轮复测（2026-09-23，第 6 个源接上之后）**：同一个真库现在报 **33 个源**（5 张表 + 28 份 `cli/agents/…/metadata.json`）、**11,519 事件**（+28 条 `subagent.end`）、仍 **0 解析失败**；四桶合计**一位不变**（167,593,984）——闭合行自身不带 usage，这正是 §三"只认 `model_usage`"在新增源之后依然成立的直接证据。子代理链 **28/28 按 `foreign-key` 接通、0 靠启发式、0 未决**，`doctor` 关于本 Agent"没有外键可退"的那行随之消失。

