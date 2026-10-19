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
import { agentCapabilityGrantSchema, agentClientSchema } from '@clinmesh/contracts/agent'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'
import { sourceArtifactHash } from '../src/application/scenario-data/provider.ts'
import type { SqlitePerformanceObserver } from '../src/infrastructure/sqlite/performance-observer.ts'
import { canonicalJsonHash } from '../src/application/scenario-data/canonical-json.ts'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })
type ModelInput = { schemaName: string; userPayload: unknown; systemPrompt: string }
async function setup(complete?: (input: ModelInput) => unknown | Promise<unknown>, syntheaProvider = new StubSyntheaProvider(),
  reply = '我头晕一周，没有胸痛。', now?: () => Date, performanceObserver?: SqlitePerformanceObserver) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-quality-'))
  disposals.push(() => rm(directory, { recursive: true, force: true }))
  const bridge = { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 1000, maxResponseBytes: 256 * 1024 }
  const options: Parameters<typeof createClinMeshRuntime>[0] = {
    ...(now === undefined ? {} : { now }),
    ...(performanceObserver === undefined ? {} : { performanceObserver }),
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
          : input.schemaName === 'patient_dialogue_reply' ? { reply }
            : complete === undefined ? { issues: [], agentFactChecks: [] } : await complete(input)
      if (payload instanceof Response) return payload
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
  expect(quality.issues.find(issue => issue.field === 'physicalExamination')).toMatchObject({
    message: '体格检查尚未记录。',
    explanation: {
      impact: '当前正文未说明本次实际完成的查体及其结果。',
      suggestion: '记录实际完成的查体和结果；尚未查体可如实注明，不为补齐字段安排检查或补写正常。',
    },
  })
  expect((await f.readCase()).clinicalDocument?.draft).toBeUndefined()
})

it('checks current consultation without loading 596 visible history resources into real-time quality', async () => {
  const provider = new class extends StubSyntheaProvider {
    override async generate() {
      const corpus = await super.generate()
      const source = corpus.sources[0]!
      const raw = z.object({ entry: z.array(z.unknown()) }).passthrough().parse(source.raw)
      raw.entry.push(...Array.from({ length: 596 }, (_, index) => ({ fullUrl: `urn:uuid:quality-observation-${index}`,
        resource: { resourceType: 'Observation', id: `quality-observation-${index}`, status: 'final',
          subject: { reference: 'urn:uuid:patient' }, encounter: { reference: 'urn:uuid:prior-encounter' },
          effectiveDateTime: '2024-01-10T09:05:00+08:00', code: { text: `合成历史观察${index}` },
          valueQuantity: { value: index / 100, unit: 'mmol/L' },
          extension: [{ url: 'https://untrusted.invalid', valueString: 'private-extension' }] },
      })))
      return { ...corpus, sources: [{ ...source, raw, hash: sourceArtifactHash(raw) }] }
    }
  }()
  let statements = 0
  let modelInput: unknown
  const f = await setup(input => {
    modelInput = input.userPayload
    return { issues: [], agentFactChecks: [] }
  }, provider, undefined, undefined, {
    observeStatement: () => { statements += 1 }, observeTransaction: () => {},
  })
  statements = 0
  const detail = await f.readCase()
  expect(detail.qualityControl?.caseId).toBe(f.started.outpatientCaseId)
  expect(statements).toBeLessThan(200)
  statements = 0
  const quality = await f.read()
  expect(quality.inputFingerprint).toBe(detail.qualityControl?.inputFingerprint)
  expect(statements).toBeLessThan(200)

  expect((await f.mutate('check', { expectedDraftVersion: 0 })).status).toBe(200)
  const row = z.object({ input_json: z.string() }).parse(f.runtime.database.driver.prepare(`
    SELECT input_json FROM clinical_document_quality WHERE case_id = ? AND scope_key = 'saved'
  `).get(f.started.outpatientCaseId))
  const input = z.object({ evidence: z.array(z.object({ id: z.string(), text: z.string() })) }).parse(JSON.parse(row.input_json))
  expect(input.evidence.some(item => item.id.startsWith('history:'))).toBe(false)
  expect(input.evidence).toContainEqual(expect.objectContaining({ text: persona.openingStatement }))
  expect(Buffer.byteLength(row.input_json)).toBeLessThan(16 * 1024)
  expect(row.input_json).not.toMatch(/private-extension|untrusted\.invalid|2 型糖尿病/)
  await f.runtime.dispatchPending()
  expect((await f.read()).status).toBe('ready')
  expect(modelInput).toMatchObject({ evidence: expect.arrayContaining([expect.objectContaining({ kind: 'patient', text: persona.openingStatement })]) })
  expect((await f.read()).notices.join('')).toContain('不自动读取既往病历全文')
})

