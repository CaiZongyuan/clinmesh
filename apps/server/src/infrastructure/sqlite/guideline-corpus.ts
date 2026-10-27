import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { guidelineEvidenceSchema, type GuidelineEvidence } from '@clinmesh/contracts/doctor-recommendations'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { guidelinePassagePolicyRevision, isGuidelinePassageUsable, isGuidelineSourceUsable } from '../../application/guideline-corpus.ts'
import type {
  GuidelineDocument,
  GuidelineDeploymentPolicy,
  GuidelineSearchResult,
  GuidelineSourceDefinition,
  GuidelineSourceStatus,
} from '../../application/guideline-corpus.ts'

const identity = z.string().trim().min(1).max(256)
const licenseSchema = z.object({
  id: identity, url: z.url(), usage: z.enum(['open', 'non-commercial', 'unverified']),
}).strict()
const distributionSchema = z.object({
  packageId: identity, releaseId: identity, textStatus: z.enum(['verified', 'pending', 'unreadable']),
  verificationRecord: z.string().trim().min(1).max(2_000),
}).strict()
export const guidelineSourceDefinitionSchema = guidelineEvidenceSchema.omit({
  locator: true, text: true, sourceHash: true,
}).extend({
  downloadUrl: z.url(),
  format: z.enum(['pdf', 'text']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['active', 'withdrawn', 'superseded']),
  license: licenseSchema,
  distribution: distributionSchema.optional(),
  topics: z.array(z.object({
    terms: z.array(identity).min(1),
    diagnosisQueries: z.array(identity.regex(/\p{Script=Han}/u)),
  }).strict()),
}).strict().transform(({ publishedAt, effectiveAt, distribution, ...source }) => ({
  ...source,
  ...(publishedAt === undefined ? {} : { publishedAt }),
  ...(effectiveAt === undefined ? {} : { effectiveAt }),
  ...(distribution === undefined ? {} : { distribution }),
}))

const passageSchema = z.object({
  locator: guidelineEvidenceSchema.shape.locator,
  text: z.string().min(1).max(12_000).refine(text => text.trim().length > 0),
}).strict()
const documentSchema = z.object({
  source: guidelineSourceDefinitionSchema,
  passages: z.array(passageSchema),
}).strict().refine(document => document.passages.length > 0
  || document.source.status !== 'active' || document.source.license.usage !== 'open'
  || (document.source.distribution !== undefined && document.source.distribution.textStatus !== 'verified'),
  'Available guidelines require readable passages')
  .refine(document => new Set(document.passages.map(passage => passage.locator)).size === document.passages.length,
  'Guideline passage locators must be unique')
const sourceRowSchema = z.object({ metadata: z.string(), digest: z.string(), passageCount: z.number().int().nonnegative(),
  unusablePassageCount: z.number().int().nonnegative() })
const passageRowSchema = z.object({ id: z.string(), locator: z.string(), text: z.string(), rank: z.number() })
const storedDocumentSchema = z.object({ metadata: z.string(), digest: z.string() })
const storedPassagesSchema = z.array(z.object({ id: z.string(), locator: z.string(), text: z.string() }))
const documentsSchema = z.array(documentSchema).refine(items => new Set(items.map(item => item.source.id)).size === items.length,
  'Guideline source IDs must be unique within a release')
const restrictionSchema = z.object({
  status: z.enum(['withdrawn', 'superseded']).optional(),
  textStatus: z.enum(['pending', 'unreadable']).optional(),
  distributionDisabled: z.literal(true).optional(),
  license: licenseSchema.optional(),
}).strict()
type SourceRestriction = z.infer<typeof restrictionSchema>
const applicationId = 0x434d4743
const searchRevision = 'topic-source-rounds-v1'

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function restrictionDigest(restriction: SourceRestriction): string {
  return hash(JSON.stringify([restriction.status, restriction.textStatus, restriction.distributionDisabled, restriction.license]))
}

function sourceRestriction(source: GuidelineSourceDefinition, previous?: GuidelineSourceDefinition): SourceRestriction {
  const restriction: SourceRestriction = {}
  if (source.status !== 'active') restriction.status = source.status
  if (source.distribution !== undefined && source.distribution.textStatus !== 'verified') restriction.textStatus = source.distribution.textStatus
  const tightenedLicense = previous !== undefined && previous.license.usage !== source.license.usage
    && (source.license.usage === 'unverified' || previous.license.usage === 'open')
  if (tightenedLicense) {
    restriction.license = source.license
    if (source.distribution === undefined) restriction.distributionDisabled = true
  }
  return restriction
}

