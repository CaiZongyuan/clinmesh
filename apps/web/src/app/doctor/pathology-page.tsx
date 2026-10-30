import type { DoctorRecommendationSuggestion, DoctorReviewedInvestigationService } from '@clinmesh/contracts/doctor-recommendations'
import type { PathologyReport, PathologyRequest, PathologyServiceSnapshot } from '@clinmesh/contracts/his'
import { pathologyPurposeSchema, savePathologyRequestDraftRequestSchema } from '@clinmesh/contracts/his'
import type { PathologySourceProcedure } from '@clinmesh/contracts/pathology'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { FieldDescription, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useMutation, useQuery } from '@tanstack/react-query'
import { PlusIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRegisterAgentForm } from '../agent-page-context.tsx'
import { AgentReviewAnchor } from '../agent-review.tsx'
import {
  acknowledgePathologyReport,
  cancelPathologyRequest,
  correctPathologyReport,
  deletePathologyRequestDraft,
  getCasePathologyServices,
  getImagingStudy,
  getImagingStudyBlock,
  newIdempotencyKey,
  retryPathologyRequest,
  savePathologyRequestDraft,
} from '../api-client.ts'
import { ImagingViewer, type ImagingViewerSource } from '../imaging/imaging-viewer.tsx'
import { getWorkspaceErrorMessage } from '../workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { WorkspaceSelect } from '../workspace-select.tsx'
import { formatClinicalDateTime } from './clinical-date-time.ts'
import { DoctorDraftField as Field } from './doctor-draft-fields.tsx'
import { DoctorRecommendationsPanel, type PreparationDraft } from './doctor-recommendations.tsx'
import { DoctorRecordReviewNotice } from './doctor-record-review-notice.tsx'
import type { ImagingSummaryInsertion, ImagingViewState } from './imaging-page.tsx'
import { InvestigationBilling, InvestigationPrice, missingInvestigationPrice, reviewedInvestigationService } from './investigation-billing.tsx'
import { InvestigationRequestWorkspace } from './investigation-request-workspace.tsx'

interface PathologyRequestState {
  draft?: { purpose: string; service: PathologyServiceSnapshot; sourceProcedure: PathologySourceProcedure } | undefined
  draftVersion: number
  requests: PathologyRequest[]
}

export interface PathologyPageActions {
  /** 当前账号兼有管理员岗位时才能更正报告。 */
  canCorrect: boolean
  onChanged: () => Promise<unknown> | void
  /** 把报告摘要插入未签病历；病历已签或只读时不提供。 */
  onInsertSummary?: ((request: PathologyRequest, report: PathologyReport) => ImagingSummaryInsertion) | undefined
  /** 阅片状态与放射共用同一种结构，按申请和报告标识区分。 */
  view: ImagingViewState
}

const summaryInsertionLabels: Record<ImagingSummaryInsertion, [string, string]> = {
  duplicate: ['病历中已有这一版报告的摘要，未重复插入。', 'This report version is already in the clinical document.'],
  inserted: ['已插入病历“辅助检查”，签署病历时一并保存。', 'Inserted into the clinical document; it is saved when the document is signed.'],
  'too-long': ['病历“辅助检查”已接近长度上限，未插入。', 'The clinical document field is near its length limit; nothing was inserted.'],
}

const statusLabels: Record<PathologyRequest['status'], [string, string]> = {
  accepted: ['已收片', 'Slides received'],
  acknowledged: ['医生已阅', 'Acknowledged'],
  cancelled: ['已取消', 'Cancelled'],
  'generation-failed': ['未取得结果', 'No result'],
  'in-progress': ['阅片中', 'Under review'],
  issued: ['已开立', 'Issued'],
  reported: ['报告已出', 'Reported'],
}

function procedureLabel(procedure: PathologySourceProcedure): string {
  return `${procedure.display ?? procedure.code} · ${procedure.performedAt.slice(0, 10)}`
}

