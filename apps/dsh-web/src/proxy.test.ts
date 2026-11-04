import { afterEach, describe, expect, it } from 'vitest'
import { once } from 'node:events'
import { createServer, request as requestHttp, type Server } from 'node:http'
import { createClinMeshProxyHandler, parseClinMeshProxyConfig } from './proxy.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })))
})

describe('ClinMesh DSH Host proxy', () => {
  it('reads only the fixed Patient FHIR resource through the authenticated host namespace', async () => {
    let observed: { cookie: string | undefined; path: string | undefined } | undefined
    const upstream = await listen(createServer((request, response) => {
      observed = { cookie: request.headers.cookie, path: request.url }
      response.setHeader('content-type', 'application/fhir+json')
      response.end(JSON.stringify({ resourceType: 'Patient', id: 'synthetic-1', gender: 'female' }))
    }))
    const proxy = await listen(createServer(createClinMeshProxyHandler({ upstreamOrigin: upstream.origin })))
    const response = await fetch(`${proxy.origin}/clinmesh-api/_fhir/R5/Patient/synthetic-1`, {
      headers: { cookie: 'clinmesh.session=current' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ resourceType: 'Patient', id: 'synthetic-1', gender: 'female' })
    expect(observed).toEqual({ cookie: 'clinmesh.session=current', path: '/fhir/R5/Patient/synthetic-1' })
  })

  it('rejects unsupported FHIR paths before normalization or upstream contact', async () => {
    let upstreamRequests = 0
    const upstream = await listen(createServer((_request, response) => {
      upstreamRequests += 1
      response.end('{}')
    }))
    const proxy = await listen(createServer(createClinMeshProxyHandler({ upstreamOrigin: upstream.origin })))
    for (const path of [
      '/clinmesh-api/_fhir',
      '/clinmesh-api/_fhir/R5/Patient',
      '/clinmesh-api/_fhir/R5/Patient/',
      '/clinmesh-api/_fhir/R4/Patient/synthetic-1',
      '/clinmesh-api/_fhir/R5/Observation/synthetic-1',
      '/clinmesh-api/_fhir/R5/Patient/synthetic-1/_history',
      '/clinmesh-api/_fhir/R5/Patient?name=synthetic',
      '/clinmesh-api/_fhir/R5/Patient/synthetic-1?ignored=true',
      '/clinmesh-api/_fhir/R5/Patient/.',
      '/clinmesh-api/_fhir/R5/Patient/..',
      '/clinmesh-api/_fhir/../his/v1/patients',
      '/clinmesh-api/_fhir/R5/Patient/%2e%2e',
      '/clinmesh-api/_fhir/R5/Patient/synthetic%2f1',
      '/clinmesh-api/_fhir/R5/Patient/synthetic%5c1',
      '/clinmesh-api/_fhir/R5/Patient/synthetic%251',
      '/clinmesh-api/_fhir/R5/Patient/synthetic_1',
      '/clinmesh-api/path/../_fhir/R5/Patient/synthetic-1',
      '/clinmesh-api\\_fhir/R5/Patient/synthetic-1',
      'http://dsh.local/clinmesh-api/_fhir/R5/Patient/synthetic-1',
      `/clinmesh-api/_fhir/R5/Patient/${'a'.repeat(65)}`,
    ]) {
      expect((await rawRequest(proxy.origin, path)).status, path).toBe(404)
    }
    expect(upstreamRequests).toBe(0)
  })

  it('rejects every non-GET Patient request without contacting the upstream', async () => {
    let upstreamRequests = 0
    const upstream = await listen(createServer((_request, response) => {
      upstreamRequests += 1
      response.end('{}')
    }))
    const proxy = await listen(createServer(createClinMeshProxyHandler({ upstreamOrigin: upstream.origin })))
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      expect(await rawRequest(proxy.origin, '/clinmesh-api/_fhir/R5/Patient/synthetic-1', method), method)
        .toEqual({ status: 405, allow: 'GET' })
    }
    expect(upstreamRequests).toBe(0)
  })

  it('maps the namespaced path and preserves authenticated request semantics', async () => {
    let observed: {
      body: string
      cookie?: string
      origin?: string
      path?: string
    } = { body: '' }
    const upstream = await listen(createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      observed = {
        body: Buffer.concat(chunks).toString('utf8'),
        ...(request.headers.cookie === undefined ? {} : { cookie: request.headers.cookie }),
        ...(request.headers.origin === undefined ? {} : { origin: request.headers.origin }),
        ...(request.url === undefined ? {} : { path: request.url }),
      }
      response.statusCode = 201
      response.setHeader('content-type', 'application/json')
      response.setHeader('set-cookie', 'clinmesh.session=next; HttpOnly; Path=/')
      response.end(JSON.stringify({ data: { accepted: true } }))
    }))
    const proxy = await listen(createServer(createClinMeshProxyHandler({
      upstreamOrigin: upstream.origin,
    })))

    const response = await fetch(`${proxy.origin}/clinmesh-api/his/v1/patients?active=true`, {
      body: '{"name":"合成患者"}',
      headers: {
        cookie: 'clinmesh.session=current',
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:3080',
      },
      method: 'POST',
    })

    expect(response.status).toBe(201)
    expect(response.headers.get('set-cookie')).toContain('clinmesh.session=next')
    expect(await response.json()).toEqual({ data: { accepted: true } })
    expect(observed).toEqual({
      body: '{"name":"合成患者"}',
      cookie: 'clinmesh.session=current',
      origin: 'http://127.0.0.1:3080',
      path: '/api/his/v1/patients?active=true',
    })
  })

  it('rejects non-loopback and path-bearing upstream configuration', () => {
    expect(() => parseClinMeshProxyConfig({ upstreamOrigin: 'https://example.com' }))
      .toThrow('loopback')
    expect(() => parseClinMeshProxyConfig({ upstreamOrigin: 'http://127.0.0.1:51868/api' }))
      .toThrow('origin')
  })

  it('rejects an oversized request before contacting Hono', async () => {
    let upstreamRequests = 0
    const upstream = await listen(createServer((_request, response) => {
      upstreamRequests += 1
      response.end()
    }))
    const proxy = await listen(createServer(createClinMeshProxyHandler({
      maxRequestBytes: 8,
      upstreamOrigin: upstream.origin,
    })))

    const response = await fetch(`${proxy.origin}/clinmesh-api/his/v1/patients`, {
      body: '0123456789',
      method: 'POST',
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: { code: 'REQUEST_TOO_LARGE', message: '请求体超过大小限制' },
    })
    expect(upstreamRequests).toBe(0)
  })

  it('passes a full-size imaging pixel block through unchanged with its cache policy', async () => {
    // 像素块上限为 2 MiB，默认响应上限需要容纳它且不改动任何字节。
    const block = Buffer.alloc(2 * 1024 * 1024)
    for (let index = 0; index < block.length; index += 1) block[index] = index % 251
    const upstream = await listen(createServer((_request, response) => {
      response.setHeader('content-type', 'application/octet-stream')
      response.setHeader('cache-control', 'private, no-store')
      response.end(block)
    }))
    const proxy = await listen(createServer(createClinMeshProxyHandler({ upstreamOrigin: upstream.origin })))

    const response = await fetch(
      `${proxy.origin}/clinmesh-api/his/v1/imaging-studies/study-1/series/0/frames/0/blocks/0`,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(Buffer.from(await response.arrayBuffer()).equals(block)).toBe(true)
  })

  it('rejects an oversized upstream response before sending it to the browser', async () => {
    const upstream = await listen(createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end('{"value":"too-large"}')
    }))
    const proxy = await listen(createServer(createClinMeshProxyHandler({
      maxResponseBytes: 8,
      upstreamOrigin: upstream.origin,
    })))

    const response = await fetch(`${proxy.origin}/clinmesh-api/auth/context`)

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: { code: 'UPSTREAM_RESPONSE_TOO_LARGE', message: 'ClinMesh 服务响应超过大小限制' },
    })
  })

  it('returns a stable timeout without retaining the upstream request', async () => {
    const upstream = await listen(createServer(() => {}))
    const proxy = await listen(createServer(createClinMeshProxyHandler({
      requestTimeoutMs: 20,
      upstreamOrigin: upstream.origin,
    })))

    const response = await fetch(`${proxy.origin}/clinmesh-api/auth/context`)

    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({
      error: { code: 'UPSTREAM_TIMEOUT', message: 'ClinMesh 服务响应超时' },
    })
  })
})

async function listen(server: Server): Promise<{ origin: string }> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP address')
  }
  return { origin: `http://127.0.0.1:${address.port}` }
}

function rawRequest(origin: string, path: string, method = 'GET'): Promise<{ status: number; allow?: string }> {
  return new Promise((resolve, reject) => {
    const request = requestHttp(origin, { path, method }, response => {
      response.resume()
      response.once('end', () => resolve({ status: response.statusCode ?? 0,
        ...(response.headers.allow === undefined ? {} : { allow: response.headers.allow }),
      }))
      response.once('error', reject)
    })
    request.once('error', reject)
    request.end()
  })
}
