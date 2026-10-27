import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { guidelineEvidenceSchema, type GuidelineEvidence } from '@clinmesh/contracts/doctor-recommendations'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { guidelinePassagePolicyRevision, guidelineSourceLineage, isGuidelinePassageUsable, isGuidelineSourceUsable, localEvaluationSourcePrefix } from '../../application/guideline-corpus.ts'
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
  derivedFromSourceId: identity.optional(),
  downloadUrl: z.url().optional(),
  format: z.enum(['pdf', 'text']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['active', 'withdrawn', 'superseded']),
  license: licenseSchema,
  distribution: distributionSchema.optional(),
  topics: z.array(z.object({
    terms: z.array(identity).min(1),
    diagnosisQueries: z.array(identity.regex(/\p{Script=Han}/u)),
  }).strict()),
}).strict().refine(source => source.derivedFromSourceId !== source.id, 'A guideline source cannot derive from itself')
  .transform(({ publishedAt, effectiveAt, distribution, downloadUrl, derivedFromSourceId, ...source }) => ({
  ...source,
  ...(derivedFromSourceId === undefined ? {} : { derivedFromSourceId }),
  ...(downloadUrl === undefined ? {} : { downloadUrl }),
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
  || document.source.id.startsWith(localEvaluationSourcePrefix)
  || (document.source.distribution !== undefined && document.source.distribution.textStatus !== 'verified'),
  'Available guidelines require readable passages')
  .refine(document => new Set(document.passages.map(passage => passage.locator)).size === document.passages.length,
  'Guideline passage locators must be unique')
const sourceRowSchema = z.object({ id: z.string(), metadata: z.string(), digest: z.string(), bodyId: z.string().nullable(), passageCount: z.number().int().nonnegative(),
  unusablePassageCount: z.number().int().nonnegative() })
const passageRowSchema = z.object({ id: z.string(), locator: z.string(), text: z.string(), rank: z.number() })
const storedDocumentSchema = z.object({ metadata: z.string(), digest: z.string(), body_id: z.string().nullable(), integrity_invalid: z.number().int() })
const storedPassagesSchema = z.array(z.object({ id: z.string(), ordinal: z.number().int(), locator: z.string(), text: z.string() }))
const bodySchema = z.object({ id: z.string(), format: z.enum(['pdf', 'text']), source_sha256: z.string(), version: z.string() })
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
const searchRevision = 'topic-shared-body-rounds-v3'

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function bodyIdentity(source: Pick<GuidelineSourceDefinition, 'format' | 'sha256' | 'version'>, passages: GuidelineDocument['passages']): string {
  return hash(JSON.stringify(['guideline-body-v1', source.format, source.sha256, source.version, passages]))
}

function passageIdentity(bodyId: string, ordinal: number, locator: string): string {
  return hash(JSON.stringify([bodyId, ordinal, locator]))
}

const bodyTables = `
  CREATE TABLE guideline_body (id TEXT PRIMARY KEY, format TEXT NOT NULL, source_sha256 TEXT NOT NULL, version TEXT NOT NULL) STRICT;
  CREATE TABLE guideline_passage (
    id TEXT PRIMARY KEY, body_id TEXT NOT NULL REFERENCES guideline_body(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0), locator TEXT NOT NULL, text TEXT NOT NULL,
    UNIQUE(body_id, ordinal)
  ) STRICT;
  CREATE INDEX guideline_passage_body ON guideline_passage(body_id);
  CREATE VIRTUAL TABLE guideline_passage_fts USING fts5(
    text, content = 'guideline_passage', content_rowid = 'rowid', tokenize = 'trigram'
  );
  CREATE TRIGGER guideline_passage_insert AFTER INSERT ON guideline_passage BEGIN
    INSERT INTO guideline_passage_fts (rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER guideline_passage_delete AFTER DELETE ON guideline_passage BEGIN
    INSERT INTO guideline_passage_fts (guideline_passage_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;
`

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
  readonly schemaUpgraded: boolean
  readonly #database: Database.Database
  readonly #allowNonCommercial: boolean
  readonly #deploymentPolicy: GuidelineDeploymentPolicy
  readonly #allowLocalEvaluation: boolean

  constructor(options: { databasePath: string; readOnly?: boolean; allowNonCommercial?: boolean; deploymentPolicy?: GuidelineDeploymentPolicy; allowLocalEvaluation?: boolean }) {
    this.#allowNonCommercial = options.allowNonCommercial === true
    this.#deploymentPolicy = options.deploymentPolicy ?? 'default'
    this.#allowLocalEvaluation = options.allowLocalEvaluation === true
    if (!options.readOnly) mkdirSync(dirname(options.databasePath), { recursive: true })
    this.#database = new Database(options.databasePath, options.readOnly
      ? { readonly: true, fileMustExist: true }
      : undefined)
    try {
      const version = this.#database.pragma('user_version', { simple: true })
      this.schemaUpgraded = version === 1 || version === 2
      if (version === 0 && !options.readOnly) {
        if (this.#database.pragma('application_id', { simple: true }) !== 0
          || this.#database.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get() !== undefined) {
          throw new Error('Unsupported guideline corpus schema')
        }
        this.#database.transaction(() => this.#database.exec(`
          ${bodyTables}
          CREATE TABLE guideline_source (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, digest TEXT NOT NULL,
            body_id TEXT REFERENCES guideline_body(id), integrity_invalid INTEGER NOT NULL DEFAULT 0 CHECK(integrity_invalid IN (0, 1))) STRICT;
          CREATE TABLE guideline_source_restriction (id TEXT PRIMARY KEY, restriction TEXT NOT NULL) STRICT;
          PRAGMA application_id = ${applicationId};
          PRAGMA user_version = 3;
        `))()
      }
      if (this.#database.pragma('application_id', { simple: true }) !== applicationId
        || ![1, 2, 3].includes(Number(this.#database.pragma('user_version', { simple: true })))) {
        throw new Error('Unsupported guideline corpus schema')
      }
      this.#database.pragma('foreign_keys = ON')
      this.#database.pragma('busy_timeout = 5000')
      if (!options.readOnly) this.#database.pragma('journal_mode = WAL')
      this.#database.function('guideline_passage_usable', { deterministic: true }, text =>
        typeof text === 'string' && isGuidelinePassageUsable({ text }) ? 1 : 0)
      if (this.schemaUpgraded) {
        if (options.readOnly) throw new Error('Guideline corpus requires preparation to upgrade its shared-body schema')
        this.#database.transaction(() => {
          if (version === 1) {
            this.#database.exec('CREATE TABLE guideline_source_restriction (id TEXT PRIMARY KEY, restriction TEXT NOT NULL) STRICT')
            const rows = z.array(z.object({ id: z.string() })).parse(this.#database.prepare('SELECT id FROM guideline_source').all())
            for (const row of rows) {
              const source = this.#storedSource(row.id)
              if (source !== undefined) this.#saveRestriction(source.id, sourceRestriction(source))
            }
          }
          this.#upgradeBodies()
        })()
      }
    } catch (error) {
      this.#database.close()
      throw error
    }
  }

  #upgradeBodies(): void {
    const rows = z.array(z.object({ id: z.string(), metadata: z.string(), digest: z.string() }))
      .parse(this.#database.prepare('SELECT id, metadata, digest FROM guideline_source ORDER BY id').all())
    const legacy = rows.map(row => {
      const source = this.#storedSource(row.id)
      const passages = z.array(z.object({ id: z.string(), locator: z.string(), text: z.string() }))
        .parse(this.#database.prepare('SELECT id, locator, text FROM guideline_passage WHERE source_id = ? ORDER BY rowid').all(row.id))
      const documentPassages = passages.map(({ locator, text }) => ({ locator, text }))
      const sourceDigest = source === undefined ? '' : hash(JSON.stringify(source))
      const valid = source !== undefined && source.id === row.id
        && passages.every(passage => passage.id === hash(JSON.stringify([row.id, source.version, source.sha256, passage.locator, sourceDigest])))
        && hash(JSON.stringify({ source, passages: documentPassages })) === row.digest
      return { ...row, source, passages: documentPassages, valid }
    })
    this.#database.exec(`
      DROP TRIGGER guideline_passage_insert;
      DROP TRIGGER guideline_passage_delete;
      DROP TABLE guideline_passage_fts;
      ALTER TABLE guideline_passage RENAME TO guideline_passage_legacy;
      ${bodyTables}
      ALTER TABLE guideline_source ADD COLUMN body_id TEXT REFERENCES guideline_body(id);
      ALTER TABLE guideline_source ADD COLUMN integrity_invalid INTEGER NOT NULL DEFAULT 0 CHECK(integrity_invalid IN (0, 1));
    `)
    for (const item of legacy) {
      let bodyId: string | null = null
      if (item.passages.length > 0) {
        const source = item.source ?? { format: 'text' as const, sha256: '', version: '' }
        bodyId = item.source === undefined ? hash(JSON.stringify(['invalid-guideline-source-v1', item.id, item.digest, item.passages]))
          : bodyIdentity(source, item.passages)
        this.#saveBody(source, item.passages, bodyId)
      }
      this.#database.prepare('UPDATE guideline_source SET body_id = ?, integrity_invalid = ? WHERE id = ?')
        .run(bodyId, item.valid ? 0 : 1, item.id)
    }
    this.#database.exec('DROP TABLE guideline_passage_legacy; PRAGMA user_version = 3')
  }

  #bodyPassages(bodyId: string) {
    return storedPassagesSchema.parse(this.#database.prepare('SELECT id, ordinal, locator, text FROM guideline_passage WHERE body_id = ? ORDER BY ordinal').all(bodyId))
  }

  #bodyIntegrity(bodyId: string): boolean {
    const body = bodySchema.safeParse(this.#database.prepare('SELECT id, format, source_sha256, version FROM guideline_body WHERE id = ?').get(bodyId))
    if (!body.success) return false
    const rows = this.#bodyPassages(bodyId)
    const passages = rows.map(({ locator, text }) => ({ locator, text }))
    return rows.length > 0 && rows.every((passage, index) => passage.ordinal === index
      && passage.id === passageIdentity(bodyId, index, passage.locator))
      && bodyIdentity({ format: body.data.format, sha256: body.data.source_sha256, version: body.data.version }, passages) === bodyId
  }

  #saveBody(source: Pick<GuidelineSourceDefinition, 'format' | 'sha256' | 'version'>,
    passages: GuidelineDocument['passages'], bodyId = bodyIdentity(source, passages)): string {
    if (this.#bodyIntegrity(bodyId)) return bodyId
    this.#database.prepare(`INSERT INTO guideline_body(id, format, source_sha256, version) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET format = excluded.format, source_sha256 = excluded.source_sha256, version = excluded.version`)
      .run(bodyId, source.format, source.sha256, source.version)
    this.#database.prepare('DELETE FROM guideline_passage WHERE body_id = ?').run(bodyId)
    const insert = this.#database.prepare('INSERT INTO guideline_passage(id, body_id, ordinal, locator, text) VALUES (?, ?, ?, ?, ?)')
    for (const [ordinal, passage] of passages.entries()) insert.run(passageIdentity(bodyId, ordinal, passage.locator), bodyId, ordinal, passage.locator, passage.text)
    return bodyId
  }

  importDocument(input: GuidelineDocument): { created: boolean; passageCount: number } {
    return this.importDocuments([input])
  }

  importReleaseDocuments(inputs: readonly GuidelineDocument[], restoreSourceIds: readonly string[] = []) {
    return this.#database.transaction(() => {
      const restoring = new Set(restoreSourceIds)
      const result = this.importDocuments(inputs.filter(input => !restoring.has(input.source.id)), { preserveRestrictions: true })
      if (restoring.size > 0) {
        const restored = this.importDocuments(inputs.filter(input => restoring.has(input.source.id)))
        result.created ||= restored.created
        result.passageCount += restored.passageCount
      }
      return { ...result, sources: this.sources() }
    })()
  }

  importDocuments(inputs: readonly GuidelineDocument[], options: { preserveRestrictions?: boolean } = {}): { created: boolean; passageCount: number } {
    const documents = documentsSchema.parse(inputs)
    return this.#database.transaction(() => {
      let created = false
      const passageCount = documents.reduce((total, document) => total + document.passages.length, 0)
      if (!this.hasValidSearchIndex()) {
        this.#database.exec("INSERT INTO guideline_passage_fts(guideline_passage_fts) VALUES('rebuild')")
        created = true
      }
      const linked = this.#withSourceLinks(documents)
      for (const source of linked.damagedLinks) {
        // Preserve a uniquely known historical parent without trusting or re-signing damaged content.
        this.#database.prepare('UPDATE guideline_source SET metadata = ?, integrity_invalid = 1 WHERE id = ?')
          .run(JSON.stringify(source), source.id)
        created = true
      }
      const publications = [
        ...linked.existing.map(input => ({ input, preserveRestrictions: true })),
        ...linked.inputs.map(input => ({ input, preserveRestrictions: options.preserveRestrictions === true })),
      ]
      for (const { input, preserveRestrictions } of publications) {
        const previousRestriction = this.#restriction(input.source.id)
        const restriction = preserveRestrictions ? this.#releaseRestriction(input.source)
          : sourceRestriction(input.source, this.#storedSource(input.source.id))
        if (!preserveRestrictions && previousRestriction.textStatus !== undefined && input.source.distribution === undefined) {
          if (input.source.status === 'active') throw new Error('Guideline text restriction requires an explicit verification status before maintenance import')
          restriction.textStatus = previousRestriction.textStatus
        }
        if (!preserveRestrictions && previousRestriction.license?.usage === input.source.license.usage && input.source.distribution === undefined) {
          // Maintenance sync first restricts use, then imports the fetched body.
          // That second write must retain the restriction even if its license is unchanged.
          restriction.license = input.source.license
          restriction.distributionDisabled = true
        }
        this.#saveRestriction(input.source.id, restriction)
        const document = preserveRestrictions ? this.#withRestriction(input, restriction) : input
        const digest = hash(JSON.stringify(document))
        const existing = this.#storedDocumentIntegrity(document.source.id)
        if (existing?.valid && existing.digest === digest) continue
        created = true
        const bodyId = document.passages.length === 0 ? null : this.#saveBody(document.source, document.passages)
        this.#database.prepare(`
          INSERT INTO guideline_source (id, metadata, digest, body_id, integrity_invalid) VALUES (?, ?, ?, ?, 0)
          ON CONFLICT(id) DO UPDATE SET metadata = excluded.metadata, digest = excluded.digest, body_id = excluded.body_id, integrity_invalid = 0
        `).run(document.source.id, JSON.stringify(document.source), digest, bodyId)
      }
      this.#database.exec('DELETE FROM guideline_body WHERE NOT EXISTS (SELECT 1 FROM guideline_source WHERE body_id = guideline_body.id)')
      return { created, passageCount }
    })()
  }

  matchesDocuments(inputs: readonly GuidelineDocument[], options: { preserveRestrictions?: boolean } = {}): boolean {
    const documents = documentsSchema.parse(inputs)
    return this.#database.transaction(() => {
      const linked = this.#withSourceLinks(documents)
      if (linked.existing.length > 0 || linked.damagedLinks.length > 0) return false
      return linked.inputs.every(input => {
        const restriction = options.preserveRestrictions ? this.#releaseRestriction(input.source) : undefined
        if (restriction !== undefined && restrictionDigest(restriction) !== restrictionDigest(this.#restriction(input.source.id))) return false
        const document = restriction === undefined ? input : this.#withRestriction(input, restriction)
        const existing = this.#storedDocumentIntegrity(document.source.id)
        return existing?.valid === true && existing.digest === hash(JSON.stringify(document))
      })
    })()
  }

  #withSourceLinks(inputs: GuidelineDocument[]): { inputs: GuidelineDocument[]; existing: GuidelineDocument[]; damagedLinks: GuidelineSourceDefinition[] } {
    const ids = z.array(z.object({ id: z.string() })).parse(this.#database.prepare('SELECT id FROM guideline_source').all())
    const stored = ids.flatMap(({ id }) => {
      const source = this.#storedSource(id)
      return source === undefined || source.id !== id ? [] : [source]
    })
    const previous = new Map(stored.map(source => [source.id, source]))
    const candidates = [...stored, ...inputs.map(input => input.source)]
    const originalId = (source: GuidelineSourceDefinition, known: readonly GuidelineSourceDefinition[]) => {
      const originals = known.filter(candidate => !candidate.id.startsWith(localEvaluationSourcePrefix)
        && (candidate.sha256 === source.sha256 || source.id === `${localEvaluationSourcePrefix}${candidate.id}`))
      const originalIds = new Set(originals.map(original => original.id))
      if (originalIds.size > 1) throw new Error('Guideline original source is ambiguous; specify derivedFromSourceId')
      return originals[0]?.id
    }
    const link = (source: GuidelineSourceDefinition): GuidelineSourceDefinition => {
      const oldSource = previous.get(source.id)
      let parentId = source.derivedFromSourceId ?? oldSource?.derivedFromSourceId
      if (parentId === undefined && source.id.startsWith(localEvaluationSourcePrefix)) {
        // Keep a unique historical parent as a restriction even while the old body awaits repair.
        if (oldSource !== undefined) parentId = originalId(oldSource, stored)
        parentId ??= originalId(source, candidates)
      }
      return parentId === undefined ? source : guidelineSourceDefinitionSchema.parse({ ...source, derivedFromSourceId: parentId })
    }
    const incomingIds = new Set(inputs.map(input => input.source.id))
    const existing: GuidelineDocument[] = []
    const damagedLinks: GuidelineSourceDefinition[] = []
    for (const source of stored) {
      if (incomingIds.has(source.id)) continue
      const linked = link(source)
      if (linked.derivedFromSourceId === source.derivedFromSourceId) continue
      if (this.#storedDocumentIntegrity(source.id)?.valid !== true) {
        damagedLinks.push(linked)
        continue
      }
      const body = z.object({ body_id: z.string().nullable() }).parse(this.#database.prepare('SELECT body_id FROM guideline_source WHERE id = ?').get(source.id))
      const passages = body.body_id === null ? [] : this.#bodyPassages(body.body_id)
      existing.push({ source: linked, passages: passages.map(({ locator, text }) => ({ locator, text })) })
    }
    const linkedInputs = inputs.map(input => ({ ...input, source: link(input.source) }))
    const sources = [...new Map([...stored, ...damagedLinks, ...existing.map(input => input.source), ...linkedInputs.map(input => input.source)]
      .map(source => [source.id, source])).values()]
    if (sources.some(source => guidelineSourceLineage(source, sources) === null)) throw new Error('Guideline source derivation cycle')
    return { inputs: linkedInputs, existing, damagedLinks }
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
    const stored = this.#database.prepare('SELECT metadata, digest, body_id, integrity_invalid FROM guideline_source WHERE id = ?').get(sourceId)
    if (stored === undefined) return undefined
    const row = storedDocumentSchema.safeParse(stored)
    if (!row.success) return { digest: '', valid: false }
    const invalid = { digest: row.data.digest, valid: false }
    if (row.data.integrity_invalid !== 0) return invalid
    let source: unknown
    try { source = JSON.parse(row.data.metadata) }
    catch { return invalid }
    const metadata = guidelineSourceDefinitionSchema.safeParse(source)
    if (!metadata.success || metadata.data.id !== sourceId) return invalid
    if (row.data.body_id !== null && !this.#bodyIntegrity(row.data.body_id)) return invalid
    const passages = row.data.body_id === null ? [] : this.#bodyPassages(row.data.body_id).map(({ locator, text }) => ({ locator, text }))
    if (row.data.body_id !== null && bodyIdentity(metadata.data, passages) !== row.data.body_id) return invalid
    return { digest: row.data.digest, valid: hash(JSON.stringify({ source: metadata.data,
      passages })) === row.data.digest }
  }

  search(text: string): GuidelineSearchResult {
    return this.#database.transaction(() => {
      const rows = this.#sourceRows()
      const validSourceIds = new Set(rows.filter(row => this.#storedDocumentIntegrity(row.id)?.valid).map(row => row.id))
      const metadata = new Map(rows.flatMap(row => {
        const source = this.#storedSource(row.id)
        return source === undefined || source.id !== row.id ? [] : [[row.id, source] as const]
      }))
      const sources = [...metadata.values()].filter(source => validSourceIds.has(source.id))
        .toSorted((left, right) => Number(left.id.startsWith(localEvaluationSourcePrefix)) - Number(right.id.startsWith(localEvaluationSourcePrefix))
        || Number(left.derivedFromSourceId !== undefined) - Number(right.derivedFromSourceId !== undefined) || left.id.localeCompare(right.id))
      const sourceBodies = new Map(rows.map(row => [row.id, row.bodyId]))
      const revision = hash(JSON.stringify([searchRevision, guidelinePassagePolicyRevision, this.#allowNonCommercial, this.#deploymentPolicy, this.#allowLocalEvaluation,
        rows.map(row => [row.digest, row.bodyId, validSourceIds.has(row.id)])]))
      const guidelines: GuidelineEvidence[] = []
      const diagnosisQueries = new Set<string>()
      const inactiveSources: GuidelineSearchResult['inactiveSources'] = rows.flatMap(row => {
        const source = metadata.get(row.id)
        const lineage = source === undefined ? null : guidelineSourceLineage(source, sources)
        if (validSourceIds.has(row.id) && lineage !== null && lineage.complete
          && lineage.sources.every(item => item.status === 'active'
            && (item.distribution === undefined || item.distribution.textStatus === 'verified'))) return []
        // A damaged row still blocks its own fixed quotation. Derived restrictions do not block an original by shared URL/hash.
        return [{ id: row.id, ...(source !== undefined && source.derivedFromSourceId === undefined
          && !source.id.startsWith(localEvaluationSourcePrefix) ? { url: source.url, sourceHash: source.sha256 } : {}) }]
      })
      const inactiveSourceIds = new Set(inactiveSources.map(source => source.id))
      const candidates = new Map<string, { evidence: GuidelineEvidence; bodyId: string; queries: string[]; rank: number; topicMatches: number }>()
      const queryText = text.toLowerCase()
      const tokens = text.match(/\p{Script=Han}+|[a-zA-Z0-9]+/gu) ?? []
      const terms = [...new Set(tokens.flatMap(token => /^\p{Script=Han}{4,}$/u.test(token)
        ? [token, ...Array.from({ length: token.length - 2 }, (_, index) => token.slice(index, index + 3))]
        : [token]))]
        .filter(term => [...term].length >= 2).slice(0, 96)
      for (const source of sources) {
        if (inactiveSourceIds.has(source.id)) continue
        if (!isGuidelineSourceUsable(source, this.#allowNonCommercial, { deploymentPolicy: this.#deploymentPolicy,
          allowLocalEvaluation: this.#allowLocalEvaluation, knownSources: sources })) continue
        const bodyId = sourceBodies.get(source.id)
        if (bodyId === null || bodyId === undefined) continue
        const topics = source.topics.filter(topic => topic.terms.some(term => queryText.includes(term.toLowerCase())))
        const sourceTerms = [...new Set([...topics.flatMap(topic => topic.terms), ...terms])].slice(0, 128)
        const indexedTerms = sourceTerms.filter(term => [...term].length >= 3)
        const shortTerms = sourceTerms.filter(term => [...term].length === 2)
        const sourcePhrase = indexedTerms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')
        const passages = indexedTerms.length === 0 ? [] : z.array(passageRowSchema).parse(this.#database.prepare(`
          SELECT p.id, p.locator, p.text, bm25(guideline_passage_fts) AS rank FROM guideline_passage p
          JOIN guideline_passage_fts ON guideline_passage_fts.rowid = p.rowid
          WHERE p.body_id = ? AND guideline_passage_fts MATCH ? AND guideline_passage_usable(p.text)
          ORDER BY bm25(guideline_passage_fts), p.id LIMIT 64
        `).all(bodyId, sourcePhrase))
        if (shortTerms.length > 0) passages.push(...z.array(passageRowSchema).parse(this.#database.prepare(`
          SELECT id, locator, text, 0 AS rank FROM guideline_passage WHERE body_id = ?
          AND guideline_passage_usable(text)
          AND (${shortTerms.map(() => 'instr(lower(text), lower(?)) > 0').join(' OR ')}) ORDER BY id LIMIT 64
        `).all(bodyId, ...shortTerms)))
        const seen = new Set<string>()
        for (const passage of passages) {
          if (seen.has(passage.id)) continue
          seen.add(passage.id)
          const evidence = guidelineEvidenceSchema.parse({
            id: hash(JSON.stringify([passage.id, hash(JSON.stringify(source))])), title: source.title, publisher: source.publisher, documentType: source.documentType,
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
          const previous = candidates.get(passage.id)
          candidates.set(passage.id, previous === undefined ? { evidence, bodyId, queries: [...queries], rank: passage.rank, topicMatches }
            : { ...previous, queries: [...new Set([...previous.queries, ...queries])], rank: Math.min(previous.rank, passage.rank),
              topicMatches: Math.max(previous.topicMatches, topicMatches) })
        }
      }
      // 相同主题相关性先覆盖不同正文，再取同文后续段落，上传别名不额外占用预算。
      const bodyRounds = new Map<string, number>()
      const rankedCandidates = [...candidates.values()].toSorted((left, right) => right.topicMatches - left.topicMatches
        || left.rank - right.rank || left.evidence.id.localeCompare(right.evidence.id)).map(candidate => {
        const key = JSON.stringify([candidate.topicMatches, candidate.bodyId])
        const bodyRound = bodyRounds.get(key) ?? 0
        bodyRounds.set(key, bodyRound + 1)
        return { ...candidate, bodyRound }
      })
      for (const candidate of rankedCandidates.toSorted((left, right) => right.topicMatches - left.topicMatches
        || left.bodyRound - right.bodyRound || left.rank - right.rank || left.evidence.id.localeCompare(right.evidence.id))) {
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
      ...(row.bodyId === null ? {} : { bodyId: row.bodyId }),
      ...(this.#storedDocumentIntegrity(row.id)?.valid === true ? {} : { integrityValid: false as const }),
      ...(row.unusablePassageCount > 0 ? { unusablePassageCount: row.unusablePassageCount } : {}),
    }))
  }

  #sourceRows() {
    return z.array(sourceRowSchema).parse(this.#database.prepare(`
      SELECT id, metadata, digest, body_id AS bodyId,
        (SELECT count(*) FROM guideline_passage p WHERE p.body_id = s.body_id) AS passageCount,
        (SELECT count(*) FROM guideline_passage p WHERE p.body_id = s.body_id AND NOT guideline_passage_usable(p.text)) AS unusablePassageCount
      FROM guideline_source s ORDER BY id
    `).all())
  }

  close(): void { this.#database.close() }
}
