import { apiErrorSchema, sessionContextSchema, clinicalDocumentDraftContentSchema, clinicalDocumentDraftResponseSchema, controlConsultationRecordingResponseSchema, doctorCaseDetailSchema, sendConsultationMessageResponseSchema, triageQueueSchema } from '@clinmesh/contracts/his'
import { agentCapabilityGrantSchema, agentClientSchema } from '@clinmesh/contracts/agent'
import { clinicalDocumentSignPreviewResponseSchema, clinicalDocumentSignResponseSchema, cancelClinicalDocumentSignResponseSchema } from '@clinmesh/contracts/his'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { ChatCompletionsError } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { DshModelProvider } from '../src/infrastructure/ai/dsh-model-provider.ts'
import type { JsonChatCompletionInput, JsonChatCompletionsProvider } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider, useSyntheticLaboratoryCatalog } from './fixtures/consultation.ts'
import { recordingFixtureProvider, replaceWithPreConsolidationDatabase } from './fixtures/consultation-history.ts'
import { replaceWithPreSourceDatabase, replaceWithRecordingBranchDatabase } from './fixtures/legacy-recording-database.ts'

const disposals: Array<() => Promise<void>> = []

it.each(['incremental', 'quality'] as const)('upgrades a populated %s release while preserving its records and audit', async branch => {
  const fixture = await setup()
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  const before = await fixture.read()
  const snapshot = () => ({
    additions: fixture.runtime.database.driver.prepare('SELECT workspace_id, epoch, case_id, addition_id, field, source_turn_id, quote, relation, status, target_addition_id, ownership, start_offset, end_offset, current_text, review_state, review_status, rejected, undone, inverse_text, facts_json FROM consultation_history_addition ORDER BY rowid').all(),
    receipts: fixture.runtime.database.driver.prepare('SELECT * FROM command_receipt ORDER BY rowid').all(),
    branchRows: branch === 'incremental'
      ? fixture.runtime.database.driver.prepare('SELECT * FROM consultation_recording_batch ORDER BY batch_id').all()
      : fixture.runtime.database.driver.prepare('SELECT * FROM clinical_document_quality ORDER BY scope_key').all(),
  })
  const stored = snapshot()
  expect(stored.additions.length).toBeGreaterThan(0)
  expect(stored.branchRows.length).toBeGreaterThan(0)
  expect(stored.receipts.length).toBeGreaterThan(0)
  await fixture.restart(path => replaceWithRecordingBranchDatabase(path, branch))
  expect(fixture.runtime.database.diagnostics()).toMatchObject({ schemaVersion: 81, integrity: 'ok', foreignKeys: true })
  expect(fixture.runtime.database.driver.pragma('foreign_key_check')).toEqual([])
  expect(snapshot()).toEqual(stored)
  const upgraded = await fixture.read()
  expect(upgraded.clinicalDocument).toEqual(before.clinicalDocument)
  expect(upgraded.consultationRecording?.sourceResults).toEqual(before.consultationRecording?.sourceResults)
  await fixture.restart()
  expect(snapshot()).toEqual(stored)
})

it.each(['main', 'fields'] as const)('integrates a populated %s branch database without losing field rows, sources or audit', async branch => {
  const field = branch === 'main' ? 'physicalExamination' : 'familyHistory'
  const quote = branch === 'main' ? '查体：双肺呼吸音清。' : '我父亲患高血压。'
  const text = branch === 'main' ? '双肺呼吸音清' : '父亲患高血压，患者自述'
  const fixture = await setup({ reply: quote, extract: input => {
    const source = (input.userPayload as { turns: Array<{ id: string; kind: string; messageText: string }> }).turns.at(-1)!
    return { additions: branch === 'main' && source.kind !== 'doctor' ? [] : [{ field, relation: 'addition',
      facts: [{ text, sources: [{ sourceTurnId: source.id, quote }] }] }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  if (branch === 'main') {
    const detail = await fixture.read()
    const context = await fixture.runtime.identity.resolveActorContext(new Headers({ cookie: fixture.cookie }), 'encounter.consultation.recording.control')
    fixture.runtime.workflow.consultationRecording.recordDoctorSupplement({ context,
      encounterId: fixture.started.encounterId, sourceId: 'doctor-upgrade-source', content: quote,
      sessionId: 'synthetic-upgrade-session', rpcId: 'synthetic-upgrade-rpc', messageId: 'synthetic-upgrade-message',
      recordedAt: '2026-10-15T00:00:00.000Z', expectedVersions: { [`Encounter/${fixture.started.encounterId}`]: detail.encounter.versionId },
      idempotencyKey: randomUUID() })
    await fixture.runtime.dispatchPending()
  }
  const before = await fixture.read()
  expect(before.clinicalDocument!.draft![field]).toBe(text)
  const snapshot = () => ({
    rows: fixture.runtime.database.driver.prepare('SELECT workspace_id, epoch, case_id, addition_id, field, source_turn_id, quote, relation, status, target_addition_id, ownership, start_offset, end_offset, current_text, review_state, review_status, rejected, undone, inverse_text, facts_json FROM consultation_history_addition ORDER BY rowid').all(),
    jobs: fixture.runtime.database.driver.prepare('SELECT * FROM consultation_recording_job ORDER BY turn_id').all(),
    receipts: fixture.runtime.database.driver.prepare('SELECT * FROM command_receipt ORDER BY rowid').all(),
  })
  const stored = snapshot()
  await fixture.restart(path => replaceWithRecordingBranchDatabase(path, branch))
  expect(fixture.runtime.database.diagnostics()).toMatchObject({ schemaVersion: 81, integrity: 'ok', foreignKeys: true })
  expect(fixture.runtime.database.driver.pragma('foreign_key_check')).toEqual([])
  expect(snapshot()).toEqual(stored)
  const upgraded = await fixture.read()
  expect(upgraded.clinicalDocument).toEqual(before.clinicalDocument)
  expect(upgraded.consultationRecording!.additions).toEqual(before.consultationRecording!.additions)
  expect(upgraded.consultationRecording!.sources).toEqual(before.consultationRecording!.sources)
  await fixture.restart()
  expect(snapshot()).toEqual(stored)
})
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })

const summaryPayloadSchema = z.object({
  turns: z.array(z.object({ id: z.string(), speaker: z.string(), messageText: z.string() })),
  history: z.array(z.object({ id: z.string(), field: z.string(), text: z.string().optional() })),
})
const firstFeverReply = '昨天晚上开始发烧，最高量到38.5度，还咳嗽，但是没有痰。'
const secondFeverReply = '咳嗽也是昨晚开始的，胸口不疼，也不觉得喘。'
const feverSummary = '昨晚起发热伴干咳，自述最高体温38.5℃'
const combinedFeverSummary = feverSummary + '；否认胸痛、气促'

function feverSummaries(input: JsonChatCompletionInput) {
  const { turns, history } = summaryPayloadSchema.parse(input.userPayload)
  const first = turns.find(turn => turn.messageText === firstFeverReply)!
  const second = turns.find(turn => turn.messageText === secondFeverReply)
  return { additions: [{ field: 'historyOfPresentIllness', relation: second === undefined ? 'addition' : 'update',
    ...(second === undefined ? {} : { targetAdditionId: history[0]!.id }),
    facts: [{ text: feverSummary, sources: [{ sourceTurnId: first.id, quote: first.messageText },
      ...(second === undefined ? [] : [{ sourceTurnId: second.id, quote: second.messageText }])] },
    ...(second === undefined ? [] : [{ text: '否认胸痛、气促', sources: [{ sourceTurnId: second.id, quote: second.messageText }] }])],
  }] }
}

async function setup(options: {
  recording?: boolean
  now?: () => Date
  failFirstReply?: boolean
  reply?: string | (() => string)
  extract?: (input: JsonChatCompletionInput) => Promise<unknown> | unknown
  resolveModel?: JsonChatCompletionsProvider['resolveModel']
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-auto-record-'))
  disposals.push(() => rm(directory, { recursive: true }))
  const requests: JsonChatCompletionInput[] = []
  let replyCalls = 0
  const provider: JsonChatCompletionsProvider = {
    ...(options.resolveModel === undefined ? {} : { resolveModel: options.resolveModel }),
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
    ...(options.now === undefined ? {} : { now: options.now }),
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters',
    chatCompletionsProvider: recordingFixtureProvider(provider), databasePath: join(directory, 'clinmesh.sqlite'),
    consultationModel: 'synthetic', patientPersonaModel: 'synthetic', investigationModel: 'synthetic',
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply', outboxRetryDelayMs: 0,
    ...(options.recording === false ? {} : { dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 } }),
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
  const askMore = async (actorHeaders: Record<string, string> = { cookie }) => {
    const detail = await read()
    return runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/ask-consultation-question`, {
      method: 'POST', headers: { ...actorHeaders, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${started.encounterId}`]: detail.encounter.versionId,
        [`Task/${detail.taskId}`]: detail.taskVersion }, input: { expectedConsultationVersion: detail.consultation!.version, message: '再确认一下病史？' } }),
    })
  }
  const save = async (history: string, field: keyof typeof clinicalDocumentDraftContentSchema.shape = 'historyOfPresentIllness') => {
    const detail = await read()
    const draft = detail.clinicalDocument?.draft ?? { assessment: '', chiefComplaint: '', disposition: '', followUp: '',
      physicalExamination: '', historyOfPresentIllness: '' }
    const document = clinicalDocumentDraftContentSchema.parse(Object.fromEntries(
      Object.keys(clinicalDocumentDraftContentSchema.shape).map(field => [field, draft[field as keyof typeof draft]]).filter(([, value]) => value !== undefined),
    ))
    const response = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`, {
      method: 'PUT', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${started.encounterId}`]: detail.encounter.versionId },
        input: { expectedDraftVersion: detail.clinicalDocument?.draft?.version ?? 0, document: { ...document, [field]: history } } }),
    })
    if (response.status === 200) clinicalDocumentDraftResponseSchema.parse(await response.clone().json())
    return response
  }
  const control = async (action: 'activate' | 'pause' | 'resume' | 'backfill' | 'retry', options: { key?: string; version?: number; headers?: Record<string, string> } = {}) => {
    const detail = await read()
    return runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/consultation-recording/actions/control`, {
      method: 'POST', headers: { ...(options.headers ?? { cookie }), origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': options.key ?? randomUUID() },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${started.encounterId}`]: detail.encounter.versionId },
        input: { action, expectedRecordingVersion: options.version ?? detail.consultationRecording?.version ?? 0 } }),
    })
  }
  return { get runtime() { return runtime }, read, ask, askMore, requests, started, cookie, save, control,
    restart: async (prepare?: (databasePath: string) => Promise<void>) => {
      await runtime.close()
      await prepare?.(join(directory, 'clinmesh.sqlite'))
      runtime = await createRuntime()
    } }
}

