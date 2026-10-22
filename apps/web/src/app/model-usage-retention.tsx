import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { modelUsageRetentionUpdateSchema, type ModelUsageRetention } from '@clinmesh/contracts/model-usage'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@clinmesh/ui/components/card'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { ApiClientError } from './api-client.ts'
import { updateModelUsageRetention } from './model-usage-api.ts'
import { modelUsageMessages } from './model-usage-i18n.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

type Messages = ReturnType<typeof modelUsageMessages>

export function retentionPeriod(data: ModelUsageRetention, messages: Messages) {
  return data.days === null ? messages.retentionPermanent : `${data.days} ${messages.retentionDayUnit}`
}

function RetentionForm({ data, messages, pending, save }: {
  data: ModelUsageRetention; messages: Messages; pending: boolean; save(days: number | null): void
}) {
  const [permanent, setPermanent] = useState(data.days === null)
  const [days, setDays] = useState(data.days === null ? '' : String(data.days))
  const [invalid, setInvalid] = useState(false)
  return <form noValidate onSubmit={event => {
    event.preventDefault()
    const parsed = modelUsageRetentionUpdateSchema.safeParse({ days: permanent ? null : days.trim() === '' ? Number.NaN : Number(days),
      expectedVersion: data.version })
    setInvalid(!parsed.success)
    if (parsed.success) save(parsed.data.days)
  }}><FieldGroup>
    <Field orientation="horizontal" data-disabled={pending}>
      <Checkbox id="model-retention-permanent" checked={permanent} disabled={pending}
        onCheckedChange={value => { setPermanent(value); setInvalid(false) }} />
      <FieldLabel htmlFor="model-retention-permanent">{messages.retentionPermanent}</FieldLabel>
    </Field>
    <Field data-invalid={invalid} data-disabled={pending || permanent}>
      <FieldLabel htmlFor="model-retention-days">{messages.retentionDays}</FieldLabel>
      <Input id="model-retention-days" type="number" min="1" step="1" inputMode="numeric" value={days}
        disabled={pending || permanent} aria-invalid={invalid}
        aria-describedby={invalid ? 'model-retention-description model-retention-error' : 'model-retention-description'}
        onChange={event => { setDays(event.target.value); setInvalid(false) }} />
      <FieldDescription id="model-retention-description">{messages.retentionDaysDescription}</FieldDescription>
      {invalid ? <FieldError id="model-retention-error">{messages.retentionInvalid}</FieldError> : null}
    </Field>
    <Button type="submit" disabled={pending}>{pending ? messages.savingPolicy : messages.saveRetention}</Button>
  </FieldGroup></form>
}

export function ModelUsageRetention({ data, locale, administrator, saved }: {
  data: ModelUsageRetention; locale: WorkspaceLocale; administrator: boolean; saved(data: ModelUsageRetention): void
}) {
  const messages = modelUsageMessages(locale)
  const mutation = useMutation({ mutationFn: updateModelUsageRetention, retry: false, onSuccess: saved })
  const error = mutation.error instanceof ApiClientError && mutation.error.status === 409 ? messages.retentionConflict
    : mutation.error instanceof ApiClientError && mutation.error.status === 403 ? messages.retentionDenied : messages.retentionSaveError
  return <Card role="region" aria-label={messages.retention}><CardHeader><CardTitle>{messages.retention}</CardTitle>
    <CardDescription>{messages.retentionDescription}</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">
    <dl className="grid gap-3 sm:grid-cols-3">
      <div><dt className="text-muted-foreground">{messages.currentRetention}</dt><dd>{retentionPeriod(data, messages)}</dd></div>
      <div><dt className="text-muted-foreground">{messages.compactedRequests}</dt><dd>{new Intl.NumberFormat(locale).format(data.compactedRequests)}</dd></div>
      <div><dt className="text-muted-foreground">{messages.lastCompactedAt}</dt><dd>{data.lastCompactedAt === null ? messages.neverCompacted
        : new Date(data.lastCompactedAt).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })}</dd></div>
    </dl>
    {administrator ? <RetentionForm key={data.version} data={data} messages={messages} pending={mutation.isPending}
      save={days => mutation.mutate({ days, expectedVersion: data.version })} /> : <p>{messages.readOnlyRetention}</p>}
    {mutation.isError ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {mutation.isSuccess ? <p role="status">{messages.savedRetention}</p> : null}
  </CardContent></Card>
}
