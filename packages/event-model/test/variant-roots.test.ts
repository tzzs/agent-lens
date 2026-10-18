/**
 * §5.3 variant roots: the machine ran more than one store, and only the logs know.
 *
 * The measured case this comes from: a real home directory with `~/.claude` (647 MB) *and*
 * `~/.claude-deepseek` (13 MB, 6 session files, `deepseek-v4-flash`, the same usage dialect).
 * Reading only the canonical root reported a smaller world than the machine actually ran.
 *
 * Every test below is a rule from the module header, and the negative cases matter more than
 * the positive one: a wrong root attributes one store's spend to another.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostContext } from '../src/adapter.ts'
import { isVariant, rootsOf, variantRoots } from '../src/variant-roots.ts'

const temps: string[] = []

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agl-variant-roots-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

function ctxFor(homedir: string, overrides: Partial<HostContext> = {}): HostContext {
  return {
    dataRoot: null,
    homedir,
    env: {},
    readFile: async () => '',
    readDir: (path) => import('node:fs/promises').then((m) => m.readdir(path)),
    stat: async (path) => {
      const { stat } = await import('node:fs/promises')
      try {
        const s = await stat(path)
        return { size: s.size, mtimeMs: s.mtimeMs, inode: s.ino }
      } catch {
        return null
      }
    },
    ...overrides,
  }
}

/** Create a directory tree; a trailing `/` means "directory", otherwise a file with `body`. */
async function plant(root: string, spec: Record<string, string | null>): Promise<void> {
  for (const [rel, body] of Object.entries(spec)) {
    const path = join(root, rel)
    if (body === null) await mkdir(path, { recursive: true })
    else {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, body, 'utf8')
    }
  }
}

