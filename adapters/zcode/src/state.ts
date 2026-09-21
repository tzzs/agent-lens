/**
 * Per-source scan state.
 *
 * ZCode's §七 mapping is per-row by construction: `parse` SQL-joins every key a row lacks
 * (`part`→message role/model, all→session root/parent/directory), so `normalize` never has
 * to remember anything to produce the right event. That is deliberate — §5.2 forbids an
 * adapter from querying, and the one cross-table link that would want a memory
 * (`tool_usage.tool_call_id` → the `part` row's `tool.start`) crosses a source boundary,
 * so it stays unlinked rather than being remembered into a wrong parent.
 *
 * What this map IS for is the frame that lost its joins: when a row arrives with no
 * `__session_*` / `__message_*` columns (the LEFT JOIN missed, or a framing shorter than
 * `parse`'s delivered it), an earlier row of the SAME source that did carry them can vouch
 * for that row's session and message attribution. That is weaker than a join and is always
 * reported in `metadata.diagnostics` (`*_inherited_from_source_state`), but it beats
 * inventing a session id out of a row ordinal, and it is strictly per-source, so nothing
 * leaks between tables.
 *
 * The order dependence is part of the trade: this path is only reached on rows whose own
 * columns are silent, i.e. rows a re-scan from zero and a resumed scan already disagree
 * about. It can never change the output of a normally-framed store, which is what §4.2's
 * replay guarantee actually covers.
 *
 * Rescan safety (§4.2): a full rescan restarts at rowid 1, so a non-increasing seq means
 * "this source is being replayed" and the map is rebuilt, keeping a replay's inherited
 * attributions byte-identical to the first pass.
 */
export interface SessionAttrs {
  rootSessionId: string | null
  parentSessionId: string | null
  directory: string | null
  version: string | null
}

export interface MessageAttrs {
  role: string | null
  kind: string | null
  origin: string | null
  modelId: string | null
  providerId: string | null
  variant: string | null
}

export class ScanState {
  private lastSeq = 0
  private readonly sessions = new Map<string, SessionAttrs>()
  private readonly messages = new Map<string, MessageAttrs>()

  observes(rawSeq: number): void {
    if (rawSeq <= this.lastSeq) this.reset()
    this.lastSeq = rawSeq
  }

  private reset(): void {
    this.sessions.clear()
    this.messages.clear()
  }

  /** Records only what this row actually states; absent fields must not overwrite facts. */
  noteSession(nativeSessionId: string, attrs: SessionAttrs): void {
    const seen = this.sessions.get(nativeSessionId) ?? {
      rootSessionId: null,
      parentSessionId: null,
      directory: null,
      version: null,
    }
    this.sessions.set(nativeSessionId, {
      rootSessionId: attrs.rootSessionId ?? seen.rootSessionId,
      parentSessionId: attrs.parentSessionId ?? seen.parentSessionId,
      directory: attrs.directory ?? seen.directory,
      version: attrs.version ?? seen.version,
    })
  }

  session(nativeSessionId: string | null | undefined): SessionAttrs | undefined {
    return nativeSessionId ? this.sessions.get(nativeSessionId) : undefined
  }

  noteMessage(messageId: string, attrs: MessageAttrs): void {
    const seen = this.messages.get(messageId)
    if (!seen) {
      this.messages.set(messageId, attrs)
      return
    }
    this.messages.set(messageId, {
      role: attrs.role ?? seen.role,
      kind: attrs.kind ?? seen.kind,
      origin: attrs.origin ?? seen.origin,
      modelId: attrs.modelId ?? seen.modelId,
      providerId: attrs.providerId ?? seen.providerId,
      variant: attrs.variant ?? seen.variant,
    })
  }

  message(messageId: string | null | undefined): MessageAttrs | undefined {
    return messageId ? this.messages.get(messageId) : undefined
  }
}

const states = new Map<string, ScanState>()

export function stateFor(sourceId: string): ScanState {
  let s = states.get(sourceId)
  if (!s) {
    s = new ScanState()
    states.set(sourceId, s)
  }
  return s
}

export function forgetState(sourceId: string): void {
  states.delete(sourceId)
}
