import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { doctorRecommendationStateSchema, generateDoctorRecommendationsResponseSchema } from '@clinmesh/contracts/doctor-recommendations'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'
import type { JsonChatCompletionsProvider } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { z } from 'zod'
import { DshModelProvider } from '../src/infrastructure/ai/dsh-model-provider.ts'
import { encodeModelRoute, modelBridgeRequestSchema } from '@clinmesh/contracts/model-bridge'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import type { JsonChatCompletionResult } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { sourceArtifactHash } from '../src/application/scenario-data/provider.ts'
import { installSyntheticImagingAssets } from './fixtures/imaging-catalog.ts'
import { installSyntheticPathologySlides } from './fixtures/pathology-catalog.ts'
import { breastCaseBundle } from './fixtures/pathology-scenario.ts'
import { laboratoryServiceSnapshotSchema } from '@clinmesh/contracts/his'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })

type Complete = (input: Parameters<JsonChatCompletionsProvider['completeJson']>[0]) => Promise<JsonChatCompletionResult | Response>
async function setup(complete?: Complete, options: { syntheaProvider?: StubSyntheaProvider; route?: () => string; timeoutMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-recommendations-'))
  disposals.push(() => rm(directory, { recursive: true, force: true }))
  const bridge = { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: options.timeoutMs ?? 1000, maxResponseBytes: 256 * 1024 }
  const route = encodeModelRoute({ provider: 'synthetic', model: 'synthetic' })
  const runtimeOptions: Parameters<typeof createClinMeshRuntime>[0] = {
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters',
    databasePath: join(directory, 'clinmesh.sqlite'), demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply', outboxRetryDelayMs: 0,
    imagingAssetDirectory: join(directory, 'imaging-assets'), imagingCatalogDirectory: join(directory, 'imaging-catalog'),
    pathologyAssetDirectory: join(directory, 'pathology-assets'), pathologyCatalogDirectory: join(directory, 'pathology-catalog'),
    dshModelBridge: bridge,
    chatCompletionsProvider: new DshModelProvider({ ...bridge, fetch: async (_url, init) => {
        const input = modelBridgeRequestSchema.parse(JSON.parse(String(init?.body)))
        if (input.operation === 'resolve') return Response.json({ model: options.route?.() ?? route })
        if (input.schemaName === 'patient_persona') return Response.json({ content: JSON.stringify(persona), model: input.model })
        if (complete !== undefined) {
          const result = await complete({ ...input, ...(init?.signal == null ? {} : { signal: init.signal }) })
          return result instanceof Response ? result : Response.json({ ...result, model: input.model })
        }
        throw new Error('This read must not generate suggestions')
      } }),
    syntheaProvider: options.syntheaProvider ?? new StubSyntheaProvider(), trustedOrigins: ['http://localhost'],
  }
  let runtime = await createClinMeshRuntime(runtimeOptions)
  disposals.push(() => runtime.close())
  const started = await startConsultationCase(runtime)
  const cookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const claimed = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, {
    method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: {
      [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1',
    }, input: {} }),
  })
  expect(claimed.status).toBe(200)
  const path = (kind = 'diagnosis') => `/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/${kind}`
  const read = async (kind = 'diagnosis') => {
    const response = await runtime.app.request(path(kind), { headers: { cookie } })
    const body: unknown = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    return doctorRecommendationStateSchema.parse(body)
  }
  const generate = async (kind = 'diagnosis', refresh = false) => {
    const state = await read(kind)
    return runtime.app.request(`${path(kind)}/actions/generate`, {
      method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${state.encounterId}`]: state.encounterVersion },
        input: { expectedInputFingerprint: state.inputFingerprint, refresh } }),
    })
  }
  const readCase = async () => doctorCaseDetailSchema.parse(await (await runtime.app.request(
    `/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } },
  )).json())
  const saveDocument = async (document: Record<string, string>) => runtime.app.request(
    `/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`, {
      method: 'PUT', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${started.encounterId}`]: (await readCase()).encounter.versionId }, input: { expectedDraftVersion: (await readCase()).clinicalDocument?.draft?.version ?? 0,
        document: { assessment: '', chiefComplaint: '', disposition: '', followUp: '', historyOfPresentIllness: '', physicalExamination: '', ...document } } }),
    },
  )
  return { get runtime() { return runtime }, started, cookie, directory, path, read, generate, readCase, saveDocument,
    restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(runtimeOptions) },
  }
}

it('reads a responsible doctor’s recommendation state without generating or changing clinical drafts', async () => {
  const { runtime, started, cookie } = await setup()
  const readCase = async () => (await runtime.app.request(
    `/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } },
  )).json()
  const before = await readCase()
  const response = await runtime.app.request(
    `/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/laboratory`, { headers: { cookie } },
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    caseId: started.outpatientCaseId, kind: 'laboratory', status: 'idle', generation: 0, items: [], stale: false,
  })
  expect(await readCase()).toEqual(before)
})

