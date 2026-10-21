import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { modelUsageFeatureSchema, modelUsageFilterSchema, modelUsageAttemptSchema,
  type ModelUsageAttempt, type ModelUsageFilter, type ModelUsageOverview } from '@clinmesh/contracts/model-usage'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@clinmesh/ui/components/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { getModelUsageOverview, getModelUsageRequest, getModelUsageRequests } from './model-usage-api.ts'
import { modelUsageMessages } from './model-usage-i18n.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

type Messages = ReturnType<typeof modelUsageMessages>
const initialFilters: ModelUsageFilter = { offset: 0, limit: 25 }

function formatCount(value: number | null, locale: WorkspaceLocale, messages: Messages) {
  return value === null ? messages.unknown : new Intl.NumberFormat(locale).format(value)
}

function Loading({ messages }: { messages: Messages }) {
  return <div role="status" className="flex flex-col gap-3"><span>{messages.loading}</span><Skeleton className="h-24 w-full" /></div>
}

function ReadError({ title, messages, retry }: { title: string; messages: Messages; retry(): void }) {
  return <Alert variant="destructive"><AlertTitle>{title}</AlertTitle><AlertDescription>
    <Button onClick={retry} size="sm" variant="outline">{messages.retry}</Button>
  </AlertDescription></Alert>
}

function NoRequests({ messages }: { messages: Messages }) {
  return <Empty><EmptyHeader><EmptyTitle>{messages.empty}</EmptyTitle>
    <EmptyDescription>{messages.emptyDescription}</EmptyDescription></EmptyHeader></Empty>
}

function Summary({ data, locale, messages }: { data: ModelUsageOverview; locale: WorkspaceLocale; messages: Messages }) {
  const { totals } = data
  const metrics = [
    { label: messages.dispatched, value: formatCount(totals.requests, locale, messages), description: messages.dispatchScope },
    { label: messages.knownTokens, value: formatCount(totals.knownTokens, locale, messages),
      description: `${formatCount(totals.unknownTokenRequests, locale, messages)} ${messages.unknownTokenRequests}` },
    { label: messages.cost, value: messages.unknown,
      description: `${formatCount(totals.unpricedRequests, locale, messages)} ${messages.unpricedRequests}` },
    { label: messages.outstanding, value: `${totals.inFlight} / ${totals.unknownRequests}`,
      description: `${messages.inFlight} / ${messages.unresolved}` },
  ]
  return <div className="flex min-w-0 flex-col gap-3"><div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4">
    {metrics.map(metric => <Card key={metric.label} aria-label={metric.label} role="region" size="sm">
      <CardHeader><CardTitle>{metric.label}</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2"><p className="text-2xl font-semibold tabular-nums">{metric.value}</p>
        <p className="text-sm text-muted-foreground">{metric.description}</p></CardContent>
    </Card>)}
  </div><p className="text-sm text-muted-foreground">{messages.reservations}</p></div>
}

