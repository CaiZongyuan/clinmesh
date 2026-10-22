import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CommandExecutor, type ActorContext } from '../src/application/command-executor.ts'
import { applyMigrations, expectedSchemaVersion, openClinMeshDatabase, verifyMigrations, type ClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { FhirRepository } from '../src/infrastructure/sqlite/fhir-repository.ts'
import { allocateRegistrationNumber, readRegistrationNumberState } from '../src/infrastructure/sqlite/registration-numbering.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'

const mainMigrations = ['0069_registration-numbering.sql', '0070_doctor-recommendation-consolidation-stage.sql']
const inpatientMigrations = ['0069_inpatient-admission.sql', '0070_inpatient-orders.sql', '0071_inpatient-investigations-transfer.sql',
  '0072_inpatient-surgery.sql', '0073_inpatient-discharge.sql', '0074_inpatient-record.sql']
const modelUsageMigrations = ['0071_model-usage.sql', '0072_model-usage-control.sql', '0073_model-task-recovery.sql',
  '0074_host-model-waiting.sql', '0075_model-usage-dimensions.sql', '0076_model-usage-retention.sql', '0077_model-usage-token-breakdown.sql']
const paymentMigrations = ['0071_payment-installments.sql', '0072_payment-history-pagination.sql', '0075_payment-refunds.sql', '0075_refund-tenders.sql']
const directories: string[] = [], databases: ClinMeshDatabase[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true })))
})

async function legacy(kind: 'main' | 'inpatient') {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-main-upgrade-'))
  directories.push(directory)
  const migrations = join(directory, 'migrations')
  await mkdir(migrations)
  const pending = [...(kind === 'main' ? inpatientMigrations : mainMigrations), ...modelUsageMigrations, ...paymentMigrations].sort()
  const files = (await readdir('drizzle')).filter(file => file.endsWith('.sql') && !pending.includes(file))
  await Promise.all(files.map(file => copyFile(join('drizzle', file), join(migrations, file))))
  const database = openClinMeshDatabase({ databasePath: join(directory, 'legacy.sqlite'), busyTimeoutMs: 5000 })
  databases.push(database)
  expect(applyMigrations(database, migrations).schemaVersion).toBe(kind === 'main' ? 78 : 82)
  const scope = { workspaceId: 'workspace-upgrade', epoch: 'epoch-1', scenarioRunId: 'run-1' }
  new WorkspaceRepository(database).install({ ...scope, scenarioId: 'main-inpatient-upgrade', workspaceName: '合成迁移医院' })
  const actor: ActorContext = { ...scope, actorId: 'registrar', roleCode: 'registrar' }
  const fhir = new FhirRepository(database)
  fhir.create(actor, { resourceType: 'Patient', id: 'synthetic-upgrade-patient', name: [{ text: '合成迁移患者' }] })
  const commands = new CommandExecutor(database, fhir)
  const issue = (key: string, number?: string) => commands.execute({ context: actor, operation: 'registration.register', input: { key },
    idempotencyKey: key, expectedVersions: {}, dataSchema: z.object({ encounterId: z.string(), registrationNumber: z.string() }) }, transaction => {
    const registrationNumber = number ?? allocateRegistrationNumber(database, '2026-10-20')
    const encounter = transaction.fhir.create(actor, { resourceType: 'Encounter', id: `outpatient-${key}`, status: 'planned',
      actualPeriod: { start: '2026-10-20T09:00:00+08:00' }, subject: { reference: 'Patient/synthetic-upgrade-patient' },
      identifier: [{ system: 'https://caizongyuan.github.io/clinmesh/fhir/outpatient-encounter', value: registrationNumber }] })
    return { data: { encounterId: encounter.id, registrationNumber }, effects: [{ kind: 'created', reference: `Encounter/${encounter.id}`, versionId: '1' }] }
  })
  const receipt = issue('original', kind === 'inpatient' ? 'CM-OP-20261020-0017' : undefined)
  if (kind === 'inpatient') commands.execute({ context: actor, operation: 'inpatient.admission.register', input: {}, idempotencyKey: 'inpatient-original',
    expectedVersions: {}, dataSchema: z.object({ admissionId: z.string() }) }, transaction => {
    database.driver.prepare('INSERT INTO inpatient_ward VALUES (?, ?, ?, ?, ?)').run(scope.workspaceId, scope.epoch, 'ward-legacy', 'organization-legacy', '旧病区')
    database.driver.prepare(`INSERT INTO inpatient_admission(workspace_id,epoch,admission_id,patient_id,inpatient_number,admission_route,ward_id,organization_id,status,registered_at)
      VALUES(?,?,'inpatient-original','synthetic-upgrade-patient','ZY-legacy','direct','ward-legacy','organization-legacy','registered',?)`)
      .run(scope.workspaceId, scope.epoch, '2026-10-20T09:00:00+08:00')
    database.driver.prepare('INSERT INTO inpatient_deposit VALUES (?, ?, ?, ?, ?, ?)')
      .run(scope.workspaceId, scope.epoch, 'deposit-original', 'inpatient-original', 100000, '2026-10-20T09:00:00+08:00')
    const encounter = transaction.fhir.create(actor, { resourceType: 'Encounter', id: 'inpatient-original', status: 'planned',
      subject: { reference: 'Patient/synthetic-upgrade-patient' }, identifier: [{ system: 'urn:clinmesh:inpatient-number', value: 'ZY-legacy' }],
      class: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'IMP' }] }] })
    return { data: { admissionId: encounter.id }, effects: [{ kind: 'created', reference: `Encounter/${encounter.id}`, versionId: '1' }] }
  })
  return { database, migrations, pending, actor, commands, issue, receipt }
}

