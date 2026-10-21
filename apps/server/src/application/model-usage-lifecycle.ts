import type { ModelUsageContext, ModelUsageOutcome } from '@clinmesh/contracts/model-usage'

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
  }, reserve?: () => void): string
  settle(attemptId: string, outcome: ModelUsageOutcome): void
}
