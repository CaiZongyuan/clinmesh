import type { ClinicalCatalog, DoctorCaseDetail, DoctorQueueItem, SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@clinmesh/ui/components/select'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircleIcon, CheckIcon, CircleAlertIcon, ClipboardPenIcon, FileSignatureIcon, FlaskConicalIcon, PlusIcon, RefreshCwIcon, ShieldAlertIcon, StethoscopeIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import {
  getClinicalCatalog,
  getDoctorCase,
  getDoctorQueue,
  issueLaboratoryOrder,
  newIdempotencyKey,
  previewClinicalSign,
  saveFirstVisitDraft,
  saveRevisitDraft,
  signClinicalDocument,
  startFirstVisit,
  startRevisit,
} from './api-client.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { allergyWarningLabel } from './allergy-warning.ts'
import { PaginationControls } from './pagination-controls.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import { formatFen } from './workspace-format.ts'

interface DoctorWorkspaceProps {
  locale: WorkspaceLocale
  session: SessionContext
}

export function DoctorWorkspace({ locale, session }: DoctorWorkspaceProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const queryClient = useQueryClient()
  const scope = [session.actor.workspaceId, session.actor.epoch] as const
  const [page, setPage] = useState(1)
  const queueKey = ['doctor-queue', ...scope, page] as const
  const queue = useQuery({
    queryFn: ({ signal }) => getDoctorQueue(signal, page),
    queryKey: queueKey,
    refetchInterval: query => query.state.data?.items.some(item => item.status === 'awaiting-report') === true
      ? 1_500
      : false,
  })
  const [selectedCaseId, setSelectedCaseId] = useState<string>()
  const [laboratoryItemId, setLaboratoryItemId] = useState('')
  const [indicationCode, setIndicationCode] = useState('')
  const selectedCase = queue.data?.items.find(item => item.caseId === selectedCaseId)
    ?? queue.data?.items[0]
  const detailKey = [
    'doctor-case',
    ...scope,
    selectedCase?.caseId,
    selectedCase?.diagnosticReportId,
  ] as const
  const detail = useQuery({
    enabled: selectedCase !== undefined,
    queryFn: ({ signal }) => getDoctorCase(selectedCase?.caseId ?? '', signal),
    queryKey: detailKey,
    refetchInterval: selectedCase?.status === 'awaiting-report' ? 1_500 : false,
  })
  const catalog = useQuery({
    queryFn: ({ signal }) => getClinicalCatalog(signal),
    queryKey: ['clinical-catalog', ...scope],
  })
  const refreshCase = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queueKey }),
      queryClient.invalidateQueries({ queryKey: detailKey }),
    ])
  }
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
      const catalogItemId = laboratoryItemId || catalog.data.laboratory[0]?.id
      const catalogItem = catalog.data.laboratory.find(item => item.id === catalogItemId)
      const expectedDraftVersion = detail.data.drafts?.firstVisit?.version
      const resolvedIndicationCode = indicationCode || catalogItem?.allowedIndicationCodes[0]
      if (
        catalogItemId === undefined
        || expectedDraftVersion === undefined
        || resolvedIndicationCode === undefined
      ) {
        throw new Error(messages.consultationUnavailable)
      }
      return issueLaboratoryOrder({
        catalogItemId,
        encounterId: detail.data.encounter.id,
        encounterVersion: detail.data.encounter.versionId,
        expectedDraftVersion,
        indicationCode: resolvedIndicationCode,
        taskId: detail.data.taskId,
        taskVersion: detail.data.taskVersion,
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
  const resolvedLaboratoryItemId = laboratoryItemId || catalog.data?.laboratory[0]?.id || ''
  const resolvedLaboratoryItem = catalog.data?.laboratory.find(
    item => item.id === resolvedLaboratoryItemId,
  )
  const resolvedIndicationCode = indicationCode || resolvedLaboratoryItem?.allowedIndicationCodes[0] || ''

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(18rem,0.72fr)_minmax(30rem,1.28fr)]">
      <section aria-labelledby="consultation-queue-heading" className="flex min-w-0 flex-col gap-4 border-b pb-6 xl:border-r xl:border-b-0 xl:pr-6">
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
                onSelect={() => setSelectedCaseId(item.caseId)}
                selected={item.caseId === selectedCase?.caseId}
              />
            ))}
            <PaginationControls
              messages={messages}
              onPageChange={(nextPage) => {
                setPage(nextPage)
                setSelectedCaseId(undefined)
              }}
              page={queue.data.page}
              pageSize={queue.data.pageSize}
              total={queue.data.total}
            />
          </div>
        )}
      </section>

      <section aria-labelledby="case-detail-heading" className="flex min-w-0 flex-col gap-5">
        <h2 className="text-base font-semibold" id="case-detail-heading">{messages.caseDetail}</h2>
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
        {detail.isPending && selectedCase !== undefined ? <Skeleton className="h-64 w-full" /> : detail.isError ? (
          <ErrorAlert message={getWorkspaceErrorMessage(detail.error, messages)} title={getWorkspaceErrorTitle(detail.error, messages, messages.consultationUnavailable)} />
        ) : detail.data === undefined ? (
          <Empty className="min-h-44 border"><EmptyHeader><EmptyMedia variant="icon"><ClipboardPenIcon aria-hidden="true" /></EmptyMedia><EmptyTitle>{messages.noConsultationCases}</EmptyTitle></EmptyHeader></Empty>
        ) : (
          <CaseDetail
            catalog={catalog}
            detail={detail.data}
            indicationCode={resolvedIndicationCode}
            laboratoryItemId={resolvedLaboratoryItemId}
            locale={locale}
            messages={messages}
            onIndicationChange={setIndicationCode}
            onLaboratoryItemChange={(value) => {
              setLaboratoryItemId(value)
              setIndicationCode('')
            }}
            onIssueOrder={() => issueOrder.mutate()}
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
          />
        )}
      </section>
    </div>
  )
}

