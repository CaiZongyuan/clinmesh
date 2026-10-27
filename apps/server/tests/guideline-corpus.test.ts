import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type { GuidelineDocument } from '../src/application/guideline-corpus.ts'
import { GuidelineCorpus, guidelineSourceDefinitionSchema } from '../src/infrastructure/sqlite/guideline-corpus.ts'

function document(): GuidelineDocument {
  return {
    source: {
      id: 'synthetic-rare-disease',
      title: '合成罕见病诊疗指南',
      publisher: '合成指南机构',
      documentType: 'guideline',
      version: '2026',
      publishedAt: '2026-10-16',
      url: 'https://example.org/guideline',
      downloadUrl: 'https://example.org/guideline.pdf',
      format: 'pdf',
      sha256: 'a'.repeat(64),
      scope: '用于合成病例测试',
      status: 'active',
      license: { id: 'synthetic-open', url: 'https://example.org/license', usage: 'open' },
      topics: [{ terms: ['软骨发育不全', 'achondroplasia'], diagnosisQueries: ['软骨发育不全'] }],
    },
    passages: [{ locator: '第二章，第 12 页', text: '软骨发育不全患者需要结合生长发育情况评估。不得仅凭身高确诊。' }],
  }
}

describe('GuidelineCorpus 公共存储与检索接口', () => {
  const directories: string[] = []
  const corpora: GuidelineCorpus[] = []
  function open(path?: string, readOnly = false, allowLocalEvaluation = false): GuidelineCorpus {
    const databasePath = path ?? join(directory(), 'guidelines.sqlite')
    const corpus = new GuidelineCorpus({ databasePath, readOnly, allowLocalEvaluation })
    corpora.push(corpus)
    return corpus
  }
  function directory(): string {
    const path = mkdtempSync(join(tmpdir(), 'clinmesh-guideline-corpus-'))
    directories.push(path)
    return path
  }
  afterEach(() => {
    for (const corpus of corpora.splice(0)) corpus.close()
    for (const path of directories.splice(0)) rmSync(path, { force: true, recursive: true })
  })

  it('导入后通过新连接检索完整原文、定位和真实来源', () => {
    const path = join(directory(), 'guidelines.sqlite')
    const writer = open(path)
    const input = document()
    expect(writer.importDocument(input)).toEqual({ created: true, passageCount: 1 })
    const reader = open(path, true)
    expect(reader.sources()).toEqual([{ source: input.source, passageCount: 1 }])
    const result = reader.search('患者有软骨发育不全，需要评估')
    expect(result.guidelines).toHaveLength(1)
    expect(result.guidelines[0]).toMatchObject({
      title: input.source.title,
      locator: input.passages[0]!.locator,
      text: input.passages[0]!.text,
      url: input.source.url,
      sourceHash: input.source.sha256,
    })
    expect(result.diagnosisQueries).toEqual(['软骨发育不全'])
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/)
  })

  it('固定包与本地验证开关独立生效，原来源撤回或正文待核验共同停用派生内容', () => {
    const path = join(directory(), 'guidelines.sqlite')
    const writer = open(path)
    const released = document()
    released.source.license.usage = 'unverified'
    released.source.distribution = { packageId: 'synthetic-guidelines', releaseId: 'synthetic-v1', textStatus: 'verified', verificationRecord: 'verified.json' }
    const local = structuredClone(released)
    local.source.id = `local-evaluation-${released.source.id}`
    delete local.source.distribution
    delete local.source.downloadUrl
    writer.importDocuments([released, local])
    for (const [deploymentPolicy, allowLocalEvaluation, count] of [
      ['default', false, 0], ['internal-testing', false, 1], ['default', true, 1], ['internal-testing', true, 2],
    ] as const) {
      const reader = new GuidelineCorpus({ databasePath: path, readOnly: true, deploymentPolicy, allowLocalEvaluation })
      try { expect(reader.search('软骨发育不全').guidelines).toHaveLength(count) } finally { reader.close() }
    }
    const reader = new GuidelineCorpus({ databasePath: path, readOnly: true, deploymentPolicy: 'internal-testing', allowLocalEvaluation: true })
    try {
      writer.importDocument({ source: { ...released.source, distribution: { ...released.source.distribution, textStatus: 'pending' } }, passages: [] })
      expect(reader.search('软骨发育不全').guidelines).toEqual([])
      writer.importDocument({ source: { ...released.source, status: 'withdrawn', sha256: 'b'.repeat(64) }, passages: [] })
      expect(reader.search('软骨发育不全').guidelines).toEqual([])
    } finally { reader.close() }
  })

  it('院内自定义编号副本按显式原来源关联停用，即使原文件哈希和网址变化', () => {
    const path = join(directory(), 'guidelines.sqlite')
    const writer = open(path)
    const original = document()
    original.source.distribution = { packageId: 'synthetic-guidelines', releaseId: 'synthetic-v1', textStatus: 'verified', verificationRecord: 'verified.json' }
    const uploaded = document()
    uploaded.source = { ...uploaded.source, id: 'local-evaluation-hospital-upload-42',
      derivedFromSourceId: original.source.id, sha256: 'c'.repeat(64) }
    const independent = document()
    independent.source.id = 'independent-source'
    independent.source.sha256 = 'd'.repeat(64)
    writer.importDocuments([original, uploaded, independent])
    const reader = open(path, true, true)
    const before = reader.search('软骨发育不全')
    expect(before.guidelines).toHaveLength(3)
    writer.importDocument({ source: { ...original.source, status: 'withdrawn', sha256: 'b'.repeat(64),
      url: 'https://example.org/withdrawal' }, passages: [] })
    const after = reader.search('软骨发育不全')
    expect(after.guidelines.map(item => item.sourceHash)).toEqual(['d'.repeat(64)])
    expect(after.revision).not.toBe(before.revision)
    expect(reader.sources().find(item => item.source.id === uploaded.source.id)?.source)
      .toHaveProperty('derivedFromSourceId', original.source.id)
  })

  it.each(['local-first', 'release-first', 'together'] as const)(
    '真实冠心病来源编号在导入时补齐持久关联，撤回换哈希后旧副本仍停用：%s', order => {
      const path = join(directory(), 'guidelines.sqlite')
      const writer = open(path)
      const released = JSON.parse(readFileSync(new URL('../reference-data/guideline-release-manifest.json', import.meta.url), 'utf8'))
      const registry = JSON.parse(readFileSync(new URL('../reference-data/local-guideline-sources.json', import.meta.url), 'utf8'))
      const original = { source: guidelineSourceDefinitionSchema.parse(released.sources.find((item: { source: { id: string } }) => item.source.id === 'coronary-01-2021').source),
        passages: [{ locator: '合成物理第1页', text: 'Coronary synthetic assessment evidence.' }] }
      original.source.license.usage = 'open'
      const uploaded = { source: guidelineSourceDefinitionSchema.parse(registry.sources[0].source), passages: original.passages }
      // Simulate older imports without the new explicit relationship.
      delete uploaded.source.derivedFromSourceId
      if (order === 'together') writer.importDocuments([original, uploaded])
      else for (const input of order === 'local-first' ? [uploaded, original] : [original, uploaded]) writer.importDocument(input)
      const reader = open(path, true, true)
      expect(reader.search('coronary').guidelines).toHaveLength(2)
      writer.importDocument({ source: { ...original.source, status: 'withdrawn', sha256: 'b'.repeat(64),
        url: 'https://example.org/withdrawal' }, passages: [] })
      expect(reader.search('coronary').guidelines).toEqual([])
      expect(reader.sources().find(item => item.source.id === uploaded.source.id)?.source)
        .toHaveProperty('derivedFromSourceId', 'coronary-01-2021')
      expect(open(path, true, true).search('coronary').guidelines).toEqual([])
    })

  it('派生链的原来源正文待核验时所有下游停用，缺省关联的重导不能切断链条', () => {
    const corpus = open()
    const original = document()
    original.source.distribution = { packageId: 'synthetic', releaseId: 'v1', textStatus: 'verified', verificationRecord: 'verified.json' }
    const intermediate = document()
    intermediate.source = { ...intermediate.source, id: 'hospital-reviewed-excerpt', derivedFromSourceId: original.source.id, sha256: 'b'.repeat(64) }
    const child = document()
    child.source = { ...child.source, id: 'hospital-department-copy', derivedFromSourceId: intermediate.source.id, sha256: 'c'.repeat(64) }
    corpus.importDocuments([original, intermediate, child])
    const staleChild = structuredClone(child)
    delete staleChild.source.derivedFromSourceId
    corpus.importDocument(staleChild)
    expect(corpus.sources().find(item => item.source.id === child.source.id)?.source)
      .toHaveProperty('derivedFromSourceId', intermediate.source.id)
    corpus.importDocument({ source: { ...original.source, sha256: 'd'.repeat(64),
      distribution: { ...original.source.distribution, textStatus: 'pending' } }, passages: [] })
    expect(corpus.search('软骨发育不全').guidelines).toEqual([])
  })

  it('原来源关联拒绝自引用和循环，失败不留下部分正文', () => {
    const corpus = open()
    const first = document()
    first.source.derivedFromSourceId = first.source.id
    expect(() => corpus.importDocument(first)).toThrow('cannot derive from itself')
    const second = document()
    second.source.id = 'second-source'
    first.source.derivedFromSourceId = second.source.id
    second.source.derivedFromSourceId = first.source.id
    expect(() => corpus.importDocuments([first, second])).toThrow('cycle')
    expect(corpus.sources()).toEqual([])
  })

  it('同字节对应多个原来源时要求明确关联，不猜测院内上传副本的归属', () => {
    const corpus = open()
    const first = document()
    const second = document()
    second.source.id = 'another-original'
    const child = document()
    child.source.id = 'local-evaluation-hospital-upload-42'
    expect(() => corpus.importDocuments([first, second, child])).toThrow('ambiguous')
    expect(corpus.sources()).toEqual([])
    child.source.derivedFromSourceId = second.source.id
    expect(() => corpus.importDocuments([first, second, child])).not.toThrow()
  })

  it('旧库原件和副本同批更换文件时，仍从更新前记录恢复稳定关联', () => {
    const path = join(directory(), 'guidelines.sqlite')
    const corpus = open(path, false, true)
    const original = document()
    const child = document()
    child.source.id = 'local-evaluation-hospital-upload-42'
    corpus.importDocument(child)
    const legacy = new Database(path)
    try {
      const source = legacy.prepare<[], { id: string; metadata: string; digest: string }>('SELECT * FROM guideline_source').get()!
      const passages = legacy.prepare<[], { id: string; source_id: string; locator: string; text: string }>('SELECT id, source_id, locator, text FROM guideline_passage').all()
      corpus.importDocument(original)
      legacy.transaction(() => {
        legacy.prepare('DELETE FROM guideline_passage WHERE source_id = ?').run(child.source.id)
        legacy.prepare('UPDATE guideline_source SET metadata = @metadata, digest = @digest WHERE id = @id').run(source)
        const insert = legacy.prepare('INSERT INTO guideline_passage(id, source_id, locator, text) VALUES(@id, @source_id, @locator, @text)')
        for (const passage of passages) insert.run(passage)
      })()
    } finally { legacy.close() }
    expect(corpus.search('软骨发育不全').guidelines).toHaveLength(2)
    const updatedChild = { ...child, source: { ...child.source, sha256: 'c'.repeat(64) } }
    corpus.importDocuments([
      { source: { ...original.source, status: 'withdrawn', sha256: 'b'.repeat(64) }, passages: [] },
      updatedChild,
    ])
    expect(corpus.sources().find(item => item.source.id === child.source.id)?.source)
      .toHaveProperty('derivedFromSourceId', original.source.id)
    expect(corpus.search('软骨发育不全').guidelines).toEqual([])
  })

  it('整包导入原子发布并保留其他来源，任一无效正文不能留下部分更新', () => {
    const path = join(directory(), 'guidelines.sqlite')
    const writer = open(path)
    const original = document()
    writer.importDocument(original)
    const reader = open(path, true)
    const before = reader.search('软骨发育不全')
    const added = document()
    added.source.id = 'second-source'
    added.source.version = '2027'
    const invalid = document()
    invalid.source.id = 'invalid-source'
    invalid.passages[0]!.text = ''
    expect(() => writer.importDocuments([added, invalid])).toThrow()
    expect(reader.sources()).toHaveLength(1)
    expect(reader.search('软骨发育不全')).toEqual(before)
    expect(writer.importDocuments([added])).toEqual({ created: true, passageCount: 1 })
    expect(reader.sources()).toHaveLength(2)
    expect(reader.search('软骨发育不全').revision).not.toBe(before.revision)
    expect(writer.importDocuments([added])).toEqual({ created: false, passageCount: 1 })
    expect(() => writer.importDocuments([added, added])).toThrow()
    expect(reader.sources()).toHaveLength(2)
  })

  it('只读整包核对检查实际正文，发现损坏后重复导入修复而不误信既有摘要', () => {
    const path = join(directory(), 'guidelines.sqlite')
    const writer = open(path)
    const input = document()
    writer.importDocument(input)
    const reader = open(path, true)
    expect(reader.matchesDocuments([input])).toBe(true)
    const other = document()
    other.source.id = 'unrelated-source'
    writer.importDocument(other)
    expect(reader.matchesDocuments([input])).toBe(true)
    const external = new Database(path)
    try {
      external.prepare('UPDATE guideline_passage SET text = ? WHERE source_id = ?').run('Damaged persisted source text.', input.source.id)
    } finally { external.close() }
    expect(reader.matchesDocuments([input])).toBe(false)
    expect(writer.importDocuments([input])).toEqual({ created: true, passageCount: 1 })
    expect(reader.matchesDocuments([input])).toBe(true)
    expect(reader.search('软骨发育不全').guidelines).toContainEqual(expect.objectContaining({ text: input.passages[0]!.text }))
    expect(reader.sources()).toHaveLength(2)
    expect(writer.importDocuments([input])).toEqual({ created: false, passageCount: 1 })
  })

  it('全文检索能找到未登记主题的新病种而不返回整个文档', () => {
    const corpus = open()
    const input = document()
    input.source.topics = []
    input.passages.push({ locator: '第三章，第 13 页', text: '合成病例中，肝豆状核变性需要进一步评估。' })
    corpus.importDocument(input)
    const result = corpus.search('肝豆状核变性')
    expect(result.guidelines.map(item => item.text)).toEqual([input.passages[1]!.text])
    expect(result.diagnosisQueries).toEqual([])
    expect(corpus.search('本次患者有肝豆状核变性表现，需要进一步明确').guidelines.map(item => item.text))
      .toEqual([input.passages[1]!.text])
  })

  it('本地已核原文可以保留真实出版页而不虚构下载地址', () => {
    const corpus = open()
    const input = document()
    const { downloadUrl: _downloadUrl, ...source } = input.source
    corpus.importDocument({ ...input, source })
    expect(corpus.sources()[0]?.source).not.toHaveProperty('downloadUrl')
    expect(corpus.search('软骨发育不全').guidelines[0]).toMatchObject({
      url: source.url, sourceHash: source.sha256, text: input.passages[0]!.text,
    })
  })

  it('本地验证用途只开放显式本地来源且关闭模式会停用，即使该来源另有开放许可', () => {
    const path = join(directory(), 'guidelines.sqlite')
    const writer = open(path)
    const local = document()
    local.source.id = 'local-evaluation-synthetic-coronary'
    local.source.license.usage = 'non-commercial'
    writer.importDocument(local)
    const other = document()
    other.source.id = 'synthetic-other-non-commercial'
    other.source.license.usage = 'non-commercial'
    other.passages = [{ locator: 'another original', text: '软骨发育不全其他来源，不属于本次本地验证资料。' }]
    writer.importDocument(other)
    const ordinary = open(path, true)
    const evaluation = open(path, true, true)
    expect(ordinary.search('软骨发育不全').guidelines).toEqual([])
    const result = evaluation.search('软骨发育不全')
    expect(result.guidelines.map(item => item.text)).toEqual([local.passages[0]!.text])
    expect(result.revision).not.toBe(ordinary.search('软骨发育不全').revision)
    expect(evaluation.sources().find(item => item.source.id === local.source.id)?.source.license.usage).toBe('non-commercial')
    local.source.license.usage = 'open'
    writer.importDocument(local)
    expect(ordinary.search('软骨发育不全').guidelines).toEqual([])
  })

  it('原来源稳定身份撤回后停用派生原文，即使撤回记录同时换了网址和哈希', () => {
    const corpus = open(undefined, false, true)
    const parent = document()
    parent.source.license.usage = 'unverified'
    corpus.importDocument({ source: parent.source, passages: [] })
    const local = document()
    local.source.id = `local-evaluation-${parent.source.id}`
    local.source.license.usage = 'unverified'
    corpus.importDocument(local)
    expect(corpus.search('软骨发育不全').guidelines).toHaveLength(1)
    corpus.importDocument({ source: { ...parent.source, status: 'withdrawn',
      url: 'https://example.org/withdrawal', sha256: 'b'.repeat(64) }, passages: [] })
    expect(corpus.search('软骨发育不全').guidelines).toEqual([])
  })

  it('同条原文的来源适用条件变化后不继续使用旧依据身份', () => {
    const corpus = open()
    const input = document()
    corpus.importDocument(input)
    const before = corpus.search('软骨发育不全').guidelines[0]!
    input.source.scope = '更新后的适用条件：仅限已完成正式评估的成人。'
    corpus.importDocument(input)
    const after = corpus.search('软骨发育不全').guidelines[0]!
    expect(after.text).toBe(before.text)
    expect(after.locator).toBe(before.locator)
    expect(after.scope).toBe(input.source.scope)
    expect(after.id).not.toBe(before.id)
  })

  it('只返回病例与段落相关主题的登记中文诊断词，中文词可以检索英文原文', () => {
    const corpus = open()
    const input = document()
    input.source.topics.push({ terms: ['糖尿病', 'diabetes'], diagnosisQueries: ['糖尿病'] })
    input.passages = [
      { locator: 'Recommendation 1', text: 'Achondroplasia requires further assessment. Do not diagnose using height alone.' },
      { locator: 'Recommendation 2', text: 'Diabetes requires confirmation before treatment.' },
    ]
    corpus.importDocument(input)
    expect(corpus.search('软骨发育不全').guidelines.map(item => item.text)).toEqual([input.passages[0]!.text])
    expect(corpus.search('软骨发育不全').diagnosisQueries).toEqual(['软骨发育不全'])
    expect(corpus.search('ACHONDROPLASIA').diagnosisQueries).toEqual(['软骨发育不全'])
  })

  it('未核实许可及已撤回或被替代的来源不成为运行时证据', () => {
    const corpus = open()
    const input = document()
    corpus.importDocument(input)
    const revision = corpus.search('软骨发育不全').revision
    input.source.license.usage = 'unverified'
    corpus.importDocument(input)
    expect(corpus.search('软骨发育不全').guidelines).toEqual([])
    expect(corpus.search('软骨发育不全').diagnosisQueries).toEqual([])
    expect(corpus.search('软骨发育不全').revision).not.toBe(revision)
    input.source.license.usage = 'non-commercial'
    input.source.status = 'withdrawn'
    corpus.importDocument(input)
    expect(corpus.search('软骨发育不全').guidelines).toEqual([])
    input.source.status = 'superseded'
    corpus.importDocument(input)
    expect(corpus.search('软骨发育不全').guidelines).toEqual([])
    input.source.status = 'active'
    corpus.importDocument(input)
    expect(corpus.search('软骨发育不全').guidelines).toEqual([])
  })

  it('默认不检索非商业全文，只有显式声明用途的连接可读取且两种用途的指纹不同', () => {
    const path = join(directory(), 'guidelines.sqlite')
    const writer = open(path)
    const input = document()
    input.source.license.usage = 'non-commercial'
    writer.importDocument(input)
    const denied = writer.search('软骨发育不全')
    expect(denied.guidelines).toEqual([])
    expect(denied.diagnosisQueries).toEqual([])
    const allowed = new GuidelineCorpus({ databasePath: path, readOnly: true, allowNonCommercial: true })
    corpora.push(allowed)
    const permitted = allowed.search('软骨发育不全')
    expect(permitted.guidelines.map(item => item.text)).toEqual([input.passages[0]!.text])
    expect(permitted.diagnosisQueries).toEqual(['软骨发育不全'])
    expect(permitted.revision).not.toBe(denied.revision)
    expect(open(path, true).search('软骨发育不全')).toEqual(denied)
    input.source.license.usage = 'unverified'
    writer.importDocument(input)
    expect(allowed.search('软骨发育不全').guidelines).toEqual([])
  })

  it('内部测试只启用固定资料包内已核验正文，保留原始用途并将策略纳入检索版本', () => {
    const path = join(directory(), 'guidelines.sqlite')
    const writer = open(path)
    const input = document()
    input.source.license.usage = 'unverified'
    input.source.distribution = { packageId: 'synthetic-guidelines', releaseId: 'synthetic-v1',
      textStatus: 'verified', verificationRecord: 'verification/synthetic-source.json' }
    writer.importDocument(input)
    const internal = new GuidelineCorpus({ databasePath: path, readOnly: true, deploymentPolicy: 'internal-testing' })
    corpora.push(internal)
    expect(writer.search('软骨发育不全').guidelines).toEqual([])
    expect(internal.search('软骨发育不全').guidelines.map(item => item.text)).toEqual([input.passages[0]!.text])
    expect(internal.sources()[0]!.source.license.usage).toBe('unverified')
    expect(internal.search('软骨发育不全').revision).not.toBe(writer.search('软骨发育不全').revision)
    const previous = internal.search('软骨发育不全').revision
    for (const textStatus of ['pending', 'unreadable'] as const) {
      writer.importDocument({ ...input, source: { ...input.source, license: { ...input.source.license, usage: 'open' },
        distribution: { ...input.source.distribution, textStatus } } })
      expect(internal.search('软骨发育不全').guidelines).toEqual([])
      expect(writer.search('软骨发育不全').guidelines).toEqual([])
      expect(internal.search('软骨发育不全').revision).not.toBe(previous)
    }
    for (const status of ['withdrawn', 'superseded'] as const) {
      writer.importDocument({ ...input, source: { ...input.source, status } })
      expect(internal.search('软骨发育不全').guidelines).toEqual([])
    }
    const unregistered = document()
    unregistered.source.license.usage = 'unverified'
    writer.importDocument(unregistered)
    expect(internal.search('软骨发育不全').guidelines).toEqual([])
  })

  it('旧用途限制不能覆盖新包更严格的许可，核对与导入采用同一限制合并', () => {
    const path = join(directory(), 'guidelines.sqlite')
    const writer = open(path)
    const input = document()
    writer.importDocument(input)
    writer.importDocument({ ...input, source: { ...input.source, license: { ...input.source.license, usage: 'non-commercial' } } })
    const next = document()
    next.source.license.usage = 'unverified'
    const reader = new GuidelineCorpus({ databasePath: path, readOnly: true, allowNonCommercial: true })
    corpora.push(reader)
    expect(reader.search('软骨发育不全').guidelines).toHaveLength(1)
    expect(writer.matchesDocuments([next], { preserveRestrictions: true })).toBe(false)
    writer.importDocuments([next], { preserveRestrictions: true })
    expect(reader.sources()[0]!.source.license.usage).toBe('unverified')
    expect(reader.search('软骨发育不全').guidelines).toEqual([])
    expect(writer.matchesDocuments([next], { preserveRestrictions: true })).toBe(true)
  })

  it.each(['pending', 'unreadable'] as const)('用途限制保留分发身份时仍尊重新包正文限制：%s', textStatus => {
    const path = join(directory(), 'guidelines.sqlite')
    const writer = open(path)
    const input = document()
    input.source.distribution = { packageId: 'synthetic-guidelines', releaseId: 'v1', textStatus: 'verified', verificationRecord: 'v1.json' }
    writer.importDocument(input)
    writer.importDocument({ ...input, source: { ...input.source, license: { ...input.source.license, usage: 'non-commercial' } } })
    const reader = new GuidelineCorpus({ databasePath: path, readOnly: true, deploymentPolicy: 'internal-testing' })
    corpora.push(reader)
    expect(reader.search('软骨发育不全').guidelines).toHaveLength(1)
    const next = { ...input, source: { ...input.source, version: '2027',
      distribution: { ...input.source.distribution, releaseId: 'v2', verificationRecord: 'v2.json', textStatus } } }
    expect(writer.matchesDocuments([next], { preserveRestrictions: true })).toBe(false)
    writer.importDocuments([next], { preserveRestrictions: true })
    expect(reader.search('软骨发育不全').guidelines).toEqual([])
    expect(reader.sources()[0]!.source.distribution).toMatchObject({ releaseId: 'v2', verificationRecord: 'v2.json', textStatus })
  })

  it('结果限制为八段并遵守序列化预算，保留完整原段落及限定语', () => {
    const corpus = open()
    const input = document()
    input.passages = Array.from({ length: 12 }, (_, index) => ({
      locator: `第 ${index + 1} 节`,
      text: `软骨发育不全。${'合成资料用于检索回归。'.repeat(700)}不得仅凭身高确诊。`,
    }))
    corpus.importDocument(input)
    const result = corpus.search('软骨发育不全')
    expect(result.guidelines.length).toBeGreaterThan(0)
    expect(result.guidelines.length).toBeLessThanOrEqual(8)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(48 * 1024)
    for (const evidence of result.guidelines) {
      expect(input.passages.find(passage => passage.locator === evidence.locator)?.text).toBe(evidence.text)
      expect(evidence.text).toMatch(/不得仅凭身高确诊。$/)
    }
  })

  it('只读连接不创建数据库，写入者拒绝占用不属于指南库的已有文件', () => {
    const missing = join(directory(), 'missing.sqlite')
    expect(() => open(missing, true)).toThrow()
    expect(existsSync(missing)).toBe(false)
    const foreign = join(directory(), 'business.sqlite')
    const database = new Database(foreign)
    database.exec('CREATE TABLE clinical_document (id TEXT PRIMARY KEY) STRICT')
    database.close()
    expect(() => open(foreign)).toThrow('Unsupported guideline corpus schema')
    expect(() => open(foreign, true)).toThrow('Unsupported guideline corpus schema')
  })

  it('两个中文字可通过登记别名匹配英文正文，FTS特殊字符按普通病例文本处理', () => {
    const corpus = open()
    const input = document()
    input.source.topics = [{ terms: ['抑郁', 'depression'], diagnosisQueries: ['抑郁障碍'] }]
    input.passages = [{ locator: 'Recommendation 1', text: 'Adults with depression need a full assessment.' }]
    corpus.importDocument(input)
    expect(corpus.search('抑郁').guidelines.map(item => item.text)).toEqual([input.passages[0]!.text])
    expect(corpus.search('抑郁 " OR NOT (x:* NEAR/5) --').diagnosisQueries).toEqual(['抑郁障碍'])
  })

  it('同内容重复导入不产生新版本，非法更新不抹掉已有原文', () => {
    const corpus = open()
    const input = document()
    corpus.importDocument(input)
    const before = corpus.search('软骨发育不全')
    expect(corpus.importDocument(structuredClone(input))).toEqual({ created: false, passageCount: 1 })
    for (const invalid of ['', ' ', 'x'.repeat(12_001)]) {
      const update = document()
      update.passages[0]!.text = invalid
      expect(() => corpus.importDocument(update)).toThrow()
      expect(corpus.search('软骨发育不全')).toEqual(before)
    }
    const duplicate = document()
    duplicate.passages.push({ ...duplicate.passages[0]! })
    expect(() => corpus.importDocument(duplicate)).toThrow()
    const unexpected = Object.assign(document(), { hiddenField: 'not allowed' })
    expect(() => corpus.importDocument(unexpected)).toThrow()
    const nested = document()
    Object.assign(nested.source.license, { permitted: true })
    expect(() => corpus.importDocument(nested)).toThrow()
    expect(corpus.search('软骨发育不全')).toEqual(before)
  })

  it('已有只读连接立即看到后续导入，全库身份变化使未命中查询也失效', () => {
    const path = join(directory(), 'guidelines.sqlite')
    const writer = open(path)
    writer.importDocument(document())
    const reader = open(path, true)
    const before = reader.search('软骨发育不全')
    const other = document()
    other.source.id = 'different-topic'
    other.source.topics = [{ terms: ['糖尿病', 'diabetes'], diagnosisQueries: ['糖尿病'] }]
    other.passages = [{ locator: 'Recommendation 3', text: 'Diabetes requires a separate assessment.' }]
    writer.importDocument(other)
    const after = reader.search('软骨发育不全')
    expect(after.guidelines).toEqual(before.guidelines)
    expect(after.revision).not.toBe(before.revision)
    expect(reader.search('糖尿病').guidelines.map(item => item.text)).toEqual([other.passages[0]!.text])
    expect(() => reader.importDocument({ ...other, source: { ...other.source, version: '2027' } })).toThrow()
    expect(reader.sources()).toHaveLength(2)
    for (const update of [
      { ...other, source: { ...other.source, status: 'withdrawn' as const } },
      { ...other, source: { ...other.source, license: { ...other.source.license, usage: 'unverified' as const } } },
      { ...other, source: { ...other.source, version: '2027', sha256: 'b'.repeat(64) } },
      { ...other, passages: [{ locator: 'Recommendation 3', text: 'Diabetes requires confirmation.' }] },
    ]) {
      const previous = reader.search('no such disease').revision
      writer.importDocument(update)
      expect(reader.search('no such disease').revision).not.toBe(previous)
    }
  })

  it('证据标识绑定来源版本、哈希及定位，同内容查询返回确定顺序', () => {
    const corpus = open()
    const input = document()
    corpus.importDocument(input)
    const before = corpus.search('软骨发育不全')
    expect(corpus.search('软骨发育不全')).toEqual(before)
    input.source.version = '2027'
    input.source.sha256 = 'b'.repeat(64)
    corpus.importDocument(input)
    const after = corpus.search('软骨发育不全')
    expect(after.guidelines[0]!.id).not.toBe(before.guidelines[0]!.id)
    expect(after.guidelines[0]!.sourceHash).toBe('b'.repeat(64))
    expect(after.revision).not.toBe(before.revision)
  })

  it('无匹配或空查询返回空结果及全库版本，来源状态仍可检查', () => {
    const corpus = open()
    corpus.importDocument(document())
    for (const query of ['', '  ', 'unknown-synthetic-condition', '"* OR ( )']) {
      expect(corpus.search(query)).toEqual({ guidelines: [], diagnosisQueries: [], inactiveSources: [], revision: corpus.search('').revision })
    }
    expect(corpus.sources()).toHaveLength(1)
  })

  it('登记诊断查询必须含中文，不将英文别名泄漏到中文诊断目录', () => {
    const corpus = open()
    const input = document()
    input.source.topics[0]!.diagnosisQueries = ['achondroplasia']
    expect(() => corpus.importDocument(input)).toThrow()
    expect(corpus.sources()).toEqual([])
  })

  it('跨来源按病例相关性选择证据，先导入的普通匹配不能挤掉具体病种', () => {
    const corpus = open()
    const generic = document()
    generic.source.id = 'aaa-generic-assessment'
    generic.source.topics = []
    generic.passages = Array.from({ length: 12 }, (_, index) => ({ locator: `Section ${index}`, text: 'An assessment can be performed for many conditions.' }))
    corpus.importDocument(generic)
    const specific = document()
    specific.source.id = 'zzz-achondroplasia'
    specific.passages = Array.from({ length: 9 }, (_, index) => ({
      locator: `Recommendation ${index + 1}`, text: 'Achondroplasia requires a focused assessment.',
    }))
    corpus.importDocument(specific)
    const result = corpus.search('achondroplasia assessment')
    expect(result.guidelines[0]!.text).toBe(specific.passages[0]!.text)
    expect(result.guidelines).toHaveLength(8)
    expect(result.guidelines.every(item => item.text === specific.passages[0]!.text)).toBe(true)
  })

  it('混合病例的同等相关主题先覆盖不同来源，重复段落不能挤掉另一主题依据', () => {
    const corpus = open()
    const history = document()
    history.source.id = 'synthetic-hypertension-history'
    history.source.topics = [{ terms: ['高血压', 'hypertension', 'assessment'], diagnosisQueries: ['高血压'] }]
    history.passages = Array.from({ length: 12 }, (_, index) => ({
      locator: `History recommendation ${index}`,
      text: 'Hypertension assessment assessment assessment requires monitoring.',
    }))
    const current = document()
    current.source.id = 'synthetic-postprocedure-assessment'
    current.source.topics = [{ terms: ['术后评估', 'assessment'], diagnosisQueries: [] }]
    current.passages = [{ locator: 'Discharge assessment', text: 'Assessment before discharge requires a caregiver, reliable follow-up, medication review, a contact number for urgent concerns, and confirmation that the patient understands the care plan.' }]
    corpus.importDocuments([history, current])

    const result = corpus.search('既往高血压，目前需要术后评估和出院照护条件')
    expect(result.guidelines).toContainEqual(expect.objectContaining({
      locator: 'Discharge assessment', text: current.passages[0]!.text,
    }))
    expect(result.guidelines).toHaveLength(8)
    expect(result.diagnosisQueries).toEqual(['高血压'])
  })

  it('检索保留原段落的空白与原有换行，不改写取得的原文', () => {
    const corpus = open()
    const input = document()
    input.passages[0]!.text = '\n  软骨发育不全需要评估。\n不得仅凭身高确诊。  \n'
    corpus.importDocument(input)
    expect(corpus.search('软骨发育不全').guidelines[0]!.text).toBe(input.passages[0]!.text)
  })

  it('保存完整原文但隔离控制字符和替换字符段落，邻近正常条款仍可检索', () => {
    const corpus = open()
    const input = document()
    input.passages = [
      { locator: '第1页阈值条款', text: '软骨发育不全阈值为 5\u0002ULN，需结合病例评估。' },
      { locator: '第2页单位条款', text: '软骨发育不全阈值为 5\uFFFDULN，单位不得猜测。' },
      { locator: '第3页正常条款', text: '\t软骨发育不全需要进一步评估。\r\n不得仅凭身高确诊。\n' },
      { locator: '第4页异常条款', text: '软骨发育不全阈值为 5\u0082ULN，单位不得猜测。' },
    ]
    corpus.importDocument(input)
    expect(corpus.search('软骨发育不全').guidelines.map(item => item.text)).toEqual([input.passages[2]!.text])
    expect(corpus.sources()).toEqual([{ source: input.source, passageCount: 4, unusablePassageCount: 3 }])
    expect(corpus.matchesDocuments([input])).toBe(true)
    const normal = document()
    corpus.importDocument(normal)
    expect(corpus.sources()).toEqual([{ source: normal.source, passageCount: 1 }])
  })

  it('无需重新下载正文即可原子撤回、替代或撤销来源许可，可用来源仍拒绝空正文', () => {
    const corpus = open()
    const input = document()
    for (const source of [
      { ...input.source, status: 'withdrawn' as const },
      { ...input.source, status: 'superseded' as const },
      { ...input.source, license: { ...input.source.license, usage: 'unverified' as const } },
    ]) {
      corpus.importDocument(input)
      const before = corpus.search('软骨发育不全')
      expect(corpus.importDocument({ source, passages: [] })).toEqual({ created: true, passageCount: 0 })
      expect(corpus.search('软骨发育不全').guidelines).toEqual([])
      expect(corpus.search('软骨发育不全').revision).not.toBe(before.revision)
    }
    corpus.importDocument(input)
    const before = corpus.search('软骨发育不全')
    expect(() => corpus.importDocument({ source: input.source, passages: [] })).toThrow()
    expect(corpus.search('软骨发育不全')).toEqual(before)
  })
})
