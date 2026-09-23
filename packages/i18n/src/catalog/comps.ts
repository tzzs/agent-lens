/**
 * Strings owned by the shared components (`apps/web/src/components/**`) rather
 * than by any one page: range controls, table chrome, chart legends, the node
 * inspector. Page-specific copy stays in the page's own namespace.
 *
 * The short range pills (`24h`, `7d`, …) are display-only: the §7 `since` value
 * sent to the server is the option's key, so a locale may widen a pill without
 * changing what the query asks for.
 */
import { matches } from '../index.ts'

const en = {
  rangeTitle: 'Time range',
  range24h: '24h',
  range7d: '7d',
  range30d: '30d',
  range90d: '90d',
  range1y: '1y',
  agent: 'Agent',
  host: 'Host',
  allAgents: 'All agents',
  allHosts: 'All hosts',
  filter: 'Filter',
  all: 'All',
  noRows: 'No rows',
  list: 'List',
  refreshing: 'Refreshing',
  vsPriorPeriod: 'vs prior period',
}

const zh = matches(en)({
  rangeTitle: '时间范围',
  range24h: '24 小时',
  range7d: '7 天',
  range30d: '30 天',
  range90d: '90 天',
  range1y: '1 年',
  agent: 'Agent',
  host: '主机',
  allAgents: '全部 agent',
  allHosts: '全部主机',
  filter: '筛选',
  all: '全部',
  noRows: '无数据行',
  list: '列表',
  refreshing: '正在刷新',
  vsPriorPeriod: '较上一周期',
})

export default { en, zh }
