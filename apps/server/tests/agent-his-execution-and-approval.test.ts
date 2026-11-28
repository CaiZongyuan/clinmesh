import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai'
import { agentCapabilitiesManifestSchema } from '@clinmesh/contracts/agent-capabilities'
import {
  agentSessionDetailSchema,
  LLM_RUNTIME_HEADERS,
  resolveAgentDevReflectionResponseSchema,
} from '@clinmesh/contracts/agent-sessions'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { createClinMeshRuntime } from '../src/runtime.ts'
import type { CustomMockResponder } from '../src/infrastructure/agents/byok-provider-resolver.ts'
import type { JsonChatCompletionsProvider } from '../src/infrastructure/ai/openai-chat-completions.ts'
import {
  persona,
  signIn,
  startConsultationCase,
  StubSyntheaProvider,
} from './fixtures/consultation.ts'

const origin = 'http://localhost'
const runtimes: Array<Awaited<ReturnType<typeof createClinMeshRuntime>>> = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(r => r.close()))
  await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

const personaProvider: JsonChatCompletionsProvider = {
  async completeJson(input) {
    if (input.model === 'synthetic-consultation') {
      return { content: JSON.stringify({ reply: '一阵一阵的，站起来时头晕更明显。' }), model: 'synthetic-consultation' }
    }
    return { content: JSON.stringify(persona), model: 'synthetic-persona' }
  },
}

