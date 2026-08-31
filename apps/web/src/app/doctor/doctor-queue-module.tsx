import type { DoctorQueueItem, VirtualPatientList } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Spinner } from '@clinmesh/ui/components/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { CircleAlertIcon, PlayIcon, StethoscopeIcon, UserRoundPlusIcon } from 'lucide-react'
import { useState } from 'react'
import { PaginationControls } from '../pagination-controls.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from '../workspace-error.ts'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { doctorCaseStatusLabel } from './doctor-case-status.ts'
import { PatientAvatar, VitalSummary } from './patient-summary.tsx'

type WorkspaceMessages = ReturnType<typeof getWorkspaceMessages>
type VirtualPatient = VirtualPatientList['items'][number]

interface DoctorQueuePage {
  items: DoctorQueueItem[]
  page: number
  pageSize: number
  total: number
}

function ErrorAlert({ error, fallbackTitle, messages }: {
  error: Error
  fallbackTitle: string
  messages: WorkspaceMessages
}): React.JSX.Element {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>{getWorkspaceErrorTitle(error, messages, fallbackTitle)}</AlertTitle>
      <AlertDescription>{getWorkspaceErrorMessage(error, messages)}</AlertDescription>
    </Alert>
  )
}

function VirtualPatientRow({ item, messages, onSelect, selected }: {
  item: VirtualPatient
  messages: WorkspaceMessages
  onSelect: () => void
  selected: boolean
}): React.JSX.Element {
  return (
    <Button
      aria-label={`${messages.selectVirtualPatient} ${item.name}`}
      aria-pressed={selected}
      className={`h-auto min-h-20 w-full justify-start gap-3 rounded-md border px-3 py-2 text-left ${selected
        ? 'border-primary/40 bg-primary/5'
        : 'border-border bg-background hover:border-foreground/20'}`}
      onClick={onSelect}
      type="button"
      variant="ghost"
    >
      <PatientAvatar className="size-9" label={`${item.name} ${messages.patient}`} name={item.name} />
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{item.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {messages[`gender_${item.gender}` as 'gender_male']} · {item.birthDate}
          </span>
        </span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">{item.presentation.chiefComplaint}</span>
      </span>
    </Button>
  )
}

function DoctorCaseRow({ item, messages, onSelect, selected }: {
  item: DoctorQueueItem
  messages: WorkspaceMessages
  onSelect: () => void
  selected: boolean
}): React.JSX.Element {
  return (
    <Button
      aria-label={`${messages.selectCase} ${item.patient.name}`}
      className={`h-auto min-h-20 w-full justify-between gap-3 rounded-md border px-3 py-2 text-left ${selected
        ? 'border-primary/40 bg-primary/5'
        : 'border-border bg-background hover:border-foreground/20'}`}
      onClick={onSelect}
      role="listitem"
      type="button"
      variant="ghost"
    >
      <span className="flex min-w-0 items-center gap-3">
        <PatientAvatar className="size-9" label={`${item.patient.name} ${messages.patient}`} name={item.patient.name} />
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{item.patient.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {messages[`gender_${item.patient.gender}` as 'gender_male']} · {item.patient.birthDate}
            </span>
          </span>
          <span className="mt-1 block truncate text-xs text-muted-foreground">{item.presentation.chiefComplaint}</span>
        </span>
      </span>
      <Badge className="shrink-0" variant="outline">{doctorCaseStatusLabel(item.status, messages)}</Badge>
    </Button>
  )
}

export function DoctorQueueModule({
  activeCaseId,
  messages,
  onQueuePageChange,
  onSelectCase,
  onSelectVirtualPatient,
  onStartVirtualPatient,
  onVirtualPatientPageChange,
  queueData,
  queueError,
  queuePending,
  selectedVirtualPatient,
  startError,
  startPending,
  virtualPatientData,
  virtualPatientError,
  virtualPatientPending,
}: {
  activeCaseId: string | undefined
  messages: WorkspaceMessages
  onQueuePageChange: (page: number) => void
  onSelectCase: (caseId: string) => void
  onSelectVirtualPatient: (patient: VirtualPatient) => void
  onStartVirtualPatient: (patient: VirtualPatient) => void
  onVirtualPatientPageChange: (page: number) => void
  queueData: DoctorQueuePage | undefined
  queueError: Error | null
  queuePending: boolean
  selectedVirtualPatient: VirtualPatient | undefined
  startError: Error | null
  startPending: boolean
  virtualPatientData: VirtualPatientList | undefined
  virtualPatientError: Error | null
  virtualPatientPending: boolean
}): React.JSX.Element {
  const [selectedView, setSelectedView] = useState<'queue' | 'candidates'>()
  const view = selectedView ?? (!queuePending && queueData?.total === 0 ? 'candidates' : 'queue')
  return (
    <aside aria-label={messages.consultationQueue} className="min-w-0 border-b bg-background xl:border-r xl:border-b-0">
      <Tabs
        className="h-full min-w-0 gap-0"
        onValueChange={(value) => {
          if (value === 'queue' || value === 'candidates') setSelectedView(value)
        }}
        value={view}
      >
        <div className="border-b px-3 pt-3">
          <div className="flex items-center justify-between gap-2 pb-2">
            <h2 className="text-base font-semibold">{messages.waitingPatients}</h2>
            <Badge variant="secondary">
              {view === 'queue' ? (queueData?.total ?? 0) : (virtualPatientData?.total ?? 0)}
            </Badge>
          </div>
          <TabsList className="h-9 w-full justify-start" variant="line">
            <TabsTrigger className="flex-1" value="queue">
              {messages.consultationQueue}
              <span className="tabular-nums text-muted-foreground">{queueData?.total ?? 0}</span>
            </TabsTrigger>
            <TabsTrigger className="flex-1" value="candidates">
              {messages.virtualPatientCandidates}
              <span className="tabular-nums text-muted-foreground">{virtualPatientData?.total ?? 0}</span>
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent className="p-3" value="queue">
          <section aria-labelledby="consultation-queue-heading" className="flex min-w-0 flex-col gap-3">
            <h3 className="sr-only" id="consultation-queue-heading">{messages.consultationQueue}</h3>
            {queuePending ? <Skeleton className="h-44 w-full" /> : queueError !== null ? (
              <ErrorAlert error={queueError} fallbackTitle={messages.consultationUnavailable} messages={messages} />
            ) : queueData === undefined || queueData.items.length === 0 ? (
              <Empty className="min-h-44 border">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><StethoscopeIcon aria-hidden="true" /></EmptyMedia>
                  <EmptyTitle>{messages.noConsultationCases}</EmptyTitle>
                  <EmptyDescription>{messages.noConsultationCasesDescription}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <div className="flex max-h-[calc(100svh-19rem)] flex-col gap-2 overflow-y-auto pr-1" role="list">
                  {queueData.items.map(item => (
                    <DoctorCaseRow
                      item={item}
                      key={item.caseId}
                      messages={messages}
                      onSelect={() => onSelectCase(item.caseId)}
                      selected={item.caseId === activeCaseId}
                    />
                  ))}
                </div>
                <PaginationControls
                  messages={messages}
                  onPageChange={onQueuePageChange}
                  page={queueData.page}
                  pageSize={queueData.pageSize}
                  total={queueData.total}
                />
              </>
            )}
          </section>
        </TabsContent>

        <TabsContent className="p-3" value="candidates">
          <section aria-labelledby="virtual-patient-heading" className="flex min-w-0 flex-col gap-3">
            <h3 className="sr-only" id="virtual-patient-heading">{messages.virtualPatientCandidates}</h3>
            {virtualPatientPending ? <Skeleton className="h-44 w-full" /> : virtualPatientError !== null ? (
              <ErrorAlert error={virtualPatientError} fallbackTitle={messages.virtualPatientsUnavailable} messages={messages} />
            ) : virtualPatientData === undefined || virtualPatientData.items.length === 0 ? (
              <Empty className="min-h-44 border">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><UserRoundPlusIcon aria-hidden="true" /></EmptyMedia>
                  <EmptyTitle>{messages.noVirtualPatients}</EmptyTitle>
                  <EmptyDescription>{messages.noVirtualPatientsDescription}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <div className="flex max-h-[calc(100svh-29rem)] flex-col gap-2 overflow-y-auto pr-1">
                  {virtualPatientData.items.map(item => (
                    <VirtualPatientRow
                      item={item}
                      key={item.id}
                      messages={messages}
                      onSelect={() => onSelectVirtualPatient(item)}
                      selected={item.id === selectedVirtualPatient?.id}
                    />
                  ))}
                </div>
                {selectedVirtualPatient === undefined ? null : (
                  <div className="flex flex-col gap-3 border-t pt-3">
                    <p className="text-sm">{selectedVirtualPatient.presentation.summary}</p>
                    <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-xs">
                      <VitalSummary label="T" value={selectedVirtualPatient.presentation.vitalSigns.temperatureC} />
                      <VitalSummary label="P" value={selectedVirtualPatient.presentation.vitalSigns.pulseBpm} />
                      <VitalSummary label="R" value={selectedVirtualPatient.presentation.vitalSigns.respirationBpm} />
                      <VitalSummary label="BP" value={`${selectedVirtualPatient.presentation.vitalSigns.bloodPressure.systolicMmHg}/${selectedVirtualPatient.presentation.vitalSigns.bloodPressure.diastolicMmHg}`} />
                      <VitalSummary label="SpO2" value={selectedVirtualPatient.presentation.vitalSigns.oxygenSaturationPct} />
                    </dl>
                    {startError === null ? null : (
                      <ErrorAlert error={startError} fallbackTitle={messages.operationFailed} messages={messages} />
                    )}
                    <Button
                      disabled={startPending}
                      onClick={() => onStartVirtualPatient(selectedVirtualPatient)}
                      type="button"
                    >
                      {startPending ? <Spinner aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
                      {startPending ? messages.startingConsultation : messages.startConsultation}
                    </Button>
                  </div>
                )}
                <PaginationControls
                  messages={messages}
                  onPageChange={onVirtualPatientPageChange}
                  page={virtualPatientData.page}
                  pageSize={virtualPatientData.pageSize}
                  total={virtualPatientData.total}
                />
              </>
            )}
          </section>
        </TabsContent>
      </Tabs>
    </aside>
  )
}
