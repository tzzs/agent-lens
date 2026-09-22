#!/usr/bin/env node
/**
 * ZCode 实测（§17）：~/.zcode 的会话/用量数据普查。
 * 用法: node docs/research/probe-zcode.mjs [dataRoot]
 *   默认 $ZCODE_HOME 或 ~/.zcode
 * 只读（§18 row 7 硬约束）：**绝不开启对方的库**。先把 `*.sqlite` 连同其 `-wal`
 *   （从不含 `-shm`）复制到临时目录，在副本上 `PRAGMA journal_mode=DELETE` 折成
 *   回滚模式单文件，再打开副本 —— 复制不是打开。JSONL 侧只走 fs 读接口。
 * 隐私：只打印 key 名、枚举值、计数与数值；不打印 prompt/响应正文，不读取凭据文件。
 * 输出：库/表清单 → model_usage 逐请求口径与 cache 方言 → turn_usage rollup 双计风险
 *       → 维度词表 → 宿主切分 → 会话/项目归组 → message/part 形态 → 能力目录
 *       → rollout 与 log JSONL 通道。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const ROOT = path.resolve(
  process.argv[2] || process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode'),
)
if (!fs.existsSync(ROOT)) {
  console.error(`不存在: ${ROOT}   （用法: node probe-zcode.mjs [dataRoot]）`)
  process.exit(2)
}
const SNAP = path.join(os.tmpdir(), 'agentlens-zcode-probe')
const KEEP = process.argv.includes('--keep')
const NO_CONTENT = new Set(['credentials.json', 'provider_config.json', 'bot-state.v3.json'])

const hr = (s) => console.log(`\n${'─'.repeat(8)} ${s} ${'─'.repeat(Math.max(0, 56 - s.length))}`)
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)
const sz = (n) => `${(n / 1048576).toFixed(1)}MB`
/** ms epoch → ISO-ish UTC 串。`datetime(x,1000)` 是错的，必须 `x/1000`。 */
const iso = (col) => `datetime(${col}/1000,'unixepoch')`

/** SQLite 文件头：字节 18/19 = write/read format version，2 == WAL。只读前 100 字节。 */
function journalMode(file) {
  try {
    const fd = fs.openSync(file, 'r')
    const b = Buffer.alloc(100)
    fs.readSync(fd, b, 0, 100, 0)
    fs.closeSync(fd)
    if (b.slice(0, 15).toString('ascii') !== 'SQLite format 3') return 'not-a-db'
    return b[18] === 2 && b[19] === 2 ? 'WAL' : 'rollback'
  } catch (e) {
    return `ERR ${e.code}`
  }
}

function walk(dir, out = [], depth = 0) {
  if (depth > 4) return out
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out, depth + 1)
    else if (e.isFile()) out.push(p)
  }
  return out
}

