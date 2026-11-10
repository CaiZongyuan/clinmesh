import { OrderComposerLayout, OrderComposerFooter, OrderComposerSearch, OrderCatalogCandidate } from './order-composer-layout.tsx'
import type { DoctorRecommendationSuggestion } from '@clinmesh/contracts/doctor-recommendations'
import type { PathologyReport, PathologyRequest, PathologyServiceSnapshot } from '@clinmesh/contracts/his'
import { pathologyPurposeSchema, savePathologyRequestDraftRequestSchema } from '@clinmesh/contracts/his'
import type { PathologySourceProcedure } from '@clinmesh/contracts/pathology'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@clinmesh/ui/components/alert-dialog'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Spinner } from '@clinmesh/ui/components/spinner'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
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
  correctPathologyReport,
  deletePathologyRequestDraft,
  getCasePathologyServices,
  getImagingStudy,
  getImagingStudyBlock,
  newIdempotencyKey,
} from '../api-client.ts'
import { ImagingViewer, type ImagingViewerSource } from '../imaging/imaging-viewer.tsx'
import { getWorkspaceErrorMessage } from '../workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { WorkspaceSelect } from '../workspace-select.tsx'
import { formatClinicalDateTime } from './clinical-date-time.ts'
import { DoctorDraftEditorScope, DoctorDraftField as Field, useDoctorDraftFieldEdit, useDoctorDraftItemEdit } from './doctor-draft-fields.tsx'
import { DoctorRecommendationsPanel, type PreparationDraft } from './doctor-recommendations.tsx'
import { DoctorRecordReviewNotice } from './doctor-record-review-notice.tsx'
import type { ImagingSummaryInsertion, ImagingViewState } from './imaging-page.tsx'
import { InvestigationBilling, InvestigationPrice, missingInvestigationPrice, reviewedInvestigationService } from './investigation-billing.tsx'
import { InvestigationServiceDetails } from './investigation-service-details.tsx'
import { InvestigationRequestWorkspace } from './investigation-request-workspace.tsx'
import { useInvestigationPreferences, useManualInvestigationDrafts } from './investigation-draft-storage.ts'
import { OutpatientInvestigationActions } from './outpatient-investigation-actions.tsx'
import type { OutpatientInvestigationActionContext } from './outpatient-investigation-action-store.ts'

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

