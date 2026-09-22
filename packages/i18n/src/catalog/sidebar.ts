/**
 * Sidebar footer: the two viewer preferences this browser owns (colour theme and
 * language) plus the local-first promise.
 *
 * `langEnglish`/`langChinese` are deliberately identical in both catalogs: a
 * language switcher that names its options in the language you cannot read is
 * useless, so each stays in its own script. They are short because the row shares
 * the sidebar's 15rem with its own label.
 */
import { matches } from '../index.ts'

const en = {
  tagline: 'Agent activity center',
  theme: 'Theme',
  themeAria: 'Color theme',
  themeSystem: 'System',
  themeLight: 'Light',
  themeDark: 'Dark',
  lang: 'Language',
  langAria: 'Interface language',
  langSystem: 'Auto',
  langEnglish: 'EN',
  langChinese: '中文',
  localFirst: 'Loopback only · no telemetry · nothing leaves this machine',
}

const zh = matches(en)({
  tagline: 'Agent 活动中心',
  theme: '主题',
  themeAria: '配色主题',
  themeSystem: '跟随系统',
  themeLight: '浅色',
  themeDark: '深色',
  lang: '语言',
  langAria: '界面语言',
  langSystem: '自动',
  langEnglish: 'EN',
  langChinese: '中文',
  localFirst: '仅监听回环地址 · 无遥测 · 数据不出本机',
})

export default { en, zh }
