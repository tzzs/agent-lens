/**
 * Display formatting copy: duration units, relative-time tails and the cost
 * basis notes `lib/format.ts` attaches as `title`.
 *
 * Deliberately absent: currency (`$` is the unit the data is in, not a locale
 * word) and absolute timestamps, which stay ISO-UTC in every locale so a
 * screenshot and a log line still agree.
 */
import { matches } from '../index.ts'

const en = {
  unitMs: '{n}ms',
  unitS: '{n}s',
  unitM: '{n}m',
  unitH: '{n}h',
  durHM: '{h}h {m}m',
  durMS: '{m}m {s}s',
  agoS: '{n}s ago',
  agoM: '{n}m ago',
  agoH: '{n}h ago',
  agoD: '{n}d ago',
  otherFold: 'Other ({n})',
  noProject: '(no project)',
  costNoPrice: 'no price available — shown as n/a, never $0 (§8)',
  costPartial: 'at least this much: some agents have no price and are excluded (§8)',
  costEstimate: 'computed from tokens × price (estimate)',
  costReported: 'the agent reported this figure itself (§8)',
  // What the session-level duration metric measures; Sessions, Agents and the session
  // page all quote it, so the explanation exists once.
  activeMetric: 'Summed time of recorded events (model calls, tool runs), each request counted once — not wall-clock time.',
}

const zh = matches(en)({
  unitMs: '{n} 毫秒',
  unitS: '{n} 秒',
  unitM: '{n} 分',
  unitH: '{n} 时',
  durHM: '{h} 时 {m} 分',
  durMS: '{m} 分 {s} 秒',
  agoS: '{n} 秒前',
  agoM: '{n} 分前',
  agoH: '{n} 小时前',
  agoD: '{n} 天前',
  otherFold: '其他（{n}）',
  noProject: '（无项目）',
  costNoPrice: '暂无价格——按 §8 显示为“未定价”，不会显示 $0',
  costPartial: '至少这么多：部分 agent 没有价格，已从合计中排除（§8）',
  costEstimate: '由 tokens × 单价计算（估算）',
  costReported: '这是 agent 自己上报的数字（§8）',
  activeMetric: '已记录事件的时长合计（模型调用、工具运行），每个请求只计一次——不是挂钟时间。',
})

export default { en, zh }