async function signing(fixture: Awaited<ReturnType<typeof setup>>) {
  const complete = { assessment: '医生评估待进一步明确。', chiefComplaint: '头晕一周。', disposition: '门诊随访。',
    followUp: '加重时及时就诊。', physicalExamination: '查体未见明显异常。', historyOfPresentIllness: '医生已核对病史。' }
  const request = async (action: string, input: object, options: { cookie?: string; version?: string; key?: string } = {}) => {
    const current = await fixture.read()
    return fixture.runtime.app.request(`/api/his/v1/encounters/${fixture.started.encounterId}/clinical-document/${action}`, {
      method: action === 'draft' ? 'PUT' : 'POST',
      headers: { cookie: options.cookie ?? fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json',
        'idempotency-key': options.key ?? randomUUID() },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${fixture.started.encounterId}`]: options.version ?? current.encounter.versionId }, input }),
    })
  }
  const save = async () => {
    const response = await request('draft', { document: complete, expectedDraftVersion: (await fixture.read()).clinicalDocument?.draft?.version ?? 0 })
    expect(response.status).toBe(200)
    clinicalDocumentDraftResponseSchema.parse(await response.json())
  }
  const preview = async () => {
    const response = await request('actions/preview-sign', { expectedDraftVersion: (await fixture.read()).clinicalDocument!.draft!.version })
    expect(response.status).toBe(200)
    return clinicalDocumentSignPreviewResponseSchema.parse(await response.json()).data
  }
  return { complete, save, preview, request }
}

it('replays legacy activation, resume and signing preview receipts without restoring review contracts or changing stored evidence', async () => {
  const fixture = await setup()
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const updateReceipt = (operation: string, key: string, value: unknown) => fixture.runtime.database.driver.prepare(
    'UPDATE command_receipt SET response_json = ? WHERE operation = ? AND idempotency_key = ?',
  ).run(JSON.stringify(value), operation, key)
  const storedReceipt = (operation: string, key: string) => fixture.runtime.database.driver.prepare(
    'SELECT response_json FROM command_receipt WHERE operation = ? AND idempotency_key = ?',
  ).get(operation, key)
  const auditCount = () => fixture.runtime.database.driver.prepare('SELECT COUNT(*) AS count FROM audit_log').get()
  for (const action of ['activate', 'resume'] as const) {
    if (action === 'resume') expect((await fixture.control('pause')).status).toBe(200)
    const version = (await fixture.read()).consultationRecording!.version
    const key = randomUUID()
    const response = await fixture.control(action, { key, version })
    expect(response.status).toBe(200)
    const receipt = controlConsultationRecordingResponseSchema.parse(await response.json())
    expect(receipt.data.additions.length).toBeGreaterThan(0)
    const legacy = { ...receipt, data: { ...receipt.data, status: 'pending', additions: receipt.data.additions.map(addition => ({
      ...addition, status: 'pending', reviewStatus: 'unreviewed', reviewable: true,
    })) } }
    updateReceipt('consultation.recording.control', key, legacy)
    const before = await fixture.read()
    const audits = auditCount()
    const replay = await fixture.control(action, { key, version })
    expect(replay.status).toBe(200)
    const projected = controlConsultationRecordingResponseSchema.parse(await replay.json())
    expect(projected).toEqual({ ...receipt, data: { ...receipt.data, status: 'processing',
      additions: receipt.data.additions.map(addition => ({ ...addition, status: 'superseded' })),
    } })
    expect(storedReceipt('consultation.recording.control', key)).toEqual({ response_json: JSON.stringify(legacy) })
    expect(await fixture.read()).toEqual(before)
    expect(auditCount()).toEqual(audits)
  }

  const sign = await signing(fixture)
  await sign.save()
  const previewKey = randomUUID()
  const expectedDraftVersion = (await fixture.read()).clinicalDocument!.draft!.version
  const previewResponse = await sign.request('actions/preview-sign', { expectedDraftVersion }, { key: previewKey })
  expect(previewResponse.status).toBe(200)
  const preview = clinicalDocumentSignPreviewResponseSchema.parse(await previewResponse.json())
  const oldPreview = { ...preview, data: { ...preview.data, consultationReview: {
    consultationVersion: 4, remainingCount: 0, failedCount: 0, paused: false, conflictCount: 1, unreviewedCount: 1,
  } } }
  updateReceipt('clinical-document.preview-sign', previewKey, oldPreview)
  const audits = auditCount()
  const previewReplay = await sign.request('actions/preview-sign', { expectedDraftVersion }, { key: previewKey })
  expect(previewReplay.status).toBe(200)
  expect(clinicalDocumentSignPreviewResponseSchema.parse(await previewReplay.json())).toEqual(preview)
  expect(storedReceipt('clinical-document.preview-sign', previewKey)).toEqual({ response_json: JSON.stringify(oldPreview) })
  expect(auditCount()).toEqual(audits)
  const signed = await sign.request('actions/sign', { commitToken: preview.data.commitToken, previewId: preview.data.previewId })
  expect(signed.status).toBe(200)
})

it('saves, restarts, signs and revises family and allergy history while preserving signed originals and formal allergies', async () => {
  const fixture = await setup()
  const sign = await signing(fixture)
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await sign.save()
  expect((await fixture.read()).clinicalDocument!.draft).not.toHaveProperty('familyHistory')
  const allergyCount = () => fixture.runtime.database.driver.prepare("SELECT COUNT(*) AS count FROM fhir_resource WHERE resource_type = 'AllergyIntolerance'").get()
  const beforeAllergies = allergyCount()
  await fixture.save('父亲患高血压。', 'familyHistory')
  await fixture.save('青霉素用药后皮疹。', 'allergyHistory')
  await fixture.restart()
  const preview = await sign.preview()
  expect(preview.document.content).toMatchObject({ familyHistory: '父亲患高血压。', allergyHistory: '青霉素用药后皮疹。' })
  const response = await sign.request('actions/sign', { commitToken: preview.commitToken, previewId: preview.previewId, })
  expect(response.status).toBe(200)
  const signed = clinicalDocumentSignResponseSchema.parse(await response.json()).data
  const readFhir = async (type: string, id: string) => (await fixture.runtime.app.request(`/fhir/R5/${type}/${id}`, { headers: { cookie: fixture.cookie } })).json()
  const original = await readFhir('Composition', signed.compositionId)
  const bundle = await readFhir('Bundle', signed.bundleId)
  expect(original).toMatchObject({ section: expect.arrayContaining([
    { title: '家族史', code: expect.objectContaining({ coding: expect.arrayContaining([expect.objectContaining({ code: 'family-history' })]) }),
      text: expect.objectContaining({ div: expect.stringContaining('父亲患高血压。') }) },
    { title: '过敏史', code: expect.objectContaining({ coding: expect.arrayContaining([expect.objectContaining({ code: 'allergy-history' })]) }),
      text: expect.objectContaining({ div: expect.stringContaining('青霉素用药后皮疹。') }) },
    expect.objectContaining({ title: '体格检查' }),
  ]) })
  const current = await fixture.read()
  const revisionResponse = await fixture.runtime.app.request(`/api/his/v1/clinical-documents/${signed.compositionId}/actions/revise`, {
    method: 'POST', headers: { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: { [`Composition/${signed.compositionId}`]: signed.compositionVersion,
      [`Encounter/${fixture.started.encounterId}`]: current.encounter.versionId }, input: {
      document: { ...preview.document.content, familyHistory: '', allergyHistory: '过敏药物待核实。' }, reason: '补充核对病史。',
    } }),
  })
  expect(revisionResponse.status).toBe(200)
  await fixture.restart()
  expect((await fixture.read()).clinicalDocument!.signed.map(document => document.content)).toEqual([
    preview.document.content, { ...preview.document.content, familyHistory: '', allergyHistory: '过敏药物待核实。' },
  ])
  expect(await readFhir('Composition', signed.compositionId)).toEqual(original)
  expect(await readFhir('Bundle', signed.bundleId)).toEqual(bundle)
  expect(allergyCount()).toEqual(beforeAllergies)
})

it.each(['\n', '\r\n'])('accepts separately cited patient statements delimited by %j', async newline => {
  const reply = `发热三天${newline}最高量到38.5度`
  const fixture = await setup({ reply, extract: input => {
    const turn = summaryPayloadSchema.parse(input.userPayload).turns.at(-1)!
    return { additions: [{ field: 'historyOfPresentIllness', relation: 'addition', facts: [
      { text: '发热三天', sources: [{ sourceTurnId: turn.id, quote: '发热三天' }] },
      { text: '自述最高体温38.5℃', sources: [{ sourceTurnId: turn.id, quote: '最高量到38.5度' }] },
    ] }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const recorded = await fixture.read()
  expect(recorded.consultationRecording).toMatchObject({ status: 'updated', failures: [] })
  expect(recorded.clinicalDocument!.draft!.historyOfPresentIllness).toBe('发热三天；自述最高体温38.5℃')
  expect(recorded.consultation!.turns.at(-1)!.messageText).toBe(reply)
  expect(recorded.qualityControl).toMatchObject({ status: 'ready', stale: false, draftVersion: recorded.clinicalDocument!.draft!.version })
})

it('ignores an old-only summary rewrite after a reply with no new history', async () => {
  let reply = firstFeverReply
  const fixture = await setup({ reply: () => reply, extract: input => {
    if (reply === firstFeverReply) return feverSummaries(input)
    const { turns, history } = summaryPayloadSchema.parse(input.userPayload)
    const first = turns.find(turn => turn.messageText === firstFeverReply)!
    return { additions: [{ field: 'historyOfPresentIllness', relation: 'update', targetAdditionId: history[0]!.id,
      facts: [{ text: '自述最高体温38.5℃，昨晚起发热伴干咳',
        sources: [{ sourceTurnId: first.id, quote: first.messageText }] }] }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const before = await fixture.read()
  reply = '谢谢。'
  expect((await fixture.askMore()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const after = await fixture.read()
  expect(after.clinicalDocument).toEqual(before.clinicalDocument)
  expect(after.consultationRecording!.additions).toEqual(before.consultationRecording!.additions)
  expect(after.consultationRecording).toMatchObject({ status: 'updated', failures: [] })
})

it('retains patient uncertainty, home measurements, external diagnoses, medication and allergy attribution', async () => {
  const reply = '我记不清了，可能三天前开始头晕。家里量的血压是150/90。外院说我有高血压。以前吃过氨氯地平，我不确定青霉素是不是过敏。'
  const texts = ['自述头晕可能始于三天前，具体时间记不清', '自述居家血压150/90，外院曾告知高血压', '自述既往服用氨氯地平，青霉素过敏情况不确定']
  const fixture = await setup({ reply, extract: input => {
    const source = summaryPayloadSchema.parse(input.userPayload).turns.at(-1)!
    return { additions: texts.map((text, index) => ({ field: index === 2 ? 'priorMedicalHistory' : 'historyOfPresentIllness',
      relation: 'addition', facts: [{ text, sources: [{ sourceTurnId: source.id, quote: reply }] }] })) }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  const detail = await fixture.read()
  expect(detail.clinicalDocument?.draft).toMatchObject({ historyOfPresentIllness: texts.slice(0, 2).join('\n'),
    priorMedicalHistory: texts[2], physicalExamination: '', assessment: '' })
  expect(detail.consultationRecording!.additions.flatMap(addition => addition.facts!)).toHaveLength(3)
})

it('rejects a source from another case without a standalone verification request', async () => {
  const fixture = await setup({ reply: firstFeverReply,
    extract: () => ({ additions: [{ field: 'historyOfPresentIllness', relation: 'addition', facts: [{
      text: feverSummary, sources: [{ sourceTurnId: 'other-case-patient-turn', quote: firstFeverReply }],
    }] }] }) })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  expect(fixture.requests.filter(input => input.schemaName === 'consultation_history_verification')).toHaveLength(0)
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'failed', additions: [] })
})

it('retires legacy verdicts and duplicate outbox deliveries on a populated database without regenerating saved evidence', async () => {
  const texts = ['患者自述发热', '患者自述干咳', '患者自述无痰', '自述最高体温38.5℃', '患者自述昨晚起病']
  const fixture = await setup({ reply: firstFeverReply, extract: input => {
    const source = summaryPayloadSchema.parse(input.userPayload).turns.at(-1)!
    return { additions: texts.map(text => ({ field: 'historyOfPresentIllness', relation: 'addition',
      facts: [{ text, sources: [{ sourceTurnId: source.id, quote: firstFeverReply }] }] })) }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const before = await fixture.read()
  expect(before.consultationRecording!.additions).toHaveLength(5)
  expect(fixture.requests.filter(input => input.schemaName === 'consultation_history_verification')).toHaveLength(0)
  const database = fixture.runtime.database.driver
  const additions = z.array(z.object({ addition_id: z.string(), batch_id: z.string() })).parse(database.prepare(
    'SELECT addition_id, batch_id FROM consultation_history_addition_batch ORDER BY rowid',
  ).all())
  const event = z.record(z.string(), z.unknown()).parse(database.prepare(
    "SELECT * FROM outbox_event WHERE kind = 'consultation.record-history' ORDER BY rowid LIMIT 1",
  ).get())
  const actor = z.object({ actor_context_json: z.string() }).parse(database.prepare(
    'SELECT actor_context_json FROM consultation_recording',
  ).get())
  const states = ['pending', 'failed', 'flagged', 'stale', 'verified'] as const
  const insertVerdict = database.prepare(`INSERT INTO consultation_recording_verification
    (workspace_id, epoch, case_id, addition_id, batch_id, content_hash, actor_context_json, status, reason, elapsed_ms)
    SELECT workspace_id, epoch, case_id, addition_id, batch_id, 'synthetic-legacy-content-hash', ?, ?, ?, ?
    FROM consultation_history_addition_batch WHERE addition_id = ?`)
  for (const [index, state] of states.entries()) insertVerdict.run(actor.actor_context_json, state,
    state === 'failed' ? 'verification-unavailable' : state === 'flagged' ? 'verification-rejected' : null,
    state === 'pending' ? null : 12, additions[index]!.addition_id)
  const legacyEvent = { ...event, event_id: 'legacy-verification-event', kind: 'consultation.verify-history',
    dedup_key: 'synthetic-legacy-verification', status: 'queued', attempt: 0, lease_owner: null, leased_until: null,
    next_attempt_at: '2026-01-01T00:00:00.000Z',
    payload_json: JSON.stringify({ batchId: additions[0]!.batch_id, additionId: additions[0]!.addition_id,
      turnId: before.consultation!.turns.at(-1)!.id }) }
  const columns = Object.keys(legacyEvent)
  database.prepare(`INSERT INTO outbox_event (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map(column => legacyEvent[column as keyof typeof legacyEvent]))
  const audit = database.prepare('SELECT * FROM audit_log ORDER BY rowid').all()
  const receipts = database.prepare('SELECT * FROM command_receipt ORDER BY rowid').all()
  const historicalVerdicts = database.prepare(`SELECT workspace_id, epoch, case_id, addition_id, batch_id,
    content_hash, actor_context_json, reason, elapsed_ms FROM consultation_recording_verification ORDER BY rowid`).all()
  const requests = fixture.requests.length
  await fixture.restart(replaceWithPreConsolidationDatabase)
  expect(fixture.runtime.database.diagnostics()).toMatchObject({ schemaVersion: 81, integrity: 'ok', foreignKeys: true })
  expect(fixture.runtime.database.driver.pragma('foreign_key_check')).toEqual([])
  const verdicts = () => fixture.runtime.database.driver.prepare(`SELECT status, retired_status
    FROM consultation_recording_verification ORDER BY rowid`).all()
  expect(verdicts()).toEqual(states.map(state => ({ status: state === 'pending' ? 'stale' : state, retired_status: state })))
  expect(fixture.runtime.database.driver.prepare('SELECT addition_id, batch_id FROM consultation_history_addition_batch ORDER BY rowid').all()).toEqual(additions)
  expect(() => fixture.runtime.database.driver.prepare('UPDATE consultation_history_addition_batch SET batch_id = ? WHERE addition_id = ?')
    .run('missing-batch', additions[0]!.addition_id)).toThrow('FOREIGN KEY constraint failed')
  expect(fixture.runtime.database.driver.pragma('foreign_key_check')).toEqual([])
  await fixture.runtime.dispatchPending()
  const after = await fixture.read()
  expect(after.clinicalDocument).toEqual(before.clinicalDocument)
  expect(after.consultationRecording!.sources).toEqual(before.consultationRecording!.sources)
  expect(after.consultationRecording!.additions).toEqual(before.consultationRecording!.additions)
  expect(after.consultationRecording!.verification).toEqual({ pendingCount: 0, flaggedCount: 0, failedCount: 0, issues: [] })
  const retiredEvent = () => fixture.runtime.database.driver.prepare(`SELECT status, attempt FROM outbox_event
    WHERE event_id = 'legacy-verification-event'`).get()
  expect(retiredEvent()).toEqual({ status: 'completed', attempt: 1 })
  // Redelivery must finish once, then remain inert across polls and restart.
  fixture.runtime.database.driver.prepare(`UPDATE outbox_event SET status = 'queued', attempt = 0,
    next_attempt_at = '2026-01-01T00:00:00.000Z'
    WHERE event_id = 'legacy-verification-event'`).run()
  await fixture.runtime.dispatchPending()
  await fixture.runtime.dispatchPending()
  await fixture.restart()
  await fixture.runtime.dispatchPending()
  expect(retiredEvent()).toEqual({ status: 'completed', attempt: 1 })
  expect(fixture.requests).toHaveLength(requests)
  expect(fixture.runtime.database.driver.prepare('SELECT * FROM audit_log ORDER BY rowid').all()).toEqual(audit)
  expect(fixture.runtime.database.driver.prepare('SELECT * FROM command_receipt ORDER BY rowid').all()).toEqual(receipts)
  expect(fixture.runtime.database.driver.prepare(`SELECT workspace_id, epoch, case_id, addition_id, batch_id,
    content_hash, actor_context_json, reason, elapsed_ms FROM consultation_recording_verification ORDER BY rowid`).all()).toEqual(historicalVerdicts)
  expect(verdicts()).toEqual(states.map(state => ({ status: state === 'pending' ? 'stale' : state, retired_status: state })))
  expect((await fixture.control('retry')).status).toBe(409)
  expect((await fixture.askMore()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).consultationRecording).toMatchObject({ processedCount: 2, failedCount: 0, remainingCount: 0 })
  expect(fixture.requests.filter(input => input.schemaName === 'consultation_history_verification')).toHaveLength(0)
})

it('rejects a changed consultation snapshot and signs a fresh preview without an acknowledgement when recording is unavailable', async () => {
  const fixture = await setup({ recording: false })
  expect((await fixture.ask()).status).toBe(200)
  const actions = await signing(fixture)
  await actions.save()
  const preview = await actions.preview()
  const before = (await fixture.read()).consultation!.version
  expect((await fixture.askMore()).status).toBe(200)
  expect((await fixture.read()).consultation!.version).toBeGreaterThan(before)
  const denied = await actions.request('actions/sign', { previewId: preview.previewId, commitToken: preview.commitToken, })
  expect(denied.status).toBe(409)
  expect((await fixture.read()).clinicalDocument?.signed).toHaveLength(0)
  expect((await actions.request('actions/cancel-sign', { previewId: preview.previewId })).status).toBe(200)
  const fresh = await actions.preview()
  expect(fresh).not.toHaveProperty('consultationReview')
  expect((await actions.request('actions/sign', { previewId: fresh.previewId, commitToken: fresh.commitToken })).status).toBe(200)
  expect((await fixture.read()).clinicalDocument?.signed).toHaveLength(1)
})

it('enforces responsibility for signing preparation, commit and cancellation while allowing a newly trusted actor of the responsible role to recover', async () => {
  const fixture = await setup()
  expect((await fixture.ask()).status).toBe(200)
  const actions = await signing(fixture)
  await actions.save()
  const preview = await actions.preview()
  const frozen = await fixture.read()
  const context = { workspaceId: 'workspace-demo', epoch: 'epoch-1' }
  fixture.runtime.fhir.create(context, {
    resourceType: 'PractitionerRole', id: 'practitioner-role-other-sign-doctor', active: true,
    practitioner: { reference: 'Practitioner/practitioner-outpatient-doctor' },
    organization: { reference: 'Organization/organization-clinmesh' }, code: [{ text: 'outpatient-doctor' }],
    location: [{ reference: 'Location/location-outpatient-doctor' }],
  })
  fixture.runtime.database.driver.prepare(`INSERT INTO practitioner_role_binding (
    workspace_id, practitioner_role_id, practitioner_id, role_code, organization_id, location_id, active
  ) VALUES (?, ?, ?, 'outpatient-doctor', ?, ?, 1)`).run(context.workspaceId, 'practitioner-role-other-sign-doctor',
    'practitioner-outpatient-doctor', 'organization-clinmesh', 'location-outpatient-doctor')
  fixture.runtime.database.driver.prepare(`INSERT INTO membership_practitioner_role (
    membership_id, workspace_id, practitioner_role_id
  ) VALUES ('membership-administrator', ?, ?)`).run(context.workspaceId, 'practitioner-role-other-sign-doctor')
  const admin = await signIn(fixture.runtime, 'admin@demo.clinmesh.local')
  const select = async (practitionerRoleId: string) => {
    const response = await fixture.runtime.app.request('/api/auth/role', {
      method: 'POST', headers: { cookie: admin, origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ practitionerRoleId }),
    })
    expect(response.status).toBe(200)
    return sessionContextSchema.parse(await response.json())
  }
  await select('practitioner-role-other-sign-doctor')
  for (const [action, input] of [
    ['actions/preview-sign', { expectedDraftVersion: frozen.clinicalDocument!.draft!.version }],
    ['actions/sign', { previewId: preview.previewId, commitToken: preview.commitToken, }],
    ['actions/cancel-sign', { previewId: preview.previewId }],
  ] as const) {
    const denied = await actions.request(action, input, { cookie: admin })
    expect(denied.status).toBe(403)
    expect(apiErrorSchema.parse(await denied.json()).error.code).toBe('ROLE_NOT_ALLOWED')
    expect(await fixture.read()).toEqual(frozen)
  }
  const selected = await select('practitioner-role-outpatient-doctor')
  expect(selected.actor.actorId).not.toBe((await fixture.runtime.identity.resolveSessionContext(new Headers({ cookie: fixture.cookie }))).actor.actorId)
  const cancelled = await actions.request('actions/cancel-sign', { previewId: preview.previewId }, { cookie: admin })
  expect(cancelled.status).toBe(200)
  expect(cancelClinicalDocumentSignResponseSchema.parse(await cancelled.json()).data.previewId).toBe(preview.previewId)
  expect((await fixture.read()).consultationRecording?.signingPreparation).toBeUndefined()
})

it('cancels preparation durably and resumes an unfinished answer in a new generation while discarding the old result', async () => {
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const extracting = new Promise<void>(resolve => { entered = resolve })
  let calls = 0
  const fixture = await setup({ extract: async input => {
    if (calls++ === 0) { entered(); await held; return { additions: [] } }
    const turn = (input.userPayload as { turns: Array<{ id: string }> }).turns.at(-1)!
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: turn.id, quote: '头晕一周了，站起来时更明显。', relation: 'addition' }] }
  } })
  disposals.push(async () => release())
  await fixture.ask()
  const processing = fixture.runtime.dispatchPending()
  await extracting
  const actions = await signing(fixture)
  await actions.save()
  const preview = await actions.preview()
  const key = randomUUID()
  expect((await actions.request('actions/cancel-sign', { previewId: 'another-preview' })).status).toBe(409)
  expect((await actions.request('actions/cancel-sign', { previewId: preview.previewId }, { version: '1' })).status).toBe(409)
  expect((await actions.request('actions/cancel-sign', { previewId: preview.previewId }, { cookie: await signIn(fixture.runtime, 'registrar@demo.clinmesh.local') })).status).toBe(403)
  const cancel = await actions.request('actions/cancel-sign', { previewId: preview.previewId }, { key })
  expect(cancel.status).toBe(200)
  const receipt = cancelClinicalDocumentSignResponseSchema.parse(await cancel.json())
  release()
  await processing
  expect((await fixture.read()).consultationRecording).toMatchObject({ processedCount: 1, remainingCount: 0, additions: [{ status: 'applied' }] })
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(actions.complete.historyOfPresentIllness + '\n患者自述：头晕一周了，站起来时更明显。')
  await fixture.restart()
  expect((await actions.request('actions/cancel-sign', { previewId: preview.previewId }, { key })).status).toBe(200)
  expect(cancelClinicalDocumentSignResponseSchema.parse(await (await actions.request('actions/cancel-sign', { previewId: preview.previewId }, { key })).json())).toEqual(receipt)
  expect((await fixture.read()).consultationRecording?.signingPreparation).toBeUndefined()
  expect((await actions.request('actions/sign', { commitToken: preview.commitToken, previewId: preview.previewId, })).status).toBe(409)
})

