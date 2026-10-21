import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { modelUsageReconcileSchema, modelUsageRepriceSchema, type ModelUsageAttempt } from '@clinmesh/contracts/model-usage'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { ApiClientError } from './api-client.ts'
import { reconcileModelUsage, repriceModelUsage } from './model-usage-api.ts'
import { modelUsageMessages } from './model-usage-i18n.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

function CorrectionDialog({ item, mode, locale, saved }: {
  item: ModelUsageAttempt; mode: 'reconcile' | 'reprice'; locale: WorkspaceLocale; saved(item: ModelUsageAttempt): void
}) {
  const messages = modelUsageMessages(locale)
  const [open, setOpen] = useState(false)
  const [evidence, setEvidence] = useState('')
  const [tokens, setTokens] = useState('')
  const [cny, setCny] = useState('')
  const [invalid, setInvalid] = useState(false)
  const unknownTokens = (item.accounting?.totalTokens ?? item.usage.totalTokens) === null
  const unknownCny = (item.accounting?.cny ?? item.effectiveCost?.cny ?? item.cost.cny) === null
  const mutation = useMutation({ retry: false,
    mutationFn: (input: { expectedRevision: number; evidence: string; totalTokens?: number; cny?: number }) =>
      mode === 'reconcile' ? reconcileModelUsage(item.id, input) : repriceModelUsage(item.id, input),
    onSuccess: result => { saved(result); setOpen(false) },
  })
  const title = mode === 'reconcile' ? messages.reconcile : messages.reprice
  const error = mutation.error instanceof ApiClientError && mutation.error.status === 409 ? messages.correctionConflict
    : mutation.error instanceof ApiClientError && mutation.error.status === 403 ? messages.correctionDenied : messages.correctionError
  return <Dialog open={open} onOpenChange={value => {
    if (mutation.isPending) return
    setOpen(value)
    if (value) { setEvidence(''); setTokens(''); setCny(''); setInvalid(false); mutation.reset() }
  }}><DialogTrigger render={<Button variant="outline" size="sm" />}>{title}</DialogTrigger>
    <DialogContent><DialogHeader><DialogTitle>{title}</DialogTitle>
      <DialogDescription>{mode === 'reconcile' ? messages.reconcileDescription : messages.repriceDescription}</DialogDescription></DialogHeader>
      <form className="flex min-h-0 flex-col" noValidate onSubmit={event => {
        event.preventDefault()
        const input = { expectedRevision: item.corrections.length, evidence: evidence.trim(),
          ...(mode === 'reconcile' && unknownTokens && tokens.trim() !== '' ? { totalTokens: Number(tokens) } : {}),
          ...(mode === 'reconcile' && unknownCny && cny.trim() !== '' ? { cny: Number(cny) } : {}) }
        const parsed = mode === 'reconcile' ? modelUsageReconcileSchema.safeParse(input) : modelUsageRepriceSchema.safeParse(input)
        setInvalid(!parsed.success)
        if (parsed.success) mutation.mutate(parsed.data)
      }}>
        <FieldGroup className="min-h-0 overflow-y-auto p-4">
          <Field data-invalid={invalid} data-disabled={mutation.isPending}><FieldLabel htmlFor={`usage-${mode}-evidence`}>{messages.evidence}</FieldLabel>
            <Input id={`usage-${mode}-evidence`} value={evidence} maxLength={256} disabled={mutation.isPending} aria-invalid={invalid}
              aria-describedby={invalid ? `usage-${mode}-error` : undefined} onChange={event => { setEvidence(event.target.value); setInvalid(false) }} />
            <FieldDescription>{messages.revision} {item.corrections.length}</FieldDescription></Field>
          {mode === 'reconcile' && unknownTokens ? <Field data-invalid={invalid} data-disabled={mutation.isPending}>
            <FieldLabel htmlFor="usage-reconcile-tokens">{messages.totalTokens}</FieldLabel>
            <Input id="usage-reconcile-tokens" type="number" inputMode="numeric" min="0" step="1" value={tokens} disabled={mutation.isPending}
              aria-invalid={invalid} onChange={event => { setTokens(event.target.value); setInvalid(false) }} /></Field> : null}
          {mode === 'reconcile' && unknownCny ? <Field data-invalid={invalid} data-disabled={mutation.isPending}>
            <FieldLabel htmlFor="usage-reconcile-cny">{messages.cost}</FieldLabel>
            <Input id="usage-reconcile-cny" type="number" inputMode="decimal" min="0" step="0.000001" value={cny} disabled={mutation.isPending}
              aria-invalid={invalid} onChange={event => { setCny(event.target.value); setInvalid(false) }} /></Field> : null}
          {invalid ? <FieldError id={`usage-${mode}-error`}>{messages.correctionInvalid}</FieldError> : null}
          {mutation.isError ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        </FieldGroup>
        <DialogFooter><Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => setOpen(false)}>{messages.cancel}</Button>
          <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? messages.savingPolicy
            : mode === 'reconcile' ? messages.confirmReconcile : messages.confirmReprice}</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
}

