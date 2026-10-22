import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { doctorRecommendationKindSchema, doctorRecommendationStateSchema, type DoctorRecommendationKind } from '@clinmesh/contracts/doctor-recommendations'
import { doctorCaseDetailSchema, sendConsultationMessageResponseSchema } from '@clinmesh/contracts/his'
import { encodeModelRoute, modelBridgeRequestSchema } from '@clinmesh/contracts/model-bridge'
import { unknownModelTokenUsage } from '@clinmesh/contracts/model-usage'
import { DshModelProvider } from '../src/infrastructure/ai/dsh-model-provider.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { canonicalJsonHash } from '../src/application/scenario-data/canonical-json.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'

// 回归用例：同输入复用、同题共享和成功步骤恢复。
// 所有模型传输均被本地 fetch 替身截获；不监听端口、不连接真实模型。
type CompleteRequest = Extract<z.infer<typeof modelBridgeRequestSchema>, { operation: 'complete' }>
type Responder = (input: CompleteRequest, signal: AbortSignal | null | undefined) => Promise<Response>
const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })

function gate() {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

function bridgeResponse(input: CompleteRequest, body: Record<string, unknown>, status = 200) {
  return Response.json({ ...body, accounting: { attemptId: input.attemptId,
    status: status >= 400 ? 'failed' : 'succeeded', dispatch: 'dispatched', usage: unknownModelTokenUsage,
  } }, { status })
}

function answer(input: CompleteRequest, value: unknown) {
  return bridgeResponse(input, { model: input.model, content: JSON.stringify(value) })
}

async function setup(respond: Responder) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-usage-reproduction-'))
  disposals.push(() => rm(directory, { recursive: true, force: true }))
  const bridge = { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters',
    timeoutMs: 10_000, maxResponseBytes: 256 * 1024 }
  const route = encodeModelRoute({ provider: 'synthetic', model: 'offline-only' })
  const provider = new DshModelProvider({ ...bridge, fetch: async (_url, init) => {
    const input = modelBridgeRequestSchema.parse(JSON.parse(String(init?.body)))
    if (input.operation === 'resolve') return Response.json({ model: route })
    if (input.schemaName === 'patient_persona') return answer(input, persona)
    if (input.schemaName === 'clinical_document_quality' || input.schemaName === 'clinical_document_quality_verification') {
      const payload = z.object({ agentFacts: z.array(z.object({ id: z.string() })) }).parse(input.userPayload)
      return answer(input, { issues: [], agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })) })
    }
    return respond(input, init?.signal)
  } })
  const options: Parameters<typeof createClinMeshRuntime>[0] = {
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters',
    databasePath: join(directory, 'clinmesh.sqlite'), demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply', outboxRetryDelayMs: 0, dshModelBridge: bridge, chatCompletionsProvider: provider,
    syntheaProvider: new StubSyntheaProvider(), trustedOrigins: ['http://localhost'],
    imagingAssetDirectory: join(directory, 'imaging-assets'), imagingCatalogDirectory: join(directory, 'imaging-catalog'),
    pathologyAssetDirectory: join(directory, 'pathology-assets'), pathologyCatalogDirectory: join(directory, 'pathology-catalog'),
  }
  let runtime = await createClinMeshRuntime(options)
  disposals.push(() => runtime.close())
  const started = await startConsultationCase(runtime)
  const cookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const headers = (key: string = randomUUID()) => ({ cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key })
  const readCase = async () => doctorCaseDetailSchema.parse(await (await runtime.app.request(
    `/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } },
  )).json())
  const claim = async () => {
    const response = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ expectedVersions: {
        [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1',
      }, input: {} }),
    })
    expect(response.status, await response.text()).toBe(200)
  }
  const path = (kind: DoctorRecommendationKind) => `/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/${kind}`
  const read = async (kind: DoctorRecommendationKind = 'diagnosis') => doctorRecommendationStateSchema.parse(
    await (await runtime.app.request(path(kind), { headers: { cookie } })).json(),
  )
  const generate = async (kind: DoctorRecommendationKind = 'diagnosis', action: { refresh?: boolean; continueGeneration?: number; key?: string } = {}) => {
    const state = await read(kind)
    const response = await runtime.app.request(`${path(kind)}/actions/generate`, {
      method: 'POST', headers: headers(action.key), body: JSON.stringify({
        expectedVersions: { [`Encounter/${state.encounterId}`]: state.encounterVersion },
        input: { expectedInputFingerprint: state.inputFingerprint, refresh: action.refresh ?? false,
          ...(action.continueGeneration === undefined ? {} : { continueGeneration: action.continueGeneration }) },
      }),
    })
    expect(response.status, await response.text()).toBe(200)
  }
  const saveDocument = async (chiefComplaint = '头晕一周') => {
    const current = await readCase()
    const response = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`, {
      method: 'PUT', headers: headers(), body: JSON.stringify({
        expectedVersions: { [`Encounter/${started.encounterId}`]: current.encounter.versionId },
        input: { expectedDraftVersion: current.clinicalDocument?.draft?.version ?? 0, document: {
          assessment: '', chiefComplaint, disposition: '', followUp: '',
          historyOfPresentIllness: '站起时明显。', physicalExamination: '',
        } },
      }),
    })
    expect(response.status, await response.text()).toBe(200)
  }
  return { get runtime() { return runtime }, started, headers, readCase, claim, read, generate, saveDocument,
    restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(options) },
  }
}

