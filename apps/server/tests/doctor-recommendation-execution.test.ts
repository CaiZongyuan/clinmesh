import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { encodeModelRoute } from '@clinmesh/contracts/model-bridge'
import { DshModelProvider } from '../src/infrastructure/ai/dsh-model-provider.ts'
import { ClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { OpenAIChatCompletionsClient, type JsonChatCompletionInput } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { DoctorRecommendationExecution, readDoctorRecommendationExecution, recommendationRequestHash } from '../src/application/doctor-recommendation-execution.ts'

const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })
const output = z.object({ ok: z.boolean() }).strict()
const request: JsonChatCompletionInput = {
  model: 'synthetic-model', schemaName: 'synthetic', jsonSchema: z.toJSONSchema(output),
  systemPrompt: 'Synthetic only', userPayload: {}, validate: value => output.safeParse(value).success,
}
function seedScope(database: ClinMeshDatabase, workspaceId: string, epoch: string): void {
  database.driver.prepare(`INSERT OR IGNORE INTO workspace (workspace_id, name, created_at) VALUES (?, 'Synthetic workspace', '2026-10-20T00:00:00.000Z')`).run(workspaceId)
  database.driver.prepare(`INSERT OR IGNORE INTO workspace_epoch (workspace_id, epoch, state, scenario_id, created_at)
    VALUES (?, ?, 'active', 'synthetic-scenario', '2026-10-20T00:00:00.000Z')`).run(workspaceId, epoch)
}
function fixture(fetch: typeof globalThis.fetch, model = request.model) {
  const directory = mkdtempSync(join(tmpdir(), 'clinmesh-recommendation-execution-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const database = new ClinMeshDatabase(new Database(join(directory, 'execution.sqlite')))
  cleanup.push(() => database.close())
  database.driver.pragma('foreign_keys = ON')
  database.driver.exec(readFileSync(new URL('../drizzle/0000_foundation.sql', import.meta.url), 'utf8'))
  database.driver.exec(readFileSync(new URL('../drizzle/0060_doctor-recommendations.sql', import.meta.url), 'utf8'))
  database.driver.exec(readFileSync(new URL('../drizzle/0068_doctor-recommendation-execution.sql', import.meta.url), 'utf8'))
  database.driver.exec(readFileSync(new URL('../drizzle/0073_model-task-recovery.sql', import.meta.url), 'utf8'))
  seedScope(database, 'workspace', 'epoch')
  const provider = new OpenAIChatCompletionsClient({ apiKey: 'synthetic', baseUrl: 'https://synthetic.invalid', fetch })
  const options = { database, identity: { workspaceId: 'workspace', epoch: 'epoch', actorId: 'doctor', contextKey: 'context',
    caseId: 'case', kind: 'diagnosis' as const, generation: 1 }, inputFingerprint: 'synthetic-input', model,
    policyVersion: 'synthetic-v1', provider, assertCurrent: () => {} }
  return { database, options, execution: new DoctorRecommendationExecution(options) }
}
const success = () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] })
const batchRequest = (batchId: string): JsonChatCompletionInput => ({ ...request, userPayload: { batchId } })

it('persists validated successful units and reuses them after reconstruction', async () => {
  let sent = 0
  const { execution, options } = fixture(async () => { sent += 1; return success() })
  execution.plan('generation', [{ batchId: '0', inputHash: recommendationRequestHash(request) }])
  await expect(execution.run({ stage: 'generation', batchId: '0', request }, value => output.parse(value))).resolves.toEqual({ ok: true })
  const restarted = new DoctorRecommendationExecution(options)
  restarted.plan('generation', [{ batchId: '0', inputHash: recommendationRequestHash(request) }])
  await expect(restarted.run({ stage: 'generation', batchId: '0', request }, value => output.parse(value))).resolves.toEqual({ ok: true })
  expect(sent).toBe(1)
  expect(restarted.status()).toMatchObject({ status: 'completed', requestCount: 1, extraRequestCount: 0 })
})

