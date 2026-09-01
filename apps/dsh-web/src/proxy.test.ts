import { afterEach, describe, expect, it } from 'vitest'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { createClinMeshProxyHandler, parseClinMeshProxyConfig } from './proxy.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })))
})

describe('ClinMesh DSH Host proxy', () => {
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
