import { formatFen, formatShanghaiMinute } from './workspace-format.ts'
import { InpatientPatientHeader, InpatientQueueGroup, InpatientStageCard } from './inpatient-layout.tsx'
import { inpatientDrgPayerReviewListSchema, inpatientDrgPayerReviewPreviewSchema } from '@clinmesh/contracts/inpatient-drg-payer'
import { inpatientListSchema } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { skipToken, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { RefreshCwIcon } from 'lucide-react'
import { apiGet } from './api-client.ts'
import { inpatientScopeKey } from './inpatient-scope.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { WorkspaceCardLayout, WorkspaceCard, WorkspaceQueueCard } from './workspace-card-layout.tsx'
import { InpatientActionProvider, InpatientActionOutlet } from './inpatient-workspace-actions.tsx'
import { InpatientDrgPayer } from './inpatient-drg-payer.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import { inpatientFlow } from './inpatient-stage-activity.ts'
import { InpatientNumber, InpatientNumberTail } from './inpatient-number.tsx'
import { PaginationControls } from './pagination-controls.tsx'
import { inpatientDepartureLabel } from './inpatient-labels.ts'

type InsuranceReviewProps = { session: SessionContext; locale: WorkspaceLocale }
const RECORDS_PER_PAGE = 10

export function InpatientInsuranceReview(props: InsuranceReviewProps): React.JSX.Element {
  return <InsuranceReview key={JSON.stringify([props.session.user.id, props.session.actor])} {...props} />
}

function InsuranceReview({ session, locale }: InsuranceReviewProps): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const client = useQueryClient(), scope = inpatientScopeKey(session)
  const admissions = useQuery({ queryKey: [...scope, 'admissions'], queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/admissions', inpatientListSchema, signal) })
  const [view, setView] = useState<{ selectedId: string | null | undefined; requestedPage: number; selectPending: boolean; completed: boolean }>({ selectedId: undefined, requestedPage: 1, selectPending: false, completed: false })
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
  const queueReady = admissions.isSuccess && assessments.every(query => query.isSuccess && !query.isFetching)
  const queueError = assessments.find(query => query.error)?.error
  const selected = selectedId === undefined ? selectPending ? undefined : pageItems[0] : archived.find(item => item.id === selectedId)
  // 只消费当前页的显式继续意图一次；病例选定后，刷新与分组变化不再推导另一位患者。
  useEffect(() => {
    if (selectedId !== undefined || !admissions.isSuccess || selectPending && !queueReady || !selectPending && pageItems.length === 0) return
    const nextId = (selectPending ? unassessed[0] : pageItems[0])?.id ?? null
    setView(current => current.selectedId === undefined && current.requestedPage === requestedPage && current.selectPending === selectPending
      ? { ...current, selectedId: nextId, selectPending: false } : current)
  }, [selectedId, admissions.isSuccess, selectPending, queueReady, requestedPage, pageItems, unassessed])
  const write = useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
  const changePage = (nextPage: number, pendingOnly = false) => {
    if (write.mutation.isPending) return
    setView({ requestedPage: nextPage, selectedId: undefined, selectPending: pendingOnly, completed: false })
  }
  const nextRecord = () => {
    if (!queueReady || !selected) return
    const next = unassessed.find(item => item.id !== selected.id)
    setView(current => ({ ...current, selectedId: next?.id ?? null, selectPending: false, completed: !next }))
    write.mutation.reset()
  }
  const selectedCase = useQuery({ queryKey: [...scope, selected?.id, 'drg-payer-preview'], retry: false,
    queryFn: selected ? ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${selected.id}/drg/payer-review-preview`, inpatientDrgPayerReviewPreviewSchema, signal) : skipToken })
  const headerInput = selectedCase.error === null ? selectedCase.data?.caseSummary.groupingInput : undefined
  const gender = headerInput?.gender === 'female' ? t('女', 'Female') : headerInput?.gender === 'male' ? t('男', 'Male') : t('性别未记录', 'Gender unavailable')
  let emptyTitle = t('等待病案归档', 'Awaiting archived records')
  if (pageItems.length > 0 && (selectedId === null || selectPending)) {
    if (queueError) emptyTitle = t('本页核定状态待确认', 'Assessment status needs confirmation on this page')
    else if (!queueReady) emptyTitle = t('正在读取本页核定状态', 'Loading assessment status for this page')
    else if (unassessed.length > 0) emptyTitle = t('本页还有待核定病案', 'Records still await assessment on this page')
    else if (view.completed) emptyTitle = pageCount === 1 ? t('本次核定已完成', 'Assessment complete') : t('本页核定已完成', 'Assessment complete on this page')
    else emptyTitle = t('本页暂无待核定病案', 'No records awaiting assessment on this page')
  }
  const queue = <section aria-label={t('核定队列', 'Assessment queue')}><WorkspaceQueueCard title={<h2>{t('核定队列', 'Assessment queue')}</h2>} description={t('已归档病案', 'Archived records')} actions={<Button aria-label={t('刷新', 'Refresh')} title={t('刷新', 'Refresh')} variant="ghost" size="icon-sm" onClick={() => void client.invalidateQueries({ queryKey: scope })}><RefreshCwIcon aria-hidden="true" /></Button>}>
    <div className="flex flex-col gap-2">
      {pageCount > 1 ? <p className="text-xs text-muted-foreground">{t('核定分组与计数仅限本页病案', 'Assessment groups and counts cover this page only')}</p> : null}
      <PaginationControls ariaLabel={t('核定队列分页', 'Assessment queue pagination')} messages={getWorkspaceMessages(locale)} page={page} pageSize={RECORDS_PER_PAGE} total={archived.length} disabled={write.mutation.isPending} onPageChange={nextPage => changePage(nextPage)} />
      {admissions.isPending || assessments.some(query => query.isPending) ? <><p role="status" className="text-xs">{t('正在读取本页核定状态', 'Loading assessment status for this page')}</p><Skeleton className="h-24 w-full" /></> : null}
      {queueError ? <Alert variant="destructive"><AlertDescription>{t('核定状态读取失败：', 'Unable to read assessment status: ')}{getWorkspaceErrorMessage(queueError, getWorkspaceMessages(locale))}<Button variant="outline" onClick={() => { for (const query of assessments) if (query.isError) void query.refetch() }}>{t('重试核定状态', 'Retry assessment status')}</Button></AlertDescription></Alert> : null}
      {[{ title: t('已归档病案', 'Archived records'), items: unassessed, assessed: false }, { title: t('已核定', 'Assessed'), items: assessed, assessed: true }].map(group => <InpatientQueueGroup key={group.title} title={group.title} count={group.items.length}>
        <div data-inpatient-queue-items>{group.items.map(item => <Button key={item.id} variant="ghost" className="h-auto w-full justify-start whitespace-normal py-3 text-start" aria-current={item.id === selected?.id ? 'true' : undefined}
          onClick={() => setView(current => ({ ...current, selectedId: item.id, selectPending: false, completed: false }))}><span className="flex min-w-0 flex-col gap-1"><span className="flex flex-wrap items-center justify-between gap-2"><strong>{item.patientName}</strong>{group.assessed ? <Badge variant="success">{t('已核定', 'Assessed')}</Badge> : <Badge variant="outline">{t('待核定', 'Pending')}</Badge>}</span>{latestReview(item.id) ? <span className="text-xs tabular-nums text-muted-foreground">{latestReview(item.id)!.drgCode} · {formatShanghaiMinute(latestReview(item.id)!.reviewedAt)} {t('核定', 'assessed')}</span> : null}<span className="text-xs text-muted-foreground"><InpatientNumberTail locale={locale} number={item.inpatientNumber} /></span></span></Button>)}</div>
      </InpatientQueueGroup>)}
      {admissions.data && archived.length === 0 ? <Empty><EmptyHeader><EmptyTitle>{t('无已归档病例', 'No archived records')}</EmptyTitle><EmptyDescription>{t('病案归档后进入核定队列。', 'Archived records enter the assessment queue.')}</EmptyDescription></EmptyHeader></Empty> : null}
    </div>
  </WorkspaceQueueCard></section>
  return <section aria-label={t('医保办核定工作台', 'Insurance assessment workspace')} className="clinmesh-inpatient-workspace flex min-h-0 min-w-0 flex-1 flex-col"><InpatientActionProvider stage="record"><WorkspaceCardLayout id={`inpatient-insurance-${session.actor.practitionerRoleId}`} locale={locale} queue={queue} flow={inpatientFlow(selected, locale)} action={<InpatientActionOutlet />}
    patient={selected ? <section aria-label={t('当前住院患者', 'Current inpatient')}><InpatientPatientHeader name={selected.patientName} identity={headerInput ? `${gender} · ${headerInput.ageYears}${t(' 岁', ' years')}` : undefined} location={headerInput ? `${inpatientDepartureLabel(headerInput.dischargeMode, locale)}${headerInput.inpatientDays > 0 ? t(` · 住院 ${headerInput.inpatientDays} 天`, ` · Stay ${headerInput.inpatientDays} days`) : ''}` : undefined} status={t('已归档 · 只读', 'Archived · read only')} details={<><InpatientNumber locale={locale} number={selected.inpatientNumber} /><span>{t('预交金 ' , 'Deposits ')}{formatFen(selected.depositFen, locale)}</span><span>{t('累计费用 ' , 'Charges ')}{formatFen(selected.chargesFen, locale)}</span></>} /></section> : undefined}>
    {admissions.error ? <Alert variant="destructive"><AlertDescription>{t('核定队列读取失败：', 'Unable to read the assessment queue: ')}{getWorkspaceErrorMessage(admissions.error, getWorkspaceMessages(locale))}<Button variant="outline" onClick={() => void admissions.refetch()}>{t('重试', 'Retry')}</Button></AlertDescription></Alert> : null}
    <InpatientWriteRecovery write={write} locale={locale} />
    <section aria-label={t('历史核定', 'Assessment history')} className="flex min-h-0 flex-1 flex-col">
      {selected ? <InpatientStageCard title={t('医保核定', 'Insurance assessment')} turn={t('轮到你：审阅归档分组与费用，再提交模拟核定', 'Your turn: review archived grouping and charges, then submit the assessment')} owners={<p className="text-xs">{t('病案归档', 'Record archive')} → <strong>{t('医保办核定', 'Insurance assessment')}</strong></p>}><InpatientDrgPayer key={selected.id} admission={selected} session={session} locale={locale} write={write} {...(queueReady ? { onNext: nextRecord } : {})} /></InpatientStageCard>
        : <WorkspaceCard title={<h2>{emptyTitle}</h2>}>
          <p>{pageItems.length > 0 ? queueError ? t('请重试核定状态，确认本页病案后再继续。', 'Retry assessment status before continuing with this page.') : hasNextPage ? t('可继续下一页或从队列查看已核定历史。', 'Continue to the next page or view assessed history from the queue.') : t('可从队列查看病案与已核定历史。', 'View records and assessment history from the queue.') : t('请病案人员先完成归档，再从队列选取病案。', 'Medical records staff must archive the record before it can be selected for assessment.')}</p>
          {hasNextPage && queueReady && selectedId === null && unassessed.length === 0 ? <Button variant="outline" onClick={() => changePage(page + 1, true)}>{t('继续下一页', 'Continue to next page')}</Button> : null}
        </WorkspaceCard>}
    </section>
  </WorkspaceCardLayout></InpatientActionProvider></section>
}
