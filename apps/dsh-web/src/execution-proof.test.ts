import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  AgentExecutionProofIssuer,
  parseAgentExecutionProof,
  parseDoctorAgentTaskPermit,
} from './execution-proof.ts'

describe('direct doctor task permits', () => {
  it('verifies the signed binding and rejects tampering, another issuer, malformed payloads and expiry', () => {
    const secret = 'synthetic-doctor-task-secret-at-least-32-characters'
    const now = () => new Date('2026-10-10T00:00:00.000Z')
    const payload = { scopeKey: 'doctor-case-scope', pageRevision: '["consultation",null]',
      contextId: 'current-context', dshSessionId: 'current-session', rpcId: 'human-rpc',
      inputHash: 'a'.repeat(64), issuedAt: now().toISOString(), expiresAt: '2026-10-10T00:01:00.000Z',
      purpose: 'clinmesh-doctor-delegation', taskId: '01234567-89ab-7def-8123-456789abcdef', version: 1 }
    const sign = (value: unknown) => {
      const encoded = Buffer.from(JSON.stringify(value)).toString('base64url')
      return encoded + '.' + createHmac('sha256', secret).update(encoded).digest('base64url')
    }
    const permit = sign(payload)
    expect(parseDoctorAgentTaskPermit(permit, { secret, now })).toEqual(payload)
    expect(() => parseDoctorAgentTaskPermit(permit + 'x', { secret, now })).toThrow('invalid')
    expect(() => parseDoctorAgentTaskPermit(permit, { secret: 'another-host-secret', now })).toThrow('invalid')
    expect(() => parseDoctorAgentTaskPermit(sign({ ...payload, inputHash: 'invalid' }), { secret, now })).toThrow('invalid')
    expect(() => parseDoctorAgentTaskPermit(permit, { secret,
      now: () => new Date('2026-10-10T00:01:00.000Z') })).toThrow('expired')
  })
})

