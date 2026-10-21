import { Context } from '@deepseek-ai/cordis'
import Llm, { LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { isDoctorDelegation } from './doctor-delegation.ts'
import { syntheticHostUsageControl } from './doctor-input-fixture.ts'
import { hostDoctorUsageAdmissionSchema, hostDoctorUsageObservationSchema } from '@clinmesh/contracts/model-usage'

it.each(['missing-adapter', 'unsupported-effort'] as const)('does not count SDK preflight rejection as a request: %s', async failure => {
  const ctx = new Context()
  let streams = 0
  let admissions = 0
  class SyntheticModel extends LlmAdapter {
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
    override async *stream(_request: GenerateOptions): AsyncIterable<StreamChunk> {
      streams++
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  try {
    await ctx.plugin(Llm)
    if (failure === 'unsupported-effort') ctx.llm.registerAdapter(['synthetic'], new SyntheticModel())
    await expect(isDoctorDelegation(ctx, { provider: 'synthetic', model: 'classifier',
      ...(failure === 'unsupported-effort' ? { reasoningEffort: ReasoningEffortId('unsupported') } : {}) },
    '替我问清头晕的诱因。', new AbortController().signal, { ...syntheticHostUsageControl,
      secret: 'synthetic-only-host-secret', permit: 'synthetic-only-input-permit-at-least-32-characters',
      fetch: (async (input: RequestInfo | URL) => {
        if (new URL(String(input)).pathname.endsWith('/admit')) admissions++
        return syntheticHostUsageControl.fetch(input)
      }) as typeof fetch,
    })).rejects.toThrow()
    expect(streams).toBe(0)
    expect(admissions).toBe(0)
  } finally { await ctx.fiber.dispose() }
})

it('admits the prepared SDK defaults before dispatching exactly one bounded classifier request', async () => {
  const ctx = new Context()
  let admitted = false
  let streams = 0
  const reports: unknown[] = []
  class SyntheticModel extends LlmAdapter {
    override async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, reasoning: {
        efforts: [{ id: ReasoningEffortId('synthetic-effort'), name: 'Synthetic' }], defaultEffort: ReasoningEffortId('synthetic-effort') } }
    }
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      expect(admitted).toBe(true)
      expect(request).toMatchObject({ model: 'classifier', maxTokens: 1024, reasoningEffort: 'synthetic-effort' })
      streams++
      yield { type: 'text-delta', index: 0, text: '{"intent":"discuss","evidence":""}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  try {
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['synthetic'], new SyntheticModel())
    expect(await isDoctorDelegation(ctx, { provider: 'synthetic', model: 'classifier' }, '讨论头晕的诱因。',
      new AbortController().signal, { ...syntheticHostUsageControl, secret: 'synthetic-only-host-secret',
        permit: 'synthetic-only-input-permit-at-least-32-characters', fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const body: unknown = JSON.parse(String(init?.body))
          if (new URL(String(input)).pathname.endsWith('/admit')) {
            expect(hostDoctorUsageAdmissionSchema.parse(body)).toMatchObject({ provider: 'synthetic', model: 'classifier', reasoningEffort: 'synthetic-effort' })
            admitted = true
          } else reports.push(hostDoctorUsageObservationSchema.parse(body))
          return syntheticHostUsageControl.fetch(input)
        }) as typeof fetch })).toBe(false)
    expect(streams).toBe(1)
    expect(reports).toMatchObject([{ phase: 'terminal', outcome: { status: 'succeeded', dispatch: 'dispatched', actualModel: 'classifier' } }])
  } finally { await ctx.fiber.dispose() }
})
