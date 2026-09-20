/**
 * THE one place adapters are wired (§5.4: cli -> query -> storage; adapters are
 * optional satellites). Loaded dynamically so a missing adapter package degrades
 * to "no adapters installed" instead of crashing the CLI.
 */
import type { AgentAdapter } from '@agentlens/event-model'

const OPTIONAL_ADAPTER_PACKAGES = ['@agentlens/adapter-claude-code'] as const

export async function getAdapters(): Promise<AgentAdapter[]> {
  const adapters: AgentAdapter[] = []
  for (const pkg of OPTIONAL_ADAPTER_PACKAGES) {
    try {
      // Variable specifier on purpose: a static import would make the missing
      // package a build-time error; here it is a runtime no-op.
      const mod = (await import(/* @vite-ignore */ pkg)) as Record<string, unknown>
      const candidate = (mod['default'] ?? mod['adapter'] ?? mod['claudeCodeAdapter']) as AgentAdapter | undefined
      if (candidate && typeof candidate.discover === 'function' && typeof candidate.normalize === 'function') {
        adapters.push(candidate)
      }
    } catch {
      // adapter package not installed — expected until M1 lands
    }
  }
  return adapters
}
