/**
 * Source watcher (§4.3/§12): a thin scheduler over the orchestrator's
 * `scanSource` — it never re-implements framing or offset logic. Its job is to
 * decide *which* sources changed, in what order, and to survive one source or
 * adapter failing without stalling the rest (§5.2 rule 1, §4.2).
 *
 * Two wake-up paths share one `tick()`: an event-driven hint (`fs.watch` on
 * each source directory — macOS drops events for files appended by another
 * process, so it's an optimization only) plus a periodic safety-net poll.
 * Tests drive `tick()`/`scanOnce()` directly with no timers and no sleeps.
 *
 * Change detection reuses `needsRescan` verbatim (§4.3): a source is scanned
 * only when its `(inode, size, mtime)` differs from the saved row, so the
 * poll cost is one `stat` per source. Rotation and vanishing flow through the
 * same `scan()` callback, whose `scanSource` commit writes `status='rotated'`
 * / `'gone'` without deleting history (§4.3).
 */
import { watch, type FSWatcher } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentAdapter, SourceSpec } from '@agentlens/event-model'
import { needsRescan, statSource, type SavedSourcePosition, type SourceStat } from './incremental.ts'
import type { ScanResult } from './orchestrator.ts'

export const DEFAULT_WATCH_INTERVAL_MS = 5_000
export const DEFAULT_DISCOVER_INTERVAL_MS = 60_000
const DEFAULT_MAX_FAILURES = 5
/** fs.watch hints coalesce; poll already guarantees eventual catch. */
const HINT_DEBOUNCE_MS = 200

/**
 * One watched log file. Persistence is *outside* the watcher: `saved` is the
 * current last-good position (advanced by the caller's sink after a commit,
 * §4.2) and `scan` runs `scanSource` and returns its `ScanResult` unchanged.
 * The watcher only calls `scan` when `needsRescan` says a change is worth a
 * pass, so `saved` must be updated by `scan` (or the sink it drives) before
 * the next tick reads it.
 */
export interface WatchTarget {
  id: string
  agentId: string
  adapter: AgentAdapter
  source: SourceSpec
  /** Where the next scan resumes from; seed `{inode:0,size:0,mtimeMs:0,lastOffset:0}` for never-scanned. */
  saved: SavedSourcePosition
  scan(): Promise<ScanResult>
  /** Re-enumerate this adapter's sources (new session files appearing); the watcher dedupes by id. */
  discover?(): AsyncIterable<WatchTarget>
}

export interface WatchTargetSummary {
  id: string
  agentId: string
  path: string
  action: ScanResult['action']
  events: number
  linesConsumed: number
  failures: number
  nextOffset: number
  /** §4.2 — true only when the batch committed and moved `last_offset`. */
  committed: boolean
}

/** A source scan, stat, or discovery that threw: surfaced so `doctor` can see it (§5.2 rule 1). */
export interface WatchFailure {
  atMs: number
  id: string
  agentId: string
  path: string
  error: string
  consecutive: number
  /** `true` once `maxFailures` is reached; quarantined sources retry only on next discovery. */
  quarantined: boolean
}

/** One completed watch cycle; the SSE bridge (§12) will forward these verbatim. */
export interface WatchBatch {
  atMs: number
  scanned: WatchTargetSummary[]
  discovered: string[]
  failed: WatchFailure[]
  /** Ids whose stat returned null this cycle; the commit already wrote `status='gone'`. */
  vanished: string[]
}

export interface WatcherOptions {
  targets: Iterable<WatchTarget>
  intervalMs?: number
  /** Re-discover interval; `0` disables. Default 60s. */
  discoverIntervalMs?: number
  maxFailures?: number
  /** Set `false` to disable `fs.watch` hints (test/poll-only mode). Default `true`. */
  useFsWatch?: boolean
  now?: () => number
  onBatch?(b: WatchBatch): void
  onDiscovered?(added: readonly WatchTarget[]): void
  onVanished?(t: WatchTarget): void
  onQuarantined?(f: WatchFailure): void
  /** Loop-level throw: `start()` catches `tick()` rejections so one bad cycle cannot kill the resident process. */
  onLoopError?(err: Error): void
}

