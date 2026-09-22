/**
 * The explanatory notes the API used to send as English sentences.
 *
 * Every key here is a code in `packages/server/src/notes.ts`; the server names the
 * fact, this file words it, and `apps/web/test/server-notes.test.ts` holds the two
 * lists in step. The English values are the removed sentences verbatim — a user
 * reading the dashboard in English must not see a word change from this move, and
 * the cost note is deliberately asserted to still name `cost_total`, which is what
 * `packages/server/test/cost.test.ts` used to check before the sentence moved.
 *
 * `probeError` and `catalogUnreadable` carry the server's own diagnostic text in
 * `{detail}`: paths and OS error strings are not translated, because a user pastes
 * them when reporting a bug.
 */
import { matches } from '../index.ts'

const en = {
  dedupRequestMax: 'deduped by request_id (MAX per request, then SUM) — §3.1 invariant',
  noPriceTable:
    'no price table injected — api-equivalent and actual are n/a (§8: an unknown price must never render as $0); cost_total covers only reported slices',
  fusedFormula:
    'cost_total (cube, §18 row 1) = agent-reported cost where the agent reported one + priced tokens for the never-reported part, NULL when neither; api-equivalent = all tokens x price (per-agent §18 fold), actual = billing mode applied to it (subscription/local real cash is 0)',
  notDetected: 'not detected on this machine',
  dataRootUnreadable: 'data root is not readable by this process',
  adapterNotInstalled: 'its adapter package is not installed in this build (history stays queryable)',
  probeError: '{detail}',
  noCatalogInjected: 'no capability catalog injected in this build (adapters expose capabilities() from M6)',
  catalogUnreadable: 'capability catalog unreadable: {detail}',
  catalogCounts: '{installed} catalogued entries · {neverUsed} never observed in the event stream',
  contentOn: 'content layer on: timelines show message/tool text',
  contentOff: 'content layer off (the default; scan with --content) or expired: timelines are metrics-only, statistics unaffected',
  contentPresent: 'content layer present for this session',
  contentWithheldByParam:
    'content layer present; payload text withheld by `payloads=0`, fetch it per node from /api/sessions/:id/nodes/:nodeId/payloads',
  contentMissing: 'content layer off or expired (payload TTL) — metrics-only timeline; re-scan with --content to capture message/tool text',
  canonicalRootFold:
    'One row per canonical repo root (§4.1): worktrees and subdirectories fold into the parent project, so a row can cover several paths',
  naMeansUnpriced: 'cost shown as n/a when a model has no price: §8 forbids reading an unknown price as $0',
}

const zh = matches(en)({
  dedupRequestMax: '按 request_id 去重（每个请求取 MAX，再求和）—— §3.1 的不变量',
  noPriceTable:
    '未注入价格表——api-equivalent 与 actual 都显示为未定价（§8：未知的价格绝不能显示成 $0）；cost_total 只覆盖已上报的那部分',
  fusedFormula:
    'cost_total（立方体，§18 第 1 行）= agent 自己上报的费用（凡上报过的部分）+ 未上报部分按 token 计价，两者都没有时为 NULL；api-equivalent = 全部 tokens × 单价（按 agent 套用 §18 折叠规则），actual = 在其上应用计费模式（订阅制与本地模型的真实现金支出为 0）',
  notDetected: '本机未检测到',
  dataRootUnreadable: '本进程读不到该数据目录',
  adapterNotInstalled: '当前构建里没有安装它的 adapter 包（历史数据仍可查询）',
  probeError: '{detail}',
  noCatalogInjected: '当前构建没有注入能力目录（adapter 从 M6 起提供 capabilities()）',
  catalogUnreadable: '能力目录读取失败：{detail}',
  catalogCounts: '目录里共 {installed} 项 · 其中 {neverUsed} 项在事件流里从未出现',
  contentOn: '内容层已开启：时间线会显示消息/工具文本',
  contentOff: '内容层关闭（默认值，需带 --content 扫描）或已过期：时间线只有指标，统计数据不受影响',
  contentPresent: '这个会话有内容层数据',
  contentWithheldByParam: '内容层存在；本次请求带 `payloads=0` 未取正文，可按节点从 /api/sessions/:id/nodes/:nodeId/payloads 获取',
  contentMissing: '内容层已关闭或过期（payload TTL）——时间线只有指标；用 --content 重新扫描才能采集消息/工具文本',
  canonicalRootFold: '一行对应一个规范化的仓库根目录（§4.1）：worktree 与子目录都会折叠进父项目，所以一行可能覆盖多个路径',
  naMeansUnpriced: '模型没有价格时费用显示为未定价：§8 禁止把未知价格读成 $0',
})

export default { en, zh }
