/**
 * The two persistent §14 banners, worded from the structured fields the API
 * already returns (`agentId`, `dominantHost`, `dominantShare`, `hosts[]`,
 * `emptyDirs`, `projectDirsWithoutSessions`) rather than from a sentence the
 * server composed in advance.
 *
 * That makes locale a property of the viewer while the *numbers* stay the
 * server's, which is the whole point of §14: one source per figure. The English
 * strings here are pinned against `packages/server`'s own wording by
 * `apps/web/test/i18n.test.ts`, so the dashboard and the terminal cannot drift
 * into two phrasings of one fact — the failure this repo's audit already logged.
 */
import { matches } from '../index.ts'

const en = {
  hostSplitTitle: 'Host split.',
  coverageTitle: 'Incomplete history.',
  hostSplitNormal: '{share}% of {agent} records came from {host}, not {others}',
  hostSplitOtherHost: 'the other host',
  hostSplitOwnHost: '{share}% of {agent} records are its own host, the rest is {rest}',
  hostSplitRestNone: 'nowhere',
  hostSplitTail: ' — shown split by default',
  coverageRetained:
    '{count, plural, one {{count} source dir still exists but holds no session files ({population}, §4.4 row 4)} other {{count} source dirs still exist but hold no session files ({population}, §4.4 row 4)}}',
  coverageIngestedPopulation: 'upstream retention, dirs this store already has rows for',
  coverageProjectRows:
    '{count, plural, one {{count} attributed project root holds no session rows here — never ingested from them, or retention took it since (§7)} other {{count} attributed project roots hold no session rows here — never ingested from them, or retention took it since (§7)}}',
  coverageClauseJoin: ' · ',
  coverageTail: ' — history is incomplete',
  limits:
    'only dirs already ingested at least once are visible here; dirs never scanned cannot be distinguished from dirs with nothing in them — `agl doctor` sweeps the live store instead, and says which population it counted',
}

const zh = matches(en)({
  hostSplitTitle: '主机分裂',
  coverageTitle: '历史不完整',
  hostSplitNormal: '{agent} 有 {share}% 的记录来自主机 {host}，而不是 {others}',
  hostSplitOtherHost: '另一台主机',
  hostSplitOwnHost: '{agent} 有 {share}% 的记录挂在它自己的主机名下，其余为 {rest}',
  hostSplitRestNone: '没有来源',
  hostSplitTail: '，因此默认按主机拆分展示',
  coverageRetained: '有 {count} 个源目录仍在，但已不含会话文件（{population}，§4.4 第 4 行）',
  coverageIngestedPopulation: '上游清理，本库已有这些目录的记录',
  coverageProjectRows:
    '{count, plural, other {{count} 个已归属项目的根目录在本库里已无任何会话记录——从未从中采集，或之后被清理（§7）}}',
  coverageClauseJoin: '；',
  coverageTail: '，历史并不完整',
  limits: '这里只看得到至少采集过一次的路径；从未扫描过的目录与扫描后确实为空的目录无法区分 —— 用 `agl doctor` 扫描实时存储，它会说明自己数的是哪一批',
})

export default { en, zh }
