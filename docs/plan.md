> **存档说明**：本文件是 2026-09-21 之前的原始思路记录，保留不改。
> 实施依据请看 **`plan-v2.md`（当前方案，已按 `research/claude-code.md` 的实测修订）**。
> 本文中的若干判断已被实测推翻，典型是「Claude Code 会剥离 usage 字段」与「Skill 调用可由工具调用计数」两处。

我觉得这个方向**是成立的，而且和 Langfuse / Phoenix 的产品哲学其实不一样**。

如果按照你现在的需求来做，我不会把它设计成“另一个 Langfuse”，而会把它定义成：

> **Local-first Universal Agent Observability**
>
> 自动发现电脑上的各种 Agent → 读取它们已有的本地日志/数据库 → 统一成 Agent Event → SQLite → CLI + Web Dashboard。

核心价值不是“帮 Agent 上报 Trace”，而是：

> **不改 Agent、不接 SDK、不要求用户埋点，就能看清楚这台机器上的所有 Agent 到底干了什么、用了多少 Token、花了多少钱、调用了哪些 Tool / Skill / MCP / Plugin / Connector。**

---

# 一、我认为产品应该先确定一个非常清晰的定位

可以暂时叫：

**AgentLens / AgentScope / AgentWatch / Agent Observatory**

我个人更倾向于类似：

> **AgentScope — Universal Local Observability for AI Agents**

一句话：

> **See everything your AI agents do. Locally.**

---

# 二、核心产品模型

不要把 Agent 当成产品的最顶层。

我建议建立：

```text
Machine
 ├── Agents
 │    ├── Claude Code
 │    ├── Codex
 │    ├── Qoder
 │    ├── OpenCode
 │    └── WorkBuddy
 │
 ├── Projects
 │    ├── agentx
 │    ├── skillbox
 │    └── ...
 │
 └── Sessions
      ├── Session A
      ├── Session B
      └── Session C
```

然后每个 Session 里面：

```text
Session
 │
 ├── Model
 │
 ├── Messages
 │
 ├── Token Usage
 │
 ├── Tool Calls
 │
 ├── Skills
 │
 ├── MCP
 │
 ├── Plugins
 │
 ├── Connectors
 │
 ├── Subagents
 │
 └── Commands
```

所以真正的核心数据结构应该是：

```text
Agent
Project
Session
Event
```

其中 **Event 是整个系统的核心。**

---

# 三、不要直接设计“Token 表”，而应该设计统一 Event Model

这是整个项目最重要的一步。

例如：

```json
{
  "id": "evt_01...",
  "timestamp": "2026-09-20T18:32:12Z",

  "agent": {
    "id": "claude-code",
    "name": "Claude Code",
    "version": "1.0.0"
  },

  "project": {
    "id": "agentx",
    "path": "/Users/tanzz/workspaces/agentx"
  },

  "session": {
    "id": "sess_123"
  },

  "type": "tool_call",

  "model": {
    "provider": "anthropic",
    "name": "claude-opus-4-1"
  },

  "usage": {
    "input_tokens": 1200,
    "output_tokens": 530,
    "cache_read_tokens": 3000,
    "cache_write_tokens": 0,
    "reasoning_tokens": 0
  },

  "tool": {
    "type": "skill",
    "name": "git"
  },

  "metadata": {}
}
```

但实际上我建议进一步抽象。

---

# 四、Event Type 不要只做 Tool

可以设计成：

```text
AgentEvent
│
├── session.start
├── session.end
│
├── message.user
├── message.assistant
│
├── generation.start
├── generation.end
│
├── tool.start
├── tool.end
│
├── skill.invoke
│
├── mcp.invoke
│
├── plugin.invoke
│
├── connector.invoke
│
├── subagent.start
├── subagent.end
│
├── command.execute
│
└── error
```

这样以后就不会出现：

> “Claude Code 的 Skill 和 Codex 的 Skill 数据结构不一样怎么办？”

因为 Adapter 负责把它们转换成统一事件。

---

# 五、然后再建立 Capability Model

这里我觉得可以做得比现有工具更漂亮。

因为：

```text
Skill
MCP
Plugin
Connector
Tool
Command
Subagent
```

