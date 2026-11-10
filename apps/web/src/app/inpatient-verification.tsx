import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { InpatientOrder } from '@clinmesh/contracts/inpatient-clinical'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Input } from '@clinmesh/ui/components/input'
import { useRef, useState } from 'react'
import { InpatientItemRow } from './inpatient-layout.tsx'
import { inpatientFrequencyLabel } from './inpatient-labels.ts'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { useInpatientOrderBatch, inpatientOrderBatchScope } from './inpatient-order-batch.ts'
import { formatShanghaiMinute } from './workspace-format.ts'
import { AgentReviewAnchor } from './agent-review.tsx'
import { inpatientOrderAnchor } from './inpatient-agent-tools.tsx'

export function InpatientVerification({ admission, session, locale, orders, loading, blocked, active, refresh, write }: {
  admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; orders: InpatientOrder[];
  loading: boolean; blocked: boolean; active: boolean; refresh: () => Promise<InpatientOrder[] | undefined>; write: ReturnType<typeof useInpatientWriteIntent>
}) {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const batch = useInpatientOrderBatch({ scope: inpatientOrderBatchScope(session, admission.patientId, admission.id), session, write })
  const [search, setSearch] = useState(''), [page, setPage] = useState(0), [review, setReview] = useState(false), [discard, setDiscard] = useState(false)
  const [checking, setChecking] = useState(false), [notice, setNotice] = useState('')
  const reviewFocus = useRef<HTMLButtonElement>(null)
  const current = useRef({ active, admissionId: admission.id }); current.current = { active, admissionId: admission.id }
  const guard = () => current.current.active && current.current.admissionId === admission.id
  const pending = orders.filter(order => order.state === 'signed')
  const filtered = pending.filter(order => order.display.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const pageCount = Math.max(1, Math.ceil(filtered.length / 10)), shownPage = Math.min(page, pageCount - 1)
  const visible = filtered.slice(shownPage * 10, (shownPage + 1) * 10)
  const selected = batch.rows.filter(row => row.selected)
  const unknown = batch.items.some(item => item.status === 'unknown')
  const disabled = blocked || loading || batch.blocked || checking
  const changed = (order: InpatientOrder) => !orders.some(currentOrder => currentOrder.id === order.id && currentOrder.state === 'signed'
    && currentOrder.version === order.version && currentOrder.admissionId === order.admissionId)
  const problems = selected.filter(row => changed(row.order))
  const select = (next: InpatientOrder[], checked: boolean) => {
    if (batch.select(next, checked)) setNotice('')
    else setNotice(t('待校对清单最多保留20条，请移除不需要的项目后再选择；原选择已保留。', 'Keep at most 20 verification drafts. Remove unneeded items before selecting more; existing input is retained.'))
  }
  const check = async (submit: boolean) => {
    if (disabled || !selected.length || !guard()) return
    setChecking(true)
    try {
      const fresh = await refresh()
      if (!guard()) return
      if (!fresh) { setNotice(t('医嘱读取失败，请重试；选择已保留。', 'Orders could not be loaded. Retry; selection is retained.')); return }
      if (selected.some(row => !fresh.some(order => order.id === row.id && order.state === 'signed' && order.version === row.order.version))) {
        setNotice(t('已选医嘱状态或内容已变化，请逐项重新核对或移除。', 'Selected orders changed. Review each changed item or remove it.')); return
      }
      setNotice('')
      if (!submit) { setReview(true); return }
      if (!batch.prepare(fresh)) { setNotice(t('校对清单无法保存，原输入保留；请先恢复原操作或重试。', 'The verification list could not be saved. Input is retained; recover the original operation or retry.')); return }
      setReview(false)
      void batch.start(guard)
    } finally { setChecking(false) }
  }
  const details = (order: InpatientOrder) => <>
    <span>{order.duration === 'long' ? t('长期', 'Long') : t('临时', 'Temporary')}</span>
    <span>{order.kind === 'medication' ? t('药品 · 每次 ', 'Medication · per dose ') : t('护理治疗 · 每次 ', 'Nursing care · per execution ')}{order.doseText || `${order.doseQuantity}${order.unit}`}{order.kind === 'medication' && order.doseText.replace(/\s/g, '') !== `${order.doseQuantity}${order.unit}` ? `（${order.doseQuantity}${order.unit}）` : ''}</span>
    <span>{order.kind === 'medication' ? inpatientFrequencyLabel(order.frequencyCode, locale) : t('按医嘱执行', 'As ordered')}</span>
    <span>{t('开立 ', 'Signed ')}{formatShanghaiMinute(order.signedAt)}</span>
  </>
  const successCount = batch.items.filter(item => item.status === 'success').length
  return <section aria-label={t('新医嘱校对', 'New order verification')} className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t('新医嘱校对', 'New order verification')} · {pending.length}</h3><span className="text-xs text-muted-foreground">{t('每次最多20条 · 核停另行办理', 'Up to 20 per batch · verify stops separately')}</span></div>
    {admission.recordStatus === 'archived' || admission.status !== 'admitted' ? <p role="status" className="text-sm text-muted-foreground">{admission.recordStatus === 'archived' ? t('病案已归档，不能校对新医嘱。', 'This record is archived; new orders cannot be verified.') : t('当前住院状态不允许校对新医嘱。', 'The admission state does not allow verification of new orders.')}</p> : null}
    {batch.failed ? <Alert variant="destructive"><AlertDescription>{t('待校对清单无法读取或保存，已暂停办理并保留原选择。', 'Verification drafts cannot be reliably read or saved. Writes are blocked and input is retained.')}</AlertDescription></Alert> : null}
    {notice ? <Alert role="alert"><AlertDescription>{notice}</AlertDescription></Alert> : null}
    <div className="flex flex-wrap items-center gap-2">
      <Input className="min-w-0 flex-1 basis-48" aria-label={t('搜索待校对医嘱', 'Search new orders')} value={search} onChange={event => { setSearch(event.currentTarget.value); setPage(0) }} />
      <Button variant="outline" disabled={disabled || !visible.length} onClick={() => select(visible, true)}>{t('全选当前页可校对医嘱', 'Select eligible orders on this page')}</Button>
      <Button variant="ghost" disabled={disabled || !selected.length} onClick={() => batch.deselectAll()}>{t('清空选择', 'Clear selection')}</Button>
      <span className="text-xs tabular-nums">{shownPage + 1}/{pageCount}</span>
      <Button variant="ghost" disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}>{t('上一页', 'Previous')}</Button>
      <Button variant="ghost" disabled={shownPage + 1 >= pageCount} onClick={() => setPage(shownPage + 1)}>{t('下一页', 'Next')}</Button>
    </div>
    {visible.map(order => <InpatientItemRow key={order.id} title={order.display} metadata={details(order)} badge={<Badge variant="outline">{t('待校对', 'Awaiting verification')}</Badge>}
      actions={<Checkbox aria-label={t(`选择校对：${order.display}`, `Select verification: ${order.display}`)} checked={batch.rows.some(row => row.id === order.id && row.selected)} disabled={disabled} onCheckedChange={checked => select([order], checked)} />}><AgentReviewAnchor id={inpatientOrderAnchor(admission.id, order.id)} /></InpatientItemRow>)}
    {!loading && !visible.length ? <p className="text-sm text-muted-foreground">{pending.length ? t('没有匹配的新医嘱。', 'No matching new orders.') : t('暂无待校对的新医嘱。', 'No new orders to verify.')}</p> : null}
    {batch.rows.length || batch.failed ? <section aria-label={t('待校对清单', 'Verification draft list')} className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">{t(`待校对清单 (${batch.rows.length}/20) · 已选 ${selected.length}`, `Drafts (${batch.rows.length}/20) · ${selected.length} selected`)}</h4><Button variant="ghost" disabled={batch.busy || unknown} onClick={() => setDiscard(true)}>{t('清空待校对清单', 'Discard verification drafts')}</Button></div>
      {batch.rows.map(row => <div key={row.id} className="flex min-w-0 flex-wrap items-start gap-2 rounded border p-2 text-sm">
        <Checkbox aria-label={t(`清单选择：${row.order.display}`, `Draft selection: ${row.order.display}`)} checked={row.selected} disabled={disabled} onCheckedChange={checked => select([row.order], checked)} />
        <div className="min-w-0 flex-1 basis-40"><p className="break-words font-medium">{row.order.display}</p><div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">{details(row.order)}</div>
          {changed(row.order) ? <p role="status" className="text-destructive">{t('状态或内容已变化，须重新核对或移除。', 'State or version changed. Review again or remove.')}</p> : null}</div>
        {changed(row.order) && orders.some(order => order.id === row.id && order.state === 'signed') ? <Button variant="outline" size="sm" disabled={disabled} onClick={() => select([orders.find(order => order.id === row.id)!], row.selected)}>{t(`重新核对：${row.order.display}`, `Review again: ${row.order.display}`)}</Button> : null}
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => batch.remove(row.id)}>{t(`移除：${row.order.display}`, `Remove: ${row.order.display}`)}</Button>
      </div>)}
    </section> : null}
    {batch.items.length ? <section aria-label={t('逐项校对结果', 'Verification results')} className="space-y-2 text-sm">
      <h4 className="font-semibold">{t(`逐项校对结果 · 成功 ${successCount}/${batch.items.length}`, `Verification results · ${successCount}/${batch.items.length} succeeded`)}</h4>
      {batch.items.map(item => <p key={item.idempotencyKey} className="break-words">{item.row.order.display} · {item.status === 'success' ? t('已校对，按原计划交接', 'Verified; handed off as planned') : item.status === 'failed' ? t(`校对失败：${item.error?.message ?? ''}；输入保留，请重新核对。`, `Verification failed: ${item.error?.message ?? ''}; input retained. Review again.`) : item.status === 'unknown' ? t('结果待核实', 'Outcome unconfirmed') : t('尚未发送，需重新核对后办理', 'Not sent; review again before proceeding')}</p>)}
      {unknown ? <Alert><AlertDescription><p>{t('一条校对结果待核实，已停止后续项目。恢复只核查原尝试；其余项目仍需重新核对。', 'One result is unconfirmed. Further items are paused. Recover the original attempt, then review remaining orders again.')}</p><Button variant="outline" disabled={batch.busy || checking || write.mutation.isPending || !active} onClick={() => { void batch.recover(guard) }}>{t('恢复原校对结果', 'Recover original verification')}</Button></AlertDescription></Alert> : null}
    </section> : null}
    {pending.length || batch.rows.length || batch.items.length || batch.failed ? <InpatientPrimaryAction stage="orders" priority={pending.length || batch.rows.length || unknown ? 20 : -10}><WorkspaceActionBar tone={disabled || !selected.length || problems.length ? pending.length || batch.rows.length || batch.failed ? 'blocked' : 'complete' : 'normal'}
      summary={batch.failed ? t('待校对清单暂不可用', 'Verification drafts unavailable') : pending.length || batch.rows.length ? t(`已选 ${selected.length} 条新医嘱待核对`, `${selected.length} new orders selected`) : t('本次医嘱校对已完成', 'Order verification complete')}
      reason={t('校对不代表发药、给药或健康教育完成；PRN仍需另行逐项发起。', 'Verification does not record dispensing, administration, or education. Request each PRN execution separately.')}
      action={pending.length || batch.rows.length ? <Button ref={reviewFocus} disabled={disabled || !selected.length || problems.length > 0} onClick={() => { void check(false) }}>{t(`集中核对新医嘱 (${selected.length})`, `Review new orders (${selected.length})`)}</Button> : undefined} /></InpatientPrimaryAction> : null}
    <Dialog open={review} pending={checking} onOpenChange={setReview}><DialogContent className="sm:max-w-[720px]" finalFocus={reviewFocus}>
      <DialogHeader><DialogTitle>{t('集中核对新医嘱', 'Review new orders')}</DialogTitle><DialogDescription>{t(`${admission.patientName} · 本次住院 · 已选 ${selected.length} 条，仅校对新医嘱`, `${admission.patientName} · this admission · ${selected.length} selected new orders`)}</DialogDescription></DialogHeader>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
        {notice ? <Alert role="alert"><AlertDescription>{notice}</AlertDescription></Alert> : null}
        {selected.map(row => <InpatientItemRow key={row.id} title={row.order.display} metadata={details(row.order)} badge={<Badge variant="outline">{changed(row.order) ? t('须重新核对', 'Review required') : t('待校对', 'Awaiting verification')}</Badge>} />)}
        <p className="text-xs text-muted-foreground">{t('逐项核对后确认。各条按原医嘱独立办理；已成功项保留，失败项保留输入。', 'Confirm after reviewing every item. Each order is processed independently; successes and failed input are retained.')}</p>
      </div>
      <DialogFooter><DialogClose render={<Button variant="outline" />}>{t('返回修改', 'Back')}</DialogClose><Button disabled={disabled || !selected.length || problems.length > 0} onClick={() => { void check(true) }}>{t(`确认校对 ${selected.length} 条新医嘱`, `Confirm verification of ${selected.length} orders`)}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={discard} onOpenChange={setDiscard}><DialogContent>
      <DialogHeader><DialogTitle>{t('丢弃待校对清单？', 'Discard verification drafts?')}</DialogTitle><DialogDescription>{t('将移除本次住院尚未提交的校对选择。已保存的医嘱及校对记录保留。', 'Remove unsubmitted verification selections for this admission. Saved orders and verifications remain.')}</DialogDescription></DialogHeader>
      <DialogFooter><DialogClose render={<Button variant="outline" />}>{t('保留清单', 'Keep drafts')}</DialogClose><Button disabled={batch.busy || unknown} onClick={() => { if (batch.clear()) setDiscard(false) }}>{t('确认丢弃待校对清单', 'Discard drafts')}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>
}
