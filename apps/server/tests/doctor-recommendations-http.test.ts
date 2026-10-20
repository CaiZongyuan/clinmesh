import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { doctorRecommendationStateSchema, generateDoctorRecommendationsResponseSchema, confirmDoctorPreparationResponseSchema } from '@clinmesh/contracts/doctor-recommendations'
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
async function setup(complete?: Complete, options: { syntheaProvider?: StubSyntheaProvider; route?: () => string; timeoutMs?: number; referenceDiagnoses?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-recommendations-'))
  disposals.push(() => rm(directory, { recursive: true, force: true }))
  const bridge = { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: options.timeoutMs ?? 1000, maxResponseBytes: 256 * 1024 }
  const route = encodeModelRoute({ provider: 'synthetic', model: 'synthetic' })
  const referenceDatabasePath = options.referenceDiagnoses ? await installPreparationReferenceDiagnoses(directory) : undefined
  const runtimeOptions: Parameters<typeof createClinMeshRuntime>[0] = {
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters',
    ...(referenceDatabasePath === undefined ? {} : { referenceDatabasePath }),
    databasePath: join(directory, 'clinmesh.sqlite'), demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply', outboxRetryDelayMs: 0,
    imagingAssetDirectory: join(directory, 'imaging-assets'), imagingCatalogDirectory: join(directory, 'imaging-catalog'),
    pathologyAssetDirectory: join(directory, 'pathology-assets'), pathologyCatalogDirectory: join(directory, 'pathology-catalog'),
    dshModelBridge: bridge,
    chatCompletionsProvider: new DshModelProvider({ ...bridge, fetch: async (_url, init) => {
        const input = modelBridgeRequestSchema.parse(JSON.parse(String(init?.body)))
        if (input.operation === 'resolve') return Response.json({ model: options.route?.() ?? route })
        if (input.schemaName === 'patient_persona') return Response.json({ content: JSON.stringify(persona), model: input.model })
        if (input.schemaName === 'clinical_document_quality' || input.schemaName === 'clinical_document_quality_verification') {
          const payload = z.object({ agentFacts: z.array(z.object({ id: z.string() })) }).parse(input.userPayload)
          return Response.json({ content: JSON.stringify({ issues: [], agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })) }), model: input.model })
        }
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
  const readCase = async () => {
    const { qualityControl: _qualityControl, ...clinical } = doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } },
    )).json())
    // 质控拥有独立后台进度，本套回归比较完整诊疗事实与草稿。
    return clinical
  }
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

it('explains an unavailable hospital laboratory catalog while allowing only read-only reasoning', async () => {
  const fixture = await setup(async input => {
    expect(input.schemaName).toBe('doctor_recommendations')
    expect(input.userPayload).toMatchObject({ kind: 'laboratory', mode: 'considerations-only' })
    return { model: input.model, content: JSON.stringify({ items: [], considerations: [], missingInformation: [] }) }
  })
  expect((await fixture.generate('laboratory')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read('laboratory')).toMatchObject({ status: 'missing-evidence', items: [],
    missingInformation: [expect.stringContaining('检验目录')] })
})

it.each(['caseSupported', 'applicable', 'qualifiersPreserved'] as const)('does not publish or downgrade a candidate rejected for %s, and names the actual review failure', async field => {
  const fixture = await setup(async input => {
    if (input.schemaName === 'doctor_recommendations') {
      const output = diagnosisOutput(input)
      output.items[0]!.rationale = '患者说没自行量过体温，因此没有任何体温资料。'
      return { model: input.model, content: JSON.stringify({ ...output, missingInformation: ['需要先完成血常规、CRP和全套检查。'] }) }
    }
    return { model: input.model, content: JSON.stringify({ items: verificationOutput(input).items.map(item => ({ ...item,
      [field]: false, reason: '已有分诊体温记录；患者未自行测量不能概括为没有体温资料。' })) }) }
  })
  const before = await fixture.readCase()
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const state = await fixture.read()
  expect(state).toMatchObject({ status: 'missing-evidence', items: [], considerations: [],
    notices: [expect.objectContaining({ category: 'verification', message: expect.stringContaining('已有分诊体温记录') })] })
  expect(state.missingInformation.join()).not.toContain('需要先完成血常规')
  expect(await fixture.readCase()).toEqual(before)
})

function diagnosisOutput(input: Parameters<JsonChatCompletionsProvider['completeJson']>[0]) {
  const payload = z.object({ kind: z.string().optional(), guidelines: z.array(z.object({ id: z.string() })),
    caseEvidence: z.array(z.object({ id: z.string(), text: z.string() })) }).parse(input.userPayload)
  return { items: [{ id: 'hypertension-candidate', kind: 'diagnosis', catalogItemId: 'diagnosis-hypertension',
    ...(payload.kind === 'diagnosis' ? { role: 'primary' as const } : {}),
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

it('keeps a case-supported diagnostic direction read-only when only guideline support is absent', async () => {
  const fixture = await setup(async input => ({ model: input.model, content: JSON.stringify(input.schemaName === 'doctor_recommendations'
    ? diagnosisOutput(input) : { items: verificationOutput(input).items.map(item => ({ ...item, guidelineSupported: false,
      reason: '现有条款提供评估背景，尚未支持该具体诊断。' })) }) }))
  const before = await fixture.readCase()
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ status: 'ready', items: [],
    considerations: [expect.objectContaining({ id: 'hypertension-candidate', label: '高血压' })],
    notices: [expect.objectContaining({ category: 'guideline', message: expect.stringContaining('尚未支持该具体诊断') })] })
  expect(await fixture.readCase()).toEqual(before)
})

function prescriptionOutput(input: Parameters<JsonChatCompletionsProvider['completeJson']>[0]) {
  const base = diagnosisOutput(input)
  const payload = z.object({ guidelines: z.array(z.object({ id: z.string() })) }).parse(input.userPayload)
  return { ...base, items: [{ ...base.items[0]!, kind: 'prescription', catalogItemId: 'medication-amlodipine',
    guidelineEvidenceIds: [payload.guidelines.find(item => item.id === 'viatris-norvasc-adult-hypertension-dose')!.id],
    doseText: '5 mg', frequencyCode: 'QD', courseDays: 30, quantity: 30,
  }] }
}

it('verifies the actual diagnosis identity before accepting an opaque catalog ID with a fabricated label', async () => {
  const received: Array<{ label: string; code?: string }> = []
  const schemas: string[] = []
  const fixture = await setup(async input => {
    schemas.push(input.schemaName)
    if (input.schemaName === 'doctor_recommendations') {
      const output = diagnosisOutput(input)
      return { content: JSON.stringify({ ...output, items: [{ ...output.items[0],
        catalogItemId: 'opaque-diagnosis-27', label: '高血压',
      }] }), model: input.model }
    }
    const payload = z.object({ items: z.array(z.object({ id: z.string(), label: z.string(),
      referenceConcept: z.object({ code: z.string() }).optional() })) }).parse(input.userPayload)
    received.push(...payload.items.map(item => ({ label: item.label, ...(item.referenceConcept === undefined ? {} : { code: item.referenceConcept.code }) })))
    return { content: JSON.stringify({ items: payload.items.map(item => ({ id: item.id,
      guidelineSupported: item.label === '高血压', caseSupported: item.label === '高血压',
      applicable: item.referenceConcept?.code !== 'R50.9', qualifiersPreserved: true,
    })) }), model: input.model }
  })
  fixture.runtime.database.driver.prepare(`UPDATE diagnosis_catalog SET item_id = 'opaque-diagnosis-27'
    WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1' AND code = 'R50.9'
  `).run()
  const before = await fixture.readCase()
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ status: 'missing-evidence', items: [] })
  expect(received).toEqual([{ label: '发热，未特指', code: 'R50.9' }])
  expect(schemas).toEqual(['doctor_recommendations', 'doctor_recommendation_verification'])
  expect(await fixture.readCase()).toEqual(before)
})

it.each(['approve', 'oppose-final', 'omit-final', 'duplicate-final', 'wrong-final'])(
  'verifies all eight candidates in bounded requests with complete original evidence when their combined payload exceeds the budget (%s)', async outcome => {
  const calls: string[] = []
  const verifiedIds: string[] = []
  let generationEvidence: unknown[] = []
  let generationGuidelines: unknown[] = []
  let activeVerifications = 0
  let peakVerifications = 0
  let generationPayloadBytes = 0
  let outputBytes = 0
  let verificationPayloadBytes = 0
  const fixture = await setup(async input => {
    calls.push(input.schemaName)
    if (input.schemaName === 'doctor_recommendation_verification') {
      const payload = z.object({ items: z.array(z.object({ id: z.string(), caseEvidenceIds: z.array(z.string()) })),
        guidelines: z.array(z.unknown()), caseEvidence: z.array(z.object({ id: z.string() }).passthrough()) }).parse(input.userPayload)
      expect(Buffer.byteLength(JSON.stringify(input.userPayload))).toBeLessThanOrEqual(240 * 1024)
      expect(payload.caseEvidence).toEqual(generationEvidence)
      expect(payload.guidelines).toEqual(generationGuidelines)
      for (const candidate of payload.items) expect(candidate.caseEvidenceIds.every(id => payload.caseEvidence.some(evidence => evidence.id === id))).toBe(true)
      verifiedIds.push(...payload.items.map(item => item.id))
      activeVerifications += 1
      peakVerifications = Math.max(peakVerifications, activeVerifications)
      await Promise.resolve()
      activeVerifications -= 1
      expect(await fixture.read()).toMatchObject({ status: 'pending', items: [] })
      const output = verificationOutput(input)
      if (payload.items.some(item => item.id === 'candidate-7')) {
        if (outcome === 'oppose-final') output.items = output.items.map(item => ({ ...item, applicable: item.id !== 'candidate-7' }))
        else if (outcome === 'omit-final') output.items = output.items.filter(item => item.id !== 'candidate-7')
        else if (outcome === 'duplicate-final') output.items = output.items.map(item => item.id === 'candidate-7' ? output.items[0]! : item)
        else if (outcome === 'wrong-final') output.items = output.items.map(item => ({ ...item, id: item.id === 'candidate-7' ? 'candidate-0' : item.id }))
      }
      return { content: JSON.stringify(output), model: input.model }
    }
    generationPayloadBytes = Buffer.byteLength(JSON.stringify(input.userPayload))
    const candidate = diagnosisOutput(input).items[0]!
    const payload = z.object({ kind: z.string(), guidelines: z.array(z.unknown()),
      caseEvidence: z.array(z.object({ id: z.string() }).passthrough()) }).parse(input.userPayload)
    generationEvidence = payload.caseEvidence
    generationGuidelines = payload.guidelines
    const detail = '待'.repeat(2000)
    const output = { items: Array.from({ length: 8 }, (_, index) => ({ ...candidate, id: `candidate-${index}`,
      caseEvidenceIds: [payload.caseEvidence[index % payload.caseEvidence.length]!.id],
      rationale: detail, supportingInformation: [detail], opposingInformation: [detail], missingInformation: [detail] })), missingInformation: [] }
    outputBytes = Buffer.byteLength(JSON.stringify(output))
    verificationPayloadBytes = Buffer.byteLength(JSON.stringify({ ...payload, items: output.items }))
    return { content: JSON.stringify(output), model: input.model }
  })
  const field = '合'.repeat(4000)
  expect((await fixture.saveDocument({ assessment: field, auxiliaryExamination: field, chiefComplaint: '合'.repeat(1000),
    disposition: field, followUp: field, historyOfPresentIllness: '合'.repeat(5000), physicalExamination: field, priorMedicalHistory: field })).status).toBe(200)
  const before = await fixture.readCase()
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(generationPayloadBytes).toBeGreaterThan(90 * 1024)
  expect(generationPayloadBytes).toBeLessThan(240 * 1024)
  expect(outputBytes).toBeGreaterThan(190 * 1024)
  expect(outputBytes).toBeLessThan(256 * 1024)
  expect(verificationPayloadBytes).toBeGreaterThan(256 * 1024)
  const invalid = outcome === 'omit-final' || outcome === 'duplicate-final' || outcome === 'wrong-final'
  expect(await fixture.read()).toMatchObject(invalid ? { status: 'failed', errorCode: 'AI_RESPONSE_INVALID', items: [] }
    : { status: 'ready', items: Array.from({ length: outcome === 'oppose-final' ? 7 : 8 }, (_, index) => ({ id: `candidate-${index}` })) })
  if (!invalid) expect((await fixture.read()).errorCode).toBeUndefined()
  expect([...new Set(verifiedIds)].toSorted()).toEqual(Array.from({ length: 8 }, (_, index) => `candidate-${index}`))
  if (!invalid) expect(verifiedIds).toHaveLength(8)
  expect(calls.filter(schema => schema === 'doctor_recommendation_verification').length).toBeGreaterThan(1)
  expect(peakVerifications).toBe(2)
  expect(await fixture.readCase()).toEqual(before)
})

it('keeps a complete candidate unavailable when it cannot fit a verification request by itself', async () => {
  const calls: string[] = []
  const fixture = await setup(async input => {
    calls.push(input.schemaName)
    const candidate = diagnosisOutput(input).items[0]!
    const detail = '待'.repeat(2000)
    const output = { items: [{ ...candidate, rationale: detail, supportingInformation: Array(12).fill(detail),
      opposingInformation: Array(12).fill(detail), missingInformation: Array(12).fill(detail) }], missingInformation: [] }
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(256 * 1024)
    return { content: JSON.stringify(output), model: input.model }
  })
  const field = '合'.repeat(4000)
  expect((await fixture.saveDocument({ assessment: field, auxiliaryExamination: field, chiefComplaint: '合'.repeat(1000),
    disposition: field, followUp: field, historyOfPresentIllness: '合'.repeat(5000), physicalExamination: field, priorMedicalHistory: field })).status).toBe(200)
  const before = await fixture.readCase()
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ status: 'missing-evidence', items: [], missingInformation: [expect.stringContaining('核验请求预算')] })
  expect(calls).toEqual(['doctor_recommendations'])
  expect(await fixture.readCase()).toEqual(before)
})

