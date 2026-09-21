#!/usr/bin/env node
/**
 * M1 ⑤ — parent-link accuracy of the Claude Code subagent heuristic, scored against
 * a CONTENT ground truth that is independent of ids and of the rule itself.
 *
 * THE RULE UNDER TEST (as implemented, git SHA printed in the output):
 *   adapters/claude-code/src/state.ts :: ScanState.linkSidechain() —
 *   among `Agent`/`Task` tool_use calls registered for the same sessionId, take the
 *   one with the greatest rawSeq satisfying rawSeq <= chain-start && timestamp <=
 *   chain-start; no candidate -> parent_event_id = NULL. Registered by
 *   normalize.ts :: noteAgentEntry (SUBAGENT_ENTRY_TOOLS = {Agent, Task}).
 *   The probe does NOT reimplement it: it runs the adapter's real
 *   discover/parse/normalize and reads `subagent.start.parent_event_id` back out,
 *   resolving the event id to its `tool_use.id` within the same run.
 *
 * THE GROUND TRUTH (independent of the heuristic and of the FK):
 *   a spawned agent's first user-role record in its sidechain file IS the prompt
 *   handed to it by the parent `Agent` tool_use. For every sampled chain we score
 *   each preceding same-session `Agent` call's input (prompt, fallback description)
 *   against that opening text with a language-agnostic normalised character-bigram
 *   containment + common-prefix ratio, and take the best. Accuracy = heuristic pick
 *   == content pick. Ambiguity (two candidates within a small margin), "no
 *   candidate" and "heuristic NULL" are counted and reported separately.
 *
 *   As a cross-check the probe also recovers the structural foreign key measured in
 *   the companion report (the spawn's own `tool_result` record carries
 *   `tool_use_id` + `toolUseResult.agentId`) and reports three-way agreement
 *   FK × content × heuristic. Content never sees the FK, so agreement is genuine
 *   corroboration, not circularity.
 *
 * SAMPLING: deterministic stride over sidechain files sorted by path, `--sample=N`
 *   (default 20; the whole population if smaller — the population count is printed).
 *
 * LOG ROOT: env AGL_PROBE_CLAUDE_DIR points at a Claude config dir whose `projects/`
 *   subdir holds the JSONL (default `~/.claude`). This lets the probe run against
 *   de-identified fixture trees too.
 *
 * SAFETY (non-negotiable, same discipline as probe-subagent-attribution.mjs):
 *   - Opens `*.jsonl` and `*.meta.json` for READING only; never writes, moves,
 *     renames, chmods or deletes anything under the log root; never touches
 *     `-wal`/`-shm` sidecars; never opens `*.db`/`*.sqlite` (JSONL-only probe; node
 *     may print an ExperimentalWarning because the adapter barrel statically
 *     imports node:sqlite — no connection is ever created here).
 *   - If a directory read is refused it is reported as `blocked`, not `absent`.
 * PRIVACY: stdout carries only counts, lengths, scores and sha256-truncated
 *   identifiers. Prompt text is read into memory for scoring and NEVER printed,
 *   stored on any printed row, or hashed in a recoverable way.
 *
 * RUN:  node docs/research/probe-subagent-parents.mjs [--sample=20] [--verbose]
 *       AGL_PROBE_CLAUDE_DIR=/path/to/fixture-config node docs/research/probe-subagent-parents.mjs
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'

const SRC = new URL('../../adapters/claude-code/src/', import.meta.url)
const { discover } = await import(new URL('discover.ts', SRC).href)
const { parse } = await import(new URL('parse.ts', SRC).href)
const { normalize } = await import(new URL('normalize.ts', SRC).href)
const { forgetState } = await import(new URL('state.ts', SRC).href)

const ROOT = process.env.AGL_PROBE_CLAUDE_DIR || join(homedir(), '.claude')
const PROJECTS = join(ROOT, 'projects')
const argv = process.argv.join(' ')
const SAMPLE = Number(/--sample=(\d+)/.exec(argv)?.[1] ?? 0) || 20
const VERBOSE = process.argv.includes('--verbose')
const AGENT_ENTRY_TOOLS = new Set(['Agent', 'Task'])
/** content-match tuning (see score() ) */
const FLOOR = 0.3 // below this the best candidate is "no content signal"
const TIE = 0.05 // best - second smaller than this => ambiguous

