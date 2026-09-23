/**
 * `settings` namespace — every string this page shows. Owners: see the page file
 * beside it; `en` is the wording the terminal and the API docs also quote, so
 * reword it with the §14 rule in mind, not casually.
 *
 * Deliberately absent: the server's own error text (an API message is shown
 * verbatim in every locale — it carries the paths a bug report needs), the
 * `billing mode` and agent-status enum values the data itself states, the
 * `agl pricing billing set …` command line, and `cost.basis`, which the API
 * still sends as a finished sentence.
 *
 * Two values are only one half of a rendered line, because the page keeps a
 * `<span class="nums">` around the path and the `agl` word: the spaces the
 * English needs are carried by the template.
 */
import { matches } from '../index.ts'

const en = {
  title: 'Settings',
  pageDesc: 'Adapters, pricing, data sources and privacy, as reported by the running server.',
  pageInfo:
    "Nothing here is computed in the browser: it is the server's own report from /api/health and /api/doctor. The billing modes below are the one thing you can change here, and they are saved on the server.",
  loadingServerReport: "Reading the server's report",
  loadingAsking: 'Asking the server',
  loadingBilling: 'Reading the billing declarations',
  loadingDoctor: 'Checking adapters, pricing and sources',

  /* the server surface */
  server: 'Server',
  serverName: 'Name',
  status: 'Status',
  statusOk: 'OK',
  serverClock: 'Server clock',
  dbPath: 'Database path',
  inMemory: 'In-memory (not persisted)',
  migrationsApplied: 'Migrations applied',
  eventsStored: 'Events stored',
  sessions: 'Sessions',

  /* privacy */
  privacyTitle: 'Privacy & local-first',
  loopbackBind: 'Loopback-only bind',
  loopbackYes: 'Yes · same-origin only',
  loopbackNo: 'No',
  contentLayer: 'Content layer',
  contentOn: 'On · {n} payloads stored',
  contentOff: 'Off · metrics only',
  privacyLead:
    'AgentLens reads private local agent logs and serves them without authentication, so the server binds to loopback only and this dashboard never requests anything beyond its own origin — no telemetry, no CDN, and its fonts ship inside the app. The content layer is off by default and stays off unless a scan opts in with',
  privacyTail:
    ': message and tool text is the only private content it ever copies into this database. Every statistic works without it.',

  /* adapters */
  adapters: 'Adapters',
  noAdapters: 'No adapters installed in this build — rows come from ingested history',
  adaptersInfo: 'The CLI owns adapter wiring (§5.4). Detection is read-only; hover a status for its note.',
  adaptersCaption: 'Adapters',
  adaptersEmpty: 'No agents detected or ingested yet',
  colAgent: 'Agent',
  colVersion: 'Version',
  colRoot: 'Data root',
  colSources: 'Sources',
  colStatus: 'Status',
  statusIngestedOnly: 'Ingested only',
  statusNotDetected: 'Not detected',
  statusError: 'Error',

  /* pricing */
  pricing: 'Pricing',
  pricingInfo: 'Costs use the injected price table. An unknown price renders as n/a, never $0 (§8).',
  priceTable: 'Price table',
  priceConfigured: 'Configured',
  priceNotInjected: 'Not injected',
  modelsPriced: 'Models priced',
  modelsSeen: 'Models seen',
  missingAPrice: 'Missing a price',
  allUnpriced: 'All — cost is n/a',
  none: 'None',

  /* §8 billing declarations */
  billing: 'Billing modes',
  billingInfo:
    "How each agent's tokens become money (§8). Cash and API-equivalent are two different numbers and the app keeps showing both: declaring a mode moves the cash figure, never the token value.",
  declRejected: 'Declaration rejected.',
  saved: 'Saved.',
  savedNote: 'saved: {agent} = {mode}',
  clearedTail: '(declaration cleared, so the api default applies again)',
  declared: 'declared',
  defaultMode: 'default',
  billingModeAria: 'Billing mode for {agent}',
  modeApi: 'API — tokens x price',
  modeSubscription: 'Subscription — $0 cash, priced as API equivalent',
  modeLocal: 'Local — $0 cash, priced as API equivalent',
  notDeclared: 'Not declared (api default)',
  noAgentsYet: 'No agents known yet — a scan registers them, then a mode can be declared here.',
  savedInLead: 'Saved in',
  savedInMid: ', the same file',
  savedInTail:
    'reads, so the terminal and this page can never disagree. A model with no price still reads n/a, never $0 — a billing mode is a statement about cash, not a price (§8).',
  noDbLead:
    'This server was started without a database file, so it has nowhere to keep a declaration. Declare modes with',
  noDbTail: 'instead.',

  /* data sources */
  dataSources: 'Data sources',
  dataSourcesInfo: 'Presence checks over the sources the collector has ingested — nothing here is a statistic.',
  sourcesKnown: 'Sources known',
  unreachable: 'Unreachable',
  dirsEmptied: 'Dirs emptied by retention',
  eventlessSessions: 'Sessions without events',

  /* appearance */
  appearance: 'Appearance',
  browserOnly: 'Saved in this browser only.',
  systemFollow: 'System follows your OS — currently {resolved}.',
  colorTheme: 'Color theme',
  themeSystem: 'System',
  themeLight: 'Light',
  themeDark: 'Dark',
  // The resolved mode named inside a sentence, which reads lowercase in English.
  resolvedLight: 'light',
  resolvedDark: 'dark',
}

