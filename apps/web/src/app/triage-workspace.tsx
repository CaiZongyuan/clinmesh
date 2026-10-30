import type { SessionContext, TriageQueueItem } from '@clinmesh/contracts/his'
import { agentToolInputSchemas } from '@clinmesh/contracts/agent'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, CircleAlertIcon, HeartPulseIcon, UserRoundCheckIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { getTriageQueue, newIdempotencyKey, recordTriage } from './api-client.ts'
import { PaginationControls } from './pagination-controls.tsx'
import { RegistrationNumber } from './registration-number.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { agentViewRevision, useRegisterAgentPage } from './agent-page-context.tsx'
import { useAgentReview } from './agent-review.tsx'
import { AgentDraftField, WorkspaceActionBar, WorkspaceCard, WorkspaceCardLayout, WorkspacePatientCard, WorkspaceQueueCard, useWorkspaceCardView } from './workspace-card-layout.tsx'
import { outpatientFlow, type OutpatientFlowState } from './workspace-flow.ts'

interface TriageWorkspaceProps {
  locale: WorkspaceLocale
  session: SessionContext
}

type TriageStatus = 'completed' | 'pending'
type TriageAcuity = 'level-1' | 'level-2' | 'level-3' | 'level-4'

const statuses: TriageStatus[] = ['pending', 'completed']
const caseFlowStep: Readonly<Record<string, keyof OutpatientFlowState>> = {
  'awaiting-triage': 'triage',
  'awaiting-doctor': 'consultation',
  'first-visit': 'consultation',
  'awaiting-lab-payment': 'billing',
  'awaiting-lis': 'consultation',
  'awaiting-report': 'consultation',
  'awaiting-revisit': 'consultation',
  'revisit-draft': 'consultation',
  'awaiting-medication-payment': 'billing',
  'awaiting-dispense': 'pharmacy',
}
const acuities: TriageAcuity[] = ['level-1', 'level-2', 'level-3', 'level-4']
const vitalRanges = {
  temperatureC: { min: 30, max: 45, step: 0.1 },
  pulseBpm: { min: 20, max: 250, step: 1 },
  respirationBpm: { min: 5, max: 80, step: 1 },
  systolicMmHg: { min: 50, max: 260, step: 1 },
  diastolicMmHg: { min: 30, max: 180, step: 1 },
  oxygenSaturationPct: { min: 50, max: 100, step: 0.1 },
}
type VitalKey = keyof typeof vitalRanges
type TriageDraftField = VitalKey | 'chiefComplaint' | 'acuityCode'
type TriageDraft = Record<VitalKey | 'chiefComplaint', string> & {
  acuityCode: TriageAcuity
  assisted: readonly TriageDraftField[]
}
const defaultDraft: TriageDraft = {
  chiefComplaint: '', temperatureC: '37.0', pulseBpm: '92', respirationBpm: '18',
  systolicMmHg: '118', diastolicMmHg: '78', oxygenSaturationPct: '98', acuityCode: 'level-3', assisted: [],
}

