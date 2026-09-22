/**
 * Pi traces are plain JSONL, so framing is exactly the event-model's default reader:
 * whole lines only, a trailing fragment left unconsumed (§4.3), and an undecodable
 * line yielded as a marker record so `normalize()` reports it as a `ParseFailure`
 * instead of throwing (§5.2 rule 1).
 */
import { parseJsonlRecords } from '@agentlens/event-model'

/** §5.1 `parse`. */
export const parse = parseJsonlRecords
