import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { decodeModelRoute, encodeModelRoute, modelBridgeAccountingMediaType, modelBridgeAccountingSchema,
  modelBridgeFirstTextHeader, modelBridgeRequestSchema, modelRouteSchema } from '@clinmesh/contracts/model-bridge'
import { mergeModelTokenUsage, modelUsageConfigurationSchema, modelUsageOutcomeSchema, unknownModelTokenUsage,
  type ModelTokenUsage, type ModelUsageConfiguration } from '@clinmesh/contracts/model-usage'
import { dshTokenUsage } from './dsh-token-usage.ts'

class ModelAccessError extends Error {}
class ModelTimeoutError extends Error {}
class ModelIncompleteError extends Error {}
class ModelRateLimitError extends Error {
  constructor(readonly retryAfterMs: number | undefined) { super('Model rate limit reached') }
}

export function createModelBridgeHandler(ctx: Pick<Context, 'llm' | 'agentDefaultModel'>, secret: string, selection: () => string) {
  const closing = new AbortController()
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const address = request.socket.remoteAddress
    const credential = Buffer.from(request.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${secret}`)
    if (request.headers.origin !== undefined || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '')
      || credential.length !== expected.length || !timingSafeEqual(credential, expected)) {
      response.writeHead(403).end(); return
    }
    if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }).end(); return }
    let responseStarted = false
    let streamStarted = false
    let attemptId: string | undefined
    let incremental = false
    let usage: ModelTokenUsage = unknownModelTokenUsage
    let actualModel: string | undefined
    let providerRequestId: string | undefined
    let configuration: ModelUsageConfiguration | undefined
    let modelStreamStarted = false
    let terminalReceived = false
    const accounting = (status: 'succeeded' | 'failed' | 'cancelled' | 'unknown') => attemptId === undefined ? {} : {
      accounting: modelBridgeAccountingSchema.parse({ attemptId, status, usage, ...configuration,
        dispatch: modelStreamStarted ? 'dispatched' : 'not-dispatched',
        ...(actualModel === undefined ? {} : { actualModel }), ...(providerRequestId === undefined ? {} : { providerRequestId }) }),
    }
    const send = (status: number, body: string, firstTextMs?: number) => {
      if (responseStarted || response.destroyed || response.writableEnded) return
      // Host gzip can defer writableEnded after end(); retain ownership while it flushes.
      responseStarted = true
      if (incremental) {
        if (!streamStarted) {
          response.writeHead(200, { 'content-type': modelBridgeAccountingMediaType, 'cache-control': 'no-store, no-transform' })
          streamStarted = true
        }
        const value: unknown = JSON.parse(body)
        response.end(`${JSON.stringify(status < 400 ? { type: 'result', attemptId, result: value }
          : { type: 'error', attemptId, error: value, httpStatus: status })}\n`)
        return
      }
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store', ...(firstTextMs === undefined ? {} : { [modelBridgeFirstTextHeader]: String(firstTextMs) }) }).end(body)
    }
    const cancelled = new AbortController()
    const abort = () => { if (!response.writableFinished) cancelled.abort() }
    response.on('close', abort)
    let signal = AbortSignal.any([closing.signal, cancelled.signal, AbortSignal.timeout(10_000)])
    const disconnect = () => {
      if (closing.signal.aborted || cancelled.signal.aborted) response.destroy()
      else send(503, JSON.stringify({ error: 'MODEL_TIMEOUT', ...accounting('unknown') }))
    }
    signal.addEventListener('abort', disconnect, { once: true })
    try {
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Invalid content type')
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > 256 * 1024) throw new Error('Request too large')
        chunks.push(buffer)
      }
      const input = modelBridgeRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (input.operation === 'complete') {
        attemptId = input.attemptId
        incremental = attemptId !== undefined && request.headers.accept === modelBridgeAccountingMediaType
      }
      signal.throwIfAborted()
      signal.removeEventListener('abort', disconnect)
      signal = AbortSignal.any([closing.signal, cancelled.signal,
        AbortSignal.timeout(input.operation === 'complete' ? input.timeoutMs ?? 60_000 : 60_000)])
      signal.addEventListener('abort', disconnect, { once: true })
      const route = input.operation === 'resolve'
        ? selection() === 'default' ? modelRouteSchema.parse(ctx.agentDefaultModel.currentSelection()) : decodeModelRoute(selection())
        : decodeModelRoute(input.model)
      signal.throwIfAborted()
      const model = encodeModelRoute(route)
      // The route is fixed for this auxiliary stream; successful SDK chunks expose no alternate model.
      const safeModel = modelUsageOutcomeSchema.shape.actualModel.safeParse(route.model)
      if (safeModel.success) actualModel = safeModel.data
      let content: string | undefined
      let firstTextMs: number | undefined
      if (input.operation === 'complete') {
        const started = performance.now()
        const catalog = await ctx.llm.listModels(route.provider)
        signal.throwIfAborted()
        if (!catalog.some(item => item.id === route.model)) throw new Error('Model unavailable')
        const prepared = await ctx.llm.prepareCall({ provider: route.provider, model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
          temperature: 0 }, signal)
        signal.throwIfAborted()
        configuration = modelUsageConfigurationSchema.parse({ reasoningEffort: prepared.config.reasoningEffort ?? null,
          outputLimit: prepared.config.maxTokens ?? null })
        content = ''
        let finished = false
        // Auxiliary call: no Session, Agent system prompt, transcript, Tools or private log.
        modelStreamStarted = true
        for await (const chunk of prepared.stream({
          ...prepared.config, signal,
          system: `${input.systemPrompt}\nReturn exactly one JSON data object matching this JSON Schema, without Markdown or $schema metadata:\n${JSON.stringify(input.jsonSchema)}`,
          messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input.userPayload) }] }],
        })) {
          if (chunk.type === 'usage') {
            usage = mergeModelTokenUsage(usage, dshTokenUsage(chunk.usage))
            if (incremental && !response.destroyed && !responseStarted) {
              if (!streamStarted) {
                response.writeHead(200, { 'content-type': modelBridgeAccountingMediaType, 'cache-control': 'no-store, no-transform' })
                streamStarted = true
              }
              response.write(`${JSON.stringify({ type: 'usage', attemptId, usage, configuration })}\n`)
            }
          }
          if (chunk.type === 'text-delta') {
            if (chunk.text.length > 0) firstTextMs ??= performance.now() - started
            content += chunk.text
          }
          if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('Response too large')
          if (chunk.type === 'finish') {
            terminalReceived = true
            if (chunk.reason.kind === 'error') {
              const parsed = modelUsageOutcomeSchema.shape.providerRequestId.safeParse(chunk.reason.failure.requestId)
              if (parsed.success) providerRequestId = parsed.data
            }
            if (chunk.reason.kind === 'error'
              && ['AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL'].includes(chunk.reason.failure.code)) {
              throw new ModelAccessError('Model authentication or access failed')
            }
            if (chunk.reason.kind === 'error' && chunk.reason.failure.code === 'TIMEOUT') {
              throw new ModelTimeoutError('Model request timed out')
            }
            if (chunk.reason.kind === 'error' && chunk.reason.failure.code === 'RATE_LIMIT') {
              const delay = chunk.reason.failure.providerRetryAfterMs
              throw new ModelRateLimitError(typeof delay === 'number' && Number.isFinite(delay) && delay > 0
                ? Math.min(10 * 60_000, Math.ceil(delay)) : undefined)
            }
            if (chunk.reason.kind === 'aborted') throw new ModelIncompleteError('Model result is unknown')
            if (chunk.reason.kind !== 'stop') throw new Error('Model call failed')
            finished = true
          }
        }
        if (!finished || signal.aborted) throw new ModelIncompleteError('Model call incomplete')
        // Some text-only providers still wrap their structured answer in a code fence.
        content = content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1')
      }
      const body = JSON.stringify({ model, ...(content === undefined ? {} : { content }),
        ...(attemptId === undefined ? {} : { ...accounting('succeeded'), ...(firstTextMs === undefined ? {} : { firstTextMs }) }) })
      send(200, body, firstTextMs)
    } catch (error) {
      // Provider failures can contain credentials and private prompts; do not relay or log them.
      const body = JSON.stringify({ ...(error instanceof ModelRateLimitError
        ? { error: 'MODEL_RATE_LIMIT', ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) }
        : { error: error instanceof ModelAccessError ? 'MODEL_AUTH_FAILED'
          : error instanceof ModelTimeoutError ? 'MODEL_TIMEOUT' : 'MODEL_UNAVAILABLE' }),
        ...accounting(signal.aborted ? 'cancelled' : error instanceof ModelTimeoutError || error instanceof ModelIncompleteError
          || modelStreamStarted && !terminalReceived ? 'unknown' : 'failed') })
      send(error instanceof ModelRateLimitError ? 429 : 503, body)
    } finally { response.off('close', abort); signal.removeEventListener('abort', disconnect) }
  }
  return { handler, dispose: () => closing.abort() }
}
