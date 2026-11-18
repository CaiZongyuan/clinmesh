import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  clinicalOverrideInputSchema,
  type ClinicalOverrideInput,
  type ClinicalOverrideReason,
  type ClinicalQualityAlertCode,
  type ClinicalQualityCheck,
} from '@clinmesh/contracts/clinical-quality'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { ClinicalOverrideFields, extractClinicalQualityError, QualityFindingList } from './clinical-quality-banner.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'

export interface AgentReviewResult {
  approved: boolean
  data?: unknown
}

export interface AgentReviewTask {
  bindDecisionGate(gate: AgentReviewDecisionGate): void
  decision: Promise<AgentReviewResult>
  kind: 'clinmesh-agent-review'
}

export type AgentReviewDecision = 'approved' | 'rejected'
export type AgentReviewDecisionGate = (decision: AgentReviewDecision) => Promise<void>

interface AgentReviewDecisionGateRef {
  current?: AgentReviewDecisionGate
}

export interface AgentReviewRequest {
  allowClinicalOverride?: boolean | undefined
  anchor?: string
  clinicalOverride?: ClinicalOverrideInput | undefined
  content?: ReactNode | ((locale: WorkspaceLocale) => ReactNode)
  confirmationLabel?: ReviewText
  confirmLabel: ReviewText
  description: ReviewText
  onConfirm(acknowledged: boolean, clinicalOverride?: ClinicalOverrideInput): unknown | Promise<unknown>
  signal: AbortSignal
  title: ReviewText
}

type ReviewText = string | ((locale: WorkspaceLocale) => string)

function reviewText(text: ReviewText | undefined, locale: WorkspaceLocale): string | undefined {
  return typeof text === 'function' ? text(locale) : text
}

interface PendingReview extends AgentReviewRequest {
  approvedError?: Error | undefined
  decisionApproved: boolean
  returnFocus: HTMLElement | null
  decisionGate: AgentReviewDecisionGateRef
  restoreFocus: boolean
  phase: 'pending' | 'gating' | 'executing' | 'settled'
  resolve(value: AgentReviewResult): void
  reject(error: Error): void
}

interface AgentReviewController {
  cancel(reason: string): void
  request(input: AgentReviewRequest): AgentReviewTask
}

const AgentReviewContext = createContext<AgentReviewController | null>(null)
const ReviewLocationContext = createContext<{
  pending: boolean
  title: string | undefined
  registerAnchor(id: string, element: HTMLElement | null): void
  registerOutlet(element: HTMLElement | null): void
} | null>(null)
const unavailableReviewController: AgentReviewController = {
  cancel() {},
  request: () => reviewTask(
    Promise.reject(new Error('ClinMesh Agent review is unavailable')),
    {},
  ),
}

const emptyOverride: {
  alert?: ClinicalQualityCheck | undefined
  codes: ClinicalQualityAlertCode[]
  note: string
  reason: ClinicalOverrideReason | null
} = { codes: [], note: '', reason: null }

