import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { modelUsageControlUpdateSchema, type ModelUsageControl, type ModelUsageControlUpdate } from '@clinmesh/contracts/model-usage'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@clinmesh/ui/components/card'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { ApiClientError } from './api-client.ts'
import { updateModelUsageControl } from './model-usage-api.ts'
import { modelUsageMessages } from './model-usage-i18n.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

type Messages = ReturnType<typeof modelUsageMessages>

function ScopeSummary({ scope, locale, messages }: {
  scope: ModelUsageControl['workspace']; locale: WorkspaceLocale; messages: Messages
}) {
  const count = (value: number | null) => value === null ? messages.unlimited : new Intl.NumberFormat(locale).format(value)
  const facts = [[messages.requestLimit, count(scope.requests)], [messages.used, count(scope.used)],
    [messages.reserved, count(scope.reserved)], [messages.remaining, count(scope.remaining)],
    [messages.automaticRetries, scope.automaticRetries ? messages.enabled : messages.disabled],
    [messages.requestsStartedAt, scope.requestsStartedAt === null ? messages.noStart
      : new Date(scope.requestsStartedAt).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })],
    [messages.tokenLimit, messages.unlimited], [messages.costLimit, messages.unlimited]]
  return <div className="flex flex-col gap-4"><Badge variant={scope.enabled ? 'secondary' : 'destructive'}>{scope.enabled ? messages.enabled : messages.disabled}</Badge>
    <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{facts.map(([label, value]) => <div key={label} className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt><dd>{value}</dd></div>)}</dl></div>
}

function WorkspaceControlForm({ scope, messages, pending, save }: {
  scope: ModelUsageControl['workspace']; messages: Messages; pending: boolean; save(input: ModelUsageControlUpdate): void
}) {
  const [enabled, setEnabled] = useState(scope.enabled)
  const [automaticRetries, setAutomaticRetries] = useState(scope.automaticRetries)
  const [unlimited, setUnlimited] = useState(scope.requests === null)
  const [requests, setRequests] = useState(scope.requests === null ? '' : String(scope.requests))
  const [invalid, setInvalid] = useState(false)
  return <form noValidate onSubmit={event => {
    event.preventDefault()
    const parsed = modelUsageControlUpdateSchema.safeParse({ expectedVersion: scope.version, enabled, automaticRetries,
      requests: unlimited ? null : requests.trim() === '' ? Number.NaN : Number(requests) })
    setInvalid(!parsed.success)
    if (parsed.success) save(parsed.data)
  }}><FieldGroup>
    <Field orientation="horizontal" data-disabled={pending}><Checkbox id="model-generation-enabled" checked={enabled} disabled={pending} onCheckedChange={setEnabled} />
      <FieldLabel htmlFor="model-generation-enabled">{messages.generationEnabled}</FieldLabel></Field>
    <FieldDescription>{messages.disableDescription}</FieldDescription>
    <Field orientation="horizontal" data-disabled={pending}><Checkbox id="model-requests-unlimited" checked={unlimited} disabled={pending}
      onCheckedChange={value => { setUnlimited(value); setInvalid(false) }} />
      <FieldLabel htmlFor="model-requests-unlimited">{messages.requestsUnlimited}</FieldLabel></Field>
    <Field data-invalid={invalid} data-disabled={pending || unlimited}><FieldLabel htmlFor="model-request-limit">{messages.requestLimit}</FieldLabel>
      <Input id="model-request-limit" type="number" min="0" step="1" inputMode="numeric" aria-invalid={invalid}
        aria-describedby={invalid ? 'model-request-limit-description model-request-limit-error' : 'model-request-limit-description'} disabled={pending || unlimited} value={requests}
        onChange={event => { setRequests(event.target.value); setInvalid(false) }} />
      <FieldDescription id="model-request-limit-description">{messages.requestLimitDescription}</FieldDescription>
      {invalid ? <FieldError id="model-request-limit-error">{messages.invalidLimit}</FieldError> : null}</Field>
    <Field orientation="horizontal" data-disabled={pending}><Checkbox id="model-automatic-retries" checked={automaticRetries} disabled={pending} onCheckedChange={setAutomaticRetries} />
      <FieldLabel htmlFor="model-automatic-retries">{messages.retriesEnabled}</FieldLabel></Field>
    <FieldDescription>{messages.retriesDescription}</FieldDescription>
    <Button type="submit" disabled={pending}>{pending ? messages.savingPolicy : messages.savePolicy}</Button>
  </FieldGroup></form>
}

