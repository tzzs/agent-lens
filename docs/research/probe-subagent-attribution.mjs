#!/usr/bin/env node
/**
 * M1 ⑤ — accuracy of the Claude Code subagent *parent-attribution* heuristic.
 *
 * WHAT IS MEASURED
 *   §4.4 row 8 claims the logs carry `agentId` on sidechain records but no
 *   `agentId -> tool_use.id` foreign key, so `adapters/claude-code/src/state.ts`
 *   `linkSidechain()` falls back to "most recent preceding Agent/Task call in the
 *   same session". This probe (1) finds whatever independent evidence the real logs
 *   do carry, (2) runs the *adapter's own code* over real files to see what the
 *   heuristic actually returns, and (3) scores it against that evidence.
 *
 * THE HEURISTIC IS NOT REIMPLEMENTED. `discover`, `parse` and `normalize` are
 * imported from `adapters/claude-code/src/*.ts` and executed; every
 * `parent_event_id` reported here comes out of `ScanState.linkSidechain()`. The
 * only local logic is *evidence* gathering (foreign keys, time windows), which has
 * to stay independent of the rule under test. `--verbose` prints the per-sidechain
 * rows; an inferred parent that cannot be traced back to a spawn of the same run
 * shows as `unknown:<hash>` and makes the row unscoreable rather than silently wrong.
 *
 * MODES
 *   A "as deployed": every discovered file is normalized as its own source, exactly
 *     like the collector does. This is what the product would write today.
 *   B "counterfactual inline": each session file plus its sidechain files replayed
 *     as ONE stream ordered by the records' own timestamps — the legacy inline shape
 *     §2.3 measured, and the best case the rule was designed for. No FK is used to
 *     position records, so parallel-spawn ambiguity survives into the measurement.
 *
 * SAFETY (read-only evidence outside the repo)
 *   - Opens `*.jsonl` and `*.meta.json` for reading only; never writes, moves,
 *     renames, chmods or deletes anything under $HOME.
 *   - Never opens `*.db` / `*.sqlite` (a WAL-mode sidecar was created once before;
 *     that is why this probe is JSONL-only). `@agentlens/collector` statically
 *     imports `node:sqlite` through its barrel, so node prints an ExperimentalWarning;
 *     no connection is ever created here.
 *   - If a directory cannot be read, that is reported as `blocked`, separately from
 *     `absent`.
 *
 * PRIVACY: stdout carries counts, booleans, timestamps-derived bucket widths and
 *   SHA-256-truncated identifiers. No message content, prompts, tool inputs,
 *   transcripts, or home-directory paths are ever printed.
 *
 * RUN:  node docs/research/probe-subagent-attribution.mjs [--limit=N] [--verbose]
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'

const SRC = new URL('../../adapters/claude-code/src/', import.meta.url)
const { discover } = await import(new URL('discover.ts', SRC).href)
const { parse } = await import(new URL('parse.ts', SRC).href)
const { normalize } = await import(new URL('normalize.ts', SRC).href)
const { forgetState } = await import(new URL('state.ts', SRC).href)

const ROOT = join(homedir(), '.claude', 'projects')
const LIMIT = Number(/--limit=(\d+)/.exec(process.argv.join(' '))?.[1] ?? 0) || Infinity
const VERBOSE = process.argv.includes('--verbose')

const hid = (value, n = 8) =>
  value === null || value === undefined ? 'null' : createHash('sha256').update(String(value)).digest('hex').slice(0, n)
/** File identity: relative to the probed root, then hashed. Nothing else is printed. */
const fid = (path) => hid(relative(ROOT, path).split(sep).join('/'), 10)
const AGENT_ENTRY_TOOLS = new Set(['Agent', 'Task'])
const ms = (iso) => {
  const v = typeof iso === 'string' ? Date.parse(iso) : typeof iso === 'number' ? iso : NaN
  return Number.isNaN(v) ? null : v
}
const contentBlocks = (rec) => {
  const c = rec?.message?.content
  if (Array.isArray(c)) return c.filter((b) => b && typeof b === 'object')
  return []
}

// ── 0. read-only fs plumbing ────────────────────────────────────────────────

