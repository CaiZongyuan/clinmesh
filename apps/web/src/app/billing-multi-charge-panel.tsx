import type { billingCaseSchema, multiChargePaymentPreviewResponseSchema, SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import type { z } from 'zod'
import { newIdempotencyKey, previewMultiChargePayment } from './api-client.ts'
import { agentViewRevision } from './agent-page-context.tsx'
import { paymentMethodLabel } from './billing-case-panel.tsx'
import { emptyMultiChargeDraft, multiChargeDraftStorage, type MultiChargeDraft } from './billing-multi-charge-draft.ts'
import { parseTenderAmounts } from './billing-payment-input.ts'
import { PaginationControls } from './pagination-controls.tsx'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceErrorMessage } from './workspace-error.ts'

type Bill = z.infer<typeof billingCaseSchema>
type Charge = Bill['charges'][number]
type FrozenPreview = z.infer<typeof multiChargePaymentPreviewResponseSchema>['data']

function available(charge: Charge) {
  return charge.category !== 'registration' && ['billable', 'declined'].includes(charge.status) && charge.remainingFen > 0
}

export function BillingMultiChargePanel({ bill, session, locale, blocked, onRefresh }: {
  bill: Bill; session: SessionContext; locale: WorkspaceLocale; blocked: boolean; onRefresh: () => unknown
}) {
  const zh = locale === 'zh-CN'
  const messages = getWorkspaceMessages(locale)
  const storage = multiChargeDraftStorage(session, { caseId: bill.caseId, patientId: bill.patient.id, encounterId: bill.encounterId })
  const [state, setState] = useState(() => storage.load())
  const draft = state.draft
  const [open, setOpen] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [frozen, setFrozen] = useState<{ signature: string; data: FrozenPreview }>()
  const [expired, setExpired] = useState(false)
  const fieldsId = useId()
  const revision = useRef(0)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const signature = agentViewRevision({ storageKey: storage.key, draft, charges: bill.charges })
  const current = useRef(signature)
  current.current = signature
  const selected = draft.selectedChargeIds.map(id => ({ id, charge: bill.charges.find(charge => charge.chargeItemId === id) }))
  const selectedCharges = selected.flatMap(item => item.charge === undefined ? [] : [item.charge])
  const invalid = selected.some(item => item.charge === undefined || !available(item.charge))
  const remainingFen = selectedCharges.reduce((sum, charge) => sum + charge.remainingFen, 0)
  let tenderError = ''
  let tenders: ReturnType<typeof parseTenderAmounts>
  try {
    tenders = parseTenderAmounts(draft.tenderAmounts, messages.invalidPaymentAmount)
    if (tenders !== undefined && tenders.reduce((sum, tender) => sum + tender.amountFen, 0) !== remainingFen) {
      tenderError = zh ? '组合支付合计必须等于所选项目剩余应收。' : 'Tender total must equal the selected remaining balance.'
    }
  } catch { tenderError = messages.invalidPaymentAmount }
  const preview = useMutation({
    mutationFn: (submission: { input: Parameters<typeof previewMultiChargePayment>[0]; signature: string; revision: number }) =>
      previewMultiChargePayment(submission.input, newIdempotencyKey()),
    onSuccess: (response, submission) => {
      if (mounted.current && submission.signature === current.current && submission.revision === revision.current) {
        setFrozen({ signature: submission.signature, data: response.data })
        setExpired(false)
      }
    },
  })
  const change = (next: MultiChargeDraft) => {
    revision.current += 1
    setFrozen(undefined)
    preview.reset()
    setDiscarding(false)
    try { storage.save(next); setState({ draft: next, failed: false }) }
    catch { setState({ draft: next, failed: true }) }
  }
  const validPreview = frozen?.signature === signature && !expired ? frozen.data : undefined
  useEffect(() => {
    if (frozen === undefined) return
    const timer = setTimeout(() => setExpired(true), Math.max(0, Date.parse(frozen.data.expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [frozen])
  const filtered = bill.charges.filter(charge => `${charge.descriptionZh} ${charge.descriptionEn} ${charge.chargeItemId}`.toLowerCase().includes(draft.filter.trim().toLowerCase()))
  const pageSize = 10
  const page = Math.min(draft.page, Math.max(1, Math.ceil(filtered.length / pageSize)))
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize)
  const toggle = (chargeItemId: string) => change({ ...draft, selectedChargeIds: draft.selectedChargeIds.includes(chargeItemId)
    ? draft.selectedChargeIds.filter(id => id !== chargeItemId) : [...draft.selectedChargeIds, chargeItemId] })
  const title = zh ? '选择多项收费' : 'Select multiple charges'
  const name = (charge: Charge) => zh ? charge.descriptionZh : charge.descriptionEn
  const rowReason = (charge: Charge) => charge.category === 'registration' ? messages.registrationReadOnly
    : charge.status === 'cancelled' ? (zh ? '已取消，按原交易退款' : 'Cancelled; refund original transaction')
      : ['ambiguous', 'payment-pending'].includes(charge.status) ? (zh ? '资金未明，请先查询原尝试' : 'Query original unknown attempt first')
        : charge.remainingFen === 0 ? (zh ? '已缴清或医保已覆盖' : 'Paid or covered by insurance')
          : available(charge) ? '' : (zh ? '当前不可收款' : 'Unavailable for collection')
  return <Dialog open={open} onOpenChange={value => {
    setOpen(value); setDiscarding(false)
    if (!value) { revision.current += 1; setFrozen(undefined); preview.reset() }
  }}>
    <DialogTrigger render={<Button aria-label={title} disabled={blocked} variant="outline" type="button" />}>{title}{draft.selectedChargeIds.length > 0 ? <Badge variant="secondary">{draft.selectedChargeIds.length}</Badge> : null}</DialogTrigger>
    <DialogContent className="max-w-6xl">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{bill.patient.name} · {bill.patient.identifier} · {bill.encounterId}</DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-4">
        <p className="text-sm text-muted-foreground">{zh ? '选择同次门诊的 2–20 项待缴费用。每项按剩余应收一次收齐；此处仅生成预览。' : 'Select 2–20 charges from this visit. Preview the full remaining balance for each charge.'}</p>
        {state.failed ? <Alert variant="destructive"><AlertTitle>{zh ? '草稿存储不可用' : 'Draft storage unavailable'}</AlertTitle><AlertDescription>
          <p>{zh ? '无法可靠保存或读取完整私稿，暂不能预览。恢复存储后重试保存，或明确丢弃草稿。' : 'Preview is blocked until the draft is saved reliably or explicitly discarded.'}</p>
          <Button onClick={() => change(draft)} variant="outline">{zh ? '重试保存草稿' : 'Retry saving draft'}</Button>
        </AlertDescription></Alert> : null}
        <FieldGroup className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field className="flex-1"><FieldLabel htmlFor={`${fieldsId}-filter`}>{zh ? '筛选费用' : 'Filter charges'}</FieldLabel>
            <Input id={`${fieldsId}-filter`} maxLength={200} value={draft.filter} onChange={event => change({ ...draft, filter: event.currentTarget.value, page: 1 })} />
          </Field>
          <Button type="button" variant="outline" onClick={onRefresh}>{messages.refreshBill}</Button>
          <Button type="button" variant="outline" disabled={new Set([...draft.selectedChargeIds, ...visible.filter(available).map(charge => charge.chargeItemId)]).size > 20}
            onClick={() => change({ ...draft, selectedChargeIds: [...new Set([...draft.selectedChargeIds, ...visible.filter(available).map(charge => charge.chargeItemId)])] })}>{zh ? '全选本页可收费项目' : 'Select collectable charges on this page'}</Button>
        </FieldGroup>
        <section aria-label={zh ? '完整费用清单' : 'Complete charge list'} className="min-w-0">
          <Table className="min-w-[48rem]">
            <TableHeader><TableRow><TableHead>{zh ? '选择 / 项目' : 'Select / charge'}</TableHead><TableHead>{zh ? '净应收' : 'Net due'}</TableHead><TableHead>{messages.paidAmount}</TableHead><TableHead>{zh ? '医保覆盖' : 'Insurance'}</TableHead><TableHead>{messages.remainingAmount}</TableHead><TableHead>{zh ? '本次金额' : 'This collection'}</TableHead></TableRow></TableHeader>
            <TableBody>{visible.map(charge => <TableRow key={charge.chargeItemId}>
              <TableCell><div className="flex items-start gap-2"><Checkbox aria-label={`${zh ? '选择收费：' : 'Select charge: '}${name(charge)}`} checked={draft.selectedChargeIds.includes(charge.chargeItemId)}
                disabled={!available(charge) || (!draft.selectedChargeIds.includes(charge.chargeItemId) && draft.selectedChargeIds.length >= 20)} onCheckedChange={() => toggle(charge.chargeItemId)} />
                <div className="flex flex-col gap-1"><span>{name(charge)}</span>{rowReason(charge) ? <span className="text-xs text-muted-foreground">{rowReason(charge)}</span> : null}</div></div></TableCell>
              <TableCell>{formatFen(charge.amountFen, locale)}</TableCell><TableCell>{formatFen(charge.paidFen, locale)}</TableCell>
              <TableCell>{formatFen(charge.insuranceFen, locale)}</TableCell><TableCell>{formatFen(charge.remainingFen, locale)}</TableCell>
              <TableCell>{draft.selectedChargeIds.includes(charge.chargeItemId) && available(charge) ? formatFen(charge.remainingFen, locale) : '—'}</TableCell>
            </TableRow>)}</TableBody>
          </Table>
          {visible.length === 0 ? <p className="py-3 text-sm">{zh ? '没有匹配的费用，待处理清单仍保留。' : 'No matching charges. Selected charges are preserved.'}</p> : null}
          <PaginationControls ariaLabel={zh ? '费用清单分页' : 'Charge pages'} messages={messages} page={page} pageSize={pageSize} total={filtered.length} onPageChange={next => change({ ...draft, page: next })} />
        </section>
        <section aria-label={zh ? '待处理清单' : 'Selected charges'} className="flex flex-col gap-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{zh ? '待处理清单' : 'Selected charges'} <Badge variant="secondary">{draft.selectedChargeIds.length}</Badge></h3>
            <Button variant="outline" size="sm" onClick={() => change({ ...draft, selectedChargeIds: [] })}>{zh ? '清空选择' : 'Clear selection'}</Button></div>
          <ul className="flex flex-col gap-2 text-sm">{selected.map(({ id, charge }) => <li key={id} className="flex items-center justify-between gap-2"><span>{charge === undefined ? id : name(charge)} {charge === undefined ? (zh ? '项目已不可用，请移除' : 'Unavailable; remove this selection') : rowReason(charge)}</span>
            <Button variant="ghost" size="sm" aria-label={`${zh ? '移除收费：' : 'Remove charge: '}${charge === undefined ? id : name(charge)}`} onClick={() => toggle(id)}>{zh ? '移除' : 'Remove'}</Button></li>)}</ul>
          <p className="font-semibold tabular-nums">{zh ? '本次合计' : 'Collection total'} {formatFen(remainingFen, locale)}</p>
          {invalid ? <p role="alert">{zh ? '所选项目已变化或不可收款，请刷新并逐项核对。' : 'Selected charges changed or are unavailable. Refresh and review them.'}</p> : null}
        </section>
        <FieldGroup className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(['cash', 'bank-card', 'mobile'] as const).map(method => <Field key={method} data-invalid={tenderError !== '' || undefined}>
            <FieldLabel htmlFor={`${fieldsId}-${method}`}>{paymentMethodLabel(method, messages)}</FieldLabel>
            <Input id={`${fieldsId}-${method}`} inputMode="decimal" maxLength={100} aria-invalid={tenderError !== '' || undefined} value={draft.tenderAmounts[method] ?? ''}
              placeholder="0.00" onChange={event => change({ ...draft, tenderAmounts: { ...draft.tenderAmounts, [method]: event.currentTarget.value } })} />
          </Field>)}
          <Field><FieldLabel htmlFor={`${fieldsId}-rule`}>{messages.paymentSimulatorRule}</FieldLabel><WorkspaceSelect id={`${fieldsId}-rule`} ariaLabel={messages.paymentSimulatorRule} value={draft.simulatorRule}
            items={[{ value: 'success', label: messages.simulatorSuccess }, { value: 'decline', label: messages.simulatorDecline }, { value: 'ambiguous', label: messages.simulatorAmbiguous }, { value: 'ambiguous-decline', label: messages.simulatorAmbiguousDecline }, { value: 'ambiguous-pending', label: messages.simulatorAmbiguousPending }]}
            onValueChange={value => { if (value !== null) change({ ...draft, simulatorRule: value as MultiChargeDraft['simulatorRule'] }) }} /></Field>
        </FieldGroup>
        <p className="text-sm text-muted-foreground">{zh ? '方式留空默认现金收齐全部所选余额；填写方式时合计须相等。' : 'Leave tenders blank for full cash collection; explicit tenders must match the total.'}</p>
        {tenderError ? <p role="alert" className="text-sm text-destructive">{tenderError}</p> : null}
        {preview.isError ? <Alert variant="destructive"><AlertTitle>{messages.operationFailed}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(preview.error, messages)}</AlertDescription></Alert> : null}
        {validPreview === undefined ? frozen !== undefined ? <p role="status">{zh ? '预览已失效，请重新预览。' : 'Preview expired or changed. Preview again.'}</p> : null : <section aria-label={zh ? '合并收费预览' : 'Combined charge preview'} className="flex flex-col gap-3 rounded-lg border p-4">
          <h3 className="font-semibold">{zh ? '合并收费预览' : 'Combined charge preview'}</h3>
          <p role="status">{zh ? '本预览尚未收款' : 'No payment has been collected'}</p>
          <Table><TableHeader><TableRow><TableHead>{messages.chargeItem}</TableHead><TableHead>{zh ? '净应收' : 'Net due'}</TableHead><TableHead>{messages.paidAmount}</TableHead><TableHead>{zh ? '医保覆盖' : 'Insurance'}</TableHead><TableHead>{messages.remainingAmount}</TableHead><TableHead>{zh ? '本次金额' : 'Collection'}</TableHead></TableRow></TableHeader>
            <TableBody>{validPreview.charges.map(charge => <TableRow key={charge.chargeItemId}><TableCell>{zh ? charge.descriptionZh : charge.descriptionEn}</TableCell><TableCell>{formatFen(charge.amountFen, locale)}</TableCell><TableCell>{formatFen(charge.paidFen, locale)}</TableCell><TableCell>{formatFen(charge.insuranceFen, locale)}</TableCell><TableCell>{formatFen(charge.remainingFen, locale)}</TableCell><TableCell>{formatFen(charge.collectionAmountFen, locale)}</TableCell></TableRow>)}</TableBody></Table>
          <p className="font-semibold">{zh ? '预览总额' : 'Preview total'} {formatFen(validPreview.amountFen, locale)}</p>
          <p className="text-sm">{validPreview.tenders.map(tender => `${paymentMethodLabel(tender.method, messages)} ${formatFen(tender.amountFen, locale)}`).join(' + ')}</p>
          <p className="text-xs text-muted-foreground">{zh ? '有效至' : 'Expires at'} {new Date(validPreview.expiresAt).toLocaleTimeString(locale)}</p>
        </section>}
        {discarding ? <Alert><AlertTitle>{zh ? '丢弃完整私稿？' : 'Discard this draft?'}</AlertTitle><AlertDescription>
          <p>{zh ? '将移除本次选择、支付方式、处理结果和筛选，不影响原资金尝试。' : 'Remove this selection, tenders, simulator and filters.'}</p>
          <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setDiscarding(false)}>{messages.cancel}</Button>
            <Button onClick={() => { revision.current += 1; setFrozen(undefined); preview.reset(); try { storage.discard(); setState({ draft: emptyMultiChargeDraft(), failed: false }); setDiscarding(false) } catch { setState(current => ({ ...current, failed: true })) } }}>{zh ? '确认丢弃草稿' : 'Confirm discard draft'}</Button></div>
        </AlertDescription></Alert> : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => setDiscarding(true)}>{zh ? '丢弃草稿' : 'Discard draft'}</Button>
        <Button disabled={blocked || state.failed || preview.isPending || draft.selectedChargeIds.length < 2 || invalid || tenderError !== ''} onClick={() => {
          try { storage.save(draft) } catch { setState(current => ({ ...current, failed: true })); return }
          setFrozen(undefined)
          preview.mutate({ input: { caseId: bill.caseId, charges: selectedCharges.map(charge => ({ chargeItemId: charge.chargeItemId, chargeVersion: charge.chargeVersion })), simulatorRule: draft.simulatorRule, tenders }, signature, revision: revision.current })
        }}>{preview.isPending ? (zh ? '正在预览…' : 'Previewing…') : (zh ? '预览合并收费' : 'Preview combined charges')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
