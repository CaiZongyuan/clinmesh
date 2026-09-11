import {
  agentToolsForContext,
  agentHumanRoleCodeSchema,
  agentViewIdSchema,
  agentViewsForRole,
  parseAgentToolInput,
  type AgentOperationId,
  type AgentPageContextClaim,
  type AgentPageContextSnapshot,
} from '@clinmesh/contracts/agent'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { SyntheticCaseRepository } from '../infrastructure/sqlite/synthetic-case-repository.ts'
import type { ActorContext } from './command-executor.ts'

const versionRowSchema = z.object({ version: z.union([z.number(), z.string()]) }).strict()
const scenarioRowSchema = z.object({ status: z.string(), version: z.string() }).strict()
const generationJobRowSchema = z.object({ status: z.string(), version: z.string() }).strict()
const triageCaseRowSchema = z.object({
  encounter_id: z.string(),
  has_triage: z.number().int(),
  status: z.string(),
  task_version: z.union([z.number(), z.string()]),
}).strict()
const doctorCaseRowSchema = z.object({
  clinical_document_draft_version: z.number().int().nullable(),
  encounter_id: z.string(),
  encounter_status: z.string(),
  encounter_version: z.union([z.number(), z.string()]),
  has_consultation: z.number().int(),
  has_correctable_laboratory: z.number().int(),
  has_diagnosis_draft: z.number().int(),
  has_laboratory_draft: z.number().int(),
  has_prescription_draft: z.number().int(),
  has_reported_laboratory: z.number().int(),
  has_signed_document: z.number().int(),
  has_cancellable_laboratory: z.number().int(),
  practitioner_role_id: z.string().nullable(),
  prescription_status: z.string().nullable(),
  status: z.string(),
}).strict()
const chargeRowSchema = z.object({
  case_id: z.string(),
  category: z.string(),
  status: z.string(),
  version: z.number().int(),
}).strict()
const prescriptionRowSchema = z.object({
  case_status: z.string(),
  has_review: z.number().int(),
  status: z.string(),
  version: z.number().int(),
}).strict()

type ResolvedSelection =
  | { kind: 'none' }
  | { kind: 'scenario-run'; id: string; status: string }
  | { kind: 'generation-job'; id: string; status: string }
  | { kind: 'patient'; id: string }
  | { kind: 'synthetic-case'; id: string; status: 'brief-ready' }
  | { kind: 'triage-item'; id: string; encounterId: string; status: string }
  | ({ kind: 'case'; id: string } & z.infer<typeof doctorCaseRowSchema>)
  | ({ kind: 'billing-item'; id: string } & z.infer<typeof chargeRowSchema>)
  | ({ kind: 'prescription'; id: string } & z.infer<typeof prescriptionRowSchema>)
  | { kind: 'encounter'; id: string; caseId: string }

export interface ResolvedAgentPageContext {
  allowedOperationIds: AgentOperationId[]
  selection: ResolvedSelection
}

const selectionKindsByView = {
  billing: ['billing-item'],
  consultation: ['case', 'encounter'],
  overview: ['scenario-run'],
  pharmacy: ['prescription'],
  registration: ['patient', 'synthetic-case'],
  scenarioData: ['generation-job'],
  settingsGeneral: [],
  triage: ['triage-item'],
  uiComponents: [],
} as const

const commonOperations = new Set<AgentOperationId>([
  'ui.context.read',
  'ui.navigate',
  'ui.panel.focus',
])

export function resolveAgentPageContext(
  database: ClinMeshDatabase,
  cases: SyntheticCaseRepository,
  actor: ActorContext,
  userAccountId: string,
  claim: AgentPageContextClaim,
): ResolvedAgentPageContext | undefined {
  const roleCode = agentHumanRoleCodeSchema.safeParse(actor.roleCode)
  if (!roleCode.success || !agentViewsForRole(roleCode.data).includes(claim.viewId)) return undefined
  const selection = resolveSelection(database, cases, actor, claim)
  if (selection === undefined || !draftMatchesSelection(claim, selection)) return undefined
  const allowed = new Set(agentToolsForContext(roleCode.data, claim.viewId)
    .map(definition => definition.operationId))
  const accountCanCorrectLaboratoryReport = roleCode.data === 'outpatient-doctor'
    && claim.viewId === 'consultation'
    && accountHasAdministratorRole(database, actor, userAccountId)
  narrowOperations(allowed, claim, selection, accountCanCorrectLaboratoryReport)
  return { allowedOperationIds: [...allowed], selection }
}

