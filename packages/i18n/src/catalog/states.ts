/**
 * The shared loading / error surface (`StatePanel`, `Loading`, `Alert`).
 *
 * `requestFailed` is the frame only: the server's own error text is rendered
 * beside it verbatim, in every locale, because it carries paths and query detail
 * a user pastes when reporting a bug.
 */
import { matches } from '../index.ts'

const en = {
  loading: 'Loading',
  requestFailed: 'Request failed',
  refreshFailed: 'Refresh failed.',
  showingLast: 'showing the last values the server reported.',
  showingLastNumbers: 'showing the last good numbers.',
  dismiss: 'Dismiss',
  contentOffTitle: 'Content layer is off.',
}

const zh = matches(en)({
  loading: '加载中',
  requestFailed: '请求失败',
  refreshFailed: '刷新失败。',
  showingLast: '仍显示服务器上一次报告的值。',
  showingLastNumbers: '仍显示上一次的正确数字。',
  dismiss: '关闭',
  contentOffTitle: '内容层已关闭。',
})

export default { en, zh }
