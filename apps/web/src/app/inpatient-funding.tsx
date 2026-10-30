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
import { AgentDraftField, WorkspaceActionBar } from './workspace-card-layout.tsx'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { useInpatientAgentState } from './inpatient-agent-tools.tsx'

type Props = { admission: InpatientAdmission; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>; statement: z.infer<typeof inpatientPaymentsSchema> }
export function InpatientFunding({ admission, locale, write, statement }: Props): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const agent = useInpatientAgentState()
  const [localKind, setLocalKind] = useState<'deposit' | 'supplement'>(admission.status === 'departed' ? 'supplement' : 'deposit')
  const [localAmounts, setLocalAmounts] = useState({ cash: '', 'bank-card': '', mobile: '' })
  const kind = agent?.payment.kind ?? localKind, amounts = agent?.payment.amounts ?? localAmounts
  const setKind = (value: 'deposit' | 'supplement') => agent ? agent.updatePayment({ kind: value }) : setLocalKind(value)
  const [sourceId, setSourceId] = useState<string | null>(null), [refundAmount, setRefundAmount] = useState('')
  const [localRule, setLocalRule] = useState<'success' | 'decline' | 'ambiguous' | 'ambiguous-decline' | 'ambiguous-pending'>('success')
  const rule = agent?.payment.rule ?? localRule
  const setRule = (value: typeof localRule) => agent ? agent.updatePayment({ rule: value }) : setLocalRule(value)
  const methods = { cash: t('现金','Cash'), 'bank-card': t('银行卡','Bank card'), mobile: t('移动支付','Mobile payment') }
  const rules = { success: t('成功','Success'), decline: t('拒绝','Declined'), ambiguous: t('未知后查明成功','Unknown, then success'),
    'ambiguous-decline': t('未知后查明拒绝','Unknown, then declined'), 'ambiguous-pending': t('持续未知','Still unknown') }
  const outcome = (value: 'success' | 'declined' | 'ambiguous') => ({ success:t('成功','Success'),declined:t('拒绝','Declined'),ambiguous:t('结果未知','Unknown') })[value]
  const enteredTenders = (Object.keys(methods) as Array<keyof typeof methods>).flatMap(method => {
    const amountFen = yuanToFen(amounts[method] || '0')
    return amountFen === undefined || amountFen === 0 ? [] : [{ method, amountFen }]
  })
  const defaultCash = kind === 'supplement' && Object.values(amounts).every(value => value === '') && statement.remainingFen > 0
  const tenders = defaultCash ? [{ method: 'cash' as const, amountFen: statement.remainingFen }] : enteredTenders
  const amountFen = tenders.reduce((sum, tender) => sum + tender.amountFen, 0)
  const invalidAmount = Object.values(amounts).some(value => value !== '' && yuanToFen(value) === undefined) || !Number.isSafeInteger(amountFen) || amountFen <= 0 || kind === 'supplement' && amountFen > statement.remainingFen
  const refundFen = yuanToFen(refundAmount), blocked = write.blocked || statement.pendingCount > 0
  const latest = write.mutation.data
  const payPreview = latest?.command.operation === 'inpatient.payment.preview' && latest.command.input.admissionId === admission.id
    ? inpatientPaymentPreviewResponseSchema.parse(latest.response).data : undefined
  const refundPreview = latest?.command.operation === 'inpatient.refund.preview' && latest.command.input.admissionId === admission.id
    ? inpatientRefundPreviewResponseSchema.parse(latest.response).data : undefined
  const formatTenders = (items: typeof tenders | undefined) => (items ?? []).map(item => `${methods[item.method]} ${formatFen(item.amountFen,locale)}`).join(' / ')
  return <section aria-label={t('住院收退款','Inpatient funding')} className="flex min-w-0 flex-col gap-3">
    <h3 className="font-bold">{t('住院收退款','Inpatient funding')}</h3>
    <div className="flex flex-col gap-2 rounded-md border bg-card px-3 py-2 text-sm">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span>{t('累计预交金：','Deposits: ')}<span className="font-mono text-foreground tabular-nums">{formatFen(statement.depositFen,locale)}</span></span>
        <span>{t('成功补缴：','Supplements: ')}<span className="font-mono text-foreground tabular-nums">{formatFen(statement.supplementFen,locale)}</span></span>
        <span>{t('成功退款：','Refunds: ')}<span className="font-mono text-foreground tabular-nums">{formatFen(statement.refundedFen,locale)}</span></span>
      </div>
      <p data-testid="inpatient-funding-balance" className="text-base">
        {statement.remainingFen < 0 ? t('应退：','Still refundable: ') : t('需补交：','Still due: ')}<span className="font-mono font-semibold tabular-nums">{formatFen(Math.abs(statement.remainingFen),locale)}</span>
      </p>
    </div>
    {statement.pendingCount > 0 ? <Alert><AlertDescription>{t('资金结果未知，请查询原尝试。查明前不能再次收退款、封账或清床。','Funds are unknown. Query the original attempt before another payment, settlement or bed clearance.')}</AlertDescription></Alert> : null}
    <FieldSet disabled={blocked} className="rounded-md border bg-card p-3">
      <FieldLegend>{t('收取预交金或补缴','Collect deposit or supplement')}</FieldLegend>
      <FieldGroup>
        <Field><FieldLabel id="inpatient-funding-kind-label">{t('收款用途','Collection purpose')}</FieldLabel>
          <ToggleGroup aria-labelledby="inpatient-funding-kind-label" value={[kind]} variant="outline" onValueChange={values => {
            if (values[0] === 'deposit' || values[0] === 'supplement') setKind(values[0])
          }}><ToggleGroupItem value="deposit">{t('预交金','Deposit')}</ToggleGroupItem><ToggleGroupItem value="supplement" disabled={admission.status !== 'departed'}>{t('出院补交','Departure supplement')}</ToggleGroupItem></ToggleGroup>
        </Field>
        {(Object.keys(methods) as Array<keyof typeof methods>).map(method => <AgentDraftField key={method} assisted={agent?.payment.assisted[method] === true} locale={locale}><Field data-invalid={amounts[method] !== '' && yuanToFen(amounts[method]) === undefined}>
          <FieldLabel htmlFor={`inpatient-funding-${method}`}>{methods[method]}{t('金额（元）',' amount (CNY)')}</FieldLabel>
          <Input id={`inpatient-funding-${method}`} inputMode="decimal" className="font-mono" value={amounts[method]} aria-invalid={amounts[method] !== '' && yuanToFen(amounts[method]) === undefined}
            onChange={event => {
              const next = { ...amounts, [method]: event.currentTarget.value }
              if (agent) agent.updatePayment({ amounts: next, assisted: { ...agent.payment.assisted, [method]: false } })
              else setLocalAmounts(next)
            }} />
          {amounts[method] !== '' && yuanToFen(amounts[method]) === undefined ? <p role="alert">{t('请填写有效金额，最多两位小数。', 'Enter a valid amount with at most two decimal places.')}</p> : null}
        </Field></AgentDraftField>)}
        {kind === 'supplement' ? <p className="text-sm text-muted-foreground">{t('金额留空时，按全部需补交金额记为现金。', 'Leave amounts blank to collect the full remaining balance in cash.')}</p> : null}
        <Field><FieldLabel id="inpatient-funding-rule-label">{t('合成渠道结果','Synthetic channel result')}</FieldLabel>
          <ToggleGroup aria-labelledby="inpatient-funding-rule-label" value={[rule]} variant="outline" className="max-w-full flex-wrap" onValueChange={values => {
            const value = values[0]
            if (value === 'success' || value === 'decline' || value === 'ambiguous' || value === 'ambiguous-decline' || value === 'ambiguous-pending') setRule(value)
          }}>{Object.entries(rules).map(([value,label]) => <ToggleGroupItem key={value} value={value}>{label}</ToggleGroupItem>)}</ToggleGroup>
        </Field>
      </FieldGroup>
    </FieldSet>
    {payPreview ? <Alert data-inpatient-funding-preview><AlertDescription>
      <p>{t('已固定收款预览：','Fixed collection preview: ')}{payPreview.kind === 'deposit' ? t('预交金','Deposit') : t('补缴','Supplement')} · <span className="font-mono tabular-nums">{formatFen(payPreview.amountFen,locale)}</span> · {formatTenders(payPreview.tenders)} · {outcome(payPreview.expectedOutcome)}</p>
    </AlertDescription></Alert> : null}
    {admission.status === 'departed' ? <FieldSet disabled={blocked} className="rounded-md border bg-card p-3"><FieldLegend>{t('按原款退款','Refund original collection')}</FieldLegend><FieldGroup>
      <Field><FieldLabel htmlFor="inpatient-refund-source">{t('原入金','Original collection')}</FieldLabel>
        <WorkspaceSelect id="inpatient-refund-source" value={sourceId} onValueChange={setSourceId} items={statement.sources.filter(source => source.refundableFen > 0).map(source => ({value:source.id,
          label:`${source.kind === 'inpatient-deposit' ? t('预交金','Deposit') : t('补缴','Supplement')} · ${source.createdAt} · ${t('可退','Refundable')} ${formatFen(source.refundableFen,locale)}`}))} />
      </Field>
      <Field><FieldLabel htmlFor="inpatient-refund-amount">{t('退款金额（元）','Refund amount (CNY)')}</FieldLabel><Input id="inpatient-refund-amount" inputMode="decimal" className="font-mono" value={refundAmount} onChange={event => setRefundAmount(event.currentTarget.value)} /></Field>
      <div><Button disabled={blocked || !sourceId || refundFen === undefined || refundFen <= 0} onClick={() => { if (sourceId && refundFen) write.mutation.mutate({operation:'inpatient.refund.preview',input:{admissionId:admission.id,sourceId,amountFen:refundFen,simulatorRule:rule}}) }}>{t('预览退款','Preview refund')}</Button></div>
    </FieldGroup></FieldSet> : null}
    {refundPreview ? <Alert><AlertDescription>
      <p>{t('已固定退款预览：','Fixed refund preview: ')}<span className="font-mono tabular-nums">{formatFen(refundPreview.amountFen,locale)}</span> · {t('原入金','Original collection')} <span className="font-mono">{refundPreview.sourceId}</span> · {outcome(refundPreview.expectedOutcome)}</p>
    </AlertDescription></Alert> : null}
    <Table><TableHeader><TableRow><TableHead>{t('资金记录','Funding')}</TableHead><TableHead className="text-right">{t('金额与方式','Amount and methods')}</TableHead><TableHead>{t('结果','Outcome')}</TableHead><TableHead>{t('原尝试查询','Query original attempt')}</TableHead></TableRow></TableHeader><TableBody>
      {statement.payments.map(payment => <TableRow key={payment.paymentId}><TableCell>{payment.kind === 'deposit' ? t('预交金','Deposit') : t('补缴','Supplement')} · <span className="font-mono text-xs text-muted-foreground">{payment.createdAt}</span></TableCell><TableCell className="whitespace-nowrap text-right"><span className="font-mono tabular-nums">{formatFen(payment.amountFen,locale)}</span> · {formatTenders(payment.tenders)}</TableCell><TableCell>{outcome(payment.outcome)}</TableCell><TableCell>
        {payment.outcome === 'ambiguous' ? <Button disabled={write.blocked} onClick={() => write.mutation.mutate({operation:'inpatient.payment.recover',input:{admissionId:admission.id,paymentId:payment.paymentId,expectedPaymentVersion:payment.version}})}>{t('查询原收款','Query original collection')}</Button> : null}
      </TableCell></TableRow>)}
      {statement.refunds.map(refund => <TableRow key={refund.refundId}><TableCell>{t('退款','Refund')} · <span className="font-mono text-xs text-muted-foreground">{refund.createdAt}</span></TableCell><TableCell className="whitespace-nowrap text-right"><span className="font-mono tabular-nums">{formatFen(refund.amountFen,locale)}</span> · {formatTenders(refund.tenders)}</TableCell><TableCell>{outcome(refund.outcome)}</TableCell><TableCell>
        {refund.outcome === 'ambiguous' ? <Button disabled={write.blocked} onClick={() => write.mutation.mutate({operation:'inpatient.refund.recover',input:{admissionId:admission.id,refundId:refund.refundId,expectedRefundVersion:refund.version}})}>{t('查询原退款','Query original refund')}</Button> : null}
      </TableCell></TableRow>)}
    </TableBody></Table>
    {payPreview || refundPreview || statement.pendingCount > 0 || statement.remainingFen > 0 || kind === 'deposit' ? <InpatientPrimaryAction stage="discharge" priority={statement.pendingCount > 0 ? 50 : payPreview || refundPreview ? 30 : 20}>
      <WorkspaceActionBar summary={`${t('需补交 ', 'Amount due ')}${formatFen(Math.max(0, statement.remainingFen), locale)}`}
        tone={payPreview || refundPreview ? 'confirm' : blocked || invalidAmount ? 'blocked' : 'normal'}
        reason={statement.pendingCount > 0 ? t('结果未知，先查询原支付结果；查明前不能再次收退款或结算。', 'The result is unknown. Query the original payment before another collection, refund or settlement.')
          : payPreview ? `${t('确认后记录收款 ', 'Confirmation records a collection of ')}${formatFen(payPreview.amountFen, locale)} · ${formatTenders(payPreview.tenders)}`
            : refundPreview ? `${t('确认后按原款退款 ', 'Confirmation refunds the original collection: ')}${formatFen(refundPreview.amountFen, locale)}`
              : invalidAmount ? t('还差：核对收款金额，不能超过需补交金额。', 'Check the collection amount; it cannot exceed the remaining balance.') : undefined}
        action={statement.pendingCount > 0 ? <Button disabled={write.blocked} onClick={() => {
          const payment = statement.payments.find(item => item.outcome === 'ambiguous'), refund = statement.refunds.find(item => item.outcome === 'ambiguous')
          if (payment) write.mutation.mutate({ operation: 'inpatient.payment.recover', input: { admissionId: admission.id, paymentId: payment.paymentId, expectedPaymentVersion: payment.version } })
          else if (refund) write.mutation.mutate({ operation: 'inpatient.refund.recover', input: { admissionId: admission.id, refundId: refund.refundId, expectedRefundVersion: refund.version } })
        }}>{t('查询原支付结果', 'Query original payment result')}</Button>
          : payPreview || refundPreview ? <><Button variant="outline" disabled={blocked} onClick={() => write.mutation.reset()}>{t('返回', 'Back')}</Button>
            <Button disabled={blocked} onClick={() => {
              if (payPreview) write.mutation.mutate({ operation: 'inpatient.payment.confirm', input: { admissionId: admission.id, previewId: payPreview.previewId, commitToken: payPreview.commitToken } })
              else if (refundPreview) write.mutation.mutate({ operation: 'inpatient.refund.confirm', input: { admissionId: admission.id, previewId: refundPreview.previewId, commitToken: refundPreview.commitToken } })
            }}>{payPreview ? t('确认收款', 'Confirm collection') : t('确认退款', 'Confirm refund')}</Button></>
            : <Button disabled={blocked || invalidAmount} onClick={() => write.mutation.mutate({ operation: 'inpatient.payment.preview', input: { admissionId: admission.id, kind, amountFen, tenders, simulatorRule: rule } })}>{t('预览收款', 'Preview collection')}</Button>} />
    </InpatientPrimaryAction> : null}
  </section>
}
