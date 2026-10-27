import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runLocalGuidelineSync } from '../src/guideline-local-sync.ts'
import { GuidelineCorpus } from '../src/infrastructure/sqlite/guideline-corpus.ts'
import type { GuidelineSourceDefinition } from '../src/application/guideline-corpus.ts'
import { syntheticGuidelinePdf } from './fixtures/synthetic-guideline-pdf.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-local-guidelines-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const sourceDirectory = join(directory, 'originals')
  await mkdir(sourceDirectory)
  const bytes = syntheticGuidelinePdf([
    ['Coronary assessment requires current clinical evidence. Do not diagnose from chest pain alone.'],
    ['Unreviewed third-party table must not become recommendation evidence.'],
  ])
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const source: GuidelineSourceDefinition = {
    id: 'local-evaluation-synthetic-coronary', title: '合成冠心病本地资料', publisher: '合成资料发布者',
    documentType: 'guideline', version: 'synthetic-1', url: 'https://example.org/coronary', format: 'pdf', sha256,
    scope: '用户提供资料，仅用于本地流程验证，保留实际使用条件。', status: 'active',
    license: { id: 'synthetic-unverified', url: 'https://example.org/rights', usage: 'unverified' },
    topics: [{ terms: ['冠心病', 'coronary'], diagnosisQueries: ['冠状动脉粥样硬化性心脏病'] }],
  }
  const manifest = join(directory, 'sources.json')
  const database = join(directory, 'guidelines.sqlite')
  const file = join(sourceDirectory, `${sha256}.pdf`)
  await writeFile(file, bytes)
  const entry = { source, pages: [[1, 1]] }
  const save = () => writeFile(manifest, JSON.stringify({ schemaVersion: 1, sources: [entry] }))
  await save()
  const args = ['--manifest', manifest, '--source-dir', sourceDirectory, '--database', database]
  function reader(allowLocalEvaluation = true) {
    const corpus = new GuidelineCorpus({ databasePath: database, readOnly: true, allowLocalEvaluation })
    cleanups.push(() => corpus.close())
    return corpus
  }
  return { directory, source, entry, save, manifest, database, file, args, reader }
}

it('显式本地导入只提供指定物理页，保留原文和真实使用条件', async () => {
  const data = await fixture()
  data.source.license = { id: 'CC-BY-NC-ND-4.0', url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/', usage: 'non-commercial' }
  await data.save()
  const result = await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true })
  expect(result).toMatchObject({ sourceCount: 1, passageCount: 1, searchableSourceCount: 1, failedSourceCount: 0 })
  const corpus = data.reader()
  const resultText = corpus.search('冠心病 coronary').guidelines
  expect(resultText).toHaveLength(1)
  expect(resultText[0]).toMatchObject({ text: 'Coronary assessment requires current clinical evidence. Do not diagnose from chest pain alone.',
    locator: expect.stringContaining('PDF 物理第 1 页'), sourceHash: data.source.sha256, url: data.source.url })
  expect(resultText[0]?.scope).toContain('CC-BY-NC-ND-4.0')
  expect(resultText[0]?.scope).toContain('https://creativecommons.org/licenses/by-nc-nd/4.0/')
  expect(corpus.search('Unreviewed third-party table').guidelines).toEqual([])
  expect(corpus.sources()[0]?.source).toMatchObject({ license: data.source.license,
    scope: expect.stringContaining('本地流程验证') })
  expect(data.reader(false).search('冠心病 coronary').guidelines).toEqual([])
})

