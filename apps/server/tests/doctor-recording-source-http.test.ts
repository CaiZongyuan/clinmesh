import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agentPageContextBindingSchema, doctorRecordingSourceResponseSchema } from '@clinmesh/contracts/agent'
import { createPatientResponseSchema, doctorCaseDetailSchema, doctorQueueSchema, registrationResponseSchema,
  startVisitResponseSchema, triageResponseSchema, consultationHistoryFieldSchema } from '@clinmesh/contracts/his'
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

async function fixture(provider?: JsonChatCompletionsProvider, modelTimeoutMs?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-doctor-source-'))
  disposals.push(() => rm(directory, { recursive: true }))
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters', databasePath: join(directory, 'clinmesh.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply', trustedOrigins: ['http://localhost'],
    dshBridgeSecret: secret,
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret, timeoutMs: modelTimeoutMs ?? 2000, maxResponseBytes: 8192 },
    ...(provider === undefined ? {} : { chatCompletionsProvider: { ...provider, async completeJson(input) {
      if (input.schemaName === 'clinical_document_quality' || input.schemaName === 'clinical_document_quality_verification') {
        const payload = z.object({ agentFacts: z.array(z.object({ id: z.string() })) }).parse(input.userPayload)
        return { model: 'synthetic', content: JSON.stringify({ issues: [],
          agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })) }) }
      }
      return provider.completeJson(input)
    } }, syntheaProvider: new StubSyntheaProvider(),
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
  const context = async (overrides: Record<string, unknown> = {}, dshSessionId = 'doctor-source-session') => agentPageContextBindingSchema.parse(await (await runtime.app.request('/api/agent/v1/page-contexts', {
    method: 'POST', headers: headers(doctor), body: JSON.stringify({ claim: { ...claim, ...overrides },
      client: { id: 'doctor-source-client', revision: ++revision }, dshSessionId }),
  })).json())
  const read = async () => doctorCaseDetailSchema.parse(await (await runtime.app.request(`/api/his/v1/doctor/cases/${caseId}`, { headers: { cookie: doctor } })).json())
  const source = async (binding: Awaited<ReturnType<typeof context>>, content = '查体：双肺呼吸音清，无啰音。',
    rpcId = 'doctor-source-rpc', messageId = 'native-doctor-message') => {
    const response = await runtime.app.request('/api/agent/v1/doctor-tasks/permit', { method: 'POST', headers: headers(doctor),
      body: JSON.stringify({ contextToken: binding.token, content, rpcId }) })
    expect(response.status).toBe(201)
    const { permit } = await response.json() as { permit: string }
    const encodedPermit = permit.split('.')[0]!
    const payload = { ...JSON.parse(Buffer.from(encodedPermit, 'base64url').toString()),
      purpose: 'clinmesh-doctor-recording-source', version: 1, messageId, recordedAt: new Date().toISOString() }
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return { content, sourceProof: `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}` }
  }
  const record = (binding: Awaited<ReturnType<typeof context>>, input: Awaited<ReturnType<typeof source>>, cookie = doctor) => runtime.app.request('/api/agent/v1/doctor-inputs', {
    method: 'POST', headers: headers(cookie), body: JSON.stringify({ ...input, contextToken: binding.token }),
  })
  return { runtime, doctor, registrar, caseId, encounterId: registration.encounterId, visit, context, read, source, record }
}