export function validateAgentToolInputForContext(
  database: ClinMeshDatabase,
  cases: SyntheticCaseRepository,
  context: AgentPageContextSnapshot,
  userAccountId: string,
  operationId: AgentOperationId,
  rawInput: unknown,
): unknown | undefined {
  let input: unknown
  try {
    input = parseAgentToolInput(operationId, rawInput)
  } catch {
    return undefined
  }
  const actor: ActorContext = {
    actorId: context.actor.actorId,
    epoch: context.workspace.epoch,
    practitionerRoleId: context.actor.practitionerRoleId,
    roleCode: context.actor.roleCode,
    scenarioRunId: context.workspace.scenarioRunId,
    workspaceId: context.workspace.id,
  }
  const current = resolveAgentPageContext(database, cases, actor, userAccountId, context.claim)
  if (current === undefined || !current.allowedOperationIds.includes(operationId)) return undefined
  if (!inputMatchesCurrentResources(database, cases, actor, context.claim, operationId, input)) {
    return undefined
  }
  return input
}

export const proposalCommandOperations: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'scenario.install.propose': ['scenario.install'],
  'scenario.reset.propose': ['scenario.reset'],
  'registration.patient.create.propose': ['patient.create-synthetic'],
  'registration.outpatient.propose': ['registration.register'],
  'registration.synthetic-case.start.propose': ['synthetic-case.start-outpatient-visit'],
  'triage.record.propose': ['encounter.record-triage'],
  'outpatient.visit.start.propose': ['encounter.start-first-visit', 'encounter.start-revisit'],
  'outpatient.diagnosis.confirm.propose': ['encounter.confirm-diagnosis'],
  'outpatient.laboratory.issue.propose': [
    'encounter.issue-laboratory-order',
    'laboratory-request.issue',
  ],
  'outpatient.laboratory.cancel.propose': ['laboratory-request.cancel'],
  'outpatient.report.acknowledge.propose': ['laboratory-report.acknowledge'],
  'outpatient.report.correct.propose': ['laboratory-report.correct'],
  'outpatient.prescription.issue.propose': ['encounter.issue-prescription'],
  'outpatient.prescription.withdraw.propose': ['prescription.withdraw'],
  'outpatient.medication.none.propose': ['encounter.confirm-no-medication'],
  'outpatient.record.sign.propose': ['clinical-document.sign', 'encounter.sign-and-complete'],
  'outpatient.record.revise.propose': ['clinical-document.revise'],
  'outpatient.encounter.complete.propose': ['encounter.complete'],
  'billing.payment.confirm.propose': ['payment.confirm'],
  'pharmacy.review.propose': ['prescription.review'],
  'pharmacy.dispense.propose': ['prescription.dispense'],
})

