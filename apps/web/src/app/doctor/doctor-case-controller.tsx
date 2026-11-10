import { cn } from '@clinmesh/ui/lib/utils'
import { useQuery } from '@tanstack/react-query'
import { Badge } from '@clinmesh/ui/components/badge'
import { getDoctorQueue, getDoctorCompletedCases } from '../api-client.ts'
import {
  type DoctorQueueView
} from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { CheckCircleIcon, CheckIcon, ClipboardCheckIcon, ClipboardPenIcon, FileSignatureIcon, RefreshCwIcon, StethoscopeIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { agentViewRevision, useRegisterAgentPage } from '../agent-page-context.tsx'
import {
  DoctorCompletedCaseLibrary
} from '../doctor-completed-cases.tsx'
import { InpatientReferral } from '../inpatient-referral.tsx'
import { WorkspaceActionBar, WorkspaceHeaderPatient, announceHandoff } from '../workspace-card-layout.tsx'
import {
  getWorkspaceErrorMessage,
  getWorkspaceErrorTitle,
} from '../workspace-error.ts'
import { formatFen } from '../workspace-format.ts'
import { outpatientCaseFlowState } from '../workspace-flow.ts'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { formatClinicalDateTime } from './clinical-date-time.ts'
import { createWorkingClinicalDocument } from './clinical-document-content.ts'
import { doctorConsultationAgentActions } from './doctor-agent-consultation.tsx'
import { doctorDiagnosisAgentActions } from './doctor-agent-diagnosis.tsx'
import { doctorInvestigationsAgentActions } from './doctor-agent-investigations.tsx'
import { doctorPrescriptionAgentActions } from './doctor-agent-prescription.tsx'
import { doctorRecordAgentActions } from './doctor-agent-record.tsx'
import { doctorWorkspaceAgentActions } from './doctor-agent-workspace.tsx'
import { CaseDetail } from './doctor-case-detail.tsx'
import { useDoctorCaseModel } from './doctor-case-model.tsx'
import { type CompletedCaseCorrectionNavigation, type DoctorCaseControllerProps, type DoctorWorkspaceProps, ErrorAlert, emptyDoctorAgentDraftHydrationRevisions, usesStructuredClinicalDocument } from './doctor-case-support.tsx'
import { DoctorCompletionActionBar } from './doctor-completion-action.tsx'
import { DoctorDraftMarksProvider } from './doctor-draft-fields.tsx'
import { DoctorPreparationProvider } from './doctor-preparation-state.tsx'
import { DoctorQueueModule } from './doctor-queue-module.tsx'
import { insertImagingReportSummary } from './imaging-report-summary.ts'
import { DoctorCaseDetailRegion, DoctorWorkspaceLayout } from './responsive-layout.tsx'

export function DoctorWorkspace(props: DoctorWorkspaceProps): React.JSX.Element {
  const actor = props.session.actor
  return <DoctorWorkspaceScope key={JSON.stringify([actor.workspaceId, actor.epoch, actor.actorId, actor.practitionerRoleId])} {...props} />
}

function DoctorWorkspaceScope({ locale, session }: DoctorWorkspaceProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  // The business panes unmount independently; the shared tabs keep one indicator and DOM host.
  // Scoped slots/parking own host cleanup; React 18 replays effects without reattaching refs.
  const [navigationHost] = useState(() => document.createElement('div'))
  const [navigationReady, setNavigationReady] = useState(false)
  const navigationParking = useRef<HTMLDivElement>(null)
  const mountNavigation = useCallback((element: HTMLDivElement | null) => {
    const target = element ?? navigationParking.current
    if (target === null) return
    // Park before the old pane is removed, then move into the new slot without resetting CSS or focus.
    if (target.isConnected && navigationHost.isConnected && 'moveBefore' in target && typeof target.moveBefore === 'function') target.moveBefore(navigationHost, null)
    else target.append(navigationHost)
    if (element !== null) setNavigationReady(true)
  }, [navigationHost])
  const [activeTab, setActiveTab] = useState<DoctorQueueView | 'completed'>('active')
  const [selectedCaseId, setSelectedCaseId] = useState<string>()
  const [correctionNavigation, setCorrectionNavigation] = useState<
    CompletedCaseCorrectionNavigation
  >()
  const scope = [session.actor.workspaceId, session.actor.epoch, session.actor.actorId, session.actor.practitionerRoleId]
  const activeQueue = useQuery({ queryKey: ['doctor-queue', ...scope, 'active', 1], queryFn: ({ signal }) => getDoctorQueue(signal, 1, 'active') })
  const waitingQueue = useQuery({ queryKey: ['doctor-queue', ...scope, 'waiting', 1], queryFn: ({ signal }) => getDoctorQueue(signal, 1, 'waiting') })
  const completedQueue = useQuery({ queryKey: ['doctor-completed-cases', ...scope, {}, 1], queryFn: ({ signal }) => getDoctorCompletedCases({}, signal) })
  const queueTabClassName = cn(
    'min-w-0 gap-1 px-1 dark:data-active:bg-background dark:data-active:text-foreground dark:data-active:shadow-xs',
    locale === 'en-US' && 'h-auto flex-col whitespace-normal',
  )
  const queueLabelClassName = locale === 'en-US' ? 'min-w-0 max-w-full wrap-anywhere whitespace-normal' : undefined
  const navigation = (
    <TabsList data-view-switch="" aria-label={messages.consultation} className="grid h-auto! w-full grid-cols-3">
      <TabsTrigger aria-describedby="doctor-queue-count-active" aria-label={messages.doctorActiveQueue} className={queueTabClassName} value="active"><span className={queueLabelClassName}>{messages.doctorActiveQueue}</span><Badge aria-label={messages.doctorQueueCount.replace('{count}', String(activeQueue.data?.total ?? '—'))} id="doctor-queue-count-active" className="px-1 tabular-nums" variant="secondary">{activeQueue.data?.total ?? '—'}</Badge></TabsTrigger>
      <TabsTrigger aria-describedby="doctor-queue-count-waiting" aria-label={messages.doctorWaitingQueue} className={queueTabClassName} value="waiting"><span className={queueLabelClassName}>{messages.doctorWaitingQueue}</span><Badge aria-label={messages.doctorQueueCount.replace('{count}', String(waitingQueue.data?.total ?? '—'))} id="doctor-queue-count-waiting" className="px-1 tabular-nums" variant="secondary">{waitingQueue.data?.total ?? '—'}</Badge></TabsTrigger>
      <TabsTrigger aria-describedby="doctor-queue-count-completed" aria-label={messages.doctorCompletedQueue} className={queueTabClassName} value="completed"><span className={queueLabelClassName}>{messages.doctorCompletedQueue}</span><Badge aria-label={messages.doctorQueueCount.replace('{count}', String(completedQueue.data?.total ?? '—'))} id="doctor-queue-count-completed" className="px-1 tabular-nums" variant="secondary">{completedQueue.data?.total ?? '—'}</Badge></TabsTrigger>
    </TabsList>
  )
  const navigationSlot = <div className="min-w-0" ref={mountNavigation} />
  return (
    <Tabs className="min-h-0 flex-1 gap-0" onValueChange={value => {
      if (value !== 'active' && value !== 'waiting' && value !== 'completed') return
      setActiveTab(value)
      setSelectedCaseId(undefined)
      setCorrectionNavigation(undefined)
    }} value={activeTab}>
      <div aria-hidden="true" className="pointer-events-none fixed -left-10000 top-0" ref={navigationParking} />
      {navigationReady ? createPortal(navigation, navigationHost) : null}
      {activeTab !== 'completed' ? (
        <DoctorCaseController
          navigation={navigationSlot}
          queueView={activeTab}
          onQueueViewChange={setActiveTab}
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
      ) : (
        <DoctorCompletedCaseLibrary
          navigation={navigationSlot}
          locale={locale}
          onOpenCorrection={(caseId, target) => {
            setSelectedCaseId(caseId)
            setCorrectionNavigation({ caseId, handled: false, target })
            setActiveTab('active')
          }}
          session={session}
        />
      )}
    </Tabs>
  )
}

function DoctorCaseController(props: DoctorCaseControllerProps): React.JSX.Element {
  const model = useDoctorCaseModel(props)
  const {
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
    selectInvestigation,
    selectInvestigationRequest,
    pageScope,
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
    completeCaseEncounter,
    askQuestion,
    retryPatientReply,
    start,
    beginRevisit,
    saveDraft,
    issueOrder,
    saveLaboratoryRequest,
    issueRequest,
    deleteRequestDraft,
    cancelRequest,
    acknowledgeReport,
    correctReport,
    controlRecording,
    confirmVisitKind,
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
  } = model
  const [completionReview, setCompletionReview] = useState<{ caseId: string; signature: string }>()
  useEffect(() => { setCompletionReview(undefined) }, [pageScope])
  const completionSignature = agentViewRevision(completion.data ?? {})
  // The completion trigger remounts when the review bar closes; focus it once it is back.
  const restoreCompletionTrigger = useRef(false)
  const closeCompletion = () => {
    restoreCompletionTrigger.current = true
    setCompletionReview(undefined)
  }
  const consulting = !detailUnavailable && detail.data !== undefined && detail.data.consultation !== undefined
    && detail.data.encounter.status === 'in-progress' && detail.data.status !== 'awaiting-doctor'
  const completionAction = {
    error: completeCaseEncounter.variables?.caseId === activeCaseId ? completeCaseEncounter.error : null,
    onSubmit: () => {
      if (activeCaseId === undefined) return
      const name = detail.data?.patient.name ?? ''
      completeCaseEncounter.mutate({ caseId: activeCaseId }, { onSuccess: () => announceHandoff(
        `${locale === 'zh-CN' ? '已完诊' : 'Encounter completed'} · ${name}`, locale === 'zh-CN' ? '已交给收费处缴费' : 'Handed to the cashier for payment') })
    },
    pending: completeCaseEncounter.isPending && completeCaseEncounter.variables?.caseId === activeCaseId,
    success: completeCaseEncounter.isSuccess && completeCaseEncounter.variables?.caseId === activeCaseId,
  }
  const agentPage = useMemo(() => ({
    actions: {
      ...doctorWorkspaceAgentActions(model),
      ...doctorConsultationAgentActions(model),
      ...doctorDiagnosisAgentActions(model),
      ...doctorInvestigationsAgentActions(model),
      ...doctorPrescriptionAgentActions(model),
      ...doctorRecordAgentActions(model),
    },
    claim: {
      version: 1 as const,
      viewId: 'consultation' as const,
      activeSection: activeCaseSection,
      viewRevision: agentViewRevision({
        activeCaseId,
        activeCaseSection,
        investigationView,
        laboratorySelection: { catalogItemId: resolvedLaboratoryItemId, indicationCode: resolvedIndicationCode },
        clinicalDocument: currentClinicalDocument,
        consultationVersion: detail.data?.consultation?.version,
        firstVisitDraftVersion: detail.data?.drafts?.firstVisit?.version,
        revisitDraftVersion: detail.data?.drafts?.revisit?.version,
        revisitConditionVersion: detail.data?.drafts?.revisit?.conditionVersion,
        documentDraftVersion: detail.data?.drafts?.document?.version,
        prescriptionDraftVersion: detail.data?.drafts?.prescription?.version,
        prescriptionDraftItems: detail.data?.drafts?.prescription?.items.map(item => [item.medicationRequestId, item.versionId]),
        medicationDraftVersion: detail.data?.medicationConclusion?.draftVersion,
        prescription: detail.data?.medicationConclusion?.prescription === undefined ? undefined : {
          id: detail.data.medicationConclusion.prescription.id,
          version: detail.data.medicationConclusion.prescription.version,
          withdrawalVersion: detail.data.medicationConclusion.prescription.withdrawal?.version,
          items: detail.data.medicationConclusion.prescription.items.map(item => [item.medicationRequestId, item.medicationRequestVersion]),
        },
        noMedicationVersion: detail.data?.medicationConclusion?.noMedication?.version,
        diagnosisDraftVersion: detail.data?.diagnosis?.draftVersion,
        diagnosisConfirmation: detail.data?.diagnosis?.confirmation === undefined ? undefined : {
          id: detail.data.diagnosis.confirmation.id,
          revision: detail.data.diagnosis.confirmation.revisionNumber,
          entries: detail.data.diagnosis.confirmation.entries.map(entry => [entry.conditionId, entry.conditionVersion]),
        },
        signedDocuments: detail.data?.clinicalDocument?.signed.map(document => [document.compositionId, document.compositionVersion]),
        encounterStatus: detail.data?.encounter.status,
        encounterVersion: detail.data?.encounter.versionId,
        taskVersion: detail.data?.taskVersion,
        status: detail.data?.status,
        patientVersion: detail.data?.patient.versionId,
        imagingDraftVersion: detail.data?.imagingRequests?.draftVersion,
        pathologyDraftVersion: detail.data?.pathologyRequests?.draftVersion,
        laboratoryDraftVersion: detail.data?.laboratoryRequests?.draftVersion,
        requests: [
          ...(detail.data?.laboratoryRequests?.requests ?? []),
          ...(detail.data?.imagingRequests?.requests ?? []),
          ...(detail.data?.pathologyRequests?.requests ?? []),
        ].map(request => ({
          id: request.id, version: request.version, status: request.status,
          serviceRequestVersion: request.serviceRequestVersion, taskVersion: request.taskVersion,
          report: request.report === undefined ? undefined : [
            request.report.diagnosticReportId, request.report.diagnosticReportVersion,
            request.report.acknowledgement?.id,
          ],
        })),
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
          : queue.isError || detailUnavailable ? 'error' as const
            : queue.data?.items.length === 0 ? 'empty' as const : 'ready' as const,
      },
    },
    label: 'ClinMesh · 门诊医生',
    feedbackSelectionId: activeCaseId ?? '',
    readState: () => ({
      case: detail.data === undefined ? null : {
        caseId: detail.data.caseId,
        consultation: detail.data.consultation ?? null,
        diagnosis: detail.data.diagnosis ?? null,
        encounter: detail.data.encounter,
        imagingRequests: detail.data.imagingRequests ?? null,
        laboratoryRequests: detail.data.laboratoryRequests ?? null,
        pathologyRequests: detail.data.pathologyRequests ?? null,
        patient: detail.data.patient,
        presentation: detail.data.presentation,
      },
      clinicalDocumentDraft: currentClinicalDocument ?? null,
      laboratoryDraft: { catalogItemId: resolvedLaboratoryItemId, indicationCode: resolvedIndicationCode },
      queue: queue.data ?? null,
      queueCount: queue.data?.total ?? 0,
      section: activeCaseSection,
      investigation: investigationView,
    }),
  }), [
    activeCaseId,
    activeCaseSection,
    acknowledgeReport.mutateAsync,
    agentReview,
    askQuestion.isPending,
    askQuestion.mutateAsync,
    beginRevisit.mutateAsync,
    cancelRequest.mutateAsync,
    confirmCaseDiagnosis.mutateAsync,
    correctReport.mutateAsync,
    currentClinicalDocument,
    detail.data,
    detailUnavailable,
    detail.isPending,
    canCorrectReports,
    hydrateAgentDraft,
    imagingView,
    investigationView,
    selectInvestigation,
    issueOrder.mutateAsync,
    issueRequest.mutateAsync,
    issueRequest.isPending,
    issueRequest.variables?.caseId,
    saveLaboratoryRequest.isPending,
    saveLaboratoryRequest.variables?.caseId,
    messages,
    onQueueViewChange,
    onSelectedCaseIdChange,
    page,
    previewSign.mutateAsync,
    queue.data,
    queue.isError,
    queue.isPending,
    resolvedIndicationCode,
    resolvedLaboratoryItem,
    resolvedLaboratoryItemId,
    retryPatientReply.isPending,
    retryPatientReply.mutateAsync,
    saveDraft.mutateAsync,
    saveRevisit.mutateAsync,
    start.mutateAsync,
    usesIndependentLaboratoryRequests,
  ])
  useRegisterAgentPage(agentPage)
  return (
    <DoctorDraftMarksProvider><DoctorPreparationProvider detail={detailUnavailable ? undefined : detail.data} scope={pageScope}
      inputRevision={recommendationRevision}
      formRevisions={activeCaseId === undefined ? undefined : agentDraftHydrationRevisions[activeCaseId]}
      enabled={!detailUnavailable && detail.data?.consultation !== undefined && detail.data.encounter.status === 'in-progress' && detail.data.status !== 'awaiting-doctor'}>
      {detailUnavailable || detail.data === undefined ? null : <WorkspaceHeaderPatient>{detail.data.patient.name}</WorkspaceHeaderPatient>}
      <DoctorWorkspaceLayout locale={locale} flowState={detailUnavailable || detail.data === undefined ? {}
        : outpatientCaseFlowState(detail.data.encounter.status === 'completed' ? 'completed' : detail.data.status)}
        action={completionAction.success ? <section aria-label={locale === 'zh-CN' ? '完诊操作' : 'Encounter completion action'}>
          <WorkspaceActionBar tone="complete" summary={messages.encounterCompleted}
            reason={locale === 'zh-CN' ? '下一步：可在完诊列表回看病例。' : 'Next: review the case in Completed visits.'} />
        </section> : completionReview !== undefined && completionReview.caseId === activeCaseId && completion.data !== undefined ? <DoctorCompletionActionBar
          action={completionAction} basisCurrent={!completion.isFetching && !completion.isError && completionReview.signature === completionSignature}
          locale={locale} messages={messages} onBack={closeCompletion}
          onNavigate={target => { completionNavigate?.(target); setCompletionReview(undefined) }} preview={completion.data} />
        : consulting ? (() => {
          const activeCase = detail.data
          const showRecordSignBar = activeCase !== undefined
            && activeCaseSection === 'record'
            && usesStructuredClinicalDocument(activeCase)
            && (activeCase.clinicalDocument?.signed.length ?? 0) === 0
          const currentSignPreview = prepareClinicalDocumentSign.variables?.caseId === activeCase?.caseId
            ? prepareClinicalDocumentSign.data?.data
            : undefined
          const signPreparing = currentSignPreview !== undefined
            || activeCase?.consultationRecording?.signingPreparation?.active === true
            || (prepareClinicalDocumentSign.isPending && prepareClinicalDocumentSign.variables?.caseId === activeCase?.caseId)
          const cancelSignPending = cancelClinicalDocumentSign.isPending && cancelClinicalDocumentSign.variables?.caseId === activeCase?.caseId
          const saveDraftPendingForCase = saveDocumentDraft.isPending && saveDocumentDraft.variables?.caseId === activeCase?.caseId
          const saveDraftSuccessForCase = saveDocumentDraft.isSuccess && saveDocumentDraft.variables?.caseId === activeCase?.caseId
          const recordReason = showRecordSignBar
            ? (hasUnsavedClinicalDocumentChanges
              ? messages.clinicalDocumentDraftUnsaved
              : saveDraftSuccessForCase
                ? messages.clinicalDocumentDraftSaved
                : undefined)
            : undefined
          return <WorkspaceActionBar
            reason={recordReason}
            action={<div className="flex flex-wrap items-center gap-2">
              {showRecordSignBar && currentClinicalDocument !== undefined ? <>
                <Button
                  disabled={saveDraftPendingForCase || signPreparing || cancelSignPending}
                  onClick={() => saveDocumentDraft.mutate({ caseId: activeCase.caseId, document: currentClinicalDocument })}
                  type="button"
                  variant="outline"
                >
                  {messages.saveClinicalDocumentDraft}
                </Button>
                <Button
                  disabled={signPreparing || cancelSignPending}
                  onClick={() => {
                    const form = caseDetailRoot.current?.querySelector<HTMLFormElement>(`form[aria-label="${messages.structuredClinicalDocument}"]`)
                    if (form !== null && form !== undefined) {
                      form.requestSubmit()
                    } else {
                      prepareClinicalDocumentSign.mutate({ caseId: activeCase.caseId, document: currentClinicalDocument })
                    }
                  }}
                  type="button"
                  variant="outline"
                >
                  {prepareClinicalDocumentSign.isPending && prepareClinicalDocumentSign.variables?.caseId === activeCase.caseId
                    ? <RefreshCwIcon aria-hidden="true" className="animate-spin" data-icon="inline-start" />
                    : <FileSignatureIcon aria-hidden="true" data-icon="inline-start" />}
                  {prepareClinicalDocumentSign.isPending && prepareClinicalDocumentSign.variables?.caseId === activeCase.caseId
                    ? messages.signingClinicalRecord
                    : messages.signClinicalRecord}
                </Button>
              </> : null}
              <Button data-completion-trigger="" type="button"
                ref={element => { if (element && restoreCompletionTrigger.current) { restoreCompletionTrigger.current = false; element.focus() } }}
                disabled={completion.isPending || completion.isError || completion.data === undefined}
                title={completion.isError ? messages.encounterCompletionUnavailable : undefined}
                onClick={() => { if (activeCaseId !== undefined) setCompletionReview({ caseId: activeCaseId, signature: completionSignature }) }}>
                <ClipboardCheckIcon aria-hidden="true" data-icon="inline-start" />
                {messages.finishEncounter} {completion.data === undefined ? '' : `${completion.data.items.filter(item => item.status === 'complete').length}/${completion.data.items.length}`}
              </Button>
            </div>}
          />
        })()
        : !detailUnavailable && detail.data !== undefined && detail.data.encounter.status === 'in-progress' && detail.data.status === 'awaiting-doctor' ? (
          <WorkspaceActionBar
            summary={messages.status_awaitingDoctor}
            reason={locale === 'zh-CN' ? '轮到你：查看分诊摘要与主诉，点击开始首诊进入问诊与病历书写' : 'Next: review triage summary and start the first visit'}
            action={<Button disabled={start.isPending && start.variables?.caseId === detail.data.caseId} onClick={() => start.mutate({ caseId: detail.data.caseId })} type="button">
              <StethoscopeIcon data-icon="inline-start" />
              {messages.startFirstVisit}
            </Button>}
          />
        ) : !detailUnavailable && detail.data !== undefined && detail.data.encounter.status === 'in-progress' && detail.data.status === 'awaiting-revisit' ? (
          <WorkspaceActionBar
            summary={messages.status_awaitingRevisit}
            reason={locale === 'zh-CN' ? '轮到你：查看复诊结果，点击开始复诊' : 'Next: review revisit results and start the revisit'}
            action={<Button disabled={beginRevisit.isPending && beginRevisit.variables?.caseId === detail.data.caseId} onClick={() => beginRevisit.mutate({ caseId: detail.data.caseId })} type="button">
              <StethoscopeIcon data-icon="inline-start" />
              {messages.startRevisit}
            </Button>}
          />
        ) : undefined}
        selectedCaseId={activeCaseId} queueLabel={messages.waitingPatients} detailLabel={messages.caseDetail}
        queue={showDetail => (
          <DoctorQueueModule
            navigation={navigation}
            queueView={queueView}
            activeCaseId={activeCaseId}
            messages={messages}
            onQueuePageChange={(nextPage) => {
              setPage(nextPage)
              onSelectedCaseIdChange(undefined)
            }}
            onSelectCase={caseId => { onSelectedCaseIdChange(caseId); showDetail() }}
            queueData={visibleQueue.data}
            queueError={visibleQueue.error}
            queuePending={visibleQueue.isPending}
            onRetry={() => { void visibleQueue.refetch() }}
          />
        )}>
        <DoctorCaseDetailRegion containerRef={caseDetailRoot} labelledBy="case-detail-heading">
          <h2 className="sr-only" id="case-detail-heading">{messages.caseDetail}</h2>
          {catalog.error === null ? null : <Alert variant="destructive">
            <AlertTitle>{locale === 'zh-CN' ? '诊疗目录读取失败' : 'Clinical catalog could not be loaded'}</AlertTitle>
            <AlertDescription><Button onClick={() => { void catalog.refetch() }} size="sm" type="button" variant="outline">{messages.suggestionRetry}</Button></AlertDescription>
          </Alert>}
          {!detail.isError || detailUnavailable ? null : <Alert>
            <AlertTitle>{locale === 'zh-CN' ? '病例刷新失败' : 'Case refresh failed'}</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              <span>{locale === 'zh-CN' ? '已保留当前病例信息。' : 'Current case information is retained.'}</span>
              <Button disabled={detail.isFetching} onClick={() => { void detail.refetch() }} size="sm" type="button" variant="outline">{messages.suggestionRetry}</Button>
            </AlertDescription>
          </Alert>}
          {issueOrder.isSuccess && issueOrder.variables.caseId === activeCaseId ? (
            <Alert className="shrink-0">
              <CheckIcon aria-hidden="true" />
              <AlertTitle>{messages.laboratoryOrderIssued}</AlertTitle>
              <AlertDescription>
                {messages.awaitingLaboratoryPayment} · {formatFen(issueOrder.data.data.totalFen, locale)}
              </AlertDescription>
            </Alert>
          ) : null}
          {completeSign.isSuccess && completeSign.variables.caseId === activeCaseId ? (
            <Alert className="shrink-0">
              <CheckCircleIcon aria-hidden="true" />
              <AlertTitle>{messages.encounterCompleted}</AlertTitle>
              <AlertDescription>{messages.awaitingMedicationPayment}</AlertDescription>
            </Alert>
          ) : null}
          {detail.isPending && activeCaseId !== undefined ? <Skeleton className="h-64 w-full" /> : detailUnavailable && detail.error !== null ? (
            <><ErrorAlert message={getWorkspaceErrorMessage(detail.error, messages)} title={getWorkspaceErrorTitle(detail.error, messages, messages.consultationUnavailable)} />
              <Button onClick={() => { void detail.refetch() }} type="button" variant="outline">{messages.suggestionRetry}</Button></>
          ) : detail.data === undefined ? (
            <Empty className="min-h-44 border"><EmptyHeader><EmptyMedia variant="icon"><ClipboardPenIcon aria-hidden="true" /></EmptyMedia><EmptyTitle>{messages.noConsultationCases}</EmptyTitle></EmptyHeader></Empty>
          ) : (
            <CaseDetail
              investigationActionContext={{ session, caseId: detail.data.caseId, patientId: detail.data.patient.id,
                encounterId: detail.data.encounter.id, patientName: detail.data.patient.name,
                onChanged: () => refreshCaseById(detail.data.caseId) }}
              patientActions={<InpatientReferral key={detail.data.encounter.id} encounterId={detail.data.encounter.id} encounterVersion={detail.data.encounter.versionId} locale={locale} session={session}
                patient={detail.data.patient} registrationNumber={detail.data.registrationNumber} diagnosisConfirmation={detail.data.diagnosis?.confirmation} />}
              clinicalDocumentUpdates={clinicalDocumentUpdates}
              onCompletionNavigateChange={setCompletionNavigateStable}
              recommendationScope={pageScope}
              recommendationRevision={recommendationRevision}
              agentDraftHydrationRevisions={agentDraftHydrationRevisions[detail.data.caseId]
                ?? emptyDoctorAgentDraftHydrationRevisions}
              clinicalDocumentActions={{
                confirmVisitKind: {
                  error: confirmVisitKind.variables?.caseId === detail.data.caseId ? confirmVisitKind.error : null,
                  pending: confirmVisitKind.isPending && confirmVisitKind.variables?.caseId === detail.data.caseId,
                  onSubmit: input => confirmVisitKind.mutateAsync({ caseId: detail.data.caseId, ...input }),
                },
                cancelSign: {
                  error: cancelClinicalDocumentSign.variables?.caseId === detail.data.caseId ? cancelClinicalDocumentSign.error : null,
                  pending: cancelClinicalDocumentSign.isPending && cancelClinicalDocumentSign.variables?.caseId === detail.data.caseId,
                  onSubmit: previewId => cancelClinicalDocumentSign.mutate({ caseId: detail.data.caseId, previewId }),
                },
                controlRecording: {
                  error: controlRecording.variables?.caseId === detail.data.caseId ? controlRecording.error : null,
                  pending: controlRecording.isPending && controlRecording.variables?.caseId === detail.data.caseId,
                  onSubmit: action => controlRecording.mutate({ caseId: detail.data.caseId, action }),
                },
                save: {
                  error: saveDocumentDraft.variables?.caseId === detail.data.caseId ? saveDocumentDraft.error : null,
                  hasUnsavedChanges: hasUnsavedClinicalDocumentChanges,
                  onSubmit: document => saveDocumentDraft.mutate({ caseId: detail.data.caseId, document }),
                  pending: saveDocumentDraft.isPending && saveDocumentDraft.variables?.caseId === detail.data.caseId,
                  success: saveDocumentDraft.isSuccess && saveDocumentDraft.variables?.caseId === detail.data.caseId,
                },
                prepareSign: {
                  data: prepareClinicalDocumentSign.variables?.caseId === detail.data.caseId
                    ? prepareClinicalDocumentSign.data?.data
                    : undefined,
                  error: prepareClinicalDocumentSign.variables?.caseId === detail.data.caseId
                    ? prepareClinicalDocumentSign.error
                    : null,
                  onReset: () => {
                    const previewId = prepareClinicalDocumentSign.data?.data.previewId
                    if (previewId !== undefined) cancelClinicalDocumentSign.mutate({ caseId: detail.data.caseId, previewId })
                  },
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
              correctionTarget={correctionNavigation?.caseId === detail.data.caseId
                ? correctionNavigation.target
                : undefined}
              consultationAction={{
                error: retryPatientReply.variables?.caseId === detail.data.caseId && retryPatientReply.error !== null
                  ? retryPatientReply.error
                  : askQuestion.variables?.caseId === detail.data.caseId ? askQuestion.error : null,
                onAsk: message => askQuestion.mutate({ caseId: detail.data.caseId, message }),
                onRetry: () => retryPatientReply.mutate({ caseId: detail.data.caseId }),
                pending: (askQuestion.isPending && askQuestion.variables?.caseId === detail.data.caseId)
                  || (retryPatientReply.isPending && retryPatientReply.variables?.caseId === detail.data.caseId),
                ...(askQuestion.isPending && askQuestion.variables?.caseId === detail.data.caseId
                  ? { pendingMessage: askQuestion.variables.message } : {}),
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
              imagingActions={{
                canCorrect: canCorrectReports,
                onChanged: () => refreshCaseById(detail.data.caseId),
                // 摘要只插入未签病历的工作稿；已签文书通过文书更正流程修改。
                ...(detail.data.encounter.status !== 'in-progress' || (detail.data.clinicalDocument?.signed.length ?? 0) > 0
                  ? {}
                  : {
                    onInsertSummary: (request, report) => {
                      const document = workingClinicalDocuments[detail.data.caseId]
                        ?? createWorkingClinicalDocument(detail.data)
                      const insertion = insertImagingReportSummary(document.auxiliaryExamination, request.service.name, {
                        impression: report.impression,
                        issuedLabel: formatClinicalDateTime(report.issuedAt, 'zh-CN'),
                        revisionNumber: report.revisionNumber,
                      })
                      if (insertion.status === 'inserted') {
                        setWorkingClinicalDocuments(current => ({
                          ...current,
                          [detail.data.caseId]: { ...document, auxiliaryExamination: insertion.text },
                        }))
                      }
                      return insertion.status
                    },
                  }),
                view: imagingView,
              }}
              pathologyActions={{
                canCorrect: canCorrectReports,
                onChanged: () => refreshCaseById(detail.data.caseId),
                ...(detail.data.encounter.status !== 'in-progress' || (detail.data.clinicalDocument?.signed.length ?? 0) > 0
                  ? {}
                  : {
                    onInsertSummary: (request, report) => {
                      const document = workingClinicalDocuments[detail.data.caseId]
                        ?? createWorkingClinicalDocument(detail.data)
                      const insertion = insertImagingReportSummary(document.auxiliaryExamination, request.service.name, {
                        impression: report.diagnosis,
                        issuedLabel: formatClinicalDateTime(report.issuedAt, 'zh-CN'),
                        reportKind: '病理会诊报告',
                        revisionNumber: report.revisionNumber,
                      })
                      if (insertion.status === 'inserted') {
                        setWorkingClinicalDocuments(current => ({
                          ...current,
                          [detail.data.caseId]: { ...document, auxiliaryExamination: insertion.text },
                        }))
                      }
                      return insertion.status
                    },
                  }),
                // 切片的阅片状态与放射影像共用：都按申请和报告标识记录。
                view: imagingView,
              }}
              investigationView={investigationView}
              onSelectInvestigation={selectInvestigation}
              onSelectInvestigationRequest={selectInvestigationRequest}
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
                correct: {
                  allowed: canCorrectReports,
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
                  ...(issueRequest.variables?.caseId === detail.data.caseId && issueRequest.data !== undefined
                    ? { successRequestId: issueRequest.data.data.request.id } : {}),
                },
                save: {
                  error: saveLaboratoryRequest.variables?.caseId === detail.data.caseId
                    ? saveLaboratoryRequest.error
                    : null,
                  onSubmit: override => saveLaboratoryRequest.mutate({ caseId: detail.data.caseId, ...(override === undefined ? {} : { override }) }),
                  pending: saveLaboratoryRequest.isPending
                    && saveLaboratoryRequest.variables?.caseId === detail.data.caseId,
                },
              }}
              locale={locale}
              messages={messages}
              onClinicalDocumentChange={document => {
                clinicalDocumentUpdates.onEdit(detail.data.caseId, document)
                setWorkingClinicalDocuments(current => ({
                  ...current,
                  [detail.data.caseId]: document,
                }))
              }}
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
        </DoctorCaseDetailRegion>
      </DoctorWorkspaceLayout>
    </DoctorPreparationProvider></DoctorDraftMarksProvider>
  )

}