it('reuses all five recommendation generations after saving identical document text, with an unchanged-input control', async () => {
  const calls: string[] = []
  const fixture = await setup(async input => {
    expect(input.schemaName).toBe('doctor_recommendations')
    calls.push(z.object({ kind: z.string() }).parse(input.userPayload).kind)
    return answer(input, { items: [], considerations: [], missingInformation: [] })
  })
  await fixture.claim()
  await fixture.saveDocument()
  const kinds = doctorRecommendationKindSchema.options
  for (const kind of kinds) await fixture.generate(kind)
  await fixture.runtime.dispatchPending()
  const before = await fixture.readCase()
  const previous = await Promise.all(kinds.map(kind => fixture.read(kind)))
  expect(previous.map(state => state.generation)).toEqual([1, 1, 1, 1, 1])
  expect(calls).toHaveLength(5)

  // 对照：无保存、输入未变时，新幂等键和 refresh:false 仍复用现有生成。
  for (const kind of kinds) await fixture.generate(kind)
  await fixture.runtime.dispatchPending()
  expect(calls).toHaveLength(5)

  await fixture.saveDocument()
  const after = await fixture.readCase()
  expect(before.clinicalDocument?.draft).toBeDefined()
  expect(after.clinicalDocument?.draft).toBeDefined()
  const { version: beforeVersion, updatedAt: _beforeUpdatedAt, ...beforeText } = before.clinicalDocument!.draft!
  const { version: afterVersion, updatedAt: _afterUpdatedAt, ...afterText } = after.clinicalDocument!.draft!
  expect(beforeText).toMatchObject({ chiefComplaint: '头晕一周', historyOfPresentIllness: '站起时明显。' })
  expect(afterText).toEqual(beforeText)
  expect(beforeVersion).toBe(1)
  expect(afterVersion).toBe(2)
  const stale = await Promise.all(kinds.map(kind => fixture.read(kind)))
  for (let index = 0; index < kinds.length; index++) {
    expect(stale[index]!.stale).toBe(false)
    expect(stale[index]!.inputFingerprint).toBe(previous[index]!.inputFingerprint)
  }
  // 重放页面自动 effect 使用的 refresh:false 请求，不声称进行了浏览器验证。
  for (const kind of kinds) await fixture.generate(kind)
  await fixture.runtime.dispatchPending()
  const regenerated = await Promise.all(kinds.map(kind => fixture.read(kind)))
  expect(regenerated.map(state => state.generation)).toEqual([1, 1, 1, 1, 1])
  for (const kind of kinds) expect(calls.filter(value => value === kind)).toHaveLength(1)
})

