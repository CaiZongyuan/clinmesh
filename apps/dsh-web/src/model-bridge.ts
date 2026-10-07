import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { decodeModelRoute, encodeModelRoute, modelBridgeRequestSchema, modelRouteSchema } from '@clinmesh/contracts/model-bridge'

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
    const cancelled = new AbortController()
    const abort = () => { if (!response.writableFinished) cancelled.abort() }
    response.on('close', abort)
    const signal = AbortSignal.any([closing.signal, cancelled.signal, AbortSignal.timeout(60_000)])
    const disconnect = () => response.destroy()
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
      const route = input.operation === 'resolve'
        ? selection() === 'default' ? modelRouteSchema.parse(ctx.agentDefaultModel.currentSelection()) : decodeModelRoute(selection())
        : decodeModelRoute(input.model)
      signal.throwIfAborted()
      const model = encodeModelRoute(route)
      let content: string | undefined
      if (input.operation === 'complete') {
        const catalog = await ctx.llm.listModels(route.provider)
        signal.throwIfAborted()
        if (!catalog.some(item => item.id === route.model)) throw new Error('Model unavailable')
        content = ''
        let finished = false
        // Auxiliary call: no Session, Agent system prompt, transcript, Tools or private log.
        for await (const chunk of ctx.llm.stream({
          provider: route.provider, model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
          signal, temperature: 0,
          system: `${input.systemPrompt}\nReturn exactly one JSON object matching this JSON Schema, without Markdown:\n${JSON.stringify(input.jsonSchema)}`,
          messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input.userPayload) }] }],
        })) {
          if (chunk.type === 'text-delta') content += chunk.text
          if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('Response too large')
          if (chunk.type === 'finish') {
            if (chunk.reason.kind !== 'stop') throw new Error('Model call failed')
            finished = true
          }
        }
        if (!finished || signal.aborted) throw new Error('Model call incomplete')
        // Some text-only providers still wrap their structured answer in a code fence.
        content = content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1')
      }
      const body = JSON.stringify({ model, ...(content === undefined ? {} : { content }) })
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' }).end(body)
    } catch {
      // Provider failures can contain credentials and private prompts; do not relay or log them.
      if (!response.destroyed) response.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"MODEL_UNAVAILABLE"}')
    } finally { response.off('close', abort); signal.removeEventListener('abort', disconnect) }
  }
  return { handler, dispose: () => closing.abort() }
}
