import { laboratoryGenerationErrorMessage } from './laboratory-generation-error.ts'
import { lazy, Suspense, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SessionContext, ImagingRequest } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientInvestigationCatalogSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { apiGet, getImagingStudy, getImagingStudyBlock } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { formatFen } from './workspace-format.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

type Write=ReturnType<typeof useInpatientWriteIntent>
type Props={admission:InpatientAdmission;session:SessionContext;locale:WorkspaceLocale;write:Write}
const ImagingViewer=lazy(()=>import('./imaging/imaging-viewer.tsx').then(module=>({default:module.ImagingViewer})))

export function InpatientInvestigations({admission,session,locale,write}:Props) {
  const zh=locale==='zh-CN',t=(cn:string,en:string)=>zh?cn:en,doctor=session.actor.roleCode==='inpatient-doctor',nurse=session.actor.roleCode==='ward-nurse'
  const key=['inpatient',session.actor.workspaceId,session.actor.epoch,session.actor.practitionerRoleId]
  const facts=useQuery({queryKey:[...key,admission.id,'investigations'],queryFn:({signal})=>apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/investigations`,inpatientInvestigationsSchema,signal)})
  const catalog=useQuery({queryKey:[...key,'investigation-catalog'],queryFn:({signal})=>apiGet('/api/his/v1/inpatient/investigation-catalog',inpatientInvestigationCatalogSchema,signal)})
  const [itemId,setItemId]=useState<string|null>(null),[indication,setIndication]=useState('')
  const selected=catalog.data?.items.find(item=>item.id===itemId),blocked=write.blocked||admission.status!=='admitted'
  const issue=()=>{
    if(selected===undefined)return
    const common={admissionId:admission.id,encounterVersion:admission.versionId,catalogVersion:selected.version}
    if(selected.kind==='imaging')write.mutation.mutate({operation:'inpatient.investigation.issue',input:{...common,selection:{kind:'imaging',serviceId:selected.id,indication}}})
    else if(selected.indicationCodes[0])write.mutation.mutate({operation:'inpatient.investigation.issue',input:{...common,selection:{kind:'laboratory',catalogItemId:selected.id,indicationCode:selected.indicationCodes[0]}}})
  }
  const error=facts.error??catalog.error
  const status=(value:string,sent:boolean)=>({issued:sent?t('已送检，待受理','Sent, awaiting acceptance'):t('待送检','Awaiting dispatch'),accepted:t('已受理','Accepted'),'in-progress':t('执行中','In progress'),'generation-failed':t('结果生成失败','Result failed'),reported:t('报告已签发','Reported'),acknowledged:t('报告已阅','Acknowledged'),cancelled:t('已取消','Cancelled')}[value]??value)
  return <section aria-label={t('住院检查检验','Inpatient investigations')} className="flex flex-col gap-3">
    <h3>{t('检查检验与报告','Investigations and reports')}</h3>
    {error?<Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(error,getWorkspaceMessages(locale))}</AlertDescription></Alert>:null}
    {facts.isPending?<p>{t('正在加载检查检验','Loading investigations')}</p>:null}
    {doctor?<form onSubmit={event=>{event.preventDefault();issue()}}><FieldSet disabled={blocked}><FieldLegend>{t('开立住院检查','Order investigation')}</FieldLegend><FieldGroup className="grid gap-3 md:grid-cols-2">
      <Field><FieldLabel htmlFor="inpatient-investigation-item">{t('住院检查项目','Investigation item')}</FieldLabel><WorkspaceSelect id="inpatient-investigation-item" value={itemId} onValueChange={setItemId}
        items={(catalog.data?.items??[]).map(item=>({value:item.id,label:`${item.display} · ${item.priceFen===undefined?t('未计价','Not priced'):formatFen(item.priceFen,locale)}${item.available?'':t(' · 尚未开展',' · unavailable')}`}))}/></Field>
      {selected?.kind==='imaging'?<Field><FieldLabel htmlFor="inpatient-investigation-indication">{t('检查指征','Clinical indication')}</FieldLabel><Input id="inpatient-investigation-indication" value={indication} onChange={event=>setIndication(event.currentTarget.value)} required minLength={2} maxLength={500}/></Field>:null}
      <Button type="submit" disabled={blocked||!selected?.available||(selected.kind==='imaging'&&indication.trim().length<2)}>{t('开立住院检查','Issue investigation')}</Button>
    </FieldGroup></FieldSet></form>:null}
    {[...(facts.data?.laboratoryRequests??[]).map(request=>({kind:'laboratory' as const,request})),...(facts.data?.imagingRequests??[]).map(request=>({kind:'imaging' as const,request}))].map(({kind,request})=>{
      const sent=facts.data?.sent.some(item=>item.requestId===request.id)===true
      const input={admissionId:admission.id,requestId:request.id,expectedRequestVersion:request.version,serviceRequestVersion:request.serviceRequestVersion,taskVersion:request.taskVersion!}
      const display='service' in request?request.service.name:request.laboratoryService?.nameZh??request.referenceConcept?.display??request.catalogItemId
      const acknowledge=()=>{if(request.report)write.mutation.mutate({operation:'inpatient.investigation.acknowledge',input:{...input,diagnosticReportId:request.report.diagnosticReportId,diagnosticReportVersion:request.report.diagnosticReportVersion}})}
      return <article key={request.id} className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
        <p>{display} · {status(request.status,sent)}</p>
        {request.generationError?<p>{kind==='laboratory'?laboratoryGenerationErrorMessage(request.generationError.code,locale):t('本次检查没有取得结果，未生成报告。可以重试，或取消该申请。','This examination produced no result and no report. Retry or cancel the request.')}</p>:null}
        {nurse&&request.status==='issued'&&!sent?<Button disabled={blocked} onClick={()=>write.mutation.mutate({operation:'inpatient.investigation.send',input})}>{t('校对并送检','Verify and send')}</Button>:null}
        {doctor&&((request.status==='issued'&&!sent)||request.status==='generation-failed')?<Button variant="outline" disabled={blocked} onClick={()=>write.mutation.mutate({operation:'inpatient.investigation.cancel',input})}>{t('取消检查申请','Cancel investigation')}</Button>:null}
        {doctor&&request.status==='generation-failed'&&!['INVESTIGATION_TRUTH_INCOMPATIBLE','INVESTIGATION_UNSUPPORTED'].includes(request.generationError?.code??'')?<Button disabled={blocked} onClick={()=>write.mutation.mutate({operation:'inpatient.investigation.retry',input})}>{t('重试结果生成','Retry result')}</Button>:null}
        {request.previousReports.map(report=><details key={report.diagnosticReportId}><summary>{t('既往报告修订','Previous report revision')} {report.revisionNumber}</summary><p>{report.issuedAt}</p><p>{'impression' in report?report.impression:report.conclusion}</p></details>)}
        {request.report?<>
          <p>{t('报告修订','Report revision')} {request.report.revisionNumber} · {new Date(request.report.issuedAt).toLocaleString(zh?'zh-CN':'en-US')}</p>
          {'impression' in request.report?<><p>{request.report.technique}</p><p>{request.report.findings}</p><p>{request.report.impression}</p></>:<><p>{request.report.conclusion}</p>{request.report.results.map((result,index)=><p key={index}>{result.display} · {typeof result.value==='object'?result.value.display:String(result.value)} {'unit' in result?result.unit.display:''}</p>)}</>}
          {kind==='imaging'&&'service' in request?<InpatientImage key={request.report.diagnosticReportId} request={request} locale={locale} scope={key} allowAcknowledge={doctor&&request.status==='reported'} blocked={write.blocked} onAcknowledge={acknowledge}/>:doctor&&request.status==='reported'?<Button disabled={write.blocked} onClick={acknowledge}>{t('确认报告已阅','Acknowledge report')}</Button>:null}
        </>:null}
      </article>
    })}
    {facts.data&&facts.data.laboratoryRequests.length+facts.data.imagingRequests.length===0?<p>{t('暂无检查检验申请','No investigations')}</p>:null}
  </section>
}

function InpatientImage({request,locale,scope,allowAcknowledge,blocked,onAcknowledge}:{request:ImagingRequest;locale:WorkspaceLocale;scope:unknown[];allowAcknowledge:boolean;blocked:boolean;onAcknowledge:()=>void}) {
  const zh=locale==='zh-CN',[open,setOpen]=useState(false),[shown,setShown]=useState(false)
  const studyId=request.report!.studyId
  const study=useQuery({queryKey:[...scope,'inpatient-imaging-study',studyId],enabled:open,gcTime:0,queryFn:({signal})=>getImagingStudy(studyId,signal)})
  const source=useMemo(()=>study.data===undefined?undefined:{study:study.data,loadBlock:(path:string,signal:AbortSignal)=>getImagingStudyBlock(studyId,path,signal)},[study.data,studyId])
  return <>
    <Button variant="outline" onClick={()=>setOpen(!open)}>{open?(zh?'收起影像':'Hide images'):(zh?'查看影像':'View images')}</Button>
    {study.error?<Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(study.error,getWorkspaceMessages(locale))}</AlertDescription></Alert>:null}
    {open&&source?<Suspense fallback={<p>{zh?'正在加载影像':'Loading images'}</p>}><ImagingViewer key={studyId} locale={locale} source={source} onFrameShown={()=>setShown(true)}/></Suspense>:null}
    {allowAcknowledge?<Button disabled={blocked||!shown||study.data?.available!==true} onClick={onAcknowledge}>{zh?'确认报告已阅':'Acknowledge report'}</Button>:null}
  </>
}
