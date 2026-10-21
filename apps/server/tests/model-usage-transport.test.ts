import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { encodeModelRoute } from '@clinmesh/contracts/model-bridge'
import { createModelBridgeHandler } from '../../dsh-web/src/model-bridge.ts'
import { DshModelProvider } from '../src/infrastructure/ai/dsh-model-provider.ts'
import { expect, it } from 'vitest'
import { unknownModelTokenUsage, type ModelUsageContext, type ModelUsageOutcome } from '@clinmesh/contracts/model-usage'
import type { ModelUsageRecorder } from '../src/application/model-usage-lifecycle.ts'
import { OpenAIChatCompletionsClient, type JsonChatCompletionInput } from '../src/infrastructure/ai/openai-chat-completions.ts'

const usageContext: ModelUsageContext = {
  workspaceId: 'synthetic', epoch: 'synthetic', taskId: 'synthetic', stage: 'generation', trigger: 'manual', sources: [],
}
const input: JsonChatCompletionInput = {
  model: 'synthetic', schemaName: 'patient_persona', jsonSchema: {}, systemPrompt: 'Synthetic only', userPayload: {},
  validate: value => typeof value === 'object' && value !== null && 'ok' in value,
}
function recorder() {
  const attempts: Array<{ id: string; metadata: Parameters<ModelUsageRecorder['begin']>[0]; outcome?: ModelUsageOutcome }> = []
  const service: ModelUsageRecorder = {
    begin(metadata, reserve) { reserve?.(); const id = randomUUID(); attempts.push({ id, metadata }); return id },
    checkpoint() {},
    settle(id, outcome) { attempts.find(attempt => attempt.id === id)!.outcome = outcome },
  }
  return { attempts, service }
}

it('records every direct fallback with actual model and inclusive token subsets', async () => {
  const accounting = recorder()
  let sent = 0
  let reserved = 0
  const provider = new OpenAIChatCompletionsClient({ apiKey: 'synthetic-secret', baseUrl: 'https://synthetic.invalid',
    fetch: async () => {
      sent += 1
      return Response.json({ model: 'actual-synthetic', id: `request-${sent}`,
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130,
          prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 10 } },
        choices: [{ message: { content: sent === 1 ? '{}' : '{"ok":true}' } }] })
    },
  })
  await provider.completeJson({ ...input, usageContext, usageRecorder: accounting.service, onBeforeRequest: () => { reserved += 1 } })
  expect({ sent, reserved }).toEqual({ sent: 2, reserved: 2 })
  expect(accounting.attempts.map(attempt => attempt.metadata.kind)).toEqual(['initial', 'format-repair'])
  expect(accounting.attempts.map(attempt => attempt.metadata)).toMatchObject([1, 2].map(() => ({
    reservationBoundary: { adapter: 'openai-chat', version: 'openai-chat-v1', inputTokens: null,
      outputTokens: null, reason: 'output-limit-unbounded' },
  })))
  expect(accounting.attempts.map(attempt => attempt.outcome)).toEqual([1, 2].map(request => ({
    status: 'succeeded', dispatch: 'dispatched', actualModel: 'actual-synthetic', providerRequestId: `request-${request}`, httpStatus: 200,
    usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130, cachedInputTokens: 20, reasoningOutputTokens: 10, mapping: 'openai-v1',
      raw: { format: 'openai', promptTokens: 100, completionTokens: 30, cachedPromptTokens: 20, reasoningCompletionTokens: 10, totalTokens: 130 } },
  })))
  expect(JSON.stringify(accounting.attempts)).not.toContain('synthetic-secret')
})

it('does not dispatch when recording fails or trusted context is missing', async () => {
  let sent = 0
  const provider = new OpenAIChatCompletionsClient({ apiKey: 'synthetic', baseUrl: 'https://synthetic.invalid',
    fetch: async () => { sent += 1; return Response.json({}) },
  })
  const accounting = recorder()
  await expect(provider.completeJson({ ...input, usageRecorder: accounting.service })).rejects.toMatchObject({ name: 'ChatCompletionRequestControlError' })
  await expect(provider.completeJson({ ...input, usageContext, usageRecorder: { ...accounting.service,
    begin() { throw new Error('Synthetic ledger unavailable') },
  } })).rejects.toMatchObject({ name: 'ChatCompletionRequestControlError' })
  expect(sent).toBe(0)
})

