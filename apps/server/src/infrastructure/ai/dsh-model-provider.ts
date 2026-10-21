import { dshDefaultModel, decodeModelRoute, modelBridgeAccountingMediaType, modelBridgeFrameSchema,
  modelBridgeErrorSchema, modelBridgeFirstTextHeader, modelBridgePath, modelBridgeResponseSchema } from '@clinmesh/contracts/model-bridge'
import { unknownModelTokenUsage, type ModelTokenUsage, type ModelUsageOutcome } from '@clinmesh/contracts/model-usage'
import { beginChatCompletionUsage, settleChatCompletionUsage, ChatCompletionRequestControlError, invokeChatCompletionRequestControl, ChatCompletionsError, StructuredOutputValidationError, type JsonChatCompletionInput, type JsonChatCompletionsProvider } from './openai-chat-completions.ts'
import { z, ZodError } from 'zod'
import { setTimeout as delay } from 'node:timers/promises'

export class DshModelProvider implements JsonChatCompletionsProvider {
  readonly supportsRequestControl = true
  readonly supportsUsageAccounting = true
  readonly #endpoint: URL
  constructor(private readonly options: { origin: string; secret: string; timeoutMs: number; maxResponseBytes: number; fetch?: typeof fetch }) {
    this.#endpoint = new URL(modelBridgePath, options.origin)
    if (this.#endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(this.#endpoint.hostname)) {
      throw new Error('The DSH model bridge requires an HTTP loopback origin')
    }
  }

  async resolveModel(model: string, signal?: AbortSignal, deadline = performance.now() + this.options.timeoutMs): Promise<string> {
    if (model !== dshDefaultModel) { decodeModelRoute(model); return model }
    const result = await this.#request({ operation: 'resolve' }, signal, undefined, deadline)
    decodeModelRoute(result.model)
    return result.model
  }