function UsageCharts({ data, locale, messages }: { data: ModelUsageOverview; locale: WorkspaceLocale; messages: Messages }) {
  const maximum = Math.max(1, ...data.trend.map(item => item.requests))
  const featureMaximum = Math.max(1, ...data.features.map(item => item.requests))
  return <div className="grid min-w-0 gap-4 xl:grid-cols-2">
    <Card className="min-w-0"><CardHeader><CardTitle>{messages.trend}</CardTitle>
      <CardDescription>{messages.requestCount} / {messages.knownTokens}</CardDescription></CardHeader><CardContent>
      {data.trend.length === 0 ? <NoRequests messages={messages} /> : <Table aria-label={messages.trend}>
        <TableHeader><TableRow><TableHead>{messages.date}</TableHead><TableHead>{messages.requestCount}</TableHead>
          <TableHead>{messages.knownTokens}</TableHead></TableRow></TableHeader>
        <TableBody>{data.trend.map(item => <TableRow key={item.date}>
          <TableCell>{item.date}</TableCell><TableCell><div className="flex min-w-20 items-center gap-2">
            <span className="tabular-nums">{formatCount(item.requests, locale, messages)}</span>
            <div aria-hidden="true" className="h-2 flex-1 rounded bg-muted"><div className="h-2 rounded bg-primary" style={{ width: `${item.requests / maximum * 100}%` }} /></div>
          </div></TableCell><TableCell className="tabular-nums">{formatCount(item.knownTokens, locale, messages)}</TableCell>
        </TableRow>)}</TableBody></Table>}
    </CardContent></Card>
    <Card className="min-w-0"><CardHeader><CardTitle>{messages.distribution}</CardTitle>
      <CardDescription>{messages.requestCount} / {messages.knownTokens}</CardDescription></CardHeader><CardContent>
      {data.features.length === 0 ? <NoRequests messages={messages} /> : <Table aria-label={messages.distribution}>
        <TableHeader><TableRow><TableHead>{messages.feature}</TableHead><TableHead>{messages.requestCount}</TableHead><TableHead>{messages.knownTokens}</TableHead></TableRow></TableHeader>
        <TableBody>{data.features.map(item => <TableRow key={item.feature}>
          <TableCell>{messages.featureLabel(item.feature)}</TableCell><TableCell><div className="flex min-w-20 items-center gap-2">
            <span className="tabular-nums">{formatCount(item.requests, locale, messages)}</span>
            <div aria-hidden="true" className="h-2 flex-1 rounded bg-muted"><div className="h-2 rounded bg-primary" style={{ width: `${item.requests / featureMaximum * 100}%` }} /></div>
          </div></TableCell><TableCell className="tabular-nums">{formatCount(item.knownTokens, locale, messages)}</TableCell>
        </TableRow>)}</TableBody></Table>}
    </CardContent></Card>
  </div>
}

function RequestTable({ items, locale, messages, select }: {
  items: ModelUsageAttempt[]; locale: WorkspaceLocale; messages: Messages; select(id: string, trigger: HTMLButtonElement): void
}) {
  if (items.length === 0) return <NoRequests messages={messages} />
  return <Table aria-label={messages.requests}><TableHeader><TableRow>
    {[messages.requestTime, messages.feature, messages.provider, messages.actualModel, messages.result, messages.token, messages.cost, messages.detail]
      .map(label => <TableHead key={label}>{label}</TableHead>)}
  </TableRow></TableHeader><TableBody>{items.map(item => <TableRow key={item.id}>
    <TableCell><time dateTime={item.startedAt}>{new Date(item.startedAt).toLocaleString(locale)}</time></TableCell>
    <TableCell>{messages.featureLabel(item.feature)}<p className="text-xs text-muted-foreground">{messages.kindLabel(item.kind)}</p></TableCell>
    <TableCell>{item.provider}</TableCell>
    <TableCell className="max-w-56 whitespace-normal break-all">{item.actualModel ?? messages.notReturned}</TableCell>
    <TableCell><Badge variant={item.status === 'failed' ? 'destructive' : 'secondary'}>{messages.statusLabel(item.status)}</Badge></TableCell>
    <TableCell className="tabular-nums">{formatCount(item.usage.totalTokens, locale, messages)}</TableCell>
    <TableCell>{messages.unpriced}</TableCell>
    <TableCell><Button onClick={event => select(item.id, event.currentTarget)} size="sm" variant="outline">{messages.viewDetail}</Button></TableCell>
  </TableRow>)}</TableBody></Table>
}

