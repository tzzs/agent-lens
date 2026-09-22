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
 *
 * All four rules the whole-plan audit found split across the surfaces are here — the host split,
 * the coverage clause, the unpriced-model set and the billing-mode fold — plus the three this
 * file was written for (the pricing merge, the timeline order, the project label). No rule is
 * exempt, and a rule whose home has to be a surface file names that file, which a separate check
 * then proves really does hold it.
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
  /**
   * Set when the owner is one of the two surfaces instead of a shared package: the ONE file
   * allowed to state the rule. Without this, a rule the surfaces cannot push downward (it
   * needs the `sources` table, or a price entry) has no home the guard can name, and "no
   * surface may state it" would flag the only copy that exists.
   */
  statedIn?: string
  /** Writing this in a surface means the owner was bypassed. */
  forbidden: { re: RegExp; why: string }[]
  /**
   * Files that present this fact to a user must name the owner. A surface that stops calling
   * it has not been deleted — it has gone quiet, or grown its own copy next release.
   */
  calls?: { file: string; symbol: string }[]
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
    what: 'what a NULL fused cost leaves as a floor (§8)',
    home: '@agentlens/query → costFloor',
    forbidden: [
      { re: /cost_total\)\s*\?\?\s*numOrNull\(r\.cost_reported/, why: 'the fallback is the floor rule; a surface that writes it inline drifts from the one that prints "at least" vs n/a' },
      { re: /totals\.cost_total\s*\?\?\s*totals\.cost_reported/, why: 'same rule, CLI side' },
    ],
    calls: [
      { file: 'packages/server/src/cost.ts', symbol: 'costFloor' },
      { file: 'apps/cli/src/commands/usage.ts', symbol: 'costFloor' },
    ],
  },
  {
    what: 'the order a session timeline is read in',
    home: '@agentlens/storage → loadSessionEvents / SESSION_EVENT_SQL',
    forbidden: [
      { re: /raw_seq IS NULL/, why: 're-sorting per surface is exactly the drift §19 records for Web vs CLI session order' },
    ],
  },
  {
    what: 'the clause coverage uses for a dir that outlived its session files (§11)',
    home: '@agentlens/server → coverage.ts retentionPhrase / coverageBanner',
    statedIn: 'packages/server/src/coverage.ts',
    forbidden: [
      {
        re: /holds? no session files/,
        why: 'this clause IS the label; the filesystem sweep and the `sources` table answer two different questions and used to phrase them almost identically (§14)',
      },
      { re: /retentionPhrase\(\s*scope/, why: 'a second builder is a second label for the same fact' },
    ],
    calls: [
      { file: 'apps/cli/src/index.ts', symbol: 'coverageReport' },
      { file: 'apps/cli/src/commands/doctor.ts', symbol: 'retentionPhrase' },
    ],
  },
  {
    what: 'which models are unpriced, and which of their buckets lack a price (§8, §11)',
    home: '@agentlens/server → cost.ts modelSpend / unpricedBuckets / missingPriceModels',
    statedIn: 'packages/server/src/cost.ts',
    forbidden: [
      { re: /isMissingPrice/, why: 'the per-bucket test is the rule; the server used to ask only "is the entry null", so a gap the cube rendered as n/a went unreported' },
      { re: /PRICE_MISSING/, why: 'the same rule in its sentinel form' },
      { re: /FROM models m LEFT JOIN events/, why: 'one model-spend read; the two copies differed in how they filled `last_seen`, which is the price lookup date' },
    ],
    calls: [
      { file: 'apps/cli/src/commands/doctor.ts', symbol: 'modelSpend' },
      { file: 'apps/cli/src/commands/doctor.ts', symbol: 'unpricedBuckets' },
      { file: 'packages/server/src/models.ts', symbol: 'missingPriceModels' },
    ],
  },
  {
    what: "the §8 fold from an API-equivalent amount to actual cash for a declared mode",
    home: "@agentlens/pricing → computeCost, projected per agent by @agentlens/server → actualUsdFor",
    statedIn: 'packages/server/src/cost.ts',
    forbidden: [
      {
        re: /=== 'api' \?/,
        why: "the mode table is pricing's; this file holds the only surface-side projection of it (a per-agent aggregate has no single PriceEntry to hand computeCost), and packages/server/test/cost.test.ts asserts the two agree for every mode",
      },
    ],
    calls: [{ file: 'packages/server/src/cost.ts', symbol: 'actualUsdFor(' }],
  },
  {
    what: 'whether the materialised stage 1 still describes `events`, and what that costs (§11/§19)',
    home: '@agentlens/storage → requestFoldHealth / requestFoldSentence',
    forbidden: [
      { re: /SUM\(member_count\)/, why: 'the certificate is one query; a surface that re-reads it can disagree with the reader that declines on it' },
      { re: /FROM (main\.)?requests\b/, why: 'the folded table is storage\'s; reading it from a surface bypasses the decline rule as well as the counts' },
      { re: /policy_fingerprint/, why: 'comparing the grouping on disk to the stored policies is the fold owner\'s check (§18 row 2)' },
    ],
    calls: [
      { file: 'apps/cli/src/commands/doctor.ts', symbol: 'requestFoldSentence' },
      { file: 'packages/server/src/doctor.ts', symbol: 'requestFoldSentence' },
    ],
  },
]

