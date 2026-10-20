import { clinicalDocumentFieldSchema, type ClinicalDocumentContent, type ClinicalDocumentQualityControlState, type DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import {
  checkClinicalDocumentQuality, getClinicalDocumentQuality, newIdempotencyKey,
} from '../api-client.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { formatClinicalDateTime } from './clinical-date-time.ts'

export type QualityIssue = ClinicalDocumentQualityControlState['issues'][number]
type Messages = ReturnType<typeof getWorkspaceMessages>
type QualityRequest = { identity: string; revision: number; clientId: string; refresh: boolean }
const requestIdentities = new WeakMap<QueryClient, Map<string, QualityRequest>>()

function currentGeneration(previous: ClinicalDocumentQualityControlState | undefined, incoming: ClinicalDocumentQualityControlState) {
  if (previous !== undefined && previous.generation > incoming.generation) return previous
  if (previous?.generation === incoming.generation && previous.inputFingerprint === incoming.inputFingerprint
    && previous.status !== 'pending' && incoming.status === 'pending' && !incoming.stale) return previous
  return incoming
}

export function useDocumentQualityControl({ detail, document, scope, initialState, enabled = true }: {
  detail: DoctorCaseDetail
  document?: ClinicalDocumentContent
  scope?: string | undefined
  initialState?: ClinicalDocumentQualityControlState | undefined
  enabled?: boolean
}) {
  const client = useQueryClient()
  const saved = detail.clinicalDocument?.draft
  const candidate = document !== undefined && !clinicalDocumentFieldSchema.options.every(field => (document[field] ?? '') === (saved?.[field] ?? ''))
    ? document : undefined
  const identity = JSON.stringify([scope, detail.caseId, detail.encounter.id, saved?.version ?? 0,
    clinicalDocumentFieldSchema.options.map(field => (candidate ?? saved)?.[field] ?? ''), candidate !== undefined,
    detail.consultation?.turns.filter(turn => turn.kind === 'text' && turn.speaker === 'patient'),
    detail.consultationRecording?.sources,
    detail.consultationRecording?.additions.filter(addition => addition.status === 'applied' && addition.ownership === 'automatic'),
    detail.allergies, detail.presentation, detail.triage, detail.diagnosis?.confirmation, detail.priorFacts,
    detail.laboratoryRequests?.requests.map(request => [request.report, request.previousReports]),
    detail.imagingRequests?.requests.map(request => [request.report, request.previousReports]),
    detail.pathologyRequests?.requests.map(request => [request.report, request.previousReports]),
  ])
  let ledger = requestIdentities.get(client)
  if (ledger === undefined) { ledger = new Map(); requestIdentities.set(client, ledger) }
  const ledgerKey = JSON.stringify([scope, detail.caseId, candidate !== undefined])
  const previousRequest = ledger.get(ledgerKey)
  const request = previousRequest?.identity === identity ? previousRequest : {
    identity, revision: (previousRequest?.revision ?? 0) + 1, clientId: previousRequest?.clientId ?? newIdempotencyKey(), refresh: false,
  }
  ledger.set(ledgerKey, request)
  const [debouncedIdentity, setDebouncedIdentity] = useState<string>()
  useEffect(() => {
    if (!enabled) return
    const timer = setTimeout(() => setDebouncedIdentity(identity), candidate === undefined ? 0 : 500)
    return () => clearTimeout(timer)
  }, [identity, enabled, candidate === undefined])
  const draftVersion = detail.clinicalDocument?.draft?.version ?? 0
  const queryKey = ['document-quality', scope, detail.caseId, candidate === undefined ? 'saved' : request.clientId, request.revision] as const
  const matches = (incoming: ClinicalDocumentQualityControlState) => incoming.caseId === detail.caseId
    && incoming.encounterId === detail.encounter.id && incoming.draftVersion === draftVersion
    && (candidate === undefined ? incoming.clientId === undefined
      && (initialState === undefined || incoming.documentFingerprint === initialState.documentFingerprint)
      : incoming.clientId === request.clientId && incoming.clientRevision === request.revision)
  const query = useQuery({
    queryKey, retry: false, retryOnMount: false, refetchOnMount: false, refetchOnWindowFocus: false,
    enabled: enabled && debouncedIdentity === identity && client.getQueryState(queryKey)?.error == null,
    ...(initialState === undefined ? {} : { initialData: initialState }),
    queryFn: async () => {
      const previous = client.getQueryData<ClinicalDocumentQualityControlState>(queryKey)
      const check = previous === undefined || previous.stale || previous.status === 'idle' || request.refresh
      const refresh = request.refresh || previous?.stale === true
      request.refresh = false
      const incoming = check ? await checkClinicalDocumentQuality({ caseId: detail.caseId,
        encounterId: detail.encounter.id, encounterVersion: detail.encounter.versionId, expectedDraftVersion: draftVersion,
        ...(candidate === undefined ? {} : { document: candidate, clientId: request.clientId, clientRevision: request.revision }),
        refresh }) : await getClinicalDocumentQuality(detail.caseId, candidate === undefined ? undefined : request.clientId)
      if (!matches(incoming)) throw new Error('DOCUMENT_QUALITY_INPUT_CHANGED')
      return currentGeneration(client.getQueryData<ClinicalDocumentQualityControlState>(queryKey), incoming)
    },
    refetchInterval: query => query.state.error === null ? 1_500 : false,
  })
  const state = query.data !== undefined && matches(query.data) ? query.data : undefined
  const stale = state?.stale === true || query.error?.message === 'DOCUMENT_QUALITY_INPUT_CHANGED'
  return {
    state, stale, error: query.error,
    pending: enabled && (debouncedIdentity !== identity || query.isPending || query.isFetching && state === undefined),
    retry: () => { request.refresh = true; void query.refetch() },
  }
}

export type DocumentQualityControl = ReturnType<typeof useDocumentQualityControl>

export function locateDocumentQualityIssue(root: ParentNode, issue: QualityIssue): boolean {
  const field = root.querySelector<HTMLElement>(`[data-clinical-document-field="${issue.field}"]`)
  const input = field?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
  if (input === undefined || input === null || input.disabled) return false
  field?.scrollIntoView?.({ block: 'center', behavior: 'instant' })
  input.focus({ preventScroll: true })
  const quote = issue.evidence.find(evidence => evidence.kind === 'document' && evidence.field === issue.field
    && input.value.includes(evidence.text) && input.value.indexOf(evidence.text) === input.value.lastIndexOf(evidence.text))?.text
  const start = quote === undefined ? 0 : input.value.indexOf(quote)
  input.setSelectionRange(start, quote === undefined ? start : start + quote.length)
  return true
}

export function openIssues(quality: DocumentQualityControl) {
  return quality.stale || quality.error !== null ? [] : quality.state?.issues.filter(issue => issue.status === 'open' && issue.classification !== 'needs-completion') ?? []
}

export function shortIssue(issue: QualityIssue, messages: Messages, locale: WorkspaceLocale) {
  const field = messages[issue.field]
  if (locale === 'zh-CN') {
    switch (issue.kind) {
      case 'missing-field': return `${field}有内容待补充，请核对。`
      case 'omission': return `${field}有已知信息待补充。`
      case 'inconsistency': return `${field}的记录不一致，请核对。`
      case 'agent-source': return `${field}中有内容需要核实。`
    }
  }
  switch (issue.kind) {
    case 'missing-field': return `${field} needs more detail.`
    case 'omission': return `${field} is missing known information.`
    case 'inconsistency': return `Check conflicting information in ${field}.`
    case 'agent-source': return `Verify information in ${field}.`
  }
}

export function DocumentQualityCompact({ quality, messages, locale, onLocateIssue }: {
  quality: DocumentQualityControl; messages: Messages; locale: WorkspaceLocale; onLocateIssue?: ((issue: QualityIssue) => void) | undefined
}) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const issues = openIssues(quality)
  const first = issues[0]
  if (first === undefined) return null
  const location = (issue: QualityIssue) => onLocateIssue === undefined ? <p className="break-words">{shortIssue(issue, messages, locale)}</p>
    : <Button className="h-auto min-h-7 min-w-0 justify-start whitespace-normal break-words text-left"
    onClick={() => onLocateIssue(issue)} size="sm" type="button" variant="link">{shortIssue(issue, messages, locale)}</Button>
  return <section aria-label={messages.documentQualityTitle} data-document-quality-compact>
    <Alert role="group">
      <AlertDescription className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {location(first)}
          {issues.length === 1 ? null : <Button aria-controls={id} aria-expanded={expanded} onClick={() => setExpanded(open => !open)}
            size="sm" type="button" variant="ghost">{locale === 'zh-CN' ? `另有 ${issues.length - 1} 处` : `${issues.length - 1} more`}</Button>}
        </div>
        {!expanded || issues.length === 1 ? null : <ul className="flex min-w-0 flex-col gap-1" id={id}>
          {issues.slice(1).map(issue => <li className="min-w-0" key={issue.id}>{location(issue)}</li>)}
        </ul>}
      </AlertDescription>
    </Alert>
  </section>
}

