/**
 * §4.4 row 8, closed one layer up from where it was measured.
 *
 * The shape `docs/research/subagent-attribution.md` §2/§7 found: Claude Code writes a side
 * chain's transcript into its OWN file (`<session>/subagents/agent-<agentId>.jsonl`) while the
 * `Agent`/`Task` `tool_use` that started it sits in the parent's file. The adapter's ledger is
 * per source (`stateFor(ctx.source.id)`), so a side-chain source never sees the parent's
 * candidates and `subagent.start.parent_event_id` lands NULL on 20/20 real chains
 * (`docs/research/probe-subagent-parents.mjs` §10.2).
 *
 * Fixing that inside the adapter would need a process-global, session-keyed ledger, and the
 * answer would then depend on which of the two files was scanned first — a watch tick that
 * sees only one of them would produce a different store than a full scan. So the link is
 * resolved HERE, after ingestion, from rows that are already durable:
 *
 *  - the candidate pool is every persisted spawn row of the chain's session, so the result is a
 *    pure function of stored rows, never of arrival or scan order (§4.2);
 *  - proof first: a closing `subagent.end` whose `parent_source` is `foreign-key` names the
 *    spawn's own event id (`tool_use_id` + `toolUseResult.agentId`, measured 36/36);
 *  - heuristic second: the nearest preceding spawn, the rule measured at 17/17 against a content
 *    ground truth. `raw_seq` breaks ties only where it is comparable — two sources of one
 *    session each number their own records from 1, so cross-file it is meaningless and the
 *    timestamp alone decides;
 *  - otherwise NULL stays NULL: §4.4 row 8 permits an unknown parent, and a guess would put the
 *    chain under the wrong spawn, which a gap does not.
 *
 * The write-back is `insertEvents`' §5.3 repair upsert — `parent_event_id` and `metadata` are
 * both repaired columns, so re-deriving the row is the only path taken and this module issues no
 * UPDATE of its own. Convergence falls out of that upsert's NULL-safe `WHERE` guard: the second
 * run derives the same parent, the guard matches, zero rows change. Every apply runs inside one
 * transaction and is checked before it commits — if the rewrite moved any column other than the
 * two intended ones, the transaction rolls back and the row is reported as refused rather than
 * silently re-stated, because "a replay of the same bytes is byte-identical" is the contract a
 * lossy projection would break.
 *
 * Adapters take part by declaring their row vocabulary (`SubagentLinkVocabulary`), so an agent
 * that is not listed is never rewritten. That matters for Codex: its `subagent.start` is
 * parentless BY DESIGN (the spawning `spawn_agent` call lives in another thread file, and
 * `subagentsIncluded: false` keeps those threads out of its cost fold — §18 row 2/3), so linking
 * it from a time heuristic would be a wrong edge with a price tag attached.
 *
 * Two consequences of resolving it here rather than in the mapping:
 *  - no `PARSER_VERSION` bump: this pass repairs rows the CURRENT parser already wrote, so there
 *    is nothing for §5.3's drift rescan to discover. A row the adapter re-derives on a replay
 *    comes back with a NULL parent again, which is why the scan runs must call this after the
 *    last source — and `watch` must call it after every batch, not once at startup;
 *  - `doctor`'s tiers stay honest: the chain row keeps saying `foreign-key` or `heuristic`
 *    because that is how THIS pass justified it, and §8's "print the three separately" still
 *    distinguishes a proved link from a guessed one from a gap.
 */
import type { DatabaseSync } from 'node:sqlite'
import { inflateSync } from 'node:zlib'
import { Buffer } from 'node:buffer'
import type {
  AgentEvent,
  CapabilityRef,
  CapabilityType,
  CostSource,
  EventStatus,
  EventType,
  ModelRef,
  PayloadDraft,
  Usage,
  UsageSource,
} from '@agentlens/event-model'
import { insertEvents, withTransaction } from './write.ts'