describe('DSH Agent execution proof issuer', () => {
  it('rebinds one explicitly rejected read once while preserving its native call and origin', () => {
    const secret = 'synthetic-read-recovery-secret-at-least-32-characters'
    const now = () => new Date('2026-10-10T00:00:00.000Z')
    const issuer = new AgentExecutionProofIssuer({ secret, now })
    const initial = { scopeKey: 'current-case', pageRevision: '["before",null]', toolName: 'clinmesh_read_doctor_context' }
    const origin = { request: { scopeKey: 'original-request', pageRevision: '["original",null]' },
      task: { scopeKey: 'case-at-input', pageRevision: '["input",null]', messageId: 'human-message',
        rpcId: 'human-rpc', turn: 1, acceptedAt: now().toISOString() } }
    issuer.begin({ ...initial, callId: 'read-call', dshSessionId: 'same-session', origin })
    const previousProof = issuer.issue({ ...initial, contextId: 'before-context' })
    const updated = { ...initial, pageRevision: '["after",null]', contextId: 'after-context' }
    const recovered = issuer.issue({ ...updated, previousProof })
    expect(parseAgentExecutionProof(recovered, { secret, now })).toMatchObject({
      ...updated, callId: 'read-call', dshSessionId: 'same-session', origin,
    })
    expect(() => issuer.issue({ ...updated, contextId: 'third-context', previousProof: recovered })).toThrow('already issued')
    expect(() => issuer.issue({ ...updated, contextId: 'another-context', previousProof })).toThrow('pending')
  })

  it('keeps the original doctor task and request separate from the current read binding', () => {
    const secret = 'test-dsh-bridge-secret-with-at-least-32-characters'
    const now = () => new Date('2026-08-31T00:00:00.000Z')
    const issuer = new AgentExecutionProofIssuer({ secret, now })
    const origin = {
      request: { scopeKey: 'clinmesh:case-1-before-update', pageRevision: '["before",null]' },
      task: { scopeKey: 'clinmesh:case-1-at-input', pageRevision: '["input",null]',
        messageId: 'doctor-message-1', acceptedAt: now().toISOString(), rpcId: 'human-request-1', turn: 1 },
    }
    issuer.begin({ callId: 'read-after-update', dshSessionId: 'session-1',
      scopeKey: 'clinmesh:case-1-after-update', pageRevision: '["after",null]',
      toolName: 'clinmesh_read_doctor_context', origin })
    const token = issuer.issue({ contextId: 'context-after-update', scopeKey: 'clinmesh:case-1-after-update',
      pageRevision: '["after",null]', toolName: 'clinmesh_read_doctor_context' })
    expect(parseAgentExecutionProof(token, { secret, now })).toMatchObject({
      contextId: 'context-after-update', callId: 'read-after-update',
      scopeKey: 'clinmesh:case-1-after-update', pageRevision: '["after",null]', origin,
    })
  })

  it('binds a renewed Context to the observed scope and page revision only once', () => {
    const secret = 'test-dsh-bridge-secret-with-at-least-32-characters'
    const now = () => new Date('2026-08-31T00:00:00.000Z')
    const issuer = new AgentExecutionProofIssuer({ secret, now })
    const finish = issuer.begin({
      callId: 'renewed-call', dshSessionId: 'session-1',
      pageRevision: '["view-1",null]',
      scopeKey: 'clinmesh:case-1',
      toolName: 'clinmesh_read_current_context',
    })
    const request = {
      contextId: 'context-after-renewal', scopeKey: 'clinmesh:case-1',
      pageRevision: '["view-1",null]', toolName: 'clinmesh_read_current_context',
    }
    expect(() => issuer.issue({ ...request, pageRevision: '["view-2",null]' })).toThrow('pending')
    expect(() => issuer.issue({ ...request, scopeKey: 'clinmesh:case-2' })).toThrow('pending')
    const proof = issuer.issue(request)
    expect(parseAgentExecutionProof(proof, { secret, now })).toMatchObject({
      callId: 'renewed-call', contextId: 'context-after-renewal',
      dshSessionId: 'session-1', scopeKey: 'clinmesh:case-1',
      pageRevision: '["view-1",null]', version: 3,
    })
    expect(() => issuer.issue({ ...request, contextId: 'another-context' })).toThrow('already issued')
    finish()
    expect(() => issuer.issue(request)).toThrow('pending')
  })

  it('issues one proof only for an observed pending Tool call', () => {
    const issuer = new AgentExecutionProofIssuer({
      now: () => new Date('2026-08-31T00:00:00.000Z'),
      secret: 'test-dsh-bridge-secret-with-at-least-32-characters',
    })
    const finish = issuer.begin({
      callId: 'call-1',
      dshSessionId: 'session-1',
      pageRevision: '["view-1",null]',
      scopeKey: 'clinmesh:registrar:registration',
      toolName: 'clinmesh_read_current_context',
    })

    expect(() => issuer.issue({
      contextId: 'context-2',
      pageRevision: '["wrong-view",null]',
      scopeKey: 'clinmesh:registrar:registration',
      toolName: 'clinmesh_read_current_context',
    })).toThrow('pending')

    const token = issuer.issue({
      contextId: 'context-1',
      pageRevision: '["view-1",null]',
      scopeKey: 'clinmesh:registrar:registration',
      toolName: 'clinmesh_read_current_context',
    })
    expect(parseAgentExecutionProof(token, {
      now: () => new Date('2026-08-31T00:00:30.000Z'),
      secret: 'test-dsh-bridge-secret-with-at-least-32-characters',
    })).toMatchObject({
      callId: 'call-1',
      contextId: 'context-1',
      dshSessionId: 'session-1',
      pageRevision: '["view-1",null]',
      scopeKey: 'clinmesh:registrar:registration',
    })
    expect(() => issuer.issue({
      contextId: 'context-1',
      pageRevision: '["view-1",null]',
      scopeKey: 'clinmesh:registrar:registration',
      toolName: 'clinmesh_read_current_context',
    })).toThrow('already issued')
    finish()
    expect(() => issuer.issue({
      contextId: 'context-1',
      pageRevision: '["view-1",null]',
      scopeKey: 'clinmesh:registrar:registration',
      toolName: 'clinmesh_read_current_context',
    })).toThrow('pending')
  })

  it('rejects duplicate pending calls, tampering, and expiry', () => {
    const secret = 'test-dsh-bridge-secret-with-at-least-32-characters'
    const issuer = new AgentExecutionProofIssuer({
      now: () => new Date('2026-08-31T00:00:00.000Z'),
      secret,
    })
    issuer.begin({
      callId: 'call-1',
      dshSessionId: 'session-1',
      pageRevision: '["view-1",null]',
      scopeKey: 'clinmesh:registrar:registration',
      toolName: 'clinmesh_read_current_context',
    })
    expect(() => issuer.begin({
      callId: 'call-2',
      dshSessionId: 'session-1',
      pageRevision: '["view-1",null]',
      scopeKey: 'clinmesh:registrar:registration',
      toolName: 'clinmesh_read_current_context',
    })).toThrow('already pending')
    const token = issuer.issue({
      contextId: 'context-1',
      pageRevision: '["view-1",null]',
      scopeKey: 'clinmesh:registrar:registration',
      toolName: 'clinmesh_read_current_context',
    })
    expect(() => parseAgentExecutionProof(`${token}x`, { now: () => new Date(), secret }))
      .toThrow('invalid')
    expect(() => parseAgentExecutionProof(token, {
      now: () => new Date('2026-08-31T00:02:00.000Z'),
      secret,
    })).toThrow('expired')
  })
})