it('reads prescription state from the installed medication config without treating execution rules as product fields', async () => {
  const fixture = await setup()
  expect(await fixture.read('prescription')).toMatchObject({ status: 'idle', items: [] })
})

it('explains an unavailable hospital laboratory catalog without making an unsupported model request', async () => {
  const fixture = await setup()
  expect((await fixture.generate('laboratory')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read('laboratory')).toMatchObject({ status: 'missing-evidence', items: [],
    missingInformation: [expect.stringContaining('检验目录')] })
})

function diagnosisOutput(input: Parameters<JsonChatCompletionsProvider['completeJson']>[0]) {
  const payload = z.object({ guidelines: z.array(z.object({ id: z.string() })),
    caseEvidence: z.array(z.object({ id: z.string(), text: z.string() })) }).parse(input.userPayload)
  return { items: [{ id: 'hypertension-candidate', kind: 'diagnosis', catalogItemId: 'diagnosis-hypertension',
    label: '候选名称', rationale: '结合已公开高血压病史核对当前血压与症状。',
    supportingInformation: ['既往高血压病史'], opposingInformation: [], missingInformation: ['当前症状病因尚待核实'],
    guidelineEvidenceIds: [payload.guidelines[0]!.id],
    caseEvidenceIds: [payload.caseEvidence.find(item => item.text.includes('高血压'))!.id],
  }], missingInformation: [] }
}

function verificationOutput(input: Parameters<JsonChatCompletionsProvider['completeJson']>[0]) {
  const payload = z.object({ items: z.array(z.object({ id: z.string() })) }).parse(input.userPayload)
  return { items: payload.items.map(item => ({ id: item.id,
    guidelineSupported: true, caseSupported: true, applicable: true, qualifiersPreserved: true,
  })) }
}

function prescriptionOutput(input: Parameters<JsonChatCompletionsProvider['completeJson']>[0]) {
  const base = diagnosisOutput(input)
  const payload = z.object({ guidelines: z.array(z.object({ id: z.string() })) }).parse(input.userPayload)
  return { ...base, items: [{ ...base.items[0]!, kind: 'prescription', catalogItemId: 'medication-amlodipine',
    guidelineEvidenceIds: [payload.guidelines.find(item => item.id === 'viatris-norvasc-adult-hypertension-dose')!.id],
    doseText: '5 mg', frequencyCode: 'QD', courseDays: 30, quantity: 30,
  }] }
}

function syntheticLaboratory(id: string) {
  const referenceConcept = { id: `reference:${id}`, code: 'SYN-LAB', display: '合成生化指标',
    system: 'urn:synthetic:laboratory', version: '1', sourceLocator: 'synthetic:test:recommendations' }
  return laboratoryServiceSnapshotSchema.parse({
    id, localCode: id, nameZh: `合成检验 ${id}`, allowedIndicationCodes: ['clinical-evaluation'],
    componentServiceIds: [], doctorOrderable: true, executingDepartmentId: 'laboratory', priceFen: 1000,
    referenceConcept, referenceReleaseId: 'synthetic-laboratory-release', serviceKind: 'laboratory',
    specimen: { code: 'blood', display: '静脉血' }, tatMinutes: 180, version: 1,
    reportDefinition: { conclusionTemplate: '合成检验结果。', results: [{ referenceConcept,
      alternateCodings: [], referenceRange: { low: 0, high: 10, text: '0–10' },
      unit: { code: 'mg/L', display: 'mg/L', system: 'http://unitsofmeasure.org' }, valueType: 'quantity' }] },
  })
}

it('maps a laboratory suggestion to the full current hospital catalog beyond its first public page', async () => {
  const fixture = await setup(async input => {
    if (input.schemaName === 'doctor_recommendation_verification') return { content: JSON.stringify(verificationOutput(input)), model: input.model }
    const payload = z.object({ catalogs: z.object({ laboratory: z.object({ items: z.array(z.object({ id: z.string() })) }) }).strict() }).parse(input.userPayload)
    expect(payload.catalogs.laboratory.items).toHaveLength(60)
    const output = diagnosisOutput(input)
    return { content: JSON.stringify({ ...output, items: [{ ...output.items[0], kind: 'laboratory',
      catalogItemId: 'lab-59', indicationCode: 'clinical-evaluation' }] }), model: input.model }
  })
  for (let index = 0; index < 60; index += 1) {
    const service = syntheticLaboratory(`lab-${String(index).padStart(2, '0')}`)
    fixture.runtime.database.driver.prepare(`INSERT INTO hospital_service_catalog
      (workspace_id, epoch, service_id, code, name_zh, name_en, version, active, config_json)
      VALUES ('workspace-demo', 'epoch-1', ?, ?, ?, ?, 1, 1, ?)
    `).run(service.id, service.localCode, service.nameZh, service.nameZh, JSON.stringify({ laboratoryService: service }))
  }
  const before = await fixture.readCase()
  expect((await fixture.generate('laboratory')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read('laboratory')).toMatchObject({ status: 'ready', items: [{
    kind: 'laboratory', catalogItemId: 'lab-59', label: '合成检验 lab-59', indicationCode: 'clinical-evaluation',
  }] })
  expect(await fixture.readCase()).toEqual(before)
})

it('uses installed imaging metadata and invalidates a suggestion when its actual offering disappears', async () => {
  let requests = 0
  const fixture = await setup(async input => {
    requests += 1
    if (input.schemaName === 'doctor_recommendation_verification') return { content: JSON.stringify(verificationOutput(input)), model: input.model }
    const payload = z.object({ catalogs: z.object({ imaging: z.object({ items: z.array(z.object({ available: z.boolean(),
      service: z.object({ id: z.string() }) })) }) }).strict() }).parse(input.userPayload)
    expect(payload.catalogs.imaging.items.find(item => item.service.id === 'imaging-chest-ct-plain')?.available).toBe(true)
    const { catalogItemId: _id, ...common } = diagnosisOutput(input).items[0]!
    return { content: JSON.stringify({ items: [{ ...common, kind: 'imaging', serviceId: 'imaging-chest-ct-plain',
      indication: '核对当前病例的适用检查范围。' }], missingInformation: [] }), model: input.model }
  })
  await installSyntheticImagingAssets({ assetDirectory: join(fixture.directory, 'imaging-assets'),
    catalogDirectory: join(fixture.directory, 'imaging-catalog'), assets: [{ assetId: 'synthetic-ct', examCode: 'chest-ct-plain' }] })
  const before = await fixture.readCase()
  expect((await fixture.generate('imaging')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read('imaging')).toMatchObject({ status: 'ready', items: [{ kind: 'imaging', serviceId: 'imaging-chest-ct-plain' }] })
  await rm(join(fixture.directory, 'imaging-assets', 'installed', 'synthetic-ct'), { force: true, recursive: true })
  expect((await fixture.read('imaging')).stale).toBe(true)
  expect((await fixture.generate('imaging')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read('imaging')).toMatchObject({ generation: 2, status: 'missing-evidence', items: [] })
  expect(requests).toBe(2)
  expect(await fixture.readCase()).toEqual(before)
})

it.each([false, true])('maps pathology only to an offered service and its authorized visible source procedure (fabricated: %s)', async fabricated => {
  const syntheaProvider = new class extends StubSyntheaProvider {
    override async generate() {
      const corpus = await super.generate()
      const raw = breastCaseBundle({ name: '合成乳腺复诊患者' })
      return { ...corpus, sources: [{ ...corpus.sources[0]!, raw, hash: sourceArtifactHash(raw) }] }
    }
  }()
  const fixture = await setup(async input => {
    if (input.schemaName === 'doctor_recommendation_verification') return { content: JSON.stringify(verificationOutput(input)), model: input.model }
    const payload = z.object({ guidelines: z.array(z.object({ id: z.string() })),
      caseEvidence: z.array(z.object({ id: z.string(), text: z.string() })),
      catalogs: z.object({ pathology: z.object({ items: z.array(z.object({ available: z.boolean(), service: z.object({ id: z.string() }),
        sourceProcedures: z.array(z.object({ sourceReference: z.string() })) })) }) }).strict(),
    }).parse(input.userPayload)
    const offered = payload.catalogs.pathology.items.find(item => item.available)!
    expect(offered.sourceProcedures).toMatchObject([{ sourceReference: 'urn:uuid:procedure-0' }])
    return { content: JSON.stringify({ items: [{ id: 'breast-pathology-candidate', kind: 'pathology',
      serviceId: offered.service.id, sourceProcedureReference: fabricated ? 'urn:uuid:other-patient-procedure' : offered.sourceProcedures[0]!.sourceReference,
      label: '模型名称', purpose: '复核既往手术切片。', rationale: '结合可见既往手术资料核对病理诊断依据。',
      supportingInformation: ['可见既往乳腺手术记录'], opposingInformation: [], missingInformation: ['需核对会诊是否适用'],
      guidelineEvidenceIds: [payload.guidelines.find(item => item.id === 'nhc-breast-2022-pathology')!.id],
      caseEvidenceIds: [payload.caseEvidence.find(item => item.text.includes('乳房肿块切除术'))!.id],
    }], missingInformation: [] }), model: input.model }
  }, { syntheaProvider })
  await installSyntheticPathologySlides({ assetDirectory: join(fixture.directory, 'pathology-assets'),
    catalogDirectory: join(fixture.directory, 'pathology-catalog'), slides: [{ assetId: 'synthetic-breast-slide' }] })
  const before = await fixture.readCase()
  expect((await fixture.generate('pathology')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read('pathology')).toMatchObject(fabricated ? { status: 'missing-evidence', items: [] }
    : { status: 'ready', items: [{ kind: 'pathology', serviceId: 'pathology-breast-slide-consultation', sourceProcedureReference: 'urn:uuid:procedure-0' }] })
  expect(await fixture.readCase()).toEqual(before)
})

it.each(['guideline', 'case'])('rejects an unknown %s citation through the real DSH repair boundary', async source => {
  const schemas: string[] = []
  const fixture = await setup(async input => {
    schemas.push(input.schemaName)
    const output = diagnosisOutput(input)
    if (source === 'guideline') output.items[0]!.guidelineEvidenceIds = ['fabricated-guideline']
    else output.items[0]!.caseEvidenceIds = ['other-patient-evidence']
    return { content: JSON.stringify(output), model: input.model }
  })
  const before = await fixture.readCase()
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ status: 'failed', errorCode: 'AI_RESPONSE_INVALID', items: [] })
  expect(schemas).toEqual(['doctor_recommendations', 'doctor_recommendations'])
  expect(await fixture.readCase()).toEqual(before)
})

it.each(['guidelineSupported', 'caseSupported', 'applicable', 'qualifiersPreserved'])('keeps a false %s semantic conclusion final without asking the model to repair it', async field => {
  const schemas: string[] = []
  const fixture = await setup(async input => {
    schemas.push(input.schemaName)
    const output = input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input)
      : { items: verificationOutput(input).items.map(item => ({ ...item, [field]: false })) }
    return { content: JSON.stringify(output), model: input.model }
  })
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ status: 'missing-evidence', items: [], missingInformation: [expect.stringContaining('独立核验')] })
  expect(schemas).toEqual(['doctor_recommendations', 'doctor_recommendation_verification'])
})

