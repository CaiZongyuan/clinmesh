import { clinicalDocumentDraftContentSchema, clinicalDocumentDraftResponseSchema, controlConsultationRecordingResponseSchema, doctorCaseDetailSchema, reviewConsultationHistoryResponseSchema, sendConsultationMessageResponseSchema, triageQueueSchema } from '@clinmesh/contracts/his'
import { agentCapabilityGrantSchema, agentClientSchema } from '@clinmesh/contracts/agent'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { ChatCompletionsError } from '../src/infrastructure/ai/openai-chat-completions.ts'
import type { JsonChatCompletionInput, JsonChatCompletionsProvider } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })

async function setup(options: {
  failFirstReply?: boolean
  reply?: string | (() => string)
  extract?: (input: JsonChatCompletionInput) => Promise<unknown> | unknown
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-auto-record-'))
  disposals.push(() => rm(directory, { recursive: true }))
  const requests: JsonChatCompletionInput[] = []
  let replyCalls = 0
  const provider: JsonChatCompletionsProvider = {
    async completeJson(input) {
      requests.push(input)
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
      if (input.schemaName === 'patient_dialogue_reply') {
        if (options.failFirstReply && replyCalls++ === 0) throw new Error('Synthetic reply failure')
        return { content: JSON.stringify({ reply: typeof options.reply === 'function' ? options.reply() : options.reply ?? '头晕一周了，站起来时更明显。' }), model: 'synthetic' }
      }
      if (options.extract !== undefined) return { content: JSON.stringify(await options.extract(input)), model: 'synthetic' }
      const payload = input.userPayload as { turns: Array<{ id: string; speaker: string; messageText: string }> }
      const answer = payload.turns.findLast(turn => turn.speaker === 'patient')!
      return { content: JSON.stringify({ additions: [{
        field: 'historyOfPresentIllness', sourceTurnId: answer.id,
        quote: '头晕一周了，站起来时更明显。', relation: 'addition',
      }] }), model: 'synthetic' }
    },
  }
  const createRuntime = () => createClinMeshRuntime({
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters',
    chatCompletionsProvider: provider, databasePath: join(directory, 'clinmesh.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply', outboxRetryDelayMs: 0,
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    syntheaProvider: new StubSyntheaProvider(), trustedOrigins: ['http://localhost'],
  })
  let runtime = await createRuntime()
  disposals.push(() => runtime.close())
  const started = await startConsultationCase(runtime)
  const cookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const read = async () => doctorCaseDetailSchema.parse(await (await runtime.app.request(
    `/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } },
  )).json())
  const key = randomUUID()
  const ask = (actorHeaders: Record<string, string> = { cookie }) => runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/ask-consultation-question`, {
    method: 'POST', headers: { ...actorHeaders, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ expectedVersions: {
      [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1',
    }, input: { expectedConsultationVersion: 2, message: '头晕多久了？有没有胸痛？' } }),
  })
  const askMore = async () => {
    const detail = await read()
    return runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/ask-consultation-question`, {
      method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${started.encounterId}`]: detail.encounter.versionId,
        [`Task/${detail.taskId}`]: detail.taskVersion }, input: { expectedConsultationVersion: detail.consultation!.version, message: '再确认一下病史？' } }),
    })
  }
  const save = async (history: string) => {
    const detail = await read()
    const draft = detail.clinicalDocument?.draft ?? { assessment: '', chiefComplaint: '', disposition: '', followUp: '',
      physicalExamination: '', historyOfPresentIllness: '' }
    const document = clinicalDocumentDraftContentSchema.parse(Object.fromEntries(
      Object.keys(clinicalDocumentDraftContentSchema.shape).map(field => [field, draft[field as keyof typeof draft]]).filter(([, value]) => value !== undefined),
    ))
    const response = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`, {
      method: 'PUT', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${started.encounterId}`]: detail.encounter.versionId },
        input: { expectedDraftVersion: detail.clinicalDocument?.draft?.version ?? 0, document: { ...document, historyOfPresentIllness: history } } }),
    })
    if (response.status === 200) clinicalDocumentDraftResponseSchema.parse(await response.clone().json())
    return response
  }
  const control = async (action: 'pause' | 'resume' | 'backfill' | 'retry', options: { key?: string; version?: number; headers?: Record<string, string> } = {}) => {
    const detail = await read()
    return runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/consultation-recording/actions/control`, {
      method: 'POST', headers: { ...(options.headers ?? { cookie }), origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': options.key ?? randomUUID() },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${started.encounterId}`]: detail.encounter.versionId },
        input: { action, expectedRecordingVersion: options.version ?? detail.consultationRecording?.version ?? 0 } }),
    })
  }
  return { get runtime() { return runtime }, read, ask, askMore, requests, started, cookie, save, control,
    restart: async () => { await runtime.close(); runtime = await createRuntime() } }
}

