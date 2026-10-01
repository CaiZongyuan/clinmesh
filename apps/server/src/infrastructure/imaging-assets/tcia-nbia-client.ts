import { z } from 'zod'
import type { ImagingSourceClient } from './imaging-asset-store.ts'
import { dicomUidSchema } from './imaging-catalog.ts'

const defaultBaseUrl = 'https://services.cancerimagingarchive.net/nbia-api/services/v1'
const instanceListSchema = z.array(z.object({ SOPInstanceUID: dicomUidSchema }))

async function readBoundedBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > maximumBytes) {
      await reader.cancel()
      throw new Error(`The TCIA response exceeds ${maximumBytes} bytes`)
    }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** TCIA NBIA 公开接口的来源客户端：只按序列与实例 UID 读取无需登录的公开合集。 */
export function createTciaNbiaSourceClient(options: {
  baseUrl?: string
  fetch?: typeof fetch
  maxInstanceBytes?: number
  timeoutMs?: number
} = {}): ImagingSourceClient {
  const baseUrl = options.baseUrl ?? defaultBaseUrl
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const maxInstanceBytes = options.maxInstanceBytes ?? 128 * 1024 * 1024
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1_000

  async function get(operation: string, parameters: Record<string, string>, maximumBytes: number) {
    const url = `${baseUrl}/${operation}?${new URLSearchParams(parameters)}`
    const response = await fetchImplementation(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`TCIA ${operation} failed with HTTP ${response.status}`)
    return await readBoundedBytes(response, maximumBytes)
  }

  return {
    async fetchInstance(reference) {
      return await get('getSingleImage', {
        SeriesInstanceUID: reference.seriesInstanceUid,
        SOPInstanceUID: reference.sopInstanceUid,
      }, maxInstanceBytes)
    },
    async listInstances(reference) {
      const body = await get('getSOPInstanceUIDs', { SeriesInstanceUID: reference.seriesInstanceUid }, 4 * 1024 * 1024)
      return instanceListSchema.parse(JSON.parse(Buffer.from(body).toString('utf8')))
        .map(instance => instance.SOPInstanceUID)
    },
  }
}