export function ModelUsagePolicy({ data, locale, administrator, saved }: {
  data: ModelUsageControl; locale: WorkspaceLocale; administrator: boolean; saved(data: ModelUsageControl): void
}) {
  const messages = modelUsageMessages(locale)
  const mutation = useMutation({ mutationFn: updateModelUsageControl, retry: false, onSuccess: saved })
  const saveError = mutation.error instanceof ApiClientError && mutation.error.status === 409 ? messages.policyConflict
    : mutation.error instanceof ApiClientError && mutation.error.status === 403 ? messages.policyDenied : messages.saveError
  const reasons = { MODEL_DISABLED: messages.rejectionDisabled, MODEL_REQUEST_LIMIT: messages.rejectionLimit,
    MODEL_RETRY_DISABLED: messages.rejectionRetry, MODEL_LEDGER_UNAVAILABLE: messages.rejectionLedger }
  return <div className="flex min-w-0 flex-col gap-4">
    <Card role="region" aria-label={messages.workspaceControl}><CardHeader><CardTitle>{messages.workspaceControl}</CardTitle>
      <CardDescription>{messages.policyDescription}</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">
      <ScopeSummary scope={data.workspace} locale={locale} messages={messages} />
      {administrator ? <WorkspaceControlForm key={data.workspace.version} scope={data.workspace} messages={messages}
        pending={mutation.isPending} save={input => mutation.mutate(input)} /> : <p>{messages.readOnlyControl}</p>}
      {mutation.isError ? <Alert variant="destructive"><AlertDescription>{saveError}</AlertDescription></Alert> : null}
      {mutation.isSuccess ? <p role="status">{messages.savedPolicy}</p> : null}
      <p className="text-muted-foreground">{messages.futurePolicy}</p>
    </CardContent></Card>
    {data.deployment === null ? null : <Card role="region" aria-label={messages.deploymentControl}><CardHeader><CardTitle>{messages.deploymentControl}</CardTitle></CardHeader><CardContent>
      <ScopeSummary scope={data.deployment} locale={locale} messages={messages} />
    </CardContent></Card>}
    <Card role="region" aria-label={messages.recovery}><CardHeader><CardTitle>{messages.recovery}</CardTitle>
      <CardDescription>{messages.recoveryDescription}</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">
      <dl className="grid gap-4 sm:grid-cols-2"><div><dt>{messages.waiting}</dt><dd>{data.waiting}</dd></div>
        <div><dt>{messages.inFlight}</dt><dd>{data.inFlight}</dd></div></dl>
      <p>{messages.effectiveControl}: {data.effective.enabled ? messages.enabled : messages.disabled} · {messages.automaticRetries}: {data.effective.automaticRetries ? messages.enabled : messages.disabled}</p>
      <div><p>{messages.lastRejection}</p>{data.lastRejection === null ? <p>{messages.noRejection}</p> : <>
        <p>{data.lastRejection.scope === 'workspace' ? messages.workspaceScope : messages.deploymentScope}{locale === 'zh-CN' ? '' : ': '}{reasons[data.lastRejection.code]}</p>
        <time dateTime={data.lastRejection.at}>{new Date(data.lastRejection.at).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })}</time></>}
      </div>
    </CardContent></Card>
  </div>
}
