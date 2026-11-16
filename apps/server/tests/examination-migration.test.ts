import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { applyMigrations, openClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'

it('功能检查重建迁移保留旧费用、精确预览和收费归属并允许 examination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-examination-migration-'))
  const database = openClinMeshDatabase({ databasePath: join(directory, 'hospital.sqlite'), busyTimeoutMs: 5000 })
  const migration = '0113_functional-examination.sql'
  try {
    const migrations = join(directory, 'migrations')
    await mkdir(migrations)
    await Promise.all(
      (await readdir('drizzle'))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .map((file) => copyFile(join('drizzle', file), join(migrations, file))),
    )
    applyMigrations(database, migrations)
    const scope = { workspaceId: 'synthetic-upgrade', epoch: 'epoch-1', scenarioRunId: 'run' },
      now = '2026-11-10T00:00:00.000Z'
    new WorkspaceRepository(database).install({
      ...scope,
      scenarioId: 'synthetic-upgrade',
      workspaceName: '合成功能检查迁移',
    })
    database.driver
      .prepare(
        "INSERT INTO scenario_definition(scenario_id,version,kind,schema_version) VALUES('synthetic-upgrade','1','candidate','1')",
      )
      .run()
    database.driver
      .prepare(
        "INSERT INTO scenario_epoch_state(workspace_id,epoch,scenario_run_id,scenario_id,deterministic_seed,virtual_time,initial_state_hash) VALUES(?,?,'run','synthetic-upgrade',1,?,?)",
      )
      .run(scope.workspaceId, scope.epoch, now, '0'.repeat(64))
    database.driver
      .prepare(
        "INSERT INTO outpatient_catalog(workspace_id,epoch,item_id,kind,code,name_zh,name_en) VALUES(?,?,'department','department','general','合成科室','Synthetic department')",
      )
      .run(scope.workspaceId, scope.epoch)
    database.driver
      .prepare(
        `INSERT INTO outpatient_case(workspace_id,epoch,case_id,scenario_run_id,patient_id,registration_id,encounter_id,account_id,department_id,location_id,initial_task_id,status,arrived_at,updated_at)
      VALUES(?,?,'case','run','patient','registration','encounter','account','department','location','task','first-visit',?,?)`,
      )
      .run(scope.workspaceId, scope.epoch, now, now)
    database.driver
      .prepare(
        `INSERT INTO charge_record(workspace_id,epoch,charge_id,case_id,account_id,charge_item_id,category,source_reference,description_zh,description_en,quantity,unit_price_fen,total_fen,status,version,created_at)
      VALUES(?,?,'charge','case','account','item','laboratory','ServiceRequest/original','合成检验','Synthetic laboratory',1,100,100,'billable',3,?)`,
      )
      .run(scope.workspaceId, scope.epoch, now)
    database.driver
      .prepare(
        `INSERT INTO payment_preview(workspace_id,epoch,preview_id,case_id,category,amount_fen,expected_charge_version,simulator_rule,token_hash,expires_at,consumed_at,tenders_json,actor_context_hash,charge_item_id)
      VALUES(?,?,'preview','case','laboratory',100,3,'success','synthetic-token',?,NULL,'[{"method":"cash","amountFen":100}]','synthetic-actor','item')`,
      )
      .run(scope.workspaceId, scope.epoch, now)
    const charges = database.driver.prepare('SELECT * FROM charge_record').all(),
      previews = database.driver.prepare('SELECT * FROM payment_preview').all()
    expect(applyMigrations(database).applied).toEqual([migration, '0114_outpatient-follow-up-source.sql'])
    expect(database.driver.prepare('SELECT * FROM charge_record').all()).toEqual(charges)
    expect(database.driver.prepare('SELECT * FROM payment_preview').all()).toEqual(previews)
    database.driver.prepare("UPDATE charge_record SET category='examination' WHERE charge_id='charge'").run()
    database.driver.prepare("UPDATE payment_preview SET category='examination' WHERE preview_id='preview'").run()
    expect(database.driver.pragma('foreign_key_check')).toEqual([])
    expect(applyMigrations(database).applied).toEqual([])
  } finally {
    database.close()
    await rm(directory, { recursive: true })
  }
})
