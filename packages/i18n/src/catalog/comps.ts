/**
 * Strings owned by the shared components (`apps/web/src/components/**`) rather
 * than by any one page: range controls, table chrome, chart legends, the node
 * inspector. Page-specific copy stays in the page's own namespace.
 */
import { matches } from '../index.ts'

const en = {
  rangeTitle: 'Time range',
}

const zh = matches(en)({
  rangeTitle: '时间范围',
})

export default { en, zh }
