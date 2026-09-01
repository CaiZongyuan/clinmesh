import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from 'node:http'
import { request as requestHttp } from 'node:http'
import { z } from 'zod'

export const CLINMESH_PROXY_PATH = '/clinmesh-api'
const CLINMESH_UPSTREAM_PATH = '/api'
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const ALLOWED_METHODS = new Set(['DELETE', 'GET', 'POST', 'PUT'])
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const proxyConfigSchema = z.object({
  maxRequestBytes: z.number().int().positive().max(8 * 1024 * 1024)
    .default(DEFAULT_MAX_REQUEST_BYTES),
  maxResponseBytes: z.number().int().positive().max(16 * 1024 * 1024)
    .default(DEFAULT_MAX_RESPONSE_BYTES),
  requestTimeoutMs: z.number().int().positive().max(5 * 60_000)
    .default(DEFAULT_REQUEST_TIMEOUT_MS),
  upstreamOrigin: z.url().refine(isLoopbackOrigin, {
    message: 'ClinMesh upstream must be a loopback HTTP origin without a path',
  }),
}).strict()

export type ClinMeshProxyConfig = z.infer<typeof proxyConfigSchema>

export function parseClinMeshProxyConfig(input: unknown): ClinMeshProxyConfig {
  return proxyConfigSchema.parse(input)
}

export function createClinMeshProxyHandler(input: unknown) {
  const config = parseClinMeshProxyConfig(input)
  const upstreamOrigin = new URL(config.upstreamOrigin)

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://dsh.local')
      if (!isMountedPath(requestUrl.pathname)) {
        writeError(response, 404, 'NOT_FOUND', '接口不存在')
        return
      }
      if (request.method === undefined || !ALLOWED_METHODS.has(request.method)) {
        response.setHeader('allow', [...ALLOWED_METHODS].join(', '))
        writeError(response, 405, 'METHOD_NOT_ALLOWED', '请求方法不受支持')
        return
      }
      const declaredLength = Number(request.headers['content-length'] ?? 0)
      if (Number.isFinite(declaredLength) && declaredLength > config.maxRequestBytes) {
        writeError(response, 413, 'REQUEST_TOO_LARGE', '请求体超过大小限制')
        return
      }

      const body = await readRequestBody(request, config.maxRequestBytes)
      const suffix = requestUrl.pathname.slice(CLINMESH_PROXY_PATH.length)
      const target = new URL(
        `${CLINMESH_UPSTREAM_PATH}${suffix}${requestUrl.search}`,
        upstreamOrigin,
      )
      const headers = filterHeaders(request.headers)
      headers.host = target.host
      if (body.length === 0) delete headers['content-length']
      else headers['content-length'] = String(body.length)

      await forwardRequest({
        body,
        headers,
        request,
        response,
        target,
        maxResponseBytes: config.maxResponseBytes,
        timeoutMs: config.requestTimeoutMs,
      })
    } catch (error) {
      if (error instanceof RequestTooLargeError) {
        writeError(response, 413, 'REQUEST_TOO_LARGE', '请求体超过大小限制')
        return
      }
      if (!response.headersSent) {
        writeError(response, 400, 'INVALID_REQUEST', '请求无法读取')
      } else if (!response.writableEnded) {
        response.destroy()
      }
    }
  }
}

function isLoopbackOrigin(value: string): boolean {
  const url = new URL(value)
  return (
    url.protocol === 'http:'
    && LOOPBACK_HOSTS.has(url.hostname)
    && url.username === ''
    && url.password === ''
    && url.pathname === '/'
    && url.search === ''
    && url.hash === ''
  )
}

function isMountedPath(pathname: string): boolean {
  return pathname === CLINMESH_PROXY_PATH
    || pathname.startsWith(`${CLINMESH_PROXY_PATH}/`)
}

function filterHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => (
    value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())
  )))
}

async function readRequestBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maximum) throw new RequestTooLargeError()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function forwardRequest(input: {
  body: Buffer
  headers: IncomingHttpHeaders
  maxResponseBytes: number
  request: IncomingMessage
  response: ServerResponse
  target: URL
  timeoutMs: number
}): Promise<void> {
  return new Promise(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve()
    }
    const upstream = requestHttp(input.target, {
      headers: input.headers,
      method: input.request.method,
    }, upstreamResponse => {
      void (async () => {
        try {
          const body = await readUpstreamBody(upstreamResponse, input.maxResponseBytes)
          if (settled) return
          input.response.statusCode = upstreamResponse.statusCode ?? 502
          for (const [name, value] of Object.entries(upstreamResponse.headers)) {
            if (
              value !== undefined
              && name.toLowerCase() !== 'content-length'
              && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())
            ) input.response.setHeader(name, value)
          }
          input.response.setHeader('content-length', body.length)
          input.response.end(body)
        } catch (error) {
          if (settled) return
          if (error instanceof ResponseTooLargeError) {
            writeError(
              input.response,
              502,
              'UPSTREAM_RESPONSE_TOO_LARGE',
              'ClinMesh 服务响应超过大小限制',
            )
          } else if (!input.response.headersSent) {
            writeError(input.response, 502, 'UPSTREAM_ERROR', 'ClinMesh 服务响应失败')
          } else if (!input.response.writableEnded) {
            input.response.destroy()
          }
        } finally {
          finish()
        }
      })()
    })
    timer = setTimeout(() => {
      upstream.destroy(new Error('ClinMesh upstream timed out'))
      if (!input.response.headersSent) {
        writeError(input.response, 504, 'UPSTREAM_TIMEOUT', 'ClinMesh 服务响应超时')
      } else if (!input.response.writableEnded) {
        input.response.destroy()
      }
      finish()
    }, input.timeoutMs)
    upstream.once('error', () => {
      if (settled) return
      if (!input.response.headersSent) {
        writeError(input.response, 502, 'UPSTREAM_UNAVAILABLE', 'ClinMesh 服务暂时不可用')
      }
      finish()
    })
    input.response.once('close', () => {
      if (!input.response.writableEnded) upstream.destroy()
      finish()
    })
    if (input.body.length > 0) upstream.write(input.body)
    upstream.end()
  })
}

async function readUpstreamBody(response: IncomingMessage, maximum: number): Promise<Buffer> {
  const declaredLength = Number(response.headers['content-length'] ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    response.destroy()
    throw new ResponseTooLargeError()
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maximum) {
      response.destroy()
      throw new ResponseTooLargeError()
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function writeError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  if (response.headersSent) return
  const body = JSON.stringify({ error: { code, message } })
  response.statusCode = status
  response.setHeader('content-length', Buffer.byteLength(body))
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(body)
}

class RequestTooLargeError extends Error {}
class ResponseTooLargeError extends Error {}
