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
  const count = (value: number | null) => value === null ? messages.unlimited : new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value)
  const reservation = (known: number, unknown: number) => unknown === 0 ? count(known) : `${count(known)} + ${unknown} ${messages.unknownReservations}`
  const remaining = (value: number | null, limit: number | null) => value === null && limit !== null ? messages.unknown : count(value)
  const facts = [[messages.requestLimit, count(scope.requests)], [messages.used, count(scope.used)],
    [messages.reserved, count(scope.reserved)], [messages.remaining, count(scope.remaining)],
    [messages.automaticRetries, scope.automaticRetries ? messages.enabled : messages.disabled],
    [messages.requestsStartedAt, scope.requestsStartedAt === null ? messages.noStart
      : new Date(scope.requestsStartedAt).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })],
    [messages.tokenLimit, count(scope.tokens)], [messages.tokensUsed, count(scope.tokensUsed)],
    [messages.tokensReserved, reservation(scope.tokensReserved, scope.tokensUnknownReservations)], [messages.tokensRemaining, remaining(scope.tokensRemaining, scope.tokens)],
    [messages.tokensStartedAt, scope.tokensStartedAt === null ? messages.noStart : new Date(scope.tokensStartedAt).toLocaleString(locale)],
    [messages.costLimit, count(scope.cny)], [messages.cnyUsed, count(scope.cnyUsed)],
    [messages.cnyReserved, reservation(scope.cnyReserved, scope.cnyUnknownReservations)], [messages.cnyRemaining, remaining(scope.cnyRemaining, scope.cny)],
    [messages.cnyStartedAt, scope.cnyStartedAt === null ? messages.noStart : new Date(scope.cnyStartedAt).toLocaleString(locale)]]
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
  const [tokensUnlimited, setTokensUnlimited] = useState(scope.tokens === null)
  const [cnyUnlimited, setCnyUnlimited] = useState(scope.cny === null)
  const [tokens, setTokens] = useState(scope.tokens === null ? '' : String(scope.tokens))
  const [cny, setCny] = useState(scope.cny === null ? '' : String(scope.cny))
  const [invalidDimension, setInvalidDimension] = useState<'tokens' | 'cny'>()
  return <form noValidate onSubmit={event => {
    event.preventDefault()
    const parsed = modelUsageControlUpdateSchema.safeParse({ expectedVersion: scope.version, enabled, automaticRetries,
      requests: unlimited ? null : requests.trim() === '' ? Number.NaN : Number(requests),
      tokens: tokensUnlimited ? null : tokens.trim() === '' ? Number.NaN : Number(tokens),
      cny: cnyUnlimited ? null : cny.trim() === '' ? Number.NaN : Number(cny) })
    setInvalid(!parsed.success && parsed.error.issues.some(issue => issue.path[0] === 'requests'))
    setInvalidDimension(!parsed.success && parsed.error.issues.some(issue => issue.path[0] === 'tokens') ? 'tokens'
      : !parsed.success && parsed.error.issues.some(issue => issue.path[0] === 'cny') ? 'cny' : undefined)
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
    {([{ dimension: 'tokens', unlimited: tokensUnlimited, setUnlimited: setTokensUnlimited, value: tokens, setValue: setTokens,
      label: messages.tokenLimit, unlimitedLabel: messages.tokensUnlimited, error: messages.invalidTokens },
    { dimension: 'cny', unlimited: cnyUnlimited, setUnlimited: setCnyUnlimited, value: cny, setValue: setCny,
      label: messages.costLimit, unlimitedLabel: messages.cnyUnlimited, error: messages.invalidCny }] as const).map(limit =>
      <FieldGroup key={limit.dimension}>
        <Field orientation="horizontal" data-disabled={pending}><Checkbox id={`model-${limit.dimension}-unlimited`}
          checked={limit.unlimited} disabled={pending} onCheckedChange={value => { limit.setUnlimited(value); setInvalidDimension(undefined) }} />
          <FieldLabel htmlFor={`model-${limit.dimension}-unlimited`}>{limit.unlimitedLabel}</FieldLabel></Field>
        <Field data-invalid={invalidDimension === limit.dimension} data-disabled={pending || limit.unlimited}>
          <FieldLabel htmlFor={`model-${limit.dimension}-limit`}>{limit.label}</FieldLabel>
          <Input id={`model-${limit.dimension}-limit`} type="number" min="0" step={limit.dimension === 'tokens' ? '1' : '0.000001'}
            inputMode={limit.dimension === 'tokens' ? 'numeric' : 'decimal'} disabled={pending || limit.unlimited}
            aria-invalid={invalidDimension === limit.dimension} aria-describedby={invalidDimension === limit.dimension ? `model-${limit.dimension}-error` : undefined}
            value={limit.value} onChange={event => { limit.setValue(event.target.value); setInvalidDimension(undefined) }} />
          {invalidDimension === limit.dimension ? <FieldError id={`model-${limit.dimension}-error`}>{limit.error}</FieldError> : null}
        </Field>
      </FieldGroup>)}
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
    MODEL_RETRY_DISABLED: messages.rejectionRetry, MODEL_LEDGER_UNAVAILABLE: messages.rejectionLedger,
    MODEL_TOKEN_LIMIT: messages.rejectionTokens, MODEL_CNY_LIMIT: messages.rejectionCny, MODEL_METERING_UNAVAILABLE: messages.rejectionMetering }
  return <div className="flex min-w-0 flex-col gap-4">
    <Card role="region" aria-label={messages.workspaceControl}><CardHeader><CardTitle>{messages.workspaceControl}</CardTitle>
      <CardDescription>{messages.policyDescription}</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">
      <ScopeSummary scope={data.workspace} locale={locale} messages={messages} />
      {administrator ? <WorkspaceControlForm key={data.workspace.version} scope={data.workspace} messages={messages}
        pending={mutation.isPending} save={input => mutation.mutate(input)} /> : <p>{messages.readOnlyControl}</p>}
      {mutation.isError ? <Alert variant="destructive"><AlertDescription>{saveError}</AlertDescription></Alert> : null}
      {mutation.isSuccess ? <p role="status">{messages.savedPolicy}</p> : null}
      <p className="text-muted-foreground">{messages.meteringNotice}</p>
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
        {data.lastRejection.dimension === null ? null : <p>{data.lastRejection.dimension} · {messages.remaining}: {data.lastRejection.remaining ?? messages.unknown}
          {' · '}{messages.required}: {data.lastRejection.required ?? messages.unknown}</p>}
        <time dateTime={data.lastRejection.at}>{new Date(data.lastRejection.at).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })}</time></>}
      </div>
    </CardContent></Card>
  </div>
}