实际上都是：

> **Agent Capability Invocation**

所以统一：

```text
Capability
│
├── type
│   ├── tool
│   ├── skill
│   ├── mcp
│   ├── plugin
│   ├── connector
│   ├── command
│   └── subagent
│
├── provider
├── name
├── version
└── invocation
```

例如：

```text
Skill
  claude-code
  └── commit

MCP
  github
  └── create_pull_request

Connector
  slack
  └── send_message

Plugin
  figma
  └── get_design_context
```

最终 Dashboard 就可以统一回答：

> **Agent 到底使用了哪些能力？**

---

# 六、统计维度要设计成一个“多维数据立方体”

这是你这个项目真正有价值的地方。

用户不应该只能看到：

> Claude Code：$2.31

而应该可以任意切：

```text
Time
Agent
Project
Session
Model
Provider
Capability
Skill
MCP
Plugin
Connector
Command
Subagent
```

例如：

### Token

```text
Total Tokens

Agent
├── Claude Code      12.3M
├── Codex             8.7M
├── Qoder             3.2M
└── OpenCode          1.8M
```

再切：

```text
Project
├── agentx            9.2M
├── skillbox          5.1M
└── remote-pulse      3.4M
```

再切：

```text
Model
├── Claude Opus
├── GPT-5.6
├── GPT-5.6-mini
└── DeepSeek
```

甚至：

```text
Skill
├── git               12,421
├── code-review        3,182
├── browser             921
└── ...
```

---

# 七、Cost 一定要单独设计 Cost Engine

这里非常重要。

不要把：

```text
cost = token × price
```

直接写死。

应该：

```text
Usage
   ↓
Pricing Engine
   ↓
Cost
```

例如：

```text
Model
 ├── input price
 ├── output price
 ├── cache read price
 ├── cache write price
 └── reasoning price
```

然后：

```text
CostBreakdown
├── input
├── output
├── cache
├── reasoning
└── total
```

这样才能支持：

```text
Anthropic
OpenAI
Google
DeepSeek
MiniMax
OpenRouter
Local Model
```

以及：

```text
$0
```

的本地模型。

---

# 八、本地模型也必须支持

这一点我认为非常重要。

例如你现在：

```text
LM Studio
Qwen
Ollama
vLLM
llama.cpp
```

实际上：

```text
Token ≠ Cost
```

可以：

```text
Qwen3.5 35B
Input: 4.2M
Output: 1.1M
Cost: $0
```

以后甚至可以增加：

```text
Electricity
GPU Time
CPU Time
```

形成：

> **Compute Cost**

但这应该放到后面。

---

# 九、数据采集层是整个项目最关键的技术壁垒

不要要求用户：

```text
pip install xxx
```

然后修改：

```text
Claude Code
Codex
Qoder
```

也不要要求：

```text
OPENAI_API_KEY
LANGFUSE_PUBLIC_KEY
```

你的 Collector 应该主动寻找：

```text
~/.claude/
~/.codex/
~/.qoder/
~/.config/opencode/
...
```

发现：

```text
JSONL
SQLite
JSON
logs
cache
session files
```

然后：

```text
Parser
 ↓
Normalizer
 ↓
Agent Event
 ↓
SQLite
```

---

# 十、所以整个系统应该是 Adapter Architecture

例如：

```text
agent-monitor
│
├── core
│
├── collector
│
├── parser
│
├── normalizer
│
├── pricing
│
├── storage
│
├── server
│
└── adapters
     │
     ├── claude-code
     ├── codex
     ├── qoder
     ├── opencode
     ├── workbuddy
     ├── cursor
     └── ...
```

每一个 Agent：

```text
Adapter
├── detect()
├── discover()
├── parse()
├── normalize()
└── capabilities()
```

例如：

```typescript
interface AgentAdapter {
  id: string

  detect(): Promise<boolean>

  discover(): Promise<Source[]>

  parse(source: Source): AsyncIterable<AgentEvent>

  capabilities(): Capability[]
}
```

---

# 十一、最重要的是“增量解析”

不能每次：

```bash
agent-monitor scan
```

都把几十 GB 日志重新扫描。

应该：

