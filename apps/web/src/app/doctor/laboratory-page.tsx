import type {
  ClinicalCatalog,
  DoctorCaseDetail,
  LaboratoryReport,
  LaboratoryRequest,
} from '@clinmesh/contracts/his'
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
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Textarea } from '@clinmesh/ui/components/textarea'
import {
  CheckIcon,
  CircleAlertIcon,
  CircleXIcon,
  FlaskConicalIcon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from '../workspace-error.ts'
import { formatLaboratoryPrice } from '../workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { WorkspaceSelect } from '../workspace-select.tsx'
import {
  LaboratoryCatalogDialog,
  type LaboratoryCatalogSelection,
  type ReferenceCatalogSearches,
} from './catalog-picker-dialogs.tsx'
import { useAutosave } from './use-autosave.ts'

export interface LaboratoryPageActions {
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

export interface LaboratoryReportCorrectionInput {
  conclusion: string
  reason: string
  results: Array<{ code: string; value: number }>
}

type WorkspaceMessages = ReturnType<typeof getWorkspaceMessages>

function ErrorAlert({ message, title }: { message: string; title: string }): React.JSX.Element {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

export function LaboratoryPage({
  actions,
  catalogError,
  catalogPending,
  detail,
  elementId,
  indicationCode,
  issueLegacyOrderError,
  issueLegacyOrderPending,
  laboratoryCatalog,
  laboratoryItemId,
  locale,
  messages,
  onIndicationChange,
  onIssueLegacyOrder,
  onLaboratoryItemChange,
  readOnly,
  referenceSearch,
  showCorrection,
}: {
  actions: LaboratoryPageActions
  catalogError: Error | null
  catalogPending: boolean
  detail: DoctorCaseDetail
  elementId: string
  indicationCode: string
  issueLegacyOrderError: Error | null
  issueLegacyOrderPending: boolean
  laboratoryCatalog: ClinicalCatalog['laboratory']
  laboratoryItemId: string
  locale: WorkspaceLocale
  messages: WorkspaceMessages
  onIndicationChange: (value: string) => void
  onIssueLegacyOrder: () => void
  onLaboratoryItemChange: (value: string) => void
  readOnly: boolean
  referenceSearch: ReferenceCatalogSearches['laboratory']
  showCorrection: boolean
}): React.JSX.Element {
  const firstVisitDraft = detail.drafts?.firstVisit
  const laboratoryItems = laboratoryCatalog.map(item => ({
    label: `${locale === 'zh-CN' ? item.nameZh : item.nameEn} · ${formatLaboratoryPrice(item.priceFen ?? 0, locale)}`,
    value: item.id,
  }))
  const indicationItems = laboratoryCatalog
    .find(item => item.id === laboratoryItemId)
    ?.allowedIndicationCodes.map(code => ({
      label: indicationLabel(code, messages),
      value: code,
    })) ?? []
  const legacyLaboratoryOrder = readOnly
    || detail.consultation !== undefined
    || detail.status !== 'first-visit'
    ? null
    : (
        <section aria-labelledby="laboratory-order-heading" className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold" id="laboratory-order-heading">{messages.laboratoryOrder}</h3>
          {catalogPending ? <Skeleton className="h-20 w-full" /> : catalogError !== null ? (
            <ErrorAlert
              message={getWorkspaceErrorMessage(catalogError, messages)}
              title={getWorkspaceErrorTitle(catalogError, messages, messages.consultationUnavailable)}
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
                  disabled={firstVisitDraft === undefined || issueLegacyOrderPending}
                  onClick={onIssueLegacyOrder}
                  type="button"
                >
                  <FlaskConicalIcon data-icon="inline-start" />
                  {messages.issueLaboratoryOrder}
                </Button>
              </div>
              {issueLegacyOrderError === null ? null : (
                <ErrorAlert
                  message={getWorkspaceErrorMessage(issueLegacyOrderError, messages)}
                  title={getWorkspaceErrorTitle(issueLegacyOrderError, messages, messages.operationFailed)}
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

  return (
    <div className="@container/laboratory">
      <div id={elementId} tabIndex={-1}>
        {detail.consultation === undefined ? (
          <div className="grid min-w-0 gap-5 @2xl/laboratory:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.2fr)]">
            <div>{legacyLaboratoryOrder}</div>
            <section aria-labelledby="legacy-laboratory-results-heading" className="flex min-w-0 flex-col gap-3">
              <h3 className="text-sm font-semibold" id="legacy-laboratory-results-heading">{messages.laboratoryResults}</h3>
              {detail.report === undefined ? null : (
                <LaboratoryReportView locale={locale} messages={messages} report={detail.report} />
              )}
              {awaitingReport}
              {detail.report === undefined && awaitingReport === null ? (
                <p className="text-sm text-muted-foreground">{messages.noLaboratoryRequests}</p>
              ) : null}
            </section>
          </div>
        ) : catalogPending ? <Skeleton className="h-72 w-full" /> : catalogError !== null ? (
          <ErrorAlert
            message={getWorkspaceErrorMessage(catalogError, messages)}
            title={getWorkspaceErrorTitle(catalogError, messages, messages.consultationUnavailable)}
          />
        ) : (
          <LaboratoryRequestEditor
            actions={actions}
            caseId={detail.caseId}
            catalog={laboratoryCatalog}
            indicationCode={indicationCode}
            indicationItems={indicationItems}
            key={`laboratory-request:${detail.caseId}:${detail.laboratoryRequests?.draftVersion ?? 0}`}
            laboratoryItemId={laboratoryItemId}
            locale={locale}
            messages={messages}
            onIndicationChange={onIndicationChange}
            onLaboratoryItemChange={onLaboratoryItemChange}
            readOnly={readOnly}
            referenceSearch={referenceSearch}
            showCorrection={showCorrection}
            state={detail.laboratoryRequests}
          />
        )}
      </div>
    </div>
  )
}

function LaboratoryRequestEditor({
  actions,
  caseId,
  catalog,
  indicationCode,
  indicationItems,
  laboratoryItemId,
  locale,
  messages,
  onIndicationChange,
  onLaboratoryItemChange,
  readOnly,
  referenceSearch,
  showCorrection,
  state,
}: {
  actions: LaboratoryPageActions
  caseId: string
  catalog: ClinicalCatalog['laboratory']
  indicationCode: string
  indicationItems: Array<{ label: string; value: string }>
  laboratoryItemId: string
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onIndicationChange: (value: string) => void
  onLaboratoryItemChange: (value: string) => void
  readOnly: boolean
  referenceSearch: ReferenceCatalogSearches['laboratory']
  showCorrection: boolean
  state: DoctorCaseDetail['laboratoryRequests']
}): React.JSX.Element {
  const catalogById = useMemo(() => new Map(catalog.map(item => [item.id, item])), [catalog])
  const [selectedReference, setSelectedReference] = useState<LaboratoryCatalogSelection | undefined>(
    () => {
      const reference = state?.draft?.referenceConcept
      return reference === undefined
        ? undefined
        : {
            catalogItemId: reference.id,
            code: reference.code,
            display: reference.display,
            referenceConcept: {
              ...reference,
              domain: 'laboratory',
              status: 'active',
            },
          }
    },
  )
  const draftItem = state?.draft === undefined
    ? undefined
    : catalogById.get(state.draft.catalogItemId)
  const selectedItem = catalogById.get(laboratoryItemId)
  const selectedDisplay = (locale === 'zh-CN' ? selectedItem?.nameZh : selectedItem?.nameEn)
    ?? selectedReference?.display
    ?? state?.draft?.referenceConcept?.display
  const selectedCode = selectedReference?.code
    ?? state?.draft?.referenceConcept?.code
    ?? selectedItem?.id
  const draftMatchesSelection = state?.draft?.catalogItemId === laboratoryItemId
    && state.draft.indicationCode === indicationCode
  const effectiveIndicationItems = indicationItems.length > 0
    ? indicationItems
    : laboratoryItemId.length === 0 || indicationCode.length === 0
      ? []
      : [{ label: indicationLabel(indicationCode, messages), value: indicationCode }]
  useAutosave({
    delayMs: 800,
    enabled: !readOnly
      && !actions.save.pending
      && laboratoryItemId.length > 0
      && indicationCode.length > 0
      && !draftMatchesSelection,
    onSave: actions.save.onSubmit,
    revision: `${caseId}:${state?.draftVersion ?? 0}:${laboratoryItemId}:${indicationCode}`,
  })
  const requestHeadingId = `laboratory-request-heading-${caseId}`
  const resultsHeadingId = `laboratory-results-heading-${caseId}`
  return (
    <div className="grid min-w-0 gap-5 @2xl/laboratory:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.2fr)]">
      {readOnly ? null : (
        <section aria-labelledby={requestHeadingId} className="flex min-w-0 flex-col gap-3">
          <h3 className="text-sm font-semibold" id={requestHeadingId}>{messages.laboratoryOrder}</h3>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="laboratory-item">{messages.laboratoryItem}</FieldLabel>
              <div className="flex min-h-16 items-center justify-between gap-3 border px-3 py-2" id="laboratory-item">
                <span className="min-w-0">
                  {selectedDisplay === undefined ? (
                    <span className="text-sm text-muted-foreground">
                      {locale === 'zh-CN' ? '尚未选择检验项目' : 'No laboratory item selected'}
                    </span>
                  ) : (
                    <>
                      <strong className="block truncate text-sm">{selectedDisplay}</strong>
                      <span className="mt-1 block break-all font-mono text-xs text-muted-foreground">
                        {selectedCode}
                      </span>
                    </>
                  )}
                </span>
                <LaboratoryCatalogDialog
                  locale={locale}
                  onSelect={(selection) => {
                    setSelectedReference(selection)
                    onLaboratoryItemChange(selection.catalogItemId)
                  }}
                  search={referenceSearch}
                />
              </div>
            </Field>
            {laboratoryItemId.length === 0 ? null : <Field>
              <FieldLabel htmlFor="laboratory-indication">{messages.laboratoryIndication}</FieldLabel>
              {effectiveIndicationItems.length === 1 ? (
                <div className="flex h-8 items-center rounded-md border px-2.5 text-sm" id="laboratory-indication">
                  {effectiveIndicationItems[0]?.label}
                </div>
              ) : (
                <WorkspaceSelect id="laboratory-indication" items={effectiveIndicationItems} onValueChange={value => onIndicationChange(value ?? '')} value={indicationCode} />
              )}
            </Field>}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <p aria-live="polite" className="mr-auto text-xs text-muted-foreground">
                {actions.save.error !== null
                  ? messages.autosaveFailed
                  : actions.save.pending
                  ? messages.autosaveSaving
                  : !draftMatchesSelection
                    ? messages.autosavePending
                    : state?.draft === undefined ? '' : messages.autosaveSaved}
              </p>
              {state?.draft === undefined ? null : (
                <>
                  <AlertDialog>
                    <AlertDialogTrigger render={<Button disabled={actions.deleteDraft.pending || actions.issue.pending || actions.save.pending || !draftMatchesSelection} type="button" variant="destructive" />}>
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
                              ?? (locale === 'zh-CN'
                                ? state.draft.laboratoryService?.nameZh
                                : state.draft.laboratoryService?.nameEn)
                              ?? state.draft.referenceConcept?.display
                              ?? state.draft.catalogItemId}
                          </dd>
                        </div>
                      </dl>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
                        <AlertDialogAction
                          disabled={actions.deleteDraft.pending || actions.save.pending}
                          onClick={actions.deleteDraft.onSubmit}
                          variant="destructive"
                        >
                          <Trash2Icon data-icon="inline-start" />{messages.confirmDelete}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  <Button
                    disabled={actions.issue.pending || actions.save.pending || !draftMatchesSelection}
                    onClick={actions.issue.onSubmit}
                    type="button"
                  >
                    <FlaskConicalIcon data-icon="inline-start" />{messages.issueLaboratoryRequest}
                  </Button>
                </>
              )}
            </div>
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
          </FieldGroup>
        </section>
      )}
      <section
        aria-labelledby={resultsHeadingId}
        className={readOnly
          ? 'flex min-w-0 flex-col gap-2 @2xl/laboratory:col-span-2'
          : 'flex min-w-0 flex-col gap-2'}
      >
        <h3 className="text-sm font-semibold" id={resultsHeadingId}>{messages.laboratoryResults}</h3>
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
                  ?? (locale === 'zh-CN'
                    ? request.laboratoryService?.nameZh
                    : request.laboratoryService?.nameEn)
                  ?? request.referenceConcept?.display
                  ?? request.catalogItemId
                return (
                  <TableRow key={request.id}>
                    <TableCell className="break-words whitespace-normal font-medium">{itemName}</TableCell>
                    <TableCell className="break-words whitespace-normal">{indicationLabel(request.indicationCode, messages)}</TableCell>
                    <TableCell className="break-words whitespace-normal"><Badge variant="outline">{laboratoryRequestStatusLabel(request, messages)}</Badge>{request.generationError === undefined ? null : <p className="mt-1 text-xs text-destructive">{generationErrorMessage(locale)}</p>}</TableCell>
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
                        <CancelLaboratoryRequestButton
                          action={actions.cancel}
                          itemName={itemName}
                          messages={messages}
                          request={request}
                        />
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
                {(locale === 'zh-CN' ? item?.nameZh : item?.nameEn)
                  ?? (locale === 'zh-CN'
                    ? request.laboratoryService?.nameZh
                    : request.laboratoryService?.nameEn)
                  ?? request.referenceConcept?.display}
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
              itemName={(locale === 'zh-CN' ? item?.nameZh : item?.nameEn)
                ?? (locale === 'zh-CN'
                  ? request.laboratoryService?.nameZh
                  : request.laboratoryService?.nameEn)
                ?? request.referenceConcept?.display
                ?? request.catalogItemId}
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
      </section>
    </div>
  )
}

function generationErrorMessage(locale: WorkspaceLocale): string {
  return locale === 'zh-CN'
    ? '结果生成失败，可重试。'
    : 'Result generation failed. You can retry.'
}

function CancelLaboratoryRequestButton({ action, itemName, messages, request }: {
  action: LaboratoryPageActions['cancel']
  itemName: string
  messages: ReturnType<typeof getWorkspaceMessages>
  request: LaboratoryRequest
}): React.JSX.Element {
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={(
          <Button
            aria-label={`${messages.cancelLaboratoryRequest} ${itemName}`}
            disabled={action.pending}
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
            disabled={action.pending}
            onClick={() => action.onSubmit(request)}
            variant="destructive"
          >
            <CircleXIcon data-icon="inline-start" />
            {messages.confirmCancelLaboratoryRequest}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function LaboratoryRequestReport({ action, correctionAction, itemName, locale, messages, readOnly, request, showCorrection }: {
  action: LaboratoryPageActions['acknowledge']
  correctionAction: LaboratoryPageActions['correct']
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
  action: LaboratoryPageActions['correct']
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


function LaboratoryReportView({ locale, messages, report }: {
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
  if (code === 'fever') return messages.indication_fever
  if (code === 'clinical-evaluation') return messages.indication_clinicalEvaluation
  return code
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
  value: boolean | number | string | { code: string; display: string; system: string },
  unit: string | undefined,
  locale: WorkspaceLocale,
  messages: ReturnType<typeof getWorkspaceMessages>,
): string {
  if (typeof value === 'boolean') return value ? messages.positive : messages.negative
  if (typeof value === 'object') return value.display
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