export class GuidelineCorpus {
  readonly #database: Database.Database
  readonly #allowNonCommercial: boolean
  readonly #deploymentPolicy: GuidelineDeploymentPolicy

  constructor(options: { databasePath: string; readOnly?: boolean; allowNonCommercial?: boolean; deploymentPolicy?: GuidelineDeploymentPolicy }) {
    this.#allowNonCommercial = options.allowNonCommercial === true
    this.#deploymentPolicy = options.deploymentPolicy ?? 'default'
    if (!options.readOnly) mkdirSync(dirname(options.databasePath), { recursive: true })
    this.#database = new Database(options.databasePath, options.readOnly
      ? { readonly: true, fileMustExist: true }
      : undefined)
    try {
      const version = this.#database.pragma('user_version', { simple: true })
      if (version === 0 && !options.readOnly) {
        if (this.#database.pragma('application_id', { simple: true }) !== 0
          || this.#database.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get() !== undefined) {
          throw new Error('Unsupported guideline corpus schema')
        }
        this.#database.transaction(() => this.#database.exec(`
          CREATE TABLE guideline_source (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
          CREATE TABLE guideline_passage (
            id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES guideline_source(id),
            locator TEXT NOT NULL, text TEXT NOT NULL
          ) STRICT;
          CREATE INDEX guideline_passage_source ON guideline_passage(source_id);
          CREATE VIRTUAL TABLE guideline_passage_fts USING fts5(
            text, content = 'guideline_passage', content_rowid = 'rowid', tokenize = 'trigram'
          );
          CREATE TRIGGER guideline_passage_insert AFTER INSERT ON guideline_passage BEGIN
            INSERT INTO guideline_passage_fts (rowid, text) VALUES (new.rowid, new.text);
          END;
          CREATE TRIGGER guideline_passage_delete AFTER DELETE ON guideline_passage BEGIN
            INSERT INTO guideline_passage_fts (guideline_passage_fts, rowid, text)
            VALUES ('delete', old.rowid, old.text);
          END;
          PRAGMA application_id = ${applicationId};
          PRAGMA user_version = 1;
        `))()
      }
      if (this.#database.pragma('application_id', { simple: true }) !== applicationId
        || ![1, 2].includes(Number(this.#database.pragma('user_version', { simple: true })))) {
        throw new Error('Unsupported guideline corpus schema')
      }
      this.#database.pragma('foreign_keys = ON')
      this.#database.pragma('busy_timeout = 5000')
      if (!options.readOnly) this.#database.pragma('journal_mode = WAL')
      this.#database.function('guideline_passage_usable', { deterministic: true }, text =>
        typeof text === 'string' && isGuidelinePassageUsable({ text }) ? 1 : 0)
      if (!options.readOnly && this.#database.pragma('user_version', { simple: true }) === 1) {
        this.#database.transaction(() => {
          this.#database.exec('CREATE TABLE guideline_source_restriction (id TEXT PRIMARY KEY, restriction TEXT NOT NULL) STRICT')
          const rows = z.array(z.object({ metadata: z.string() })).parse(this.#database.prepare('SELECT metadata FROM guideline_source').all())
          for (const row of rows) {
            const source = guidelineSourceDefinitionSchema.parse(JSON.parse(row.metadata))
            this.#saveRestriction(source.id, sourceRestriction(source))
          }
          this.#database.pragma('user_version = 2')
        })()
      }
    } catch (error) {
      this.#database.close()
      throw error
    }
  }

  importDocument(input: GuidelineDocument): { created: boolean; passageCount: number } {
    return this.importDocuments([input])
  }

  importDocuments(inputs: readonly GuidelineDocument[], options: { preserveRestrictions?: boolean } = {}): { created: boolean; passageCount: number } {
    const documents = documentsSchema.parse(inputs)
    return this.#database.transaction(() => {
      let created = false
      let passageCount = 0
      if (!this.hasValidSearchIndex()) {
        this.#database.exec("INSERT INTO guideline_passage_fts(guideline_passage_fts) VALUES('rebuild')")
        created = true
      }
      for (const input of documents) {
        const previousRestriction = this.#restriction(input.source.id)
        const restriction = options.preserveRestrictions ? this.#releaseRestriction(input.source)
          : sourceRestriction(input.source, this.#storedSource(input.source.id))
        if (!options.preserveRestrictions && previousRestriction.textStatus !== undefined && input.source.distribution === undefined) {
          if (input.source.status === 'active') throw new Error('Guideline text restriction requires an explicit verification status before maintenance import')
          restriction.textStatus = previousRestriction.textStatus
        }
        if (!options.preserveRestrictions && previousRestriction.license?.usage === input.source.license.usage && input.source.distribution === undefined) {
          // Maintenance sync first restricts use, then imports the fetched body.
          // That second write must retain the restriction even if its license is unchanged.
          restriction.license = input.source.license
          restriction.distributionDisabled = true
        }
        this.#saveRestriction(input.source.id, restriction)
        const document = options.preserveRestrictions ? this.#withRestriction(input, restriction) : input
        passageCount += document.passages.length
        const digest = hash(JSON.stringify(document))
        const existing = this.#storedDocumentIntegrity(document.source.id)
        if (existing?.valid && existing.digest === digest) continue
        created = true
        this.#database.prepare('DELETE FROM guideline_passage WHERE source_id = ?').run(document.source.id)
        this.#database.prepare(`
          INSERT INTO guideline_source (id, metadata, digest) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET metadata = excluded.metadata, digest = excluded.digest
        `).run(document.source.id, JSON.stringify(document.source), digest)
        const insert = this.#database.prepare('INSERT INTO guideline_passage (id, source_id, locator, text) VALUES (?, ?, ?, ?)')
        for (const passage of document.passages) {
          const id = hash(JSON.stringify([document.source.id, document.source.version, document.source.sha256, passage.locator]))
          insert.run(id, document.source.id, passage.locator, passage.text)
        }
      }
      return { created, passageCount }
    })()
  }

  matchesDocuments(inputs: readonly GuidelineDocument[], options: { preserveRestrictions?: boolean } = {}): boolean {
    const documents = documentsSchema.parse(inputs)
    return this.#database.transaction(() => documents.every(input => {
      const restriction = options.preserveRestrictions ? this.#releaseRestriction(input.source) : undefined
      if (restriction !== undefined && restrictionDigest(restriction) !== restrictionDigest(this.#restriction(input.source.id))) return false
      const document = restriction === undefined ? input : this.#withRestriction(input, restriction)
      const existing = this.#storedDocumentIntegrity(document.source.id)
      return existing?.valid === true && existing.digest === hash(JSON.stringify(document))
    }))()
  }

  #restriction(sourceId: string): SourceRestriction {
    const stored = this.#database.prepare('SELECT restriction FROM guideline_source_restriction WHERE id = ?').get(sourceId)
    return stored === undefined ? {} : restrictionSchema.parse(JSON.parse(z.object({ restriction: z.string() }).parse(stored).restriction))
  }

  #releaseRestriction(source: GuidelineSourceDefinition): SourceRestriction {
    const stored = this.#storedSource(source.id)
    const restriction = { ...sourceRestriction(source, stored),
      ...(stored === undefined ? {} : sourceRestriction(stored, source)), ...this.#restriction(source.id) }
    // A version-1 corpus has no separate license history. Comparing its current
    // rights with the locked source also preserves restrictions published before migration.
    if (restriction.license !== undefined && (source.license.usage === 'unverified'
      || (source.license.usage === 'non-commercial' && restriction.license.usage === 'open'))) restriction.license = source.license
    if (source.distribution !== undefined && source.distribution.textStatus !== 'verified'
      && restriction.textStatus !== 'unreadable') restriction.textStatus = source.distribution.textStatus
    return restriction
  }

  #storedSource(sourceId: string): GuidelineSourceDefinition | undefined {
    const row = z.object({ metadata: z.string() }).safeParse(this.#database.prepare('SELECT metadata FROM guideline_source WHERE id = ?').get(sourceId))
    if (!row.success) return undefined
    let metadata: unknown
    try { metadata = JSON.parse(row.data.metadata) } catch { return undefined }
    const source = guidelineSourceDefinitionSchema.safeParse(metadata)
    return source.success ? source.data : undefined
  }

  #saveRestriction(sourceId: string, restriction: SourceRestriction): void {
    if (Object.keys(restriction).length === 0) this.#database.prepare('DELETE FROM guideline_source_restriction WHERE id = ?').run(sourceId)
    else this.#database.prepare(`INSERT INTO guideline_source_restriction (id, restriction) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET restriction = excluded.restriction`).run(sourceId, JSON.stringify(restriction))
  }

  #withRestriction(document: GuidelineDocument, restriction: SourceRestriction): GuidelineDocument {
    const source = { ...document.source }
    if (restriction.status !== undefined) source.status = restriction.status
    if (restriction.license !== undefined) source.license = restriction.license
    if (restriction.textStatus !== undefined) {
      if (source.distribution === undefined) throw new Error('Restricted guideline text requires release provenance')
      source.distribution = { ...source.distribution, textStatus: restriction.textStatus }
    } else if (restriction.distributionDisabled) delete source.distribution
    return { source, passages: document.passages }
  }

  // SQLite requires a writable connection for this command even though it only
  // checks the index. Read-only preparation runs it on its disposable snapshot.
  hasValidSearchIndex(): boolean {
    try {
      this.#database.exec("INSERT INTO guideline_passage_fts(guideline_passage_fts, rank) VALUES('integrity-check', 1)")
      return true
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'SQLITE_CORRUPT_VTAB') return false
      throw error
    }
  }

  #storedDocumentIntegrity(sourceId: string): { digest: string; valid: boolean } | undefined {
    const stored = this.#database.prepare('SELECT metadata, digest FROM guideline_source WHERE id = ?').get(sourceId)
    if (stored === undefined) return undefined
    const row = storedDocumentSchema.safeParse(stored)
    if (!row.success) return { digest: '', valid: false }
    const invalid = { digest: row.data.digest, valid: false }
    const rows = storedPassagesSchema.safeParse(this.#database.prepare('SELECT id, locator, text FROM guideline_passage WHERE source_id = ? ORDER BY rowid').all(sourceId))
    if (!rows.success) return invalid
    let source: unknown
    try { source = JSON.parse(row.data.metadata) }
    catch { return invalid }
    const metadata = guidelineSourceDefinitionSchema.safeParse(source)
    if (!metadata.success || metadata.data.id !== sourceId) return invalid
    if (rows.data.some(passage => passage.id !== hash(JSON.stringify([sourceId, metadata.data.version, metadata.data.sha256, passage.locator])))) return invalid
    return { digest: row.data.digest, valid: hash(JSON.stringify({ source: metadata.data,
      passages: rows.data.map(({ locator, text }) => ({ locator, text })) })) === row.data.digest }
  }

  search(text: string): GuidelineSearchResult {
    return this.#database.transaction(() => {
      const rows = this.#sourceRows()
      const revision = hash(JSON.stringify([searchRevision, guidelinePassagePolicyRevision, this.#allowNonCommercial, this.#deploymentPolicy, rows.map(row => row.digest)]))
      const guidelines: GuidelineEvidence[] = []
      const diagnosisQueries = new Set<string>()
      const inactiveSources: GuidelineSearchResult['inactiveSources'] = []
      const candidates: Array<{ evidence: GuidelineEvidence; sourceId: string; queries: string[]; rank: number; topicMatches: number }> = []
      const queryText = text.toLowerCase()
      const tokens = text.match(/\p{Script=Han}+|[a-zA-Z0-9]+/gu) ?? []
      const terms = [...new Set(tokens.flatMap(token => /^\p{Script=Han}{4,}$/u.test(token)
        ? [token, ...Array.from({ length: token.length - 2 }, (_, index) => token.slice(index, index + 3))]
        : [token]))]
        .filter(term => [...term].length >= 2).slice(0, 96)
      for (const row of rows) {
        const source = guidelineSourceDefinitionSchema.parse(JSON.parse(row.metadata))
        if (source.status !== 'active' || (source.distribution !== undefined && source.distribution.textStatus !== 'verified')) {
          inactiveSources.push({ id: source.id, url: source.url, sourceHash: source.sha256 })
          continue
        }
        if (!isGuidelineSourceUsable(source, this.#allowNonCommercial, this.#deploymentPolicy)) continue
        const topics = source.topics.filter(topic => topic.terms.some(term => queryText.includes(term.toLowerCase())))
        const sourceTerms = [...new Set([...topics.flatMap(topic => topic.terms), ...terms])].slice(0, 128)
        const indexedTerms = sourceTerms.filter(term => [...term].length >= 3)
        const shortTerms = sourceTerms.filter(term => [...term].length === 2)
        const sourcePhrase = indexedTerms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')
        const passages = indexedTerms.length === 0 ? [] : z.array(passageRowSchema).parse(this.#database.prepare(`
          SELECT p.id, p.locator, p.text, bm25(guideline_passage_fts) AS rank FROM guideline_passage p
          JOIN guideline_passage_fts ON guideline_passage_fts.rowid = p.rowid
          WHERE p.source_id = ? AND guideline_passage_fts MATCH ? AND guideline_passage_usable(p.text)
          ORDER BY bm25(guideline_passage_fts), p.id LIMIT 64
        `).all(source.id, sourcePhrase))
        if (shortTerms.length > 0) passages.push(...z.array(passageRowSchema).parse(this.#database.prepare(`
          SELECT id, locator, text, 0 AS rank FROM guideline_passage WHERE source_id = ?
          AND guideline_passage_usable(text)
          AND (${shortTerms.map(() => 'instr(lower(text), lower(?)) > 0').join(' OR ')}) ORDER BY id LIMIT 64
        `).all(source.id, ...shortTerms)))
        const seen = new Set<string>()
        for (const passage of passages) {
          if (seen.has(passage.id)) continue
          seen.add(passage.id)
          const evidence = guidelineEvidenceSchema.parse({
            id: passage.id, title: source.title, publisher: source.publisher, documentType: source.documentType,
            version: source.version, publishedAt: source.publishedAt, effectiveAt: source.effectiveAt,
            url: source.url, scope: source.scope, sourceHash: source.sha256,
            locator: passage.locator, text: passage.text,
          })
          // 共享显示 schema 会 trim，检索保留原文中的空白。
          evidence.text = passage.text
          const queries = new Set<string>()
          let topicMatches = 0
          const passageText = passage.text.toLowerCase()
          for (const topic of topics) {
            if (!topic.terms.some(term => passageText.includes(term.toLowerCase()))) continue
            topicMatches++
            for (const query of topic.diagnosisQueries) queries.add(query)
          }
          candidates.push({ evidence, sourceId: source.id, queries: [...queries], rank: passage.rank, topicMatches })
        }
      }
      // 相同主题相关性先覆盖各来源，再取同源后续段落，避免重复依据占满预算。
      const sourceRounds = new Map<string, number>()
      const rankedCandidates = candidates.toSorted((left, right) => right.topicMatches - left.topicMatches
        || left.rank - right.rank || left.evidence.id.localeCompare(right.evidence.id)).map(candidate => {
        const key = JSON.stringify([candidate.topicMatches, candidate.sourceId])
        const sourceRound = sourceRounds.get(key) ?? 0
        sourceRounds.set(key, sourceRound + 1)
        return { ...candidate, sourceRound }
      })
      for (const candidate of rankedCandidates.toSorted((left, right) => right.topicMatches - left.topicMatches
        || left.sourceRound - right.sourceRound || left.rank - right.rank || left.evidence.id.localeCompare(right.evidence.id))) {
        if (guidelines.length === 8) break
        const queries = new Set([...diagnosisQueries, ...candidate.queries])
        if (Buffer.byteLength(JSON.stringify({ guidelines: [...guidelines, candidate.evidence], diagnosisQueries: [...queries], inactiveSources, revision })) > 48 * 1024) continue
        guidelines.push(candidate.evidence)
        for (const query of queries) diagnosisQueries.add(query)
      }
      return { guidelines, diagnosisQueries: [...diagnosisQueries], inactiveSources, revision }
    })()
  }

  sources(): GuidelineSourceStatus[] {
    return this.#sourceRows().map(row => ({
      source: guidelineSourceDefinitionSchema.parse(JSON.parse(row.metadata)), passageCount: row.passageCount,
      ...(row.unusablePassageCount > 0 ? { unusablePassageCount: row.unusablePassageCount } : {}),
    }))
  }

  #sourceRows() {
    return z.array(sourceRowSchema).parse(this.#database.prepare(`
      SELECT metadata, digest, (SELECT count(*) FROM guideline_passage p WHERE p.source_id = s.id) AS passageCount,
        (SELECT count(*) FROM guideline_passage p WHERE p.source_id = s.id AND NOT guideline_passage_usable(p.text)) AS unusablePassageCount
      FROM guideline_source s ORDER BY id
    `).all())
  }

  close(): void { this.#database.close() }
}
