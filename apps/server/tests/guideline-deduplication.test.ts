import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { guidelineCorpusStatistics, type GuidelineDocument } from '../src/application/guideline-corpus.ts'
import { GuidelineCorpus, guidelineSourceDefinitionSchema } from '../src/infrastructure/sqlite/guideline-corpus.ts'
import { matchesGuidelineDocuments } from '../src/infrastructure/sqlite/guideline-corpus-check.ts'
import { syntheticGuidelineDocument } from './fixtures/guideline-corpus.ts'

const roots: string[] = []
const corpora: GuidelineCorpus[] = []
afterEach(() => {
  for (const corpus of corpora.splice(0)) corpus.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function path() {
  const root = mkdtempSync(join(tmpdir(), 'clinmesh-guideline-dedup-'))
  roots.push(root)
  return join(root, 'guidelines.sqlite')
}
function open(databasePath = path(), readOnly = false) {
  const corpus = new GuidelineCorpus({ databasePath, readOnly, allowLocalEvaluation: true })
  corpora.push(corpus)
  return corpus
}
function documents() {
  const original = structuredClone(syntheticGuidelineDocument)
  const copy = structuredClone(original)
  copy.source = { ...copy.source, id: 'local-evaluation-hospital-copy', derivedFromSourceId: original.source.id,
    url: 'https://example.org/hospital-copy' }
  return { original, copy }
}

function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function legacy(databasePath: string, documents: GuidelineDocument[], version: 1 | 2) {
  const database = new Database(databasePath)
  database.exec(`
    CREATE TABLE guideline_source(id TEXT PRIMARY KEY, metadata TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
    CREATE TABLE guideline_passage(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES guideline_source(id), locator TEXT NOT NULL, text TEXT NOT NULL) STRICT;
    CREATE INDEX guideline_passage_source ON guideline_passage(source_id);
    CREATE VIRTUAL TABLE guideline_passage_fts USING fts5(text, content='guideline_passage', content_rowid='rowid', tokenize='trigram');
    CREATE TRIGGER guideline_passage_insert AFTER INSERT ON guideline_passage BEGIN
      INSERT INTO guideline_passage_fts(rowid,text) VALUES(new.rowid,new.text);
    END;
    CREATE TRIGGER guideline_passage_delete AFTER DELETE ON guideline_passage BEGIN
      INSERT INTO guideline_passage_fts(guideline_passage_fts,rowid,text) VALUES('delete',old.rowid,old.text);
    END;
    PRAGMA application_id=0x434d4743;
    PRAGMA user_version=${version};
  `)
  if (version === 2) database.exec('CREATE TABLE guideline_source_restriction(id TEXT PRIMARY KEY, restriction TEXT NOT NULL) STRICT')
  for (const document of documents) {
    const source = guidelineSourceDefinitionSchema.parse(document.source)
    database.prepare('INSERT INTO guideline_source(id,metadata,digest) VALUES(?,?,?)').run(source.id, JSON.stringify(source), digest({ source, passages: document.passages }))
    for (const passage of document.passages) {
      database.prepare('INSERT INTO guideline_passage(id,source_id,locator,text) VALUES(?,?,?,?)')
        .run(digest([source.id, source.version, source.sha256, passage.locator, digest(source)]), source.id, passage.locator, passage.text)
    }
  }
  return database
}

it.each(['together', 'original-first', 'copy-first'])('相同文献保留两份来源但正文及检索只保留一份：%s', order => {
  const databasePath = path()
  const corpus = open(databasePath)
  const { original, copy } = documents()
  if (order === 'together') corpus.importDocuments([original, copy])
  else for (const document of order === 'original-first' ? [original, copy] : [copy, original]) corpus.importDocument(document)
  const sources = corpus.sources()
  expect(sources).toHaveLength(2)
  expect(sources[0]!.bodyId).toMatch(/^[a-f0-9]{64}$/)
  expect(sources[0]!.bodyId).toBe(sources[1]!.bodyId)
  expect(guidelineCorpusStatistics(sources, { allowLocalEvaluation: true })).toMatchObject({
    sourceCount: 2, documentCount: 1, passageCount: 1, searchableSourceCount: 2, searchableDocumentCount: 1, searchablePassageCount: 1,
  })
  const database = new Database(databasePath, { readonly: true })
  try {
    expect(database.prepare('SELECT count(*) AS count FROM guideline_body').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT count(*) AS count FROM guideline_passage').get()).toEqual({ count: 1 })
  } finally { database.close() }
  const found = corpus.search('diabetes')
  expect(found.guidelines).toHaveLength(1)
  expect(found.guidelines[0]!.url).toBe(original.source.url)
  expect(corpus.importDocuments([original, copy])).toEqual({ created: false, passageCount: 2 })
  expect(corpus.search('diabetes')).toEqual(found)
  expect(corpus.matchesDocuments([original, copy])).toBe(true)
})

it.each([1, 2] as const)('旧schema v%s在写端原子补齐共享正文，只读检查不迁移正式库', version => {
  const databasePath = path()
  const { original, copy } = documents()
  legacy(databasePath, [original, copy], version).close()
  const before = readFileSync(databasePath)
  expect(() => open(databasePath, true)).toThrow('requires preparation')
  expect(matchesGuidelineDocuments(databasePath, [original, copy])).toBe(false)
  expect(readFileSync(databasePath)).toEqual(before)
  const corpus = open(databasePath)
  expect(corpus.schemaUpgraded).toBe(true)
  expect(corpus.matchesDocuments([original, copy])).toBe(true)
  expect(corpus.hasValidSearchIndex()).toBe(true)
  expect(guidelineCorpusStatistics(corpus.sources(), { allowLocalEvaluation: true })).toMatchObject({ sourceCount: 2, documentCount: 1, passageCount: 1 })
  expect(corpus.search('diabetes').guidelines).toHaveLength(1)
  expect(open(databasePath, true).schemaUpgraded).toBe(false)
  expect(matchesGuidelineDocuments(databasePath, [original, copy])).toBe(true)
})

it.each(['text', 'passage-id', 'metadata'] as const)('迁移保留损坏来源状态，不借完整副本洗白；明确重导可修复：%s', damage => {
  const databasePath = path()
  const { original, copy } = documents()
  const previous = legacy(databasePath, [original, copy], 2)
  if (damage === 'text') previous.prepare('UPDATE guideline_passage SET text=? WHERE source_id=?').run('Corrupted legacy content.', copy.source.id)
  else if (damage === 'passage-id') previous.prepare('UPDATE guideline_passage SET id=? WHERE source_id=?').run('corrupted-passage-id', copy.source.id)
  else previous.prepare('UPDATE guideline_source SET metadata=? WHERE id=?').run('{broken', copy.source.id)
  previous.close()
  const corpus = open(databasePath)
  expect(corpus.matchesDocuments([original])).toBe(true)
  expect(corpus.matchesDocuments([copy])).toBe(false)
  expect(corpus.search('diabetes').guidelines).toHaveLength(1)
  corpus.importDocument(original)
  expect(corpus.matchesDocuments([copy])).toBe(false)
  if (damage !== 'metadata') expect(corpus.sources().find(item => item.source.id === copy.source.id)).toMatchObject({ integrityValid: false })
  else expect(() => corpus.sources()).toThrow()
  const raw = new Database(databasePath, { readonly: true })
  try { expect(raw.prepare('SELECT integrity_invalid FROM guideline_source WHERE id=?').get(copy.source.id)).toEqual({ integrity_invalid: 1 }) }
  finally { raw.close() }
  corpus.importDocuments([copy], { preserveRestrictions: true })
  expect(corpus.matchesDocuments([original, copy])).toBe(true)
  expect(corpus.sources().every(item => item.integrityValid !== false)).toBe(true)
  expect(new Set(corpus.sources().map(item => item.bodyId)).size).toBe(1)
})

it.each([1, 2] as const)('旧schema v%s中未关联的损坏副本不阻断健康原件重导，补关联保留不可信状态', version => {
  const databasePath = path()
  const { original, copy } = documents()
  delete copy.source.derivedFromSourceId
  const previous = legacy(databasePath, [original, copy], version)
  previous.prepare('UPDATE guideline_passage SET text=? WHERE source_id=?').run('Corrupted unlinked copy.', copy.source.id)
  previous.close()
  const corpus = open(databasePath)
  expect(corpus.sources().find(item => item.source.id === copy.source.id)).toMatchObject({ integrityValid: false })
  expect(corpus.importReleaseDocuments([original]).created).toBe(true)
  expect(corpus.matchesDocuments([original])).toBe(true)
  expect(corpus.search('diabetes').guidelines).toHaveLength(1)
  const damaged = corpus.sources().find(item => item.source.id === copy.source.id)!
  expect(damaged.integrityValid).toBe(false)
  expect(damaged.source.derivedFromSourceId).toBe(original.source.id)
  corpus.importDocument(copy)
  const repaired = corpus.sources().find(item => item.source.id === copy.source.id)!
  expect(repaired.integrityValid).toBeUndefined()
  expect(repaired.source.derivedFromSourceId).toBe(original.source.id)
  expect(new Set(corpus.sources().map(item => item.bodyId)).size).toBe(1)
  expect(corpus.search('diabetes').guidelines).toHaveLength(1)
})

it.each([1, 2] as const)('旧schema v%s的损坏副本保留原件历史关联，修复正文不能绕过撤回', version => {
  const databasePath = path()
  const { original, copy } = documents()
  delete copy.source.derivedFromSourceId
  const previous = legacy(databasePath, [original, copy], version)
  previous.prepare('UPDATE guideline_passage SET text=? WHERE source_id=?').run('Corrupted unlinked copy.', copy.source.id)
  const oldDigest = previous.prepare('SELECT digest FROM guideline_source WHERE id=?').get(copy.source.id)
  previous.close()
  const corpus = open(databasePath)
  corpus.importDocument({ source: { ...original.source, status: 'withdrawn', sha256: 'b'.repeat(64) }, passages: [] })
  expect(corpus.search('diabetes').guidelines).toEqual([])
  expect(corpus.sources().find(item => item.source.id === copy.source.id)).toMatchObject({ integrityValid: false })
  const external = new Database(databasePath, { readonly: true })
  try { expect(external.prepare('SELECT digest FROM guideline_source WHERE id=?').get(copy.source.id)).toEqual(oldDigest) }
  finally { external.close() }
  corpus.importDocument(copy)
  const repaired = corpus.sources().find(item => item.source.id === copy.source.id)!
  expect(repaired.integrityValid).toBeUndefined()
  expect(repaired.source.derivedFromSourceId).toBe(original.source.id)
  expect(corpus.search('diabetes').guidelines).toEqual([])
  expect(guidelineCorpusStatistics(corpus.sources(), { allowLocalEvaluation: true }).searchableSourceCount).toBe(0)
})

it.each(['excerpt', 'revision', 'version', 'original', 'format', 'locator', 'order'] as const)('节选、修订或身份不同的资料独立存储：%s', change => {
  const corpus = open()
  const { original, copy } = documents()
  original.passages.push({ locator: '合成第3节第2段', text: 'Diabetes monitoring requires a separate follow-up assessment.' })
  copy.passages = structuredClone(original.passages)
  if (change === 'excerpt') copy.passages.pop()
  else if (change === 'revision') copy.passages[0]!.text += ' A reviewed correction.'
  else if (change === 'version') copy.source.version = 'synthetic-2'
  else if (change === 'original') copy.source.sha256 = 'b'.repeat(64)
  else if (change === 'format') copy.source.format = 'pdf'
  else if (change === 'locator') copy.passages[0]!.locator = '合成附录第1段'
  else copy.passages.reverse()
  corpus.importDocuments([original, copy])
  expect(new Set(corpus.sources().map(item => item.bodyId)).size).toBe(2)
  expect(guidelineCorpusStatistics(corpus.sources(), { allowLocalEvaluation: true })).toMatchObject({
    sourceCount: 2, documentCount: 2, passageCount: original.passages.length + copy.passages.length,
  })
  expect(corpus.search('diabetes').guidelines).toHaveLength(original.passages.length + copy.passages.length)
})

it('修改来源元数据不复制正文，但会改变检索版本与对应依据身份', () => {
  const corpus = open()
  const { original, copy } = documents()
  corpus.importDocuments([original, copy])
  const before = corpus.search('diabetes')
  const bodyId = corpus.sources()[0]!.bodyId
  original.source.scope = '仅供另一组合成适用人群核对。'
  corpus.importDocument(original)
  const after = corpus.search('diabetes')
  expect(corpus.sources().every(item => item.bodyId === bodyId)).toBe(true)
  expect(after.revision).not.toBe(before.revision)
  expect(after.guidelines[0]!.id).not.toBe(before.guidelines[0]!.id)
  expect(after.guidelines[0]!.scope).toBe(original.source.scope)
})

it('清空一个导入来源保留另一来源的共享正文，最后引用移除才回收正文与索引', () => {
  const databasePath = path()
  const corpus = open(databasePath)
  const { original, copy } = documents()
  corpus.importDocuments([original, copy])
  const before = corpus.search('diabetes')
  corpus.importDocument({ source: copy.source, passages: [] })
  expect(corpus.search('diabetes').guidelines).toEqual(before.guidelines)
  expect(corpus.sources().find(item => item.source.id === copy.source.id)).toEqual({ source: copy.source, passageCount: 0 })
  const database = new Database(databasePath, { readonly: true })
  try {
    expect(database.prepare('SELECT count(*) AS count FROM guideline_body').get()).toEqual({ count: 1 })
    corpus.importDocument({ source: { ...original.source, license: { ...original.source.license, usage: 'unverified' } }, passages: [] })
    expect(database.prepare('SELECT count(*) AS count FROM guideline_body').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT count(*) AS count FROM guideline_passage').get()).toEqual({ count: 0 })
    expect(corpus.search('diabetes').guidelines).toEqual([])
    expect(corpus.hasValidSearchIndex()).toBe(true)
    corpus.importDocument(original)
    expect(corpus.matchesDocuments([original])).toBe(true)
    expect(corpus.search('diabetes').guidelines).toHaveLength(1)
  } finally { database.close() }
})

it.each([false, true])('停用副本或节选只停用自身，不反向停用仍有效的原件：节选=%s', excerpt => {
  const corpus = open()
  const { original, copy } = documents()
  original.passages.push({ locator: '合成第3节第2段', text: 'Diabetes follow-up needs reassessment.' })
  copy.passages = structuredClone(original.passages)
  if (excerpt) copy.passages.pop()
  corpus.importDocuments([original, copy])
  corpus.importDocument({ ...copy, source: { ...copy.source, status: 'withdrawn' } })
  const found = corpus.search('diabetes')
  expect(found.guidelines).toHaveLength(2)
  expect(found.guidelines.every(item => item.url === original.source.url)).toBe(true)
  expect(guidelineCorpusStatistics(corpus.sources(), { allowLocalEvaluation: true })).toMatchObject({ searchableSourceCount: 1, searchableDocumentCount: 1 })
})

it.each(['text', 'metadata'] as const)('损坏父来源不在可信父链中，即使副本正文完整也不可检索：%s', damage => {
  const databasePath = path()
  const { original, copy } = documents()
  const previous = legacy(databasePath, [original, copy], 1)
  if (damage === 'text') previous.prepare('UPDATE guideline_passage SET text=? WHERE source_id=?').run('Corrupted parent text.', original.source.id)
  else previous.prepare('UPDATE guideline_source SET metadata=? WHERE id=?').run('{broken', original.source.id)
  previous.close()
  const corpus = open(databasePath)
  expect(corpus.search('diabetes').guidelines).toEqual([])
  corpus.importDocument(original)
  expect(corpus.search('diabetes').guidelines).toHaveLength(1)
})

it('共享正文损坏使所有引用失效，明确重导修复实际正文和FTS', () => {
  const databasePath = path()
  const corpus = open(databasePath)
  const { original, copy } = documents()
  corpus.importDocuments([original, copy])
  const before = corpus.search('diabetes')
  const external = new Database(databasePath)
  try { external.prepare('UPDATE guideline_passage SET text=?').run('Corrupted body text.') } finally { external.close() }
  expect(corpus.matchesDocuments([original, copy])).toBe(false)
  expect(corpus.sources().every(item => item.integrityValid === false)).toBe(true)
  expect(corpus.search('diabetes').guidelines).toEqual([])
  expect(corpus.search('diabetes').revision).not.toBe(before.revision)
  corpus.importDocument(original)
  expect(corpus.matchesDocuments([original, copy])).toBe(true)
  expect(corpus.hasValidSearchIndex()).toBe(true)
  expect(corpus.search('diabetes').guidelines).toHaveLength(1)
})

it('后续来源限制拒绝导入时，新正文、映射与回收一起回滚', () => {
  const databasePath = path()
  const corpus = open(databasePath)
  const { original, copy } = documents()
  const restricted = structuredClone(original)
  restricted.source.id = 'pending-independent-source'
  restricted.source.sha256 = 'b'.repeat(64)
  restricted.source.license.usage = 'unverified'
  restricted.source.distribution = { packageId: 'synthetic', releaseId: 'v1', textStatus: 'pending', verificationRecord: 'pending.json' }
  restricted.passages = []
  corpus.importDocuments([original, copy, restricted])
  const before = corpus.search('diabetes')
  const changed = structuredClone(original)
  changed.passages[0]!.text += ' A new extraction revision.'
  const invalid = structuredClone(restricted)
  delete invalid.source.distribution
  invalid.passages = original.passages
  expect(() => corpus.importDocuments([changed, invalid])).toThrow('requires an explicit verification status')
  expect(corpus.search('diabetes')).toEqual(before)
  expect(corpus.matchesDocuments([original, copy])).toBe(true)
  expect(corpus.hasValidSearchIndex()).toBe(true)
  const external = new Database(databasePath, { readonly: true })
  try { expect(external.prepare('SELECT count(*) AS count FROM guideline_body').get()).toEqual({ count: 1 }) }
  finally { external.close() }
})

it('多份完全相同上传不占据重复候选或挤掉另一文献，导入顺序不改变最终身份', () => {
  const { original, copy } = documents()
  original.passages = Array.from({ length: 10 }, (_, index) => ({ locator: `Synthetic diabetes section ${index}`,
    text: 'Diabetes monitoring requires a clinical assessment.' }))
  const copies = Array.from({ length: 10 }, (_, index) => ({ source: { ...copy.source, id: `local-evaluation-upload-${index}` },
    passages: original.passages }))
  const independent = structuredClone(original)
  independent.source.id = 'independent-monitoring-guideline'
  independent.source.sha256 = 'b'.repeat(64)
  independent.passages = [{ locator: 'Independent follow-up', text: 'Diabetes monitoring requires another assessment.' }]
  const forward = open()
  const reverse = open()
  forward.importDocuments([original, ...copies, independent])
  reverse.importDocuments([independent, ...copies.toReversed(), original])
  const found = forward.search('diabetes monitoring')
  expect(found).toEqual(reverse.search('diabetes monitoring'))
  expect(found.guidelines).toHaveLength(8)
  expect(found.guidelines).toContainEqual(expect.objectContaining({ locator: 'Independent follow-up' }))
  expect(guidelineCorpusStatistics(forward.sources(), { allowLocalEvaluation: true })).toMatchObject({ sourceCount: 12, documentCount: 2, passageCount: 11 })
})

it.each([1, 2] as const)('旧schema v%s的撤回限制保留到显式复核恢复，不因共享正文或重装清除', version => {
  const databasePath = path()
  const { original, copy } = documents()
  const withdrawn = { ...original, source: { ...original.source, status: 'withdrawn' as const } }
  const previous = legacy(databasePath, [withdrawn, copy], version)
  if (version === 2) previous.prepare('INSERT INTO guideline_source_restriction(id,restriction) VALUES(?,?)').run(original.source.id, JSON.stringify({ status: 'withdrawn' }))
  previous.close()
  const corpus = open(databasePath)
  expect(corpus.search('diabetes').guidelines).toEqual([])
  corpus.importReleaseDocuments([original, copy])
  expect(corpus.sources().find(item => item.source.id === original.source.id)?.source.status).toBe('withdrawn')
  expect(corpus.search('diabetes').guidelines).toEqual([])
  expect(new Set(corpus.sources().map(item => item.bodyId)).size).toBe(1)
  corpus.importReleaseDocuments([original, copy], [original.source.id])
  expect(corpus.search('diabetes').guidelines).toHaveLength(1)
})
