import {
  type OutboxClaim,
  type OutboxCompletion,
  type OutboxEventView,
  OutboxRepository,
} from '../infrastructure/sqlite/outbox-repository.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'

export interface OutboxHandlerInput {
  attempt: number
  correlationId: string
  epoch: string
  eventId: string
  payload: unknown
  scenarioRunId: string
  workspaceId: string
}

export interface OutboxHandlerResult {
  status: OutboxCompletion
}

export type OutboxHandler = (input: OutboxHandlerInput) => Promise<OutboxHandlerResult>

interface OutboxDispatcherOptions {
  handlers: Record<string, OutboxHandler>
  leaseDurationMs: number
  leaseOwner: string
  maxAttempts?: number
  maxRetryDelayMs?: number
  now?: () => Date
  retryDelayMs?: number
}

export class OutboxDispatcher {
  readonly #handlers: Record<string, OutboxHandler>
  readonly #leaseDurationMs: number
  readonly #leaseOwner: string
  readonly #maxAttempts: number
  readonly #maxRetryDelayMs: number
  readonly #now: () => Date
  readonly #outbox: OutboxRepository
  readonly #retryDelayMs: number

  constructor(database: ClinMeshDatabase, options: OutboxDispatcherOptions) {
    this.#handlers = options.handlers
    this.#leaseDurationMs = options.leaseDurationMs
    this.#leaseOwner = options.leaseOwner
    this.#maxAttempts = options.maxAttempts ?? 3
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000
    this.#now = options.now ?? (() => new Date())
    this.#outbox = new OutboxRepository(database)
    this.#retryDelayMs = options.retryDelayMs ?? 1_000
  }

  claimNext(): OutboxClaim | undefined {
    return this.#outbox.claimNext({
      leaseDurationMs: this.#leaseDurationMs,
      leaseOwner: this.#leaseOwner,
      now: this.#now(),
    })
  }

  async dispatchOnce(): Promise<OutboxEventView | undefined> {
    const claim = this.claimNext()
    if (claim === undefined) return undefined
    const handler = this.#handlers[claim.kind]
    const completion = handler === undefined
      ? { status: 'retryable-failed' as const }
      : await handler({
          attempt: claim.attempt,
          correlationId: claim.correlationId,
          epoch: claim.epoch,
          eventId: claim.eventId,
          payload: claim.payload,
          scenarioRunId: claim.scenarioRunId,
          workspaceId: claim.workspaceId,
        }).catch(() => ({ status: 'retryable-failed' as const }))
    return this.#outbox.complete(claim, completion.status, {
      maxRetryDelayMs: this.#maxRetryDelayMs,
      maxAttempts: this.#maxAttempts,
      now: this.#now(),
      retryDelayMs: this.#retryDelayMs,
    })
  }
}
