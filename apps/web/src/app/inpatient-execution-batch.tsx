import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Input } from '@clinmesh/ui/components/input'
import { useRef, useState } from 'react'
import type { z } from 'zod'
import { ApiClientError } from './api-client.ts'
import { executionDraftScope, sameExecutionDraft, useExecutionDrafts, type ExecutionAction, type ExecutionDraft } from './inpatient-execution-drafts.ts'
import { inpatientFrequencyLabel } from './inpatient-labels.ts'
import { formatShanghaiMinute } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

type Clinical = z.infer<typeof inpatientFullClinicalSchema>
type Candidate = Pick<ExecutionDraft, 'id' | 'order' | 'execution'>
type Facts = { data: Clinical; virtualTime: string }
function candidates(data: Clinical, action: ExecutionAction): Candidate[] {
  return action === 'request-prn' ? data.orders.filter(order => order.frequencyCode === 'PRN').map(order => ({ id: order.id, order }))
    : data.executions.flatMap(execution => {
      const order = data.orders.find(order => order.id === execution.orderId)
      return order?.kind === (action === 'administer' ? 'medication' : 'service') && execution.status !== 'completed' && execution.status !== 'cancelled' ? [{ id: execution.id, order, execution }] : []
    })
}
function unavailable(row: Candidate, facts: Facts, action: ExecutionAction, zh: boolean): string | undefined {
  const t = (cn: string, en: string) => zh ? cn : en
  if (row.order.state !== 'verified') return t('医嘱尚未校对、已申请停止或已结束。', 'The order is unverified, stopping, or finished.')
  if (action === 'request-prn') {
    const executions = facts.data.executions.filter(execution => execution.orderId === row.order.id)
    if (row.order.duration === 'temporary' && executions.length > 0 || executions.some(execution => Date.parse(execution.scheduledFor) === Date.parse(facts.virtualTime))) return t('当前时点已发起，或临时 PRN 已有执行任务。', 'Already requested at this virtual time, or this temporary PRN already has a task.')
  } else {
    if (!row.execution) return t('执行记录缺失。', 'Execution record is missing.')
    if (Date.parse(row.execution.scheduledFor) > Date.parse(facts.virtualTime)) return t('尚未到计划执行时点。', 'The scheduled execution time has not arrived.')
    if (row.execution.status !== (action === 'administer' ? 'dispensed' : 'pending')) return t('当前执行状态不可办理；给药须先由药师发药。', 'This execution state is ineligible; medication must first be dispensed.')
    if (action === 'administer' && facts.data.dispenses.filter(dispense => dispense.executionId === row.id).reduce((sum, dispense) => sum + dispense.quantity, 0) !== row.order.doseQuantity) return t('本次实际发药量与医嘱剂量不符。', 'The dispensed quantity does not match this dose.')
  }
  return undefined
}

