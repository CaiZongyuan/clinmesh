import { describe, expect, it } from 'vitest'
import { createIdcSourceClient } from '../src/infrastructure/imaging-assets/idc-source-client.ts'
import { explicitVrLittleEndianSyntax, syntheticSlideLevel } from './fixtures/pathology-dicom.ts'

const seriesInstanceUid = '2.25.7100'
const studyInstanceUid = '2.25.7000'
const seriesUuid = '11111111-2222-4333-8444-555555555555'
const baseUrl = 'https://bucket.invalid'

function instance(sopInstanceUid: string, pixelBytes: number): Uint8Array {
  return syntheticSlideLevel({
    frames: [Uint8Array.from({ length: pixelBytes }, (_, index) => index % 251)],
    height: 4,
    imageType: 'DERIVED\\PRIMARY\\THUMBNAIL\\RESAMPLED',
    micronsPerPixel: 5,
    photometric: 'RGB',
    seriesInstanceUid,
    sopInstanceUid,
    tileSize: 4,
    transferSyntaxUid: explicitVrLittleEndianSyntax,
    width: 4,
  })
}

const objects = new Map([
  [`${seriesUuid}/aaaaaaaa-0000-4000-8000-000000000001.dcm`, { bytes: instance('2.25.7110', 40_000), etag: '"etag-one"' }],
  [`${seriesUuid}/bbbbbbbb-0000-4000-8000-000000000002.dcm`, { bytes: instance('2.25.7120', 900), etag: '"etag-two"' }],
])

interface Request {
  ifMatch: string | null
  range: string | null
  url: string
}

