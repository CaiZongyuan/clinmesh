import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { inpatientFullClinicalSchema, InpatientOrder } from '@clinmesh/contracts/inpatient-clinical'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Input } from '@clinmesh/ui/components/input'
import { useRef, useState, type ReactNode } from 'react'
import type { z } from 'zod'
import { InpatientItemRow } from './inpatient-layout.tsx'
import { inpatientFrequencyLabel } from './inpatient-labels.ts'
import { inpatientOrderBatchScope, orderBatchEligible, useInpatientOrderBatch } from './inpatient-order-batch.ts'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

type InpatientFullClinical = z.infer<typeof inpatientFullClinicalSchema>

export function InpatientStopOrders({ admission, session, locale, data, loading, active, refresh, write, renderOrder }: {
  admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; data: InpatientFullClinical;
  loading: boolean; active: boolean; refresh: () => Promise<InpatientFullClinical | undefined>;
  write: ReturnType<typeof useInpatientWriteIntent>; renderOrder: (order: InpatientOrder, selection: ReactNode) => ReactNode
}) {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const doctor = session.actor.roleCode === 'inpatient-doctor', allowedRole = doctor || session.actor.roleCode === 'ward-nurse'
  const action = doctor ? 'request-stop' : 'verify-stop'
  const batch = useInpatientOrderBatch({ scope: inpatientOrderBatchScope(session, admission.patientId, admission.id, action), session, write })
  const [search, setSearch] = useState(''), [page, setPage] = useState(0), [review, setReview] = useState(false), [discard, setDiscard] = useState(false)
  const [checking, setChecking] = useState(false), [notice, setNotice] = useState('')
  const reviewFocus = useRef<HTMLButtonElement>(null)
  const reviewedExecutions = useRef<string | null>(null)
  const current = useRef({ active, admission }); current.current = { active, admission }
  const unavailable = admission.recordStatus === 'archived' ? t('病案已归档，不能办理停嘱。', 'This record is archived; stops are unavailable.')
    : admission.financialStatus !== 'open' ? t('费用已封账，不能办理停嘱。', 'The account is closed; stops are unavailable.')
      : !['admitted', 'discharge-pending'].includes(admission.status) ? t('当前住院状态不允许办理停嘱。', 'The admission state does not allow stops.')
        : !allowedRole ? t('当前岗位无停嘱办理权限。', 'The current role cannot process stops.') : ''
  const guard = () => current.current.active && current.current.admission.id === admission.id
    && current.current.admission.recordStatus !== 'archived' && current.current.admission.financialStatus === 'open'
    && ['admitted', 'discharge-pending'].includes(current.current.admission.status) && allowedRole
  const orders = data.orders.filter(order => doctor || order.state !== 'signed')
  const filtered = orders.filter(order => order.display.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const pageCount = Math.max(1, Math.ceil(filtered.length / 10)), shownPage = Math.min(page, pageCount - 1), visible = filtered.slice(shownPage * 10, (shownPage + 1) * 10)
  const eligible = visible.filter(order => orderBatchEligible(order, action)), pending = orders.filter(order => orderBatchEligible(order, action))
  const selected = batch.rows.filter(row => row.selected), unknown = batch.items.some(item => item.status === 'unknown')
  const disabled = Boolean(unavailable) || loading || !active || batch.blocked || checking
  const changed = (order: InpatientOrder, fresh = data.orders) => !fresh.some(next => next.id === order.id && next.version === order.version
    && next.admissionId === order.admissionId && orderBatchEligible(next, action) && next.stopReason === order.stopReason)
  const problems = selected.some(row => changed(row.order))
  const missingReason = doctor && selected.some(row => !(row.reasonOverride ?? batch.commonReason).trim())
  const title = doctor ? t('集中申请停嘱', 'Review stop requests') : t('集中核对停嘱', 'Review stop verifications')
  const draftTitle = doctor ? t('待停嘱清单', 'Stop request drafts') : t('待核停清单', 'Stop verification drafts')
  const select = (next: InpatientOrder[], checked: boolean) => {
    setNotice(batch.select(next, checked) ? '' : t('每次最多保留20条停嘱待办，请先移除不需要的项目；原输入已保留。', 'Keep at most 20 stop drafts. Remove unneeded items; input is retained.'))
  }
  const executionSignature = (fresh: InpatientFullClinical) => JSON.stringify(fresh.executions
    .filter(execution => selected.some(row => row.id === execution.orderId))
    .map(execution => ({ id: execution.id, status: execution.status, version: execution.version }))
    .sort((left, right) => left.id.localeCompare(right.id)))
  const check = async (submit: boolean) => {
    if (disabled || !selected.length || missingReason || !guard()) return
    setChecking(true)
    try {
      const fresh = await refresh()
      if (!guard()) return
      if (!fresh) { setNotice(t('医嘱读取失败，请重试；原输入已保留。', 'Orders could not be loaded. Retry; input is retained.')); return }
      if (selected.some(row => changed(row.order, fresh.orders))) { setNotice(t('医嘱内容或停嘱理由已变化，请逐项重新核对或移除。', 'Order contents or stop reason changed. Review each item again or remove it.')); return }
      if (submit && reviewedExecutions.current !== executionSignature(fresh)) {
        setReview(false)
        setNotice(t('执行任务已变化，请重新审阅停嘱影响后确认；原输入已保留。', 'Execution tasks changed. Review the stop impacts again before confirming; input is retained.'))
        return
      }
      setNotice('')
      if (!submit) { reviewedExecutions.current = executionSignature(fresh); setReview(true); return }
      if (!batch.prepare(fresh.orders)) { setNotice(t('停嘱清单无法保存，原输入已保留；请先恢复原操作或重试。', 'The stop list could not be saved. Input is retained; recover the original attempt or retry.')); return }
      setReview(false); void batch.start(guard)
    } finally { setChecking(false) }
  }
  const details = (order: InpatientOrder) => <><span>{order.duration === 'long' ? t('长期', 'Long') : t('临时', 'Temporary')}</span><span>{t('每次 ', 'Per execution ')}{order.doseText || `${order.doseQuantity}${order.unit}`}</span><span>{inpatientFrequencyLabel(order.frequencyCode, locale)}</span></>
  const impact = (order: InpatientOrder) => {
    const executions = data.executions.filter(execution => execution.orderId === order.id)
    return <p className="text-xs text-muted-foreground">{t(`核停后：待执行 ${executions.filter(execution => execution.status === 'pending').length} 次、已发药待给药 ${executions.filter(execution => execution.status === 'dispensed').length} 次执行任务将取消；既有发药和给药记录保留，库存及费用不自动退回。`, `After verification: ${executions.filter(execution => execution.status === 'pending').length} pending and ${executions.filter(execution => execution.status === 'dispensed').length} dispensed execution tasks cancel. Existing dispensing and administration records remain; stock and charges are not automatically reversed.`)}</p>
  }
  return <section aria-label={t('住院医嘱', 'Inpatient orders')} className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-semibold">{t('住院医嘱', 'Inpatient orders')} · {orders.length}</h3><span className="text-xs text-muted-foreground">{doctor ? t('批量申请停嘱 · 每次最多20条', 'Stop requests · up to 20') : t('批量核对停嘱 · 与新医嘱校对分开', 'Verify stops separately from new orders')}</span></div>
    {unavailable ? <p role="status" className="text-sm text-muted-foreground">{unavailable}</p> : null}
    {batch.failed ? <Alert variant="destructive"><AlertDescription>{t('停嘱待办无法读取或保存，请先恢复原操作；原输入已保留。', 'Stop drafts cannot be reliably read or saved. Writes are blocked and input is retained.')}</AlertDescription></Alert> : null}
    {notice ? <Alert role="alert"><AlertDescription>{notice}</AlertDescription></Alert> : null}
    <div className="flex flex-wrap items-center gap-2">
      <Input className="min-w-0 flex-1 basis-48" aria-label={t('搜索住院医嘱', 'Search inpatient orders')} value={search} onChange={event => { setSearch(event.currentTarget.value); setPage(0) }} />
      <Button variant="outline" disabled={disabled || !eligible.length} onClick={() => select(eligible, true)}>{doctor ? t('全选当前页可停嘱医嘱', 'Select eligible stop requests on this page') : t('全选当前页可核停医嘱', 'Select eligible stop verifications on this page')}</Button>
      <Button variant="ghost" disabled={disabled || !selected.length} onClick={() => batch.deselectAll()}>{t('清空选择', 'Clear selection')}</Button>
      <span className="text-xs tabular-nums">{shownPage + 1}/{pageCount}</span><Button variant="ghost" disabled={!shownPage} onClick={() => setPage(shownPage - 1)}>{t('上一页', 'Previous')}</Button><Button variant="ghost" disabled={shownPage + 1 >= pageCount} onClick={() => setPage(shownPage + 1)}>{t('下一页', 'Next')}</Button>
    </div>
    {visible.map(order => renderOrder(order, <div className="flex items-center gap-2">{orderBatchEligible(order, action) ? <Checkbox aria-label={doctor ? t(`选择停嘱：${order.display}`, `Select stop: ${order.display}`) : t(`选择核停：${order.display}`, `Select stop verification: ${order.display}`)} checked={batch.rows.some(row => row.id === order.id && row.selected)} disabled={disabled} onCheckedChange={checked => select([order], checked)} /> : <span className="text-xs text-muted-foreground">{doctor ? t('当前状态不可申请停嘱', 'State does not allow a stop request') : t('仅待停嘱核对状态可核停', 'Only requested stops can be verified')}</span>}</div>))}
    {!loading && !visible.length ? <p className="text-sm text-muted-foreground">{t('暂无匹配医嘱。', 'No matching orders.')}</p> : null}
    {batch.rows.length || doctor && batch.commonReason ? <section aria-label={draftTitle} className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap justify-between gap-2"><h4 className="text-sm font-semibold">{draftTitle} ({batch.rows.length}/20) · {t(`已选 ${selected.length}`, `${selected.length} selected`)}</h4><Button variant="ghost" disabled={batch.busy || unknown} onClick={() => setDiscard(true)}>{t('丢弃停嘱待办', 'Discard stop drafts')}</Button></div>
      {doctor ? <label className="space-y-1 text-sm"><span>{t('共同停嘱理由', 'Common stop reason')}</span><Input aria-label={t('共同停嘱理由', 'Common stop reason')} disabled={disabled} maxLength={2000} value={batch.commonReason} onChange={event => batch.setCommonReason(event.currentTarget.value)} /></label> : null}
      {batch.rows.map(row => <div key={row.id} className="flex min-w-0 flex-wrap gap-2 rounded border p-2 text-sm">
        <Checkbox aria-label={t(`清单选择：${row.order.display}`, `Draft selection: ${row.order.display}`)} disabled={disabled} checked={row.selected} onCheckedChange={checked => select([row.order], checked)} />
        <div className="min-w-0 flex-1 basis-48"><p className="break-words font-medium">{row.order.display}</p><div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">{details(row.order)}</div>
          {doctor ? <div className="mt-2 space-y-1">{row.reasonOverride === undefined ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => batch.setReasonOverride(row.id, '')}>{t(`单独填写理由：${row.order.display}`, `Set individual reason: ${row.order.display}`)}</Button> : <><Input aria-label={t(`单项停嘱理由：${row.order.display}`, `Individual stop reason: ${row.order.display}`)} maxLength={2000} disabled={disabled} value={row.reasonOverride} onChange={event => batch.setReasonOverride(row.id, event.currentTarget.value)} /><Button size="sm" variant="ghost" disabled={disabled} onClick={() => batch.setReasonOverride(row.id, undefined)}>{t(`使用共同理由：${row.order.display}`, `Use common reason: ${row.order.display}`)}</Button></>}
            <p className={(row.reasonOverride ?? batch.commonReason).trim() ? 'break-words text-muted-foreground' : 'text-destructive'}>{t('最终停嘱理由：', 'Final stop reason: ')}{(row.reasonOverride ?? batch.commonReason).trim() || t('缺少理由，请填写或删除空的单项覆盖。', 'Missing reason. Enter one or remove the empty override.')}</p></div>
            : <><p className="break-words">{t('正式停嘱理由：', 'Formal stop reason: ')}{row.order.stopReason || t('历史医嘱缺少停嘱理由', 'Legacy stop reason missing')}</p>{impact(row.order)}</>}
          {changed(row.order) ? <p role="status" className="text-destructive">{t('内容或停嘱理由已变化，须重新核对或移除。', 'Contents or stop reason changed. Review again or remove.')}</p> : null}
        </div>
        {changed(row.order) && data.orders.some(order => order.id === row.id && orderBatchEligible(order, action)) ? <Button variant="outline" size="sm" disabled={disabled} onClick={() => select([data.orders.find(order => order.id === row.id)!], row.selected)}>{t(`重新核对：${row.order.display}`, `Review again: ${row.order.display}`)}</Button> : null}
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => batch.remove(row.id)}>{t(`移除：${row.order.display}`, `Remove: ${row.order.display}`)}</Button>
      </div>)}
    </section> : null}
    {batch.items.length ? <section aria-label={doctor ? t('逐项停嘱申请结果', 'Stop request results') : t('逐项停嘱核对结果', 'Stop verification results')} className="space-y-2 text-sm">
      <h4 className="font-semibold">{t(`逐项结果 · 成功 ${batch.items.filter(item => item.status === 'success').length}/${batch.items.length}`, `Results · ${batch.items.filter(item => item.status === 'success').length}/${batch.items.length} succeeded`)}</h4>
      {batch.items.map(item => <p key={item.idempotencyKey} className="break-words">{item.row.order.display} · {item.status === 'success' ? doctor ? t('已申请停嘱，待护士核对', 'Stop requested; awaiting nurse verification') : t('已核停', 'Stop verified') : item.status === 'failed' ? t(`办理失败：${item.error?.message ?? ''}；输入已保留，请重新核对。`, `Failed: ${item.error?.message ?? ''}; input retained. Review again.`) : item.status === 'unknown' ? t('结果待核实', 'Outcome unconfirmed') : t('尚未发送，需重新核对后办理', 'Not sent; review again before proceeding')}</p>)}
      {unknown ? <Alert><AlertDescription><p>{t('一条结果待核实，已停止后续项目。恢复只核查原尝试；其余项目仍需重新核对。', 'One result is unconfirmed; further items are paused. Recover the original attempt, then review remaining items again.')}</p><Button variant="outline" disabled={batch.busy || checking || write.mutation.isPending || !guard()} onClick={() => { void batch.recover(guard) }}>{doctor ? t('恢复原停嘱申请', 'Recover original stop request') : t('恢复原停嘱核对', 'Recover original stop verification')}</Button></AlertDescription></Alert> : null}
    </section> : null}
    {allowedRole ? <InpatientPrimaryAction stage="orders" priority={selected.length || unknown ? 25 : !doctor && pending.length ? 10 : -20}><WorkspaceActionBar tone={disabled || !selected.length || problems || missingReason ? 'blocked' : 'normal'} summary={t(`已选 ${selected.length} 条${doctor ? '停嘱申请' : '停嘱核对'}`, `${selected.length} stops selected`)} reason={unavailable || (missingReason ? t('还差：逐项停嘱理由', 'Complete each stop reason') : problems ? t('还差：重新核对变化医嘱', 'Review changed orders again') : doctor ? t('申请后暂停后续任务、发药和给药，护士核对后停嘱生效。', 'The request pauses further tasks, dispensing, and administration; nurse verification completes the stop.') : t('待执行及已发药待给药任务取消，既有发药记录和费用保留。', 'Pending and dispensed tasks cancel; existing dispensing records and charges remain.'))} action={<Button ref={reviewFocus} disabled={disabled || !selected.length || problems || missingReason} onClick={() => { void check(false) }}>{title} ({selected.length})</Button>} /></InpatientPrimaryAction> : null}
    <Dialog open={review} onOpenChange={setReview}><DialogContent className="sm:max-w-[720px]" finalFocus={reviewFocus}>
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{admission.patientName} · {t(`本次住院 · 已选 ${selected.length} 条`, `This admission · ${selected.length} selected`)}</DialogDescription></DialogHeader>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">{notice ? <Alert role="alert"><AlertDescription>{notice}</AlertDescription></Alert> : null}
        {selected.map(row => <InpatientItemRow key={row.id} title={row.order.display} metadata={details(row.order)} badge={<Badge variant="outline">{row.order.state === 'stop-requested' ? t('待停嘱核对', 'Stop requested') : row.order.state === 'signed' ? t('待校对', 'Signed') : t('已校对', 'Verified')}</Badge>}><p className="break-words text-sm">{doctor ? t('最终停嘱理由：', 'Final stop reason: ') : t('正式停嘱理由：', 'Formal stop reason: ')}{doctor ? (row.reasonOverride ?? batch.commonReason).trim() : row.order.stopReason || t('历史医嘱缺少停嘱理由', 'Legacy stop reason missing')}</p>{impact(row.order)}</InpatientItemRow>)}
        <p className="text-xs text-muted-foreground">{t('逐项核对后确认。各条独立办理；已成功项保留，失败项保留输入。', 'Confirm after reviewing each item. Each order is processed independently; successes and failed input are retained.')}</p>
      </div>
      <DialogFooter><Button variant="outline" onClick={() => setReview(false)}>{t('返回修改', 'Back')}</Button><Button disabled={disabled || !selected.length || problems || missingReason} onClick={() => { void check(true) }}>{doctor ? t(`确认申请 ${selected.length} 条停嘱`, `Confirm ${selected.length} stop requests`) : t(`确认核对 ${selected.length} 条停嘱`, `Confirm ${selected.length} stop verifications`)}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={discard} onOpenChange={setDiscard}><DialogContent><DialogHeader><DialogTitle>{t('丢弃停嘱待办？', 'Discard stop drafts?')}</DialogTitle><DialogDescription>{t('将移除当前动作未提交的选择、共同理由和单项理由。已保存的停嘱记录保留。', 'Remove unsubmitted selections, common reason, and individual reasons for this action. Saved stop records remain.')}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDiscard(false)}>{t('保留待办', 'Keep drafts')}</Button><Button disabled={batch.busy || unknown} onClick={() => { if (batch.clear()) setDiscard(false) }}>{t('确认丢弃停嘱待办', 'Discard stop drafts')}</Button></DialogFooter></DialogContent></Dialog>
  </section>
}
