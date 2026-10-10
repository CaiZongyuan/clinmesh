import type { consultationSignReviewSchema } from '@clinmesh/contracts/his'
import type { z } from 'zod'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import type { getWorkspaceMessages } from '../workspace-i18n.ts'

export type ConsultationSignReview = z.infer<typeof consultationSignReviewSchema>

export function requiresConsultationReview(review: ConsultationSignReview | null | undefined): boolean {
  return review != null && (review.remainingCount > 0 || review.conflictCount > 0 || review.unreviewedCount > 0)
}

export function ConsultationSignReviewNotice({ review, messages }: {
  review: ConsultationSignReview | null | undefined
  messages: ReturnType<typeof getWorkspaceMessages>
}): React.JSX.Element | null {
  if (!requiresConsultationReview(review) || review == null) return null
  return <Alert data-consultation-sign-review="">
    <AlertTitle>{messages.consultationSignReviewTitle}</AlertTitle>
    <AlertDescription>
      <p>{messages.consultationRecordingRemaining} {review.remainingCount} · {messages.consultationSignFailed} {review.failedCount}</p>
      {review.paused && review.remainingCount > 0 ? <p>{messages.consultationSignPaused}</p> : null}
      <p>{messages.consultationSignConflicts} {review.conflictCount} · {messages.consultationSignUnreviewed} {review.unreviewedCount}</p>
      <p>{messages.consultationSignReviewDescription}</p>
    </AlertDescription>
  </Alert>
}
