/**
 * `agents` namespace — every string this page shows. Owners: see the page file
 * beside it; `en` is the wording the terminal and the API docs also quote, so
 * reword it with the §14 rule in mind, not casually.
 *
 * Deliberately absent: agent ids, display names and host names, model ids, the
 * billing-mode key an undeclared mode falls back to (`api`, `subscription`, …),
 * and the percentages and figures themselves — `share()`'s `<1%` and `—` are
 * number glyphs, not words.
 *
 * `word*` keys label a capability *type* inside a chip and inside its title. The
 * page printed the raw type id before, so the English values stay lower case
 * except `MCP`, the one spelling the sibling Capabilities page already overrides.
 * A plural message selects its English form from a numeric argument and prints the
 * pre-grouped string, so a locale switch never changes how a number reads.
 */
import { matches } from '../index.ts'

const en = {
  title: 'Agents',
  pageDesc: 'Every local agent, split by host.',
  pageInfo:
    "Host is part of an agent's identity (§18 item 6), so each card shows its own host split. Est. cost is tokens × list price — an estimate, not cash, and n/a when a model has no price. An agent with nothing in the window says so instead of showing zeros (§14).",
  loading: 'Loading agents',

  /* the two empty states */
  noMatch: 'No agent matches the agent filter',
  noneDetected: 'No agents detected on this machine yet',
  hiddenByFilter:
    '{n, plural, one {{s} other known agent is} other {{s} other known agents are}} hidden by the agent filter.',

  /* billing mode, declared per agent (§8) */
  billingApi: 'API',
  billingSubscription: 'Subscription',
  billingLocal: 'Local',
  billingApiNote: 'billed per token, so est. cost is the cash figure',
  billingSubscriptionNote:
    'flat plan: actual cash is $0, while est. cost prices the same tokens as an API call',
  billingLocalNote:
    'nothing bills per token: actual cash is $0, while est. cost prices the same tokens as an API call (§8)',
  billingFallbackNote: 'est. cost is the API equivalent',
  billingTitle: 'Billing mode these figures use — declare it in Settings › Billing modes. {note}',

  /* the four-up stat strip */
  sessions: 'Sessions',
  events: 'Events',
  tokens: 'Tokens',
  estCost: 'Est. cost',
  duration: 'Duration',
  durationInfo:
    'Summed time of recorded events (model calls, tool runs), each request counted once — not wall-clock time.',
  noDurations: 'No event durations recorded',
  sessionsTitle: '{n, plural, one {{s} session} other {{s} sessions}}',
  eventsTitle: '{n, plural, one {{s} event} other {{s} events}}',
  tokensTitle: '{n, plural, one {{s} token} other {{s} tokens}}',

  /* the breakdown toggle and its three sections */
  breakdown: 'Breakdown',
  hostsCount: '{n, plural, one {{s} host} other {{s} hosts}}',
  capabilitiesCount: '{n, plural, one {{s} capability} other {{s} capabilities}}',
  modelsCount: '{n, plural, one {{s} model} other {{s} models}}',
  hostOne: 'Host {host}',
  hostsHeading: 'Hosts',
  hostsCaption: 'Sessions and events per host for {name}',
  colHost: 'Host',
  colShare: 'Share',
  shareInfo: "Share of this agent's events",
  capabilitiesHeading: 'Capabilities',
  modelsHeading: 'Models',
  modelsCaption: 'Tokens and estimated cost per model for {name}',
  colModel: 'Model',
  viewSessions: 'View sessions →',

  /* capability type on a card */
  wordTool: 'tool',
  wordSkill: 'skill',
  wordMcp: 'MCP',
  wordPlugin: 'plugin',
  wordConnector: 'connector',
  wordCommand: 'command',
  wordSubagent: 'subagent',
  wordHook: 'hook',
  capEvents: '{n, plural, one {{s} {type} event} other {{s} {type} events}}',
  capErrorTail: ', {n} with an error status',
  errorsCount: '{n, plural, one {{s} error} other {{s} errors}}',

  /* an agent known but idle in the window (§14) */
  notRecorded: 'Not recorded in this window',
  notRecordedTitle:
    'Known to AgentLens, but it logged no events in the selected range — shown instead of a row of zeros.',
  hostFilterLine: 'Host filter: {hosts}',
}

const zh = matches(en)({
  title: 'Agents',
  pageDesc: '本机的每个 agent，按主机拆分。',
  pageInfo:
    '主机是 agent 身份的一部分（§18 第 6 条），因此每张卡片都显示自己的主机拆分。估算成本是 tokens × 牌价——一个估算值，不是现金；模型没有定价时显示“未定价”。本时间窗内没有记录的 agent 会直接说明，而不是一排零（§14）。',
  loading: '正在加载 agents',

  noMatch: '没有 agent 符合当前的 agent 筛选条件',
  noneDetected: '这台机器上还未检测到任何 agent',
  hiddenByFilter: '另有 {s} 个已知 agent 因 agent 筛选条件而被隐藏。',

  billingApi: 'API',
  billingSubscription: '订阅制',
  billingLocal: '本地',
  billingApiNote: '按 token 计费，因此估算成本就是现金支出',
  billingSubscriptionNote: '固定套餐：实际现金支出为 $0，而估算成本按同样的 tokens 调用 API 的价格计',
  billingLocalNote: '没有任何东西按 token 计费：实际现金支出为 $0，而估算成本按同样的 tokens 调用 API 的价格计（§8）',
  billingFallbackNote: '估算成本为其 API 等价金额',
  billingTitle: '这些数字所用的计费模式——请在“设置 › 计费模式”中声明。{note}',

  sessions: '会话',
  events: '事件',
  tokens: 'token 数',
  estCost: '估算成本',
  duration: '时长',
  durationInfo: '已记录事件的时长之和（模型调用、工具运行），每个请求只计一次——不是墙上时钟时间。',
  noDurations: '未记录到事件时长',
  sessionsTitle: '{s} 个会话',
  eventsTitle: '{s} 个事件',
  tokensTitle: '{s} 个 token',

  breakdown: '明细',
  hostsCount: '{s} 台主机',
  capabilitiesCount: '{s} 项能力',
  modelsCount: '{s} 个模型',
  hostOne: '主机 {host}',
  hostsHeading: '主机',
  hostsCaption: '{name} 的各主机会话数与事件数',
  colHost: '主机',
  colShare: '占比',
  shareInfo: '占该 agent 事件数的比例',
  capabilitiesHeading: '能力',
  modelsHeading: '模型',
  modelsCaption: '{name} 的各模型 token 数与估算成本',
  colModel: '模型',
  viewSessions: '查看会话 →',

  wordTool: '工具',
  wordSkill: '技能',
  wordMcp: 'MCP',
  wordPlugin: '插件',
  wordConnector: '连接器',
  wordCommand: '命令',
  wordSubagent: '子代理',
  wordHook: '钩子',
  capEvents: '{s} 次 {type} 事件',
  capErrorTail: '，其中 {n} 次以错误状态结束',
  errorsCount: '{s} 次错误',

  notRecorded: '本时间窗内没有记录',
  notRecordedTitle: 'AgentLens 知道它，但它在所选范围内没有记录任何事件——这里显示这一条，而不是一排零。',
  hostFilterLine: '主机筛选：{hosts}',
})

export default { en, zh }
