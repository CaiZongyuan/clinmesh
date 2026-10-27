import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyMigrations,
  canonicalStateHash,
  openClinMeshDatabase,
  type ClinMeshDatabase,
} from '../src/infrastructure/sqlite/database.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'

const migration = '0092_outpatient-investigation-billing.sql'
const pendingMigrations = [migration, '0093_outpatient-investigation-draft-price.sql',
  '0093_synthetic-inpatient-case-materialization.sql', '0094_authored-exact-investigation.sql', '0097_model-usage-task-dimensions.sql']
const scope = { workspaceId: 'synthetic-investigation-upgrade', epoch: 'epoch-1' }
const now = '2026-10-26T01:00:00.000Z'
const directories: string[] = []
const databases: ClinMeshDatabase[] = []

async function legacyDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-investigation-billing-upgrade-'))
  directories.push(directory)
  const migrations = join(directory, 'migrations')
  await mkdir(migrations)
  await Promise.all((await readdir('drizzle'))
    .filter(file => file.endsWith('.sql') && file < migration)
    .map(file => copyFile(join('drizzle', file), join(migrations, file))))
  const database = openClinMeshDatabase({ databasePath: join(directory, 'hospital.sqlite'), busyTimeoutMs: 5000 })
  databases.push(database)
  applyMigrations(database, migrations)
  new WorkspaceRepository(database).install({
    ...scope, scenarioId: 'synthetic-upgrade', scenarioRunId: 'synthetic-run', workspaceName: '合成检查收费迁移医院',
  })
  database.driver.prepare(`INSERT INTO scenario_definition(scenario_id,version,kind,schema_version)
    VALUES('synthetic-upgrade','1','candidate','1')`).run()
  database.driver.prepare(`INSERT INTO scenario_epoch_state
    (workspace_id,epoch,scenario_run_id,scenario_id,deterministic_seed,virtual_time,initial_state_hash)
    VALUES(?,?,'synthetic-run','synthetic-upgrade',1,?,?)`).run(scope.workspaceId, scope.epoch, now, '0'.repeat(64))
  database.driver.prepare(`INSERT INTO outpatient_catalog(workspace_id,epoch,item_id,kind,code,name_zh,name_en)
    VALUES(?,?,'department','department','general','合成科室','Synthetic department')`).run(scope.workspaceId, scope.epoch)
  database.driver.prepare(`INSERT INTO outpatient_case
    (workspace_id,epoch,case_id,scenario_run_id,patient_id,registration_id,encounter_id,account_id,
      department_id,location_id,initial_task_id,status,arrived_at,updated_at)
    VALUES(?,?,'case','synthetic-run','patient','registration','encounter','account',
      'department','location','initial-task','first-visit',?,?)`).run(scope.workspaceId, scope.epoch, now, now)
  database.driver.prepare(`INSERT INTO clinical_request_context
    (workspace_id,epoch,case_id,outpatient_case_id,patient_id,encounter_id)
    VALUES(?,?,'case','case','patient','encounter')`).run(scope.workspaceId, scope.epoch)
  insertCharge(database, 'original', 'laboratory')
  return database
}

function insertCharge(database: ClinMeshDatabase, id: string, category: string) {
  database.driver.prepare(`INSERT INTO charge_record
    (workspace_id,epoch,charge_id,case_id,account_id,charge_item_id,category,source_reference,
      description_zh,description_en,quantity,unit_price_fen,total_fen,status,version,created_at)
    VALUES(?,?,?,'case','account',?,?,?,'合成检查','Synthetic investigation',1,2500,2500,'billable',3,?)`)
    .run(scope.workspaceId, scope.epoch, `charge-${id}`, `item-${id}`, category, `ServiceRequest/${id}`, now)
}

function insertPreview(database: ClinMeshDatabase, id: string) {
  database.driver.prepare(`INSERT INTO payment_preview
    (workspace_id,epoch,preview_id,case_id,category,amount_fen,expected_charge_version,simulator_rule,
      token_hash,expires_at,consumed_at,tenders_json,actor_context_hash)
    VALUES(?,?,?,'case','laboratory',2500,3,'success','original-token',?,NULL,?,'original-actor-context')`)
    .run(scope.workspaceId, scope.epoch, id, now, JSON.stringify([{ method: 'cash', amountFen: 2500 }]))
}

