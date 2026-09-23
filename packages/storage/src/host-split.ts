/**
 * §14: one host-split fact, decided once. The CLI warned only above an 80% share with a
 * 20-event floor and skipped a host that merely repeats the agent's own name; the served
 * banner fired above 50% with none of those guards — so a measured 73.4% split warned in the
 * browser and stayed silent in the terminal, and the two numbers users are told to trust came
 * with two different degrees of alarm.
 *
 * The thresholds are not averaged into a third rule. There are two genuinely different
 * statements here, and they need different evidence:
 *
 *  - **warn** ("your mental model of this agent is probably wrong"): rare and cheap to ignore,
 *    so it has to be loud-and-rare — a dominant host at ≥80%, at least two hosts, enough
 *    events to mean something, and not the degenerate case where the host id equals the agent
 *    id (a single-host adapter writes that shape, and calling it a split would be false).
 *  - **split** ("this view is broken down by host"): a display fact, true of any view with a
 *    majority host, so it fires at >50% — and it must never read as a warning, because nearly
 *    every multi-host agent has a majority.
 *
 * Both are computed from the same ranked shares so the number quoted in either sentence is the
 * same number.
 */

/** Per-host event counts for one agent, as stored. */
export interface HostCount {
  host: string
  events: number
}

export interface HostShare extends HostCount {
  /** 0 when the agent has no events at all. */
  share: number
}

/** Ranked dominant-first, so a caller can render the same order everywhere. */
export function rankHostShares(counts: readonly HostCount[]): HostShare[] {
  const total = counts.reduce((sum, c) => sum + c.events, 0)
  return counts
    .map((c) => ({ host: c.host, events: c.events, share: total === 0 ? 0 : c.events / total }))
    .sort((a, b) => b.events - a.events || (a.host < b.host ? -1 : 1))
}
/**
 * A single-host agent has nothing to split and nothing to warn about. Exported
 * because the phrasing of the banner depends on it and the rule must not be
 * re-decided by whichever surface renders the numbers.
 */
export const isDegenerateHost = (agentId: string, host: string) => host === agentId || host === '(none)' || host === ''

export interface HostSplit {
  agentId: string
  hosts: HostShare[]
  dominant: HostShare
  /** Dominant host is a bare majority — worth splitting the view, not worth an alarm. */
  splittable: boolean
  /** The §11/§14 warning condition. */
  warnable: boolean
}

export const HOST_WARN_MIN_EVENTS = 20
export const HOST_WARN_SHARE = 0.8

/**
 * The decision for one agent. `splittable` at >0.5 with a second host present; `warnable`
 * only on the stricter rule, so the terminal and the browser raise the same alarm on the same
 * store at the same moment.
 */
export function hostSplitFor(agentId: string, counts: readonly HostCount[]): HostSplit | null {
  // A host with no events is a label the store mentions, not a population: counting it as the
  // second half of a "split" would turn a single-host agent into a reported distortion.
  const hosts = rankHostShares(counts.filter((c) => c.events > 0))
  if (hosts.length < 2) return null
  const total = hosts.reduce((sum, h) => sum + h.events, 0)
  const dominant = hosts[0]!
  const noise = isDegenerateHost(agentId, dominant.host)
  return {
    agentId,
    hosts,
    dominant,
    // A second population is all a split needs; the host named after the agent itself is still
    // real traffic. Only the *warning* cares about that degenerate case, because "90% of
    // claude-code came from claude-code" is a tautology rather than a distortion.
    splittable: dominant.share > 0.5,
    warnable: !noise && total >= HOST_WARN_MIN_EVENTS && dominant.share >= HOST_WARN_SHARE,
  }
}

/**
 * Across agents: the warning names the one with the highest dominant share (the CLI's old
 * tie-break was by share, kept deliberately — the loudest distortion is the one worth a line),
 * the split note names the busiest, because that is the view the user is actually looking at.
 */
export function pickHostWarning(splits: readonly (HostSplit | null)[]): HostSplit | null {
  let best: HostSplit | null = null
  for (const s of splits) {
    if (!s || !s.warnable) continue
    if (best && best.dominant.share >= s.dominant.share) continue
    best = s
  }
  return best
}

export function pickHostSplit(splits: readonly (HostSplit | null)[]): HostSplit | null {
  let best: HostSplit | null = null
  let bestEvents = 0
  for (const s of splits) {
    if (!s || !s.splittable) continue
    const total = s.hosts.reduce((sum, h) => sum + h.events, 0)
    if (total <= bestEvents) continue
    bestEvents = total
    best = s
  }
  return best
}

/** The one sentence both surfaces say. `where` differs only in whose records they are. */
export function hostSplitSentence(split: HostSplit, noun = 'records'): string {
  const others = split.hosts.slice(1).map((h) => h.host).join(', ')
  return (
    `${(split.dominant.share * 100).toFixed(1)}% of ${split.agentId} ${noun} came from ` +
    `${split.dominant.host}, not ${others || 'the other host'}`
  )
}

/**
 * The gentler "this view is broken down by host" sentence. When the dominant host carries the
 * agent's own name (`host_id = 'claude-code'` beside `claude-desktop`), the warning phrasing
 * above turns into "90% of claude-code came from claude-code" — a tautology on screen when it is
 * really the minority that surprises people. Said from the minority instead, the same share
 * stays informative without pretending to be an alarm.
 */
export function hostSplitNotice(split: HostSplit, noun = 'records'): string {
  if (!isDegenerateHost(split.agentId, split.dominant.host)) return hostSplitSentence(split, noun)
  const detail = split.hosts
    .slice(1)
    .map((h) => `${h.host} ${(h.share * 100).toFixed(1)}%`)
    .join(', ')
  return `${(split.dominant.share * 100).toFixed(1)}% of ${split.agentId} ${noun} are its own host, the rest is ${detail || 'nowhere'}`
}