export function AgentReviewProvider({ children, locale = 'zh-CN' }: { children: ReactNode; locale?: WorkspaceLocale }): React.JSX.Element {
  const [pending, setPending] = useState<PendingReview>()
  const pendingRef = useRef(pending)
  const [confirming, setConfirming] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [override, setOverride] = useState(emptyOverride)
  const [anchors, setAnchors] = useState<Record<string, HTMLElement>>({})
  const [outlet, setOutlet] = useState<HTMLElement | null>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const previousReview = useRef<PendingReview | undefined>(undefined)
  const reviewId = useId()
  const registerAnchor = useCallback((id: string, element: HTMLElement | null) => {
    setAnchors(previous => {
      if (previous[id] === element || element === null && previous[id] === undefined) return previous
      const next = { ...previous }
      if (element === null) delete next[id]
      else next[id] = element
      return next
    })
  }, [])
  const locations = useMemo(() => ({ pending: pending !== undefined, title: reviewText(pending?.title, locale), registerAnchor, registerOutlet: setOutlet }), [pending, locale, registerAnchor])
  const target = pending?.anchor === undefined ? outlet : anchors[pending.anchor] ?? outlet

  useLayoutEffect(() => {
    if (pending === undefined) {
      const previous = previousReview.current
      const original = previous?.returnFocus
      if (previous?.restoreFocus && original?.isConnected) original.focus({ preventScroll: true })
      previousReview.current = undefined
      return
    }
    previousReview.current = pending
    confirmButton.current?.focus({ preventScroll: true })
    confirmButton.current?.scrollIntoView?.({ block: 'nearest' })
  }, [pending, target])

  useEffect(() => () => {
    const review = pendingRef.current
    if (review === undefined || review.phase !== 'pending') return
    review.phase = 'settled'
    review.reject(new Error('ClinMesh Agent review was closed'))
  }, [])

  const controller = useMemo<AgentReviewController>(() => ({
    cancel(reason) {
      const review = pendingRef.current
      if (review === undefined) return
      review.restoreFocus = false
      if (review.phase !== 'pending') return
      review.phase = 'settled'
      pendingRef.current = undefined
      setPending(undefined)
      review.reject(new Error(reason))
    },
    request(input) {
      if (input.signal.aborted) {
        return reviewTask(Promise.reject(new Error('ClinMesh Agent review was cancelled')), {})
      }
      if (pendingRef.current !== undefined) {
        return reviewTask(
          Promise.reject(new Error('Another ClinMesh Agent review is pending')),
          {},
        )
      }
      setAcknowledged(false)
      setOverride({
        codes: input.clinicalOverride ? [...input.clinicalOverride.acknowledgedAlerts] : [],
        note: input.clinicalOverride?.note ?? '',
        reason: input.clinicalOverride?.reasonCode ?? null,
      })
      const decisionGate: AgentReviewDecisionGateRef = {}
      return reviewTask(new Promise((resolve, reject) => {
        const review: PendingReview = {
          ...input,
          decisionApproved: false,
          returnFocus: activeElement(),
          restoreFocus: true,
          decisionGate,
          phase: 'pending',
          reject,
          resolve,
        }
        const onAbort = (): void => {
          if (pendingRef.current !== review) return
          review.restoreFocus = false
          if (review.phase !== 'pending') return
          review.phase = 'settled'
          pendingRef.current = undefined
          setPending(undefined)
          reject(new Error('ClinMesh Agent review was cancelled'))
        }
        input.signal.addEventListener('abort', onAbort, { once: true })
        const settleResolve = review.resolve
        const settleReject = review.reject
        review.resolve = value => {
          input.signal.removeEventListener('abort', onAbort)
          settleResolve(value)
        }
        review.reject = error => {
          input.signal.removeEventListener('abort', onAbort)
          settleReject(error)
        }
        pendingRef.current = review
        setPending(review)
      }), decisionGate)
    },
  }), [])

  const overrideActive = pending !== undefined && (pending.clinicalOverride !== undefined || override.alert !== undefined)
  const parsedOverride = overrideActive
    ? clinicalOverrideInputSchema.safeParse({
        acknowledgedAlerts: override.codes,
        note: override.note,
        reasonCode: override.reason,
      })
    : undefined

  const reject = async (): Promise<void> => {
    const review = pendingRef.current
    if (review === undefined || review.phase !== 'pending') return
    if (review.decisionApproved) {
      review.phase = 'settled'
      pendingRef.current = undefined
      setPending(undefined)
      setOverride(emptyOverride)
      review.reject(review.approvedError ?? new Error('ClinMesh Agent review clinical quality alert was not overridden'))
      return
    }
    review.phase = 'gating'
    setConfirming(true)
    try {
      await requireDecisionGate(review)('rejected')
      if (review.phase !== 'gating') return
      review.phase = 'settled'
      pendingRef.current = undefined
      setPending(undefined)
      setOverride(emptyOverride)
      review.resolve({ approved: false })
    } catch (error) {
      if (review.phase === 'settled') return
      review.phase = 'settled'
      pendingRef.current = undefined
      setPending(undefined)
      setOverride(emptyOverride)
      review.reject(error instanceof Error ? error : new Error('ClinMesh review decision failed'))
    } finally {
      setConfirming(false)
    }
  }
  const confirm = async (): Promise<void> => {
    const review = pendingRef.current
    if (review === undefined || review.phase !== 'pending') return
    if (review.confirmationLabel !== undefined && !acknowledged) return
    if (overrideActive && !parsedOverride?.success) return
    setConfirming(true)
    try {
      if (!review.decisionApproved) {
        review.phase = 'gating'
        await requireDecisionGate(review)('approved')
        if (review.phase !== 'gating') return
        review.decisionApproved = true
      }
      if (review.signal.aborted) throw new Error('ClinMesh Agent review was cancelled')
      review.phase = 'executing'
      const data = await review.onConfirm(acknowledged, parsedOverride?.success ? parsedOverride.data : undefined)
      review.phase = 'settled'
      pendingRef.current = undefined
      setPending(undefined)
      setOverride(emptyOverride)
      review.resolve({
        approved: true,
        ...(data === undefined ? {} : { data }),
      })
    } catch (error) {
      if (review.phase === 'settled') return
      const extracted = review.allowClinicalOverride === true ? extractClinicalQualityError(error) : undefined
      if (
        extracted !== undefined
        && extracted.code === 'CLINICAL_QUALITY_ALERT'
        && extracted.check.redLines.length === 0
        && extracted.check.alerts.length > 0
      ) {
        review.approvedError = error instanceof Error ? error : new Error(extracted.message)
        review.phase = 'pending'
        setOverride(prev => ({ ...prev, alert: extracted.check, codes: [...new Set(extracted.check.alerts.map(item => item.code))] }))
        return
      }
      review.phase = 'settled'
      pendingRef.current = undefined
      setPending(undefined)
      setOverride(emptyOverride)
      review.reject(error instanceof Error ? error : new Error('ClinMesh review action failed'))
    } finally {
      setConfirming(false)
    }
  }

  const review = pending === undefined ? null : <section role="region" aria-labelledby={`${reviewId}-title`}
    aria-describedby={`${reviewId}-description`} data-agent-review="" className="flex min-w-0 flex-col gap-3 border-t border-info bg-info/10 p-3 text-card-foreground"
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!confirming) void reject() }
    }}>
    <div className="flex min-w-0 flex-col gap-1">
      <h2 id={`${reviewId}-title`} className="text-sm font-semibold">{reviewText(pending.title, locale)}</h2>
      <p id={`${reviewId}-description`} className="text-sm">{reviewText(pending.description, locale)}</p>
      <p role="status" className="text-xs text-muted-foreground">
        {locale === 'zh-CN'
          ? confirming ? '正在处理人工决定' : '待人工确认；请在此确认本次操作'
          : confirming ? 'Processing human decision' : 'Awaiting human confirmation; confirm this action here'}
      </p>
    </div>
    {pending.content === undefined ? null : <div className="max-h-[40vh] overflow-y-auto">
      {typeof pending.content === 'function' ? pending.content(locale) : pending.content}
    </div>}
    {!overrideActive ? null : <div aria-label={locale === 'zh-CN' ? '临床质控确认说明' : 'Clinical quality override review'} className="flex min-w-0 flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-sm" data-agent-review-clinical-override="">
      {override.alert ? <QualityFindingList items={override.alert.alerts} /> : <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium">{locale === 'zh-CN' ? '智能体附带临床越权说明（请核对后确认）：' : 'Agent proposed clinical override (review before confirming):'}</span>
        {override.codes.map(c => <Badge key={c} variant="outline">{c}</Badge>)}
      </div>}
      <ClinicalOverrideFields disabled={confirming} id={reviewId} locale={locale} note={override.note} reason={override.reason} setNote={note => setOverride(p => ({ ...p, note }))} setReason={reason => setOverride(p => ({ ...p, reason }))} />
    </div>}
    {pending.confirmationLabel === undefined ? null : <Field orientation="horizontal">
      <Checkbox id={`${reviewId}-confirmation`} disabled={confirming} checked={acknowledged} onCheckedChange={setAcknowledged} />
      <FieldLabel htmlFor={`${reviewId}-confirmation`}>{reviewText(pending.confirmationLabel, locale)}</FieldLabel>
    </Field>}
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button disabled={confirming} variant="outline" onClick={() => void reject()}>{locale === 'zh-CN' ? '不采用' : 'Do not use'}</Button>
      <Button ref={confirmButton} disabled={confirming || (overrideActive && !parsedOverride?.success)}
        aria-disabled={pending.confirmationLabel !== undefined && !acknowledged}
        onClick={() => void confirm()}>{reviewText(pending.confirmLabel, locale)}</Button>
    </div>
  </section>

  return <AgentReviewContext.Provider value={controller}>
    <ReviewLocationContext.Provider value={locations}>
      {children}
      {review === null ? null : target === null ? <div className="sticky bottom-0 shrink-0" data-agent-review-fallback="">{review}</div> : createPortal(review, target)}
    </ReviewLocationContext.Provider>
  </AgentReviewContext.Provider>
}

