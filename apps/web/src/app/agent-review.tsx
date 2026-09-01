import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@clinmesh/ui/components/alert-dialog'

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
  confirmLabel: string
  description: string
  onConfirm(): unknown | Promise<unknown>
  signal: AbortSignal
  title: string
}

interface PendingReview extends AgentReviewRequest {
  decisionGate: AgentReviewDecisionGateRef
  phase: 'pending' | 'gating' | 'executing' | 'settled'
  resolve(value: AgentReviewResult): void
  reject(error: Error): void
}

interface AgentReviewController {
  cancel(reason: string): void
  request(input: AgentReviewRequest): AgentReviewTask
}

const AgentReviewContext = createContext<AgentReviewController | null>(null)
const unavailableReviewController: AgentReviewController = {
  cancel() {},
  request: () => reviewTask(
    Promise.reject(new Error('ClinMesh Agent review is unavailable')),
    {},
  ),
}

export function AgentReviewProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [pending, setPending] = useState<PendingReview>()
  const pendingRef = useRef(pending)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => () => {
    const review = pendingRef.current
    if (review === undefined || review.phase !== 'pending') return
    review.phase = 'settled'
    review.reject(new Error('ClinMesh Agent review was closed'))
  }, [])

  const controller = useMemo<AgentReviewController>(() => ({
    cancel(reason) {
      const review = pendingRef.current
      if (review === undefined || review.phase !== 'pending') return
      review.phase = 'settled'
      pendingRef.current = undefined
      setPending(undefined)
      review.reject(new Error(reason))
    },
    request(input) {
      if (pendingRef.current !== undefined) {
        return reviewTask(
          Promise.reject(new Error('Another ClinMesh Agent review is pending')),
          {},
        )
      }
      const decisionGate: AgentReviewDecisionGateRef = {}
      return reviewTask(new Promise((resolve, reject) => {
        const review: PendingReview = {
          ...input,
          decisionGate,
          phase: 'pending',
          reject,
          resolve,
        }
        const onAbort = (): void => {
          if (pendingRef.current !== review || review.phase !== 'pending') return
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

  const reject = async (): Promise<void> => {
    const review = pendingRef.current
    if (review === undefined || review.phase !== 'pending') return
    review.phase = 'gating'
    setConfirming(true)
    try {
      await requireDecisionGate(review)('rejected')
      if (review.phase !== 'gating') return
      review.phase = 'settled'
      pendingRef.current = undefined
      setPending(undefined)
      review.resolve({ approved: false })
    } catch (error) {
      if (review.phase === 'settled') return
      review.phase = 'settled'
      pendingRef.current = undefined
      setPending(undefined)
      review.reject(error instanceof Error ? error : new Error('ClinMesh review decision failed'))
    } finally {
      setConfirming(false)
    }
  }
  const confirm = async (): Promise<void> => {
    const review = pendingRef.current
    if (review === undefined || review.phase !== 'pending') return
    review.phase = 'gating'
    setConfirming(true)
    try {
      await requireDecisionGate(review)('approved')
      if (review.phase !== 'gating') return
      if (review.signal.aborted) throw new Error('ClinMesh Agent review was cancelled')
      review.phase = 'executing'
      const data = await review.onConfirm()
      review.phase = 'settled'
      pendingRef.current = undefined
      setPending(undefined)
      review.resolve({
        approved: true,
        ...(data === undefined ? {} : { data }),
      })
    } catch (error) {
      if (review.phase === 'settled') return
      review.phase = 'settled'
      pendingRef.current = undefined
      setPending(undefined)
      review.reject(error instanceof Error ? error : new Error('ClinMesh review action failed'))
    } finally {
      setConfirming(false)
    }
  }

  return (
    <AgentReviewContext.Provider value={controller}>
      {children}
      <AlertDialog open={pending !== undefined} onOpenChange={open => {
        if (!open) void reject()
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            <AlertDialogDescription>{pending?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirming}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={confirming} onClick={() => void confirm()}>
              {pending?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AgentReviewContext.Provider>
  )
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