  async completeJson(input: JsonChatCompletionInput) {
    const deadline = performance.now() + this.options.timeoutMs
    const model = await this.resolveModel(input.model, input.signal, deadline)
    const rateLimitRetry = { available: true }
    let issues: Array<{ code: string; path: string }> = []
    let validationError: unknown
    for (let attempt = 0; attempt < (input.maxAttempts ?? 2); attempt++) {
      validationError = undefined
      const result = await this.#request({
        operation: 'complete', model, schemaName: input.schemaName, jsonSchema: input.jsonSchema,
        systemPrompt: attempt === 0 ? input.systemPrompt : `${input.systemPrompt}\nThe previous response failed validation: ${JSON.stringify(issues)}. Generate a corrected JSON object using the original data and schema. Do not include $schema or other schema metadata.`,
        userPayload: input.userPayload,
      }, input.signal, rateLimitRetry, deadline, input.onResponse, input.maxInputBytes, input, attempt === 0 ? input.usageKind ?? 'initial' : 'format-repair')
      if (result.firstTextMs !== undefined) input.onFirstText?.(result.firstTextMs)
      if (result.model !== model) throw new ChatCompletionsError('AI_RESPONSE_INVALID', 'The model bridge changed the pinned route')
      try {
        let value: unknown = JSON.parse(result.content ?? '')
        // Only a known schema annotation is removable. All business fields remain subject to validation.
        if (typeof value === 'object' && value !== null && !Array.isArray(value) && '$schema' in value
          && typeof value.$schema === 'string') {
          const { $schema: _annotation, ...data } = value
          value = data
        }
        if (input.validate === undefined || input.validate(value)) return { content: JSON.stringify(value), model }
        issues = [{ code: 'schema_mismatch', path: '' }]
      } catch (error) {
        validationError = error
        issues = error instanceof ZodError ? error.issues.slice(0, 12).map(issue => ({
          code: issue.code, path: issue.path.join('.').slice(0, 200),
        })) : error instanceof StructuredOutputValidationError ? [{ code: error.code, path: error.path }]
          : [{ code: error instanceof SyntaxError ? 'invalid_json' : 'schema_mismatch', path: '' }]
      }
    }
    throw new ChatCompletionsError('AI_RESPONSE_INVALID', 'The DSH model returned invalid structured output', {
      validationIssues: issues, cause: validationError,
    })
  }

  async #request(payload: Record<string, unknown> & { operation: 'resolve' | 'complete' }, callerSignal?: AbortSignal,
    rateLimitRetry?: { available: boolean }, deadline = performance.now() + this.options.timeoutMs, onResponse?: () => void,
    maxInputBytes = 256 * 1024, control?: JsonChatCompletionInput, requestKind: 'initial' | 'format-repair' = 'initial') {
    const timeoutMs = Math.ceil(deadline - performance.now())
    if (timeoutMs < 100) throw new ChatCompletionsError('AI_TIMEOUT', 'The DSH model request timed out')
    // Allow the host deadline to return its safe timeout code before the transport is cancelled.
    const signal = callerSignal === undefined ? AbortSignal.timeout(timeoutMs + 1_000)
      : AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs + 1_000)])
    const retrySignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted()
        if (attempt > 0) retrySignal.throwIfAborted()
        const remainingMs = Math.ceil(deadline - performance.now())
        if (remainingMs < 100) throw new ChatCompletionsError('AI_TIMEOUT', 'The DSH model request timed out')
        const completionPayload = payload.operation === 'resolve' ? payload : { ...payload, timeoutMs: remainingMs }
        // Account for the fixed UUID size before reserving either the ledger or task budget.
        const serialized = JSON.stringify(control?.usageRecorder === undefined ? completionPayload
          : { ...completionPayload, attemptId: '00000000-0000-4000-8000-000000000000' })
        if (Buffer.byteLength(serialized) > Math.min(256 * 1024, maxInputBytes)) throw new ChatCompletionsError('AI_REQUEST_TOO_LARGE', 'The model request exceeds the size limit')
        const route = payload.operation === 'complete' ? decodeModelRoute(String(payload.model)) : undefined
        const attemptId = control === undefined || route === undefined ? undefined : beginChatCompletionUsage(control, {
          provider: route.provider, model: String(payload.model), ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
          outputLimit: null, kind: attempt === 0 ? requestKind : 'rate-limit-retry',
        })
        const body = attemptId === undefined ? serialized : JSON.stringify({ ...completionPayload, attemptId })
        let knownUsage: ModelTokenUsage = unknownModelTokenUsage
        let settled = false
        try {
          const response = await (this.options.fetch ?? fetch)(this.#endpoint, {
            method: 'POST', redirect: 'error', signal,
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.secret}`,
              ...(attemptId === undefined ? {} : { accept: modelBridgeAccountingMediaType }) }, body,
          })
          onResponse?.()
          if (response.body === null) {
            invokeChatCompletionRequestControl(control?.onRequestComplete)
            settled = true
            if (control !== undefined) settleChatCompletionUsage(control, attemptId, { status: 'unknown', usage: knownUsage, httpStatus: response.status })
            if (!response.ok) throw new ChatCompletionsError('AI_REQUEST_FAILED', 'The DSH model bridge is unavailable', { httpStatus: response.status })
            throw new ChatCompletionsError('AI_RESPONSE_INVALID', 'The model bridge returned no response')
          }
          const chunks: Uint8Array[] = []
          const incremental = response.headers.get('content-type')?.split(';')[0] === modelBridgeAccountingMediaType
          const decoder = new TextDecoder()
          let pending = ''
          let terminal: { value: unknown; status: number } | undefined
          const frame = (line: string) => {
            if (terminal !== undefined) throw new ChatCompletionsError('AI_RESPONSE_INVALID', 'The model bridge sent data after its terminal frame')
            const parsed = modelBridgeFrameSchema.parse(JSON.parse(line))
            if (attemptId === undefined || parsed.attemptId !== attemptId) throw new ChatCompletionsError('AI_RESPONSE_INVALID', 'The model bridge changed the attempt identity')
            if (parsed.type === 'usage') knownUsage = parsed.usage
            else terminal = parsed.type === 'result' ? { value: parsed.result, status: 200 }
              : { value: parsed.error, status: parsed.httpStatus }
          }
          let size = 0
          const reader = response.body.getReader()
          try {
            while (true) {
              const next = await reader.read()
              if (next.done) break
              const chunk = next.value
              size += chunk.length
              if (size > this.options.maxResponseBytes) throw new ChatCompletionsError('AI_RESPONSE_TOO_LARGE', 'The model response exceeds the size limit')
              if (incremental) {
                pending += decoder.decode(chunk, { stream: true })
                let newline: number
                while ((newline = pending.indexOf('\n')) >= 0) {
                  const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
                  if (line.length > 0) frame(line)
                }
              } else chunks.push(chunk)
            }
          } finally {
            await reader.cancel().catch(() => {})
            reader.releaseLock()
          }
          if (incremental) {
            pending += decoder.decode()
            if (pending.length > 0) frame(pending)
            if (terminal === undefined) throw new ChatCompletionsError('AI_REQUEST_FAILED', 'The model bridge stream ended without a terminal frame')
          }
          const content = incremental ? JSON.stringify(terminal!.value) : Buffer.concat(chunks).toString('utf8')
          const responseStatus = incremental ? terminal!.status : response.status
          const failure = modelBridgeErrorSchema.safeParse(parseJson(content))
          const completed = modelBridgeResponseSchema.safeParse(parseJson(content))
          const accounting = failure.success ? failure.data.accounting : completed.success ? completed.data.accounting : undefined
          if (accounting !== undefined && accounting.attemptId !== attemptId) throw new ChatCompletionsError('AI_RESPONSE_INVALID', 'The model bridge changed the attempt identity')
          if (accounting !== undefined) knownUsage = accounting.usage
          const unknownResult = accounting?.status === 'unknown' || accounting?.status === 'cancelled'
          if (!unknownResult) invokeChatCompletionRequestControl(control?.onRequestComplete)
          settled = true
          if (control !== undefined) settleChatCompletionUsage(control, attemptId, accounting === undefined
            ? { status: responseStatus >= 400 ? 'failed' : 'succeeded', usage: knownUsage, httpStatus: responseStatus }
            : { ...withoutAttemptIdentity(accounting), httpStatus: responseStatus })
          if (unknownResult) throw new ChatCompletionsError(failure.success && failure.data.error === 'MODEL_TIMEOUT'
            ? 'AI_TIMEOUT' : 'AI_REQUEST_FAILED', 'The DSH model request outcome is unknown')
          if (responseStatus >= 400) {
            let failure: unknown
            try { failure = JSON.parse(content) } catch { /* Unrecognized errors use a static safe fallback. */ }
            const parsed = modelBridgeErrorSchema.safeParse(failure)
            if (parsed.success && parsed.data.error === 'MODEL_AUTH_FAILED') {
              throw new ChatCompletionsError('AI_AUTH_FAILED',
                'The selected DSH Provider rejected authentication or access; check its credentials and permissions',
                { httpStatus: responseStatus })
            }
            if (parsed.success && parsed.data.error === 'MODEL_TIMEOUT') {
              throw new ChatCompletionsError('AI_TIMEOUT', 'The DSH model request timed out',
                { httpStatus: responseStatus })
            }
            if (parsed.success && parsed.data.error === 'MODEL_RATE_LIMIT') {
              const retryAfterMs = parsed.data.retryAfterMs ?? 1_000
              if (rateLimitRetry?.available && attempt === 0
                && deadline - performance.now() - retryAfterMs >= 100) {
                rateLimitRetry.available = false
                await delay(retryAfterMs, undefined, { signal: retrySignal })
                continue
              }
              throw new ChatCompletionsError('AI_REQUEST_FAILED', 'The selected DSH Provider is rate limited; retry later',
                { httpStatus: 429 })
            }
            throw new ChatCompletionsError('AI_REQUEST_FAILED', 'The DSH model bridge is unavailable', { httpStatus: responseStatus })
          }
          const header = response.headers.get(modelBridgeFirstTextHeader)
          const firstText = header === null ? undefined : z.coerce.number().finite().nonnegative().max(10 * 60_000).safeParse(header)
          return { ...modelBridgeResponseSchema.parse(JSON.parse(content)),
            ...(firstText?.success ? { firstTextMs: firstText.data } : {}) }
        } catch (error) {
          if (!settled && control !== undefined) settleChatCompletionUsage(control, attemptId, {
            status: callerSignal?.aborted ? 'cancelled' : 'unknown', usage: knownUsage,
          })
          throw error
        }
      }
      throw new ChatCompletionsError('AI_REQUEST_FAILED', 'The DSH model bridge is unavailable')
    } catch (error) {
      if (error instanceof ChatCompletionRequestControlError) throw error
      if (signal.aborted) throw new ChatCompletionsError('AI_TIMEOUT', 'The DSH model request was cancelled or timed out')
      if (error instanceof ChatCompletionsError) throw error
      if (retrySignal.aborted) throw new ChatCompletionsError('AI_TIMEOUT', 'The DSH model request was cancelled or timed out')
      throw new ChatCompletionsError('AI_REQUEST_FAILED', 'The DSH model bridge could not complete the request')
    }
  }
}

function parseJson(content: string): unknown {
  try { return JSON.parse(content) } catch { return undefined }
}
function withoutAttemptIdentity(value: ModelUsageOutcome & { attemptId: string }): ModelUsageOutcome {
  const { attemptId: _attemptId, ...outcome } = value
  return outcome
}
