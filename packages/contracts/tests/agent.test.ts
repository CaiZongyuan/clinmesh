import { describe, expect, it } from 'vitest'
import {
  agentPageContextClaimSchema,
  agentPageBindingRevision,
  agentPageContextRequestSchema,
  agentPageContextSnapshotSchema,
  agentSelectionKindSchema,
  agentExecutionProofPayloadSchema,
  agentToolAuthorizationRequestSchema,
  agentToolCatalog,
  agentHumanRoleCodeSchema,
  agentToolsForContext,
  agentViewsForRole,
  doctorCaseSectionSchema,
  parseAgentToolInput,
} from '../src/agent.ts'

describe('ClinMesh DSH Agent contracts', () => {
  it('keeps the page binding revision stable across transient UI state and binds draft state', () => {
    const claim = agentPageContextClaimSchema.parse({
      version: 1,
      viewId: 'registration',
      viewRevision: 'view-17',
      ui: { status: 'ready' },
    })
    expect(agentPageBindingRevision(claim)).toBe('["view-17",null]')
    expect(agentPageBindingRevision({ ...claim, ui: { status: 'loading' } }))
      .toBe('["view-17",null]')
    expect(agentPageBindingRevision({
      ...claim,
      draft: { kind: 'patient', id: 'patient-draft', revision: '3', dirty: true },
    })).toBe('["view-17",["patient","patient-draft","3",true]]')
  })

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
    const sections = [undefined, ...doctorCaseSectionSchema.options]
    for (const roleCode of agentHumanRoleCodeSchema.options) {
      for (const viewId of agentViewsForRole(roleCode)) {
        for (const activeSection of sections) {
          const tools = agentToolsForContext(roleCode, viewId, activeSection)
          expect(tools.length, `${roleCode}/${viewId}/${activeSection}`).toBeGreaterThan(0)
          expect(tools.length, `${roleCode}/${viewId}/${activeSection}`).toBeLessThanOrEqual(32)
          expect(new Set(tools.map(tool => tool.toolName)).size).toBe(tools.length)
          for (const tool of tools) {
            expect(tool.toolName).toMatch(/^clinmesh_[a-z0-9_]+$/)
            expect(tool.toolName).not.toBe('clinmesh_execute_action')
            expect(tool.roleCodes).toContain(roleCode)
            expect(tool.viewIds).toContain(viewId)
            if (tool.section !== undefined) expect(tool.section).toBe(activeSection)
          }
        }
      }
    }
  })

  it('publishes each doctor section Tool only in its own section and cross-section Tools in every section', () => {
    const doctorTools = agentToolCatalog.filter(tool => tool.roleCodes.includes('outpatient-doctor')
      && tool.viewIds.includes('consultation'))
    const crossSection = doctorTools.filter(tool => tool.section === undefined)
      .map(tool => tool.operationId)
    expect(crossSection).toEqual([
      'ui.context.read',
      'ui.navigate',
      'ui.panel.focus',
      'outpatient.case.read',
      'outpatient.case.select',
      'outpatient.section.select',
      'outpatient.first-visit.draft.set',
      'outpatient.revisit.draft.set',
      'outpatient.visit.start.propose',
      'outpatient.encounter.complete.propose',
    ])
    expect(doctorTools.filter(tool => tool.section !== undefined).every(tool => (
      tool.operationId.startsWith('outpatient.')
    ))).toBe(true)
    for (const section of doctorCaseSectionSchema.options) {
      const published = agentToolsForContext('outpatient-doctor', 'consultation', section)
        .map(tool => tool.operationId)
      expect(published).toEqual(expect.arrayContaining(crossSection))
      expect(published).toEqual(doctorTools
        .filter(tool => tool.section === undefined || tool.section === section)
        .map(tool => tool.operationId))
    }
    expect(agentToolsForContext('outpatient-doctor', 'consultation').map(tool => tool.operationId))
      .toEqual(crossSection)
    expect(agentToolsForContext('outpatient-doctor', 'consultation', 'laboratory')
      .map(tool => tool.operationId)).toEqual(expect.arrayContaining([
      'outpatient.laboratory.draft.set',
      'outpatient.report.acknowledge.propose',
      'outpatient.imaging.issue.propose',
    ]))
    expect(agentToolsForContext('outpatient-doctor', 'consultation', 'record')
      .map(tool => tool.operationId)).not.toContain('outpatient.report.acknowledge.propose')
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

  it('exposes synthetic data status and reviewed reset from the administrator page', () => {
    const adminTools = agentToolsForContext('administrator', 'scenarioData')
    expect(adminTools.map(tool => tool.operationId)).toEqual([
      'ui.context.read',
      'ui.navigate',
      'ui.panel.focus',
      'scenario.status.read',
      'scenario.providers.read',
      'scenario.generation.status.read',
      'scenario.reset.propose',
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

  it('opens an imaging study only through the laboratory section', () => {
    expect(parseAgentToolInput('outpatient.section.select', {
      imagingRequestId: 'imaging-request-1',
      section: 'laboratory',
    })).toEqual({ imagingRequestId: 'imaging-request-1', section: 'laboratory' })
    expect(() => parseAgentToolInput('outpatient.section.select', {
      imagingRequestId: 'imaging-request-1',
      section: 'record',
    })).toThrow()
  })

  it('keeps imaging Tools narrow: no pixels, asset identity, or free-text report rewrite', () => {
    const imagingTools = agentToolsForContext('outpatient-doctor', 'consultation', 'laboratory')
      .filter(tool => tool.operationId.startsWith('outpatient.imaging.'))
    expect(imagingTools.map(tool => [tool.operationId, tool.mode])).toEqual([
      ['outpatient.imaging.draft.set', 'draft'],
      ['outpatient.imaging.issue.propose', 'proposal'],
      ['outpatient.imaging.cancel.propose', 'proposal'],
      ['outpatient.imaging.retry.propose', 'proposal'],
      ['outpatient.imaging.correct.propose', 'proposal'],
    ])
    expect(parseAgentToolInput('outpatient.imaging.draft.set', {
      indication: 'x'.repeat(500),
      serviceId: 'imaging-chest-ct-plain',
    })).toEqual({ indication: 'x'.repeat(500), serviceId: 'imaging-chest-ct-plain' })
    expect(() => parseAgentToolInput('outpatient.imaging.draft.set', {
      indication: 'x'.repeat(501),
      serviceId: 'imaging-chest-ct-plain',
    })).toThrow()
    expect(() => parseAgentToolInput('outpatient.imaging.draft.set', {
      assetId: 'asset-1',
      indication: '咳嗽两周',
      serviceId: 'imaging-chest-ct-plain',
    })).toThrow()
    const correction = { reason: '报告内容已重新核对', reportRevision: 2, requestId: 'imaging-request-1' }
    expect(parseAgentToolInput('outpatient.imaging.correct.propose', correction)).toEqual(correction)
    expect(() => parseAgentToolInput('outpatient.imaging.correct.propose', {
      ...correction,
      impression: '自由改写的印象',
    })).toThrow()
  })

  it('opens a slide only through the laboratory section', () => {
    expect(parseAgentToolInput('outpatient.section.select', {
      pathologyRequestId: 'pathology-request-1',
      section: 'laboratory',
    })).toEqual({ pathologyRequestId: 'pathology-request-1', section: 'laboratory' })
    expect(() => parseAgentToolInput('outpatient.section.select', {
      pathologyRequestId: 'pathology-request-1',
      section: 'record',
    })).toThrow()
  })

  it('keeps pathology Tools narrow: no pixels, asset identity, or free-text report rewrite', () => {
    const laboratoryTools = agentToolsForContext('outpatient-doctor', 'consultation', 'laboratory')
    // 检验、放射与病理三类申请的 Tool 同在“检验检查”栏目，合计仍在单次注册上限内。
    expect(laboratoryTools.length).toBeLessThanOrEqual(32)
    expect(laboratoryTools.filter(tool => tool.operationId.startsWith('outpatient.pathology.'))
      .map(tool => [tool.operationId, tool.mode])).toEqual([
      ['outpatient.pathology.draft.set', 'draft'],
      ['outpatient.pathology.issue.propose', 'proposal'],
      ['outpatient.pathology.cancel.propose', 'proposal'],
      ['outpatient.pathology.retry.propose', 'proposal'],
      ['outpatient.pathology.correct.propose', 'proposal'],
    ])
    expect(agentToolsForContext('outpatient-doctor', 'consultation', 'record')
      .some(tool => tool.operationId.startsWith('outpatient.pathology.'))).toBe(false)
    const draft = {
      purpose: '外院切片复核',
      serviceId: 'pathology-breast-slide-consultation',
      sourceProcedureReference: 'urn:uuid:procedure-0',
    }
    expect(parseAgentToolInput('outpatient.pathology.draft.set', draft)).toEqual(draft)
    expect(() => parseAgentToolInput('outpatient.pathology.draft.set', { ...draft, assetId: 'asset-1' })).toThrow()
    expect(() => parseAgentToolInput('outpatient.pathology.draft.set', { ...draft, purpose: 'x'.repeat(501) })).toThrow()
    expect(() => parseAgentToolInput('outpatient.pathology.draft.set', {
      purpose: draft.purpose,
      serviceId: draft.serviceId,
    })).toThrow()
    const correction = { reason: '报告内容已重新核对', reportRevision: 2, requestId: 'pathology-request-1' }
    expect(parseAgentToolInput('outpatient.pathology.correct.propose', correction)).toEqual(correction)
    expect(() => parseAgentToolInput('outpatient.pathology.correct.propose', {
      ...correction,
      diagnosis: '自由改写的病理诊断',
    })).toThrow()
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
      version: 2,
      callId: 'call-17',
      contextId: 'context-17',
      dshSessionId: 'session-1',
      scopeKey: 'clinmesh:registrar:registration',
      pageRevision: '["view-17",null]',
      toolName: 'clinmesh_read_current_context',
      issuedAt: '2026-08-31T00:00:00.000Z',
      expiresAt: '2026-08-31T00:01:00.000Z',
    })
    expect(proof.callId).toBe('call-17')
    expect(agentExecutionProofPayloadSchema.safeParse({ ...proof, version: 1 }).success).toBe(false)
    expect(agentExecutionProofPayloadSchema.safeParse({ ...proof, pageRevision: undefined }).success).toBe(false)
    expect(agentExecutionProofPayloadSchema.safeParse({ ...proof, pageRevision: 'x'.repeat(1025) }).success).toBe(false)
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
