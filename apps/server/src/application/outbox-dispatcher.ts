import {
  type OutboxClaim,
  type OutboxCompletion,
  type OutboxEventView,
  type OutboxFilter,
  OutboxRepository,
} from '../infrastructure/sqlite/outbox-repository.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { EnqueuedOutboxEvent } from './command-executor.ts'

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

  claimNext(filter: OutboxFilter = {}): OutboxClaim | undefined {
    return this.#outbox.claimNext({
      leaseDurationMs: this.#leaseDurationMs,
      leaseOwner: this.#leaseOwner,
      now: this.#now(),
      ...filter,
    })
  }

  nextDelayedAttemptAt(filter: OutboxFilter = {}): string | undefined {
    return this.#outbox.nextDelayedAttemptAt({
      now: this.#now(),
      ...filter,
    })
  }

  async dispatchOnce(filter: OutboxFilter = {}): Promise<OutboxEventView | undefined> {
    const claim = this.claimNext(filter)
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

export interface OutboxLane {
  readonly concurrency: number
  readonly filter: OutboxFilter
  readonly id: string
}

interface OutboxLaneSchedulerOptions {
  dispatcher: OutboxDispatcher
  lanes: readonly OutboxLane[]
  now?: () => Date
  onError: (error: unknown) => void
}

const maxTimerDelayMs = 2_147_483_647

/** 管理单进程 Outbox 各 lane 并发槽位、事件驱动即时唤醒与每 lane 单最早延迟定时器。 */
export class OutboxLaneScheduler {
  #closed = false
  readonly #delayedTimers = new Map<string, { count: number; dueAtMs: number; timer: ReturnType<typeof setTimeout> }>()
  readonly #dispatchCycles = new Map<string, Promise<number>>()
  readonly #dispatcher: OutboxDispatcher
  readonly #lanes: readonly OutboxLane[]
  readonly #now: () => Date
  readonly #onError: (error: unknown) => void
  readonly #pendingWake = new Map<string, number>()

  constructor(options: OutboxLaneSchedulerOptions) {
    this.#dispatcher = options.dispatcher
    this.#lanes = options.lanes
    this.#now = options.now ?? (() => new Date())
    this.#onError = options.onError
  }

  notifyEnqueued(events: readonly EnqueuedOutboxEvent[]): void {
    if (this.#closed) return
    const nowMs = this.#now().getTime()
    const immediateCounts = new Map<OutboxLane, number>()
    for (const event of events) {
      const lane = this.#laneForKind(event.kind)
      if (lane === undefined) continue
      const dueAtMs = Date.parse(event.nextAttemptAt)
      if (!Number.isFinite(dueAtMs) || dueAtMs <= nowMs) {
        immediateCounts.set(lane, (immediateCounts.get(lane) ?? 0) + 1)
      } else {
        this.#scheduleDelayedLane(lane, dueAtMs, 1)
      }
    }
    if (immediateCounts.size > 0) {
      queueMicrotask(() => {
        if (this.#closed) return
        for (const [lane, count] of immediateCounts) {
          this.#wakeLane(lane, count)
        }
      })
    }
  }

  wakeIdleSlots(): void {
    if (this.#closed) return
    for (const lane of this.#lanes) {
      for (let slot = 0; slot < lane.concurrency; slot += 1) {
        if (this.#dispatchCycles.has(`${lane.id}:${slot}`)) continue
        void this.#pumpSlot(lane, slot).catch(this.#onError)
      }
    }
  }

  async drainPending(): Promise<void> {
    for (let round = 0; !this.#closed && round < 100; round += 1) {
      const counts = await Promise.all(this.#lanes.map(lane => Promise.all(Array.from(
        { length: lane.concurrency },
        (_, slot) => this.#pumpSlot(lane, slot),
      ))))
      if (counts.every(lane => lane.every(count => count === 0))) break
    }
  }

  stop(): void {
    this.#closed = true
    for (const entry of this.#delayedTimers.values()) clearTimeout(entry.timer)
    this.#delayedTimers.clear()
    this.#pendingWake.clear()
  }

  whenIdle(): Promise<unknown> {
    return Promise.all(this.#dispatchCycles.values())
  }

  #laneForKind(kind: string): OutboxLane | undefined {
    return this.#lanes.find(lane => (
      (lane.filter.kinds === undefined || lane.filter.kinds.includes(kind))
      && (lane.filter.excludedKinds === undefined || !lane.filter.excludedKinds.includes(kind))
    ))
  }

  #consumePendingWake(laneId: string): void {
    const remaining = this.#pendingWake.get(laneId)
    if (remaining === undefined) return
    if (remaining <= 1) this.#pendingWake.delete(laneId)
    else this.#pendingWake.set(laneId, remaining - 1)
  }

  #pumpSlot(lane: OutboxLane, slot: number): Promise<number> {
    const key = `${lane.id}:${slot}`
    const running = this.#dispatchCycles.get(key)
    if (running !== undefined) return running
    const cycle = (async () => {
      let handled = 0
      while (!this.#closed && handled < 100) {
        this.#consumePendingWake(lane.id)
        if (await this.#dispatcher.dispatchOnce(lane.filter) === undefined) break
        handled += 1
      }
      return handled
    })().finally(() => {
      this.#dispatchCycles.delete(key)
      if (this.#closed) return
      const remaining = this.#pendingWake.get(lane.id)
      if (remaining !== undefined && remaining > 0) {
        this.#pendingWake.delete(lane.id)
        this.#wakeLane(lane, remaining)
      }
    })
    this.#dispatchCycles.set(key, cycle)
    return cycle
  }

  #wakeLane(lane: OutboxLane, count = 1): void {
    if (this.#closed) return
    const target = Math.max(1, Math.min(count, lane.concurrency))
    let started = 0
    for (let slot = 0; slot < lane.concurrency && started < target; slot += 1) {
      if (this.#dispatchCycles.has(`${lane.id}:${slot}`)) continue
      started += 1
      void this.#pumpSlot(lane, slot).catch(this.#onError)
    }
    const deficit = target - started
    if (deficit > 0) {
      const current = this.#pendingWake.get(lane.id) ?? 0
      this.#pendingWake.set(lane.id, Math.min(lane.concurrency, current + deficit))
    }
  }

  #scheduleDelayedLane(lane: OutboxLane, dueAtMs: number, count = 1): void {
    if (this.#closed) return
    const existing = this.#delayedTimers.get(lane.id)
    if (existing !== undefined) {
      if (dueAtMs > existing.dueAtMs) return
      if (dueAtMs === existing.dueAtMs) {
        existing.count = Math.min(lane.concurrency, existing.count + count)
        return
      }
      clearTimeout(existing.timer)
      this.#delayedTimers.delete(lane.id)
    }
    const delayMs = Math.max(1, Math.min(dueAtMs - this.#now().getTime(), maxTimerDelayMs))
    const timer = setTimeout(() => {
      const current = this.#delayedTimers.get(lane.id)
      if (current?.timer !== timer) return
      this.#delayedTimers.delete(lane.id)
      if (this.#closed) return
      const remainingMs = dueAtMs - this.#now().getTime()
      if (remainingMs > 0) {
        this.#scheduleDelayedLane(lane, dueAtMs, current.count)
        return
      }
      try {
        const nextAttemptAt = this.#dispatcher.nextDelayedAttemptAt(lane.filter)
        if (nextAttemptAt !== undefined) {
          const nextDueAtMs = Date.parse(nextAttemptAt)
          if (Number.isFinite(nextDueAtMs)) this.#scheduleDelayedLane(lane, nextDueAtMs, 1)
        }
      } catch (error) {
        this.#onError(error)
      }
      this.#wakeLane(lane, current.count)
    }, delayMs)
    this.#delayedTimers.set(lane.id, { count, dueAtMs, timer })
  }
}
