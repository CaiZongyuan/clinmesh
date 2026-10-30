import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { unknownModelTokenUsage } from '@clinmesh/contracts/model-usage'
import { afterEach, describe, expect, it } from 'vitest'
import { runDatabaseCli } from '../src/database-cli.ts'
import { applyMigrations, canonicalStateHash, openClinMeshDatabase, type ClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'
import { FhirRepository } from '../src/infrastructure/sqlite/fhir-repository.ts'
import { CommandExecutor } from '../src/application/command-executor.ts'
import { ModelUsageService } from '../src/application/model-usage-service.ts'
import { ScenarioService } from '../src/application/scenario-service.ts'
import { PciCaseSource } from '../src/application/scenario-data/pci-case-source.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from '../src/application/scenario-data/medical-service-snapshot.ts'
import { SyntheticCaseRepository } from '../src/infrastructure/sqlite/synthetic-case-repository.ts'
import { SyntheticPatientProfileRepository } from '../src/infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import { PatientPersonaRepository } from '../src/infrastructure/sqlite/patient-persona-repository.ts'
import { InvestigationResultRepository } from '../src/infrastructure/sqlite/investigation-result-repository.ts'
import { OutboxRepository } from '../src/infrastructure/sqlite/outbox-repository.ts'
import { allocateRegistrationNumber } from '../src/infrastructure/sqlite/registration-numbering.ts'
import { runGuidelinePrepare } from '../src/guideline-prepare.ts'
import { createGuidelineReleaseFixture } from './fixtures/guideline-release.ts'
import { prepareLegacyPaymentCutover } from './fixtures/payment-cutover.ts'
import { preparePciPaymentDrgFixture } from './fixtures/pci-payment-drg.ts'

const directories: string[] = []
const databases: ClinMeshDatabase[] = []
afterEach(async () => {
  for (const db of databases.splice(0)) if (db.driver.open) db.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true })
})

async function oldDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-payment-cutover-'))
  directories.push(directory)
  const migrations = join(directory, 'migrations')
  await mkdir(migrations)
  for (const file of (await readdir('drizzle')).filter(file => file.endsWith('.sql') && file < '0103_')) {
    await copyFile(join('drizzle', file), join(migrations, file))
  }
  const path = join(directory, 'hospital.sqlite')
  const db = openClinMeshDatabase({ databasePath: path, busyTimeoutMs: 5000 })
  databases.push(db)
  applyMigrations(db, migrations)
  new WorkspaceRepository(db).install({ workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioId: 'synthetic-cutover', scenarioRunId: 'run-old', workspaceName: 'Synthetic cutover' })
  db.driver.exec(`
    INSERT INTO scenario_definition (scenario_id,version,kind,schema_version) VALUES ('synthetic-cutover','1','candidate','1');
    INSERT INTO scenario_epoch_state (workspace_id,epoch,scenario_run_id,scenario_id,deterministic_seed,virtual_time,initial_state_hash)
      VALUES ('workspace-demo','epoch-1','run-old','synthetic-cutover',1,'2026-08-24T00:00:00Z','synthetic-hash');
    INSERT INTO outpatient_catalog (workspace_id,epoch,item_id,kind,code,name_zh,name_en)
      VALUES ('workspace-demo','epoch-1','department','department','general','Synthetic department','Synthetic department');
    INSERT INTO outpatient_case (workspace_id,epoch,case_id,scenario_run_id,patient_id,registration_id,encounter_id,account_id,department_id,location_id,initial_task_id,status,arrived_at,updated_at)
      VALUES ('workspace-demo','epoch-1','old-case','run-old','old-patient','old-registration','old-encounter','old-account','department','location','old-task','awaiting-lab-payment','2026-08-24','2026-08-24');
    INSERT INTO charge_record (workspace_id,epoch,charge_id,case_id,account_id,charge_item_id,category,source_reference,description_zh,description_en,quantity,unit_price_fen,total_fen,status,version,created_at)
      VALUES ('workspace-demo','epoch-1','old-charge','old-case','old-account','old-item','laboratory','ServiceRequest/old','Synthetic lab','Synthetic lab',1,6800,6800,'paid',2,'2026-08-24');
    INSERT INTO payment_preview (workspace_id,epoch,preview_id,case_id,category,charge_item_id,amount_fen,expected_charge_version,simulator_rule,token_hash,expires_at,consumed_at)
      VALUES ('workspace-demo','epoch-1','old-preview','old-case','laboratory','old-item',6800,1,'success','synthetic-token','2026-08-24','2026-08-24');
    INSERT INTO payment_transaction (workspace_id,epoch,payment_id,case_id,category,amount_fen,outcome,correlation_id,preview_id,created_at)
      VALUES ('workspace-demo','epoch-1','old-payment','old-case','laboratory',6800,'success','synthetic-old','old-preview','2026-08-24');
  `)
  return { directory, path, db }
}

