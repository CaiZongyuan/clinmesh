import { inpatientPaymentPreviewResponseSchema, inpatientRefundPreviewResponseSchema, type inpatientPaymentsSchema } from '@clinmesh/contracts/inpatient-discharge'
import type { InpatientStage } from '@clinmesh/contracts/agent'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { z } from 'zod'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { useId, useState } from 'react'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen, formatShanghaiMinute, yuanToFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { AgentDraftField, WorkspaceActionBar, useWorkspaceConfirmation } from './workspace-card-layout.tsx'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { useInpatientAgentState } from './inpatient-agent-tools.tsx'

type Props = { admission: InpatientAdmission; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>; statement: z.infer<typeof inpatientPaymentsSchema>; collect?: boolean; allowExtraCollection?: boolean; stage?: InpatientStage }
export function InpatientFunding({ admission, locale, write, statement, collect = true, allowExtraCollection = false, stage = 'discharge' }: Props): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const agent = useInpatientAgentState()
  const id = useId()
  const [extraCollection, setExtraCollection] = useState(false)
  const [comboMode, setComboMode] = useState(false)
  const [singleMethod, setSingleMethod] = useState<'cash' | 'bank-card' | 'mobile'>('cash')
  const showCollection = collect || extraCollection
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
  const hasMultipleTenders = enteredTenders.length > 1 || Object.values(agent?.payment.assisted ?? {}).filter(Boolean).length > 1
  const showCombo = comboMode || hasMultipleTenders
  const defaultSingle = kind === 'supplement' && Object.values(amounts).every(value => value === '') && statement.remainingFen > 0
  const tenders = defaultSingle ? [{ method: singleMethod, amountFen: statement.remainingFen }] : enteredTenders
  const amountFen = tenders.reduce((sum, tender) => sum + tender.amountFen, 0)
  const invalidAmount = Object.values(amounts).some(value => value !== '' && yuanToFen(value) === undefined) || !Number.isSafeInteger(amountFen) || amountFen <= 0 || kind === 'supplement' && amountFen > statement.remainingFen
  const refundFen = yuanToFen(refundAmount), blocked = write.blocked || statement.pendingCount > 0
  const latest = write.mutation.data
  const payPreview = latest?.command.operation === 'inpatient.payment.preview' && latest.command.input.admissionId === admission.id
    ? inpatientPaymentPreviewResponseSchema.parse(latest.response).data : undefined
  const refundPreview = latest?.command.operation === 'inpatient.refund.preview' && latest.command.input.admissionId === admission.id
    ? inpatientRefundPreviewResponseSchema.parse(latest.response).data : undefined
  const confirmation = useWorkspaceConfirmation({ open: !!payPreview || !!refundPreview, pending: write.mutation.isPending, disabled: blocked,
    scope: JSON.stringify([admission.id, kind]), onCancel: () => write.mutation.reset() })
  const formatTenders = (items: typeof tenders | undefined) => (items ?? []).map(item => `${methods[item.method]} ${formatFen(item.amountFen,locale)}`).join(' / ')
  const showRefundForm = collect && admission.status === 'departed' && statement.remainingFen < 0
  const supplementCompleted = statement.payments.some(p => p.kind === 'supplement' && p.outcome === 'success') && statement.remainingFen === 0
  return <section aria-label={t('住院收退款','Inpatient funding')} className="flex min-w-0 flex-col gap-3">
    <h3 className="font-bold">{t('住院收退款','Inpatient funding')}</h3>
    {supplementCompleted ? <div role="status" className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-800 dark:text-emerald-300">
      ✓ {t('已收出院补交，可继续预览并确认出院结算', 'Departure supplement collected; ready to preview and confirm settlement')}
    </div> : null}
    <div className="flex flex-col gap-2 rounded-md border bg-card px-3 py-2 text-sm">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span>{t('累计预交金：','Deposits: ')}<span className="font-semibold text-foreground tabular-nums">{formatFen(statement.depositFen,locale)}</span></span>
        <span>{t('成功补缴：','Supplements: ')}<span className="font-semibold text-foreground tabular-nums">{formatFen(statement.supplementFen,locale)}</span></span>
        <span>{t('成功退款：','Refunds: ')}<span className="font-semibold text-foreground tabular-nums">{formatFen(statement.refundedFen,locale)}</span></span>
      </div>
      <p data-testid="inpatient-funding-balance" className="text-base">
        {statement.remainingFen < 0 ? t('应退：','Still refundable: ') : statement.remainingFen === 0 ? t('无需补退：', 'No balance: ') : t('需补交：','Still due: ')}<span className="font-semibold tabular-nums">{formatFen(Math.abs(statement.remainingFen),locale)}</span>
      </p>
    </div>
    {statement.pendingCount > 0 ? <Alert><AlertDescription>{t('资金结果未知，请查询原尝试。查明前不能再次收退款、封账或清床。','Funds are unknown. Query the original attempt before another payment, settlement or bed clearance.')}</AlertDescription></Alert> : null}
    {showCollection || showRefundForm ? <details className="clinmesh-inpatient-disclosure rounded-md border border-dashed px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium text-muted-foreground">{t('渠道结果设置：合成渠道结果', 'Channel result setting: synthetic channel result')}（{rules[rule]}）</summary>
      <div className="pt-2">
        <Field><FieldLabel id={`${id}-inpatient-funding-rule-label`}>{t('合成渠道结果','Synthetic channel result')}</FieldLabel>
          <ToggleGroup aria-labelledby={`${id}-inpatient-funding-rule-label`} disabled={blocked} value={[rule]} variant="outline" className="max-w-full flex-wrap" onValueChange={values => {
            const value = values[0]
            if (value === 'success' || value === 'decline' || value === 'ambiguous' || value === 'ambiguous-decline' || value === 'ambiguous-pending') setRule(value)
          }}>{Object.entries(rules).map(([value,label]) => <ToggleGroupItem key={value} value={value}>{label}</ToggleGroupItem>)}</ToggleGroup>
        </Field>
      </div>
    </details> : null}
    {!collect && allowExtraCollection ? <Button variant="outline" className="self-start" aria-expanded={extraCollection} onClick={() => setExtraCollection(value => !value)}>{extraCollection ? t('收起补充预交金', 'Hide additional deposit') : t('补充预交金', 'Additional deposit')}</Button> : null}
    {showCollection ? <FieldSet disabled={blocked} className="rounded-md border bg-card p-3">
      <FieldLegend>{t('收取预交金或补缴','Collect deposit or supplement')}</FieldLegend>
      <FieldGroup>
        <Field><FieldLabel id={`${id}-inpatient-funding-kind-label`}>{t('收款用途','Collection purpose')}</FieldLabel>
          <ToggleGroup aria-labelledby={`${id}-inpatient-funding-kind-label`} value={[kind]} variant="outline" onValueChange={values => {
            if (values[0] === 'deposit' || values[0] === 'supplement') setKind(values[0])
          }}><ToggleGroupItem value="deposit">{t('预交金','Deposit')}</ToggleGroupItem><ToggleGroupItem value="supplement" disabled={admission.status !== 'departed'}>{t('出院补交','Departure supplement')}</ToggleGroupItem></ToggleGroup>
        </Field>
        {showCombo ? <>
          <div className="grid gap-3 sm:grid-cols-3">
            {(Object.keys(methods) as Array<keyof typeof methods>).map(method => <AgentDraftField key={method} assisted={agent?.payment.assisted[method] === true} locale={locale}><Field data-invalid={amounts[method] !== '' && yuanToFen(amounts[method]) === undefined}>
              <FieldLabel htmlFor={`${id}-inpatient-funding-${method}`}>{methods[method]}{t('金额（元）',' amount (CNY)')}</FieldLabel>
              <Input id={`${id}-inpatient-funding-${method}`} data-inpatient-funding-method={method} inputMode="decimal" className="tabular-nums" value={amounts[method]} aria-invalid={amounts[method] !== '' && yuanToFen(amounts[method]) === undefined}
                onChange={event => {
                  const next = { ...amounts, [method]: event.currentTarget.value }
                  if (agent) agent.updatePayment({ amounts: next, assisted: { ...agent.payment.assisted, [method]: false } })
                  else setLocalAmounts(next)
                }} />
              {amounts[method] !== '' && yuanToFen(amounts[method]) === undefined ? <p role="alert">{t('请填写有效金额，最多两位小数。', 'Enter a valid amount with at most two decimal places.')}</p> : null}
            </Field></AgentDraftField>)}
          </div>
          {!hasMultipleTenders ? <Button type="button" variant="ghost" size="sm" className="self-start text-xs text-muted-foreground" onClick={() => setComboMode(false)}>{t('收起组合支付', 'Use single payment method')}</Button> : null}
        </> : <>
          <div className="grid gap-3 sm:grid-cols-2">
            <AgentDraftField assisted={agent?.payment.assisted[singleMethod] === true} locale={locale}>
              <Field data-invalid={amounts[singleMethod] !== '' && yuanToFen(amounts[singleMethod]) === undefined}>
                <FieldLabel htmlFor={`${id}-inpatient-funding-${singleMethod}`}>{methods[singleMethod]}{t('金额（元）',' amount (CNY)')}</FieldLabel>
                <Input id={`${id}-inpatient-funding-${singleMethod}`} data-inpatient-funding-method={singleMethod} inputMode="decimal" className="tabular-nums" placeholder={defaultSingle ? (statement.remainingFen / 100).toFixed(2) : '0.00'} value={amounts[singleMethod]} aria-invalid={amounts[singleMethod] !== '' && yuanToFen(amounts[singleMethod]) === undefined}
                  onChange={event => {
                    const next = { cash: '', 'bank-card': '', mobile: '', [singleMethod]: event.currentTarget.value }
                    if (agent) agent.updatePayment({ amounts: next, assisted: { ...agent.payment.assisted, [singleMethod]: false } })
                    else setLocalAmounts(next)
                  }} />
                {amounts[singleMethod] !== '' && yuanToFen(amounts[singleMethod]) === undefined ? <p role="alert">{t('请填写有效金额，最多两位小数。', 'Enter a valid amount with at most two decimal places.')}</p> : null}
              </Field>
            </AgentDraftField>
            <Field>
              <FieldLabel id={`${id}-inpatient-funding-method-label`}>{t('收款方式', 'Payment method')}</FieldLabel>
              <ToggleGroup aria-labelledby={`${id}-inpatient-funding-method-label`} value={[singleMethod]} variant="outline" className="flex-wrap" onValueChange={values => {
                const nextMethod = values[0] as keyof typeof methods | undefined
                if (nextMethod && nextMethod in methods) {
                  const val = amounts[singleMethod]
                  const next = { cash: '', 'bank-card': '', mobile: '', [nextMethod]: val }
                  setSingleMethod(nextMethod)
                  if (agent) agent.updatePayment({ amounts: next })
                  else setLocalAmounts(next)
                }
              }}>
                {Object.entries(methods).map(([m, label]) => <ToggleGroupItem key={m} value={m}>{label}</ToggleGroupItem>)}
              </ToggleGroup>
            </Field>
          </div>
          <Button type="button" variant="ghost" size="sm" className="self-start text-xs text-muted-foreground" onClick={() => setComboMode(true)}>+ {t('组合支付（多方式分摊）', 'Split across multiple methods')}</Button>
        </>}
        {kind === 'supplement' ? <p className="text-xs text-muted-foreground">{t('金额留空时，按全部需补交金额记入当前所选方式。', 'Leave amounts blank to collect the full remaining balance.')}</p> : null}

      </FieldGroup>
    </FieldSet> : null}
    {payPreview ? <Alert data-inpatient-funding-preview><AlertDescription>
      <p>{t('已固定收款预览：','Fixed collection preview: ')}{payPreview.kind === 'deposit' ? t('预交金','Deposit') : t('补缴','Supplement')} · <span className="font-semibold tabular-nums">{formatFen(payPreview.amountFen,locale)}</span> · {formatTenders(payPreview.tenders)} · {outcome(payPreview.expectedOutcome)}</p>
    </AlertDescription></Alert> : null}
    {showRefundForm ? <FieldSet disabled={blocked} className="rounded-md border bg-card p-3"><FieldLegend>{t('按原款退款','Refund original collection')}</FieldLegend><FieldGroup>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field><FieldLabel htmlFor={`${id}-inpatient-refund-source`}>{t('原入金','Original collection')}</FieldLabel>
          <WorkspaceSelect id={`${id}-inpatient-refund-source`} value={sourceId} onValueChange={setSourceId} items={statement.sources.filter(source => source.refundableFen > 0).map(source => ({value:source.id,
            label:`${source.kind === 'inpatient-deposit' ? t('预交金','Deposit') : t('补缴','Supplement')} · ${formatShanghaiMinute(source.createdAt)} · ${t('可退','Refundable')} ${formatFen(source.refundableFen,locale)}`}))} />
        </Field>
        <Field><FieldLabel htmlFor={`${id}-inpatient-refund-amount`}>{t('退款金额（元）','Refund amount (CNY)')}</FieldLabel><Input id={`${id}-inpatient-refund-amount`} inputMode="decimal" className="tabular-nums" value={refundAmount} onChange={event => setRefundAmount(event.currentTarget.value)} /></Field>
      </div>
      <div><Button disabled={blocked || !sourceId || refundFen === undefined || refundFen <= 0} onClick={() => { if (sourceId && refundFen) { confirmation.captureTrigger(); write.mutation.mutate({operation:'inpatient.refund.preview',input:{admissionId:admission.id,sourceId,amountFen:refundFen,simulatorRule:rule}}) } }}>{t('预览退款','Preview refund')}</Button></div>
    </FieldGroup></FieldSet> : null}
    {refundPreview ? <Alert><AlertDescription>
      <p>{t('已固定退款预览：','Fixed refund preview: ')}<span className="font-semibold tabular-nums">{formatFen(refundPreview.amountFen,locale)}</span> · {t('原入金','Original collection')} <span className="tabular-nums">{statement.sources.find(source => source.id === refundPreview.sourceId) ? formatShanghaiMinute(statement.sources.find(source => source.id === refundPreview.sourceId)!.createdAt) : t('已核对原款', 'Original collection verified')}</span> · {outcome(refundPreview.expectedOutcome)}</p>
    </AlertDescription></Alert> : null}
    <Table><TableHeader><TableRow><TableHead>{t('资金记录','Funding')}</TableHead><TableHead className="text-right">{t('金额与方式','Amount and methods')}</TableHead><TableHead>{t('结果','Outcome')}</TableHead><TableHead>{t('原尝试查询','Query original attempt')}</TableHead></TableRow></TableHeader><TableBody>
      {statement.payments.length === 0 && statement.refunds.length === 0 ? <TableRow><TableCell colSpan={4} className="text-center text-xs text-muted-foreground">{t('暂无资金记录', 'No funding records')}</TableCell></TableRow> : null}
      {statement.payments.map(payment => <TableRow key={payment.paymentId}><TableCell>{payment.kind === 'deposit' ? t('预交金','Deposit') : t('补缴','Supplement')} · <span className="text-xs text-muted-foreground tabular-nums">{formatShanghaiMinute(payment.createdAt)}</span></TableCell><TableCell className="whitespace-nowrap text-right"><span className="font-semibold tabular-nums">{formatFen(payment.amountFen,locale)}</span> · {formatTenders(payment.tenders)}</TableCell><TableCell>{outcome(payment.outcome)}</TableCell><TableCell>
        {payment.outcome === 'ambiguous' ? <Button disabled={write.blocked} onClick={() => write.mutation.mutate({operation:'inpatient.payment.recover',input:{admissionId:admission.id,paymentId:payment.paymentId,expectedPaymentVersion:payment.version}})}>{t('查询原收款','Query original collection')}</Button> : null}
      </TableCell></TableRow>)}
      {statement.refunds.map(refund => <TableRow key={refund.refundId}><TableCell>{t('退款','Refund')} · <span className="text-xs text-muted-foreground tabular-nums">{formatShanghaiMinute(refund.createdAt)}</span></TableCell><TableCell className="whitespace-nowrap text-right"><span className="font-semibold tabular-nums">{formatFen(refund.amountFen,locale)}</span> · {formatTenders(refund.tenders)}</TableCell><TableCell>{outcome(refund.outcome)}</TableCell><TableCell>
        {refund.outcome === 'ambiguous' ? <Button disabled={write.blocked} onClick={() => write.mutation.mutate({operation:'inpatient.refund.recover',input:{admissionId:admission.id,refundId:refund.refundId,expectedRefundVersion:refund.version}})}>{t('查询原退款','Query original refund')}</Button> : null}
      </TableCell></TableRow>)}
    </TableBody></Table>
    {payPreview || refundPreview || statement.pendingCount > 0 || showCollection && (statement.remainingFen > 0 || kind === 'deposit') ? <InpatientPrimaryAction stage={stage} priority={statement.pendingCount > 0 ? 50 : payPreview || refundPreview ? 30 : 20}>
      <WorkspaceActionBar onKeyDown={confirmation.onKeyDown} summary={statement.pendingCount > 0 ? t('原支付结果待查明', 'Original payment result pending') : statement.remainingFen < 0 ? `${t('应退 ', 'Refund due ')}${formatFen(-statement.remainingFen, locale)}` : statement.remainingFen === 0 ? t('无需补退', 'No balance due') : `${t('需补交 ', 'Amount due ')}${formatFen(statement.remainingFen, locale)}`}
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
          : payPreview || refundPreview ? <><Button variant="outline" disabled={write.mutation.isPending} onClick={() => write.mutation.reset()}>{t('返回', 'Back')}</Button>
            <Button ref={confirmation.confirmRef} disabled={blocked} onClick={() => {
              if (payPreview) write.mutation.mutate({ operation: 'inpatient.payment.confirm', input: { admissionId: admission.id, previewId: payPreview.previewId, commitToken: payPreview.commitToken } })
              else if (refundPreview) write.mutation.mutate({ operation: 'inpatient.refund.confirm', input: { admissionId: admission.id, previewId: refundPreview.previewId, commitToken: refundPreview.commitToken } })
            }}>{payPreview ? t('确认收款', 'Confirm collection') : t('确认退款', 'Confirm refund')}</Button></>
            : <Button ref={confirmation.triggerRef} disabled={blocked || invalidAmount} onClick={() => { confirmation.captureTrigger(); write.mutation.mutate({ operation: 'inpatient.payment.preview', input: { admissionId: admission.id, kind, amountFen, tenders, simulatorRule: rule } }) }}>{t('预览收款', 'Preview collection')}</Button>} />
    </InpatientPrimaryAction> : null}
  </section>
}