it('retains unchanged facts from the pinned batch without asking the model to repeat their evidence', async () => {
  const provider: JsonChatCompletionsProvider = { async completeJson(input) {
    if (input.schemaName === 'consultation_history_verification') return { content: JSON.stringify({
      additions: [{ index: 0, faithful: true, complete: true, relationValid: true }],
    }), model: 'synthetic' }
    const payload = z.object({ turns: z.array(z.object({ id: z.string(), messageText: z.string() })),
      history: z.array(z.object({ id: z.string() })) }).parse(input.userPayload)
    const source = payload.turns.at(-1)!
    const target = payload.history[0]
    return { content: JSON.stringify({ additions: [{ field: 'physicalExamination',
      relation: target === undefined ? 'addition' : 'update',
      ...(target === undefined ? {} : { targetAdditionId: target.id, retainedFactIndexes: [0] }),
      facts: [{ text: source.messageText.slice(0, -1), sources: [{ sourceTurnId: source.id, quote: source.messageText }] }],
    }] }), model: 'synthetic' }
  } }
  const f = await fixture(provider)
  const binding = await f.context()
  const saved = []
  for (const [index, text] of ['双肺呼吸音清。', '心律齐。'].entries()) {
    const input = await f.source(binding, text, `retain-rpc-${index}`, `retain-message-${index}`)
    saved.push(doctorRecordingSourceResponseSchema.parse(await (await f.record(binding, input)).json()).data.sourceId)
    await f.runtime.dispatchPending()
  }
  const detail = await f.read()
  expect(detail.clinicalDocument?.draft?.physicalExamination).toBe('双肺呼吸音清；心律齐')
  expect(detail.consultationRecording?.additions.filter(item => item.status === 'applied')).toHaveLength(1)
  expect(detail.consultationRecording?.additions.find(item => item.status === 'applied')?.facts?.flatMap(fact => fact.sources)
    .map(source => source.sourceTurnId)).toEqual(saved)
})

it('persists the increment before semantic verification and batches saved sources once', async () => {
  let summaries = 0
  let verifications = 0
  const provider: JsonChatCompletionsProvider = {
    async completeJson(input) {
      if (input.schemaName === 'consultation_history_verification') {
        verifications += 1
        return { content: JSON.stringify({ additions: [{ index: 0, faithful: false, complete: true, relationValid: true }] }), model: 'synthetic' }
      }
      summaries += 1
      const { turns } = z.object({ turns: z.array(z.object({ id: z.string(), messageText: z.string() })) }).parse(input.userPayload)
      return { content: JSON.stringify({ additions: [{ field: 'physicalExamination', relation: 'addition',
        facts: turns.map(turn => ({ text: turn.messageText.slice(0, -1), sources: [{ sourceTurnId: turn.id, quote: turn.messageText }] })) }] }), model: 'synthetic' }
    },
  }
  const f = await fixture(provider)
  const revision = async () => z.object({ revision: z.string() }).parse(await (await f.runtime.app.request(
    `/api/his/v1/doctor/cases/${f.caseId}/recording-events`, { headers: { cookie: f.doctor } })).json()).revision
  const initialRevision = await revision()
  const binding = await f.context()
  for (const [index, text] of ['双肺呼吸音清。', '心律齐。'].entries()) {
    const input = await f.source(binding, text, `batch-rpc-${index}`, `batch-message-${index}`)
    expect((await f.record(binding, input)).status).toBe(200)
  }
  await f.runtime.dispatcher.dispatchOnce()
  const recorded = await f.read()
  expect(recorded.clinicalDocument?.draft?.physicalExamination).toBe('双肺呼吸音清；心律齐')
  expect(summaries).toBe(1)
  expect(verifications).toBe(0)
  expect(recorded.consultationRecording).toMatchObject({ processedCount: 2, remainingCount: 0,
    verification: { pendingCount: 1, flaggedCount: 0 } })
  const recordedRevision = await revision()
  expect(recordedRevision).not.toBe(initialRevision)
  await f.runtime.dispatchPending()
  const checked = await f.read()
  expect(checked.consultationRecording).toMatchObject({ verification: { pendingCount: 0, flaggedCount: 1 } })
  expect(checked.clinicalDocument?.draft).toEqual(recorded.clinicalDocument?.draft)
  expect(await revision()).not.toBe(recordedRevision)
})