it('uses actual installed product specifications and leaves unsupported prescription course and quantity null', async () => {
  const inputs: Parameters<JsonChatCompletionsProvider['completeJson']>[0][] = []
  const fixture = await setup(async input => {
    inputs.push(input)
    const output = input.schemaName === 'doctor_recommendations' ? prescriptionOutput(input)
      : { items: verificationOutput(input).items.map(item => ({ ...item, prescriptionFields: {
        doseText: true, frequencyCode: true, courseDays: false, quantity: false,
      } })) }
    return { content: JSON.stringify(output), model: input.model }
  })
  const before = await fixture.readCase()
  expect((await fixture.generate('prescription')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read('prescription')).toMatchObject({ status: 'ready', items: [{
    catalogItemId: 'medication-amlodipine', label: '苯磺酸氨氯地平片', doseText: '5 mg', frequencyCode: 'QD', courseDays: null, quantity: null,
    missingInformation: expect.arrayContaining([expect.stringContaining('疗程缺少'), expect.stringContaining('数量缺少')]),
  }] })
  const payload = z.object({ medicationPresentations: z.array(z.object({ id: z.string(),
    product: z.object({ strength: z.string(), dosageForm: z.string(), packageDescription: z.string() }).optional() })) }).parse(inputs[1]!.userPayload)
  expect(payload.medicationPresentations.find(item => item.id === 'medication-amlodipine')?.product)
    .toMatchObject({ strength: '5 mg', dosageForm: '片剂', packageDescription: '30片/盒' })
  expect(JSON.stringify(inputs[1]!.userPayload)).not.toMatch(/allowedDoseTexts|allowedCourseDays|defaultQuantity|defaultDoseText/)
  expect(inputs.map(input => input.schemaName)).toEqual(['doctor_recommendations', 'doctor_recommendation_verification'])
  expect(await fixture.readCase()).toEqual(before)
})

it('preserves missing dose and packaging evidence even when a verifier incorrectly approves a legacy medication', async () => {
  const fixture = await setup(async input => ({ content: JSON.stringify(input.schemaName === 'doctor_recommendations' ? prescriptionOutput(input)
    : { items: verificationOutput(input).items.map(item => ({ ...item, prescriptionFields: {
      doseText: true, frequencyCode: true, courseDays: true, quantity: true,
    } })) }), model: input.model }))
  fixture.runtime.database.driver.prepare(`UPDATE outpatient_catalog SET config_json = json_remove(config_json,
    '$.product', '$.drugConcept', '$.regulatoryVerification', '$.availableScopes')
    WHERE item_id = 'medication-amlodipine' AND workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
  `).run()
  expect((await fixture.generate('prescription')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read('prescription')).toMatchObject({ status: 'ready', items: [{
    doseText: null, quantity: null, missingInformation: expect.arrayContaining([expect.stringContaining('规格')]),
  }] })
})

it.each(['missing', 'duplicate', 'wrong-id', 'missing-prescription-fields'])('requires complete independent verification for every candidate (%s)', async failure => {
  const fixture = await setup(async input => {
    let output: unknown
    if (input.schemaName === 'doctor_recommendations') output = failure === 'missing-prescription-fields' ? prescriptionOutput(input) : diagnosisOutput(input)
    else {
      const valid = verificationOutput(input)
      output = failure === 'missing' ? { items: [] } : failure === 'duplicate' ? { items: [valid.items[0], valid.items[0]] }
        : failure === 'wrong-id' ? { items: [{ ...valid.items[0], id: 'other-candidate' }] } : valid
    }
    return { content: JSON.stringify(output), model: input.model }
  })
  const kind = failure === 'missing-prescription-fields' ? 'prescription' : 'diagnosis'
  expect((await fixture.generate(kind)).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read(kind)).toMatchObject({ status: 'failed', errorCode: 'AI_RESPONSE_INVALID', items: [] })
})

it.each([
  ['MODEL_AUTH_FAILED', 401, 'MODEL_AUTH_FAILED', 1],
  ['MODEL_TIMEOUT', 504, 'MODEL_TIMEOUT', 1],
  ['MODEL_UNAVAILABLE', 503, 'MODEL_UNAVAILABLE', 3],
] as const)('settles a host %s failure with bounded retries and supports an explicit retry', async (code, status, errorCode, attempts) => {
  let failing = true
  let generationRequests = 0
  const fixture = await setup(async input => {
    if (input.schemaName === 'doctor_recommendations') generationRequests += 1
    if (failing) return Response.json({ error: code }, { status })
    return { content: JSON.stringify(input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input)), model: input.model }
  })
  const before = await fixture.readCase()
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ generation: 1, status: 'failed', errorCode, items: [] })
  expect(generationRequests).toBe(attempts)
  failing = false
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ generation: 2, status: 'ready', items: [{ kind: 'diagnosis' }] })
  expect(await fixture.readCase()).toEqual(before)
})

