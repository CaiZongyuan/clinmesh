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
import type { ReferenceMedicationProduct } from '@clinmesh/contracts/reference-data'
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
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Spinner } from '@clinmesh/ui/components/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRightIcon, CheckCircleIcon, CheckIcon, CircleAlertIcon, CircleXIcon, ClipboardCheckIcon, ClipboardListIcon, ClipboardPenIcon, FileSignatureIcon, FlaskConicalIcon, LibraryBigIcon, MessagesSquareIcon, PillIcon, PlayIcon, PlusIcon, RefreshCwIcon, RotateCcwIcon, StethoscopeIcon, TestTubesIcon, Trash2Icon, UserRoundPlusIcon } from 'lucide-react'
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
import { PaginationControls } from '../pagination-controls.tsx'
import {
  getWorkspaceErrorMessage,
  getWorkspaceErrorTitle,
} from '../workspace-error.ts'
import { formatFen } from '../workspace-format.ts'
import { WorkspaceSelect } from '../workspace-select.tsx'
import {
  MedicationCatalogDialog,
  type MedicationCatalogSelection,
} from './catalog-picker-dialogs.tsx'
import {
  DoctorCaseContextRail,
  type DoctorCaseSection,
} from './case-context-rail.tsx'
import { ClinicalDocumentPage } from './clinical-document-page.tsx'
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
import { PrescriptionPage } from './prescription-page.tsx'

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

type EncounterCompletionQueryScope = readonly ['encounter-completion', string, string]

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
        <DoctorCaseController
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

function DoctorCaseController({
  correctionNavigation,
  locale,
  onCorrectionNavigationHandled,
  onSelectedCaseIdChange,
  selectedCaseId,
  session,
}: DoctorCaseControllerProps): React.JSX.Element {
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
  const saveCaseDiagnosis = useMutation({
    mutationFn: (entries: DiagnosisDraftEntry[]) => {
      const current = detail.data
      if (current === undefined) throw new Error(messages.consultationUnavailable)
      return saveDiagnosisDraft({
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        entries,
        expectedDraftVersion: current.diagnosis?.draftVersion ?? 0,
      }, newIdempotencyKey())
    },
    onSuccess: refreshCase,
  })
  const confirmCaseDiagnosis = useMutation({
    mutationFn: () => {
      const current = detail.data
      if (current?.diagnosis?.draft === undefined) {
        throw new Error(messages.consultationUnavailable)
      }
      return confirmDiagnosis({
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        expectedDraftVersion: current.diagnosis.draftVersion,
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
                onSubmit: () => confirmCaseDiagnosis.mutate(),
                pending: confirmCaseDiagnosis.isPending,
              },
              save: {
                error: saveCaseDiagnosis.error,
                onSubmit: entries => saveCaseDiagnosis.mutate(entries),
                pending: saveCaseDiagnosis.isPending,
                success: saveCaseDiagnosis.isSuccess,
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
    <div className={contextRailOpen
      ? 'grid min-w-0 overflow-hidden border bg-background 2xl:grid-cols-[minmax(0,1fr)_300px]'
      : 'grid min-w-0 overflow-hidden border bg-background 2xl:grid-cols-[minmax(0,1fr)_2.75rem]'}>
      <div className="flex min-w-0 flex-col">
        <PatientBanner
          {...(readOnly || detail.consultation === undefined
            ? {}
            : {
                completionAction: (
                  <EncounterCompletionPanel
                    detail={detail}
                    messages={messages}
                    onCompleted={onEncounterCompleted}
                    onNavigate={navigateToCompletionTarget}
                    onRefresh={onRefreshCase}
                    queryScope={completionQueryScope}
                  />
                ),
              })}
          detail={detail}
          messages={messages}
          statusText={doctorCaseStatusLabel(detail.status, messages)}
        />

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
                <TabsTrigger value="consultation"><MessagesSquareIcon aria-hidden="true" />{messages.consultationRecord}</TabsTrigger>
              )}
              <TabsTrigger value="record"><ClipboardListIcon aria-hidden="true" />{messages.medicalRecord}</TabsTrigger>
              <TabsTrigger value="laboratory"><TestTubesIcon aria-hidden="true" />{messages.laboratoryAndExamination}</TabsTrigger>
              <TabsTrigger value="diagnosis"><StethoscopeIcon aria-hidden="true" />{messages.diagnosis}</TabsTrigger>
              <TabsTrigger value="prescription"><PillIcon aria-hidden="true" />{messages.prescription}</TabsTrigger>
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
                readOnly={readOnly}
              />
            </TabsContent>
          )}

          <TabsContent className="p-4" value="record">
            <div className="flex flex-col gap-4">
              {overviewWorkflow}
              <div className="min-w-0">
                {detail.consultation === undefined ? firstVisitRecord : (
                  <ClinicalDocumentPage
                    allowRevision={!readOnly || correctionTarget === 'clinical-document'}
                    detail={detail}
                    elementId={encounterCompletionTargetElementIds['clinical-document']}
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
              <DiagnosisPage
                actions={diagnosisActions}
                catalog={catalog.data.diagnoses}
                elementId={encounterCompletionTargetElementIds.diagnosis}
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
              <PrescriptionPage
                allowWithdrawal={!readOnly || correctionTarget === 'medication-conclusion'}
                catalog={catalog.data.medications}
                detail={detail}
                elementId={encounterCompletionTargetElementIds['medication-conclusion']}
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
              locale={locale}
              messages={messages}
              onIndicationChange={onIndicationChange}
              onIssueLegacyOrder={onIssueOrder}
              onLaboratoryItemChange={onLaboratoryItemChange}
              readOnly={readOnly}
              showCorrection={correctionTarget === 'laboratory'}
            />
          </TabsContent>
        </Tabs>
      </div>

      <DoctorCaseContextRail
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

function ErrorAlert({ message, title }: { message: string; title: string }): React.JSX.Element {
  return <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{title}</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>
}
