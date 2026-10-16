import assert from 'node:assert/strict'
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { applyMigrations, openClinMeshDatabase } from '../../src/infrastructure/sqlite/database.ts'

// Keep HTTP-produced facts, but persist only columns that existed before 0061.
// The subsequent runtime startup must perform the real legacy schema upgrade.
export async function replaceWithPreSourceDatabase(databasePath: string): Promise<void> {
  const directory = dirname(databasePath)
  const migrationDirectory = join(directory, 'pre-source-migrations')
  await mkdir(migrationDirectory)
  const migrations = (await readdir(join(process.cwd(), 'drizzle'))).filter(file => /^\d{4}_.+\.sql$/u.test(file) && file < '0061_')
  await Promise.all(migrations.map(file => copyFile(join(process.cwd(), 'drizzle', file), join(migrationDirectory, file))))
  const legacyPath = join(directory, 'legacy.sqlite')
  const legacy = openClinMeshDatabase({ databasePath: legacyPath, busyTimeoutMs: 5_000 })
  try {
    assert.equal(applyMigrations(legacy, migrationDirectory).schemaVersion, 65)
    legacy.driver.pragma('foreign_keys = OFF')
    legacy.driver.prepare('ATTACH DATABASE ? AS captured').run(databasePath)
    const tables = legacy.driver.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%' AND name != 'schema_migration' ORDER BY name`).all() as Array<{ name: string }>
    legacy.driver.exec('BEGIN')
    for (const { name } of tables) {
      const quoted = `"${name.replaceAll('"', '""')}"`
      const columns = legacy.driver.pragma(`table_info(${quoted})`) as Array<{ name: string }>
      const list = columns.map(column => `"${column.name.replaceAll('"', '""')}"`).join(', ')
      const legacyRows = name === 'outbox_event' ? " WHERE kind != 'clinical-document.check-quality'" : ''
      legacy.driver.exec(`INSERT OR REPLACE INTO ${quoted} (${list}) SELECT ${list} FROM captured.${quoted}${legacyRows}`)
    }
    legacy.driver.exec('COMMIT')
    legacy.driver.exec('DETACH DATABASE captured')
    legacy.driver.pragma('foreign_keys = ON')
    assert.deepEqual(legacy.driver.pragma('foreign_key_check'), [])
    assert.equal(legacy.driver.prepare(`SELECT 1 FROM sqlite_schema WHERE name = 'consultation_recording_source'`).get(), undefined)
    assert.equal((legacy.driver.pragma('table_info(consultation_recording)') as Array<{ name: string }>)
      .some(column => column.name === 'actor_context_json'), false)
  } finally { legacy.close() }
  await copyFile(legacyPath, databasePath)
}