/** The row-level metadata names one adapter's mapping uses for the same three facts. */
export interface SubagentLinkVocabulary {
  /** `agents.id` this vocabulary belongs to. */
  agentId: string
  /** metadata key naming the side chain on its `subagent.start` / closing `subagent.end`. */
  chainKey: string
  /** metadata key on the spawn `tool.start` holding the raw `tool_use.id`. */
  spawnToolUseKey: string
  /** metadata key on the closing row stating how that row was linked. */
  parentSourceKey: string
  /** value of `parentSourceKey` that means "the spawn's own `tool_result` proved it". */
  foreignKeyValue: string
  /** metadata key on the closing row carrying the spawn's event id. */
  linkedParentKey: string
  /**
   * What `linkedParentKey` actually names. `'event-id'` (the default) is claude-code's shape:
   * the closing row is derived from the same file as the spawn, so it can quote the spawn's own
   * event id.
   *
   * `'tool-use-id'` exists for an agent whose proof comes from a DIFFERENT store: the spawn's
   * event id is `deriveEventId({sourceId, rawSeq, …})`, and `rawSeq` is the other source's rowid,
   * which no adapter can reconstruct from the linking document. Naming the raw call id instead
   * keeps the proof a fact rather than a guess; this pass resolves it against the pool, and a raw
   * id matching zero or two spawns is treated as no proof at all.
   */
  proofNames?: 'event-id' | 'tool-use-id'
}

/**
 * Produced by `adapters/claude-code/src/normalize.ts` (`subagentStart` / `sidechainClose` /
 * `fromAssistantBlock`). It is spelled out here rather than imported: §5.4 forbids core
 * packages from reaching into an adapter, and the store must keep working with whatever rows an
 * adapter actually wrote.
 */
export const CLAUDE_CODE_SUBAGENT_LINK: SubagentLinkVocabulary = {
  agentId: 'claude-code',
  chainKey: 'agent_id',
  spawnToolUseKey: 'tool_use_id',
  parentSourceKey: 'parent_source',
  foreignKeyValue: 'foreign-key',
  linkedParentKey: 'linked_parent',
}

/** Agents whose stored rows this linker understands. Adding one is a vocabulary declaration. */
export const SUBAGENT_LINK_VOCABULARIES: readonly SubagentLinkVocabulary[] = [CLAUDE_CODE_SUBAGENT_LINK]

/** How a resolved parent is justified: a proof beats a guess, and only a guess says `heuristic`. */
export type SubagentParentEvidence = 'foreign-key' | 'heuristic'

export interface SubagentSpawnCandidate {
  eventId: string
  sourceId: string
  timestamp: number
  rawSeq: number
  /** The raw id the source names this call by; how a `proofNames: 'tool-use-id'` proof finds it. */
  toolUseId: string
}

/** The chain row the pool is matched against: its own position, nothing else. */
export interface SubagentChainPosition {
  eventId: string
  sourceId: string
  timestamp: number
  rawSeq: number
}

export interface SubagentParentDecision {
  parentEventId: string | null
  evidence: SubagentParentEvidence | null
}

/**
 * The rule, as a pure function of the pool. `proof` is the spawn event id the closing
 * `tool_result` names; it wins whenever it is a row that exists in this session, and the
 * nearest-preceding heuristic only runs when there is no proof (or when the proven row is gone,
 * e.g. pruned — a link to a missing event is worse than a resolvable guess).
 */
export function resolveSubagentParent(
  chain: SubagentChainPosition,
  spawns: readonly SubagentSpawnCandidate[],
  proof: string | null,
): SubagentParentDecision {
  if (proof !== null && spawns.some((s) => s.eventId === proof)) {
    return { parentEventId: proof, evidence: 'foreign-key' }
  }
  const best = pickNearestPrecedingSpawn(chain, spawns)
  return best ? { parentEventId: best.eventId, evidence: 'heuristic' } : { parentEventId: null, evidence: null }
}

/**
 * Greatest timestamp at or before the chain's first record — the `linkSidechain()` rule of
 * `adapters/claude-code/src/state.ts`, with the one part of it that cannot cross files: its
 * `rawSeq <=` guard only applies to candidates in the chain's own source, because `raw_seq` is a
 * per-file line counter. Ties resolve on `(timestamp, raw_seq, id)` so the pick is a total order
 * over the pool and therefore independent of read order.
 */
