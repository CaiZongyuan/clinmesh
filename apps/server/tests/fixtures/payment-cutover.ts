import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { CommandExecutor, type ActorContext } from '../../src/application/command-executor.ts'
import { IdentityService, syntheticAccounts } from '../../src/application/identity-service.ts'
import { ScenarioService } from '../../src/application/scenario-service.ts'
import { WorkflowService } from '../../src/application/workflow-service.ts'
import { PciCaseSource } from '../../src/application/scenario-data/pci-case-source.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../../src/application/scenario-data/medication-product-snapshot.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from '../../src/application/scenario-data/medical-service-snapshot.ts'
import { applyMigrations, openClinMeshDatabase } from '../../src/infrastructure/sqlite/database.ts'
import { FhirRepository } from '../../src/infrastructure/sqlite/fhir-repository.ts'
import { PatientPersonaRepository } from '../../src/infrastructure/sqlite/patient-persona-repository.ts'
import { SyntheticCaseRepository } from '../../src/infrastructure/sqlite/synthetic-case-repository.ts'
import { SyntheticPatientProfileRepository } from '../../src/infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import { WorkspaceRepository } from '../../src/infrastructure/sqlite/workspace-repository.ts'
import type { preparePciPaymentDrgFixture } from './pci-payment-drg.ts'

