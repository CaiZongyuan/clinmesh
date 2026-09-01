import { agentToolInputSchemas } from '@clinmesh/contracts/agent'
import {
  clinicalDocumentContentSchema,
  diagnosisDraftEntrySchema,
  laboratoryRequestCatalogItemIdSchema,
  prescriptionDraftContentSchema,
  type ClinicalCatalog,
  type ClinicalDocumentContent,
  type DiagnosisDraftEntry,
  type DoctorCaseDetail,
  type EncounterCompletionPreview,
  type EncounterCompletionTarget,
  type LaboratoryRequest,
  type LaboratoryRequestCatalogItemId,
  type LaboratoryReport,
  type SessionContext,
  type VirtualPatientList,
} from '@clinmesh/contracts/his'
import { z } from 'zod'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@clinmesh/ui/components/alert-dialog'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { ArrowRightIcon, CheckCircleIcon, CheckIcon, CircleAlertIcon, ClipboardCheckIcon, ClipboardListIcon, ClipboardPenIcon, FileSignatureIcon, LibraryBigIcon, MessagesSquareIcon, PillIcon, PlusIcon, RefreshCwIcon, StethoscopeIcon, TestTubesIcon, Trash2Icon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  acknowledgeLaboratoryReport,
  askConsultationQuestion,
  cancelLaboratoryRequest,
  completeEncounter,
  confirmNoMedication,
  confirmDiagnosis,
  correctLaboratoryReport,
  deleteLaboratoryRequestDraft,
  deletePrescriptionDraft,
  getClinicalCatalog,
  getDoctorCase,
  getDoctorQueue,
  getEncounterCompletion,
  getVirtualPatients,
  issueLaboratoryRequest,
  issueLaboratoryOrder,
  issuePrescription,
  newIdempotencyKey,
  previewClinicalSign,
  previewStructuredClinicalDocumentSign,
  reviseStructuredClinicalDocument,
  retryLaboratoryResultGeneration,
  saveClinicalDocumentDraft,
  saveDiagnosisDraft,
  saveFirstVisitDraft,
  saveLaboratoryRequestDraft,
  savePrescriptionDraft,
  saveRevisitDraft,
  searchReferenceDiagnoses,
  searchReferenceLaboratory,
  searchReferenceMedications,
  signClinicalDocument,
  signStructuredClinicalDocument,
  startFirstVisit,
  startRevisit,
  startVirtualPatient,
  withdrawPrescription,
} from '../api-client.ts'
import {
  DoctorCompletedCaseLibrary,
  type CompletedCaseCorrectionTarget,
} from '../doctor-completed-cases.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import {
  getWorkspaceErrorMessage,
  getWorkspaceErrorTitle,
} from '../workspace-error.ts'
import { formatFen } from '../workspace-format.ts'
import { WorkspaceSelect } from '../workspace-select.tsx'
import {
  DoctorCaseContextRail,
  type DoctorCaseSection,
} from './case-context-rail.tsx'
import type { ReferenceCatalogSearches } from './catalog-picker-dialogs.tsx'
import {
  ClinicalDocumentPage,
  type ClinicalDocumentPageActions,
  type ClinicalDocumentRevisionInput,
  type ClinicalDocumentSignPreview,
} from './clinical-document-page.tsx'
import {
  ConsultationPage,
  type ConsultationPageAction,
} from './consultation-page.tsx'
import { DiagnosisPage, type DiagnosisPageActions } from './diagnosis-page.tsx'
import { doctorCaseStatusLabel } from './doctor-case-status.ts'
import { DoctorQueueModule } from './doctor-queue-module.tsx'
import {
  LaboratoryPage,
  type LaboratoryPageActions,
  type LaboratoryReportCorrectionInput,
} from './laboratory-page.tsx'
import { PatientBanner } from './patient-summary.tsx'
import { PrescriptionPage, type PrescriptionPageActions } from './prescription-page.tsx'
import { agentViewRevision, useRegisterAgentPage } from '../agent-page-context.tsx'
import { useAgentReview } from '../agent-review.tsx'

interface DoctorWorkspaceProps {
  locale: WorkspaceLocale
  session: SessionContext
}

interface CompletedCaseCorrectionNavigation {
  caseId: string
  handled: boolean
  target: CompletedCaseCorrectionTarget
}

interface DoctorCaseControllerProps extends DoctorWorkspaceProps {
  correctionNavigation: CompletedCaseCorrectionNavigation | undefined
  onCorrectionNavigationHandled: () => void
  onSelectedCaseIdChange: (caseId: string | undefined) => void
  selectedCaseId: string | undefined
}

type DoctorAgentDraftKind =
  | 'diagnosis'
  | 'first-visit'
  | 'laboratory'
  | 'prescription'
  | 'record'
  | 'revisit'

type DoctorAgentDraftHydrationRevisions = Partial<Record<DoctorAgentDraftKind, number>>

const emptyDoctorAgentDraftHydrationRevisions: DoctorAgentDraftHydrationRevisions = {}

interface EncounterCompletionAction {
  error: Error | null
  onSubmit: () => void
  pending: boolean
  success: boolean
}

interface ReferenceCatalogSearchParameters {
  enabled: boolean
  page: number
  query: string
}

const encounterCompletionTargetElementIds = {
  diagnosis: 'encounter-completion-target-diagnosis',
  'clinical-document': 'encounter-completion-target-clinical-document',
  laboratory: 'encounter-completion-target-laboratory',
  'medication-conclusion': 'encounter-completion-target-medication-conclusion',
} satisfies Record<EncounterCompletionTarget, string>

const caseDetailSectionByCompletionTarget = {
  diagnosis: 'diagnosis',
  'clinical-document': 'record',
  laboratory: 'laboratory',
  'medication-conclusion': 'prescription',
} satisfies Record<EncounterCompletionTarget, DoctorCaseSection>

const doctorCaseSectionTabElementIds = {
  consultation: 'doctor-case-section-consultation',
  diagnosis: 'doctor-case-section-diagnosis',
  laboratory: 'doctor-case-section-laboratory',
  prescription: 'doctor-case-section-prescription',
  record: 'doctor-case-section-record',
} satisfies Record<DoctorCaseSection, string>

const caseDetailSectionSchema = z.enum([
  'consultation',
  'record',
  'diagnosis',
  'prescription',
  'laboratory',
])
const reportCorrectionInputSchema = z.object({
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
    catalogItemId: z.string().min(1).max(128),
    doseText: z.string().trim().min(1).max(120),
    frequencyCode: z.string().trim().min(1).max(32),
    quantity: z.number().int().min(1).max(1_000),
  }).strict()).min(1).max(8),
}).strict()
const clinicalDocumentRevisionInputSchema = z.object({
  document: clinicalDocumentContentSchema,
  reason: z.string().trim().min(2).max(500),
}).strict()

function isLaboratoryRequestCatalogItemId(
  value: string,
): value is LaboratoryRequestCatalogItemId {
  return laboratoryRequestCatalogItemIdSchema.safeParse(value).success
}

function isCancellableLaboratoryRequest(request: LaboratoryRequest): boolean {
  return request.status === 'issued'
    || (
      request.status === 'generation-failed'
      && request.generationError?.code === 'INVESTIGATION_UNSUPPORTED'
    )
}

function createWorkingClinicalDocument(detail: DoctorCaseDetail): ClinicalDocumentContent {
  const persisted = detail.clinicalDocument?.draft
    ?? detail.clinicalDocument?.signed.at(-1)?.content
  if (persisted !== undefined) {
    return {
      assessment: persisted.assessment,
      auxiliaryExamination: persisted.auxiliaryExamination,
      chiefComplaint: persisted.chiefComplaint,
      disposition: persisted.disposition,
      followUp: persisted.followUp,
      historyOfPresentIllness: persisted.historyOfPresentIllness,
      physicalExamination: persisted.physicalExamination,
      priorMedicalHistory: persisted.priorMedicalHistory,
    }
  }
  const vitals = detail.presentation.vitalSigns
  return {
    assessment: '',
    auxiliaryExamination: detail.report === undefined
      ? '暂无辅助检查结果。'
      : detail.report.results.map(result => `${result.code} ${String(result.value)}`).join('；'),
    chiefComplaint: detail.presentation.chiefComplaint,
    disposition: '',
    followUp: '',
    historyOfPresentIllness: detail.presentation.summary,
    physicalExamination: `T ${vitals.temperatureC} °C，P ${vitals.pulseBpm} 次/分，R ${vitals.respirationBpm} 次/分，BP ${vitals.bloodPressure.systolicMmHg}/${vitals.bloodPressure.diastolicMmHg} mmHg，SpO₂ ${vitals.oxygenSaturationPct}%。`,
    priorMedicalHistory: detail.priorFacts.length === 0
      ? '系统未记录既往病史。'
      : detail.priorFacts.map(fact => fact.display || fact.code).join('；'),
  }
}

export function DoctorWorkspace({ locale, session }: DoctorWorkspaceProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const [activeTab, setActiveTab] = useState<'active' | 'completed'>('active')
  const [selectedCaseId, setSelectedCaseId] = useState<string>()
  const [correctionNavigation, setCorrectionNavigation] = useState<
    CompletedCaseCorrectionNavigation
  >()
  useEffect(() => {
    setActiveTab('active')
    setSelectedCaseId(undefined)
    setCorrectionNavigation(undefined)
  }, [session.actor.epoch, session.actor.workspaceId])
  return (
    <Tabs onValueChange={value => setActiveTab(value as 'active' | 'completed')} value={activeTab}>
      <TabsList aria-label={messages.consultation} className="w-full sm:w-fit" variant="line">
        <TabsTrigger className="min-w-0 px-3" value="active">
          <StethoscopeIcon data-icon="inline-start" />
          {messages.doctorActiveCases}
        </TabsTrigger>
        <TabsTrigger className="min-w-0 px-3" value="completed">
          <LibraryBigIcon data-icon="inline-start" />
          {messages.doctorCompletedCases}
        </TabsTrigger>
      </TabsList>
      <TabsContent className="pt-4" value="active">
        <DoctorCaseController
          correctionNavigation={correctionNavigation}
          key={`${session.actor.workspaceId}:${session.actor.epoch}`}
          locale={locale}
          onCorrectionNavigationHandled={() => setCorrectionNavigation(current => (
            current === undefined ? undefined : { ...current, handled: true }
          ))}
          onSelectedCaseIdChange={setSelectedCaseId}
          selectedCaseId={selectedCaseId}
          session={session}
        />
      </TabsContent>
      <TabsContent className="pt-4" value="completed">
        <DoctorCompletedCaseLibrary
          locale={locale}
          onOpenCorrection={(caseId, target) => {
            setSelectedCaseId(caseId)
            setCorrectionNavigation({ caseId, handled: false, target })
            setActiveTab('active')
          }}
          session={session}
        />
      </TabsContent>
    </Tabs>
  )
}

