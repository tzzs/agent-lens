/**
 * §2 Machine tier — the per-install identity minted by migration `005_machine.sql`.
 *
 * The id is a random UUIDv4 living in a singleton `machine` row INSIDE the database file:
 *  - it travels with the data, so a future merge of two AgentLens stores can attribute
 *    rows to the install that produced them without re-attributing anything;
 *  - it is never a hostname (they collide and leak identity) and never a personal
 *    identifier (§16 privacy posture: the tool is local, no telemetry);
 *  - per-event machine attribution is deliberately DEFERRED (§19): on a single machine
 *    every row belongs to the one machine, and `host_id` (§18 row 6) already splits
 *    CLI vs desktop on it. A per-row column would be a schema change against the §15 M5
 *    freeze that buys nothing until a second machine can share a store.
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export interface MachineIdentity {
  /** UUIDv4, minted once per database file. */
  readonly id: string
  /** Epoch ms of the mint — the `Date.now()` of the FIRST process that touched an empty table. */
  readonly mintedAt: number
}

/** The stored machine id, or null when none has been minted yet (fresh or read-only store). */
export function getMachineId(db: DatabaseSync): string | null {
  const row = db.prepare('SELECT id FROM machine WHERE slot = 0').get() as { id: string } | undefined
  return row ? String(row.id) : null
}

/**
 * Read the machine id, minting it on first call. The INSERT is
 * `ON CONFLICT DO NOTHING`, so two processes racing on a fresh store both converge on
 * the row that won the conflict — the id is minted exactly once per database (§4.2's
 * idempotence instinct applied to identity).
 * Throws if the `machine` table is absent (pre-005 store — call `migrate()` first) or
 * the database is opened read-only and the table is still empty; use
 * {@link readMachineId} for a never-throwing, non-minting read.
 */
export function ensureMachineId(db: DatabaseSync): MachineIdentity {
  db.prepare('INSERT INTO machine (slot, id, minted_at) VALUES (0, ?, ?) ON CONFLICT (slot) DO NOTHING').run(
    randomUUID(),
    Date.now(),
  )
  const row = db.prepare('SELECT id, minted_at FROM machine WHERE slot = 0').get() as {
    id: string
    minted_at: number
  }
  return { id: String(row.id), mintedAt: Number(row.minted_at) }
}

/** Non-minting read for openers that may hold the db read-only. */
export function readMachineId(db: DatabaseSync): string | null {
  try {
    return getMachineId(db)
  } catch {
    return null // table not present (pre-005) — absence is not an error worth leaking
  }
}
