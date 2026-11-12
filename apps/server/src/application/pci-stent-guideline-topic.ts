import type { GuidelinePatientPopulation } from './guideline-corpus.ts'
import type { GuidelineCorpus } from '../infrastructure/sqlite/guideline-corpus.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

const revascularizationHash = '9843131ad84f9a261ceb8857025e656a067496472edabfb6bd2b6297f2c5ff0e'
export const pciStentGuidelineTopic = {
  id: 'pci-stent' as const, version: '2026-11-02.r1',
  navigation: '适用于已提出PCI计划时核对支架类别、IVUS／OCT指导条件与测量要求。DES相对BMS属于类别建议；IVUS的用途及OCT的替代均须保留人群、条件、例外与推荐强度。测量须区分近远端参考段、管腔与EEM及测长方法。以下仅为操作性导航，结论必须引用同时回读的原文，不以导航文字作证据。',
  limitations: ['首期固定2021版血运重建指南与CVIT共识，未完成现行版本全集核查。',
    '不判断是否应接受PCI，不提供具体产品、规格或固定数量；合成方案的3.0mm、5–16mm与每类一件不属于指南要求。'],
  references: [
    { sourceId: 'coronary-10-2021', title: '2021 ACC/AHA/SCAI 血运重建指南', version: '2021', sha256: revascularizationHash, page: 35,
      fragments: ['In patients undergoing PCI, DES should be used in preference to BMS'] },
    { sourceId: 'coronary-10-2021', title: '2021 ACC/AHA/SCAI 血运重建指南', version: '2021', sha256: revascularizationHash, page: 36,
      fragments: ['IVUS can be useful', 'left main or complex coronary artery stenting', 'except in ostial left main disease'] },
    { sourceId: 'coronary-15-2021', title: '2021 CVIT 血管内超声共识', version: '2021', sha256: 'c2018438f6bfe9abf39cdfa813f6a6312de858bb6047ce18d9a01bff222ae9ad', page: 6,
      fragments: ['both proximal and distal reference', 'lumen, EEM, and plaque measurements', 'length cannot be measured'] },
  ],
}
const normalize = (text: string) => text.replace(/-\r?\n/g, '').replace(/\s/g, '').toLowerCase()

export function readPciStentGuidelineTopic(
  corpus?: GuidelineCorpus,
  options?: { population?: GuidelinePatientPopulation },
) {
  const { references, ...topic } = pciStentGuidelineTopic
  const empty = { topic, guidelines: [] as ReturnType<GuidelineCorpus['readReferences']>['guidelines'],
    missing: ['尚无本专题可用的固定指南原文，无法提供指南参考意见。'], sourceStatus: 'unavailable' as 'available' | 'unavailable' | 'read-failed' }
  if (!corpus) return empty
  let read: ReturnType<GuidelineCorpus['readReferences']>
  try { read = corpus.readReferences(references.map(({ fragments: _fragments, title: _title, ...reference }) => reference), options) }
  catch { return { ...empty, missing: ['指南原文读取失败，请核查指南库后显式重新评估。'], sourceStatus: 'read-failed' as const } }
  if (read.missing.length > 0) return { ...empty, missing: read.missing.map(item =>
    `${references.find(reference => reference.sourceId === item.sourceId)!.title}物理第${item.page}页不可用，请核查来源版本、用途与正文。`) }
  for (const reference of references) {
    const page = read.guidelines.filter(item => item.sourceHash === reference.sha256 && item.version === reference.version
      && Number(/^PDF 物理第 (\d+) 页/.exec(item.locator)?.[1]) === reference.page).map(item => item.text).join('\n')
    if (!reference.fragments.every(fragment => normalize(page).includes(normalize(fragment))))
      return { ...empty, missing: [`指南物理第${reference.page}页未完整保留本专题所需条款与限定语，停止使用专题。`] }
  }
  if (read.guidelines.length + 1 > 8 || Buffer.byteLength(JSON.stringify({ topic, guidelines: read.guidelines })) > 48 * 1024)
    return { ...empty, missing: ['指南专题与完整原文超出证据预算，不能截断限定语后提供意见。'] }
  return { topic, guidelines: read.guidelines, missing: [], sourceStatus: 'available' as const }
}
export const pciStentGuidelineTopicFingerprint = canonicalJsonHash(pciStentGuidelineTopic)