it('keeps same-text work in flight and cancels it when the actual clinical input changes', async () => {
  const entered = gate(), release = gate()
  let activeSignal: AbortSignal | null | undefined
  const calls: string[] = []
  const fixture = await setup(async (input, signal) => {
    calls.push(input.schemaName)
    activeSignal = signal
    entered.open()
    await release.promise
    return answer(input, diagnosis(input))
  })
  await fixture.claim()
  await fixture.saveDocument()
  await fixture.generate()
  const dispatch = fixture.runtime.dispatchPending()
  try {
    await entered.promise
    await fixture.saveDocument()
    expect(await fixture.read()).toMatchObject({ status: 'pending', stale: false, generation: 1 })
    expect(activeSignal?.aborted).toBe(false)
    await fixture.saveDocument('头晕一周，今天加重。')
    expect(await fixture.read()).toMatchObject({ stale: true, generation: 1 })
    expect(activeSignal?.aborted).toBe(true)
  } finally {
    release.open()
    await dispatch
  }
  expect(calls).toEqual(['doctor_recommendations'])
  expect((await fixture.read()).items).toEqual([])
})

it('reuses a verified legacy successful snapshot even when the same text was saved before upgrading', async () => {
  let calls = 0
  const fixture = await setup(async input => {
    calls++
    return answer(input, { items: [], considerations: [], missingInformation: [] })
  })
  await fixture.claim()
  await fixture.saveDocument()
  await fixture.generate()
  await fixture.runtime.dispatchPending()
  const current = await fixture.readCase()
  const draft = current.clinicalDocument!.draft!
  const row = z.object({ input_json: z.string(), state_json: z.string() }).parse(fixture.runtime.database.driver.prepare(
    "SELECT input_json, state_json FROM doctor_recommendation_state WHERE kind = 'diagnosis'",
  ).get())
  const snapshot = z.object({ caseEvidence: z.array(z.object({ label: z.string() }).loose()) }).loose().parse(JSON.parse(row.input_json))
  for (const evidence of snapshot.caseEvidence) {
    if (evidence.label.startsWith('当前病历草稿 / ')) evidence.label = evidence.label.replace('当前病历草稿 / ', `当前病历草稿 v${draft.version} / `) + ` / ${draft.updatedAt}`
  }
  const fingerprint = canonicalJsonHash(snapshot)
  const state = doctorRecommendationStateSchema.parse(JSON.parse(row.state_json))
  fixture.runtime.database.driver.prepare("UPDATE doctor_recommendation_state SET input_json = ?, input_fingerprint = ?, state_json = ? WHERE kind = 'diagnosis'")
    .run(JSON.stringify(snapshot), fingerprint, JSON.stringify({ ...state, inputFingerprint: fingerprint }))
  await fixture.saveDocument()
  await fixture.restart()
  expect(await fixture.read()).toMatchObject({ stale: false, generation: 1, status: state.status })
  await fixture.generate()
  await fixture.runtime.dispatchPending()
  expect(calls).toBe(1)
})

it('migrates unverifiable old pending input to unknown and requires an explicit new generation', async () => {
  let calls = 0
  const fixture = await setup(async input => {
    calls += 1
    return answer(input, { items: [], considerations: [], missingInformation: [] })
  })
  await fixture.claim()
  await fixture.generate()
  // Upgrade an old pending task with no verifiable snapshot or dispatch evidence.
  fixture.runtime.database.driver.prepare("UPDATE doctor_recommendation_state SET input_json = '{}' WHERE kind = 'diagnosis'").run()
  for (const table of ['continue', 'unit', 'plan', '']) fixture.runtime.database.driver.exec(
    `DROP TABLE doctor_recommendation_execution${table === '' ? '' : `_${table}`}`,
  )
  for (const table of ['model_task_step', 'model_task_wait', 'model_reply_wait']) {
    fixture.runtime.database.driver.exec(`DROP TABLE ${table}`)
  }
  for (const migration of ['0068_doctor-recommendation-execution.sql', '0070_doctor-recommendation-consolidation-stage.sql', '0073_model-task-recovery.sql']) {
    fixture.runtime.database.driver.exec(readFileSync(new URL(`../drizzle/${migration}`, import.meta.url), 'utf8'))
  }
  await fixture.restart()
  expect(await fixture.read()).toMatchObject({ status: 'failed', generation: 1, errorCode: 'MODEL_OUTCOME_UNKNOWN' })
  await fixture.generate()
  await fixture.runtime.dispatchPending()
  expect(calls).toBe(0)
  expect((await fixture.read()).generation).toBe(1)
  await fixture.generate('diagnosis', { refresh: true })
  await fixture.runtime.dispatchPending()
  expect(calls).toBe(1)
  expect(await fixture.read()).toMatchObject({ generation: 2, status: 'missing-evidence' })
})

