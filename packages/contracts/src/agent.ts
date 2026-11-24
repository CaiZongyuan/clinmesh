import { z } from 'zod'
import {
  agentToolInputSchemas,
  agentViewIdSchema,
  isAgentOperationId,
  type AgentOperationId,
  type DoctorCaseSection,
  type InpatientStage,
} from './agent-tool-input.ts'
import { hisOperationIdSchema } from './his-operations-runtime.ts'
import { commandResponseSchema, doctorCaseDetailSchema, doctorQueueSchema, roleCodeSchema,
  caseExaminationServiceCatalogSchema, caseImagingServiceCatalogSchema, casePathologyServiceCatalogSchema } from './his.ts'

export * from './doctor-history.ts'

export {
  agentToolInputSchemas,
  agentViewIdSchema,
  clinicalOverrideToolParameters,
  doctorCaseSectionSchema,
  inpatientStageSchema,
  isAgentOperationId,
  parseAgentToolInput,
  type AgentOperationId,
  type DoctorCaseSection,
  type InpatientStage,
} from './agent-tool-input.ts'

export const agentHumanRoleCodeSchema = z.enum([
  'administrator',
  'cashier',
  'outpatient-doctor',
  'inpatient-doctor',
  'ward-nurse',
  'medical-records',
  'pharmacist',
  'registrar',
  'triage-nurse',
])

export const agentSelectionKindSchema = z.enum([
  'billing-item',
  'case',
  'encounter',
  'generation-job',
  'inpatient-admission',
  'patient',
  'prescription',
  'scenario-run',
  'synthetic-case',
  'triage-item',
])

export const agentDraftKindSchema = z.enum([
  'clinical-document',
  'diagnosis',
  'dispense',
  'first-visit',
  'inpatient-payment',
  'laboratory',
  'patient',
  'pharmacy-review',
  'prescription',
  'registration',
  'revisit',
  'triage',
])

const versionedSelectionSchema = z.object({
  id: z.string().trim().min(1).max(128),
  kind: agentSelectionKindSchema,
  version: z.string().trim().min(1).max(128).optional(),
}).strict()

const agentDraftReferenceSchema = z.object({
  dirty: z.boolean(),
  id: z.string().trim().min(1).max(160),
  kind: agentDraftKindSchema,
  revision: z.string().trim().min(1).max(128),
}).strict()

const agentPageUiStateSchema = z.object({
  search: z.string().max(100).optional(),
  status: z.enum(['empty', 'error', 'loading', 'ready']),
}).strict()

export const agentPageContextClaimSchema = z.object({
  taskEpoch: z.uuid().optional(),
  activeSection: z.string().trim().min(1).max(64).optional(),
  draft: agentDraftReferenceSchema.optional(),
  selection: versionedSelectionSchema.optional(),
  ui: agentPageUiStateSchema,
  version: z.literal(1),
  viewId: agentViewIdSchema,
  viewRevision: z.string().trim().min(1).max(128),
}).strict()

export const agentPageContextSnapshotSchema = z.object({
  actor: z.object({
    actorId: z.string().min(1),
    practitionerRoleId: z.string().min(1),
    roleCode: agentHumanRoleCodeSchema,
  }).strict(),
  allowedOperationIds: z.array(z.string().min(1)).max(32),
  claim: agentPageContextClaimSchema,
  dshSessionId: z.string().trim().min(1).max(256),
  expiresAt: z.iso.datetime({ offset: true }),
  id: z.string().min(1),
  issuedAt: z.iso.datetime({ offset: true }),
  scopeKey: z.string().trim().min(1).max(128),
  version: z.literal(1),
  workspace: z.object({
    epoch: z.string().min(1),
    id: z.string().min(1),
    scenarioRunId: z.string().min(1),
  }).strict(),
}).strict()

export const agentPageContextRequestSchema = z.object({
  claim: agentPageContextClaimSchema,
  client: z.object({
    id: z.string().trim().min(1).max(128),
    revision: z.number().int().positive(),
  }).strict(),
  dshSessionId: z.string().trim().min(1).max(256),
}).strict()

export const agentPageContextBindingSchema = z.object({
  snapshot: agentPageContextSnapshotSchema,
  token: z.string().min(32),
}).strict()

