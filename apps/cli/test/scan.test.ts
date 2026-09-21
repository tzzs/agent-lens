/**
 * How the §18 row 7 refusals reach the terminal: one line per store, never one per
 * source, and never the path twice. Plus the §6 privacy default behind them.
 */
import { describe, expect, it } from 'vitest'
import { parseArgs, CLI_FLAG_SCHEMA } from '../src/args.ts'
import { contentWanted, refusalLines, type ScanOutcome, type SourceRefusal } from '../src/commands/scan.ts'

const flags = (...argv: string[]) => parseArgs(argv, CLI_FLAG_SCHEMA).flags

const refusal = (agentId: string, path: string): SourceRefusal => ({
  agentId,
  path,
  reason: `refusing to open "${path}": it is in WAL mode, and even a read-only connection can create or replay its -wal/-shm sidecars (§18 row 7).`,
})

const outcome = (refusals: SourceRefusal[]): ScanOutcome => ({
  adaptersFound: 1,
  sourcesScanned: refusals.length,
  events: 0,
  failures: 0,
  notDetected: [],
  refusals,
})

const HOME = '/home/me'
const OPENCODE_DB = `${HOME}/.local/share/opencode/opencode.db`

describe('the content layer default (§6)', () => {
  it('is off unless the run asks for it', () => {
    expect(contentWanted(flags('scan'))).toBe(false)
    expect(contentWanted(flags('scan', '--no-content'))).toBe(false)
    expect(contentWanted(flags('scan', '--content'))).toBe(true)
    // An explicit global opt-out outranks a per-run opt-in.
    expect(contentWanted(flags('scan', '--content', '--no-content'))).toBe(false)
  })
})

describe('refusalLines', () => {
  it('collapses the sources that share one store into a single line', () => {
    const lines = refusalLines(outcome([refusal('opencode', OPENCODE_DB), refusal('opencode', OPENCODE_DB), refusal('opencode', OPENCODE_DB)]), { homedir: HOME })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('opencode ~/.local/share/opencode/opencode.db not read (3 sources)')
    // The line already names the store, so the reason must not repeat it.
    expect(lines[0]?.match(/opencode\.db/g)).toHaveLength(1)
    expect(lines[0]).toContain('WAL mode')
    expect(lines[0]).not.toContain(HOME) // §11: the absolute home directory stays out of output
  })

  it('keeps distinct stores as distinct lines', () => {
    const lines = refusalLines(outcome([refusal('opencode', `${HOME}/a.db`), refusal('codex', `${HOME}/b.db`)]), { homedir: HOME })
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l.split(' ')[1])).toEqual(['opencode', 'codex'])
    expect(lines.every((l) => !l.includes('(2 sources)'))).toBe(true)
  })
})
