import { type DoctorCaseSection } from '@clinmesh/contracts/agent'
import {
  clinicalDocumentAgentFactSchema,
  clinicalDocumentContentSchema,
  clinicalDocumentDraftContentSchema,
  diagnosisDraftEntrySchema,
  laboratoryRequestCatalogItemIdSchema,
  type DiagnosisDraftEntry,
  type DoctorCaseDetail,
  type DoctorQueueView,
  type EncounterCompletionTarget,
  type LaboratoryReport,
  type LaboratoryRequest,
  type LaboratoryRequestCatalogItemId,
  type SessionContext
} from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { CircleAlertIcon } from 'lucide-react'
import { type ReactNode } from 'react'
import { z } from 'zod'
import {
  type CompletedCaseCorrectionTarget
} from '../doctor-completed-cases.tsx'
import { type WorkspaceLocale } from '../workspace-i18n.ts'

export interface DoctorWorkspaceProps {
  locale: WorkspaceLocale
  session: SessionContext
}

export interface CompletedCaseCorrectionNavigation {
  caseId: string
  handled: boolean
  target: CompletedCaseCorrectionTarget
}

export interface DoctorCaseControllerProps extends DoctorWorkspaceProps {
  navigation: ReactNode
  queueView: DoctorQueueView
  onQueueViewChange: (view: DoctorQueueView) => void
  correctionNavigation: CompletedCaseCorrectionNavigation | undefined
  onCorrectionNavigationHandled: () => void
  onSelectedCaseIdChange: (caseId: string | undefined) => void
  selectedCaseId: string | undefined
}

export type DoctorAgentDraftKind =
  | 'diagnosis'
  | 'first-visit'
  | 'imaging'
  | 'laboratory'
  | 'pathology'
  | 'prescription'
  | 'record'
  | 'revisit'

export type DoctorAgentDraftHydrationRevisions = Partial<Record<DoctorAgentDraftKind, number>>

export const emptyDoctorAgentDraftHydrationRevisions: DoctorAgentDraftHydrationRevisions = {}

export interface EncounterCompletionAction {
  error: Error | null
  onSubmit: () => void
  pending: boolean
  success: boolean
}

export interface ReferenceCatalogSearchParameters {
  enabled: boolean
  page: number
  query: string
}

export const encounterCompletionTargetElementIds = {
  diagnosis: 'encounter-completion-target-diagnosis',
  'clinical-document': 'encounter-completion-target-clinical-document',
  imaging: 'encounter-completion-target-imaging',
  laboratory: 'encounter-completion-target-laboratory',
  'medication-conclusion': 'encounter-completion-target-medication-conclusion',
  pathology: 'encounter-completion-target-pathology',
} satisfies Record<EncounterCompletionTarget, string>

export const caseDetailSectionByCompletionTarget = {
  diagnosis: 'diagnosis',
  'clinical-document': 'record',
  // 放射检查、病理会诊与检验在同一个“检验检查”分区内。
  imaging: 'laboratory',
  laboratory: 'laboratory',
  'medication-conclusion': 'prescription',
  pathology: 'laboratory',
} satisfies Record<EncounterCompletionTarget, DoctorCaseSection>

export const doctorCaseSectionTabElementIds = {
  consultation: 'doctor-case-section-consultation',
  diagnosis: 'doctor-case-section-diagnosis',
  laboratory: 'doctor-case-section-laboratory',
  prescription: 'doctor-case-section-prescription',
  record: 'doctor-case-section-record',
} satisfies Record<DoctorCaseSection, string>

export const reportCorrectionInputSchema = z.object({
  conclusion: z.string().trim().min(2).max(2_000),
  reason: z.string().trim().min(2).max(500),
  requestId: z.string().min(1).max(128),
  results: z.array(z.object({
    code: z.string().min(1),
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

export const revisitDraftInputSchema = z.object({
  diagnosis: z.object({
    code: z.string().trim().min(1).max(80),
    display: z.string().trim().min(1).max(200),
  }).strict(),
  document: z.object({
    assessment: z.string().trim().min(1).max(4_000),
    plan: z.string().trim().min(1).max(4_000),
  }).strict(),
  medications: z.array(z.object({
    catalogItemId: z.string().min(1).max(128),
    doseText: z.string().trim().min(1).max(120),
    frequencyCode: z.string().trim().min(1).max(32),
    quantity: z.number().int().min(1).max(1_000),
  }).strict()).min(1).max(8),
}).strict()

export const clinicalDocumentRevisionInputSchema = z.object({
  document: clinicalDocumentContentSchema,
  reason: z.string().trim().min(2).max(500),
}).strict()

export function isLaboratoryRequestCatalogItemId(
  value: string,
): value is LaboratoryRequestCatalogItemId {
  return laboratoryRequestCatalogItemIdSchema.safeParse(value).success
}

export function isCancellableLaboratoryRequest(request: LaboratoryRequest): boolean {
  return request.status === 'issued' || request.status === 'generation-failed'
}

export function isAwaitingResult(request: { status: LaboratoryRequest['status'] }): boolean {
  return request.status === 'issued' || request.status === 'accepted' || request.status === 'in-progress'
}

export function usesStructuredClinicalDocument(detail: DoctorCaseDetail | undefined): boolean {
  return detail !== undefined && (detail.consultation !== undefined || detail.consultationRecording !== undefined
    || detail.clinicalDocument?.draft !== undefined || (detail.clinicalDocument?.signed.length ?? 0) > 0)
}

export type InvestigationCategory = 'laboratory' | 'imaging' | 'pathology'

export interface InvestigationView {
  caseId: string
  category: InvestigationCategory
  selected: Partial<Record<InvestigationCategory, string>>
  reportId?: string | undefined
}

export function caseInvestigationRequests(detail: DoctorCaseDetail | undefined) {
  return {
    laboratory: detail?.laboratoryRequests?.requests ?? [],
    imaging: detail?.imagingRequests?.requests ?? [],
    pathology: detail?.pathologyRequests?.requests ?? [],
  }
}

export interface MedicationDraftLine {
  catalogItemId: string
  doseText: string
  frequencyCode: string
  key: string
  quantity: string
}

export function ErrorAlert({ message, title }: { message: string; title: string }): React.JSX.Element {
  return <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{title}</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>
}

export function doctorRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Doctor Agent input must be an object')
  }
  return value as Record<string, unknown>
}

export function doctorString(value: unknown, key: string, maximum: number): string {
  const candidate = doctorRecord(value)[key]
  if (typeof candidate !== 'string' || candidate.trim() === '' || candidate.length > maximum) {
    throw new TypeError(`${key} is invalid`)
  }
  return candidate.trim()
}

export function doctorDiagnosisEntries(value: unknown): DiagnosisDraftEntry[] {
  const entries = doctorRecord(value).entries
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array')
  return entries.map(entry => diagnosisDraftEntrySchema.parse(entry))
}

export function doctorClinicalDocument(value: unknown) {
  const { agentFacts, ...document } = clinicalDocumentDraftContentSchema.extend({
    agentFacts: z.array(clinicalDocumentAgentFactSchema).max(64).optional(),
  }).parse(value)
  return { document, agentFacts }
}

export function requireDoctorDetail(
  detail: DoctorCaseDetail | undefined,
  message: string,
): DoctorCaseDetail {
  if (detail === undefined) throw new Error(message)
  return detail
}

export function isQuantitativeLaboratoryResult(
  result: LaboratoryReport['results'][number],
): result is Extract<LaboratoryReport['results'][number], { value: number }> {
  return typeof result.value === 'number' && 'unit' in result
}
