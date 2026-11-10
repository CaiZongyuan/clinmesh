import { Badge } from '@clinmesh/ui/components/badge'
import { InpatientItemRow } from './inpatient-layout.tsx'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { InpatientOrderComposer } from './inpatient-order-composer.tsx'
import { orderDraftKey } from './inpatient-order-drafts.ts'
import { InpatientChargeList } from './inpatient-charges.tsx'
import { inpatientFullCatalogSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { scenarioStateSchema, type SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
import { useQuery } from '@tanstack/react-query'
import { PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { ApiClientError, apiGet } from './api-client.ts'
import { InpatientDiagnosisEditor } from './inpatient-diagnosis-editor.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { AgentReviewAnchor } from './agent-review.tsx'
import { inpatientOrderAnchor } from './inpatient-agent-tools.tsx'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { inpatientAdmissionConditionLabel, inpatientFrequencyLabel } from './inpatient-labels.ts'
import { formatShanghaiMinute } from './workspace-format.ts'
import { InpatientVerification } from './inpatient-verification.tsx'
import { InpatientStopOrders } from './inpatient-stop-orders.tsx'
import { InpatientExecutionBatch } from './inpatient-execution-batch.tsx'

type Write = ReturnType<typeof useInpatientWriteIntent>

/** 开立被业务规则拒绝（如适应症不符）时取服务端原因就地显示；全局提示不再改写为「目录或业务规则已变化」。 */
export function inpatientOrderRejection(mutation: Write['mutation']): string | undefined {
  const error = mutation.error
  return mutation.variables?.operation === 'inpatient.order.issue' && error instanceof ApiClientError && error.code === 'CATALOG_CONFLICT' ? error.message : undefined
}

export function InpatientClinical({ admission, session, locale, write, view = 'orders', active = true }: { view?: 'orders' | 'fees'; active?: boolean; admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: Write }): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const doctor = session.actor.roleCode === 'inpatient-doctor', nurse = session.actor.roleCode === 'ward-nurse'
  const scope = ['inpatient',session.actor.workspaceId,session.actor.epoch,session.actor.practitionerRoleId]
  const messages = getWorkspaceMessages(locale)
  const clinical = useQuery({ queryKey: [...scope,admission.id,'clinical'], queryFn: ({signal}) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/clinical`,inpatientFullClinicalSchema,signal) })
  const scenario = useQuery({ queryKey: ['scenario', 'virtual-time'], enabled: nurse,
    queryFn: ({ signal }) => apiGet('/api/sim/v1/scenario-runs/current', scenarioStateSchema, signal), retry: false })
  const catalog = useQuery({ queryKey: [...scope,'clinical-catalog'], enabled: (doctor || nurse) && view === 'orders', queryFn: ({signal}) => apiGet('/api/his/v1/inpatient/clinical-catalog',inpatientFullCatalogSchema,signal) })
  const [composing, setComposing] = useState(false)
  const [editingDiagnosis, setEditingDiagnosis] = useState(false)
  const surgery = useQuery({ queryKey: [...scope,admission.id,'surgeries'], enabled: doctor && view === 'orders', queryFn: ({signal}) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/surgeries`,inpatientSurgerySchema,signal) })
  const data = clinical.data, blocked = write.blocked || admission.status !== 'admitted'
  const diagnosed = (data?.diagnosis.entries.length ?? 0) > 0
  const error=clinical.error ?? catalog.error
  const diagnosisBlocked = write.blocked || admission.recordStatus === 'archived' || admission.status === 'registered'
  if (view === 'fees') return <>{error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(error,messages)}</AlertDescription></Alert> : null}{data ? <InpatientChargeList data={{ admissionId: admission.id, financialStatus: admission.financialStatus, charges: data.charges, chargesFen: data.chargesFen }} locale={locale} /> : null}</>
  return <section aria-label={t('住院诊疗','Inpatient care')} className="flex flex-col gap-4">
    {error ? <Alert variant="destructive"><AlertDescription>{t('诊断医嘱读取失败：', 'Care records failed to load: ')}{getWorkspaceErrorMessage(error,messages)}<Button variant="outline" size="sm" onClick={() => { void clinical.refetch(); void catalog.refetch() }}>{t('重试诊疗记录', 'Retry care records')}</Button></AlertDescription></Alert> : null}
    {clinical.isPending ? <Skeleton className="h-24 w-full" /> : null}
    {data && !nurse ? <section aria-label={t('住院诊断摘要', 'Inpatient diagnosis summary')} className="clinmesh-inpatient-summary">
      <div className="clinmesh-inpatient-section-heading"><h3>{t('住院诊断', 'Inpatient diagnosis')}</h3>{doctor ? <Button variant="ghost" size="sm" disabled={diagnosisBlocked} aria-haspopup="dialog" onClick={() => setEditingDiagnosis(true)}>{diagnosed ? null : <PlusIcon data-icon="inline-start" />}{diagnosed ? t('修改诊断', 'Edit diagnoses') : t('添加诊断', 'Add diagnosis')}</Button> : null}</div>
      {!diagnosed ? <p className="text-sm text-muted-foreground">{t('尚未确认。先从国家临床版 2022 选定主诊断和入院病情，才能开立药品医嘱。', 'Not confirmed. Select a primary diagnosis and condition on admission from the national clinical edition 2022 before ordering medications.')}</p> : null}
      {data.diagnosis.entries.map(entry => <div key={entry.conditionId} className="clinmesh-inpatient-diagnosis-line"><Badge variant={entry.role === 'primary' ? 'default' : 'outline'}>{entry.role === 'primary' ? t('主诊断', 'Primary') : t('次诊断', 'Secondary')}</Badge><span className="font-medium">{entry.coding.display}</span><span className="text-xs text-muted-foreground tabular-nums">{entry.coding.code}</span><span className="text-sm text-muted-foreground">{t('入院病情：', 'On admission: ')}{inpatientAdmissionConditionLabel(entry.admissionCondition, locale)}</span>{entry.note ? <span className="text-sm text-muted-foreground">{entry.note}</span> : null}</div>)}
      {doctor ? <InpatientDiagnosisEditor key={data.admissionId} data={data} session={session} locale={locale} blocked={diagnosisBlocked} write={write} open={editingDiagnosis} onOpenChange={setEditingDiagnosis} /> : null}
    </section> : null}
    {nurse && data ? <InpatientVerification key={`${session.user.id}:${scope.join(':')}:${admission.id}`} admission={admission} session={session} locale={locale} orders={data.orders} loading={clinical.isFetching || clinical.isError} blocked={blocked || admission.recordStatus === 'archived'} active={active} write={write} refresh={async () => { const result = await clinical.refetch(); return result.isSuccess ? result.data.orders : undefined }} /> : null}
    {data ? <InpatientStopOrders key={`stop:${session.user.id}:${scope.join(':')}:${admission.id}`} admission={admission} session={session} locale={locale} data={data} loading={clinical.isFetching || clinical.isError} active={active} write={write} refresh={async () => { const result = await clinical.refetch(); return result.isSuccess ? result.data : undefined }} renderOrder={(order, selection) => {
      const orderExecutions = data.executions.filter(execution => execution.orderId === order.id)
      const completedExecutions = orderExecutions.filter(execution => execution.status === 'completed').length
      const verifiedLabel = nurse && order.kind === 'medication' && orderExecutions.length > 0 && orderExecutions.every(e => e.status === 'pending')
        ? t('已校对 · 等药师发药', 'Verified · awaiting pharmacist')
        : t('已校对', 'Verified')
      return <InpatientItemRow key={order.id} title={order.display} badge={<Badge variant="outline">{order.duration==='long'?t('长期','Long'):t('临时','Temporary')}</Badge>}
      metadata={<>{order.kind === 'medication' ? <><span>{t('每次 ','Per dose ')}{order.doseText}{order.doseText.replace(/\s/g, '') === `${order.doseQuantity}${order.unit}` ? null : `（${order.doseQuantity}${order.unit}）`}</span><span>{inpatientFrequencyLabel(order.frequencyCode, locale)}</span></> : <span>{t('每次 ','Per execution ')}{order.doseQuantity}{order.unit}</span>}{orderExecutions.length > 0 ? <span className="tabular-nums">{t(`已执行 ${completedExecutions}/${orderExecutions.length} 次`, `Executed ${completedExecutions}/${orderExecutions.length}`)}</span> : null}{order.surgeryExecutionId ? <span>{t('术后医嘱 · ','Postoperative order · ')}{surgery.data?.executions.find(item=>item.id===order.surgeryExecutionId)?.actualProcedure.coding.display ?? t('已关联手术', 'Linked procedure')}</span> : null}</>}
      complete={order.state === 'stopped' || order.state === 'completed'} actions={<>{selection}<Badge variant="outline">{{signed:t('待校对','Awaiting verification'),verified:verifiedLabel,'stop-requested':t('待停嘱核对','Stop requested'),stopped:t('已停止','Stopped'),completed:t('已结束','Finished')}[order.state]}</Badge>
        {doctor ? <Dialog key={`${scope.join(':')}:${admission.id}:${order.id}`}>
          <DialogTrigger render={<Button variant="outline" size="sm" />}>{t(`执行记录 (${orderExecutions.length})`, `Execution records (${orderExecutions.length})`)}</DialogTrigger>
          <DialogContent className="sm:max-w-[640px]">
            <DialogHeader><DialogTitle>{order.display} · {t(`执行记录 (${orderExecutions.length})`, `Execution records (${orderExecutions.length})`)}</DialogTitle><DialogDescription>{t('每次 ', 'Per execution ')}{order.doseQuantity}{order.unit} · {inpatientFrequencyLabel(order.frequencyCode, locale)}</DialogDescription></DialogHeader>
            <div className="min-h-0 overflow-y-auto p-4">
              {orderExecutions.length === 0 ? <p className="text-sm text-muted-foreground">{t('暂无执行记录', 'No execution records')}</p> : orderExecutions.map(execution => <InpatientItemRow key={execution.id} title={formatShanghaiMinute(execution.scheduledFor).slice(5)} complete={execution.status === 'completed'} metadata={<span>{order.doseQuantity}{order.unit}</span>} badge={<Badge variant="outline">{{pending:t('待执行','Pending'),dispensed:t('已发药','Dispensed'),completed:t('已完成','Completed'),cancelled:t('已取消','Cancelled')}[execution.status]}</Badge>} />)}
            </div>
            <DialogFooter><DialogClose render={<Button variant="outline" />}>{t('关闭', 'Close')}</DialogClose></DialogFooter>
          </DialogContent>
        </Dialog> : null}
      </>}>
      <AgentReviewAnchor id={inpatientOrderAnchor(admission.id, order.id)} />
    </InpatientItemRow>}} /> : null}
    {!doctor && data && data.executions.length > 0 ? <details open className="clinmesh-inpatient-disclosure"><summary>{t('执行记录', 'Execution records')} <span className="tabular-nums">{data.executions.length}</span></summary><div>
    {data?.executions.map(execution=>{
      const order=data.orders.find(order=>order.id===execution.orderId)!
      const due = scenario.data !== undefined && Date.parse(execution.scheduledFor) <= Date.parse(scenario.data.virtualTime)
      const availableAt = new Date(execution.scheduledFor).toLocaleTimeString(zh ? 'zh-CN' : 'en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
      return <InpatientItemRow key={execution.id} title={order.display} complete={execution.status === 'completed'} badge={<Badge variant="outline">{{pending:t('待执行','Pending'),dispensed:t('已发药','Dispensed'),completed:t('已完成','Completed'),cancelled:t('已取消','Cancelled')}[execution.status]}</Badge>} metadata={<span>{formatShanghaiMinute(execution.scheduledFor).slice(5)} · {order.doseQuantity}{order.unit}</span>} actions={<>
        {nurse && execution.status === 'dispensed' && !due ? <p role="status">{scenario.data ? t(`${availableAt} 后可给药`, `Medication can be administered after ${availableAt}`) : t('正在核对给药时间', 'Checking administration time')}</p> : null}
      </>} />
    })}</div></details> : null}
    {nurse && data ? <section aria-label={t('实际执行与 PRN', 'Actual executions and PRN')} className="flex flex-wrap gap-2">{(['administer', 'complete', 'request-prn'] as const).map(action => <InpatientExecutionBatch key={`${action}:${session.user.id}:${scope.join(':')}:${admission.id}`} action={action} admission={admission} session={session} locale={locale} data={data} virtualTime={scenario.data?.virtualTime} active={active} loading={clinical.isFetching || scenario.isFetching} loadFailed={clinical.isError || scenario.isError} write={write} refresh={async () => {
      const [records, clock] = await Promise.all([clinical.refetch(), scenario.refetch()])
      return records.isSuccess && clock.isSuccess ? { data: records.data, virtualTime: clock.data.virtualTime } : undefined
    }} />)}</section> : null}
    {doctor ? <section aria-label={t('开立医嘱', 'Issue order')}>
      <InpatientPrimaryAction stage="orders" priority={-10}><WorkspaceActionBar summary={t('在弹窗中连续添加并核对医嘱；开立后交病区护士校对。', 'Add and review orders in the composer; ward nurse verification follows.')}
        action={<Button disabled={admission.status !== 'admitted' || admission.recordStatus === 'archived'} onClick={() => setComposing(true)}>{t('开立医嘱', 'Issue order')}</Button>} /></InpatientPrimaryAction>
      {data ? <InpatientOrderComposer key={orderDraftKey(session, admission)} open={composing && active} onOpenChange={setComposing} active={active} session={session} admission={admission} encounterVersion={data.encounterVersion} diagnosed={diagnosed}
        services={catalog.data?.services ?? []} surgeries={surgery.data?.executions ?? []} locale={locale} write={write} loading={catalog.isPending} catalogError={catalog.error} onReload={() => void catalog.refetch()} /> : null}
    </section> : null}
  </section>
}
