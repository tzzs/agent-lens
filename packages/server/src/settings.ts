/**
 * §8's "let the user declare a billing mode per Agent", server side.
 *
 * The route writes the very file the CLI's `billingModeFor` reads
 * (`<dir of --db>/config.json`, via @agentlens/pricing's store), and reads it back
 * through the same live view — so the dashboard cannot end up reporting a mode the
 * terminal denies (§14). No new dependency, no new storage: the declaration is one
 * small JSON document the user may also hand-edit.
 */
import type { DatabaseSync } from 'node:sqlite'
import {
  assertBillingMode,
  billingModeFor,
  billingModelKey,
  isBillingMode,
  liveBillingModes,
  parseModelKey,
  planFeeFor,
  writeBillingMode,
  writeBillingModelMode,
  writeBillingPlanFee,
  type BillingDeclaration,
  type BillingMode,
} from '@agentlens/pricing'
import { ApiError } from './errors.ts'
import { redactHome, rowsOf } from './resolve.ts'

export interface BillingModelRow {
  /** The `"<provider>/<name>"` key the declaration is stored under. */
  key: string
  provider: string
  model: string
  /** What a cost figure for THIS model folds with: its override, else the agent default. */
  effectiveMode: BillingMode
  /** False when the row answers with the agent default — the UI must not paint that as a choice. */
  overridden: boolean
}

export interface BillingAgentRow {
  agentId: string
  displayName: string | null
  /** The mode the cost figures are folded with right now. */
  billingMode: BillingMode
  /** False for the unset ones: the UI must tell a default apart from a declaration. */
  declared: boolean
  /** What the plan is declared to cost per calendar month; null = undeclared. */
  planUsdPerMonth: number | null
  /** The models this agent actually has events for, each with the mode that prices it. */
  models: BillingModelRow[]
}

export interface BillingView {
  configFile: string
  modes: Record<string, BillingDeclaration>
  agents: BillingAgentRow[]
}

export interface BillingWriteResult {
  agent: string
  /** The effective default after the write: clearing lands back on the `api` default. */
  mode: BillingMode
  planUsdPerMonth: number | null
  /** Present only when the write targeted one model. */
  model?: { key: string; mode: BillingMode }
  modes: Record<string, BillingDeclaration>
}

export class BillingSettings {
  private readonly modes: Record<string, BillingDeclaration>

  constructor(
    private readonly db: DatabaseSync,
    readonly configPath: string,
    private readonly homedir: string,
  ) {
    this.modes = liveBillingModes(configPath)
  }

  /** Known agents, plus any declaration kept for an agent not ingested (yet). */
  view(): BillingView {
    const ids = new Set<string>([
      ...rowsOf(this.db, 'SELECT id FROM agents ORDER BY id').map((r) => String(r.id)),
      ...Object.keys(this.modes),
    ])
    const meta = new Map(
      rowsOf(this.db, 'SELECT id, display_name FROM agents').map((r) => [String(r.id), r.display_name ? String(r.display_name) : null]),
    )
    // Only models the store has events for are offered: a declaration against a name nobody
    // ever ran is inert, and offering it invites the user to spend a choice on nothing.
    const seen = new Map<string, { provider: string; model: string }[]>()
    for (const r of rowsOf(
      this.db,
      `SELECT DISTINCT e.agent_id AS a, m.provider AS p, m.name AS n
         FROM events e JOIN models m ON m.rowid = e.model_rowid
        WHERE e.agent_id IS NOT NULL AND m.name IS NOT NULL
        ORDER BY p, n`,
    )) {
      const list = seen.get(String(r.a)) ?? []
      list.push({ provider: String(r.p ?? ''), model: String(r.n ?? '') })
      seen.set(String(r.a), list)
    }
    return {
      configFile: redactHome(this.configPath, this.homedir),
      modes: { ...this.modes },
      agents: [...ids].sort().map((agentId) => {
        const declaration = this.modes[agentId]
        const defaultMode = billingModeFor(this.modes, agentId)
        return {
          agentId,
          displayName: meta.get(agentId) ?? null,
          billingMode: defaultMode,
          declared: declaration?.mode != null || Object.keys(declaration?.models ?? {}).length > 0,
          planUsdPerMonth: planFeeFor(this.modes, agentId),
          models: (seen.get(agentId) ?? []).map(({ provider, model }) => ({
            key: billingModelKey(provider, model),
            provider,
            model,
            effectiveMode: billingModeFor(this.modes, agentId, provider, model),
            overridden: billingModeFor(this.modes, agentId, provider, model) !== defaultMode,
          })),
        }
      }),
    }
  }

