import { afterEach, expect, it } from 'vitest'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, openClinMeshDatabase, type ClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'

const migration = '0107_inpatient-independent-review.sql'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const tables = ['inpatient_drg_review_revision', 'inpatient_drg_review', 'inpatient_drg_review_todo', 'inpatient_drg_review_action']
function rows(database: ClinMeshDatabase) {
  return tables.map(table => database.driver.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
}
async function legacy() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-independent-review-upgrade-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const database = openClinMeshDatabase({ databasePath: join(directory, 'hospital.sqlite'), busyTimeoutMs: 5000 })
  cleanups.push(async () => { database.close() })
  database.driver.exec(`CREATE TABLE inpatient_admission (workspace_id TEXT,epoch TEXT,admission_id TEXT,
    PRIMARY KEY(workspace_id,epoch,admission_id)) STRICT;`)
  database.driver.exec(await readFile('drizzle/0096_inpatient-drg-followup.sql', 'utf8'))
  database.driver.exec(await readFile('drizzle/0100_inpatient-drg-review.sql', 'utf8'))
  database.driver.prepare('INSERT INTO inpatient_admission VALUES(?,?,?)').run('w', 'e', 'a')
  database.driver.prepare(`INSERT INTO inpatient_drg_followup
    (workspace_id,epoch,task_id,admission_id,context_json,status,started_at,updated_at)
    VALUES('w','e','followup','a','{"actorId":"original-doctor"}','stopped','before','before')`).run()
  database.driver.prepare(`INSERT INTO inpatient_drg_review_revision VALUES('w','e','revision','followup','a','original-fingerprint','{"marker":"original-snapshot"}','before')`).run()
  database.driver.prepare(`INSERT INTO inpatient_drg_review VALUES('w','e','a','followup',7,3,'revision','{"note":"original-handoff"}')`).run()
  database.driver.prepare(`INSERT INTO inpatient_drg_review_todo VALUES('w','e','todo','followup','a','issue','original-evidence','{"marker":"original-issue"}','in-progress',9,'original-note')`).run()
  database.driver.prepare(`INSERT INTO inpatient_drg_review_action VALUES('w','e','action','a','todo','in-progress','original-note','original-doctor','inpatient-doctor','before','original-evidence')`).run()
  const migrations = join(directory, 'migrations')
  await mkdir(migrations)
  await copyFile(join('drizzle', migration), join(migrations, migration))
  return { directory, database, migrations }
}

it('旧核查、待办状态、处置和交接逐字段保留，无跟进住院可生成核查且跨住院引用仍拒绝', async () => {
  const s = await legacy(), before = rows(s.database)
  expect(applyMigrations(s.database, s.migrations).applied).toEqual([migration])
  expect(rows(s.database)).toEqual(before)
  expect(s.database.driver.prepare('SELECT context_json FROM inpatient_drg_followup').get()).toEqual({ context_json: '{"actorId":"original-doctor"}' })
  s.database.driver.prepare('INSERT INTO inpatient_admission VALUES(?,?,?)').run('w', 'e', 'new-admission')
  s.database.driver.prepare(`INSERT INTO inpatient_drg_review_revision VALUES('w','e','new-revision','automatic','new-admission','new-fingerprint','{}','now')`).run()
  s.database.driver.prepare(`INSERT INTO inpatient_drg_review VALUES('w','e','new-admission','automatic',1,1,'new-revision',NULL)`).run()
  s.database.driver.prepare(`INSERT INTO inpatient_drg_review_todo VALUES('w','e','new-todo','automatic','new-admission','new-issue','new-evidence','{}','pending',1,NULL)`).run()
  expect(() => s.database.driver.prepare(`INSERT INTO inpatient_drg_review_action VALUES('w','e','cross-admission','a','new-todo','dismiss','wrong admission','actor','cashier','now','evidence')`).run()).toThrow(/FOREIGN KEY/)
  expect(s.database.driver.pragma('foreign_key_check')).toEqual([])
  expect(applyMigrations(s.database, s.migrations).applied).toEqual([])
})

it('升级失败原子恢复原核查和跟进外键，不留下半迁移表', async () => {
  const s = await legacy(), before = rows(s.database)
  const sql = await readFile(join(s.migrations, migration), 'utf8')
  await writeFile(join(s.migrations, migration), `${sql}\nSELECT * FROM missing_independent_review_upgrade;\n`)
  expect(() => applyMigrations(s.database, s.migrations)).toThrow('missing_independent_review_upgrade')
  expect(rows(s.database)).toEqual(before)
  expect(s.database.driver.prepare("SELECT name FROM sqlite_temp_schema WHERE name LIKE 'retained_drg_review%'").all()).toEqual([])
  expect(s.database.driver.pragma('foreign_key_check')).toEqual([])
  expect(s.database.diagnostics().foreignKeys).toBe(true)
  await writeFile(join(s.migrations, migration), sql)
  expect(applyMigrations(s.database, s.migrations).applied).toEqual([migration])
  expect(rows(s.database)).toEqual(before)
})