const agentExecutionBindingSchema = z.object({
  pageRevision: z.string().min(1).max(1024),
  scopeKey: z.string().trim().min(1).max(128),
}).strict()

export const doctorAgentTaskPermitPayloadSchema = agentExecutionBindingSchema.extend({
  contextId: z.string().min(1).max(128),
  dshSessionId: z.string().min(1).max(256),
  expiresAt: z.iso.datetime({ offset: true }),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.iso.datetime({ offset: true }),
  purpose: z.literal('clinmesh-doctor-input'),
  rpcId: z.string().min(1).max(256),
  taskId: z.uuid(),
  version: z.literal(2),
})

export const doctorAgentTaskPermitRequestSchema = z.object({
  contextToken: z.string().min(32),
  content: z.string().min(1).max(2000),
  rpcId: z.string().min(1).max(256),
}).strict()

export const doctorAgentTaskPermitResponseSchema = z.object({
  content: z.string().min(1).max(2000),
  dshSessionId: z.string().min(1).max(256),
  permit: z.string().min(32).max(8192),
  rpcId: z.string().min(1).max(256),
  taskId: z.uuid(),
}).strict()

export type DoctorAgentTaskPermitRequest = z.infer<typeof doctorAgentTaskPermitRequestSchema>
export type DoctorAgentTaskSubmission = z.infer<typeof doctorAgentTaskPermitResponseSchema>
export type DoctorAgentChatInput = Pick<DoctorAgentTaskSubmission, 'content' | 'dshSessionId' | 'rpcId'>

export const doctorRecordingSourceProofPayloadSchema = doctorAgentTaskPermitPayloadSchema.omit({ purpose: true, version: true }).extend({
  messageId: z.string().min(1).max(256),
  recordedAt: z.iso.datetime({ offset: true }),
  purpose: z.literal('clinmesh-doctor-recording-source'),
  version: z.literal(1),
}).strict()

export const doctorRecordingSourceRequestSchema = z.object({
  contextToken: z.string().min(32),
  content: z.string().min(1).max(2000),
  sourceProof: z.string().min(32).max(8192),
}).strict()

export const doctorRecordingSourceResponseSchema = commandResponseSchema(
  z.object({ caseId: z.string().min(1), sourceId: z.string().min(1) }).strict(),
)

export type DoctorRecordingSourceInput = DoctorAgentChatInput & { sourceProof: string }

export const agentExecutionProofPayloadSchema = z.object({
  callId: z.string().trim().min(1).max(256),
  contextId: z.string().trim().min(1).max(128),
  dshSessionId: z.string().trim().min(1).max(256),
  expiresAt: z.iso.datetime({ offset: true }),
  issuedAt: z.iso.datetime({ offset: true }),
  pageRevision: z.string().min(1).max(1024),
  origin: z.object({
    request: agentExecutionBindingSchema,
    task: agentExecutionBindingSchema.extend({
      messageId: z.string().trim().min(1).max(256),
      acceptedAt: z.iso.datetime({ offset: true }),
      rpcId: z.string().trim().min(1).max(256),
      contextId: z.string().min(1).max(128).optional(),
      delegationId: z.uuid().optional(),
      delegationInputHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      turn: z.number().int().positive(),
    }),
  }).strict().optional(),
  scopeKey: z.string().trim().min(1).max(128),
  toolName: z.string().regex(/^clinmesh_[a-z0-9_]+$/).max(64),
  version: z.literal(3),
}).strict()

export const agentToolAuthorizationRequestSchema = z.object({
  contextToken: z.string().min(32),
  executionProof: z.string().min(32),
  input: z.json(),
  operationId: z.string().trim().min(1).max(128),
}).strict().superRefine((value, context) => {
  if (!isAgentOperationId(value.operationId)) {
    context.addIssue({ code: 'custom', message: 'The Agent operation is not registered', path: ['operationId'] })
    return
  }
  const parsed = agentToolInputSchemas[value.operationId].safeParse(value.input)
  if (parsed.success) return
  for (const issue of parsed.error.issues) {
    context.addIssue({ ...issue, path: ['input', ...issue.path] })
  }
})