async function createRuntime(
  mockResponder: CustomMockResponder,
  extra?: { devReflectionDir?: string },
) {
  const dir = await mkdtemp(join(tmpdir(), 'clinmesh-agent-his-'))
  directories.push(dir)
  const runtime = await createClinMeshRuntime({
    authBaseUrl: origin,
    authSecret: 'test-auth-secret-with-at-least-32-characters',
    chatCompletionsProvider: personaProvider,
    consultationModel: 'synthetic-consultation',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
    databasePath: join(dir, 'clinmesh.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!',
    ...(extra?.devReflectionDir ? { devReflection: { enabled: true, outputDir: extra.devReflectionDir } } : {}),
    migrationMode: 'apply',
    mockResponder,
    mockTokensPerSecond: 10_000,
    outboxRetryDelayMs: 0,
    patientPersonaModel: 'synthetic-persona',
    syntheaProvider: new StubSyntheaProvider(),
    trustedOrigins: [origin],
  })
  runtimes.push(runtime)
  return runtime
}

async function startDoctorVisit(runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>) {
  const started = await startConsultationCase(runtime, 'Synthetic-Demo-Password-2026!', origin)
  const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local', 'Synthetic-Demo-Password-2026!', origin)
  const detailResp = await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}`, {
    headers: { cookie: doctorCookie },
  })
  const detail = doctorCaseDetailSchema.parse(await detailResp.json())
  const startResp = await runtime.app.request(
    `/api/his/v1/encounters/${detail.encounter.id}/actions/start-first-visit`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: doctorCookie,
        'idempotency-key': `start-${Date.now()}`,
        origin,
      },
      body: JSON.stringify({
        expectedVersions: {
          [`Encounter/${detail.encounter.id}`]: detail.encounter.versionId,
          [`Task/${detail.taskId}`]: detail.taskVersion,
        },
        input: {},
      }),
    },
  )
  expect(startResp.status).toBe(200)
  return { ...started, doctorCookie }
}

async function waitForCondition(
  runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
  cookie: string,
  sessionId: string,
  predicate: (detail: ReturnType<typeof agentSessionDetailSchema.parse>) => boolean,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await runtime.app.request(`/api/agents/sessions/${sessionId}`, {
      headers: { cookie },
    })
    const detail = agentSessionDetailSchema.parse(await res.json())
    if (predicate(detail)) return detail
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`Timed out waiting for agent session ${sessionId} condition`)
}

describe('Clinician Assistant executable HIS tools, HITL approval park gate, QuickJS codemode & UI Park Bridge', () => {
  it('autonomously drafts & previews clinical document, parks high-risk sign behind clinician approval (reject -> 0 writes, approve -> SQLite signed)', async () => {
    let step = 0
    let targetEncounterId = ''
    let savedEncounterVersion = '3'
    let capturedPreviewId = ''
    let capturedCommitToken = ''
    let rejectedObserved = false

    const runtime = await createRuntime((context) => {
      const lastToolResult = context.messages.findLast(m => m.role === 'toolResult')
      const lastToolText = lastToolResult?.role === 'toolResult'
        ? lastToolResult.content
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map(p => p.text)
            .join('\n')
        : ''

      step += 1
      if (step === 1) {
        return fauxAssistantMessage([
          fauxToolCall('macro_outpatient_write_preflight', {}),
        ], { stopReason: 'toolUse' })
      }
      if (step === 2) {
        const parsed = JSON.parse(lastToolText) as { case?: { encounter?: { versionId?: string } } }
        savedEncounterVersion = parsed.case?.encounter?.versionId ?? '3'
        return fauxAssistantMessage([
          fauxToolCall('tool_search', { query: 'encounter_clinical_document_draft_set sign preview sign' }),
        ], { stopReason: 'toolUse' })
      }
      if (step === 3) {
        return fauxAssistantMessage([
          fauxToolCall('encounter_clinical_document_draft_set', {
            encounterId: targetEncounterId,
            encounterVersion: savedEncounterVersion,
            expectedDraftVersion: 0,
            document: {
              chiefComplaint: '反复头晕一周',
              historyOfPresentIllness: '患者近一周起立时反复头晕、眼前发黑，休息后可缓解。',
              priorMedicalHistory: '既往高血压病史，规律服药。',
              allergyHistory: '否认已知药物过敏。',
              familyHistory: '否认特殊家族病史。',
              menstrualHistory: '已绝经。',
              obstetricHistory: '孕2产2。',
              physicalExamination: '神志清，BP 162/96 mmHg，P 82次/分，SpO2 98%。',
              auxiliaryExamination: '暂未见新发本院辅助检查报告。',
              assessment: '高血压伴头晕待查。',
              disposition: '门诊监测血压并随访。',
              followUp: '一周后复诊，症状加重随时急诊。',
            },
          }),
        ], { stopReason: 'toolUse' })
      }
      if (step === 4) {
        return fauxAssistantMessage([
          fauxToolCall('encounter_clinical_document_sign_preview', {
            encounterId: targetEncounterId,
            encounterVersion: savedEncounterVersion,
            expectedDraftVersion: 1,
          }),
        ], { stopReason: 'toolUse' })
      }
      if (step === 5) {
        const parsed = JSON.parse(lastToolText) as { data?: { previewId?: string; commitToken?: string } }
        capturedPreviewId = parsed.data?.previewId ?? ''
        capturedCommitToken = parsed.data?.commitToken ?? ''
        // First sign attempt -> clinician will REJECT
        return fauxAssistantMessage([
          fauxToolCall('encounter_clinical_document_sign', {
            encounterId: targetEncounterId,
            encounterVersion: savedEncounterVersion,
            previewId: capturedPreviewId,
            commitToken: capturedCommitToken,
          }),
        ], { stopReason: 'toolUse' })
      }
      if (step === 6) {
        if (lastToolText.includes('DOCTOR_REJECTED') || lastToolText.includes('拒绝')) {
          rejectedObserved = true
        }
        // Second sign attempt -> clinician will APPROVE
        return fauxAssistantMessage([
          fauxToolCall('encounter_clinical_document_sign', {
            encounterId: targetEncounterId,
            encounterVersion: savedEncounterVersion,
            previewId: capturedPreviewId,
            commitToken: capturedCommitToken,
          }),
        ], { stopReason: 'toolUse' })
      }
      return fauxAssistantMessage([
        fauxText(`病历已按医生确认正式签署完成。`),
      ])
    })

    const { doctorCookie, outpatientCaseId, encounterId } = await startDoctorVisit(runtime)
    targetEncounterId = encounterId

    // Create clinician assistant session bound to the outpatient encounter
    const createResp = await runtime.app.request('/api/agents/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin },
      body: JSON.stringify({ caseId: outpatientCaseId, encounterId }),
    })
    expect(createResp.status).toBe(201)
    const created = agentSessionDetailSchema.parse(await createResp.json())
    const sessionId = created.session.sessionId

    // Send user prompt in mock mode
    const sendResp = await runtime.app.request(`/api/agents/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: doctorCookie,
        origin,
        [LLM_RUNTIME_HEADERS.mode]: 'mock',
      },
      body: JSON.stringify({ content: '帮我自动写好结构化病历草稿并发起签署确认' }),
    })
    expect(sendResp.status).toBe(202)

    // Wait until parked on the first high-risk sign approval card!
    const parked1 = await waitForCondition(
      runtime,
      doctorCookie,
      sessionId,
      d => (d.pendingApprovals?.length ?? 0) === 1,
    )
    expect(parked1.pendingApprovals![0]!.operationId).toBe('encounter.clinical-document.sign')
    expect(parked1.mutationVersion).toBeGreaterThanOrEqual(2) // draft + preview already ran autonomously!

    // Verify SQLite: draft IS persisted, signed is still 0 while parked!
    const midDetail = doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${outpatientCaseId}`,
      { headers: { cookie: doctorCookie } },
    )).json())
    expect(midDetail.clinicalDocument?.draft?.chiefComplaint).toBe('反复头晕一周')
    expect(midDetail.clinicalDocument?.signed.length ?? 0).toBe(0)

    // 1) REJECT first approval -> verify 0 signed docs in SQLite!
    const rejectResp = await runtime.app.request(
      `/api/agents/sessions/${sessionId}/approvals/${parked1.pendingApprovals![0]!.approvalId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: doctorCookie, origin },
        body: JSON.stringify({ approved: false, reason: '需先复核体征' }),
      },
    )
    expect(rejectResp.status).toBe(200)

    // Wait for second sign attempt to park
    const parked2 = await waitForCondition(
      runtime,
      doctorCookie,
      sessionId,
      d => (d.pendingApprovals?.length ?? 0) === 1 && d.pendingApprovals![0]!.approvalId !== parked1.pendingApprovals![0]!.approvalId,
    )
    expect(rejectedObserved).toBe(true)

    const afterRejectDetail = doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${outpatientCaseId}`,
      { headers: { cookie: doctorCookie } },
    )).json())
    expect(afterRejectDetail.clinicalDocument?.signed.length ?? 0).toBe(0)

    // 2) APPROVE second approval -> verify real signed clinical document commits to SQLite!
    const approveResp = await runtime.app.request(
      `/api/agents/sessions/${sessionId}/approvals/${parked2.pendingApprovals![0]!.approvalId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: doctorCookie, origin },
        body: JSON.stringify({ approved: true }),
      },
    )
    expect(approveResp.status).toBe(200)

    const settled = await waitForCondition(
      runtime,
      doctorCookie,
      sessionId,
      d => d.session.status !== 'running',
    )
    expect(settled.pendingApprovals).toEqual([])
    expect(settled.session.status).toBe('idle')

    const finalDetail = doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${outpatientCaseId}`,
      { headers: { cookie: doctorCookie } },
    )).json())
    expect(finalDetail.clinicalDocument?.signed.length).toBe(1)
    expect(finalDetail.clinicalDocument?.signed[0]?.content.chiefComplaint).toBe('反复头晕一周')
  })

  it('executes parallel HIS reads inside QuickJS codemode while physically excluding high-risk commits from sandbox', async () => {
    let step = 0
    let targetCaseId = ''
    let codemodeOutput = ''
    const runtime = await createRuntime((context) => {
      step += 1
      if (step === 1) {
        return fauxAssistantMessage([
          fauxToolCall('codemode', {
            code: `
              const [c, cat] = await Promise.all([
                tools.doctor_case_get({ caseId: ${JSON.stringify(targetCaseId)} }),
                tools.catalog_clinical_read({}),
              ]);
              return {
                patient: c.patient?.name,
                diagCount: cat.diagnoses?.length ?? 0,
                highRiskSignExposedInSandbox: 'encounter_clinical_document_sign' in tools,
                highRiskCompleteExposedInSandbox: 'encounter_complete' in tools,
              };
            `,
          }),
        ], { stopReason: 'toolUse' })
      }
      const tr = context.messages.findLast(m => m.role === 'toolResult')
      codemodeOutput = tr?.role === 'toolResult'
        ? tr.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map(p => p.text).join('\n')
        : ''
      return fauxAssistantMessage([fauxText('QuickJS 沙箱并行读取验证完成。')])
    })

    const { doctorCookie, outpatientCaseId, encounterId } = await startDoctorVisit(runtime)
    targetCaseId = outpatientCaseId
    const created = agentSessionDetailSchema.parse(await (await runtime.app.request('/api/agents/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin },
      body: JSON.stringify({ caseId: outpatientCaseId, encounterId }),
    })).json())

    await runtime.app.request(`/api/agents/sessions/${created.session.sessionId}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: doctorCookie,
        origin,
        [LLM_RUNTIME_HEADERS.mode]: 'mock',
      },
      body: JSON.stringify({ content: '用 codemode 并行查病例和目录' }),
    })

    await waitForCondition(runtime, doctorCookie, created.session.sessionId, d => d.session.status !== 'running')
    expect(codemodeOutput).toContain('张琴')
    expect(codemodeOutput).toContain('"highRiskSignExposedInSandbox":false')
    expect(codemodeOutput).toContain('"highRiskCompleteExposedInSandbox":false')
  })

  it('parks frontend UI-SDK bridge request and resumes immediately when browser posts ui-bridge result', async () => {
    let step = 0
    let bridgeToolOutput = ''
    const runtime = await createRuntime((context) => {
      step += 1
      if (step === 1) {
        return fauxAssistantMessage([
          fauxToolCall('ui_stage_form_draft', {
            changes: [
              { ref: '主诉', value: '尝试覆写手改主诉' },
              { ref: '现病史', value: '近一周反复头晕。' },
            ],
          }),
        ], { stopReason: 'toolUse' })
      }
      const tr = context.messages.findLast(m => m.role === 'toolResult')
      bridgeToolOutput = tr?.role === 'toolResult'
        ? tr.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map(p => p.text).join('\n')
        : ''
      return fauxAssistantMessage([fauxText('已完成前端表单草稿预填，并保留了医生手改主诉。')])
    })

    const { doctorCookie, outpatientCaseId, encounterId } = await startDoctorVisit(runtime)
    const created = agentSessionDetailSchema.parse(await (await runtime.app.request('/api/agents/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin },
      body: JSON.stringify({ caseId: outpatientCaseId, encounterId }),
    })).json())
    const sessionId = created.session.sessionId

    await runtime.app.request(`/api/agents/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: doctorCookie,
        origin,
        [LLM_RUNTIME_HEADERS.mode]: 'mock',
      },
      body: JSON.stringify({ content: '帮我把现病史填进当前表单' }),
    })

    const parked = await waitForCondition(
      runtime,
      doctorCookie,
      sessionId,
      d => (d.pendingUiRequests?.length ?? 0) === 1,
    )
    const uiReq = parked.pendingUiRequests![0]!
    expect(uiReq.action).toBe('stage')

    const bridgeResp = await runtime.app.request(`/api/agents/sessions/${sessionId}/ui-bridge/${uiReq.requestId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin },
      body: JSON.stringify({
        ok: true,
        resultJson: JSON.stringify({
          appliedCount: 1,
          appliedRefs: ['现病史'],
          skippedHumanEdited: [{ ref: '主诉', label: '主诉', preservedValue: '医生手改主诉' }],
        }),
      }),
    })
    expect(bridgeResp.status).toBe(200)
    expect(await bridgeResp.json()).toEqual({ delivered: true })

    const settled = await waitForCondition(runtime, doctorCookie, sessionId, d => d.session.status !== 'running')
    expect(settled.pendingUiRequests).toEqual([])
    expect(bridgeToolOutput).toContain('skippedHumanEdited')
    expect(bridgeToolOutput).toContain('医生手改主诉')
  })

  it('serves blacklist-default-allow capabilities manifest and executes ui_navigate_workspace without confirmation block', async () => {
    let step = 0
    let navOutput = ''
    let capsOutput = ''
    const runtime = await createRuntime((context) => {
      step += 1
      if (step === 1) {
        return fauxAssistantMessage([
          fauxToolCall('list_agent_capabilities', {}),
          fauxToolCall('ui_navigate_workspace', { target: '病历栏' }),
        ], { stopReason: 'toolUse' })
      }
      const results = context.messages.filter(m => m.role === 'toolResult')
      for (const r of results) {
        const text = r.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map(p => p.text).join('\n')
        if (r.toolName === 'list_agent_capabilities') capsOutput = text
        if (r.toolName === 'ui_navigate_workspace') navOutput = text
      }
      return fauxAssistantMessage([fauxText('已切换到病历记录栏。')])
    })

    const { doctorCookie, outpatientCaseId, encounterId } = await startDoctorVisit(runtime)

    // 1. Verify GET /api/agents/capabilities endpoint
    const capResp = await runtime.app.request('/api/agents/capabilities', {
      headers: { cookie: doctorCookie },
    })
    expect(capResp.status).toBe(200)
    const manifest = agentCapabilitiesManifestSchema.parse(await capResp.json())
    expect(manifest.policyMode).toBe('blacklist-default-allow')
    expect(manifest.roleCode).toBe('outpatient-doctor')
    expect(manifest.counts.defaultAllowedOperations).toBeGreaterThan(30)
    expect(manifest.counts.confirmationGatedOperations).toBeGreaterThan(5)
    expect(manifest.events.some(e => e.category === 'navigate' && e.permission === 'allow')).toBe(true)
    expect(manifest.blacklist.some(b => b.pattern === 'auth.*')).toBe(true)

    // 2. Verify list_agent_capabilities + ui_navigate_workspace park bridge round-trip
    const created = agentSessionDetailSchema.parse(await (await runtime.app.request('/api/agents/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin },
      body: JSON.stringify({ caseId: outpatientCaseId, encounterId }),
    })).json())
    const sessionId = created.session.sessionId

    await runtime.app.request(`/api/agents/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: doctorCookie,
        origin,
        [LLM_RUNTIME_HEADERS.mode]: 'mock',
      },
      body: JSON.stringify({ content: '帮我从患者对话栏切换到病历栏' }),
    })

    const parked = await waitForCondition(
      runtime,
      doctorCookie,
      sessionId,
      d => (d.pendingUiRequests?.length ?? 0) === 1,
    )
    expect(parked.pendingApprovals).toEqual([])
    const navReq = parked.pendingUiRequests![0]!
    expect(navReq.action).toBe('navigate')
    expect(JSON.parse(navReq.payloadJson)).toEqual({ target: '病历栏' })

    const bridgeResp = await runtime.app.request(`/api/agents/sessions/${sessionId}/ui-bridge/${navReq.requestId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin },
      body: JSON.stringify({
        ok: true,
        resultJson: JSON.stringify({ ok: true, matchedLabel: '病历记录', matchedValue: 'record', previousValue: 'consultation' }),
      }),
    })
    expect(bridgeResp.status).toBe(200)

    const settled = await waitForCondition(runtime, doctorCookie, sessionId, d => d.session.status !== 'running')
    expect(settled.pendingUiRequests).toEqual([])
    expect(capsOutput).toContain('"policyMode":"blacklist-default-allow"')
    expect(navOutput).toContain('"matchedValue":"record"')
  })

  it('exposes consultation.version in doctor_case_get, sends consultation in 1 call via macro_consultation_ask, and batches multiple clinical commits into 1 readable approval card', async () => {
    let step = 0
    let targetCaseId = ''
    let targetEncounterId = ''
    let caseSnapshotText = ''
    let consultReplyText = ''
    let batchReceiptText = ''

    const runtime = await createRuntime((context) => {
      step += 1
      const lastTool = context.messages.findLast(m => m.role === 'toolResult')
      const lastToolText = lastTool?.role === 'toolResult'
        ? lastTool.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map(p => p.text).join('\n')
        : ''

      if (step === 1) {
        return fauxAssistantMessage([
          fauxToolCall('codemode', {
            code: `
              const c = await tools.doctor_case_get({ caseId: ${JSON.stringify(targetCaseId)} });
              const cat = await tools.catalog_clinical_read({});
              return {
                consultationVersion: c.consultation?.version,
                labDraftVersion: c.laboratoryDraftVersion,
                encounterVersion: c.encounter?.versionId,
                firstDiag: cat.diagnoses?.[0],
              };
            `,
          }),
        ], { stopReason: 'toolUse' })
      }
      if (step === 2) {
        caseSnapshotText = lastToolText
        return fauxAssistantMessage([
          fauxToolCall('macro_consultation_ask', {
            message: '请问这种头晕是一阵一阵的，还是持续性的？',
          }),
        ], { stopReason: 'toolUse' })
      }
      if (step === 3) {
        consultReplyText = lastToolText
        // Save clinical doc + diagnosis drafts inside codemode, then batch-confirm everything in ONE approval card!
        return fauxAssistantMessage([
          fauxToolCall('codemode', {
            code: `
              const fresh = await tools.doctor_case_get({ caseId: ${JSON.stringify(targetCaseId)} });
              const cat = await tools.catalog_clinical_read({});
              await tools.encounter_clinical_document_draft_set({
                encounterId: ${JSON.stringify(targetEncounterId)},
                encounterVersion: fresh.encounter.versionId,
                expectedDraftVersion: 0,
                document: {
                  chiefComplaint: '反复头晕一周',
                  historyOfPresentIllness: '患者近一周反复头晕，无意识障碍。',
                  priorMedicalHistory: '既往高血压病史5年。',
                  allergyHistory: '否认药物过敏史。',
                  familyHistory: '否认特殊家族病史。',
                  menstrualHistory: '已绝经。',
                  obstetricHistory: '孕2产2。',
                  physicalExamination: '神志清，生命体征平稳。',
                  auxiliaryExamination: '待完善心电图检查。',
                  assessment: '高血压伴头晕。',
                  disposition: '完善检查并监测血压。',
                  followUp: '一周后复诊。',
                },
              });
              const diag = cat.diagnoses[0];
              await tools.encounter_diagnosis_draft_set({
                encounterId: ${JSON.stringify(targetEncounterId)},
                encounterVersion: fresh.encounter.versionId,
                expectedDraftVersion: fresh.diagnosis?.draftVersion ?? 0,
                entries: [{ catalogItemId: diag.id, role: 'primary' }],
              });
              const exams = await tools.doctor_case_examination_services_list({ caseId: ${JSON.stringify(targetCaseId)} });
              return { exam: exams.items?.[0] ?? null };
            `,
          }),
        ], { stopReason: 'toolUse' })
      }
      if (step === 4) {
        const examMatch = lastToolText.match(/"id":"([^"]+)"/)
        const examServiceId = examMatch?.[1] ?? 'examination-ecg-12-lead'
        return fauxAssistantMessage([
          fauxToolCall('batch_confirm_clinical_orders', {
            title: '批量确认签署病历、诊断与心电图（共 3 项）',
            signClinicalDocument: true,
            confirmDiagnosis: true,
            examinationRequests: [
              { serviceId: examServiceId, serviceName: '常规十二导联心电图', indication: '头晕待查评估心律' },
            ],
          }),
        ], { stopReason: 'toolUse' })
      }
      batchReceiptText = lastToolText
      return fauxAssistantMessage([fauxText('已一次性完成病历签署、诊断确认与检查开立。')])
    })

    const { doctorCookie, outpatientCaseId, encounterId } = await startDoctorVisit(runtime)
    targetCaseId = outpatientCaseId
    targetEncounterId = encounterId

    const created = agentSessionDetailSchema.parse(await (await runtime.app.request('/api/agents/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin },
      body: JSON.stringify({ caseId: outpatientCaseId, encounterId }),
    })).json())
    const sessionId = created.session.sessionId

    await runtime.app.request(`/api/agents/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: doctorCookie,
        origin,
        [LLM_RUNTIME_HEADERS.mode]: 'mock',
      },
      body: JSON.stringify({ content: '你来问诊并一次性准备好病历、诊断和心电图让我一次确认' }),
    })

    // Expect ONE single parked batch approval card with human-readable details!
    const parked = await waitForCondition(
      runtime,
      doctorCookie,
      sessionId,
      d => (d.pendingApprovals?.length ?? 0) === 1,
    )
    const card = parked.pendingApprovals![0]!
    expect(card.operationId).toBe('batch.clinical-orders.confirm')
    expect(card.title).toContain('共 3 项')
    expect(card.details?.length).toBe(3)
    expect(card.details?.some(d => d.badge === '病历' && d.value.includes('反复头晕一周'))).toBe(true)
    expect(card.details?.some(d => d.badge === '诊断')).toBe(true)
    expect(card.details?.some(d => d.badge === '功能检查' && d.label === '常规十二导联心电图')).toBe(true)

    // Approve ONCE -> verify ALL 3 commits succeed cleanly in SQLite!
    const approveResp = await runtime.app.request(`/api/agents/sessions/${sessionId}/approvals/${card.approvalId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin },
      body: JSON.stringify({ approved: true }),
    })
    expect(approveResp.status).toBe(200)

    const settled = await waitForCondition(runtime, doctorCookie, sessionId, d => d.session.status !== 'running')
    expect(settled.pendingApprovals).toEqual([])
    expect(caseSnapshotText).toContain('"consultationVersion":')
    expect(caseSnapshotText).toContain('"labDraftVersion":0')
    expect(consultReplyText).toContain('"ok":true')
    expect(batchReceiptText).toContain('"succeededCount":3')
    expect(batchReceiptText).toContain('"failedCount":0')

    const finalDetail = doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${outpatientCaseId}`,
      { headers: { cookie: doctorCookie } },
    )).json())
    expect(finalDetail.clinicalDocument?.signed.length).toBe(1)
    expect(finalDetail.diagnosis?.confirmation).toBeTruthy()
    expect(finalDetail.examinationRequests?.requests.length).toBe(1)
  })

  it('triggers dev watchdog after repeated tool failures, creates a redacted dev_reflect_friction card, and persists to dev dir only on explicit developer confirmation', async () => {
    const reflectionDir = await mkdtemp(join(tmpdir(), 'clinmesh-dev-refl-'))
    directories.push(reflectionDir)

    let step = 0
    let watchdogObserved = ''
    const runtime = await createRuntime((context) => {
      step += 1
      const lastTool = context.messages.findLast(m => m.role === 'toolResult')
      const lastText = lastTool?.role === 'toolResult'
        ? lastTool.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map(p => p.text).join('\n')
        : ''

      if (step === 1) {
        return fauxAssistantMessage([
          fauxToolCall('codemode', {
            code: `
              const errs = [];
              for (let i = 0; i < 3; i++) {
                try {
                  await tools.doctor_case_get({ caseId: 'missing-case-id-' + i });
                } catch (e) {
                  errs.push(String(e));
                }
              }
              return errs;
            `,
          }),
        ], { stopReason: 'toolUse' })
      }
      if (step === 2) {
        watchdogObserved = lastText
        return fauxAssistantMessage([
          fauxToolCall('dev_reflect_friction', {
            category: 'missing-field',
            title: '病例查询反复 404 导致连续失败',
            symptom: '连续 3 次调用 doctor_case_get 触发 404（测试脱敏 sk-live1234567890abcdef）。',
            rootCause: '未校验当前会话绑定的 caseId 是否有效就直接发起循环查询。',
            suggestedFix: '在工具描述中强提示默认省略 caseId 以继承会话绑定，避免模型虚构 ID。',
            affectedTools: ['doctor_case_get'],
          }),
        ], { stopReason: 'toolUse' })
      }
      return fauxAssistantMessage([fauxText('检测到连续失败并已生成开发反思卡片，请确认是否记录到开发目录。')])
    }, { devReflectionDir: reflectionDir })

    const { doctorCookie, outpatientCaseId, encounterId } = await startDoctorVisit(runtime)
    const created = agentSessionDetailSchema.parse(await (await runtime.app.request('/api/agents/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin },
      body: JSON.stringify({ caseId: outpatientCaseId, encounterId }),
    })).json())
    const sessionId = created.session.sessionId

    await runtime.app.request(`/api/agents/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: doctorCookie,
        origin,
        [LLM_RUNTIME_HEADERS.mode]: 'mock',
      },
      body: JSON.stringify({ content: '测试开发模式反思熔断机制' }),
    })

    const settled = await waitForCondition(runtime, doctorCookie, sessionId, d => d.session.status !== 'running')
    expect(watchdogObserved).toContain('[DEV-WATCHDOG]')
    expect(settled.devReflections?.length).toBe(1)

    const refl = settled.devReflections![0]!
    expect(refl.status).toBe('pending')
    expect(refl.category).toBe('missing-field')
    expect(refl.telemetry.turnErrors).toBeGreaterThanOrEqual(3)
    expect(refl.symptom).not.toContain('sk-live1234567890abcdef')
    expect(refl.symptom).toContain('[REDACTED_CREDENTIAL]')

    // Before developer clicks Save, nothing is written to reflectionDir!
    expect(await readdir(reflectionDir)).toEqual([])

    // Developer explicitly confirms Save -> writes Markdown + index.jsonl
    const saveResp = await runtime.app.request(`/api/agents/sessions/${sessionId}/dev-reflections/${refl.reflectionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin },
      body: JSON.stringify({ action: 'save' }),
    })
    expect(saveResp.status).toBe(200)
    const savedPayload = resolveAgentDevReflectionResponseSchema.parse(await saveResp.json())
    expect(savedPayload.reflection.status).toBe('saved')
    expect(savedPayload.savedPath).toBeTruthy()

    const files = await readdir(reflectionDir)
    const mdFile = files.find(f => f.endsWith('.md'))
    expect(mdFile).toBeTruthy()
    expect(files).toContain('index.jsonl')
    const mdText = await readFile(join(reflectionDir, mdFile!), 'utf8')
    expect(mdText).toContain('病例查询反复 404 导致连续失败')
    expect(mdText).not.toContain('sk-live1234567890abcdef')

    // Developer dismisses -> card disappears cleanly
    const dismissResp = await runtime.app.request(`/api/agents/sessions/${sessionId}/dev-reflections/${refl.reflectionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin },
      body: JSON.stringify({ action: 'dismiss' }),
    })
    expect(dismissResp.status).toBe(200)
    const dismissedPayload = resolveAgentDevReflectionResponseSchema.parse(await dismissResp.json())
    expect(dismissedPayload.detail.devReflections).toEqual([])
  })
})
