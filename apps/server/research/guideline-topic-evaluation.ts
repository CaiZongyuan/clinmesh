/** 两个人工整理专题的取证实验；不接入业务，不调用模型。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { GuidelineCorpus } from '../src/infrastructure/sqlite/guideline-corpus.ts'
import { isGuidelinePassageUsable, isGuidelineSourceUsable, type GuidelineSourceStatus } from '../src/application/guideline-corpus.ts'
import type { GuidelineEvidence } from '@clinmesh/contracts/doctor-recommendations'

const projectRoot = resolve(import.meta.dirname, '../../..')
const hashes = {
  revascularization: '9843131ad84f9a261ceb8857025e656a067496472edabfb6bd2b6297f2c5ff0e',
  ivus: 'c2018438f6bfe9abf39cdfa813f6a6312de858bb6047ce18d9a01bff222ae9ad',
  contrast: '332e74aa189a08a56053e38cc8deea8b07aeeb1903770a2b41248692cce77c0e',
}
// 在整理专题之前，按原件和上一轮实际问题固定；不从专题输出生成期望。
const cases = [
  { id: 'Q1', topic: 'pci-stent', query: 'PCI stent type drug-eluting DES BMS', expected: [
    { hash: hashes.revascularization, page: 35, fragments: ['In patients undergoing PCI, DES should be used in preference to BMS'] },
  ] },
  { id: 'Q2', topic: 'pci-stent', query: 'IVUS reference segment lesion length lumen diameter stent sizing', expected: [
    { hash: hashes.ivus, page: 6, fragments: ['both proximal and distal reference', 'lumen, EEM, and plaque measurements', 'length cannot be measured'] },
    { hash: hashes.revascularization, page: 36, fragments: ['IVUS can be useful', 'left main or complex coronary artery stenting', 'except in ostial left main disease'] },
  ] },
  { id: 'Q3', topic: 'contrast-kidney', query: 'PCI 含碘对比剂 肾功能 eGFR 水化', expected: [
    { hash: hashes.contrast, page: 2, fragments: ['慢性肾脏疾病', '最重要的危险因素'] },
    { hash: hashes.contrast, page: 3, fragments: ['必要时请肾内科会诊', '个体化的获益风险评估'] },
  ] },
  { id: 'Q4', topic: 'contrast-kidney', query: 'PCI 零对比剂 超低剂量 肾功能不全 IVUS', expected: [
    { hash: hashes.contrast, page: 5, fragments: ['患者需要在术前有冠状动脉造影及CT影像资料', '且须在IVUS指导下完成介入诊断治疗', '尚不能在临床常规推广应用', '建议严格限定其适应证', '且由有经验的术者完成'] },
  ] },
]
const normalize = (text: string) => text.replace(/-\r?\n/g, '').replace(/\s/g, '').toLowerCase()
const physicalPage = (locator: string) => Number(/^PDF 物理第 (\d+) 页/.exec(locator)?.[1])
type Evidence = Pick<GuidelineEvidence, 'sourceHash' | 'version' | 'title' | 'url' | 'scope' | 'locator' | 'text'>
function coverage(evidence: Evidence[], expected: typeof cases[number]['expected']) {
  return expected.map(item => ({ page: item.page, sourceHash: item.hash,
    present: evidence.some(part => part.sourceHash === item.hash && part.version === '2021'
      && physicalPage(part.locator) === item.page && item.fragments.every(fragment => normalize(part.text).includes(normalize(fragment)))) }))
}

const referenceSchema = z.object({ sourceId: z.string().min(1), version: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  page: z.number().int().positive(), required: z.boolean() }).strict()
const topicSchema = z.object({ id: z.enum(['pci-stent', 'contrast-kidney']), version: z.literal(1),
  unsupportedCapabilities: z.array(z.string().min(1)), references: z.array(referenceSchema).min(1).max(7) }).strict()
const passageSchema = z.object({ locator: z.string(), text: z.string() }).strict()
const policy = { deploymentPolicy: 'default', allowLocalEvaluation: true } as const
const databasePath = resolve(projectRoot, '.data/clinmesh-guidelines.sqlite')
const corpus = new GuidelineCorpus({ databasePath, readOnly: true, ...policy })
// 专题实验按公开 sources() 的策略结果回读其不可变 body；不增加产品查询 API。
const reader = new Database(databasePath, { readonly: true, fileMustExist: true })
reader.pragma('query_only = ON')
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const evidenceView = ({ sourceHash, version, title, url, scope, locator, text }: Evidence): Evidence => ({ sourceHash, version, title, url, scope, locator, text })

function contextSize(topic: string | null, evidence: Evidence[]) {
  const parts = evidence.length + (topic === null ? 0 : 1)
  const bytes = Buffer.byteLength(JSON.stringify({ topic, evidence }), 'utf8')
  assert(parts <= 8 && bytes <= 48 * 1024, '超出共同的八段或48KiB上下文预算，不截断原文条件')
  return { parts, bytes }
}
function passages(source: GuidelineSourceStatus) {
  return z.array(passageSchema).parse(reader.prepare('SELECT locator, text FROM guideline_passage WHERE body_id=? ORDER BY ordinal').all(source.bodyId ?? ''))
}
interface TopicContext {
  topic: string | null
  evidence: Evidence[]
  gaps: Array<{ sourceId: string; page: number; required: boolean; reason: string }>
  unsupportedCapabilities: string[]
}
function readTopic(id: string, sources: GuidelineSourceStatus[], allowLocalEvaluation = true) {
  const empty: TopicContext = { topic: null, evidence: [], gaps: [], unsupportedCapabilities: [] }
  if (!['pci-stent', 'contrast-kidney'].includes(id)) return { ...empty, status: 'out-of-scope' }
  const markdown = readFileSync(resolve(projectRoot, 'docs/research/topics', `${id}.md`), 'utf8')
  const metadata = /```json\r?\n([\s\S]*?)\r?\n```/.exec(markdown)?.[1]
  assert(metadata, '专题缺少机器引用')
  const topic = topicSchema.parse(JSON.parse(metadata))
  assert.equal(topic.id, id)
  assert.equal(new Set(topic.references.map(item => `${item.sourceId}:${item.page}`)).size, topic.references.length, '专题引用重复')
  const knownSources = sources.filter(item => item.integrityValid !== false).map(item => item.source)
  const selected: Evidence[] = [], gaps = empty.gaps
  for (const reference of topic.references) {
    const source = sources.find(item => item.source.id === reference.sourceId)
    let reason: string | undefined
    if (!source || source.integrityValid === false) reason = 'source-missing-or-invalid'
    else if (source.source.sha256 !== reference.sha256 || source.source.version !== reference.version) reason = 'source-revision-changed'
    else if (!isGuidelineSourceUsable(source.source, false, { ...policy, allowLocalEvaluation, knownSources })) reason = 'source-unavailable'
    const passage = reason === undefined && source ? passages(source).find(item => physicalPage(item.locator) === reference.page) : undefined
    if (reason === undefined && !passage) reason = 'passage-not-available'
    if (passage && !isGuidelinePassageUsable(passage)) reason = 'passage-unreadable'
    if (reason !== undefined) { gaps.push({ sourceId: reference.sourceId, page: reference.page, required: reference.required, reason }); continue }
    assert(source && passage)
    selected.push({ sourceHash: source.source.sha256, version: source.source.version, title: source.source.title,
      url: source.source.url, scope: source.source.scope, locator: passage.locator, text: passage.text })
  }
  if (gaps.some(item => item.required)) return { ...empty, gaps, status: 'blocked' }
  contextSize(markdown, selected)
  return { topic: markdown, evidence: selected, gaps, unsupportedCapabilities: topic.unsupportedCapabilities,
    status: gaps.length > 0 ? 'incomplete' : 'ready' }
}

try {
  const sources = corpus.sources(), sourceSnapshot = digest(sources)
  const baselineRows = cases.map(item => {
    const result = corpus.search(item.query)
    const baseline = result.guidelines.map(evidenceView)
    return { id: item.id, query: item.query, selectedTopic: item.topic,
      baseline: { ...contextSize(null, baseline), coverage: coverage(baseline, item.expected) },
      revision: result.revision }
  })
  if (process.argv.includes('--baseline-only')) {
    console.log(JSON.stringify(baselineRows.map(row => ({ id: row.id, ...row.baseline })), null, 2))
    assert(baselineRows.every(row => row.baseline.coverage.every(item => item.present)), '现有检索没有找全预先固定的关键原文及限定语')
  } else {
    const rows = cases.map((item, index) => {
      const guided = readTopic(item.topic, sources)
      return { ...baselineRows[index]!, guided: { ...contextSize(guided.topic, guided.evidence), status: guided.status,
        coverage: coverage(guided.evidence, item.expected), gaps: guided.gaps } }
    })
    assert(rows.every(row => row.guided.coverage.every(item => item.present)), '专题未找全独立固定的关键原文及限定语')
    const stent = readTopic('pci-stent', sources), contrast = readTopic('contrast-kidney', sources)
    assert(stent.unsupportedCapabilities.includes('specific-product-selection') && stent.unsupportedCapabilities.includes('material-quantity'), '缺失具体器械与数量边界')
    const outside = readTopic('antiplatelet', sources)
    assert(outside.status === 'out-of-scope' && outside.topic === null && outside.evidence.length === 0, '不能用两个专题回答双抗疗程')
    assert(contrast.unsupportedCapabilities.includes('fixed-hydration-rate') && contrast.gaps.some(item => item.page === 4)
      && !contrast.evidence.some(item => physicalPage(item.locator) === 4), '不可用水化原文不能经专题进入上下文')
    const canonicalContrast = sources.find(item => item.source.id === 'coronary-20-2021')
    assert(canonicalContrast)
    const correctedPage = passages(canonicalContrast).find(item => physicalPage(item.locator) === 4)
    assert(correctedPage && isGuidelinePassageUsable(correctedPage), '固定包第4页需通过勘误覆盖层恢复为可读原文')
    const restricted = readTopic('pci-stent', sources, false)
    const restrictedCorpus = new GuidelineCorpus({ databasePath, readOnly: true, deploymentPolicy: 'default', allowLocalEvaluation: false })
    try {
      assert(!restrictedCorpus.search(cases[0]!.query).guidelines.some(item => item.sourceHash === hashes.revascularization), '限制策略仍允许核心来源，不能作为不可用反例')
      assert(restricted.status === 'blocked' && restricted.topic === null && restricted.evidence.length === 0, '来源不可用时派生专题也必须停用')
    } finally { restrictedCorpus.close() }
    assert.equal(digest(corpus.sources()), sourceSnapshot, '实验期间来源变化，不能使用混合快照比较')
    const result = { experiment: 'manual-topics-no-model', policy, maxParts: 8, maxBytes: 48 * 1024,
      rows, boundaries: { Q5: 'unsupported-device-and-quantity-declared', Q6: outside.status,
        Q7: 'hydration-page-unavailable-and-excluded', Q8: restricted.status },
      summary: { expectedPages: rows.reduce((sum, row) => sum + row.baseline.coverage.length, 0),
        baselinePages: rows.reduce((sum, row) => sum + row.baseline.coverage.filter(item => item.present).length, 0),
        guidedPages: rows.reduce((sum, row) => sum + row.guided.coverage.filter(item => item.present).length, 0) } }
    const output = resolve(projectRoot, '.data/research/inpatient-guideline-topic-evaluation.json')
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify(result, null, 2))
  }
} finally {
  reader.close()
  corpus.close()
}
