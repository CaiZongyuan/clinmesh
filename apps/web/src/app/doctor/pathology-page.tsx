import type { PathologyReport, PathologyRequest, PathologyServiceSnapshot } from '@clinmesh/contracts/his'
import type { PathologySourceProcedure } from '@clinmesh/contracts/pathology'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import {
  acknowledgePathologyReport,
  cancelPathologyRequest,
  correctPathologyReport,
  deletePathologyRequestDraft,
  getCasePathologyServices,
  getImagingStudy,
  getImagingStudyBlock,
  issuePathologyRequest,
  newIdempotencyKey,
  retryPathologyRequest,
  savePathologyRequestDraft,
} from '../api-client.ts'
import { ImagingViewer, type ImagingViewerSource } from '../imaging/imaging-viewer.tsx'
import { getWorkspaceErrorMessage } from '../workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { WorkspaceSelect } from '../workspace-select.tsx'
import { formatClinicalDateTime } from './clinical-date-time.ts'
import type { ImagingSummaryInsertion, ImagingViewState } from './imaging-page.tsx'

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
        {report.revisionNumber === 1 ? '' : zh ? ` · 第 ${report.revisionNumber} 版，更正原因：${report.revisionReason}` : ` · Revision ${report.revisionNumber}: ${report.revisionReason}`}
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
function PathologyRequestItem({ actions, locale, readOnly, request }: {
  actions: PathologyPageActions
  locale: WorkspaceLocale
  readOnly: boolean
  request: PathologyRequest
}) {
  const zh = locale === 'zh-CN'
  const messages = getWorkspaceMessages(locale)
  const { onChanged, onInsertSummary, view } = actions
  const [summaryInsertion, setSummaryInsertion] = useState<ImagingSummaryInsertion>()
  const viewerOpen = view.isOpen(request.id)
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
    <li className="border-t py-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm font-medium">{request.service.name}</strong>
        <Badge variant={request.status === 'acknowledged' ? 'success' : request.status === 'generation-failed' ? 'warning' : 'outline'}>
          {statusLabels[request.status][zh ? 0 : 1]}
        </Badge>
        <span className="text-xs text-muted-foreground">{zh ? '送检手术：' : 'Source procedure: '}{procedureLabel(request.sourceProcedure)}</span>
        <span className="text-xs text-muted-foreground">{zh ? '会诊目的：' : 'Purpose: '}{request.purpose}</span>
      </div>
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
            <details className="mt-2">
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
    </li>
  )
}

