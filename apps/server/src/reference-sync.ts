import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { runReferenceDatabaseCli } from './reference-database-cli.ts'

const maxCliOutputBytes = 2 * 1024 * 1024
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const defaultRepositoryRoot = resolve(import.meta.dirname, '../../..')
const cnHealthLauncherPath = (repositoryRoot: string): string =>
  join(repositoryRoot, 'node_modules/cn-health/bin/cn-health.js')

export interface CnHealthInvocation {
  file: string
  prefix: readonly string[]
}

export function cnHealthInvocation(input: {
  cliPath?: string | undefined
  execPath: string
  repositoryRoot: string
}): CnHealthInvocation {
  if (input.cliPath !== undefined) return { file: input.cliPath, prefix: [] }
  return { file: input.execPath, prefix: [cnHealthLauncherPath(input.repositoryRoot)] }
}

const referenceLockSchema = z.object({
  cli: z.object({
    package: z.literal('cn-health'),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
  }).strict(),
  compositeRelease: z.object({
    createdAt: z.iso.datetime({ offset: true }),
    releaseId: z.string().min(1).max(256),
    schemaVersion: z.literal('1'),
  }).strict(),
  datasets: z.array(z.object({
    datasetId: z.enum([
      'laboratory-cn',
      'loinc-zh-cn',
      'nhc-icd10-clinical',
      'nhsa-drugs',
    ]),
    datasetSchemaVersion: z.union([z.literal(1), z.literal(2)]),
    licenseId: z.string().min(1).max(256),
    manifestSha256: sha256Schema,
    publishedAt: z.iso.date().optional(),
    releaseId: z.string().min(1).max(256),
    sourceId: z.string().min(1).max(256),
    sourceUrl: z.string().url(),
  }).strict()).min(1).superRefine((datasets, context) => {
    const ids = datasets.map(dataset => dataset.datasetId)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'Reference lock Dataset IDs must be unique' })
    }
  }),
  registry: z.object({
    keyId: z.string().regex(/^[a-f0-9]{16}$/),
    publicKeyHex: z.string().regex(/^[a-f0-9]{64}$/),
    publicKeySha256: sha256Schema,
    url: z.string().url(),
  }).strict(),
  retrievedAt: z.iso.datetime({ offset: true }),
  schemaVersion: z.literal(1),
}).strict()

const materializationReceiptSchema = z.object({
  cliVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  command: z.literal('dataset.materialize'),
  dataset: z.object({
    datasetSchemaVersion: z.union([z.literal(1), z.literal(2)]),
    id: z.string().min(1),
    releaseId: z.string().min(1),
  }).strict(),
  manifest: z.object({
    path: z.literal('manifest.json'),
    sha256: sha256Schema,
    sizeBytes: z.number().int().positive(),
  }).strict(),
  registry: z.object({
    keyId: z.string().min(1),
    trust: z.literal('signed-registry'),
    url: z.string().url(),
  }).strict(),
  schemaVersion: z.literal(1),
  sqlite: z.object({
    path: z.literal('data.sqlite'),
    sha256: sha256Schema,
    sizeBytes: z.number().int().positive(),
  }).strict(),
}).strict()

const materializedDatasetManifestSchema = z.object({
  canonical: z.object({
    recordCount: z.number().int().nonnegative(),
    tables: z.array(z.object({
      recordCount: z.number().int().nonnegative(),
      table: z.string().min(1),
    }).loose()).optional(),
  }).loose(),
  dataset: z.object({
    datasetSchemaVersion: z.union([z.literal(1), z.literal(2)]),
    id: z.string().min(1),
  }).loose(),
  release: z.object({ id: z.string().min(1) }).loose(),
}).loose()

export interface ReferenceSyncOptions {
  checkOnly: boolean
  cliPath?: string
  databasePath: string
  lockPath: string
  onProgress?: (line: string) => void
  repositoryRoot?: string
  runtimeDataDirectory?: string
}

function elapsedSeconds(start: number): string {
  return `${((performance.now() - start) / 1000).toFixed(1)}s`
}

async function timedPhase<T>(input: {
  label: string
  onProgress?: ((line: string) => void) | undefined
  run: () => Promise<T>
}): Promise<T> {
  const start = performance.now()
  const result = await input.run()
  input.onProgress?.(`${input.label} 完成 (${elapsedSeconds(start)})`)
  return result
}

async function hashFile(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash('sha256')
  const input = createReadStream(path)
  for await (const chunk of input) hash.update(chunk)
  return { sha256: hash.digest('hex'), sizeBytes: (await stat(path)).size }
}

/**
 * Runs the cn-health CLI, returning its stdout and forwarding each stderr
 * line to `onProgress`; the CLI reports download and verification progress
 * on stderr while keeping stdout JSON-only.
 */