function count(db: ClinMeshDatabase, table: string) {
  return (db.driver.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count
}

describe('explicit synthetic payment cutover', () => {
  it('ordinary migration rejects old money without changing the old running chain', async () => {
    const { db } = await oldDatabase()
    try {
      const before = canonicalStateHash(db)
      expect(() => applyMigrations(db)).toThrow('PAYMENT_CUTOVER_REQUIRED')
      expect(canonicalStateHash(db)).toBe(before)
      expect(count(db, 'payment_transaction')).toBe(1)
    } finally { db.close() }
  })

  it('requires explicit acknowledgement, backs up old facts and atomically opens an empty generation with the original configuration', async () => {
    const { db, path, directory } = await oldDatabase()
    const before = canonicalStateHash(db)
    const authority = db.driver.prepare('SELECT * FROM registration_number_authority').all()
    db.close()
    const backup = join(directory, 'before.sqlite')
    await expect(runDatabaseCli(['payment-cutover', '--database', path, '--backup', backup], {})).rejects.toThrow('discard-synthetic-runtime')
    const result = await runDatabaseCli(['payment-cutover', '--database', path, '--backup', backup, '--confirm', 'discard-synthetic-runtime'], {})
    expect(result).toMatchObject({ cutover: { epochs: [{ workspaceId: 'workspace-demo', fromEpoch: 'epoch-1', toEpoch: 'epoch-2' }] } })
    const old = openClinMeshDatabase({ databasePath: backup, busyTimeoutMs: 5000 })
    databases.push(old)
    expect(canonicalStateHash(old)).toBe(before)
    expect(count(old, 'payment_transaction')).toBe(1)
    const current = openClinMeshDatabase({ databasePath: path, busyTimeoutMs: 5000 })
    databases.push(current)
    expect(current.driver.pragma('foreign_key_check')).toEqual([])
    expect(current.driver.prepare("SELECT 1 FROM sqlite_schema WHERE name='payment_transaction'").get()).toBeUndefined()
    expect(count(current, 'charge_record')).toBe(0)
    expect(count(current, 'outpatient_case')).toBe(0)
    expect(current.driver.prepare('SELECT * FROM registration_number_authority').all()).toEqual(authority)
    expect(current.driver.prepare("SELECT state FROM workspace_epoch WHERE epoch='epoch-1'").get()).toEqual({ state: 'closed' })
    expect(current.driver.prepare('SELECT active_epoch FROM workspace').get()).toEqual({ active_epoch: 'epoch-2' })
    expect(current.driver.prepare("SELECT code,name_zh,config_json FROM outpatient_catalog WHERE epoch='epoch-2'").all())
      .toEqual(old.driver.prepare('SELECT code,name_zh,config_json FROM outpatient_catalog').all())
    await expect(runDatabaseCli(['payment-cutover', '--database', path, '--backup', join(directory, 'again.sqlite'), '--confirm', 'discard-synthetic-runtime'], {})).rejects.toThrow('PAYMENT_CUTOVER_ALREADY_APPLIED')
  })

  it('rolls back deleted runtime, schema, epoch and numbering together and keeps the diagnostic backup for repair', async () => {
    const { db, path, directory } = await oldDatabase()
    db.driver.exec("CREATE TRIGGER synthetic_cutover_fault BEFORE DELETE ON outpatient_case BEGIN SELECT RAISE(ABORT,'synthetic cutover failure'); END")
    const before = canonicalStateHash(db)
    const backup = join(directory, 'failed-cutover.sqlite')
    await expect(runDatabaseCli(['payment-cutover', '--database', path, '--backup', backup, '--confirm', 'discard-synthetic-runtime'], {}))
      .rejects.toThrow(`切换前备份 ${backup}`)
    expect(canonicalStateHash(db)).toBe(before)
    expect(db.driver.pragma('foreign_key_check')).toEqual([])
    expect(count(db, 'payment_transaction')).toBe(1)
    expect(count(db, 'workspace_epoch')).toBe(1)
    expect((await stat(backup)).size).toBeGreaterThan(0)
    db.driver.exec('DROP TRIGGER synthetic_cutover_fault')
    await expect(runDatabaseCli(['payment-cutover', '--database', path, '--backup', backup, '--confirm', 'discard-synthetic-runtime'], {}))
      .rejects.toThrow('Backup destination already exists')
    await expect(runDatabaseCli(['payment-cutover', '--database', path, '--backup', join(directory, 'repaired.sqlite'), '--confirm', 'discard-synthetic-runtime'], {}))
      .resolves.toMatchObject({ cutover: { epochs: [{ toEpoch: 'epoch-2' }] } })
  })

  it('refuses to discard new-model unknown money', async () => {
    const { db, path, directory } = await oldDatabase()
    db.driver.exec(`INSERT INTO clinical_request_context(workspace_id,epoch,case_id,outpatient_case_id,patient_id,encounter_id)
      SELECT workspace_id,epoch,case_id,case_id,patient_id,encounter_id FROM outpatient_case;
      INSERT INTO collection_transaction(workspace_id,epoch,payment_id,owner_kind,owner_id,patient_id,encounter_id,purpose,preview_id,amount_fen,outcome,recovery_outcome,correlation_id,created_at)
      VALUES('workspace-demo','epoch-1','new-unknown','outpatient','old-case','old-patient','old-encounter','outpatient-charge','new-preview',100,'ambiguous','success','new-synthetic','2026-08-24');`)
    const before = canonicalStateHash(db)
    await expect(runDatabaseCli(['payment-cutover', '--database', path, '--backup', join(directory, 'refused.sqlite'), '--confirm', 'discard-synthetic-runtime'], {}))
      .rejects.toThrow('PAYMENT_CUTOVER_NEW_MONEY')
    expect(canonicalStateHash(db)).toBe(before)
    expect(count(db, 'collection_transaction')).toBe(1)
    await expect(stat(join(directory, 'refused.sqlite'))).rejects.toThrow()
  })

  it('refuses ordinary upgrade of a refund whose original money is outside the shared model', async () => {
    const { db } = await oldDatabase()
    db.driver.exec(`DELETE FROM payment_transaction;
      INSERT INTO refund_transaction(workspace_id,epoch,refund_id,source_kind,source_id,basis_id,owner_kind,owner_id,amount_fen,outcome,recovery_outcome,correlation_id,created_at)
      VALUES('workspace-demo','epoch-1','old-refund','outpatient-payment','old-payment','outpatient-charge:old-item','outpatient','old-case',100,'ambiguous','success','synthetic-old-refund','2026-08-24');`)
    const before = canonicalStateHash(db)
    expect(() => applyMigrations(db)).toThrow('PAYMENT_CUTOVER_REQUIRED')
    expect(canonicalStateHash(db)).toBe(before)
  })

  it('rejects a changed source before any migration and requires an explicit owner decision for unknown tables', async () => {
    const { db, path, directory } = await oldDatabase()
    const before = canonicalStateHash(db)
    expect(() => applyMigrations(db, undefined, { paymentCutover: { expectedStateHash: 'outdated-backup' } })).toThrow('PAYMENT_CUTOVER_SOURCE_CHANGED')
    expect(canonicalStateHash(db)).toBe(before)
    expect(db.driver.pragma('foreign_keys', { simple: true })).toBe(1)
    db.driver.exec('CREATE TABLE future_owner_state (id TEXT PRIMARY KEY) STRICT; INSERT INTO future_owner_state VALUES (\'keep-me\')')
    const withUnknown = canonicalStateHash(db)
    await expect(runDatabaseCli(['payment-cutover', '--database', path, '--backup', join(directory, 'unknown.sqlite'), '--confirm', 'discard-synthetic-runtime'], {}))
      .rejects.toThrow('PAYMENT_CUTOVER_UNKNOWN_TABLE: 未登记保留边界：future_owner_state')
    expect(canonicalStateHash(db)).toBe(withUnknown)
  })

  it('preserves source identities and content, accounts, configuration, metering, audit, issuance and separate databases while retiring old intents', async () => {
    const prepared = await preparePciPaymentDrgFixture()
    directories.push(prepared.directory)
    const { source, legacy } = await prepareLegacyPaymentCutover(prepared)
    const db = openClinMeshDatabase({ databasePath: prepared.options.databasePath, busyTimeoutMs: 5000 })
    databases.push(db)
    const fhir = new FhirRepository(db), commands = new CommandExecutor(db, fhir)
    const context = { workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1', actorId: 'synthetic-cutover-administrator', roleCode: 'administrator' }
    const usage = new ModelUsageService(db, commands)
    const attemptId = usage.begin({ context: { workspaceId: context.workspaceId, epoch: context.epoch, actorId: context.actorId,
      taskId: 'synthetic-old-task', caseId: legacy.admissionId, stage: 'synthetic-cutover', trigger: 'automatic', sources: [] },
      feature: 'investigation_result', provider: 'synthetic', model: 'synthetic-no-call', outputLimit: null, kind: 'initial' })
    usage.settle(attemptId, { status: 'unknown', dispatch: 'unknown', usage: unknownModelTokenUsage })
    const retention = usage.updateRetention(context, { days: null, expectedVersion: usage.retention(context.workspaceId).version }, 'retain-metering-policy')
    const snapshotRepository = new InvestigationResultRepository(db)
    const snapshot = snapshotRepository.createOrGet({ workspaceId: context.workspaceId, caseId: source.case.caseId,
      catalogItemId: 'synthetic-reusable-result', snapshotId: 'synthetic-result-before-cutover', createdAt: '2026-08-24T01:00:00.000Z',
      inputHash: '1'.repeat(64), outputHash: '2'.repeat(64), promptHash: null, promptVersion: null, model: null, source: 'case-truth-exact',
      requestedConcept: { id: 'synthetic-result', code: 'synthetic', display: 'Synthetic reusable result', system: 'https://example.test/synthetic', version: '1', sourceLocator: 'synthetic-fixture' },
      content: { conclusion: 'Synthetic stable finding', results: [{ code: 'synthetic', display: 'Synthetic', interpretation: 'normal', referenceRange: { text: 'Synthetic negative' }, value: false }] } })
    expect(db.driver.transaction(() => allocateRegistrationNumber(db, '2026-08-24'))()).toBe('CM-OP-20260824-000002')
    db.driver.exec(`INSERT INTO outbox_event(workspace_id,epoch,event_id,scenario_run_id,kind,dedup_key,payload_json,payload_hash,status,next_attempt_at,created_at,updated_at)
      VALUES('workspace-demo','epoch-1','old-callback','scenario-run-1','synthetic-cutover','old-callback','{}','synthetic','queued','2026-08-24','2026-08-24','2026-08-24');`)
    const outbox = new OutboxRepository(db)
    const claim = outbox.claimNext({ leaseOwner: 'synthetic-old-worker', leaseDurationMs: 30000, now: new Date() })!
    expect(claim.eventId).toBe('old-callback')
    const originalCase = db.driver.prepare('SELECT * FROM synthetic_case_instance WHERE case_id=?').get(source.case.caseId) as Record<string, unknown>
    const assetTables = ['synthetic_patient_profile', 'synthetic_patient_profile_revision', 'synthetic_patient_profile_batch',
      'synthetic_case_truth', 'synthetic_case_visible_history', 'synthetic_case_visible_resource', 'patient_persona_revision',
      'investigation_result_snapshot', 'user', 'account', 'workspace_actor', 'workspace_membership', 'practitioner_role_binding',
      'membership_practitioner_role', 'registration_number_authority', 'registration_number_counter', 'audit_head', 'audit_log', 'action_trace',
      'model_usage_attempt', 'model_usage_control', 'model_usage_request_reservation', 'model_usage_dimension', 'model_usage_dimension_reservation', 'model_usage_retention']
    const originals = new Map(assetTables.map(table => [table, db.driver.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
    for (const table of ['synthetic_patient_profile', 'synthetic_patient_profile_revision', 'synthetic_case_truth', 'patient_persona_revision', 'investigation_result_snapshot', 'user', 'audit_log', 'model_usage_attempt']) {
      expect(originals.get(table)!.length, table).toBeGreaterThan(0)
    }
    const originalPolicyReceipt = db.driver.prepare("SELECT * FROM command_receipt WHERE operation LIKE 'model-usage.%'").all()
    const guideline = await createGuidelineReleaseFixture(join(prepared.directory, 'guidelines'))
    const guidelineDatabasePath = join(prepared.directory, 'guideline.sqlite')
    await runGuidelinePrepare({ ...guideline, databasePath: guidelineDatabasePath, deploymentPolicy: 'internal-testing' })
    const referenceBefore = await readFile(prepared.data.referenceDatabasePath)
    const guidelinesBefore = await readFile(guidelineDatabasePath)
    const result = await runDatabaseCli(['payment-cutover', '--database', prepared.options.databasePath,
      '--backup', join(prepared.directory, 'before-cutover.sqlite'), '--confirm', 'discard-synthetic-runtime'], {})
    expect(result).toMatchObject({ cutover: { preserved: expect.arrayContaining([
      expect.objectContaining({ table: 'synthetic_patient_profile', count: 1, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ table: 'investigation_result_snapshot', count: 1 }),
    ]) } })
    for (const [table, original] of originals) {
      const current = db.driver.prepare(`SELECT * FROM ${table}${table === 'audit_head' ? " WHERE epoch='epoch-1'" : ''} ORDER BY rowid`).all()
      expect(current, table).toEqual(original)
    }
    const readyCase = db.driver.prepare('SELECT * FROM synthetic_case_instance WHERE case_id=?').get(source.case.caseId) as Record<string, unknown>
    expect(readyCase).toEqual({ ...originalCase, status: 'brief-ready', revision: Number(originalCase.revision) + 1, updated_at: expect.any(String) })
    expect(snapshotRepository.getById(context.workspaceId, snapshot.snapshotId)).toEqual(snapshot)
    expect(db.driver.prepare("SELECT * FROM command_receipt WHERE operation LIKE 'model-usage.%'").all()).toEqual(originalPolicyReceipt)
    expect(usage.updateRetention({ ...context, epoch: 'epoch-2', scenarioRunId: 'scenario-run-2' }, { days: null, expectedVersion: 1 }, 'retain-metering-policy')).toEqual(retention)
    const state = canonicalStateHash(db)
    expect(() => outbox.complete(claim, 'completed', { maxAttempts: 3, maxRetryDelayMs: 1000, now: new Date(), retryDelayMs: 10 })).toThrow('lease is no longer owned')
    expect(canonicalStateHash(db)).toBe(state)
    expect(() => commands.execute({ context, operation: 'synthetic.legacy.payment-chain', input: legacy, idempotencyKey: legacy.receiptKey,
      expectedVersions: {}, dataSchema: z.object({ admissionId: z.string(), paymentId: z.string() }) }, () => { throw new Error('Old handler must never run') }))
      .toThrow('not active')
    expect(db.driver.prepare("SELECT outcome FROM audit_log WHERE operation='synthetic.legacy.payment-chain' ORDER BY sequence DESC LIMIT 1").get()).toEqual({ outcome: 'failed' })
    for (const table of ['collection_transaction', 'inpatient_admission', 'outpatient_case', 'outbox_event']) expect(count(db, table), table).toBe(0)
    expect(db.driver.transaction(() => allocateRegistrationNumber(db, '2026-08-24'))()).toBe('CM-OP-20260824-000003')
    expect(await readFile(prepared.data.referenceDatabasePath)).toEqual(referenceBefore)
    expect(await readFile(guidelineDatabasePath)).toEqual(guidelinesBefore)
  }, 90000)

  it('retains workspace idempotency for preserved source and scenario owners across the cutover', async () => {
    const prepared = await preparePciPaymentDrgFixture()
    directories.push(prepared.directory)
    const { source } = await prepareLegacyPaymentCutover(prepared)
    const db = openClinMeshDatabase({ databasePath: prepared.options.databasePath, busyTimeoutMs: 5000 })
    databases.push(db)
    const fhir = new FhirRepository(db), commands = new CommandExecutor(db, fhir)
    const context = { workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1', actorId: 'synthetic-cutover-administrator', roleCode: 'administrator' }
    const scenarios = new ScenarioService(db, fhir, commands, syntheticNhsaMedicationProductSnapshot,
      syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot)
    const install = scenarios.install({ context, kind: 'candidate', idempotencyKey: 'preserved-scenario-install' })
    const receipts = db.driver.prepare("SELECT * FROM command_receipt WHERE operation IN ('scenario.install','synthetic-case.pci-source.prepare') ORDER BY operation").all()
    expect(receipts).toHaveLength(2)
    await runDatabaseCli(['payment-cutover', '--database', prepared.options.databasePath,
      '--backup', join(prepared.directory, 'before-preserved-owner-replay.sqlite'), '--confirm', 'discard-synthetic-runtime'], {})
    const current = { ...context, epoch: 'epoch-3', scenarioRunId: 'scenario-run-3' }
    expect(scenarios.current(current).epoch).toBe(current.epoch)
    const before = canonicalStateHash(db)
    expect(scenarios.install({ context: current, kind: 'candidate', idempotencyKey: 'preserved-scenario-install' })).toEqual(install)
    const cases = new SyntheticCaseRepository(db)
    const pci = new PciCaseSource(commands, new SyntheticPatientProfileRepository(db), cases, new PatientPersonaRepository(db, cases))
    expect(pci.prepare(current, { expectedEpoch: context.epoch }, 'synthetic-legacy-source').data).toEqual(source)
    expect(canonicalStateHash(db)).toBe(before)
    expect(db.driver.prepare("SELECT * FROM command_receipt WHERE operation IN ('scenario.install','synthetic-case.pci-source.prepare') ORDER BY operation").all()).toEqual(receipts)
  }, 90000)
})
