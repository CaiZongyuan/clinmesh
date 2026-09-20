import type { DoctorQueueItem, DoctorQueueView } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { CircleAlertIcon, StethoscopeIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { PaginationControls } from '../pagination-controls.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from '../workspace-error.ts'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { doctorCaseStatusLabel } from './doctor-case-status.ts'
import { patientAge, PatientAvatar } from './patient-summary.tsx'

type WorkspaceMessages = ReturnType<typeof getWorkspaceMessages>

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

function DoctorCaseRow({ item, messages, onSelect, selected }: {
  item: DoctorQueueItem
  messages: WorkspaceMessages
  onSelect: () => void
  selected: boolean
}): React.JSX.Element {
  const label = `${messages.selectCase} ${item.patient.name}`
  const age = patientAge(item.patient.birthDate)
  return (
    <li aria-label={label} className="list-none">
      <Button
        aria-label={label}
        data-agent-selection={item.caseId}
        className={`h-auto min-h-20 w-full justify-between gap-3 rounded-md border px-3 py-2 text-left ${selected
          ? 'border-primary/40 bg-primary/5'
          : 'border-border bg-background hover:border-foreground/20'}`}
        onClick={onSelect}
        type="button"
        variant="ghost"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <PatientAvatar className="size-9" label={`${item.patient.name} ${messages.patient}`} name={item.patient.name} />
          <span className="min-w-0">
            <span className="flex min-w-0 flex-col gap-1">
              <span className="truncate font-medium" title={item.patient.name}>{item.patient.name}</span>
              <span className="text-xs text-muted-foreground">
                {messages[`gender_${item.patient.gender}` as 'gender_male']} · {age === undefined ? '-' : messages.patientAge.replace('{age}', String(age))}
              </span>
            </span>
            <span className="mt-1 block truncate text-xs text-muted-foreground">{item.presentation?.chiefComplaint ?? messages.triageNotRecorded}</span>
          </span>
        </span>
        <Badge className="shrink-0" variant="outline">{doctorCaseStatusLabel(item.status, messages)}</Badge>
      </Button>
    </li>
  )
}

export function DoctorQueueModule({
  navigation,
  queueView,
  activeCaseId,
  messages,
  onQueuePageChange,
  onSelectCase,
  queueData,
  queueError,
  queuePending,
}: {
  navigation: ReactNode
  queueView: DoctorQueueView
  activeCaseId: string | undefined
  messages: WorkspaceMessages
  onQueuePageChange: (page: number) => void
  onSelectCase: (caseId: string) => void
  queueData: DoctorQueuePage | undefined
  queueError: Error | null
  queuePending: boolean
}): React.JSX.Element {
  return (
    <aside aria-label={messages.consultationQueue} className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="shrink-0 border-b p-2">{navigation}</div>
      <div className="shrink-0 border-b px-3 pt-3">
        <div className="flex items-center justify-between gap-2 pb-2">
          <h2 className="text-sm font-semibold">{queueView === 'active' ? messages.doctorActiveQueue : messages.doctorWaitingQueue}</h2>
          <Badge variant="secondary">{queueData?.total ?? 0}</Badge>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
        <section aria-labelledby="consultation-queue-heading" className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            <h3 className="sr-only" id="consultation-queue-heading">{messages.consultationQueue}</h3>
            {queuePending ? <Skeleton className="h-44 w-full" /> : queueError !== null ? (
              <ErrorAlert error={queueError} fallbackTitle={messages.consultationUnavailable} messages={messages} />
            ) : queueData === undefined || queueData.items.length === 0 ? (
              <Empty className="min-h-44 border">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><StethoscopeIcon aria-hidden="true" /></EmptyMedia>
                  <EmptyTitle>{queueView === 'active' ? messages.doctorActiveQueueEmpty : messages.noConsultationCases}</EmptyTitle>
                  <EmptyDescription>{messages.noConsultationCasesDescription}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
                  {queueData.items.map(item => (
                    <DoctorCaseRow
                      item={item}
                      key={item.caseId}
                      messages={messages}
                      onSelect={() => onSelectCase(item.caseId)}
                      selected={item.caseId === activeCaseId}
                    />
                  ))}
                </ul>
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
      </div>
    </aside>
  )
}
