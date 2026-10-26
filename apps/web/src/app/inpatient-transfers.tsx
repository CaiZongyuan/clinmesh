import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientIncomingTransfersSchema, inpatientTransferCatalogSchema, inpatientTransfersSchema } from '@clinmesh/contracts/inpatient-transfer'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { apiGet } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

type Props={session:SessionContext;locale:WorkspaceLocale;write:ReturnType<typeof useInpatientWriteIntent>}
function useTransferCatalog(session:SessionContext) {
  return useQuery({queryKey:['inpatient',session.actor.workspaceId,session.actor.epoch,session.actor.practitionerRoleId,'transfer-catalog'],
    queryFn:({signal})=>apiGet('/api/his/v1/inpatient/transfer-catalog',inpatientTransferCatalogSchema,signal)})
}

export function InpatientTransfers({admission,session,locale,write}:Props&{admission:InpatientAdmission}) {
  const zh=locale==='zh-CN',t=(cn:string,en:string)=>zh?cn:en,doctor=session.actor.roleCode==='inpatient-doctor',nurse=session.actor.roleCode==='ward-nurse'
  const catalog=useTransferCatalog(session)
  const facts=useQuery({queryKey:['inpatient',session.actor.workspaceId,session.actor.epoch,session.actor.practitionerRoleId,admission.id,'transfers'],
    queryFn:({signal})=>apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/transfers`,inpatientTransfersSchema,signal)})
  const [targetWardId,setTargetWardId]=useState<string|null>(null),[reason,setReason]=useState('')
  const blocked=write.blocked||admission.status!=='admitted',error=catalog.error??facts.error
  return <section aria-label={t('住院转科','Inpatient transfer')} className="flex flex-col gap-3">
    <h3 className="text-base font-semibold">{t('转科与交接','Transfer and handover')}</h3>
    {error?<Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(error,getWorkspaceMessages(locale))}</AlertDescription></Alert>:null}
    {doctor?<form onSubmit={event=>{event.preventDefault();if(targetWardId)write.mutation.mutate({operation:'inpatient.transfer.request',input:{admissionId:admission.id,encounterVersion:admission.versionId,targetWardId,reason}})}}>
      <FieldSet disabled={blocked}><FieldLegend>{t('申请转科','Request transfer')}</FieldLegend><FieldGroup className="grid gap-3 md:grid-cols-2">
        <Field><FieldLabel htmlFor="inpatient-transfer-ward">{t('转入病区','Target ward')}</FieldLabel><WorkspaceSelect id="inpatient-transfer-ward" value={targetWardId} onValueChange={setTargetWardId} items={(catalog.data?.wards??[]).filter(ward=>ward.id!==admission.wardId).map(ward=>({value:ward.id,label:ward.name}))}/></Field>
        <Field><FieldLabel htmlFor="inpatient-transfer-reason">{t('转科理由','Transfer reason')}</FieldLabel><Input id="inpatient-transfer-reason" value={reason} onChange={event=>setReason(event.currentTarget.value)} required maxLength={2000}/></Field>
        <Button type="submit" disabled={blocked||!targetWardId||!reason.trim()||facts.data?.transfers.some(transfer=>['requested','handed-over'].includes(transfer.status))}>{t('申请转科','Request transfer')}</Button>
      </FieldGroup></FieldSet>
    </form>:null}
    {facts.data?.transfers.map(transfer=>{
      const input={admissionId:admission.id,encounterVersion:admission.versionId,transferId:transfer.id,expectedTransferVersion:transfer.version}
      return <article key={transfer.id} className="flex flex-col gap-2 rounded-md border bg-card p-3">
        <p>{catalog.data?.wards.find(ward=>ward.id===transfer.sourceWardId)?.name} → {catalog.data?.wards.find(ward=>ward.id===transfer.targetWardId)?.name} · {{requested:t('待原科交接','Awaiting source handover'),'handed-over':t('待目标科接收','Awaiting target receipt'),completed:t('已接收','Received'),cancelled:t('已取消','Cancelled')}[transfer.status]}</p><p>{transfer.reason}</p>
        {nurse&&transfer.status==='requested'?<Button disabled={blocked} onClick={()=>write.mutation.mutate({operation:'inpatient.transfer.handover',input})}>{t('完成原科交接','Complete source handover')}</Button>:null}
        {doctor&&['requested','handed-over'].includes(transfer.status)?<Button variant="outline" disabled={blocked} onClick={()=>write.mutation.mutate({operation:'inpatient.transfer.cancel',input})}>{t('取消转科申请','Cancel transfer')}</Button>:null}
      </article>
    })}
    {facts.data?.transfers.length===0?<p>{t('暂无转科记录','No transfers')}</p>:null}
  </section>
}

export function InpatientIncomingTransfers({session,locale,write}:Props) {
  const zh=locale==='zh-CN',catalog=useTransferCatalog(session)
  const incoming=useQuery({queryKey:['inpatient',session.actor.workspaceId,session.actor.epoch,session.actor.practitionerRoleId,'incoming-transfers'],
    queryFn:({signal})=>apiGet('/api/his/v1/inpatient/transfers/incoming',inpatientIncomingTransfersSchema,signal)})
  const [beds,setBeds]=useState<Record<string,string|null>>({}),error=incoming.error??catalog.error
  return <section aria-label={zh?'待接收转科':'Incoming transfers'} className="flex flex-col gap-3 rounded-lg border bg-card p-3">
    <h3>{zh?'待接收转科':'Incoming transfers'}</h3>
    {error?<Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(error,getWorkspaceMessages(locale))}</AlertDescription></Alert>:null}
    {incoming.data?.items.map(item=><article key={item.transfer.id} className="flex flex-col gap-2 rounded-md border bg-card p-3">
      <p>{item.patientName} · {item.inpatientNumber}</p><p>{item.transfer.reason}</p>
      {item.transfer.status==='requested'?<p>{zh?'等待原科护士完成交接':'Awaiting source nurse handover'}</p>:<FieldSet disabled={write.blocked}><FieldGroup>
        <Field><FieldLabel htmlFor={`inpatient-transfer-bed-${item.transfer.id}`}>{zh?'转科接收床位':'Transfer receiving bed'}</FieldLabel><WorkspaceSelect id={`inpatient-transfer-bed-${item.transfer.id}`} value={beds[item.transfer.id]??null}
          onValueChange={value=>setBeds(current=>({...current,[item.transfer.id]:value}))} items={(catalog.data?.beds??[]).filter(bed=>bed.wardId===item.transfer.targetWardId&&bed.available).map(bed=>({value:bed.id,label:bed.name}))}/></Field>
        <Button disabled={write.blocked||!beds[item.transfer.id]} onClick={()=>{const bedId=beds[item.transfer.id];if(bedId)write.mutation.mutate({operation:'inpatient.transfer.receive',input:{admissionId:item.admissionId,encounterVersion:item.encounterVersion,transferId:item.transfer.id,expectedTransferVersion:item.transfer.version,bedId}})}}>{zh?'接收转科并分床':'Receive transfer and assign bed'}</Button>
      </FieldGroup></FieldSet>}
    </article>)}
    {incoming.data?.items.length===0?<p>{zh?'暂无待接收转科':'No incoming transfers'}</p>:null}
  </section>
}
