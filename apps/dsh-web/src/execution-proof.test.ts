import { describe, expect, it } from 'vitest'
import {
  AgentExecutionProofIssuer,
  parseAgentExecutionProof,
} from './execution-proof.ts'

describe('DSH Agent execution proof issuer', () => {
  it('issues one proof only for an observed pending Tool call', () => {
    const issuer = new AgentExecutionProofIssuer({
      now: () => new Date('2026-08-31T00:00:00.000Z'),
      secret: 'test-dsh-bridge-secret-with-at-least-32-characters',
    })
    const finish = issuer.begin({
      callId: 'call-1',
      contextId: 'context-1',
      dshSessionId: 'session-1',
      scopeKey: 'clinmesh:registrar:registration',
      toolName: 'clinmesh_read_current_context',
    })

    expect(() => issuer.issue({
      contextId: 'context-2',
      scopeKey: 'clinmesh:registrar:registration',
      toolName: 'clinmesh_read_current_context',
    })).toThrow('pending')

    const token = issuer.issue({
      contextId: 'context-1',
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
      scopeKey: 'clinmesh:registrar:registration',
    })
    expect(() => issuer.issue({
      contextId: 'context-1',
      scopeKey: 'clinmesh:registrar:registration',
      toolName: 'clinmesh_read_current_context',
    })).toThrow('already issued')
    finish()
    expect(() => issuer.issue({
      contextId: 'context-1',
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
      contextId: 'context-1',
      dshSessionId: 'session-1',
      scopeKey: 'clinmesh:registrar:registration',
      toolName: 'clinmesh_read_current_context',
    })
    expect(() => issuer.begin({
      callId: 'call-2',
      contextId: 'context-1',
      dshSessionId: 'session-1',
      scopeKey: 'clinmesh:registrar:registration',
      toolName: 'clinmesh_read_current_context',
    })).toThrow('already pending')
    const token = issuer.issue({
      contextId: 'context-1',
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