it('retries an unavailable semantic check without regenerating the saved draft or repeating a negative verdict', async () => {
  let summaries = 0
  let checks = 0
  let unavailable = true
  const f = await fixture({ async completeJson(input) {
    if (input.schemaName === 'consultation_history_verification') {
      checks++
      if (unavailable) throw new Error('Synthetic offline verifier')
      return { content: JSON.stringify({ additions: [{ index: 0, faithful: false, complete: true, relationValid: true }] }), model: 'synthetic' }
    }
    summaries++
    const payload = z.object({ turns: z.array(z.object({ id: z.string(), messageText: z.string() })) }).parse(input.userPayload)
    const source = payload.turns.at(-1)!
    return { content: JSON.stringify({ additions: [{ field: 'physicalExamination', relation: 'addition',
      facts: [{ text: '双肺呼吸音清', sources: [{ sourceTurnId: source.id, quote: source.messageText }] }] }] }), model: 'synthetic' }
  } })
  const binding = await f.context()
  await f.record(binding, await f.source(binding, '双肺呼吸音清。'))
  await f.runtime.dispatchPending()
  const before = await f.read()
  expect(before.consultationRecording?.verification?.failedCount).toBe(1)
  const retry = async () => {
    const detail = await f.read()
    return f.runtime.app.request(`/api/his/v1/encounters/${f.encounterId}/consultation-recording/actions/control`, {
      method: 'POST', headers: headers(f.doctor), body: JSON.stringify({ expectedVersions: { [`Encounter/${f.encounterId}`]: detail.encounter.versionId },
        input: { action: 'retry', expectedRecordingVersion: detail.consultationRecording!.version } }),
    })
  }
  unavailable = false
  expect((await retry()).status).toBe(200)
  await f.runtime.dispatchPending()
  const after = await f.read()
  expect(after.consultationRecording?.verification).toMatchObject({ failedCount: 0, flaggedCount: 1 })
  expect(after.clinicalDocument?.draft).toEqual(before.clinicalDocument?.draft)
  expect({ summaries, checks }).toEqual({ summaries: 1, checks: 2 })
  expect((await retry()).status).toBe(409)
})

it('preserves complete evidence beyond 128 KiB of identity metadata without enlarging model input', async () => {
  const f = await fixture({ async completeJson(input) {
    if (input.schemaName === 'consultation_history_verification') {
      const { additions } = z.object({ additions: z.array(z.unknown()) }).parse(input.userPayload)
      return { content: JSON.stringify({ additions: additions.map((_, index) => ({
        index, faithful: true, complete: true, relationValid: true,
      })) }), model: 'synthetic' }
    }
    expect(Buffer.byteLength(JSON.stringify(input.userPayload))).toBeLessThanOrEqual(128 * 1024)
    const { turns, currentSourceIds } = z.object({ turns: z.array(z.object({ id: z.string(), messageText: z.string() })),
      currentSourceIds: z.array(z.string()) }).parse(input.userPayload)
    return { content: JSON.stringify({ additions: currentSourceIds.map(id => {
      const source = turns.find(turn => turn.id === id)!
      return { field: 'physicalExamination', relation: 'addition', facts: [{ text: source.messageText.slice(0, -1),
        sources: [{ sourceTurnId: source.id, quote: source.messageText }] }] }
    }) }), model: 'synthetic' }
  } })
  const binding = await f.context({}, 's'.repeat(256))
  for (let index = 0; index < 160; index++) {
    await f.record(binding, await f.source(binding, `第${index + 1}次复测心率${60 + index % 40}次每分钟。`,
      String(index).padEnd(256, 'r'), String(index).padEnd(256, 'm')))
  }
  await f.runtime.dispatchPending()
  expect((await f.read()).consultationRecording).toMatchObject({ processedCount: 160, failedCount: 0 })
  const last = z.object({ snapshot_json: z.string() }).parse(f.runtime.database.driver.prepare(
    'SELECT snapshot_json FROM consultation_recording_batch ORDER BY rowid DESC LIMIT 1').get())
  expect(Buffer.byteLength(last.snapshot_json)).toBeGreaterThan(128 * 1024)
  expect(Buffer.byteLength(last.snapshot_json)).toBeLessThanOrEqual(256 * 1024)
  expect(JSON.parse(last.snapshot_json).sources).toHaveLength(160)
}, 120_000)

