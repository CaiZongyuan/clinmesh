import { doctorCaseDetailSchema, sendConsultationMessageResponseSchema, triageQueueSchema } from '@clinmesh/contracts/his'
import { agentCapabilityGrantSchema, agentClientSchema } from '@clinmesh/contracts/agent'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import type { JsonChatCompletionInput, JsonChatCompletionsProvider } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })

async function setup(options: {
  reply?: string
  extract?: (input: JsonChatCompletionInput) => Promise<unknown> | unknown
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-auto-record-'))
  disposals.push(() => rm(directory, { recursive: true }))
  const requests: JsonChatCompletionInput[] = []
  const provider: JsonChatCompletionsProvider = {
    async completeJson(input) {
      requests.push(input)
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
      if (input.schemaName === 'patient_dialogue_reply') return { content: JSON.stringify({ reply: options.reply ?? '头晕一周了，站起来时更明显。' }), model: 'synthetic' }
      if (options.extract !== undefined) return { content: JSON.stringify(await options.extract(input)), model: 'synthetic' }
      const payload = input.userPayload as { turns: Array<{ id: string; speaker: string; messageText: string }> }
      const answer = payload.turns.findLast(turn => turn.speaker === 'patient')!
      return { content: JSON.stringify({ additions: [{
        field: 'historyOfPresentIllness', sourceTurnId: answer.id,
        quote: '头晕一周了，站起来时更明显。', relation: 'addition',
      }] }), model: 'synthetic' }
    },
  }
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters',
    chatCompletionsProvider: provider, databasePath: join(directory, 'clinmesh.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply', outboxRetryDelayMs: 0,
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    syntheaProvider: new StubSyntheaProvider(), trustedOrigins: ['http://localhost'],
  })
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
  return { runtime, read, ask, askMore, requests, started, cookie }
}

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
  expect(extraction.userPayload).toEqual({ turns: expect.any(Array) })
  expect(JSON.stringify(extraction.userPayload)).not.toMatch(/hiddenResources|Case Truth|persona|knownConditions|2型糖尿病/)
  const duplicate = await ask()
  expect(duplicate.status).toBe(200)
  await runtime.dispatchPending()
  expect((await read()).clinicalDocument?.draft?.version).toBe(detail.clinicalDocument?.draft?.version)
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
  expect(detail.consultationRecording).toMatchObject({ status: 'pending', additions: [] })
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
  expect((await read()).consultationRecording).toMatchObject({ status: 'pending', additions: [] })
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
  expect((await read()).consultationRecording).toMatchObject({ status: 'pending', additions: [] })
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
  expect((await read()).consultationRecording).toMatchObject({ status: 'pending', additions: [] })
  expect((await read()).consultation?.turns).toHaveLength(3)
})

it('saves an incomplete draft while preserving required fields for signing', async () => {
  const { ask, read, runtime, started, cookie } = await setup()
  await ask()
  await runtime.dispatchPending()
  const detail = await read()
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
  const preview = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/clinical-document/actions/preview-sign`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() }, body: JSON.stringify({
      expectedVersions: { [`Encounter/${started.encounterId}`]: latest.encounter.versionId },
      input: { expectedDraftVersion: latest.clinicalDocument!.draft!.version },
    }),
  })
  expect(preview.status).toBe(400)
  expect((await read()).clinicalDocument?.signed).toEqual([])
})

it('does not wait for extraction and preserves a concurrent human draft instead of overwriting it', async () => {
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
  expect(await read()).toMatchObject({ clinicalDocument: { draft: { historyOfPresentIllness: '医生手工核对的病史。', version: 1 } },
    consultationRecording: { status: 'pending', additions: [{ status: 'pending' }] } })
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
  const adminHeaders = { cookie: started.adminCookie, origin: 'http://localhost', 'content-type': 'application/json' }
  const clientResponse = await runtime.app.request('/api/agent/v1/clients', {
    method: 'POST', headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ name: 'Synthetic consultation recorder' }),
  })
  expect(clientResponse.status).toBe(200)
  const client = agentClientSchema.parse(await clientResponse.json())
  const grantResponse = await runtime.app.request('/api/agent/v1/grants', {
    method: 'POST', headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ agentClientId: client.agentClientId, operationIds: ['encounter.consultation.ask'],
      practitionerRoleId: 'practitioner-role-outpatient-doctor', ttlSeconds: 3600 }),
  })
  expect(grantResponse.status).toBe(200)
  const grant = agentCapabilityGrantSchema.parse(await grantResponse.json())
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
  expect((await read()).consultationRecording).toMatchObject({ status: 'pending', additions: [] })
  expect((await read()).consultation?.turns).toHaveLength(3)
  await runtime.dispatchPending()
  expect((await read()).consultationRecording?.status).toBe('pending')
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