function insertRequest(database: ClinMeshDatabase, id: string, kind: string, caseId = 'case') {
  database.driver.prepare(`INSERT INTO laboratory_request
    (workspace_id,epoch,request_id,case_id,request_kind,catalog_item_id,reference_json,indication_code,
      service_request_id,execution_task_id,status,version,authored_by,authored_at)
    VALUES(?,?,?,?,?,?,?,'clinical-assessment',?,?,'issued',1,'synthetic-doctor',?)`)
    .run(scope.workspaceId, scope.epoch, id, caseId, kind, `service-${id}`, '{}', `service-request-${id}`, `task-${id}`, now)
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true })))
})

describe('门诊独立检查收费迁移', () => {
  it('保留旧应收、精确预览、原收退款及三类免费申请，重启后不重复迁移', async () => {
    const database = await legacyDatabase()
    insertCharge(database, 'registration', 'registration')
    insertCharge(database, 'medication', 'medication')
    for (const kind of ['laboratory', 'imaging', 'pathology']) insertRequest(database, `legacy-${kind}`, kind)
    database.driver.prepare(`INSERT INTO inpatient_ward VALUES(?,?,'ward','organization','合成病区')`)
      .run(scope.workspaceId, scope.epoch)
    database.driver.prepare(`INSERT INTO inpatient_admission
      (workspace_id,epoch,admission_id,patient_id,inpatient_number,admission_route,ward_id,organization_id,status,registered_at)
      VALUES(?,?,'admission','inpatient','ZY-synthetic','direct','ward','organization','admitted',?)`)
      .run(scope.workspaceId, scope.epoch, now)
    database.driver.prepare(`INSERT INTO clinical_request_context
      (workspace_id,epoch,case_id,admission_id,patient_id,encounter_id)
      VALUES(?,?,'admission','admission','inpatient','inpatient-encounter')`).run(scope.workspaceId, scope.epoch)
    insertRequest(database, 'inpatient-request', 'laboratory', 'admission')
    for (const outcome of ['success', 'declined', 'ambiguous']) {
      insertPreview(database, `preview-${outcome}`)
      database.driver.prepare(`INSERT INTO payment_transaction
        (workspace_id,epoch,payment_id,case_id,category,amount_fen,outcome,correlation_id,preview_id,created_at,recovery_outcome)
        VALUES(?,?,?,'case','laboratory',2500,?,?,?,?, 'success')`)
        .run(scope.workspaceId, scope.epoch, `payment-${outcome}`, outcome, `correlation-${outcome}`, `preview-${outcome}`, now)
      database.driver.prepare('INSERT INTO payment_allocation VALUES(?,?,?,?,?)')
        .run(scope.workspaceId, scope.epoch, `payment-${outcome}`, 'item-original', 2500)
      database.driver.prepare('INSERT INTO payment_tender VALUES(?,?,?,?,?,?)')
        .run(scope.workspaceId, scope.epoch, `payment-${outcome}`, 'cash', 2500, 0)
    }
    insertPreview(database, 'unconsumed-preview')
    database.driver.prepare('INSERT INTO payment_resolution VALUES(?,?,?,?,?)')
      .run(scope.workspaceId, scope.epoch, 'payment-ambiguous', 'success', now)
    database.driver.prepare('INSERT INTO financial_charge_adjustment VALUES(?,?,?,?,?,?,?,?)')
      .run(scope.workspaceId, scope.epoch, 'adjustment', 'item-original', 500, '合成历史费用更正', 'not-started', now)
    database.driver.prepare(`INSERT INTO refund_transaction VALUES(?,?,'refund','outpatient-payment',
      'payment-success','outpatient-charge:item-original','outpatient','case',500,'ambiguous','success','refund-correlation',?)`)
      .run(scope.workspaceId, scope.epoch, now)
    database.driver.prepare('INSERT INTO refund_tender VALUES(?,?,?,?,?,?)')
      .run(scope.workspaceId, scope.epoch, 'refund', 'cash', 500, 0)
    database.driver.prepare('INSERT INTO refund_preview VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(scope.workspaceId, scope.epoch, 'refund-preview', 'payment-success', 500, 1, 3,
        'ambiguous-success', 'original-actor-context', 'original-refund-token', now, null)

    const preservedTables = ['charge_record', 'payment_transaction', 'payment_allocation', 'payment_tender',
      'payment_resolution', 'financial_charge_adjustment', 'refund_transaction', 'refund_tender', 'refund_preview',
      'laboratory_request', 'clinical_request_context']
    const before = preservedTables.map(table => database.driver.prepare(`SELECT * FROM ${table}`).all())
    const previews = database.driver.prepare<[], Record<string, unknown>>('SELECT * FROM payment_preview ORDER BY preview_id').all()
    expect(applyMigrations(database).applied).toEqual(pendingMigrations)
    for (const [index, table] of preservedTables.entries()) {
      expect(database.driver.prepare(`SELECT * FROM ${table}`).all()).toEqual(before[index])
    }
    expect(database.driver.prepare('SELECT * FROM payment_preview ORDER BY preview_id').all())
      .toEqual(previews.map(row => ({ ...row, charge_item_id: 'item-original' })))
    expect(database.driver.prepare(`SELECT request_id,case_id,payment_policy,charge_item_id,price_json,released_at,release_json
      FROM outpatient_investigation_billing ORDER BY request_id`).all()).toEqual([
      { request_id: 'legacy-imaging', case_id: 'case', payment_policy: 'legacy-unbilled', charge_item_id: null, price_json: null, released_at: null, release_json: null },
      { request_id: 'legacy-laboratory', case_id: 'case', payment_policy: 'legacy-unbilled', charge_item_id: null, price_json: null, released_at: null, release_json: null },
      { request_id: 'legacy-pathology', case_id: 'case', payment_policy: 'legacy-unbilled', charge_item_id: null, price_json: null, released_at: null, release_json: null },
    ])
    expect(database.driver.pragma('foreign_key_check')).toEqual([])
    expect(database.diagnostics().foreignKeys).toBe(true)
    const upgradedHash = canonicalStateHash(database)
    const databasePath = database.driver.name
    database.close()
    databases.splice(databases.indexOf(database), 1)
    const reopened = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5000 })
    databases.push(reopened)
    expect(applyMigrations(reopened).applied).toEqual([])
    expect(canonicalStateHash(reopened)).toBe(upgradedHash)
    expect(reopened.driver.pragma('foreign_key_check')).toEqual([])
  })

  it('同次多项同类费用存在时，旧已付款预览使用原资金分配确定费用目标', async () => {
    const database = await legacyDatabase()
    insertCharge(database, 'second', 'laboratory')
    insertPreview(database, 'consumed-preview')
    database.driver.prepare("UPDATE payment_preview SET consumed_at=? WHERE preview_id='consumed-preview'").run(now)
    database.driver.prepare(`INSERT INTO payment_transaction
      (workspace_id,epoch,payment_id,case_id,category,amount_fen,outcome,correlation_id,preview_id,created_at)
      VALUES(?,?,'original-payment','case','laboratory',2500,'success','original-correlation','consumed-preview',?)`)
      .run(scope.workspaceId, scope.epoch, now)
    database.driver.prepare('INSERT INTO payment_allocation VALUES(?,?,?,?,?)')
      .run(scope.workspaceId, scope.epoch, 'original-payment', 'item-second', 2500)

    expect(applyMigrations(database).applied).toEqual(pendingMigrations)

    expect(database.driver.prepare("SELECT charge_item_id FROM payment_preview WHERE preview_id='consumed-preview'").get())
      .toEqual({ charge_item_id: 'item-second' })
    expect(database.driver.prepare('SELECT charge_item_id FROM payment_allocation').get()).toEqual({ charge_item_id: 'item-second' })
    expect(database.driver.pragma('foreign_key_check')).toEqual([])
  })

  it.each(['missing', 'ambiguous'] as const)('旧预览费用目标%s时拒绝迁移，完整回滚并恢复外键保护', async matching => {
    const database = await legacyDatabase()
    insertPreview(database, 'preview-invalid')
    if (matching === 'missing') database.driver.prepare("DELETE FROM charge_record WHERE charge_item_id='item-original'").run()
    else insertCharge(database, 'second', 'laboratory')
    const previousVersion = database.diagnostics().schemaVersion
    const previousHash = canonicalStateHash(database)
    const previousPreviews = database.driver.prepare('SELECT * FROM payment_preview').all()

    expect(() => applyMigrations(database)).toThrow()

    expect(database.diagnostics()).toMatchObject({ schemaVersion: previousVersion, foreignKeys: true })
    expect(canonicalStateHash(database)).toBe(previousHash)
    expect(database.driver.prepare('SELECT * FROM payment_preview').all()).toEqual(previousPreviews)
    expect(database.driver.prepare("SELECT name FROM sqlite_schema WHERE name='outpatient_investigation_billing'").get()).toBeUndefined()
    expect(database.driver.pragma('foreign_key_check')).toEqual([])
  })

  it('新增放射和病理应收支持精确预览，预付策略及放行快照保持受约束的原申请关联', async () => {
    const database = await legacyDatabase()
    applyMigrations(database)
    for (const category of ['imaging', 'pathology']) {
      insertCharge(database, category, category)
      insertRequest(database, `request-${category}`, category)
      database.driver.prepare(`INSERT INTO payment_preview
        (workspace_id,epoch,preview_id,case_id,category,amount_fen,expected_charge_version,simulator_rule,
          token_hash,expires_at,charge_item_id)
        VALUES(?,?,?,'case',?,2500,3,'success','synthetic-token',?,?)`)
        .run(scope.workspaceId, scope.epoch, `new-preview-${category}`, category, now, `item-${category}`)
      database.driver.prepare(`INSERT INTO payment_transaction
        (workspace_id,epoch,payment_id,case_id,category,amount_fen,outcome,correlation_id,preview_id,created_at)
        VALUES(?,?,?,'case',?,2500,'success',?,?,?)`)
        .run(scope.workspaceId, scope.epoch, `new-payment-${category}`, category, `new-correlation-${category}`, `new-preview-${category}`, now)
      database.driver.prepare(`INSERT INTO outpatient_investigation_billing
        (workspace_id,epoch,request_id,case_id,payment_policy,charge_item_id,price_json)
        VALUES(?,?,?,'case','prepaid-v1',?,'{"id":"synthetic-price","priceFen":2500}')`)
        .run(scope.workspaceId, scope.epoch, `request-${category}`, `item-${category}`)
    }
    expect(database.driver.prepare('SELECT category,charge_item_id FROM payment_preview ORDER BY category').all()).toEqual([
      { category: 'imaging', charge_item_id: 'item-imaging' },
      { category: 'pathology', charge_item_id: 'item-pathology' },
    ])
    expect(() => database.driver.prepare(`UPDATE outpatient_investigation_billing
      SET payment_policy='legacy-unbilled' WHERE request_id='request-imaging'`).run()).toThrow()
    expect(() => database.driver.prepare(`UPDATE outpatient_investigation_billing
      SET price_json=NULL WHERE request_id='request-imaging'`).run()).toThrow()
    expect(() => database.driver.prepare(`UPDATE outpatient_investigation_billing
      SET charge_item_id='item-pathology' WHERE request_id='request-imaging'`).run()).toThrow()
    expect(() => database.driver.prepare(`UPDATE outpatient_investigation_billing
      SET request_id='nonexistent' WHERE request_id='request-imaging'`).run()).toThrow()
    expect(() => database.driver.prepare(`UPDATE outpatient_investigation_billing
      SET released_at=? WHERE request_id='request-imaging'`).run(now)).toThrow()
    database.driver.prepare(`UPDATE outpatient_investigation_billing SET released_at=?,release_json='{"paidFen":2500}'
      WHERE request_id='request-imaging'`).run(now)
    expect(() => database.driver.prepare(`UPDATE payment_preview SET charge_item_id='nonexistent'
      WHERE preview_id='new-preview-imaging'`).run()).toThrow()
    expect(database.driver.pragma('foreign_key_check')).toEqual([])
  })
})