it('persists pause while saving replies, then resumes in order without duplicating processed answers or losing manual edits', async () => {
  let reply = '头晕一周了。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const turns = (input.userPayload as { turns: Array<{ id: string; messageText: string }> }).turns
    return { additions: turns.filter(turn => (input.userPayload as { currentSourceIds: string[] }).currentSourceIds.includes(turn.id))
      .map(turn => ({ field: 'historyOfPresentIllness', sourceTurnId: turn.id, quote: turn.messageText, relation: 'addition' })) }
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
  expect(fixture.requests.filter(input => input.schemaName === 'consultation_history_increment')).toHaveLength(2)
  expect(fixture.runtime.database.driver.prepare("SELECT count(*) AS count FROM audit_log WHERE operation = 'consultation.recording.control' AND outcome = 'success'").get()).toMatchObject({ count: 2 })
})

it('offers historical backfill without changing a manual draft on read or restart', async () => {
  const fixture = await setup({ extract: input => {
    const turns = (input.userPayload as { turns: Array<{ id: string; messageText: string }> }).turns
    return { additions: turns.filter(turn => (input.userPayload as { currentSourceIds: string[] }).currentSourceIds.includes(turn.id))
      .map(turn => ({ field: 'historyOfPresentIllness', sourceTurnId: turn.id, quote: turn.messageText, relation: 'addition' })) }
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
  expect(fixture.requests.filter(input => input.schemaName === 'consultation_history_increment')).toHaveLength(1)
})

it('recovers failed batch members explicitly across restart and persists real progress across restart', async () => {
  let fail = true
  let reply = '头晕一周了。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    if (fail) throw new Error('Synthetic disconnect')
    const turns = (input.userPayload as { turns: Array<{ id: string; messageText: string }> }).turns
    return { additions: turns.filter(turn => (input.userPayload as { currentSourceIds: string[] }).currentSourceIds.includes(turn.id))
      .map(turn => ({ field: 'historyOfPresentIllness', sourceTurnId: turn.id, quote: turn.messageText, relation: 'addition' })) }
  } })
  await fixture.ask()
  reply = '夜间也会头晕。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.restart()
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'failed', failedCount: 2, processedCount: 0, remainingCount: 2 })
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
  let recordingSignal!: AbortSignal
  const entered = new Promise<void>(resolve => { enter = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const fixture = await setup({ extract: async input => {
    if (calls++ === 0) {
      recordingSignal = input.signal!
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
    expect(recordingSignal.aborted).toBe(true)
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

it.each(['医生核对：否认胸痛。', '医生核对：睡眠正常。'] as const)('recompares history saved during extraction before applying a new addition (%s)', async manual => {
  let release!: () => void
  let started!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const extracting = new Promise<void>(resolve => { started = resolve })
  let calls = 0
  const fixture = await setup({ reply: '胸痛两天了。', extract: async input => {
    const payload = input.userPayload as { turns: Array<{ id: string }>;
      manualHistory?: Array<{ id: string; text: string }> }
    if (++calls === 1) { started(); await blocked }
    const target = payload.manualHistory?.find(item => item.text === '医生核对：否认胸痛。')
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
      quote: '胸痛两天了。', relation: target === undefined ? 'addition' : 'conflict',
      ...(target === undefined ? {} : { targetAdditionId: target.id }) }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  const processing = fixture.runtime.dispatchPending()
  await extracting
  try { expect((await fixture.save(manual)).status).toBe(200) } finally { release(); await processing }
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(manual)
  expect((await fixture.control('retry')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const detail = await fixture.read()
  const conflicting = manual.includes('否认胸痛')
  expect(detail.clinicalDocument?.draft?.historyOfPresentIllness)
    .toBe(`${manual}\n${conflicting ? '患者自述存在矛盾，待核实：' : ''}患者自述：胸痛两天了。`)
  expect(detail.consultationRecording).toMatchObject({ remainingCount: 0, failedCount: 0,
    additions: [{ status: 'applied' }] })
  expect(calls).toBe(2)
})

it('settles repeated in-flight manual saves without appending stale history and allows an explicit retry', async () => {
  let changing = true
  let calls = 0
  const fixture = await setup({ reply: '胸痛两天了。', extract: async input => {
    const payload = input.userPayload as { turns: Array<{ id: string }> }
    if (changing) expect((await fixture.save(`医生核对：睡眠正常。第${++calls}次核对。`)).status).toBe(200)
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
      quote: '胸痛两天了。', relation: 'addition' }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(calls).toBe(1)
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe('医生核对：睡眠正常。第1次核对。')
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'failed', remainingCount: 1,
    failures: [{ code: 'CONSULTATION_RECORDING_SOURCE_INVALID', retrying: false }], additions: [] })
  await fixture.restart()
  changing = false
  expect((await fixture.control('retry')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness)
    .toBe('医生核对：睡眠正常。第1次核对。\n患者自述：胸痛两天了。')
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'updated', remainingCount: 0 })
})

it.each(['manual-source', 'wrong-field', 'fabricated-target'] as const)('rejects %s in a handwritten history comparison without changing the draft', async invalid => {
  const fixture = await setup({ reply: '胸痛两天了。', extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }>;
      manualHistory: Array<{ id: string; field: string; text: string }> }
    const target = payload.manualHistory.find(item => item.text === '医生核对：否认胸痛。')!
    return { additions: [{ field: invalid === 'wrong-field' ? 'priorMedicalHistory' : 'historyOfPresentIllness',
      sourceTurnId: payload.turns.at(-1)!.id, quote: invalid === 'manual-source' ? target.text : '胸痛两天了。',
      relation: 'conflict', targetAdditionId: invalid === 'fabricated-target' ? 'manual:made-up' : target.id }] }
  } })
  expect((await fixture.save('医生核对：否认胸痛。')).status).toBe(200)
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const detail = await fixture.read()
  expect(detail.clinicalDocument?.draft?.historyOfPresentIllness).toBe('医生核对：否认胸痛。')
  expect(detail.consultationRecording).toMatchObject({ status: 'failed', additions: [], failures: [
    { code: 'CONSULTATION_RECORDING_SOURCE_INVALID', retrying: false },
  ] })
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

it('retains invalid sentence fragments for explicit recovery without automatic reruns', async () => {
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
  expect((await fixture.read()).consultationRecording?.failedCount).toBe(1)
  expect((await fixture.control('retry')).status).toBe(200)
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
  fixture.runtime.database.driver.prepare('DELETE FROM consultation_recording_verification').run()
  fixture.runtime.database.driver.prepare('DELETE FROM consultation_history_addition_batch').run()
  fixture.runtime.database.driver.prepare('DELETE FROM consultation_history_addition WHERE case_id = ? AND addition_id != ?')
    .run(fixture.started.outpatientCaseId, originalId)
  fixture.runtime.database.driver.prepare(`UPDATE consultation_history_addition SET quote = ?, facts_json = NULL, ownership = 'automatic',
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

it('records ambiguous contradictory patient history while preserving the previous account', async () => {
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
  expect(await fixture.read()).toMatchObject({ clinicalDocument: { draft: { historyOfPresentIllness: '患者自述：头晕一周了。\n患者自述存在矛盾，待核实：患者自述：头晕五天了。', version: 2 } },
    consultationRecording: { status: 'updated', additions: [{ status: 'applied' }, { status: 'applied', currentText: '患者自述存在矛盾，待核实：患者自述：头晕五天了。' }] } })
})

async function createDoctorGrant(runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>, adminCookie: string,
  operationId: 'encounter.consultation.ask' | 'encounter.consultation.reply.retry' | 'encounter.consultation-recording.control'
    | 'encounter.clinical-document.sign.cancel') {
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

it.each(['active', 'disable', 'revoke'] as const)('resumes unfinished recording with a cancel-only Agent Grant only while it is %s', async action => {
  const fixture = await setup()
  expect((await fixture.ask()).status).toBe(200)
  const actions = await signing(fixture)
  await actions.save()
  const preview = await actions.preview()
  const { adminHeaders, client, grant } = await createDoctorGrant(fixture.runtime, fixture.started.adminCookie,
    'encounter.clinical-document.sign.cancel')
  expect(grant.operationIds).toEqual(['command.receipt.get', 'encounter.clinical-document.sign.cancel'])
  const detail = await fixture.read()
  const cancelled = await fixture.runtime.app.request(`/api/his/v1/encounters/${fixture.started.encounterId}/clinical-document/actions/cancel-sign`, {
    method: 'POST', headers: { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json',
      'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: { [`Encounter/${fixture.started.encounterId}`]: detail.encounter.versionId },
      input: { previewId: preview.previewId } }),
  })
  expect(cancelled.status).toBe(200)
  expect(cancelClinicalDocumentSignResponseSchema.parse(await cancelled.json()).data.previewId).toBe(preview.previewId)
  const resumed = await fixture.read()
  expect(resumed.consultationRecording?.signingPreparation).toBeUndefined()
  expect(resumed.consultationRecording).toMatchObject({ status: 'processing', processedCount: 0, remainingCount: 1 })
  if (action !== 'active') {
    const path = action === 'disable' ? `/api/agent/v1/clients/${client.agentClientId}/actions/disable`
      : `/api/agent/v1/grants/${grant.grantId}/actions/revoke`
    expect((await fixture.runtime.app.request(path, { method: 'POST', body: '{}',
      headers: { ...adminHeaders, 'idempotency-key': randomUUID() } })).status).toBe(200)
    if (action === 'revoke') {
      const replacement = await fixture.runtime.app.request('/api/agent/v1/grants', {
        method: 'POST', headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
        body: JSON.stringify({ agentClientId: client.agentClientId, operationIds: ['encounter.clinical-document.sign.cancel'],
          practitionerRoleId: 'practitioner-role-outpatient-doctor', ttlSeconds: 3600 }),
      })
      expect(replacement.status).toBe(200)
      expect(agentCapabilityGrantSchema.parse(await replacement.json()).grantId).not.toBe(grant.grantId)
    }
  }
  await fixture.restart()
  await fixture.runtime.dispatchPending()
  const after = await fixture.read()
  expect(after.consultationRecording?.signingPreparation).toBeUndefined()
  if (action === 'active') {
    expect(after.consultationRecording).toMatchObject({ status: 'updated', processedCount: 1, remainingCount: 0,
      failedCount: 0, failures: [], additions: [{ status: 'applied' }] })
    expect(after.clinicalDocument!.draft!.historyOfPresentIllness).toBe(
      `${actions.complete.historyOfPresentIllness}\n患者自述：头晕一周了，站起来时更明显。`)
  } else {
    expect(after.clinicalDocument?.draft).toEqual(resumed.clinicalDocument?.draft)
    expect(after.consultationRecording).toMatchObject({ status: 'failed', processedCount: 0, remainingCount: 1,
      failedCount: 1, additions: [], failures: [{ code: 'CONSULTATION_RECORDING_CONTEXT_INACTIVE', retrying: false }] })
  }
})

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
  expect(extraction.userPayload).toEqual({ turns: expect.any(Array), history: [], rejectedFacts: [], currentSourceIds: [expect.stringMatching(/^t\d+$/)] })
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
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'failed',
    failures: [{ code: 'AI_REQUEST_FAILED', retrying: false }] })
  expect((await fixture.control('retry')).status).toBe(200)
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
  for (let failure = 0; failure < earlierFailures; failure += 1) {
    await fixture.runtime.dispatchPending()
    expect((await fixture.control('retry')).status).toBe(200)
  }
  const processing = fixture.runtime.dispatchPending()
  await extracting
  await fixture.restart()
  await processing
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'processing', failures: [] })
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'updated', failures: [] })
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe('患者自述：头晕一周了，站起来时更明显。')
})

it.each(['没有胸痛。', '之前没有胸痛。后来也没有胸痛。'])('rejects a quote that removes the patient negation instead of recording chest pain (%s)', async reply => {
  const { runtime, ask, read } = await setup({ reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', quote: '胸痛。',
      sourceTurnId: payload.turns.at(-1)!.id, relation: 'addition' }] }
  } })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  const detail = await read()
  expect(detail.clinicalDocument?.draft).toBeUndefined()
  expect(detail.consultationRecording).toMatchObject({ status: 'failed', additions: [] })
})

it.each(['之前没有胸痛。胸痛。', '我不清楚，胸痛。胸痛。'])('records a later complete statement when an earlier substring is not a valid citation (%s)', async reply => {
  const fixture = await setup({ reply, extract: input => {
    const turns = (input.userPayload as { turns: Array<{ id: string }> }).turns
    return { additions: [{ field: 'historyOfPresentIllness', quote: '胸痛。',
      sourceTurnId: turns.at(-1)!.id, relation: 'addition' }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const detail = await fixture.read()
  expect(detail.consultation!.turns.at(-1)!.messageText).toBe(reply)
  expect(detail.clinicalDocument?.draft).toMatchObject({ historyOfPresentIllness: '患者自述：胸痛。', version: 1 })
  expect(detail.consultationRecording).toMatchObject({ status: 'updated', processedCount: 1, remainingCount: 0,
    failures: [], additions: [{ sourceTurnId: detail.consultation!.turns.at(-1)!.id, quote: '胸痛。', status: 'applied' }] })
  expect(fixture.requests.filter(request => request.schemaName === 'consultation_history_increment')).toHaveLength(1)
})

it.each([false, true])('repairs malformed output once within each recording attempt (manual retry: %s)', async manualRetry => {
  const prompts: string[] = []
  let retryEnabled = false
  const uncertain = '凉水酸那一下像是那边，是不是同一颗我说不准。'
  const confirmed = '牙上没见发黑，也没觉着缺。'
  const provider = new DshModelProvider({
    origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters',
    timeoutMs: 2000, maxResponseBytes: 8192,
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { model: string; systemPrompt: string;
        userPayload: { turns: Array<{ id: string }> } }
      prompts.push(request.systemPrompt)
      const repaired = request.systemPrompt.includes('previous response failed validation')
      const valid = repaired && (!manualRetry || retryEnabled)
      return Response.json({ model: request.model, content: JSON.stringify({ additions: [{
        field: 'historyOfPresentIllness', relation: 'addition',
        sourceTurnId: valid ? request.userPayload.turns.at(-1)!.id : undefined,
        quote: valid ? confirmed : uncertain,
      }] }) })
    },
  })
  const fixture = await setup({ reply: `${uncertain}${confirmed}`, extract: async input => {
    const result = await provider.completeJson({ ...input, model: 'dsh:{"provider":"synthetic","model":"synthetic"}' })
    return JSON.parse(result.content)
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  if (manualRetry) {
    const failed = await fixture.read()
    expect(failed.consultationRecording).toMatchObject({ status: 'failed', processedCount: 0, remainingCount: 1,
      failures: [{ code: 'AI_RESPONSE_INVALID', retrying: false }], additions: [] })
    expect(failed.clinicalDocument?.draft).toBeUndefined()
    expect(failed.consultation?.turns.at(-1)?.messageText).toBe(`${uncertain}${confirmed}`)
    expect(prompts).toHaveLength(2)
    retryEnabled = true
    expect((await fixture.control('retry')).status).toBe(200)
    await fixture.runtime.dispatchPending()
  }
  expect(await fixture.read()).toMatchObject({
    consultationRecording: { status: 'updated', processedCount: 1, remainingCount: 0, failures: [] },
    clinicalDocument: { draft: { historyOfPresentIllness: `患者自述：${confirmed}` } },
  })
  expect(prompts).toHaveLength(manualRetry ? 4 : 2)
  expect(prompts.at(-1)).toContain('additions.0.facts.0.sourceIds')
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
  if (name === 'unknown answer') {
    expect((await read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe('患者自述：我不知道。')
    expect((await read()).consultationRecording?.verification).toMatchObject({ pendingCount: 0, flaggedCount: 0, failedCount: 0 })
  } else {
    expect((await read()).clinicalDocument?.draft).toBeUndefined()
    expect((await read()).consultationRecording).toMatchObject({ status: 'failed', additions: [] })
  }
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
  const { ask, read, runtime, started, cookie, control } = await setup({ extract: input => {
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
  expect((await read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe('医生手工核对的病史。')
  expect((await control('retry')).status).toBe(200)
  await runtime.dispatchPending()
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

it.each(['头晕一周了。', '头晕一周了'])('deduplicates ordinary additions across alternate sentence endings (%s)', async quote => {
  let firstSource = ''
  const alternate = quote.endsWith('。') ? quote.slice(0, -1) : `${quote}。`
  const fixture = await setup({ reply: '头晕一周了。', extract: input => {
    const turns = (input.userPayload as { turns: Array<{ id: string }> }).turns
    const sourceTurnId = turns.at(-1)!.id
    const addition = { field: 'historyOfPresentIllness', sourceTurnId, quote, relation: 'addition' }
    if (!firstSource) { firstSource = sourceTurnId; return { additions: [addition] } }
    return { additions: [{ ...addition, sourceTurnId: firstSource, quote: alternate },
      { ...addition, quote: alternate }, addition] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const initial = await fixture.read()
  expect(initial.consultationRecording!.additions).toHaveLength(1)
  await fixture.restart()
  expect((await fixture.askMore()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const after = await fixture.read()
  expect(after.consultationRecording).toMatchObject({ status: 'updated', processedCount: 2, remainingCount: 0, failures: [] })
  expect(after.consultationRecording!.additions).toEqual(initial.consultationRecording!.additions)
  expect(after.clinicalDocument?.draft).toEqual(initial.clinicalDocument?.draft)
})

it.each(['disable', 'revoke'] as const)('settles a late recording as failed after Agent authorization %s', async action => {
  let release!: (value: unknown) => void
  let entered!: () => void
  let recordingSignal!: AbortSignal
  let sourceTurnId = ''
  const extracting = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<unknown>(resolve => { release = resolve })
  const { runtime, ask, read, started } = await setup({ extract: input => {
    recordingSignal = input.signal!
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
    expect(recordingSignal.aborted).toBe(true)
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
  let recordingSignal!: AbortSignal
  let sourceTurnId = ''
  const extracting = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<unknown>(resolve => { release = resolve })
  const { runtime, ask, started, cookie } = await setup({ extract: input => {
    recordingSignal = input.signal!
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
    expect(recordingSignal.aborted).toBe(true)
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

it.each([
  { field: 'familyHistory', reply: '我父亲患高血压。', text: '父亲患高血压，患者自述' },
  { field: 'allergyHistory', reply: '我用青霉素后出过皮疹。', text: '自述青霉素用药后出现皮疹' },
] as const)('records $field directly and persists sources across restart without a review operation', async ({ field, reply, text }) => {
  const fixture = await setup({ reply, extract: input => {
    const turn = summaryPayloadSchema.parse(input.userPayload).turns.at(-1)!
    return { additions: [{ field, relation: 'addition', facts: [{ text, sources: [{ sourceTurnId: turn.id, quote: reply }] }] }] }
  } })
  await fixture.save('医生记录：病史继续收集。')
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  const detail = await fixture.read()
  expect(detail.clinicalDocument!.draft).toMatchObject({ [field]: text, historyOfPresentIllness: '医生记录：病史继续收集。' })
  expect(detail.consultationRecording).toMatchObject({ status: 'updated', additions: [{ field, status: 'applied', summary: text }] })
  expect(detail.consultationRecording!.additions[0]).not.toHaveProperty('reviewStatus')
  const before = detail.clinicalDocument!.draft
  await fixture.restart()
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).clinicalDocument!.draft).toEqual(before)
  const removed = await fixture.runtime.app.request(`/api/his/v1/encounters/${fixture.started.encounterId}/consultation-history/actions/review`, { method: 'POST', headers: { cookie: fixture.cookie } })
  expect(removed.status).toBe(404)
})

it('merges verified multi-turn facts automatically without losing sources or manual text', async () => {
  let reply = firstFeverReply
  const fixture = await setup({ reply: () => reply, extract: feverSummaries })
  await fixture.save('医生记录：睡眠正常。')
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe('医生记录：睡眠正常。\n' + feverSummary)
  reply = secondFeverReply
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  const detail = await fixture.read()
  expect(detail.clinicalDocument!.draft!.historyOfPresentIllness).toBe('医生记录：睡眠正常。\n' + combinedFeverSummary)
  expect(detail.consultationRecording!.additions.map(item => item.status)).toEqual(['superseded', 'applied'])
  expect(detail.consultationRecording!.additions.at(-1)!.facts![0]!.sources).toHaveLength(2)
})

it('requeues old pending suggestions on upgrade and records them without writing on reads or duplicating on restart', async () => {
  const fixture = await setup()
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  const row = (await fixture.read()).consultationRecording!.additions[0]!
  await fixture.save('医生记录：睡眠正常。')
  fixture.runtime.database.driver.prepare('DELETE FROM consultation_recording_verification').run()
  fixture.runtime.database.driver.prepare('DELETE FROM consultation_history_addition_batch').run()
  fixture.runtime.database.driver.prepare("UPDATE consultation_history_addition SET addition_id = 'legacy:' || addition_id, status = 'pending', ownership = 'automatic', start_offset = NULL, end_offset = NULL, current_text = '' WHERE addition_id = ?").run(row.id)
  fixture.runtime.database.driver.prepare('DELETE FROM schema_migration WHERE migration_id = ?').run('0062_consultation-direct-recording.sql')
  await fixture.restart()
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe('医生记录：睡眠正常。')
  await fixture.runtime.dispatchPending()
  const detail = await fixture.read()
  expect(detail.clinicalDocument!.draft!.historyOfPresentIllness).toBe('医生记录：睡眠正常。\n患者自述：头晕一周了，站起来时更明显。')
  expect(detail.consultationRecording).toMatchObject({ status: 'updated', remainingCount: 0 })
  await fixture.restart()
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).clinicalDocument!.draft).toEqual(detail.clinicalDocument!.draft)
})

it.each(['preparing', 'signed'] as const)('discards an extraction that completes while %s and preserves the fixed document', async phase => {
  let release!: () => void
  let entered!: () => void
  let recordingSignal!: AbortSignal
  const held = new Promise<void>(resolve => { release = resolve })
  const extracting = new Promise<void>(resolve => { entered = resolve })
  const fixture = await setup({ extract: async input => {
    recordingSignal = input.signal!
    entered(); await held
    const answer = summaryPayloadSchema.parse(input.userPayload).turns.at(-1)!
    return { additions: [{ field: 'historyOfPresentIllness', relation: 'addition', sourceTurnId: answer.id, quote: answer.messageText }] }
  } })
  await fixture.ask()
  const processing = fixture.runtime.dispatchPending()
  await extracting
  let frozen: z.infer<typeof doctorCaseDetailSchema>['clinicalDocument']
  try {
    const actions = await signing(fixture)
    await actions.save()
    const preview = await actions.preview()
    expect(recordingSignal.aborted).toBe(true)
    if (phase === 'signed') expect((await actions.request('actions/sign', { previewId: preview.previewId, commitToken: preview.commitToken })).status).toBe(200)
    frozen = (await fixture.read()).clinicalDocument
  } finally { release(); await processing }
  expect((await fixture.read()).clinicalDocument).toEqual(frozen)
})

it.each(['job-with-grant', 'no-job-human'] as const)('upgrades a populated pre-0061 database and resumes report recording without losing legacy facts (%s)', async kind => {
  let reply = '头晕一周了。站起来时更明显。'
  const fixture = await setup({ reply: () => reply, resolveModel: async model => `${model}-legacy-route`, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string; kind: string; messageText: string }>; history: Array<{ id: string; quote: string }> }
    const answer = payload.turns.at(-1)!
    if (answer.kind === 'report') return { additions: [] }
    const target = reply.startsWith('刚才说错了') ? payload.history.find(row => row.quote === '头晕一周了。') : undefined
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: answer.id, quote: reply,
      relation: target === undefined ? 'addition' : 'correction', ...(target === undefined ? {} : { targetAdditionId: target.id }) }] }
  } })
  if (kind === 'job-with-grant') {
    const { grant } = await createDoctorGrant(fixture.runtime, fixture.started.adminCookie, 'encounter.consultation.ask')
    const actor = { authorization: `Bearer ${grant.token}` }
    expect((await fixture.ask(actor)).status).toBe(200)
    await fixture.runtime.dispatchPending()
    reply = '刚才说错了，头晕三天。'
    expect((await fixture.askMore(actor)).status).toBe(200)
    await fixture.runtime.dispatchPending()
    await fixture.save('患者自述：刚才说错了，头晕三天。\n医生核对：站立时更明显。')
    reply = '夜间也会头晕。'
    expect((await fixture.askMore(actor)).status).toBe(200)
    await fixture.runtime.dispatchPending()
    fixture.runtime.database.driver.prepare('UPDATE consultation_history_addition SET rejected = 1, undone = 1 WHERE addition_id = ?').run((await fixture.read()).consultationRecording!.additions.at(-1)!.id)
  } else {
    expect((await fixture.runtime.app.request(`/api/his/v1/encounters/${fixture.started.encounterId}/actions/start-first-visit`, {
      method: 'POST', headers: { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${fixture.started.encounterId}`]: fixture.started.encounterVersion,
        [`Task/${fixture.started.doctorTaskId}`]: '1' }, input: {} }),
    })).status).toBe(200)
  }
  const before = await fixture.read()
  const originalContext = z.object({ actor_context_json: z.string() }).parse(fixture.runtime.database.driver.prepare(
    'SELECT actor_context_json FROM consultation_recording WHERE case_id = ?').get(fixture.started.outpatientCaseId)).actor_context_json
  const snapshot = () => ({
    recording: fixture.runtime.database.driver.prepare('SELECT workspace_id, epoch, case_id, version, paused, start_sequence FROM consultation_recording ORDER BY case_id').all(),
    jobs: fixture.runtime.database.driver.prepare('SELECT * FROM consultation_recording_job ORDER BY turn_id').all(),
    models: fixture.runtime.database.driver.prepare('SELECT * FROM ai_model_binding ORDER BY task_id').all(),
    additions: fixture.runtime.database.driver.prepare('SELECT workspace_id, epoch, case_id, addition_id, field, source_turn_id, quote, relation, status, target_addition_id, ownership, start_offset, end_offset, current_text, review_state, review_status, rejected, undone, inverse_text, facts_json FROM consultation_history_addition ORDER BY addition_id').all(),
    receipts: fixture.runtime.database.driver.prepare('SELECT * FROM command_receipt ORDER BY operation, idempotency_key').all(),
  })
  const stored = snapshot()
  if (kind === 'job-with-grant') {
    expect(stored.jobs).toHaveLength(3)
    expect(stored.models.length).toBeGreaterThan(0)
    expect(stored.receipts.length).toBeGreaterThan(0)
    expect(JSON.stringify(stored.jobs)).toContain('agentGrantId')
    expect(before.consultationRecording!.additions.some(row => row.ownership === 'manual')).toBe(true)
    expect(before.consultationRecording!.additions.some(row => row.status === 'undone')).toBe(true)
    expect(stored.additions).toEqual(expect.arrayContaining([expect.objectContaining({ inverse_text: '患者自述：头晕一周了。' }),
      expect.objectContaining({ ownership: 'manual' }), expect.objectContaining({ rejected: 1, undone: 1 })]))
  }
  await fixture.restart(replaceWithPreSourceDatabase)
  expect(fixture.runtime.database.diagnostics()).toMatchObject({ schemaVersion: 81, foreignKeys: true, integrity: 'ok' })
  expect(fixture.runtime.database.driver.pragma('foreign_key_check')).toEqual([])
  expect(snapshot()).toEqual(stored)
  const upgraded = await fixture.read()
  expect(upgraded.consultationRecording!.requiresContextBinding).toBe(kind === 'no-job-human')
  expect(upgraded.clinicalDocument?.draft).toEqual(before.clinicalDocument?.draft)
  expect(upgraded.consultationRecording!.additions).toEqual(before.consultationRecording!.additions)
  if (kind === 'no-job-human') {
    expect(upgraded.consultationRecording!.requiresContextBinding).toBe(true)
    expect((await fixture.control('activate', { version: upgraded.consultationRecording!.version })).status).toBe(200)
    expect((await fixture.read()).consultationRecording!.requiresContextBinding).toBe(false)
  }
  useSyntheticLaboratoryCatalog(fixture.runtime)
  const detail = await fixture.read()
  const expectedVersions = { [`Encounter/${fixture.started.encounterId}`]: detail.encounter.versionId }
  const headers = { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json' }
  const draft = await fixture.runtime.app.request(`/api/his/v1/encounters/${fixture.started.encounterId}/laboratory-request/draft`, {
    method: 'PUT', headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions, input: { catalogItemId: 'lab-cbc', expectedDraftVersion: 0, indicationCode: 'fever' } }),
  })
  expect(draft.status).toBe(200)
  const saved = await draft.json() as { data: { draftVersion: number } }
  expect((await fixture.runtime.app.request(`/api/his/v1/encounters/${fixture.started.encounterId}/laboratory-request/actions/issue`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions, input: { expectedDraftVersion: saved.data.draftVersion } }),
  })).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).consultationRecording).toMatchObject({ remainingCount: 0,
    processedCount: kind === 'job-with-grant' ? 4 : 1, version: before.consultationRecording!.version })
  const reportContext = z.object({ actor_context_json: z.string() }).parse(fixture.runtime.database.driver.prepare(`SELECT job.actor_context_json FROM consultation_recording_job AS job
    JOIN consultation_recording_source AS source ON source.workspace_id = job.workspace_id AND source.epoch = job.epoch
      AND source.source_id = job.turn_id WHERE source.source_kind = 'report' AND job.case_id = ?
  `).get(fixture.started.outpatientCaseId))
  expect(JSON.parse(reportContext.actor_context_json)).toEqual(JSON.parse(originalContext))
})