it('persists pause while saving replies, then resumes in order without duplicating processed answers or losing manual edits', async () => {
  let reply = '头晕一周了。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const turns = (input.userPayload as { turns: Array<{ id: string; messageText: string }> }).turns
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: turns.at(-1)!.id, quote: turns.at(-1)!.messageText, relation: 'addition' }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect((await fixture.save('医生核对：头晕五天。')).status).toBe(200)
  const key = randomUUID()
  const paused = await fixture.control('pause', { key, version: 1 })
  expect(paused.status).toBe(200)
  const receipt = controlConsultationRecordingResponseSchema.parse(await paused.json())
  expect(receipt.data).toMatchObject({ version: 2, status: 'paused', processedCount: 1, remainingCount: 0 })
  reply = '站起来时更明显。'
  expect((await fixture.askMore()).status).toBe(200)
  reply = '夜间也会头晕。'
  expect((await fixture.askMore()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.restart()
  expect(await fixture.read()).toMatchObject({ clinicalDocument: { draft: { historyOfPresentIllness: '医生核对：头晕五天。' } },
    consultationRecording: { status: 'paused', paused: true, processedCount: 1, remainingCount: 2 } })
  expect((await fixture.control('resume', { version: 1 })).status).toBe(409)
  const replay = await fixture.control('pause', { key, version: 1 })
  expect(controlConsultationRecordingResponseSchema.parse(await replay.json())).toEqual(receipt)
  expect((await fixture.control('resume')).status).toBe(200)
  await fixture.restart()
  await fixture.runtime.dispatchPending()
  const final = await fixture.read()
  expect(final.clinicalDocument?.draft?.historyOfPresentIllness).toBe('医生核对：头晕五天。\n患者自述：站起来时更明显。\n患者自述：夜间也会头晕。')
  expect(final.consultationRecording).toMatchObject({ status: 'updated', version: 3, processedCount: 3, remainingCount: 0,
    additions: [{ ownership: 'manual' }, { ownership: 'automatic' }, { ownership: 'automatic' }] })
  expect(fixture.requests.filter(input => input.schemaName === 'consultation_history_increment')).toHaveLength(3)
  expect(fixture.runtime.database.driver.prepare("SELECT count(*) AS count FROM audit_log WHERE operation = 'consultation.recording.control' AND outcome = 'success'").get()).toMatchObject({ count: 2 })
})

it('offers historical backfill without changing a manual draft on read or restart', async () => {
  const fixture = await setup({ extract: input => {
    const turns = (input.userPayload as { turns: Array<{ id: string; messageText: string }> }).turns
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: turns.at(-1)!.id, quote: turns.at(-1)!.messageText, relation: 'addition' }] }
  } })
  // 模拟迁移前已有 Consultation：迁移不会为这些病例登记自动资格。
  fixture.runtime.database.driver.prepare('DELETE FROM consultation_recording').run()
  expect((await fixture.ask()).status).toBe(200)
  expect((await fixture.save('医生手工核对的病史。')).status).toBe(200)
  await fixture.restart()
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ clinicalDocument: { draft: { version: 1, historyOfPresentIllness: '医生手工核对的病史。' } },
    consultationRecording: { version: 0, status: 'backfill', remainingCount: 2 } })
  expect(fixture.requests.filter(input => input.schemaName === 'consultation_history_increment')).toHaveLength(0)
  const key = randomUUID()
  const response = await fixture.control('backfill', { key, version: 0 })
  expect(response.status).toBe(200)
  const receipt = controlConsultationRecordingResponseSchema.parse(await response.json())
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(`医生手工核对的病史。\n患者自述：${persona.openingStatement}\n患者自述：头晕一周了，站起来时更明显。`)
  const replay = await fixture.control('backfill', { key, version: 0 })
  expect(controlConsultationRecordingResponseSchema.parse(await replay.json())).toEqual(receipt)
  expect((await fixture.control('backfill')).status).toBe(409)
  expect(fixture.requests.filter(input => input.schemaName === 'consultation_history_increment')).toHaveLength(2)
})

it('retries a failed head before later replies and persists real progress across restart', async () => {
  let fail = true
  let reply = '头晕一周了。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    if (fail) throw new Error('Synthetic disconnect')
    const turns = (input.userPayload as { turns: Array<{ id: string; messageText: string }> }).turns
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: turns.at(-1)!.id, quote: turns.at(-1)!.messageText, relation: 'addition' }] }
  } })
  await fixture.ask()
  reply = '夜间也会头晕。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.restart()
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'failed', failedCount: 1, processedCount: 0, remainingCount: 2 })
  fail = false
  expect((await fixture.control('retry')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ clinicalDocument: { draft: { historyOfPresentIllness: '患者自述：头晕一周了。\n患者自述：夜间也会头晕。' } },
    consultationRecording: { status: 'updated', failedCount: 0, processedCount: 2, remainingCount: 0 } })
  expect((await fixture.control('retry')).status).toBe(409)
})

it.each([
  [false, false], [true, false], [false, true], [true, true],
] as const)('discards an in-flight result after pause with early resume %s and timeout %s', async (resumeFirst, timeout) => {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const fixture = await setup({ extract: async input => {
    if (calls++ === 0) {
      enter(); await held
      if (timeout) throw new ChatCompletionsError('AI_TIMEOUT', 'Synthetic late timeout')
    }
    const turns = (input.userPayload as { turns: Array<{ id: string; messageText: string }> }).turns
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: turns.at(-1)!.id, quote: turns.at(-1)!.messageText, relation: 'addition' }] }
  } })
  await fixture.ask()
  const dispatch = fixture.runtime.dispatchPending()
  await entered
  try {
    expect((await fixture.control('pause')).status).toBe(200)
    if (resumeFirst) expect((await fixture.control('resume')).status).toBe(200)
  } finally { release(); await dispatch }
  if (!resumeFirst) {
    expect((await fixture.read()).clinicalDocument?.draft).toBeUndefined()
    expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'paused', processedCount: 0, remainingCount: 1 })
    expect((await fixture.control('resume')).status).toBe(200)
    await fixture.runtime.dispatchPending()
  }
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'updated', processedCount: 1, remainingCount: 0 })
  expect((await fixture.read()).clinicalDocument?.draft?.version).toBe(1)
  expect(calls).toBe(2)
})

it('protects an edited sentence while appending unrelated history in the same field', async () => {
  let reply = '头晕一周了。'
  const { runtime, read, ask, askMore, save } = await setup({ reply: () => reply, extract: input => {
    const turns = (input.userPayload as { turns: Array<{ id: string; messageText: string }> }).turns
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: turns.at(-1)!.id,
      quote: turns.at(-1)!.messageText, relation: 'addition' }] }
  } })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  expect((await save('医生核对：头晕五天。')).status).toBe(200)
  reply = '站起来时更明显。'
  expect((await askMore()).status).toBe(200)
  await runtime.dispatchPending()
  expect(await read()).toMatchObject({ clinicalDocument: { draft: {
    historyOfPresentIllness: '医生核对：头晕五天。\n患者自述：站起来时更明显。',
  } }, consultationRecording: { status: 'updated', additions: [
    { ownership: 'manual', currentText: '医生核对：头晕五天。' }, { ownership: 'automatic', status: 'applied' },
  ] } })
})

