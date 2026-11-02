import { inpatientListSchema } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet } from './api-client.ts'
import { inpatientScopeKey } from './inpatient-scope.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { WorkspaceCardLayout, WorkspaceCard, WorkspacePatientCard, WorkspaceQueueCard } from './workspace-card-layout.tsx'
import { InpatientActionProvider, InpatientActionOutlet } from './inpatient-workspace-actions.tsx'
import { InpatientDrgPayer } from './inpatient-drg-payer.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import { inpatientFlow } from './inpatient-stage-activity.ts'

export function InpatientInsuranceReview({ session, locale }: { session: SessionContext; locale: WorkspaceLocale }): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const client = useQueryClient(), scope = inpatientScopeKey(session)
  const admissions = useQuery({ queryKey: [...scope, 'admissions'], queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/admissions', inpatientListSchema, signal) })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const archived = (admissions.data?.items ?? []).filter(item => item.recordStatus === 'archived')
  const selected = archived.find(item => item.id === selectedId) ?? archived[0]
  const write = useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
  const queue = <section aria-label={t('核定队列', 'Assessment queue')}><WorkspaceQueueCard title={<h2>{t('核定队列', 'Assessment queue')}</h2>} description={t('已归档病案', 'Archived records')}>
    <div data-inpatient-queue className="flex flex-col gap-2">
      {admissions.isPending ? <Skeleton className="h-24 w-full" /> : null}
      <div data-inpatient-queue-items>{archived.map(item => <Button key={item.id} variant="ghost" className="h-auto w-full justify-start whitespace-normal py-3 text-start" aria-current={item.id === selected?.id ? 'true' : undefined}
        onClick={() => setSelectedId(item.id)}><span className="flex min-w-0 flex-col gap-1"><strong>{item.patientName}</strong><span className="tabular-nums text-xs text-muted-foreground">{item.inpatientNumber}</span></span></Button>)}</div>
      {admissions.data && archived.length === 0 ? <Empty><EmptyHeader><EmptyTitle>{t('无已归档病例', 'No archived records')}</EmptyTitle><EmptyDescription>{t('病案归档后进入核定队列。', 'Archived records enter the assessment queue.')}</EmptyDescription></EmptyHeader></Empty> : null}
    </div>
  </WorkspaceQueueCard></section>
  return <section aria-label={t('医保办核定工作台', 'Insurance assessment workspace')} className="flex min-h-0 min-w-0 flex-1 flex-col"><InpatientActionProvider stage="record"><WorkspaceCardLayout id={`inpatient-insurance-${session.actor.practitionerRoleId}`} locale={locale} queue={queue} flow={inpatientFlow(selected, locale)} action={<InpatientActionOutlet />}
    patient={selected ? <WorkspacePatientCard title={selected.patientName} description={selected.inpatientNumber}><p>{t('已归档病案 · 归档诊疗只读', 'Archived record · care is read only')}</p></WorkspacePatientCard> : undefined}>
    {admissions.error ? <Alert variant="destructive"><AlertDescription>{t('核定队列读取失败：', 'Unable to read the assessment queue: ')}{getWorkspaceErrorMessage(admissions.error, getWorkspaceMessages(locale))}<Button variant="outline" onClick={() => void admissions.refetch()}>{t('重试', 'Retry')}</Button></AlertDescription></Alert> : null}
    <InpatientWriteRecovery write={write} locale={locale} />
    <section aria-label={t('历史核定', 'Assessment history')} className="flex min-h-0 flex-1 flex-col">
      {selected ? <WorkspaceCard><InpatientDrgPayer key={selected.id} admission={selected} session={session} locale={locale} write={write} /></WorkspaceCard>
        : <WorkspaceCard title={<h2>{t('等待病案归档', 'Awaiting archived records')}</h2>}><p>{t('请病案人员先完成归档，再从队列选取病案。', 'Medical records staff must archive the record before it can be selected for assessment.')}</p></WorkspaceCard>}
    </section>
  </WorkspaceCardLayout></InpatientActionProvider></section>
}