it('notifies authorized case readers after commit and cleans up cancelled subscriptions', async () => {
  const f = await fixture()
  const url = `/api/his/v1/doctor/cases/${f.caseId}/recording-events`
  expect((await f.runtime.app.request(url)).status).toBe(401)
  expect((await f.runtime.app.request(url, { headers: { cookie: f.registrar } })).status).toBe(403)
  const revisionSchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
  const initial = revisionSchema.parse(await (await f.runtime.app.request(url, { headers: { cookie: f.doctor } })).json())
  const controller = new AbortController()
  const cancelled = f.runtime.app.request(`${url}?since=${initial.revision}`, { headers: { cookie: f.doctor }, signal: controller.signal })
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  controller.abort()
  expect((await cancelled).status).toBe(200)
  const waiting = f.runtime.app.request(`${url}?since=${initial.revision}`, { headers: { cookie: f.doctor } })
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  const binding = await f.context()
  await f.record(binding, await f.source(binding))
  const response = await waiting
  expect(response.status).toBe(200)
  expect(revisionSchema.parse(await response.json()).revision).not.toBe(initial.revision)
})

it('discards a semantic verdict for a fragment the doctor has edited while verification was running', async () => {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const f = await fixture({ async completeJson(input) {
    if (input.schemaName === 'consultation_history_verification') {
      entered(); await held
      return { content: JSON.stringify({ additions: [{ index: 0, faithful: false, complete: true, relationValid: true }] }), model: 'synthetic' }
    }
    const source = z.object({ turns: z.array(z.object({ id: z.string(), messageText: z.string() })) }).parse(input.userPayload).turns.at(-1)!
    return { content: JSON.stringify({ additions: [{ field: 'physicalExamination', relation: 'addition',
      facts: [{ text: '双肺呼吸音清', sources: [{ sourceTurnId: source.id, quote: source.messageText }] }] }] }), model: 'synthetic' }
  } })
  const binding = await f.context()
  await f.record(binding, await f.source(binding, '双肺呼吸音清。'))
  await f.runtime.dispatcher.dispatchOnce({ kinds: ['consultation.record-history'] })
  const checking = f.runtime.dispatcher.dispatchOnce({ kinds: ['consultation.verify-history'] })
  await started
  try {
    const before = await f.read()
    const response = await f.runtime.app.request(`/api/his/v1/encounters/${f.encounterId}/clinical-document/draft`, {
      method: 'PUT', headers: headers(f.doctor), body: JSON.stringify({ expectedVersions: { [`Encounter/${f.encounterId}`]: before.encounter.versionId },
        input: { expectedDraftVersion: before.clinicalDocument!.draft!.version,
          document: { ...before.clinicalDocument!.draft, version: undefined, updatedAt: undefined, physicalExamination: '医生复核：右下肺呼吸音减弱。' } } }),
    })
    expect(response.status).toBe(200)
  } finally { release(); await checking }
  const after = await f.read()
  expect(after.clinicalDocument!.draft!.physicalExamination).toBe('医生复核：右下肺呼吸音减弱。')
  expect(after.consultationRecording?.verification).toMatchObject({ pendingCount: 0, flaggedCount: 0, failedCount: 0 })
  expect(f.runtime.database.driver.prepare('SELECT status FROM consultation_recording_verification').get()).toEqual({ status: 'stale' })
})

