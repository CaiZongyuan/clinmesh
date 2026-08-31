import type { ClinicalDocumentContent, DoctorCaseDetail } from '@clinmesh/contracts/his'
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
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Textarea } from '@clinmesh/ui/components/textarea'
import {
  CheckCircleIcon,
  CheckIcon,
  CircleAlertIcon,
  ClipboardPenIcon,
  FileSignatureIcon,
  RefreshCwIcon,
} from 'lucide-react'
import { useState } from 'react'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from '../workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { formatClinicalDateTime } from './clinical-date-time.ts'

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
  elementId,
  locale,
  messages,
  onDocumentChange,
  workingDocument,
}: {
  actions: ClinicalDocumentPageActions
  allowRevision: boolean
  detail: DoctorCaseDetail
  elementId: string
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onDocumentChange: (document: ClinicalDocumentContent) => void
  workingDocument: ClinicalDocumentContent
}): React.JSX.Element | null {
  const signedDocuments = detail.clinicalDocument?.signed ?? []
  const latestSignedDocument = signedDocuments.at(-1)
  const [revisionPreview, setRevisionPreview] = useState<ClinicalDocumentRevisionInput>()

  if (
    signedDocuments.length === 0
    && detail.encounter.status !== 'in-progress'
  ) {
    return null
  }

  const currentPreview = actions.prepareSign.data
  return (
    <section
      aria-labelledby="structured-clinical-document-heading"
      className="flex flex-col gap-4"
      id={elementId}
      tabIndex={-1}
    >
      <h3 className="text-sm font-semibold" id="structured-clinical-document-heading">
        {messages.structuredClinicalDocument}
      </h3>
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
                      {messages.signedAt} {formatClinicalDateTime(document.signedAt, locale)}
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
        </>
      ) : (
        <>
          <form
            aria-label={messages.structuredClinicalDocument}
            className="flex flex-col gap-3"
            onSubmit={event => {
              event.preventDefault()
              actions.prepareSign.onSubmit(workingDocument)
            }}
          >
            <ClinicalRecordEditor
              content={workingDocument}
              idPrefix={`clinical-record-${detail.caseId}`}
              messages={messages}
              onChange={onDocumentChange}
            />
            <div className="flex justify-end border-t pt-3">
              <Button disabled={actions.prepareSign.pending} type="submit">
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
              if (!open && !actions.sign.pending) actions.prepareSign.onReset()
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
                <AlertDialogCancel disabled={actions.sign.pending}>{messages.cancel}</AlertDialogCancel>
                <Button
                  disabled={currentPreview === undefined || actions.sign.pending}
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
