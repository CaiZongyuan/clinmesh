import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  agentExecutionProofPayloadSchema,
} from '@clinmesh/contracts/agent'

const PROOF_TTL_MS = 60_000

interface ProofOptions {
  now?: () => Date
  secret: string
}

interface PendingExecution {
  callId: string
  dshSessionId: string
  issued: boolean
  scopeKey: string
  toolName: string
}

function pendingKey(input: { scopeKey: string; toolName: string }): string {
  return `${input.scopeKey}\u0000${input.toolName}`
}

export class AgentExecutionProofIssuer {
  readonly #now: () => Date
  readonly #pending = new Map<string, PendingExecution>()
  readonly #secret: string

  constructor(options: ProofOptions) {
    this.#now = options.now ?? (() => new Date())
    this.#secret = options.secret
  }

  begin(input: Omit<PendingExecution, 'issued'>): () => void {
    const key = pendingKey(input)
    if (this.#pending.has(key)) {
      throw new Error('A ClinMesh Tool call is already pending for this context and operation')
    }
    const pending: PendingExecution = { ...input, issued: false }
    this.#pending.set(key, pending)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.#pending.get(key) === pending) this.#pending.delete(key)
    }
  }

  issue(input: { scopeKey: string; toolName: string }): string {
    const pending = this.#pending.get(pendingKey(input))
    if (pending === undefined) throw new Error('No pending ClinMesh Tool call matches this context')
    if (pending.issued) throw new Error('The pending ClinMesh Tool proof was already issued')
    pending.issued = true
    const now = this.#now()
    return signAgentExecutionProof({
      callId: pending.callId,
      dshSessionId: pending.dshSessionId,
      expiresAt: new Date(now.getTime() + PROOF_TTL_MS).toISOString(),
      issuedAt: now.toISOString(),
      scopeKey: pending.scopeKey,
      toolName: pending.toolName,
      version: 1,
    }, this.#secret)
  }
}

export function signAgentExecutionProof(
  payload: Parameters<typeof agentExecutionProofPayloadSchema.parse>[0],
  secret: string,
): string {
  const parsed = agentExecutionProofPayloadSchema.parse(payload)
  const encoded = Buffer.from(JSON.stringify(parsed)).toString('base64url')
  return `${encoded}.${signature(encoded, secret).toString('base64url')}`
}

export function parseAgentExecutionProof(
  token: string,
  options: ProofOptions,
): ReturnType<typeof agentExecutionProofPayloadSchema.parse> {
  const [encodedPayload, encodedSignature, extra] = token.split('.')
  if (encodedPayload === undefined || encodedSignature === undefined || extra !== undefined) {
    throw invalidProof()
  }
  const expected = signature(encodedPayload, options.secret)
  const actual = Buffer.from(encodedSignature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw invalidProof()
  }
  let payload: ReturnType<typeof agentExecutionProofPayloadSchema.parse>
  try {
    payload = agentExecutionProofPayloadSchema.parse(
      JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()),
    )
  } catch {
    throw invalidProof()
  }
  if (Date.parse(payload.expiresAt) <= (options.now ?? (() => new Date()))().getTime()) {
    throw new Error('The DSH Agent execution proof has expired')
  }
  return payload
}

function signature(encodedPayload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(encodedPayload).digest()
}

function invalidProof(): Error {
  return new Error('The DSH Agent execution proof is invalid')
}
