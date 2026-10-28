import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CommandExecutor } from '../src/application/command-executor.ts'
import { OutboxDispatcher } from '../src/application/outbox-dispatcher.ts'
import { ModelTaskRecovery } from '../src/application/model-task-recovery.ts'
import { ModelUsageControlError } from '../src/application/model-usage-control.ts'
import {
  applyMigrations,
  openClinMeshDatabase,
} from '../src/infrastructure/sqlite/database.ts'
import { FhirRepository } from '../src/infrastructure/sqlite/fhir-repository.ts'
import { OutboxRepository } from '../src/infrastructure/sqlite/outbox-repository.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'

describe('persistent outbox dispatcher', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
  })

  it('recovers an expired claim after restart without creating another event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-outbox-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'clinmesh.sqlite')
    const context = { epoch: 'epoch-001', workspaceId: 'workspace-001' }
    const firstDatabase = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    applyMigrations(firstDatabase)
    new WorkspaceRepository(firstDatabase).install({
      ...context,
      scenarioId: 'outpatient-fever-001',
      scenarioRunId: 'run-001',
      workspaceName: '合成医院工作区',
    })
    const executor = new CommandExecutor(firstDatabase, new FhirRepository(firstDatabase), {
      now: () => new Date('2026-08-24T01:00:00.000Z'),
    })
    executor.execute({
      context: {
        ...context,
        actorId: 'actor-cashier',
        roleCode: 'cashier',
        scenarioRunId: 'run-001',
      },
      dataSchema: z.object({ accepted: z.boolean() }),
      expectedVersions: {},
      idempotencyKey: 'payment-001',
      input: { paymentId: 'payment-001' },
      operation: 'billing.confirm-payment',
    }, transaction => {
      transaction.enqueue({
        dedupKey: 'lis-ready-payment-001',
        kind: 'lis-ready',
        payload: { serviceRequestId: 'service-request-001' },
      })
      return { data: { accepted: true }, effects: [] }
    })

    const firstDispatcher = new OutboxDispatcher(firstDatabase, {
      handlers: {},
      leaseDurationMs: 30_000,
      leaseOwner: 'worker-a',
      now: () => new Date('2026-08-24T01:00:01.000Z'),
    })
    const abandonedClaim = firstDispatcher.claimNext()
    expect(abandonedClaim).toMatchObject({ attempt: 1, kind: 'lis-ready', status: 'claimed' })
    firstDatabase.close()

    const handler = vi.fn(async () => ({ status: 'completed' as const }))
    const reopenedDatabase = openClinMeshDatabase({ databasePath, busyTimeoutMs: 5_000 })
    applyMigrations(reopenedDatabase)
    const recoveredDispatcher = new OutboxDispatcher(reopenedDatabase, {
      handlers: { 'lis-ready': handler },
      leaseDurationMs: 30_000,
      leaseOwner: 'worker-b',
      now: () => new Date('2026-08-24T01:00:32.000Z'),
    })

    expect(await recoveredDispatcher.dispatchOnce()).toMatchObject({
      attempt: 2,
      eventId: abandonedClaim?.eventId,
      status: 'completed',
    })
    expect(handler).toHaveBeenCalledOnce()
    expect(new OutboxRepository(reopenedDatabase).list(context)).toMatchObject([{
      attempt: 2,
      eventId: abandonedClaim?.eventId,
      status: 'completed',
    }])
    reopenedDatabase.close()
  })

  it('holds configuration waits across wakeups and policy changes until the runtime is replaced', async () => {
    const database = openClinMeshDatabase({ databasePath: ':memory:', busyTimeoutMs: 5_000 })
    try {
      applyMigrations(database)
      const context = { epoch: 'epoch-001', workspaceId: 'workspace-001' }
      new WorkspaceRepository(database).install({ ...context, scenarioId: 'outpatient-fever-001',
        scenarioRunId: 'run-001', workspaceName: '合成医院工作区' })
      new CommandExecutor(database, new FhirRepository(database)).execute({
        context: { ...context, actorId: 'actor-system', roleCode: 'system', scenarioRunId: 'run-001' },
        dataSchema: z.object({ accepted: z.boolean() }), expectedVersions: {}, idempotencyKey: 'configuration-wait',
        input: {}, operation: 'synthetic.configuration-wait',
      }, transaction => {
        transaction.enqueue({ dedupKey: 'configuration-wait', kind: 'configuration-wait', payload: {} })
        return { data: { accepted: true }, effects: [] }
      })
      let policy = 'original-policy', configured = false, dispatches = 0
      const control = { canDispatch: () => true, automaticRetries: () => true, recoveryState: () => policy }
      let recovery = new ModelTaskRecovery(database, control)
      const dispatcher = new OutboxDispatcher(database, {
        leaseDurationMs: 30_000, leaseOwner: 'synthetic-worker', handlers: {
          'configuration-wait': async event => {
            dispatches += 1
            return configured ? { status: 'completed' } : recovery.defer(event,
              new ModelUsageControlError('MODEL_METERING_UNAVAILABLE', 'workspace'), 'runtime-restart')!
          },
        },
      })
      const blocked = await dispatcher.dispatchOnce()
      expect(blocked).toMatchObject({ status: 'failed', attempt: 0 })
      for (const nextPolicy of ['original-policy', 'changed-policy']) {
        policy = nextPolicy
        recovery.wake()
        expect(await dispatcher.dispatchOnce()).toBeUndefined()
      }
      expect(dispatches).toBe(1)
      configured = true
      recovery = new ModelTaskRecovery(database, control)
      recovery.wake()
      expect(await dispatcher.dispatchOnce()).toMatchObject({ eventId: blocked!.eventId, status: 'completed', attempt: 1 })
      expect(dispatches).toBe(2)
      expect(new OutboxRepository(database).list(context)).toMatchObject([{ eventId: blocked!.eventId, status: 'completed' }])
    } finally { database.close() }
  })

  it('retries a transient failure and preserves an ambiguous completion without redelivery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-outbox-outcomes-'))
    temporaryDirectories.push(directory)
    const database = openClinMeshDatabase({
      databasePath: join(directory, 'clinmesh.sqlite'),
      busyTimeoutMs: 5_000,
    })
    applyMigrations(database)
    const context = { epoch: 'epoch-001', workspaceId: 'workspace-001' }
    new WorkspaceRepository(database).install({
      ...context,
      scenarioId: 'outpatient-fever-001',
      scenarioRunId: 'run-001',
      workspaceName: '合成医院工作区',
    })
    let now = new Date('2026-08-24T01:00:00.000Z')
    const executor = new CommandExecutor(database, new FhirRepository(database), { now: () => now })
    for (const [key, kind] of [['retry-001', 'retry'], ['ambiguous-001', 'ambiguous']] as const) {
      executor.execute({
        context: { ...context, actorId: 'actor-system', roleCode: 'system', scenarioRunId: 'run-001' },
        dataSchema: z.object({ accepted: z.boolean() }),
        expectedVersions: {},
        idempotencyKey: key,
        input: { key },
        operation: `enqueue.${kind}`,
      }, transaction => {
        transaction.enqueue({ dedupKey: key, kind, payload: { key } })
        return { data: { accepted: true }, effects: [] }
      })
    }
    let retryAttempts = 0
    const dispatcher = new OutboxDispatcher(database, {
      handlers: {
        ambiguous: async () => ({ status: 'ambiguous' }),
        retry: async () => ({ status: ++retryAttempts < 3 ? 'retryable-failed' : 'completed' }),
      },
      leaseDurationMs: 30_000,
      leaseOwner: 'worker-a',
      maxAttempts: 3,
      now: () => now,
      retryDelayMs: 1_000,
    })

    const initialResults = [await dispatcher.dispatchOnce(), await dispatcher.dispatchOnce()]
    expect(initialResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ attempt: 1, kind: 'ambiguous', status: 'ambiguous' }),
      expect.objectContaining({ attempt: 1, kind: 'retry', status: 'failed' }),
    ]))
    expect(await dispatcher.dispatchOnce()).toBeUndefined()
    now = new Date('2026-08-24T01:00:01.000Z')
    expect(await dispatcher.dispatchOnce()).toMatchObject({ attempt: 2, kind: 'retry', status: 'failed' })
    expect(await dispatcher.dispatchOnce()).toBeUndefined()
    now = new Date('2026-08-24T01:00:02.999Z')
    expect(await dispatcher.dispatchOnce()).toBeUndefined()
    now = new Date('2026-08-24T01:00:03.000Z')
    expect(await dispatcher.dispatchOnce()).toMatchObject({ attempt: 3, kind: 'retry', status: 'completed' })
    expect(retryAttempts).toBe(3)
    database.close()
  })

  it('returns abandoned when reset closes an event while its handler is in flight', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-outbox-reset-race-'))
    temporaryDirectories.push(directory)
    const database = openClinMeshDatabase({
      databasePath: join(directory, 'clinmesh.sqlite'),
      busyTimeoutMs: 5_000,
    })
    applyMigrations(database)
    const context = { epoch: 'epoch-001', workspaceId: 'workspace-001' }
    new WorkspaceRepository(database).install({
      ...context,
      scenarioId: 'outpatient-fever-001',
      scenarioRunId: 'run-001',
      workspaceName: '合成医院工作区',
    })
    const commandTime = new Date('2026-08-24T01:00:00.000Z')
    const executor = new CommandExecutor(database, new FhirRepository(database), {
      now: () => commandTime,
    })
    executor.execute({
      context: { ...context, actorId: 'actor-cashier', roleCode: 'cashier', scenarioRunId: 'run-001' },
      dataSchema: z.object({ accepted: z.boolean() }),
      expectedVersions: {},
      idempotencyKey: 'late-result-001',
      input: { serviceRequestId: 'service-request-001' },
      operation: 'billing.confirm-payment',
    }, transaction => {
      transaction.enqueue({
        dedupKey: 'late-result-001',
        kind: 'lis-ready',
        payload: { serviceRequestId: 'service-request-001' },
      })
      return { data: { accepted: true }, effects: [] }
    })
    let releaseHandler: (() => void) | undefined
    let markEntered: (() => void) | undefined
    const handlerEntered = new Promise<void>(resolve => { markEntered = resolve })
    const dispatcher = new OutboxDispatcher(database, {
      handlers: {
        'lis-ready': async () => {
          markEntered?.()
          await new Promise<void>(resolve => { releaseHandler = resolve })
          return { status: 'completed' }
        },
      },
      leaseDurationMs: 30_000,
      leaseOwner: 'worker-a',
      now: () => new Date('2026-08-24T01:00:00.000Z'),
    })
    const dispatch = dispatcher.dispatchOnce()
    await handlerEntered
    database.driver.prepare(`
      UPDATE outbox_event SET status = 'abandoned', lease_owner = NULL, leased_until = NULL
      WHERE workspace_id = ? AND epoch = ? AND status = 'claimed'
    `).run(context.workspaceId, context.epoch)
    database.driver.prepare(`
      UPDATE scenario_run SET status = 'closed' WHERE workspace_id = ? AND epoch = ?
    `).run(context.workspaceId, context.epoch)
    database.driver.prepare(`
      UPDATE workspace_epoch SET state = 'closed' WHERE workspace_id = ? AND epoch = ?
    `).run(context.workspaceId, context.epoch)
    releaseHandler?.()

    expect(await dispatch).toMatchObject({ kind: 'lis-ready', status: 'abandoned' })
    database.close()
  })
})