it('replaces only the untouched automatic fragment after an explicit patient correction', async () => {
  let reply = '头晕一周了。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string; messageText: string }>; history: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
      quote: payload.turns.at(-1)!.messageText, relation: payload.history.length ? 'correction' : 'addition',
      ...(payload.history[0] === undefined ? {} : { targetAdditionId: payload.history[0].id }) }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  reply = '刚才说错了，头晕是五天。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ clinicalDocument: { draft: {
    historyOfPresentIllness: '患者自述：刚才说错了，头晕是五天。', version: 2,
  } }, consultationRecording: { status: 'updated', additions: [{ status: 'superseded' }, { status: 'applied', ownership: 'automatic' }] } })
})

it('keeps a new explicit correction when a superseded correction used the same quote', async () => {
  let reply = '头晕一周了。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string; messageText: string }>; history: Array<{ id: string }> }
    const addition = { field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
      quote: payload.turns.at(-1)!.messageText, relation: payload.history.length ? 'correction' : 'addition',
      ...(payload.history[0] === undefined ? {} : { targetAdditionId: payload.history[0].id }) }
    return { additions: [addition, addition] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  for (const correction of ['刚才说错了，头晕是五天。', '刚才说错了，头晕是六天。', '刚才说错了，头晕是五天。']) {
    reply = correction
    expect((await fixture.askMore()).status).toBe(200)
    await fixture.runtime.dispatchPending()
  }
  await fixture.restart()
  const final = await fixture.read()
  expect(final.clinicalDocument?.draft).toMatchObject({
    historyOfPresentIllness: '患者自述：刚才说错了，头晕是五天。', version: 4,
  })
  expect(final.consultationRecording).toMatchObject({ status: 'updated', additions: [
    { status: 'superseded' }, { status: 'superseded' }, { status: 'superseded' },
    { status: 'applied', ownership: 'automatic', sourceTurnId: final.consultation?.turns.at(-1)?.id },
  ] })
  expect(final.consultationRecording?.additions).toHaveLength(4)
})

it.each(['accept', 'ignore'] as const)('requires a current-version %s decision before changing manually edited history', async decision => {
  let reply = '头晕一周了。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string; messageText: string }>; history: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
      quote: payload.turns.at(-1)!.messageText, relation: payload.history.length ? 'correction' : 'addition',
      ...(payload.history[0] === undefined ? {} : { targetAdditionId: payload.history[0].id }) }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  expect((await fixture.save('医生核对：头晕六天。')).status).toBe(200)
  await fixture.restart()
  reply = '刚才记错了，头晕是五天。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  const detail = await fixture.read()
  expect(detail).toMatchObject({ clinicalDocument: { draft: { historyOfPresentIllness: '医生核对：头晕六天。' } },
    consultationRecording: { status: 'pending', additions: [{ ownership: 'manual' }, { status: 'pending', currentText: '医生核对：头晕六天。' }] } })
  const additionId = detail.consultationRecording!.additions.at(-1)!.id
  const key = randomUUID()
  const review = (expectedDraftVersion: number, idempotencyKey = key) => fixture.runtime.app.request(
    `/api/his/v1/encounters/${fixture.started.encounterId}/consultation-history/actions/review`, {
      method: 'POST', headers: { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${fixture.started.encounterId}`]: detail.encounter.versionId },
        input: { additionId, decision, expectedDraftVersion } }),
    })
  expect((await review(0, randomUUID())).status).toBe(409)
  const accepted = await review(detail.clinicalDocument!.draft!.version)
  expect(accepted.status).toBe(200)
  const receipt = reviewConsultationHistoryResponseSchema.parse(await accepted.json())
  expect(receipt.data.draftVersion).toBe(detail.clinicalDocument!.draft!.version + (decision === 'accept' ? 1 : 0))
  const after = await fixture.read()
  expect(after.clinicalDocument?.draft?.historyOfPresentIllness).toBe(decision === 'accept'
    ? '患者自述：刚才记错了，头晕是五天。' : '医生核对：头晕六天。')
  expect(after.consultationRecording?.additions.at(-1)?.status).toBe(decision === 'accept' ? 'applied' : 'ignored')
  const replay = await review(detail.clinicalDocument!.draft!.version)
  expect(replay.status).toBe(200)
  expect(reviewConsultationHistoryResponseSchema.parse(await replay.json())).toEqual(receipt)
  expect((await fixture.read()).clinicalDocument?.draft?.version).toBe(after.clinicalDocument?.draft?.version)
})

it('protects separated manual edits but allows a correction between them in the same field', async () => {
  let reply = '头晕一周了。站起来时更明显。夜间也会头晕。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string; messageText: string }>; history: Array<{ id: string; quote: string }> }
    const sourceTurnId = payload.turns.at(-1)!.id
    return { additions: payload.history.length === 0 ? reply.match(/[^。]+。/g)!.map(quote => ({
      field: 'historyOfPresentIllness', sourceTurnId, quote, relation: 'addition',
    })) : [{ field: 'historyOfPresentIllness', sourceTurnId, quote: reply, relation: 'correction',
      targetAdditionId: payload.history.find(item => item.quote === '站起来时更明显。')!.id }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.save('医生核对：头晕五天。\n患者自述：站起来时更明显。\n医生核对：白天也会头晕。')
  reply = '刚才说错了，站起来时不明显。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ clinicalDocument: { draft: {
    historyOfPresentIllness: '医生核对：头晕五天。\n患者自述：刚才说错了，站起来时不明显。\n医生核对：白天也会头晕。',
  } }, consultationRecording: { additions: [{ ownership: 'manual' }, { status: 'superseded' },
    { ownership: 'manual' }, { status: 'applied', ownership: 'automatic' }] } })
})

it('protects only the edited sentence when the model groups several statements in one addition', async () => {
  let reply = '头晕一周了。夜间也会头晕。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }>; history: Array<{ id: string; quote: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
      quote: reply, relation: payload.history.length ? 'correction' : 'addition',
      ...(payload.history.length ? { targetAdditionId: payload.history.at(-1)!.id } : {}) }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  const original = (await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness
  expect((await fixture.save(original.replace('头晕一周了', '头晕五天了'))).status).toBe(200)
  reply = '刚才说错了，夜间没有头晕。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ clinicalDocument: { draft: {
    historyOfPresentIllness: '患者自述：头晕五天了。\n患者自述：刚才说错了，夜间没有头晕。',
  } }, consultationRecording: { status: 'updated', additions: [
    { quote: '头晕一周了。', ownership: 'manual' },
    { quote: '夜间也会头晕。', status: 'superseded' },
    { status: 'applied', ownership: 'automatic' },
  ] } })
})

it.each(['correction', 'conflict'] as const)('retries a %s without a target instead of creating an unusable review', async relation => {
  let reply = '头晕一周了。'
  let missingTarget = true
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }>; history: Array<{ id: string }> }
    const includeTarget = !missingTarget
    if (payload.history.length) missingTarget = false
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
      quote: reply, relation: payload.history.length ? relation : 'addition',
      ...(includeTarget && payload.history.length ? { targetAdditionId: payload.history[0]!.id } : {}) }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  reply = '刚才说错了，头晕是五天。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).consultationRecording?.additions).toHaveLength(2)
  expect((await fixture.read()).consultationRecording?.additions.at(-1)).toMatchObject({
    relation, status: relation === 'correction' ? 'applied' : 'pending',
    ...(relation === 'conflict' ? { reviewable: true } : {}),
  })
})

it('retains manual ownership when an unanchored legacy fragment is restored and the service restarts', async () => {
  let reply = '头晕一周了。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }>; history: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
      quote: reply, relation: payload.history.length ? 'correction' : 'addition',
      ...(payload.history.length ? { targetAdditionId: payload.history[0]!.id } : {}) }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.save('医生核对：头晕六天。')
  // Seed the migrated representation of an already edited pre-ownership record.
  fixture.runtime.database.driver.prepare(`UPDATE consultation_history_addition SET ownership = 'automatic',
    start_offset = NULL, end_offset = NULL, current_text = '' WHERE case_id = ?`).run(fixture.started.outpatientCaseId)
  await fixture.save('患者自述：头晕一周了。')
  await fixture.restart()
  reply = '刚才说错了，头晕是五天。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ clinicalDocument: { draft: {
    historyOfPresentIllness: '患者自述：头晕一周了。',
  } }, consultationRecording: { status: 'pending', additions: [
    { ownership: 'manual' }, { status: 'pending', reviewable: true },
  ] } })
})

it('retries invalid sentence fragments before writing an unreadable case', async () => {
  let grouped = true
  const fixture = await setup({ reply: '头晕一周了。嗯', extract: input => {
    const quote = grouped ? '头晕一周了。嗯' : '头晕一周了。'
    grouped = false
    return { additions: [{ field: 'historyOfPresentIllness',
      sourceTurnId: (input.userPayload as { turns: Array<{ id: string }> }).turns.at(-1)!.id,
      quote, relation: 'addition' }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ clinicalDocument: { draft: {
    historyOfPresentIllness: '患者自述：头晕一周了。', version: 1,
  } }, consultationRecording: { status: 'updated', additions: [{ quote: '头晕一周了。' }] } })
})

it.each(['automatic', 'manual'] as const)('preserves %s unrelated sentences when correcting a multi-statement legacy increment', async ownership => {
  let reply = '头晕一周了。夜间也会头晕。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }>; history: Array<{ id: string; quote: string }> }
    const target = payload.history.find(item => item.quote === '夜间也会头晕。') ?? payload.history[0]
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
      quote: reply, relation: target ? 'correction' : 'addition',
      ...(target ? { targetAdditionId: target.id } : {}) }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  const originalId = (await fixture.read()).consultationRecording!.additions[0]!.id
  await fixture.save('患者自述：头晕一周了。夜间也会头晕。')
  // Seed the original single-row representation before ownership/statement ranges existed.
  fixture.runtime.database.driver.prepare('DELETE FROM consultation_history_addition WHERE case_id = ? AND addition_id != ?')
    .run(fixture.started.outpatientCaseId, originalId)
  fixture.runtime.database.driver.prepare(`UPDATE consultation_history_addition SET quote = ?, ownership = 'automatic',
    start_offset = NULL, end_offset = NULL, current_text = '' WHERE addition_id = ?`).run(reply, originalId)
  await fixture.restart()
  if (ownership === 'manual') await fixture.save('患者自述：头晕五天了。夜间也会头晕。')
  reply = '刚才说错了，夜间没有头晕。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness)
    .toBe(ownership === 'manual' ? '患者自述：头晕五天了。患者自述：刚才说错了，夜间没有头晕。'
      : '患者自述：头晕一周了。患者自述：刚才说错了，夜间没有头晕。')
  expect((await fixture.read()).consultationRecording?.status).toBe('updated')
})

it('keeps ambiguous contradictory history pending even when its target is automatic', async () => {
  let reply = '头晕一周了。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string; messageText: string }>; history: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
      quote: payload.turns.at(-1)!.messageText, relation: payload.history.length ? 'conflict' : 'addition',
      ...(payload.history[0] === undefined ? {} : { targetAdditionId: payload.history[0].id }) }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  reply = '头晕五天了。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ clinicalDocument: { draft: { historyOfPresentIllness: '患者自述：头晕一周了。', version: 1 } },
    consultationRecording: { status: 'pending', additions: [{ status: 'applied' }, { status: 'pending', currentText: '患者自述：头晕一周了。' }] } })
})

async function createDoctorGrant(runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>, adminCookie: string,
  operationId: 'encounter.consultation.ask' | 'encounter.consultation.reply.retry' | 'encounter.consultation-recording.control') {
  const adminHeaders = { cookie: adminCookie, origin: 'http://localhost', 'content-type': 'application/json' }
  const clientResponse = await runtime.app.request('/api/agent/v1/clients', {
    method: 'POST', headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ name: 'Synthetic consultation recorder' }),
  })
  expect(clientResponse.status).toBe(200)
  const client = agentClientSchema.parse(await clientResponse.json())
  const grantResponse = await runtime.app.request('/api/agent/v1/grants', {
    method: 'POST', headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ agentClientId: client.agentClientId, operationIds: [operationId],
      practitionerRoleId: 'practitioner-role-outpatient-doctor', ttlSeconds: 3600 }),
  })
  expect(grantResponse.status).toBe(200)
  return { adminHeaders, client, grant: agentCapabilityGrantSchema.parse(await grantResponse.json()) }
}

it.each(['active', 'revoke'] as const)('resumes with a control-only Agent Grant and respects its exact identity while %s', async action => {
  const fixture = await setup()
  expect((await fixture.ask()).status).toBe(200)
  expect((await fixture.control('pause')).status).toBe(200)
  expect((await fixture.askMore()).status).toBe(200)
  const { adminHeaders, client, grant } = await createDoctorGrant(fixture.runtime, fixture.started.adminCookie,
    'encounter.consultation-recording.control')
  expect((await fixture.control('resume', { headers: { authorization: `Bearer ${grant.token}` } })).status).toBe(200)
  if (action === 'revoke') {
    expect((await fixture.runtime.app.request(`/api/agent/v1/grants/${grant.grantId}/actions/revoke`, {
      method: 'POST', body: '{}', headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
    })).status).toBe(200)
    // 同一 Client 的另一有效授权不能让旧恢复意图继续写入。
    const replacement = await fixture.runtime.app.request('/api/agent/v1/grants', {
      method: 'POST', headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ agentClientId: client.agentClientId, operationIds: ['encounter.consultation-recording.control'],
        practitionerRoleId: 'practitioner-role-outpatient-doctor', ttlSeconds: 3600 }),
    })
    expect(replacement.status).toBe(200)
    expect(agentCapabilityGrantSchema.parse(await replacement.json()).grantId).not.toBe(grant.grantId)
  }
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).consultationRecording?.status).toBe(action === 'active' ? 'updated' : 'failed')
  expect((await fixture.read()).clinicalDocument?.draft === undefined).toBe(action !== 'active')
})

it.each(['active', 'disable', 'revoke'] as const)('records a saved reply with a retry-only Agent Grant only while it is %s', async action => {
  const { runtime, ask, read, started } = await setup({ failFirstReply: true })
  expect((await ask()).status).toBe(503)
  const pending = await read()
  expect(pending.consultation!.turns.at(-1)!.speaker).toBe('doctor')
  const { adminHeaders, client, grant } = await createDoctorGrant(runtime, started.adminCookie,
    'encounter.consultation.reply.retry')
  const response = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/retry-consultation-reply`, {
    method: 'POST', headers: { authorization: `Bearer ${grant.token}`, origin: 'http://localhost',
      'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: {}, input: { expectedConsultationVersion: pending.consultation!.version } }),
  })
  expect(response.status).toBe(200)
  expect((await read()).consultation!.turns.at(-1)!.speaker).toBe('patient')
  if (action !== 'active') {
    const path = action === 'disable' ? `/api/agent/v1/clients/${client.agentClientId}/actions/disable`
      : `/api/agent/v1/grants/${grant.grantId}/actions/revoke`
    expect((await runtime.app.request(path, { method: 'POST', body: '{}',
      headers: { ...adminHeaders, 'idempotency-key': randomUUID() } })).status).toBe(200)
  }
  await runtime.dispatchPending()
  const detail = await read()
  expect(detail.consultationRecording?.status).toBe(action === 'active' ? 'updated' : 'failed')
  if (action === 'active') {
    expect(detail.clinicalDocument?.draft?.historyOfPresentIllness).toBe('患者自述：头晕一周了，站起来时更明显。')
  } else {
    expect(detail.clinicalDocument?.draft).toBeUndefined()
    expect(detail.consultationRecording?.additions).toEqual([])
  }
})

it('records saved patient history asynchronously through the public consultation and case interfaces', async () => {
  const { runtime, read, ask, requests } = await setup()
  const response = await ask()
  expect(response.status).toBe(200)
  const asked = sendConsultationMessageResponseSchema.parse(await response.json())
  expect(asked.data.patientTurn.messageText).toBe('头晕一周了，站起来时更明显。')
  expect(await read()).toMatchObject({ consultationRecording: { status: 'processing' } })
  await runtime.dispatchPending()
  const detail = await read()
  expect(detail).toMatchObject({
    clinicalDocument: { draft: { historyOfPresentIllness: '患者自述：头晕一周了，站起来时更明显。', assessment: '', physicalExamination: '' } },
    consultationRecording: { status: 'updated', additions: [{ sourceTurnId: asked.data.patientTurn.id, status: 'applied' }] },
  })
  const extraction = requests.find(request => request.schemaName === 'consultation_history_increment')!
  expect(extraction.userPayload).toEqual({ turns: expect.any(Array), history: [] })
  expect(JSON.stringify(extraction.userPayload)).not.toMatch(/hiddenResources|Case Truth|persona|knownConditions|2型糖尿病/)
  const duplicate = await ask()
  expect(duplicate.status).toBe(200)
  await runtime.dispatchPending()
  expect((await read()).clinicalDocument?.draft?.version).toBe(detail.clinicalDocument?.draft?.version)
})

it.each(['AI_TIMEOUT', 'AI_AUTH_FAILED', 'AI_RESPONSE_INVALID'] as const)(
  'settles %s recording failures across restart and allows explicit retry without losing the reply', async code => {
    let fail = true
    const fixture = await setup({ extract: input => {
      if (fail) throw new ChatCompletionsError(code, 'private-provider-credential-and-prompt')
      const turns = (input.userPayload as { turns: Array<{ id: string; messageText: string }> }).turns
      return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: turns.at(-1)!.id,
        quote: turns.at(-1)!.messageText, relation: 'addition' }] }
    } })
    expect((await fixture.ask()).status).toBe(200)
    await fixture.runtime.dispatchPending()
    const detail = await fixture.read()
    expect(detail.clinicalDocument?.draft).toBeUndefined()
    expect(detail.consultationRecording).toMatchObject({ status: 'failed', failedCount: 1, remainingCount: 1, additions: [],
      failures: [{ sourceTurnId: detail.consultation?.turns.at(-1)?.id, code, retrying: false }] })
    expect(detail.consultation?.turns).toHaveLength(3)
    expect(JSON.stringify(detail)).not.toContain('private-provider-credential-and-prompt')
    expect(fixture.requests.filter(request => request.schemaName === 'consultation_history_increment')).toHaveLength(1)
    await fixture.restart()
    await fixture.runtime.dispatchPending()
    expect((await fixture.read()).consultationRecording).toEqual(detail.consultationRecording)
    expect(fixture.requests.filter(request => request.schemaName === 'consultation_history_increment')).toHaveLength(1)
    fail = false
    const retried = await fixture.control('retry')
    expect(retried.status).toBe(200)
    expect(controlConsultationRecordingResponseSchema.parse(await retried.json()).data).toMatchObject({
      status: 'processing', failedCount: 0, failures: [], remainingCount: 1,
    })
    await fixture.runtime.dispatchPending()
    expect((await fixture.read()).consultationRecording).toMatchObject({
      status: 'updated', failedCount: 0, failures: [], processedCount: 1, remainingCount: 0,
    })
    expect(fixture.requests.filter(request => request.schemaName === 'consultation_history_increment')).toHaveLength(2)
  },
)