it('records published laboratory values and conclusion with a fixed report version while paused', async () => {
  const fixture = await setup({ extract: input => {
    const source = (input.userPayload as { turns: Array<{ id: string; kind: string; messageText: string }> }).turns.at(-1)!
    return { additions: source.kind !== 'report' ? [] : [{ field: 'auxiliaryExamination', relation: 'addition',
      facts: [{ text: '本院检验白细胞计数11.2×10^9/L', sources: [{ sourceTurnId: source.id, quote: source.messageText.split('\n').at(-1)! }] }],
    }] }
  } })
  useSyntheticLaboratoryCatalog(fixture.runtime)
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  expect((await fixture.control('pause')).status).toBe(200)
  const detail = await fixture.read()
  const expectedVersions = { [`Encounter/${fixture.started.encounterId}`]: detail.encounter.versionId }
  const headers = { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json' }
  const draft = await fixture.runtime.app.request(`/api/his/v1/encounters/${fixture.started.encounterId}/laboratory-request/draft`, {
    method: 'PUT', headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions, input: { catalogItemId: 'lab-cbc', expectedDraftVersion: 0, indicationCode: 'fever' } }),
  })
  expect(draft.status).toBe(200)
  const saved = await draft.json() as { data: { draftVersion: number } }
  const issued = await fixture.runtime.app.request(`/api/his/v1/encounters/${fixture.started.encounterId}/laboratory-request/actions/issue`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions, input: { expectedDraftVersion: saved.data.draftVersion } }),
  })
  expect(issued.status).toBe(200)
  const actions = await signing(fixture)
  await actions.save()
  const preview = await actions.preview()
  await fixture.runtime.dispatchPending()
  const published = await fixture.read()
  const report = published.laboratoryRequests!.requests[0]!.report!
  const source = published.consultationRecording!.sources!.find(source => source.kind === 'report')!
  expect(source).toMatchObject({ reportReference: `DiagnosticReport/${report.diagnosticReportId}/_history/1` })
  expect(source.messageText).toContain(report.conclusion)
  expect(source.messageText).toContain('11.2')
  expect(published.consultationRecording).toMatchObject({ status: 'paused', remainingCount: 1 })
  expect((await actions.request('actions/sign', { previewId: preview.previewId, commitToken: preview.commitToken })).status).toBe(409)
  expect(published.clinicalDocument?.signed).toHaveLength(0)
  expect((await actions.request('actions/cancel-sign', { previewId: preview.previewId })).status).toBe(200)
  await fixture.restart()
  expect((await fixture.read()).consultationRecording!.sources!.find(item => item.kind === 'report')).toEqual(source)
  expect((await fixture.control('resume')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).clinicalDocument!.draft).toMatchObject({ auxiliaryExamination: '本院检验白细胞计数11.2×10^9/L' })
  expect((await fixture.read()).consultationRecording).toMatchObject({ remainingCount: 0, status: 'updated' })
})

