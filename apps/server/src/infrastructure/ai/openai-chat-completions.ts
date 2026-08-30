import { z } from 'zod'

const providerResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().min(1),
      role: z.string().optional(),
    }).passthrough(),
  }).passthrough()).min(1),
  model: z.string().min(1).optional(),
}).passthrough()

export type ChatCompletionsErrorCode =
  | 'AI_REQUEST_FAILED'
  | 'AI_REQUEST_TOO_LARGE'
  | 'AI_RESPONSE_INVALID'
  | 'AI_RESPONSE_TOO_LARGE'
  | 'AI_TIMEOUT'

export class ChatCompletionsError extends Error {
  readonly code: ChatCompletionsErrorCode

  constructor(code: ChatCompletionsErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ChatCompletionsError'
    this.code = code
  }
}

export interface JsonChatCompletionInput {
  jsonSchema: Record<string, unknown>
  model: string
  schemaName: string
  signal?: AbortSignal
  systemPrompt: string
  userPayload: unknown
}

export interface JsonChatCompletionResult {
  content: string
  model: string
}

export interface JsonChatCompletionsProvider {
  completeJson(input: JsonChatCompletionInput): Promise<JsonChatCompletionResult>
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && Number(declaredLength) > maximumBytes) {
    throw new ChatCompletionsError(
      'AI_RESPONSE_TOO_LARGE',
      'The AI provider response exceeds the configured size limit',
    )
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > maximumBytes) {
      await reader.cancel()
      throw new ChatCompletionsError(
        'AI_RESPONSE_TOO_LARGE',
        'The AI provider response exceeds the configured size limit',
      )
    }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export class OpenAIChatCompletionsClient implements JsonChatCompletionsProvider {
  readonly #apiKey: string
  readonly #endpoint: URL
  readonly #fetch: typeof fetch
  readonly #maxRequestBytes: number
  readonly #maxResponseBytes: number
  readonly #timeoutMs: number

  constructor(options: {
    apiKey: string
    baseUrl: string
    fetch?: typeof fetch
    maxRequestBytes?: number
    maxResponseBytes?: number
    timeoutMs?: number
  }) {
    const endpoint = new URL(options.baseUrl)
    if (!['http:', 'https:'].includes(endpoint.protocol)) {
      throw new Error('The AI provider URL must use HTTP or HTTPS')
    }
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/chat/completions`
    endpoint.search = ''
    endpoint.hash = ''
    this.#apiKey = z.string().min(1).parse(options.apiKey)
    this.#endpoint = endpoint
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#maxRequestBytes = options.maxRequestBytes ?? 256 * 1024
    this.#maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024
    this.#timeoutMs = options.timeoutMs ?? 60_000
  }

  async completeJson(input: JsonChatCompletionInput): Promise<JsonChatCompletionResult> {
    const body = JSON.stringify({
      messages: [{ role: 'system', content: input.systemPrompt }, {
        role: 'user',
        content: JSON.stringify(input.userPayload),
      }],
      model: input.model,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: input.schemaName,
          schema: input.jsonSchema,
          strict: true,
        },
      },
      temperature: 0,
    })
    if (Buffer.byteLength(body) > this.#maxRequestBytes) {
      throw new ChatCompletionsError(
        'AI_REQUEST_TOO_LARGE',
        'The AI request exceeds the configured size limit',
      )
    }
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs)
    const signal = input.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([input.signal, timeoutSignal])
    let response: Response
    try {
      response = await this.#fetch(this.#endpoint, {
        body,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        method: 'POST',
        signal,
      })
    } catch (error) {
      if (signal.aborted) {
        throw new ChatCompletionsError('AI_TIMEOUT', 'The AI provider request timed out', {
          cause: error,
        })
      }
      throw new ChatCompletionsError('AI_REQUEST_FAILED', 'The AI provider request failed', {
        cause: error,
      })
    }
    if (!response.ok) {
      throw new ChatCompletionsError(
        'AI_REQUEST_FAILED',
        `The AI provider returned HTTP ${response.status}`,
      )
    }
    try {
      const parsed = providerResponseSchema.parse(JSON.parse(
        await readBoundedResponse(response, this.#maxResponseBytes),
      ))
      return {
        content: parsed.choices[0]!.message.content,
        model: parsed.model ?? input.model,
      }
    } catch (error) {
      if (error instanceof ChatCompletionsError) throw error
      throw new ChatCompletionsError(
        'AI_RESPONSE_INVALID',
        'The AI provider returned an invalid response',
        { cause: error },
      )
    }
  }
}
