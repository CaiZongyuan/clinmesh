import { createHash } from 'node:crypto'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runGuidelineSync } from '../src/guideline-sync.ts'
import { GuidelineCorpus } from '../src/infrastructure/sqlite/guideline-corpus.ts'
import type { GuidelineSourceDefinition } from '../src/application/guideline-corpus.ts'

const disposals: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })

function source(id: string, text: string): GuidelineSourceDefinition {
  return { id, title: `合成指南 ${id}`, publisher: '合成发布机构', documentType: 'guideline', version: 'synthetic-1',
    url: `https://www.who.int/${id}`, downloadUrl: `https://iris.who.int/${id}.txt`, format: 'text',
    sha256: createHash('sha256').update(text).digest('hex'), scope: '仅供合成回归验证。', status: 'active',
    license: { id: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', usage: 'open' },
    topics: [{ terms: ['糖尿病', 'diabetes'], diagnosisQueries: ['糖尿病'] }],
  }
}

async function fixture(sources: GuidelineSourceDefinition[]) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-guideline-sync-'))
  disposals.push(() => rm(directory, { recursive: true, force: true }))
  const manifest = join(directory, 'sources.json')
  const database = join(directory, 'guidelines.sqlite')
  const cache = join(directory, 'cache')
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, sources }))
  return { manifest, database, cache, args: ['--manifest', manifest, '--database', database, '--cache-dir', cache] }
}

it('reports readable and searchable sources separately and makes only permitted original passages queryable', async () => {
  const readable = 'Synthetic diabetes recommendation. Retain the original conditional recommendation.\n'
  const withheld = 'Synthetic diabetes source with unverified model-use rights.\n'
  const allowed = source('synthetic-allowed', readable)
  const unverified: GuidelineSourceDefinition = { ...source('synthetic-withheld', withheld),
    license: { ...allowed.license, usage: 'unverified' } }
  const data = await fixture([allowed, unverified])
  const result = await runGuidelineSync(data.args, { fetch: async url => new Response(
    String(url) === allowed.downloadUrl ? readable : withheld, { headers: { 'content-type': 'text/plain' } },
  ) })
  expect(result).toMatchObject({ sourceCount: 2, searchableSourceCount: 1, passageCount: 2, searchablePassageCount: 1, failedSourceCount: 0 })
  expect(result.items).toContainEqual(expect.objectContaining({ sourceId: unverified.id, status: 'withheld' }))
  const corpus = new GuidelineCorpus({ databasePath: data.database, readOnly: true })
  disposals.push(() => corpus.close())
  expect(corpus.search('糖尿病').guidelines.map(item => item.text)).toEqual([readable])
})

it.each(['parent-first', 'child-first'])('显式派生来源的同步状态与进度按最终父链判断：%s', async order => {
  const originalText = 'Synthetic diabetes original evidence.\n'
  const childText = 'Synthetic diabetes derived evidence.\n'
  const original = source('synthetic-parent', originalText)
  const child = { ...source('synthetic-child', childText), derivedFromSourceId: original.id }
  const data = await fixture(order === 'parent-first' ? [original, child] : [child, original])
  const progress: string[] = []
  const imported = await runGuidelineSync(data.args, { onProgress: line => progress.push(line),
    fetch: async url => new Response(String(url) === original.downloadUrl ? originalText : childText) })
  expect(imported).toMatchObject({ searchableSourceCount: 2, searchablePassageCount: 2, failedSourceCount: 0 })
  expect(imported.items).toContainEqual({ sourceId: child.id, status: 'imported', passageCount: 1 })
  expect(progress).toContain(`${child.id}: 1 段，1 段可检索`)
  const repeated = await runGuidelineSync(data.args, { fetch: async () => { throw new Error('Use verified cache') } })
  expect(repeated.items).toContainEqual({ sourceId: child.id, status: 'unchanged', passageCount: 1 })
  await writeFile(data.manifest, JSON.stringify({ schemaVersion: 1,
    sources: [child, { ...original, status: 'withdrawn', sha256: 'b'.repeat(64) }] }))
  progress.length = 0
  const withdrawn = await runGuidelineSync(data.args, { onProgress: line => progress.push(line),
    fetch: async () => { throw new Error('Withdrawal must not fetch') } })
  expect(withdrawn).toMatchObject({ searchableSourceCount: 0, searchablePassageCount: 0, failedSourceCount: 0 })
  expect(withdrawn.items).toContainEqual({ sourceId: child.id, status: 'withheld', passageCount: 1 })
  expect(progress).toContain(`${child.id}: 1 段，0 段可检索`)
})

