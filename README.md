# AgentLens

The activity monitor for AI agents. `agl` reads the logs the coding agents on your
machine already write — no proxies, no SDK changes, no instrumentation — normalizes
them into one event model, stores the result in a local SQLite file, and shows you what
your agents actually did: tokens, cost, sessions, projects, tools, skills, MCP calls,
hooks, subagents.

Design and measured constraints live in [`docs/plan-v2.md`](docs/plan-v2.md).

## Detected today

Claude Code · Codex · Qoder · OpenCode · WorkBuddy · Pi · ZCode

Each one is an adapter under `adapters/`: a read-only reader plus a pure
normalizer. Adapters never write to, move or rename a source file, and they refuse to
open a third-party SQLite database that is in WAL mode (opening it would create or
rewrite `-wal`/`-shm` sidecars). Where a WAL store must be read, it is copied into this
tool's own snapshot directory first and the copy is what gets opened.

## Requirements

Node ≥ 22.13 (`node:sqlite` is used directly — no native driver to build) and pnpm 11.

## Run it

```bash
pnpm install
alias agl='node --disable-warning=ExperimentalWarning --experimental-transform-types '"$PWD"'/apps/cli/src/command-exec.ts'
agl            # scan, print the §14 summary, then serve the dashboard
```

`apps/cli/src/command-exec.ts` is the bin entry (`agentlens` / `agl`); the package is not
published to npm yet, so there is no `npx agentlens`, and the workspace runs straight from
TypeScript. The dashboard binds loopback on `http://localhost:7317`. Pass `--no-serve` to
only scan, or `--serve` to force the server even when output is piped.

```bash
agl status                      # discovered agents, source counts, today's totals
agl usage --by model --since 7d # the aggregation cube, sliced
agl sessions --agent codex
agl session <id>                # ordered timeline
agl doctor                      # data-trust report: what is missing, folded, refused
agl tools | skills | mcp | plugins | connectors | subagents | hooks
agl projects                    # one project, seen across agents
agl export --format jsonl|csv|otel [--push <otlp-url>]
agl pricing update              # refresh the litellm price snapshot
agl pricing update --source openrouter   # fill in the models litellm has no price for
agl pricing billing set <agent> api|subscription|local
agl prune --older-than 90d
```

`agl --help` lists every flag. Filters accept names or ids; `--since`/`--until` accept
`7d`, `24h`, `30m`, `2026-09-01`, `20260901` or ms epoch.

## Where your data goes

`~/.agentlens/agentlens.db`, unless `--db` says otherwise. Nothing leaves the machine:
no telemetry, no network calls. `agl export --push` is the one command that sends data
out, and only to a URL you pass.

The **content layer is off by default**. Scanning stores metrics — token counts, models,
durations, capability names, which tool ran — and not message bodies, prompt snapshots or
file contents. Opt in with `--content`, and payloads are still truncated per record and
TTL-cleaned by `agl prune`.

Anything the tool had to guess is reported rather than hidden: `agl doctor` prints
missing price tables, sources refused for WAL side effects, fold policies per agent
(`docs/plan-v2.md` §18), upstream files that no longer exist, and events whose timestamp
had to be invented at ingest time.

Each store carries one random install id, which `agl status` prints. It exists so two
databases could later be merged without guessing which rows came from where; it is not a
hostname, not derived from anything about you, and never sent anywhere.

Upgrading re-derives what the parsers already stored. When an identity or timestamp rule
changes, the first `agl scan` after the update re-reads every source once and repairs
those columns in place — about 32 seconds over 535 MB of real logs on the machine this
was measured on. Every scan after that is a no-op.

A scan also gives project rows their name back, once. Sources that are unchanged are
skipped rather than re-read, so a project recorded before naming existed would otherwise
print as a hash forever; each scan ends by proving a root for those rows, and it writes
one only when the path reproduces the hash already stored. Rows that cannot be proven
keep the hash — on this machine every codex project does, because codex records its
working directory only inside transcripts, and a guess would label a project with a
directory it never used.

## Development

```bash
pnpm test          # vitest, whole workspace including adapter fixture snapshots
pnpm typecheck     # tsc --noEmit
cd apps/web && npm run build && npx svelte-check --fail-on-warnings
```

Layout, dependency arrows (`adapters → event-model`, `cli/web → query → storage`,
adapters never referencing each other — enforced by
`packages/event-model/test/dependency-arrows.test.ts`) and the milestone plan are in
`docs/plan-v2.md` §5 and §15.
