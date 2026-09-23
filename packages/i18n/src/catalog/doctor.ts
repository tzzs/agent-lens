/**
 * `doctor` namespace — every string this page shows. Owners: see the page file
 * beside it; `en` is the wording the terminal and the API docs also quote, so
 * reword it with the §14 rule in mind, not casually.
 *
 * Deliberately absent: the figures' own formatting (paths, agent ids, parser
 * version numbers, the `parser_version` column, `request_max` and the other fold
 * modes, `agl` command lines) and the sentences the API still sends whole
 * (`cost.basis`, `content.note`, `catalog.note`, an agent row's `note`), which
 * stay the server's words. The coverage banner and its limits note are not here
 * either: they are composed from the structured `coverage` fields through the
 * `banner` namespace, so the viewer's language decides their wording.
 *
 * Several values sit beside a `<span class="nums">` the page must keep, so a
 * message is only one side of a sentence; the leading/trailing spaces the English
 * needs are carried by the template, not by the value.
 */
import { matches } from '../index.ts'

const en = {
  title: 'Doctor',
  pageDesc: 'Can you trust these numbers? Parsing, coverage, pricing and permissions checks.',
  pageInfo:
    'The same report agl doctor prints (§11). Parsing, usage quality, coverage and pricing cover the whole store; capabilities and cost follow the selected window.',
  generated: 'Generated {at}',
  loading: 'Running diagnostics',
  showingLastReport: 'showing the last good report.',

  /* the four summary tiles */
  agentsTile: 'Agents',
  agentsTileInfo:
    'OK means an adapter in this build detected the agent on this machine. Ingested-only agents keep their history but have no adapter here.',
  agentsOf: 'of',
  agentsOfTail: 'OK',
  everyAgentDetected: 'Every agent detected',
  noAgentsKnown: 'No agents known yet',
  parseErrorsTile: 'Parse errors',
  parseErrorsTileInfo:
    'Raw records that failed to parse, as a share of everything read, across the whole store.',
  failedMid: 'failed ·',
  eventsParsedTail: 'events parsed',
  dedupTile: 'Dedup inflation avoided',
  dedupTileInfo:
    "Each agent's tokens are folded under the policy persisted with its own rows (§18 row 2) — request_max folds per request_id, the others never deduplicate. This is how much a raw per-record sum would have over-counted.",
  rawLead: 'Raw',
  tokensAfterFold: "tokens after each agent's own fold",
  noDuplication: 'No request_id duplication observed',
  missingPriceTile: 'Models missing a price',
  missingPriceTileInfo: 'A model without a price shows its cost as n/a — never $0 (§8).',
  allModels: 'All',
  noPriceTableDetail: 'No price table injected — all cost is n/a',
  modelsSeenLead: 'Of',
  modelsSeenTail: 'models seen — their cost is n/a',
  everyModelPriced: 'Every model seen has a price',

  /* agent status, in words (§11) */
  statusOk: 'OK',
  statusIngestedOnly: 'Ingested only',
  statusNotDetected: 'Not detected',
  statusError: 'Error',

  /* the agents surface */
  agentsSurface: 'Agents',
  noAdapters: 'No adapters installed in this build',
  agentsSurfaceInfo:
    'Detection is read-only. An agent without an adapter in this build still shows its ingested history.',
  eventsUnit: 'events',
  sourcesUnit: 'sources',
  noAgentsAtAll: 'No agents detected or ingested yet.',

  /* parsing */
  parsing: 'Parsing',
  parsingInfo: 'Across the whole store, not only the selected window.',
  eventsParsed: 'Events parsed',
  parseErrors: 'Parse errors',
  unknownTypes: 'Unknown event types',
  driftNoEval: "Parser-version drift can't be evaluated —",
  driftNoEvalMid: 'source(s) belong to agents with no adapter in this build,',
  driftNoEvalTail: 'carry no version yet.',
  driftStaleOf: 'of',
  driftStaleTail:
    'sources carry a stale parser_version — the next scan re-reads them in full (§5.3).',
  staleChipTitle: '{agent}: {sources} source(s) stored by parser {version}',
  parserCurrent: 'Parser current',
  sourcesMatch: "source(s) match their adapter's parser version{extra}.",
  unscannedTail: ' · {n} not yet scanned',
  furtherUnmapped:
    'further source(s) belong to agents with no adapter here — drift unknowable for them.',

  /* usage quality */
  usageQuality: 'Usage quality',
  usageQualitySubtitle: 'Events by where their token usage came from',
  usageQualityInfo:
    'Reported: the agent logged its own usage. Estimated: usage was derived. Missing: none recorded. Across the whole store.',
  reportedByAgent: 'Reported by the agent',
  estimated: 'Estimated',
  missing: 'Missing',
  withoutRequestId: 'Without a request_id',
  dedupActiveLead: 'request_id dedup active: raw',
  tokensWord: 'tokens',
  inflationAvoided: 'inflation avoided',
  noDupInData: 'No request_id duplication observed in this data.',
  mixedFoldsTitle: 'Mixed folds in one database —',
  mixedFoldsBody:
    ": every figure below is that agent's own fold. No global rule was applied, and none would be correct (§18 row 2).",
  foldChipTitle: "The fold persisted with this agent's stored rows",
  subagentsCounted: 'subagents counted',
  subagentsExcluded: 'subagents excluded',
  defaulted: 'defaulted',
  defaultedTitle:
    "No policy was persisted for this agent, so the cube's most conservative default applied",
  usageShares: 'reported {r} · estimated {e} · missing {m}',
  withoutRequestIdTip: 'Records the per-request fallback key had to cover, counted individually',
  withoutRequestIdN: '{n} without a request_id{extra}',
  withUsageN: ' ({n} with usage)',
  foldActive:
    'request_id dedup {state}: raw sum {naive} → {folded} tokens · {groups} folded groups from {rows} usage rows',
  dedupStateActive: 'active',
  dedupStateNotNeeded: 'not needed',
  foldNone: 'no request_id dedup: raw sum {naive} = {folded} · {rows} usage rows summed once each',
  disagreeLead: 'Cube and event-model disagree for this agent (',
  disagreeVs: 'vs',
  disagreeTail:
    ') — one path is wrong, so every token and cost figure for it is untrustworthy until they match.',
  declaresLead: 'This agent declares',
  declaresMid: ': one global request_max would have reported',
  insteadOf: 'instead of',
  declaresEnd: ' (§18 row 2).',
  itsAdapterNow: 'Its installed adapter now declares',
  exclSubagents: 'with subagents excluded',
  butRowsFolded: ', but the stored rows are folded',
  rowsNotNextScan: '— the figures describe the rows, not the next scan.',
  noPolicyForIt:
    'No adapter in this build declares a policy for it — nothing above is a claim about the next scan.',

  /* coverage */
  coverage: 'Coverage',
  coverageInfo:
    'Upstream tools can delete old session files while their folder stays, so a scan can look complete while being partial. These are presence checks, not statistics.',
  historyMaybeIncomplete: 'History may be incomplete.',
  unreachableNow:
    '{n, plural, one {{n} ingested source can\'t be read right now.} other {{n} ingested sources can\'t be read right now.}}',
  complete: 'Complete',
  historyLooksComplete: 'History looks complete for ingested sources.',
  emptyDirsHeading: 'Source dirs whose session files are gone',
  missingWord: 'missing',
  projectDirsHeading: 'Project dirs with no sessions left',
  retentionUnreadable: 'known source(s) no longer readable',
  retentionGone: ' (gone',
  retentionRotated: 'rotated',
  retentionUnreadableTail:
    ') — the events already ingested from them stay, nothing new can arrive.',
  retentionActiveTail:
    'source(s) read to their end · coverage stops where upstream retention stops (§4.4 row 4).',

  /* subagent links */
  subagentLinks: 'Subagent links',
  subagentLinksInfo:
    '§4.4 row 8: a subagent event is attached to the nearest preceding parent call by time, with no foreign key behind it, so some links cannot be resolved.',
  noSubagentEvents: 'No subagent events ingested — the link heuristic is untested on this data.',
  orphanOf: '{orphan} of {total} unlinked',
  orphansCounted: "Their tokens and cost ARE counted; only the timeline's tree placement is unknown.",

  /* invented timestamps */
  stageOneTitle: 'Materialised stage 1',
  stageOneInfo:
    '§19: the per-request fold is stored in its own table so the cube stops folding every event on each read. No foreign key ties that table to `events`, so whether it still agrees is a fact worth printing.',
  // Split around the inline <code>events</code> the report keeps in its markup, so the
  // spaces that sentence needs live in the message rather than in the template.
  stageOneDeclinedLead:
    'The figures stay right either way: a table that drifted or was folded under another policy is declined, and the read folds from ',
  stageOneDeclinedTail: ' again — this costs speed, not correctness.',
  stageOneNoReport: 'This server build reported no stage-1 health.',
  inventedTimestamps: 'Invented timestamps',
  inventedTimestampsInfo:
    "§5.2: an event whose source stated no time gets one anyway — the source file's last write, or the instant the scan ran. The rows are real activity; only their date is a stand-in.",
  allTsStated: 'Every ingested event carries a timestamp its source stated (§5.2).',
  guessedOf: '{g} of {e} guessed',
  tsWindowLead: 'Time-windowed numbers —',
  tsWindowMid: ", this page's window — include these rows whatever their real date is.",
  tsScanClock: 'are dated by the scan clock, which bounds nothing;',
  tsFileMtime: "by the source file's last write, which does (§19).",

  /* capabilities, pricing, cost */
  capabilities: 'Capabilities',
  inSelectedWindow: 'In the selected window',
  noCapabilityEvents: 'No capability events in this window.',
  errorsWord: 'errors',
  catalogLabel: 'Catalog:',
  pricing: 'Pricing',
  pricingInfo: 'Costs use the injected price table. A model without a price shows cost as n/a — never $0 (§8).',
  modelsPriced: 'Models priced',
  modelsSeen: 'Models seen',
  missingPriceAlert: '{n} missing a price — cost n/a:',
  noPriceTableTitle: 'No price table injected —',
  allCostNa: 'all cost is n/a, never shown as $0.',
  cost: 'Cost',
  costActual: 'Actual, reported where known',
  costApiEquiv: 'API-equivalent estimate',
  costReportedBy: 'Reported by agents',
  noPriceFor: 'No price for {agents} — the totals above are a floor.',

  /* permissions and the content layer */
  permissions: 'Permissions',
  permissionsInfo: "Whether this process can read each detected agent's data root.",
  readable: 'Readable',
  unreadable: 'Unreadable',
  noPermissions: 'Nothing to report — no agent data roots were detected.',
  contentLayer: 'Content layer',
  contentLayerInfo:
    'An optional copy of message and tool text, made only when a scan runs with --content. Statistics never depend on it.',
  status: 'Status',
  contentOn: 'On',
  contentOff: 'Off · metrics only',
  payloadsStored: 'Payloads stored',
}