type HostContext = Parameters<typeof createModelBridgeHandler>[0]
type StreamChunk = ReturnType<HostContext['llm']['stream']> extends AsyncIterable<infer Chunk> ? Chunk : never
const secret = 'synthetic-model-bridge-secret-at-least-32-characters'
const route = { provider: 'synthetic-provider', model: 'synthetic' }
async function host(stream: HostContext['llm']['stream'], listModels = async () => [{ id: route.model }]) {
  const handler = createModelBridgeHandler({ llm: { listModels, stream,
    prepareCall: async (config: Parameters<HostContext['llm']['prepareCall']>[0]) => ({ config, stream }) },
    agentDefaultModel: { currentSelection: () => route } } as unknown as HostContext, secret, () => 'default')
  const server = createServer(handler.handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Synthetic server unavailable')
  return { origin: `http://127.0.0.1:${address.port}`, async close() {
    handler.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  } }
}

it.each(['unavailable', 'missing'] as const)('does not count an actual model dispatch when the Host catalog is %s', async failure => {
  let streams = 0
  const bridge = await host(async function *(): AsyncGenerator<StreamChunk> {
    streams += 1
    yield { type: 'finish', reason: { kind: 'stop' } }
  }, async () => {
    if (failure === 'unavailable') throw new Error('Synthetic catalog unavailable')
    return []
  })
  try {
    const accounting = recorder()
    const provider = new DshModelProvider({ origin: bridge.origin, secret, timeoutMs: 2000, maxResponseBytes: 4096 })
    await expect(provider.completeJson({ ...input, model: encodeModelRoute(route), usageContext, usageRecorder: accounting.service }))
      .rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' })
    expect(streams).toBe(0)
    expect(accounting.attempts).toHaveLength(1)
    expect(accounting.attempts[0]?.outcome).toMatchObject({ status: 'failed', dispatch: 'not-dispatched' })
  } finally { await bridge.close() }
})

it('uses one attempt across the real bridge and separately accounts rate-limit resends and format repairs', async () => {
  let streams = 0
  const bridge = await host(async function *(): AsyncGenerator<StreamChunk> {
    if (++streams === 1) { yield { type: 'finish', reason: { kind: 'error', failure: {
      code: 'RATE_LIMIT', message: 'private-provider-message', providerRetryAfterMs: 1,
    } } }; return }
    yield { type: 'text-delta', index: 0, text: streams === 2 ? '{}' : '{"ok":true}' }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 20,
      cacheWriteTokens: 5, reasoningTokens: 10, totalTokens: 155 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  try {
    const accounting = recorder()
    const provider = new DshModelProvider({ origin: bridge.origin, secret, timeoutMs: 2000, maxResponseBytes: 4096 })
    await provider.completeJson({ ...input, model: encodeModelRoute(route), usageContext, usageRecorder: accounting.service })
    expect(streams).toBe(3)
    expect(accounting.attempts.map(attempt => attempt.metadata.kind)).toEqual(['initial', 'rate-limit-retry', 'format-repair'])
    expect(accounting.attempts.map(attempt => attempt.metadata)).toMatchObject([1, 2, 3].map(() => ({
      reservationBoundary: { adapter: 'dsh-bridge', version: 'dsh-sdk-0.2.1-rc.2-v1', inputTokens: null,
        outputTokens: null, reason: 'adapter-metering-unavailable' },
    })))
    expect(new Set(accounting.attempts.map(attempt => attempt.id)).size).toBe(3)
    expect(accounting.attempts[1]?.outcome?.usage).toEqual({ inputTokens: 125, outputTokens: 30,
      cachedInputTokens: 25, reasoningOutputTokens: 10, totalTokens: 155, mapping: 'dsh-v1',
      raw: { format: 'dsh', uncachedInputTokens: 100, outputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 5, reasoningTokens: 10, totalTokens: 155 } })
    expect(JSON.stringify(accounting.attempts)).not.toMatch(/private-provider-message|synthetic-model-bridge-secret/)
  } finally { await bridge.close() }
})

it('retains validated bridge usage delivered before cancellation interrupts the terminal response', async () => {
  const bridge = await host(async function *(options): AsyncGenerator<StreamChunk> {
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }
    await new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('Synthetic abort')), { once: true }))
  })
  try {
    const accounting = recorder()
    const cancelled = new AbortController()
    let received!: () => void
    const firstUsage = new Promise<void>(resolve => { received = resolve })
    const provider = new DshModelProvider({ origin: bridge.origin, secret, timeoutMs: 2000, maxResponseBytes: 4096,
      fetch: async (url, init) => {
        const response = await fetch(url, init)
        return new Response(response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) { controller.enqueue(chunk); received() },
        })), { status: response.status, headers: response.headers })
      },
    })
    const result = provider.completeJson({ ...input, model: encodeModelRoute(route), usageContext,
      usageRecorder: accounting.service, signal: cancelled.signal })
    const rejected = expect(result).rejects.toMatchObject({ code: 'AI_TIMEOUT' })
    await firstUsage
    // Reading the transport chunk and parsing its metadata precede this next task.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    cancelled.abort()
    await rejected
    expect(accounting.attempts).toHaveLength(1)
    expect(accounting.attempts[0]?.outcome).toMatchObject({ status: 'cancelled', dispatch: 'dispatched', usage: {
      inputTokens: 12, outputTokens: 3, totalTokens: 15, mapping: 'dsh-v1',
    } })
  } finally { await bridge.close() }
})

