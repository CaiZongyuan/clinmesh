import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultGuidelineDatabasePath, readServerConfig, readServerEnvironment } from './config.ts'
import { runDatabaseCli } from './database-cli.ts'
import { runReferenceDatabaseCli } from './reference-database-cli.ts'
import { runDrgReferenceSync, type DrgReferenceSyncOptions } from './drg-reference-sync.ts'
import { runGuidelinePrepare } from './guideline-prepare.ts'
import { referenceDatabaseIsReady } from './reference-readiness.ts'
import { runReferenceSync } from './reference-sync.ts'

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

export async function prepareDevelopmentEnvironment(input: {
  busyTimeoutMs?: number
  databasePath: string
  migrationsOnly?: boolean
  referenceDatabasePath?: string
  referenceReleaseId?: string
  repositoryRoot?: string
  drgReference?: Pick<DrgReferenceSyncOptions, 'lockPath' | 'distributionPath' | 'installDirectory'>
  guidelineDatabasePath?: string
  guidelineReference?: Pick<Parameters<typeof runGuidelinePrepare>[0], 'lockPath' | 'inputRoot' | 'installDirectory' | 'deploymentPolicy' | 'allowNonCommercial' | 'allowLocalEvaluation'>
  onProgress?: (line: string) => void
}) {
  const result = await prepareDevelopmentDatabases(input)
  if (input.migrationsOnly === true) return result
  await runGuidelinePrepare({
    ...input.guidelineReference,
    databasePath: resolve(input.guidelineDatabasePath ?? defaultGuidelineDatabasePath),
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
  })
  if (input.referenceDatabasePath === undefined) return result
  const repositoryRoot = resolve(input.repositoryRoot ?? join(import.meta.dirname, '../../..'))
  const databasePath = resolve(input.referenceDatabasePath)
  if (!referenceDatabaseIsReady(databasePath, repositoryRoot, input.referenceReleaseId)) {
    await runReferenceSync({
      checkOnly: false,
      databasePath,
      lockPath: join(repositoryRoot, 'reference-data.lock.json'),
      repositoryRoot,
      ...(input.drgReference === undefined ? {} : { drgReference: input.drgReference }),
      ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    })
  } else {
    await runDrgReferenceSync({
      ...input.drgReference,
      databasePath,
      repositoryRoot,
      ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    })
  }
  return result
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
    ...(config.referenceDatabasePath === undefined
      ? {}
      : { referenceDatabasePath: config.referenceDatabasePath }),
    ...(config.referenceReleaseId === undefined ? {} : { referenceReleaseId: config.referenceReleaseId }),
    onProgress: line => process.stderr.write(`${line}\n`),
  })
  console.info(JSON.stringify(result))
}
