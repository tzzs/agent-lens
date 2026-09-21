import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// §5.4 lists the arrows and closes with "Adapter 之间不得互相引用". A prose rule
// nobody checks drifts the first time an adapter reaches for a neighbour's helper,
// so the import graph itself is asserted here. Only src/ counts: a test may seed the
// database directly, which is not a product dependency.
const ROOT = new URL('../../..', import.meta.url).pathname

// Discovered from the filesystem, not a hand-written list: an eighth adapter has to
// be covered the day it appears, which a map someone must remember to update is not.
function packageDirs(): Record<string, string> {
  const dirs: Record<string, string> = {}
  for (const group of ['packages', 'adapters', 'apps']) {
    for (const entry of readdirSync(join(ROOT, group))) {
      const dir = `${group}/${entry}`
      if (!statSync(join(ROOT, dir), { throwIfNoEntry: false })?.isDirectory()) continue
      const name = entry
      dirs[dir] = group === 'adapters' ? `adapter-${name}` : name
    }
  }
  return dirs
}

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) tsFiles(full, acc)
    else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

const PACKAGE_OF = packageDirs()
const KNOWN_PACKAGES = new Set(Object.values(PACKAGE_OF))

function importEdges(): { from: string; to: string; file: string }[] {
  const edges: { from: string; to: string; file: string }[] = []
  for (const [dir, from] of Object.entries(PACKAGE_OF)) {
    const src = join(ROOT, dir, 'src')
    if (!statSync(src, { throwIfNoEntry: false })?.isDirectory()) continue
    for (const file of tsFiles(src)) {
      const text = readFileSync(file, 'utf8')
      for (const found of text.matchAll(/from\s+['"]@agentlens\/([\w-]+)['"]/g)) {
        const to = found[1]
        if (to && KNOWN_PACKAGES.has(to)) edges.push({ from, to, file: file.slice(ROOT.length) })
      }
    }
  }
  return edges
}

type Edge = { from: string; to: string; file: string }

const violations = (edges: Edge[], allowed: (e: Edge) => boolean) =>
  edges.filter((e) => !allowed(e)).map((e) => `${e.file}: ${e.from} → ${e.to}`)

describe('§5.4 dependency arrows', () => {
  const edges = importEdges().filter((e) => e.from !== e.to)

  it('event-model sits at the bottom and imports nothing internal', () => {
    expect(violations(edges, (e) => e.from !== 'event-model')).toEqual([])
  })

  it('adapters never reference each other', () => {
    expect(violations(edges, (e) => !e.from.startsWith('adapter-') || !e.to.startsWith('adapter-'))).toEqual([])
  })

  // §5.4: the only arrow an adapter may take is `adapters → event-model`.
  // collector is the scheduler that consumes adapters, so an adapter importing
  // it closes a package-level cycle. The framing helpers adapters need
  // (walkForFiles, parseJsonlRecords, readIncremental, PARSE_ERROR_KEY…) moved
  // to event-model to make this enforceable, and no adapter is exempt.

  it('adapters import event-model only: never collector (their consumer), never each other', () => {
    expect(
      violations(edges, (e) => !e.from.startsWith('adapter-') || e.to === 'event-model'),
    ).toEqual([])
  })

  it('core packages cannot reach into an adapter, which is how agents stay pluggable', () => {
    expect(violations(edges, (e) => e.from.startsWith('adapter-') || !e.to.startsWith('adapter-'))).toEqual([])
  })

  it('storage/pricing do not depend on the layers built on top of them', () => {
    const below = new Set(['event-model', 'collector'])
    expect(
      violations(
        edges,
        (e) =>
          !(e.from === 'storage' || e.from === 'pricing') ||
          below.has(e.to) ||
          (e.from === 'pricing' && e.to === 'storage'),
      ),
    ).toEqual([])
  })

  it('query does not depend on the surfaces that consume it', () => {
    expect(violations(edges, (e) => e.from !== 'query' || !['server', 'cli', 'web'].includes(e.to))).toEqual([])
  })
})
