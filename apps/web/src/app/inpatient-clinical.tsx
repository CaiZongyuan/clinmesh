import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { Badge } from '@clinmesh/ui/components/badge'
import { InpatientItemRow } from './inpatient-layout.tsx'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { InpatientChargeList } from './inpatient-charges.tsx'
import { inpatientFullCatalogSchema, inpatientFullClinicalSchema, type inpatientOrderIssueInputSchema } from '@clinmesh/contracts/inpatient-clinical'
import type { InpatientDrgSimulationInput } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { z } from 'zod'
import { resolveInpatientDose, type InpatientDoseResult } from '@clinmesh/core/inpatient-dose'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { scenarioStateSchema, type SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { useQuery } from '@tanstack/react-query'
import { PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { ApiClientError, apiGet } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { InpatientDiagnosisEditor } from './inpatient-diagnosis-editor.tsx'
import { InpatientOrderPicker, type InpatientOrderPick } from './inpatient-order-picker.tsx'
import { OrderEstimate, useOrderEstimate } from './inpatient-order-estimate.tsx'
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
  const [pick, setPick] = useState<InpatientOrderPick | null>(null), [duration,setDuration] = useState<'long'|'temporary'>('long')
  const [frequency,setFrequency] = useState<'QD'|'BID'|'PRN'|null>(null), [dose,setDose] = useState<string|null>(null)
  const [surgeryId,setSurgeryId] = useState<string|null>(null)
  const [editingDiagnosis, setEditingDiagnosis] = useState(false), [reasonOrderId, setReasonOrderId] = useState<string | null>(null)
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const reason = reasonOrderId ? reasons[reasonOrderId] ?? '' : ''
  const setReason = (value: string) => { if (reasonOrderId) setReasons(previous => ({ ...previous, [reasonOrderId]: value })) }
  const [estimating, setEstimating] = useState(false)
  const surgery = useQuery({ queryKey: [...scope,admission.id,'surgeries'], enabled: doctor && view === 'orders', queryFn: ({signal}) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/surgeries`,inpatientSurgerySchema,signal) })
  const medication = pick?.kind === 'medication' ? pick.item : undefined, service = pick?.kind === 'service' ? pick.item : undefined
  const doseText = dose ?? medication?.doses[0]?.doseText ?? ''
  const selectedDose = medication ? resolveInpatientDose({ unit: medication.unit, doses: medication.doses,
    ...(medication.doseBasis ? { doseBasis: medication.doseBasis } : {}),
    ...(medication.maxDoseQuantity === undefined ? {} : { maxDoseQuantity: medication.maxDoseQuantity }) }, doseText) : undefined
  const selectedFrequency = frequency !== null && medication?.frequencyCodes.includes(frequency) ? frequency : medication?.frequencyCodes[0]
  const data = clinical.data, blocked = write.blocked || admission.status !== 'admitted'
  const stopBlocked = write.blocked || !['admitted','discharge-pending'].includes(admission.status)
  const diagnosed = (data?.diagnosis.entries.length ?? 0) > 0
  const orderInput = (): z.infer<typeof inpatientOrderIssueInputSchema> | undefined => {
    if (!data) return undefined
    const common={admissionId:admission.id,encounterVersion:data.encounterVersion,duration,...(surgeryId ? {surgeryExecutionId:surgeryId} : {})}
    if (medication && selectedDose && 'quantity' in selectedDose && selectedFrequency) return {...common,selection:{kind:'medication',catalogItemId:medication.id,catalogVersion:medication.version,doseText,doseQuantity:selectedDose.quantity,frequencyCode:selectedFrequency}}
    if(service) return {...common,selection:{kind:'service',serviceId:service.id,serviceVersion:service.version,quantity:1}}
    return undefined
  }
  const input = orderInput()
  const draft: InpatientDrgSimulationInput | undefined = input?.selection.kind === 'medication'
    ? { medications: [{ catalogItemId: input.selection.catalogItemId, catalogVersion: input.selection.catalogVersion, doseText: input.selection.doseText, doseQuantity: input.selection.doseQuantity, frequencyCode: input.selection.frequencyCode }], services: [] }
    : input?.selection.kind === 'service' ? { medications: [], services: [{ serviceId: input.selection.serviceId, serviceVersion: input.selection.serviceVersion, quantity: input.selection.quantity }] } : undefined
  const estimate = useOrderEstimate({ scope, admissionId: admission.id, draft, enabled: doctor && active && estimating && !blocked })
  const showEstimate = doctor && estimating && draft !== undefined
  const rejection = doctor ? inpatientOrderRejection(write.mutation) : undefined
  const choose = (next: InpatientOrderPick | null) => { setPick(next); setFrequency(null); setDose(null); if (rejection) write.mutation.reset() }
  const issue = () => {
    if (!input || (showEstimate && !estimate.fingerprint)) return
    write.mutation.mutate({ operation: 'inpatient.order.issue', input: showEstimate ? { ...input, expectedDrgFingerprint: estimate.fingerprint } : input },
      { onSuccess: () => { setPick(null); setFrequency(null); setDose(null); setEstimating(false) } })
  }
  const error=clinical.error ?? catalog.error
  const verificationOrders = data?.orders.filter(order => order.state === 'signed' || order.state === 'stop-requested') ?? []
  const nextVerification = verificationOrders[0]
  const diagnosisBlocked = write.blocked || admission.recordStatus === 'archived' || admission.status === 'registered'
  const issueAction = <Button disabled={blocked || !input || (showEstimate && !estimate.fingerprint)} onClick={issue}>{t('开立医嘱','Issue order')}</Button>
  const doctorBar = !pick && !diagnosed
    ? <WorkspaceActionBar summary={t('确认后才能开立药品医嘱', 'Confirm diagnoses before ordering medications')} action={<Button disabled={diagnosisBlocked} onClick={() => setEditingDiagnosis(true)}>{t('确认住院诊断', 'Confirm diagnoses')}</Button>} />
    : !pick ? <WorkspaceActionBar tone="blocked" reason={t('还差：选择医嘱项目', 'Complete: choose an order item')} action={issueAction} />
      : <WorkspaceActionBar tone={blocked || !input ? 'blocked' : 'normal'}
        reason={rejection ? t(`不能开立：${rejection}`, `Cannot issue: ${rejection}`) : !input ? t('还差：核对每次剂量和频次', 'Complete: check the dose and frequency') : t('开立后交病区护士校对', 'New orders go to the ward nurse for verification')}
        action={<><Button variant="outline" disabled={!draft} aria-expanded={showEstimate} onClick={() => setEstimating(value => !value)}>{estimating ? t('收起费用预计', 'Hide estimate') : t('费用预计', 'Estimate charges')}</Button>{issueAction}</>} />
  if (view === 'fees') return <>{error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(error,messages)}</AlertDescription></Alert> : null}{data ? <InpatientChargeList data={{ admissionId: admission.id, financialStatus: admission.financialStatus, charges: data.charges, chargesFen: data.chargesFen }} locale={locale} /> : null}</>
  return <section aria-label={t('住院诊疗','Inpatient care')} className="flex flex-col gap-4">
    {error ? <Alert variant="destructive"><AlertDescription>{t('诊断医嘱读取失败：', 'Care records failed to load: ')}{getWorkspaceErrorMessage(error,messages)}<Button variant="outline" size="sm" onClick={() => { void clinical.refetch(); void catalog.refetch() }}>{t('重试诊疗记录', 'Retry care records')}</Button></AlertDescription></Alert> : null}
    {clinical.isPending ? <Skeleton className="h-24 w-full" /> : null}
    {data ? <section aria-label={t('住院诊断摘要', 'Inpatient diagnosis summary')} className="clinmesh-inpatient-summary">
      <div className="clinmesh-inpatient-section-heading"><h3>{t('住院诊断', 'Inpatient diagnosis')}</h3>{doctor ? <Button variant="ghost" size="sm" disabled={diagnosisBlocked} aria-haspopup="dialog" onClick={() => setEditingDiagnosis(true)}>{diagnosed ? null : <PlusIcon data-icon="inline-start" />}{diagnosed ? t('修改诊断', 'Edit diagnoses') : t('添加诊断', 'Add diagnosis')}</Button> : null}</div>
      {!diagnosed ? <p className="text-sm text-muted-foreground">{t('尚未确认。先从国家临床版 2022 选定主诊断和入院病情，才能开立药品医嘱。', 'Not confirmed. Select a primary diagnosis and condition on admission from the national clinical edition 2022 before ordering medications.')}</p> : null}
      {data.diagnosis.entries.map(entry => <div key={entry.conditionId} className="clinmesh-inpatient-diagnosis-line"><Badge variant={entry.role === 'primary' ? 'default' : 'outline'}>{entry.role === 'primary' ? t('主诊断', 'Primary') : t('次诊断', 'Secondary')}</Badge><span className="font-medium">{entry.coding.display}</span><span className="text-xs text-muted-foreground tabular-nums">{entry.coding.code}</span><span className="text-sm text-muted-foreground">{t('入院病情：', 'On admission: ')}{inpatientAdmissionConditionLabel(entry.admissionCondition, locale)}</span>{entry.note ? <span className="text-sm text-muted-foreground">{entry.note}</span> : null}</div>)}
      {doctor ? <InpatientDiagnosisEditor key={data.admissionId} data={data} session={session} locale={locale} blocked={diagnosisBlocked} write={write} open={editingDiagnosis} onOpenChange={setEditingDiagnosis} /> : null}
    </section> : null}
    {nurse && data && data.orders.length > 0 ? <InpatientPrimaryAction stage="orders"><WorkspaceActionBar tone={nextVerification ? (nextVerification.state === 'signed' ? blocked : stopBlocked) ? 'blocked' : 'normal' : 'complete'}
      summary={nextVerification ? t(`还差 ${verificationOrders.length} 条医嘱待校对`, `${verificationOrders.length} orders still need verification`) : data.orders.length > 0 ? t('本次医嘱校对已完成', 'Order verification complete') : t('等待住院医生开立医嘱', 'Waiting for inpatient orders')}
      reason={nextVerification?.display ?? (data.orders.some(order => order.state === 'verified') ? t('已校对医嘱按计划发药或执行；PRN 由你逐条填写理由后发起。', 'Verified orders proceed to dispensing or execution. Request PRN execution with a reason for each order.') : undefined)}
      action={nextVerification ? <Button disabled={nextVerification.state === 'signed' ? blocked : stopBlocked} onClick={() => write.mutation.mutate({ operation: nextVerification.state === 'signed' ? 'inpatient.order.verify' : 'inpatient.order.verify-stop', input: { admissionId: admission.id, orderId: nextVerification.id, expectedOrderVersion: nextVerification.version } })}>{nextVerification.state === 'signed' ? t('校对下一条医嘱', 'Verify next order') : t('核对下一条停嘱', 'Verify next stop request')}</Button> : undefined} /></InpatientPrimaryAction> : null}
    <section aria-label={t('住院医嘱', 'Inpatient orders')}>
    {doctor && data ? <h3 className="text-sm font-semibold">{t('住院医嘱', 'Inpatient orders')} <span className="tabular-nums">{t(`${data.orders.length} 条`, String(data.orders.length))}</span></h3> : null}
    {data?.orders.map(order=>{
      const orderExecutions = data.executions.filter(execution => execution.orderId === order.id)
      const completedExecutions = orderExecutions.filter(execution => execution.status === 'completed').length
      return <InpatientItemRow key={order.id} title={order.display} badge={<Badge variant="outline">{order.duration==='long'?t('长期','Long'):t('临时','Temporary')}</Badge>}
      metadata={<>{order.kind === 'medication' ? <><span>{t('每次 ','Per dose ')}{order.doseText}{order.doseText.replace(/\s/g, '') === `${order.doseQuantity}${order.unit}` ? null : `（${order.doseQuantity}${order.unit}）`}</span><span>{inpatientFrequencyLabel(order.frequencyCode, locale)}</span></> : <span>{t('每次 ','Per execution ')}{order.doseQuantity}{order.unit}</span>}{orderExecutions.length > 0 ? <span className="tabular-nums">{t(`已执行 ${completedExecutions}/${orderExecutions.length} 次`, `Executed ${completedExecutions}/${orderExecutions.length}`)}</span> : null}{order.surgeryExecutionId ? <span>{t('术后医嘱 · ','Postoperative order · ')}{surgery.data?.executions.find(item=>item.id===order.surgeryExecutionId)?.actualProcedure.coding.display ?? t('已关联手术', 'Linked procedure')}</span> : null}</>}
      complete={order.state === 'stopped' || order.state === 'completed'} actions={<><Badge variant="outline">{{signed:t('待校对','Awaiting verification'),verified:t('已校对','Verified'),'stop-requested':t('待停嘱核对','Stop requested'),stopped:t('已停止','Stopped'),completed:t('已结束','Finished')}[order.state]}</Badge>
        {nurse && order.state==='signed' ? <Button disabled={blocked} onClick={()=>write.mutation.mutate({operation:'inpatient.order.verify',input:{admissionId:admission.id,orderId:order.id,expectedOrderVersion:order.version}})}>{t('校对医嘱','Verify order')}</Button>:null}
        {doctor && ['signed','verified'].includes(order.state) ? <Button variant="outline" disabled={stopBlocked} aria-expanded={reasonOrderId === order.id} onClick={() => setReasonOrderId(reasonOrderId === order.id ? null : order.id)}>{t('申请停嘱','Request stop')}</Button>:null}
        {nurse && order.state==='stop-requested' ? <Button disabled={stopBlocked} onClick={()=>write.mutation.mutate({operation:'inpatient.order.verify-stop',input:{admissionId:admission.id,orderId:order.id,expectedOrderVersion:order.version}})}>{t('核对停嘱','Verify stop')}</Button>:null}
        {nurse && order.state==='verified' && order.frequencyCode==='PRN' ? <Button disabled={blocked} aria-expanded={reasonOrderId === order.id} onClick={() => setReasonOrderId(reasonOrderId === order.id ? null : order.id)}>{t('按需给药','Request PRN execution')}</Button>:null}
      </>}>
      {doctor && reasonOrderId === order.id ? <Field><FieldLabel htmlFor="inpatient-order-reason">{t('停嘱理由', 'Reason for stopping')}</FieldLabel><Input id="inpatient-order-reason" maxLength={2000} value={reason} onChange={event => setReason(event.currentTarget.value)} /><FieldDescription>{t('提交后由病区护士核对生效。', 'The ward nurse verifies the stop before it takes effect.')}</FieldDescription>
        <InpatientPrimaryAction stage="orders" priority={30}><WorkspaceActionBar summary={order.display} reason={!reason.trim() ? t('还差：停嘱理由', 'Complete: reason for stopping') : t('护士核对后生效', 'Takes effect after nurse verification')} tone={stopBlocked || !reason.trim() ? 'blocked' : 'normal'}
          action={<><Button variant="outline" onClick={() => setReasonOrderId(null)}>{t('取消', 'Cancel')}</Button><Button disabled={stopBlocked || !reason.trim()} onClick={() => write.mutation.mutate({ operation: 'inpatient.order.request-stop', input: { admissionId: admission.id, orderId: order.id, expectedOrderVersion: order.version, reason } }, { onSuccess: () => { setReasonOrderId(null); setReason('') } })}>{t('确认申请停嘱', 'Confirm stop request')}</Button></>} /></InpatientPrimaryAction></Field> : null}
      {nurse && reasonOrderId === order.id ? <div className="flex flex-col gap-2"><Field><FieldLabel htmlFor="inpatient-order-reason">{t('按需执行理由', 'Reason for PRN execution')}</FieldLabel><Input id="inpatient-order-reason" maxLength={2000} value={reason} onChange={event => setReason(event.currentTarget.value)} /></Field><div className="flex flex-wrap gap-2"><InpatientPrimaryAction stage="orders" priority={30}><WorkspaceActionBar summary={order.display} reason={!reason.trim() ? t('还差：按需执行理由。', 'Enter a reason for PRN execution.') : undefined} tone={blocked || !reason.trim() ? 'blocked' : 'normal'} action={<Button disabled={blocked || !reason.trim()} onClick={() => write.mutation.mutate({ operation: 'inpatient.execution.request-prn', input: { admissionId: admission.id, orderId: order.id, expectedOrderVersion: order.version, reason } }, { onSuccess: () => { setReasonOrderId(null); setReason('') } })}>{t('确认按需给药', 'Confirm PRN execution')}</Button>} /></InpatientPrimaryAction><Button variant="ghost" onClick={() => setReasonOrderId(null)}>{t('收起', 'Close')}</Button></div></div> : null}
      <AgentReviewAnchor id={inpatientOrderAnchor(admission.id, order.id)} />
    </InpatientItemRow>})}
    {data?.orders.length === 0 ? <p className="rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground">{t('暂无在用医嘱。开立后交病区护士校对。', 'No active inpatient orders. New orders go to the ward nurse for verification.')}</p> : null}
    </section>
    {data && data.executions.length > 0 ? <details open={!doctor} className="clinmesh-inpatient-disclosure"><summary>{t('执行记录', 'Execution records')} <span className="tabular-nums">{data.executions.length}</span></summary><div>
    {data?.executions.map(execution=>{
      const order=data.orders.find(order=>order.id===execution.orderId)!
      const valid = !blocked && order.state==='verified'
      const due = scenario.data !== undefined && Date.parse(execution.scheduledFor) <= Date.parse(scenario.data.virtualTime)
      const availableAt = new Date(execution.scheduledFor).toLocaleTimeString(zh ? 'zh-CN' : 'en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
      return <InpatientItemRow key={execution.id} title={order.display} complete={execution.status === 'completed'} badge={<Badge variant="outline">{{pending:t('待执行','Pending'),dispensed:t('已发药','Dispensed'),completed:t('已完成','Completed'),cancelled:t('已取消','Cancelled')}[execution.status]}</Badge>} metadata={<span>{formatShanghaiMinute(execution.scheduledFor)} · {order.doseQuantity}{order.unit}</span>} actions={<>
        {nurse && execution.status === 'dispensed' && !due ? <p role="status">{scenario.data ? t(`${availableAt} 后可给药`, `Medication can be administered after ${availableAt}`) : t('正在核对给药时间', 'Checking administration time')}</p> : null}
        {nurse && execution.status==='dispensed' ? <Button disabled={!valid || !due} onClick={()=>write.mutation.mutate({operation:'inpatient.execution.administer',input:{admissionId:admission.id,executionId:execution.id,expectedExecutionVersion:execution.version}})}>{t('给药','Administer')}</Button>:null}
        {nurse && execution.status==='pending' && order.kind==='service' ? <Button disabled={!valid || !due} onClick={()=>write.mutation.mutate({operation:'inpatient.execution.complete',input:{admissionId:admission.id,executionId:execution.id,expectedExecutionVersion:execution.version}})}>{t('完成健康教育','Complete education')}</Button>:null}
      </>} />
    })}</div></details> : null}
    {doctor ? <section aria-label={t('开立医嘱', 'Issue order')} className="flex flex-col gap-3"><h3 className="text-sm font-semibold">{t('开立医嘱','Issue order')}</h3>
      <Field><FieldLabel htmlFor="inpatient-order-item">{t('医嘱项目','Order item')}</FieldLabel>
        <InpatientOrderPicker id="inpatient-order-item" session={session} locale={locale} services={catalog.data?.services ?? []} diagnosed={diagnosed} disabled={blocked} picked={pick} onPick={choose} />
        {diagnosed ? null : <FieldDescription>{t('药品按住院诊断核对适应症；确认诊断前只能开护理项目。', 'Medications are checked against the admission diagnoses; only nursing items can be ordered before confirming them.')}</FieldDescription>}</Field>
      <FieldSet disabled={blocked}><FieldLegend className="sr-only">{t('医嘱用法', 'Order instructions')}</FieldLegend><FieldGroup className="clinmesh-inpatient-order-fields">
      <Field data-disabled={!pick || undefined}><FieldLabel htmlFor="inpatient-order-duration">{t('医嘱时效','Order duration')}</FieldLabel><ToggleGroup id="inpatient-order-duration" aria-label={t('医嘱时效', 'Order duration')} disabled={!pick} value={[duration]} variant="outline" data-view-switch="" onValueChange={values => { if (values[0] === 'long' || values[0] === 'temporary') setDuration(values[0]) }}><ToggleGroupItem value="long">{t('长期', 'Long')}</ToggleGroupItem><ToggleGroupItem value="temporary">{t('临时', 'Temporary')}</ToggleGroupItem></ToggleGroup></Field>
      <Field data-disabled={!medication || undefined}><FieldLabel htmlFor="inpatient-order-frequency">{t('医嘱频次','Order frequency')}</FieldLabel>
        {medication && medication.frequencyCodes.length > 1 ? <WorkspaceSelect id="inpatient-order-frequency" value={selectedFrequency??null} items={medication.frequencyCodes.map(code=>({value:code,label:inpatientFrequencyLabel(code, locale)}))} onValueChange={setFrequency} />
          : <p id="inpatient-order-frequency" className={medication || service ? 'flex h-8 items-center text-sm' : 'flex h-8 items-center rounded-lg border border-dashed px-2.5 text-sm'}>{medication && selectedFrequency ? inpatientFrequencyLabel(selectedFrequency, locale) : service ? t('不适用', 'Not applicable') : <span className="text-muted-foreground">{t('选择项目后显示', 'Shown after choosing an item')}</span>}</p>}</Field>
      <Field data-disabled={!medication || undefined} data-invalid={selectedDose && 'reason' in selectedDose}><FieldLabel htmlFor="inpatient-order-dose">{t('每次剂量','Dose per execution')}</FieldLabel>
        <div className="relative"><Input id="inpatient-order-dose" className={medication ? 'pe-16' : 'disabled:border-dashed disabled:bg-transparent'} disabled={!medication} placeholder={service ? t('1 次', '1 time') : t('选择项目后填写', 'Enter after choosing an item')} value={medication ? doseText : ''} required={medication !== undefined} maxLength={120} aria-invalid={selectedDose !== undefined && 'reason' in selectedDose} aria-describedby={medication ? 'inpatient-order-dose-result' : undefined} onChange={event=>setDose(event.currentTarget.value)} />
          {medication && selectedDose && 'quantity' in selectedDose ? <span id="inpatient-order-dose-result" aria-live="polite" className="pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground tabular-nums">= {selectedDose.quantity} {medication.unit}</span> : null}</div>
        {medication && selectedDose && 'reason' in selectedDose ? <p id="inpatient-order-dose-result" aria-live="polite" className="text-xs text-destructive">{doseError(selectedDose, zh)}</p> : null}</Field>
      {surgery.data?.executions.length || surgeryId ? <Field className="clinmesh-inpatient-order-extra"><FieldLabel htmlFor="inpatient-postoperative">{t('术后关联手术','Postoperative procedure')}</FieldLabel><WorkspaceSelect id="inpatient-postoperative" value={surgeryId ?? ''} items={[{value:'',label:t('普通医嘱','Regular order')},...(surgery.data?.executions ?? []).map(item=>({value:item.id,label:`${item.actualProcedure.coding.code} · ${item.actualProcedure.coding.display}`}))]} onValueChange={setSurgeryId} /></Field> : null}
      </FieldGroup></FieldSet>
      {rejection ? <div role="alert" className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
        <p><strong>{t(`不能开立${pick ? ` ${pick.item.display}` : ''}：`, `Cannot issue${pick ? ` ${pick.item.display}` : ''}: `)}</strong>{rejection}</p>
        <p className="text-muted-foreground">{t('需要的话先在住院诊断里补上对应诊断，再重新开立。', 'If needed, add the matching diagnosis first, then issue again.')}</p>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setEditingDiagnosis(true)}>{t('修改诊断', 'Edit diagnoses')}</Button><Button size="sm" variant="ghost" onClick={() => choose(null)}>{t('换一个项目', 'Choose another item')}</Button></div>
      </div> : null}
      {showEstimate ? <OrderEstimate estimate={estimate} locale={locale} /> : null}
      <InpatientPrimaryAction stage="orders" priority={pick || !diagnosed ? 20 : -10} fallback={null}>{doctorBar}</InpatientPrimaryAction>
    </section> : null}
  </section>
}

function doseError(result: Exclude<InpatientDoseResult, { quantity: number }>, zh: boolean) {
  const messages = {
    'invalid-dose': ['请填写有效的每次剂量和单位', 'Enter a valid dose and unit'],
    'missing-conversion': ['缺少该剂量单位的明确换算关系，可按制剂单位填写', 'This dose unit has no confirmed conversion; enter preparation units'],
    'unit-mismatch': ['本次剂量单位与已声明的换算不匹配', 'The dose unit does not match the declared conversion'],
    'fractional-quantity': ['本次用量无法换算为完整制剂数量', 'The dose does not convert to whole preparation units'],
    'dose-limit': ['本次用量超过已声明的每次上限', 'The dose exceeds the declared limit per execution'],
  }
  return messages[result.reason][zh ? 0 : 1]
}