const blocked = []
async function listDir(dir) {
  try {
    return { entries: await readdir(dir) }
  } catch (err) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') blocked.push(dir)
    return { entries: null, code: err?.code ?? 'error' }
  }
}
async function readText(path) {
  try {
    return { text: await readFile(path, 'utf8') }
  } catch (err) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') blocked.push(path)
    return { text: null, code: err?.code ?? 'error' }
  }
}

const hostCtx = {
  dataRoot: join(homedir(), '.claude'),
  homedir: homedir(),
  env: {},
  async readFile(p) {
    const r = await readText(p)
    if (r.text === null) throw new Error(`unreadable ${r.code}`)
    return r.text
  },
  async readDir(p) {
    const d = await listDir(p)
    if (d.entries === null) throw new Error(`unreadable ${d.code}`)
    return d.entries
  },
  async stat(p) {
    try {
      const s = await stat(p)
      return { size: s.size, mtimeMs: s.mtimeMs, inode: s.ino }
    } catch {
      return null
    }
  },
}

// ── 1. discover sources with the adapter's real discover() ──────────────────

const rootStat = await hostCtx.stat(ROOT)
if (rootStat === null) {
  const d = await listDir(dirname(ROOT))
  console.log(
    d.entries === null
      ? `BLOCKED: ${basename(dirname(ROOT))} unreadable (${d.code}) — cannot measure`
      : 'ABSENT: ~/.claude/projects does not exist on this host — nothing to measure',
  )
  process.exit(0)
}

const discovered = []
for await (const source of discover(hostCtx)) discovered.push(source)
/**
 * `discover()` is a bounded recursive walk of *.jsonl, so it returns BOTH the
 * session files and, on this machine, the per-subagent files under
 * `<project>/<session>/subagents/agent-<agentId>.jsonl`. Splitting them is the
 * first finding; the history index is out of scope here.
 */
const sessionFiles = discovered.filter((s) => !s.path.endsWith('history.jsonl') && !/\/subagents\/[^/]+\.jsonl$/.test(s.path))
const sidechainFiles = discovered.filter((s) => /\/subagents\/[^/]+\.jsonl$/.test(s.path))

// ── 2. structural evidence pass (ids, types, timestamps, flags only) ────────

/** @type {Map<string, {seq:number,offset:number,rec:object}>} per parsed record */
async function readRecords(source) {
  const ctx = {
    source,
    agentId: 'claude-code',
    hostId: 'probe',
    sessionHint: source.sessionHint ?? null,
  }
  const out = []
  for await (const record of parse(source, { offset: 0, firstSeq: 1 }, ctx)) out.push(record)
  return out
}

/** parent session file -> its structural facts */
const sessions = new Map()
for (const source of sessionFiles) {
  const records = await readRecords(source)
  const s = {
    source,
    records,
    /** tool_use.id -> spawn call, in file order */
    agentCalls: new Map(),
    /** agentId -> Set<tool_use.id>, the inline foreign keys */
    inlineFk: new Map(),
    /** tool_use.id -> closing tool_result ts */
    closedAt: new Map(),
    /** agentIds of sidechain records inlined *inside* this file (legacy §2.3 shape) */
    inlinedSidechain: new Set(),
    subagentHookRecords: 0,
    subagentHookWithToolUseId: 0,
    nativeSessionId: null,
    spawnBackground: 0,
    parseErrors: 0,
  }
  sessions.set(source.path, s)
  for (const record of records) {
    const rec = record.value
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      s.parseErrors++
      continue
    }
    if (typeof rec.sessionId === 'string') s.nativeSessionId = rec.sessionId
    if (rec.isSidechain === true && typeof rec.agentId === 'string') s.inlinedSidechain.add(rec.agentId)
    if (rec.type === 'assistant') {
      for (const block of contentBlocks(rec)) {
        if (block.type === 'tool_use' && AGENT_ENTRY_TOOLS.has(block.name)) {
          const id = typeof block.id === 'string' ? block.id : null
          if (!id) continue
          const input = block.input && typeof block.input === 'object' ? block.input : {}
          s.agentCalls.set(id, {
            toolUseId: id,
            name: block.name,
            ts: ms(rec.timestamp) ?? record.occurredAt,
            seq: record.seq,
            background: input.run_in_background === true,
          })
          if (input.run_in_background === true) s.spawnBackground++
        }
      }
    }
    if (rec.type === 'user') {
      const toolResultIds = contentBlocks(rec)
        .filter((b) => b.type === 'tool_result')
        .map((b) => (typeof b.tool_use_id === 'string' ? b.tool_use_id : typeof b.toolUseID === 'string' ? b.toolUseID : null))
        .filter((v) => v !== null)
      const tur = rec.toolUseResult
      const agentId = tur && typeof tur === 'object' ? tur.agentId ?? tur.agent_id : null
      for (const id of toolResultIds) {
        if (s.agentCalls.has(id) && !s.closedAt.has(id)) s.closedAt.set(id, ms(rec.timestamp) ?? record.occurredAt)
      }
      // THE CANDIDATE FOREIGN KEY: the spawn's tool_result carries both sides.
      if (typeof agentId === 'string') {
        for (const id of toolResultIds) {
          if (!s.agentCalls.has(id)) continue
          if (!s.inlineFk.has(agentId)) s.inlineFk.set(agentId, new Set())
          s.inlineFk.get(agentId).add(id)
        }
      }
    }
    const att = rec.attachment
    if (att && typeof att === 'object' && typeof att.hookName === 'string' && /Subagent/i.test(att.hookName)) {
      s.subagentHookRecords++
      if (typeof att.toolUseID === 'string') s.subagentHookWithToolUseId++
    }
  }
}