export function DocumentQualityDetails({ quality, messages, locale, onLocateIssue }: {
  quality: DocumentQualityControl; messages: Messages; locale: WorkspaceLocale; onLocateIssue?: ((issue: QualityIssue) => void) | undefined
}) {
  const fields = [...new Set(quality.state?.issues.map(issue => issue.field) ?? [])]
  return <div className="flex min-w-0 flex-col gap-3" data-document-quality-details>
    <DocumentQualityStatus quality={quality} messages={messages} locale={locale} />
    {fields.map(field => <DocumentQualityFieldIssues field={field} key={field} locale={locale} messages={messages}
      onLocateIssue={onLocateIssue} quality={quality} />)}
  </div>
}

const failureMessages = {
  'invalid-json': ['返回内容格式不正确，本次病历检查未完成，可重试。', 'The response format was invalid. The document check is incomplete; retry when ready.'],
  'invalid-shape': ['返回的检查内容不完整，本次检查未完成，可重试。', 'The response was incomplete. The document check did not finish; retry when ready.'],
  'invalid-source': ['引用的病历或资料无法核对，本次检查未完成，可重试。', 'A document or source quotation could not be verified. The check is incomplete; retry when ready.'],
  'invalid-coverage': ['部分内容没有完成核对，本次检查未完成，可重试。', 'Some content was not reviewed. The check is incomplete; retry when ready.'],
  'invalid-scope': ['返回内容超出本次病历检查范围，请重试。', 'The response exceeded the scope of this document check. Please retry.'],
  authentication: ['辅助模型的账户或权限不可用，请检查设置后重试。', 'The model account or access is unavailable. Check settings before retrying.'],
  timeout: ['病历检查等待超时，请稍后重试。', 'The document check timed out. Please retry later.'],
  'input-limit': ['本次资料超过检查范围，部分内容还没有检查完。', 'The supplied information exceeded the check limit. Part of the review remains incomplete.'],
  transport: ['病历检查服务暂时未能返回结果，请稍后重试。', 'The document check service could not return a result. Please retry later.'],
  unavailable: ['辅助检查服务暂不可用，仍保留已确定的问题提示。', 'The review service is unavailable. Established document issues remain available.'],
} satisfies Record<NonNullable<ClinicalDocumentQualityControlState['failure']>['reason'], [string, string]>

