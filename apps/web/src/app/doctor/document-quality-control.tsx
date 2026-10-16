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

type QualityIssue = ClinicalDocumentQualityControlState['issues'][number]
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

function Issue({ issue, quality, messages, locale }: {
  issue: QualityIssue; quality: DocumentQualityControl; messages: Messages; locale: WorkspaceLocale
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
    {issue.review === undefined ? null : <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
      {issue.review.actorId} · {formatClinicalDateTime(issue.review.reviewedAt, locale)}
      {issue.review.reason ? ` · ${issue.review.reason}` : ''}
    </p>}
    {quality.retainedIssueId !== issue.id || quality.retentionError === null ? null
      : <p role="alert">{messages.documentQualityRetainFailed}</p>}
    <div className="flex flex-wrap gap-2">
      <Button aria-controls={`${id}-evidence`} aria-expanded={evidenceOpen} onClick={() => setEvidenceOpen(open => !open)} size="sm" type="button" variant="ghost">
        {evidenceOpen ? messages.documentQualityHideEvidence : messages.documentQualityViewEvidence}
      </Button>
      {issue.status !== 'open' ? null : <Button disabled={quality.stale || quality.error !== null || quality.retaining}
        onClick={() => setRetaining(open => !open)} size="sm" type="button" variant="outline">{messages.documentQualityRetain}</Button>}
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

export function DocumentQualityFieldIssues({ field, quality, messages, locale }: {
  field: keyof ClinicalDocumentContent; quality: DocumentQualityControl; messages: Messages; locale: WorkspaceLocale
}) {
  const issues = quality.stale || quality.error !== null ? [] : quality.state?.issues.filter(issue => issue.field === field) ?? []
  if (issues.length === 0) return null
  const retained = issues.filter(issue => issue.status === 'retained')
  return <section aria-label={`${messages[field]}${messages.documentQualityFieldSuffix}`} className="flex min-w-0 flex-col gap-2" data-document-quality-field={field}>
    <ul className="flex min-w-0 flex-col gap-3">{issues.filter(issue => issue.status === 'open').map(issue =>
      <Issue issue={issue} key={`${issue.id}:${issue.relatedFingerprint}`} quality={quality} messages={messages} locale={locale} />)}</ul>
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
  return <section aria-label={messages.documentQualitySignSummary} className="flex min-w-0 flex-col gap-3" data-document-quality-sign-summary>
    <DocumentQualityStatus quality={quality} messages={messages} />
    <p className="text-xs text-muted-foreground">{messages.documentQualityAdvisory}</p>
    {quality.stale || quality.error !== null ? null : <ul className="flex min-w-0 flex-col gap-3">{quality.state?.issues.filter(issue => issue.status === 'open').map(issue =>
      <li className="flex min-w-0 flex-col gap-1" key={issue.id}>
        <p className="text-xs font-medium">{messages[issue.field]}</p>
        <ul><Issue issue={issue} quality={quality} messages={messages} locale={locale} /></ul>
      </li>)}</ul>}
  </section>
}