function DoctorCaseController({
  correctionNavigation,
  locale,
  onCorrectionNavigationHandled,
  onSelectedCaseIdChange,
  selectedCaseId,
  session,
}: DoctorCaseControllerProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const agentReview = useAgentReview()
  const queryClient = useQueryClient()
  const scope = [session.actor.workspaceId, session.actor.epoch] as const
  const [page, setPage] = useState(1)
  const [activeCaseSection, setActiveCaseSection] = useState<DoctorCaseSection>('record')
  const [virtualPatientPage, setVirtualPatientPage] = useState(1)
  const [diagnosisReferenceSearch, setDiagnosisReferenceSearch] = useState<ReferenceCatalogSearchParameters>({
    enabled: false,
    page: 1,
    query: '',
  })
  const [laboratoryReferenceSearch, setLaboratoryReferenceSearch] = useState<ReferenceCatalogSearchParameters>({
    enabled: false,
    page: 1,
    query: '',
  })
  const [medicationReferenceSearch, setMedicationReferenceSearch] = useState<ReferenceCatalogSearchParameters>({
    enabled: false,
    page: 1,
    query: '',
  })
  const queueKey = ['doctor-queue', ...scope, page] as const
  const virtualPatientScopeKey = ['doctor-virtual-patients', ...scope] as const
  const encounterCompletionScopeKey = ['encounter-completion', ...scope] as const
  const completedCaseListScopeKey = ['doctor-completed-cases', ...scope] as const
  const completedCaseDetailScopeKey = ['doctor-completed-case', ...scope] as const
  const virtualPatientKey = [...virtualPatientScopeKey, virtualPatientPage] as const
  const virtualPatients = useQuery({
    queryFn: ({ signal }) => getVirtualPatients(signal, virtualPatientPage),
    queryKey: virtualPatientKey,
  })
  const queue = useQuery({
    queryFn: ({ signal }) => getDoctorQueue(signal, page),
    queryKey: queueKey,
    refetchInterval: query => query.state.data?.items.some(item => item.status === 'awaiting-report') === true
      ? 1_500
      : false,
  })
  const [selectedVirtualPatientId, setSelectedVirtualPatientId] = useState<string>()
  const [laboratoryItemId, setLaboratoryItemId] = useState('')
  const [indicationCode, setIndicationCode] = useState('')
  const [workingClinicalDocuments, setWorkingClinicalDocuments] = useState<
    Record<string, ClinicalDocumentContent>
  >({})
  const [agentDraftHydrationRevisions, setAgentDraftHydrationRevisions] = useState<
    Record<string, DoctorAgentDraftHydrationRevisions>
  >({})
  const hydrateAgentDraft = useCallback((caseId: string, kind: DoctorAgentDraftKind): void => {
    setAgentDraftHydrationRevisions(current => ({
      ...current,
      [caseId]: {
        ...current[caseId],
        [kind]: (current[caseId]?.[kind] ?? 0) + 1,
      },
    }))
  }, [])
  const autoStartRequested = useRef(false)
  const activeCaseId = selectedCaseId ?? queue.data?.items[0]?.caseId
  const selectedCase = queue.data?.items.find(item => item.caseId === activeCaseId)
  const selectedVirtualPatient = virtualPatients.data?.items.find(
    item => item.id === selectedVirtualPatientId,
  )
  const detailKey = [
    'doctor-case',
    ...scope,
    activeCaseId,
    selectedCase?.diagnosticReportId,
  ] as const
  const detail = useQuery({
    enabled: activeCaseId !== undefined,
    queryFn: ({ signal }) => getDoctorCase(activeCaseId ?? '', signal),
    queryKey: detailKey,
    refetchInterval: query => selectedCase?.status === 'awaiting-report'
      || (
        query.state.data?.laboratoryRequests?.reportingSupported === true
        && query.state.data.laboratoryRequests.requests.some(
          request => request.status === 'issued'
            || request.status === 'accepted'
            || request.status === 'in-progress',
        )
      )
      ? 1_500
      : false,
  })
  const completion = useQuery({
    enabled: detail.data?.consultation !== undefined
      && detail.data.encounter.status === 'in-progress'
      && detail.data.status !== 'awaiting-doctor',
    queryFn: ({ signal }) => getEncounterCompletion(detail.data?.encounter.id ?? '', signal),
    queryKey: [
      ...encounterCompletionScopeKey,
      detail.data?.encounter.id ?? '',
      detail.data?.encounter.versionId ?? '',
    ],
  })
  useEffect(() => {
    setLaboratoryItemId('')
    setIndicationCode('')
    setActiveCaseSection('record')
  }, [activeCaseId, session.actor.epoch, session.actor.workspaceId])
  const catalog = useQuery({
    queryFn: ({ signal }) => getClinicalCatalog(signal),
    queryKey: ['clinical-catalog', ...scope],
  })
  const referenceDiagnoses = useQuery({
    enabled: diagnosisReferenceSearch.enabled,
    queryFn: ({ signal }) => searchReferenceDiagnoses(
      diagnosisReferenceSearch.query,
      diagnosisReferenceSearch.page,
      signal,
    ),
    queryKey: [
      'reference-catalog',
      ...scope,
      'diagnoses',
      diagnosisReferenceSearch.query,
      diagnosisReferenceSearch.page,
    ],
  })
  const referenceLaboratory = useQuery({
    enabled: laboratoryReferenceSearch.enabled && activeCaseId !== undefined,
    queryFn: ({ signal }) => searchReferenceLaboratory(
      activeCaseId ?? '',
      laboratoryReferenceSearch.query,
      laboratoryReferenceSearch.page,
      signal,
    ),
    queryKey: [
      'reference-catalog',
      ...scope,
      'laboratory',
      activeCaseId,
      laboratoryReferenceSearch.query,
      laboratoryReferenceSearch.page,
    ],
  })
  const referenceMedications = useQuery({
    enabled: medicationReferenceSearch.enabled,
    queryFn: ({ signal }) => searchReferenceMedications(
      medicationReferenceSearch.query,
      medicationReferenceSearch.page,
      signal,
    ),
    queryKey: [
      'reference-catalog',
      ...scope,
      'medications',
      medicationReferenceSearch.query,
      medicationReferenceSearch.page,
    ],
  })
  const referenceCatalogSearches: ReferenceCatalogSearches = {
    diagnoses: {
      data: referenceDiagnoses.data,
      error: referenceDiagnoses.error,
      isError: referenceDiagnoses.isError,
      isFetching: referenceDiagnoses.isFetching,
      isPending: referenceDiagnoses.isPending,
      onSearch: (query, searchPage) => setDiagnosisReferenceSearch({
        enabled: true,
        page: searchPage,
        query,
      }),
    },
    laboratory: {
      data: referenceLaboratory.data,
      error: referenceLaboratory.error,
      isError: referenceLaboratory.isError,
      isFetching: referenceLaboratory.isFetching,
      isPending: referenceLaboratory.isPending,
      onSearch: (query, searchPage) => setLaboratoryReferenceSearch({
        enabled: true,
        page: searchPage,
        query,
      }),
    },
    medications: {
      data: referenceMedications.data,
      error: referenceMedications.error,
      isError: referenceMedications.isError,
      isFetching: referenceMedications.isFetching,
      isPending: referenceMedications.isPending,
      onSearch: (query, searchPage) => setMedicationReferenceSearch({
        enabled: true,
        page: searchPage,
        query,
      }),
    },
  }
  const persistedClinicalDocumentVersion = detail.data?.clinicalDocument?.draft?.version
    ?? detail.data?.clinicalDocument?.signed.at(-1)?.revisionNumber
  useEffect(() => {
    const currentDetail = detail.data
    if (currentDetail === undefined || persistedClinicalDocumentVersion === undefined) return
    setWorkingClinicalDocuments(current => ({
      ...current,
      [currentDetail.caseId]: createWorkingClinicalDocument(currentDetail),
    }))
  }, [detail.data?.caseId, persistedClinicalDocumentVersion])
  const usesIndependentLaboratoryRequests = detail.data?.consultation !== undefined
  const laboratoryCatalog = catalog.data?.laboratory.filter(item => (
    usesIndependentLaboratoryRequests
      ? isLaboratoryRequestCatalogItemId(item.id)
      : item.id === 'lab-fever-panel'
  )) ?? []
  const draftLaboratoryItemId = detail.data?.laboratoryRequests?.draft?.catalogItemId
  const requestedLaboratoryItemId = laboratoryItemId || draftLaboratoryItemId
  const resolvedLaboratoryItemId = requestedLaboratoryItemId
    ?? (usesIndependentLaboratoryRequests ? '' : laboratoryCatalog[0]?.id)
    ?? ''
  const resolvedLaboratoryItem = laboratoryCatalog.find(item => item.id === resolvedLaboratoryItemId)
  const draftIndicationCode = detail.data?.laboratoryRequests?.draft?.catalogItemId === resolvedLaboratoryItemId
    ? detail.data.laboratoryRequests.draft.indicationCode
    : undefined
  const requestedIndicationCode = resolvedLaboratoryItem?.allowedIndicationCodes.includes(indicationCode)
    ? indicationCode
    : draftIndicationCode
  const resolvedIndicationCode = resolvedLaboratoryItem === undefined
    ? requestedIndicationCode ?? (indicationCode || 'clinical-evaluation')
    : resolvedLaboratoryItem.allowedIndicationCodes.includes(
    requestedIndicationCode ?? '',
  ) === true
    ? requestedIndicationCode ?? ''
    : resolvedLaboratoryItem?.allowedIndicationCodes[0] ?? ''
  const startCandidate = useMutation({
    mutationFn: (patient: VirtualPatientList['items'][number]) => {
      return startVirtualPatient(
        patient.id,
        patient.version,
        newIdempotencyKey(),
      )
    },
    onSuccess: async response => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: virtualPatientScopeKey }),
        queryClient.invalidateQueries({ queryKey: ['doctor-queue', ...scope] }),
      ])
      setVirtualPatientPage(1)
      setSelectedVirtualPatientId(undefined)
      onSelectedCaseIdChange(response.data.caseId)
    },
  })
  const autoStartCandidate = virtualPatients.data?.items[0]
  useEffect(() => {
    if (
      autoStartRequested.current
      || queue.data?.total !== 0
      || virtualPatients.data === undefined
      || virtualPatients.data.total < 12
      || autoStartCandidate === undefined
    ) return
    autoStartRequested.current = true
    startCandidate.mutate(autoStartCandidate)
  }, [autoStartCandidate, queue.data?.total, startCandidate, virtualPatients.data])
  const refreshCaseById = async (caseId: string | undefined) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queueKey }),
      queryClient.invalidateQueries({
        queryKey: caseId === undefined
          ? ['doctor-case', ...scope]
          : ['doctor-case', ...scope, caseId],
      }),
      queryClient.invalidateQueries({ queryKey: encounterCompletionScopeKey }),
    ])
  }
  const refreshCompletedCaseDetails = async () => {
    await queryClient.invalidateQueries({ queryKey: completedCaseDetailScopeKey })
  }
  const completeCaseEncounter = useMutation({
    mutationFn: ({ caseId }: { caseId: string }) => {
      const current = detail.data
      const preview = completion.data
      if (
        current?.caseId !== caseId
        || preview?.encounterId !== current.encounter.id
        || preview.encounterVersion !== current.encounter.versionId
      ) {
        throw new Error(messages.encounterCompletionUnavailable)
      }
      return completeEncounter({
        encounterId: preview.encounterId,
        encounterVersion: preview.encounterVersion,
      }, newIdempotencyKey())
    },
    onError: async (_error, variables) => refreshCaseById(variables.caseId),
    onSuccess: async (_response, variables) => {
      onSelectedCaseIdChange(variables.caseId)
      await Promise.all([
        refreshCaseById(variables.caseId),
        refreshCompletedCaseDetails(),
        queryClient.invalidateQueries({ queryKey: completedCaseListScopeKey }),
      ])
    },
  })
  const askQuestion = useMutation({
    mutationFn: ({ caseId, questionCode }: { caseId: string; questionCode: string }) => {
      const current = detail.data
      if (current?.caseId !== caseId || current.consultation === undefined) {
        throw new Error(messages.consultationUnavailable)
      }
      return askConsultationQuestion({
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        expectedVersion: current.consultation.version,
        questionCode,
        taskId: current.taskId,
        taskVersion: current.taskVersion,
      }, newIdempotencyKey())
    },
    onSuccess: async (_response, variables) => refreshCaseById(variables.caseId),
  })
  const signingDependencies = (caseId: string) => {
    const current = detail.data
    const revisit = current?.drafts?.revisit
    const prescription = current?.drafts?.prescription
    const document = current?.drafts?.document
    if (
      current?.caseId !== caseId
      || revisit === undefined
      || prescription === undefined
      || document === undefined
    ) {
      throw new Error(messages.consultationUnavailable)
    }
    const expectedVersions: Record<string, string> = {
      [`Condition/${revisit.conditionId}`]: revisit.conditionVersion,
      [`Encounter/${current.encounter.id}`]: current.encounter.versionId,
      [`Task/${current.taskId}`]: current.taskVersion,
    }
    for (const item of prescription.items) {
      expectedVersions[`MedicationRequest/${item.medicationRequestId}`] = item.versionId
    }
    return {
      draftVersions: {
        documentDraft: document.version,
        prescription: prescription.version,
        revisitDraft: revisit.version,
      },
      encounterId: current.encounter.id,
      expectedVersions,
    }
  }
  const start = useMutation({
    mutationFn: ({ caseId }: { caseId: string }) => {
      if (detail.data?.caseId !== caseId) throw new Error(messages.consultationUnavailable)
      return startFirstVisit({
        encounterId: detail.data.encounter.id,
        encounterVersion: detail.data.encounter.versionId,
        taskId: detail.data.taskId,
        taskVersion: detail.data.taskVersion,
      }, newIdempotencyKey())
    },
    onSuccess: async (_response, variables) => refreshCaseById(variables.caseId),
  })
  const beginRevisit = useMutation({
    mutationFn: ({ caseId }: { caseId: string }) => {
      if (detail.data?.caseId !== caseId) throw new Error(messages.consultationUnavailable)
      return startRevisit({
        encounterId: detail.data.encounter.id,
        encounterVersion: detail.data.encounter.versionId,
        taskId: detail.data.taskId,
        taskVersion: detail.data.taskVersion,
      }, newIdempotencyKey())
    },
    onSuccess: async (_response, variables) => refreshCaseById(variables.caseId),
  })
  const saveDraft = useMutation({
    mutationFn: ({ caseId, ...input }: {
      assessment: string
      caseId: string
      historyOfPresentIllness: string
    }) => {
      if (detail.data?.caseId !== caseId) throw new Error(messages.consultationUnavailable)
      return saveFirstVisitDraft({
        ...input,
        encounterId: detail.data.encounter.id,
        encounterVersion: detail.data.encounter.versionId,
        expectedDraftVersion: detail.data.drafts?.firstVisit?.version ?? 0,
      }, newIdempotencyKey())
    },
    onSuccess: async (_response, variables) => refreshCaseById(variables.caseId),
  })
  const issueOrder = useMutation({
    mutationFn: ({ caseId }: { caseId: string }) => {
      if (detail.data?.caseId !== caseId || catalog.data === undefined) {
        throw new Error(messages.consultationUnavailable)
      }
      const catalogItemId = resolvedLaboratoryItemId
      const catalogItem = laboratoryCatalog.find(item => item.id === catalogItemId)
      const expectedDraftVersion = detail.data.drafts?.firstVisit?.version
      const resolvedLegacyIndicationCode = resolvedIndicationCode || catalogItem?.allowedIndicationCodes[0]
      if (
        catalogItemId.length === 0
        || expectedDraftVersion === undefined
        || resolvedLegacyIndicationCode === undefined
      ) {
        throw new Error(messages.consultationUnavailable)
      }
      return issueLaboratoryOrder({
        catalogItemId,
        encounterId: detail.data.encounter.id,
        encounterVersion: detail.data.encounter.versionId,
        expectedDraftVersion,
        indicationCode: resolvedLegacyIndicationCode,
        taskId: detail.data.taskId,
        taskVersion: detail.data.taskVersion,
      }, newIdempotencyKey())
    },
    onSuccess: async (_response, variables) => refreshCaseById(variables.caseId),
  })
  const saveLaboratoryRequest = useMutation({
    mutationFn: ({ caseId }: { caseId: string }) => {
      const current = detail.data
      if (current?.caseId !== caseId
        || !isLaboratoryRequestCatalogItemId(resolvedLaboratoryItemId)
        || resolvedIndicationCode.length === 0) {
        throw new Error(messages.consultationUnavailable)
      }
      return saveLaboratoryRequestDraft({
        catalogItemId: resolvedLaboratoryItemId,
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        expectedDraftVersion: current.laboratoryRequests?.draftVersion ?? 0,
        indicationCode: resolvedIndicationCode,
      }, newIdempotencyKey())
    },
    onError: async (_error, variables) => refreshCaseById(variables.caseId),
    onSuccess: async (_response, variables) => refreshCaseById(variables.caseId),
  })
  const issueRequest = useMutation({
    mutationFn: ({ caseId }: { caseId: string }) => {
      const current = detail.data
      const requestState = current?.laboratoryRequests
      if (current?.caseId !== caseId || requestState?.draft === undefined) {
        throw new Error(messages.consultationUnavailable)
      }
      return issueLaboratoryRequest({
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        expectedDraftVersion: requestState.draftVersion,
      }, newIdempotencyKey())
    },
    onSuccess: async (_response, variables) => {
      saveLaboratoryRequest.reset()
      setLaboratoryItemId('')
      setIndicationCode('')
      await refreshCaseById(variables.caseId)
    },
  })
  const deleteRequestDraft = useMutation({
    mutationFn: (caseId: string) => {
      const current = detail.data
      const requestState = current?.laboratoryRequests
      if (current?.caseId !== caseId || requestState?.draft === undefined) {
        throw new Error(messages.consultationUnavailable)
      }
      return deleteLaboratoryRequestDraft({
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        expectedDraftVersion: requestState.draftVersion,
      }, newIdempotencyKey())
    },
    onError: async (_error, caseId) => refreshCaseById(caseId),
    onSuccess: async (_response, caseId) => {
      saveLaboratoryRequest.reset()
      setLaboratoryItemId('')
      setIndicationCode('')
      await refreshCaseById(caseId)
    },
  })
  const cancelRequest = useMutation({
    mutationFn: ({ request }: { caseId: string; request: LaboratoryRequest }) => (
      cancelLaboratoryRequest({
        requestId: request.id,
        requestVersion: request.version,
        serviceRequestId: request.serviceRequestId,
        serviceRequestVersion: request.serviceRequestVersion,
        taskId: request.taskId,
        taskVersion: request.taskVersion,
      }, newIdempotencyKey())
    ),
    onError: async (_error, variables) => refreshCaseById(variables.caseId),
    onSuccess: async (_response, variables) => refreshCaseById(variables.caseId),
  })
  const retryResultGeneration = useMutation({
    mutationFn: ({ request }: { caseId: string; request: LaboratoryRequest }) => retryLaboratoryResultGeneration({
      requestId: request.id,
      requestVersion: request.version,
      taskId: request.taskId,
      taskVersion: request.taskVersion,
    }, newIdempotencyKey()),
    onError: async (_error, variables) => refreshCaseById(variables.caseId),
    onSuccess: async (_response, variables) => refreshCaseById(variables.caseId),
  })
  const acknowledgeReport = useMutation({
    mutationFn: ({ request }: { caseId: string; request: LaboratoryRequest }) => {
      if (request.report === undefined) throw new Error(messages.consultationUnavailable)
      return acknowledgeLaboratoryReport({
        diagnosticReportId: request.report.diagnosticReportId,
        diagnosticReportVersion: request.report.diagnosticReportVersion,
        requestId: request.id,
        requestVersion: request.version,
      }, newIdempotencyKey())
    },
    onSuccess: async (_response, variables) => refreshCaseById(variables.caseId),
  })
  const correctReport = useMutation({
    mutationFn: ({ input, request }: {
      caseId: string
      input: LaboratoryReportCorrectionInput
      request: LaboratoryRequest
    }) => {
      if (request.report === undefined) throw new Error(messages.consultationUnavailable)
      return correctLaboratoryReport({
        ...input,
        diagnosticReportId: request.report.diagnosticReportId,
        diagnosticReportVersion: request.report.diagnosticReportVersion,
        requestId: request.id,
        requestVersion: request.version,
      }, newIdempotencyKey())
    },
    onError: async (_error, variables) => {
      await Promise.all([
        refreshCaseById(variables.caseId),
        refreshCompletedCaseDetails(),
      ])
    },
    onSuccess: async (_response, variables) => {
      await Promise.all([
        refreshCaseById(variables.caseId),
        refreshCompletedCaseDetails(),
      ])
    },
  })
  const prepareClinicalDocumentSign = useMutation({
    mutationFn: async ({ caseId, document }: {
      caseId: string
      document: ClinicalDocumentContent
    }) => {
      const current = detail.data
      if (current?.caseId !== caseId) throw new Error(messages.consultationUnavailable)
      const saved = await saveClinicalDocumentDraft({
        document,
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        expectedDraftVersion: current.clinicalDocument?.draft?.version ?? 0,
      }, newIdempotencyKey())
      return previewStructuredClinicalDocumentSign({
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        expectedDraftVersion: saved.data.draftVersion,
      }, newIdempotencyKey())
    },
    onError: async (_error, variables) => refreshCaseById(variables.caseId),
  })
  const signStructuredDocument = useMutation({
    mutationFn: ({ caseId, preview }: {
      caseId: string
      preview: ClinicalDocumentSignPreview
    }) => {
      const current = detail.data
      if (current?.caseId !== caseId) throw new Error(messages.consultationUnavailable)
      return signStructuredClinicalDocument({
        commitToken: preview.commitToken,
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        previewId: preview.previewId,
      }, newIdempotencyKey())
    },
    onError: async (_error, variables) => refreshCaseById(variables.caseId),
    onSuccess: async (_response, variables) => {
      prepareClinicalDocumentSign.reset()
      await refreshCaseById(variables.caseId)
    },
  })
  const reviseClinicalDocument = useMutation({
    mutationFn: (input: ClinicalDocumentRevisionInput) => reviseStructuredClinicalDocument({
      compositionId: input.compositionId,
      compositionVersion: input.compositionVersion,
      document: input.document,
      encounterId: input.encounterId,
      encounterVersion: input.encounterVersion,
      reason: input.reason,
    }, newIdempotencyKey()),
    onError: async (_error, variables) => {
      await Promise.all([
        refreshCaseById(variables.caseId),
        refreshCompletedCaseDetails(),
      ])
    },
    onSuccess: async (_response, variables) => {
      await Promise.all([
        refreshCaseById(variables.caseId),
        refreshCompletedCaseDetails(),
      ])
    },
  })
  const savePrescription = useMutation({
    mutationFn: ({ caseId, items }: {
      caseId: string
      items: Parameters<typeof savePrescriptionDraft>[0]['items']
    }) => {
      const current = detail.data
      if (current?.caseId !== caseId) throw new Error(messages.consultationUnavailable)
      return savePrescriptionDraft({
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        expectedDraftVersion: current.medicationConclusion?.draftVersion ?? 0,
        items,
      }, newIdempotencyKey())
    },
    onError: async (_error, variables) => refreshCaseById(variables.caseId),
    onSuccess: async (_response, variables) => refreshCaseById(variables.caseId),
  })
  const removePrescriptionDraft = useMutation({
    mutationFn: ({ caseId }: { caseId: string }) => {
      const current = detail.data
      const state = current?.medicationConclusion
      if (current?.caseId !== caseId || state?.draft === undefined) {
        throw new Error(messages.consultationUnavailable)
      }
      return deletePrescriptionDraft({
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        expectedDraftVersion: state.draftVersion,
      }, newIdempotencyKey())
    },
    onError: async (_error, variables) => refreshCaseById(variables.caseId),
    onSuccess: async (_response, variables) => {
      savePrescription.reset()
      await refreshCaseById(variables.caseId)
    },
  })
  const issueCasePrescription = useMutation({
    mutationFn: ({ caseId }: { caseId: string }) => {
      const current = detail.data
      const state = current?.medicationConclusion
      if (current?.caseId !== caseId || state?.draft === undefined) {
        throw new Error(messages.consultationUnavailable)
      }
      return issuePrescription({
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        expectedDraftVersion: state.draftVersion,
      }, newIdempotencyKey())
    },
    onError: async (_error, variables) => refreshCaseById(variables.caseId),
    onSuccess: async (_response, variables) => {
      savePrescription.reset()
      await refreshCaseById(variables.caseId)
    },
  })
  const confirmCaseNoMedication = useMutation({
    mutationFn: ({ caseId }: { caseId: string }) => {
      const current = detail.data
      if (current?.caseId !== caseId) throw new Error(messages.consultationUnavailable)
      return confirmNoMedication({
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        expectedDraftVersion: current.medicationConclusion?.draftVersion ?? 0,
      }, newIdempotencyKey())
    },
    onError: async (_error, variables) => refreshCaseById(variables.caseId),
    onSuccess: async (_response, variables) => refreshCaseById(variables.caseId),
  })
  const withdrawCasePrescription = useMutation({
    mutationFn: ({ caseId, prescriptionId }: { caseId: string; prescriptionId: string }) => {
      const current = detail.data
      const prescription = current?.medicationConclusion?.prescription
      if (current?.caseId !== caseId || prescription?.id !== prescriptionId) {
        throw new Error(messages.consultationUnavailable)
      }
      return withdrawPrescription({
        expectedPrescriptionVersion: prescription.version,
        medicationRequests: prescription.items.map(item => ({
          id: item.medicationRequestId,
          version: item.medicationRequestVersion,
        })),
        prescriptionId: prescription.id,
      }, newIdempotencyKey())
    },
    onError: async (_error, variables) => {
      await Promise.all([
        refreshCaseById(variables.caseId),
        refreshCompletedCaseDetails(),
      ])
    },
    onSuccess: async (_response, variables) => {
      await Promise.all([
        refreshCaseById(variables.caseId),
        refreshCompletedCaseDetails(),
      ])
    },
  })
  const saveCaseDiagnosis = useMutation({
    mutationFn: ({ caseId, entries }: {
      caseId: string
      entries: DiagnosisDraftEntry[]
    }) => {
      const current = detail.data
      if (current?.caseId !== caseId) throw new Error(messages.consultationUnavailable)
      return saveDiagnosisDraft({
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        entries,
        expectedDraftVersion: current.diagnosis?.draftVersion ?? 0,
      }, newIdempotencyKey())
    },
    onError: async (_error, variables) => refreshCaseById(variables.caseId),
    onSuccess: async (_response, variables) => refreshCaseById(variables.caseId),
  })
  const confirmCaseDiagnosis = useMutation({
    mutationFn: ({ caseId }: { caseId: string }) => {
      const current = detail.data
      if (current?.caseId !== caseId || current.diagnosis?.draft === undefined) {
        throw new Error(messages.consultationUnavailable)
      }
      return confirmDiagnosis({
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        expectedDraftVersion: current.diagnosis.draftVersion,
      }, newIdempotencyKey())
    },
    onSuccess: async (_response, variables) => {
      saveCaseDiagnosis.reset()
      await refreshCaseById(variables.caseId)
    },
  })
  const saveRevisit = useMutation({
    mutationFn: (input: {
      caseId: string
      diagnosis: { code: string; display: string }
      document: { assessment: string; plan: string }
      medications: Array<{
        catalogItemId: string
        doseText: string
        frequencyCode: string
        quantity: number
      }>
    }) => {
      if (detail.data?.caseId !== input.caseId) throw new Error(messages.consultationUnavailable)
      const revisit = detail.data.drafts?.revisit
      const prescription = detail.data.drafts?.prescription
      const expectedVersions: Record<string, string> = {
        [`Encounter/${detail.data.encounter.id}`]: detail.data.encounter.versionId,
      }
      if (revisit !== undefined) {
        expectedVersions[`Condition/${revisit.conditionId}`] = revisit.conditionVersion
      }
      for (const item of prescription?.items ?? []) {
        expectedVersions[`MedicationRequest/${item.medicationRequestId}`] = item.versionId
      }
      return saveRevisitDraft({
        diagnosis: input.diagnosis,
        document: input.document,
        draftVersions: {
          documentDraft: detail.data.drafts?.document?.version ?? 0,
          prescription: prescription?.version ?? 0,
          revisitDraft: revisit?.version ?? 0,
        },
        encounterId: detail.data.encounter.id,
        expectedVersions,
        medications: input.medications,
      }, newIdempotencyKey())
    },
    onSuccess: async (_response, variables) => refreshCaseById(variables.caseId),
  })
  const previewSign = useMutation({
    mutationFn: ({ caseId }: { caseId: string }) => (
      previewClinicalSign(signingDependencies(caseId), newIdempotencyKey())
    ),
  })
  const completeSign = useMutation({
    mutationFn: ({ caseId }: { caseId: string }) => {
      if (previewSign.variables?.caseId !== caseId || previewSign.data === undefined) {
        throw new Error(messages.consultationUnavailable)
      }
      const dependencies = signingDependencies(caseId)
      return signClinicalDocument({
        commitToken: previewSign.data.data.commitToken,
        encounterId: dependencies.encounterId,
        expectedVersions: dependencies.expectedVersions,
        previewId: previewSign.data.data.previewId,
      }, newIdempotencyKey())
    },
    onSuccess: async (_response, variables) => refreshCaseById(variables.caseId),
  })
  const currentClinicalDocument = detail.data === undefined
    ? undefined
    : workingClinicalDocuments[detail.data.caseId] ?? createWorkingClinicalDocument(detail.data)
  const agentPage = useMemo(() => ({
    actions: {
      'outpatient.case.read': {
        description: 'Read the selected authorized outpatient case and visible clinical state.',
        enabled: activeCaseId !== undefined,
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => {
          if (activeCaseId === undefined) throw new Error(messages.consultationUnavailable)
          return getDoctorCase(activeCaseId, signal)
        },
      },
      'outpatient.case.select': {
        description: 'Select one case from the current doctor queue.',
        enabled: (queue.data?.items.length ?? 0) > 0,
        parameters: {
          type: 'object' as const,
          properties: { caseId: { type: 'string', maxLength: 128 } },
          required: ['caseId'],
          additionalProperties: false,
        },
        execute: (raw: unknown) => {
          const caseId = doctorString(raw, 'caseId', 128)
          if (!queue.data?.items.some(item => item.caseId === caseId)) {
            throw new Error('Case is not in the current doctor queue')
          }
          onSelectedCaseIdChange(caseId)
          return { caseId, selected: true }
        },
      },
      'outpatient.section.select': {
        description: 'Select one visible section in the current doctor case.',
        enabled: detail.data !== undefined,
        parameters: {
          type: 'object' as const,
          properties: { section: { type: 'string', enum: caseDetailSectionSchema.options } },
          required: ['section'],
          additionalProperties: false,
        },
        execute: (raw: unknown) => {
          const section = caseDetailSectionSchema.parse(doctorRecord(raw).section)
          const tab = document.getElementById(doctorCaseSectionTabElementIds[section])
          if (!(tab instanceof HTMLButtonElement)) {
            throw new Error('Doctor case section is not available')
          }
          tab.click()
          return { section, selected: true }
        },
      },
      'outpatient.consultation.ask': {
        description: 'Ask one allowlisted Virtual Patient question in the current consultation.',
        enabled: (detail.data?.consultation?.questions.length ?? 0) > 0,
        parameters: {
          type: 'object' as const,
          properties: { questionCode: { type: 'string', maxLength: 128 } },
          required: ['questionCode'],
          additionalProperties: false,
        },
        execute: (raw: unknown) => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          return askQuestion.mutateAsync({
            caseId: current.caseId,
            questionCode: doctorString(raw, 'questionCode', 128),
          })
        },
      },
      'outpatient.first-visit.draft.set': {
        description: 'Validate and save the current first-visit draft without issuing an order.',
        enabled: detail.data?.status === 'first-visit',
        parameters: {
          type: 'object' as const,
          properties: {
            assessment: { type: 'string', maxLength: 2000 },
            historyOfPresentIllness: { type: 'string', maxLength: 4000 },
          },
          required: ['assessment', 'historyOfPresentIllness'],
          additionalProperties: false,
        },
        execute: async (raw: unknown) => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          const result = await saveDraft.mutateAsync({
            assessment: doctorString(raw, 'assessment', 2000),
            caseId: current.caseId,
            historyOfPresentIllness: doctorString(raw, 'historyOfPresentIllness', 4000),
          })
          hydrateAgentDraft(current.caseId, 'first-visit')
          return result
        },
      },
      'outpatient.diagnosis.draft.set': {
        description: 'Validate and save the structured diagnosis draft without confirming it.',
        enabled: detail.data?.consultation !== undefined
          && detail.data.encounter.status === 'in-progress',
        parameters: {
          type: 'object' as const,
          properties: {
            entries: {
              type: 'array',
              minItems: 1,
              maxItems: 8,
              items: {
                type: 'object',
                properties: {
                  catalogItemId: { type: 'string' },
                  note: { type: 'string', maxLength: 500 },
                  role: { type: 'string', enum: ['principal', 'secondary'] },
                },
                required: ['catalogItemId', 'role'],
                additionalProperties: false,
              },
            },
          },
          required: ['entries'],
          additionalProperties: false,
        },
        execute: async (raw: unknown) => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          const entries = doctorDiagnosisEntries(raw)
          const result = await saveCaseDiagnosis.mutateAsync({
            caseId: current.caseId,
            entries,
          })
          hydrateAgentDraft(current.caseId, 'diagnosis')
          return result
        },
      },
      'outpatient.laboratory.draft.set': {
        description: 'Validate and save a laboratory request draft without issuing it.',
        enabled: detail.data?.consultation !== undefined
          && detail.data.encounter.status === 'in-progress',
        parameters: {
          type: 'object' as const,
          properties: {
            catalogItemId: { type: 'string', maxLength: 512 },
            indicationCode: { type: 'string', maxLength: 64 },
          },
          required: ['catalogItemId', 'indicationCode'],
          additionalProperties: false,
        },
        execute: async (raw: unknown) => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          const {
            catalogItemId,
            indicationCode: nextIndication,
          } = agentToolInputSchemas['outpatient.laboratory.draft.set'].parse(raw)
          const result = await saveLaboratoryRequestDraft({
            catalogItemId,
            encounterId: current.encounter.id,
            encounterVersion: current.encounter.versionId,
            expectedDraftVersion: current.laboratoryRequests?.draftVersion ?? 0,
            indicationCode: nextIndication,
          }, newIdempotencyKey())
          await refreshCaseById(current.caseId)
          setLaboratoryItemId(catalogItemId)
          setIndicationCode(nextIndication)
          hydrateAgentDraft(current.caseId, 'laboratory')
          return result
        },
      },
      'outpatient.prescription.draft.set': {
        description: 'Validate and save the controlled prescription draft without issuing it.',
        enabled: detail.data?.consultation !== undefined
          && detail.data.medicationConclusion?.prescription === undefined
          && detail.data.medicationConclusion?.noMedication === undefined,
        parameters: {
          type: 'object' as const,
          properties: {
            items: {
              type: 'array',
              minItems: 1,
              maxItems: 8,
              items: {
                type: 'object',
                properties: {
                  catalogItemId: { type: 'string' },
                  courseDays: { type: 'integer', minimum: 1, maximum: 30 },
                  doseText: { type: 'string', maxLength: 120 },
                  frequencyCode: { type: 'string', maxLength: 32 },
                  quantity: { type: 'integer', minimum: 1, maximum: 1_000 },
                },
                required: [
                  'catalogItemId', 'courseDays', 'doseText', 'frequencyCode', 'quantity',
                ],
                additionalProperties: false,
              },
            },
          },
          required: ['items'],
          additionalProperties: false,
        },
        execute: async (raw: unknown) => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          const input = prescriptionDraftContentSchema.parse(raw)
          const result = await savePrescription.mutateAsync({
            caseId: current.caseId,
            items: input.items,
          })
          hydrateAgentDraft(current.caseId, 'prescription')
          return result
        },
      },
      'outpatient.revisit.draft.set': {
        description: 'Validate and save the current revisit draft without signing it.',
        enabled: detail.data?.status === 'revisit-draft'
          && detail.data.consultation === undefined,
        parameters: {
          type: 'object' as const,
          properties: {
            diagnosis: {
              type: 'object',
              properties: { code: { type: 'string' }, display: { type: 'string' } },
              required: ['code', 'display'],
              additionalProperties: false,
            },
            document: {
              type: 'object',
              properties: { assessment: { type: 'string' }, plan: { type: 'string' } },
              required: ['assessment', 'plan'],
              additionalProperties: false,
            },
            medications: {
              type: 'array',
              minItems: 1,
              maxItems: 8,
              items: {
                type: 'object',
                properties: {
                  catalogItemId: { type: 'string' },
                  doseText: { type: 'string' },
                  frequencyCode: { type: 'string' },
                  quantity: { type: 'integer' },
                },
                required: ['catalogItemId', 'doseText', 'frequencyCode', 'quantity'],
                additionalProperties: false,
              },
            },
          },
          required: ['diagnosis', 'document', 'medications'],
          additionalProperties: false,
        },
        execute: async (raw: unknown) => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          const result = await saveRevisit.mutateAsync({
            caseId: current.caseId,
            ...revisitDraftInputSchema.parse(raw),
          })
          hydrateAgentDraft(current.caseId, 'revisit')
          return result
        },
      },
      'outpatient.record.draft.set': {
        description: 'Validate and save the structured clinical document draft without signing it.',
        enabled: detail.data?.consultation !== undefined
          && detail.data.encounter.status === 'in-progress',
        parameters: {
          type: 'object' as const,
          properties: Object.fromEntries([
            'assessment', 'auxiliaryExamination', 'chiefComplaint', 'disposition',
            'followUp', 'historyOfPresentIllness', 'physicalExamination', 'priorMedicalHistory',
          ].map(key => [key, { type: 'string', maxLength: 4000 }])),
          required: [
            'assessment', 'auxiliaryExamination', 'chiefComplaint', 'disposition',
            'followUp', 'historyOfPresentIllness', 'physicalExamination', 'priorMedicalHistory',
          ],
          additionalProperties: false,
        },
        execute: async (raw: unknown) => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          const document = doctorClinicalDocument(raw)
          const result = await saveClinicalDocumentDraft({
            document,
            encounterId: current.encounter.id,
            encounterVersion: current.encounter.versionId,
            expectedDraftVersion: current.clinicalDocument?.draft?.version ?? 0,
          }, newIdempotencyKey())
          await refreshCaseById(current.caseId)
          setWorkingClinicalDocuments(documents => ({
            ...documents,
            [current.caseId]: document,
          }))
          hydrateAgentDraft(current.caseId, 'record')
          return result
        },
      },
      'outpatient.preview.request': {
        description: 'Generate the current clinical sign preview without committing it.',
        enabled: detail.data?.consultation === undefined
          ? detail.data?.drafts?.document !== undefined
          : detail.data?.clinicalDocument?.draft !== undefined,
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: () => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          if (current.consultation === undefined) {
            return previewSign.mutateAsync({ caseId: current.caseId })
          }
          const draft = current.clinicalDocument?.draft
          if (draft === undefined) throw new Error(messages.consultationUnavailable)
          return previewStructuredClinicalDocumentSign({
            encounterId: current.encounter.id,
            encounterVersion: current.encounter.versionId,
            expectedDraftVersion: draft.version,
          }, newIdempotencyKey())
        },
      },
      'outpatient.visit.start.propose': {
        description: 'Open human review before starting the selected visit.',
        enabled: detail.data?.status === 'awaiting-doctor'
          || detail.data?.status === 'awaiting-revisit',
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          const revisit = current.status === 'awaiting-revisit'
          return agentReview.request({
            confirmLabel: revisit ? messages.startRevisit : messages.startFirstVisit,
            description: current.patient.name,
            onConfirm: () => revisit
              ? beginRevisit.mutateAsync({ caseId: current.caseId })
              : start.mutateAsync({ caseId: current.caseId }),
            signal,
            title: revisit ? messages.startRevisit : messages.startFirstVisit,
          })
        },
      },
      'outpatient.diagnosis.confirm.propose': {
        description: 'Open human review before confirming structured diagnoses.',
        enabled: detail.data?.consultation !== undefined
          && detail.data.encounter.status === 'in-progress',
        parameters: {
          type: 'object' as const,
          properties: {
            entries: {
              type: 'array',
              minItems: 1,
              maxItems: 8,
              items: {
                type: 'object',
                properties: {
                  catalogItemId: { type: 'string' },
                  note: { type: 'string', maxLength: 500 },
                  role: { type: 'string', enum: ['principal', 'secondary'] },
                },
                required: ['catalogItemId', 'role'],
                additionalProperties: false,
              },
            },
          },
          required: ['entries'],
          additionalProperties: false,
        },
        execute: (raw: unknown, signal: AbortSignal) => {
          const entries = doctorDiagnosisEntries(raw)
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          return agentReview.request({
            confirmLabel: messages.confirmDiagnosis,
            description: `${entries.length} 项诊断`,
            onConfirm: async () => {
              const saved = await saveDiagnosisDraft({
                encounterId: current.encounter.id,
                encounterVersion: current.encounter.versionId,
                entries,
                expectedDraftVersion: current.diagnosis?.draftVersion ?? 0,
              }, newIdempotencyKey())
              const result = await confirmDiagnosis({
                encounterId: current.encounter.id,
                encounterVersion: current.encounter.versionId,
                expectedDraftVersion: saved.data.draftVersion,
              }, newIdempotencyKey())
              await refreshCaseById(current.caseId)
              return result
            },
            signal,
            title: messages.confirmDiagnosis,
          })
        },
      },
      'outpatient.laboratory.issue.propose': {
        description: 'Open human review before issuing the current laboratory request.',
        enabled: usesIndependentLaboratoryRequests
          ? detail.data?.laboratoryRequests?.draft !== undefined
          : detail.data?.drafts?.firstVisit !== undefined,
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => agentReview.request({
          confirmLabel: messages.issueLaboratoryRequest,
          description: resolvedLaboratoryItem?.nameZh ?? messages.consultationUnavailable,
          onConfirm: () => {
            const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
            return usesIndependentLaboratoryRequests
              ? issueRequest.mutateAsync({ caseId: current.caseId })
              : issueOrder.mutateAsync({ caseId: current.caseId })
          },
          signal,
          title: messages.issueLaboratoryRequest,
        }),
      },
      'outpatient.laboratory.cancel.propose': {
        description: 'Open human review before cancelling one cancellable laboratory request.',
        enabled: detail.data?.laboratoryRequests?.requests.some(
          isCancellableLaboratoryRequest,
        ) === true,
        parameters: {
          type: 'object' as const,
          properties: { requestId: { type: 'string', maxLength: 128 } },
          required: ['requestId'],
          additionalProperties: false,
        },
        execute: (raw: unknown, signal: AbortSignal) => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          const requestId = doctorString(raw, 'requestId', 128)
          const request = current.laboratoryRequests?.requests.find(item => item.id === requestId)
          if (request === undefined || !isCancellableLaboratoryRequest(request)) {
            throw new Error(messages.consultationUnavailable)
          }
          return agentReview.request({
            confirmLabel: messages.confirmCancelLaboratoryRequest,
            description: request.catalogItemId,
            onConfirm: () => cancelRequest.mutateAsync({ caseId: current.caseId, request }),
            signal,
            title: messages.cancelLaboratoryRequestTitle,
          })
        },
      },
      'outpatient.report.acknowledge.propose': {
        description: 'Open human review before acknowledging one signed laboratory report.',
        enabled: detail.data?.laboratoryRequests?.requests.some(
          request => request.status === 'reported',
        ) === true,
        parameters: {
          type: 'object' as const,
          properties: { requestId: { type: 'string', maxLength: 128 } },
          required: ['requestId'],
          additionalProperties: false,
        },
        execute: (raw: unknown, signal: AbortSignal) => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          const requestId = doctorString(raw, 'requestId', 128)
          const request = current.laboratoryRequests?.requests.find(item => item.id === requestId)
          if (request?.status !== 'reported' || request.report === undefined) {
            throw new Error(messages.consultationUnavailable)
          }
          return agentReview.request({
            confirmLabel: messages.acknowledgeLaboratoryReport,
            description: request.catalogItemId,
            onConfirm: () => acknowledgeReport.mutateAsync({
              caseId: current.caseId,
              request,
            }),
            signal,
            title: messages.acknowledgeLaboratoryReport,
          })
        },
      },
      'outpatient.report.correct.propose': {
        description: 'Open human review before correcting one quantitative laboratory report.',
        enabled: detail.data?.laboratoryRequests?.requests.some(request => (
          request.report !== undefined
          && request.report.results.every(isQuantitativeLaboratoryResult)
        )) === true,
        parameters: {
          type: 'object' as const,
          properties: {
            conclusion: { type: 'string', maxLength: 2_000 },
            reason: { type: 'string', maxLength: 500 },
            requestId: { type: 'string', maxLength: 128 },
            results: {
              type: 'array',
              minItems: 1,
              maxItems: 32,
              items: {
                type: 'object',
                properties: { code: { type: 'string' }, value: { type: 'number' } },
                required: ['code', 'value'],
                additionalProperties: false,
              },
            },
          },
          required: ['conclusion', 'reason', 'requestId', 'results'],
          additionalProperties: false,
        },
        execute: (raw: unknown, signal: AbortSignal) => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          const input = reportCorrectionInputSchema.parse(raw)
          const request = current.laboratoryRequests?.requests.find(item => item.id === input.requestId)
          if (
            request?.report === undefined
            || !request.report.results.every(isQuantitativeLaboratoryResult)
          ) throw new Error(messages.consultationUnavailable)
          return agentReview.request({
            confirmLabel: messages.confirmLaboratoryReportCorrection,
            description: `${request.catalogItemId} · ${input.reason}`,
            onConfirm: () => correctReport.mutateAsync({
              caseId: current.caseId,
              input: {
                conclusion: input.conclusion,
                reason: input.reason,
                results: input.results,
              },
              request,
            }),
            signal,
            title: messages.previewLaboratoryReportCorrection,
          })
        },
      },
      'outpatient.prescription.issue.propose': {
        description: 'Open human review before issuing the current prescription draft.',
        enabled: detail.data?.medicationConclusion?.draft !== undefined,
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          const state = current.medicationConclusion
          if (state?.draft === undefined) throw new Error(messages.consultationUnavailable)
          return agentReview.request({
            confirmLabel: messages.issuePrescription,
            description: `${current.patient.name} · ${state.draft.items.length} 项药品`,
            onConfirm: () => issueCasePrescription.mutateAsync({ caseId: current.caseId }),
            signal,
            title: messages.issuePrescription,
          })
        },
      },
      'outpatient.prescription.withdraw.propose': {
        description: 'Open human review before withdrawing the current undispensed prescription.',
        enabled: detail.data?.medicationConclusion?.prescription?.status === 'signed'
          || detail.data?.medicationConclusion?.prescription?.status === 'paid',
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          const prescription = current.medicationConclusion?.prescription
          if (
            prescription === undefined
            || (prescription.status !== 'signed' && prescription.status !== 'paid')
          ) throw new Error(messages.consultationUnavailable)
          return agentReview.request({
            confirmLabel: messages.confirmWithdrawal,
            description: prescription.number,
            onConfirm: () => withdrawCasePrescription.mutateAsync({
              caseId: current.caseId,
              prescriptionId: prescription.id,
            }),
            signal,
            title: messages.withdrawPrescriptionTitle,
          })
        },
      },
      'outpatient.medication.none.propose': {
        description: 'Open human review before recording a formal no-medication conclusion.',
        enabled: detail.data?.consultation !== undefined
          && detail.data.medicationConclusion?.prescription === undefined
          && detail.data.medicationConclusion?.noMedication === undefined,
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          const state = current.medicationConclusion
          if (state?.prescription !== undefined || state?.noMedication !== undefined) {
            throw new Error(messages.consultationUnavailable)
          }
          return agentReview.request({
            confirmLabel: messages.confirmNoMedication,
            description: current.patient.name,
            onConfirm: () => confirmCaseNoMedication.mutateAsync({ caseId: current.caseId }),
            signal,
            title: messages.confirmNoMedication,
          })
        },
      },
      'outpatient.record.sign.propose': {
        description: 'Generate a sign preview and open human review before signing clinical facts.',
        enabled: detail.data?.consultation === undefined
          ? detail.data?.drafts?.document !== undefined
          : detail.data?.clinicalDocument?.draft !== undefined,
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: async (_raw: unknown, signal: AbortSignal) => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          if (current.consultation !== undefined) {
            const draft = current.clinicalDocument?.draft
            if (draft === undefined) throw new Error(messages.consultationUnavailable)
            const preview = await previewStructuredClinicalDocumentSign({
              encounterId: current.encounter.id,
              encounterVersion: current.encounter.versionId,
              expectedDraftVersion: draft.version,
            }, newIdempotencyKey())
            return agentReview.request({
              confirmLabel: messages.confirmClinicalRecordSign,
              description: current.patient.name,
              onConfirm: () => signStructuredClinicalDocument({
                commitToken: preview.data.commitToken,
                encounterId: current.encounter.id,
                encounterVersion: current.encounter.versionId,
                previewId: preview.data.previewId,
              }, newIdempotencyKey()).then(async result => {
                await refreshCaseById(current.caseId)
                return result
              }),
              signal,
              title: messages.confirmClinicalRecordSign,
            })
          }
          const preview = await previewSign.mutateAsync({ caseId: current.caseId })
          const dependencies = signingDependencies(current.caseId)
          return agentReview.request({
            confirmLabel: messages.confirmClinicalSign,
            description: detail.data?.patient.name ?? messages.consultationUnavailable,
            onConfirm: () => signClinicalDocument({
              commitToken: preview.data.commitToken,
              encounterId: dependencies.encounterId,
              expectedVersions: dependencies.expectedVersions,
              previewId: preview.data.previewId,
            }, newIdempotencyKey()).then(async result => {
              await refreshCaseById(current.caseId)
              return result
            }),
            signal,
            title: messages.confirmClinicalSign,
          })
        },
      },
      'outpatient.record.revise.propose': {
        description: 'Open human review before creating a revision of the latest signed document.',
        enabled: (detail.data?.clinicalDocument?.signed.length ?? 0) > 0,
        parameters: {
          type: 'object' as const,
          properties: {
            document: {
              type: 'object',
              properties: Object.fromEntries([
                'assessment', 'auxiliaryExamination', 'chiefComplaint', 'disposition',
                'followUp', 'historyOfPresentIllness', 'physicalExamination', 'priorMedicalHistory',
              ].map(key => [key, { type: 'string' }])),
              required: [
                'assessment', 'auxiliaryExamination', 'chiefComplaint', 'disposition',
                'followUp', 'historyOfPresentIllness', 'physicalExamination', 'priorMedicalHistory',
              ],
              additionalProperties: false,
            },
            reason: { type: 'string', maxLength: 500 },
          },
          required: ['document', 'reason'],
          additionalProperties: false,
        },
        execute: (raw: unknown, signal: AbortSignal) => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          const latest = current.clinicalDocument?.signed.at(-1)
          if (latest === undefined) throw new Error(messages.consultationUnavailable)
          const input = clinicalDocumentRevisionInputSchema.parse(raw)
          return agentReview.request({
            confirmLabel: messages.confirmClinicalDocumentRevisionAction,
            description: `${current.patient.name} · ${input.reason}`,
            onConfirm: () => reviseClinicalDocument.mutateAsync({
              caseId: current.caseId,
              compositionId: latest.compositionId,
              compositionVersion: latest.compositionVersion,
              document: input.document,
              encounterId: current.encounter.id,
              encounterVersion: current.encounter.versionId,
              reason: input.reason,
            }),
            signal,
            title: messages.confirmClinicalDocumentRevision,
          })
        },
      },
      'outpatient.encounter.complete.propose': {
        description: 'Open human review before completing the selected Encounter.',
        enabled: detail.data?.encounter.status === 'in-progress',
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          return agentReview.request({
            confirmLabel: messages.encounterCompleted,
            description: current.patient.name,
            onConfirm: () => completeCaseEncounter.mutateAsync({ caseId: current.caseId }),
            signal,
            title: messages.encounterCompleted,
          })
        },
      },
    },
    claim: {
      version: 1 as const,
      viewId: 'consultation' as const,
      activeSection: activeCaseSection,
      viewRevision: agentViewRevision({
        activeCaseId,
        activeCaseSection,
        clinicalDocument: currentClinicalDocument,
        diagnosisDraftVersion: detail.data?.diagnosis?.draftVersion,
        encounterVersion: detail.data?.encounter.versionId,
        laboratoryDraftVersion: detail.data?.laboratoryRequests?.draftVersion,
        page,
      }),
      ...(detail.data === undefined ? {} : {
        selection: {
          id: detail.data.caseId,
          kind: 'case' as const,
          version: detail.data.encounter.versionId,
        },
        ...(currentClinicalDocument === undefined ? {} : {
          draft: {
            dirty: true,
            id: `${detail.data.caseId}:clinical-document`,
            kind: 'clinical-document' as const,
            revision: String(detail.data.clinicalDocument?.draft?.version ?? 0),
          },
        }),
      }),
      ui: {
        status: queue.isPending || detail.isPending ? 'loading' as const
          : queue.isError || detail.isError ? 'error' as const
            : queue.data?.items.length === 0 ? 'empty' as const : 'ready' as const,
      },
    },
    label: 'ClinMesh · 门诊医生',
    readState: () => ({
      case: detail.data === undefined ? null : {
        caseId: detail.data.caseId,
        consultation: detail.data.consultation ?? null,
        diagnosis: detail.data.diagnosis ?? null,
        encounter: detail.data.encounter,
        laboratoryRequests: detail.data.laboratoryRequests ?? null,
        patient: detail.data.patient,
        presentation: detail.data.presentation,
      },
      clinicalDocumentDraft: currentClinicalDocument ?? null,
      queueCount: queue.data?.total ?? 0,
      section: activeCaseSection,
    }),
  }), [
    activeCaseId,
    activeCaseSection,
    acknowledgeReport.mutateAsync,
    agentReview,
    askQuestion.mutateAsync,
    beginRevisit.mutateAsync,
    cancelRequest.mutateAsync,
    confirmCaseDiagnosis.mutateAsync,
    correctReport.mutateAsync,
    currentClinicalDocument,
    detail.data,
    detail.isError,
    detail.isPending,
    hydrateAgentDraft,
    issueOrder.mutateAsync,
    issueRequest.mutateAsync,
    messages,
    onSelectedCaseIdChange,
    page,
    previewSign.mutateAsync,
    queue.data,
    queue.isError,
    queue.isPending,
    resolvedLaboratoryItem,
    saveDraft.mutateAsync,
    saveRevisit.mutateAsync,
    start.mutateAsync,
    usesIndependentLaboratoryRequests,
  ])
  useRegisterAgentPage(agentPage)
  return (
    <div className="grid min-h-[calc(100svh-9.5rem)] min-w-0 grid-cols-1 border bg-background xl:grid-cols-[300px_minmax(0,1fr)]">
      <DoctorQueueModule
        activeCaseId={activeCaseId}
        messages={messages}
        onQueuePageChange={(nextPage) => {
          setPage(nextPage)
          onSelectedCaseIdChange(undefined)
        }}
        onSelectCase={onSelectedCaseIdChange}
        onSelectVirtualPatient={(patient) => {
          startCandidate.reset()
          setSelectedVirtualPatientId(patient.id)
        }}
        onStartVirtualPatient={patient => startCandidate.mutate(patient)}
        onVirtualPatientPageChange={(nextPage) => {
          setVirtualPatientPage(nextPage)
          setSelectedVirtualPatientId(undefined)
        }}
        queueData={queue.data}
        queueError={queue.error}
        queuePending={queue.isPending}
        selectedVirtualPatient={selectedVirtualPatient}
        startError={startCandidate.error}
        startPending={startCandidate.isPending}
        virtualPatientData={virtualPatients.data}
        virtualPatientError={virtualPatients.error}
        virtualPatientPending={virtualPatients.isPending}
      />
      <section aria-labelledby="case-detail-heading" className="flex min-w-0 flex-col gap-3 p-3">
        <h2 className="sr-only" id="case-detail-heading">{messages.caseDetail}</h2>
        {issueOrder.isSuccess && issueOrder.variables.caseId === activeCaseId ? (
          <Alert>
            <CheckIcon aria-hidden="true" />
            <AlertTitle>{messages.laboratoryOrderIssued}</AlertTitle>
            <AlertDescription>
              {messages.awaitingLaboratoryPayment} · {formatFen(issueOrder.data.data.totalFen, locale)}
            </AlertDescription>
          </Alert>
        ) : null}
        {completeSign.isSuccess && completeSign.variables.caseId === activeCaseId ? (
          <Alert>
            <CheckCircleIcon aria-hidden="true" />
            <AlertTitle>{messages.encounterCompleted}</AlertTitle>
            <AlertDescription>{messages.awaitingMedicationPayment}</AlertDescription>
          </Alert>
        ) : null}
        {detail.isPending && activeCaseId !== undefined ? <Skeleton className="h-64 w-full" /> : detail.isError ? (
          <ErrorAlert message={getWorkspaceErrorMessage(detail.error, messages)} title={getWorkspaceErrorTitle(detail.error, messages, messages.consultationUnavailable)} />
        ) : detail.data === undefined ? (
          <Empty className="min-h-44 border"><EmptyHeader><EmptyMedia variant="icon"><ClipboardPenIcon aria-hidden="true" /></EmptyMedia><EmptyTitle>{messages.noConsultationCases}</EmptyTitle></EmptyHeader></Empty>
        ) : (
          <CaseDetail
            agentDraftHydrationRevisions={agentDraftHydrationRevisions[detail.data.caseId]
              ?? emptyDoctorAgentDraftHydrationRevisions}
            clinicalDocumentActions={{
              prepareSign: {
                data: prepareClinicalDocumentSign.variables?.caseId === detail.data.caseId
                  ? prepareClinicalDocumentSign.data?.data
                  : undefined,
                error: prepareClinicalDocumentSign.variables?.caseId === detail.data.caseId
                  ? prepareClinicalDocumentSign.error
                  : null,
                onReset: prepareClinicalDocumentSign.reset,
                onSubmit: document => prepareClinicalDocumentSign.mutate({
                  caseId: detail.data.caseId,
                  document,
                }),
                pending: prepareClinicalDocumentSign.isPending
                  && prepareClinicalDocumentSign.variables?.caseId === detail.data.caseId,
              },
              revise: {
                error: reviseClinicalDocument.variables?.caseId === detail.data.caseId
                  ? reviseClinicalDocument.error
                  : null,
                onSubmit: input => reviseClinicalDocument.mutate(input),
                pending: reviseClinicalDocument.isPending
                  && reviseClinicalDocument.variables?.caseId === detail.data.caseId,
                success: reviseClinicalDocument.isSuccess
                  && reviseClinicalDocument.variables?.caseId === detail.data.caseId,
              },
              sign: {
                error: signStructuredDocument.variables?.caseId === detail.data.caseId
                  ? signStructuredDocument.error
                  : null,
                onSubmit: preview => signStructuredDocument.mutate({
                  caseId: detail.data.caseId,
                  preview,
                }),
                pending: signStructuredDocument.isPending
                  && signStructuredDocument.variables?.caseId === detail.data.caseId,
                success: signStructuredDocument.isSuccess
                  && signStructuredDocument.variables?.caseId === detail.data.caseId,
              },
            }}
            completion={completion}
            completionAction={{
              error: completeCaseEncounter.variables?.caseId === detail.data.caseId
                ? completeCaseEncounter.error
                : null,
              onSubmit: () => completeCaseEncounter.mutate({ caseId: detail.data.caseId }),
              pending: completeCaseEncounter.isPending
                && completeCaseEncounter.variables?.caseId === detail.data.caseId,
              success: completeCaseEncounter.isSuccess
                && completeCaseEncounter.variables?.caseId === detail.data.caseId,
            }}
            correctionTarget={correctionNavigation?.caseId === detail.data.caseId
              ? correctionNavigation.target
              : undefined}
            consultationAction={{
              error: askQuestion.variables?.caseId === detail.data.caseId
                ? askQuestion.error
                : null,
              onAsk: questionCode => askQuestion.mutate({
                caseId: detail.data.caseId,
                questionCode,
              }),
              pending: askQuestion.isPending
                && askQuestion.variables?.caseId === detail.data.caseId,
            }}
            catalog={catalog}
            detail={detail.data}
            diagnosisActions={{
              confirm: {
                error: confirmCaseDiagnosis.variables?.caseId === detail.data.caseId
                  ? confirmCaseDiagnosis.error
                  : null,
                onSubmit: () => confirmCaseDiagnosis.mutate({ caseId: detail.data.caseId }),
                pending: confirmCaseDiagnosis.isPending
                  && confirmCaseDiagnosis.variables?.caseId === detail.data.caseId,
              },
              save: {
                error: saveCaseDiagnosis.variables?.caseId === detail.data.caseId
                  ? saveCaseDiagnosis.error
                  : null,
                onSubmit: entries => saveCaseDiagnosis.mutate({
                  caseId: detail.data.caseId,
                  entries,
                }),
                pending: saveCaseDiagnosis.isPending
                  && saveCaseDiagnosis.variables?.caseId === detail.data.caseId,
                savedRevision: saveCaseDiagnosis.isSuccess
                  && saveCaseDiagnosis.variables?.caseId === detail.data.caseId
                  ? JSON.stringify(saveCaseDiagnosis.variables.entries)
                  : undefined,
                success: saveCaseDiagnosis.isSuccess
                  && saveCaseDiagnosis.variables?.caseId === detail.data.caseId,
              },
            }}
            indicationCode={resolvedIndicationCode}
            key={detail.data.caseId}
            laboratoryCatalog={laboratoryCatalog}
            laboratoryItemId={resolvedLaboratoryItemId}
            laboratoryRequestActions={{
              acknowledge: {
                error: acknowledgeReport.variables?.caseId === detail.data.caseId
                  ? acknowledgeReport.error
                  : null,
                onSubmit: request => acknowledgeReport.mutate({
                  caseId: detail.data.caseId,
                  request,
                }),
                pending: acknowledgeReport.isPending
                  && acknowledgeReport.variables?.caseId === detail.data.caseId,
                ...(acknowledgeReport.isPending
                  && acknowledgeReport.variables?.caseId === detail.data.caseId
                  ? { pendingRequestId: acknowledgeReport.variables.request.id }
                  : {}),
              },
              cancel: {
                error: cancelRequest.variables?.caseId === detail.data.caseId
                  && detail.data.laboratoryRequests?.requests.some(
                    request => request.id === cancelRequest.variables?.request.id,
                  ) === true
                  ? cancelRequest.error
                  : null,
                onSubmit: request => cancelRequest.mutate({ caseId: detail.data.caseId, request }),
                pending: cancelRequest.isPending
                  && cancelRequest.variables?.caseId === detail.data.caseId,
                ...(cancelRequest.isSuccess
                  && cancelRequest.variables?.caseId === detail.data.caseId
                  ? { successRequestId: cancelRequest.variables.request.id }
                  : {}),
              },
              correct: {
                allowed: session.availableRoles.some(role => role.code === 'administrator'),
                error: correctReport.variables?.caseId === detail.data.caseId
                  && detail.data.laboratoryRequests?.requests.some(request => (
                    request.id === correctReport.variables?.request.id
                    && request.report?.diagnosticReportId
                      === correctReport.variables?.request.report?.diagnosticReportId
                  )) === true
                  ? correctReport.error
                  : null,
                ...(correctReport.variables === undefined
                  ? {}
                  : { lastRequestId: correctReport.variables.request.id }),
                onSubmit: (request, input) => correctReport.mutate({
                  caseId: detail.data.caseId,
                  input,
                  request,
                }),
                pending: correctReport.isPending
                  && correctReport.variables?.caseId === detail.data.caseId,
                ...(correctReport.isPending
                  && correctReport.variables?.caseId === detail.data.caseId
                  ? { pendingRequestId: correctReport.variables.request.id }
                  : {}),
                ...(correctReport.isSuccess
                  && correctReport.variables?.caseId === detail.data.caseId
                  ? { successRequestId: correctReport.variables.request.id }
                  : {}),
              },
              deleteDraft: {
                error: deleteRequestDraft.variables === detail.data.caseId
                  ? deleteRequestDraft.error
                  : null,
                onSubmit: () => deleteRequestDraft.mutate(detail.data.caseId),
                pending: deleteRequestDraft.isPending
                  && deleteRequestDraft.variables === detail.data.caseId,
                ...(deleteRequestDraft.data === undefined
                  || deleteRequestDraft.variables !== detail.data.caseId
                  ? {}
                  : {
                      success: {
                        caseId: detail.data.caseId,
                        draftVersion: deleteRequestDraft.data.data.draftVersion,
                      },
                    }),
              },
              issue: {
                error: issueRequest.variables?.caseId === detail.data.caseId
                  ? issueRequest.error
                  : null,
                onSubmit: () => issueRequest.mutate({ caseId: detail.data.caseId }),
                pending: issueRequest.isPending
                  && issueRequest.variables?.caseId === detail.data.caseId,
              },
              retry: {
                error: retryResultGeneration.variables?.caseId === detail.data.caseId
                  ? retryResultGeneration.error
                  : null,
                onSubmit: request => retryResultGeneration.mutate({
                  caseId: detail.data.caseId,
                  request,
                }),
                pending: retryResultGeneration.isPending
                  && retryResultGeneration.variables?.caseId === detail.data.caseId,
                ...(retryResultGeneration.isPending
                  && retryResultGeneration.variables?.caseId === detail.data.caseId
                  ? { pendingRequestId: retryResultGeneration.variables.request.id }
                  : {}),
              },
              save: {
                error: saveLaboratoryRequest.variables?.caseId === detail.data.caseId
                  ? saveLaboratoryRequest.error
                  : null,
                onSubmit: () => saveLaboratoryRequest.mutate({ caseId: detail.data.caseId }),
                pending: saveLaboratoryRequest.isPending
                  && saveLaboratoryRequest.variables?.caseId === detail.data.caseId,
              },
            }}
            locale={locale}
            messages={messages}
            onClinicalDocumentChange={document => {
              setWorkingClinicalDocuments(current => ({
                ...current,
                [detail.data.caseId]: document,
              }))
            }}
            onActiveSectionChange={setActiveCaseSection}
            onIndicationChange={setIndicationCode}
            onCorrectionNavigationHandled={onCorrectionNavigationHandled}
            onLaboratoryItemChange={(value) => {
              setLaboratoryItemId(value)
              setIndicationCode('')
            }}
            onIssueOrder={() => {
              onSelectedCaseIdChange(detail.data.caseId)
              issueOrder.mutate({ caseId: detail.data.caseId })
            }}
            onPreviewSign={() => previewSign.mutate({ caseId: detail.data.caseId })}
            prescriptionActions={{
              confirmNoMedication: {
                error: confirmCaseNoMedication.variables?.caseId === detail.data.caseId
                  ? confirmCaseNoMedication.error
                  : null,
                onSubmit: () => confirmCaseNoMedication.mutate({ caseId: detail.data.caseId }),
                pending: confirmCaseNoMedication.isPending
                  && confirmCaseNoMedication.variables?.caseId === detail.data.caseId,
              },
              deleteDraft: {
                data: removePrescriptionDraft.variables?.caseId === detail.data.caseId
                  && removePrescriptionDraft.data !== undefined
                  ? {
                      caseId: detail.data.caseId,
                      draftVersion: removePrescriptionDraft.data.data.draftVersion,
                    }
                  : undefined,
                error: removePrescriptionDraft.variables?.caseId === detail.data.caseId
                  ? removePrescriptionDraft.error
                  : null,
                onSubmit: () => removePrescriptionDraft.mutate({ caseId: detail.data.caseId }),
                pending: removePrescriptionDraft.isPending
                  && removePrescriptionDraft.variables?.caseId === detail.data.caseId,
              },
              issue: {
                error: issueCasePrescription.variables?.caseId === detail.data.caseId
                  ? issueCasePrescription.error
                  : null,
                onSubmit: () => issueCasePrescription.mutate({ caseId: detail.data.caseId }),
                pending: issueCasePrescription.isPending
                  && issueCasePrescription.variables?.caseId === detail.data.caseId,
              },
              saveDraft: {
                error: savePrescription.variables?.caseId === detail.data.caseId
                  ? savePrescription.error
                  : null,
                onSubmit: items => savePrescription.mutate({
                  caseId: detail.data.caseId,
                  items,
                }),
                pending: savePrescription.isPending
                  && savePrescription.variables?.caseId === detail.data.caseId,
                savedRevision: savePrescription.isSuccess
                  && savePrescription.variables?.caseId === detail.data.caseId
                  ? JSON.stringify(savePrescription.variables.items)
                  : undefined,
                success: savePrescription.isSuccess
                  && savePrescription.variables?.caseId === detail.data.caseId,
              },
              withdraw: {
                error: withdrawCasePrescription.variables?.caseId === detail.data.caseId
                  ? withdrawCasePrescription.error
                  : null,
                onSubmit: () => {
                  const prescription = detail.data.medicationConclusion?.prescription
                  if (prescription !== undefined) {
                    withdrawCasePrescription.mutate({
                      caseId: detail.data.caseId,
                      prescriptionId: prescription.id,
                    })
                  }
                },
                pending: withdrawCasePrescription.isPending
                  && withdrawCasePrescription.variables?.caseId === detail.data.caseId,
              },
            }}
            referenceCatalogSearches={referenceCatalogSearches}
            onSaveDraft={input => saveDraft.mutate({ caseId: detail.data.caseId, ...input })}
            onSaveRevisit={input => saveRevisit.mutate({ caseId: detail.data.caseId, ...input })}
            onSign={() => {
              onSelectedCaseIdChange(detail.data.caseId)
              completeSign.mutate({ caseId: detail.data.caseId })
            }}
            onStart={() => start.mutate({ caseId: detail.data.caseId })}
            onStartRevisit={() => beginRevisit.mutate({ caseId: detail.data.caseId })}
            issueOrderError={issueOrder.variables?.caseId === detail.data.caseId ? issueOrder.error : null}
            issueOrderPending={issueOrder.isPending && issueOrder.variables?.caseId === detail.data.caseId}
            saveDraftError={saveDraft.variables?.caseId === detail.data.caseId ? saveDraft.error : null}
            saveDraftPending={saveDraft.isPending && saveDraft.variables?.caseId === detail.data.caseId}
            saveDraftSuccess={saveDraft.isSuccess && saveDraft.variables?.caseId === detail.data.caseId}
            saveRevisitError={saveRevisit.variables?.caseId === detail.data.caseId ? saveRevisit.error : null}
            saveRevisitPending={saveRevisit.isPending && saveRevisit.variables?.caseId === detail.data.caseId}
            saveRevisitSuccess={saveRevisit.isSuccess && saveRevisit.variables?.caseId === detail.data.caseId}
            signCompleted={completeSign.isSuccess && completeSign.variables?.caseId === detail.data.caseId}
            signError={completeSign.variables?.caseId === detail.data.caseId ? completeSign.error : null}
            signPending={completeSign.isPending && completeSign.variables?.caseId === detail.data.caseId}
            signPreview={previewSign.variables?.caseId === detail.data.caseId
              ? previewSign.data?.data
              : undefined}
            signPreviewError={previewSign.variables?.caseId === detail.data.caseId ? previewSign.error : null}
            signPreviewPending={previewSign.isPending && previewSign.variables?.caseId === detail.data.caseId}
            startError={start.variables?.caseId === detail.data.caseId ? start.error : null}
            startPending={start.isPending && start.variables?.caseId === detail.data.caseId}
            startRevisitError={beginRevisit.variables?.caseId === detail.data.caseId
              ? beginRevisit.error
              : null}
            startRevisitPending={beginRevisit.isPending
              && beginRevisit.variables?.caseId === detail.data.caseId}
            workingClinicalDocument={workingClinicalDocuments[detail.data.caseId]
              ?? createWorkingClinicalDocument(detail.data)}
          />
        )}
      </section>
    </div>
  )
}