it('keeps a concurrent manual field while recording an independent candidate in another field', async () => {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const f = await fixture({ async completeJson(input) {
    if (input.schemaName === 'consultation_history_verification') return { content: JSON.stringify({
      additions: [{ index: 0, faithful: true, complete: true, relationValid: true }],
    }), model: 'synthetic' }
    const source = z.object({ turns: z.array(z.object({ id: z.string() })) }).parse(input.userPayload).turns.at(-1)!
    entered(); await held
    return { content: JSON.stringify({ additions: [
      { field: 'physicalExamination', relation: 'addition', facts: [{ text: '双肺呼吸音清',
        sources: [{ sourceTurnId: source.id, quote: '双肺呼吸音清。' }] }] },
      { field: 'assessment', relation: 'addition', facts: [{ text: '考虑上呼吸道感染',
        sources: [{ sourceTurnId: source.id, quote: '考虑上呼吸道感染。' }] }] },
    ] }), model: 'synthetic' }
  } })
  const binding = await f.context()
  await f.record(binding, await f.source(binding, '双肺呼吸音清。考虑上呼吸道感染。'))
  const extracting = f.runtime.dispatcher.dispatchOnce({ kinds: ['consultation.record-history'] })
  await started
  try {
    const before = await f.read()
    const response = await f.runtime.app.request(`/api/his/v1/encounters/${f.encounterId}/clinical-document/draft`, {
      method: 'PUT', headers: headers(f.doctor), body: JSON.stringify({ expectedVersions: { [`Encounter/${f.encounterId}`]: before.encounter.versionId },
        input: { expectedDraftVersion: 0, document: { ...Object.fromEntries(consultationHistoryFieldSchema.options.map(field => [field, ''])),
          assessment: '医生手工评估：尚待检查。' } } }),
    })
    expect(response.status).toBe(200)
  } finally { release(); await extracting }
  const detail = await f.read()
  expect(detail.clinicalDocument?.draft).toMatchObject({ physicalExamination: '双肺呼吸音清', assessment: '医生手工评估：尚待检查。' })
  expect(detail.consultationRecording?.sourceResults).toEqual([{ sourceId: expect.any(String), result: 'needs-verification' }])
})

it('does not send a paused document to a queued semantic check', async () => {
  let checks = 0
  const f = await fixture({ async completeJson(input) {
    if (input.schemaName === 'consultation_history_verification') { checks++; throw new Error('Paused verification must not run') }
    const source = z.object({ turns: z.array(z.object({ id: z.string(), messageText: z.string() })) }).parse(input.userPayload).turns.at(-1)!
    return { content: JSON.stringify({ additions: [{ field: 'physicalExamination', relation: 'addition',
      facts: [{ text: '双肺呼吸音清', sources: [{ sourceTurnId: source.id, quote: source.messageText }] }] }] }), model: 'synthetic' }
  } })
  const binding = await f.context()
  await f.record(binding, await f.source(binding, '双肺呼吸音清。'))
  await f.runtime.dispatcher.dispatchOnce({ kinds: ['consultation.record-history'] })
  const before = await f.read()
  const paused = await f.runtime.app.request(`/api/his/v1/encounters/${f.encounterId}/consultation-recording/actions/control`, {
    method: 'POST', headers: headers(f.doctor), body: JSON.stringify({ expectedVersions: { [`Encounter/${f.encounterId}`]: before.encounter.versionId },
      input: { action: 'pause', expectedRecordingVersion: before.consultationRecording!.version } }),
  })
  expect(paused.status).toBe(200)
  await f.runtime.dispatchPending()
  expect(checks).toBe(0)
  expect((await f.read()).clinicalDocument?.draft).toEqual(before.clinicalDocument?.draft)
  expect((await f.read()).consultationRecording?.verification).toMatchObject({ pendingCount: 0, failedCount: 1 })
})

it('isolates a candidate with forged citations and continues recording later sources', async () => {
  const provider: JsonChatCompletionsProvider = { async completeJson(input) {
    if (input.schemaName === 'consultation_history_verification') return { content: JSON.stringify({
      additions: [{ index: 0, faithful: true, complete: true, relationValid: true }],
    }), model: 'synthetic' }
    const { turns, currentSourceIds } = z.object({ turns: z.array(z.object({ id: z.string(), messageText: z.string() })),
      currentSourceIds: z.array(z.string()) }).parse(input.userPayload)
    const source = turns.find(turn => turn.id === currentSourceIds[0])!
    return { model: 'synthetic', content: JSON.stringify({ additions: [
      { field: 'physicalExamination', relation: 'addition', facts: [{ text: source.messageText.slice(0, -1),
        sources: [{ sourceTurnId: source.id, quote: source.messageText }] }] },
      ...(source.messageText === '双肺呼吸音清。' ? [{ field: 'assessment', relation: 'addition',
        facts: [{ text: '无依据的诊断', sources: [{ sourceTurnId: 'forged-source', quote: '伪造来源。' }] }] }] : []),
    ] }) }
  } }
  const f = await fixture(provider)
  const binding = await f.context()
  await f.record(binding, await f.source(binding, '双肺呼吸音清。'))
  await f.runtime.dispatchPending()
  expect((await f.read()).clinicalDocument?.draft).toMatchObject({ physicalExamination: '双肺呼吸音清', assessment: '' })
  expect((await f.read()).consultationRecording).toMatchObject({ failedCount: 1,
    sourceResults: [{ result: 'needs-verification' }] })
  await f.record(binding, await f.source(binding, '心律齐。', 'next-rpc', 'next-message'))
  await f.runtime.dispatchPending()
  const detail = await f.read()
  expect(detail.clinicalDocument?.draft?.physicalExamination).toBe('双肺呼吸音清\n心律齐')
  expect(detail.consultationRecording).toMatchObject({ failedCount: 1, processedCount: 1 })
})

