import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import type { GuidelineDocument } from '../src/application/guideline-corpus.ts'
import { GuidelineCorpus } from '../src/infrastructure/sqlite/guideline-corpus.ts'

const disposals: Array<() => void> = []
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose() })

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'clinmesh-fixed-guidelines-'))
  disposals.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'guidelines.sqlite')
  const writer = new GuidelineCorpus({ databasePath: path })
  const reader = new GuidelineCorpus({ databasePath: path, readOnly: true })
  disposals.push(() => writer.close(), () => reader.close())
  const document: GuidelineDocument = { source: { id: 'synthetic-stent-guideline', title: '合成支架指南',
    publisher: '合成机构', documentType: 'guideline', version: '2021', url: 'https://example.test/stent',
    sha256: 'a'.repeat(64), format: 'pdf', scope: '仅供合成回归', status: 'active',
    license: { id: 'CC0', url: 'https://example.test/license', usage: 'open' }, topics: [] }, passages: [
    { locator: 'PDF 物理第 35 页', text: 'Synthetic category recommendation. Retain the patient population and exceptions.' },
    { locator: 'PDF 物理第 36 页', text: 'Synthetic selective imaging guidance; this is optional, not compulsory.' },
  ] }
  writer.importDocument(document)
  const reference = { sourceId: document.source.id, version: '2021', sha256: document.source.sha256, page: 35 }
  return { path, reader, writer, document, reference }
}

it('固定引用从精确身份、版本、哈希和物理页回读完整原文，不依赖检索关键词', () => {
  const s = setup()
  const result = s.reader.readReferences([s.reference, { ...s.reference, page: 36 }])
  expect(result.missing).toEqual([])
  expect(result.guidelines.map(item => ({ title: item.title, version: item.version, sourceHash: item.sourceHash,
    locator: item.locator, text: item.text }))).toEqual(s.document.passages.map(passage => ({ title: '合成支架指南',
    version: '2021', sourceHash: 'a'.repeat(64), ...passage })))
  expect(s.reader.readReferences([s.reference, s.reference]).guidelines).toHaveLength(1)
})

it('固定引用版本、哈希或页码不匹配时保留来源缺口，不替换成相似正文', () => {
  const s = setup()
  for (const reference of [{ ...s.reference, version: '2022' }, { ...s.reference, sha256: 'b'.repeat(64) },
    { ...s.reference, page: 99 }]) {
    const result = s.reader.readReferences([reference])
    expect(result.guidelines).toEqual([])
    expect(result.missing).toHaveLength(1)
  }
})

it.each(['withdrawn', 'superseded', 'restricted', 'damaged'] as const)('固定引用在来源%s后立即失效，不复用旧正文', reason => {
  const s = setup()
  const original = s.reader.readReferences([s.reference])
  if (reason === 'damaged') {
    const connection = new Database(s.path)
    try { connection.prepare('UPDATE guideline_passage SET text=?').run('Silently damaged source text.') }
    finally { connection.close() }
  } else {
    s.writer.importDocument({ ...s.document, source: { ...s.document.source,
      ...(reason === 'restricted' ? { license: { ...s.document.source.license, usage: 'unverified' } } : { status: reason }) }, passages: [] })
  }
  const current = s.reader.readReferences([s.reference])
  expect(current.guidelines).toEqual([])
  expect(current.missing).toHaveLength(1)
  expect(current.revision).not.toBe(original.revision)
})

it('正式来源与院内副本指向同一正文时只回读一次，祖先撤回后副本也失效', () => {
  const s = setup(), aliasId = 'local-evaluation-synthetic-stent-copy'
  s.writer.importDocument({ ...s.document, source: { ...s.document.source, id: aliasId, derivedFromSourceId: s.document.source.id } })
  const reader = new GuidelineCorpus({ databasePath: s.path, readOnly: true, allowLocalEvaluation: true })
  disposals.push(() => reader.close())
  const references = [s.reference, { ...s.reference, sourceId: aliasId }]
  const original = reader.readReferences(references)
  expect(original.missing).toEqual([])
  expect(original.guidelines).toHaveLength(1)
  s.writer.importDocument({ ...s.document, source: { ...s.document.source, status: 'withdrawn', sha256: 'c'.repeat(64) }, passages: [] })
  expect(reader.readReferences(references)).toMatchObject({ guidelines: [], missing: [{ sourceId: s.reference.sourceId }, { sourceId: aliasId }] })
})
