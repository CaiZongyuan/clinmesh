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
    dshModelBridge: bridge,
    chatCompletionsProvider: new DshModelProvider({ ...bridge, fetch: async (_url, init) => {
        const input = modelBridgeRequestSchema.parse(JSON.parse(String(init?.body)))
        if (input.operation === 'resolve') return Response.json({ model: options.route?.() ?? route })
        if (input.schemaName === 'patient_persona') return Response.json({ content: JSON.stringify(persona), model: input.model })
        if (complete !== undefined) {
          const result = await complete(input)
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