function CaseDetail({
  agentDraftHydrationRevisions,
  catalog,
  clinicalDocumentActions,
  completion,
  completionAction,
  consultationAction,
  correctionTarget,
  detail,
  diagnosisActions,
  indicationCode,
  issueOrderError,
  issueOrderPending,
  laboratoryItemId,
  laboratoryCatalog,
  laboratoryRequestActions,
  locale,
  messages,
  onClinicalDocumentChange,
  onActiveSectionChange,
  onIssueOrder,
  onIndicationChange,
  onCorrectionNavigationHandled,
  onPreviewSign,
  onLaboratoryItemChange,
  prescriptionActions,
  referenceCatalogSearches,
  onSaveDraft,
  onSaveRevisit,
  onSign,
  onStart,
  onStartRevisit,
  saveDraftError,
  saveDraftPending,
  saveDraftSuccess,
  saveRevisitError,
  saveRevisitPending,
  saveRevisitSuccess,
  signCompleted,
  signError,
  signPending,
  signPreview,
  signPreviewError,
  signPreviewPending,
  startError,
  startPending,
  startRevisitError,
  startRevisitPending,
  workingClinicalDocument,
}: {
  agentDraftHydrationRevisions: DoctorAgentDraftHydrationRevisions
  catalog: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getClinicalCatalog>>>>
  clinicalDocumentActions: ClinicalDocumentPageActions
  completion: UseQueryResult<EncounterCompletionPreview, Error>
  completionAction: EncounterCompletionAction
  consultationAction: ConsultationPageAction
  correctionTarget: CompletedCaseCorrectionTarget | undefined
  detail: DoctorCaseDetail
  diagnosisActions: DiagnosisPageActions
  indicationCode: string
  issueOrderError: Error | null
  issueOrderPending: boolean
  laboratoryCatalog: ClinicalCatalog['laboratory']
  laboratoryItemId: string
  laboratoryRequestActions: LaboratoryPageActions
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onClinicalDocumentChange: (document: ClinicalDocumentContent) => void
  onActiveSectionChange: (section: DoctorCaseSection) => void
  onIssueOrder: () => void
  onIndicationChange: (value: string) => void
  onCorrectionNavigationHandled: () => void
  onPreviewSign: () => void
  onLaboratoryItemChange: (value: string) => void
  prescriptionActions: PrescriptionPageActions
  referenceCatalogSearches: ReferenceCatalogSearches
  onSaveDraft: (input: { assessment: string; historyOfPresentIllness: string }) => void
  onSaveRevisit: (input: {
    diagnosis: { code: string; display: string }
    document: { assessment: string; plan: string }
    medications: Array<{
      catalogItemId: string
      doseText: string
      frequencyCode: string
      quantity: number
    }>
  }) => void
  onSign: () => void
  onStart: () => void
  onStartRevisit: () => void
  saveDraftError: Error | null
  saveDraftPending: boolean
  saveDraftSuccess: boolean
  saveRevisitError: Error | null
  saveRevisitPending: boolean
  saveRevisitSuccess: boolean
  signCompleted: boolean
  signError: Error | null
  signPending: boolean
  signPreview: Awaited<ReturnType<typeof previewClinicalSign>>['data'] | undefined
  signPreviewError: Error | null
  signPreviewPending: boolean
  startError: Error | null
  startPending: boolean
  startRevisitError: Error | null
  startRevisitPending: boolean
  workingClinicalDocument: ClinicalDocumentContent
}): React.JSX.Element {
  const firstVisitDraft = detail.drafts?.firstVisit
  const readOnly = detail.encounter.status !== 'in-progress'
  const visitNotStarted = detail.status === 'awaiting-doctor'
  const clinicalReadOnly = readOnly || visitNotStarted
  const [activeSection, setActiveSection] = useState<DoctorCaseSection>('record')
  const [contextRailOpen, setContextRailOpen] = useState(true)
  const [pendingNavigation, setPendingNavigation] = useState<{
    source: 'checklist' | 'correction'
    target: EncounterCompletionTarget
  }>()
  useEffect(() => {
    if (correctionTarget === undefined) return
    setActiveSection(caseDetailSectionByCompletionTarget[correctionTarget])
    setPendingNavigation({ source: 'correction', target: correctionTarget })
  }, [correctionTarget, detail.caseId])

  useEffect(() => {
    if (pendingNavigation === undefined) return
    const target = document.getElementById(
      encounterCompletionTargetElementIds[pendingNavigation.target],
    )
    if (target === null) return
    target.focus()
    target.scrollIntoView?.({ block: 'start' })
    if (pendingNavigation.source === 'correction') onCorrectionNavigationHandled()
    setPendingNavigation(undefined)
  }, [activeSection, onCorrectionNavigationHandled, pendingNavigation])

  useEffect(() => {
    onActiveSectionChange(activeSection)
  }, [activeSection, onActiveSectionChange])

  const navigateToCompletionTarget = (target: EncounterCompletionTarget): void => {
    setActiveSection(caseDetailSectionByCompletionTarget[target])
    setPendingNavigation({ source: 'checklist', target })
  }

  const overviewWorkflow = readOnly ? null : detail.status === 'awaiting-doctor' ? (
    <div className="flex flex-col items-start gap-3">
      <Button disabled={startPending} onClick={onStart} type="button">
        <StethoscopeIcon data-icon="inline-start" />
        {messages.startFirstVisit}
      </Button>
      {startError === null ? null : (
        <ErrorAlert
          message={getWorkspaceErrorMessage(startError, messages)}
          title={getWorkspaceErrorTitle(startError, messages, messages.operationFailed)}
        />
      )}
    </div>
  ) : detail.status === 'awaiting-revisit' ? (
    <div className="flex flex-col items-start gap-3">
      <Button disabled={startRevisitPending} onClick={onStartRevisit} type="button">
        <StethoscopeIcon data-icon="inline-start" />
        {messages.startRevisit}
      </Button>
      {startRevisitError === null ? null : (
        <ErrorAlert
          message={getWorkspaceErrorMessage(startRevisitError, messages)}
          title={getWorkspaceErrorTitle(startRevisitError, messages, messages.operationFailed)}
        />
      )}
    </div>
  ) : null

  const firstVisitRecord = readOnly || detail.status !== 'first-visit' ? null : (
    <section aria-labelledby="first-visit-heading" className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold" id="first-visit-heading">{messages.firstVisitRecord}</h3>
      <form
        aria-labelledby="first-visit-heading"
        key={`${detail.caseId}:${firstVisitDraft?.version ?? 0}:${agentDraftHydrationRevisions['first-visit'] ?? 0}`}
        onSubmit={event => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          onSaveDraft({
            assessment: String(data.get('assessment') ?? ''),
            historyOfPresentIllness: String(data.get('historyOfPresentIllness') ?? ''),
          })
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="first-visit-history">{messages.historyOfPresentIllness}</FieldLabel>
            <Textarea
              defaultValue={firstVisitDraft?.historyOfPresentIllness}
              id="first-visit-history"
              name="historyOfPresentIllness"
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="first-visit-assessment">{messages.firstVisitAssessment}</FieldLabel>
            <Textarea
              defaultValue={firstVisitDraft?.assessment}
              id="first-visit-assessment"
              name="assessment"
              required
            />
          </Field>
          <div className="flex justify-end">
            <Button disabled={saveDraftPending} type="submit">
              <ClipboardPenIcon data-icon="inline-start" />
              {messages.saveFirstVisitDraft}
            </Button>
          </div>
          {saveDraftSuccess ? (
            <Alert><CheckIcon aria-hidden="true" /><AlertTitle>{messages.draftSaved}</AlertTitle></Alert>
          ) : null}
          {saveDraftError === null ? null : (
            <ErrorAlert
              message={getWorkspaceErrorMessage(saveDraftError, messages)}
              title={getWorkspaceErrorTitle(saveDraftError, messages, messages.operationFailed)}
            />
          )}
        </FieldGroup>
      </form>
    </section>
  )

  const revisitWorkflow = readOnly
    || detail.status !== 'revisit-draft'
    || detail.consultation !== undefined
    ? null
    : catalog.isPending ? <Skeleton className="h-72 w-full" /> : catalog.isError ? (
      <ErrorAlert
        message={getWorkspaceErrorMessage(catalog.error, messages)}
        title={getWorkspaceErrorTitle(catalog.error, messages, messages.consultationUnavailable)}
      />
    ) : (
      <div className="flex flex-col gap-3">
        {saveRevisitSuccess ? (
          <Alert><CheckIcon aria-hidden="true" /><AlertTitle>{messages.revisitDraftSaved}</AlertTitle></Alert>
        ) : null}
        {detail.drafts?.prescription === undefined ? null : (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{messages.prescriptionNumber}</span>
            <Badge variant="outline">{detail.drafts.prescription.number}</Badge>
          </div>
        )}
        <RevisitEditor
          catalog={catalog.data}
          detail={detail}
          key={`${detail.caseId}:${detail.drafts?.prescription?.version ?? 0}:${agentDraftHydrationRevisions.revisit ?? 0}`}
          locale={locale}
          messages={messages}
          onSave={onSaveRevisit}
          pending={saveRevisitPending}
        />
        {saveRevisitError === null ? null : (
          <ErrorAlert
            message={getWorkspaceErrorMessage(saveRevisitError, messages)}
            title={getWorkspaceErrorTitle(saveRevisitError, messages, messages.operationFailed)}
          />
        )}
        {signCompleted ? null : (
          <section aria-labelledby="clinical-sign-heading" className="flex flex-col gap-3 border-t pt-5">
            <div className="flex justify-end">
              <Button
                disabled={signPreviewPending}
                onClick={onPreviewSign}
                type="button"
                variant="outline"
              >
                <FileSignatureIcon data-icon="inline-start" />
                {messages.previewClinicalSign}
              </Button>
            </div>
            {signPreviewError === null ? null : (
              <ErrorAlert
                message={getWorkspaceErrorMessage(signPreviewError, messages)}
                title={getWorkspaceErrorTitle(signPreviewError, messages, messages.operationFailed)}
              />
            )}
            {signPreview === undefined ? null : (
              <div className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold" id="clinical-sign-heading">
                  {messages.clinicalSignPreview}
                </h3>
                <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">{messages.diagnosis}</dt>
                    <dd className="font-medium">
                      {signPreview.summary.diagnosis.code} · {signPreview.summary.diagnosis.display}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{messages.documentSummary}</dt>
                    <dd className="font-medium">{signPreview.summary.document.assessment}</dd>
                    <dd className="text-muted-foreground">{signPreview.summary.document.plan}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{messages.amount}</dt>
                    <dd className="font-medium">{formatFen(signPreview.medicationTotalFen, locale)}</dd>
                  </div>
                </dl>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{messages.medication}</TableHead>
                      <TableHead>{messages.quantity}</TableHead>
                      <TableHead>{messages.unitPrice}</TableHead>
                      <TableHead>{messages.subtotal}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {signPreview.summary.medications.map(medication => (
                      <TableRow key={medication.medicationRequestId}>
                        <TableCell className="font-medium">
                          {locale === 'zh-CN' ? medication.nameZh : medication.nameEn}
                        </TableCell>
                        <TableCell>{medication.quantity}</TableCell>
                        <TableCell>{formatFen(medication.unitPriceFen, locale)}</TableCell>
                        <TableCell>{formatFen(medication.subtotalFen, locale)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="flex justify-end">
                  <Button disabled={signPending} onClick={onSign} type="button">
                    <CheckCircleIcon data-icon="inline-start" />
                    {messages.confirmClinicalSign}
                  </Button>
                </div>
              </div>
            )}
            {signError === null ? null : (
              <ErrorAlert
                message={getWorkspaceErrorMessage(signError, messages)}
                title={getWorkspaceErrorTitle(signError, messages, messages.operationFailed)}
              />
            )}
          </section>
        )}
      </div>
    )

  return (
    <div className={contextRailOpen
      ? 'grid min-w-0 overflow-hidden border bg-background xl:grid-cols-[minmax(0,1fr)_300px]'
      : 'grid min-w-0 overflow-hidden border bg-background xl:grid-cols-[minmax(0,1fr)_2.75rem]'}>
      <div className="flex min-w-0 flex-col">
        <PatientBanner
          {...(clinicalReadOnly || detail.consultation === undefined
            ? {}
            : {
                completionAction: (
                  <EncounterCompletionPanel
                    action={completionAction}
                    messages={messages}
                    onNavigate={navigateToCompletionTarget}
                    preview={completion}
                  />
                ),
              })}
          detail={detail}
          messages={messages}
          statusText={doctorCaseStatusLabel(detail.status, messages)}
        />

        {overviewWorkflow === null ? null : (
          <div className="border-b p-4">{overviewWorkflow}</div>
        )}

        <Tabs
          className="min-w-0 gap-0 bg-background"
          onValueChange={value => {
            if (value === 'consultation' || value === 'record' || value === 'diagnosis' || value === 'prescription' || value === 'laboratory') {
              setActiveSection(value)
            }
          }}
          value={activeSection}
        >
          <div className="overflow-x-auto border-b px-2">
            <TabsList className="h-11 min-w-max" variant="line">
              {detail.consultation === undefined ? null : (
                <TabsTrigger id={doctorCaseSectionTabElementIds.consultation} value="consultation"><MessagesSquareIcon aria-hidden="true" />{messages.consultationRecord}</TabsTrigger>
              )}
              <TabsTrigger id={doctorCaseSectionTabElementIds.record} value="record"><ClipboardListIcon aria-hidden="true" />{messages.medicalRecord}</TabsTrigger>
              <TabsTrigger id={doctorCaseSectionTabElementIds.laboratory} value="laboratory"><TestTubesIcon aria-hidden="true" />{messages.laboratoryAndExamination}</TabsTrigger>
              <TabsTrigger id={doctorCaseSectionTabElementIds.diagnosis} value="diagnosis"><StethoscopeIcon aria-hidden="true" />{messages.diagnosis}</TabsTrigger>
              <TabsTrigger id={doctorCaseSectionTabElementIds.prescription} value="prescription"><PillIcon aria-hidden="true" />{messages.prescription}</TabsTrigger>
            </TabsList>
          </div>

          {detail.consultation === undefined ? null : (
            <TabsContent className="p-4" value="consultation">
              <ConsultationPage
                action={consultationAction}
                consultation={detail.consultation}
                key={`consultation:${detail.caseId}`}
                locale={locale}
                messages={messages}
                patientName={detail.patient.name}
                readOnly={clinicalReadOnly}
              />
            </TabsContent>
          )}

          <TabsContent className="p-4" value="record">
            <div className="flex flex-col gap-4">
              <div className="min-w-0">
                {visitNotStarted ? null : detail.consultation === undefined ? firstVisitRecord : (
                  <ClinicalDocumentPage
                    actions={clinicalDocumentActions}
                    allowRevision={!clinicalReadOnly || correctionTarget === 'clinical-document'}
                    detail={detail}
                    elementId={encounterCompletionTargetElementIds['clinical-document']}
                    key={`structured-clinical-document:${detail.caseId}:${agentDraftHydrationRevisions.record ?? 0}`}
                    locale={locale}
                    messages={messages}
                    onDocumentChange={onClinicalDocumentChange}
                    workingDocument={workingClinicalDocument}
                  />
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent className="p-4" value="diagnosis">
            {detail.consultation === undefined ? revisitWorkflow : catalog.isPending ? (
              <Skeleton className="h-72 w-full" />
            ) : catalog.isError ? (
              <ErrorAlert
                message={getWorkspaceErrorMessage(catalog.error, messages)}
                title={getWorkspaceErrorTitle(catalog.error, messages, messages.consultationUnavailable)}
              />
            ) : (
              <DiagnosisPage
                actions={diagnosisActions}
                catalog={catalog.data.diagnoses}
                elementId={encounterCompletionTargetElementIds.diagnosis}
                key={`${detail.caseId}:${agentDraftHydrationRevisions.diagnosis ?? 0}`}
                locale={locale}
                messages={messages}
                readOnly={clinicalReadOnly}
                referenceSearch={referenceCatalogSearches.diagnoses}
                state={detail.diagnosis}
              />
            )}
          </TabsContent>

          <TabsContent className="p-4" value="prescription">
            {detail.consultation === undefined || catalog.isPending ? (
              detail.consultation === undefined ? revisitWorkflow : <Skeleton className="h-72 w-full" />
            ) : catalog.isError ? (
              <ErrorAlert
                message={getWorkspaceErrorMessage(catalog.error, messages)}
                title={getWorkspaceErrorTitle(catalog.error, messages, messages.consultationUnavailable)}
              />
            ) : catalog.data.prescriptionConclusionSupported ? (
              <PrescriptionPage
                actions={prescriptionActions}
                allowWithdrawal={!clinicalReadOnly || correctionTarget === 'medication-conclusion'}
                catalog={catalog.data.medications}
                detail={detail}
                elementId={encounterCompletionTargetElementIds['medication-conclusion']}
                key={`medication-conclusion:${detail.caseId}:${agentDraftHydrationRevisions.prescription ?? 0}`}
                locale={locale}
                messages={messages}
                readOnly={clinicalReadOnly}
                referenceSearch={referenceCatalogSearches.medications}
              />
            ) : null}
          </TabsContent>

          <TabsContent className="p-4" value="laboratory">
            <LaboratoryPage
              actions={laboratoryRequestActions}
              catalogError={catalog.error}
              catalogPending={catalog.isPending}
              detail={detail}
              elementId={encounterCompletionTargetElementIds.laboratory}
              indicationCode={indicationCode}
              issueLegacyOrderError={issueOrderError}
              issueLegacyOrderPending={issueOrderPending}
              laboratoryCatalog={laboratoryCatalog}
              laboratoryItemId={laboratoryItemId}
              key={`laboratory:${detail.caseId}:${agentDraftHydrationRevisions.laboratory ?? 0}`}
              locale={locale}
              messages={messages}
              onIndicationChange={onIndicationChange}
              onIssueLegacyOrder={onIssueOrder}
              onLaboratoryItemChange={onLaboratoryItemChange}
              readOnly={clinicalReadOnly}
              referenceSearch={referenceCatalogSearches.laboratory}
              showCorrection={correctionTarget === 'laboratory'}
            />
          </TabsContent>
        </Tabs>
      </div>

      <DoctorCaseContextRail
        completion={completion.data}
        detail={detail}
        expanded={contextRailOpen}
        locale={locale}
        messages={messages}
        onExpandedChange={setContextRailOpen}
        section={activeSection}
        statusText={doctorCaseStatusLabel(detail.status, messages)}
      />
    </div>
  )
}

function EncounterCompletionPanel({ action, messages, onNavigate, preview }: {
  action: EncounterCompletionAction
  messages: ReturnType<typeof getWorkspaceMessages>
  onNavigate: (target: EncounterCompletionTarget) => void
  preview: UseQueryResult<EncounterCompletionPreview, Error>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (action.success) setOpen(false)
  }, [action.success])
  const incompleteItems = preview.data?.items.filter(item => item.status !== 'complete') ?? []

  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogTrigger
        render={<Button disabled={preview.isPending} size="sm" type="button" />}
      >
        <ClipboardCheckIcon aria-hidden="true" data-icon="inline-start" />
        {messages.finishEncounter}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {preview.data?.canComplete === true
              ? messages.confirmEncounterCompletion
              : messages.encounterBlocked}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {preview.data?.canComplete === true
              ? messages.confirmEncounterCompletionDescription
              : messages.encounterBlockedDescription}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {preview.isPending ? <Skeleton className="h-28 w-full" /> : preview.isError ? (
          <ErrorAlert
            message={getWorkspaceErrorMessage(preview.error, messages)}
            title={getWorkspaceErrorTitle(preview.error, messages, messages.encounterCompletionUnavailable)}
          />
        ) : incompleteItems.length === 0 ? null : (
          <ul className="grid gap-2">
            {incompleteItems.map(item => {
              const navigationLabel = messages.encounterCompletionTarget.replace('{status}', item.statusText)
              return (
                <li className="flex items-center justify-between gap-3 rounded-md border px-3 py-2" key={item.code}>
                  <span className="text-sm">{item.statusText}</span>
                  <Button
                    aria-label={navigationLabel}
                    onClick={() => {
                      setOpen(false)
                      onNavigate(item.target)
                    }}
                    size="icon-sm"
                    title={navigationLabel}
                    type="button"
                    variant="ghost"
                  >
                    <ArrowRightIcon />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
        {action.error === null ? null : (
          <ErrorAlert
            message={getWorkspaceErrorMessage(action.error, messages)}
            title={getWorkspaceErrorTitle(action.error, messages, messages.operationFailed)}
          />
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
          {preview.data?.canComplete === true ? (
            <Button disabled={action.pending} onClick={action.onSubmit} type="button">
              {action.pending
                ? <RefreshCwIcon aria-hidden="true" className="animate-spin" data-icon="inline-start" />
                : <ClipboardCheckIcon aria-hidden="true" data-icon="inline-start" />}
              {action.pending ? messages.completingEncounter : messages.confirmEncounterCompletion}
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

interface MedicationDraftLine {
  catalogItemId: string
  doseText: string
  frequencyCode: string
  key: string
  quantity: string
}

function RevisitEditor({ catalog, detail, locale, messages, onSave, pending }: {
  catalog: ClinicalCatalog
  detail: DoctorCaseDetail
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onSave: (input: {
    diagnosis: { code: string; display: string }
    document: { assessment: string; plan: string }
    medications: Array<{
      catalogItemId: string
      doseText: string
      frequencyCode: string
      quantity: number
    }>
  }) => void
  pending: boolean
}): React.JSX.Element {
  const revisit = detail.drafts?.revisit
  const document = detail.drafts?.document
  const prescription = detail.drafts?.prescription
  const [diagnosisCode, setDiagnosisCode] = useState(revisit?.diagnosis.code ?? '')
  const [diagnosisDisplay, setDiagnosisDisplay] = useState(revisit?.diagnosis.display ?? '')
  const [assessment, setAssessment] = useState(document?.assessment ?? '')
  const [plan, setPlan] = useState(document?.plan ?? '')
  const medicationById = useMemo(
    () => new Map(catalog.medications.map(item => [item.id, item])),
    [catalog.medications],
  )
  const [medications, setMedications] = useState<MedicationDraftLine[]>(() => {
    if (prescription !== undefined && prescription.items.length > 0) {
      return prescription.items.map(item => ({
        catalogItemId: item.medicationId,
        doseText: item.doseText,
        frequencyCode: item.frequencyCode,
        key: item.medicationRequestId,
        quantity: String(item.quantity),
      }))
    }
    return []
  })
  const medicationItems = catalog.medications.map(item => ({
    label: locale === 'zh-CN' ? item.nameZh : item.nameEn,
    value: item.id,
  }))
  const updateMedication = (index: number, update: Partial<MedicationDraftLine>) => {
    setMedications(current => current.map((item, itemIndex) => (
      itemIndex === index ? { ...item, ...update } : item
    )))
  }
  const addMedication = () => {
    setMedications(current => [...current, {
      catalogItemId: '',
      doseText: '',
      frequencyCode: '',
      key: globalThis.crypto.randomUUID(),
      quantity: '1',
    }])
  }
  const hasInvalidMedication = medications.some(item => (
    item.catalogItemId.length === 0
    || item.doseText.length === 0
    || item.frequencyCode.length === 0
    || !Number.isInteger(Number(item.quantity))
    || Number(item.quantity) < 1
  ))

  return (
    <form
      onSubmit={event => {
        event.preventDefault()
        onSave({
          diagnosis: { code: diagnosisCode, display: diagnosisDisplay },
          document: { assessment, plan },
          medications: medications.map(item => ({
            catalogItemId: item.catalogItemId,
            doseText: item.doseText,
            frequencyCode: item.frequencyCode,
            quantity: Number(item.quantity),
          })),
        })
      }}
    >
      <FieldGroup>
        <h3 className="text-sm font-semibold">{messages.revisitRecord}</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field><FieldLabel htmlFor="revisit-diagnosis-code">{messages.diagnosisCode}</FieldLabel><Input id="revisit-diagnosis-code" onChange={event => setDiagnosisCode(event.currentTarget.value)} required value={diagnosisCode} /></Field>
          <Field><FieldLabel htmlFor="revisit-diagnosis-display">{messages.diagnosisDisplay}</FieldLabel><Input id="revisit-diagnosis-display" onChange={event => setDiagnosisDisplay(event.currentTarget.value)} required value={diagnosisDisplay} /></Field>
        </div>
        <Field><FieldLabel htmlFor="revisit-assessment">{messages.revisitAssessment}</FieldLabel><Textarea id="revisit-assessment" onChange={event => setAssessment(event.currentTarget.value)} required value={assessment} /></Field>
        <Field><FieldLabel htmlFor="revisit-plan">{messages.clinicalPlan}</FieldLabel><Textarea id="revisit-plan" onChange={event => setPlan(event.currentTarget.value)} required value={plan} /></Field>
        <div className="flex items-center justify-between gap-2 border-t pt-5">
          <h3 className="text-sm font-semibold">{messages.prescription}</h3>
          <Button disabled={catalog.medications.length === 0} onClick={addMedication} size="sm" type="button" variant="outline">
            <PlusIcon data-icon="inline-start" />{messages.addMedication}
          </Button>
        </div>
        {medications.map((line, index) => {
          const suffix = index === 0 ? '' : ` ${index + 1}`
          const selectedMedication = medicationById.get(line.catalogItemId)
          const doseItems = selectedMedication?.allowedDoseTexts.map(value => ({ label: value, value })) ?? []
          const frequencyItems = selectedMedication?.allowedFrequencyCodes.map(value => ({ label: value, value })) ?? []
          return (
            <div className="grid grid-cols-1 gap-3 border-b pb-4 lg:grid-cols-[minmax(12rem,1.5fr)_minmax(7rem,0.8fr)_minmax(7rem,0.8fr)_6rem_auto]" key={line.key}>
              <Field>
                <FieldLabel htmlFor={`medication-${index}`}>{messages.medication}{suffix}</FieldLabel>
                <WorkspaceSelect
                  id={`medication-${index}`}
                  items={medicationItems}
                  onValueChange={value => {
                    const selected = value === null ? undefined : medicationById.get(value)
                    if (selected === undefined) return
                    updateMedication(index, {
                      catalogItemId: selected.id,
                      doseText: selected.defaultDoseText,
                      frequencyCode: selected.defaultFrequencyCode,
                    })
                  }}
                  placeholder={locale === 'zh-CN' ? '请选择药品' : 'Select medication'}
                  value={line.catalogItemId || null}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`dose-${index}`}>{messages.dose}{suffix}</FieldLabel>
                <WorkspaceSelect id={`dose-${index}`} items={doseItems} onValueChange={value => updateMedication(index, { doseText: value ?? '' })} value={line.doseText} />
              </Field>
              <Field>
                <FieldLabel htmlFor={`frequency-${index}`}>{messages.frequency}{suffix}</FieldLabel>
                <WorkspaceSelect id={`frequency-${index}`} items={frequencyItems} onValueChange={value => updateMedication(index, { frequencyCode: value ?? '' })} value={line.frequencyCode} />
              </Field>
              <Field><FieldLabel htmlFor={`quantity-${index}`}>{messages.quantity}{suffix}</FieldLabel><Input id={`quantity-${index}`} min="1" onChange={event => updateMedication(index, { quantity: event.currentTarget.value })} required type="number" value={line.quantity} /></Field>
              <div className="flex items-end">
                <Button aria-label={`${messages.removeMedication}${suffix}`} onClick={() => setMedications(current => current.filter((_, itemIndex) => itemIndex !== index))} size="icon" title={`${messages.removeMedication}${suffix}`} type="button" variant="ghost"><Trash2Icon /></Button>
              </div>
            </div>
          )
        })}
        <div className="sticky bottom-0 flex justify-end border-t bg-background py-3">
          <Button disabled={pending || medications.length === 0 || hasInvalidMedication} type="submit"><ClipboardPenIcon data-icon="inline-start" />{messages.saveRevisitDraft}</Button>
        </div>
      </FieldGroup>
    </form>
  )
}

function ErrorAlert({ message, title }: { message: string; title: string }): React.JSX.Element {
  return <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{title}</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>
}

function doctorRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Doctor Agent input must be an object')
  }
  return value as Record<string, unknown>
}

function doctorString(value: unknown, key: string, maximum: number): string {
  const candidate = doctorRecord(value)[key]
  if (typeof candidate !== 'string' || candidate.trim() === '' || candidate.length > maximum) {
    throw new TypeError(`${key} is invalid`)
  }
  return candidate.trim()
}

function doctorDiagnosisEntries(value: unknown): DiagnosisDraftEntry[] {
  const entries = doctorRecord(value).entries
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array')
  return entries.map(entry => diagnosisDraftEntrySchema.parse(entry))
}

function doctorClinicalDocument(value: unknown): ClinicalDocumentContent {
  const input = doctorRecord(value)
  const field = (key: keyof ClinicalDocumentContent): string => doctorString(input, key, 4_000)
  return {
    assessment: field('assessment'),
    auxiliaryExamination: field('auxiliaryExamination'),
    chiefComplaint: field('chiefComplaint'),
    disposition: field('disposition'),
    followUp: field('followUp'),
    historyOfPresentIllness: field('historyOfPresentIllness'),
    physicalExamination: field('physicalExamination'),
    priorMedicalHistory: field('priorMedicalHistory'),
  }
}

function requireDoctorDetail(
  detail: DoctorCaseDetail | undefined,
  message: string,
): DoctorCaseDetail {
  if (detail === undefined) throw new Error(message)
  return detail
}

function isQuantitativeLaboratoryResult(
  result: LaboratoryReport['results'][number],
): result is Extract<LaboratoryReport['results'][number], { value: number }> {
  return typeof result.value === 'number' && 'unit' in result
}
