import {
  type ClinicalCatalog,
  type DoctorCompletedCaseDetail,
  type DoctorCompletedCaseTimelineEvent,
  type SessionContext,
} from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Separator } from '@clinmesh/ui/components/separator'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { useQuery } from '@tanstack/react-query'
import {
  CircleAlertIcon,
  Clock3Icon,
  EyeIcon,
  FileClockIcon,
  FilePenLineIcon,
  FilterXIcon,
  FlaskConicalIcon,
  LibraryBigIcon,
  RotateCcwIcon,
  SearchIcon,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'
import {
  getClinicalCatalog,
  getDoctorCompletedCase,
  getDoctorCompletedCases,
  type DoctorCompletedCaseFilters,
} from './api-client.ts'
import { PaginationControls } from './pagination-controls.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import {
  getWorkspaceMessages,
  type WorkspaceLocale,
  type WorkspaceMessageKey,
} from './workspace-i18n.ts'
import { WorkspaceSelect } from './workspace-select.tsx'

interface DoctorCompletedCaseLibraryProps {
  locale: WorkspaceLocale
  onOpenCorrection: (caseId: string, target: CompletedCaseCorrectionTarget) => void
  session: SessionContext
}

export type CompletedCaseCorrectionTarget =
  | 'clinical-document'
  | 'laboratory'
  | 'medication-conclusion'

interface FilterFormState {
  completedFrom: string
  completedTo: string
  diagnosisCatalogItemId: string
  patientId: string
}

type CompletedPrescription = NonNullable<
  NonNullable<DoctorCompletedCaseDetail['medicationConclusion']>['prescription']
>
type LaboratoryRequestStatus = DoctorCompletedCaseDetail['laboratoryRequests'][number]['status']
type CompletedLaboratoryReport = NonNullable<
  DoctorCompletedCaseDetail['laboratoryRequests'][number]['report']
>

const allDiagnoses = '__all_diagnoses__'
const emptyFilters: FilterFormState = {
  completedFrom: '',
  completedTo: '',
  diagnosisCatalogItemId: allDiagnoses,
  patientId: '',
}

const timelineMessageKeys = {
  'clinical-document-revised': 'timeline_clinicalDocumentRevised',
  'clinical-document-signed': 'timeline_clinicalDocumentSigned',
  'consultation-recorded': 'timeline_consultationRecorded',
  'diagnosis-confirmed': 'timeline_diagnosisConfirmed',
  'encounter-completed': 'timeline_encounterCompleted',
  'laboratory-report-acknowledged': 'timeline_laboratoryReportAcknowledged',
  'laboratory-report-issued': 'timeline_laboratoryReportIssued',
  'laboratory-report-revised': 'timeline_laboratoryReportRevised',
  'laboratory-request-draft-deleted': 'timeline_laboratoryRequestDraftDeleted',
  'laboratory-request-cancelled': 'timeline_laboratoryRequestCancelled',
  'laboratory-request-issued': 'timeline_laboratoryRequestIssued',
  'no-medication-confirmed': 'timeline_noMedicationConfirmed',
  'prescription-draft-deleted': 'timeline_prescriptionDraftDeleted',
  'prescription-issued': 'timeline_prescriptionIssued',
  'prescription-withdrawn': 'timeline_prescriptionWithdrawn',
} satisfies Record<DoctorCompletedCaseTimelineEvent['kind'], WorkspaceMessageKey>

const laboratoryStatusMessageKeys = {
  accepted: 'laboratoryRequestStatus_accepted',
  acknowledged: 'laboratoryRequestStatus_acknowledged',
  cancelled: 'laboratoryRequestStatus_cancelled',
  'generation-failed': 'laboratoryRequestStatus_generationFailed',
  'in-progress': 'laboratoryRequestStatus_inProgress',
  issued: 'laboratoryRequestStatus_issued',
  reported: 'laboratoryRequestStatus_reported',
} satisfies Record<LaboratoryRequestStatus, WorkspaceMessageKey>