function executeCli(input: {
  args: readonly string[]
  file: string
  onProgress?: ((line: string) => void) | undefined
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.file, input.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let settled = false
    const finish = (run: () => void) => {
      if (settled) return
      settled = true
      run()
    }
    createInterface({ input: child.stderr })
      .on('line', line => input.onProgress?.(line))
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= maxCliOutputBytes) {
        stdout.push(chunk)
        return
      }
      child.kill()
      finish(() => reject(new Error('cn-health CLI stdout exceeded the size limit')))
    })
    child.on('error', error => finish(() => reject(error)))
    child.on('close', (code, signal) => finish(() => {
      const output = Buffer.concat(stdout).toString('utf8')
      if (code === 0) {
        resolve(output)
        return
      }
      const detail = output.trim().slice(0, 500)
      reject(new Error(`cn-health CLI exited with ${signal ?? code}${detail === '' ? '' : `: ${detail}`}`))
    }))
  })
}

function assertReceipt(input: {
  dataset: z.infer<typeof referenceLockSchema>['datasets'][number]
  lock: z.infer<typeof referenceLockSchema>
  receipt: z.infer<typeof materializationReceiptSchema>
}): void {
  if (input.receipt.cliVersion !== input.lock.cli.version) {
    throw new Error('Materialization CLI version does not match lock')
  }
  if (input.receipt.dataset.id !== input.dataset.datasetId
    || input.receipt.dataset.releaseId !== input.dataset.releaseId
    || input.receipt.dataset.datasetSchemaVersion !== input.dataset.datasetSchemaVersion) {
    throw new Error('Materialization Dataset identity does not match lock')
  }
  if (input.receipt.registry.url !== input.lock.registry.url
    || input.receipt.registry.keyId !== input.lock.registry.keyId) {
    throw new Error('Materialization Registry identity does not match lock')
  }
  if (input.receipt.manifest.sha256 !== input.dataset.manifestSha256) {
    throw new Error('Materialization Manifest SHA256 does not match lock')
  }
}