it('automatically recovers a complete technical failure without repeating an earlier successful unit', async () => {
  let sent = 0
  const { execution } = fixture(async () => { sent += 1; return sent === 2 ? new Response('', { status: 503 }) : success() })
  execution.plan('history-selection', ['0', '1'].map(batchId => ({ batchId, inputHash: recommendationRequestHash(batchRequest(batchId)) })))
  for (const batchId of ['0', '1']) await execution.run({ stage: 'history-selection', batchId, request: batchRequest(batchId) }, value => output.parse(value))
  expect(sent).toBe(3)
  expect(execution.status()).toMatchObject({ status: 'completed', requestCount: 3, extraRequestCount: 1 })
})

it('keeps an incomplete transport unknown and opens it only once per explicit continuation intent', async () => {
  let sent = 0
  const { execution, options } = fixture(async () => { sent += 1; throw new TypeError('Synthetic disconnected transport') })
  execution.plan('generation', [{ batchId: '0', inputHash: recommendationRequestHash(request) }])
  const run = (target = execution) => target.run({ stage: 'generation', batchId: '0', request }, value => output.parse(value))
  await expect(run()).rejects.toMatchObject({ kind: 'unknown' })
  await expect(run(new DoctorRecommendationExecution(options))).rejects.toMatchObject({ kind: 'unknown' })
  expect(sent).toBe(1)
  expect(execution.continue('human-intent-1')).toBe(true)
  await expect(run()).rejects.toMatchObject({ kind: 'unknown' })
  expect(execution.continue('human-intent-1')).toBe(false)
  await expect(run()).rejects.toMatchObject({ kind: 'unknown' })
  expect(sent).toBe(2)
  expect(execution.status()).toMatchObject({ status: 'unknown', canContinue: true, extraRequestCount: 1 })
})

it.each(['format', 'unavailable', 'rate-limit', 'disconnected'])('allows only one request per manual intent with automatic retries off (%s)', async failure => {
  let sent = 0
  const { options } = fixture(async () => {
    sent++
    if (failure === 'disconnected') throw new TypeError('Synthetic disconnected transport')
    if (failure === 'format') return Response.json({ choices: [{ message: { content: '{}' } }] })
    return new Response('', { status: failure === 'rate-limit' ? 429 : 503 })
  })
  let execution = new DoctorRecommendationExecution({ ...options, automaticRetries: () => false })
  execution.plan('generation', [{ batchId: '0', inputHash: recommendationRequestHash(request) }])
  const run = () => execution.run({ stage: 'generation', batchId: '0', request }, value => output.parse(value))
  await expect(run()).rejects.toBeDefined()
  expect(execution.status()).toMatchObject({ requestCount: 1, canContinue: true })
  expect(execution.continue('first-intent')).toBe(true)
  expect(execution.status().canContinue).toBe(false)
  execution = new DoctorRecommendationExecution({ ...options, automaticRetries: () => false })
  await expect(run()).rejects.toBeDefined()
  expect(sent).toBe(2)
  expect(execution.status()).toMatchObject({ requestCount: 2, extraRequestCount: 1, canContinue: true })
  expect(execution.continue('first-intent')).toBe(false)
  await expect(run()).rejects.toBeDefined()
  expect(sent).toBe(2)
  expect(execution.continue('second-intent')).toBe(true)
  await expect(run()).rejects.toBeDefined()
  expect(sent).toBe(3)
  expect(execution.status()).toMatchObject({ status: 'exhausted', requestCount: 3, extraRequestCount: 2, canContinue: false })
})

it('requires a new intent after a continuation terminates before dispatch without spending its request budget', async () => {
  let sent = 0
  const { execution } = fixture(async () => {
    if (++sent === 1) throw new TypeError('Synthetic disconnected transport')
    return success()
  })
  execution.plan('generation', [{ batchId: '0', inputHash: recommendationRequestHash(request) }])
  const run = (next = request) => execution.run({ stage: 'generation', batchId: '0', request: next }, value => output.parse(value))
  await expect(run()).rejects.toMatchObject({ kind: 'unknown' })
  execution.continue('cancelled-intent')
  await expect(run({ ...request, signal: AbortSignal.abort() })).rejects.toBeDefined()
  expect(sent).toBe(1)
  expect(execution.status()).toMatchObject({ status: 'failed', requestCount: 1, extraRequestCount: 0, canContinue: true })
  expect(execution.continue('cancelled-intent')).toBe(false)
  execution.continue('new-intent')
  await run()
  expect(sent).toBe(2)
  expect(execution.status()).toMatchObject({ status: 'completed', requestCount: 2, extraRequestCount: 1 })
})