export function pickNearestPrecedingSpawn(
  chain: SubagentChainPosition,
  spawns: readonly SubagentSpawnCandidate[],
): SubagentSpawnCandidate | null {
  let best: SubagentSpawnCandidate | null = null
  for (const s of spawns) {
    if (s.eventId === chain.eventId) continue
    if (s.timestamp > chain.timestamp) continue
    if (s.sourceId === chain.sourceId && s.rawSeq > chain.rawSeq) continue
    if (best === null || ranksAfter(s, best)) best = s
  }
  return best
}

function ranksAfter(a: SubagentSpawnCandidate, b: SubagentSpawnCandidate): boolean {
  if (a.timestamp !== b.timestamp) return a.timestamp > b.timestamp
  if (a.rawSeq !== b.rawSeq) return a.rawSeq > b.rawSeq
  return a.eventId > b.eventId
}

export interface SubagentLinkPlanRow {
  agentId: string
  /** `events.id` of the `subagent.start` row. */
  eventId: string
  sessionId: string
  chainKey: string
  currentParentEventId: string | null
  /** What the pool says the parent is; NULL means it stays unknown. */
  parentEventId: string | null
  evidence: SubagentParentEvidence | null
  /** `parent_source` after the write-back: `none` is the honest label for an unresolved chain. */
  parentSource: 'foreign-key' | 'heuristic' | 'none'
  /** False when nothing about the row changes, so the apply can skip it. */
  changes: boolean
}

export interface SubagentLinkPlan {
  rows: SubagentLinkPlanRow[]
  /** `subagent.start` rows the pool was consulted for. */
  chains: number
  linkedByProof: number
  linkedByHeuristic: number
  /** Chains with no spawn to point at, and no proof: still NULL after this run (§4.4 row 8). */
  unresolved: number
  /** Closing rows whose proof names nothing, or names two different spawns. */
  unusableProofs: number
  /** Sessions the pool was read for. */
  sessions: number
}

export interface SubagentLinkApplyResult extends SubagentLinkPlan {
  /** Rows whose `parent_event_id`/`metadata` the repair upsert actually moved. */
  rewritten: number
  /** Chains left alone because the stored row could not be re-stated without losing a column. */
  refused: { eventId: string; reason: string }[]
}

export interface SubagentLinkOptions {
  /** Restricts the pass to these agents; defaults to every declared vocabulary. */
  agentIds?: readonly string[]
}

type Row = Record<string, unknown>

/** session id -> chain key -> the spawn event ids its closing rows name. Nested so no separator
 * key can ever collide, and a set because two rows that disagree are not evidence. */
type ProofIndex = Map<string, Map<string, Set<string>>>

/**
 * Turn one closing row's proof into the spawn's event id. `'event-id'` proofs are already that;
 * a `'tool-use-id'` proof must name exactly one spawn in this session, because a raw id shared
 * by two calls proves nothing about which one opened the chain.
 */
function resolveProofTarget(
  vocab: SubagentLinkVocabulary,
  candidates: readonly SubagentSpawnCandidate[],
  proof: string,
): string | null {
  if ((vocab.proofNames ?? 'event-id') === 'event-id') return proof
  const matches = candidates.filter((c) => c.toolUseId === proof)
  return matches.length === 1 ? (matches[0]?.eventId ?? null) : null
}

/** The proof for one chain, or null when nothing proves it — or when two things do. */
function proofAt(proofs: ProofIndex, sessionId: string, chainKey: string): string | null {
  const parents = proofs.get(sessionId)?.get(chainKey)
  if (!parents || parents.size !== 1) return null
  return [...parents][0] ?? null
}

function proofSet(proofs: ProofIndex, sessionId: string, chainKey: string, parent: string): void {
  let byChain = proofs.get(sessionId)
  if (!byChain) {
    byChain = new Map()
    proofs.set(sessionId, byChain)
  }
  const parents = byChain.get(chainKey)
  if (parents) parents.add(parent)
  else byChain.set(chainKey, new Set([parent]))
}

