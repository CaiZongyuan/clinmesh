import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { CommandExecutor, type ActorContext } from '../src/application/command-executor.ts'
import { RefundLedger } from '../src/application/refund-ledger.ts'
import { applyMigrations, openClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { FhirRepository } from '../src/infrastructure/sqlite/fhir-repository.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'

it('非空住院资金迁移适配旧退款，原入金、冻结账、归档JSON及原receipt完全保留且不重复发送', async () => {
  const directory = await mkdtemp(join(tmpdir(),'clinmesh-inpatient-funding-upgrade-'))
  const database = openClinMeshDatabase({databasePath:join(directory,'hospital.sqlite'),busyTimeoutMs:5000})
  try {
    const migrations = join(directory,'migrations'), target = '0076_inpatient-payments.sql'
    const files = (await readdir('drizzle')).filter(file=>file.endsWith('.sql')).sort()
    await mkdir(migrations)
    await Promise.all(files.filter(file=>file<target).map(file=>copyFile(join('drizzle',file),join(migrations,file))))
    applyMigrations(database,migrations)
    const scope = {workspaceId:'synthetic-upgrade',epoch:'epoch-1',scenarioRunId:'synthetic-run'}
    new WorkspaceRepository(database).install({...scope,scenarioId:'synthetic-inpatient-upgrade',workspaceName:'合成资金迁移医院'})
    const context: ActorContext = {...scope,actorId:'synthetic-cashier',roleCode:'cashier'}
    const commands = new CommandExecutor(database,new FhirRepository(database)), dataSchema = z.object({admissionId:z.string()})
    const config = {context,operation:'synthetic.legacy.settle',input:{admissionId:'legacy'},idempotencyKey:'synthetic-legacy-key',expectedVersions:{},dataSchema}
    const oldJson = JSON.stringify({immutable:'合成历史快照',transactions:[{id:'legacy-refund',amountFen:-6000}]})
    const original = commands.execute(config,()=> {
      database.driver.prepare('INSERT INTO inpatient_ward VALUES(?,?,?,?,?)').run(scope.workspaceId,scope.epoch,'ward','organization','合成历史病区')
      database.driver.prepare(`INSERT INTO inpatient_admission(workspace_id,epoch,admission_id,patient_id,inpatient_number,admission_route,ward_id,organization_id,status,financial_status,record_status,registered_at)
        VALUES(?,?,'legacy','synthetic-patient','ZY-legacy','direct','ward','organization','cleared','settled','archived','2026-10-01T00:00:00Z')`).run(scope.workspaceId,scope.epoch)
      database.driver.prepare('INSERT INTO inpatient_deposit VALUES(?,?,?,?,?,?)').run(scope.workspaceId,scope.epoch,'legacy-deposit','legacy',10000,'2026-10-01T00:00:00Z')
      database.driver.prepare('INSERT INTO inpatient_settlement VALUES(?,?,?,?,?,?)').run(scope.workspaceId,scope.epoch,'legacy-settlement','legacy',oldJson,'2026-10-02T00:00:00Z')
      database.driver.prepare('INSERT INTO inpatient_settlement_transaction VALUES(?,?,?,?,?,?,?,?,?)').run(scope.workspaceId,scope.epoch,'legacy-refund','legacy','legacy-settlement','refund',-6000,'legacy-deposit','2026-10-02T00:00:00Z')
      database.driver.prepare('INSERT INTO inpatient_record_revision VALUES(?,?,?,?,?,?,?,?,?,?)').run(scope.workspaceId,scope.epoch,'legacy',1,'original-hash',oldJson,'{}','doctor','doctor-role','2026-10-02T00:00:00Z')
      database.driver.prepare('INSERT INTO inpatient_record_review VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(scope.workspaceId,scope.epoch,'legacy','review',1,'original-hash','approved',null,'records','records-role','2026-10-02T00:00:00Z')
      database.driver.prepare(`INSERT INTO inpatient_record_archive
        (workspace_id,epoch,admission_id,archive_id,revision,review_id,sources_hash,snapshot_json,actor_id,practitioner_role_id,recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(scope.workspaceId,scope.epoch,'legacy','archive',1,'review','original-hash',oldJson,'records','records-role','2026-10-02T00:00:00Z')
      return {data:{admissionId:'legacy'},effects:[]}
    })
    const tables = ['inpatient_deposit','inpatient_settlement','inpatient_settlement_transaction','inpatient_record_revision','inpatient_record_review','inpatient_record_archive']
    const before = tables.map(table=> {
      const statement = database.driver.prepare(`SELECT * FROM ${table}`)
      return {table,columns:statement.columns().map(column=>column.name).join(','),rows:statement.all()}
    })
    expect(applyMigrations(database).applied).toEqual(files.filter(file=>file>=target))
    // Later migrations may add columns; every original column and row must remain unchanged.
    for (const {table,columns,rows} of before) expect(database.driver.prepare(`SELECT ${columns} FROM ${table}`).all()).toEqual(rows)
    const ledger = new RefundLedger(database)
    expect(ledger.balance(context,{kind:'inpatient-deposit',id:'legacy-deposit',amountFen:10000})).toMatchObject({refundedFen:6000,reservedFen:0,refundableFen:4000})
    expect(ledger.attempts(context,'inpatient','legacy')).toMatchObject([{refundId:'legacy-refund',sourceId:'legacy-deposit',amountFen:6000,outcome:'success'}])
    expect(database.driver.prepare('SELECT COUNT(*) AS count FROM inpatient_payment_attempt').get()).toEqual({count:0})
    expect(commands.execute(config,()=>{throw new Error('原receipt不应重执行')})).toEqual(original)
    expect(applyMigrations(database).applied).toEqual([])
    expect(database.driver.pragma('foreign_key_check')).toEqual([])
  } finally { database.close(); await rm(directory,{recursive:true}) }
})
