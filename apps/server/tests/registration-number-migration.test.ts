import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CommandExecutor, type ActorContext } from '../src/application/command-executor.ts'
import { applyMigrations, openClinMeshDatabase, type ClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { FhirRepository } from '../src/infrastructure/sqlite/fhir-repository.ts'
import { readRegistrationNumberState } from '../src/infrastructure/sqlite/registration-numbering.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'

const migration = '0069_registration-numbering.sql'
const numberSystem = 'https://caizongyuan.github.io/clinmesh/fhir/outpatient-encounter'
const directories: string[] = []
const databases: ClinMeshDatabase[] = []

async function legacyDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-number-migration-'))
  directories.push(directory)
  const migrations = join(directory, 'legacy-migrations')
  await mkdir(migrations)
  const files = (await readdir('drizzle')).filter(file => file.endsWith('.sql') && file !== migration)
  await Promise.all(files.map(file => copyFile(join('drizzle', file), join(migrations, file))))
  const database = openClinMeshDatabase({ databasePath: join(directory, 'legacy.sqlite'), busyTimeoutMs: 5000 })
  databases.push(database)
  applyMigrations(database, migrations)
  return database
}

function context(database: ClinMeshDatabase, workspaceId: string): ActorContext {
  const scope = { workspaceId, epoch: 'epoch-1', scenarioRunId: 'run-1' }
  new WorkspaceRepository(database).install({ ...scope, scenarioId: 'number-migration', workspaceName: 'Synthetic numbering migration' })
  return { ...scope, actorId: 'registrar', roleCode: 'registrar' }
}

function issue(database: ClinMeshDatabase, actor: ActorContext, suffix: string, visitDate = '2026-10-20') {
  const fhir = new FhirRepository(database)
  return new CommandExecutor(database, fhir).execute({
    context: actor, dataSchema: z.object({ encounterId: z.string() }), expectedVersions: {},
    idempotencyKey: suffix, input: {}, operation: 'registration.register',
  }, transaction => {
    const encounter = transaction.fhir.create(actor, {
      resourceType: 'Encounter', id: `encounter-${suffix}`, status: 'planned',
      actualPeriod: { start: `${visitDate}T09:00:00+08:00` },
      identifier: [{ system: numberSystem, value: `CM-OP-${visitDate.replaceAll('-', '')}-${suffix}` }],
    })
    return { data: { encounterId: encounter.id }, effects: [{ kind: 'created', reference: `Encounter/${encounter.id}`, versionId: '1' }] }
  })
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true })))
})

describe('registration numbering history migration', () => {
  it('initializes all dates from complete audited issuance across scopes and preserves legacy duplicates', async () => {
    const database = await legacyDatabase()
    const first = context(database, 'workspace-1')
    const second = context(database, 'workspace-2')
    issue(database, first, '0007')
    issue(database, second, '0007')
    issue(database, first, '0013', '2026-10-21')
    const original = database.driver.prepare("SELECT content_json FROM fhir_history WHERE resource_type = 'Encounter' ORDER BY workspace_id, epoch, resource_id").all()

    expect(applyMigrations(database).applied).toEqual([migration])
    expect(readRegistrationNumberState(database).counters).toEqual([
      { visitDate: '2026-10-20', highWater: 7 }, { visitDate: '2026-10-21', highWater: 13 },
    ])
    expect(database.driver.prepare("SELECT content_json FROM fhir_history WHERE resource_type = 'Encounter' ORDER BY workspace_id, epoch, resource_id").all()).toEqual(original)
    expect(applyMigrations(database).applied).toEqual([])
  })

  it('uses preserved initial history even when current Encounter and business rows are absent', async () => {
    const database = await legacyDatabase()
    const actor = context(database, 'workspace-1')
    issue(database, actor, '0019')
    database.driver.prepare("DELETE FROM fhir_resource WHERE resource_type = 'Encounter'").run()

    applyMigrations(database)
    expect(readRegistrationNumberState(database).counters).toEqual([{ visitDate: '2026-10-20', highWater: 19 }])
  })

  it.each(['missing-encounter', 'missing-audit', 'unknown-encounter', 'reset'] as const)(
    'rejects unproven %s history atomically without modifying existing facts', async (failure) => {
      const database = await legacyDatabase()
      const actor = context(database, 'workspace-1')
      issue(database, actor, '0023')
      if (failure === 'missing-encounter') database.driver.prepare("DELETE FROM fhir_history WHERE resource_type = 'Encounter'").run()
      if (failure === 'missing-audit') database.driver.prepare('DELETE FROM audit_log').run()
      if (failure === 'unknown-encounter') new FhirRepository(database).create(actor, {
        resourceType: 'Encounter', id: 'unknown-encounter', status: 'planned',
        identifier: [{ system: numberSystem, value: 'CM-OP-20261020-9999' }],
      })
      if (failure === 'reset') new CommandExecutor(database, new FhirRepository(database)).execute({
        context: actor, dataSchema: z.object({}), expectedVersions: {}, idempotencyKey: 'reset', input: {}, operation: 'scenario.reset',
      }, () => ({ data: {}, effects: [] }))
      const history = database.driver.prepare('SELECT * FROM fhir_history ORDER BY resource_type, resource_id, version_id').all()

      expect(() => applyMigrations(database)).toThrow('Registration numbering history cannot be proven complete')
      expect(database.driver.prepare('SELECT 1 FROM schema_migration WHERE migration_id = ?').get(migration)).toBeUndefined()
      expect(database.driver.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'registration_number_authority'").get()).toBeUndefined()
      expect(database.driver.prepare('SELECT * FROM fhir_history ORDER BY resource_type, resource_id, version_id').all()).toEqual(history)
    },
  )
})