export const agentToolAuthorizationResponseSchema = z.object({
  callId: z.string().min(1),
  context: agentPageContextSnapshotSchema,
  dshSessionId: z.string().min(1),
  operationId: z.string().min(1),
  proposalId: z.string().min(1).optional(),
  receiptToken: z.string().min(32),
  status: z.literal('authorized'),
}).strict()

export const agentToolResultRequestSchema = z.object({
  error: z.string().max(2048).optional(),
  ok: z.boolean(),
  receiptToken: z.string().min(32),
  result: z.json().optional(),
}).strict().superRefine((value, context) => {
  if (value.ok && value.error !== undefined) {
    context.addIssue({ code: 'custom', message: 'A successful Tool result cannot include an error' })
  }
})

export const agentDoctorQueryRequestSchema = z.object({
  contextToken: z.string().min(32),
  receiptToken: z.string().min(32),
  input: z.json(),
}).strict()

export const agentDoctorCaseReadSchema = doctorCaseDetailSchema.extend({
  examinationServices: caseExaminationServiceCatalogSchema.shape.items.nullable().default(null),
  imagingServices: caseImagingServiceCatalogSchema.shape.items.nullable(),
  pathologyServices: casePathologyServiceCatalogSchema.shape.items.nullable(),
  queue: doctorQueueSchema.nullable(),
})

export const agentReviewDecisionRequestSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  receiptToken: z.string().min(32),
}).strict()

export const agentReviewDecisionResponseSchema = z.object({
  decidedAt: z.iso.datetime({ offset: true }),
  decision: z.enum(['approved', 'rejected']),
  proposalId: z.string().min(1),
}).strict()

export const agentToolCompletionResponseSchema = z.object({
  auditId: z.string().min(1).optional(),
  proposalStatus: z.enum(['approved', 'rejected']).optional(),
  requestId: z.string().min(1).optional(),
  status: z.enum(['completed', 'failed']),
  traceId: z.string().min(1).optional(),
}).strict()

export type AgentHumanRoleCode = z.infer<typeof agentHumanRoleCodeSchema>
export type AgentViewId = z.infer<typeof agentViewIdSchema>
export type AgentPageContextClaim = z.infer<typeof agentPageContextClaimSchema>

export function agentPageBindingRevision(claim: AgentPageContextClaim): string {
  return JSON.stringify([
    claim.viewRevision,
    claim.draft === undefined
      ? null
      : [claim.draft.kind, claim.draft.id, claim.draft.revision, claim.draft.dirty],
  ])
}

export type AgentPageContextRequest = z.infer<typeof agentPageContextRequestSchema>
export type AgentPageContextSnapshot = z.infer<typeof agentPageContextSnapshotSchema>
export type AgentPageContextBinding = z.infer<typeof agentPageContextBindingSchema>
export type AgentToolAuthorizationRequest = z.infer<typeof agentToolAuthorizationRequestSchema>
export type AgentToolAuthorizationResponse = z.infer<typeof agentToolAuthorizationResponseSchema>
export type AgentToolResultRequest = z.infer<typeof agentToolResultRequestSchema>
export type AgentReviewDecisionRequest = z.infer<typeof agentReviewDecisionRequestSchema>
export type AgentReviewDecisionResponse = z.infer<typeof agentReviewDecisionResponseSchema>
export type AgentToolCompletionResponse = z.infer<typeof agentToolCompletionResponseSchema>

export type AgentOperationMode = 'draft' | 'preview' | 'proposal' | 'query' | 'ui'
export type AgentOperationRisk = 'draft-only' | 'human-review' | 'read-only' | 'ui-only'

export interface AgentToolDefinition {
  mode: AgentOperationMode
  operationId: AgentOperationId
  risk: AgentOperationRisk
  roleCodes: readonly AgentHumanRoleCode[]
  /** 只在这些诊疗栏目或住院环节之一为当前栏目时发布；缺省表示在所属 view 的每个栏目都发布。 */
  sections?: readonly (DoctorCaseSection | InpatientStage)[]
  toolName: string
  viewIds: readonly AgentViewId[]
}

const allRoles = agentHumanRoleCodeSchema.options
const allViews = agentViewIdSchema.options

