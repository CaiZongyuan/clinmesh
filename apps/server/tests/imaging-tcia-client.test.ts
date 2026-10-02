import { describe, expect, it } from 'vitest'
import { createTciaNbiaSourceClient } from '../src/infrastructure/imaging-assets/tcia-nbia-client.ts'

const reference = { seriesInstanceUid: '2.25.1100', studyInstanceUid: '2.25.9' }

function fakeFetch(respond: (url: URL) => Response, requests: string[] = []): typeof fetch {
  return async (input) => {
    const url = new URL(String(input))
    requests.push(url.href)
    return respond(url)
  }
}

describe('TCIA NBIA imaging source client', () => {
  it('lists and downloads instances by source UID from the public NBIA endpoints', async () => {
    const requests: string[] = []
    const client = createTciaNbiaSourceClient({
      baseUrl: 'https://nbia.example/v1',
      fetch: fakeFetch(url => url.pathname.endsWith('/getSOPInstanceUIDs')
        ? Response.json([{ SOPInstanceUID: '2.25.1102' }, { SOPInstanceUID: '2.25.1101' }])
        : new Response(Uint8Array.from([1, 2, 3]), { headers: { 'content-type': 'application/dicom' } }), requests),
    })

    expect(await client.listInstances(reference)).toEqual(['2.25.1102', '2.25.1101'])
    expect(Array.from(await client.fetchInstance({ ...reference, sopInstanceUid: '2.25.1101' }))).toEqual([1, 2, 3])
    expect(requests).toEqual([
      'https://nbia.example/v1/getSOPInstanceUIDs?SeriesInstanceUID=2.25.1100',
      'https://nbia.example/v1/getSingleImage?SeriesInstanceUID=2.25.1100&SOPInstanceUID=2.25.1101',
    ])
  })

  it('rejects failed, malformed and oversized responses', async () => {
    const failing = createTciaNbiaSourceClient({
      fetch: fakeFetch(() => new Response('unavailable', { status: 503 })),
      retryDelaysMs: [],
    })
    await expect(failing.listInstances(reference)).rejects.toThrow('HTTP 503')
    await expect(failing.fetchInstance({ ...reference, sopInstanceUid: '2.25.1101' })).rejects.toThrow('HTTP 503')

    const malformed = createTciaNbiaSourceClient({
      fetch: fakeFetch(() => Response.json([{ SOPInstanceUID: '../escape' }])),
    })
    await expect(malformed.listInstances(reference)).rejects.toThrow()

    const oversizedRequests: string[] = []
    const oversized = createTciaNbiaSourceClient({
      fetch: fakeFetch(() => new Response(new Uint8Array(9)), oversizedRequests),
      maxInstanceBytes: 8,
      retryDelaysMs: [0, 0],
    })
    await expect(oversized.fetchInstance({ ...reference, sopInstanceUid: '2.25.1101' }))
      .rejects.toThrow('exceeds 8 bytes')
    expect(oversizedRequests).toHaveLength(1)
  })

  it.each([
    { name: 'a server error', response: () => new Response('unavailable', { status: 503 }) },
    { name: 'a request timeout', response: () => new Response('timeout', { status: 408 }) },
    { name: 'rate limiting', response: () => new Response('slow down', { status: 429 }) },
    {
      name: 'a body shorter than its Content-Length',
      response: () => new Response(Uint8Array.from([1]), { headers: { 'content-length': '3' } }),
    },
    {
      name: 'a network failure',
      response: () => {
        throw new TypeError('fetch failed')
      },
    },
  ])('retries $name with bounded backoff and then succeeds', async ({ response }) => {
    const requests: string[] = []
    let failures = 2
    const client = createTciaNbiaSourceClient({
      fetch: fakeFetch(() => {
        if (failures === 0) return new Response(Uint8Array.from([1, 2, 3]), { headers: { 'content-length': '3' } })
        failures -= 1
        return response()
      }, requests),
      retryDelaysMs: [0, 0],
    })

    expect(Array.from(await client.fetchInstance({ ...reference, sopInstanceUid: '2.25.1101' }))).toEqual([1, 2, 3])
    expect(requests).toHaveLength(3)
  })

  it('gives up after the bounded attempts and does not retry other client errors', async () => {
    const exhaustedRequests: string[] = []
    const exhausted = createTciaNbiaSourceClient({
      fetch: fakeFetch(() => new Response('unavailable', { status: 502 }), exhaustedRequests),
      retryDelaysMs: [0, 0],
    })
    await expect(exhausted.fetchInstance({ ...reference, sopInstanceUid: '2.25.1101' })).rejects.toThrow('HTTP 502')
    expect(exhaustedRequests).toHaveLength(3)

    const missingRequests: string[] = []
    const missing = createTciaNbiaSourceClient({
      fetch: fakeFetch(() => new Response('not found', { status: 404 }), missingRequests),
      retryDelaysMs: [0, 0],
    })
    await expect(missing.fetchInstance({ ...reference, sopInstanceUid: '2.25.1101' })).rejects.toThrow('HTTP 404')
    expect(missingRequests).toHaveLength(1)
  })
})
