import { OrderComposerLayout, OrderComposerFooter, OrderComposerSearch, OrderCatalogCandidate } from './order-composer-layout.tsx'
import { agentToolInputSchemas } from '@clinmesh/contracts/agent'
import type { DoctorRecommendationSuggestion } from '@clinmesh/contracts/doctor-recommendations'
import type { ImagingReport, ImagingRequest, ImagingServiceSnapshot } from '@clinmesh/contracts/his'
import { imagingIndicationSchema } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@clinmesh/ui/components/alert-dialog'
import { Spinner } from '@clinmesh/ui/components/spinner'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Empty, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useMutation, useQuery } from '@tanstack/react-query'
import { PlusIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRegisterAgentForm } from '../agent-page-context.tsx'
import { AgentReviewAnchor } from '../agent-review.tsx'
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
} from '../api-client.ts'
import { ImagingViewer, type ImagingViewerSource } from '../imaging/imaging-viewer.tsx'
import { getWorkspaceErrorMessage } from '../workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { DoctorDraftEditorScope, DoctorDraftField as Field, useDoctorDraftItemEdit } from './doctor-draft-fields.tsx'
import { DoctorRecommendationsPanel, type PreparationDraft } from './doctor-recommendations.tsx'
import { DoctorRecordReviewNotice } from './doctor-record-review-notice.tsx'
import { InvestigationBilling, InvestigationPrice, missingInvestigationPrice, reviewedInvestigationService } from './investigation-billing.tsx'
import { InvestigationServiceDetails, ReportText } from './investigation-service-details.tsx'
import { InvestigationRequestWorkspace } from './investigation-request-workspace.tsx'
import { useInvestigationPreferences, useManualInvestigationDrafts } from './investigation-draft-storage.ts'

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
    <li className="border-t py-3"><AgentReviewAnchor id={`doctor-investigation:${request.id}`}>
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
    </AgentReviewAnchor></li>
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

