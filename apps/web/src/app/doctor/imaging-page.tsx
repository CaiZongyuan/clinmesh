import { imagingIndicationSchema } from '@clinmesh/contracts/his'
import type { ImagingReport, ImagingRequest, ImagingServiceSnapshot } from '@clinmesh/contracts/his'
import { DoctorRecordReviewNotice } from './doctor-record-review-notice.tsx'
import type { DoctorRecommendationSuggestion } from '@clinmesh/contracts/doctor-recommendations'
import { agentToolInputSchemas } from '@clinmesh/contracts/agent'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Empty, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useMutation, useQuery } from '@tanstack/react-query'
import { PlusIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  acknowledgeImagingReport,
  cancelImagingRequest,
  correctImagingReport,
  deleteImagingRequestDraft,
  getCaseImagingServices,
  getImagingStudy,
  getImagingStudyBlock,
  newIdempotencyKey,
  retryImagingRequest,
  saveImagingRequestDraft,
} from '../api-client.ts'
import { ImagingViewer, type ImagingViewerSource } from '../imaging/imaging-viewer.tsx'
import { useRegisterAgentForm } from '../agent-page-context.tsx'
import { getWorkspaceErrorMessage } from '../workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { formatClinicalDateTime } from './clinical-date-time.ts'
import { InvestigationRequestWorkspace } from './investigation-request-workspace.tsx'
import { DoctorRecommendationsPanel, type PreparationDraft } from './doctor-recommendations.tsx'
import { InvestigationBilling, InvestigationPrice, missingInvestigationPrice } from './investigation-billing.tsx'

interface ImagingRequestState {
  draft?: { indication: string; service: ImagingServiceSnapshot } | undefined
  draftVersion: number
  requests: ImagingRequest[]
}

/** 阅片状态：哪些申请的影像已展开、哪些报告的影像已成功显示过。人工点击与 Agent 导航阅片写入同一份状态。 */
export interface ImagingViewState {
  isOpen(requestId: string): boolean
  isShown(diagnosticReportId: string): boolean
  markShown(diagnosticReportId: string): void
  setOpen(requestId: string, open: boolean): void
}

/** `scope` 变化（切换病例）时阅片状态回到初始，旧病例展开的影像不会带到新病例。 */
export function useImagingViewState(scope: string): ImagingViewState {
  const [state, setState] = useState<{ open: string[]; scope: string; shown: string[] }>({ open: [], scope, shown: [] })
  return useMemo(() => {
    const scoped = (value: typeof state) => value.scope === scope ? value : { open: [], scope, shown: [] }
    const current = scoped(state)
    return {
      isOpen: requestId => current.open.includes(requestId),
      isShown: diagnosticReportId => current.shown.includes(diagnosticReportId),
      markShown: diagnosticReportId => setState((previous) => {
        const value = scoped(previous)
        return value.shown.includes(diagnosticReportId) ? value : { ...value, shown: [...value.shown, diagnosticReportId] }
      }),
      setOpen: (requestId, open) => setState((previous) => {
        const value = scoped(previous)
        const others = value.open.filter(id => id !== requestId)
        return { ...value, open: open ? [...others, requestId] : others }
      }),
    }
  }, [scope, state])
}

export type ImagingSummaryInsertion = 'duplicate' | 'inserted' | 'too-long'

export interface ImagingPageActions {
  /** 当前账号兼有管理员岗位时才能更正报告。 */
  canCorrect: boolean
  onChanged: () => Promise<unknown> | void
  /** 把报告摘要插入未签病历；病历已签或只读时不提供。 */
  onInsertSummary?: ((request: ImagingRequest, report: ImagingReport) => ImagingSummaryInsertion) | undefined
  view: ImagingViewState
}

const summaryInsertionLabels: Record<ImagingSummaryInsertion, [string, string]> = {
  duplicate: ['病历中已有这一版报告的摘要，未重复插入。', 'This report version is already in the clinical document.'],
  inserted: ['已插入病历“辅助检查”，签署病历时一并保存。', 'Inserted into the clinical document; it is saved when the document is signed.'],
  'too-long': ['病历“辅助检查”已接近长度上限，未插入。', 'The clinical document field is near its length limit; nothing was inserted.'],
}

