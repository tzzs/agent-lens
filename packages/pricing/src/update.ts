import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { litellmRawMapToSnapshot, loadSnapshot, type PriceSnapshot } from './snapshot.ts'

export const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

export class PricingFetchError extends Error {
  override readonly name = 'PricingFetchError'
  constructor(message: string, override readonly cause?: unknown) {
    super(message)
  }
}

export interface FetchOptions {
  /** Injectable so tests (and offline runs) never touch the network. */
  fetchImpl?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>
  timeoutMs?: number
  now?: () => number
}

export async function fetchLitellmSnapshot(
  url: string = LITELLM_PRICES_URL,
  opts: FetchOptions = {},
): Promise<PriceSnapshot> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new PricingFetchError('global fetch is unavailable; Node 22+ is required')
  }
  const timeoutMs = opts.timeoutMs ?? 15_000
  let res: Response
  try {
    res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw new PricingFetchError(`failed to fetch price snapshot from ${url}: ${(e as Error).message}`, e)
  }
  if (!res.ok) {
    throw new PricingFetchError(`price snapshot fetch returned HTTP ${res.status} from ${url}`)
  }
  let text: string
  try {
    text = await res.text()
  } catch (e) {
    throw new PricingFetchError(`failed to read price snapshot body from ${url}`, e)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new PricingFetchError(`fetched price data is not valid JSON: ${(e as Error).message}`, e)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PricingFetchError('litellm price file must be a JSON object keyed by model id')
  }
  return litellmRawMapToSnapshot(raw as Record<string, unknown>, {
    fetchedAt: (opts.now ?? Date.now)(),
    source: url,
  })
}

export function writeSnapshotFile(path: string, snapshot: PriceSnapshot): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
}

/** Returns null when absent/unreadable so callers fall back to the bundled snapshot. */
export function readSnapshotFile(path: string): PriceSnapshot | null {
  try {
    return loadSnapshot(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
