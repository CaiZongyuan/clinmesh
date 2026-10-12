import { dshDefaultModel, decodeModelRoute, modelBridgeErrorSchema, modelBridgePath, modelBridgeResponseSchema } from '@clinmesh/contracts/model-bridge'
import { ChatCompletionsError, type JsonChatCompletionInput, type JsonChatCompletionsProvider } from './openai-chat-completions.ts'
import { ZodError } from 'zod'

export class DshModelProvider implements JsonChatCompletionsProvider {
  readonly #endpoint: URL
  constructor(private readonly options: { origin: string; secret: string; timeoutMs: number; maxResponseBytes: number; fetch?: typeof fetch }) {
    this.#endpoint = new URL(modelBridgePath, options.origin)
    if (this.#endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(this.#endpoint.hostname)) {
      throw new Error('The DSH model bridge requires an HTTP loopback origin')
    }
  }

  async resolveModel(model: string, signal?: AbortSignal): Promise<string> {
    if (model !== dshDefaultModel) { decodeModelRoute(model); return model }
    const result = await this.#request({ operation: 'resolve' }, signal)
    decodeModelRoute(result.model)
    return result.model
  }

  async completeJson(input: JsonChatCompletionInput) {
    const model = await this.resolveModel(input.model, input.signal)
    let issues: Array<{ code: string; path: string }> = []
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.#request({
        operation: 'complete', model, schemaName: input.schemaName, jsonSchema: input.jsonSchema,
        systemPrompt: attempt === 0 ? input.systemPrompt : `${input.systemPrompt}\nThe previous response failed validation: ${JSON.stringify(issues)}. Generate a corrected JSON object using the original data and schema. Do not include $schema or other schema metadata.`,
        userPayload: input.userPayload, timeoutMs: this.options.timeoutMs,
      }, input.signal)
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
        issues = error instanceof ZodError ? error.issues.slice(0, 12).map(issue => ({
          code: issue.code, path: issue.path.join('.').slice(0, 200),
        })) : [{ code: 'invalid_json_or_content', path: '' }]
      }
    }
    throw new ChatCompletionsError('AI_RESPONSE_INVALID', 'The DSH model returned invalid structured output', { validationIssues: issues })
  }

  async #request(payload: unknown, callerSignal?: AbortSignal) {
    // Allow the host deadline to return its safe timeout code before the transport is cancelled.
    const signal = callerSignal === undefined ? AbortSignal.timeout(this.options.timeoutMs + 1_000)
      : AbortSignal.any([callerSignal, AbortSignal.timeout(this.options.timeoutMs + 1_000)])
    const body = JSON.stringify(payload)
    if (Buffer.byteLength(body) > 256 * 1024) throw new ChatCompletionsError('AI_REQUEST_TOO_LARGE', 'The model request exceeds the size limit')
    try {
      const response = await (this.options.fetch ?? fetch)(this.#endpoint, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.secret}` }, body,
      })
      if (response.body === null) {
        if (!response.ok) throw new ChatCompletionsError('AI_REQUEST_FAILED', 'The DSH model bridge is unavailable', { httpStatus: response.status })
        throw new ChatCompletionsError('AI_RESPONSE_INVALID', 'The model bridge returned no response')
      }
      const chunks: Uint8Array[] = []
      let size = 0
      const reader = response.body.getReader()
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          const chunk = next.value
          size += chunk.length
          if (size > this.options.maxResponseBytes) throw new ChatCompletionsError('AI_RESPONSE_TOO_LARGE', 'The model response exceeds the size limit')
          chunks.push(chunk)
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      const content = Buffer.concat(chunks).toString('utf8')
      if (!response.ok) {
        let failure: unknown
        try { failure = JSON.parse(content) } catch { /* Unrecognized errors use a static safe fallback. */ }
        const parsed = modelBridgeErrorSchema.safeParse(failure)
        if (parsed.success && parsed.data.error === 'MODEL_AUTH_FAILED') {
          throw new ChatCompletionsError('AI_AUTH_FAILED',
            'The selected DSH Provider rejected authentication or access; check its credentials and permissions',
            { httpStatus: response.status })
        }
        if (parsed.success && parsed.data.error === 'MODEL_TIMEOUT') {
          throw new ChatCompletionsError('AI_TIMEOUT', 'The DSH model request timed out',
            { httpStatus: response.status })
        }
        throw new ChatCompletionsError('AI_REQUEST_FAILED', 'The DSH model bridge is unavailable', { httpStatus: response.status })
      }
      return modelBridgeResponseSchema.parse(JSON.parse(content))
    } catch (error) {
      if (signal.aborted) throw new ChatCompletionsError('AI_TIMEOUT', 'The DSH model request was cancelled or timed out')
      if (error instanceof ChatCompletionsError) throw error
      throw new ChatCompletionsError('AI_REQUEST_FAILED', 'The DSH model bridge could not complete the request')
    }
  }
}
