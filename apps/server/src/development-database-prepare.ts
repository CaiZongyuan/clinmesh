import { existsSync } from 'node:fs'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { defaultGuidelineDatabasePath, readServerConfig, readServerEnvironment } from './config.ts'
import { runDatabaseCli } from './database-cli.ts'
import { runReferenceDatabaseCli } from './reference-database-cli.ts'
import { runDrgReferenceSync, type DrgReferenceSyncOptions } from './drg-reference-sync.ts'
import { inspectDrgRulesSourceInputs, runDrgRulesPrepare } from './drg-rules-prepare.ts'
import { runGuidelinePrepare } from './guideline-prepare.ts'
import { loadReviewedDrgRules } from './infrastructure/reference-data/drg-rules-package.ts'
import { referenceDatabaseIsReady } from './reference-readiness.ts'
import { runReferenceSync } from './reference-sync.ts'

const referenceLockReleaseSchema = z.object({
  compositeRelease: z.object({ releaseId: z.string().min(1) }),
})

export async function prepareDevelopmentDatabases(input: {
  busyTimeoutMs?: number
  databasePath: string
  referenceDatabasePath?: string
}) {
  const busyTimeoutMs = String(input.busyTimeoutMs ?? 5_000)
  const operational = await runDatabaseCli([
    'migrate',
    '--database', resolve(input.databasePath),
    '--busy-timeout-ms', busyTimeoutMs,
  ], {})
  const reference = input.referenceDatabasePath === undefined
    ? null
    : await runReferenceDatabaseCli([
        'migrate',
        '--database', resolve(input.referenceDatabasePath),
        '--busy-timeout-ms', busyTimeoutMs,
      ])
  return { operational, reference }
}

export async function prepareDevelopmentDrgRules(input: {
  inputRoot: string
  repositoryRoot: string
  referenceReleaseId?: string
  offlineLockPath?: string
  sourceLockPath?: string
  outputDirectory?: string
  reviewPath?: string
}) {
  const inspected = await inspectDrgRulesSourceInputs({
    inputRoot: input.inputRoot,
    ...(input.sourceLockPath === undefined ? {} : { sourceLockPath: input.sourceLockPath }),
    ...(input.offlineLockPath === undefined ? {} : { offlineLockPath: input.offlineLockPath }),
  })
  if (!inspected.available) {
    if (input.outputDirectory !== undefined) {
      throw new Error(`Configured DRG rules directory cannot be prepared because offline inventory lacks required inputs for ${inspected.source.releaseId}`)
    }
    return {
      status: 'skipped' as const,
      reason: 'source-inputs-absent' as const,
      releaseId: inspected.source.releaseId,
      outputDirectory: null,
      reviewPath: null,
    }
  }
  const outputDirectory = resolve(input.outputDirectory ?? join(input.repositoryRoot, '.data/drg-rules', inspected.source.releaseId))
  const prepared = await runDrgRulesPrepare({
    inputRoot: input.inputRoot,
    outputDirectory,
    sourceLockPath: inspected.sourceLockPath,
    offlineLockPath: inspected.offlineLockPath,
  })
  const defaultReviewPath = join(input.repositoryRoot, 'deployment/drg/pci-demo-review.json')
  const reviewPath = input.reviewPath !== undefined
    ? resolve(input.reviewPath)
    : input.outputDirectory === undefined && existsSync(defaultReviewPath)
      ? resolve(defaultReviewPath)
      : null
  if (reviewPath !== null) {
    const referenceLockPath = join(input.repositoryRoot, 'reference-data.lock.json')
    const effectiveReferenceReleaseId = input.referenceReleaseId
      ?? (existsSync(referenceLockPath)
        ? referenceLockReleaseSchema.parse(JSON.parse(await readFile(referenceLockPath, 'utf8'))).compositeRelease.releaseId
        : undefined)
    await loadReviewedDrgRules({
      directory: prepared.outputDirectory,
      reviewPath,
      referenceReleaseId: effectiveReferenceReleaseId,
    })
    const noticeSourcePath = join(dirname(reviewPath), 'NOTICE.md')
    if (existsSync(noticeSourcePath)) {
      const sourceStat = await lstat(noticeSourcePath)
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error('DRG rules NOTICE.md source must be a regular file')
      }
      const noticeContent = await readFile(noticeSourcePath, 'utf8')
      const targetNoticePath = join(prepared.outputDirectory, 'NOTICE.md')
      const existingNotice = await lstat(targetNoticePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (existingNotice !== null && (!existingNotice.isFile() || existingNotice.isSymbolicLink())) {
        throw new Error('DRG rules target NOTICE.md must be a regular file')
      }
      const currentNotice = existingNotice === null ? null : await readFile(targetNoticePath, 'utf8')
      if (currentNotice !== noticeContent) await writeFile(targetNoticePath, noticeContent, 'utf8')
    }
  }
  return { ...prepared, reviewPath }
}