  /**
   * Declare a default (`mode`), a plan fee (`planUsdPerMonth`) or one model
   * (`model` + `mode`); `null` on any of them undeclares that one thing and leaves the rest.
   * Throws ApiError for anything unsupported.
   */
  declare(body: unknown): BillingWriteResult {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw ApiError.badRequest(
        'body must be a JSON object: {"agent": "<id>", "mode": "api | subscription | local" | null} (optionally "model": "<provider>/<name>", or "planUsdPerMonth": <number> | null)',
      )
    }
    const raw = body as { agent?: unknown; mode?: unknown; model?: unknown; planUsdPerMonth?: unknown }
    if (typeof raw.agent !== 'string' || raw.agent.trim() === '') {
      throw ApiError.badRequest('"agent" must be a non-empty agent id')
    }
    const agent = raw.agent.trim()
    const known = new Set<string>([...rowsOf(this.db, 'SELECT id FROM agents').map((r) => String(r.id)), ...Object.keys(this.modes)])
    if (!known.has(agent)) {
      throw ApiError.notFound(`unknown agent ${JSON.stringify(agent)}`, {
        knownAgents: [...known].sort(),
        hint: 'declare only agents AgentLens knows; a typo would silently change no number',
      })
    }
    const isModelWrite = typeof raw.model === 'string'
    const isFeeWrite = raw.planUsdPerMonth !== undefined
    if (isModelWrite && !isBillingMode(raw.mode)) {
      throw ApiError.badRequest('a model write needs "mode": one of api | subscription | local, or null to drop that model\'s override')
    }
    // The union lives in @agentlens/pricing; catching its error lets the message name the
    // legal set while the status stays a 400 the UI can show (§9's error contract).
    let mode: BillingMode | null = null
    if (!isFeeWrite) {
      if (raw.mode === null || raw.mode === undefined) {
        mode = null
      } else {
        try {
          mode = assertBillingMode(raw.mode)
        } catch (err) {
          throw ApiError.badRequest(`${(err as Error).message}, or null to drop the declaration`)
        }
      }
    }
    try {
      if (isFeeWrite) {
        const fee = raw.planUsdPerMonth
        if (fee !== null && (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0)) {
          throw ApiError.badRequest('"planUsdPerMonth" must be a non-negative number, or null to undeclare the fee')
        }
        const modes = writeBillingPlanFee(this.configPath, agent, fee as number | null)
        return { agent, mode: billingModeFor(modes, agent), planUsdPerMonth: planFeeFor(modes, agent), modes }
      }
      if (isModelWrite) {
        const key = (raw.model as string).trim()
        const modes = writeBillingModelMode(this.configPath, agent, key, mode)
        return {
          agent,
          mode: billingModeFor(modes, agent),
          planUsdPerMonth: planFeeFor(modes, agent),
          model: { key, mode: billingModeFor(modes, agent, ...parseModelKey(key)) },
          modes,
        }
      }
      const modes = writeBillingMode(this.configPath, agent, mode)
      return { agent, mode: billingModeFor(modes, agent), planUsdPerMonth: planFeeFor(modes, agent), modes }
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw ApiError.badRequest((err as Error).message)
    }
  }
}

/** Parses the POST body; a malformed body is the caller's error (400), not ours (500). */
export async function readJsonBody(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json()
  } catch (err) {
    throw ApiError.badRequest(`request body must be JSON: ${(err as Error).message}`)
  }
}
