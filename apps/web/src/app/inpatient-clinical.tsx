import { inpatientAdmissionConditionSchema, inpatientFullCatalogSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { z } from 'zod'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@clinmesh/ui/components/table'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet, searchReferenceDiagnoses } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { PaginationControls } from './pagination-controls.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { formatFen } from './workspace-format.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

export function InpatientClinical({ admission, session, locale, write }: { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent> }): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const doctor = session.actor.roleCode === 'inpatient-doctor', nurse = session.actor.roleCode === 'ward-nurse', pharmacist = session.actor.roleCode === 'pharmacist', cashier = session.actor.roleCode === 'cashier'
  const scope = ['inpatient',session.actor.workspaceId,session.actor.epoch,session.actor.practitionerRoleId]
  const client = useQueryClient(), messages = getWorkspaceMessages(locale)
  const clinical = useQuery({ queryKey: [...scope,admission.id,'clinical'], queryFn: ({signal}) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/clinical`,inpatientFullClinicalSchema,signal) })
  const catalog = useQuery({ queryKey: [...scope,'clinical-catalog'], enabled: doctor || nurse || pharmacist, queryFn: ({signal}) => apiGet('/api/his/v1/inpatient/clinical-catalog',inpatientFullCatalogSchema,signal) })
  const [diagnosisId,setDiagnosisId] = useState<string|null>(null), [secondaryId,setSecondaryId] = useState<string|null>(null)
  const [primaryCondition,setPrimaryCondition]=useState<z.infer<typeof inpatientAdmissionConditionSchema>|null>(null), [secondaryCondition,setSecondaryCondition]=useState<z.infer<typeof inpatientAdmissionConditionSchema>|null>(null)
  const conditions=[{value:'1' as const,label:t('1 · 有','1 · Present')},{value:'2' as const,label:t('2 · 临床未确定','2 · Clinically undetermined')},{value:'3' as const,label:t('3 · 情况不明','3 · Unknown')},{value:'4' as const,label:t('4 · 无','4 · Absent')}]
  const [query,setQuery] = useState(''), [search,setSearch] = useState(''), [page,setPage] = useState(1)
  const references = useQuery({ queryKey: [...scope,'diagnosis-reference',search,page], enabled: doctor && search.length>0, queryFn: ({signal}) => searchReferenceDiagnoses(search,page,signal) })
  const [itemId,setItemId] = useState<string|null>(null), [duration,setDuration] = useState<'long'|'temporary'>('long')
  const [frequency,setFrequency] = useState<'QD'|'BID'|'PRN'|null>(null), [dose,setDose] = useState<string|null>(null)
  const [reason,setReason] = useState(''), [lotIds,setLotIds] = useState<Record<string,string>>({})
  const medication = catalog.data?.medications.find(item => item.id === itemId), service = catalog.data?.services.find(item => item.id === itemId)
  const selectedDose = medication?.doses.find(item => item.doseText === dose) ?? medication?.doses[0]
  const selectedFrequency = frequency !== null && medication?.frequencyCodes.includes(frequency) ? frequency : medication?.frequencyCodes[0]
  const data = clinical.data, blocked = write.blocked || admission.status !== 'admitted'
  const candidates = search.length>0 ? references.data?.items ?? [] : catalog.data?.diagnoses ?? []
  const diagnose = () => {
    if (!data || !diagnosisId || !primaryCondition || (secondaryId && !secondaryCondition)) return
    write.mutation.mutate({operation:'inpatient.diagnosis.confirm',input:{admissionId:admission.id,encounterVersion:data.encounterVersion,expectedRevision:data.diagnosis.revision,
      entries:[{catalogItemId:diagnosisId,role:'primary',admissionCondition:primaryCondition},...(secondaryId && secondaryCondition && secondaryId!==diagnosisId ? [{catalogItemId:secondaryId,role:'secondary' as const,admissionCondition:secondaryCondition}] : [])]}})
  }
  const issue = () => {
    if (!data) return
    const common={admissionId:admission.id,encounterVersion:data.encounterVersion,duration}
    if (medication && selectedDose && selectedFrequency) write.mutation.mutate({operation:'inpatient.order.issue',input:{...common,selection:{kind:'medication',catalogItemId:medication.id,catalogVersion:medication.version,doseText:selectedDose.doseText,doseQuantity:selectedDose.quantity,frequencyCode:selectedFrequency}}})
    else if(service) write.mutation.mutate({operation:'inpatient.order.issue',input:{...common,selection:{kind:'service',serviceId:service.id,serviceVersion:service.version,quantity:1}}})
  }
  const error=clinical.error ?? catalog.error ?? references.error
  return <section aria-label={t('住院诊疗','Inpatient care')} className="mt-4 flex flex-col gap-4">
    {error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(error,messages)}</AlertDescription></Alert> : null}
    <div className="flex items-center gap-2"><h3>{t('诊断与医嘱','Diagnoses and orders')}</h3><Button variant="outline" onClick={() => void client.invalidateQueries({queryKey:['inpatient']})}>{t('刷新诊疗记录','Refresh care')}</Button></div>
    {clinical.isPending ? <p>{t('正在加载诊疗记录','Loading care')}</p> : null}
    {data?.diagnosis.entries.map(entry => <p key={entry.conditionId}>{entry.role==='primary' ? t('主诊断：','Primary: ') : t('次诊断：','Secondary: ')}{entry.coding.display}</p>)}
    {doctor ? <form onSubmit={event=>{event.preventDefault();diagnose()}}><FieldSet disabled={blocked}><FieldLegend>{t('确认本次住院诊断','Confirm admission diagnosis')}</FieldLegend><FieldGroup className="grid gap-3 md:grid-cols-2">
      <Field><FieldLabel htmlFor="inpatient-diagnosis-search">{t('诊断目录检索','Search diagnosis catalog')}</FieldLabel><Input id="inpatient-diagnosis-search" value={query} onChange={event=>setQuery(event.currentTarget.value)} /></Field>
      <Button type="button" variant="outline" onClick={()=>{setSearch(query.trim());setPage(1)}}>{t('查询诊断','Search diagnoses')}</Button>
      <Field><FieldLabel htmlFor="inpatient-diagnosis">{t('住院诊断','Inpatient diagnosis')}</FieldLabel><WorkspaceSelect id="inpatient-diagnosis" value={diagnosisId} items={candidates.map(item=>({value:item.id,label:item.display}))} onValueChange={setDiagnosisId} /></Field>
      <Field><FieldLabel htmlFor="inpatient-secondary">{t('次诊断（可选）','Secondary diagnosis (optional)')}</FieldLabel><WorkspaceSelect id="inpatient-secondary" value={secondaryId} items={candidates.filter(item=>item.id!==diagnosisId).map(item=>({value:item.id,label:item.display}))} onValueChange={setSecondaryId} /></Field>
      <Field><FieldLabel htmlFor="inpatient-primary-condition">{t('主诊断入院病情','Primary diagnosis on admission')}</FieldLabel><WorkspaceSelect id="inpatient-primary-condition" value={primaryCondition} items={conditions} onValueChange={setPrimaryCondition}/></Field>
      {secondaryId ? <Field><FieldLabel htmlFor="inpatient-secondary-condition">{t('次诊断入院病情','Secondary diagnosis on admission')}</FieldLabel><WorkspaceSelect id="inpatient-secondary-condition" value={secondaryCondition} items={conditions} onValueChange={setSecondaryCondition}/></Field>:null}
      <Button type="submit" disabled={blocked || !diagnosisId || !primaryCondition || (!!secondaryId && !secondaryCondition) || !data}>{t('确认住院诊断','Confirm diagnosis')}</Button>
      {references.data && search.length>0 ? <PaginationControls messages={messages} page={page} pageSize={references.data.pageSize} total={references.data.total} onPageChange={setPage} /> : null}
    </FieldGroup></FieldSet></form> : null}
    {doctor ? <form onSubmit={event=>{event.preventDefault();issue()}}><FieldSet disabled={blocked}><FieldLegend>{t('签发医嘱','Issue order')}</FieldLegend><FieldGroup className="grid gap-3 md:grid-cols-2">
      <Field><FieldLabel htmlFor="inpatient-order-item">{t('医嘱项目','Order item')}</FieldLabel><WorkspaceSelect id="inpatient-order-item" value={itemId} items={[...(catalog.data?.medications??[]),...(catalog.data?.services??[])].map(item=>({value:item.id,label:item.display}))} onValueChange={value=>{setItemId(value);setFrequency(null);setDose(null)}} /></Field>
      <Field><FieldLabel htmlFor="inpatient-order-duration">{t('医嘱时效','Order duration')}</FieldLabel><WorkspaceSelect id="inpatient-order-duration" value={duration} items={[{value:'long',label:t('长期','Long')},{value:'temporary',label:t('临时','Temporary')}]} onValueChange={value=>{if(value)setDuration(value)}} /></Field>
      {medication ? <><Field><FieldLabel htmlFor="inpatient-order-dose">{t('每次剂量','Dose per execution')}</FieldLabel><WorkspaceSelect id="inpatient-order-dose" value={selectedDose?.doseText??null} items={medication.doses.map(item=>({value:item.doseText,label:`${item.doseText} · ${item.quantity}${medication.unit}`}))} onValueChange={setDose} /></Field>
      <Field><FieldLabel htmlFor="inpatient-order-frequency">{t('医嘱频次','Order frequency')}</FieldLabel><WorkspaceSelect id="inpatient-order-frequency" value={selectedFrequency??null} items={medication.frequencyCodes.map(code=>({value:code,label:code==='QD'?'QD · 08:00':code==='BID'?'BID · 08:00 / 20:00':t('PRN · 按需','PRN · as needed')}))} onValueChange={setFrequency} /></Field></> : null}
      <Button type="submit" disabled={blocked || !data || (!medication && !service)}>{t('签发医嘱','Issue order')}</Button>
    </FieldGroup></FieldSet></form> : null}
    {doctor || nurse ? <Field><FieldLabel htmlFor="inpatient-order-reason">{t('停嘱或按需执行理由','Reason for stop or PRN execution')}</FieldLabel><Input id="inpatient-order-reason" value={reason} onChange={event=>setReason(event.currentTarget.value)} /></Field> : null}
    {data?.orders.map(order=><article key={order.id} className="flex flex-col gap-2 rounded-md border p-3">
      <p>{order.display} · {{signed:t('待校对','Awaiting verification'),verified:t('已校对','Verified'),'stop-requested':t('待核停','Stop requested'),stopped:t('已停止','Stopped'),completed:t('已结束','Finished')}[order.state]}</p>
      <p>{order.duration==='long'?t('长期','Long'):t('临时','Temporary')} · {order.doseText} · {t('每次','Per execution ')}{order.doseQuantity}{order.unit} · {order.frequencyCode}</p>
      <div className="flex flex-wrap gap-2">
        {nurse && order.state==='signed' ? <Button disabled={blocked} onClick={()=>write.mutation.mutate({operation:'inpatient.order.verify',input:{admissionId:admission.id,orderId:order.id,expectedOrderVersion:order.version}})}>{t('校对医嘱','Verify order')}</Button>:null}
        {doctor && ['signed','verified'].includes(order.state) ? <Button variant="outline" disabled={blocked || !reason.trim()} onClick={()=>write.mutation.mutate({operation:'inpatient.order.request-stop',input:{admissionId:admission.id,orderId:order.id,expectedOrderVersion:order.version,reason}})}>{t('申请停嘱','Request stop')}</Button>:null}
        {nurse && order.state==='stop-requested' ? <Button disabled={blocked} onClick={()=>write.mutation.mutate({operation:'inpatient.order.verify-stop',input:{admissionId:admission.id,orderId:order.id,expectedOrderVersion:order.version}})}>{t('核对停嘱','Verify stop')}</Button>:null}
        {nurse && order.state==='verified' && order.frequencyCode==='PRN' ? <Button disabled={blocked || !reason.trim()} onClick={()=>write.mutation.mutate({operation:'inpatient.execution.request-prn',input:{admissionId:admission.id,orderId:order.id,expectedOrderVersion:order.version,reason}})}>{t('请求按需执行','Request PRN execution')}</Button>:null}
      </div>
    </article>)}
    {data?.executions.map(execution=>{
      const order=data.orders.find(order=>order.id===execution.orderId)!
      const medication=catalog.data?.medications.find(item=>item.id===order.catalogItemId), lots=medication?.lots??[]
      const lot=lots.find(item=>item.id===(lotIds[execution.id]??lots[0]?.id))
      const valid = !blocked && order.state==='verified'
      return <article key={execution.id} className="flex flex-col gap-2 rounded-md border p-3">
        <p>{order.display} · {{pending:t('待执行','Pending'),dispensed:t('已发药','Dispensed'),completed:t('已完成','Completed'),cancelled:t('已取消','Cancelled')}[execution.status]}</p>
        <p>{new Date(execution.scheduledFor).toLocaleString(zh?'zh-CN':'en-US',{timeZone:'Asia/Shanghai'})} · {order.doseQuantity}{order.unit}</p>
        {pharmacist && execution.status==='pending' && order.kind==='medication' ? <>
          <Field><FieldLabel htmlFor={`inpatient-lot-${execution.id}`}>{t('发药批次','Inventory lot')}</FieldLabel><WorkspaceSelect id={`inpatient-lot-${execution.id}`} value={lot?.id??null} items={lots.map(lot=>({value:lot.id,label:`${lot.id} · ${lot.quantityOnHand}${order.unit} · ${lot.expiresOn}`}))} onValueChange={value=>{if(value)setLotIds(current=>({...current,[execution.id]:value}))}} /></Field>
          <Button disabled={!valid || !lot || lot.quantityOnHand<order.doseQuantity} onClick={()=>{if(lot)write.mutation.mutate({operation:'inpatient.execution.dispense',input:{admissionId:admission.id,executionId:execution.id,expectedExecutionVersion:execution.version,lotSelections:[{lotId:lot.id,expectedVersion:lot.version,quantity:order.doseQuantity}]}})}}>{t('发药','Dispense')}</Button>
        </>:null}
        {nurse && execution.status==='dispensed' ? <Button disabled={!valid} onClick={()=>write.mutation.mutate({operation:'inpatient.execution.administer',input:{admissionId:admission.id,executionId:execution.id,expectedExecutionVersion:execution.version}})}>{t('给药','Administer')}</Button>:null}
        {nurse && execution.status==='pending' && order.kind==='service' ? <Button disabled={!valid} onClick={()=>write.mutation.mutate({operation:'inpatient.execution.complete',input:{admissionId:admission.id,executionId:execution.id,expectedExecutionVersion:execution.version}})}>{t('完成健康教育','Complete education')}</Button>:null}
      </article>
    })}
    {data?.orders.length===0 ? <p>{t('暂无医嘱','No orders')}</p>:null}
    <h3>{t('费用明细','Charges')}</h3>
    {cashier ? <Field><FieldLabel htmlFor="inpatient-reversal-reason">{t('冲正理由','Reversal reason')}</FieldLabel><Input id="inpatient-reversal-reason" value={reason} onChange={event=>setReason(event.currentTarget.value)} /></Field>:null}
    <Table><TableHeader><TableRow><TableHead>{t('日期 / 类别','Date / type')}</TableHead><TableHead>{t('金额','Amount')}</TableHead><TableHead>{t('状态','Status')}</TableHead></TableRow></TableHeader><TableBody>
      {data?.charges.map(charge=><TableRow key={charge.id}><TableCell>{charge.serviceDate} · {charge.kind}</TableCell><TableCell>{formatFen(charge.amountFen,locale)}</TableCell><TableCell>
        {charge.reversalOf ? t('关联冲正','Linked reversal') : data.charges.some(item=>item.reversalOf===charge.id) ? t('已冲正','Reversed') : cashier ? <Button variant="outline" disabled={write.blocked || admission.financialStatus!=='open' || !reason.trim()} onClick={()=>write.mutation.mutate({operation:'inpatient.charge.reverse',input:{admissionId:admission.id,chargeId:charge.id,expectedChargeVersion:charge.version,reason}})}>{t('冲正','Reverse')}</Button>:t('已入账','Recorded')}
      </TableCell></TableRow>)}
    </TableBody></Table>
    <p>{t('费用净额：','Net charges: ')}{formatFen(data?.chargesFen??0,locale)}</p>
  </section>
}
