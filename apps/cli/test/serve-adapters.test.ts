/**
 * §14's "CLI and Web cannot disagree", pinned at the seam that broke: the web
 * Doctor's adapter rows must come from the CLI's own adapter set. Before this,
 * `@agentlens/server` tried to `import` adapter packages it does not depend on,
 * the import always failed, and `/api/doctor` answered "no adapters installed"
 * with every agent as `ingested-only` while `agl doctor` listed them all.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@agentlens/storage'
import { createApp } from '@agentlens/server'
import { getAdapters } from '../src/adapters.ts'

describe('the served Doctor uses the CLI adapter set', () => {
  let db: DatabaseSync
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'agl-serve-adapters-'))
    db = openDatabase(join(dir, 'test.db'))
    migrate(db)
  })

  afterAll(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('resolves every shipped adapter from the CLI package', async () => {
    const adapters = await getAdapters()
    expect(adapters.map((a) => a.id).sort()).toEqual(
      ['claude-code', 'codex', 'opencode', 'pi', 'qoder', 'workbuddy', 'zcode'].sort(),
    )
  })

  it('lists one detected row per adapter instead of an ingested-only fallback', async () => {
    const app = createApp({ db, now: () => 1_700_000_000_000, adapters: getAdapters })
    const res = await app.request('/api/doctor')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.adaptersInstalled).toBe(true)
    const byId = new Map(body.agents.map((r: { id: string }) => [r.id, r]))
    for (const adapter of await getAdapters()) {
      const row = byId.get(adapter.id)
      expect(row, `${adapter.id} missing from /api/doctor`).toBeDefined()
      expect(row.status).not.toBe('ingested-only')
      expect(['ok', 'not-detected']).toContain(row.status)
    }
  })
})