function RequestDetail({ item, locale, messages, close }: {
  item: ModelUsageAttempt; locale: WorkspaceLocale; messages: Messages; close(): void
}) {
  const region = useRef<HTMLElement>(null)
  useEffect(() => { region.current?.focus() }, [item.id])
  const facts = [
    [messages.attemptId, item.id], [messages.result, messages.statusLabel(item.status)],
    [messages.dispatchState, messages.dispatchLabel(item.dispatch)],
    [messages.feature, messages.featureLabel(item.feature)], [messages.requestKind, messages.kindLabel(item.kind)],
    [messages.task, item.context.taskId], [messages.stage, item.context.stage],
    [messages.caseId, item.context.caseId ?? messages.notReturned], [messages.encounter, item.context.encounterId ?? messages.notReturned],
    [messages.epoch, item.context.epoch], [messages.trigger, messages.triggerLabel(item.context.trigger)],
    [messages.provider, item.provider], [messages.requestedModel, item.requestedModel],
    [messages.actualModel, item.actualModel ?? messages.notReturned], [messages.reasoning, item.reasoningEffort ?? messages.notReturned],
    [messages.outputLimit, formatCount(item.outputLimit, locale, messages)], [messages.providerRequest, item.providerRequestId ?? messages.notReturned],
    [messages.startedAt, new Date(item.startedAt).toLocaleString(locale)],
    [messages.endedAt, item.endedAt === null ? messages.notReturned : new Date(item.endedAt).toLocaleString(locale)],
    [messages.httpStatus, item.httpStatus ?? messages.notReturned], [messages.mapping, item.usage.mapping],
    [messages.inputTokens, formatCount(item.usage.inputTokens, locale, messages)],
    [messages.outputTokens, formatCount(item.usage.outputTokens, locale, messages)],
    [messages.cachedTokens, formatCount(item.usage.cachedInputTokens, locale, messages)],
    [messages.reasoningTokens, formatCount(item.usage.reasoningOutputTokens, locale, messages)],
    [messages.totalTokens, formatCount(item.usage.totalTokens, locale, messages)], [messages.cost, messages.unpriced],
  ]
  return <section ref={region} tabIndex={-1} aria-label={messages.detail} className="min-w-0 outline-none"><Card>
    <CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><CardTitle>{messages.detail}</CardTitle>
      <Button size="sm" variant="ghost" onClick={close}>{messages.closeDetail}</Button></div>
      <CardDescription>{messages.tokenExplanation}</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-5"><dl className="grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
      {facts.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-muted-foreground">{label}</dt>
        <dd className="break-all">{value}</dd></div>)}
    </dl>
      <div className="flex flex-col gap-2"><h3 className="font-medium">{messages.sources}</h3><p className="text-muted-foreground">{messages.sourceDescription}</p>
        {item.context.sources.length === 0 ? <p>{messages.noSources}</p> : <Table aria-label={messages.sources}>
          <TableHeader><TableRow><TableHead>{messages.trigger}</TableHead><TableHead>{messages.sourceKind}</TableHead><TableHead>ID</TableHead></TableRow></TableHeader>
          <TableBody>{item.context.sources.map((source, index) => <TableRow key={`${source.relationship}:${source.kind}:${source.id}:${index}`}>
            <TableCell>{source.relationship === 'trigger' ? messages.triggerSources : messages.evidenceSources}</TableCell>
            <TableCell>{source.kind}</TableCell><TableCell className="whitespace-normal break-all">{source.id}</TableCell>
          </TableRow>)}</TableBody></Table>}
      </div>
    </CardContent>
  </Card></section>
}

function ReadOnlyPolicy({ data, messages }: { data: ModelUsageOverview; messages: Messages }) {
  return <Card><CardHeader><CardTitle>{messages.policy}</CardTitle><CardDescription>{messages.policyDescription}</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-4"><Badge variant="secondary">{data.policy.enabled ? messages.enabled : ''}</Badge>
      <dl className="grid gap-4 sm:grid-cols-3">{[messages.requestLimit, messages.tokenLimit, messages.costLimit].map(label => <div key={label}>
        <dt className="text-muted-foreground">{label}</dt><dd>{messages.unlimited}</dd></div>)}</dl>
      <p>{messages.reservations}</p><p className="text-muted-foreground">{messages.futurePolicy}</p>
    </CardContent></Card>
}