it('withholds non-commercial sources from sync availability unless deployment use is explicitly declared', async () => {
  const text = 'Synthetic diabetes recommendation for non-commercial research only.\n'
  const entry = source('synthetic-non-commercial', text)
  entry.license.usage = 'non-commercial'
  const data = await fixture([entry])
  const imported = await runGuidelineSync(data.args, { fetch: async () => new Response(text) })
  expect(imported).toMatchObject({ sourceCount: 1, passageCount: 1, searchableSourceCount: 0, searchablePassageCount: 0 })
  expect(imported.items).toEqual([expect.objectContaining({ sourceId: entry.id, status: 'withheld' })])
  const args = ['--check', '--database', data.database]
  const fetch: typeof globalThis.fetch = async () => { throw new Error('Check-only must not download') }
  expect(await runGuidelineSync(args, { fetch, allowNonCommercial: true }))
    .toMatchObject({ searchableSourceCount: 1, searchablePassageCount: 1, items: [{ sourceId: entry.id, status: 'available', passageCount: 1 }] })
  expect(await runGuidelineSync(args, { fetch }))
    .toMatchObject({ searchableSourceCount: 0, searchablePassageCount: 0, items: [{ sourceId: entry.id, status: 'withheld', passageCount: 1 }] })
})

it('checks internal-test availability using the same registered text status as runtime search', async () => {
  const text = 'Synthetic diabetes recommendation for a verified internal-test distribution.\n'
  const entry = source('synthetic-internal-testing', text)
  entry.license.usage = 'unverified'
  entry.distribution = { packageId: 'synthetic-guidelines', releaseId: 'synthetic-v1', textStatus: 'verified',
    verificationRecord: 'verification/synthetic-guideline.json' }
  const data = await fixture([entry])
  const corpus = new GuidelineCorpus({ databasePath: data.database })
  try { corpus.importDocument({ source: entry, passages: [{ locator: 'Line 1', text }] }) }
  finally { corpus.close() }
  const args = ['--check', '--database', data.database]
  const noNetwork: typeof fetch = async () => { throw new Error('Read-only check must not fetch') }
  expect(await runGuidelineSync(args, { fetch: noNetwork, deploymentPolicy: 'internal-testing' }))
    .toMatchObject({ sourceCount: 1, searchableSourceCount: 1, searchablePassageCount: 1,
      items: [{ sourceId: entry.id, status: 'available', passageCount: 1 }] })
  expect(await runGuidelineSync(args, { fetch: noNetwork }))
    .toMatchObject({ searchableSourceCount: 0, searchablePassageCount: 0 })
  await writeFile(data.manifest, JSON.stringify({ schemaVersion: 1,
    sources: [{ ...entry, distribution: { ...entry.distribution, textStatus: 'unreadable' } }] }))
  expect(await runGuidelineSync(data.args, { fetch: noNetwork, deploymentPolicy: 'internal-testing' }))
    .toMatchObject({ failedSourceCount: 0, searchableSourceCount: 0, passageCount: 0 })
})

