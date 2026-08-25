import {
  laboratoryRequestCatalogItemIdSchema,
  type ClinicalCatalog,
  type ClinicalDocumentContent,
  type DoctorCaseDetail,
  type DoctorQueueItem,
  type LaboratoryRequest,
  type LaboratoryRequestCatalogItemId,
  type SessionContext,
  type VirtualPatientList,
} from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircleIcon, CheckIcon, CircleAlertIcon, CircleXIcon, ClipboardPenIcon, FileSignatureIcon, FlaskConicalIcon, MessagesSquareIcon, PlayIcon, PlusIcon, RefreshCwIcon, SendIcon, ShieldAlertIcon, StethoscopeIcon, Trash2Icon, UserRoundPlusIcon } from 'lucide-react'
import { useState } from 'react'
import {
  askConsultationQuestion,
  cancelLaboratoryRequest,
  deleteLaboratoryRequestDraft,
  getClinicalCatalog,
  getDoctorCase,
  getDoctorQueue,
  getVirtualPatients,
  issueLaboratoryRequest,
  issueLaboratoryOrder,
  newIdempotencyKey,
  previewClinicalSign,
  previewStructuredClinicalDocumentSign,
  reviseStructuredClinicalDocument,
  saveClinicalDocumentDraft,
  saveFirstVisitDraft,
  saveLaboratoryRequestDraft,
  saveRevisitDraft,
  signClinicalDocument,
  signStructuredClinicalDocument,
  startFirstVisit,
  startRevisit,
  startVirtualPatient,
} from './api-client.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { PaginationControls } from './pagination-controls.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import { formatFen } from './workspace-format.ts'
import { WorkspaceSelect } from './workspace-select.tsx'

interface DoctorWorkspaceProps {
  locale: WorkspaceLocale
  session: SessionContext
}

interface ConsultationAction {
  error: Error | null
  onAsk: (questionCode: string) => void
  pending: boolean
}

interface LaboratoryRequestActions {
  cancel: {
    error: Error | null
    onSubmit: (request: LaboratoryRequest) => void
    pending: boolean
  }
  deleteDraft: {
    error: Error | null
    onSubmit: () => void
    pending: boolean
  }
  issue: {
    error: Error | null
    onSubmit: () => void
    pending: boolean
  }
  save: {
    error: Error | null
    onSubmit: () => void
    pending: boolean
  }
}

function isLaboratoryRequestCatalogItemId(
  value: string,
): value is LaboratoryRequestCatalogItemId {
  return laboratoryRequestCatalogItemIdSchema.safeParse(value).success
}

