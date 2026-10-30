import { createHash } from 'node:crypto'
import { z } from 'zod'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import type { ClinMeshDatabase } from './database.ts'
import { FhirRepository } from './fhir-repository.ts'
import { readRegistrationNumberState } from './registration-numbering.ts'

export const paymentCutoverMigration = '0103_payment-collection-cutover.sql'
const legacyPaymentTables = [
  'payment_transaction', 'payment_allocation', 'payment_tender', 'payment_resolution', 'refund_preview',
  'inpatient_payment_attempt', 'inpatient_payment_resolution', 'inpatient_settlement_supplement_refund',
] as const

function tableExists(database: ClinMeshDatabase, table: string) {
  return database.driver.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table) !== undefined
}

const preservedTables = [
  'account', 'action_trace', 'agent_client', 'ai_model_binding', 'audit_head', 'audit_log', 'auth_session_context',
  'imaging_case_binding', 'imaging_case_preparation', 'investigation_result_snapshot', 'membership_practitioner_role',
  'model_usage_attempt', 'model_usage_control', 'model_usage_control_rejection', 'model_usage_correction_audit',
  'model_usage_daily', 'model_usage_dimension', 'model_usage_dimension_reservation', 'model_usage_request_reservation',
  'model_usage_retention', 'pathology_case_binding', 'pathology_case_preparation', 'patient_persona_job', 'patient_persona_revision',
  'practitioner_role_binding', 'registration_number_authority', 'registration_number_counter', 'runtime_metadata',
  'scenario_definition', 'scenario_generation_job', 'session', 'synthetic_case_instance', 'synthetic_case_truth',
  'synthetic_case_visible_history', 'synthetic_case_visible_resource', 'synthetic_patient_profile',
  'synthetic_patient_profile_batch', 'synthetic_patient_profile_revision', 'user', 'verification', 'workspace_actor',
  'workspace_membership', 'laboratory_service_publication_job', 'laboratory_service_publication_candidate',
] as const
const configurationTables = [
  'diagnosis_catalog', 'hospital_service_catalog', 'inpatient_ward', 'inpatient_bed', 'inpatient_surgery_catalog',
  'outpatient_catalog', 'scenario_epoch_state', 'scenario_hidden_fact', 'scenario_reveal_policy', 'scenario_simulator_rule',
] as const
const runtimeTables = [
  'agent_capability_grant', 'agent_grant_operation', 'agent_page_context', 'agent_proposal', 'agent_review_decision', 'agent_tool_call',
  'charge_record', 'clinical_document_agent_content', 'clinical_document_draft', 'clinical_document_quality',
  'clinical_document_quality_review', 'clinical_document_sign_preview', 'clinical_draft', 'clinical_request_context', 'clinical_sign_preview',
  'collection_resolution', 'collection_tender', 'collection_transaction', 'consultation', 'consultation_history_addition',
  'consultation_history_addition_batch', 'consultation_recording', 'consultation_recording_batch', 'consultation_recording_candidate_failure',
  'consultation_recording_job', 'consultation_recording_source', 'consultation_recording_verification', 'consultation_reply_attempt',
  'consultation_reply_intent', 'consultation_turn', 'diagnosis_confirmation', 'diagnosis_entry', 'diagnosis_state', 'dispense',
  'doctor_consideration_disposition', 'doctor_recommendation_execution', 'doctor_recommendation_execution_continue',
  'doctor_recommendation_execution_plan', 'doctor_recommendation_execution_unit', 'doctor_recommendation_state', 'financial_charge_adjustment',
  'imaging_report_content', 'imaging_request_detail', 'imaging_request_state', 'imaging_study', 'inpatient_admission', 'inpatient_bed_occupancy',
  'inpatient_charge', 'inpatient_collection_supplement_refund', 'inpatient_deposit', 'inpatient_diagnosis_confirmation', 'inpatient_diagnosis_entry',
  'inpatient_discharge_event', 'inpatient_dispense', 'inpatient_drg_agent_analysis', 'inpatient_drg_agent_plan', 'inpatient_drg_followup',
  'inpatient_drg_payer_review', 'inpatient_drg_review', 'inpatient_drg_review_action', 'inpatient_drg_review_revision', 'inpatient_drg_review_todo',
  'inpatient_execution', 'inpatient_financial_adjustment', 'inpatient_financial_refund_preview', 'inpatient_insurance_adjustment',
  'inpatient_insurance_adjustment_preview', 'inpatient_investigation', 'inpatient_material_estimate', 'inpatient_material_reservation',
  'inpatient_order', 'inpatient_order_verification', 'inpatient_payment_allocation', 'inpatient_payment_attempt', 'inpatient_payment_preview',
  'inpatient_payment_resolution', 'inpatient_pci_selection', 'inpatient_postoperative_order', 'inpatient_record_archive', 'inpatient_record_number',
  'inpatient_record_review', 'inpatient_record_revision', 'inpatient_referral', 'inpatient_refund_preview', 'inpatient_settlement',
  'inpatient_settlement_supplement_refund', 'inpatient_settlement_transaction', 'inpatient_surgery_execution', 'inpatient_surgery_material',
  'inpatient_surgery_material_correction', 'inpatient_surgery_material_record', 'inpatient_surgery_request', 'inpatient_transfer',
  'insurance_event', 'insurance_preview', 'inventory_movement', 'laboratory_report_acknowledgement', 'laboratory_report_revision',
  'laboratory_request', 'laboratory_request_state', 'model_host_wait', 'model_reply_wait', 'model_task_step', 'model_task_wait',
  'no_medication_conclusion', 'outbox_event', 'outpatient_case', 'outpatient_case_responsibility', 'outpatient_investigation_billing',
  'outpatient_payment_allocation', 'outpatient_refund_preview', 'pathology_report_content', 'pathology_request_detail', 'pathology_request_state',
  'pathology_study', 'payment_allocation', 'payment_preview', 'payment_resolution', 'payment_tender', 'payment_transaction',
  'prescription', 'prescription_authorship', 'prescription_draft_state', 'prescription_item', 'prescription_review', 'prescription_withdrawal',
  'refund_preview', 'refund_resolution', 'refund_tender', 'refund_transaction', 'registration', 'signed_clinical_document',
  'synthetic_case_materialization', 'synthetic_patient_materialization', 'triage_record',
] as const
const environmentTypes = ['Organization', 'Practitioner', 'PractitionerRole', 'Location', 'Medication']
const retainedFhirTypes = [...environmentTypes, 'AuditEvent'].map(value => `'${value}'`).join(',')
const retainedReceipt = [
  'model-usage.%', 'scenario.%', 'scenario-generation-job.%', 'patient-persona-job.%', 'patient-persona-revision.%',
  'synthetic-patient-profile.%', 'synthetic-case.pci-source.prepare', 'laboratory-service-defaults.%',
  'laboratory-service-publication.%', 'imaging-preparation.%', 'pathology-preparation.%', 'agent-client.%',
].map(operation => `operation LIKE '${operation}'`).join(' OR ')
const rowSchema = z.record(z.string(), z.unknown())
const rowsSchema = z.array(rowSchema)
const columnsSchema = z.array(z.object({ name: z.string(), pk: z.number() }))
const epochSchema = z.object({ workspaceId: z.string(), fromEpoch: z.string(), toEpoch: z.string(), scenarioRunId: z.string(), scenarioId: z.string() })