it('reports a generation response budget when valid candidates exceed the provider response limit', async () => {
  const calls: string[] = []
  const fixture = await setup(async input => {
    calls.push(input.schemaName)
    const candidate = diagnosisOutput(input).items[0]!
    const detail = '待'.repeat(2000)
    const output = { items: Array.from({ length: 8 }, (_, index) => ({ ...candidate, id: `oversized-candidate-${index}`,
      rationale: detail, supportingInformation: [detail, detail], opposingInformation: [detail, detail], missingInformation: [detail, detail] })), missingInformation: [] }
    expect(Buffer.byteLength(JSON.stringify(output))).toBeGreaterThan(256 * 1024)
    return { content: JSON.stringify(output), model: input.model }
  })
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ status: 'missing-evidence', items: [], missingInformation: [expect.stringContaining('生成响应预算')] })
  expect((await fixture.read()).errorCode).toBeUndefined()
  expect(calls).toEqual(['doctor_recommendations'])
})

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
  let verificationPayload: unknown
  const fixture = await setup(async input => {
    if (input.schemaName === 'doctor_recommendation_verification') {
      verificationPayload = input.userPayload
      return { content: JSON.stringify(verificationOutput(input)), model: input.model }
    }
    if (input.schemaName === 'doctor_recommendation_catalog_selection') {
      const payload = z.object({ catalogs: z.object({ laboratory: z.object({ items: z.array(z.object({ id: z.string() })) }) }) }).parse(input.userPayload)
      // 筛选视图覆盖公开分页之外的全部目录项。
      expect(payload.catalogs.laboratory.items).toHaveLength(60)
      return { content: JSON.stringify({ complete: true, selectedCatalogItemIds: payload.catalogs.laboratory.items
        .filter(item => item.id === 'lab-59').map(item => item.id) }), model: input.model }
    }
    const payload = z.object({ catalogs: z.object({ laboratory: z.object({ items: z.array(z.object({ id: z.string() })) }) }).strict() }).parse(input.userPayload)
    // 生成只携带已选项目的筛选视图；完整定义由独立核验经 selectedCatalogItems 提供。
    expect(payload.catalogs.laboratory.items).toEqual([expect.objectContaining({ id: 'lab-59' })])
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
  expect(verificationPayload).toMatchObject({ items: [{ catalogItemId: 'lab-59', label: '合成检验 lab-59' }],
    selectedCatalogItems: { laboratory: [{ id: 'lab-59', localCode: 'lab-59', referenceConcept: { code: 'SYN-LAB' },
      reportDefinition: { results: [{ referenceConcept: { code: 'SYN-LAB' }, unit: { code: 'mg/L' } }] } }] } })
  expect(await fixture.readCase()).toEqual(before)
})

it('generates from a lightweight complete laboratory catalog while preserving specimen, panel and clinical applicability', async () => {
  const requests: string[] = []
  let generationBytes = 0
  let verificationPayload: unknown
  const fixture = await setup(async input => {
    requests.push(input.schemaName)
    if (input.schemaName === 'doctor_recommendation_verification') {
      verificationPayload = input.userPayload
      return { content: JSON.stringify(verificationOutput(input)), model: input.model }
    }
    if (input.schemaName === 'doctor_recommendation_catalog_selection') {
      const payload = z.object({ catalogs: z.object({ laboratory: z.object({ items: z.array(z.object({ id: z.string() }).passthrough()) }) }) }).parse(input.userPayload)
      expect(payload.catalogs.laboratory.items).toHaveLength(100)
      expect(payload.catalogs.laboratory.items.find(item => item.id === 'lab-00')).not.toHaveProperty('minimumAgeYears')
      // 筛选视图保留项目身份、标本、组合成员、允许适应证与适用条件，不含报告定义与参考范围。
      expect(payload.catalogs.laboratory.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'lab-98', nameZh: '同名合成组合', specimen: { code: 'blood', display: '静脉血' } }),
        expect.objectContaining({ id: 'lab-99', nameZh: '同名合成组合', specimen: { code: 'urine', display: '尿液' },
          referenceConcept: { id: 'reference:lab-99', code: 'SYN-LAB', display: '合成生化指标', system: 'urn:synthetic:laboratory', version: '1' },
          allowedIndicationCodes: ['clinical-evaluation'], componentServiceIds: ['leaf-quantity', 'leaf-qualitative'], minimumAgeYears: 18,
          sourceDataset: { datasetId: 'laboratory-cn' }, standardStatus: { mode: 'future-standard-preview', standard: 'WS/T 886-2026', effectiveOn: '2026-11-01' } }),
      ]))
      expect(payload.catalogs.laboratory.items.find(item => item.id === 'lab-99')).not.toHaveProperty('reportDefinition')
      expect(JSON.stringify(payload.catalogs)).not.toMatch(/conclusionTemplate|priceFen|executingDepartmentId|tatMinutes|healthyStrategy|precision|simulationLow|simulationHigh|sourceLocator|sourceLocation|sourceStandard|referenceReleaseId/)
      return { content: JSON.stringify({ complete: true, selectedCatalogItemIds: ['lab-99'] }), model: input.model }
    }
    generationBytes = Buffer.byteLength(JSON.stringify(input.userPayload))
    const payload = z.object({ catalogs: z.object({ laboratory: z.object({ items: z.array(z.object({ id: z.string() }).passthrough()) }) }) }).parse(input.userPayload)
    // 生成只携带已选项目的筛选视图；完整报告定义由独立核验经 selectedCatalogItems 提供。
    expect(payload.catalogs.laboratory.items).toEqual([expect.objectContaining({ id: 'lab-99' })])
    expect(payload.catalogs.laboratory.items[0]).not.toHaveProperty('reportDefinition')
    const output = diagnosisOutput(input)
    return { content: JSON.stringify({ ...output, items: [{ ...output.items[0], kind: 'laboratory',
      catalogItemId: 'lab-99', indicationCode: 'clinical-evaluation' }] }), model: input.model }
  })
  const services = Array.from({ length: 100 }, (_, index) => {
    const service = syntheticLaboratory(`lab-${String(index).padStart(2, '0')}`)
    service.reportDefinition.conclusionTemplate = '合'.repeat(1000)
    return service
  })
  services[98]!.nameZh = '同名合成组合'
  const selected = services[99]!
  selected.nameZh = '同名合成组合'
  selected.specimen = { code: 'urine', display: '尿液' }
  selected.sourceDataset = { datasetId: 'laboratory-cn', releaseId: 'synthetic-clinical-release' }
  selected.standardStatus = { mode: 'future-standard-preview', standard: 'WS/T 886-2026', effectiveOn: '2026-11-01' }
  selected.componentServiceIds = ['leaf-quantity', 'leaf-qualitative']
  const provenance = { sourceLocation: '合成标准条款', sourceStandard: '合成标准', sourceType: 'national-standard' as const, sourceVersion: '1' }
  selected.reportDefinition.results = [
    { ...selected.reportDefinition.results[0]!, referenceConcept: { ...selected.referenceConcept, id: 'quantity-member', code: 'SYN-PANEL-QUANTITY' },
      alternateCodings: [{ code: 'synthetic-loinc', system: 'http://loinc.org', version: 'synthetic-1' }], precision: 1, healthyStrategy: 'uniform',
      adultReferenceRules: [{ ...provenance, low: 0, high: 10, notes: '限成年男性', referenceKind: 'range', sex: 'male', simulationLow: 1, simulationHigh: 9 }] },
    { referenceConcept: { ...selected.referenceConcept, id: 'qualitative-member', code: 'SYN-PANEL-QUALITATIVE' }, alternateCodings: [],
      valueType: 'string', referenceRange: { text: '阴性' }, allowedValues: ['阴性', '阳性'], healthyStrategy: 'fixed-normal',
      adultReferenceRules: [{ ...provenance, normalValue: '阴性', notes: '限成年女性', referenceKind: 'coded', sex: 'female' }] },
  ]
  expect(Buffer.byteLength(JSON.stringify(services))).toBeGreaterThan(240 * 1024)
  for (const service of services) {
    fixture.runtime.database.driver.prepare(`INSERT INTO hospital_service_catalog
      (workspace_id, epoch, service_id, code, name_zh, name_en, version, active, config_json)
      VALUES ('workspace-demo', 'epoch-1', ?, ?, ?, ?, 1, 1, ?)
    `).run(service.id, service.localCode, service.nameZh, service.nameZh, JSON.stringify({ laboratoryService: service }))
  }
  const before = await fixture.readCase()
  expect((await fixture.generate('laboratory')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read('laboratory')).toMatchObject({ status: 'ready', stale: false, items: [{
    kind: 'laboratory', catalogItemId: 'lab-99', label: '同名合成组合', indicationCode: 'clinical-evaluation',
  }] })
  expect(generationBytes).toBeLessThan(150 * 1024)
  expect(requests).toEqual(['doctor_recommendation_catalog_selection', 'doctor_recommendations', 'doctor_recommendation_verification'])
  expect(verificationPayload).toMatchObject({ selectedCatalogItems: { laboratory: [{ id: 'lab-99',
    specimen: { code: 'urine', display: '尿液' }, sourceDataset: { datasetId: 'laboratory-cn', releaseId: 'synthetic-clinical-release' },
    referenceConcept: { sourceLocator: 'synthetic:test:recommendations' },
    reportDefinition: { results: [{ adultReferenceRules: [{ sourceStandard: '合成标准', simulationLow: 1, simulationHigh: 9 }] }, {}] },
  }] } })
  fixture.runtime.database.driver.prepare(`UPDATE hospital_service_catalog SET
    config_json = json_set(config_json, '$.laboratoryService.tatMinutes', 240)
    WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1' AND service_id = 'lab-00'
  `).run()
  expect((await fixture.read('laboratory')).stale).toBe(true)
  expect(await fixture.readCase()).toEqual(before)
})

async function installLargeClinicalRecommendationCatalog(fixture: Awaited<ReturnType<typeof setup>>) {
  for (let index = 0; index < 100; index += 1) {
    const service = syntheticLaboratory(`clinical-lab-${String(index).padStart(2, '0')}`)
    service.sourceDataset = { datasetId: 'laboratory-cn', releaseId: 'synthetic-clinical-release' }
    service.reportDefinition.results = Array.from({ length: 4 }, (_, member) => ({
      ...service.reportDefinition.results[0]!,
      referenceConcept: { ...service.referenceConcept, id: `${service.id}:member-${member}`, code: `SYN-${index}-${member}`,
        display: `第${member}项合成生化指标，需结合实际标本与临床资料解读。` },
      adultReferenceRules: [{ high: 10, low: 0, notes: '仅用于成人参考；缺乏明确的临床依据时应核实，不得以目录存在推定需要检查。'.repeat(2),
        referenceKind: 'range', sex: 'all', sourceLocation: '合成标准条款', sourceStandard: '合成标准', sourceType: 'national-standard', sourceVersion: '1' }],
    }))
    fixture.runtime.database.driver.prepare(`INSERT INTO hospital_service_catalog
      (workspace_id, epoch, service_id, code, name_zh, name_en, version, active, config_json)
      VALUES ('workspace-demo', 'epoch-1', ?, ?, ?, ?, 1, 1, ?)
    `).run(service.id, service.localCode, service.nameZh, service.nameZh, JSON.stringify({ laboratoryService: service }))
  }
  const field = '合'.repeat(4000)
  expect((await fixture.saveDocument({ assessment: field, auxiliaryExamination: field, chiefComplaint: '合'.repeat(1000),
    disposition: field, followUp: field, historyOfPresentIllness: '合'.repeat(5000), physicalExamination: field, priorMedicalHistory: field })).status).toBe(200)
}

