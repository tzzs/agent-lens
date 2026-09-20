#!/usr/bin/env node
/**
 * Qoder / OpenCode / WorkBuddy 通用实测脚本（§17 第 3、4 项）。
 *   - 判定数据格式：SQLite（.db/.sqlite/.vscdb）还是 JSONL
 *   - 若为 SQLite：尝试用 node:sqlite 以 readOnly 打开，列出表名，探测是否有稳定的 session/uuid 列
 *   - 关键安全校验：打开前后 -wal / -shm 伴随文件是否出现（绝不应被我们的只读打开创建）
 *   - 若打不开：捕获并原样打印错误（那是"读不到"，不是"不存在"）
 *
 * 用法: node docs/research/probe-qoder.mjs [targetDir ...]
 *   省略参数默认 ~/.qoder
 * 只读：只用 node:fs 读 + node:sqlite readOnly 打开；绝不写 / 改权限 / 创建任何文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const ROOTS = (argv.length ? argv : [path.join(os.homedir(), '.qoder')]).map((p) => path.resolve(p))

const DB_EXT = ['.db', '.sqlite', '.sqlite3', '.vscdb']
const accompanying = (p) => [p + '-wal', p + '-shm', p + '-journal']

function walk(d, depth = 0, out = []) {
  if (depth > 6) return out
  let es; try { es = fs.readdirSync(d, { withFileTypes: true }) } catch (e) { out.push({ err: e.code, p: d }); return out }
  for (const e of es) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, depth + 1, out)
    else { let s = null; try { s = fs.statSync(p) } catch {} out.push({ p, size: s ? s.size : null }) }
  }
  return out
}

let DatabaseSync = null
try { ({ DatabaseSync } = require('node:sqlite')) } catch { /* node<22 */ }
if (!DatabaseSync) { try { ({ DatabaseSync } = await import('node:sqlite')) } catch { } }

const clip = (s, n = 120) => (typeof s === 'string' ? s.replace(new RegExp(os.homedir(), 'g'), '~').slice(0, n) : s)