it.each(['failed', 'unknown'])('continues only one batch when another batch is %s and preserves the remaining failure', async outcome => {
  let failing = true
  let sent = 0
  const { options } = fixture(async () => {
    sent++
    if (failing && sent === 2 && outcome === 'unknown') throw new TypeError('Synthetic disconnected transport')
    return failing ? new Response('', { status: 401 }) : success()
  })
  const execution = new DoctorRecommendationExecution({ ...options, automaticRetries: () => false })
  execution.plan('verification', ['0', '1'].map(batchId => ({ batchId, inputHash: recommendationRequestHash(batchRequest(batchId)) })))
  const run = (batchId: string) => execution.run({ stage: 'verification', batchId, request: batchRequest(batchId) }, value => output.parse(value))
  await Promise.allSettled(['0', '1'].map(run))
  expect(execution.status()).toMatchObject({ requestCount: 2, canContinue: true })
  failing = false
  execution.continue('first-batch')
  const results = await Promise.allSettled(['0', '1'].map(run))
  expect(results.map(result => result.status)).toEqual(outcome === 'unknown' ? ['rejected', 'fulfilled'] : ['fulfilled', 'rejected'])
  expect(sent).toBe(3)
  expect(execution.status()).toMatchObject({ requestCount: 3, extraRequestCount: 1, canContinue: true })
  execution.continue('second-batch')
  await Promise.all(['0', '1'].map(run))
  expect(sent).toBe(4)
  expect(execution.status()).toMatchObject({ status: 'completed', requestCount: 4, extraRequestCount: 2 })
})

it('stops the generation after a unit consumes three actual format attempts', async () => {
  let sent = 0
  const { execution } = fixture(async () => { sent += 1; return Response.json({ choices: [{ message: { content: '{}' } }] }) })
  execution.plan('history-selection', ['0', '1'].map(batchId => ({ batchId, inputHash: recommendationRequestHash(request) })))
  await expect(execution.run({ stage: 'history-selection', batchId: '0', request }, value => output.parse(value))).rejects.toMatchObject({ kind: 'exhausted' })
  await expect(execution.run({ stage: 'history-selection', batchId: '1', request }, value => output.parse(value))).rejects.toMatchObject({ kind: 'exhausted' })
  expect(sent).toBe(3)
  expect(execution.status()).toMatchObject({ status: 'exhausted', requestCount: 3, extraRequestCount: 2, canContinue: false })
})

it('atomically gives only one concurrent retry the last generation extra request', async () => {
  let sent = 0
  const { execution } = fixture(async () => {
    sent += 1
    return [1, 3, 5, 7, 8].includes(sent) ? new Response('', { status: 503 }) : success()
  })
  execution.plan('history-selection', ['0', '1', '2', '3', '4'].map(batchId => ({ batchId, inputHash: recommendationRequestHash(batchRequest(batchId)) })))
  for (const batchId of ['0', '1', '2']) await execution.run({ stage: 'history-selection', batchId, request: batchRequest(batchId) }, value => output.parse(value))
  const results = await Promise.allSettled(['3', '4'].map(batchId => execution.run({ stage: 'history-selection', batchId, request: batchRequest(batchId) }, value => output.parse(value))))
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  expect(sent).toBe(9)
  expect(execution.status()).toMatchObject({ status: 'exhausted', requestCount: 9, extraRequestCount: 4, canContinue: false })
})

