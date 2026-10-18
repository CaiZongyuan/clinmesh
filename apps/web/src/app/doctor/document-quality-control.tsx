import type { ClinicalDocumentContent, ClinicalDocumentQualityControlState, DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import {
  checkClinicalDocumentQuality, getClinicalDocumentQuality, newIdempotencyKey, retainClinicalDocumentQualityIssue,
} from '../api-client.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { formatClinicalDateTime } from './clinical-date-time.ts'

export type QualityIssue = ClinicalDocumentQualityControlState['issues'][number]
type Messages = ReturnType<typeof getWorkspaceMessages>

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
  const retentionKeys = useRef(new Map<string, string>())
  const { qualityControl: _quality, ...clinicalContext } = detail
  const identity = JSON.stringify([scope, clinicalContext, document, enabled])
  const view = useRef<{ identity: string; revision: number; clientId: string; scope: string | undefined; refresh: boolean } | null>(null)
  if (view.current === null || view.current.identity !== identity) {
    view.current = { identity, revision: (view.current?.revision ?? 0) + 1,
      clientId: view.current !== null && view.current.scope === scope ? view.current.clientId : newIdempotencyKey(), scope, refresh: false }
  }
  const request = view.current
  const [debouncedIdentity, setDebouncedIdentity] = useState<string>()
  useEffect(() => {
    if (!enabled) return
    const timer = setTimeout(() => setDebouncedIdentity(identity), document === undefined ? 0 : 500)
    return () => clearTimeout(timer)
  }, [identity, enabled, document === undefined])
  const draftVersion = detail.clinicalDocument?.draft?.version ?? 0
  const queryKey = ['document-quality', scope, detail.caseId, request.clientId, request.revision] as const
  const matches = (incoming: ClinicalDocumentQualityControlState) => incoming.caseId === detail.caseId
    && incoming.encounterId === detail.encounter.id && incoming.draftVersion === draftVersion
    && (document === undefined ? incoming.clientId === undefined
      && (initialState === undefined || incoming.documentFingerprint === initialState.documentFingerprint)
      : incoming.clientId === request.clientId && incoming.clientRevision === request.revision)
  const query = useQuery({
    queryKey, retry: false, refetchOnWindowFocus: false,
    enabled: enabled && debouncedIdentity === identity,
    ...(initialState === undefined ? {} : { initialData: initialState }),
    queryFn: async ({ signal }) => {
      const previous = client.getQueryData<ClinicalDocumentQualityControlState>(queryKey)
      const check = previous === undefined || previous.stale || previous.status === 'idle' || request.refresh
      const refresh = request.refresh || previous?.stale === true
      request.refresh = false
      const incoming = check ? await checkClinicalDocumentQuality({ caseId: detail.caseId,
        encounterId: detail.encounter.id, encounterVersion: detail.encounter.versionId, expectedDraftVersion: draftVersion,
        ...(document === undefined ? {} : { document, clientId: request.clientId, clientRevision: request.revision }),
        refresh }, signal) : await getClinicalDocumentQuality(detail.caseId, document === undefined ? undefined : request.clientId, signal)
      if (!matches(incoming)) throw new Error('DOCUMENT_QUALITY_INPUT_CHANGED')
      return currentGeneration(client.getQueryData<ClinicalDocumentQualityControlState>(queryKey), incoming)
    },
    refetchInterval: query => query.state.error === null ? 1_500 : false,
  })
  const retention = useMutation({
    mutationFn: async ({ issueId, reason, state, idempotencyKey }: {
      issueId: string; reason: string; state: ClinicalDocumentQualityControlState; identity: string; idempotencyKey: string;
    }) => {
      await client.cancelQueries({ queryKey, exact: true })
      const latest = await getClinicalDocumentQuality(detail.caseId, state.clientId)
      if (!matches(latest) || latest.stale || latest.inputFingerprint !== state.inputFingerprint) {
        throw new Error('DOCUMENT_QUALITY_INPUT_CHANGED')
      }
      if (latest.issues.find(issue => issue.id === issueId)?.status !== 'open') return latest
      return retainClinicalDocumentQualityIssue({ caseId: detail.caseId, encounterId: detail.encounter.id,
        encounterVersion: detail.encounter.versionId, expectedInputFingerprint: state.inputFingerprint,
        issueId, ...(state.clientId === undefined ? {} : { clientId: state.clientId }), ...(reason.trim() ? { reason: reason.trim() } : {}) }, idempotencyKey)
    },
    onSuccess: async (incoming, variables) => {
      if (view.current?.identity !== variables.identity || !matches(incoming)) return
      await client.cancelQueries({ queryKey, exact: true })
      if (view.current?.identity !== variables.identity) return
      client.setQueryData<ClinicalDocumentQualityControlState>(queryKey, previous => currentGeneration(previous, incoming))
    },
  })
  const state = query.data !== undefined && matches(query.data) ? query.data : undefined
  const stale = state?.stale === true || query.error?.message === 'DOCUMENT_QUALITY_INPUT_CHANGED'
    || retention.variables?.identity === identity && retention.error?.message === 'DOCUMENT_QUALITY_INPUT_CHANGED'
  return {
    state, stale, error: query.error,
    retentionError: retention.variables?.identity === identity ? retention.error : null,
    retainedIssueId: retention.variables?.identity === identity ? retention.variables.issueId : undefined,
    pending: enabled && (debouncedIdentity !== identity || query.isPending || query.isFetching && state === undefined),
    retaining: retention.isPending && retention.variables?.identity === identity,
    retry: () => { retention.reset(); request.refresh = true; void query.refetch() },
    retain: (issueId: string, reason: string) => {
      if (state === undefined || stale || query.isError) return
      const intent = JSON.stringify([scope, detail.caseId, detail.encounter.versionId, state.clientId, state.inputFingerprint, issueId, reason.trim()])
      const idempotencyKey = retentionKeys.current.get(intent) ?? newIdempotencyKey()
      retentionKeys.current.set(intent, idempotencyKey)
      retention.mutate({ issueId, reason, state, identity, idempotencyKey })
    },
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

function openIssues(quality: DocumentQualityControl) {
  return quality.stale || quality.error !== null ? [] : quality.state?.issues.filter(issue => issue.status === 'open') ?? []
}

function shortIssue(issue: QualityIssue, messages: Messages, locale: WorkspaceLocale) {
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
    <DocumentQualityStatus quality={quality} messages={messages} />
    {fields.map(field => <DocumentQualityFieldIssues field={field} key={field} locale={locale} messages={messages}
      onLocateIssue={onLocateIssue} quality={quality} />)}
  </div>
}

export function DocumentQualityStatus({ quality, messages }: {
  quality: DocumentQualityControl; messages: Messages
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
        {quality.state?.notices.map(notice => <p key={notice}>{notice}</p>)}
        <Button disabled={quality.pending} onClick={quality.retry} size="sm" type="button" variant="outline">
          {messages.documentQualityRetry}
        </Button>
      </AlertDescription>
    </Alert>
  </section>
}

function Issue({ issue, quality, messages, locale, onLocateIssue }: {
  issue: QualityIssue; quality: DocumentQualityControl; messages: Messages; locale: WorkspaceLocale
  onLocateIssue?: ((issue: QualityIssue) => void) | undefined
}) {
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const [retaining, setRetaining] = useState(false)
  const [reason, setReason] = useState('')
  const id = useId()
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
    {quality.retainedIssueId !== issue.id || quality.retentionError === null ? null
      : <p role="alert">{messages.documentQualityRetainFailed}</p>}
    <div className="flex flex-wrap gap-2">
      {onLocateIssue === undefined || issue.status !== 'open' ? null : <Button onClick={() => onLocateIssue(issue)} size="sm" type="button" variant="outline">
        {locale === 'zh-CN' ? '查看位置' : 'Go to field'}
      </Button>}
      <Button aria-controls={`${id}-evidence`} aria-expanded={evidenceOpen} onClick={() => setEvidenceOpen(open => !open)} size="sm" type="button" variant="ghost">
        {evidenceOpen ? messages.documentQualityHideEvidence : messages.documentQualityViewEvidence}
      </Button>
      {issue.status !== 'open' ? null : <Button disabled={quality.stale || quality.error !== null || quality.retaining}
        onClick={() => setRetaining(open => !open)} size="sm" type="button" variant="outline">{locale === 'zh-CN' ? '已核实，保留原文' : messages.documentQualityRetain}</Button>}
    </div>
    {!evidenceOpen ? null : <div className="flex min-w-0 flex-col gap-2 rounded-md bg-muted p-3" id={`${id}-evidence`}>
      <p className="whitespace-pre-wrap break-words">{issue.basis.kind === 'official' ? messages.documentQualityOfficialBasis : messages.documentQualityProjectBasis}：{' '}
        {issue.basis.url !== undefined && /^https?:\/\//.test(issue.basis.url)
          ? <a className="underline" href={issue.basis.url} rel="noreferrer" target="_blank">{issue.basis.label}</a> : issue.basis.label}
        {issue.basis.locator ? ` · ${issue.basis.locator}` : ''}</p>
      {issue.evidence.map((evidence, index) => <blockquote className="flex min-w-0 flex-col gap-1 whitespace-pre-wrap break-words border-s-2 ps-3" key={`${evidence.id}:${index}`}>
        <p className="text-xs text-muted-foreground">{evidence.label}
          {evidence.recordedAt ? ` · ${formatClinicalDateTime(evidence.recordedAt, locale)}` : ''}
          {evidence.reference ? ` · ${evidence.reference}` : ''}</p>
        <p>{evidence.text}</p>
      </blockquote>)}
    </div>}
    {!retaining || issue.status !== 'open' ? null : <div className="flex flex-col gap-2">
      <Field>
        <FieldLabel htmlFor={`${id}-reason`}>{messages.documentQualityRetainReason}</FieldLabel>
        <Textarea id={`${id}-reason`} maxLength={1_000} onChange={event => setReason(event.currentTarget.value)} value={reason} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button disabled={quality.stale || quality.error !== null || quality.retaining} onClick={() => quality.retain(issue.id, reason)} size="sm" type="button">
          {messages.documentQualityConfirmRetain}
        </Button>
        <Button onClick={() => setRetaining(false)} size="sm" type="button" variant="ghost">{messages.cancel}</Button>
      </div>
    </div>}
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
      <Issue issue={issue} key={`${issue.id}:${issue.relatedFingerprint}`} quality={quality} messages={messages} locale={locale} onLocateIssue={onLocateIssue} />)}</ul>
    {retained.length === 0 ? null : <details>
      <summary className="cursor-pointer text-xs text-muted-foreground">{messages.documentQualityRetainedHistory} ({retained.length})</summary>
      <ul className="mt-2 flex min-w-0 flex-col gap-3">{retained.map(issue => <Issue issue={issue} key={issue.id} quality={quality} messages={messages} locale={locale} />)}</ul>
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
