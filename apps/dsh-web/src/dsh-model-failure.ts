import type { LlmFailure } from '@deepseek-ai/dsh-llm'

/** SDK error finishes can wrap transport exceptions without a Provider response. */
export function isDefinitiveDshFailure(failure: LlmFailure): boolean {
  if (failure.code === 'TIMEOUT') return false
  if (['AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'RATE_LIMIT'].includes(failure.code)) return true
  const status = failure.status
  return status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599
    && status !== 408 && status !== 504
}
