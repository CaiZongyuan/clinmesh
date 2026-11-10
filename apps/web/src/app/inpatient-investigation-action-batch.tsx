import { useRef, useState } from 'react'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Input } from '@clinmesh/ui/components/input'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { ApiClientError } from './api-client.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { indicationLabel } from './doctor/laboratory-page.tsx'
import { laboratoryGenerationErrorMessage } from './laboratory-generation-error.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { canReviewInvestigationAction, investigationActionEntries, investigationActionName, investigationActionUnavailable,
  sameInvestigationActionSnapshot, useInvestigationActionDrafts, type InvestigationAction, type InvestigationActionFacts, type InvestigationActionSnapshot } from './inpatient-investigation-action-drafts.ts'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>;
  data: InvestigationActionFacts; refresh: () => Promise<InvestigationActionFacts | undefined>; loading: boolean }

export function InpatientInvestigationActionBatch(props: Props) {
  const [action, setAction] = useState<InvestigationAction>('cancel')
  const t = (cn: string, en: string) => props.locale === 'zh-CN' ? cn : en
  return <section aria-label={t('检查申请集中办理', 'Investigation actions')} className="flex min-w-0 flex-col gap-3">
    <ToggleGroup aria-label={t('检查申请办理动作', 'Investigation action')} value={[action]} variant="outline" disabled={props.write.blocked}
      onValueChange={values => { if (values[0] === 'cancel' || values[0] === 'retry') setAction(values[0]) }}>
      <ToggleGroupItem value="cancel">{t('取消申请', 'Cancel requests')}</ToggleGroupItem>
      <ToggleGroupItem value="retry">{t('失败重试', 'Retry failures')}</ToggleGroupItem>
    </ToggleGroup>
    <ActionList key={`${props.session.user.id}:${JSON.stringify(props.session.actor)}:${props.admission.id}:${action}`} {...props} action={action} />
  </section>
}

