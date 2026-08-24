import type { SessionContext, TriageQueueItem } from '@clinmesh/contracts/his'
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
import { Tabs, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, CircleAlertIcon, HeartPulseIcon, UserRoundCheckIcon } from 'lucide-react'
import { useState } from 'react'
import { getTriageQueue, newIdempotencyKey, recordTriage } from './api-client.ts'
import { PaginationControls } from './pagination-controls.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'

interface TriageWorkspaceProps {
  locale: WorkspaceLocale
  session: SessionContext
}

type TriageStatus = 'completed' | 'exception' | 'pending'
type TriageAcuity = 'level-1' | 'level-2' | 'level-3' | 'level-4'

const statuses: TriageStatus[] = ['pending', 'completed', 'exception']
const acuities: TriageAcuity[] = ['level-1', 'level-2', 'level-3', 'level-4']

export function TriageWorkspace({ locale, session }: TriageWorkspaceProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const queryClient = useQueryClient()
  const scope = [session.actor.workspaceId, session.actor.epoch] as const
  const [status, setStatus] = useState<TriageStatus>('pending')
  const [page, setPage] = useState(1)
  const [selectedCaseId, setSelectedCaseId] = useState<string>()
  const [chiefComplaint, setChiefComplaint] = useState('')
  const [temperatureC, setTemperatureC] = useState('37.0')
  const [pulseBpm, setPulseBpm] = useState('92')
  const [respirationBpm, setRespirationBpm] = useState('18')
  const [systolicMmHg, setSystolicMmHg] = useState('118')
  const [diastolicMmHg, setDiastolicMmHg] = useState('78')
  const [oxygenSaturationPct, setOxygenSaturationPct] = useState('98')
  const [acuityCode, setAcuityCode] = useState<TriageAcuity>('level-3')
  const queueKey = ['triage-queue', ...scope, status, page] as const
  const queue = useQuery({
    queryFn: ({ signal }) => getTriageQueue(status, signal, page),
    queryKey: queueKey,
  })
  const selectedCase = queue.data?.items.find(item => item.caseId === selectedCaseId)
    ?? queue.data?.items[0]
  const mutation = useMutation({
    mutationFn: () => {
      if (selectedCase === undefined) throw new Error(messages.triageUnavailable)
      return recordTriage({
        acuityCode,
        bloodPressure: {
          diastolicMmHg: Number(diastolicMmHg),
          systolicMmHg: Number(systolicMmHg),
        },
        chiefComplaint,
        encounterId: selectedCase.encounterId,
        encounterVersion: selectedCase.encounterVersion,
        oxygenSaturationPct: Number(oxygenSaturationPct),
        pulseBpm: Number(pulseBpm),
        respirationBpm: Number(respirationBpm),
        taskId: selectedCase.taskId,
        taskVersion: selectedCase.taskVersion,
        temperatureC: Number(temperatureC),
      }, newIdempotencyKey())
    },
    onSuccess: async () => {
      setChiefComplaint('')
      setSelectedCaseId(undefined)
      await queryClient.invalidateQueries({ queryKey: ['triage-queue', ...scope] })
    },
  })

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(18rem,0.8fr)_minmax(28rem,1.2fr)]">
      <section aria-labelledby="triage-queue-heading" className="flex min-w-0 flex-col gap-4 border-b pb-6 xl:border-r xl:border-b-0 xl:pr-6">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold" id="triage-queue-heading">{messages.triageQueue}</h2>
          <Badge variant="secondary">{queue.data?.total ?? 0}</Badge>
        </div>
        <Tabs onValueChange={(value) => {
          setStatus(value as TriageStatus)
          setPage(1)
          setSelectedCaseId(undefined)
        }} value={status}>
          <TabsList className="w-full">
            {statuses.map(value => (
              <TabsTrigger className="min-w-0 flex-1" key={value} value={value}>
                {value === 'pending' ? messages.pendingTriage : value === 'completed' ? messages.completedTriage : messages.exceptionQueue}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {queue.isPending ? <Skeleton className="h-44 w-full" /> : queue.isError ? (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>{getWorkspaceErrorTitle(queue.error, messages, messages.triageUnavailable)}</AlertTitle>
            <AlertDescription>{getWorkspaceErrorMessage(queue.error, messages)}</AlertDescription>
          </Alert>
        ) : queue.data.items.length === 0 ? (
          <Empty className="min-h-44 border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><HeartPulseIcon aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{messages.noTriageCases}</EmptyTitle>
              <EmptyDescription>{messages.noTriageCasesDescription}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-2" role="list">
            {queue.data.items.map(item => (
              <CaseRow
                item={item}
                key={item.caseId}
                locale={locale}
                onSelect={() => setSelectedCaseId(item.caseId)}
                selected={item.caseId === selectedCase?.caseId}
                selectLabel={messages.selectCase}
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

      <section aria-labelledby="triage-assessment-heading" className="flex min-w-0 flex-col gap-4">
        <h2 className="text-base font-semibold" id="triage-assessment-heading">{messages.triageAssessment}</h2>
        {mutation.isSuccess ? (
          <Alert>
            <CheckIcon aria-hidden="true" />
            <AlertTitle>{messages.triageCompleted}</AlertTitle>
            <AlertDescription>{messages.awaitingDoctor}</AlertDescription>
          </Alert>
        ) : null}
        {mutation.isError ? (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>{getWorkspaceErrorTitle(mutation.error, messages, messages.operationFailed)}</AlertTitle>
            <AlertDescription>{getWorkspaceErrorMessage(mutation.error, messages)}</AlertDescription>
          </Alert>
        ) : null}
        {status !== 'pending' || selectedCase === undefined ? (
          <Empty className="min-h-44 border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><UserRoundCheckIcon aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{messages.noTriageCases}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <form
            onSubmit={event => {
              event.preventDefault()
              mutation.mutate()
            }}
          >
            <FieldGroup>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{selectedCase.patient.name}</div>
                  <div className="text-sm text-muted-foreground">{selectedCase.registrationNumber}</div>
                </div>
                <Badge variant="outline">{selectedCase.patient.identifier}</Badge>
              </div>
              <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <div><dt className="text-muted-foreground">{messages.location}</dt><dd className="font-medium">{selectedCase.locationId}</dd></div>
                <div><dt className="text-muted-foreground">{messages.visitType}</dt><dd className="font-medium">{selectedCase.visitTypeId}</dd></div>
              </dl>
              <Field>
                <FieldLabel htmlFor="triage-chief-complaint">{messages.chiefComplaint}</FieldLabel>
                <Textarea id="triage-chief-complaint" onChange={event => setChiefComplaint(event.currentTarget.value)} required value={chiefComplaint} />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <VitalField id="triage-temperature" label={messages.temperatureC} max="45" min="30" onChange={setTemperatureC} step="0.1" value={temperatureC} />
                <VitalField id="triage-pulse" label={messages.pulseBpm} max="250" min="20" onChange={setPulseBpm} value={pulseBpm} />
                <VitalField id="triage-respiration" label={messages.respirationBpm} max="80" min="5" onChange={setRespirationBpm} value={respirationBpm} />
                <VitalField id="triage-systolic" label={messages.systolicMmHg} max="260" min="50" onChange={setSystolicMmHg} value={systolicMmHg} />
                <VitalField id="triage-diastolic" label={messages.diastolicMmHg} max="180" min="30" onChange={setDiastolicMmHg} value={diastolicMmHg} />
                <VitalField id="triage-oxygen" label={messages.oxygenSaturationPct} max="100" min="50" onChange={setOxygenSaturationPct} step="0.1" value={oxygenSaturationPct} />
              </div>
              <Field>
                <FieldLabel htmlFor="triage-acuity">{messages.acuity}</FieldLabel>
                <Select onValueChange={value => setAcuityCode(value as TriageAcuity)} value={acuityCode}>
                  <SelectTrigger className="w-full" id="triage-acuity"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{acuities.map(value => (
                    <SelectItem key={value} value={value}>{messages[`acuity_${value.replace('-', '')}` as 'acuity_level1']}</SelectItem>
                  ))}</SelectGroup></SelectContent>
                </Select>
              </Field>
              <div className="sticky bottom-0 flex justify-end border-t bg-background py-3">
                <Button disabled={mutation.isPending} type="submit">
                  <HeartPulseIcon data-icon="inline-start" />
                  {messages.completeTriage}
                </Button>
              </div>
            </FieldGroup>
          </form>
        )}
      </section>
    </div>
  )
}

function CaseRow({
  item,
  locale,
  onSelect,
  selected,
  selectLabel,
}: {
  item: TriageQueueItem
  locale: WorkspaceLocale
  onSelect: () => void
  selected: boolean
  selectLabel: string
}): React.JSX.Element {
  return (
    <Button
      aria-label={`${selectLabel} ${item.patient.name}`}
      className="h-auto min-h-16 w-full justify-between gap-3 px-3 py-2 text-left"
      onClick={onSelect}
      role="listitem"
      type="button"
      variant={selected ? 'secondary' : 'outline'}
    >
      <span className="min-w-0">
        <span className="block truncate font-medium">{item.patient.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{item.registrationNumber}</span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(item.arrivedAt))}
      </span>
    </Button>
  )
}

function VitalField({
  id,
  label,
  max,
  min,
  onChange,
  step = '1',
  value,
}: {
  id: string
  label: string
  max: string
  min: string
  onChange: (value: string) => void
  step?: string
  value: string
}): React.JSX.Element {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        max={max}
        min={min}
        onChange={event => onChange(event.currentTarget.value)}
        required
        step={step}
        type="number"
        value={value}
      />
    </Field>
  )
}