/** sidechain file -> structural facts */
const sidechains = []
for (const source of sidechainFiles) {
  const agentId = /agent-(.+)\.jsonl$/.exec(basename(source.path))?.[1] ?? null
  const records = await readRecords(source)
  const stamps = records.map((r) => ms(r.value?.timestamp) ?? r.occurredAt).filter((v) => v !== null).sort((a, b) => a - b)
  const sessionIds = new Set(records.map((r) => (typeof r.value?.sessionId === 'string' ? r.value.sessionId : null)).filter((v) => v !== null))
  // `<proj>/<session>/subagents/agent-<id>.jsonl` -> `<proj>/<session>.jsonl`
  const subagentsDir = dirname(source.path)
  const sessionDir = dirname(subagentsDir)
  const parentFile = join(dirname(sessionDir), `${basename(sessionDir)}.jsonl`)
  // sidecar meta.json: the file name is the agentId, the payload may carry toolUseId
  const meta = await readText(join(subagentsDir, `agent-${agentId}.meta.json`))
  let metaToolUseId = null
  let metaAgentType = null
  let metaPresent = false
  if (meta.text !== null) {
    metaPresent = true // present but unparseable is still evidence a sidecar exists
    try {
      const j = JSON.parse(meta.text)
      metaToolUseId = typeof j?.toolUseId === 'string' ? j.toolUseId : null
      metaAgentType = typeof j?.agentType === 'string' ? j.agentType : null
    } catch {
      /* ignore */
    }
  }
  sidechains.push({
    source,
    agentId,
    records,
    recordCount: records.length,
    sidechainFlagged: records.filter((r) => r.value?.isSidechain === true).length,
    withAgentIdField: records.filter((r) => typeof r.value?.agentId === 'string').length,
    sessionIds: [...sessionIds],
    firstTs: stamps[0] ?? null,
    lastTs: stamps[stamps.length - 1] ?? null,
    owningSession: sessions.get(parentFile) ?? null,
    parentFileFound: sessions.has(parentFile),
    metaPresent,
    metaToolUseId,
    metaAgentType,
  })
}

/** legacy shape (§2.3): sidechain records inlined inside the session file itself */
const inlinedSidechainAgentIds = new Set([...sessions.values()].flatMap((s) => [...s.inlinedSidechain]))

// ── 3. Mode A — run the real adapter exactly as the collector would ─────────

/**
 * Per-run `tool_use_id -> event id` maps. A run's parent link can only be
 * resolved against the ids that *that* run derived (`deriveEventId` mixes in
 * sourceId + rawSeq), so nothing is compared across runs by event id: each row
 * carries the inferred parent's `tool_use_id`, which is run-independent.
 */