```text
source
  ↓
file inode
  ↓
offset
  ↓
incremental parser
  ↓
event
```

数据库：

```text
sources
├── path
├── inode
├── size
├── last_offset
├── last_modified
└── parser_version
```

这样：

```bash
agent-monitor watch
```

可以持续运行。

---

# 十二、SQLite 非常适合你的第一版

我反而**不建议一开始 PostgreSQL + ClickHouse + Redis**。

你的目标用户很可能是：

```text
一个开发者
一台电脑
5～10 个 Agent
每天几百～几万 Event
```

SQLite 完全够。

架构：

```text
             Claude Code
                  │
             Codex / Qoder
                  │
             OpenCode...
                  │
                  ▼
          ┌───────────────┐
          │   Collectors  │
          └───────┬───────┘
                  │
                  ▼
          ┌───────────────┐
          │   Adapters    │
          └───────┬───────┘
                  │
                  ▼
          ┌───────────────┐
          │ Unified Events│
          └───────┬───────┘
                  │
                  ▼
             ┌────────┐
             │ SQLite │
             └───┬────┘
                 │
        ┌────────┴────────┐
        ▼                 ▼
       CLI             Web UI
```

甚至第一版可以做到：

```bash
agent-monitor
```

然后自动：

```text
http://localhost:xxxx
```

---

# 十三、数据库表我会这样设计

至少：

```text
agents
projects
sessions
events
models
capabilities
usage
costs
sources
subagents
```

其中 `events`：

```text
events
--------------------
id
timestamp
agent_id
project_id
session_id
parent_event_id

type
subtype

model_id

input_tokens
output_tokens
cache_read_tokens
cache_write_tokens
reasoning_tokens

capability_type
capability_name

duration_ms
status

raw_source_id
raw_offset

metadata
```

然后不要过度范式化。

对于这种分析型工具，我会允许：

```text
JSON metadata
```

存在。

---

# 十四、CLI 应该非常 Unix-like

不要把 CLI 做成一个“大而全的配置工具”。

我会设计成：

```bash
agent-monitor
```

默认打开 Dashboard。

---

### 查看状态

```bash
agent-monitor status
```

例如：

```text
Agents
────────────────────────────
Claude Code       4 sessions
Codex             7 sessions
Qoder             2 sessions
OpenCode          3 sessions

Today
────────────────────────────
Tokens            12.8M
Cost              $8.31
Sessions          16
Tool Calls        842
Skills            127
MCP Calls         93
```

---

### Token

```bash
agent-monitor usage
```

或者：

```bash
agent-monitor usage --agent claude-code
```

```bash
agent-monitor usage --project agentx
```

```bash
agent-monitor usage --since 7d
```

---

### Sessions

```bash
agent-monitor sessions
```

```bash
agent-monitor sessions --agent codex
```

---

### Skills

```bash
agent-monitor skills
```

输出：

```text
Skill                    Calls
──────────────────────────────
git                       321
code-review               182
browser                    93
commit                     81
```

---

### MCP

```bash
agent-monitor mcp
```

---

### Tools

```bash
agent-monitor tools
```

---

### Session Trace

这是一个非常重要的 CLI：

```bash
agent-monitor session <id>
```

显示：

```text
Session: sess_123
Agent: Claude Code
Project: agentx
Duration: 18m 32s
Tokens: 142K
Cost: $0.84

Timeline

18:32 user
18:32 assistant
18:33 tool → Read
18:33 tool → Bash
18:34 skill → git
18:35 mcp → github.create_pr
18:36 subagent → reviewer
...
```

---

# 十五、CLI 还应该有一个特别重要的命令

```bash
agent-monitor doctor
```

自动检查：

```text
✓ Claude Code detected
✓ Codex detected
✓ Qoder detected
✓ OpenCode detected

✓ Claude logs readable
✓ Codex logs readable
✗ Qoder database locked

✓ SQLite
✓ Pricing database

Warnings:
- Codex model pricing unavailable
- Qoder Skill metadata unavailable
```

这会极大降低用户第一次使用的门槛。

---

# 十六、Web UI 我不会模仿 Langfuse

Langfuse 的 UI 更像：

> Observability Platform

