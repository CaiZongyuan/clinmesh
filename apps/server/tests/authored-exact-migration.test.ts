import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { investigationResultSnapshotSchema, scenarioGenerationRequestSchema } from '@clinmesh/contracts/scenario'
import { openClinMeshDatabase, applyMigrations } from '../src/infrastructure/sqlite/database.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'
import { SyntheticPatientProfileRepository } from '../src/infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import { SyntheticCaseRepository } from '../src/infrastructure/sqlite/synthetic-case-repository.ts'
import { InvestigationResultRepository } from '../src/infrastructure/sqlite/investigation-result-repository.ts'
import { createSyntheticPatientProfiles } from '../src/application/scenario-data/synthetic-patient-profile.ts'
import { compileSyntheaIndexCase } from '../src/application/scenario-data/synthea-index-case.ts'
import { StubSyntheaProvider } from './fixtures/consultation.ts'

it('作者精确结果迁移保留非空旧快照及来源外键，并允许无模型的通用Case Truth来源', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-authored-exact-migration-'))
  const database = openClinMeshDatabase({ databasePath: join(directory, 'hospital.sqlite'), busyTimeoutMs: 5000 })
  try {
    const migrations = join(directory, 'migrations')
    await mkdir(migrations)
    const files = (await readdir('drizzle')).filter(file => file.endsWith('.sql') && file !== '0094_authored-exact-investigation.sql')
    await Promise.all(files.map(file => copyFile(join('drizzle', file), join(migrations, file))))
    applyMigrations(database, migrations)
    const workspaceId = 'workspace-migration'
    new WorkspaceRepository(database).install({ workspaceId, epoch: 'epoch-1', scenarioRunId: 'run-1', scenarioId: 'synthetic', workspaceName: '合成迁移医院' })
    const sources = (await new StubSyntheaProvider().generate()).sources
    const profile = createSyntheticPatientProfiles({ batchId: 'synthetic-migration', batchName: '合成迁移病例', createdAt: '2026-06-01T00:00:00Z', workspaceId, sources,
      request: scenarioGenerationRequestSchema.parse({ providerId: 'synthea', moduleMode: 'all', name: '合成迁移病例', modules: [],
        population: { count: 1, age: { minimum: 50, maximum: 70 }, gender: 'any' },
        seeds: { population: 1, clinical: 1 }, timeRange: { start: '2020-01-01', end: '2026-06-01' }, timeZone: 'Asia/Shanghai' }),
    })[0]!
    new SyntheticPatientProfileRepository(database).createBatch([profile], 'synthetic-admin')
    const syntheticCase = new SyntheticCaseRepository(database).createFromProfile({ actorId: 'synthetic-admin', profile, compiled: compileSyntheaIndexCase(sources[0]!.raw) })
    const snapshots = new InvestigationResultRepository(database)
    const old = snapshots.createOrGet(investigationResultSnapshotSchema.parse({
      workspaceId, snapshotId: 'legacy-exact', caseId: syntheticCase.caseId, catalogItemId: 'synthetic-wbc',
      requestedConcept: { id: 'synthetic:loinc:6690-2', system: 'http://loinc.org', code: '6690-2', display: '白细胞计数', version: 'synthetic', sourceLocator: 'synthetic:migration' },
      content: { conclusion: '合成旧精确结果', results: [{ code: '6690-2', display: '白细胞计数', value: 6.2,
        unit: { system: 'http://unitsofmeasure.org', code: '10*9/L', display: '10*9/L' }, referenceRange: { low: 3.5, high: 9.5, text: '3.5-9.5' }, interpretation: 'normal' }] },
      source: 'synthea-exact', model: null, promptHash: null, promptVersion: null,
      inputHash: '1'.repeat(64), outputHash: '2'.repeat(64), createdAt: '2026-06-01T00:00:00Z',
    }))
    expect(applyMigrations(database).applied).toEqual(['0094_authored-exact-investigation.sql'])
    expect(snapshots.getById(workspaceId, old.snapshotId)).toEqual(old)
    const authored = snapshots.createOrGet({ ...old, source: 'case-truth-exact', snapshotId: 'authored-exact', inputHash: '3'.repeat(64) })
    expect(authored).toMatchObject({ source: 'case-truth-exact', model: null, promptHash: null, promptVersion: null })
    expect(database.driver.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(database.driver.pragma('foreign_key_check')).toEqual([])
    expect(database.driver.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(database.driver.pragma('foreign_key_list(laboratory_request)')).toContainEqual(expect.objectContaining({ table: 'investigation_result_snapshot' }))
  } finally {
    database.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
