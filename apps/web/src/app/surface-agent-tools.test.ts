import { describe, expect, it, vi } from 'vitest'
import type { AgentPageContextBinding, AgentToolDefinition } from '@clinmesh/contracts/agent'
import { buildSurfaceAgentTools } from './surface-agent-tools.ts'
import { ApiClientError } from './api-client.ts'

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
  it('keeps the native pause marker when both the action and failed-result recording lose their responses', async () => {
    const settled = vi.fn()
    const tools = buildSurfaceAgentTools({
      binding, definitions, actions: { 'registration.patient.search': {
        description: 'Search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        execute: async () => { throw new ApiClientError(0, 'NETWORK_ERROR', 'Response lost') },
      } },
      authorize: async request => ({ callId: 'call', context: binding.snapshot, dshSessionId: 'dsh-session-1',
        operationId: request.operationId, receiptToken: 'receipt', status: 'authorized' }),
      complete: async () => { throw new ApiClientError(0, 'NETWORK_ERROR', 'Completion lost') },
      issueProof: async () => 'proof', readState: () => ({}), review: async () => ({}), onExecutionSettled: settled,
    })
    const tool = tools.find(tool => tool.name === 'clinmesh_search_patients')!
    const signal = new AbortController().signal
    await expect(tool.execute({ query: '合成患者', scopeKey: binding.snapshot.scopeKey, pageRevision: '["view-1",null]' }, signal))
      .rejects.toThrow('CLINMESH_EXECUTION_UNCONFIRMED: Response lost')
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith('proof', signal, true))
  })
  it('keeps the loaded queue page on the production query path and discards a late result after a case change', async () => {
    const doctor: AgentPageContextBinding = { ...binding, snapshot: { ...binding.snapshot,
      actor: { actorId: 'doctor', practitionerRoleId: 'doctor-role', roleCode: 'outpatient-doctor' },
      claim: { ...binding.snapshot.claim, viewId: 'consultation', selection: { id: 'case-1', kind: 'case', version: '1' } },
      allowedOperationIds: ['outpatient.case.read'] } }
    const execute = vi.fn()
    const action = { description: 'Read current case', parameters: { type: 'object' as const }, execute }
    let frame = { binding: doctor, actions: { 'outpatient.case.read': action },
      readState: () => ({ queue: { page: 2, pageSize: 20, total: 21, items: [] } }) }
    let switchCase = false
    const issueProof = vi.fn(async () => 'proof')
    const read = buildSurfaceAgentTools({ ...frame, resolveFrame: () => frame,
      definitions: [{ mode: 'query', operationId: 'outpatient.case.read', risk: 'read-only', roleCodes: ['outpatient-doctor'],
        toolName: 'clinmesh_read_doctor_context', viewIds: ['consultation'] }],
      authorize: async request => ({ callId: 'call', context: doctor.snapshot, dshSessionId: 'dsh-session-1',
        operationId: request.operationId, receiptToken: 'receipt', status: 'authorized' }),
      queryDoctor: async () => {
        if (switchCase) frame = { ...frame, binding: { ...doctor, snapshot: { ...doctor.snapshot,
          claim: { ...doctor.snapshot.claim, selection: { id: 'case-2', kind: 'case', version: '1' } } } } }
        return { caseId: 'case-1', queue: { page: 1, pageSize: 20, total: 21, items: [] } }
      },
      issueProof, complete: async () => ({}), review: async () => ({}),
    })[0]!
    const data = JSON.parse(await read.execute({ scopeKey: 'old-model-scope', pageRevision: 'old-revision' }, new AbortController().signal)).data
    expect(data.queue).toMatchObject({ page: 2, pageSize: 20, total: 21 })
    expect(execute).not.toHaveBeenCalled()
    await expect(read.execute({ patientId: 'untrusted-patient' }, new AbortController().signal)).rejects.toThrow()
    expect(issueProof).toHaveBeenCalledOnce()
    switchCase = true
    await expect(read.execute({}, new AbortController().signal)).rejects.toThrow('CLINMESH_TASK_CHANGED')
  })
  it('recovers one rejected doctor read after a same-case context update before executing its body', async () => {
    const doctor: AgentPageContextBinding = { ...binding, snapshot: { ...binding.snapshot,
      actor: { actorId: 'doctor', practitionerRoleId: 'doctor-role', roleCode: 'outpatient-doctor' },
      claim: { ...binding.snapshot.claim, viewId: 'consultation', selection: { id: 'case-1', kind: 'case', version: '1' } },
      allowedOperationIds: ['outpatient.case.read'] } }
    const action = { description: 'Read current case', parameters: { type: 'object' as const }, execute: vi.fn(async () => ({ caseId: 'case-1' })) }
    let frame = { binding: doctor, actions: { 'outpatient.case.read': action }, readState: () => ({}) }
    const issueProof = vi.fn(async () => 'proof-1')
    let attempts = 0
    const read = buildSurfaceAgentTools({ ...frame, resolveFrame: () => frame,
      definitions: [{ mode: 'query', operationId: 'outpatient.case.read', risk: 'read-only', roleCodes: ['outpatient-doctor'],
        toolName: 'clinmesh_read_doctor_context', viewIds: ['consultation'] }],
      authorize: async request => {
        attempts += 1
        if (attempts === 1) {
          frame = { ...frame, binding: { ...doctor, token: 'renewed-token', snapshot: { ...doctor.snapshot, id: 'context-2' } } }
          throw new ApiClientError(401, 'AGENT_CONTEXT_INVALID', 'Context renewed')
        }
        expect(request.contextToken).toBe('renewed-token')
        return { callId: 'call', context: frame.binding.snapshot, dshSessionId: 'dsh-session-1',
          operationId: request.operationId, receiptToken: 'receipt', status: 'authorized' }
      },
      issueProof, complete: async () => ({}), review: async () => ({}),
    })[0]!
    await expect(read.execute({}, new AbortController().signal)).resolves.toContain('"caseId":"case-1"')
    expect(issueProof).toHaveBeenCalledWith(expect.objectContaining({ contextId: 'context-2', previousProof: 'proof-1' }))
    expect(attempts).toBe(2)
    expect(action.execute).toHaveBeenCalledOnce()
  })
  it('reads the current doctor frame after a same-case update without model binding arguments', async () => {
    const doctorBinding: AgentPageContextBinding = { ...binding, snapshot: { ...binding.snapshot,
      actor: { actorId: 'actor-doctor', practitionerRoleId: 'role-doctor', roleCode: 'outpatient-doctor' },
      allowedOperationIds: ['ui.context.read', 'outpatient.case.read'], scopeKey: 'doctor-case-before-update',
      claim: { ...binding.snapshot.claim, viewId: 'consultation', activeSection: 'record',
        selection: { id: 'case-1', kind: 'case', version: '1' } } } }
    const oldRead = vi.fn(async () => ({ caseId: 'case-1', saved: 'before update' }))
    const newRead = vi.fn(async () => ({ caseId: 'case-1', saved: 'after update' }))
    const oldAction = { description: 'Read doctor case', parameters: { type: 'object' as const }, execute: oldRead }
    let frame = { binding: doctorBinding, actions: { 'outpatient.case.read': oldAction },
      readState: () => ({ unsaved: 'before doctor edit' }) }
    const issueProof = vi.fn(async () => 'proof')
    const tools = buildSurfaceAgentTools({ ...frame, resolveFrame: () => frame, resolveBinding: () => frame.binding,
      definitions: [{ ...definitions[0]!, roleCodes: ['outpatient-doctor'], viewIds: ['consultation'] },
        { mode: 'query', operationId: 'outpatient.case.read', risk: 'read-only', roleCodes: ['outpatient-doctor'],
          toolName: 'clinmesh_read_doctor_context', viewIds: ['consultation'] }],
      authorize: async request => ({ callId: 'call', context: frame.binding.snapshot,
        dshSessionId: frame.binding.snapshot.dshSessionId, operationId: request.operationId,
        receiptToken: 'receipt', status: 'authorized' }),
      issueProof, complete: async () => ({}), review: async () => ({}),
    })
    frame = { binding: { ...doctorBinding, token: 'new-context-token', snapshot: { ...doctorBinding.snapshot,
      id: 'context-after-update', scopeKey: 'doctor-case-after-update', claim: { ...doctorBinding.snapshot.claim,
        viewRevision: 'view-2', activeSection: 'laboratory', selection: { id: 'case-1', kind: 'case', version: '2' } } } },
      actions: { 'outpatient.case.read': { ...oldAction, execute: newRead } },
      readState: () => ({ unsaved: 'current doctor edit' }) }
    for (const tool of tools) {
      expect(tool.parameters).not.toHaveProperty('properties.scopeKey')
      expect(tool.parameters).not.toHaveProperty('properties.pageRevision')
      const result = JSON.parse(await tool.execute({ scopeKey: doctorBinding.snapshot.scopeKey,
        pageRevision: '["view-1",null]' }, new AbortController().signal))
      expect(result.ok).toBe(true)
      if (tool.name === 'clinmesh_read_current_context') {
        expect(result.data.pageState).toEqual({ unsaved: 'current doctor edit' })
        expect(result.data.snapshot.id).toBe('context-after-update')
      } else expect(result.data.saved).toBe('after update')
    }
    expect(oldRead).not.toHaveBeenCalled()
    expect(newRead).toHaveBeenCalledOnce()
    expect(issueProof).toHaveBeenCalledWith(expect.objectContaining({ contextId: 'context-after-update',
      scopeKey: 'doctor-case-after-update', pageRevision: '["view-2",null]' }))
  })

  it('executes arguments generated before Context renewal with the same semantic page binding', async () => {
    const renewed = { ...binding, token: 'renewed-context-token', snapshot: {
      ...binding.snapshot, id: 'context-after-renewal',
      claim: { ...binding.snapshot.claim, ui: { status: 'loading' as const } },
    } }
    const issueProof = vi.fn(async () => 'proof')
    const tools = buildSurfaceAgentTools({
      actions: {}, binding: renewed, definitions,
      authorize: async () => ({ callId: 'call', context: renewed.snapshot,
        dshSessionId: renewed.snapshot.dshSessionId, operationId: 'ui.context.read',
        receiptToken: 'receipt', status: 'authorized' }),
      complete: async () => ({}), issueProof,
      readState: () => ({ queue: 'visible' }), review: async () => ({}),
    })
    const read = tools.find(tool => tool.name === 'clinmesh_read_current_context')!
    expect(read.parameters).not.toHaveProperty('properties.contextId')
    const result = JSON.parse(await read.execute({
      scopeKey: binding.snapshot.scopeKey, pageRevision: '["view-1",null]',
    }, new AbortController().signal))
    expect(result).toMatchObject({ ok: true, data: { snapshot: { id: 'context-after-renewal' } } })
    expect(issueProof).toHaveBeenCalledWith(expect.objectContaining({
      contextId: 'context-after-renewal', scopeKey: binding.snapshot.scopeKey,
      pageRevision: '["view-1",null]',
    }))
    await expect(read.execute({
      scopeKey: binding.snapshot.scopeKey, pageRevision: '["view-before-edit",null]',
    }, new AbortController().signal)).rejects.toThrow('CLINMESH_BINDING_MISMATCH')
    expect(issueProof).toHaveBeenCalledOnce()
  })

  it.each([
    [new ApiClientError(0, 'NETWORK_ERROR', 'Response lost'), 'unconfirmed'],
    [new ApiClientError(0, 'REQUEST_TIMEOUT', 'Timed out'), 'unconfirmed'],
    [new ApiClientError(200, 'UNEXPECTED_RESPONSE', 'Unreadable response'), 'unconfirmed'],
    [new ApiClientError(409, 'VERSION_CONFLICT', 'Version changed'), 'failed'],
  ])('preserves uncertain results for page writes and approved Commands: %s', async (error, phase) => {
    for (const detached of [false, true]) {
      let rejectDecision: (error: unknown) => void = () => undefined
      const decision = new Promise<never>((_, reject) => { rejectDecision = reject })
      const feedback = vi.fn()
      const tools = buildSurfaceAgentTools({
        actions: { 'registration.patient.create.propose': {
          description: 'Create patient', parameters: { type: 'object' },
          execute: () => {
            if (!detached) throw error
            return { kind: 'clinmesh-agent-review', decision, bindDecisionGate: () => undefined }
          },
        } },
        binding, definitions,
        authorize: async input => ({ callId: 'call', context: binding.snapshot, dshSessionId: 'session',
          operationId: input.operationId, proposalId: 'proposal', receiptToken: 'receipt', status: 'authorized' }),
        complete: async () => ({}), onActionFeedback: feedback,
        issueProof: async () => 'proof', readState: () => ({}), review: async () => ({}),
      })
      const execute = tools.find(tool => tool.name === 'clinmesh_prepare_create_patient')!.execute(
        { pageRevision: '["view-1",null]', scopeKey: binding.snapshot.scopeKey }, new AbortController().signal,
      )
      if (detached) { await execute; rejectDecision(error) }
      else await expect(execute).rejects.toThrow(error.message)
      await vi.waitFor(() => expect(feedback.mock.lastCall?.[0].phase).toBe(phase))
      if (phase === 'unconfirmed') expect(feedback.mock.lastCall?.[0].message).toContain('请读取当前状态')
    }
  })

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
    const feedback = vi.fn()
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
      onActionFeedback: feedback,
      issueProof: vi.fn(async () => 'proof-with-at-least-32-characters'),
      readState: () => ({ queueStatus: 'empty' }),
      review: vi.fn(async () => ({ decision: 'approved' })),
    })

    expect(tools.map(tool => tool.name)).toEqual([
      'clinmesh_read_current_context',
      'clinmesh_search_patients',
    ])
    expect(tools[1]?.description).toContain('读取当前授权页面及未保存内容')
    expect(tools[1]?.description).toContain('const 不会自动填入')
    expect(tools[1]?.description).toContain('不是强制覆盖授权或并发修改保护')
    expect(tools[1]?.parameters).toMatchObject({
      properties: {
        pageRevision: { const: '["view-1",null]' },
        query: { type: 'string' },
        scopeKey: { const: 'clinmesh:registrar:registration' },
        scores: { type: 'array', items: { type: 'number' } },
      },
    })
    expect(JSON.stringify(tools[1]?.parameters)).not.toMatch(
      /format|maxLength|minItems|minimum/,
    )
    const result = JSON.parse(await tools[1]!.execute({
      pageRevision: '["view-1",null]',
      scopeKey: 'clinmesh:registrar:registration',
      query: '张',
    }, new AbortController().signal)) as Record<string, unknown>
    expect(result).toMatchObject({ data: { matches: 1 }, ok: true })
    expect(search).toHaveBeenCalledOnce()
    expect(feedback.mock.calls.map(([event]) => event.phase)).toEqual(['executing', 'completed'])
    expect(feedback.mock.calls[0]?.[0]).toMatchObject({
      operationId: 'registration.patient.search', input: { query: '张' },
    })
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

  it.each(['AGENT_CONTEXT_EXPIRED', 'AGENT_CONTEXT_INVALID', 'AGENT_CONTEXT_STALE'])(
    'gives current-binding recovery guidance before executing for %s', async code => {
      const readState = vi.fn()
      const tools = buildSurfaceAgentTools({
        actions: {}, binding, definitions,
        authorize: async () => { throw new ApiClientError(409, code, 'Context unavailable') },
        complete: vi.fn(), issueProof: async () => 'proof', readState, review: vi.fn(),
      })
      const result = tools[0]!.execute({
        pageRevision: '["view-1",null]', scopeKey: binding.snapshot.scopeKey,
      }, new AbortController().signal)
      await expect(result).rejects.toThrow(`${code}:`)
      await expect(result).rejects.toThrow('当前工具 schema')
      expect(readState).not.toHaveBeenCalled()
    },
  )

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
      readState: () => ({
        provider: { available: true, unavailableReason: undefined },
        selectedPatientId: 'patient-1',
      }),
      review: vi.fn(async () => ({ decision: 'approved' })),
    })
    const read = tools.find(tool => tool.name === 'clinmesh_read_current_context')!
    const value = JSON.parse(await read.execute(
      { pageRevision: '["view-1",null]', scopeKey: 'clinmesh:registrar:registration' },
      new AbortController().signal,
    )) as Record<string, unknown>
    expect(value).toMatchObject({
      ok: true,
      data: {
        pageState: {
          provider: { available: true },
          selectedPatientId: 'patient-1',
        },
        snapshot: { id: 'context-1' },
      },
    })
    expect(JSON.stringify(value)).not.toContain('unavailableReason')
    expect(JSON.stringify(value)).not.toContain('hiddenFacts')
    await expect(read.execute({}, new AbortController().signal))
      .rejects.toThrow('CLINMESH_BINDING_ARGUMENTS_INVALID')
    await expect(read.execute(
      { pageRevision: '["view-1",null]', scopeKey: 'clinmesh:forged' },
      new AbortController().signal,
    )).rejects.toThrow('CLINMESH_BINDING_MISMATCH')
    expect(authorize).toHaveBeenCalledOnce()
  })

  it('returns a pending proposal before completing the later human review decision', async () => {
    let resolveDecision: (value: { approved: boolean }) => void = () => undefined
    const decision = new Promise<{ approved: boolean }>(resolve => {
      resolveDecision = resolve
    })
    const bindDecisionGate = vi.fn()
    const feedback = vi.fn()
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
      onActionFeedback: feedback,
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
      { pageRevision: '["view-1",null]', scopeKey: binding.snapshot.scopeKey },
      new AbortController().signal,
    )).resolves.toContain('awaiting-human-review')
    expect(complete).not.toHaveBeenCalled()
    expect(bindDecisionGate).toHaveBeenCalledOnce()
    expect(feedback.mock.calls.map(([event]) => event.phase)).toEqual(['executing', 'awaiting-review'])

    resolveDecision({ approved: false })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, result: { approved: false } }),
      expect.any(AbortSignal),
    ))
    expect(feedback.mock.lastCall?.[0].phase).toBe('rejected')
  })

  it('does not report success when authorization fails or the result receipt is unconfirmed', async () => {
    const feedback = vi.fn()
    const authorize = vi.fn(async () => { throw new Error('scope expired') })
    const complete = vi.fn(async () => { throw new Error('receipt unavailable') })
    const makeTools = () => buildSurfaceAgentTools({
      actions: { 'registration.patient.search': {
        description: 'Search patients', parameters: { type: 'object' }, execute: () => ({ matches: 1 }),
      } },
      binding, definitions, authorize, complete, onActionFeedback: feedback,
      issueProof: async () => 'proof', readState: () => ({}), review: async () => ({}),
    })
    const bound = { pageRevision: '["view-1",null]', scopeKey: binding.snapshot.scopeKey, query: '张' }
    await expect(makeTools()[1]!.execute(bound, new AbortController().signal)).rejects.toThrow('scope expired')
    expect(feedback).not.toHaveBeenCalled()
    const accepted = {
      callId: 'call', context: binding.snapshot, dshSessionId: 'session', operationId: 'registration.patient.search',
      receiptToken: 'receipt', status: 'authorized' as const,
    }
    const authorized = buildSurfaceAgentTools({
      actions: { 'registration.patient.search': {
        description: 'Search patients', parameters: { type: 'object' }, execute: () => ({ matches: 1 }),
      } },
      binding, definitions, authorize: async () => accepted, complete, onActionFeedback: feedback,
      issueProof: async () => 'proof', readState: () => ({}), review: async () => ({}),
    })
    await expect(authorized[1]!.execute(bound, new AbortController().signal)).rejects.toThrow('receipt unavailable')
    expect(feedback.mock.calls.map(([event]) => event.phase)).toEqual(['executing', 'unconfirmed'])
  })
})