function ReportText({ locale, report }: { locale: WorkspaceLocale; report: PathologyReport }) {
  const zh = locale === 'zh-CN'
  return (
    <dl className="mt-2 grid gap-2 text-sm">
      <div>
        <dt className="text-xs text-muted-foreground">{zh ? '标本信息' : 'Specimen'}</dt>
        <dd>
          {zh
            ? `既往手术：${procedureLabel(report.specimen.procedure)}；HE 染色切片 ${report.specimen.slideCount} 张`
            : `Source procedure: ${procedureLabel(report.specimen.procedure)}; ${report.specimen.slideCount} H&E slide(s)`}
        </dd>
      </div>
      <div><dt className="text-xs text-muted-foreground">{zh ? '镜下所见' : 'Microscopy'}</dt><dd>{report.microscopy}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{zh ? '病理诊断' : 'Diagnosis'}</dt><dd>{report.diagnosis}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{zh ? '既有免疫组化结果' : 'Prior immunohistochemistry'}</dt><dd>{report.immunohistochemistry}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{zh ? '备注' : 'Note'}</dt><dd>{report.note}</dd></div>
      <div className="text-xs text-muted-foreground">
        {zh ? '病理科 · 收片 ' : 'Pathology · Received '}{formatClinicalDateTime(report.receivedAt, locale)}
        {zh ? ' · 签发 ' : ' · Issued '}{formatClinicalDateTime(report.issuedAt, locale)}
        {zh ? ` · 第 ${report.revisionNumber} 版` : ` · Revision ${report.revisionNumber}`}
        {report.revisionNumber === 1 ? '' : zh ? `，更正原因：${report.revisionReason}` : `: ${report.revisionReason}`}
        {report.acknowledgement === undefined ? '' : zh ? ` · 已阅 ${formatClinicalDateTime(report.acknowledgement.acknowledgedAt, locale)}` : ` · Acknowledged ${formatClinicalDateTime(report.acknowledgement.acknowledgedAt, locale)}`}
      </div>
    </dl>
  )
}