async function runAdapter(source, records) {
  forgetState(source.id)
  const ctx = {
    source,
    agentId: 'claude-code',
    hostId: 'probe',
    sessionHint: source.sessionHint ?? null,
    // project identity has no bearing on parent linkage; keep it deterministic.
    resolveProject: (cwd) => (typeof cwd === 'string' && cwd ? hid(cwd, 6) : null),
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
  }
  const spawnByEventId = new Map()
  const starts = []
  const ends = []
  for (const record of records) {
    const result = await normalize(record, ctx)
    for (const e of result.events ?? []) {
      if (e.type === 'tool.start' && e.capability?.type === 'subagent') {
        const tuid = typeof e.metadata?.tool_use_id === 'string' ? e.metadata.tool_use_id : null
        if (tuid) spawnByEventId.set(e.id, tuid)
      } else if (e.type === 'subagent.start') {
        starts.push(e)
      } else if (e.type === 'subagent.end') {
        ends.push(e)
      }
    }
  }
  forgetState(source.id)
  const resolve = (e) =>
    e === null || e === undefined
      ? null
      : {
          agentId: typeof e.metadata?.agent_id === 'string' ? e.metadata.agent_id : null,
          matched: e.metadata?.parent_matched === true || e.parentEventId !== null,
          parentToolUseId: e.parentEventId === null ? null : spawnByEventId.get(e.parentEventId) ?? `unknown:${hid(e.parentEventId, 6)}`,
        }
  return { starts: starts.map(resolve), ends: ends.map(resolve) }
}

const modeAStart = new Map()
const modeAEnd = new Map()
for (const source of discovered) {
  if (source.path.endsWith('history.jsonl')) continue
  const isSidechainFile = /\/subagents\/[^/]+\.jsonl$/.test(source.path)
  const s = isSidechainFile ? null : sessions.get(source.path)
  const { starts, ends } = await runAdapter(source, s ? s.records : await readRecords(source))
  // `subagent.end` is emitted where the closing tool_result is, i.e. the parent file;
  // its own record already holds the FK, so it is scored separately.
  for (const e of ends) if (e.agentId && !modeAEnd.has(e.agentId)) modeAEnd.set(e.agentId, e)
  if (!isSidechainFile) continue
  for (const e of starts) if (e.agentId && !modeAStart.has(e.agentId)) modeAStart.set(e.agentId, e)
}

// ── 4. Mode B — counterfactual: one merged stream per parent session ────────
// The heuristic can only be right where it can see the spawn calls at all. In the
// current on-disk format sidechains are separate sources (separate ScanState), so
// Mode B replays each session file plus its sidechain files as ONE stream,
// ordered by the records' own timestamps: the legacy inline shape §2.3 measured,
// and the best case the rule was designed for. No FK is used to position records.
const modeB = new Map()
{
  const byParent = new Map()
  for (const sc of sidechains) {
    if (!sc.owningSession) continue
    if (!byParent.has(sc.owningSession.source.path)) byParent.set(sc.owningSession.source.path, [])
    byParent.get(sc.owningSession.source.path).push(sc)
  }
  let n = 0
  for (const [path, scs] of byParent) {
    if (n++ >= LIMIT) break
    const session = sessions.get(path)
    const merged = [...session.records, ...scs.flatMap((sc) => sc.records)]
      .map((r, i) => ({ r, ts: ms(r.value?.timestamp) ?? r.occurredAt ?? 0, i }))
      .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.r.seq - b.r.seq)
    const source = {
      id: `probe-merged-${fid(path)}`,
      path: join(tmpdir(), `probe-merged-${fid(path)}`),
      kind: 'jsonl',
      sessionHint: session.source.sessionHint,
    }
    let seq = 0
    const records = merged.map((m) => ({ ...m.r, seq: ++seq, offset: seq }))
    const { starts } = await runAdapter(source, records)
    for (const e of starts) if (e.agentId && !modeB.has(e.agentId)) modeB.set(e.agentId, e)
  }
}

// ── 5. score the heuristic against independent evidence ──────────────────────

