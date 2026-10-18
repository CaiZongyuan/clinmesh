import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, resolve, sep } from 'node:path'
import { z } from 'zod'
import { preparedDatasetSchema, preparedRecordSchema, preparedSummarySchema, type PreparedRecord } from '@clinmesh/contracts/drg'
import type { ReferenceDatabase } from '../sqlite/reference-database.ts'

export const preparedLockSchema = z.object({
  releaseId: z.string().min(1), manifestPath: z.string().min(1),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export const preparedManifestSchema = z.object({
  schemaVersion: z.literal('clinmesh.prepared-catalogues.v1'),
  releaseId: z.string().min(1), createdAt: z.iso.datetime(),
  archiveChecksumsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sources: z.record(z.string(), z.json()),
  files: z.array(z.object({
    path: z.string().min(1), dataset: preparedDatasetSchema, table: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), rows: z.number().int().nonnegative(),
    sourceVersion: z.string(),
  }).strict()).min(5),
}).strict()
export type PreparedLock = z.infer<typeof preparedLockSchema>

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function importPreparedCatalogues(database: ReferenceDatabase, manifestPath: string, lock: PreparedLock) {
  if (await fileSha256(manifestPath) !== lock.manifestSha256) throw new Error('清洗发布清单哈希与 lock 不一致')
  const manifestText = readFileSync(manifestPath, 'utf8')
  const manifest = preparedManifestSchema.parse(JSON.parse(manifestText))
  if (manifest.releaseId !== lock.releaseId) throw new Error('清洗发布版本与 lock 不一致')
  const root = dirname(resolve(manifestPath))
  const paths = new Set<string>()
  for (const file of manifest.files) {
    const path = resolve(root, file.path)
    if (!path.startsWith(root + sep) || paths.has(path)) throw new Error('清洗文件路径越界或重复')
    paths.add(path)
    if (await fileSha256(path) !== file.sha256) throw new Error(`清洗文件哈希不一致：${file.path}`)
  }
  const existing = z.object({ manifest_sha256: z.string() }).optional().parse(database.driver.prepare(
    'SELECT manifest_sha256 FROM prepared_reference_release WHERE release_id = ?',
  ).get(lock.releaseId))
  if (existing !== undefined) {
    if (existing.manifest_sha256 !== lock.manifestSha256) throw new Error('已发布的清洗版本不可覆盖')
    verifyPreparedCounts(database, lock.releaseId, manifest)
    return { created: false, ...preparedSummary(database, lock.releaseId) }
  }
  database.driver.exec('BEGIN IMMEDIATE')
  try {
    database.driver.prepare('INSERT INTO prepared_reference_release VALUES (?, ?, ?, ?)')
      .run(lock.releaseId, lock.manifestSha256, manifestText, manifest.createdAt)
    const insert = database.driver.prepare('INSERT INTO prepared_reference_record VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const file of manifest.files) {
      let count = 0
      const lines = createInterface({ input: createReadStream(resolve(root, file.path)), crlfDelay: Infinity })
      for await (const line of lines) {
        if (line.trim() === '') continue
        count++
        const payload = z.record(z.string(), z.json()).parse(JSON.parse(line))
        const id = typeof payload.id === 'string' && payload.id !== '' ? payload.id : `row-${count}`
        const code = typeof payload.code === 'string' ? payload.code : null
        const name = typeof payload.name === 'string' ? payload.name : ''
        if (file.table === 'records' && ['icd10', 'icd9', 'services', 'drugs'].includes(file.dataset)) {
          if (typeof payload.id !== 'string' || (payload.kind !== 'hierarchy_only' && typeof payload.name !== 'string')) throw new Error(`主目录缺少 id/name：${file.path}:${count}`)
          if (['icd10', 'icd9'].includes(file.dataset) && payload.kind === 'leaf' && (code === null || code === '')) {
            throw new Error(`末级编码缺失：${file.path}:${count}`)
          }
        }
        insert.run(lock.releaseId, file.dataset, file.table, id, code, name, file.sourceVersion, JSON.stringify(payload))
      }
      if (count !== file.rows) throw new Error(`清洗行数不一致：${file.path}，${count}/${file.rows}`)
    }
    database.driver.exec('COMMIT')
  } catch (error) {
    if (database.driver.inTransaction) database.driver.exec('ROLLBACK')
    throw error
  }
  return { created: true, ...preparedSummary(database, lock.releaseId) }
}

function verifyPreparedCounts(database: ReferenceDatabase, releaseId: string, manifest: z.infer<typeof preparedManifestSchema>) {
  for (const file of manifest.files) {
    const row = z.object({ count: z.number() }).parse(database.driver.prepare(
      'SELECT COUNT(*) AS count FROM prepared_reference_record WHERE release_id = ? AND dataset = ? AND table_name = ?',
    ).get(releaseId, file.dataset, file.table))
    if (row.count !== file.rows) throw new Error(`清洗参考库行数不一致：${file.dataset}/${file.table}`)
  }
  const total = z.object({ count: z.number() }).parse(database.driver.prepare(
    'SELECT COUNT(*) AS count FROM prepared_reference_record WHERE release_id = ?',
  ).get(releaseId))
  if (total.count !== manifest.files.reduce((sum, file) => sum + file.rows, 0)) throw new Error('清洗参考库总行数与清单不一致')
}

export function verifyPreparedDatabase(database: ReferenceDatabase) {
  const releases = z.array(z.object({ release_id: z.string(), manifest_sha256: z.string(), manifest_json: z.string() })).parse(
    database.driver.prepare('SELECT release_id, manifest_sha256, manifest_json FROM prepared_reference_release').all(),
  )
  for (const release of releases) {
    if (createHash('sha256').update(release.manifest_json).digest('hex') !== release.manifest_sha256) throw new Error('清洗参考库发布清单哈希不一致')
    const manifest = preparedManifestSchema.parse(JSON.parse(release.manifest_json))
    if (manifest.releaseId !== release.release_id) throw new Error('清洗参考库发布身份不一致')
    verifyPreparedCounts(database, release.release_id, manifest)
  }
}

export function preparedSummary(database: ReferenceDatabase, releaseId: string) {
  const release = z.object({ manifest_sha256: z.string(), manifest_json: z.string() }).optional().parse(database.driver.prepare(
    'SELECT manifest_sha256, manifest_json FROM prepared_reference_release WHERE release_id = ?',
  ).get(releaseId))
  if (release === undefined) return null
  const manifest = preparedManifestSchema.parse(JSON.parse(release.manifest_json))
  verifyPreparedCounts(database, releaseId, manifest)
  return preparedSummarySchema.parse({ releaseId, manifestSha256: release.manifest_sha256,
    tables: manifest.files.map(file => ({ dataset: file.dataset, table: file.table, count: file.rows })) })
}

const rowSchema = z.object({
  dataset: preparedDatasetSchema, table_name: z.string(), record_id: z.string(), code: z.string().nullable(),
  name: z.string(), source_version: z.string(), payload_json: z.string(),
})
function fromRow(row: unknown): PreparedRecord {
  const value = rowSchema.parse(row)
  return preparedRecordSchema.parse({ dataset: value.dataset, table: value.table_name, id: value.record_id,
    code: value.code, name: value.name, sourceVersion: value.source_version, payload: JSON.parse(value.payload_json) })
}
export function readPreparedRecord(database: ReferenceDatabase, releaseId: string, dataset: string, id: string) {
  const row = database.driver.prepare('SELECT * FROM prepared_reference_record WHERE release_id = ? AND dataset = ? AND table_name = ? AND record_id = ?')
    .get(releaseId, dataset, 'records', id)
  return row === undefined ? undefined : fromRow(row)
}
export function searchPreparedRecords(database: ReferenceDatabase, releaseId: string, input: {
  dataset: string, table: string, query: string, page: number,
}) {
  // instr 按字面搜索，避免通配符改变查询范围。
  const values = [releaseId, input.dataset, input.table, input.query, input.query, input.query]
  const where = 'release_id = ? AND dataset = ? AND table_name = ? AND (? = \'\' OR instr(code, ?) > 0 OR instr(name, ?) > 0)'
  const total = z.object({ count: z.number() }).parse(database.driver.prepare(`SELECT COUNT(*) AS count FROM prepared_reference_record WHERE ${where}`).get(...values)).count
  const items = database.driver.prepare(`SELECT * FROM prepared_reference_record WHERE ${where} ORDER BY record_id LIMIT 30 OFFSET ?`)
    .all(...values, (input.page - 1) * 30).map(fromRow)
  return { releaseId, total, items }
}
