import { describe, expect, it, vi } from 'vitest'
import type { AgentToolDefinition } from '@clinmesh/contracts/agent'
import { buildSurfaceAgentTools } from './surface-agent-tools.ts'

const binding = {
  snapshot: {
    version: 1 as const,
    id: 'context-1',
    claim: {
      version: 1 as const,
      viewId: 'registration' as const,
      viewRevision: 'view-1',
      ui: { status: 'ready' as const },
    },
    actor: {
      actorId: 'actor-registrar',
      practitionerRoleId: 'practitioner-role-registrar',
      roleCode: 'registrar' as const,
    },
    workspace: {
      id: 'workspace-demo',
      epoch: 'epoch-1',
      scenarioRunId: 'scenario-run-1',
    },
    allowedOperationIds: [
      'ui.context.read',
      'registration.patient.search',
      'registration.patient.create.propose',
    ],
    dshSessionId: 'dsh-session-1',
    scopeKey: 'clinmesh:registrar:registration',
    issuedAt: '2026-08-31T00:00:00.000Z',
    expiresAt: '2026-08-31T00:05:00.000Z',
  },
  token: 'context-token-with-at-least-32-characters',
}

const definitions: AgentToolDefinition[] = [
  {
    mode: 'query',
    operationId: 'ui.context.read',
    risk: 'read-only',
    roleCodes: ['registrar'],
    toolName: 'clinmesh_read_current_context',
    viewIds: ['registration'],
  },
  {
    mode: 'query',
    operationId: 'registration.patient.search',
    risk: 'read-only',
    roleCodes: ['registrar'],
    toolName: 'clinmesh_search_patients',
    viewIds: ['registration'],
  },
  {
    mode: 'proposal',
    operationId: 'registration.patient.create.propose',
    risk: 'human-review',
    roleCodes: ['registrar'],
    toolName: 'clinmesh_prepare_create_patient',
    viewIds: ['registration'],
  },
]

describe('ClinMesh Surface Agent tools', () => {
  it('binds the current context and records one authorized page action', async () => {
    const search = vi.fn(async (input: unknown) => ({ input, matches: 1 }))
    const authorize = vi.fn(async input => ({
      callId: 'call-1',
      context: binding.snapshot,
      dshSessionId: 'session-1',
      operationId: input.operationId,
      receiptToken: 'receipt-token-with-at-least-32-characters',
      status: 'authorized' as const,
    }))
    const complete = vi.fn(async () => ({ status: 'completed' as const }))
    const tools = buildSurfaceAgentTools({
      actions: {
        'registration.patient.search': {
          description: 'Search visible synthetic patients.',
          execute: search,
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', format: 'search', maxLength: 100 },
              scores: {
                type: 'array',
                minItems: 1,
                items: { type: 'number', minimum: 0 },
              },
            },
            required: ['query'],
            additionalProperties: false,
          },
        },
      },
      authorize,
      binding,
      complete,
      definitions,
      issueProof: vi.fn(async () => 'proof-with-at-least-32-characters'),
      readState: () => ({ queueStatus: 'empty' }),
      review: vi.fn(async () => ({ decision: 'approved' })),
    })

    expect(tools.map(tool => tool.name)).toEqual([
      'clinmesh_read_current_context',
      'clinmesh_search_patients',
    ])
    expect(tools[1]?.parameters).toMatchObject({
      properties: {
        contextId: { enum: ['context-1'] },
        query: { type: 'string' },
        scopeKey: { enum: ['clinmesh:registrar:registration'] },
        scores: { type: 'array', items: { type: 'number' } },
      },
    })
    expect(JSON.stringify(tools[1]?.parameters)).not.toMatch(
      /format|maxLength|minItems|minimum/,
    )
    const result = JSON.parse(await tools[1]!.execute({
      contextId: 'context-1',
      scopeKey: 'clinmesh:registrar:registration',
      query: '张',
    }, new AbortController().signal)) as Record<string, unknown>
    expect(result).toMatchObject({ data: { matches: 1 }, ok: true })
    expect(search).toHaveBeenCalledOnce()
    expect(authorize).toHaveBeenCalledOnce()
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ input: { query: '张' } }),
      expect.any(AbortSignal),
    )
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true }),
      expect.any(AbortSignal),
    )
  })

  it('returns only registered page state and rejects another scope key', async () => {
    const authorize = vi.fn(async input => ({
      callId: 'call-2',
      context: binding.snapshot,
      dshSessionId: 'session-1',
      operationId: input.operationId,
      receiptToken: 'receipt-token-with-at-least-32-characters',
      status: 'authorized' as const,
    }))
    const tools = buildSurfaceAgentTools({
      actions: {},
      authorize,
      binding,
      complete: vi.fn(async () => ({ status: 'completed' as const })),
      definitions,
      issueProof: vi.fn(async () => 'proof-with-at-least-32-characters'),
      readState: () => ({ selectedPatientId: 'patient-1' }),
      review: vi.fn(async () => ({ decision: 'approved' })),
    })
    const read = tools.find(tool => tool.name === 'clinmesh_read_current_context')!
    const value = JSON.parse(await read.execute(
      { contextId: 'context-1', scopeKey: 'clinmesh:registrar:registration' },
      new AbortController().signal,
    )) as Record<string, unknown>
    expect(value).toMatchObject({
      ok: true,
      data: {
        pageState: { selectedPatientId: 'patient-1' },
        snapshot: { id: 'context-1' },
      },
    })
    expect(JSON.stringify(value)).not.toContain('hiddenFacts')
    await expect(read.execute(
      { contextId: 'context-1', scopeKey: 'clinmesh:forged' },
      new AbortController().signal,
    )).rejects.toThrow('scope')
  })

  it('returns a pending proposal before completing the later human review decision', async () => {
    let resolveDecision: (value: { approved: boolean }) => void = () => undefined
    const decision = new Promise<{ approved: boolean }>(resolve => {
      resolveDecision = resolve
    })
    const bindDecisionGate = vi.fn()
    const complete = vi.fn(async () => ({ status: 'completed' as const }))
    const tools = buildSurfaceAgentTools({
      actions: {
        'registration.patient.create.propose': {
          description: 'Open human review for the current patient draft.',
          execute: () => ({ bindDecisionGate, kind: 'clinmesh-agent-review', decision }),
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      authorize: vi.fn(async input => ({
        callId: 'call-review-1',
        context: binding.snapshot,
        dshSessionId: 'session-1',
        operationId: input.operationId,
        proposalId: 'proposal-1',
        receiptToken: 'receipt-token-with-at-least-32-characters',
        status: 'authorized' as const,
      })),
      binding,
      complete,
      definitions,
      issueProof: vi.fn(async () => 'proof-with-at-least-32-characters'),
      readState: () => ({}),
      review: vi.fn(async () => ({
        decidedAt: '2026-08-31T00:00:01.000Z',
        decision: 'rejected' as const,
        proposalId: 'proposal-1',
      })),
    })
    const prepare = tools.find(tool => tool.name === 'clinmesh_prepare_create_patient')!

    await expect(prepare.execute(
      { contextId: 'context-1', scopeKey: binding.snapshot.scopeKey },
      new AbortController().signal,
    )).resolves.toContain('awaiting-human-review')
    expect(complete).not.toHaveBeenCalled()
    expect(bindDecisionGate).toHaveBeenCalledOnce()

    resolveDecision({ approved: false })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, result: { approved: false } }),
      expect.any(AbortSignal),
    ))
  })
})
