import type { ClinicalDocumentContent, ClinicalDocumentQualityControlState, DoctorCaseDetail } from '@clinmesh/contracts/his'
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
} from '@clinmesh/ui/components/alert-dialog'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Textarea } from '@clinmesh/ui/components/textarea'
import {
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  ClipboardPenIcon,
  FileSignatureIcon,
  RefreshCwIcon,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from '../workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { formatClinicalDateTime } from './clinical-date-time.ts'
import { ConsultationRecordingControls, type ConsultationRecordingAction } from './consultation-recording-controls.tsx'
import { ClinicalDocumentUpdateControl, type ClinicalDocumentUpdates } from './clinical-document-updates.tsx'
import {
  DocumentQualityCompact, DocumentQualityDetails, DocumentQualitySignSummary, locateDocumentQualityIssue,
  useDocumentQualityControl, type DocumentQualityControl, type QualityIssue,
} from './document-quality-control.tsx'

function ErrorAlert({ message, title }: { message: string; title: string }): React.JSX.Element {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

export interface ClinicalDocumentSignPreview {
  qualityControl?: ClinicalDocumentQualityControlState | undefined
  expiresAt?: string
  commitToken: string
  document: { content: ClinicalDocumentContent }
  previewId: string
}

export interface ClinicalDocumentRevisionInput {
  caseId: string
  compositionId: string
  compositionVersion: string
  document: ClinicalDocumentContent
  encounterId: string
  encounterVersion: string
  reason: string
}

export interface ClinicalDocumentPageActions {
  cancelSign?: { error: Error | null; pending: boolean; onSubmit: (previewId: string) => void }
  controlRecording?: ConsultationRecordingAction
  save?: {
    error: Error | null
    hasUnsavedChanges?: boolean
    onSubmit: (document: ClinicalDocumentContent) => void
    pending: boolean
    success: boolean
  }
  prepareSign: {
    data: ClinicalDocumentSignPreview | undefined
    error: Error | null
    onReset: () => void
    onSubmit: (document: ClinicalDocumentContent) => void
    pending: boolean
  }
  revise: {
    error: Error | null
    onSubmit: (input: ClinicalDocumentRevisionInput) => void
    pending: boolean
    success: boolean
  }
  sign: {
    error: Error | null
    onSubmit: (preview: ClinicalDocumentSignPreview) => void
    pending: boolean
    success: boolean
  }
}

export function ClinicalDocumentPage({
  actions,
  allowRevision,
  detail,
  updates,
  elementId,
  locale,
  messages,
  onDocumentChange,
  workingDocument,
  qualityScope,
  quality: externalQuality,
  onOpenQualityDetails,
}: {
  actions: ClinicalDocumentPageActions
  allowRevision: boolean
  detail: DoctorCaseDetail
  updates?: ClinicalDocumentUpdates | undefined
  elementId: string
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onDocumentChange: (document: ClinicalDocumentContent) => void
  workingDocument: ClinicalDocumentContent
  qualityScope?: string | undefined
  quality?: DocumentQualityControl | undefined
  onOpenQualityDetails?: (() => void) | undefined
}): React.JSX.Element | null {
  const signedDocuments = (detail.clinicalDocument?.signed ?? [])
    .toSorted((left, right) => right.revisionNumber - left.revisionNumber)
  const latestSignedDocument = signedDocuments[0]
  const [revisionPreview, setRevisionPreview] = useState<ClinicalDocumentRevisionInput>()
  const internalQuality = useDocumentQualityControl({ detail, document: workingDocument, scope: qualityScope,
    enabled: externalQuality === undefined && signedDocuments.length === 0 && detail.encounter.status === 'in-progress' })
  const quality = externalQuality ?? internalQuality
  const [explanationOpen, setExplanationOpen] = useState(false)
  const root = useRef<HTMLElement>(null)
  const pendingLocation = useRef<{ issue: QualityIssue; caseId: string; scope: string | undefined } | null>(null)
  const explanationTitle = locale === 'zh-CN' ? '依据与说明' : 'Basis and details'
  const locateIssue = (issue: QualityIssue) => {
    if (explanationOpen) {
      pendingLocation.current = { issue, caseId: detail.caseId, scope: qualityScope }
      setExplanationOpen(false)
    } else if (root.current !== null) locateDocumentQualityIssue(root.current, issue)
  }

  if (
    signedDocuments.length === 0
    && detail.encounter.status !== 'in-progress'
  ) {
    return null
  }

  const currentPreview = actions.prepareSign.data
  const preparation = detail.consultationRecording?.signingPreparation
  const preparing = currentPreview !== undefined || preparation?.active === true || actions.prepareSign.pending
  const cancelPending = actions.cancelSign?.pending === true
  return (
    <section
      aria-labelledby="structured-clinical-document-heading"
      className="flex flex-col gap-4"
      id={elementId}
      ref={root}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold" id="structured-clinical-document-heading">{messages.structuredClinicalDocument}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {signedDocuments.length > 0 ? null : <Button onClick={onOpenQualityDetails ?? (() => setExplanationOpen(true))}
            size="sm" type="button" variant="ghost">{explanationTitle}</Button>}
          <ConsultationRecordingControls
            recording={detail.consultationRecording} action={actions.controlRecording}
            disabled={signedDocuments.length > 0 || detail.encounter.status !== 'in-progress' || preparing}
            messages={messages} />
        </div>
      </div>
      <Dialog onOpenChange={setExplanationOpen} onOpenChangeComplete={open => {
        if (!open && pendingLocation.current !== null) {
          const target = pendingLocation.current
          if (root.current !== null && target.caseId === detail.caseId && target.scope === qualityScope) locateDocumentQualityIssue(root.current, target.issue)
          pendingLocation.current = null
        }
      }} open={explanationOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>{explanationTitle}</DialogTitle></DialogHeader>
          <div className="min-h-0 overflow-y-auto p-4"><DocumentQualityDetails quality={quality} messages={messages} locale={locale} onLocateIssue={locateIssue} /></div>
        </DialogContent>
      </Dialog>
      {actions.save?.error == null ? null : <ErrorAlert
        message={getWorkspaceErrorMessage(actions.save.error, messages)}
        title={messages.saveClinicalDocumentDraft}
      />}
      {actions.save?.success && !actions.save.hasUnsavedChanges ? <p role="status" className="text-sm text-muted-foreground">{messages.clinicalDocumentDraftSaved}</p> : null}
      {actions.sign.success ? (
        <Alert>
          <CheckCircleIcon aria-hidden="true" />
          <AlertTitle>{messages.clinicalDocumentSigned}</AlertTitle>
          <AlertDescription>{messages.encounterStillInProgress}</AlertDescription>
        </Alert>
      ) : null}
      {signedDocuments.length > 0 ? (
        <>
          {actions.revise.success ? (
            <Alert>
              <CheckIcon aria-hidden="true" />
              <AlertTitle>{messages.clinicalDocumentRevisionSaved}</AlertTitle>
            </Alert>
          ) : null}
          {!allowRevision || latestSignedDocument === undefined ? null : (
            <div className="flex flex-col gap-3">
              <h4 className="text-sm font-semibold">
                {messages.clinicalDocumentRevisionForm}
              </h4>
              <ClinicalDocumentForm
                content={latestSignedDocument.content}
                formName={messages.clinicalDocumentRevisionForm}
                idPrefix={`clinical-document-revision-${latestSignedDocument.compositionId}`}
                includeRevisionReason
                key={`${detail.caseId}:${latestSignedDocument.compositionId}`}
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
                pending={actions.revise.pending}
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
                      disabled={actions.revise.pending}
                      onClick={() => {
                        if (revisionPreview === undefined) return
                        actions.revise.onSubmit(revisionPreview)
                        setRevisionPreview(undefined)
                      }}
                    >
                      <FileSignatureIcon data-icon="inline-start" />
                      {messages.confirmClinicalDocumentRevisionAction}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              {actions.revise.error === null ? null : (
                <ErrorAlert
                  message={getWorkspaceErrorMessage(actions.revise.error, messages)}
                  title={getWorkspaceErrorTitle(actions.revise.error, messages, messages.operationFailed)}
                />
              )}
            </div>
          )}
          <section aria-labelledby="signed-clinical-document-history-heading" className="flex min-w-0 flex-col gap-3 border-t pt-5" key={detail.caseId}>
            <h4 className="text-sm font-semibold" id="signed-clinical-document-history-heading">
              {messages.signedClinicalDocumentHistory}
            </h4>
            <ol className="flex min-w-0 flex-col gap-3">
              {signedDocuments.map(document => (
                <li className="min-w-0" key={document.documentId}>
                  <details className="group rounded-md border">
                    <summary className="flex cursor-pointer list-none items-start gap-3 rounded-md p-3 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                      <span className="flex min-w-0 flex-1 flex-col gap-2">
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">{messages.documentVersion} {document.revisionNumber}</Badge>
                          {document.documentId === latestSignedDocument?.documentId
                            ? <Badge variant="secondary">{messages.latestClinicalDocumentVersion}</Badge> : null}
                          <time className="text-xs text-muted-foreground" dateTime={document.signedAt}>
                            {messages.signedAt} {formatClinicalDateTime(document.signedAt, locale)}
                          </time>
                        </span>
                        {document.revisionReason === undefined ? null : (
                          <span className="line-clamp-2 break-words text-sm text-muted-foreground">
                            {messages.revisionReason}：{document.revisionReason}
                          </span>
                        )}
                      </span>
                      <ChevronDownIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 group-open:rotate-180" />
                    </summary>
                    <div className="flex min-w-0 flex-col gap-3 border-t p-3">
                      {document.revisionReason === undefined ? null : (
                        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                          {messages.revisionReason}：{document.revisionReason}
                        </p>
                      )}
                      <ClinicalDocumentContentView content={document.content} messages={messages} />
                    </div>
                  </details>
                </li>
              ))}
            </ol>
          </section>
        </>
      ) : (
        <>
          {preparation === undefined || currentPreview !== undefined ? null : <Alert>
            <AlertTitle>{messages.consultationSignRecoveryTitle}</AlertTitle>
            <AlertDescription>
              <p>{messages.consultationSignRecoveryDescription}</p>
              <Button type="button" variant="outline" disabled={cancelPending}
                onClick={() => actions.cancelSign?.onSubmit(preparation.previewId)}>{messages.consultationSignReturn}</Button>
            </AlertDescription>
          </Alert>}
          {actions.cancelSign?.error == null ? null : <ErrorAlert title={messages.operationFailed}
            message={getWorkspaceErrorMessage(actions.cancelSign.error, messages)} />}
          {externalQuality === undefined ? <DocumentQualityCompact quality={quality} messages={messages} locale={locale} onLocateIssue={locateIssue} /> : null}
          <form
            aria-label={messages.structuredClinicalDocument}
            className="flex flex-col gap-3"
            onSubmit={event => {
              event.preventDefault()
              actions.prepareSign.onSubmit(workingDocument)
            }}
          >
            <ClinicalRecordEditor
              disabled={preparing || cancelPending}
              content={workingDocument}
              idPrefix={`clinical-record-${detail.caseId}`}
              messages={messages}
              onChange={onDocumentChange}
              updates={updates}
            />
            <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
              {actions.save?.hasUnsavedChanges ? <p role="status" className="mr-auto text-sm text-muted-foreground">
                {messages.clinicalDocumentDraftUnsaved}
              </p> : null}
              {actions.save === undefined ? null : <Button disabled={actions.save.pending || preparing || cancelPending} onClick={() => actions.save?.onSubmit(workingDocument)} type="button" variant="outline">
                {messages.saveClinicalDocumentDraft}
              </Button>}
              <Button disabled={preparing || cancelPending} type="submit">
                {actions.prepareSign.pending
                  ? <RefreshCwIcon aria-hidden="true" className="animate-spin" data-icon="inline-start" />
                  : <FileSignatureIcon aria-hidden="true" data-icon="inline-start" />}
                {actions.prepareSign.pending ? messages.signingClinicalRecord : messages.signClinicalRecord}
              </Button>
            </div>
          </form>
          {actions.prepareSign.error === null ? null : (
            <ErrorAlert
              message={getWorkspaceErrorMessage(actions.prepareSign.error, messages)}
              title={getWorkspaceErrorTitle(actions.prepareSign.error, messages, messages.operationFailed)}
            />
          )}
          <AlertDialog
            onOpenChange={open => {
              if (!open && !actions.sign.pending && !cancelPending) actions.prepareSign.onReset()
            }}
            open={currentPreview !== undefined}
          >
            <AlertDialogContent className="sm:max-w-2xl">
              <AlertDialogHeader>
                <AlertDialogTitle>{messages.confirmClinicalRecordSign}</AlertDialogTitle>
                <AlertDialogDescription>{messages.clinicalDocumentSignDescription}</AlertDialogDescription>
              </AlertDialogHeader>
              {currentPreview === undefined ? null : (
                <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto">
                  <DocumentQualitySignSummary detail={detail} state={currentPreview.qualityControl} scope={qualityScope} locale={locale} />
                  <ClinicalDocumentContentView content={currentPreview.document.content} messages={messages} />
                  {actions.sign.error === null ? null : <ErrorAlert title={messages.operationFailed}
                    message={getWorkspaceErrorMessage(actions.sign.error, messages)} />}
                  {actions.cancelSign?.error == null ? null : <ErrorAlert title={messages.operationFailed}
                    message={getWorkspaceErrorMessage(actions.cancelSign.error, messages)} />}
                </div>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={actions.sign.pending || cancelPending}>
                  {messages.cancel}
                </AlertDialogCancel>
                <Button
                  disabled={currentPreview === undefined || actions.sign.pending || cancelPending}
                  onClick={() => {
                    if (currentPreview !== undefined) actions.sign.onSubmit(currentPreview)
                  }}
                  type="button"
                >
                  {actions.sign.pending
                    ? <RefreshCwIcon aria-hidden="true" className="animate-spin" data-icon="inline-start" />
                    : <CheckCircleIcon aria-hidden="true" data-icon="inline-start" />}
                  {messages.confirmClinicalRecordSign}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {actions.sign.error === null ? null : (
            <ErrorAlert
              message={getWorkspaceErrorMessage(actions.sign.error, messages)}
              title={getWorkspaceErrorTitle(actions.sign.error, messages, messages.operationFailed)}
            />
          )}
        </>
      )}
    </section>
  )
}

function ClinicalRecordEditor({ content, disabled, idPrefix, messages, onChange, updates }: {
  content: ClinicalDocumentContent
  disabled: boolean
  idPrefix: string
  messages: ReturnType<typeof getWorkspaceMessages>
  onChange: (document: ClinicalDocumentContent) => void
  updates: ClinicalDocumentUpdates | undefined
}): React.JSX.Element {
  const fields = [
    { field: 'chiefComplaint', label: messages.chiefComplaint, maxLength: 1_000, multiline: false },
    { field: 'historyOfPresentIllness', label: messages.historyOfPresentIllness, maxLength: 5_000, multiline: true },
    { field: 'priorMedicalHistory', label: messages.priorMedicalHistory, maxLength: 4_000, multiline: true },
    { field: 'familyHistory', label: messages.familyHistory, maxLength: 4_000, multiline: true },
    { field: 'allergyHistory', label: messages.allergyHistory, maxLength: 4_000, multiline: true },
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
        const optional = field === 'familyHistory' || field === 'allergyHistory'
        return (
          <Field data-clinical-document-field={field} className="grid gap-2 border-b px-3 py-2.5 last:border-b-0 @min-[640px]/case-content:grid-cols-[6rem_minmax(0,1fr)] @min-[640px]/case-content:items-start" key={field}>
            <div className="flex flex-wrap items-center gap-2 pt-2 @min-[640px]/case-content:flex-col @min-[640px]/case-content:items-start @min-[640px]/case-content:gap-1">
              <FieldLabel htmlFor={id}>{label}</FieldLabel>
              {updates?.fields[field] === undefined ? null : <span className="clinical-document-update-label" role="status">{messages.clinicalDocumentFieldUpdated}</span>}
            </div>
            <div className="flex min-w-0 flex-col gap-2">
            <ClinicalDocumentUpdateControl field={field} updates={updates}>
            {multiline ? (
              <Textarea
                disabled={disabled}
                className="min-h-10 resize-y"
                id={id}
                maxLength={maxLength}
                minLength={optional ? undefined : 2}
                onChange={event => onChange({ ...content, [field]: event.currentTarget.value })}
                required={!optional}
                value={value}
              />
            ) : (
              <Input
                disabled={disabled}
                id={id}
                maxLength={maxLength}
                minLength={optional ? undefined : 2}
                onChange={event => onChange({ ...content, [field]: event.currentTarget.value })}
                required={!optional}
                value={value}
              />
            )}
            </ClinicalDocumentUpdateControl>
            {optional ? <FieldDescription>{messages.clinicalHistoryOptional}</FieldDescription> : null}
            </div>
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
          allergyHistory: String(data.get('allergyHistory') ?? ''),
          assessment: String(data.get('assessment') ?? ''),
          auxiliaryExamination: String(data.get('auxiliaryExamination') ?? ''),
          chiefComplaint: String(data.get('chiefComplaint') ?? ''),
          disposition: String(data.get('disposition') ?? ''),
          followUp: String(data.get('followUp') ?? ''),
          familyHistory: String(data.get('familyHistory') ?? ''),
          historyOfPresentIllness: String(data.get('historyOfPresentIllness') ?? ''),
          physicalExamination: String(data.get('physicalExamination') ?? ''),
          priorMedicalHistory: String(data.get('priorMedicalHistory') ?? ''),
        }, String(data.get('revisionReason') ?? ''))
      }}
    >
      <FieldGroup className="grid grid-cols-1 gap-0 overflow-hidden rounded-md border @min-[768px]/case-content:grid-cols-2">
        <Field className="border-b p-3 @min-[768px]/case-content:col-span-2">
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
        <Field className="border-b p-3 @min-[768px]/case-content:col-span-2">
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
        <Field className="border-b p-3 @min-[768px]/case-content:col-span-2">
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
        {(['familyHistory', 'allergyHistory'] as const).map(field => (
          <Field className="border-b p-3 @min-[768px]/case-content:col-span-2" key={field}>
            <FieldLabel htmlFor={`${idPrefix}-${field}`}>{messages[field]}</FieldLabel>
            <Textarea defaultValue={content[field] ?? ''} id={`${idPrefix}-${field}`} maxLength={4_000} name={field} />
            <FieldDescription>{messages.clinicalHistoryOptional}</FieldDescription>
          </Field>
        ))}
        <Field className="border-b p-3 @min-[768px]/case-content:col-span-2">
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
        <Field className="border-b p-3 @min-[768px]/case-content:col-span-2">
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
        <Field className="border-b p-3 @min-[768px]/case-content:border-r">
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
        <Field className="border-b p-3 @min-[768px]/case-content:col-span-2">
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
          <Field className="border-b p-3 @min-[768px]/case-content:col-span-2">
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
        <Field className="items-end p-3 @min-[768px]/case-content:col-span-2">
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

export function ClinicalDocumentContentView({ content, messages }: {
  content: ClinicalDocumentContent
  messages: ReturnType<typeof getWorkspaceMessages>
}): React.JSX.Element {
  const fields = ['chiefComplaint', 'historyOfPresentIllness', 'priorMedicalHistory', 'familyHistory', 'allergyHistory', 'physicalExamination',
    'auxiliaryExamination', 'assessment', 'disposition', 'followUp'] as const
  return (
    <dl className="grid grid-cols-1 gap-3 text-sm @min-[768px]/case-content:grid-cols-2">
      {fields.map(field => {
        if (content[field] === undefined) return null
        return <div key={field} data-clinical-document-field={field}>
          <dt className="text-muted-foreground">{messages[field]}</dt>
          <dd className="whitespace-pre-wrap break-words font-medium">{content[field] || messages.clinicalHistoryNotRecorded}</dd>
        </div>
      })}
    </dl>
  )
}