const zh = matches(en)({
  title: '设置',
  pageDesc: 'adapter、定价、数据源与隐私，均来自运行中的服务器自报的信息。',
  pageInfo:
    '这里没有任何内容在浏览器里计算：它是服务器通过 /api/health 与 /api/doctor 给出的自述。下面的计费方式是此处唯一可以改动的东西，并且保存在服务器上。',
  loadingServerReport: '正在读取服务器的报告',
  loadingAsking: '正在询问服务器',
  loadingBilling: '正在读取计费方式声明',
  loadingDoctor: '正在检查 adapter、定价与数据源',

  server: '服务器',
  serverName: '名称',
  status: '状态',
  statusOk: '正常',
  serverClock: '服务器时钟',
  dbPath: '数据库路径',
  inMemory: '内存库（未持久化）',
  migrationsApplied: '已应用的迁移',
  eventsStored: '已存事件',
  sessions: '会话',

  privacyTitle: '隐私与本地优先',
  loopbackBind: '仅绑定回环地址',
  loopbackYes: '是 · 仅同源访问',
  loopbackNo: '否',
  contentLayer: '内容层',
  contentOn: '已开启 · 存了 {n} 条正文',
  contentOff: '已关闭 · 仅指标',
  privacyLead:
    'AgentLens 会读取本机 agent 的私有日志，并在没有身份验证的情况下对外提供，因此服务器只绑定回环地址，本看板也绝不会请求自身源之外的任何资源 —— 没有遥测、没有 CDN，字体也随应用一起打包。内容层默认关闭，只有在扫描时主动带上',
  privacyTail:
    ' 才会开启：消息与工具正文是它唯一会复制进这个数据库的私有内容。所有统计不启用它也照样可用。',

  adapters: 'Adapters',
  noAdapters: '本构建未安装任何 adapter —— 行数据来自已采集的历史',
  adaptersInfo: 'adapter 的接线由 CLI 负责（§5.4）。检测是只读的；把鼠标停在状态标签上可以看到它的说明。',
  adaptersCaption: 'Adapters',
  adaptersEmpty: '尚未检测到或采集任何 agent',
  colAgent: 'Agent',
  colVersion: '版本',
  colRoot: '数据根目录',
  colSources: '数据源',
  colStatus: '状态',
  statusIngestedOnly: '仅已采集',
  statusNotDetected: '未检测到',
  statusError: '错误',

  pricing: '定价',
  pricingInfo: '成本按注入的价格表计算。价格未知时显示为 未定价，绝不会是 $0（§8）。',
  priceTable: '价格表',
  priceConfigured: '已配置',
  priceNotInjected: '未注入',
  modelsPriced: '已定价模型',
  modelsSeen: '出现过的模型',
  missingAPrice: '缺少定价',
  allUnpriced: '全部 —— 成本为 未定价',
  none: '无',

  billing: '计费方式',
  billingInfo:
    '这里说的是每个 agent 的 token 如何变成钱（§8）。现金与 API 等价是两个不同的数字，应用会一直同时显示两者：声明某个计费方式只会改变现金数字，不会改变 token 的价值。',
  declRejected: '声明被拒绝。',
  saved: '已保存。',
  savedNote: '已保存：{agent} = {mode}',
  clearedTail: '（声明已清除，因此 api 默认值重新生效）',
  declared: '已声明',
  defaultMode: '默认',
  billingModeAria: '{agent} 的计费方式',
  modeApi: 'API —— 按 tokens x 单价',
  modeSubscription: '订阅 —— 现金为 $0，按 API 等价计价',
  modeLocal: '本地 —— 现金为 $0，按 API 等价计价',
  notDeclared: '未声明（api 默认）',
  noAgentsYet: '还没有已知的 agent —— 一次扫描会先把它们登记，之后才能在这里声明计费方式。',
  savedInLead: '已保存到',
  savedInMid: '，这个文件正是',
  savedInTail: '读取的同一份，因此终端与本页面不可能不一致。没有定价的模型仍然显示 未定价，绝不会是 $0 —— 计费方式说的是现金，不是价格（§8）。',
  noDbLead: '这台服务器启动时没有指定数据库文件，因此它没有地方保存声明。请改用',
  noDbTail: '来声明计费方式。',

  dataSources: '数据源',
  dataSourcesInfo: '对采集器已采集过的数据源做存在性检查 —— 这里没有任何统计数字。',
  sourcesKnown: '已知数据源',
  unreachable: '读不到',
  dirsEmptied: '被保留策略清空的目录',
  eventlessSessions: '没有事件的会话',

  appearance: '外观',
  browserOnly: '只保存在当前浏览器里。',
  systemFollow: '系统主题跟随操作系统 —— 当前为 {resolved}。',
  colorTheme: '配色主题',
  themeSystem: '跟随系统',
  themeLight: '浅色',
  themeDark: '深色',
  resolvedLight: '浅色',
  resolvedDark: '深色',
})

export default { en, zh }