/** 模拟公开存储桶：列出序列目录，并按 Range 与 If-Match 返回对象片段；`intercept` 可以替换某次响应。 */
function bucket(
  requests: Request[],
  intercept: (request: Request, count: number) => Response | undefined = () => undefined,
  listing = objects,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const request = { ifMatch: headers.get('if-match'), range: headers.get('range'), url: String(input) }
    requests.push(request)
    const intercepted = intercept(request, requests.length)
    if (intercepted !== undefined) return intercepted
    const url = new URL(request.url)
    if (url.pathname === '/') {
      expect(Object.fromEntries(url.searchParams)).toEqual({ 'list-type': '2', prefix: `${seriesUuid}/` })
      return new Response(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${
        [...listing].map(([key, object]) => (
          `<Contents><Key>${key}</Key><ETag>${object.etag.replaceAll('"', '&quot;')}</ETag><Size>${object.bytes.byteLength}</Size></Contents>`
        )).join('')
      }</ListBucketResult>`)
    }
    const object = objects.get(url.pathname.slice(1))
    if (object === undefined) return new Response('', { status: 404 })
    if (request.ifMatch !== object.etag) return new Response('', { status: 412 })
    const [start, end] = /^bytes=(\d+)-(\d+)$/.exec(request.range ?? '')!.slice(1).map(Number)
    return new Response(object.bytes.slice(start!, end! + 1), { status: 206 })
  }) as typeof fetch
}

function client(requests: Request[], options: Partial<Parameters<typeof createIdcSourceClient>[0]> = {}) {
  return createIdcSourceClient({
    baseUrl,
    chunkBytes: 16_000,
    fetch: bucket(requests),
    retryDelaysMs: [0, 0],
    seriesUuids: new Map([[seriesInstanceUid, seriesUuid]]),
    ...options,
  })
}

describe('IDC public bucket source client', () => {
  it('identifies instances from their file meta headers without downloading them', async () => {
    const requests: Request[] = []

    expect(await client(requests).listInstances({ seriesInstanceUid, studyInstanceUid })).toEqual(['2.25.7110', '2.25.7120'])

    // 只读取每个对象开头的 16 KiB（较小的对象读到末尾）。
    const small = objects.get(`${seriesUuid}/bbbbbbbb-0000-4000-8000-000000000002.dcm`)!.bytes.byteLength
    expect(requests.map(request => request.range)).toEqual([null, 'bytes=0-16383', `bytes=0-${small - 1}`])
  })

  it('downloads an instance in ranged chunks bound to the listed ETag', async () => {
    const requests: Request[] = []
    const progress: number[] = []
    const source = client(requests, { onProgress: ({ bytes }) => progress.push(bytes) })
    const expected = objects.get(`${seriesUuid}/aaaaaaaa-0000-4000-8000-000000000001.dcm`)!.bytes

    // 部署同步不先列出序列：首次下载时列出一次，并发下载共用这次列出。
    const [first, second] = await Promise.all([
      source.fetchInstance({ seriesInstanceUid, sopInstanceUid: '2.25.7110', studyInstanceUid }),
      source.fetchInstance({ seriesInstanceUid, sopInstanceUid: '2.25.7120', studyInstanceUid }),
    ])

    expect(Buffer.from(first).equals(Buffer.from(expected))).toBe(true)
    expect(second.byteLength).toBe(objects.get(`${seriesUuid}/bbbbbbbb-0000-4000-8000-000000000002.dcm`)!.bytes.byteLength)
    expect(requests.filter(request => new URL(request.url).pathname === '/')).toHaveLength(1)
    const downloads = requests.filter(request => request.url.endsWith('000000000001.dcm')).slice(1)
    expect(downloads.map(request => request.range)).toEqual([
      'bytes=0-15999',
      'bytes=16000-31999',
      `bytes=32000-${expected.byteLength - 1}`,
    ])
    expect(new Set(downloads.map(request => request.ifMatch))).toEqual(new Set(['"etag-one"']))
    expect(progress).toContain(expected.byteLength)
  })

  it('retries only the failed range after transient failures', async () => {
    const requests: Request[] = []
    let failures = 0
    const source = client(requests, {
      fetch: bucket(requests, (request) => {
        if (request.range !== 'bytes=16000-31999' || failures >= 2) return undefined
        failures += 1
        // 一次服务端错误，一次被截断的响应体。
        return failures === 1 ? new Response('', { status: 503 }) : new Response(new Uint8Array(10), { status: 206 })
      }),
    })

    const bytes = await source.fetchInstance({ seriesInstanceUid, sopInstanceUid: '2.25.7110', studyInstanceUid })

    expect(Buffer.from(bytes).equals(Buffer.from(objects.get(`${seriesUuid}/aaaaaaaa-0000-4000-8000-000000000001.dcm`)!.bytes))).toBe(true)
    expect(requests.filter(request => request.range === 'bytes=16000-31999')).toHaveLength(3)
    expect(requests.filter(request => request.range === 'bytes=0-15999')).toHaveLength(1)
  })

  it('fails without retrying when the object changed, is missing or exceeds the size limit', async () => {
    const changed: Request[] = []
    const stale = new Map([...objects].map(([key, object]) => [key, { ...object, etag: '"etag-old"' }]))
    await expect(client(changed, { fetch: bucket(changed, undefined, stale) })
      .listInstances({ seriesInstanceUid, studyInstanceUid })).rejects.toThrow('HTTP 412')
    expect(changed).toHaveLength(2)

    const tooLarge: Request[] = []
    await expect(client(tooLarge, { maxInstanceBytes: 1_000 })
      .fetchInstance({ seriesInstanceUid, sopInstanceUid: '2.25.7110', studyInstanceUid })).rejects.toThrow('exceeds 1000 bytes')
    await expect(client([]).fetchInstance({ seriesInstanceUid, sopInstanceUid: '2.25.7999', studyInstanceUid }))
      .rejects.toThrow('is not in its IDC series')
  })

  it('reads only series directories declared by the catalog and rejects unexpected objects', async () => {
    const requests: Request[] = []
    await expect(client(requests).listInstances({ seriesInstanceUid: '2.25.7999', studyInstanceUid }))
      .rejects.toThrow('has no IDC series directory')
    expect(requests).toEqual([])

    const foreign = new Map([[`${seriesUuid}/../other/secret.dcm`, { bytes: new Uint8Array(4), etag: '"x"' }]])
    await expect(client(requests, { fetch: bucket(requests, undefined, foreign) })
      .listInstances({ seriesInstanceUid, studyInstanceUid })).rejects.toThrow('unexpected object')
    expect(requests).toHaveLength(1)
  })
})