let headSha = 'unknown'
try {
  headSha = execFileSync('git', ['-C', dirname(new URL(import.meta.url).pathname), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
} catch {
  /* read-only convenience; the report prints `unknown` instead */
}

const hid = (value, n = 8) =>
  value === null || value === undefined ? 'null' : createHash('sha256').update(String(value)).digest('hex').slice(0, n)
const fid = (path) => hid(relative(PROJECTS, path).split(sep).join('/'), 10)
const ms = (iso) => {
  const v = typeof iso === 'string' ? Date.parse(iso) : typeof iso === 'number' ? iso : NaN
  return Number.isNaN(v) ? null : v
}
const contentBlocks = (rec) => {
  const c = rec?.message?.content
  if (Array.isArray(c)) return c.filter((b) => b && typeof b === 'object')
  return []
}

// ── content ground-truth scorer (language agnostic, zero deps) ──────────────
// Normalise: lowercase, keep alphanumerics (incl. CJK), drop everything else.
const normalize_ = (s) => String(s).normalize('NFKD').toLowerCase().replace(/[^0-9a-z\u3400-\u9fff]+/g, '')
/** multiset of character bigrams — robust for spaceless (CJK) and spaceful text alike */
const bigrams = (s) => {
  const m = new Map()
  for (let i = 0; i + 1 < s.length; i++) {
    const g = s.slice(i, i + 2)
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return m
}
/**
 * score(openingText, candidatePrompt) ∈ [0,1]:
 *   multiset-bigram containment over min(size)  ∪  common-prefix ratio over min(len).
 * An exact replay of the prompt scores 1.0; unrelated text scores ≈ 0.
 */
function score(opening, candidate) {
  const a = normalize_(opening)
  const b = normalize_(candidate)
  if (!a || !b) return 0
  const ba = bigrams(a)
  const bb = bigrams(b)
  let inter = 0
  let sizeB = 0
  for (const [g, n] of bb) {
    sizeB += n
    inter += Math.min(n, ba.get(g) ?? 0)
  }
  let sizeA = 0
  for (const n of ba.values()) sizeA += n
  const containment = inter / Math.min(sizeA, sizeB)
  let lcp = 0
  while (lcp < a.length && lcp < b.length && a[lcp] === b[lcp]) lcp++
  const prefix = lcp / Math.min(a.length, b.length)
  return Math.max(containment, prefix)
}
/** first user-role record that carries plain text: the prompt handed to the agent */
function openingText(records) {
  for (const { value: rec } of records) {
    if (rec?.type !== 'user') continue
    const c = rec.message?.content
    if (typeof c === 'string' && c.trim()) return c
    if (Array.isArray(c)) {
      const t = c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
      if (t.trim()) return t
    }
  }
  return null
}

// ── read-only fs plumbing (shared shape with probe-subagent-attribution.mjs) ─

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
  dataRoot: ROOT,
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

// ── 1. discover + structural pass (reuses the earlier probe's log walk) ─────

try {
  await stat(PROJECTS)
} catch {
  console.log(`ABSENT: ${PROJECTS} does not exist — nothing to measure (set AGL_PROBE_CLAUDE_DIR to a config dir with projects/)`)
  process.exit(0)
}

const discovered = []
for await (const source of discover(hostCtx)) discovered.push(source)
const sessionFiles = discovered.filter((s) => !s.path.endsWith('history.jsonl') && !/\/subagents\/[^/]+\.jsonl$/.test(s.path))
const sidechainFiles = discovered.filter((s) => /\/subagents\/[^/]+\.jsonl$/.test(s.path))

async function readRecords(source) {
  const ctx = { source, agentId: 'claude-code', hostId: 'probe', sessionHint: source.sessionHint ?? null }
  const out = []
  for await (const record of parse(source, { offset: 0, firstSeq: 1 }, ctx)) out.push(record)
  return out
}

/** every `Agent`/`Task` tool_use seen anywhere in a session (parent file or sibling chain) */
function collectCalls(records, into) {
  for (const record of records) {
    const rec = record.value
    if (!rec || typeof rec !== 'object') continue
    if (rec.type !== 'assistant') continue
    for (const block of contentBlocks(rec)) {
      if (block.type !== 'tool_use' || !AGENT_ENTRY_TOOLS.has(block.name)) continue
      const id = typeof block.id === 'string' ? block.id : null
      if (!id || into.has(id)) continue
      const input = block.input && typeof block.input === 'object' ? block.input : {}
      into.set(id, {
        toolUseId: id,
        name: block.name,
        ts: ms(rec.timestamp) ?? record.occurredAt,
        // prompt/description kept in memory ONLY for scoring; never printed.
        prompt: typeof input.prompt === 'string' ? input.prompt : null,
        description: typeof input.description === 'string' ? input.description : null,
        subagentType: typeof input.subagent_type === 'string' ? input.subagent_type : null,
      })
    }
  }
}

/** inline FK inside one parent file: agentId -> Set(tool_use.id) proven by its own tool_result */
function collectFk(records, calls, into) {
  for (const record of records) {
    const rec = record.value
    if (!rec || rec.type !== 'user') continue
    const tur = rec.toolUseResult
    const agentId = tur && typeof tur === 'object' ? tur.agentId ?? tur.agent_id : null
    if (typeof agentId !== 'string') continue
    for (const b of contentBlocks(rec)) {
      if (b.type !== 'tool_result') continue
      const tuid = typeof b.tool_use_id === 'string' ? b.tool_use_id : null
      if (tuid && calls.has(tuid)) {
        if (!into.has(agentId)) into.set(agentId, new Set())
        into.get(agentId).add(tuid)
      }
    }
  }
}

/** parent session file -> {records, calls(Map), fk(Map), nativeSessionId} */
const sessions = new Map()
for (const source of sessionFiles) {
  const records = await readRecords(source)
  const calls = new Map()
  collectCalls(records, calls)
  const fk = new Map()
  collectFk(records, calls, fk)
  const nativeSessionId = records.find((r) => typeof r.value?.sessionId === 'string')?.value?.sessionId ?? null
  sessions.set(source.path, { source, records, calls, fk, nativeSessionId })
}

const sidechains = []
for (const source of sidechainFiles) {
  const agentId = /agent-(.+)\.jsonl$/.exec(basename(source.path))?.[1] ?? null
  const records = await readRecords(source)
  const stamps = records.map((r) => ms(r.value?.timestamp) ?? r.occurredAt).filter((v) => v !== null).sort((a, b) => a - b)
  const subagentsDir = dirname(source.path)
  const sessionDir = dirname(subagentsDir)
  const parentFile = join(dirname(sessionDir), `${basename(sessionDir)}.jsonl`)
  const meta = await readText(join(subagentsDir, `agent-${agentId}.meta.json`))
  let metaToolUseId = null
  if (meta.text !== null) {
    try {
      metaToolUseId = typeof JSON.parse(meta.text)?.toolUseId === 'string' ? JSON.parse(meta.text).toolUseId : null
    } catch {
      /* sidecar exists but is unparseable */
    }
  }
  sidechains.push({
    source,
    agentId,
    records,
    recordCount: records.length,
    firstTs: stamps[0] ?? null,
    open: openingText(records),
    owningSession: sessions.get(parentFile) ?? null,
    metaToolUseId,
  })
}
// sibling spawns must be visible to each chain's candidate set: second pass, parent-level merge
for (const sc of sidechains) {
  if (!sc.owningSession) continue
  for (const [id, call] of collectInto(sc)) if (!sc.owningSession.calls.has(id)) sc.owningSession.calls.set(id, call)
}
function collectInto(sc) {
  const tmp = new Map()
  collectCalls(sc.records, tmp)
  return tmp
}

// ── 2. deterministic stride sample of `SAMPLE` chains ───────────────────────

const sorted = [...sidechains].sort((a, b) => a.source.path < b.source.path ? -1 : 1)
const sampled =
  sorted.length <= SAMPLE
    ? sorted
    : Array.from({ length: SAMPLE }, (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (SAMPLE - 1))]).filter(
        (v, i, arr) => arr.indexOf(v) === i,
      )

// ── 3. run the REAL adapter code (deployed shape + merged inline stream) ────

async function runAdapter(source, records) {
  forgetState(source.id)
  const ctx = {
    source,
    agentId: 'claude-code',
    hostId: 'probe',
    sessionHint: source.sessionHint ?? null,
    resolveProject: (cwd) => (typeof cwd === 'string' && cwd ? hid(cwd, 6) : null),
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
  }
  const spawnByEventId = new Map()
  const starts = []
  for (const record of records) {
    const result = await normalize(record, ctx)
    for (const e of result.events ?? []) {
      if (e.type === 'tool.start' && e.capability?.type === 'subagent') {
        const tuid = typeof e.metadata?.tool_use_id === 'string' ? e.metadata.tool_use_id : null
        if (tuid) spawnByEventId.set(e.id, tuid)
      } else if (e.type === 'subagent.start') {
        starts.push(e)
      }
    }
  }
  forgetState(source.id)
  const resolve = (e) => ({
    agentId: typeof e.metadata?.agent_id === 'string' ? e.metadata.agent_id : null,
    matched: e.parentEventId !== null,
    parentToolUseId:
      e.parentEventId === null ? null : spawnByEventId.get(e.parentEventId) ?? `unknown:${hid(e.parentEventId, 6)}`,
    parentSource: e.metadata?.parent_source ?? null,
  })
  return starts.map(resolve)
}

/** deployed shape: sampled sidechain file alone as its own source */
const heuristicDeployed = new Map()
for (const sc of sampled) {
  const starts = await runAdapter(sc.source, sc.records)
  for (const s of starts) if (s.agentId && !heuristicDeployed.has(s.agentId)) heuristicDeployed.set(s.agentId, s)
}

/** merged inline stream per needed parent session (all sibling chains included) */
const heuristicInline = new Map()
{
  const needed = new Set(sampled.filter((s) => s.owningSession).map((s) => s.owningSession.source.path))
  for (const path of needed) {
    const session = sessions.get(path)
    const siblings = sidechains.filter((sc) => sc.owningSession?.source.path === path)
    const merged = [...session.records, ...siblings.flatMap((sc) => sc.records)]
      .map((r, i) => ({ r, ts: ms(r.value?.timestamp) ?? r.occurredAt ?? 0, i }))
      .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.r.seq - b.r.seq)
    const source = {
      id: `probe-merged-${fid(path)}`,
      path: join(tmpdir(), `probe-merged-${fid(path)}`),
      kind: 'jsonl',
      sessionHint: session.source.sessionHint,
    }
    let seq = 0
    const starts = await runAdapter(source, merged.map((m) => ({ ...m.r, seq: ++seq, offset: seq })))
    for (const s of starts) if (s.agentId && !heuristicInline.has(s.agentId)) heuristicInline.set(s.agentId, s)
  }
}

// ── 4. per-sample content pick + scoring ────────────────────────────────────

const rows = []
for (const sc of sampled) {
  const session = sc.owningSession
  const candidates = session && sc.firstTs !== null ? [...session.calls.values()].filter((c) => c.ts <= sc.firstTs) : []
  let best = null
  let second = 0
  let bestText = null
  for (const c of candidates) {
    const target = c.prompt ?? c.description
    const s = sc.open && target ? score(sc.open, target) : 0
    if (best === null || s > best.s) {
      if (best) second = best.s
      best = { call: c, s }
      bestText = target
    } else if (s > second) second = s
  }
  const content = best === null || best.s < FLOOR ? null : { pick: best.call, top: best.s, second }
  const ambiguous = content !== null && content.second >= content.top - TIE

  // structural FK (cross-check only; never used to build the content pick)
  const fkSet = session && sc.agentId ? session.fk.get(sc.agentId) : null
  const fk = fkSet && fkSet.size === 1 ? [...fkSet][0] : null

  const inline = heuristicInline.get(sc.agentId)
  const deployed = heuristicDeployed.get(sc.agentId)
  const pick = inline?.parentToolUseId ?? null
  const contentId = content && !ambiguous ? content.pick.toolUseId : null

  let cls
  if (!session) cls = 'no-parent-file'
  else if (candidates.length === 0) cls = 'no-candidate'
  else if (deployed?.parentToolUseId && String(deployed.parentToolUseId).startsWith('unknown:')) cls = 'untraceable'
  else if (inline === undefined || (inline.matched === false && candidates.length > 0)) cls = 'heuristic-null-despite-candidates'
  else if (!inline.matched) cls = 'heuristic-null'
  else if (!content) cls = 'no-content-signal'
  else if (ambiguous) cls = 'ambiguous-content'
  else cls = pick === contentId ? 'correct' : 'WRONG'

  rows.push({
    file: fid(sc.source.path),
    agentId: hid(sc.agentId),
    records: sc.recordCount,
    openLen: sc.open?.length ?? 0,
    candidates: candidates.length,
    content: content ? { id: hid(content.pick.toolUseId, 6), top: +content.top.toFixed(3), second: +content.second.toFixed(3), kind: content.pick.prompt ? 'prompt' : 'description' } : null,
    heuristicInline: pick ? hid(pick, 6) : null,
    inlineSource: inline?.parentSource ?? null,
    heuristicDeployed: deployed ? (deployed.matched ? hid(deployed.parentToolUseId, 6) : 'NULL') : 'not-emitted',
    fk: fk ? hid(fk, 6) : fkSet ? `fk-ambiguous(${fkSet.size})` : sc.metaToolUseId ? `meta:${hid(sc.metaToolUseId, 6)}` : null,
    contentEqFk: fk && contentId ? contentId === fk : null,
    heuristicEqFk: fk && pick ? pick === fk : null,
    cls,
  })
}

// ── 5. report ───────────────────────────────────────────────────────────────

const lines = []
const p = (...a) => lines.push(a.join(' '))
const n = (cls) => rows.filter((r) => r.cls === cls).length
p('# probe-subagent-parents — heuristic vs CONTENT ground truth (read-only, JSONL only)')
p(`git HEAD measured against : ${headSha}`)
p(`log root                  : ${process.env.AGL_PROBE_CLAUDE_DIR ? 'AGL_PROBE_CLAUDE_DIR (custom)' : '~/.claude'} · projects: ${sessionFiles.length} session files, ${sidechainFiles.length} sidechain files`)
p(`population                : ${sidechains.length} side chains; sampled ${rows.length} by deterministic stride over path-sorted files${sidechains.length > SAMPLE ? ` (env-var/flag --sample=${SAMPLE})` : ''}`)
p(`blocked reads             : ${blocked.length === 0 ? 'none' : String(blocked.length)}`)
p('')
p('## content ground truth (opening user text vs preceding Agent inputs)')
p(`chains with opening text   : ${rows.filter((r) => r.openLen > 0).length}/${rows.length}`)
p(`exact prompt replay (>=.99): ${rows.filter((r) => r.content && r.content.top >= 0.99).length}/${rows.length}`)
p(`content pick resolved      : ${rows.filter((r) => r.content && !['ambiguous-content'].includes(r.cls)).length}/${rows.length}`)
p(`content x FK agreement     : ${rows.filter((r) => r.contentEqFk === true).length}/${rows.filter((r) => r.contentEqFk !== null).length} (content never reads the FK — agreement is independent corroboration)`)
p(`no-candidate chains        : ${n('no-candidate')} · no-parent-file: ${n('no-parent-file')} · no-content-signal: ${n('no-content-signal')}`)
p(`ambiguous (top-second<${TIE})  : ${n('ambiguous-content')}`)
p('')
p('## heuristic (real linkSidechain via adapter normalize)')
p(`deployed shape  matched    : ${rows.filter((r) => r.heuristicDeployed !== 'NULL' && r.heuristicDeployed !== 'not-emitted').length}/${rows.length} · NULL: ${rows.filter((r) => r.heuristicDeployed === 'NULL').length} (per-source ScanState: sidechains never see the parent spawn)`)
p(`merged inline   matched    : ${rows.filter((r) => r.heuristicInline !== null).length}/${rows.length}`)
p(`merged inline x FK agreement: ${rows.filter((r) => r.heuristicEqFk === true).length}/${rows.filter((r) => r.heuristicEqFk !== null).length}`)
const scorable = rows.filter((r) => ['correct', 'WRONG'].includes(r.cls) || r.cls === 'heuristic-null-despite-candidates')
const correct = n('correct')
p(`ACCURACY (heuristic == unambiguous content pick): ${correct}/${scorable.length || rows.filter((r) => r.content && !["ambiguous-content"].includes(r.cls)).length || 1} scorable = ${((correct / Math.max(1, scorable.length)) * 100).toFixed(1)}%`)
p(`outright wrong picks       : ${n('WRONG')}   <- confident mislink, the dangerous class`)
p(`heuristic NULL w/ candidates: ${n('heuristic-null-despite-candidates')}`)
p(`untraceable event->tuid    : ${n('untraceable')}`)
p('')
p('## per-sample rows (sha256-truncated ids; openLen/cand/scores only, no text)')
p('| # | chain | agentId | recs | openLen | cands | content (id/top/2nd) | heuristic-inline | src | heuristic-deployed | FK | class |')
p('|---|-------|---------|------|---------|-------|--------------------|------------------|-----|--------------------|----|-------|')
rows.forEach((r, i) =>
  p(
    `| ${i + 1} | ${r.file} | ${r.agentId} | ${r.records} | ${r.openLen} | ${r.candidates} | ${r.content ? `${r.content.id}/${r.content.top}/${r.content.second} (${r.content.kind})` : '-'} | ${r.heuristicInline ?? 'NULL'} | ${r.inlineSource ?? '-'} | ${r.heuristicDeployed} | ${r.fk ?? '-'} | ${r.cls} |`,
  ),
)
if (VERBOSE) {
  p('')
  p('## verbose rows (still content-free)')
  for (const r of rows) p(JSON.stringify(r))
}
p('')
p('Privacy: only digests, counts, lengths and scores printed; prompts/tool inputs are never emitted or persisted.')
console.log(lines.join('\n'))
