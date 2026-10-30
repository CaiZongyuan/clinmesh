import { doctorCaseSectionSchema, type DoctorCaseSection } from '@clinmesh/contracts/agent'
import {
  doctorQueueViewStatusGroups,
  type ClinicalDocumentContent,
  type DiagnosisDraftEntry,
  type DoctorCaseDetail,
  type EncounterCompletionTarget,
  type LaboratoryRequest
} from '@clinmesh/contracts/his'
import { mergeDocumentText } from '@clinmesh/core/document-text'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAgentReview } from '../agent-review.tsx'
import {
  ApiClientError,
  acknowledgeLaboratoryReport,
  cancelLaboratoryRequest,
  cancelStructuredClinicalDocumentSign,
  completeEncounter,
  confirmDiagnosis,
  confirmNoMedication,
  controlConsultationRecording,
  correctLaboratoryReport,
  deleteLaboratoryRequestDraft,
  deletePrescriptionDraft,
  getClinicalCatalog,
  getDoctorCase,
  getDoctorQueue,
  getEncounterCompletion,
  issueLaboratoryOrder,
  issueLaboratoryRequest,
  issuePrescription,
  newIdempotencyKey,
  previewClinicalSign,
  previewStructuredClinicalDocumentSign,
  retryConsultationReply,
  retryLaboratoryResultGeneration,
  reviseStructuredClinicalDocument,
  saveClinicalDocumentDraft,
  saveDiagnosisDraft,
  saveFirstVisitDraft,
  saveLaboratoryRequestDraft,
  savePrescriptionDraft,
  saveRevisitDraft,
  searchReferenceDiagnoses,
  searchReferenceLaboratory,
  searchReferenceMedications,
  sendConsultationMessage,
  signClinicalDocument,
  signStructuredClinicalDocument,
  startFirstVisit,
  startRevisit,
  subscribeRecordingUpdates,
  withdrawPrescription
} from '../api-client.ts'
import { useWorkspaceCardView } from '../workspace-card-layout.tsx'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import type { ReferenceCatalogSearches } from './catalog-picker-dialogs.tsx'
import { createWorkingClinicalDocument } from './clinical-document-content.ts'
import {
  type ClinicalDocumentRevisionInput,
  type ClinicalDocumentSignPreview
} from './clinical-document-page.tsx'
import { useClinicalDocumentUpdates } from './clinical-document-updates.tsx'
import { caseInvestigationRequests, isAwaitingResult, isLaboratoryRequestCatalogItemId, type DoctorAgentDraftHydrationRevisions, type DoctorAgentDraftKind, type DoctorCaseControllerProps, type InvestigationCategory, type InvestigationView, type ReferenceCatalogSearchParameters } from './doctor-case-support.tsx'
import { useImagingViewState } from './imaging-page.tsx'
import {
  type LaboratoryReportCorrectionInput
} from './laboratory-page.tsx'

