import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { ImagingSourceClient } from './imaging-asset-store.ts'
import { dicomUidSchema } from './imaging-catalog.ts'

const defaultBaseUrl = 'https://services.cancerimagingarchive.net/nbia-api/services/v1'
const instanceListSchema = z.array(z.object({ SOPInstanceUID: dicomUidSchema }))

/** 可判定的请求失败；`retryable` 为 false 时（例如 404、超出上限）重试不会得到不同结果。 */
class TciaRequestError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'TciaRequestError'
    this.retryable = retryable
  }
}

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
      throw new TciaRequestError(`The TCIA response exceeds ${maximumBytes} bytes`, false)
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

/**
 * TCIA NBIA 公开接口的来源客户端：只按序列与实例 UID 读取无需登录的公开合集。
 * 网络错误、超时、5xx、408、429 与短于 Content-Length 的响应体按 `retryDelaysMs` 退避后重试；
 * 其余 4xx 和超出上限的响应直接失败。一套 CT 有数百个实例，偶发网络失败不应让整套素材从头下载。
 */
export function createTciaNbiaSourceClient(options: {
  baseUrl?: string
  fetch?: typeof fetch
  maxInstanceBytes?: number
  retryDelaysMs?: number[]
  timeoutMs?: number
} = {}): ImagingSourceClient {
  const baseUrl = options.baseUrl ?? defaultBaseUrl
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const maxInstanceBytes = options.maxInstanceBytes ?? 128 * 1024 * 1024
  const retryDelaysMs = options.retryDelaysMs ?? [1_000, 4_000]
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1_000

  async function getOnce(operation: string, url: string, maximumBytes: number) {
    const response = await fetchImplementation(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) {
      await response.body?.cancel()
      const retryable = response.status >= 500 || response.status === 408 || response.status === 429
      throw new TciaRequestError(`TCIA ${operation} failed with HTTP ${response.status}`, retryable)
    }
    const bytes = await readBoundedBytes(response, maximumBytes)
    const declared = response.headers.get('content-length')
    if (declared !== null && Number(declared) !== bytes.byteLength) {
      throw new TciaRequestError(`TCIA ${operation} returned ${bytes.byteLength} of ${declared} bytes`, true)
    }
    return bytes
  }

  async function get(operation: string, parameters: Record<string, string>, maximumBytes: number) {
    const url = `${baseUrl}/${operation}?${new URLSearchParams(parameters)}`
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await getOnce(operation, url, maximumBytes)
      } catch (error) {
        const wait = retryDelaysMs[attempt]
        if (wait === undefined || (error instanceof TciaRequestError && !error.retryable)) throw error
        await delay(wait)
      }
    }
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