function identifier(value: string) { return `"${value.replaceAll('"', '""')}"` }
function tableColumns(database: ClinMeshDatabase, table: string) {
  return columnsSchema.parse(database.driver.prepare(`PRAGMA table_info(${identifier(table)})`).all())
}
function rows(database: ClinMeshDatabase, table: string, where = '1') {
  const columns = tableColumns(database, table)
  const keys = columns.filter(column => column.pk > 0).toSorted((a, b) => a.pk - b.pk)
  return rowsSchema.parse(database.driver.prepare(`SELECT * FROM ${identifier(table)} WHERE ${where}
    ORDER BY ${(keys.length === 0 ? columns : keys).map(column => identifier(column.name)).join(',')}`).all())
}
function fingerprint(database: ClinMeshDatabase, table: string, where = '1') {
  const content = rows(database, table, where).map(row => table === 'synthetic_case_instance'
    ? Object.fromEntries(Object.entries(row).filter(([key]) => !['status', 'revision', 'updated_at'].includes(key))) : row)
  return { table, count: content.length, contentHash: createHash('sha256').update(JSON.stringify(content)).digest('hex') }
}

export interface PaymentCutoverReport {
  epochs: Array<{ workspaceId: string; fromEpoch: string; toEpoch: string }>
  preserved: Array<{ table: string; count: number; contentHash: string }>
  discarded: Array<{ table: string; count: number }>
}

