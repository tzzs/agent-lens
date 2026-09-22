/**
 * `sessions` namespace — every string this page shows. Owners: see the page file
 * beside it; `en` is the wording the terminal and the API docs also quote, so
 * reword it with the §14 rule in mind, not casually.
 *
 * Deliberately absent: session ids, titles, agent ids, host names and project
 * paths — those are the viewer's own data, shown verbatim in every locale, and
 * the search box filters on them, so translating them would break the match.
 */
import { matches } from '../index.ts'

const en = {
  title: 'Sessions',
  description: 'Most recent first. Open one for its waterfall timeline.',
  loading: 'Loading sessions',
  contentOff: 'Content layer is off — session details will be metrics-only.',

  // Filter row
  filterByAgent: 'Filter by agent',
  searchLabel: 'Search sessions',
  searchPlaceholder: 'Search title, id, project…',

  // Table columns
  colSession: 'Session',
  colAgent: 'Agent',
  colProject: 'Project',
  colEvents: 'Events',
  colTokens: 'Tokens',
  colActive: 'Active',
  colCost: 'Est. cost',
  colCostInfo: 'Tokens × list price. {na} when the model has no price — never $0.',
  colLast: 'Last seen',

  // Rows and the states around them
  untitled: 'Untitled {agent} session',
  noDurations: 'No event in this session reported a duration of its own',
  wallClockTitle: 'Wall clock, first event to last',
  emptyFiltered: 'No sessions match these filters',
  emptyWindow: 'No sessions in this window',
  showing: 'Showing {n} of {total} sessions{tail}.',
  // The limit is the page's own `limit: 100` query, so the number is wording here.
  showingTailTruncated: ' — the 100 most recent; narrow the range or agent to see older ones',
}

const zh = matches(en)({
  title: '会话',
  description: '最近的排在最前，点开任意一行看它的瀑布式时间线。',
  loading: '正在加载会话',
  contentOff: '内容层已关闭——会话详情只有指标数据。',

  filterByAgent: '按 agent 筛选',
  searchLabel: '搜索会话',
  searchPlaceholder: '搜索标题、id、项目…',

  colSession: '会话',
  colAgent: 'Agent',
  colProject: '项目',
  colEvents: '事件',
  colTokens: 'token',
  colActive: '活跃时长',
  colCost: '估算费用',
  colCostInfo: 'tokens × 牌价。模型没有价格时显示为{na}，绝不显示 $0。',
  colLast: '最近活动',

  untitled: '未命名 {agent} 会话',
  noDurations: '这个会话里没有任何事件上报过自己的时长',
  wallClockTitle: '挂钟时间：从首条事件到最后一条',
  emptyFiltered: '没有符合这些筛选条件的会话',
  emptyWindow: '这个时间窗内没有会话',
  showing: '共 {total} 个会话，当前显示 {n} 个{tail}。',
  showingTailTruncated: '（只有最近 100 个，可缩小时间范围或只选一个 agent 来看更早的）',
})

export default { en, zh }
