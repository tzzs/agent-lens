/**
 * Bounded recursive file walker used by adapters' `discover()` (§5.1).
 * Deterministic (sorted) traversal so fixtures and idempotency tests are stable;
 * symlinks are never followed, so a log root cannot trap us in a cycle.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface WalkOptions {
  /** RegExp, or a glob with `*` (any chars except `/`) and `?` matched against the file name. */
  pattern: RegExp | string
  /** ms epoch; skip files whose mtime is older than this. */
  since?: number
  followSymlinks?: false
}

export async function* walkForFiles(root: string, opts: WalkOptions): AsyncIterable<string> {
  const re = toRegExp(opts.pattern)
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // vanished or unreadable mid-walk: nothing to discover here
    }
    const dirs: string[] = []
    for (const ent of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (ent.isSymbolicLink()) continue
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        dirs.push(full)
      } else if (ent.isFile() && re.test(ent.name)) {
        if (opts.since !== undefined) {
          try {
            const s = await stat(full)
            if (s.mtimeMs < opts.since) continue
          } catch {
            continue
          }
        }
        yield full
      }
    }
    // push reversed so the DFS pops in sorted order
    for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i]!)
  }
}

function toRegExp(pattern: RegExp | string): RegExp {
  if (pattern instanceof RegExp) return pattern
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  return new RegExp(`^${body}$`)
}
