import { z } from 'zod'
import {
  clinicalDocumentContentSchema,
  diagnosisDraftContentSchema,
  laboratoryRequestCatalogItemIdSchema,
  prescriptionDraftContentSchema,
} from './his.ts'

export const agentViewIdSchema = z.enum([
  'overview',
  'scenarioData',
  'registration',
  'triage',
  'consultation',
  'billing',
  'pharmacy',
  'settingsGeneral',
  'uiComponents',
])

const emptyInputSchema = z.object({}).strict()
const boundedIdSchema = z.string().trim().min(1).max(128)
const boundedCodeSchema = z.string().trim().min(1).max(128)
const diagnosisInputSchema = diagnosisDraftContentSchema
const firstVisitDraftInputSchema = z.object({
  assessment: z.string().trim().min(1).max(2_000),
  historyOfPresentIllness: z.string().trim().min(1).max(4_000),
}).strict()
const laboratoryDraftInputSchema = z.object({
  catalogItemId: laboratoryRequestCatalogItemIdSchema,
  indicationCode: z.string().trim().min(1).max(128),
}).strict()
const revisitDraftInputSchema = z.object({
  diagnosis: z.object({
    code: z.string().trim().min(1).max(80),
    display: z.string().trim().min(1).max(200),
  }).strict(),
  document: z.object({
    assessment: z.string().trim().min(1).max(4_000),
    plan: z.string().trim().min(1).max(4_000),
  }).strict(),
  medications: z.array(z.object({
    catalogItemId: boundedIdSchema,
    doseText: z.string().trim().min(1).max(120),
    frequencyCode: z.string().trim().min(1).max(32),
    quantity: z.number().int().min(1).max(1_000),
  }).strict()).min(1).max(8),
}).strict()
const reportCorrectionInputSchema = z.object({
  conclusion: z.string().trim().min(2).max(2_000),
  reason: z.string().trim().min(2).max(500),
  requestId: boundedIdSchema,
  results: z.array(z.object({
    code: boundedCodeSchema,
    value: z.number().finite(),
  }).strict()).min(1).max(32),
}).strict().superRefine((input, context) => {
  if (new Set(input.results.map(result => result.code)).size === input.results.length) return
  context.addIssue({
    code: 'custom',
    message: 'Laboratory report correction result codes must be unique',
    path: ['results'],
  })
})
const clinicalDocumentRevisionInputSchema = z.object({
  document: clinicalDocumentContentSchema,
  reason: z.string().trim().min(2).max(500),
}).strict()
const triageDraftInputSchema = z.object({
  acuityCode: z.enum(['level-1', 'level-2', 'level-3', 'level-4']),
  chiefComplaint: z.string().trim().min(1).max(500),
  diastolicMmHg: z.number().finite().min(30).max(180),
  oxygenSaturationPct: z.number().finite().min(50).max(100),
  pulseBpm: z.number().finite().min(20).max(250),
  respirationBpm: z.number().finite().min(5).max(80),
  systolicMmHg: z.number().finite().min(50).max(260),
  temperatureC: z.number().finite().min(30).max(45),
}).strict()

