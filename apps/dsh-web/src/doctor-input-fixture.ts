import { createHash, createHmac, randomUUID } from 'node:crypto'

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