export async function prepareDevelopmentEnvironment(input: {
  busyTimeoutMs?: number
  databasePath: string
  migrationsOnly?: boolean
  referenceDatabasePath?: string
  referenceReleaseId?: string
  repositoryRoot?: string
  drgReference?: Pick<DrgReferenceSyncOptions, 'lockPath' | 'distributionPath' | 'installDirectory'>
  drgRules?: {
    outputDirectory?: string
    reviewPath?: string
    sourceLockPath?: string
  }
  guidelineDatabasePath?: string
  guidelineReference?: Pick<Parameters<typeof runGuidelinePrepare>[0], 'lockPath' | 'inputRoot' | 'installDirectory' | 'deploymentPolicy' | 'allowNonCommercial' | 'allowLocalEvaluation'>
  onProgress?: (line: string) => void
}) {
  const repositoryRoot = resolve(input.repositoryRoot ?? join(import.meta.dirname, '../../..'))
  const result = await prepareDevelopmentDatabases(input)
  if (input.migrationsOnly === true) return { ...result, drgRules: null }
  await runGuidelinePrepare({
    ...input.guidelineReference,
    databasePath: resolve(input.guidelineDatabasePath ?? defaultGuidelineDatabasePath),
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
  })
  if (input.referenceDatabasePath === undefined) return { ...result, drgRules: null }
  const databasePath = resolve(input.referenceDatabasePath)
  const drgSync = !referenceDatabaseIsReady(databasePath, repositoryRoot, input.referenceReleaseId)
    ? (await runReferenceSync({
        checkOnly: false,
        databasePath,
        lockPath: join(repositoryRoot, 'reference-data.lock.json'),
        repositoryRoot,
        ...(input.drgReference === undefined ? {} : { drgReference: input.drgReference }),
        ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      })).drg
    : await runDrgReferenceSync({
        ...input.drgReference,
        databasePath,
        repositoryRoot,
        ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      })
  const drgRules = await prepareDevelopmentDrgRules({
    inputRoot: drgSync.inputRoot,
    repositoryRoot,
    ...(input.referenceReleaseId === undefined ? {} : { referenceReleaseId: input.referenceReleaseId }),
    ...(input.drgReference?.lockPath === undefined ? {} : { offlineLockPath: input.drgReference.lockPath }),
    ...input.drgRules,
  })
  return { ...result, drgRules }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  const environment = readServerEnvironment(process.env)
  const config = readServerConfig(environment)
  const result = await prepareDevelopmentEnvironment({
    busyTimeoutMs: Number(environment.CLINMESH_BUSY_TIMEOUT_MS ?? '5000'),
    databasePath: config.databasePath,
    migrationsOnly: process.argv.includes('--migrations-only'),
    guidelineDatabasePath: config.guidelineDatabasePath,
    guidelineReference: {
      deploymentPolicy: config.guidelineDeploymentPolicy,
      allowNonCommercial: config.guidelineNonCommercialUse,
      allowLocalEvaluation: config.guidelineLocalEvaluation,
    },
    ...(config.drgRulesDirectory === undefined
      ? {}
      : { drgRules: { outputDirectory: config.drgRulesDirectory, reviewPath: config.drgRulesReviewPath! } }),
    ...(config.referenceDatabasePath === undefined
      ? {}
      : { referenceDatabasePath: config.referenceDatabasePath }),
    ...(config.referenceReleaseId === undefined ? {} : { referenceReleaseId: config.referenceReleaseId }),
    onProgress: line => process.stderr.write(`${line}\n`),
  })
  console.info(JSON.stringify(result))
}