it('retains known Host usage when a later SDK snapshot omits previously reported counters', async () => {
  const bridge = await host(async function *(): AsyncGenerator<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: '{"ok":true}' }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 2,
      cacheWriteTokens: 1, reasoningTokens: 1, totalTokens: 18 } }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  try {
    const accounting = recorder()
    const provider = new DshModelProvider({ origin: bridge.origin, secret, timeoutMs: 2000, maxResponseBytes: 4096 })
    await provider.completeJson({ ...input, model: encodeModelRoute(route), usageContext, usageRecorder: accounting.service })
    expect(accounting.attempts[0]?.outcome).toMatchObject({ status: 'succeeded', dispatch: 'dispatched', usage: {
      inputTokens: 15, outputTokens: 3, cachedInputTokens: 3, reasoningOutputTokens: 1, totalTokens: 18, mapping: 'dsh-v1',
      raw: { format: 'dsh', uncachedInputTokens: 12, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 1, totalTokens: 18 },
    } })
  } finally { await bridge.close() }
})

it('retains trusted usage and dispatch through later empty bridge frames and terminal accounting', async () => {
  const accounting = recorder()
  const model = encodeModelRoute(route)
  const provider = new DshModelProvider({ origin: 'http://127.0.0.1:12345', secret, timeoutMs: 2000, maxResponseBytes: 4096,
    fetch: async (_url, init) => {
      const { attemptId } = JSON.parse(String(init?.body)) as { attemptId: string }
      return new Response([
        { type: 'usage', attemptId, usage: { inputTokens: 15, outputTokens: 3, cachedInputTokens: 3,
          reasoningOutputTokens: 1, totalTokens: 18, mapping: 'dsh-v1' } },
        { type: 'usage', attemptId, usage: unknownModelTokenUsage },
        { type: 'result', attemptId, result: { model, content: '{"ok":true}', accounting: {
          attemptId, status: 'succeeded', dispatch: 'unknown', usage: unknownModelTokenUsage,
        } } },
      ].map(frame => JSON.stringify(frame)).join('\n'), { headers: { 'content-type': 'application/x-ndjson' } })
    },
  })
  await provider.completeJson({ ...input, model, usageContext, usageRecorder: accounting.service })
  expect(accounting.attempts[0]?.outcome).toMatchObject({ status: 'succeeded', dispatch: 'dispatched', usage: {
    inputTokens: 15, outputTokens: 3, cachedInputTokens: 3, reasoningOutputTokens: 1, totalTokens: 18, mapping: 'dsh-v1',
  } })
})

it('keeps a direct HTTP failure and missing usage distinct from zero consumption', async () => {
  const accounting = recorder()
  const provider = new OpenAIChatCompletionsClient({ apiKey: 'synthetic', baseUrl: 'https://synthetic.invalid',
    fetch: async () => Response.json({ error: { message: 'private-model-text' } }, { status: 503 }),
  })
  await expect(provider.completeJson({ ...input, usageContext, usageRecorder: accounting.service }))
    .rejects.toMatchObject({ code: 'AI_REQUEST_FAILED', httpStatus: 503 })
  expect(accounting.attempts).toHaveLength(1)
  expect(accounting.attempts[0]?.outcome).toEqual({ status: 'failed', dispatch: 'dispatched', httpStatus: 503, usage: {
    inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null, totalTokens: null, mapping: 'unknown',
  } })
  expect(JSON.stringify(accounting.attempts)).not.toContain('private-model-text')
})