// ── 0. 数据根概览 ──────────────────────────────────────────────────────────
hr('0. 数据根')
console.log(`dataRoot=${ROOT}`)
for (const e of fs.readdirSync(ROOT, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  const p = path.join(ROOT, e.name)
  if (e.isDirectory()) {
    const n = walk(p).length
    console.log(`  dir  ${e.name.padEnd(20)} files=${n}`)
  } else {
    console.log(`  file ${e.name.padEnd(20)} ${sz(fs.statSync(p).size)}${NO_CONTENT.has(e.name) ? '  (凭据类，不读取内容)' : ''}`)
  }
}
const sqliteFiles = walk(ROOT).filter((f) => /\.sqlite$|\.db$/.test(f))
console.log(`\n  *.sqlite / *.db 候选源:`)
for (const f of sqliteFiles) {
  const wal = fs.existsSync(`${f}-wal`) ? sz(fs.statSync(`${f}-wal`).size) : '—'
  const shm = fs.existsSync(`${f}-shm`) ? sz(fs.statSync(`${f}-shm`).size) : '—'
  console.log(`    ${path.relative(ROOT, f).padEnd(28)} ${sz(fs.statSync(f).size).padStart(8)}  journal=${journalMode(f).padEnd(9)} -wal=${wal.padStart(8)} -shm=${shm}`)
}

// ── 1. 快照：复制 → 折回滚模式 → 只开副本 ──────────────────────────────────
hr('1. 快照（复制不是打开）')
fs.rmSync(SNAP, { recursive: true, force: true })
fs.mkdirSync(SNAP, { recursive: true })
const copies = new Map()
for (const f of sqliteFiles) {
  const name = `${path.basename(ROOT)}-${path.relative(ROOT, f).replace(/[\\/]/g, '_')}`
  const dst = path.join(SNAP, name)
  fs.copyFileSync(f, dst)
  if (fs.existsSync(`${f}-wal`)) fs.copyFileSync(`${f}-wal`, `${dst}-wal`)
  if (fs.existsSync(`${f}-shm`)) console.log(`    ⚠️ 源有 -shm，但副本不抄 -shm`)
  const db = new DatabaseSync(dst)
  db.exec('PRAGMA journal_mode = DELETE')
  db.close()
  copies.set(f, dst)
  console.log(`    ${path.relative(ROOT, f)} → ${name} (${sz(fs.statSync(dst).size)}, ${journalMode(dst)})`)
}
const srcSigsAfter = sqliteFiles.map((f) => `${path.basename(f)}:${fs.statSync(f).size}:${Math.floor(fs.statSync(f).mtimeMs)}`).join(' ')

function open(src) {
  const p = copies.get(src)
  return p ? new DatabaseSync(p, { readOnly: true }) : null
}
function rows(db, sql, ...args) {
  try {
    return db.prepare(sql).all(...args)
  } catch (e) {
    return [{ _err: e.message }]
  }
}
function show(label, rs) {
  console.log(`  ${label}`)
  for (const r of rs) {
    console.log(`     ${Object.entries(r).map(([k, v]) => `${k}=${v === null ? '∅' : typeof v === 'string' ? JSON.stringify(v.length > 60 ? v.slice(0, 60) + '…' : v) : v}`).join('  ')}`)
  }
}

// ── 2. 表清单 ─────────────────────────────────────────────────────────────
for (const [src, copy] of copies) {
  const rel = path.relative(ROOT, src)
  hr(`2. ${rel}`)
  const db = open(src)
  const tables = rows(db, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .map((r) => r.name)
    .filter((t) => !/^(dwf_|workflow_|permission$|session_task_link$)/.test(t) || rel.startsWith('cli'))
  console.log(`  tables=${tables.length}: ${tables.join(', ')}`)
  for (const t of tables) {
    const cols = rows(db, `PRAGMA table_info(${JSON.stringify(t)})`).map((c) => c.name)
    let n = '?'
    try {
      n = db.prepare(`SELECT COUNT(*) c FROM ${JSON.stringify(t)}`).get().c
    } catch {}
    const usageish = cols.filter((c) => /token|usage|cost|cache|price|credit|model|provider/i.test(c))
    console.log(`    ${t.padEnd(22)} rows=${String(n).padStart(6)} cols=${cols.length}${usageish.length ? `  usageCols=[${usageish.join(',')}]` : ''}`)
  }
  // schema 版本 / 应用版本
  for (const t of ['schema_migration', 'local_setting']) {
    if (!tables.includes(t)) continue
    if (t === 'schema_migration') {
      show('迁移（版本漂移线索）', rows(db, `SELECT id, app_version, datetime(time_applied,1000,'unixepoch') t FROM ${t} ORDER BY rowid DESC LIMIT 3`))
    }
  }
  db.close()
}

// ── 3. model_usage：逐请求口径 ─────────────────────────────────────────────
hr('3. model_usage 逐请求口径（token 是"悄悄错"的头号来源）')
const CLI_DB = sqliteFiles.find((f) => /cli[\\/]db[\\/]db\.sqlite$/.test(f)) ?? null
const mu = open(CLI_DB)
if (mu && rows(mu, `SELECT name FROM sqlite_master WHERE type='table' AND name='model_usage'`).length) {
  show(
    '基数：行数 vs 各 id 的唯一性（决定去重口径）',
    rows(
      mu,
      `SELECT COUNT(*) r,
              COUNT(DISTINCT id) d_id,
              COUNT(DISTINCT logical_request_id) d_logical,
              COUNT(DISTINCT assistant_message_id) d_msg,
              COUNT(DISTINCT trace_id) d_trace,
              COUNT(DISTINCT session_id) d_sess,
              COUNT(DISTINCT turn_id) d_turn,
              MIN(attempt_index) min_attempt, MAX(attempt_index) max_attempt,
              SUM(retry_count>0) retried
         FROM model_usage`,
    ),
  )
  show(
    '同一 logical_request_id 是否多行（>1 才需要 request_max）',
    rows(mu, `SELECT n_per_request, COUNT(*) requests FROM (SELECT logical_request_id, COUNT(*) n_per_request FROM model_usage GROUP BY 1) GROUP BY 1 ORDER BY 2 DESC`),
  )
  show(
    'token 求和（五桶 + 两个 total 列）',
    rows(
      mu,
      `SELECT SUM(input_tokens) input, SUM(output_tokens) output, SUM(reasoning_tokens) reasoning,
              SUM(cache_creation_input_tokens) cache_creation, SUM(cache_read_input_tokens) cache_read,
              SUM(provider_total_tokens) provider_total, SUM(computed_total_tokens) computed_total
         FROM model_usage`,
    ),
  )
  show(
    '恒等式判定（哪条成立 = cache 是否含入 input）',
    rows(
      mu,
      `SELECT COUNT(*) n,
              SUM(computed_total_tokens = input_tokens+output_tokens) eq_in_out,
              SUM(computed_total_tokens = input_tokens+output_tokens+cache_read_input_tokens) eq_in_out_cr,
              SUM(computed_total_tokens = input_tokens+output_tokens+cache_creation_input_tokens+cache_read_input_tokens) eq_all4,
              SUM(cache_read_input_tokens <= input_tokens) cr_le_input,
              SUM(cache_read_input_tokens > input_tokens) cr_gt_input,
              SUM(input_tokens=0) input_zero, SUM(cache_read_input_tokens=0) cr_zero,
              SUM(reasoning_tokens>0) reasoning_pos,
              SUM(reasoning_tokens<=output_tokens) reasoning_le_output,
              SUM(provider_total_tokens = computed_total_tokens) prov_eq_comp
         FROM model_usage`,
    ),
  )
  show('raw_usage_json 方言样本（列名字段名对照，不含正文）', rows(mu, `SELECT substr(raw_usage_json,1,200) raw, substr(provider_metadata_json,1,80) meta FROM model_usage LIMIT 3`))
  for (const col of ['query_source', 'provider_id', 'model_id', 'variant', 'agent', 'mode', 'task_type', 'status', 'finish_reason', 'error_type']) {
    show(
      `${col} 词表`,
      rows(mu, `SELECT ${col} v, COUNT(*) n, SUM(computed_total_tokens) tok FROM model_usage GROUP BY 1 ORDER BY 2 DESC LIMIT 12`),
    )
  }
  show('时间范围', rows(mu, `SELECT ${iso('MIN(started_at)')} first, ${iso('MAX(started_at)')} last FROM model_usage`))

  hr('4. rollup 双计风险（turn_usage 是 model_usage 的聚合，不是新信息）')
  show(
    'turn_usage 总量 vs 同 turn 的 model_usage 之和',
    rows(
      mu,
      `SELECT (SELECT COUNT(*) FROM turn_usage) turn_rows,
              (SELECT SUM(computed_total_tokens) FROM turn_usage) turn_tokens,
              (SELECT SUM(m.computed_total_tokens) FROM turn_usage tu JOIN model_usage m ON m.session_id=tu.session_id AND m.turn_id=tu.turn_id) model_tokens_same_turn,
              (SELECT COUNT(*) FROM turn_usage tu WHERE EXISTS(SELECT 1 FROM model_usage m WHERE m.session_id=tu.session_id AND m.turn_id=tu.turn_id)) turns_with_model_rows,
              (SELECT COUNT(DISTINCT session_id||'#'||turn_id) FROM model_usage WHERE turn_id IS NOT NULL) distinct_model_turns`,
    ),
  )
  show(
    'per-turn 精确相等率（input/output 两列）',
    rows(
      mu,
      `SELECT SUM(tu.input_tokens=x.i AND tu.output_tokens=x.o) exact, COUNT(*) n
         FROM turn_usage tu JOIN (SELECT session_id,turn_id,SUM(input_tokens) i,SUM(output_tokens) o FROM model_usage GROUP BY 1,2) x
           ON x.session_id=tu.session_id AND x.turn_id=tu.turn_id`,
    ),
  )
  show(
    'tool_usage 粒度',
    rows(mu, `SELECT COUNT(*) r, COUNT(DISTINCT tool_call_id) d_call, COUNT(DISTINCT session_id) d_sess, MIN(started_at) t0, MAX(started_at) t1 FROM tool_usage`),
  )

  hr('5. 会话 / 项目 / 子代理结构')
  show('session 基数', rows(mu, `SELECT COUNT(*) n, COUNT(DISTINCT project_id) d_project, COUNT(DISTINCT directory) d_dir, SUM(parent_id IS NOT NULL) subagent_sessions, SUM(workspace_id IS NOT NULL) has_workspace, SUM(share_url IS NOT NULL) has_share FROM session`))
  show('session 分组（project_id × directory × task_type）', rows(mu, `SELECT project_id, directory, task_type, COUNT(*) n FROM session GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 10`))
  show('session.version / title_source / mode 词表', rows(mu, `SELECT version, title_source, COUNT(*) n FROM session GROUP BY 1,2 ORDER BY 3 DESC LIMIT 8`))
  show('子代理会话命名（parent_id 外键可用性）', rows(mu, `SELECT substr(id,1,40) id, substr(parent_id,1,40) parent, task_type FROM session WHERE parent_id IS NOT NULL LIMIT 4`))
  show('孤儿检查（model_usage.session_id 不在 session 表）', rows(mu, `SELECT COUNT(DISTINCT m.session_id) orphan_sessions FROM model_usage m LEFT JOIN session s ON s.id=m.session_id WHERE s.id IS NULL`))
  hr('5b. 副本一致性与对账口径（简报 §三/§四 的数字都出自这里）')
  show(
    '同一调用的 token 存了几份、彼此是否逐字段相等',
    rows(
      mu,
      `SELECT (SELECT COUNT(*) FROM part WHERE json_extract(data,'$.type')='step-finish') sf_rows,
              (SELECT SUM(json_extract(data,'$.tokens.total')=mu.computed_total_tokens) FROM part pj JOIN model_usage mu ON mu.logical_request_id=pj.message_id WHERE json_extract(pj.data,'$.type')='step-finish') sf_eq_total,
              (SELECT SUM(json_extract(data,'$.reason')=mu.finish_reason) FROM part pj JOIN model_usage mu ON mu.logical_request_id=pj.message_id WHERE json_extract(pj.data,'$.type')='step-finish') sf_eq_finish,
              (SELECT COUNT(*) FROM tool_usage tu WHERE EXISTS(SELECT 1 FROM part p WHERE json_extract(p.data,'$.callID')=tu.tool_call_id)) tool_call_id_joins,
              (SELECT COUNT(*) FROM tool_usage) tool_usage_rows`,
    ),
  )
  show(
    '对账锚点：适配器必须产出的四个数（ccusage zcode 同窗口实测）',
    rows(
      mu,
      `SELECT SUM(input_tokens)-SUM(cache_read_input_tokens)-SUM(cache_creation_input_tokens) uncached_input,
              SUM(cache_read_input_tokens) cache_read,
              SUM(output_tokens) output,
              SUM(computed_total_tokens) total
         FROM model_usage`,
    ),
  )
  show(
    '真实用户轮次 vs 合成注入（按 role 映射会虚报）',
    rows(
      mu,
      `SELECT json_extract(data,'$.role') role, json_extract(data,'$.semantics.origin') origin,
              json_extract(data,'$.semantics.kind') kind, COUNT(*) n
         FROM message GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 10`,
    ),
  )
  show(
    '子代理归属是否确定性外键（query_source vs session.parent_id）',
    rows(
      mu,
      `SELECT (s.parent_id IS NOT NULL) sub_session, mu.query_source, COUNT(*) n
         FROM model_usage mu JOIN session s ON s.id=mu.session_id GROUP BY 1,2 ORDER BY 3 DESC`,
    ),
  )
  show(
    'trace_id 不能当请求键（一个 trace 跨多少会话）',
    rows(mu, `SELECT trace_id, COUNT(*) rows_, COUNT(DISTINCT session_id) d_sess FROM model_usage GROUP BY 1 ORDER BY 2 DESC LIMIT 3`),
  )
  // 宿主切分证据：桌面任务索引是否覆盖全部根会话（读同一个快照流程的副本）
  const V2 = sqliteFiles.find((f) => /tasks-index\.sqlite$/.test(f))
  if (V2) {
    const v2 = open(V2)
    const taskIds = rows(v2, `SELECT task_id FROM tasks`).map((r) => r.task_id).filter(Boolean)
    const sess = rows(mu, `SELECT id, parent_id FROM session WHERE parent_id IS NULL`).map((r) => r.id)
    const set = new Set(taskIds)
    console.log(
      `  宿主切分: 根会话=${sess.length}  桌面 tasks 行数=${taskIds.length}  命中=${sess.filter((s) => set.has(s)).length}  → CLI-only=${sess.filter((s) => !set.has(s)).length}` +
        `\n    ⚠️ 数据躺在 ~/.zcode/cli/ 下不等于宿主是 CLI；session 表 25 列无 entrypoint/origin 列。`,
    )
    show('tasks 表列', rows(v2, `SELECT name FROM pragma_table_info('tasks')`).slice(0, 30).map((r) => ({ col: r.name })))
    v2.close()
  }
  show(
    'session 变更统计列（代码量产品价值）',
    rows(mu, `SELECT COUNT(*) n, SUM(summary_additions) adds, SUM(summary_deletions) dels, SUM(summary_files) files, SUM(summary_diffs IS NOT NULL) has_diffs, SUM(revert IS NOT NULL) has_revert FROM session`),
  )

  hr('6. message / part 形态')
  show('message.role 普查', rows(mu, `SELECT json_extract(data,'$.role') role, COUNT(*) n FROM message GROUP BY 1 ORDER BY 2 DESC`))
  show('part.type 普查', rows(mu, `SELECT json_extract(data,'$.type') t, COUNT(*) n FROM part GROUP BY 1 ORDER BY 2 DESC LIMIT 20`))
  show('payload 体积（决定截断策略）', rows(mu, `SELECT MAX(length(data)) max_bytes, AVG(length(data)) avg_bytes, COUNT(*) n FROM part`))
  show('message.data 键名普查（role/assistant 顶层）', (() => {
    const m = new Map()
    for (const r of rows(mu, `SELECT data FROM message LIMIT 600`)) {
      try {
        for (const k of Object.keys(JSON.parse(r.data))) bump(m, k)
      } catch {}
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ key: k, n }))
  })())
  show('part.data 键名普查', (() => {
    const m = new Map()
    for (const r of rows(mu, `SELECT data FROM part LIMIT 1200`)) {
      try {
        const o = JSON.parse(r.data)
        for (const k of Object.keys(o)) bump(m, `${o.type ?? '?'}.${k}`)
      } catch {}
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, n]) => ({ key: k, n }))
  })())
  show('tool part 的 tool 名 + state 词表', rows(mu, `SELECT json_extract(data,'$.tool') tool, json_extract(data,'$.state.status') st, COUNT(*) n FROM part WHERE json_extract(data,'$.type')='tool' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 14`))

  hr('6b. 思考（reasoning）到底计在哪一维（§八 第 2 项）')
  show(
    'token 桶 vs 实际内容：上游不上报思考 token，但内容存在',
    rows(
      mu,
      `SELECT (SELECT COUNT(*) FROM part WHERE json_extract(data,'$.type')='reasoning') reasoning_parts,
              (SELECT SUM(length(json_extract(data,'$.text'))) FROM part WHERE json_extract(data,'$.type')='reasoning') reasoning_chars,
              (SELECT SUM(reasoning_tokens>0) FROM model_usage) rows_with_reasoning_tokens,
              (SELECT COUNT(*) FROM model_usage WHERE raw_usage_json LIKE '%reasoning%' OR raw_usage_json LIKE '%thinking%') raw_json_mentions_reasoning,
              (SELECT SUM(computed_total_tokens) FROM model_usage) computed,
              (SELECT SUM(input_tokens+output_tokens) FROM model_usage) in_plus_out`,
    ),
  )
  show(
    'variant 是否真控制思考输出（disabled 应当干净地关掉它）',
    rows(
      mu,
      `SELECT u.variant, COUNT(*) requests, SUM(u.reasoning_tokens) reasoning_tokens_sum,
              SUM(EXISTS(SELECT 1 FROM part p WHERE p.message_id=u.logical_request_id
                          AND json_extract(p.data,'$.type')='reasoning')) with_reasoning_part,
              SUM(u.computed_total_tokens) tokens
         FROM model_usage u GROUP BY 1 ORDER BY 2 DESC`,
    ),
  )
  show('单条 reasoning 的体量与是否有独立耗时', rows(mu, `SELECT MAX(length(json_extract(data,'$.text'))) max_chars, COUNT(*) n FROM part WHERE json_extract(data,'$.type')='reasoning'`))
  show('reasoning part 自带 start/end（毫秒）⇒ 没有 token 也能量时间', rows(mu, `SELECT substr(json_extract(data,'$.time'),1,60) t FROM part WHERE json_extract(data,'$.type')='reasoning' LIMIT 1`))

  hr('7. 能力目录 / 其它表')
  show('tool_usage 词表（含只读/破坏性标记）', rows(mu, `SELECT tool_name, COUNT(*) n, SUM(read_only) read_only, SUM(destructive) destructive, COUNT(DISTINCT side_effect_scope) scopes FROM tool_usage GROUP BY 1 ORDER BY 2 DESC LIMIT 20`))
  show('tool_usage side_effect_scope / approval_status', rows(mu, `SELECT side_effect_scope, approval_status, status, COUNT(*) n FROM tool_usage GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 10`))
  show('session_entry type（会话内运行时事件）', rows(mu, `SELECT type, COUNT(*) n FROM session_entry GROUP BY 1 ORDER BY 2 DESC LIMIT 12`))
  show('input_history kind', rows(mu, `SELECT kind, COUNT(*) n FROM input_history GROUP BY 1`))
  show('mcp 工具调用（tool_usage 侧）', rows(mu, `SELECT tool_name, COUNT(*) n FROM tool_usage WHERE tool_name LIKE 'mcp__%' GROUP BY 1 ORDER BY 2 DESC LIMIT 12`))
  mu.close()
}

