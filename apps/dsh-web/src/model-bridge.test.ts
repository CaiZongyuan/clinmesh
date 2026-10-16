import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { dshDefaultModel } from '@clinmesh/contracts/model-bridge'
import { afterEach, expect, it } from 'vitest'
import { DshModelProvider } from '../../server/src/infrastructure/ai/dsh-model-provider.ts'
import { createModelBridgeHandler } from './model-bridge.ts'

type HostContext = Parameters<typeof createModelBridgeHandler>[0]
type GenerateOptions = Parameters<HostContext['llm']['stream']>[0]
type StreamChunk = ReturnType<HostContext['llm']['stream']> extends AsyncIterable<infer Chunk> ? Chunk : never

const secret = 'synthetic-model-bridge-secret-at-least-32-characters'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function host(compression: 'none' | 'gzip', providerFailure?: 'TIMEOUT' | 'RATE_LIMIT') {
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
  const dsh = await host('gzip', 'TIMEOUT')
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 100, maxResponseBytes: 2048 })
  await expect(provider.completeJson(input)).rejects.toMatchObject({
    code: 'AI_TIMEOUT', message: 'The DSH model request timed out',
  })
})

it.each(['none', 'gzip'] as const)('recovers from one rate limit through the actual %s host', async compression => {
  const dsh = await host(compression, 'RATE_LIMIT')
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 2048 })
  const result = await provider.completeJson(input)
  expect(JSON.parse(result.content)).toEqual({ ok: true })
  expect(dsh.calls).toHaveLength(2)
})
