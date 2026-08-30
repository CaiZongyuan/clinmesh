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
  decision: Promise<AgentReviewResult>
  kind: 'clinmesh-agent-review'
}

export interface AgentReviewRequest {
  confirmLabel: string
  description: string
  onConfirm(): unknown | Promise<unknown>
  signal: AbortSignal
  title: string
}

interface PendingReview extends AgentReviewRequest {
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
  request: () => reviewTask(Promise.reject(new Error('ClinMesh Agent review is unavailable'))),
}

export function AgentReviewProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [pending, setPending] = useState<PendingReview>()
  const pendingRef = useRef(pending)
  const [confirming, setConfirming] = useState(false)
  pendingRef.current = pending

  useEffect(() => () => {
    pendingRef.current?.reject(new Error('ClinMesh Agent review was closed'))
  }, [])

  const controller = useMemo<AgentReviewController>(() => ({
    cancel(reason) {
      const review = pendingRef.current
      if (review === undefined) return
      setPending(undefined)
      review.reject(new Error(reason))
    },
    request(input) {
      if (pendingRef.current !== undefined) {
        return reviewTask(Promise.reject(new Error('Another ClinMesh Agent review is pending')))
      }
      return reviewTask(new Promise((resolve, reject) => {
        const review: PendingReview = { ...input, reject, resolve }
        const onAbort = (): void => {
          if (pendingRef.current !== review) return
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
        setPending(review)
      }))
    },
  }), [])

  const reject = (): void => {
    const review = pendingRef.current
    if (review === undefined || confirming) return
    setPending(undefined)
    review.resolve({ approved: false })
  }
  const confirm = async (): Promise<void> => {
    const review = pendingRef.current
    if (review === undefined || confirming) return
    setConfirming(true)
    try {
      const data = await review.onConfirm()
      setPending(undefined)
      review.resolve({ approved: true, data })
    } catch (error) {
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
        if (!open) reject()
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            <AlertDialogDescription>{pending?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirming} onClick={reject}>取消</AlertDialogCancel>
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
}

function reviewTask(decision: Promise<AgentReviewResult>): AgentReviewTask {
  return { decision, kind: 'clinmesh-agent-review' }
}