const prescriptionStatusMessageKeys = {
  dispensed: 'prescriptionStatus_dispensed',
  paid: 'prescriptionStatus_paid',
  signed: 'prescriptionStatus_signed',
  withdrawn: 'prescriptionStatus_withdrawn',
} satisfies Record<CompletedPrescription['status'], WorkspaceMessageKey>

const dateTimeFormatters = {
  'en-US': new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
  'zh-CN': new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }),
} satisfies Record<WorkspaceLocale, Intl.DateTimeFormat>

function submittedFilters(form: FilterFormState): DoctorCompletedCaseFilters {
  const patientId = form.patientId.trim()
  return {
    ...(form.completedFrom === '' ? {} : { completedFrom: form.completedFrom }),
    ...(form.completedTo === '' ? {} : { completedTo: form.completedTo }),
    ...(form.diagnosisCatalogItemId === allDiagnoses
      ? {}
      : { diagnosisCatalogItemId: form.diagnosisCatalogItemId }),
    ...(patientId === '' ? {} : { patientId }),
  }
}

function sameFilters(left: DoctorCompletedCaseFilters, right: DoctorCompletedCaseFilters): boolean {
  return left.completedFrom === right.completedFrom
    && left.completedTo === right.completedTo
    && left.diagnosisCatalogItemId === right.diagnosisCatalogItemId
    && left.patientId === right.patientId
}

function formatDateTime(value: string, locale: WorkspaceLocale): string {
  return dateTimeFormatters[locale].format(new Date(value))
}

