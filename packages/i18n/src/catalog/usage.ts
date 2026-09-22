/**
 * `usage` namespace — every string this page shows. Owners: see the page file
 * beside it; `en` is the wording the terminal and the API docs also quote, so
 * reword it with the §14 rule in mind, not casually.
 *
 * Deliberately absent: the cube's wire vocabulary as the page sends and echoes it
 * (`metrics=events,tokens_total`, `order: metric:events:desc`), the `explain` block
 * the server writes (§7), the row values themselves (agent ids, hosts, capability
 * names, `ok`/`error` statuses) and `api.ts`'s `'(unnamed)'` disclosure — those are
 * data, not copy. The window clause nests as `{window}` for the same reason: only
 * the words around the raw §7 `since` value (`30d`) translate, never the value.
 *
 * `metrics.*` and `dims.*` are the ONE place a field name is allowed to read
 * differently: English repeats the wire name verbatim, so a gloss changes no
 * request, no response and no English pixel. Wherever a label stops matching the
 * field name the header carries that name in its tooltip, because a user who is
 * told「缓存读 tokens」still has to be able to find `tokens_cache_read` in the
 * explain block and in §7.
 */
import { matches } from '../index.ts'

const en = {
  title: 'Usage',
  explorerTitle: 'Usage explorer',
  pageDesc: 'Pick metrics, dimensions and filters to query the usage cube directly. {window}',
  windowLast: 'Window: last {since}.',
  windowAll: 'Window: all time.',
  pageInfo:
    "This page is the query cube itself — every other page is a fixed slice of it (§7). The server's own account of each query is shown under the result.",

  /* the two pickers */
  metricsTitle: 'Metrics',
  dimsTitle: 'Dimensions',
  selectedCount: '{n} selected',
  groupActivity: 'Activity',
  groupTokens: 'Tokens',
  groupCost: 'Cost',
  groupTime: 'Time',
  groupScope: 'Scope',
  groupModel: 'Model',
  groupCapability: 'Capability',
  groupCapabilityName: 'Capability name',
  capabilityNameNote: 'restricts rows to that kind',
  groupOther: 'Other',

  /* the filter fields */
  filtersTitle: 'Filters',
  filtersInfo: "Only the header's time range applies on this page; agent and status are chosen here.",
  statusLabel: 'Status',
  anyStatus: 'Any status',
  statusOk: 'OK',
  statusError: 'Error',
  statusUnknown: 'Unknown',
  orderLabel: 'Order',
  orderOr: 'or',
  limitLabel: 'Row limit',
  limitHint: '0–5,000. Totals always cover every matching event.',

  /* the result and its states */
  loadingText: 'Running the query',
  failedTitle: 'Query failed.',
  failedTail: 'the table below is the last successful result.',
  noMatchTitle: 'No event can match.',
  noMatchBody: 'This capability dimension contradicts the capability-type filter, so the query was not run.',
  selectOneMetric: 'Select at least one metric.',
  rowCount: '{n, plural, one {{n} row} other {{n} rows}}',
  totals: 'Totals',
  totalsInfo:
    'Totals are computed over every matching event, not just the rows shown: they include rows cut by the limit, and distinct counts such as sessions are not column sums.',
  caption: 'Query result',
  emptyNoRows: 'No rows for this spec',
  emptyNoDim: 'No dimension selected — the totals row below is the whole result',
  rowsRestricted: 'Rows restricted to capability type {dims} · {trunc}',
  truncatedByLimit: 'truncated by limit',
  notTruncated: 'not truncated',
  truncatedNote: 'Truncated by limit',
  howTitle: 'How this was computed',
  howInfo: 'The query the server actually ran, verbatim (§7 explain).',

  /** Cube metrics, keyed by the field name in camelCase. */
  metrics: {
    events: 'events',
    sessions: 'sessions',
    duration: 'duration',
    tokensTotal: 'tokens_total',
    tokensInput: 'tokens_input',
    tokensOutput: 'tokens_output',
    tokensCacheRead: 'tokens_cache_read',
    tokensCacheWrite: 'tokens_cache_write',
    tokensReasoning: 'tokens_reasoning',
    costApiEquiv: 'cost_api_equiv',
    costReported: 'cost_reported',
  },

  /** Cube dimensions, same rule. */
  dims: {
    time: 'time',
    day: 'day',
    week: 'week',
    month: 'month',
    agent: 'agent',
    host: 'host',
    project: 'project',
    session: 'session',
    thread: 'thread',
    model: 'model',
    provider: 'provider',
    capabilityType: 'capability_type',
    capabilityName: 'capability_name',
    tool: 'tool',
    skill: 'skill',
    mcp: 'mcp',
    plugin: 'plugin',
    connector: 'connector',
    command: 'command',
    subagent: 'subagent',
    hook: 'hook',
    status: 'status',
    usageSource: 'usage_source',
  },
}

