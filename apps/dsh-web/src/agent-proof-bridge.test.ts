import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { installAgentProofBridge } from './agent-proof-bridge.ts'

// The host event bus is external; the installed listener and proof issuer are real.
function bridge() {
  const on = vi.fn()
  const currentTool = vi.fn(() => ({ parameters: { type: 'object', properties: {
    scopeKey: { type: 'string', const: 'scope' },
    pageRevision: { type: 'string', const: '["view-1",null]' },
  } } }))
  installAgentProofBridge({ on, effect: vi.fn(), tools: { get: currentTool } } as unknown as Context,
    'test-bridge-secret-with-at-least-32-characters')
  const before = on.mock.calls.find(([name]) => name === 'tools/pre-execute')![1] as (
    execution: ToolExecution, next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: string; reason?: string }>
  const finish = on.mock.calls.find(([name]) => name === 'tools/result')![1] as (
    execution: ToolExecution,
  ) => void
  return { before, finish, currentTool }
}

function execution(args: unknown, session = true, name = 'clinmesh_fill_clinical_document_draft') {
  return {
    arguments: args, callId: crypto.randomUUID(), name,
    ...(session ? { agent: { session: { id: 'synthetic-session' } } } : {}),
  } as ToolExecution
}

describe('ClinMesh host Tool binding diagnostics', () => {
  it('rejects a call generated for an earlier page before dispatching or creating a proof', async () => {
    const { before } = bridge()
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    for (const args of [
      { scopeKey: 'other-patient', pageRevision: '["view-1",null]' },
      { scopeKey: 'scope', pageRevision: '["before-edit",null]' },
    ]) {
      expect(await before(execution(args), next)).toMatchObject({
        kind: 'deny', reason: expect.stringContaining('CLINMESH_BINDING_MISMATCH'),
      })
    }
    expect(next).not.toHaveBeenCalled()
  })

  it.each([
    [{ assessment: 'synthetic' }, ['pageRevision', 'scopeKey']],
    [{ pageRevision: '["view-1",null]' }, ['scopeKey']],
    [{ pageRevision: '', scopeKey: 'scope' }, ['pageRevision']],
    [{ pageRevision: '["view-1",null]', scopeKey: 42 }, ['scopeKey']],
    [null, ['scopeKey', 'pageRevision']],
  ])('identifies invalid binding fields without dispatching: %j', async (args, fields) => {
    const { before } = bridge()
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    const result = await before(execution(args), next)
    expect(result.kind).toBe('deny')
    expect(result.reason).toContain('CLINMESH_BINDING_ARGUMENTS_INVALID')
    expect(result.reason).toContain(fields.join(', '))
    expect(result.reason).toContain('const')
    expect(next).not.toHaveBeenCalled()
  })

  it('distinguishes a missing host session from missing arguments', async () => {
    const { before } = bridge()
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    const result = await before(execution({ pageRevision: '["view-1",null]', scopeKey: 'scope' }, false), next)
    expect(result.reason).toContain('CLINMESH_HOST_SESSION_REQUIRED')
    expect(next).not.toHaveBeenCalled()
  })

  it('allows a corrected call, then read and repeated writes with the same binding', async () => {
    const { before, finish } = bridge()
    const next = async () => ({ kind: 'allow' as const })
    expect((await before(execution({}), next)).kind).toBe('deny')
    for (const name of ['clinmesh_read_current_context',
      'clinmesh_fill_clinical_document_draft', 'clinmesh_fill_clinical_document_draft']) {
      const call = execution({ pageRevision: '["view-1",null]', scopeKey: 'scope' }, true, name)
      expect(await before(call, next)).toEqual({ kind: 'allow' })
      finish(call)
    }
    expect(await before(execution({}, false, 'other_tool'), next)).toEqual({ kind: 'allow' })
  })
})
