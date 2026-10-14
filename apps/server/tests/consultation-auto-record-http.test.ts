import { apiErrorSchema, sessionContextSchema, clinicalDocumentDraftContentSchema, clinicalDocumentDraftResponseSchema, consultationHistoryFactSchema, controlConsultationRecordingResponseSchema, doctorCaseDetailSchema, reviewConsultationHistoryResponseSchema, sendConsultationMessageResponseSchema, triageQueueSchema, type ConsultationHistoryDecision } from '@clinmesh/contracts/his'
import { agentCapabilityGrantSchema, agentClientSchema } from '@clinmesh/contracts/agent'
import { clinicalDocumentSignPreviewResponseSchema, clinicalDocumentSignResponseSchema, cancelClinicalDocumentSignResponseSchema } from '@clinmesh/contracts/his'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { ChatCompletionsError } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { DshModelProvider } from '../src/infrastructure/ai/dsh-model-provider.ts'
import type { JsonChatCompletionInput, JsonChatCompletionsProvider } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'
import { recordingFixtureProvider } from './fixtures/consultation-history.ts'
import { applyMigrations } from '../src/infrastructure/sqlite/database.ts'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })

const summaryPayloadSchema = z.object({
  turns: z.array(z.object({ id: z.string(), speaker: z.string(), messageText: z.string() })),
  history: z.array(z.object({ id: z.string(), field: z.string(), text: z.string() })),
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

const faithfulSummaryVerification = (input: JsonChatCompletionInput) => ({ additions:
  z.object({ additions: z.array(z.unknown()) }).parse(input.userPayload).additions.map((_, index) => ({
    index, faithful: true, complete: true, relationValid: true,
  })) })

async function setup(options: {
  recording?: boolean
  now?: () => Date
  failFirstReply?: boolean
  reply?: string | (() => string)
  extract?: (input: JsonChatCompletionInput) => Promise<unknown> | unknown
  verify?: (input: JsonChatCompletionInput) => unknown
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
    ...(options.now === undefined ? {} : { now: options.now }),
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters',
    chatCompletionsProvider: recordingFixtureProvider(provider, options.verify), databasePath: join(directory, 'clinmesh.sqlite'),
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
  const askMore = async () => {
    const detail = await read()
    return runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/ask-consultation-question`, {
      method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
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
  const control = async (action: 'pause' | 'resume' | 'backfill' | 'retry', options: { key?: string; version?: number; headers?: Record<string, string> } = {}) => {
    const detail = await read()
    return runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/consultation-recording/actions/control`, {
      method: 'POST', headers: { ...(options.headers ?? { cookie }), origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': options.key ?? randomUUID() },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${started.encounterId}`]: detail.encounter.versionId },
        input: { action, expectedRecordingVersion: options.version ?? detail.consultationRecording?.version ?? 0 } }),
    })
  }
  const review = async (additionId: string, decision: ConsultationHistoryDecision,
    options: { key?: string; version?: number; headers?: Record<string, string> } = {}) => {
    const detail = await read()
    const response = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/consultation-history/actions/review`, {
      method: 'POST', headers: { ...(options.headers ?? { cookie }), origin: 'http://localhost',
        'content-type': 'application/json', 'idempotency-key': options.key ?? randomUUID() },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${started.encounterId}`]: detail.encounter.versionId },
        input: { additionId, decision, expectedDraftVersion: options.version ?? detail.clinicalDocument?.draft?.version ?? 0 } }),
    })
    if (response.status === 200) reviewConsultationHistoryResponseSchema.parse(await response.clone().json())
    return response
  }
  // Ownership, source and signing regressions start from physician-applied text.
  // Exercise the public review Command explicitly; generation itself stays read-only.
  const applySuggestions = async () => {
    const detail = await read()
    if (detail.consultationRecording?.signingPreparation?.active || detail.clinicalDocument?.signed.length) return
    for (const addition of (await read()).consultationRecording?.additions ?? []) {
      if (addition.status !== 'pending' || !addition.reviewable || addition.relation === 'conflict') continue
      const current = await read()
      const target = current.consultationRecording?.additions.find(item => item.id === addition.targetAdditionId)
      if (addition.targetAdditionId?.startsWith('manual:') || target?.ownership === 'manual') continue
      const field = current.clinicalDocument?.draft?.[addition.field] ?? ''
      const text = addition.summary || `患者自述：${addition.quote}`
      const length = target === undefined ? field.length + (field ? 1 : 0) + text.length
        : field.length - addition.currentText.length + text.length
      const limit = addition.field === 'chiefComplaint' ? 1_000 : addition.field === 'historyOfPresentIllness' ? 5_000 : 4_000
      if (length > limit) continue
      expect((await review(addition.id, 'accept')).status).toBe(200)
    }
  }
  return { get runtime() { return runtime }, read, ask, askMore, requests, started, cookie, save, control, review, applySuggestions,
    restart: async () => { await runtime.close(); runtime = await createRuntime() } }
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

