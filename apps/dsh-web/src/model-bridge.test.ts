import { Context } from '@deepseek-ai/cordis'
import Llm, { LlmAdapter, ReasoningEffortId, type GenerateOptions as SdkGenerateOptions, type StreamChunk as SdkStreamChunk } from '@deepseek-ai/dsh-llm'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { dshDefaultModel, encodeModelRoute } from '@clinmesh/contracts/model-bridge'
import { afterEach, expect, it, vi } from 'vitest'
import { DshModelProvider } from '../../server/src/infrastructure/ai/dsh-model-provider.ts'
import { createModelBridgeHandler } from './model-bridge.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { ModelUsageOutcome } from '@clinmesh/contracts/model-usage'
import { applyMigrations, openClinMeshDatabase } from '../../server/src/infrastructure/sqlite/database.ts'
import { DoctorRecommendationExecution, recommendationRequestHash } from '../../server/src/application/doctor-recommendation-execution.ts'
import { z } from 'zod'

type HostContext = Parameters<typeof createModelBridgeHandler>[0]
type GenerateOptions = Parameters<HostContext['llm']['stream']>[0]
type StreamChunk = ReturnType<HostContext['llm']['stream']> extends AsyncIterable<infer Chunk> ? Chunk : never

const secret = 'synthetic-model-bridge-secret-at-least-32-characters'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function host(compression: 'none' | 'gzip', providerFailure?: 'TIMEOUT' | 'RATE_LIMIT', finishGate?: Promise<void>, reportUsage = false) {
  const ctx = new Context()
  cleanup.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression, compressionThresholdBytes: 0 })
  const calls: GenerateOptions[] = []
  const modelContext = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'synthetic-provider', model: 'synthetic-model' }) },
    llm: {
      listModels: async () => [{ provider: 'synthetic-provider', id: 'synthetic-model', name: 'Synthetic model' }],
      async prepareCall(config: Parameters<HostContext['llm']['prepareCall']>[0]) {
        return { config, stream: (options: GenerateOptions) => this.stream(options) }
      },
      async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
        calls.push(options)
        if (finishGate !== undefined) {
          yield { type: 'text-delta', index: 0, text: '{"ok":true}' }
          if (reportUsage) yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
          await finishGate
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (providerFailure !== undefined) {
          if (providerFailure === 'RATE_LIMIT' && calls.length > 1) {
            yield { type: 'text-delta', index: 0, text: '{"ok":true}' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          } else {
            yield { type: 'finish', reason: { kind: 'error', failure: {
              code: providerFailure, providerRetryAfterMs: 20, message: 'private synthetic provider failure',
            } } }
          }
          return
        }
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('Synthetic cancellation')), { once: true })
        })
      },
    },
  }
  const bridge = createModelBridgeHandler(modelContext as unknown as HostContext, secret, () => 'default')
  cleanup.push(async () => { bridge.dispose() })
  ctx.webServer.register({ kind: 'exact', path: '/clinmesh-model-bridge', handler: bridge.handler })
  return { calls, origin: `http://127.0.0.1:${ctx.webServer.port}` }
}

const input = { model: dshDefaultModel, schemaName: 'patient_persona', jsonSchema: {},
  systemPrompt: 'synthetic', userPayload: {} }

async function sdkHost(adapter: LlmAdapter) {
  const ctx = new Context()
  cleanup.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Llm)
  ctx.llm.registerAdapter(['synthetic'], adapter)
  const route = { provider: 'synthetic', model: 'synthetic-model' }
  const bridge = createModelBridgeHandler({ llm: ctx.llm,
    agentDefaultModel: { currentSelection: () => route },
  } as HostContext, secret, () => 'default')
  cleanup.push(async () => { bridge.dispose() })
  ctx.webServer.register({ kind: 'exact', path: '/clinmesh-model-bridge', handler: bridge.handler })
  return { model: encodeModelRoute(route),
    provider: new DshModelProvider({ origin: `http://127.0.0.1:${ctx.webServer.port}`, secret, timeoutMs: 2000, maxResponseBytes: 4096 }) }
}

