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
    generationBytes = Buffer.byteLength(JSON.stringify(input.userPayload))
    const payload = z.object({ catalogs: z.object({ laboratory: z.object({ items: z.array(z.object({ id: z.string() }).passthrough()) }) }) }).parse(input.userPayload)
    expect(payload.catalogs.laboratory.items).toHaveLength(100)
    expect(payload.catalogs.laboratory.items.find(item => item.id === 'lab-00')).not.toHaveProperty('minimumAgeYears')
    expect(payload.catalogs.laboratory.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'lab-98', nameZh: '同名合成组合', specimen: { code: 'blood', display: '静脉血' } }),
      expect.objectContaining({ id: 'lab-99', nameZh: '同名合成组合', specimen: { code: 'urine', display: '尿液' },
        referenceConcept: { id: 'reference:lab-99', code: 'SYN-LAB', display: '合成生化指标', system: 'urn:synthetic:laboratory', version: '1' },
        allowedIndicationCodes: ['clinical-evaluation'], componentServiceIds: ['leaf-quantity', 'leaf-qualitative'], minimumAgeYears: 18,
        sourceDataset: { datasetId: 'laboratory-cn' }, standardStatus: { mode: 'future-standard-preview', standard: 'WS/T 886-2026', effectiveOn: '2026-11-01' },
        reportDefinition: { results: [
          expect.objectContaining({ referenceConcept: expect.objectContaining({ code: 'SYN-PANEL-QUANTITY' }),
            alternateCodings: [{ code: 'synthetic-loinc', system: 'http://loinc.org', version: 'synthetic-1' }],
            valueType: 'quantity', unit: { code: 'mg/L', display: 'mg/L', system: 'http://unitsofmeasure.org' },
            referenceRange: { low: 0, high: 10, text: '0–10' },
            adultReferenceRules: [{ low: 0, high: 10, notes: '限成年男性', referenceKind: 'range', sex: 'male' }] }),
          expect.objectContaining({ referenceConcept: expect.objectContaining({ code: 'SYN-PANEL-QUALITATIVE' }), valueType: 'string',
            allowedValues: ['阴性', '阳性'], adultReferenceRules: [{ normalValue: '阴性', notes: '限成年女性', referenceKind: 'coded', sex: 'female' }] }),
        ] },
      }),
    ]))
    expect(JSON.stringify(payload.catalogs)).not.toMatch(/conclusionTemplate|priceFen|executingDepartmentId|tatMinutes|healthyStrategy|precision|simulationLow|simulationHigh|sourceLocator|sourceLocation|sourceStandard|referenceReleaseId/)
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
  expect(requests).toEqual(['doctor_recommendations', 'doctor_recommendation_verification'])
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
  let selectedEvidence: unknown[] = []
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
      const payload = z.object({ caseEvidence: z.array(z.unknown()), catalogs: z.object({ laboratory: z.object({ items: z.array(z.object({
        id: z.string(), minimumAgeYears: z.literal(18), reportDefinition: z.object({ results: z.array(z.object({
          unit: z.object({ code: z.literal('mg/L') }), adultReferenceRules: z.array(z.object({ sex: z.literal('all'), notes: z.string().min(1) })),
        })) }),
      })) }) }) }).parse(input.userPayload)
      if (selectedEvidence.length === 0) selectedEvidence = payload.caseEvidence
      expect(payload.caseEvidence).toEqual(selectedEvidence)
      for (const item of payload.catalogs.laboratory.items) expect(item.reportDefinition.results).toHaveLength(4)
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
    expect(input.userPayload).toMatchObject({ caseEvidence: selectedEvidence,
      catalogs: { laboratory: { items: [{ id: 'clinical-lab-99' }] } } })
    const output = diagnosisOutput(input)
    return { content: JSON.stringify({ ...output, items: [{ ...output.items[0], kind: 'laboratory',
      catalogItemId: 'clinical-lab-99', indicationCode: 'clinical-evaluation' }] }), model: input.model }
  }, { syntheaProvider: largeRecommendationHistory() })
  await installLargeClinicalRecommendationCatalog(fixture)
  const before = await fixture.readCase()
  expect((await fixture.generate('laboratory')).status).toBe(200)
  await fixture.runtime.dispatchPending()
  expect(await fixture.read('laboratory')).toMatchObject({ status: 'ready', items: [{ kind: 'laboratory', catalogItemId: 'clinical-lab-99' }] })
  expect(reviewed.toSorted()).toEqual(Array.from({ length: 100 }, (_, index) => `clinical-lab-${String(index).padStart(2, '0')}`))
  for (const batch of batchSchemas) expect(batch.schema).toMatchObject({ properties: {
    selectedCatalogItemIds: { items: { enum: batch.ids } },
  } })
  expect(projectedCatalogBytes).toBeGreaterThan(240 * 1024)
  expect(peak).toBe(2)
  const calls = requests.filter(name => name === 'doctor_recommendation_catalog_selection').length
  expect(calls).toBe(3)
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
})

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
      if (input.schemaName === pausedSchema && paused < 2) {
        paused += 1
        if (paused === 2) entered()
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
    expect(requests.filter(name => name === pausedSchema)).toHaveLength(2)
    expect(requests).not.toContain('doctor_recommendations')
    await fixture.runtime.dispatchPending()
    expect(await fixture.read('laboratory')).toMatchObject({ generation: 2, status: 'ready', items: [{ catalogItemId: 'clinical-lab-99' }] })
    expect(requests.filter(name => name === 'doctor_recommendations')).toHaveLength(1)
  },
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
  const fixture = await setup(async input => ({ content: JSON.stringify({ items: [], missingInformation: [] }), model: input.model }), { syntheaProvider })
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

it('independently checks read-only case reasoning when the public case has no acquired guideline', async () => {
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
  const fixture = await setup(async input => {
    requests.push(input.schemaName)
    const payload = z.object({ guidelines: z.array(z.unknown()), caseEvidence: z.array(z.object({ id: z.string(), kind: z.string() }).passthrough()),
      considerations: z.array(z.object({ id: z.string() })).optional() }).parse(input.userPayload)
    expect(payload.guidelines).toEqual([])
    if (input.schemaName === 'doctor_recommendations') {
      suppliedEvidence = payload.caseEvidence
      const evidence = payload.caseEvidence.find(item => item.kind === 'presentation')!
      return { model: input.model, content: JSON.stringify({ items: [], considerations: [{
        id: 'synthetic-dizziness-consideration', label: '核对头晕的症状演变', rationale: '结合当前主诉提出待核实方向，不作确诊。',
        supportingInformation: ['当前主诉包含头晕。'], opposingInformation: [],
        missingInformation: ['补问是否出现新的伴随表现，以决定后续评估方向。'], caseEvidenceIds: [evidence.id],
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
  expect(await fixture.read()).toMatchObject({ status: 'ready', guidelines: [], items: [],
    considerations: [expect.objectContaining({ id: 'synthetic-dizziness-consideration' })],
    notices: [expect.objectContaining({ category: 'guideline' })] })
  expect(requests).toEqual(['doctor_recommendations', 'doctor_recommendation_verification'])
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