it('keeps one pinned model during automatic retries and binds the current model for a new manual generation', async () => {
  const first = encodeModelRoute({ provider: 'synthetic', model: 'first' })
  const second = encodeModelRoute({ provider: 'synthetic', model: 'second' })
  let selected = first
  let failing = true
  const models: string[] = []
  const fixture = await setup(async input => {
    models.push(input.model)
    if (failing) { selected = second; return Response.json({ error: 'MODEL_UNAVAILABLE' }, { status: 503 }) }
    return { content: JSON.stringify(input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input)), model: input.model }
  }, { route: () => selected })
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).status).toBe('failed')
  expect(models).toEqual([first, first, first])
  failing = false
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).status).toBe('ready')
  expect(models).toEqual([first, first, first, second, second])
})

it('restores queued recommendations from file-backed SQLite after runtime restart', async () => {
  const fixture = await setup(async input => ({
    content: JSON.stringify(input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input)), model: input.model,
  }))
  expect((await fixture.generate()).status).toBe(200)
  expect((await fixture.read()).status).toBe('pending')
  await fixture.restart()
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ status: 'ready', generation: 1, items: [{ kind: 'diagnosis' }] })
})

it('recovers a cancelled in-flight recommendation after shutdown with the original pinned model', async () => {
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let interrupted = false
  const first = encodeModelRoute({ provider: 'synthetic', model: 'before-shutdown' })
  const second = encodeModelRoute({ provider: 'synthetic', model: 'after-shutdown' })
  let selected = first
  const models: string[] = []
  const fixture = await setup(async input => {
    models.push(input.model)
    if (!interrupted) {
      interrupted = true
      entered()
      await new Promise<void>((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }))
    }
    return { content: JSON.stringify(input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input)), model: input.model }
  }, { route: () => selected })
  expect((await fixture.generate()).status).toBe(200)
  const dispatch = fixture.runtime.dispatchPending()
  await started
  selected = second
  await fixture.restart()
  await dispatch
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ status: 'ready', generation: 1 })
  expect(models).toEqual([first, first, first])
})

