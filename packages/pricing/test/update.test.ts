import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  fetchLitellmSnapshot,
  PricingFetchError,
  readSnapshotFile,
  writeSnapshotFile,
  LITELLM_PRICES_URL,
} from '../src/update.ts'
import { normalizeLitellmEntries, type PriceSnapshot } from '../src/snapshot.ts'

const RAW_LITELLM = {
  sample_model_names: 'a,b',
  'claude-sonnet-5': {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    litellm_provider: 'anthropic',
    mode: 'chat',
  },
  'claude-sonnet-5-budget': { input_cost_per_token: 1.5e-6, output_cost_per_token: 7.5e-6 },
  'meta-llama/llama-4-maverick': { input_cost_per_token: 1.5e-6, output_cost_per_token: 6e-6 },
}

function fakeResponse(body: string, ok = true, status = 200): Response {
  return { ok, status, text: async () => body } as unknown as Response
}

describe('fetchLitellmSnapshot', () => {
  it('wraps a litellm flat map into a snapshot via injected fetchImpl', async () => {
    const calls: string[] = []
    const snapshot = await fetchLitellmSnapshot(LITELLM_PRICES_URL, {
      fetchImpl: async (url) => {
        calls.push(url)
        return fakeResponse(JSON.stringify(RAW_LITELLM))
      },
      now: () => 1758506400000,
    })
    expect(calls).toEqual([LITELLM_PRICES_URL])
    expect(snapshot.fetchedAt).toBe(1758506400000)
    expect(snapshot.source).toBe(LITELLM_PRICES_URL)

    const entries = normalizeLitellmEntries(snapshot, { generatedAt: snapshot.fetchedAt })
    expect(entries.map((e) => `${e.provider}/${e.model}`)).toEqual([
      'anthropic/claude-sonnet-5',
      'meta-llama/llama-4-maverick',
    ])
  })

  it('surfaces a network rejection as PricingFetchError instead of crashing', async () => {
    await expect(
      fetchLitellmSnapshot(LITELLM_PRICES_URL, {
        fetchImpl: async () => {
          throw new TypeError('network down')
        },
      }),
    ).rejects.toThrow(PricingFetchError)
  })

  it('surfaces HTTP and JSON failures as PricingFetchError', async () => {
    await expect(fetchLitellmSnapshot('x', { fetchImpl: async () => fakeResponse('', false, 500) })).rejects.toThrow(
      /HTTP 500/,
    )
    await expect(fetchLitellmSnapshot('x', { fetchImpl: async () => fakeResponse('not json') })).rejects.toThrow(PricingFetchError)
  })
})

describe('snapshot file cache (~/.agentlens/pricing/snapshot.json)', () => {
  it('round-trips a written snapshot and returns null when absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentlens-pricing-'))
    try {
      const path = join(dir, 'nested', 'snapshot.json')
      expect(readSnapshotFile(path)).toBeNull() // absent → caller falls back to bundled

      const snapshot: PriceSnapshot = {
        fetchedAt: 1758506400000,
        source: 'unit-test',
        entries: [{ model: 'claude-haiku-4-5', litellm_provider: 'anthropic', input_cost_per_token: 1e-6 }],
      }
      writeSnapshotFile(path, snapshot)
      const read = readSnapshotFile(path)!
      expect(read.entries[0]?.model).toBe('claude-haiku-4-5')
      expect(read.fetchedAt).toBe(snapshot.fetchedAt)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
