import { Badge } from '@clinmesh/ui/components/badge'
import { InpatientItemRow } from './inpatient-layout.tsx'
import { laboratoryGenerationErrorMessage } from './laboratory-generation-error.ts'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { z } from 'zod'
import { PlusIcon } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { SessionContext, ImagingRequest } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientInvestigationCatalogSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { apiGet, getImagingStudy, getImagingStudyBlock } from './api-client.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { AgentReviewAnchor } from './agent-review.tsx'
import { inpatientReportAnchor, useInpatientAgentState } from './inpatient-agent-tools.tsx'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { InpatientInvestigationComposer, type InpatientInvestigationSelection } from './inpatient-investigation-composer.tsx'
import { LaboratoryReportVersion } from './doctor/laboratory-page.tsx'
import { ReportText } from './doctor/imaging-page.tsx'
import { formatClinicalDateTime } from './doctor/clinical-date-time.ts'

type Write=ReturnType<typeof useInpatientWriteIntent>
type Props={admission:InpatientAdmission;session:SessionContext;locale:WorkspaceLocale;write:Write}
type CatalogItem=z.infer<typeof inpatientInvestigationCatalogSchema>['items'][number]
const ImagingViewer=lazy(()=>import('./imaging/imaging-viewer.tsx').then(module=>({default:module.ImagingViewer})))

