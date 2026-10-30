import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PaymentCollection } from '../src/application/payment-collection.ts'
import { applyMigrations, openClinMeshDatabase, type ClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'

const context = { workspaceId: 'collection-workspace', epoch: 'epoch-1' }
const now = '2026-10-29T01:00:00.000Z'
const directories: string[] = []
const databases: ClinMeshDatabase[] = []

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-collection-'))
  directories.push(directory)
  const databasePath = join(directory, 'collection.sqlite')
  const database = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5000 })
  databases.push(database)
  applyMigrations(database)
  new WorkspaceRepository(database).install({ ...context, scenarioId: 'collection', scenarioRunId: 'run-1', workspaceName: '合成收款' })
  database.driver.prepare(`INSERT INTO scenario_definition (scenario_id,version,kind,schema_version)
    VALUES ('collection','1','candidate','1')`).run()
  database.driver.prepare(`INSERT INTO scenario_epoch_state
    (workspace_id,epoch,scenario_run_id,scenario_id,deterministic_seed,virtual_time,initial_state_hash)
    VALUES (?,?,'run-1','collection',1,?,?)`).run(context.workspaceId, context.epoch, now, '0'.repeat(64))
  database.driver.prepare(`INSERT INTO outpatient_catalog (workspace_id,epoch,item_id,kind,code,name_zh,name_en)
    VALUES (?,?,'department','department','general','合成科室','Synthetic department')`).run(context.workspaceId, context.epoch)
  database.driver.prepare(`INSERT INTO outpatient_case (
    workspace_id,epoch,case_id,scenario_run_id,patient_id,registration_id,encounter_id,account_id,
    department_id,location_id,initial_task_id,status,arrived_at,updated_at
  ) VALUES (?,?,'case-1','run-1','patient-1','registration-1','encounter-1','account-1',
    'department','location','task-1','awaiting-lab-payment',?,?)`).run(context.workspaceId, context.epoch, now, now)
  database.driver.prepare(`INSERT INTO clinical_request_context
    (workspace_id,epoch,case_id,outpatient_case_id,patient_id,encounter_id)
    VALUES (?,?,'case-1','case-1','patient-1','encounter-1')`).run(context.workspaceId, context.epoch)
  database.driver.prepare(`INSERT INTO scenario_simulator_rule (workspace_id,epoch,simulator,rule_code,outcome,config_json)
    VALUES (?,?,'payment','ambiguous','ambiguous','{}')`).run(context.workspaceId, context.epoch)
  for (const [rule, outcome] of [['success', 'success'], ['decline', 'declined']]) {
    database.driver.prepare(`INSERT INTO scenario_simulator_rule (workspace_id,epoch,simulator,rule_code,outcome,config_json)
      VALUES (?,?,'payment',?,?,'{}')`).run(context.workspaceId, context.epoch, rule, outcome)
  }
  return { database, databasePath, collection: new PaymentCollection(database) }
}

afterEach(async () => {
  for (const database of databases.splice(0)) if (database.driver.open) database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true })))
})

it('keeps original unknown money facts and resolves only that attempt after reopening the database', async () => {
  const { database, databasePath, collection } = await fixture()
  const payment = database.driver.transaction(() => collection.create(context, {
    owner: { kind: 'outpatient', id: 'case-1' }, purpose: 'outpatient-charge', previewId: 'preview-1',
    amountFen: 3000, tenders: [{ method: 'bank-card', amountFen: 1000 }, { method: 'mobile', amountFen: 2000 }],
    simulatorRule: 'ambiguous', createdAt: now,
  }))()
  expect(payment).toMatchObject({ ownerId: 'case-1', patientId: 'patient-1', encounterId: 'encounter-1',
    amountFen: 3000, initialOutcome: 'ambiguous', outcome: 'ambiguous', version: 1 })
  database.close()
  const reopened = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5000 })
  databases.push(reopened)
  const recovered = new PaymentCollection(reopened)
  expect(recovered.tenders(context, payment.paymentId)).toEqual([
    { method: 'bank-card', amountFen: 1000 }, { method: 'mobile', amountFen: 2000 },
  ])
  expect(recovered.attempt({ ...context, epoch: 'other' }, payment.paymentId)).toBeUndefined()
  const resolve = () => reopened.driver.transaction(() => recovered.recover(context, payment.paymentId, 1, now))()
  expect(resolve()).toMatchObject({ changed: true, payment: { paymentId: payment.paymentId, initialOutcome: 'ambiguous', outcome: 'success', version: 2 } })
  expect(() => resolve()).toThrow('版本')
  expect(reopened.driver.transaction(() => recovered.recover(context, payment.paymentId, 2, now))())
    .toMatchObject({ changed: false, payment: { outcome: 'success', version: 2 } })
})

it.each([
  ['success', 'success', 'success', false],
  ['decline', 'declined', 'declined', false],
  ['ambiguous-decline', 'ambiguous', 'declined', true],
  ['ambiguous-pending', 'ambiguous', 'ambiguous', false],
] as const)('preserves the original %s result and uses its frozen query plan', async (simulatorRule, initialOutcome, outcome, changed) => {
  const { database, collection } = await fixture()
  const payment = database.driver.transaction(() => collection.create(context, {
    owner: { kind: 'outpatient', id: 'case-1' }, purpose: 'outpatient-charge', previewId: 'preview-1',
    amountFen: 1000, tenders: [{ method: 'cash', amountFen: 1000 }], simulatorRule, createdAt: now,
  }))()
  // Active channel policy may change; querying an original attempt must use its recorded plan.
  database.driver.prepare("UPDATE scenario_simulator_rule SET outcome='success'").run()
  expect(database.driver.transaction(() => collection.recover(context, payment.paymentId, 1, now))())
    .toMatchObject({ changed, payment: { initialOutcome, outcome, version: changed ? 2 : 1 } })
})

it('rolls back an appended result with its owning transaction and rejects a different owner purpose', async () => {
  const { database, collection } = await fixture()
  const input = {
    owner: { kind: 'outpatient' as const, id: 'case-1' }, purpose: 'outpatient-charge' as const,
    previewId: 'preview-1', amountFen: 1000, tenders: [{ method: 'cash' as const, amountFen: 1000 }],
    simulatorRule: 'ambiguous' as const, createdAt: now,
  }
  expect(() => collection.create(context, input)).toThrow('Command 事务')
  expect(() => database.driver.transaction(() => collection.create(context, { ...input, purpose: 'inpatient-deposit' }))())
    .toThrow('原就诊')
  const payment = database.driver.transaction(() => collection.create(context, input))()
  expect(() => database.driver.transaction(() => {
    collection.recover(context, payment.paymentId, 1, now)
    throw new Error('synthetic business failure')
  })()).toThrow('synthetic business failure')
  expect(collection.attempt(context, payment.paymentId)).toMatchObject({ outcome: 'ambiguous', version: 1, resolvedAt: null })
  expect(database.driver.transaction(() => collection.recover(context, payment.paymentId, 1, now))())
    .toMatchObject({ changed: true, payment: { outcome: 'success', version: 2 } })
})
