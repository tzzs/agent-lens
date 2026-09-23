/**
 * `projects` namespace — every string this page shows. Owners: see the page file
 * beside it; `en` is the wording the terminal and the API docs also quote, so
 * reword it with the §14 rule in mind, not casually.
 *
 * Deliberately absent: project names, canonical roots, observed paths, agent ids,
 * model names, event-type strings and the `+N` overflow chip — all data, not copy.
 * The server's grouping `note`, each session's own `title` and the request error
 * text stay the server's words in every locale; the refresh-failure frame is
 * reused from `states.*`, and a cost figure's own basis tooltip belongs to
 * `CostFigure` (`viz.*` / `fmt.*`).
 *
 * `count` carries the English one/other agreement the page used to do by hand
 * (`rows.length === 1 && !truncated`), which is why the truncated case is its own
 * message: "1,234+ projects" is never singular.
 */
import { matches } from '../index.ts'

const en = {
  title: 'Projects',
  count: '{n, plural, one {{n} project} other {{n} projects}}',
  countPlus: '{n}+ projects',
  desc: '{count} in this window, grouped across agents and worktrees.',
  pageDesc: 'Grouped across agents and worktrees.',
  loadingProjects: 'Loading projects',
  empty: 'No projects in this window',

  /* the table */
  colProject: 'Project',
  colAgents: 'Agents',
  colAgent: 'Agent',
  colSessions: 'Sessions',
  colTokens: 'Tokens',
  colEstCost: 'Est. cost',
  costColumnInfo: 'Tokens × list price. n/a when a model has no price — never $0.',
  noRoot: 'No repo root recorded',
  tokensTitle: '{n} tokens',

  /* a project's expanded detail */
  byAgent: 'By agent',
  byAgentAria: 'Usage by agent',
  noAgentActivity: 'No agent activity in this window',
  recentSessions: 'Recent sessions',
  untitled: 'Untitled',
  noSessions: 'No sessions recorded',
  models: 'Models',
  modelChipTitle: '{model} · {tokens} tokens · {events} events',
  noModelCalls: 'No model calls in this window',
  capabilities: 'Capabilities',
  capabilityChipTitle: '{n} {type} {n, plural, one {event} other {events}}',
  noCapabilityCalls: 'No capability calls in this window',
  observedCwds: 'Observed working directories ({n})',
  observedCwdsNote:
    'Every path below resolved to this project — the evidence for folding worktrees and subdirectories into one row. Busiest first; event counts cover all recorded history, not just this window.',
  eventsCount: '{n, plural, one {{n} event} other {{n} events}}',

  /* the §4.1 truncation tail */
  truncatedNote:
    'Showing {n} projects; more were active in this window — narrow the range or agent filter to see the rest.',
}

const zh = matches(en)({
  title: '项目',
  count: '{n} 个项目',
  countPlus: '{n}+ 个项目',
  desc: '{count}，统计自本时间窗，已按 agent 与 worktree 归并分组。',
  pageDesc: '已按 agent 与 worktree 归并分组。',
  loadingProjects: '正在加载项目',
  empty: '这个时间窗内没有项目',

  colProject: '项目',
  colAgents: 'Agents',
  colAgent: 'Agent',
  colSessions: '会话',
  colTokens: 'token',
  colEstCost: '估算费用',
  costColumnInfo: 'tokens × 牌价。模型没有价格时显示为未定价，绝不会是 $0。',
  noRoot: '未记录仓库根目录',
  tokensTitle: '{n} 个 token',

  byAgent: '按 agent 统计',
  byAgentAria: '按 agent 区分的用量',
  noAgentActivity: '这个时间窗内没有 agent 活动',
  recentSessions: '最近的会话',
  untitled: '未命名',
  noSessions: '未记录任何会话',
  models: '模型',
  modelChipTitle: '{model} · {tokens} 个 token · {events} 个事件',
  noModelCalls: '这个时间窗内没有模型调用',
  capabilities: '能力调用',
  capabilityChipTitle: '{n} 个 {type} 事件',
  noCapabilityCalls: '这个时间窗内没有能力调用',
  observedCwds: '观测到的工作目录（{n} 个）',
  observedCwdsNote:
    '下面每个路径都归到了这个项目——正是把 worktree 与子目录折叠汇总成一行的依据。按繁忙程度排在前面；事件数量覆盖全部已记录历史，不只是当前时间窗。',
  eventsCount: '{n} 个事件',

  truncatedNote: '这里只显示 {n} 个项目；这个时间窗内还有更多项目在活动——缩小时间范围或 agent 筛选即可看到其余部分。',
})

export default { en, zh }