export function InpatientInvestigations({admission,session,locale,write}:Props) {
  const zh=locale==='zh-CN',t=(cn:string,en:string)=>zh?cn:en,doctor=session.actor.roleCode==='inpatient-doctor',nurse=session.actor.roleCode==='ward-nurse',messages=getWorkspaceMessages(locale)
  const key=['inpatient',session.actor.workspaceId,session.actor.epoch,session.actor.practitionerRoleId]
  const facts=useQuery({queryKey:[...key,admission.id,'investigations'],queryFn:({signal})=>apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/investigations`,inpatientInvestigationsSchema,signal)})
  const catalog=useQuery({queryKey:[...key,'investigation-catalog'],enabled:doctor,queryFn:({signal})=>apiGet('/api/his/v1/inpatient/investigation-catalog',inpatientInvestigationCatalogSchema,signal)})
  const [issuing,setIssuing]=useState(false),[shownReports,setShownReports]=useState<ReadonlySet<string>>(()=>new Set())
  const blocked=write.blocked||admission.status!=='admitted'
  const issue=(item:CatalogItem,selection:InpatientInvestigationSelection,done:()=>void)=>{
    const common={admissionId:admission.id,encounterVersion:admission.versionId,catalogVersion:item.version}
    write.mutation.mutate({operation:'inpatient.investigation.issue',input:{...common,selection:selection.kind==='imaging'?{kind:'imaging',serviceId:item.id,indication:selection.indication}:{kind:'laboratory',catalogItemId:item.id,indicationCode:selection.indicationCode}}},{onSuccess:done})
  }
  const markShown=useCallback((reportId:string,shown:boolean)=>setShownReports(current=>{
    if(current.has(reportId)===shown)return current
    const next=new Set(current); if(shown)next.add(reportId); else next.delete(reportId); return next
  }),[])
  const error=facts.error??catalog.error
  const status=(value:string,sent:boolean)=>({issued:sent?t('已送检，待受理','Sent, awaiting acceptance'):t('待送检','Awaiting dispatch'),accepted:t('已受理','Accepted'),'in-progress':t('执行中','In progress'),'generation-failed':t('结果生成失败','Result failed'),reported:t('待阅','Awaiting review'),acknowledged:t('报告已阅','Acknowledged'),cancelled:t('已取消','Cancelled')}[value]??value)
  const rows=[...(facts.data?.laboratoryRequests??[]).map(request=>({kind:'laboratory' as const,request})),...(facts.data?.imagingRequests??[]).map(request=>({kind:'imaging' as const,request}))]
  const nameOf=(request:typeof rows[number]['request'])=>'service' in request?request.service.name:request.laboratoryService?.nameZh??request.referenceConcept?.display??request.catalogItemId
  const ackInput=(request:typeof rows[number]['request'])=>request.report===undefined?undefined:{admissionId:admission.id,requestId:request.id,expectedRequestVersion:request.version,serviceRequestVersion:request.serviceRequestVersion,taskVersion:request.taskVersion!,diagnosticReportId:request.report.diagnosticReportId,diagnosticReportVersion:request.report.diagnosticReportVersion}
  const acknowledge=(request:typeof rows[number]['request'])=>{const input=ackInput(request);if(input)write.mutation.mutate({operation:'inpatient.investigation.acknowledge',input})}
  // 操作栏逐份确认：优先可立即已阅的报告，影像须先实际显示首帧。
  const unread=rows.filter(row=>row.request.status==='reported'&&row.request.report!==undefined)
  const ready=(row:typeof rows[number])=>row.kind==='laboratory'||shownReports.has(row.request.report!.diagnosticReportId)
  const next=unread.find(ready)??unread[0]
  return <section aria-label={t('住院检查检验','Inpatient investigations')} className="flex flex-col gap-3">
    {error?<Alert variant="destructive"><AlertDescription>{t('检查检验读取失败：', 'Investigations failed to load: ')}{getWorkspaceErrorMessage(error,messages)}<Button variant="outline" size="sm" onClick={() => { void facts.refetch(); void catalog.refetch() }}>{t('重试检查检验', 'Retry investigations')}</Button></AlertDescription></Alert>:null}
    {facts.isPending?<Skeleton className="h-24 w-full" />:null}
    {rows.map(({kind,request})=>{
      const sent=facts.data?.sent.some(item=>item.requestId===request.id)===true
      const input={admissionId:admission.id,requestId:request.id,expectedRequestVersion:request.version,serviceRequestVersion:request.serviceRequestVersion,taskVersion:request.taskVersion!}
      const renderRow = (imageActions?: ReactNode, imageContent?: ReactNode) => <InpatientItemRow key={request.id} title={nameOf(request)} complete={request.status === 'acknowledged'}
        badge={<span className="text-xs text-muted-foreground">{kind==='imaging'?t('检查','Imaging'):t('检验','Laboratory')}</span>}
        metadata={request.report ? <>{'impression' in request.report ? <><span className="basis-full line-clamp-2">{t('印象 ','Impression ')}{request.report.impression}</span>{request.status==='reported'&&!shownReports.has(request.report.diagnosticReportId)?<span>{t('先查看影像，再已阅', 'View images before acknowledging')}</span>:null}</> : <>{request.report.results.slice(0, 3).map((result, index) => <span key={index} className={result.interpretation === 'high' || result.interpretation === 'low' ? 'text-warning' : undefined}>{result.display} <b>{typeof result.value === 'object' ? result.value.display : String(result.value)} {'unit' in result ? result.unit.display : ''}{result.interpretation === 'high' ? ' ↑' : result.interpretation === 'low' ? ' ↓' : ''}</b> · {t('参考 ', 'Reference ')}{result.referenceRange.text}</span>)}{request.report.results.length > 3 ? <span>{t(`另 ${request.report.results.length - 3} 项见完整报告`, `${request.report.results.length - 3} more in the full report`)}</span> : null}</>}<span>{t('签发 ', 'Issued ')}{formatClinicalDateTime(request.report.issuedAt, locale)}</span></> : undefined}
        actions={<><Badge variant={request.status==='reported'||request.status==='generation-failed'?'warning':'outline'}>{status(request.status,sent)}</Badge>
          {nurse&&request.status==='issued'&&!sent?<Button disabled={blocked} onClick={()=>write.mutation.mutate({operation:'inpatient.investigation.send',input})}>{t('校对并送检','Verify and send')}</Button>:null}
          {doctor&&((request.status==='issued'&&!sent)||request.status==='generation-failed')?<Button variant="outline" disabled={blocked} onClick={()=>write.mutation.mutate({operation:'inpatient.investigation.cancel',input})}>{t('取消检查申请','Cancel investigation')}</Button>:null}
          {doctor&&request.status==='generation-failed'&&!['INVESTIGATION_TRUTH_INCOMPATIBLE','INVESTIGATION_UNSUPPORTED'].includes(request.generationError?.code??'')?<Button disabled={blocked} onClick={()=>write.mutation.mutate({operation:'inpatient.investigation.retry',input})}>{t('重试结果生成','Retry result')}</Button>:null}
          {request.report && kind === 'laboratory' && doctor && request.status === 'reported' ? <Button variant="outline" disabled={write.blocked} onClick={()=>acknowledge(request)}>{t('已阅','Acknowledge report')}</Button> : null}
          {imageActions}
        </>}>
        {request.generationError?<p>{kind==='laboratory'?laboratoryGenerationErrorMessage(request.generationError.code,locale):t('本次检查没有取得结果，未生成报告。可以重试，或取消该申请。','This examination produced no result and no report. Retry or cancel the request.')}</p>:null}
        {request.previousReports.map(report=><details className="clinmesh-inpatient-disclosure" key={report.diagnosticReportId}><summary>{t('既往报告修订','Previous report revision')} {report.revisionNumber}</summary>{'impression' in report?<ReportText locale={locale} report={report}/>:<LaboratoryReportVersion current={false} locale={locale} messages={messages} report={report}/>}</details>)}
        {request.report?<details className="clinmesh-inpatient-disclosure"><summary>{t('查看完整报告', 'View full report')}</summary><div className="min-w-0 overflow-x-auto">
          {'impression' in request.report?<ReportText locale={locale} report={request.report}/>:<LaboratoryReportVersion current locale={locale} messages={messages} report={request.report}/>}
        </div></details>:null}
        {imageContent}
        <AgentReviewAnchor id={inpatientReportAnchor(admission.id, request.id)} />
      </InpatientItemRow>
      return kind === 'imaging' && 'service' in request && request.report
        ? <InpatientImage key={request.report.diagnosticReportId} admissionId={admission.id} request={request} locale={locale} scope={key} allowAcknowledge={doctor && request.status === 'reported'} blocked={write.blocked} onAcknowledge={()=>acknowledge(request)} onShown={markShown}>{renderRow}</InpatientImage>
        : renderRow()
    })}
    {facts.data&&rows.length===0?<p>{t('暂无检查检验申请','No investigations')}</p>:null}
    {doctor ? <div><Button variant="ghost" disabled={blocked} onClick={() => setIssuing(true)}><PlusIcon aria-hidden="true" />{t('开立住院检查', 'Order investigation')}</Button></div> : null}
    {doctor ? <InpatientInvestigationComposer open={issuing} onOpenChange={setIssuing} items={catalog.data?.items ?? []} locale={locale} disabled={blocked || write.mutation.isPending} onIssue={issue}
      error={write.mutation.isError && write.mutation.variables?.operation === 'inpatient.investigation.issue' ? getWorkspaceErrorMessage(write.mutation.error, messages) : undefined} /> : null}
    {doctor && next ? <InpatientPrimaryAction stage="investigations"><WorkspaceActionBar tone={write.blocked || !ready(next) ? 'blocked' : 'normal'}
      summary={unread.length > 1 ? t(`共 ${unread.length} 份待已阅，逐份确认`, `${unread.length} reports to acknowledge`) : undefined}
      reason={!ready(next) ? t('还差：先查看影像再已阅', 'View the images before acknowledging') : t('已阅后记入本次住院', 'Acknowledgement is recorded for this admission')}
      action={<Button disabled={write.blocked || !ready(next)} onClick={() => acknowledge(next.request)}>{t(`已阅：${nameOf(next.request)}`, `Acknowledge: ${nameOf(next.request)}`)}</Button>} /></InpatientPrimaryAction> : null}
  </section>
}

function InpatientImage({admissionId,request,locale,scope,allowAcknowledge,blocked,onAcknowledge,onShown,children}:{admissionId:string;request:ImagingRequest;locale:WorkspaceLocale;scope:unknown[];allowAcknowledge:boolean;blocked:boolean;onAcknowledge:()=>void;onShown:(reportId:string,shown:boolean)=>void;children:(actions:ReactNode,viewer:ReactNode)=>ReactNode}) {
  const zh=locale==='zh-CN',[open,setOpen]=useState(false),[shown,setShown]=useState(false)
  const agent = useInpatientAgentState()
  const shownReport = useMemo(() => ({ admissionId, requestId: request.id, diagnosticReportId: request.report!.diagnosticReportId,
    diagnosticReportVersion: request.report!.diagnosticReportVersion }), [admissionId, request.id, request.report?.diagnosticReportId, request.report?.diagnosticReportVersion])
  const setReportShown = agent?.setReportShown
  const studyId=request.report!.studyId
  const study=useQuery({queryKey:[...scope,'inpatient-imaging-study',studyId],enabled:open,gcTime:0,queryFn:({signal})=>getImagingStudy(studyId,signal)})
  const source=useMemo(()=>study.data===undefined?undefined:{study:study.data,loadBlock:(path:string,signal:AbortSignal)=>getImagingStudyBlock(studyId,path,signal)},[study.data,studyId])
  useEffect(() => () => setReportShown?.(shownReport, false), [setReportShown, shownReport])
  useEffect(() => { if (study.data?.available !== true || study.error) setReportShown?.(shownReport, false) }, [study.data?.available, study.error, setReportShown, shownReport])
  const reportId = shownReport.diagnosticReportId, available = study.data?.available === true && !study.error
  useEffect(() => { onShown(reportId, shown && available); return () => onShown(reportId, false) }, [onShown, reportId, shown, available])
  const actions = <>
    <Button variant="outline" onClick={()=>setOpen(!open)}>{open?(zh?'收起影像':'Hide images'):(zh?'查看影像':'View images')}</Button>
    {allowAcknowledge?<Button variant="outline" disabled={blocked||!shown||study.data?.available!==true} onClick={onAcknowledge}>{zh?'已阅':'Acknowledge report'}</Button>:null}
  </>
  const viewer = <>
    {study.error?<Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(study.error,getWorkspaceMessages(locale))}</AlertDescription></Alert>:null}
    {open&&source?<Suspense fallback={<p>{zh?'正在加载影像':'Loading images'}</p>}><ImagingViewer key={studyId} locale={locale} source={source} onFrameShown={()=>{ setShown(true); if (study.data?.available === true) setReportShown?.(shownReport, true) }}/></Suspense>:null}
  </>
  return children(actions, viewer)
}