export function assertPaymentCutoverAllowed(database: ClinMeshDatabase) {
  if (database.driver.prepare('SELECT 1 FROM schema_migration WHERE migration_id=?').get(paymentCutoverMigration) !== undefined) {
    throw new Error('PAYMENT_CUTOVER_ALREADY_APPLIED: 本次开发切换已完成，禁止再次舍弃运行数据。')
  }
  if (tableExists(database, 'collection_transaction')
    && database.driver.prepare('SELECT 1 FROM collection_transaction LIMIT 1').get() !== undefined) {
    throw new Error('PAYMENT_CUTOVER_NEW_MONEY: 已存在新模型交易，必须保留原款、未决尝试和回执；不能执行旧合成数据切换。')
  }
  for (const table of ['scenario_generation_job', 'patient_persona_job', 'laboratory_service_publication_job']) {
    if (tableExists(database, table) && database.driver.prepare(`SELECT 1 FROM ${table} WHERE status IN ('queued','running') LIMIT 1`).get() !== undefined) {
      throw new Error(`PAYMENT_CUTOVER_BUSY: ${table} 仍有未完成来源任务；先等待任务结束并停止服务。`)
    }
  }
  const invalidContext = database.driver.prepare(`SELECT 1 FROM workspace w WHERE w.active_epoch IS NULL OR NOT EXISTS (
    SELECT 1 FROM workspace_epoch e JOIN scenario_epoch_state s USING(workspace_id,epoch)
      JOIN scenario_run r USING(workspace_id,epoch,scenario_run_id)
    WHERE e.workspace_id=w.workspace_id AND e.epoch=w.active_epoch AND e.state='active'
  ) LIMIT 1`).get()
  if (invalidContext !== undefined) throw new Error('PAYMENT_CUTOVER_CONTEXT_INVALID: 活动世代或场景配置缺失，保留原库并修复后再切换。')
}