export function DoctorCompletedCaseLibrary({
  locale,
  onOpenCorrection,
  session,
}: DoctorCompletedCaseLibraryProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const scope = [session.actor.workspaceId, session.actor.epoch] as const
  const [draftFilters, setDraftFilters] = useState<FilterFormState>(emptyFilters)
  const [filters, setFilters] = useState<DoctorCompletedCaseFilters>({})
  const [page, setPage] = useState(1)
  const [selectedCaseId, setSelectedCaseId] = useState<string>()
  const catalog = useQuery({
    queryFn: ({ signal }) => getClinicalCatalog(signal),
    queryKey: ['clinical-catalog', ...scope],
  })
  const cases = useQuery({
    queryFn: ({ signal }) => getDoctorCompletedCases(filters, signal, page),
    queryKey: ['doctor-completed-cases', ...scope, filters, page],
  })
  const detail = useQuery({
    enabled: selectedCaseId !== undefined,
    queryFn: ({ signal }) => getDoctorCompletedCase(selectedCaseId ?? '', signal),
    queryKey: ['doctor-completed-case', ...scope, selectedCaseId],
  })
  const diagnosisItems = [{ label: messages.allDiagnoses, value: allDiagnoses }, ...(
    catalog.data?.diagnoses.map(item => ({
      label: `${locale === 'zh-CN' ? item.nameZh : item.nameEn} · ${item.code}`,
      value: item.id,
    })) ?? []
  )]

  const search = (nextFilters: DoctorCompletedCaseFilters) => {
    setPage(1)
    setSelectedCaseId(undefined)
    if (page === 1 && sameFilters(filters, nextFilters)) {
      void cases.refetch()
      return
    }
    setFilters(nextFilters)
  }

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    search(submittedFilters(draftFilters))
  }

  const resetFilters = () => {
    setDraftFilters(emptyFilters)
    search({})
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(28rem,0.9fr)_minmax(34rem,1.1fr)]">
      <div className="flex min-w-0 flex-col gap-5 border-b pb-6 xl:border-r xl:border-b-0 xl:pr-6">
        <form aria-label={messages.completedCaseFilters} onSubmit={applyFilters}>
          <FieldSet>
            <FieldLegend>{messages.completedCaseFilters}</FieldLegend>
            <FieldGroup className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="completed-case-patient-id">{messages.completedPatientId}</FieldLabel>
                <Input
                  autoComplete="off"
                  id="completed-case-patient-id"
                  onChange={event => setDraftFilters(current => ({
                    ...current,
                    patientId: event.target.value,
                  }))}
                  value={draftFilters.patientId}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="completed-case-diagnosis">{messages.completedDiagnosis}</FieldLabel>
                <WorkspaceSelect
                  id="completed-case-diagnosis"
                  items={diagnosisItems}
                  onValueChange={value => setDraftFilters(current => ({
                    ...current,
                    diagnosisCatalogItemId: value ?? allDiagnoses,
                  }))}
                  value={draftFilters.diagnosisCatalogItemId}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="completed-case-from">{messages.completedFrom}</FieldLabel>
                <Input
                  id="completed-case-from"
                  max={draftFilters.completedTo || undefined}
                  onChange={event => setDraftFilters(current => ({
                    ...current,
                    completedFrom: event.target.value,
                  }))}
                  type="date"
                  value={draftFilters.completedFrom}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="completed-case-to">{messages.completedTo}</FieldLabel>
                <Input
                  id="completed-case-to"
                  min={draftFilters.completedFrom || undefined}
                  onChange={event => setDraftFilters(current => ({
                    ...current,
                    completedTo: event.target.value,
                  }))}
                  type="date"
                  value={draftFilters.completedTo}
                />
              </Field>
            </FieldGroup>
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={resetFilters} type="button" variant="outline">
                <FilterXIcon data-icon="inline-start" />
                {messages.resetCompletedCaseFilters}
              </Button>
              <Button type="submit">
                <SearchIcon data-icon="inline-start" />
                {messages.searchCompletedCases}
              </Button>
            </div>
          </FieldSet>
        </form>

        <Separator />

        <section aria-labelledby="completed-case-list-heading" className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold" id="completed-case-list-heading">
              {messages.doctorCompletedCases}
            </h2>
            <Badge variant="secondary">{cases.data?.total ?? 0}</Badge>
          </div>
          {catalog.isError ? (
            <CompletedCaseError
              error={catalog.error}
              fallbackTitle={messages.completedCasesUnavailable}
              messages={messages}
            />
          ) : null}
          {cases.isPending ? <Skeleton className="h-52 w-full" /> : cases.isError ? (
            <CompletedCaseError
              error={cases.error}
              fallbackTitle={messages.completedCasesUnavailable}
              messages={messages}
            />
          ) : cases.data.items.length === 0 ? (
            <Empty className="min-h-52 border">
              <EmptyHeader>
                <EmptyMedia variant="icon"><LibraryBigIcon aria-hidden="true" /></EmptyMedia>
                <EmptyTitle>{messages.noCompletedCases}</EmptyTitle>
                <EmptyDescription>{messages.noCompletedCasesDescription}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="min-w-0 overflow-x-auto">
              <Table className="min-w-[44rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead>{messages.patient}</TableHead>
                    <TableHead>{messages.syntheticIdentifier}</TableHead>
                    <TableHead>{messages.completedAt}</TableHead>
                    <TableHead>{messages.primaryDiagnosis}</TableHead>
                    <TableHead><span className="sr-only">{messages.viewCompletedCase}</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cases.data.items.map(item => (
                    <TableRow data-state={selectedCaseId === item.caseId ? 'selected' : undefined} key={item.caseId}>
                      <TableCell className="max-w-64 whitespace-normal font-medium break-words">
                        {item.patient.name}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{item.patient.identifier}</TableCell>
                      <TableCell>{formatDateTime(item.completedAt, locale)}</TableCell>
                      <TableCell className="max-w-56 whitespace-normal break-words">
                        {item.primaryDiagnosis?.display ?? '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          aria-label={`${messages.viewCompletedCase} ${item.patient.name}`}
                          onClick={() => setSelectedCaseId(item.caseId)}
                          size="icon-sm"
                          title={messages.viewCompletedCase}
                          type="button"
                          variant="ghost"
                        >
                          <EyeIcon aria-hidden="true" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {cases.data === undefined || cases.data.total === 0 ? null : (
            <PaginationControls
              messages={messages}
              onPageChange={(nextPage) => {
                setPage(nextPage)
                setSelectedCaseId(undefined)
              }}
              page={cases.data.page}
              pageSize={cases.data.pageSize}
              total={cases.data.total}
            />
          )}
        </section>
      </div>

      <section aria-labelledby="completed-case-detail-heading" className="flex min-w-0 flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold" id="completed-case-detail-heading">
            {messages.completedCaseDetail}
          </h2>
          {detail.data === undefined ? null : <Badge variant="outline">{messages.readOnlyDetail}</Badge>}
        </div>
        {detail.isPending && selectedCaseId !== undefined ? <Skeleton className="h-72 w-full" /> : detail.isError ? (
          <CompletedCaseError
            error={detail.error}
            fallbackTitle={messages.completedCasesUnavailable}
            messages={messages}
          />
        ) : detail.data === undefined ? (
          <Empty className="min-h-52 border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><FileClockIcon aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{messages.selectCompletedCase}</EmptyTitle>
              <EmptyDescription>{messages.selectCompletedCaseDescription}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <CompletedCaseDetailView
            canCorrectLaboratoryReport={session.availableRoles.some(
              role => role.code === 'administrator',
            )}
            catalog={catalog.data}
            detail={detail.data}
            locale={locale}
            onOpenCorrection={onOpenCorrection}
          />
        )}
      </section>
    </div>
  )
}

function CompletedCaseError({ error, fallbackTitle, messages }: {
  error: Error
  fallbackTitle: string
  messages: ReturnType<typeof getWorkspaceMessages>
}): React.JSX.Element {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>{getWorkspaceErrorTitle(error, messages, fallbackTitle)}</AlertTitle>
      <AlertDescription>{getWorkspaceErrorMessage(error, messages)}</AlertDescription>
    </Alert>
  )
}

function CompletedCaseDetailView({ canCorrectLaboratoryReport, catalog, detail, locale, onOpenCorrection }: {
  canCorrectLaboratoryReport: boolean
  catalog?: ClinicalCatalog | undefined
  detail: DoctorCompletedCaseDetail
  locale: WorkspaceLocale
  onOpenCorrection: (caseId: string, target: CompletedCaseCorrectionTarget) => void
}): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const hasCorrectableClinicalDocument = detail.clinicalDocuments.some(
    document => document.correctionSupported,
  )
  const hasCorrectableLaboratoryReport = detail.laboratoryRequests.some(
    request => request.correctionSupported
      && (request.report !== undefined || request.previousReports.length > 0),
  )
  const hasWithdrawablePrescription = detail.medicationConclusion?.prescription
    ?.withdrawalSupported === true
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Fact label={messages.patient} value={detail.patient.name} />
        <Fact label={messages.syntheticIdentifier} value={detail.patient.identifier} />
        <Fact label={messages.birthDate} value={detail.patient.birthDate ?? '—'} />
        <Fact label={messages.completedAt} value={formatDateTime(detail.completedAt, locale)} />
        <Fact label="Encounter" mono value={`Encounter/${detail.encounter.id}`} />
        <Fact label={messages.status} value={messages.encounterCompleted} />
      </dl>

      <div className="flex flex-wrap justify-end gap-2">
        {hasCorrectableClinicalDocument ? (
          <Button
            onClick={() => onOpenCorrection(detail.caseId, 'clinical-document')}
            size="sm"
            type="button"
            variant="outline"
          >
            <FilePenLineIcon data-icon="inline-start" />
            {messages.openClinicalDocumentCorrection}
          </Button>
        ) : null}
        {hasCorrectableLaboratoryReport && canCorrectLaboratoryReport ? (
          <Button
            onClick={() => onOpenCorrection(detail.caseId, 'laboratory')}
            size="sm"
            type="button"
            variant="outline"
          >
            <FlaskConicalIcon data-icon="inline-start" />
            {messages.openLaboratoryReportCorrection}
          </Button>
        ) : null}
        {hasWithdrawablePrescription ? (
          <Button
            onClick={() => onOpenCorrection(detail.caseId, 'medication-conclusion')}
            size="sm"
            type="button"
            variant="outline"
          >
            <RotateCcwIcon data-icon="inline-start" />
            {messages.withdrawPrescription}
          </Button>
        ) : null}
      </div>

      <Separator />

      <CompletedCaseSection heading={messages.consultationRecord}>
        {detail.consultation === undefined || detail.consultation.records.length === 0 ? (
          <p className="text-sm text-muted-foreground">{messages.noConsultationHistory}</p>
        ) : (
          <ol className="flex flex-col gap-4">
            {detail.consultation.records.map(record => (
              <li className="min-w-0 border-l-2 border-primary/30 pl-4" key={record.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{record.question.text}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(record.recordedAt, locale)}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm">{record.answer}</p>
                <code className="mt-2 block break-all text-xs text-muted-foreground">
                  ConsultationRecord/{record.id}
                </code>
              </li>
            ))}
          </ol>
        )}
      </CompletedCaseSection>

      <CompletedCaseSection heading={messages.structuredClinicalDocument}>
        {detail.clinicalDocuments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{messages.noSignedClinicalDocuments}</p>
        ) : (
          <ol className="flex flex-col gap-5">
            {detail.clinicalDocuments.map(document => (
              <li className="flex min-w-0 flex-col gap-3 border-b pb-5 last:border-b-0 last:pb-0" key={document.compositionId}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge variant="secondary">{messages.documentVersion} {document.revisionNumber}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {messages.signedAt} {formatDateTime(document.signedAt, locale)}
                  </span>
                </div>
                {document.revisionReason === undefined ? null : (
                  <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                    <span className="font-medium">{messages.revisionReason}: </span>
                    {document.revisionReason}
                  </p>
                )}
                <ClinicalDocumentFacts content={document.content} messages={messages} />
                <code className="break-all text-xs text-muted-foreground">
                  Composition/{document.compositionId}
                </code>
              </li>
            ))}
          </ol>
        )}
      </CompletedCaseSection>

      <CompletedCaseSection heading={messages.laboratoryOrder}>
        {detail.laboratoryRequests.length === 0 ? (
          <p className="text-sm text-muted-foreground">{messages.noLaboratoryRequests}</p>
        ) : (
          <ol className="flex flex-col gap-5">
            {detail.laboratoryRequests.map(request => (
              <li className="flex min-w-0 flex-col gap-3 border-b pb-5 last:border-b-0 last:pb-0" key={request.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">
                    {catalog?.laboratory.find(item => item.id === request.catalogItemId)?.[
                      locale === 'zh-CN' ? 'nameZh' : 'nameEn'
                    ] ?? request.catalogDisplay ?? request.catalogItemId ?? '—'}
                  </span>
                  <Badge variant="outline">{messages[laboratoryStatusMessageKeys[request.status]]}</Badge>
                </div>
                <code className="break-all text-xs text-muted-foreground">
                  ServiceRequest/{request.serviceRequestId}
                </code>
                {request.previousReports.map(report => (
                  <LaboratoryReportView current={false} key={report.diagnosticReportId} locale={locale} report={report} />
                ))}
                {request.report === undefined ? null : (
                  <LaboratoryReportView current locale={locale} report={request.report} />
                )}
              </li>
            ))}
          </ol>
        )}
      </CompletedCaseSection>

      <CompletedCaseSection heading={messages.diagnosisRecord}>
        {detail.diagnosis === undefined ? (
          <p className="text-sm text-muted-foreground">{messages.noDiagnosisConfirmation}</p>
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            <div className="min-w-0 overflow-x-auto">
              <Table className="min-w-[36rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead>{messages.diagnosisRole}</TableHead>
                    <TableHead>{messages.diagnosisCode}</TableHead>
                    <TableHead>{messages.diagnosisDisplay}</TableHead>
                    <TableHead>{messages.diagnosisNote}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.diagnosis.entries.map(entry => (
                    <TableRow key={entry.conditionId}>
                      <TableCell>{entry.role === 'primary' ? messages.primaryDiagnosis : messages.secondaryDiagnosis}</TableCell>
                      <TableCell className="font-mono text-xs">{entry.code}</TableCell>
                      <TableCell className="whitespace-normal break-words">{entry.display}</TableCell>
                      <TableCell className="whitespace-normal break-words">{entry.note ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <span className="text-xs text-muted-foreground">
              {messages.diagnosisConfirmedAt} {formatDateTime(detail.diagnosis.confirmedAt, locale)}
            </span>
          </div>
        )}
      </CompletedCaseSection>

      <CompletedCaseSection heading={messages.medicationConclusion}>
        <MedicationConclusion detail={detail} locale={locale} />
      </CompletedCaseSection>

      <section aria-label={messages.completedCaseTimeline} className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center gap-2">
          <Clock3Icon aria-hidden="true" className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{messages.completedCaseTimeline}</h3>
        </div>
        <ol className="relative flex min-w-0 flex-col gap-5 border-l pl-5">
          {detail.timeline.map((event, index) => (
            <li className="relative min-w-0" key={`${event.reference}:${event.kind}:${index}`}>
              <span className="absolute top-1.5 -left-[1.56rem] size-2 rounded-full bg-primary" />
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{messages[timelineMessageKeys[event.kind]]}</span>
                  <time className="text-xs text-muted-foreground" dateTime={event.occurredAt}>
                    {formatDateTime(event.occurredAt, locale)}
                  </time>
                </div>
                <div className="min-w-0 text-xs">
                  <span className="text-muted-foreground">{messages.resourceReference}: </span>
                  <code className="break-all">{event.reference}</code>
                </div>
                {event.relatedReferences.length === 0 ? null : (
                  <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs">
                    <span className="text-muted-foreground">{messages.relatedResources}:</span>
                    {event.relatedReferences.map(reference => (
                      <code className="break-all" key={reference}>{reference}</code>
                    ))}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

function CompletedCaseSection({ children, heading }: {
  children: React.ReactNode
  heading: string
}): React.JSX.Element {
  return (
    <section className="flex min-w-0 flex-col gap-4 border-b pb-5">
      <h3 className="text-sm font-semibold">{heading}</h3>
      {children}
    </section>
  )
}

function Fact({ label, mono = false, value }: {
  label: string
  mono?: boolean
  value: string
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`${mono ? 'break-all font-mono text-xs' : 'break-words font-medium'} mt-1`}>{value}</dd>
    </div>
  )
}

function ClinicalDocumentFacts({ content, messages }: {
  content: DoctorCompletedCaseDetail['clinicalDocuments'][number]['content']
  messages: ReturnType<typeof getWorkspaceMessages>
}): React.JSX.Element {
  const facts: Array<[label: string, value: string]> = 'plan' in content
    ? [
        [messages.assessment, content.assessment],
        [messages.clinicalPlan, content.plan],
      ]
    : [
        [messages.chiefComplaint, content.chiefComplaint],
        [messages.historyOfPresentIllness, content.historyOfPresentIllness],
        [messages.physicalExamination, content.physicalExamination],
        [messages.assessment, content.assessment],
        [messages.disposition, content.disposition],
        [messages.followUp, content.followUp],
      ]
  return (
    <dl className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
      {facts.map(([label, value]) => (
        <div className="min-w-0" key={label}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 whitespace-pre-wrap break-words text-sm">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function LaboratoryReportView({ current, locale, report }: {
  current: boolean
  locale: WorkspaceLocale
  report: CompletedLaboratoryReport
}): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const versionLabel = (
    current
      ? messages.laboratoryReportCurrentVersion
      : messages.laboratoryReportReplacedVersion
  ).replace('{version}', report.revisionNumber.toLocaleString(locale))
  return (
    <section className="flex min-w-0 flex-col gap-3 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={current ? 'secondary' : 'outline'}>{versionLabel}</Badge>
        {report.acknowledgement === undefined ? null : (
          <Badge variant="success">{messages.laboratoryReportAcknowledged}</Badge>
        )}
        <code className="break-all text-xs text-muted-foreground">
          DiagnosticReport/{report.diagnosticReportId}
        </code>
      </div>
      {report.revisionReason === undefined ? null : (
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
          <span className="font-medium">{messages.laboratoryReportRevisionReason}: </span>
          {report.revisionReason}
        </p>
      )}
      <p className="whitespace-pre-wrap break-words text-sm">
        <span className="font-medium">{messages.laboratoryReportConclusion}: </span>
        {report.conclusion}
      </p>
      <div className="min-w-0 overflow-x-auto">
        <Table className="min-w-[34rem]">
          <TableHeader>
            <TableRow>
              <TableHead>{messages.laboratoryItem}</TableHead>
              <TableHead>{messages.result}</TableHead>
              <TableHead>{messages.referenceRange}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.results.map(result => (
              <TableRow key={result.observationId}>
                <TableCell>{result.display}</TableCell>
                <TableCell>
                  {typeof result.value === 'number'
                    ? result.value.toLocaleString(locale)
                    : String(result.value)}
                  {result.unit === undefined ? null : ` ${result.unit.display}`}
                  {result.interpretation === undefined ? null : (
                    <Badge className="ml-2" variant={result.interpretation === 'normal' ? 'success' : 'warning'}>
                      {result.interpretation === 'normal'
                        ? messages.normal
                        : result.interpretation === 'high'
                          ? messages.abnormalHigh
                          : result.interpretation === 'low'
                            ? messages.abnormalLow
                            : messages.abnormal}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{result.referenceRange?.text ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

function MedicationConclusion({ detail, locale }: {
  detail: DoctorCompletedCaseDetail
  locale: WorkspaceLocale
}): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const conclusion = detail.medicationConclusion
  if (conclusion?.prescription === undefined && conclusion?.noMedication === undefined) {
    return <p className="text-sm text-muted-foreground">{messages.noMedicationConclusion}</p>
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {conclusion.prescription === undefined ? null : (
        <PrescriptionHistory locale={locale} prescription={conclusion.prescription} />
      )}
      {conclusion.noMedication === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2 border-t pt-4 text-sm">
          <Badge variant="secondary">{messages.noMedicationConfirmed}</Badge>
          <span className="text-muted-foreground">
            {messages.authoredAt} {formatDateTime(conclusion.noMedication.authoredAt, locale)}
          </span>
        </div>
      )}
    </div>
  )
}

function PrescriptionHistory({ locale, prescription }: {
  locale: WorkspaceLocale
  prescription: CompletedPrescription
}): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{messages.prescriptionNumber} {prescription.number}</Badge>
        <Badge variant="outline">{messages[prescriptionStatusMessageKeys[prescription.status]]}</Badge>
        <span className="text-xs text-muted-foreground">
          {messages.authoredAt} {formatDateTime(prescription.authoredAt, locale)}
        </span>
      </div>
      {prescription.withdrawal === undefined ? null : (
        <span className="text-xs text-muted-foreground">
          {messages.prescriptionWithdrawn} · {formatDateTime(prescription.withdrawal.withdrawnAt, locale)}
        </span>
      )}
      <div className="min-w-0 overflow-x-auto">
        <Table className="min-w-[42rem]">
          <TableHeader>
            <TableRow>
              <TableHead>{messages.medication}</TableHead>
              <TableHead>{messages.dose}</TableHead>
              <TableHead>{messages.frequency}</TableHead>
              <TableHead>{messages.course}</TableHead>
              <TableHead>{messages.quantity}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {prescription.items.map(item => (
              <TableRow key={item.medicationRequestId}>
                <TableCell className="whitespace-normal break-words">{item.display}</TableCell>
                <TableCell>{item.doseText}</TableCell>
                <TableCell>{item.frequencyCode}</TableCell>
                <TableCell>{item.courseDays} {messages.days}</TableCell>
                <TableCell>{item.quantity}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