function defineAgentTool(definition: AgentToolDefinition): AgentToolDefinition {
  return Object.freeze({
    ...definition,
    roleCodes: Object.freeze([...definition.roleCodes]),
    ...(definition.sections === undefined ? {} : { sections: Object.freeze([...definition.sections]) }),
    viewIds: Object.freeze([...definition.viewIds]),
  })
}

function tool(
  operationId: AgentOperationId,
  toolName: string,
  mode: AgentOperationMode,
  roleCodes: readonly AgentHumanRoleCode[],
  viewIds: readonly AgentViewId[],
  sectionOrSections?: DoctorCaseSection | InpatientStage | readonly (DoctorCaseSection | InpatientStage)[],
): AgentToolDefinition {
  const risk: AgentOperationRisk = mode === 'proposal' ? 'human-review' : mode === 'draft' ? 'draft-only' : mode === 'ui' ? 'ui-only' : 'read-only'
  const sections = sectionOrSections === undefined
    ? undefined
    : typeof sectionOrSections === 'string'
      ? [sectionOrSections]
      : sectionOrSections
  return defineAgentTool({
    mode,
    operationId,
    risk,
    roleCodes,
    ...(sections === undefined ? {} : { sections }),
    toolName,
    viewIds,
  })
}

const doctor = ['outpatient-doctor'] as const
const administrator = ['administrator'] as const
const registrar = ['registrar'] as const
const triage = ['triage-nurse'] as const
const cashier = ['cashier'] as const
const pharmacist = ['pharmacist'] as const
const ipDoc = ['inpatient-doctor'] as const
const ipClinical = ['inpatient-doctor', 'ward-nurse', 'medical-records'] as const
const consultationView = ['consultation'] as const
const inpatientView = ['inpatient'] as const
const registrationView = ['registration'] as const
const triageView = ['triage'] as const
const billingView = ['billing'] as const
const pharmacyView = ['pharmacy'] as const
const scenarioView = ['scenarioData'] as const

const sharedAgentViews = ['settingsGeneral', 'uiComponents'] as const
const agentRoleViews: Readonly<Record<AgentHumanRoleCode, readonly AgentViewId[]>> = Object.freeze({
  administrator: Object.freeze(['scenarioData', ...sharedAgentViews] as const),
  cashier: Object.freeze(['billing', 'inpatient', ...sharedAgentViews] as const),
  'outpatient-doctor': Object.freeze(['consultation', ...sharedAgentViews] as const),
  'inpatient-doctor': Object.freeze(['inpatient', ...sharedAgentViews] as const),
  'ward-nurse': Object.freeze(['inpatient', ...sharedAgentViews] as const),
  'medical-records': Object.freeze(['inpatient', ...sharedAgentViews] as const),
  pharmacist: Object.freeze(['pharmacy', ...sharedAgentViews] as const),
  registrar: Object.freeze(['registration', ...sharedAgentViews] as const),
  'triage-nurse': Object.freeze(['triage', ...sharedAgentViews] as const),
})

export function agentViewsForRole(roleCode: AgentHumanRoleCode): readonly AgentViewId[] {
  return agentRoleViews[roleCode]
}