/** The caller holds the migration write transaction with FK enforcement deferred until its final check. */
export function discardLegacyPaymentRuntime(database: ClinMeshDatabase): PaymentCutoverReport {
  assertPaymentCutoverAllowed(database)
  readRegistrationNumberState(database)
  const known = new Set<string>([...preservedTables, ...configurationTables, ...runtimeTables,
    'command_effect', 'command_receipt', 'fhir_history', 'fhir_resource', 'fhir_sp_string', 'inventory_lot',
    'workspace', 'workspace_epoch', 'scenario_run', 'schema_migration'])
  const tables = z.array(z.object({ name: z.string() })).parse(database.driver.prepare(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).all()).map(row => row.name)
  const unknown = tables.filter(table => !known.has(table))
  if (unknown.length > 0) throw new Error(`PAYMENT_CUTOVER_UNKNOWN_TABLE: 未登记保留边界：${unknown.join(', ')}`)

  const unchanged = preservedTables.map(table => ({ table, where: '1' }))
  const configuration = configurationTables.map(table => ({ table, where: '1' }))
  const selective = [
    ...['command_effect', 'command_receipt'].map(table => ({ table, where: retainedReceipt })),
    ...['fhir_resource', 'fhir_history', 'fhir_sp_string'].map(table => ({ table, where: `resource_type IN (${retainedFhirTypes})` })),
  ]
  const retained = [...unchanged, ...configuration, ...selective]
  const preserved = retained.map(({ table, where }) => fingerprint(database, table, where))
  const epochs = z.array(epochSchema).parse(database.driver.prepare(`
    SELECT w.workspace_id AS workspaceId,w.active_epoch AS fromEpoch,e.scenario_id AS scenarioId,
      'epoch-'||(SELECT COUNT(*)+1 FROM workspace_epoch prior WHERE prior.workspace_id=w.workspace_id) AS toEpoch,
      'scenario-run-'||(SELECT COUNT(*)+1 FROM workspace_epoch prior WHERE prior.workspace_id=w.workspace_id) AS scenarioRunId
    FROM workspace w JOIN workspace_epoch e ON e.workspace_id=w.workspace_id AND e.epoch=w.active_epoch
  `).all())
  const inventory = rowsSchema.parse(database.driver.prepare(`SELECT lot.*,
    lot.quantity_on_hand + COALESCE((SELECT SUM(m.quantity) FROM inventory_movement m
      WHERE m.workspace_id=lot.workspace_id AND m.epoch=lot.epoch AND m.lot_id=lot.lot_id),0) AS initial_quantity,
    (SELECT content_json FROM fhir_resource f WHERE f.workspace_id=lot.workspace_id AND f.epoch=lot.epoch
      AND f.resource_type='InventoryItem' AND f.resource_id=lot.lot_id) AS resource_json
    FROM inventory_lot lot JOIN workspace w ON w.workspace_id=lot.workspace_id AND w.active_epoch=lot.epoch`).all())
  const discarded = runtimeTables.map(table => ({ table, count: z.object({ count: z.number() }).parse(
    database.driver.prepare(`SELECT COUNT(*) AS count FROM ${identifier(table)}`).get()).count }))
  for (const table of runtimeTables) database.driver.exec(`DELETE FROM ${identifier(table)}`)
  for (const table of ['command_effect', 'command_receipt']) database.driver.exec(`DELETE FROM ${table} WHERE NOT (${retainedReceipt})`)
  for (const table of ['fhir_sp_string', 'fhir_history', 'fhir_resource']) database.driver.exec(`DELETE FROM ${table} WHERE resource_type NOT IN (${retainedFhirTypes})`)
  database.driver.exec('DELETE FROM inventory_lot')
  const now = new Date().toISOString()
  database.driver.prepare(`UPDATE synthetic_case_instance SET
    status=CASE WHEN active_brief_revision IS NULL THEN 'brief-pending' ELSE 'brief-ready' END,
    revision=revision+1,updated_at=? WHERE status IN ('started','completed')`).run(now)

  // Prove the exact original identities and bytes before adding new-generation configuration rows.
  retained.forEach(({ table, where }, index) => {
    if (JSON.stringify(fingerprint(database, table, where)) !== JSON.stringify(preserved[index])) {
      throw new Error(`PAYMENT_CUTOVER_RETENTION_FAILED: ${table}`)
    }
  })
  for (const epoch of epochs) {
    const { workspaceId, fromEpoch, toEpoch, scenarioId, scenarioRunId } = epoch
    database.driver.prepare("INSERT INTO workspace_epoch(workspace_id,epoch,state,scenario_id,created_at,activated_at) VALUES(?,?,'building',?,?,?)")
      .run(workspaceId, toEpoch, scenarioId, now, now)
    database.driver.prepare("INSERT INTO scenario_run(workspace_id,epoch,scenario_run_id,scenario_id,status,started_at) VALUES(?,?,?,?,'active',?)")
      .run(workspaceId, toEpoch, scenarioRunId, scenarioId, now)
    for (const table of configurationTables) {
      const columns = tableColumns(database, table).map(column => column.name)
      const projected = columns.map(column => column === 'epoch' ? '?' : column === 'scenario_run_id' ? '?' : identifier(column))
      const parameters = columns.flatMap(column => column === 'epoch' ? [toEpoch] : column === 'scenario_run_id' ? [scenarioRunId] : [])
      database.driver.prepare(`INSERT INTO ${identifier(table)} (${columns.map(identifier).join(',')})
        SELECT ${projected.join(',')} FROM ${identifier(table)} WHERE workspace_id=? AND epoch=?`)
        .run(...parameters, workspaceId, fromEpoch)
    }
    for (const table of ['fhir_resource', 'fhir_history', 'fhir_sp_string']) {
      const columns = tableColumns(database, table).map(column => column.name)
      database.driver.prepare(`INSERT INTO ${table} (${columns.map(identifier).join(',')})
        SELECT ${columns.map(column => column === 'epoch' ? '?' : identifier(column)).join(',')} FROM ${table}
        WHERE workspace_id=? AND epoch=? AND resource_type IN (${environmentTypes.map(type => `'${type}'`).join(',')})`)
        .run(toEpoch, workspaceId, fromEpoch)
    }
    for (const lot of inventory.filter(row => row.workspace_id === workspaceId)) {
      database.driver.prepare(`INSERT INTO inventory_lot(workspace_id,epoch,lot_id,medication_id,location_id,lot_number,expires_on,quantity_on_hand,version)
        VALUES(?,?,?,?,?,?,?,?,1)`).run(workspaceId, toEpoch, lot.lot_id, lot.medication_id, lot.location_id, lot.lot_number, lot.expires_on, lot.initial_quantity)
      if (typeof lot.resource_json !== 'string') throw new Error('PAYMENT_CUTOVER_INVENTORY_PROJECTION_MISSING')
      const resource = rowSchema.parse(JSON.parse(lot.resource_json))
      new FhirRepository(database).createProjection({ workspaceId, epoch: toEpoch }, fhirResourceSchema.parse({
        ...resource, netContent: { ...rowSchema.parse(resource.netContent), value: lot.initial_quantity },
      }))
    }
    database.driver.prepare('INSERT INTO audit_head(workspace_id,epoch,sequence,hash) VALUES(?,?,0,?)').run(workspaceId, toEpoch, '0'.repeat(64))
    database.driver.prepare("UPDATE scenario_run SET status='closed',completed_at=? WHERE workspace_id=? AND status='active' AND epoch!=?").run(now, workspaceId, toEpoch)
    database.driver.prepare("UPDATE workspace_epoch SET state='closed',closed_at=? WHERE workspace_id=? AND epoch!=? AND state!='closed'").run(now, workspaceId, toEpoch)
    database.driver.prepare("UPDATE workspace_epoch SET state='active' WHERE workspace_id=? AND epoch=?").run(workspaceId, toEpoch)
    database.driver.prepare('UPDATE workspace SET active_epoch=? WHERE workspace_id=?').run(toEpoch, workspaceId)
  }
  readRegistrationNumberState(database)
  return { epochs: epochs.map(({ workspaceId, fromEpoch, toEpoch }) => ({ workspaceId, fromEpoch, toEpoch })), preserved, discarded }
}

export function assertPaymentUpgradeAllowed(database: ClinMeshDatabase) {
  const legacy: string[] = legacyPaymentTables.filter(table => tableExists(database, table)
    && database.driver.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get() !== undefined)
  for (const [table, sourceId] of [['inpatient_deposit', 'transaction_id'], ['refund_transaction', 'source_id']] as const) {
    if (!tableExists(database, table)) continue
    const unlinked = tableExists(database, 'collection_transaction')
      ? database.driver.prepare(`SELECT 1 FROM ${table} source WHERE NOT EXISTS (
        SELECT 1 FROM collection_transaction payment WHERE payment.workspace_id=source.workspace_id
          AND payment.epoch=source.epoch AND payment.payment_id=source.${sourceId}
      ) LIMIT 1`).get()
      : database.driver.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()
    if (unlinked !== undefined) legacy.push(table)
  }
  if (legacy.length > 0) throw new Error(`PAYMENT_CUTOVER_REQUIRED: 旧合成资金仍存在（${legacy.join(', ')}）。停止服务，备份后显式执行 db payment-cutover；正常迁移不会清空运行数据。`)
}