for (const ROOT of ROOTS) {
  console.log(`\n########## ${ROOT.replace(os.homedir(), '~')} ##########`)
  if (!fs.existsSync(ROOT)) { console.log('  不存在（not present）'); continue }
  const entries = walk(ROOT)
  const files = entries.filter((e) => e.p && e.size != null)
  const errs = entries.filter((e) => e.err)
  const dbs = files.filter((f) => DB_EXT.includes(path.extname(f.p).toLowerCase()))
  const jsonls = files.filter((f) => /\.(jsonl|json)$/.test(f.p))
  const walshm = files.filter((f) => /-(wal|shm|journal)$/.test(f.p))
  console.log(`  文件总数=${files.length} 目录读取错误=${errs.length}  SQLite候选=${dbs.length}  JSON(L)=${jsonls.length}  已存在的 wal/shm=${walshm.length}`)
  if (errs.length) { const byCode = {}; for (const e of errs) byCode[e.err] = (byCode[e.err] ?? 0) + 1; console.log('  读取受限目录(权限门):', JSON.stringify(byCode)) }

  console.log('  --- 最大的 12 个文件 ---')
  for (const f of files.sort((a, b) => b.size - a.size).slice(0, 12))
    console.log(`    ${(f.size / 1024).toFixed(0).padStart(8)}K  ${clip(f.p.replace(ROOT, '.'), 90)}`)

  if (dbs.length) {
    console.log(`\n  --- SQLite 只读打开测试（${dbs.length} 个候选）---`)
    for (const f of dbs.sort((a, b) => b.size - a.size).slice(0, 8)) {
      const before = accompanying(f.p).map((a) => fs.existsSync(a))
      let opened = false, tables = [], cols = [], err = null
      try {
        const db = new DatabaseSync(f.p, { open: true, readOnly: true })
        opened = true
        try {
          tables = db.prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`).all().map((r) => `${r.name}(${r.type})`)
          const sessionTables = tables.filter((t) => /session|conversation|thread|chat/i.test(t))
          const probe = sessionTables.length ? sessionTables : tables.slice(0, 3)
          for (const t of probe) {
            const nm = t.split('(')[0]
            try { for (const c of db.prepare(`PRAGMA table_info(${JSON.stringify(nm)})`).all()) if (/session|thread|uuid|id|conversation/i.test(c.name)) cols.push(`${nm}.${c.name}`) } catch { }
          }
        } catch (e) { err = 'query:' + e.message }
        db.close()
      } catch (e) { err = e.code || e.message }
      const after = accompanying(f.p).map((a) => fs.existsSync(a))
      const created = accompanying(f.p).filter((_, i) => !before[i] && after[i])
      console.log(`    ${clip(path.basename(f.p), 40).padEnd(42)} open=${opened ? 'OK(ro)' : 'FAIL'}${err ? ' [' + clip(err, 80) + ']' : ''}  新建wal/shm=${created.length ? '⚠️' + created.map((c) => path.basename(c)).join(',') : '无'}`)
      if (opened && tables.length) console.log(`       tables(${tables.length}): ${tables.slice(0, 15).join(', ')}${tables.length > 15 ? ' +' + (tables.length - 15) + '…' : ''}`)
      if (cols.length) console.log(`       session/uuid 列候选: ${[...new Set(cols)].slice(0, 12).join(', ')}`)
    }
  }
  if (jsonls.length) {
    console.log(`\n  --- JSON(L) 采样（前 6 个较大文件的首记录 key）---`)
    for (const f of jsonls.sort((a, b) => b.size - a.size).slice(0, 6)) {
      try {
        const fd = fs.openSync(f.p, 'r'); const buf = Buffer.alloc(Math.min(4000, f.size)); fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd)
        const firstLine = buf.toString('utf8').split('\n')[0]
        let keys = firstLine
        try { const o = JSON.parse(firstLine); keys = Object.keys(o).join(',') } catch { keys = '(非单行JSON/超大字段)' }
        console.log(`    ${clip(path.basename(f.p), 40).padEnd(42)} ${(f.size / 1024).toFixed(0)}K  keys=${clip(keys, 160)}`)
      } catch (e) { console.log(`    ${path.basename(f.p)} 读取失败 ${e.code || e.message}`) }
    }
  }

  // --- projects/*.jsonl 记录/usage 普查（若存在）---
  const projDir = path.join(ROOT, 'projects')
  if (fs.existsSync(projDir)) {
    const projFiles = walk(projDir).filter((e) => e.p && e.p.endsWith('.jsonl'))
    const recTypes = new Map(), usageKeys = new Map(), topKeys = new Map()
    let recs = 0, filesWithUsage = 0, filesSampled = 0, modelField = new Map()
    const byReqId = new Map()        // usage.request_id -> Set(usage sig)  探测多 block 重复
    const byAnchor = new Map()       // requestTokenAnchor -> count of usage-carrying records
    const fileSessions = new Map()   // file -> Set(sessionId)
    let usageRecs = 0, noReqId = 0
    for (const f of projFiles) {
      if (filesSampled >= 60) break
      filesSampled++
      const sess = new Set(); fileSessions.set(path.basename(f.p), sess)
      let text; try { text = fs.readFileSync(f.p, 'utf8') } catch { continue }
      for (const l of text.split('\n').filter(Boolean)) {
        let r; try { r = JSON.parse(l) } catch { continue }
        recs++
        bump(recTypes, r.type ?? '(none)')
        for (const k of Object.keys(r)) bump(topKeys, k)
        if (r.sessionId) sess.add(r.sessionId)
        const u = r.usage || r.data?.usage || r.message?.usage
        if (u && typeof u === 'object' && (u.input_tokens != null || u.output_tokens != null)) {
          usageRecs++; filesWithUsage++
          for (const k of Object.keys(u)) bump(usageKeys, k)
          const rid = u.request_id || r.requestTokenAnchor
          if (!rid) noReqId++
          const sig = [u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].join(',')
          if (rid) { if (!byReqId.has(rid)) byReqId.set(rid, new Map()); byReqId.get(rid).set(sig, (byReqId.get(rid).get(sig) ?? 0) + 1) }
          if (r.requestTokenAnchor) byAnchor.set(r.requestTokenAnchor, (byAnchor.get(r.requestTokenAnchor) ?? 0) + 1)
        }
        if (r.model || r.message?.model || r.data?.model) bump(modelField, r.model || r.message?.model || r.data?.model)
      }
    }
    let multiSig = 0, multiRec = 0
    for (const [, sigs] of byReqId) { const n = [...sigs.values()].reduce((s, v) => s + v, 0); if (n > 1) multiRec++; if (sigs.size > 1) multiSig++ }
    const anchorDup = [...byAnchor.values()].filter((n) => n > 1).length
    const multiSessFiles = [...fileSessions].filter(([, s]) => s.size > 1).length
    console.log(`\n  --- projects/*.jsonl 普查（采样 ${filesSampled}/${projFiles.length} 文件，${recs} 记录）---`)
    console.log(`    记录 type: ${JSON.stringify(Object.fromEntries([...recTypes].sort((a, b) => b[1] - a[1])))}`)
    console.log(`    顶层 key: ${JSON.stringify(Object.fromEntries([...topKeys].sort((a, b) => b[1] - a[1]).slice(0, 22)))}`)
    console.log(`    带 usage 的记录=${usageRecs}  缺 request_id/anchor=${noReqId}`)
    console.log(`    usage 字段名: ${JSON.stringify(Object.fromEntries([...usageKeys].sort((a, b) => b[1] - a[1])))}`)
    console.log(`    Claude式重复：distinct request_id 组=${byReqId.size}，其中多条记录共享同一 request_id 的=${multiRec}（usage 值不同的组=${multiSig}）；requestTokenAnchor 重复挂多条=${anchorDup}`)
    console.log(`    session 边界：单文件含 >1 sessionId 的文件=${multiSessFiles}（0 则等同 Claude"一文件一 session"）`)
    console.log(`    model: ${JSON.stringify(Object.fromEntries([...modelField].sort((a, b) => b[1] - a[1]).slice(0, 10)))}`)
  }
}

function bump(m, k, n = 1) { m.set(k, (m.get(k) ?? 0) + n) }


