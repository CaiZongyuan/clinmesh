import { inpatientPaymentPreviewResponseSchema, inpatientRefundPreviewResponseSchema, type inpatientPaymentsSchema } from '@clinmesh/contracts/inpatient-discharge'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { z } from 'zod'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { useState } from 'react'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen, yuanToFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

type Props = { admission: InpatientAdmission; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>; statement: z.infer<typeof inpatientPaymentsSchema> }
export function InpatientFunding({ admission, locale, write, statement }: Props): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const [kind, setKind] = useState<'deposit' | 'supplement'>('deposit')
  const [amounts, setAmounts] = useState({ cash: '', 'bank-card': '', mobile: '' })
  const [sourceId, setSourceId] = useState<string | null>(null), [refundAmount, setRefundAmount] = useState('')
  const [rule, setRule] = useState<'success' | 'decline' | 'ambiguous' | 'ambiguous-decline' | 'ambiguous-pending'>('success')
  const methods = { cash: t('现金','Cash'), 'bank-card': t('银行卡','Bank card'), mobile: t('移动支付','Mobile payment') }
  const rules = { success: t('成功','Success'), decline: t('拒绝','Declined'), ambiguous: t('未知后查明成功','Unknown, then success'),
    'ambiguous-decline': t('未知后查明拒绝','Unknown, then declined'), 'ambiguous-pending': t('持续未知','Still unknown') }
  const outcome = (value: 'success' | 'declined' | 'ambiguous') => ({ success:t('成功','Success'),declined:t('拒绝','Declined'),ambiguous:t('结果未知','Unknown') })[value]
  const tenders = (Object.keys(methods) as Array<keyof typeof methods>).flatMap(method => {
    const amountFen = yuanToFen(amounts[method] || '0')
    return amountFen === undefined || amountFen === 0 ? [] : [{ method, amountFen }]
  })
  const amountFen = tenders.reduce((sum, tender) => sum + tender.amountFen, 0)
  const invalidAmount = Object.values(amounts).some(value => value !== '' && yuanToFen(value) === undefined) || !Number.isSafeInteger(amountFen) || amountFen <= 0
  const refundFen = yuanToFen(refundAmount), blocked = write.blocked || statement.pendingCount > 0
  const latest = write.mutation.data
  const payPreview = latest?.command.operation === 'inpatient.payment.preview' && latest.command.input.admissionId === admission.id
    ? inpatientPaymentPreviewResponseSchema.parse(latest.response).data : undefined
  const refundPreview = latest?.command.operation === 'inpatient.refund.preview' && latest.command.input.admissionId === admission.id
    ? inpatientRefundPreviewResponseSchema.parse(latest.response).data : undefined
  const formatTenders = (items: typeof tenders | undefined) => (items ?? []).map(item => `${methods[item.method]} ${formatFen(item.amountFen,locale)}`).join(' / ')
  return <section aria-label={t('住院收退款','Inpatient funding')} className="flex min-w-0 flex-col gap-3">
    <h3 className="font-serif font-bold">{t('住院收退款','Inpatient funding')}</h3>
    <div className="flex flex-col gap-2 rounded-md border bg-card px-3 py-2 text-sm">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span>{t('累计预交金：','Deposits: ')}<span className="font-mono text-foreground tabular-nums">{formatFen(statement.depositFen,locale)}</span></span>
        <span>{t('成功补缴：','Supplements: ')}<span className="font-mono text-foreground tabular-nums">{formatFen(statement.supplementFen,locale)}</span></span>
        <span>{t('成功退款：','Refunds: ')}<span className="font-mono text-foreground tabular-nums">{formatFen(statement.refundedFen,locale)}</span></span>
      </div>
      <p data-testid="inpatient-funding-balance" className="text-base">
        {statement.remainingFen < 0 ? t('尚应退：','Still refundable: ') : t('尚应收：','Still due: ')}<span className="font-mono font-semibold tabular-nums">{formatFen(Math.abs(statement.remainingFen),locale)}</span>
      </p>
    </div>
    {statement.pendingCount > 0 ? <Alert><AlertDescription>{t('资金结果未知，请查询原尝试。查明前不能再次收退款、封账或清床。','Funds are unknown. Query the original attempt before another payment, settlement or bed clearance.')}</AlertDescription></Alert> : null}
    <FieldSet disabled={blocked} className="rounded-md border bg-card p-3">
      <FieldLegend className="font-serif">{t('收取预交金或补缴','Collect deposit or supplement')}</FieldLegend>
      <FieldGroup>
        <Field><FieldLabel id="inpatient-funding-kind-label">{t('收款用途','Collection purpose')}</FieldLabel>
          <ToggleGroup aria-labelledby="inpatient-funding-kind-label" value={[kind]} variant="outline" onValueChange={values => {
            if (values[0] === 'deposit' || values[0] === 'supplement') setKind(values[0])
          }}><ToggleGroupItem value="deposit">{t('预交金','Deposit')}</ToggleGroupItem><ToggleGroupItem value="supplement" disabled={admission.status !== 'departed'}>{t('出区补缴','Departure supplement')}</ToggleGroupItem></ToggleGroup>
        </Field>
        {(Object.keys(methods) as Array<keyof typeof methods>).map(method => <Field key={method} data-invalid={amounts[method] !== '' && yuanToFen(amounts[method]) === undefined}>
          <FieldLabel htmlFor={`inpatient-funding-${method}`}>{methods[method]}{t('金额（元）',' amount (CNY)')}</FieldLabel>
          <Input id={`inpatient-funding-${method}`} inputMode="decimal" className="font-mono" value={amounts[method]} aria-invalid={amounts[method] !== '' && yuanToFen(amounts[method]) === undefined}
            onChange={event => setAmounts({ ...amounts, [method]: event.currentTarget.value })} />
        </Field>)}
        <Field><FieldLabel id="inpatient-funding-rule-label">{t('合成渠道结果','Synthetic channel result')}</FieldLabel>
          <ToggleGroup aria-labelledby="inpatient-funding-rule-label" value={[rule]} variant="outline" className="max-w-full flex-wrap" onValueChange={values => {
            const value = values[0]
            if (value === 'success' || value === 'decline' || value === 'ambiguous' || value === 'ambiguous-decline' || value === 'ambiguous-pending') setRule(value)
          }}>{Object.entries(rules).map(([value,label]) => <ToggleGroupItem key={value} value={value}>{label}</ToggleGroupItem>)}</ToggleGroup>
        </Field>
        <div><Button disabled={blocked || invalidAmount} onClick={() => write.mutation.mutate({ operation:'inpatient.payment.preview',input:{ admissionId:admission.id,kind,amountFen,tenders,simulatorRule:rule } })}>{t('预览收款','Preview collection')}</Button></div>
      </FieldGroup>
    </FieldSet>
    {payPreview ? <Alert><AlertDescription>
      <p>{t('已冻结收款预览：','Frozen collection preview: ')}{payPreview.kind === 'deposit' ? t('预交金','Deposit') : t('补缴','Supplement')} · <span className="font-mono tabular-nums">{formatFen(payPreview.amountFen,locale)}</span> · {formatTenders(payPreview.tenders)} · {outcome(payPreview.expectedOutcome)}</p>
      <div><Button disabled={blocked} onClick={() => write.mutation.mutate({operation:'inpatient.payment.confirm',input:{admissionId:admission.id,previewId:payPreview.previewId,commitToken:payPreview.commitToken}})}>{t('确认已审阅收款','Confirm reviewed collection')}</Button></div>
    </AlertDescription></Alert> : null}
    {admission.status === 'departed' ? <FieldSet disabled={blocked} className="rounded-md border bg-card p-3"><FieldLegend className="font-serif">{t('按原款退款','Refund original collection')}</FieldLegend><FieldGroup>
      <Field><FieldLabel htmlFor="inpatient-refund-source">{t('原入金','Original collection')}</FieldLabel>
        <WorkspaceSelect id="inpatient-refund-source" value={sourceId} onValueChange={setSourceId} items={statement.sources.filter(source => source.refundableFen > 0).map(source => ({value:source.id,
          label:`${source.kind === 'inpatient-deposit' ? t('预交金','Deposit') : t('补缴','Supplement')} · ${source.createdAt} · ${t('可退','Refundable')} ${formatFen(source.refundableFen,locale)}`}))} />
      </Field>
      <Field><FieldLabel htmlFor="inpatient-refund-amount">{t('退款金额（元）','Refund amount (CNY)')}</FieldLabel><Input id="inpatient-refund-amount" inputMode="decimal" className="font-mono" value={refundAmount} onChange={event => setRefundAmount(event.currentTarget.value)} /></Field>
      <div><Button disabled={blocked || !sourceId || refundFen === undefined || refundFen <= 0} onClick={() => { if (sourceId && refundFen) write.mutation.mutate({operation:'inpatient.refund.preview',input:{admissionId:admission.id,sourceId,amountFen:refundFen,simulatorRule:rule}}) }}>{t('预览退款','Preview refund')}</Button></div>
    </FieldGroup></FieldSet> : null}
    {refundPreview ? <Alert><AlertDescription>
      <p>{t('已冻结退款预览：','Frozen refund preview: ')}<span className="font-mono tabular-nums">{formatFen(refundPreview.amountFen,locale)}</span> · {t('原入金','Original collection')} <span className="font-mono">{refundPreview.sourceId}</span> · {outcome(refundPreview.expectedOutcome)}</p>
      <div><Button disabled={blocked} onClick={() => write.mutation.mutate({operation:'inpatient.refund.confirm',input:{admissionId:admission.id,previewId:refundPreview.previewId,commitToken:refundPreview.commitToken}})}>{t('确认已审阅退款','Confirm reviewed refund')}</Button></div>
    </AlertDescription></Alert> : null}
    <Table><TableHeader><TableRow><TableHead>{t('资金记录','Funding')}</TableHead><TableHead className="text-right">{t('金额与方式','Amount and methods')}</TableHead><TableHead>{t('结果','Outcome')}</TableHead><TableHead>{t('原尝试查询','Query original attempt')}</TableHead></TableRow></TableHeader><TableBody>
      {statement.payments.map(payment => <TableRow key={payment.paymentId}><TableCell>{payment.kind === 'deposit' ? t('预交金','Deposit') : t('补缴','Supplement')} · <span className="font-mono text-xs text-muted-foreground">{payment.createdAt}</span></TableCell><TableCell className="whitespace-nowrap text-right"><span className="font-mono tabular-nums">{formatFen(payment.amountFen,locale)}</span> · {formatTenders(payment.tenders)}</TableCell><TableCell>{outcome(payment.outcome)}</TableCell><TableCell>
        {payment.outcome === 'ambiguous' ? <Button disabled={write.blocked} onClick={() => write.mutation.mutate({operation:'inpatient.payment.recover',input:{admissionId:admission.id,paymentId:payment.paymentId,expectedPaymentVersion:payment.version}})}>{t('查询原收款','Query original collection')}</Button> : null}
      </TableCell></TableRow>)}
      {statement.refunds.map(refund => <TableRow key={refund.refundId}><TableCell>{t('退款','Refund')} · <span className="font-mono text-xs text-muted-foreground">{refund.createdAt}</span></TableCell><TableCell className="whitespace-nowrap text-right"><span className="font-mono tabular-nums">{formatFen(refund.amountFen,locale)}</span> · {formatTenders(refund.tenders)}</TableCell><TableCell>{outcome(refund.outcome)}</TableCell><TableCell>
        {refund.outcome === 'ambiguous' ? <Button disabled={write.blocked} onClick={() => write.mutation.mutate({operation:'inpatient.refund.recover',input:{admissionId:admission.id,refundId:refund.refundId,expectedRefundVersion:refund.version}})}>{t('查询原退款','Query original refund')}</Button> : null}
      </TableCell></TableRow>)}
    </TableBody></Table>
  </section>
}
