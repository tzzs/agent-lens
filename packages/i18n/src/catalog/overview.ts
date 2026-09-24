/**
 * `overview` namespace — every string this page shows. Owners: see the page file
 * beside it; `en` is the wording the terminal and the API docs also quote, so
 * reword it with the §14 rule in mind, not casually.
 *
 * Deliberately absent: the cost-card `basis` note and the capability names on the
 * bars, which are the server's own strings and stay verbatim in every locale, and
 * `{gran}`, the query's granularity token (`day` / `week` / `month`) that the
 * trend rows are keyed by — a data key, like an event type, is not a word.
 */
import { matches } from '../index.ts'

const en = {
  title: 'Overview',
  description: 'Tokens, cost and activity across every local agent.',
  info: 'Tokens are de-duplicated per request_id (MAX per request, then SUM — §3.1). Trend bucket: {gran}.',
  updated: 'Updated {time} UTC',
  loading: 'Crunching the overview',

  // Tokens card — its breakdown rows are `viz.token*`, the inspector uses the same words.
  tokens: 'Tokens',

  // Cost card
  cost: 'Cost',
  costInfo: "Actual is what the run cost: the agent's own reported figure where it logs one, otherwise priced tokens folded through its billing mode, so a subscription or local model spends $0 (§8, §18). est. is the same tokens at API list price.",
  apiEquivalent: 'API equivalent',
  agentReported: 'Agent-reported',
  noPricing: 'No price table — cost is {na}.',
  noPriceFor: 'No price for {agents}',
  noPriceForTitle:
    'The tokens these agents spent on models with no price are left out of the totals, which are therefore a floor — the priced part of the same window is still counted.',
  noPrice: 'no price',

  // Sessions and events cards
  sessions: 'Sessions',
  sessionsActive: 'Active in the selected window',
  events: 'Events',
  eventsInfo: 'Metric-layer rows — every message, tool call, hook fire and lifecycle event.',
  perSessionAvg: '{n} per session on average',
  deltaInfo: 'Last half of the window vs its first half',

  // Charts: a Surface title, its subtitle, and the `label` the chart reads out
  tokenTrend: 'Token trend',
  tokenTrendSubtitle: 'Total tokens per {gran}',
  tokensPer: 'Tokens per {gran}',
  tokensByAgent: 'Tokens by agent',
  costTrend: 'Est. cost trend',
  costTrendSubtitle: 'API-equivalent $ per {gran} — an estimate, not cash',
  estCostPer: 'Estimated cost per {gran}',
  eventTrend: 'Event trend',
  eventTrendSubtitle: 'Metric events per {gran}',
  eventsPer: 'Events per {gran}',
  capabilityEvents: 'Capability events',
  capabilityEventsSubtitle: 'Tool, skill, MCP, hook … calls',
  totalNote: '{dur} total',
  tokensByProject: 'Tokens by project',
  tokensByProjectInfo: 'Projects are folded across agents and worktrees. Unnamed projects show a short id; hover for the full value.',
  activityMix: 'Activity mix',
  activityMixSubtitle: 'Capability and signal counts in the window',

  // The activity feed's rows are keyed by the API (`tool`, `skill`, …). A key with
  // no entry here prints itself, so a new server-side counter is never hidden.
  capTool: 'tool',
  capSkill: 'skill',
  capMcp: 'mcp',
  capPlugin: 'plugin',
  capConnector: 'connector',
  capCommand: 'command',
  capSubagent: 'subagent',
  capHook: 'hook',
  capCompact: 'compact',
  capErrors: 'errors',

  contentOff: 'Content layer is off — session timelines are metrics-only. Token, cost and capability numbers here are unaffected (§3.2).',
}

const zh = matches(en)({
  title: '总览',
  description: '本机所有 agent 的 token、费用与活动。',
  info: 'token 已按 request_id 去重（每个请求取 MAX，再求 SUM，§3.1 不变量）。趋势分桶：{gran}。',
  updated: '更新于 {time} UTC',
  loading: '正在汇总总览数据',

  tokens: 'token 用量',

  cost: '费用',
  costInfo: '实际就是这个任务花掉的钱：agent 自己的日志里有上报数字时就用它，否则把已定价的 token 按它声明的计费模式折算，所以订阅制或本地模型的花费是 $0（§8、§18）。估算则是同样的 token 按 API 牌价算出的金额。',
  apiEquivalent: 'API 等效费用',
  agentReported: 'agent 上报',
  noPricing: '没有价格表——费用只能显示为{na}。',
  noPriceFor: '{agents} 无价格',
  noPriceForTitle: '这些 agent 花在「没有价格的模型」上的 token 未计入合计，因此合计只是一个下限——同一窗口里能计价的部分仍然算在内。',
  noPrice: '无价格',

  sessions: '会话',
  sessionsActive: '在所选时间窗内活跃',
  events: '事件',
  eventsInfo: '指标层的行——每条消息、每次工具调用、每次 hook 触发与每个生命周期事件。',
  perSessionAvg: '平均每个会话 {n} 个事件',
  deltaInfo: '时间窗后半段相对前半段的变化',

  tokenTrend: 'token 趋势',
  tokenTrendSubtitle: '每 {gran} 的 token 合计',
  tokensPer: '每 {gran} 的 token',
  tokensByAgent: '按 agent 看 token',
  costTrend: '估算费用趋势',
  costTrendSubtitle: '每 {gran} 的 API 等效金额（$）——是估算，不是现金',
  estCostPer: '每 {gran} 的估算费用',
  eventTrend: '事件趋势',
  eventTrendSubtitle: '每 {gran} 的指标事件数',
  eventsPer: '每 {gran} 的事件数',
  capabilityEvents: '能力调用事件',
  capabilityEventsSubtitle: '工具、skill、MCP、hook 等调用的次数',
  totalNote: '合计 {dur}',
  tokensByProject: '按项目看 token',
  tokensByProjectInfo: '项目会跨 agent 与 worktree 合并统计；没有名字的项目显示短 id，悬停可看完整值。',
  activityMix: '活动构成',
  activityMixSubtitle: '时间窗内的能力与信号计数',

  capTool: '工具',
  capSkill: '技能',
  capMcp: 'MCP',
  capPlugin: '插件',
  capConnector: '连接器',
  capCommand: '命令',
  capSubagent: '子代理',
  capHook: '钩子',
  capCompact: '压缩',
  capErrors: '错误',

  contentOff: '内容层已关闭——会话时间线只有指标数据。这里的 token、费用与能力数字不受影响（§3.2）。',
})

export default { en, zh }