it('reads every oversized clinical catalog batch with selected original history and reuses only an unchanged complete catalog selection', async () => {
  const reviewed: string[] = []
  const batchSchemas: Array<{ ids: string[]; schema: Record<string, unknown> }> = []
  const requests: string[] = []
  let selectedEvidence: Array<{ text: string }> = []
  let projectedCatalogBytes = 0
  let verificationPayload: unknown
  let active = 0
  let peak = 0
  const fixture = await setup(async input => {
    requests.push(input.schemaName)
    expect(Buffer.byteLength(JSON.stringify(input.userPayload))).toBeLessThanOrEqual(240 * 1024)
    if (input.schemaName === 'doctor_recommendation_history_selection') {
      const payload = z.object({ historyEvidence: z.array(z.object({ id: z.string(), text: z.string() })) }).parse(input.userPayload)
      return { content: JSON.stringify({ complete: true, selectedEvidenceIds: payload.historyEvidence.filter(item => item.text.includes('未标注异常的旧肝功能结果')).map(item => item.id) }), model: input.model }
    }
    const text = JSON.stringify(input.userPayload)
    expect(text).toContain('旧的抗凝药记录，停药情况尚不明确。')
    expect(text).toContain('未标注异常的旧肝功能结果，尚不能排除异常，需复查。')
    if (input.schemaName === 'doctor_recommendation_catalog_selection') {
      const payload = z.object({ caseEvidence: z.array(z.object({ id: z.string(), text: z.string() })), catalogs: z.object({ laboratory: z.object({ items: z.array(z.object({
        id: z.string(), minimumAgeYears: z.literal(18),
      }).passthrough()) }) }) }).parse(input.userPayload)
      if (selectedEvidence.length === 0) selectedEvidence = payload.caseEvidence
      expect(payload.caseEvidence).toEqual(selectedEvidence)
      for (const item of payload.catalogs.laboratory.items) {
        expect(item).not.toHaveProperty('reportDefinition')
        expect(item).not.toHaveProperty('adultReferenceRules')
      }
      projectedCatalogBytes += Buffer.byteLength(JSON.stringify(z.object({ catalogs: z.object({ laboratory: z.object({
        items: z.array(z.unknown()),
      }) }) }).parse(input.userPayload).catalogs.laboratory.items))
      reviewed.push(...payload.catalogs.laboratory.items.map(item => item.id))
      batchSchemas.push({ ids: payload.catalogs.laboratory.items.map(item => item.id), schema: input.jsonSchema })
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      active -= 1
      return { content: JSON.stringify({ complete: true, selectedCatalogItemIds: payload.catalogs.laboratory.items
        .filter(item => item.id === 'clinical-lab-99').map(item => item.id) }), model: input.model }
    }
    if (input.schemaName === 'doctor_recommendation_verification') {
      verificationPayload = input.userPayload
      return { content: JSON.stringify(verificationOutput(input)), model: input.model }
    }
    expect(input.userPayload).toMatchObject({ catalogs: { laboratory: { items: [{ id: 'clinical-lab-99' }] } } })
    const generatedPayload = z.object({ caseEvidence: z.array(z.object({ id: z.string(), text: z.string() })) }).parse(input.userPayload)
    // 筛选阶段只携带索引摘要，生成阶段仍携带完整必读与已选原文。
    for (const item of selectedEvidence) expect(Buffer.byteLength(item.text)).toBeLessThanOrEqual(2 * 1024)
    const generatedLongest = Math.max(...generatedPayload.caseEvidence.map(item => Buffer.byteLength(item.text)))
    expect(generatedLongest).toBeGreaterThan(2 * 1024)
    expect(JSON.stringify(generatedPayload.caseEvidence)).toContain('未标注异常的旧肝功能结果，尚不能排除异常，需复查。')
    const output = diagnosisOutput(input)
    return { content: JSON.stringify({ ...output, items: [{ ...output.items[0], kind: 'laboratory',
      catalogItemId: 'clinical-lab-99', indicationCode: 'clinical-evaluation' }] }), model: input.model }
  }, { syntheaProvider: largeRecommendationHistory() })
  await installLargeClinicalRecommendationCatalog(fixture)
  const before = await fixture.readCase()
  expect((await fixture.generate('laboratory')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read('laboratory'), JSON.stringify({ ...await fixture.read('laboratory'), requests }))
    .toMatchObject({ status: 'ready', items: [{ kind: 'laboratory', catalogItemId: 'clinical-lab-99' }] })
  expect(reviewed.toSorted()).toEqual(Array.from({ length: 100 }, (_, index) => `clinical-lab-${String(index).padStart(2, '0')}`))
  for (const batch of batchSchemas) expect(batch.schema).toMatchObject({ properties: {
    selectedCatalogItemIds: { items: { enum: batch.ids } },
  } })
  expect(projectedCatalogBytes).toBeGreaterThan(20 * 1024)
  expect(projectedCatalogBytes).toBeLessThan(120 * 1024)
  expect(peak).toBe(1)
  const calls = requests.filter(name => name === 'doctor_recommendation_catalog_selection').length
  expect(calls).toBe(1)
  expect(verificationPayload).toMatchObject({ selectedCatalogItems: { laboratory: [{ id: 'clinical-lab-99',
    specimen: { code: 'blood' }, reportDefinition: { results: expect.arrayContaining([
      expect.objectContaining({ referenceConcept: expect.objectContaining({ sourceLocator: 'synthetic:test:recommendations' }),
        adultReferenceRules: [expect.objectContaining({ sourceStandard: '合成标准' })] }),
    ]) },
  }] } })
  const persisted = z.object({ input_json: z.string() }).parse(fixture.runtime.database.driver.prepare(
    "SELECT input_json FROM doctor_recommendation_state WHERE kind = 'laboratory'",
  ).get())
  expect(JSON.parse(persisted.input_json)).toMatchObject({ historySelection: { selectedEvidenceIds: expect.any(Array) }, catalogSelection: {
    reviewedCatalogItemIds: expect.arrayContaining(reviewed), selectedCatalogItemIds: ['clinical-lab-99'],
  } })
  expect((await fixture.generate('laboratory', true)).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect((await fixture.read('laboratory')).status).toBe('ready')
  expect(requests.filter(name => name === 'doctor_recommendation_catalog_selection')).toHaveLength(calls)
  fixture.runtime.database.driver.prepare(`UPDATE hospital_service_catalog SET config_json = json_set(config_json, '$.laboratoryService.tatMinutes', 240)
    WHERE service_id = 'clinical-lab-00'`).run()
  expect((await fixture.read('laboratory')).stale).toBe(true)
  expect((await fixture.generate('laboratory')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect((await fixture.read('laboratory')).status).toBe('ready')
  expect(requests.filter(name => name === 'doctor_recommendation_catalog_selection')).toHaveLength(2 * calls)
  expect(await fixture.readCase()).toEqual(before)
  // 596 条历史、100 项临床目录及长病历反复走完整读取、失效和重建，需覆盖较慢的 CI runner。
}, 30_000)

it.each(['incomplete', 'foreign-id', 'duplicate-id', 'cross-batch-id', 'none-supported'])(
  'does not generate executable suggestions from an incomplete, invalid or empty catalog selection (%s)', async failure => {
    const requests: string[] = []
    const fixture = await setup(async input => {
      requests.push(input.schemaName)
      if (input.schemaName === 'doctor_recommendations') {
        expect(failure).toBe('none-supported')
        expect(input.userPayload).toMatchObject({ mode: 'considerations-only', catalogs: { laboratory: { items: [] } } })
        return { model: input.model, content: JSON.stringify({ items: [], considerations: [], missingInformation: [] }) }
      }
      expect(input.schemaName).toBe('doctor_recommendation_catalog_selection')
      const payload = z.object({ catalogs: z.object({ laboratory: z.object({ items: z.array(z.object({ id: z.string() })) }) }) }).parse(input.userPayload)
      const firstId = payload.catalogs.laboratory.items[0]!.id
      const otherBatchId = Array.from({ length: 100 }, (_, index) => `clinical-lab-${String(index).padStart(2, '0')}`)
        .find(id => !payload.catalogs.laboratory.items.some(item => item.id === id))!
      return { content: JSON.stringify({ complete: failure !== 'incomplete', selectedCatalogItemIds:
        failure === 'foreign-id' ? ['foreign-catalog-item'] : failure === 'duplicate-id' ? [firstId, firstId]
          : failure === 'cross-batch-id' ? [otherBatchId] : [] }), model: input.model }
    })
    await installLargeClinicalRecommendationCatalog(fixture)
    const before = await fixture.readCase()
    expect((await fixture.generate('laboratory')).status).toBe(200)
    await fixture.runtime.dispatchPending()
    expect(await fixture.read('laboratory')).toMatchObject(failure === 'incomplete'
      ? { status: 'missing-evidence', items: [], missingInformation: [expect.stringContaining('完整读取')] }
      : failure === 'none-supported' ? { status: 'missing-evidence', items: [], missingInformation: [expect.stringContaining('适用的检验项目')] }
        : { status: 'failed', items: [], errorCode: 'AI_RESPONSE_INVALID' })
    expect(requests.length).toBeGreaterThan(0)
    if (failure === 'none-supported') {
      expect(requests.at(-1)).toBe('doctor_recommendations')
      expect(requests.slice(0, -1).every(name => name === 'doctor_recommendation_catalog_selection')).toBe(true)
    } else expect(requests.every(name => name === 'doctor_recommendation_catalog_selection')).toBe(true)
    expect(await fixture.readCase()).toEqual(before)
  },
)

it('rejects a generated catalog item that was available but not selected by the complete catalog review', async () => {
  const requests: string[] = []
  const fixture = await setup(async input => {
    requests.push(input.schemaName)
    if (input.schemaName === 'doctor_recommendation_catalog_selection') {
      const payload = z.object({ catalogs: z.object({ laboratory: z.object({ items: z.array(z.object({ id: z.string() })) }) }) }).parse(input.userPayload)
      return { content: JSON.stringify({ complete: true, selectedCatalogItemIds: payload.catalogs.laboratory.items
        .filter(item => item.id === 'clinical-lab-99').map(item => item.id) }), model: input.model }
    }
    const output = diagnosisOutput(input)
    return { content: JSON.stringify({ ...output, items: [{ ...output.items[0], kind: 'laboratory',
      catalogItemId: 'clinical-lab-00', indicationCode: 'clinical-evaluation' }] }), model: input.model }
  })
  await installLargeClinicalRecommendationCatalog(fixture)
  expect((await fixture.generate('laboratory')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read('laboratory')).toMatchObject({ status: 'failed', items: [], errorCode: 'AI_RESPONSE_INVALID' })
  expect(requests).not.toContain('doctor_recommendation_verification')
})

it.each(['history', 'catalog'])(
  'stops a superseded recommendation after the first %s selection wave before further model calls', async stage => {
    const pausedSchema = `doctor_recommendation_${stage}_selection`
    const requests: string[] = []
    let paused = 0
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const fixture = await setup(async input => {
      requests.push(input.schemaName)
      if (input.schemaName === pausedSchema && paused < 1) {
        paused += 1
        entered()
        await held
      }
      if (input.schemaName === 'doctor_recommendation_history_selection') {
        const payload = z.object({ historyEvidence: z.array(z.object({ id: z.string(), text: z.string() })) }).parse(input.userPayload)
        return { content: JSON.stringify({ complete: true, selectedEvidenceIds: payload.historyEvidence
          .filter(item => item.text.includes('未标注异常的旧肝功能结果')).map(item => item.id) }), model: input.model }
      }
      if (input.schemaName === 'doctor_recommendation_catalog_selection') {
        const payload = z.object({ catalogs: z.object({ laboratory: z.object({ items: z.array(z.object({ id: z.string() })) }) }) }).parse(input.userPayload)
        return { content: JSON.stringify({ complete: true, selectedCatalogItemIds: payload.catalogs.laboratory.items
          .filter(item => item.id === 'clinical-lab-99').map(item => item.id) }), model: input.model }
      }
      const output = input.schemaName === 'doctor_recommendation_verification' ? verificationOutput(input)
        : { ...diagnosisOutput(input), items: [{ ...diagnosisOutput(input).items[0], kind: 'laboratory',
          catalogItemId: 'clinical-lab-99', indicationCode: 'clinical-evaluation' }] }
      return { content: JSON.stringify(output), model: input.model }
    }, { syntheaProvider: largeRecommendationHistory() })
    await installLargeClinicalRecommendationCatalog(fixture)
    await fixture.runtime.dispatchPending()
    expect((await fixture.generate('laboratory')).status).toBe(200)
    const dispatch = fixture.runtime.dispatcher.dispatchOnce()
    await started
    try { expect((await fixture.generate('laboratory', true)).status).toBe(200) } finally { release() }
    await dispatch
    expect(await fixture.read('laboratory')).toMatchObject({ generation: 2, status: 'pending', items: [] })
    // 目录瘦身后 100 项通常单批完成筛选，替换发生在首个筛选请求进行中即可验证中断；历史仍按两批并发读取。
    expect(requests.filter(name => name === pausedSchema)).toHaveLength(stage === 'history' ? 2 : 1)
    expect(requests).not.toContain('doctor_recommendations')
    await fixture.runtime.dispatchPending()
    expect(await fixture.read('laboratory')).toMatchObject({ generation: 2, status: 'ready', items: [{ catalogItemId: 'clinical-lab-99' }] })
    expect(requests.filter(name => name === 'doctor_recommendations')).toHaveLength(1)
  },
  30_000,
)

it('uses installed imaging metadata and invalidates a suggestion when its actual offering disappears', async () => {
  let requests = 0
  let verificationPayload: unknown
  const fixture = await setup(async input => {
    requests += 1
    if (input.schemaName === 'doctor_recommendation_verification') {
      verificationPayload = input.userPayload
      return { content: JSON.stringify(verificationOutput(input)), model: input.model }
    }
    const payload = z.object({ mode: z.string(), catalogs: z.object({ imaging: z.object({ items: z.array(z.object({ available: z.boolean(),
      service: z.object({ id: z.string() }) })) }) }).strict() }).parse(input.userPayload)
    if (payload.mode === 'considerations-only') {
      expect(payload.catalogs.imaging.items.some(item => item.available)).toBe(false)
      return { model: input.model, content: JSON.stringify({ items: [], considerations: [], missingInformation: [] }) }
    }
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
  expect(verificationPayload).toMatchObject({ items: [{ label: '胸部 CT 平扫', serviceId: 'imaging-chest-ct-plain' }],
    selectedCatalogItems: { imaging: [{ id: 'imaging-chest-ct-plain', code: 'CT-CHEST-PLAIN', method: '平扫（不使用造影剂）' }] } })
  await rm(join(fixture.directory, 'imaging-assets', 'installed', 'synthetic-ct'), { force: true, recursive: true })
  expect((await fixture.read('imaging')).stale).toBe(true)
  expect((await fixture.generate('imaging')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read('imaging')).toMatchObject({ generation: 2, status: 'missing-evidence', items: [] })
  expect(requests).toBe(3)
  expect(await fixture.readCase()).toEqual(before)
})

it.each([false, true])('maps pathology only to an offered service and its authorized visible source procedure (fabricated: %s)', async fabricated => {
  let verificationPayload: unknown
  const syntheaProvider = new class extends StubSyntheaProvider {
    override async generate() {
      const corpus = await super.generate()
      const raw = breastCaseBundle({ name: '合成乳腺复诊患者' })
      return { ...corpus, sources: [{ ...corpus.sources[0]!, raw, hash: sourceArtifactHash(raw) }] }
    }
  }()
  const fixture = await setup(async input => {
    if (input.schemaName === 'doctor_recommendation_verification') {
      verificationPayload = input.userPayload
      return { content: JSON.stringify(verificationOutput(input)), model: input.model }
    }
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
  if (fabricated) expect(verificationPayload).toBeUndefined()
  else expect(verificationPayload).toMatchObject({ items: [{ label: '乳腺切片病理会诊', sourceProcedureReference: 'urn:uuid:procedure-0' }],
    selectedCatalogItems: { pathology: [{ service: { code: 'PATH-BREAST-SLIDE-CONSULT' },
      sourceProcedures: [{ sourceReference: 'urn:uuid:procedure-0', code: '392021009', display: '乳房肿块切除术' }] }] } })
  expect(await fixture.readCase()).toEqual(before)
  if (!fabricated) {
    const prepared = await fixture.read('pathology')
    const selection = { kind: 'pathology', source: 'agent', suggestionId: prepared.items[0]!.id,
      serviceId: 'pathology-breast-slide-consultation', sourceProcedureReference: 'urn:uuid:procedure-0', purpose: '复核既往手术切片。' }
    const wrongSource = await confirmPreparation(fixture, 'pathology', preparationBody(prepared, [{
      ...selection, sourceProcedureReference: 'urn:uuid:other-patient-procedure',
    }]))
    expect(wrongSource.status).toBe(409)
    expect(await fixture.readCase()).toEqual(before)
    const response = await confirmPreparation(fixture, 'pathology', preparationBody(prepared, [selection]))
    expect(response.status, await response.clone().text()).toBe(200)
    const receipt = confirmDoctorPreparationResponseSchema.parse(await response.json())
    expect((await fixture.readCase()).pathologyRequests?.requests[0]).toMatchObject({
      id: receipt.data.recordIds[0], status: 'issued', sourceProcedure: { sourceReference: 'urn:uuid:procedure-0' },
    })
  }
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
  expect(await fixture.read()).toMatchObject(field === 'guidelineSupported'
    ? { status: 'ready', items: [], considerations: [expect.objectContaining({ id: 'hypertension-candidate' })],
      notices: [expect.objectContaining({ category: 'guideline' })] }
    : { status: 'missing-evidence', items: [], considerations: [], notices: [expect.objectContaining({ category: 'verification' })] })
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
  expect(inputs[1]!.userPayload).toMatchObject({ items: [{ catalogItemId: 'medication-amlodipine', label: '苯磺酸氨氯地平片' }] })
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
    const stale = await fixture.read()
    expect(stale.stale).toBe(true)
    expect(stale).not.toHaveProperty('hidePreviousResults')
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

it.each(['Device', 'SupplyDelivery'])('reads all recommendation kinds with a visible %s type while preserving history field boundaries', async resourceType => {
  const type = { coding: [{ code: 'SYN-TYPE', display: '合成历史类型', system: 'urn:synthetic:history-type' }], text: '合成历史类型' }
  const syntheaProvider = new class extends StubSyntheaProvider {
    override async generate() {
      const corpus = await super.generate()
      const raw = z.object({ entry: z.array(z.object({ resource: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough().parse(corpus.sources[0]!.raw)
      raw.entry.find(item => item.resource.id === 'pe')!.resource.type = [type]
      raw.entry.push({ fullUrl: 'urn:uuid:prior-history-type', resource: {
        id: 'prior-history-type', resourceType, patient: { reference: 'urn:uuid:patient' },
        ...(resourceType === 'Device' ? { manufactureDate: '2025-01-10T09:10:00+08:00', status: 'active' }
          : { occurrenceDateTime: '2025-01-10T09:10:00+08:00', status: 'completed' }),
        type: { ...type, coding: [{ ...type.coding[0], extension: [{ url: 'https://untrusted.example/coding', valueString: 'private-coding-extension' }] }],
          extension: [{ url: 'https://untrusted.example/type', valueString: 'private-type-extension' }],
          reference: { reference: 'urn:uuid:index-condition' } },
        extension: [{ url: 'https://untrusted.example/resource', valueString: 'private-resource-extension' }],
        meta: { source: 'https://untrusted.example/source', tag: [{ code: 'private-metadata' }] },
        url: 'https://untrusted.example/raw', text: { status: 'generated', div: '<div>private-narrative</div>' },
      } })
      return { ...corpus, sources: [{ ...corpus.sources[0]!, raw, hash: sourceArtifactHash(raw) }] }
    }
  }()
  const fixture = await setup(async input => ({ content: JSON.stringify({ items: [], considerations: [], missingInformation: [] }), model: input.model }), { syntheaProvider })
  const before = await fixture.readCase()
  for (const kind of ['laboratory', 'diagnosis', 'prescription']) {
    expect(await fixture.read(kind)).toMatchObject({ kind, status: 'idle' })
    expect((await fixture.generate(kind)).status).toBe(200)
    await fixture.runtime.dispatchPending()
    const state = await fixture.read(kind)
    expect(state.status).toBe('missing-evidence')
    const history = state.caseEvidence.filter(item => item.kind === 'history').flatMap(item => {
      const group = z.object({ resourceType: z.string(), entries: z.array(z.record(z.string(), z.unknown())) }).safeParse(JSON.parse(item.text))
      return group.success ? group.data.entries.map(entry => ({ ...entry, resourceType: group.data.resourceType })) : []
    })
    expect(history).toContainEqual(expect.objectContaining({
      entryId: 'urn:uuid:prior-history-type', resourceType,
      clinical: { type, ...(resourceType === 'Device' ? { status: 'active' }
        : { occurrenceDateTime: '2025-01-10T09:10:00+08:00', status: 'completed' }) },
    }))
    expect(history).toContainEqual(expect.objectContaining({
      entryId: 'urn:uuid:prior-encounter', resourceType: 'Encounter', clinical: expect.objectContaining({ type: [type] }),
    }))
    expect(JSON.stringify(history)).not.toMatch(/"(?:extension|meta|url|patient|subject|reference)"|untrusted|private-/)
    expect(JSON.stringify(state)).not.toMatch(/2 型糖尿病|index-condition|11\.2|untrusted|private-/)
  }
  expect(await fixture.readCase()).toEqual(before)
})

it('generates from more than one hundred visible records while preserving every source and qualifier', async () => {
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
  const requests: string[] = []
  const fixture = await setup(async input => {
    requests.push(input.schemaName)
    const text = JSON.stringify(input.userPayload)
    for (let index = 0; index < 110; index += 1) expect(text).toContain(`第${index}项可见病史，不能删除“尚未明确”的限定。`)
    return { content: JSON.stringify(input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input)), model: input.model }
  }, { syntheaProvider })
  expect((await fixture.read()).status).toBe('idle')
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ status: 'ready', items: [{ kind: 'diagnosis' }] })
  expect(requests).toEqual(['doctor_recommendations', 'doctor_recommendation_verification'])
})

function largeRecommendationHistory(noteForIndex = (index: number) => index === 595
  ? '未标注异常的旧肝功能结果，尚不能排除异常，需复查。'
  : '本条历史记录未有进一步解释，不能推定正常。'.repeat(18)) {
  return new class extends StubSyntheaProvider {
    override async generate() {
      const corpus = await super.generate()
      const raw = z.object({ entry: z.array(z.object({ resource: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough().parse(corpus.sources[0]!.raw)
      raw.entry.push(...Array.from({ length: 596 }, (_, index) => ({ fullUrl: `urn:uuid:historical-observation-${index}`,
        resource: { resourceType: 'Observation', id: `historical-observation-${index}`, subject: { reference: 'urn:uuid:patient' },
          encounter: { reference: 'urn:uuid:prior-encounter' }, status: 'final', effectiveDateTime: '2024-01-10T09:05:00+08:00',
          code: { text: `历史观察编号${index}。` }, note: [{ text: noteForIndex(index) }] },
      })), { fullUrl: 'urn:uuid:old-anticoagulation', resource: { resourceType: 'MedicationRequest', id: 'old-anticoagulation',
        subject: { reference: 'urn:uuid:patient' }, encounter: { reference: 'urn:uuid:prior-encounter' },
        status: 'unknown', intent: 'order', authoredOn: '2010-01-10T09:05:00+08:00',
        medicationCodeableConcept: { text: '旧的抗凝药记录，停药情况尚不明确。' } } })
      return { ...corpus, sources: [{ ...corpus.sources[0]!, raw, hash: sourceArtifactHash(raw) }] }
    }
  }()
}

function heavyRequiredHistory({ procedures = 44, observations = 12, keepRepeat = 1150 }: { procedures?: number; observations?: number; keepRepeat?: number } = {}) {
  return new class extends StubSyntheaProvider {
    override async generate() {
      const corpus = await super.generate()
      const raw = z.object({ entry: z.array(z.object({ resource: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough().parse(corpus.sources[0]!.raw)
      raw.entry.push(...Array.from({ length: procedures }, (_, index) => ({ fullUrl: `urn:uuid:historical-procedure-${index}`,
        resource: { resourceType: 'Procedure', id: `historical-procedure-${index}`, subject: { reference: 'urn:uuid:patient' },
          encounter: { reference: 'urn:uuid:prior-encounter' }, status: 'completed', performedDateTime: '2024-01-05T09:05:00+08:00',
          code: { text: `既往手术记录编号${index}。` }, note: [{ text: 'x'.repeat(3800) }] },
      })), ...Array.from({ length: observations }, (_, index) => ({ fullUrl: `urn:uuid:large-related-${index}`,
        resource: { resourceType: 'Observation', id: `large-related-${index}`, subject: { reference: 'urn:uuid:patient' },
          encounter: { reference: 'urn:uuid:prior-encounter' }, status: 'final', effectiveDateTime: '2024-02-10T09:05:00+08:00',
          code: { text: `相关大记录编号${index}。` }, note: [{ text: 'KEEP.'.repeat(keepRepeat) }] },
      })))
      return { ...corpus, sources: [{ ...corpus.sources[0]!, raw, hash: sourceArtifactHash(raw) }] }
    }
  }()
}

it('generates from individually selected complete history records without retaining unrelated neighbours in their original packs', async () => {
  const selectedNote = '本次需复核的完整观察记录，尚不能排除肝功能异常，不能改为正常。' + '原始测量条件和备注必须完整保留。'.repeat(18)
  const unrelatedNote = 'UNRELATED_ONLY_SENTINEL：这条完整记录已明确核对为与本次无关。'.repeat(18)
  const reviewed: string[] = []
  const selectionIds: string[] = []
  const batchSchemas: Array<{ ids: string[]; schema: Record<string, unknown> }> = []
  const completedStages: string[] = []
  const fixture = await setup(async input => {
    if (input.schemaName === 'doctor_recommendation_history_selection') {
      const payload = z.object({ requiredEvidence: z.array(z.object({ text: z.string() })),
        historyEvidence: z.array(z.object({ id: z.string(), text: z.string() })) }).parse(input.userPayload)
      expect(JSON.stringify(payload.requiredEvidence)).toContain('旧的抗凝药记录，停药情况尚不明确。')
      reviewed.push(...payload.historyEvidence.map(item => item.text))
      selectionIds.push(...payload.historyEvidence.map(item => item.id))
      batchSchemas.push({ ids: payload.historyEvidence.map(item => item.id), schema: input.jsonSchema })
      return { content: JSON.stringify({ complete: true,
        selectedEvidenceIds: payload.historyEvidence.filter(item => item.text.includes(selectedNote)).map(item => item.id),
      }), model: input.model }
    }
    completedStages.push(input.schemaName)
    const text = JSON.stringify(input.userPayload)
    expect(text).toContain(selectedNote)
    expect(text).toContain('旧的抗凝药记录，停药情况尚不明确。')
    expect(text).not.toContain('UNRELATED_ONLY_SENTINEL')
    return { content: JSON.stringify(input.schemaName === 'doctor_recommendations'
      ? diagnosisOutput(input) : verificationOutput(input)), model: input.model }
  }, { syntheaProvider: largeRecommendationHistory(index => index % 30 === 0 ? selectedNote : unrelatedNote) })
  const before = await fixture.readCase()
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).status).toBe('ready')
  expect(Math.max(...selectionIds.map(id => Buffer.byteLength(id)))).toBeLessThanOrEqual(16)
  for (const batch of batchSchemas) expect(batch.schema).toMatchObject({ properties: {
    selectedEvidenceIds: { items: { enum: batch.ids } },
  } })
  for (let index = 0; index < 596; index += 1) expect(reviewed.join('\n')).toContain(`历史观察编号${index}。`)
  expect(completedStages).toEqual(['doctor_recommendations', 'doctor_recommendation_verification'])
  expect(await fixture.readCase()).toEqual(before)
})

it('reads every batch of a large history concurrently and reuses original-source selection across suggestion kinds', async () => {
  const syntheaProvider = largeRecommendationHistory()
  const selectedHistoryInputs: string[] = []
  const requests: string[] = []
  const requestChecks: Array<{ stage: string; safety: boolean; old?: boolean }> = []
  let active = 0
  let peak = 0
  let release!: () => void
  const parallel = new Promise<void>(resolve => { release = resolve })
  const fixture = await setup(async input => {
    requests.push(input.schemaName)
    expect(Buffer.byteLength(JSON.stringify(input.userPayload))).toBeLessThan(240 * 1024)
    if (input.schemaName === 'doctor_recommendation_history_selection') {
      const payload = z.object({ requiredEvidence: z.array(z.object({ text: z.string() })),
        historyEvidence: z.array(z.object({ id: z.string(), text: z.string() })) }).parse(input.userPayload)
      requestChecks.push({ stage: input.schemaName, safety: JSON.stringify(payload.requiredEvidence).includes('旧的抗凝药记录，停药情况尚不明确。') })
      expect(JSON.stringify(payload.requiredEvidence)).toContain('旧的抗凝药记录，停药情况尚不明确。')
      selectedHistoryInputs.push(...payload.historyEvidence.map(item => item.text))
      active += 1
      peak = Math.max(peak, active)
      if (active === 2) release()
      await parallel
      active -= 1
      return { content: JSON.stringify({ complete: true, selectedEvidenceIds: payload.historyEvidence
        .filter(item => item.text.includes('未标注异常的旧肝功能结果')).map(item => item.id) }), model: input.model }
    }
    const text = JSON.stringify(input.userPayload)
    requestChecks.push({ stage: input.schemaName, safety: text.includes('旧的抗凝药记录，停药情况尚不明确。'), old: text.includes('未标注异常的旧肝功能结果，尚不能排除异常，需复查。') })
    expect(text).toContain('旧的抗凝药记录，停药情况尚不明确。')
    expect(text).toContain('未标注异常的旧肝功能结果，尚不能排除异常，需复查。')
    const payload = z.object({ kind: z.string() }).parse(input.userPayload)
    const output = input.schemaName === 'doctor_recommendations'
      ? payload.kind === 'prescription' ? prescriptionOutput(input) : diagnosisOutput(input)
      : { items: verificationOutput(input).items.map(item => ({ ...item,
        ...(payload.kind !== 'prescription' ? {} : { prescriptionFields: { doseText: true, frequencyCode: true, courseDays: true, quantity: true } }),
      })) }
    return { content: JSON.stringify(output), model: input.model }
  }, { syntheaProvider })
  const before = await fixture.readCase()
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const completed = await fixture.read()
  expect(completed.status, JSON.stringify({ errorCode: completed.errorCode, requests, requestChecks, peak })).toBe('ready')
  expect(completed.items).toMatchObject([{ kind: 'diagnosis' }])
  for (let index = 0; index < 596; index += 1) expect(selectedHistoryInputs.join('\n')).toContain(`历史观察编号${index}。`)
  expect(peak).toBe(2)
  const selections = requests.filter(name => name === 'doctor_recommendation_history_selection').length
  expect(selections).toBeGreaterThan(1)
  expect(selections).toBeLessThanOrEqual(8)
  expect((await fixture.generate('diagnosis', true)).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).status).toBe('ready')
  expect(requests.filter(name => name === 'doctor_recommendation_history_selection')).toHaveLength(selections)
  expect((await fixture.generate('prescription')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect((await fixture.read('prescription')).status).toBe('ready')
  expect(requests.filter(name => name === 'doctor_recommendation_history_selection')).toHaveLength(selections)
  expect(await fixture.readCase()).toEqual(before)
  expect((await fixture.saveDocument({ chiefComplaint: '新增本次症状，需重新核对旧结果。' })).status).toBe(200)
  expect((await fixture.read()).stale).toBe(true)
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).status).toBe('ready')
  expect(requests.filter(name => name === 'doctor_recommendation_history_selection')).toHaveLength(2 * selections)
})

it('consolidates selected history into the generation budget instead of failing when the combined evidence overflows', async () => {
  const requests: string[] = []
  const fixture = await setup(async input => {
    requests.push(input.schemaName)
    if (input.schemaName === 'doctor_recommendation_history_selection') {
      const payload = z.object({ requiredEvidence: z.array(z.object({ id: z.string(), text: z.string() })),
        historyEvidence: z.array(z.object({ id: z.string(), text: z.string() })) }).parse(input.userPayload)
      // 筛选请求只携带必读资料的索引摘要，不再携带全文。
      for (const item of payload.requiredEvidence) expect(Buffer.byteLength(item.text)).toBeLessThanOrEqual(2 * 1024)
      return { content: JSON.stringify({ complete: true, selectedEvidenceIds: payload.historyEvidence
        .filter(item => item.text.includes('相关大记录编号')).map(item => item.id) }), model: input.model }
    }
    if (input.schemaName === 'doctor_recommendation_history_consolidation') {
      const payload = z.object({ capacity: z.number().int().positive(),
        selectedRecords: z.array(z.object({ selectionId: z.string(), text: z.string() })) }).parse(input.userPayload)
      expect(payload.selectedRecords.length).toBeGreaterThan(payload.capacity)
      expect(payload.selectedRecords.every(item => item.text.includes('相关大记录编号'))).toBe(true)
      return { content: JSON.stringify({ complete: true, selectedEvidenceIds: payload.selectedRecords
        .filter(item => item.text.includes('相关大记录编号0。')).map(item => item.selectionId) }), model: input.model }
    }
    const text = JSON.stringify(input.userPayload)
    expect(text).toContain('既往手术记录编号0。')
    expect(text).toContain('相关大记录编号0。')
    expect(text).not.toContain('相关大记录编号1。')
    return { content: JSON.stringify(input.schemaName === 'doctor_recommendations'
      ? diagnosisOutput(input) : verificationOutput(input)), model: input.model }
  }, { syntheaProvider: heavyRequiredHistory() })
  const before = await fixture.readCase()
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const state = await fixture.read()
  expect(state.status, JSON.stringify({ errorCode: state.errorCode, missingInformation: state.missingInformation, requests })).toBe('ready')
  expect(state.items).toMatchObject([{ kind: 'diagnosis' }])
  expect(requests.filter(name => name === 'doctor_recommendation_history_consolidation')).toHaveLength(1)
  expect(requests.at(-1)).toBe('doctor_recommendation_verification')
  expect(await fixture.readCase()).toEqual(before)
})

it('notifies the doctor when even the largest selected record cannot join the generation request', async () => {
  const requests: string[] = []
  const sizes: number[] = []
  const capacities: number[] = []
  const fixture = await setup(async input => {
    requests.push(input.schemaName)
    if (input.schemaName === 'doctor_recommendation_history_selection') {
      const payload = z.object({ historyEvidence: z.array(z.object({ id: z.string(), text: z.string() })) }).parse(input.userPayload)
      return { content: JSON.stringify({ complete: true, selectedEvidenceIds: payload.historyEvidence
        .filter(item => item.text.includes('相关大记录编号')).map(item => item.id) }), model: input.model }
    }
    if (input.schemaName === 'doctor_recommendation_history_consolidation') {
      const payload = z.object({ capacity: z.number().int().positive(),
        selectedRecords: z.array(z.object({ selectionId: z.string(), text: z.string() })) }).parse(input.userPayload)
      capacities.push(payload.capacity)
      return { content: JSON.stringify({ complete: true, selectedEvidenceIds: payload.selectedRecords
        .slice(0, payload.capacity).map(item => item.selectionId) }), model: input.model }
    }
    sizes.push(Buffer.byteLength(JSON.stringify(input.userPayload)))
    const text = JSON.stringify(input.userPayload)
    expect(text).toContain('既往手术记录编号0。')
    expect(text).not.toContain('相关大记录编号0。')
    return { content: JSON.stringify(input.schemaName === 'doctor_recommendations'
      ? diagnosisOutput(input) : verificationOutput(input)), model: input.model }
  }, { syntheaProvider: heavyRequiredHistory({ procedures: 55 }) })
  const before = await fixture.readCase()
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const state = await fixture.read()
  expect(state.status, JSON.stringify({ errorCode: state.errorCode, sizes, capacities, requests })).toBe('ready')
  expect(state.notices?.map(notice => notice.message).join('\n'), JSON.stringify({ sizes, capacities, requests })).toContain('未纳入本次建议')
  expect(requests.filter(name => name === 'doctor_recommendation_history_consolidation')).toHaveLength(0)
  expect(await fixture.readCase()).toEqual(before)
})

it('keeps the explicit budget failure when the consolidation request itself exceeds the envelope', async () => {
  const requests: string[] = []
  const fixture = await setup(async input => {
    requests.push(input.schemaName)
    if (input.schemaName === 'doctor_recommendation_history_selection') {
      const payload = z.object({ historyEvidence: z.array(z.object({ id: z.string(), text: z.string() })) }).parse(input.userPayload)
      return { content: JSON.stringify({ complete: true, selectedEvidenceIds: payload.historyEvidence
        .filter(item => item.text.includes('相关大记录编号')).map(item => item.id) }), model: input.model }
    }
    return { content: JSON.stringify(input.schemaName === 'doctor_recommendations'
      ? diagnosisOutput(input) : verificationOutput(input)), model: input.model }
  }, { syntheaProvider: heavyRequiredHistory({ observations: 24, keepRepeat: 2200 }) })
  const before = await fixture.readCase()
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const state = await fixture.read()
  expect(state.status, JSON.stringify({ errorCode: state.errorCode, requests })).toBe('missing-evidence')
  expect(state.missingInformation).toContain('当前完整资料或候选结果超过自动资料读取请求预算，无法形成可采纳建议。')
  expect(requests.filter(name => name === 'doctor_recommendation_history_selection').length).toBeGreaterThanOrEqual(1)
  expect(requests).not.toContain('doctor_recommendation_history_consolidation')
  expect(requests).not.toContain('doctor_recommendations')
  expect(await fixture.readCase()).toEqual(before)
})

it.each(['incomplete', 'foreign-id', 'provider-error', 'timeout'])('does not generate from an incomplete or invalid history selection (%s)', async failure => {
  const requests: string[] = []
  const fixture = await setup(async input => {
    requests.push(input.schemaName)
    expect(input.schemaName).toBe('doctor_recommendation_history_selection')
    if (failure === 'provider-error' || failure === 'timeout') return Response.json({
      error: failure === 'timeout' ? 'MODEL_TIMEOUT' : 'MODEL_UNAVAILABLE',
    }, { status: 503 })
    return { content: JSON.stringify({ complete: failure !== 'incomplete',
      selectedEvidenceIds: failure === 'foreign-id' ? ['evidence:another-patient'] : [] }), model: input.model }
  }, { syntheaProvider: largeRecommendationHistory() })
  const before = await fixture.readCase()
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject(failure === 'incomplete'
    ? { status: 'missing-evidence', items: [], missingInformation: [expect.stringContaining('完整读取')] }
    : { status: 'failed', items: [], errorCode: failure === 'timeout' ? 'MODEL_TIMEOUT'
      : failure === 'provider-error' ? 'MODEL_UNAVAILABLE' : 'AI_RESPONSE_INVALID' })
  expect(requests.length).toBeGreaterThan(0)
  expect(requests.every(name => name === 'doctor_recommendation_history_selection')).toBe(true)
  expect(await fixture.readCase()).toEqual(before)
})

it('stops after the bounded Provider retry on rate limits and preserves clinical drafts for explicit recovery', async () => {
  let requests = 0
  const fixture = await setup(async () => {
    requests += 1
    return Response.json({ error: 'MODEL_RATE_LIMIT', retryAfterMs: 5 }, { status: 429 })
  })
  expect((await fixture.saveDocument({ chiefComplaint: '保留当前人工主诉。' })).status).toBe(200)
  const before = await fixture.readCase()
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(requests).toBe(2)
  expect(await fixture.read()).toMatchObject({ status: 'failed', errorCode: 'MODEL_UNAVAILABLE', items: [],
    missingInformation: [expect.stringContaining('限流')] })
  await fixture.runtime.dispatchPending()
  expect(requests).toBe(2)
  expect(await fixture.readCase()).toEqual(before)
})

it.each(['legacy-format', 'foreign-case-reference'] as const)('independently checks read-only case reasoning with the supplied reference schema when no guideline is acquired (%s)', async failure => {
  const syntheaProvider = new class extends StubSyntheaProvider {
    override async generate() {
      const corpus = await super.generate()
      const raw = z.object({ entry: z.array(z.object({ resource: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough().parse(corpus.sources[0]!.raw)
      raw.entry = raw.entry.filter(item => item.resource.id !== 'pc')
      return { ...corpus, sources: [{ ...corpus.sources[0]!, raw, hash: sourceArtifactHash(raw) }] }
    }
  }()
  const requests: string[] = []
  let suppliedEvidence: unknown
  let generationAttempts = 0
  const generationSchemas: Array<{ schema: Record<string, unknown>; evidenceIds: string[]; prompt: string }> = []
  const fixture = await setup(async input => {
    requests.push(input.schemaName)
    const payload = z.object({ guidelines: z.array(z.unknown()), caseEvidence: z.array(z.object({ id: z.string(), kind: z.string() }).passthrough()),
      considerations: z.array(z.object({ id: z.string() })).optional() }).parse(input.userPayload)
    expect(payload.guidelines).toEqual([])
    if (input.schemaName === 'doctor_recommendations') {
      generationSchemas.push({ schema: input.jsonSchema, evidenceIds: payload.caseEvidence.map(item => item.id), prompt: input.systemPrompt })
      expect(input.jsonSchema).toMatchObject({ required: expect.arrayContaining(['considerations']),
        properties: { items: { maxItems: 0 } } })
      const first = generationAttempts++ === 0
      if (first && failure === 'legacy-format') return { model: input.model, content: JSON.stringify({ items: [], missingInformation: [] }) }
      suppliedEvidence = payload.caseEvidence
      const evidence = payload.caseEvidence.find(item => item.kind === 'presentation')!
      return { model: input.model, content: JSON.stringify({ items: [], considerations: [{
        id: 'synthetic-dizziness-consideration', label: '核对头晕的症状演变', rationale: '结合当前主诉提出待核实方向，不作确诊。',
        supportingInformation: ['当前主诉包含头晕。'], opposingInformation: [],
        missingInformation: ['补问是否出现新的伴随表现，以决定后续评估方向。'],
        caseEvidenceIds: [first && failure === 'foreign-case-reference' ? 'other-patient-evidence' : evidence.id],
      }], missingInformation: [] }) }
    }
    expect(input.schemaName).toBe('doctor_recommendation_verification')
    expect(payload.caseEvidence).toEqual(suppliedEvidence)
    return { model: input.model, content: JSON.stringify({ items: payload.considerations!.map(item => ({ id: item.id,
      guidelineSupported: false, caseSupported: true, applicable: true, qualifiersPreserved: true })) }) }
  }, { syntheaProvider })
  const before = await fixture.readCase()
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(generationSchemas).toHaveLength(2)
  for (const generation of generationSchemas) expect(generation.schema).toMatchObject({ properties: {
    considerations: { maxItems: 8, items: { properties: { caseEvidenceIds: {
      minItems: 1, maxItems: 12, items: { enum: generation.evidenceIds },
    } } } },
  } })
  if (failure === 'foreign-case-reference') expect(generationSchemas[1]!.prompt).toContain('considerations.0.caseEvidenceIds.0')
  expect(await fixture.read()).toMatchObject({ status: 'ready', guidelines: [], items: [],
    considerations: [expect.objectContaining({ id: 'synthetic-dizziness-consideration' })],
    notices: [expect.objectContaining({ category: 'guideline' })] })
  expect(requests).toEqual(['doctor_recommendations', 'doctor_recommendations', 'doctor_recommendation_verification'])
  expect(await fixture.readCase()).toEqual(before)
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
      id: 'synthetic-hypertension-candidate', kind: 'diagnosis', role: 'primary', catalogItemId: 'diagnosis-hypertension',
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


it('confirms a selected prepared diagnosis atomically without requiring a separate draft save', async () => {
  const fixture = await setup(async input => ({ content: JSON.stringify(
    input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input),
  ), model: input.model }))
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const prepared = await fixture.read()
  const candidate = prepared.items[0]!
  const response = await fixture.runtime.app.request(`${fixture.path()}/actions/confirm`, {
    method: 'POST', headers: { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: { [`Encounter/${prepared.encounterId}`]: prepared.encounterVersion },
      input: { generation: prepared.generation, inputFingerprint: prepared.inputFingerprint,
        expectedDraftVersion: (await fixture.readCase()).diagnosis?.draftVersion ?? 0,
        selections: [{ kind: 'diagnosis', source: 'agent', suggestionId: candidate.id,
          catalogItemId: 'diagnosis-hypertension', role: 'primary' }] } }),
  })
  expect(response.status, await response.clone().text()).toBe(200)
  expect((await fixture.readCase()).diagnosis).toMatchObject({
    confirmation: { entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary' }] },
  })
})

it('invalidates every prepared kind when a formal investigation is issued or cancelled before a report exists', async () => {
  const fixture = await setup()
  const service = syntheticLaboratory('lab-preparation')
  fixture.runtime.database.driver.prepare(`INSERT INTO hospital_service_catalog
    (workspace_id, epoch, service_id, code, name_zh, name_en, version, active, config_json)
    VALUES ('workspace-demo', 'epoch-1', ?, ?, ?, ?, 1, 1, ?)
  `).run(service.id, service.localCode, service.nameZh, service.nameZh, JSON.stringify({ laboratoryService: service }))
  const before = await Promise.all(['diagnosis', 'laboratory', 'prescription'].map(kind => fixture.read(kind)))
  const post = async (action: string, input: unknown, method = 'POST') => fixture.runtime.app.request(
    `/api/his/v1/encounters/${fixture.started.encounterId}/${action}`, {
      method, headers: { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${fixture.started.encounterId}`]: before[0]!.encounterVersion }, input }),
    })
  const saved = await post('laboratory-request/draft', { catalogItemId: service.id, indicationCode: 'clinical-evaluation', expectedDraftVersion: 0 }, 'PUT')
  expect(saved.status, await saved.clone().text()).toBe(200)
  const issued = await post('laboratory-request/actions/issue', { expectedDraftVersion: 1 })
  expect(issued.status, await issued.clone().text()).toBe(200)
  const request = z.object({ data: z.object({ request: z.object({ id: z.string(), version: z.number(), serviceRequestId: z.string(), serviceRequestVersion: z.string(), taskId: z.string(), taskVersion: z.string() }) }) }).parse(await issued.json()).data.request
  const afterIssue = await Promise.all(before.map(state => fixture.read(state.kind)))
  expect((await fixture.readCase()).encounter.versionId).toBe(before[0]!.encounterVersion)
  for (const [index, state] of afterIssue.entries()) expect(state.inputFingerprint).not.toBe(before[index]!.inputFingerprint)
  const cancelled = await fixture.runtime.app.request(`/api/his/v1/laboratory-requests/${request.id}/actions/cancel`, {
    method: 'POST', headers: { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: { [`ServiceRequest/${request.serviceRequestId}`]: request.serviceRequestVersion, [`Task/${request.taskId}`]: request.taskVersion }, input: { expectedRequestVersion: request.version, reasonCode: 'no-longer-needed' } }),
  })
  expect(cancelled.status, await cancelled.clone().text()).toBe(200)
  for (const state of afterIssue) expect((await fixture.read(state.kind)).inputFingerprint).not.toBe(state.inputFingerprint)
})

function preparationBody(state: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['read']>>, selections: unknown[], expectedDraftVersion = 0) {
  return { expectedVersions: { [`Encounter/${state.encounterId}`]: state.encounterVersion }, input: {
    generation: state.generation, inputFingerprint: state.inputFingerprint, expectedDraftVersion, selections,
  } }
}
function confirmPreparation(fixture: Awaited<ReturnType<typeof setup>>, kind: string, body: unknown, key = randomUUID(), cookie = fixture.cookie) {
  return fixture.runtime.app.request(`${fixture.path(kind)}/actions/confirm`, {
    method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body),
  })
}

it('confirms manual diagnosis without reading or generating recommendations and replays the same audited receipt', async () => {
  const fixture = await setup()
  const clinical = await fixture.readCase()
  const body = { expectedVersions: { [`Encounter/${clinical.encounter.id}`]: clinical.encounter.versionId }, input: {
    expectedDraftVersion: 0, selections: [{ kind: 'diagnosis', source: 'manual', catalogItemId: 'diagnosis-fever', role: 'primary', note: '医生手动添加。' }],
  } }
  const key = randomUUID()
  const response = await confirmPreparation(fixture, 'diagnosis', body, key)
  expect(response.status, await response.clone().text()).toBe(200)
  const receipt = confirmDoctorPreparationResponseSchema.parse(await response.json())
  expect(receipt.auditId).toBeTruthy()
  expect((await fixture.readCase()).diagnosis?.confirmation).toMatchObject({ revisionNumber: 1,
    entries: [{ catalogItemId: 'diagnosis-fever', role: 'primary', note: '医生手动添加。' }],
  })
  const replay = await confirmPreparation(fixture, 'diagnosis', body, key)
  expect(replay.status, await replay.clone().text()).toBe(200)
  expect(confirmDoctorPreparationResponseSchema.parse(await replay.json())).toEqual(receipt)
  expect((await fixture.readCase()).diagnosis?.confirmation?.revisionNumber).toBe(1)
})

it.each(['pending', 'failed', 'stale', 'missing-evidence'] as const)('allows independent manual diagnosis while recommendations are %s', async status => {
  let modelCalls = 0
  const fixture = await setup(async input => {
    modelCalls += 1
    return { model: input.model, content: status === 'failed' ? 'invalid structured response'
      : JSON.stringify(input.schemaName === 'doctor_recommendations'
        ? status === 'missing-evidence' ? { items: [], missingInformation: [] } : diagnosisOutput(input) : verificationOutput(input)) }
  })
  expect((await fixture.generate()).status).toBe(200)
  if (status !== 'pending') await fixture.runtime.dispatchPending()
  if (status === 'stale') expect((await fixture.saveDocument({ assessment: '医生新增病情核对内容。' })).status).toBe(200)
  const state = await fixture.read()
  expect(state).toMatchObject(status === 'stale' ? { stale: true } : { status })
  const clinical = await fixture.readCase()
  const beforeCalls = modelCalls
  const response = await confirmPreparation(fixture, 'diagnosis', {
    expectedVersions: { [`Encounter/${clinical.encounter.id}`]: clinical.encounter.versionId }, input: {
      expectedDraftVersion: 0, selections: [{ kind: 'diagnosis', source: 'manual', catalogItemId: 'diagnosis-fever', role: 'primary' }],
    },
  })
  expect(response.status, await response.clone().text()).toBe(200)
  expect((await fixture.readCase()).diagnosis?.confirmation?.entries).toMatchObject([{ catalogItemId: 'diagnosis-fever' }])
  expect(modelCalls).toBe(beforeCalls)
})

it('allows manual confirmation even when the saved recommendation state cannot be read', async () => {
  const fixture = await setup()
  expect((await fixture.generate()).status).toBe(200)
  fixture.runtime.database.driver.prepare(`UPDATE doctor_recommendation_state SET state_json = '{}' WHERE case_id = ?`)
    .run(fixture.started.outpatientCaseId)
  expect((await fixture.runtime.app.request(fixture.path(), { headers: { cookie: fixture.cookie } })).status).toBe(400)
  const clinical = await fixture.readCase()
  const response = await confirmPreparation(fixture, 'diagnosis', {
    expectedVersions: { [`Encounter/${clinical.encounter.id}`]: clinical.encounter.versionId }, input: {
      expectedDraftVersion: 0, selections: [{ kind: 'diagnosis', source: 'manual', catalogItemId: 'diagnosis-fever', role: 'primary' }],
    },
  })
  expect(response.status, await response.clone().text()).toBe(200)
  expect((await fixture.readCase()).diagnosis?.confirmation?.entries).toMatchObject([{ catalogItemId: 'diagnosis-fever' }])
})

it('rejects stale agent selections in a mixed batch while allowing current manual input without the old proof', async () => {
  const fixture = await setup(async input => ({ content: JSON.stringify(
    input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input),
  ), model: input.model }))
  await fixture.generate()
  await fixture.runtime.dispatchPending()
  const prepared = await fixture.read()
  expect((await fixture.saveDocument({ assessment: '新资料需要重新核对自动诊断。' })).status).toBe(200)
  const manual = { kind: 'diagnosis', source: 'manual', catalogItemId: 'diagnosis-fever', role: 'primary' }
  const before = await fixture.readCase()
  const mixed = await confirmPreparation(fixture, 'diagnosis', preparationBody(prepared, [manual, {
    kind: 'diagnosis', source: 'agent', suggestionId: prepared.items[0]!.id, catalogItemId: 'diagnosis-hypertension', role: 'secondary',
  }]))
  expect(mixed.status, await mixed.clone().text()).toBe(409)
  expect(await fixture.readCase()).toEqual(before)
  const response = await confirmPreparation(fixture, 'diagnosis', {
    expectedVersions: { [`Encounter/${before.encounter.id}`]: before.encounter.versionId }, input: { expectedDraftVersion: 0, selections: [manual] },
  })
  expect(response.status, await response.clone().text()).toBe(200)
})

it('keeps manual confirmation subject to current authorization, catalog and clinical versions', async () => {
  const fixture = await setup()
  const clinical = await fixture.readCase()
  const manual = { kind: 'diagnosis', source: 'manual', catalogItemId: 'diagnosis-fever', role: 'primary' }
  const body = { expectedVersions: { [`Encounter/${clinical.encounter.id}`]: clinical.encounter.versionId },
    input: { expectedDraftVersion: 0, selections: [manual] } }
  for (const input of [
    { ...body, expectedVersions: { [`Encounter/${clinical.encounter.id}`]: '1' } },
    { ...body, input: { ...body.input, expectedDraftVersion: 8 } },
    { ...body, input: { ...body.input, selections: [{ ...manual, catalogItemId: 'missing-diagnosis' }] } },
    { ...body, input: { ...body.input, selections: [{ ...manual, role: 'secondary' }] } },
  ]) {
    const rejected = await confirmPreparation(fixture, 'diagnosis', input)
    expect(rejected.status, await rejected.clone().text()).toBe(409)
    expect(await fixture.readCase()).toEqual(clinical)
  }
  const triage = await signIn(fixture.runtime, 'triage@demo.clinmesh.local')
  const unauthorized = await confirmPreparation(fixture, 'diagnosis', body, randomUUID(), triage)
  expect(unauthorized.status).toBe(403)
  expect(await fixture.readCase()).toEqual(clinical)
})

function installPreparationLaboratory(fixture: Awaited<ReturnType<typeof setup>>, id: string) {
  const service = syntheticLaboratory(id)
  fixture.runtime.database.driver.prepare(`INSERT INTO hospital_service_catalog
    (workspace_id, epoch, service_id, code, name_zh, name_en, version, active, config_json)
    VALUES ('workspace-demo', 'epoch-1', ?, ?, ?, ?, 1, 1, ?)
  `).run(service.id, service.localCode, service.nameZh, service.nameZh, JSON.stringify({ laboratoryService: service }))
}

it('rejects a prepared confirmation after saved patient facts change without advancing the Encounter', async () => {
  const fixture = await setup(async input => ({ content: JSON.stringify(input.schemaName === 'patient_dialogue_reply'
    ? { reply: '我这两天还会心慌，站起来的时候更明显。' }
    : input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input)), model: input.model }))
  expect((await fixture.generate()).status).toBe(200)
  await fixture.runtime.dispatchPending()
  const prepared = await fixture.read()
  const previous = await fixture.readCase()
  const body = preparationBody(prepared, [{ kind: 'diagnosis', source: 'agent', suggestionId: prepared.items[0]!.id,
    catalogItemId: 'diagnosis-hypertension', role: 'primary' }])
  const answered = await fixture.runtime.app.request(`/api/his/v1/encounters/${prepared.encounterId}/actions/ask-consultation-question`, {
    method: 'POST', headers: { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: { [`Encounter/${prepared.encounterId}`]: prepared.encounterVersion,
      [`Task/${fixture.started.doctorTaskId}`]: previous.taskVersion }, input: {
      expectedConsultationVersion: previous.consultation!.version, message: '还有其他不舒服吗？',
    } }),
  })
  expect(answered.status, await answered.clone().text()).toBe(200)
  const changed = await fixture.readCase()
  expect(changed.encounter.versionId).toBe(prepared.encounterVersion)
  const rejected = await confirmPreparation(fixture, 'diagnosis', body)
  expect(rejected.status, await rejected.clone().text()).toBe(409)
  expect((await fixture.readCase()).diagnosis).toEqual(changed.diagnosis)
})

it('replays the same prepared confirmation receipt without creating another diagnosis revision', async () => {
  const fixture = await setup(async input => ({ content: JSON.stringify(
    input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input),
  ), model: input.model }))
  await fixture.generate()
  await fixture.runtime.dispatchPending()
  const prepared = await fixture.read()
  const key = randomUUID()
  const body = preparationBody(prepared, [{ kind: 'diagnosis', source: 'agent', suggestionId: prepared.items[0]!.id,
    catalogItemId: 'diagnosis-hypertension', role: 'primary' }])
  const first = await confirmPreparation(fixture, 'diagnosis', body, key)
  expect(first.status).toBe(200)
  const receipt = confirmDoctorPreparationResponseSchema.parse(await first.json())
  const replay = await confirmPreparation(fixture, 'diagnosis', body, key)
  expect(replay.status, await replay.clone().text()).toBe(200)
  expect(confirmDoctorPreparationResponseSchema.parse(await replay.json())).toEqual(receipt)
  expect((await fixture.readCase()).diagnosis?.confirmation?.revisionNumber).toBe(1)
})

it.each(['generation', 'clinical-identity', 'directory', 'doctor-scope', 'draft-version'] as const)('rejects prepared confirmation with changed %s', async change => {
  const fixture = await setup(async input => ({ content: JSON.stringify(
    input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input),
  ), model: input.model }))
  await fixture.generate()
  await fixture.runtime.dispatchPending()
  const prepared = await fixture.read()
  const body = preparationBody(prepared, [{ kind: 'diagnosis', source: 'agent', suggestionId: prepared.items[0]!.id,
    catalogItemId: change === 'clinical-identity' ? 'diagnosis-fever' : 'diagnosis-hypertension', role: 'primary' }], change === 'draft-version' ? 42 : 0)
  if (change === 'generation') await fixture.generate('diagnosis', true)
  if (change === 'directory') fixture.runtime.database.driver.prepare(`UPDATE diagnosis_catalog SET active = 0 WHERE item_id = 'diagnosis-hypertension'`).run()
  const cookie = change === 'doctor-scope' ? await signIn(fixture.runtime, 'triage@demo.clinmesh.local') : fixture.cookie
  const before = await fixture.readCase()
  const response = await confirmPreparation(fixture, 'diagnosis', body, randomUUID(), cookie)
  expect(response.status, await response.clone().text()).toBe(change === 'doctor-scope' ? 403 : 409)
  expect(await fixture.readCase()).toEqual(before)
})

it('issues selected prepared laboratory items atomically and preserves an existing manual draft', async () => {
  const fixture = await setup(async input => {
    if (input.schemaName === 'doctor_recommendation_verification') return { model: input.model, content: JSON.stringify(verificationOutput(input)) }
    if (input.schemaName === 'doctor_recommendation_catalog_selection') {
      const payload = z.object({ catalogs: z.object({ laboratory: z.object({ items: z.array(z.object({ id: z.string() })) }) }) }).parse(input.userPayload)
      return { model: input.model, content: JSON.stringify({ complete: true, selectedCatalogItemIds: payload.catalogs.laboratory.items
        .filter(item => item.id === 'lab-preparation-a' || item.id === 'lab-preparation-b').map(item => item.id) }) }
    }
    const base = diagnosisOutput(input).items[0]!
    return { model: input.model, content: JSON.stringify({ items: ['lab-preparation-a', 'lab-preparation-b'].map((id, index) => ({
      ...base, id: `lab-candidate-${index}`, kind: 'laboratory', catalogItemId: id, indicationCode: 'clinical-evaluation',
    })), missingInformation: [] }) }
  })
  installPreparationLaboratory(fixture, 'lab-preparation-a')
  installPreparationLaboratory(fixture, 'lab-preparation-b')
  await fixture.generate('laboratory')
  await fixture.runtime.dispatchPending()
  const prepared = await fixture.read('laboratory')
  const selections = prepared.items.map(item => ({ kind: 'laboratory', source: 'agent', suggestionId: item.id,
    catalogItemId: item.kind === 'laboratory' ? item.catalogItemId : '', indicationCode: 'clinical-evaluation' }))
  expect(selections).toHaveLength(2)
  const beforeBad = await fixture.readCase()
  const bad = await confirmPreparation(fixture, 'laboratory', preparationBody(prepared,
    selections.map((item, index) => index === 1 ? { ...item, indicationCode: 'not-allowed' } : item)))
  expect(bad.status, await bad.clone().text()).toBe(409)
  expect(await fixture.readCase()).toEqual(beforeBad)
  const body = preparationBody(prepared, selections)
  const key = randomUUID()
  const issued = await confirmPreparation(fixture, 'laboratory', body, key)
  expect(issued.status, await issued.clone().text()).toBe(200)
  const receipt = confirmDoctorPreparationResponseSchema.parse(await issued.json())
  expect(receipt).toMatchObject({ data: { kind: 'laboratory', draftVersion: 4, recordIds: [expect.any(String), expect.any(String)] }, effects: expect.arrayContaining([
    expect.objectContaining({ kind: 'created', reference: expect.stringMatching(/^ServiceRequest\//) }),
  ]) })
  const replay = await confirmPreparation(fixture, 'laboratory', body, key)
  expect(replay.status).toBe(200)
  expect(confirmDoctorPreparationResponseSchema.parse(await replay.json())).toEqual(receipt)
  const formalRequests = (await fixture.readCase()).laboratoryRequests?.requests
  expect(formalRequests).toHaveLength(2)
  expect(formalRequests?.every(request => Number.isFinite(Date.parse(request.authoredAt ?? '')))).toBe(true)

  const saved = await fixture.runtime.app.request(`/api/his/v1/encounters/${prepared.encounterId}/laboratory-request/draft`, {
    method: 'PUT', headers: { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: body.expectedVersions, input: { catalogItemId: 'lab-preparation-a', indicationCode: 'clinical-evaluation', expectedDraftVersion: 4 } }),
  })
  expect(saved.status).toBe(200)
  await fixture.generate('laboratory')
  await fixture.runtime.dispatchPending()
  const next = await fixture.read('laboratory')
  const before = await fixture.readCase()
  const blocked = await confirmPreparation(fixture, 'laboratory', preparationBody(next, selections, 5))
  expect(blocked.status).toBe(409)
  expect(await fixture.readCase()).toEqual(before)
})

it('requires explicit versioned resolution of an existing laboratory draft and rolls back the whole replacement batch on failure', async () => {
  const fixture = await setup()
  for (const id of ['lab-manual-original', 'lab-manual-next', 'lab-manual-other']) installPreparationLaboratory(fixture, id)
  const clinical = await fixture.readCase()
  const expectedVersions = { [`Encounter/${clinical.encounter.id}`]: clinical.encounter.versionId }
  const saved = await fixture.runtime.app.request(`/api/his/v1/encounters/${clinical.encounter.id}/laboratory-request/draft`, {
    method: 'PUT', headers: { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions, input: { expectedDraftVersion: 0, catalogItemId: 'lab-manual-original', indicationCode: 'clinical-evaluation' } }),
  })
  expect(saved.status, await saved.clone().text()).toBe(200)
  const before = await fixture.readCase()
  const selections = ['lab-manual-next', 'lab-manual-other'].map(catalogItemId => ({ kind: 'laboratory', source: 'manual', catalogItemId, indicationCode: 'clinical-evaluation' }))
  const input = { expectedDraftVersion: 1, selections }
  for (const changes of [{}, { resolveExistingDraft: false }, { resolveExistingDraft: true, expectedDraftVersion: 0 },
    { resolveExistingDraft: true, selections: [selections[0], { ...selections[1], indicationCode: 'not-allowed' }] }]) {
    const rejected = await confirmPreparation(fixture, 'laboratory', { expectedVersions, input: { ...input, ...changes } })
    expect(rejected.status, await rejected.clone().text()).toBe(409)
    expect(await fixture.readCase()).toEqual(before)
  }
  const body = { expectedVersions, input: { ...input, resolveExistingDraft: true } }
  const key = randomUUID()
  const issued = await confirmPreparation(fixture, 'laboratory', body, key)
  expect(issued.status, await issued.clone().text()).toBe(200)
  const receipt = confirmDoctorPreparationResponseSchema.parse(await issued.json())
  expect(receipt.data).toMatchObject({ draftVersion: 6, recordIds: [expect.any(String), expect.any(String)] })
  const after = await fixture.readCase()
  expect(after.laboratoryRequests?.draft).toBeUndefined()
  expect(after.laboratoryRequests?.requests.map(item => item.catalogItemId)).toEqual(['lab-manual-next', 'lab-manual-other'])
  expect(confirmDoctorPreparationResponseSchema.parse(await (await confirmPreparation(fixture, 'laboratory', body, key)).json())).toEqual(receipt)
})

it.each(['imaging', 'pathology'] as const)('resolves an existing %s draft atomically before manual issuance without recommendations', async kind => {
  const syntheaProvider = new class extends StubSyntheaProvider {
    override async generate() {
      const corpus = await super.generate()
      const raw = breastCaseBundle({ name: '合成手动开具患者' })
      return { ...corpus, sources: [{ ...corpus.sources[0]!, raw, hash: sourceArtifactHash(raw) }] }
    }
  }()
  const fixture = await setup(undefined, { syntheaProvider })
  if (kind === 'imaging') await installSyntheticImagingAssets({ assetDirectory: join(fixture.directory, 'imaging-assets'),
    catalogDirectory: join(fixture.directory, 'imaging-catalog'), assets: [{ assetId: 'synthetic-ct', examCode: 'chest-ct-plain' }] })
  else await installSyntheticPathologySlides({ assetDirectory: join(fixture.directory, 'pathology-assets'),
    catalogDirectory: join(fixture.directory, 'pathology-catalog'), slides: [{ assetId: 'synthetic-breast-slide' }] })
  const clinical = await fixture.readCase()
  const expectedVersions = { [`Encounter/${clinical.encounter.id}`]: clinical.encounter.versionId }
  const fields = kind === 'imaging' ? { serviceId: 'imaging-chest-ct-plain', indication: '医生核对当前检查目的。' }
    : { serviceId: 'pathology-breast-slide-consultation', sourceProcedureReference: 'urn:uuid:procedure-0', purpose: '复核既往手术切片。' }
  const saved = await fixture.runtime.app.request(`/api/his/v1/encounters/${clinical.encounter.id}/${kind}-request/draft`, {
    method: 'PUT', headers: { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions, input: { expectedDraftVersion: 0, ...fields } }),
  })
  expect(saved.status, await saved.clone().text()).toBe(200)
  const before = await fixture.readCase()
  const selection = { ...fields, kind, source: 'manual' }
  const input = { expectedDraftVersion: 1, selections: [selection] }
  for (const changes of [{}, { resolveExistingDraft: true, expectedDraftVersion: 0 }, { resolveExistingDraft: true,
    selections: [{ ...selection, ...(kind === 'imaging' ? { serviceId: 'unavailable-service' } : { sourceProcedureReference: 'urn:uuid:other-patient-procedure' }) }],
  }]) {
    const rejected = await confirmPreparation(fixture, kind, { expectedVersions, input: { ...input, ...changes } })
    expect(rejected.status, await rejected.clone().text()).toBe(409)
    expect(await fixture.readCase()).toEqual(before)
  }
  const response = await confirmPreparation(fixture, kind, { expectedVersions, input: { ...input, resolveExistingDraft: true } })
  expect(response.status, await response.clone().text()).toBe(200)
  const receipt = confirmDoctorPreparationResponseSchema.parse(await response.json())
  expect(receipt.data.draftVersion).toBe(4)
  const after = await fixture.readCase()
  const state = kind === 'imaging' ? after.imagingRequests : after.pathologyRequests
  expect(state?.draft).toBeUndefined()
  expect(state?.requests).toMatchObject([{ id: receipt.data.recordIds[0], status: 'issued', service: { id: fields.serviceId } }])
})

it('keeps a physician-edited diagnosis confirmable as explicit manual input when the new generation has no agent items', async () => {
  let empty = false
  const fixture = await setup(async input => ({ content: JSON.stringify(input.schemaName === 'doctor_recommendations'
    ? empty ? { items: [], missingInformation: [] } : diagnosisOutput(input) : verificationOutput(input)), model: input.model }))
  await fixture.generate()
  await fixture.runtime.dispatchPending()
  expect((await fixture.read()).items).toHaveLength(1)
  empty = true
  await fixture.generate('diagnosis', true)
  await fixture.runtime.dispatchPending()
  const next = await fixture.read()
  expect(next).toMatchObject({ generation: 2, status: 'missing-evidence', items: [] })
  const result = await confirmPreparation(fixture, 'diagnosis', preparationBody(next, [{
    kind: 'diagnosis', source: 'manual', catalogItemId: 'diagnosis-hypertension', role: 'primary', note: '医生核对后保留。',
  }]))
  expect(result.status, await result.clone().text()).toBe(200)
  expect((await fixture.readCase()).diagnosis?.confirmation?.entries[0]).toMatchObject({ note: '医生核对后保留。' })
})

it('requires the model to propose the diagnosis role rather than inventing one from list position', async () => {
  const fixture = await setup(async input => {
    const output = input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input)
    return { content: JSON.stringify({ ...output, items: output.items.map(item => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'role'))) }), model: input.model }
  })
  await fixture.generate()
  await fixture.runtime.dispatchPending()
  expect(await fixture.read()).toMatchObject({ status: 'failed', errorCode: 'AI_RESPONSE_INVALID', items: [] })
})

it('issues a prepared prescription through the existing diagnosis, dose and product validators without a separate draft', async () => {
  const fixture = await setup(async input => {
    const kind = z.object({ kind: z.string().optional() }).parse(input.userPayload).kind
    const output = input.schemaName === 'doctor_recommendations'
      ? kind === 'prescription' ? prescriptionOutput(input) : diagnosisOutput(input)
      : { items: verificationOutput(input).items.map(item => ({ ...item, prescriptionFields: {
        doseText: true, frequencyCode: true, courseDays: true, quantity: true,
      } })) }
    return { model: input.model, content: JSON.stringify(output) }
  })
  await fixture.generate()
  await fixture.runtime.dispatchPending()
  const diagnosis = await fixture.read()
  expect((await confirmPreparation(fixture, 'diagnosis', preparationBody(diagnosis, [{ kind: 'diagnosis', source: 'agent',
    suggestionId: diagnosis.items[0]!.id, catalogItemId: 'diagnosis-hypertension', role: 'primary' }]))).status).toBe(200)
  await fixture.generate('prescription')
  await fixture.runtime.dispatchPending()
  const prepared = await fixture.read('prescription')
  expect(prepared).toMatchObject({ status: 'ready', items: [expect.objectContaining({ doseText: '5 mg', courseDays: 30, quantity: 30 })] })
  const selection = { kind: 'prescription', source: 'agent', suggestionId: prepared.items[0]!.id,
    catalogItemId: 'medication-amlodipine', doseText: '5 mg', frequencyCode: 'QD', courseDays: 30, quantity: 30 }
  const before = await fixture.readCase()
  const incomplete = await confirmPreparation(fixture, 'prescription', preparationBody(prepared, [{ ...selection, doseText: null }]))
  expect(incomplete.status).toBe(400)
  const invalid = await confirmPreparation(fixture, 'prescription', preparationBody(prepared, [{ ...selection, doseText: 'unsupported dose' }]))
  expect(invalid.status, await invalid.clone().text()).toBe(409)
  expect(await fixture.readCase()).toEqual(before)
  const body = preparationBody(prepared, [selection])
  const key = randomUUID()
  const issued = await confirmPreparation(fixture, 'prescription', body, key)
  expect(issued.status, await issued.clone().text()).toBe(200)
  const receipt = confirmDoctorPreparationResponseSchema.parse(await issued.json())
  expect(receipt).toMatchObject({ data: { kind: 'prescription', draftVersion: 2, recordIds: [expect.any(String)] } })
  expect((await fixture.readCase()).medicationConclusion?.prescription).toMatchObject({ status: 'signed',
    items: [{ catalogItemId: 'medication-amlodipine', doseText: '5 mg', frequencyCode: 'QD', courseDays: 30, quantity: 30 }] })
  expect(confirmDoctorPreparationResponseSchema.parse(await (await confirmPreparation(fixture, 'prescription', body, key)).json())).toEqual(receipt)
})

it('rejects prepared diagnosis confirmation when a report is published after the last recommendation GET', async () => {
  let entered!: () => void
  let release!: () => void
  const reportStarted = new Promise<void>(resolve => { entered = resolve })
  const reportHeld = new Promise<void>(resolve => { release = resolve })
  const fixture = await setup(async input => {
    if (input.schemaName === 'investigation_service_result') {
      entered()
      await reportHeld
      return { model: input.model, content: JSON.stringify({ conclusion: '合成生化指标升高。', results: [{
        code: 'SYN-LAB', interpretation: 'high', referenceRange: { low: 0, high: 10, text: '0–10' },
        unit: { code: 'mg/L', display: 'mg/L', system: 'http://unitsofmeasure.org' }, value: 12,
      }] }) }
    }
    return { model: input.model, content: JSON.stringify(input.schemaName === 'doctor_recommendations'
      ? diagnosisOutput(input) : verificationOutput(input)) }
  })
  installPreparationLaboratory(fixture, 'lab-report-race')
  const initial = await fixture.read()
  const headers = { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json' }
  const saved = await fixture.runtime.app.request(`/api/his/v1/encounters/${initial.encounterId}/laboratory-request/draft`, {
    method: 'PUT', headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: { [`Encounter/${initial.encounterId}`]: initial.encounterVersion }, input: {
      catalogItemId: 'lab-report-race', indicationCode: 'clinical-evaluation', expectedDraftVersion: 0,
    } }),
  })
  expect(saved.status).toBe(200)
  const issued = await fixture.runtime.app.request(`/api/his/v1/encounters/${initial.encounterId}/laboratory-request/actions/issue`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: { [`Encounter/${initial.encounterId}`]: initial.encounterVersion }, input: { expectedDraftVersion: 1 } }),
  })
  expect(issued.status).toBe(200)
  const reporting = fixture.runtime.dispatchPending()
  try {
    await reportStarted
    expect((await fixture.generate()).status).toBe(200)
    for (let step = 0; step < 10 && (await fixture.read()).status === 'pending'; step += 1) await fixture.runtime.dispatcher.dispatchOnce()
    const prepared = await fixture.read()
    expect(prepared.status).toBe('ready')
    const body = preparationBody(prepared, [{ kind: 'diagnosis', source: 'agent', suggestionId: prepared.items[0]!.id,
      catalogItemId: 'diagnosis-hypertension', role: 'primary' }])
    release()
    await reporting
    const latest = await fixture.readCase()
    expect(latest.encounter.versionId).toBe(prepared.encounterVersion)
    expect(latest.laboratoryRequests?.requests[0]?.report).toMatchObject({ conclusion: '合成生化指标升高。' })
    const rejected = await confirmPreparation(fixture, 'diagnosis', body)
    expect(rejected.status, await rejected.clone().text()).toBe(409)
    expect((await fixture.readCase()).diagnosis).toEqual(latest.diagnosis)
  } finally { release(); await reporting }
})

it('confirms prepared imaging through its actual offering and returns the formal request identity', async () => {
  const fixture = await setup(async input => {
    if (input.schemaName === 'doctor_recommendation_verification') return { model: input.model, content: JSON.stringify(verificationOutput(input)) }
    const { catalogItemId: _catalogItemId, ...base } = diagnosisOutput(input).items[0]!
    return { model: input.model, content: JSON.stringify({ items: [{ ...base, kind: 'imaging', serviceId: 'imaging-chest-ct-plain',
      indication: '核对当前病例的适用检查范围。' }], missingInformation: [] }) }
  })
  await installSyntheticImagingAssets({ assetDirectory: join(fixture.directory, 'imaging-assets'),
    catalogDirectory: join(fixture.directory, 'imaging-catalog'), assets: [{ assetId: 'synthetic-ct', examCode: 'chest-ct-plain' }] })
  await fixture.generate('imaging')
  await fixture.runtime.dispatchPending()
  const state = await fixture.read('imaging')
  expect(state.status).toBe('ready')
  const response = await confirmPreparation(fixture, 'imaging', preparationBody(state, [{ kind: 'imaging', source: 'agent',
    suggestionId: state.items[0]!.id, serviceId: 'imaging-chest-ct-plain', indication: '核对当前病例的适用检查范围。' }]))
  expect(response.status, await response.clone().text()).toBe(200)
  const receipt = confirmDoctorPreparationResponseSchema.parse(await response.json())
  expect((await fixture.readCase()).imagingRequests?.requests[0]).toMatchObject({ id: receipt.data.recordIds[0],
    status: 'issued', service: { id: 'imaging-chest-ct-plain' } })
})

it.each([false, true])('preserves an existing physician diagnosis draft until explicit selections or resolution (%s)', async resolveExistingDraft => {
  const fixture = await setup(async input => ({ model: input.model, content: JSON.stringify(
    input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input),
  ) }))
  const initial = await fixture.read()
  const saved = await fixture.runtime.app.request(`/api/his/v1/encounters/${initial.encounterId}/diagnosis/draft`, {
    method: 'PUT', headers: { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: { [`Encounter/${initial.encounterId}`]: initial.encounterVersion }, input: {
      expectedDraftVersion: 0, entries: [{ catalogItemId: 'diagnosis-fever', role: 'primary', note: '医生手写的待核对备注。' }],
    } }),
  })
  expect(saved.status).toBe(200)
  await fixture.generate()
  await fixture.runtime.dispatchPending()
  const prepared = await fixture.read()
  const before = await fixture.readCase()
  const automatic = { kind: 'diagnosis', source: 'agent', suggestionId: prepared.items[0]!.id,
    catalogItemId: 'diagnosis-hypertension', role: 'primary' }
  const blocked = await confirmPreparation(fixture, 'diagnosis', preparationBody(prepared, [automatic], 1))
  expect(blocked.status, await blocked.clone().text()).toBe(409)
  expect(await fixture.readCase()).toEqual(before)
  const selections = resolveExistingDraft ? [automatic] : [
    { ...automatic, role: 'secondary' }, { kind: 'diagnosis', source: 'manual', catalogItemId: 'diagnosis-fever',
      role: 'primary', note: '医生手写的待核对备注。' },
  ]
  const body = preparationBody(prepared, selections, 1)
  const stale = await confirmPreparation(fixture, 'diagnosis', { ...body, input: { ...body.input, expectedDraftVersion: 42, resolveExistingDraft: true } })
  expect(stale.status).toBe(409)
  expect(await fixture.readCase()).toEqual(before)
  const confirmed = await confirmPreparation(fixture, 'diagnosis', { ...body, input: { ...body.input, resolveExistingDraft } })
  expect(confirmed.status, await confirmed.clone().text()).toBe(200)
  expect((await fixture.readCase()).diagnosis?.confirmation?.entries).toMatchObject(resolveExistingDraft ? [
    { catalogItemId: 'diagnosis-hypertension', role: 'primary' },
  ] : [
    { catalogItemId: 'diagnosis-hypertension', role: 'secondary' },
    { catalogItemId: 'diagnosis-fever', role: 'primary', note: '医生手写的待核对备注。' },
  ])
})


const preparationReferenceProduct = { approvalNumber: '合成批准文号', brandName: null, code: 'SYNTHETIC-AMLODIPINE', dosageForm: '片剂',
  genericName: '合成苯磺酸氨氯地平片', id: 'reference-amlodipine', manufacturer: '合成药厂', packageDescription: '30片/盒',
  sourceLocator: 'synthetic:medications[0]', status: 'active', strength: '5mg', system: 'https://example.org/synthetic-medications', version: 'synthetic-2026' }

async function installPreparationReferenceDiagnoses(directory: string) {
  const artifact = JSON.stringify({ schemaVersion: '1', concepts: [{
    id: 'reference-hypertension', code: 'I10', display: '参考原发性高血压', domain: 'diagnosis', status: 'active',
    system: 'https://example.org/synthetic-icd10', version: 'synthetic-2026', sourceLocator: 'synthetic:diagnoses[0]',
  }], medicationProducts: [preparationReferenceProduct], services: [], valueSetEntries: [] })
  const manifest = { createdAt: '2026-08-28T00:00:00.000Z', releaseId: 'synthetic-preparation-reference', schemaVersion: '1', sources: [{
    acquisitionMethod: 'generated', artifactPath: 'diagnoses.json', checksum: createHash('sha256').update(artifact).digest('hex'),
    licenseId: 'CC0-1.0', retrievedAt: '2026-08-28T00:00:00.000Z', sourceId: 'synthetic-preparation-diagnoses',
    sourceUrl: 'https://example.org/synthetic-icd10', upstreamVersion: 'synthetic-2026',
  }] }
  await writeFile(join(directory, 'diagnoses.json'), artifact)
  await writeFile(join(directory, 'diagnoses-release.json'), JSON.stringify(manifest))
  const path = join(directory, 'reference.sqlite')
  await runReferenceDatabaseCli(['migrate', '--database', path])
  await runReferenceDatabaseCli(['import', '--database', path, '--manifest', join(directory, 'diagnoses-release.json')])
  return path
}

it('re-resolves the real Reference medication rather than trusting a client product snapshot during manual issuance', async () => {
  const fixture = await setup(undefined, { referenceDiagnoses: true })
  const catalog = await fixture.runtime.app.request('/api/his/v1/reference-catalogs/medications?query=合成苯磺酸氨氯地平片&pageSize=20', { headers: { cookie: fixture.cookie } })
  expect(catalog.status).toBe(200)
  expect(await catalog.json()).toMatchObject({ items: [preparationReferenceProduct] })
  const clinical = await fixture.readCase()
  const diagnosis = await confirmPreparation(fixture, 'diagnosis', {
    expectedVersions: { [`Encounter/${clinical.encounter.id}`]: clinical.encounter.versionId }, input: { expectedDraftVersion: 0,
      selections: [{ kind: 'diagnosis', source: 'manual', catalogItemId: 'reference-hypertension', role: 'primary' }],
    },
  })
  expect(diagnosis.status, await diagnosis.clone().text()).toBe(200)
  const current = await fixture.readCase()
  const selection = { kind: 'prescription', source: 'manual', catalogItemId: preparationReferenceProduct.id,
    doseText: '5 mg', frequencyCode: 'QD', courseDays: 30, quantity: 30,
    referenceProduct: { ...preparationReferenceProduct, id: 'fabricated-product', genericName: '伪造药品', strength: '500mg', packageDescription: '999片/盒',
      dosageForm: '伪造剂型', manufacturer: '伪造厂商' },
  }
  const expectedVersions = { [`Encounter/${current.encounter.id}`]: current.encounter.versionId }
  const invalid = await confirmPreparation(fixture, 'prescription', { expectedVersions, input: { expectedDraftVersion: 0,
    selections: [{ ...selection, catalogItemId: 'fabricated-product' }],
  } })
  expect(invalid.status, await invalid.clone().text()).toBe(409)
  expect(await fixture.readCase()).toEqual(current)
  const issued = await confirmPreparation(fixture, 'prescription', { expectedVersions, input: { expectedDraftVersion: 0, selections: [selection] } })
  expect(issued.status, await issued.clone().text()).toBe(200)
  const item = (await fixture.readCase()).medicationConclusion?.prescription?.items[0]
  expect(item).toMatchObject({ catalogItemId: preparationReferenceProduct.id, display: preparationReferenceProduct.genericName })
  const request = z.object({ medication: z.object({ reference: z.object({ reference: z.string() }) }) }).parse(await (await fixture.runtime.app.request(
    `/fhir/R5/MedicationRequest/${item!.medicationRequestId}`, { headers: { cookie: fixture.cookie } },
  )).json())
  const medication = await fixture.runtime.app.request(`/fhir/R5/${request.medication.reference.reference}`, { headers: { cookie: fixture.cookie } })
  expect(medication.status).toBe(200)
  expect(await medication.json()).toMatchObject({ code: { coding: [{ code: preparationReferenceProduct.code, display: preparationReferenceProduct.genericName }] },
    doseForm: { text: preparationReferenceProduct.dosageForm }, marketingAuthorizationHolder: { display: preparationReferenceProduct.manufacturer },
  })
})

it.each(['agent', 'manual'] as const)('confirms a real Reference diagnosis from explicit %s selection and rejects a mismatched coding snapshot', async source => {
  const fixture = await setup(async input => {
    const output = input.schemaName === 'doctor_recommendations' ? diagnosisOutput(input) : verificationOutput(input)
    return { model: input.model, content: JSON.stringify(input.schemaName !== 'doctor_recommendations' ? output : {
      ...output, items: output.items.map(item => ({ ...item, catalogItemId: 'reference-hypertension' })),
    }) }
  }, { referenceDiagnoses: true })
  await fixture.generate()
  await fixture.runtime.dispatchPending()
  const prepared = await fixture.read()
  expect(prepared).toMatchObject({ status: 'ready', items: [expect.objectContaining({
    catalogItemId: 'reference-hypertension', referenceConcept: expect.objectContaining({ code: 'I10', version: 'synthetic-2026' }),
  })] })
  const item = prepared.items[0]!
  if (item.kind !== 'diagnosis' || item.referenceConcept === undefined) throw new Error('Missing actual Reference diagnosis')
  const selection = { kind: 'diagnosis', source, catalogItemId: item.catalogItemId, role: 'primary',
    ...(source === 'agent' ? { suggestionId: item.id } : {}), referenceConcept: item.referenceConcept }
  const before = await fixture.readCase()
  const bad = await confirmPreparation(fixture, 'diagnosis', preparationBody(prepared, [{ ...selection,
    referenceConcept: { ...item.referenceConcept, code: 'fabricated-coding' },
  }]))
  expect(bad.status, await bad.clone().text()).toBe(409)
  expect(await fixture.readCase()).toEqual(before)
  const confirmed = await confirmPreparation(fixture, 'diagnosis', preparationBody(prepared, [{
    ...selection, ...(source === 'agent' ? { referenceConcept: undefined } : {}),
  }]))
  expect(confirmed.status, await confirmed.clone().text()).toBe(200)
  const confirmedEntry = (await fixture.readCase()).diagnosis?.confirmation?.entries[0]
  expect(confirmedEntry).toMatchObject({ catalogItemId: 'reference-hypertension', code: 'I10', display: '参考原发性高血压',
    system: 'https://example.org/synthetic-icd10' })
  if (confirmedEntry === undefined) throw new Error('Missing confirmed Reference diagnosis')
  const resource = await fixture.runtime.app.request(`/fhir/R5/Condition/${confirmedEntry.conditionId}`, { headers: { cookie: fixture.cookie } })
  expect(resource.status).toBe(200)
  const condition = z.object({ code: z.object({ coding: z.array(z.object({ code: z.string(), display: z.string(), system: z.string() })) }) }).parse(await resource.json())
  expect(condition.code.coding).toContainEqual({ code: 'I10', display: '参考原发性高血压', system: 'https://example.org/synthetic-icd10' })
})

it.each([false, true])('preserves an existing physician prescription draft until explicit selections or resolution (%s)', async resolveExistingDraft => {
  const fixture = await setup(async input => {
    const kind = z.object({ kind: z.string().optional() }).parse(input.userPayload).kind
    const output = input.schemaName === 'doctor_recommendations'
      ? kind === 'prescription' ? prescriptionOutput(input) : diagnosisOutput(input)
      : { items: verificationOutput(input).items.map(item => ({ ...item, prescriptionFields: {
        doseText: true, frequencyCode: true, courseDays: true, quantity: true,
      } })) }
    return { model: input.model, content: JSON.stringify(output) }
  })
  await fixture.generate()
  await fixture.runtime.dispatchPending()
  const diagnosis = await fixture.read()
  expect((await confirmPreparation(fixture, 'diagnosis', preparationBody(diagnosis, [{ kind: 'diagnosis', source: 'agent',
    suggestionId: diagnosis.items[0]!.id, catalogItemId: 'diagnosis-hypertension', role: 'primary' }]))).status).toBe(200)
  const clinical = await fixture.readCase()
  const prescription = { catalogItemId: 'medication-amlodipine', doseText: '5 mg', frequencyCode: 'QD', courseDays: 30, quantity: 30 }
  const saved = await fixture.runtime.app.request(`/api/his/v1/encounters/${diagnosis.encounterId}/prescription/draft`, {
    method: 'PUT', headers: { cookie: fixture.cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: { [`Encounter/${diagnosis.encounterId}`]: clinical.encounter.versionId }, input: {
      expectedDraftVersion: 0, items: [prescription],
    } }),
  })
  expect(saved.status, await saved.clone().text()).toBe(200)
  await fixture.generate('prescription')
  await fixture.runtime.dispatchPending()
  const prepared = await fixture.read('prescription')
  const before = await fixture.readCase()
  const automatic = { ...prescription, kind: 'prescription', source: 'agent', suggestionId: prepared.items[0]!.id }
  const blocked = await confirmPreparation(fixture, 'prescription', preparationBody(prepared, [automatic], 1))
  expect(blocked.status, await blocked.clone().text()).toBe(409)
  expect(await fixture.readCase()).toEqual(before)
  const body = preparationBody(prepared, resolveExistingDraft ? [automatic] : [{ ...prescription, kind: 'prescription', source: 'manual' }], 1)
  const stale = await confirmPreparation(fixture, 'prescription', { ...body, input: { ...body.input, expectedDraftVersion: 42, resolveExistingDraft: true } })
  expect(stale.status).toBe(409)
  expect(await fixture.readCase()).toEqual(before)
  const issued = await confirmPreparation(fixture, 'prescription', { ...body, input: { ...body.input, resolveExistingDraft } })
  expect(issued.status, await issued.clone().text()).toBe(200)
  expect((await fixture.readCase()).medicationConclusion?.prescription?.items).toMatchObject([prescription])
})
