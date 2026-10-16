import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { guidelineEvidenceSchema, type GuidelineEvidence } from '@clinmesh/contracts/doctor-recommendations'
import Database from 'better-sqlite3'
import { z } from 'zod'
import type {
  GuidelineDocument,
  GuidelineSearchResult,
  GuidelineSourceStatus,
} from '../../application/guideline-corpus.ts'

const identity = z.string().trim().min(1).max(256)
export const guidelineSourceDefinitionSchema = guidelineEvidenceSchema.omit({
  locator: true, text: true, sourceHash: true,
}).extend({
  downloadUrl: z.url(),
  format: z.enum(['pdf', 'text']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['active', 'withdrawn', 'superseded']),
  license: z.object({
    id: identity,
    url: z.url(),
    usage: z.enum(['open', 'non-commercial', 'unverified']),
  }).strict(),
  topics: z.array(z.object({
    terms: z.array(identity).min(1),
    diagnosisQueries: z.array(identity.regex(/\p{Script=Han}/u)),
  }).strict()),
}).strict().transform(({ publishedAt, effectiveAt, ...source }) => ({
  ...source,
  ...(publishedAt === undefined ? {} : { publishedAt }),
  ...(effectiveAt === undefined ? {} : { effectiveAt }),
}))

const passageSchema = z.object({
  locator: guidelineEvidenceSchema.shape.locator,
  text: z.string().min(1).max(12_000).refine(text => text.trim().length > 0),
}).strict()
const documentSchema = z.object({
  source: guidelineSourceDefinitionSchema,
  passages: z.array(passageSchema),
}).strict().refine(document => document.passages.length > 0
  || document.source.status !== 'active' || document.source.license.usage === 'unverified',
  'Searchable guidelines require readable passages')
  .refine(document => new Set(document.passages.map(passage => passage.locator)).size === document.passages.length,
  'Guideline passage locators must be unique')
const sourceRowSchema = z.object({ metadata: z.string(), digest: z.string(), passageCount: z.number().int().nonnegative() })
const passageRowSchema = z.object({ id: z.string(), locator: z.string(), text: z.string(), rank: z.number() })
const applicationId = 0x434d4743

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export class GuidelineCorpus {
  readonly #database: Database.Database

  constructor(options: { databasePath: string; readOnly?: boolean }) {
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
        || this.#database.pragma('user_version', { simple: true }) !== 1) {
        throw new Error('Unsupported guideline corpus schema')
      }
      this.#database.pragma('foreign_keys = ON')
      this.#database.pragma('busy_timeout = 5000')
      if (!options.readOnly) this.#database.pragma('journal_mode = WAL')
    } catch (error) {
      this.#database.close()
      throw error
    }
  }

  importDocument(input: GuidelineDocument): { created: boolean; passageCount: number } {
    const document = documentSchema.parse(input)
    const digest = hash(JSON.stringify(document))
    return this.#database.transaction(() => {
      const existing = this.#database.prepare('SELECT digest FROM guideline_source WHERE id = ?').get(document.source.id)
      if (existing !== undefined && z.object({ digest: z.string() }).parse(existing).digest === digest) {
        return { created: false, passageCount: document.passages.length }
      }
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
      return { created: true, passageCount: document.passages.length }
    })()
  }

  search(text: string): GuidelineSearchResult {
    return this.#database.transaction(() => {
      const rows = this.#sourceRows()
      const revision = hash(JSON.stringify(rows.map(row => row.digest)))
      const guidelines: GuidelineEvidence[] = []
      const diagnosisQueries = new Set<string>()
      const candidates: Array<{ evidence: GuidelineEvidence; queries: string[]; rank: number; topicMatches: number }> = []
      const queryText = text.toLowerCase()
      const tokens = text.match(/\p{Script=Han}+|[a-zA-Z0-9]+/gu) ?? []
      const terms = [...new Set(tokens.flatMap(token => /^\p{Script=Han}{4,}$/u.test(token)
        ? [token, ...Array.from({ length: token.length - 2 }, (_, index) => token.slice(index, index + 3))]
        : [token]))]
        .filter(term => [...term].length >= 2).slice(0, 96)
      for (const row of rows) {
        const source = guidelineSourceDefinitionSchema.parse(JSON.parse(row.metadata))
        if (source.status !== 'active' || source.license.usage === 'unverified') continue
        const topics = source.topics.filter(topic => topic.terms.some(term => queryText.includes(term.toLowerCase())))
        const sourceTerms = [...new Set([...topics.flatMap(topic => topic.terms), ...terms])].slice(0, 128)
        const indexedTerms = sourceTerms.filter(term => [...term].length >= 3)
        const shortTerms = sourceTerms.filter(term => [...term].length === 2)
        const sourcePhrase = indexedTerms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')
        const passages = indexedTerms.length === 0 ? [] : z.array(passageRowSchema).parse(this.#database.prepare(`
          SELECT p.id, p.locator, p.text, bm25(guideline_passage_fts) AS rank FROM guideline_passage p
          JOIN guideline_passage_fts ON guideline_passage_fts.rowid = p.rowid
          WHERE p.source_id = ? AND guideline_passage_fts MATCH ?
          ORDER BY bm25(guideline_passage_fts), p.id LIMIT 64
        `).all(source.id, sourcePhrase))
        if (shortTerms.length > 0) passages.push(...z.array(passageRowSchema).parse(this.#database.prepare(`
          SELECT id, locator, text, 0 AS rank FROM guideline_passage WHERE source_id = ?
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
          candidates.push({ evidence, queries: [...queries], rank: passage.rank, topicMatches })
        }
      }
      for (const candidate of candidates.toSorted((left, right) => right.topicMatches - left.topicMatches
        || left.rank - right.rank || left.evidence.id.localeCompare(right.evidence.id))) {
        if (guidelines.length === 8) break
        const queries = new Set([...diagnosisQueries, ...candidate.queries])
        if (Buffer.byteLength(JSON.stringify({ guidelines: [...guidelines, candidate.evidence], diagnosisQueries: [...queries], revision })) > 48 * 1024) continue
        guidelines.push(candidate.evidence)
        for (const query of queries) diagnosisQueries.add(query)
      }
      return { guidelines, diagnosisQueries: [...diagnosisQueries], revision }
    })()
  }

  sources(): GuidelineSourceStatus[] {
    return this.#sourceRows().map(row => ({
      source: guidelineSourceDefinitionSchema.parse(JSON.parse(row.metadata)), passageCount: row.passageCount,
    }))
  }

  #sourceRows() {
    return z.array(sourceRowSchema).parse(this.#database.prepare(`
      SELECT metadata, digest, (SELECT count(*) FROM guideline_passage p WHERE p.source_id = s.id) AS passageCount
      FROM guideline_source s ORDER BY id
    `).all())
  }

  close(): void { this.#database.close() }
}