it('marks old suggestions stale when the actual diagnosis catalog changes and rejects the previous fingerprint', async () => {
  const fixture = await setup(async input => ({
    content: JSON.stringify(input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input)), model: input.model,
  }))
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const previous = await fixture.read()
  fixture.runtime.database.driver.prepare(`UPDATE diagnosis_catalog SET name_zh = '高血压（目录修订）', version = version + 1
    WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1' AND item_id = 'diagnosis-hypertension'
  `).run()
  expect(await fixture.read()).toMatchObject({ status: 'ready', stale: true })
  const rejected = await fixture.runtime.app.request(`${fixture.path()}/actions/generate`, {
    method: 'POST', headers: { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: { [`Encounter/${previous.encounterId}`]: previous.encounterVersion },
      input: { expectedInputFingerprint: previous.inputFingerprint, refresh: false } }),
  })
  expect(rejected.status).toBe(409)
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ generation: 2, stale: false, items: [{ label: '高血压（目录修订）' }] })
})

it('rejects generation with an old Encounter version even when the input fingerprint is current', async () => {
  const fixture = await setup()
  const state = await fixture.read()
  const response = await fixture.runtime.app.request(`${fixture.path()}/actions/generate`, {
    method: 'POST', headers: { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: { [`Encounter/${state.encounterId}`]: '1' },
      input: { expectedInputFingerprint: state.inputFingerprint, refresh: false } }),
  })
  expect(response.status).toBe(409)
  expect(await fixture.read()).toMatchObject({ generation: 0, status: 'idle' })
})