export function ModelUsageCorrections({ item, locale, administrator, saved }: {
  item: ModelUsageAttempt; locale: WorkspaceLocale; administrator: boolean; saved(item: ModelUsageAttempt): void
}) {
  const messages = modelUsageMessages(locale)
  const format = (value: number | null) => value === null ? messages.unknown : new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value)
  const effective = item.effectiveCost ?? item.cost
  const totalTokens = item.accounting?.totalTokens ?? item.usage.totalTokens
  const cny = item.accounting?.cny ?? effective.cny
  const canCorrect = administrator && item.status !== 'in-flight' && item.dispatch !== 'not-dispatched'
  const canReprice = cny === null && (item.cost.status === 'price-not-configured' || item.cost.status === 'exchange-rate-not-configured')
  return <div className="flex min-w-0 flex-col gap-3">
    <h3 className="font-medium">{messages.priceAtCall}</h3>
    <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {[[messages.result, messages.costStatusLabel(item.cost.status)], [messages.currency, item.cost.currency ?? messages.unknown],
        [messages.originalAmount, format(item.cost.original)], [messages.cost, format(item.cost.cny)],
        [messages.priceVersion, item.priceSnapshot?.price?.version ?? messages.notReturned],
        [messages.exchangeVersion, item.priceSnapshot?.exchangeRate?.version ?? messages.notReturned]].map(([label, value]) =>
        <div key={label}><dt className="text-muted-foreground">{label}</dt><dd>{value}</dd></div>)}
    </dl>
    <h3 className="font-medium">{messages.effectiveAccounting}</h3>
    <p>{messages.totalTokens}: {format(totalTokens)} · {messages.cost}: {format(cny)}</p>
    {item.reservationBoundary === null ? null : <div><h3 className="font-medium">{messages.reservationBoundary}</h3>
      <p>{item.reservationBoundary.adapter} · {item.reservationBoundary.version}</p>
      <p>{messages.inputBoundary}: {format(item.reservationBoundary.inputTokens)} · {messages.outputBoundary}: {format(item.reservationBoundary.outputTokens)}</p></div>}
    {canCorrect ? <div className="flex flex-wrap gap-2">
      {totalTokens === null || cny === null ? <CorrectionDialog item={item} mode="reconcile" locale={locale} saved={saved} /> : null}
      {canReprice ? <CorrectionDialog item={item} mode="reprice" locale={locale} saved={saved} /> : null}
    </div> : null}
    <h3 className="font-medium">{messages.corrections}</h3>
    {item.corrections.length === 0 ? <p>{messages.noCorrections}</p> : <ol className="flex min-w-0 flex-col gap-3">{item.corrections.map(correction =>
      <li key={correction.revision} className="min-w-0"><p>{messages.revision} {correction.revision} · {correction.kind === 'reconcile' ? messages.reconcile : messages.reprice}</p>
        <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {[[messages.evidence, correction.evidence], [messages.operator, correction.actorId], [messages.date, new Date(correction.at).toLocaleString(locale)],
            [messages.totalTokens, format(correction.totalTokens)], [messages.cost, format(correction.cny)],
            [messages.currency, correction.cost?.currency ?? messages.notReturned], [messages.originalAmount, format(correction.cost?.original ?? null)],
            [messages.priceVersion, correction.priceSnapshot?.price?.version ?? messages.notReturned],
            [messages.exchangeVersion, correction.priceSnapshot?.exchangeRate?.version ?? messages.notReturned]].map(([label, value]) =>
            <div key={label} className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="break-all">{value}</dd></div>)}
        </dl></li>)}</ol>}
  </div>
}