it('重复上传保留来源记录但只计一份正文，移除一个来源仍保留共享内容', async () => {
  const data = await fixture()
  const copy = { ...data.source, id: 'local-evaluation-second-upload' }
  await writeFile(data.manifest, JSON.stringify({ schemaVersion: 1,
    sources: [data.entry, { ...data.entry, source: copy }] }))
  expect(await runLocalGuidelineSync(data.args)).toMatchObject({ sourceCount: 2, documentCount: 1,
    passageCount: 1, searchableSourceCount: 0, searchableDocumentCount: 0, searchablePassageCount: 0 })
  const enabled = await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true })
  expect(enabled).toMatchObject({ sourceCount: 2, documentCount: 1, passageCount: 1,
    searchableSourceCount: 2, searchableDocumentCount: 1, searchablePassageCount: 1 })
  expect(enabled.items).toMatchObject([{ passageCount: 1 }, { passageCount: 1 }])
  const reader = data.reader()
  expect(reader.sources()).toHaveLength(2)
  expect(reader.search('coronary').guidelines).toHaveLength(1)
  await data.save()
  expect(await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true })).toMatchObject({
    sourceCount: 2, documentCount: 1, passageCount: 1, searchableSourceCount: 1,
    searchableDocumentCount: 1, searchablePassageCount: 1,
  })
  expect(reader.sources().find(item => item.source.id === copy.id)).toMatchObject({ passageCount: 0 })
  expect(reader.search('coronary').guidelines).toHaveLength(1)
})

it.each(['open', 'non-commercial'] as const)('重复导入保持依据身份，范围收紧后更新失败停用旧页但保留%s许可', async usage => {
  const data = await fixture()
  data.source.license.usage = usage
  data.entry.pages = [[1, 2]]
  await data.save()
  await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true })
  const reader = data.reader()
  const original = reader.search('coronary')
  expect(reader.search('Unreviewed table').guidelines).toHaveLength(1)
  expect((await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true })).items)
    .toEqual([{ sourceId: data.source.id, status: 'unchanged', passageCount: 2 }])
  expect(reader.search('coronary')).toEqual(original)
  data.entry.pages = [[1, 1]]
  await data.save()
  await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true })
  expect(reader.search('Unreviewed table').guidelines).toEqual([])
  expect(reader.search('coronary').guidelines[0]?.id).not.toBe(original.guidelines[0]?.id)
  data.entry.pages = [[2, 2]]
  await data.save()
  await unlink(data.file)
  expect(await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true })).toMatchObject({ failedSourceCount: 1, searchableSourceCount: 0 })
  expect(reader.search('coronary table').guidelines).toEqual([])
  expect(reader.sources()[0]?.source.license).toEqual(data.source.license)
})

it.each(['open', 'non-commercial'] as const)('完整清单移除本地来源时停用旧原文，保留其他来源和%s许可', async usage => {
  const data = await fixture()
  data.source.license.usage = usage
  await data.save()
  await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true })
  const writer = new GuidelineCorpus({ databasePath: data.database })
  cleanups.push(() => writer.close())
  const other = { ...data.source, id: 'synthetic-independent', topics: [],
    license: { ...data.source.license, usage: 'open' as const } }
  writer.importDocument({ source: other, passages: [{ locator: 'independent', text: 'Independent preserved original.' }] })
  await writeFile(data.manifest, JSON.stringify({ schemaVersion: 1, sources: [] }))
  await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true })
  const reader = data.reader()
  expect(reader.search('coronary').guidelines).toEqual([])
  expect(reader.search('Independent').guidelines.map(item => item.text)).toEqual(['Independent preserved original.'])
  expect(reader.sources().find(item => item.source.id === data.source.id)).toMatchObject({ passageCount: 0,
    source: { status: 'active', license: data.source.license } })
})

it('本地同步统计沿用原非商业用途开关，不连带启用其他来源', async () => {
  const data = await fixture()
  await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true })
  const writer = new GuidelineCorpus({ databasePath: data.database })
  cleanups.push(() => writer.close())
  writer.importDocument({ source: { ...data.source, id: 'synthetic-existing-non-commercial',
    license: { ...data.source.license, usage: 'non-commercial' } },
    passages: [{ locator: 'independent', text: 'Independent coronary original.' }] })
  expect(await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true }))
    .toMatchObject({ searchableSourceCount: 1, searchablePassageCount: 1 })
  expect(await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true, allowNonCommercial: true }))
    .toMatchObject({ searchableSourceCount: 2, searchablePassageCount: 2 })
})

it('不正确的原文件哈希不能进入检索', async () => {
  const data = await fixture()
  await writeFile(data.file, 'different original bytes')
  const result = await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true })
  expect(result).toMatchObject({ failedSourceCount: 1, searchableSourceCount: 0 })
  expect(result.items[0]?.reason).toContain('SHA-256')
  expect(data.reader().sources()).toEqual([])
})

