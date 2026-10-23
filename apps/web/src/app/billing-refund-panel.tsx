import { useState } from 'react'
import type { z } from 'zod'
import type { billingCaseSchema, paymentSimulatorRuleSchema, SessionContext } from '@clinmesh/contracts/his'
import { refundPreviewResponseSchema } from '@clinmesh/contracts/refunds'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@clinmesh/ui/components/alert-dialog'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { getRefundCase } from './api-client.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { formatFen } from './workspace-format.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'

type FrozenRefund = { preview: z.infer<typeof refundPreviewResponseSchema>['data']; chargeVersion: number }
type Correction = { chargeItemId: string; chargeVersion: number; amountFen: number; reason: string }
function inputFen(value: string) {
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value.trim())) throw new Error('请输入正数金额，最多两位小数 / Enter a positive amount with at most two decimals')
  const [yuan = '0', fraction = ''] = value.trim().split('.')
  const amount = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000_000) throw new Error('金额超出范围 / Amount outside supported range')
  return amount
}

export function BillingRefundPanel({ bill, session, locale, onChanged, disabled }: {
  bill: z.infer<typeof billingCaseSchema>; session: SessionContext; locale: WorkspaceLocale; onChanged: () => Promise<unknown>; disabled: boolean
}) {
  const text = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const messages = getWorkspaceMessages(locale)
  const queryClient = useQueryClient()
  const scope = [session.actor.workspaceId, session.actor.epoch, session.actor.actorId] as const
  const queryKey = ['billing-refunds', ...scope, bill.caseId] as const
  const ledger = useQuery({ queryKey, queryFn: ({ signal }) => getRefundCase(bill.caseId, signal) })
  const [chargeId, setChargeId] = useState<string>()
  const charges = bill.charges.filter(charge => charge.category !== 'registration')
  const charge = charges.find(item => item.chargeItemId === chargeId) ?? charges[0]
  const [correctionAmount, setCorrectionAmount] = useState('')
  const [reason, setReason] = useState('')
  const [correction, setCorrection] = useState<Correction>()
  const [paymentId, setPaymentId] = useState<string>()
  const source = ledger.data?.sources.find(item => item.sourceId === paymentId) ?? ledger.data?.sources[0]
  const [refundAmount, setRefundAmount] = useState('')
  const [rule, setRule] = useState<z.infer<typeof paymentSimulatorRuleSchema>>('success')
  const [frozen, setFrozen] = useState<FrozenRefund>()
  const [recoverId, setRecoverId] = useState<string>()
  const [inputError, setInputError] = useState<string>()
  const refresh = async () => { await Promise.all([queryClient.invalidateQueries({ queryKey }), onChanged()]) }
  const write = useInpatientWriteIntent(session, async (command, response) => {
    if (command.operation === 'billing.charge.adjust') { setCorrection(undefined); setCorrectionAmount(''); setReason(''); setFrozen(undefined) }
    if (command.operation === 'refund.preview' && command.caseId === bill.caseId) setFrozen({ preview: refundPreviewResponseSchema.parse(response).data, chargeVersion: command.input.chargeVersion })
    if (command.operation === 'refund.confirm') { setFrozen(undefined); setRefundAmount('') }
    if (command.operation === 'refund.recover') setRecoverId(undefined)
    await refresh()
  })
  const preview = () => {
    try {
      const originalCharge = bill.charges.find(item => item.chargeItemId === source?.chargeItemId)
      if (source === undefined || originalCharge === undefined) throw new Error(messages.paymentUnavailable)
      setInputError(undefined)
      write.mutation.mutate({ operation: 'refund.preview', caseId: bill.caseId, input: { paymentId: source.sourceId,
        amountFen: inputFen(refundAmount), expectedSourceVersion: source.version, simulatorRule: rule,
        chargeItemId: source.chargeItemId, chargeVersion: originalCharge.chargeVersion } })
    } catch (failure) { setInputError(failure instanceof Error ? failure.message : messages.operationFailed) }
  }
  const recover = (refundId: string) => {
    const attempt = ledger.data?.refunds.find(item => item.refundId === refundId)
    const original = ledger.data?.sources.find(item => item.sourceId === attempt?.sourceId)
    const originalCharge = bill.charges.find(item => item.chargeItemId === original?.chargeItemId)
    if (attempt === undefined || originalCharge === undefined) { setInputError(messages.paymentUnavailable); return }
    write.mutation.mutate({ operation: 'refund.recover', caseId: bill.caseId, input: { refundId, expectedRefundVersion: attempt.version,
      chargeItemId: originalCharge.chargeItemId, chargeVersion: originalCharge.chargeVersion } })
  }
  const busy = write.blocked || disabled
  const requestPending = write.mutation.isPending
  const error = write.storageFailure ?? [ledger, write.mutation].find(item => item.isError)?.error
  const pendingCommand = write.pending?.command
  const ownPending = pendingCommand?.operation === 'billing.charge.adjust' ? pendingCommand.input.caseId === bill.caseId
    : (pendingCommand?.operation === 'refund.preview' || pendingCommand?.operation === 'refund.confirm' || pendingCommand?.operation === 'refund.recover') && pendingCommand.caseId === bill.caseId
  const feedback = <>
    {write.pending === null ? null : <Alert><AlertTitle>{text('原操作结果待确认', 'Original operation awaiting confirmation')}</AlertTitle><AlertDescription>
      {ownPending ? text('已保留原操作、幂等键及完整输入。恢复时先查询原回执，再按原意图恢复。', 'The original command, key and input are saved. Recovery checks its receipt first.') : text('当前岗位有其他待确认操作，请返回原患者或操作入口恢复。', 'Return to the original patient or operation to resolve the pending command.')}
    </AlertDescription></Alert>}
    {ownPending ? <Button disabled={write.mutation.isPending} variant="outline" onClick={() => write.mutation.mutate(undefined)}>{text('恢复原费用更正或退款', 'Recover original correction or refund')}</Button> : null}
    {error === undefined && inputError === undefined ? null : <Alert variant="destructive"><AlertTitle>{messages.operationFailed}</AlertTitle><AlertDescription>{inputError ?? (error === undefined ? '' : getWorkspaceErrorMessage(error, messages))}</AlertDescription></Alert>}
  </>
  const outcome = (value: string) => value === 'success' ? text('退款成功', 'Refund succeeded') : value === 'declined' ? text('退款被拒绝', 'Refund declined') : text('退款结果未知', 'Refund result unknown')
  const recovery = ledger.data?.refunds.find(item => item.refundId === recoverId)
  return <section aria-label={text('费用更正与退款', 'Fee corrections and refunds')} className="flex min-w-0 flex-col gap-4 rounded-md border p-3">
    <h3 className="text-base font-semibold">{text('费用更正与退款', 'Fee corrections and refunds')}</h3>
    <p className="text-sm text-muted-foreground">{text('费用冲减与资金退款分别记录，保留原费用、原交易及临床执行事实。', 'Fee corrections and money refunds preserve the original charges, payments and clinical execution.')}</p>
    {ledger.isPending ? <Skeleton className="h-16 w-full" /> : null}
    {ledger.data === undefined ? null : <>
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        <div><dt>{text('累计冲减', 'Fee reductions')}</dt><dd>{formatFen(ledger.data.adjustedFen, locale)}</dd></div>
        <div><dt>{text('累计已退', 'Refunded')}</dt><dd>{formatFen(ledger.data.refundedFen, locale)}</dd></div>
        <div><dt>{text('未知退款预占', 'Reserved refunds')}</dt><dd>{formatFen(ledger.data.reservedFen, locale)}</dd></div>
      </dl>
      {ledger.data.adjustments.map(item => <p className="break-all text-sm" key={item.adjustmentId}>{formatFen(item.amountFen, locale)} · {item.reason} · {item.adjustmentId}</p>)}
      <FieldGroup>
        <Field><FieldLabel htmlFor="correction-charge">{text('原费用项目', 'Original charge')}</FieldLabel><WorkspaceSelect id="correction-charge" disabled={busy} value={charge?.chargeItemId ?? null} items={charges.map(item => ({ value: item.chargeItemId, label: locale === 'zh-CN' ? item.descriptionZh : item.descriptionEn }))} onValueChange={value => setChargeId(value ?? undefined)} /></Field>
        <Field><FieldLabel htmlFor="correction-amount">{text('费用冲减金额（元）', 'Fee reduction (CNY)')}</FieldLabel><Input id="correction-amount" inputMode="decimal" value={correctionAmount} disabled={busy} onChange={event => setCorrectionAmount(event.target.value)} /></Field>
        <Field><FieldLabel htmlFor="correction-reason">{text('费用更正原因', 'Reason for correction')}</FieldLabel><Input id="correction-reason" value={reason} maxLength={1000} disabled={busy} onChange={event => setReason(event.target.value)} /></Field>
      </FieldGroup>
      <Button disabled={busy || charge === undefined || reason.trim().length < 5 || correctionAmount === ''} variant="outline" onClick={() => {
        try { if (charge !== undefined) { write.mutation.reset(); setCorrection({ chargeItemId: charge.chargeItemId, chargeVersion: charge.chargeVersion, amountFen: inputFen(correctionAmount), reason: reason.trim() }); setInputError(undefined) } }
        catch (failure) { setInputError(failure instanceof Error ? failure.message : messages.operationFailed) }
      }}>{text('记录费用更正', 'Record fee correction')}</Button>
      {ledger.data.sources.length === 0 ? <p className="text-sm">{text('尚无可关联的成功原交易。', 'No successful original payment is available.')}</p> : <>
        <FieldGroup>
          <Field><FieldLabel htmlFor="refund-source">{text('退款关联原交易', 'Original payment')}</FieldLabel><WorkspaceSelect id="refund-source" disabled={busy} value={source?.sourceId ?? null} items={ledger.data.sources.map(item => ({ value: item.sourceId, label: `${item.sourceId} · ${text('可退', 'Refundable')} ${formatFen(item.refundableFen, locale)}` }))} onValueChange={value => { setPaymentId(value ?? undefined); setFrozen(undefined) }} /></Field>
          <Field><FieldLabel htmlFor="refund-amount">{text('本次退款金额（元）', 'Refund amount (CNY)')}</FieldLabel><Input id="refund-amount" inputMode="decimal" disabled={busy} value={refundAmount} onChange={event => { setRefundAmount(event.target.value); setFrozen(undefined) }} /></Field>
          <Field><FieldLabel htmlFor="refund-rule">{text('退款处理结果', 'Refund channel result')}</FieldLabel><WorkspaceSelect id="refund-rule" disabled={busy} value={rule} onValueChange={value => { setRule(value ?? 'success'); setFrozen(undefined) }} items={[
            { value: 'success', label: messages.simulatorSuccess }, { value: 'decline', label: messages.simulatorDecline },
            { value: 'ambiguous', label: messages.simulatorAmbiguous }, { value: 'ambiguous-decline', label: messages.simulatorAmbiguousDecline },
            { value: 'ambiguous-pending', label: messages.simulatorAmbiguousPending },
          ]} /></Field>
        </FieldGroup>
        <Button disabled={busy || source === undefined || source.refundableFen === 0 || refundAmount === ''} onClick={preview}>{text('预览退款', 'Preview refund')}</Button>
      </>}
      {ledger.data.refunds.map(item => <div className="flex min-w-0 flex-col gap-2 rounded-md border p-3" key={item.refundId}>
        <Badge variant={item.outcome === 'success' ? 'secondary' : 'outline'}>{outcome(item.outcome)}</Badge>
        <p className="break-all text-sm">{formatFen(item.amountFen, locale)} · {item.refundId}</p><p className="break-all text-xs text-muted-foreground">{text('原交易', 'Original payment')}: {item.sourceId} · {item.correlationId}</p>
        {item.tenders === undefined ? null : <p className="text-sm">{item.tenders.map(tender => `${tender.method === 'cash' ? messages.tenderCash : tender.method === 'bank-card' ? messages.tenderCard : messages.tenderMobile} ${formatFen(tender.amountFen, locale)}`).join(' + ')}</p>}
        {item.outcome === 'ambiguous' ? <Button disabled={busy} variant="outline" onClick={() => setRecoverId(item.refundId)}>{text('查询原退款结果', 'Query original refund')}</Button> : null}
      </div>)}
    </>}
    {feedback}
    <AlertDialog open={correction !== undefined} onOpenChange={open => { if (!open && !requestPending) setCorrection(undefined) }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{text('确认费用更正', 'Confirm fee correction')}</AlertDialogTitle><AlertDialogDescription>{text('核对冲减金额及原因。本次操作不退款、不撤销临床执行。', 'Review the reduction and reason. Money and clinical execution are separate.')}</AlertDialogDescription></AlertDialogHeader>
        <p>{formatFen(correction?.amountFen ?? 0, locale)} · {correction?.reason}</p>{feedback}<AlertDialogFooter><AlertDialogCancel disabled={requestPending}>{messages.cancel}</AlertDialogCancel><Button disabled={busy} onClick={() => { if (correction !== undefined) write.mutation.mutate({ operation: 'billing.charge.adjust', input: { ...correction, caseId: bill.caseId } }) }}>{text('确认费用更正', 'Confirm fee correction')}</Button></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={frozen !== undefined} onOpenChange={open => { if (!open && !requestPending) setFrozen(undefined) }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{text('确认退款', 'Confirm refund')}</AlertDialogTitle><AlertDialogDescription>{text('按本次冻结预览退款。未知结果需查询原尝试。', 'Submit the frozen refund. Query the original attempt if its result is unknown.')}</AlertDialogDescription></AlertDialogHeader>
        <p className="break-all">{frozen?.preview.sourceId} · {formatFen(frozen?.preview.amountFen ?? 0, locale)}</p>{feedback}<AlertDialogFooter><AlertDialogCancel disabled={requestPending}>{messages.cancel}</AlertDialogCancel><Button disabled={busy} onClick={() => { if (frozen !== undefined) write.mutation.mutate({ operation: 'refund.confirm', caseId: bill.caseId, input: { previewId: frozen.preview.previewId, commitToken: frozen.preview.commitToken, chargeItemId: frozen.preview.chargeItemId, chargeVersion: frozen.chargeVersion } }) }}>{text('提交退款', 'Submit refund')}</Button></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={recoverId !== undefined} onOpenChange={open => { if (!open && !requestPending) setRecoverId(undefined) }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{text('查询原退款结果', 'Query original refund')}</AlertDialogTitle><AlertDialogDescription>{text('只查询已记录的退款，不另发退款。', 'Query this recorded refund without sending another refund.')}</AlertDialogDescription></AlertDialogHeader>
        <p className="break-all">{recovery?.refundId} · {formatFen(recovery?.amountFen ?? 0, locale)}</p>{feedback}<AlertDialogFooter><AlertDialogCancel disabled={requestPending}>{messages.cancel}</AlertDialogCancel><Button disabled={busy} onClick={() => { if (recoverId !== undefined) recover(recoverId) }}>{text('查询原退款结果', 'Query original refund')}</Button></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </section>
}
