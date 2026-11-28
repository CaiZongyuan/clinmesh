import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { type ModelUsageContext, type ModelUsageOutcome } from '@clinmesh/contracts/model-usage'
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
