import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agentPageContextBindingSchema, doctorRecordingSourceResponseSchema } from '@clinmesh/contracts/agent'
import { createPatientResponseSchema, doctorCaseDetailSchema, doctorQueueSchema, registrationResponseSchema,
  startVisitResponseSchema, triageResponseSchema } from '@clinmesh/contracts/his'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'
import type { JsonChatCompletionsProvider } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { z } from 'zod'

const secret = 'synthetic-doctor-recording-secret-at-least-32-characters'
const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })
const headers = (cookie: string) => ({ cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() })
function changeSignedSource(sourceProof: string, overrides: Record<string, unknown>) {
  const payload = JSON.parse(Buffer.from(sourceProof.split('.')[0]!, 'base64url').toString())
  const encoded = Buffer.from(JSON.stringify({ ...payload, ...overrides })).toString('base64url')
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`
}

async function fixture(provider?: JsonChatCompletionsProvider) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-doctor-source-'))
  disposals.push(() => rm(directory, { recursive: true }))
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters', databasePath: join(directory, 'clinmesh.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply', trustedOrigins: ['http://localhost'],
    dshBridgeSecret: secret,
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret, timeoutMs: 2000, maxResponseBytes: 8192 },
    ...(provider === undefined ? {} : { chatCompletionsProvider: provider, syntheaProvider: new StubSyntheaProvider(),
      consultationModel: 'synthetic', patientPersonaModel: 'synthetic', investigationModel: 'synthetic' }),
  })
  disposals.push(() => runtime.close())
  const registrar = await signIn(runtime, 'registrar@demo.clinmesh.local')
  const patient = createPatientResponseSchema.parse(await (await runtime.app.request('/api/his/v1/patients', {
    method: 'POST', headers: headers(registrar), body: JSON.stringify({ expectedVersions: {}, input: {
      birthDate: '1990-05-10', gender: 'male', identifier: `CM-SYN-${randomUUID()}`, name: '合成医生补充患者',
    } }),
  })).json()).data.patient
  const registration = registrationResponseSchema.parse(await (await runtime.app.request('/api/his/v1/registrations/actions/register', {
    method: 'POST', headers: headers(registrar), body: JSON.stringify({ expectedVersions: { [`Patient/${patient.id}`]: patient.versionId }, input: {
      departmentId: 'department-general-medicine', locationId: 'location-outpatient', patientId: patient.id, visitDate: '2026-08-24', visitTypeId: 'visit-general',
    } }),
  })).json()).data
  const nurse = await signIn(runtime, 'triage@demo.clinmesh.local')
  const triage = triageResponseSchema.parse(await (await runtime.app.request(`/api/his/v1/encounters/${registration.encounterId}/actions/record-triage`, {
    method: 'POST', headers: headers(nurse), body: JSON.stringify({ expectedVersions: {
      [`Encounter/${registration.encounterId}`]: '1', [`Task/${registration.queueTaskId}`]: '1',
    }, input: { acuityCode: 'level-3', bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 }, chiefComplaint: '发热伴咽痛两天',
      oxygenSaturationPct: 98, pulseBpm: 102, respirationBpm: 20, temperatureC: 38.6 } }),
  })).json()).data
  const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const visit = startVisitResponseSchema.parse(await (await runtime.app.request(`/api/his/v1/encounters/${registration.encounterId}/actions/start-first-visit`, {
    method: 'POST', headers: headers(doctor), body: JSON.stringify({ expectedVersions: {
      [`Encounter/${registration.encounterId}`]: '2', [`Task/${triage.doctorTaskId}`]: '1',
    }, input: {} }),
  })).json()).data
  const queue = doctorQueueSchema.parse(await (await runtime.app.request('/api/his/v1/doctor/queue', { headers: { cookie: doctor } })).json())
  const caseId = queue.items.find(item => item.encounterId === registration.encounterId)!.caseId
  const claim = { taskEpoch: randomUUID(), activeSection: 'record', version: 1, viewId: 'consultation',
    viewRevision: 'doctor-source-original', ui: { status: 'ready' }, selection: { kind: 'case', id: caseId, version: visit.encounterVersion } }
  let revision = 0
  const context = async (overrides: Record<string, unknown> = {}) => agentPageContextBindingSchema.parse(await (await runtime.app.request('/api/agent/v1/page-contexts', {
    method: 'POST', headers: headers(doctor), body: JSON.stringify({ claim: { ...claim, ...overrides },
      client: { id: 'doctor-source-client', revision: ++revision }, dshSessionId: 'doctor-source-session' }),
  })).json())
  const read = async () => doctorCaseDetailSchema.parse(await (await runtime.app.request(`/api/his/v1/doctor/cases/${caseId}`, { headers: { cookie: doctor } })).json())
  const source = async (binding: Awaited<ReturnType<typeof context>>, content = '查体：双肺呼吸音清，无啰音。', rpcId = 'doctor-source-rpc') => {
    const response = await runtime.app.request('/api/agent/v1/doctor-tasks/permit', { method: 'POST', headers: headers(doctor),
      body: JSON.stringify({ contextToken: binding.token, content, rpcId }) })
    expect(response.status).toBe(201)
    const { permit } = await response.json() as { permit: string }
    const encodedPermit = permit.split('.')[0]!
    const payload = { ...JSON.parse(Buffer.from(encodedPermit, 'base64url').toString()),
      purpose: 'clinmesh-doctor-recording-source', version: 1, messageId: 'native-doctor-message', recordedAt: new Date().toISOString() }
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return { content, sourceProof: `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}` }
  }
  const record = (binding: Awaited<ReturnType<typeof context>>, input: Awaited<ReturnType<typeof source>>, cookie = doctor) => runtime.app.request('/api/agent/v1/doctor-inputs', {
    method: 'POST', headers: headers(cookie), body: JSON.stringify({ ...input, contextToken: binding.token }),
  })
  return { runtime, doctor, registrar, caseId, encounterId: registration.encounterId, visit, context, read, source, record }
}

it('records a proven doctor supplement without a Tool and reads it through the case Query', async () => {
  const f = await fixture()
  const binding = await f.context()
  const input = await f.source(binding)
  const response = await f.record(binding, input)
  expect(response.status).toBe(200)
  const receipt = doctorRecordingSourceResponseSchema.parse(await response.json())
  expect(receipt.data.caseId).toBe(f.caseId)
  const detail = await f.read()
  expect(detail.consultation).toBeUndefined()
  expect(detail.consultationRecording?.sources).toEqual([expect.objectContaining({
    id: receipt.data.sourceId, kind: 'doctor', messageText: input.content,
    sessionId: 'doctor-source-session', messageId: 'native-doctor-message', rpcId: 'doctor-source-rpc',
  })])
  expect(detail.consultationRecording?.remainingCount).toBe(1)
  expect((await f.record(binding, input)).status).toBe(200)
  expect((await f.read()).consultationRecording?.sources).toHaveLength(1)
  const freshPermit = await f.source(binding)
  await f.record(binding, freshPermit)
  expect((await f.read()).consultationRecording?.sources).toHaveLength(1)
  expect((await f.read()).consultationRecording?.remainingCount).toBe(1)
})

it('automatically records four doctor fields without changing the patient consultation', async () => {
  const fields = [
    { field: 'physicalExamination', text: '双肺呼吸音清，无啰音', quote: '查体：双肺呼吸音清，无啰音。' },
    { field: 'assessment', text: '倾向上呼吸道感染', quote: '评估：倾向上呼吸道感染。' },
    { field: 'disposition', text: '先对症处理', quote: '处置：先对症处理。' },
    { field: 'followUp', text: '症状加重及时复诊', quote: '随访：症状加重及时复诊。' },
  ]
  const provider: JsonChatCompletionsProvider = {
    async completeJson(input) {
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
      if (input.schemaName === 'consultation_history_verification') {
        const { additions } = z.object({ additions: z.array(z.unknown()) }).parse(input.userPayload)
        return { content: JSON.stringify({ additions: additions.map((_, index) => ({ index, faithful: true, complete: true, relationValid: true })) }), model: 'synthetic' }
      }
      const { turns } = z.object({ turns: z.array(z.object({ id: z.string(), speaker: z.string() })) }).parse(input.userPayload)
      const source = turns.find(turn => turn.speaker === 'doctor')
      return { content: JSON.stringify({ additions: source === undefined ? [] : fields.map(field => ({ field: field.field,
        relation: 'addition', facts: [{ text: field.text, sources: [{ sourceTurnId: source.id, quote: field.quote }] }] })) }), model: 'synthetic' }
    },
  }
  const f = await fixture(provider)
  const consultation = await startConsultationCase(f.runtime)
  const started = await f.runtime.app.request(`/api/his/v1/encounters/${consultation.encounterId}/actions/start-first-visit`, {
    method: 'POST', headers: headers(f.doctor), body: JSON.stringify({ expectedVersions: {
      [`Encounter/${consultation.encounterId}`]: consultation.encounterVersion, [`Task/${consultation.doctorTaskId}`]: '1',
    }, input: {} }),
  })
  expect(started.status).toBe(200)
  const visit = startVisitResponseSchema.parse(await started.json()).data
  const read = async () => doctorCaseDetailSchema.parse(await (await f.runtime.app.request(
    `/api/his/v1/doctor/cases/${consultation.outpatientCaseId}`, { headers: { cookie: f.doctor } },
  )).json())
  const before = await read()
  const binding = await f.context({ selection: { kind: 'case', id: consultation.outpatientCaseId,
    version: visit.encounterVersion }, viewRevision: 'doctor-full-document-case' })
  const input = await f.source(binding, fields.map(field => field.quote).join(''), 'four-doctor-fields')
  const response = await f.record(binding, input)
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
  const receipt = doctorRecordingSourceResponseSchema.parse(await response.json())
  await f.runtime.dispatchPending()
  const after = await read()
  expect(after.clinicalDocument?.draft).toMatchObject({ physicalExamination: '双肺呼吸音清，无啰音',
    assessment: '倾向上呼吸道感染', disposition: '先对症处理', followUp: '症状加重及时复诊' })
  expect(after.consultation?.version).toBe(before.consultation?.version)
  expect(after.consultation?.turns).toEqual(before.consultation?.turns)
  expect(after.consultationRecording?.sources).toContainEqual(expect.objectContaining({ id: receipt.data.sourceId,
    kind: 'doctor', messageText: input.content }))
})

it('accepts a same-case ordinary page update but rejects forged sources and identity changes', async () => {
  const f = await fixture()
  const original = await f.context()
  const input = await f.source(original)
  const current = await f.context({ activeSection: 'consultation', viewRevision: 'ordinary-case-update' })
  for (const changed of [{ ...input, content: '未在原文出现的医生事实。' }, { ...input, sourceProof: input.sourceProof + 'x' }]) {
    expect([401, 403]).toContain((await f.record(current, changed)).status)
  }
  expect([401, 403]).toContain((await f.record(current, input, f.registrar)).status)
  const permit = await f.runtime.app.request('/api/agent/v1/doctor-tasks/permit', { method: 'POST', headers: headers(f.doctor),
    body: JSON.stringify({ contextToken: current.token, content: input.content, rpcId: 'permit-only' }) })
  const permitOnly = await permit.json() as { permit: string }
  expect((await f.record(current, { ...input, sourceProof: permitOnly.permit })).status).toBe(401)
  expect((await f.read()).consultationRecording).toBeUndefined()
  expect((await f.record(current, input)).status).toBe(200)
})

it('rejects an old source after leaving a case and returning even with the same task epoch', async () => {
  const f = await fixture()
  const original = await f.context()
  const input = await f.source(original)
  await f.context({ selection: undefined, ui: { status: 'empty' }, viewRevision: 'left-original-case' })
  const returned = await f.context({ viewRevision: 'returned-original-case' })
  expect((await f.record(returned, input)).status).toBe(403)
  expect((await f.read()).consultationRecording).toBeUndefined()
  const newSource = await f.source(returned, input.content, 'new-case-task-rpc')
  expect((await f.record(returned, newSource)).status).toBe(200)
  const changedEpoch = await f.context({ taskEpoch: randomUUID(), viewRevision: 'new-task-epoch' })
  expect((await f.record(changedEpoch, newSource)).status).toBe(403)
  expect((await f.read()).consultationRecording?.sources).toHaveLength(1)
})

it('saves a doctor source while paused without processing it', async () => {
  const f = await fixture()
  const binding = await f.context()
  const control = async (action: string, expectedRecordingVersion: number) => f.runtime.app.request(
    `/api/his/v1/encounters/${f.encounterId}/consultation-recording/actions/control`, { method: 'POST', headers: headers(f.doctor),
      body: JSON.stringify({ expectedVersions: { [`Encounter/${f.encounterId}`]: f.visit.encounterVersion },
        input: { action, expectedRecordingVersion } }) })
  expect((await control('activate', 0)).status).toBe(200)
  expect((await control('pause', (await f.read()).consultationRecording!.version)).status).toBe(200)
  const source = await f.source(binding)
  expect((await f.record(binding, source)).status).toBe(200)
  await f.runtime.dispatchPending()
  const detail = await f.read()
  expect(detail.consultationRecording).toMatchObject({ paused: true, processedCount: 0, failedCount: 0, remainingCount: 1 })
  expect(detail.consultationRecording?.sources).toHaveLength(1)
  expect(detail.clinicalDocument?.draft).toBeUndefined()
})

it('rejects expired, foreign-session, unknown and changed binding source proofs before saving', async () => {
  const f = await fixture()
  const binding = await f.context()
  const input = await f.source(binding)
  for (const [overrides, status] of [
    [{ expiresAt: '2020-01-01T00:00:00.000Z' }, 401],
    [{ dshSessionId: 'another-dsh-session' }, 403],
    [{ arbitraryCaseId: 'another-case' }, 401],
    [{ contextId: 'unissued-context' }, 401],
    [{ scopeKey: 'another-case-scope' }, 403],
  ] as const) {
    expect((await f.record(binding, { ...input, sourceProof: changeSignedSource(input.sourceProof, overrides) })).status).toBe(status)
  }
  expect((await f.read()).consultationRecording).toBeUndefined()
})

it('rejects an old source after the workspace epoch resets', async () => {
  const f = await fixture()
  const binding = await f.context()
  const input = await f.source(binding)
  const admin = await signIn(f.runtime, 'admin@demo.clinmesh.local')
  const reset = await f.runtime.app.request('/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', {
    method: 'POST', headers: headers(admin), body: '{}',
  })
  expect(reset.status).toBe(200)
  expect([401, 403, 409]).toContain((await f.record(binding, input)).status)
})

it('rechecks case responsibility before replaying a saved source receipt', async () => {
  const f = await fixture()
  const binding = await f.context()
  const input = await f.source(binding)
  expect((await f.record(binding, input)).status).toBe(200)
  // 当前没有责任转移 Command；注入持久权限变更后，继续通过真实 HTTP 验证回放门禁。
  expect(f.runtime.database.driver.prepare(`DELETE FROM outpatient_case_responsibility
    WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1' AND case_id = ?`).run(f.caseId).changes).toBe(1)
  expect((await f.record(binding, input)).status).toBe(403)
})

