import { doctorCaseSectionSchema, type DoctorCaseSection } from '@clinmesh/contracts/agent'
import {
  type ClinicalCatalog,
  type ClinicalDocumentContent,
  type DoctorCaseDetail,
  type EncounterCompletionPreview,
  type EncounterCompletionTarget
} from '@clinmesh/contracts/his'
import { Alert, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { CheckCircleIcon, CheckIcon, ClipboardCheckIcon, ClipboardPenIcon, FileSignatureIcon, StethoscopeIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useRegisterAgentForm } from '../agent-page-context.tsx'
import {
  getClinicalCatalog,
  previewClinicalSign
} from '../api-client.ts'
import {
  type CompletedCaseCorrectionTarget
} from '../doctor-completed-cases.tsx'
import { useWorkspaceCardView, WorkspaceTabs } from '../workspace-card-layout.tsx'
import {
  getWorkspaceErrorMessage,
  getWorkspaceErrorTitle,
} from '../workspace-error.ts'
import { formatFen } from '../workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import type { ReferenceCatalogSearches } from './catalog-picker-dialogs.tsx'
import {
  ClinicalDocumentPage,
  type ClinicalDocumentPageActions
} from './clinical-document-page.tsx'
import { type ClinicalDocumentUpdates } from './clinical-document-updates.tsx'
import { EncounterCompletionProgress } from './completion-checklist.tsx'
import {
  ConsultationPage,
  type ConsultationPageAction,
} from './consultation-page.tsx'
import { DiagnosisPage, type DiagnosisPageActions } from './diagnosis-page.tsx'
import { doctorCaseStatusLabel } from './doctor-case-status.ts'
import { caseDetailSectionByCompletionTarget, caseInvestigationRequests, encounterCompletionTargetElementIds, ErrorAlert, usesStructuredClinicalDocument, type DoctorAgentDraftHydrationRevisions, type InvestigationCategory, type InvestigationView } from './doctor-case-support.tsx'
import { DoctorDraftScope, DoctorDraftField as Field } from './doctor-draft-fields.tsx'
import { useDoctorPreparation } from './doctor-preparation-state.tsx'
import { DoctorPreparationDetailsDialog, DoctorRecommendationDetails } from './doctor-recommendations.tsx'
import { RevisitEditor } from './doctor-revisit-editor.tsx'
import { DocumentQualityCompact, DocumentQualityDetails, locateDocumentQualityIssue, useDocumentQualityControl, type QualityIssue } from './document-quality-control.tsx'
import { ImagingPage, type ImagingPageActions } from './imaging-page.tsx'
import {
  LaboratoryPage,
  type LaboratoryPageActions
} from './laboratory-page.tsx'
import { PathologyPage, type PathologyPageActions } from './pathology-page.tsx'
import { PatientBanner } from './patient-summary.tsx'
import { PrescriptionPage, type PrescriptionPageActions } from './prescription-page.tsx'
import { DoctorCaseLayout, DoctorCasePanel } from './responsive-layout.tsx'

export function CaseDetail({
  patientActions,
  clinicalDocumentUpdates,
  onCompletionNavigateChange,
  agentDraftHydrationRevisions,
  recommendationScope,
  recommendationRevision,
  catalog,
  clinicalDocumentActions,
  completion,
  onRequestCompletion,
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
  investigationView,
  onSelectInvestigation,
  onSelectInvestigationRequest,
  imagingActions,
  pathologyActions,
  locale,
  messages,
  onClinicalDocumentChange,
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
  patientActions: ReactNode
  clinicalDocumentUpdates: ClinicalDocumentUpdates
  agentDraftHydrationRevisions: DoctorAgentDraftHydrationRevisions
  recommendationScope: string
  recommendationRevision: string
  catalog: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getClinicalCatalog>>>>
  clinicalDocumentActions: ClinicalDocumentPageActions
  completion: UseQueryResult<EncounterCompletionPreview, Error>
  onRequestCompletion: () => void
  onCompletionNavigateChange?: (navigate: (target: EncounterCompletionTarget) => void) => void
  consultationAction: ConsultationPageAction
  correctionTarget: CompletedCaseCorrectionTarget | undefined
  detail: DoctorCaseDetail
  diagnosisActions: DiagnosisPageActions
  indicationCode: string
  issueOrderError: Error | null
  issueOrderPending: boolean
  laboratoryCatalog: ClinicalCatalog['laboratory']
  laboratoryItemId: string
  investigationView: InvestigationView
  onSelectInvestigation: (category: InvestigationCategory, requestId?: string, reportId?: string) => void
  onSelectInvestigationRequest: (category: InvestigationCategory, requestId: string) => void
  laboratoryRequestActions: LaboratoryPageActions
  imagingActions: ImagingPageActions
  pathologyActions: PathologyPageActions
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onClinicalDocumentChange: (document: ClinicalDocumentContent) => void
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
  const firstVisitForm = useRef<HTMLFormElement>(null)
  useRegisterAgentForm({
    viewId: 'consultation', selectionId: detail.caseId, name: 'firstVisit', values: null,
    readValues: () => {
      const form = firstVisitForm.current
      if (form === null) return null
      const data = new FormData(form)
      return { assessment: String(data.get('assessment') ?? ''), historyOfPresentIllness: String(data.get('historyOfPresentIllness') ?? '') }
    },
  })
  const readOnly = detail.encounter.status !== 'in-progress'
  const visitNotStarted = detail.status === 'awaiting-doctor'
  const clinicalReadOnly = readOnly || visitNotStarted
  const preparation = useDoctorPreparation()
  const quality = useDocumentQualityControl({
    detail, document: workingClinicalDocument, scope: recommendationScope,
    enabled: !clinicalReadOnly && (detail.clinicalDocument?.signed.length ?? 0) === 0
  })
  const [pendingQualityIssue, setPendingQualityIssue] = useState<{ caseId: string; issue: QualityIssue }>()
  const sectionView = useWorkspaceCardView('doctor-case-section')
  const parsedSection = doctorCaseSectionSchema.safeParse(sectionView.tab)
  const activeSection = parsedSection.success ? parsedSection.data : 'record'
  const setActiveSection = useCallback((section: DoctorCaseSection) => sectionView.setTab(section), [sectionView.setTab])
  const [pendingNavigation, setPendingNavigation] = useState<{
    source: 'checklist' | 'correction'
    target: EncounterCompletionTarget
  }>()
  const detailRoot = useRef<HTMLDivElement>(null)
  const correctionNavigationKey = useRef<string | undefined>(undefined)
  const navigateToQualityIssue = (issue: QualityIssue) => {
    preparation?.closeDetails()
    setActiveSection('record')
    setPendingQualityIssue({ caseId: detail.caseId, issue })
  }
  useEffect(() => {
    if (activeSection !== 'record' || pendingQualityIssue === undefined || pendingQualityIssue.caseId !== detail.caseId) return
    const frame = requestAnimationFrame(() => {
      if (detailRoot.current !== null) locateDocumentQualityIssue(detailRoot.current, pendingQualityIssue.issue)
      setPendingQualityIssue(undefined)
    })
    return () => cancelAnimationFrame(frame)
  }, [activeSection, pendingQualityIssue, detail.caseId])
  const navigateInvestigationTarget = useCallback((target: EncounterCompletionTarget): void => {
    if (target === 'laboratory' || target === 'imaging' || target === 'pathology') {
      const requests = caseInvestigationRequests(detail)[target]
      const selected = requests?.find(request => request.status === 'reported')
        ?? requests?.find(request => request.report !== undefined)
        ?? requests?.[0]
      onSelectInvestigation(target, selected?.id)
    }
  }, [detail.laboratoryRequests, detail.imagingRequests, detail.pathologyRequests, onSelectInvestigation])
  useEffect(() => {
    if (correctionTarget === undefined) return
    const key = `${detail.caseId}:${correctionTarget}`
    if (correctionNavigationKey.current === key) return
    correctionNavigationKey.current = key
    navigateInvestigationTarget(correctionTarget)
    setActiveSection(caseDetailSectionByCompletionTarget[correctionTarget])
    setPendingNavigation({ source: 'correction', target: correctionTarget })
  }, [correctionTarget, detail.caseId, navigateInvestigationTarget])

  useEffect(() => {
    if (pendingNavigation === undefined) return
    const target = detailRoot.current?.querySelector<HTMLElement>(
      `#${encounterCompletionTargetElementIds[pendingNavigation.target]}`,
    )
    if (target === null || target === undefined) return
    target.focus()
    target.scrollIntoView?.({ block: 'start' })
    if (pendingNavigation.source === 'correction') onCorrectionNavigationHandled()
    setPendingNavigation(undefined)
  }, [activeSection, investigationView.category, onCorrectionNavigationHandled, pendingNavigation])

  const navigateToCompletionTarget = useCallback((target: EncounterCompletionTarget): void => {
    navigateInvestigationTarget(target)
    setActiveSection(caseDetailSectionByCompletionTarget[target])
    setPendingNavigation({ source: 'checklist', target })
  }, [navigateInvestigationTarget])
  useEffect(() => {
    onCompletionNavigateChange?.(navigateToCompletionTarget)
  }, [navigateToCompletionTarget, onCompletionNavigateChange])

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
    <DoctorDraftScope caseId={detail.caseId} kind="first-visit" revision={clinicalReadOnly ? 0 : agentDraftHydrationRevisions['first-visit'] ?? 0} locale={locale}><section aria-labelledby="first-visit-heading" className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold" id="first-visit-heading">{messages.firstVisitRecord}</h3>
      <form
        aria-labelledby="first-visit-heading"
        ref={firstVisitForm}
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
    </section></DoctorDraftScope>
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
        <DoctorDraftScope caseId={detail.caseId} kind="revisit" revision={clinicalReadOnly ? 0 : agentDraftHydrationRevisions['revisit'] ?? 0} locale={locale}><RevisitEditor
          catalog={catalog.data}
          detail={detail}
          key={`${detail.caseId}:${detail.drafts?.prescription?.version ?? 0}:${agentDraftHydrationRevisions.revisit ?? 0}`}
          locale={locale}
          messages={messages}
          onSave={onSaveRevisit}
          pending={saveRevisitPending}
        /></DoctorDraftScope>
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
                <dl className="grid grid-cols-1 gap-3 text-sm @min-[640px]/case-content:grid-cols-2">
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
    <DoctorCaseLayout>
      <div ref={detailRoot} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {preparation === undefined ? null : <DoctorPreparationDetailsDialog open={preparation.details.open}
          onOpenChange={open => { if (!open) preparation.closeDetails() }} title={locale === 'zh-CN' ? '依据与说明' : 'Evidence and details'}>
          {preparation.details.kind === 'quality' ? null : <DoctorRecommendationDetails job={preparation.jobs[preparation.details.kind]} locale={locale} />}
          <DocumentQualityDetails quality={quality} messages={messages} locale={locale} onLocateIssue={navigateToQualityIssue} />
        </DoctorPreparationDetailsDialog>}
        <PatientBanner
          patientActions={patientActions}
          workingDocument={workingClinicalDocument}
          {...(clinicalReadOnly || detail.consultation === undefined
            ? {}
            : {
              completionAction: (
                <Button data-completion-trigger="" disabled={completion.isPending || completion.isError || completion.data === undefined}
                  title={completion.isError ? messages.encounterCompletionUnavailable : undefined} onClick={onRequestCompletion} size="sm" type="button">
                  <ClipboardCheckIcon aria-hidden="true" data-icon="inline-start" />
                  {messages.finishEncounter} {completion.data === undefined ? '' : `${completion.data.items.filter(item => item.status === 'complete').length}/${completion.data.items.length}`}
                </Button>
              ),
            })}
          detail={detail}
          messages={messages}
          statusText={doctorCaseStatusLabel(detail.status, messages)}
          completionChecklist={completion.data === undefined ? null : (
            <EncounterCompletionProgress completion={completion.data} locale={locale} />
          )}
        />

        {overviewWorkflow === null ? null : (
          <div className="shrink-0 border-b p-4">{overviewWorkflow}</div>
        )}

        <WorkspaceTabs id="doctor-case-section" locale={locale} value={activeSection}
          onValueChange={value => {
            const section = doctorCaseSectionSchema.safeParse(value)
            if (section.success) setActiveSection(section.data)
          }}
          items={[
            ...(detail.consultation === undefined ? [] : [{ value: 'consultation', label: messages.consultationRecord,
              count: detail.consultation.turns.findLast(turn => turn.kind === 'text')?.speaker === 'doctor' ? 1 : 0,
              status: detail.consultation.turns.length > 0 ? 'completed' : 'pending' }]),
            { value: 'record', label: messages.medicalRecord },
            { value: 'laboratory', label: messages.laboratoryAndExamination },
            { value: 'diagnosis', label: messages.diagnosis },
            { value: 'prescription', label: messages.prescription },
          ].map(item => {
            const pending = completion.data?.items.filter(check => check.status === 'incomplete'
              && caseDetailSectionByCompletionTarget[check.target] === item.value).length ?? 0
            const known = item.value === 'consultation' ? (detail.consultation?.turns.length ?? 0) > 0 : completion.data !== undefined
            return { value: item.value, label: item.label,
              ...(item.value === 'consultation' || completion.data !== undefined ? { count: item.value === 'consultation' ? item.count ?? 0 : pending } : {}),
              status: item.value === activeSection ? 'current' : !known || pending > 0 ? 'pending' : 'completed' }
          })}>
          <div className="empty:hidden shrink-0 px-4 pt-3"><DocumentQualityCompact quality={quality} messages={messages} locale={locale} onLocateIssue={navigateToQualityIssue} /></div>

          <span id="clinical-document-update-notice" className="sr-only" role="status">
            {Object.keys(clinicalDocumentUpdates.fields).length === 0 ? '' : messages.clinicalDocumentHasUpdates}
          </span>
          {Object.keys(clinicalDocumentUpdates.fields).length === 0 ? null : <Button className="self-start" onClick={() => setActiveSection('record')} size="sm" type="button" variant="ghost">
            {messages.medicalRecord} · {messages.clinicalDocumentUpdatesShort}
          </Button>}

          {detail.consultation === undefined ? null : (
            <DoctorCasePanel value="consultation">
              <ConsultationPage
                action={{
                  ...consultationAction, onOpenReport: reference => {
                    const reportId = reference?.split('/')[1]
                    const categories = ['laboratory', 'imaging', 'pathology'] as const
                    for (const category of reportId === undefined ? [] : categories) {
                      const requests = caseInvestigationRequests(detail)[category]
                      const request = requests?.find(item => item.report?.diagnosticReportId === reportId
                        || item.previousReports.some(report => report.diagnosticReportId === reportId))
                      if (request !== undefined) {
                        onSelectInvestigation(category, request.id, reportId)
                        break
                      }
                    }
                    setActiveSection('laboratory')
                  }
                }}
                consultation={detail.consultation}
                key={`consultation:${detail.caseId}`}
                locale={locale}
                messages={messages}
                patientName={detail.patient.name}
                readOnly={clinicalReadOnly}
                recording={detail.consultationRecording}
                recordingAction={clinicalDocumentActions.controlRecording}
                recordingReadOnly={(detail.clinicalDocument?.signed.length ?? 0) > 0}
              />
            </DoctorCasePanel>
          )}

          <DoctorCasePanel value="record"><DoctorDraftScope caseId={detail.caseId} kind="record" revision={clinicalReadOnly ? 0 : agentDraftHydrationRevisions['record'] ?? 0} locale={locale}>
            <div className="flex flex-col gap-4">
              <div className="min-w-0">
                {visitNotStarted ? null : !usesStructuredClinicalDocument(detail) ? firstVisitRecord : (
                  <ClinicalDocumentPage
                    actions={clinicalDocumentActions}
                    allowRevision={!clinicalReadOnly || correctionTarget === 'clinical-document'}
                    detail={detail}
                    updates={clinicalDocumentUpdates}
                    elementId={encounterCompletionTargetElementIds['clinical-document']}
                    key={`structured-clinical-document:${detail.caseId}:${agentDraftHydrationRevisions.record ?? 0}`}
                    locale={locale}
                    messages={messages}
                    onDocumentChange={onClinicalDocumentChange}
                    workingDocument={workingClinicalDocument}
                    qualityScope={recommendationScope}
                    quality={quality}
                    {...(preparation === undefined ? {} : { onOpenQualityDetails: () => preparation.openDetails('quality') })}
                  />
                )}
              </div>
            </div>
          </DoctorDraftScope></DoctorCasePanel>

          <DoctorCasePanel keepMounted={detail.consultation !== undefined} value="diagnosis"><DoctorDraftScope caseId={detail.caseId} kind="diagnosis" revision={clinicalReadOnly ? 0 : agentDraftHydrationRevisions['diagnosis'] ?? 0} locale={locale}>
            {detail.consultation === undefined ? revisitWorkflow : catalog.isPending ? (
              <Skeleton className="h-72 w-full" />
            ) : catalog.isError ? (
              <ErrorAlert
                message={getWorkspaceErrorMessage(catalog.error, messages)}
                title={getWorkspaceErrorTitle(catalog.error, messages, messages.consultationUnavailable)}
              />
            ) : (
              <fieldset className="min-w-0 border-0 p-0" disabled={preparation?.submitting('diagnosis') === true}><DiagnosisPage
                actions={diagnosisActions}
                recommendationScope={recommendationScope}
                recommendationRevision={recommendationRevision}
                caseId={detail.caseId}
                catalog={catalog.data.diagnoses}
                encounter={detail.encounter}
                elementId={encounterCompletionTargetElementIds.diagnosis}
                key={`${detail.caseId}:${agentDraftHydrationRevisions.diagnosis ?? 0}`}
                locale={locale}
                messages={messages}
                readOnly={clinicalReadOnly}
                referenceSearch={referenceCatalogSearches.diagnoses}
                state={detail.diagnosis}
              /></fieldset>
            )}
          </DoctorDraftScope></DoctorCasePanel>

          <DoctorCasePanel keepMounted={detail.consultation !== undefined} value="prescription"><DoctorDraftScope caseId={detail.caseId} kind="prescription" revision={clinicalReadOnly ? 0 : agentDraftHydrationRevisions['prescription'] ?? 0} locale={locale}>
            {detail.consultation === undefined || catalog.isPending ? (
              detail.consultation === undefined ? revisitWorkflow : <Skeleton className="h-72 w-full" />
            ) : catalog.isError ? (
              <ErrorAlert
                message={getWorkspaceErrorMessage(catalog.error, messages)}
                title={getWorkspaceErrorTitle(catalog.error, messages, messages.consultationUnavailable)}
              />
            ) : catalog.data.prescriptionConclusionSupported ? (
              <fieldset className="min-w-0 border-0 p-0" disabled={preparation?.submitting('prescription') === true}><PrescriptionPage
                actions={prescriptionActions}
                recommendationScope={recommendationScope}
                recommendationRevision={recommendationRevision}
                allowWithdrawal={!clinicalReadOnly || correctionTarget === 'medication-conclusion'}
                catalog={catalog.data.medications}
                detail={detail}
                elementId={encounterCompletionTargetElementIds['medication-conclusion']}
                key={`medication-conclusion:${detail.caseId}:${agentDraftHydrationRevisions.prescription ?? 0}`}
                locale={locale}
                messages={messages}
                readOnly={clinicalReadOnly}
                referenceSearch={referenceCatalogSearches.medications}
              /></fieldset>
            ) : null}
          </DoctorDraftScope></DoctorCasePanel>

          <DoctorCasePanel value="laboratory">
            <Tabs onValueChange={value => { if (value === 'laboratory' || value === 'imaging' || value === 'pathology') onSelectInvestigation(value) }} value={investigationView.category}>
              <TabsList aria-label={locale === 'zh-CN' ? '检查分类' : 'Investigation categories'} className="h-auto! max-w-full flex-wrap justify-start" variant="line">
                <TabsTrigger value="laboratory">{locale === 'zh-CN' ? '检验' : 'Laboratory'} <Badge variant="secondary">{detail.laboratoryRequests?.requests.length ?? (detail.report === undefined ? 0 : 1)}</Badge></TabsTrigger>
                <TabsTrigger value="imaging">{locale === 'zh-CN' ? '放射检查' : 'Radiology'} <Badge variant="secondary">{detail.imagingRequests?.requests.length ?? 0}</Badge></TabsTrigger>
                <TabsTrigger value="pathology">{locale === 'zh-CN' ? '病理会诊' : 'Pathology'} <Badge variant="secondary">{detail.pathologyRequests?.requests.length ?? 0}</Badge></TabsTrigger>
              </TabsList>
              <TabsContent keepMounted value="laboratory"><DoctorDraftScope caseId={detail.caseId} kind="laboratory" revision={clinicalReadOnly ? 0 : agentDraftHydrationRevisions['laboratory'] ?? 0} locale={locale}>
                <fieldset className="min-w-0 border-0 p-0" disabled={preparation?.submitting('laboratory') === true}><LaboratoryPage
                  actions={laboratoryRequestActions}
                  recommendationScope={recommendationScope}
                  recommendationRevision={recommendationRevision}
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
                  editDraft={(agentDraftHydrationRevisions.laboratory ?? 0) > 0}
                  active={investigationView.category === 'laboratory'}
                  selectedRequestId={investigationView.selected.laboratory}
                  onSelectRequest={id => onSelectInvestigationRequest('laboratory', id)}
                  selectedReportId={investigationView.reportId}
                  showCorrection={correctionTarget === 'laboratory'}
                /></fieldset>
              </DoctorDraftScope></TabsContent>
              <TabsContent keepMounted value="imaging"><DoctorDraftScope caseId={detail.caseId} kind="imaging" revision={clinicalReadOnly ? 0 : agentDraftHydrationRevisions['imaging'] ?? 0} locale={locale}>
                <fieldset className="min-w-0 border-0 p-0" disabled={preparation?.submitting('imaging') === true}><ImagingPage
                  actions={imagingActions}
                  recommendationScope={recommendationScope}
                  recommendationRevision={recommendationRevision}
                  active={investigationView.category === 'imaging'}
                  caseId={detail.caseId}
                  elementId={encounterCompletionTargetElementIds.imaging}
                  encounter={detail.encounter}
                  key={`imaging:${detail.caseId}:${agentDraftHydrationRevisions.imaging ?? 0}`}
                  locale={locale}
                  readOnly={clinicalReadOnly}
                  state={detail.imagingRequests}
                  editDraft={(agentDraftHydrationRevisions.imaging ?? 0) > 0}
                  selectedRequestId={investigationView.selected.imaging}
                  onSelectRequest={id => onSelectInvestigationRequest('imaging', id)}
                  selectedReportId={investigationView.reportId}
                /></fieldset>
              </DoctorDraftScope></TabsContent>
              <TabsContent keepMounted value="pathology"><DoctorDraftScope caseId={detail.caseId} kind="pathology" revision={clinicalReadOnly ? 0 : agentDraftHydrationRevisions['pathology'] ?? 0} locale={locale}>
                <fieldset className="min-w-0 border-0 p-0" disabled={preparation?.submitting('pathology') === true}><PathologyPage
                  actions={pathologyActions}
                  recommendationScope={recommendationScope}
                  recommendationRevision={recommendationRevision}
                  active={investigationView.category === 'pathology'}
                  caseId={detail.caseId}
                  elementId={encounterCompletionTargetElementIds.pathology}
                  encounter={detail.encounter}
                  key={`pathology:${detail.caseId}:${agentDraftHydrationRevisions.pathology ?? 0}`}
                  locale={locale}
                  readOnly={clinicalReadOnly}
                  state={detail.pathologyRequests}
                  editDraft={(agentDraftHydrationRevisions.pathology ?? 0) > 0}
                  selectedRequestId={investigationView.selected.pathology}
                  onSelectRequest={id => onSelectInvestigationRequest('pathology', id)}
                  selectedReportId={investigationView.reportId}
                /></fieldset>
              </DoctorDraftScope></TabsContent>
            </Tabs>
          </DoctorCasePanel>
        </WorkspaceTabs>
      </div>


    </DoctorCaseLayout>
  )
}
