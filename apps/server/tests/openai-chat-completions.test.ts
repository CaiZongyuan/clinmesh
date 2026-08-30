import { describe, expect, it } from 'vitest'
import {
  ChatCompletionsError,
  OpenAIChatCompletionsClient,
} from '../src/infrastructure/ai/openai-chat-completions.ts'

const secret = 'test-secret-that-must-not-escape'
const completionInput = {
  jsonSchema: {
    additionalProperties: false,
    properties: { chiefComplaint: { type: 'string' } },
    required: ['chiefComplaint'],
    type: 'object',
  },
  model: 'fake-brief-model',
  schemaName: 'patient_brief',
  systemPrompt: 'Return one synthetic Patient Brief.',
  userPayload: { patient: { age: 50 } },
}

describe('OpenAI-compatible Chat Completions client', () => {
  it('uses one fixed JSON-schema request and returns bounded message content', async () => {
    let requestUrl = ''
    let requestInit: RequestInit | undefined
    const client = new OpenAIChatCompletionsClient({
      apiKey: secret,
      baseUrl: 'https://openrouter.example/api/v1/',
      fetch: async (input, init) => {
        requestUrl = String(input)
        requestInit = init
        return Response.json({
          choices: [{ message: { content: '{"chiefComplaint":"头晕"}', role: 'assistant' } }],
          model: 'resolved-brief-model',
        })
      },
    })

    await expect(client.completeJson(completionInput)).resolves.toEqual({
      content: '{"chiefComplaint":"头晕"}',
      model: 'resolved-brief-model',
    })
    expect(requestUrl).toBe('https://openrouter.example/api/v1/chat/completions')
    expect(new Headers(requestInit?.headers).get('authorization')).toBe(`Bearer ${secret}`)
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      model: 'fake-brief-model',
      response_format: {
        json_schema: { name: 'patient_brief', strict: true },
        type: 'json_schema',
      },
      temperature: 0,
    })
  })

  it.each([
    {
      code: 'AI_REQUEST_FAILED',
      fetch: async () => new Response('provider body with secret-like text', { status: 429 }),
      options: {},
    },
    {
      code: 'AI_RESPONSE_INVALID',
      fetch: async () => new Response('{not-json', { status: 200 }),
      options: {},
    },
    {
      code: 'AI_RESPONSE_TOO_LARGE',
      fetch: async () => Response.json({ choices: [{ message: { content: 'x'.repeat(1_000) } }] }),
      options: { maxResponseBytes: 100 },
    },
  ])('returns $code without exposing credentials', async ({ code, fetch, options }) => {
    const client = new OpenAIChatCompletionsClient({
      apiKey: secret,
      baseUrl: 'https://openrouter.example/api/v1',
      fetch,
      ...options,
    })
    const error = await client.completeJson(completionInput).catch(value => value)

    expect(error).toBeInstanceOf(ChatCompletionsError)
    expect(error).toMatchObject({ code })
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(String(error)).not.toContain(secret)
  })

  it('classifies an aborted request as a timeout', async () => {
    const client = new OpenAIChatCompletionsClient({
      apiKey: secret,
      baseUrl: 'https://openrouter.example/api/v1',
      fetch: async (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
      timeoutMs: 5,
    })

    await expect(client.completeJson(completionInput)).rejects.toMatchObject({
      code: 'AI_TIMEOUT',
    })
  })
})
