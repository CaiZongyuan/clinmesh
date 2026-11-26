import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { encodeModelRoute } from '@clinmesh/contracts/model-bridge'
import { doctorCaseDetailSchema, laboratoryServiceSnapshotSchema, sendConsultationMessageResponseSchema } from '@clinmesh/contracts/his'
import { doctorRecommendationStateSchema } from '@clinmesh/contracts/doctor-recommendations'
import { modelUsageListSchema } from '@clinmesh/contracts/model-usage'
import { createModelBridgeHandler, type ModelBridgeSelection } from '../../dsh-web/src/model-bridge.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'

type HostContext = Parameters<typeof createModelBridgeHandler>[0]
type GenerateOptions = Parameters<HostContext['llm']['stream']>[0]
type StreamChunk = ReturnType<HostContext['llm']['stream']> extends AsyncIterable<infer Chunk> ? Chunk : never

const secret = 'synthetic-tiered-routing-secret-at-least-32-characters'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function syntheticLaboratory(id: string) {
  const referenceConcept = {
    id: `reference:${id}`,
    code: 'SYN-LAB',
    display: '合成生化指标',
    system: 'urn:synthetic:laboratory',
    version: '1',
    sourceLocator: 'synthetic:test:tiered-routing',
  }
  return laboratoryServiceSnapshotSchema.parse({
    id,
    localCode: id,
    nameZh: `合成检验 ${id}`,
    allowedIndicationCodes: ['clinical-evaluation'],
    componentServiceIds: [],
    doctorOrderable: true,
    executingDepartmentId: 'laboratory',
    priceFen: 1000,
    outpatientBilling: {
      id: `synthetic-price-${id}`,
      version: 1,
      priceFen: 1000,
      currency: 'CNY',
      unit: 'item',
      source: 'synthetic-test',
      effectiveOn: '2026-08-24',
    },
    referenceConcept,
    referenceReleaseId: 'synthetic-laboratory-release',
    serviceKind: 'laboratory',
    specimen: { code: 'blood', display: '静脉血' },
    tatMinutes: 180,
    version: 1,
    reportDefinition: {
      conclusionTemplate: '合成检验结果。',
      results: [{
        referenceConcept,
        alternateCodings: [],
        referenceRange: { low: 0, high: 10, text: '0–10' },
        unit: { code: 'mg/L', display: 'mg/L', system: 'http://unitsofmeasure.org' },
        valueType: 'quantity',
      }],
    },
  })
}

function insertLaboratoryService(runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>, id: string) {
  const service = syntheticLaboratory(id)
  runtime.database.driver.prepare(`INSERT INTO hospital_service_catalog
    (workspace_id, epoch, service_id, code, name_zh, name_en, version, active, config_json)
    VALUES ('workspace-demo', 'epoch-1', ?, ?, ?, ?, 1, 1, ?)
  `).run(service.id, service.localCode, service.nameZh, service.nameZh, JSON.stringify({
    availableScopes: ['outpatient'],
    laboratoryService: service,
  }))
  runtime.laboratoryServicePublisher.ensureDefaultServices()
}

