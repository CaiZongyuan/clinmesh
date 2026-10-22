import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { doctorRecommendationStateSchema, generateDoctorRecommendationsResponseSchema } from '@clinmesh/contracts/doctor-recommendations'
import { encodeModelRoute, modelBridgeRequestSchema } from '@clinmesh/contracts/model-bridge'
import { unknownModelTokenUsage } from '@clinmesh/contracts/model-usage'
import type { GuidelineDocument } from '../src/application/guideline-corpus.ts'
import { GuidelineCorpus } from '../src/infrastructure/sqlite/guideline-corpus.ts'
import { DshModelProvider } from '../src/infrastructure/ai/dsh-model-provider.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'
import { syntheticGuidelineDocument as document, syntheticGuidelineParagraph as paragraph } from './fixtures/guideline-corpus.ts'
import { doctorGuidelineGroups } from '../src/application/doctor-guideline-evidence.ts'

const disposals: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })

async function setup(chiefComplaint = '糖尿病复查。') {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-guideline-http-'))
  disposals.push(() => rm(directory, { recursive: true, force: true }))
  const corpusPath = join(directory, 'guidelines.sqlite')
  const writer = new GuidelineCorpus({ databasePath: corpusPath })
  disposals.push(() => writer.close())
  writer.importDocument(document)
  const route = encodeModelRoute({ provider: 'synthetic', model: 'synthetic' })
  const bridge = { origin: 'http://127.0.0.1:1', secret: 'synthetic-guideline-bridge-secret', timeoutMs: 1000, maxResponseBytes: 256 * 1024 }
  const seen: Record<string, unknown> = {}
  const provider = new DshModelProvider({ ...bridge, fetch: async (_url, init) => {
    const input = modelBridgeRequestSchema.parse(JSON.parse(String(init?.body)))
    if (input.operation === 'resolve') return Response.json({ model: route })
    let result: unknown
    if (input.schemaName === 'patient_persona') result = persona
    else if (input.schemaName === 'clinical_document_quality' || input.schemaName === 'clinical_document_quality_verification') {
      const payload = z.object({ agentFacts: z.array(z.object({ id: z.string() })) }).parse(input.userPayload)
      result = { issues: [], agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })) }
    } else if (input.schemaName === 'doctor_recommendations') {
      const payload = z.object({ guidelines: z.array(z.object({ id: z.string(), title: z.string() }).passthrough()),
        caseEvidence: z.array(z.object({ id: z.string(), text: z.string() })) }).parse(input.userPayload)
      seen.generation = payload.guidelines
      const guideline = payload.guidelines.find(item => item.title === document.source.title)
      const fact = payload.caseEvidence.find(item => item.text.includes('糖尿病'))
      result = guideline === undefined || fact === undefined ? { items: [], considerations: [], missingInformation: ['未收到已导入的糖尿病指南或病例资料。'] } : {
        items: [{ id: 'synthetic-diabetes-candidate', kind: 'diagnosis', role: 'primary', catalogItemId: 'diagnosis-type-2-diabetes-hyperglycemia',
          label: '合成糖尿病候选', rationale: '仅验证指南检索和实际病例引用进入独立核验。', supportingInformation: ['医生已记录糖尿病病史。'],
          opposingInformation: [], missingInformation: ['仍由医生核对当前诊断。'], guidelineEvidenceIds: [guideline.id], caseEvidenceIds: [fact.id] }],
        missingInformation: [],
      }
    } else if (input.schemaName === 'doctor_recommendation_verification') {
      const payload = z.object({ guidelines: z.array(z.unknown()), items: z.array(z.object({ id: z.string() })) }).parse(input.userPayload)
      seen.verification = payload.guidelines
      result = { items: payload.items.map(item => ({ id: item.id, guidelineSupported: true, caseSupported: true,
        applicable: true, qualifiersPreserved: true })) }
    } else throw new Error(`Unexpected synthetic schema ${input.schemaName}`)
    return Response.json({ model: input.model, content: JSON.stringify(result),
      ...(input.attemptId === undefined ? {} : { accounting: { attemptId: input.attemptId,
        status: 'succeeded', dispatch: 'dispatched', usage: unknownModelTokenUsage } }) })
  } })
  const options: Parameters<typeof createClinMeshRuntime>[0] = {
    databasePath: join(directory, 'hospital.sqlite'), guidelineDatabasePath: corpusPath,
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-guideline-auth-secret-at-least-32',
    cursorSecret: 'synthetic-guideline-cursor-secret-at-least-32', demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply', trustedOrigins: ['http://localhost'], dshModelBridge: bridge,
    chatCompletionsProvider: provider, syntheaProvider: new StubSyntheaProvider(),
    imagingAssetDirectory: join(directory, 'imaging'), imagingCatalogDirectory: join(directory, 'imaging-catalog'),
    pathologyAssetDirectory: join(directory, 'pathology'), pathologyCatalogDirectory: join(directory, 'pathology-catalog'),
  }
  const runtime = await createClinMeshRuntime(options)
  disposals.push(() => runtime.close())
  const started = await startConsultationCase(runtime)
  const cookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const headers = { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }
  const claimed = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, {
    method: 'POST', headers, body: JSON.stringify({ expectedVersions: {
      [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1',
    }, input: {} }),
  })
  expect(claimed.status).toBe(200)
  const readCase = async () => doctorCaseDetailSchema.parse(await (await runtime.app.request(
    `/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } },
  )).json())
  const clinical = await readCase()
  const saved = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`, {
    method: 'PUT', headers: { ...headers, 'idempotency-key': randomUUID() }, body: JSON.stringify({
      expectedVersions: { [`Encounter/${started.encounterId}`]: clinical.encounter.versionId },
      input: { expectedDraftVersion: clinical.clinicalDocument?.draft?.version ?? 0,
        document: { assessment: '', chiefComplaint, disposition: '', followUp: '',
          historyOfPresentIllness: '医生补充：既往确诊2型糖尿病，本次核对血糖和原治疗。', physicalExamination: '' } },
    }),
  })
  expect(saved.status).toBe(200)
  const path = `/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/diagnosis`
  const read = async (reader = runtime) => doctorRecommendationStateSchema.parse(await (await reader.app.request(path, { headers: { cookie } })).json())
  const generate = async (target = runtime) => {
    const state = await read(target)
    const response = await target.app.request(`${path}/actions/generate`, { method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${state.encounterId}`]: state.encounterVersion },
        input: { expectedInputFingerprint: state.inputFingerprint, refresh: true } }) })
    expect(response.status).toBe(200)
    const pending = generateDoctorRecommendationsResponseSchema.parse(await response.json())
    expect(pending.data).toMatchObject({ status: 'pending' })
    expect(pending.data).not.toHaveProperty('hidePreviousResults')
    await target.dispatchPending()
    return read(target)
  }
  return { runtime, options, writer, seen, read, readCase, generate, path, headers }
}

it('uses imported original guideline passages in generation and independent verification without changing clinical drafts', async () => {
  const fixture = await setup()
  const before = (await fixture.readCase()).clinicalDocument
  const state = await fixture.generate()
  expect(state.guidelines).toContainEqual(expect.objectContaining({ title: document.source.title,
    text: paragraph, locator: document.passages[0]!.locator, sourceHash: document.source.sha256 }))
  expect(state).toMatchObject({ status: 'ready', stale: false, items: [expect.objectContaining({ kind: 'diagnosis', label: '2型糖尿病伴高血糖' })] })
  expect(fixture.seen.verification).toEqual(fixture.seen.generation)
  expect((await fixture.readCase()).clinicalDocument).toEqual(before)
})

it('does not send non-commercial passages to the model without an explicit deployment declaration', async () => {
  const fixture = await setup('糖尿病复查，咳嗽。')
  fixture.writer.importDocument({ ...document, source: { ...document.source,
    license: { ...document.source.license, usage: 'non-commercial' } } })
  const before = (await fixture.readCase()).clinicalDocument
  const state = await fixture.generate()
  expect(state.guidelines.some(item => item.title === document.source.title)).toBe(false)
  expect(fixture.seen.generation).not.toContainEqual(expect.objectContaining({ title: document.source.title }))
  expect(state.items).toEqual([])
  expect((await fixture.readCase()).clinicalDocument).toEqual(before)
})

it('enables non-commercial passages only in the declared runtime and invalidates its cached recommendations in a restricted runtime', async () => {
  const fixture = await setup('糖尿病复查，咳嗽。')
  fixture.writer.importDocument({ ...document, source: { ...document.source,
    license: { ...document.source.license, usage: 'non-commercial' } } })
  const allowed = await createClinMeshRuntime({ ...fixture.options, guidelineNonCommercialUse: true })
  disposals.push(() => allowed.close())
  const original = await fixture.generate(allowed)
  expect(original).toMatchObject({ status: 'ready', stale: false })
  expect(original).not.toHaveProperty('hidePreviousResults')
  expect(original.guidelines).toContainEqual(expect.objectContaining({ title: document.source.title, text: paragraph }))
  expect(original.guidelines).toContainEqual(expect.objectContaining({ id: 'nhc-influenza-2025-diagnosis' }))
  expect(fixture.seen.verification).toEqual(fixture.seen.generation)
  const key = randomUUID()
  const replayRequest = (target: typeof fixture.runtime) => target.app.request(`${fixture.path}/actions/generate`, {
    method: 'POST', headers: { ...fixture.headers, 'idempotency-key': key },
    body: JSON.stringify({ expectedVersions: { [`Encounter/${original.encounterId}`]: original.encounterVersion },
      input: { expectedInputFingerprint: original.inputFingerprint, refresh: false } }),
  })
  const cachedResponse = await replayRequest(allowed)
  expect(cachedResponse.status).toBe(200)
  const cached = generateDoctorRecommendationsResponseSchema.parse(await cachedResponse.json())
  expect(cached.data.guidelines).toContainEqual(expect.objectContaining({ text: paragraph }))
  const restricted = await fixture.read()
  expect(restricted).toMatchObject({ stale: true, hidePreviousResults: true })
  expect(restricted.inputFingerprint).not.toBe(original.inputFingerprint)
  expect(restricted.guidelines).toEqual([])
  expect(restricted.items).toEqual([])
  expect(restricted.considerations).toEqual([])
  expect(JSON.stringify(restricted)).not.toContain(paragraph)
  expect(restricted.notices).toContainEqual(expect.objectContaining({ category: 'guideline', message: expect.stringContaining('旧结果已隐藏') }))
  const replayedResponse = await replayRequest(fixture.runtime)
  expect(replayedResponse.status).toBe(200)
  const replayed = generateDoctorRecommendationsResponseSchema.parse(await replayedResponse.json())
  expect(replayed.auditId).toBe(cached.auditId)
  expect(replayed.data).toMatchObject({ generation: original.generation, stale: true, hidePreviousResults: true, guidelines: [], items: [], considerations: [] })
  expect(JSON.stringify(replayed)).not.toContain(paragraph)
  const refreshed = await fixture.generate()
  expect(refreshed.items).toEqual([])
  expect(refreshed).not.toHaveProperty('hidePreviousResults')
  expect(refreshed.guidelines.some(item => item.title === document.source.title)).toBe(false)
  expect(fixture.seen.generation).not.toContainEqual(expect.objectContaining({ title: document.source.title }))
})

it('makes an existing recommendation stale when the imported source changes through a separate writer', async () => {
  const fixture = await setup()
  const original = await fixture.generate()
  expect(original).toMatchObject({ status: 'ready', stale: false })
  const updated = `${paragraph}\nAdditional synthetic recommendation: review renal function before choosing treatment.`
  fixture.writer.importDocument({ source: { ...document.source, version: 'synthetic-2',
    sha256: createHash('sha256').update(updated).digest('hex') },
    passages: [{ locator: '合成第3节第1段，第二版', text: updated }] })
  const stale = await fixture.read()
  expect(stale.stale).toBe(true)
  expect(stale.inputFingerprint).not.toBe(original.inputFingerprint)
  const refreshed = await fixture.generate()
  expect(refreshed).toMatchObject({ status: 'ready', stale: false })
  expect(refreshed.guidelines).toContainEqual(expect.objectContaining({ version: 'synthetic-2', text: updated }))
})

it.each(['withdrawn', 'unverified'] as const)('stops using imported passages after their %s metadata is published without new source bytes', async reason => {
  const fixture = await setup()
  expect(await fixture.generate()).toMatchObject({ status: 'ready', stale: false })
  const source: GuidelineDocument['source'] = reason === 'withdrawn'
    ? { ...document.source, status: 'withdrawn' }
    : { ...document.source, license: { ...document.source.license, usage: 'unverified' } }
  fixture.writer.importDocument({ source, passages: [] })
  expect(await fixture.read()).toMatchObject({ stale: true, hidePreviousResults: true, items: [], guidelines: [] })
  const refreshed = await fixture.generate()
  expect(refreshed).toMatchObject({ status: 'missing-evidence', stale: false, items: [] })
  expect(refreshed.guidelines.some(item => item.title === document.source.title)).toBe(false)
  expect(refreshed.notices).toContainEqual(expect.objectContaining({ category: 'processing', message: expect.stringContaining('本轮未形成') }))
  expect(refreshed.missingInformation).not.toContain('未收到已导入的糖尿病指南或病例资料。')
})

it.each([
  { status: 'withdrawn', identity: 'hash' }, { status: 'superseded', identity: 'url' },
  { status: 'withdrawn', identity: 'id' },
] as const)('excludes fixed quotations for a $status source matched by $identity', async ({ status, identity }) => {
  const fixture = await setup('糖尿病复查，咳嗽。')
  const quotation = doctorGuidelineGroups[0]!.evidence[0]!
  const source: GuidelineDocument['source'] = { ...document.source,
    id: identity === 'id' ? 'nhc-influenza-2025' : 'synthetic-influenza-status',
    title: quotation.title, url: quotation.url, sha256: quotation.sourceHash,
    license: { ...document.source.license, usage: 'unverified' } }
  fixture.writer.importDocument({ source, passages: [] })
  const original = await fixture.generate()
  expect(original.guidelines.some(item => item.id === 'nhc-influenza-2025-diagnosis')).toBe(true)
  fixture.writer.importDocument({ source: { ...source, status,
    ...(identity === 'hash' ? {} : { sha256: 'a'.repeat(64) }),
    ...(identity === 'url' ? {} : { url: 'https://www.who.int/synthetic-influenza-alias' }) }, passages: [] })
  expect(await fixture.read()).toMatchObject({ stale: true, hidePreviousResults: true, items: [], guidelines: [] })
  const refreshed = await fixture.generate()
  expect(refreshed.guidelines.some(item => item.sourceHash === quotation.sourceHash)).toBe(false)
  expect(fixture.seen.verification).toEqual(fixture.seen.generation)
  expect(fixture.seen.generation).not.toContainEqual(expect.objectContaining({ sourceHash: quotation.sourceHash }))
})
