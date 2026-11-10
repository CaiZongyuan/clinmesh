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
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
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
import { ReportText } from './doctor/investigation-service-details.tsx'
import { formatClinicalDateTime } from './doctor/clinical-date-time.ts'
import { formatLabReferenceRange, formatLabResultDisplay } from './inpatient-report-format.ts'
import { InpatientReportBody, InpatientLabReportTable } from './inpatient-report-body.tsx'
import { InpatientReportReader } from './inpatient-report-reader.tsx'
import { InpatientInvestigationActionBatch } from './inpatient-investigation-action-batch.tsx'

type Write=ReturnType<typeof useInpatientWriteIntent>
type Props={admission:InpatientAdmission;session:SessionContext;locale:WorkspaceLocale;write:Write;onOpenStage?:(stage:string)=>void}
type CatalogItem=z.infer<typeof inpatientInvestigationCatalogSchema>['items'][number]
type InvestigationRequest = z.infer<typeof inpatientInvestigationsSchema>['laboratoryRequests'][number] | ImagingRequest
type Report = NonNullable<InvestigationRequest['report']>
const reportKey = (admissionId: string, report: Report) => `${admissionId}:${report.diagnosticReportId}:${report.diagnosticReportVersion}`
const ImagingViewer=lazy(()=>import('./imaging/imaging-viewer.tsx').then(module=>({default:module.ImagingViewer})))

