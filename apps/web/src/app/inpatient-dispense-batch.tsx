import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { WorkspaceSelect } from './workspace-select.tsx'
import { Input } from '@clinmesh/ui/components/input'
import { useId, useRef, useState, type ReactNode } from 'react'
import { canReviewDispense, dispenseEntries, dispenseScope, dispenseSnapshot, sameDispenseSnapshot, useDispenseDrafts, type DispenseSnapshot, type PharmacyFacts } from './inpatient-dispense-drafts.ts'
import { inpatientFrequencyLabel } from './inpatient-labels.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import { formatShanghaiMinute } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { getBatchFailureMessage } from './workspace-error.ts'

export function InpatientDispenseBatch({ data, session, locale, loading, refresh, write, virtualNow, completionAction, children }: {
  data: PharmacyFacts; session: SessionContext; locale: WorkspaceLocale; loading: boolean;
  refresh: () => Promise<PharmacyFacts | undefined>; write: ReturnType<typeof useInpatientWriteIntent>; virtualNow: number | undefined;
  completionAction?: ReactNode; children: (parts: { content: ReactNode; action: ReactNode }) => ReactNode;
}) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const id = useId()
  const scope = dispenseScope(session, data)
  const batch = useDispenseDrafts({ scope, session, write, refresh })
  const [search, setSearch] = useState(''), [page, setPage] = useState(0), [lotIds, setLotIds] = useState<Record<string, string>>({})
  const [review, setReview] = useState<DispenseSnapshot[] | null>(null), [discard, setDiscard] = useState(false), [checking, setChecking] = useState(false), [notice, setNotice] = useState('')
  const entries = dispenseEntries(data), selected = batch.rows.filter(row => row.selected), unknown = batch.items.some(item => item.status === 'unknown')
  const disabled = batch.blocked || loading || checking || data.admission.status !== 'admitted'
  const current = useRef({ scope, session, selected }); current.current = { scope, session, selected }
  const guard = () => current.current.scope.admissionId === scope.admissionId && current.current.scope.patientId === scope.patientId
    && current.current.session.user.id === session.user.id && JSON.stringify(current.current.session.actor) === JSON.stringify(session.actor)
  const lotFor = (entry: typeof entries[number]) => {
    const selectedLot = lotIds[entry.execution.id] ?? batch.rows.find(row => row.snapshot.execution.id === entry.execution.id)?.snapshot.lot.id
    return selectedLot ? entry.lots.find(lot => lot.id === selectedLot) : entry.lots[0]
  }
  const reason = (entry: typeof entries[number]) => entry.unavailable ? entry.execution.status !== 'pending' ? t('已发药或执行结束，不能重复发药。', 'Already dispensed or finished.')
    : t('当前医嘱或住院状态不能发药。', 'The current order or admission cannot be dispensed.')
    : !lotFor(entry) || lotFor(entry)!.quantityOnHand < entry.order.doseQuantity ? t('本批次库存不足，请核对其他批次。', 'Insufficient stock in this lot.') : ''
  const filtered = entries.filter(entry => `${entry.order.display} ${formatShanghaiMinute(entry.execution.scheduledFor)}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const pageCount = Math.max(1, Math.ceil(filtered.length / 10)), shownPage = Math.min(page, pageCount - 1), visible = filtered.slice(shownPage * 10, shownPage * 10 + 10)
  const select = (snapshots: DispenseSnapshot[], checked: boolean) => {
    if (!batch.select(snapshots, checked)) setNotice(t('最多保留20条发药待处理清单；请先移除不需要的项目。原输入已保留。', 'Keep at most 20 dispensing drafts; remove an item first. Inputs are retained.'))
    else setNotice('')
  }
  const lotLabel = (snapshot: DispenseSnapshot) => {
    const index = entries.find(entry => entry.execution.id === snapshot.execution.id)?.lots.findIndex(lot => lot.id === snapshot.lot.id) ?? -1
    return index < 0 ? t('原核对库存批次', 'Reviewed inventory lot') : t(`库存批次 ${index + 1}`, `Stock lot ${index + 1}`)
  }
  const details = (snapshot: DispenseSnapshot) => <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
    <span>{snapshot.order.doseText} · {snapshot.order.doseQuantity}{snapshot.order.unit} · {inpatientFrequencyLabel(snapshot.order.frequencyCode, locale, false)}</span>
    <span>{t('执行时点：', 'Scheduled: ')}{formatShanghaiMinute(snapshot.execution.scheduledFor)}</span>
    <span>{lotLabel(snapshot)} · {t('库存 ', 'Stock ')}{snapshot.lot.quantityOnHand}{snapshot.order.unit} · {t('有效期 ', 'Expires ')}{snapshot.lot.expiresOn}</span>
    {virtualNow !== undefined && Date.parse(snapshot.lot.expiresOn) - virtualNow <= 30 * 86_400_000 ? <span>{t('临期批次', 'Near expiry')}</span> : null}
  </div>
  const confirm = async () => {
    if (disabled || !review || !guard()) return
    setChecking(true); setNotice('')
    try {
      const fresh = await refresh()
      if (!guard()) return
      if (!fresh || review.length !== current.current.selected.length || review.some(snapshot => !canReviewDispense(snapshot, fresh)
        || !current.current.selected.some(row => sameDispenseSnapshot(row.snapshot, snapshot))) || !batch.prepare(fresh)) {
        setNotice(t('医嘱、执行单、过敏或库存已变化，或所选总量超过同批库存；请返回逐项更新核对，本次未发送。', 'Orders, executions, allergies or stock changed, or total quantity exceeds the lot. Return to review; nothing was sent.'))
        return
      }
      setReview(null); void batch.start(guard)
    } catch { setNotice(t('最新发药信息读取失败，请重试；原输入已保留。', 'Current dispensing information could not be loaded. Inputs are retained.')) }
    finally { setChecking(false) }
  }
  const complete = !batch.busy && !batch.rows.length && batch.items.length > 0 && batch.items.every(item => item.status === 'success')
  const action = complete ? <WorkspaceActionBar tone="complete" summary={<span role="status">{t('已完成发药', 'Dispensing completed')}</span>}
    reason={t('已发药记录保留，由病区护士按时给药。', 'Dispensing records remain; the ward nurse administers as scheduled.')} action={completionAction} />
    : <WorkspaceActionBar tone={disabled || !selected.length ? 'blocked' : 'normal'} summary={t(`已选 ${selected.length} 条发药执行单`, `${selected.length} executions selected`)}
    reason={unknown ? t('先恢复原发药，余项重新核对；发药不等于已给药。', 'Recover original dispensing, then review remaining items. Dispensing does not record administration.') : t('逐单核对药品、批次、完整数量和执行时点；仅办理当前患者。', 'Check each medication, lot, full quantity and scheduled time for this patient.')}
    action={unknown ? <Button disabled={batch.busy || batch.failed || !guard()} onClick={() => { void batch.recover(guard) }}>{t('恢复原发药', 'Recover original dispensing')}</Button>
      : <Button disabled={disabled || !selected.length} onClick={() => { setNotice(''); setReview(selected.map(row => row.snapshot)) }}>{t('集中发药', 'Review dispensing')}</Button>} />
  const content = <section aria-label={t('同患者集中发药', 'Patient dispensing')} className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t('本次住院执行单', 'Admission executions')} · {entries.length}</h3><span className="text-xs text-muted-foreground">{t('每次最多20条 · 每单发足既定数量，发药后由护士给药', 'Up to 20 · Dispense each full dose; the nurse administers later')}</span></div>
    {batch.failed ? <Alert variant="destructive"><AlertDescription>{t('发药待处理清单无法可靠读取或保存，已阻止发送；请先核查原操作。', 'Draft storage is unavailable. Resolve the original attempt before dispensing.')}</AlertDescription></Alert> : null}
    {notice && !review ? <Alert><AlertDescription>{notice}</AlertDescription></Alert> : null}
    <div className="flex flex-wrap items-center gap-2"><Input className="min-w-0 flex-1 basis-48" aria-label={t('搜索发药执行单', 'Search dispensing executions')} value={search} onChange={event => { setSearch(event.currentTarget.value); setPage(0) }} />
      <Button variant="outline" disabled={disabled || !visible.some(entry => !reason(entry))} onClick={() => select(visible.filter(entry => !reason(entry)).map(entry => dispenseSnapshot(entry, lotFor(entry)!, data)), true)}>{t('全选本页可发药执行单', 'Select eligible executions on this page')}</Button>
      <Button variant="ghost" disabled={disabled || !selected.length} onClick={() => batch.deselectAll()}>{t('清空选择', 'Clear selection')}</Button>
      <span className="text-xs">{shownPage + 1}/{pageCount}</span><Button variant="ghost" disabled={!shownPage} onClick={() => setPage(shownPage - 1)}>{t('上一页', 'Previous')}</Button><Button variant="ghost" disabled={shownPage + 1 >= pageCount} onClick={() => setPage(shownPage + 1)}>{t('下一页', 'Next')}</Button>
    </div>
    {visible.map(entry => { const lot = lotFor(entry), snapshot = lot ? dispenseSnapshot(entry, lot, data) : undefined; return <article key={entry.execution.id} className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2"><label className="flex min-w-0 items-start gap-2"><Checkbox aria-label={t(`选择发药：${entry.order.display} · ${formatShanghaiMinute(entry.execution.scheduledFor)}`, `Select dispensing: ${entry.order.display} · ${formatShanghaiMinute(entry.execution.scheduledFor)}`)} checked={batch.rows.some(row => row.snapshot.execution.id === entry.execution.id && row.selected)} disabled={disabled || !!reason(entry)} onCheckedChange={checked => { if (snapshot) select([snapshot], checked) }} /><strong className="min-w-0 break-words text-sm">{entry.order.display}</strong></label><Badge variant="outline">{entry.execution.status === 'pending' ? t('待发药', 'Awaiting dispensing') : t('已发药或执行结束', 'Dispensed or finished')}</Badge></div>
      {snapshot ? details(snapshot) : <p className="text-xs">{t('暂无可用库存批次', 'No usable stock lot')}</p>}
      {!entry.unavailable ? <WorkspaceSelect id={`${id}-${entry.execution.id}`} ariaLabel={t(`发药批次：${entry.order.display} · ${formatShanghaiMinute(entry.execution.scheduledFor)}`, `Stock lot: ${entry.order.display} · ${formatShanghaiMinute(entry.execution.scheduledFor)}`)} value={lot?.id ?? null} disabled={disabled} items={entry.lots.map((lot, index) => ({ value: lot.id, label: `${t('库存批次', 'Stock lot')} ${index + 1} · ${lot.quantityOnHand}${entry.order.unit} · ${lot.expiresOn}` }))} onValueChange={id => {
        if (!id) return; setLotIds(current => ({ ...current, [entry.execution.id]: id })); const lot = entry.lots.find(lot => lot.id === id)
        const row = batch.rows.find(row => row.snapshot.execution.id === entry.execution.id)
        if (lot && row) select([dispenseSnapshot(entry, lot, data)], row.selected)
      }} /> : null}
      {reason(entry) ? <p className="text-xs text-muted-foreground">{reason(entry)}</p> : null}
    </article> })}
    {!entries.length ? <p>{t('没有当前执行单；长期药嘱等待下次排程。', 'No executions; long orders await their next schedule.')}</p> : !visible.length ? <p>{t('没有匹配的执行单。', 'No matching executions.')}</p> : null}
    {batch.rows.length || batch.failed ? <section aria-label={t('发药待处理清单', 'Dispensing drafts')} className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">{t(`发药待处理清单（${batch.rows.length}/20）· 已选 ${selected.length} 条`, `Dispensing drafts (${batch.rows.length}/20) · ${selected.length} selected`)}</h4><Button variant="ghost" disabled={batch.busy || unknown || write.blocked} onClick={() => setDiscard(true)}>{t('丢弃发药待处理清单', 'Discard dispensing drafts')}</Button></div>
      {batch.rows.map(row => { const entry = entries.find(entry => entry.execution.id === row.snapshot.execution.id), lot = entry?.lots.find(lot => lot.id === row.snapshot.lot.id), changed = !canReviewDispense(row.snapshot, data); return <article key={row.snapshot.execution.id} className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
        <div className="flex flex-wrap items-start justify-between gap-2"><label className="flex min-w-0 items-start gap-2"><Checkbox aria-label={t(`待发药选择：${row.snapshot.order.display} · ${formatShanghaiMinute(row.snapshot.execution.scheduledFor)}`, `Draft selection: ${row.snapshot.order.display}`)} checked={row.selected} disabled={disabled} onCheckedChange={checked => select([row.snapshot], checked)} /><strong className="min-w-0 break-words text-sm">{row.snapshot.order.display}</strong></label><Button variant="ghost" disabled={disabled} onClick={() => batch.remove(row.snapshot.execution.id)}>{t(`移除：${row.snapshot.order.display} · ${formatShanghaiMinute(row.snapshot.execution.scheduledFor)}`, `Remove: ${row.snapshot.order.display}`)}</Button></div>
        {details(row.snapshot)}<p className="text-xs text-muted-foreground">{t('发药前核对快照；当前进度以逐项结果和正式记录为准。', 'Pre-dispensing review snapshot. See item outcomes and formal records for progress.')}</p>
        {changed ? <p role="status" className="text-sm text-destructive">{t('医嘱、执行单、过敏或库存已变化，请更新核对；已发药项不可重复办理。', 'Orders, execution, allergies or stock changed. Review again; completed dispensing cannot repeat.')}</p> : null}
        {changed && entry && !entry.unavailable && lot ? <Button variant="outline" disabled={disabled} onClick={() => select([dispenseSnapshot(entry, lot, data)], row.selected)}>{t(`更新核对：${row.snapshot.order.display} · ${formatShanghaiMinute(row.snapshot.execution.scheduledFor)}`, `Review current execution: ${row.snapshot.order.display}`)}</Button> : null}
      </article> })}
    </section> : null}
    {batch.items.length ? <section aria-label={t('发药逐项结果', 'Dispensing outcomes')} className="flex flex-col gap-2 text-sm"><h4 className="font-semibold">{t(`逐项发药结果 · 成功 ${batch.items.filter(item => item.status === 'success').length}/${batch.items.length}`, `Dispensing outcomes · ${batch.items.filter(item => item.status === 'success').length}/${batch.items.length} succeeded`)}</h4>{batch.items.map(item => <p key={item.row.revision} className="break-words">{item.row.snapshot.order.display} · {formatShanghaiMinute(item.row.snapshot.execution.scheduledFor)}：{item.status === 'success' ? t('已发药，待护士给药', 'Dispensed; awaiting nurse administration') : item.status === 'unknown' ? t('结果待确认，请恢复原发药；后续未发送。', 'Result unknown; recover original dispensing. Later items are paused.') : item.status === 'failed' ? t(`发药失败：${getBatchFailureMessage(item.error, locale)}；输入已保留。`, `Dispensing failed: ${getBatchFailureMessage(item.error, locale)}; input retained.`) : t('尚未发送，请重新核对。', 'Not sent; review again.')}</p>)}</section> : null}
    <Dialog open={review !== null} pending={checking} onOpenChange={open => { if (!open) setReview(null) }}><DialogContent className="sm:max-w-[720px]"><DialogHeader><DialogTitle>{t('集中发药核对', 'Review dispensing')}</DialogTitle><DialogDescription>{data.admission.patientName} · {t(`本次住院 · 已选 ${review?.length ?? 0} 条`, `Current admission · ${review?.length ?? 0} selected`)}</DialogDescription></DialogHeader>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">{notice ? <Alert variant="destructive"><AlertDescription>{notice}</AlertDescription></Alert> : null}{review?.map(snapshot => <article key={snapshot.execution.id} className="flex min-w-0 flex-col gap-2 rounded-md border p-3"><strong className="break-words text-sm">{snapshot.order.display}</strong>{details(snapshot)}<Badge variant="outline">{t('待发药', 'Awaiting dispensing')}</Badge></article>)}<p className="text-xs text-muted-foreground">{t('逐单独立发药并记录库存与费用。成功项保留，结果不明时停止后续；不生成给药记录。', 'Each execution records its stock movement and charge. Successful items remain complete; unknown outcomes pause later items. Administration is separate.')}</p></div>
      <DialogFooter><DialogClose render={<Button variant="outline" />}>{t('返回修改', 'Back')}</DialogClose><Button disabled={disabled} onClick={() => { void confirm() }}>{t('确认发药', 'Confirm dispensing')}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={discard} onOpenChange={setDiscard}><DialogContent><DialogHeader><DialogTitle>{t('丢弃发药待处理清单', 'Discard dispensing drafts')}</DialogTitle><DialogDescription>{t('仅丢弃本患者本次住院的未发送选择和结果展示，不撤销已发药记录、库存变化或费用。', 'Discard only this admission’s draft choices and outcome display. Completed dispensing, stock movements and charges remain.')}</DialogDescription></DialogHeader><DialogFooter><DialogClose render={<Button variant="outline" />}>{t('保留待处理清单', 'Keep drafts')}</DialogClose><Button disabled={batch.busy || unknown || write.blocked} onClick={() => { if (batch.clear()) setDiscard(false) }}>{t('确认丢弃', 'Confirm discard')}</Button></DialogFooter></DialogContent></Dialog>
  </section>
  return children({ content, action })
}