const statusLabels: Record<ImagingRequest['status'], [string, string]> = {
  accepted: ['已受理', 'Accepted'],
  acknowledged: ['医生已阅', 'Acknowledged'],
  cancelled: ['已取消', 'Cancelled'],
  'generation-failed': ['未取得结果', 'No result'],
  'in-progress': ['检查中', 'In progress'],
  issued: ['已开具', 'Issued'],
  reported: ['已报告', 'Reported'],
}

function ReportText({ locale, report }: { locale: WorkspaceLocale; report: ImagingReport }) {
  const zh = locale === 'zh-CN'
  return (
    <dl className="mt-2 grid gap-2 text-sm">
      <div><dt className="text-xs text-muted-foreground">{zh ? '检查技术' : 'Technique'}</dt><dd>{report.technique}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{zh ? '检查所见' : 'Findings'}</dt><dd>{report.findings}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{zh ? '印象' : 'Impression'}</dt><dd>{report.impression}</dd></div>
      <div className="text-xs text-muted-foreground">
        {zh ? '签发时间 ' : 'Issued '}{formatClinicalDateTime(report.issuedAt, locale)}
        {zh ? ` · 第 ${report.revisionNumber} 版` : ` · Revision ${report.revisionNumber}`}
        {report.revisionReason === undefined ? '' : zh ? `，更正原因：${report.revisionReason}` : `: ${report.revisionReason}`}
        {report.acknowledgement === undefined ? '' : zh ? ` · 已阅 ${formatClinicalDateTime(report.acknowledgement.acknowledgedAt, locale)}` : ` · Acknowledged ${formatClinicalDateTime(report.acknowledgement.acknowledgedAt, locale)}`}
      </div>
    </dl>
  )
}

