import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { inpatientFinancialSchema, inpatientFinancialAdjustmentInputSchema, inpatientFinancialRefundPreviewResponseSchema } from '@clinmesh/contracts/inpatient-finance'
import { inpatientPaymentPreviewResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { paymentSimulatorRuleSchema, type SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogCancel } from '@clinmesh/ui/components/alert-dialog'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { apiGet } from './api-client.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen, yuanToFen } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { InpatientFinancialInsurance } from './inpatient-financial-insurance.tsx'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write?: ReturnType<typeof useInpatientWriteIntent> }
type Frozen = { kind: 'refund'; data: z.infer<typeof inpatientFinancialRefundPreviewResponseSchema>['data'] }
  | { kind: 'payment'; data: z.infer<typeof inpatientPaymentPreviewResponseSchema>['data'] }
function FinancialWriteError({ locale, write }: { locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent> }) {
  return write.mutation.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(write.mutation.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null
}
function amountFen(value: string) {
  const input = value.trim()
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(input)) return 0
  const amount = yuanToFen(input)
  return amount !== undefined && amount > 0 && amount <= 1_000_000_000 ? amount : 0
}

export function InpatientFinancialAdjustments({ admission, session, locale, write }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const bill = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id, 'financial-adjustments'],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/financial-adjustments`, inpatientFinancialSchema, signal) })
  return <section aria-label={t('后续财务更正', 'Later financial adjustments')} className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4">
    <h3 className="font-serif">{t('后续财务更正', 'Later financial adjustments')}</h3>
    {bill.isPending ? <Skeleton className="h-16 w-full" /> : null}
    {bill.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(bill.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    {bill.data ? <>
      <p>{t('首次冻结费用', 'First frozen charges')} <span className="font-mono">{formatFen(bill.data.frozenChargesFen, locale)}</span> · {t('首次净资金', 'First net funds')} <span className="font-mono">{formatFen(bill.data.frozenFundsFen, locale)}</span></p>
      <p data-testid="financial-current">{t('当前费用', 'Current charges')} <span className="font-mono">{formatFen(bill.data.currentChargesFen, locale)}</span> · {t('当前净资金', 'Current net funds')} <span className="font-mono">{formatFen(bill.data.currentFundsFen, locale)}</span></p>
      <p>{t('待补收', 'To collect')} <span className="font-mono">{formatFen(bill.data.remainingCollectFen, locale)}</span> · {t('待退款', 'To refund')} <span className="font-mono">{formatFen(bill.data.remainingRefundFen, locale)}</span></p>
      <p>{t('未知补收', 'Unknown collection')} <span className="font-mono">{formatFen(bill.data.reservedCollectFen, locale)}</span> · {t('未知退款', 'Unknown refund')} <span className="font-mono">{formatFen(bill.data.reservedFen, locale)}</span></p>
      <p className="text-sm text-muted-foreground">{t('更正以追加记录核对当前差异，首次结算与归档快照继续保留。', 'Appended corrections explain current differences while preserving the first settlement and archived record.')}</p>
      {bill.data.adjustments.map(item => <p className="break-all" key={item.adjustmentId}>{item.direction === 'decrease' ? t('冲减', 'Decrease') : t('补计', 'Increase')} <span className="font-mono">{formatFen(item.amountFen, locale)}</span> · {item.reason} · {item.status === 'unknown' ? t('资金结果未知', 'Funds unknown') : item.status === 'completed' ? t('调整完成', 'Completed') : t('待处理', 'Pending')} · <span className="font-mono">{item.adjustmentId}</span></p>)}
      <InpatientFinancialInsurance bill={bill.data} locale={locale} write={write} fetching={bill.isFetching} />
      {write && session.actor.roleCode === 'cashier' ? <FinancialActions key={admission.id} bill={bill.data} admission={admission} locale={locale} write={write} fetching={bill.isFetching} /> : null}
    </> : null}
  </section>
}

function FinancialActions({ bill, admission, locale, write, fetching }: { bill: z.infer<typeof inpatientFinancialSchema>; admission: InpatientAdmission;
  locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>; fetching: boolean }) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const [chargeId, setChargeId] = useState<string | null>(null), [direction, setDirection] = useState<'decrease' | 'increase'>('decrease')
  const [amount, setAmount] = useState(''), [reason, setReason] = useState('')
  const [correction, setCorrection] = useState<z.infer<typeof inpatientFinancialAdjustmentInputSchema>>()
  const [adjustmentId, setAdjustmentId] = useState<string | null>(null), [sourceId, setSourceId] = useState<string | null>(null)
  const [money, setMoney] = useState(''), [card, setCard] = useState(''), [rule, setRule] = useState<z.infer<typeof paymentSimulatorRuleSchema>>('success')
  const [frozen, setFrozen] = useState<Frozen>()
  const result = write.mutation.data
  useEffect(() => {
    if (result?.command.input && 'admissionId' in result.command.input && result.command.input.admissionId === admission.id) {
      if (result.command.operation === 'inpatient.financial.refund.preview') setFrozen({ kind: 'refund', data: inpatientFinancialRefundPreviewResponseSchema.parse(result.response).data })
      if (result.command.operation === 'inpatient.financial.payment.preview') setFrozen({ kind: 'payment', data: inpatientPaymentPreviewResponseSchema.parse(result.response).data })
      if (['inpatient.financial.refund.confirm', 'inpatient.financial.payment.confirm'].includes(result.command.operation)) setFrozen(undefined)
    }
  }, [result, admission.id])
  const charge = bill.charges.find(item => item.chargeId === chargeId) ?? bill.charges.find(item => item.originalFen > 0)
  const adjustment = bill.adjustments.find(item => item.adjustmentId === adjustmentId) ?? bill.adjustments.find(item => item.status === 'pending')
  const source = bill.sources.find(item => item.sourceId === sourceId) ?? bill.sources.find(item => item.refundableFen > 0)
  const value = amountFen(money), cardValue = amountFen(card), delta = amountFen(amount), busy = write.blocked || fetching
  const collecting = bill.insurance ? bill.remainingCollectFen > 0 : adjustment?.direction === 'increase'
  const insurancePending = bill.insurance && !bill.insurance.ready
  const correctionPending = bill.insurance && (insurancePending || bill.remainingCollectFen + bill.remainingRefundFen + bill.reservedFen + bill.reservedCollectFen > 0)
  const tenders = [{ method: 'cash' as const, amountFen: value - cardValue }, { method: 'bank-card' as const, amountFen: cardValue }].filter(item => item.amountFen > 0)
  const outcome = (value: string) => value === 'ambiguous' ? t('结果未知', 'Unknown') : value === 'declined' ? t('已拒绝', 'Declined') : t('成功', 'Succeeded')
  return <>
    <FieldGroup>
      <Field><FieldLabel htmlFor="financial-charge">{t('更正关联原费用', 'Original charge')}</FieldLabel><WorkspaceSelect id="financial-charge" value={charge?.chargeId ?? null} items={bill.charges.filter(item => item.originalFen > 0).map(item => ({ value: item.chargeId, label: `${item.label} · ${formatFen(item.currentFen, locale)}` }))} onValueChange={setChargeId} /></Field>
      <Field><FieldLabel htmlFor="financial-direction">{t('更正方向', 'Correction direction')}</FieldLabel><WorkspaceSelect id="financial-direction" value={direction} items={[{ value: 'decrease', label: t('冲减', 'Decrease') }, { value: 'increase', label: t('补计', 'Increase') }]} onValueChange={value => { if (value) setDirection(value) }} /></Field>
      <Field><FieldLabel htmlFor="financial-amount">{t('更正金额（元）', 'Correction (CNY)')}</FieldLabel><Input id="financial-amount" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /></Field>
      <Field><FieldLabel htmlFor="financial-reason">{t('财务更正原因', 'Reason for correction')}</FieldLabel><Input id="financial-reason" value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} /></Field>
    </FieldGroup>
    <Button variant="outline" disabled={busy || !!correctionPending || !charge || !delta || reason.trim().length < 5} onClick={() => { if (charge) setCorrection({ admissionId: admission.id, chargeId: charge.chargeId, direction, amountFen: delta, reason: reason.trim(), expectedFingerprint: bill.fingerprint }) }}>{t('审阅财务更正', 'Review financial correction')}</Button>
    {bill.adjustments.length ? <>
      <FieldGroup>
        <Field><FieldLabel htmlFor="financial-basis">{t('收退款更正依据', 'Adjustment for collection or refund')}</FieldLabel><WorkspaceSelect id="financial-basis" value={adjustment?.adjustmentId ?? null} items={bill.adjustments.map(item => ({ value: item.adjustmentId, label: `${item.direction === 'decrease' ? t('冲减', 'Decrease') : t('补计', 'Increase')} · ${item.reason} · ${formatFen(item.remainingFen, locale)}` }))} onValueChange={setAdjustmentId} /></Field>
        {!collecting ? <Field><FieldLabel htmlFor="financial-source">{t('退款原交易', 'Original payment to refund')}</FieldLabel><WorkspaceSelect id="financial-source" value={source?.sourceId ?? null} items={bill.sources.map(item => ({ value: item.sourceId, label: `${item.sourceId} · ${formatFen(item.refundableFen, locale)}` }))} onValueChange={setSourceId} /></Field> : null}
        <Field><FieldLabel htmlFor="financial-money">{t('本次收退金额（元）', 'Collection or refund (CNY)')}</FieldLabel><Input id="financial-money" inputMode="decimal" value={money} onChange={event => setMoney(event.target.value)} /></Field>
        {collecting ? <Field><FieldLabel htmlFor="financial-card">{t('其中银行卡（元，其余现金）', 'Bank card portion (CNY; remainder in cash)')}</FieldLabel><Input id="financial-card" inputMode="decimal" value={card} onChange={event => setCard(event.target.value)} /></Field> : null}
        <Field><FieldLabel htmlFor="financial-rule">{t('合成渠道结果', 'Synthetic channel result')}</FieldLabel><WorkspaceSelect id="financial-rule" value={rule} onValueChange={value => { if (value) setRule(value) }} items={[
          { value: 'success', label: t('成功', 'Success') }, { value: 'decline', label: t('拒绝', 'Declined') }, { value: 'ambiguous', label: t('未知，查询成功', 'Unknown, resolves succeeded') }, { value: 'ambiguous-decline', label: t('未知，查询拒绝', 'Unknown, resolves declined') }, { value: 'ambiguous-pending', label: t('持续未知', 'Remains unknown') },
        ]} /></Field>
      </FieldGroup>
      <Button disabled={busy || !!insurancePending || !adjustment || !value || (collecting ? cardValue > value || (card.trim() !== '' && card.trim() !== '0' && !cardValue) : !source)} onClick={() => {
        if (!adjustment) return
        if (collecting) write.mutation.mutate({ operation: 'inpatient.financial.payment.preview', input: { admissionId: admission.id, adjustmentId: adjustment.adjustmentId, amountFen: value, tenders, expectedFingerprint: bill.fingerprint, simulatorRule: rule } })
        else if (source) write.mutation.mutate({ operation: 'inpatient.financial.refund.preview', input: { admissionId: admission.id, adjustmentId: adjustment.adjustmentId, sourceKind: source.sourceKind, sourceId: source.sourceId, amountFen: value, expectedSourceVersion: source.version, expectedFingerprint: bill.fingerprint, simulatorRule: rule } })
      }}>{collecting ? t('预览后续补收', 'Preview later collection') : t('预览后续退款', 'Preview later refund')}</Button>
    </> : null}
    {bill.payments.map(item => <div className="flex flex-col gap-2" key={item.paymentId}><p className="break-all">{t('后续补收', 'Later collection')} <span className="font-mono">{formatFen(item.amountFen, locale)}</span> · {outcome(item.outcome)} · <span className="font-mono">{item.paymentId}</span></p>{item.outcome === 'ambiguous' ? <Button variant="outline" disabled={busy} onClick={() => write.mutation.mutate({ operation: 'inpatient.financial.payment.recover', input: { admissionId: admission.id, paymentId: item.paymentId, expectedPaymentVersion: item.version } })}>{t('查询原补收结果', 'Query original collection')}</Button> : null}</div>)}
    {bill.refunds.map(item => <div className="flex flex-col gap-2" key={item.refundId}><p className="break-all">{t('后续退款', 'Later refund')} <span className="font-mono">{formatFen(item.amountFen, locale)}</span> · {outcome(item.outcome)} · <span className="font-mono">{item.refundId}</span></p>{item.outcome === 'ambiguous' ? <Button variant="outline" disabled={busy} onClick={() => write.mutation.mutate({ operation: 'inpatient.financial.refund.recover', input: { admissionId: admission.id, refundId: item.refundId, expectedRefundVersion: item.version } })}>{t('查询原后续退款结果', 'Query original later refund')}</Button> : null}</div>)}
    <AlertDialog open={!!correction} onOpenChange={open => { if (!open && !write.mutation.isPending) setCorrection(undefined) }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('确认后续财务更正', 'Confirm later financial correction')}</AlertDialogTitle><AlertDialogDescription>{t('核对更正方向、金额和原因。费用与资金分别记录。', 'Review the direction, amount and reason. Charges and funds are recorded separately.')}</AlertDialogDescription></AlertDialogHeader><p>{correction?.direction === 'decrease' ? t('冲减', 'Decrease') : t('补计', 'Increase')} <span className="font-mono">{formatFen(correction?.amountFen ?? 0, locale)}</span> · {correction?.reason}</p><FinancialWriteError locale={locale} write={write} /><AlertDialogFooter><AlertDialogCancel disabled={write.mutation.isPending}>{t('取消', 'Cancel')}</AlertDialogCancel><Button disabled={write.blocked} onClick={() => { if (correction) write.mutation.mutate({ operation: 'inpatient.financial.adjust', input: correction }, { onSuccess: () => { setCorrection(undefined); setAmount(''); setReason('') } }) }}>{t('提交财务更正', 'Submit financial correction')}</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={!!frozen} onOpenChange={open => { if (!open && !write.mutation.isPending) setFrozen(undefined) }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{frozen?.kind === 'payment' ? t('确认后续补收', 'Confirm later collection') : t('确认后续退款', 'Confirm later refund')}</AlertDialogTitle><AlertDialogDescription>{t('核对本次冻结预览；结果未知时查询原尝试。', 'Review this frozen preview; query the original attempt if its result is unknown.')}</AlertDialogDescription></AlertDialogHeader><p><span className="font-mono">{formatFen(frozen?.data.amountFen ?? 0, locale)}</span> · {frozen?.data.expectedOutcome ? outcome(frozen.data.expectedOutcome) : ''}</p><FinancialWriteError locale={locale} write={write} /><AlertDialogFooter><AlertDialogCancel disabled={write.mutation.isPending}>{t('取消', 'Cancel')}</AlertDialogCancel><Button disabled={write.blocked} onClick={() => { if (frozen) write.mutation.mutate({ operation: frozen.kind === 'payment' ? 'inpatient.financial.payment.confirm' : 'inpatient.financial.refund.confirm', input: { admissionId: admission.id, previewId: frozen.data.previewId, commitToken: frozen.data.commitToken } }) }}>{t('确认本次收退', 'Confirm this transaction')}</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>
}
