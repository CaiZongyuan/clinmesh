import { z } from 'zod'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { modelUsageOutcomeSchema, unknownModelTokenUsage, type ModelUsageContext, type ModelUsageOutcome } from '@clinmesh/contracts/model-usage'
import type { ModelUsageRecorder } from '../../application/model-usage-lifecycle.ts'

const providerMessageSchema = z.object({
  content: z.string().nullable().optional(),
  role: z.string().optional(),
  tool_calls: z.array(z.object({
    function: z.object({
      arguments: z.string(),
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
  | 'AI_AUTH_FAILED'
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

export class StructuredOutputValidationError extends Error {
  constructor(readonly code: 'quality_source' | 'quality_coverage' | 'quality_scope', readonly path: string) {
    super('The structured output failed a domain validation check')
    this.name = 'StructuredOutputValidationError'
  }
}

/** Control failures must never become provider retry or format-repair failures. */
export class ChatCompletionRequestControlError extends Error {
  constructor(cause: unknown) {
    super('The model request was stopped by its execution control', { cause })
    this.name = 'ChatCompletionRequestControlError'
  }
}

export function invokeChatCompletionRequestControl(hook: (() => void) | undefined): void {
  try { hook?.() } catch (cause) { throw new ChatCompletionRequestControlError(cause) }
}

/** The ledger and the existing task gate share the recorder's reservation transaction. */
export function beginChatCompletionUsage(input: Pick<JsonChatCompletionInput, 'usageContext' | 'usageRecorder' | 'onBeforeRequest' | 'schemaName'>,
  metadata: Omit<Parameters<ModelUsageRecorder['begin']>[0], 'context' | 'feature'>): string | undefined {
  try {
    if (input.usageRecorder === undefined) { input.onBeforeRequest?.(); return undefined }
    if (input.usageContext === undefined) throw new Error('Trusted model usage context is required')
    return input.usageRecorder.begin({ ...metadata, context: input.usageContext, feature: input.schemaName }, input.onBeforeRequest)
  } catch (cause) { throw new ChatCompletionRequestControlError(cause) }
}

export function settleChatCompletionUsage(input: Pick<JsonChatCompletionInput, 'usageRecorder'>, attemptId: string | undefined,
  outcome: ModelUsageOutcome): void {
  if (attemptId === undefined) return
  invokeChatCompletionRequestControl(() => input.usageRecorder!.settle(attemptId, outcome))
}

const usageCount = z.number().int().nonnegative().safe()
const openAIUsageSchema = z.object({
  prompt_tokens: usageCount.optional(), completion_tokens: usageCount.optional(), total_tokens: usageCount.optional(),
  prompt_tokens_details: z.object({ cached_tokens: usageCount.optional() }).optional(),
  completion_tokens_details: z.object({ reasoning_tokens: usageCount.optional() }).optional(),
  prompt_cache_hit_tokens: usageCount.optional(),
})
function openAIOutcome(response: Response, value: unknown): ModelUsageOutcome {
  const metadata = z.object({ model: z.unknown().optional(), id: z.unknown().optional(), usage: z.unknown().optional() }).safeParse(value)
  const usage = openAIUsageSchema.safeParse(metadata.success ? metadata.data.usage : undefined)
  const actualModel = modelUsageOutcomeSchema.shape.actualModel.safeParse(metadata.success ? metadata.data.model : undefined)
  const providerRequestId = modelUsageOutcomeSchema.shape.providerRequestId.safeParse(
    response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? (metadata.success ? metadata.data.id : undefined))
  const counts = usage.success ? usage.data : undefined
  const inputTokens = counts?.prompt_tokens ?? null
  const outputTokens = counts?.completion_tokens ?? null
  const cached = counts?.prompt_tokens_details?.cached_tokens ?? counts?.prompt_cache_hit_tokens ?? null
  const reasoning = counts?.completion_tokens_details?.reasoning_tokens ?? null
  const derivedTotal = inputTokens !== null && outputTokens !== null && Number.isSafeInteger(inputTokens + outputTokens) ? inputTokens + outputTokens : null
  return { status: response.ok ? 'succeeded' : 'failed', dispatch: 'dispatched', httpStatus: response.status,
    ...(actualModel.success && actualModel.data !== undefined ? { actualModel: actualModel.data } : {}),
    ...(providerRequestId.success && providerRequestId.data !== undefined ? { providerRequestId: providerRequestId.data } : {}),
    usage: counts === undefined ? unknownModelTokenUsage : { inputTokens, outputTokens,
      totalTokens: counts.total_tokens === undefined ? derivedTotal : derivedTotal === null || counts.total_tokens === derivedTotal ? counts.total_tokens : null,
      cachedInputTokens: cached !== null && (inputTokens === null || cached <= inputTokens) ? cached : null,
      reasoningOutputTokens: reasoning !== null && (outputTokens === null || reasoning <= outputTokens) ? reasoning : null,
      mapping: 'openai-v1', raw: { format: 'openai', promptTokens: inputTokens, completionTokens: outputTokens,
        cachedPromptTokens: cached, reasoningCompletionTokens: reasoning, totalTokens: counts.total_tokens ?? null } },
  }
}

export interface JsonChatCompletionInput {
  usageContext?: ModelUsageContext
  usageRecorder?: ModelUsageRecorder
  usageKind?: 'initial' | 'format-repair'
  /** Synchronous, atomic reservation immediately before each actual completion fetch. */
  onBeforeRequest?: () => void
  /** A complete transport outcome arrived; headers alone do not establish this. */
  onRequestComplete?: () => void
  maxAttempts?: 1 | 2
  /** Serialized request limit, including schema and every format-repair prompt. */
  maxInputBytes?: number
  onResponse?: () => void
  /** Provider-observed first text, excluding transport; absent when unavailable. */
  onFirstText?: (elapsedMs: number) => void
  jsonSchema: Record<string, unknown>
  model: string
  schemaName: string
  signal?: AbortSignal
  systemPrompt: string
  userPayload: unknown
  validate?: (value: unknown) => boolean
}

export interface JsonChatCompletionResult {
  content: string
  model: string
}

export interface JsonChatCompletionsProvider {
  readonly supportsUsageAccounting?: boolean
  /** True only when every real completion fetch invokes the request lifecycle hooks. */
  readonly supportsRequestControl?: boolean
  resolveModel?(model: string, signal?: AbortSignal): Promise<string>
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
  readonly supportsRequestControl = true
  readonly supportsUsageAccounting = true
  readonly #apiKey: string
  readonly #endpoint: URL
  readonly #fetch: typeof fetch
  readonly #jsonSchemaRejectedModels = new Set<string>()
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
    let attempts = 0
    const responseContents = new WeakMap<Response, string>()
    const request = async (payload: unknown): Promise<Response> => {
      if (attempts >= (input.maxAttempts ?? 3)) {
        throw new ChatCompletionsError('AI_RESPONSE_INVALID', 'The structured response attempt budget was exhausted')
      }
      attempts += 1
      const body = JSON.stringify(payload)
      if (Buffer.byteLength(body) > Math.min(this.#maxRequestBytes, input.maxInputBytes ?? Infinity)) {
        throw new ChatCompletionsError(
          'AI_REQUEST_TOO_LARGE',
          'The AI request exceeds the configured size limit',
        )
      }
      if (signal.aborted) throw new ChatCompletionsError('AI_TIMEOUT', 'The AI provider request was cancelled or timed out')
      const attemptId = beginChatCompletionUsage(input, { provider: this.#endpoint.hostname, model: input.model,
        outputLimit: null, kind: attempts === 1 ? input.usageKind ?? 'initial' : 'format-repair' })
      let settled = false
      try {
        const response = await this.#fetch(this.#endpoint, {
          body,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${this.#apiKey}`,
            'content-type': 'application/json',
          },
          method: 'POST',
          signal,
        })
        input.onResponse?.()
        const content = await readBoundedResponse(response, this.#maxResponseBytes)
        responseContents.set(response, content)
        invokeChatCompletionRequestControl(input.onRequestComplete)
        let value: unknown
        try { value = JSON.parse(content) } catch { /* Only validated metadata reaches the ledger. */ }
        settled = true
        settleChatCompletionUsage(input, attemptId, openAIOutcome(response, value))
        return response
      } catch (error) {
        if (!settled) settleChatCompletionUsage(input, attemptId, {
          status: input.signal?.aborted ? 'cancelled' : 'unknown', dispatch: 'unknown', usage: unknownModelTokenUsage,
        })
        if (error instanceof ChatCompletionRequestControlError) throw error
        if (error instanceof ChatCompletionsError) throw error
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
    let response: Response | undefined
    let validationError: unknown
    try {
      const parseResponse = async (value: Response) => {
        if (!value.ok) {
          throw new ChatCompletionsError(
            'AI_REQUEST_FAILED',
            `The AI provider returned HTTP ${value.status}`,
            { httpStatus: value.status },
          )
        }
        const content = responseContents.get(value)!
        return providerResponseSchema.parse(JSON.parse(content))
      }
      const structuredJsonContent = (path: string, parsed: z.infer<typeof providerResponseSchema>) => {
        const message = parsed.choices[0]!.message
        const candidates = [
          message.tool_calls?.find(
            call => call.function.name === input.schemaName,
          )?.function.arguments,
          typeof message.content === 'string' && message.content.length > 0
            ? message.content
            : undefined,
        ]
        for (const candidate of candidates) {
          if (candidate === undefined) continue
          const normalized = singleJsonCodeBlock(candidate) ?? candidate
          try {
            const value: unknown = JSON.parse(normalized)
            if (input.validate?.(value) === false) {
              validationError = new Error('The structured output did not match its schema')
              console.warn(`[ai-chat-completions] ${path} content failed schema validation (model ${input.model})`)
              continue
            }
            return normalized
          } catch (error) {
            validationError = error
            const category = error instanceof SyntaxError ? 'JSON syntax' : error instanceof StructuredOutputValidationError ? error.code : 'schema validation'
            console.warn(`[ai-chat-completions] ${path} content failed ${category} (model ${input.model})`)
            continue
          }
        }
        return undefined
      }
      let parsed: z.infer<typeof providerResponseSchema> | undefined
      let content: string | undefined
      let contentPath: string | undefined
      if (this.#jsonSchemaRejectedModels.has(input.model)) {
        // 该模型此前对 JSON-schema 请求返回 400，确定性失败不再重付学费。
      } else {
        response = await request(jsonSchemaBody)
        if (response.status === 400) {
          this.#jsonSchemaRejectedModels.add(input.model)
          console.warn(`[ai-chat-completions] model ${input.model} rejected the JSON-schema request with HTTP 400; skipping it for future calls`)
        } else {
          parsed = await parseResponse(response)
          contentPath = 'JSON-schema request'
          content = structuredJsonContent(contentPath, parsed)
        }
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
        contentPath = 'required tool request'
        content = structuredJsonContent(contentPath, parsed)
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
        contentPath = 'prompt request'
        content = structuredJsonContent(contentPath, parsed)
      }
      if (content === undefined || parsed === undefined || contentPath === undefined) {
        throw validationError ?? new Error('The expected structured result was not returned')
      }
      console.info(`[ai-chat-completions] structured result via ${contentPath} (model ${parsed.model ?? input.model})`)
      return {
        content,
        model: parsed.model ?? input.model,
      }
    } catch (error) {
      if (error instanceof ChatCompletionRequestControlError) throw error
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
            : error instanceof StructuredOutputValidationError ? { validationIssues: [{ code: error.code, path: error.path }] }
              : error instanceof SyntaxError ? { validationIssues: [{ code: 'invalid_json', path: '' }] } : {}),
        },
      )
    }
  }
}