export const agentToolCatalog: readonly AgentToolDefinition[] = Object.freeze([
  tool('ui.context.read', 'clinmesh_read_current_context', 'query', allRoles, allViews),
  tool('ui.navigate', 'clinmesh_navigate', 'ui', allRoles, allViews),
  tool('ui.panel.focus', 'clinmesh_focus_panel', 'ui', allRoles, allViews),
  tool('inpatient.stage.select', 'clinmesh_select_inpatient_stage', 'ui', ['inpatient-doctor', 'ward-nurse', 'cashier', 'medical-records'], inpatientView),
  tool('inpatient.surgery.read', 'clinmesh_read_inpatient_surgeries', 'query', ipClinical, inpatientView, ['surgery', 'record']),
  tool('inpatient.angiography-reports.read', 'clinmesh_read_inpatient_angiography_reports', 'query', ipClinical, inpatientView, ['investigations', 'surgery', 'record']),
  tool('inpatient.clinical-scores.read', 'clinmesh_read_inpatient_clinical_scores', 'query', ipClinical, inpatientView, ['admission', 'orders', 'surgery', 'discharge', 'record']),
  tool('inpatient.clinical-fact-ledger.read', 'clinmesh_read_inpatient_clinical_fact_ledger', 'query', ipDoc, inpatientView, ['admission', 'orders', 'surgery', 'discharge', 'record']),
  tool('inpatient.guideline-topics.read', 'clinmesh_read_inpatient_guideline_topics', 'query', ipClinical, inpatientView, ['orders', 'surgery', 'discharge', 'record']),
  tool('inpatient.clinical-quality.read', 'clinmesh_read_inpatient_clinical_quality', 'query', ipDoc, inpatientView, ['orders', 'surgery', 'discharge', 'record']),
  tool('inpatient.order-set-drafts.read', 'clinmesh_read_inpatient_order_set_drafts', 'query', ipDoc, inpatientView, ['orders', 'investigations']),
  tool('inpatient.order.verify.propose', 'clinmesh_prepare_verify_inpatient_order', 'proposal', ['ward-nurse'], inpatientView, 'orders'),
  tool('inpatient.report.acknowledge.propose', 'clinmesh_prepare_acknowledge_inpatient_report', 'proposal', ipDoc, inpatientView, 'investigations'),
  tool('inpatient.payment.draft.set', 'clinmesh_fill_inpatient_payment_draft', 'draft', cashier, inpatientView, 'discharge'),
  tool('inpatient.payment.preview', 'clinmesh_preview_inpatient_payment', 'preview', cashier, inpatientView, 'discharge'),
  tool('inpatient.settlement.preview', 'clinmesh_preview_inpatient_settlement', 'preview', cashier, inpatientView, 'discharge'),

  tool('scenario.status.read', 'clinmesh_read_scenario_status', 'query', administrator, scenarioView),
  tool('scenario.providers.read', 'clinmesh_read_scenario_providers', 'query', administrator, scenarioView),
  tool('scenario.generation.status.read', 'clinmesh_read_generation_status', 'query', administrator, scenarioView),
  tool('scenario.reset.propose', 'clinmesh_prepare_scenario_reset', 'proposal', administrator, scenarioView),

  tool('registration.patient.search', 'clinmesh_search_patients', 'query', registrar, registrationView),
  tool('registration.patient.select', 'clinmesh_select_registration_patient', 'ui', registrar, registrationView),
  tool('registration.patient.draft.set', 'clinmesh_fill_patient_draft', 'draft', registrar, registrationView),
  tool('registration.draft.set', 'clinmesh_fill_registration_draft', 'draft', registrar, registrationView),
  tool('registration.patient.create.propose', 'clinmesh_prepare_create_patient', 'proposal', registrar, registrationView),
  tool('registration.outpatient.propose', 'clinmesh_prepare_register_outpatient', 'proposal', registrar, registrationView),
  tool('registration.synthetic-case.search', 'clinmesh_search_registration_cases', 'query', registrar, registrationView),
  tool('registration.synthetic-case.select', 'clinmesh_select_registration_case', 'ui', registrar, registrationView),
  tool('registration.synthetic-case.start.propose', 'clinmesh_prepare_start_registration_case', 'proposal', registrar, registrationView),

  tool('triage.queue.read', 'clinmesh_read_triage_queue', 'query', triage, triageView),
  tool('triage.case.select', 'clinmesh_select_triage_case', 'ui', triage, triageView),
  tool('triage.draft.set', 'clinmesh_fill_triage_draft', 'draft', triage, triageView),
  tool('triage.record.propose', 'clinmesh_prepare_record_triage', 'proposal', triage, triageView),

  tool('outpatient.case.read', 'clinmesh_read_doctor_context', 'query', doctor, consultationView),
  tool('outpatient.history.search', 'clinmesh_search_doctor_history', 'query', doctor, consultationView),
  tool('outpatient.history.read', 'clinmesh_read_doctor_history', 'query', doctor, consultationView),
  tool('outpatient.clinical-scores.read', 'clinmesh_read_clinical_scores', 'query', doctor, consultationView, ['diagnosis', 'prescription']),
  tool('outpatient.clinical-fact-ledger.read', 'clinmesh_read_clinical_fact_ledger', 'query', doctor, consultationView, ['diagnosis', 'prescription']),
  tool('outpatient.guideline-topics.read', 'clinmesh_read_guideline_topics', 'query', doctor, consultationView, ['diagnosis', 'prescription']),
  tool('outpatient.clinical-quality.read', 'clinmesh_read_clinical_quality', 'query', doctor, consultationView, ['diagnosis', 'prescription', 'record']),
  tool('outpatient.order-set-drafts.read', 'clinmesh_read_order_set_drafts', 'query', doctor, consultationView, ['diagnosis', 'prescription']),
  tool('outpatient.case.select', 'clinmesh_select_doctor_case', 'ui', doctor, consultationView),
  tool('outpatient.section.select', 'clinmesh_select_doctor_section', 'ui', doctor, consultationView),
  tool('outpatient.consultation.ask', 'clinmesh_ask_virtual_patient', 'draft', doctor, consultationView, 'consultation'),
  tool('outpatient.consultation.reply.retry', 'clinmesh_retry_patient_reply', 'draft', doctor, consultationView, 'consultation'),
  tool('outpatient.first-visit.draft.set', 'clinmesh_fill_first_visit_draft', 'draft', doctor, consultationView),
  tool('outpatient.diagnosis.draft.set', 'clinmesh_fill_diagnosis_draft', 'draft', doctor, consultationView, 'diagnosis'),
  tool('outpatient.laboratory.draft.set', 'clinmesh_fill_laboratory_draft', 'draft', doctor, consultationView, 'laboratory'),
  tool('outpatient.prescription.draft.set', 'clinmesh_fill_prescription_draft', 'draft', doctor, consultationView, 'prescription'),
  tool('outpatient.record.draft.set', 'clinmesh_fill_clinical_document_draft', 'draft', doctor, consultationView, 'record'),
  tool('outpatient.revisit.draft.set', 'clinmesh_fill_revisit_draft', 'draft', doctor, consultationView),
  tool('outpatient.preview.request', 'clinmesh_request_preview', 'preview', doctor, consultationView, 'record'),
  tool('outpatient.visit.start.propose', 'clinmesh_prepare_start_visit', 'proposal', doctor, consultationView),
  tool('outpatient.diagnosis.confirm.propose', 'clinmesh_prepare_confirm_diagnosis', 'proposal', doctor, consultationView, 'diagnosis'),
  tool('outpatient.laboratory.issue.propose', 'clinmesh_prepare_issue_laboratory', 'proposal', doctor, consultationView, 'laboratory'),
  tool('outpatient.laboratory.cancel.propose', 'clinmesh_prepare_cancel_laboratory', 'proposal', doctor, consultationView, 'laboratory'),
  tool('outpatient.report.acknowledge.propose', 'clinmesh_prepare_acknowledge_report', 'proposal', doctor, consultationView, 'laboratory'),
  tool('outpatient.report.correct.propose', 'clinmesh_prepare_correct_report', 'proposal', doctor, consultationView, 'laboratory'),
  tool('outpatient.examination.draft.set', 'clinmesh_fill_examination_draft', 'draft', doctor, consultationView, 'laboratory'),
  tool('outpatient.examination.issue.propose', 'clinmesh_prepare_issue_examination', 'proposal', doctor, consultationView, 'laboratory'),
  tool('outpatient.examination.cancel.propose', 'clinmesh_prepare_cancel_examination', 'proposal', doctor, consultationView, 'laboratory'),
  tool('outpatient.examination.retry.propose', 'clinmesh_prepare_retry_examination', 'proposal', doctor, consultationView, 'laboratory'),
  tool('outpatient.imaging.draft.set', 'clinmesh_fill_imaging_draft', 'draft', doctor, consultationView, 'laboratory'),
  tool('outpatient.imaging.issue.propose', 'clinmesh_prepare_issue_imaging', 'proposal', doctor, consultationView, 'laboratory'),
  tool('outpatient.imaging.cancel.propose', 'clinmesh_prepare_cancel_imaging', 'proposal', doctor, consultationView, 'laboratory'),
  tool('outpatient.imaging.retry.propose', 'clinmesh_prepare_retry_imaging', 'proposal', doctor, consultationView, 'laboratory'),
  tool('outpatient.imaging.correct.propose', 'clinmesh_prepare_correct_imaging_report', 'proposal', doctor, consultationView, 'laboratory'),
  tool('outpatient.pathology.draft.set', 'clinmesh_fill_pathology_draft', 'draft', doctor, consultationView, 'laboratory'),
  tool('outpatient.pathology.issue.propose', 'clinmesh_prepare_issue_pathology', 'proposal', doctor, consultationView, 'laboratory'),
  tool('outpatient.pathology.cancel.propose', 'clinmesh_prepare_cancel_pathology', 'proposal', doctor, consultationView, 'laboratory'),
  tool('outpatient.pathology.retry.propose', 'clinmesh_prepare_retry_pathology', 'proposal', doctor, consultationView, 'laboratory'),
  tool('outpatient.pathology.correct.propose', 'clinmesh_prepare_correct_pathology_report', 'proposal', doctor, consultationView, 'laboratory'),
  tool('outpatient.prescription.issue.propose', 'clinmesh_prepare_issue_prescription', 'proposal', doctor, consultationView, 'prescription'),
  tool('outpatient.prescription.withdraw.propose', 'clinmesh_prepare_withdraw_prescription', 'proposal', doctor, consultationView, 'prescription'),
  tool('outpatient.medication.none.propose', 'clinmesh_prepare_no_medication', 'proposal', doctor, consultationView, 'prescription'),
  tool('outpatient.record.sign.propose', 'clinmesh_prepare_sign_document', 'proposal', doctor, consultationView, 'record'),
  tool('outpatient.record.revise.propose', 'clinmesh_prepare_revise_document', 'proposal', doctor, consultationView, 'record'),
  tool('outpatient.encounter.complete.propose', 'clinmesh_prepare_complete_encounter', 'proposal', doctor, consultationView),

  tool('billing.queue.read', 'clinmesh_read_billing_queue', 'query', cashier, billingView),
  tool('billing.case.read', 'clinmesh_read_billing_case', 'query', cashier, billingView),
  tool('billing.item.select', 'clinmesh_select_billing_item', 'ui', cashier, billingView),
  tool('billing.payment.preview', 'clinmesh_preview_payment', 'preview', cashier, billingView),
  tool('billing.payment.confirm.propose', 'clinmesh_prepare_confirm_payment', 'proposal', cashier, billingView),
  tool('billing.payment.recover.propose', 'clinmesh_prepare_recover_payment', 'proposal', cashier, billingView),

  tool('pharmacy.queue.read', 'clinmesh_read_pharmacy_queue', 'query', pharmacist, pharmacyView),
  tool('pharmacy.prescription.select', 'clinmesh_select_pharmacy_prescription', 'ui', pharmacist, pharmacyView),
  tool('pharmacy.review.draft.set', 'clinmesh_fill_pharmacy_review', 'draft', pharmacist, pharmacyView),
  tool('pharmacy.dispense.draft.set', 'clinmesh_fill_dispense_draft', 'draft', pharmacist, pharmacyView),
  tool('pharmacy.review.propose', 'clinmesh_prepare_review_prescription', 'proposal', pharmacist, pharmacyView),
  tool('pharmacy.dispense.propose', 'clinmesh_prepare_dispense', 'proposal', pharmacist, pharmacyView),
])