it('persists retained issues with audit and idempotency, and rechecks only changed relevant content', async () => {
  const f = await setup()
  expect((await f.save({ historyOfPresentIllness: '今日头晕。' }, { agentGenerated: true })).status).toBe(200)
  const state = await f.read()
  const issue = state.issues.find(issue => issue.kind === 'agent-source')!
  expect(issue).toMatchObject({ message: '现病史中的 Agent 新增片段尚无可核对的已保存来源。', explanation: {
    impact: '系统暂不能从已保存来源核验该片段，不据此断言患者事实错误。',
    suggestion: '核对下方原文；内容属实可补充真实来源或核实后保留，表述不准确则修改正文。',
  } })
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

const recordingQualityPayloadSchema = qualityPayloadSchema.extend({ recordingContext: z.object({
  changes: z.array(z.object({ id: z.string(), field: z.string(), relation: z.string(),
    before: z.object({ text: z.string() }).optional(), after: z.object({ text: z.string() }), newSourceIds: z.array(z.string()),
    rejectedFacts: z.array(z.object({ text: z.string(), sources: z.array(z.object({ sourceTurnId: z.string(), quote: z.string() })) })) })),
  rejectedFacts: z.array(z.object({ text: z.string() })),
}) })

// Historical data is seeded at the durable boundary; assertions use the public
// quality endpoint and the external model boundary, never private quality methods.
async function seedRecordingChange(f: Awaited<ReturnType<typeof setup>>, options: {
  relation?: 'update' | 'correction' | 'conflict'; after?: string; before?: string; rejected?: string;
  field?: 'historyOfPresentIllness' | 'chiefComplaint';
} = {}) {
  expect((await f.ask()).status).toBe(200)
  await f.runtime.dispatchPending()
  const before = options.before ?? '头晕一周；无胸痛'
  const after = options.after ?? '站起时头晕加重'
  const field = options.field ?? 'historyOfPresentIllness'
  const { version: _version, updatedAt: _updatedAt, ...saved } = (await f.readCase()).clinicalDocument?.draft ?? { version: 0, updatedAt: '' }
  expect((await f.save({ ...saved, [field]: after })).status).toBe(200)
  await f.runtime.dispatchPending()
  const detail = await f.readCase()
  const sources = detail.consultationRecording!.sources!
  const prior = sources[0]!, latest = sources.at(-1)!
  const scope = z.object({ workspace_id: z.string(), epoch: z.string() }).parse(f.runtime.database.driver.prepare(
    'SELECT workspace_id, epoch FROM outpatient_case WHERE case_id = ?').get(f.started.outpatientCaseId))
  const source = (text: string, id = prior.id, quote = prior.messageText) => ({ text, sources: [{ sourceTurnId: id, quote }] })
  const oldFacts = before.split('；').map(text => source(text))
  const newFacts = [source(after, latest.id, latest.messageText)]
  const batchId = randomUUID(), additionId = randomUUID(), targetId = randomUUID()
  const batch = { members: [{ id: latest.id, generation: 1 }], sources,
    baseline: { version: 1, content: { assessment: '', chiefComplaint: '', disposition: '', followUp: '', physicalExamination: '', historyOfPresentIllness: '', [field]: before } },
    history: [{ id: targetId, field, text: before, facts: oldFacts, quote: prior.messageText, sourceTurnId: prior.id }],
    manualHistory: [], rejectedFacts: options.rejected === undefined ? [] : [{ ...source(options.rejected), field }] }
  f.runtime.database.driver.prepare(`INSERT INTO consultation_recording_batch
    (workspace_id, epoch, case_id, batch_id, snapshot_json, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(scope.workspace_id, scope.epoch, f.started.outpatientCaseId, batchId, JSON.stringify(batch), '2026-10-19T00:00:00Z', '2026-10-19T00:00:01Z')
  f.runtime.database.driver.prepare(`INSERT INTO consultation_history_addition
    (workspace_id, epoch, case_id, addition_id, source_turn_id, field, quote, relation, status,
      current_text, facts_json, review_state) VALUES (?, ?, ?, ?, ?, ?, ?, 'addition', 'applied', ?, ?, 'superseded')`)
    .run(scope.workspace_id, scope.epoch, f.started.outpatientCaseId, targetId, prior.id, field, prior.messageText, before, JSON.stringify(oldFacts))
  f.runtime.database.driver.prepare(`INSERT INTO consultation_history_addition
    (workspace_id, epoch, case_id, addition_id, source_turn_id, field, quote, relation, status,
      target_addition_id, start_offset, end_offset, current_text, facts_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, 0, ?, ?, ?)`)
    .run(scope.workspace_id, scope.epoch, f.started.outpatientCaseId, additionId, latest.id, field, latest.messageText,
      options.relation ?? 'update', targetId, after.length, after, JSON.stringify(newFacts))
  f.runtime.database.driver.prepare(`INSERT INTO consultation_history_addition_batch
    (workspace_id, epoch, case_id, addition_id, batch_id) VALUES (?, ?, ?, ?, ?)`)
    .run(scope.workspace_id, scope.epoch, f.started.outpatientCaseId, additionId, batchId)
  return { additionId, batchId, before, after, prior, latest, scope }
}

it.each(['saved', 'candidate'] as const)('continues the original quality requests for other automatic fragments after a %s manual rewrite', async mode => {
  const calls: ModelInput[] = []
  const f = await setup(input => {
    calls.push(input)
    const payload = recordingQualityPayloadSchema.parse(input.userPayload)
    return { issues: [], agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })),
      recordingChecks: payload.recordingContext.changes.map(change => ({ id: change.id,
        preserved: true, relationValid: true, rejectionValid: true })) }
  })
  const edited = await seedRecordingChange(f)
  const retained = await seedRecordingChange(f, { field: 'chiefComplaint', after: '头晕一周' })
  const { version, updatedAt: _updatedAt, ...saved } = (await f.readCase()).clinicalDocument!.draft!
  const document = { ...saved, historyOfPresentIllness: '医生复核：头晕与起立有关，尚待查明。' }
  calls.length = 0
  if (mode === 'saved') expect((await f.save(document)).status).toBe(200)
  expect((await f.mutate('check', { expectedDraftVersion: mode === 'saved'
    ? (await f.readCase()).clinicalDocument!.draft!.version : version,
  ...(mode === 'candidate' ? { document, clientId: 'manual-recording-editor', clientRevision: 1 } : {}) })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(await f.read(mode === 'candidate' ? 'manual-recording-editor' : undefined)).toMatchObject({ status: 'ready', stale: false })
  expect(calls.map(call => call.schemaName)).toEqual(['clinical_document_quality', 'clinical_document_quality_verification'])
  for (const call of calls) {
    const payload = recordingQualityPayloadSchema.parse(call.userPayload)
    expect(payload.document.historyOfPresentIllness).toBe(document.historyOfPresentIllness)
    expect(payload.recordingContext.changes.map(change => change.id)).toEqual([retained.additionId])
    expect(payload.agentFacts.some(fact => fact.id.startsWith(`${edited.additionId}:`))).toBe(false)
    expect(payload.agentFacts.some(fact => fact.id.startsWith(`${retained.additionId}:`))).toBe(true)
  }
  expect((await f.readCase()).clinicalDocument!.draft!.historyOfPresentIllness)
    .toBe(mode === 'saved' ? document.historyOfPresentIllness : edited.after)
})

it.each(['correction', 'conflict'] as const)('checks a new %s of a manually owned former automatic target without reviving its old facts', async relation => {
  const calls: ModelInput[] = []
  const f = await setup(input => {
    calls.push(input)
    const payload = recordingQualityPayloadSchema.parse(input.userPayload)
    return { issues: [], agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })),
      recordingChecks: payload.recordingContext.changes.map(change => ({ id: change.id,
        preserved: true, relationValid: true, rejectionValid: true })) }
  }, undefined, '刚才时间说错了，我头晕三周，站起来会加重。')
  const former = await seedRecordingChange(f)
  const retained = await seedRecordingChange(f, { field: 'chiefComplaint', after: '头晕一周' })
  const { version: _version, updatedAt: _updatedAt, ...saved } = (await f.readCase()).clinicalDocument!.draft!
  const manual = '医生核实：头晕两周，起立时加重。'
  expect((await f.save({ ...saved, historyOfPresentIllness: manual })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect((await f.ask()).status).toBe(200)
  await f.runtime.dispatchPending()
  const sources = (await f.readCase()).consultationRecording!.sources!, latest = sources.at(-1)!
  expect(latest.id).not.toBe(former.latest.id)
  const after = relation === 'correction' ? '患者更正为头晕三周，起立时加重。' : '原记头晕两周；患者现自述三周，时长待核实。'
  expect((await f.save({ ...saved, historyOfPresentIllness: after })).status).toBe(200)
  await f.runtime.dispatchPending()
  const detail = await f.readCase(), batchId = randomUUID(), additionId = randomUUID()
  const fact = { text: after, sources: [{ sourceTurnId: latest.id, quote: latest.messageText }] }
  const batch = { members: [{ id: latest.id, generation: 1 }], sources,
    baseline: { version: detail.clinicalDocument!.draft!.version - 1, content: { ...saved, historyOfPresentIllness: manual } },
    history: [{ id: former.additionId, field: 'historyOfPresentIllness', text: former.after,
      facts: [{ text: former.after, sources: [{ sourceTurnId: former.latest.id, quote: former.latest.messageText }] }],
      sourceTurnId: former.latest.id, quote: former.latest.messageText }],
    manualHistory: [{ id: former.additionId, field: 'historyOfPresentIllness', text: manual, start: 0, end: manual.length }], rejectedFacts: [] }
  f.runtime.database.driver.prepare("UPDATE consultation_history_addition SET review_state = 'superseded' WHERE addition_id = ?").run(former.additionId)
  f.runtime.database.driver.prepare(`INSERT INTO consultation_recording_batch
    (workspace_id, epoch, case_id, batch_id, snapshot_json, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(former.scope.workspace_id, former.scope.epoch, f.started.outpatientCaseId, batchId, JSON.stringify(batch), '2026-10-19T00:00:02Z', '2026-10-19T00:00:03Z')
  f.runtime.database.driver.prepare(`INSERT INTO consultation_history_addition
    (workspace_id, epoch, case_id, addition_id, source_turn_id, field, quote, relation, status,
      target_addition_id, start_offset, end_offset, current_text, facts_json)
    VALUES (?, ?, ?, ?, ?, 'historyOfPresentIllness', ?, ?, 'applied', ?, 0, ?, ?, ?)`)
    .run(former.scope.workspace_id, former.scope.epoch, f.started.outpatientCaseId, additionId, latest.id, latest.messageText,
      relation, former.additionId, after.length, after, JSON.stringify([fact]))
  f.runtime.database.driver.prepare(`INSERT INTO consultation_history_addition_batch
    (workspace_id, epoch, case_id, addition_id, batch_id) VALUES (?, ?, ?, ?, ?)`)
    .run(former.scope.workspace_id, former.scope.epoch, f.started.outpatientCaseId, additionId, batchId)
  calls.length = 0
  expect((await f.mutate('check', { expectedDraftVersion: detail.clinicalDocument!.draft!.version })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(await f.read()).toMatchObject({ status: 'ready', stale: false })
  expect(calls.map(call => call.schemaName)).toEqual(['clinical_document_quality', 'clinical_document_quality_verification'])
  for (const call of calls) {
    const payload = z.object({ recordingContext: z.object({ changes: z.array(z.object({ id: z.string(),
      targetId: z.string().optional(), before: z.object({ text: z.string(), facts: z.array(z.unknown()) }), newSourceIds: z.array(z.string()) })) }) }).parse(call.userPayload)
    expect(payload.recordingContext.changes.map(change => change.id)).toEqual([retained.additionId, additionId])
    expect(payload.recordingContext.changes.find(change => change.id === additionId)).toMatchObject({
      targetId: former.additionId, before: { text: manual, facts: [] }, newSourceIds: [latest.id],
    })
  }
  expect((await f.readCase()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(after)
})

it('keeps immutable automatic ancestry after a doctor later edits the still-visible target of a conflict', async () => {
  const calls: ModelInput[] = []
  const f = await setup(input => {
    calls.push(input)
    const payload = recordingQualityPayloadSchema.parse(input.userPayload)
    return { issues: [], agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })),
      recordingChecks: payload.recordingContext.changes.map(change => ({ id: change.id,
        preserved: change.before?.text !== '头晕一周；无胸痛', relationValid: true, rejectionValid: true })) }
  })
  const first = await seedRecordingChange(f)
  expect((await f.ask()).status).toBe(200)
  await f.runtime.dispatchPending()
  const latest = (await f.readCase()).consultationRecording!.sources!.at(-1)!
  const conflict = '患者本次自述头晕两周，与原记时长存在矛盾，待核实。'
  const current = `${first.after}。\n${conflict}`
  expect((await f.save({ historyOfPresentIllness: current })).status).toBe(200)
  await f.runtime.dispatchPending()
  const detail = await f.readCase(), batchId = randomUUID(), additionId = randomUUID()
  const fact = (text: string, source = latest) => ({ text, sources: [{ sourceTurnId: source.id, quote: source.messageText }] })
  const batch = { members: [{ id: latest.id, generation: 1 }], sources: detail.consultationRecording!.sources!,
    baseline: { version: detail.clinicalDocument!.draft!.version - 1, content: { assessment: '', chiefComplaint: '', disposition: '',
      followUp: '', physicalExamination: '', historyOfPresentIllness: first.after } },
    history: [{ id: first.additionId, field: 'historyOfPresentIllness', text: first.after, facts: [fact(first.after, first.latest)],
      sourceTurnId: first.latest.id, quote: first.latest.messageText }], manualHistory: [], rejectedFacts: [] }
  f.runtime.database.driver.prepare(`INSERT INTO consultation_recording_batch
    (workspace_id, epoch, case_id, batch_id, snapshot_json, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(first.scope.workspace_id, first.scope.epoch, f.started.outpatientCaseId, batchId, JSON.stringify(batch), '2026-10-19T00:00:02Z', '2026-10-19T00:00:03Z')
  f.runtime.database.driver.prepare(`INSERT INTO consultation_history_addition
    (workspace_id, epoch, case_id, addition_id, source_turn_id, field, quote, relation, status,
      target_addition_id, start_offset, end_offset, current_text, facts_json)
    VALUES (?, ?, ?, ?, ?, 'historyOfPresentIllness', ?, 'conflict', 'applied', ?, ?, ?, ?, ?)`)
    .run(first.scope.workspace_id, first.scope.epoch, f.started.outpatientCaseId, additionId, latest.id, latest.messageText,
      first.additionId, first.after.length + 2, current.length, conflict, JSON.stringify([fact(conflict)]))
  f.runtime.database.driver.prepare(`INSERT INTO consultation_history_addition_batch
    (workspace_id, epoch, case_id, addition_id, batch_id) VALUES (?, ?, ?, ?, ?)`)
    .run(first.scope.workspace_id, first.scope.epoch, f.started.outpatientCaseId, additionId, batchId)
  const manual = '医生复核原片段：头晕与体位有关，时长待核实。'
  calls.length = 0
  expect((await f.save({ historyOfPresentIllness: `${manual}\n${conflict}` })).status).toBe(200)
  expect((await f.mutate('check', { expectedDraftVersion: (await f.readCase()).clinicalDocument!.draft!.version })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(await f.read()).toMatchObject({ status: 'ready', stale: false, issues: expect.arrayContaining([
    expect.objectContaining({ kind: 'agent-source', message: '现病史中的自动记录变更尚未确认保留全部仍有效的旧事实。' }),
  ]) })
  expect(calls.map(call => call.schemaName)).toEqual(['clinical_document_quality', 'clinical_document_quality_verification'])
  for (const call of calls) {
    const payload = z.object({ recordingContext: z.object({ changes: z.array(z.object({ id: z.string(), historical: z.boolean(),
      before: z.object({ text: z.string() }), after: z.object({ text: z.string() }) })) }) }).parse(call.userPayload)
    expect(payload.recordingContext.changes).toEqual([
      { id: first.additionId, historical: true, before: { text: first.before }, after: { text: first.after } },
      { id: additionId, historical: false, before: { text: first.after }, after: { text: conflict } },
    ])
  }
  expect((await f.readCase()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(`${manual}\n${conflict}`)
})

it('checks preservation of old valid recording facts in the existing quality requests and reuses the complete input', async () => {
  const calls: ModelInput[] = []
  const f = await setup(input => {
    calls.push(input)
    const payload = qualityPayloadSchema.parse(input.userPayload)
    const recording = recordingQualityPayloadSchema.safeParse(input.userPayload)
    return { issues: [], agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })),
      ...(recording.success ? { recordingChecks: recording.data.recordingContext.changes.map(change => ({ id: change.id,
        preserved: input.schemaName !== 'clinical_document_quality_verification', relationValid: true, rejectionValid: true })) } : {}) }
  })
  const seeded = await seedRecordingChange(f)
  calls.length = 0
  expect((await f.mutate('check', { expectedDraftVersion: (await f.readCase()).clinicalDocument!.draft!.version })).status).toBe(200)
  await f.runtime.dispatchPending()
  const state = await f.read()
  expect(state).toMatchObject({ status: 'ready', stale: false, issues: expect.arrayContaining([
    expect.objectContaining({ kind: 'agent-source', field: 'historyOfPresentIllness', classification: 'needs-verification',
      message: '现病史中的自动记录变更尚未确认保留全部仍有效的旧事实。' }),
  ]) })
  expect(calls.map(call => call.schemaName)).toEqual(['clinical_document_quality', 'clinical_document_quality_verification'])
  const input = recordingQualityPayloadSchema.parse(calls[0]!.userPayload)
  expect(input.recordingContext.changes).toEqual([expect.objectContaining({ id: seeded.additionId, relation: 'update',
    before: expect.objectContaining({ text: '头晕一周；无胸痛' }), after: expect.objectContaining({ text: '站起时头晕加重' }),
    newSourceIds: [seeded.latest.id] })])
  expect(state.issues.find(issue => issue.kind === 'agent-source')?.explanation?.impact).toContain('不能确认')
  expect((await f.readCase()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(seeded.after)
  await f.restart()
  expect((await f.mutate('check', { expectedDraftVersion: (await f.readCase()).clinicalDocument!.draft!.version })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(calls).toHaveLength(2)
})

it('does not declare recording protections complete when a rejected fact has no recoverable saved source', async () => {
  let calls = 0
  const f = await setup(input => {
    calls += 1
    const payload = qualityPayloadSchema.parse(input.userPayload)
    return { issues: [], agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })),
      recordingChecks: recordingQualityPayloadSchema.safeParse(input.userPayload).data?.recordingContext.changes.map(change => ({
        id: change.id, preserved: true, relationValid: true, rejectionValid: true,
      })) ?? [] }
  })
  const seeded = await seedRecordingChange(f)
  f.runtime.database.driver.prepare(`INSERT INTO consultation_history_addition
    (workspace_id, epoch, case_id, addition_id, source_turn_id, field, quote, relation, status,
      current_text, facts_json, rejected, undone) VALUES (?, ?, ?, ?, ?, 'historyOfPresentIllness', ?, 'addition', 'applied', ?, ?, 1, 1)`)
    .run(seeded.scope.workspace_id, seeded.scope.epoch, f.started.outpatientCaseId, randomUUID(), seeded.prior.id,
      seeded.prior.messageText, '既往拒绝事实', JSON.stringify([{ text: '既往拒绝事实', sources: [{ sourceTurnId: 'unavailable-source', quote: '原始来源不可恢复。' }] }]))
  calls = 0
  expect((await f.mutate('check', { expectedDraftVersion: (await f.readCase()).clinicalDocument!.draft!.version })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(await f.read()).toMatchObject({ status: 'incomplete', stale: false })
  expect((await f.read()).notices.join('')).toContain('拒绝事实或来源上下文不足')
  expect(calls).toBe(0)
})

it('keeps both old-fact preservation and relation findings when the same recording change fails both checks', async () => {
  const f = await setup(input => {
    const payload = qualityPayloadSchema.parse(input.userPayload)
    const recording = recordingQualityPayloadSchema.safeParse(input.userPayload)
    return { issues: [], agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })),
      recordingChecks: recording.data?.recordingContext.changes.map(change => ({ id: change.id,
        preserved: false, relationValid: false, rejectionValid: true })) ?? [] }
  })
  await seedRecordingChange(f, { relation: 'correction' })
  expect((await f.mutate('check', { expectedDraftVersion: (await f.readCase()).clinicalDocument!.draft!.version })).status).toBe(200)
  await f.runtime.dispatchPending()
  const issues = (await f.read()).issues.filter(issue => issue.kind === 'agent-source')
  expect(issues.map(issue => issue.message)).toEqual([
    '现病史中的自动记录变更尚未确认保留全部仍有效的旧事实。',
    '现病史中的自动记录的更正或冲突关系尚未通过来源语义核验。',
  ])
  expect(new Set(issues.map(issue => issue.id)).size).toBe(2)
})

it.each(['update', 'correction', 'conflict'] as const)('accepts a supported %s with its old/new context in both quality requests', async relation => {
  const calls: ModelInput[] = []
  const f = await setup(input => {
    calls.push(input)
    const payload = qualityPayloadSchema.parse(input.userPayload)
    const recording = recordingQualityPayloadSchema.safeParse(input.userPayload)
    return { issues: [], agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })),
      recordingChecks: recording.data?.recordingContext.changes.map(change => ({ id: change.id,
        preserved: true, relationValid: true, rejectionValid: true })) ?? [] }
  })
  const seeded = await seedRecordingChange(f, { relation, after: relation === 'conflict' ? '无胸痛；患者另述胸痛，双方说法待核实' : '头晕一周；无胸痛；站起时加重' })
  calls.length = 0
  expect((await f.mutate('check', { expectedDraftVersion: (await f.readCase()).clinicalDocument!.draft!.version })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(await f.read()).toMatchObject({ status: 'ready', stale: false })
  expect((await f.read()).issues.filter(issue => issue.kind === 'agent-source')).toEqual([])
  expect(calls.map(call => call.schemaName)).toEqual(['clinical_document_quality', 'clinical_document_quality_verification'])
  for (const call of calls) expect(recordingQualityPayloadSchema.parse(call.userPayload).recordingContext.changes)
    .toEqual([expect.objectContaining({ id: seeded.additionId, relation,
      before: expect.objectContaining({ text: seeded.before }), after: expect.objectContaining({ text: seeded.after }) })])
})

it.each([false, true])('checks rejected fact recurrence against new batch sources (new support: %s)', async newSupport => {
  const calls: ModelInput[] = []
  const reply = newSupport ? '我现在出现胸痛。' : '我现在只是头晕加重。'
  const f = await setup(input => {
    calls.push(input)
    const payload = qualityPayloadSchema.parse(input.userPayload)
    const recording = recordingQualityPayloadSchema.safeParse(input.userPayload)
    return { issues: [], agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })),
      recordingChecks: recording.data?.recordingContext.changes.map(change => ({ id: change.id,
        preserved: true, relationValid: true, rejectionValid: newSupport })) ?? [] }
  }, undefined, reply)
  const seeded = await seedRecordingChange(f, { rejected: '胸痛', after: '胸痛；头晕加重' })
  calls.length = 0
  expect((await f.mutate('check', { expectedDraftVersion: (await f.readCase()).clinicalDocument!.draft!.version })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect((await f.read()).status).toBe('ready')
  expect((await f.read()).issues.filter(issue => issue.kind === 'agent-source')).toHaveLength(newSupport ? 0 : 1)
  expect(calls.map(call => call.schemaName)).toEqual(['clinical_document_quality', 'clinical_document_quality_verification'])
  const input = recordingQualityPayloadSchema.parse(calls[0]!.userPayload)
  expect(input.evidence).toContainEqual(expect.objectContaining({ id: seeded.latest.id, text: reply }))
  expect(input.recordingContext.changes).toEqual([expect.objectContaining({ newSourceIds: [seeded.latest.id],
    rejectedFacts: [expect.objectContaining({ text: '胸痛', sources: [{ sourceTurnId: seeded.prior.id, quote: seeded.prior.messageText }] })] })])
  expect((await f.readCase()).clinicalDocument!.draft!.historyOfPresentIllness).toBe('胸痛；头晕加重')
})

it.each(['bytes', 'facts'] as const)('charges complete recording context to the existing %s budget instead of truncating it or calling a model', async budget => {
  let calls = 0
  const f = await setup(() => { calls += 1; return { issues: [], agentFactChecks: [] } })
  const seeded = await seedRecordingChange(f)
  const batch = z.object({ snapshot_json: z.string() }).parse(f.runtime.database.driver.prepare(
    'SELECT snapshot_json FROM consultation_recording_batch WHERE batch_id = ?').get(seeded.batchId))
  const input = z.record(z.string(), z.unknown()).parse(JSON.parse(batch.snapshot_json))
  input.rejectedFacts = Array.from({ length: budget === 'bytes' ? 120 : 201 }, (_, index) => ({
    text: `${index}${'合成旧事实'.repeat(budget === 'bytes' ? 100 : 1)}`,
    field: 'historyOfPresentIllness', sources: [{ sourceTurnId: seeded.prior.id, quote: seeded.prior.messageText }] }))
  f.runtime.database.driver.prepare('UPDATE consultation_recording_batch SET snapshot_json = ? WHERE batch_id = ?')
    .run(JSON.stringify(input), seeded.batchId)
  calls = 0
  expect((await f.mutate('check', { expectedDraftVersion: (await f.readCase()).clinicalDocument!.draft!.version })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(await f.read()).toMatchObject({ status: 'incomplete', errorCode: 'INPUT_TOO_LARGE' })
  expect((await f.read()).notices.join('')).toContain('未截断资料')
  expect(calls).toBe(0)
})

it('retains original source limitations for unsupported Agent statements and accepts the negative independent verdict without repair', async () => {
  const examples = [
    { quote: '我早上吃过饭，也喝过水。', statement: '已空腹至少八小时。' },
    { quote: '我早上吃过饭，也喝过水。', statement: '符合采血条件。' },
    { quote: '我早上吃过饭，也喝过水。', statement: '已完成采血。' },
    { quote: '我会不会得了糖尿病？', statement: '已确诊糖尿病。' },
    { quote: '如果胸痛三天是不是要检查？', statement: '胸痛三天。' },
    { quote: '假如一直没有进食会不会头晕？', statement: '一直未进食。' },
    { quote: '我没有胸痛。', statement: '存在胸痛。' },
    { quote: '我可能昨晚发热，记不清。', statement: '昨晚明确发热。' },
    { quote: '我自己量过体温37.2度。', statement: '本院测得体温38.2度。' },
    { quote: '我猜医生可能会给我开降压药。', statement: '医生已决定开降压药。' },
  ]
  const calls: ModelInput[] = []
  const f = await setup(input => {
    calls.push(input)
    const payload = qualityPayloadSchema.parse(input.userPayload)
    return { issues: [], agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id,
      supported: input.schemaName !== 'clinical_document_quality_verification' })) }
  })
  const scope = z.object({ workspace_id: z.string(), epoch: z.string() }).parse(f.runtime.database.driver.prepare(
    'SELECT workspace_id, epoch FROM outpatient_case WHERE case_id = ?').get(f.started.outpatientCaseId))
  // Seed persisted source history without invoking the patient simulator's
  // independent hidden-diagnosis guard; only the quality seam is under test.
  f.runtime.database.driver.prepare(`INSERT INTO consultation_recording_source
    (workspace_id, epoch, case_id, source_id, source_kind, message_text, sequence, recorded_at, metadata_json)
    VALUES (?, ?, ?, ?, 'patient', ?, 2, '2026-10-19T00:00:00Z', '{}')`)
    .run(scope.workspace_id, scope.epoch, f.started.outpatientCaseId, randomUUID(), [...new Set(examples.map(example => example.quote))].join(''))
  const source = (await f.readCase()).consultationRecording!.sources!.at(-1)!
  calls.length = 0
  const document = examples.map(example => example.statement).join('')
  expect((await f.save({ historyOfPresentIllness: document }, { agentGenerated: true, agentFacts: examples.map(example => ({
    field: 'historyOfPresentIllness', text: example.statement, sources: [{ sourceTurnId: source.id, quote: example.quote }],
  })) })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect((await f.read()).status).toBe('ready')
  expect((await f.read()).issues.filter(issue => issue.kind === 'agent-source')).toHaveLength(examples.length)
  expect(calls.map(call => call.schemaName)).toEqual(['clinical_document_quality', 'clinical_document_quality_verification'])
  const payload = z.object({ agentFacts: z.array(z.object({ text: z.string(), sources: z.array(z.object({ quote: z.string() })) })) })
  for (const call of calls) {
    const facts = payload.parse(call.userPayload).agentFacts
    for (const example of examples) expect(facts).toContainEqual(expect.objectContaining({ text: example.statement,
      sources: [expect.objectContaining({ quote: example.quote })] }))
    expect(call.systemPrompt).toContain('进食或饮水不能推断空腹时长')
    expect(call.systemPrompt).toContain('完整自述旁含问号')
    expect(call.systemPrompt).toContain('医生明确表达或明确采纳的决定')
  }
  expect((await f.readCase()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(document)
})

it('keeps a still-valid fact lost before a second replacement in current quality context', async () => {
  const calls: ModelInput[] = []
  const f = await setup(input => {
    calls.push(input)
    const payload = qualityPayloadSchema.parse(input.userPayload)
    const recording = recordingQualityPayloadSchema.safeParse(input.userPayload)
    return { issues: [], agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })),
      recordingChecks: recording.data?.recordingContext.changes.map(change => ({ id: change.id,
        preserved: change.before?.text !== '头晕一周；无胸痛', relationValid: true, rejectionValid: true })) ?? [] }
  })
  const first = await seedRecordingChange(f)
  const current = `${first.after}；伴恶心`
  expect((await f.save({ historyOfPresentIllness: current })).status).toBe(200)
  await f.runtime.dispatchPending()
  const detail = await f.readCase(), batchId = randomUUID(), additionId = randomUUID()
  const fact = (text: string) => ({ text, sources: [{ sourceTurnId: first.latest.id, quote: first.latest.messageText }] })
  const batch = { members: [{ id: first.latest.id, generation: 2 }], sources: detail.consultationRecording!.sources!,
    baseline: { version: detail.clinicalDocument!.draft!.version - 1, content: { assessment: '', chiefComplaint: '', disposition: '',
      followUp: '', physicalExamination: '', historyOfPresentIllness: first.after } },
    history: [{ id: first.additionId, field: 'historyOfPresentIllness', text: first.after, facts: [fact(first.after)],
      sourceTurnId: first.latest.id, quote: first.latest.messageText }], manualHistory: [], rejectedFacts: [] }
  f.runtime.database.driver.prepare("UPDATE consultation_history_addition SET review_state = 'superseded' WHERE addition_id = ?").run(first.additionId)
  f.runtime.database.driver.prepare(`INSERT INTO consultation_recording_batch
    (workspace_id, epoch, case_id, batch_id, snapshot_json, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(first.scope.workspace_id, first.scope.epoch, f.started.outpatientCaseId, batchId, JSON.stringify(batch), '2026-10-19T00:00:02Z', '2026-10-19T00:00:03Z')
  f.runtime.database.driver.prepare(`INSERT INTO consultation_history_addition
    (workspace_id, epoch, case_id, addition_id, source_turn_id, field, quote, relation, status,
      target_addition_id, start_offset, end_offset, current_text, facts_json)
    VALUES (?, ?, ?, ?, ?, 'historyOfPresentIllness', ?, 'update', 'applied', ?, 0, ?, ?, ?)`)
    .run(first.scope.workspace_id, first.scope.epoch, f.started.outpatientCaseId, additionId, first.latest.id, first.latest.messageText,
      first.additionId, current.length, current, JSON.stringify([fact(current)]))
  f.runtime.database.driver.prepare(`INSERT INTO consultation_history_addition_batch
    (workspace_id, epoch, case_id, addition_id, batch_id) VALUES (?, ?, ?, ?, ?)`)
    .run(first.scope.workspace_id, first.scope.epoch, f.started.outpatientCaseId, additionId, batchId)
  calls.length = 0
  expect((await f.mutate('check', { expectedDraftVersion: detail.clinicalDocument!.draft!.version })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect((await f.read()).issues).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'agent-source',
    message: '现病史中的自动记录变更尚未确认保留全部仍有效的旧事实。' })]))
  const context = recordingQualityPayloadSchema.parse(calls[0]!.userPayload).recordingContext
  expect(context.changes).toHaveLength(2)
  expect(context.changes).toContainEqual(expect.objectContaining({ id: first.additionId, before: { text: first.before } }))
  expect((await f.readCase()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(current)
})

it.each(['missing', 'cycle'] as const)('does not claim a complete recording check when the replacement chain is %s', async kind => {
  let calls = 0
  const f = await setup(() => { calls += 1; return { issues: [], agentFactChecks: [] } })
  const seeded = await seedRecordingChange(f)
  f.runtime.database.driver.prepare('UPDATE consultation_history_addition SET target_addition_id = ? WHERE addition_id = ?')
    .run(kind === 'cycle' ? seeded.additionId : 'missing-ancestor', seeded.additionId)
  calls = 0
  expect((await f.mutate('check', { expectedDraftVersion: (await f.readCase()).clinicalDocument!.draft!.version })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect((await f.read()).status).toBe('incomplete')
  expect((await f.read()).notices.join('')).toContain('语义检查未完成')
  expect(calls).toBe(0)
})

it('can verify the explicit self-report beside a question while keeping the complete original sentence', async () => {
  const calls: ModelInput[] = []
  const f = await setup(input => {
    calls.push(input)
    const payload = qualityPayloadSchema.parse(input.userPayload)
    return { issues: [], agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })) }
  }, undefined, '我头晕一周，会不会很严重？')
  expect((await f.ask()).status).toBe(200)
  await f.runtime.dispatchPending()
  const source = (await f.readCase()).consultationRecording!.sources!.at(-1)!
  calls.length = 0
  expect((await f.save({ historyOfPresentIllness: '患者自述头晕一周。' }, { agentGenerated: true,
    agentFacts: [{ field: 'historyOfPresentIllness', text: '患者自述头晕一周。', sources: [{ sourceTurnId: source.id, quote: source.messageText }] }] })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect((await f.read()).issues.filter(issue => issue.kind === 'agent-source')).toEqual([])
  expect(calls.map(call => call.schemaName)).toEqual(['clinical_document_quality', 'clinical_document_quality_verification'])
  for (const call of calls) expect(qualityPayloadSchema.parse(call.userPayload).evidence)
    .toContainEqual(expect.objectContaining({ id: source.id, text: '我头晕一周，会不会很严重？' }))
})

it.each(['saved', 'candidate'] as const)('reuses a failed %s task until an explicit retry without new outbox work or model calls', async mode => {
  let calls = 0
  const f = await setup(() => {
    calls += 1
    return Response.json({ model: encodeModelRoute({ provider: 'synthetic', model: 'synthetic' }), content: '{invalid-json' })
  })
  const input = { expectedDraftVersion: 0, ...(mode === 'candidate' ? { clientId: 'stable-editor', clientRevision: 1,
    document: { assessment: '', chiefComplaint: '头晕。', disposition: '', followUp: '', physicalExamination: '', historyOfPresentIllness: '' } } : {}) }
  expect((await f.mutate('check', input)).status).toBe(200)
  await f.runtime.dispatchPending()
  const state = await f.read(mode === 'candidate' ? 'stable-editor' : undefined)
  expect(state.status).toBe('failed')
  const taskCount = () => z.object({ count: z.number() }).parse(f.runtime.database.driver.prepare(
    "SELECT count(*) AS count FROM outbox_event WHERE kind = 'clinical-document.check-quality'").get()).count
  const tasks = taskCount(), completedCalls = calls
  expect(completedCalls).toBe(2)
  expect((await f.mutate('check', input)).status).toBe(200)
  expect((await f.read(mode === 'candidate' ? 'stable-editor' : undefined)).generation).toBe(state.generation)
  await f.runtime.dispatchPending()
  expect(taskCount()).toBe(tasks)
  expect(calls).toBe(completedCalls)
  expect((await f.mutate('check', { ...input, refresh: true })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect((await f.read(mode === 'candidate' ? 'stable-editor' : undefined)).generation).toBe(state.generation + 1)
  expect(taskCount()).toBe(tasks + 1)
  expect(calls).toBe(completedCalls + 2)
})

it('reuses semantic quality when saving the same document only changes its draft version', async () => {
  let calls = 0
  const f = await setup(() => { calls += 1; return { issues: [], agentFactChecks: [] } })
  expect((await f.save({ chiefComplaint: '头晕一天。' })).status).toBe(200)
  await f.runtime.dispatchPending()
  const before = await f.read(), completedCalls = calls
  expect((await f.save({ chiefComplaint: '头晕一天。' })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect((await f.read()).draftVersion).toBe(before.draftVersion + 1)
  expect((await f.read()).generation).toBe(before.generation)
  expect(calls).toBe(completedCalls)
})

it('shares one pending task between an unsaved candidate, its saved document and another client across restart', async () => {
  let calls = 0
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const f = await setup(async () => { calls += 1; enter(); await held; return { issues: [], agentFactChecks: [] } })
  const document = { assessment: '', chiefComplaint: '头晕一天。', disposition: '', followUp: '', physicalExamination: '', historyOfPresentIllness: '' }
  expect((await f.mutate('check', { expectedDraftVersion: 0, document, clientId: 'editor-a', clientRevision: 1 })).status).toBe(200)
  const dispatch = f.runtime.dispatchPending()
  await entered
  try {
    expect((await f.save(document)).status).toBe(200)
    expect((await f.mutate('check', { expectedDraftVersion: 1, document, clientId: 'editor-b', clientRevision: 9 })).status).toBe(200)
    expect((await f.read()).status).toBe('pending')
    expect((await f.read('editor-a')).clientRevision).toBe(1)
    expect((await f.read('editor-b')).clientRevision).toBe(9)
  } finally { release() }
  await dispatch
  const tasks = z.object({ count: z.number() }).parse(f.runtime.database.driver.prepare(
    "SELECT count(*) AS count FROM outbox_event WHERE kind = 'clinical-document.check-quality'").get()).count
  expect(tasks).toBe(1)
  expect(calls).toBe(1)
  await f.restart()
  for (const clientId of [undefined, 'editor-a', 'editor-b']) expect(await f.read(clientId)).toMatchObject({ status: 'ready', stale: false, draftVersion: 1 })
  expect((await f.read('editor-a')).clientRevision).toBe(1)
  expect((await f.read('editor-b')).clientRevision).toBe(9)
})

it('shares failure and explicit retry generations across aliases without navigation retries', async () => {
  let calls = 0
  const f = await setup(() => { calls += 1; return Response.json({ model: encodeModelRoute({ provider: 'synthetic', model: 'synthetic' }), content: '{invalid-json' }) })
  const document = { assessment: '', chiefComplaint: '头晕一天。', disposition: '', followUp: '', physicalExamination: '', historyOfPresentIllness: '' }
  const input = { expectedDraftVersion: 0, document, clientId: 'editor-a', clientRevision: 1 }
  expect((await f.mutate('check', input)).status).toBe(200)
  await f.runtime.dispatchPending()
  expect((await f.mutate('check', { ...input, clientId: 'editor-b', clientRevision: 9 })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(calls).toBe(2)
  expect(await f.read('editor-b')).toMatchObject({ status: 'failed', generation: 1, clientRevision: 9 })
  expect((await f.mutate('check', { ...input, refresh: true })).status).toBe(200)
  expect(await f.read('editor-b')).toMatchObject({ status: 'pending', generation: 2, clientRevision: 9 })
  expect((await f.mutate('check', { ...input, clientId: 'editor-b', clientRevision: 10 })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(calls).toBe(4)
  expect(await f.read('editor-a')).toMatchObject({ status: 'failed', generation: 2, clientRevision: 1 })
  expect(await f.read('editor-b')).toMatchObject({ status: 'failed', generation: 2, clientRevision: 10 })
  await f.restart()
  expect((await f.mutate('check', { ...input, clientId: 'editor-b', clientRevision: 10 })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(calls).toBe(4)
  expect(z.object({ count: z.number() }).parse(f.runtime.database.driver.prepare(
    "SELECT count(*) AS count FROM outbox_event WHERE kind = 'clinical-document.check-quality'").get()).count).toBe(2)
})

it('rejects a late canonical generation after another alias explicitly retries it', async () => {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const f = await setup(async input => {
    calls += 1
    if (calls === 1) { enter(); await held; return { issues: [], agentFactChecks: [] } }
    if (input.schemaName === 'clinical_document_quality_verification') return { issues: [{ index: 0, supported: true }], agentFactChecks: [] }
    return { issues: [{ kind: 'missing-field', field: 'chiefComplaint', message: '新的质控提示。', documentQuote: '头晕。', sourceQuotes: [],
      explanation: { impact: '病程还需要核实。', suggestion: '核对现有主诉。' } }], agentFactChecks: [] }
  })
  const document = { assessment: '', chiefComplaint: '头晕。', disposition: '', followUp: '', physicalExamination: '', historyOfPresentIllness: '' }
  const input = { expectedDraftVersion: 0, document, clientId: 'editor-a', clientRevision: 1 }
  expect((await f.mutate('check', input)).status).toBe(200)
  const dispatch = f.runtime.dispatchPending()
  await entered
  try { expect((await f.mutate('check', { ...input, clientId: 'editor-b', clientRevision: 9, refresh: true })).status).toBe(200) }
  finally { release() }
  await dispatch
  expect(calls).toBe(3)
  for (const clientId of ['editor-a', 'editor-b']) expect(await f.read(clientId)).toMatchObject({ status: 'ready', generation: 2,
    issues: expect.arrayContaining([expect.objectContaining({ message: '新的质控提示。' })]) })
})

async function qualityGrant(f: Awaited<ReturnType<typeof setup>>, operationId: string, ttlSeconds = 3600) {
  const headers = { cookie: f.started.adminCookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }
  const clientResponse = await f.runtime.app.request('/api/agent/v1/clients', { method: 'POST', headers,
    body: JSON.stringify({ name: 'Synthetic quality checker' }) })
  expect(clientResponse.status).toBe(200)
  const client = agentClientSchema.parse(await clientResponse.json())
  const granted = await f.runtime.app.request('/api/agent/v1/grants', { method: 'POST',
    headers: { ...headers, 'idempotency-key': randomUUID() }, body: JSON.stringify({ agentClientId: client.agentClientId,
      operationIds: [operationId, 'doctor.document-quality.get'], practitionerRoleId: 'practitioner-role-outpatient-doctor', ttlSeconds }) })
  expect(granted.status).toBe(200)
  return agentCapabilityGrantSchema.parse(await granted.json())
}

it('independently verifies exact source omissions and shares retention across saved and unsaved scopes', async () => {
  const f = await setup(input => {
    const payload = qualityPayloadSchema.parse(input.userPayload)
    if (input.schemaName === 'clinical_document_quality_verification') return { issues: payload.issues!.map((_, index) => ({ index, supported: true })), agentFactChecks: [] }
    const source = payload.evidence.find(item => item.kind === 'patient')!
    return { issues: [{ kind: 'omission', field: 'priorMedicalHistory', message: '当前问诊中的头晕病史可能尚未纳入正文。',
      explanation: { impact: '正文未保留患者已陈述的头晕过程，后续阅读者可能不了解其持续时间。',
        suggestion: '核对下方问诊原文后，将与本次就诊相关的病史写入现病史；不代患者补充未知内容。' },
      sourceQuotes: [{ evidenceId: source.id, quote: source.text }] }], agentFactChecks: [] }
  })
  expect((await f.save({ historyOfPresentIllness: '记录待补充。' })).status).toBe(200)
  await f.runtime.dispatchPending()
  const issue = (await f.read()).issues.find(issue => issue.kind === 'omission')!
  expect(issue).toMatchObject({ field: 'priorMedicalHistory', classification: 'needs-completion', status: 'open' })
  expect(issue).toMatchObject({ basis: { kind: 'project' }, explanation: {
    impact: '正文未保留患者已陈述的头晕过程，后续阅读者可能不了解其持续时间。',
    suggestion: '核对下方问诊原文后，将与本次就诊相关的病史写入现病史；不代患者补充未知内容。',
  } })
  expect(issue.evidence[0]).toMatchObject({ kind: 'patient', text: persona.openingStatement })
  const detail = await f.readCase()
  const document = { assessment: '', chiefComplaint: '', disposition: '', followUp: '', physicalExamination: '', historyOfPresentIllness: '记录待补充。' }
  expect((await f.mutate('check', { expectedDraftVersion: detail.clinicalDocument!.draft!.version, document, clientId: 'same-document', clientRevision: 1 })).status).toBe(200)
  await f.runtime.dispatchPending()
  const candidate = await f.read('same-document')
  expect((await f.mutate('retain', { issueId: issue.id, clientId: 'same-document', expectedInputFingerprint: candidate.inputFingerprint })).status).toBe(200)
  expect((await f.read()).issues.find(item => item.id === issue.id)?.status).toBe('retained')
})

it.each(['auxiliaryExamination', 'familyHistory', 'physicalExamination'] as const)(
  'does not publish arbitrary %s checklist requirements as missing template fields even if a model endorses them', async field => {
    const f = await setup(input => {
      const payload = qualityPayloadSchema.parse(input.userPayload)
      if (input.schemaName === 'clinical_document_quality_verification') return {
        issues: payload.issues!.map((_, index) => ({ index, supported: true })), agentFactChecks: [],
      }
      return { issues: [{ kind: 'missing-field', field, message: '缺少病种清单要求的记录。',
        explanation: { impact: '尚无血常规、CRP或病原学结果。', suggestion: '补齐全套检查结果。' },
        ...(payload.document[field] ? { documentQuote: payload.document[field] } : {}), sourceQuotes: [],
      }], agentFactChecks: [] }
    })
    expect((await f.save({ physicalExamination: '一般情况可。', auxiliaryExamination: '尚无本次检查结果。' })).status).toBe(200)
    await f.runtime.dispatchPending()
    const quality = await f.read()
    expect(quality).toMatchObject({ status: 'failed', errorCode: 'AI_RESPONSE_INVALID' })
    expect(quality.issues.filter(issue => issue.field === field)).toEqual([])
    expect((await f.readCase()).clinicalDocument?.draft).toMatchObject({ auxiliaryExamination: '尚无本次检查结果。' })
  },
)

it('reads legacy persisted checks as stale and refreshes them without reusing an old semantic explanation', async () => {
  const f = await setup(input => {
    const payload = qualityPayloadSchema.parse(input.userPayload)
    if (input.schemaName === 'clinical_document_quality_verification') return {
      issues: payload.issues!.map((_, index) => ({ index, supported: true })), agentFactChecks: [],
    }
    return { issues: [{ kind: 'missing-field', field: 'chiefComplaint', message: '主诉未说明持续时间。', documentQuote: '头晕。',
      explanation: { impact: '正文中的主诉未说明症状持续多久。', suggestion: '核对已知病史后补录持续时间；无法确认可如实注明不详。' },
      sourceQuotes: [],
    }], agentFactChecks: [] }
  })
  expect((await f.save({ chiefComplaint: '头晕。' })).status).toBe(200)
  await f.runtime.dispatchPending()
  const row = z.object({ input_json: z.string(), state_json: z.string() }).parse(f.runtime.database.driver.prepare(
    'SELECT input_json, state_json FROM clinical_document_quality WHERE case_id = ? AND scope_key = ?').get(f.started.outpatientCaseId, 'saved'))
  const input = z.record(z.string(), z.unknown()).parse(JSON.parse(row.input_json))
  delete input.policyRevision
  const old = clinicalDocumentQualityControlStateSchema.parse(JSON.parse(row.state_json))
  const legacy = { ...old, inputFingerprint: canonicalJsonHash(input), issues: old.issues.map(({ explanation: _explanation, ...issue }) => issue) }
  f.runtime.database.driver.prepare('UPDATE clinical_document_quality SET input_json = ?, state_json = ? WHERE case_id = ? AND scope_key = ?')
    .run(JSON.stringify(input), JSON.stringify(legacy), f.started.outpatientCaseId, 'saved')
  await f.restart()
  expect(await f.read()).toMatchObject({ stale: true })
  expect((await f.read()).issues.some(issue => issue.field === 'chiefComplaint')).toBe(false)
  expect((await f.mutate('check', { expectedDraftVersion: (await f.readCase()).clinicalDocument!.draft!.version })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(await f.read()).toMatchObject({ stale: false, status: 'ready', issues: expect.arrayContaining([
    expect.objectContaining({ field: 'chiefComplaint', explanation: { impact: '正文中的主诉未说明症状持续多久。',
      suggestion: '核对已知病史后补录持续时间；无法确认可如实注明不详。' } }),
  ]) })
})

it('reopens an otherwise unchanged issue when its verified explanation changes', async () => {
  let suggestion = '核对现病史中的持续时间后补录主诉。'
  const f = await setup(input => {
    const payload = qualityPayloadSchema.parse(input.userPayload)
    if (input.schemaName === 'clinical_document_quality_verification') return {
      issues: payload.issues!.map((_, index) => ({ index, supported: true })), agentFactChecks: [],
    }
    return { issues: [{ kind: 'missing-field', field: 'chiefComplaint', message: '主诉未说明持续时间。', documentQuote: '头晕。',
      explanation: { impact: '主诉未说明症状持续多久。', suggestion }, sourceQuotes: [],
    }], agentFactChecks: [] }
  })
  expect((await f.save({ chiefComplaint: '头晕。' })).status).toBe(200)
  await f.runtime.dispatchPending()
  const before = await f.read()
  const issue = before.issues.find(item => item.field === 'chiefComplaint')!
  expect((await f.mutate('retain', { issueId: issue.id, expectedInputFingerprint: before.inputFingerprint })).status).toBe(200)
  suggestion = '核对患者原话；无法确认持续时间时如实注明不详。'
  expect((await f.mutate('check', { expectedDraftVersion: before.draftVersion, refresh: true })).status).toBe(200)
  await f.runtime.dispatchPending()
  const changed = (await f.read()).issues.find(item => item.field === 'chiefComplaint')!
  expect(changed).toMatchObject({ status: 'open', explanation: { suggestion } })
  expect(changed.relatedFingerprint).not.toBe(issue.relatedFingerprint)
  expect(changed.review).toBeUndefined()
})

it('does not publish a newly generated finding that omits its impact and suggested action', async () => {
  const f = await setup(() => ({ issues: [{ kind: 'missing-field', field: 'chiefComplaint',
    message: '主诉缺持续时间。', documentQuote: '头晕。', sourceQuotes: [],
  }], agentFactChecks: [] }))
  expect((await f.save({ chiefComplaint: '头晕。' })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(await f.read()).toMatchObject({ status: 'failed', errorCode: 'AI_RESPONSE_INVALID' })
  expect((await f.read()).issues.some(issue => issue.field === 'chiefComplaint')).toBe(false)
})

it('keeps subjective fever and a triage measurement as separate evidence and honors rejection of a false contradiction', async () => {
  const reply = '我觉得发热，但没量过体温。'
  let verified = false
  const f = await setup(input => {
    const payload = qualityPayloadSchema.parse(input.userPayload)
    const triage = payload.evidence.find(item => item.id === 'clinical:triage')!
    expect(JSON.parse(triage.text)).toMatchObject({ temperatureC: 36.5 })
    if (input.schemaName === 'clinical_document_quality_verification') {
      verified = true
      return { issues: payload.issues!.map((_, index) => ({ index, supported: false })), agentFactChecks: [] }
    }
    const patient = payload.evidence.find(item => item.kind === 'patient' && item.text === reply)
    return { issues: patient === undefined ? [] : [{ kind: 'inconsistency', field: 'physicalExamination',
      message: '候选误把自述与分诊记录当成矛盾。', documentQuote: '分诊体温36.5℃。',
      explanation: { impact: '候选没有区分患者自述和分诊测量。', suggestion: '保留自述和实际分诊记录，不直接判定其中一方错误。' },
      sourceQuotes: [{ evidenceId: patient.id, quote: reply }, { evidenceId: triage.id, quote: triage.text }],
    }], agentFactChecks: [] }
  }, new StubSyntheaProvider(), reply)
  expect((await f.ask()).status).toBe(200)
  expect((await f.save({ physicalExamination: '分诊体温36.5℃。', historyOfPresentIllness: '患者自述发热感，未自行测量体温。' })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(verified).toBe(true)
  expect(await f.read()).toMatchObject({ status: 'ready' })
  expect((await f.read()).issues.some(issue => issue.kind === 'inconsistency')).toBe(false)
  expect((await f.readCase()).clinicalDocument?.draft?.physicalExamination).toBe('分诊体温36.5℃。')
})

it('checks family and allergy history against saved patient facts without flagging already recorded facts or handwritten text as Agent content', async () => {
  const reply = '我父亲患高血压。我对青霉素过敏。'
  const f = await setup(input => {
    const payload = qualityPayloadSchema.parse(input.userPayload)
    if (input.schemaName === 'clinical_document_quality_verification') return {
      issues: payload.issues!.map((_, index) => ({ index, supported: true })), agentFactChecks: [],
    }
    const source = payload.evidence.find(item => item.kind === 'patient' && item.text === reply)
    return { issues: source === undefined ? [] : [
      { field: 'familyHistory', quote: '我父亲患高血压。', marker: '父亲患高血压' },
      { field: 'allergyHistory', quote: '我对青霉素过敏。', marker: '青霉素过敏' },
    ].filter(item => !payload.document[item.field]?.includes(item.marker)).map(item => ({
      kind: 'omission', field: item.field, message: '已知患者事实尚未记录。',
      explanation: { impact: `正文未保留患者自述的${item.marker}信息。`, suggestion: '核对下方患者原话后补录相关事实，保留自述限定。' },
      sourceQuotes: [{ evidenceId: source.id, quote: item.quote }],
    })), agentFactChecks: [] }
  }, new StubSyntheaProvider(), reply)
  expect((await f.ask()).status).toBe(200)
  await f.runtime.dispatchPending()
  const issues = (await f.read()).issues.filter(issue => issue.kind === 'omission')
  expect(issues.map(issue => issue.field)).toEqual(['familyHistory', 'allergyHistory'])
  expect(issues.flatMap(issue => issue.evidence)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'patient', text: '我父亲患高血压。', recordedAt: expect.any(String) }),
    expect.objectContaining({ kind: 'patient', text: '我对青霉素过敏。', recordedAt: expect.any(String) }),
  ]))
  expect((await f.save({ familyHistory: '患者自述父亲患高血压。', allergyHistory: '患者自述青霉素过敏。' })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect((await f.read()).issues.filter(issue => issue.kind !== 'missing-field')).toEqual([])
  expect((await f.readCase()).clinicalDocument!.draft).toMatchObject({ familyHistory: '患者自述父亲患高血压。', allergyHistory: '患者自述青霉素过敏。' })
})

it('publishes a same-time contradiction with original evidence and accepts negative verification for reasonable changes and explicit corrections', async () => {
  const reply = '今天上午体温38.5℃。昨天没有发热。刚才说错了，现在没有胸痛。'
  let verifications = 0
  const f = await setup(input => {
    const payload = qualityPayloadSchema.parse(input.userPayload)
    if (input.schemaName === 'clinical_document_quality_verification') {
      verifications += 1
      return { issues: payload.issues!.map((_, index) => ({ index, supported: index === 0 })), agentFactChecks: [] }
    }
    const source = payload.evidence.find(item => item.kind === 'patient' && item.text === reply)
    if (source === undefined || payload.document.physicalExamination !== '今天上午体温36.5℃。') return { issues: [], agentFactChecks: [] }
    return { issues: [
      { kind: 'inconsistency', field: 'physicalExamination', message: '同日上午体温需要核实。', documentQuote: '今天上午体温36.5℃。',
        explanation: { impact: '两处同日上午体温数值不同，尚不能确定对应时点。', suggestion: '核对两次测量的时间与来源，保留实际数值后修订时间表述。' },
        sourceQuotes: [{ evidenceId: source.id, quote: '今天上午体温38.5℃。' }] },
      ...['昨天没有发热。', '刚才说错了，现在没有胸痛。'].map(quote => ({ kind: 'inconsistency', field: 'historyOfPresentIllness',
        message: '应由独立核验排除的候选。', explanation: { impact: '候选将不同时点或明确更正误作互斥事实。', suggestion: '该候选不应成为待核实问题。' },
        documentQuote: '昨夜发热，现无胸痛。', sourceQuotes: [{ evidenceId: source.id, quote }] })),
    ], agentFactChecks: [] }
  }, new StubSyntheaProvider(), reply)
  expect((await f.ask()).status).toBe(200)
  expect((await f.save({ physicalExamination: '今天上午体温36.5℃。', historyOfPresentIllness: '昨夜发热，现无胸痛。' })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect((await f.read()).issues.filter(issue => issue.kind === 'inconsistency')).toEqual([
    expect.objectContaining({ field: 'physicalExamination', classification: 'needs-verification', evidence: [
      expect.objectContaining({ kind: 'document', text: '今天上午体温36.5℃。' }),
      expect.objectContaining({ kind: 'patient', text: '今天上午体温38.5℃。', recordedAt: expect.any(String) }),
    ] }),
  ])
  expect(verifications).toBe(1)
  expect((await f.read()).status).toBe('ready')
})

it('denies quality reads, checks and retention outside the responsible doctor session without modifying the draft', async () => {
  const f = await setup()
  expect((await f.save({ chiefComplaint: '头晕一周。' })).status).toBe(200)
  const before = await f.readCase()
  const state = await f.read()
  const cookie = f.started.adminCookie
  expect((await f.runtime.app.request(f.path)).status).toBe(401)
  expect((await f.runtime.app.request(f.path, { headers: { cookie } })).status).toBe(403)
  for (const [action, input] of [
    ['check', { expectedDraftVersion: before.clinicalDocument!.draft!.version }],
    ['retain', { issueId: state.issues[0]!.id, expectedInputFingerprint: state.inputFingerprint }],
  ] as const) {
    const response = await f.runtime.app.request(`${f.path}/actions/${action}`, { method: 'POST', headers: { ...f.headers(), cookie },
      body: JSON.stringify({ expectedVersions: { [`Encounter/${f.started.encounterId}`]: before.encounter.versionId }, input }) })
    expect(response.status).toBe(403)
  }
  expect((await f.readCase()).clinicalDocument).toEqual(before.clinicalDocument)
  expect(await f.read()).toEqual(state)
})

it.each(['encounter.clinical-document.draft.set', 'doctor.document-quality.check', 'doctor.document-quality.retain'])(
  'accepts a narrow %s Agent Grant without requiring unrelated consultation permissions', async operationId => {
    const f = await setup()
    const grant = await qualityGrant(f, operationId)
    expect(grant.operationIds).not.toContain('encounter.consultation.ask')
    const headers = { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() }
    const read = async () => {
      const response = await f.runtime.app.request(f.path, { headers })
      expect(response.status).toBe(200)
      return clinicalDocumentQualityControlStateSchema.parse(await response.json())
    }
    const state = await read()
    const detail = await f.readCase()
    const draft = operationId === 'encounter.clinical-document.draft.set'
    const input = draft ? { expectedDraftVersion: 0, document: { assessment: '', chiefComplaint: 'Agent 自述头晕一周。',
      disposition: '', followUp: '', physicalExamination: '', historyOfPresentIllness: '' } }
      : operationId.endsWith('.check') ? { expectedDraftVersion: 0 }
        : { issueId: state.issues[0]!.id, expectedInputFingerprint: state.inputFingerprint }
    const path = draft ? `/api/his/v1/encounters/${f.started.encounterId}/clinical-document/draft`
      : `${f.path}/actions/${operationId.endsWith('.check') ? 'check' : 'retain'}`
    const response = await f.runtime.app.request(path, { method: draft ? 'PUT' : 'POST', headers,
      body: JSON.stringify({ expectedVersions: { [`Encounter/${f.started.encounterId}`]: detail.encounter.versionId }, input }) })
    expect(response.status, await response.clone().text()).toBe(200)
    await f.runtime.dispatchPending()
    if (operationId.endsWith('.retain')) expect((await read()).issues[0]!.status).toBe('retained')
    else expect(await read()).toMatchObject({ status: 'ready', stale: false })
    if (draft) expect((await read()).issues).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'agent-source', field: 'chiefComplaint' })]))
    for (const [path, input] of [
      ['actions/ask-consultation-question', { expectedConsultationVersion: detail.consultation!.version, message: '请继续说说病史。' }],
      ['consultation-recording/actions/control', { action: 'resume', expectedRecordingVersion: detail.consultationRecording!.version }],
    ] as const) expect((await f.runtime.app.request(`/api/his/v1/encounters/${f.started.encounterId}/${path}`, { method: 'POST',
      headers: { ...headers, 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {
        [`Encounter/${f.started.encounterId}`]: detail.encounter.versionId, [`Task/${detail.taskId}`]: detail.taskVersion,
      }, input }) })).status).toBe(403)
  },
)

it.each(['revoked', 'expired'] as const)('discards an in-flight quality result after its original Agent Grant is %s and permits trusted recovery', async invalidation => {
  let clock = Date.now()
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const f = await setup(async () => { enter(); await held; return { issues: [], agentFactChecks: [] } },
    new StubSyntheaProvider(), undefined, () => new Date(clock))
  const grant = await qualityGrant(f, 'doctor.document-quality.check', 60)
  const headers = { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() }
  const detail = await f.readCase()
  expect((await f.runtime.app.request(`${f.path}/actions/check`, { method: 'POST', headers,
    body: JSON.stringify({ expectedVersions: { [`Encounter/${f.started.encounterId}`]: detail.encounter.versionId }, input: { expectedDraftVersion: 0 } }) })).status).toBe(200)
  const dispatch = f.runtime.dispatchPending()
  await entered
  try {
    if (invalidation === 'expired') clock += 61_000
    else expect((await f.runtime.app.request(`/api/agent/v1/grants/${grant.grantId}/actions/revoke`, { method: 'POST',
      headers: { ...f.headers(), cookie: f.started.adminCookie }, body: '{}' })).status).toBe(200)
  } finally { release() }
  await dispatch
  expect((await f.runtime.app.request(f.path, { headers })).status).toBe(401)
  expect(await f.read()).toMatchObject({ status: 'pending', stale: true })
  expect((await f.readCase()).clinicalDocument?.draft).toBeUndefined()
  expect((await f.mutate('check', { expectedDraftVersion: 0, refresh: true })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(await f.read()).toMatchObject({ status: 'ready', stale: false })
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
    explanation: { impact: '候选声称遗漏了外部事实。', suggestion: '核对来源是否属于本病例。' },
    sourceQuotes: [{ evidenceId: 'source-from-another-case', quote: '不存在的患者事实。' }] }], agentFactChecks: [] }))
  expect((await f.save({ chiefComplaint: '头晕。' })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(await f.read()).toMatchObject({ status: 'failed', errorCode: 'AI_RESPONSE_INVALID', failure: { stage: 'generation', reason: 'invalid-source' } })
  expect((await f.read()).issues.some(issue => issue.kind === 'omission')).toBe(false)
  expect((await f.read()).issues.some(issue => issue.kind === 'missing-field')).toBe(true)
})

it.each(['invalid-json', 'invalid-shape', 'invalid-scope', 'invalid-coverage'] as const)('preserves the safe %s reason and stage after bounded correction fails', async reason => {
  const calls: string[] = []
  const f = await setup(input => {
    calls.push(input.schemaName)
    if (reason === 'invalid-json') return Response.json({ model: encodeModelRoute({ provider: 'synthetic', model: 'synthetic' }), content: '{private-invalid-json-body' })
    if (reason === 'invalid-shape') return { issues: [] }
    if (reason === 'invalid-coverage' && input.schemaName === 'clinical_document_quality_verification') return { issues: [], agentFactChecks: [] }
    return { issues: [{ kind: 'missing-field', field: reason === 'invalid-scope' ? 'priorMedicalHistory' : 'chiefComplaint',
      message: '需核对已知病史的持续时间。', documentQuote: '头晕。', sourceQuotes: [],
      explanation: { impact: '记录未说明已知病程。', suggestion: '核对已有原文后记录。' } }], agentFactChecks: [] }
  })
  expect((await f.save({ chiefComplaint: '头晕。', priorMedicalHistory: '头晕。' })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(await f.read()).toMatchObject({ status: 'failed', errorCode: 'AI_RESPONSE_INVALID',
    failure: { stage: reason === 'invalid-coverage' ? 'verification' : 'generation', reason } })
  expect(calls).toHaveLength(reason === 'invalid-coverage' ? 3 : 2)
  const returned = JSON.stringify(await f.read())
  expect(returned).not.toContain('private-invalid-json-body')
  expect(returned).not.toContain('SyntaxError')
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
  expect((await request('sign', { previewId: preview.previewId, commitToken: preview.commitToken })).status).toBe(200)
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
  expect(new Set(state.notices).size).toBe(state.notices.length)
  for (const issue of state.issues.slice(0, 12)) expect((await f.mutate('retain', {
    issueId: issue.id, expectedInputFingerprint: state.inputFingerprint,
  })).status).toBe(200)
  expect((await f.read()).issues.filter(issue => issue.status === 'retained')).toHaveLength(12)
  expect((await f.readCase()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(text)
})

it('keeps deterministic checks available without a configured model and leaves semantic quality explicitly unavailable', async () => {
  const f = await setup()
  await f.restartWithoutModel()
  expect((await f.save({ chiefComplaint: '头晕一天。' })).status).toBe(200)
  expect(await f.read()).toMatchObject({ status: 'unavailable', issues: expect.arrayContaining([expect.objectContaining({ field: 'assessment', kind: 'missing-field' })]) })
  expect((await f.read()).notices.join('')).toContain('语义检查尚未完成')
})

it('does not automatically include all prior conditions in real-time quality', async () => {
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
  expect((await f.read()).status).toBe('ready')
  expect(modelCalls).toBeGreaterThan(0)
  const row = z.object({ input_json: z.string() }).parse(f.runtime.database.driver.prepare(`
    SELECT input_json FROM clinical_document_quality WHERE case_id = ? AND scope_key = 'saved'
  `).get(f.started.outpatientCaseId))
  expect(row.input_json).not.toContain('第209项合成公开病史')
  expect((await f.readCase()).clinicalDocument!.draft!.chiefComplaint).toBe('头晕一周。')
})

it('reports incomplete quality for an oversized current document without truncating saved text or calling the model', async () => {
  let modelCalls = 0
  const f = await setup(() => { modelCalls += 1; return { issues: [], agentFactChecks: [] } })
  const text = '这是一段合成病历原文。'.repeat(300)
  const document = { chiefComplaint: '头晕一周。', historyOfPresentIllness: text, priorMedicalHistory: text,
    familyHistory: text, allergyHistory: text, auxiliaryExamination: text, physicalExamination: text,
    assessment: text, disposition: text, followUp: text }
  expect((await f.save(document)).status).toBe(200)
  await f.runtime.dispatchPending()
  expect(await f.read()).toMatchObject({ status: 'incomplete', errorCode: 'INPUT_TOO_LARGE' })
  expect(modelCalls).toBe(0)
  expect((await f.readCase()).clinicalDocument!.draft).toMatchObject(document)
})

it('rejects circular document-only omissions and duplicate statements posed as factual contradictions', async () => {
  let duplicate = false
  const f = await setup(input => {
    const payload = qualityPayloadSchema.parse(input.userPayload)
    const source = payload.evidence.find(item => item.kind === (duplicate ? 'patient' : 'document'))!
    return { issues: [{ kind: duplicate ? 'inconsistency' : 'omission', field: 'historyOfPresentIllness', message: '无效问题依据。',
      explanation: { impact: '候选引用了循环依据或重复语句。', suggestion: '不能用正文证明其自身遗漏，也不能把相同语句当作互斥。' },
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

it('keeps Agent source warnings when an unsaved manual prefix moves the fragment within the same field', async () => {
  const f = await setup()
  const agentText = 'Agent 记录：近期反复口渴。'
  expect((await f.save({ assessment: agentText }, { agentGenerated: true })).status).toBe(200)
  const saved = (await f.readCase()).clinicalDocument!.draft!
  const { version, updatedAt: _updatedAt, ...document } = saved
  const response = await f.mutate('check', { expectedDraftVersion: version, clientId: 'editor-prefix', clientRevision: 1,
    document: { ...document, assessment: `医生补充：待复查。\n${agentText}` } })
  expect(response.status).toBe(200)
  const candidate = await f.read('editor-prefix')
  expect(candidate.issues.filter(issue => issue.kind === 'agent-source').flatMap(issue => issue.evidence.map(item => item.text)))
    .toEqual([agentText])
  expect((await f.readCase()).clinicalDocument!.draft).toEqual(saved)
})

it('accepts newly supplied sources for unchanged Agent text without attributing unchanged handwritten text to the Agent', async () => {
  const f = await setup(input => {
    const payload = qualityPayloadSchema.parse(input.userPayload)
    return { issues: [], agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })) }
  })
  const source = (await f.readCase()).consultation!.turns.find(turn => turn.speaker === 'patient')!
  const manual = '医生保留原评估。'
  expect((await f.save({ assessment: manual })).status).toBe(200)
  const document = { chiefComplaint: source.messageText, assessment: manual }
  expect((await f.save(document, { agentGenerated: true })).status).toBe(200)
  expect((await f.read()).issues.filter(issue => issue.kind === 'agent-source').map(issue => issue.field)).toEqual(['chiefComplaint'])
  expect((await f.save(document, { agentGenerated: true, agentFacts: [
    { field: 'chiefComplaint', text: source.messageText, sources: [{ sourceTurnId: source.id, quote: source.messageText }] },
    { field: 'assessment', text: manual, sources: [] },
  ] })).status).toBe(200)
  await f.runtime.dispatchPending()
  expect((await f.read()).issues.filter(issue => issue.kind === 'agent-source')).toEqual([])
  expect((await f.read()).status).toBe('ready')
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