你的 UI 应该更像：

> **Agent Activity Center**

我建议左侧：

```text
────────────────────
Overview

Agents
Projects
Sessions

Usage
  Tokens
  Cost

Capabilities
  Tools
  Skills
  MCP
  Plugins
  Connectors

Subagents

────────────────────
Settings
Adapters
Pricing
Data Sources
```

---

# 十七、首页应该是 Dashboard

类似：

```text
┌─────────────────────────────────────────────┐
│ Agent Observatory                 Last 7d  │
├─────────────────────────────────────────────┤
│                                             │
│  Tokens       Cost       Sessions   Events  │
│  24.8M        $18.42     183        8.2K   │
│                                             │
├─────────────────────────────────────────────┤
│ Token Usage                                 │
│                                             │
│       ╭───────────────╮                     │
│      ╱                 ╲                    │
│ ────╯                   ╰────               │
│                                             │
├──────────────────────┬──────────────────────┤
│ Agent                │ Project              │
│                      │                      │
│ Claude Code  48%     │ agentx       39%    │
│ Codex        31%     │ skillbox     27%    │
│ Qoder        14%     │ remote-pulse 21%    │
│ OpenCode      7%     │ other        13%    │
└──────────────────────┴──────────────────────┘
```

---

# 十八、Agent 页面

点击：

```text
Claude Code
```

看到：

```text
Claude Code

Sessions       183
Tokens         12.3M
Cost           $9.82
Tool Calls     4,281
Skills         823
MCP Calls      312
Subagents      84
```

下面：

```text
Token Usage
Cost
Sessions
Models
Projects
Skills
MCP
Tools
```

---

# 十九、Project 页面其实可能比 Agent 页面更重要

比如：

```text
agentx
```

你会看到：

```text
Project: agentx

Total Usage
────────────────
Tokens       8.2M
Cost         $6.42
Sessions     72

Agents
────────────────
Claude Code
Codex
OpenCode

Models
────────────────
GPT-5.6
Claude Opus
DeepSeek

Capabilities
────────────────
Skills
MCP
Tools
Plugins

Recent Sessions
────────────────
...
```

这对于你这种**同时使用 Claude Code + Codex + OpenCode 开发同一个项目**的人非常有价值。

---

# 二十、最有意思的是 Session 页面

我认为这是产品最容易产生“Wow”的地方。

例如：

```text
Session #1837

Claude Code
agentx
42m 13s

Tokens
Input       84,123
Output      12,482
Cache       192,421
Total       289,026

Cost
$1.84
```

下面是完整 Timeline：

```text
USER
│
├── "帮我实现 Agent Router"
│
ASSISTANT
│
├── Read package.json
├── Read router.ts
├── Skill: coding
│
├── MCP: github.search
│
├── Subagent: researcher
│   ├── Web Search
│   ├── Read
│   └── Return
│
├── Edit router.ts
├── Bash: npm test
│
└── Commit
```

然后每一个节点点开：

```text
Tool Input
Tool Output
Tokens
Duration
Model
Parent
Raw Event
```

这其实已经非常接近：

> **Agent Flight Recorder**

---

# 二十一、我甚至建议增加“Replay”

例如：

```text
▶ Replay Session
```

像看录像一样：

```text
00:00 User
00:03 Claude
00:08 Read
00:12 Skill
00:19 MCP
00:28 Subagent
00:45 Edit
01:12 Test
```

这个能力会让你的产品和单纯：

```text
Token Dashboard
```

拉开很大的差距。

---

# 二十二、再往上一步，就是 Agent Cost Intelligence

第一阶段：

> “用了多少钱？”

第二阶段：

> “钱花在哪里？”

第三阶段：

> “为什么花这么多？”

例如：

```text
agentx
$6.42

Claude Code       $3.81
Codex             $1.92
Subagents         $0.51
MCP               $0.18
```

继续点：

```text
Claude Code
$3.81

coding            $1.21
debugging         $0.93
testing           $0.72
research          $0.63
```

再继续：

```text
Session #1837
$1.84

Input             $0.72
Output            $0.41
Cache             $0.32
Subagent          $0.27
Tool overhead     $0.12
```

这就从：