it('rejects a source while signing is prepared and after an immutable document is signed', async () => {
  const f = await fixture()
  const binding = await f.context()
  const input = await f.source(binding)
  const document = { chiefComplaint: '发热两天', historyOfPresentIllness: '发热伴咽痛。', priorMedicalHistory: '未记录。',
    physicalExamination: '双肺呼吸音清。', auxiliaryExamination: '未开立。', assessment: '待核实。', disposition: '对症处理。', followUp: '症状加重及时复诊。' }
  const expectedVersions = { [`Encounter/${f.encounterId}`]: f.visit.encounterVersion }
  const saved = await f.runtime.app.request(`/api/his/v1/encounters/${f.encounterId}/clinical-document/draft`, {
    method: 'PUT', headers: headers(f.doctor), body: JSON.stringify({ expectedVersions, input: { document, expectedDraftVersion: 0 } }),
  })
  expect(saved.status).toBe(200)
  const preview = await f.runtime.app.request(`/api/his/v1/encounters/${f.encounterId}/clinical-document/actions/preview-sign`, {
    method: 'POST', headers: headers(f.doctor), body: JSON.stringify({ expectedVersions, input: { expectedDraftVersion: 1 } }),
  })
  expect(preview.status).toBe(200)
  expect((await f.record(binding, input)).status).toBe(409)
  const prepared = await preview.json() as { data: { previewId: string; commitToken: string } }
  const signed = await f.runtime.app.request(`/api/his/v1/encounters/${f.encounterId}/clinical-document/actions/sign`, {
    method: 'POST', headers: headers(f.doctor), body: JSON.stringify({ expectedVersions, input: {
      commitToken: prepared.data.commitToken, previewId: prepared.data.previewId, consultationReviewed: true,
    } }),
  })
  expect(signed.status).toBe(200)
  expect((await f.record(binding, input)).status).toBe(409)
  expect((await f.read()).consultationRecording?.sources ?? []).toEqual([])
})