const rows = []
for (const sc of sidechains) {
  const session = sc.owningSession
  const fkIds = new Set()
  if (sc.metaToolUseId) fkIds.add(sc.metaToolUseId)
  if (session && sc.agentId) for (const id of session.inlineFk.get(sc.agentId) ?? []) fkIds.add(id)
  const fkToolUseIds = [...fkIds].filter((id) => session?.agentCalls.has(id))
  const truth = fkToolUseIds.length === 1 ? fkToolUseIds[0] : null

  // Independent, FK-blind time evidence: does the chain start inside a call's window?
  let windowsContaining = 0
  let uniqueWindowParent = null
  let latestPreceding = null
  let precedingCalls = 0
  if (session && sc.firstTs !== null) {
    for (const call of session.agentCalls.values()) {
      if (call.ts < sc.firstTs) {
        precedingCalls++
        if (!latestPreceding || call.ts > latestPreceding.ts) latestPreceding = call
      }
      const end = session.closedAt.get(call.toolUseId)
      if (end === undefined || end === null) continue
      if (call.ts <= sc.firstTs && sc.firstTs <= end) {
        windowsContaining++
        uniqueWindowParent = call
      }
    }
  }

  const score = (r) =>
    r === undefined
      ? undefined
      : {
          matched: r.matched,
          parent: r.parentToolUseId && hid(r.parentToolUseId, 6),
          correct: truth ? r.parentToolUseId === truth : null,
        }
  rows.push({
    file: fid(sc.source.path),
    agentId: hid(sc.agentId),
    records: sc.recordCount,
    sidechainFlagged: sc.sidechainFlagged,
    agentIdField: sc.withAgentIdField,
    parentFileFound: sc.parentFileFound,
    sameSession: session ? sc.sessionIds.length === 1 && sc.sessionIds[0] === session.nativeSessionId : null,
    agentTypeFromMeta: sc.metaAgentType,
    metaHasFk: sc.metaToolUseId !== null,
    inlineFkCount: session && sc.agentId ? (session.inlineFk.get(sc.agentId)?.size ?? 0) : 0,
    fkCount: fkToolUseIds.length,
    truth: truth ? hid(truth, 6) : null,
    modeA: score(modeAStart.get(sc.agentId)),
    endA: score(modeAEnd.get(sc.agentId)),
    modeB: score(modeB.get(sc.agentId)),
    windowClass: !session || sc.firstTs === null ? 'no-parent-file' : precedingCalls === 0 ? 'c-none-preceding' : windowsContaining === 0 ? 'd-preceding-but-no-window' : windowsContaining === 1 ? 'a-unique-window' : 'b-overlapping-windows',
    windowsContaining,
    precedingCalls,
    windowAgreesWithFk: windowsContaining === 1 && truth ? uniqueWindowParent.toolUseId === truth : null,
    latestPrecedingAgreesWithFk: latestPreceding && truth ? latestPreceding.toolUseId === truth : null,
  })
}

// ── 6. report ───────────────────────────────────────────────────────────────

const count = (fn) => rows.reduce((acc, r) => acc + (fn(r) ? 1 : 0), 0)
const totalSpawns = [...sessions.values()].reduce((n, s) => n + s.agentCalls.size, 0)
const totalBackground = [...sessions.values()].reduce((n, s) => n + s.spawnBackground, 0)
const spawnsWithSeveralChains = [...sessions.values()].flatMap((s) => [...s.inlineFk.values()].map((set) => set.size)).filter((n) => n > 1).length
const hookRecords = [...sessions.values()].reduce((n, s) => n + s.subagentHookRecords, 0)
const hookWithTuid = [...sessions.values()].reduce((n, s) => n + s.subagentHookWithToolUseId, 0)
const classes = {}
for (const r of rows) classes[r.windowClass] = (classes[r.windowClass] ?? 0) + 1
/** spawn calls that no sampled chain points at: the reverse coverage gap */
const claimed = new Set(rows.flatMap((r, i) => (sidechains[i]?.metaToolUseId ? [sidechains[i].metaToolUseId] : [])))
for (const sc of sidechains) {
  if (sc.owningSession && sc.agentId) for (const id of sc.owningSession.inlineFk.get(sc.agentId) ?? []) claimed.add(id)
}
const orphanSpawns = [...sessions.values()].flatMap((s) => [...s.agentCalls.values()]).filter((c) => !claimed.has(c.toolUseId))

const scoreLine = (label, sel) => {
  const seen = rows.filter((r) => sel(r) !== undefined)
  const matched = seen.filter((r) => sel(r).matched)
  p(`${label} seen           : ${seen.length}/${rows.length}`)
  p(`  parent matched     : ${matched.length}`)
  p(`  parent NULL        : ${seen.length - matched.length}`)
  p(`  matched AND == FK truth : ${matched.filter((r) => sel(r).correct === true).length}`)
  p(`  matched AND WRONG       : ${matched.filter((r) => sel(r).correct === false).length}   <- a confidently wrong link`)
  p(`  inferred id untraceable : ${matched.filter((r) => String(sel(r).parent).startsWith('unknown:')).length}`)
}

