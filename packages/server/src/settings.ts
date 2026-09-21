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
  liveBillingModes,
  writeBillingMode,
  type BillingMode,
} from '@agentlens/pricing'
import { ApiError } from './errors.ts'
import { redactHome, rowsOf } from './resolve.ts'

export interface BillingAgentRow {
  agentId: string
  displayName: string | null
  /** The mode the cost figures are folded with right now. */
  billingMode: BillingMode
  /** False for the unset ones: the UI must tell a default apart from a declaration. */
  declared: boolean
}

export interface BillingView {
  configFile: string
  modes: Record<string, BillingMode>
  agents: BillingAgentRow[]
}

export interface BillingWriteResult {
  agent: string
  /** The effective mode after the write: clearing lands back on the `api` default. */
  mode: BillingMode
  modes: Record<string, BillingMode>
}

export class BillingSettings {
  private readonly modes: Record<string, BillingMode>

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
    return {
      configFile: redactHome(this.configPath, this.homedir),
      modes: { ...this.modes },
      agents: [...ids].sort().map((agentId) => ({
        agentId,
        displayName: meta.get(agentId) ?? null,
        billingMode: this.modes[agentId] ?? 'api',
        declared: agentId in this.modes,
      })),
    }
  }

  /** Declare (`mode`) or undeclare (`mode: null`); throws ApiError for anything unsupported. */
  declare(body: unknown): BillingWriteResult {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw ApiError.badRequest('body must be a JSON object: {"agent": "<id>", "mode": "api | subscription | local" | null}')
    }
    const raw = body as { agent?: unknown; mode?: unknown }
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
    // The union lives in @agentlens/pricing; catching its error lets the message name the
    // legal set while the status stays a 400 the UI can show (§9's error contract).
    let mode: BillingMode | null
    if (raw.mode === null || raw.mode === undefined) {
      mode = null
    } else {
      try {
        mode = assertBillingMode(raw.mode)
      } catch (err) {
        throw ApiError.badRequest(`${(err as Error).message}, or null to drop the declaration`)
      }
    }
    const modes = writeBillingMode(this.configPath, agent, mode)
    return { agent, mode: modes[agent] ?? 'api', modes }
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
