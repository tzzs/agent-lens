/**
 * §5.4 draws the arrows; this file guards the failure mode the arrows cannot express.
 *
 * `dependency-arrows.test.ts` asserts which packages may import which, and for the adapters and
 * core packages that is enough. It is structurally blind to the case that bit §14 four times in
 * one round: `apps/cli` and `packages/server` are *allowed* to import the same helper, so nothing
 * stopped them from each writing their own version of a rule instead — the pricing merge, the host
 * split, the canonical timeline order and the project label each existed twice, and every one of
 * them produced a different number on the same database. The arrow check cannot see that because
 * there is no illegal import in it: the duplication is in the direction the arrows permit.
 *
 * So each rule that owes one answer gets an owner here plus the literals that mean "someone
 * re-implemented it". Adding a rule is one entry in the table; the checks are deliberately
 * syntactic and slightly over-eager, because the cost of a false alarm (move a line, or add the
 * rule to its owner and call it) is far below the cost of two surfaces disagreeing about a figure
 * the user is being asked to trust.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = new URL('../../..', import.meta.url).pathname

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) tsFiles(full, acc)
    else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

/** The surfaces §5.4 lets consume shared rules — the two ends §14 says must never disagree. */
const SURFACES = ['apps/cli/src', 'packages/server/src'].map((dir) => ({
  dir,
  files: tsFiles(join(ROOT, dir)).map((file) => ({ file: file.slice(ROOT.length), text: readFileSync(file, 'utf8') })),
}))

interface Rule {
  /** What the rule answers, for the failure message. */
  what: string
  /** Package + export that owns the answer. */
  home: string
  /** Writing this in a surface means the owner was bypassed. */
  forbidden: { re: RegExp; why: string }[]
}

const RULES: Rule[] = [
  {
    what: 'the price table a figure is computed against (snapshot + user overrides)',
    home: '@agentlens/pricing → loadMergedPricing',
    forbidden: [
      { re: /pricing-overrides\.jsonl/, why: 'the override filename belongs to the merge, and a copy diverges from the file the other surface reads' },
      { re: /price-snapshot\.json/, why: 'same reason, for the snapshot path' },
      { re: /\.withOverride\(/, why: 'merging line-by-line here is how the CLI and served doctor came apart (433/6 vs 432/11)' },
    ],
  },
  {
    what: 'whether a host distribution deserves a warning, and how dominant it is',
    home: '@agentlens/storage → hostSplitFor / pickHostWarning / pickHostSplit',
    forbidden: [
      { re: /share\s*(?:<=|<|>=|>)\s*0\.\d/, why: 'a threshold written here is a second rule; §14 had 0.8 in the terminal and 0.5 in the server' },
      { re: /HOST_SKEW/, why: 'the constant moved to the shared owner' },
    ],
  },
  {
    what: 'the order a session timeline is read in',
    home: '@agentlens/storage → loadSessionEvents / SESSION_EVENT_SQL',
    forbidden: [
      { re: /raw_seq IS NULL/, why: 're-sorting per surface is exactly the drift §19 records for Web vs CLI session order' },
    ],
  },
]

describe('§14: one owner per shared rule, surfaces may not re-implement it', () => {
  for (const rule of RULES) {
    it(`${rule.what}: no surface re-implements ${rule.home}`, () => {
      const hits: string[] = []
      for (const surface of SURFACES) {
        for (const file of surface.files) {
          for (const { re, why } of rule.forbidden) {
            if (re.test(file.text)) hits.push(`${file.file} matches ${re} — ${why}`)
          }
        }
      }
      expect(hits, `${rule.home} owns this rule`).toEqual([])
    })
  }

  it('the surfaces are still enumerated from disk, so a new one is covered automatically', () => {
    // A guard that quietly stops matching files is worse than no guard: it reads as green.
    for (const surface of SURFACES) {
      expect(surface.files.length, `${surface.dir} should contain sources`).toBeGreaterThan(5)
    }
    expect(SURFACES.flatMap((s) => s.files).some((f) => /pricing-store|serve|banners/.test(f.file))).toBe(true)
  })

  it('the owner exports are actually importable, so the rule has somewhere to go', () => {
    // Guards the guard: the failure message tells people to "use the owner", which is only a
    // fix if the owner really publishes the symbol.
    const owners: { pkg: string; names: string[] }[] = [
      { pkg: 'packages/pricing', names: ['loadMergedPricing'] },
      { pkg: 'packages/storage', names: ['hostSplitFor', 'pickHostWarning', 'pickHostSplit', 'loadSessionEvents', 'SESSION_EVENT_SQL'] },
      { pkg: 'packages/event-model', names: ['projectLabel'] },
    ]
    for (const { pkg, names } of owners) {
      const srcDir = join(ROOT, pkg, 'src')
      const body = tsFiles(srcDir)
        .map((f) => readFileSync(f, 'utf8'))
        .join('\n')
      const barrel = readFileSync(join(srcDir, 'index.ts'), 'utf8')
      for (const name of names) {
        expect(body, `${pkg} defines ${name}`).toMatch(new RegExp(`export (?:function|const|class) ${name}\\b`))
        expect(barrel, `${pkg}/src/index.ts re-exports the file that owns ${name}`).toContain('export * from')
      }
    }
  })
})
