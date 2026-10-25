import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { userInfo } from 'node:os'
import { Readable } from 'node:stream'
import {
  offlineReferenceInventoryListSchema, offlineReferenceInventorySchema, offlineReferenceLockSchema,
  type OfflineReferenceInventory, type OfflineReferenceInventoryQuery, type OfflineReferenceLock,
} from '@clinmesh/contracts/reference-data'
import { z } from 'zod'
import type { ReferenceDatabase } from '../sqlite/reference-database.ts'
import { listPinnedArtifacts, openCompactStorage, type CompactStorage } from './drg-compact-storage.ts'

type CompactRead = (path: string) => Promise<Buffer>

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const jsonRecordSchema = z.record(z.string(), z.json())
const fileSchema = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).loose()
const preparedManifestSchema = z.object({
  schemaVersion: z.literal('clinmesh.prepared-catalogues.v1'), releaseId: z.string(),
  files: z.array(fileSchema.extend({
    rows: z.number().int().nonnegative(), sourceVersion: z.string().min(1),
  })).min(1),
  sources: z.record(z.string(), z.object({
    version: z.string().min(1), archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
    pdfSha256: z.string().regex(/^[a-f0-9]{64}$/), sourcePublicationVerified: z.boolean(),
  }).loose()),
}).loose()