/** 管理员更正表单：只选择同一切片素材另一份已复核发布的报告内容修订，不接受自由改写。 */
function PathologyReportCorrection({ locale, onChanged, report, request }: {
  locale: WorkspaceLocale
  onChanged: () => Promise<unknown> | void
  report: PathologyReport
  request: PathologyRequest
}) {
  const zh = locale === 'zh-CN'
  const messages = getWorkspaceMessages(locale)
  const [reportRevision, setReportRevision] = useState('')
  const [reason, setReason] = useState('')
  const correction = useMutation({
    mutationFn: () => correctPathologyReport(
      request,
      report,
      { reason: reason.trim(), reportRevision: Number(reportRevision) },
      newIdempotencyKey(),
    ),
    onSettled: () => onChanged(),
  })
  const idPrefix = `pathology-correction-${request.id}`
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-muted-foreground">{zh ? '更正报告（管理员）' : 'Correct report (administrator)'}</summary>
      <div className="mt-2 grid gap-2">
        <p className="text-xs text-muted-foreground">
          {zh
            ? '更正会按所选的报告内容修订重新签发报告，原报告与原确认保留。可选修订见“病理覆盖清单”中该切片的复核预览。'
            : 'A correction reissues the report from the selected reviewed revision; the earlier report and acknowledgement are kept.'}
        </p>
        <div>
          <label className="text-xs text-muted-foreground" htmlFor={`${idPrefix}-revision`}>{zh ? '报告内容修订号' : 'Report content revision'}</label>
          <Input
            id={`${idPrefix}-revision`}
            min={1}
            onChange={event => setReportRevision(event.target.value)}
            type="number"
            value={reportRevision}
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground" htmlFor={`${idPrefix}-reason`}>{zh ? '更正原因' : 'Reason'}</label>
          <Textarea id={`${idPrefix}-reason`} maxLength={500} onChange={event => setReason(event.target.value)} value={reason} />
        </div>
        <div>
          <Button
            disabled={!/^[1-9]\d*$/.test(reportRevision) || reason.trim().length < 2 || correction.isPending}
            onClick={() => correction.mutate()}
            size="sm"
            variant="outline"
          >
            {zh ? '提交更正' : 'Submit correction'}
          </Button>
        </div>
        {correction.isError ? (
          <Alert variant="destructive">
            <AlertTitle>{zh ? '报告未更正' : 'The report was not corrected'}</AlertTitle>
            <AlertDescription>{getWorkspaceErrorMessage(correction.error, messages)}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </details>
  )
}

/** 一条会诊申请：状态、报告、切片入口，以及进行中病例的取消、重试与确认已阅。 */
function PathologyRequestItem({ actions, active, locale, readOnly, request, selectedReportId }: {
  actions: PathologyPageActions
  active: boolean
  locale: WorkspaceLocale
  readOnly: boolean
  request: PathologyRequest
  selectedReportId?: string | undefined
}) {
  const zh = locale === 'zh-CN'
  const messages = getWorkspaceMessages(locale)
  const { onChanged, onInsertSummary, view } = actions
  const [summaryInsertion, setSummaryInsertion] = useState<ImagingSummaryInsertion>()
  const targetedHistory = request.previousReports.some(report => report.diagnosticReportId === selectedReportId)
  const [historyOpen, setHistoryOpen] = useState(targetedHistory)
  useEffect(() => { if (targetedHistory) setHistoryOpen(true) }, [targetedHistory])
  const viewerOpen = active && view.isOpen(request.id)
  const diagnosticReportId = request.report?.diagnosticReportId
  const studyId = request.report?.studyId
  const study = useQuery({
    enabled: viewerOpen && studyId !== undefined,
    gcTime: 0,
    queryFn: ({ signal }) => getImagingStudy(studyId!, signal),
    queryKey: ['imaging-study', studyId ?? 'none'],
  })
  // 显示过切片之后检查又报告不可读时（例如重新读取发现文件缺失），不再开放确认已阅。
  const slideShown = diagnosticReportId !== undefined && view.isShown(diagnosticReportId) && study.data?.available === true
  const source = useMemo<ImagingViewerSource | undefined>(() => study.data === undefined || studyId === undefined
    ? undefined
    : { loadBlock: (path, signal) => getImagingStudyBlock(studyId, path, signal), study: study.data },
  [study.data, studyId])
  const handleSlideShown = useCallback(() => {
    if (diagnosticReportId !== undefined) view.markShown(diagnosticReportId)
  }, [diagnosticReportId, view])
  const action = useMutation({
    mutationFn: async (kind: 'acknowledge' | 'cancel' | 'retry'): Promise<void> => {
      if (kind === 'cancel') await cancelPathologyRequest(request, newIdempotencyKey())
      else if (kind === 'retry') await retryPathologyRequest(request, newIdempotencyKey())
      else await acknowledgePathologyReport(request, request.report!, newIdempotencyKey())
    },
    onSettled: () => onChanged(),
  })
  return (
    <li className="border-t py-3"><AgentReviewAnchor id={`doctor-investigation:${request.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm font-medium">{request.service.name}</strong>
        <Badge variant={request.status === 'acknowledged' ? 'success' : request.status === 'generation-failed' ? 'warning' : 'outline'}>
          {statusLabels[request.status][zh ? 0 : 1]}
        </Badge>
        <span className="text-xs text-muted-foreground">{zh ? '送检手术：' : 'Source procedure: '}{procedureLabel(request.sourceProcedure)}</span>
        <span className="text-xs text-muted-foreground">{zh ? '会诊目的：' : 'Purpose: '}{request.purpose}</span>
      </div>
      <InvestigationBilling billing={request.billing} locale={locale} />
      {request.status === 'generation-failed' ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {zh ? '本次会诊没有取得结果，未生成报告。可以重试，或取消该申请。' : 'This consultation produced no result and no report. Retry or cancel the request.'}
        </p>
      ) : null}
      {request.report === undefined ? null : (
        <>
          <ReportText locale={locale} report={request.report} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button onClick={() => view.setOpen(request.id, !viewerOpen)} size="sm" variant="outline">
              {viewerOpen ? (zh ? '收起切片' : 'Hide slide') : (zh ? '打开切片' : 'Open slide')}
            </Button>
            {onInsertSummary === undefined ? null : (
              <Button onClick={() => setSummaryInsertion(onInsertSummary(request, request.report!))} size="sm" variant="outline">
                {zh ? '摘要插入病历' : 'Insert summary into record'}
              </Button>
            )}
            {readOnly || request.status !== 'reported' ? null : (
              <>
                <Button
                  disabled={!slideShown || action.isPending}
                  onClick={() => action.mutate('acknowledge')}
                  size="sm"
                >
                  {zh ? '确认已阅' : 'Acknowledge'}
                </Button>
                {slideShown ? null : (
                  <span className="text-xs text-muted-foreground">
                    {zh ? '打开切片并成功显示后才能确认已阅' : 'Open the slide before acknowledging'}
                  </span>
                )}
              </>
            )}
          </div>
          {summaryInsertion === undefined ? null : (
            <p className="mt-1 text-xs text-muted-foreground" role="status">{summaryInsertionLabels[summaryInsertion][zh ? 0 : 1]}</p>
          )}
          {!viewerOpen ? null : study.isPending ? <Skeleton className="mt-2 h-40 w-full" /> : study.isError || source === undefined ? (
            <Alert className="mt-2" variant="destructive">
              <AlertTitle>{zh ? '无法打开切片' : 'Unable to open the slide'}</AlertTitle>
              <AlertDescription>
                <Button onClick={() => void study.refetch()} size="sm" variant="outline">{zh ? '重试' : 'Retry'}</Button>
              </AlertDescription>
            </Alert>
          ) : (
            <div className="mt-2">
              <ImagingViewer key={studyId} locale={locale} onFrameShown={handleSlideShown} source={source} />
            </div>
          )}
          {request.previousReports.length === 0 ? null : (
            <details className="mt-2" onToggle={event => setHistoryOpen(event.currentTarget.open)} open={historyOpen}>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {zh ? `历史报告 · ${request.previousReports.length}` : `Earlier reports · ${request.previousReports.length}`}
              </summary>
              {request.previousReports.map(report => <ReportText key={report.diagnosticReportId} locale={locale} report={report} />)}
            </details>
          )}
          {actions.canCorrect
            ? <PathologyReportCorrection locale={locale} onChanged={onChanged} report={request.report} request={request} />
            : null}
        </>
      )}
      {readOnly ? null : (
        <div className="mt-2 flex flex-wrap gap-2">
          {request.status === 'generation-failed' ? (
            <Button disabled={action.isPending} onClick={() => action.mutate('retry')} size="sm" variant="outline">
              {zh ? '重试' : 'Retry'}
            </Button>
          ) : null}
          {request.status === 'issued' || request.status === 'generation-failed' ? (
            <Button disabled={action.isPending} onClick={() => action.mutate('cancel')} size="sm" variant="outline">
              {zh ? '取消申请' : 'Cancel request'}
            </Button>
          ) : null}
        </div>
      )}
      {action.isError ? (
        <Alert className="mt-2" variant="destructive">
          <AlertTitle>{zh ? '操作未完成' : 'The action did not complete'}</AlertTitle>
          <AlertDescription>{getWorkspaceErrorMessage(action.error, messages)}</AlertDescription>
        </Alert>
      ) : null}
    </AgentReviewAnchor></li>
  )
}

/** 会诊申请列表；已完诊病例以只读方式复用。 */
export function PathologyRequestList({ actions, active = true, locale, readOnly, requests, selectedReportId }: {
  actions: PathologyPageActions
  active?: boolean | undefined
  locale: WorkspaceLocale
  readOnly: boolean
  requests: PathologyRequest[]
  selectedReportId?: string | undefined
}) {
  if (requests.length === 0) return null
  return (
    <ul>
      {requests.map(request => (
        <PathologyRequestItem
          actions={actions}
          active={active}
          key={`${request.id}:${request.report?.diagnosticReportId ?? 'none'}`}
          locale={locale}
          readOnly={readOnly}
          request={request}
          selectedReportId={selectedReportId}
        />
      ))}
    </ul>
  )
}

interface PathologyComposerTarget {
  purpose: string
  procedureReference: string | null
  serviceId: string | null
}

/** 三页签统一弹窗合同（病理）：目录选会诊项目、送检手术与会诊目的在同一次弹窗内完成，点「保存草稿」落单这一条并关闭；未确认关闭即弃置弹窗内输入。 */
function PathologyComposerDialog({ draftPending, existingServiceId, locale, onConfirm, onOpenChange, open, services, target }: {
  draftPending: boolean
  existingServiceId: string | undefined
  locale: WorkspaceLocale
  onConfirm: (target: { purpose: string; procedureReference: string; serviceId: string }) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  services: Array<{ available: boolean; service: PathologyServiceSnapshot; sourceProcedures: PathologySourceProcedure[] }> | undefined
  target?: PathologyComposerTarget | undefined
}): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const targetRef = useRef(target)
  targetRef.current = target
  const openingRef = useRef(open)
  const [serviceId, setServiceId] = useState<string | null>(null)
  const [procedureReference, setProcedureReference] = useState<string | null>(null)
  const [purpose, setPurpose] = useState('')
  const [conflict, setConflict] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (open && !openingRef.current) {
      setServiceId(targetRef.current?.serviceId ?? null)
      setProcedureReference(targetRef.current?.procedureReference ?? null)
      setPurpose(targetRef.current?.purpose ?? '')
      setConflict(false)
      setQuery('')
    }
    openingRef.current = open
  }, [open])
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const visible = (services ?? []).filter(item => terms.every(term => (
    `${item.service.name} ${item.service.code} ${item.service.specimenType}`.toLocaleLowerCase().includes(term)
  )))
  const selected = (services ?? []).find(item => item.service.id === serviceId)
  const select = (item: { available: boolean; service: PathologyServiceSnapshot; sourceProcedures: PathologySourceProcedure[] }) => {
    if (existingServiceId !== undefined && item.service.id !== existingServiceId) {
      setConflict(true)
      return
    }
    setConflict(false)
    setServiceId(item.service.id)
    setProcedureReference(item.sourceProcedures[0]?.sourceReference ?? null)
  }
  const confirm = () => {
    if (serviceId === null || procedureReference === null || !pathologyPurposeSchema.safeParse(purpose).success) return
    onConfirm({ purpose, procedureReference, serviceId })
    onOpenChange(false)
  }
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex h-[min(680px,calc(100svh-2rem))] flex-col sm:max-w-4xl" data-agent-catalog="pathology">
        <DialogHeader>
          <DialogTitle>{target?.serviceId != null ? (zh ? '编辑病理会诊' : 'Edit pathology consultation') : (zh ? '选择病理会诊' : 'Select a pathology consultation')}</DialogTitle>
          <DialogDescription>{zh
            ? '在目录中选择会诊项目、送检手术并填写会诊目的，一次弹窗确认一条病理会诊申请。'
            : 'Pick a consultation and source procedure, enter the purpose; one dialog confirms one pathology request.'}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <Input aria-label={zh ? '搜索病理目录' : 'Search pathology catalog'} maxLength={128}
            onChange={event => setQuery(event.target.value)}
            placeholder={zh ? '名称、编号或标本类型' : 'Name, code, or specimen type'} value={query} />
          <div className="max-h-[12.5rem] overflow-y-auto border-y">
            {visible.length === 0 ? <p className="p-4 text-sm text-muted-foreground" role="status">{zh ? '没有匹配的病理会诊项目。' : 'No matching pathology consultations.'}</p> : (
              <ul className="divide-y">
                {visible.map(item => (
                  <li className="px-3 py-2" key={item.service.id}>
                    <Button aria-pressed={serviceId === item.service.id}
                      className="h-auto w-full min-w-0 items-start justify-start gap-2 whitespace-normal px-1 py-2 text-left"
                      disabled={!item.available || item.sourceProcedures.length === 0 || draftPending}
                      onClick={() => select(item)}
                      type="button"
                      variant={serviceId === item.service.id ? 'secondary' : 'outline'}
                    >
                      <span className="min-w-0">
                        <strong className="block truncate">{item.available ? item.service.name : zh ? `${item.service.name}：本院当前未开展` : `${item.service.name}: not currently available`}</strong>
                        <span className="block truncate text-xs text-muted-foreground">{item.service.code} · {item.service.specimenType}</span>
                        {item.sourceProcedures.length === 0 ? <span className="block truncate text-xs text-muted-foreground">{zh ? '无可送检的既往手术' : 'No eligible procedure in the history'}</span> : null}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {selected === undefined ? null : (
          <div className="flex min-w-0 flex-col gap-3 border-t pt-3">
            <dl className="flex flex-col gap-2 text-sm">
              <div><dt className="text-xs text-muted-foreground">{zh ? '会诊项目' : 'Consultation'}</dt><dd>{selected.service.name}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{zh ? '标本类型' : 'Specimen type'}</dt><dd>{selected.service.specimenType}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{zh ? '适用条件' : 'Applicability'}</dt><dd>{selected.service.applicability}</dd></div>
            </dl>
            <InvestigationPrice locale={locale} price={selected.service.outpatientBilling} />
            <Field>
              <FieldLabel htmlFor="pathology-composer-procedure">{zh ? '送检的既往手术' : 'Source procedure'}</FieldLabel>
              {selected.sourceProcedures.length === 0 ? (
                <FieldDescription>{zh ? '该患者的既往病史中没有可送检的乳腺手术。' : 'The history has no breast procedure to consult on.'}</FieldDescription>
              ) : (
                <WorkspaceSelect
                  id="pathology-composer-procedure"
                  items={selected.sourceProcedures.map(procedure => ({ label: procedureLabel(procedure), value: procedure.sourceReference }))}
                  onValueChange={setProcedureReference}
                  placeholder={zh ? '从既往病史中选择手术' : 'Select a procedure from the history'}
                  value={procedureReference}
                />
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="pathology-composer-purpose">{zh ? '会诊目的' : 'Purpose'}</FieldLabel>
              <Textarea disabled={draftPending} id="pathology-composer-purpose" maxLength={500} onChange={event => setPurpose(event.target.value)} value={purpose} />
            </Field>
          </div>
        )}
        {conflict ? <p className="text-sm text-destructive" role="alert">{zh ? '已有保存的病理会诊草稿，请先开具或删除后再更换会诊项目。' : 'Issue or delete the saved pathology draft before choosing another consultation.'}</p> : null}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>{zh ? '取消' : 'Cancel'}</DialogClose>
          <Button disabled={serviceId === null || procedureReference === null || !pathologyPurposeSchema.safeParse(purpose).success || draftPending} onClick={confirm} type="button">
            {zh ? '保存草稿' : 'Save draft'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 医生工作台的病理会诊：选择本院会诊服务、从患者可见既往病史中选择送检对应的手术并填写会诊目的，
 * 手工与自动项目共用待开具清单；目录与申请信息同屏填写，正式申请与剩余待开具项目分组管理。
 */
export function PathologyPage({ actions, active = true, caseId, elementId, encounter, locale, onSelectRequest, readOnly, recommendationRevision, recommendationScope, selectedReportId, selectedRequestId, state }: {
  actions: PathologyPageActions
  active?: boolean | undefined
  caseId: string
  editDraft?: boolean | undefined
  elementId: string
  encounter: { id: string; versionId: string }
  locale: WorkspaceLocale
  onSelectRequest?: ((requestId: string) => void) | undefined
  readOnly: boolean
  recommendationRevision?: string | undefined
  recommendationScope?: string | undefined
  selectedReportId?: string | undefined
  selectedRequestId?: string | undefined
  state: PathologyRequestState | undefined
}) {
  const { onChanged } = actions
  const zh = locale === 'zh-CN'
  const messages = getWorkspaceMessages(locale)
  const [serviceId, setServiceId] = useState<string | null>(state?.draft?.service.id ?? null)
  const [procedureReference, setProcedureReference] = useState<string | null>(state?.draft?.sourceProcedure.sourceReference ?? null)
  const [purpose, setPurpose] = useState(state?.draft?.purpose ?? '')
  const [composerOpen, setComposerOpen] = useState(false)
  const [reviewedService, setReviewedService] = useState<DoctorReviewedInvestigationService>()
  const [localSelectedId, setLocalSelectedId] = useState<string>()
  const requests = state?.requests ?? []
  const selectedRequest = requests.find(request => request.id === (selectedRequestId ?? localSelectedId)) ?? requests[0]
  const recordRef = useRef<HTMLDivElement>(null)
  const selectRequest = (requestId: string) => { setLocalSelectedId(requestId); onSelectRequest?.(requestId) }
  const services = useQuery({
    enabled: !readOnly,
    queryFn: ({ signal }) => getCasePathologyServices(caseId, signal),
    queryKey: ['doctor-case-pathology-services', caseId],
  })
  const draftVersion = state?.draftVersion ?? 0
  const parsedDraft = savePathologyRequestDraftRequestSchema.shape.input.safeParse({
    expectedDraftVersion: draftVersion,
    purpose,
    serviceId,
    sourceProcedureReference: procedureReference,
  })
  useRegisterAgentForm({
    viewId: 'consultation', selectionId: caseId, name: 'pathology',
    values: readOnly || !parsedDraft.success ? null : parsedDraft.data,
  })
  const encounterVersion = { encounterId: encounter.id, encounterVersion: encounter.versionId }
  const draftAction = useMutation({
    // 保存值随确认一次性传入：弹窗内点「保存草稿」时页面状态尚未提交。
    mutationFn: async (action: { kind: 'delete' } | { kind: 'save'; purpose: string; serviceId: string; sourceProcedureReference: string }): Promise<void> => {
      if (action.kind === 'delete') {
        await deletePathologyRequestDraft({ ...encounterVersion, expectedDraftVersion: draftVersion }, newIdempotencyKey())
        return
      }
      await savePathologyRequestDraft({
        ...encounterVersion, expectedDraftVersion: draftVersion, purpose: action.purpose, serviceId: action.serviceId,
        sourceProcedureReference: action.sourceProcedureReference,
      }, newIdempotencyKey())
    },
    onSettled: () => onChanged(),
    onSuccess: (_result, action) => { if (action.kind === 'delete') { setServiceId(null); setProcedureReference(null); setPurpose('') } },
  })
  const selectedService = services.data?.items.find(item => item.service.id === serviceId)
  const recommendationUnavailableReason = (suggestion: DoctorRecommendationSuggestion | PreparationDraft): string | undefined => {
    if (suggestion.kind !== 'pathology' || services.isFetching || draftAction.isPending) return messages.recommendationRequestTargetUnavailable
    const target = services.data?.items.find(item => item.service.id === suggestion.serviceId)
    if (target?.available !== true || !target.sourceProcedures.some(procedure => procedure.sourceReference === suggestion.sourceProcedureReference)
      || !savePathologyRequestDraftRequestSchema.shape.input.safeParse({
        expectedDraftVersion: draftVersion, serviceId: suggestion.serviceId,
        sourceProcedureReference: suggestion.sourceProcedureReference, purpose: suggestion.purpose,
      }).success) return messages.recommendationRequestTargetUnavailable
    return target.service.outpatientBilling === undefined ? missingInvestigationPrice(locale) : undefined
  }
  // 三页签统一结构（病理）：左主列为入口与草稿卡片，目录检索、送检手术与会诊目的在同一次弹窗内完成。
  const composerTarget = useMemo<PathologyComposerTarget>(() => ({ procedureReference, purpose, serviceId }), [procedureReference, purpose, serviceId])
  const selectedProcedure = selectedService?.sourceProcedures.find(procedure => procedure.sourceReference === procedureReference)
  const editor = readOnly ? null : services.isPending ? <Skeleton className="mt-3 h-24 w-full" /> : services.isError ? (
    <Alert className="mt-3" variant="destructive">
      <AlertTitle>{zh ? '无法加载病理会诊服务' : 'Unable to load pathology services'}</AlertTitle>
      <AlertDescription>
        <Button onClick={() => void services.refetch()} size="sm" variant="outline">{zh ? '重试' : 'Retry'}</Button>
      </AlertDescription>
    </Alert>
  ) : (
    <section aria-label={zh ? '开具病理会诊' : 'Prepare pathology consultation'} className="flex min-w-0 flex-col gap-3">
      {serviceId === null ? (
        <>
          <div>
            <Button data-agent-catalog-trigger="pathology" disabled={draftAction.isPending} onClick={() => setComposerOpen(true)} type="button">
              <PlusIcon data-icon="inline-start" />{zh ? '添加病理会诊' : 'Add pathology consultation'}
            </Button>
          </div>
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            {zh ? '在弹窗中检索病理目录，选择会诊项目、送检手术并填写会诊目的。' : 'Search the pathology catalog in the dialog, pick a consultation and procedure, and enter the purpose.'}
          </p>
        </>
      ) : (
        <Button
          aria-label={`${zh ? '编辑病理会诊' : 'Edit pathology consultation'} ${selectedService?.service.name ?? state?.draft?.service.name ?? serviceId}`}
          className="h-auto w-full min-w-0 items-start justify-start gap-2 whitespace-normal p-3 text-left"
          onClick={() => setComposerOpen(true)}
          type="button"
          variant="outline"
        >
          <span className="min-w-0 flex-1">
            <strong className="block truncate text-sm">{selectedService?.service.name ?? state?.draft?.service.name ?? serviceId}</strong>
            <span className="mt-1 block text-xs text-muted-foreground">
              {zh ? '送检手术：' : 'Source procedure: '}{selectedProcedure !== undefined ? procedureLabel(selectedProcedure) : procedureReference ?? '—'}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">{zh ? '会诊目的：' : 'Purpose: '}{purpose.trim() === '' ? '—' : purpose}</span>
          </span>
        </Button>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {state?.draft === undefined ? null : (
          <>
            <Button disabled={draftAction.isPending} onClick={() => draftAction.mutate({ kind: 'delete' })} size="sm" variant="outline">
              {zh ? '删除草稿' : 'Delete draft'}
            </Button>
            <span className="text-xs text-muted-foreground">
              {zh ? `已保存草稿：${state.draft.service.name}（${procedureLabel(state.draft.sourceProcedure)}）` : `Saved draft: ${state.draft.service.name} (${procedureLabel(state.draft.sourceProcedure)})`}
            </span>
          </>
        )}
      </div>
      {draftAction.isError ? (
        <Alert variant="destructive">
          <AlertTitle>{draftAction.variables?.kind === 'delete' ? zh ? '草稿未移除' : 'Draft was not removed' : zh ? '病理会诊申请未提交' : 'The pathology request was not submitted'}</AlertTitle>
          <AlertDescription>{getWorkspaceErrorMessage(draftAction.error, messages)}</AlertDescription>
        </Alert>
      ) : null}
      <PathologyComposerDialog
        draftPending={draftAction.isPending}
        existingServiceId={state?.draft?.service.id}
        locale={locale}
        onConfirm={({ procedureReference: nextProcedureReference, purpose: nextPurpose, serviceId: nextServiceId }) => {
          setReviewedService(reviewedInvestigationService(services.data?.items.find(item => item.service.id === nextServiceId)?.service))
          setServiceId(nextServiceId)
          setProcedureReference(nextProcedureReference)
          setPurpose(nextPurpose)
          draftAction.mutate({ kind: 'save', purpose: nextPurpose, serviceId: nextServiceId, sourceProcedureReference: nextProcedureReference })
        }}
        onOpenChange={setComposerOpen}
        open={composerOpen}
        services={services.data?.items}
        target={composerTarget}
      />
    </section>
  )

  const pending = (
    <DoctorRecommendationsPanel
      caseId={caseId}
      kind="pathology"
      inputRevision={recommendationRevision}
      locale={locale}
      scope={recommendationScope}
      enabled={active && !readOnly}
      disabled={draftAction.isPending || services.isFetching}
      encounter={encounter}
      expectedDraftVersion={draftVersion}
      resolveExistingDraft={state?.draft !== undefined}
      manualItems={serviceId === null && procedureReference === null && purpose === '' ? [] : [{ label: selectedService?.service.name ?? state?.draft?.service.name ?? serviceId ?? '',
        value: { source: 'manual', kind: 'pathology', serviceId: serviceId ?? '', sourceProcedureReference: procedureReference ?? '', purpose, ...(reviewedService?.id === serviceId ? { reviewedService } : {}) } }]}
      onManualChange={({ value }) => {
        if (value.kind !== 'pathology' || serviceId !== null && serviceId !== value.serviceId) return false
        setReviewedService(value.reviewedService)
        setServiceId(value.serviceId); setProcedureReference(value.sourceProcedureReference); setPurpose(value.purpose)
        return true
      }}
      onConfirmed={(values, result) => {
        if (result.recordIds[0] !== undefined) selectRequest(result.recordIds[0])
        if (!values.some(value => value.source === 'manual' && value.kind === 'pathology' && value.serviceId === serviceId && value.sourceProcedureReference === procedureReference && value.purpose.trim() === purpose.trim())) return
        setServiceId(null); setProcedureReference(null); setPurpose('')
      }}
      onManualRemove={value => { if (value.kind !== 'pathology' || value.serviceId !== serviceId) return; if (state?.draft !== undefined) draftAction.mutate({ kind: 'delete' }); else { setServiceId(null); setProcedureReference(null); setPurpose('') } }}
      unavailableReason={recommendationUnavailableReason}
      manualUnavailableReason={recommendationUnavailableReason}
      investigationServiceFor={value => value.kind === 'pathology' ? reviewedInvestigationService(services.data?.items.find(item => item.service.id === value.serviceId)?.service) : undefined}
      itemDetails={value => value.kind === 'pathology' ? <InvestigationPrice locale={locale} price={value.reviewedService?.outpatientBilling ?? undefined} /> : null}
    />
  )
  return (
    <section aria-labelledby={`${elementId}-heading`} className="outline-none" id={elementId} tabIndex={-1}>
      <h3 className="mb-3 text-sm font-semibold" id={`${elementId}-heading`}>{zh ? '病理会诊' : 'Pathology consultation'}</h3>
      {readOnly || selectedRequest === undefined || selectedRequest.status === 'cancelled' ? null : <DoctorRecordReviewNotice caseId={caseId}
        authoredAt={selectedRequest.authoredAt} locale={locale} onReview={() => {
          selectRequest(selectedRequest.id)
          requestAnimationFrame(() => { recordRef.current?.scrollIntoView({ block: 'nearest' }); recordRef.current?.focus() })
        }} />}
      <InvestigationRequestWorkspace
        entry={readOnly ? null : editor} pending={pending}
        locale={locale}
        onSelectRequest={selectRequest}
        requests={requests.map(request => ({
          id: request.id,
          inProgress: ['issued', 'accepted', 'in-progress'].includes(request.status),
          statusLabel: statusLabels[request.status][zh ? 0 : 1],
          title: request.service.name,
          unread: request.status === 'reported',
        }))}
        selectedRequestId={selectedRequest?.id}
      >
        {selectedRequest === undefined ? null : <div ref={recordRef} tabIndex={-1}><PathologyRequestList actions={actions} active={active} locale={locale} readOnly={readOnly} requests={[selectedRequest]} selectedReportId={selectedReportId} /></div>}
      </InvestigationRequestWorkspace>
    </section>
  )
}