it('lets a new increment finish while another semantic check is still running', async () => {
  let signalStarted!: () => void
  let release!: () => void
  const checking = new Promise<void>(resolve => { signalStarted = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const provider: JsonChatCompletionsProvider = { async completeJson(input) {
    if (input.schemaName === 'consultation_history_verification') {
      signalStarted()
      await gate
      return { content: JSON.stringify({ additions: [{ index: 0, faithful: true, complete: true, relationValid: true }] }), model: 'synthetic' }
    }
    const { turns, currentSourceIds } = z.object({ turns: z.array(z.object({ id: z.string(), messageText: z.string() })),
      currentSourceIds: z.array(z.string()) }).parse(input.userPayload)
    const source = turns.find(turn => turn.id === currentSourceIds[0])!
    return { content: JSON.stringify({ additions: [{ field: 'physicalExamination', relation: 'addition',
      facts: [{ text: source.messageText.slice(0, -1), sources: [{ sourceTurnId: source.id, quote: source.messageText }] }] }] }), model: 'synthetic' }
  } }
  const f = await fixture(provider)
  const binding = await f.context()
  await f.record(binding, await f.source(binding, '双肺呼吸音清。'))
  const first = f.runtime.dispatchPending()
  await checking
  let second: Promise<void> | undefined
  try {
    await f.record(binding, await f.source(binding, '心律齐。', 'parallel-rpc', 'parallel-message'))
    second = f.runtime.dispatchPending()
    await expect.poll(async () => (await f.read()).clinicalDocument?.draft?.physicalExamination)
      .toBe('双肺呼吸音清\n心律齐')
  } finally { release(); await Promise.all([first, second]) }
})

it('cancels an in-flight semantic request as soon as its exact fragment is superseded', async () => {
  let entered!: () => void
  let release!: () => void
  let cancelled = false
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const f = await fixture({ async completeJson(input) {
    if (input.schemaName === 'consultation_history_verification') {
      entered()
      await new Promise<void>((resolve, reject) => {
        input.signal!.addEventListener('abort', () => { cancelled = true; reject(input.signal!.reason) }, { once: true })
        void held.then(resolve)
      })
      return { content: JSON.stringify({ additions: [{ index: 0, faithful: true, complete: true, relationValid: true }] }), model: 'synthetic' }
    }
    const payload = z.object({ turns: z.array(z.object({ id: z.string(), messageText: z.string() })),
      history: z.array(z.object({ id: z.string() })) }).parse(input.userPayload)
    const source = payload.turns.at(-1)!
    const target = payload.history[0]
    return { content: JSON.stringify({ additions: [{ field: 'physicalExamination', relation: target === undefined ? 'addition' : 'update',
      ...(target === undefined ? {} : { targetAdditionId: target.id, retainedFactIndexes: [0] }),
      facts: [{ text: source.messageText.slice(0, -1), sources: [{ sourceTurnId: source.id, quote: source.messageText }] }] }] }), model: 'synthetic' }
  } })
  const binding = await f.context()
  await f.record(binding, await f.source(binding, '双肺呼吸音清。'))
  await f.runtime.dispatcher.dispatchOnce({ kinds: ['consultation.record-history'] })
  const checking = f.runtime.dispatcher.dispatchOnce({ kinds: ['consultation.verify-history'] })
  await started
  try {
    await f.record(binding, await f.source(binding, '心律齐。', 'cancel-check-rpc', 'cancel-check-message'))
    await f.runtime.dispatcher.dispatchOnce({ kinds: ['consultation.record-history'] })
    await expect.poll(() => cancelled, { timeout: 500 }).toBe(true)
  } finally { release(); await checking }
  expect((await f.read()).clinicalDocument?.draft?.physicalExamination).toBe('双肺呼吸音清；心律齐')
  expect(f.runtime.database.driver.prepare("SELECT count(*) AS count FROM consultation_recording_verification WHERE status = 'stale'").get()).toEqual({ count: 1 })
})

it.each(['binding', 'generation'] as const)('cancels an in-flight recording during %s on pause and resumes without waiting for the old model', async phase => {
  let entered!: () => void
  let release!: () => void
  let recordingSignal!: AbortSignal
  let calls = 0
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const waitForCancellation = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    recordingSignal = signal
    recordingSignal.addEventListener('abort', () => reject(recordingSignal.reason), { once: true })
    entered()
    void held.then(resolve)
  })
  const f = await fixture({ async resolveModel(model, signal) {
    if (phase === 'binding' && recordingSignal === undefined) await waitForCancellation(signal!)
    return model
  }, async completeJson(input) {
    if (input.schemaName === 'consultation_history_verification') return { content: JSON.stringify({
      additions: [{ index: 0, faithful: true, complete: true, relationValid: true }],
    }), model: 'synthetic' }
    calls++
    if (phase === 'generation' && calls === 1) await waitForCancellation(input.signal!)
    const { turns } = z.object({ turns: z.array(z.object({ id: z.string(), messageText: z.string() })) }).parse(input.userPayload)
    return { content: JSON.stringify({ additions: [{ field: 'physicalExamination', relation: 'addition',
      facts: [{ text: '双肺呼吸音清', sources: [{ sourceTurnId: turns[0]!.id, quote: turns[0]!.messageText }] }] }] }), model: 'synthetic' }
  } })
  const binding = await f.context()
  expect((await f.record(binding, await f.source(binding, '双肺呼吸音清。'))).status).toBe(200)
  const control = async (action: 'pause' | 'resume') => {
    const before = await f.read()
    return f.runtime.app.request(`/api/his/v1/encounters/${f.encounterId}/consultation-recording/actions/control`, {
      method: 'POST', headers: headers(f.doctor), body: JSON.stringify({
        expectedVersions: { [`Encounter/${f.encounterId}`]: before.encounter.versionId },
        input: { action, expectedRecordingVersion: before.consultationRecording!.version },
      }),
    })
  }
  const extracting = f.runtime.dispatchPending()
  await started
  try {
    expect((await control('pause')).status).toBe(200)
    expect(recordingSignal.aborted).toBe(true)
    await extracting
    const paused = await f.read()
    expect(paused.clinicalDocument?.draft).toBeUndefined()
    expect(paused.consultationRecording).toMatchObject({ paused: true, processedCount: 0, remainingCount: 1, failedCount: 0 })
    expect((await control('resume')).status).toBe(200)
    await f.runtime.dispatchPending()
    expect(calls).toBe(phase === 'binding' ? 1 : 2)
    const resumed = await f.read()
    expect(resumed.clinicalDocument?.draft?.physicalExamination).toBe('双肺呼吸音清')
    expect(resumed.consultationRecording).toMatchObject({ processedCount: 1, remainingCount: 0, failedCount: 0 })
  } finally { release(); await extracting }
})

