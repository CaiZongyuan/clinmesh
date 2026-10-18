import { z } from 'zod'
import { modelBridgeResponseSchema } from '../packages/contracts/src/model-bridge.ts'

export function summarizeModelOutput(content: string): Record<string, unknown> {
  const trimmed = content.trim()
  const metadata: Record<string, unknown> = {
    characters: Array.from(content).length,
    startsWithObject: trimmed.startsWith('{'), endsWithObject: trimmed.endsWith('}'),
    startsWithArray: trimmed.startsWith('['), endsWithArray: trimmed.endsWith(']'),
    startsWithJsonFence: /^```(?:json)?(?:\s|$)/i.test(trimmed), endsWithJsonFence: trimmed.endsWith('```'),
    jsonParsed: false,
  }
  try {
    const value: unknown = JSON.parse(content)
    metadata.jsonParsed = true
    metadata.rootType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      metadata.fields = Object.fromEntries(['issues', 'agentFactChecks'].map(field => {
        const item: unknown = Reflect.get(value, field)
        return [field, Array.isArray(item) ? { type: 'array', length: item.length }
          : { type: item === undefined ? 'missing' : item === null ? 'null' : typeof item }]
      }))
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      for (const [field, pattern] of [
        ['syntaxPosition', /position (\d+)/], ['syntaxLine', /line (\d+)/], ['syntaxColumn', /column (\d+)/],
      ] as const) {
        const digits = pattern.exec(error.message)?.[1]
        if (digits !== undefined) metadata[field] = Number(digits)
      }
    }
  }
  return metadata
}

export function repairValidationMetadata(prompt: string): Array<{ code: string; path: string }> {
  const prefix = 'The previous response failed validation: '
  const suffix = '. Generate a corrected JSON object'
  const start = prompt.lastIndexOf(prefix)
  if (start < 0) return []
  const end = prompt.indexOf(suffix, start + prefix.length)
  if (end < 0) return []
  try {
    const parsed = z.array(z.object({ code: z.string(), path: z.string() })).max(12)
      .safeParse(JSON.parse(prompt.slice(start + prefix.length, end)))
    return parsed.success ? parsed.data : []
  } catch { return [] }
}

// Read a bounded copy; the original response still goes through the Provider's unchanged checks.
export async function modelBridgeResponseMetadata(response: Response, limit: number): Promise<Record<string, unknown>> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    reader = response.clone().body?.getReader()
    if (reader === undefined) return { unavailable: 'missing-response' }
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > limit) return { unavailable: 'response-limit' }
      chunks.push(next.value)
    }
    const parsed = modelBridgeResponseSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    return parsed.success ? summarizeModelOutput(parsed.data.content ?? '') : { unavailable: 'invalid-bridge-envelope' }
  } catch { return { unavailable: 'response-unavailable' } }
  finally { if (reader !== undefined) { void reader.cancel().catch(() => {}); reader.releaseLock() } }
}