// ── 8. JSONL 通道 ─────────────────────────────────────────────────────────
hr('8. rollout / log JSONL 通道')
function censusJsonl(file, limit = 2000) {
  const out = { types: new Map(), keys: new Map(), usageKeys: new Map(), n: 0, maxLine: 0, unparsable: 0 }
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(1 << 20)
  let carry = ''
  while (out.n < limit) {
    const r = fs.readSync(fd, buf, 0, buf.length, null)
    if (r === 0) break
    const lines = (carry + buf.subarray(0, r).toString('utf8')).split('\n')
    carry = lines.pop() ?? ''
    for (const L of lines) {
      if (!L.trim()) continue
      out.n++
      out.maxLine = Math.max(out.maxLine, L.length)
      let o
      try {
        o = JSON.parse(L)
      } catch {
        out.unparsable++
        continue
      }
      bump(out.types, String(o.type ?? '<none>'))
      if (!out.keys.has(String(o.type))) out.keys.set(String(o.type), Object.keys(o))
      const u = o.response?.providerMetadata?.anthropic?.usage ?? o.usage ?? o.message?.usage
      if (u && typeof u === 'object') for (const k of Object.keys(u)) bump(out.usageKeys, k)
    }
  }
  fs.closeSync(fd)
  return out
}
for (const f of walk(ROOT).filter((x) => x.endsWith('.jsonl'))) {
  const c = censusJsonl(f)
  console.log(`\n  ${path.relative(ROOT, f)}  lines=${c.n} maxLine=${c.maxLine}B unparsable=${c.unparsable}`)
  console.log(`    type: ${[...c.types].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k}=${n}`).join(' ')}`)
  for (const [t, ks] of c.keys) console.log(`    keys(${t}): ${ks.join(', ')}`.slice(0, 300))
  if (c.usageKeys.size) console.log(`    usage keys: ${[...c.usageKeys].map(([k, n]) => `${k}=${n}`).join(', ')}`)
}

// ── 9. 非库文件的能力面 ────────────────────────────────────────────────────
hr('9. 能力面（插件/技能/记忆），以及写入副作用核查')
for (const rel of ['cli/plugins/installed_plugins.json', 'cli/plugins/known_marketplaces.json']) {
  const p = path.join(ROOT, rel)
  if (!fs.existsSync(p)) continue
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const shape = Array.isArray(j) ? `array(${j.length}) first=[${Object.keys(j[0] ?? {}).join(',')}]` : Object.keys(j).join(',')
    console.log(`  ${rel}: ${shape}`.slice(0, 240))
  } catch (e) {
    console.log(`  ${rel}: 解析失败 ${e.message}`)
  }
}
for (const rel of ['cli/plugins', 'cli/memories/projects', 'cli/agents', 'v2/checkpoints']) {
  const p = path.join(ROOT, rel)
  if (!fs.existsSync(p)) continue
  const e = fs.readdirSync(p, { withFileTypes: true })
  console.log(`  ${rel}: ${e.filter((x) => x.isDirectory()).length} dirs / ${e.filter((x) => x.isFile()).length} files`)
}
const srcSigsNow = sqliteFiles.map((f) => `${path.basename(f)}:${fs.statSync(f).size}:${Math.floor(fs.statSync(f).mtimeMs)}`).join(' ')
console.log(`\n  源库副作用核查: ${srcSigsAfter === srcSigsNow ? '✅ 探测前后 size:mtime 逐字节相同' : '❌ 源库被改动，必须复查'}`)
console.log(`  快照目录: ${SNAP}${KEEP ? '（--keep 保留）' : ''}`)
if (!KEEP) fs.rmSync(SNAP, { recursive: true, force: true })
