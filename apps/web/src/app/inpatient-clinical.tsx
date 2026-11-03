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
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { InpatientDiagnosisEditor } from './inpatient-diagnosis-editor.tsx'
import { InpatientCatalogPicker } from './inpatient-catalog-picker.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { DrgError, DrgStaleNotice, InpatientDrgPanel, type DrgReview, type DrgEvaluationState } from './inpatient-drg.tsx'
import { formatFen } from './workspace-format.ts'
import { AgentReviewAnchor } from './agent-review.tsx'
import { inpatientOrderAnchor } from './inpatient-agent-tools.tsx'
import { InpatientConfirmation } from './inpatient-confirmation.tsx'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import { Skeleton } from '@clinmesh/ui/components/skeleton'

export function InpatientClinical({ admission, session, locale, write, view = 'orders', active = true }: { view?: 'orders' | 'fees'; active?: boolean; admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent> }): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const checkingMessage = t('正在核对评估，暂不可确认。', 'Checking the assessment; confirmation is temporarily unavailable.')
  const doctor = session.actor.roleCode === 'inpatient-doctor', nurse = session.actor.roleCode === 'ward-nurse'
  const scope = ['inpatient',session.actor.workspaceId,session.actor.epoch,session.actor.practitionerRoleId]
  const messages = getWorkspaceMessages(locale)
  const clinical = useQuery({ queryKey: [...scope,admission.id,'clinical'], queryFn: ({signal}) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/clinical`,inpatientFullClinicalSchema,signal) })
  const scenario = useQuery({ queryKey: ['scenario', 'virtual-time'], enabled: nurse,
    queryFn: ({ signal }) => apiGet('/api/sim/v1/scenario-runs/current', scenarioStateSchema, signal), retry: false })
  const catalog = useQuery({ queryKey: [...scope,'clinical-catalog'], enabled: (doctor || nurse) && view === 'orders', queryFn: ({signal}) => apiGet('/api/his/v1/inpatient/clinical-catalog',inpatientFullCatalogSchema,signal) })
  const [itemId,setItemId] = useState<string|null>(null), [duration,setDuration] = useState<'long'|'temporary'>('long')
  const [frequency,setFrequency] = useState<'QD'|'BID'|'PRN'|null>(null), [dose,setDose] = useState<string|null>(null)
  const [surgeryId,setSurgeryId] = useState<string|null>(null)
  const [editingDiagnosis, setEditingDiagnosis] = useState(false), [reasonOrderId, setReasonOrderId] = useState<string | null>(null)
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const reason = reasonOrderId ? reasons[reasonOrderId] ?? '' : ''
  const setReason = (value: string) => { if (reasonOrderId) setReasons(previous => ({ ...previous, [reasonOrderId]: value })) }
  const [evaluate, setEvaluate] = useState(false)
  const [evaluation, setEvaluation] = useState<DrgEvaluationState>()
  const [review, setReview] = useState<{ input: z.infer<typeof inpatientOrderIssueInputSchema>; display: string; assessment: DrgReview }>()
  const reviewCurrent = evaluation?.reviewable === true && review?.assessment.fingerprint === evaluation.fingerprint
  const surgery = useQuery({ queryKey: [...scope,admission.id,'surgeries'], enabled: doctor && view === 'orders', queryFn: ({signal}) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/surgeries`,inpatientSurgerySchema,signal) })
  const medication = catalog.data?.medications.find(item => item.id === itemId), service = catalog.data?.services.find(item => item.id === itemId)
  const doseText = dose ?? medication?.doses[0]?.doseText ?? ''
  const selectedDose = medication ? resolveInpatientDose({ unit: medication.unit, doses: medication.doses,
    ...(medication.doseBasis ? { doseBasis: medication.doseBasis } : {}),
    ...(medication.maxDoseQuantity === undefined ? {} : { maxDoseQuantity: medication.maxDoseQuantity }) }, doseText) : undefined
  const selectedFrequency = frequency !== null && medication?.frequencyCodes.includes(frequency) ? frequency : medication?.frequencyCodes[0]
  const data = clinical.data, blocked = write.blocked || admission.status !== 'admitted'
  const stopBlocked = write.blocked || !['admitted','discharge-pending'].includes(admission.status)
  const orderInput = (): z.infer<typeof inpatientOrderIssueInputSchema> | undefined => {
    if (!data) return undefined
    const common={admissionId:admission.id,encounterVersion:data.encounterVersion,duration,...(surgeryId ? {surgeryExecutionId:surgeryId} : {})}
    if (medication && selectedDose && 'quantity' in selectedDose && selectedFrequency) return {...common,selection:{kind:'medication',catalogItemId:medication.id,catalogVersion:medication.version,doseText,doseQuantity:selectedDose.quantity,frequencyCode:selectedFrequency}}
    if(service) return {...common,selection:{kind:'service',serviceId:service.id,serviceVersion:service.version,quantity:1}}
    return undefined
  }
  const issue = () => { const input = orderInput(); if (input) write.mutation.mutate({ operation: 'inpatient.order.issue', input }) }
  const input = orderInput()
  const draft: InpatientDrgSimulationInput | undefined = input?.selection.kind === 'medication'
    ? { medications: [{ catalogItemId: input.selection.catalogItemId, catalogVersion: input.selection.catalogVersion, doseText: input.selection.doseText, doseQuantity: input.selection.doseQuantity, frequencyCode: input.selection.frequencyCode }], services: [] }
    : input?.selection.kind === 'service' ? { medications: [], services: [{ serviceId: input.selection.serviceId, serviceVersion: input.selection.serviceVersion, quantity: input.selection.quantity }] } : undefined
  const error=clinical.error ?? catalog.error
  const orderFormId = `${admission.id}-order-form`
  const orderAction = <Button type="submit" form={orderFormId} disabled={blocked || !input}>{t('开立医嘱','Issue order')}</Button>
  const verificationOrders = data?.orders.filter(order => order.state === 'signed' || order.state === 'stop-requested') ?? []
  const nextVerification = verificationOrders[0]
  if (view === 'fees') return <>{error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(error,messages)}</AlertDescription></Alert> : null}{data ? <InpatientChargeList data={{ admissionId: admission.id, financialStatus: admission.financialStatus, charges: data.charges, chargesFen: data.chargesFen }} locale={locale} /> : null}</>
  return <section aria-label={t('住院诊疗','Inpatient care')} className="flex flex-col gap-4">
    {error ? <Alert variant="destructive"><AlertDescription>{t('诊断医嘱读取失败：', 'Care records failed to load: ')}{getWorkspaceErrorMessage(error,messages)}<Button variant="outline" size="sm" onClick={() => { void clinical.refetch(); void catalog.refetch() }}>{t('重试诊疗记录', 'Retry care records')}</Button></AlertDescription></Alert> : null}
    {clinical.isPending ? <Skeleton className="h-24 w-full" /> : null}
    {data ? <section aria-label={t('住院诊断摘要', 'Inpatient diagnosis summary')} className="clinmesh-inpatient-summary">
      <div className="clinmesh-inpatient-section-heading"><h3>{t('住院诊断', 'Inpatient diagnosis')}</h3>{doctor ? <Button variant="ghost" size="sm" aria-expanded={editingDiagnosis} aria-controls={`${admission.id}-diagnosis-editor`} onClick={() => setEditingDiagnosis(value => !value)}>{editingDiagnosis ? t('收起诊断编辑', 'Close diagnosis editor') : t('修改诊断', 'Edit diagnosis')}</Button> : null}</div>
      {data.diagnosis.entries.length === 0 ? <p className="text-sm text-muted-foreground">{t('尚未确认住院诊断。', 'No confirmed inpatient diagnosis.')}</p> : null}
      {data.diagnosis.entries.map(entry => <div key={entry.conditionId} className="clinmesh-inpatient-diagnosis-line"><span className="font-medium">{entry.coding.display}</span><Badge variant="outline">{entry.role === 'primary' ? t('主诊断', 'Primary') : t('次诊断', 'Secondary')}</Badge><span className="text-sm text-muted-foreground">{t('入院病情：', 'On admission: ')}{{ '1': t('有', 'Present'), '2': t('临床未确定', 'Clinically undetermined'), '3': t('情况不明', 'Unknown'), '4': t('无', 'Absent') }[entry.admissionCondition]}</span>{entry.note ? <span className="text-sm text-muted-foreground">{entry.note}</span> : null}</div>)}
      {doctor ? <div id={`${admission.id}-diagnosis-editor`} hidden={!editingDiagnosis} className="mt-3"><InpatientDiagnosisEditor data={data} diagnoses={catalog.data?.diagnoses ?? []} session={session} locale={locale} active={editingDiagnosis} blocked={write.blocked || admission.recordStatus === 'archived' || admission.status === 'registered'} write={write} /></div> : null}
    </section> : null}
    {nurse && data && data.orders.length > 0 ? <InpatientPrimaryAction stage="orders"><WorkspaceActionBar tone={nextVerification ? (nextVerification.state === 'signed' ? blocked : stopBlocked) ? 'blocked' : 'normal' : 'complete'}
      summary={nextVerification ? t(`还差 ${verificationOrders.length} 条医嘱待校对`, `${verificationOrders.length} orders still need verification`) : data.orders.length > 0 ? t('本次医嘱校对已完成', 'Order verification complete') : t('等待住院医生开立医嘱', 'Waiting for inpatient orders')}
      reason={nextVerification?.display ?? (data.orders.some(order => order.state === 'verified') ? t('已校对医嘱按计划发药或执行；PRN 由你逐条填写理由后发起。', 'Verified orders proceed to dispensing or execution. Request PRN execution with a reason for each order.') : undefined)}
      action={nextVerification ? <Button disabled={nextVerification.state === 'signed' ? blocked : stopBlocked} onClick={() => write.mutation.mutate({ operation: nextVerification.state === 'signed' ? 'inpatient.order.verify' : 'inpatient.order.verify-stop', input: { admissionId: admission.id, orderId: nextVerification.id, expectedOrderVersion: nextVerification.version } })}>{nextVerification.state === 'signed' ? t('校对下一条医嘱', 'Verify next order') : t('核对下一条停嘱', 'Verify next stop request')}</Button> : undefined} /></InpatientPrimaryAction> : null}
    <section aria-label={t('住院医嘱', 'Inpatient orders')}>
    {data?.orders.map(order=><InpatientItemRow key={order.id} title={order.display} badge={<Badge variant="outline">{order.duration==='long'?t('长期','Long'):t('临时','Temporary')}</Badge>}
      metadata={<><span>{order.doseText} · {t('每次','Per execution ')}{order.doseQuantity}{order.unit} · {order.frequencyCode}</span>{order.surgeryExecutionId ? <span>{t('术后医嘱 · ','Postoperative order · ')}{surgery.data?.executions.find(item=>item.id===order.surgeryExecutionId)?.actualProcedure.coding.display ?? t('已关联手术', 'Linked procedure')}</span> : null}</>}
      complete={order.state === 'stopped' || order.state === 'completed'} actions={<><Badge variant="outline">{{signed:t('待校对','Awaiting verification'),verified:t('已校对','Verified'),'stop-requested':t('待停嘱核对','Stop requested'),stopped:t('已停止','Stopped'),completed:t('已结束','Finished')}[order.state]}</Badge>
        {nurse && order.state==='signed' ? <Button disabled={blocked} onClick={()=>write.mutation.mutate({operation:'inpatient.order.verify',input:{admissionId:admission.id,orderId:order.id,expectedOrderVersion:order.version}})}>{t('校对医嘱','Verify order')}</Button>:null}
        {doctor && ['signed','verified'].includes(order.state) ? <Button variant="outline" disabled={stopBlocked} aria-expanded={reasonOrderId === order.id} onClick={() => setReasonOrderId(reasonOrderId === order.id ? null : order.id)}>{t('申请停嘱','Request stop')}</Button>:null}
        {nurse && order.state==='stop-requested' ? <Button disabled={stopBlocked} onClick={()=>write.mutation.mutate({operation:'inpatient.order.verify-stop',input:{admissionId:admission.id,orderId:order.id,expectedOrderVersion:order.version}})}>{t('核对停嘱','Verify stop')}</Button>:null}
        {nurse && order.state==='verified' && order.frequencyCode==='PRN' ? <Button disabled={blocked} aria-expanded={reasonOrderId === order.id} onClick={() => setReasonOrderId(reasonOrderId === order.id ? null : order.id)}>{t('按需给药','Request PRN execution')}</Button>:null}
      </>}>
      {(doctor || nurse) && reasonOrderId === order.id ? <div className="flex flex-col gap-2"><Field><FieldLabel htmlFor="inpatient-order-reason">{doctor ? t('停嘱理由', 'Reason for stopping') : t('按需执行理由', 'Reason for PRN execution')}</FieldLabel><Input id="inpatient-order-reason" maxLength={2000} value={reason} onChange={event => setReason(event.currentTarget.value)} /></Field><div className="flex flex-wrap gap-2"><InpatientPrimaryAction stage="orders" priority={30}><WorkspaceActionBar summary={order.display} reason={!reason.trim() ? doctor ? t('还差：停嘱理由。', 'Enter a reason for stopping.') : t('还差：按需执行理由。', 'Enter a reason for PRN execution.') : undefined} tone={(doctor ? stopBlocked : blocked) || !reason.trim() ? 'blocked' : 'normal'} action={<Button disabled={(doctor ? stopBlocked : blocked) || !reason.trim()} onClick={() => write.mutation.mutate({ operation: doctor ? 'inpatient.order.request-stop' : 'inpatient.execution.request-prn', input: { admissionId: admission.id, orderId: order.id, expectedOrderVersion: order.version, reason } }, { onSuccess: () => { setReasonOrderId(null); setReason('') } })}>{doctor ? t('确认申请停嘱', 'Confirm stop request') : t('确认按需给药', 'Confirm PRN execution')}</Button>} /></InpatientPrimaryAction><Button variant="ghost" onClick={() => setReasonOrderId(null)}>{t('收起', 'Close')}</Button></div></div> : null}
      <AgentReviewAnchor id={inpatientOrderAnchor(admission.id, order.id)} />
    </InpatientItemRow>)}
    {data?.orders.length === 0 ? <p className="text-sm text-muted-foreground">{t('暂无住院医嘱。开立后交病区护士校对。', 'No inpatient orders. New orders go to the ward nurse for verification.')}</p> : null}
    </section>
    {data && data.executions.length > 0 ? <details open={!doctor} className="clinmesh-inpatient-disclosure"><summary>{t('执行记录', 'Execution records')} <span className="tabular-nums">{data.executions.length}</span></summary><div>
    {data?.executions.map(execution=>{
      const order=data.orders.find(order=>order.id===execution.orderId)!
      const valid = !blocked && order.state==='verified'
      const due = scenario.data !== undefined && Date.parse(execution.scheduledFor) <= Date.parse(scenario.data.virtualTime)
      const availableAt = new Date(execution.scheduledFor).toLocaleTimeString(zh ? 'zh-CN' : 'en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
      return <InpatientItemRow key={execution.id} title={order.display} complete={execution.status === 'completed'} badge={<Badge variant="outline">{{pending:t('待执行','Pending'),dispensed:t('已发药','Dispensed'),completed:t('已完成','Completed'),cancelled:t('已取消','Cancelled')}[execution.status]}</Badge>} metadata={<span>{new Date(execution.scheduledFor).toLocaleString(zh?'zh-CN':'en-US',{timeZone:'Asia/Shanghai'})} · {order.doseQuantity}{order.unit}</span>} actions={<>
        {nurse && execution.status === 'dispensed' && !due ? <p role="status">{scenario.data ? t(`${availableAt} 后可给药`, `Medication can be administered after ${availableAt}`) : t('正在核对给药时间', 'Checking administration time')}</p> : null}
        {nurse && execution.status==='dispensed' ? <Button disabled={!valid || !due} onClick={()=>write.mutation.mutate({operation:'inpatient.execution.administer',input:{admissionId:admission.id,executionId:execution.id,expectedExecutionVersion:execution.version}})}>{t('给药','Administer')}</Button>:null}
        {nurse && execution.status==='pending' && order.kind==='service' ? <Button disabled={!valid || !due} onClick={()=>write.mutation.mutate({operation:'inpatient.execution.complete',input:{admissionId:admission.id,executionId:execution.id,expectedExecutionVersion:execution.version}})}>{t('完成健康教育','Complete education')}</Button>:null}
      </>} />
    })}</div></details> : null}
    {doctor ? <section aria-label={t('开立医嘱', 'Issue order')} className="flex flex-col gap-3"><h3 className="text-sm font-semibold">{t('开立医嘱','Issue order')}</h3>
      <div className="clinmesh-inpatient-order-selection"><Field><FieldLabel htmlFor="inpatient-order-item">{t('医嘱项目','Order item')}</FieldLabel><WorkspaceSelect id="inpatient-order-item" disabled={blocked} value={itemId} items={[...(catalog.data?.medications??[]),...(catalog.data?.services??[])].map(item=>({value:item.id,label:item.display}))} onValueChange={value=>{setItemId(value);setFrequency(null);setDose(null)}} /></Field><InpatientCatalogPicker kind="medication" session={session} locale={locale} disabled={blocked} onSelect={id => { setItemId(id); setFrequency(null); setDose(null); void catalog.refetch() }} /></div>
      <form id={orderFormId} onSubmit={event=>{event.preventDefault();issue()}}><FieldSet disabled={blocked}><FieldLegend className="sr-only">{t('医嘱用法', 'Order instructions')}</FieldLegend><FieldGroup className="clinmesh-inpatient-order-fields">
      <Field><FieldLabel htmlFor="inpatient-order-duration">{t('医嘱时效','Order duration')}</FieldLabel><ToggleGroup id="inpatient-order-duration" aria-label={t('医嘱时效', 'Order duration')} value={[duration]} variant="outline" data-view-switch="" onValueChange={values => { if (values[0] === 'long' || values[0] === 'temporary') setDuration(values[0]) }}><ToggleGroupItem value="long">{t('长期', 'Long')}</ToggleGroupItem><ToggleGroupItem value="temporary">{t('临时', 'Temporary')}</ToggleGroupItem></ToggleGroup></Field>
      {medication ? <><Field><FieldLabel htmlFor="inpatient-order-frequency">{t('医嘱频次','Order frequency')}</FieldLabel><WorkspaceSelect id="inpatient-order-frequency" value={selectedFrequency??null} items={medication.frequencyCodes.map(code=>({value:code,label:code==='QD'?'QD · 08:00':code==='BID'?'BID · 08:00 / 20:00':t('PRN · 按需','PRN · as needed')}))} onValueChange={setFrequency} /></Field>
      <Field data-invalid={selectedDose && 'reason' in selectedDose}><FieldLabel htmlFor="inpatient-order-dose">{t('每次剂量','Dose per execution')}</FieldLabel><Input id="inpatient-order-dose" value={doseText} required maxLength={120} aria-invalid={selectedDose !== undefined && 'reason' in selectedDose} onChange={event=>setDose(event.currentTarget.value)} />
      {selectedDose ? <p aria-live="polite">{'quantity' in selectedDose ? `${t('每次','Per execution ')}${selectedDose.quantity}${medication.unit}` : doseError(selectedDose, zh)}</p> : null}
      <p className="text-xs text-muted-foreground">{t('可填写明确剂量或制剂数量，例如','Enter a dose or preparation quantity, for example ')}{medication.doses[0]?.doseText ?? `1${medication.unit}`} / {`1${medication.unit}`}</p></Field></> : null}
      {surgery.data?.executions.length || surgeryId ? <Field className="clinmesh-inpatient-order-extra"><FieldLabel htmlFor="inpatient-postoperative">{t('术后关联手术','Postoperative procedure')}</FieldLabel><WorkspaceSelect id="inpatient-postoperative" value={surgeryId ?? ''} items={[{value:'',label:t('普通医嘱','Regular order')},...(surgery.data?.executions ?? []).map(item=>({value:item.id,label:`${item.actualProcedure.coding.code} · ${item.actualProcedure.coding.display}`}))]} onValueChange={setSurgeryId} /></Field> : null}
      <InpatientPrimaryAction stage="orders" priority={input ? 20 : -10} fallback={orderAction}><WorkspaceActionBar tone={blocked || !input ? 'blocked' : 'normal'} summary={t('开立后交病区护士校对', 'New orders go to the ward nurse for verification')}
        reason={!input ? t('还差：选择医嘱项目并核对剂量、频次。', 'Select an order item and check its dose and frequency.') : undefined} action={orderAction} /></InpatientPrimaryAction>
      <div className="clinmesh-inpatient-order-extra"><Button type="button" variant="outline" disabled={blocked || !draft} onClick={() => setEvaluate(value => !value)}>{evaluate ? t('收起当前医嘱预计','Hide order estimate') : t('预计当前医嘱','Estimate current order')}</Button></div>
    </FieldGroup></FieldSet></form></section> : null}
    {doctor && evaluate && draft ? <InpatientDrgPanel admission={admission} session={session} locale={locale} write={write} draft={draft} active={active} reservations={false} {...(review ? { onEvaluationChange: setEvaluation } : {})} onReview={assessment => { const frozenInput = orderInput(); if (frozenInput) setReview({ input: { ...frozenInput, expectedDrgFingerprint: assessment.fingerprint }, display: medication?.display ?? service?.display ?? '', assessment }) }} /> : null}
    {review ? <InpatientConfirmation locale={locale} title={t('确认预计后的医嘱','Confirm reviewed order')}
      description={t('核对当前医嘱和费用预计。提交时将重新核验诊疗、费用和目录修订；变化后需重新预计。','Review the selected order and charge estimate. Care, charges and catalog revisions will be checked again when submitting.')}
      confirmLabel={t('确认开立医嘱','Confirm order')} pending={write.mutation.isPending} disabled={write.blocked || !reviewCurrent}
      onCancel={() => setReview(undefined)} onConfirm={() => { if (reviewCurrent) write.mutation.mutate({ operation: 'inpatient.order.issue', input: review.input }, { onSuccess: () => setReview(undefined) }) }}>
      <p>{review.display} · {review.input.duration === 'temporary' ? t('临时','Temporary') : t('长期','Long')}</p>
      <p>{review.input.selection.kind === 'medication' ? `${review.input.selection.doseText} · ${review.input.selection.frequencyCode}` : `${t('数量 ','Quantity ')}${review.input.selection.quantity}`}</p>
      <p>{t('当前病组 ','Current group ')}{review.assessment.drgCode ?? t('未确定','Undetermined')} · {t('预计总额 ','Estimated charges ')}{formatFen(review.assessment.estimatedTotalFen, locale)}</p>
      <DrgError error={write.mutation.error} locale={locale} />{evaluation?.stale ? <DrgStaleNotice locale={locale} /> : !reviewCurrent ? <p role="status">{checkingMessage}</p> : null}
    </InpatientConfirmation> : null}
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
