import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { applyMigrations, openClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'

it('旧库岗位迁移保留所有引用，迁移失败回滚并恢复外键保护', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-migration-'))
  const database = openClinMeshDatabase({ databasePath: join(directory, 'old.sqlite'), busyTimeoutMs: 100 })
  const source = new URL('../drizzle/', import.meta.url)
  const migration = '0069_inpatient-admission.sql'
  try {
    for (const file of (await readdir(source)).filter(file => file.endsWith('.sql') && file < migration)) {
      await copyFile(new URL(file, source), join(directory, file))
    }
    applyMigrations(database, directory)
    database.driver.exec(`
      INSERT INTO workspace VALUES ('hospital', '合成医院', NULL, 1, '2026-01-01');
      INSERT INTO user VALUES ('user', '合成人员', 'synthetic@example.local', 1, NULL, 0, 0);
      INSERT INTO workspace_membership VALUES ('member', 'hospital', 'user', 'actor', 'active', '2026-01-01');
      INSERT INTO practitioner_role_binding VALUES ('hospital', 'role', 'practitioner', 'registrar', 'organization', 'location', 1);
      INSERT INTO membership_practitioner_role VALUES ('member', 'hospital', 'role');
      INSERT INTO session VALUES ('session', 9999999999999, 'synthetic-token', 0, 0, NULL, NULL, 'user');
      INSERT INTO auth_session_context VALUES ('session', 'member', 'role', '2026-01-01');
    `)
    const sql = await readFile(new URL(migration, source), 'utf8')
    await writeFile(join(directory, migration), `${sql}\nSELECT * FROM missing_table;\n`)
    expect(() => applyMigrations(database, directory)).toThrow('missing_table')
    expect(database.diagnostics().foreignKeys).toBe(true)
    expect(database.driver.prepare('SELECT practitioner_role_id FROM auth_session_context').get()).toEqual({ practitioner_role_id: 'role' })
    await writeFile(join(directory, migration), sql)
    expect(applyMigrations(database, directory).applied).toEqual([migration])
    expect(database.driver.pragma('foreign_key_check')).toEqual([])
    expect(database.driver.prepare('SELECT * FROM practitioner_role_binding').get()).toMatchObject({ role_code: 'registrar', organization_id: 'organization' })
    expect(database.driver.prepare('SELECT practitioner_role_id FROM membership_practitioner_role').get()).toEqual({ practitioner_role_id: 'role' })
    expect(database.driver.prepare('SELECT practitioner_role_id FROM auth_session_context').get()).toEqual({ practitioner_role_id: 'role' })
    expect(() => database.driver.prepare('DELETE FROM practitioner_role_binding WHERE practitioner_role_id=?').run('role')).toThrow('FOREIGN KEY')
    database.driver.exec('BEGIN IMMEDIATE')
    expect(() => applyMigrations(database, directory)).toThrow('without an active transaction')
    expect(database.driver.inTransaction).toBe(true)
    database.driver.exec('ROLLBACK')
  } finally {
    database.close()
    await rm(directory, { recursive: true })
  }
})
