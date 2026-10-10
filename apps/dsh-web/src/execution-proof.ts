import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  agentExecutionProofPayloadSchema,
  doctorAgentTaskPermitPayloadSchema,
  agentToolCatalog,
  isDoctorReadOperation,
} from '@clinmesh/contracts/agent'

const PROOF_TTL_MS = 60_000
const doctorReadNames = new Set(agentToolCatalog.filter(tool => isDoctorReadOperation(tool.operationId))
  .map(tool => tool.toolName))

interface ProofOptions {
  now?: () => Date
  secret: string
}

interface PendingExecution {
  callId: string
  dshSessionId: string
  issued: boolean
  recovered?: boolean
  proof?: string
  pageRevision: string
  origin?: ReturnType<typeof agentExecutionProofPayloadSchema.parse>['origin']
  scopeKey: string
  toolName: string
}

function pendingKey(input: { pageRevision: string; scopeKey: string; toolName: string }): string {
  return JSON.stringify([input.scopeKey, input.pageRevision, input.toolName])
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
      const currentKey = pendingKey(pending)
      if (this.#pending.get(currentKey) === pending) this.#pending.delete(currentKey)
    }
  }

  issue(input: { contextId: string; pageRevision: string; scopeKey: string; toolName: string; previousProof?: string | undefined }): string {
    const previous = input.previousProof === undefined ? undefined
      : parseAgentExecutionProof(input.previousProof, { secret: this.#secret, now: this.#now })
    const key = pendingKey(previous ?? input)
    const pending = this.#pending.get(key)
    if (pending === undefined) throw new Error('No pending ClinMesh Tool call matches this context')
    if (previous !== undefined) {
      if (pending.proof !== input.previousProof || pending.toolName !== input.toolName
        || !doctorReadNames.has(input.toolName) || pending.origin === undefined) {
        throw new Error('No pending doctor read matches the previous proof')
      }
      if (pending.recovered) throw new Error('The pending ClinMesh Tool proof was already issued for recovery')
      const updatedKey = pendingKey(input)
      if (this.#pending.has(updatedKey) && this.#pending.get(updatedKey) !== pending) {
        throw new Error('A ClinMesh Tool call is already pending for this context and operation')
      }
      this.#pending.delete(key)
      Object.assign(pending, { scopeKey: input.scopeKey, pageRevision: input.pageRevision, recovered: true })
      this.#pending.set(updatedKey, pending)
    } else if (pending.issued) throw new Error('The pending ClinMesh Tool proof was already issued')
    pending.issued = true
    const now = this.#now()
    pending.proof = signAgentExecutionProof({
      callId: pending.callId,
      contextId: input.contextId,
      dshSessionId: pending.dshSessionId,
      expiresAt: new Date(now.getTime() + PROOF_TTL_MS).toISOString(),
      issuedAt: now.toISOString(),
      pageRevision: pending.pageRevision,
      ...(pending.origin === undefined ? {} : { origin: pending.origin }),
      scopeKey: pending.scopeKey,
      toolName: pending.toolName,
      version: 3,
    }, this.#secret)
    return pending.proof
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

export function parseDoctorAgentTaskPermit(token: string, options: ProofOptions):
  ReturnType<typeof doctorAgentTaskPermitPayloadSchema.parse> {
  const [encoded, signed, extra] = token.split('.')
  if (encoded === undefined || signed === undefined || extra !== undefined) throw invalidProof()
  const expected = signature(encoded, options.secret)
  const actual = Buffer.from(signed, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalidProof()
  let payload: ReturnType<typeof doctorAgentTaskPermitPayloadSchema.parse>
  try { payload = doctorAgentTaskPermitPayloadSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString())) }
  catch { throw invalidProof() }
  if (Date.parse(payload.expiresAt) <= (options.now ?? (() => new Date()))().getTime()) {
    throw new Error('The doctor task permit has expired')
  }
  return payload
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