it('exposes transient failure while retrying and clears it after a validated update', async () => {
  let failed = false
  const fixture = await setup({ extract: input => {
    if (!failed) { failed = true; throw new ChatCompletionsError('AI_REQUEST_FAILED', 'private-network-error') }
    const turns = (input.userPayload as { turns: Array<{ id: string }> }).turns
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: turns.at(-1)!.id,
      quote: '头晕一周了，站起来时更明显。', relation: 'addition' }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatcher.dispatchOnce()
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'processing',
    failures: [{ code: 'AI_REQUEST_FAILED', retrying: true }] })
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'updated', failures: [] })
})

it.each([0, 2])('settles an extraction cancelled by Server shutdown after %s earlier failures', async earlierFailures => {
  let entered!: () => void
  const extracting = new Promise<void>(resolve => { entered = resolve })
  let cancelled = false
  let calls = 0
  const fixture = await setup({ extract: async input => {
    if (calls++ < earlierFailures) throw new ChatCompletionsError('AI_REQUEST_FAILED', 'Synthetic transient failure')
    if (!cancelled) {
      entered()
      await new Promise<void>((_resolve, reject) => input.signal!.addEventListener('abort', () => {
        cancelled = true
        reject(new ChatCompletionsError('AI_TIMEOUT', 'Synthetic shutdown'))
      }, { once: true }))
    }
    const turns = (input.userPayload as { turns: Array<{ id: string }> }).turns
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: turns.at(-1)!.id,
      quote: '头晕一周了，站起来时更明显。', relation: 'addition' }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  const processing = fixture.runtime.dispatchPending()
  await extracting
  await fixture.restart()
  await processing
  if (earlierFailures === 2) {
    expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'failed',
      failures: [{ code: 'CONSULTATION_RECORDING_FAILED', retrying: false }] })
    await fixture.runtime.dispatchPending()
    expect((await fixture.read()).clinicalDocument?.draft).toBeUndefined()
    expect(calls).toBe(3)
    return
  }
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'processing', failures: [] })
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'updated', failures: [] })
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe('患者自述：头晕一周了，站起来时更明显。')
})

