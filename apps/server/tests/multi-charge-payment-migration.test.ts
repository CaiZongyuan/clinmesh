import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { CommandExecutor } from '../src/application/command-executor.ts'
import { PaymentCollection } from '../src/application/payment-collection.ts'
import { PaymentLedger } from '../src/application/payment-ledger.ts'
import { applyMigrations, openClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { FhirRepository } from '../src/infrastructure/sqlite/fhir-repository.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'

it('0111非空升级保留原款、零金额分配、旧退款预览和回执并约束完整分配归属', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-multi-charge-upgrade-'))
  const database = openClinMeshDatabase({ databasePath: join(directory, 'hospital.sqlite'), busyTimeoutMs: 5000 })
  const migration = '0111_multi-charge-payment-collection.sql'
  try {
    const migrations = join(directory, 'migrations')
    await mkdir(migrations)
    await Promise.all((await readdir('drizzle')).filter(file => file.endsWith('.sql') && file < migration)
      .map(file => copyFile(join('drizzle', file), join(migrations, file))))
    applyMigrations(database, migrations)
    const context = { workspaceId: 'synthetic-upgrade', epoch: 'epoch-1', scenarioRunId: 'run', actorId: 'cashier', roleCode: 'cashier' }
    const now = '2026-11-10T00:00:00.000Z'
    new WorkspaceRepository(database).install({ ...context, scenarioId: 'synthetic-upgrade', workspaceName: '合成多费用升级' })
    database.driver.prepare(`INSERT INTO scenario_definition(scenario_id,version,kind,schema_version) VALUES ('synthetic-upgrade','1','candidate','1')`).run()
    database.driver.prepare(`INSERT INTO scenario_epoch_state(workspace_id,epoch,scenario_run_id,scenario_id,deterministic_seed,virtual_time,initial_state_hash)
      VALUES (?,?,'run','synthetic-upgrade',1,?,?)`).run(context.workspaceId, context.epoch, now, '0'.repeat(64))
    database.driver.prepare(`INSERT INTO outpatient_catalog(workspace_id,epoch,item_id,kind,code,name_zh,name_en)
      VALUES (?,?,'department','department','general','合成科室','Synthetic department')`).run(context.workspaceId, context.epoch)
    database.driver.prepare(`INSERT INTO outpatient_case(workspace_id,epoch,case_id,scenario_run_id,patient_id,registration_id,encounter_id,
      account_id,department_id,location_id,initial_task_id,status,arrived_at,updated_at)
      VALUES (?,?,'case','run','patient','registration','encounter','account','department','location','task','awaiting-lab-payment',?,?)`)
      .run(context.workspaceId, context.epoch, now, now)
    database.driver.prepare(`INSERT INTO clinical_request_context(workspace_id,epoch,case_id,outpatient_case_id,patient_id,encounter_id)
      VALUES (?,?,'case','case','patient','encounter')`).run(context.workspaceId, context.epoch)
    database.driver.prepare(`INSERT INTO scenario_simulator_rule(workspace_id,epoch,simulator,rule_code,outcome,config_json)
      VALUES (?,?,'payment','success','success','{}')`).run(context.workspaceId, context.epoch)
    for (const [id, amount] of [['charge', 100], ['zero', 0], ['second', 100]] as const) {
      database.driver.prepare(`INSERT INTO charge_record(workspace_id,epoch,charge_id,case_id,account_id,charge_item_id,category,source_reference,
        description_zh,description_en,quantity,unit_price_fen,total_fen,status,version,created_at)
        VALUES (?,?,?,'case','account',?,'laboratory',?,'合成检验','Synthetic laboratory',1,?,?,'billable',1,?)`)
        .run(context.workspaceId, context.epoch, id, id, `ServiceRequest/${id}`, amount, amount, now)
    }
    const collection = new PaymentCollection(database)
    const commands = new CommandExecutor(database, new FhirRepository(database))
    const config = { context, operation: 'payment.confirm', input: { previewId: 'original-preview', commitToken: 'synthetic-original-token' },
      expectedVersions: {}, idempotencyKey: 'synthetic-original-key', dataSchema: z.object({ paymentId: z.string() }) }
    const original = commands.execute(config, () => {
      const payment = collection.create(context, { owner: { kind: 'outpatient', id: 'case' }, purpose: 'outpatient-charge', previewId: 'original-preview',
        amountFen: 100, tenders: [{ method: 'bank-card', amountFen: 100 }], simulatorRule: 'success', createdAt: now })
      database.driver.prepare(`INSERT INTO outpatient_payment_allocation(workspace_id,epoch,payment_id,case_id,charge_item_id,amount_fen)
        VALUES (?,?,?,'case','charge',100)`).run(context.workspaceId, context.epoch, payment.paymentId)
      return { data: { paymentId: payment.paymentId }, effects: [] }
    })
    const zero = database.driver.transaction(() => collection.create(context, { owner: { kind: 'outpatient', id: 'case' }, purpose: 'outpatient-charge',
      previewId: 'zero-preview', amountFen: 0, tenders: [{ method: 'cash', amountFen: 0 }], simulatorRule: 'success', createdAt: now }))()
    database.driver.prepare(`INSERT INTO outpatient_payment_allocation(workspace_id,epoch,payment_id,case_id,charge_item_id,amount_fen)
      VALUES (?,?,?,'case','zero',0)`).run(context.workspaceId, context.epoch, zero.paymentId)
    for (const consumed of [null, now]) {
      database.driver.prepare(`INSERT INTO outpatient_refund_preview(workspace_id,epoch,preview_id,payment_id,amount_fen,source_version,charge_version,
        simulator_rule,actor_context_hash,token_hash,expires_at,consumed_at) VALUES (?,?,?,?,50,1,1,'success','original-actor-hash','original-token-hash',?,?)`)
        .run(context.workspaceId, context.epoch, consumed === null ? 'refund-active' : 'refund-consumed', original.data.paymentId, '2026-11-10T00:05:00.000Z', consumed)
    }
    const preservedTables = ['collection_transaction', 'collection_tender', 'command_receipt', 'charge_record']
    const originalRows = preservedTables.map(table => database.driver.prepare(`SELECT * FROM ${table}`).all())
    const previews = database.driver.prepare('SELECT * FROM outpatient_refund_preview ORDER BY preview_id').all()
    const allocations = database.driver.prepare('SELECT * FROM outpatient_payment_allocation ORDER BY payment_id').all()

    expect(applyMigrations(database).applied).toEqual([migration])
    preservedTables.forEach((table, index) => expect(database.driver.prepare(`SELECT * FROM ${table}`).all()).toEqual(originalRows[index]))
    expect(database.driver.prepare('SELECT * FROM outpatient_refund_preview ORDER BY preview_id').all())
      .toEqual(previews.map(preview => ({ ...preview, charge_item_id: 'charge' })))
    expect(database.driver.prepare('SELECT * FROM outpatient_payment_allocation ORDER BY payment_id').all())
      .toEqual(allocations.map(allocation => ({ ...allocation, position: 0 })))
    expect(commands.execute(config, () => { throw new Error('原回执禁止重执行') })).toEqual(original)
    expect(new PaymentLedger(database).attempts(context, 'case').items.find(item => item.paymentId === zero.paymentId))
      .toMatchObject({ amountFen: 0, chargeItemId: 'zero', tenders: [{ method: 'cash', amountFen: 0 }] })

    database.driver.transaction(() => {
      const multi = collection.create(context, { owner: { kind: 'outpatient', id: 'case' }, purpose: 'outpatient-charge', previewId: 'multi-preview',
        amountFen: 100, tenders: [{ method: 'cash', amountFen: 100 }], simulatorRule: 'success', createdAt: now })
      const ledger = new PaymentLedger(database)
      ledger.allocate(context, multi.paymentId, 'case', 'charge', 40, 0)
      ledger.allocate(context, multi.paymentId, 'case', 'second', 60, 1)
      expect(() => ledger.allocate(context, multi.paymentId, 'case', 'charge', 1, 2)).toThrow()
      expect(() => ledger.allocate(context, multi.paymentId, 'other-case', 'zero', 1, 2)).toThrow()
      expect(() => ledger.allocate(context, multi.paymentId, 'case', 'missing-charge', 1, 2)).toThrow()
      expect(ledger.attempts(context, 'case').items.find(item => item.paymentId === multi.paymentId))
        .toMatchObject({ kind: 'multi-charge', amountFen: 100, allocations: [{ chargeItemId: 'charge', amountFen: 40 }, { chargeItemId: 'second', amountFen: 60 }] })
    })()
    expect(applyMigrations(database).applied).toEqual([])
    expect(database.driver.pragma('foreign_key_check')).toEqual([])
  } finally { database.close(); await rm(directory, { recursive: true }) }
}, 30_000)