function quote(value: string): string {
  // Keys come from a declared vocabulary, never from data; the quoting is belt-and-braces so a
  // future vocabulary with a dotted or quoted key cannot turn into a different json path.
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Rows of one agent that speak the subagent-link vocabulary: spawns, chains, and closing proofs. */
function loadPool(db: DatabaseSync, vocab: SubagentLinkVocabulary): {
  spawns: Map<string, SubagentSpawnCandidate[]>
  proofs: ProofIndex
  chains: ChainRow[]
  /** Closing rows that name a spawn the store no longer holds, or name two different spawns. */
  unusableProofs: number
} {
  const spawns = new Map<string, SubagentSpawnCandidate[]>()
  const proofs = new Map<string, Map<string, Set<string>>>()
  const chains: ChainRow[] = []
  const spawnSql = `
    SELECT id, session_id, source_id, timestamp, raw_seq,
           json_extract(metadata, '$.${quote(vocab.spawnToolUseKey)}') AS tool_use_id
    FROM events
    WHERE agent_id = ? AND type = 'tool.start' AND capability_type = 'subagent'
      AND session_id IS NOT NULL
    ORDER BY timestamp, raw_seq IS NULL, raw_seq, id`
  for (const r of rowsOf(db, spawnSql, vocab.agentId)) {
    const position = positionOf(r)
    if (position === null || position.sourceId === '') continue
    // A `subagent.start` is also `capability_type = 'subagent'`, but never a `tool.start`;
    // requiring the tool_use id keeps foreign rows (another mapping's spawn) out of the pool.
    if (typeof r.tool_use_id !== 'string' || r.tool_use_id === '') continue
    const list = spawns.get(position.sessionId)
    const candidate: SubagentSpawnCandidate = {
      eventId: position.eventId,
      sourceId: position.sourceId,
      timestamp: position.timestamp,
      rawSeq: position.rawSeq,
      toolUseId: r.tool_use_id,
    }
    if (list) list.push(candidate)
    else spawns.set(position.sessionId, [candidate])
  }

  const proofSql = `
    SELECT session_id,
           json_extract(metadata, '$.${quote(vocab.chainKey)}') AS chain_key,
           COALESCE(json_extract(metadata, '$.${quote(vocab.linkedParentKey)}'), parent_event_id) AS parent_event_id
    FROM events
    WHERE agent_id = ? AND type = 'subagent.end'
      AND json_extract(metadata, '$.${quote(vocab.chainKey)}') IS NOT NULL
      AND json_extract(metadata, '$.${quote(vocab.parentSourceKey)}') = ?`
  let unusableProofs = 0
  const proofCandidates: { sessionId: string; chainKey: string; parent: string }[] = []
  for (const r of rowsOf(db, proofSql, vocab.agentId, vocab.foreignKeyValue)) {
    const sessionId = typeof r.session_id === 'string' ? r.session_id : null
    const chainKey = typeof r.chain_key === 'string' ? r.chain_key : null
    const parent = typeof r.parent_event_id === 'string' ? r.parent_event_id : null
    if (sessionId === null || chainKey === null || parent === null) continue
    proofCandidates.push({ sessionId, chainKey, parent })
  }
  // Set-valued, then narrowed: two closing rows naming different spawns for one chain is a
  // contradiction, not evidence, and "keep the last one read" would make the answer depend on row
  // order. A proof whose spawn row is no longer in the store is the other unusable case.
  // A proof that names a raw call id is resolved here, against this session's pool, so every
  // path below keeps speaking event ids: the resolved answer is still a pure function of stored
  // rows, never of which source was scanned first.
  for (const c of proofCandidates) {
    const target = resolveProofTarget(vocab, spawns.get(c.sessionId) ?? [], c.parent)
    if (target === null) {
      unusableProofs++
      continue
    }
    proofSet(proofs, c.sessionId, c.chainKey, target)
  }
  for (const [sessionId, byChain] of proofs) {
    for (const [chainKey, parents] of byChain) {
      const parent = parents.size === 1 ? [...parents][0] ?? null : null
      if (parent === null || spawns.get(sessionId)?.some((s) => s.eventId === parent) !== true) {
        unusableProofs++
        byChain.delete(chainKey)
      }
    }
  }

  const chainSql = `
    SELECT id, session_id, source_id, timestamp, raw_seq, parent_event_id,
           json_extract(metadata, '$.${quote(vocab.chainKey)}') AS chain_key,
           json_extract(metadata, '$.${quote(vocab.parentSourceKey)}') AS parent_source,
           json_extract(metadata, '$.parent_matched') AS parent_matched,
           json_extract(metadata, '$.parent_heuristic') AS parent_heuristic
    FROM events
    WHERE agent_id = ?
      AND type = 'subagent.start'
      AND json_extract(metadata, '$.${quote(vocab.chainKey)}') IS NOT NULL
    ORDER BY session_id, timestamp, raw_seq IS NULL, raw_seq, id`
  for (const r of rowsOf(db, chainSql, vocab.agentId)) {
    const position = positionOf(r)
    const chainKey = typeof r.chain_key === 'string' ? r.chain_key : null
    if (position === null || chainKey === null) continue
    chains.push({
      ...position,
      chainKey,
      storedParent: typeof r.parent_event_id === 'string' ? r.parent_event_id : null,
      storedParentSource: typeof r.parent_source === 'string' ? r.parent_source : null,
      storedMatched: boolOf(r.parent_matched),
      storedHeuristic: boolOf(r.parent_heuristic),
    })
  }
  return { spawns, proofs, chains, unusableProofs }
}

interface ChainRow extends SubagentChainPosition {
  sessionId: string
  chainKey: string
  storedParent: string | null
  storedParentSource: string | null
  storedMatched: boolean | null
  storedHeuristic: boolean | null
}

/**
 * What the linker would write, without writing anything: the deployed scan calls
 * `resolveSubagentParents`, while a caller that only wants to see the evidence (doctor, tests)
 * can read the same decision through this.
 */
export function planSubagentParentLinks(db: DatabaseSync, opts: SubagentLinkOptions = {}): SubagentLinkPlan {
  const rows: SubagentLinkPlanRow[] = []
  let unresolved = 0
  let unusableProofs = 0
  let sessions = 0
  for (const vocab of SUBAGENT_LINK_VOCABULARIES) {
    if (opts.agentIds && !opts.agentIds.includes(vocab.agentId)) continue
    const pool = loadPool(db, vocab)
    if (pool.chains.length === 0) continue
    sessions += new Set(pool.chains.map((c) => c.sessionId)).size
    unusableProofs += pool.unusableProofs
    for (const chain of pool.chains) {
      const decision = resolveSubagentParent(
        chain,
        pool.spawns.get(chain.sessionId) ?? [],
        proofAt(pool.proofs, chain.sessionId, chain.chainKey),
      )
      if (decision.parentEventId === null) unresolved++
      const parentSource = decision.evidence ?? 'none'
      rows.push({
        agentId: vocab.agentId,
        eventId: chain.eventId,
        sessionId: chain.sessionId,
        chainKey: chain.chainKey,
        currentParentEventId: chain.storedParent,
        parentEventId: decision.parentEventId,
        evidence: decision.evidence,
        parentSource,
        changes: chainNeedsWrite(chain, decision.parentEventId, parentSource),
      })
    }
  }
  const linkedByProof = rows.filter((r) => r.evidence === 'foreign-key').length
  const linkedByHeuristic = rows.filter((r) => r.evidence === 'heuristic').length
  return {
    rows,
    chains: rows.length,
    linkedByProof,
    linkedByHeuristic,
    unresolved,
    unusableProofs,
    sessions,
  }
}

/**
 * A stored row needs no write when its parent and all three evidence keys already say what the
 * pool says. That equality is what makes the second run a no-op: the pool did not change, so
 * neither does the derived answer, and `insertEvents` never sees the row at all.
 */
function chainNeedsWrite(chain: ChainRow, parentEventId: string | null, parentSource: string): boolean {
  if (chain.storedParent !== parentEventId) return true
  if (chain.storedParentSource !== parentSource) return true
  if (chain.storedMatched === null || chain.storedHeuristic === null) return true
  const matched = parentEventId !== null
  return chain.storedMatched !== matched || chain.storedHeuristic !== (parentSource === 'heuristic')
}

export function resolveSubagentParents(
  db: DatabaseSync,
  opts: SubagentLinkOptions = {},
): SubagentLinkApplyResult {
  const plan = planSubagentParentLinks(db, opts)
  const targets = plan.rows.filter((r) => r.changes)
  if (targets.length === 0) return { ...plan, rewritten: 0, refused: [] }
  const { rewritten, refused } = applyLinks(db, targets)
  return { ...plan, rewritten, refused }
}

/**
 * One transaction: snapshot the rows, re-derive them through §5.3's repair upsert, then prove the
 * only columns that moved are the two this linker owns. Any other difference — a NULL the
 * projection turned into `''`, a `content_ref` a payload rebuild could not restate, a
 * `model_rowid` that found a different row — aborts the whole pass, so a parent link is never
 * bought with silent edits to unrelated columns.
 */
function applyLinks(
  db: DatabaseSync,
  targets: readonly SubagentLinkPlanRow[],
): { rewritten: number; refused: { eventId: string; reason: string }[] } {
  const refused: { eventId: string; reason: string }[] = []
  const decisions = new Map(targets.map((t) => [t.eventId, t]))
  const wanted = targets.map((t) => t.eventId)
  let rewritten = 0
  withTransaction(db, () => {
    const before = snapshotRows(db, wanted)
    const beforePayloads = snapshotPayloads(db, wanted)
    const beforeTables = snapshotTableCounts(db)
    const events: AgentEvent[] = []
    for (const id of wanted) {
      const row = before.get(id)
      const decision = decisions.get(id)
      if (!row || !decision) {
        refused.push({ eventId: id, reason: 'the row is no longer in the store' })
        continue
      }
      const built = repairableEventFromRow(db, row, decision, refused)
      if (built) events.push(built)
    }
    if (events.length === 0) return
    // `contentEnabled` must stay on whenever a row carries `content_ref`: the repair upsert binds
    // that column from the event's payload, so writing without it would blank the content pointer
    // (§3.2). `insertPayload` is INSERT OR IGNORE on `event_id`, so the payload row itself never moves.
    rewritten = insertEvents(db, events, { contentEnabled: events.some((e) => e.payload) }).inserted
    const after = snapshotRows(db, wanted)
    const afterPayloads = snapshotPayloads(db, wanted)
    for (const [id, oldRow] of before) {
      const newRow = after.get(id)
      if (!newRow) throw new Error(`subagent parent link: event ${id} disappeared during the repair`)
      for (const column of Object.keys(oldRow)) {
        if (column === 'parent_event_id' || column === 'metadata') continue
        if (oldRow[column] !== newRow[column]) {
          throw new Error(
            `subagent parent link refused for ${id}: the repair upsert moved ${column} from ` +
              `${JSON.stringify(oldRow[column])} to ${JSON.stringify(newRow[column])}`,
          )
        }
      }
    }
    for (const [id, oldPayload] of beforePayloads) {
      const newPayload = afterPayloads.get(id)
      if (!newPayload || JSON.stringify(newPayload) !== JSON.stringify(oldPayload)) {
        throw new Error(`subagent parent link refused for ${id}: the content layer changed`)
      }
    }
    // A link pass edits rows; it never adds or removes any. `insertEvents` mints
    // `agents`/`sources`/`sessions`/`projects` placeholders and can look up a model row, so a count
    // that moved means this pass reached a store its events no longer describe (rows pruned under a
    // different `--since`) and re-stating them is not safe.
    const afterTables = snapshotTableCounts(db)
    const moved = Object.keys(afterTables).filter((t) => afterTables[t] !== beforeTables[t])
    if (moved.length > 0) {
      throw new Error(
        `subagent parent link refused: the pass changed row counts for ${moved
          .map((t) => `${t} (${beforeTables[t]} → ${afterTables[t]})`)
          .join(', ')}`,
      )
    }
  })
  return { rewritten, refused }
}

/**
 * `AgentEvent` with NULL-preserving fields: `insertEvents` binds every optional one through
 * `nn()`, so `null` here is what reproduces a stored NULL. `rowToEvent` cannot be reused — it is
 * the metric-layer rehydration, and it collapses `host_id`/`project_id` to `''` and drops
 * `model`/`payload`, which are exactly the columns a write-back must not touch.
 */
function repairableEventFromRow(
  db: DatabaseSync,
  row: Row,
  decision: SubagentLinkPlanRow,
  refused: { eventId: string; reason: string }[],
): AgentEvent | null {
  const refuse = (reason: string): null => {
    refused.push({ eventId: decision.eventId, reason })
    return null
  }
  const required = ['id', 'session_id', 'source_id', 'agent_id'] as const
  for (const column of required) if (typeof row[column] !== 'string') return refuse(`${column} is not a string`)
  if (blank(row.timestamp)) return refuse('timestamp is NULL')
  if (blank(row.type)) return refuse('type is NULL')
  if (blank(row.schema_version)) return refuse('schema_version is NULL')

  let model: ModelRef | null = null
  if (!blank(row.model_rowid)) {
    const m = rowsOf(db, 'SELECT provider, name, tier FROM models WHERE rowid = ?', Number(row.model_rowid))[0]
    if (!m) return refuse(`models row ${String(row.model_rowid)} is gone`)
    model = { provider: String(m.provider), name: String(m.name), tier: (m.tier as string | null) ?? null }
  }

  let payload: PayloadDraft | null = null
  if (!blank(row.content_ref)) {
    const p = rowsOf(db, 'SELECT kind, role, text FROM payloads WHERE event_id = ?', String(row.id))[0]
    if (!p) return refuse(`content_ref ${String(row.content_ref)} has no payloads row`)
    const storedKind = String(p.kind ?? '')
    if (storedKind !== String(row.content_ref)) {
      // The repair writes `content_ref = payload.kind`; a disagreement would rewrite it.
      return refuse(`content_ref ${String(row.content_ref)} != payloads.kind ${storedKind}`)
    }
    payload = {
      kind: storedKind as PayloadDraft['kind'],
      role: (p.role as string | null) ?? null,
      text: blank(p.text) ? '' : inflateSync(Buffer.from(p.text as Uint8Array)).toString('utf8'),
    }
  }

  // Every row this linker targets is a `subagent.start`, and the adapter always writes its
  // metadata; a row without one gets the evidence keys added rather than skipped, since adding
  // them is what keeps `parent_event_id` and its stated evidence from disagreeing.
  const metadata: Record<string, unknown> = {}
  if (!blank(row.metadata)) {
    try {
      const parsed = JSON.parse(String(row.metadata)) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return refuse('metadata is not a JSON object')
      }
      Object.assign(metadata, parsed as Record<string, unknown>)
    } catch {
      return refuse('metadata is not parseable JSON')
    }
  }
  // The three evidence keys are this linker's own output; everything else in the row is data.
  metadata.parent_source = decision.parentSource
  metadata.parent_matched = decision.parentEventId !== null
  metadata.parent_heuristic = decision.parentSource === 'heuristic'

  const capability: CapabilityRef | null = blank(row.capability_type)
    ? null
    : {
        type: row.capability_type as CapabilityType,
        name: String(row.capability_name ?? ''),
        provider: (row.capability_provider as string | null) ?? null,
      }
  if (capability && blank(row.capability_name)) return refuse('capability_name is NULL under a capability')

  const tokens = [
    row.input_tokens,
    row.output_tokens,
    row.cache_read_tokens,
    row.cache_write_tokens,
    row.reasoning_tokens,
  ]
  const usage = (tokens.every(blank)
    ? null
    : {
        // Stored NULL stays NULL: `insertEvents` binds `nn(usage?.x)`, so a `0` here would be a
        // silent answer to a question the source never asked (§5.2).
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        reasoningTokens: row.reasoning_tokens,
      }) as Usage | null

  const event = {
    id: String(row.id),
    schemaVersion: Number(row.schema_version ?? 0),
    agentId: String(row.agent_id),
    hostId: (row.host_id as string | null) ?? null,
    sourceId: String(row.source_id),
    sessionId: String(row.session_id),
    projectId: (row.project_id as string | null) ?? null,
    parentEventId: decision.parentEventId,
    requestId: (row.request_id as string | null) ?? null,
    threadId: (row.thread_id as string | null) ?? null,
    timestamp: Number(row.timestamp),
    ingestedAt: (row.ingested_at as number | null) ?? null,
    type: row.type as EventType,
    subtype: (row.subtype as string | null) ?? null,
    model,
    usage,
    usageSource: (row.usage_source as UsageSource | null) ?? null,
    costReported: (row.cost_reported as number | null) ?? null,
    costSource: (row.cost_source as CostSource | null) ?? null,
    credits: (row.credits as number | null) ?? null,
    capability,
    durationMs: (row.duration_ms as number | null) ?? null,
    status: (row.status as EventStatus | null) ?? null,
    errorFingerprint: (row.error_fingerprint as string | null) ?? null,
    rawSeq: (row.raw_seq as number | null) ?? null,
    rawOffset: (row.raw_offset as number | null) ?? null,
    payload,
    metadata,
  }
  return event as unknown as AgentEvent
}

