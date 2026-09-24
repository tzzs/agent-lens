/**
 * The §8 billing-mode declaration store: `<dataDir>/config.json`, shaped
 * `{ "billing": { "<agentId>": "<mode>" | { mode, planUsdPerMonth, models } } }`.
 *
 * One implementation on purpose. The CLI command, the server route and the cube's
 * `billingModeFor` all go through here, because §14's invariant is that the
 * terminal and the dashboard cannot report different numbers from the same rows —
 * and after this feature the mode is written at runtime, so two copies of the file
 * format would be two chances to disagree.
 *
 * WHY A MODE CAN BE PER-MODEL: billing is not a property of the agent. One Claude
 * Code install runs half its models on a subscription and half on a metered key, and
 * answering that question once per agent turns real cash into $0 for the part that
 * was paid for. `models` is keyed `"<provider>/<name>"` — the same pair
 * `dims: ['provider','model']` produces, so a declaration cannot address a row that
 * no read can find.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BillingMode } from './price-types.ts'

export const BILLING_MODES: readonly BillingMode[] = ['api', 'subscription', 'local']

/** One agent's whole declaration. Always fully populated, so no caller branches on absence. */
export interface BillingDeclaration {
  /** `null` = this agent declares no default; only its per-model entries answer. */
  mode: BillingMode | null
  /** What the plan actually costs per calendar month, or `null` for "not declared" (§8: unknown is never $0). */
  planUsdPerMonth: number | null
  /** `"<provider>/<name>"` → mode, winning over `mode` for that model alone. */
  models: Record<string, BillingMode>
}

export const NO_DECLARATION: BillingDeclaration = { mode: null, planUsdPerMonth: null, models: {} }

/** The key `models` is stored under, from the two halves the cube reports. */
export function billingModelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** `billingModelKey` inverted. Only the FIRST slash splits, since a model name may carry its own. */
export function parseModelKey(key: string): [provider: string, model: string] {
  const at = key.indexOf('/')
  return at < 0 ? ['', key] : [key.slice(0, at), key.slice(at + 1)]
}


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

/** A fee is optional, so a bad one drops the FEE and keeps the mode; a bad mode drops the agent. */
function parseFee(v: unknown): number | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new BillingModeError(`planUsdPerMonth must be a non-negative number, got ${JSON.stringify(v)}`)
  }
  return v
}

function parseModelModes(v: unknown): Record<string, BillingMode> {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new BillingModeError(`billing models must be an object of "<provider>/<name>" -> mode, got ${JSON.stringify(v)}`)
  }
  const out: Record<string, BillingMode> = {}
  for (const [key, mode] of Object.entries(v as Record<string, unknown>)) {
    if (!isBillingMode(mode)) {
      throw new BillingModeError(`billing model "${key}" must be one of api | subscription | local, got ${JSON.stringify(mode)}`)
    }
    out[key] = mode
  }
  return out
}

/**
 * Tolerant read: one unusable entry drops that entry, not the whole file, so a typo in
 * one agent's fee cannot silently re-price every other agent back to `api`.
 */
