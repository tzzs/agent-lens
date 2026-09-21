/**
 * Read-only helpers for the diagnostic routes (§11).
 *
 * Adapter *loading* deliberately does not live here (§5.4): the server declares no
 * dependency on any adapter package, and a variable-specifier `import` from this
 * package would resolve to nothing and swallow the error — which is how the web
 * Doctor came to contradict `agl doctor`. The CLI injects its adapter set through
 * `ServerDeps.adapters` instead, so both ends walk the same five adapters.
 * Detection stays strictly read-only — this tool reads private logs and must
 * never touch them (§5.2 rule 3).
 */
import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs'
import type { HostContext } from '@agentlens/event-model'

/** Read-only HostContext (§5.1); `dataRoot` narrows a scan to one agent's store. */
export function hostContext(opts: { homedir: string; env?: NodeJS.ProcessEnv; dataRoot?: string | null }): HostContext {
  const dataRoot = opts.dataRoot ?? null
  return {
    dataRoot,
    homedir: opts.homedir,
    env: opts.env ?? {},
    async readFile(path: string) {
      return readFileSync(path, 'utf8')
    },
    async readDir(path: string) {
      return readdirSync(path)
    },
    async stat(path: string) {
      try {
        const st = statSync(path)
        return { size: st.size, mtimeMs: st.mtimeMs, inode: st.ino }
      } catch {
        return null
      }
    },
  }
}

export function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}
