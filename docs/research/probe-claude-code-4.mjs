#!/usr/bin/env node
// ⑧ 用户消息形态(command-name/tool_result) ⑨ hookName 分布 ⑩ cwd/worktree 路径形态与项目归组可行性
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(process.env.HOME, '.claude/projects')
function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.name.endsWith('.jsonl')) yield p
  }
}
const hooks = new Map(), hookEvents = new Map(), hookErr = new Map()
const shapes = new Map()
const cmdNames = new Map()
const cwds = new Map()
const userTypes = new Map()
const promptIdDistinct = new Map()
let turnCompanion = 0, sourceToolUseID = 0

for (const file of walk(ROOT)) {
  const dirName = path.basename(path.dirname(file))
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    let r; try { r = JSON.parse(line) } catch { continue }

    if (r.cwd) {
      const isWorktree = cwds.set(r.cwd, (cwds.get(r.cwd) ?? 0) + 1)
      void isWorktree
    }
    if (r.userType) userTypes.set(r.userType, (userTypes.get(r.userType) ?? 0) + 1)
    if (r.turnCompanion) turnCompanion++
    if (r.sourceToolUseID) sourceToolUseID++
    if (r.promptId) { const s = promptIdDistinct.get(r.sessionId ?? '?') ?? new Set(); s.add(r.promptId); promptIdDistinct.set(r.sessionId ?? '?', s) }

    // ⑧ user content 形态
    if (r.type === 'user') {
      const c = r.message?.content
      if (typeof c === 'string') {
        if (c.includes('<command-name>')) {
          const m = c.match(/<command-name>\s*\[?\s*([^\]<\n]+)/)
          if (m) cmdNames.set(m[1].trim(), (cmdNames.get(m[1].trim()) ?? 0) + 1)
          shapes.set('string:command-name', (shapes.get('string:command-name') ?? 0) + 1)
        } else if (c.includes('<local-command')) shapes.set('string:local-command', (shapes.get('string:local-command') ?? 0) + 1)
        else if (c.startsWith('<')) shapes.set('string:other-xml', (shapes.get('string:other-xml') ?? 0) + 1)
        else shapes.set('string:plain', (shapes.get('string:plain') ?? 0) + 1)
      } else if (Array.isArray(c)) {
        const t = c.map((x) => x?.type).join('+')
        shapes.set(`array:${t}`, (shapes.get(`array:${t}`) ?? 0) + 1)
      }
    }

    // ⑨ hook
    if (r.type === 'attachment' && r.attachment?.type?.startsWith('hook_')) {
      const a = r.attachment
      hooks.set(a.hookName ?? '?', (hooks.get(a.hookName ?? '?') ?? 0) + 1)
      hookEvents.set(a.hookEvent ?? '?', (hookEvents.get(a.hookEvent ?? '?') ?? 0) + 1)
      if (a.exitCode) hookErr.set(`exit=${a.exitCode}`, (hookErr.get(`exit=${a.exitCode}`) ?? 0) + 1)
    }
  }
  // 目录名 -> 路径 反解可行性
  void dirName
}

console.log('## ⑧ user.message.content 形态'); [...shapes].sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${k}: ${v}`))
console.log('\n## ⑧ <command-name> 值 (top20)'); [...cmdNames].sort((a,b)=>b[1]-a[1]).slice(0,20).forEach(([k,v])=>console.log(`  /${k}: ${v}`))
console.log(`\n  turnCompanion 字段记录=${turnCompanion}  sourceToolUseID 字段记录=${sourceToolUseID}`)
console.log(`  userType: ${JSON.stringify(Object.fromEntries(userTypes))}`)
const turns = [...promptIdDistinct.values()].reduce((s, x) => s + x.size, 0)
console.log(`  distinct promptId 合计(≈用户轮次)=${turns}`)

console.log('\n## ⑨ hookName (top15)'); [...hooks].sort((a,b)=>b[1]-a[1]).slice(0,15).forEach(([k,v])=>console.log(`  ${k}: ${v}`))
console.log('## ⑨ hookEvent'); [...hookEvents].sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${k}: ${v}`))
console.log(`## ⑨ 非零 exitCode: ${JSON.stringify(Object.fromEntries(hookErr))}`)

console.log('\n## ⑩ distinct cwd (前25，含计数)')
;[...cwds].sort((a,b)=>b[1]-a[1]).slice(0,25).forEach(([k,v])=>console.log(`  ${String(v).padStart(5)}  ${k}`))
const wt = [...cwds.keys()].filter((c) => c.includes('/.claude/worktrees/'))
const main = [...cwds.keys()].filter((c) => !c.includes('/.claude/worktrees/'))
console.log(`\n  cwd 总数=${cwds.size} ; worktree 内 cwd=${wt.length} ; 非 worktree=${main.length}`)
wt.slice(0, 6).forEach((c) => console.log(`    wt: ${c}  → 主仓库候选 ${c.split('/.claude/worktrees/')[0]}`))
