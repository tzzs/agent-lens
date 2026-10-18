/**
 * §5.3 "the store moved and the logs stayed" — variant data roots.
 *
 * Model-switching tools (CC Switch, local gateways, a hand-written `alias claude='CLAUDE_CONFIG_DIR=~/.claude-deepseek claude'`)
 * do not merge into the canonical store: they point one agent at a *second* data root with the
 * same layout and its own session files. Reading only `~/.claude` therefore reports a smaller
 * world than the machine actually ran, and every such root is invisible to a gateway that only
 * sees traffic routed through itself.
 *
 * The rule here is deliberately narrow, because a wrong root is worse than a missed one:
 *
 * 1. **Same shape, not same name.** A candidate is a sibling directory of the canonical root
 *    (same parent, name starts with `<base>` — `~/.claude-deepseek`, `~/.codex.work`) and it
 *    must contain the layout marker this adapter names. `~/.claude-backup` that holds only
 *    `settings.json` is not a store; `~/.claude-deepseek` with `projects/**\/*.jsonl` is.
 * 2. **Never a guess.** An unreadable parent, a symlink loop, or a directory that merely shares
 *    the prefix is skipped, not reported as empty — `discover` returning no sources for it is
 *    indistinguishable from "this root was never used", which would hide the very gap this
 *    file exists to close.
 * 3. **Explicit wins, and is exclusive.** `CLAUDE_CONFIG_DIR`/`CODEX_HOME` already means "this
 *    is the store"; when set, variants are not scanned. The user pointed somewhere on purpose.
 * 4. **Deterministic order.** Sorted by path so `source_id` enumeration, fixture tests and two
 *    replays agree (§4.2).
 *
 * `doctor` gets the same list through `Detection.variantRoots`, so a machine with two roots is
 * a sentence on screen rather than a silent 98 MB hole.
 */
import { basename, dirname, join } from 'node:path'
import type { HostContext } from './adapter.ts'

/** Directories whose names are store-shaped but never a live variant root. */
const NEVER_VARIANTS = new Set(['backup', 'backups', 'bak', 'old', 'tmp', 'temp', 'cache', 'node_modules'])

export interface VariantRootsInput {
  /** The canonical root this adapter would read if nothing else existed. */
  canonical: string
  /** True when the canonical path came from an upstream env switch (exclusive, rule 3). */
  fromEnv: boolean
  /**
   * The layout marker that makes a sibling a store: paths *relative to the candidate root*,
   * each of which must exist (a directory or a file — `ctx.stat` answers both).
   */
  markers: readonly string[]
  /**
   * Suffixes that are known to belong to the agent itself rather than a variant, e.g. `-ide`
   * for Antigravity's IDE companion, or `-cn` for a regional build. Matched case-insensitively
   * against the part after `<base>`, with or without a leading `-`/`.`/`_`.
   */
  notVariants?: readonly string[]
}

/**
 * List the sibling data roots of `canonical` that hold the agent's own layout.
 * Never throws: an unreadable parent yields `[]` plus a reason.
 */
export async function variantRoots(
  ctx: HostContext,
  input: VariantRootsInput,
): Promise<{ roots: string[]; skipped: { path: string; reason: string }[] }> {
  const skipped: { path: string; reason: string }[] = []
  if (input.fromEnv) return { roots: [], skipped }

  const canonical = input.canonical.replace(/[\\/]+$/, '')
  const base = basename(canonical)
  if (!base) return { roots: [], skipped }
  const parent = dirname(canonical)

  let entries: string[]
  try {
    entries = await ctx.readDir(parent)
  } catch (err) {
    // Rule 2: "I could not look" is not "there is nothing there".
    skipped.push({ path: parent, reason: `unreadable parent: ${String(err)}` })
    return { roots: [], skipped }
  }

  const lowerBase = base.toLowerCase()
  const notVariants = new Set((input.notVariants ?? []).map((s) => s.toLowerCase()))
  const candidates: string[] = []
  for (const name of entries) {
    if (name === base) continue
    const lower = name.toLowerCase()
    if (!lower.startsWith(lowerBase)) continue
    const suffix = lower.slice(lowerBase.length).replace(/^[-._]/, '')
    // `<base>` itself and `<base>-something` both count; `baseball` does not.
    if (lower !== lowerBase && !/^[-._]/.test(lower.slice(lowerBase.length))) continue
    if (suffix !== '' && (notVariants.has(suffix) || NEVER_VARIANTS.has(suffix))) continue
    candidates.push(join(parent, name))
  }
  candidates.sort()

  const roots: string[] = []
  for (const candidate of candidates) {
    const holds = await hasLayout(ctx, candidate, input.markers)
    if (holds.ok) roots.push(candidate)
    else if (holds.reason !== null) skipped.push({ path: candidate, reason: holds.reason })
  }
  return { roots, skipped }
}

async function hasLayout(
  ctx: HostContext,
  root: string,
  markers: readonly string[],
): Promise<{ ok: true } | { ok: false; reason: string | null }> {
  if (markers.length === 0) return { ok: false, reason: null }
  for (const marker of markers) {
    let st: { size: number; mtimeMs: number; inode: number } | null
    try {
      st = await ctx.stat(join(root, marker))
    } catch (err) {
      return { ok: false, reason: `unreadable layout marker ${marker}: ${String(err)}` }
    }
    if (st === null) return { ok: false, reason: null }
  }
  return { ok: true }
}

/**
 * Every root this adapter should read, canonical first. Callers that only need to iterate
 * (`discover`, `detect`, `capabilities`) use this instead of a bare `rootOf`.
 */
export async function rootsOf(
  ctx: HostContext,
  canonical: string,
  fromEnv: boolean,
  input: Omit<VariantRootsInput, 'canonical' | 'fromEnv'>,
): Promise<string[]> {
  const { roots } = await variantRoots(ctx, { canonical, fromEnv, ...input })
  return [canonical, ...roots]
}

/** `true` when `root` is not the canonical one — used to label a source's provenance. */
export function isVariant(canonical: string, root: string): boolean {
  return root.replace(/[\\/]+$/, '') !== canonical.replace(/[\\/]+$/, '')
}
