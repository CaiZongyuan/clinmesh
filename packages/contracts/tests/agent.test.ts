import { describe, expect, it } from 'vitest'
import {
  agentPageContextClaimSchema,
  agentPageContextRequestSchema,
  agentPageContextSnapshotSchema,
  agentSelectionKindSchema,
  agentExecutionProofPayloadSchema,
  agentToolAuthorizationRequestSchema,
  agentToolCatalog,
  agentToolsForContext,
  agentViewsForRole,
  parseAgentToolInput,
} from '../src/agent.ts'

describe('ClinMesh DSH Agent contracts', () => {
  it('accepts a bounded page claim and rejects arbitrary or hidden state', () => {
    const claim = {
      version: 1,
      viewId: 'consultation',
      viewRevision: 'view-17',
      activeSection: 'diagnosis',
      selection: {
        kind: 'encounter',
        id: 'encounter-1',
        version: '4',
      },
      draft: {
        kind: 'diagnosis',
        id: 'encounter-1:diagnosis',
        revision: '3',
        dirty: true,
      },
      ui: {
        status: 'ready',
        search: '发热',
      },
    }

    expect(agentPageContextClaimSchema.parse(claim)).toEqual(claim)
    expect(agentPageContextClaimSchema.safeParse({
      ...claim,
      caseTruth: { diagnosis: 'secret' },
    }).success).toBe(false)
    expect(agentPageContextClaimSchema.safeParse({
      ...claim,
      ui: { ...claim.ui, arbitraryPageDump: '<html>secret</html>' },
    }).success).toBe(false)
  })

  it('requires server-owned identity, scope, expiry, and operation grants in a snapshot', () => {
    const snapshot = agentPageContextSnapshotSchema.parse({
      version: 1,
      id: 'context-1',
      claim: {
        version: 1,
        viewId: 'registration',
        viewRevision: 'view-1',
        ui: { status: 'ready' },
      },
      actor: {
        actorId: 'actor-registrar',
        practitionerRoleId: 'practitioner-role-registrar',
        roleCode: 'registrar',
      },
      workspace: {
        id: 'workspace-demo',
        epoch: 'epoch-1',
        scenarioRunId: 'scenario-run-1',
      },
      allowedOperationIds: ['registration.patient.search'],
      dshSessionId: 'dsh-session-1',
      scopeKey: 'clinmesh:registrar:registration',
      issuedAt: '2026-08-31T00:00:00.000Z',
      expiresAt: '2026-08-31T00:05:00.000Z',
    })

    expect(snapshot.actor.roleCode).toBe('registrar')
    expect(snapshot.allowedOperationIds).toEqual(['registration.patient.search'])
  })

  it('binds Page Context issuance to one DSH Session and monotonic browser revision', () => {
    expect(agentPageContextRequestSchema.parse({
      claim: {
        version: 1,
        viewId: 'registration',
        viewRevision: 'view-1',
        ui: { status: 'ready' },
      },
      client: { id: 'surface-client-1', revision: 2 },
      dshSessionId: 'dsh-session-1',
    })).toMatchObject({
      client: { id: 'surface-client-1', revision: 2 },
      dshSessionId: 'dsh-session-1',
    })
    expect(agentPageContextRequestSchema.safeParse({
      claim: {
        version: 1,
        viewId: 'registration',
        viewRevision: 'view-1',
        ui: { status: 'ready' },
      },
      client: { id: 'surface-client-1', revision: 0 },
      dshSessionId: 'dsh-session-1',
    }).success).toBe(false)
  })

  it('publishes only narrow, role-scoped tools within the broker limit', () => {
    const contexts = [
      ['administrator', 'overview'],
      ['registrar', 'registration'],
      ['triage-nurse', 'triage'],
      ['outpatient-doctor', 'consultation'],
      ['cashier', 'billing'],
      ['pharmacist', 'pharmacy'],
    ] as const

    for (const [roleCode, viewId] of contexts) {
      const tools = agentToolsForContext(roleCode, viewId)
      expect(tools.length).toBeGreaterThan(0)
      expect(tools.length).toBeLessThanOrEqual(32)
      expect(new Set(tools.map(tool => tool.toolName)).size).toBe(tools.length)
      for (const tool of tools) {
        expect(tool.toolName).toMatch(/^clinmesh_[a-z0-9_]+$/)
        expect(tool.toolName).not.toBe('clinmesh_execute_action')
        expect(tool.roleCodes).toContain(roleCode)
        expect(tool.viewIds).toContain(viewId)
      }
    }
  })

  it('publishes registrar Synthetic Case search, selection, and human-review actions', () => {
    expect(agentSelectionKindSchema.parse('synthetic-case')).toBe('synthetic-case')
    expect(agentToolsForContext('registrar', 'registration').map(tool => tool.operationId))
      .toEqual(expect.arrayContaining([
        'registration.synthetic-case.search',
        'registration.synthetic-case.select',
        'registration.synthetic-case.start.propose',
      ]))
    expect(parseAgentToolInput('registration.synthetic-case.search', { query: '张琴' }))
      .toEqual({ query: '张琴' })
    expect(parseAgentToolInput('registration.synthetic-case.select', {
      caseId: 'synthetic-case-001',
    })).toEqual({ caseId: 'synthetic-case-001' })
  })

  it('limits navigation destinations to the current role and shared settings', () => {
    expect(agentViewsForRole('registrar')).toEqual([
      'registration',
      'settingsGeneral',
      'uiComponents',
    ])
    expect(agentViewsForRole('administrator')).toEqual([
      'overview',
      'scenarioData',
      'settingsGeneral',
      'uiComponents',
    ])
    expect(agentViewsForRole('registrar')).not.toContain('consultation')
  })

  it('keeps formal hospital effects behind human review', () => {
    const formalOperations = agentToolCatalog.filter(tool => tool.mode === 'proposal')
    expect(formalOperations.length).toBeGreaterThan(0)
    expect(formalOperations.every(tool => tool.risk === 'human-review')).toBe(true)
    expect(agentToolCatalog.map(tool => tool.mode)).not.toContain('command')
  })

  it('exposes only Provider and generation status from Scenario authoring', () => {
    const adminTools = agentToolsForContext('administrator', 'scenarioData')
    expect(adminTools.map(tool => tool.operationId)).toEqual([
      'ui.context.read',
      'ui.navigate',
      'ui.panel.focus',
      'scenario.providers.read',
      'scenario.generation.status.read',
    ])
  })

  it('uses the current doctor page ids for Agent section selection', () => {
    expect(parseAgentToolInput('outpatient.section.select', { section: 'laboratory' }))
      .toEqual({ section: 'laboratory' })
    expect(() => parseAgentToolInput(
      'outpatient.section.select',
      { section: 'examination' },
    )).toThrow()
  })

  it('matches laboratory draft Tool lengths to the owning Command input', () => {
    const maximumInput = {
      catalogItemId: 'l'.repeat(512),
      indicationCode: 'i'.repeat(64),
    }
    expect(parseAgentToolInput('outpatient.laboratory.draft.set', maximumInput))
      .toEqual(maximumInput)
    expect(() => parseAgentToolInput('outpatient.laboratory.draft.set', {
      ...maximumInput,
      catalogItemId: 'l'.repeat(513),
    })).toThrow()
    expect(() => parseAgentToolInput('outpatient.laboratory.draft.set', {
      ...maximumInput,
      indicationCode: 'i'.repeat(65),
    })).toThrow()
  })

  it('binds one execution proof and authorization request to an exact Tool call', () => {
    const proof = agentExecutionProofPayloadSchema.parse({
      version: 1,
      callId: 'call-17',
      contextId: 'context-17',
      dshSessionId: 'session-1',
      scopeKey: 'clinmesh:registrar:registration',
      toolName: 'clinmesh_read_current_context',
      issuedAt: '2026-08-31T00:00:00.000Z',
      expiresAt: '2026-08-31T00:01:00.000Z',
    })
    expect(proof.callId).toBe('call-17')
    expect(agentToolAuthorizationRequestSchema.parse({
      contextToken: 'c'.repeat(32),
      executionProof: 'p'.repeat(32),
      operationId: 'ui.context.read',
      input: {},
    }).operationId).toBe('ui.context.read')
    expect(agentToolAuthorizationRequestSchema.safeParse({
      contextToken: 'c'.repeat(32),
      executionProof: 'p'.repeat(32),
      operationId: 'registration.patient.search',
      input: { query: 'x'.repeat(101) },
    }).success).toBe(false)
    expect(agentToolAuthorizationRequestSchema.safeParse({
      contextToken: 'c'.repeat(32),
      executionProof: 'p'.repeat(32),
      operationId: 'triage.draft.set',
      input: {
        acuityCode: 'level-2',
        chiefComplaint: '发热',
        diastolicMmHg: 80,
        oxygenSaturationPct: 101,
        pulseBpm: 90,
        respirationBpm: 18,
        systolicMmHg: 120,
        temperatureC: 38.5,
      },
    }).success).toBe(false)
    expect(agentExecutionProofPayloadSchema.safeParse({
      ...proof,
      runAs: 'actor-administrator',
    }).success).toBe(false)
  })
})
