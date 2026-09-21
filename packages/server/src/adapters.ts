/**
 * Optional adapter access for the diagnostic routes.
 *
 * Adapters are satellites (§5.4): they are loaded through a variable specifier so
 * a missing package is a runtime no-op rather than a build error, and the server
 * keeps zero compile-time edges to them (the CLI wires the same list for `agl
 * doctor`). Detection is strictly read-only — this tool reads private logs and
 * must never touch them (§5.2 rule 3).
 */
import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs'
import type { AgentAdapter, HostContext } from '@agentlens/event-model'

const OPTIONAL_ADAPTER_PACKAGES = ['@agentlens/adapter-claude-code'] as const

export async function loadAdapters(): Promise<AgentAdapter[]> {
  const out: AgentAdapter[] = []
  for (const pkg of OPTIONAL_ADAPTER_PACKAGES) {
    try {
      const mod = (await import(/* @vite-ignore */ pkg)) as Record<string, unknown>
      const candidate = (mod['default'] ?? mod['adapter'] ?? mod['claudeCodeAdapter']) as AgentAdapter | undefined
      if (candidate && typeof candidate.discover === 'function' && typeof candidate.normalize === 'function') out.push(candidate)
    } catch {
      // adapter package not installed — expected in a server-only build
    }
  }
  return out
}

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