describe('variant roots (§5.3)', () => {
  it('finds a sibling root that holds the agent layout, canonical first', async () => {
    const h = await home()
    await plant(h, {
      '.claude/projects/-work/sess.jsonl': '{}\n',
      '.claude-deepseek/projects/-work/sess.jsonl': '{}\n',
      '.claude-deepseek/settings.json': '{}',
    })
    const ctx = ctxFor(h)
    const roots = await rootsOf(ctx, join(h, '.claude'), false, { markers: ['projects'] })
    expect(roots).toEqual([join(h, '.claude'), join(h, '.claude-deepseek')])
  })

  it('is sorted and replay-stable (§4.2)', async () => {
    const h = await home()
    await plant(h, {
      '.claude/projects/a.jsonl': '{}\n',
      '.claude-work/projects/a.jsonl': '{}\n',
      '.claude-deepseek/projects/a.jsonl': '{}\n',
    })
    const ctx = ctxFor(h)
    const first = await rootsOf(ctx, join(h, '.claude'), false, { markers: ['projects'] })
    const second = await rootsOf(ctx, join(h, '.claude'), false, { markers: ['projects'] })
    expect(second).toEqual(first)
    expect(first).toEqual([
      join(h, '.claude'),
      join(h, '.claude-deepseek'),
      join(h, '.claude-work'),
    ])
  })

  it('ignores a sibling with the right name but no layout marker', async () => {
    const h = await home()
    await plant(h, {
      '.claude/projects/a.jsonl': '{}\n',
      // A leftover settings folder: same name shape, nothing that makes it a store.
      '.claude-backup/settings.json': '{}',
    })
    const ctx = ctxFor(h)
    expect(await rootsOf(ctx, join(h, '.claude'), false, { markers: ['projects'] })).toEqual([
      join(h, '.claude'),
    ])
  })

  it('ignores a sibling whose name only shares the prefix (`baseball`, not `base-…`)', async () => {
    const h = await home()
    await plant(h, {
      '.claude/projects/a.jsonl': '{}\n',
      '.claudeish/projects/a.jsonl': '{}\n',
    })
    const ctx = ctxFor(h)
    expect(await rootsOf(ctx, join(h, '.claude'), false, { markers: ['projects'] })).toEqual([
      join(h, '.claude'),
    ])
  })

  it('honours notVariants so a companion install is not mistaken for a second store', async () => {
    const h = await home()
    await plant(h, {
      '.gemini/antigravity/conversations/a.pb': '',
      '.gemini/antigravity-ide/conversations/a.pb': '',
    })
    const ctx = ctxFor(h)
    const roots = await rootsOf(ctx, join(h, '.gemini'), false, {
      markers: ['antigravity/conversations'],
      notVariants: ['antigravity-ide'],
    })
    // `.gemini` itself lacks the marker and is still returned as canonical (callers decide
    // what that means); the IDE companion must not appear as a second store.
    expect(roots).not.toContain(join(h, '.gemini-antigravity-ide'))
    expect(roots).toEqual([join(h, '.gemini')])
  })

  it('skips known non-store suffixes (`-backup`, `-old`, `.bak`)', async () => {
    const h = await home()
    await plant(h, {
      '.claude/projects/a.jsonl': '{}\n',
      '.claude-backup/projects/a.jsonl': '{}\n',
      '.claude.bak/projects/a.jsonl': '{}\n',
      '.claude-old/projects/a.jsonl': '{}\n',
    })
    const ctx = ctxFor(h)
    expect(await rootsOf(ctx, join(h, '.claude'), false, { markers: ['projects'] })).toEqual([
      join(h, '.claude'),
    ])
  })

  it('is exclusive when the canonical root came from an upstream env switch (rule 3)', async () => {
    const h = await home()
    await plant(h, {
      '.claude/projects/a.jsonl': '{}\n',
      '.claude-deepseek/projects/a.jsonl': '{}\n',
    })
    const ctx = ctxFor(h)
    // `CLAUDE_CONFIG_DIR` means "this is the store", not "also look around".
    expect(await rootsOf(ctx, join(h, '.claude-deepseek'), true, { markers: ['projects'] })).toEqual([
      join(h, '.claude-deepseek'),
    ])
  })

  it('reports an unreadable parent instead of pretending there are no siblings', async () => {
    const h = await home()
    const ctx = ctxFor(h, {
      readDir: async () => {
        throw new Error('EACCES: permission denied')
      },
    })
    const { roots, skipped } = await variantRoots(ctx, {
      canonical: join(h, '.claude'),
      fromEnv: false,
      markers: ['projects'],
    })
    expect(roots).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.reason).toContain('EACCES')
  })

  it('reports a candidate it could not inspect rather than dropping it silently', async () => {
    const h = await home()
    await plant(h, { '.claude/projects/a.jsonl': '{}\n', '.claude-deepseek/': null })
    const ctx = ctxFor(h, {
      stat: async (path) => {
        if (path.includes('.claude-deepseek')) throw new Error('EIO: i/o error')
        const { stat } = await import('node:fs/promises')
        try {
          const s = await stat(path)
          return { size: s.size, mtimeMs: s.mtimeMs, inode: s.ino }
        } catch {
          return null
        }
      },
    })
    const { roots, skipped } = await variantRoots(ctx, {
      canonical: join(h, '.claude'),
      fromEnv: false,
      markers: ['projects'],
    })
    expect(roots).toEqual([])
    expect(skipped.some((s) => s.path.includes('.claude-deepseek') && s.reason.includes('EIO'))).toBe(true)
  })

  it('accepts a dot and an underscore separator as the same shape', async () => {
    const h = await home()
    await plant(h, {
      '.claude/projects/a.jsonl': '{}\n',
      '.claude.work/projects/a.jsonl': '{}\n',
      '.claude_ci/projects/a.jsonl': '{}\n',
    })
    const ctx = ctxFor(h)
    expect(await rootsOf(ctx, join(h, '.claude'), false, { markers: ['projects'] })).toEqual([
      join(h, '.claude'),
      join(h, '.claude.work'),
      join(h, '.claude_ci'),
    ])
  })

  it('matches case-insensitively on the prefix', async () => {
    const h = await home()
    await plant(h, {
      '.claude/projects/a.jsonl': '{}\n',
      '.Claude-Work/projects/a.jsonl': '{}\n',
    })
    const ctx = ctxFor(h)
    expect(await rootsOf(ctx, join(h, '.claude'), false, { markers: ['projects'] })).toContain(
      join(h, '.Claude-Work'),
    )
  })

  it('isVariant tells the canonical root from the ones it found', () => {
    expect(isVariant('/home/u/.claude', '/home/u/.claude')).toBe(false)
    expect(isVariant('/home/u/.claude/', '/home/u/.claude')).toBe(false)
    expect(isVariant('/home/u/.claude', '/home/u/.claude-deepseek')).toBe(true)
  })
})
