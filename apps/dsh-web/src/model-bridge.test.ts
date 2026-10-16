import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { dshDefaultModel } from '@clinmesh/contracts/model-bridge'
import { afterEach, expect, it } from 'vitest'
import { DshModelProvider } from '../../server/src/infrastructure/ai/dsh-model-provider.ts'
import { createModelBridgeHandler } from './model-bridge.ts'
import { setTimeout as delay } from 'node:timers/promises'

type HostContext = Parameters<typeof createModelBridgeHandler>[0]
type GenerateOptions = Parameters<HostContext['llm']['stream']>[0]
type StreamChunk = ReturnType<HostContext['llm']['stream']> extends AsyncIterable<infer Chunk> ? Chunk : never

const secret = 'synthetic-model-bridge-secret-at-least-32-characters'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function host(compression: 'none' | 'gzip', providerTimeout = false, finishGate?: Promise<void>) {
  const ctx = new Context()
  cleanup.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression, compressionThresholdBytes: 0 })
  const calls: GenerateOptions[] = []
  const modelContext = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'synthetic-provider', model: 'synthetic-model' }) },
    llm: {
      listModels: async () => [{ provider: 'synthetic-provider', id: 'synthetic-model', name: 'Synthetic model' }],
      async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
        calls.push(options)
        if (finishGate !== undefined) {
          yield { type: 'text-delta', index: 0, text: '{"ok":true}' }
          await finishGate
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (providerTimeout) {
          yield { type: 'finish', reason: { kind: 'error', failure: {
            code: 'TIMEOUT', message: 'private synthetic provider failure',
          } } }
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

it.each(['none', 'gzip'] as const)('returns a safe deadline error through the actual %s host and cancels the model stream', async compression => {
  const dsh = await host(compression)
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 100, maxResponseBytes: 2048 })
  await expect(provider.completeJson(input)).rejects.toMatchObject({
    code: 'AI_TIMEOUT', message: 'The DSH model request timed out',
  })
  expect(dsh.calls).toHaveLength(1)
  expect(dsh.calls[0]?.signal?.aborted).toBe(true)
})

it('preserves a Provider timeout through gzip without exposing its private message', async () => {
  const dsh = await host('gzip', true)
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 100, maxResponseBytes: 2048 })
  await expect(provider.completeJson(input)).rejects.toMatchObject({
    code: 'AI_TIMEOUT', message: 'The DSH model request timed out',
  })
})

it('reports Provider first text independently of the buffered gzip response', async () => {
  let release!: () => void
  const dsh = await host('gzip', false, new Promise<void>(resolve => { release = resolve }))
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
