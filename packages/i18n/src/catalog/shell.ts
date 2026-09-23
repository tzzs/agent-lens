/**
 * The app shell (`App.svelte`): the §10 navigation, the live-stream chip and the
 * route-not-found panel. Nav labels are short because the sidebar is 15rem wide
 * and Chinese needs the tighter word more than English does.
 */
import { matches } from '../index.ts'

const en = {
  skipToContent: 'Skip to content',
  brand: 'AgentLens',
  navOverview: 'Overview',
  navExplore: 'Explore',
  navSessions: 'Sessions',
  navProjects: 'Projects',
  navAgents: 'Agents',
  navAnalyze: 'Analyze',
  navCapabilities: 'Capabilities',
  navUsage: 'Usage',
  navModels: 'Models',
  navSystem: 'System',
  navDoctor: 'Doctor',
  navSettings: 'Settings',
  openNav: 'Open navigation',
  closeNav: 'Close navigation',
  primaryNav: 'Primary',
  live: 'Live',
  offline: 'Offline',
  liveTitle: 'Streaming · {events} events · latest {ago}',
  offlineTitle: 'Live stream not connected',
  unknownPageStart: 'Unknown page',
  unknownPageEnd: '. Pick one from the navigation.',
}

const zh = matches(en)({
  skipToContent: '跳到主要内容',
  brand: 'AgentLens',
  navOverview: '总览',
  navExplore: '浏览',
  navSessions: '会话',
  navProjects: '项目',
  navAgents: 'Agents',
  navAnalyze: '分析',
  navCapabilities: '能力调用',
  navUsage: '用量',
  navModels: '模型',
  navSystem: '系统',
  navDoctor: '体检',
  navSettings: '设置',
  openNav: '打开导航',
  closeNav: '关闭导航',
  primaryNav: '主导航',
  live: '实时',
  offline: '离线',
  liveTitle: '正在接收 · {events} 条事件 · 最近一条 {ago}',
  offlineTitle: '实时流未连接',
  unknownPageStart: '未知页面',
  unknownPageEnd: '，请从左侧导航中选择。',
})

export default { en, zh }