export function ReportText({ locale, report }: { locale: WorkspaceLocale; report: PathologyReport }) {
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
function PathologyRequestItem({ actions, active, locale, readOnly: _readOnly, request, selectedReportId }: {
  actions: PathologyPageActions
  active: boolean
  locale: WorkspaceLocale
  readOnly: boolean
  request: PathologyRequest
  selectedReportId?: string | undefined
}) {
  const zh = locale === 'zh-CN'
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
  const source = useMemo<ImagingViewerSource | undefined>(() => study.data === undefined || studyId === undefined
    ? undefined
    : { loadBlock: (path, signal) => getImagingStudyBlock(studyId, path, signal), study: study.data },
  [study.data, studyId])
  const handleSlideShown = useCallback(() => {
    if (diagnosticReportId !== undefined) view.markShown(diagnosticReportId)
  }, [diagnosticReportId, view])
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

/** 同一弹窗连续加入；每项送检手术与目的独立，加入成功后清除当前输入。 */
function PathologyComposerDialog({ addedItems, draftPending, locale, notice, onConfirm, onOpenChange, open, services }: {
  addedItems: string[]
  draftPending: boolean
  locale: WorkspaceLocale
  notice: string
  onConfirm: (target: { purpose: string; procedureReference: string; serviceId: string }) => boolean
  onOpenChange: (open: boolean) => void
  open: boolean
  services: Array<{ available: boolean; service: PathologyServiceSnapshot; sourceProcedures: PathologySourceProcedure[] }> | undefined
}): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const markEdited = useDoctorDraftFieldEdit()
  const openingRef = useRef(open)
  const [serviceId, setServiceId] = useState<string | null>(null)
  const [procedureReference, setProcedureReference] = useState<string | null>(null)
  const [purpose, setPurpose] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (open && !openingRef.current) {
      setServiceId(null)
      setProcedureReference(null)
      setPurpose('')
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
    if (item.service.id !== serviceId) setPurpose('')
    setServiceId(item.service.id)
    setProcedureReference(item.sourceProcedures[0]?.sourceReference ?? null)
  }
  const confirm = () => {
    if (serviceId === null || procedureReference === null || !pathologyPurposeSchema.safeParse(purpose).success) return
    if (onConfirm({ purpose, procedureReference, serviceId })) {
      setServiceId(null); setProcedureReference(null); setPurpose('')
    }
  }
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex h-[min(720px,calc(100svh-2.5rem))] flex-col sm:max-w-4xl" data-agent-catalog="pathology">
        <DialogHeader>
          <DialogTitle>{zh ? '选择病理会诊' : 'Select a pathology consultation'}</DialogTitle>
          <DialogDescription>{zh
            ? '连续选择会诊项目，每项独立选择送检手术并填写目的；在待开清单集中开立，最多 8 项。'
            : 'Add consultations with individual source procedures and purposes; issue up to eight together from the pending list.'}</DialogDescription>
        </DialogHeader>
        <OrderComposerLayout locale={locale} catalog={<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <OrderComposerSearch><Input aria-label={zh ? '搜索病理目录' : 'Search pathology catalog'} maxLength={128}
            onChange={event => setQuery(event.target.value)}
            placeholder={zh ? '名称、编号或标本类型' : 'Name, code, or specimen type'} value={query} /></OrderComposerSearch>
          <div className="min-h-0 flex-1 overflow-y-auto border-y p-1">
            {visible.length === 0 ? <p className="p-4 text-sm text-muted-foreground" role="status">{zh ? '没有匹配的病理会诊项目。' : 'No matching pathology consultations.'}</p> : (
              <ul className="flex flex-col gap-0.5">
                {visible.map(item => (
                  <li key={item.service.id}>
                    <OrderCatalogCandidate selected={serviceId === item.service.id}
                      disabled={!item.available || item.sourceProcedures.length === 0 || draftPending}
                      onSelect={() => select(item)}
                    >
                      <span className="min-w-0">
                        <strong className="block truncate">{item.service.name}</strong>
                        <span className="block truncate text-xs text-muted-foreground">{item.service.code} · {item.service.specimenType}</span>
                        {item.available ? null : <span className="block text-xs text-muted-foreground">{zh ? '本院当前未开展' : 'Not currently available'}</span>}
                        {item.sourceProcedures.length === 0 ? <span className="block truncate text-xs text-muted-foreground">{zh ? '无可送检的既往手术' : 'No eligible procedure in the history'}</span> : null}
                      </span>
                      {item.service.outpatientBilling === undefined ? null : <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground tabular-nums">¥{(item.service.outpatientBilling.priceFen / 100).toFixed(2)}</span>}
                    </OrderCatalogCandidate>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>}>
        {selected === undefined ? null : (
          <div className="flex min-w-0 flex-col gap-3 border-t pt-3">
            <InvestigationServiceDetails code={selected.service.code} locale={locale} name={selected.service.name} price={selected.service.outpatientBilling}
              facts={[
                { label: zh ? '标本类型' : 'Specimen type', value: selected.service.specimenType },
                { label: zh ? '适用条件' : 'Applicability', value: selected.service.applicability },
              ]} />
            <Field>
              <FieldLabel htmlFor="pathology-composer-procedure">{zh ? '送检的既往手术' : 'Source procedure'}</FieldLabel>
              {selected.sourceProcedures.length === 0 ? (
                <FieldDescription>{zh ? '该患者的既往病史中没有可送检的乳腺手术。' : 'The history has no breast procedure to consult on.'}</FieldDescription>
              ) : (
                <WorkspaceSelect
                  id="pathology-composer-procedure"
                  items={selected.sourceProcedures.map(procedure => ({ label: procedureLabel(procedure), value: procedure.sourceReference }))}
                  onValueChange={value => {
                    if (value !== procedureReference) markEdited('pathology-composer-procedure')
                    setProcedureReference(value)
                  }}
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
        </OrderComposerLayout>
        <p className="text-sm" role="status">{zh ? `已加入 ${addedItems.length} 项：${addedItems.join('、') || '暂无'}` : `Added ${addedItems.length}: ${addedItems.join(', ') || 'None'}`}</p>
        {notice === '' ? null : <p className="text-sm text-destructive" role="alert">{notice}</p>}
        <OrderComposerFooter hint={draftPending ? (zh ? '正在保存，请稍候' : 'Saving, please wait') : selected === undefined ? (zh ? '请先从左侧选择项目' : 'Choose an item first')
          : procedureReference === null || !pathologyPurposeSchema.safeParse(purpose).success
            ? `${zh ? '还差：' : 'Complete: '}${[procedureReference === null ? (zh ? '送检的既往手术' : 'source procedure') : undefined, !pathologyPurposeSchema.safeParse(purpose).success ? (zh ? '会诊目的' : 'consultation purpose') : undefined].filter(Boolean).join(zh ? '、' : ', ')}`
            : (zh ? '核对右侧信息后加入' : 'Review the fields before adding')}>
          <DialogClose render={<Button type="button" variant="outline" />}>{zh ? '关闭' : 'Close'}</DialogClose>
          <Button data-busy={draftPending || undefined} data-unavailable={serviceId === null || procedureReference === null || !pathologyPurposeSchema.safeParse(purpose).success || draftPending ? '' : undefined} disabled={serviceId === null || procedureReference === null || !pathologyPurposeSchema.safeParse(purpose).success || draftPending} onClick={confirm} type="button">
            {draftPending ? <Spinner aria-hidden="true" data-icon="inline-start" /> : null}{draftPending ? (zh ? '正在保存' : 'Saving') : (zh ? '加入病理会诊' : 'Add pathology consultation')}
          </Button>
        </OrderComposerFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 医生工作台的病理会诊：选择本院会诊服务、从患者可见既往病史中选择送检对应的手术并填写会诊目的，
 * 手工与自动项目共用待开具清单；目录与申请信息同屏填写，正式申请与剩余待开具项目分组管理。
 */
export function PathologyPage({ actions, active = true, actionContext, caseId, elementId, encounter, locale, onSelectRequest, readOnly, recommendationRevision, recommendationScope, selectedReportId, selectedRequestId, state }: {
  actions: PathologyPageActions
  actionContext?: OutpatientInvestigationActionContext | undefined
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
  const dismissDraftItem = useDoctorDraftItemEdit()
  const zh = locale === 'zh-CN'
  const messages = getWorkspaceMessages(locale)
  const draftScope = JSON.stringify([recommendationScope, caseId, encounter.id, 'pathology'])
  const manualDrafts = useManualInvestigationDrafts(draftScope, 'pathology')
  const draftPreferences = useInvestigationPreferences(draftScope)
  const [composerOpen, setComposerOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [discardOpen, setDiscardOpen] = useState(false)
  const [localSelectedRequestId, setLocalSelectedRequestId] = useState<string>()
  const selectRequest = (id: string): void => {
    setLocalSelectedRequestId(id)
    onSelectRequest?.(id)
  }
  const selectedRequest = state?.requests.find(request => request.id === (selectedRequestId ?? localSelectedRequestId)) ?? state?.requests[0]
  const recordRef = useRef<HTMLDivElement>(null)
  const services = useQuery({
    enabled: !readOnly,
    queryFn: ({ signal }) => getCasePathologyServices(caseId, signal),
    queryKey: ['doctor-case-pathology-services', caseId],
  })
  const draftVersion = state?.draftVersion ?? 0
  const legacyVersion = state?.draft === undefined ? undefined : String(draftVersion) + ':' + state.draft.service.id
  useEffect(() => {
    if (readOnly || manualDrafts.failed || legacyVersion === undefined || manualDrafts.legacyVersion === legacyVersion || state?.draft === undefined) return
    const draft = state.draft
    if (!draftPreferences.save(previous => ({ ...previous,
      edits: Object.fromEntries(Object.entries(previous.edits).filter(([key]) => key !== JSON.stringify(['pathology', draft.service.id]))) }))) return
    manualDrafts.save(previous => [...previous.filter(row => row.value.kind !== 'pathology' || row.value.serviceId !== draft.service.id),
      { label: draft.service.name, value: { source: 'manual', kind: 'pathology', serviceId: draft.service.id,
        sourceProcedureReference: draft.sourceProcedure.sourceReference, purpose: draft.purpose, reviewedService: reviewedInvestigationService(draft.service)! } }], legacyVersion)
  })
  const removeLocal = (target: string) => manualDrafts.save(rows => target === 'all' ? [] : rows.filter(row => row.value.kind !== 'pathology' || row.value.serviceId !== target))
  const draftAction = useMutation({
    mutationFn: async (target: string): Promise<void> => {
      await deletePathologyRequestDraft({ encounterId: encounter.id, encounterVersion: encounter.versionId, expectedDraftVersion: draftVersion }, newIdempotencyKey())
      if (removeLocal(target)) setDiscardOpen(false)
    },
    onSettled: () => onChanged(),
  })
  const discard = (target: string) => {
    if (state?.draft !== undefined && (target === 'all' || state.draft.service.id === target)) draftAction.mutate(target)
    else if (removeLocal(target)) setDiscardOpen(false)
  }
  const lastDraft = manualDrafts.rows.at(-1)?.value
  const draftInput = savePathologyRequestDraftRequestSchema.shape.input.safeParse(lastDraft?.kind === 'pathology'
    ? { expectedDraftVersion: draftVersion, serviceId: lastDraft.serviceId, sourceProcedureReference: lastDraft.sourceProcedureReference, purpose: lastDraft.purpose } : null)
  useRegisterAgentForm({
    name: 'pathology', selectionId: caseId, viewId: 'consultation',
    values: readOnly || !draftInput.success ? null : draftInput.data,
  })
  const recommendationUnavailableReason = (suggestion: DoctorRecommendationSuggestion | PreparationDraft): string | undefined => {
    if (suggestion.kind !== 'pathology' || draftAction.isPending || services.isFetching) return messages.recommendationRequestTargetUnavailable
    const target = services.data?.items.find(item => item.service.id === suggestion.serviceId)
    if (target?.available !== true || !target.sourceProcedures.some(procedure => procedure.sourceReference === suggestion.sourceProcedureReference)
      || !savePathologyRequestDraftRequestSchema.shape.input.safeParse({
        expectedDraftVersion: draftVersion, serviceId: suggestion.serviceId,
        sourceProcedureReference: suggestion.sourceProcedureReference, purpose: suggestion.purpose,
      }).success) return messages.recommendationRequestTargetUnavailable
    return target.service.outpatientBilling === undefined ? missingInvestigationPrice(locale) : undefined
  }
  const addButton = (
    <Button data-agent-catalog-trigger="pathology" disabled={draftAction.isPending || manualDrafts.failed} onClick={() => setComposerOpen(true)} size="sm" type="button" variant="outline">
      <PlusIcon data-icon="inline-start" />{zh ? '添加病理会诊' : 'Add pathology consultation'}
    </Button>
  )
  const editor = readOnly ? null : services.isPending ? <Skeleton className="mt-3 h-24 w-full" /> : services.isError ? (
    <Alert className="mt-3" variant="destructive">
      <AlertTitle>{zh ? '无法加载病理会诊服务' : 'Unable to load pathology services'}</AlertTitle>
      <AlertDescription>
        <Button onClick={() => void services.refetch()} size="sm" variant="outline">{zh ? '重试' : 'Retry'}</Button>
      </AlertDescription>
    </Alert>
  ) : (
    <section aria-label={zh ? '开具病理会诊' : 'Prepare pathology request'} className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">{zh ? '同类待开项目最多 8 项，关闭、切患者和刷新后保留。' : 'Keep up to eight consultations after closing, switching patients or reloading.'}</p>
        <AlertDialog pending={draftAction.isPending} open={discardOpen} onOpenChange={setDiscardOpen}><AlertDialogTrigger render={<Button size="sm" type="button" variant="outline" disabled={draftAction.isPending} />}>
          {zh ? '清空待开清单' : 'Discard pending consultations'}
        </AlertDialogTrigger><AlertDialogContent><AlertDialogHeader>
          <AlertDialogTitle>{zh ? '丢弃全部手动待开病理会诊？' : 'Discard all manual pending consultations?'}</AlertDialogTitle>
          <AlertDialogDescription>{zh ? '将删除这些未提交输入，已经开立的申请不受影响。' : 'Discard the unsubmitted inputs. Issued requests remain.'}</AlertDialogDescription>
        </AlertDialogHeader>{draftAction.isError ? <p role="alert">{getWorkspaceErrorMessage(draftAction.error, messages)}</p> : null}
        <AlertDialogFooter><AlertDialogCancel>{messages.cancel}</AlertDialogCancel><AlertDialogAction disabled={draftAction.isPending} onClick={() => discard('all')}>{zh ? '确认清空' : 'Confirm discard'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
      </div>
      {manualDrafts.failed ? <Alert variant="destructive"><AlertTitle>{messages.operationFailed}</AlertTitle><AlertDescription>{zh ? '待开清单无法保存或读取，已停止开立；请确认清空后再试。' : 'Pending storage is unavailable. Confirm discarding before continuing.'}</AlertDescription></Alert> : null}
      {notice === '' ? null : <p role="alert">{notice}</p>}
      {draftAction.isError ? <Alert variant="destructive"><AlertTitle>{zh ? '草稿未移除' : 'Draft was not removed'}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(draftAction.error, messages)}</AlertDescription></Alert> : null}
      <DoctorDraftEditorScope id={undefined} open={composerOpen}>{commit => <PathologyComposerDialog
        addedItems={manualDrafts.rows.map(row => row.label)}
        draftPending={draftAction.isPending || manualDrafts.failed}
        locale={locale}
        notice={manualDrafts.failed ? (zh ? '待开清单无法保存，请保留输入并恢复浏览器存储后再试。' : 'Pending inputs could not be saved. Keep the input and restore browser storage.') : notice}
        onConfirm={({ purpose, procedureReference, serviceId }) => {
          if (manualDrafts.rows.length >= 8 && !manualDrafts.rows.some(row => row.value.kind === 'pathology' && row.value.serviceId === serviceId)) {
            setNotice(zh ? '最多保留 8 项，请先开立或移除项目。' : 'Keep at most eight consultations; issue or remove one first.'); return false
          }
          const service = services.data?.items.find(item => item.available && item.service.id === serviceId)?.service
          if (service === undefined) return false
          const saved = manualDrafts.save(previous => [...previous.filter(row => row.value.kind !== 'pathology' || row.value.serviceId !== serviceId),
            { label: service.name, value: { source: 'manual', kind: 'pathology', serviceId, purpose, sourceProcedureReference: procedureReference, reviewedService: reviewedInvestigationService(service)! } }])
          if (saved) { commit(); dismissDraftItem(serviceId); setNotice('') }
          return saved
        }}
        onOpenChange={setComposerOpen}
        open={composerOpen}
        services={services.data?.items}
      />}</DoctorDraftEditorScope>
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
      disabled={manualDrafts.failed || draftAction.isPending || services.isFetching}
      encounter={encounter}
      expectedDraftVersion={draftVersion}
      resolveExistingDraft={state?.draft !== undefined}
      manualControls={readOnly || services.isPending || services.isError ? null : addButton}
      manualItems={manualDrafts.rows}
      onManualChange={item => {
        if (item.value.kind !== 'pathology' || item.value.source !== 'manual') return false
        const id = item.value.serviceId
        return manualDrafts.save(previous => [...previous.filter(row => row.value.kind !== 'pathology' || row.value.serviceId !== id), item])
      }}
      onConfirmed={(values, result) => {
        if (result.recordIds[0] !== undefined) selectRequest(result.recordIds[0])
        return manualDrafts.save(previous => previous.filter(row => !values.some(value => value.source === 'manual' && value.kind === 'pathology'
          && row.value.kind === 'pathology' && row.value.serviceId === value.serviceId
          && row.value.sourceProcedureReference === value.sourceProcedureReference && row.value.purpose.trim() === value.purpose.trim()
          && (row.value.reviewedService === undefined || row.value.reviewedService.version === value.reviewedService?.version
            && row.value.reviewedService.outpatientBilling?.version === value.reviewedService.outpatientBilling?.version))))
      }}
      onManualRemove={value => { if (value.kind === 'pathology') discard(value.serviceId) }}
      unavailableReason={recommendationUnavailableReason}
      manualUnavailableReason={recommendationUnavailableReason}
      investigationServiceFor={value => value.kind === 'pathology' ? reviewedInvestigationService(services.data?.items.find(item => item.service.id === value.serviceId)?.service) : undefined}
      pathologySourcesFor={value => value.kind === 'pathology' ? services.data?.items.find(item => item.service.id === value.serviceId)?.sourceProcedures ?? [] : []}
      itemDetails={value => {
        if (value.kind !== 'pathology') return null
        const procedure = services.data?.items.find(item => item.service.id === value.serviceId)?.sourceProcedures.find(procedure => procedure.sourceReference === value.sourceProcedureReference)
        return <><p className="text-xs text-muted-foreground">{zh ? '送检手术：' : 'Source procedure: '}{procedure === undefined ? value.sourceProcedureReference : procedureLabel(procedure)}</p><InvestigationPrice locale={locale} presentation="inline" price={value.reviewedService?.outpatientBilling ?? undefined} /></>
      }}
    />
  )
  return (
    <section aria-labelledby={`${elementId}-heading`} className="outline-none" id={elementId} tabIndex={-1}>
      <h3 className="sr-only" id={`${elementId}-heading`}>{zh ? '病理会诊' : 'Pathology consultation'}</h3>
      {readOnly || selectedRequest === undefined || selectedRequest.status === 'cancelled' ? null : <DoctorRecordReviewNotice caseId={caseId}
        authoredAt={selectedRequest.authoredAt} locale={locale} onReview={() => {
          selectRequest(selectedRequest.id)
          requestAnimationFrame(() => { recordRef.current?.scrollIntoView({ block: 'nearest' }); recordRef.current?.focus() })
        }} />}
      <InvestigationRequestWorkspace
        actionRecords={actionContext === undefined ? undefined : <OutpatientInvestigationActions locale={locale} context={actionContext} kind="pathology" records={requests.map(request => ({ request, title: request.service.name, statusLabel: statusLabels[request.status][zh ? 0 : 1] }))} onSelectRequest={selectRequest} selectedRequestId={selectedRequest?.id} readOnly={readOnly} />}
        entry={readOnly ? null : editor} pending={pending}
        locale={locale}
        onSelectRequest={selectRequest}
        requests={(state?.requests ?? []).map(request => ({
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