function snapshot(database: ClinMeshDatabase) {
  const tables = z.array(z.object({ name: z.string() })).parse(database.driver.prepare(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migration' ORDER BY name").all())
  return tables.map(({ name }) => ({ name, rows: database.driver.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all() }))
}

describe('main 发号库与住院库的完整迁移身份兼容', () => {
  it.each(['main', 'inpatient'] as const)('%s旧库升级至当前版本保留全部原事实、历史、receipt与已应用迁移，发号继续递增', async kind => {
    const s = await legacy(kind), before = snapshot(s.database)
    const migrations = s.database.driver.prepare('SELECT * FROM schema_migration ORDER BY migration_id').all()
    const state = kind === 'main' ? readRegistrationNumberState(s.database) : undefined
    expect(applyMigrations(s.database)).toEqual({ applied: s.pending, schemaVersion: expectedSchemaVersion() })
    expect(verifyMigrations(s.database).schemaVersion).toBe(expectedSchemaVersion())
    expect(s.database.driver.pragma('foreign_key_check')).toEqual([])
    for (const { name, rows } of before) expect(s.database.driver.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).toEqual(rows)
    expect(s.database.driver.prepare('SELECT * FROM schema_migration ORDER BY migration_id').all()).toEqual(expect.arrayContaining(migrations))
    if (state) expect(readRegistrationNumberState(s.database)).toEqual(state)
    else expect(readRegistrationNumberState(s.database).counters).toEqual([{ visitDate: '2026-10-20', highWater: 17 }])
    expect(s.issue('original', s.receipt.data.registrationNumber)).toEqual(s.receipt)
    expect(s.issue('next').data.registrationNumber).toBe(kind === 'main' ? 'CM-OP-20261020-000002' : 'CM-OP-20261020-000018')
    expect(applyMigrations(s.database)).toEqual({ applied: [], schemaVersion: expectedSchemaVersion() })
  })

  it.each(['main', 'inpatient'] as const)('%s旧库失败回滚并保留迁移身份与外键保护，修正后可完整升级', async kind => {
    const s = await legacy(kind), before = snapshot(s.database)
    const migration = s.pending[0]!, sql = await readFile(join('drizzle', migration), 'utf8')
    const migrationRows = s.database.driver.prepare('SELECT * FROM schema_migration ORDER BY migration_id').all()
    await writeFile(join(s.migrations, migration), `${sql}\nSELECT * FROM missing_inpatient_main_upgrade_table;\n`)
    expect(() => applyMigrations(s.database, s.migrations)).toThrow('missing_inpatient_main_upgrade_table')
    expect(s.database.diagnostics().foreignKeys).toBe(true)
    expect(snapshot(s.database)).toEqual(before)
    expect(s.database.driver.prepare('SELECT * FROM schema_migration ORDER BY migration_id').all()).toEqual(migrationRows)
    expect(applyMigrations(s.database).schemaVersion).toBe(expectedSchemaVersion())
  })
})