export interface Watcher {
  readonly targets: readonly WatchTarget[]
  /** Live count of timers/watchers; `start()` ≥ 1, `stop()` === 0. The CLI e2e test asserts clean shutdown via this. */
  readonly openHandleCount: number
  tick(): Promise<WatchBatch>
  scanOnce(): Promise<WatchBatch>
  start(): void
  stop(): void
  readonly stopped: boolean
}

export function createWatcher(options: WatcherOptions): Watcher {
  const intervalMs = options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS
  const discoverIntervalMs = options.discoverIntervalMs ?? DEFAULT_DISCOVER_INTERVAL_MS
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES
  const useFsWatch = options.useFsWatch ?? true
  const now = options.now ?? Date.now

  const byId = new Map<string, WatchTarget>()
  for (const t of options.targets) if (!byId.has(t.id)) byId.set(t.id, t)

  const missing = new Set<string>()
  const fails = new Map<string, number>()
  const quarantined = new Set<string>()
  const watchers = new Map<string, FSWatcher>()
  let pollTimer: NodeJS.Timeout | null = null
  let debounceTimer: NodeJS.Timeout | null = null
  let lastDiscoverAt = 0
  let running = false
  let queued = false
  let stopped = false

  async function tick(): Promise<WatchBatch> {
    if (stopped) return emptyBatch()
    const scanned: WatchTargetSummary[] = []
    const failed: WatchFailure[] = []
    const vanished: string[] = []

    // Discover first so a `scanOnce()` both adopts a new source and ingests it in one pass.
    const discovery = await runDiscovery(now())
    const discovered = discovery.added
    for (const d of discovered) openWatchersForDir(dirname(d.source.path))
    if (discovered.length > 0) options.onDiscovered?.(discovered)

    for (const id of [...byId.keys()]) {
      if (stopped) break
      const target = byId.get(id)
      if (!target || quarantined.has(id)) continue

      let st: SourceStat | null
      try {
        st = await statSource(target.source.path)
      } catch (err) {
        // `statSource` swallows ENOENT into null; anything else here is a transient io error,
        // not a §4.3 vanish, so we must not commit 'gone'. Retry next cycle.
        failed.push(note(id, target, err))
        continue
      }

      if (st === null) {
        // §4.3: file gone. Commit once to flip `status='gone'`; scanSource keeps the previous
        // offset/inode and writes no rows, so history stays intact. Suppress re-commits while gone.
        if (missing.has(id)) continue
        missing.add(id)
        try {
          const res = await target.scan()
          if (res.action === 'gone') {
            vanished.push(id)
            options.onVanished?.(target)
          }
        } catch (err) {
          failed.push(note(id, target, err))
        }
        continue
      }
      missing.delete(id)

      if (needsRescan(st, target.saved) === 'skip') continue
      try {
        const res = await target.scan()
        if (res.action !== 'skip') {
          scanned.push({
            id,
            agentId: target.agentId,
            path: target.source.path,
            action: res.action,
            events: res.events,
            linesConsumed: res.linesConsumed,
            failures: res.failures,
            nextOffset: res.nextOffset,
            committed: true,
          })
          fails.delete(id)
        }
      } catch (err) {
        // §4.2: `commitSource` did not run, so `target.saved.lastOffset` still points at the
        // last good line boundary. Nothing to roll back here — the sink owns the transaction.
        failed.push(note(id, target, err))
      }
    }

    const batch: WatchBatch = {
      atMs: now(),
      scanned,
      discovered: discovered.map((d) => d.id),
      failed: [...failed, ...discovery.failed],
      vanished,
    }
    if (batch.scanned.length || batch.discovered.length || batch.failed.length || batch.vanished.length) {
      options.onBatch?.(batch)
    }
    return batch
  }

  async function scanOnce(): Promise<WatchBatch> {
    lastDiscoverAt = 0
    return tick()
  }

  async function runDiscovery(atMs: number): Promise<{ added: WatchTarget[]; failed: WatchFailure[] }> {
    if (discoverIntervalMs === 0) return { added: [], failed: [] }
    if (lastDiscoverAt && atMs - lastDiscoverAt < discoverIntervalMs) return { added: [], failed: [] }
    lastDiscoverAt = atMs
    const seen = new Map<string, WatchTarget>()
    const discoverFailures: WatchFailure[] = []
    for (const target of [...byId.values()]) {
      if (!target.discover) continue
      try {
        for await (const t of target.discover()) {
          if (t && !seen.has(t.id)) seen.set(t.id, t)
        }
      } catch (err) {
        // Discovery failing is not a scan failing: record it (doctor) but do not quarantine the source.
        discoverFailures.push({
          atMs: now(),
          id: target.id,
          agentId: target.agentId,
          path: target.source.path,
          error: err instanceof Error ? err.message : String(err),
          consecutive: fails.get(target.id) ?? 0,
          quarantined: false,
        })
      }
    }
    const added: WatchTarget[] = []
    for (const [id, t] of seen) {
      if (quarantined.has(id)) quarantined.delete(id)
      if (byId.has(id)) continue
      byId.set(id, t)
      added.push(t)
    }
    return { added, failed: discoverFailures }
  }

  function note(id: string, target: WatchTarget, err: unknown): WatchFailure {
    const consecutive = (fails.get(id) ?? 0) + 1
    fails.set(id, consecutive)
    const f: WatchFailure = {
      atMs: now(),
      id,
      agentId: target.agentId,
      path: target.source.path,
      error: err instanceof Error ? err.message : String(err),
      consecutive,
      quarantined: consecutive >= maxFailures,
    }
    if (f.quarantined && !quarantined.has(id)) {
      quarantined.add(id)
      options.onQuarantined?.(f)
    }
    return f
  }

  function emptyBatch(): WatchBatch {
    return { atMs: now(), scanned: [], discovered: [], failed: [], vanished: [] }
  }

  function openWatchersForDir(dir: string): void {
    if (!useFsWatch || stopped || watchers.has(dir)) return
    let w: FSWatcher
    try {
      w = watch(dir, () => hint())
    } catch {
      return // unreadable / vanished dir: poll still covers it
    }
    w.on('error', () => { watchers.delete(dir); try { w.close() } catch { /* already closed */ } })
    watchers.set(dir, w)
  }

  function hint(): void {
    if (stopped || debounceTimer) return
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void runLoopTick()
    }, HINT_DEBOUNCE_MS)
  }

  /** One cycle at a time; further wake-ups while running coalesce into exactly one follow-up. */
  async function runLoopTick(): Promise<WatchBatch | null> {
    if (running) { queued = true; return null }
    running = true
    let last: WatchBatch | null = null
    try {
      do {
        queued = false
        last = await tick()
      } while (queued && !stopped)
    } catch (err) {
      options.onLoopError?.(err instanceof Error ? err : new Error(String(err)))
    } finally {
      running = false
    }
    return last
  }

  function start(): void {
    if (stopped || pollTimer) return
    pollTimer = setInterval(() => void runLoopTick(), intervalMs)
    for (const t of byId.values()) openWatchersForDir(dirname(t.source.path))
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    for (const w of watchers.values()) {
      try { w.close() } catch { /* already closed */ }
    }
    watchers.clear()
  }

  return {
    get targets() { return [...byId.values()] },
    get openHandleCount() {
      return (pollTimer ? 1 : 0) + (debounceTimer ? 1 : 0) + watchers.size
    },
    get stopped() { return stopped },
    tick,
    scanOnce,
    start,
    stop,
  }
}