it('persists a valid recording returned after six seconds within the normal model budget', async () => {
  const f = await fixture({ async completeJson(input) {
    if (input.schemaName === 'consultation_history_verification') return { content: JSON.stringify({
      additions: [{ index: 0, faithful: true, complete: true, relationValid: true }],
    }), model: 'synthetic' }
    const { turns } = z.object({ turns: z.array(z.object({ id: z.string(), messageText: z.string() })) }).parse(input.userPayload)
    await new Promise(resolve => setTimeout(resolve, 6_100))
    input.signal?.throwIfAborted()
    return { content: JSON.stringify({ additions: [{ field: 'physicalExamination', relation: 'addition',
      facts: [{ text: turns[0]!.messageText, sources: [{ sourceTurnId: turns[0]!.id, quote: turns[0]!.messageText }] }] }] }), model: 'synthetic' }
  } })
  const binding = await f.context()
  await f.record(binding, await f.source(binding, '双肺呼吸音清。'))
  await f.runtime.dispatchPending()
  expect((await f.read()).clinicalDocument?.draft?.physicalExamination).toBe('双肺呼吸音清。')
  expect((await f.read()).consultationRecording).toMatchObject({ processedCount: 1, failedCount: 0 })
})

it('cancels a timed out recording once and preserves its failure without blocking the next source', async () => {
  let calls = 0
  let cancelled = false
  const provider: JsonChatCompletionsProvider = { async completeJson(input) {
    if (input.schemaName === 'consultation_history_verification') return { content: JSON.stringify({ additions: [] }), model: 'synthetic' }
    calls += 1
    if (calls === 1) await new Promise<void>((_resolve, reject) => input.signal!.addEventListener('abort', () => {
      cancelled = true; reject(input.signal!.reason)
    }, { once: true }))
    return { content: JSON.stringify({ additions: [] }), model: 'synthetic' }
  } }
  const f = await fixture(provider, 100)
  const binding = await f.context()
  await f.record(binding, await f.source(binding))
  await f.runtime.dispatchPending()
  expect(cancelled).toBe(true)
  expect(calls).toBe(1)
  expect((await f.read()).consultationRecording).toMatchObject({ failures: [{ code: 'AI_TIMEOUT', retrying: false }] })
  const timing = z.object({ timings_json: z.string() }).parse(f.runtime.database.driver.prepare(
    'SELECT timings_json FROM consultation_recording_batch').get())
  expect(JSON.parse(timing.timings_json)).toMatchObject({ errorCode: 'AI_TIMEOUT', stage: 'summary', sourceCount: 1,
    aggregationMs: 0, schedulingMs: expect.any(Number), modelMs: expect.any(Number), validationMs: 0,
    persistenceMs: expect.any(Number), firstResponseMs: null, firstTextMs: null })
  await f.record(binding, await f.source(binding, '没有新增记录。', 'after-timeout-rpc', 'after-timeout-message'))
  await f.runtime.dispatchPending()
  expect(calls).toBe(2)
  expect((await f.read()).consultationRecording).toMatchObject({ processedCount: 1, failedCount: 1,
    sourceResults: [{ result: 'failed' }, { result: 'no-new-facts' }] })
})

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

