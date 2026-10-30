import assert from 'node:assert/strict'
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { applyMigrations, openClinMeshDatabase } from '../../src/infrastructure/sqlite/database.ts'
import { isRetiredCapturedPaymentTable } from './historical-payment-schema.ts'

const legacyPractitionerRoles = "role_code IN ('registrar', 'triage-nurse', 'outpatient-doctor', 'cashier', 'pharmacist', 'administrator')"

// 旧版本不包含住院环境、岗位及其成员、会话关联。
export function preInpatientRows(table: string): string {
  if (table === 'practitioner_role_binding') return ` WHERE ${legacyPractitionerRoles}`
  if (table === 'membership_practitioner_role') return ` WHERE (workspace_id, practitioner_role_id) IN (
    SELECT workspace_id, practitioner_role_id FROM captured.practitioner_role_binding WHERE ${legacyPractitionerRoles})`
  if (table === 'auth_session_context') return ` WHERE (membership_id, practitioner_role_id) IN (
    SELECT membership_id, practitioner_role_id FROM captured.membership_practitioner_role
    WHERE (workspace_id, practitioner_role_id) IN (
      SELECT workspace_id, practitioner_role_id FROM captured.practitioner_role_binding WHERE ${legacyPractitionerRoles}))`
  if (['fhir_resource', 'fhir_history', 'fhir_sp_string'].includes(table)) return ` WHERE (resource_type, resource_id) NOT IN (
    SELECT 'Organization', organization_id FROM captured.inpatient_ward
    UNION SELECT 'Location', ward_id FROM captured.inpatient_ward
    UNION SELECT 'Location', room_id FROM captured.inpatient_bed
    UNION SELECT 'Location', bed_id FROM captured.inpatient_bed
    UNION SELECT 'Practitioner', practitioner_id FROM captured.practitioner_role_binding WHERE NOT (${legacyPractitionerRoles})
    UNION SELECT 'PractitionerRole', practitioner_role_id FROM captured.practitioner_role_binding WHERE NOT (${legacyPractitionerRoles})
    UNION SELECT 'Location', location_id FROM captured.practitioner_role_binding WHERE NOT (${legacyPractitionerRoles}))`
  return ''
}

// Keep HTTP-produced facts, but persist only columns that existed before 0061.
// The subsequent runtime startup must perform the real legacy schema upgrade.
export async function replaceWithPreSourceDatabase(databasePath: string): Promise<void> {
  return replaceWithRecordingDatabase(databasePath, 'pre-source')
}

export async function replaceWithRecordingBranchDatabase(databasePath: string, branch: 'main' | 'fields' | 'incremental' | 'quality'): Promise<void> {
  return replaceWithRecordingDatabase(databasePath, branch)
}

async function replaceWithRecordingDatabase(databasePath: string, branch: 'pre-source' | 'main' | 'fields' | 'incremental' | 'quality'): Promise<void> {
  const directory = dirname(databasePath)
  const migrationDirectory = join(directory, 'pre-source-migrations')
  await mkdir(migrationDirectory)
  const migrations = (await readdir(join(process.cwd(), 'drizzle'))).filter(file => {
    if (branch === 'incremental' || branch === 'quality') return /^\d{4}_.+\.sql$/u.test(file)
      && file < '0065_'
      && file !== (branch === 'incremental' ? '0064_clinical-document-quality.sql' : '0064_incremental-recording.sql')
    if (!/^\d{4}_.+\.sql$/u.test(file) || file === '0060_z-recording-branch-staging.sql') return false
    if (file < '0061_') return true
    if (branch === 'main') return file === '0061_consultation-recording-sources.sql'
    return branch === 'fields' && ['0061_clinical-document-history-fields.sql', '0062_consultation-direct-recording.sql'].includes(file)
  })
  await Promise.all(migrations.map(file => copyFile(join(process.cwd(), 'drizzle', file), join(migrationDirectory, file))))
  const legacyPath = join(directory, 'legacy.sqlite')
  const legacy = openClinMeshDatabase({ databasePath: legacyPath, busyTimeoutMs: 5_000 })
  try {
    assert.equal(applyMigrations(legacy, migrationDirectory).schemaVersion,
      branch === 'pre-source' ? 65 : branch === 'main' ? 66 : branch === 'fields' ? 67 : 71)
    legacy.driver.pragma('foreign_keys = OFF')
    legacy.driver.prepare('ATTACH DATABASE ? AS captured').run(databasePath)
    const tables = legacy.driver.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%' AND name != 'schema_migration' ORDER BY name`).all() as Array<{ name: string }>
    legacy.driver.exec('BEGIN')
    for (const { name } of tables) {
      if (isRetiredCapturedPaymentTable(legacy, name)) continue
      const quoted = `"${name.replaceAll('"', '""')}"`
      const columns = legacy.driver.pragma(`table_info(${quoted})`) as Array<{ name: string }>
      const list = columns.map(column => `"${column.name.replaceAll('"', '""')}"`).join(', ')
      const legacyRows = name === 'outbox_event' ? ` WHERE kind NOT IN (${branch === 'quality'
        ? "'consultation.verify-history'" : branch === 'incremental'
          ? "'clinical-document.check-quality'" : "'clinical-document.check-quality', 'consultation.verify-history'"})` : preInpatientRows(name)
      legacy.driver.exec(`INSERT OR REPLACE INTO ${quoted} (${list}) SELECT ${list} FROM captured.${quoted}${legacyRows}`)
    }
    legacy.driver.exec('COMMIT')
    legacy.driver.exec('DETACH DATABASE captured')
    legacy.driver.pragma('foreign_keys = ON')
    assert.deepEqual(legacy.driver.pragma('foreign_key_check'), [])
    const hasSources = branch === 'main' || branch === 'incremental' || branch === 'quality'
    assert.equal(legacy.driver.prepare(`SELECT 1 FROM sqlite_schema WHERE name = 'consultation_recording_source'`).get() !== undefined, hasSources)
    assert.equal((legacy.driver.pragma('table_info(consultation_recording)') as Array<{ name: string }>)
      .some(column => column.name === 'actor_context_json'), hasSources)
  } finally { legacy.close() }
  await copyFile(legacyPath, databasePath)
}
