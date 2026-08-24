import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runDatabaseCli } from '../src/database-cli.ts'
import {
  applyMigrations,
  backupDatabase,
  canonicalStateHash,
  openClinMeshDatabase,
  rebuildDatabaseIndexes,
  restoreDatabase,
} from '../src/infrastructure/sqlite/database.ts'
import { FhirRepository } from '../src/infrastructure/sqlite/fhir-repository.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'

describe('SQLite lifecycle', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
  })

  it('opens a configured file with the required safety settings and stable migrations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-sqlite-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'clinmesh.sqlite')

    const first = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    const firstMigration = applyMigrations(first)

    expect(first.diagnostics()).toEqual({
      busyTimeoutMs: 5_000,
      foreignKeys: true,
      integrity: 'ok',
      journalMode: 'wal',
      schemaVersion: 8,
    })
    expect(firstMigration).toEqual({
      applied: [
        '0000_foundation.sql',
        '0001_identity.sql',
        '0002_scenario.sql',
        '0003_outpatient-workflow.sql',
        '0004_clinical-signing.sql',
        '0005_partial-dispensing.sql',
        '0006_queue-pagination.sql',
        '0007_prescription-review.sql',
      ],
      schemaVersion: 8,
    })
    first.close()

    const reopened = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    expect(applyMigrations(reopened)).toEqual({ applied: [], schemaVersion: 8 })
    expect(reopened.diagnostics().schemaVersion).toBe(8)
    reopened.close()
  })

  it('requires migrations to be applied explicitly before verified runtime startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-explicit-migration-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'clinmesh.sqlite')
    const options = {
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath,
      demoPassword: `Test-${crypto.randomUUID()}-Aa1!`,
      migrationMode: 'verify' as const,
      trustedOrigins: ['http://localhost'],
    }

    await expect(createClinMeshRuntime(options)).rejects.toThrow('Pending database migrations')
    const unmigrated = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    expect(unmigrated.diagnostics().schemaVersion).toBe(0)
    applyMigrations(unmigrated)
    unmigrated.close()

    const runtime = await createClinMeshRuntime(options)
    expect(runtime.database.diagnostics().schemaVersion).toBe(8)
    await runtime.close()
  })

  it('restores a consistent backup to a new path without changing the active database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-backup-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'active.sqlite')
    const backupPath = join(directory, 'backup.sqlite')
    const restoredPath = join(directory, 'restored.sqlite')
    const context = { epoch: 'epoch-001', workspaceId: 'workspace-001' }
    const database = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    applyMigrations(database)
    new WorkspaceRepository(database).install({
      ...context,
      scenarioId: 'backup-contract',
      scenarioRunId: 'run-001',
      workspaceName: '合成备份工作区',
    })
    const hashBeforeDomainFacts = canonicalStateHash(database)
    database.driver.prepare(`
      INSERT INTO scenario_definition (
        scenario_id, version, kind, schema_version, clinical_review_json
      ) VALUES (?, ?, ?, ?, ?)
    `).run('backup-contract', '1.0.0', 'candidate', '1', null)
    database.driver.prepare(`
      INSERT INTO scenario_epoch_state (
        workspace_id, epoch, scenario_run_id, scenario_id,
        deterministic_seed, virtual_time, initial_state_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      'run-001',
      'backup-contract',
      20260824,
      '2026-08-24T09:00:00+08:00',
      'synthetic-initial-state',
    )
    database.driver.prepare(`
      INSERT INTO outpatient_catalog (
        workspace_id, epoch, item_id, kind, code, name_zh, name_en,
        price_fen, version, active, config_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      'synthetic-service',
      'laboratory',
      'SYN-LAB',
      '合成检验服务',
      'Synthetic laboratory service',
      2500,
      1,
      1,
      '{}',
    )
    expect(canonicalStateHash(database)).not.toBe(hashBeforeDomainFacts)
    const repository = new FhirRepository(database, {
      now: () => new Date('2026-08-24T01:00:00.000Z'),
    })
    repository.create(context, {
      resourceType: 'Patient',
      id: 'patient-backup',
      name: [{ text: '备份版本' }],
    })
    const expectedHash = canonicalStateHash(database)

    expect(await backupDatabase(database, backupPath)).toMatchObject({
      canonicalStateHash: expectedHash,
      schemaVersion: 8,
    })
    repository.update(context, {
      resourceType: 'Patient',
      id: 'patient-backup',
      name: [{ text: '活动库后续版本' }],
    }, '1')

    expect(await restoreDatabase({
      backupPath,
      busyTimeoutMs: 5_000,
      destinationPath: restoredPath,
      expectedSchemaVersion: 8,
    })).toMatchObject({
      canonicalStateHash: expectedHash,
      integrity: 'ok',
      schemaVersion: 8,
    })

    const restored = openClinMeshDatabase({ databasePath: restoredPath, busyTimeoutMs: 5_000 })
    expect(new FhirRepository(restored).read(context, 'Patient', 'patient-backup')).toMatchObject({
      meta: { versionId: '1' },
      name: [{ text: '备份版本' }],
    })
    expect(repository.read(context, 'Patient', 'patient-backup')).toMatchObject({
      meta: { versionId: '2' },
      name: [{ text: '活动库后续版本' }],
    })
    restored.close()
    database.close()
  })

  it('rejects a corrupt restore candidate without creating the destination or changing the active database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-corrupt-restore-'))
    temporaryDirectories.push(directory)
    const activePath = join(directory, 'active.sqlite')
    const corruptPath = join(directory, 'corrupt.sqlite')
    const destinationPath = join(directory, 'restored.sqlite')
    const context = { epoch: 'epoch-001', workspaceId: 'workspace-001' }
    const database = openClinMeshDatabase({ databasePath: activePath, busyTimeoutMs: 5_000 })
    applyMigrations(database)
    new WorkspaceRepository(database).install({
      ...context,
      scenarioId: 'restore-failure-contract',
      scenarioRunId: 'run-001',
      workspaceName: '合成恢复失败工作区',
    })
    const repository = new FhirRepository(database)
    repository.create(context, {
      resourceType: 'Patient',
      id: 'patient-active',
      name: [{ text: '活动库合成患者' }],
    })
    await writeFile(corruptPath, 'this is not a SQLite database')

    await expect(restoreDatabase({
      backupPath: corruptPath,
      busyTimeoutMs: 5_000,
      destinationPath,
      expectedSchemaVersion: 8,
    })).rejects.toThrow()
    expect(existsSync(destinationPath)).toBe(false)
    expect(repository.read(context, 'Patient', 'patient-active')).toMatchObject({
      name: [{ text: '活动库合成患者' }],
    })
    database.close()
  })

  it('enforces foreign keys and bounds competing WAL writers by the configured busy timeout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-sqlite-contention-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'clinmesh.sqlite')
    const writerA = openClinMeshDatabase({ databasePath, busyTimeoutMs: 25 })
    applyMigrations(writerA)
    const writerB = openClinMeshDatabase({ databasePath, busyTimeoutMs: 25 })
    const context = { epoch: 'epoch-001', workspaceId: 'workspace-001' }
    new WorkspaceRepository(writerA).install({
      ...context,
      scenarioId: 'sqlite-contention-contract',
      scenarioRunId: 'run-001',
      workspaceName: '合成并发工作区',
    })

    expect(() => writerA.driver.prepare(`
      INSERT INTO workspace_epoch (
        workspace_id, epoch, state, scenario_id, created_at
      ) VALUES ('missing-workspace', 'epoch-invalid', 'active', 'invalid', ?)
    `).run(new Date().toISOString())).toThrow(/FOREIGN KEY constraint failed/)

    writerA.driver.exec('BEGIN IMMEDIATE')
    writerA.driver.prepare(`
      UPDATE workspace SET name = '写入者甲' WHERE workspace_id = ?
    `).run(context.workspaceId)
    const startedAt = performance.now()
    expect(() => writerB.driver.prepare(`
      UPDATE workspace SET name = '写入者乙' WHERE workspace_id = ?
    `).run(context.workspaceId)).toThrow(/database is locked/)
    expect(performance.now() - startedAt).toBeLessThan(500)
    writerA.driver.exec('ROLLBACK')
    expect(writerB.driver.prepare(`
      UPDATE workspace SET name = '写入者乙' WHERE workspace_id = ?
    `).run(context.workspaceId).changes).toBe(1)
    expect(writerB.diagnostics()).toMatchObject({
      busyTimeoutMs: 25,
      foreignKeys: true,
      journalMode: 'wal',
    })
    writerB.close()
    writerA.close()
  })

  it('rebuilds the role queue indexes and preserves indexed query plans', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-index-rebuild-'))
    temporaryDirectories.push(directory)
    const database = openClinMeshDatabase({
      databasePath: join(directory, 'clinmesh.sqlite'),
      busyTimeoutMs: 5_000,
    })
    applyMigrations(database)

    const result = rebuildDatabaseIndexes(database)
    expect(result).toMatchObject({ integrity: 'ok' })
    expect(result.indexes).toEqual(expect.arrayContaining([
      'fhir_sp_string_search_idx',
      'outpatient_case_arrival_idx',
      'outpatient_case_status_arrival_idx',
      'outpatient_case_status_updated_idx',
      'charge_record_queue_idx',
    ]))
    const plans = [
      database.driver.prepare(`
        EXPLAIN QUERY PLAN
        SELECT resource_id FROM fhir_sp_string
        WHERE workspace_id = ? AND epoch = ? AND resource_type = 'Patient'
          AND param = 'name' AND normalized LIKE ?
      `).all('workspace-demo', 'epoch-1', '合成密度%'),
      database.driver.prepare(`
        EXPLAIN QUERY PLAN
        SELECT case_id FROM outpatient_case
        WHERE workspace_id = ? AND epoch = ?
        ORDER BY arrived_at DESC, case_id LIMIT ? OFFSET ?
      `).all('workspace-demo', 'epoch-1', 20, 0),
      database.driver.prepare(`
        EXPLAIN QUERY PLAN
        SELECT case_id FROM outpatient_case
        WHERE workspace_id = ? AND epoch = ? AND status = ?
        ORDER BY arrived_at, case_id LIMIT ? OFFSET ?
      `).all('workspace-demo', 'epoch-1', 'awaiting-triage', 20, 0),
      database.driver.prepare(`
        EXPLAIN QUERY PLAN
        SELECT case_id FROM outpatient_case
        WHERE workspace_id = ? AND epoch = ? AND status = ?
        ORDER BY updated_at, case_id LIMIT ? OFFSET ?
      `).all('workspace-demo', 'epoch-1', 'awaiting-dispense', 20, 0),
      database.driver.prepare(`
        EXPLAIN QUERY PLAN
        SELECT charge_id FROM charge_record
        WHERE workspace_id = ? AND epoch = ? AND category = ? AND status = ?
        ORDER BY created_at, charge_id LIMIT ? OFFSET ?
      `).all('workspace-demo', 'epoch-1', 'laboratory', 'billable', 20, 0),
    ].flat() as Array<{ detail: string }>
    const details = plans.map(plan => plan.detail).join('\n')
    expect(details).toContain('fhir_sp_string_search_idx')
    expect(details).toContain('outpatient_case_arrival_idx')
    expect(details).toContain('outpatient_case_status_arrival_idx')
    expect(details).toContain('outpatient_case_status_updated_idx')
    expect(details).toContain('charge_record_queue_idx')
    database.close()
  })

  it('runs explicit migrate, verify, backup, and restore operations through the CLI contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-database-cli-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'active.sqlite')
    const backupPath = join(directory, 'backup.sqlite')
    const restoredPath = join(directory, 'restored.sqlite')
    const legacyMigrationDirectory = join(directory, 'legacy-migrations')
    await mkdir(legacyMigrationDirectory)
    for (const migration of [
      '0000_foundation.sql',
      '0001_identity.sql',
      '0002_scenario.sql',
      '0003_outpatient-workflow.sql',
      '0004_clinical-signing.sql',
      '0005_partial-dispensing.sql',
      '0006_queue-pagination.sql',
    ]) {
      await copyFile(join(process.cwd(), 'drizzle', migration), join(legacyMigrationDirectory, migration))
    }
    const legacyDatabase = openClinMeshDatabase({ busyTimeoutMs: 5_000, databasePath })
    applyMigrations(legacyDatabase, legacyMigrationDirectory)
    legacyDatabase.close()

    const migrationResult = z.object({
      applied: z.array(z.string()),
      preMigrationBackup: z.object({
        canonicalStateHash: z.string().regex(/^[a-f0-9]{64}$/),
        path: z.string().min(1),
        schemaVersion: z.literal(7),
      }),
      schemaVersion: z.literal(8),
    }).parse(await runDatabaseCli([
      'migrate',
      '--database',
      databasePath,
    ], {}))
    expect(migrationResult.applied).toEqual(['0007_prescription-review.sql'])
    expect(existsSync(migrationResult.preMigrationBackup.path)).toBe(true)
    await expect(runDatabaseCli([
      'verify',
      '--database',
      databasePath,
    ], {})).resolves.toMatchObject({ integrity: 'ok', schemaVersion: 8 })
    await expect(runDatabaseCli([
      'backup',
      '--database',
      databasePath,
      '--output',
      backupPath,
    ], {})).resolves.toMatchObject({ integrity: 'ok', schemaVersion: 8 })
    await expect(runDatabaseCli([
      'restore',
      '--backup',
      backupPath,
      '--destination',
      restoredPath,
    ], {})).resolves.toMatchObject({ integrity: 'ok', schemaVersion: 8 })
  })
})