function resolveSelection(
  database: ClinMeshDatabase,
  cases: SyntheticCaseRepository,
  actor: ActorContext,
  claim: AgentPageContextClaim,
): ResolvedSelection | undefined {
  const selection = claim.selection
  if (selection === undefined) return { kind: 'none' }
  if (!(selectionKindsByView[claim.viewId] as readonly string[]).includes(selection.kind)) return undefined
  if (selection.version === undefined) return undefined
  const bindings = [actor.workspaceId, actor.epoch]

  if (selection.kind === 'scenario-run') {
    const row = scenarioRowSchema.optional().parse(database.driver.prepare(`
      SELECT status, epoch AS version FROM scenario_run
      WHERE workspace_id = ? AND epoch = ? AND scenario_run_id = ?
    `).get(...bindings, selection.id))
    if (row === undefined || selection.id !== actor.scenarioRunId || row.version !== selection.version) {
      return undefined
    }
    return { id: selection.id, kind: selection.kind, status: row.status }
  }
  if (selection.kind === 'generation-job') {
    const row = generationJobRowSchema.optional().parse(database.driver.prepare(`
      SELECT status, updated_at AS version FROM scenario_generation_job
      WHERE workspace_id = ? AND job_id = ?
    `).get(actor.workspaceId, selection.id))
    if (row === undefined || row.version !== selection.version) return undefined
    return { id: selection.id, kind: selection.kind, status: row.status }
  }
  if (selection.kind === 'synthetic-case') {
    const revision = cases.getRegistrationCandidateRevision(actor.workspaceId, selection.id)
    if (
      revision === undefined
      || String(revision) !== selection.version
    ) return undefined
    return { id: selection.id, kind: selection.kind, status: 'brief-ready' }
  }
  if (selection.kind === 'patient') {
    const row = versionRowSchema.optional().parse(database.driver.prepare(`
      SELECT version_id AS version FROM fhir_resource
      WHERE workspace_id = ? AND epoch = ? AND resource_type = 'Patient'
        AND resource_id = ? AND deleted = 0
    `).get(...bindings, selection.id))
    if (row === undefined || String(row.version) !== selection.version) return undefined
    return { id: selection.id, kind: selection.kind }
  }
  if (selection.kind === 'triage-item') {
    const row = triageCaseRowSchema.optional().parse(database.driver.prepare(`
      SELECT outpatient_case.encounter_id, outpatient_case.status,
        task.version_id AS task_version,
        EXISTS (
          SELECT 1 FROM triage_record
          WHERE triage_record.workspace_id = outpatient_case.workspace_id
            AND triage_record.epoch = outpatient_case.epoch
            AND triage_record.case_id = outpatient_case.case_id
        ) AS has_triage
      FROM outpatient_case
      JOIN fhir_resource AS task
        ON task.workspace_id = outpatient_case.workspace_id
       AND task.epoch = outpatient_case.epoch
       AND task.resource_type = 'Task'
       AND task.resource_id = outpatient_case.initial_task_id
      WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
        AND outpatient_case.case_id = ? AND outpatient_case.scenario_run_id = ?
    `).get(...bindings, selection.id, actor.scenarioRunId))
    if (
      row === undefined
      || String(row.task_version) !== selection.version
      || (claim.activeSection === 'pending' && row.status !== 'awaiting-triage')
      || (claim.activeSection === 'completed' && row.has_triage !== 1)
      || claim.activeSection === 'exception'
    ) return undefined
    return { encounterId: row.encounter_id, id: selection.id, kind: selection.kind, status: row.status }
  }
  if (selection.kind === 'case') {
    const row = doctorCaseRowSchema.optional().parse(database.driver.prepare(`
      SELECT outpatient_case.encounter_id, outpatient_case.status,
        encounter.version_id AS encounter_version,
        json_extract(encounter.content_json, '$.status') AS encounter_status,
        responsibility.practitioner_role_id,
        document_draft.version AS clinical_document_draft_version,
        prescription.status AS prescription_status,
        EXISTS (SELECT 1 FROM consultation WHERE consultation.workspace_id = outpatient_case.workspace_id
          AND consultation.epoch = outpatient_case.epoch AND consultation.case_id = outpatient_case.case_id) AS has_consultation,
        EXISTS (SELECT 1 FROM diagnosis_state WHERE diagnosis_state.workspace_id = outpatient_case.workspace_id
          AND diagnosis_state.epoch = outpatient_case.epoch AND diagnosis_state.case_id = outpatient_case.case_id
          AND diagnosis_state.status = 'draft' AND diagnosis_state.draft_json IS NOT NULL) AS has_diagnosis_draft,
        EXISTS (SELECT 1 FROM laboratory_request_state WHERE laboratory_request_state.workspace_id = outpatient_case.workspace_id
          AND laboratory_request_state.epoch = outpatient_case.epoch AND laboratory_request_state.case_id = outpatient_case.case_id
          AND laboratory_request_state.draft_catalog_item_id IS NOT NULL) AS has_laboratory_draft,
        EXISTS (SELECT 1 FROM prescription_draft_state WHERE prescription_draft_state.workspace_id = outpatient_case.workspace_id
          AND prescription_draft_state.epoch = outpatient_case.epoch AND prescription_draft_state.case_id = outpatient_case.case_id
          AND prescription_draft_state.draft_json IS NOT NULL) AS has_prescription_draft,
        EXISTS (SELECT 1 FROM laboratory_request WHERE laboratory_request.workspace_id = outpatient_case.workspace_id
          AND laboratory_request.epoch = outpatient_case.epoch AND laboratory_request.case_id = outpatient_case.case_id
          AND (laboratory_request.status = 'issued'
            OR (laboratory_request.status = 'generation-failed'
              AND laboratory_request.generation_error_code = 'INVESTIGATION_UNSUPPORTED')))
          AS has_cancellable_laboratory,
        EXISTS (SELECT 1 FROM laboratory_request WHERE laboratory_request.workspace_id = outpatient_case.workspace_id
          AND laboratory_request.epoch = outpatient_case.epoch AND laboratory_request.case_id = outpatient_case.case_id
          AND laboratory_request.status = 'reported') AS has_reported_laboratory,
        EXISTS (SELECT 1 FROM laboratory_request WHERE laboratory_request.workspace_id = outpatient_case.workspace_id
          AND laboratory_request.epoch = outpatient_case.epoch AND laboratory_request.case_id = outpatient_case.case_id
          AND laboratory_request.status IN ('reported', 'acknowledged')) AS has_correctable_laboratory,
        EXISTS (SELECT 1 FROM signed_clinical_document WHERE signed_clinical_document.workspace_id = outpatient_case.workspace_id
          AND signed_clinical_document.epoch = outpatient_case.epoch AND signed_clinical_document.case_id = outpatient_case.case_id) AS has_signed_document
      FROM outpatient_case
      JOIN fhir_resource AS encounter
        ON encounter.workspace_id = outpatient_case.workspace_id
       AND encounter.epoch = outpatient_case.epoch
       AND encounter.resource_type = 'Encounter'
       AND encounter.resource_id = outpatient_case.encounter_id
      LEFT JOIN outpatient_case_responsibility AS responsibility
        ON responsibility.workspace_id = outpatient_case.workspace_id
       AND responsibility.epoch = outpatient_case.epoch
       AND responsibility.case_id = outpatient_case.case_id
      LEFT JOIN clinical_document_draft AS document_draft
        ON document_draft.workspace_id = outpatient_case.workspace_id
       AND document_draft.epoch = outpatient_case.epoch
       AND document_draft.case_id = outpatient_case.case_id
      LEFT JOIN prescription
        ON prescription.workspace_id = outpatient_case.workspace_id
       AND prescription.epoch = outpatient_case.epoch
       AND prescription.case_id = outpatient_case.case_id
      WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
        AND outpatient_case.case_id = ? AND outpatient_case.scenario_run_id = ?
    `).get(...bindings, selection.id, actor.scenarioRunId))
    if (
      row === undefined
      || String(row.encounter_version) !== selection.version
      || row.encounter_status !== 'in-progress'
      || (
        row.status !== 'awaiting-doctor'
        && row.practitioner_role_id !== actor.practitionerRoleId
      )
    ) return undefined
    return { ...row, id: selection.id, kind: selection.kind }
  }
  if (selection.kind === 'billing-item') {
    const row = chargeRowSchema.optional().parse(database.driver.prepare(`
      SELECT case_id, category, status, version FROM charge_record
      WHERE workspace_id = ? AND epoch = ? AND charge_item_id = ?
    `).get(...bindings, selection.id))
    if (row === undefined || String(row.version) !== selection.version) return undefined
    const [category, visibleStatus] = claim.activeSection?.split(':') ?? []
    if (
      category !== row.category
      || (visibleStatus === 'pending' ? row.status !== 'billable' : visibleStatus !== row.status)
    ) return undefined
    return { ...row, id: selection.id, kind: selection.kind }
  }
  if (selection.kind === 'prescription') {
    const row = prescriptionRowSchema.optional().parse(database.driver.prepare(`
      SELECT prescription.status, prescription.version,
        outpatient_case.status AS case_status,
        EXISTS (
          SELECT 1 FROM prescription_review
          WHERE prescription_review.workspace_id = prescription.workspace_id
            AND prescription_review.epoch = prescription.epoch
            AND prescription_review.prescription_id = prescription.prescription_id
        ) AS has_review
      FROM prescription
      JOIN outpatient_case
        ON outpatient_case.workspace_id = prescription.workspace_id
       AND outpatient_case.epoch = prescription.epoch
       AND outpatient_case.case_id = prescription.case_id
      WHERE prescription.workspace_id = ? AND prescription.epoch = ?
        AND prescription.prescription_id = ?
    `).get(...bindings, selection.id))
    if (
      row === undefined
      || String(row.version) !== selection.version
      || (claim.activeSection === 'pending' && (
        row.case_status !== 'awaiting-dispense' || row.status !== 'paid'
      ))
      || (claim.activeSection === 'completed' && (
        row.case_status !== 'completed' || row.status !== 'dispensed'
      ))
      || claim.activeSection === 'exception'
    ) return undefined
    return { ...row, id: selection.id, kind: selection.kind }
  }
  if (selection.kind === 'encounter') {
    const row = z.object({ case_id: z.string(), version: z.union([z.number(), z.string()]) })
      .strict().optional().parse(database.driver.prepare(`
        SELECT outpatient_case.case_id, encounter.version_id AS version
        FROM outpatient_case
        JOIN fhir_resource AS encounter
          ON encounter.workspace_id = outpatient_case.workspace_id
         AND encounter.epoch = outpatient_case.epoch
         AND encounter.resource_type = 'Encounter'
         AND encounter.resource_id = outpatient_case.encounter_id
        WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
          AND outpatient_case.encounter_id = ?
      `).get(...bindings, selection.id))
    if (row === undefined || String(row.version) !== selection.version) return undefined
    return { caseId: row.case_id, id: selection.id, kind: selection.kind }
  }
  return undefined
}