export async function runReferenceSync(options: ReferenceSyncOptions) {
  const repositoryRoot = resolve(options.repositoryRoot ?? defaultRepositoryRoot)
  const lockPath = resolve(options.lockPath)
  const lock = referenceLockSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')))
  const publicKey = Buffer.from(lock.registry.publicKeyHex, 'hex')
  const publicKeySha256 = createHash('sha256').update(publicKey).digest('hex')
  if (publicKeySha256 !== lock.registry.publicKeySha256
    || !publicKeySha256.startsWith(lock.registry.keyId)) {
    throw new Error('Reference lock Registry public key does not match key ID')
  }
  const staging = await mkdtemp(join(tmpdir(), 'clinmesh-reference-sync-'))
  const publicKeyPath = join(staging, 'registry.pub')
  const invocation = cnHealthInvocation({
    cliPath: options.cliPath,
    execPath: process.execPath,
    repositoryRoot,
  })
  if (options.cliPath === undefined) {
    const launcherPath = cnHealthLauncherPath(repositoryRoot)
    try {
      await access(launcherPath)
    } catch {
      throw new Error(`cn-health launcher not found at ${launcherPath}; run pnpm install first`)
    }
  }
  const runtimeDataDirectory = resolve(
    options.runtimeDataDirectory ?? join(repositoryRoot, '.data/cn-health-cache'),
  )
  await mkdir(runtimeDataDirectory, { recursive: true })
  await writeFile(publicKeyPath, publicKey)
  try {
    const report = (line: string) => {
      options.onProgress?.(line)
    }
    const syncStart = performance.now()
    const outcomes = await Promise.allSettled(lock.datasets.map(async (dataset, datasetIndex) => {
      const datasetStart = performance.now()
      report(`[${datasetIndex + 1}/${lock.datasets.length}] materialize ${dataset.releaseId}`)
      const outputDirectory = join(staging, dataset.datasetId)
      const stdout = await executeCli({
        args: [
          ...invocation.prefix,
          '--data-dir', runtimeDataDirectory,
          'dataset', 'materialize', dataset.datasetId, dataset.releaseId,
          '--registry', lock.registry.url,
          '--public-key', publicKeyPath,
          '--output', outputDirectory,
          '--json',
        ],
        file: invocation.file,
        onProgress: options.onProgress,
      })
      const receipt = materializationReceiptSchema.parse(JSON.parse(stdout))
      const persistedReceipt = materializationReceiptSchema.parse(JSON.parse(
        await readFile(join(outputDirectory, 'materialization.json'), 'utf8'),
      ))
      if (JSON.stringify(receipt) !== JSON.stringify(persistedReceipt)) {
        throw new Error('Materialization stdout and receipt differ')
      }
      assertReceipt({ dataset, lock, receipt })
      const manifestPath = join(outputDirectory, receipt.manifest.path)
      const sqlitePath = join(outputDirectory, receipt.sqlite.path)
      const [manifestFile, sqliteFile] = await Promise.all([
        hashFile(manifestPath),
        hashFile(sqlitePath),
      ])
      if (manifestFile.sha256 !== receipt.manifest.sha256
        || manifestFile.sizeBytes !== receipt.manifest.sizeBytes) {
        throw new Error('Materialized Manifest does not match receipt')
      }
      if (sqliteFile.sha256 !== receipt.sqlite.sha256
        || sqliteFile.sizeBytes !== receipt.sqlite.sizeBytes) {
        throw new Error('Materialized SQLite does not match receipt')
      }
      const materializedManifest = materializedDatasetManifestSchema.parse(JSON.parse(
        await readFile(manifestPath, 'utf8'),
      ))
      if (materializedManifest.dataset.id !== dataset.datasetId
        || materializedManifest.release.id !== dataset.releaseId
        || materializedManifest.dataset.datasetSchemaVersion !== dataset.datasetSchemaVersion) {
        throw new Error('Materialized Manifest Dataset identity does not match lock')
      }
      report(`[${datasetIndex + 1}/${lock.datasets.length}] ${dataset.releaseId} 完成 `
        + `(${(sqliteFile.sizeBytes / 1_000_000).toFixed(1)} MB, ${elapsedSeconds(datasetStart)})`)
      return {
        dataset: {
          datasetId: dataset.datasetId,
          datasetSchemaVersion: dataset.datasetSchemaVersion,
          recordCount: materializedManifest.canonical.recordCount,
          releaseId: dataset.releaseId,
          tables: (materializedManifest.canonical.tables ?? []).map(table => ({
            recordCount: table.recordCount,
            table: table.table,
          })),
        },
        source: {
          acquisitionMethod: 'documented-api',
          artifactFormat: 'cn-health-candidate',
          artifactPath: relative(staging, manifestPath),
          checksum: dataset.manifestSha256,
          licenseId: dataset.licenseId,
          materialization: {
            cliVersion: receipt.cliVersion,
            manifestSha256: receipt.manifest.sha256,
            registryKeyId: receipt.registry.keyId,
            registryUrl: receipt.registry.url,
            sqliteSha256: receipt.sqlite.sha256,
            sqliteSizeBytes: receipt.sqlite.sizeBytes,
          },
          ...(dataset.publishedAt === undefined ? {} : { publishedAt: dataset.publishedAt }),
          retrievedAt: lock.retrievedAt,
          sourceId: dataset.sourceId,
          sourceUrl: dataset.sourceUrl,
          upstreamVersion: dataset.releaseId,
        },
      }
    }))
    const failures = outcomes.flatMap((outcome, index) => outcome.status === 'rejected'
      ? [{ datasetId: lock.datasets[index]!.datasetId, reason: outcome.reason }]
      : [])
    if (failures.length > 0) {
      const first = failures[0]!
      throw new Error(`materialize 失败：${failures.map(failure => failure.datasetId).join(', ')}；`
        + `首个错误：${first.reason instanceof Error ? first.reason.message : String(first.reason)}`)
    }
    const datasets = []
    const sources = []
    for (const outcome of outcomes) {
      if (outcome.status !== 'fulfilled') continue
      datasets.push(outcome.value.dataset)
      sources.push(outcome.value.source)
    }
    const importManifestPath = join(staging, 'reference-release.json')
    await writeFile(importManifestPath, `${JSON.stringify({
      ...lock.compositeRelease,
      sources,
    })}\n`)
    const databasePath = options.checkOnly
      ? join(staging, 'check-reference.sqlite')
      : resolve(options.databasePath)
    await mkdir(dirname(databasePath), { recursive: true })
    await timedPhase({
      label: 'migrate',
      onProgress: options.onProgress,
      run: () => runReferenceDatabaseCli(['migrate', '--database', databasePath]),
    })
    const release = await timedPhase({
      label: `import ${lock.compositeRelease.releaseId}`,
      onProgress: options.onProgress,
      run: () => runReferenceDatabaseCli([
        'import', '--database', databasePath, '--manifest', importManifestPath,
      ]),
    })
    await timedPhase({
      label: 'verify',
      onProgress: options.onProgress,
      run: () => runReferenceDatabaseCli(['verify', '--database', databasePath]),
    })
    report(`reference:sync 完成 (总耗时 ${elapsedSeconds(syncStart)})`)
    return { checkOnly: options.checkOnly, datasets, release }
  } finally {
    await rm(staging, { recursive: true })
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

async function main(): Promise<void> {
  const result = await runReferenceSync({
    checkOnly: process.argv.includes('--check'),
    databasePath: option('--database') ?? join(defaultRepositoryRoot, '.data/clinmesh-reference.sqlite'),
    lockPath: option('--lock') ?? join(defaultRepositoryRoot, 'reference-data.lock.json'),
    onProgress: line => process.stderr.write(`${line}\n`),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main()
}