/** A stored column that carries no value: NULL, or absent on a row read before a migration. */
function blank(value: unknown): boolean {
  return value === null || value === undefined
}

function snapshotRows(db: DatabaseSync, ids: readonly string[]): Map<string, Row> {
  const out = new Map<string, Row>()
  for (const chunk of chunks(ids)) {
    for (const r of rowsOf(db, `SELECT rowid AS _rowid, * FROM events WHERE id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) {
      out.set(String(r.id), r)
    }
  }
  return out
}

function snapshotPayloads(db: DatabaseSync, ids: readonly string[]): Map<string, Row> {
  const out = new Map<string, Row>()
  for (const chunk of chunks(ids)) {
    for (const r of rowsOf(
      db,
      `SELECT event_id, kind, role, bytes, truncated, created_at FROM payloads WHERE event_id IN (${chunk.map(() => '?').join(',')})`,
      ...chunk,
    )) {
      out.set(String(r.event_id), r)
    }
  }
  return out
}

/**
 * Row counts for every table `insertEvents` can reach. The names are a literal set, not data, and
 * a link pass claims nothing: each count has to come back the same or the transaction rolls back.
 */
function snapshotTableCounts(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {}
  for (const table of [
    'events',
    'payloads',
    'models',
    'sources',
    'sessions',
    'projects',
    'agents',
    'parse_errors',
  ]) {
    out[table] = Number(rowsOf(db, `SELECT COUNT(*) AS n FROM ${table}`)[0]?.n ?? 0)
  }
  return out
}

function chunks(ids: readonly string[], size = 500): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

function rowsOf(db: DatabaseSync, sql: string, ...params: unknown[]): Row[] {
  const stmt = db.prepare(sql)
  const out = params.length ? stmt.all(...(params as never[])) : stmt.all()
  return (out as Row[]).map((r) => ({ ...r }))
}

function positionOf(row: Row): (SubagentChainPosition & { sessionId: string; sourceId: string }) | null {
  if (typeof row.id !== 'string' || typeof row.session_id !== 'string') return null
  const timestamp = Number(row.timestamp)
  if (!Number.isFinite(timestamp)) return null
  return {
    eventId: row.id,
    sessionId: row.session_id,
    sourceId: typeof row.source_id === 'string' ? row.source_id : '',
    timestamp,
    rawSeq: Number.isFinite(Number(row.raw_seq)) ? Number(row.raw_seq) : 0,
  }
}

/** SQLite's `json_extract` hands back 1/0 for JSON booleans; absence stays null. */
function boolOf(value: unknown): boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  return String(value) === 'true'
}
