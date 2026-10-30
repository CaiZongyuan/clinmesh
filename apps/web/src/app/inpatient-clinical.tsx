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
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@clinmesh/ui/components/alert-dialog'
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
  const [reason,setReason] = useState(''), [surgeryId,setSurgeryId] = useState<string|null>(null)
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
  if (view === 'fees') return <>{error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(error,messages)}</AlertDescription></Alert> : null}{data ? <InpatientChargeList data={{ admissionId: admission.id, financialStatus: admission.financialStatus, charges: data.charges, chargesFen: data.chargesFen }} locale={locale} /> : null}</>
  return <section aria-label={t('住院诊疗','Inpatient care')} className="flex flex-col gap-4">
    {error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(error,messages)}</AlertDescription></Alert> : null}
    <h3 className="text-base font-semibold">{t('诊断与医嘱','Diagnoses and orders')}</h3>
    {clinical.isPending ? <p>{t('正在加载诊疗记录','Loading care')}</p> : null}
    {data?.diagnosis.entries.map(entry => <p key={entry.conditionId}>{entry.role==='primary' ? t('主诊断：','Primary: ') : t('次诊断：','Secondary: ')}{entry.coding.display}</p>)}
    {doctor && data ? <InpatientDiagnosisEditor data={data} diagnoses={catalog.data?.diagnoses ?? []} session={session} locale={locale} blocked={write.blocked || admission.recordStatus === 'archived' || admission.status === 'registered'} write={write} /> : null}
    {doctor ? <InpatientCatalogPicker kind="medication" session={session} locale={locale} disabled={blocked}
      onSelect={id => { setItemId(id); setFrequency(null); setDose(null); void catalog.refetch() }} /> : null}
    {doctor ? <form onSubmit={event=>{event.preventDefault();issue()}}><FieldSet disabled={blocked}><FieldLegend>{t('开立医嘱','Issue order')}</FieldLegend><FieldGroup className="grid gap-3 md:grid-cols-2">
      <Field><FieldLabel htmlFor="inpatient-order-item">{t('医嘱项目','Order item')}</FieldLabel><WorkspaceSelect id="inpatient-order-item" value={itemId} items={[...(catalog.data?.medications??[]),...(catalog.data?.services??[])].map(item=>({value:item.id,label:item.display}))} onValueChange={value=>{setItemId(value);setFrequency(null);setDose(null)}} /></Field>
      <Field><FieldLabel htmlFor="inpatient-order-duration">{t('医嘱时效','Order duration')}</FieldLabel><WorkspaceSelect id="inpatient-order-duration" value={duration} items={[{value:'long',label:t('长期','Long')},{value:'temporary',label:t('临时','Temporary')}]} onValueChange={value=>{if(value)setDuration(value)}} /></Field>
      {medication ? <><Field data-invalid={selectedDose && 'reason' in selectedDose}><FieldLabel htmlFor="inpatient-order-dose">{t('每次剂量','Dose per execution')}</FieldLabel><Input id="inpatient-order-dose" value={doseText} required maxLength={120} aria-invalid={selectedDose !== undefined && 'reason' in selectedDose} onChange={event=>setDose(event.currentTarget.value)} />
      {selectedDose ? <p aria-live="polite">{'quantity' in selectedDose ? `${t('每次','Per execution ')}${selectedDose.quantity}${medication.unit}` : doseError(selectedDose, zh)}</p> : null}
      <p>{t('可填写明确剂量或制剂数量，例如','Enter a dose or preparation quantity, for example ')}{medication.doses[0]?.doseText ?? `1${medication.unit}`} / {`1${medication.unit}`}</p></Field>
      <Field><FieldLabel htmlFor="inpatient-order-frequency">{t('医嘱频次','Order frequency')}</FieldLabel><WorkspaceSelect id="inpatient-order-frequency" value={selectedFrequency??null} items={medication.frequencyCodes.map(code=>({value:code,label:code==='QD'?'QD · 08:00':code==='BID'?'BID · 08:00 / 20:00':t('PRN · 按需','PRN · as needed')}))} onValueChange={setFrequency} /></Field></> : null}
      <Field><FieldLabel htmlFor="inpatient-postoperative">{t('术后关联手术','Postoperative procedure')}</FieldLabel><WorkspaceSelect id="inpatient-postoperative" value={surgeryId ?? ''} items={[{value:'',label:t('普通医嘱','Regular order')},...(surgery.data?.executions ?? []).map(item=>({value:item.id,label:`${item.actualProcedure.coding.code} · ${item.actualProcedure.coding.display}`}))]} onValueChange={setSurgeryId} /></Field>
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={blocked || !input}>{t('开立医嘱','Issue order')}</Button><Button type="button" variant="outline" disabled={blocked || !draft} onClick={() => setEvaluate(value => !value)}>{evaluate ? t('收起当前医嘱预计','Hide order estimate') : t('预计当前医嘱','Estimate current order')}</Button></div>
    </FieldGroup></FieldSet></form> : null}
    {doctor && evaluate && draft ? <InpatientDrgPanel admission={admission} session={session} locale={locale} write={write} draft={draft} active={active} reservations={false} {...(review ? { onEvaluationChange: setEvaluation } : {})} onReview={assessment => { const frozenInput = orderInput(); if (frozenInput) setReview({ input: { ...frozenInput, expectedDrgFingerprint: assessment.fingerprint }, display: medication?.display ?? service?.display ?? '', assessment }) }} /> : null}
    <AlertDialog open={review !== undefined} onOpenChange={open => { if (!open && !write.mutation.isPending) setReview(undefined) }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('确认预计后的医嘱','Confirm reviewed order')}</AlertDialogTitle><AlertDialogDescription>{t('核对当前医嘱和费用预计。提交时将重新核验诊疗、费用和目录修订；变化后需重新预计。','Review the selected order and charge estimate. Care, charges and catalog revisions will be checked again when submitting.')}</AlertDialogDescription></AlertDialogHeader>{review ? <><p>{review.display} · {review.input.duration === 'temporary' ? t('临时','Temporary') : t('长期','Long')}</p><p>{review.input.selection.kind === 'medication' ? `${review.input.selection.doseText} · ${review.input.selection.frequencyCode}` : `${t('数量 ','Quantity ')}${review.input.selection.quantity}`}</p><p>{t('正式病组 ','Formal group ')}{review.assessment.drgCode ?? t('未确定','Undetermined')} · {t('预计总额 ','Estimated charges ')}{formatFen(review.assessment.estimatedTotalFen, locale)}</p></> : null}<DrgError error={write.mutation.error} locale={locale} />{evaluation?.stale ? <DrgStaleNotice locale={locale} /> : !reviewCurrent ? <p role="status">{checkingMessage}</p> : null}<AlertDialogFooter><AlertDialogCancel disabled={write.mutation.isPending}>{t('取消','Cancel')}</AlertDialogCancel><Button disabled={write.blocked || !reviewCurrent} onClick={() => { if (review && reviewCurrent) write.mutation.mutate({ operation: 'inpatient.order.issue', input: review.input }, { onSuccess: () => setReview(undefined) }) }}>{t('确认开立医嘱','Confirm order')}</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
    {doctor || nurse ? <Field><FieldLabel htmlFor="inpatient-order-reason">{t('停嘱或按需执行理由','Reason for stop or PRN execution')}</FieldLabel><Input id="inpatient-order-reason" value={reason} onChange={event=>setReason(event.currentTarget.value)} /></Field> : null}
    {data?.orders.map(order=><article key={order.id} className="flex flex-col gap-2 rounded-md border bg-card p-3">
      <p>{order.display} · {{signed:t('待校对','Awaiting verification'),verified:t('已校对','Verified'),'stop-requested':t('待停嘱核对','Stop requested'),stopped:t('已停止','Stopped'),completed:t('已结束','Finished')}[order.state]}</p>
      {order.surgeryExecutionId ? <p>{t('术后医嘱 · ','Postoperative order · ')}{surgery.data?.executions.find(item=>item.id===order.surgeryExecutionId)?.actualProcedure.coding.display ?? order.surgeryExecutionId}</p> : null}
      <p>{order.duration==='long'?t('长期','Long'):t('临时','Temporary')} · {order.doseText} · {t('每次','Per execution ')}{order.doseQuantity}{order.unit} · {order.frequencyCode}</p>
      <div className="flex flex-wrap gap-2">
        {nurse && order.state==='signed' ? <Button disabled={blocked} onClick={()=>write.mutation.mutate({operation:'inpatient.order.verify',input:{admissionId:admission.id,orderId:order.id,expectedOrderVersion:order.version}})}>{t('校对医嘱','Verify order')}</Button>:null}
        {doctor && ['signed','verified'].includes(order.state) ? <Button variant="outline" disabled={stopBlocked || !reason.trim()} onClick={()=>write.mutation.mutate({operation:'inpatient.order.request-stop',input:{admissionId:admission.id,orderId:order.id,expectedOrderVersion:order.version,reason}})}>{t('申请停嘱','Request stop')}</Button>:null}
        {nurse && order.state==='stop-requested' ? <Button disabled={stopBlocked} onClick={()=>write.mutation.mutate({operation:'inpatient.order.verify-stop',input:{admissionId:admission.id,orderId:order.id,expectedOrderVersion:order.version}})}>{t('核对停嘱','Verify stop')}</Button>:null}
        {nurse && order.state==='verified' && order.frequencyCode==='PRN' ? <Button disabled={blocked || !reason.trim()} onClick={()=>write.mutation.mutate({operation:'inpatient.execution.request-prn',input:{admissionId:admission.id,orderId:order.id,expectedOrderVersion:order.version,reason}})}>{t('按需给药','Request PRN execution')}</Button>:null}
      </div>
      <AgentReviewAnchor id={inpatientOrderAnchor(admission.id, order.id)} />
    </article>)}
    {data?.executions.map(execution=>{
      const order=data.orders.find(order=>order.id===execution.orderId)!
      const valid = !blocked && order.state==='verified'
      const due = scenario.data !== undefined && Date.parse(execution.scheduledFor) <= Date.parse(scenario.data.virtualTime)
      const availableAt = new Date(execution.scheduledFor).toLocaleTimeString(zh ? 'zh-CN' : 'en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
      return <article key={execution.id} className="flex flex-col gap-2 rounded-md border bg-card p-3">
        <p>{order.display} · {{pending:t('待执行','Pending'),dispensed:t('已发药','Dispensed'),completed:t('已完成','Completed'),cancelled:t('已取消','Cancelled')}[execution.status]}</p>
        <p className="font-mono text-sm tabular-nums">{new Date(execution.scheduledFor).toLocaleString(zh?'zh-CN':'en-US',{timeZone:'Asia/Shanghai'})} · {order.doseQuantity}{order.unit}</p>
        {nurse && execution.status === 'dispensed' && !due ? <p role="status">{scenario.data ? t(`${availableAt} 后可给药`, `Medication can be administered after ${availableAt}`) : t('正在核对给药时间', 'Checking administration time')}</p> : null}
        {nurse && execution.status==='dispensed' ? <Button disabled={!valid || !due} onClick={()=>write.mutation.mutate({operation:'inpatient.execution.administer',input:{admissionId:admission.id,executionId:execution.id,expectedExecutionVersion:execution.version}})}>{t('给药','Administer')}</Button>:null}
        {nurse && execution.status==='pending' && order.kind==='service' ? <Button disabled={!valid || !due} onClick={()=>write.mutation.mutate({operation:'inpatient.execution.complete',input:{admissionId:admission.id,executionId:execution.id,expectedExecutionVersion:execution.version}})}>{t('完成健康教育','Complete education')}</Button>:null}
      </article>
    })}
    {data?.orders.length===0 ? <p>{t('暂无医嘱','No orders')}</p>:null}
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