it('rejects regrouping, changed content, dependencies and original model bindings', async () => {
  const { execution, options } = fixture(async () => success())
  execution.plan('history-selection', [{ batchId: '0', inputHash: recommendationRequestHash(request) }])
  expect(() => execution.plan('history-selection', [{ batchId: 'another', inputHash: recommendationRequestHash(request) }])).toThrowError(/plan-conflict/)
  expect(() => execution.plan('history-selection', [{ batchId: '0', inputHash: recommendationRequestHash({ ...request, userPayload: { changed: true } }) }])).toThrowError(/plan-conflict/)
  expect(() => execution.plan('history-selection', [{ batchId: '0', inputHash: recommendationRequestHash(request), dependencies: [{ stage: 'generation', batchId: '0' }] }])).toThrowError(/plan-conflict/)
  expect(() => new DoctorRecommendationExecution({ ...options, model: 'changed' })).toThrowError(/plan-conflict/)
  await expect(execution.run({ stage: 'history-selection', batchId: '0', request: { ...request, userPayload: { changed: true } } }, value => output.parse(value))).rejects.toMatchObject({ kind: 'plan-conflict' })
})

it('retains candidate generation and a successful verification batch when continuing a later failure', async () => {
  let sent = 0
  const { execution, options } = fixture(async () => {
    sent += 1
    return sent === 3 ? new Response('', { status: 401 }) : success()
  })
  execution.plan('generation', [{ batchId: '0', inputHash: recommendationRequestHash(request) }])
  const generation = { stage: 'generation' as const, batchId: '0', request }
  await execution.run(generation, value => output.parse(value))
  execution.plan('verification', ['0', '1'].map(batchId => ({ batchId, inputHash: recommendationRequestHash(request),
    dependencies: [{ stage: 'generation' as const, batchId: '0' }] })))
  await execution.run({ stage: 'verification', batchId: '0', request }, value => output.parse(value))
  await expect(execution.run({ stage: 'verification', batchId: '1', request }, value => output.parse(value))).rejects.toMatchObject({ kind: 'failed' })
  const restarted = new DoctorRecommendationExecution(options)
  await expect(restarted.run({ stage: 'verification', batchId: '1', request }, value => output.parse(value))).rejects.toMatchObject({ kind: 'failed' })
  restarted.continue('continue-remaining-verification')
  await restarted.run(generation, value => output.parse(value))
  for (const batchId of ['0', '1']) await restarted.run({ stage: 'verification', batchId, request }, value => output.parse(value))
  expect(sent).toBe(4)
  expect(restarted.status()).toMatchObject({ status: 'completed', requestCount: 4, extraRequestCount: 1 })
})

it('treats a legitimate negative verification as a reusable successful outcome', async () => {
  let sent = 0
  const { execution } = fixture(async () => { sent += 1; return Response.json({ choices: [{ message: { content: '{"ok":false}' } }] }) })
  execution.plan('verification', [{ batchId: '0', inputHash: recommendationRequestHash(request) }])
  for (let repeat = 0; repeat < 2; repeat++) {
    await expect(execution.run({ stage: 'verification', batchId: '0', request }, value => output.parse(value))).resolves.toEqual({ ok: false })
  }
  expect(sent).toBe(1)
})

it('does not mistake an active dispatch for a process interruption', async () => {
  let release: () => void = () => {}
  const barrier = new Promise<void>(resolve => { release = resolve })
  const { execution, options } = fixture(async () => { await barrier; return success() })
  execution.plan('generation', [{ batchId: '0', inputHash: recommendationRequestHash(request) }])
  const running = execution.run({ stage: 'generation', batchId: '0', request }, value => output.parse(value))
  const concurrent = new DoctorRecommendationExecution(options)
  expect(concurrent.status()).toMatchObject({ status: 'running', requestCount: 1 })
  expect(concurrent.recoverUnknown()).toBe(0)
  await expect(concurrent.run({ stage: 'generation', batchId: '0', request }, value => output.parse(value))).rejects.toMatchObject({ kind: 'running' })
  release()
  await expect(running).resolves.toEqual({ ok: true })
})