const lines = []
const p = (...args) => lines.push(args.join(' '))
p('# subagent attribution probe — read-only, JSONL only')
p(`probed root              : ~/.claude/projects`)
p(`sources discovered       : ${discovered.length} (adapter discover(), recursive walk)`)
p(`  session files          : ${sessionFiles.length}`)
p(`  sidechain files        : ${sidechainFiles.length}  <project>/<session>/subagents/agent-<agentId>.jsonl`)
const sum = (key) => rows.reduce((n, r) => n + r[key], 0)
p(`  sidechain records      : ${sum('records')} total · isSidechain=${sum('sidechainFlagged')} · agentId field=${sum('agentIdField')} (100% means every record self-identifies its chain)`)
p(`sampled sidechains N     : ${rows.length} (distinct agentIds ${new Set(sidechains.map((s) => s.agentId)).size}) — full population, not a subset`)
p(`Agent/Task spawn calls   : ${totalSpawns} (run_in_background=true: ${totalBackground})`)
p(`  spawns with no chain file: ${orphanSpawns.length} (of which background: ${orphanSpawns.filter((c) => c.background).length}) — a chain may also close without ever splitting out`)
p(`legacy inline sidechains : ${inlinedSidechainAgentIds.size} agentIds inlined inside session files (0 => deployed format is split files)`)
p(`spawn -> >1 chain        : ${spawnsWithSeveralChains} (1:N spawn:agentId would defeat latest-preceding)`)
p(`parse failures           : ${[...sessions.values()].reduce((n, s) => n + s.parseErrors, 0)}`)
p(`blocked reads            : ${blocked.length === 0 ? 'none' : `${blocked.length} (EACCES/EPERM — 'blocked', not 'absent')`}`)
p('')
p('## independent evidence available')
p(`meta.json toolUseId FK   : ${count((r) => r.metaHasFk)}/${rows.length} sidechains (${count((r) => r.parentFileFound)} chains have a parent session file at all)`)
p(`inline spawn-result FK   : ${count((r) => r.inlineFkCount > 0)}/${rows.length} sidechains (user record: tool_result.tool_use_id + toolUseResult.agentId)`)
p(`unique FK-resolvable     : ${count((r) => r.truth !== null)}/${rows.length} — ground truth for the scores below`)
p(`chain keeps parent sessionId: ${count((r) => r.sameSession === true)}/${rows.length} (the rest open a phantom session id)`)
p(`SubagentStart/Stop hooks : ${hookRecords} record(s), ${hookWithTuid} carrying a toolUseID`)
p('')
p('## Mode A — adapter as deployed today (real discover -> real normalize)')
scoreLine('subagent.start', (r) => r.modeA)
scoreLine('subagent.end  ', (r) => r.endA)
p('')
p('## Mode B — merged single stream (legacy inline shape; best case for the rule)')
scoreLine('subagent.start', (r) => r.modeB)
p('')
p('## window-containment classification (time-only, FK-blind)')
p(`  (a) uniquely determined  : ${classes['a-unique-window'] ?? 0}   window==FK truth: ${count((r) => r.windowClass === 'a-unique-window' && r.windowAgreesWithFk === true)}`)
p(`  (b) overlapping windows  : ${classes['b-overlapping-windows'] ?? 0}   latest-preceding==FK truth: ${count((r) => r.windowClass === 'b-overlapping-windows' && r.latestPrecedingAgreesWithFk === true)}`)
p(`  (c) no preceding call    : ${classes['c-none-preceding'] ?? 0}`)
p(`  (d) preceding, no window : ${classes['d-preceding-but-no-window'] ?? 0}`)
p(`  no parent file found     : ${classes['no-parent-file'] ?? 0}`)
p(`  cross-parent overlap rate: ${(classes['b-overlapping-windows'] ?? 0)}/${rows.length}`)
p('')
if (VERBOSE) {
  p('## per-sidechain rows (hashed ids)')
  for (const r of rows) p(JSON.stringify(r))
  p('')
}
p('Note: identifiers are sha256-truncated; no message content, tool inputs or home paths are printed.')
console.log(lines.join('\n'))