function CaseDetail({
  catalog,
  detail,
  indicationCode,
  issueOrderError,
  issueOrderPending,
  laboratoryItemId,
  locale,
  messages,
  onIssueOrder,
  onIndicationChange,
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
}: {
  catalog: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getClinicalCatalog>>>>
  detail: DoctorCaseDetail
  indicationCode: string
  issueOrderError: Error | null
  issueOrderPending: boolean
  laboratoryItemId: string
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onIssueOrder: () => void
  onIndicationChange: (value: string) => void
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
}): React.JSX.Element {
  const firstVisitDraft = detail.drafts?.firstVisit
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div>
          <div className="text-lg font-semibold">{detail.patient.name}</div>
          <div className="text-sm text-muted-foreground">{detail.patient.identifier}</div>
        </div>
        <Badge variant="outline">{statusLabel(detail.status, messages)}</Badge>
      </div>
      <section aria-labelledby="triage-summary-heading" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold" id="triage-summary-heading">{messages.triageSummary}</h3>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div><dt className="text-muted-foreground">{messages.chiefComplaint}</dt><dd className="font-medium">{detail.triage.chiefComplaint}</dd></div>
          <div><dt className="text-muted-foreground">{messages.temperatureC}</dt><dd className="font-medium">{detail.triage.temperatureC}</dd></div>
          <div><dt className="text-muted-foreground">{messages.acuity}</dt><dd className="font-medium">{detail.triage.acuityCode}</dd></div>
        </dl>
      </section>
      <section aria-labelledby="prior-facts-heading" className="flex flex-col gap-2 border-b pb-4">
        <h3 className="text-sm font-semibold" id="prior-facts-heading">{messages.priorFacts}</h3>
        {detail.priorFacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{messages.noPriorFacts}</p>
        ) : (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {detail.priorFacts.map(fact => (
              <li key={fact.id}>{fact.display || fact.code}{fact.recordedDate === undefined ? '' : ` · ${fact.recordedDate}`}</li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="allergy-summary-heading" className="flex flex-col gap-2 border-b pb-4">
        <h3 className="text-sm font-semibold" id="allergy-summary-heading">{messages.allergySummary}</h3>
        {detail.allergies.length === 0 ? (
          <p className="text-sm text-muted-foreground">{messages.noKnownAllergies}</p>
        ) : (
          <Alert variant="destructive">
            <ShieldAlertIcon aria-hidden="true" />
            <AlertTitle>{messages.allergySummary}</AlertTitle>
            <AlertDescription>
              <ul className="flex list-disc flex-col gap-1 pl-4">
                {detail.allergies.map((allergy, index) => (
                  <li key={index}>{allergyWarningLabel(allergy)}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
      </section>
      {detail.report === undefined ? null : (
        <LaboratoryReport locale={locale} messages={messages} report={detail.report} />
      )}
      {detail.status === 'awaiting-doctor' ? (
        <div className="flex flex-col items-start gap-3">
          <Button disabled={startPending} onClick={onStart} type="button"><StethoscopeIcon data-icon="inline-start" />{messages.startFirstVisit}</Button>
          {startError === null ? null : <ErrorAlert message={getWorkspaceErrorMessage(startError, messages)} title={getWorkspaceErrorTitle(startError, messages, messages.operationFailed)} />}
        </div>
      ) : detail.status === 'first-visit' ? (
        <div className="flex flex-col gap-6">
          <section aria-labelledby="first-visit-heading" className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold" id="first-visit-heading">{messages.firstVisitRecord}</h3>
            <form
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
                <Field><FieldLabel htmlFor="first-visit-history">{messages.historyOfPresentIllness}</FieldLabel><Textarea defaultValue={firstVisitDraft?.historyOfPresentIllness} id="first-visit-history" name="historyOfPresentIllness" required /></Field>
                <Field><FieldLabel htmlFor="first-visit-assessment">{messages.firstVisitAssessment}</FieldLabel><Textarea defaultValue={firstVisitDraft?.assessment} id="first-visit-assessment" name="assessment" required /></Field>
                <div className="flex justify-end"><Button disabled={saveDraftPending} type="submit"><ClipboardPenIcon data-icon="inline-start" />{messages.saveFirstVisitDraft}</Button></div>
                {saveDraftSuccess ? <Alert><CheckIcon aria-hidden="true" /><AlertTitle>{messages.draftSaved}</AlertTitle></Alert> : null}
                {saveDraftError === null ? null : <ErrorAlert message={getWorkspaceErrorMessage(saveDraftError, messages)} title={getWorkspaceErrorTitle(saveDraftError, messages, messages.operationFailed)} />}
              </FieldGroup>
            </form>
          </section>
          <section aria-labelledby="laboratory-order-heading" className="flex flex-col gap-3 border-t pt-5">
            <h3 className="text-sm font-semibold" id="laboratory-order-heading">{messages.laboratoryOrder}</h3>
            {catalog.isPending ? <Skeleton className="h-20 w-full" /> : catalog.isError ? <ErrorAlert message={getWorkspaceErrorMessage(catalog.error, messages)} title={getWorkspaceErrorTitle(catalog.error, messages, messages.consultationUnavailable)} /> : (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="laboratory-item">{messages.laboratoryItem}</FieldLabel>
                  <Select onValueChange={value => onLaboratoryItemChange(value ?? '')} value={laboratoryItemId}>
                    <SelectTrigger className="w-full" id="laboratory-item"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectGroup>{catalog.data.laboratory.map(item => (
                      <SelectItem key={item.id} value={item.id}>{locale === 'zh-CN' ? item.nameZh : item.nameEn} · {formatFen(item.priceFen ?? 0, locale)}</SelectItem>
                    ))}</SelectGroup></SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="laboratory-indication">{messages.laboratoryIndication}</FieldLabel>
                  <Select onValueChange={value => onIndicationChange(value ?? '')} value={indicationCode}>
                    <SelectTrigger className="w-full" id="laboratory-indication"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectGroup>{catalog.data.laboratory.find(item => item.id === laboratoryItemId)?.allowedIndicationCodes.map(code => (
                      <SelectItem key={code} value={code}>{indicationLabel(code, messages)}</SelectItem>
                    ))}</SelectGroup></SelectContent>
                  </Select>
                </Field>
                <div className="flex justify-end"><Button disabled={firstVisitDraft === undefined || issueOrderPending} onClick={onIssueOrder} type="button"><FlaskConicalIcon data-icon="inline-start" />{messages.issueLaboratoryOrder}</Button></div>
                {issueOrderError === null ? null : <ErrorAlert message={getWorkspaceErrorMessage(issueOrderError, messages)} title={getWorkspaceErrorTitle(issueOrderError, messages, messages.operationFailed)} />}
              </FieldGroup>
            )}
          </section>
        </div>
      ) : detail.status === 'awaiting-report' ? (
        <Alert>
          <RefreshCwIcon aria-hidden="true" />
          <AlertTitle>{messages.awaitingLisReport}</AlertTitle>
          <AlertDescription>{messages.awaitingLisReportDescription}</AlertDescription>
        </Alert>
      ) : detail.status === 'awaiting-revisit' ? (
        <div className="flex flex-col items-start gap-3">
          <Button disabled={startRevisitPending} onClick={onStartRevisit} type="button">
            <StethoscopeIcon data-icon="inline-start" />{messages.startRevisit}
          </Button>
          {startRevisitError === null ? null : <ErrorAlert message={getWorkspaceErrorMessage(startRevisitError, messages)} title={getWorkspaceErrorTitle(startRevisitError, messages, messages.operationFailed)} />}
        </div>
      ) : detail.status === 'revisit-draft' ? (
        catalog.isPending ? <Skeleton className="h-72 w-full" /> : catalog.isError ? (
          <ErrorAlert message={getWorkspaceErrorMessage(catalog.error, messages)} title={getWorkspaceErrorTitle(catalog.error, messages, messages.consultationUnavailable)} />
        ) : (
          <div className="flex flex-col gap-3">
            {saveRevisitSuccess ? (
              <Alert>
                <CheckIcon aria-hidden="true" />
                <AlertTitle>{messages.revisitDraftSaved}</AlertTitle>
              </Alert>
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
            {saveRevisitError === null ? null : <ErrorAlert message={getWorkspaceErrorMessage(saveRevisitError, messages)} title={getWorkspaceErrorTitle(saveRevisitError, messages, messages.operationFailed)} />}
            {signCompleted ? null : (
              <section aria-labelledby="clinical-sign-heading" className="flex flex-col gap-3 border-t pt-5">
                <div className="flex justify-end">
                  <Button disabled={signPreviewPending} onClick={onPreviewSign} type="button" variant="outline">
                    <FileSignatureIcon data-icon="inline-start" />{messages.previewClinicalSign}
                  </Button>
                </div>
                {signPreviewError === null ? null : <ErrorAlert message={getWorkspaceErrorMessage(signPreviewError, messages)} title={getWorkspaceErrorTitle(signPreviewError, messages, messages.operationFailed)} />}
                {signPreview === undefined ? null : (
                  <div className="flex flex-col gap-3">
                    <h3 className="text-sm font-semibold" id="clinical-sign-heading">{messages.clinicalSignPreview}</h3>
                    <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                      <div><dt className="text-muted-foreground">{messages.diagnosis}</dt><dd className="font-medium">{signPreview.summary.diagnosis.code} · {signPreview.summary.diagnosis.display}</dd></div>
                      <div><dt className="text-muted-foreground">{messages.documentSummary}</dt><dd className="font-medium">{signPreview.summary.document.assessment}</dd><dd className="text-muted-foreground">{signPreview.summary.document.plan}</dd></div>
                      <div><dt className="text-muted-foreground">{messages.amount}</dt><dd className="font-medium">{formatFen(signPreview.medicationTotalFen, locale)}</dd></div>
                    </dl>
                    <Table>
                      <TableHeader><TableRow><TableHead>{messages.medication}</TableHead><TableHead>{messages.quantity}</TableHead><TableHead>{messages.unitPrice}</TableHead><TableHead>{messages.subtotal}</TableHead></TableRow></TableHeader>
                      <TableBody>{signPreview.summary.medications.map(medication => (
                        <TableRow key={medication.medicationRequestId}>
                          <TableCell className="font-medium">{locale === 'zh-CN' ? medication.nameZh : medication.nameEn}</TableCell>
                          <TableCell>{medication.quantity}</TableCell>
                          <TableCell>{formatFen(medication.unitPriceFen, locale)}</TableCell>
                          <TableCell>{formatFen(medication.subtotalFen, locale)}</TableCell>
                        </TableRow>
                      ))}</TableBody>
                    </Table>
                    <div className="flex justify-end">
                      <Button disabled={signPending} onClick={onSign} type="button">
                        <CheckCircleIcon data-icon="inline-start" />{messages.confirmClinicalSign}
                      </Button>
                    </div>
                  </div>
                )}
                {signError === null ? null : <ErrorAlert message={getWorkspaceErrorMessage(signError, messages)} title={getWorkspaceErrorTitle(signError, messages, messages.operationFailed)} />}
              </section>
            )}
          </div>
        )
      ) : null}
    </div>
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
          return (
            <div className="grid grid-cols-1 gap-3 border-b pb-4 lg:grid-cols-[minmax(12rem,1.5fr)_minmax(7rem,0.8fr)_minmax(7rem,0.8fr)_6rem_auto]" key={line.key}>
              <Field>
                <FieldLabel htmlFor={`medication-${index}`}>{messages.medication}{suffix}</FieldLabel>
                <Select
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
                >
                  <SelectTrigger className="w-full" id={`medication-${index}`}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{catalog.medications.map(item => (
                    <SelectItem key={item.id} value={item.id}>{locale === 'zh-CN' ? item.nameZh : item.nameEn}</SelectItem>
                  ))}</SelectGroup></SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`dose-${index}`}>{messages.dose}{suffix}</FieldLabel>
                <Select onValueChange={value => updateMedication(index, { doseText: value ?? '' })} value={line.doseText}>
                  <SelectTrigger className="w-full" id={`dose-${index}`}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{selectedMedication?.allowedDoseTexts.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`frequency-${index}`}>{messages.frequency}{suffix}</FieldLabel>
                <Select onValueChange={value => updateMedication(index, { frequencyCode: value ?? '' })} value={line.frequencyCode}>
                  <SelectTrigger className="w-full" id={`frequency-${index}`}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{selectedMedication?.allowedFrequencyCodes.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
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

function laboratoryResultName(code: string, messages: ReturnType<typeof getWorkspaceMessages>): string {
  if (code === '80382-5') return messages.resultCode_803825
  if (code === '6690-2') return messages.resultCode_66902
  return code
}

function indicationLabel(code: string, messages: ReturnType<typeof getWorkspaceMessages>): string {
  return code === 'fever' ? messages.indication_fever : code
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

function interpretationLabel(code: string, messages: ReturnType<typeof getWorkspaceMessages>): string {
  if (code === 'H') return messages.abnormalHigh
  if (code === 'L') return messages.abnormalLow
  if (code === 'POS') return messages.positive
  return messages.abnormal
}

function DoctorCaseRow({ item, messages, onSelect, selected }: {
  item: DoctorQueueItem
  messages: ReturnType<typeof getWorkspaceMessages>
  onSelect: () => void
  selected: boolean
}): React.JSX.Element {
  return (
    <Button aria-label={`${messages.selectCase} ${item.patient.name}`} className="h-auto min-h-16 w-full justify-between gap-3 px-3 py-2 text-left" onClick={onSelect} role="listitem" type="button" variant={selected ? 'secondary' : 'outline'}>
      <span className="min-w-0"><span className="block truncate font-medium">{item.patient.name}</span><span className="block truncate text-xs text-muted-foreground">{item.triage.chiefComplaint}</span></span>
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