export function InpatientInvestigations({admission,session,locale,write,onOpenStage}:Props) {
  const zh=locale==='zh-CN',t=(cn:string,en:string)=>zh?cn:en,doctor=session.actor.roleCode==='inpatient-doctor',nurse=session.actor.roleCode==='ward-nurse',messages=getWorkspaceMessages(locale)
  const key=['inpatient',session.user.id,session.actor]
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
  const unread=rows.filter(row=>row.request.status==='reported'&&row.request.report!==undefined)
  return <section aria-label={t('住院检查检验','Inpatient investigations')} className="flex flex-col gap-3">
    {error?<Alert variant="destructive"><AlertDescription>{t('检查检验读取失败：', 'Investigations failed to load: ')}{getWorkspaceErrorMessage(error,messages)}<Button variant="outline" size="sm" onClick={() => { void facts.refetch(); void catalog.refetch() }}>{t('重试检查检验', 'Retry investigations')}</Button></AlertDescription></Alert>:null}
    {facts.isPending?<Skeleton className="h-24 w-full" />:null}
    {doctor && facts.data ? <InpatientInvestigationActionBatch admission={admission} session={session} locale={locale} write={write} data={facts.data}
      loading={facts.isPending || facts.isError} refresh={async () => { const fresh = await facts.refetch(); return fresh.isSuccess ? fresh.data : undefined }} /> : null}
    {doctor && facts.data ? <InpatientReportReader admission={admission} session={session} locale={locale} write={write} data={facts.data}
      loading={facts.isPending || facts.isError} refresh={async () => { const fresh = await facts.refetch(); return fresh.isSuccess ? fresh.data : undefined }} /> : null}
    {rows.filter(row => !doctor || row.request.report !== undefined).map(({kind,request})=>{
      const sent=facts.data?.sent.some(item=>item.requestId===request.id)===true
      const input={admissionId:admission.id,requestId:request.id,expectedRequestVersion:request.version,serviceRequestVersion:request.serviceRequestVersion,taskVersion:request.taskVersion!}
      const isAngio = kind === 'imaging' && 'service' in request && (request.service.name.includes('造影') || request.service.code.toLowerCase().includes('angio'))
      const renderRow = (imageActions?: ReactNode, imageContent?: ReactNode) => <InpatientItemRow key={request.id} title={nameOf(request)} complete={request.status === 'acknowledged'}
        badge={<span className="text-xs text-muted-foreground">{kind==='imaging'?t('检查','Imaging'):t('检验','Laboratory')}</span>}
        metadata={request.report ? <>{!doctor || request.status === 'acknowledged' ? <ReportSummary report={request.report} locale={locale} compact={doctor} /> : null}{'impression' in request.report && request.status === 'reported' && !shownReports.has(reportKey(admission.id, request.report)) ? <span>{t('先查看影像，再已阅', 'View images before acknowledging')}</span> : null}<span>{t('签发 ', 'Issued ')}{formatClinicalDateTime(request.report.issuedAt, locale)}</span></> : undefined}
        actions={<><Badge variant={request.status==='reported'||request.status==='generation-failed'?'warning':'outline'}>{status(request.status,sent)}</Badge>
          {nurse&&request.status==='issued'&&!sent?<Button disabled={blocked} onClick={()=>write.mutation.mutate({operation:'inpatient.investigation.send',input})}>{t('校对并送检','Verify and send')}</Button>:null}
          {imageActions}
          {doctor && request.report && (request.status === 'acknowledged' || request.previousReports.length > 0) ? <InpatientReportDetails key={`${JSON.stringify(key)}:${reportKey(admission.id, request.report)}`} request={request} name={nameOf(request)} locale={locale} /> : null}
        </>}>
        {isAngio && request.report && 'findings' in request.report && (!doctor || request.status === 'reported') ? <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-info/30 bg-info/5 px-3 py-1.5 text-xs">
          <span><strong>{t('造影发现（结构化报告）：', 'Angiography findings (structured report): ')}</strong>{request.report.findings}</span>
          {onOpenStage ? <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs text-info" onClick={() => onOpenStage('surgery')}>{t('已带入手术选型 ›', 'Copied to surgery selection ›')}</Button> : null}
        </div> : null}
        {request.generationError?<p>{kind==='laboratory'?laboratoryGenerationErrorMessage(request.generationError.code,locale):t('本次检查没有取得结果，未生成报告。可以重试，或取消该申请。','This examination produced no result and no report. Retry or cancel the request.')}</p>:null}
        {doctor && request.report && request.status === 'reported' ? <div className="min-w-0 overflow-x-auto"><InpatientReportBody report={request.report} locale={locale} /></div> : null}
        {!doctor ? request.previousReports.map(report=><details className="clinmesh-inpatient-disclosure" key={report.diagnosticReportId}><summary>{t('既往报告修订','Previous report revision')} {report.revisionNumber}</summary>{'impression' in report?<ReportText locale={locale} report={report}/>:<InpatientLabReportTable locale={locale} report={report}/>}</details>) : null}
        {!doctor && request.report?<details className="clinmesh-inpatient-disclosure"><summary>{t('查看完整报告', 'View full report')}</summary><div className="min-w-0 overflow-x-auto">
          {'impression' in request.report?<ReportText locale={locale} report={request.report}/>:<InpatientLabReportTable locale={locale} report={request.report}/>}
        </div></details>:null}
        {imageContent}
        <AgentReviewAnchor id={inpatientReportAnchor(admission.id, request.id)} />
      </InpatientItemRow>
      return kind === 'imaging' && 'service' in request && request.report
        ? <InpatientImage key={`${reportKey(admission.id, request.report)}:${request.status}`} admissionId={admission.id} request={request} locale={locale} scope={key} onShown={markShown}>{renderRow}</InpatientImage>
        : renderRow()
    })}
    {facts.data&&rows.length===0?<p>{t('暂无检查检验申请','No investigations')}</p>:null}
    {doctor && !issuing ? <div><Button variant="outline" size="sm" disabled={blocked} onClick={() => setIssuing(true)}><PlusIcon aria-hidden="true" />{t('开立住院检查', 'Order investigation')}</Button></div> : null}
    {doctor ? <InpatientInvestigationComposer open={issuing} onOpenChange={setIssuing} items={catalog.data?.items ?? []} locale={locale} disabled={blocked || write.mutation.isPending} onIssue={issue}
      error={write.mutation.isError && write.mutation.variables?.operation === 'inpatient.investigation.issue' ? getWorkspaceErrorMessage(write.mutation.error, messages) : undefined} /> : null}
    {doctor ? <InpatientPrimaryAction stage="investigations" priority={-30}><WorkspaceActionBar showWithoutAction reason={unread.length > 0 ? t(`共 ${unread.length} 份待阅，请打开连续阅读住院报告`, `${unread.length} unread reports; open the inpatient report reader`) : t('送检和出报告由其他岗位完成，报告签发后这里会提醒你', 'Dispatch and reporting are completed by other roles; you will be notified here once reports are issued')} /></InpatientPrimaryAction> : null}
  </section>
}

function ReportSummary({ report, locale, compact }: { report: Report; locale: WorkspaceLocale; compact: boolean }) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  if ('impression' in report) return <span className="basis-full line-clamp-2">{compact ? null : t('印象 ', 'Impression ')}{report.impression}</span>
  if (!compact) return <>{report.results.slice(0, 3).map((result, index) => <span key={index} className={result.interpretation === 'high' || result.interpretation === 'low' ? 'text-warning' : undefined}>{formatLabResultDisplay(result.display)} <b>{typeof result.value === 'object' ? result.value.display : String(result.value)}{'unit' in result && result.unit.display !== '1' ? ` ${result.unit.display}` : ''}{result.interpretation === 'high' ? ' ↑' : result.interpretation === 'low' ? ' ↓' : ''}</b> · {t('参考 ', 'Reference ')}{formatLabReferenceRange(result.referenceRange.text)}</span>)}{report.results.length > 3 ? <span>{t(`另 ${report.results.length - 3} 项见完整报告`, `${report.results.length - 3} more in the full report`)}</span> : null}</>
  const abnormal = report.results.filter(result => result.interpretation === 'high' || result.interpretation === 'low')
  return <span className="basis-full line-clamp-2">{(abnormal.length > 0 ? abnormal : report.results).slice(0, 3).map(result => `${formatLabResultDisplay(result.display)} ${typeof result.value === 'object' ? result.value.display : result.value}${'unit' in result && result.unit.display !== '1' ? ` ${result.unit.display}` : ''}${result.interpretation === 'high' ? ' ↑' : result.interpretation === 'low' ? ' ↓' : ''}`).join(' · ')}{report.results.length > 3 ? locale === 'zh-CN' ? ` · 共 ${report.results.length} 项` : ` · ${report.results.length} results` : ''}</span>
}