export function DoctorWorkspace({ locale, session }: DoctorWorkspaceProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const queryClient = useQueryClient()
  const scope = [session.actor.workspaceId, session.actor.epoch] as const
  const [page, setPage] = useState(1)
  const [virtualPatientPage, setVirtualPatientPage] = useState(1)
  const queueKey = ['doctor-queue', ...scope, page] as const
  const virtualPatientScopeKey = ['doctor-virtual-patients', ...scope] as const
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
  const [selectedCaseId, setSelectedCaseId] = useState<string>()
  const [selectedVirtualPatientId, setSelectedVirtualPatientId] = useState<string>()
  const [laboratoryItemId, setLaboratoryItemId] = useState('')
  const [indicationCode, setIndicationCode] = useState('')
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
      || query.state.data?.laboratoryRequests?.requests.some(
        request => request.status === 'issued' || request.status === 'accepted',
      ) === true
      ? 1_500
      : false,
  })
  const catalog = useQuery({
    queryFn: ({ signal }) => getClinicalCatalog(signal),
    queryKey: ['clinical-catalog', ...scope],
  })
  const usesIndependentLaboratoryRequests = detail.data?.consultation !== undefined
  const laboratoryCatalog = catalog.data?.laboratory.filter(item => (
    usesIndependentLaboratoryRequests
      ? isLaboratoryRequestCatalogItemId(item.id)
      : item.id === 'lab-fever-panel'
  )) ?? []
  const draftLaboratoryItemId = detail.data?.laboratoryRequests?.draft?.catalogItemId
  const requestedLaboratoryItemId = laboratoryCatalog.some(item => item.id === laboratoryItemId)
    ? laboratoryItemId
    : draftLaboratoryItemId
  const resolvedLaboratoryItemId = laboratoryCatalog.some(item => item.id === requestedLaboratoryItemId)
    ? requestedLaboratoryItemId ?? ''
    : laboratoryCatalog[0]?.id ?? ''
  const resolvedLaboratoryItem = laboratoryCatalog.find(item => item.id === resolvedLaboratoryItemId)
  const draftIndicationCode = detail.data?.laboratoryRequests?.draft?.catalogItemId === resolvedLaboratoryItemId
    ? detail.data.laboratoryRequests.draft.indicationCode
    : undefined
  const requestedIndicationCode = resolvedLaboratoryItem?.allowedIndicationCodes.includes(indicationCode)
    ? indicationCode
    : draftIndicationCode
  const resolvedIndicationCode = resolvedLaboratoryItem?.allowedIndicationCodes.includes(
    requestedIndicationCode ?? '',
  ) === true
    ? requestedIndicationCode ?? ''
    : resolvedLaboratoryItem?.allowedIndicationCodes[0] ?? ''
  const startCandidate = useMutation({
    mutationFn: () => {
      if (selectedVirtualPatient === undefined) {
        throw new Error(messages.virtualPatientsUnavailable)
      }
      return startVirtualPatient(
        selectedVirtualPatient.id,
        selectedVirtualPatient.version,
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
      setSelectedCaseId(response.data.caseId)
    },
  })
  const refreshCase = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queueKey }),
      queryClient.invalidateQueries({ queryKey: detailKey }),
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
    mutationFn: () => {
      const current = detail.data
      const requestState = current?.laboratoryRequests
      if (current === undefined || requestState?.draft === undefined) {
        throw new Error(messages.consultationUnavailable)
      }
      return deleteLaboratoryRequestDraft({
        encounterId: current.encounter.id,
        encounterVersion: current.encounter.versionId,
        expectedDraftVersion: requestState.draftVersion,
      }, newIdempotencyKey())
    },
    onSuccess: refreshCase,
  })
  const cancelRequest = useMutation({
    mutationFn: (request: LaboratoryRequest) => cancelLaboratoryRequest({
      requestId: request.id,
      requestVersion: request.version,
      serviceRequestId: request.serviceRequestId,
      serviceRequestVersion: request.serviceRequestVersion,
      taskId: request.taskId,
      taskVersion: request.taskVersion,
    }, newIdempotencyKey()),
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
    <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(18rem,0.72fr)_minmax(30rem,1.28fr)]">
      <div className="flex min-w-0 flex-col gap-5 border-b pb-6 xl:border-r xl:border-b-0 xl:pr-6">
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
            <div className="flex flex-col gap-2">
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
                  <div className="space-y-1 text-sm">
                    <div className="text-xs text-muted-foreground">{messages.presentationSummary}</div>
                    <p>{selectedVirtualPatient.presentation.summary}</p>
                  </div>
                  <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-xs sm:grid-cols-5">
                    <VitalSummary label="T" value={selectedVirtualPatient.presentation.vitalSigns.temperatureC} />
                    <VitalSummary label="P" value={selectedVirtualPatient.presentation.vitalSigns.pulseBpm} />
                    <VitalSummary label="R" value={selectedVirtualPatient.presentation.vitalSigns.respirationBpm} />
                    <VitalSummary label="BP" value={`${selectedVirtualPatient.presentation.vitalSigns.bloodPressure.systolicMmHg}/${selectedVirtualPatient.presentation.vitalSigns.bloodPressure.diastolicMmHg}`} />
                    <VitalSummary label="SpO2" value={selectedVirtualPatient.presentation.vitalSigns.oxygenSaturationPct} />
                  </dl>
                  {startCandidate.isError ? (
                    <ErrorAlert message={getWorkspaceErrorMessage(startCandidate.error, messages)} title={getWorkspaceErrorTitle(startCandidate.error, messages, messages.operationFailed)} />
                  ) : null}
                  <Button disabled={startCandidate.isPending} onClick={() => startCandidate.mutate()} type="button">
                    {startCandidate.isPending
                      ? <RefreshCwIcon aria-hidden="true" className="animate-spin" />
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
                  onSelect={() => setSelectedCaseId(item.caseId)}
                  selected={item.caseId === activeCaseId}
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
      </div>

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
        {detail.isPending && activeCaseId !== undefined ? <Skeleton className="h-64 w-full" /> : detail.isError ? (
          <ErrorAlert message={getWorkspaceErrorMessage(detail.error, messages)} title={getWorkspaceErrorTitle(detail.error, messages, messages.consultationUnavailable)} />
        ) : detail.data === undefined ? (
          <Empty className="min-h-44 border"><EmptyHeader><EmptyMedia variant="icon"><ClipboardPenIcon aria-hidden="true" /></EmptyMedia><EmptyTitle>{messages.noConsultationCases}</EmptyTitle></EmptyHeader></Empty>
        ) : (
          <CaseDetail
            consultationAction={{
              error: askQuestion.error,
              onAsk: questionCode => askQuestion.mutate(questionCode),
              pending: askQuestion.isPending,
            }}
            catalog={catalog}
            detail={detail.data}
            indicationCode={resolvedIndicationCode}
            laboratoryCatalog={laboratoryCatalog}
            laboratoryItemId={resolvedLaboratoryItemId}
            laboratoryRequestActions={{
              cancel: {
                error: cancelRequest.error,
                onSubmit: request => cancelRequest.mutate(request),
                pending: cancelRequest.isPending,
              },
              deleteDraft: {
                error: deleteRequestDraft.error,
                onSubmit: () => deleteRequestDraft.mutate(),
                pending: deleteRequestDraft.isPending,
              },
              issue: {
                error: issueRequest.error,
                onSubmit: () => issueRequest.mutate(),
                pending: issueRequest.isPending,
              },
              save: {
                error: saveLaboratoryRequest.error,
                onSubmit: () => saveLaboratoryRequest.mutate(),
                pending: saveLaboratoryRequest.isPending,
              },
            }}
            locale={locale}
            messages={messages}
            onIndicationChange={setIndicationCode}
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
          />
        )}
      </section>
    </div>
  )
}