it('conservatively retains an uncompleted reservation as unknown on restart', async () => {
  const { execution, options, database } = fixture(async () => success())
  execution.plan('generation', [{ batchId: '0', inputHash: recommendationRequestHash(request) }])
  // An old process committed this reservation and stopped before saving a complete outcome.
  database.driver.prepare(`UPDATE doctor_recommendation_execution_unit SET status = 'dispatching', request_count = 1`).run()
  const restarted = new DoctorRecommendationExecution(options)
  expect(restarted.status()).toMatchObject({ status: 'unknown', requestCount: 1, canContinue: true })
  await expect(restarted.run({ stage: 'generation', batchId: '0', request }, value => output.parse(value))).rejects.toMatchObject({ kind: 'unknown' })
})

it('reads an existing binding without creating another task or exposing checkpoint content', async () => {
  const { execution, options, database } = fixture(async () => success())
  expect(readDoctorRecommendationExecution(database, { ...options.identity, generation: 2 })).toBeUndefined()
  execution.plan('generation', [{ batchId: '0', inputHash: recommendationRequestHash(request) }])
  await execution.run({ stage: 'generation', batchId: '0', request }, value => output.parse(value))
  const read = readDoctorRecommendationExecution(database, options.identity)
  expect(read).toMatchObject({ model: request.model, policyVersion: 'synthetic-v1', inputFingerprint: 'synthetic-input', status: { requestCount: 1 } })
  expect(JSON.stringify(read)).not.toContain('"ok"')
  expect(readDoctorRecommendationExecution(database, { ...options.identity, generation: 2 })).toBeUndefined()
})

it('counts a legacy single-call adapter and retains its complete negative result', async () => {
  let sent = 0
  const { options } = fixture(async () => success())
  const execution = new DoctorRecommendationExecution({ ...options, provider: {
    completeJson: async () => { sent += 1; return { content: '{"ok":false}', model: request.model } },
  } })
  execution.plan('generation', [{ batchId: '0', inputHash: recommendationRequestHash(request) }])
  await execution.run({ stage: 'generation', batchId: '0', request }, value => output.parse(value))
  expect(sent).toBe(1)
  expect(execution.status()).toMatchObject({ requestCount: 1, extraRequestCount: 0 })
})

it('stops before the next fetch and preserves the owning validity error', async () => {
  let current = true
  let sent = 0
  const stale = new Error('Synthetic obsolete generation')
  const { options } = fixture(async () => { sent += 1; current = false; return Response.json({ choices: [{ message: { content: '{}' } }] }) })
  const execution = new DoctorRecommendationExecution({ ...options, assertCurrent: () => { if (!current) throw stale } })
  execution.plan('generation', [{ batchId: '0', inputHash: recommendationRequestHash(request) }])
  await expect(execution.run({ stage: 'generation', batchId: '0', request }, value => output.parse(value))).rejects.toBe(stale)
  expect(sent).toBe(1)
})

it('shares its persistent unit budget with DSH rate-limit resends and format repair', async () => {
  let sent = 0
  const model = encodeModelRoute({ provider: 'synthetic', model: 'synthetic' })
  const { options } = fixture(async () => success(), model)
  const execution = new DoctorRecommendationExecution({ ...options, provider: new DshModelProvider({
    origin: 'http://127.0.0.1:43210', secret: 'synthetic', timeoutMs: 2_000, maxResponseBytes: 2048,
    fetch: async () => {
      sent += 1
      return sent === 1 ? Response.json({ error: 'MODEL_RATE_LIMIT', retryAfterMs: 1 }, { status: 429 })
        : Response.json({ content: sent === 2 ? '{}' : '{"ok":true}', model })
    },
  }) })
  const pinnedRequest = { ...request, model }
  execution.plan('generation', [{ batchId: '0', inputHash: recommendationRequestHash(pinnedRequest) }])
  await execution.run({ stage: 'generation', batchId: '0', request: pinnedRequest }, value => output.parse(value))
  execution.plan('verification', [{ batchId: '0', inputHash: recommendationRequestHash(pinnedRequest), dependencies: [{ stage: 'generation', batchId: '0' }] }])
  await expect(execution.run({ stage: 'verification', batchId: '0', request: pinnedRequest }, value => output.parse(value))).rejects.toMatchObject({ kind: 'exhausted' })
  expect(sent).toBe(3)
  expect(execution.status()).toMatchObject({ requestCount: 3, extraRequestCount: 2, canContinue: false })
})