export function InpatientExecutionBatch({ admission, session, locale, action, data, virtualTime, loading, loadFailed, active, write, refresh }: {
  admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; action: ExecutionAction; data: Clinical; virtualTime: string | undefined;
  loading: boolean; loadFailed: boolean; active: boolean; write: ReturnType<typeof useInpatientWriteIntent>; refresh: () => Promise<Facts | undefined>
}) {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const label = action === 'administer' ? t('给药', 'Administration') : action === 'complete' ? t('教育', 'Education') : 'PRN'
  const title = action === 'administer' ? t('集中记录给药', 'Record administrations') : action === 'complete' ? t('集中记录健康教育', 'Record health education') : t('集中发起 PRN', 'Request PRN executions')
  const reviewLabel = action === 'request-prn' ? t('核对 PRN 发起', 'Review PRN requests') : t(`核对${label}记录`, `Review ${label.toLowerCase()} records`)
  const confirmLabel = action === 'request-prn' ? t('确认发起 PRN', 'Confirm PRN requests') : t(`确认保存${label}记录`, `Save ${label.toLowerCase()} records`)
  const batch = useExecutionDrafts({ scope: executionDraftScope(session, admission.patientId, admission.id, action), session, write })
  const [open, setOpen] = useState(false), [review, setReview] = useState(false), [discard, setDiscard] = useState(false), [search, setSearch] = useState(''), [page, setPage] = useState(0), [notice, setNotice] = useState(''), [checking, setChecking] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const permitted = active && admission.status === 'admitted' && admission.recordStatus !== 'archived' && session.actor.roleCode === 'ward-nurse'
  const current = useRef({ permitted, active, admissionId: admission.id, open }); current.current = { permitted, active, admissionId: admission.id, open }
  const guard = () => current.current.permitted && current.current.admissionId === admission.id && current.current.open
  const all = candidates(data, action), selected = batch.rows.filter(row => row.selected)
  const filtered = all.filter(row => `${row.order.display} ${row.id}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const pageCount = Math.max(1, Math.ceil(filtered.length / 10)), currentPage = Math.min(page, pageCount - 1), visible = filtered.slice(currentPage * 10, (currentPage + 1) * 10)
  const facts = virtualTime ? { data, virtualTime } : undefined
  const problem = (row: Candidate) => !facts ? t('正在核对执行时间与记录。', 'Loading virtual time and execution records.') : unavailable(row, facts, action, zh)
  const changed = (row: Candidate) => !all.some(item => item.id === row.id && sameExecutionDraft(item, row))
  const rowProblem = (row: ExecutionDraft) => changed(row) ? t('状态或内容已变化，须重新核实或移除。', 'State or version changed. Verify again or remove.') : problem(row)
  const pendingItem = batch.items.find(item => item.status === 'unknown' || item.idempotencyKey === write.pending?.idempotencyKey)
  const disabled = !permitted || loading || loadFailed || batch.blocked || checking || !facts
  const issues = selected.some(row => !row.verified || rowProblem(row) || action === 'request-prn' && !(row.reasonOverride ?? batch.commonReason).trim())
  const update = (row: Candidate, patch: { verified?: boolean; selected?: boolean }) => {
    if (batch.update(row, patch)) setNotice('')
    else setNotice(t('清单最多20项；请移除不需要的项目。原输入保留，存储异常时暂停办理。', 'Keep at most 20 drafts. Remove unneeded items. Input is retained; storage failures block writes.'))
  }
  const check = async (submit: boolean) => {
    if (disabled || !selected.length || issues || !guard()) return
    setChecking(true)
    try {
      const fresh = await refresh()
      if (!guard()) return
      if (!fresh) { setNotice(t('读取失败，请重试；已核实内容和选择保留。', 'Loading failed. Retry; verified input and selections are retained.')); return }
      const eligible = candidates(fresh.data, action).filter(row => !unavailable(row, fresh, action, zh))
      if (selected.some(row => !eligible.some(item => item.id === row.id && sameExecutionDraft(row, item)))) { setNotice(t('已选项目状态或内容已变化，请逐项重新核实或移除。', 'Selected states or versions changed. Verify each item again or remove it.')); return }
      setNotice('')
      if (!submit) { setReview(true); return }
      if (!batch.prepare(eligible)) { setNotice(t('清单无法可靠保存，请先恢复原操作或重试；原输入保留。', 'Drafts could not be reliably saved. Recover the original attempt or retry; input is retained.')); return }
      setReview(false); void batch.start(guard)
    } finally { setChecking(false) }
  }
  const details = (row: Candidate) => <div className="flex flex-wrap gap-x-3 gap-y-1 break-words text-xs text-muted-foreground">
    <span>{row.order.duration === 'long' ? t('长期', 'Long') : t('临时', 'Temporary')} · {inpatientFrequencyLabel(row.order.frequencyCode, locale)}</span>
    <span>{t('每次 ', 'Per execution ')}{row.order.doseText || `${row.order.doseQuantity}${row.order.unit}`} · {row.order.doseQuantity}{row.order.unit}</span>
    {row.execution ? <span>{formatShanghaiMinute(row.execution.scheduledFor)}</span> : null}<span className="break-all">{row.id}</span>
  </div>
  const selectBox = (row: Candidate, draft?: ExecutionDraft, inDraft = false) => <label className="flex items-start gap-2 text-sm"><Checkbox checked={draft?.selected ?? false} disabled={disabled || !!problem(row) || changed(row) || action !== 'request-prn' && !draft?.verified} onCheckedChange={selected => update(row, { selected })} /><span className="break-words">{t(`${inDraft ? '清单选择' : `选择${label}`}：${row.order.display}`, `${inDraft ? 'Draft selection' : `Select ${label.toLowerCase()}`}: ${row.order.display}`)}</span></label>
  const successes = batch.items.filter(item => item.status === 'success').length
  const failureReason = (error: (typeof batch.items)[number]['error']) => getWorkspaceErrorMessage(new ApiClientError(error?.status ?? 0, error?.code ?? '', ''), getWorkspaceMessages(locale))
  return <>
    <Button ref={trigger} variant="outline" disabled={!permitted && !(active && pendingItem)} onClick={() => { setReview(false); setOpen(true) }}>{title}</Button>
    <Dialog pending={batch.busy || checking || write.mutation.isPending} open={open} onOpenChange={next => { setOpen(next); if (!next) setReview(false) }}>
      <DialogContent className="sm:max-w-[1000px]" finalFocus={trigger} showCloseButton={false}>
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{admission.patientName} · {t(`同患者同次住院 · 已选 ${selected.length} 项 · 每次最多20项`, `Same patient and admission · ${selected.length} selected · up to 20 per batch`)}</DialogDescription></DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
          {!permitted ? <Alert><AlertDescription>{admission.recordStatus === 'archived' ? t('病案已归档，不能新增执行记录。原结果仍可查询。', 'This record is archived; no new executions may be recorded. Original results can still be queried.') : t('当前身份、住院状态或页签不允许新增执行记录。', 'The current identity, admission state, or tab does not allow new executions.')}</AlertDescription></Alert> : null}
          {batch.failed ? <Alert variant="destructive"><AlertDescription>{t('清单无法可靠读取或保存，已暂停办理并保留原输入。', 'Drafts cannot be reliably read or saved. Writes are blocked and input is retained.')}</AlertDescription></Alert> : null}
          {notice ? <Alert><AlertDescription>{notice}</AlertDescription></Alert> : null}
          {loadFailed ? <Alert variant="destructive"><AlertDescription><p>{t('执行记录或执行时间读取失败，原输入保留；请重试后再核实保存。', 'Execution records or time failed to load. Input is retained; retry before verifying and saving.')}</p><Button variant="outline" disabled={checking || loading || batch.busy} onClick={() => {
            setChecking(true)
            void refresh().then(fresh => { if (current.current.open) setNotice(fresh ? '' : t('执行记录仍未读成，请稍后重试。', 'Execution records still could not be loaded. Retry later.')) }).finally(() => setChecking(false))
          }}>{t('重试执行记录', 'Retry execution records')}</Button></AlertDescription></Alert> : null}
          <p className="text-sm">{action === 'request-prn' ? t('仅发起待执行任务，不代表已经给药。逐项核对最终理由。', 'Request pending tasks only; this does not record administration. Review each final reason.') : t('仅记录实际已经发生且逐项明确核实的情况。先核实，再选择；不提供全选。', 'Record only facts that actually occurred and were explicitly verified item by item. Verify, then select; there is no select-all.')}</p>
          {review ? <section aria-label={reviewLabel} className="space-y-3">
            {selected.map(row => <article key={row.id} aria-label={t(`核对项目：${row.id}`, `Review item: ${row.id}`)} className="space-y-2 rounded-md border p-3"><h3 className="break-words font-medium">{row.order.display}</h3>{details(row)}{action === 'request-prn' ? <p className="whitespace-pre-wrap break-words text-sm">{t('最终理由：', 'Final reason: ')}{row.reasonOverride ?? batch.commonReason}</p> : <Badge>{t('已逐项核实实际发生', 'Actual occurrence verified')}</Badge>}{rowProblem(row) ? <p className="text-sm text-destructive">{rowProblem(row)}</p> : null}</article>)}
          </section> : <>
            <div className="flex flex-wrap items-center gap-2"><Input className="min-w-0 flex-1 basis-48" aria-label={t(`搜索${label}项目`, `Search ${label.toLowerCase()} items`)} placeholder={t(`搜索${label}项目`, `Search ${label.toLowerCase()} items`)} value={search} onChange={event => { setSearch(event.currentTarget.value); setPage(0) }} /><Button variant="ghost" disabled={disabled || !selected.length} onClick={() => batch.deselectAll()}>{t('清空选择', 'Clear selection')}</Button><span className="text-xs">{currentPage + 1}/{pageCount} · {t('每页10项', '10 per page')}</span><Button variant="ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t('上一页', 'Previous')}</Button><Button variant="ghost" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>{t('下一页', 'Next')}</Button></div>
            {action === 'request-prn' ? <label className="flex flex-col gap-2 text-sm">{t('PRN共同理由', 'Common PRN reason')}<Input aria-label={t('PRN共同理由', 'Common PRN reason')} maxLength={2000} disabled={disabled} value={batch.commonReason} onChange={event => batch.setCommonReason(event.currentTarget.value)} /></label> : null}
            {visible.map(row => {
              const draft = batch.rows.find(draft => draft.id === row.id), valid = draft && sameExecutionDraft(draft, row)
              return <article key={row.id} aria-label={t(`${label}项目：${row.id}`, `${label} item: ${row.id}`)} className="space-y-2 rounded-md border p-3"><h3 className="break-words font-medium">{row.order.display}</h3>{details(row)}
                {problem(row) ? <p className="text-sm text-muted-foreground">{problem(row)}</p> : null}
                {action !== 'request-prn' ? <label className="flex items-start gap-2 text-sm"><Checkbox checked={valid ? draft.verified : false} disabled={disabled || !!problem(row)} onCheckedChange={verified => update(row, { verified, selected: false })} /><span className="break-words">{t(`已核实实际${label}：${row.order.display}`, `Verified actual ${label.toLowerCase()}: ${row.order.display}`)}</span></label> : null}
                {selectBox(row, valid ? draft : undefined)}
              </article>
            })}
            {!loading && visible.length === 0 ? <p className="text-sm">{all.length ? t('没有匹配的项目。', 'No matching items.') : t('暂无当前可办理项目。', 'No current items to process.')}</p> : null}
            <section aria-label={t(`${label}待办清单`, `${label} draft list`)} className="space-y-3 rounded-md border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t(`待办清单 ${batch.rows.length}/20 · 已选 ${selected.length}`, `Drafts ${batch.rows.length}/20 · ${selected.length} selected`)}</h3><Button variant="ghost" disabled={batch.busy || !!pendingItem || !batch.rows.length} onClick={() => setDiscard(true)}>{t('丢弃待办清单', 'Discard drafts')}</Button></div>
              {batch.rows.map(row => <article key={row.id} aria-label={t(`待办项目：${row.id}`, `Draft item: ${row.id}`)} className="space-y-2 rounded border p-2"><h4 className="break-words text-sm font-medium">{row.order.display}</h4>{details(row)}{selectBox(row, row, true)}{rowProblem(row) ? <p className="text-sm text-destructive">{rowProblem(row)}</p> : null}
                {action === 'request-prn' ? <><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={disabled} onClick={() => batch.setReasonOverride(row.id, row.reasonOverride === undefined ? '' : undefined)}>{row.reasonOverride === undefined ? t('单独填写理由', 'Use individual reason') : t('使用共同理由', 'Use common reason')}</Button>{row.reasonOverride === undefined ? <p className="whitespace-pre-wrap break-words text-sm">{t('最终理由：', 'Final reason: ')}{batch.commonReason || t('尚未填写', 'Missing')}</p> : null}</div>{row.reasonOverride !== undefined ? <Input aria-label={t(`单项 PRN 理由：${row.order.display}`, `Individual PRN reason: ${row.order.display}`)} disabled={disabled} maxLength={2000} value={row.reasonOverride} onChange={event => batch.setReasonOverride(row.id, event.currentTarget.value)} /> : null}</> : null}
                <Button variant="ghost" size="sm" disabled={disabled} onClick={() => batch.remove(row.id)}>{t('移除项目', 'Remove item')}</Button>
              </article>)}
            </section>
          </>}
          {batch.items.length > 0 ? <section aria-label={t(`${label}逐项结果`, `${label} results`)} className="space-y-2 text-sm"><h3 className="font-semibold">{t(`逐项结果 · 成功 ${successes}/${batch.items.length}`, `Results · ${successes}/${batch.items.length} succeeded`)}</h3>{batch.items.map(item => <p key={item.idempotencyKey} className="break-words">{item.row.order.display} · {item.row.id} · {item.status === 'success' ? action === 'request-prn' ? t('已发起，仍待执行', 'Requested; still pending execution') : t('已保存实际记录', 'Actual record saved') : item.status === 'failed' ? t(`保存失败：${failureReason(item.error)}；输入保留，请重新核实。`, `Failed: ${failureReason(item.error)}; input retained. Verify again.`) : item.status === 'unknown' ? t('原结果待查明，后续项目已停止。', 'Original outcome unconfirmed; further items stopped.') : t('尚未发送，需重新核对。', 'Not sent; review again.')}</p>)}</section> : null}
          {pendingItem ? <Alert><AlertDescription><p>{t('请查询原尝试。恢复不会继续其余项目，余项须重新核对确认。', 'Query the original attempt. Recovery does not continue remaining items; review and confirm them again.')}</p><Button variant="outline" disabled={!active || batch.busy || checking || write.mutation.isPending || !!write.storageFailure} onClick={() => { void batch.recover(() => current.current.open && current.current.active && current.current.admissionId === admission.id) }}>{t(`恢复原${label}结果`, `Recover original ${label.toLowerCase()} result`)}</Button></AlertDescription></Alert> : null}
        </div>
        <DialogFooter><DialogClose render={<Button variant="outline" />}>{t('关闭办理窗口', 'Close processing window')}</DialogClose>{review ? <Button variant="outline" disabled={disabled} onClick={() => setReview(false)}>{t('返回修改', 'Back')}</Button> : null}<Button disabled={disabled || !selected.length || issues} onClick={() => { void check(review) }}>{review ? confirmLabel : `${reviewLabel} (${selected.length})`}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={discard} onOpenChange={setDiscard}><DialogContent><DialogHeader><DialogTitle>{t('丢弃未提交清单？', 'Discard unsubmitted drafts?')}</DialogTitle><DialogDescription>{t('删除本动作尚未提交的核实内容、选择和理由。已经保存的记录保留。', 'Remove unsubmitted verification, selection, and reasons for this action. Saved records remain.')}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDiscard(false)}>{t('保留清单', 'Keep drafts')}</Button><Button disabled={batch.busy || !!pendingItem} onClick={() => { if (batch.clear()) setDiscard(false) }}>{t('确认丢弃待办清单', 'Discard drafts')}</Button></DialogFooter></DialogContent></Dialog>
  </>
}
