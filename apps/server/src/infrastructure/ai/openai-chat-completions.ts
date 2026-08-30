import { z } from 'zod'
import { fromMarkdown } from 'mdast-util-from-markdown'

const providerMessageSchema = z.object({
  content: z.string().nullable().optional(),
  role: z.string().optional(),
  tool_calls: z.array(z.object({
    function: z.object({
      arguments: z.string().min(1),
      name: z.string().min(1),
    }).passthrough(),
    type: z.literal('function'),
  }).passthrough()).min(1).optional(),
}).passthrough()

const providerResponseSchema = z.object({
  choices: z.array(z.object({ message: providerMessageSchema }).passthrough()).min(1),
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
  readonly httpStatus: number | undefined
  readonly validationIssues: Array<{ code: string; path: string }> | undefined

  constructor(
    code: ChatCompletionsErrorCode,
    message: string,
    options?: ErrorOptions & {
      httpStatus?: number
      validationIssues?: Array<{ code: string; path: string }>
    },
  ) {
    super(message, options)
    this.name = 'ChatCompletionsError'
    this.code = code
    this.httpStatus = options?.httpStatus
    this.validationIssues = options?.validationIssues
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

function singleJsonCodeBlock(value: string): string | undefined {
  const document = fromMarkdown(value)
  if (document.children.length !== 1) return undefined
  const node = document.children[0]
  if (node?.type !== 'code' || (node.lang !== null && node.lang !== 'json')) return undefined
  return node.value
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
    const commonBody = {
      messages: [{ role: 'system', content: input.systemPrompt }, {
        role: 'user',
        content: JSON.stringify(input.userPayload),
      }],
      model: input.model,
      temperature: 0,
    }
    const jsonSchemaBody = {
      ...commonBody,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: input.schemaName,
          schema: input.jsonSchema,
          strict: true,
        },
      },
    }
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs)
    const signal = input.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([input.signal, timeoutSignal])
    const request = async (payload: unknown): Promise<Response> => {
      const body = JSON.stringify(payload)
      if (Buffer.byteLength(body) > this.#maxRequestBytes) {
        throw new ChatCompletionsError(
          'AI_REQUEST_TOO_LARGE',
          'The AI request exceeds the configured size limit',
        )
      }
      try {
        return await this.#fetch(this.#endpoint, {
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
    }
    let response = await request(jsonSchemaBody)
    try {
      const parseResponse = async (value: Response) => {
        if (!value.ok) {
          throw new ChatCompletionsError(
            'AI_REQUEST_FAILED',
            `The AI provider returned HTTP ${value.status}`,
            { httpStatus: value.status },
          )
        }
        return providerResponseSchema.parse(JSON.parse(
          await readBoundedResponse(value, this.#maxResponseBytes),
        ))
      }
      const structuredJsonContent = (parsed: z.infer<typeof providerResponseSchema>) => {
        const message = parsed.choices[0]!.message
        const content = typeof message.content === 'string' && message.content.length > 0
          ? message.content
          : message.tool_calls?.find(
              call => call.function.name === input.schemaName,
            )?.function.arguments
        if (content === undefined) return undefined
        const normalized = singleJsonCodeBlock(content) ?? content
        try {
          JSON.parse(normalized)
          return normalized
        } catch {
          return undefined
        }
      }
      let parsed: z.infer<typeof providerResponseSchema> | undefined
      let content: string | undefined
      if (response.status === 400) {
        await response.body?.cancel()
      } else {
        parsed = await parseResponse(response)
        content = structuredJsonContent(parsed)
      }
      if (content === undefined) {
        response = await request({
          ...commonBody,
          tool_choice: { type: 'function', function: { name: input.schemaName } },
          tools: [{
            type: 'function',
            function: {
              name: input.schemaName,
              description: 'Return the validated structured result.',
              parameters: input.jsonSchema,
            },
          }],
        })
        parsed = await parseResponse(response)
        content = structuredJsonContent(parsed)
      }
      if (content === undefined) {
        response = await request({
          ...commonBody,
          messages: [{
            role: 'system',
            content: [
              input.systemPrompt,
              'Return exactly one JSON object matching this JSON Schema:',
              JSON.stringify(input.jsonSchema),
            ].join('\n'),
          }, {
            role: 'user',
            content: JSON.stringify(input.userPayload),
          }],
        })
        parsed = await parseResponse(response)
        content = structuredJsonContent(parsed)
      }
      if (content === undefined || parsed === undefined) {
        throw new Error('The expected structured result was not returned')
      }
      return {
        content,
        model: parsed.model ?? input.model,
      }
    } catch (error) {
      if (error instanceof ChatCompletionsError) throw error
      throw new ChatCompletionsError(
        'AI_RESPONSE_INVALID',
        'The AI provider returned an invalid response',
        {
          cause: error,
          ...(error instanceof z.ZodError
            ? {
                validationIssues: error.issues.map(issue => ({
                  code: issue.code,
                  path: issue.path.join('.'),
                })),
              }
            : {}),
        },
      )
    }
  }
}