it('rejects recommendation read and generation from another role or without case responsibility', async () => {
  const fixture = await setup()
  const state = await fixture.read()
  const triage = await signIn(fixture.runtime, 'triage@demo.clinmesh.local')
  for (const cookie of [triage, fixture.cookie]) {
    if (cookie === fixture.cookie) fixture.runtime.database.driver.prepare(`DELETE FROM outpatient_case_responsibility
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1' AND case_id = ?`).run(fixture.started.outpatientCaseId)
    const response = await fixture.runtime.app.request(fixture.path(), { headers: { cookie } })
    expect(response.status).toBe(403)
    const generated = await fixture.runtime.app.request(`${fixture.path()}/actions/generate`, {
      method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${state.encounterId}`]: state.encounterVersion },
        input: { expectedInputFingerprint: state.inputFingerprint, refresh: false } }),
    })
    expect(generated.status).toBe(403)
  }
})

it('drops a late generation after a clinical draft changes and accepts a new generation from current evidence', async () => {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let first = true
  const fixture = await setup(async input => {
    if (first) { first = false; entered(); await held }
    return { content: JSON.stringify(input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input)), model: input.model }
  })
  expect((await fixture.generate()).status).toBe(200)
  const dispatch = fixture.runtime.dispatchPending()
  await started
  try {
    expect((await fixture.saveDocument({ assessment: '不能把既往高血压直接当成本次头晕的病因。' })).status).toBe(200)
    expect((await fixture.read()).stale).toBe(true)
  } finally { release() }
  await dispatch
  expect(await fixture.read()).toMatchObject({ status: 'failed', errorCode: 'WORKFLOW_CONFLICT', stale: true, items: [] })
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ status: 'ready', generation: 2, stale: false })
  expect((await fixture.readCase()).clinicalDocument?.draft?.assessment).toBe('不能把既往高血压直接当成本次头晕的病因。')
})

it('keeps a refreshed generation authoritative when the preceding model result arrives late', async () => {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let generation = 0
  const fixture = await setup(async input => {
    if (input.schemaName === 'doctor_recommendations') {
      generation += 1
      const output = diagnosisOutput(input)
      output.items[0]!.id = `candidate-generation-${generation}`
      if (generation === 1) { entered(); await held }
      return { content: JSON.stringify(output), model: input.model }
    }
    return { content: JSON.stringify(verificationOutput(input)), model: input.model }
  })
  expect((await fixture.generate()).status).toBe(200)
  const dispatch = fixture.runtime.dispatchPending()
  await started
  try { expect((await fixture.generate('diagnosis', true)).status).toBe(200) } finally { release() }
  await dispatch
  expect(await fixture.read()).toMatchObject({ status: 'ready', generation: 2, items: [{ id: 'candidate-generation-2' }] })
})

it('invalidates a pending result when the original doctor membership is revoked', async () => {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const fixture = await setup(async input => {
    if (input.schemaName === 'doctor_recommendations') { entered(); await held }
    return { content: JSON.stringify(input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input)), model: input.model }
  })
  expect((await fixture.generate()).status).toBe(200)
  const dispatch = fixture.runtime.dispatchPending()
  await started
  try {
    fixture.runtime.database.driver.prepare("UPDATE workspace_membership SET status = 'suspended' WHERE actor_id = 'actor-outpatient-doctor'").run()
  } finally { release() }
  await dispatch
  fixture.runtime.database.driver.prepare("UPDATE workspace_membership SET status = 'active' WHERE actor_id = 'actor-outpatient-doctor'").run()
  expect(await fixture.read()).toMatchObject({ status: 'failed', errorCode: 'WORKFLOW_CONFLICT', items: [] })
})

it('keeps an old Epoch model result out of the current Workspace after reset', async () => {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const fixture = await setup(async input => {
    if (input.schemaName === 'doctor_recommendations') { entered(); await held }
    return { content: JSON.stringify(input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input)), model: input.model }
  })
  expect((await fixture.generate()).status).toBe(200)
  const dispatch = fixture.runtime.dispatchPending()
  await started
  try {
    const response = await fixture.runtime.app.request('/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', {
      method: 'POST', headers: { cookie: fixture.started.adminCookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: '{}',
    })
    expect(response.status).toBe(200)
  } finally { release() }
  await dispatch
  expect((await fixture.runtime.app.request(fixture.path(), { headers: { cookie: fixture.cookie } })).status).not.toBe(200)
})

it('reads and generates from complete long clinical fields without losing their negative qualifiers', async () => {
  const inputs: Parameters<JsonChatCompletionsProvider['completeJson']>[0][] = []
  const fixture = await setup(async input => {
    inputs.push(input)
    return { content: JSON.stringify(input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input)), model: input.model }
  })
  const history = `${'既往病史仍需核对。'.repeat(440)}目前不能排除体位性头晕，是否与降压药有关？`
  const examination = `${'体格检查仍需复核。'.repeat(380)}无已确认神经系统阳性体征。`
  const assessment = `${'病因需要进一步评估。'.repeat(360)}尚未确诊其他疾病。`
  expect((await fixture.saveDocument({ historyOfPresentIllness: history, physicalExamination: examination, assessment,
    followUp: '复诊时必须重新评估。'.repeat(390) })).status).toBe(200)
  expect((await fixture.read()).status).toBe('idle')
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ status: 'ready', items: [{ kind: 'diagnosis' }] })
  const evidence = z.object({ caseEvidence: z.array(z.object({ text: z.string() })) }).parse(inputs[0]!.userPayload).caseEvidence
  expect(evidence.map(item => item.text)).toContain(history)
  expect(evidence.map(item => item.text)).toContain(examination)
  expect(evidence.map(item => item.text)).toContain(assessment)
  expect((await fixture.readCase()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(history)
})

it('uses authorized visible history beyond the first public page while keeping index-case answers private', async () => {
  const syntheaProvider = new class extends StubSyntheaProvider {
    override async generate() {
      const corpus = await super.generate()
      const raw = z.object({ entry: z.array(z.object({ resource: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough().parse(corpus.sources[0]!.raw)
      raw.entry.push(...Array.from({ length: 24 }, (_, index) => ({
        fullUrl: `urn:uuid:prior-visible-condition-${index}`,
        resource: { resourceType: 'Condition', id: `visible-condition-${index}`, subject: { reference: 'urn:uuid:patient' },
          encounter: { reference: 'urn:uuid:prior-encounter' }, recordedDate: '2025-01-10T09:05:00+08:00',
          code: { text: `第${index}项公开既往诊断，尚需核实。` } },
      })))
      return { ...corpus, sources: [{ ...corpus.sources[0]!, raw, hash: sourceArtifactHash(raw) }] }
    }
  }()
  const fixture = await setup(async input => {
    if (input.schemaName === 'doctor_recommendations') {
      const payload = z.object({ caseEvidence: z.array(z.object({ text: z.string() })) }).parse(input.userPayload)
      for (let index = 0; index < 24; index += 1) expect(JSON.stringify(payload.caseEvidence)).toContain(`第${index}项公开既往诊断，尚需核实。`)
      expect(JSON.stringify(payload)).not.toContain('2 型糖尿病')
    }
    return { content: JSON.stringify(input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input)), model: input.model }
  }, { syntheaProvider })
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).status).toBe('ready')
})

it('reports an explicit evidence budget limit instead of failing reads or silently truncating a large visible history', async () => {
  const syntheaProvider = new class extends StubSyntheaProvider {
    override async generate() {
      const corpus = await super.generate()
      const raw = z.object({ entry: z.array(z.object({ resource: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough().parse(corpus.sources[0]!.raw)
      raw.entry.push(...Array.from({ length: 110 }, (_, index) => ({ fullUrl: `urn:uuid:large-visible-condition-${index}`,
        resource: { resourceType: 'Condition', id: `large-visible-condition-${index}`, subject: { reference: 'urn:uuid:patient' },
          encounter: { reference: 'urn:uuid:prior-encounter' }, recordedDate: '2025-01-10T09:05:00+08:00',
          code: { text: `第${index}项可见病史，不能删除“尚未明确”的限定。` } },
      })))
      return { ...corpus, sources: [{ ...corpus.sources[0]!, raw, hash: sourceArtifactHash(raw) }] }
    }
  }()
  const fixture = await setup(undefined, { syntheaProvider })
  expect((await fixture.read()).status).toBe('idle')
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ status: 'missing-evidence', items: [],
    missingInformation: [expect.stringContaining('完整可见资料超过')] })
})

it('declines to invent a guideline when the public case contains none of the acquired guideline scopes', async () => {
  const syntheaProvider = new class extends StubSyntheaProvider {
    override async generate() {
      const corpus = await super.generate()
      const raw = z.object({ entry: z.array(z.object({ resource: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough().parse(corpus.sources[0]!.raw)
      raw.entry = raw.entry.filter(item => item.resource.id !== 'pc')
      return { ...corpus, sources: [{ ...corpus.sources[0]!, raw, hash: sourceArtifactHash(raw) }] }
    }
  }()
  const fixture = await setup(undefined, { syntheaProvider })
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ status: 'missing-evidence', guidelines: [], items: [],
    missingInformation: [expect.stringContaining('没有已取得的适用指南')] })
})

it('preserves a formal no-medication conclusion and explains why a new prescription recommendation is unnecessary', async () => {
  const fixture = await setup()
  const post = async (action: string, input: unknown, method = 'POST') => fixture.runtime.app.request(
    `/api/his/v1/encounters/${fixture.started.encounterId}/${action}`, {
      method, headers: { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${fixture.started.encounterId}`]: (await fixture.readCase()).encounter.versionId }, input }),
    },
  )
  expect((await post('diagnosis/draft', { expectedDraftVersion: 0, entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary' }] }, 'PUT')).status).toBe(200)
  expect((await post('diagnosis/actions/confirm', { expectedDraftVersion: 1 })).status).toBe(200)
  expect((await post('medication-conclusion/actions/confirm-no-medication', { expectedDraftVersion: 0 })).status).toBe(200)
  const before = await fixture.readCase()
  expect((await fixture.generate('prescription')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read('prescription')).toMatchObject({ status: 'missing-evidence', items: [],
    missingInformation: [expect.stringContaining('已有正式用药结论')] })
  expect(await fixture.readCase()).toEqual(before)
})

it('generates independently verified suggestions from actual visible evidence without writing diagnoses or drafts', async () => {
  const inputs: Parameters<JsonChatCompletionsProvider['completeJson']>[0][] = []
  const { runtime, started, cookie } = await setup(async input => {
    inputs.push(input)
    if (input.schemaName === 'doctor_recommendation_verification') {
      const payload = z.object({ items: z.array(z.object({ id: z.string() })) }).parse(input.userPayload)
      return { content: JSON.stringify({ items: payload.items.map(item => ({ id: item.id,
        guidelineSupported: true, caseSupported: true, applicable: true, qualifiersPreserved: true,
      })) }), model: 'synthetic' }
    }
    expect(input.schemaName).toBe('doctor_recommendations')
    const payload = z.object({
      guidelines: z.array(z.object({ id: z.string() })), caseEvidence: z.array(z.object({ id: z.string() })),
    }).parse(input.userPayload)
    return { content: JSON.stringify({ items: [{
      id: 'synthetic-hypertension-candidate', kind: 'diagnosis', catalogItemId: 'diagnosis-hypertension',
      label: '模型给出的名称', rationale: '依据可见既往病史进一步核对当前血压。',
      supportingInformation: ['可见高血压病史'], opposingInformation: [], missingInformation: ['当前血压仍需核对'],
      guidelineEvidenceIds: [payload.guidelines[0]!.id], caseEvidenceIds: [payload.caseEvidence[0]!.id],
    }], missingInformation: [] }), model: 'synthetic' }
  })
  const path = `/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/diagnosis`
  const state = doctorRecommendationStateSchema.parse(await (await runtime.app.request(path, { headers: { cookie } })).json())
  const before = await (await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } })).json()
  const response = await runtime.app.request(`${path}/actions/generate`, {
    method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: { [`Encounter/${state.encounterId}`]: state.encounterVersion },
      input: { expectedInputFingerprint: state.inputFingerprint, refresh: false } }),
  })
  expect(response.status).toBe(200)
  await runtime.dispatchPending()
  const result = doctorRecommendationStateSchema.parse(await (await runtime.app.request(path, { headers: { cookie } })).json())
  expect(result).toMatchObject({ status: 'ready', generation: 1, stale: false,
    items: [{ kind: 'diagnosis', catalogItemId: 'diagnosis-hypertension', label: '高血压' }],
  })
  expect(inputs.map(input => input.schemaName)).toEqual(['doctor_recommendations', 'doctor_recommendation_verification'])
  expect(JSON.stringify(inputs.map(input => input.userPayload))).not.toMatch(/2 型糖尿病|11\.2|hiddenResources|reasoning/)
  expect(await (await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } })).json()).toEqual(before)
})

it('queues generation through an idempotent command while preserving every clinical draft', async () => {
  const { runtime, started, cookie } = await setup()
  const path = `/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/laboratory`
  const read = async () => doctorRecommendationStateSchema.parse(await (await runtime.app.request(path, { headers: { cookie } })).json())
  const state = await read()
  const key = randomUUID()
  const request = () => runtime.app.request(`${path}/actions/generate`, {
    method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ expectedVersions: { [`Encounter/${state.encounterId}`]: state.encounterVersion },
      input: { expectedInputFingerprint: state.inputFingerprint, refresh: false } }),
  })
  const before = await (await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } })).json()
  const response = await request()
  expect(response.status).toBe(200)
  const queued = generateDoctorRecommendationsResponseSchema.parse(await response.json())
  expect(queued.data).toMatchObject({ status: 'pending', generation: 1, items: [] })
  const replay = generateDoctorRecommendationsResponseSchema.parse(await (await request()).json())
  expect(replay.auditId).toBe(queued.auditId)
  expect(await read()).toMatchObject({ status: 'pending', generation: 1 })
  expect(await (await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } })).json()).toEqual(before)
})
