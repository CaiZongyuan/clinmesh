import type { DoctorQueueItem, DoctorQueueView } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { CircleAlertIcon, StethoscopeIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { PaginationControls } from '../pagination-controls.tsx'
import { QueuePatientRow } from '../queue-patient-row.tsx'
import { RegistrationNumber } from '../registration-number.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from '../workspace-error.ts'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { doctorCaseStatusLabel } from './doctor-case-status.ts'
import { patientAge } from './patient-summary.tsx'

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
  const demographics = [item.patient.gender === undefined ? undefined : messages[`gender_${item.patient.gender}` as 'gender_male'],
    age === undefined ? undefined : messages.patientAge.replace('{age}', String(age))].filter(Boolean).join(' · ')
  const acuity = item.triage?.acuityCode
  const acuityLabel = acuity === 'level-1' ? messages.acuity_level1
    : acuity === 'level-2' ? messages.acuity_level2
      : acuity === 'level-3' ? messages.acuity_level3
        : acuity === 'level-4' ? messages.acuity_level4 : acuity
  return (
    <li aria-label={label} className="list-none">
      <QueuePatientRow selectionId={item.caseId} label={label} name={item.patient.name} selected={selected} onSelect={onSelect}
        status={<span className="inline-flex max-w-full flex-wrap items-center justify-end gap-1">{acuityLabel === undefined ? null : <Badge variant="outline">{acuityLabel}</Badge>}<Badge variant="outline">{doctorCaseStatusLabel(item.status, messages)}</Badge></span>}
        description={<span className="flex flex-wrap gap-x-2 gap-y-1">{demographics ? <span>{demographics}</span> : null}<span>{item.presentation?.chiefComplaint ?? item.triage?.chiefComplaint ?? messages.triageNotRecorded}</span></span>}
        number={<RegistrationNumber messages={messages} registrationNumber={item.registrationNumber} hideLabel />} />
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
  onRetry,
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
  onRetry?: () => void
}): React.JSX.Element {
  return (
    <aside aria-label={messages.consultationQueue} className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b p-2">
        <div className="min-w-0 flex-1">{navigation}</div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden py-2">
        <section aria-labelledby="consultation-queue-heading" className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            <h3 className="sr-only" id="consultation-queue-heading">{messages.consultationQueue}</h3>
            {queuePending ? <Skeleton className="h-44 w-full" /> : queueError !== null ? (
              <><ErrorAlert error={queueError} fallbackTitle={messages.consultationUnavailable} messages={messages} />
                {onRetry === undefined ? null : <Button onClick={onRetry} type="button" variant="outline">{messages.suggestionRetry}</Button>}</>
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
                <ul data-workspace-queue-items="" className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
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