it('counts only readable passages and reports damaged text without rewriting stored originals', async () => {
  const entry = source('synthetic-mixed-text', 'Synthetic diabetes source.\n')
  const unreadable = { ...entry, id: 'synthetic-only-damaged-text' }
  const data = await fixture([entry, unreadable])
  const corpus = new GuidelineCorpus({ databasePath: data.database })
  const mixed = { source: entry, passages: [
    { locator: 'Line 1', text: 'Diabetes threshold: 5\u0002ULN.' },
    { locator: 'Line 2', text: 'Diabetes threshold: 5\uFFFDULN.' },
    { locator: 'Line 3', text: 'Diabetes requires confirmation before treatment.\n' },
  ] }
  try {
    corpus.importDocuments([mixed, { source: unreadable, passages: [mixed.passages[0]!] }])
    const checked = await runGuidelineSync(['--check', '--database', data.database])
    expect(checked).toMatchObject({ sourceCount: 2, passageCount: 4, searchableSourceCount: 1, searchablePassageCount: 1,
      items: [{ sourceId: entry.id, status: 'available', passageCount: 3, unusablePassageCount: 2 },
        { sourceId: unreadable.id, status: 'withheld', passageCount: 1, unusablePassageCount: 1 }] })
    expect(corpus.matchesDocuments([mixed])).toBe(true)
  } finally { corpus.close() }
})

it('check-only reports local validation availability and parent withdrawal using the same policy as the reader', async () => {
  const text = 'Synthetic coronary assessment requires current evidence.\n'
  const parent = source('synthetic-coronary', text)
  parent.license.usage = 'unverified'
  const data = await fixture([parent])
  await runGuidelineSync(data.args, { fetch: async () => new Response(text) })
  const writer = new GuidelineCorpus({ databasePath: data.database })
  disposals.push(() => writer.close())
  writer.importDocument({ source: { ...parent, id: `local-evaluation-${parent.id}` }, passages: [{ locator: 'original page 1', text }] })
  const args = ['--check', '--database', data.database]
  expect(await runGuidelineSync(args)).toMatchObject({ sourceCount: 2, searchableSourceCount: 0 })
  expect(await runGuidelineSync(args, { allowLocalEvaluation: true }))
    .toMatchObject({ sourceCount: 2, searchableSourceCount: 1, searchablePassageCount: 1 })
  writer.importDocument({ source: { ...parent, status: 'withdrawn', sha256: 'b'.repeat(64), url: 'https://www.who.int/withdrawal' }, passages: [] })
  expect(await runGuidelineSync(args, { allowLocalEvaluation: true })).toMatchObject({ searchableSourceCount: 0, searchablePassageCount: 0 })
})

it('reuses verified bytes on a repeated sync and checks the corpus without downloading or replacing its revision', async () => {
  const text = 'Synthetic diabetes recommendation. Do not omit the individual conditions.\n'
  const data = await fixture([source('synthetic-cache', text)])
  await runGuidelineSync(data.args, { fetch: async () => new Response(text) })
  const reader = new GuidelineCorpus({ databasePath: data.database, readOnly: true })
  disposals.push(() => reader.close())
  const before = reader.search('糖尿病')
  const noNetwork: typeof fetch = async () => { throw new Error('Repeated imports must use the verified cache') }
  const repeated = await runGuidelineSync(data.args, { fetch: noNetwork })
  expect(repeated.items).toEqual([{ sourceId: 'synthetic-cache', status: 'unchanged', passageCount: 1 }])
  expect(reader.search('糖尿病')).toEqual(before)
  expect(await runGuidelineSync(['--check', '--database', data.database], { fetch: noNetwork }))
    .toMatchObject({ sourceCount: 1, searchableSourceCount: 1, searchablePassageCount: 1, failedSourceCount: 0 })
  expect(reader.search('糖尿病')).toEqual(before)
})