it('keeps SDK capability rejection out of actual dispatched requests', async () => {
  let dispatched = 0
  class SyntheticModel extends LlmAdapter {
    override async listModels(provider: string) { return [{ provider, id: 'synthetic-model', name: 'Synthetic' }] }
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
    override async *stream(_request: SdkGenerateOptions): AsyncIterable<SdkStreamChunk> {
      dispatched++
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const { provider } = await sdkHost(new SyntheticModel())
  const model = encodeModelRoute({ provider: 'synthetic', model: 'synthetic-model', reasoningEffort: 'unsupported' })
  const outcomes: ModelUsageOutcome[] = []
  await expect(provider.completeJson({ ...input, model,
    usageContext: { workspaceId: 'synthetic', epoch: 'synthetic', taskId: 'synthetic', stage: 'generation', trigger: 'manual', sources: [] },
    usageRecorder: { begin() { return randomUUID() }, checkpoint() {}, settle(_id, outcome) { outcomes.push(outcome) } },
  })).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' })
  expect(dispatched).toBe(0)
  expect(outcomes).toMatchObject([{ status: 'failed', dispatch: 'not-dispatched' }])
})

it('reports the exact prepared SDK defaults in bridge accounting', async () => {
  const calls: SdkGenerateOptions[] = []
  class SyntheticModel extends LlmAdapter {
    override async listModels(provider: string) { return [{ provider, id: 'synthetic-model', name: 'Synthetic' }] }
    override async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, defaultMaxTokens: 4096, reasoning: {
        efforts: [{ id: ReasoningEffortId('synthetic-high'), name: 'Synthetic' }], defaultEffort: ReasoningEffortId('synthetic-high') } }
    }
    override async *stream(request: SdkGenerateOptions): AsyncIterable<SdkStreamChunk> {
      calls.push(request)
      yield { type: 'text-delta', index: 0, text: '{"ok":true}' }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const { provider, model } = await sdkHost(new SyntheticModel())
  const outcomes: ModelUsageOutcome[] = []
  await provider.completeJson({ ...input, model,
    usageContext: { workspaceId: 'synthetic', epoch: 'synthetic', taskId: 'synthetic', stage: 'generation', trigger: 'manual', sources: [] },
    usageRecorder: { begin() { return randomUUID() }, checkpoint() {}, settle(_id, outcome) { outcomes.push(outcome) } },
  })
  expect(calls).toMatchObject([{ reasoningEffort: 'synthetic-high', maxTokens: 4096 }])
  expect(outcomes).toMatchObject([{ status: 'succeeded', reasoningEffort: 'synthetic-high', outputLimit: 4096 }])
})

it('keeps an SDK-normalized network interruption unknown until an explicit recommendation continuation', async () => {
  let streams = 0
  class InterruptedModel extends LlmAdapter {
    override async listModels(provider: string) { return [{ provider, id: 'synthetic-model', name: 'Synthetic' }] }
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
    override async *stream(_request: SdkGenerateOptions): AsyncIterable<SdkStreamChunk> {
      streams++
      yield { type: 'text-delta', index: 0, text: streams === 1 ? '{' : '{"ok":true}' }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
      if (streams === 1) throw new Error('Synthetic disconnected transport with private details')
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const { provider, model } = await sdkHost(new InterruptedModel())
  const database = openClinMeshDatabase({ databasePath: ':memory:', busyTimeoutMs: 5000 })
  cleanup.push(async () => { database.close() })
  applyMigrations(database, fileURLToPath(new URL('../../server/drizzle/', import.meta.url)))
  database.driver.prepare("INSERT INTO workspace (workspace_id, name, created_at) VALUES ('synthetic', 'Synthetic', '2026-10-21T00:00:00.000Z')").run()
  database.driver.prepare(`INSERT INTO workspace_epoch (workspace_id, epoch, state, scenario_id, created_at)
    VALUES ('synthetic', 'synthetic', 'active', 'synthetic', '2026-10-21T00:00:00.000Z')`).run()
  const outcomes: ModelUsageOutcome[] = []
  const output = z.object({ ok: z.boolean() }).strict()
  const request = { ...input, model, jsonSchema: z.toJSONSchema(output), validate: (value: unknown) => output.safeParse(value).success,
    usageRecorder: { begin(_input: unknown, reserve?: () => void) { reserve?.(); return randomUUID() }, checkpoint() {},
      settle(_id: string, outcome: ModelUsageOutcome) { outcomes.push(outcome) } },
  }
  const options = { database, identity: { workspaceId: 'synthetic', epoch: 'synthetic', actorId: 'synthetic', contextKey: 'synthetic',
    caseId: 'synthetic', kind: 'diagnosis' as const, generation: 1 }, inputFingerprint: 'synthetic', model, policyVersion: 'synthetic',
    provider, assertCurrent: () => {} }
  const execution = new DoctorRecommendationExecution(options)
  execution.plan('generation', [{ batchId: '0', inputHash: recommendationRequestHash(request) }])
  const run = (target = execution) => target.run({ stage: 'generation', batchId: '0', request }, value => output.parse(value))
  await expect(run()).rejects.toMatchObject({ kind: 'unknown' })
  await expect(run(new DoctorRecommendationExecution(options))).rejects.toMatchObject({ kind: 'unknown' })
  expect(streams).toBe(1)
  expect(execution.status()).toMatchObject({ status: 'unknown', requestCount: 1, extraRequestCount: 0 })
  expect(outcomes).toMatchObject([{ status: 'unknown', dispatch: 'dispatched', usage: { totalTokens: 12 } }])
  expect(JSON.stringify(outcomes)).not.toContain('private details')
  expect(execution.continue('synthetic-human-intent')).toBe(true)
  await expect(run()).resolves.toEqual({ ok: true })
  expect(streams).toBe(2)
  expect(execution.status()).toMatchObject({ status: 'completed', requestCount: 2, extraRequestCount: 1 })
})

it.each([503, 408, 504])('distinguishes a definite Provider failure from an unknown timeout with HTTP %s', async status => {
  class RejectedModel extends LlmAdapter {
    override async listModels(provider: string) { return [{ provider, id: 'synthetic-model', name: 'Synthetic' }] }
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
    override async *stream(_request: SdkGenerateOptions): AsyncIterable<SdkStreamChunk> {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PROVIDER_ERROR', status, message: 'Synthetic failure' } } }
    }
  }
  const { provider, model } = await sdkHost(new RejectedModel())
  const outcomes: ModelUsageOutcome[] = []
  let completed = 0
  await expect(provider.completeJson({ ...input, model, onRequestComplete: () => { completed++ },
    usageContext: { workspaceId: 'synthetic', epoch: 'synthetic', taskId: 'synthetic', stage: 'generation', trigger: 'manual', sources: [] },
    usageRecorder: { begin(_input, reserve) { reserve?.(); return randomUUID() }, checkpoint() {}, settle(_id, outcome) { outcomes.push(outcome) } },
  })).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' })
  expect(outcomes).toMatchObject([{ status: status === 503 ? 'failed' : 'unknown', dispatch: 'dispatched' }])
  expect(completed).toBe(status === 503 ? 1 : 0)
})

it.each(['none', 'gzip'] as const)('preserves usage before a cancelled stream through the actual %s Host', async compression => {
  let release!: () => void
  const dsh = await host(compression, undefined, new Promise<void>(resolve => { release = resolve }), true)
  const cancel = new AbortController()
  let received!: () => void
  const metadata = new Promise<void>(resolve => { received = resolve })
  const outcomes: ModelUsageOutcome[] = []
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 4096,
    fetch: Object.assign(async (url: URL | RequestInfo, options?: RequestInit) => {
      const response = await fetch(url, options)
      expect(response.headers.get('content-encoding')).toBeNull()
      return new Response(response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) { controller.enqueue(chunk); received() },
      })), { headers: response.headers, status: response.status })
    }, { preconnect: globalThis.fetch.preconnect }),
  })
  const execution = provider.completeJson({ ...input, model: encodeModelRoute({ provider: 'synthetic-provider', model: 'synthetic-model' }), signal: cancel.signal,
    usageContext: { workspaceId: 'synthetic', epoch: 'synthetic', taskId: 'synthetic', stage: 'generation', trigger: 'manual', sources: [] },
    usageRecorder: { begin(_input, reserve) { reserve?.(); return randomUUID() }, checkpoint() {}, settle(_id, outcome) { outcomes.push(outcome) } },
  })
  const result = expect(execution).rejects.toMatchObject({ code: 'AI_TIMEOUT' })
  try {
    await metadata
    await delay(0)
    cancel.abort()
    await result
    expect(outcomes).toMatchObject([{ status: 'cancelled', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }])
    expect(dsh.calls).toHaveLength(1)
  } finally { release() }
})