export function DocumentQualityStatus({ quality, messages, locale = 'zh-CN' }: {
  quality: DocumentQualityControl; messages: Messages; locale?: WorkspaceLocale
}) {
  const status = quality.stale ? messages.documentQualityStale : quality.error !== null ? messages.documentQualityFailed
    : quality.pending || quality.state?.status === 'pending' ? messages.documentQualityPending
      : quality.state?.status === 'ready' ? messages.documentQualityReady
        : quality.state?.status === 'failed' ? messages.documentQualityFailed
          : quality.state?.status === 'incomplete' ? messages.documentQualityIncomplete
            : quality.state?.status === 'unavailable' ? messages.documentQualityUnavailable : messages.documentQualityIdle
  return <section aria-label={messages.documentQualityTitle} data-document-quality-status={quality.stale ? 'stale' : quality.error !== null ? 'failed'
    : quality.pending ? 'pending' : quality.state?.status ?? 'idle'}>
    <Alert role="group">
      <AlertTitle>{messages.documentQualityTitle}</AlertTitle>
      <AlertDescription>
        <p role="status">{status}</p>
        {quality.stale || quality.error !== null || quality.state?.failure === undefined ? null : <p data-document-quality-failure={quality.state.failure.reason}>
          {failureMessages[quality.state.failure.reason][locale === 'zh-CN' ? 0 : 1]}
        </p>}
        {quality.state?.notices.map(notice => <p key={notice}>{notice}</p>)}
        <Button disabled={quality.pending} onClick={quality.retry} size="sm" type="button" variant="outline">
          {messages.documentQualityRetry}
        </Button>
      </AlertDescription>
    </Alert>
  </section>
}

