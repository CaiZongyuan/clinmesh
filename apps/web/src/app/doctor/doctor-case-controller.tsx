import {
  type DoctorQueueView
} from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { CheckCircleIcon, CheckIcon, ClipboardPenIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { agentViewRevision, useRegisterAgentPage } from '../agent-page-context.tsx'
import {
  DoctorCompletedCaseLibrary
} from '../doctor-completed-cases.tsx'
import { InpatientReferral } from '../inpatient-referral.tsx'
import { WorkspaceActionBar, WorkspaceHeaderPatient } from '../workspace-card-layout.tsx'
import {
  getWorkspaceErrorMessage,
  getWorkspaceErrorTitle,
} from '../workspace-error.ts'
import { formatFen } from '../workspace-format.ts'
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
import { type CompletedCaseCorrectionNavigation, type DoctorCaseControllerProps, type DoctorWorkspaceProps, ErrorAlert, emptyDoctorAgentDraftHydrationRevisions } from './doctor-case-support.tsx'
import { DoctorCompletionActionBar } from './doctor-completion-action.tsx'
import { DoctorDraftMarksProvider } from './doctor-draft-fields.tsx'
import { DoctorPreparationProvider } from './doctor-preparation-state.tsx'
import { DoctorQueueModule } from './doctor-queue-module.tsx'
import { DoctorSuggestionStack } from './doctor-suggestion-stack.tsx'
import { insertImagingReportSummary } from './imaging-report-summary.ts'
import { DoctorCaseDetailRegion, DoctorWorkspaceLayout } from './responsive-layout.tsx'

export function DoctorWorkspace(props: DoctorWorkspaceProps): React.JSX.Element {
  const actor = props.session.actor
  return <DoctorWorkspaceScope key={JSON.stringify([actor.workspaceId, actor.epoch, actor.actorId, actor.practitionerRoleId])} {...props} />
}

function DoctorWorkspaceScope({ locale, session }: DoctorWorkspaceProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const [activeTab, setActiveTab] = useState<DoctorQueueView | 'completed'>('active')
  const [selectedCaseId, setSelectedCaseId] = useState<string>()
  const [correctionNavigation, setCorrectionNavigation] = useState<
    CompletedCaseCorrectionNavigation
  >()
  const navigation = (
    <TabsList aria-label={messages.consultation} className="h-auto! w-full flex-wrap">
      <TabsTrigger value="active">{messages.doctorActiveQueue}</TabsTrigger>
      <TabsTrigger value="waiting">{messages.doctorWaitingQueue}</TabsTrigger>
      <TabsTrigger value="completed">{messages.doctorCompletedQueue}</TabsTrigger>
    </TabsList>
  )
  return (
    <Tabs className="min-h-0 flex-1 gap-0" onValueChange={value => {
      if (value !== 'active' && value !== 'waiting' && value !== 'completed') return
      setActiveTab(value)
      setSelectedCaseId(undefined)
      setCorrectionNavigation(undefined)
    }} value={activeTab}>
      {activeTab !== 'completed' ? (
        <DoctorCaseController
          navigation={navigation}
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
          navigation={navigation}
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
  } = model
  const [completionReview, setCompletionReview] = useState<{ caseId: string; signature: string }>()
  useEffect(() => { setCompletionReview(undefined) }, [pageScope])
  const completionSignature = agentViewRevision(completion.data ?? {})
  const closeCompletion = () => {
    setCompletionReview(undefined)
    caseDetailRoot.current?.querySelector<HTMLButtonElement>('[data-completion-trigger]')?.focus()
  }
  const completionAction = {
    error: completeCaseEncounter.variables?.caseId === activeCaseId ? completeCaseEncounter.error : null,
    onSubmit: () => { if (activeCaseId !== undefined) completeCaseEncounter.mutate({ caseId: activeCaseId }) },
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
      <DoctorWorkspaceLayout locale={locale} activeStep={detail.data?.encounter.status === 'in-progress' ? 'consultation' : undefined}
        action={completionAction.success ? <section aria-label={locale === 'zh-CN' ? '完诊操作' : 'Encounter completion action'}>
          <WorkspaceActionBar tone="complete" summary={messages.encounterCompleted}
            reason={locale === 'zh-CN' ? '下一步：可在完诊列表回看病例。' : 'Next: review the case in Completed visits.'} />
        </section> : completionReview !== undefined && completionReview.caseId === activeCaseId && completion.data !== undefined ? <DoctorCompletionActionBar
          action={completionAction} basisCurrent={!completion.isFetching && !completion.isError && completionReview.signature === completionSignature}
          locale={locale} messages={messages} onBack={closeCompletion}
          onNavigate={target => { completionNavigate?.(target); setCompletionReview(undefined) }} preview={completion.data} /> : undefined}
        selectedCaseId={activeCaseId} queueLabel={messages.waitingPatients} detailLabel={messages.caseDetail}
        suggestions={{
          label: messages.suggestionStackTitle,
          node: <DoctorSuggestionStack completion={completion} detail={detailUnavailable ? undefined : detail.data}
            clinicalDocument={currentClinicalDocument} locale={locale} messages={messages} scope={pageScope}
            {...(completionNavigate === undefined ? {} : { onNavigateToCompletionTarget: completionNavigate })} />,
        }}
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
              patientActions={<InpatientReferral key={detail.data.encounter.id} encounterId={detail.data.encounter.id} encounterVersion={detail.data.encounter.versionId} locale={locale} session={session} />}
              clinicalDocumentUpdates={clinicalDocumentUpdates}
              onCompletionNavigateChange={setCompletionNavigateStable}
              recommendationScope={pageScope}
              recommendationRevision={recommendationRevision}
              agentDraftHydrationRevisions={agentDraftHydrationRevisions[detail.data.caseId]
                ?? emptyDoctorAgentDraftHydrationRevisions}
              clinicalDocumentActions={{
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
            onRequestCompletion={() => {
              if (activeCaseId !== undefined) setCompletionReview({ caseId: activeCaseId, signature: completionSignature })
            }}
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
