import { readingBindingSchema, readingBindingStatusSchema, readingAssetStatusSchema, readingCapabilitiesSchema, readingOperationSchema, readingSessionCreatedSchema,
  pathologyReadingProtocol, type PathologyReadingConfig, type ReadingContext } from '@clinmesh/contracts/pathology-reading'
import { z } from 'zod'

export interface PathologyReadingDeployment {
  serviceToken: string
  trustedOrigins: string[]
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export class PathologyReadingError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 | 502 | 503 = 409,
    readonly outcome: 'not-applied' | 'unknown' = 'not-applied') { super(message) }
}

export class PathJxAdapter {
  constructor(readonly config: PathologyReadingConfig, private readonly deployment: PathologyReadingDeployment) {
    if (!deployment.trustedOrigins.includes(config.endpoint) || !deployment.trustedOrigins.includes(config.viewerOrigin)) {
      throw new PathologyReadingError('PATHOLOGY_READING_ORIGIN_UNTRUSTED', 'The reading service origin is not deployment-approved', 403)
    }
  }

  async capabilities() {
    const result = await this.request('/capabilities', readingCapabilitiesSchema)
    if (result.instanceId !== this.config.instanceId) throw new PathologyReadingError('PATHOLOGY_READING_INSTANCE_MISMATCH', 'The reading service instance has changed')
    return result
  }

  async bind(input: { bindingId: string; intentId: string; contentHash: string; assetKey: string; context: ReadingContext;
    organ: 'colorectal' | 'thyroid'; specimenType: string; stain: 'HE' }) {
    const { bindingId, ...body } = input
    const result = await this.request(`/bindings/${encodeURIComponent(bindingId)}`, readingBindingSchema, 'PUT', { protocol: pathologyReadingProtocol, ...body })
    if (result.instanceId !== this.config.instanceId || result.bindingId !== bindingId || result.contentHash !== input.contentHash) {
      throw new PathologyReadingError('PATHOLOGY_READING_BINDING_MISMATCH', 'The original slide binding cannot be verified')
    }
    return result
  }

  createSession(input: { intentId: string; bindingId: string; actor: { id: string; displayName: string }; context: ReadingContext;
    writable: boolean; parentOrigin: string; expiresAt: string; authorizationToken: string }) {
    return this.request('/sessions', readingSessionCreatedSchema, 'POST', { protocol: pathologyReadingProtocol, ...input })
  }

  async operation(intentId: string, bindingId: string) {
    const result = await this.request(`/operations/${encodeURIComponent(intentId)}?bindingId=${encodeURIComponent(bindingId)}`, readingOperationSchema)
    if (result.intentId !== intentId) throw new PathologyReadingError('PATHOLOGY_READING_PROTOCOL_INVALID', 'The original reading intent could not be verified', 502)
    return result
  }
  binding(bindingId: string) { return this.request(`/bindings/${encodeURIComponent(bindingId)}`, readingBindingStatusSchema) }
  asset(assetKey: string) { return this.request(`/assets/${encodeURIComponent(assetKey)}`, readingAssetStatusSchema) }
  closeSession(sessionId: string) { return this.request(`/sessions/${encodeURIComponent(sessionId)}`, z.unknown(), 'DELETE') }

  async request<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown): Promise<T> {
    const writing = method !== 'GET'
    let response: Response
    try {
      response = await (this.deployment.fetch ?? globalThis.fetch)(`${this.config.endpoint}/api/integrations/clinmesh/v1${path}`, {
        method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(this.deployment.timeoutMs ?? 5000),
        headers: { authorization: `Bearer ${this.deployment.serviceToken}`, accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      throw new PathologyReadingError('PATHOLOGY_READING_UNAVAILABLE', 'The reading service request could not be confirmed', 503, writing ? 'unknown' : 'not-applied')
    }
    if (!response.ok) {
      throw new PathologyReadingError(response.status === 404 ? 'PATHOLOGY_READING_OBJECT_MISSING' : response.status === 409 ? 'PATHOLOGY_READING_CONFLICT' : 'PATHOLOGY_READING_UNAVAILABLE',
        'The reading service rejected the request', response.status === 409 ? 409 : 503,
        writing && response.status >= 500 ? 'unknown' : 'not-applied')
    }
    if (response.status === 204) return schema.parse(undefined)
    const length = Number(response.headers.get('content-length'))
    if (length > 2_097_152) throw new PathologyReadingError('PATHOLOGY_READING_PROTOCOL_INVALID', 'The reading response exceeds its budget', 502, writing ? 'unknown' : 'not-applied')
    try {
      const text = await response.text()
      if (Buffer.byteLength(text) > 2_097_152) throw new Error('response budget')
      return schema.parse(JSON.parse(text))
    } catch {
      throw new PathologyReadingError('PATHOLOGY_READING_PROTOCOL_INVALID', 'The reading service returned an invalid protocol response', 502, writing ? 'unknown' : 'not-applied')
    }
  }
}