it.each([' ', '。'])('invalidates recommendations for an exact document change (%j)', async suffix => {
  const fixture = await setup(async input => answer(input, { items: [], considerations: [], missingInformation: [] }))
  await fixture.claim()
  await fixture.saveDocument()
  await fixture.generate()
  await fixture.runtime.dispatchPending()
  const before = await fixture.read()
  await fixture.saveDocument(`头晕一周${suffix}`)
  expect(await fixture.read()).toMatchObject({ generation: 1, stale: true })
  expect((await fixture.read()).inputFingerprint).not.toBe(before.inputFingerprint)
})

it('replays the saved patient answer without another model request after completion', async () => {
  let calls = 0
  const fixture = await setup(async input => {
    expect(input.schemaName).toBe('patient_dialogue_reply')
    calls += 1
    return answer(input, { reply: '有一个礼拜了，站起来时明显。' })
  })
  const request = {
    method: 'POST', headers: fixture.headers('same-doctor-question'), body: JSON.stringify({
      expectedVersions: { [`Encounter/${fixture.started.encounterId}`]: fixture.started.encounterVersion,
        [`Task/${fixture.started.doctorTaskId}`]: '1' },
      input: { expectedConsultationVersion: 2, message: '您头晕多久了？' },
    }),
  }
  const path = `/api/his/v1/encounters/${fixture.started.encounterId}/actions/ask-consultation-question`
  const first = await fixture.runtime.app.request(path, request)
  expect(first.status).toBe(200)
  const firstBody = sendConsultationMessageResponseSchema.parse(await first.json())
  const replay = await fixture.runtime.app.request(path, request)
  expect(replay.status).toBe(200)
  expect(sendConsultationMessageResponseSchema.parse(await replay.json())).toEqual(firstBody)
  expect(calls).toBe(1)
  const detail = await fixture.readCase()
  expect(detail.consultation?.turns).toHaveLength(3)
  expect(detail.consultation?.turns.at(-1)?.id).toBe(firstBody.data.patientTurn.id)
})

function diagnosis(input: CompleteRequest) {
  const payload = z.object({ guidelines: z.array(z.object({ id: z.string() })),
    caseEvidence: z.array(z.object({ id: z.string(), text: z.string() })) }).parse(input.userPayload)
  return { items: [{ id: 'hypertension-candidate', kind: 'diagnosis', catalogItemId: 'diagnosis-hypertension', role: 'primary',
    label: '高血压', rationale: '结合已公开高血压病史核对当前血压与症状。',
    supportingInformation: ['既往高血压病史'], opposingInformation: [], missingInformation: ['当前症状病因尚待核实'],
    guidelineEvidenceIds: [payload.guidelines[0]!.id],
    caseEvidenceIds: [payload.caseEvidence.find(item => item.text.includes('高血压'))!.id],
  }], missingInformation: [] }
}

function verification(input: CompleteRequest) {
  const payload = z.object({ items: z.array(z.object({ id: z.string() })) }).parse(input.userPayload)
  return { items: payload.items.map(item => ({ id: item.id, guidelineSupported: true,
    caseSupported: true, applicable: true, qualifiersPreserved: true })) }
}