it('院内上传保留显式原来源，原来源换哈希撤回后重导仍停用且统计一致', async () => {
  const data = await fixture()
  data.source.derivedFromSourceId = 'hospital-original-coronary'
  await data.save()
  await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true })
  const writer = new GuidelineCorpus({ databasePath: data.database })
  cleanups.push(() => writer.close())
  const original = { ...data.source, id: 'hospital-original-coronary', sha256: 'b'.repeat(64), status: 'withdrawn' as const }
  delete original.derivedFromSourceId
  writer.importDocument({ source: original, passages: [] })
  const before = data.reader().search('coronary').revision
  const result = await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true })
  expect(result).toMatchObject({ searchableSourceCount: 0, searchablePassageCount: 0, failedSourceCount: 0,
    items: [{ sourceId: data.source.id, status: 'unchanged', passageCount: 1 }] })
  expect(data.reader().search('coronary')).toMatchObject({ guidelines: [], revision: before })
  expect(data.reader().sources().find(item => item.source.id === data.source.id)?.source)
    .toHaveProperty('derivedFromSourceId', 'hospital-original-coronary')
})

it('旧本地清单重导保留自动关联且不重复清空正文', async () => {
  const data = await fixture()
  await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true })
  const writer = new GuidelineCorpus({ databasePath: data.database })
  cleanups.push(() => writer.close())
  const original = { ...data.source, id: 'hospital-original-coronary', license: { ...data.source.license, usage: 'open' as const } }
  writer.importDocument({ source: original, passages: [{ locator: 'synthetic', text: 'Synthetic coronary original.' }] })
  const before = data.reader().search('coronary')
  expect(await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true })).toMatchObject({ failedSourceCount: 0,
    items: [{ sourceId: data.source.id, status: 'unchanged', passageCount: 1 }] })
  expect(data.reader().search('coronary')).toEqual(before)
})

it.each([
  { name: '不可解释控制字符', page: ['Coronary risk \u0001 assessment requires evidence.'], reason: 'control characters' },
  { name: '只有可见图形而无原文', page: { operators: '0 0 20 20 re f' }, reason: 'readable original text' },
])('纳入页有$name时拒绝整份导入', async ({ page, reason }) => {
  const data = await fixture()
  const bytes = syntheticGuidelinePdf([page])
  data.source.sha256 = createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(data.directory, 'originals', `${data.source.sha256}.pdf`), bytes)
  await data.save()
  const result = await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true })
  expect(result).toMatchObject({ failedSourceCount: 1, searchableSourceCount: 0, searchablePassageCount: 0 })
  expect(result.items[0]?.reason).toContain(reason)
  expect(data.reader().search('coronary').guidelines).toEqual([])
})

it.each([{ pages: [[0, 1]] }, { pages: [[2, 1]] }, { pages: [[1, 2], [2, 2]] }])('非法或重叠页范围在创建数据库之前拒绝：$pages', async ({ pages }) => {
  const data = await fixture()
  data.entry.pages = pages
  await data.save()
  await expect(runLocalGuidelineSync(data.args)).rejects.toThrow('page')
  await expect(access(data.database)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('超出实际PDF的页范围不产生任何可用片段', async () => {
  const data = await fixture()
  data.entry.pages = [[1, 3]]
  await data.save()
  const result = await runLocalGuidelineSync(data.args, { allowLocalEvaluation: true })
  expect(result).toMatchObject({ failedSourceCount: 1, searchableSourceCount: 0 })
  expect(result.items[0]?.reason).toContain('page count')
  expect(data.reader().search('coronary').guidelines).toEqual([])
})

it.each(['javascript:alert(1)', 'https://synthetic:credential@example.org/publication', 'https://example.org:8443/publication'])('本地资料的出版链接不能携带可执行协议、凭据或自定义端口：%s', async url => {
  const data = await fixture()
  data.source.url = url
  await data.save()
  await expect(runLocalGuidelineSync(data.args)).rejects.toThrow('HTTPS')
  await expect(access(data.database)).rejects.toMatchObject({ code: 'ENOENT' })
})
