/**
 * `sessionDetail` namespace — every string this page shows. Owners: see the page file
 * beside it; `en` is the wording the terminal and the API docs also quote, so
 * reword it with the §14 rule in mind, not casually.
 *
 * Deliberately absent: the event-kind chip labels (they come from `eventKinds()`),
 * a cost figure's own basis tooltip (`viz.*` / `fmt.*`, built by `CostFigure`),
 * the loading/error frame (`states.*`, built by `StatePanel`) and everything the
 * API still sends whole — `session.title`, `contentNote`, `explain` and the
 * request error text — which stay the server's words in every locale.
 *
 * `notFoundLead` / `notFoundTail` are one English sentence split around the
 * `<span class="nums">` that carries the requested id: the id must keep its own
 * typeface, so the page owns the middle of the sentence and the catalog both ends
 * — including the space English needs before its verb, which the value carries
 * because Chinese must not gain one before its full stop.
 */
import { matches } from '../index.ts'

const en = {
  title: 'Session',
  unavailable: 'Session unavailable',
  backSessions: 'Sessions',
  loadingTimeline: 'Loading timeline',

  /* the 404 / 409 frames */
  ambiguousMatches: 'The id prefix matched more than one session — pick one:',
  notFoundLead: 'No session id (or prefix)',
  notFoundTail: ' exists in this database.',

  /* header */
  untitled: 'Untitled {agent} session',
  copyIdTitle: 'Copy full session id: {id}',

  /* the six metric tiles */
  tileAgent: 'Agent',
  tileProject: 'Project',
  tileStarted: 'Started (UTC)',
  tileEvents: 'Events',
  tileTokens: 'Tokens',
  tileActive: 'Active',
  activeWithSpan: '{metric} Wall clock, first event to last: {span}.',
  metricsOnly: 'Metrics-only timeline.',

  /* the filter row */
  filterByKind: 'Filter by event kind',
  allEvents: 'All events',
  searchAria: 'Search events',
  searchPlaceholder: 'Search tools, models, types…',
  collapseAll: 'Collapse all',
  expandAll: 'Expand all',

  /* the waterfall */
  colEvent: 'Event',
  shownOf: '· {n} shown',
  colDur: 'Dur.',
  colTokens: 'Tokens',
  colTime: 'Time',
  noMatch: 'No events match these filters.',
  noEvents: 'This session has no events.',
  listAria: 'Session events',
  estCost: 'Est. cost',
  keysHint: '· ↑↓ to move, ←→ to fold, Esc to close',
  orphansTitle:
    'These rows do carry parent_event_id; the parent is simply outside the session being shown — a subagent thread, or another source of the same conversation. Nothing is missing (§4.4).',
  orphansNote: '{n} event(s) hang from a parent outside this session, so they sit at the top level here',
  explainSummary: 'How these totals were derived',
}

const zh = matches(en)({
  title: '会话',
  unavailable: '会话不可用',
  backSessions: '会话',
  loadingTimeline: '正在加载时间线',

  ambiguousMatches: '该 id 前缀匹配到了多个会话——请选择其中一个：',
  notFoundLead: '本数据库中不存在会话 id（或前缀）',
  notFoundTail: '。',

  untitled: '未命名 {agent} 会话',
  copyIdTitle: '复制完整会话 id：{id}',

  tileAgent: 'Agent',
  tileProject: '项目',
  tileStarted: '开始时间（UTC）',
  tileEvents: '事件',
  tileTokens: 'token 用量',
  tileActive: '活跃时长',
  activeWithSpan: '{metric}挂钟时间为 {span}（从首条事件到最后一条）。',
  metricsOnly: '仅有指标的时间线。',

  filterByKind: '按事件类型筛选',
  allEvents: '全部事件',
  searchAria: '搜索事件',
  searchPlaceholder: '搜索工具、模型、类型…',
  collapseAll: '全部折叠',
  expandAll: '全部展开',

  colEvent: '事件',
  shownOf: '· 已显示 {n} 条',
  colDur: '时长',
  colTokens: 'token',
  colTime: '时间',
  noMatch: '没有事件符合这些筛选条件。',
  noEvents: '这个会话没有任何事件。',
  listAria: '会话事件',
  estCost: '估算费用',
  keysHint: '· ↑↓ 移动，←→ 折叠汇总，Esc 关闭',
  orphansTitle:
    '这些行确实带有 parent_event_id；只是父事件不在当前展示的这段会话里——可能是一条子代理线程，或同一场对话的另一个数据源。并没有内容缺失（§4.4）。',
  orphansNote: '有 {n} 个事件挂在本次会话之外的父事件上，因此在这里显示在顶层',
  explainSummary: '这些合计是怎么得出的',
})

export default { en, zh }