it('records a published report before the first patient question using the assigned doctor context', async () => {
  const fixture = await setup({ extract: input => {
    const source = (input.userPayload as { turns: Array<{ id: string; kind: string; messageText: string }> }).turns.at(-1)!
    return { additions: source.kind !== 'report' ? [] : [{ field: 'auxiliaryExamination', relation: 'addition',
      facts: [{ text: '本院检验白细胞计数11.2×10^9/L', sources: [{ sourceTurnId: source.id, quote: source.messageText.split('\n').at(-1)! }] }],
    }] }
  } })
  useSyntheticLaboratoryCatalog(fixture.runtime)
  const headers = { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json' }
  const start = await fixture.runtime.app.request(`/api/his/v1/encounters/${fixture.started.encounterId}/actions/start-first-visit`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {
      [`Encounter/${fixture.started.encounterId}`]: fixture.started.encounterVersion, [`Task/${fixture.started.doctorTaskId}`]: '1',
    }, input: {} }),
  })
  expect(start.status).toBe(200)
  const expectedVersions = { [`Encounter/${fixture.started.encounterId}`]: (await fixture.read()).encounter.versionId }
  const draft = await fixture.runtime.app.request(`/api/his/v1/encounters/${fixture.started.encounterId}/laboratory-request/draft`, {
    method: 'PUT', headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions, input: { catalogItemId: 'lab-cbc', expectedDraftVersion: 0, indicationCode: 'fever' } }),
  })
  expect(draft.status).toBe(200)
  const saved = await draft.json() as { data: { draftVersion: number } }
  const issued = await fixture.runtime.app.request(`/api/his/v1/encounters/${fixture.started.encounterId}/laboratory-request/actions/issue`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions, input: { expectedDraftVersion: saved.data.draftVersion } }),
  })
  expect(issued.status).toBe(200)
  await fixture.runtime.dispatchPending()
  const result = await fixture.read()
  expect(result.consultation!.turns.filter(turn => turn.kind === 'text')).toHaveLength(1)
  expect(result.clinicalDocument?.draft).toMatchObject({ auxiliaryExamination: '本院检验白细胞计数11.2×10^9/L' })
  expect(result.consultationRecording).toMatchObject({ remainingCount: 0, status: 'updated', processedCount: 1 })
})
