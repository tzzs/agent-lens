/**
 * Hand-rolled argv parser — commander is deliberately NOT a dependency (§13:
 * zero-dep ambition; the plan's "commander" row is overridden by the task's
 * hard constraint).
 *
 * Grammar:
 *   agentlens <word...> [--flag value | --flag=value | --boolean-flag | -h] [positional...]
 *   - leading bare words form the command path; later bare words are positionals
 *   - `--flag value` and `--flag=value` both bind a `value`/`repeat` flag
 *   - `repeat` flags accumulate into a string[]; comma-splitting happens in FlagView.list()
 *   - `--` ends flag parsing; everything after it is positional
 *   - unknown flags / value flags without a value are UsageError (exit code 2)
 */

export type FlagKind = 'boolean' | 'value' | 'repeat'

export interface FlagDef {
  kind: FlagKind
  aliases?: string[]
}

export type FlagSchema = Record<string, FlagDef>

export class UsageError extends Error {
  override readonly name = 'UsageError'
}

export type RawFlags = Record<string, boolean | string | string[]>

export interface ParsedArgs {
  /** Bare words in order: command path first, then positionals. */
  words: string[]
  flags: FlagView
}

export class FlagView {
  // Plain fields (no parameter properties): `node --experimental-strip-types` is
  // strip-only and rejects them, and that is how this bin ships.
  private readonly raw: RawFlags
  private readonly schema: FlagSchema

  constructor(raw: RawFlags, schema: FlagSchema) {
    this.raw = raw
    this.schema = schema
  }

  private def(name: string): FlagDef {
    const d = this.schema[name]
    if (!d) throw new Error(`flag ${name} is not in the schema`) // programmer error, not user error
    return d
  }

  bool(name: string): boolean {
    return this.raw[name] === true
  }

  str(name: string): string | undefined {
    const v = this.raw[name]
    if (typeof v === 'string') return v
    if (Array.isArray(v)) return v[v.length - 1]
    return undefined
  }

  /** Number flag; UsageError when unparsable. */
  num(name: string): number | undefined {
    const s = this.str(name)
    if (s === undefined) return undefined
    const n = Number(s)
    if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} expects a non-negative number, got ${JSON.stringify(s)}`)
    return n
  }

  list(name: string): string[] {
    const v = this.raw[name]
    if (v === undefined || typeof v === 'boolean') return []
    const items = (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(','))
    return items.map((s) => s.trim()).filter((s) => s.length > 0)
  }
}

export function parseArgs(argv: readonly string[], schema: FlagSchema): ParsedArgs {
  const aliasIndex = new Map<string, string>() // long name or short alias -> canonical long name
  for (const [name, def] of Object.entries(schema)) {
    aliasIndex.set(name, name)
    for (const a of def.aliases ?? []) aliasIndex.set(a, name)
  }

  const words: string[] = []
  const raw: RawFlags = {}
  let i = 0
  let endOfFlags = false
  while (i < argv.length) {
    const tok = argv[i]!
    if (endOfFlags || !tok.startsWith('-')) {
      words.push(tok)
      i++
      continue
    }
    if (tok === '--') {
      endOfFlags = true
      i++
      continue
    }
    let body = tok.slice(tok.startsWith('--') ? 2 : 1)
    let inlineValue: string | undefined
    const eq = body.indexOf('=')
    if (eq >= 0) {
      inlineValue = body.slice(eq + 1)
      body = body.slice(0, eq)
    }
    const canonical = aliasIndex.get(body)
    if (!canonical) throw new UsageError(`unknown flag: ${tok}`)
    const def = schema[canonical]!
    if (def.kind === 'boolean') {
      if (inlineValue !== undefined) {
        if (!/^(true|false|1|0)$/.test(inlineValue)) throw new UsageError(`--${canonical} is a boolean flag; got ${JSON.stringify(inlineValue)}`)
        raw[canonical] = inlineValue === 'true' || inlineValue === '1'
      } else {
        raw[canonical] = true
      }
      i++
      continue
    }
    let value = inlineValue
    if (value === undefined) {
      const next = argv[i + 1]
      if (next === undefined || (next.startsWith('--') && next !== '--')) {
        throw new UsageError(`flag --${canonical} requires a value`)
      }
      value = next
      i += 2
    } else {
      i++
    }
    if (def.kind === 'value') raw[canonical] = value
    else {
      const cur = (raw[canonical] as string[] | undefined) ?? []
      cur.push(value)
      raw[canonical] = cur
    }
  }
  return { words, flags: new FlagView(raw, schema) }
}

/** The one schema shared by every subcommand; per-command relevance is documented in --help. */
export const CLI_FLAG_SCHEMA: FlagSchema = {
  help: { kind: 'boolean', aliases: ['h'] },
  version: { kind: 'boolean', aliases: ['V'] },
  db: { kind: 'value' },
  serve: { kind: 'boolean' },
  interval: { kind: 'value' },
  'no-content': { kind: 'boolean' },
  explain: { kind: 'boolean' },
  agent: { kind: 'repeat' },
  host: { kind: 'repeat' },
  project: { kind: 'repeat' },
  session: { kind: 'repeat' },
  model: { kind: 'repeat' },
  provider: { kind: 'repeat' },
  status: { kind: 'repeat' },
  type: { kind: 'repeat' },
  since: { kind: 'value' },
  until: { kind: 'value' },
  by: { kind: 'repeat' },
  limit: { kind: 'value' },
  format: { kind: 'value' },
  'older-than': { kind: 'value' },
  // pricing override
  input: { kind: 'value' },
  output: { kind: 'value' },
  'cache-read': { kind: 'value' },
  'cache-write': { kind: 'value' },
  reasoning: { kind: 'value' },
  'effective-from': { kind: 'value' },
}
