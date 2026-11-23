import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import { frozenCatalogCoverageSchema } from './catalog-insurance-coverage.ts'
import type { ActorContext, CommandTransaction } from './command-executor.ts'
import { InpatientBilling, type InpatientEffects } from './inpatient-billing.ts'
import { WorkflowError } from './workflow-error.ts'

export function inpatientRequestOwner(database: ClinMeshDatabase, context: ActorContext, caseId: string) {
  return z.object({ admission_id: z.string(), patient_id: z.string(), organization_id: z.string(), ward_id: z.string(), status: z.string(), source_case_id: z.string().nullable() }).optional()
    .parse(database.driver.prepare('SELECT * FROM inpatient_admission WHERE workspace_id=? AND epoch=? AND admission_id=?').get(context.workspaceId, context.epoch, caseId))
}

export function assertInpatientRequestScope(database: ClinMeshDatabase, context: ActorContext, caseId: string, roles = ['inpatient-doctor', 'ward-nurse']) {
  const admission = inpatientRequestOwner(database, context, caseId)
  if (admission === undefined) return undefined
  if (!roles.includes(context.roleCode) || context.organizationId !== admission.organization_id || context.locationId !== admission.ward_id) {
    throw new WorkflowError('ROLE_NOT_ALLOWED', '当前科室或病区不负责本次住院检查')
  }
  return admission
}

/**
 * 现代门诊（带独立 Consultation）正式开单与用药结论前置门禁：
 * 住院申请（inpatient_admission）与无 Consultation 的首期兼容门诊跳过；
 * 强制先存在首版正式签署病历（CLINICAL_DOCUMENT_UNSIGNED），再存在有效已确认主诊断（DIAGNOSIS_UNCONFIRMED）。
 */
export function assertOutpatientOrderPrerequisites(
  database: ClinMeshDatabase,
  context: ActorContext,
  caseId: string,
): void {
  if (inpatientRequestOwner(database, context, caseId) !== undefined) return
  const consultation = database.driver.prepare(
    'SELECT 1 FROM consultation WHERE workspace_id = ? AND epoch = ? AND case_id = ?',
  ).get(context.workspaceId, context.epoch, caseId)
  if (consultation === undefined) return

  const signedRoot = database.driver.prepare(`
    SELECT 1 FROM signed_clinical_document
    WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND revision_of_document_id IS NULL
  `).get(context.workspaceId, context.epoch, caseId)
  if (signedRoot === undefined) {
    throw new WorkflowError(
      'CLINICAL_DOCUMENT_UNSIGNED',
      '正式开立医嘱或确认用药结论前，须先完成首版结构化门诊病历正式电子签名。',
    )
  }

  const confirmedPrimaryDiagnosis = database.driver.prepare(`
    SELECT 1
    FROM diagnosis_confirmation AS confirmation
    JOIN diagnosis_entry AS entry
      ON entry.workspace_id = confirmation.workspace_id
     AND entry.epoch = confirmation.epoch
     AND entry.confirmation_id = confirmation.confirmation_id
    WHERE confirmation.workspace_id = ? AND confirmation.epoch = ? AND confirmation.case_id = ?
      AND confirmation.revision_number = (
        SELECT MAX(revision_number) FROM diagnosis_confirmation
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      )
      AND entry.role = 'primary'
    LIMIT 1
  `).get(
    context.workspaceId,
    context.epoch,
    caseId,
    context.workspaceId,
    context.epoch,
    caseId,
  )
  if (confirmedPrimaryDiagnosis === undefined) {
    throw new WorkflowError(
      'DIAGNOSIS_UNCONFIRMED',
      '正式开立医嘱或确认用药结论前，须先确认至少一条有效主诊断。',
    )
  }
}

/** LIS/RIS 报告事务的费用适配；修订不经过首次完成入口。 */
export function recordInpatientInvestigationCharge(database: ClinMeshDatabase, transaction: CommandTransaction, context: ActorContext, requestId: string, now: string): InpatientEffects {
  const row = z.object({ admission_id: z.string(), organization_id: z.string(), financial_status: z.string(), status: z.string(), request_kind: z.enum(['laboratory', 'imaging', 'examination']), price_fen: z.number().int().nonnegative().safe(), charge_definition_json: z.string() }).optional()
    .parse(database.driver.prepare(`SELECT i.admission_id,a.organization_id,a.financial_status,a.status,r.request_kind,i.price_fen,i.charge_definition_json FROM inpatient_investigation i
      JOIN inpatient_admission a ON a.workspace_id=i.workspace_id AND a.epoch=i.epoch AND a.admission_id=i.admission_id
      JOIN laboratory_request r ON r.workspace_id=i.workspace_id AND r.epoch=i.epoch AND r.request_id=i.request_id
      WHERE i.workspace_id=? AND i.epoch=? AND i.request_id=?`).get(context.workspaceId, context.epoch, requestId))
  const effects: InpatientEffects = []
  if (row === undefined) return effects
  if(row.financial_status!=='open' || !['admitted','discharge-pending'].includes(row.status)) throw new WorkflowError('WORKFLOW_CONFLICT','住院已出区或结算，不能追加检查费用')
  const definition = z.object({ display: z.string().min(1), trigger: z.literal('execution-completed'), priceFen: z.number().int().nonnegative().safe(), insuranceCoverage: frozenCatalogCoverageSchema.optional() }).parse(JSON.parse(row.charge_definition_json))
  if (definition.priceFen !== row.price_fen) throw new WorkflowError('WORKFLOW_CONFLICT', '住院检查冻结价目不一致')
  new InpatientBilling(database, transaction.fhir).record(context, { admissionId: row.admission_id, organizationId: row.organization_id,
    kind: row.request_kind, sourceId: requestId, serviceDate: new Date(Date.parse(now) + 8 * 3_600_000).toISOString().slice(0, 10),
    amountFen: row.price_fen, virtualTime: now, label: definition.display,
    ...(definition.insuranceCoverage === undefined ? {} : { coverageJson: JSON.stringify(definition.insuranceCoverage) }) }, effects)
  return effects
}