it('retains a stream interruption as unknown even after response headers arrived', async () => {
  let sent = 0
  const { execution } = fixture(async () => {
    sent += 1
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error('Synthetic broken stream')) } }))
  })
  execution.plan('generation', [{ batchId: '0', inputHash: recommendationRequestHash(request) }])
  await expect(execution.run({ stage: 'generation', batchId: '0', request }, value => output.parse(value))).rejects.toMatchObject({ kind: 'unknown' })
  expect(sent).toBe(1)
  expect(execution.status()).toMatchObject({ status: 'unknown', requestCount: 1 })
})

it('retains shutdown cancellation and the last occupied request after successive explicit continuations', async () => {
  const abort = new AbortController()
  let sent = 0
  const { execution } = fixture(async (_url, init) => {
    sent += 1
    if (sent > 1) throw new TypeError('Synthetic disconnected continuation')
    return new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new Error('Synthetic cancelled request'))
      else init?.signal?.addEventListener('abort', () => reject(new Error('Synthetic cancelled request')), { once: true })
    })
  })
  let cancelledRequest = { ...request, signal: abort.signal }
  execution.plan('generation', [{ batchId: '0', inputHash: recommendationRequestHash(cancelledRequest) }])
  const run = () => execution.run({ stage: 'generation', batchId: '0', request: cancelledRequest }, value => output.parse(value))
  const running = run()
  abort.abort()
  await expect(running).rejects.toMatchObject({ kind: 'unknown' })
  cancelledRequest = { ...request, signal: new AbortController().signal }
  for (const intent of ['human-1', 'human-2']) {
    execution.continue(intent)
    await expect(run()).rejects.toMatchObject({ kind: 'unknown' })
  }
  expect(sent).toBe(3)
  expect(execution.status()).toMatchObject({ status: 'exhausted', requestCount: 3, canContinue: false })
  expect(() => execution.continue('human-3')).toThrowError(/exhausted/)
})

it('does not reserve or fetch when the dispatch was already cancelled', async () => {
  let sent = 0
  const { execution } = fixture(async () => { sent += 1; return success() })
  const cancelled = { ...request, signal: AbortSignal.abort() }
  execution.plan('generation', [{ batchId: '0', inputHash: recommendationRequestHash(cancelled) }])
  await expect(execution.run({ stage: 'generation', batchId: '0', request: cancelled }, value => output.parse(value))).rejects.toBeDefined()
  expect(sent).toBe(0)
  expect(execution.status()).toMatchObject({ requestCount: 0 })
})

it.each(['history-selection', 'catalog-selection'] as const)('reuses an exact successful %s across kinds and explicit generations within the same trusted scope', async stage => {
  let sent = 0
  const { execution, options } = fixture(async () => { sent += 1; return success() })
  const plan = [{ batchId: '0', inputHash: recommendationRequestHash(request) }]
  execution.plan(stage, plan)
  await execution.run({ stage, batchId: '0', request }, value => output.parse(value))
  const anotherKind = new DoctorRecommendationExecution({ ...options, identity: { ...options.identity, kind: 'laboratory' } })
  anotherKind.plan(stage, plan)
  await anotherKind.run({ stage, batchId: '0', request }, value => output.parse(value))
  const refreshed = new DoctorRecommendationExecution({ ...options, identity: { ...options.identity, generation: 2 } })
  refreshed.plan(stage, plan)
  await refreshed.run({ stage, batchId: '0', request }, value => output.parse(value))
  expect(sent).toBe(1)
  expect(anotherKind.status()).toMatchObject({ requestCount: 0, extraRequestCount: 0 })
  expect(refreshed.status()).toMatchObject({ requestCount: 0, extraRequestCount: 0 })
})

