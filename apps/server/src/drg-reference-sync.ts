import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'
import { extract } from 'tar'
import { z } from 'zod'
import { offlineReferenceLockSchema } from '@clinmesh/contracts/reference-data'
import { readServerEnvironment } from './config.ts'
import { inspectOfflineInventory, listOfflineInventories, prepareOfflineInventory } from './infrastructure/reference-data/offline-reference-inventory.ts'
import { applyReferenceMigrations, openReferenceDatabase } from './infrastructure/sqlite/reference-database.ts'

const defaultRepositoryRoot = resolve(import.meta.dirname, '../../..')
const defaultLockPath = resolve(import.meta.dirname, '../reference-data/drg-offline.lock.json')
const defaultDistributionPath = resolve(import.meta.dirname, '../reference-data/drg-distribution.lock.json')

const distributionSchema = z.object({
  schemaVersion: z.literal(1), inventoryId: z.string().min(1),
  offlineLockSha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifact: z.object({
    url: z.url().refine(value => {
      const url = new URL(value)
      return !url.username && !url.password && (url.protocol === 'https:'
        || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
    }, 'Reference distribution requires HTTPS'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().positive().max(2_000_000_000),
    unpackedSizeBytes: z.number().int().positive().max(4_000_000_000), fileCount: z.number().int().positive().max(100_000),
  }).strict(),
}).strict()

export interface DrgReferenceSyncOptions {
  databasePath: string
  repositoryRoot?: string
  installDirectory?: string
  lockPath?: string
  distributionPath?: string
  checkOnly?: boolean
  onProgress?: (line: string) => void
}

export interface DrgReferenceSyncResult {
  inventoryId: string
  source: 'local' | 'installed' | 'download'
  created: boolean
  inputRoot: string
}

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

async function publish(options: DrgReferenceSyncOptions, lockPath: string, inputRoot: string, source: DrgReferenceSyncResult['source']) {
  const inventory = await inspectOfflineInventory(lockPath, inputRoot)
  let temporary: string | undefined
  let database: ReturnType<typeof openReferenceDatabase> | undefined
  try {
    if (!options.checkOnly) {
      try {
        database = openReferenceDatabase({ databasePath: options.databasePath, readonly: true, busyTimeoutMs: 5_000 })
        let page = 1
        while (true) {
          const result = listOfflineInventories(database, { page, pageSize: 50 })
          if (result.items.some(item => item.inventoryId === inventory.inventoryId && item.contentHash === inventory.contentHash)) {
            return { inventoryId: inventory.inventoryId, source, created: false, inputRoot }
          }
          if (page * result.pageSize >= result.total) break
          page += 1
        }
      } catch { /* A missing database or migration is prepared below. */ }
      finally { database?.close() }
    }
    if (options.checkOnly) temporary = await mkdtemp(join(tmpdir(), 'clinmesh-drg-check-'))
    const databasePath = temporary === undefined ? options.databasePath : join(temporary, 'reference.sqlite')
    await mkdir(dirname(resolve(databasePath)), { recursive: true })
    const writable = openReferenceDatabase({ databasePath, busyTimeoutMs: 5_000 })
    try {
      applyReferenceMigrations(writable)
      const result = await prepareOfflineInventory(writable, lockPath, inputRoot)
      return { inventoryId: inventory.inventoryId, source, created: result.created, inputRoot }
    } finally { writable.close() }
  } finally {
    if (temporary !== undefined) await rm(temporary, { recursive: true, force: true })
  }
}

async function download(artifact: z.infer<typeof distributionSchema>['artifact'], path: string): Promise<void> {
  const response = await fetch(artifact.url, { signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok || response.body === null) throw new Error(`DRG reference download failed: HTTP ${response.status}`)
  const digest = createHash('sha256')
  let bytes = 0
  const checked = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length
    if (bytes > artifact.sizeBytes) { callback(new Error('DRG archive exceeds its pinned size')); return }
    digest.update(chunk)
    callback(null, chunk)
  } })
  const body = response.body
  const chunks = async function* () {
    const reader = body.getReader()
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) return
        yield result.value
      }
    } finally { reader.releaseLock() }
  }
  await pipeline(Readable.from(chunks()), checked, createWriteStream(path, { flags: 'wx' }))
  if (bytes !== artifact.sizeBytes || digest.digest('hex') !== artifact.sha256) {
    throw new Error('DRG archive size or SHA-256 does not match its lock')
  }
}

