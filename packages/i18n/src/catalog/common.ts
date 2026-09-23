/**
 * Tokens shared by every surface: the two "no value" glyphs and the plural
 * helper. `na` is a product rule, not a word — §8 says an unpriced figure reads
 * as "not priced", never as free, so it stays distinct from a real zero.
 */
import { matches } from '../index.ts'

const en = {
  na: 'n/a',
  dash: '—',
  yes: 'yes',
  no: 'no',
  copy: 'Copy',
  copied: 'Copied',
  // The §7 trend buckets are named by the API, so English reads back the raw unit.
  granDay: 'day',
  granWeek: 'week',
  granMonth: 'month',
}

const zh = matches(en)({
  na: '未定价',
  dash: '—',
  yes: '是',
  no: '否',
  copy: '复制',
  copied: '已复制',
  granDay: '天',
  granWeek: '周',
  granMonth: '月',
})

export default { en, zh }