/** 目录内逐项核对指征并连续加入；正式开立只在同次就诊待开清单中确认。 */
function ImagingComposerDialog({ addedItems, draftPending, locale, notice, onConfirm, onOpenChange, open, services }: {
  addedItems: string[]
  draftPending: boolean
  locale: WorkspaceLocale
  notice: string
  onConfirm: (input: { indication: string; serviceId: string }) => boolean
  onOpenChange: (open: boolean) => void
  open: boolean
  services: Array<{ available: boolean; service: ImagingServiceSnapshot }> | undefined
}): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const openingRef = useRef(open)
  const [serviceId, setServiceId] = useState<string | null>(null)
  const [indication, setIndication] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (open && !openingRef.current) {
      setServiceId(null)
      setIndication('')
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
    setServiceId(item.service.id)
    setIndication('')
  }
  const confirm = () => {
    if (serviceId === null || !imagingIndicationSchema.safeParse(indication).success) return
    if (onConfirm({ indication: indication.trim(), serviceId })) { setServiceId(null); setIndication('') }
  }
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex h-[min(720px,calc(100svh-2.5rem))] flex-col sm:max-w-4xl" data-agent-catalog="imaging">
        <DialogHeader>
          <DialogTitle>{zh ? '选择放射检查' : 'Select an examination'}</DialogTitle>
          <DialogDescription>{zh
            ? '连续选择检查并分别填写指征，加入后可继续添加；在待开清单集中开立，最多 8 项。'
            : 'Add examinations with their own indications, then issue them together from the pending list. Keep up to eight.'}</DialogDescription>
        </DialogHeader>
        <OrderComposerLayout locale={locale} catalog={<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <OrderComposerSearch><Input aria-label={zh ? '搜索放射目录' : 'Search imaging catalog'} maxLength={128}
            onChange={event => setQuery(event.target.value)}
            placeholder={zh ? '名称、编号、部位或方式' : 'Name, code, body site, or method'} value={query} /></OrderComposerSearch>
          <div className="min-h-0 flex-1 overflow-y-auto border-y p-1">
            {visible.length === 0 ? <Empty role="status"><EmptyHeader><EmptyTitle>{zh ? '没有匹配的放射检查' : 'No matching imaging examinations'}</EmptyTitle></EmptyHeader></Empty> : (
              <ul className="flex flex-col gap-0.5">
                {visible.map(({ available, service }) => (
                  <li key={service.id}>
                    <OrderCatalogCandidate selected={serviceId === service.id} disabled={!available || draftPending} onSelect={() => select({ available, service })}>
                      <span className="min-w-0"><strong className="block truncate" title={service.name}>{service.name}</strong>
                        {available ? null : <span className="block text-xs text-muted-foreground">{zh ? '本院当前未开展' : 'Not currently available'}</span>}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{service.bodySite} · {service.method}</span>
                      {service.outpatientBilling === undefined ? null : <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground tabular-nums">¥{(service.outpatientBilling.priceFen / 100).toFixed(2)}</span>}
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
                { label: zh ? '部位与方式' : 'Body site and method', value: `${selected.service.bodySite} · ${selected.service.method}` },
                { label: zh ? '适用条件' : 'Applicability', value: selected.service.applicability },
              ]} />
            <Field>
              <FieldLabel htmlFor="imaging-composer-indication">{zh ? '检查指征' : 'Indication'}</FieldLabel>
              <Textarea disabled={draftPending} id="imaging-composer-indication" maxLength={500} onChange={event => setIndication(event.target.value)} value={indication} />
            </Field>
          </div>
        )}
        </OrderComposerLayout>
        <p className="text-sm" role="status">{zh ? `已加入 ${addedItems.length} 项：${addedItems.join('、') || '暂无'}` : `Added ${addedItems.length}: ${addedItems.join(', ') || 'None'}`}</p>
        {notice === '' ? null : <p className="text-sm text-destructive" role="alert">{notice}</p>}
        <OrderComposerFooter hint={draftPending ? (zh ? '正在保存，请稍候' : 'Saving, please wait') : selected === undefined ? (zh ? '请先从左侧选择项目' : 'Choose an item first')
          : !imagingIndicationSchema.safeParse(indication).success ? (indication.trim() ? (zh ? '请核对检查指征' : 'Check the indication') : (zh ? '还差：检查指征' : 'Complete the indication'))
            : (zh ? '核对右侧信息后加入' : 'Review the fields before adding')}>
          <DialogClose render={<Button type="button" variant="outline" />}>{zh ? '关闭' : 'Close'}</DialogClose>
          <Button data-busy={draftPending || undefined} data-unavailable={serviceId === null || !imagingIndicationSchema.safeParse(indication).success || draftPending ? '' : undefined} disabled={serviceId === null || !imagingIndicationSchema.safeParse(indication).success || draftPending} onClick={confirm} type="button">
            {draftPending ? <Spinner aria-hidden="true" data-icon="inline-start" /> : null}{draftPending ? (zh ? '正在保存' : 'Saving') : (zh ? '加入放射检查' : 'Add imaging examination')}
          </Button>
        </OrderComposerFooter>
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
  const dismissDraftItem = useDoctorDraftItemEdit()
  const zh = locale === 'zh-CN'
  const messages = getWorkspaceMessages(locale)
  const draftScope = JSON.stringify([recommendationScope, caseId, encounter.id, 'imaging'])
  const manualDrafts = useManualInvestigationDrafts(draftScope, 'imaging')
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
    queryFn: ({ signal }) => getCaseImagingServices(caseId, signal),
    queryKey: ['doctor-case-imaging-services', caseId],
  })
  const draftVersion = state?.draftVersion ?? 0
  const legacyVersion = state?.draft === undefined ? undefined : String(draftVersion) + ':' + state.draft.service.id
  useEffect(() => {
    if (readOnly || manualDrafts.failed || legacyVersion === undefined || manualDrafts.legacyVersion === legacyVersion || state?.draft === undefined) return
    const draft = state.draft
    if (!draftPreferences.save(previous => ({ ...previous,
      edits: Object.fromEntries(Object.entries(previous.edits).filter(([key]) => key !== JSON.stringify(['imaging', draft.service.id]))) }))) return
    manualDrafts.save(previous => [...previous.filter(row => row.value.kind !== 'imaging' || row.value.serviceId !== draft.service.id),
      { label: draft.service.name, value: { source: 'manual', kind: 'imaging', serviceId: draft.service.id,
        indication: draft.indication, reviewedService: reviewedInvestigationService(draft.service)! } }], legacyVersion)
  })
  const removeLocal = (target: string) => manualDrafts.save(rows => target === 'all' ? [] : rows.filter(row => row.value.kind !== 'imaging' || row.value.serviceId !== target))
  const draftAction = useMutation({
    mutationFn: async (target: string): Promise<void> => {
      await deleteImagingRequestDraft({ encounterId: encounter.id, encounterVersion: encounter.versionId, expectedDraftVersion: draftVersion }, newIdempotencyKey())
      if (removeLocal(target)) setDiscardOpen(false)
    },
    onSettled: () => onChanged(),
  })
  const discard = (target: string) => {
    if (state?.draft !== undefined && (target === 'all' || state.draft.service.id === target)) draftAction.mutate(target)
    else if (removeLocal(target)) setDiscardOpen(false)
  }
  const lastDraft = manualDrafts.rows.at(-1)?.value
  const draftInput = agentToolInputSchemas['outpatient.imaging.draft.set'].safeParse(lastDraft?.kind === 'imaging'
    ? { serviceId: lastDraft.serviceId, indication: lastDraft.indication } : null)
  useRegisterAgentForm({
    name: 'imaging', selectionId: caseId, viewId: 'consultation',
    values: readOnly || !draftInput.success ? null : draftInput.data,
  })
  const recommendationUnavailableReason = (suggestion: DoctorRecommendationSuggestion | PreparationDraft): string | undefined => {
    if (suggestion.kind !== 'imaging' || draftAction.isPending || services.isFetching
      || !services.data?.items.some(item => item.available && item.service.id === suggestion.serviceId)
      || !agentToolInputSchemas['outpatient.imaging.draft.set'].safeParse({
        serviceId: suggestion.serviceId, indication: suggestion.indication,
      }).success) return messages.recommendationRequestTargetUnavailable
    return services.data?.items.find(item => item.service.id === suggestion.serviceId)?.service.outpatientBilling === undefined ? missingInvestigationPrice(locale) : undefined
  }
  const addButton = (
    <Button data-agent-catalog-trigger="imaging" disabled={draftAction.isPending || manualDrafts.failed} onClick={() => setComposerOpen(true)} size="sm" type="button" variant="outline">
      <PlusIcon data-icon="inline-start" />{zh ? '添加放射检查' : 'Add examination'}
    </Button>
  )
  const editor = readOnly ? null : services.isPending ? <Skeleton className="mt-3 h-24 w-full" /> : services.isError ? (
    <Alert className="mt-3" variant="destructive">
      <AlertTitle>{zh ? '无法加载放射服务' : 'Unable to load imaging services'}</AlertTitle>
      <AlertDescription>
        <Button onClick={() => void services.refetch()} size="sm" variant="outline">{zh ? '重试' : 'Retry'}</Button>
      </AlertDescription>
    </Alert>
  ) : (
    <section aria-label={zh ? '开具放射申请' : 'Prepare imaging request'} className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">{zh ? '同类待开项目最多 8 项，关闭、切患者和刷新后保留。' : 'Keep up to eight examinations after closing, switching patients or reloading.'}</p>
        <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}><AlertDialogTrigger render={<Button size="sm" type="button" variant="outline" disabled={draftAction.isPending} />}>
          {zh ? '清空待开清单' : 'Discard pending examinations'}
        </AlertDialogTrigger><AlertDialogContent><AlertDialogHeader>
          <AlertDialogTitle>{zh ? '丢弃全部手动待开放射检查？' : 'Discard all manual pending examinations?'}</AlertDialogTitle>
          <AlertDialogDescription>{zh ? '将删除这些未提交输入，已经开立的申请不受影响。' : 'Discard the unsubmitted inputs. Issued requests remain.'}</AlertDialogDescription>
        </AlertDialogHeader>{draftAction.isError ? <p role="alert">{getWorkspaceErrorMessage(draftAction.error, messages)}</p> : null}
        <AlertDialogFooter><AlertDialogCancel>{messages.cancel}</AlertDialogCancel><AlertDialogAction disabled={draftAction.isPending} onClick={() => discard('all')}>{zh ? '确认清空' : 'Confirm discard'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
      </div>
      {manualDrafts.failed ? <Alert variant="destructive"><AlertTitle>{messages.operationFailed}</AlertTitle><AlertDescription>{zh ? '待开清单无法保存或读取，已停止开立；请确认清空后再试。' : 'Pending storage is unavailable. Confirm discarding before continuing.'}</AlertDescription></Alert> : null}
      {notice === '' ? null : <p role="alert">{notice}</p>}
      {draftAction.isError ? <Alert variant="destructive"><AlertTitle>{zh ? '草稿未移除' : 'Draft was not removed'}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(draftAction.error, messages)}</AlertDescription></Alert> : null}
      <DoctorDraftEditorScope id={undefined} open={composerOpen}>{commit => <ImagingComposerDialog
        addedItems={manualDrafts.rows.map(row => row.label)}
        draftPending={draftAction.isPending || manualDrafts.failed}
        locale={locale}
        notice={manualDrafts.failed ? (zh ? '待开清单无法保存，请保留输入并恢复浏览器存储后再试。' : 'Pending inputs could not be saved. Keep the input and restore browser storage.') : notice}
        onConfirm={({ indication, serviceId }) => {
          if (manualDrafts.rows.length >= 8 && !manualDrafts.rows.some(row => row.value.kind === 'imaging' && row.value.serviceId === serviceId)) {
            setNotice(zh ? '最多保留 8 项，请先开立或移除项目。' : 'Keep at most eight examinations; issue or remove one first.'); return false
          }
          const service = services.data?.items.find(item => item.available && item.service.id === serviceId)?.service
          if (service === undefined) return false
          const saved = manualDrafts.save(previous => [...previous.filter(row => row.value.kind !== 'imaging' || row.value.serviceId !== serviceId),
            { label: service.name, value: { source: 'manual', kind: 'imaging', serviceId, indication, reviewedService: reviewedInvestigationService(service)! } }])
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
      kind="imaging"
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
        if (item.value.kind !== 'imaging' || item.value.source !== 'manual') return false
        const id = item.value.serviceId
        return manualDrafts.save(previous => [...previous.filter(row => row.value.kind !== 'imaging' || row.value.serviceId !== id), item])
      }}
      onConfirmed={(values, result) => {
        if (result.recordIds[0] !== undefined) selectRequest(result.recordIds[0])
        return manualDrafts.save(previous => previous.filter(row => !values.some(value => value.source === 'manual' && value.kind === 'imaging'
          && row.value.kind === 'imaging' && row.value.serviceId === value.serviceId && row.value.indication.trim() === value.indication.trim()
          && (row.value.reviewedService === undefined || row.value.reviewedService.version === value.reviewedService?.version
            && row.value.reviewedService.outpatientBilling?.version === value.reviewedService.outpatientBilling?.version))))
      }}
      onManualRemove={value => { if (value.kind === 'imaging') discard(value.serviceId) }}
      unavailableReason={recommendationUnavailableReason}
      manualUnavailableReason={recommendationUnavailableReason}
      investigationServiceFor={value => value.kind === 'imaging' ? reviewedInvestigationService(services.data?.items.find(item => item.service.id === value.serviceId)?.service) : undefined}
      itemDetails={value => value.kind === 'imaging' ? <InvestigationPrice locale={locale} presentation="inline" price={value.reviewedService?.outpatientBilling ?? undefined} /> : null}
    />
  )
  return (
    <section aria-labelledby={`${elementId}-heading`} className="flex min-w-0 flex-col gap-3 outline-none" id={elementId} tabIndex={-1}>
      <h3 className="sr-only" id={`${elementId}-heading`}>{zh ? '放射检查' : 'Imaging'}</h3>
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