it('rejects a quote that removes the patient negation instead of recording chest pain', async () => {
  const { runtime, ask, read } = await setup({ reply: '没有胸痛。', extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', quote: '胸痛',
      sourceTurnId: payload.turns.at(-1)!.id, relation: 'addition' }] }
  } })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  const detail = await read()
  expect(detail.clinicalDocument?.draft).toBeUndefined()
  expect(detail.consultationRecording).toMatchObject({ status: 'failed', additions: [] })
})

it.each([
  ['胸痛已经三天了吗？', '胸痛已经三天了吗'],
  ['胸痛已经三天?', '胸痛已经三天'],
  ['胸痛已经三天！？', '胸痛已经三天'],
  ['胸痛已经三天！ ？', '胸痛已经三天'],
  ['胸痛已经三天 \t？', '胸痛已经三天'],
])('rejects a quote that removes the question mark from %s', async (reply, quote) => {
  const { runtime, ask, read } = await setup({ reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', quote,
      sourceTurnId: payload.turns.at(-1)!.id, relation: 'addition' }] }
  } })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  const detail = await read()
  expect(detail.clinicalDocument?.draft).toBeUndefined()
  expect(detail.consultationRecording).toMatchObject({ status: 'failed', additions: [] })
  expect(detail.consultation?.turns.at(-1)?.messageText).toBe(reply)
})

