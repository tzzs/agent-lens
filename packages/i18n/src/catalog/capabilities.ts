/**
 * `capabilities` namespace — every string this page shows. Owners: see the page file
 * beside it; `en` is the wording the terminal and the API docs also quote, so
 * reword it with the §14 rule in mind, not casually.
 *
 * Deliberately absent: the capability *names* (`bash`, `Edit`, a server's tool
 * names) and the agent ids, which are the data's own labels, `lib/api.ts`'s
 * `UNNAMED_CAPABILITY` sentinel, which the capability-dims test pins, and the two
 * strings the API still sends whole — `catalog.note` and the `explain` SQL.
 *
 * `type*` keys are the by-type table's row labels, so English has plurals
 * (`Tools`) and Chinese has one form. `word*` keys are the singular category word
 * used inside a sentence or a catalog chip; English keeps the raw lower-case type
 * the page printed before, with `MCP` as the one spelling the page already
 * overrode.
 */
import { matches } from '../index.ts'

const en = {
  title: 'Capabilities',
  pageDesc: 'Which tools, skills, MCP servers, hooks and subagents did the work — uses, time, failures and cost.',
  pageInfo:
    'Grouped by capability type for the selected window (§10). A type an agent does not record reads “Not reported”, never 0 (§18 item 5).',
  loading: 'Loading capabilities',

  /* the by-type table */
  byType: 'By type',
  byTypeSubtitle: 'Expand a type to see its most-used names.',
  tableCaption: 'Capability use by type',
  colType: 'Type',
  colUses: 'Uses',
  colDuration: 'Duration',
  colTokens: 'Tokens',
  colFailures: 'Failures',
  colCost: 'Est. cost',
  colReportedBy: 'Reported by',
  colName: 'Name',
  colErrors: 'Errors',
  usesInfo: 'Events recorded for this capability type in the selected window.',
  durationInfo:
    'Total time the agents logged for these calls. A dash means no durations were recorded for this type, not zero time.',
  tokensInfo: 'Tokens carried by these events, counted once per request (§3.1).',
  failuresInfo: 'Calls that ended in an error status.',
  costInfo: 'Tokens × list price. n/a when there is no price or no tokens to price — never $0.',
  reportedByInfo: 'Agents that recorded this type in the selected window.',
  noDurations: 'No durations recorded',
  noUses: 'No uses in this window',
  topNamesSr: ', top names',

  /* status of one capability type in the window */
  notReported: 'Not reported',
  notReportedTitle: 'An absence, not a zero: these agents record no {type} events at all.',
  notReportedMeans: 'means the agent records no events of that type at all. It is an absence, not a zero.',
  byAgents: 'by {agents}',

  /* capability type labels: the table's plural row label and the singular word */
  typeTool: 'Tools',
  typeSkill: 'Skills',
  typeMcp: 'MCP',
  typePlugin: 'Plugins',
  typeConnector: 'Connectors',
  typeCommand: 'Commands',
  typeSubagent: 'Subagents',
  typeHook: 'Hooks',
  wordTool: 'tool',
  wordSkill: 'skill',
  wordMcp: 'MCP',
  wordPlugin: 'plugin',
  wordConnector: 'connector',
  wordCommand: 'command',
  wordSubagent: 'subagent',
  wordHook: 'hook',

  /* per-name detail under a type */
  namesCaption: 'Most-used {type} names',
  topNamesNote: 'Top {n} names by uses. The {type} row above totals every name, including ones not listed.',
  agentUseTitle:
    '{agent}: {n, plural, one {{uses} use} other {{uses} uses}} across {m, plural, one {{sessions} session} other {{sessions} sessions}}',
  failureChipTitle: '{n, plural, one {{calls} call} other {{calls} calls}} of {total} ended in an error ({pct})',

  /* installed but never used */
  installedTitle: 'Installed but never used',
  installedSubtitle: "In an agent's catalog, but no uses in this window",
  installedInfo:
    "Read from each agent's static capability catalog (§5.1). An entry is listed when nothing in the selected window used it.",
  noCatalog: "No catalog available, so unused capabilities can't be listed. That is not the same as none.",
  catalogEmpty: 'The catalog is empty: no installed capabilities were found.',
  catalogAllUsed: 'All {n, plural, one {{s} catalogued entry was} other {{s} catalogued entries were}} used in this window.',

  /* the derivation card */
  deriveTitle: 'How these numbers were derived',
  deriveInfo: 'The cube query behind this page (§7). “Not reported” follows §18 item 5.',
  queryLabel: 'Query',
}

