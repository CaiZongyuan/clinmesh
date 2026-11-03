import { formatFen } from './workspace-format.ts'
import { InpatientPatientHeader, InpatientQueueGroup, InpatientStageCard } from './inpatient-layout.tsx'
import { inpatientDrgPayerReviewListSchema } from '@clinmesh/contracts/inpatient-drg-payer'
import { inpatientListSchema } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
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

export function InpatientInsuranceReview({ session, locale }: { session: SessionContext; locale: WorkspaceLocale }): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const client = useQueryClient(), scope = inpatientScopeKey(session)
  const admissions = useQuery({ queryKey: [...scope, 'admissions'], queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/admissions', inpatientListSchema, signal) })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const archived = (admissions.data?.items ?? []).filter(item => item.recordStatus === 'archived')
  const selected = archived.find(item => item.id === selectedId) ?? archived[0]
  const assessments = useQueries({ queries: archived.map(item => ({ queryKey: [...scope, item.id, 'drg-payer-reviews'], retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${item.id}/drg/payer-reviews`, inpatientDrgPayerReviewListSchema, signal) })) })
  const assessed = new Set(archived.filter((_item, index) => (assessments[index]?.data?.reviews.length ?? 0) > 0).map(item => item.id))
  const write = useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
  const queue = <section aria-label={t('核定队列', 'Assessment queue')}><WorkspaceQueueCard title={<h2>{t('核定队列', 'Assessment queue')}</h2>} description={t('已归档病案', 'Archived records')}>
    <div className="flex flex-col gap-2">
      {admissions.isPending ? <Skeleton className="h-24 w-full" /> : null}
      {[{ title: t('已归档病案', 'Archived records'), items: archived.filter(item => !assessed.has(item.id)) }, { title: t('已核定', 'Assessed'), items: archived.filter(item => assessed.has(item.id)) }].map(group => <InpatientQueueGroup key={group.title} title={group.title} count={group.items.length}>
        <div data-inpatient-queue-items>{group.items.map(item => <Button key={item.id} variant="ghost" className="h-auto w-full justify-start whitespace-normal py-3 text-start" aria-current={item.id === selected?.id ? 'true' : undefined}
          onClick={() => setSelectedId(item.id)}><span className="flex min-w-0 flex-col gap-1"><strong>{item.patientName}</strong><span className="text-xs text-muted-foreground"><InpatientNumberTail locale={locale} number={item.inpatientNumber} /></span></span></Button>)}</div>
      </InpatientQueueGroup>)}
      {admissions.data && archived.length === 0 ? <Empty><EmptyHeader><EmptyTitle>{t('无已归档病例', 'No archived records')}</EmptyTitle><EmptyDescription>{t('病案归档后进入核定队列。', 'Archived records enter the assessment queue.')}</EmptyDescription></EmptyHeader></Empty> : null}
    </div>
  </WorkspaceQueueCard></section>
  return <section aria-label={t('医保办核定工作台', 'Insurance assessment workspace')} className="clinmesh-inpatient-workspace flex min-h-0 min-w-0 flex-1 flex-col"><InpatientActionProvider stage="record"><WorkspaceCardLayout id={`inpatient-insurance-${session.actor.practitionerRoleId}`} locale={locale} queue={queue} flow={inpatientFlow(selected, locale)} action={<InpatientActionOutlet />}
    patient={selected ? <InpatientPatientHeader name={selected.patientName} status={t('已归档 · 只读', 'Archived · read only')} details={<><InpatientNumber locale={locale} number={selected.inpatientNumber} /><span>{t('预交金 ' , 'Deposits ')}{formatFen(selected.depositFen, locale)}</span><span>{t('累计费用 ' , 'Charges ')}{formatFen(selected.chargesFen, locale)}</span></>} /> : undefined}>
    {admissions.error ? <Alert variant="destructive"><AlertDescription>{t('核定队列读取失败：', 'Unable to read the assessment queue: ')}{getWorkspaceErrorMessage(admissions.error, getWorkspaceMessages(locale))}<Button variant="outline" onClick={() => void admissions.refetch()}>{t('重试', 'Retry')}</Button></AlertDescription></Alert> : null}
    <InpatientWriteRecovery write={write} locale={locale} />
    <section aria-label={t('历史核定', 'Assessment history')} className="flex min-h-0 flex-1 flex-col">
      {selected ? <InpatientStageCard title={t('医保核定', 'Insurance assessment')} turn={t('轮到你：审阅归档分组与费用，再提交模拟核定', 'Your turn: review archived grouping and charges, then submit the assessment')} owners={<p className="text-xs">{t('病案归档', 'Record archive')} → <strong>{t('医保办核定', 'Insurance assessment')}</strong></p>}><InpatientDrgPayer key={selected.id} admission={selected} session={session} locale={locale} write={write} onNext={() => { const next = archived.find(item => item.id !== selected.id && !assessed.has(item.id)); setSelectedId(next?.id ?? null); write.mutation.reset() }} /></InpatientStageCard>
        : <WorkspaceCard title={<h2>{t('等待病案归档', 'Awaiting archived records')}</h2>}><p>{t('请病案人员先完成归档，再从队列选取病案。', 'Medical records staff must archive the record before it can be selected for assessment.')}</p></WorkspaceCard>}
    </section>
  </WorkspaceCardLayout></InpatientActionProvider></section>
}
