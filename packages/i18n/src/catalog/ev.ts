/**
 * Timeline event-type wording (`lib/eventKinds.ts`). Only the *category* of an
 * event is translated — `tool.bash` keeps "bash", because that is a name the
 * agent chose, not a word this UI explains.
 */
import { matches } from '../index.ts'

const en = {
  user: 'user',
  assistant: 'assistant',
  tool: 'tool',
  skill: 'skill',
  mcp: 'mcp',
  plugin: 'plugin',
  connector: 'connector',
  command: 'command',
  subagent: 'subagent',
  hook: 'hook',
  generation: 'gen',
  compact: 'compact',
  error: 'error',
  event: 'event',
  groupMessage: 'Messages',
  groupTool: 'Tools',
  groupAgent: 'Subagents',
  groupContext: 'Compaction',
  groupError: 'Errors',
  groupOther: 'Other',
}

const zh = matches(en)({
  user: '用户',
  assistant: '助手',
  tool: '工具',
  skill: '技能',
  mcp: 'MCP',
  plugin: '插件',
  connector: '连接器',
  command: '命令',
  subagent: '子代理',
  hook: '钩子',
  generation: '生成',
  compact: '压缩',
  error: '错误',
  event: '事件',
  groupMessage: '消息',
  groupTool: '工具',
  groupAgent: '子代理',
  groupContext: '上下文压缩',
  groupError: '错误',
  groupOther: '其他',
})

export default { en, zh }
