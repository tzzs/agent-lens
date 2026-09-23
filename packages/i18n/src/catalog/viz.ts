/**
 * Chart and timeline furniture: axes, legends, tooltips, waterfall rows and the
 * cost figure's basis labels. Owned by `apps/web/src/components/**` except the
 * ones the pages themselves pass in.
 *
 * Composition rules the copy has to keep: a chart's `label` is an aria-name, the
 * cost titles are one sentence per basis plus an optional "at least this much"
 * tail, and an unpriced figure never renders as `$0` (§8) — so the "n/a" wording
 * stays `common.na` and only the sentences around it translate.
 */
import { matches } from '../index.ts'

const en = {
  // Shared by Bars, Donut and Sparkline.
  peak: 'peak',
  noDataInRange: 'No data in range',
  total: 'total',

  // Donut
  donutBreakdown: 'breakdown',
  donutAria: '{label}: total {v}',

  // Sparkline
  sparkTrend: 'trend',
  sparkAria: '{label} — arrow keys step through points',
  gapsIn: '{na} in {n}',

  // TimelineRow — one waterfall row
  expandChildren: '{n, plural, one {Expand {n} child event} other {Expand {n} child events}}',
  collapseChildren: '{n, plural, one {Collapse {n} child event} other {Collapse {n} child events}}',

  // NodeInspector
  closeDetails: 'Close details',
  fieldType: 'Type',
  fieldTime: 'Time',
  fieldDuration: 'Duration',
  fieldStatus: 'Status',
  fieldModel: 'Model',
  fieldCapability: 'Capability',
  fieldProvider: 'Provider',
  fieldRequest: 'Request',
  fieldUsageSource: 'Usage source',
  fieldError: 'Error',
  fieldEventId: 'Event id',
  tokenInput: 'Input',
  tokenOutput: 'Output',
  tokenCacheRead: 'Cache read',
  tokenCacheWrite: 'Cache write',
  tokenReasoning: 'Reasoning',
  tokensHeading: 'Tokens',
  contentHeading: 'Content',
  contentOff: 'Content layer is off — metrics only for this event.',
  loadingContent: 'Loading this event’s content…',
  noContentLogged: 'This event logged no content.',
  metadataLabel: 'Metadata',

  // Payload
  payloadTruncated: 'truncated',
  payloadTruncatedTitle: 'Stored text was capped at 20k characters',
  payloadKindUserMessage: 'user message',
  payloadKindAssistantMessage: 'assistant message',
  payloadKindToolInput: 'tool input',
  payloadKindToolOutput: 'tool output',
  payloadKindReasoning: 'reasoning',

  // CostFigure — the basis a cost number carries
  costLabelEst: 'est.',
  costLabelActual: 'actual',
  costLabelReported: 'reported',
  costTitleEst: 'Computed estimate: tokens × list price (cost_api_equiv). Not a cash figure.',
  costTitleActual: 'Actual cash after the declared billing mode — subscription and local models spend 0 (§8).',
  costTitleReported: "Cost the agent logged for itself (§18 row 1): only where an agent's own log carries the figure, so which agents report is a fact about the data, not a fixed list; every other cost here falls back to the computed estimate (est.).",
  costTitlePartial: 'At least this much: some agents have no price and are excluded.',
  costTitleNoPrice: 'No price available for this model — shown as n/a, never $0 (§8).',
}

const zh = matches(en)({
  peak: '峰值',
  noDataInRange: '该范围内没有数据',
  total: '合计',

  donutBreakdown: '分类占比',
  donutAria: '{label}：合计 {v}',

  sparkTrend: '趋势',
  sparkAria: '{label}——方向键可逐点查看',
  gapsIn: '{n} 个时间桶为“{na}”',

  expandChildren: '展开 {n} 个子事件',
  collapseChildren: '折叠 {n} 个子事件',

  closeDetails: '关闭详情',
  fieldType: '类型',
  fieldTime: '时间',
  fieldDuration: '时长',
  fieldStatus: '状态',
  fieldModel: '模型',
  fieldCapability: '能力',
  fieldProvider: '提供方',
  fieldRequest: '请求',
  fieldUsageSource: '用量来源',
  fieldError: '错误',
  fieldEventId: '事件 id',
  tokenInput: '输入',
  tokenOutput: '输出',
  tokenCacheRead: '缓存读',
  tokenCacheWrite: '缓存写',
  tokenReasoning: '推理',
  tokensHeading: 'token 用量',
  contentHeading: '内容',
  contentOff: '内容层已关闭——此事件仅有指标。',
  loadingContent: '正在加载该事件的内容…',
  noContentLogged: '该事件没有记录任何内容。',
  metadataLabel: '元数据',

  payloadTruncated: '已截断',
  payloadTruncatedTitle: '存储的文本在 20k 字符处被截断',
  payloadKindUserMessage: '用户消息',
  payloadKindAssistantMessage: '助手消息',
  payloadKindToolInput: '工具输入',
  payloadKindToolOutput: '工具输出',
  payloadKindReasoning: '推理',

  costLabelEst: '估算',
  costLabelActual: '实际',
  costLabelReported: '上报',
  costTitleEst: '计算出的估算值：tokens × 牌价（cost_api_equiv），不是现金数字。',
  costTitleActual: '按已声明的计费模式算出的实际现金支出——订阅制与本地模型的花费为 0（§8）。',
  costTitleReported: 'agent 自己记录的费用（§18 第 1 行）：只有当某个 agent 自己的日志里带着这个费用数字时才用，所以哪些 agent 会上报是数据本身的事实，而不是一份固定清单；此处其他所有费用都会退回计算出的估算值（估算）。',
  costTitlePartial: '至少这么多：部分 agent 没有价格，已从合计中排除。',
  costTitleNoPrice: '该模型暂无价格——显示为未定价，绝不显示 $0（§8）。',
})

export default { en, zh }