export const agentToolInputSchemas = Object.freeze({
  'ui.context.read': emptyInputSchema,
  'ui.navigate': z.object({ destination: agentViewIdSchema }).strict(),
  'ui.panel.focus': emptyInputSchema,
  'scenario.status.read': emptyInputSchema,
  'scenario.providers.read': emptyInputSchema,
  'scenario.generation.status.read': emptyInputSchema,
  'scenario.install.propose': z.object({ kind: z.enum(['candidate', 'density']) }).strict(),
  'scenario.reset.propose': emptyInputSchema,
  'registration.patient.search': z.object({
    query: z.string().trim().min(1).max(100),
  }).strict(),
  'registration.patient.select': z.object({ patientId: boundedIdSchema }).strict(),
  'registration.patient.draft.set': z.object({
    birthDate: z.iso.date(),
    gender: z.enum(['male', 'female', 'other', 'unknown']),
    identifier: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(80),
  }).strict(),
  'registration.draft.set': z.object({
    departmentId: boundedIdSchema,
    locationId: boundedIdSchema,
    visitTypeId: boundedIdSchema,
  }).strict(),
  'registration.patient.create.propose': emptyInputSchema,
  'registration.outpatient.propose': emptyInputSchema,
  'triage.queue.read': emptyInputSchema,
  'triage.case.select': z.object({ caseId: boundedIdSchema }).strict(),
  'triage.draft.set': triageDraftInputSchema,
  'triage.record.propose': emptyInputSchema,
  'outpatient.case.read': emptyInputSchema,
  'outpatient.case.select': z.object({ caseId: boundedIdSchema }).strict(),
  'outpatient.section.select': z.object({
    section: z.enum(['consultation', 'record', 'diagnosis', 'prescription', 'laboratory']),
  }).strict(),
  'outpatient.consultation.ask': z.object({ questionCode: boundedCodeSchema }).strict(),
  'outpatient.first-visit.draft.set': firstVisitDraftInputSchema,
  'outpatient.diagnosis.draft.set': diagnosisInputSchema,
  'outpatient.laboratory.draft.set': laboratoryDraftInputSchema,
  'outpatient.prescription.draft.set': prescriptionDraftContentSchema,
  'outpatient.record.draft.set': clinicalDocumentContentSchema,
  'outpatient.revisit.draft.set': revisitDraftInputSchema,
  'outpatient.preview.request': emptyInputSchema,
  'outpatient.visit.start.propose': emptyInputSchema,
  'outpatient.diagnosis.confirm.propose': diagnosisInputSchema,
  'outpatient.laboratory.issue.propose': emptyInputSchema,
  'outpatient.laboratory.cancel.propose': z.object({ requestId: boundedIdSchema }).strict(),
  'outpatient.report.acknowledge.propose': z.object({ requestId: boundedIdSchema }).strict(),
  'outpatient.report.correct.propose': reportCorrectionInputSchema,
  'outpatient.prescription.issue.propose': emptyInputSchema,
  'outpatient.prescription.withdraw.propose': emptyInputSchema,
  'outpatient.medication.none.propose': emptyInputSchema,
  'outpatient.record.sign.propose': emptyInputSchema,
  'outpatient.record.revise.propose': clinicalDocumentRevisionInputSchema,
  'outpatient.encounter.complete.propose': emptyInputSchema,
  'billing.queue.read': emptyInputSchema,
  'billing.item.select': z.object({ chargeItemId: boundedIdSchema }).strict(),
  'billing.payment.preview': emptyInputSchema,
  'billing.payment.confirm.propose': emptyInputSchema,
  'pharmacy.queue.read': emptyInputSchema,
  'pharmacy.prescription.select': z.object({ prescriptionId: boundedIdSchema }).strict(),
  'pharmacy.review.draft.set': z.object({
    note: z.string().trim().min(1).max(500),
  }).strict(),
  'pharmacy.dispense.draft.set': z.object({
    selections: z.array(z.object({
      lotId: boundedIdSchema,
      medicationRequestId: boundedIdSchema,
      quantity: z.number().int().positive().max(1_000_000),
    }).strict()).min(1).max(20),
  }).strict(),
  'pharmacy.review.propose': emptyInputSchema,
  'pharmacy.dispense.propose': emptyInputSchema,
})

export type AgentOperationId = keyof typeof agentToolInputSchemas

export function parseAgentToolInput<OperationId extends AgentOperationId>(
  operationId: OperationId,
  input: unknown,
): z.infer<(typeof agentToolInputSchemas)[OperationId]> {
  return agentToolInputSchemas[operationId].parse(input) as z.infer<
    (typeof agentToolInputSchemas)[OperationId]
  >
}

export function isAgentOperationId(value: string): value is AgentOperationId {
  return Object.hasOwn(agentToolInputSchemas, value)
}
