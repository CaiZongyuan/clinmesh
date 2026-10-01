import type { ImagingReport, ImagingRequest, ImagingServiceSnapshot } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import {
  acknowledgeImagingReport,
  cancelImagingRequest,
  correctImagingReport,
  deleteImagingRequestDraft,
  getCaseImagingServices,
  getImagingStudy,
  getImagingStudyBlock,
  issueImagingRequest,
  newIdempotencyKey,
  retryImagingRequest,
  saveImagingRequestDraft,
} from '../api-client.ts'
import { ImagingViewer, type ImagingViewerSource } from '../imaging/imaging-viewer.tsx'
import { getWorkspaceErrorMessage } from '../workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { WorkspaceSelect } from '../workspace-select.tsx'
import { formatClinicalDateTime } from './clinical-date-time.ts'

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
        {report.revisionNumber === 1 ? '' : zh ? ` · 第 ${report.revisionNumber} 版，更正原因：${report.revisionReason}` : ` · Revision ${report.revisionNumber}: ${report.revisionReason}`}
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
function ImagingRequestItem({ actions, locale, readOnly, request }: {
  actions: ImagingPageActions
  locale: WorkspaceLocale
  readOnly: boolean
  request: ImagingRequest
}) {
  const zh = locale === 'zh-CN'
  const messages = getWorkspaceMessages(locale)
  const { onChanged, onInsertSummary, view } = actions
  const [summaryInsertion, setSummaryInsertion] = useState<ImagingSummaryInsertion>()
  const viewerOpen = view.isOpen(request.id)
  const diagnosticReportId = request.report?.diagnosticReportId
  const frameShown = diagnosticReportId !== undefined && view.isShown(diagnosticReportId)
  const studyId = request.report?.studyId
  const study = useQuery({
    enabled: viewerOpen && studyId !== undefined,
    gcTime: 0,
    queryFn: ({ signal }) => getImagingStudy(studyId!, signal),
    queryKey: ['imaging-study', studyId ?? 'none'],
  })
  const source = useMemo<ImagingViewerSource | undefined>(() => study.data === undefined || studyId === undefined
    ? undefined
    : { loadBlock: (position, signal) => getImagingStudyBlock(studyId, position, signal), study: study.data },
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
            <details className="mt-2">
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
export function ImagingRequestList({ actions, locale, readOnly, requests }: {
  actions: ImagingPageActions
  locale: WorkspaceLocale
  readOnly: boolean
  requests: ImagingRequest[]
}) {
  if (requests.length === 0) return null
  return (
    <ul>
      {requests.map(request => (
        <ImagingRequestItem
          actions={actions}
          key={`${request.id}:${request.report?.diagnosticReportId ?? 'none'}`}
          locale={locale}
          readOnly={readOnly}
          request={request}
        />
      ))}
    </ul>
  )
}

/**
 * 医生工作台的放射检查：选择本院放射服务并填写检查指征，保存草稿后签发；
 * 下方列出本次就诊的放射申请、报告和影像。
 */
export function ImagingPage({ actions, caseId, elementId, encounter, locale, readOnly, state }: {
  actions: ImagingPageActions
  caseId: string
  elementId: string
  encounter: { id: string; versionId: string }
  locale: WorkspaceLocale
  readOnly: boolean
  state: ImagingRequestState | undefined
}) {
  const { onChanged } = actions
  const zh = locale === 'zh-CN'
  const messages = getWorkspaceMessages(locale)
  const [serviceId, setServiceId] = useState<string | null>(state?.draft?.service.id ?? null)
  const [indication, setIndication] = useState(state?.draft?.indication ?? '')
  const services = useQuery({
    enabled: !readOnly,
    queryFn: ({ signal }) => getCaseImagingServices(caseId, signal),
    queryKey: ['doctor-case-imaging-services', caseId],
  })
  const draftVersion = state?.draftVersion ?? 0
  const encounterVersion = { encounterId: encounter.id, encounterVersion: encounter.versionId }
  const draftAction = useMutation({
    mutationFn: async (kind: 'delete' | 'issue' | 'save'): Promise<void> => {
      if (kind === 'delete') {
        await deleteImagingRequestDraft({ ...encounterVersion, expectedDraftVersion: draftVersion }, newIdempotencyKey())
        return
      }
      // 签发的是已保存的草稿：表单有改动时先保存，再按保存后的草稿版本签发。
      const unchanged = state?.draft?.service.id === serviceId && state.draft.indication === indication.trim()
      const saved = unchanged
        ? draftVersion
        : (await saveImagingRequestDraft({
            ...encounterVersion,
            expectedDraftVersion: draftVersion,
            indication,
            serviceId: serviceId!,
          }, newIdempotencyKey())).data.draftVersion
      if (kind === 'issue') {
        await issueImagingRequest({ ...encounterVersion, expectedDraftVersion: saved }, newIdempotencyKey())
      }
    },
    onSettled: () => onChanged(),
    onSuccess: (_result, kind) => {
      if (kind === 'save') return
      setServiceId(null)
      setIndication('')
    },
  })
  const formReady = serviceId !== null && indication.trim().length >= 2
  return (
    <section aria-labelledby={`${elementId}-heading`} className="mt-6 border-t pt-4 outline-none" id={elementId} tabIndex={-1}>
      <h3 className="text-sm font-semibold" id={`${elementId}-heading`}>{zh ? '放射检查' : 'Imaging'}</h3>
      {readOnly ? null : services.isPending ? <Skeleton className="mt-3 h-24 w-full" /> : services.isError ? (
        <Alert className="mt-3" variant="destructive">
          <AlertTitle>{zh ? '无法加载放射服务' : 'Unable to load imaging services'}</AlertTitle>
          <AlertDescription>
            <Button onClick={() => void services.refetch()} size="sm" variant="outline">{zh ? '重试' : 'Retry'}</Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="mt-3 grid gap-3">
          <div>
            <label className="text-xs text-muted-foreground" htmlFor={`${elementId}-service`}>{zh ? '检查项目' : 'Examination'}</label>
            <WorkspaceSelect
              id={`${elementId}-service`}
              items={services.data.items.filter(item => item.available).map(item => ({
                label: `${item.service.name} · ${item.service.method}`,
                value: item.service.id,
              }))}
              onValueChange={setServiceId}
              placeholder={zh ? '选择放射检查' : 'Select an imaging examination'}
              value={serviceId}
            />
            {services.data.items.filter(item => !item.available).map(item => (
              <p className="mt-1 text-xs text-muted-foreground" key={item.service.id}>
                {zh ? `${item.service.name}：本院当前未开展` : `${item.service.name}: not currently available`}
              </p>
            ))}
          </div>
          <div>
            <label className="text-xs text-muted-foreground" htmlFor={`${elementId}-indication`}>{zh ? '检查指征' : 'Indication'}</label>
            <Textarea
              id={`${elementId}-indication`}
              maxLength={500}
              onChange={event => setIndication(event.target.value)}
              value={indication}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={!formReady || draftAction.isPending} onClick={() => draftAction.mutate('save')} size="sm" variant="outline">
              {zh ? '保存草稿' : 'Save draft'}
            </Button>
            <Button disabled={!formReady || draftAction.isPending} onClick={() => draftAction.mutate('issue')} size="sm">
              {zh ? '签发申请' : 'Issue request'}
            </Button>
            {state?.draft === undefined ? null : (
              <>
                <Button disabled={draftAction.isPending} onClick={() => draftAction.mutate('delete')} size="sm" variant="outline">
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
              <AlertTitle>{zh ? '放射申请未提交' : 'The imaging request was not submitted'}</AlertTitle>
              <AlertDescription>{getWorkspaceErrorMessage(draftAction.error, messages)}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      )}
      {state === undefined || state.requests.length === 0
        ? <p className="mt-3 text-sm text-muted-foreground">{zh ? '本次就诊暂无放射申请。' : 'No imaging requests in this visit.'}</p>
        : <div className="mt-3"><ImagingRequestList actions={actions} locale={locale} readOnly={readOnly} requests={state.requests} /></div>}
    </section>
  )
}