it.each([' ', '\t', '\u00a0', '\n'])('records a complete statement after sentence whitespace %j', async whitespace => {
  const quote = '站起来时更明显。'
  const { runtime, ask, read } = await setup({ reply: `头晕一周了。${whitespace}${quote}`, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', quote,
      sourceTurnId: payload.turns.at(-1)!.id, relation: 'addition' }] }
  } })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  expect(await read()).toMatchObject({
    clinicalDocument: { draft: { historyOfPresentIllness: `患者自述：${quote}` } },
    consultationRecording: { status: 'updated', additions: [{ quote, status: 'applied' }] },
  })
})

it('rejects a quote that drops uncertainty from the same patient sentence', async () => {
  const { runtime, ask, read } = await setup({ reply: '我不清楚，胸痛已经三天。', extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', quote: '胸痛已经三天。',
      sourceTurnId: payload.turns.at(-1)!.id, relation: 'addition' }] }
  } })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  expect((await read()).clinicalDocument?.draft).toBeUndefined()
  expect((await read()).consultationRecording).toMatchObject({ status: 'failed', additions: [] })
})

it.each([
  ['我不清楚 胸痛已经三天。', '胸痛已经三天。'],
  ['胸痛已经三天 我不清楚。', '胸痛已经三天'],
])('rejects whitespace clipping that removes uncertainty from %s', async (reply, quote) => {
  const { runtime, ask, read } = await setup({ reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', quote,
      sourceTurnId: payload.turns.at(-1)!.id, relation: 'addition' }] }
  } })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  expect((await read()).clinicalDocument?.draft).toBeUndefined()
  expect((await read()).consultationRecording).toMatchObject({ status: 'failed', additions: [] })
})