export function parseBillingModes(raw: unknown): Record<string, BillingDeclaration> {
  const billing = (raw as { billing?: unknown } | null)?.billing
  if (typeof billing !== 'object' || billing === null || Array.isArray(billing)) return {}
  const out: Record<string, BillingDeclaration> = {}
  for (const [agent, value] of Object.entries(billing as Record<string, unknown>)) {
    try {
      if (typeof value === 'string') {
        // The original shape: a bare mode is the agent's default and nothing else.
        if (isBillingMode(value)) out[agent] = { ...NO_DECLARATION, mode: value }
        continue
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const entry = value as { mode?: unknown; planUsdPerMonth?: unknown; models?: unknown }
      const mode = entry.mode === undefined || entry.mode === null ? null : assertBillingMode(entry.mode)
      out[agent] = { mode, planUsdPerMonth: parseFee(entry.planUsdPerMonth), models: parseModelModes(entry.models) }
    } catch {
      // Skip this agent's declaration; the rest of the file still answers.
      continue
    }
  }
  return out
}

/**
 * The mode one row is billed at: its own model entry, else the agent's default, else `api`.
 * Model-level always wins because it is the narrower claim about the same money.
 */
export function billingModeFor(
  modes: Record<string, BillingDeclaration>,
  agentId: string,
  provider = '',
  model = '',
): BillingMode {
  const declaration = modes[agentId]
  if (!declaration) return 'api'
  if (model) {
    const perModel = declaration.models[billingModelKey(provider, model)]
    if (perModel) return perModel
  }
  return declaration.mode ?? 'api'
}

export function planFeeFor(modes: Record<string, BillingDeclaration>, agentId: string): number | null {
  return modes[agentId]?.planUsdPerMonth ?? null
}

export function readBillingModesFile(path: string): Record<string, BillingDeclaration> {
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
 * Read-modify-write one agent's declaration. `mutate` receives the agent's CURRENT, fully
 * populated declaration so a write of one field cannot erase the others — the bug shape this
 * whole file exists to avoid is a serializer that rebuilds a record key by key.
 *
 * An agent with nothing but a mode stays written as the plain string it has always been, so a
 * per-model feature does not reformat every existing config file.
 */
function editDeclaration(
  path: string,
  agentId: string,
  mutate: (current: BillingDeclaration) => BillingDeclaration,
): Record<string, BillingDeclaration> {
  const id = agentId.trim()
  if (!id) throw new BillingModeError('agent id is required, got an empty agent id')
  const config = readConfigObject(path)
  // Untyped leftovers a hand-edited file may contain are carried over verbatim: this
  // function owns only the one declaration it was asked about.
  const raw =
    config.billing !== null && typeof config.billing === 'object' && !Array.isArray(config.billing)
      ? { ...(config.billing as Record<string, unknown>) }
      : {}
  const current = parseBillingModes({ billing: raw })[id] ?? NO_DECLARATION
  const next = mutate({ ...current, models: { ...current.models } })
  if (next.mode === null && next.planUsdPerMonth === null && Object.keys(next.models).length === 0) {
    delete raw[id]
  } else if (next.mode !== null && next.planUsdPerMonth === null && Object.keys(next.models).length === 0) {
    raw[id] = next.mode
  } else {
    raw[id] = {
      ...(next.mode !== null ? { mode: next.mode } : {}),
      ...(next.planUsdPerMonth !== null ? { planUsdPerMonth: next.planUsdPerMonth } : {}),
      ...(Object.keys(next.models).length > 0 ? { models: next.models } : {}),
    }
  }
  config.billing = raw
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return parseBillingModes(config)
}

/** Declare (`mode`) or undeclare (`null`) one agent's DEFAULT; per-model entries and the fee survive. */
export function writeBillingMode(
  path: string,
  agentId: string,
  mode: BillingMode | null,
): Record<string, BillingDeclaration> {
  const resolved = mode === null ? null : assertBillingMode(mode)
  return editDeclaration(path, agentId, (current) => ({ ...current, mode: resolved }))
}

/** Declare what the plan costs per calendar month; `null` undeclares it (which makes actual cash unknown, not $0). */
export function writeBillingPlanFee(
  path: string,
  agentId: string,
  planUsdPerMonth: number | null,
): Record<string, BillingDeclaration> {
  const fee = planUsdPerMonth === null ? null : parseFee(planUsdPerMonth)
  return editDeclaration(path, agentId, (current) => ({ ...current, planUsdPerMonth: fee }))
}

/**
 * Declare one model, or `null` to drop just that model's override back onto the agent default.
 * Throws rather than writing a mode for a model key nobody can produce, since the file gives no
 * way to tell `openai/gpt-5` from a mistyped `openai/gpt5`.
 */
export function writeBillingModelMode(
  path: string,
  agentId: string,
  modelKey: string,
  mode: BillingMode | null,
): Record<string, BillingDeclaration> {
  const key = modelKey.trim()
  if (!key.includes('/')) {
    throw new BillingModeError(`billing model key must be "<provider>/<name>", got ${JSON.stringify(modelKey)}`)
  }
  const resolved = mode === null ? null : assertBillingMode(mode)
  return editDeclaration(path, agentId, (current) => {
    const models = { ...current.models }
    if (resolved === null) delete models[key]
    else models[key] = resolved
    return { ...current, models }
  })
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
export function liveBillingModes(path: string): Record<string, BillingDeclaration> {
  let stamp = ''
  let cached: Record<string, BillingDeclaration> = {}
  const current = (): Record<string, BillingDeclaration> => {
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
  return new Proxy({} as Record<string, BillingDeclaration>, {
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
