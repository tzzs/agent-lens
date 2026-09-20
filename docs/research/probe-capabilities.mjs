#!/usr/bin/env node
/**
 * 跨 Agent 能力普查（§17 第 5 项）：对 JSONL 型 Agent 统计
 *   - MCP：mcp__ 工具名 / mcp 关键字 / mcp server 名
 *   - compaction：compact / compaction / compacted / replacement_history
 *   - hook 类事件：hook / PreToolUse / PostToolUse
 *   - subagent：isSidechain / agentId / spawn_agent / thread_source=subagent
 * 用法: node docs/research/probe-capabilities.mjs <agentName> <jsonlRoot...>
 * 只读。
 */
import fs from 'node:fs'; import path from 'node:path'
const [agent, ...roots] = process.argv.slice(2)
if (!agent || !roots.length) { console.error('用法: node probe-capabilities.mjs <agentName> <jsonlRoot...>'); process.exit(2) }
function* walk(d){ try{ for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name); if(e.isDirectory())yield* walk(p); else if(e.name.endsWith('.jsonl'))yield p} }catch{} }
const M={mcpToolName:0,mcpServer:new Set(),compaction:0,compacted:0,replacement:0,hookEvent:0,hookNames:new Map(),subagent:0,sidechain:0,spawnAgent:0,skillListing:0,mcpInstructions:0,deferredTools:0,total:0}
for(const r of roots){ if(!fs.existsSync(r))continue
  for(const f of walk(r)){
    let text; try{text=fs.readFileSync(f,'utf8')}catch{continue}
    for(const line of text.split('\n')){ if(!line)continue; let rec; try{rec=JSON.parse(line)}catch{continue} M.total++
      const j=line
      const c=rec.payload?.content||rec.message?.content
      if(Array.isArray(c))for(const b of c){ if(b?.type==='tool_use'&&/^mcp__/.test(b.name||'')){M.mcpToolName++; const seg=b.name.split('__'); if(seg[1])M.mcpServer.add(seg[1])} }
      if(rec.payload?.type==='function_call'&&/^mcp/.test(rec.payload?.name||''))M.mcpToolName++
      if(/"name":"mcp__|mcp__/.test(j))M.mcpToolName++
      if(/compact_boundary|"type":"compaction"|"compacted"|replacement_history|time_compacting|context_compaction/.test(j))M.compaction++
      if(/"hook"|"hookName"|"hookEvent"|PreToolUse|PostToolUse|SessionStart/.test(j)){M.hookEvent++; const m=j.match(/"(?:hookName|hookEvent)"\s*:\s*"([^"]{0,40})"/); if(m)M.hookNames.set(m[1],(M.hookNames.get(m[1])??0)+1)}
      if(/isSidechain":true|"thread_source":"subagent"|spawn_agent|"agentId"/.test(j))M.subagent++
      if(rec.isSidechain)M.sidechain++
      if(/"name":"(spawn_agent|Task|Agent)"/.test(j))M.spawnAgent++
      if(/skill_listing|"invoked_skills"/.test(j))M.skillListing++
      if(/mcp_instructions/.test(j))M.mcpInstructions++
      if(/deferred_tools/.test(j))M.deferredTools++
    }
  }
}
console.log(`agent=${agent}  jsonl records scanned=${M.total}`)
console.log(`  MCP:  mcp__工具引用≈${M.mcpToolName}  server名(${M.mcpServer.size}): ${[...M.mcpServer].slice(0,12).join(', ')||'—'}  mcp_instructions=${M.mcpInstructions}  deferred_tools=${M.deferredTools}`)
console.log(`  compaction: ${M.compaction}   hook事件引用: ${M.hookEvent}  hookName样本: ${JSON.stringify(Object.fromEntries([...M.hookNames].sort((a,b)=>b[1]-a[1]).slice(0,6)))}`)
console.log(`  subagent标记: ${M.subagent}  isSidechain: ${M.sidechain}  spawn/Task/Agent 工具: ${M.spawnAgent}  skill_listing/invoked_skills: ${M.skillListing}`)