export function useDoctorCaseModel({
  navigation,
  queueView,
  onQueueViewChange,
  correctionNavigation,
  locale,
  onCorrectionNavigationHandled,
  onSelectedCaseIdChange,
  selectedCaseId,
  session,
}: DoctorCaseControllerProps) {
  const messages = getWorkspaceMessages(locale)
  const agentReview = useAgentReview()
  const queryClient = useQueryClient()
  const scope = useMemo(() => [session.actor.workspaceId, session.actor.epoch, session.actor.actorId, session.actor.practitionerRoleId] as const,
    [session.actor.workspaceId, session.actor.epoch, session.actor.actorId, session.actor.practitionerRoleId])
  const [page, setPage] = useState(1)
  const [lastQueueView, setLastQueueView] = useState(queueView)
  if (lastQueueView !== queueView) {
    setLastQueueView(queueView)
    setPage(1)
  }
  const sectionView = useWorkspaceCardView('doctor-case-section')
  const parsedSection = doctorCaseSectionSchema.safeParse(sectionView.tab)
  const activeCaseSection = parsedSection.success ? parsedSection.data : 'record'
  const setActiveCaseSection = useCallback((section: DoctorCaseSection) => sectionView.setTab(section), [sectionView.setTab])
  const [completionNavigate, setCompletionNavigate] = useState<((target: EncounterCompletionTarget) => void) | undefined>()
  const setCompletionNavigateStable = useCallback(
    (navigate: (target: EncounterCompletionTarget) => void) => {
      setCompletionNavigate((current: ((target: EncounterCompletionTarget) => void) | undefined) =>
        current === navigate ? current : navigate)
    },
    [],
  )
  const caseDetailRoot = useRef<HTMLElement>(null)
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
  const encounterCompletionScopeKey = ['encounter-completion', ...scope] as const
  const completedCaseListScopeKey = ['doctor-completed-cases', ...scope] as const
  const completedCaseDetailScopeKey = ['doctor-completed-case', ...scope] as const
  const queue = useQuery({
    queryFn: ({ signal }) => getDoctorQueue(signal, page),
    queryKey: queueKey,
    refetchInterval: query => query.state.data?.items.some(item => item.status === 'awaiting-report') === true
      ? 1_500
      : false,
  })
  const visibleQueue = useQuery({
    queryFn: ({ signal }) => getDoctorQueue(signal, page, queueView),
    queryKey: ['doctor-queue', ...scope, queueView, page],
    refetchInterval: query => query.state.data?.items.some(item => item.status === 'awaiting-report') === true
      ? 1_500
      : false,
  })
  const [laboratoryItemId, setLaboratoryItemId] = useState<string>()
  const [indicationCode, setIndicationCode] = useState('')
  const [workingClinicalDocuments, setWorkingClinicalDocuments] = useState<
    Record<string, ClinicalDocumentContent>
  >({})
  const clinicalDocumentBaselines = useRef<Record<string, {
    document: ClinicalDocumentContent
    persisted: ClinicalDocumentContent | undefined
    recordedAdditionIds: ReadonlySet<string>
  }>>({})
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
  const activeCaseId = selectedCaseId ?? visibleQueue.data?.items[0]?.caseId
  const activeCaseIdRef = useRef(activeCaseId)
  activeCaseIdRef.current = activeCaseId
  const [investigationSelection, setInvestigationSelection] = useState<InvestigationView>()
  const selectInvestigation = useCallback((category: InvestigationCategory, requestId?: string, reportId?: string): void => {
    if (activeCaseId === undefined || activeCaseIdRef.current !== activeCaseId) return
    setInvestigationSelection(previous => {
      const selected = previous?.caseId === activeCaseId ? previous.selected : {}
      return { caseId: activeCaseId, category, selected: requestId === undefined ? selected : { ...selected, [category]: requestId }, reportId }
    })
  }, [activeCaseId])
  const selectInvestigationRequest = useCallback((category: InvestigationCategory, requestId: string): void => {
    if (activeCaseId === undefined || activeCaseIdRef.current !== activeCaseId) return
    setInvestigationSelection(previous => {
      const current = previous?.caseId === activeCaseId ? previous : undefined
      return {
        caseId: activeCaseId,
        category: current?.category ?? 'laboratory',
        selected: { ...current?.selected, [category]: requestId },
        reportId: current?.category === category ? undefined : current?.reportId,
      }
    })
  }, [activeCaseId])
  const pageScope = JSON.stringify([session.actor.workspaceId, session.actor.epoch, session.actor.actorId, session.actor.practitionerRoleId, activeCaseId])
  const pageScopeRef = useRef(pageScope)
  pageScopeRef.current = pageScope
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const imagingView = useImagingViewState(activeCaseId ?? '')
  const selectedCase = visibleQueue.data?.items.find(item => item.caseId === activeCaseId)
  const detailKey = [
    'doctor-case',
    ...scope,
    activeCaseId,
    selectedCase?.diagnosticReportId,
  ] as const
  const [recordingNotificationCase, setRecordingNotificationCase] = useState<string>()
  const detail = useQuery({
    enabled: activeCaseId !== undefined,
    queryFn: ({ signal }) => getDoctorCase(activeCaseId ?? '', signal),
    queryKey: detailKey,
    // 检验、放射与病理申请在后台执行：有申请尚未出结果时持续刷新，报告到达后页面自行更新。
    refetchInterval: query => selectedCase?.status === 'awaiting-report'
      || (
        query.state.data?.laboratoryRequests?.reportingSupported === true
        && query.state.data.laboratoryRequests.requests.some(isAwaitingResult)
      )
      || query.state.data?.imagingRequests?.requests.some(isAwaitingResult) === true
      || query.state.data?.pathologyRequests?.requests.some(isAwaitingResult) === true
      || query.state.data?.consultation?.replyAttempt?.status === 'executing'
      || query.state.data?.consultation?.replyAttempt?.status === 'blocked'
      || (query.state.data?.consultationRecording !== undefined && query.state.data.encounter.status === 'in-progress'
        && (recordingNotificationCase !== activeCaseId || query.state.status === 'error'))
      ? 1_500
      : false,
  })
  useEffect(() => {
    if (activeCaseId === undefined) return
    return subscribeRecordingUpdates(activeCaseId, () => {
      void queryClient.invalidateQueries({ queryKey: ['doctor-case', ...scope, activeCaseId] })
    }, connected => {
      setRecordingNotificationCase(current => connected ? activeCaseId : current === activeCaseId ? undefined : current)
    })
  }, [activeCaseId, queryClient, scope])
  const investigationView = useMemo<InvestigationView>(() => {
    const view = investigationSelection?.caseId === activeCaseId ? investigationSelection : undefined
    const groups = caseInvestigationRequests(detail.data)
    const selected: InvestigationView['selected'] = {}
    for (const category of ['laboratory', 'imaging', 'pathology'] as const) {
      const requests = groups[category]
      const request = requests.find(item => item.id === view?.selected[category]) ?? requests[0]
      if (request !== undefined) selected[category] = request.id
    }
    return {
    caseId: activeCaseId ?? '',
    category: view?.category ?? 'laboratory',
    selected,
    reportId: view?.reportId,
  }
  }, [activeCaseId, detail.data, investigationSelection])
  const detailUnavailable = detail.isError && (detail.data === undefined
    || !(detail.error instanceof ApiClientError)
    || (detail.error.status !== 0 && detail.error.status < 500))
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
    setLaboratoryItemId(undefined)
    setIndicationCode('')
    // 完诊纠错由详情页选择目标分区，不能被切例初始化覆盖。
    if (correctionNavigation?.caseId !== activeCaseId || correctionNavigation?.handled !== false) setActiveCaseSection('record')
  }, [activeCaseId, session.actor.epoch, session.actor.workspaceId])
  const catalog = useQuery({
    queryFn: ({ signal }) => getClinicalCatalog(signal),
    queryKey: ['clinical-catalog', ...scope],
  })
  const recommendationIdentity = JSON.stringify([pageScope, detail.data === undefined ? null : {
    encounter: detail.data.encounter, patient: detail.data.patient, presentation: detail.data.presentation,
    triage: detail.data.triage, allergies: detail.data.allergies, priorFacts: detail.data.priorFacts,
    turns: detail.data.consultation?.turns, clinicalDocument: detail.data.clinicalDocument,
    drafts: detail.data.drafts, diagnosis: detail.data.diagnosis, medicationConclusion: detail.data.medicationConclusion,
    report: detail.data.report, laboratoryRequests: detail.data.laboratoryRequests,
    imagingRequests: detail.data.imagingRequests, pathologyRequests: detail.data.pathologyRequests,
  }, catalog.data])
  const recommendationInput = useRef({ identity: recommendationIdentity, revision: 0 })
  if (recommendationInput.current.identity !== recommendationIdentity) {
    recommendationInput.current = { identity: recommendationIdentity, revision: recommendationInput.current.revision + 1 }
  }
  const recommendationRevision = String(recommendationInput.current.revision)
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
      onSearch: (query, searchPage) => {
        if (diagnosisReferenceSearch.enabled && diagnosisReferenceSearch.query === query && diagnosisReferenceSearch.page === searchPage) {
          void referenceDiagnoses.refetch()
        } else {
          setDiagnosisReferenceSearch({ enabled: true, page: searchPage, query })
        }
      },
    },
    laboratory: {
      data: referenceLaboratory.data,
      error: referenceLaboratory.error,
      isError: referenceLaboratory.isError,
      isFetching: referenceLaboratory.isFetching,
      isPending: referenceLaboratory.isPending,
      onSearch: (query, searchPage) => {
        if (laboratoryReferenceSearch.enabled && laboratoryReferenceSearch.query === query && laboratoryReferenceSearch.page === searchPage) {
          void referenceLaboratory.refetch()
        } else {
          setLaboratoryReferenceSearch({ enabled: true, page: searchPage, query })
        }
      },
    },
    medications: {
      data: referenceMedications.data,
      error: referenceMedications.error,
      isError: referenceMedications.isError,
      isFetching: referenceMedications.isFetching,
      isPending: referenceMedications.isPending,
      onSearch: (query, searchPage) => {
        if (medicationReferenceSearch.enabled && medicationReferenceSearch.query === query && medicationReferenceSearch.page === searchPage) {
          void referenceMedications.refetch()
        } else {
          setMedicationReferenceSearch({ enabled: true, page: searchPage, query })
        }
      },
    },
  }
  const persistedClinicalDocumentVersion = detail.data?.clinicalDocument?.draft?.version
    ?? detail.data?.clinicalDocument?.signed.at(-1)?.revisionNumber
  useEffect(() => {
    const currentDetail = detail.data
    if (currentDetail === undefined) return
    const next = createWorkingClinicalDocument(currentDetail)
    const previous = clinicalDocumentBaselines.current[currentDetail.caseId]
    clinicalDocumentBaselines.current[currentDetail.caseId] = {
      document: next,
      persisted: currentDetail.clinicalDocument?.draft ?? currentDetail.clinicalDocument?.signed.at(-1)?.content,
      recordedAdditionIds: new Set(currentDetail.consultationRecording?.additions.map(addition => addition.id)),
    }
    setWorkingClinicalDocuments(current => {
      const working = current[currentDetail.caseId]
      const merged = { ...next }
      if (working !== undefined && previous !== undefined) {
        for (const field of Object.keys(next) as Array<keyof ClinicalDocumentContent>) {
          const newlyRecorded = currentDetail.consultationRecording?.additions.some(addition => addition.status === 'applied'
            && addition.ownership === 'automatic' && addition.field === field && !previous.recordedAdditionIds.has(addition.id))
          const firstAutomaticContent = currentDetail.consultationRecording?.hasSavedDraft === false
            && !previous.persisted?.[field]
            && currentDetail.consultationRecording.additions.some(addition => addition.status === 'applied' && addition.field === field)
          // 预填尚未持久化，首批自动内容来自空字段，应追加到已经改写的预填后。
          merged[field] = firstAutomaticContent && working[field] !== previous.document[field]
            ? [working[field], next[field]].filter(Boolean).join('\n')
            : mergeDocumentText(previous.document[field] ?? '', working[field] ?? '', next[field] ?? '', newlyRecorded ? '待核实补充：' : undefined)
        }
      }
      return {
    ...current,
    [currentDetail.caseId]: merged,
  }
    })
  }, [detail.data?.caseId, persistedClinicalDocumentVersion])
  const usesIndependentLaboratoryRequests = detail.data?.consultation !== undefined
  const laboratoryCatalog = catalog.data?.laboratory.filter(item => (
    usesIndependentLaboratoryRequests
      ? isLaboratoryRequestCatalogItemId(item.id)
      : item.id === 'lab-fever-panel'
  )) ?? []
  const draftLaboratoryItemId = detail.data?.laboratoryRequests?.draft?.catalogItemId
  const requestedLaboratoryItemId = laboratoryItemId ?? draftLaboratoryItemId
  const resolvedLaboratoryItemId = requestedLaboratoryItemId
    ?? (usesIndependentLaboratoryRequests ? '' : laboratoryCatalog[0]?.id)
    ?? ''
  const resolvedLaboratoryItem = laboratoryCatalog.find(item => item.id === resolvedLaboratoryItemId)
  const draftIndicationCode = detail.data?.laboratoryRequests?.draft?.catalogItemId === resolvedLaboratoryItemId
    ? detail.data.laboratoryRequests.draft.indicationCode
    : undefined
  const requestedIndicationCode = resolvedLaboratoryItem === undefined || resolvedLaboratoryItem.allowedIndicationCodes.includes(indicationCode)
    ? indicationCode || draftIndicationCode
    : draftIndicationCode
  const resolvedIndicationCode = resolvedLaboratoryItem === undefined
    ? requestedIndicationCode ?? (indicationCode || (resolvedLaboratoryItemId === '' ? '' : 'clinical-evaluation'))
    : resolvedLaboratoryItem.allowedIndicationCodes.includes(
      requestedIndicationCode ?? '',
    ) === true
      ? requestedIndicationCode ?? ''
      : resolvedLaboratoryItem?.allowedIndicationCodes[0] ?? ''
  const refreshCaseById = async (caseId: string | undefined) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['doctor-queue', ...scope] }),
      queryClient.invalidateQueries({
        queryKey: caseId === undefined
          ? ['doctor-case', ...scope]
          : ['doctor-case', ...scope, caseId],
        refetchType: caseId === undefined ? 'active' : 'all',
      }),
      queryClient.invalidateQueries({ queryKey: encounterCompletionScopeKey }),
    ])
    // 队列拥有分组；移出待诊时，详情的报告 key 可能已经变化。
    const current = queryClient.getQueryData<typeof queue.data>(queueKey)?.items.find(item => item.caseId === caseId)
    if (queueView === 'waiting' && activeCaseIdRef.current === caseId && current !== undefined
      && doctorQueueViewStatusGroups.active.includes(current.status)) {
      onSelectedCaseIdChange(current.caseId)
      onQueueViewChange('active')
    }
  }
  const refreshCompletedCaseDetails = async () => {
    await queryClient.invalidateQueries({ queryKey: completedCaseDetailScopeKey })
  }
  const applySignCancellation = async (caseId: string, previewId: string) => {
    const queryKey = ['doctor-case', ...scope, caseId]
    await queryClient.cancelQueries({ queryKey })
    queryClient.setQueriesData<DoctorCaseDetail>({ queryKey }, current => {
      if (current?.consultationRecording?.signingPreparation?.previewId !== previewId) return current
      const { signingPreparation: _preparation, ...recording } = current.consultationRecording
      return {
    ...current,
    consultationRecording: recording,
  }
    })
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
    onSuccess: async (response, variables) => {
      queryClient.setQueriesData<DoctorCaseDetail>({ queryKey: ['doctor-case', ...scope, variables.caseId] }, current => {
        if (current?.encounter.id !== response.data.encounterId) return current
        return { ...current, encounter: { ...current.encounter, status: response.data.status, versionId: response.data.encounterVersion } }
      })
      onSelectedCaseIdChange(variables.caseId)
      await Promise.all([
        refreshCaseById(variables.caseId),
        refreshCompletedCaseDetails(),
        queryClient.invalidateQueries({ queryKey: completedCaseListScopeKey }),
      ])
    },
  })
  const askQuestion = useMutation({
    onMutate: (): void => { retryPatientReply.reset() },
    mutationFn: ({ caseId, message }: { caseId: string; message: string }) => {
      const current = detail.data
      if (current?.caseId !== caseId || current.consultation === undefined) {
        throw new Error(messages.consultationUnavailable)
      }
      return sendConsultationMessage({
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        expectedConsultationVersion: current.consultation.version,
        message,
        taskId: current.taskId,
        taskVersion: current.taskVersion,
      }, newIdempotencyKey())
    },
    onError: async (_error, variables) => refreshCaseById(variables.caseId),
    onSuccess: async (_response, variables) => refreshCaseById(variables.caseId),
  })
  const retryPatientReply = useMutation({
    onMutate: (): void => { askQuestion.reset() },
    mutationFn: ({ caseId }: { caseId: string }) => {
      const current = detail.data
      if (current?.caseId !== caseId || current.consultation === undefined) {
        throw new Error(messages.consultationUnavailable)
      }
      return retryConsultationReply({
        encounterId: current.encounter.id,
        expectedConsultationVersion: current.consultation.version,
      }, newIdempotencyKey())
    },
    onSettled: async (_response, _error, variables) => refreshCaseById(variables.caseId),
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
    onMutate: ({ caseId }) => { onSelectedCaseIdChange(caseId) },
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
    onMutate: ({ caseId }) => { onSelectedCaseIdChange(caseId) },
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
    mutationFn: ({ caseId, override }: { caseId: string; override?: { catalogItemId: string; indicationCode: string } }) => {
      const current = detail.data
      const catalogItemId = override?.catalogItemId ?? resolvedLaboratoryItemId
      const indicationCode = override?.indicationCode ?? resolvedIndicationCode
      if (current?.caseId !== caseId
        || !isLaboratoryRequestCatalogItemId(catalogItemId)
        || indicationCode.length === 0) {
        throw new Error(messages.consultationUnavailable)
      }
      return saveLaboratoryRequestDraft({
        catalogItemId,
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        expectedDraftVersion: current.laboratoryRequests?.draftVersion ?? 0,
        indicationCode,
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
    onSuccess: async (response, variables) => {
      if (activeCaseIdRef.current === variables.caseId) {
        saveLaboratoryRequest.reset()
        setLaboratoryItemId('')
        setIndicationCode('')
        selectInvestigationRequest('laboratory', response.data.request.id)
      }
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
      if (activeCaseIdRef.current === caseId) {
        saveLaboratoryRequest.reset()
        setLaboratoryItemId('')
        setIndicationCode('')
      }
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
  const activatedRecordingCases = useRef(new Set<string>())
  const controlRecording = useMutation({
    mutationFn: ({ caseId, action }: { caseId: string; action: Parameters<typeof controlConsultationRecording>[0]['action'] }) => {
      const current = detail.data
      if (current?.caseId !== caseId) throw new Error(messages.consultationUnavailable)
      return controlConsultationRecording({
        action, encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId, expectedRecordingVersion: current.consultationRecording?.version ?? 0
      }, newIdempotencyKey())
    },
    onError: async (_error, variables) => refreshCaseById(variables.caseId),
    onSuccess: async (response, variables) => {
      const queryKey = ['doctor-case', ...scope, variables.caseId]
      await queryClient.cancelQueries({ queryKey })
      queryClient.setQueriesData<DoctorCaseDetail>({ queryKey }, current => {
        // Control versions do not advance with saved drafts, ownership or background progress.
        const recording = current?.consultationRecording
        const version = recording?.version ?? 0
        if (current === undefined || version > response.data.version) return current
        if (version === response.data.version) {
          if (variables.action !== 'activate' || recording === undefined
            || response.data.requiresContextBinding === undefined) return current
          return {
            ...current, consultationRecording: {
              ...recording,
              requiresContextBinding: response.data.requiresContextBinding,
              status: recording.requiresContextBinding === true && recording.status === 'idle'
                && recording.remainingCount > 0 && response.data.status === 'processing' ? 'processing' : recording.status
            }
          }
        }
        return {
    ...current,
    consultationRecording: response.data,
  }
      })
      await refreshCaseById(variables.caseId)
    },
  })
  useEffect(() => {
    const current = detail.data
    const recording = current?.consultationRecording
    const requiresBinding = recording?.requiresContextBinding === true
    if (current === undefined || current.status === 'awaiting-doctor'
      || current.encounter.status !== 'in-progress' || (current.clinicalDocument?.signed.length ?? 0) > 0
      || recording?.signingPreparation?.active === true
      || (!requiresBinding && ((current.consultation?.turns.length ?? 0) > 0
        || (recording !== undefined && (recording.version !== 0 || recording.status !== 'idle'))))) return
    const key = `${scope[0]}:${scope[1]}:${current.caseId}`
    if (activatedRecordingCases.current.has(key)) return
    activatedRecordingCases.current.add(key)
    controlRecording.mutate({ caseId: current.caseId, action: 'activate' })
  }, [detail.data, scope[0], scope[1], controlRecording.mutate])
  const saveDocumentDraft = useMutation({
    mutationFn: ({ caseId, document }: { caseId: string; document: ClinicalDocumentContent }) => {
      const current = detail.data
      if (current?.caseId !== caseId) throw new Error(messages.consultationUnavailable)
      return saveClinicalDocumentDraft({
        document, encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        expectedDraftVersion: current.clinicalDocument?.draft?.version ?? 0,
      }, newIdempotencyKey())
    },
    onError: async (_error, variables) => refreshCaseById(variables.caseId),
    onSuccess: async (_response, variables) => refreshCaseById(variables.caseId),
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
    onSuccess: async (_response, variables) => refreshCaseById(variables.caseId),
  })
  const cancelClinicalDocumentSign = useMutation({
    mutationFn: ({ caseId, previewId }: { caseId: string; previewId: string }) => {
      const current = detail.data
      if (current?.caseId !== caseId) throw new Error(messages.consultationUnavailable)
      return cancelStructuredClinicalDocumentSign({
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId, previewId
      },
        `cancel-sign:${session.actor.practitionerRoleId}:${previewId}:${current.encounter.versionId}`)
    },
    onSuccess: async (response, variables) => {
      await applySignCancellation(variables.caseId, response.data.previewId)
      if (prepareClinicalDocumentSign.data?.data.previewId === response.data.previewId) prepareClinicalDocumentSign.reset()
      await refreshCaseById(variables.caseId)
    },
    onError: async (_error, variables): Promise<void> => {
      const queryKey = ['doctor-case', ...scope, variables.caseId]
      try {
        await queryClient.refetchQueries({ queryKey }, { throwOnError: true })
      } catch { return }
      const current = queryClient.getQueriesData<DoctorCaseDetail>({ queryKey })
        .find(([key, value]) => value?.caseId === variables.caseId && queryClient.getQueryState(key)?.status === 'success')?.[1]
      if (current?.consultationRecording === undefined
        || current.consultationRecording.signingPreparation?.previewId === variables.previewId) return
      if (prepareClinicalDocumentSign.variables?.caseId === variables.caseId
        && prepareClinicalDocumentSign.data?.data.previewId === variables.previewId) prepareClinicalDocumentSign.reset()
      cancelClinicalDocumentSign.reset()
    },
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
  const persistedWorkingClinicalDocument = detail.data === undefined ? undefined : createWorkingClinicalDocument(detail.data)
  const currentClinicalDocument = detail.data === undefined
    ? undefined
    : workingClinicalDocuments[detail.data.caseId] ?? persistedWorkingClinicalDocument
  const hasUnsavedClinicalDocumentChanges = persistedWorkingClinicalDocument !== undefined && currentClinicalDocument !== undefined
    && (Object.keys(persistedWorkingClinicalDocument) as Array<keyof ClinicalDocumentContent>)
      .some(field => (currentClinicalDocument[field] ?? '') !== (persistedWorkingClinicalDocument[field] ?? ''))
  const clinicalDocumentUpdates = useClinicalDocumentUpdates(detail.data?.caseId, currentClinicalDocument,
    detail.data?.encounter.status === 'in-progress' && (detail.data.clinicalDocument?.signed.length ?? 0) === 0)
  const canCorrectReports = session.availableRoles.some(role => role.code === 'administrator')
  const runImagingAction = async <Result,>(caseId: string, action: () => Promise<Result>): Promise<Result> => {
    const result = await action()
    await refreshCaseById(caseId)
    return result
  }
  return {
    navigation,
    queueView,
    onQueueViewChange,
    correctionNavigation,
    locale,
    onCorrectionNavigationHandled,
    onSelectedCaseIdChange,
    session,
    messages,
    agentReview,
    scope,
    page,
    setPage,
    activeCaseSection,
    completionNavigate,
    setCompletionNavigateStable,
    caseDetailRoot,
    queue,
    visibleQueue,
    setLaboratoryItemId,
    setIndicationCode,
    workingClinicalDocuments,
    setWorkingClinicalDocuments,
    agentDraftHydrationRevisions,
    hydrateAgentDraft,
    activeCaseId,
    activeCaseIdRef,
    selectInvestigation,
    selectInvestigationRequest,
    pageScope,
    pageScopeRef,
    mountedRef,
    imagingView,
    detail,
    investigationView,
    detailUnavailable,
    completion,
    catalog,
    recommendationRevision,
    referenceCatalogSearches,
    usesIndependentLaboratoryRequests,
    laboratoryCatalog,
    resolvedLaboratoryItemId,
    resolvedLaboratoryItem,
    resolvedIndicationCode,
    refreshCaseById,
    applySignCancellation,
    completeCaseEncounter,
    askQuestion,
    retryPatientReply,
    signingDependencies,
    start,
    beginRevisit,
    saveDraft,
    issueOrder,
    saveLaboratoryRequest,
    issueRequest,
    deleteRequestDraft,
    cancelRequest,
    retryResultGeneration,
    acknowledgeReport,
    correctReport,
    controlRecording,
    saveDocumentDraft,
    prepareClinicalDocumentSign,
    cancelClinicalDocumentSign,
    signStructuredDocument,
    reviseClinicalDocument,
    savePrescription,
    removePrescriptionDraft,
    issueCasePrescription,
    confirmCaseNoMedication,
    withdrawCasePrescription,
    saveCaseDiagnosis,
    confirmCaseDiagnosis,
    saveRevisit,
    previewSign,
    completeSign,
    currentClinicalDocument,
    hasUnsavedClinicalDocumentChanges,
    clinicalDocumentUpdates,
    canCorrectReports,
    runImagingAction,
  }
}

export type DoctorCaseModel = ReturnType<typeof useDoctorCaseModel>
