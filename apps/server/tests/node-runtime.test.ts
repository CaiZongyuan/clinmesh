import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { healthResponseSchema } from '@clinmesh/contracts/health'
import {
  doctorCaseDetailSchema,
  examinationRequestDraftResponseSchema,
  issueExaminationRequestResponseSchema,
  sessionContextSchema,
} from '@clinmesh/contracts/his'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { OutboxRepository } from '../src/infrastructure/sqlite/outbox-repository.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { startServer } from '../src/server.ts'
import {
  acuteBronchitis,
  caseBundle,
  createImagingRuntime,
  generateCase,
  mutation,
  signIn,
  startConsultation,
} from './fixtures/imaging-scenario.ts'
import { satisfyOutpatientOrderPrerequisites } from './fixtures/outpatient-order-gate.ts'
import { payOutpatientInvestigation } from './fixtures/pay-outpatient-investigation.ts'

describe('Node.js runtime', () => {
  it('keeps idle lanes moving without accumulating timer waiters behind a slow lane', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-runtime-dispatch-timer-'))
    vi.useFakeTimers()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://127.0.0.1', authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: `Test-${randomUUID()}-Aa1!`, migrationMode: 'apply', trustedOrigins: ['http://127.0.0.1'],
      autoDispatchIntervalMs: 10,
    })
    let checks = 0
    const dispatch = vi.spyOn(runtime.dispatcher, 'dispatchOnce').mockImplementation(async filter => {
      if (filter?.kinds?.includes('doctor.generate-recommendations') && checks++ < 1) {
        await held
        return { attempt: 1, correlationId: 'synthetic-correlation', dedupKey: randomUUID(), epoch: 'synthetic-epoch', eventId: randomUUID(),
          kind: 'doctor.generate-recommendations', payload: {}, scenarioRunId: 'synthetic-run', workspaceId: 'synthetic-workspace',
          status: 'completed' }
      }
      return undefined
    })
    try {
      await vi.advanceTimersByTimeAsync(500)
      expect(checks).toBe(1)
      expect(dispatch.mock.calls.filter(([filter]) => filter?.kinds?.includes('consultation.record-history')).length).toBeGreaterThan(10)
      const before = dispatch.mock.calls.length
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(dispatch.mock.calls.length - before).toBeLessThanOrEqual(1)
    } finally {
      release()
      await runtime.close()
      vi.useRealTimers()
      await rm(directory, { recursive: true })
    }
  })

  it('serves the Hono application over a real HTTP listener', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-node-runtime-'))
    const webRoot = join(directory, 'web')
    await mkdir(webRoot)
    await writeFile(join(webRoot, 'index.html'), '<main>ClinMesh runtime</main>', 'utf8')
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://127.0.0.1',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://127.0.0.1'],
      webRoot,
    })
    const server = startServer({ app: runtime.app, hostname: '127.0.0.1', port: 0 })

    try {
      await new Promise<void>((resolve) => server.once('listening', resolve))
      const address = server.address() as AddressInfo
      const response = await fetch(`http://127.0.0.1:${address.port}/api/health`)

      expect(response.status).toBe(200)
      expect(healthResponseSchema.parse(await response.json())).toEqual({
        fhirVersion: '5.0.0',
        service: 'clinmesh-server',
        status: 'ok',
      })
      const signIn = await fetch(`http://127.0.0.1:${address.port}/api/auth/sign-in/email`, {
        body: JSON.stringify({ email: 'registrar@demo.clinmesh.local', password }),
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1' },
        method: 'POST',
      })
      expect(signIn.status).toBe(200)
      const cookie = signIn.headers.getSetCookie()[0]?.split(';', 1)[0]
      const session = await fetch(`http://127.0.0.1:${address.port}/api/auth/context`, {
        headers: { cookie: cookie ?? '' },
      })
      expect(session.status).toBe(200)
      expect(sessionContextSchema.parse(await session.json())).toMatchObject({ actor: { roleCode: 'registrar' } })
      expect(await (await fetch(`http://127.0.0.1:${address.port}/registration`)).text())
        .toContain('ClinMesh runtime')
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error))
      })
      await runtime.close()
      await rm(directory, { recursive: true })
    }
  }, 15_000)

  it('waits for an in-flight dispatch cycle before closing SQLite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-runtime-close-'))
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://127.0.0.1',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: `Test-${randomUUID()}-Aa1!`,
      migrationMode: 'apply',
      trustedOrigins: ['http://127.0.0.1'],
    })
    let releaseDispatch: (() => void) | undefined
    const held = new Promise<void>(release => { releaseDispatch = release })
    const dispatchEntered = new Promise<void>(resolve => {
      vi.spyOn(runtime.dispatcher, 'dispatchOnce').mockImplementation(async () => {
        resolve()
        await held
        return undefined
      })
    })
    const dispatch = runtime.dispatchPending()
    await dispatchEntered
    let closeFinished = false
    const close = Promise.resolve(runtime.close()).then(() => { closeFinished = true })
    await Promise.resolve()

    expect(closeFinished).toBe(false)
    releaseDispatch?.()
    await Promise.all([dispatch, close])
    expect(() => runtime.database.diagnostics()).toThrow()
    await rm(directory, { recursive: true })
  })

  it('wakes the matching lane within 50ms on commit and ignores rollbacks and idempotent replays', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-runtime-immediate-wake-'))
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://127.0.0.1',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      autoDispatchIntervalMs: 60_000,
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: `Test-${randomUUID()}-Aa1!`,
      migrationMode: 'apply',
      trustedOrigins: ['http://127.0.0.1'],
    })
    try {
      const context = {
        actorId: 'actor-system',
        epoch: 'epoch-1',
        roleCode: 'system',
        scenarioRunId: 'scenario-run-1',
        workspaceId: 'workspace-demo',
      }
      const originalDispatchOnce = runtime.dispatcher.dispatchOnce.bind(runtime.dispatcher)
      let enteredAt: number | undefined
      let resolveCompleted!: () => void
      const completed = new Promise<void>(resolve => { resolveCompleted = resolve })
      const dispatchSpy = vi.spyOn(runtime.dispatcher, 'dispatchOnce').mockImplementation(async filter => {
        const started = performance.now()
        const result = await originalDispatchOnce(filter)
        if (result?.kind === 'pharmacy.ready') {
          enteredAt ??= started
          resolveCompleted()
        }
        return result
      })

      const executeImmediate = () => runtime.commands.execute({
        context,
        dataSchema: z.object({ ok: z.boolean() }),
        expectedVersions: {},
        idempotencyKey: 'immediate-wake-001',
        input: { prescriptionId: 'rx-1' },
        operation: 'outbox.immediate-wake',
      }, transaction => {
        transaction.enqueue({
          dedupKey: 'pharmacy-ready-immediate-1',
          kind: 'pharmacy.ready',
          payload: { caseId: 'case-1', prescriptionId: 'rx-1' },
        })
        return { data: { ok: true }, effects: [] }
      })

      const committedAt = performance.now()
      executeImmediate()
      await Promise.race([
        completed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Immediate wakeup timed out')), 1_000)),
      ])
      expect(enteredAt).toBeDefined()
      expect(enteredAt! - committedAt).toBeLessThan(50)
      expect(dispatchSpy.mock.calls.length).toBeGreaterThan(0)
      for (const [filter] of dispatchSpy.mock.calls) {
        expect(filter?.kinds).toBeUndefined()
        expect(filter?.excludedKinds).toContain('consultation.record-history')
      }
      expect(new OutboxRepository(runtime.database).list(context)).toMatchObject([{
        dedupKey: 'pharmacy-ready-immediate-1',
        status: 'completed',
      }])

      // Drain any trailing loop check, then verify replay and rollback do not trigger wakeups.
      await new Promise(resolve => setTimeout(resolve, 20))
      const callsAfterCommit = dispatchSpy.mock.calls.length

      executeImmediate()
      expect(() => runtime.commands.execute({
        context,
        dataSchema: z.object({ ok: z.boolean() }),
        expectedVersions: {},
        idempotencyKey: 'immediate-rollback-001',
        input: { prescriptionId: 'rx-rollback' },
        operation: 'outbox.immediate-rollback',
      }, transaction => {
        transaction.enqueue({
          dedupKey: 'pharmacy-ready-rollback-1',
          kind: 'pharmacy.ready',
          payload: { caseId: 'case-1', prescriptionId: 'rx-rollback' },
        })
        throw new Error('rollback before commit')
      })).toThrow('rollback before commit')

      await new Promise(resolve => setTimeout(resolve, 20))
      expect(dispatchSpy.mock.calls.length).toBe(callsAfterCommit)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true })
    }
  })

  it('cascades accept -> start -> report outbox hops continuously without waiting for the fallback interval', async () => {
    const bundle = caseBundle({
      gender: 'male',
      index: [{ ...acuteBronchitis, resourceType: 'Condition' }],
      name: '级联唤醒合成患者',
    })
    const item = await createImagingRuntime([
      {
        ...bundle,
        entry: bundle.entry.filter(entry => entry.resource.id !== 'prior-fact-0'),
      },
    ], { autoDispatchIntervalMs: 60_000, persona: true })
    try {
      const admin = await signIn(item.runtime)
      const source = await generateCase(item.runtime, admin)
      const visit = await startConsultation(item.runtime, admin, source)
      await satisfyOutpatientOrderPrerequisites(item.runtime, visit.doctor, visit.outpatientCaseId)
      const detail = async () => doctorCaseDetailSchema.parse(await (await item.runtime.app.request(
        `/api/his/v1/doctor/cases/${visit.outpatientCaseId}`,
        { headers: { cookie: visit.doctor } },
      )).json())
      const current = await detail()
      const expectedVersions = { [`Encounter/${visit.encounterId}`]: current.encounter.versionId }
      const saved = await item.runtime.app.request(
        `/api/his/v1/encounters/${visit.encounterId}/examination-request/draft`,
        mutation(visit.doctor, {
          expectedVersions,
          input: {
            expectedDraftVersion: current.examinationRequests?.draftVersion ?? 0,
            indication: '级联唤醒验证',
            serviceId: 'examination-ecg-12-lead',
          },
        }, 'PUT'),
      )
      expect(saved.status).toBe(200)
      const savedDraft = examinationRequestDraftResponseSchema.parse(await saved.json()).data
      const issued = await item.runtime.app.request(
        `/api/his/v1/encounters/${visit.encounterId}/examination-request/actions/issue`,
        mutation(visit.doctor, {
          expectedVersions,
          input: { expectedDraftVersion: savedDraft.draftVersion },
        }),
      )
      expect(issued.status).toBe(200)
      const request = issueExaminationRequestResponseSchema.parse(await issued.json()).data.request

      const originalDispatchOnce = item.runtime.dispatcher.dispatchOnce.bind(item.runtime.dispatcher)
      const completedHops: string[] = []
      let resolveReported!: () => void
      const reported = new Promise<void>(resolve => { resolveReported = resolve })
      vi.spyOn(item.runtime.dispatcher, 'dispatchOnce').mockImplementation(async filter => {
        const result = await originalDispatchOnce(filter)
        if (result !== undefined && result.kind.startsWith('examination.')) {
          completedHops.push(result.kind)
          if (result.kind === 'examination.report-request') resolveReported()
        }
        return result
      })

      const startedAt = performance.now()
      await payOutpatientInvestigation(item.runtime, {
        caseId: visit.outpatientCaseId,
        category: 'examination',
        chargeItemId: request.billing!.chargeItemId,
      })
      await Promise.race([
        reported,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Cascade timed out')), 2_000)),
      ])
      expect(performance.now() - startedAt).toBeLessThan(2_000)
      expect(completedHops).toEqual([
        'examination.accept-request',
        'examination.start-request',
        'examination.report-request',
      ])
      const updated = await detail()
      expect(updated.examinationRequests?.requests[0]?.status).toBe('reported')
    } finally {
      await item.runtime.close()
      await rm(item.directory, { recursive: true, force: true })
    }
  })

  it('holds delayed outbox events until due, reschedules for earlier arrivals, and clears timers on close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-runtime-delayed-wake-'))
    let runtime: Awaited<ReturnType<typeof createClinMeshRuntime>> | undefined
    try {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'))
      runtime = await createClinMeshRuntime({
        authBaseUrl: 'http://127.0.0.1',
        authSecret: 'test-auth-secret-with-at-least-32-characters',
        autoDispatchIntervalMs: 60_000,
        cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
        databasePath: join(directory, 'clinmesh.sqlite'),
        demoPassword: `Test-${randomUUID()}-Aa1!`,
        migrationMode: 'apply',
        trustedOrigins: ['http://127.0.0.1'],
      })
      const activeRuntime = runtime
      const context = {
        actorId: 'actor-system',
        epoch: 'epoch-1',
        roleCode: 'system',
        scenarioRunId: 'scenario-run-1',
        workspaceId: 'workspace-demo',
      }
      const outbox = new OutboxRepository(activeRuntime.database)
      const dispatchSpy = vi.spyOn(activeRuntime.dispatcher, 'dispatchOnce')
      const enqueueDelayed = (key: string, delayMs: number, kind = 'pharmacy.ready') => {
        activeRuntime.commands.execute({
          context,
          dataSchema: z.object({ ok: z.boolean() }),
          expectedVersions: {},
          idempotencyKey: `delayed-${key}`,
          input: { key, delayMs },
          operation: 'outbox.delayed-wake',
        }, transaction => {
          transaction.enqueue({
            dedupKey: key,
            delayMs,
            kind,
            payload: kind === 'pharmacy.ready'
              ? { caseId: 'case-1', prescriptionId: key }
              : { generation: 1, turnId: key },
          })
          return { data: { ok: true }, effects: [] }
        })
      }

      // Enqueue later (+5s) first, then earlier (+1s) on the same business lane.
      enqueueDelayed('later-5000', 5_000)
      enqueueDelayed('earlier-1000', 1_000)

      await vi.advanceTimersByTimeAsync(999)
      expect(dispatchSpy).not.toHaveBeenCalled()
      expect(outbox.list(context).map(event => ({ dedupKey: event.dedupKey, status: event.status }))).toEqual([
        { dedupKey: 'later-5000', status: 'queued' },
        { dedupKey: 'earlier-1000', status: 'queued' },
      ])

      // At 1_000ms, only the business lane wakes; the earlier event executes while +5_000ms stays queued.
      await vi.advanceTimersByTimeAsync(1)
      expect(dispatchSpy.mock.calls.length).toBeGreaterThan(0)
      for (const [filter] of dispatchSpy.mock.calls) {
        expect(filter?.kinds).toBeUndefined()
        expect(filter?.excludedKinds).toContain('consultation.record-history')
      }
      expect(outbox.list(context).map(event => ({ dedupKey: event.dedupKey, status: event.status }))).toEqual([
        { dedupKey: 'later-5000', status: 'queued' },
        { dedupKey: 'earlier-1000', status: 'completed' },
      ])

      // At 4_999ms, the later event is still unclaimed; at 5_000ms, it completes immediately.
      await vi.advanceTimersByTimeAsync(3_999)
      expect(outbox.list(context).find(event => event.dedupKey === 'later-5000')?.status).toBe('queued')
      await vi.advanceTimersByTimeAsync(1)
      expect(outbox.list(context).find(event => event.dedupKey === 'later-5000')?.status).toBe('completed')

      // Enqueue pending delayed events on two lanes and confirm runtime.close() clears all timers.
      const timersBeforePending = vi.getTimerCount()
      enqueueDelayed('pending-business', 3_000, 'pharmacy.ready')
      enqueueDelayed('pending-recording', 4_000, 'consultation.record-history')
      expect(vi.getTimerCount()).toBe(timersBeforePending + 2)

      await activeRuntime.close()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(10_000)
    } finally {
      await runtime?.close()
      vi.useRealTimers()
      await rm(directory, { recursive: true })
    }
  })

  it('stays completely passive when autoDispatchIntervalMs is omitted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-runtime-passive-'))
    let runtime: Awaited<ReturnType<typeof createClinMeshRuntime>> | undefined
    try {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'))
      runtime = await createClinMeshRuntime({
        authBaseUrl: 'http://127.0.0.1',
        authSecret: 'test-auth-secret-with-at-least-32-characters',
        cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
        databasePath: join(directory, 'clinmesh.sqlite'),
        demoPassword: `Test-${randomUUID()}-Aa1!`,
        migrationMode: 'apply',
        trustedOrigins: ['http://127.0.0.1'],
      })
      const context = {
        actorId: 'actor-system',
        epoch: 'epoch-1',
        roleCode: 'system',
        scenarioRunId: 'scenario-run-1',
        workspaceId: 'workspace-demo',
      }
      const baselineTimerCount = vi.getTimerCount()
      const dispatchSpy = vi.spyOn(runtime.dispatcher, 'dispatchOnce')

      runtime.commands.execute({
        context,
        dataSchema: z.object({ ok: z.boolean() }),
        expectedVersions: {},
        idempotencyKey: 'passive-mode-001',
        input: {},
        operation: 'outbox.passive-mode',
      }, transaction => {
        transaction.enqueue({
          dedupKey: 'passive-immediate',
          kind: 'pharmacy.ready',
          payload: { caseId: 'case-1', prescriptionId: 'rx-immediate' },
        })
        transaction.enqueue({
          dedupKey: 'passive-delayed',
          delayMs: 500,
          kind: 'pharmacy.ready',
          payload: { caseId: 'case-1', prescriptionId: 'rx-delayed' },
        })
        return { data: { ok: true }, effects: [] }
      })

      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(dispatchSpy).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(baselineTimerCount)
      const outbox = new OutboxRepository(runtime.database)
      expect(outbox.list(context).map(event => event.status)).toEqual(['queued', 'queued'])

      await runtime.dispatchPending()
      expect(outbox.list(context).map(event => event.status)).toEqual(['completed', 'completed'])
    } finally {
      await runtime?.close()
      vi.useRealTimers()
      await rm(directory, { recursive: true })
    }
  })
})