const ALL_FILES = SURFACES.flatMap((s) => s.files)

describe('§14: one owner per shared rule, surfaces may not re-implement it', () => {
  for (const rule of RULES) {
    it(`${rule.what}: no surface re-implements ${rule.home}`, () => {
      const hits: string[] = []
      for (const surface of SURFACES) {
        for (const file of surface.files) {
          if (file.file === rule.statedIn) continue // the surface that legitimately owns it
          for (const { re, why } of rule.forbidden) {
            if (re.test(file.text)) hits.push(`${file.file} matches ${re} — ${why}`)
          }
        }
      }
      expect(hits, `${rule.home} owns this rule`).toEqual([])
    })
  }

  it('a rule whose home is a surface file is really stated there', () => {
    // Without this, `statedIn` would be an exemption with the owner's name on it: pointing at a
    // file that no longer holds the rule silences the check instead of describing the design.
    for (const rule of RULES.filter((r) => r.statedIn)) {
      const owner = ALL_FILES.find((f) => f.file === rule.statedIn)
      expect(owner, `${rule.statedIn} is gone, so ${rule.what} has no home`).toBeDefined()
      expect(rule.forbidden.some(({ re }) => re.test(owner!.text)), `${rule.statedIn} no longer states ${rule.what}`).toBe(true)
    }
  })

  it('every surface that presents one of these facts calls its owner', () => {
    for (const rule of RULES) {
      for (const c of rule.calls ?? []) {
        const file = ALL_FILES.find((f) => f.file === c.file)
        expect(file, `${c.file} disappeared: ${rule.what} lost the surface that presented it`).toBeDefined()
        expect(file!.text, `${c.file} must reach ${rule.home}`).toContain(c.symbol)
      }
    }
  })

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
      {
        pkg: 'packages/server',
        names: ['coverageReport', 'retentionPhrase', 'modelSpend', 'unpricedBuckets', 'missingPriceModels', 'actualUsdFor'],
      },
    ]
    for (const { pkg, names } of owners) {
      const srcDir = join(ROOT, pkg, 'src')
      const body = tsFiles(srcDir)
        .map((f) => readFileSync(f, 'utf8'))
        .join('\n')
      const barrel = readFileSync(join(srcDir, 'index.ts'), 'utf8')
      for (const name of names) {
        expect(body, `${pkg} defines ${name}`).toMatch(new RegExp(`export (?:function|const|class) ${name}\\b`))
        // Either a star barrel or the name in the package's own re-export list; a comment that
        // happens to mention it cannot pass the `body` check above, so the pair is the promise.
        expect(barrel, `${pkg}/src/index.ts publishes ${name}`).toMatch(new RegExp(`export \\* from|\\b${name}\\b`))
      }
    }
  })
})