function buildStructuredAnswer(system: string, payload: unknown): unknown {
  const parsed = z.record(z.string(), z.unknown()).safeParse(payload)
  if (!parsed.success) return { ok: true }
  const data = parsed.data
  if ('privateEpisodeEvidence' in data || 'visibleHistory' in data) return persona
  if ('turns' in data && 'currentSourceIds' in data) {
    const turns = z.array(z.object({
      id: z.string(),
      sentences: z.array(z.object({ id: z.string(), text: z.string() })),
    })).parse(data.turns)
    const current = z.array(z.string()).parse(data.currentSourceIds)
    const turn = turns.find(item => current.includes(item.id))!
    return {
      additions: [{
        field: 'historyOfPresentIllness',
        relation: 'addition',
        facts: [{ text: '患者自述头晕三天，否认胸痛', sourceIds: turn.sentences.map(sentence => sentence.id) }],
      }],
    }
  }
  if ('document' in data && 'agentFacts' in data) {
    const agentFacts = z.array(z.object({ id: z.string() })).parse(data.agentFacts)
    const issues = z.array(z.unknown()).optional().parse(data.issues)
    return {
      issues: issues?.map((_, index) => ({ index, supported: true })) ?? [],
      agentFactChecks: agentFacts.map(fact => ({ id: fact.id, supported: true })),
    }
  }
  if ('selectionContextHash' in data && 'catalogs' in data) {
    const catalogs = z.object({ laboratory: z.object({ items: z.array(z.object({ id: z.string() })) }) }).parse(data.catalogs)
    return { complete: true, selectedCatalogItemIds: [catalogs.laboratory.items[0]!.id] }
  }
  if ('items' in data && 'guidelines' in data && !('mode' in data)) {
    const items = z.array(z.object({ id: z.string() })).parse(data.items)
    return {
      items: items.map(item => ({
        id: item.id,
        guidelineSupported: true,
        caseSupported: true,
        applicable: true,
        qualifiersPreserved: true,
      })),
    }
  }
  if ('kind' in data && 'mode' in data) {
    const kind = z.string().parse(data.kind)
    const guidelines = z.array(z.object({ id: z.string() })).parse(data.guidelines)
    const caseEvidence = z.array(z.object({ id: z.string(), text: z.string() })).parse(data.caseEvidence)
    const evidenceId = caseEvidence.find(item => item.text.includes('高血压'))?.id ?? caseEvidence[0]!.id
    if (kind === 'laboratory') {
      const catalogs = z.object({ laboratory: z.object({ items: z.array(z.object({ id: z.string() })) }) }).parse(data.catalogs)
      return {
        items: [{
          id: 'lab-candidate-1',
          kind: 'laboratory',
          catalogItemId: catalogs.laboratory.items[0]!.id,
          indicationCode: 'clinical-evaluation',
          label: '合成检验建议',
          rationale: '结合既往病史核对实验室指标。',
          supportingInformation: ['既往病史支持检验评估'],
          opposingInformation: [],
          missingInformation: ['尚无本次检验结果'],
          guidelineEvidenceIds: [guidelines[0]!.id],
          caseEvidenceIds: [evidenceId],
        }],
        missingInformation: [],
      }
    }
    return {
      items: [{
        id: 'diag-candidate-1',
        kind: 'diagnosis',
        catalogItemId: 'diagnosis-hypertension',
        role: 'primary',
        label: '原发性高血压',
        rationale: '结合既往高血压病史评估。',
        supportingInformation: ['既往高血压病史'],
        opposingInformation: [],
        missingInformation: ['需核对当前血压读数'],
        guidelineEvidenceIds: [guidelines[0]!.id],
        caseEvidenceIds: [evidenceId],
      }],
      missingInformation: [],
    }
  }
  if ('persona' in data || 'consultationHistory' in data || 'doctorMessage' in data || 'latestDoctorMessage' in data || system.includes('患者')) {
    return { reply: '头晕三天了，没有胸痛。' }
  }
  throw new Error(`Unexpected synthetic request for system: ${system.slice(0, 60)}`)
}