it('keeps exact selection reuse within workspace, epoch, actor, context, case, model and policy boundaries', async () => {
  let sent = 0
  const { execution, options } = fixture(async () => { sent += 1; return success() })
  const plan = [{ batchId: '0', inputHash: recommendationRequestHash(request) }]
  execution.plan('history-selection', plan)
  await execution.run({ stage: 'history-selection', batchId: '0', request }, value => output.parse(value))
  for (const scope of ['workspaceId', 'epoch', 'actorId', 'contextKey', 'caseId'] as const) {
    const identity = { ...options.identity, [scope]: `${scope}-different` }
    seedScope(options.database, identity.workspaceId, identity.epoch)
    const isolated = new DoctorRecommendationExecution({ ...options, identity })
    isolated.plan('history-selection', plan)
    await isolated.run({ stage: 'history-selection', batchId: '0', request }, value => output.parse(value))
  }
  const changedPolicy = new DoctorRecommendationExecution({ ...options, identity: { ...options.identity, generation: 3 }, policyVersion: 'different-policy' })
  changedPolicy.plan('history-selection', plan)
  await changedPolicy.run({ stage: 'history-selection', batchId: '0', request }, value => output.parse(value))
  expect(sent).toBe(7)
})

it.each(['generation', 'verification'] as const)('does not share %s outcomes across kinds or generations', async stage => {
  let sent = 0
  const { execution, options } = fixture(async () => { sent += 1; return success() })
  const plan = [{ batchId: '0', inputHash: recommendationRequestHash(request) }]
  execution.plan(stage, plan)
  await execution.run({ stage, batchId: '0', request }, value => output.parse(value))
  const anotherKind = new DoctorRecommendationExecution({ ...options, identity: { ...options.identity, kind: 'laboratory' } })
  anotherKind.plan(stage, plan)
  await anotherKind.run({ stage, batchId: '0', request }, value => output.parse(value))
  const refreshed = new DoctorRecommendationExecution({ ...options, identity: { ...options.identity, generation: 2 } })
  refreshed.plan(stage, plan)
  await refreshed.run({ stage, batchId: '0', request }, value => output.parse(value))
  expect(sent).toBe(3)
})

it('enforces composite scope references and preserves parent executions on restricted deletion', () => {
  const { database } = fixture(async () => success())
  seedScope(database, 'workspace', 'other-epoch')
  const insertExecution = database.driver.prepare(`INSERT INTO doctor_recommendation_execution
    (workspace_id, epoch, execution_key, binding_json) VALUES (?, ?, 'shared-key', '{}')`)
  expect(() => insertExecution.run('missing-workspace', 'epoch')).toThrow(/FOREIGN KEY/)
  insertExecution.run('workspace', 'epoch')
  const insertPlan = database.driver.prepare(`INSERT INTO doctor_recommendation_execution_plan
    (workspace_id, epoch, execution_key, stage, plan_json) VALUES (?, ?, 'shared-key', 'generation', '[]')`)
  expect(() => insertPlan.run('workspace', 'other-epoch')).toThrow(/FOREIGN KEY/)
  insertExecution.run('workspace', 'other-epoch')
  insertPlan.run('workspace', 'epoch')
  const insertUnit = database.driver.prepare(`INSERT INTO doctor_recommendation_execution_unit
    (workspace_id, epoch, execution_key, stage, batch_id, input_hash, dependencies_json, status)
    VALUES (?, ?, 'shared-key', 'generation', '0', ?, '[]', 'pending')`)
  expect(() => insertUnit.run('workspace', 'other-epoch', recommendationRequestHash(request))).toThrow(/FOREIGN KEY/)
  insertUnit.run('workspace', 'epoch', recommendationRequestHash(request))
  const insertContinue = database.driver.prepare(`INSERT INTO doctor_recommendation_execution_continue
    (workspace_id, epoch, execution_key, intent_key) VALUES (?, ?, 'shared-key', 'manual-intent')`)
  expect(() => insertContinue.run('missing-workspace', 'epoch')).toThrow(/FOREIGN KEY/)
  insertContinue.run('workspace', 'epoch')
  insertContinue.run('workspace', 'other-epoch')
  expect(() => database.driver.prepare(`DELETE FROM doctor_recommendation_execution
    WHERE workspace_id = 'workspace' AND epoch = 'epoch' AND execution_key = 'shared-key'`).run()).toThrow(/FOREIGN KEY/)
  expect(() => database.driver.prepare(`DELETE FROM doctor_recommendation_execution_plan
    WHERE workspace_id = 'workspace' AND epoch = 'epoch' AND execution_key = 'shared-key'`).run()).toThrow(/FOREIGN KEY/)
  expect(database.driver.pragma('foreign_key_check')).toEqual([])
})