function Issue({ issue, messages, locale, onLocateIssue }: {
  issue: QualityIssue; messages: Messages; locale: WorkspaceLocale
  onLocateIssue?: ((issue: QualityIssue) => void) | undefined
}) {
  return <li className="flex min-w-0 flex-col gap-2 text-sm" data-document-quality-issue={issue.id} data-document-quality-issue-status={issue.status}>
    <p className="whitespace-pre-wrap break-words">
      <Badge variant={issue.status === 'retained' ? 'outline' : 'secondary'}>{issue.status === 'retained' ? messages.documentQualityRetained
        : issue.classification === 'needs-completion' ? messages.documentQualityCompletion : messages.documentQualityVerification}</Badge>{' '}{issue.message}
    </p>
    {issue.explanation === undefined ? null : <dl className="grid min-w-0 gap-1 whitespace-pre-wrap break-words">
      <dt className="text-xs font-medium text-muted-foreground">{messages.documentQualityImpact}</dt>
      <dd>{issue.explanation.impact}</dd>
      <dt className="text-xs font-medium text-muted-foreground">{messages.documentQualitySuggestion}</dt>
      <dd>{issue.explanation.suggestion}</dd>
    </dl>}
    {issue.review === undefined ? null : <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
      {issue.review.actorId} · {formatClinicalDateTime(issue.review.reviewedAt, locale)}
      {issue.review.reason ? ` · ${issue.review.reason}` : ''}
    </p>}
    {onLocateIssue === undefined || issue.status !== 'open' ? null : <Button onClick={() => onLocateIssue(issue)} size="sm" type="button" variant="outline">
      {locale === 'zh-CN' ? '查看位置' : 'Go to field'}
    </Button>}
  </li>
}

export function DocumentQualityFieldIssues({ field, quality, messages, locale, onLocateIssue }: {
  field: keyof ClinicalDocumentContent; quality: DocumentQualityControl; messages: Messages; locale: WorkspaceLocale
  onLocateIssue?: ((issue: QualityIssue) => void) | undefined
}) {
  const issues = quality.stale || quality.error !== null ? [] : quality.state?.issues.filter(issue => issue.field === field) ?? []
  if (issues.length === 0) return null
  const retained = issues.filter(issue => issue.status === 'retained')
  return <section aria-label={`${messages[field]}${messages.documentQualityFieldSuffix}`} className="flex min-w-0 flex-col gap-2" data-document-quality-field={field}>
    <ul className="flex min-w-0 flex-col gap-3">{issues.filter(issue => issue.status === 'open').map(issue =>
      <Issue issue={issue} key={`${issue.id}:${issue.relatedFingerprint}`} messages={messages} locale={locale} onLocateIssue={onLocateIssue} />)}</ul>
    {retained.length === 0 ? null : <details>
      <summary className="cursor-pointer text-xs text-muted-foreground">{messages.documentQualityRetainedHistory} ({retained.length})</summary>
      <ul className="mt-2 flex min-w-0 flex-col gap-3">{retained.map(issue => <Issue issue={issue} key={issue.id} messages={messages} locale={locale} />)}</ul>
    </details>}
  </section>
}

export function DocumentQualitySignSummary({ detail, state, scope, locale }: {
  detail: DoctorCaseDetail; state: ClinicalDocumentQualityControlState | undefined; scope?: string | undefined; locale: WorkspaceLocale
}) {
  const quality = useDocumentQualityControl({ detail, initialState: state, scope })
  const messages = getWorkspaceMessages(locale)
  const [detailsOpen, setDetailsOpen] = useState(false)
  return <section aria-label={messages.documentQualitySignSummary} className="flex min-w-0 flex-col gap-3" data-document-quality-sign-summary>
    <DocumentQualityCompact quality={quality} messages={messages} locale={locale} />
    <details onToggle={event => setDetailsOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm">{locale === 'zh-CN' ? '依据与说明' : 'Basis and details'}</summary>
      {!detailsOpen ? null : <div className="mt-3 flex min-w-0 flex-col gap-3">
        <p className="text-xs text-muted-foreground">{messages.documentQualityAdvisory}</p>
        <DocumentQualityDetails quality={quality} messages={messages} locale={locale} />
      </div>}
    </details>
  </section>
}