/**
 * 当前岗位、view 与栏目可发布的 Tool；Server 签发 Page Context 与 Surface 注册都使用它。
 * 带栏目的 Tool 只在 `activeSection` 命中其 `sections` 时发布，未声明栏目的 Tool 在每个栏目都发布。
 */
export function agentToolsForContext(
  roleCode: AgentHumanRoleCode,
  viewId: AgentViewId,
  activeSection?: string,
): readonly AgentToolDefinition[] {
  return agentToolCatalog.filter(definition => (
    definition.roleCodes.includes(roleCode)
    && definition.viewIds.includes(viewId)
    && (definition.sections === undefined || (activeSection !== undefined && (definition.sections as readonly string[]).includes(activeSection)))
  ))
}

export function isDoctorReadOperation(operationId: string): boolean {
  return operationId === 'ui.context.read' || operationId === 'outpatient.case.read'
    || operationId === 'outpatient.history.search' || operationId === 'outpatient.history.read'
    || operationId === 'outpatient.clinical-scores.read' || operationId === 'outpatient.clinical-fact-ledger.read'
    || operationId === 'outpatient.guideline-topics.read'
    || operationId === 'outpatient.clinical-quality.read' || operationId === 'outpatient.order-set-drafts.read'
}

export function usesDoctorReadBinding(snapshot: AgentPageContextSnapshot, operationId: string): boolean {
  return isDoctorReadOperation(operationId) && snapshot.actor.roleCode === 'outpatient-doctor'
    && snapshot.claim.viewId === 'consultation' && snapshot.claim.selection?.kind === 'case'
}