it('reports a damaged source update while retaining the prior searchable version', async () => {
  const text = 'Synthetic diabetes recommendation. Retain this verified original version.\n'
  const original = source('synthetic-update', text)
  const data = await fixture([original])
  await runGuidelineSync(data.args, { fetch: async () => new Response(text) })
  const reader = new GuidelineCorpus({ databasePath: data.database, readOnly: true })
  disposals.push(() => reader.close())
  const before = reader.search('糖尿病')
  await writeFile(data.manifest, JSON.stringify({ schemaVersion: 1, sources: [{ ...original, version: 'synthetic-2', sha256: 'a'.repeat(64) }] }))
  const failed = await runGuidelineSync(data.args, { fetch: async () => new Response('damaged replacement') })
  expect(failed).toMatchObject({ failedSourceCount: 1, searchableSourceCount: 1, searchablePassageCount: 1 })
  expect(failed.items).toContainEqual(expect.objectContaining({ sourceId: original.id, status: 'failed', reason: expect.stringContaining('SHA-256') }))
  expect(reader.search('糖尿病')).toEqual(before)
})

it('withdraws an installed source without requiring its bytes to remain available', async () => {
  const text = 'Synthetic diabetes recommendation. This source is later withdrawn.\n'
  const original = source('synthetic-withdrawn', text)
  const data = await fixture([original])
  await runGuidelineSync(data.args, { fetch: async () => new Response(text) })
  await writeFile(data.manifest, JSON.stringify({ schemaVersion: 1, sources: [{ ...original, status: 'withdrawn', sha256: 'b'.repeat(64) }] }))
  const result = await runGuidelineSync(data.args, { fetch: async () => { throw new Error('Withdrawal must not fetch') } })
  expect(result).toMatchObject({ sourceCount: 1, searchableSourceCount: 0, passageCount: 0, failedSourceCount: 0 })
  const reader = new GuidelineCorpus({ databasePath: data.database, readOnly: true })
  disposals.push(() => reader.close())
  expect(reader.search('糖尿病').guidelines).toEqual([])
})

it.each([
  { usage: 'unverified', allowNonCommercial: false },
  { usage: 'non-commercial', allowNonCommercial: false },
  { usage: 'non-commercial', allowNonCommercial: true },
] as const)('applies a $usage restriction before attempting an unavailable update ($allowNonCommercial)', async ({ usage, allowNonCommercial }) => {
  const text = 'Synthetic diabetes recommendation. The use status later becomes restricted.\n'
  const original = source('synthetic-use-restriction', text)
  const data = await fixture([original])
  await runGuidelineSync(data.args, { fetch: async () => new Response(text) })
  await writeFile(data.manifest, JSON.stringify({ schemaVersion: 1, sources: [{ ...original, sha256: 'c'.repeat(64),
    license: { ...original.license, usage } }] }))
  const result = await runGuidelineSync(data.args, { allowNonCommercial, fetch: async () => new Response(null, { status: 503 }) })
  expect(result).toMatchObject({ sourceCount: 1, searchableSourceCount: 0, passageCount: 0, failedSourceCount: 1 })
  const reader = new GuidelineCorpus({ databasePath: data.database, readOnly: true, allowNonCommercial })
  disposals.push(() => reader.close())
  expect(reader.search('糖尿病').guidelines).toEqual([])
  expect(reader.sources()[0]!.source.license.usage).toBe(usage)
  expect(await runGuidelineSync(['--check', '--database', data.database], { allowNonCommercial }))
    .toMatchObject({ searchableSourceCount: 0, items: [{ sourceId: original.id, status: 'withheld', passageCount: 0 }] })
})

it('rejects a duplicate source registry before touching the destination database', async () => {
  const entry = source('synthetic-duplicate', 'Synthetic original.\n')
  const data = await fixture([entry, entry])
  await expect(runGuidelineSync(data.args, { fetch: async () => { throw new Error('Invalid registry must not fetch') } })).rejects.toThrow('unique')
  await expect(access(data.database)).rejects.toMatchObject({ code: 'ENOENT' })
})