it.each([129, 256])('persists and queues doctor supplements with %i-character native identifiers', async length => {
  const f = await fixture()
  const sessionId = 's'.repeat(length)
  const messageId = 'm'.repeat(length)
  const rpcId = 'r'.repeat(length)
  const binding = await f.context({}, sessionId)
  const input = await f.source(binding, '查体：双肺呼吸音清，无啰音。', rpcId, messageId)
  const response = await f.record(binding, input)
  expect(response.status).toBe(200)
  const receipt = doctorRecordingSourceResponseSchema.parse(await response.json())
  expect((await f.read()).consultationRecording).toMatchObject({ remainingCount: 1,
    sources: [{ id: receipt.data.sourceId, kind: 'doctor', messageText: input.content, sessionId, messageId, rpcId }] })
  expect((await f.record(binding, input)).status).toBe(200)
  expect((await f.read()).consultationRecording).toMatchObject({ remainingCount: 1,
    sources: [{ id: receipt.data.sourceId, sessionId, messageId, rpcId }] })
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
      commitToken: prepared.data.commitToken, previewId: prepared.data.previewId,
    } }),
  })
  expect(signed.status).toBe(200)
  expect((await f.record(binding, input)).status).toBe(409)
  expect((await f.read()).consultationRecording?.sources ?? []).toEqual([])
})