function ActionList({ admission, session, locale, write, data, refresh, loading, action }: Props & { action: InvestigationAction }) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en, cancel = action === 'cancel'
  const label = cancel ? t('取消申请', 'Cancel requests') : t('重新生成', 'Retry generation')
  const batch = useInvestigationActionDrafts({ scope: { accountId: session.user.id, actor: session.actor, patientId: admission.patientId, admissionId: admission.id, action }, session, write, refresh })
  const [search, setSearch] = useState(''), [page, setPage] = useState(0), [review, setReview] = useState<InvestigationActionSnapshot[] | null>(null)
  const [checking, setChecking] = useState(false), [notice, setNotice] = useState(''), [discard, setDiscard] = useState(false)
  const selected = batch.rows.filter(row => row.selected), unknown = batch.items.some(item => item.status === 'unknown')
  const current = useRef({ admission, session, selected })
  current.current = { admission, session, selected }
  const guard = () => current.current.admission.id === admission.id && current.current.admission.status === 'admitted'
    && current.current.session.user.id === session.user.id && JSON.stringify(current.current.session.actor) === JSON.stringify(session.actor)
  const disabled = batch.blocked || checking || loading || admission.status !== 'admitted'
  const entries = investigationActionEntries(data).filter(entry => !entry.request.report)
  const filtered = entries.filter(entry => investigationActionName(entry).toLowerCase().includes(search.toLowerCase()))
  const pages = Math.max(1, Math.ceil(filtered.length / 10)), shownPage = Math.min(page, pages - 1), visible = filtered.slice(shownPage * 10, (shownPage + 1) * 10)
  const state = (snapshot: InvestigationActionSnapshot) => ({ issued: snapshot.sent ? t('已送检，待受理', 'Sent, awaiting acceptance') : t('待送检', 'Awaiting dispatch'),
    accepted: t('已受理', 'Accepted'), 'in-progress': t('执行中', 'In progress'), 'generation-failed': t('结果生成失败', 'Generation failed'), cancelled: t('已取消', 'Cancelled'),
    reported: t('报告已签发', 'Report issued'), acknowledged: t('报告已阅', 'Report acknowledged') }[snapshot.request.status])
  const reason = (snapshot: InvestigationActionSnapshot) => admission.status !== 'admitted' ? t('当前住院已不可办理', 'Admission is no longer writable')
    : investigationActionUnavailable(snapshot, action) ? cancel ? snapshot.sent && snapshot.request.status === 'issued'
      ? t('已送检，不能取消；请继续完成检查', 'Already dispatched; continue the investigation') : t('当前状态不允许取消', 'This state cannot be cancelled')
      : ['INVESTIGATION_TRUTH_INCOMPATIBLE', 'INVESTIGATION_UNSUPPORTED'].includes(snapshot.request.generationError?.code ?? '')
        ? t('来源不相容或不支持，不能重试；可核查后取消', 'Unsupported source; review and cancel if needed') : t('仅可重试允许重新生成的失败申请', 'Only eligible generation failures can be retried') : undefined
  const failureReason = (error?: { code: string }) => error?.code === 'INVESTIGATION_REVIEW_CHANGED'
    ? t('申请内容或状态已变化，请重新核对；该项未发送。', 'This request changed. Review it again; this item was not sent.')
    : getWorkspaceErrorMessage(new ApiClientError(0, error?.code ?? '', ''), getWorkspaceMessages(locale))
  const details = (snapshot: InvestigationActionSnapshot) => <div className="flex flex-col gap-1 text-xs text-muted-foreground">
    <span>{snapshot.kind === 'laboratory' ? t('检验', 'Laboratory') : t('检查', 'Imaging')} · {state(snapshot)}</span>
    <span>{t('申请指征：', 'Indication: ')}{snapshot.kind === 'laboratory' ? snapshot.request.indicationCode === 'clinical-assessment' ? t('临床评估', 'Clinical assessment')
      : indicationLabel(snapshot.request.indicationCode, getWorkspaceMessages(locale)) : snapshot.request.indication}</span>
    {snapshot.request.generationError ? <span>{snapshot.kind === 'laboratory' ? laboratoryGenerationErrorMessage(snapshot.request.generationError.code, locale)
      : t('本次检查未取得结果，未生成报告；请核查后重试或取消申请。', 'No result or report was produced. Review the request, then retry or cancel it.')}</span> : null}
    {cancel ? <span>{t('取消理由：不再需要', 'Cancellation reason: no longer needed')}</span> : null}
  </div>
  const select = (snapshots: InvestigationActionSnapshot[], checked: boolean) => {
    if (!batch.select(snapshots, checked)) setNotice(t('每次最多保留20条，或当前操作尚未完成；原清单已保留。', 'Up to 20 requests, and the original operation must be resolved. The list is retained.'))
    else setNotice('')
  }
  const confirm = async () => {
    if (disabled || !review || !guard()) return
    setChecking(true); setNotice('')
    try {
      const fresh = await refresh()
      if (!guard()) return
      if (!fresh || review.length !== current.current.selected.length || review.some(snapshot => !canReviewInvestigationAction(snapshot, fresh, action)
        || !current.current.selected.some(row => sameInvestigationActionSnapshot(row.snapshot, snapshot))) || !batch.prepare(fresh)) {
        setNotice(t('申请内容、状态或所选清单已变化；请返回逐项重新核对，本次未发送。', 'Requests or the selected list changed. Return to review; nothing was sent.'))
        return
      }
      setReview(null); void batch.start(guard)
    } catch { setNotice(t('最新申请读取失败，请重试；原清单已保留。', 'Current requests could not be loaded. The list is retained.')) }
    finally { setChecking(false) }
  }
  const complete = !batch.busy && !batch.rows.length && batch.items.length > 0 && batch.items.every(item => item.status === 'success')
  const actionBar = <WorkspaceActionBar tone={complete ? 'complete' : disabled || !selected.length ? 'blocked' : 'normal'}
    ariaLabel={cancel ? t('集中取消申请操作', 'Request cancellation actions') : t('集中重新生成操作', 'Generation retry actions')}
    summary={complete ? <span role="status">{cancel ? t('已完成取消申请', 'Cancellation completed') : t('已提交重新生成', 'Generation retries submitted')}</span> : t(`已选 ${selected.length} 条${label}`, `${selected.length} requests selected`)}
    reason={cancel ? t('取消申请不等于退款，既有费用和记录按原规则保留。', 'Cancellation does not refund payments; existing records remain.') : t('只提交重新生成请求，报告仍需等待签发。', 'Submit generation retries; reports still require issuance.')}
    action={complete ? undefined : unknown ? <Button disabled={batch.busy || batch.failed || loading || !guard()} onClick={() => { void batch.recover(guard) }}>{t(`恢复原${label}`, `Recover original ${label}`)}</Button>
      : <Button disabled={disabled || !selected.length} onClick={() => { setNotice(''); setReview(selected.map(row => row.snapshot)) }}>{t(`集中${label}`, `Review ${label}`)}</Button>} />
  return <>
    <p className="text-xs text-muted-foreground">{t('同患者同次住院 · 每次最多20条 · 每页10条', 'Same patient and admission · Up to 20 requests · 10 per page')}</p>
    {batch.failed ? <Alert variant="destructive"><AlertDescription>{t('待处理清单无法可靠读取或保存，已阻止发送；请先核查原操作。', 'The list cannot be read or saved reliably. Resolve the original operation before sending.')}</AlertDescription></Alert> : null}
    {notice && !review ? <Alert><AlertDescription>{notice}</AlertDescription></Alert> : null}
    <div className="flex flex-wrap items-center gap-2"><Input className="min-w-0 flex-1 basis-48" aria-label={t('搜索待处理检查申请', 'Search investigation requests')} value={search} onChange={event => { setSearch(event.currentTarget.value); setPage(0) }} />
      <Button variant="outline" disabled={disabled || !visible.some(entry => !reason(entry))} onClick={() => select(visible.filter(entry => !reason(entry)), true)}>{t(`全选本页可${label}`, `Select eligible ${label} on this page`)}</Button>
      <Button variant="ghost" disabled={disabled || !selected.length} onClick={() => batch.deselectAll()}>{t('清空选择', 'Clear selection')}</Button>
      <span className="text-xs">{shownPage + 1}/{pages}</span><Button variant="ghost" disabled={!shownPage} onClick={() => setPage(shownPage - 1)}>{t('上一页', 'Previous page')}</Button><Button variant="ghost" disabled={shownPage + 1 >= pages} onClick={() => setPage(shownPage + 1)}>{t('下一页', 'Next page')}</Button>
    </div>
    {visible.map(snapshot => <article key={snapshot.request.id} className="flex min-w-0 flex-col gap-1 border-b py-2"><label className="flex min-w-0 items-start gap-2">
      <Checkbox aria-label={t(`选择${label}：${investigationActionName(snapshot)}`, `Select ${label}: ${investigationActionName(snapshot)}`)} disabled={disabled || !!reason(snapshot)} checked={batch.rows.some(row => row.snapshot.request.id === snapshot.request.id && row.selected)} onCheckedChange={checked => select([snapshot], checked)} />
      <strong className="min-w-0 break-words text-sm">{investigationActionName(snapshot)}</strong></label>{details(snapshot)}{reason(snapshot) ? <p className="text-xs text-muted-foreground">{reason(snapshot)}</p> : null}</article>)}
    {!entries.length ? <p>{t('暂无待处理检查申请；报告在下方阅读。', 'No requests to process. Read available reports below.')}</p> : !visible.length ? <p>{t('没有匹配的申请。', 'No matching requests.')}</p> : null}
    {batch.rows.length || batch.failed ? <section aria-label={t(`${label}待处理清单`, `${label} list`)} className="flex min-w-0 flex-col gap-2 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">{t(`待处理清单（${batch.rows.length}/20）· 已选 ${selected.length} 条`, `List (${batch.rows.length}/20) · ${selected.length} selected`)}</h4><Button variant="ghost" disabled={batch.busy || unknown || write.blocked} onClick={() => setDiscard(true)}>{t('丢弃待处理清单', 'Discard list')}</Button></div>
      {batch.rows.map(row => { const fresh = investigationActionEntries(data).find(entry => entry.request.id === row.snapshot.request.id), changed = !canReviewInvestigationAction(row.snapshot, data, action); return <article key={row.snapshot.request.id} className="flex min-w-0 flex-col gap-1 border-b py-2">
        <div className="flex flex-wrap items-center justify-between gap-2"><label className="flex min-w-0 items-start gap-2"><Checkbox aria-label={t(`待处理选择：${investigationActionName(row.snapshot)}`, `List selection: ${investigationActionName(row.snapshot)}`)} disabled={disabled} checked={row.selected} onCheckedChange={checked => select([row.snapshot], checked)} /><strong className="break-words text-sm">{investigationActionName(row.snapshot)}</strong></label><Button variant="ghost" disabled={disabled} onClick={() => batch.remove(row.snapshot.request.id)}>{t(`移除：${investigationActionName(row.snapshot)}`, `Remove: ${investigationActionName(row.snapshot)}`)}</Button></div>
        {details(row.snapshot)}{changed ? <p className="text-xs">{t('申请内容或状态已变化，须重新核对后办理。', 'This request changed. Review it again before processing.')}</p> : null}
        {changed && fresh && !reason(fresh) ? <Button variant="outline" disabled={disabled} onClick={() => select([fresh], row.selected)}>{t(`更新核对：${investigationActionName(row.snapshot)}`, `Update review: ${investigationActionName(row.snapshot)}`)}</Button> : null}
      </article> })}
    </section> : null}
    {batch.items.length ? <section aria-label={t(`${label}逐项结果`, `${label} outcomes`)} className="flex min-w-0 flex-col gap-1 text-sm"><h4 className="font-semibold">{t(`成功 ${batch.items.filter(item => item.status === 'success').length}/${batch.items.length}`, `${batch.items.filter(item => item.status === 'success').length}/${batch.items.length} succeeded`)}</h4>
      {batch.items.map(item => <p key={item.row.revision} className="break-words">{investigationActionName(item.row.snapshot)}：{item.status === 'success' ? cancel ? t('申请已取消', 'Request cancelled') : t('已提交重新生成，等待报告', 'Retry submitted; awaiting report')
        : item.status === 'unknown' ? t(`结果待确认，请恢复原${label}；后续未发送。`, `Result unknown; recover original ${label}. Later requests are paused.`) : item.status === 'failed' ? t(`办理失败：${failureReason(item.error)}；原清单保留。`, `Failed: ${failureReason(item.error)}. The list is retained.`) : t('尚未发送，请重新核对。', 'Not sent; review again.')}</p>)}
    </section> : null}
    {batch.rows.length || batch.items.length ? <InpatientPrimaryAction stage="investigations" priority={batch.rows.length || unknown ? 10 : -10} fallback={actionBar}>{actionBar}</InpatientPrimaryAction> : actionBar}
    <Dialog pending={checking} open={review !== null} onOpenChange={open => { if (!open) setReview(null) }}><DialogContent className="sm:max-w-[720px]"><DialogHeader><DialogTitle>{cancel ? t('集中取消检查申请', 'Review request cancellations') : t('集中重试结果生成', 'Review generation retries')}</DialogTitle><DialogDescription>{admission.patientName} · {t(`本次住院 · 已选 ${review?.length ?? 0} 条`, `Current admission · ${review?.length ?? 0} selected`)}</DialogDescription></DialogHeader>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">{notice ? <Alert variant="destructive"><AlertDescription>{notice}</AlertDescription></Alert> : null}{review?.map(snapshot => <article key={snapshot.request.id} className="flex min-w-0 flex-col gap-1 border-b pb-2"><strong className="break-words text-sm">{investigationActionName(snapshot)}</strong>{details(snapshot)}</article>)}<p className="text-xs text-muted-foreground">{cancel ? t('逐项取消申请；不撤销已有记录或自动退款。', 'Cancel requests individually; retain existing records without automatic refunds.') : t('逐项重新提交生成；不将重试视为报告已签发。', 'Retry generation individually; reports remain subject to issuance.')}</p></div>
      <DialogFooter><DialogClose render={<Button variant="outline" />}>{t('返回修改', 'Back')}</DialogClose><Button disabled={disabled} onClick={() => { void confirm() }}>{cancel ? t('确认取消申请', 'Confirm cancellation') : t('确认重新生成', 'Confirm retries')}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={discard} onOpenChange={setDiscard}><DialogContent><DialogHeader><DialogTitle>{t('丢弃待处理清单', 'Discard list')}</DialogTitle><DialogDescription>{t('只丢弃本患者当前动作的未发送选择和结果展示，不撤销已完成的操作。', 'Discard this patient’s unsent selections and outcome display for this action. Completed operations remain.')}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDiscard(false)}>{t('保留待处理清单', 'Keep list')}</Button><Button disabled={batch.busy || unknown || write.blocked} onClick={() => { if (batch.clear()) setDiscard(false) }}>{t('确认丢弃', 'Confirm discard')}</Button></DialogFooter></DialogContent></Dialog>
  </>
}