export function AgentReviewAnchor({ id, children, className }: { id: string; children?: ReactNode; className?: string }) {
  const locations = useContext(ReviewLocationContext)
  const register = locations?.registerAnchor
  const ref = useCallback((element: HTMLDivElement | null) => register?.(id, element), [id, register])
  return <div className={className} data-agent-review-anchor={id}><div>{children}</div><div ref={ref} /></div>
}

export function AgentReviewOutlet() {
  const locations = useContext(ReviewLocationContext)
  return <div ref={locations?.registerOutlet} hidden={!locations?.pending} data-agent-review-outlet="" />
}

export function useAgentReviewPending(): boolean {
  return useContext(ReviewLocationContext)?.pending ?? false
}

/** 正在等人确认的助手审阅标题，供患者头部的「助手已准备」行使用；没有待确认审阅时为 undefined。 */
export function useAgentReviewTitle(): string | undefined {
  return useContext(ReviewLocationContext)?.title
}

function activeElement(): HTMLElement | null {
  let element = document.activeElement
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement
  return element instanceof HTMLElement ? element : null
}

export function useAgentReview(): AgentReviewController {
  return useContext(AgentReviewContext) ?? unavailableReviewController
}

export function isAgentReviewTask(value: unknown): value is AgentReviewTask {
  return typeof value === 'object'
    && value !== null
    && (value as { kind?: unknown }).kind === 'clinmesh-agent-review'
    && (value as { decision?: unknown }).decision instanceof Promise
    && typeof (value as { bindDecisionGate?: unknown }).bindDecisionGate === 'function'
}

function reviewTask(
  decision: Promise<AgentReviewResult>,
  decisionGate: AgentReviewDecisionGateRef,
): AgentReviewTask {
  return {
    bindDecisionGate(gate) {
      if (decisionGate.current !== undefined) {
        throw new Error('ClinMesh Agent review decision gate is already bound')
      }
      decisionGate.current = gate
    },
    decision,
    kind: 'clinmesh-agent-review',
  }
}

function requireDecisionGate(review: PendingReview): AgentReviewDecisionGate {
  if (review.decisionGate.current === undefined) {
    throw new Error('ClinMesh Agent review is not bound to an authorized proposal')
  }
  return review.decisionGate.current
}