function InpatientReportDetails({ request, name, locale }: { request: InvestigationRequest; name: string; locale: WorkspaceLocale }) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  return <Dialog>
    <DialogTrigger render={<Button variant="outline" size="sm" />}>{request.status === 'acknowledged' ? t('查看全文', 'View full report') : t('既往修订', 'Previous revisions')}</DialogTrigger>
    <DialogContent className="sm:max-w-[720px]">
      <DialogHeader><DialogTitle>{name}{t(' · 完整报告', ' · Full report')}</DialogTitle><DialogDescription>{t('签发 ', 'Issued ')}{formatClinicalDateTime(request.report!.issuedAt, locale)}</DialogDescription></DialogHeader>
      <div className="min-h-0 overflow-auto p-4 flex flex-col gap-4">
        <section aria-label={t('当前报告', 'Current report')}><InpatientReportBody report={request.report!} locale={locale} /></section>
        {request.previousReports.map(report => <section key={report.diagnosticReportId} className="border-t pt-4 flex flex-col gap-2" aria-label={t('既往报告修订', 'Previous report revision')}><h4 className="text-sm font-medium">{t('既往报告修订 · ', 'Previous report revision · ')}{formatClinicalDateTime(report.issuedAt, locale)}</h4><InpatientReportBody report={report} locale={locale} /></section>)}
      </div>
      <DialogFooter><DialogClose render={<Button variant="outline" />}>{t('关闭', 'Close')}</DialogClose></DialogFooter>
    </DialogContent>
  </Dialog>
}

function InpatientImage({admissionId,request,locale,scope,onShown,children}:{admissionId:string;request:ImagingRequest;locale:WorkspaceLocale;scope:unknown[];onShown:(reportId:string,shown:boolean)=>void;children:(actions:ReactNode,viewer:ReactNode)=>ReactNode}) {
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
  const reportId = reportKey(admissionId, request.report!), available = study.data?.available === true && !study.error
  useEffect(() => { onShown(reportId, shown && available); return () => onShown(reportId, false) }, [onShown, reportId, shown, available])
  const actions = <>
    <Button variant="outline" onClick={()=>setOpen(!open)}>{open?(zh?'收起影像':'Hide images'):(zh?'查看影像':'View images')}</Button>
  </>
  const viewer = <>
    {study.error?<Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(study.error,getWorkspaceMessages(locale))}</AlertDescription></Alert>:null}
    {open&&source?<Suspense fallback={<p>{zh?'正在加载影像':'Loading images'}</p>}><ImagingViewer key={studyId} locale={locale} source={source} onFrameShown={()=>{ setShown(true); if (study.data?.available === true) setReportShown?.(shownReport, true) }}/></Suspense>:null}
  </>
  return children(actions, viewer)
}