const zh = matches(en)({
  title: '能力调用',
  pageDesc: '哪些工具、技能、MCP 服务器、钩子与子代理在干活——用量、时长、失败与成本。',
  pageInfo:
    '按所选时间窗内的能力类型分组（§10）。agent 没有记录的类型显示为“未上报”，绝不会显示成 0（§18 第 5 条）。',
  loading: '正在加载能力',

  byType: '按类型',
  byTypeSubtitle: '展开某个类型，即可看到它最常用的名称。',
  tableCaption: '按类型统计的能力用量',
  colType: '类型',
  colUses: '用量',
  colDuration: '时长',
  colTokens: 'token 数',
  colFailures: '失败数',
  colCost: '估算成本',
  colReportedBy: '上报者',
  colName: '名称',
  colErrors: '错误数',
  usesInfo: '所选时间窗内，该能力类型记录到的事件。',
  durationInfo: 'agent 为这些调用记录的总时长。破折号表示该类型没有记录到时长，而不是时长为零。',
  tokensInfo: '这些事件所带的 tokens，每个请求只计一次（§3.1）。',
  failuresInfo: '以错误状态结束的调用。',
  costInfo: 'tokens × 牌价。没有价格、或没有可计价的 tokens 时显示“未定价”，绝不会显示 $0。',
  reportedByInfo: '在所选时间窗内记录到该类型的 agent。',
  noDurations: '未记录到时长',
  noUses: '本时间窗内没有使用记录',
  topNamesSr: '，最常用的名称',

  notReported: '未上报',
  notReportedTitle: '这是一种缺席，不是零：这些 agent 根本不记录 {type} 事件。',
  notReportedMeans: '表示该 agent 根本不记录这一类型的事件。这是缺席，不是零。',
  byAgents: '未由 {agents} 上报',

  typeTool: '工具',
  typeSkill: '技能',
  typeMcp: 'MCP',
  typePlugin: '插件',
  typeConnector: '连接器',
  typeCommand: '命令',
  typeSubagent: '子代理',
  typeHook: '钩子',
  wordTool: '工具',
  wordSkill: '技能',
  wordMcp: 'MCP',
  wordPlugin: '插件',
  wordConnector: '连接器',
  wordCommand: '命令',
  wordSubagent: '子代理',
  wordHook: '钩子',

  namesCaption: '最常用的 {type} 名称',
  topNamesNote: '按用量列出前 {n} 个名称。上面的 {type} 行汇总了全部名称，包括未列出的那些。',
  agentUseTitle: '{agent}：{uses} 次使用，分布在 {sessions} 个会话中',
  failureChipTitle: '{total} 次调用中有 {calls} 次以错误结束（{pct}）',

  installedTitle: '已安装但从未使用',
  installedSubtitle: '在某个 agent 的能力目录里，但本时间窗内没有被用到',
  installedInfo:
    '读取自每个 agent 的静态能力目录（§5.1）。当所选时间窗里没有任何东西用到某个条目时，它就会被列在这里。',
  noCatalog: '没有可用的能力目录，因此无法列出未使用的能力。这和“一个都没有”不是一回事。',
  catalogEmpty: '能力目录是空的：未发现已安装的能力。',
  catalogAllUsed: '目录里的 {s} 个条目在本时间窗内都用到过。',

  deriveTitle: '这些数字是怎么来的',
  deriveInfo: '本页面背后的立方体查询（§7）。“未上报”的写法遵循 §18 第 5 条。',
  queryLabel: '查询',
})

export default { en, zh }
