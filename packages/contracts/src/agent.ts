import { z } from 'zod'
import {
  agentToolInputSchemas,
  agentViewIdSchema,
  isAgentOperationId,
  type AgentOperationId,
} from './agent-tool-input.ts'

export {
  agentToolInputSchemas,
  agentViewIdSchema,
  isAgentOperationId,
  parseAgentToolInput,
  type AgentOperationId,
} from './agent-tool-input.ts'

export const agentHumanRoleCodeSchema = z.enum([
  'administrator',
  'cashier',
  'outpatient-doctor',
  'pharmacist',
  'registrar',
  'triage-nurse',
])

export const agentSelectionKindSchema = z.enum([
  'billing-item',
  'case',
  'encounter',
  'generation-job',
  'patient',
  'prescription',
  'scenario-run',
  'triage-item',
])

export const agentDraftKindSchema = z.enum([
  'clinical-document',
  'diagnosis',
  'dispense',
  'first-visit',
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

export const agentExecutionProofPayloadSchema = z.object({
  callId: z.string().trim().min(1).max(256),
  dshSessionId: z.string().trim().min(1).max(256),
  expiresAt: z.iso.datetime({ offset: true }),
  issuedAt: z.iso.datetime({ offset: true }),
  scopeKey: z.string().trim().min(1).max(128),
  toolName: z.string().regex(/^clinmesh_[a-z0-9_]+$/).max(64),
  version: z.literal(1),
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
  toolName: string
  viewIds: readonly AgentViewId[]
}

const allRoles = agentHumanRoleCodeSchema.options
const allViews = agentViewIdSchema.options

function defineAgentTool(definition: AgentToolDefinition): AgentToolDefinition {
  return Object.freeze({
    ...definition,
    roleCodes: Object.freeze([...definition.roleCodes]),
    viewIds: Object.freeze([...definition.viewIds]),
  })
}

function tool(
  operationId: AgentOperationId,
  toolName: string,
  mode: AgentOperationMode,
  risk: AgentOperationRisk,
  roleCodes: readonly AgentHumanRoleCode[],
  viewIds: readonly AgentViewId[],
): AgentToolDefinition {
  return defineAgentTool({ mode, operationId, risk, roleCodes, toolName, viewIds })
}

const doctor = ['outpatient-doctor'] as const
const administrator = ['administrator'] as const
const registrar = ['registrar'] as const
const triage = ['triage-nurse'] as const
const cashier = ['cashier'] as const
const pharmacist = ['pharmacist'] as const

const sharedAgentViews = ['settingsGeneral', 'uiComponents'] as const
const agentRoleViews: Readonly<Record<AgentHumanRoleCode, readonly AgentViewId[]>> = Object.freeze({
  administrator: Object.freeze(['overview', 'scenarioData', ...sharedAgentViews] as const),
  cashier: Object.freeze(['billing', ...sharedAgentViews] as const),
  'outpatient-doctor': Object.freeze(['consultation', ...sharedAgentViews] as const),
  pharmacist: Object.freeze(['pharmacy', ...sharedAgentViews] as const),
  registrar: Object.freeze(['registration', ...sharedAgentViews] as const),
  'triage-nurse': Object.freeze(['triage', ...sharedAgentViews] as const),
})

export function agentViewsForRole(roleCode: AgentHumanRoleCode): readonly AgentViewId[] {
  return agentRoleViews[roleCode]
}

export const agentToolCatalog: readonly AgentToolDefinition[] = Object.freeze([
  tool('ui.context.read', 'clinmesh_read_current_context', 'query', 'read-only', allRoles, allViews),
  tool('ui.navigate', 'clinmesh_navigate', 'ui', 'ui-only', allRoles, allViews),
  tool('ui.panel.focus', 'clinmesh_focus_panel', 'ui', 'ui-only', allRoles, allViews),

  tool('scenario.status.read', 'clinmesh_read_scenario_status', 'query', 'read-only', administrator, ['overview']),
  tool('scenario.providers.read', 'clinmesh_read_scenario_providers', 'query', 'read-only', administrator, ['scenarioData']),
  tool('scenario.generation.status.read', 'clinmesh_read_generation_status', 'query', 'read-only', administrator, ['scenarioData']),
  tool('scenario.install.propose', 'clinmesh_prepare_scenario_install', 'proposal', 'human-review', administrator, ['overview']),
  tool('scenario.reset.propose', 'clinmesh_prepare_scenario_reset', 'proposal', 'human-review', administrator, ['overview']),

  tool('registration.patient.search', 'clinmesh_search_patients', 'query', 'read-only', registrar, ['registration']),
  tool('registration.patient.select', 'clinmesh_select_registration_patient', 'ui', 'ui-only', registrar, ['registration']),
  tool('registration.patient.draft.set', 'clinmesh_fill_patient_draft', 'draft', 'draft-only', registrar, ['registration']),
  tool('registration.draft.set', 'clinmesh_fill_registration_draft', 'draft', 'draft-only', registrar, ['registration']),
  tool('registration.patient.create.propose', 'clinmesh_prepare_create_patient', 'proposal', 'human-review', registrar, ['registration']),
  tool('registration.outpatient.propose', 'clinmesh_prepare_register_outpatient', 'proposal', 'human-review', registrar, ['registration']),

  tool('triage.queue.read', 'clinmesh_read_triage_queue', 'query', 'read-only', triage, ['triage']),
  tool('triage.case.select', 'clinmesh_select_triage_case', 'ui', 'ui-only', triage, ['triage']),
  tool('triage.draft.set', 'clinmesh_fill_triage_draft', 'draft', 'draft-only', triage, ['triage']),
  tool('triage.record.propose', 'clinmesh_prepare_record_triage', 'proposal', 'human-review', triage, ['triage']),

  tool('outpatient.case.read', 'clinmesh_read_doctor_context', 'query', 'read-only', doctor, ['consultation']),
  tool('outpatient.case.select', 'clinmesh_select_doctor_case', 'ui', 'ui-only', doctor, ['consultation']),
  tool('outpatient.section.select', 'clinmesh_select_doctor_section', 'ui', 'ui-only', doctor, ['consultation']),
  tool('outpatient.consultation.ask', 'clinmesh_ask_virtual_patient', 'draft', 'draft-only', doctor, ['consultation']),
  tool('outpatient.first-visit.draft.set', 'clinmesh_fill_first_visit_draft', 'draft', 'draft-only', doctor, ['consultation']),
  tool('outpatient.diagnosis.draft.set', 'clinmesh_fill_diagnosis_draft', 'draft', 'draft-only', doctor, ['consultation']),
  tool('outpatient.laboratory.draft.set', 'clinmesh_fill_laboratory_draft', 'draft', 'draft-only', doctor, ['consultation']),
  tool('outpatient.prescription.draft.set', 'clinmesh_fill_prescription_draft', 'draft', 'draft-only', doctor, ['consultation']),
  tool('outpatient.record.draft.set', 'clinmesh_fill_clinical_document_draft', 'draft', 'draft-only', doctor, ['consultation']),
  tool('outpatient.revisit.draft.set', 'clinmesh_fill_revisit_draft', 'draft', 'draft-only', doctor, ['consultation']),
  tool('outpatient.preview.request', 'clinmesh_request_preview', 'preview', 'read-only', doctor, ['consultation']),
  tool('outpatient.visit.start.propose', 'clinmesh_prepare_start_visit', 'proposal', 'human-review', doctor, ['consultation']),
  tool('outpatient.diagnosis.confirm.propose', 'clinmesh_prepare_confirm_diagnosis', 'proposal', 'human-review', doctor, ['consultation']),
  tool('outpatient.laboratory.issue.propose', 'clinmesh_prepare_issue_laboratory', 'proposal', 'human-review', doctor, ['consultation']),
  tool('outpatient.laboratory.cancel.propose', 'clinmesh_prepare_cancel_laboratory', 'proposal', 'human-review', doctor, ['consultation']),
  tool('outpatient.report.acknowledge.propose', 'clinmesh_prepare_acknowledge_report', 'proposal', 'human-review', doctor, ['consultation']),
  tool('outpatient.report.correct.propose', 'clinmesh_prepare_correct_report', 'proposal', 'human-review', doctor, ['consultation']),
  tool('outpatient.prescription.issue.propose', 'clinmesh_prepare_issue_prescription', 'proposal', 'human-review', doctor, ['consultation']),
  tool('outpatient.prescription.withdraw.propose', 'clinmesh_prepare_withdraw_prescription', 'proposal', 'human-review', doctor, ['consultation']),
  tool('outpatient.medication.none.propose', 'clinmesh_prepare_no_medication', 'proposal', 'human-review', doctor, ['consultation']),
  tool('outpatient.record.sign.propose', 'clinmesh_prepare_sign_document', 'proposal', 'human-review', doctor, ['consultation']),
  tool('outpatient.record.revise.propose', 'clinmesh_prepare_revise_document', 'proposal', 'human-review', doctor, ['consultation']),
  tool('outpatient.encounter.complete.propose', 'clinmesh_prepare_complete_encounter', 'proposal', 'human-review', doctor, ['consultation']),

  tool('billing.queue.read', 'clinmesh_read_billing_queue', 'query', 'read-only', cashier, ['billing']),
  tool('billing.item.select', 'clinmesh_select_billing_item', 'ui', 'ui-only', cashier, ['billing']),
  tool('billing.payment.preview', 'clinmesh_preview_payment', 'preview', 'read-only', cashier, ['billing']),
  tool('billing.payment.confirm.propose', 'clinmesh_prepare_confirm_payment', 'proposal', 'human-review', cashier, ['billing']),

  tool('pharmacy.queue.read', 'clinmesh_read_pharmacy_queue', 'query', 'read-only', pharmacist, ['pharmacy']),
  tool('pharmacy.prescription.select', 'clinmesh_select_pharmacy_prescription', 'ui', 'ui-only', pharmacist, ['pharmacy']),
  tool('pharmacy.review.draft.set', 'clinmesh_fill_pharmacy_review', 'draft', 'draft-only', pharmacist, ['pharmacy']),
  tool('pharmacy.dispense.draft.set', 'clinmesh_fill_dispense_draft', 'draft', 'draft-only', pharmacist, ['pharmacy']),
  tool('pharmacy.review.propose', 'clinmesh_prepare_review_prescription', 'proposal', 'human-review', pharmacist, ['pharmacy']),
  tool('pharmacy.dispense.propose', 'clinmesh_prepare_dispense', 'proposal', 'human-review', pharmacist, ['pharmacy']),
])

export function agentToolsForContext(
  roleCode: AgentHumanRoleCode,
  viewId: AgentViewId,
): readonly AgentToolDefinition[] {
  return agentToolCatalog.filter(definition => (
    definition.roleCodes.includes(roleCode)
    && definition.viewIds.includes(viewId)
  ))
}