> Observability

逐渐变成：

> **Agent Efficiency**

---

# 二十三、但这里有一个非常重要的产品原则

**不要一开始做 Evaluation。**

也不要一开始做：

```text
Prompt Management
Dataset
Experiment
LLM Evaluation
Human Feedback
```

这些已经是 Langfuse / Phoenix 的领域。

你的第一性原理应该是：

> **Observe what already happened.**

而不是：

> Instrument what is about to happen.

---

# 二十四、所以 MVP 我会非常克制

### Phase 0

只支持：

```text
Claude Code
Codex
Qoder
OpenCode
```

并且只做：

```text
Token
Cost
Session
Project
Agent
Tool
Skill
MCP
Subagent
```

---

### Phase 1

增加：

```text
Plugin
Connector
Command
Model
Provider
Pricing
```

---

### Phase 2

增加：

```text
Session Replay
Timeline
Trace
Search
Filters
Export
```

---

### Phase 3

增加：

```text
Real-time Watch
Notifications
Cost Alerts
Usage Alerts
```

例如：

```text
⚠ Claude Code used 2.1M tokens today

⚠ agentx cost increased 240%

⚠ Qoder generated 13,000 tool calls
```

---

# 二十五、再往后才是团队版

如果未来真的做大：

```text
Local Agent Monitor
        ↓
Optional Cloud
        ↓
Team
        ↓
Organization
```

例如：

```text
Developer
   ↓
Agent Monitor
   ↓
Local SQLite

              optional

   ↓
Agent Observability Server
   ↓
Team Dashboard
```

这时候才考虑：

```text
Postgres
ClickHouse
Redis
Object Storage
OTel
```

而不是第一天就引入。

---

# 二十六、和 Langfuse 的关系应该这样处理

我甚至不会把 Langfuse 当竞争对手。

可以设计：

```text
Agent Adapter
      │
      ▼
Unified Event
      │
 ┌────┴─────────┐
 ▼              ▼
SQLite        Export
 │              │
 ▼              ▼
Web UI       Langfuse
             Phoenix
             OTel
```

也就是说：

> **你的产品负责“采集 + 统一”。**

而：

> Langfuse / Phoenix 负责“高级分析 / 企业 Observability”。

这样战略上会非常舒服。

---

# 二十七、真正的护城河其实不是 UI

我觉得这个项目最值得做的是：

## Universal Agent Adapter

因为未来：

```text
Claude Code
Codex
Qoder
OpenCode
Cursor
Windsurf
Gemini CLI
Aider
Cline
Roo Code
OpenClaw
WorkBuddy
...
```

每一个 Agent 都有自己的：

```text
日志格式
Session 格式
Tool 格式
Skill 格式
MCP 格式
Token 格式
```

你做：

```text
Agent Adapter
      ↓
Unified Agent Event
```

相当于建立一个：

> **Agent Observability Compatibility Layer**

这个东西的价值其实比一个漂亮 Dashboard 大得多。

---

# 二十八、甚至可以把 Adapter 做成插件

例如：

```bash
agent-monitor adapters
```

```text
Installed adapters

✓ claude-code
✓ codex
✓ qoder
✓ opencode
✓ workbuddy

Available

○ cursor
○ gemini-cli
○ cline
○ aider
```

然后：

```bash
agent-monitor adapter install cursor
```

未来甚至：

```text
npm package
@agent-monitor/adapter-xxx
```

---

# 二十九、我建议项目最终形成这样的结构

```text
agent-monitor/
│
├── apps/
│   ├── cli/
│   └── web/
│
├── packages/
│   ├── core/
│   ├── event-model/
│   ├── storage/
│   ├── pricing/
│   ├── collector/
│   ├── parser/
│   ├── query/
│   └── sdk/
│
├── adapters/
│   ├── claude-code/
│   ├── codex/
│   ├── qoder/
│   ├── opencode/
│   └── workbuddy/
│
└── docs/
```

核心依赖关系：

```text
             Adapters
                │
                ▼
          Event Model
                │
        ┌───────┴───────┐
        ▼               ▼
     Storage           Export
        │
        ▼
      Query
        │
   ┌────┴────┐
   ▼         ▼
  CLI       Web
```