/** A real pre-cutover schema with synthetic legacy money and the progress it funded. */
export async function prepareLegacyPaymentCutover(prepared: Awaited<ReturnType<typeof preparePciPaymentDrgFixture>>) {
  const migrations = join(prepared.directory, 'legacy-migrations')
  await mkdir(migrations)
  const files = (await readdir('drizzle')).filter(file => /^\d{4}_[a-z0-9-]+\.sql$/.test(file) && file < '0103_')
  await Promise.all(files.map(file => copyFile(join('drizzle', file), join(migrations, file))))
  const database = openClinMeshDatabase({ databasePath: prepared.options.databasePath, busyTimeoutMs: 5000 })
  const scope = { workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1' }
  const context: ActorContext = { ...scope, actorId: 'synthetic-cutover-administrator', roleCode: 'administrator' }
  const now = '2026-08-24T09:00:00+08:00'
  try {
    applyMigrations(database, migrations)
    new WorkspaceRepository(database).install({ ...scope, scenarioId: 'candidate-fever-outpatient-v3', workspaceName: '合成支付切换验收医院' })
    const fhir = new FhirRepository(database)
    const commands = new CommandExecutor(database, fhir)
    new ScenarioService(database, fhir, commands, syntheticNhsaMedicationProductSnapshot,
      syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot).ensureInitialEpoch(scope)
    await new IdentityService(database, { authBaseUrl: prepared.options.authBaseUrl, authSecret: prepared.options.authSecret,
      commands, trustedOrigins: prepared.options.trustedOrigins }).seedSyntheticAccounts({ password: prepared.password, workspaceId: scope.workspaceId })
    const profiles = new SyntheticPatientProfileRepository(database), cases = new SyntheticCaseRepository(database)
    const personas = new PatientPersonaRepository(database, cases)
    const source = new PciCaseSource(commands, profiles, cases, personas).prepare(context, { expectedEpoch: scope.epoch }, 'synthetic-legacy-source').data
    const registrar = syntheticAccounts.find(account => account.roleCode === 'registrar')!
    const registrarContext: ActorContext = { ...scope, actorId: registrar.actorId, roleCode: registrar.roleCode,
      practitionerId: registrar.practitionerId, practitionerRoleId: 'practitioner-role-registrar',
      organizationId: 'organization-clinmesh', locationId: 'location-registrar' }
    const profile = profiles.getRevision(scope.workspaceId, source.profileId, source.case.profileRevision)!
    const brief = personas.getRevision(scope.workspaceId, source.case.caseId, source.case.activeBriefRevision!)!
    const start = { key: 'synthetic-legacy-start-outpatient', request: {
      activeBriefRevision: brief.revision, departmentId: 'department-general-medicine', expectedCaseRevision: source.case.revision,
      locationId: 'location-outpatient', visitDate: '2026-08-24', visitTypeId: 'visit-general',
    } }
    const started = new WorkflowService(database, fhir, commands, { tokenSecret: prepared.options.cursorSecret }).startSyntheticCase({
      ...start.request, brief, context: registrarContext, idempotencyKey: start.key, profile, syntheticCase: source.case,
    }).data
    const legacy = { patientId: started.patientId, admissionId: 'synthetic-legacy-admission',
      outpatientCaseId: started.outpatientCaseId, paymentId: 'synthetic-legacy-payment', receiptKey: 'synthetic-legacy-receipt' }
    commands.execute({ context, operation: 'synthetic.legacy.payment-chain', input: legacy, idempotencyKey: legacy.receiptKey,
      expectedVersions: {}, dataSchema: z.object({ admissionId: z.string(), paymentId: z.string() }) }, () => {
      database.driver.prepare(`UPDATE synthetic_case_instance SET status='completed',revision=revision+1 WHERE workspace_id=? AND case_id=?`)
        .run(scope.workspaceId, source.case.caseId)
      database.driver.prepare(`INSERT INTO inpatient_admission
        (workspace_id,epoch,admission_id,patient_id,inpatient_number,admission_route,source_case_id,ward_id,organization_id,status,financial_status,record_status,registered_at)
        VALUES(?,?,?,?,'SYN-OLD-001','direct',?,'ward-general','organization-inpatient-medicine','cleared','settled','archived',?)`)
        .run(scope.workspaceId, scope.epoch, legacy.admissionId, legacy.patientId, source.case.caseId, now)
      database.driver.prepare(`INSERT INTO inpatient_deposit VALUES(?,?,'legacy-deposit',?,10000,?)`)
        .run(scope.workspaceId, scope.epoch, legacy.admissionId, now)
      database.driver.prepare(`INSERT INTO inpatient_charge
        (workspace_id,epoch,charge_id,admission_id,organization_id,kind,source_id,service_date,amount_fen,virtual_time)
        VALUES(?,?,'legacy-charge',?,'organization-inpatient-medicine','bed','legacy-bed','2026-08-24',10000,?)`)
        .run(scope.workspaceId, scope.epoch, legacy.admissionId, now)
      const frozen = JSON.stringify({ synthetic: true, chargesFen: 10000, transactions: [{ id: 'legacy-deposit', amountFen: 10000 }] })
      database.driver.prepare(`INSERT INTO inpatient_settlement VALUES(?,?,'legacy-settlement',?,?,?)`)
        .run(scope.workspaceId, scope.epoch, legacy.admissionId, frozen, now)
      database.driver.prepare(`INSERT INTO inpatient_record_revision VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(scope.workspaceId, scope.epoch, legacy.admissionId, 1, 'synthetic-legacy-sources', frozen, '{}', context.actorId, 'practitioner-role-inpatient-doctor', now)
      database.driver.prepare(`INSERT INTO inpatient_record_review VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(scope.workspaceId, scope.epoch, legacy.admissionId, 'legacy-review', 1, 'synthetic-legacy-sources', 'approved', null,
          context.actorId, 'practitioner-role-medical-records', now)
      database.driver.prepare(`INSERT INTO inpatient_record_archive
        (workspace_id,epoch,admission_id,archive_id,revision,review_id,sources_hash,snapshot_json,actor_id,practitioner_role_id,recorded_at)
        VALUES(?,?,?,'legacy-archive',1,'legacy-review','synthetic-legacy-sources',?,?,?,?)`)
        .run(scope.workspaceId, scope.epoch, legacy.admissionId, frozen, context.actorId, 'practitioner-role-medical-records', now)
      database.driver.prepare(`UPDATE outpatient_case SET status='awaiting-lis',updated_at=? WHERE workspace_id=? AND epoch=? AND case_id=?`)
        .run(now, scope.workspaceId, scope.epoch, legacy.outpatientCaseId)
      database.driver.prepare(`INSERT INTO charge_record
        (workspace_id,epoch,charge_id,case_id,account_id,charge_item_id,category,source_reference,description_zh,description_en,quantity,unit_price_fen,total_fen,status,version,created_at)
        VALUES(?,?,'legacy-lab-charge',?,'legacy-account','legacy-lab-item','laboratory','ServiceRequest/legacy-lab','合成已付检验','Synthetic paid lab',1,6800,6800,'paid',2,?)`)
        .run(scope.workspaceId, scope.epoch, legacy.outpatientCaseId, now)
      database.driver.prepare(`INSERT INTO payment_preview
        (workspace_id,epoch,preview_id,case_id,charge_item_id,category,amount_fen,expected_charge_version,simulator_rule,token_hash,expires_at,consumed_at)
        VALUES(?,?,'legacy-preview',?,'legacy-lab-item','laboratory',6800,1,'success','synthetic-legacy-token',?,?)`)
        .run(scope.workspaceId, scope.epoch, legacy.outpatientCaseId, now, now)
      database.driver.prepare(`INSERT INTO payment_transaction
        (workspace_id,epoch,payment_id,case_id,category,amount_fen,outcome,correlation_id,preview_id,created_at,recovery_outcome)
        VALUES(?,?,?,?,'laboratory',6800,'success','synthetic-legacy-correlation','legacy-preview',?,'success')`)
        .run(scope.workspaceId, scope.epoch, legacy.paymentId, legacy.outpatientCaseId, now)
      database.driver.prepare(`INSERT INTO payment_allocation VALUES(?,?,?,'legacy-lab-item',6800)`)
        .run(scope.workspaceId, scope.epoch, legacy.paymentId)
      database.driver.prepare(`INSERT INTO payment_tender VALUES(?,?,?,'cash',6800,0)`)
        .run(scope.workspaceId, scope.epoch, legacy.paymentId)
      return { data: { admissionId: legacy.admissionId, paymentId: legacy.paymentId }, effects: [] }
    })
    if ((database.driver.pragma('foreign_key_check') as unknown[]).length !== 0) throw new Error('Synthetic pre-cutover fixture has invalid foreign keys')
    return { source, legacy, start }
  } finally {
    database.close()
  }
}
