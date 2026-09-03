import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentPageContextBindingSchema,
  agentReviewDecisionResponseSchema,
  agentToolAuthorizationResponseSchema,
  agentToolCompletionResponseSchema,
  type AgentPageContextClaim,
} from '@clinmesh/contracts/agent'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'

describe('DSH Agent Page Context HTTP contract', () => {
  const runtimes: Array<Awaited<ReturnType<typeof createClinMeshRuntime>>> = []
  const directories: string[] = []
  let pageContextRevision = 0

  async function setup(
    email = 'registrar@demo.clinmesh.local',
    now?: () => Date,
  ) {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-agent-context-'))
    directories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      dshBridgeSecret: 'test-dsh-bridge-secret-with-at-least-32-characters',
      migrationMode: 'apply',
      ...(now === undefined ? {} : { now }),
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const signIn = await runtime.app.request('/api/auth/sign-in/email', {
      body: JSON.stringify({ email, password }),
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      method: 'POST',
    })
    expect(signIn.status).toBe(200)
    return {
      cookie: signIn.headers.get('set-cookie')?.split(';', 1)[0] ?? '',
      password,
      runtime,
    }
  }

  async function createContext(
    runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
    cookie: string,
    claim: AgentPageContextClaim | Record<string, unknown>,
    options: {
      clientId?: string
      clientRevision?: number
      dshSessionId?: string
    } = {},
  ) {
    pageContextRevision += 1
    return runtime.app.request('/api/agent/v1/page-contexts', {
      body: JSON.stringify({
        claim,
        client: {
          id: options.clientId ?? 'test-surface-client',
          revision: options.clientRevision ?? pageContextRevision,
        },
        dshSessionId: options.dshSessionId ?? 'dsh-session-1',
      }),
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost',
      },
      method: 'POST',
    })
  }

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true })))
  })

  it('signs a role-scoped snapshot from server-owned session context', async () => {
    const { cookie, runtime } = await setup()
    const response = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-view-1',
      ui: { status: 'ready', search: '张' },
    })

    expect(response.status).toBe(201)
    const binding = agentPageContextBindingSchema.parse(await response.json())
    expect(binding.snapshot).toMatchObject({
      actor: {
        actorId: 'actor-registrar',
        practitionerRoleId: 'practitioner-role-registrar',
        roleCode: 'registrar',
      },
      claim: { viewId: 'registration' },
      dshSessionId: 'dsh-session-1',
      workspace: {
        epoch: 'epoch-1',
        id: 'workspace-demo',
        scenarioRunId: 'scenario-run-1',
      },
    })
    expect(binding.snapshot.allowedOperationIds).toContain('registration.patient.search')
    expect(binding.snapshot.allowedOperationIds).not.toContain('outpatient.case.read')
  })

  it('rejects forged and stale resource references before signing Page Context', async () => {
    const { cookie, runtime } = await setup()
    const missing = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'forged-patient',
      selection: { id: 'patient-does-not-exist', kind: 'patient', version: '1' },
      ui: { status: 'ready' },
    })
    expect(missing.status).toBe(409)
    expect(await missing.json()).toMatchObject({ error: { code: 'AGENT_CONTEXT_STALE' } })

    const stale = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'stale-patient',
      selection: { id: 'candidate-patient-001', kind: 'patient', version: '999' },
      ui: { status: 'ready' },
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: { code: 'AGENT_CONTEXT_STALE' } })
  })

  it('binds registrar Synthetic Case proposals to one ready Case revision', async () => {
    const { cookie, runtime } = await setup()
    const caseId = 'synthetic-case-agent-001'
    const profileId = 'synthetic-profile-agent-001'
    const now = '2026-09-03T09:00:00.000+08:00'
    const identity = JSON.stringify({ displayName: '张琴', mrn: 'CMSYNAGENT001' })
    const demographics = JSON.stringify({ birthDate: '1970-01-01', gender: 'female' })
    runtime.database.driver.prepare(`
      INSERT INTO synthetic_patient_profile (
        workspace_id, profile_id, batch_id, batch_name, source_patient_id,
        revision, display_name, mrn, identity_json, demographics_json,
        source_hash, raw_source_json, generation_json,
        created_by_actor_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'workspace-demo', profileId, 'batch-agent', 'Agent 测试批次', 'source-patient-agent',
      1, '张琴', 'CMSYNAGENT001', identity, demographics,
      'a'.repeat(64), '{}', '{}', 'actor-administrator', now, now,
    )
    runtime.database.driver.prepare(`
      INSERT INTO synthetic_patient_profile_revision (
        workspace_id, profile_id, revision, identity_json, demographics_json,
        created_by_actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('workspace-demo', profileId, 1, identity, demographics, 'actor-administrator', now)
    runtime.database.driver.prepare(`
      INSERT INTO synthetic_case_instance (
        workspace_id, case_id, profile_id, profile_revision, revision,
        case_type, status, active_brief_revision, source_hash,
        visible_history_count, created_by_actor_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'workspace-demo', caseId, profileId, 1, 3, 'follow-up', 'brief-ready', 1,
      'a'.repeat(64), 0, 'actor-administrator', now, now,
    )
    runtime.database.driver.prepare(`
      INSERT INTO patient_brief_revision (
        workspace_id, case_id, revision, content_json, model_id,
        prompt_version, prompt_hash, input_hash, output_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'workspace-demo', caseId, 1, '{}', 'test-model', 'test-prompt-v1',
      'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64), now,
    )
    const claim = {
      version: 1 as const,
      viewId: 'registration' as const,
      viewRevision: 'registration-synthetic-case-1',
      selection: { id: caseId, kind: 'synthetic-case' as const, version: '3' },
      draft: {
        dirty: false,
        id: caseId,
        kind: 'registration' as const,
        revision: 'registration-draft-1',
      },
      ui: { status: 'ready' as const },
    }

    const response = await createContext(runtime, cookie, claim)
    expect(response.status).toBe(201)
    const binding = agentPageContextBindingSchema.parse(await response.json())
    expect(binding.snapshot.allowedOperationIds).toEqual(expect.arrayContaining([
      'registration.synthetic-case.search',
      'registration.synthetic-case.select',
      'registration.synthetic-case.start.propose',
    ]))
    expect(binding.snapshot.allowedOperationIds).not.toContain('registration.outpatient.propose')

    runtime.database.driver.prepare(`
      UPDATE synthetic_case_instance SET status = 'started', revision = 4
      WHERE workspace_id = ? AND case_id = ?
    `).run('workspace-demo', caseId)
    const stale = await createContext(runtime, cookie, {
      ...claim,
      viewRevision: 'registration-synthetic-case-stale',
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: { code: 'AGENT_CONTEXT_STALE' } })
  })

  it('re-signs a selected Encounter from its current triage state and version', async () => {
    const { cookie, password, runtime } = await setup()
    const mutationHeaders = {
      'content-type': 'application/json',
      cookie,
      origin: 'http://localhost',
    }
    const patientResponse = await runtime.app.request('/api/his/v1/patients', {
      body: JSON.stringify({
        expectedVersions: {},
        input: {
          birthDate: '1992-02-02',
          gender: 'female',
          identifier: 'CM-AGENT-CONTEXT-001',
          name: '合成上下文患者',
        },
      }),
      headers: { ...mutationHeaders, 'idempotency-key': randomUUID() },
      method: 'POST',
    })
    const patient = await patientResponse.json() as {
      data: { patient: { id: string; versionId: string } }
    }
    const catalogResponse = await runtime.app.request('/api/his/v1/catalogs/registration', {
      headers: { cookie },
    })
    const catalog = await catalogResponse.json() as {
      departments: Array<{ id: string }>
      locations: Array<{ id: string }>
      virtualDate: string
      visitTypes: Array<{ id: string }>
    }
    const registrationResponse = await runtime.app.request('/api/his/v1/registrations/actions/register', {
      body: JSON.stringify({
        expectedVersions: {
          [`Patient/${patient.data.patient.id}`]: patient.data.patient.versionId,
        },
        input: {
          departmentId: catalog.departments[0]?.id,
          locationId: catalog.locations[0]?.id,
          patientId: patient.data.patient.id,
          visitDate: catalog.virtualDate,
          visitTypeId: catalog.visitTypes[0]?.id,
        },
      }),
      headers: { ...mutationHeaders, 'idempotency-key': randomUUID() },
      method: 'POST',
    })
    expect(registrationResponse.status).toBe(200)

    const triageSignIn = await runtime.app.request('/api/auth/sign-in/email', {
      body: JSON.stringify({ email: 'triage@demo.clinmesh.local', password }),
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      method: 'POST',
    })
    const triageCookie = triageSignIn.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    const queueResponse = await runtime.app.request('/api/his/v1/triage/queue?status=pending', {
      headers: { cookie: triageCookie },
    })
    const queue = await queueResponse.json() as {
      items: Array<{
        caseId: string
        encounterId: string
        encounterVersion: string
        taskId: string
        taskVersion: string
      }>
    }
    const item = queue.items.find(candidate => candidate.encounterId !== undefined)
    expect(item).toBeDefined()
    const pendingContext = await createContext(runtime, triageCookie, {
      activeSection: 'pending',
      draft: {
        dirty: true,
        id: `${item!.caseId}:triage`,
        kind: 'triage',
        revision: 'triage-draft-1',
      },
      selection: { id: item!.caseId, kind: 'triage-item', version: item!.taskVersion },
      ui: { status: 'ready' },
      version: 1,
      viewId: 'triage',
      viewRevision: 'triage-pending-1',
    })
    expect(pendingContext.status).toBe(201)
    const pending = agentPageContextBindingSchema.parse(await pendingContext.json())
    expect(pending.snapshot.allowedOperationIds).toContain('triage.record.propose')

    const triageResponse = await runtime.app.request(
      `/api/his/v1/encounters/${item!.encounterId}/actions/record-triage`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${item!.encounterId}`]: item!.encounterVersion,
            [`Task/${item!.taskId}`]: item!.taskVersion,
          },
          input: {
            acuityCode: 'level-3',
            bloodPressure: { diastolicMmHg: 78, systolicMmHg: 118 },
            chiefComplaint: '发热伴咽痛',
            oxygenSaturationPct: 98,
            pulseBpm: 92,
            respirationBpm: 18,
            temperatureC: 38.2,
          },
        }),
        headers: {
          'content-type': 'application/json',
          cookie: triageCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(triageResponse.status).toBe(200)
    const triaged = await triageResponse.json() as {
      data: { encounterVersion: string }
    }

    const staleContext = await createContext(runtime, triageCookie, {
      activeSection: 'pending',
      selection: { id: item!.caseId, kind: 'triage-item', version: item!.taskVersion },
      ui: { status: 'ready' },
      version: 1,
      viewId: 'triage',
      viewRevision: 'triage-stale-1',
    })
    expect(staleContext.status).toBe(409)
    expect(await staleContext.json()).toMatchObject({ error: { code: 'AGENT_CONTEXT_STALE' } })

    const completedContext = await createContext(runtime, triageCookie, {
      activeSection: 'completed',
      selection: { id: item!.caseId, kind: 'triage-item', version: '2' },
      ui: { status: 'ready' },
      version: 1,
      viewId: 'triage',
      viewRevision: 'triage-completed-1',
    })
    expect(completedContext.status).toBe(201)
    const completed = agentPageContextBindingSchema.parse(await completedContext.json())
    expect(completed.snapshot.allowedOperationIds).not.toContain('triage.record.propose')

    const doctorSignIn = await runtime.app.request('/api/auth/sign-in/email', {
      body: JSON.stringify({ email: 'doctor@demo.clinmesh.local', password }),
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      method: 'POST',
    })
    const doctorCookie = doctorSignIn.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    const doctorQueueResponse = await runtime.app.request('/api/his/v1/doctor/queue', {
      headers: { cookie: doctorCookie },
    })
    const doctorQueue = await doctorQueueResponse.json() as {
      items: Array<{ caseId: string; encounterVersion: string; status: string }>
    }
    const doctorCase = doctorQueue.items.find(candidate => candidate.caseId === item!.caseId)
    expect(doctorCase).toMatchObject({
      encounterVersion: triaged.data.encounterVersion,
      status: 'awaiting-doctor',
    })
    const doctorContext = await createContext(runtime, doctorCookie, {
      activeSection: 'record',
      selection: {
        id: item!.caseId,
        kind: 'case',
        version: triaged.data.encounterVersion,
      },
      ui: { status: 'ready' },
      version: 1,
      viewId: 'consultation',
      viewRevision: 'doctor-awaiting-visit-1',
    })
    expect(doctorContext.status).toBe(201)
    const doctor = agentPageContextBindingSchema.parse(await doctorContext.json())
    expect(doctor.snapshot.allowedOperationIds).toContain('outpatient.visit.start.propose')

    runtime.database.driver.prepare(`
      INSERT INTO laboratory_request (
        workspace_id, epoch, request_id, case_id, catalog_item_id, reference_json,
        indication_code, service_request_id, execution_task_id, diagnostic_report_id,
        status, version, authored_by, authored_at, reported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reported', 1, ?, ?, ?)
    `).run(
      'workspace-demo',
      'epoch-1',
      'laboratory-request-admin-correction',
      item!.caseId,
      'lab-crp',
      JSON.stringify({
        code: '1988-5',
        display: 'C 反应蛋白',
        id: 'lab-crp',
        sourceLocator: 'agent-context-test',
        system: 'http://loinc.org',
        version: '2.83',
      }),
      'fever',
      'service-request-admin-correction',
      'task-admin-correction',
      'diagnostic-report-admin-correction',
      'actor-outpatient-doctor',
      '2026-08-24T01:00:00.000Z',
      '2026-08-24T01:05:00.000Z',
    )
    const correctionClaim = {
      activeSection: 'laboratory',
      selection: {
        id: item!.caseId,
        kind: 'case' as const,
        version: triaged.data.encounterVersion,
      },
      ui: { status: 'ready' as const },
      version: 1 as const,
      viewId: 'consultation' as const,
      viewRevision: 'doctor-report-correction-capability',
    }
    const ordinaryCorrectionContext = await createContext(runtime, doctorCookie, correctionClaim)
    expect(ordinaryCorrectionContext.status).toBe(201)
    const ordinaryCorrection = agentPageContextBindingSchema.parse(
      await ordinaryCorrectionContext.json(),
    )
    expect(ordinaryCorrection.snapshot.allowedOperationIds)
      .not.toContain('outpatient.report.correct.propose')

    const administratorSignIn = await runtime.app.request('/api/auth/sign-in/email', {
      body: JSON.stringify({ email: 'admin@demo.clinmesh.local', password }),
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      method: 'POST',
    })
    const administratorCookie = administratorSignIn.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    const selectDoctorRole = await runtime.app.request('/api/auth/role', {
      body: JSON.stringify({ practitionerRoleId: 'practitioner-role-outpatient-doctor' }),
      headers: {
        'content-type': 'application/json',
        cookie: administratorCookie,
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(selectDoctorRole.status).toBe(200)
    const administratorCorrectionContext = await createContext(
      runtime,
      administratorCookie,
      { ...correctionClaim, viewRevision: 'administrator-report-correction-capability' },
    )
    expect(administratorCorrectionContext.status).toBe(201)
    const administratorCorrection = agentPageContextBindingSchema.parse(
      await administratorCorrectionContext.json(),
    )
    expect(administratorCorrection.snapshot.allowedOperationIds)
      .toContain('outpatient.report.correct.propose')
  })

  it('does not let an older browser revision revoke a newer Page Context', async () => {
    const { cookie, runtime } = await setup()
    const latestResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-latest',
      ui: { status: 'ready' },
    }, { clientId: 'ordered-surface-client', clientRevision: 2 })
    expect(latestResponse.status).toBe(201)
    const latest = agentPageContextBindingSchema.parse(await latestResponse.json())

    const lateResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-late',
      ui: { status: 'ready' },
    }, { clientId: 'ordered-surface-client', clientRevision: 1 })
    expect(lateResponse.status).toBe(409)
    expect(await lateResponse.json()).toMatchObject({ error: { code: 'AGENT_CONTEXT_SUPERSEDED' } })

    const authorized = await runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: latest.token,
        executionProof: executionProof({
          callId: 'call-after-late-context',
          contextId: latest.snapshot.id,
          dshSessionId: 'dsh-session-1',
          scopeKey: latest.snapshot.scopeKey,
          toolName: 'clinmesh_read_current_context',
        }),
        input: {},
        operationId: 'ui.context.read',
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(authorized.status).toBe(201)
  })

  it('keeps active Page Contexts isolated between Surface clients', async () => {
    const { cookie, runtime } = await setup()
    const claim = {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-multi-client',
      ui: { status: 'ready' },
    } satisfies AgentPageContextClaim
    const leaderResponse = await createContext(runtime, cookie, claim, {
      clientId: 'leader-surface-client',
      clientRevision: 1,
    })
    expect(leaderResponse.status).toBe(201)
    const leader = agentPageContextBindingSchema.parse(await leaderResponse.json())

    const contenderResponse = await createContext(runtime, cookie, claim, {
      clientId: 'contender-surface-client',
      clientRevision: 1,
    })
    expect(contenderResponse.status).toBe(201)

    const authorized = await runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: leader.token,
        executionProof: executionProof({
          callId: 'call-after-contender-context',
          contextId: leader.snapshot.id,
          dshSessionId: 'dsh-session-1',
          scopeKey: leader.snapshot.scopeKey,
          toolName: 'clinmesh_read_current_context',
        }),
        input: {},
        operationId: 'ui.context.read',
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })

    expect(authorized.status).toBe(201)
  })

  it('rejects an execution proof issued for a previous Page Context binding', async () => {
    const { cookie, runtime } = await setup()
    const firstResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-binding-1',
      ui: { status: 'ready' },
    })
    const first = agentPageContextBindingSchema.parse(await firstResponse.json())
    const proof = executionProof({
      callId: 'call-old-binding-1',
      contextId: first.snapshot.id,
      dshSessionId: 'dsh-session-1',
      scopeKey: first.snapshot.scopeKey,
      toolName: 'clinmesh_search_patients',
    })
    const secondResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-binding-2',
      ui: { status: 'ready' },
    })
    const second = agentPageContextBindingSchema.parse(await secondResponse.json())
    expect(second.snapshot.scopeKey).toBe(first.snapshot.scopeKey)

    const response = await runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: second.token,
        executionProof: proof,
        input: { query: '合成患者' },
        operationId: 'registration.patient.search',
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'AGENT_OPERATION_NOT_ALLOWED' } })
  })

  it('rejects a role/view mismatch and arbitrary hidden state', async () => {
    const { cookie, runtime } = await setup()
    const mismatch = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'consultation',
      viewRevision: 'forged',
      ui: { status: 'ready' },
    })
    expect(mismatch.status).toBe(403)
    expect(await mismatch.json()).toMatchObject({ error: { code: 'AGENT_VIEW_NOT_ALLOWED' } })

    const hidden = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'forged',
      ui: { status: 'ready' },
      hiddenFacts: [{ diagnosis: 'secret' }],
    })
    expect(hidden.status).toBe(400)
    expect(await hidden.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  })

  it('exposes only read-only Scenario authoring status to an administrator context', async () => {
    const { cookie, runtime } = await setup('admin@demo.clinmesh.local')
    const response = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'scenarioData',
      viewRevision: 'scenario-data-1',
      ui: { status: 'ready' },
    })
    const binding = agentPageContextBindingSchema.parse(await response.json())
    expect(binding.snapshot.allowedOperationIds).toEqual([
      'ui.context.read',
      'ui.navigate',
      'ui.panel.focus',
      'scenario.providers.read',
      'scenario.generation.status.read',
    ])
  })

  it('rejects bounded Tool input before reserving its DSH call id', async () => {
    const { cookie, runtime } = await setup()
    const contextResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-input-1',
      ui: { status: 'ready' },
    })
    const binding = agentPageContextBindingSchema.parse(await contextResponse.json())
    const proof = executionProof({
      callId: 'call-bounded-input-1',
      contextId: binding.snapshot.id,
      dshSessionId: 'dsh-session-1',
      scopeKey: binding.snapshot.scopeKey,
      toolName: 'clinmesh_search_patients',
    })
    const authorize = (query: string) => runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: binding.token,
        executionProof: proof,
        input: { query },
        operationId: 'registration.patient.search',
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })

    const invalid = await authorize('x'.repeat(101))
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
    expect((await authorize('合成患者')).status).toBe(201)
  })

  it('authorizes and completes one exact DSH Tool call while rejecting replay', async () => {
    const { cookie, runtime } = await setup()
    const contextResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-view-1',
      ui: { status: 'ready' },
    })
    const binding = agentPageContextBindingSchema.parse(await contextResponse.json())
    const proof = executionProof({
      callId: 'call-1',
      contextId: binding.snapshot.id,
      dshSessionId: 'dsh-session-1',
      scopeKey: binding.snapshot.scopeKey,
      toolName: 'clinmesh_search_patients',
    })
    const authorize = () => runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: binding.token,
        executionProof: proof,
        input: { query: '张' },
        operationId: 'registration.patient.search',
      }),
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost',
      },
      method: 'POST',
    })

    const response = await authorize()
    expect(response.status).toBe(201)
    const authorized = agentToolAuthorizationResponseSchema.parse(await response.json())
    expect(authorized).toMatchObject({
      callId: 'call-1',
      dshSessionId: 'dsh-session-1',
      operationId: 'registration.patient.search',
      status: 'authorized',
    })
    const replay = await authorize()
    expect(replay.status).toBe(409)
    expect(await replay.json()).toMatchObject({ error: { code: 'AGENT_CALL_REPLAYED' } })

    const replacement = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-view-2',
      ui: { status: 'empty' },
    })
    expect(replacement.status).toBe(201)

    const complete = () => runtime.app.request('/api/agent/v1/tool-calls/result', {
      body: JSON.stringify({
        ok: true,
        receiptToken: authorized.receiptToken,
        result: { count: 1 },
      }),
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect((await complete()).status).toBe(200)
    const duplicateResult = await complete()
    expect(duplicateResult.status).toBe(409)
    expect(await duplicateResult.json()).toMatchObject({ error: { code: 'AGENT_CALL_NOT_PENDING' } })
  })

  it('rejects a tampered proof and a Tool/operation mismatch', async () => {
    const { cookie, runtime } = await setup()
    const contextResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-view-1',
      ui: { status: 'ready' },
    })
    const binding = agentPageContextBindingSchema.parse(await contextResponse.json())
    const proof = executionProof({
      callId: 'call-2',
      contextId: binding.snapshot.id,
      dshSessionId: 'dsh-session-1',
      scopeKey: binding.snapshot.scopeKey,
      toolName: 'clinmesh_search_patients',
    })
    const request = (executionProof: string, operationId: string, input: unknown) => runtime.app.request(
      '/api/agent/v1/tool-calls',
      {
        body: JSON.stringify({ contextToken: binding.token, executionProof, input, operationId }),
        headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
        method: 'POST',
      },
    )

    const tampered = await request(`${proof}x`, 'registration.patient.search', { query: '张' })
    expect(tampered.status).toBe(401)
    expect(await tampered.json()).toMatchObject({ error: { code: 'AGENT_PROOF_INVALID' } })
    const mismatch = await request(proof, 'registration.patient.create.propose', {})
    expect(mismatch.status).toBe(403)
    expect(await mismatch.json()).toMatchObject({ error: { code: 'AGENT_OPERATION_NOT_ALLOWED' } })
  })

  it('rejects an expired Page Context before authorizing a Tool call', async () => {
    let now = new Date('2026-08-31T00:00:00.000Z')
    const { cookie, runtime } = await setup('registrar@demo.clinmesh.local', () => now)
    const contextResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-expiry-1',
      ui: { status: 'ready' },
    })
    const binding = agentPageContextBindingSchema.parse(await contextResponse.json())
    now = new Date('2026-08-31T00:05:00.000Z')

    const response = await runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: binding.token,
        executionProof: executionProof({
          callId: 'call-expired-1',
          contextId: binding.snapshot.id,
          dshSessionId: 'dsh-session-1',
          scopeKey: binding.snapshot.scopeKey,
          toolName: 'clinmesh_read_current_context',
        }),
        input: {},
        operationId: 'ui.context.read',
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'AGENT_CONTEXT_EXPIRED' } })
  })

  it('marks an undecided proposal stale when its receipt expires', async () => {
    let now = new Date('2026-08-31T00:00:00.000Z')
    const { cookie, runtime } = await setup('registrar@demo.clinmesh.local', () => now)
    const contextResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-expired-review-1',
      draft: { dirty: true, id: 'new-patient', kind: 'patient', revision: 'draft-1' },
      ui: { status: 'ready' },
    })
    const binding = agentPageContextBindingSchema.parse(await contextResponse.json())
    const authorize = await runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: binding.token,
        executionProof: executionProof({
          callId: 'call-expired-review-1',
          contextId: binding.snapshot.id,
          dshSessionId: 'dsh-session-1',
          scopeKey: binding.snapshot.scopeKey,
          toolName: 'clinmesh_prepare_create_patient',
        }, now),
        input: {},
        operationId: 'registration.patient.create.propose',
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    const authorized = agentToolAuthorizationResponseSchema.parse(await authorize.json())
    now = new Date('2026-08-31T00:05:00.000Z')

    const completion = await runtime.app.request('/api/agent/v1/tool-calls/result', {
      body: JSON.stringify({
        error: 'The ClinMesh Agent Page Context expired',
        ok: false,
        receiptToken: authorized.receiptToken,
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(completion.status).toBe(200)
    expect(runtime.database.driver.prepare(`
      SELECT status FROM agent_proposal
      WHERE workspace_id = ? AND epoch = ? AND proposal_id = ?
    `).get('workspace-demo', 'epoch-1', authorized.proposalId)).toEqual({ status: 'stale' })
  })

  it('rejects a Page Context from the previous Epoch after Scenario reset', async () => {
    const { cookie, password, runtime } = await setup()
    const contextResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-epoch-1',
      draft: { dirty: true, id: 'new-patient', kind: 'patient', revision: 'draft-1' },
      ui: { status: 'ready' },
    })
    const binding = agentPageContextBindingSchema.parse(await contextResponse.json())
    const proposalResponse = await runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: binding.token,
        executionProof: executionProof({
          callId: 'call-old-epoch-proposal-1',
          contextId: binding.snapshot.id,
          dshSessionId: 'dsh-session-1',
          scopeKey: binding.snapshot.scopeKey,
          toolName: 'clinmesh_prepare_create_patient',
        }),
        input: {},
        operationId: 'registration.patient.create.propose',
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    const proposal = agentToolAuthorizationResponseSchema.parse(await proposalResponse.json())
    const adminSignIn = await runtime.app.request('/api/auth/sign-in/email', {
      body: JSON.stringify({ email: 'admin@demo.clinmesh.local', password }),
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      method: 'POST',
    })
    const adminCookie = adminSignIn.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    const reset = await runtime.app.request(
      '/api/sim/v1/scenario-runs/scenario-run-1/actions/reset',
      {
        body: '{}',
        headers: {
          'content-type': 'application/json',
          cookie: adminCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(reset.status).toBe(200)

    const response = await runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: binding.token,
        executionProof: executionProof({
          callId: 'call-old-epoch-1',
          contextId: binding.snapshot.id,
          dshSessionId: 'dsh-session-1',
          scopeKey: binding.snapshot.scopeKey,
          toolName: 'clinmesh_read_current_context',
        }),
        input: {},
        operationId: 'ui.context.read',
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'AGENT_CONTEXT_INVALID' } })

    const completion = await runtime.app.request('/api/agent/v1/tool-calls/result', {
      body: JSON.stringify({
        error: 'The Scenario Epoch changed',
        ok: false,
        receiptToken: proposal.receiptToken,
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(completion.status).toBe(200)
    expect(runtime.database.driver.prepare(`
      SELECT status FROM agent_proposal
      WHERE workspace_id = ? AND epoch = ? AND proposal_id = ?
    `).get('workspace-demo', 'epoch-1', proposal.proposalId)).toEqual({ status: 'stale' })
  })

  it('marks a cancelled proposal stale without recording a human review decision', async () => {
    const { cookie, runtime } = await setup()
    const contextResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-cancelled-review-1',
      draft: {
        dirty: true,
        id: 'new-patient',
        kind: 'patient',
        revision: 'patient-draft-1',
      },
      ui: { status: 'ready' },
    })
    const binding = agentPageContextBindingSchema.parse(await contextResponse.json())
    const authorize = await runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: binding.token,
        executionProof: executionProof({
          callId: 'call-cancelled-proposal-1',
          contextId: binding.snapshot.id,
          dshSessionId: 'dsh-session-1',
          scopeKey: binding.snapshot.scopeKey,
          toolName: 'clinmesh_prepare_create_patient',
        }),
        input: {},
        operationId: 'registration.patient.create.propose',
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    const authorized = agentToolAuthorizationResponseSchema.parse(await authorize.json())
    const completed = await runtime.app.request('/api/agent/v1/tool-calls/result', {
      body: JSON.stringify({
        error: 'The Surface Agent page scope changed',
        ok: false,
        receiptToken: authorized.receiptToken,
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })

    expect(completed.status).toBe(200)
    expect(agentToolCompletionResponseSchema.parse(await completed.json())).toEqual({
      status: 'failed',
    })
    expect(runtime.database.driver.prepare(
      'SELECT status FROM agent_proposal WHERE proposal_id = ?',
    ).get(authorized.proposalId)).toEqual({ status: 'stale' })
    expect(runtime.database.driver.prepare(
      'SELECT COUNT(*) AS count FROM agent_review_decision WHERE proposal_id = ?',
    ).get(authorized.proposalId)).toEqual({ count: 0 })
  })

  it('links a human-approved proposal to its Command, Audit Event, and Action Trace', async () => {
    const { cookie, runtime } = await setup()
    const contextResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-review-1',
      draft: {
        dirty: true,
        id: 'new-patient',
        kind: 'patient',
        revision: 'patient-draft-1',
      },
      ui: { status: 'ready' },
    })
    const binding = agentPageContextBindingSchema.parse(await contextResponse.json())
    const authorize = await runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: binding.token,
        executionProof: executionProof({
          callId: 'call-proposal-1',
          contextId: binding.snapshot.id,
          dshSessionId: 'dsh-session-1',
          scopeKey: binding.snapshot.scopeKey,
          toolName: 'clinmesh_prepare_create_patient',
        }),
        input: {},
        operationId: 'registration.patient.create.propose',
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    const authorized = agentToolAuthorizationResponseSchema.parse(await authorize.json())
    expect(authorized.proposalId).toBeDefined()

    const decisionResponse = await runtime.app.request('/api/agent/v1/tool-calls/review', {
      body: JSON.stringify({ decision: 'approved', receiptToken: authorized.receiptToken }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(decisionResponse.status).toBe(200)
    expect(agentReviewDecisionResponseSchema.parse(await decisionResponse.json())).toMatchObject({
      decision: 'approved',
      proposalId: authorized.proposalId,
    })

    const commandResponse = await runtime.app.request('/api/his/v1/patients', {
      body: JSON.stringify({
        expectedVersions: {},
        input: {
          birthDate: '1990-01-01',
          gender: 'male',
          identifier: 'CM-AGENT-REVIEW-001',
          name: '合成患者复核',
        },
      }),
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(commandResponse.status).toBe(200)
    const command = await commandResponse.json() as {
      auditId: string
      requestId: string
    }

    const completedResponse = await runtime.app.request('/api/agent/v1/tool-calls/result', {
      body: JSON.stringify({
        ok: true,
        receiptToken: authorized.receiptToken,
        result: { approved: true, data: command },
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(completedResponse.status).toBe(200)
    expect(agentToolCompletionResponseSchema.parse(await completedResponse.json())).toEqual({
      auditId: command.auditId,
      proposalStatus: 'approved',
      requestId: command.requestId,
      status: 'completed',
      traceId: expect.any(String),
    })
  })

  it('does not begin review after the bound DSH Session is replaced', async () => {
    const { cookie, runtime } = await setup()
    const contextResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-session-1',
      draft: { dirty: true, id: 'new-patient', kind: 'patient', revision: 'draft-1' },
      ui: { status: 'ready' },
    }, { dshSessionId: 'dsh-session-1' })
    const binding = agentPageContextBindingSchema.parse(await contextResponse.json())
    const authorize = await runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: binding.token,
        executionProof: executionProof({
          callId: 'call-session-replaced-1',
          contextId: binding.snapshot.id,
          dshSessionId: 'dsh-session-1',
          scopeKey: binding.snapshot.scopeKey,
          toolName: 'clinmesh_prepare_create_patient',
        }),
        input: {},
        operationId: 'registration.patient.create.propose',
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    const authorized = agentToolAuthorizationResponseSchema.parse(await authorize.json())

    const replacement = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-session-2',
      draft: { dirty: true, id: 'new-patient', kind: 'patient', revision: 'draft-1' },
      ui: { status: 'ready' },
    }, { dshSessionId: 'dsh-session-2' })
    expect(replacement.status).toBe(201)

    const decision = await runtime.app.request('/api/agent/v1/tool-calls/review', {
      body: JSON.stringify({ decision: 'approved', receiptToken: authorized.receiptToken }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(decision.status).toBe(409)
    expect(await decision.json()).toMatchObject({ error: { code: 'AGENT_CALL_NOT_PENDING' } })
  })

  it('rejects an approved proposal linked with ids from two different Commands', async () => {
    const { cookie, runtime } = await setup()
    const contextResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-command-link-1',
      draft: { dirty: true, id: 'new-patient', kind: 'patient', revision: 'draft-1' },
      ui: { status: 'ready' },
    })
    const binding = agentPageContextBindingSchema.parse(await contextResponse.json())
    const authorize = await runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: binding.token,
        executionProof: executionProof({
          callId: 'call-command-link-1',
          contextId: binding.snapshot.id,
          dshSessionId: 'dsh-session-1',
          scopeKey: binding.snapshot.scopeKey,
          toolName: 'clinmesh_prepare_create_patient',
        }),
        input: {},
        operationId: 'registration.patient.create.propose',
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    const authorized = agentToolAuthorizationResponseSchema.parse(await authorize.json())
    const decision = await runtime.app.request('/api/agent/v1/tool-calls/review', {
      body: JSON.stringify({ decision: 'approved', receiptToken: authorized.receiptToken }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(decision.status).toBe(200)

    const createPatient = async (identifier: string) => {
      const response = await runtime.app.request('/api/his/v1/patients', {
        body: JSON.stringify({
          expectedVersions: {},
          input: { birthDate: '1990-01-01', gender: 'male', identifier, name: '合成关联患者' },
        }),
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      })
      expect(response.status).toBe(200)
      return await response.json() as { auditId: string; requestId: string }
    }
    const first = await createPatient('CM-AGENT-LINK-001')
    const second = await createPatient('CM-AGENT-LINK-002')

    const mixed = await runtime.app.request('/api/agent/v1/tool-calls/result', {
      body: JSON.stringify({
        ok: true,
        receiptToken: authorized.receiptToken,
        result: {
          approved: true,
          data: { auditId: first.auditId, requestId: second.requestId },
        },
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(mixed.status).toBe(403)
    expect(await mixed.json()).toMatchObject({ error: { code: 'AGENT_OPERATION_NOT_ALLOWED' } })

    runtime.database.driver.prepare(`
      UPDATE command_receipt SET practitioner_role_id = 'practitioner-role-administrator'
      WHERE audit_id = ? AND request_id = ?
    `).run(first.auditId, first.requestId)
    runtime.database.driver.prepare(`
      UPDATE audit_log SET practitioner_role_id = 'practitioner-role-administrator'
      WHERE audit_id = ?
    `).run(first.auditId)
    const wrongRole = await runtime.app.request('/api/agent/v1/tool-calls/result', {
      body: JSON.stringify({
        ok: true,
        receiptToken: authorized.receiptToken,
        result: { approved: true, data: first },
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(wrongRole.status).toBe(403)
    expect(await wrongRole.json()).toMatchObject({
      error: { code: 'AGENT_OPERATION_NOT_ALLOWED' },
    })

    const catalogResponse = await runtime.app.request('/api/his/v1/catalogs/registration', {
      headers: { cookie },
    })
    const catalog = await catalogResponse.json() as {
      departments: Array<{ id: string }>
      locations: Array<{ id: string }>
      virtualDate: string
      visitTypes: Array<{ id: string }>
    }
    const registrationResponse = await runtime.app.request('/api/his/v1/registrations/actions/register', {
      body: JSON.stringify({
        expectedVersions: { 'Patient/candidate-patient-001': '1' },
        input: {
          departmentId: catalog.departments[0]?.id,
          locationId: catalog.locations[0]?.id,
          patientId: 'candidate-patient-001',
          visitDate: catalog.virtualDate,
          visitTypeId: catalog.visitTypes[0]?.id,
        },
      }),
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(registrationResponse.status).toBe(200)
    const registration = await registrationResponse.json() as { auditId: string; requestId: string }
    const wrongOperation = await runtime.app.request('/api/agent/v1/tool-calls/result', {
      body: JSON.stringify({
        ok: true,
        receiptToken: authorized.receiptToken,
        result: { approved: true, data: registration },
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(wrongOperation.status).toBe(403)
    expect(await wrongOperation.json()).toMatchObject({
      error: { code: 'AGENT_OPERATION_NOT_ALLOWED' },
    })
  })
})

function executionProof(input: {
  callId: string
  contextId: string
  dshSessionId: string
  scopeKey: string
  toolName: string
}, now = new Date()): string {
  const payload = {
    ...input,
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    issuedAt: now.toISOString(),
    version: 1,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac(
    'sha256',
    'test-dsh-bridge-secret-with-at-least-32-characters',
  ).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}
