import { expect, it } from 'vitest'
import { encodeModelRoute } from '@clinmesh/contracts/model-bridge'
import { DshModelProvider } from '../src/infrastructure/ai/dsh-model-provider.ts'
import { OpenAIChatCompletionsClient, type JsonChatCompletionInput } from '../src/infrastructure/ai/openai-chat-completions.ts'

const request: JsonChatCompletionInput = {
  model: 'synthetic-model', schemaName: 'synthetic', jsonSchema: { type: 'object' },
  systemPrompt: 'Synthetic only', userPayload: {}, validate: value => typeof value === 'object' && value !== null && 'ok' in value,
}

it('checks every direct fallback before fetching and preserves a control failure', async () => {
  let sent = 0
  let checks = 0
  let completed = 0
  const stop = new Error('Synthetic budget exhausted')
  const provider = new OpenAIChatCompletionsClient({ apiKey: 'synthetic', baseUrl: 'https://synthetic.invalid',
    fetch: async () => { sent += 1; return Response.json({ choices: [{ message: { content: '{}' } }] }) },
  })
  await expect(provider.completeJson({ ...request,
    onBeforeRequest: () => { if (++checks === 2) throw stop }, onRequestComplete: () => { completed += 1 },
  })).rejects.toMatchObject({ cause: stop })
  expect({ sent, checks, completed }).toEqual({ sent: 1, checks: 2, completed: 1 })
})

it('checks the DSH rate-limit resend and format repair independently', async () => {
  let sent = 0
  let checks = 0
  let completed = 0
  const stop = new Error('Synthetic budget exhausted')
  const model = encodeModelRoute({ provider: 'synthetic', model: 'synthetic' })
  const provider = new DshModelProvider({ origin: 'http://127.0.0.1:43210', secret: 'synthetic', timeoutMs: 2_000,
    maxResponseBytes: 2_048, fetch: async () => {
      sent += 1
      return sent === 1 ? Response.json({ error: 'MODEL_RATE_LIMIT', retryAfterMs: 1 }, { status: 429 })
        : Response.json({ content: '{}', model })
    },
  })
  await expect(provider.completeJson({ ...request, model,
    onBeforeRequest: () => { if (++checks === 3) throw stop }, onRequestComplete: () => { completed += 1 },
  })).rejects.toMatchObject({ cause: stop })
  expect({ sent, checks, completed }).toEqual({ sent: 2, checks: 3, completed: 2 })
})