function CaseDetail({
  catalog,
  consultationAction,
  detail,
  indicationCode,
  issueOrderError,
  issueOrderPending,
  laboratoryItemId,
  laboratoryCatalog,
  laboratoryRequestActions,
  locale,
  messages,
  onIssueOrder,
  onIndicationChange,
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
}: {
  catalog: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getClinicalCatalog>>>>
  consultationAction: ConsultationAction
  detail: DoctorCaseDetail
  indicationCode: string
  issueOrderError: Error | null
  issueOrderPending: boolean
  laboratoryCatalog: ClinicalCatalog['laboratory']
  laboratoryItemId: string
  laboratoryRequestActions: LaboratoryRequestActions
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onIssueOrder: () => void
  onIndicationChange: (value: string) => void
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
}): React.JSX.Element {
  const firstVisitDraft = detail.drafts?.firstVisit
  const presentation = detail.presentation
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
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div>
          <div className="text-lg font-semibold">{detail.patient.name}</div>
          <div className="text-sm text-muted-foreground">{detail.patient.identifier}</div>
        </div>
        <Badge variant="outline">{statusLabel(detail.status, messages)}</Badge>
      </div>
      <section aria-labelledby="clinical-presentation-heading" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold" id="clinical-presentation-heading">
          {detail.triage === undefined ? messages.clinicalPresentation : messages.triageSummary}
        </h3>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2"><dt className="text-muted-foreground">{messages.chiefComplaint}</dt><dd className="font-medium">{presentation.chiefComplaint}</dd></div>
          {presentation.summary === presentation.chiefComplaint ? null : (
            <div className="sm:col-span-2"><dt className="text-muted-foreground">{messages.presentationSummary}</dt><dd className="font-medium">{presentation.summary}</dd></div>
          )}
          <div><dt className="text-muted-foreground">{messages.temperatureC}</dt><dd className="font-medium">{presentation.vitalSigns.temperatureC}</dd></div>
          <div><dt className="text-muted-foreground">{messages.pulseBpm}</dt><dd className="font-medium">{presentation.vitalSigns.pulseBpm}</dd></div>
          <div><dt className="text-muted-foreground">{messages.respirationBpm}</dt><dd className="font-medium">{presentation.vitalSigns.respirationBpm}</dd></div>
          <div><dt className="text-muted-foreground">{messages.bloodPressure}</dt><dd className="font-medium">{presentation.vitalSigns.bloodPressure.systolicMmHg}/{presentation.vitalSigns.bloodPressure.diastolicMmHg}</dd></div>
          <div><dt className="text-muted-foreground">{messages.oxygenSaturationPct}</dt><dd className="font-medium">{presentation.vitalSigns.oxygenSaturationPct}</dd></div>
          {detail.triage === undefined ? null : (
            <div><dt className="text-muted-foreground">{messages.acuity}</dt><dd className="font-medium">{messages[`acuity_${detail.triage.acuityCode.replace('-', '')}` as 'acuity_level1']}</dd></div>
          )}
        </dl>
      </section>
      {detail.consultation === undefined ? null : (
        <ConsultationPanel
          action={consultationAction}
          consultation={detail.consultation}
          key={detail.caseId}
          locale={locale}
          messages={messages}
          patientName={detail.patient.name}
        />
      )}
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
                {detail.allergies.map(allergy => (
                  <li key={allergy.code}>{allergy.display}</li>
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
            {catalog.isPending ? <Skeleton className="h-20 w-full" /> : catalog.isError ? <ErrorAlert message={getWorkspaceErrorMessage(catalog.error, messages)} title={getWorkspaceErrorTitle(catalog.error, messages, messages.consultationUnavailable)} /> : detail.consultation !== undefined ? (
              <LaboratoryRequestEditor
                actions={laboratoryRequestActions}
                catalog={laboratoryCatalog}
                indicationCode={indicationCode}
                indicationItems={indicationItems}
                laboratoryItemId={laboratoryItemId}
                laboratoryItems={laboratoryItems}
                locale={locale}
                messages={messages}
                onIndicationChange={onIndicationChange}
                onLaboratoryItemChange={onLaboratoryItemChange}
                state={detail.laboratoryRequests}
              />
            ) : (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="laboratory-item">{messages.laboratoryItem}</FieldLabel>
                  <WorkspaceSelect id="laboratory-item" items={laboratoryItems} onValueChange={value => onLaboratoryItemChange(value ?? '')} value={laboratoryItemId} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="laboratory-indication">{messages.laboratoryIndication}</FieldLabel>
                  <WorkspaceSelect id="laboratory-indication" items={indicationItems} onValueChange={value => onIndicationChange(value ?? '')} value={indicationCode} />
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
      <StructuredClinicalDocumentPanel
        detail={detail}
        key={`structured-clinical-document:${detail.caseId}`}
        locale={locale}
        messages={messages}
        onRefresh={onRefreshCase}
      />
    </div>
  )
}

function LaboratoryRequestEditor({
  actions,
  catalog,
  indicationCode,
  indicationItems,
  laboratoryItemId,
  laboratoryItems,
  locale,
  messages,
  onIndicationChange,
  onLaboratoryItemChange,
  state,
}: {
  actions: LaboratoryRequestActions
  catalog: ClinicalCatalog['laboratory']
  indicationCode: string
  indicationItems: Array<{ label: string; value: string }>
  laboratoryItemId: string
  laboratoryItems: Array<{ label: string; value: string }>
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onIndicationChange: (value: string) => void
  onLaboratoryItemChange: (value: string) => void
  state: DoctorCaseDetail['laboratoryRequests']
}): React.JSX.Element {
  const catalogById = new Map(catalog.map(item => [item.id, item]))
  const draftItem = state?.draft === undefined
    ? undefined
    : catalogById.get(state.draft.catalogItemId)
  const draftMatchesSelection = state?.draft?.catalogItemId === laboratoryItemId
    && state.draft.indicationCode === indicationCode
  return (
    <div className="flex flex-col gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="laboratory-item">{messages.laboratoryItem}</FieldLabel>
          <WorkspaceSelect id="laboratory-item" items={laboratoryItems} onValueChange={value => onLaboratoryItemChange(value ?? '')} value={laboratoryItemId} />
        </Field>
        <Field>
          <FieldLabel htmlFor="laboratory-indication">{messages.laboratoryIndication}</FieldLabel>
          <WorkspaceSelect id="laboratory-indication" items={indicationItems} onValueChange={value => onIndicationChange(value ?? '')} value={indicationCode} />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={actions.save.pending || laboratoryItemId.length === 0 || indicationCode.length === 0} onClick={actions.save.onSubmit} type="button" variant="outline">
            <ClipboardPenIcon data-icon="inline-start" />{messages.saveLaboratoryRequestDraft}
          </Button>
          {state?.draft === undefined ? null : (
            <>
              <Button disabled={actions.deleteDraft.pending} onClick={actions.deleteDraft.onSubmit} type="button" variant="destructive">
                <Trash2Icon data-icon="inline-start" />{messages.deleteLaboratoryRequestDraft}
              </Button>
              <Button disabled={actions.issue.pending || !draftMatchesSelection} onClick={actions.issue.onSubmit} type="button">
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
              {locale === 'zh-CN' ? draftItem?.nameZh : draftItem?.nameEn} · {indicationLabel(state.draft.indicationCode, messages)}
            </AlertDescription>
          </Alert>
        )}
        {actions.save.error === null ? null : <ErrorAlert message={getWorkspaceErrorMessage(actions.save.error, messages)} title={getWorkspaceErrorTitle(actions.save.error, messages, messages.operationFailed)} />}
        {actions.deleteDraft.error === null ? null : <ErrorAlert message={getWorkspaceErrorMessage(actions.deleteDraft.error, messages)} title={getWorkspaceErrorTitle(actions.deleteDraft.error, messages, messages.operationFailed)} />}
        {actions.issue.error === null ? null : <ErrorAlert message={getWorkspaceErrorMessage(actions.issue.error, messages)} title={getWorkspaceErrorTitle(actions.issue.error, messages, messages.operationFailed)} />}
      </FieldGroup>
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{messages.laboratoryRequestStatus}</h4>
        {state === undefined || state.requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">{messages.noLaboratoryRequests}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{messages.laboratoryItem}</TableHead>
                <TableHead>{messages.laboratoryIndication}</TableHead>
                <TableHead>{messages.status}</TableHead>
                <TableHead>{messages.documentVersion}</TableHead>
                <TableHead><span className="sr-only">{messages.laboratoryRequestActions}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.requests.map((request) => {
                const item = catalogById.get(request.catalogItemId)
                return (
                  <TableRow key={request.id}>
                    <TableCell className="font-medium">{locale === 'zh-CN' ? item?.nameZh : item?.nameEn}</TableCell>
                    <TableCell>{indicationLabel(request.indicationCode, messages)}</TableCell>
                    <TableCell><Badge variant="outline">{laboratoryRequestStatusLabel(request, messages)}</Badge></TableCell>
                    <TableCell>{request.version}</TableCell>
                    <TableCell className="text-right">
                      {request.status !== 'issued' ? null : (
                        <Button
                          aria-label={`${messages.cancelLaboratoryRequest} ${locale === 'zh-CN' ? item?.nameZh : item?.nameEn}`}
                          disabled={actions.cancel.pending}
                          onClick={() => actions.cancel.onSubmit(request)}
                          size="icon-sm"
                          title={`${messages.cancelLaboratoryRequest} ${locale === 'zh-CN' ? item?.nameZh : item?.nameEn}`}
                          type="button"
                          variant="destructive"
                        >
                          <CircleXIcon />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
        {actions.cancel.error === null ? null : <ErrorAlert message={getWorkspaceErrorMessage(actions.cancel.error, messages)} title={getWorkspaceErrorTitle(actions.cancel.error, messages, messages.operationFailed)} />}
      </div>
    </div>
  )
}

const emptyClinicalDocument: ClinicalDocumentContent = {
  assessment: '',
  chiefComplaint: '',
  disposition: '',
  followUp: '',
  historyOfPresentIllness: '',
  physicalExamination: '',
}

function StructuredClinicalDocumentPanel({ detail, locale, messages, onRefresh }: {
  detail: DoctorCaseDetail
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onRefresh: () => Promise<void>
}): React.JSX.Element | null {
  const draft = detail.clinicalDocument?.draft
  const signedDocuments = detail.clinicalDocument?.signed ?? []
  const latestSignedDocument = signedDocuments.at(-1)
  const previewSign = useMutation({
    mutationFn: () => {
      if (draft === undefined) throw new Error(messages.consultationUnavailable)
      return previewStructuredClinicalDocumentSign({
        encounterId: detail.encounter.id,
        encounterVersion: detail.encounter.versionId,
        expectedDraftVersion: draft.version,
      }, newIdempotencyKey())
    },
  })
  const saveDraft = useMutation({
    mutationFn: (document: ClinicalDocumentContent) => saveClinicalDocumentDraft({
      document,
      encounterId: detail.encounter.id,
      encounterVersion: detail.encounter.versionId,
      expectedDraftVersion: draft?.version ?? 0,
    }, newIdempotencyKey()),
    onError: async () => {
      await onRefresh()
    },
    onMutate: () => {
      previewSign.reset()
    },
    onSuccess: async () => {
      await onRefresh()
    },
  })
  const sign = useMutation({
    mutationFn: () => {
      const preview = previewSign.data?.data
      if (preview === undefined) throw new Error(messages.consultationUnavailable)
      return signStructuredClinicalDocument({
        commitToken: preview.commitToken,
        encounterId: detail.encounter.id,
        encounterVersion: detail.encounter.versionId,
        previewId: preview.previewId,
      }, newIdempotencyKey())
    },
    onError: async () => {
      await onRefresh()
    },
    onSuccess: async () => {
      await onRefresh()
    },
  })
  const revise = useMutation({
    mutationFn: (input: { document: ClinicalDocumentContent; reason: string }) => {
      if (latestSignedDocument === undefined) throw new Error(messages.consultationUnavailable)
      return reviseStructuredClinicalDocument({
        compositionId: latestSignedDocument.compositionId,
        compositionVersion: latestSignedDocument.compositionVersion,
        document: input.document,
        encounterId: detail.encounter.id,
        encounterVersion: detail.encounter.versionId,
        reason: input.reason,
      }, newIdempotencyKey())
    },
    onError: async () => {
      await onRefresh()
    },
    onSuccess: async () => {
      await onRefresh()
    },
  })

  if (
    signedDocuments.length === 0
    && detail.encounter.status !== 'in-progress'
  ) {
    return null
  }

  const preview = previewSign.data?.data
  const currentPreview = preview?.document.version === draft?.version
    ? preview
    : undefined
  return (
    <section aria-labelledby="structured-clinical-document-heading" className="flex flex-col gap-4 border-t pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold" id="structured-clinical-document-heading">
          {messages.structuredClinicalDocument}
        </h3>
        {draft === undefined || signedDocuments.length > 0 ? null : (
          <Badge variant="outline">{messages.documentVersion} {draft.version}</Badge>
        )}
      </div>
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
                    <Badge variant="secondary">{messages.documentVersion} {document.revisionNumber}</Badge>
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
          {latestSignedDocument === undefined ? null : (
            <div className="flex flex-col gap-3 border-t pt-5">
              <h4 className="text-sm font-semibold">
                {messages.clinicalDocumentRevisionForm} {latestSignedDocument.revisionNumber}
              </h4>
              <ClinicalDocumentForm
                content={latestSignedDocument.content}
                formName={`${messages.clinicalDocumentRevisionForm} ${latestSignedDocument.revisionNumber}`}
                idPrefix={`clinical-document-revision-${latestSignedDocument.revisionNumber}`}
                includeRevisionReason
                key={latestSignedDocument.compositionId}
                messages={messages}
                onSubmit={(document, reason) => revise.mutate({ document, reason })}
                pending={revise.isPending}
                pendingLabel={messages.revisingClinicalDocument}
                submitLabel={messages.submitClinicalDocumentRevision}
              />
              {revise.error === null ? null : (
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
          <ClinicalDocumentForm
            content={draft ?? emptyClinicalDocument}
            formName={messages.structuredClinicalDocument}
            idPrefix="clinical-document-draft"
            key={`${detail.caseId}:${draft?.version ?? 0}`}
            messages={messages}
            onSubmit={document => saveDraft.mutate(document)}
            pending={saveDraft.isPending}
            pendingLabel={messages.savingClinicalDocument}
            submitLabel={messages.saveClinicalDocumentDraft}
          />
          {saveDraft.isSuccess ? (
            <Alert>
              <CheckIcon aria-hidden="true" />
              <AlertTitle>{messages.clinicalDocumentDraftSaved}</AlertTitle>
            </Alert>
          ) : null}
          {saveDraft.error === null ? null : (
            <ErrorAlert
              message={getWorkspaceErrorMessage(saveDraft.error, messages)}
              title={getWorkspaceErrorTitle(saveDraft.error, messages, messages.operationFailed)}
            />
          )}
          <div className="flex justify-end">
            <Button
              disabled={draft === undefined || previewSign.isPending || saveDraft.isPending}
              onClick={() => previewSign.mutate()}
              type="button"
              variant="outline"
            >
              {previewSign.isPending
                ? <RefreshCwIcon aria-hidden="true" className="animate-spin" data-icon="inline-start" />
                : <FileSignatureIcon aria-hidden="true" data-icon="inline-start" />}
              {messages.previewClinicalDocumentSign}
            </Button>
          </div>
          {previewSign.error === null ? null : (
            <ErrorAlert
              message={getWorkspaceErrorMessage(previewSign.error, messages)}
              title={getWorkspaceErrorTitle(previewSign.error, messages, messages.operationFailed)}
            />
          )}
          {currentPreview === undefined ? null : (
            <section aria-labelledby="structured-clinical-document-sign-preview-heading" className="flex flex-col gap-3 border-t pt-5">
              <h4 className="text-sm font-semibold" id="structured-clinical-document-sign-preview-heading">
                {messages.structuredClinicalDocumentSignPreview}
              </h4>
              <ClinicalDocumentContentView content={currentPreview.document.content} messages={messages} />
              <div className="flex justify-end">
                <Button disabled={sign.isPending} onClick={() => sign.mutate()} type="button">
                  {sign.isPending
                    ? <RefreshCwIcon aria-hidden="true" className="animate-spin" data-icon="inline-start" />
                    : <CheckCircleIcon aria-hidden="true" data-icon="inline-start" />}
                  {messages.confirmStructuredClinicalSign}
                </Button>
              </div>
            </section>
          )}
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
          chiefComplaint: String(data.get('chiefComplaint') ?? ''),
          disposition: String(data.get('disposition') ?? ''),
          followUp: String(data.get('followUp') ?? ''),
          historyOfPresentIllness: String(data.get('historyOfPresentIllness') ?? ''),
          physicalExamination: String(data.get('physicalExamination') ?? ''),
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
    [messages.physicalExamination, content.physicalExamination],
    [messages.assessment, content.assessment],
    [messages.disposition, content.disposition],
    [messages.followUp, content.followUp],
  ]
  return (
    <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
      {fields.map(([label, value]) => (
        <div key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="whitespace-pre-wrap font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function formatClinicalDocumentTime(value: string, locale: WorkspaceLocale): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function ConsultationPanel({ action, consultation, locale, messages, patientName }: {
  action: ConsultationAction
  consultation: NonNullable<DoctorCaseDetail['consultation']>
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  patientName: string
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
      <form
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
      </form>
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

function laboratoryResultName(code: string, messages: ReturnType<typeof getWorkspaceMessages>): string {
  if (code === '80382-5') return messages.resultCode_803825
  if (code === '6690-2') return messages.resultCode_66902
  return code
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

function interpretationLabel(code: string, messages: ReturnType<typeof getWorkspaceMessages>): string {
  if (code === 'H') return messages.abnormalHigh
  if (code === 'L') return messages.abnormalLow
  if (code === 'POS') return messages.positive
  return messages.abnormal
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
      className="h-auto min-h-16 w-full justify-start gap-3 px-3 py-2 text-left"
      onClick={onSelect}
      type="button"
      variant={selected ? 'secondary' : 'outline'}
    >
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
    <Button aria-label={`${messages.selectCase} ${item.patient.name}`} className="h-auto min-h-16 w-full justify-between gap-3 px-3 py-2 text-left" onClick={onSelect} role="listitem" type="button" variant={selected ? 'secondary' : 'outline'}>
      <span className="min-w-0"><span className="block truncate font-medium">{item.patient.name}</span><span className="block truncate text-xs text-muted-foreground">{item.presentation.chiefComplaint}</span></span>
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