export function hasSameDoctorCase(left: AgentPageContextSnapshot, right: AgentPageContextSnapshot): boolean {
  return left.claim.viewId === 'consultation' && right.claim.viewId === 'consultation'
    && left.claim.selection?.kind === 'case' && right.claim.selection?.kind === 'case'
    && left.claim.selection.id === right.claim.selection.id
    && left.claim.taskEpoch === right.claim.taskEpoch
    && left.actor.roleCode === 'outpatient-doctor' && right.actor.roleCode === 'outpatient-doctor'
    && left.actor.actorId === right.actor.actorId && left.actor.practitionerRoleId === right.actor.practitionerRoleId
    && left.dshSessionId === right.dshSessionId && left.workspace.id === right.workspace.id
    && left.workspace.epoch === right.workspace.epoch && left.workspace.scenarioRunId === right.workspace.scenarioRunId
}

export const agentClientSchema = z.object({
  actorId: z.string().min(1),
  agentClientId: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  name: z.string().min(1).max(100),
  status: z.enum(['active', 'disabled']),
}).strict()

export const agentClientListSchema = z.object({
  items: z.array(agentClientSchema),
}).strict()

export const createAgentClientInputSchema = z.object({
  name: z.string().trim().min(2).max(100),
}).strict()

export const agentCapabilityGrantSchema = z.object({
  agentClientId: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }),
  grantId: z.uuid(),
  operationIds: z.array(hisOperationIdSchema).min(1),
  practitionerRoleId: z.string().min(1),
  token: z.string().regex(/^cma_[a-f0-9]{40}$/),
}).strict()