it.each(['none', 'gzip'] as const)('returns a safe deadline error through the actual %s host and cancels the model stream', async compression => {
  const dsh = await host(compression)
  // 固定客户端预算时钟，宿主仍用真实计时器触发超时和取消。
  vi.spyOn(performance, 'now').mockReturnValue(0)
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 100, maxResponseBytes: 2048 })
  await expect(provider.completeJson(input)).rejects.toMatchObject({
    code: 'AI_TIMEOUT', message: 'The DSH model request timed out',
  })
  expect(dsh.calls).toHaveLength(1)
  expect(dsh.calls[0]?.signal?.aborted).toBe(true)
})

it('preserves a Provider timeout through gzip without exposing its private message', async () => {
  const dsh = await host('gzip', 'TIMEOUT')
  vi.spyOn(performance, 'now').mockReturnValue(0)
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 100, maxResponseBytes: 2048 })
  await expect(provider.completeJson(input)).rejects.toMatchObject({
    code: 'AI_TIMEOUT', message: 'The DSH model request timed out',
  })
  expect(dsh.calls).toHaveLength(1)
})

it.each(['none', 'gzip'] as const)('recovers from one rate limit through the actual %s host', async compression => {
  const dsh = await host(compression, 'RATE_LIMIT')
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 2048 })
  const result = await provider.completeJson(input)
  expect(JSON.parse(result.content)).toEqual({ ok: true })
  expect(dsh.calls).toHaveLength(2)
})

it('reports Provider first text independently of the buffered gzip response', async () => {
  let release!: () => void
  const dsh = await host('gzip', undefined, new Promise<void>(resolve => { release = resolve }))
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 2048 })
  let firstTextMs: number | undefined
  let responseAt: number | undefined
  const started = performance.now()
  const request = provider.completeJson({ ...input, onFirstText: elapsedMs => { firstTextMs = elapsedMs },
    onResponse: () => { responseAt = performance.now() - started } })
  try {
    await expect.poll(() => dsh.calls.length).toBe(1)
    await delay(75)
    expect(responseAt).toBeUndefined()
  } finally { release() }
  await expect(request).resolves.toMatchObject({ content: '{"ok":true}' })
  expect(firstTextMs).toBeGreaterThanOrEqual(0)
  expect(responseAt! - firstTextMs!).toBeGreaterThanOrEqual(70)
})
