/**
 * §5.1 `parse` — Codex rollout files are plain JSONL, so framing is exactly the
 * event-model's default reader: whole lines only, a trailing fragment left unconsumed (§4.3), and an undecodable line yielded as a parse-error marker record so
 * `normalize()` reports a `ParseFailure` instead of throwing (§5.2 rule 1).
 *
 * Re-exported rather than wrapped because the generator contract
 * (`RecordStream = AsyncGenerator<RawRecord, ParseTail>`) is framing-only: everything
 * Codex-specific belongs in `normalize`.
 */
import { parseJsonlRecords } from '@agentlens/event-model'

export const parse = parseJsonlRecords