/** 会诊申请列表；已完诊病例以只读方式复用。 */
export function PathologyRequestList({ actions, locale, readOnly, requests }: {
  actions: PathologyPageActions
  locale: WorkspaceLocale
  readOnly: boolean
  requests: PathologyRequest[]
}) {
  if (requests.length === 0) return null
  return (
    <ul>
      {requests.map(request => (
        <PathologyRequestItem
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
 * 医生工作台的病理会诊：选择本院会诊服务、从患者可见既往病史中选择送检对应的手术并填写会诊目的，
 * 保存草稿后签发；下方列出本次就诊的会诊申请、报告和切片。
 */
export function PathologyPage({ actions, caseId, elementId, encounter, locale, readOnly, state }: {
  actions: PathologyPageActions
  caseId: string
  elementId: string
  encounter: { id: string; versionId: string }
  locale: WorkspaceLocale
  readOnly: boolean
  state: PathologyRequestState | undefined
}) {
  const { onChanged } = actions
  const zh = locale === 'zh-CN'
  const messages = getWorkspaceMessages(locale)
  const [serviceId, setServiceId] = useState<string | null>(state?.draft?.service.id ?? null)
  const [procedureReference, setProcedureReference] = useState<string | null>(state?.draft?.sourceProcedure.sourceReference ?? null)
  const [purpose, setPurpose] = useState(state?.draft?.purpose ?? '')
  const services = useQuery({
    enabled: !readOnly,
    queryFn: ({ signal }) => getCasePathologyServices(caseId, signal),
    queryKey: ['doctor-case-pathology-services', caseId],
  })
  const draftVersion = state?.draftVersion ?? 0
  const encounterVersion = { encounterId: encounter.id, encounterVersion: encounter.versionId }
  const draftAction = useMutation({
    mutationFn: async (kind: 'delete' | 'issue' | 'save'): Promise<void> => {
      if (kind === 'delete') {
        await deletePathologyRequestDraft({ ...encounterVersion, expectedDraftVersion: draftVersion }, newIdempotencyKey())
        return
      }
      // 签发的是已保存的草稿：表单有改动时先保存，再按保存后的草稿版本签发。
      const unchanged = state?.draft?.service.id === serviceId
        && state.draft.sourceProcedure.sourceReference === procedureReference
        && state.draft.purpose === purpose.trim()
      const saved = unchanged
        ? draftVersion
        : (await savePathologyRequestDraft({
            ...encounterVersion,
            expectedDraftVersion: draftVersion,
            purpose,
            serviceId: serviceId!,
            sourceProcedureReference: procedureReference!,
          }, newIdempotencyKey())).data.draftVersion
      if (kind === 'issue') {
        await issuePathologyRequest({ ...encounterVersion, expectedDraftVersion: saved }, newIdempotencyKey())
      }
    },
    onSettled: () => onChanged(),
    onSuccess: (_result, kind) => {
      if (kind === 'save') return
      setServiceId(null)
      setProcedureReference(null)
      setPurpose('')
    },
  })
  const selectedService = services.data?.items.find(item => item.service.id === serviceId)
  const formReady = serviceId !== null && procedureReference !== null && purpose.trim().length >= 2
  return (
    <section aria-labelledby={`${elementId}-heading`} className="mt-6 border-t pt-4 outline-none" id={elementId} tabIndex={-1}>
      <h3 className="text-sm font-semibold" id={`${elementId}-heading`}>{zh ? '病理会诊' : 'Pathology consultation'}</h3>
      {readOnly ? null : services.isPending ? <Skeleton className="mt-3 h-24 w-full" /> : services.isError ? (
        <Alert className="mt-3" variant="destructive">
          <AlertTitle>{zh ? '无法加载病理会诊服务' : 'Unable to load pathology services'}</AlertTitle>
          <AlertDescription>
            <Button onClick={() => void services.refetch()} size="sm" variant="outline">{zh ? '重试' : 'Retry'}</Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="mt-3 grid gap-3">
          <div>
            <label className="text-xs text-muted-foreground" htmlFor={`${elementId}-service`}>{zh ? '会诊项目' : 'Consultation'}</label>
            <WorkspaceSelect
              id={`${elementId}-service`}
              items={services.data.items.filter(item => item.available).map(item => ({
                label: `${item.service.name} · ${item.service.specimenType}`,
                value: item.service.id,
              }))}
              onValueChange={(value) => {
                setServiceId(value)
                setProcedureReference(null)
              }}
              placeholder={zh ? '选择病理会诊' : 'Select a pathology consultation'}
              value={serviceId}
            />
            {services.data.items.filter(item => !item.available).map(item => (
              <p className="mt-1 text-xs text-muted-foreground" key={item.service.id}>
                {zh ? `${item.service.name}：本院当前未开展` : `${item.service.name}: not currently available`}
              </p>
            ))}
          </div>
          <div>
            <label className="text-xs text-muted-foreground" htmlFor={`${elementId}-procedure`}>{zh ? '送检的既往手术' : 'Source procedure'}</label>
            <WorkspaceSelect
              id={`${elementId}-procedure`}
              items={(selectedService?.sourceProcedures ?? []).map(procedure => ({
                label: procedureLabel(procedure),
                value: procedure.sourceReference,
              }))}
              onValueChange={setProcedureReference}
              placeholder={zh ? '从既往病史中选择手术' : 'Select a procedure from the history'}
              value={procedureReference}
            />
            {selectedService !== undefined && selectedService.sourceProcedures.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {zh ? '该患者的既往病史中没有可送检的乳腺手术。' : 'The history has no breast procedure to consult on.'}
              </p>
            ) : null}
          </div>
          <div>
            <label className="text-xs text-muted-foreground" htmlFor={`${elementId}-purpose`}>{zh ? '会诊目的' : 'Purpose'}</label>
            <Textarea
              id={`${elementId}-purpose`}
              maxLength={500}
              onChange={event => setPurpose(event.target.value)}
              value={purpose}
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
                  {zh
                    ? `已保存草稿：${state.draft.service.name}（${procedureLabel(state.draft.sourceProcedure)}）`
                    : `Saved draft: ${state.draft.service.name} (${procedureLabel(state.draft.sourceProcedure)})`}
                </span>
              </>
            )}
          </div>
          {draftAction.isError ? (
            <Alert variant="destructive">
              <AlertTitle>{zh ? '病理会诊申请未提交' : 'The pathology request was not submitted'}</AlertTitle>
              <AlertDescription>{getWorkspaceErrorMessage(draftAction.error, messages)}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      )}
      {state === undefined || state.requests.length === 0
        ? <p className="mt-3 text-sm text-muted-foreground">{zh ? '本次就诊暂无病理会诊申请。' : 'No pathology consultations in this visit.'}</p>
        : <div className="mt-3"><PathologyRequestList actions={actions} locale={locale} readOnly={readOnly} requests={state.requests} /></div>}
    </section>
  )
}
