import type { ModelTokenUsage, ModelUsageConfiguration, ModelUsageContext, ModelUsageOutcome, ModelUsageReservationBoundary } from '@clinmesh/contracts/model-usage'

export interface ModelUsageRecorder {
  /** Reservation and the existing task request gate commit or roll back together. */
  begin(input: {
    context: ModelUsageContext
    feature: string
    provider: string
    model: string
    reasoningEffort?: string
    outputLimit: number | null
    kind: 'initial' | 'format-repair' | 'rate-limit-retry'
    /** Trusted task state, read inside admission and consumed by the task reservation. */
    hasManualRetryAuthorization?: () => boolean
    reservationBoundary?: ModelUsageReservationBoundary
  }, reserve?: () => void): string
  /** Persist observed consumption without declaring the external request complete. */
  checkpoint(attemptId: string, usage: ModelTokenUsage, configuration?: ModelUsageConfiguration): void
  settle(attemptId: string, outcome: ModelUsageOutcome): void
}