export function ModelUsageWorkspace({ locale, session }: { locale: WorkspaceLocale; session: SessionContext }) {
  const messages = modelUsageMessages(locale)
  const queryClient = useQueryClient()
  const detailTrigger = useRef<HTMLButtonElement>(null)
  const [tab, setTab] = useState('overview')
  const [filters, setFilters] = useState<ModelUsageFilter>(initialFilters)
  const [selectedId, setSelectedId] = useState<string>()
  const scope = [session.actor.workspaceId, session.actor.epoch, session.actor.actorId, session.actor.practitionerRoleId, session.actor.roleCode]
  const overview = useQuery({ queryKey: ['model-usage', 'overview', ...scope, filters],
    queryFn: ({ signal }) => getModelUsageOverview(filters, signal), retry: false })
  const requestFilters = { ...filters, offset: tab === 'overview' ? 0 : filters.offset, limit: tab === 'overview' ? 5 : filters.limit }
  const requests = useQuery({ queryKey: ['model-usage', 'requests', ...scope, requestFilters],
    queryFn: ({ signal }) => getModelUsageRequests(requestFilters, signal), retry: false,
    enabled: tab === 'overview' || tab === 'requests' })
  const detail = useQuery({ queryKey: ['model-usage', 'detail', ...scope, selectedId],
    queryFn: ({ signal }) => getModelUsageRequest(selectedId!, signal), retry: false, enabled: selectedId !== undefined })
  const requestContent = requests.isPending ? <Loading messages={messages} /> : requests.isError
    ? <ReadError title={messages.loadError} messages={messages} retry={() => { void requests.refetch() }} />
    : <RequestTable items={requests.data.items} locale={locale} messages={messages} select={(id, trigger) => {
      detailTrigger.current = trigger; setSelectedId(id)
    }} />

  return <section aria-label={locale === 'zh-CN' ? '模型用量' : 'Model usage'} className="flex min-w-0 flex-col gap-4">
    <Alert role="note"><AlertTitle>{messages.coverage}</AlertTitle><AlertDescription>{messages.coverageDescription}</AlertDescription></Alert>
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="min-w-0 flex-1 text-sm text-muted-foreground">{messages.aggregateScope} {messages.memberScope}</p>
      <Button size="sm" variant="outline" disabled={overview.isFetching || requests.isFetching || detail.isFetching}
        onClick={() => { void queryClient.invalidateQueries({ queryKey: ['model-usage'] }) }}>{messages.refresh}</Button>
    </div>
    <Tabs value={tab} onValueChange={value => { setTab(String(value)); setSelectedId(undefined) }} className="min-w-0 gap-4">
      <div className="max-w-full overflow-x-auto pb-1"><TabsList aria-label={locale === 'zh-CN' ? '模型用量页签' : 'Model usage tabs'} variant="line">
        {(['overview', 'requests', 'policy', 'pricing'] as const).map(value => <TabsTrigger key={value} value={value}>{messages[value]}</TabsTrigger>)}
      </TabsList></div>
      {(tab === 'overview' || tab === 'requests') ? <details open={tab === 'requests'} className="rounded-lg border bg-card p-3">
        <summary className="cursor-pointer text-sm font-medium">{messages.filters}</summary>
        <UsageFilters key={JSON.stringify(filters)} filters={filters} messages={messages} onApply={value => {
          setFilters(value); setSelectedId(undefined)
        }} />
      </details> : null}
      <TabsContent value="overview" className="flex min-w-0 flex-col gap-4">
        {overview.isPending ? <Loading messages={messages} /> : overview.isError
          ? <ReadError title={messages.loadError} messages={messages} retry={() => { void overview.refetch() }} />
          : <><Summary data={overview.data} locale={locale} messages={messages} /><UsageCharts data={overview.data} locale={locale} messages={messages} /></>}
        <Card className="min-w-0"><CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><CardTitle>{messages.recent}</CardTitle>
          <Button size="sm" variant="ghost" onClick={() => { setTab('requests'); setSelectedId(undefined) }}>{messages.allRequests}</Button></div></CardHeader>
          <CardContent>{requestContent}</CardContent></Card>
      </TabsContent>
      <TabsContent value="requests" className="flex min-w-0 flex-col gap-4"><Card className="min-w-0"><CardHeader><CardTitle>{messages.requests}</CardTitle></CardHeader>
        <CardContent>{requestContent}</CardContent></Card>
        {!requests.isSuccess ? null : <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm">{requests.data.total} {messages.total} · {messages.page} {Math.floor(filters.offset / filters.limit) + 1}</p>
          <div className="flex gap-2"><Button size="sm" variant="outline" disabled={filters.offset === 0 || requests.isFetching}
            onClick={() => { setFilters(current => ({ ...current, offset: Math.max(0, current.offset - current.limit) })); setSelectedId(undefined) }}>{messages.previous}</Button>
          <Button size="sm" variant="outline" disabled={filters.offset + filters.limit >= requests.data.total || requests.isFetching}
            onClick={() => { setFilters(current => ({ ...current, offset: current.offset + current.limit })); setSelectedId(undefined) }}>{messages.next}</Button></div>
        </div>}
      </TabsContent>
      <TabsContent value="policy">{overview.isPending ? <Loading messages={messages} /> : overview.isError
        ? <ReadError title={messages.loadError} messages={messages} retry={() => { void overview.refetch() }} />
        : <ReadOnlyPolicy data={overview.data} messages={messages} />}</TabsContent>
      <TabsContent value="pricing"><Card><CardHeader><CardTitle>{messages.pricing}</CardTitle><CardDescription>{messages.priceDescription}</CardDescription></CardHeader>
        <CardContent><p>{messages.priceDetails}</p></CardContent></Card></TabsContent>
    </Tabs>
    {selectedId === undefined ? null : detail.isPending ? <Loading messages={messages} /> : detail.isError
      ? <ReadError title={messages.detailError} messages={messages} retry={() => { void detail.refetch() }} />
      : <RequestDetail item={detail.data} locale={locale} messages={messages} close={() => {
        detailTrigger.current?.focus(); setSelectedId(undefined)
      }} />}
  </section>
}

