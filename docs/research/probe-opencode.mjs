#!/usr/bin/env node
/**
 * OpenCode 实测（§17 第 3 项）：SQLite 结构、token/usage 列、session 稳定性、能力表。
 * 用法: node docs/research/probe-opencode.mjs [opencode.db]
 *   默认 ~/.local/share/opencode/opencode.db
 * 只读：node:sqlite readOnly 打开；打印前后检查 -wal/-shm 是否被本次打开新建。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const DB = path.resolve(process.argv[2] || path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'))
if (!fs.existsSync(DB)) { console.error(`不存在: ${DB}   （用法: node probe-opencode.mjs [opencode.db]）`); process.exit(2) }
console.log(`DB=${DB.replace(os.homedir(), '~')}  size=${(fs.statSync(DB).size / 1048576).toFixed(1)}MB`)
const acc = [DB + '-wal', DB + '-shm']
const before = acc.map((a) => fs.existsSync(a))

const db = new DatabaseSync(DB, { open: true, readOnly: true })
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r) => r.name)
console.log(`tables(${tables.length}): ${tables.join(', ')}`)

console.log('\n## 各表行数 + 含 token/usage/cost/cache/model/session 的列')
for (const t of tables) {
  let cols = []
  try { cols = db.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all().map((c) => c.name) } catch { continue }
  let n = '?'
  try { n = db.prepare(`SELECT COUNT(*) c FROM ${JSON.stringify(t)}`).get().c } catch { }
  const interesting = cols.filter((c) => /token|usage|cost|cache|model|price|session|prompt|completion|reasoning|tokens/i.test(c))
  if (interesting.length || /session|message|part|usage|project/i.test(t))
    console.log(`  ${t.padEnd(24)} rows=${String(n).padStart(7)}  cols=[${cols.join(', ')}]`)
  if (interesting.length) console.log(`      ↳ 关键字段: ${interesting.join(', ')}`)
}

// 尝试从 message / part 表取 usage/成本样本（仅列名与数值，不打印文本正文）
for (const t of ['message', 'part', 'session', 'session_usage', 'usage']) {
  if (!tables.includes(t)) continue
  try {
    const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all().map((c) => c.name)
    const tokenCols = cols.filter((c) => /token|cost|cache|price|usage|model/i.test(c))
    if (!tokenCols.length) continue
    const sel = ['id', ...tokenCols].slice(0, 8)
    const rows = db.prepare(`SELECT ${sel.map((c) => JSON.stringify(c)).join(',')} FROM ${JSON.stringify(t)} LIMIT 3`).all()
    console.log(`\n  样本 ${t}: ${JSON.stringify(rows).slice(0, 500)}`)
  } catch (e) { console.log(`  ${t} 查询失败: ${e.message}`) }
}
db.close()
const after = acc.map((a) => fs.existsSync(a))
const created = acc.filter((_, i) => !before[i] && after[i])
console.log(`\n只读打开结论: open=OK   本次新建 -wal/-shm = ${created.length ? '⚠️ ' + created.map((c) => path.basename(c)).join(',') : '无（安全）'}`)

// —— 追加：per-record data JSON 里的 usage/cost/tool 粒度 ——
{
  const db2 = new DatabaseSync(DB, { open: true, readOnly: true })
  const parseKeys = (tbl, col = 'data') => {
    const out = new Map(); let rows = []
    try { rows = db2.prepare(`SELECT ${JSON.stringify(col)} d FROM ${JSON.stringify(tbl)} LIMIT 400`).all() } catch { return out }
    for (const r of rows) { let o; try { o = JSON.parse(r.d) } catch { continue } for (const k of Object.keys(o)) out.set(k, (out.get(k) ?? 0) + 1); if (o.type) out.set('type=' + o.type, (out.get('type=' + o.type) ?? 0) + 1); if (o.tool) out.set('tool=' + o.tool, (out.get('tool=' + o.tool) ?? 0) + 1) }
    return out
  }
  for (const t of ['message', 'part', 'session_message']) {
    if (!tables.includes(t)) continue
    const k = parseKeys(t)
    console.log(`\n## ${t}.data 字段/类型普查(≤400行)`)
    console.log('  ' + JSON.stringify(Object.fromEntries([...k].sort((a, b) => b[1] - a[1]).slice(0, 30))))
  }
  // part 里是否有 per-part cost/tokens？
  try { const c = db2.prepare(`SELECT COUNT(*) n FROM part`).get().n; console.log(`\n  part 行数=${c}`) } catch {}
  db2.close()
}
