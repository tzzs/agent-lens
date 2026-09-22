/**
 * `capabilities` namespace — every string this page shows. Owners: see the page file
 * beside it; `en` is the wording the terminal and the API docs also quote, so
 * reword it with the §14 rule in mind, not casually.
 */
import { matches } from '../index.ts'

const en = {
  title: 'Capabilities',
}

const zh = matches(en)({
  title: '能力调用',
})

export default { en, zh }