export const agentCapabilityGrantViewSchema = z.object({
  agentClientId: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  grantId: z.uuid(),
  operationIds: z.array(hisOperationIdSchema).min(1),
  practitionerRoleId: z.string().min(1),
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
  status: z.enum(['active', 'expired', 'invalidated', 'revoked']),
}).strict()

export const agentCapabilityGrantListSchema = z.object({
  items: z.array(agentCapabilityGrantViewSchema),
}).strict()

export const createAgentCapabilityGrantInputSchema = z.object({
  agentClientId: z.uuid(),
  operationIds: z.array(hisOperationIdSchema).min(1),
  practitionerRoleId: z.string().min(1),
  ttlSeconds: z.number().int().min(60).max(86_400),
}).strict()

export const revokedAgentCapabilityGrantSchema = z.object({
  grantId: z.uuid(),
  revokedAt: z.iso.datetime({ offset: true }),
  status: z.literal('revoked'),
}).strict()

export const agentCapabilityContextSchema = z.object({
  actor: z.object({
    actorId: z.string().min(1),
    epoch: z.string().min(1),
    locationId: z.string().min(1),
    organizationId: z.string().min(1),
    practitionerId: z.string().min(1),
    practitionerRoleId: z.string().min(1),
    roleCode: roleCodeSchema,
    scenarioRunId: z.string().min(1),
    workspaceId: z.string().min(1),
  }).strict(),
  agent: z.object({
    agentClientId: z.uuid(),
    name: z.string().min(1),
  }).strict(),
  grant: z.object({
    expiresAt: z.iso.datetime({ offset: true }),
    grantId: z.uuid(),
    operationIds: z.array(hisOperationIdSchema).min(1),
    policyVersion: z.number().int().positive(),
  }).strict(),
}).strict()