it('scopes reads, plans, recovery, continuation and dispatch accounting even when another scope reuses an opaque execution key', async () => {
  let sent = 0
  const { database, options } = fixture(async () => { sent += 1; return sent === 1 ? new Response('', { status: 401 }) : success() })
  const original = z.object({ execution_key: z.string(), binding_json: z.string() }).parse(database.driver.prepare(`
    SELECT execution_key, binding_json FROM doctor_recommendation_execution WHERE workspace_id = ? AND epoch = ?`).get('workspace', 'epoch'))
  database.driver.prepare(`DELETE FROM doctor_recommendation_execution WHERE workspace_id = ? AND epoch = ? AND execution_key = ?`).run('workspace', 'epoch', original.execution_key)
  seedScope(database, 'other-workspace', 'other-epoch')
  database.driver.prepare(`INSERT INTO doctor_recommendation_execution (workspace_id, epoch, execution_key, binding_json, extra_request_count)
    VALUES ('other-workspace', 'other-epoch', ?, ?, 4)`).run(original.execution_key, original.binding_json)
  database.driver.prepare(`INSERT INTO doctor_recommendation_execution_plan (workspace_id, epoch, execution_key, stage, plan_json)
    VALUES ('other-workspace', 'other-epoch', ?, 'generation', '[]')`).run(original.execution_key)
  database.driver.prepare(`INSERT INTO doctor_recommendation_execution_unit
    (workspace_id, epoch, execution_key, stage, batch_id, input_hash, dependencies_json, status, request_count)
    VALUES ('other-workspace', 'other-epoch', ?, 'generation', '0', ?, '[]', 'dispatching', 3)`)
    .run(original.execution_key, recommendationRequestHash(request))
  database.driver.prepare(`INSERT INTO doctor_recommendation_execution_continue (workspace_id, epoch, execution_key, intent_key)
    VALUES ('other-workspace', 'other-epoch', ?, 'shared-intent')`).run(original.execution_key)
  expect(readDoctorRecommendationExecution(database, options.identity)).toBeUndefined()
  const execution = new DoctorRecommendationExecution(options)
  execution.plan('generation', [{ batchId: '0', inputHash: recommendationRequestHash(request) }])
  expect(execution.status()).toMatchObject({ status: 'pending', requestCount: 0, extraRequestCount: 0 })
  expect(execution.recoverUnknown()).toBe(0)
  await expect(execution.run({ stage: 'generation', batchId: '0', request }, value => output.parse(value))).rejects.toMatchObject({ kind: 'failed' })
  expect(execution.continue('shared-intent')).toBe(true)
  await execution.run({ stage: 'generation', batchId: '0', request }, value => output.parse(value))
  expect(sent).toBe(2)
  expect(readDoctorRecommendationExecution(database, options.identity)).toMatchObject({ status: { status: 'completed', requestCount: 2, extraRequestCount: 1 } })
  expect(database.driver.prepare(`SELECT status, request_count FROM doctor_recommendation_execution_unit
    WHERE workspace_id = 'other-workspace' AND epoch = 'other-epoch' AND execution_key = ?`).get(original.execution_key))
    .toEqual({ status: 'dispatching', request_count: 3 })
  expect(database.driver.prepare(`SELECT extra_request_count FROM doctor_recommendation_execution
    WHERE workspace_id = 'other-workspace' AND epoch = 'other-epoch' AND execution_key = ?`).get(original.execution_key))
    .toEqual({ extra_request_count: 4 })
})
