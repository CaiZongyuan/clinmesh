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

it('applies an unverified-use restriction before attempting an unavailable update', async () => {
  const text = 'Synthetic diabetes recommendation. The use status later becomes unverified.\n'
  const original = source('synthetic-use-restriction', text)
  const data = await fixture([original])
  await runGuidelineSync(data.args, { fetch: async () => new Response(text) })
  await writeFile(data.manifest, JSON.stringify({ schemaVersion: 1, sources: [{ ...original, sha256: 'c'.repeat(64),
    license: { ...original.license, usage: 'unverified' } }] }))
  const result = await runGuidelineSync(data.args, { fetch: async () => new Response(null, { status: 503 }) })
  expect(result).toMatchObject({ sourceCount: 1, searchableSourceCount: 0, passageCount: 0, failedSourceCount: 1 })
  const reader = new GuidelineCorpus({ databasePath: data.database, readOnly: true })
  disposals.push(() => reader.close())
  expect(reader.search('糖尿病').guidelines).toEqual([])
})

it('rejects a duplicate source registry before touching the destination database', async () => {
  const entry = source('synthetic-duplicate', 'Synthetic original.\n')
  const data = await fixture([entry, entry])
  await expect(runGuidelineSync(data.args, { fetch: async () => { throw new Error('Invalid registry must not fetch') } })).rejects.toThrow('unique')
  await expect(access(data.database)).rejects.toMatchObject({ code: 'ENOENT' })
})