export function TriageWorkspace({ locale, session }: TriageWorkspaceProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const agentReview = useAgentReview()
  const queryClient = useQueryClient()
  const scope = [session.actor.workspaceId, session.actor.epoch] as const
  const draftScope = JSON.stringify([session.actor.actorId, ...scope, session.actor.practitionerRoleId])
  const view = useWorkspaceCardView('triage-queue')
  const status: TriageStatus = view.tab === 'completed' ? 'completed' : 'pending'
  const [page, setPage] = useState(1)
  const [selectedCaseId, setSelectedCaseId] = useState<string>()
  const [drafts, setDrafts] = useState<Record<string, TriageDraft>>({})
  const acuityItems = acuities.map(value => ({
    label: messages[`acuity_${value.replace('-', '')}` as 'acuity_level1'],
    value,
  }))
  const queueKey = ['triage-queue', ...scope, status, page] as const
  const queue = useQuery({
    queryFn: ({ signal }) => getTriageQueue(status, signal, page),
    queryKey: queueKey,
  })
  const selectedCase = queue.data?.items.find(item => item.caseId === selectedCaseId)
    ?? queue.data?.items[0]
  const draftKey = selectedCase === undefined ? undefined : `${draftScope}:${selectedCase.caseId}`
  const draft = draftKey === undefined ? defaultDraft : drafts[draftKey] ?? defaultDraft
  const { chiefComplaint, temperatureC, pulseBpm, respirationBpm, systolicMmHg, diastolicMmHg, oxygenSaturationPct, acuityCode } = draft
  function setField<Field extends TriageDraftField>(field: Field, value: TriageDraft[Field]) {
    if (draftKey === undefined) return
    setDrafts(current => {
      const previous = current[draftKey] ?? defaultDraft
      return { ...current, [draftKey]: { ...previous, [field]: value, assisted: previous.assisted.filter(item => item !== field) } }
    })
  }
  const vitalValues = { temperatureC, pulseBpm, respirationBpm, systolicMmHg, diastolicMmHg, oxygenSaturationPct }
  const missingFields = [
    ...(chiefComplaint.trim() === '' ? [messages.chiefComplaint] : []),
    ...(Object.keys(vitalRanges) as VitalKey[])
      .filter(key => !validVital(vitalValues[key], vitalRanges[key]))
      .map(key => messages[key]),
  ]
  const canRecord = status === 'pending' && queue.isSuccess && selectedCase !== undefined && missingFields.length === 0
  const mutation = useMutation({
    mutationFn: ({ item, draft: values }: { item: TriageQueueItem; draft: TriageDraft; key: string }) => {
      return recordTriage({
        acuityCode: values.acuityCode,
        bloodPressure: {
          diastolicMmHg: Number(values.diastolicMmHg),
          systolicMmHg: Number(values.systolicMmHg),
        },
        chiefComplaint: values.chiefComplaint,
        encounterId: item.encounterId,
        encounterVersion: item.encounterVersion,
        oxygenSaturationPct: Number(values.oxygenSaturationPct),
        pulseBpm: Number(values.pulseBpm),
        respirationBpm: Number(values.respirationBpm),
        taskId: item.taskId,
        taskVersion: item.taskVersion,
        temperatureC: Number(values.temperatureC),
      }, newIdempotencyKey())
    },
    onSuccess: async (_response, { item, key }) => {
      setDrafts(current => { const next = { ...current }; delete next[key]; return next })
      if (key === `${draftScope}:${item.caseId}`) setSelectedCaseId(current => current === item.caseId ? undefined : current)
      await queryClient.invalidateQueries({ queryKey: ['triage-queue', ...scope] })
    },
  })

  const agentPage = useMemo(() => ({
    actions: {
      'triage.queue.read': {
        description: 'Read the current authorized triage queue page.',
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => getTriageQueue(status, signal, page),
      },
      'triage.case.select': {
        description: 'Select one case from the current triage queue.',
        enabled: (queue.data?.items.length ?? 0) > 0,
        parameters: {
          type: 'object' as const,
          properties: { caseId: { type: 'string', maxLength: 128 } },
          required: ['caseId'],
          additionalProperties: false,
        },
        execute: (raw: unknown) => {
          const { caseId } = agentToolInputSchemas['triage.case.select'].parse(raw)
          if (!queue.data?.items.some(item => item.caseId === caseId)) {
            throw new Error('Case is not in the current triage queue')
          }
          setSelectedCaseId(caseId)
          return { caseId, selected: true }
        },
      },
      'triage.draft.set': {
        description: 'Fill the current triage draft without submitting an Observation.',
        enabled: selectedCase !== undefined,
        parameters: {
          type: 'object' as const,
          properties: {
            acuityCode: { type: 'string', enum: acuities },
            chiefComplaint: { type: 'string', maxLength: 500 },
            diastolicMmHg: { type: 'number', minimum: 30, maximum: 180 },
            oxygenSaturationPct: { type: 'number', minimum: 50, maximum: 100 },
            pulseBpm: { type: 'number', minimum: 20, maximum: 250 },
            respirationBpm: { type: 'number', minimum: 5, maximum: 80 },
            systolicMmHg: { type: 'number', minimum: 50, maximum: 260 },
            temperatureC: { type: 'number', minimum: 30, maximum: 45 },
          },
          required: [
            'acuityCode', 'chiefComplaint', 'diastolicMmHg', 'oxygenSaturationPct',
            'pulseBpm', 'respirationBpm', 'systolicMmHg', 'temperatureC',
          ],
          additionalProperties: false,
        },
        execute: (raw: unknown) => {
          if (selectedCase === undefined || draftKey === undefined) throw new Error(messages.triageUnavailable)
          const values = agentToolInputSchemas['triage.draft.set'].parse(raw)
          setDrafts(current => ({ ...current, [draftKey]: {
            acuityCode: values.acuityCode, chiefComplaint: values.chiefComplaint,
            diastolicMmHg: String(values.diastolicMmHg), oxygenSaturationPct: String(values.oxygenSaturationPct),
            pulseBpm: String(values.pulseBpm), respirationBpm: String(values.respirationBpm),
            systolicMmHg: String(values.systolicMmHg), temperatureC: String(values.temperatureC),
            assisted: ['chiefComplaint', 'temperatureC', 'pulseBpm', 'respirationBpm', 'systolicMmHg', 'diastolicMmHg', 'oxygenSaturationPct', 'acuityCode'],
          } }))
          return { updated: true }
        },
      },
      'triage.record.propose': {
        description: 'Open human review for the current triage draft.',
        enabled: canRecord,
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => {
          if (selectedCase === undefined || draftKey === undefined || !canRecord) throw new Error(messages.triageUnavailable)
          return agentReview.request({
            confirmLabel: locale => getWorkspaceMessages(locale).completeTriage,
            description: locale => `${selectedCase.patient.name} · ${temperatureC} °C · ${getWorkspaceMessages(locale)[`acuity_${acuityCode.replace('-', '')}` as 'acuity_level1']}`,
            onConfirm: () => mutation.mutateAsync({ item: selectedCase, draft, key: draftKey }),
            signal,
            title: locale => getWorkspaceMessages(locale).triageAssessment,
          })
        },
      },
    },
    claim: {
      version: 1 as const,
      viewId: 'triage' as const,
      viewRevision: agentViewRevision({
        acuityCode,
        chiefComplaint,
        diastolicMmHg,
        oxygenSaturationPct,
        page,
        pulseBpm,
        respirationBpm,
        selectedCaseId: selectedCase?.caseId,
        status,
        systolicMmHg,
        temperatureC,
      }),
      activeSection: status,
      ...(selectedCase === undefined ? {} : {
        selection: {
          id: selectedCase.caseId,
          kind: 'triage-item' as const,
          version: selectedCase.taskVersion,
        },
        draft: {
          dirty: chiefComplaint !== '',
          id: `${selectedCase.caseId}:triage`,
          kind: 'triage' as const,
          revision: agentViewRevision({
            acuityCode,
            chiefComplaint,
            diastolicMmHg,
            oxygenSaturationPct,
            pulseBpm,
            respirationBpm,
            systolicMmHg,
            temperatureC,
          }),
        },
      }),
      ui: {
        status: queue.isPending ? 'loading' as const
          : queue.isError ? 'error' as const
            : queue.data?.items.length === 0 ? 'empty' as const : 'ready' as const,
      },
    },
    label: 'ClinMesh · 门诊分诊',
    readState: () => ({
      draft: {
        acuityCode,
        chiefComplaint,
        diastolicMmHg: Number(diastolicMmHg),
        oxygenSaturationPct: Number(oxygenSaturationPct),
        pulseBpm: Number(pulseBpm),
        respirationBpm: Number(respirationBpm),
        systolicMmHg: Number(systolicMmHg),
        temperatureC: Number(temperatureC),
      },
      queueCount: queue.data?.total ?? 0,
      selectedCase: selectedCase === undefined ? null : {
        caseId: selectedCase.caseId,
        encounterId: selectedCase.encounterId,
        patientName: selectedCase.patient.name,
      },
      status,
    }),
  }), [
    acuityCode,
    agentReview,
    chiefComplaint,
    diastolicMmHg,
    messages,
    mutation.mutateAsync,
    oxygenSaturationPct,
    page,
    pulseBpm,
    queue.data,
    queue.isError,
    queue.isPending,
    respirationBpm,
    selectedCase,
    status,
    canRecord,
    draft,
    draftKey,
    systolicMmHg,
    temperatureC,
  ])
  useRegisterAgentPage(agentPage)

  const patientCard = selectedCase === undefined ? null : <section aria-label={locale === 'zh-CN' ? '当前患者' : 'Current patient'}>
    <WorkspacePatientCard title={selectedCase.patient.name}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <RegistrationNumber key={selectedCase.caseId} messages={messages} registrationNumber={selectedCase.registrationNumber} />
        <Badge variant="outline">{messages.patientNumber}：{selectedCase.patient.identifier}</Badge>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <div><dt className="text-muted-foreground">{messages.department}</dt><dd>{locale === 'zh-CN' ? selectedCase.department.nameZh : selectedCase.department.nameEn}</dd></div>
        <div><dt className="text-muted-foreground">{messages.location}</dt><dd>{locale === 'zh-CN' ? selectedCase.location.nameZh : selectedCase.location.nameEn}</dd></div>
        <div><dt className="text-muted-foreground">{messages.visitType}</dt><dd>{locale === 'zh-CN' ? selectedCase.visitType.nameZh : selectedCase.visitType.nameEn}</dd></div>
        <div><dt className="text-muted-foreground">{messages.arrivalTime}</dt><dd className="tabular-nums">{new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(selectedCase.arrivedAt))}</dd></div>
      </dl>
    </WorkspacePatientCard>
  </section>
  const riskCard = selectedCase === undefined ? null : <section aria-label={messages.riskInformation}>
    <WorkspaceCard title={<h2>{messages.riskInformation}</h2>}>
      <Alert variant={selectedCase.riskFlags.length === 0 ? 'default' : 'destructive'}>
        {selectedCase.riskFlags.length === 0 ? <UserRoundCheckIcon aria-hidden="true" /> : <CircleAlertIcon aria-hidden="true" />}
        <AlertDescription>{selectedCase.riskFlags.length === 0 ? messages.noKnownRisks : selectedCase.riskFlags.map(risk => risk.display).join('; ')}</AlertDescription>
      </Alert>
    </WorkspaceCard>
  </section>
  const actionBar = status === 'pending' && selectedCase !== undefined
    ? <WorkspaceActionBar summary={selectedCase.patient.name} tone={canRecord ? 'normal' : 'blocked'}
        reason={queue.isError ? (locale === 'zh-CN' ? '请先重试分诊队列' : 'Retry the triage queue first') : missingFields.length === 0
          ? (locale === 'zh-CN' ? '已填写完整，可以完成分诊' : 'Ready to complete triage')
          : `${locale === 'zh-CN' ? '还差：' : 'Still needed: '}${missingFields.join(locale === 'zh-CN' ? '、' : ', ')}`}
        action={<Button disabled={mutation.isPending || !canRecord} type="submit" form="triage-assessment-form"><HeartPulseIcon data-icon="inline-start" />{messages.completeTriage}</Button>} />
    : mutation.isSuccess ? <WorkspaceActionBar tone="complete" reason={`${messages.triageCompleted} · ${messages.awaitingDoctor}`} /> : null
  const flowState: OutpatientFlowState = {}
  if (selectedCase !== undefined) {
    flowState.registration = 'completed'
    if (selectedCase.status !== 'awaiting-triage') flowState.triage = 'completed'
    if (selectedCase.status === 'completed') flowState.consultation = 'completed'
    const current = caseFlowStep[selectedCase.status]
    if (current !== undefined) flowState[current] = 'current'
  }

  return (
    <WorkspaceCardLayout id="triage" locale={locale} flow={outpatientFlow(locale, flowState)}
      patient={patientCard} aside={riskCard} action={actionBar} queue={
      <section aria-labelledby="triage-queue-heading" className="min-w-0">
        <WorkspaceQueueCard>
        <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold" id="triage-queue-heading">{messages.triageQueue}</h2>
          <Badge variant="secondary">{queue.data?.total ?? 0}</Badge>
        </div>
        <Tabs onValueChange={(value) => {
          if (value === 'pending' || value === 'completed') view.setTab(value)
          setPage(1)
          setSelectedCaseId(undefined)
        }} value={status}>
          <TabsList className="w-full">
            {statuses.map(value => (
              <TabsTrigger className="min-w-0 flex-1" key={value} value={value}>
                {value === 'pending' ? messages.pendingTriage : messages.completedTriage}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {queue.isPending ? <Skeleton className="h-44 w-full" /> : queue.isError ? (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>{locale === 'zh-CN' ? '分诊队列读取失败' : 'Could not load the triage queue'}</AlertTitle>
            <AlertDescription>{getWorkspaceErrorMessage(queue.error, messages)}</AlertDescription>
            <Button disabled={queue.isFetching} onClick={() => void queue.refetch()} type="button" variant="outline">{locale === 'zh-CN' ? '重试分诊队列' : 'Retry triage queue'}</Button>
          </Alert>
        ) : queue.data.items.length === 0 ? (
          <Empty className="min-h-44 border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><HeartPulseIcon aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{messages.noTriageCases}</EmptyTitle>
              <EmptyDescription>{status === 'pending'
                ? (locale === 'zh-CN' ? '暂无待分诊患者，请先由挂号员办理挂号。' : 'No patients awaiting triage. Ask the registrar to register a visit first.')
                : (locale === 'zh-CN' ? '暂无已分诊患者，完成分诊后可在这里回查。' : 'Completed triage assessments appear here after triage.')}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-2" role="list" data-workspace-queue-items="">
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
        </div>
        </WorkspaceQueueCard>
      </section>}>

      <section aria-labelledby="triage-assessment-heading" className="flex min-w-0 flex-col gap-4">
        <WorkspaceCard>
        <div className="flex flex-col gap-4">
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
        {queue.isPending ? <Skeleton className="h-44 w-full" /> : queue.isError ? (
          <p role="status" className="text-sm text-muted-foreground">{locale === 'zh-CN' ? '暂无法显示分诊资料，请先重试队列。' : 'Triage details are unavailable. Retry the queue first.'}</p>
        ) : status !== 'pending' || selectedCase === undefined ? (
          <Empty className="min-h-44 border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><UserRoundCheckIcon aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{messages.noTriageCases}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <form
            id="triage-assessment-form"
            onSubmit={event => {
              event.preventDefault()
              if (canRecord && selectedCase !== undefined && draftKey !== undefined) mutation.mutate({ item: selectedCase, draft, key: draftKey })
            }}
          >
            <FieldGroup>
              <AgentDraftField assisted={draft.assisted.includes('chiefComplaint')} locale={locale}><Field>
                <FieldLabel htmlFor="triage-chief-complaint">{messages.chiefComplaint}</FieldLabel>
                <Textarea id="triage-chief-complaint" onChange={event => setField('chiefComplaint', event.currentTarget.value)} required value={chiefComplaint} />
              </Field></AgentDraftField>
              <div className="flex flex-col gap-2">
                <h3 className="font-medium">{locale === 'zh-CN' ? '生命体征' : 'Vital signs'}</h3>
                <p className="text-sm text-muted-foreground">{locale === 'zh-CN' ? '默认值不是测量结果' : 'Default values are not measurements'}</p>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <VitalField id="triage-temperature" label={messages.temperatureC} {...vitalRanges.temperatureC} locale={locale} assisted={draft.assisted.includes('temperatureC')} onChange={value => setField('temperatureC', value)} value={temperatureC} />
                <VitalField id="triage-pulse" label={messages.pulseBpm} {...vitalRanges.pulseBpm} locale={locale} assisted={draft.assisted.includes('pulseBpm')} onChange={value => setField('pulseBpm', value)} value={pulseBpm} />
                <VitalField id="triage-respiration" label={messages.respirationBpm} {...vitalRanges.respirationBpm} locale={locale} assisted={draft.assisted.includes('respirationBpm')} onChange={value => setField('respirationBpm', value)} value={respirationBpm} />
                <VitalField id="triage-systolic" label={messages.systolicMmHg} {...vitalRanges.systolicMmHg} locale={locale} assisted={draft.assisted.includes('systolicMmHg')} onChange={value => setField('systolicMmHg', value)} value={systolicMmHg} />
                <VitalField id="triage-diastolic" label={messages.diastolicMmHg} {...vitalRanges.diastolicMmHg} locale={locale} assisted={draft.assisted.includes('diastolicMmHg')} onChange={value => setField('diastolicMmHg', value)} value={diastolicMmHg} />
                <VitalField id="triage-oxygen" label={messages.oxygenSaturationPct} {...vitalRanges.oxygenSaturationPct} locale={locale} assisted={draft.assisted.includes('oxygenSaturationPct')} onChange={value => setField('oxygenSaturationPct', value)} value={oxygenSaturationPct} />
              </div>
              <AgentDraftField assisted={draft.assisted.includes('acuityCode')} locale={locale}><Field>
                <FieldLabel id="triage-acuity-label">{messages.acuity}</FieldLabel>
                <ToggleGroup aria-labelledby="triage-acuity-label" className="max-w-full flex-wrap" value={[acuityCode]} variant="outline" onValueChange={values => {
                  const next = acuities.find(value => value === values[0])
                  if (next !== undefined) setField('acuityCode', next)
                }}>
                  {acuityItems.map(item => <ToggleGroupItem key={item.value} value={item.value}>{item.label}</ToggleGroupItem>)}
                </ToggleGroup>
              </Field></AgentDraftField>
            </FieldGroup>
          </form>
        )}
        </div>
        </WorkspaceCard>
      </section>
    </WorkspaceCardLayout>
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
  const messages = getWorkspaceMessages(locale)
  return (
    <div aria-label={`${selectLabel} ${item.patient.name}`} className="flex min-w-0 flex-col gap-1" role="listitem">
      <Button
        aria-label={`${selectLabel} ${item.patient.name}`}
        data-agent-selection={item.caseId}
        className="h-auto min-h-12 w-full justify-between gap-3 px-3 py-2 text-left"
        onClick={onSelect}
        type="button"
        variant={selected ? 'secondary' : 'outline'}
      >
        <span className="min-w-0 truncate font-medium">{item.patient.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(item.arrivedAt))}
        </span>
      </Button>
      <div className="px-3 text-xs text-muted-foreground"><RegistrationNumber messages={messages} registrationNumber={item.registrationNumber} /></div>
    </div>
  )
}

function VitalField({
  assisted,
  id,
  label,
  locale,
  max,
  min,
  onChange,
  step = 1,
  value,
}: {
  assisted: boolean
  id: string
  label: string
  locale: WorkspaceLocale
  max: number
  min: number
  onChange: (value: string) => void
  step?: number
  value: string
}): React.JSX.Element {
  const invalid = !validVital(value, { min, max, step })
  return (
    <AgentDraftField assisted={assisted} locale={locale}><Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        aria-describedby={`${id}-range${invalid ? ` ${id}-error` : ''}`}
        aria-invalid={invalid || undefined}
        max={max}
        min={min}
        onChange={event => onChange(event.currentTarget.value)}
        required
        step={step}
        type="number"
        value={value}
      />
      <FieldDescription id={`${id}-range`}>{locale === 'zh-CN' ? '可录入范围：' : 'Accepted range: '}{min}–{max}</FieldDescription>
      {invalid ? <FieldError id={`${id}-error`}>{locale === 'zh-CN'
        ? `请输入${min}–${max}范围内的有效数值`
        : `Enter a valid number from ${min} to ${max}`}</FieldError> : null}
    </Field></AgentDraftField>
  )
}

function validVital(value: string, { min, max, step }: { min: number; max: number; step: number }): boolean {
  const number = Number(value)
  return value.trim() !== '' && Number.isFinite(number) && number >= min && number <= max
    && Number.isInteger(step === 0.1 ? number * 10 : number)
}