function draftMatchesSelection(
  claim: AgentPageContextClaim,
  selection: ResolvedSelection,
): boolean {
  const draft = claim.draft
  if (draft === undefined) return true
  if (claim.viewId === 'registration') {
    if (selection.kind === 'none') return draft.kind === 'patient' && draft.id === 'new-patient'
    return (selection.kind === 'patient' || selection.kind === 'synthetic-case')
      && draft.kind === 'registration'
      && draft.id === selection.id
  }
  if (claim.viewId === 'triage' && selection.kind === 'triage-item') {
    return draft.kind === 'triage' && draft.id === `${selection.id}:triage`
  }
  if (claim.viewId === 'consultation' && selection.kind === 'case') {
    return draft.kind === 'clinical-document'
      && draft.id === `${selection.id}:clinical-document`
      && draft.revision === String(selection.clinical_document_draft_version ?? 0)
  }
  if (claim.viewId === 'pharmacy' && selection.kind === 'prescription') {
    const expectedKind = selection.has_review === 1 ? 'dispense' : 'pharmacy-review'
    return draft.kind === expectedKind && draft.id === `${selection.id}:pharmacy`
  }
  return false
}

function narrowOperations(
  allowed: Set<AgentOperationId>,
  claim: AgentPageContextClaim,
  selection: ResolvedSelection,
  accountCanCorrectLaboratoryReport: boolean,
): void {
  const retain = (operations: readonly AgentOperationId[]): void => {
    const selected = new Set([...commonOperations, ...operations])
    for (const operation of allowed) if (!selected.has(operation)) allowed.delete(operation)
  }
  if (claim.viewId === 'registration') {
    const operations: AgentOperationId[] = [
      'registration.patient.search',
      'registration.patient.select',
      'registration.patient.draft.set',
      'registration.draft.set',
      'registration.synthetic-case.search',
      'registration.synthetic-case.select',
    ]
    if (claim.draft?.kind === 'patient' && claim.draft.dirty) {
      operations.push('registration.patient.create.propose')
    }
    if (selection.kind === 'patient') operations.push('registration.outpatient.propose')
    if (selection.kind === 'synthetic-case') {
      operations.push('registration.synthetic-case.start.propose')
    }
    retain(operations)
    return
  }
  if (claim.viewId === 'triage') {
    const operations: AgentOperationId[] = ['triage.queue.read', 'triage.case.select']
    if (selection.kind === 'triage-item' && selection.status === 'awaiting-triage') {
      operations.push('triage.draft.set', 'triage.record.propose')
    }
    retain(operations)
    return
  }
  if (claim.viewId === 'consultation') {
    if (selection.kind !== 'case') {
      retain(['outpatient.case.select'])
      return
    }
    const operations: AgentOperationId[] = [
      'outpatient.case.read',
      'outpatient.case.select',
      'outpatient.section.select',
    ]
    if (selection.status === 'awaiting-doctor' || selection.status === 'awaiting-revisit') {
      operations.push('outpatient.visit.start.propose')
    }
    if (selection.status === 'first-visit') operations.push('outpatient.first-visit.draft.set')
    if (selection.status === 'revisit-draft') operations.push('outpatient.revisit.draft.set')
    if (selection.has_consultation === 1) {
      operations.push(
        'outpatient.consultation.ask',
        'outpatient.diagnosis.draft.set',
        'outpatient.diagnosis.confirm.propose',
        'outpatient.laboratory.draft.set',
        'outpatient.prescription.draft.set',
        'outpatient.record.draft.set',
        'outpatient.medication.none.propose',
        'outpatient.encounter.complete.propose',
      )
    }
    if (selection.has_laboratory_draft === 1 || selection.status === 'first-visit') {
      operations.push('outpatient.laboratory.issue.propose')
    }
    if (selection.has_cancellable_laboratory === 1) {
      operations.push('outpatient.laboratory.cancel.propose')
    }
    if (selection.has_reported_laboratory === 1) operations.push('outpatient.report.acknowledge.propose')
    if (selection.has_correctable_laboratory === 1 && accountCanCorrectLaboratoryReport) {
      operations.push('outpatient.report.correct.propose')
    }
    if (selection.has_prescription_draft === 1) operations.push('outpatient.prescription.issue.propose')
    if (selection.prescription_status === 'signed' || selection.prescription_status === 'paid') {
      operations.push('outpatient.prescription.withdraw.propose')
    }
    if (selection.clinical_document_draft_version !== null || selection.status === 'revisit-draft') {
      operations.push('outpatient.preview.request', 'outpatient.record.sign.propose')
    }
    if (selection.has_signed_document === 1) operations.push('outpatient.record.revise.propose')
    retain(operations)
    return
  }
  if (claim.viewId === 'billing') {
    const operations: AgentOperationId[] = ['billing.queue.read', 'billing.item.select']
    if (selection.kind === 'billing-item' && selection.status === 'billable') {
      operations.push('billing.payment.preview', 'billing.payment.confirm.propose')
    }
    retain(operations)
    return
  }
  if (claim.viewId === 'pharmacy') {
    const operations: AgentOperationId[] = ['pharmacy.queue.read', 'pharmacy.prescription.select']
    if (selection.kind === 'prescription' && selection.case_status === 'awaiting-dispense') {
      if (selection.has_review === 0) {
        operations.push('pharmacy.review.draft.set', 'pharmacy.review.propose')
      } else {
        operations.push('pharmacy.dispense.draft.set', 'pharmacy.dispense.propose')
      }
    }
    retain(operations)
  }
}