---

# 三十、我认为第一版甚至可以做到“一条命令启动”

最终体验应该是：

```bash
npx agent-monitor
```

或者：

```bash
brew install agent-monitor
agent-monitor
```

然后：

```text
Agent Monitor

Scanning local agents...

✓ Claude Code
✓ Codex
✓ Qoder
✓ OpenCode

Found:

1,827 Sessions
42.8M Tokens
$37.21 Estimated Cost
12,821 Tool Calls
1,923 Skill Calls
482 MCP Calls

Dashboard:
http://localhost:7317
```

浏览器自动打开。

**这比让用户部署 Langfuse Docker Compose 的体验完全不是一个量级。**

---

# 三十一、我会把整个产品拆成四个核心层

最终可以形成一张非常清晰的架构：

```text
                    Agent Monitor
                         │
        ┌────────────────┼────────────────┐
        │                │                │
     COLLECT          NORMALIZE        ANALYZE
        │                │                │
        ▼                ▼                ▼
   Agent Logs       Agent Events      Metrics
   SQLite           Unified Model     Cost
   JSONL            Capability        Usage
   Database         Session           Trends
   API                                Efficiency
        │
        └────────────────┬───────────────┘
                         ▼
                    EXPERIENCE
                         │
                   ┌─────┴─────┐
                   ▼           ▼
                  CLI         Web
```

其中：

**Collector 是入口。**

**Unified Event Model 是核心。**

**SQLite 是第一版基础设施。**

**Adapter 是最大的长期资产。**

**Web UI 是用户看到的产品。**

---

# 三十二、如果是我来推进，我会按这个顺序做

不要先画完整 UI，也不要先做 20 个 Agent。

### Step 1：定义 Event Schema

先把：

```text
Session
Message
Generation
Tool
Skill
MCP
Plugin
Connector
Subagent
Command
Usage
Cost
```

全部定义出来。

这是整个项目的地基。

### Step 2：只实现两个 Adapter

我会直接：

```text
Claude Code
Codex
```

因为这两个能覆盖非常典型的 Agent 使用模式。

### Step 3：SQLite + Query Engine

做到：

```bash
agent-monitor usage
agent-monitor sessions
agent-monitor tools
agent-monitor skills
```

### Step 4：Web Dashboard

先做：

```text
Overview
Agents
Projects
Sessions
Usage
Capabilities
```

### Step 5：Qoder / OpenCode / WorkBuddy

验证 Adapter 架构是不是真的“通用”。

### Step 6：Session Timeline / Replay

这个阶段开始形成明显产品差异。

### Step 7：实时 Watch

```bash
agent-monitor watch
```

### Step 8：Cost / Efficiency

最后再做：

```text
Cost breakdown
Usage anomaly
Agent efficiency
```

---

## 最后一个关键判断

我认为这个项目**不要把自己定义成“Token Dashboard”**。

那样会被 ccusage 一类工具卡死在一个非常小的市场。

也不要定义成：

> “开源 Langfuse”

因为那样必然陷入：

```text
Docker
Postgres
ClickHouse
Redis
OTel
SDK
Tracing
Evaluation
```

这条路。

我会把它定义成：

> ### **The Activity Monitor for AI Agents**
>
> **Automatically discover your local agents and show everything they do.**

然后把产品的核心数据关系固定成：

```text
             Agent
               │
        ┌──────┴──────┐
        ▼             ▼
     Project        Model
        │
        ▼
     Session
        │
        ▼
      Event
        │
 ┌──────┼────────┬────────┬────────┐
 ▼      ▼        ▼        ▼        ▼
Tool  Skill     MCP    Plugin  Connector
```

**我觉得这才是你前面一直在讨论的 Agent Infra 地图里，比较值得独立做出来的一层：不是 Observability Backend，而是 `Agent Activity / Telemetry Collection Layer`。**

而且它和你之前想做的 **跨 Agent Memory Controller** 其实天然能连接起来：同一个 Unified Event Model 将来既可以给 Observability 用，也可以给 Memory Controller 判断“这个事件是否值得进入长期记忆”——这样两个项目的底层数据模型可以从一开始就保持兼容。