it.each([
  ['我不清楚，血糖是5.8mmol/L。', '8mmol/L。'],
  ['头晕3.5天。', '头晕3.'],
])('rejects an extraction that splits a decimal in %s', async (reply, quote) => {
  const { runtime, ask, read } = await setup({ reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', quote,
      sourceTurnId: payload.turns.at(-1)!.id, relation: 'addition' }] }
  } })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  expect((await read()).clinicalDocument?.draft).toBeUndefined()
  expect((await read()).consultationRecording).toMatchObject({ status: 'failed', additions: [] })
})

it('applies a repeated model addition once without exhausting durable retries', async () => {
  const { runtime, ask, read } = await setup({ extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }> }
    const addition = { field: 'historyOfPresentIllness', quote: '头晕一周了，站起来时更明显。',
      sourceTurnId: payload.turns.at(-1)!.id, relation: 'addition' }
    return { additions: [addition, addition] }
  } })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  expect((await read()).clinicalDocument?.draft).toMatchObject({
    historyOfPresentIllness: '患者自述：头晕一周了，站起来时更明显。', version: 1,
  })
  expect((await read()).consultationRecording).toMatchObject({ status: 'updated', additions: [{ status: 'applied' }] })
  expect((await read()).consultationRecording?.additions).toHaveLength(1)
})

it.each([
  ['doctor question', (turns: Array<{ id: string }>) => ({ sourceTurnId: turns[1]!.id, quote: '头晕多久了？' })],
  ['unasked negative', (turns: Array<{ id: string }>) => ({ sourceTurnId: turns.at(-1)!.id, quote: '没有胸痛。' })],
  ['fabricated source', () => ({ sourceTurnId: 'different-patient-turn', quote: '头晕一周了，站起来时更明显。' })],
  ['unknown answer', (turns: Array<{ id: string }>) => ({ sourceTurnId: turns.at(-1)!.id, quote: '我不知道。' })],
] as const)('keeps the reply and rejects %s in extracted history', async (name, candidate) => {
  const { runtime, ask, read } = await setup({
    ...(name === 'unknown answer' ? { reply: '我不知道。' } : {}),
    extract: input => ({ additions: [{ field: 'historyOfPresentIllness', relation: 'addition',
      ...candidate((input.userPayload as { turns: Array<{ id: string }> }).turns) }] }),
  })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  expect((await read()).clinicalDocument?.draft).toBeUndefined()
  expect((await read()).consultationRecording).toMatchObject({ status: 'failed', additions: [] })
  expect((await read()).consultation?.turns).toHaveLength(3)
})

it('saves an incomplete draft while preserving required fields for signing', async () => {
  const { ask, read, runtime, started, cookie } = await setup()
  await ask()
  await runtime.dispatchPending()
  const detail = await read()
  expect(detail.consultationRecording?.hasSavedDraft).toBe(false)
  const headers = { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }
  const saved = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`, {
    method: 'PUT', headers, body: JSON.stringify({
      expectedVersions: { [`Encounter/${started.encounterId}`]: detail.encounter.versionId },
      input: { expectedDraftVersion: detail.clinicalDocument!.draft!.version, document: {
        assessment: '', chiefComplaint: '头晕一周', disposition: '', followUp: '',
        physicalExamination: '', historyOfPresentIllness: '患者自述：头晕一周了，站起来时更明显。',
      } },
    }),
  })
  expect(saved.status).toBe(200)
  const latest = await read()
  expect(latest.consultationRecording?.hasSavedDraft).toBe(true)
  const preview = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/clinical-document/actions/preview-sign`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() }, body: JSON.stringify({
      expectedVersions: { [`Encounter/${started.encounterId}`]: latest.encounter.versionId },
      input: { expectedDraftVersion: latest.clinicalDocument!.draft!.version },
    }),
  })
  expect(preview.status).toBe(400)
  expect((await read()).clinicalDocument?.signed).toEqual([])
})

it('does not wait for extraction and appends history while preserving concurrent human content', async () => {
  let release!: (value: unknown) => void
  let entered!: () => void
  const extracting = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<unknown>(resolve => { release = resolve })
  let turnId = ''
  const { ask, read, runtime, started, cookie } = await setup({ extract: input => {
    turnId = (input.userPayload as { turns: Array<{ id: string }> }).turns.at(-1)!.id
    entered()
    return held
  } })
  expect((await ask()).status).toBe(200)
  const dispatch = runtime.dispatchPending()
  await extracting
  try {
    const detail = await read()
    const response = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`, {
      method: 'PUT', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${started.encounterId}`]: detail.encounter.versionId },
        input: { expectedDraftVersion: 0, document: { assessment: '', chiefComplaint: '', disposition: '', followUp: '',
          physicalExamination: '', historyOfPresentIllness: '医生手工核对的病史。' } } }),
    })
    expect(response.status).toBe(200)
  } finally {
    release({ additions: [{ field: 'historyOfPresentIllness', sourceTurnId: turnId,
      quote: '头晕一周了，站起来时更明显。', relation: 'addition' }] })
    await dispatch
  }
  expect(await read()).toMatchObject({ clinicalDocument: { draft: { historyOfPresentIllness: '医生手工核对的病史。\n患者自述：头晕一周了，站起来时更明显。', version: 2 } },
    consultationRecording: { status: 'updated', additions: [{ status: 'applied' }] } })
})