it('keeps a direct network failure dispatch unknown', async () => {
  const accounting = recorder()
  const provider = new OpenAIChatCompletionsClient({ apiKey: 'synthetic', baseUrl: 'https://synthetic.invalid',
    fetch: async () => { throw new Error('Synthetic connection lost') },
  })
  await expect(provider.completeJson({ ...input, usageContext, usageRecorder: accounting.service }))
    .rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' })
  expect(accounting.attempts).toHaveLength(1)
  expect(accounting.attempts[0]?.outcome).toMatchObject({ status: 'unknown', dispatch: 'unknown', usage: { totalTokens: null } })
})

it('rejects cross-attempt bridge metadata before accepting its usage or result', async () => {
  const accounting = recorder()
  const provider = new DshModelProvider({ origin: 'http://127.0.0.1:12345', secret, timeoutMs: 2000, maxResponseBytes: 4096,
    fetch: async () => new Response(`${JSON.stringify({ type: 'usage', attemptId: randomUUID(), usage: {
      inputTokens: 999, outputTokens: 999, totalTokens: 1998, cachedInputTokens: null, reasoningOutputTokens: null, mapping: 'dsh-v1',
    } })}\n`, { headers: { 'content-type': 'application/x-ndjson' } }),
  })
  await expect(provider.completeJson({ ...input, model: encodeModelRoute(route), usageContext, usageRecorder: accounting.service }))
    .rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' })
  expect(accounting.attempts).toHaveLength(1)
  expect(accounting.attempts[0]?.outcome).toMatchObject({ status: 'unknown', dispatch: 'unknown', usage: { totalTokens: null } })
})

it.each([200, 503] as const)('retains an outstanding request when the bridge returns no body with HTTP %s', async status => {
  const accounting = recorder()
  let completed = 0
  const provider = new DshModelProvider({ origin: 'http://127.0.0.1:12345', secret, timeoutMs: 2000, maxResponseBytes: 4096,
    fetch: async () => new Response(null, { status }),
  })
  await expect(provider.completeJson({ ...input, model: encodeModelRoute(route), usageContext,
    usageRecorder: accounting.service, onRequestComplete: () => { completed += 1 },
  })).rejects.toMatchObject({ code: status === 200 ? 'AI_RESPONSE_INVALID' : 'AI_REQUEST_FAILED' })
  expect(completed).toBe(0)
  expect(accounting.attempts).toHaveLength(1)
  expect(accounting.attempts[0]?.outcome).toMatchObject({ status: 'unknown', dispatch: 'unknown', usage: { totalTokens: null } })
})

it('retains an unknown outstanding request when the bridge disconnects before any frame', async () => {
  const accounting = recorder()
  let completed = 0
  const provider = new DshModelProvider({ origin: 'http://127.0.0.1:12345', secret, timeoutMs: 2000, maxResponseBytes: 4096,
    fetch: async () => new Response('', { headers: { 'content-type': 'application/x-ndjson' } }),
  })
  await expect(provider.completeJson({ ...input, model: encodeModelRoute(route), usageContext,
    usageRecorder: accounting.service, onRequestComplete: () => { completed += 1 },
  })).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' })
  expect(completed).toBe(0)
  expect(accounting.attempts[0]?.outcome).toMatchObject({ status: 'unknown', dispatch: 'unknown', usage: { totalTokens: null } })
})

it('does not authorize automatic resends when the bridge stream ends without a terminal model result', async () => {
  const bridge = await host(async function *(): AsyncGenerator<StreamChunk> {
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }
  })
  try {
    const accounting = recorder()
    let completed = 0
    const provider = new DshModelProvider({ origin: bridge.origin, secret, timeoutMs: 2000, maxResponseBytes: 4096 })
    await expect(provider.completeJson({ ...input, model: encodeModelRoute(route), usageContext,
      usageRecorder: accounting.service, onRequestComplete: () => { completed += 1 },
    })).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' })
    expect(completed).toBe(0)
    expect(accounting.attempts).toHaveLength(1)
    expect(accounting.attempts[0]?.outcome).toMatchObject({ status: 'unknown', dispatch: 'dispatched', usage: { totalTokens: 15 } })
  } finally { await bridge.close() }
})