const zh = matches(en)({
  title: '体检',
  pageDesc: '这些数字可信吗？涵盖解析、覆盖度、定价与权限检查。',
  pageInfo:
    '这与 agl doctor 打印的是同一份报告（§11）。解析、用量质量、覆盖度与定价针对整个存储；能力调用与成本只按所选时间窗统计。',
  generated: '生成于 {at}',
  loading: '正在运行体检',
  showingLastReport: '仍显示上一次的正确报告。',

  agentsTile: 'Agents',
  agentsTileInfo: '正常表示本构建里的某个 adapter 在这台机器上检测到了该 agent。仅已采集的 agent 保留自己的历史，但这里没有对应的 adapter。',
  agentsOf: '共',
  agentsOfTail: '个',
  everyAgentDetected: '所有 agent 均已检测到',
  noAgentsKnown: '尚未有已知的 agent',
  parseErrorsTile: '解析错误',
  parseErrorsTileInfo: '解析失败的原始记录，占所有读取内容的比例，统计范围为整个存储。',
  failedMid: '条失败 ·',
  eventsParsedTail: '个事件已解析',
  dedupTile: '去重避免的虚高',
  dedupTileInfo:
    '每个 agent 的 token 都按与其自身数据行一起存储的策略折叠（§18 第 2 行）—— request_max 按 request_id 折叠，其他方式从不去重。这里显示的是按单条记录直接求和会虚高多少。',
  rawLead: '原始',
  tokensAfterFold: 'tokens，按各 agent 自身的折叠规则',
  noDuplication: '未观察到 request_id 重复',
  missingPriceTile: '缺少定价的模型',
  missingPriceTileInfo: '没有定价的模型，其成本显示为 未定价，绝不会是 $0（§8）。',
  allModels: '全部',
  noPriceTableDetail: '未注入价格表 —— 所有成本均为 未定价',
  modelsSeenLead: '共',
  modelsSeenTail: '个出现过的模型没有定价 —— 其成本为 未定价',
  everyModelPriced: '出现过的模型都有定价',

  statusOk: '正常',
  statusIngestedOnly: '仅已采集',
  statusNotDetected: '未检测到',
  statusError: '错误',

  agentsSurface: 'Agents',
  noAdapters: '本构建未安装任何 adapter',
  agentsSurfaceInfo: '检测是只读的。即使本构建里没有该 agent 的 adapter，它已采集的历史仍会显示。',
  eventsUnit: '个事件',
  sourcesUnit: '个数据源',
  noAgentsAtAll: '尚未检测到或采集任何 agent。',

  parsing: '解析',
  parsingInfo: '统计范围为整个存储，不只是所选时间窗。',
  eventsParsed: '已解析事件',
  parseErrors: '解析错误',
  unknownTypes: '未知事件类型',
  driftNoEval: '无法评估解析器版本漂移 ——',
  driftNoEvalMid: '个数据源属于本构建里没有 adapter 的 agent，',
  driftNoEvalTail: '个尚无版本号。',
  driftStaleOf: '中的',
  driftStaleTail: '个数据源存有旧的 parser_version —— 下次扫描会完整重读它们（§5.3）。',
  staleChipTitle: '{agent}：由解析器 {version} 存下了 {sources} 个数据源',
  parserCurrent: '解析器已是最新',
  sourcesMatch: '个数据源与其 adapter 的解析器版本一致{extra}。',
  unscannedTail: ' · {n} 个尚未扫描',
  furtherUnmapped: '个数据源属于本构建里没有 adapter 的 agent —— 它们的漂移无从判断。',

  usageQuality: '用量质量',
  usageQualitySubtitle: '按 token 用量的来源区分事件',
  usageQualityInfo:
    '有上报：agent 自己记录了用量。估算：用量由推算得出。缺失：完全没有记录。统计范围为整个存储。',
  reportedByAgent: '由 agent 上报',
  estimated: '估算',
  missing: '缺失',
  withoutRequestId: '没有 request_id',
  dedupActiveLead: 'request_id 去重已生效：原始',
  tokensWord: 'tokens',
  inflationAvoided: '的膨胀被避免',
  noDupInData: '这份数据里未观察到 request_id 重复。',
  mixedFoldsTitle: '同一个库里存在多种折叠方式 ——',
  mixedFoldsBody: '：下面的每个数字都是该 agent 自己的折叠结果。没有套用全局规则，也不该套用（§18 第 2 行）。',
  foldChipTitle: '这是与该 agent 的存储行一起保存的折叠方式',
  subagentsCounted: '已计入子 agent',
  subagentsExcluded: '未计入子 agent',
  defaulted: '使用默认值',
  defaultedTitle: '该 agent 没有存下过策略，因此采用了立方体最保守的默认值',
  usageShares: '有上报 {r} · 估算 {e} · 缺失 {m}',
  withoutRequestIdTip: '这些记录由按请求的回退键覆盖，单独计数',
  withoutRequestIdN: '{n} 条没有 request_id{extra}',
  withUsageN: '（{n} 条带用量）',
  foldActive:
    'request_id 去重{state}：原始合计 {naive} → {folded} tokens · 由 {rows} 行 usage 折出 {groups} 个分组',
  dedupStateActive: '已生效',
  dedupStateNotNeeded: '无需生效',
  foldNone: '无 request_id 去重：原始合计 {naive} = {folded} · {rows} 行 usage 各自只累加一次',
  disagreeLead: '立方体与 event-model 对这个 agent 的结果不一致（',
  disagreeVs: '对比',
  disagreeTail:
    '）—— 两条路径中有一条是错的，因此在两者一致之前，它的所有 token 与成本数字都不可信。',
  declaresLead: '该 agent 声明的是',
  declaresMid: '：若统一套用全局 request_max，结果会是',
  insteadOf: '而不是',
  declaresEnd: '（§18 第 2 行）。',
  itsAdapterNow: '它当前安装的 adapter 声明的是',
  exclSubagents: '未计入子 agent',
  butRowsFolded: '，而存储里的行是按',
  rowsNotNextScan: '折叠的 —— 这些数字描述的是已存储的行，不是下一次扫描。',
  noPolicyForIt: '本构建里没有 adapter 为它声明策略 —— 上面任何内容都不构成对下一次扫描的断言。',

  coverage: '覆盖度',
  coverageInfo:
    '上游工具会在目录还在时删掉旧的会话文件，因此一次扫描看起来完整、实则是残缺的。这里都是存在性检查，不是统计。',
  historyMaybeIncomplete: '历史可能不完整。',
  unreachableNow: '有 {n} 个已采集的数据源此刻读不到。',
  complete: '完整',
  historyLooksComplete: '就已采集的数据源而言，历史看起来是完整的。',
  emptyDirsHeading: '会话文件已消失的数据源目录',
  missingWord: '个已缺失',
  projectDirsHeading: '已无会话的项目目录',
  retentionUnreadable: '个已知数据源已读不到',
  retentionGone: '（已删除',
  retentionRotated: '已轮转',
  retentionUnreadableTail: '）—— 从它们采集到的事件仍然保留，但不会再有新数据进来。',
  retentionActiveTail:
    '个数据源已读到底 · 覆盖度止于上游保留策略的边界（§4.4 第 4 行）。',

  subagentLinks: '子 agent 挂接',
  subagentLinksInfo:
    '§4.4 第 8 行：子 agent 事件按时间挂到最近的前一个父调用上，背后并没有外键，因此有些挂接无法解析。',
  noSubagentEvents: '没有采集到子 agent 事件 —— 这份数据无法检验挂接启发式。',
  orphanOf: '{orphan} 个未挂接，共 {total} 个',
  orphansCounted: '它们的 token 与成本确实已被计入；无法确定的只是时间轴上的树位置。',

  stageOneTitle: '已实体化的 stage 1',
  stageOneInfo:
    '§19：按请求折叠的结果存在它自己的表里，立方体因此不必每次读取都重新折叠全部事件。这张表与 `events` 之间没有外键约束，所以它是否仍然一致，是一个值得打印出来的事实。',
  stageOneDeclinedLead: '两边的数字都仍然正确：脱节过、或按别的策略折叠过的表会被弃用，读取会现场从 ',
  stageOneDeclinedTail: ' 重新折叠 —— 损失的是速度，不是正确性。',
  stageOneNoReport: '这个服务端构建没有上报 stage 1 的健康状况。',
  inventedTimestamps: '被造出的时间戳',
  inventedTimestampsInfo:
    '§5.2：源本身没给时间的事件也会被安上一个 —— 源文件的最后写入时间，或扫描运行的那一刻。这些行是真实活动，只有日期是替身。',
  allTsStated: '每个已采集事件都带着其数据源给出的时间戳（§5.2）。',
  guessedOf: '{g} 个是造出的，共 {e} 个',
  tsWindowLead: '按时间窗统计的数字 ——',
  tsWindowMid: '、本页面的时间窗 —— 无论这些行的真实日期为何，都会被包含进来。',
  tsScanClock: '个由扫描时钟定下时间戳，它框不住任何东西；',
  tsFileMtime: '个按源文件的最后写入时间定下，它可以（§19）。',

  capabilities: '能力调用',
  inSelectedWindow: '按所选时间窗',
  noCapabilityEvents: '这个时间窗内没有能力调用事件。',
  errorsWord: '个出错',
  catalogLabel: '能力目录：',
  pricing: '定价',
  pricingInfo: '成本按注入的价格表计算。没有定价的模型，其成本显示为 未定价，绝不会是 $0（§8）。',
  modelsPriced: '已定价模型',
  modelsSeen: '出现过的模型',
  missingPriceAlert: '有 {n} 个缺少定价 —— 成本为 未定价：',
  noPriceTableTitle: '未注入价格表 ——',
  allCostNa: '所有成本都是 未定价，绝不会显示为 $0。',
  cost: '成本',
  costActual: '实际花费，已知的按上报值',
  costApiEquiv: 'API 等价估算',
  costReportedBy: '由 agent 上报',
  noPriceFor: '以下 agent 没有定价：{agents} —— 上面的合计只是下限。',

  permissions: '权限',
  permissionsInfo: '本进程能否读取每个已检测到 agent 的数据根目录。',
  readable: '可读',
  unreadable: '读不到',
  noPermissions: '无可报告内容 —— 未检测到任何 agent 数据根目录。',
  contentLayer: '内容层',
  contentLayerInfo:
    '消息与工具正文的一份可选副本，只有在扫描带 --content 运行时才会生成。任何统计都不依赖它。',
  status: '状态',
  contentOn: '已开启',
  contentOff: '已关闭 · 仅指标',
  payloadsStored: '已存正文数',
})

export default { en, zh }