it('recovers only an interrupted verification after explicit continuation and never repeats the successful generation', async () => {
  const verificationEntered = gate()
  const calls: Array<{ schema: string; eventId: string; attempt: number }> = []
  let fixture!: Awaited<ReturnType<typeof setup>>
  fixture = await setup(async (input, signal) => {
    const event = z.object({ event_id: z.string(), attempt: z.number() }).parse(fixture.runtime.database.driver.prepare(
      "SELECT event_id, attempt FROM outbox_event WHERE status = 'claimed' AND kind LIKE '%recommendation%'",
    ).get())
    calls.push({ schema: input.schemaName, eventId: event.event_id, attempt: event.attempt })
    switch (calls.length) {
      case 2:
        verificationEntered.open()
        await new Promise<void>((_resolve, reject) => {
          if (signal == null) { reject(new Error('Missing cancellation signal')); return }
          if (signal.aborted) { reject(signal.reason); return }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    }
    return answer(input, input.schemaName === 'doctor_recommendations' ? diagnosis(input) : verification(input))
  })
  await fixture.claim()
  await fixture.generate()
  const dispatch = fixture.runtime.dispatchPending()
  await verificationEntered.promise
  expect(calls).toHaveLength(2)
  await fixture.restart()
  await dispatch
  await fixture.runtime.dispatchPending()
  expect(calls.map(call => call.schema)).toEqual(['doctor_recommendations', 'doctor_recommendation_verification'])
  expect(await fixture.read()).toMatchObject({ generation: 1, status: 'failed', errorCode: 'MODEL_OUTCOME_UNKNOWN',
    items: [], recovery: { status: 'unknown', requestCount: 2, canContinue: true } })
  await fixture.generate()
  await fixture.runtime.dispatchPending()
  expect(calls).toHaveLength(2)
  await fixture.generate('diagnosis', { continueGeneration: 1, key: 'continue-original-verification' })
  await fixture.runtime.dispatchPending()
  expect(calls.map(call => call.schema)).toEqual(['doctor_recommendations', 'doctor_recommendation_verification', 'doctor_recommendation_verification'])
  expect(await fixture.read()).toMatchObject({ generation: 1, status: 'ready', items: [{ kind: 'diagnosis' }] })
  await fixture.generate('diagnosis', { continueGeneration: 1, key: 'continue-original-verification' })
  await fixture.runtime.dispatchPending()
  expect(calls).toHaveLength(3)
})

it('shares the three-request unit limit between rate-limit resends and JSON repair, and automatic requests cannot reset it', async () => {
  let calls = 0
  const fixture = await setup(async input => {
    calls++
    return calls === 1 ? bridgeResponse(input, { error: 'MODEL_RATE_LIMIT', retryAfterMs: 1 }, 429)
      : bridgeResponse(input, { model: input.model, content: 'invalid JSON' })
  })
  await fixture.claim()
  await fixture.generate()
  await fixture.runtime.dispatchPending()
  expect(calls).toBe(3)
  expect(await fixture.read()).toMatchObject({ generation: 1, status: 'failed', errorCode: 'MODEL_REQUEST_LIMIT',
    recovery: { status: 'exhausted', requestCount: 3, extraRequestCount: 2, canContinue: false } })
  await fixture.restart()
  await fixture.generate()
  await fixture.runtime.dispatchPending()
  expect(calls).toBe(3)
  await fixture.generate('diagnosis', { refresh: true, key: 'explicit-regeneration' })
  await fixture.runtime.dispatchPending()
  expect(calls).toBe(6)
  expect(await fixture.read()).toMatchObject({ generation: 2, recovery: { requestCount: 3 } })
})

it('retries a complete technical verification failure without repeating candidate generation', async () => {
  const calls: string[] = []
  const fixture = await setup(async input => {
    calls.push(input.schemaName)
    if (calls.length === 2) return bridgeResponse(input, { error: 'MODEL_UNAVAILABLE' }, 503)
    return answer(input, input.schemaName === 'doctor_recommendations' ? diagnosis(input) : verification(input))
  })
  await fixture.claim()
  await fixture.generate()
  await fixture.runtime.dispatchPending()
  expect(calls).toEqual(['doctor_recommendations', 'doctor_recommendation_verification', 'doctor_recommendation_verification'])
  expect(await fixture.read()).toMatchObject({ generation: 1, status: 'ready', recovery: { requestCount: 3, extraRequestCount: 1 } })
})
