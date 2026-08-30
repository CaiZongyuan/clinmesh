import {
  laboratoryRequestCatalogItemIdSchema,
  type ClinicalCatalog,
  type ClinicalDocumentContent,
  type DiagnosisDraftEntry,
  type DoctorCaseDetail,
  type DoctorQueueItem,
  type EncounterCompletionTarget,
  type LaboratoryReport,
  type LaboratoryRequest,
  type LaboratoryRequestCatalogItemId,
  type PrescriptionDraftItem,
  type SessionContext,
  type VirtualPatientList,
} from '@clinmesh/contracts/his'
import type {
  ReferenceConcept,
  ReferenceMedicationProduct,
} from '@clinmesh/contracts/reference-data'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@clinmesh/ui/components/alert-dialog'
import { Avatar, AvatarFallback } from '@clinmesh/ui/components/avatar'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Bubble, BubbleContent } from '@clinmesh/ui/components/bubble'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Message, MessageContent, MessageFooter, MessageHeader } from '@clinmesh/ui/components/message'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@clinmesh/ui/components/message-scroller'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Spinner } from '@clinmesh/ui/components/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { cn } from '@clinmesh/ui/lib/utils'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRightIcon, CheckCircleIcon, CheckIcon, CircleAlertIcon, CircleXIcon, ClipboardCheckIcon, ClipboardListIcon, ClipboardPenIcon, FileSignatureIcon, FlaskConicalIcon, LibraryBigIcon, LockKeyholeIcon, MessagesSquareIcon, PanelRightCloseIcon, PanelRightOpenIcon, PillIcon, PlayIcon, PlusIcon, RefreshCwIcon, RotateCcwIcon, SendIcon, StethoscopeIcon, TestTubesIcon, Trash2Icon, UserRoundPlusIcon } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ApiClientError,
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
} from './api-client.ts'
import {
  DoctorCompletedCaseLibrary,
  type CompletedCaseCorrectionTarget,
} from './doctor-completed-cases.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { PaginationControls } from './pagination-controls.tsx'
import {
  getWorkspaceErrorMessage,
  getWorkspaceErrorTitle,
} from './workspace-error.ts'
import { formatFen } from './workspace-format.ts'
import { WorkspaceSelect } from './workspace-select.tsx'

interface DoctorWorkspaceProps {
  locale: WorkspaceLocale
  session: SessionContext
}

interface CompletedCaseCorrectionNavigation {
  caseId: string
  handled: boolean
  target: CompletedCaseCorrectionTarget
}

interface ActiveDoctorWorkspaceProps extends DoctorWorkspaceProps {
  correctionNavigation: CompletedCaseCorrectionNavigation | undefined
  onCorrectionNavigationHandled: () => void
  onSelectedCaseIdChange: (caseId: string | undefined) => void
  selectedCaseId: string | undefined
}

interface ConsultationAction {
  error: Error | null
  onAsk: (questionCode: string) => void
  pending: boolean
}

interface LaboratoryRequestActions {
  acknowledge: {
    error: Error | null
    onSubmit: (request: LaboratoryRequest) => void
    pending: boolean
    pendingRequestId?: string
  }
  cancel: {
    error: Error | null
    onSubmit: (request: LaboratoryRequest) => void
    pending: boolean
    successRequestId?: string
  }
  correct: {
    allowed: boolean
    error: Error | null
    lastRequestId?: string
    onSubmit: (request: LaboratoryRequest, input: LaboratoryReportCorrectionInput) => void
    pending: boolean
    pendingRequestId?: string
    successRequestId?: string
  }
  deleteDraft: {
    error: Error | null
    onSubmit: () => void
    pending: boolean
    success?: {
      caseId: string
      draftVersion: number
    }
  }
  issue: {
    error: Error | null
    onSubmit: () => void
    pending: boolean
  }
  retry: {
    error: Error | null
    onSubmit: (request: LaboratoryRequest) => void
    pending: boolean
    pendingRequestId?: string
  }
  save: {
    error: Error | null
    onSubmit: () => void
    pending: boolean
  }
}

interface LaboratoryReportCorrectionInput {
  conclusion: string
  reason: string
  results: Array<{ code: string; value: number }>
}

interface DiagnosisActions {
  confirm: {
    error: Error | null
    onSubmit: (entries: DiagnosisDraftEntry[]) => void
    pending: boolean
  }
}

type EncounterCompletionQueryScope = readonly ['encounter-completion', string, string]

const encounterCompletionTargetElementIds = {
  diagnosis: 'encounter-completion-target-diagnosis',
  'clinical-document': 'encounter-completion-target-clinical-document',
  laboratory: 'encounter-completion-target-laboratory',
  'medication-conclusion': 'encounter-completion-target-medication-conclusion',
} satisfies Record<EncounterCompletionTarget, string>

type CaseDetailSection = 'record' | 'diagnosis' | 'prescription' | 'examination'

const caseDetailSectionByCompletionTarget = {
  diagnosis: 'diagnosis',
  'clinical-document': 'record',
  laboratory: 'examination',
  'medication-conclusion': 'prescription',
} satisfies Record<EncounterCompletionTarget, CaseDetailSection>

