import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { DshModelProvider } from '../src/infrastructure/ai/dsh-model-provider.ts'
import { encodeModelRoute, modelBridgeRequestSchema } from '@clinmesh/contracts/model-bridge'
import { clinicalDocumentQualityControlStateSchema, doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'
import { sourceArtifactHash } from '../src/application/scenario-data/provider.ts'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })
type ModelInput = { schemaName: string; userPayload: unknown }
async function setup(complete?: (input: ModelInput) => unknown | Promise<unknown>, syntheaProvider = new StubSyntheaProvider()) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-quality-'))
  disposals.push(() => rm(directory, { recursive: true, force: true }))
  const bridge = { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 1000, maxResponseBytes: 256 * 1024 }
  const options: Parameters<typeof createClinMeshRuntime>[0] = {
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters', databasePath: join(directory, 'clinmesh.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply', outboxRetryDelayMs: 0,
    imagingAssetDirectory: join(directory, 'imaging'), imagingCatalogDirectory: join(directory, 'imaging-catalog'),
    pathologyAssetDirectory: join(directory, 'pathology'), pathologyCatalogDirectory: join(directory, 'pathology-catalog'),
    syntheaProvider, trustedOrigins: ['http://localhost'],
    dshModelBridge: bridge,
    chatCompletionsProvider: new DshModelProvider({ ...bridge, fetch: async (_url, init) => {
      const input = modelBridgeRequestSchema.parse(JSON.parse(String(init?.body)))
      if (input.operation === 'resolve') return Response.json({ model: encodeModelRoute({ provider: 'synthetic', model: 'synthetic' }) })
      const payload = input.schemaName === 'patient_persona' ? persona
        : input.schemaName === 'consultation_history_summary' ? { additions: [] }
          : input.schemaName === 'patient_dialogue_reply' ? { reply: '我头晕一周，没有胸痛。' }
            : complete === undefined ? { issues: [], agentFactChecks: [] } : await complete(input)
      return Response.json({ content: JSON.stringify(payload), model: input.model })
    } }),
  }
  let runtime = await createClinMeshRuntime(options)
  disposals.push(() => runtime.close())
  const started = await startConsultationCase(runtime)
  const cookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const headers = (key: string = randomUUID()) => ({ cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key })
  const claimed = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ expectedVersions: {
      [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1',
    }, input: {} }),
  })
  expect(claimed.status).toBe(200)
  const path = `/api/his/v1/doctor/cases/${started.outpatientCaseId}/document-quality-control`
  const readCase = async () => doctorCaseDetailSchema.parse(await (await runtime.app.request(
    `/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } })).json())
  const read = async (clientId?: string) => {
    const response = await runtime.app.request(path + (clientId === undefined ? '' : `?clientId=${clientId}`), { headers: { cookie } })
    const text = await response.text()
    expect(response.status, text).toBe(200)
    const body: unknown = JSON.parse(text)
    return clinicalDocumentQualityControlStateSchema.parse(body)
  }
  const mutate = async (action: string, input: object, key?: string) => {
    const detail = await readCase()
    return runtime.app.request(`${path}/actions/${action}`, { method: 'POST', headers: headers(key),
      body: JSON.stringify({ expectedVersions: { [`Encounter/${started.encounterId}`]: detail.encounter.versionId }, input }) })
  }
  const save = async (document: Record<string, string>, extra: object = {}) => {
    const detail = await readCase()
    return runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`, {
      method: 'PUT', headers: headers(), body: JSON.stringify({ expectedVersions: { [`Encounter/${started.encounterId}`]: detail.encounter.versionId },
        input: { document: { assessment: '', chiefComplaint: '', disposition: '', followUp: '', physicalExamination: '', historyOfPresentIllness: '', ...document },
          expectedDraftVersion: detail.clinicalDocument?.draft?.version ?? 0, ...extra } }) })
  }
  const ask = async () => {
    const detail = await readCase()
    return runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/ask-consultation-question`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ expectedVersions: {
        [`Encounter/${started.encounterId}`]: detail.encounter.versionId, [`Task/${detail.taskId}`]: detail.taskVersion,
      }, input: { expectedConsultationVersion: detail.consultation!.version, message: '现在还有哪些不舒服？' } }) })
  }
  return { get runtime() { return runtime }, started, cookie, path, headers, readCase, read, mutate, save, ask,
    restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(options) },
    restartWithoutModel: async () => {
      await runtime.close()
      const { dshModelBridge: _bridge, chatCompletionsProvider: _provider, ...withoutModel } = options
      runtime = await createClinMeshRuntime(withoutModel)
    } }
}

it('shows applicable empty template fields without requiring auxiliary tests or repeating encounter metadata', async () => {
  const f = await setup()
  const quality = await f.read()
  expect(quality.issues.filter(issue => issue.kind === 'missing-field').map(issue => issue.field)).toEqual([
    'chiefComplaint', 'historyOfPresentIllness', 'physicalExamination', 'assessment', 'disposition', 'followUp',
  ])
  expect(quality.issues.every(issue => issue.classification === 'needs-completion')).toBe(true)
  expect((await f.readCase()).clinicalDocument?.draft).toBeUndefined()
})

it('persists retained issues with audit and idempotency, and rechecks only changed relevant content', async () => {
  const f = await setup()
  expect((await f.save({ historyOfPresentIllness: '今日头晕。' }, { agentGenerated: true })).status).toBe(200)
  const state = await f.read()
  const issue = state.issues.find(issue => issue.kind === 'agent-source')!
  const key = randomUUID()
  const input = { issueId: issue.id, expectedInputFingerprint: state.inputFingerprint, reason: '已电话核实，保留当前表述。' }
  const first = await f.mutate('retain', input, key)
  expect(first.status).toBe(200)
  expect(await (await f.mutate('retain', input, key)).json()).toEqual(await first.json())
  const retained = (await f.read()).issues.find(item => item.id === issue.id)!
  const repeated = await f.mutate('retain', { ...input, reason: '重复点击不能覆盖首次核实记录。' })
  expect(repeated.status).toBe(200)
  expect(z.object({ effects: z.array(z.unknown()) }).parse(await repeated.json()).effects).toEqual([])
  expect((await f.read()).issues.find(item => item.id === issue.id)?.review).toEqual(retained.review)
  await f.restart()
  expect((await f.read()).issues.find(item => item.id === issue.id)).toMatchObject({ status: 'retained', review: { reason: input.reason } })
  expect((await f.save({ historyOfPresentIllness: '今日头晕。', chiefComplaint: '头晕一天。' })).status).toBe(200)
  expect((await f.read()).issues.find(item => item.id === issue.id)?.status).toBe('retained')
  expect((await f.save({ historyOfPresentIllness: '今日头晕加重。' }, { agentGenerated: true })).status).toBe(200)
  expect((await f.read()).issues.find(item => item.kind === 'agent-source')?.status).toBe('open')
  expect((await f.mutate('retain', input)).status).toBe(409)
})

const qualityPayloadSchema = z.object({ document: z.record(z.string(), z.string()),
  evidence: z.array(z.object({ id: z.string(), kind: z.string(), text: z.string() })),
  agentFacts: z.array(z.object({ id: z.string() })),
  issues: z.array(z.unknown()).optional() })

it('independently verifies exact source omissions and preserves time-qualified contradictions as clinician prompts', async () => {
  const f = await setup(input => {
    const payload = qualityPayloadSchema.parse(input.userPayload)
    if (input.schemaName === 'clinical_document_quality_verification') return { issues: payload.issues!.map((_, index) => ({ index, supported: true })), agentFactChecks: [] }
    const source = payload.evidence.find(item => item.kind === 'patient')!
    return { issues: [{ kind: 'omission', field: 'priorMedicalHistory', message: '当前问诊中的头晕病史可能尚未纳入正文。',
      sourceQuotes: [{ evidenceId: source.id, quote: source.text }] }], agentFactChecks: [] }
  })
  expect((await f.save({ historyOfPresentIllness: '记录待补充。' })).status).toBe(200)
  await f.runtime.dispatchPending()
  const issue = (await f.read()).issues.find(issue => issue.kind === 'omission')!
  expect(issue).toMatchObject({ field: 'priorMedicalHistory', classification: 'needs-completion', status: 'open' })
  expect(issue.evidence[0]).toMatchObject({ kind: 'patient', text: persona.openingStatement })
  const detail = await f.readCase()
  const document = { assessment: '', chiefComplaint: '', disposition: '', followUp: '', physicalExamination: '', historyOfPresentIllness: '记录待补充。' }
  expect((await f.mutate('check', { expectedDraftVersion: detail.clinicalDocument!.draft!.version, document, clientId: 'same-document', clientRevision: 1 })).status).toBe(200)
  await f.runtime.dispatchPending()
  const candidate = await f.read('same-document')
  expect((await f.mutate('retain', { issueId: issue.id, clientId: 'same-document', expectedInputFingerprint: candidate.inputFingerprint })).status).toBe(200)
  expect((await f.read()).issues.find(item => item.id === issue.id)?.status).toBe('retained')
})

it('drops a late candidate result after sources change and restores the latest queued check across restart', async () => {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let first = true
  const f = await setup(async input => {
    if (input.schemaName === 'clinical_document_quality' && first) { first = false; enter(); await held }
    return { issues: [], agentFactChecks: [] }
  })
  const document = { assessment: '', chiefComplaint: '头晕。', disposition: '', followUp: '', physicalExamination: '', historyOfPresentIllness: '' }
  expect((await f.mutate('check', { expectedDraftVersion: 0, document, clientId: 'editor', clientRevision: 1 })).status).toBe(200)
  const dispatch = f.runtime.dispatchPending()
  await entered
  try { expect((await f.ask()).status).toBe(200) } finally { release() }
  await dispatch
  expect(await f.read('editor')).toMatchObject({ stale: true, clientRevision: 1 })
  expect((await f.mutate('check', { expectedDraftVersion: (await f.readCase()).clinicalDocument?.draft?.version ?? 0, document, clientId: 'editor', clientRevision: 2 })).status).toBe(200)
  await f.restart()
  await f.runtime.dispatchPending()
  expect(await f.read('editor')).toMatchObject({ stale: false, status: 'ready', clientRevision: 2 })
})

it('keeps a semantic unsupported-Agent finding on subsequent reads and treats a negative verifier as a valid verdict', async () => {
  const calls: string[] = []
  const f = await setup(input => {
    calls.push(input.schemaName)
    const payload = qualityPayloadSchema.parse(input.userPayload)
    return { issues: [], agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: input.schemaName !== 'clinical_document_quality_verification' })) }
  })
  const source = (await f.readCase()).consultation!.turns.find(turn => turn.speaker === 'patient')!
  const statement = '患者已确诊心肌梗死。'
  expect((await f.save({ assessment: statement }, { agentGenerated: true,
    agentFacts: [{ field: 'assessment', text: statement, sources: [{ sourceTurnId: source.id, quote: source.messageText }] }] })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(await f.read()).toMatchObject({ status: 'ready', issues: expect.arrayContaining([expect.objectContaining({ kind: 'agent-source', field: 'assessment' })]) })
  expect((await f.read()).issues.find(issue => issue.kind === 'agent-source')?.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'patient', text: source.messageText })]))
  expect(calls.filter(name => name === 'clinical_document_quality_verification')).toHaveLength(1)
})

it('rejects fabricated source citations instead of publishing semantic claims', async () => {
  const f = await setup(() => ({ issues: [{ kind: 'omission', field: 'priorMedicalHistory', message: '伪造的遗漏。',
    sourceQuotes: [{ evidenceId: 'source-from-another-case', quote: '不存在的患者事实。' }] }], agentFactChecks: [] }))
  expect((await f.save({ chiefComplaint: '头晕。' })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(await f.read()).toMatchObject({ status: 'failed', errorCode: 'AI_RESPONSE_INVALID' })
  expect((await f.read()).issues.some(issue => issue.kind === 'omission')).toBe(false)
  expect((await f.read()).issues.some(issue => issue.kind === 'missing-field')).toBe(true)
})

it('summarizes pending quality before signing and does not invalidate the signing preview when quality completes', async () => {
  const f = await setup()
  expect((await f.save({ assessment: '待进一步明确。', chiefComplaint: '头晕一周。', disposition: '门诊观察。',
    followUp: '不适加重及时就诊。', physicalExamination: '医生查体无异常。', historyOfPresentIllness: '头晕一周，无胸痛。' })).status).toBe(200)
  const detail = await f.readCase()
  const request = (action: string, input: object) => f.runtime.app.request(`/api/his/v1/encounters/${f.started.encounterId}/clinical-document/actions/${action}`, {
    method: 'POST', headers: f.headers(), body: JSON.stringify({ expectedVersions: { [`Encounter/${f.started.encounterId}`]: detail.encounter.versionId }, input }) })
  const response = await request('preview-sign', { expectedDraftVersion: detail.clinicalDocument!.draft!.version })
  expect(response.status).toBe(200)
  const preview = z.object({ data: z.object({ qualityControl: clinicalDocumentQualityControlStateSchema, commitToken: z.string(), previewId: z.string() }) }).parse(await response.json()).data
  expect(preview.qualityControl).toMatchObject({ status: 'pending', draftVersion: detail.clinicalDocument!.draft!.version })
  await f.runtime.dispatchPending()
  expect((await f.read()).status).toBe('ready')
  expect((await request('sign', { previewId: preview.previewId, commitToken: preview.commitToken, consultationReviewed: true })).status).toBe(200)
  expect((await f.readCase()).clinicalDocument!.signed).toHaveLength(1)
})

it('reports excessive issue counts as incomplete and keeps the draft writable', async () => {
  const f = await setup()
  const text = Array.from({ length: 70 }, (_, index) => `第${index + 1}条合成症状。`).join('')
  expect((await f.save({ historyOfPresentIllness: text }, { agentGenerated: true })).status).toBe(200)
  const state = await f.read()
  expect(state.status).toBe('incomplete')
  expect(state.notices.join('')).toContain('前64项')
  expect(state.issues).toHaveLength(64)
  expect((await f.readCase()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(text)
})

it('keeps deterministic checks available without a configured model and leaves semantic quality explicitly unavailable', async () => {
  const f = await setup()
  await f.restartWithoutModel()
  expect((await f.save({ chiefComplaint: '头晕一天。' })).status).toBe(200)
  expect(await f.read()).toMatchObject({ status: 'unavailable', issues: expect.arrayContaining([expect.objectContaining({ field: 'assessment', kind: 'missing-field' })]) })
  expect((await f.read()).notices.join('')).toContain('语义检查尚未完成')
})

it('reports an incomplete semantic check for complete oversized visible history without sending truncated model input', async () => {
  let modelCalls = 0
  const provider = new class extends StubSyntheaProvider {
    override async generate() {
      const corpus = await super.generate()
      const raw = z.object({ entry: z.array(z.object({ resource: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough().parse(corpus.sources[0]!.raw)
      raw.entry.push(...Array.from({ length: 210 }, (_, index) => ({ fullUrl: `urn:uuid:quality-history-${index}`,
        resource: { resourceType: 'Condition', id: `quality-history-${index}`, subject: { reference: 'urn:uuid:patient' },
          encounter: { reference: 'urn:uuid:prior-encounter' }, recordedDate: '2025-01-10T09:05:00+08:00',
          code: { text: `第${index}项合成公开病史，诊断尚未明确。` } } })))
      return { ...corpus, sources: [{ ...corpus.sources[0]!, raw, hash: sourceArtifactHash(raw) }] }
    }
  }()
  const f = await setup(() => { modelCalls += 1; return { issues: [], agentFactChecks: [] } }, provider)
  expect((await f.save({ chiefComplaint: '头晕一周。' })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(await f.read()).toMatchObject({ status: 'incomplete', errorCode: 'INPUT_TOO_LARGE' })
  expect(modelCalls).toBe(0)
  expect((await f.readCase()).clinicalDocument!.draft!.chiefComplaint).toBe('头晕一周。')
})

it('rejects circular document-only omissions and duplicate statements posed as factual contradictions', async () => {
  let duplicate = false
  const f = await setup(input => {
    const payload = qualityPayloadSchema.parse(input.userPayload)
    const source = payload.evidence.find(item => item.kind === (duplicate ? 'patient' : 'document'))!
    return { issues: [{ kind: duplicate ? 'inconsistency' : 'omission', field: 'historyOfPresentIllness', message: '无效问题依据。',
      sourceQuotes: Array.from({ length: duplicate ? 2 : 1 }, () => ({ evidenceId: source.id, quote: source.text })) }], agentFactChecks: [] }
  })
  expect((await f.save({ historyOfPresentIllness: '今天头晕。' })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect((await f.read()).status).toBe('failed')
  duplicate = true
  expect((await f.mutate('check', { expectedDraftVersion: (await f.readCase()).clinicalDocument!.draft!.version, refresh: true })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect((await f.read()).status).toBe('failed')
  expect((await f.read()).issues.every(issue => issue.kind === 'missing-field')).toBe(true)
})

it('keeps old-Epoch quality results out of a reset workspace', async () => {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const f = await setup(async () => { enter(); await held; return { issues: [], agentFactChecks: [] } })
  expect((await f.save({ chiefComplaint: '头晕。' })).status).toBe(200)
  const dispatch = f.runtime.dispatchPending()
  await entered
  try {
    expect((await f.runtime.app.request('/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', {
      method: 'POST', headers: { ...f.headers(), cookie: f.started.adminCookie }, body: '{}',
    })).status).toBe(200)
  } finally { release() }
  await dispatch
  const doctorCookie = await signIn(f.runtime, 'doctor@demo.clinmesh.local')
  const response = await f.runtime.app.request(f.path, { headers: { cookie: doctorCookie } })
  expect([403, 404, 409]).toContain(response.status)
})

it('checks unsaved revisions without saving, isolates browser clients and rejects partial or older candidate identities', async () => {
  const f = await setup()
  const document = { assessment: '', chiefComplaint: '头晕一周。', disposition: '', followUp: '', physicalExamination: '', historyOfPresentIllness: '' }
  for (const identity of [{ clientId: 'editor-1' }, { clientRevision: 1 }, { document }]) {
    expect((await f.mutate('check', { expectedDraftVersion: 0, ...identity })).status).toBe(400)
  }
  expect((await f.mutate('check', { expectedDraftVersion: 0, document, clientId: 'editor-1', clientRevision: 2 })).status).toBe(200)
  expect(await f.read('editor-1')).toMatchObject({ clientId: 'editor-1', clientRevision: 2, draftVersion: 0, stale: false })
  expect((await f.read('editor-1')).issues.some(issue => issue.field === 'chiefComplaint')).toBe(false)
  expect((await f.readCase()).clinicalDocument?.draft).toBeUndefined()
  expect((await f.read()).issues.some(issue => issue.field === 'chiefComplaint')).toBe(true)
  expect((await f.runtime.app.request(`${f.path}?clientId=other-editor`, { headers: { cookie: f.cookie } })).status).toBe(409)
  expect((await f.mutate('check', { expectedDraftVersion: 0, document, clientId: 'editor-1', clientRevision: 1 })).status).toBe(409)
  await f.runtime.dispatchPending()
  expect(await f.read('editor-1')).toMatchObject({ status: 'ready', clientRevision: 2 })
})

it('attributes only Agent additions and keeps unrelated Agent fragments after a human edits another field', async () => {
  const f = await setup()
  const human = { historyOfPresentIllness: '今天头晕，无胸痛。', assessment: '待进一步明确。' }
  expect((await f.save(human)).status).toBe(200)
  expect((await f.save({ ...human, historyOfPresentIllness: '今天头晕，无胸痛。最近口渴明显。', assessment: '医生考虑脱水。' }, { agentGenerated: true })).status).toBe(200)
  const generated = (await f.read()).issues.filter(issue => issue.kind === 'agent-source')
  expect(generated.flatMap(issue => issue.evidence.map(item => item.text))).toEqual(expect.arrayContaining(['最近口渴明显。', '医生考虑脱水。']))
  expect(generated.some(issue => issue.evidence.some(item => item.text.includes('今天头晕')))).toBe(false)
  expect((await f.save({ historyOfPresentIllness: '今天头晕，无胸痛。最近口渴明显。', assessment: '医生核实考虑低血压。' })).status).toBe(200)
  expect((await f.read()).issues.filter(issue => issue.kind === 'agent-source').map(issue => issue.field)).toEqual(['historyOfPresentIllness'])
  await f.restart()
  expect((await f.read()).issues.filter(issue => issue.kind === 'agent-source').map(issue => issue.field)).toEqual(['historyOfPresentIllness'])
})