it.each([
  { field: 'familyHistory', reply: '我父亲患高血压。', text: '父亲患高血压，患者自述' },
  { field: 'allergyHistory', reply: '我用青霉素后出过皮疹。', text: '自述青霉素用药后出现皮疹' },
] as const)('persists independent $field suggestions, applies explicitly and undoes without removing manual text', async ({ field, reply, text }) => {
  const fixture = await setup({ reply, extract: input => {
    expect(input.systemPrompt).toContain('familyHistory 是家族史；allergyHistory 是过敏自述')
    const turn = summaryPayloadSchema.parse(input.userPayload).turns.at(-1)!
    return { additions: [{ field, relation: 'addition', facts: [{ text, sources: [{ sourceTurnId: turn.id, quote: reply }] }] }] }
  } })
  await fixture.save('医生记录：病史继续收集。')
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  const suggestion = (await fixture.read()).consultationRecording!.additions[0]!
  expect(suggestion).toMatchObject({ field, status: 'pending', summary: text })
  expect((await fixture.read()).clinicalDocument!.draft![field]).toBeUndefined()
  await fixture.restart()
  expect((await fixture.review(suggestion.id, 'accept')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument!.draft).toMatchObject({ [field]: text, historyOfPresentIllness: '医生记录：病史继续收集。' })
  await fixture.save(text + '\n医生补充：需进一步核实。', field)
  await fixture.restart()
  expect((await fixture.review(suggestion.id, 'undo')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument!.draft![field]).toBe('医生补充：需进一步核实。')
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
  const response = await sign.request('actions/sign', { commitToken: preview.commitToken, previewId: preview.previewId, consultationReviewed: true })
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

it('upgrades the old three-field history constraint without changing existing sources, review, anchors, inverses or order', async () => {
  const fixture = await setup()
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  await fixture.save('医生手工记录。\n' + (await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness)
  const database = fixture.runtime.database
  const rows = () => database.driver.prepare('SELECT * FROM consultation_history_addition ORDER BY rowid').all()
  const before = rows()
  const migration = readFileSync(new URL('../drizzle/0061_clinical-document-history-fields.sql', import.meta.url), 'utf8')
  database.driver.exec(migration.replace(
    "'priorMedicalHistory', 'familyHistory', 'allergyHistory'", "'priorMedicalHistory'"))
  database.driver.prepare("DELETE FROM schema_migration WHERE migration_id = '0061_clinical-document-history-fields.sql'").run()
  expect(rows()).toEqual(before)
  expect(applyMigrations(database).applied).toEqual(['0061_clinical-document-history-fields.sql'])
  expect(rows()).toEqual(before)
  expect(database.driver.pragma('foreign_key_check')).toEqual([])
  await fixture.restart()
  const addition = (await fixture.read()).consultationRecording!.additions.find(item => item.status === 'applied')!
  expect((await fixture.review(addition.id, 'undo')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe('医生手工记录。')
})

it('keeps new and updated suggestions out of the draft until individually applied, persists pending updates and undoes only applied text', async () => {
  let reply = firstFeverReply
  const fixture = await setup({ reply: () => reply, extract: feverSummaries })
  await fixture.save('医生记录：睡眠正常。')
  const before = (await fixture.read()).clinicalDocument!.draft
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  const first = (await fixture.read()).consultationRecording!.additions[0]!
  expect(first).toMatchObject({ status: 'pending', reviewable: true, currentText: '' })
  expect((await fixture.read()).clinicalDocument!.draft).toEqual(before)
  reply = secondFeverReply
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  const pending = (await fixture.read()).consultationRecording!.additions.at(-1)!
  expect(pending).toMatchObject({ status: 'pending', reviewable: true, summary: combinedFeverSummary })
  expect((await fixture.read()).consultationRecording!.additions[0]!.status).toBe('superseded')
  expect((await fixture.read()).clinicalDocument!.draft).toEqual(before)
  await fixture.restart()
  expect((await fixture.read()).consultationRecording!.additions.at(-1)).toEqual(pending)
  expect((await fixture.review(first.id, 'accept')).status).toBe(409)
  const key = randomUUID()
  expect((await fixture.review(pending.id, 'accept', { key, version: before!.version })).status).toBe(200)
  expect((await fixture.review(pending.id, 'accept', { key, version: before!.version })).status).toBe(200)
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe('医生记录：睡眠正常。\n' + combinedFeverSummary)
  expect((await fixture.read()).consultationRecording!.additions.at(-1)).toMatchObject({ status: 'applied', reviewStatus: 'confirmed' })
  await fixture.save('医生记录：睡眠正常。\n' + combinedFeverSummary + '\n医生补充：尚待查体。')
  expect((await fixture.review(pending.id, 'undo')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe('医生记录：睡眠正常。\n医生补充：尚待查体。')
})

it('retains all four rounds of facts when pending updates form a chain over applied history', async () => {
  const replies = ['头晕一周了。', '夜间也会头晕。', '站起来时更明显。', '今天有些乏力。']
  const texts = ['自述头晕一周', '夜间头晕', '站立时加重', '今天乏力']
  const payloadSchema = summaryPayloadSchema.extend({
    history: z.array(summaryPayloadSchema.shape.history.element.extend({ facts: z.array(consultationHistoryFactSchema) })),
  })
  let round = 0
  const fixture = await setup({ reply: () => replies[round]!, verify: faithfulSummaryVerification, extract: input => {
    const payload = payloadSchema.parse(input.userPayload)
    // Preserve the selected target's facts, as required by the model contract.
    const target = payload.history.find(item => item.field === 'historyOfPresentIllness')
    const answer = payload.turns.at(-1)!
    return { additions: [{ field: 'historyOfPresentIllness', relation: target === undefined ? 'addition' : 'update',
      ...(target === undefined ? {} : { targetAdditionId: target.id }),
      facts: [...target?.facts ?? [], { text: texts[round]!, sources: [{ sourceTurnId: answer.id, quote: answer.messageText }] }],
    }] }
  } })
  const manual = '医生记录：睡眠正常。'
  expect((await fixture.save(manual)).status).toBe(200)
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const first = (await fixture.read()).consultationRecording!.additions[0]!
  expect((await fixture.review(first.id, 'accept')).status).toBe(200)
  const appliedDraft = (await fixture.read()).clinicalDocument!.draft!
  for (round = 1; round < replies.length; round += 1) {
    if (round === 3) await fixture.restart()
    expect((await fixture.askMore()).status).toBe(200)
    await fixture.runtime.dispatchPending()
  }
  const detail = await fixture.read()
  const latest = detail.consultationRecording!.additions.at(-1)!
  expect(detail.consultationRecording!.failedCount).toBe(0)
  expect(detail.clinicalDocument!.draft).toEqual(appliedDraft)
  expect(latest).toMatchObject({ status: 'pending', reviewable: true, summary: texts.join('；') })
  expect(latest.facts!.flatMap(fact => fact.sources.map(source => source.quote))).toEqual(replies)
  expect(detail.consultationRecording!.additions.map(item => item.status)).toEqual(['applied', 'superseded', 'superseded', 'pending'])
  expect((await fixture.review(latest.id, 'accept')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(manual + '\n' + texts.join('；'))
  expect((await fixture.review(latest.id, 'undo')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(appliedDraft.historyOfPresentIllness)
  expect((await fixture.read()).consultationRecording!.additions[0]).toMatchObject({ id: first.id, status: 'applied' })
})

it('creates the first draft only on application and preserves ignored suggestions across restart and old-source replay', async () => {
  let replay = false
  const fixture = await setup({ extract: input => {
    const payload = summaryPayloadSchema.parse(input.userPayload)
    const source = replay ? payload.turns.find(turn => turn.speaker === 'patient' && turn.messageText.includes('头晕'))!
      : payload.turns.at(-1)!
    return { additions: [{ field: 'historyOfPresentIllness', relation: 'addition',
      facts: [{ text: '自述头晕一周，站立时加重', sources: [{ sourceTurnId: source.id, quote: source.messageText }] }] }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).clinicalDocument?.draft).toBeUndefined()
  const addition = (await fixture.read()).consultationRecording!.additions[0]!
  expect((await fixture.review(addition.id, 'ignore')).status).toBe(200)
  await fixture.restart()
  replay = true
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).consultationRecording!.additions).toMatchObject([{ id: addition.id, status: 'ignored' }])
  expect((await fixture.read()).clinicalDocument?.draft).toBeUndefined()
  replay = false
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  const next = (await fixture.read()).consultationRecording!.additions.at(-1)!
  expect(next).toMatchObject({ status: 'pending', reviewable: true })
  expect((await fixture.review(next.id, 'accept')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument!.draft).toMatchObject({ version: 1, historyOfPresentIllness: next.summary })
})

it('waits for explicit application of an applied summary update and preserves it through a stale draft version', async () => {
  let reply = firstFeverReply
  const fixture = await setup({ reply: () => reply, extract: feverSummaries })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  const first = (await fixture.read()).consultationRecording!.additions[0]!
  expect((await fixture.review(first.id, 'accept')).status).toBe(200)
  const applied = (await fixture.read()).clinicalDocument!.draft!
  reply = secondFeverReply
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  const pending = (await fixture.read()).consultationRecording!.additions.at(-1)!
  expect(pending).toMatchObject({ status: 'pending', currentText: feverSummary, reviewable: true })
  expect((await fixture.read()).clinicalDocument!.draft).toEqual(applied)
  await fixture.save(feverSummary + '\n医生补充：待查体。')
  expect((await fixture.review(pending.id, 'accept', { version: applied.version })).status).toBe(409)
  await fixture.restart()
  expect((await fixture.read()).consultationRecording!.additions.at(-1)).toEqual(pending)
  expect((await fixture.review(pending.id, 'accept')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(combinedFeverSummary + '\n医生补充：待查体。')
  expect((await fixture.review(pending.id, 'undo')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(feverSummary + '\n医生补充：待查体。')
})

it.each([
  { rewritten: false, alias: false }, { rewritten: true, alias: false },
  { rewritten: false, alias: true }, { rewritten: true, alias: true },
])('tracks superseded manual-target suggestions through unrelated edits or rewritten targets: %j', async ({ rewritten, alias }) => {
  let reply = '胸痛两天了。'
  const original = '医生核对：否认胸痛。'
  const fixture = await setup({ reply: () => reply, verify: faithfulSummaryVerification, extract: input => {
    const payload = z.object({
      turns: summaryPayloadSchema.shape.turns,
      history: summaryPayloadSchema.shape.history,
      manualHistory: z.array(z.object({ id: z.string(), text: z.string() })),
    }).parse(input.userPayload)
    const first = payload.turns.find(turn => turn.messageText === '胸痛两天了。')!
    const last = payload.turns.at(-1)!
    return { additions: [{ field: 'historyOfPresentIllness', relation: payload.history.length === 0 ? 'conflict' : 'update',
      targetAdditionId: (alias ? undefined : payload.history[0]?.id) ?? payload.manualHistory.find(item => item.text === original)!.id,
      facts: [{ text: last.id === first.id ? '自述胸痛两天' : '自述胸痛两天，活动后加重',
        sources: [first, ...(last.id === first.id ? [] : [last])].map(turn => ({ sourceTurnId: turn.id, quote: turn.messageText })) }] }] }
  } })
  await fixture.save(original + '\n睡眠正常。')
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  const first = (await fixture.read()).consultationRecording!.additions[0]!
  reply = '活动后更痛。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  const next = (await fixture.read()).consultationRecording!.additions.at(-1)!
  expect((await fixture.read()).consultationRecording!.additions[0]!.status).toBe('superseded')
  expect(next).toMatchObject({ status: 'pending', currentText: original, reviewable: true })
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(original + '\n睡眠正常。')
  const target = rewritten ? '医生核对：胸痛待明确。' : original
  await fixture.save('医生补充：🙂待查体。\n' + target + '\n睡眠正常。')
  await fixture.restart()
  expect((await fixture.review(first.id, 'accept')).status).toBe(409)
  expect((await fixture.read()).consultationRecording!.additions.at(-1)!.reviewable).toBe(!rewritten)
  expect((await fixture.review(next.id, 'accept')).status).toBe(rewritten ? 409 : 200)
  if (!rewritten) {
    expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe('医生补充：🙂待查体。\n自述胸痛两天，活动后加重\n睡眠正常。')
    expect((await fixture.review(next.id, 'undo')).status).toBe(200)
  }
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe('医生补充：🙂待查体。\n' + target + '\n睡眠正常。')
})

it('supersedes a pending correction when new evidence again targets the same manually edited applied fragment', async () => {
  let reply = '头晕一周了。'
  const manual = '医生核对：头晕四天。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = summaryPayloadSchema.extend({ manualHistory: z.array(z.object({ id: z.string(), text: z.string() })).default([]) }).parse(input.userPayload)
    const answer = payload.turns.at(-1)!
    const target = payload.manualHistory.find(item => item.text === manual)
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: answer.id, quote: answer.messageText,
      relation: target === undefined ? 'addition' : 'correction', ...(target === undefined ? {} : { targetAdditionId: target.id }) }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  expect((await fixture.review((await fixture.read()).consultationRecording!.additions[0]!.id, 'accept')).status).toBe(200)
  await fixture.save(manual)
  const draft = (await fixture.read()).clinicalDocument!.draft!
  reply = '刚才说错了，头晕三天。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  const old = (await fixture.read()).consultationRecording!.additions.at(-1)!
  reply = '刚才说错了，头晕两天。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  const detail = await fixture.read()
  const next = detail.consultationRecording!.additions.at(-1)!
  expect(detail.clinicalDocument!.draft).toEqual(draft)
  expect(detail.consultationRecording!.additions.find(addition => addition.id === old.id)!.status).toBe('superseded')
  expect(next).toMatchObject({ status: 'pending', reviewable: true, currentText: manual })
  expect((await fixture.review(old.id, 'accept')).status).toBe(409)
  expect((await fixture.review(next.id, 'accept')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe('患者自述：' + reply)
  expect((await fixture.review(next.id, 'undo')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(manual)
})

it('summarizes and merges multi-turn patient facts with persistent citations, deduplicates repeats and restores the predecessor on undo', async () => {
  let reply = firstFeverReply
  let repeated = false
  const fixture = await setup({ reply: () => reply,
    extract: input => repeated ? { additions: [] } : feverSummaries(input) })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(feverSummary)
  const first = (await fixture.read()).consultationRecording!.additions[0]!
  reply = secondFeverReply
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const merged = await fixture.read()
  expect(merged.clinicalDocument?.draft?.historyOfPresentIllness).toBe(combinedFeverSummary)
  const update = merged.consultationRecording!.additions.at(-1)!
  expect(update).toMatchObject({ relation: 'update', status: 'applied', summary: combinedFeverSummary,
    facts: [{ text: feverSummary, sources: [{ sourceTurnId: first.sourceTurnId, quote: firstFeverReply },
      { quote: secondFeverReply }] }, { text: '否认胸痛、气促', sources: [{ quote: secondFeverReply }] }] })
  expect(merged.consultationRecording!.additions[0]!.status).toBe('superseded')
  await fixture.restart()
  expect((await fixture.read()).consultationRecording!.additions.at(-1)).toEqual(update)
  repeated = true
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(combinedFeverSummary)
  expect((await fixture.read()).consultationRecording!.additions).toHaveLength(2)
  expect((await fixture.review(update.id, 'undo')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(feverSummary)
  expect((await fixture.read()).consultationRecording!.additions[0]).toMatchObject({
    status: 'applied', facts: first.facts, summary: first.summary,
  })
})

it('keeps a locally edited summary as a pending multi-source suggestion across restart and explicit acceptance', async () => {
  let reply = firstFeverReply
  const fixture = await setup({ reply: () => reply, extract: feverSummaries })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const manual = '医生核对：昨晚发热，体温数值待核对。'
  await fixture.save(manual)
  reply = secondFeverReply
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const pending = (await fixture.read()).consultationRecording!.additions.at(-1)!
  expect(pending).toMatchObject({ status: 'pending', currentText: manual, summary: combinedFeverSummary, reviewable: true })
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(manual)
  await fixture.restart()
  expect((await fixture.review(pending.id, 'accept')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(combinedFeverSummary)
  expect((await fixture.read()).consultationRecording!.additions.at(-1)).toMatchObject({
    status: 'applied', ownership: 'automatic', reviewStatus: 'confirmed', facts: pending.facts,
  })
})

it.each(['correction', 'conflict'] as const)('keeps both patient sources for a summarized %s and preserves the original on undo or before review', async relation => {
  let reply = firstFeverReply
  let second = false
  const revised = relation === 'correction' ? '昨晚起发热伴干咳，自述最高体温更正为38.0℃'
    : '昨晚起发热伴干咳；最高体温先述38.5℃，后述38.0℃，待核对'
  const fixture = await setup({ reply: () => reply, extract: input => {
    if (!second) return feverSummaries(input)
    const payload = summaryPayloadSchema.parse(input.userPayload)
    const first = payload.turns.find(turn => turn.messageText === firstFeverReply)!
    const last = payload.turns.at(-1)!
    return { additions: [{ field: 'historyOfPresentIllness', relation, targetAdditionId: payload.history[0]!.id,
      facts: [{ text: revised, sources: [{ sourceTurnId: first.id, quote: first.messageText },
        { sourceTurnId: last.id, quote: last.messageText }] }] }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  second = true
  reply = relation === 'correction' ? '刚才说错了，最高是38.0度。' : '最高是38.0度。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const suggestion = (await fixture.read()).consultationRecording!.additions.at(-1)!
  expect(suggestion).toMatchObject({ status: relation === 'correction' ? 'applied' : 'pending', summary: revised })
  expect(suggestion.facts![0]!.sources).toHaveLength(2)
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(relation === 'correction' ? revised : feverSummary)
  if (relation === 'correction') {
    expect((await fixture.review(suggestion.id, 'undo')).status).toBe(200)
    expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(feverSummary)
  }
})

it.each(['undo', 'ignore'] as const)('keeps a multi-source %s decision across reordered old citations while allowing new evidence', async decision => {
  let reply = firstFeverReply
  const fixture = await setup({ reply: () => reply, verify: faithfulSummaryVerification, extract: input => {
    const { turns, history } = summaryPayloadSchema.parse(input.userPayload)
    const first = turns.find(turn => turn.messageText === firstFeverReply)!
    const second = turns.findLast(turn => turn.messageText === secondFeverReply)
    if (second === undefined) return feverSummaries(input)
    const sources = turns.at(-1)!.messageText === '谢谢。' ? [first, second] : [second, first]
    return { additions: [{ field: 'historyOfPresentIllness', relation: 'update', targetAdditionId: history[0]!.id,
      facts: [{ text: combinedFeverSummary,
        sources: sources.map(source => ({ sourceTurnId: source.id, quote: source.messageText })) }] }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  if (decision === 'ignore') expect((await fixture.save('医生核对：昨晚发热，体温数值待核对。')).status).toBe(200)
  reply = secondFeverReply
  expect((await fixture.askMore()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const suggestion = (await fixture.read()).consultationRecording!.additions.at(-1)!
  expect(suggestion.status).toBe(decision === 'undo' ? 'applied' : 'pending')
  expect((await fixture.review(suggestion.id, decision)).status).toBe(200)
  await fixture.restart()
  const rejected = await fixture.read()
  reply = '谢谢。'
  expect((await fixture.askMore()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const replayed = await fixture.read()
  expect(replayed.clinicalDocument).toEqual(rejected.clinicalDocument)
  expect(replayed.consultationRecording!.additions).toEqual(rejected.consultationRecording!.additions)
  expect(replayed.consultationRecording).toMatchObject({ status: 'updated', failures: [] })
  reply = secondFeverReply
  expect((await fixture.askMore()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const fresh = await fixture.read()
  expect(fresh.consultationRecording!.additions).toHaveLength(rejected.consultationRecording!.additions.length + 1)
  expect(fresh.consultationRecording!.additions.at(-1)).toMatchObject({
    sourceTurnId: fresh.consultation!.turns.at(-1)!.id, status: decision === 'undo' ? 'applied' : 'pending',
  })
})

it('applies a verified correction when its explicit evidence follows another cited fact', async () => {
  let reply = firstFeverReply
  const revised = '昨晚起发热伴干咳；自述最高体温更正为38.0℃'
  const fixture = await setup({ reply: () => reply, verify: faithfulSummaryVerification, extract: input => {
    const { turns, history } = summaryPayloadSchema.parse(input.userPayload)
    if (reply === firstFeverReply) return feverSummaries(input)
    const first = turns.find(turn => turn.messageText === firstFeverReply)!
    const last = turns.at(-1)!
    return { additions: [{ field: 'historyOfPresentIllness', relation: 'correction', targetAdditionId: history[0]!.id,
      facts: [{ text: '昨晚起发热伴干咳', sources: [{ sourceTurnId: first.id, quote: first.messageText },
        { sourceTurnId: last.id, quote: '仍然咳嗽，没有痰。' }] },
      { text: '自述最高体温更正为38.0℃', sources: [{ sourceTurnId: first.id, quote: first.messageText },
        { sourceTurnId: last.id, quote: '刚才说错了，最高是38.0度。' }] }] }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  reply = '仍然咳嗽，没有痰。刚才说错了，最高是38.0度。'
  expect((await fixture.askMore()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const corrected = await fixture.read()
  const suggestion = corrected.consultationRecording!.additions.at(-1)!
  expect(suggestion).toMatchObject({ relation: 'correction', status: 'applied' })
  expect(corrected.clinicalDocument!.draft!.historyOfPresentIllness).toBe(revised)
  expect((await fixture.review(suggestion.id, 'undo')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(feverSummary)
})

it.each(['\n', '\r\n'])('accepts separately cited patient statements delimited by %j', async newline => {
  const reply = `发热三天${newline}最高量到38.5度`
  const fixture = await setup({ reply, verify: faithfulSummaryVerification, extract: input => {
    const turn = summaryPayloadSchema.parse(input.userPayload).turns.at(-1)!
    return { additions: [{ field: 'historyOfPresentIllness', relation: 'addition', facts: [
      { text: '发热三天', sources: [{ sourceTurnId: turn.id, quote: '发热三天' }] },
      { text: '自述最高体温38.5℃', sources: [{ sourceTurnId: turn.id, quote: '最高量到38.5度' }] },
    ] }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const recorded = await fixture.read()
  expect(recorded.consultationRecording).toMatchObject({ status: 'updated', failures: [] })
  expect(recorded.clinicalDocument!.draft!.historyOfPresentIllness).toBe('发热三天；自述最高体温38.5℃')
  expect(recorded.consultation!.turns.at(-1)!.messageText).toBe(reply)
})

it.each(['undo', 'ignore'] as const)('does not mix %s evidence into a later summary and allows the patient to provide it again', async decision => {
  const replies = ['头晕一周。', '昨天开始恶心。', '今天有乏力。', '昨天开始恶心。']
  const texts = ['头晕一周', '昨日起恶心', '今日乏力']
  let stage = 0
  const fixture = await setup({ reply: () => replies[stage]!, verify: faithfulSummaryVerification, extract: input => {
    const { turns, history } = summaryPayloadSchema.parse(input.userPayload)
    const answers = turns.filter(turn => replies.includes(turn.messageText))
    const facts = texts.slice(0, Math.min(stage + 1, 3)).map((text, index) => ({ text,
      sources: [{ sourceTurnId: answers[index]!.id, quote: answers[index]!.messageText },
        ...(stage === 3 && index === 1 ? [{ sourceTurnId: answers[3]!.id, quote: answers[3]!.messageText }] : [])],
    }))
    return { additions: [{ field: 'historyOfPresentIllness', relation: stage === 0 ? 'addition' : 'update',
      ...(stage === 0 ? {} : { targetAdditionId: history[0]!.id }), facts }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  if (decision === 'ignore') expect((await fixture.save('医生核对：头晕七天')).status).toBe(200)
  stage = 1
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const rejected = (await fixture.read()).consultationRecording!.additions.at(-1)!
  expect(rejected.status).toBe(decision === 'undo' ? 'applied' : 'pending')
  expect((await fixture.review(rejected.id, decision)).status).toBe(200)
  await fixture.restart()
  stage = 2
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  let current = (await fixture.read()).consultationRecording!.additions.at(-1)!
  expect(current.summary).toBe('头晕一周；今日乏力')
  expect(current.facts!.flatMap(fact => fact.sources)).not.toContainEqual({ sourceTurnId: rejected.sourceTurnId, quote: replies[1] })
  if (decision === 'ignore') expect((await fixture.review(current.id, 'accept')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe('头晕一周；今日乏力')
  stage = 3
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  current = (await fixture.read()).consultationRecording!.additions.at(-1)!
  expect(current.summary).toBe('头晕一周；昨日起恶心；今日乏力')
  expect(current.facts![1]!.sources).toHaveLength(1)
  expect(current.facts![1]!.sources[0]!.sourceTurnId).not.toBe(rejected.sourceTurnId)
  if (current.status === 'pending') expect((await fixture.review(current.id, 'accept')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(current.summary)
})

it('verifies a combined fact against its remaining sources after rejected evidence is removed', async () => {
  let stage = 0
  const replies = ['头晕一周。', '昨天开始恶心。', '今天有乏力。']
  const fixture = await setup({ reply: () => replies[stage]!, extract: input => {
    const { turns, history } = summaryPayloadSchema.parse(input.userPayload)
    const answers = turns.filter(turn => replies.includes(turn.messageText))
    const facts = [{ text: '头晕一周', sources: [{ sourceTurnId: answers[0]!.id, quote: replies[0] }] },
      ...(stage === 0 ? [] : [{ text: stage === 1 ? '昨日起恶心' : '昨日起恶心伴今日乏力',
        sources: answers.slice(1).map(source => ({ sourceTurnId: source.id, quote: source.messageText })) }])]
    return { additions: [{ field: 'historyOfPresentIllness', relation: stage === 0 ? 'addition' : 'update',
      ...(stage === 0 ? {} : { targetAdditionId: history[0]!.id }), facts }] }
  }, verify: input => {
    const { additions } = z.object({ additions: z.array(z.object({ facts: z.array(z.object({ text: z.string(),
      sources: z.array(z.object({ quote: z.string() })) })) })) }).parse(input.userPayload)
    return { additions: additions.map((addition, index) => ({ index, complete: true, relationValid: true,
      faithful: addition.facts.every(fact => !fact.text.includes('恶心') || fact.sources.some(source => source.quote.includes('恶心'))),
    })) }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  stage = 1
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  expect((await fixture.review((await fixture.read()).consultationRecording!.additions.at(-1)!.id, 'undo')).status).toBe(200)
  stage = 2
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe('头晕一周')
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'failed',
    failures: [{ code: 'CONSULTATION_RECORDING_SOURCE_INVALID', retrying: false }] })
})

it('checks rejected facts separately when a live predecessor shares their old citation', async () => {
  const replies = ['头晕一周，昨天开始恶心。', '恶心确实是昨天开始的。', '今天有乏力。']
  let stage = 0
  const fixture = await setup({ reply: () => replies[stage]!, extract: input => {
    const { turns, history } = summaryPayloadSchema.parse(input.userPayload)
    const answers = turns.filter(turn => replies.includes(turn.messageText))
    return { additions: [{ field: 'historyOfPresentIllness', relation: stage === 0 ? 'addition' : 'update',
      ...(stage === 0 ? {} : { targetAdditionId: history[0]!.id }), facts: [
        { text: '头晕一周', sources: [{ sourceTurnId: answers[0]!.id, quote: replies[0] }] },
        ...(stage === 0 ? [] : [{ text: '昨日起恶心', sources: [{ sourceTurnId: answers[0]!.id, quote: replies[0] },
          ...(stage === 1 ? [{ sourceTurnId: answers[1]!.id, quote: replies[1] }] : [])] }]),
        ...(stage !== 2 ? [] : [{ text: '今日乏力', sources: [{ sourceTurnId: answers[2]!.id, quote: replies[2] }] }]),
      ] }] }
  }, verify: input => {
    const factSchema = z.object({ text: z.string(), sources: z.array(z.object({ sourceTurnId: z.string() })) })
    const payload = z.object({ additions: z.array(z.object({ facts: z.array(factSchema) })),
      history: z.array(z.object({ text: z.string() })), rejectedFacts: z.array(factSchema).default([]),
      turns: z.array(z.object({ id: z.string() })),
    }).parse(input.userPayload)
    return { additions: payload.additions.map((addition, index) => ({ index, faithful: true, complete: true,
      relationValid: addition.facts.every(fact => !payload.rejectedFacts.some(rejected => rejected.text === fact.text)
        || payload.history.some(target => target.text.includes(fact.text))
        || fact.sources.some(source => source.sourceTurnId === payload.turns.at(-1)!.id)),
    })) }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  stage = 1
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  expect((await fixture.review((await fixture.read()).consultationRecording!.additions.at(-1)!.id, 'undo')).status).toBe(200)
  stage = 2
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe('头晕一周')
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'failed',
    failures: [{ code: 'CONSULTATION_RECORDING_SOURCE_INVALID', retrying: false }] })
})

it('rechecks a rejection made while the model is preparing a multi-turn summary', async () => {
  const replies = ['头晕一周。', '昨天开始恶心。', '今天有乏力。']
  const texts = ['头晕一周', '昨日起恶心', '今日乏力']
  let stage = 0
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  let paused = false
  const fixture = await setup({ reply: () => replies[stage]!, verify: faithfulSummaryVerification, extract: async input => {
    const { turns, history } = summaryPayloadSchema.parse(input.userPayload)
    const answers = turns.filter(turn => replies.includes(turn.messageText))
    if (stage === 2 && !paused) { paused = true; started(); await waiting }
    return { additions: [{ field: 'historyOfPresentIllness', relation: stage === 0 ? 'addition' : 'update',
      ...(stage === 0 ? {} : { targetAdditionId: history[0]!.id }),
      facts: texts.slice(0, stage + 1).map((text, index) => ({ text,
        sources: [{ sourceTurnId: answers[index]!.id, quote: answers[index]!.messageText }],
      })) }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  stage = 1
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const update = (await fixture.read()).consultationRecording!.additions.at(-1)!
  stage = 2
  await fixture.askMore()
  const processing = fixture.runtime.dispatchPending()
  await entered
  try { expect((await fixture.review(update.id, 'undo')).status).toBe(200) } finally { release() }
  await processing
  await fixture.applySuggestions()
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe('头晕一周；今日乏力')
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'updated', failures: [] })
})

it('ignores an old-only summary rewrite after a reply with no new history', async () => {
  let reply = firstFeverReply
  const fixture = await setup({ reply: () => reply, verify: faithfulSummaryVerification, extract: input => {
    if (reply === firstFeverReply) return feverSummaries(input)
    const { turns, history } = summaryPayloadSchema.parse(input.userPayload)
    const first = turns.find(turn => turn.messageText === firstFeverReply)!
    return { additions: [{ field: 'historyOfPresentIllness', relation: 'update', targetAdditionId: history[0]!.id,
      facts: [{ text: '自述最高体温38.5℃，昨晚起发热伴干咳',
        sources: [{ sourceTurnId: first.id, quote: first.messageText }] }] }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const before = await fixture.read()
  reply = '谢谢。'
  expect((await fixture.askMore()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const after = await fixture.read()
  expect(after.clinicalDocument).toEqual(before.clinicalDocument)
  expect(after.consultationRecording!.additions).toEqual(before.consultationRecording!.additions)
  expect(after.consultationRecording).toMatchObject({ status: 'updated', failures: [] })
})

it('migrates pre-summary extracts without rewriting their text and replays a receipt without the new source fields', async () => {
  const fixture = await setup()
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const original = await fixture.read()
  const key = randomUUID()
  const paused = await fixture.control('pause', { key })
  const receipt = controlConsultationRecordingResponseSchema.parse(await paused.json())
  const oldReceipt = { ...receipt, data: { ...receipt.data, additions: receipt.data.additions.map(({ summary: _summary, facts: _facts, ...addition }) => addition) } }
  fixture.runtime.database.driver.prepare('UPDATE command_receipt SET response_json = ? WHERE idempotency_key = ?')
    .run(JSON.stringify(oldReceipt), key)
  fixture.runtime.database.driver.exec('ALTER TABLE consultation_history_addition DROP COLUMN facts_json')
  fixture.runtime.database.driver.prepare('DELETE FROM schema_migration WHERE migration_id = ?').run('0059_consultation-history-summary.sql')
  await fixture.restart()
  const upgraded = await fixture.read()
  expect(upgraded.clinicalDocument).toEqual(original.clinicalDocument)
  expect(upgraded.consultationRecording!.additions[0]).toMatchObject({ summary: '', facts: [],
    sourceTurnId: original.consultationRecording!.additions[0]!.sourceTurnId })
  const replayed = await fixture.control('pause', { key, version: receipt.data.version - 1 })
  expect(replayed.status).toBe(200)
  expect(controlConsultationRecordingResponseSchema.parse(await replayed.json())).toEqual(oldReceipt)
  expect((await fixture.review(upgraded.consultationRecording!.additions[0]!.id, 'undo')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe('')
})

it('retains patient uncertainty, home measurements, external diagnoses, medication and allergy attribution', async () => {
  const reply = '我记不清了，可能三天前开始头晕。家里量的血压是150/90。外院说我有高血压。以前吃过氨氯地平，我不确定青霉素是不是过敏。'
  const texts = ['自述头晕可能始于三天前，具体时间记不清', '自述居家血压150/90，外院曾告知高血压', '自述既往服用氨氯地平，青霉素过敏情况不确定']
  const fixture = await setup({ reply, verify: faithfulSummaryVerification, extract: input => {
    const source = summaryPayloadSchema.parse(input.userPayload).turns.at(-1)!
    return { additions: texts.map((text, index) => ({ field: index === 2 ? 'priorMedicalHistory' : 'historyOfPresentIllness',
      relation: 'addition', facts: [{ text, sources: [{ sourceTurnId: source.id, quote: reply }] }] })) }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const detail = await fixture.read()
  expect(detail.clinicalDocument?.draft).toMatchObject({ historyOfPresentIllness: texts.slice(0, 2).join('\n'),
    priorMedicalHistory: texts[2], physicalExamination: '', assessment: '' })
  expect(detail.consultationRecording!.additions.flatMap(addition => addition.facts!)).toHaveLength(3)
})

it.each([
  ['unsupported diagnosis', '考虑肺炎'], ['wrong citation', '否认胸痛'],
  ['dropped negation', '发热伴咳嗽、咳痰'], ['changed number', '自述最高体温38.8℃'],
])('preserves the saved reply and draft when independent verification rejects %s', async (_reason, text) => {
    const fixture = await setup({ reply: firstFeverReply, extract: input => {
      const source = summaryPayloadSchema.parse(input.userPayload).turns.at(-1)!
      return { additions: [{ field: 'historyOfPresentIllness', relation: 'addition',
        facts: [{ text, sources: [{ sourceTurnId: source.id, quote: firstFeverReply }] }] }] }
    }, verify: input => {
      const verdict = { additions: faithfulSummaryVerification(input).additions.map(item => ({ ...item, faithful: false })) }
      // A valid negative verdict must not trigger structured-output repair.
      expect(input.validate!(verdict)).toBe(true)
      return verdict
    } })
    await fixture.ask()
    await fixture.runtime.dispatchPending()
    await fixture.applySuggestions()
    expect((await fixture.read()).clinicalDocument?.draft).toBeUndefined()
    expect((await fixture.read()).consultation!.turns.at(-1)!.messageText).toBe(firstFeverReply)
    expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'failed', additions: [],
      failures: [{ code: 'CONSULTATION_RECORDING_SOURCE_INVALID' }] })
  })

it.each(['lost prior fact', 'unresolved contradiction'])('keeps the prior summary when verification rejects an update with %s', async reason => {
  let reply = firstFeverReply
  let update = false
  const fixture = await setup({ reply: () => reply, extract: input => {
    if (!update) return feverSummaries(input)
    const payload = summaryPayloadSchema.parse(input.userPayload)
    const source = payload.turns.at(-1)!
    return { additions: [{ field: 'historyOfPresentIllness', relation: 'update', targetAdditionId: payload.history[0]!.id,
      facts: [{ text: reason === 'lost prior fact' ? '否认胸痛、气促' : '自述最高体温37.5℃',
        sources: [{ sourceTurnId: source.id, quote: reply }] }] }] }
  }, verify: input => ({ additions: faithfulSummaryVerification(input).additions.map(item => ({ ...item,
    complete: !update || reason !== 'lost prior fact', relationValid: !update || reason !== 'unresolved contradiction',
  })) }) })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  update = true
  reply = reason === 'lost prior fact' ? secondFeverReply : '最高量到37.5度。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(feverSummary)
  expect((await fixture.read()).consultationRecording!.additions).toHaveLength(1)
  expect((await fixture.read()).consultationRecording!.status).toBe('failed')
})

it('requires complete independent verification rather than trusting missing or duplicate verdicts', async () => {
  const fixture = await setup({ reply: firstFeverReply, extract: feverSummaries, verify: () => ({ additions: [] }) })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'failed', additions: [] })
})

it('rejects a source from another case before semantic verification', async () => {
  let verificationCalls = 0
  const fixture = await setup({ reply: firstFeverReply,
    verify: input => { verificationCalls += 1; return faithfulSummaryVerification(input) },
    extract: () => ({ additions: [{ field: 'historyOfPresentIllness', relation: 'addition', facts: [{
      text: feverSummary, sources: [{ sourceTurnId: 'other-case-patient-turn', quote: firstFeverReply }],
    }] }] }) })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  expect(verificationCalls).toBe(0)
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'failed', additions: [] })
})

it('requires review and exposes cancellable preparation without an automatic recording model', async () => {
  let now = new Date('2026-10-10T06:00:00.000Z')
  const fixture = await setup({ recording: false, now: () => now })
  expect((await fixture.ask()).status).toBe(200)
  expect((await fixture.read()).consultationRecording).toBeUndefined()
  const actions = await signing(fixture)
  await actions.save()
  const preview = await actions.preview()
  expect(preview.consultationReview).toEqual({
    consultationVersion: (await fixture.read()).consultation!.version,
    remainingCount: 2, failedCount: 0, paused: false, conflictCount: 0, unreviewedCount: 0,
  })
  expect((await fixture.read()).consultationRecording?.signingPreparation).toMatchObject({ previewId: preview.previewId, active: true })
  const denied = await actions.request('actions/sign', { previewId: preview.previewId, commitToken: preview.commitToken })
  expect(denied.status).toBe(409)
  expect(apiErrorSchema.parse(await denied.json()).error.code).toBe('WORKFLOW_CONFLICT')
  now = new Date(now.getTime() + 6 * 60_000)
  await fixture.restart()
  expect((await fixture.read()).consultationRecording?.signingPreparation).toMatchObject({ previewId: preview.previewId, active: false })
  const cancelled = await actions.request('actions/cancel-sign', { previewId: preview.previewId })
  expect(cancelled.status).toBe(200)
  cancelClinicalDocumentSignResponseSchema.parse(await cancelled.json())
  expect((await fixture.read()).consultationRecording).toBeUndefined()
  expect(fixture.requests.filter(request => request.schemaName === 'consultation_history_increment')).toEqual([])
  const fresh = await actions.preview()
  const signed = await actions.request('actions/sign', { previewId: fresh.previewId, commitToken: fresh.commitToken, consultationReviewed: true })
  expect(signed.status).toBe(200)
  clinicalDocumentSignResponseSchema.parse(await signed.json())
})

it('invalidates a changed consultation preview without an automatic recording model even after human acknowledgement', async () => {
  const fixture = await setup({ recording: false })
  expect((await fixture.ask()).status).toBe(200)
  const actions = await signing(fixture)
  await actions.save()
  const preview = await actions.preview()
  const before = (await fixture.read()).consultation!.version
  expect((await fixture.askMore()).status).toBe(200)
  expect((await fixture.read()).consultation!.version).toBeGreaterThan(before)
  const denied = await actions.request('actions/sign', { previewId: preview.previewId, commitToken: preview.commitToken, consultationReviewed: true })
  expect(denied.status).toBe(409)
  expect(apiErrorSchema.parse(await denied.json()).error.code).toBe('WORKFLOW_CONFLICT')
  expect((await fixture.read()).clinicalDocument?.signed).toEqual([])
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
    ['actions/sign', { previewId: preview.previewId, commitToken: preview.commitToken, consultationReviewed: true }],
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

it.each(['preparing', 'signed'])('freezes a preview and unfinished progress when extraction completes during %s, without allowing a late result to alter the document', async phase => {
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const extracting = new Promise<void>(resolve => { entered = resolve })
  const fixture = await setup({ extract: async input => {
    entered()
    await held
    const turn = (input.userPayload as { turns: Array<{ id: string }> }).turns.at(-1)!
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: turn.id, quote: '头晕一周了，站起来时更明显。', relation: 'addition' }] }
  } })
  disposals.push(async () => release())
  expect((await fixture.ask()).status).toBe(200)
  const processing = fixture.runtime.dispatchPending()
  await extracting
  const actions = await signing(fixture)
  await actions.save()
  const preview = await actions.preview()
  expect(preview.consultationReview).toMatchObject({ remainingCount: 1, failedCount: 0, conflictCount: 0 })
  const frozen = await fixture.read()
  expect(frozen.consultationRecording?.signingPreparation).toMatchObject({ previewId: preview.previewId, active: true })
  expect((await fixture.control('pause')).status).toBe(409)
  expect((await actions.request('actions/sign', { previewId: preview.previewId, commitToken: preview.commitToken })).status).toBe(409)
  const input = { previewId: preview.previewId, commitToken: preview.commitToken, consultationReviewed: true }
  expect((await actions.request('actions/sign', input, { version: '1' })).status).toBe(409)
  expect((await actions.request('actions/sign', input, { cookie: await signIn(fixture.runtime, 'registrar@demo.clinmesh.local') })).status).toBe(403)
  if (phase === 'preparing') {
    release()
    await processing
    await fixture.applySuggestions()
    expect(await fixture.read()).toEqual(frozen)
  }
  const signed = await actions.request('actions/sign', input)
  expect(signed.status).toBe(200)
  const receipt = clinicalDocumentSignResponseSchema.parse(await signed.json())
  const beforeLate = await fixture.read()
  release()
  await processing
  await fixture.applySuggestions()
  expect(await fixture.read()).toEqual(beforeLate)
  expect(beforeLate.clinicalDocument!.signed[0]!.content).toEqual(actions.complete)
  const composition = await fixture.runtime.app.request(`/fhir/R5/Composition/${receipt.data.compositionId}`, { headers: { cookie: fixture.cookie } })
  expect(composition.status).toBe(200)
  const persisted = await composition.json()
  await fixture.restart()
  expect((await fixture.read()).clinicalDocument).toEqual(beforeLate.clinicalDocument)
  expect(await (await fixture.runtime.app.request(`/fhir/R5/Composition/${receipt.data.compositionId}`, { headers: { cookie: fixture.cookie } })).json()).toEqual(persisted)
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
  await fixture.applySuggestions()
  expect((await fixture.read()).consultationRecording).toMatchObject({ processedCount: 1, remainingCount: 0, additions: [{ status: 'applied' }] })
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(actions.complete.historyOfPresentIllness + '\n患者自述：头晕一周了，站起来时更明显。')
  await fixture.restart()
  expect((await actions.request('actions/cancel-sign', { previewId: preview.previewId }, { key })).status).toBe(200)
  expect(cancelClinicalDocumentSignResponseSchema.parse(await (await actions.request('actions/cancel-sign', { previewId: preview.previewId }, { key })).json())).toEqual(receipt)
  expect((await fixture.read()).consultationRecording?.signingPreparation).toBeUndefined()
  expect((await actions.request('actions/sign', { commitToken: preview.commitToken, previewId: preview.previewId, consultationReviewed: true })).status).toBe(409)
})

it('recovers an expired preview after restart without losing explicit pause or omissions', async () => {
  let time = Date.now()
  const fixture = await setup({ now: () => new Date(time) })
  await fixture.ask()
  expect((await fixture.control('pause')).status).toBe(200)
  const actions = await signing(fixture)
  await actions.save()
  const preview = await actions.preview()
  expect(preview.consultationReview).toMatchObject({ paused: true, remainingCount: 1 })
  time += 5 * 60_000
  await fixture.restart()
  expect((await fixture.read()).consultationRecording?.signingPreparation).toMatchObject({ previewId: preview.previewId, active: false })
  expect((await actions.request('actions/sign', { commitToken: preview.commitToken, previewId: preview.previewId, consultationReviewed: true })).status).toBe(409)
  expect((await actions.request('actions/cancel-sign', { previewId: preview.previewId })).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  expect((await fixture.read()).consultationRecording).toMatchObject({ paused: true, remainingCount: 1, processedCount: 0 })
  expect((await fixture.control('resume')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  expect((await fixture.read()).consultationRecording).toMatchObject({ remainingCount: 0, processedCount: 1 })
})

it('reports failed recording and unresolved manual conflicts before signing, and rejects a changed consultation even after acknowledgement', async () => {
  let reply = '头晕一周了。'
  let fail = false
  const fixture = await setup({ reply: () => reply, extract: input => {
    if (fail) throw new ChatCompletionsError('AI_TIMEOUT', 'Synthetic recording timeout')
    const payload = input.userPayload as { turns: Array<{ id: string }>; history: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id, quote: reply,
      relation: payload.history[0] ? 'conflict' : 'addition', ...(payload.history[0] ? { targetAdditionId: payload.history[0].id } : {}) }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  await fixture.save('医生核对：头晕五天。')
  reply = '头晕是三天。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  fail = true
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const actions = await signing(fixture)
  await actions.save()
  const preview = await actions.preview()
  expect(preview.consultationReview).toMatchObject({ failedCount: 1, remainingCount: 1, conflictCount: 1, unreviewedCount: 0 })
  await fixture.askMore()
  expect((await actions.request('actions/sign', { commitToken: preview.commitToken, previewId: preview.previewId, consultationReviewed: true })).status).toBe(409)
  expect((await fixture.read()).clinicalDocument!.signed).toEqual([])
  expect((await actions.request('actions/cancel-sign', { previewId: preview.previewId })).status).toBe(200)
  fail = false
  expect((await fixture.control('retry')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  expect((await fixture.read()).consultationRecording!.failedCount).toBe(0)
})

it('replays a legacy preview receipt but requires fresh preparation for a consultation without a stored review snapshot', async () => {
  const fixture = await setup()
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const actions = await signing(fixture)
  await actions.save()
  const input = { expectedDraftVersion: (await fixture.read()).clinicalDocument!.draft!.version }
  const key = randomUUID()
  const receipt = clinicalDocumentSignPreviewResponseSchema.parse(await (await actions.request('actions/preview-sign', input, { key })).json())
  const { consultationReview: _review, ...legacyData } = receipt.data
  fixture.runtime.database.driver.prepare('UPDATE command_receipt SET response_json = ? WHERE idempotency_key = ?')
    .run(JSON.stringify({ ...receipt, data: legacyData }), key)
  fixture.runtime.database.driver.prepare('UPDATE clinical_document_sign_preview SET consultation_review_json = NULL WHERE preview_id = ?')
    .run(receipt.data.previewId)
  await fixture.restart()
  const replay = clinicalDocumentSignPreviewResponseSchema.parse(await (await actions.request('actions/preview-sign', input, { key })).json())
  expect(replay.data).toEqual({ ...legacyData, consultationReview: null })
  expect((await actions.request('actions/sign', { commitToken: legacyData.commitToken, previewId: legacyData.previewId, consultationReviewed: true })).status).toBe(409)
  expect((await actions.request('actions/cancel-sign', { previewId: legacyData.previewId })).status).toBe(200)
  const fresh = await actions.preview()
  expect(fresh.consultationReview).toMatchObject({ unreviewedCount: 0 })
  expect((await actions.request('actions/sign', { commitToken: fresh.commitToken, previewId: fresh.previewId, consultationReviewed: true })).status).toBe(200)
})

it('persists individual review and source after restart and undoes only the selected increment with an idempotent receipt', async () => {
  let reply = '头晕一周了。站起来时更明显。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const turns = (input.userPayload as { turns: Array<{ id: string; messageText: string }> }).turns
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: turns.at(-1)!.id,
      quote: turns.at(-1)!.messageText, relation: 'addition' }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const original = (await fixture.read()).consultationRecording!.additions
  expect(original).toMatchObject([{ reviewStatus: 'confirmed' }, { reviewStatus: 'confirmed' }])
  // Applying already records the physician's confirmation.
  expect((await fixture.save('患者自述：头晕一周了。\n患者自述：站起来时更明显。\n医生补充：尚未查体。')).status).toBe(200)
  reply = '夜间也会头晕。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  await fixture.restart()
  const before = await fixture.read()
  expect(before.consultationRecording!.additions).toMatchObject([
    { reviewStatus: 'confirmed', ownership: 'automatic' }, { reviewStatus: 'confirmed', ownership: 'automatic' },
    { reviewStatus: 'confirmed', ownership: 'automatic' },
  ])
  expect(before.consultation?.turns.find(turn => turn.id === original[0]!.sourceTurnId)?.messageText).toBe('头晕一周了。站起来时更明显。')
  const key = randomUUID()
  const version = before.clinicalDocument!.draft!.version
  expect((await fixture.review(original[0]!.id, 'undo', { version: version - 1 })).status).toBe(409)
  expect((await fixture.review(original[0]!.id, 'undo', { headers: { cookie: await signIn(fixture.runtime, 'registrar@demo.clinmesh.local') } })).status).toBe(403)
  expect((await fixture.review('another-case-increment', 'undo')).status).toBe(409)
  const undone = await fixture.review(original[0]!.id, 'undo', { key, version })
  expect(undone.status).toBe(200)
  const receipt = reviewConsultationHistoryResponseSchema.parse(await undone.json())
  expect(receipt.effects).toEqual(expect.arrayContaining([expect.objectContaining({ reference: `ClinicalDocumentDraft/${before.caseId}` })]))
  await fixture.restart()
  const after = await fixture.read()
  expect(after.clinicalDocument?.draft?.historyOfPresentIllness).toBe('患者自述：站起来时更明显。\n医生补充：尚未查体。\n患者自述：夜间也会头晕。')
  expect(after.consultationRecording!.additions).toMatchObject([
    { status: 'undone', sourceTurnId: original[0]!.sourceTurnId }, { reviewStatus: 'confirmed', ownership: 'automatic' }, { reviewStatus: 'confirmed', ownership: 'automatic' },
  ])
  const replay = await fixture.review(original[0]!.id, 'undo', { key, version })
  expect(reviewConsultationHistoryResponseSchema.parse(await replay.json())).toEqual(receipt)
  expect((await fixture.read()).clinicalDocument?.draft?.version).toBe(version + 1)
  expect(fixture.runtime.database.driver.prepare("SELECT count(*) AS count FROM audit_log WHERE operation = 'consultation.history.review' AND outcome = 'success'").get()).toMatchObject({ count: 4 })
})

it.each(['医生核对：头晕五天。', ''] as const)('preserves manually changed or deleted content on undo (%s) and leaves persistent manual review', async history => {
  const fixture = await setup()
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const id = (await fixture.read()).consultationRecording!.additions[0]!.id
  await fixture.save(history)
  const version = (await fixture.read()).clinicalDocument!.draft!.version
  expect((await fixture.review(id, 'undo')).status).toBe(200)
  await fixture.restart()
  expect(await fixture.read()).toMatchObject({ clinicalDocument: { draft: { version, historyOfPresentIllness: history } },
    consultationRecording: { status: 'pending', additions: [{ status: 'applied', reviewStatus: 'undo-pending', ownership: 'manual' }] } })
  expect((await fixture.review(id, 'confirm')).status).toBe(200)
  await fixture.restart()
  expect(await fixture.read()).toMatchObject({ clinicalDocument: { draft: { version, historyOfPresentIllness: history } },
    consultationRecording: { status: 'updated', additions: [{ reviewStatus: 'confirmed', ownership: 'manual' }] } })
})

it('ends manual undo review after accepting a replacement while preserving the superseded history', async () => {
  let reply = '头晕一周了。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }>; history: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
      quote: reply, relation: payload.history.length ? 'correction' : 'addition',
      ...(payload.history[0] === undefined ? {} : { targetAdditionId: payload.history[0].id }) }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const original = (await fixture.read()).consultationRecording!.additions[0]!
  expect((await fixture.save('医生核对：头晕五天。')).status).toBe(200)
  expect((await fixture.review(original.id, 'undo')).status).toBe(200)
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'pending',
    additions: [{ status: 'applied', reviewStatus: 'undo-pending', ownership: 'manual' }] })
  reply = '刚才说错了，头晕是三天。'
  expect((await fixture.askMore()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const correction = (await fixture.read()).consultationRecording!.additions.at(-1)!
  expect(correction).toMatchObject({ status: 'pending', reviewable: true })
  expect((await fixture.review(correction.id, 'accept')).status).toBe(200)
  await fixture.restart()
  const after = await fixture.read()
  expect(after.consultationRecording!.additions).toMatchObject([
    { id: original.id, sourceTurnId: original.sourceTurnId, status: 'superseded', reviewStatus: 'undo-pending' },
    { id: correction.id, status: 'applied', reviewStatus: 'confirmed' },
  ])
  expect(after.clinicalDocument!.draft!.historyOfPresentIllness).toBe(`患者自述：${reply}`)
  expect((await fixture.review(original.id, 'confirm')).status).toBe(409)
  expect(after.consultationRecording!.status).toBe('updated')
})

it('upgrades earlier correction history and replays an old control receipt with default review status', async () => {
  let reply = '头晕一周了。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }> ; history: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
      quote: reply, relation: payload.history.length ? 'correction' : 'addition',
      ...(payload.history[0] === undefined ? {} : { targetAdditionId: payload.history[0].id }) }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  reply = '刚才说错了，头晕是五天。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const id = (await fixture.read()).consultationRecording!.additions.at(-1)!.id
  const key = randomUUID()
  const pause = await fixture.control('pause', { key, version: 1 })
  const receipt = controlConsultationRecordingResponseSchema.parse(await pause.json())
  const oldReceipt = { ...receipt, data: { ...receipt.data, additions: receipt.data.additions.map(({ reviewStatus: _reviewStatus, ...addition }) => addition) } }
  fixture.runtime.database.driver.prepare('UPDATE command_receipt SET response_json = ? WHERE idempotency_key = ?')
    .run(JSON.stringify(oldReceipt), key)
  // Build an actual pre-0057 table on the same file-backed database, then run the normal startup migration.
  for (const column of ['review_status', 'rejected', 'undone', 'inverse_text']) {
    fixture.runtime.database.driver.exec(`ALTER TABLE consultation_history_addition DROP COLUMN ${column}`)
  }
  fixture.runtime.database.driver.prepare('DELETE FROM schema_migration WHERE migration_id = ?').run('0057_consultation-history-review.sql')
  await fixture.restart()
  expect((await fixture.read()).consultationRecording!.additions.at(-1)).toMatchObject({ reviewStatus: 'unreviewed', status: 'applied' })
  const replay = await fixture.control('pause', { key, version: 1 })
  expect(replay.status).toBe(200)
  expect(controlConsultationRecordingResponseSchema.parse(await replay.json())).toEqual({ ...receipt, data: { ...receipt.data,
    additions: receipt.data.additions.map(addition => ({ ...addition, reviewStatus: 'unreviewed' })) } })
  expect((await fixture.review(id, 'undo')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe('患者自述：头晕一周了。')
})

it.each(['confirm', 'undo'] as const)('reviews an upgraded multi-statement legacy history directly from its query IDs (%s)', async decision => {
  const quote = '头晕一周了。站起来时更明显。'
  const fixture = await setup({ reply: quote, extract: input => ({ additions: [{
    field: 'historyOfPresentIllness', sourceTurnId: (input.userPayload as { turns: Array<{ id: string }> }).turns.at(-1)!.id,
    quote, relation: 'addition',
  }] }) })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const before = await fixture.read()
  const original = before.consultationRecording!.additions[0]!
  const document = clinicalDocumentDraftContentSchema.parse(Object.fromEntries(Object.entries(before.clinicalDocument!.draft!)
    .filter(([field]) => field in clinicalDocumentDraftContentSchema.shape)))
  const history = `医生补充：🙂尚未查体。\n患者自述：${quote}\n医生补充：待查体。`
  // Seed the migrated single-row representation before ownership and sentence ranges existed.
  fixture.runtime.database.driver.prepare('DELETE FROM consultation_history_addition WHERE case_id = ? AND addition_id != ?')
    .run(before.caseId, original.id)
  fixture.runtime.database.driver.prepare(`UPDATE consultation_history_addition SET quote = ?, facts_json = NULL, start_offset = NULL,
    end_offset = NULL, current_text = '', review_status = 'unreviewed' WHERE case_id = ? AND addition_id = ?`).run(quote, before.caseId, original.id)
  fixture.runtime.database.driver.prepare('UPDATE clinical_document_draft SET content_json = ? WHERE case_id = ?')
    .run(JSON.stringify({ ...document, historyOfPresentIllness: history }), before.caseId)
  await fixture.restart()
  const upgraded = await fixture.read()
  const fragments = upgraded.consultationRecording!.additions.filter(addition => addition.status === 'applied')
  expect(fragments).toMatchObject([
    { quote: '头晕一周了。', currentText: '患者自述：头晕一周了。', sourceTurnId: original.sourceTurnId, reviewStatus: 'unreviewed' },
    { quote: '站起来时更明显。', currentText: '站起来时更明显。', sourceTurnId: original.sourceTurnId, reviewStatus: 'unreviewed' },
  ])
  expect(upgraded.clinicalDocument!.draft!.historyOfPresentIllness).toBe(history)
  expect((await fixture.read()).consultationRecording!.additions).toEqual(upgraded.consultationRecording!.additions)
  const countStored = () => fixture.runtime.database.driver.prepare('SELECT count(*) AS count FROM consultation_history_addition WHERE case_id = ?').get(before.caseId)
  expect(countStored()).toEqual({ count: 1 })
  const version = upgraded.clinicalDocument!.draft!.version
  expect((await fixture.review(fragments[0]!.id, decision, { version: version - 1 })).status).toBe(409)
  expect(countStored()).toEqual({ count: 1 })
  const key = randomUUID()
  const response = await fixture.review(fragments[0]!.id, decision, { key, version })
  expect(response.status).toBe(200)
  const receipt = reviewConsultationHistoryResponseSchema.parse(await response.json())
  await fixture.restart()
  const after = await fixture.read()
  expect(after.consultationRecording!.additions).toMatchObject([
    { id: original.id, status: 'superseded' },
    { id: fragments[0]!.id, status: decision === 'undo' ? 'undone' : 'applied', reviewStatus: 'confirmed' },
    { id: fragments[1]!.id, status: 'applied', reviewStatus: 'unreviewed', ownership: 'automatic' },
  ])
  expect(after.clinicalDocument!.draft!.historyOfPresentIllness).toBe(decision === 'undo'
    ? '医生补充：🙂尚未查体。\n站起来时更明显。\n医生补充：待查体。' : history)
  expect(after.clinicalDocument!.draft!.version).toBe(version + (decision === 'undo' ? 1 : 0))
  const replay = await fixture.review(fragments[0]!.id, decision, { key, version })
  expect(reviewConsultationHistoryResponseSchema.parse(await replay.json())).toEqual(receipt)
  expect((await fixture.review(fragments[1]!.id, 'undo')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(decision === 'undo'
    ? '医生补充：🙂尚未查体。\n医生补充：待查体。'
    : '医生补充：🙂尚未查体。\n患者自述：头晕一周了。\n医生补充：待查体。')
})

it('undoes a correction using its predecessor text while keeping later increments and supports a correction chain', async () => {
  let reply = '头晕一周了。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string; messageText: string }>; history: Array<{ id: string }> }
    const correction = reply.startsWith('刚才')
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
      quote: reply, relation: correction ? 'correction' : 'addition',
      ...(correction ? { targetAdditionId: payload.history[0]!.id } : {}) }] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  for (const value of ['刚才说错了，头晕是五天。', '刚才说错了，头晕是六天。', '夜间也会头晕。']) {
    reply = value
    await fixture.askMore()
    await fixture.runtime.dispatchPending()
    await fixture.applySuggestions()
  }
  await fixture.save('患者自述：刚才说错了，头晕是六天。\n患者自述：夜间也会头晕。\n医生补充：尚未查体。')
  const additions = (await fixture.read()).consultationRecording!.additions
  expect((await fixture.review(additions[1]!.id, 'undo')).status).toBe(409)
  expect((await fixture.review(additions[2]!.id, 'undo')).status).toBe(200)
  await fixture.restart()
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe('患者自述：刚才说错了，头晕是五天。\n患者自述：夜间也会头晕。\n医生补充：尚未查体。')
  expect((await fixture.review(additions[1]!.id, 'undo')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe('患者自述：头晕一周了。\n患者自述：夜间也会头晕。\n医生补充：尚未查体。')
  expect((await fixture.read()).consultationRecording!.additions).toMatchObject([
    { status: 'applied', ownership: 'automatic' }, { status: 'undone' }, { status: 'undone' }, { status: 'applied', ownership: 'automatic' },
  ])
})

it.each([
  { field: 'chiefComplaint', limit: 1_000 },
  { field: 'historyOfPresentIllness', limit: 5_000 },
  { field: 'priorMedicalHistory', limit: 4_000 },
] as const)('keeps an oversized correction undo pending without losing later history or manual edits ($field)', async ({ field, limit }) => {
  let reply = '头晕' + '很严重'.repeat(100) + '。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string; messageText: string }>; history: Array<{ id: string }> }
    const correction = reply.startsWith('刚才')
    return { additions: [{ field, sourceTurnId: payload.turns.at(-1)!.id,
      quote: reply, relation: correction ? 'correction' : 'addition',
      ...(correction ? { targetAdditionId: payload.history[0]!.id } : {}) }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  for (const value of ['刚才说错了，头晕五天。', '夜间也会头晕。']) {
    reply = value
    expect((await fixture.askMore()).status).toBe(200)
    await fixture.runtime.dispatchPending()
    await fixture.applySuggestions()
  }
  const history = (await fixture.read()).clinicalDocument!.draft![field]!
  const manual = '医生补充：' + '补'.repeat(limit - 100 - history.length - 6)
  expect((await fixture.save(`${history}\n${manual}`, field)).status).toBe(200)
  const before = await fixture.read()
  const correction = before.consultationRecording!.additions[1]!
  expect(correction).toMatchObject({ status: 'applied', ownership: 'automatic' })
  const key = randomUUID()
  const version = before.clinicalDocument!.draft!.version
  const response = await fixture.review(correction.id, 'undo', { key, version })
  expect(response.status).toBe(200)
  const receipt = reviewConsultationHistoryResponseSchema.parse(await response.json())
  expect(receipt.data.draftVersion).toBe(version)
  expect(receipt.effects).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ reference: `ClinicalDocumentDraft/${before.caseId}` }),
  ]))
  await fixture.restart()
  const after = await fixture.read()
  expect(after.clinicalDocument?.draft).toEqual(before.clinicalDocument?.draft)
  expect(after.consultationRecording).toMatchObject({ status: 'pending', additions: [
    { status: 'superseded' }, { status: 'applied', reviewStatus: 'undo-pending', ownership: 'automatic' },
    { status: 'applied', ownership: 'automatic' },
  ] })
  const replay = await fixture.review(correction.id, 'undo', { key, version })
  expect(replay.status).toBe(200)
  expect(reviewConsultationHistoryResponseSchema.parse(await replay.json())).toEqual(receipt)
  reply = '刚才说错了，头晕四天。'
  expect((await fixture.askMore()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  await fixture.restart()
  const replaced = await fixture.read()
  const replacement = replaced.consultationRecording!.additions.at(-1)!
  expect(replacement).toMatchObject({ status: 'applied', reviewStatus: 'confirmed', ownership: 'automatic' })
  expect(replaced.consultationRecording!.additions[1]).toMatchObject({ status: 'superseded', reviewStatus: 'undo-pending' })
  expect(replaced.consultationRecording!.status).toBe('updated')
  expect((await fixture.review(replacement.id, 'undo')).status).toBe(200)
  await fixture.restart()
  const restored = await fixture.read()
  expect(restored.consultationRecording!.additions[1]).toMatchObject({ status: 'applied', reviewStatus: 'undo-pending' })
  expect(restored.consultationRecording!.status).toBe('pending')
  expect(restored.clinicalDocument!.draft![field]).toBe(before.clinicalDocument!.draft![field])
  expect((await fixture.review(correction.id, 'confirm')).status).toBe(200)
  await fixture.restart()
  const confirmed = await fixture.read()
  expect(confirmed.clinicalDocument?.draft).toEqual(restored.clinicalDocument?.draft)
  expect(confirmed.consultationRecording!.additions[1]!.reviewStatus).toBe('confirmed')
  expect(confirmed.consultationRecording!.status).toBe('updated')
})

it('undoes a correction whose restored history exactly meets the field limit', async () => {
  const original = '头晕' + '很严重'.repeat(100) + '。'
  let reply = original
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }>; history: Array<{ id: string }> }
    const correction = reply.startsWith('刚才')
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
      quote: reply, relation: correction ? 'correction' : 'addition',
      ...(correction ? { targetAdditionId: payload.history[0]!.id } : {}) }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  reply = '刚才说错了，头晕五天。'
  expect((await fixture.askMore()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const manual = '医生补充：' + '补'.repeat(5_000 - original.length - 11)
  expect((await fixture.save(`患者自述：${reply}\n${manual}`)).status).toBe(200)
  const before = await fixture.read()
  const response = await fixture.review(before.consultationRecording!.additions[1]!.id, 'undo')
  expect(response.status).toBe(200)
  expect(reviewConsultationHistoryResponseSchema.parse(await response.json()).data.draftVersion)
    .toBe(before.clinicalDocument!.draft!.version + 1)
  await fixture.restart()
  const after = await fixture.read()
  expect(after.clinicalDocument!.draft!.historyOfPresentIllness).toBe(`患者自述：${original}\n${manual}`)
  expect(after.clinicalDocument!.draft!.historyOfPresentIllness).toHaveLength(5_000)
  expect(after.consultationRecording!.additions).toMatchObject([
    { status: 'applied', ownership: 'automatic' }, { status: 'undone', reviewStatus: 'confirmed' },
  ])
})

it.each(['correction', 'conflict'] as const)('keeps distinct targets for the same sourced %s without duplicating suggestions', async relation => {
  let reply = '头晕一周了。咳嗽一周了。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }>; history: Array<{ id: string }> }
    const sourceTurnId = payload.turns.at(-1)!.id
    const additions = payload.history.length === 0
      ? [{ field: 'historyOfPresentIllness', sourceTurnId, quote: reply, relation: 'addition' }]
      : payload.history.map(target => ({ field: 'historyOfPresentIllness', sourceTurnId, quote: reply,
        relation, targetAdditionId: target.id }))
    return { additions: [...additions, ...additions] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const originals = (await fixture.read()).consultationRecording!.additions
  expect(originals).toHaveLength(2)
  reply = relation === 'correction' ? '刚才说错了，头晕和咳嗽都只有五天。' : '头晕和咳嗽都只有五天。'
  expect((await fixture.askMore()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  await fixture.restart()
  const detail = await fixture.read()
  expect(detail.consultationRecording!.additions).toHaveLength(4)
  expect(detail.consultationRecording!.additions.slice(2)).toMatchObject(originals.map(target => ({
    sourceTurnId: detail.consultation!.turns.at(-1)!.id, quote: reply, relation, targetAdditionId: target.id,
    status: relation === 'correction' ? 'applied' : 'pending', reviewStatus: relation === 'correction' ? 'confirmed' : 'unreviewed',
  })))
  if (relation === 'correction') {
    expect(detail.consultationRecording!.status).toBe('updated')
    expect(detail.consultationRecording!.additions.slice(0, 2).every(addition => addition.status === 'superseded')).toBe(true)
    expect(detail.clinicalDocument!.draft!.historyOfPresentIllness).toBe(`患者自述：${reply}\n患者自述：${reply}`)
  } else {
    expect(detail.consultationRecording!.status).toBe('pending')
    expect(detail.clinicalDocument!.draft!.historyOfPresentIllness).toBe('患者自述：头晕一周了。\n患者自述：咳嗽一周了。')
  }
})

it.each(['头晕一周了。', '头晕一周了'] as const)('keeps rejected source evidence across alternate sentence endings (%s) but allows new replies', async quote => {
  let firstSource = ''
  let phase: 'initial' | 'replay' | 'new' = 'initial'
  const alternate = quote.endsWith('。') ? quote.slice(0, -1) : `${quote}。`
  const fixture = await setup({ reply: '头晕一周了。', extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }> }
    firstSource ||= payload.turns.at(-1)!.id
    return { additions: [{ field: 'historyOfPresentIllness',
      sourceTurnId: phase === 'new' ? payload.turns.at(-1)!.id : firstSource,
      quote: phase === 'initial' ? quote : alternate, relation: 'addition' }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const addition = (await fixture.read()).consultationRecording!.additions[0]!
  expect((await fixture.review(addition.id, 'undo')).status).toBe(200)
  await fixture.restart()
  const rejected = await fixture.read()
  expect(rejected.clinicalDocument!.draft!.historyOfPresentIllness).toBe('')
  phase = 'replay'
  expect((await fixture.askMore()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const replayed = await fixture.read()
  expect(replayed.consultationRecording!.status).toBe('updated')
  expect(replayed.clinicalDocument!.draft).toEqual(rejected.clinicalDocument!.draft)
  expect(replayed.consultationRecording!.additions).toEqual(rejected.consultationRecording!.additions)
  phase = 'new'
  expect((await fixture.askMore()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const detail = await fixture.read()
  expect(detail.consultationRecording!.additions).toHaveLength(2)
  expect(detail.consultationRecording!.additions.at(-1)).toMatchObject({ status: 'applied', quote: alternate,
    sourceTurnId: detail.consultation!.turns.at(-1)!.id, reviewStatus: 'confirmed' })
  expect(detail.clinicalDocument!.draft!.historyOfPresentIllness).toBe(`患者自述：${alternate}`)
})

it.each(['undo', 'ignore'] as const)('suppresses rejected %s evidence during later extraction while allowing an identical quote from a new reply', async decision => {
  let reply = '头晕一周了。'
  let rejected: { field: string; sourceTurnId: string; quote: string; relation: string; targetAdditionId?: string } | undefined
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string; messageText: string }>; history: Array<{ id: string }> }
    const correction = reply.startsWith('刚才')
    const addition = { field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
      quote: reply, relation: correction ? 'correction' : 'addition',
      ...(correction ? { targetAdditionId: payload.history[0]!.id } : {}) }
    const alternate = rejected === undefined ? undefined : { ...rejected, quote: rejected.quote.replace(/。$/, '') }
    return { additions: rejected === undefined ? [addition] : decision === 'ignore'
      ? [rejected, { ...alternate, relation: 'conflict' }, addition] : [rejected, alternate, addition] }
  } })
  await fixture.ask()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  if (decision === 'ignore') {
    await fixture.save('医生核对：头晕五天。')
    reply = '刚才说错了，头晕是六天。'
    await fixture.askMore()
    await fixture.runtime.dispatchPending()
    await fixture.applySuggestions()
  }
  const addition = (await fixture.read()).consultationRecording!.additions.at(-1)!
  rejected = { field: addition.field, sourceTurnId: addition.sourceTurnId, quote: addition.quote,
    relation: addition.relation, ...(addition.targetAdditionId === undefined ? {} : { targetAdditionId: addition.targetAdditionId }) }
  expect((await fixture.review(addition.id, decision)).status).toBe(200)
  await fixture.restart()
  const before = (await fixture.read()).consultationRecording!.additions.length
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const after = await fixture.read()
  expect(after.consultationRecording!.additions).toHaveLength(before + 1)
  expect(after.consultationRecording!.additions.find(item => item.id === addition.id)?.status).toBe(decision === 'undo' ? 'undone' : 'ignored')
  expect(after.consultationRecording!.additions.at(-1)).toMatchObject({ quote: addition.quote,
    sourceTurnId: after.consultation!.turns.at(-1)!.id, status: decision === 'undo' ? 'applied' : 'pending', reviewStatus: decision === 'undo' ? 'confirmed' : 'unreviewed' })
})

it('persists pause while saving replies, then resumes in order without duplicating processed answers or losing manual edits', async () => {
  let reply = '头晕一周了。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const turns = (input.userPayload as { turns: Array<{ id: string; messageText: string }> }).turns
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: turns.at(-1)!.id, quote: turns.at(-1)!.messageText, relation: 'addition' }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
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
  await fixture.applySuggestions()
  await fixture.restart()
  expect(await fixture.read()).toMatchObject({ clinicalDocument: { draft: { historyOfPresentIllness: '医生核对：头晕五天。' } },
    consultationRecording: { status: 'paused', paused: true, processedCount: 1, remainingCount: 2 } })
  expect((await fixture.control('resume', { version: 1 })).status).toBe(409)
  const replay = await fixture.control('pause', { key, version: 1 })
  expect(controlConsultationRecordingResponseSchema.parse(await replay.json())).toEqual(receipt)
  expect((await fixture.control('resume')).status).toBe(200)
  await fixture.restart()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
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
  await fixture.applySuggestions()
  expect(await fixture.read()).toMatchObject({ clinicalDocument: { draft: { version: 1, historyOfPresentIllness: '医生手工核对的病史。' } },
    consultationRecording: { version: 0, status: 'backfill', remainingCount: 2 } })
  expect(fixture.requests.filter(input => input.schemaName === 'consultation_history_increment')).toHaveLength(0)
  const key = randomUUID()
  const response = await fixture.control('backfill', { key, version: 0 })
  expect(response.status).toBe(200)
  const receipt = controlConsultationRecordingResponseSchema.parse(await response.json())
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
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
  await fixture.applySuggestions()
  await fixture.restart()
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'failed', failedCount: 1, processedCount: 0, remainingCount: 2 })
  fail = false
  expect((await fixture.control('retry')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
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
  await fixture.applySuggestions()
  if (!resumeFirst) {
    expect((await fixture.read()).clinicalDocument?.draft).toBeUndefined()
    expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'paused', processedCount: 0, remainingCount: 1 })
    expect((await fixture.control('resume')).status).toBe(200)
    await fixture.runtime.dispatchPending()
    await fixture.applySuggestions()
  }
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'updated', processedCount: 1, remainingCount: 0 })
  expect((await fixture.read()).clinicalDocument?.draft?.version).toBe(1)
  expect(calls).toBe(2)
})

it('keeps conflicting handwritten history pending across restart and replaces only its reviewed sentence', async () => {
  const original = '医生核对：否认胸痛。\n平时睡眠正常。'
  const fixture = await setup({ reply: '胸痛两天了。', extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string; messageText: string }>;
      manualHistory?: Array<{ id: string; field: string; text: string }> }
    const answer = payload.turns.at(-1)!
    const target = payload.manualHistory?.find(item => item.field === 'historyOfPresentIllness' && item.text === '医生核对：否认胸痛。')
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: answer.id,
      quote: answer.messageText, relation: target === undefined ? 'addition' : 'conflict',
      ...(target === undefined ? {} : { targetAdditionId: target.id }) }] }
  } })
  expect((await fixture.save(original)).status).toBe(200)
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const detail = await fixture.read()
  expect(detail.clinicalDocument?.draft?.historyOfPresentIllness).toBe(original)
  expect(detail.consultationRecording).toMatchObject({ status: 'pending', additions: [
    { status: 'pending', currentText: '医生核对：否认胸痛。', reviewable: true, quote: '胸痛两天了。' },
  ] })
  const additionId = detail.consultationRecording!.additions[0]!.id
  await fixture.restart()
  expect((await fixture.read()).consultationRecording).toEqual(detail.consultationRecording)
  const key = randomUUID()
  expect((await fixture.review(additionId, 'accept', { key })).status).toBe(200)
  const accepted = await fixture.read()
  expect(accepted.clinicalDocument?.draft?.historyOfPresentIllness).toBe('患者自述：胸痛两天了。\n平时睡眠正常。')
  expect(accepted.consultationRecording?.additions[0]).toMatchObject({ status: 'applied', ownership: 'automatic', reviewStatus: 'confirmed' })
  expect((await fixture.review(additionId, 'accept', { key, version: detail.clinicalDocument!.draft!.version })).status).toBe(200)
  expect((await fixture.read()).clinicalDocument?.draft).toEqual(accepted.clinicalDocument?.draft)
})

it('compares the current manual edit of an attributed fragment rather than its original patient quote', async () => {
  let reply = '否认胸痛。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string; messageText: string }>;
      manualHistory?: Array<{ id: string; text: string }> }
    const answer = payload.turns.at(-1)!
    const target = payload.manualHistory?.find(item => item.text === '医生已核对：有胸痛。')
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: answer.id, quote: answer.messageText,
      relation: target === undefined ? 'addition' : 'conflict', ...(target === undefined ? {} : { targetAdditionId: target.id }) }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const original = (await fixture.read()).consultationRecording!.additions[0]!
  expect((await fixture.save('医生已核对：有胸痛。')).status).toBe(200)
  reply = '没有胸痛。'
  expect((await fixture.askMore()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const detail = await fixture.read()
  const conflict = detail.consultationRecording!.additions.find(item => item.status === 'pending')!
  expect(conflict).toMatchObject({ targetAdditionId: original.id, currentText: '医生已核对：有胸痛。', reviewable: true })
  expect(detail.clinicalDocument?.draft?.historyOfPresentIllness).toBe('医生已核对：有胸痛。')
  expect((await fixture.review(conflict.id, 'accept')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe('患者自述：没有胸痛。')
})

it.each(['during-extraction', 'after-extraction'] as const)('invalidates a handwritten conflict target edited %s without replacing newer text', async timing => {
  let release!: () => void
  let started!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const extracting = new Promise<void>(resolve => { started = resolve })
  const fixture = await setup({ reply: '胸痛两天了。', extract: async input => {
    const payload = input.userPayload as { turns: Array<{ id: string }>;
      manualHistory: Array<{ id: string; field: string; text: string }> }
    const target = payload.manualHistory.find(item => item.text === '医生核对：否认胸痛。')!
    started()
    if (timing === 'during-extraction') await blocked
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
      quote: '胸痛两天了。', relation: 'conflict', targetAdditionId: target.id }] }
  } })
  expect((await fixture.save('医生核对：否认胸痛。')).status).toBe(200)
  expect((await fixture.ask()).status).toBe(200)
  const processing = fixture.runtime.dispatchPending()
  await extracting
  if (timing === 'after-extraction') await processing
 await fixture.applySuggestions()
  const newer = '医生重新核对：胸痛已缓解。\n睡眠正常。'
  expect((await fixture.save(newer)).status).toBe(200)
  release()
  await processing
  await fixture.applySuggestions()
  const detail = await fixture.read()
  const addition = detail.consultationRecording!.additions[0]!
  expect(addition).toMatchObject({ status: 'pending', reviewable: false })
  expect((await fixture.review(addition.id, 'accept')).status).toBe(409)
  expect((await fixture.read()).clinicalDocument?.draft).toEqual(detail.clinicalDocument?.draft)
  expect((await fixture.review(addition.id, 'ignore')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(newer)
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
  await fixture.applySuggestions()
  const detail = await fixture.read()
  const conflicting = manual.includes('否认胸痛')
  expect(detail.clinicalDocument?.draft?.historyOfPresentIllness)
    .toBe(conflicting ? manual : `${manual}\n患者自述：胸痛两天了。`)
  expect(detail.consultationRecording).toMatchObject({ remainingCount: 0, failedCount: 0,
    additions: [{ status: conflicting ? 'pending' : 'applied' }] })
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
  await fixture.applySuggestions()
  expect(calls).toBe(3)
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe('医生核对：睡眠正常。第3次核对。')
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'failed', remainingCount: 1,
    failures: [{ code: 'CONSULTATION_RECORDING_FAILED', retrying: false }], additions: [] })
  await fixture.restart()
  changing = false
  expect((await fixture.control('retry')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness)
    .toBe('医生核对：睡眠正常。第3次核对。\n患者自述：胸痛两天了。')
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'updated', remainingCount: 0 })
})

it.each(['已撤回旧记录：', '独立补充。'] as const)('rechecks the full handwritten sentence after inserting %s before a pending target', async prefix => {
  const original = '医生核对：否认胸痛。'
  const fixture = await setup({ reply: '胸痛两天了。', extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }>;
      manualHistory: Array<{ id: string; text: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
      quote: '胸痛两天了。', relation: 'conflict', targetAdditionId: payload.manualHistory.find(item => item.text === original)!.id }] }
  } })
  expect((await fixture.save(original)).status).toBe(200)
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const addition = (await fixture.read()).consultationRecording!.additions[0]!
  expect((await fixture.save(prefix + original)).status).toBe(200)
  const independent = prefix.endsWith('。')
  expect((await fixture.read()).consultationRecording!.additions[0]?.reviewable).toBe(independent)
  expect((await fixture.review(addition.id, 'accept')).status).toBe(independent ? 200 : 409)
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness)
    .toBe(prefix + (independent ? '患者自述：胸痛两天了。' : original))
})

it('keeps a multi-sentence attributed manual fragment pending instead of replacing unrelated history', async () => {
  let reply = '否认胸痛。'
  const fixture = await setup({ reply: () => reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string; messageText: string }>;
      manualHistory?: Array<{ id: string; text: string }> }
    const answer = payload.turns.at(-1)!
    const target = payload.manualHistory?.find(item => item.text === '患者自述：睡眠正常。否认胸痛。')
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: answer.id, quote: answer.messageText,
      relation: target === undefined ? 'addition' : 'conflict', ...(target === undefined ? {} : { targetAdditionId: target.id }) }] }
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const expanded = '患者自述：睡眠正常。否认胸痛。'
  expect((await fixture.save(expanded)).status).toBe(200)
  reply = '胸痛两天了。'
  expect((await fixture.askMore()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const addition = (await fixture.read()).consultationRecording!.additions.find(item => item.status === 'pending')!
  expect(addition.reviewable).toBe(false)
  expect((await fixture.review(addition.id, 'accept')).status).toBe(409)
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(expanded)
})

it('moves a handwritten conflict anchor through unrelated edits and automatic additions in the same field', async () => {
  const fixture = await setup({ reply: '胸痛两天了。走路容易累。', extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }>;
      manualHistory: Array<{ id: string; field: string; text: string }> }
    const target = payload.manualHistory.find(item => item.text === '医生核对：否认胸痛。')!
    return { additions: [
      { field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
        quote: '胸痛两天了。', relation: 'conflict', targetAdditionId: target.id },
      { field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
        quote: '走路容易累。', relation: 'addition' },
    ] }
  } })
  expect((await fixture.save('医生核对：否认胸痛。\n睡眠正常。')).status).toBe(200)
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const detail = await fixture.read()
  expect(detail.clinicalDocument?.draft?.historyOfPresentIllness).toBe('医生核对：否认胸痛。\n睡眠正常。\n患者自述：走路容易累。')
  const pending = detail.consultationRecording!.additions.find(item => item.status === 'pending')!
  expect((await fixture.save('🙂医生补充：近日食欲正常。\n' + detail.clinicalDocument!.draft!.historyOfPresentIllness)).status).toBe(200)
  await fixture.restart()
  expect((await fixture.read()).consultationRecording!.additions.find(item => item.id === pending.id)?.reviewable).toBe(true)
  expect((await fixture.review(pending.id, 'accept')).status).toBe(200)
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness)
    .toBe('🙂医生补充：近日食欲正常。\n患者自述：胸痛两天了。\n睡眠正常。\n患者自述：走路容易累。')
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
  await fixture.applySuggestions()
  const detail = await fixture.read()
  expect(detail.clinicalDocument?.draft?.historyOfPresentIllness).toBe('医生核对：否认胸痛。')
  expect(detail.consultationRecording).toMatchObject({ status: 'failed', additions: [], failures: [
    { code: 'CONSULTATION_RECORDING_SOURCE_INVALID', retrying: false },
  ] })
})

it('protects an edited sentence while appending unrelated history in the same field', async () => {
  let reply = '头晕一周了。'
  const { applySuggestions, runtime, read, ask, askMore, save } = await setup({ reply: () => reply, extract: input => {
    const turns = (input.userPayload as { turns: Array<{ id: string; messageText: string }> }).turns
    return { additions: [{ field: 'historyOfPresentIllness', sourceTurnId: turns.at(-1)!.id,
      quote: turns.at(-1)!.messageText, relation: 'addition' }] }
  } })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  await applySuggestions()
  expect((await save('医生核对：头晕五天。')).status).toBe(200)
  reply = '站起来时更明显。'
  expect((await askMore()).status).toBe(200)
  await runtime.dispatchPending()
  await applySuggestions()
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
  await fixture.applySuggestions()
  reply = '刚才说错了，头晕是五天。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
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
  await fixture.applySuggestions()
  for (const correction of ['刚才说错了，头晕是五天。', '刚才说错了，头晕是六天。', '刚才说错了，头晕是五天。']) {
    reply = correction
    expect((await fixture.askMore()).status).toBe(200)
    await fixture.runtime.dispatchPending()
    await fixture.applySuggestions()
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
  await fixture.applySuggestions()
  expect((await fixture.save('医生核对：头晕六天。')).status).toBe(200)
  await fixture.restart()
  reply = '刚才记错了，头晕是五天。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
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
  await fixture.applySuggestions()
  await fixture.save('医生核对：头晕五天。\n患者自述：站起来时更明显。\n医生核对：白天也会头晕。')
  reply = '刚才说错了，站起来时不明显。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
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
  await fixture.applySuggestions()
  const original = (await fixture.read()).clinicalDocument!.draft!.historyOfPresentIllness
  expect((await fixture.save(original.replace('头晕一周了', '头晕五天了'))).status).toBe(200)
  reply = '刚才说错了，夜间没有头晕。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
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
  await fixture.applySuggestions()
  reply = '刚才说错了，头晕是五天。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
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
  await fixture.applySuggestions()
  await fixture.save('医生核对：头晕六天。')
  // Seed the migrated representation of an already edited pre-ownership record.
  fixture.runtime.database.driver.prepare(`UPDATE consultation_history_addition SET ownership = 'automatic',
    start_offset = NULL, end_offset = NULL, current_text = '' WHERE case_id = ?`).run(fixture.started.outpatientCaseId)
  await fixture.save('患者自述：头晕一周了。')
  await fixture.restart()
  reply = '刚才说错了，头晕是五天。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
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
  await fixture.applySuggestions()
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
  await fixture.applySuggestions()
  const originalId = (await fixture.read()).consultationRecording!.additions[0]!.id
  await fixture.save('患者自述：头晕一周了。夜间也会头晕。')
  // Seed the original single-row representation before ownership/statement ranges existed.
  fixture.runtime.database.driver.prepare('DELETE FROM consultation_history_addition WHERE case_id = ? AND addition_id != ?')
    .run(fixture.started.outpatientCaseId, originalId)
  fixture.runtime.database.driver.prepare(`UPDATE consultation_history_addition SET quote = ?, facts_json = NULL, ownership = 'automatic',
    start_offset = NULL, end_offset = NULL, current_text = '' WHERE addition_id = ?`).run(reply, originalId)
  await fixture.restart()
  if (ownership === 'manual') await fixture.save('患者自述：头晕五天了。夜间也会头晕。')
  reply = '刚才说错了，夜间没有头晕。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
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
  await fixture.applySuggestions()
  reply = '头晕五天了。'
  await fixture.askMore()
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  expect(await fixture.read()).toMatchObject({ clinicalDocument: { draft: { historyOfPresentIllness: '患者自述：头晕一周了。', version: 1 } },
    consultationRecording: { status: 'pending', additions: [{ status: 'applied' }, { status: 'pending', currentText: '患者自述：头晕一周了。' }] } })
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
  await fixture.applySuggestions()
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
  await fixture.applySuggestions()
  expect((await fixture.read()).consultationRecording?.status).toBe(action === 'active' ? 'updated' : 'failed')
  expect((await fixture.read()).clinicalDocument?.draft === undefined).toBe(action !== 'active')
})

it.each(['active', 'disable', 'revoke'] as const)('records a saved reply with a retry-only Agent Grant only while it is %s', async action => {
  const { applySuggestions, runtime, ask, read, started } = await setup({ failFirstReply: true })
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
  await applySuggestions()
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
  const { applySuggestions, runtime, read, ask, requests } = await setup()
  const response = await ask()
  expect(response.status).toBe(200)
  const asked = sendConsultationMessageResponseSchema.parse(await response.json())
  expect(asked.data.patientTurn.messageText).toBe('头晕一周了，站起来时更明显。')
  expect(await read()).toMatchObject({ consultationRecording: { status: 'processing' } })
  await runtime.dispatchPending()
  await applySuggestions()
  const detail = await read()
  expect(detail).toMatchObject({
    clinicalDocument: { draft: { historyOfPresentIllness: '患者自述：头晕一周了，站起来时更明显。', assessment: '', physicalExamination: '' } },
    consultationRecording: { status: 'updated', additions: [{ sourceTurnId: asked.data.patientTurn.id, status: 'applied' }] },
  })
  const extraction = requests.find(request => request.schemaName === 'consultation_history_increment')!
  expect(extraction.userPayload).toEqual({ turns: expect.any(Array), history: [], rejectedFacts: [] })
  expect(JSON.stringify(extraction.userPayload)).not.toMatch(/hiddenResources|Case Truth|persona|knownConditions|2型糖尿病/)
  const duplicate = await ask()
  expect(duplicate.status).toBe(200)
  await runtime.dispatchPending()
  await applySuggestions()
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
    await fixture.applySuggestions()
    const detail = await fixture.read()
    expect(detail.clinicalDocument?.draft).toBeUndefined()
    expect(detail.consultationRecording).toMatchObject({ status: 'failed', failedCount: 1, remainingCount: 1, additions: [],
      failures: [{ sourceTurnId: detail.consultation?.turns.at(-1)?.id, code, retrying: false }] })
    expect(detail.consultation?.turns).toHaveLength(3)
    expect(JSON.stringify(detail)).not.toContain('private-provider-credential-and-prompt')
    expect(fixture.requests.filter(request => request.schemaName === 'consultation_history_increment')).toHaveLength(1)
    await fixture.restart()
    await fixture.runtime.dispatchPending()
    await fixture.applySuggestions()
    expect((await fixture.read()).consultationRecording).toEqual(detail.consultationRecording)
    expect(fixture.requests.filter(request => request.schemaName === 'consultation_history_increment')).toHaveLength(1)
    fail = false
    const retried = await fixture.control('retry')
    expect(retried.status).toBe(200)
    expect(controlConsultationRecordingResponseSchema.parse(await retried.json()).data).toMatchObject({
      status: 'processing', failedCount: 0, failures: [], remainingCount: 1,
    })
    await fixture.runtime.dispatchPending()
    await fixture.applySuggestions()
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
  await fixture.applySuggestions()
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
  await fixture.applySuggestions()
  if (earlierFailures === 2) {
    expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'failed',
      failures: [{ code: 'CONSULTATION_RECORDING_FAILED', retrying: false }] })
    await fixture.runtime.dispatchPending()
    await fixture.applySuggestions()
    expect((await fixture.read()).clinicalDocument?.draft).toBeUndefined()
    expect(calls).toBe(3)
    return
  }
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'processing', failures: [] })
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  expect((await fixture.read()).consultationRecording).toMatchObject({ status: 'updated', failures: [] })
  expect((await fixture.read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe('患者自述：头晕一周了，站起来时更明显。')
})

it.each(['没有胸痛。', '之前没有胸痛。后来也没有胸痛。'])('rejects a quote that removes the patient negation instead of recording chest pain (%s)', async reply => {
  const { applySuggestions, runtime, ask, read } = await setup({ reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', quote: '胸痛。',
      sourceTurnId: payload.turns.at(-1)!.id, relation: 'addition' }] }
  } })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  await applySuggestions()
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
  await fixture.applySuggestions()
  const detail = await fixture.read()
  expect(detail.consultation!.turns.at(-1)!.messageText).toBe(reply)
  expect(detail.clinicalDocument?.draft).toMatchObject({ historyOfPresentIllness: '患者自述：胸痛。', version: 1 })
  expect(detail.consultationRecording).toMatchObject({ status: 'updated', processedCount: 1, remainingCount: 0,
    failures: [], additions: [{ sourceTurnId: detail.consultation!.turns.at(-1)!.id, quote: '胸痛。', status: 'applied' }] })
  expect(fixture.requests.filter(request => request.schemaName === 'consultation_history_increment')).toHaveLength(1)
})

it.each([false, true])('repairs patient-source validation before exhausting recording retries (manual retry: %s)', async manualRetry => {
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
      return Response.json({ model: request.model, content: JSON.stringify({ additions: [{
        field: 'historyOfPresentIllness', relation: 'addition',
        sourceTurnId: repaired && (!manualRetry || retryEnabled) ? request.userPayload.turns.at(-1)!.id : 'missing-patient-turn',
        quote: repaired && (!manualRetry || retryEnabled) ? confirmed : uncertain,
      }] }) })
    },
  })
  const fixture = await setup({ reply: `${uncertain}${confirmed}`, extract: async input => {
    const result = await provider.completeJson({ ...input, model: 'dsh:{"provider":"synthetic","model":"synthetic"}' })
    return JSON.parse(result.content)
  } })
  expect((await fixture.ask()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
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
    await fixture.applySuggestions()
  }
  expect(await fixture.read()).toMatchObject({
    consultationRecording: { status: 'updated', processedCount: 1, remainingCount: 0, failures: [] },
    clinicalDocument: { draft: { historyOfPresentIllness: `患者自述：${confirmed}` } },
  })
  expect(prompts).toHaveLength(manualRetry ? 4 : 2)
  expect(prompts.at(-1)).toContain('additions.0.facts.0.sources.0')
})

it.each([
  ['胸痛已经三天了吗？', '胸痛已经三天了吗'],
  ['胸痛已经三天?', '胸痛已经三天'],
  ['胸痛已经三天！？', '胸痛已经三天'],
  ['胸痛已经三天！ ？', '胸痛已经三天'],
  ['胸痛已经三天 \t？', '胸痛已经三天'],
])('rejects a quote that removes the question mark from %s', async (reply, quote) => {
  const { applySuggestions, runtime, ask, read } = await setup({ reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', quote,
      sourceTurnId: payload.turns.at(-1)!.id, relation: 'addition' }] }
  } })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  await applySuggestions()
  const detail = await read()
  expect(detail.clinicalDocument?.draft).toBeUndefined()
  expect(detail.consultationRecording).toMatchObject({ status: 'failed', additions: [] })
  expect(detail.consultation?.turns.at(-1)?.messageText).toBe(reply)
})

it.each([' ', '\t', '\u00a0', '\n'])('records a complete statement after sentence whitespace %j', async whitespace => {
  const quote = '站起来时更明显。'
  const { applySuggestions, runtime, ask, read } = await setup({ reply: `头晕一周了。${whitespace}${quote}`, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', quote,
      sourceTurnId: payload.turns.at(-1)!.id, relation: 'addition' }] }
  } })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  await applySuggestions()
  expect(await read()).toMatchObject({
    clinicalDocument: { draft: { historyOfPresentIllness: `患者自述：${quote}` } },
    consultationRecording: { status: 'updated', additions: [{ quote, status: 'applied' }] },
  })
})

it('rejects a quote that drops uncertainty from the same patient sentence', async () => {
  const { applySuggestions, runtime, ask, read } = await setup({ reply: '我不清楚，胸痛已经三天。', extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', quote: '胸痛已经三天。',
      sourceTurnId: payload.turns.at(-1)!.id, relation: 'addition' }] }
  } })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  await applySuggestions()
  expect((await read()).clinicalDocument?.draft).toBeUndefined()
  expect((await read()).consultationRecording).toMatchObject({ status: 'failed', additions: [] })
})

it.each([
  ['我不清楚 胸痛已经三天。', '胸痛已经三天。'],
  ['胸痛已经三天 我不清楚。', '胸痛已经三天'],
])('rejects whitespace clipping that removes uncertainty from %s', async (reply, quote) => {
  const { applySuggestions, runtime, ask, read } = await setup({ reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', quote,
      sourceTurnId: payload.turns.at(-1)!.id, relation: 'addition' }] }
  } })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  await applySuggestions()
  expect((await read()).clinicalDocument?.draft).toBeUndefined()
  expect((await read()).consultationRecording).toMatchObject({ status: 'failed', additions: [] })
})

it.each([
  ['我不清楚，血糖是5.8mmol/L。', '8mmol/L。'],
  ['头晕3.5天。', '头晕3.'],
])('rejects an extraction that splits a decimal in %s', async (reply, quote) => {
  const { applySuggestions, runtime, ask, read } = await setup({ reply, extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }> }
    return { additions: [{ field: 'historyOfPresentIllness', quote,
      sourceTurnId: payload.turns.at(-1)!.id, relation: 'addition' }] }
  } })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  await applySuggestions()
  expect((await read()).clinicalDocument?.draft).toBeUndefined()
  expect((await read()).consultationRecording).toMatchObject({ status: 'failed', additions: [] })
})

it('applies a repeated model addition once without exhausting durable retries', async () => {
  const { applySuggestions, runtime, ask, read } = await setup({ extract: input => {
    const payload = input.userPayload as { turns: Array<{ id: string }> }
    const addition = { field: 'historyOfPresentIllness', quote: '头晕一周了，站起来时更明显。',
      sourceTurnId: payload.turns.at(-1)!.id, relation: 'addition' }
    return { additions: [addition, addition] }
  } })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  await applySuggestions()
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
  const { applySuggestions, runtime, ask, read } = await setup({
    ...(name === 'unknown answer' ? { reply: '我不知道。' } : {}),
    extract: input => ({ additions: [{ field: 'historyOfPresentIllness', relation: 'addition',
      ...candidate((input.userPayload as { turns: Array<{ id: string }> }).turns) }] }),
  })
  expect((await ask()).status).toBe(200)
  await runtime.dispatchPending()
  await applySuggestions()
  expect((await read()).clinicalDocument?.draft).toBeUndefined()
  expect((await read()).consultationRecording).toMatchObject({ status: 'failed', additions: [] })
  expect((await read()).consultation?.turns).toHaveLength(3)
})

it('saves an incomplete draft while preserving required fields for signing', async () => {
  const { applySuggestions, ask, read, runtime, started, cookie } = await setup()
  await ask()
  await runtime.dispatchPending()
  await applySuggestions()
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
  const { applySuggestions, ask, read, runtime, started, cookie } = await setup({ extract: input => {
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
    await applySuggestions()
  }
  expect(await read()).toMatchObject({ clinicalDocument: { draft: { historyOfPresentIllness: '医生手工核对的病史。\n患者自述：头晕一周了，站起来时更明显。', version: 2 } },
    consultationRecording: { status: 'updated', additions: [{ status: 'applied' }] } })
})

it('does not repeat history when the patient repeats the same statement in a later answer', async () => {
  const { applySuggestions, runtime, ask, askMore, read } = await setup()
  await ask()
  await runtime.dispatchPending()
  await applySuggestions()
  expect((await askMore()).status).toBe(200)
  await runtime.dispatchPending()
  await applySuggestions()
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
  await fixture.applySuggestions()
  const initial = await fixture.read()
  expect(initial.consultationRecording!.additions).toHaveLength(1)
  await fixture.restart()
  expect((await fixture.askMore()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  await fixture.applySuggestions()
  const after = await fixture.read()
  expect(after.consultationRecording).toMatchObject({ status: 'updated', processedCount: 2, remainingCount: 0, failures: [] })
  expect(after.consultationRecording!.additions).toEqual(initial.consultationRecording!.additions)
  expect(after.clinicalDocument?.draft).toEqual(initial.clinicalDocument?.draft)
})

it.each(['disable', 'revoke'] as const)('settles a late recording as pending after Agent authorization %s', async action => {
  let release!: (value: unknown) => void
  let entered!: () => void
  let sourceTurnId = ''
  const extracting = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<unknown>(resolve => { release = resolve })
  const { applySuggestions, runtime, ask, read, started } = await setup({ extract: input => {
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
    await applySuggestions()
  }
  expect((await read()).clinicalDocument?.draft).toBeUndefined()
  expect((await read()).consultationRecording).toMatchObject({ status: 'failed', additions: [] })
  expect((await read()).consultation?.turns).toHaveLength(3)
  await runtime.dispatchPending()
  await applySuggestions()
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
