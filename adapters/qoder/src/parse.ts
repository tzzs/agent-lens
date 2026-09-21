/**
 * Qoder session files are plain JSONL (the fork shares Claude's framing), so
 * `parse` is exactly the collector's default reader: whole lines only, a
 * trailing fragment left unconsumed (§4.3), an unparseable line yielded as a
 * marker record so `normalize()` reports a `ParseFailure` instead of throwing
 * (§5.2 rule 1).
 */
import { parseJsonlRecords } from '@agentlens/collector'

/** §5.1 `parse`. */
export const parse = parseJsonlRecords