function safePath(path: string): boolean {
  return !path.includes('\\') && !path.includes(':') && !path.startsWith('/')
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

export async function runDrgReferenceSync(options: DrgReferenceSyncOptions): Promise<DrgReferenceSyncResult> {
  const lockPath = resolve(options.lockPath ?? defaultLockPath)
  const lockBytes = await readFile(lockPath)
  const lock = offlineReferenceLockSchema.parse(JSON.parse(lockBytes.toString('utf8')))
  const lockHash = hash(JSON.stringify(lock))
  if (lock.packages.some(item => !safePath(item.root))) throw new Error('DRG package root must be a contained relative path')
  const repositoryRoot = resolve(options.repositoryRoot ?? defaultRepositoryRoot)
  const installDirectory = resolve(options.installDirectory ?? join(dirname(resolve(options.databasePath)), 'drg-reference'))
  const installedRoot = join(installDirectory, lockHash)
  for (const [source, inputRoot] of [['local', repositoryRoot], ['installed', installedRoot]] as const) {
    try { await inspectOfflineInventory(lockPath, inputRoot) }
    catch { continue }
    options.onProgress?.(`DRG 资料完整，复用${source === 'local' ? '本地' : '已安装'}资料：${lock.inventoryId}`)
    return publish(options, lockPath, inputRoot, source)
  }

  const distribution = distributionSchema.parse(JSON.parse(await readFile(options.distributionPath ?? defaultDistributionPath, 'utf8')))
  if (distribution.offlineLockSha256 !== lockHash || distribution.inventoryId !== lock.inventoryId) {
    throw new Error('DRG distribution does not match the offline inventory lock')
  }
  const stagingParent = options.checkOnly ? tmpdir() : installDirectory
  await mkdir(stagingParent, { recursive: true })
  const staging = await mkdtemp(join(stagingParent, '.clinmesh-drg-'))
  const extracted = join(staging, 'files')
  const backup = join(staging, 'previous')
  let replaced = false
  let installed = false
  try {
    const archivePath = join(staging, 'reference.tar.gz')
    options.onProgress?.(`下载固定 DRG 资料包：${lock.inventoryId} (${(distribution.artifact.sizeBytes / 1_000_000).toFixed(1)} MB)`)
    await download(distribution.artifact, archivePath)
    await mkdir(extracted)
    const paths = new Set<string>()
    let bytes = 0
    let extractionError: Error | undefined
    await extract({ cwd: extracted, file: archivePath, strict: true, noMtime: true, filter: (path, entry) => {
      if (extractionError !== undefined) return false
      if (!('type' in entry) || entry.type !== 'File' || !safePath(path) || !lock.packages.some(item => path.startsWith(`${item.root}/`)) || paths.has(path)) {
        extractionError = new Error('DRG archive contains an unsafe, duplicate or unexpected entry')
        return false
      }
      paths.add(path)
      bytes += entry.size
      if (paths.size > distribution.artifact.fileCount || bytes > distribution.artifact.unpackedSizeBytes) {
        extractionError = new Error('DRG archive exceeds its pinned extraction limits')
        return false
      }
      return true
    } })
    if (extractionError !== undefined) throw extractionError
    if (paths.size !== distribution.artifact.fileCount || bytes !== distribution.artifact.unpackedSizeBytes) {
      throw new Error('DRG archive is incomplete')
    }
    await inspectOfflineInventory(lockPath, extracted)
    if (options.checkOnly) return await publish(options, lockPath, extracted, 'download')
    let previousExists = false
    try { await lstat(installedRoot); previousExists = true }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    if (previousExists) { await rename(installedRoot, backup); replaced = true }
    await rename(extracted, installedRoot)
    installed = true
    const result = await publish(options, lockPath, installedRoot, 'download')
    options.onProgress?.(`DRG 资料准备完成：${result.inventoryId}`)
    return result
  } catch (error) {
    if (installed) await rm(installedRoot, { recursive: true, force: true })
    if (replaced) await rename(backup, installedRoot)
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    database: { type: 'string' }, 'install-directory': { type: 'string' },
    manifest: { type: 'string' }, distribution: { type: 'string' },
    'input-root': { type: 'string' }, check: { type: 'boolean', default: false },
  } })
  const environment = readServerEnvironment(process.env)
  const result = await runDrgReferenceSync({
    databasePath: values.database ?? environment.CLINMESH_REFERENCE_DATABASE_PATH ?? join(defaultRepositoryRoot, '.data/clinmesh-reference.sqlite'),
    ...(values['install-directory'] === undefined ? {} : { installDirectory: values['install-directory'] }),
    ...(values.manifest === undefined ? {} : { lockPath: values.manifest }),
    ...(values.distribution === undefined ? {} : { distributionPath: values.distribution }),
    ...(values['input-root'] === undefined ? {} : { repositoryRoot: values['input-root'] }),
    checkOnly: values.check, onProgress: line => process.stderr.write(`${line}\n`),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] !== undefined && /^drg-reference-sync\.(ts|js)$/.test(basename(process.argv[1]))
  && resolve(process.argv[1]) === resolve(import.meta.filename)) await main()
