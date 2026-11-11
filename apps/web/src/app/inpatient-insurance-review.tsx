import { formatFen, formatShanghaiMinute } from './workspace-format.ts'
import { InpatientPatientHeader, InpatientQueueGroup, InpatientStageCard } from './inpatient-layout.tsx'
import { inpatientDrgPayerReviewListSchema, inpatientDrgPayerReviewPreviewSchema } from '@clinmesh/contracts/inpatient-drg-payer'
import { inpatientListSchema, type InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { skipToken, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { RefreshCwIcon } from 'lucide-react'
import { ApiClientError, apiGet } from './api-client.ts'
import { inpatientScopeKey } from './inpatient-scope.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { WorkspaceCardLayout, WorkspaceCard, WorkspaceQueueCard } from './workspace-card-layout.tsx'
import { InpatientActionProvider, InpatientActionOutlet } from './inpatient-workspace-actions.tsx'
import { InpatientDrgPayer } from './inpatient-drg-payer.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import { inpatientFlow } from './inpatient-stage-activity.ts'
import { InpatientNumber } from './inpatient-number.tsx'
import { PaginationControls } from './pagination-controls.tsx'
import { inpatientDepartureLabel } from './inpatient-labels.ts'
import { useInpatientReviewQueue, type InpatientReviewQueueSnapshot, type ReviewQueueCommand } from './inpatient-review-queue.ts'
import { ReviewDraftFailure } from './review-draft-failure.tsx'

type InsuranceReviewProps = { session: SessionContext; locale: WorkspaceLocale }
const RECORDS_PER_PAGE = 10
type Target = NonNullable<InpatientReviewQueueSnapshot['target']>
type Choice = { target?: Target | null; notice?: 'changed' | 'read'; reselect?: boolean }
const keyOf = (snapshot: InpatientReviewQueueSnapshot) => JSON.stringify([snapshot.sourceId, snapshot.signature])
const mayAssess = (item: InpatientAdmission) => item.recordStatus === 'archived' && item.archivedDrgCode !== null
const targetOf = ({ id, patientId, patientName, versionId }: InpatientAdmission): Target => ({ id, patientId, patientName, versionId })
const ineligiblePreviewCodes = new Set(['INPATIENT_DRG_NOT_ARCHIVED', 'DRG_FROZEN_RESULT_MISSING', 'DRG_FROZEN_UNGROUPED', 'DRG_PAYMENT_PARAMETER_MISSING'])
async function canAssess(id: string) {
  const path = `/api/his/v1/inpatient/admissions/${encodeURIComponent(id)}/drg`
  try {
    const [reviews, preview] = await Promise.all([
      apiGet(`${path}/payer-reviews`, inpatientDrgPayerReviewListSchema),
      apiGet(`${path}/payer-review-preview`, inpatientDrgPayerReviewPreviewSchema),
    ])
    return reviews.admissionId === id && reviews.reviews.length === 0 && preview.admissionId === id
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 409 && ineligiblePreviewCodes.has(error.code)) return false
    throw error
  }
}

export function InpatientInsuranceReview(props: InsuranceReviewProps): React.JSX.Element {
  return <InsuranceReview key={JSON.stringify([props.session.user.id, props.session.actor])} {...props} />
}

function InsuranceReview({ session, locale }: InsuranceReviewProps): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const client = useQueryClient(), scope = inpatientScopeKey(session)
  const admissions = useQuery({ queryKey: [...scope, 'admissions'], queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/admissions', inpatientListSchema, signal) })
  const [view, setView] = useState<{ selectedId: string | null | undefined; requestedPage: number; selectPending: boolean }>({ selectedId: undefined, requestedPage: 1, selectPending: false })
  const [checking, setChecking] = useState(false), [choices, setChoices] = useState<Partial<Record<string, Choice>>>({})
  const mounted = useRef(true), currentId = useRef<string | undefined>(undefined), inFlight = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const { selectedId, requestedPage, selectPending } = view
  const archived = (admissions.data?.items ?? []).filter(item => item.recordStatus === 'archived')
  const pageCount = Math.max(1, Math.ceil(archived.length / RECORDS_PER_PAGE))
  const page = Math.min(requestedPage, pageCount)
  const pageItems = archived.slice((page - 1) * RECORDS_PER_PAGE, page * RECORDS_PER_PAGE)
  const hasNextPage = page < pageCount
  const assessments = useQueries({ queries: pageItems.map(item => ({ queryKey: [...scope, item.id, 'drg-payer-reviews'], retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${item.id}/drg/payer-reviews`, inpatientDrgPayerReviewListSchema, signal) })) })
  const unassessed = pageItems.filter((_item, index) => assessments[index]?.isSuccess && assessments[index]?.data?.reviews.length === 0)
  const assessed = pageItems.filter((_item, index) => assessments[index]?.isSuccess && (assessments[index]?.data?.reviews.length ?? 0) > 0)
  const latestReview = (id: string) => assessments[pageItems.findIndex(item => item.id === id)]?.data?.reviews.at(-1)
  const write = useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
  const blocked = useRef(write.blocked)
  blocked.current = write.blocked
  const originalAdmissionId = write.pending?.command.operation === 'inpatient.drg.payer.review' ? write.pending.command.input.admissionId : undefined
  const completedAdmissionId = write.mutation.isSuccess && write.mutation.data?.command.operation === 'inpatient.drg.payer.review'
    ? write.mutation.data.command.input.admissionId : undefined
  const queueReady = admissions.isSuccess && assessments.every(query => query.isSuccess && !query.isFetching)
    && (completedAdmissionId === undefined || !unassessed.some(item => item.id === completedAdmissionId))
  const queueError = assessments.find(query => query.error)?.error
  const selected = selectedId === undefined ? originalAdmissionId ? archived.find(item => item.id === originalAdmissionId) : selectPending ? undefined : pageItems[0] : archived.find(item => item.id === selectedId)
  const continuationQueue = useInpatientReviewQueue(session, selected?.id)
  const continuation = continuationQueue.snapshots.find(snapshot => snapshot.operation === 'inpatient.drg.payer.review')
  const choice = continuation && choices[keyOf(continuation)]
  const nextTarget = choice?.target === null ? undefined : choice?.target ?? continuation?.target
  currentId.current = selected?.id
  // 只消费当前页的显式继续意图一次；病例选定后，刷新与分组变化不再推导另一位患者。
  useEffect(() => {
    if (selectedId === undefined && originalAdmissionId && admissions.isSuccess) {
      const originalIndex = archived.findIndex(item => item.id === originalAdmissionId)
      setView(current => current.selectedId === undefined ? { ...current, selectedId: originalAdmissionId, requestedPage: originalIndex < 0 ? current.requestedPage : Math.floor(originalIndex / RECORDS_PER_PAGE) + 1, selectPending: false } : current)
      return
    }
    if (selectedId !== undefined || !admissions.isSuccess || selectPending && !queueReady || !selectPending && pageItems.length === 0) return
    const nextId = (selectPending ? unassessed.find(mayAssess) : pageItems[0])?.id ?? null
    setView(current => current.selectedId === undefined && current.requestedPage === requestedPage && current.selectPending === selectPending
      ? { ...current, selectedId: nextId, selectPending: false } : current)
  }, [selectedId, originalAdmissionId, admissions.isSuccess, archived, selectPending, queueReady, requestedPage, pageItems, unassessed])
  const changePage = (nextPage: number, pendingOnly = false) => {
    if (blocked.current || inFlight.current) return
    setView({ requestedPage: nextPage, selectedId: undefined, selectPending: pendingOnly })
  }
  const freezeNext = (command: ReviewQueueCommand) => {
    if (!queueReady || !selected || continuationQueue.error || inFlight.current || blocked.current) return false
    const index = pageItems.findIndex(item => item.id === selected.id)
    const ordered = [...pageItems.slice(index + 1), ...pageItems.slice(0, Math.max(0, index))]
    const target = ordered.find(item => item.id !== selected.id && mayAssess(item) && unassessed.some(pending => pending.id === item.id))
    const prepared = continuationQueue.prepare(command, { filter: 'unassessed', page, queue: pageItems.map(item => item.id), ...(target ? { target: targetOf(target) } : {}) })
    if (prepared && continuation && choice) {
      setChoices(current => { const next = { ...current }; delete next[keyOf(continuation)]; return next })
    }
    return prepared
  }
  const verifyNext = async (target?: Target) => {
    if (!continuation || blocked.current || inFlight.current) return
    const frozen = continuation, key = keyOf(frozen)
    const active = () => mounted.current && currentId.current === frozen.sourceId && !blocked.current
    const show = (value: Choice) => setChoices(previous => ({ ...previous, [key]: value }))
    const refresh = () => client.invalidateQueries({ queryKey: scope })
    inFlight.current = true; setChecking(true)
    try {
      const [list, eligible] = await Promise.all([
        apiGet('/api/his/v1/inpatient/admissions', inpatientListSchema),
        target ? canAssess(target.id) : undefined,
      ])
      if (!active()) return
      if (target) {
        const fresh = list.items.find(item => item.id === target.id)
        if (!fresh || fresh.patientId !== target.patientId || fresh.versionId !== target.versionId || !mayAssess(fresh) || !eligible) {
          show({ ...choice, notice: 'changed', reselect: true })
          await refresh()
          return
        }
        await refresh()
        if (active()) {
          setView(current => ({ ...current, selectedId: target.id, selectPending: false }))
          write.mutation.reset()
        }
        return
      }
      const currentPage = list.items.filter(item => item.recordStatus === 'archived').slice((page - 1) * RECORDS_PER_PAGE, page * RECORDS_PER_PAGE)
      const index = frozen.queue.indexOf(frozen.sourceId)
      const ordered = [...frozen.queue.slice(index + 1), ...frozen.queue.slice(0, Math.max(0, index))]
      let replacement: Target | null = null
      for (const id of ordered) {
        const item = currentPage.find(candidate => candidate.id === id)
        if (!item || item.id === frozen.sourceId || !mayAssess(item)) continue
        const confirmed = await canAssess(item.id)
        if (!active()) return
        if (confirmed) { replacement = targetOf(item); break }
      }
      await refresh()
      if (active()) show({ target: replacement })
    } catch {
      if (active()) show({ ...choice, notice: 'read' })
    } finally { inFlight.current = false; if (mounted.current) setChecking(false) }
  }
  const continuationContent = queueReady && continuation?.complete && continuation.sourceId === selected?.id ? <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3">
    <p role="status" className="text-sm">{choice?.notice === 'changed' ? t('目标病案状态已变化，请刷新队列后重新选择', 'The target record changed. Refresh the queue and select it again.')
      : choice?.notice === 'read' ? t('目标病案暂时无法确认，请重试', 'Unable to verify the target record. Retry.')
        : nextTarget ? t('本份核定已完成，核对后可继续下一份。', 'Assessment complete. Continue when ready.') : t('本页核定已完成', 'Assessment complete on this page')}</p>
    {nextTarget ? <Button variant="outline" disabled={write.blocked || checking || choice?.reselect} onClick={() => void verifyNext(nextTarget)}>{t(`下一份：${nextTarget.patientName}`, `Next record: ${nextTarget.patientName}`)}</Button>
      : continuation.page < pageCount ? <Button variant="outline" disabled={write.blocked || checking} onClick={() => changePage(continuation.page + 1, true)}>{t('继续下一页', 'Continue to next page')}</Button> : null}
    {choice?.reselect ? <Button variant="outline" disabled={write.blocked || checking} onClick={() => void verifyNext()}>{t('刷新队列并重选下一份', 'Refresh and choose the next record')}</Button> : null}
  </div> : null
  const selectedCase = useQuery({ queryKey: [...scope, selected?.id, 'drg-payer-preview'], retry: false,
    queryFn: selected ? ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${selected.id}/drg/payer-review-preview`, inpatientDrgPayerReviewPreviewSchema, signal) : skipToken })
  const headerInput = selectedCase.error === null ? selectedCase.data?.caseSummary.groupingInput : undefined
  const gender = headerInput?.gender === 'female' ? t('女', 'Female') : headerInput?.gender === 'male' ? t('男', 'Male') : t('性别未记录', 'Gender unavailable')
  let emptyTitle = t('等待病案归档', 'Awaiting archived records')
  if (pageItems.length > 0 && (selectedId === null || selectPending)) {
    if (queueError) emptyTitle = t('本页核定状态待确认', 'Assessment status needs confirmation on this page')
    else if (!queueReady) emptyTitle = t('正在读取本页核定状态', 'Loading assessment status for this page')
    else if (unassessed.some(mayAssess)) emptyTitle = t('本页还有待核定病案', 'Records still await assessment on this page')
    else emptyTitle = t('本页暂无待核定病案', 'No records awaiting assessment on this page')
  }
  const queue = <section aria-label={t('核定队列', 'Assessment queue')}><WorkspaceQueueCard title={<h2>{t('核定队列', 'Assessment queue')}</h2>} actions={<><Badge variant="secondary" className="tabular-nums">{archived.length}</Badge><Button aria-label={t('刷新', 'Refresh')} title={t('刷新', 'Refresh')} variant="ghost" size="icon-sm" onClick={() => void client.invalidateQueries({ queryKey: scope })}><RefreshCwIcon aria-hidden="true" /></Button></>}>
    <div className="flex flex-col gap-2">
      {pageCount > 1 ? <p className="text-xs text-muted-foreground">{t('核定分组与计数仅限本页病案', 'Assessment groups and counts cover this page only')}</p> : null}
      <PaginationControls ariaLabel={t('核定队列分页', 'Assessment queue pagination')} messages={getWorkspaceMessages(locale)} page={page} pageSize={RECORDS_PER_PAGE} total={archived.length} disabled={write.blocked || checking} onPageChange={nextPage => changePage(nextPage)} />
      {admissions.isPending || assessments.some(query => query.isPending) ? <><p role="status" className="text-xs">{t('正在读取本页核定状态', 'Loading assessment status for this page')}</p><Skeleton className="h-24 w-full" /></> : null}
      {queueError ? <Alert variant="destructive"><AlertDescription>{t('核定状态读取失败：', 'Unable to read assessment status: ')}{getWorkspaceErrorMessage(queueError, getWorkspaceMessages(locale))}<Button variant="outline" onClick={() => { for (const query of assessments) if (query.isError) void query.refetch() }}>{t('重试核定状态', 'Retry assessment status')}</Button></AlertDescription></Alert> : null}
      {[{ title: t('已归档病案', 'Archived records'), items: unassessed, assessed: false }, { title: t('已核定', 'Assessed'), items: assessed, assessed: true }].map(group => <InpatientQueueGroup key={group.title} title={group.title} count={group.items.length}>
        <div data-inpatient-queue-items>{group.items.map(item => <Button key={item.id} variant="ghost" className="h-auto w-full justify-start whitespace-normal py-2.5 text-start" aria-current={item.id === selected?.id ? 'true' : undefined}
          disabled={checking || (write.blocked && item.id !== selected?.id)} onClick={() => setView(current => ({ ...current, selectedId: item.id, selectPending: false }))}><span className="flex min-w-0 flex-1 flex-col gap-1"><span className="flex flex-wrap items-center justify-between gap-2"><strong>{item.patientName}</strong>{group.assessed ? <Badge variant="success">{t('已核定', 'Assessed')}</Badge> : <Badge variant="warning">{t('待核定', 'Pending')}</Badge>}</span>{latestReview(item.id) ? <span className="text-xs tabular-nums text-muted-foreground">{latestReview(item.id)!.drgCode} · {formatShanghaiMinute(latestReview(item.id)!.reviewedAt).slice(5)} {t('核定', 'assessed')}</span> : <span className="text-xs text-muted-foreground">{item.archivedDrgCode ? `${item.archivedDrgCode} · ` : ''}{item.archivedAt ? `${formatShanghaiMinute(item.archivedAt).slice(5, 10)} ${t('归档', 'archived')}` : ''}</span>}</span></Button>)}</div>
      </InpatientQueueGroup>)}
      {admissions.data && archived.length === 0 ? <Empty><EmptyHeader><EmptyTitle>{t('无已归档病例', 'No archived records')}</EmptyTitle><EmptyDescription>{t('病案归档后进入核定队列。', 'Archived records enter the assessment queue.')}</EmptyDescription></EmptyHeader></Empty> : null}
    </div>
  </WorkspaceQueueCard></section>
  return <section aria-label={t('医保办核定工作台', 'Insurance assessment workspace')} className="clinmesh-inpatient-workspace flex min-h-0 min-w-0 flex-1 flex-col"><InpatientActionProvider stage="record"><WorkspaceCardLayout id={`inpatient-insurance-${session.actor.practitionerRoleId}`} locale={locale} queue={queue} flow={inpatientFlow(selected, locale)} action={<InpatientActionOutlet />}
    patient={selected ? <section aria-label={t('当前住院患者', 'Current inpatient')}><InpatientPatientHeader name={selected.patientName} identity={headerInput ? `${gender} · ${headerInput.ageYears}${t(' 岁', ' years')}` : undefined} location={headerInput ? `${t('心内病区 · ', 'Cardiology Ward · ')}${inpatientDepartureLabel(headerInput.dischargeMode, locale)}${headerInput.inpatientDays > 0 ? t(` · 住院 ${headerInput.inpatientDays} 天`, ` · Stay ${headerInput.inpatientDays} days`) : ''}` : undefined} status={t('已归档 · 只读', 'Archived · read only')} statusVariant="outline" details={<><InpatientNumber locale={locale} number={selected.inpatientNumber} />{selected.recordNumber ? <InpatientNumber locale={locale} number={selected.recordNumber} label={t('病案号', 'Record')} /> : null}{selected.departedAt ? <span>{t('出院 ', 'Discharged ')}{formatShanghaiMinute(selected.departedAt).slice(5)}{selected.departureMethod ? ` · ${inpatientDepartureLabel(selected.departureMethod, locale)}` : headerInput ? ` · ${inpatientDepartureLabel(headerInput.dischargeMode, locale)}` : ''}</span> : null}<span>{t('归档费用 ', 'Archived charges ')}{formatFen(selected.chargesFen, locale)}</span></>} /></section> : undefined}>
    {admissions.error ? <Alert variant="destructive"><AlertDescription>{t('核定队列读取失败：', 'Unable to read the assessment queue: ')}{getWorkspaceErrorMessage(admissions.error, getWorkspaceMessages(locale))}<Button variant="outline" onClick={() => void admissions.refetch()}>{t('重试', 'Retry')}</Button></AlertDescription></Alert> : null}
    <InpatientWriteRecovery write={write} locale={locale} />
    <ReviewDraftFailure key={continuationQueue.scope} failure={continuationQueue.failure} locked={write.blocked || checking} retry={continuationQueue.retry} discardUnread={continuationQueue.discardUnread} zh={locale === 'zh-CN'} queue />
    <section aria-label={t('历史核定', 'Assessment history')} className="flex min-h-0 flex-1 flex-col">
      {selected ? <InpatientStageCard title={t('医保核定', 'Insurance assessment')} turn={t('轮到你：审阅归档分组与费用，再提交模拟核定', 'Your turn: review archived grouping and charges, then submit the assessment')} owners={<p className="text-xs">{t('病案归档', 'Record archive')} › <strong>{t('医保办核定', 'Insurance assessment')}</strong></p>}><InpatientDrgPayer key={selected.id} admission={selected} session={session} locale={locale} write={write} onBeforeReview={freezeNext} continuation={continuationContent} queueReady={queueReady && !checking} /></InpatientStageCard>
        : <WorkspaceCard title={<h2>{emptyTitle}</h2>}>
          <p>{pageItems.length > 0 ? queueError ? t('请重试核定状态，确认本页病案后再继续。', 'Retry assessment status before continuing with this page.') : hasNextPage ? t('可继续下一页或从队列查看已核定历史。', 'Continue to the next page or view assessed history from the queue.') : t('可从队列查看病案与已核定历史。', 'View records and assessment history from the queue.') : t('请病案人员先完成归档，再从队列选取病案。', 'Medical records staff must archive the record before it can be selected for assessment.')}</p>
          {hasNextPage && queueReady && selectedId === null && !unassessed.some(mayAssess) ? <Button variant="outline" onClick={() => changePage(page + 1, true)}>{t('继续下一页', 'Continue to next page')}</Button> : null}
        </WorkspaceCard>}
    </section>
  </WorkspaceCardLayout></InpatientActionProvider></section>
}