function isLaboratoryRequestCatalogItemId(
  value: string,
): value is LaboratoryRequestCatalogItemId {
  return laboratoryRequestCatalogItemIdSchema.safeParse(value).success
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
        <ActiveDoctorWorkspace
          correctionNavigation={correctionNavigation}
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

function ActiveDoctorWorkspace({
  correctionNavigation,
  locale,
  onCorrectionNavigationHandled,
  onSelectedCaseIdChange,
  selectedCaseId,
  session,
}: ActiveDoctorWorkspaceProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const queryClient = useQueryClient()
  const scope = [session.actor.workspaceId, session.actor.epoch] as const
  const [page, setPage] = useState(1)
  const [virtualPatientPage, setVirtualPatientPage] = useState(1)
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
  const catalog = useQuery({
    queryFn: ({ signal }) => getClinicalCatalog(signal),
    queryKey: ['clinical-catalog', ...scope],
  })
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
  const resolvedLaboratoryItemId = requestedLaboratoryItemId ?? laboratoryCatalog[0]?.id ?? ''
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
  const refreshCase = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queueKey }),
      queryClient.invalidateQueries({ queryKey: detailKey }),
      queryClient.invalidateQueries({ queryKey: encounterCompletionScopeKey }),
    ])
  }
  const refreshCompletedCaseDetails = async () => {
    await queryClient.invalidateQueries({ queryKey: completedCaseDetailScopeKey })
  }
  const refreshAfterCorrection = async () => {
    await Promise.all([refreshCase(), refreshCompletedCaseDetails()])
  }
  const refreshAfterCompletion = async () => {
    if (detail.data !== undefined) onSelectedCaseIdChange(detail.data.caseId)
    await Promise.all([
      refreshCase(),
      refreshCompletedCaseDetails(),
      queryClient.invalidateQueries({ queryKey: completedCaseListScopeKey }),
    ])
  }
  const askQuestion = useMutation({
    mutationFn: (questionCode: string) => {
      const current = detail.data
      if (current?.consultation === undefined) {
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: detailKey }),
  })
  const signingDependencies = () => {
    const current = detail.data
    const revisit = current?.drafts?.revisit
    const prescription = current?.drafts?.prescription
    const document = current?.drafts?.document
    if (current === undefined || revisit === undefined || prescription === undefined || document === undefined) {
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
    mutationFn: () => {
      if (detail.data === undefined) throw new Error(messages.consultationUnavailable)
      return startFirstVisit({
        encounterId: detail.data.encounter.id,
        encounterVersion: detail.data.encounter.versionId,
        taskId: detail.data.taskId,
        taskVersion: detail.data.taskVersion,
      }, newIdempotencyKey())
    },
    onSuccess: refreshCase,
  })
  const beginRevisit = useMutation({
    mutationFn: () => {
      if (detail.data === undefined) throw new Error(messages.consultationUnavailable)
      return startRevisit({
        encounterId: detail.data.encounter.id,
        encounterVersion: detail.data.encounter.versionId,
        taskId: detail.data.taskId,
        taskVersion: detail.data.taskVersion,
      }, newIdempotencyKey())
    },
    onSuccess: refreshCase,
  })
  const saveDraft = useMutation({
    mutationFn: (input: { assessment: string; historyOfPresentIllness: string }) => {
      if (detail.data === undefined) throw new Error(messages.consultationUnavailable)
      return saveFirstVisitDraft({
        ...input,
        encounterId: detail.data.encounter.id,
        encounterVersion: detail.data.encounter.versionId,
        expectedDraftVersion: detail.data.drafts?.firstVisit?.version ?? 0,
      }, newIdempotencyKey())
    },
    onSuccess: refreshCase,
  })
  const issueOrder = useMutation({
    mutationFn: () => {
      if (detail.data === undefined || catalog.data === undefined) {
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
    onSuccess: refreshCase,
  })
  const saveLaboratoryRequest = useMutation({
    mutationFn: () => {
      const current = detail.data
      if (current === undefined
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
    onSuccess: refreshCase,
  })
  const issueRequest = useMutation({
    mutationFn: () => {
      const current = detail.data
      const requestState = current?.laboratoryRequests
      if (current === undefined || requestState?.draft === undefined) {
        throw new Error(messages.consultationUnavailable)
      }
      return issueLaboratoryRequest({
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        expectedDraftVersion: requestState.draftVersion,
      }, newIdempotencyKey())
    },
    onSuccess: refreshCase,
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
    onError: refreshCase,
    onSuccess: refreshCase,
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
    onError: refreshCase,
    onSuccess: refreshCase,
  })
  const retryResultGeneration = useMutation({
    mutationFn: (request: LaboratoryRequest) => retryLaboratoryResultGeneration({
      requestId: request.id,
      requestVersion: request.version,
      taskId: request.taskId,
      taskVersion: request.taskVersion,
    }, newIdempotencyKey()),
    onError: refreshCase,
    onSuccess: refreshCase,
  })
  const acknowledgeReport = useMutation({
    mutationFn: (request: LaboratoryRequest) => {
      if (request.report === undefined) throw new Error(messages.consultationUnavailable)
      return acknowledgeLaboratoryReport({
        diagnosticReportId: request.report.diagnosticReportId,
        diagnosticReportVersion: request.report.diagnosticReportVersion,
        requestId: request.id,
        requestVersion: request.version,
      }, newIdempotencyKey())
    },
    onSuccess: refreshCase,
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
    onError: refreshAfterCorrection,
    onSuccess: refreshAfterCorrection,
  })
  const confirmCaseDiagnosis = useMutation({
    mutationFn: async (entries: DiagnosisDraftEntry[]) => {
      const current = detail.data
      if (current === undefined) throw new Error(messages.consultationUnavailable)
      const saved = await saveDiagnosisDraft({
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        entries,
        expectedDraftVersion: current.diagnosis?.draftVersion ?? 0,
      }, newIdempotencyKey())
      return confirmDiagnosis({
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        expectedDraftVersion: saved.data.draftVersion,
      }, newIdempotencyKey())
    },
    onSuccess: refreshCase,
  })
  const saveRevisit = useMutation({
    mutationFn: (input: {
      diagnosis: { code: string; display: string }
      document: { assessment: string; plan: string }
      medications: Array<{
        catalogItemId: string
        doseText: string
        frequencyCode: string
        quantity: number
      }>
    }) => {
      if (detail.data === undefined) throw new Error(messages.consultationUnavailable)
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
        ...input,
        draftVersions: {
          documentDraft: detail.data.drafts?.document?.version ?? 0,
          prescription: prescription?.version ?? 0,
          revisitDraft: revisit?.version ?? 0,
        },
        encounterId: detail.data.encounter.id,
        expectedVersions,
      }, newIdempotencyKey())
    },
    onSuccess: refreshCase,
  })
  const previewSign = useMutation({
    mutationFn: () => previewClinicalSign(signingDependencies(), newIdempotencyKey()),
  })
  const completeSign = useMutation({
    mutationFn: () => {
      if (previewSign.data === undefined) throw new Error(messages.consultationUnavailable)
      const dependencies = signingDependencies()
      return signClinicalDocument({
        commitToken: previewSign.data.data.commitToken,
        encounterId: dependencies.encounterId,
        expectedVersions: dependencies.expectedVersions,
        previewId: previewSign.data.data.previewId,
      }, newIdempotencyKey())
    },
    onSuccess: refreshCase,
  })
  return (
    <div className="grid min-h-[720px] min-w-0 grid-cols-1 border bg-background xl:grid-cols-[280px_minmax(0,1fr)]">
      <aside
        aria-label={messages.consultationQueue}
        className="flex min-w-0 flex-col gap-5 border-b p-3 xl:border-r xl:border-b-0"
      >
        <section aria-labelledby="virtual-patient-heading" className="flex min-w-0 flex-col gap-3 border-b pb-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold" id="virtual-patient-heading">{messages.virtualPatientCandidates}</h2>
            <Badge variant="secondary">{virtualPatients.data?.total ?? 0}</Badge>
          </div>
          {virtualPatients.isPending ? <Skeleton className="h-32 w-full" /> : virtualPatients.isError ? (
            <ErrorAlert message={getWorkspaceErrorMessage(virtualPatients.error, messages)} title={getWorkspaceErrorTitle(virtualPatients.error, messages, messages.virtualPatientsUnavailable)} />
          ) : virtualPatients.data.items.length === 0 ? (
            <Empty className="min-h-32 border">
              <EmptyHeader>
                <EmptyMedia variant="icon"><UserRoundPlusIcon aria-hidden="true" /></EmptyMedia>
                <EmptyTitle>{messages.noVirtualPatients}</EmptyTitle>
                <EmptyDescription>{messages.noVirtualPatientsDescription}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex max-h-64 flex-col gap-2 overflow-y-auto pr-1">
              {virtualPatients.data.items.map(item => (
                <VirtualPatientRow
                  item={item}
                  key={item.id}
                  messages={messages}
                  onSelect={() => {
                    startCandidate.reset()
                    setSelectedVirtualPatientId(item.id)
                  }}
                  selected={item.id === selectedVirtualPatient?.id}
                />
              ))}
              {selectedVirtualPatient === undefined ? null : (
                <div className="flex flex-col gap-3 border-l-2 border-primary/40 pl-3 pt-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">{messages[`gender_${selectedVirtualPatient.gender}` as 'gender_male']}</Badge>
                    <span>{messages.birthDate} {selectedVirtualPatient.birthDate}</span>
                  </div>
                  <div className="flex flex-col gap-1 text-sm">
                    <div className="text-xs text-muted-foreground">{messages.presentationSummary}</div>
                    <p>{selectedVirtualPatient.presentation.summary}</p>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                    <VitalSummary label="T" value={selectedVirtualPatient.presentation.vitalSigns.temperatureC} />
                    <VitalSummary label="P" value={selectedVirtualPatient.presentation.vitalSigns.pulseBpm} />
                    <VitalSummary label="R" value={selectedVirtualPatient.presentation.vitalSigns.respirationBpm} />
                    <VitalSummary label="BP" value={`${selectedVirtualPatient.presentation.vitalSigns.bloodPressure.systolicMmHg}/${selectedVirtualPatient.presentation.vitalSigns.bloodPressure.diastolicMmHg}`} />
                    <VitalSummary label="SpO2" value={selectedVirtualPatient.presentation.vitalSigns.oxygenSaturationPct} />
                  </dl>
                  {startCandidate.isError ? (
                    <ErrorAlert message={getWorkspaceErrorMessage(startCandidate.error, messages)} title={getWorkspaceErrorTitle(startCandidate.error, messages, messages.operationFailed)} />
                  ) : null}
                  <Button
                    disabled={startCandidate.isPending}
                    onClick={() => startCandidate.mutate(selectedVirtualPatient)}
                    type="button"
                  >
                    {startCandidate.isPending
                      ? <Spinner aria-hidden="true" />
                      : <PlayIcon aria-hidden="true" />}
                    {startCandidate.isPending ? messages.startingConsultation : messages.startConsultation}
                  </Button>
                </div>
              )}
            </div>
          )}
          {virtualPatients.data === undefined ? null : (
            <PaginationControls
              messages={messages}
              onPageChange={(nextPage) => {
                setVirtualPatientPage(nextPage)
                setSelectedVirtualPatientId(undefined)
              }}
              page={virtualPatients.data.page}
              pageSize={virtualPatients.data.pageSize}
              total={virtualPatients.data.total}
            />
          )}
        </section>

        <section aria-labelledby="consultation-queue-heading" className="flex min-w-0 flex-col gap-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold" id="consultation-queue-heading">{messages.consultationQueue}</h2>
            <Badge variant="secondary">{queue.data?.total ?? 0}</Badge>
          </div>
          {queue.isPending ? <Skeleton className="h-44 w-full" /> : queue.isError ? (
            <ErrorAlert message={getWorkspaceErrorMessage(queue.error, messages)} title={getWorkspaceErrorTitle(queue.error, messages, messages.consultationUnavailable)} />
          ) : queue.data.items.length === 0 ? (
            <Empty className="min-h-44 border">
              <EmptyHeader>
                <EmptyMedia variant="icon"><StethoscopeIcon aria-hidden="true" /></EmptyMedia>
                <EmptyTitle>{messages.noConsultationCases}</EmptyTitle>
                <EmptyDescription>{messages.noConsultationCasesDescription}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col gap-2" role="list">
              {queue.data.items.map(item => (
                <DoctorCaseRow
                  item={item}
                  key={item.caseId}
                  messages={messages}
                  onSelect={() => onSelectedCaseIdChange(item.caseId)}
                  selected={item.caseId === activeCaseId}
                />
              ))}
              <PaginationControls
                messages={messages}
                onPageChange={(nextPage) => {
                  setPage(nextPage)
                  onSelectedCaseIdChange(undefined)
                }}
                page={queue.data.page}
                pageSize={queue.data.pageSize}
                total={queue.data.total}
              />
            </div>
          )}
        </section>
      </aside>

      <section aria-labelledby="case-detail-heading" className="flex min-w-0 flex-col gap-3 p-3">
        <h2 className="sr-only" id="case-detail-heading">{messages.caseDetail}</h2>
        {issueOrder.isSuccess ? (
          <Alert>
            <CheckIcon aria-hidden="true" />
            <AlertTitle>{messages.laboratoryOrderIssued}</AlertTitle>
            <AlertDescription>
              {messages.awaitingLaboratoryPayment} · {formatFen(issueOrder.data.data.totalFen, locale)}
            </AlertDescription>
          </Alert>
        ) : null}
        {completeSign.isSuccess ? (
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
            completionQueryScope={encounterCompletionScopeKey}
            correctionTarget={correctionNavigation?.caseId === detail.data.caseId
              ? correctionNavigation.target
              : undefined}
            consultationAction={{
              error: askQuestion.error,
              onAsk: questionCode => askQuestion.mutate(questionCode),
              pending: askQuestion.isPending,
            }}
            catalog={catalog}
            detail={detail.data}
            diagnosisActions={{
              confirm: {
                error: confirmCaseDiagnosis.error,
                onSubmit: entries => confirmCaseDiagnosis.mutate(entries),
                pending: confirmCaseDiagnosis.isPending,
              },
            }}
            indicationCode={resolvedIndicationCode}
            laboratoryCatalog={laboratoryCatalog}
            laboratoryItemId={resolvedLaboratoryItemId}
            laboratoryRequestActions={{
              acknowledge: {
                error: acknowledgeReport.error,
                onSubmit: request => acknowledgeReport.mutate(request),
                pending: acknowledgeReport.isPending,
                ...(acknowledgeReport.isPending && acknowledgeReport.variables !== undefined
                  ? { pendingRequestId: acknowledgeReport.variables.id }
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
                pending: cancelRequest.isPending,
                ...(cancelRequest.isSuccess && cancelRequest.variables !== undefined
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
                pending: correctReport.isPending,
                ...(correctReport.isPending && correctReport.variables !== undefined
                  ? { pendingRequestId: correctReport.variables.request.id }
                  : {}),
                ...(correctReport.isSuccess && correctReport.variables !== undefined
                  ? { successRequestId: correctReport.variables.request.id }
                  : {}),
              },
              deleteDraft: {
                error: deleteRequestDraft.variables === detail.data.caseId
                  ? deleteRequestDraft.error
                  : null,
                onSubmit: () => deleteRequestDraft.mutate(detail.data.caseId),
                pending: deleteRequestDraft.isPending,
                ...(deleteRequestDraft.data === undefined
                  ? {}
                  : { success: deleteRequestDraft.data.data }),
              },
              issue: {
                error: issueRequest.error,
                onSubmit: () => issueRequest.mutate(),
                pending: issueRequest.isPending,
              },
              retry: {
                error: retryResultGeneration.error,
                onSubmit: request => retryResultGeneration.mutate(request),
                pending: retryResultGeneration.isPending,
                ...(retryResultGeneration.isPending && retryResultGeneration.variables !== undefined
                  ? { pendingRequestId: retryResultGeneration.variables.id }
                  : {}),
              },
              save: {
                error: saveLaboratoryRequest.error,
                onSubmit: () => saveLaboratoryRequest.mutate(),
                pending: saveLaboratoryRequest.isPending,
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
            onIndicationChange={setIndicationCode}
            onCorrectionCompleted={refreshAfterCorrection}
            onCorrectionNavigationHandled={onCorrectionNavigationHandled}
            onEncounterCompleted={refreshAfterCompletion}
            onLaboratoryItemChange={(value) => {
              setLaboratoryItemId(value)
              setIndicationCode('')
            }}
            onIssueOrder={() => issueOrder.mutate()}
            onRefreshCase={refreshCase}
            onPreviewSign={() => previewSign.mutate()}
            onSaveDraft={input => saveDraft.mutate(input)}
            onSaveRevisit={input => saveRevisit.mutate(input)}
            onSign={() => completeSign.mutate()}
            onStart={() => start.mutate()}
            onStartRevisit={() => beginRevisit.mutate()}
            issueOrderError={issueOrder.error}
            issueOrderPending={issueOrder.isPending}
            saveDraftError={saveDraft.error}
            saveDraftPending={saveDraft.isPending}
            saveDraftSuccess={saveDraft.isSuccess}
            saveRevisitError={saveRevisit.error}
            saveRevisitPending={saveRevisit.isPending}
            saveRevisitSuccess={saveRevisit.isSuccess}
            signCompleted={completeSign.isSuccess}
            signError={completeSign.error}
            signPending={completeSign.isPending}
            signPreview={previewSign.data?.data}
            signPreviewError={previewSign.error}
            signPreviewPending={previewSign.isPending}
            startError={start.error}
            startPending={start.isPending}
            startRevisitError={beginRevisit.error}
            startRevisitPending={beginRevisit.isPending}
            workingClinicalDocument={workingClinicalDocuments[detail.data.caseId]
              ?? createWorkingClinicalDocument(detail.data)}
          />
        )}
      </section>
    </div>
  )
}

function CaseDetail({
  catalog,
  completionQueryScope,
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
  onEncounterCompleted,
  onIssueOrder,
  onIndicationChange,
  onCorrectionCompleted,
  onCorrectionNavigationHandled,
  onRefreshCase,
  onPreviewSign,
  onLaboratoryItemChange,
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
  catalog: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getClinicalCatalog>>>>
  completionQueryScope: EncounterCompletionQueryScope
  consultationAction: ConsultationAction
  correctionTarget: CompletedCaseCorrectionTarget | undefined
  detail: DoctorCaseDetail
  diagnosisActions: DiagnosisActions
  indicationCode: string
  issueOrderError: Error | null
  issueOrderPending: boolean
  laboratoryCatalog: ClinicalCatalog['laboratory']
  laboratoryItemId: string
  laboratoryRequestActions: LaboratoryRequestActions
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onClinicalDocumentChange: (document: ClinicalDocumentContent) => void
  onEncounterCompleted: () => Promise<void>
  onIssueOrder: () => void
  onIndicationChange: (value: string) => void
  onCorrectionCompleted: () => Promise<void>
  onCorrectionNavigationHandled: () => void
  onRefreshCase: () => Promise<void>
  onPreviewSign: () => void
  onLaboratoryItemChange: (value: string) => void
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
  const presentation = detail.presentation
  const readOnly = detail.encounter.status !== 'in-progress'
  const hasConsultationDialogue = detail.consultation !== undefined
    && (detail.consultation.questions.length > 0 || detail.consultation.records.length > 0)
  const [activeSection, setActiveSection] = useState<CaseDetailSection>('record')
  const [consultationSidebarOpen, setConsultationSidebarOpen] = useState(true)
  const [pendingNavigation, setPendingNavigation] = useState<{
    source: 'checklist' | 'correction'
    target: EncounterCompletionTarget
  }>()
  const laboratoryItems = laboratoryCatalog.map(item => ({
    label: `${locale === 'zh-CN' ? item.nameZh : item.nameEn} · ${formatFen(item.priceFen ?? 0, locale)}`,
    value: item.id,
  }))
  const indicationItems = laboratoryCatalog
    .find(item => item.id === laboratoryItemId)
    ?.allowedIndicationCodes.map(code => ({
      label: indicationLabel(code, messages),
      value: code,
    })) ?? []

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
        key={`${detail.caseId}:${firstVisitDraft?.version ?? 0}`}
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

  const legacyLaboratoryOrder = readOnly
    || detail.consultation !== undefined
    || detail.status !== 'first-visit'
    ? null
    : (
      <section aria-labelledby="laboratory-order-heading" className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold" id="laboratory-order-heading">
          {messages.laboratoryOrder}
        </h3>
        {catalog.isPending ? <Skeleton className="h-20 w-full" /> : catalog.isError ? (
          <ErrorAlert
            message={getWorkspaceErrorMessage(catalog.error, messages)}
            title={getWorkspaceErrorTitle(catalog.error, messages, messages.consultationUnavailable)}
          />
        ) : (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="laboratory-item">{messages.laboratoryItem}</FieldLabel>
              <WorkspaceSelect
                id="laboratory-item"
                items={laboratoryItems}
                onValueChange={value => onLaboratoryItemChange(value ?? '')}
                value={laboratoryItemId}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="laboratory-indication">{messages.laboratoryIndication}</FieldLabel>
              <WorkspaceSelect
                id="laboratory-indication"
                items={indicationItems}
                onValueChange={value => onIndicationChange(value ?? '')}
                value={indicationCode}
              />
            </Field>
            <div className="flex justify-end">
              <Button
                disabled={firstVisitDraft === undefined || issueOrderPending}
                onClick={onIssueOrder}
                type="button"
              >
                <FlaskConicalIcon data-icon="inline-start" />
                {messages.issueLaboratoryOrder}
              </Button>
            </div>
            {issueOrderError === null ? null : (
              <ErrorAlert
                message={getWorkspaceErrorMessage(issueOrderError, messages)}
                title={getWorkspaceErrorTitle(issueOrderError, messages, messages.operationFailed)}
              />
            )}
          </FieldGroup>
        )}
      </section>
    )

  const awaitingReport = readOnly || detail.status !== 'awaiting-report' ? null : (
    <Alert>
      <RefreshCwIcon aria-hidden="true" />
      <AlertTitle>{messages.awaitingLisReport}</AlertTitle>
      <AlertDescription>{messages.awaitingLisReportDescription}</AlertDescription>
    </Alert>
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
          key={`${detail.caseId}:${detail.drafts?.prescription?.version ?? 0}`}
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
    <div className={consultationSidebarOpen
      ? 'grid min-w-0 overflow-hidden border bg-background xl:grid-cols-[minmax(0,1fr)_300px]'
      : 'grid min-w-0 overflow-hidden border bg-background xl:grid-cols-[minmax(0,1fr)_2.75rem]'}>
      <div className="flex min-w-0 flex-col">
        <section className="overflow-hidden border-b bg-background" aria-label={messages.caseDetail}>
          <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <PatientAvatar label={`${detail.patient.name} ${messages.patient}`} name={detail.patient.name} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-lg font-semibold">{detail.patient.name}</h2>
                  <Badge variant="outline">{messages[`gender_${detail.patient.gender}` as 'gender_male']}</Badge>
                  <span className="text-sm text-muted-foreground">{detail.patient.birthDate}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{messages.registrationNumber}：{detail.patient.identifier}</span>
                  <span>{messages.chiefComplaint}：{presentation.chiefComplaint}</span>
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant="secondary">{statusLabel(detail.status, messages)}</Badge>
              {readOnly ? (
                <Badge variant="outline"><LockKeyholeIcon aria-hidden="true" />{messages.encounterReadOnly}</Badge>
              ) : detail.consultation === undefined ? null : (
                <EncounterCompletionPanel
                  detail={detail}
                  messages={messages}
                  onCompleted={onEncounterCompleted}
                  onNavigate={navigateToCompletionTarget}
                  onRefresh={onRefreshCase}
                  queryScope={completionQueryScope}
                />
              )}
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-px border-t bg-border sm:grid-cols-3 lg:grid-cols-5 [&>div]:bg-background [&>div]:px-3 [&>div]:py-2.5">
            <VitalSummary label="T" value={`${presentation.vitalSigns.temperatureC} °C`} />
            <VitalSummary label="P" value={`${presentation.vitalSigns.pulseBpm} 次/分`} />
            <VitalSummary label="R" value={`${presentation.vitalSigns.respirationBpm} 次/分`} />
            <VitalSummary label="BP" value={`${presentation.vitalSigns.bloodPressure.systolicMmHg}/${presentation.vitalSigns.bloodPressure.diastolicMmHg} mmHg`} />
            <VitalSummary label="SpO₂" value={`${presentation.vitalSigns.oxygenSaturationPct}%`} />
          </dl>
        </section>

        <Tabs
          className="min-w-0 gap-0 bg-background"
          onValueChange={value => {
            if (value === 'record' || value === 'diagnosis' || value === 'prescription' || value === 'examination') {
              setActiveSection(value)
            }
          }}
          value={activeSection}
        >
          <div className="overflow-x-auto border-b px-2">
            <TabsList className="h-11 min-w-max" variant="line">
              <TabsTrigger value="record"><ClipboardListIcon aria-hidden="true" />{messages.medicalRecord}</TabsTrigger>
              <TabsTrigger value="diagnosis"><StethoscopeIcon aria-hidden="true" />{messages.diagnosis}</TabsTrigger>
              <TabsTrigger value="prescription"><PillIcon aria-hidden="true" />{messages.prescription}</TabsTrigger>
              <TabsTrigger value="examination"><TestTubesIcon aria-hidden="true" />{messages.laboratoryAndExamination}</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent className="p-4" value="record">
            <div className="flex flex-col gap-4">
              {overviewWorkflow}
              <div className="min-w-0">
                {detail.consultation === undefined ? firstVisitRecord : (
                  <StructuredClinicalDocumentPanel
                    allowRevision={!readOnly || correctionTarget === 'clinical-document'}
                    detail={detail}
                    key={`structured-clinical-document:${detail.caseId}`}
                    locale={locale}
                    messages={messages}
                    onDocumentChange={onClinicalDocumentChange}
                    onRevisionCompleted={onCorrectionCompleted}
                    onRefresh={onRefreshCase}
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
              <DiagnosisEditor
                actions={diagnosisActions}
                catalog={catalog.data.diagnoses}
                key={`${detail.caseId}:${detail.diagnosis?.draftVersion ?? 0}`}
                locale={locale}
                messages={messages}
                readOnly={readOnly}
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
              <MedicationConclusionPanel
                allowWithdrawal={!readOnly || correctionTarget === 'medication-conclusion'}
                catalog={catalog.data.medications}
                detail={detail}
                key={`medication-conclusion:${detail.caseId}`}
                locale={locale}
                messages={messages}
                onRefresh={correctionTarget === 'medication-conclusion'
                  ? onCorrectionCompleted
                  : onRefreshCase}
                readOnly={readOnly}
              />
            ) : null}
          </TabsContent>

          <TabsContent className="p-4" value="examination">
            <div className="flex flex-col gap-5">
              {detail.report === undefined ? null : (
                <LaboratoryReport locale={locale} messages={messages} report={detail.report} />
              )}
              {awaitingReport}
              {legacyLaboratoryOrder}
              {detail.consultation === undefined ? null : (
                <section
                  aria-labelledby="independent-laboratory-order-heading"
                  className="flex flex-col gap-3"
                  id={encounterCompletionTargetElementIds.laboratory}
                  tabIndex={-1}
                >
                  <h3 className="text-sm font-semibold" id="independent-laboratory-order-heading">{messages.laboratoryOrder}</h3>
                  {catalog.isPending ? <Skeleton className="h-20 w-full" /> : catalog.isError ? (
                    <ErrorAlert
                      message={getWorkspaceErrorMessage(catalog.error, messages)}
                      title={getWorkspaceErrorTitle(catalog.error, messages, messages.consultationUnavailable)}
                    />
                  ) : (
                    <LaboratoryRequestEditor
                      actions={laboratoryRequestActions}
                      caseId={detail.caseId}
                      catalog={laboratoryCatalog}
                      indicationCode={indicationCode}
                      indicationItems={indicationItems}
                      laboratoryItemId={laboratoryItemId}
                      laboratoryItems={laboratoryItems}
                      locale={locale}
                      messages={messages}
                      onIndicationChange={onIndicationChange}
                      onLaboratoryItemChange={onLaboratoryItemChange}
                      readOnly={readOnly}
                      showCorrection={correctionTarget === 'laboratory'}
                      state={detail.laboratoryRequests}
                    />
                  )}
                </section>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <aside
        aria-label={hasConsultationDialogue ? messages.consultationDialogue : messages.presentationSummary}
        className="flex min-w-0 flex-col border-t bg-muted/15 xl:border-t-0 xl:border-l"
      >
        <div className="flex items-center gap-2 p-2">
          <Button
            aria-expanded={consultationSidebarOpen}
            aria-label={consultationSidebarOpen ? messages.closeRightSidebar : messages.openRightSidebar}
            onClick={() => setConsultationSidebarOpen(open => !open)}
            size="icon-sm"
            title={consultationSidebarOpen ? messages.closeRightSidebar : messages.openRightSidebar}
            type="button"
            variant="ghost"
          >
            {consultationSidebarOpen
              ? <PanelRightCloseIcon aria-hidden="true" />
              : <PanelRightOpenIcon aria-hidden="true" />}
          </Button>
          {consultationSidebarOpen ? (
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">{messages.rightSidebar}</div>
              <h2 className="truncate text-sm font-semibold">
                {hasConsultationDialogue ? messages.consultationDialogue : messages.presentationSummary}
              </h2>
            </div>
          ) : null}
        </div>
        {!consultationSidebarOpen ? null : (
          <div className="flex min-h-0 flex-col gap-4 border-t p-4 pt-3">
            <section aria-labelledby={`allergy-warning-heading-${detail.caseId}`} className="border-b pb-4">
              <h3 className="text-sm font-semibold" id={`allergy-warning-heading-${detail.caseId}`}>
                {messages.allergyWarnings}
              </h3>
              {detail.allergies.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">{messages.noAllergyWarnings}</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {detail.allergies.map(allergy => (
                    <Badge key={`${allergy.code}:${allergy.display}`} variant="destructive">
                      {allergy.display}
                    </Badge>
                  ))}
                </div>
              )}
            </section>
            <section aria-labelledby={`presentation-summary-heading-${detail.caseId}`} className="border-b pb-4">
              <h3 className="text-sm font-semibold" id={`presentation-summary-heading-${detail.caseId}`}>
                {messages.presentationSummary}
              </h3>
              <dl className="mt-2 flex flex-col gap-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">{messages.chiefComplaint}</dt>
                  <dd>{presentation.chiefComplaint}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{messages.status}</dt>
                  <dd>{statusLabel(detail.status, messages)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{messages.priorDiseases}</dt>
                  <dd>{detail.priorFacts.map(fact => fact.display).join('、') || '-'}</dd>
                </div>
              </dl>
            </section>
            {detail.consultation !== undefined && hasConsultationDialogue ? (
              <ConsultationPanel
                action={consultationAction}
                consultation={detail.consultation}
                key={detail.caseId}
                locale={locale}
                messages={messages}
                patientName={detail.patient.name}
                readOnly={readOnly}
              />
            ) : null}
          </div>
        )}
      </aside>
    </div>
  )
}

function EncounterCompletionPanel({ detail, messages, onCompleted, onNavigate, onRefresh, queryScope }: {
  detail: DoctorCaseDetail
  messages: ReturnType<typeof getWorkspaceMessages>
  onCompleted: () => Promise<void>
  onNavigate: (target: EncounterCompletionTarget) => void
  onRefresh: () => Promise<void>
  queryScope: EncounterCompletionQueryScope
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const preview = useQuery({
    queryFn: ({ signal }) => getEncounterCompletion(detail.encounter.id, signal),
    queryKey: [...queryScope, detail.encounter.id, detail.encounter.versionId],
  })
  const complete = useMutation({
    mutationFn: () => {
      if (preview.data === undefined) throw new Error(messages.encounterCompletionUnavailable)
      return completeEncounter({
        encounterId: preview.data.encounterId,
        encounterVersion: preview.data.encounterVersion,
      }, newIdempotencyKey())
    },
    onError: onRefresh,
    onSuccess: async () => {
      setOpen(false)
      await onCompleted()
    },
  })
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
        {complete.error === null ? null : (
          <ErrorAlert
            message={getWorkspaceErrorMessage(complete.error, messages)}
            title={getWorkspaceErrorTitle(complete.error, messages, messages.operationFailed)}
          />
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
          {preview.data?.canComplete === true ? (
            <Button disabled={complete.isPending} onClick={() => complete.mutate()} type="button">
              {complete.isPending
                ? <RefreshCwIcon aria-hidden="true" className="animate-spin" data-icon="inline-start" />
                : <ClipboardCheckIcon aria-hidden="true" data-icon="inline-start" />}
              {complete.isPending ? messages.completingEncounter : messages.confirmEncounterCompletion}
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function LaboratoryRequestEditor({
  actions,
  caseId,
  catalog,
  indicationCode,
  indicationItems,
  laboratoryItemId,
  laboratoryItems,
  locale,
  messages,
  onIndicationChange,
  onLaboratoryItemChange,
  readOnly,
  showCorrection,
  state,
}: {
  actions: LaboratoryRequestActions
  caseId: string
  catalog: ClinicalCatalog['laboratory']
  indicationCode: string
  indicationItems: Array<{ label: string; value: string }>
  laboratoryItemId: string
  laboratoryItems: Array<{ label: string; value: string }>
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onIndicationChange: (value: string) => void
  onLaboratoryItemChange: (value: string) => void
  readOnly: boolean
  showCorrection: boolean
  state: DoctorCaseDetail['laboratoryRequests']
}): React.JSX.Element {
  const catalogById = new Map(catalog.map(item => [item.id, item]))
  const [query, setQuery] = useState('')
  const [referencePage, setReferencePage] = useState(1)
  const normalizedQuery = query.trim()
  const referenceLaboratory = useQuery({
    enabled: normalizedQuery.length >= 3,
    queryFn: ({ signal }) => searchReferenceLaboratory(normalizedQuery, referencePage, signal),
    queryKey: ['reference-laboratory', normalizedQuery, referencePage],
  })
  const draftItem = state?.draft === undefined
    ? undefined
    : catalogById.get(state.draft.catalogItemId)
  const draftMatchesSelection = state?.draft?.catalogItemId === laboratoryItemId
    && state.draft.indicationCode === indicationCode
  return (
    <div className="flex flex-col gap-4">
      {readOnly ? null : <FieldGroup>
        <Field>
          <FieldLabel htmlFor="laboratory-item">{messages.laboratoryItem}</FieldLabel>
          <Input
            aria-label={locale === 'zh-CN' ? '搜索检验目录' : 'Search laboratory catalog'}
            onChange={(event) => {
              setReferencePage(1)
              setQuery(event.currentTarget.value)
            }}
            placeholder={locale === 'zh-CN' ? '检验名称或 LOINC' : 'Name or LOINC'}
            value={query}
          />
          {normalizedQuery.length < 3 ? (
            <WorkspaceSelect id="laboratory-item" items={laboratoryItems} onValueChange={value => onLaboratoryItemChange(value ?? '')} value={laboratoryItemId} />
          ) : referenceLaboratory.isPending ? (
            <Skeleton className="h-20 w-full" />
          ) : referenceLaboratory.isError ? (
            <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{locale === 'zh-CN' ? '目录加载失败' : 'Catalog unavailable'}</AlertTitle></Alert>
          ) : referenceLaboratory.data.items.length === 0 ? (
            <p className="border px-3 py-4 text-sm text-muted-foreground">{locale === 'zh-CN' ? '未找到检验' : 'No laboratory concepts found'}</p>
          ) : (
            <div className="border">
              {referenceLaboratory.data.items.map(item => (
                <button
                  className={cn(
                    'flex w-full items-center justify-between gap-3 border-b px-3 py-2 text-left text-sm',
                    laboratoryItemId === item.id && 'bg-muted/60',
                  )}
                  disabled={item.status !== 'active'}
                  key={item.id}
                  onClick={() => onLaboratoryItemChange(item.id)}
                  type="button"
                >
                  <span>{item.display}</span><span className="font-mono text-xs text-muted-foreground">{item.code}</span>
                </button>
              ))}
              <div className="flex justify-between p-1">
                <Button disabled={referencePage === 1} onClick={() => setReferencePage(current => current - 1)} size="sm" type="button" variant="ghost">{locale === 'zh-CN' ? '上一页' : 'Previous'}</Button>
                <Button disabled={referencePage * referenceLaboratory.data.pageSize >= referenceLaboratory.data.total} onClick={() => setReferencePage(current => current + 1)} size="sm" type="button" variant="ghost">{locale === 'zh-CN' ? '下一页' : 'Next'}</Button>
              </div>
            </div>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor="laboratory-indication">{messages.laboratoryIndication}</FieldLabel>
          <WorkspaceSelect id="laboratory-indication" items={indicationItems} onValueChange={value => onIndicationChange(value ?? '')} value={indicationCode} />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            disabled={actions.save.pending || laboratoryItemId.length === 0 || indicationCode.length === 0}
            onClick={actions.save.onSubmit}
            type="button"
            variant="outline"
          >
            <ClipboardPenIcon data-icon="inline-start" />{messages.saveLaboratoryRequestDraft}
          </Button>
          {state?.draft === undefined ? null : (
            <>
              <AlertDialog>
                <AlertDialogTrigger render={<Button disabled={actions.deleteDraft.pending} type="button" variant="destructive" />}>
                  <Trash2Icon data-icon="inline-start" />{messages.deleteLaboratoryRequestDraft}
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{messages.deleteLaboratoryRequestDraftTitle}</AlertDialogTitle>
                    <AlertDialogDescription>{messages.deleteLaboratoryRequestDraftDescription}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <dl className="text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">{messages.laboratoryItem}</dt>
                      <dd className="mt-1 font-medium">
                        {(locale === 'zh-CN' ? draftItem?.nameZh : draftItem?.nameEn)
                          ?? state.draft.referenceConcept?.display
                          ?? state.draft.catalogItemId}
                      </dd>
                    </div>
                  </dl>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
                    <AlertDialogAction
                      disabled={actions.deleteDraft.pending}
                      onClick={actions.deleteDraft.onSubmit}
                      variant="destructive"
                    >
                      <Trash2Icon data-icon="inline-start" />{messages.confirmDelete}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Button
                disabled={actions.issue.pending || !draftMatchesSelection}
                onClick={actions.issue.onSubmit}
                type="button"
              >
                <FlaskConicalIcon data-icon="inline-start" />{messages.issueLaboratoryRequest}
              </Button>
            </>
          )}
        </div>
        {state?.draft === undefined ? null : (
          <Alert>
            <CheckIcon aria-hidden="true" />
            <AlertTitle>{messages.laboratoryRequestDraftSaved}</AlertTitle>
            <AlertDescription>
              {(locale === 'zh-CN' ? draftItem?.nameZh : draftItem?.nameEn)
                ?? state.draft.referenceConcept?.display
                ?? state.draft.catalogItemId} · {indicationLabel(state.draft.indicationCode, messages)}
            </AlertDescription>
          </Alert>
        )}
        {actions.deleteDraft.success?.caseId === caseId
          && state?.draft === undefined
          && state?.draftVersion === actions.deleteDraft.success.draftVersion ? (
          <Alert>
            <CheckIcon aria-hidden="true" />
            <AlertTitle>{messages.laboratoryRequestDraftDeleted}</AlertTitle>
          </Alert>
        ) : null}
        {actions.save.error === null ? null : <ErrorAlert message={getWorkspaceErrorMessage(actions.save.error, messages)} title={getWorkspaceErrorTitle(actions.save.error, messages, messages.operationFailed)} />}
        {actions.deleteDraft.error === null ? null : <ErrorAlert message={getWorkspaceErrorMessage(actions.deleteDraft.error, messages)} title={getWorkspaceErrorTitle(actions.deleteDraft.error, messages, messages.operationFailed)} />}
        {actions.issue.error === null ? null : <ErrorAlert message={getWorkspaceErrorMessage(actions.issue.error, messages)} title={getWorkspaceErrorTitle(actions.issue.error, messages, messages.operationFailed)} />}
      </FieldGroup>}
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{messages.laboratoryRequestStatus}</h4>
        {state === undefined || state.requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">{messages.noLaboratoryRequests}</p>
        ) : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[34%] whitespace-normal">{messages.laboratoryItem}</TableHead>
                <TableHead className="w-[28%] whitespace-normal">{messages.laboratoryIndication}</TableHead>
                <TableHead className="w-[26%] whitespace-normal">{messages.status}</TableHead>
                <TableHead className="w-[12%]"><span className="sr-only">{messages.laboratoryRequestActions}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.requests.map((request) => {
                const item = catalogById.get(request.catalogItemId)
                const itemName = (locale === 'zh-CN' ? item?.nameZh : item?.nameEn)
                  ?? request.referenceConcept?.display
                  ?? request.catalogItemId
                return (
                  <TableRow key={request.id}>
                    <TableCell className="break-words whitespace-normal font-medium">{itemName}</TableCell>
                    <TableCell className="break-words whitespace-normal">{indicationLabel(request.indicationCode, messages)}</TableCell>
                    <TableCell className="break-words whitespace-normal"><Badge variant="outline">{laboratoryRequestStatusLabel(request, messages)}</Badge>{request.generationError === undefined ? null : <p className="mt-1 text-xs text-destructive">{request.generationError.message}</p>}</TableCell>
                    <TableCell className="text-right">
                      {readOnly ? null : request.status === 'generation-failed' ? (
                        <Button
                          aria-label={`${locale === 'zh-CN' ? '重试结果生成' : 'Retry result generation'} ${itemName}`}
                          disabled={actions.retry.pending}
                          onClick={() => actions.retry.onSubmit(request)}
                          size="icon-sm"
                          title={locale === 'zh-CN' ? '重试结果生成' : 'Retry result generation'}
                          type="button"
                          variant="outline"
                        >
                          <RefreshCwIcon />
                        </Button>
                      ) : request.status !== 'issued' ? null : (
                        <AlertDialog>
                          <AlertDialogTrigger
                            render={(
                              <Button
                                aria-label={`${messages.cancelLaboratoryRequest} ${itemName}`}
                                disabled={actions.cancel.pending}
                                size="icon-sm"
                                title={`${messages.cancelLaboratoryRequest} ${itemName}`}
                                type="button"
                                variant="destructive"
                              />
                            )}
                          >
                            <CircleXIcon />
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>{messages.cancelLaboratoryRequestTitle}</AlertDialogTitle>
                              <AlertDialogDescription>
                                {messages.cancelLaboratoryRequestDescription}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <dl className="grid grid-cols-2 gap-3 text-sm">
                              <div>
                                <dt className="text-xs text-muted-foreground">{messages.laboratoryItem}</dt>
                                <dd className="mt-1 font-medium">{itemName}</dd>
                              </div>
                              <div>
                                <dt className="text-xs text-muted-foreground">{messages.status}</dt>
                                <dd className="mt-1 font-medium">
                                  {laboratoryRequestStatusLabel(request, messages)}
                                </dd>
                              </div>
                            </dl>
                            <AlertDialogFooter>
                              <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
                              <AlertDialogAction
                                disabled={actions.cancel.pending}
                                onClick={() => actions.cancel.onSubmit(request)}
                                variant="destructive"
                              >
                                <CircleXIcon data-icon="inline-start" />
                                {messages.confirmCancelLaboratoryRequest}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
        {actions.cancel.successRequestId !== undefined
          && state?.requests.some(request => (
            request.id === actions.cancel.successRequestId && request.status === 'cancelled'
          )) ? (
          <Alert>
            <CheckIcon aria-hidden="true" />
            <AlertTitle>{messages.laboratoryRequestCancelled}</AlertTitle>
          </Alert>
        ) : null}
        {actions.cancel.error === null ? null : <ErrorAlert message={getWorkspaceErrorMessage(actions.cancel.error, messages)} title={getWorkspaceErrorTitle(actions.cancel.error, messages, messages.operationFailed)} />}
        {actions.retry.error === null ? null : <ErrorAlert message={getWorkspaceErrorMessage(actions.retry.error, messages)} title={getWorkspaceErrorTitle(actions.retry.error, messages, messages.operationFailed)} />}
        {state?.requests.map((request) => {
          if (request.status !== 'in-progress') return null
          const item = catalogById.get(request.catalogItemId)
          return (
            <Alert key={`waiting:${request.id}`}>
              <RefreshCwIcon aria-hidden="true" className="animate-spin" />
              <AlertTitle>{messages.laboratoryResultPending}</AlertTitle>
              <AlertDescription>
                {locale === 'zh-CN' ? item?.nameZh : item?.nameEn}
                {item === undefined ? request.referenceConcept?.display : null}
              </AlertDescription>
            </Alert>
          )
        })}
        {state?.requests.map((request) => {
          if (request.report === undefined) return null
          const item = catalogById.get(request.catalogItemId)
          return (
            <LaboratoryRequestReport
              action={actions.acknowledge}
              correctionAction={actions.correct}
              itemName={(locale === 'zh-CN' ? item?.nameZh : item?.nameEn) ?? request.referenceConcept?.display ?? request.catalogItemId}
              key={`report:${request.id}:${request.report.diagnosticReportId}`}
              locale={locale}
              messages={messages}
              readOnly={readOnly}
              request={request}
              showCorrection={showCorrection}
            />
          )
        })}
        {readOnly || actions.acknowledge.error === null ? null : (
          <ErrorAlert
            message={getWorkspaceErrorMessage(actions.acknowledge.error, messages)}
            title={getWorkspaceErrorTitle(
              actions.acknowledge.error,
              messages,
              messages.operationFailed,
            )}
          />
        )}
      </div>
    </div>
  )
}

function LaboratoryRequestReport({ action, correctionAction, itemName, locale, messages, readOnly, request, showCorrection }: {
  action: LaboratoryRequestActions['acknowledge']
  correctionAction: LaboratoryRequestActions['correct']
  itemName: string
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  readOnly: boolean
  request: LaboratoryRequest
  showCorrection: boolean
}): React.JSX.Element {
  const report = request.report
  if (report === undefined) throw new Error('The laboratory report is required')
  const headingId = `laboratory-request-report-${request.id}`
  const pendingThisReport = action.pendingRequestId === request.id
  const correctionSupported = report.results.every(isQuantitativeLaboratoryResult)
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="text-sm font-semibold" id={headingId}>
          {itemName} · {messages.laboratoryReport}
        </h5>
        {readOnly || request.status !== 'reported' ? null : (
          <Button
            aria-label={`${messages.acknowledgeLaboratoryReport} ${itemName}`}
            disabled={action.pending}
            onClick={() => action.onSubmit(request)}
            size="sm"
            type="button"
          >
            {pendingThisReport
              ? <RefreshCwIcon aria-hidden="true" className="animate-spin" data-icon="inline-start" />
              : <CheckIcon data-icon="inline-start" />}
            {messages.acknowledgeLaboratoryReport}
          </Button>
        )}
      </div>
      <LaboratoryReportVersion
        current
        locale={locale}
        messages={messages}
        report={report}
      />
      {correctionAction.allowed && showCorrection && correctionSupported ? (
        <LaboratoryReportCorrectionForm
          action={correctionAction}
          itemName={itemName}
          messages={messages}
          report={report}
          request={request}
        />
      ) : null}
      {request.previousReports.length === 0 ? null : (
        <div className="flex flex-col gap-3">
          <h6 className="text-xs font-semibold text-muted-foreground">
            {messages.laboratoryReportHistory}
          </h6>
          {request.previousReports.toReversed().map(previousReport => (
            <LaboratoryReportVersion
              current={false}
              key={previousReport.diagnosticReportId}
              locale={locale}
              messages={messages}
              report={previousReport}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function LaboratoryReportCorrectionForm({ action, itemName, messages, report, request }: {
  action: LaboratoryRequestActions['correct']
  itemName: string
  messages: ReturnType<typeof getWorkspaceMessages>
  report: LaboratoryReport
  request: LaboratoryRequest
}): React.JSX.Element {
  const [preview, setPreview] = useState<LaboratoryReportCorrectionInput>()
  const pendingThisRequest = action.pending && action.pendingRequestId === request.id
  const quantitativeResults = report.results.filter(isQuantitativeLaboratoryResult)
  const submitPreview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPreview({
      conclusion: String(form.get('conclusion') ?? ''),
      reason: String(form.get('reason') ?? ''),
      results: quantitativeResults.map(result => ({
        code: result.code,
        value: Number(form.get(`result:${result.code}`)),
      })),
    })
  }
  return (
    <section className="flex flex-col gap-3 border-t pt-4">
      {action.successRequestId === request.id ? (
        <Alert>
          <CheckIcon aria-hidden="true" />
          <AlertTitle>{messages.laboratoryReportCorrectionSaved}</AlertTitle>
        </Alert>
      ) : null}
      <form
        aria-label={`${messages.openLaboratoryReportCorrection} ${itemName}`}
        onSubmit={submitPreview}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`laboratory-report-correction-conclusion-${request.id}`}>
              {messages.laboratoryReportCorrectionConclusion}
            </FieldLabel>
            <Textarea
              defaultValue={report.conclusion}
              id={`laboratory-report-correction-conclusion-${request.id}`}
              maxLength={2_000}
              minLength={2}
              name="conclusion"
              required
            />
          </Field>
          <FieldSet>
            <FieldLegend variant="label">{messages.result}</FieldLegend>
            <FieldGroup className="grid gap-3 sm:grid-cols-2">
              {quantitativeResults.map(result => (
                <Field key={result.code}>
                  <FieldLabel htmlFor={`laboratory-report-correction-${request.id}-${result.code}`}>
                    {result.display} · {messages.result}
                  </FieldLabel>
                  <Input
                    defaultValue={result.value}
                    id={`laboratory-report-correction-${request.id}-${result.code}`}
                    name={`result:${result.code}`}
                    required
                    step="any"
                    type="number"
                  />
                </Field>
              ))}
            </FieldGroup>
          </FieldSet>
          <Field>
            <FieldLabel htmlFor={`laboratory-report-correction-reason-${request.id}`}>
              {messages.laboratoryReportCorrectionReason}
            </FieldLabel>
            <Textarea
              id={`laboratory-report-correction-reason-${request.id}`}
              maxLength={500}
              minLength={2}
              name="reason"
              required
            />
          </Field>
          <div className="flex justify-end">
            <Button disabled={action.pending} type="submit" variant="outline">
              {pendingThisRequest
                ? <RefreshCwIcon aria-hidden="true" className="animate-spin" data-icon="inline-start" />
                : <FlaskConicalIcon data-icon="inline-start" />}
              {messages.previewLaboratoryReportCorrection}
            </Button>
          </div>
        </FieldGroup>
      </form>
      {action.error !== null && action.lastRequestId === request.id ? (
        <ErrorAlert
          message={getWorkspaceErrorMessage(action.error, messages)}
          title={getWorkspaceErrorTitle(action.error, messages, messages.operationFailed)}
        />
      ) : null}
      <AlertDialog
        onOpenChange={open => {
          if (!open) setPreview(undefined)
        }}
        open={preview !== undefined}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{messages.confirmLaboratoryReportCorrection}</AlertDialogTitle>
            <AlertDialogDescription>
              {messages.laboratoryReportCorrectionConfirmationDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {preview === undefined ? null : (
            <div className="max-h-[50vh] space-y-3 overflow-y-auto text-sm">
              <dl className="space-y-3">
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {messages.laboratoryReportCorrectionConclusion}
                  </dt>
                  <dd className="mt-1 whitespace-pre-wrap break-words">{preview.conclusion}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{messages.result}</dt>
                  <dd className="mt-1">
                    <ul className="space-y-1.5">
                      {preview.results.map((result, index) => (
                        <li className="flex flex-wrap justify-between gap-x-3 gap-y-1" key={result.code}>
                          <span>{quantitativeResults[index]?.display ?? result.code}</span>
                          <span className="font-medium">
                            {result.value} {quantitativeResults[index]?.unit.display ?? ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {messages.laboratoryReportCorrectionReason}
                  </dt>
                  <dd className="mt-1 whitespace-pre-wrap break-words">{preview.reason}</dd>
                </div>
              </dl>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
            <AlertDialogAction
              disabled={action.pending}
              onClick={() => {
                if (preview === undefined) return
                action.onSubmit(request, preview)
                setPreview(undefined)
              }}
            >
              {messages.confirmLaboratoryReportCorrection}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function LaboratoryReportVersion({ current, locale, messages, report }: {
  current: boolean
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  report: LaboratoryReport
}): React.JSX.Element {
  const versionLabel = (
    current
      ? messages.laboratoryReportCurrentVersion
      : messages.laboratoryReportReplacedVersion
  ).replace('{version}', report.revisionNumber.toLocaleString(locale))
  return (
    <div className="flex flex-col gap-3 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={current ? 'secondary' : 'outline'}>{versionLabel}</Badge>
        {report.acknowledgement === undefined ? null : (
          <Badge variant="success">{messages.laboratoryReportAcknowledged}</Badge>
        )}
      </div>
      {report.revisionReason === undefined ? null : (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">{messages.laboratoryReportRevisionReason}: </span>
          {report.revisionReason}
        </p>
      )}
      <p className="text-sm">
        <span className="font-medium">{messages.laboratoryReportConclusion}: </span>
        {report.conclusion}
      </p>
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[30%] whitespace-normal">{messages.laboratoryItem}</TableHead>
            <TableHead className="w-[30%] whitespace-normal">{messages.result}</TableHead>
            <TableHead className="w-[40%] whitespace-normal">{messages.referenceRange}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.results.map((result) => {
            const unit = 'unit' in result ? result.unit.display : undefined
            return (
              <TableRow key={result.observationId}>
                <TableCell className="break-words whitespace-normal font-medium">
                  {laboratoryResultName(result.code, messages, result.display)}
                </TableCell>
                <TableCell className="break-words whitespace-normal">
                  <span>{laboratoryResultValue(result.value, unit, locale, messages)}</span>
                  <Badge
                    className="ml-2"
                    variant={result.interpretation === 'normal' ? 'success' : 'destructive'}
                  >
                    {interpretationLabel(result.interpretation, messages)}
                  </Badge>
                </TableCell>
                <TableCell className="break-words whitespace-normal">{result.referenceRange.text}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function StructuredClinicalDocumentPanel({
  allowRevision,
  detail,
  locale,
  messages,
  onDocumentChange,
  onRefresh,
  onRevisionCompleted,
  workingDocument,
}: {
  allowRevision: boolean
  detail: DoctorCaseDetail
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onDocumentChange: (document: ClinicalDocumentContent) => void
  onRefresh: () => Promise<void>
  onRevisionCompleted: () => Promise<void>
  workingDocument: ClinicalDocumentContent
}): React.JSX.Element | null {
  const draft = detail.clinicalDocument?.draft
  const signedDocuments = detail.clinicalDocument?.signed ?? []
  const latestSignedDocument = signedDocuments.at(-1)
  const [revisionPreview, setRevisionPreview] = useState<{
    caseId: string
    compositionId: string
    compositionVersion: string
    document: ClinicalDocumentContent
    encounterId: string
    encounterVersion: string
    reason: string
  }>()
  const prepareSign = useMutation({
    mutationFn: async (document: ClinicalDocumentContent) => {
      const saved = await saveClinicalDocumentDraft({
        document,
        encounterId: detail.encounter.id,
        encounterVersion: detail.encounter.versionId,
        expectedDraftVersion: draft?.version ?? 0,
      }, newIdempotencyKey())
      return previewStructuredClinicalDocumentSign({
        encounterId: detail.encounter.id,
        encounterVersion: detail.encounter.versionId,
        expectedDraftVersion: saved.data.draftVersion,
      }, newIdempotencyKey())
    },
    onError: async () => {
      await onRefresh()
    },
  })
  const sign = useMutation({
    mutationFn: (preview: Awaited<ReturnType<typeof previewStructuredClinicalDocumentSign>>['data']) => (
      signStructuredClinicalDocument({
        commitToken: preview.commitToken,
        encounterId: detail.encounter.id,
        encounterVersion: detail.encounter.versionId,
        previewId: preview.previewId,
      }, newIdempotencyKey())
    ),
    onError: async () => {
      await onRefresh()
    },
    onSuccess: async () => {
      prepareSign.reset()
      await onRefresh()
    },
  })
  const revise = useMutation({
    mutationFn: (input: {
      caseId: string
      compositionId: string
      compositionVersion: string
      document: ClinicalDocumentContent
      encounterId: string
      encounterVersion: string
      reason: string
    }) => reviseStructuredClinicalDocument({
      compositionId: input.compositionId,
      compositionVersion: input.compositionVersion,
      document: input.document,
      encounterId: input.encounterId,
      encounterVersion: input.encounterVersion,
      reason: input.reason,
    }, newIdempotencyKey()),
    onError: async () => {
      await onRefresh()
    },
    onSuccess: async () => {
      await onRevisionCompleted()
    },
  })

  if (
    signedDocuments.length === 0
    && detail.encounter.status !== 'in-progress'
  ) {
    return null
  }

  const currentPreview = prepareSign.data?.data
  return (
    <section
      aria-labelledby="structured-clinical-document-heading"
      className="flex flex-col gap-4"
      id={encounterCompletionTargetElementIds['clinical-document']}
      tabIndex={-1}
    >
      <h3 className="text-sm font-semibold" id="structured-clinical-document-heading">
        {messages.structuredClinicalDocument}
      </h3>
      {sign.isSuccess ? (
        <Alert>
          <CheckCircleIcon aria-hidden="true" />
          <AlertTitle>{messages.clinicalDocumentSigned}</AlertTitle>
          <AlertDescription>{messages.encounterStillInProgress}</AlertDescription>
        </Alert>
      ) : null}
      {signedDocuments.length > 0 ? (
        <>
          {revise.isSuccess ? (
            <Alert>
              <CheckIcon aria-hidden="true" />
              <AlertTitle>{messages.clinicalDocumentRevisionSaved}</AlertTitle>
            </Alert>
          ) : null}
          <section aria-labelledby="signed-clinical-document-history-heading" className="flex flex-col gap-3">
            <h4 className="text-sm font-semibold" id="signed-clinical-document-history-heading">
              {messages.signedClinicalDocumentHistory}
            </h4>
            <ol className="flex flex-col gap-4">
              {signedDocuments.map(document => (
                <li className="flex flex-col gap-3 border-b pb-4 last:border-b-0 last:pb-0" key={document.documentId}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{messages.clinicalDocumentSigned}</Badge>
                      <Badge variant="outline">{messages.documentVersion} {document.revisionNumber}</Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {messages.signedAt} {formatClinicalDocumentTime(document.signedAt, locale)}
                    </span>
                  </div>
                  {document.revisionReason === undefined ? null : (
                    <p className="text-sm text-muted-foreground">
                      {messages.revisionReason}：{document.revisionReason}
                    </p>
                  )}
                  <ClinicalDocumentContentView content={document.content} messages={messages} />
                </li>
              ))}
            </ol>
          </section>
          {!allowRevision || latestSignedDocument === undefined ? null : (
            <div className="flex flex-col gap-3 border-t pt-5">
              <h4 className="text-sm font-semibold">
                {messages.clinicalDocumentRevisionForm}
              </h4>
              <ClinicalDocumentForm
                content={latestSignedDocument.content}
                formName={messages.clinicalDocumentRevisionForm}
                idPrefix={`clinical-document-revision-${latestSignedDocument.compositionId}`}
                includeRevisionReason
                key={latestSignedDocument.compositionId}
                messages={messages}
                onSubmit={(document, reason) => setRevisionPreview({
                  caseId: detail.caseId,
                  compositionId: latestSignedDocument.compositionId,
                  compositionVersion: latestSignedDocument.compositionVersion,
                  document,
                  encounterId: detail.encounter.id,
                  encounterVersion: detail.encounter.versionId,
                  reason,
                })}
                pending={revise.isPending}
                pendingLabel={messages.revisingClinicalDocument}
                submitLabel={messages.submitClinicalDocumentRevision}
              />
              <AlertDialog
                onOpenChange={open => {
                  if (!open) setRevisionPreview(undefined)
                }}
                open={revisionPreview !== undefined}
              >
                <AlertDialogContent className="sm:max-w-2xl">
                  <AlertDialogHeader>
                    <AlertDialogTitle>{messages.confirmClinicalDocumentRevision}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {messages.clinicalDocumentRevisionDescription}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  {revisionPreview === undefined ? null : (
                    <div className="flex max-h-[55vh] flex-col gap-4 overflow-y-auto text-sm">
                      <ClinicalDocumentContentView
                        content={revisionPreview.document}
                        messages={messages}
                      />
                      <div>
                        <div className="text-xs text-muted-foreground">{messages.revisionReason}</div>
                        <div className="mt-1 whitespace-pre-wrap break-words font-medium">
                          {revisionPreview.reason}
                        </div>
                      </div>
                    </div>
                  )}
                  <AlertDialogFooter>
                    <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
                    <AlertDialogAction
                      disabled={revise.isPending}
                      onClick={() => {
                        if (revisionPreview === undefined) return
                        revise.mutate(revisionPreview)
                        setRevisionPreview(undefined)
                      }}
                    >
                      <FileSignatureIcon data-icon="inline-start" />
                      {messages.confirmClinicalDocumentRevisionAction}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              {revise.error === null
                || revise.variables?.caseId !== detail.caseId
                || !signedDocuments.some(document => (
                  document.compositionId === revise.variables?.compositionId
                )) ? null : (
                <ErrorAlert
                  message={getWorkspaceErrorMessage(revise.error, messages)}
                  title={getWorkspaceErrorTitle(revise.error, messages, messages.operationFailed)}
                />
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <form
            aria-label={messages.structuredClinicalDocument}
            className="flex flex-col gap-3"
            onSubmit={event => {
              event.preventDefault()
              prepareSign.mutate(workingDocument)
            }}
          >
            <ClinicalRecordEditor
              content={workingDocument}
              idPrefix={`clinical-record-${detail.caseId}`}
              messages={messages}
              onChange={onDocumentChange}
            />
            <div className="flex justify-end border-t pt-3">
              <Button disabled={prepareSign.isPending} type="submit">
                {prepareSign.isPending
                  ? <RefreshCwIcon aria-hidden="true" className="animate-spin" data-icon="inline-start" />
                  : <FileSignatureIcon aria-hidden="true" data-icon="inline-start" />}
                {prepareSign.isPending ? messages.signingClinicalRecord : messages.signClinicalRecord}
              </Button>
            </div>
          </form>
          {prepareSign.error === null ? null : (
            <ErrorAlert
              message={getWorkspaceErrorMessage(prepareSign.error, messages)}
              title={getWorkspaceErrorTitle(prepareSign.error, messages, messages.operationFailed)}
            />
          )}
          <AlertDialog
            onOpenChange={open => {
              if (!open && !sign.isPending) prepareSign.reset()
            }}
            open={currentPreview !== undefined}
          >
            <AlertDialogContent className="sm:max-w-2xl">
              <AlertDialogHeader>
                <AlertDialogTitle>{messages.confirmClinicalRecordSign}</AlertDialogTitle>
                <AlertDialogDescription>{messages.clinicalDocumentSignDescription}</AlertDialogDescription>
              </AlertDialogHeader>
              {currentPreview === undefined ? null : (
                <div className="max-h-[55vh] overflow-y-auto">
                  <ClinicalDocumentContentView content={currentPreview.document.content} messages={messages} />
                </div>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={sign.isPending}>{messages.cancel}</AlertDialogCancel>
                <Button
                  disabled={currentPreview === undefined || sign.isPending}
                  onClick={() => {
                    if (currentPreview !== undefined) sign.mutate(currentPreview)
                  }}
                  type="button"
                >
                  {sign.isPending
                    ? <RefreshCwIcon aria-hidden="true" className="animate-spin" data-icon="inline-start" />
                    : <CheckCircleIcon aria-hidden="true" data-icon="inline-start" />}
                  {messages.confirmClinicalRecordSign}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {sign.error === null ? null : (
            <ErrorAlert
              message={getWorkspaceErrorMessage(sign.error, messages)}
              title={getWorkspaceErrorTitle(sign.error, messages, messages.operationFailed)}
            />
          )}
        </>
      )}
    </section>
  )
}

function ClinicalRecordEditor({ content, idPrefix, messages, onChange }: {
  content: ClinicalDocumentContent
  idPrefix: string
  messages: ReturnType<typeof getWorkspaceMessages>
  onChange: (document: ClinicalDocumentContent) => void
}): React.JSX.Element {
  const fields = [
    { field: 'chiefComplaint', label: messages.chiefComplaint, maxLength: 1_000, multiline: false },
    { field: 'historyOfPresentIllness', label: messages.historyOfPresentIllness, maxLength: 5_000, multiline: true },
    { field: 'priorMedicalHistory', label: messages.priorMedicalHistory, maxLength: 4_000, multiline: true },
    { field: 'physicalExamination', label: messages.physicalExamination, maxLength: 4_000, multiline: true },
    { field: 'auxiliaryExamination', label: messages.auxiliaryExamination, maxLength: 4_000, multiline: true },
    { field: 'assessment', label: messages.assessment, maxLength: 4_000, multiline: true },
    { field: 'disposition', label: messages.disposition, maxLength: 4_000, multiline: true },
    { field: 'followUp', label: messages.followUp, maxLength: 4_000, multiline: true },
  ] satisfies Array<{
    field: keyof ClinicalDocumentContent
    label: string
    maxLength: number
    multiline: boolean
  }>
  return (
    <FieldGroup className="gap-0 overflow-hidden rounded-md border">
      {fields.map(({ field, label, maxLength, multiline }) => {
        const id = `${idPrefix}-${field}`
        const value = content[field] ?? ''
        return (
          <Field className="grid gap-2 border-b px-3 py-2.5 last:border-b-0 sm:grid-cols-[6rem_minmax(0,1fr)] sm:items-start" key={field}>
            <FieldLabel className="pt-2" htmlFor={id}>{label}</FieldLabel>
            {multiline ? (
              <Textarea
                className="min-h-10 resize-y"
                id={id}
                maxLength={maxLength}
                minLength={2}
                onChange={event => onChange({ ...content, [field]: event.currentTarget.value })}
                required
                value={value}
              />
            ) : (
              <Input
                id={id}
                maxLength={maxLength}
                minLength={2}
                onChange={event => onChange({ ...content, [field]: event.currentTarget.value })}
                required
                value={value}
              />
            )}
          </Field>
        )
      })}
    </FieldGroup>
  )
}

function ClinicalDocumentForm({
  content,
  formName,
  idPrefix,
  includeRevisionReason = false,
  messages,
  onSubmit,
  pending,
  pendingLabel,
  submitLabel,
}: {
  content: ClinicalDocumentContent
  formName: string
  idPrefix: string
  includeRevisionReason?: boolean
  messages: ReturnType<typeof getWorkspaceMessages>
  onSubmit: (document: ClinicalDocumentContent, reason: string) => void
  pending: boolean
  pendingLabel: string
  submitLabel: string
}): React.JSX.Element {
  return (
    <form
      aria-label={formName}
      onSubmit={event => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        onSubmit({
          assessment: String(data.get('assessment') ?? ''),
          auxiliaryExamination: String(data.get('auxiliaryExamination') ?? ''),
          chiefComplaint: String(data.get('chiefComplaint') ?? ''),
          disposition: String(data.get('disposition') ?? ''),
          followUp: String(data.get('followUp') ?? ''),
          historyOfPresentIllness: String(data.get('historyOfPresentIllness') ?? ''),
          physicalExamination: String(data.get('physicalExamination') ?? ''),
          priorMedicalHistory: String(data.get('priorMedicalHistory') ?? ''),
        }, String(data.get('revisionReason') ?? ''))
      }}
    >
      <FieldGroup className="grid grid-cols-1 gap-0 overflow-hidden rounded-md border md:grid-cols-2">
        <Field className="border-b p-3 md:col-span-2">
          <FieldLabel htmlFor={`${idPrefix}-chief-complaint`}>{messages.chiefComplaint}</FieldLabel>
          <Textarea
            defaultValue={content.chiefComplaint}
            id={`${idPrefix}-chief-complaint`}
            maxLength={1_000}
            minLength={2}
            name="chiefComplaint"
            required
          />
        </Field>
        <Field className="border-b p-3 md:col-span-2">
          <FieldLabel htmlFor={`${idPrefix}-history`}>{messages.historyOfPresentIllness}</FieldLabel>
          <Textarea
            className="min-h-24"
            defaultValue={content.historyOfPresentIllness}
            id={`${idPrefix}-history`}
            maxLength={5_000}
            minLength={2}
            name="historyOfPresentIllness"
            required
          />
        </Field>
        <Field className="border-b p-3 md:col-span-2">
          <FieldLabel htmlFor={`${idPrefix}-prior-history`}>{messages.priorMedicalHistory}</FieldLabel>
          <Textarea
            defaultValue={content.priorMedicalHistory}
            id={`${idPrefix}-prior-history`}
            maxLength={4_000}
            minLength={2}
            name="priorMedicalHistory"
            required
          />
        </Field>
        <Field className="border-b p-3 md:col-span-2">
          <FieldLabel htmlFor={`${idPrefix}-examination`}>{messages.physicalExamination}</FieldLabel>
          <Textarea
            defaultValue={content.physicalExamination}
            id={`${idPrefix}-examination`}
            maxLength={4_000}
            minLength={2}
            name="physicalExamination"
            required
          />
        </Field>
        <Field className="border-b p-3 md:col-span-2">
          <FieldLabel htmlFor={`${idPrefix}-auxiliary`}>{messages.auxiliaryExamination}</FieldLabel>
          <Textarea
            defaultValue={content.auxiliaryExamination}
            id={`${idPrefix}-auxiliary`}
            maxLength={4_000}
            minLength={2}
            name="auxiliaryExamination"
            required
          />
        </Field>
        <Field className="border-b p-3 md:border-r">
          <FieldLabel htmlFor={`${idPrefix}-assessment`}>{messages.assessment}</FieldLabel>
          <Textarea
            defaultValue={content.assessment}
            id={`${idPrefix}-assessment`}
            maxLength={4_000}
            minLength={2}
            name="assessment"
            required
          />
        </Field>
        <Field className="border-b p-3">
          <FieldLabel htmlFor={`${idPrefix}-disposition`}>{messages.disposition}</FieldLabel>
          <Textarea
            defaultValue={content.disposition}
            id={`${idPrefix}-disposition`}
            maxLength={4_000}
            minLength={2}
            name="disposition"
            required
          />
        </Field>
        <Field className="border-b p-3 md:col-span-2">
          <FieldLabel htmlFor={`${idPrefix}-follow-up`}>{messages.followUp}</FieldLabel>
          <Textarea
            defaultValue={content.followUp}
            id={`${idPrefix}-follow-up`}
            maxLength={4_000}
            minLength={2}
            name="followUp"
            required
          />
        </Field>
        {includeRevisionReason ? (
          <Field className="border-b p-3 md:col-span-2">
            <FieldLabel htmlFor={`${idPrefix}-reason`}>{messages.revisionReason}</FieldLabel>
            <Textarea
              id={`${idPrefix}-reason`}
              maxLength={500}
              minLength={2}
              name="revisionReason"
              required
            />
          </Field>
        ) : null}
        <Field className="items-end p-3 md:col-span-2">
          <Button disabled={pending} type="submit">
            {pending
              ? <RefreshCwIcon aria-hidden="true" className="animate-spin" data-icon="inline-start" />
              : <ClipboardPenIcon aria-hidden="true" data-icon="inline-start" />}
            {pending ? pendingLabel : submitLabel}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

function ClinicalDocumentContentView({ content, messages }: {
  content: ClinicalDocumentContent
  messages: ReturnType<typeof getWorkspaceMessages>
}): React.JSX.Element {
  const fields = [
    [messages.chiefComplaint, content.chiefComplaint],
    [messages.historyOfPresentIllness, content.historyOfPresentIllness],
    [messages.priorMedicalHistory, content.priorMedicalHistory],
    [messages.physicalExamination, content.physicalExamination],
    [messages.auxiliaryExamination, content.auxiliaryExamination],
    [messages.assessment, content.assessment],
    [messages.disposition, content.disposition],
    [messages.followUp, content.followUp],
  ]
  return (
    <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
      {fields.flatMap(([label, value]) => value === undefined ? [] : [(
        <div key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="whitespace-pre-wrap font-medium">{value}</dd>
        </div>
      )])}
    </dl>
  )
}

function formatClinicalDocumentTime(value: string, locale: WorkspaceLocale): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function ConsultationPanel({ action, consultation, locale, messages, patientName, readOnly }: {
  action: ConsultationAction
  consultation: NonNullable<DoctorCaseDetail['consultation']>
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  patientName: string
  readOnly: boolean
}): React.JSX.Element {
  const [questionCode, setQuestionCode] = useState('')
  const timeFormatter = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  })
  return (
    <section aria-labelledby="consultation-record-heading" className="flex flex-col gap-3 border-b pb-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold" id="consultation-record-heading">{messages.consultationRecord}</h3>
        <Badge variant="secondary">{consultation.records.length}</Badge>
      </div>
      <MessageScrollerProvider autoScroll>
        <MessageScroller className="h-64 rounded-md border">
          <MessageScrollerViewport>
            <MessageScrollerContent className="gap-4 p-3">
              {consultation.records.length === 0 ? (
                <MessageScrollerItem messageId="empty-consultation-records">
                  <Empty className="min-h-52">
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><MessagesSquareIcon aria-hidden="true" /></EmptyMedia>
                      <EmptyTitle>{messages.noConsultationHistory}</EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                </MessageScrollerItem>
              ) : consultation.records.flatMap(record => [
                <MessageScrollerItem key={`${record.id}-question`} messageId={`${record.id}-question`} scrollAnchor>
                  <Message align="end">
                    <MessageContent>
                      <MessageHeader>{messages.doctorQuestion} · #{record.sequence}</MessageHeader>
                      <Bubble align="end" variant="outline"><BubbleContent>{record.question.text}</BubbleContent></Bubble>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>,
                <MessageScrollerItem key={`${record.id}-answer`} messageId={`${record.id}-answer`}>
                  <Message>
                    <MessageContent>
                      <MessageHeader>{patientName}</MessageHeader>
                      <Bubble variant="muted"><BubbleContent>{record.answer}</BubbleContent></Bubble>
                      <MessageFooter>{timeFormatter.format(new Date(record.recordedAt))}</MessageFooter>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>,
              ])}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      {readOnly ? null : <form
        onSubmit={event => {
          event.preventDefault()
          if (questionCode !== '') action.onAsk(questionCode)
        }}
      >
        <FieldGroup className="gap-3">
          <FieldSet>
            <FieldLegend variant="label">{messages.consultationQuestions}</FieldLegend>
            <ToggleGroup
              aria-label={messages.consultationQuestions}
              className="w-full"
              disabled={action.pending}
              onValueChange={value => setQuestionCode(value[0] ?? '')}
              orientation="vertical"
              value={questionCode === '' ? [] : [questionCode]}
              variant="outline"
            >
              {consultation.questions.map(question => (
                <ToggleGroupItem
                  aria-label={question.text}
                  className="h-auto w-full justify-start whitespace-normal px-3 py-2 text-left"
                  key={question.code}
                  value={question.code}
                >
                  {question.text}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FieldSet>
          <div className="flex justify-end">
            <Button disabled={action.pending || questionCode === ''} type="submit">
              {action.pending
                ? <RefreshCwIcon aria-hidden="true" className="animate-spin" data-icon="inline-start" />
                : <SendIcon aria-hidden="true" data-icon="inline-start" />}
              {action.pending ? messages.waitingForPatientAnswer : messages.askPatient}
            </Button>
          </div>
          {action.error === null ? null : (
            <ErrorAlert
              message={getWorkspaceErrorMessage(action.error, messages)}
              title={getWorkspaceErrorTitle(action.error, messages, messages.operationFailed)}
            />
          )}
        </FieldGroup>
      </form>}
    </section>
  )
}

function LaboratoryReport({ locale, messages, report }: {
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  report: NonNullable<DoctorCaseDetail['report']>
}): React.JSX.Element {
  return (
    <section aria-labelledby="laboratory-report-heading" className="flex flex-col gap-3 border-b pb-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold" id="laboratory-report-heading">{messages.laboratoryReport}</h3>
        <Badge variant="secondary">{report.status}</Badge>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{messages.laboratoryItem}</TableHead>
            <TableHead>{messages.result}</TableHead>
            <TableHead>{messages.referenceRange}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.results.map(result => (
            <TableRow key={result.code}>
              <TableCell className="font-medium">{laboratoryResultName(result.code, messages)}</TableCell>
              <TableCell>
                <span>{laboratoryResultValue(result.value, result.unit, locale, messages)}</span>
                {result.interpretation === undefined ? null : (
                  <Badge className="ml-2" variant="outline">{interpretationLabel(result.interpretation, messages)}</Badge>
                )}
              </TableCell>
              <TableCell>{result.referenceRange ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  )
}

interface DiagnosisDraftLine extends DiagnosisDraftEntry {
  key: string
  note: string
}

function diagnosisReferenceSnapshot(concept: ReferenceConcept) {
  return {
    code: concept.code,
    display: concept.display,
    id: concept.id,
    sourceLocator: concept.sourceLocator,
    system: concept.system,
    version: concept.version,
  }
}

function DiagnosisCatalogPicker({
  entry,
  id,
  locale,
  localCatalog,
  onSelect,
}: {
  entry: DiagnosisDraftLine
  id: string
  locale: WorkspaceLocale
  localCatalog: ClinicalCatalog['diagnoses']
  onSelect: (catalogItemId: string, referenceConcept?: DiagnosisDraftEntry['referenceConcept']) => void
}) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const normalizedQuery = query.trim()
  const search = useQuery({
    enabled: normalizedQuery.length >= 3,
    queryFn: ({ signal }) => searchReferenceDiagnoses(normalizedQuery, page, signal),
    queryKey: ['reference-diagnoses', normalizedQuery, page],
  })
  const localItems = localCatalog.map(item => ({
    label: `${locale === 'zh-CN' ? item.nameZh : item.nameEn} · ${item.code}`,
    value: item.id,
  }))
  return (
    <div className="flex flex-col gap-2">
      <Input
        aria-label={locale === 'zh-CN' ? '搜索疾病目录' : 'Search diagnosis catalog'}
        onChange={(event) => {
          setPage(1)
          setQuery(event.currentTarget.value)
        }}
        placeholder={locale === 'zh-CN' ? '病名或编码' : 'Name or code'}
        value={query}
      />
      {normalizedQuery.length < 3 ? (
        <WorkspaceSelect
          id={id}
          items={localItems}
          onValueChange={value => {
            if (value !== null) onSelect(value)
          }}
          value={entry.catalogItemId}
        />
      ) : search.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : search.isError ? (
        <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{locale === 'zh-CN' ? '目录加载失败' : 'Catalog unavailable'}</AlertTitle></Alert>
      ) : search.data.items.length === 0 ? (
        <p className="border px-3 py-4 text-sm text-muted-foreground">{locale === 'zh-CN' ? '未找到疾病' : 'No diagnoses found'}</p>
      ) : (
        <div className="border">
          {search.data.items.map(item => (
            <button
              className={cn(
                'flex w-full items-center justify-between gap-3 border-b px-3 py-2 text-left text-sm',
                entry.catalogItemId === item.id && 'bg-muted/60',
              )}
              disabled={item.status !== 'active'}
              key={item.id}
              onClick={() => onSelect(item.id, diagnosisReferenceSnapshot(item))}
              type="button"
            >
              <span>{item.display}</span><span className="font-mono text-xs text-muted-foreground">{item.code}</span>
            </button>
          ))}
          <div className="flex justify-between p-1">
            <Button disabled={page === 1} onClick={() => setPage(current => current - 1)} size="sm" type="button" variant="ghost">{locale === 'zh-CN' ? '上一页' : 'Previous'}</Button>
            <Button disabled={page * search.data.pageSize >= search.data.total} onClick={() => setPage(current => current + 1)} size="sm" type="button" variant="ghost">{locale === 'zh-CN' ? '下一页' : 'Next'}</Button>
          </div>
        </div>
      )}
    </div>
  )
}

function DiagnosisEditor({ actions, catalog, locale, messages, readOnly, state }: {
  actions: DiagnosisActions
  catalog: ClinicalCatalog['diagnoses']
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  readOnly: boolean
  state: DoctorCaseDetail['diagnosis']
}): React.JSX.Element {
  const [entries, setEntries] = useState<DiagnosisDraftLine[]>(() => (
    state?.draft?.entries.map((entry, index) => ({
      ...entry,
      key: `saved-${index}`,
      note: entry.note ?? '',
    })) ?? []
  ))
  const usedCatalogItemIds = new Set(entries.map(entry => entry.catalogItemId))
  const addEntry = () => {
    const catalogItem = catalog.find(item => !usedCatalogItemIds.has(item.id))
    setEntries(current => [...current, {
      catalogItemId: catalogItem?.id ?? '',
      key: globalThis.crypto.randomUUID(),
      note: '',
      role: current.some(entry => entry.role === 'primary') ? 'secondary' : 'primary',
    }])
  }
  const updateEntry = (index: number, update: Partial<DiagnosisDraftLine>) => {
    setEntries(current => current.map((entry, entryIndex) => (
      entryIndex === index ? { ...entry, ...update } : entry
    )))
  }
  const selectEntry = (
    index: number,
    catalogItemId: string,
    referenceConcept?: DiagnosisDraftEntry['referenceConcept'],
  ) => {
    setEntries(current => current.map((entry, entryIndex) => {
      if (entryIndex !== index) return entry
      const { referenceConcept: _previousReference, ...withoutReference } = entry
      return {
        ...withoutReference,
        catalogItemId,
        ...(referenceConcept === undefined ? {} : { referenceConcept }),
      }
    }))
  }
  const updateRole = (index: number, role: DiagnosisDraftEntry['role']) => {
    setEntries(current => {
      if (
        role === 'secondary'
        && current[index]?.role === 'primary'
        && !current.some((entry, entryIndex) => entryIndex !== index && entry.role === 'primary')
      ) {
        return current
      }
      return current.map((entry, entryIndex) => {
        if (entryIndex === index) return { ...entry, role }
        if (role === 'primary' && entry.role === 'primary') {
          return { ...entry, role: 'secondary' }
        }
        return entry
      })
    })
  }
  const removeEntry = (index: number) => {
    setEntries(current => {
      const remaining = current.filter((_, entryIndex) => entryIndex !== index)
      if (remaining.length > 0 && !remaining.some(entry => entry.role === 'primary')) {
        const first = remaining[0]
        if (first !== undefined) remaining[0] = { ...first, role: 'primary' }
      }
      return remaining
    })
  }

  if (state?.confirmation !== undefined) {
    return (
      <section
        aria-labelledby="diagnosis-heading"
        className="flex flex-col gap-3"
        id={encounterCompletionTargetElementIds.diagnosis}
        tabIndex={-1}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold" id="diagnosis-heading">{messages.diagnosisRecord}</h3>
          <Badge variant="secondary">{state.confirmation.entries.length}</Badge>
        </div>
        <Alert>
          <CheckCircleIcon aria-hidden="true" />
          <AlertTitle>{messages.diagnosisConfirmed}</AlertTitle>
          <AlertDescription>{messages.diagnosisConfirmedAt} · {state.confirmation.confirmedAt}</AlertDescription>
        </Alert>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{messages.diagnosisRole}</TableHead>
              <TableHead>{messages.diagnosisItem}</TableHead>
              <TableHead>{messages.diagnosisNote}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.confirmation.entries.map(entry => (
              <TableRow key={entry.conditionId}>
                <TableCell>
                  <Badge variant={entry.role === 'primary' ? 'default' : 'secondary'}>
                    {entry.role === 'primary' ? messages.primaryDiagnosis : messages.secondaryDiagnosis}
                  </Badge>
                </TableCell>
                <TableCell className="font-medium">{entry.code} · {entry.display}</TableCell>
                <TableCell>{entry.note ?? ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    )
  }

  if (readOnly) {
    return (
      <section
        aria-labelledby="diagnosis-heading"
        className="flex flex-col gap-3"
        id={encounterCompletionTargetElementIds.diagnosis}
        tabIndex={-1}
      >
        <h3 className="text-sm font-semibold" id="diagnosis-heading">{messages.diagnosisRecord}</h3>
      </section>
    )
  }

  return (
    <section
      aria-labelledby="diagnosis-heading"
      className="flex flex-col gap-4"
      id={encounterCompletionTargetElementIds.diagnosis}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold" id="diagnosis-heading">{messages.diagnosisRecord}</h3>
        <Button
          disabled={entries.length >= 8}
          onClick={addEntry}
          size="sm"
          type="button"
          variant="outline"
        >
          <PlusIcon data-icon="inline-start" />{messages.addDiagnosis}
        </Button>
      </div>
      <form
        onSubmit={event => {
          event.preventDefault()
          const submittedEntries: DiagnosisDraftEntry[] = entries.map(({ key: _key, note, ...entry }) => ({
            ...entry,
            ...(note.trim().length === 0 ? {} : { note: note.trim() }),
          }))
          actions.confirm.onSubmit(submittedEntries)
        }}
      >
        <FieldGroup>
          {entries.map((entry, index) => {
            const suffix = index === 0 ? '' : ` ${index + 1}`
            return (
              <FieldSet className="border-b pb-4" key={entry.key}>
                <FieldLegend variant="label">{messages.diagnosis} {index + 1}</FieldLegend>
                <FieldGroup>
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(15rem,1.5fr)_minmax(12rem,0.8fr)_auto]">
                    <Field>
                      <FieldLabel htmlFor={`diagnosis-item-${index}`}>{messages.diagnosisItem}{suffix}</FieldLabel>
                      <DiagnosisCatalogPicker
                        entry={entry}
                        id={`diagnosis-item-${index}`}
                        locale={locale}
                        localCatalog={catalog.filter(item => (
                          item.id === entry.catalogItemId || !usedCatalogItemIds.has(item.id)
                        ))}
                        onSelect={(catalogItemId, referenceConcept) => (
                          selectEntry(index, catalogItemId, referenceConcept)
                        )}
                      />
                    </Field>
                    <Field>
                      <FieldLabel id={`diagnosis-role-${index}`}>{messages.diagnosisRole}{suffix}</FieldLabel>
                      <ToggleGroup
                        aria-labelledby={`diagnosis-role-${index}`}
                        onValueChange={value => {
                          const role = value[0]
                          if (role === 'primary' || role === 'secondary') updateRole(index, role)
                        }}
                        size="sm"
                        spacing={2}
                        value={[entry.role]}
                        variant="outline"
                      >
                        <ToggleGroupItem value="primary">{messages.primaryDiagnosis}</ToggleGroupItem>
                        <ToggleGroupItem value="secondary">{messages.secondaryDiagnosis}</ToggleGroupItem>
                      </ToggleGroup>
                    </Field>
                    <div className="flex items-end">
                      <Button
                        aria-label={`${messages.removeDiagnosis}${suffix}`}
                        onClick={() => removeEntry(index)}
                        size="icon"
                        title={`${messages.removeDiagnosis}${suffix}`}
                        type="button"
                        variant="ghost"
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </div>
                  <Field>
                    <FieldLabel htmlFor={`diagnosis-note-${index}`}>{messages.diagnosisNote}{suffix}</FieldLabel>
                    <Textarea
                      id={`diagnosis-note-${index}`}
                      maxLength={500}
                      onChange={event => updateEntry(index, { note: event.currentTarget.value })}
                      value={entry.note}
                    />
                  </Field>
                </FieldGroup>
              </FieldSet>
            )
          })}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={actions.confirm.pending || entries.length === 0 || entries.some(entry => entry.catalogItemId === '') || !entries.some(entry => entry.role === 'primary')}
              type="submit"
            >
              <CheckCircleIcon data-icon="inline-start" />{messages.confirmDiagnosis}
            </Button>
          </div>
          {actions.confirm.error === null ? null : <ErrorAlert message={getWorkspaceErrorMessage(actions.confirm.error, messages)} title={getWorkspaceErrorTitle(actions.confirm.error, messages, messages.operationFailed)} />}
        </FieldGroup>
      </form>
    </section>
  )
}

interface PrescriptionDraftLine extends PrescriptionDraftItem {
  key: string
}

type MedicationConclusionMode = 'no-medication' | 'prescription'
type PrescriptionClinicalCatalog = Extract<
  ClinicalCatalog,
  { prescriptionConclusionSupported: true }
>
type PrescriptionMedicationCatalogItem = PrescriptionClinicalCatalog['medications'][number]

function createPrescriptionDraftLine(
  medication: PrescriptionMedicationCatalogItem,
  key: string,
): PrescriptionDraftLine {
  return {
    catalogItemId: medication.id,
    courseDays: medication.defaultCourseDays,
    doseText: medication.defaultDoseText,
    frequencyCode: medication.defaultFrequencyCode,
    key,
    quantity: medication.defaultQuantity,
  }
}

function createReferencePrescriptionDraftLine(
  product: ReferenceMedicationProduct,
): PrescriptionDraftLine {
  return {
    catalogItemId: product.id,
    courseDays: 3,
    doseText: product.strength,
    frequencyCode: 'QD',
    key: globalThis.crypto.randomUUID(),
    quantity: 1,
    referenceProduct: product,
  }
}

function MedicationConclusionPanel({
  allowWithdrawal,
  catalog,
  detail,
  locale,
  messages,
  onRefresh,
  readOnly,
}: {
  allowWithdrawal: boolean
  catalog: PrescriptionClinicalCatalog['medications']
  detail: DoctorCaseDetail
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onRefresh: () => Promise<void>
  readOnly: boolean
}): React.JSX.Element {
  const state = detail.medicationConclusion
  const prescription = state?.prescription
  const noMedicationConclusion = state?.noMedication
  const hasActivePrescription = prescription !== undefined && prescription.status !== 'withdrawn'
  const [mode, setMode] = useState<MedicationConclusionMode>(
    noMedicationConclusion === undefined ? 'prescription' : 'no-medication',
  )
  const [dirty, setDirty] = useState(false)
  const [medicationQuery, setMedicationQuery] = useState('')
  const [medicationPage, setMedicationPage] = useState(1)
  const normalizedMedicationQuery = medicationQuery.trim()
  const referenceMedications = useQuery({
    enabled: normalizedMedicationQuery.length >= 3,
    queryFn: ({ signal }) => searchReferenceMedications(
      normalizedMedicationQuery,
      medicationPage,
      signal,
    ),
    queryKey: ['reference-medications', normalizedMedicationQuery, medicationPage],
  })
  const [items, setItems] = useState<PrescriptionDraftLine[]>(() => {
    if (state?.draft !== undefined) {
      return state.draft.items.map((item, index) => ({ ...item, key: `saved-${index}` }))
    }
    const firstMedication = catalog[0]
    return firstMedication === undefined ? [] : [createPrescriptionDraftLine(firstMedication, 'new-0')]
  })
  const saveDraft = useMutation({
    mutationFn: () => savePrescriptionDraft({
      encounterId: detail.encounter.id,
      encounterVersion: detail.encounter.versionId,
      expectedDraftVersion: state?.draftVersion ?? 0,
      items: items.map(({ key: _key, ...item }) => item),
    }, newIdempotencyKey()),
    onError: onRefresh,
    onSuccess: async () => {
      setDirty(false)
      await onRefresh()
    },
  })
  const removeDraft = useMutation({
    mutationFn: (caseId: string) => {
      if (detail.caseId !== caseId || state?.draft === undefined) {
        throw new Error(messages.consultationUnavailable)
      }
      return deletePrescriptionDraft({
        encounterId: detail.encounter.id,
        encounterVersion: detail.encounter.versionId,
        expectedDraftVersion: state.draftVersion,
      }, newIdempotencyKey())
    },
    onError: onRefresh,
    onSuccess: async () => {
      setDirty(false)
      await onRefresh()
    },
  })
  const issue = useMutation({
    mutationFn: () => {
      if (state?.draft === undefined) throw new Error(messages.consultationUnavailable)
      return issuePrescription({
        encounterId: detail.encounter.id,
        encounterVersion: detail.encounter.versionId,
        expectedDraftVersion: state.draftVersion,
      }, newIdempotencyKey())
    },
    onError: onRefresh,
    onSuccess: onRefresh,
  })
  const confirmNone = useMutation({
    mutationFn: () => confirmNoMedication({
      encounterId: detail.encounter.id,
      encounterVersion: detail.encounter.versionId,
      expectedDraftVersion: state?.draftVersion ?? 0,
    }, newIdempotencyKey()),
    onError: onRefresh,
    onSuccess: onRefresh,
  })
  const withdraw = useMutation({
    mutationFn: ({ caseId, prescriptionId }: { caseId: string; prescriptionId: string }) => {
      if (
        detail.caseId !== caseId
        || prescription === undefined
        || prescription.id !== prescriptionId
      ) {
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
    onError: onRefresh,
    onSuccess: onRefresh,
  })
  const usedCatalogItemIds = new Set(items.map(item => item.catalogItemId))
  const canCombineWithCurrentItems = (
    candidate: PrescriptionMedicationCatalogItem,
    ignoredIndex?: number,
  ) => items.every((item, index) => {
    if (index === ignoredIndex || item.catalogItemId === candidate.id) return true
    const selected = catalog.find(medication => medication.id === item.catalogItemId)
    return selected?.allowedCombinationIds.includes(candidate.id) === true
      && candidate.allowedCombinationIds.includes(item.catalogItemId)
  })
  const addMedication = () => {
    const nextMedication = catalog.find(candidate => (
      !usedCatalogItemIds.has(candidate.id) && canCombineWithCurrentItems(candidate)
    ))
    if (nextMedication === undefined) return
    setItems(current => [
      ...current,
      createPrescriptionDraftLine(nextMedication, globalThis.crypto.randomUUID()),
    ])
    setDirty(true)
  }
  const updateItem = (index: number, update: Partial<PrescriptionDraftLine>) => {
    setItems(current => current.map((item, itemIndex) => (
      itemIndex === index ? { ...item, ...update } : item
    )))
    setDirty(true)
  }
  const canAddMedication = items.length < 8 && catalog.some(candidate => (
    !usedCatalogItemIds.has(candidate.id) && canCombineWithCurrentItems(candidate)
  ))

  return (
    <section
      aria-labelledby="medication-conclusion-heading"
      className="flex flex-col gap-4"
      id={encounterCompletionTargetElementIds['medication-conclusion']}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold" id="medication-conclusion-heading">
          {messages.medicationConclusion}
        </h3>
      </div>

      {prescription === undefined ? null : (
        <div className="flex flex-col gap-3">
          <Alert>
            {prescription.status === 'withdrawn'
              ? <RotateCcwIcon aria-hidden="true" />
              : <PillIcon aria-hidden="true" />}
            <AlertTitle>
              {prescription.status === 'signed'
                ? messages.prescriptionIssued
                : prescription.status === 'withdrawn'
                  ? messages.prescriptionWithdrawn
                  : prescriptionStatusLabel(prescription.status, messages)}
            </AlertTitle>
            <AlertDescription>
              {messages.prescriptionNumber} {prescription.number} · {formatClinicalDocumentTime(prescription.authoredAt, locale)}
            </AlertDescription>
          </Alert>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">{messages.prescriptionStatus}</span>
              <Badge variant="secondary">{prescriptionStatusLabel(prescription.status, messages)}</Badge>
            </div>
            {allowWithdrawal
              && (prescription.status === 'signed' || prescription.status === 'paid') ? (
              <AlertDialog>
                <AlertDialogTrigger render={<Button size="sm" type="button" variant="outline" />}>
                  <RotateCcwIcon data-icon="inline-start" />{messages.withdrawPrescription}
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{messages.withdrawPrescriptionTitle}</AlertDialogTitle>
                    <AlertDialogDescription>{messages.withdrawPrescriptionDescription}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">{messages.prescriptionNumber}</dt>
                      <dd className="mt-1 font-medium">{prescription.number}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">{messages.prescriptionStatus}</dt>
                      <dd className="mt-1 font-medium">
                        {prescriptionStatusLabel(prescription.status, messages)}
                      </dd>
                    </div>
                  </dl>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
                    <AlertDialogAction
                      disabled={withdraw.isPending}
                      onClick={() => withdraw.mutate({
                        caseId: detail.caseId,
                        prescriptionId: prescription.id,
                      })}
                    >
                      <RotateCcwIcon data-icon="inline-start" />{messages.confirmWithdrawal}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{messages.medication}</TableHead>
                <TableHead>{messages.dose}</TableHead>
                <TableHead>{messages.frequency}</TableHead>
                <TableHead>{messages.course}</TableHead>
                <TableHead>{messages.quantity}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {prescription.items.map(item => (
                <TableRow key={item.medicationRequestId}>
                  <TableCell className="font-medium">{item.display}</TableCell>
                  <TableCell>{item.doseText}</TableCell>
                  <TableCell>{item.frequencyCode}</TableCell>
                  <TableCell>{item.courseDays} {messages.days}</TableCell>
                  <TableCell>{item.quantity}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!allowWithdrawal
            || withdraw.error === null
            || withdraw.variables?.caseId !== detail.caseId
            || withdraw.variables.prescriptionId !== prescription.id ? null : (
            <ErrorAlert
              message={getWorkspaceErrorMessage(withdraw.error, messages)}
              title={getWorkspaceErrorTitle(withdraw.error, messages, messages.operationFailed)}
            />
          )}
        </div>
      )}

      {noMedicationConclusion === undefined ? null : (
        <Alert>
          <CircleXIcon aria-hidden="true" />
          <AlertTitle>{messages.noMedicationConfirmed}</AlertTitle>
          <AlertDescription>
            {messages.authoredAt} · {formatClinicalDocumentTime(noMedicationConclusion.authoredAt, locale)}
          </AlertDescription>
        </Alert>
      )}

      {readOnly || noMedicationConclusion !== undefined || hasActivePrescription ? null : (
        <Field>
          <FieldLabel id="medication-conclusion-mode-label">{messages.medicationConclusionMode}</FieldLabel>
          <ToggleGroup
            aria-labelledby="medication-conclusion-mode-label"
            onValueChange={value => {
              const selectedMode = value[0]
              if (selectedMode === 'prescription' || selectedMode === 'no-medication') {
                setMode(selectedMode)
              }
            }}
            size="sm"
            spacing={2}
            value={[mode]}
            variant="outline"
          >
            <ToggleGroupItem value="prescription">{messages.prescriptionMode}</ToggleGroupItem>
            <ToggleGroupItem value="no-medication">{messages.noMedicationMode}</ToggleGroupItem>
          </ToggleGroup>
        </Field>
      )}

      {!readOnly
        && noMedicationConclusion === undefined
        && !hasActivePrescription
        && mode === 'prescription'
        && prescription === undefined ? (
          <form
            onSubmit={event => {
              event.preventDefault()
              saveDraft.mutate()
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="reference-medication-search">
                  {locale === 'zh-CN' ? '搜索药品目录' : 'Search medication catalog'}
                </FieldLabel>
                <Input
                  id="reference-medication-search"
                  onChange={(event) => {
                    setMedicationPage(1)
                    setMedicationQuery(event.currentTarget.value)
                  }}
                  placeholder={locale === 'zh-CN' ? '通用名、商品名或编码' : 'Generic name, brand, or code'}
                  value={medicationQuery}
                />
              </Field>
              {normalizedMedicationQuery.length < 3 ? null : referenceMedications.isPending ? (
                <Skeleton className="h-20 w-full" />
              ) : referenceMedications.isError ? (
                <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{locale === 'zh-CN' ? '目录加载失败' : 'Catalog unavailable'}</AlertTitle></Alert>
              ) : referenceMedications.data.items.length === 0 ? (
                <p className="border px-3 py-4 text-sm text-muted-foreground">{locale === 'zh-CN' ? '未找到药品' : 'No medications found'}</p>
              ) : (
                <div className="border">
                  {referenceMedications.data.items.map(product => (
                    <button
                      className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 border-b px-3 py-2 text-left text-sm"
                      disabled={product.status !== 'active' || items.length >= 8 || usedCatalogItemIds.has(product.id)}
                      key={product.id}
                      onClick={() => {
                        setItems(current => [...current, createReferencePrescriptionDraftLine(product)])
                        setDirty(true)
                      }}
                      type="button"
                    >
                      <span><strong className="block">{product.genericName}</strong><span className="text-xs text-muted-foreground">{product.strength} · {product.dosageForm} · {product.manufacturer}</span></span>
                      <span className="font-mono text-xs text-muted-foreground">{product.code}</span>
                    </button>
                  ))}
                  <div className="flex justify-between p-1">
                    <Button disabled={medicationPage === 1} onClick={() => setMedicationPage(current => current - 1)} size="sm" type="button" variant="ghost">{locale === 'zh-CN' ? '上一页' : 'Previous'}</Button>
                    <Button disabled={medicationPage * referenceMedications.data.pageSize >= referenceMedications.data.total} onClick={() => setMedicationPage(current => current + 1)} size="sm" type="button" variant="ghost">{locale === 'zh-CN' ? '下一页' : 'Next'}</Button>
                  </div>
                </div>
              )}
              <div className="flex justify-end">
                <Button disabled={!canAddMedication} onClick={addMedication} size="sm" type="button" variant="outline">
                  <PlusIcon data-icon="inline-start" />{messages.addMedication}
                </Button>
              </div>
              {items.map((item, index) => {
                const suffix = index === 0 ? '' : ` ${index + 1}`
                const selectedMedication = catalog.find(medication => medication.id === item.catalogItemId)
                const medicationItems = catalog
                  .filter(candidate => (
                    candidate.id === item.catalogItemId
                    || (!usedCatalogItemIds.has(candidate.id) && canCombineWithCurrentItems(candidate, index))
                  ))
                  .map(medication => ({
                    label: locale === 'zh-CN' ? medication.nameZh : medication.nameEn,
                    value: medication.id,
                  }))
                const doseItems = selectedMedication?.allowedDoseTexts.map(value => ({ label: value, value })) ?? []
                const frequencyItems = selectedMedication?.allowedFrequencyCodes.map(value => ({ label: value, value })) ?? []
                const courseItems = selectedMedication?.allowedCourseDays.map(value => ({
                  label: `${value} ${messages.days}`,
                  value: String(value),
                })) ?? []
                const quantityItems = selectedMedication?.allowedQuantities.map(value => ({
                  label: String(value),
                  value: String(value),
                })) ?? []
                return (
                  <FieldSet className="border-b pb-4" key={item.key}>
                    <FieldLegend variant="label">{messages.medication} {index + 1}</FieldLegend>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[minmax(12rem,1.4fr)_minmax(7rem,0.8fr)_minmax(7rem,0.8fr)_minmax(6rem,0.7fr)_minmax(6rem,0.7fr)_auto]">
                      <Field>
                        <FieldLabel htmlFor={`prescription-medication-${index}`}>{messages.medication}{suffix}</FieldLabel>
                        {item.referenceProduct === undefined ? <WorkspaceSelect
                          id={`prescription-medication-${index}`}
                          items={medicationItems}
                          onValueChange={value => {
                            const medication = catalog.find(candidate => candidate.id === value)
                            if (medication === undefined) return
                            updateItem(index, createPrescriptionDraftLine(medication, item.key))
                          }}
                          value={item.catalogItemId}
                        /> : <Input id={`prescription-medication-${index}`} readOnly value={item.referenceProduct.genericName} />}
                      </Field>
                      <Field>
                        <FieldLabel htmlFor={`prescription-dose-${index}`}>{messages.dose}{suffix}</FieldLabel>
                        {item.referenceProduct === undefined ? <WorkspaceSelect
                          id={`prescription-dose-${index}`}
                          items={doseItems}
                          onValueChange={value => {
                            if (value !== null) updateItem(index, { doseText: value })
                          }}
                          value={item.doseText}
                        /> : <Input id={`prescription-dose-${index}`} maxLength={120} onChange={event => updateItem(index, { doseText: event.currentTarget.value })} value={item.doseText} />}
                      </Field>
                      <Field>
                        <FieldLabel htmlFor={`prescription-frequency-${index}`}>{messages.frequency}{suffix}</FieldLabel>
                        {item.referenceProduct === undefined ? <WorkspaceSelect
                          id={`prescription-frequency-${index}`}
                          items={frequencyItems}
                          onValueChange={value => {
                            if (value !== null) updateItem(index, { frequencyCode: value })
                          }}
                          value={item.frequencyCode}
                        /> : <Input id={`prescription-frequency-${index}`} maxLength={32} onChange={event => updateItem(index, { frequencyCode: event.currentTarget.value })} value={item.frequencyCode} />}
                      </Field>
                      <Field>
                        <FieldLabel htmlFor={`prescription-course-${index}`}>{messages.course}{suffix}</FieldLabel>
                        {item.referenceProduct === undefined ? <WorkspaceSelect
                          id={`prescription-course-${index}`}
                          items={courseItems}
                          onValueChange={value => {
                            if (value !== null) updateItem(index, { courseDays: Number(value) })
                          }}
                          value={String(item.courseDays)}
                        /> : <Input id={`prescription-course-${index}`} max={30} min={1} onChange={event => updateItem(index, { courseDays: Number(event.currentTarget.value) })} type="number" value={item.courseDays} />}
                      </Field>
                      <Field>
                        <FieldLabel htmlFor={`prescription-quantity-${index}`}>{messages.quantity}{suffix}</FieldLabel>
                        {item.referenceProduct === undefined ? <WorkspaceSelect
                          id={`prescription-quantity-${index}`}
                          items={quantityItems}
                          onValueChange={value => {
                            if (value !== null) updateItem(index, { quantity: Number(value) })
                          }}
                          value={String(item.quantity)}
                        /> : <Input id={`prescription-quantity-${index}`} max={1_000} min={1} onChange={event => updateItem(index, { quantity: Number(event.currentTarget.value) })} type="number" value={item.quantity} />}
                      </Field>
                      <div className="flex items-end">
                        <Button
                          aria-label={`${messages.removeMedication}${suffix}`}
                          disabled={items.length === 1}
                          onClick={() => {
                            setItems(current => current.filter((_, itemIndex) => itemIndex !== index))
                            setDirty(true)
                          }}
                          size="icon"
                          title={`${messages.removeMedication}${suffix}`}
                          type="button"
                          variant="ghost"
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                    </div>
                  </FieldSet>
                )
              })}
              <div className="flex flex-wrap justify-end gap-2">
                <Button disabled={saveDraft.isPending || items.length === 0} type="submit" variant="outline">
                  <ClipboardPenIcon data-icon="inline-start" />{messages.savePrescriptionDraft}
                </Button>
                {state?.draft === undefined ? null : (
                  <>
                    <AlertDialog>
                      <AlertDialogTrigger
                        render={(
                          <Button
                            disabled={removeDraft.isPending || issue.isPending}
                            type="button"
                            variant="ghost"
                          />
                        )}
                      >
                        <Trash2Icon data-icon="inline-start" />{messages.deletePrescriptionDraft}
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{messages.deletePrescriptionDraftTitle}</AlertDialogTitle>
                          <AlertDialogDescription>{messages.deletePrescriptionDraftDescription}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <ul className="flex flex-col gap-1.5 text-sm">
                          {state.draft.items.map((item) => {
                            const medication = catalog.find(candidate => candidate.id === item.catalogItemId)
                            return (
                              <li className="flex flex-wrap justify-between gap-2" key={item.catalogItemId}>
                                <span className="font-medium">
                                  {(locale === 'zh-CN' ? medication?.nameZh : medication?.nameEn)
                                    ?? item.referenceProduct?.genericName
                                    ?? item.catalogItemId}
                                </span>
                                <span className="text-muted-foreground">
                                  {messages.quantity} {item.quantity}
                                </span>
                              </li>
                            )
                          })}
                        </ul>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
                          <AlertDialogAction
                            disabled={removeDraft.isPending}
                            onClick={() => removeDraft.mutate(detail.caseId)}
                            variant="destructive"
                          >
                            <Trash2Icon data-icon="inline-start" />{messages.confirmDelete}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                    <Button
                      disabled={dirty || issue.isPending || saveDraft.isPending}
                      onClick={() => issue.mutate()}
                      type="button"
                    >
                      <PillIcon data-icon="inline-start" />{messages.issuePrescription}
                    </Button>
                  </>
                )}
              </div>
              {saveDraft.isSuccess && state?.draft !== undefined ? (
                <Alert>
                  <CheckIcon aria-hidden="true" />
                  <AlertTitle>{messages.prescriptionDraftSaved}</AlertTitle>
                </Alert>
              ) : null}
              {removeDraft.data !== undefined
                && removeDraft.variables === detail.caseId
                && state?.draft === undefined
                && state?.draftVersion === removeDraft.data.data.draftVersion ? (
                <Alert>
                  <CheckIcon aria-hidden="true" />
                  <AlertTitle>{messages.prescriptionDraftDeleted}</AlertTitle>
                </Alert>
              ) : null}
              {saveDraft.error === null ? null : (
                <ErrorAlert
                  message={getWorkspaceErrorMessage(saveDraft.error, messages)}
                  title={getWorkspaceErrorTitle(saveDraft.error, messages, messages.operationFailed)}
                />
              )}
              {removeDraft.error === null || removeDraft.variables !== detail.caseId ? null : (
                <ErrorAlert
                  message={getWorkspaceErrorMessage(removeDraft.error, messages)}
                  title={getWorkspaceErrorTitle(removeDraft.error, messages, messages.operationFailed)}
                />
              )}
              {issue.error === null ? null : (
                <ErrorAlert
                  message={getPrescriptionIssueErrorMessage(issue.error, messages)}
                  title={getWorkspaceErrorTitle(issue.error, messages, messages.operationFailed)}
                />
              )}
            </FieldGroup>
          </form>
        ) : null}

      {!readOnly
        && noMedicationConclusion === undefined
        && !hasActivePrescription
        && mode === 'no-medication' ? (
          <div className="flex flex-col items-end gap-3">
            <Button disabled={confirmNone.isPending} onClick={() => confirmNone.mutate()} type="button">
              <CircleXIcon data-icon="inline-start" />{messages.confirmNoMedication}
            </Button>
            {confirmNone.error === null ? null : (
              <ErrorAlert
                message={getWorkspaceErrorMessage(confirmNone.error, messages)}
                title={getWorkspaceErrorTitle(confirmNone.error, messages, messages.operationFailed)}
              />
            )}
          </div>
        ) : null}
    </section>
  )
}

function prescriptionStatusLabel(
  status: 'dispensed' | 'paid' | 'signed' | 'withdrawn',
  messages: ReturnType<typeof getWorkspaceMessages>,
): string {
  if (status === 'signed') return messages.prescriptionStatus_signed
  if (status === 'paid') return messages.prescriptionStatus_paid
  if (status === 'dispensed') return messages.prescriptionStatus_dispensed
  return messages.prescriptionStatus_withdrawn
}

function getPrescriptionIssueErrorMessage(
  error: Error,
  messages: ReturnType<typeof getWorkspaceMessages>,
): string {
  if (
    error instanceof ApiClientError
    && (error.code === 'CATALOG_CONFLICT' || error.code === 'WORKFLOW_CONFLICT')
  ) {
    return messages.prescriptionIssueConflictDescription
  }
  return getWorkspaceErrorMessage(error, messages)
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
    const firstMedication = catalog.medications[0]
    return firstMedication === undefined ? [] : [{
      catalogItemId: firstMedication.id,
      doseText: firstMedication.defaultDoseText,
      frequencyCode: firstMedication.defaultFrequencyCode,
      key: 'new-0',
      quantity: '1',
    }]
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
    const firstMedication = catalog.medications[0]
    if (firstMedication === undefined) return
    setMedications(current => [...current, {
      catalogItemId: firstMedication.id,
      doseText: firstMedication.defaultDoseText,
      frequencyCode: firstMedication.defaultFrequencyCode,
      key: `new-${current.length}`,
      quantity: '1',
    }])
  }

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
          const selectedMedication = catalog.medications.find(item => item.id === line.catalogItemId)
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
                    const selected = catalog.medications.find(item => item.id === value)
                    if (selected === undefined) return
                    updateMedication(index, {
                      catalogItemId: selected.id,
                      doseText: selected.defaultDoseText,
                      frequencyCode: selected.defaultFrequencyCode,
                    })
                  }}
                  value={line.catalogItemId}
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
                <Button aria-label={`${messages.removeMedication}${suffix}`} disabled={medications.length === 1} onClick={() => setMedications(current => current.filter((_, itemIndex) => itemIndex !== index))} size="icon" title={`${messages.removeMedication}${suffix}`} type="button" variant="ghost"><Trash2Icon /></Button>
              </div>
            </div>
          )
        })}
        <div className="sticky bottom-0 flex justify-end border-t bg-background py-3">
          <Button disabled={pending || medications.length === 0} type="submit"><ClipboardPenIcon data-icon="inline-start" />{messages.saveRevisitDraft}</Button>
        </div>
      </FieldGroup>
    </form>
  )
}

function laboratoryResultName(
  code: string,
  messages: ReturnType<typeof getWorkspaceMessages>,
  fallback = code,
): string {
  if (code === '80382-5') return messages.resultCode_803825
  if (code === '6690-2') return messages.resultCode_66902
  if (code === '718-7') return messages.resultCode_7187
  if (code === '777-3') return messages.resultCode_7773
  if (code === '1988-5') return messages.resultCode_19885
  return fallback
}

function indicationLabel(code: string, messages: ReturnType<typeof getWorkspaceMessages>): string {
  return code === 'fever' ? messages.indication_fever : code
}

function laboratoryRequestStatusLabel(
  request: LaboratoryRequest,
  messages: ReturnType<typeof getWorkspaceMessages>,
): string {
  if (request.status === 'issued') return messages.laboratoryRequestStatus_issued
  if (request.status === 'accepted') return messages.laboratoryRequestStatus_accepted
  if (request.status === 'in-progress') return messages.laboratoryRequestStatus_inProgress
  if (request.status === 'reported') return messages.laboratoryRequestStatus_reported
  if (request.status === 'acknowledged') return messages.laboratoryRequestStatus_acknowledged
  if (request.status === 'generation-failed') return messages.laboratoryRequestStatus_generationFailed
  return messages.laboratoryRequestStatus_cancelled
}

function laboratoryResultValue(
  value: boolean | number | string,
  unit: string | undefined,
  locale: WorkspaceLocale,
  messages: ReturnType<typeof getWorkspaceMessages>,
): string {
  if (typeof value === 'boolean') return value ? messages.positive : messages.negative
  const formatted = typeof value === 'number' ? new Intl.NumberFormat(locale).format(value) : value
  return unit === undefined ? formatted : `${formatted} ${unit}`
}

function isQuantitativeLaboratoryResult(
  result: LaboratoryReport['results'][number],
): result is Extract<LaboratoryReport['results'][number], { value: number }> {
  return typeof result.value === 'number' && 'unit' in result
}

function interpretationLabel(code: string, messages: ReturnType<typeof getWorkspaceMessages>): string {
  if (code === 'H' || code === 'high') return messages.abnormalHigh
  if (code === 'L' || code === 'low') return messages.abnormalLow
  if (code === 'N' || code === 'normal') return messages.normal
  if (code === 'POS') return messages.positive
  return messages.abnormal
}

function PatientAvatar({ className = 'size-12', label, name }: {
  className?: string
  label: string
  name: string
}): React.JSX.Element {
  return (
    <Avatar aria-label={label} className={className} role="img">
      <AvatarFallback className="bg-info/15 font-semibold text-info">
        {name.slice(0, 1)}
      </AvatarFallback>
    </Avatar>
  )
}

function VirtualPatientRow({ item, messages, onSelect, selected }: {
  item: VirtualPatientList['items'][number]
  messages: ReturnType<typeof getWorkspaceMessages>
  onSelect: () => void
  selected: boolean
}): React.JSX.Element {
  return (
    <Button
      aria-label={`${messages.selectVirtualPatient} ${item.name}`}
      aria-pressed={selected}
      className={`h-auto min-h-16 w-full justify-start gap-3 px-2 py-2 text-left ${selected
        ? 'rounded-md border border-primary/30 bg-primary/5'
        : 'rounded-none border-b'}`}
      onClick={onSelect}
      type="button"
      variant="ghost"
    >
      <PatientAvatar className="size-9" label={`${item.name} ${messages.patient}`} name={item.name} />
      <span className="min-w-0">
        <span className="block truncate font-medium">{item.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{item.presentation.chiefComplaint}</span>
      </span>
    </Button>
  )
}

function VitalSummary({ label, value }: { label: string; value: number | string }): React.JSX.Element {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}

function DoctorCaseRow({ item, messages, onSelect, selected }: {
  item: DoctorQueueItem
  messages: ReturnType<typeof getWorkspaceMessages>
  onSelect: () => void
  selected: boolean
}): React.JSX.Element {
  return (
    <Button aria-label={`${messages.selectCase} ${item.patient.name}`} className={`h-auto min-h-16 w-full justify-between gap-3 px-2 py-2 text-left ${selected ? 'rounded-md border border-primary/30 bg-primary/5' : 'rounded-none border-b'}`} onClick={onSelect} role="listitem" type="button" variant="ghost">
      <span className="flex min-w-0 items-center gap-3"><PatientAvatar className="size-9" label={`${item.patient.name} ${messages.patient}`} name={item.patient.name} /><span className="min-w-0"><span className="block truncate font-medium">{item.patient.name}</span><span className="block truncate text-xs text-muted-foreground">{item.presentation.chiefComplaint}</span></span></span>
      <Badge className="shrink-0" variant="outline">{statusLabel(item.status, messages)}</Badge>
    </Button>
  )
}

function statusLabel(status: string, messages: ReturnType<typeof getWorkspaceMessages>): string {
  if (status === 'awaiting-doctor') return messages.status_awaitingDoctor
  if (status === 'first-visit') return messages.status_firstVisit
  if (status === 'awaiting-report') return messages.status_awaitingReport
  if (status === 'awaiting-revisit') return messages.status_awaitingRevisit
  if (status === 'revisit-draft') return messages.status_revisitDraft
  return status
}

function ErrorAlert({ message, title }: { message: string; title: string }): React.JSX.Element {
  return <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{title}</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>
}
