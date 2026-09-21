/**
 * THE one place adapters are wired (§5.4: cli -> query -> storage; adapters are
 * optional satellites). Loaded dynamically so a missing adapter package degrades
 * to "no adapters installed" instead of crashing the CLI.
 */
import type { AgentAdapter, AggregationPolicy } from '@agentlens/event-model'

const OPTIONAL_ADAPTER_PACKAGES = [
  '@agentlens/adapter-claude-code',
  '@agentlens/adapter-codex',
  '@agentlens/adapter-qoder',
  '@agentlens/adapter-opencode',
  '@agentlens/adapter-workbuddy',
  '@agentlens/adapter-pi',
] as const

function isAdapter(value: unknown): value is AgentAdapter {
  if (!value || typeof value !== 'object') return false
  const a = value as Record<string, unknown>
  return typeof a['id'] === 'string' && typeof a['detect'] === 'function' && typeof a['normalize'] === 'function'
}

/** Any export of the package that quacks like an adapter; `default` wins so a package that
 *  re-exports helpers cannot accidentally register a sibling object. */
function pickAdapter(mod: Record<string, unknown>): AgentAdapter | undefined {
  if (isAdapter(mod['default'])) return mod['default']
  return Object.values(mod).find(isAdapter)
}

export async function getAdapters(): Promise<AgentAdapter[]> {
  const adapters: AgentAdapter[] = []
  for (const pkg of OPTIONAL_ADAPTER_PACKAGES) {
    try {
      // Variable specifier on purpose: a static import would make the missing
      // package a build-time error; here it is a runtime no-op.
      const mod = (await import(/* @vite-ignore */ pkg)) as Record<string, unknown>
      const candidate = pickAdapter(mod)
      if (candidate) adapters.push(candidate)
    } catch {
      // adapter package not installed — expected for agents this machine lacks
    }
  }
  return adapters
}

/**
 * §18 row 2: each adapter declares how its own logs fold into token totals. A package
 * that omits the declaration is a gap §5.2 forbids — silently falling back to
 * `request_max` is exactly what doubles Codex-style cumulative usage.
 */
export class AdapterContractError extends Error {}

export function adapterAggregations(adapters: readonly AgentAdapter[]): Record<string, AggregationPolicy> {
  const out: Record<string, AggregationPolicy> = {}
  for (const adapter of adapters) {
    if (!adapter.aggregation) {
      throw new AdapterContractError(`adapter ${adapter.id} declares no aggregation policy (§18)`)
    }
    out[adapter.id] = adapter.aggregation
  }
  return out
}
