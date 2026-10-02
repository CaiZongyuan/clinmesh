import { XMLParser } from 'fast-xml-parser'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { dicomUidSchema, type ImagingSourceClient } from './imaging-pack-store.ts'
import { dicomMetaSopInstanceUid } from './pathology-slide.ts'

const defaultBaseUrl = 'https://idc-open-data.s3.amazonaws.com'
/** File Meta 位于文件开头且很短，读取这么多字节足以识别实例。 */
const headerProbeBytes = 16 * 1024

const listingSchema = z.object({
  ListBucketResult: z.object({
    Contents: z.array(z.object({
      ETag: z.string().min(1),
      Key: z.string().min(1),
      Size: z.coerce.number().int().positive(),
    })).default([]),
    IsTruncated: z.enum(['false', 'true']),
  }),
})

/** 可判定的请求失败；`retryable` 为 false 时（例如 404、对象已变化、超出上限）重试不会得到不同结果。 */
class IdcRequestError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'IdcRequestError'
    this.retryable = retryable
  }
}

interface IdcObject {
  etag: string
  key: string
  size: number
}

/**
 * Imaging Data Commons 公开存储桶的来源客户端：按清单登记的 IDC 序列目录（`crdc_series_uuid`）匿名读取 SM 实例，
 * 不接受任意 URL。列出序列时只读取每个对象开头的 File Meta 识别 SOP Instance UID；下载按固定大小的字节区间进行，
 * 每个区间带 `If-Match` 绑定列出时的 ETag，网络错误、超时、5xx、408、429 与短于请求区间的响应按 `retryDelaysMs`
 * 退避后只重试该区间；其余 4xx、对象变化和超出上限的实例直接失败。一个 20 倍层级可达数百 MB，经代理下载需要数十分钟。
 */
export function createIdcSourceClient(options: {
  baseUrl?: string
  chunkBytes?: number
  fetch?: typeof fetch
  maxInstanceBytes?: number
  onProgress?: (progress: { bytes: number; key: string; totalBytes: number }) => void
  retryDelaysMs?: number[]
  /** SeriesInstanceUID → IDC 序列目录。 */
  seriesUuids: ReadonlyMap<string, string>
  timeoutMs?: number
}): ImagingSourceClient {
  const baseUrl = options.baseUrl ?? defaultBaseUrl
  const chunkBytes = options.chunkBytes ?? 8 * 1024 * 1024
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const maxInstanceBytes = options.maxInstanceBytes ?? 2 * 1024 * 1024 * 1024
  const retryDelaysMs = options.retryDelaysMs ?? [1_000, 4_000, 15_000, 30_000, 60_000]
  const timeoutMs = options.timeoutMs ?? 3 * 60 * 1_000
  // 按序列缓存列出结果；并发下载同一序列的实例共用一次列出。
  const listings = new Map<string, Promise<Map<string, IdcObject>>>()

  async function withRetry<Result>(operation: () => Promise<Result>): Promise<Result> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        const wait = retryDelaysMs[attempt]
        if (wait === undefined || (error instanceof IdcRequestError && !error.retryable)) throw error
        await delay(wait)
      }
    }
  }

  async function request(url: string, headers: Record<string, string>, expectedBytes?: number): Promise<Uint8Array> {
    const response = await fetchImplementation(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) {
      await response.body?.cancel()
      const retryable = response.status >= 500 || response.status === 408 || response.status === 429
      throw new IdcRequestError(`IDC request failed with HTTP ${response.status}`, retryable)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) {
      throw new IdcRequestError(`IDC returned ${bytes.byteLength} of ${expectedBytes} bytes`, true)
    }
    return bytes
  }

  function seriesUuid(seriesInstanceUid: string): string {
    const uuid = options.seriesUuids.get(seriesInstanceUid)
    if (uuid === undefined) throw new IdcRequestError(`The series ${seriesInstanceUid} has no IDC series directory`, false)
    return uuid
  }

  async function listSeries(seriesInstanceUid: string): Promise<Map<string, IdcObject>> {
    const uuid = seriesUuid(seriesInstanceUid)
    const body = await withRetry(() => request(`${baseUrl}/?${new URLSearchParams({ 'list-type': '2', prefix: `${uuid}/` })}`, {}))
    const listing = listingSchema.parse(new XMLParser({
      isArray: name => name === 'Contents',
      parseTagValue: false,
    }).parse(Buffer.from(body).toString('utf8'))).ListBucketResult
    if (listing.IsTruncated === 'true') throw new IdcRequestError(`The IDC series ${uuid} lists more objects than one page`, false)
    const keyPattern = new RegExp(`^${uuid}/[0-9a-f-]{36}\\.dcm$`)
    const series = new Map<string, IdcObject>()
    for (const content of listing.Contents.toSorted((left, right) => left.Key.localeCompare(right.Key))) {
      if (!keyPattern.test(content.Key)) throw new IdcRequestError(`The IDC series ${uuid} contains an unexpected object`, false)
      const head = await withRetry(() => request(`${baseUrl}/${content.Key}`, {
        'If-Match': content.ETag,
        Range: `bytes=0-${Math.min(headerProbeBytes, content.Size) - 1}`,
      }, Math.min(headerProbeBytes, content.Size)))
      const sopInstanceUid = dicomUidSchema.parse(dicomMetaSopInstanceUid(head))
      if (series.has(sopInstanceUid)) throw new IdcRequestError(`The IDC series ${uuid} repeats an instance`, false)
      series.set(sopInstanceUid, { etag: content.ETag, key: content.Key, size: content.Size })
    }
    return series
  }

  function cachedListing(seriesInstanceUid: string): Promise<Map<string, IdcObject>> {
    let listing = listings.get(seriesInstanceUid)
    if (listing === undefined) {
      listing = listSeries(seriesInstanceUid)
      listings.set(seriesInstanceUid, listing)
      listing.catch(() => listings.delete(seriesInstanceUid))
    }
    return listing
  }

  return {
    async fetchInstance(reference) {
      const object = (await cachedListing(reference.seriesInstanceUid)).get(reference.sopInstanceUid)
      if (object === undefined) {
        throw new IdcRequestError(`The instance ${reference.sopInstanceUid} is not in its IDC series`, false)
      }
      if (object.size > maxInstanceBytes) throw new IdcRequestError(`The IDC object exceeds ${maxInstanceBytes} bytes`, false)
      const bytes = new Uint8Array(object.size)
      for (let start = 0; start < object.size; start += chunkBytes) {
        const end = Math.min(object.size, start + chunkBytes)
        bytes.set(await withRetry(() => request(`${baseUrl}/${object.key}`, {
          'If-Match': object.etag,
          Range: `bytes=${start}-${end - 1}`,
        }, end - start)), start)
        options.onProgress?.({ bytes: end, key: object.key, totalBytes: object.size })
      }
      return bytes
    },
    async listInstances(reference) {
      return [...(await cachedListing(reference.seriesInstanceUid)).keys()]
    },
  }
}
