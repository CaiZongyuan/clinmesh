import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { LlmCallConfig, PreparedLlmCall } from '@deepseek-ai/dsh-llm'

export function syntheticRecognitionLlm(stream: PreparedLlmCall['stream']) {
  return { prepareCall: async (config: LlmCallConfig) => ({ config, stream }) }
}

// External control-server transport for Host-only lifecycle tests. Full authorization
// and persistence are covered by the real Server/Host integration tests.
export const syntheticHostUsageControl = {
  upstreamOrigin: 'http://synthetic.invalid',
  fetch: (async (input: RequestInfo | URL) => new URL(String(input)).pathname.endsWith('/admit')
    ? Response.json({ attemptId: randomUUID(), receipt: 'synthetic-receipt-for-host-only-tests' }, { status: 201 })
    : new URL(String(input)).pathname.endsWith('/status') ? Response.json({ abort: false })
      : Response.json({ recorded: true })) as typeof fetch,
}

export function doctorInputPermit(input: {
  text: string; dshSessionId: string; rpcId: string; scopeKey: string; pageRevision: string; secret: string
}): string {
  const payload = { contextId: 'synthetic-context', dshSessionId: input.dshSessionId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), inputHash: createHash('sha256').update(input.text).digest('hex'),
    issuedAt: new Date().toISOString(), pageRevision: input.pageRevision, purpose: 'clinmesh-doctor-input',
    rpcId: input.rpcId, scopeKey: input.scopeKey, taskId: randomUUID(), version: 2 }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return encoded + '.' + createHmac('sha256', input.secret).update(encoded).digest('base64url')
}