const zh = matches(en)({
  title: '用量',
  explorerTitle: '用量查询',
  pageDesc: '自选指标、维度与筛选条件，直接查询用量立方体。{window}',
  windowLast: '时间窗：最近 {since}。',
  windowAll: '时间窗：全部历史。',
  pageInfo:
    '本页面就是查询立方体本身——其他每个页面都只是它的一个固定切片（§7）。每次查询由服务器自己给出的说明会显示在结果下方。',

  metricsTitle: '指标',
  dimsTitle: '维度',
  selectedCount: '已选 {n} 项',
  groupActivity: '活动',
  groupTokens: 'token',
  groupCost: '费用',
  groupTime: '时间',
  groupScope: '范围',
  groupModel: '模型',
  groupCapability: '能力',
  groupCapabilityName: '能力名称',
  capabilityNameNote: '会把数据行限定在该类型内',
  groupOther: '其他',

  filtersTitle: '筛选',
  filtersInfo: '本页面只套用顶栏的时间窗；agent 与状态在这里选择。',
  statusLabel: '状态',
  anyStatus: '任意状态',
  statusOk: '正常',
  statusError: '错误',
  statusUnknown: '未知',
  orderLabel: '排序',
  orderOr: '或',
  limitLabel: '行数上限',
  limitHint: '0–5,000。合计始终覆盖全部匹配的事件。',

  loadingText: '正在执行查询',
  failedTitle: '查询失败。',
  failedTail: '下表仍是上一次成功的结果。',
  noMatchTitle: '不可能有任何事件匹配。',
  noMatchBody: '所选的能力维度与能力类型筛选互相矛盾，因此没有执行该查询。',
  selectOneMetric: '请至少选择一个指标。',
  rowCount: '共 {n} 行',
  totals: '合计',
  totalsInfo:
    '合计是对全部匹配事件计算的，不只是列出的这些行：其中包含被行数上限截掉的行；而会话数这类别名去重计数并不是各列相加。',
  caption: '查询结果',
  emptyNoRows: '该查询条件没有匹配到任何行',
  emptyNoDim: '未选择维度——下方的合计行就是全部结果',
  rowsRestricted: '数据行已限定在能力类型 {dims} 内 · {trunc}',
  truncatedByLimit: '已被行数上限截断',
  notTruncated: '未被截断',
  truncatedNote: '已被行数上限截断',
  howTitle: '这些数字是怎么算出来的',
  howInfo: '服务器实际执行的查询，原样展示（§7 explain）。',

  metrics: {
    events: '事件数',
    sessions: '会话数',
    duration: '时长',
    tokensTotal: 'tokens 总量',
    tokensInput: '输入 tokens',
    tokensOutput: '输出 tokens',
    tokensCacheRead: '缓存读 tokens',
    tokensCacheWrite: '缓存写 tokens',
    tokensReasoning: '推理 tokens',
    costApiEquiv: '估算费用',
    costReported: '上报费用',
  },

  dims: {
    time: '时间',
    day: '按天',
    week: '按周',
    month: '按月',
    agent: 'agent',
    host: '主机',
    project: '项目',
    session: '会话',
    thread: '线程',
    model: '模型',
    provider: '提供商',
    capabilityType: '能力类型',
    capabilityName: '能力名称',
    tool: '工具',
    skill: '技能',
    mcp: 'MCP',
    plugin: '插件',
    connector: '连接器',
    command: '命令',
    subagent: '子代理',
    hook: '钩子',
    status: '状态',
    usageSource: '用量来源',
  },
})

export default { en, zh }
