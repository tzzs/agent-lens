/**
 * The §8 billing-mode declaration store: `<dataDir>/config.json`, shaped
 * `{ "billing": { "<agentId>": "<mode>" } }`.
 *
 * One implementation on purpose. The CLI command, the server route and the cube's
 * `billingModeFor` all go through here, because §14's invariant is that the
 * terminal and the dashboard cannot report different numbers from the same rows —
 * and after this feature the mode is written at runtime, so two copies of the file
 * format would be two chances to disagree.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BillingMode } from './price-types.ts'

export const BILLING_MODES: readonly BillingMode[] = ['api', 'subscription', 'local']

export class BillingModeError extends Error {
  override readonly name = 'BillingModeError'
}

export function isBillingMode(v: unknown): v is BillingMode {
  return typeof v === 'string' && (BILLING_MODES as readonly string[]).includes(v)
}

/** Throws with both what was rejected and what is legal, so the message is actionable. */
export function assertBillingMode(v: unknown): BillingMode {
  if (!isBillingMode(v)) {
    throw new BillingModeError(
      `billing mode must be one of api | subscription | local (§8), got ${JSON.stringify(v)}`,
    )
  }
  return v
}

/** Declarations live next to the database, not in the home dir: `--db <tmp>/x.db` must stay hermetic. */
export function billingConfigPath(dbPath: string): string {
  return join(dirname(dbPath), 'config.json')
}

/** Tolerant read: a malformed value drops that one declaration instead of breaking every query. */
export function parseBillingModes(raw: unknown): Record<string, BillingMode> {
  const billing = (raw as { billing?: unknown } | null)?.billing
  if (typeof billing !== 'object' || billing === null || Array.isArray(billing)) return {}
  const out: Record<string, BillingMode> = {}
  for (const [agent, mode] of Object.entries(billing as Record<string, unknown>)) {
    if (isBillingMode(mode)) out[agent] = mode
  }
  return out
}

export function readBillingModesFile(path: string): Record<string, BillingMode> {
  try {
    return parseBillingModes(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return {}
  }
}

function readConfigObject(path: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    // The file may hold hand-edited settings besides `billing`; overwriting them with
    // a fresh object because the current content does not parse would delete them.
    throw new BillingModeError(`${path} is not valid JSON: ${(err as Error).message} — fix it before declaring a billing mode`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BillingModeError(`${path} must contain a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/**
 * Declare (`mode`) or undeclare (`null`) one agent; returns the resulting map.
 * `null` on an undeclared agent is a no-op, so "clear" is idempotent.
 */
export function writeBillingMode(
  path: string,
  agentId: string,
  mode: BillingMode | null,
): Record<string, BillingMode> {
  const id = agentId.trim()
  if (!id) throw new BillingModeError('agent id is required, got an empty agent id')
  const resolved = mode === null ? null : assertBillingMode(mode)
  const config = readConfigObject(path)
  // Untyped leftovers a hand-edited file may contain are carried over verbatim: this
  // function owns only the one declaration it was asked about.
  const raw =
    config.billing !== null && typeof config.billing === 'object' && !Array.isArray(config.billing)
      ? { ...(config.billing as Record<string, unknown>) }
      : {}
  if (resolved === null) delete raw[id]
  else raw[id] = resolved
  config.billing = raw
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return parseBillingModes(config)
}

/**
 * A read-through view of the declaration file.
 *
 * `queryDeps()` in the CLI captures the modes once, and `--serve` keeps that process
 * alive for as long as the dashboard runs — so a plain snapshot would have the page
 * write a declaration the cube still answers with the old mode until a restart, and
 * Settings and Agents would then disagree inside one process. The proxy re-reads when
 * the file's identity (size + mtime at ns resolution) changes and caches otherwise.
 */
export function liveBillingModes(path: string): Record<string, BillingMode> {
  let stamp = ''
  let cached: Record<string, BillingMode> = {}
  const current = (): Record<string, BillingMode> => {
    let next: string
    try {
      const st = statSync(path, { bigint: true })
      next = `${st.size}:${st.mtimeNs}`
    } catch {
      next = 'absent'
    }
    if (next !== stamp) {
      stamp = next
      cached = readBillingModesFile(path)
    }
    return cached
  }
  return new Proxy({} as Record<string, BillingMode>, {
    get: (_t, key) => (typeof key === 'string' ? current()[key] : undefined),
    has: (_t, key) => typeof key === 'string' && key in current(),
    ownKeys: () => Reflect.ownKeys(current()),
    // Without these two, `toEqual`/spread see an empty object and every caller that
    // enumerates the map reports "no declarations".
    getOwnPropertyDescriptor: (_t, key) =>
      typeof key === 'string' && key in current()
        ? { value: current()[key], enumerable: true, configurable: true, writable: false }
        : undefined,
    set: () => {
      throw new BillingModeError('the billing-mode view is read-only; write through writeBillingMode()')
    },
  })
}