/** 管理员更正表单：只选择同一素材另一份已复核发布的报告内容修订，不接受自由改写。 */
function ImagingReportCorrection({ locale, onChanged, report, request }: {
  locale: WorkspaceLocale
  onChanged: () => Promise<unknown> | void
  report: ImagingReport
  request: ImagingRequest
}) {
  const zh = locale === 'zh-CN'
  const messages = getWorkspaceMessages(locale)
  const [reportRevision, setReportRevision] = useState('')
  const [reason, setReason] = useState('')
  const correction = useMutation({
    mutationFn: () => correctImagingReport(
      request,
      report,
      { reason: reason.trim(), reportRevision: Number(reportRevision) },
      newIdempotencyKey(),
    ),
    onSettled: () => onChanged(),
  })
  const idPrefix = `imaging-correction-${request.id}`
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-muted-foreground">{zh ? '更正报告（管理员）' : 'Correct report (administrator)'}</summary>
      <div className="mt-2 grid gap-2">
        <p className="text-xs text-muted-foreground">
          {zh
            ? '更正会按所选的报告内容修订重新签发报告，原报告与原确认保留。可选修订见“影像覆盖清单”中该素材的复核预览。'
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

/** 一条放射申请：状态、报告、影像入口，以及进行中病例的取消、重试与确认已阅。 */
function ImagingRequestItem({ actions, active, locale, readOnly, request, selectedReportId }: {
  actions: ImagingPageActions
  active: boolean
  locale: WorkspaceLocale
  readOnly: boolean
  request: ImagingRequest
  selectedReportId?: string | undefined
}) {
  const zh = locale === 'zh-CN'
  const messages = getWorkspaceMessages(locale)
  const { onChanged, onInsertSummary, view } = actions
  const [summaryInsertion, setSummaryInsertion] = useState<ImagingSummaryInsertion>()
  const viewerOpen = active && view.isOpen(request.id)
  const diagnosticReportId = request.report?.diagnosticReportId
  const studyId = request.report?.studyId
  const study = useQuery({
    enabled: viewerOpen && studyId !== undefined,
    gcTime: 0,
    queryFn: ({ signal }) => getImagingStudy(studyId!, signal),
    queryKey: ['imaging-study', studyId ?? 'none'],
  })
  // 显示过影像之后检查又报告不可读时（例如重新读取发现像素缺失），不再开放确认已阅。
  const frameShown = diagnosticReportId !== undefined && view.isShown(diagnosticReportId) && study.data?.available === true
  const source = useMemo<ImagingViewerSource | undefined>(() => study.data === undefined || studyId === undefined
    ? undefined
    : { loadBlock: (path, signal) => getImagingStudyBlock(studyId, path, signal), study: study.data },
  [study.data, studyId])
  const handleFrameShown = useCallback(() => {
    if (diagnosticReportId !== undefined) view.markShown(diagnosticReportId)
  }, [diagnosticReportId, view])
  const action = useMutation({
    mutationFn: async (kind: 'acknowledge' | 'cancel' | 'retry'): Promise<void> => {
      if (kind === 'cancel') await cancelImagingRequest(request, newIdempotencyKey())
      else if (kind === 'retry') await retryImagingRequest(request, newIdempotencyKey())
      else await acknowledgeImagingReport(request, request.report!, newIdempotencyKey())
    },
    onSettled: () => onChanged(),
  })
  return (
    <li className="border-t py-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm font-medium">{request.service.name}</strong>
        <Badge variant={request.status === 'acknowledged' ? 'success' : request.status === 'generation-failed' ? 'warning' : 'outline'}>
          {statusLabels[request.status][zh ? 0 : 1]}
        </Badge>
        <span className="text-xs text-muted-foreground">{zh ? '指征：' : 'Indication: '}{request.indication}</span>
      </div>
      <InvestigationBilling billing={request.billing} locale={locale} />
      {request.status === 'generation-failed' ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {zh ? '本次检查没有取得结果，未生成报告。可以重试，或取消该申请。' : 'This examination produced no result and no report. Retry or cancel the request.'}
        </p>
      ) : null}
      {request.report === undefined ? null : (
        <>
          <ReportText locale={locale} report={request.report} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button onClick={() => view.setOpen(request.id, !viewerOpen)} size="sm" variant="outline">
              {viewerOpen ? (zh ? '收起影像' : 'Hide images') : (zh ? '打开影像' : 'Open images')}
            </Button>
            {onInsertSummary === undefined ? null : (
              <Button onClick={() => setSummaryInsertion(onInsertSummary(request, request.report!))} size="sm" variant="outline">
                {zh ? '摘要插入病历' : 'Insert summary into record'}
              </Button>
            )}
            {readOnly || request.status !== 'reported' ? null : (
              <>
                <Button
                  disabled={!frameShown || action.isPending}
                  onClick={() => action.mutate('acknowledge')}
                  size="sm"
                >
                  {zh ? '确认已阅' : 'Acknowledge'}
                </Button>
                {frameShown ? null : (
                  <span className="text-xs text-muted-foreground">
                    {zh ? '打开影像并成功显示后才能确认已阅' : 'Open the images before acknowledging'}
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
              <AlertTitle>{zh ? '无法打开影像' : 'Unable to open the images'}</AlertTitle>
              <AlertDescription>
                <Button onClick={() => void study.refetch()} size="sm" variant="outline">{zh ? '重试' : 'Retry'}</Button>
              </AlertDescription>
            </Alert>
          ) : (
            <div className="mt-2">
              <ImagingViewer key={studyId} locale={locale} onFrameShown={handleFrameShown} source={source} />
            </div>
          )}
          {request.previousReports.length === 0 ? null : (
            <details className="mt-2" open={request.previousReports.some(report => report.diagnosticReportId === selectedReportId) ? true : undefined}>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {zh ? `历史报告 · ${request.previousReports.length}` : `Earlier reports · ${request.previousReports.length}`}
              </summary>
              {request.previousReports.map(report => <ReportText key={report.diagnosticReportId} locale={locale} report={report} />)}
            </details>
          )}
          {actions.canCorrect
            ? <ImagingReportCorrection locale={locale} onChanged={onChanged} report={request.report} request={request} />
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
    </li>
  )
}

/** 放射申请列表；已完诊病例以只读方式复用。 */
export function ImagingRequestList({ actions, active = true, locale, readOnly, requests, selectedReportId }: {
  actions: ImagingPageActions
  active?: boolean | undefined
  locale: WorkspaceLocale
  readOnly: boolean
  requests: ImagingRequest[]
  selectedReportId?: string | undefined
}) {
  if (requests.length === 0) return null
  return (
    <ul>
      {requests.map(request => (
        <ImagingRequestItem
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

interface ImagingComposerTarget {
  indication: string
  serviceId: string | null
}

/** 三页签统一弹窗合同（放射）：目录选项目与指征在同一次弹窗内完成，点「保存草稿」落单这一条并关闭；未确认关闭即弃置弹窗内输入。 */
function ImagingComposerDialog({ draftPending, existingServiceId, locale, onConfirm, onOpenChange, open, services, target }: {
  draftPending: boolean
  existingServiceId?: string | undefined
  locale: WorkspaceLocale
  onConfirm: (input: { indication: string; serviceId: string }) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  services: Array<{ available: boolean; service: ImagingServiceSnapshot }> | undefined
  target?: ImagingComposerTarget | undefined
}): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const targetRef = useRef(target)
  targetRef.current = target
  const openingRef = useRef(open)
  const [serviceId, setServiceId] = useState<string | null>(null)
  const [indication, setIndication] = useState('')
  const [conflict, setConflict] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (open && !openingRef.current) {
      setServiceId(targetRef.current?.serviceId ?? null)
      setIndication(targetRef.current?.indication ?? '')
      setConflict(false)
      setQuery('')
    }
    openingRef.current = open
  }, [open])
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const visible = (services ?? []).filter(item => terms.every(term => (
    `${item.service.name} ${item.service.code} ${item.service.bodySite} ${item.service.method}`.toLocaleLowerCase().includes(term)
  )))
  const selected = (services ?? []).find(item => item.service.id === serviceId)
  const select = (item: { available: boolean; service: ImagingServiceSnapshot }) => {
    if (existingServiceId !== undefined && item.service.id !== existingServiceId) {
      setConflict(true)
      return
    }
    setConflict(false)
    setServiceId(item.service.id)
  }
  const confirm = () => {
    if (serviceId === null || !imagingIndicationSchema.safeParse(indication).success) return
    onConfirm({ indication, serviceId })
    onOpenChange(false)
  }
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex h-[min(680px,calc(100svh-2rem))] flex-col sm:max-w-4xl" data-agent-catalog="imaging">
        <DialogHeader>
          <DialogTitle>{target?.serviceId != null ? (zh ? '编辑放射检查' : 'Edit examination') : (zh ? '选择放射检查' : 'Select an examination')}</DialogTitle>
          <DialogDescription>{zh
            ? '在目录中选择检查项目并填写检查指征，一次弹窗确认一条检查申请。'
            : 'Pick an examination and enter the indication; one dialog confirms one imaging request.'}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <Input aria-label={zh ? '搜索放射目录' : 'Search imaging catalog'} maxLength={128}
            onChange={event => setQuery(event.target.value)}
            placeholder={zh ? '名称、编号、部位或方式' : 'Name, code, body site, or method'} value={query} />
          <div className="max-h-[12.5rem] overflow-y-auto border-y">
            {visible.length === 0 ? <Empty role="status"><EmptyHeader><EmptyTitle>{zh ? '没有匹配的放射检查' : 'No matching imaging examinations'}</EmptyTitle></EmptyHeader></Empty> : (
              <ul className="divide-y">
                {visible.map(({ available, service }) => (
                  <li className="flex min-w-0 items-center justify-between gap-2 px-3 py-2" key={service.id}>
                    <Button aria-pressed={serviceId === service.id} className="h-auto min-w-0 flex-1 items-center justify-between gap-2 whitespace-normal px-1 py-2 text-left" disabled={!available || draftPending} onClick={() => select({ available, service })} type="button" variant={serviceId === service.id ? 'secondary' : 'outline'}>
                      <span className="min-w-0 truncate" title={available ? service.name : zh ? `${service.name}：本院当前未开展` : `${service.name}: not currently available`}>{available ? service.name : zh ? `${service.name}：本院当前未开展` : `${service.name}: not currently available`}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{service.bodySite} · {service.method}</span>
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
              <div><dt className="text-xs text-muted-foreground">{zh ? '检查项目' : 'Examination'}</dt><dd>{selected.service.name}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{zh ? '部位与方式' : 'Body site and method'}</dt><dd>{selected.service.bodySite} · {selected.service.method}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{zh ? '适用条件' : 'Applicability'}</dt><dd>{selected.service.applicability}</dd></div>
            </dl>
            <InvestigationPrice locale={locale} price={selected.service.outpatientBilling} />
            <Field>
              <FieldLabel htmlFor="imaging-composer-indication">{zh ? '检查指征' : 'Indication'}</FieldLabel>
              <Textarea disabled={draftPending} id="imaging-composer-indication" maxLength={500} onChange={event => setIndication(event.target.value)} value={indication} />
            </Field>
          </div>
        )}
        {conflict ? <p className="text-sm text-destructive" role="alert">{zh ? '已有保存的放射申请草稿，请先开具或删除后再更换检查项目。' : 'Issue or delete the saved imaging draft before choosing another examination.'}</p> : null}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>{zh ? '取消' : 'Cancel'}</DialogClose>
          <Button disabled={serviceId === null || !imagingIndicationSchema.safeParse(indication).success || draftPending} onClick={confirm} type="button">
            {zh ? '保存草稿' : 'Save draft'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 放射目录与申请管理复用同一表单；报告与阅片只展示当前选中的正式申请。 */
export function ImagingPage({
  actions, active = true, caseId, elementId, encounter, locale, readOnly, recommendationRevision, recommendationScope,
  state, selectedRequestId, onSelectRequest, selectedReportId,
}: {
  actions: ImagingPageActions
  active?: boolean | undefined
  editDraft?: boolean | undefined
  caseId: string
  elementId: string
  encounter: { id: string; versionId: string }
  locale: WorkspaceLocale
  readOnly: boolean
  recommendationRevision?: string | undefined
  recommendationScope?: string | undefined
  state: ImagingRequestState | undefined
  selectedRequestId?: string | undefined
  onSelectRequest?: ((id: string) => void) | undefined
  selectedReportId?: string | undefined
}) {
  const { onChanged } = actions
  const zh = locale === 'zh-CN'
  const messages = getWorkspaceMessages(locale)
  const [serviceId, setServiceId] = useState<string | null>(state?.draft?.service.id ?? null)
  const [indication, setIndication] = useState(state?.draft?.indication ?? '')
  const [composerOpen, setComposerOpen] = useState(false)
  const [localSelectedRequestId, setLocalSelectedRequestId] = useState<string>()
  const selectRequest = (id: string): void => {
    setLocalSelectedRequestId(id)
    onSelectRequest?.(id)
  }
  const selectedRequest = state?.requests.find(request => request.id === (selectedRequestId ?? localSelectedRequestId)) ?? state?.requests[0]
  const recordRef = useRef<HTMLDivElement>(null)
  const services = useQuery({
    enabled: !readOnly,
    queryFn: ({ signal }) => getCaseImagingServices(caseId, signal),
    queryKey: ['doctor-case-imaging-services', caseId],
  })
  const draftVersion = state?.draftVersion ?? 0
  const encounterVersion = { encounterId: encounter.id, encounterVersion: encounter.versionId }
  const draftAction = useMutation({
    // 保存值随确认一次性传入：弹窗内点「保存草稿」时页面状态尚未提交。
    mutationFn: async (action: { kind: 'delete' } | { indication: string; kind: 'save'; serviceId: string }): Promise<void> => {
      if (action.kind === 'delete') {
        await deleteImagingRequestDraft({ ...encounterVersion, expectedDraftVersion: draftVersion }, newIdempotencyKey())
        return
      }
      await saveImagingRequestDraft({
        ...encounterVersion, expectedDraftVersion: draftVersion, indication: action.indication, serviceId: action.serviceId,
      }, newIdempotencyKey())
    },
    onSettled: () => onChanged(),
    onSuccess: (_result, action) => { if (action.kind === 'delete') { setServiceId(null); setIndication('') } },
  })
  const draftInput = agentToolInputSchemas['outpatient.imaging.draft.set'].safeParse({ serviceId, indication: indication.trim() })
  useRegisterAgentForm({
    name: 'imaging', selectionId: caseId, viewId: 'consultation',
    values: readOnly || !draftInput.success ? null : draftInput.data,
  })
  const selectedService = services.data?.items.find(item => item.service.id === serviceId)
  const recommendationUnavailableReason = (suggestion: DoctorRecommendationSuggestion | PreparationDraft): string | undefined => {
    if (suggestion.kind !== 'imaging' || draftAction.isPending || services.isFetching
      || !services.data?.items.some(item => item.available && item.service.id === suggestion.serviceId)
      || !agentToolInputSchemas['outpatient.imaging.draft.set'].safeParse({
        serviceId: suggestion.serviceId, indication: suggestion.indication,
      }).success) return messages.recommendationRequestTargetUnavailable
    return services.data?.items.find(item => item.service.id === suggestion.serviceId)?.service.outpatientBilling === undefined ? missingInvestigationPrice(locale) : undefined
  }
  // 三页签统一结构（放射）：左主列为入口与草稿卡片，目录检索与指征在同一次弹窗内完成。
  const composerTarget = useMemo<ImagingComposerTarget>(() => ({ indication, serviceId }), [indication, serviceId])
  const editor = readOnly ? null : services.isPending ? <Skeleton className="mt-3 h-24 w-full" /> : services.isError ? (
    <Alert className="mt-3" variant="destructive">
      <AlertTitle>{zh ? '无法加载放射服务' : 'Unable to load imaging services'}</AlertTitle>
      <AlertDescription>
        <Button onClick={() => void services.refetch()} size="sm" variant="outline">{zh ? '重试' : 'Retry'}</Button>
      </AlertDescription>
    </Alert>
  ) : (
    <section aria-label={zh ? '开具放射申请' : 'Prepare imaging request'} className="flex min-w-0 flex-col gap-3">
      {serviceId === null ? (
        <>
          <div>
            <Button data-agent-catalog-trigger="imaging" disabled={draftAction.isPending} onClick={() => setComposerOpen(true)} type="button">
              <PlusIcon data-icon="inline-start" />{zh ? '添加放射检查' : 'Add examination'}
            </Button>
          </div>
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            {zh ? '在弹窗中检索放射目录，选择检查项目并填写指征。' : 'Search the imaging catalog in the dialog, pick an examination and enter the indication.'}
          </p>
        </>
      ) : (
        <Button
          aria-label={`${zh ? '编辑放射申请' : 'Edit imaging request'} ${selectedService?.service.name ?? state?.draft?.service.name ?? serviceId}`}
          className="h-auto w-full min-w-0 items-start justify-start gap-2 whitespace-normal p-3 text-left"
          onClick={() => setComposerOpen(true)}
          type="button"
          variant="outline"
        >
          <span className="min-w-0 flex-1">
            <strong className="block truncate text-sm">{selectedService?.service.name ?? state?.draft?.service.name ?? serviceId}</strong>
            {selectedService === undefined ? null : (
              <span className="mt-1 block text-xs text-muted-foreground">{selectedService.service.bodySite} · {selectedService.service.method}</span>
            )}
            <span className="mt-1 block text-xs text-muted-foreground">{zh ? '指征：' : 'Indication: '}{indication.trim() === '' ? '—' : indication}</span>
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
              {zh ? `已保存草稿：${state.draft.service.name}` : `Saved draft: ${state.draft.service.name}`}
            </span>
          </>
        )}
      </div>
      {draftAction.isError ? (
        <Alert variant="destructive">
          <AlertTitle>{draftAction.variables?.kind === 'delete' ? zh ? '草稿未移除' : 'Draft was not removed' : zh ? '放射申请未提交' : 'The imaging request was not submitted'}</AlertTitle>
          <AlertDescription>{getWorkspaceErrorMessage(draftAction.error, messages)}</AlertDescription>
        </Alert>
      ) : null}
      <ImagingComposerDialog
        draftPending={draftAction.isPending}
        existingServiceId={state?.draft?.service.id}
        locale={locale}
        onConfirm={({ indication: nextIndication, serviceId: nextServiceId }) => {
          setServiceId(nextServiceId)
          setIndication(nextIndication)
          draftAction.mutate({ indication: nextIndication, kind: 'save', serviceId: nextServiceId })
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
      kind="imaging"
      inputRevision={recommendationRevision}
      locale={locale}
      scope={recommendationScope}
      enabled={active && !readOnly}
      disabled={draftAction.isPending || services.isFetching}
      encounter={encounter}
      expectedDraftVersion={draftVersion}
      resolveExistingDraft={state?.draft !== undefined}
      manualItems={serviceId === null && indication === '' ? [] : [{ label: selectedService?.service.name ?? state?.draft?.service.name ?? serviceId ?? '',
        value: { source: 'manual', kind: 'imaging', serviceId: serviceId ?? '', indication } }]}
      onManualChange={({ value }) => {
        if (value.kind !== 'imaging' || serviceId !== null && serviceId !== value.serviceId) return false
        setServiceId(value.serviceId); setIndication(value.indication)
        return true
      }}
      onConfirmed={(values, result) => {
        if (result.recordIds[0] !== undefined) selectRequest(result.recordIds[0])
        if (!values.some(value => value.source === 'manual' && value.kind === 'imaging' && value.serviceId === serviceId && value.indication.trim() === indication.trim())) return
        setServiceId(null); setIndication('')
      }}
      onManualRemove={value => { if (value.kind !== 'imaging' || value.serviceId !== serviceId) return; if (state?.draft !== undefined) draftAction.mutate({ kind: 'delete' }); else { setServiceId(null); setIndication('') } }}
      unavailableReason={recommendationUnavailableReason}
      manualUnavailableReason={recommendationUnavailableReason}
      itemDetails={value => value.kind === 'imaging' ? <InvestigationPrice locale={locale} price={services.data?.items.find(item => item.service.id === value.serviceId)?.service.outpatientBilling} /> : null}
    />
  )
  return (
    <section aria-labelledby={`${elementId}-heading`} className="flex min-w-0 flex-col gap-3 outline-none" id={elementId} tabIndex={-1}>
      <h3 className="text-sm font-semibold" id={`${elementId}-heading`}>{zh ? '放射检查' : 'Imaging'}</h3>
      {readOnly || selectedRequest === undefined || selectedRequest.status === 'cancelled' ? null : <DoctorRecordReviewNotice caseId={caseId}
        authoredAt={selectedRequest.authoredAt} locale={locale} onReview={() => {
          selectRequest(selectedRequest.id)
          requestAnimationFrame(() => { recordRef.current?.scrollIntoView({ block: 'nearest' }); recordRef.current?.focus() })
        }} />}
      <InvestigationRequestWorkspace
        entry={readOnly ? null : editor} pending={pending}
        locale={locale}
        onSelectRequest={selectRequest}
        requests={(state?.requests ?? []).map(request => ({
          id: request.id,
          title: request.service.name,
          statusLabel: statusLabels[request.status][zh ? 0 : 1],
          unread: request.status === 'reported',
          inProgress: request.status === 'issued' || request.status === 'accepted' || request.status === 'in-progress',
        }))}
        selectedRequestId={selectedRequest?.id}
      >
        {selectedRequest === undefined ? null : <div aria-label={zh ? '放射申请详情' : 'Imaging request details'} role="region" ref={recordRef} tabIndex={-1}>
          <ImagingRequestList actions={actions} active={active} locale={locale} readOnly={readOnly} requests={[selectedRequest]} selectedReportId={selectedReportId} />
        </div>}
      </InvestigationRequestWorkspace>
    </section>
  )
}
