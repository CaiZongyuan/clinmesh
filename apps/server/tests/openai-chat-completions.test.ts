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

  it('normalizes one JSON code block returned by the primary schema request', async () => {
    const client = new OpenAIChatCompletionsClient({
      apiKey: secret,
      baseUrl: 'https://openrouter.example/api/v1',
      fetch: async () => Response.json({
        choices: [{ message: { content: '```json\n{"chiefComplaint":"头晕"}\n```' } }],
      }),
    })

    await expect(client.completeJson(completionInput)).resolves.toMatchObject({
      content: '{"chiefComplaint":"头晕"}',
    })
  })

  it('uses the required schema tool when the primary response is not JSON', async () => {
    const bodies: unknown[] = []
    const client = new OpenAIChatCompletionsClient({
      apiKey: secret,
      baseUrl: 'https://openrouter.example/api/v1',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        if (bodies.length === 1) {
          return Response.json({ choices: [{ message: { content: 'I will explain the result.' } }] })
        }
        return Response.json({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                function: {
                  arguments: '{"chiefComplaint":"头晕"}',
                  name: 'patient_brief',
                },
                type: 'function',
              }],
            },
          }],
        })
      },
    })

    await expect(client.completeJson(completionInput)).resolves.toMatchObject({
      content: '{"chiefComplaint":"头晕"}',
    })
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toHaveProperty('tool_choice')
  })

  it('prefers valid required-tool arguments over non-JSON message content', async () => {
    const bodies: unknown[] = []
    const client = new OpenAIChatCompletionsClient({
      apiKey: secret,
      baseUrl: 'https://openrouter.example/api/v1',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        if (bodies.length === 1) return new Response('{}', { status: 400 })
        return Response.json({
          choices: [{
            message: {
              content: ' ',
              role: 'assistant',
              tool_calls: [{
                function: {
                  arguments: '{"chiefComplaint":"头晕"}',
                  name: 'patient_brief',
                },
                id: 'synthetic-tool-call',
                type: 'function',
              }],
            },
          }],
          model: 'resolved-tool-model',
        })
      },
    })

    await expect(client.completeJson(completionInput)).resolves.toEqual({
      content: '{"chiefComplaint":"头晕"}',
      model: 'resolved-tool-model',
    })
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toMatchObject({
      model: 'fake-brief-model',
      tool_choice: { function: { name: 'patient_brief' }, type: 'function' },
      tools: [{
        function: {
          name: 'patient_brief',
          parameters: completionInput.jsonSchema,
        },
        type: 'function',
      }],
    })
    expect(bodies[1]).not.toHaveProperty('response_format')
  })

  it('uses prompt-constrained JSON only when the required tool returns no structured output', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const client = new OpenAIChatCompletionsClient({
      apiKey: secret,
      baseUrl: 'https://openrouter.example/api/v1',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        if (bodies.length === 1) return new Response('{}', { status: 400 })
        if (bodies.length === 2) {
          return Response.json({
            choices: [{ message: { content: null, reasoning: 'synthetic reasoning' } }],
          })
        }
        return Response.json({
          choices: [{ message: { content: '```json\n{"chiefComplaint":"头晕"}\n```' } }],
          model: 'resolved-prompt-model',
        })
      },
    })

    await expect(client.completeJson(completionInput)).resolves.toEqual({
      content: '{"chiefComplaint":"头晕"}',
      model: 'resolved-prompt-model',
    })
    expect(bodies).toHaveLength(3)
    expect(bodies[2]).not.toHaveProperty('response_format')
    expect(bodies[2]).not.toHaveProperty('tools')
    expect(JSON.stringify(bodies[2]?.messages)).toContain('additionalProperties')
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