async function checkedBytes(file: z.infer<typeof fileSchema>, read: CompactRead): Promise<Buffer> {
  const bytes = await read(file.path)
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Offline artifact checksum mismatch: ${file.path}`)
  return bytes
}

async function checkedJson(file: z.infer<typeof fileSchema>, read: CompactRead): Promise<unknown> {
  return JSON.parse((await checkedBytes(file, read)).toString('utf8'))
}

function sourceUnits(value: unknown, units: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) sourceUnits(entry, units)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (/^(unit|sourceUnit|pricingUnit|billingUnit|计价单位|单位)$/.test(key) && typeof entry === 'string' && entry.trim() !== '') {
        units.add(entry)
      } else if (entry !== null && typeof entry === 'object') sourceUnits(entry, units)
    }
  }
}

async function preparedTables(manifest: z.infer<typeof preparedManifestSchema>, read: CompactRead) {
  const tables: OfflineReferenceInventory['packages'][number]['tables'] = []
  const seen = new Set<string>()
  for (const file of manifest.files) {
    if (seen.has(file.path)) throw new Error('Duplicate offline artifact path')
    seen.add(file.path)
    let rows = 0
    const units = new Set<string>()
    const stream = Readable.from([await checkedBytes(file, read)])
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (line.trim() === '') continue
      sourceUnits(jsonRecordSchema.parse(JSON.parse(line)), units)
      rows += 1
    }
    if (rows !== file.rows) throw new Error(`Offline artifact row count mismatch: ${file.path}`)
    tables.push({ path: file.path, sha256: file.sha256, rows, sourceVersion: file.sourceVersion,
      units: [...units].sort(), unitStatus: 'source-only-unverified', scope: 'source-review', missingParameterCodes: [] })
  }
  return tables
}

async function openDrgTables(files: z.infer<typeof fileSchema>[], version: string, read: CompactRead) {
  const index = files.find(file => file.path === 'catalog/datasets.json')
  if (index === undefined) throw new Error('OpenDRG dataset catalogue is missing from checksums')
  const datasets = z.array(z.object({
    jsonPath: z.string().min(1), hasHeader: z.boolean(), recordCount: z.number().int().nonnegative(),
    sourceUrl: z.string().url(),
  }).loose()).parse(await checkedJson(index, read))
  const tables: OfflineReferenceInventory['packages'][number]['tables'] = []
  const seen = new Set<string>()
  for (const dataset of datasets) {
    const file = files.find(file => file.path === dataset.jsonPath)
    if (file === undefined || seen.has(file.path)) throw new Error('OpenDRG dataset is unpinned or duplicated')
    seen.add(file.path)
    const value = await checkedJson(file, read)
    const entries = Array.isArray(value)
      ? value.slice(dataset.hasHeader ? 1 : 0).filter(row => Array.isArray(row)
        ? row.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== '') : row !== null)
      : Object.entries(jsonRecordSchema.parse(value))
    if (entries.length !== dataset.recordCount) throw new Error(`OpenDRG dataset row count mismatch: ${file.path}`)
    const selectedPayment = file.path === 'payments/chs_drg_30.json'
    const missingParameterCodes = selectedPayment
      ? z.array(z.array(z.union([z.string(), z.number(), z.null()]))).parse(entries)
        .filter(row => row[2] === '' || row[2] === null || row[2] === undefined || row[3] === '' || row[3] === null || row[3] === undefined)
        .map(row => z.string().min(1).parse(row[0]))
      : []
    tables.push({ path: file.path, sha256: file.sha256, rows: entries.length, sourceVersion: version,
      sourceUrl: dataset.sourceUrl, units: [], unitStatus: 'source-only-unverified', missingParameterCodes,
      scope: file.path.startsWith('payments/') ? selectedPayment ? 'selected-scheme' : 'excluded-other-scheme' : 'source-review' })
  }
  return tables
}

async function selectedGrouper(files: z.infer<typeof fileSchema>[], manifest: unknown, read: CompactRead) {
  const schemeFile = files.find(file => file.path === 'catalog/schemes.json')
  if (schemeFile === undefined) throw new Error('OpenDRG scheme catalogue is missing from checksums')
  const schemes = z.array(z.object({ id: z.string(), grouperSourceUrl: z.string().url().nullish(), groupDataPath: z.string().nullish() }).loose())
    .parse(await checkedJson(schemeFile, read))
  const scheme = schemes.find(item => item.id === 'chs_drg_30')
  const assets = z.object({ assets: z.array(z.object({ url: z.string().url(), localPath: z.string() }).loose()) }).loose().parse(manifest).assets
  const programPath = assets.find(asset => asset.url === scheme?.grouperSourceUrl)?.localPath
  const program = files.find(file => file.path === programPath)
  const parameters = files.find(file => file.path === scheme?.groupDataPath)
  if (program === undefined || parameters === undefined) throw new Error('Selected OpenDRG grouper files are missing from checksums')
  const values = z.object({ CC: z.record(z.string(), z.json()), MCC: z.record(z.string(), z.json()),
    CCE: z.record(z.string(), z.json()), SS_VALID: z.array(z.string()) }).strict()
    .parse(await checkedJson(parameters, read))
  return { schemeId: 'chs_drg_30' as const, program: { path: program.path, sha256: program.sha256 },
    parameters: { path: parameters.path, sha256: parameters.sha256, counts: {
      CC: Object.keys(values.CC).length, MCC: Object.keys(values.MCC).length,
      CCE: Object.keys(values.CCE).length, SS_VALID: values.SS_VALID.length,
    } } }
}

async function inspectPackage(input: OfflineReferenceLock['packages'][number], storage: CompactStorage) {
  const read = (path: string) => storage.read(`${input.root}/${path}`)
  const manifest = await checkedJson(input.manifest, read)
  let tables: OfflineReferenceInventory['packages'][number]['tables']
  let verifiedFileCount: number
  let grouper: OfflineReferenceInventory['packages'][number]['selectedGrouper'] = null
  let sourceArtifacts: OfflineReferenceInventory['packages'][number]['sourceArtifacts'] = []
  if (input.format === 'prepared-catalogues-v1') {
    const prepared = preparedManifestSchema.parse(manifest)
    if (prepared.releaseId !== input.version) throw new Error('Offline package version mismatch')
    tables = await preparedTables(prepared, read)
    verifiedFileCount = tables.length
    sourceArtifacts = Object.entries(prepared.sources).map(([id, source]) => ({ id,
      version: source.version, archiveSha256: source.archiveSha256, pdfSha256: source.pdfSha256,
      sourcePublicationVerified: source.sourcePublicationVerified }))
  } else {
    const upstream = z.object({ completed: z.iso.datetime({ offset: true }), baseUrl: z.string().url() }).loose().parse(manifest)
    if (upstream.completed.slice(0, 10) !== input.version || upstream.baseUrl !== input.sourceUrl) {
      throw new Error('Offline package version or source mismatch')
    }
    if (input.checksums === undefined) throw new Error('OpenDRG requires checksums')
    const checksums = z.object({ algorithm: z.literal('SHA-256'), files: z.array(fileSchema).min(1) }).loose()
      .parse(await checkedJson(input.checksums, read))
    const seen = new Set<string>()
    for (const file of checksums.files) {
      if (seen.has(file.path)) throw new Error('Duplicate offline artifact path')
      seen.add(file.path)
      await checkedBytes(file, read)
    }
    // Preserve coverage as source facts; never load or execute the bundled JavaScript.
    tables = await openDrgTables(checksums.files, input.version, read)
    grouper = await selectedGrouper(checksums.files, manifest, read)
    verifiedFileCount = checksums.files.length
  }
  const { root: _root, ...provenance } = input
  return { ...provenance, approvedUse: 'offline-review' as const, runtimeEnabled: false as const,
    verifiedFileCount, selectedGrouper: grouper, sourceArtifacts, tables }
}

export function auditOfflineInventory(database: ReferenceDatabase, input: {
  operation: 'prepare' | 'list' | 'verify'; outcome: 'success' | 'failure'; inventoryId?: string; contentHash?: string
}): void {
  database.driver.prepare(`INSERT INTO reference_offline_inventory_audit
    (recorded_at, actor_id, operation, outcome, inventory_id, content_hash) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(new Date().toISOString(), `local:${userInfo().username}`, input.operation, input.outcome, input.inventoryId ?? null, input.contentHash ?? null)
}