function accountHasAdministratorRole(
  database: ClinMeshDatabase,
  actor: ActorContext,
  userAccountId: string,
): boolean {
  return database.driver.prepare(`
    SELECT 1
    FROM workspace_membership AS membership
    JOIN membership_practitioner_role AS membership_role
      ON membership_role.membership_id = membership.membership_id
     AND membership_role.workspace_id = membership.workspace_id
    JOIN practitioner_role_binding AS role
      ON role.workspace_id = membership_role.workspace_id
     AND role.practitioner_role_id = membership_role.practitioner_role_id
    WHERE membership.workspace_id = ? AND membership.user_id = ?
      AND membership.actor_id = ? AND membership.status = 'active'
      AND role.role_code = 'administrator' AND role.active = 1
    LIMIT 1
  `).get(actor.workspaceId, userAccountId, actor.actorId) !== undefined
}

function inputMatchesCurrentResources(
  database: ClinMeshDatabase,
  cases: SyntheticCaseRepository,
  actor: ActorContext,
  claim: AgentPageContextClaim,
  operationId: AgentOperationId,
  input: unknown,
): boolean {
  const value = input as Record<string, unknown>
  const exists = (sql: string, ...bindings: unknown[]): boolean => database.driver.prepare(sql)
    .get(...bindings) !== undefined
  const scope = [actor.workspaceId, actor.epoch]
  if (operationId === 'ui.navigate') {
    const roleCode = agentHumanRoleCodeSchema.safeParse(actor.roleCode)
    const destination = agentViewIdSchema.safeParse(value.destination)
    return roleCode.success
      && destination.success
      && agentViewsForRole(roleCode.data).includes(destination.data)
  }
  if (operationId === 'registration.patient.select') {
    return exists(`SELECT 1 FROM fhir_resource WHERE workspace_id = ? AND epoch = ?
      AND resource_type = 'Patient' AND resource_id = ? AND deleted = 0`, ...scope, value.patientId)
  }
  if (operationId === 'registration.synthetic-case.select') {
    return cases.getRegistrationCandidateRevision(actor.workspaceId, String(value.caseId)) !== undefined
  }
  if (operationId === 'registration.draft.set') {
    return exists(`SELECT 1 FROM outpatient_catalog WHERE workspace_id = ? AND epoch = ?
      AND item_id = ? AND kind = 'department' AND active = 1`, ...scope, value.departmentId)
      && exists(`SELECT 1 FROM outpatient_catalog WHERE workspace_id = ? AND epoch = ?
        AND item_id = ? AND kind = 'visit-type' AND active = 1`, ...scope, value.visitTypeId)
      && exists(`SELECT 1 FROM fhir_resource WHERE workspace_id = ? AND epoch = ?
        AND resource_type = 'Location' AND resource_id = ? AND deleted = 0`, ...scope, value.locationId)
  }
  if (operationId === 'triage.case.select' || operationId === 'outpatient.case.select') {
    return exists(`SELECT 1 FROM outpatient_case WHERE workspace_id = ? AND epoch = ? AND case_id = ?`,
      ...scope, value.caseId)
  }
  if (
    operationId === 'outpatient.laboratory.cancel.propose'
    || operationId === 'outpatient.report.acknowledge.propose'
    || operationId === 'outpatient.report.correct.propose'
  ) {
    if (claim.selection?.kind !== 'case') return false
    if (operationId === 'outpatient.laboratory.cancel.propose') {
      return exists(`SELECT 1 FROM laboratory_request WHERE workspace_id = ? AND epoch = ?
        AND case_id = ? AND request_id = ?
        AND (status = 'issued'
          OR (status = 'generation-failed' AND generation_error_code = 'INVESTIGATION_UNSUPPORTED'))`,
      ...scope, claim.selection.id, value.requestId)
    }
    const statuses = operationId === 'outpatient.report.correct.propose'
      ? ['reported', 'acknowledged']
      : ['reported']
    return exists(`SELECT 1 FROM laboratory_request WHERE workspace_id = ? AND epoch = ?
      AND case_id = ? AND request_id = ? AND status IN (${statuses.map(() => '?').join(', ')})`,
    ...scope, claim.selection.id, value.requestId, ...statuses)
  }
  if (operationId === 'billing.item.select') {
    return exists(`SELECT 1 FROM charge_record WHERE workspace_id = ? AND epoch = ? AND charge_item_id = ?`,
      ...scope, value.chargeItemId)
  }
  if (operationId === 'pharmacy.prescription.select') {
    return exists(`SELECT 1 FROM prescription WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?`,
      ...scope, value.prescriptionId)
  }
  if (operationId === 'pharmacy.dispense.draft.set') {
    if (claim.selection?.kind !== 'prescription' || !Array.isArray(value.selections)) return false
    const prescriptionId = claim.selection.id
    return value.selections.every(entry => {
      const selection = entry as Record<string, unknown>
      return exists(`
        SELECT 1 FROM prescription_item AS item
        JOIN inventory_lot AS lot
          ON lot.workspace_id = item.workspace_id AND lot.epoch = item.epoch
         AND lot.medication_id = item.medication_id
        WHERE item.workspace_id = ? AND item.epoch = ? AND item.prescription_id = ?
          AND item.medication_request_id = ? AND lot.lot_id = ?
          AND lot.quantity_on_hand >= ?
      `, ...scope, prescriptionId, selection.medicationRequestId, selection.lotId, selection.quantity)
    })
  }
  return true
}