function UsageFilters({ filters, messages, onApply }: { filters: ModelUsageFilter; messages: Messages; onApply(value: ModelUsageFilter): void }) {
  const [feature, setFeature] = useState(filters.feature ?? '')
  const [status, setStatus] = useState(filters.status ?? '')
  const [error, setError] = useState(false)
  return <form aria-label={messages.filters} className="flex flex-col gap-3 pt-3" onSubmit={event => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const result = modelUsageFilterSchema.safeParse({ ...Object.fromEntries(
      ['from', 'to', 'provider', 'model', 'caseId'].map(key => [key, String(form.get(key) ?? '').trim() || undefined])),
    feature: feature || undefined, status: status || undefined, offset: 0, limit: filters.limit })
    const validRange = result.success && !(result.data.from && result.data.to && result.data.from > result.data.to)
    setError(!validRange)
    if (result.success && validRange) onApply(result.data)
  }}>
    <FieldGroup className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {(['from', 'to', 'provider', 'model', 'caseId'] as const).map(key => <Field key={key}>
        <FieldLabel htmlFor={`model-usage-${key}`}>{messages[key]}</FieldLabel>
        <Input id={`model-usage-${key}`} name={key} type={key === 'from' || key === 'to' ? 'date' : 'text'}
          defaultValue={filters[key] ?? ''} maxLength={key === 'model' ? 1024 : 256} />
      </Field>)}
      <Field><FieldLabel htmlFor="model-usage-feature">{messages.feature}</FieldLabel>
        <WorkspaceSelect id="model-usage-feature" value={feature} onValueChange={value => setFeature(value ?? '')}
          items={[{ value: '', label: messages.all }, ...modelUsageFeatureSchema.options.map(value => ({ value, label: messages.featureLabel(value) }))]} />
      </Field>
      <Field><FieldLabel htmlFor="model-usage-status">{messages.result}</FieldLabel>
        <WorkspaceSelect id="model-usage-status" value={status} onValueChange={value => setStatus(value ?? '')}
          items={[{ value: '', label: messages.all }, ...modelUsageAttemptSchema.shape.status.options.map(value => ({ value, label: messages.statusLabel(value) }))]} />
      </Field>
    </FieldGroup>
    <div className="flex flex-wrap gap-2"><Button size="sm" type="submit">{messages.apply}</Button>
      <Button size="sm" type="button" variant="outline" onClick={event => {
        event.currentTarget.form?.reset(); setFeature(''); setStatus(''); setError(false); onApply(initialFilters)
      }}>{messages.reset}</Button></div>
    {error ? <p role="alert" className="text-sm text-destructive">{messages.invalidFilters}</p> : null}
  </form>
}