async function inspectLock(lock: OfflineReferenceLock, inputRoot: string): Promise<OfflineReferenceInventory> {
  const storage = await openCompactStorage(lock, inputRoot)
  const pinned = await listPinnedArtifacts(lock, path => storage.read(path))
  if (pinned.size !== Object.keys(storage.index.files).length
    || [...pinned].some(([path, sha256]) => storage.index.files[path]?.sha256 !== sha256)) throw new Error('Compact index does not cover the complete pinned inventory')
  await storage.verifyObjects()
  const packages = []
  for (const input of lock.packages) packages.push(await inspectPackage(input, storage))
  const basis = offlineReferenceInventorySchema.omit({ contentHash: true }).parse({
    schemaVersion: lock.schemaVersion, inventoryId: lock.inventoryId, createdAt: lock.createdAt,
    scheme: lock.scheme, validationScope: 'integrity-only', runtimeEnabled: false, packages,
    storage: lock.storage,
  })
  return { ...basis, contentHash: digest(JSON.stringify(basis)) }
}

export async function inspectOfflineInventory(manifestPath: string, inputRoot: string): Promise<OfflineReferenceInventory> {
  const lock = offlineReferenceLockSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
  return inspectLock(lock, inputRoot)
}

export async function prepareOfflineInventory(database: ReferenceDatabase, manifestPath: string, inputRoot: string) {
  let lock: OfflineReferenceLock | undefined
  let inventory: OfflineReferenceInventory
  try {
    lock = offlineReferenceLockSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
    inventory = await inspectLock(lock, inputRoot)
  } catch (error) {
    auditOfflineInventory(database, { operation: 'prepare', outcome: 'failure',
      ...(lock === undefined ? {} : { inventoryId: lock.inventoryId }) })
    throw error
  }
  return publishOfflineInventory(database, inventory)
}

/** Register the inventory already verified from files during this preparation. */
export function publishOfflineInventory(database: ReferenceDatabase, inventory: OfflineReferenceInventory) {
  try {
    return database.driver.transaction(() => {
      const existingRow = database.driver.prepare('SELECT * FROM reference_offline_inventory WHERE inventory_id = ?').get(inventory.inventoryId)
      const existing = existingRow === undefined ? undefined : readInventory(existingRow)
      if (existing !== undefined && existing.contentHash !== inventory.contentHash) throw new Error('Offline inventory is immutable')
      if (existing === undefined) database.driver.prepare('INSERT INTO reference_offline_inventory VALUES (?, ?, ?)')
        .run(inventory.inventoryId, inventory.contentHash, JSON.stringify(inventory))
      auditOfflineInventory(database, { operation: 'prepare', outcome: 'success',
        inventoryId: inventory.inventoryId, contentHash: inventory.contentHash })
      return { created: existing === undefined, inventory }
    }).immediate()
  } catch (error) {
    auditOfflineInventory(database, { operation: 'prepare', outcome: 'failure',
      inventoryId: inventory.inventoryId })
    throw error
  }
}

function readInventory(value: unknown): OfflineReferenceInventory {
  const row = z.object({ inventory_id: z.string(), content_hash: z.string(), inventory_json: z.string() }).parse(value)
  const inventory = offlineReferenceInventorySchema.parse(JSON.parse(row.inventory_json))
  const { contentHash, ...basis } = inventory
  if (row.inventory_id !== inventory.inventoryId || row.content_hash !== contentHash || digest(JSON.stringify(basis)) !== contentHash) {
    throw new Error('Offline inventory content hash mismatch')
  }
  return inventory
}

export function listOfflineInventories(database: ReferenceDatabase, input: OfflineReferenceInventoryQuery) {
  const { total } = z.object({ total: z.number().int().nonnegative() })
    .parse(database.driver.prepare('SELECT COUNT(*) AS total FROM reference_offline_inventory').get())
  const rows = database.driver.prepare('SELECT * FROM reference_offline_inventory ORDER BY inventory_id LIMIT ? OFFSET ?')
    .all(input.pageSize, (input.page - 1) * input.pageSize)
  return offlineReferenceInventoryListSchema.parse({ items: rows.map(readInventory), ...input, total })
}

export function verifyOfflineInventories(database: ReferenceDatabase): void {
  let page = 1
  while (true) {
    const result = listOfflineInventories(database, { page, pageSize: 50 })
    if (page * result.pageSize >= result.total) return
    page += 1
  }
}

export function listOfflineInventoryAudit(database: ReferenceDatabase) {
  const rows = z.array(z.object({
    sequence: z.number().int(), recorded_at: z.iso.datetime({ offset: true }), actor_id: z.string(),
    operation: z.enum(['prepare', 'list', 'verify']), outcome: z.enum(['success', 'failure']),
    inventory_id: z.string().nullable(), content_hash: z.string().nullable(),
  })).parse(database.driver.prepare('SELECT * FROM reference_offline_inventory_audit ORDER BY sequence DESC LIMIT 100').all())
  return { items: rows.map(row => ({ sequence: row.sequence, recordedAt: row.recorded_at,
    actorId: row.actor_id, operation: row.operation, outcome: row.outcome,
    inventoryId: row.inventory_id, contentHash: row.content_hash })) }
}