it('routes DSH fast and strong tiers separately with auto-lowest effort and keeps bound recommendation routes across settings changes and continuation', async () => {
  const recordedCalls: Array<{
    provider: string
    model: string
    reasoningEffort: string | undefined
    kind: string
  }> = []
  let failGenerationOnce = false

  const llm = {
    listModels: async (provider: string) => [
      { provider, id: 'strong-model', name: 'Strong model' },
      { provider, id: 'fast-model', name: 'Fast model' },
      { provider, id: 'plain-model', name: 'Plain model' },
    ],
    resolveModelInfo: async (provider: string, model: string) => {
      if (model === 'strong-model') {
        return {
          provider,
          id: model,
          name: 'Strong model',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High' },
            ],
            defaultEffort: 'high',
          },
        }
      }
      if (model === 'fast-model') {
        return {
          provider,
          id: model,
          name: 'Fast model',
          reasoning: {
            efforts: [
              { id: 'minimal', name: 'Minimal' },
              { id: 'medium', name: 'Medium' },
            ],
            defaultEffort: 'medium',
          },
        }
      }
      return { provider, id: model, name: 'Plain model' }
    },
    async prepareCall(config: Parameters<HostContext['llm']['prepareCall']>[0]) {
      return { config, stream: (options: GenerateOptions) => this.stream(options) }
    },
    async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
      const payload = JSON.parse(z.object({ text: z.string() }).parse(request.messages[0]?.content[0]).text) as Record<string, unknown>
      const kind = 'privateEpisodeEvidence' in payload ? 'patient_persona'
        : 'turns' in payload && 'currentSourceIds' in payload ? 'consultation_history_summary'
          : 'document' in payload && 'agentFacts' in payload ? 'clinical_document_quality'
            : 'selectionContextHash' in payload && 'catalogs' in payload ? 'doctor_recommendation_catalog_selection'
              : 'items' in payload && 'guidelines' in payload && !('mode' in payload) ? 'doctor_recommendation_verification'
                : 'kind' in payload && 'mode' in payload ? 'doctor_recommendations'
                  : 'patient_dialogue_reply'
      recordedCalls.push({
        provider: request.provider,
        model: request.model,
        reasoningEffort: request.reasoningEffort === undefined ? undefined : String(request.reasoningEffort),
        kind,
      })
      if (kind === 'doctor_recommendations' && failGenerationOnce) {
        failGenerationOnce = false
        throw new Error('Synthetic disconnected generation stream')
      }
      const answer = buildStructuredAnswer(request.system ?? '', payload)
      yield { type: 'text-delta', index: 0, text: JSON.stringify(answer) }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  let selection: ModelBridgeSelection = {
    generationModel: encodeModelRoute({ provider: 'synthetic', model: 'strong-model' }),
    generationReasoningEffort: 'high',
    fastModel: encodeModelRoute({ provider: 'synthetic', model: 'fast-model' }),
    fastReasoningEffort: 'auto-lowest',
  }
  const bridge = createModelBridgeHandler({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'synthetic', model: 'strong-model' }) },
  } as unknown as HostContext, secret, () => selection)
  const hostServer: Server = createServer(bridge.handler)
  await new Promise<void>(resolve => hostServer.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    bridge.dispose()
    hostServer.closeAllConnections()
    await new Promise<void>(resolve => hostServer.close(() => resolve()))
  })
  const hostAddress = hostServer.address()
  if (hostAddress === null || typeof hostAddress === 'string') throw new Error('Host server unavailable')

  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-tiered-dsh-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const runtimeOptions = {
    dshModelBridge: { origin: `http://127.0.0.1:${hostAddress.port}`, secret, timeoutMs: 3000, maxResponseBytes: 1024 * 1024 },
    databasePath: join(directory, 'clinmesh.sqlite'),
    authBaseUrl: 'http://localhost',
    authSecret: secret,
    cursorSecret: secret,
    demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply' as const,
    outboxRetryDelayMs: 0,
    syntheaProvider: new StubSyntheaProvider(),
    trustedOrigins: ['http://localhost'],
  }
  let runtime = await createClinMeshRuntime(runtimeOptions)
  cleanup.push(async () => { await runtime.close() })

  const started = await startConsultationCase(runtime)
  const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const headers = () => ({ cookie: doctorCookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() })

  // Claim visit and ask a consultation question (triggers fast dialogue + fast recording + strong quality).
  expect((await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      expectedVersions: { [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1' },
      input: {},
    }),
  })).status).toBe(200)
  const beforeAsk = doctorCaseDetailSchema.parse(await (await runtime.app.request(
    `/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie: doctorCookie } },
  )).json())
  const asked = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/ask-consultation-question`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      expectedVersions: { [`Encounter/${started.encounterId}`]: beforeAsk.encounter.versionId, [`Task/${beforeAsk.taskId}`]: beforeAsk.taskVersion },
      input: { expectedConsultationVersion: beforeAsk.consultation!.version, message: '头晕多久了？' },
    }),
  })
  expect(asked.status).toBe(200)
  expect(sendConsultationMessageResponseSchema.parse(await asked.json()).data.patientTurn.messageText).toBe('头晕三天了，没有胸痛。')
  await runtime.dispatchPending()

  expect(recordedCalls.find(call => call.kind === 'patient_persona')).toMatchObject({ model: 'fast-model', reasoningEffort: 'minimal' })
  expect(recordedCalls.find(call => call.kind === 'patient_dialogue_reply')).toMatchObject({ model: 'fast-model', reasoningEffort: 'minimal' })
  expect(recordedCalls.find(call => call.kind === 'consultation_history_summary')).toMatchObject({ model: 'fast-model', reasoningEffort: 'minimal' })
  expect(recordedCalls.find(call => call.kind === 'clinical_document_quality')).toMatchObject({ model: 'strong-model', reasoningEffort: 'high' })

  // Laboratory recommendation: fast catalog-selection + strong generation/verification; interrupt generation then continue after settings change.
  insertLaboratoryService(runtime, 'lab-tiered-01')
  const readRec = async () => doctorRecommendationStateSchema.parse(await (await runtime.app.request(
    `/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/laboratory`, { headers: { cookie: doctorCookie } },
  )).json())
  const initialState = await readRec()
  failGenerationOnce = true
  const generated = await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/laboratory/actions/generate`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      expectedVersions: { [`Encounter/${initialState.encounterId}`]: initialState.encounterVersion },
      input: { expectedInputFingerprint: initialState.inputFingerprint, refresh: false },
    }),
  })
  expect(generated.status).toBe(200)
  await runtime.dispatchPending()
  const interrupted = await readRec()
  expect(interrupted).toMatchObject({ status: 'failed', errorCode: 'MODEL_OUTCOME_UNKNOWN', recovery: { status: 'unknown', canContinue: true } })

  // Change DSH model settings to plain-model and restart server; explicit continuation must keep original strong/fast routes without re-running catalog selection.
  selection = {
    generationModel: encodeModelRoute({ provider: 'synthetic', model: 'plain-model' }),
    generationReasoningEffort: 'default',
    fastModel: encodeModelRoute({ provider: 'synthetic', model: 'plain-model' }),
    fastReasoningEffort: 'auto-lowest',
  }
  await runtime.close()
  runtime = await createClinMeshRuntime(runtimeOptions)
  const callsBeforeContinue = recordedCalls.length
  const continued = await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/laboratory/actions/generate`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      expectedVersions: { [`Encounter/${interrupted.encounterId}`]: interrupted.encounterVersion },
      input: { expectedInputFingerprint: interrupted.inputFingerprint, refresh: false, continueGeneration: interrupted.generation },
    }),
  })
  expect(continued.status, await continued.clone().text()).toBe(200)
  await runtime.dispatchPending()
  expect(await readRec()).toMatchObject({ status: 'ready', generation: interrupted.generation })

  const recCalls = recordedCalls.filter(call => call.kind.startsWith('doctor_recommendation'))
  expect(recCalls.filter(call => call.kind === 'doctor_recommendation_catalog_selection')).toEqual([
    { provider: 'synthetic', model: 'fast-model', reasoningEffort: 'minimal', kind: 'doctor_recommendation_catalog_selection' },
  ])
  const afterContinueCalls = recordedCalls.slice(callsBeforeContinue)
  expect(afterContinueCalls).toEqual([
    { provider: 'synthetic', model: 'strong-model', reasoningEffort: 'high', kind: 'doctor_recommendations' },
    { provider: 'synthetic', model: 'strong-model', reasoningEffort: 'high', kind: 'doctor_recommendation_verification' },
  ])

  // New explicit refresh uses the newly configured plain-model (omitting reasoningEffort).
  const beforeRefresh = await readRec()
  const callsBeforeRefresh = recordedCalls.length
  const refreshed = await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/laboratory/actions/generate`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      expectedVersions: { [`Encounter/${beforeRefresh.encounterId}`]: beforeRefresh.encounterVersion },
      input: { expectedInputFingerprint: beforeRefresh.inputFingerprint, refresh: true },
    }),
  })
  expect(refreshed.status).toBe(200)
  await runtime.dispatchPending()
  expect(await readRec()).toMatchObject({ status: 'ready', generation: beforeRefresh.generation + 1 })
  expect(recordedCalls.slice(callsBeforeRefresh)).toEqual([
    { provider: 'synthetic', model: 'plain-model', reasoningEffort: undefined, kind: 'doctor_recommendation_catalog_selection' },
    { provider: 'synthetic', model: 'plain-model', reasoningEffort: undefined, kind: 'doctor_recommendations' },
    { provider: 'synthetic', model: 'plain-model', reasoningEffort: undefined, kind: 'doctor_recommendation_verification' },
  ])
}, 30_000)

async function startMockOpenAI() {
  const requests: Array<{ model: string; reasoning_effort?: string; schemaName?: string }> = []
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      model: string
      reasoning_effort?: string
      response_format?: { json_schema?: { name?: string } }
      messages: Array<{ role: string; content: string }>
    }
    const schemaName = body.response_format?.json_schema?.name
    requests.push({
      model: body.model,
      ...(body.reasoning_effort === undefined ? {} : { reasoning_effort: body.reasoning_effort }),
      ...(schemaName === undefined ? {} : { schemaName }),
    })
    const systemPrompt = body.messages[0]?.content ?? ''
    const userPayload = JSON.parse(body.messages[1]?.content ?? '{}')
    const answer = buildStructuredAnswer(systemPrompt, userPayload)
    const responseBody = JSON.stringify({
      id: `req-${requests.length}`,
      model: body.model,
      usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
      choices: [{ message: { role: 'assistant', content: JSON.stringify(answer) } }],
    })
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(responseBody) }).end(responseBody)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock OpenAI server unavailable')
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests }
}

it('routes OpenAI direct dual-tier models with reasoning_effort recorded in ModelUsageService and isolates single-sided configs', async () => {
  const openAI = await startMockOpenAI()

  // 1. Both strong and fast configured with distinct reasoning_effort.
  const dualDir = await mkdtemp(join(tmpdir(), 'clinmesh-openai-dual-'))
  cleanup.push(() => rm(dualDir, { recursive: true, force: true }))
  const dual = await createClinMeshRuntime({
    ai: {
      apiKey: 'synthetic-key',
      baseUrl: openAI.baseUrl,
      strongModel: 'openai-strong',
      fastModel: 'openai-fast',
      strongReasoningEffort: 'high',
      fastReasoningEffort: 'low',
      maxResponseBytes: 1024 * 1024,
      timeoutMs: 5000,
    },
    databasePath: join(dualDir, 'clinmesh.sqlite'),
    authBaseUrl: 'http://localhost',
    authSecret: secret,
    cursorSecret: secret,
    demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply',
    outboxRetryDelayMs: 0,
    syntheaProvider: new StubSyntheaProvider(),
    trustedOrigins: ['http://localhost'],
  })
  cleanup.push(async () => { await dual.close() })

  const startedDual = await startConsultationCase(dual)
  insertLaboratoryService(dual, 'lab-openai-01')
  const doctorDual = await signIn(dual, 'doctor@demo.clinmesh.local')
  const adminDual = await signIn(dual, 'admin@demo.clinmesh.local')
  const dualHeaders = () => ({ cookie: doctorDual, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() })
  expect((await dual.app.request(`/api/his/v1/encounters/${startedDual.encounterId}/actions/start-first-visit`, {
    method: 'POST',
    headers: dualHeaders(),
    body: JSON.stringify({
      expectedVersions: { [`Encounter/${startedDual.encounterId}`]: startedDual.encounterVersion, [`Task/${startedDual.doctorTaskId}`]: '1' },
      input: {},
    }),
  })).status).toBe(200)
  const labState = doctorRecommendationStateSchema.parse(await (await dual.app.request(
    `/api/his/v1/doctor/cases/${startedDual.outpatientCaseId}/recommendations/laboratory`, { headers: { cookie: doctorDual } },
  )).json())
  expect((await dual.app.request(`/api/his/v1/doctor/cases/${startedDual.outpatientCaseId}/recommendations/laboratory/actions/generate`, {
    method: 'POST',
    headers: dualHeaders(),
    body: JSON.stringify({
      expectedVersions: { [`Encounter/${labState.encounterId}`]: labState.encounterVersion },
      input: { expectedInputFingerprint: labState.inputFingerprint, refresh: false },
    }),
  })).status).toBe(200)
  await dual.dispatchPending()

  expect(openAI.requests).toContainEqual({ model: 'openai-fast', reasoning_effort: 'low', schemaName: 'patient_persona' })
  expect(openAI.requests).toContainEqual({ model: 'openai-fast', reasoning_effort: 'low', schemaName: 'doctor_recommendation_catalog_selection' })
  expect(openAI.requests).toContainEqual({ model: 'openai-strong', reasoning_effort: 'high', schemaName: 'doctor_recommendations' })
  expect(openAI.requests).toContainEqual({ model: 'openai-strong', reasoning_effort: 'high', schemaName: 'doctor_recommendation_verification' })

  const ledger = modelUsageListSchema.parse(await (await dual.app.request('/api/model-usage/requests?limit=20', {
    headers: { cookie: adminDual },
  })).json())
  expect(ledger.items.find(item => item.feature === 'patient_persona')).toMatchObject({
    requestedModel: 'openai-fast',
    reasoningEffort: 'low',
  })
  expect(ledger.items.find(item => item.feature === 'doctor_recommendation_catalog_selection')).toMatchObject({
    requestedModel: 'openai-fast',
    reasoningEffort: 'low',
  })
  expect(ledger.items.find(item => item.feature === 'doctor_recommendations')).toMatchObject({
    requestedModel: 'openai-strong',
    reasoningEffort: 'high',
  })
})

it('isolates single-sided OpenAI fast-only configuration without leaking into strong tasks', async () => {
  const openAI = await startMockOpenAI()
  const fastDir = await mkdtemp(join(tmpdir(), 'clinmesh-openai-fast-only-'))
  cleanup.push(() => rm(fastDir, { recursive: true, force: true }))
  const fastOnly = await createClinMeshRuntime({
    ai: {
      apiKey: 'synthetic-key',
      baseUrl: openAI.baseUrl,
      fastModel: 'openai-fast-only',
      fastReasoningEffort: 'low',
      maxResponseBytes: 1024 * 1024,
      timeoutMs: 5000,
    },
    databasePath: join(fastDir, 'clinmesh.sqlite'),
    authBaseUrl: 'http://localhost',
    authSecret: secret,
    cursorSecret: secret,
    demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply',
    outboxRetryDelayMs: 0,
    syntheaProvider: new StubSyntheaProvider(),
    trustedOrigins: ['http://localhost'],
  })
  cleanup.push(async () => { await fastOnly.close() })

  const startedFast = await startConsultationCase(fastOnly)
  const doctorFast = await signIn(fastOnly, 'doctor@demo.clinmesh.local')
  const fastHeaders = () => ({ cookie: doctorFast, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() })
  expect((await fastOnly.app.request(`/api/his/v1/encounters/${startedFast.encounterId}/actions/start-first-visit`, {
    method: 'POST',
    headers: fastHeaders(),
    body: JSON.stringify({
      expectedVersions: { [`Encounter/${startedFast.encounterId}`]: startedFast.encounterVersion, [`Task/${startedFast.doctorTaskId}`]: '1' },
      input: {},
    }),
  })).status).toBe(200)
  const fastDiagBefore = doctorRecommendationStateSchema.parse(await (await fastOnly.app.request(
    `/api/his/v1/doctor/cases/${startedFast.outpatientCaseId}/recommendations/diagnosis`, { headers: { cookie: doctorFast } },
  )).json())
  const requestsBeforeStrong = openAI.requests.length
  expect((await fastOnly.app.request(`/api/his/v1/doctor/cases/${startedFast.outpatientCaseId}/recommendations/diagnosis/actions/generate`, {
    method: 'POST',
    headers: fastHeaders(),
    body: JSON.stringify({
      expectedVersions: { [`Encounter/${fastDiagBefore.encounterId}`]: fastDiagBefore.encounterVersion },
      input: { expectedInputFingerprint: fastDiagBefore.inputFingerprint, refresh: false },
    }),
  })).status).toBe(200)
  await fastOnly.dispatchPending()
  expect(doctorRecommendationStateSchema.parse(await (await fastOnly.app.request(
    `/api/his/v1/doctor/cases/${startedFast.outpatientCaseId}/recommendations/diagnosis`, { headers: { cookie: doctorFast } },
  )).json())).toMatchObject({ status: 'failed', errorCode: 'MODEL_UNAVAILABLE' })
  expect(openAI.requests).toHaveLength(requestsBeforeStrong)
})

it('isolates single-sided OpenAI strong-only configuration without leaking into fast tasks or selection stages', async () => {
  const openAI = await startMockOpenAI()
  const strongDir = await mkdtemp(join(tmpdir(), 'clinmesh-openai-strong-only-'))
  cleanup.push(() => rm(strongDir, { recursive: true, force: true }))
  const strongDbPath = join(strongDir, 'clinmesh.sqlite')
  const bootstrapRuntime = await createClinMeshRuntime({
    ai: {
      apiKey: 'synthetic-key',
      baseUrl: openAI.baseUrl,
      fastModel: 'bootstrap-fast',
      maxResponseBytes: 1024 * 1024,
      timeoutMs: 5000,
    },
    databasePath: strongDbPath,
    authBaseUrl: 'http://localhost',
    authSecret: secret,
    cursorSecret: secret,
    demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply',
    outboxRetryDelayMs: 0,
    syntheaProvider: new StubSyntheaProvider(),
    trustedOrigins: ['http://localhost'],
  })
  const startedStrong = await startConsultationCase(bootstrapRuntime)
  await bootstrapRuntime.close()
  openAI.requests.length = 0

  const strongOnly = await createClinMeshRuntime({
    ai: {
      apiKey: 'synthetic-key',
      baseUrl: openAI.baseUrl,
      strongModel: 'openai-strong-only',
      strongReasoningEffort: 'high',
      maxResponseBytes: 1024 * 1024,
      timeoutMs: 5000,
    },
    databasePath: strongDbPath,
    authBaseUrl: 'http://localhost',
    authSecret: secret,
    cursorSecret: secret,
    demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply',
    outboxRetryDelayMs: 0,
    syntheaProvider: new StubSyntheaProvider(),
    trustedOrigins: ['http://localhost'],
  })
  cleanup.push(async () => { await strongOnly.close() })
  insertLaboratoryService(strongOnly, 'lab-strong-only-01')

  const doctorStrong = await signIn(strongOnly, 'doctor@demo.clinmesh.local')
  const strongHeaders = () => ({ cookie: doctorStrong, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() })
  expect((await strongOnly.app.request(`/api/his/v1/encounters/${startedStrong.encounterId}/actions/start-first-visit`, {
    method: 'POST',
    headers: strongHeaders(),
    body: JSON.stringify({
      expectedVersions: { [`Encounter/${startedStrong.encounterId}`]: startedStrong.encounterVersion, [`Task/${startedStrong.doctorTaskId}`]: '1' },
      input: {},
    }),
  })).status).toBe(200)

  // Compact diagnosis recommendation succeeds on strong-only model.
  const strongDiagBefore = doctorRecommendationStateSchema.parse(await (await strongOnly.app.request(
    `/api/his/v1/doctor/cases/${startedStrong.outpatientCaseId}/recommendations/diagnosis`, { headers: { cookie: doctorStrong } },
  )).json())
  expect((await strongOnly.app.request(`/api/his/v1/doctor/cases/${startedStrong.outpatientCaseId}/recommendations/diagnosis/actions/generate`, {
    method: 'POST',
    headers: strongHeaders(),
    body: JSON.stringify({
      expectedVersions: { [`Encounter/${strongDiagBefore.encounterId}`]: strongDiagBefore.encounterVersion },
      input: { expectedInputFingerprint: strongDiagBefore.inputFingerprint, refresh: false },
    }),
  })).status).toBe(200)
  await strongOnly.dispatchPending()
  expect(doctorRecommendationStateSchema.parse(await (await strongOnly.app.request(
    `/api/his/v1/doctor/cases/${startedStrong.outpatientCaseId}/recommendations/diagnosis`, { headers: { cookie: doctorStrong } },
  )).json())).toMatchObject({ status: 'ready' })
  expect(openAI.requests).toEqual([
    { model: 'openai-strong-only', reasoning_effort: 'high', schemaName: 'doctor_recommendations' },
    { model: 'openai-strong-only', reasoning_effort: 'high', schemaName: 'doctor_recommendation_verification' },
  ])

  // Laboratory recommendation (requires fast catalog-selection) refuses without cross-using strong-only model.
  openAI.requests.length = 0
  const strongLabBefore = doctorRecommendationStateSchema.parse(await (await strongOnly.app.request(
    `/api/his/v1/doctor/cases/${startedStrong.outpatientCaseId}/recommendations/laboratory`, { headers: { cookie: doctorStrong } },
  )).json())
  expect((await strongOnly.app.request(`/api/his/v1/doctor/cases/${startedStrong.outpatientCaseId}/recommendations/laboratory/actions/generate`, {
    method: 'POST',
    headers: strongHeaders(),
    body: JSON.stringify({
      expectedVersions: { [`Encounter/${strongLabBefore.encounterId}`]: strongLabBefore.encounterVersion },
      input: { expectedInputFingerprint: strongLabBefore.inputFingerprint, refresh: false },
    }),
  })).status).toBe(200)
  await strongOnly.dispatchPending()
  expect(doctorRecommendationStateSchema.parse(await (await strongOnly.app.request(
    `/api/his/v1/doctor/cases/${startedStrong.outpatientCaseId}/recommendations/laboratory`, { headers: { cookie: doctorStrong } },
  )).json())).toMatchObject({ status: 'failed', errorCode: 'MODEL_UNAVAILABLE' })
  expect(openAI.requests).toHaveLength(0)

  // Fast patient dialogue also refuses without cross-using strong-only model.
  const strongDetail = doctorCaseDetailSchema.parse(await (await strongOnly.app.request(
    `/api/his/v1/doctor/cases/${startedStrong.outpatientCaseId}`, { headers: { cookie: doctorStrong } },
  )).json())
  const strongAsk = await strongOnly.app.request(`/api/his/v1/encounters/${startedStrong.encounterId}/actions/ask-consultation-question`, {
    method: 'POST',
    headers: strongHeaders(),
    body: JSON.stringify({
      expectedVersions: { [`Encounter/${startedStrong.encounterId}`]: strongDetail.encounter.versionId, [`Task/${strongDetail.taskId}`]: strongDetail.taskVersion },
      input: { expectedConsultationVersion: strongDetail.consultation!.version, message: '多久了？' },
    }),
  })
  expect(strongAsk.status).toBe(503)
  expect(openAI.requests).toHaveLength(0)
}, 30_000)
