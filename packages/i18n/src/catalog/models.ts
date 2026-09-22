/**
 * `models` namespace — every string this page shows. Owners: see the page file
 * beside it; `en` is the wording the terminal and the API docs also quote, so
 * reword it with the §14 rule in mind, not casually.
 *
 * Deliberately absent: model and provider names, `$0`, the `agentlens pricing
 * update` command line and the dates `lib/format.ts` prints — the page keeps each
 * of those in its own `<span class="nums">`, and a message only carries the words
 * around it. Boundary spaces live in the template, never at the edge of a value,
 * so a locale cannot gain or lose a space it was not asked for. Two words are
 * inserted rather than written out: `{na}`, the §8 glyph, is `common.na` — the
 * same one `CostFigure` renders in the cell beside the sentence — and `{chip}` is
 * this page's own `Not configured` badge, so the header tooltip can never name a
 * state the table no longer shows.
 */
import { matches } from '../index.ts'

const en = {
  title: 'Models',
  pageDesc: 'Tokens and estimated cost per model, and which models are missing a price.',
  pageInfo: 'Est. cost is tokens × list price. A model with no price shows {na}, never $0 (§8).',
  loadingText: 'Loading models',

  /* the table */
  colModel: 'Model',
  colProvider: 'Provider',
  colEvents: 'Events',
  colSessions: 'Sessions',
  colTokens: 'Tokens',
  colTokensInfo: 'Counted once per request, then summed (§3.1).',
  colCost: 'Est. cost',
  colCostInfo: "Each day's tokens × that day's list price. {na} when the model has no price — never $0.",
  colPrice: 'Price',
  colPriceInfo:
    'Whether the price table covers this model at its last-seen date. “{chip}” means no price table is loaded at all.',
  noModel: '(no model)',
  noModelTitle: 'Events recorded without a model, such as tool calls and lifecycle events',
  empty: 'No model activity in this window',
  truncated:
    'Showing the first {n, plural, one {{n} model} other {{n} models}}. Narrow the range or agent to see the rest.',

  /* the pricing state */
  pricingGapTitle: 'Pricing gap.',
  pricingGap:
    '{n, plural, one {1 model has} other {{n} models have}} no price at {n, plural, one {its} other {their}} last-seen date, so {n, plural, one {its} other {their}} cost shows {na}:',
  pricingGapMore: 'and {n} more, listed below',
  // Split around the command, as the file's header prescribes: a message carries the
  // words around a command line, never the command line itself.
  pricingGapFallbackLead: 'Run',
  pricingGapFallbackTail: 'to price the ones the primary snapshot lacks.',
  period: '.',
  noPriceTableLead: 'No price table is loaded, so est. and actual cost show {na} everywhere. Run',
  noPriceTableTail: 'to fetch one.',
  notConfiguredTitle: 'Pricing not configured.',
  unpricedTitle: 'Unpriced models',
  unpricedSubtitle: 'No price at their last-seen date, so their cost shows {na}, never $0',
  unpricedInfo:
    "Checked against the price table at each model's last-seen date (§8), so this can include models outside the selected window.",
  lastSeen: 'Last seen',

  /* the price chips */
  chipPriced: 'Priced',
  chipUnpriced: 'Unpriced',
  chipUnpricedTitle: "No price at this model's last-seen date, so its cost shows {na}, never $0.",
  chipUnconfigured: 'Not configured',
  chipUnconfiguredTitle: 'No price table is loaded, so no model can be priced.',
  chipNoModel: 'No model',
  chipNoModelTitle: 'There is no model on these events, so there is nothing to price.',
}

const zh = matches(en)({
  title: '模型',
  pageDesc: '每个模型的 tokens 与估算费用，以及哪些模型缺少价格。',
  pageInfo: '估算费用 = tokens × 牌价。没有定价的模型显示为{na}，绝不会是 $0（§8）。',
  loadingText: '正在加载模型',

  colModel: '模型',
  colProvider: '提供商',
  colEvents: '事件数',
  colSessions: '会话数',
  colTokens: 'tokens',
  colTokensInfo: '每个请求只计一次，然后再求和（§3.1）。',
  colCost: '估算费用',
  colCostInfo: '每天的 tokens × 当天的牌价。模型没有定价时显示为{na}，绝不会是 $0。',
  colPrice: '定价',
  colPriceInfo: '价格表在其最后出现日期上是否覆盖该模型。“{chip}”表示根本没有加载任何价格表。',
  noModel: '（无模型）',
  noModelTitle: '没有记录模型的事件，例如工具调用与生命周期事件',
  empty: '这个时间窗内没有任何模型活动',
  truncated: '仅显示前 {n} 个模型。缩窄时间窗或 agent 以查看其余部分。',

  pricingGapTitle: '定价缺口。',
  pricingGap: '有 {n} 个模型在其最后出现日期上没有价格，因此它们的费用显示为{na}：',
  pricingGapMore: '另有 {n} 个列在下方',
  pricingGapFallbackLead: '运行',
  pricingGapFallbackTail: '可为主要快照缺价的模型补上价格。',
  period: '。',
  noPriceTableLead: '当前没有加载任何价格表，所以估算费用与实际费用在任何地方都显示为{na}。运行',
  noPriceTableTail: '即可拉取一份。',
  notConfiguredTitle: '未配置定价。',
  unpricedTitle: '未定价的模型',
  unpricedSubtitle: '在其最后出现日期上没有价格，因此它们的费用显示为{na}，绝不会是 $0',
  unpricedInfo: '这里是按每个模型最后出现日期（§8）时的价格表核对的，因此可能包含所选时间窗之外的模型。',
  lastSeen: '最后出现',

  chipPriced: '已定价',
  chipUnpriced: '未定价',
  chipUnpricedTitle: '该模型在其最后出现日期上没有价格，因此它的费用显示为{na}，绝不会是 $0。',
  chipUnconfigured: '未配置定价',
  chipUnconfiguredTitle: '没有加载任何价格表，因此任何模型都无法定价。',
  chipNoModel: '无模型',
  chipNoModelTitle: '这些事件上没有模型，因此也就没有可定价的对象。',
})

export default { en, zh }