it('does not repeat history when the patient repeats the same statement in a later answer', async () => {
  const { runtime, ask, askMore, read } = await setup()
  await ask()
  await runtime.dispatchPending()
  expect((await askMore()).status).toBe(200)
  await runtime.dispatchPending()
  expect((await read()).clinicalDocument?.draft).toMatchObject({
    historyOfPresentIllness: '患者自述：头晕一周了，站起来时更明显。', version: 1,
  })
})

it.each(['disable', 'revoke'] as const)('settles a late recording as pending after Agent authorization %s', async action => {
  let release!: (value: unknown) => void
  let entered!: () => void
  let sourceTurnId = ''
  const extracting = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<unknown>(resolve => { release = resolve })
  const { runtime, ask, read, started } = await setup({ extract: input => {
    sourceTurnId = (input.userPayload as { turns: Array<{ id: string }> }).turns.at(-1)!.id
    entered()
    return held
  } })
  const { adminHeaders, client, grant } = await createDoctorGrant(runtime, started.adminCookie,
    'encounter.consultation.ask')
  if (action === 'revoke') {
    const secondGrantResponse = await runtime.app.request('/api/agent/v1/grants', {
      method: 'POST', headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ agentClientId: client.agentClientId, operationIds: ['encounter.consultation.ask'],
        practitionerRoleId: 'practitioner-role-outpatient-doctor', ttlSeconds: 3600 }),
    })
    expect(secondGrantResponse.status).toBe(200)
    expect(agentCapabilityGrantSchema.parse(await secondGrantResponse.json()).grantId).not.toBe(grant.grantId)
  }
  expect((await ask({ authorization: `Bearer ${grant.token}` })).status).toBe(200)
  const dispatch = runtime.dispatchPending()
  await extracting
  try {
    const path = action === 'disable' ? `/api/agent/v1/clients/${client.agentClientId}/actions/disable`
      : `/api/agent/v1/grants/${grant.grantId}/actions/revoke`
    const response = await runtime.app.request(path, { method: 'POST', body: '{}',
      headers: { ...adminHeaders, 'idempotency-key': randomUUID() } })
    expect(response.status).toBe(200)
  } finally {
    release({ additions: [{ field: 'historyOfPresentIllness', sourceTurnId,
      quote: '头晕一周了，站起来时更明显。', relation: 'addition' }] })
    await dispatch
  }
  expect((await read()).clinicalDocument?.draft).toBeUndefined()
  expect((await read()).consultationRecording).toMatchObject({ status: 'failed', additions: [] })
  expect((await read()).consultation?.turns).toHaveLength(3)
  await runtime.dispatchPending()
  expect((await read()).consultationRecording?.status).toBe('failed')
})

it('rejects a late extraction after Epoch reset without contaminating the replayed case', async () => {
  let release!: (value: unknown) => void
  let entered!: () => void
  let sourceTurnId = ''
  const extracting = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<unknown>(resolve => { release = resolve })
  const { runtime, ask, started, cookie } = await setup({ extract: input => {
    sourceTurnId = (input.userPayload as { turns: Array<{ id: string }> }).turns.at(-1)!.id
    entered()
    return held
  } })
  await ask()
  const dispatch = runtime.dispatchPending()
  await extracting
  try {
    const reset = await runtime.app.request('/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', {
      method: 'POST', body: '{}', headers: { cookie: started.adminCookie, origin: 'http://localhost',
        'content-type': 'application/json', 'idempotency-key': randomUUID() },
    })
    expect(reset.status).toBe(200)
    const triageCookie = await signIn(runtime, 'triage@demo.clinmesh.local')
    const replays = triageQueueSchema.parse(await (await runtime.app.request('/api/his/v1/triage/queue', {
      headers: { cookie: triageCookie },
    })).json())
    expect(replays.items.length).toBeGreaterThan(0)
    const replay = replays.items[0]!
    const triaged = await runtime.app.request(`/api/his/v1/encounters/${replay.encounterId}/actions/record-triage`, {
      method: 'POST', headers: { cookie: triageCookie, origin: 'http://localhost',
        'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${replay.encounterId}`]: replay.encounterVersion,
        [`Task/${replay.taskId}`]: replay.taskVersion }, input: { acuityCode: 'level-3',
        chiefComplaint: '反复头晕一周', bloodPressure: { systolicMmHg: 162, diastolicMmHg: 96 },
        oxygenSaturationPct: 98, pulseBpm: 82, respirationBpm: 18, temperatureC: 36.5 } }),
    })
    expect(triaged.status).toBe(200)
  } finally {
    release({ additions: [{ field: 'historyOfPresentIllness', sourceTurnId,
      quote: '头晕一周了，站起来时更明显。', relation: 'addition' }] })
    await dispatch
  }
  const response = await runtime.app.request('/api/his/v1/doctor/queue?view=waiting', { headers: { cookie } })
  expect(response.status).toBe(200)
  const queue = await response.json() as { items: Array<{ caseId: string }> }
  expect(queue.items.length).toBeGreaterThan(0)
  for (const item of queue.items) {
    const detail = doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${item.caseId}`, { headers: { cookie } },
    )).json())
    expect(detail.clinicalDocument?.draft).toBeUndefined()
    expect(detail.consultationRecording?.additions).toEqual([])
  }
})
