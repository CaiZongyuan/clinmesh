import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { guidelineTopicBundleSchema, guidelineTopicIds, type GuidelineTopicId } from '@clinmesh/contracts/guideline-topics'
import { inpatientGuidelineAdviceListSchema, inpatientGuidelineAdviceSchema, inpatientGuidelineAdviceResponseSchema } from '@clinmesh/contracts/inpatient-guideline-advice'
import { inpatientSurgerySchema, inpatientSurgeryResponseSchema, inpatientSurgeryCatalogSchema, inpatientSurgeryRequestBodySchema } from '@clinmesh/contracts/inpatient-surgery'
import {
  apiErrorSchema,
  createPatientResponseSchema,
  doctorQueueSchema,
  registrationCatalogSchema,
  registrationResponseSchema,
  startVisitResponseSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientPciSelectionSchema, inpatientPciSelectionResponseSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { modelUsageListSchema } from '@clinmesh/contracts/model-usage'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { agentClientSchema, agentCapabilityGrantSchema, revokedAgentCapabilityGrantSchema } from '@clinmesh/contracts/agent'
import { pciAgentParameters, pciAgentGeneration, pciAgentVerification } from './fixtures/inpatient-drg-agent.ts'
import { GuidelineCorpus } from '../src/infrastructure/sqlite/guideline-corpus.ts'
import type { GuidelineDocument } from '../src/application/guideline-corpus.ts'
import { getGuidelineTopicDefinition, legacyPciStentTopicFingerprintIfUnchanged } from '../src/application/guideline-topic-registry.ts'
import { canonicalJsonHash } from '../src/application/scenario-data/canonical-json.ts'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { createPciPaymentDrgFixture, preparePciPaymentDrgFixture } from './fixtures/pci-payment-drg.ts'
import { setHospitalPatientBirthDate } from './fixtures/guideline-corpus.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose() })
const paragraphs = [
  'In patients undergoing PCI, DES should be used in preference to BMS. Synthetic test passage; assess the clinical population.',
  'IVUS can be useful, particularly in left main or complex coronary artery stenting. OCT is a reasonable alternative, except in ostial left main disease.',
  'Evaluate both proximal and distal reference segments, with lumen, EEM, and plaque measurements. With manual pullback, length cannot be measured without a longitudinal acquisition.',
]
function documents(): GuidelineDocument[] {
  return [{ id: 'coronary-10-2021', hash: '9843131ad84f9a261ceb8857025e656a067496472edabfb6bd2b6297f2c5ff0e',
    title: '合成血运重建指南测试原文', pages: [35, 36], texts: paragraphs.slice(0, 2) },
  { id: 'coronary-15-2021', hash: 'c2018438f6bfe9abf39cdfa813f6a6312de858bb6047ce18d9a01bff222ae9ad',
    title: '合成CVIT测量共识测试原文', pages: [6], texts: paragraphs.slice(2) }].map(item => ({ source: {
      id: item.id, title: item.title, publisher: '合成验收机构', documentType: 'guideline', version: '2021',
      url: `https://example.test/${item.id}`, sha256: item.hash, format: 'pdf', scope: '仅用于合成HTTP合同，非真实临床原件',
      status: 'active', population: 'adult', specialty: 'cardiology',
      license: { id: 'CC0', url: 'https://example.test/license', usage: 'open' }, topics: [],
    }, passages: item.pages.map((page, index) => ({ locator: `PDF 物理第 ${page} 页`, text: item.texts[index]! })) }))
}
const modelInput = z.object({ guidelines: z.array(z.object({ id: z.string(), text: z.string() })), missing: z.array(z.string()) }).passthrough()

async function setup(options: { sources?: GuidelineDocument[]; metered?: boolean; policy?: 'default' | 'internal-testing';
  respond?: (feature: string, input: unknown, fallback: unknown, index: number) => unknown | Promise<unknown> } = {}) {
  const prepared = await preparePciPaymentDrgFixture()
  cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))
  const databasePath = join(prepared.directory, 'guidelines.sqlite'), writer = new GuidelineCorpus({ databasePath })
  cleanups.push(() => writer.close())
  if ((options.sources ?? documents()).length > 0) writer.importDocuments(options.sources ?? documents())
  const calls: Array<{ feature: string; input: unknown }> = []
  prepared.options.guidelineDatabasePath = databasePath
  if (options.policy !== undefined) prepared.options.guidelineDeploymentPolicy = options.policy
  prepared.options.consultationModel = 'synthetic-guideline-model'
  prepared.options.chatCompletionsProvider = new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid/v1',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)), feature: string = body.response_format?.json_schema?.name ?? body.tools?.[0]?.function?.name
      const input = JSON.parse(body.messages[1].content)
      calls.push({ feature, input })
      const evidence = modelInput.safeParse(input)
      if (!evidence.success) return Response.json({ id: `synthetic-material-${calls.length}`, model: 'synthetic-guideline-model',
        choices: [{ message: { content: JSON.stringify(feature === 'inpatient_drg_recommendation' ? pciAgentGeneration : pciAgentVerification) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
      const fallback = feature === 'inpatient_drg_recommendation' ? { conclusions: [
        { kind: 'stent-category', applicability: 'conditional', text: '已提出PCI计划，可核对DES相对BMS的类别依据；患者具体适用尚待核实。',
          citations: [{ evidenceId: evidence.data.guidelines[0]!.id, quote: 'In patients undergoing PCI, DES should be used in preference to BMS.' }] },
        { kind: 'imaging-guidance', applicability: 'conditional', text: 'IVUS可用于介入指导，尤其左主干或复杂支架置入；OCT替代有左主干开口限制，不是所有PCI必做。',
          citations: [{ evidenceId: evidence.data.guidelines[1]!.id, quote: paragraphs[1]! }] },
        { kind: 'measurement-requirements', applicability: 'conditional', text: '需区分近远端参考段及管腔、EEM和斑块测量；无纵向采集的手动回撤不能据此测长。',
          citations: [{ evidenceId: evidence.data.guidelines[2]!.id, quote: paragraphs[2]! }] },
      ] } : { conclusions: ['stent-category', 'imaging-guidance', 'measurement-requirements'].map(kind => ({ kind,
        supported: true, populationPreserved: true, conditionsPreserved: true, strengthPreserved: true,
        noInventedMeasurements: true, noProductOrQuantity: true, reason: '合成独立核验：原文与条件一致' })) }
      const content = options.respond ? await options.respond(feature, input, fallback, calls.length) : fallback
      if (content instanceof Response) return content
      return Response.json({ id: `synthetic-guideline-${calls.length}`, model: 'synthetic-guideline-model',
        choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
    } })
  if (options.metered === false) prepared.options.chatCompletionsProvider = { completeJson: async () => { throw new Error('Must refuse before dispatch') } }
  const fixture = await createPciPaymentDrgFixture(prepared)
  cleanups.push(() => fixture.runtime.close())
  const stay = await fixture.preparePciAdmission([])
  const path = `${stay.path}/guideline-advice/${stay.requestId}`
  const read = async () => {
    const response = await fixture.request('inpatient-doctor', path)
    expect(response.status, await response.clone().text()).toBe(200)
    return inpatientGuidelineAdviceSchema.parse(await response.json())
  }
  const reprepare = async (key = randomUUID(), snapshot?: Awaited<ReturnType<typeof read>>) => {
    const current = snapshot ?? await read()
    return fixture.request('inpatient-doctor', `${stay.path}/guideline-advice/request`, {
      requestId: stay.requestId, expectedVersion: current.version, expectedFingerprint: current.fingerprint }, key)
  }
  return { fixture, prepared, stay, writer, calls, read, path, reprepare, databasePath }
}

async function cancelSingleEstimate(s: Awaited<ReturnType<typeof setup>>) {
  const estimate = (await s.fixture.read('inpatient-doctor', `${s.stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates[0]!
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/cancel`, {
    requestId: estimate.requestId, expectedVersion: estimate.version, expectedRequestVersion: estimate.requestVersion,
    expectedBasisFingerprint: estimate.basisFingerprint,
  })).status).toBe(200)
}

async function advanceTime(s: Awaited<ReturnType<typeof setup>>, expectedVirtualTime: string, targetVirtualTime: string) {
  const response = await s.fixture.request('admin', '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
    expectedVirtualTime, targetVirtualTime,
  })
  expect(response.status, await response.clone().text()).toBe(200)
}

it('有效PCI计划在无报告、未开跟进时自动准备有条件的只读意见，生成与独立核验读取同一原文', async () => {
  const s = await setup()
  expect(await s.read()).toMatchObject({ requestId: s.stay.requestId, version: 1, status: 'queued', result: null })
  const readOfficial = async () => ({
    surgery: await s.fixture.read('inpatient-doctor', `${s.stay.path}/surgeries`, inpatientSurgerySchema),
    selection: await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema),
    estimates: await s.fixture.read('inpatient-doctor', `${s.stay.path}/material-estimates`, inpatientMaterialEstimatesSchema),
    reservations: await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/reservations`, inpatientMaterialReservationListSchema),
    charges: await s.fixture.read('cashier', `${s.stay.path}/charges`, inpatientChargesSchema),
  })
  const before = await readOfficial()
  await s.fixture.runtime.dispatchPending()
  const state = await s.read()
  expect(state).toMatchObject({ status: 'incomplete', result: { conclusions: [
    { kind: 'stent-category', applicability: 'conditional' }, { kind: 'imaging-guidance' }, { kind: 'measurement-requirements' },
  ] } })
  expect(state.missing.join()).toContain('病变长度')
  expect(state.missing.join()).toContain('参考管径')
  expect(s.calls).toHaveLength(2)
  const first = modelInput.parse(s.calls[0]!.input), second = modelInput.parse(s.calls[1]!.input)
  expect(second.guidelines).toEqual(first.guidelines)
  expect(second.clinicalFacts).toEqual(first.clinicalFacts)
  expect(first.guidelines.map(item => item.text)).toEqual(paragraphs)
  expect(JSON.stringify(state.result)).not.toContain('materialId')
  expect(await readOfficial()).toEqual(before)
  expect((await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/followup`, inpatientDrgFollowupSchema)).task).toBeNull()
  await s.fixture.restart()
  await s.fixture.runtime.dispatchPending()
  expect((await s.read()).result).toEqual(state.result)
  expect(s.calls).toHaveLength(2)
})

it.each(['report-draft', 'manual-confirmation'] as const)('指南只使用所属计划的%s参数和候选，其他计划不使已发布意见过期', async source => {
  const s = await setup()
  const changeSelection = async (action: 'save' | 'confirm', input: unknown) => {
    const response = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/${action}`, input)
    expect(response.status, await response.clone().text()).toBe(200)
    return inpatientPciSelectionResponseSchema.parse(await response.json()).data
  }
  if (source === 'report-draft') {
    await s.fixture.executeAngiography(s.stay)
    expect(await s.fixture.runtime.dispatcher.dispatchOnce({ kinds: ['inpatient.angiography.report'] })).toMatchObject({ status: 'completed' })
  } else {
    await changeSelection('confirm', {
      expectedVersion: 0, parameters: { ...pciAgentParameters, requestId: s.stay.requestId },
    })
  }
  expect((await s.reprepare()).status).toBe(200)
  // Only the guideline worker runs; unrelated material preparation is outside this regression.
  for (let step = 0; step < 2; step++) await s.fixture.runtime.dispatcher.dispatchOnce({ kinds: ['inpatient.guideline-advice.prepare'] })
  const original = await s.read()
  expect(original.result).not.toBeNull()
  expect(original.missing.join()).not.toMatch(/缺少病变长度|缺少近端参考管径|缺少远端参考管径|缺少本计划适用的具体耗材候选/)
  expect(modelInput.parse(s.calls.at(-2)!.input).clinicalFacts).toMatchObject({ request: { id: s.stay.requestId },
    measurements: [expect.objectContaining({ kind: 'lesion-length', value: 12 }),
      expect.objectContaining({ value: 3 }), expect.objectContaining({ value: 3 })] })
  const pciTopicInitial = await s.fixture.read('inpatient-doctor', `${s.stay.path}/guideline-topics?topicId=pci-stent`, guidelineTopicBundleSchema)
  expect(pciTopicInitial.items[0]!.patientIndicators.find(i => i.code === 'pci-selection-plan')).toMatchObject({
    status: source === 'report-draft' ? 'present' : 'missing',
    valueText: expect.stringMatching(/长度 12mm.*近端 3mm.*远端 3mm.*选型 v1/),
    versionId: '1.s1',
  })
  const admission = await s.fixture.read('inpatient-doctor', s.stay.path, inpatientDetailSchema)
  const requested = await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/request`, {
    anesthesiaMethod: 'local-infiltration',
    encounterVersion: admission.admission.versionId,
    locationId: 'location-catheterization-lab',
    procedureId: s.stay.procedure.id,
    catalogVersion: s.stay.procedure.version,
    plannedFor: '2026-08-24T15:00:00+08:00',
    reason: '同次住院的另一项独立PCI计划',
    surgeonPractitionerId: 'practitioner-inpatient-doctor',
    surgeryType: 'elective',
  })
  expect(requested.status).toBe(200)
  const second = inpatientSurgeryResponseSchema.parse(await requested.json()).data.requests
    .find(item => item.id !== s.stay.requestId && item.plannedProcedure.coding.code === '36.0700')!
  const readSelection = () => s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)
  if (source === 'report-draft') {
    const draft = (await readSelection()).drafts!.find(item => item.requestId === second.id)!
    await changeSelection('save', {
      requestId: second.id, expectedDraftVersion: draft.version, parameters: { ...draft.parameters,
        measurements: draft.parameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, value: 17 } : item) },
    })
    expect(await s.read()).toEqual(original)
  }
  await changeSelection('confirm', {
    expectedVersion: (await readSelection()).confirmation?.version ?? 0,
    parameters: { ...pciAgentParameters, requestId: second.id,
      measurements: pciAgentParameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, value: 17 } : item) },
  })
  const pciTopicEdited = await s.fixture.read('inpatient-doctor', `${s.stay.path}/guideline-topics?topicId=pci-stent`, guidelineTopicBundleSchema)
  expect(pciTopicEdited.items[0]!.patientIndicators.find(i => i.code === 'pci-selection-plan')).toMatchObject({
    valueText: expect.stringMatching(/长度 17mm.*近端 3mm.*远端 3mm.*选型 v\d+/),
  })
  expect(await s.read()).toEqual(original)
  expect((await s.reprepare()).status).toBe(200)
  expect(s.calls).toHaveLength(2)
  if (source === 'report-draft') {
    const draft = (await readSelection()).drafts!.find(item => item.requestId === s.stay.requestId)!
    await changeSelection('save', {
      requestId: draft.requestId, expectedDraftVersion: draft.version, parameters: { ...draft.parameters,
        measurements: draft.parameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, value: 13 } : item) },
    })
  } else {
    await changeSelection('confirm', {
      expectedVersion: (await readSelection()).confirmation!.version,
      parameters: { ...pciAgentParameters, requestId: s.stay.requestId,
        measurements: pciAgentParameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, value: 13 } : item) },
    })
  }
  expect(await s.read()).toMatchObject({ status: 'stale', result: null })
  expect(s.calls).toHaveLength(2)
  expect((await s.reprepare()).status).toBe(200)
  for (let step = 0; step < 2; step++) await s.fixture.runtime.dispatcher.dispatchOnce({ kinds: ['inpatient.guideline-advice.prepare'] })
  expect(await s.read()).toMatchObject({ version: original.version + 1, result: expect.any(Object) })
  expect(modelInput.parse(s.calls.at(-2)!.input).clinicalFacts).toMatchObject({ request: { id: s.stay.requestId },
    measurements: [expect.objectContaining({ kind: 'lesion-length', value: 13 }), expect.any(Object), expect.any(Object)] })
  expect(s.calls).toHaveLength(4)
})

it.each([
  { name: '把选择性IVUS改成所有PCI必须完成', kind: 'imaging-guidance', text: '所有PCI患者必须完成IVUS检查。', flag: 'strengthPreserved' },
  { name: '从目录反推患者测量', kind: 'measurement-requirements', text: '根据目录3.0mm支架可认定患者参考管径为3.0mm。', flag: 'noInventedMeasurements' },
  { name: '从类别推固定产品与数量', kind: 'stent-category', text: '指南要求预留hospital-material-pci-stent一件。', flag: 'noProductOrQuantity' },
] as const)('独立核验拒绝$name，不发布正文或改变具体清单', async item => {
  const s = await setup({ respond: (feature, _input, fallback) => {
    const result = z.object({ conclusions: z.array(z.record(z.string(), z.unknown())) }).parse(fallback)
    return { conclusions: result.conclusions.map(conclusion => conclusion.kind !== item.kind ? conclusion
      : feature === 'inpatient_drg_recommendation' ? { ...conclusion, text: item.text }
        : { ...conclusion, [item.flag]: false, reason: '受控反例：原文不支持该推论' }) }
  } })
  await s.fixture.runtime.dispatchPending()
  expect(await s.read()).toMatchObject({ status: 'rejected', result: null, message: expect.stringContaining('未通过独立核验') })
  expect(s.calls).toHaveLength(2)
  expect((await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations).toEqual([])
})

it.each(['withdrawn', 'superseded', 'restricted', 'damaged'] as const)('来源%s后旧意见和原文停止展示，回执重放也不能恢复', async reason => {
  const s = await setup()
  await s.fixture.runtime.dispatchPending()
  const original = await s.read(), key = randomUUID()
  const response = await s.reprepare(key, original)
  expect(response.status).toBe(200)
  expect(inpatientGuidelineAdviceResponseSchema.parse(await response.json()).data.result).toEqual(original.result)
  if (reason === 'damaged') {
    const database = new Database(s.databasePath)
    try { database.prepare('UPDATE guideline_passage SET text=?').run('The original body is damaged; topic prose is not a replacement.') }
    finally { database.close() }
  } else {
    const source = documents()[0]!
    s.writer.importDocument({ ...source, source: { ...source.source,
      ...(reason === 'restricted' ? { license: { ...source.source.license, usage: 'unverified' } } : { status: reason }) }, passages: [] })
  }
  const state = await s.read()
  expect(state).toMatchObject({ status: 'no-evidence', result: null })
  expect(JSON.stringify(state)).not.toContain(paragraphs[0])
  const replayed = await s.reprepare(key, original)
  expect(replayed.status).toBe(200)
  expect(inpatientGuidelineAdviceResponseSchema.parse(await replayed.json()).data).toMatchObject({ result: null, status: 'no-evidence' })
  expect((await s.reprepare()).status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toHaveLength(2)
  expect((await s.read()).result).toBeNull()
})

it('通用Command回执只保存准备状态，不在来源撤回后泄漏旧意见或原文', async () => {
  const s = await setup()
  await s.fixture.runtime.dispatchPending()
  const key = randomUUID(), original = await s.read(), response = await s.reprepare(key, original)
  expect(response.status).toBe(200)
  expect(inpatientGuidelineAdviceResponseSchema.parse(await response.json()).data.result).toEqual(original.result)
  const document = documents()[0]!
  s.writer.importDocument({ ...document, source: { ...document.source, status: 'withdrawn' }, passages: [] })
  const queried = await s.fixture.request('inpatient-doctor', `/api/his/v1/command-receipts?operationId=inpatient.guideline-advice.request&idempotencyKey=${key}`)
  expect(queried.status).toBe(200)
  const receipt = commandReceiptLookupSchema.parse(await queried.json())
  expect(receipt).toMatchObject({ status: 'completed', response: { data: { result: null } } })
  expect(JSON.stringify(receipt)).not.toContain(paragraphs[0])
  expect(JSON.stringify(receipt)).not.toContain('已提出PCI计划，可核对DES相对BMS')
})

it('缺少必须原文时不以专题导航补造意见，新增原文后只在显式重评时派发', async () => {
  const s = await setup({ sources: [documents()[0]!] })
  expect(await s.read()).toMatchObject({ status: 'no-evidence', result: null })
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toEqual([])
  s.writer.importDocument(documents()[1]!)
  expect(await s.read()).toMatchObject({ status: 'stale', result: null })
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toEqual([])
  expect((await s.reprepare()).status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  expect(await s.read()).toMatchObject({ version: 2, status: 'incomplete', result: expect.any(Object) })
  expect(s.calls).toHaveLength(2)
})

it.each(['bytes', 'parts'] as const)('专题与完整原文超出%s预算时明确不完整，不截断后送模型', async boundary => {
  const sources = documents().map(document => ({ ...document, passages: boundary === 'bytes'
    ? document.passages.map(passage => ({ ...passage, text: `${passage.text}\n${'合成限定条件'.repeat(1000)}` }))
    : document.passages.flatMap(passage => Array.from({ length: 3 }, (_, index) => ({
      locator: `${passage.locator}，段${index + 1}`, text: passage.text,
    }))) }))
  const s = await setup({ sources })
  expect(await s.read()).toMatchObject({ status: 'no-evidence', result: null, missing: expect.arrayContaining([expect.stringContaining('预算')]) })
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toEqual([])
})

it('来源原文读取失败与尚无造影报告分别表达', async () => {
  const s = await setup()
  const database = new Database(s.databasePath)
  try { database.exec('DROP TABLE guideline_source') } finally { database.close() }
  const state = await s.read()
  expect(state).toMatchObject({ status: 'no-evidence', result: null, message: expect.stringContaining('读取失败') })
  expect(state.missing.join()).toContain('当前选型测量未关联本次正式造影报告')
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toEqual([])
})

it('计划取消阻止晚到结果，已完成手术保留有效意见只读且不重新派发', async () => {
  const cancelled = await setup()
  const surgery = await cancelled.fixture.read('inpatient-doctor', `${cancelled.stay.path}/surgeries`, inpatientSurgerySchema)
  const response = await cancelled.fixture.request('inpatient-doctor', `${cancelled.stay.path}/surgeries/cancel`, {
    requestId: cancelled.stay.requestId, expectedRequestVersion: surgery.requests[0]!.version, note: '合成取消计划' })
  expect(response.status).toBe(200)
  inpatientSurgeryResponseSchema.parse(await response.json())
  await cancelled.fixture.runtime.dispatchPending()
  expect(await cancelled.read()).toMatchObject({ status: 'cancelled', result: null })
  expect(cancelled.calls).toEqual([])
  const completed = await setup()
  await completed.fixture.runtime.dispatchPending()
  const original = await completed.read()
  // Simulate a pre-0116 migrated pci-stent row stored with the legacy topic fingerprint and frozen_readable = 0
  const pciDef = getGuidelineTopicDefinition('pci-stent')
  const legacyTopicFp = legacyPciStentTopicFingerprintIfUnchanged(pciDef)!
  expect(legacyTopicFp).not.toBe(pciDef.fingerprint)
  const storedRow = z.object({ basis_json: z.string(), result_json: z.string() }).parse(
    completed.fixture.runtime.database.driver.prepare(
      'SELECT basis_json, result_json FROM inpatient_guideline_advice WHERE admission_id = ? AND request_id = ? ORDER BY version DESC LIMIT 1',
    ).get(completed.stay.admissionId, completed.stay.requestId),
  )
  const selection = await completed.fixture.read('inpatient-doctor', `${completed.stay.path}/pci-selection`, inpatientPciSelectionSchema)
  const parameters = selection.drafts?.find(item => item.requestId === completed.stay.requestId)?.parameters
  const legacyBasis = {
    ...(JSON.parse(storedRow.basis_json) as Record<string, unknown>),
    dependencyFingerprint: canonicalJsonHash({
      candidates: selection.candidates,
      parameters,
      population: 'adult',
      topic: legacyTopicFp,
    }),
  }
  const legacyBasisFp = canonicalJsonHash(legacyBasis)
  const legacyResult = {
    ...(JSON.parse(storedRow.result_json) as Record<string, unknown>),
    fingerprint: legacyBasisFp,
    topic: { fingerprint: legacyTopicFp, id: 'pci-stent', version: pciDef.version },
  }
  completed.fixture.runtime.database.driver.prepare(
    'UPDATE inpatient_guideline_advice SET basis_json = ?, basis_fingerprint = ?, result_json = ?, frozen_readable = 0 WHERE admission_id = ? AND request_id = ?',
  ).run(JSON.stringify(legacyBasis), legacyBasisFp, JSON.stringify(legacyResult), completed.stay.admissionId, completed.stay.requestId)
  const activeLegacyRead = await completed.read()
  expect(activeLegacyRead).toMatchObject({
    fingerprint: legacyBasisFp,
    result: { fingerprint: legacyBasisFp, id: original.result!.id },
    status: original.status,
  })
  await completed.fixture.executePci(completed.stay)
  expect(await completed.read()).toMatchObject({
    fingerprint: legacyBasisFp,
    result: { conclusions: original.result!.conclusions, fingerprint: legacyBasisFp, id: original.result!.id },
    status: 'frozen',
  })
  expect((await completed.reprepare()).status).toBe(409)
  await completed.fixture.runtime.dispatchPending()
  expect(completed.calls).toHaveLength(2)
})

it('取消同次单次预计后，尚未派发的指南准备停止，不继续计费', async () => {
  const s = await setup()
  await cancelSingleEstimate(s)
  await s.fixture.runtime.dispatchPending()
  expect(await s.read()).toMatchObject({ status: 'cancelled', result: null })
  expect(s.calls).toEqual([])
})

it('取消单次预计后丢弃在途指南结果，停止独立核验；已发布意见只读且显式重评不恢复清单任务', async () => {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const s = await setup({ respond: async (_feature, _input, fallback) => { enter(); await gate; return fallback } })
  const pending = s.fixture.runtime.dispatchPending()
  try {
    await entered
    await cancelSingleEstimate(s)
    release()
    await pending
    expect(await s.read()).toMatchObject({ status: 'cancelled', result: null })
    expect(s.calls).toHaveLength(1)
  } finally { release(); await pending }
  const published = await setup()
  await published.fixture.runtime.dispatchPending()
  const original = await published.read()
  await cancelSingleEstimate(published)
  expect(await published.read()).toMatchObject({ status: 'frozen', result: original.result })
  expect((await published.reprepare()).status).toBe(200)
  await published.fixture.runtime.dispatchPending()
  expect(await published.read()).toMatchObject({ version: 2, status: 'incomplete', result: expect.any(Object) })
  expect((await published.fixture.read('inpatient-doctor', `${published.stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates[0]!.status).toBe('cancelled')
  expect(published.calls).toHaveLength(4)
})

it('缺单位且测量超出合成候选范围时仍给条件性类别意见，资料变化只在显式重评后重新准备', async () => {
  const s = await setup()
  await s.fixture.runtime.dispatchPending()
  const confirmed = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, {
    expectedVersion: 0, parameters: { ...pciAgentParameters, requestId: s.stay.requestId,
      measurements: pciAgentParameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, unit: null }
        : item.kind === 'proximal-reference-diameter' ? { ...item, value: 4 } : item) },
  })
  expect(confirmed.status).toBe(200)
  expect(await s.read()).toMatchObject({ status: 'stale', result: null })
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toHaveLength(2)
  expect((await s.reprepare()).status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  const state = await s.read()
  expect(state).toMatchObject({ status: 'incomplete', version: 2, missing: expect.arrayContaining([expect.stringContaining('单位')]),
    result: { conclusions: [expect.objectContaining({ applicability: 'conditional' }), expect.any(Object), expect.any(Object)] } })
  const input = modelInput.parse(s.calls.at(-2)!.input)
  expect(input.clinicalFacts).toMatchObject({ measurements: [expect.objectContaining({ unit: null }),
    expect.objectContaining({ value: 4 }), expect.any(Object)] })
  expect((await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations).toEqual([])
})

it('固定包用途未获准时停止派发，独立internal-testing实例才可使用已核验正文', async () => {
  const sources = documents().map(document => ({ ...document, source: { ...document.source,
    license: { ...document.source.license, usage: 'unverified' as const }, distribution: { packageId: 'synthetic-pci-guidelines',
      releaseId: 'synthetic-1', textStatus: 'verified' as const, verificationRecord: 'synthetic-verification.json' } } }))
  const restricted = await setup({ sources })
  await restricted.fixture.runtime.dispatchPending()
  expect(await restricted.read()).toMatchObject({ status: 'no-evidence', result: null })
  expect(restricted.calls).toEqual([])
  const allowed = await setup({ sources, policy: 'internal-testing' })
  await allowed.fixture.runtime.dispatchPending()
  expect(await allowed.read()).toMatchObject({ status: 'incomplete', result: expect.any(Object) })
  expect(allowed.calls).toHaveLength(2)
})

it('非空旧库升级保留原计划、费用和未开启跟进状态，历史计划只在显式准备后调用模型', async () => {
  const s = await setup()
  const original = { surgery: await s.fixture.read('inpatient-doctor', `${s.stay.path}/surgeries`, inpatientSurgerySchema),
    charges: await s.fixture.read('cashier', `${s.stay.path}/charges`, inpatientChargesSchema) }
  await s.fixture.runtime.close()
  const database = new Database(s.prepared.options.databasePath!)
  try {
    // The legacy fixture predates only this additive intent table and its automatic event.
    database.exec("DELETE FROM outbox_event WHERE kind='inpatient.guideline-advice.prepare'; DROP TABLE inpatient_guideline_advice; DELETE FROM schema_migration WHERE migration_id IN ('0108_inpatient-guideline-advice.sql','0116_guideline-topic-advice.sql')")
  } finally { database.close() }
  await s.fixture.restart()
  expect(await s.read()).toMatchObject({ version: 0, status: 'idle', result: null })
  expect(await s.fixture.read('inpatient-doctor', `${s.stay.path}/surgeries`, inpatientSurgerySchema)).toEqual(original.surgery)
  expect(await s.fixture.read('cashier', `${s.stay.path}/charges`, inpatientChargesSchema)).toEqual(original.charges)
  expect((await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/followup`, inpatientDrgFollowupSchema)).task).toBeNull()
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toEqual([])
  expect((await s.reprepare()).status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  expect(await s.read()).toMatchObject({ version: 1, status: 'incomplete', result: expect.any(Object) })
  expect(s.calls).toHaveLength(2)
})

it('模型未就绪与结果未知分别表达，未知刷新重启及显式重评均不自动重发', async () => {
  const unavailable = await setup({ metered: false })
  await unavailable.fixture.runtime.dispatchPending()
  expect(await unavailable.read()).toMatchObject({ status: 'blocked', result: null })
  expect(unavailable.calls).toEqual([])
  const unknown = await setup({ respond: () => Response.json({ error: { message: 'Synthetic upstream timeout' } }, { status: 504 }) })
  await unknown.fixture.runtime.dispatchPending()
  expect(await unknown.read()).toMatchObject({ status: 'unknown', result: null })
  expect(unknown.calls).toHaveLength(1)
  await unknown.fixture.restart()
  await unknown.fixture.runtime.dispatchPending()
  expect((await unknown.reprepare()).status).toBe(409)
  expect(unknown.calls).toHaveLength(1)
})

it('财务岗位不能读取患者指南意见，自动生成及核验按两次实际模型请求计量', async () => {
  const s = await setup()
  expect((await s.fixture.request('cashier', s.path)).status).toBe(403)
  await s.fixture.runtime.dispatchPending()
  const state = await s.read()
  const usage = await s.fixture.read('inpatient-doctor', `/api/model-usage/requests?caseId=${s.stay.admissionId}&taskId=${state.taskId}`, modelUsageListSchema)
  expect(usage.items.filter(item => item.context.taskId === state.taskId)).toHaveLength(2)
  expect(usage.items.filter(item => item.context.taskId === state.taskId).map(item => item.context.stage)).toEqual(expect.arrayContaining([
    'guideline-1-generation', 'guideline-1-verification',
  ]))
})

it('仅持有指南请求的窄Grant可显式准备，不能创建手术；撤权后旧意见停止复用', async () => {
  const s = await setup({ sources: [documents()[0]!] })
  s.writer.importDocument(documents()[1]!)
  const admin = await s.fixture.login('admin')
  const control = (path: string, input: unknown) => s.fixture.runtime.app.request(path, { method: 'POST',
    headers: { cookie: admin, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(input) })
  const client = agentClientSchema.parse(await (await control('/api/agent/v1/clients', { name: '合成指南窄授权验收' })).json())
  const grant = agentCapabilityGrantSchema.parse(await (await control('/api/agent/v1/grants', { agentClientId: client.agentClientId,
    operationIds: ['inpatient.guideline-advice.request'], practitionerRoleId: 'practitioner-role-inpatient-doctor', ttlSeconds: 3600 })).json())
  const current = await s.read()
  const requested = await s.fixture.runtime.app.request(`${s.stay.path}/guideline-advice/request`, { method: 'POST',
    headers: { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ input: { requestId: s.stay.requestId, expectedVersion: current.version, expectedFingerprint: current.fingerprint } }) })
  expect(requested.status, await requested.clone().text()).toBe(200)
  await s.fixture.runtime.dispatchPending()
  expect(await s.read()).toMatchObject({ status: 'incomplete', version: 2, result: expect.any(Object) })
  const admission = await s.fixture.read('inpatient-doctor', s.stay.path, inpatientDetailSchema)
  const catalog = await s.fixture.read('inpatient-doctor', '/api/his/v1/inpatient/surgery-catalog', inpatientSurgeryCatalogSchema)
  const procedure = catalog.procedures.find(item => item.id === s.stay.procedure.id)!
  const input = inpatientSurgeryRequestBodySchema.parse({
    anesthesiaMethod: 'local-infiltration',
    encounterVersion: admission.admission.versionId,
    locationId: 'location-catheterization-lab',
    procedureId: procedure.id,
    catalogVersion: procedure.version,
    plannedFor: '2026-08-24T15:00:00+08:00',
    reason: '窄指南授权不得创建另一项手术计划',
    surgeonPractitionerId: 'practitioner-inpatient-doctor',
    surgeryType: 'elective',
  })
  const before = await s.fixture.read('inpatient-doctor', `${s.stay.path}/surgeries`, inpatientSurgerySchema)
  const surgery = await s.fixture.runtime.app.request(`${s.stay.path}/surgeries/request`, { method: 'POST',
    headers: { authorization: `Bearer ${grant.token}`, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ input }) })
  expect(surgery.status).toBe(403)
  expect(apiErrorSchema.parse(await surgery.json()).error.code).toBe('OPERATION_NOT_ALLOWED')
  expect(await s.fixture.read('inpatient-doctor', `${s.stay.path}/surgeries`, inpatientSurgerySchema)).toEqual(before)
  const revoked = await control(`/api/agent/v1/grants/${grant.grantId}/actions/revoke`, {})
  expect(revoked.status).toBe(200)
  expect(revokedAgentCapabilityGrantSchema.parse(await revoked.json())).toMatchObject({ grantId: grant.grantId, status: 'revoked' })
  expect(await s.read()).toMatchObject({ status: 'stale', result: null })
  expect(s.calls).toHaveLength(2)
})

it('儿科或缺失出生日期患者隔离成人 PCI 指南专题，返回 no-evidence 且不发起模型请求', async () => {
  const s = await setup()
  setHospitalPatientBirthDate(s.prepared.options.databasePath, s.stay.patientId, '2014-06-01')
  const pediatricAdvice = await s.read()
  expect(pediatricAdvice).toMatchObject({ status: 'no-evidence', result: null })
  expect(pediatricAdvice.missing.join()).toContain('不可用')
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toHaveLength(0)

  setHospitalPatientBirthDate(s.prepared.options.databasePath, s.stay.patientId, undefined)
  const allOnlyAdvice = await s.read()
  expect(allOnlyAdvice).toMatchObject({ status: 'no-evidence', result: null })
  expect(allOnlyAdvice.fingerprint).not.toBe(pediatricAdvice.fingerprint)
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toHaveLength(0)
})

it('在院患者满18周岁时更新指南人群和依据指纹，显式重评后读取成人原文', async () => {
  const s = await setup()
  setHospitalPatientBirthDate(s.prepared.options.databasePath, s.stay.patientId, '2008-08-25')
  const pediatric = await s.read()
  expect(pediatric).toMatchObject({ status: 'no-evidence', result: null })
  expect((await s.reprepare()).status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toHaveLength(0)

  await advanceTime(s, '2026-08-24T09:00:00+08:00', '2026-08-24T23:59:59+08:00')
  expect(await s.read()).toMatchObject({ status: 'no-evidence', fingerprint: pediatric.fingerprint, result: null })

  await advanceTime(s, '2026-08-24T23:59:59+08:00', '2026-08-25T00:00:00+08:00')
  const adult = await s.read()
  expect(adult).toMatchObject({ status: 'stale', result: null })
  expect(adult.fingerprint).not.toBe(pediatric.fingerprint)
  expect(s.calls).toHaveLength(0)
  expect((await s.reprepare()).status).toBe(200)
  for (let step = 0; step < 2; step++) await s.fixture.runtime.dispatcher.dispatchOnce({ kinds: ['inpatient.guideline-advice.prepare'] })
  const evaluated = await s.read()
  expect(evaluated).toMatchObject({ status: 'incomplete', result: { guidelines: expect.any(Array) } })
  expect(s.calls).toHaveLength(2)
  expect(modelInput.parse(s.calls[0]!.input).guidelines.map(item => item.text)).toEqual(paragraphs)

  await advanceTime(s, '2026-08-25T00:00:00+08:00', '2026-08-25T01:00:00+08:00')
  expect(await s.read()).toEqual(evaluated)
  expect(s.calls).toHaveLength(2)
})

it('已出区患者跨18周岁生日仍按离院时间保留指南人群，召回后恢复按当前时间判断', async () => {
  const s = await setup()
  setHospitalPatientBirthDate(s.prepared.options.databasePath, s.stay.patientId, '2008-08-25')
  expect((await s.reprepare()).status).toBe(200)
  const surgery = await s.fixture.read('inpatient-doctor', `${s.stay.path}/surgeries`, inpatientSurgerySchema)
  const cancelled = await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/cancel`, {
    requestId: s.stay.requestId, expectedRequestVersion: surgery.requests[0]!.version, note: '合成取消计划后出区',
  })
  expect(cancelled.status).toBe(200)
  await s.fixture.depart(s.stay)
  const departed = await s.read()
  expect(departed).toMatchObject({ status: 'cancelled', result: null })

  await advanceTime(s, '2026-08-24T09:00:00+08:00', '2026-08-25T00:00:00+08:00')
  expect(await s.read()).toEqual(departed)
  const current = await s.fixture.read('inpatient-doctor', s.stay.path, inpatientDetailSchema)
  const recalled = await s.fixture.request('inpatient-doctor', `${s.stay.path}/discharge/recall`, {
    encounterVersion: current.admission.versionId, reason: '合成召回后按当前年龄核对指南',
  })
  expect(recalled.status).toBe(200)
  expect((await s.read()).fingerprint).not.toBe(departed.fingerprint)
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toHaveLength(0)
})

function fullTopicDocuments(): GuidelineDocument[] {
  const bySource = new Map<string, {
    pages: Map<number, string[]>
    sha256: string
    specialty: 'cardiology' | 'endocrinology'
    title: string
    version: string
  }>()
  for (const topicId of guidelineTopicIds) {
    const def = getGuidelineTopicDefinition(topicId)
    for (const ref of def.references) {
      let entry = bySource.get(ref.sourceId)
      if (!entry) {
        entry = {
          pages: new Map(),
          sha256: ref.sha256,
          specialty: def.specialty,
          title: ref.title,
          version: ref.version,
        }
        bySource.set(ref.sourceId, entry)
      }
      const list = entry.pages.get(ref.page) ?? []
      for (const frag of ref.fragments) {
        if (!list.includes(frag)) list.push(frag)
      }
      entry.pages.set(ref.page, list)
    }
  }
  return [...bySource.entries()].map(([sourceId, entry]) => ({
    passages: [...entry.pages.entries()]
      .sort(([a], [b]) => a - b)
      .map(([page, fragments]) => ({
        locator: `PDF 物理第 ${page} 页`,
        text: `${fragments.join('。 ')}（仅供合成HTTP集成测试核验）`,
      })),
    source: {
      documentType: 'guideline',
      format: 'pdf',
      id: sourceId,
      license: { id: 'CC0', url: 'https://example.test/license', usage: 'open' },
      population: 'adult',
      publisher: '合成验收机构',
      scope: '仅用于合成HTTP合同，非真实临床原件',
      sha256: entry.sha256,
      specialty: entry.specialty,
      status: 'active',
      title: entry.title,
      topics: [],
      url: `https://example.test/${sourceId}`,
      version: entry.version,
    },
  }))
}

it('0108 存量数据经 0116 表重建迁移自动回填 pci-stent，并约束 request_id 可空唯一键与手术复合外键', async () => {
  const s = await setup()
  await s.fixture.runtime.dispatchPending()
  const before = await s.read()
  expect(before).toMatchObject({ topicId: 'pci-stent', requestId: s.stay.requestId, status: 'incomplete' })

  await s.fixture.runtime.close()
  const database = new Database(s.prepared.options.databasePath!)
  try {
    const saved = database.prepare('SELECT * FROM inpatient_guideline_advice WHERE request_id = ?').get(s.stay.requestId) as Record<string, unknown>
    database.exec(`
      DROP TABLE inpatient_guideline_advice;
      CREATE TABLE inpatient_guideline_advice (
        workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, task_id TEXT NOT NULL,
        admission_id TEXT NOT NULL, request_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
        context_json TEXT NOT NULL CHECK(json_valid(context_json)),
        basis_json TEXT NOT NULL CHECK(json_valid(basis_json)), basis_fingerprint TEXT NOT NULL,
        trigger TEXT NOT NULL CHECK(trigger IN ('automatic','manual')),
        cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1)),
        status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','no-evidence','blocked','unknown','rejected','failed','stale')),
        error_code TEXT, result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)), created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id,epoch,task_id,version), UNIQUE(workspace_id,epoch,request_id,version),
        FOREIGN KEY(workspace_id,epoch,admission_id) REFERENCES inpatient_admission(workspace_id,epoch,admission_id) ON DELETE RESTRICT,
        FOREIGN KEY(workspace_id,epoch,request_id) REFERENCES inpatient_surgery_request(workspace_id,epoch,request_id) ON DELETE RESTRICT
      ) STRICT;
      DELETE FROM schema_migration WHERE migration_id = '0116_guideline-topic-advice.sql';
    `)
    database.prepare(`
      INSERT INTO inpatient_guideline_advice (
        workspace_id, epoch, task_id, admission_id, request_id, version,
        context_json, basis_json, basis_fingerprint, trigger, cancelled, status, error_code, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      saved.workspace_id, saved.epoch, saved.task_id, saved.admission_id, saved.request_id, saved.version,
      saved.context_json, saved.basis_json, saved.basis_fingerprint, saved.trigger, saved.cancelled,
      saved.status, saved.error_code, saved.result_json, saved.created_at,
    )
  } finally {
    database.close()
  }

  await s.fixture.restart()
  const after = await s.read()
  expect(after).toEqual(before)

  const checkDb = new Database(s.prepared.options.databasePath!)
  try {
    checkDb.pragma('foreign_keys = ON')
    const baseRow = checkDb.prepare('SELECT * FROM inpatient_guideline_advice LIMIT 1').get() as Record<string, unknown>
    expect(() => checkDb.prepare(`
      INSERT INTO inpatient_guideline_advice (
        workspace_id, epoch, task_id, admission_id, topic_id, request_id, version,
        context_json, basis_json, basis_fingerprint, trigger, status, created_at
      ) VALUES (?, ?, ?, ?, 'pci-stent', 'non-existent-surgery', 1, ?, ?, ?, 'manual', 'queued', ?)
    `).run(
      baseRow.workspace_id, baseRow.epoch, randomUUID(), baseRow.admission_id,
      baseRow.context_json, baseRow.basis_json, baseRow.basis_fingerprint, baseRow.created_at,
    )).toThrow()

    checkDb.prepare(`
      INSERT INTO inpatient_guideline_advice (
        workspace_id, epoch, task_id, admission_id, topic_id, request_id, version,
        context_json, basis_json, basis_fingerprint, trigger, status, created_at
      ) VALUES (?, ?, ?, ?, 'contrast-kidney-hydration', NULL, 1, ?, ?, ?, 'manual', 'queued', ?)
    `).run(
      baseRow.workspace_id, baseRow.epoch, randomUUID(), baseRow.admission_id,
      baseRow.context_json, baseRow.basis_json, baseRow.basis_fingerprint, baseRow.created_at,
    )

    expect(() => checkDb.prepare(`
      INSERT INTO inpatient_guideline_advice (
        workspace_id, epoch, task_id, admission_id, topic_id, request_id, version,
        context_json, basis_json, basis_fingerprint, trigger, status, created_at
      ) VALUES (?, ?, ?, ?, 'contrast-kidney-hydration', NULL, 1, ?, ?, ?, 'manual', 'queued', ?)
    `).run(
      baseRow.workspace_id, baseRow.epoch, randomUUID(), baseRow.admission_id,
      baseRow.context_json, baseRow.basis_json, baseRow.basis_fingerprint, baseRow.created_at,
    )).toThrow()
  } finally {
    checkDb.close()
  }
})

it('门诊与住院同步读取注册 Guideline Topic 直接返回核验原文与患者缺项，模型请求增量为 0，来源撤回降级为 unavailable', async () => {
  const s = await setup({ sources: fullTopicDocuments() })
  expect(s.calls).toHaveLength(0)

  const medicalStay = await s.fixture.admitSyntheticCase(['I25.103', 'I10.x09'], 'bed-general-2')
  const inpatientBundle = await s.fixture.read(
    'inpatient-doctor',
    `${medicalStay.path}/guideline-topics`,
    guidelineTopicBundleSchema,
  )
  expect(inpatientBundle.items.map(item => item.topic.id)).toEqual([...guidelineTopicIds])
  const nonDiabeticT2dmTopic = inpatientBundle.items.find(item => item.topic.id === 't2dm-renal-medication')!
  expect(nonDiabeticT2dmTopic.patientIndicators.find(i => i.code === 't2dm-diagnosis')).toMatchObject({ status: 'missing' })
  expect(nonDiabeticT2dmTopic.missingPatientInputs.join('；')).toContain('尚未确认 2 型糖尿病')
  const noContrastTopic = inpatientBundle.items.find(item => item.topic.id === 'contrast-kidney-hydration')!
  expect(noContrastTopic.patientIndicators.find(i => i.code === 'contrast-procedure-indication')).toMatchObject({ status: 'missing' })
  const noAcsTopic = inpatientBundle.items.find(item => item.topic.id === 'acute-chest-pain-acs')!
  expect(noAcsTopic.patientIndicators.find(i => i.code === 'acs-presentation')).toMatchObject({ status: 'missing' })
  const cadTopic = inpatientBundle.items.find(item => item.topic.id === 'cad-dapt-and-secondary-prevention')!
  expect(cadTopic.patientIndicators.find(i => i.code === 'cad-acs-eligibility')).toMatchObject({ status: 'present' })
  for (const item of inpatientBundle.items) {
    expect(item.status, item.topic.id).toBe('available')
    expect(item.guidelines.length, item.topic.id).toBeGreaterThan(0)
    expect(item.missingPatientInputs.length, item.topic.id).toBeGreaterThan(0)
  }
  expect(s.calls).toHaveLength(0)

  const patient = createPatientResponseSchema.parse(
    await (await s.fixture.request('registrar', '/api/his/v1/patients', {
      birthDate: '1965-03-10',
      gender: 'male',
      identifier: `OP-${randomUUID()}`,
      name: '合成门诊专题核对患者',
    }, randomUUID(), {})).json(),
  ).data.patient
  const regCatalog = await s.fixture.read('registrar', '/api/his/v1/catalogs/registration', registrationCatalogSchema)
  const reg = registrationResponseSchema.parse(
    await (await s.fixture.request('registrar', '/api/his/v1/registrations/actions/register', {
      departmentId: regCatalog.departments[0]!.id,
      locationId: regCatalog.locations[0]!.id,
      patientId: patient.id,
      visitDate: regCatalog.virtualDate,
      visitTypeId: regCatalog.visitTypes[0]!.id,
    }, randomUUID(), { [`Patient/${patient.id}`]: patient.versionId })).json(),
  ).data
  const triageRes = await s.fixture.request('triage', `/api/his/v1/encounters/${reg.encounterId}/actions/record-triage`, {
    acuityCode: 'level-2',
    bloodPressure: { diastolicMmHg: 86, systolicMmHg: 146 },
    chiefComplaint: '活动后胸闷痛2小时',
    oxygenSaturationPct: 97,
    pulseBpm: 92,
    respirationBpm: 18,
    temperatureC: 36.6,
  }, randomUUID(), {
    [`Encounter/${reg.encounterId}`]: '1',
    [`Task/${reg.queueTaskId}`]: '1',
  })
  expect(triageRes.status, await triageRes.clone().text()).toBe(200)
  const triaged = triageResponseSchema.parse(await triageRes.json()).data
  const startRes = await s.fixture.request('doctor', `/api/his/v1/encounters/${reg.encounterId}/actions/start-first-visit`, {}, randomUUID(), {
    [`Encounter/${reg.encounterId}`]: triaged.encounterVersion,
    [`Task/${triaged.doctorTaskId}`]: '1',
  })
  expect(startRes.status, await startRes.clone().text()).toBe(200)
  startVisitResponseSchema.parse(await startRes.json())
  const queueJson = await s.fixture.read('doctor', '/api/his/v1/doctor/queue', doctorQueueSchema)
  const opCase = queueJson.items.find(item => item.encounterId === reg.encounterId)!

  const opTopicRes = await s.fixture.request(
    'doctor',
    `/api/his/v1/doctor/cases/${opCase.caseId}/guideline-topics?topicId=acute-chest-pain-acs`,
  )
  expect(opTopicRes.status).toBe(200)
  const opBundle = guidelineTopicBundleSchema.parse(await opTopicRes.json())
  expect(opBundle.items).toHaveLength(1)
  expect(opBundle.items[0]!.status).toBe('available')
  expect(opBundle.items[0]!.guidelines.map(g => g.locator)).toEqual([
    'PDF 物理第 2 页',
    'PDF 物理第 3 页',
    'PDF 物理第 5 页',
  ])
  expect(opBundle.items[0]!.missingPatientInputs.join('；')).toContain('12 导联心电图')

  // Unrelated troponins separated by >6h (e.g. 48h apart) do NOT satisfy acute dynamic 1-6h serial retesting
  const opScenario = await s.fixture.read('admin', '/api/sim/v1/scenario-runs/current', z.object({ epoch: z.string(), workspaceId: z.string() }))
  const addOpTroponin = (issuedIso: string, value: number, interp: 'H' | 'N', includeSamplingTime = true) => {
    const scope = { epoch: opScenario.epoch, workspaceId: opScenario.workspaceId } as const
    const obs = s.fixture.runtime.fhir.create(scope, {
      code: { coding: [{ code: '2100404B', display: '高敏心肌肌钙蛋白I', system: 'urn:clinmesh:wst:886-2026' }], text: '高敏心肌肌钙蛋白I' },
      ...(includeSamplingTime ? { effectiveDateTime: issuedIso } : {}),
      encounter: { reference: `Encounter/${reg.encounterId}` },
      id: randomUUID(),
      interpretation: [{ coding: [{ code: interp }] }],
      referenceRange: [{ high: { value: 0.04 } }],
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: `Patient/${patient.id}` },
      valueQuantity: { code: 'ng/mL', system: 'http://unitsofmeasure.org', unit: 'ng/mL', value },
    })
    const dr = s.fixture.runtime.fhir.create(scope, {
      code: { text: '心肌标志物检验报告' },
      conclusion: '合成肌钙蛋白报告。',
      encounter: { reference: `Encounter/${reg.encounterId}` },
      id: randomUUID(),
      issued: issuedIso,
      resourceType: 'DiagnosticReport',
      result: [{ reference: `Observation/${obs.id}` }],
      status: 'final',
      subject: { reference: `Patient/${patient.id}` },
    })
    s.fixture.runtime.database.driver.prepare(`
      INSERT INTO laboratory_request (
        workspace_id, epoch, request_id, case_id, request_kind, catalog_item_id, reference_json,
        indication_code, service_snapshot_json, service_request_id, execution_task_id,
        diagnostic_report_id, status, version, authored_by, authored_at, reported_at
      ) VALUES (?, ?, ?, ?, 'laboratory', 'synthetic-lab-cardiac', '{}', 'clinical-assessment', '{}', ?, ?, ?, 'reported', 1, 'actor-test', ?, ?)
    `).run(scope.workspaceId, scope.epoch, randomUUID(), opCase.caseId, randomUUID(), randomUUID(), dr.id, issuedIso, issuedIso)
  }
  addOpTroponin('2026-08-22T09:00:00+08:00', 0.02, 'N')
  addOpTroponin('2026-08-24T09:00:00+08:00', 0.03, 'N')
  const wideGapBundle = guidelineTopicBundleSchema.parse(
    await (await s.fixture.request('doctor', `/api/his/v1/doctor/cases/${opCase.caseId}/guideline-topics?topicId=acute-chest-pain-acs`)).json(),
  )
  expect(wideGapBundle.items[0]!.patientIndicators.find(i => i.code === 'cardiac-troponin')?.status).toBe('missing')
  expect(wideGapBundle.items[0]!.missingPatientInputs.join('；')).toContain('1–6 小时')

  // A report issued 1.5h later whose Observation/Specimen lacks sampling time must NOT complete serial troponin verification
  addOpTroponin('2026-08-24T10:30:00+08:00', 0.02, 'N', false)
  const untimedReportBundle = guidelineTopicBundleSchema.parse(
    await (await s.fixture.request('doctor', `/api/his/v1/doctor/cases/${opCase.caseId}/guideline-topics?topicId=acute-chest-pain-acs`)).json(),
  )
  expect(untimedReportBundle.items[0]!.patientIndicators.find(i => i.code === 'cardiac-troponin')).toMatchObject({
    status: 'missing',
    valueText: expect.stringContaining('未标采样时间'),
  })

  // Adding a 2h repeat with explicit Observation sampling time within the [1h, 6h] acute window completes serial troponin verification
  addOpTroponin('2026-08-24T11:00:00+08:00', 0.02, 'N')
  const completedSerialBundle = guidelineTopicBundleSchema.parse(
    await (await s.fixture.request('doctor', `/api/his/v1/doctor/cases/${opCase.caseId}/guideline-topics?topicId=acute-chest-pain-acs`)).json(),
  )
  expect(completedSerialBundle.items[0]!.patientIndicators.find(i => i.code === 'cardiac-troponin')?.status).toBe('present')

  // A subsequent isolated normal troponin >6h later starts a new incomplete episode rather than inheriting the earlier pair
  addOpTroponin('2026-08-25T09:00:00+08:00', 0.01, 'N')
  const newIsolatedEpisodeBundle = guidelineTopicBundleSchema.parse(
    await (await s.fixture.request('doctor', `/api/his/v1/doctor/cases/${opCase.caseId}/guideline-topics?topicId=acute-chest-pain-acs`)).json(),
  )
  expect(newIsolatedEpisodeBundle.items[0]!.patientIndicators.find(i => i.code === 'cardiac-troponin')?.status).toBe('missing')

  // Non-responsible outpatient doctor cannot read another doctor's outpatient guideline-topics (returns 403)
  const prevOpResp = s.fixture.runtime.database.driver.prepare(`
    SELECT practitioner_role_id FROM outpatient_case_responsibility
    WHERE workspace_id = ? AND epoch = ? AND case_id = ?
  `).get(opScenario.workspaceId, opScenario.epoch, opCase.caseId) as { practitioner_role_id: string }
  s.fixture.runtime.database.driver.prepare(`
    UPDATE outpatient_case_responsibility SET practitioner_role_id = 'practitioner-role-administrator'
    WHERE workspace_id = ? AND epoch = ? AND case_id = ?
  `).run(opScenario.workspaceId, opScenario.epoch, opCase.caseId)
  const crossDoctorTopicRes = await s.fixture.request(
    'doctor',
    `/api/his/v1/doctor/cases/${opCase.caseId}/guideline-topics?topicId=acute-chest-pain-acs`,
  )
  expect(crossDoctorTopicRes.status).toBe(403)
  s.fixture.runtime.database.driver.prepare(`
    UPDATE outpatient_case_responsibility SET practitioner_role_id = ?
    WHERE workspace_id = ? AND epoch = ? AND case_id = ?
  `).run(prevOpResp.practitioner_role_id, opScenario.workspaceId, opScenario.epoch, opCase.caseId)

  // Completed outpatient encounter evaluates topic scores & supplementary indicators strictly at its actualPeriod.end cutoff
  const opEnc = s.fixture.runtime.fhir.read(
    { epoch: opScenario.epoch, workspaceId: opScenario.workspaceId },
    'Encounter',
    reg.encounterId,
  )
  s.fixture.runtime.fhir.update(
    { epoch: opScenario.epoch, workspaceId: opScenario.workspaceId },
    {
      ...opEnc,
      actualPeriod: { end: '2026-08-25T12:00:00+08:00', start: '2026-08-24T08:30:00+08:00' },
      status: 'completed',
    },
    opEnc.meta?.versionId ?? '1',
  )
  s.fixture.runtime.fhir.create({ epoch: opScenario.epoch, workspaceId: opScenario.workspaceId }, {
    clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
    code: { coding: [{ code: 'I25.2', display: '陈旧性心肌梗死' }], text: '陈旧性心肌梗死' },
    id: randomUUID(),
    recordedDate: '2026-09-15T10:00:00+08:00',
    resourceType: 'Condition',
    subject: { reference: `Patient/${patient.id}` },
    verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
  })
  const archivedCadBundle = guidelineTopicBundleSchema.parse(
    await (await s.fixture.request('doctor', `/api/his/v1/doctor/cases/${opCase.caseId}/guideline-topics?topicId=cad-dapt-and-secondary-prevention`)).json(),
  )
  expect(archivedCadBundle.items[0]!.patientIndicators.find(i => i.code === 'ascvd-ldl-target')?.status).toBe('missing')
  expect(archivedCadBundle.items[0]!.patientIndicators.find(i => i.code === 'cad-acs-eligibility')?.status).toBe('missing')

  const chestPainDoc = fullTopicDocuments().find(d => d.source.id === 'coronary-31-2019')!
  s.writer.importDocument({
    passages: [],
    source: { ...chestPainDoc.source, sha256: 'f'.repeat(64), status: 'withdrawn' },
  })
  const degradedRes = await s.fixture.request(
    'doctor',
    `/api/his/v1/doctor/cases/${opCase.caseId}/guideline-topics?topicId=acute-chest-pain-acs`,
  )
  const degradedBundle = guidelineTopicBundleSchema.parse(await degradedRes.json())
  expect(degradedBundle.items[0]!.status).toBe('unavailable')
  expect(degradedBundle.items[0]!.guidelines).toEqual([])
  expect(degradedBundle.items[0]!.degradedReason).toContain('不可用')
  expect(s.calls).toHaveLength(0)
})

it('无 PCI 手术申请的内科住院可按专题完成术前水化、FFR > 0.80 保守指征及二级预防评估，指标变化后指纹自动失效', async () => {
  const s = await setup({
    sources: fullTopicDocuments(),
    respond: (feature, rawInput) => {
      const parsed = z.object({
        guidelines: z.array(z.object({ id: z.string(), text: z.string() })),
        topic: z.object({ id: z.string() }),
      }).parse(rawInput)
      const topicId = parsed.topic.id as GuidelineTopicId
      const def = getGuidelineTopicDefinition(topicId)
      if (feature === 'inpatient_drg_recommendation') {
        return {
          conclusions: def.conclusionKinds.map((kind, idx) => {
            const ev = parsed.guidelines[idx % parsed.guidelines.length]!
            const quote = ev.text.split('。')[0]!
            return {
              applicability: 'conditional',
              citations: [{ evidenceId: ev.id, quote }],
              kind,
              text: `针对专题 ${topicId} 的 ${kind} 阶段条件性参考说明。`,
            }
          }),
        }
      }
      return {
        conclusions: def.conclusionKinds.map(kind => ({
          conditionsPreserved: true,
          kind,
          noInventedMeasurements: true,
          noProductOrQuantity: true,
          populationPreserved: true,
          reason: '合成独立核验通过',
          strengthPreserved: true,
          supported: true,
        })),
      }
    },
  })

  const medicalStay = await s.fixture.admitSyntheticCase(['I25.103', 'I10.x09'], 'bed-general-2')
  const initialSurgeries = await s.fixture.read('inpatient-doctor', `${medicalStay.path}/surgeries`, inpatientSurgerySchema)
  expect(initialSurgeries.requests).toEqual([])

  for (const topicId of ['contrast-kidney-hydration', 'cad-dapt-and-secondary-prevention'] as const) {
    const listBefore = await s.fixture.read(
      'inpatient-doctor',
      `${medicalStay.path}/guideline-advice?topicId=${topicId}`,
      inpatientGuidelineAdviceListSchema,
    )
    expect(listBefore.advice).toHaveLength(1)
    expect(listBefore.advice[0]).toMatchObject({
      admissionId: medicalStay.admissionId,
      requestId: null,
      status: 'idle',
      topicId,
      version: 0,
    })

    const reqRes = await s.fixture.request('inpatient-doctor', `${medicalStay.path}/guideline-advice/request`, {
      expectedFingerprint: listBefore.advice[0]!.fingerprint,
      expectedVersion: 0,
      requestId: null,
      topicId,
    })
    expect(reqRes.status, await reqRes.clone().text()).toBe(200)
    await s.fixture.runtime.dispatchPending()

    const listAfter = await s.fixture.read(
      'inpatient-doctor',
      `${medicalStay.path}/guideline-advice?topicId=${topicId}`,
      inpatientGuidelineAdviceListSchema,
    )
    expect(listAfter.advice[0]).toMatchObject({
      requestId: null,
      status: 'incomplete',
      topicId,
      version: 1,
      result: {
        conclusions: getGuidelineTopicDefinition(topicId).conclusionKinds.map(kind => ({
          applicability: 'conditional',
          kind,
        })),
      },
    })
  }

  // Diagnostic coronary angiography (88.5500) with FFR = 0.86 (> 0.80 -> conservative GDMT, zero PCI stent requests)
  const surgCat = await s.fixture.read('inpatient-doctor', '/api/his/v1/inpatient/surgery-catalog', inpatientSurgeryCatalogSchema)
  const angioProc = surgCat.procedures.find(item => item.coding.code === '88.5500')!
  const admDetail = await s.fixture.read('inpatient-doctor', medicalStay.path, inpatientDetailSchema)
  const angioReq = inpatientSurgeryResponseSchema.parse(await (await s.fixture.request('inpatient-doctor', `${medicalStay.path}/surgeries/request`, {
    anesthesiaMethod: 'local-infiltration',
    catalogVersion: angioProc.version,
    encounterVersion: admDetail.admission.versionId,
    locationId: 'location-catheterization-lab',
    plannedFor: '2026-08-24T11:00:00+08:00',
    procedureId: angioProc.id,
    reason: '诊断性冠脉造影与 FFR 功能学评估',
    surgeonPractitionerId: 'practitioner-inpatient-doctor',
    surgeryType: 'elective',
  })).json()).data.requests[0]!
  await s.fixture.request('ward-nurse', `${medicalStay.path}/surgeries/check-preop`, {
    expectedRequestVersion: angioReq.version,
    note: '造影术前核对完成',
    requestId: angioReq.id,
  })
  const preopSurg = await s.fixture.read('inpatient-doctor', `${medicalStay.path}/surgeries`, inpatientSurgerySchema)
  await s.fixture.request('inpatient-doctor', `${medicalStay.path}/surgeries/confirm-consent`, {
    expectedRequestVersion: preopSurg.requests[0]!.version,
    note: '签署造影知情同意',
    patientChoice: 'agree',
    requestId: angioReq.id,
    signerName: admDetail.admission.patientName,
    signerRole: 'patient',
  })
  const readySurg = await s.fixture.read('inpatient-doctor', `${medicalStay.path}/surgeries`, inpatientSurgerySchema)
  const angioExec = inpatientSurgeryResponseSchema.parse(await (await s.fixture.request('inpatient-doctor', `${medicalStay.path}/surgeries/execute`, {
    catalogVersion: angioProc.version,
    expectedRequestVersion: readySurg.requests[0]!.version,
    materials: [],
    note: 'LAD 中段 65% 狭窄，测 FFR 0.86（> 0.80），无 PCI 指征，转内科强化药物治疗',
    procedureId: angioProc.id,
    requestId: angioReq.id,
  })).json()).data.executions[0]!

  const db = new Database(s.prepared.options.databasePath!)
  try {
    db.prepare(`
      UPDATE inpatient_angiography_report
      SET report_json = ?
      WHERE admission_id = ? AND procedure_id = ?
    `).run(JSON.stringify({
      admissionId: medicalStay.admissionId,
      conclusion: 'LAD 中段临界狭窄，FFR 0.86 > 0.80，无功能性心肌缺血，建议优化药物保守治疗。',
      id: 'angio-ffr-negative-1',
      issuedAt: '2026-08-24T11:30:00+08:00',
      measurements: [],
      missing: [],
      procedureId: angioExec.id,
      status: 'final',
      synthetic: true,
      targetSite: null,
      version: 2,
      vessels: [{
        ffr: 0.86,
        lesionCharacteristics: '局限性偏心斑块',
        segment: '中段',
        stenosisPercent: 65,
        timiFlow: 3,
        vessel: 'LAD',
      }],
    }), medicalStay.admissionId, angioExec.id)
  } finally {
    db.close()
  }

  const revascTopics = await s.fixture.read(
    'inpatient-doctor',
    `${medicalStay.path}/guideline-topics?topicId=coronary-revascularization-indication`,
    guidelineTopicBundleSchema,
  )
  expect(revascTopics.items[0]!.patientIndicators.find(i => i.code === 'coronary-angiography')).toMatchObject({
    status: 'present',
    valueText: expect.stringContaining('LAD(中段) 狭窄 65%（FFR 0.86 > 0.80 保守治疗范围）'),
  })
  const postAngioHydrationTopics = await s.fixture.read(
    'inpatient-doctor',
    `${medicalStay.path}/guideline-topics?topicId=contrast-kidney-hydration`,
    guidelineTopicBundleSchema,
  )
  expect(postAngioHydrationTopics.items[0]!.patientIndicators.find(i => i.code === 'contrast-procedure-indication')).toMatchObject({
    status: 'missing',
  })

  // Active FHIR R5 ServiceRequest with CodeableReference (code.concept.coding/text) populates contrast-procedure-indication
  const ctaScenario = await s.fixture.read('admin', '/api/sim/v1/scenario-runs/current', z.object({ epoch: z.string(), workspaceId: z.string() }))
  const ctaSrId = randomUUID()
  const createdCtaSr = s.fixture.runtime.fhir.create({ epoch: ctaScenario.epoch, workspaceId: ctaScenario.workspaceId }, {
    code: {
      concept: {
        coding: [{ code: 'IMG-CTA-COR', display: '冠状动脉 CT 血管造影', system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/imaging-service' }],
        text: '冠状动脉 CT 血管造影',
      },
    },
    encounter: { reference: `Encounter/${medicalStay.admissionId}` },
    id: ctaSrId,
    intent: 'order',
    resourceType: 'ServiceRequest',
    status: 'active',
    subject: { reference: `Patient/${medicalStay.patientId}` },
  })
  const ctaHydrationTopics = await s.fixture.read(
    'inpatient-doctor',
    `${medicalStay.path}/guideline-topics?topicId=contrast-kidney-hydration`,
    guidelineTopicBundleSchema,
  )
  expect(ctaHydrationTopics.items[0]!.patientIndicators.find(i => i.code === 'contrast-procedure-indication')).toMatchObject({
    sourceReference: `ServiceRequest/${ctaSrId}`,
    status: 'present',
    valueText: '冠状动脉 CT 血管造影',
    versionId: '1',
  })
  s.fixture.runtime.fhir.update(
    { epoch: ctaScenario.epoch, workspaceId: ctaScenario.workspaceId },
    { ...createdCtaSr, status: 'completed' },
    createdCtaSr.meta!.versionId!,
  )

  const revascBefore = await s.fixture.read(
    'inpatient-doctor',
    `${medicalStay.path}/guideline-advice?topicId=coronary-revascularization-indication`,
    inpatientGuidelineAdviceListSchema,
  )
  const revascReq = await s.fixture.request('inpatient-doctor', `${medicalStay.path}/guideline-advice/request`, {
    expectedFingerprint: revascBefore.advice[0]!.fingerprint,
    expectedVersion: 0,
    requestId: null,
    topicId: 'coronary-revascularization-indication',
  })
  expect(revascReq.status).toBe(200)
  await s.fixture.runtime.dispatchPending()

  const revascAfter = await s.fixture.read(
    'inpatient-doctor',
    `${medicalStay.path}/guideline-advice?topicId=coronary-revascularization-indication`,
    inpatientGuidelineAdviceListSchema,
  )
  expect(revascAfter.advice[0]).toMatchObject({
    requestId: null,
    status: 'incomplete',
    topicId: 'coronary-revascularization-indication',
    version: 1,
    result: {
      conclusions: [
        { kind: 'functional-ischemia-evaluation' },
        { kind: 'revascularization-vs-gdmt' },
        { kind: 'modality-and-anatomy-scope' },
      ],
    },
  })

  // Advancing virtual time (without crossing 18th birthday) must NOT mark surgery-free advice stale!
  await advanceTime(s, '2026-08-24T09:00:00+08:00', '2026-08-24T12:00:00+08:00')
  const revascAfterClockAdvance = await s.fixture.read(
    'inpatient-doctor',
    `${medicalStay.path}/guideline-advice?topicId=coronary-revascularization-indication`,
    inpatientGuidelineAdviceListSchema,
  )
  expect(revascAfterClockAdvance.advice[0]).toEqual(revascAfter.advice[0])

  // Recording nursing vital signs with weight updates clinical scores and invalidates fingerprint -> stale!
  const currentAdm = await s.fixture.read('inpatient-doctor', medicalStay.path, inpatientDetailSchema)
  const vitalsRes = await s.fixture.request('ward-nurse', `${medicalStay.path}/vital-signs`, {
    bloodPressure: { diastolicMmHg: 78, systolicMmHg: 128 },
    encounterVersion: currentAdm.admission.versionId,
    expectedRevision: 0,
    heightCm: 172,
    oxygenSaturationPct: 98,
    pulseBpm: 72,
    respirationBpm: 16,
    temperatureC: 36.6,
    weightKg: 70,
  })
  expect(vitalsRes.status, await vitalsRes.clone().text()).toBe(200)

  const hydrationAfterVitals = await s.fixture.read(
    'inpatient-doctor',
    `${medicalStay.path}/guideline-advice?topicId=contrast-kidney-hydration`,
    inpatientGuidelineAdviceListSchema,
  )
  expect(hydrationAfterVitals.advice[0]).toMatchObject({
    requestId: null,
    status: 'stale',
    topicId: 'contrast-kidney-hydration',
    result: null,
  })

  // Re-evaluate hydration after vitals, verify active confirmed medication AllergyIntolerance invalidates basis & enters clinicalFacts, then depart!
  const hydrationRefresh = await s.fixture.request('inpatient-doctor', `${medicalStay.path}/guideline-advice/request`, {
    expectedFingerprint: hydrationAfterVitals.advice[0]!.fingerprint,
    expectedVersion: 1,
    requestId: null,
    topicId: 'contrast-kidney-hydration',
  })
  expect(hydrationRefresh.status).toBe(200)
  await s.fixture.runtime.dispatchPending()

  const activeScenario = await s.fixture.read('admin', '/api/sim/v1/scenario-runs/current', z.object({ epoch: z.string(), workspaceId: z.string() }))
  const allergyId = randomUUID()
  const createdAllergy = s.fixture.runtime.fhir.create({ epoch: activeScenario.epoch, workspaceId: activeScenario.workspaceId }, {
    category: ['medication'],
    clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical' }] },
    code: { coding: [{ code: 'clopidogrel', display: '氯吡格雷' }], text: '氯吡格雷' },
    id: allergyId,
    patient: { reference: `Patient/${medicalStay.patientId}` },
    recordedDate: '2026-08-24T11:30:00+08:00',
    resourceType: 'AllergyIntolerance',
    verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification' }] },
  })
  const hydrationAfterAllergyAdd = await s.fixture.read(
    'inpatient-doctor',
    `${medicalStay.path}/guideline-advice?topicId=contrast-kidney-hydration`,
    inpatientGuidelineAdviceListSchema,
  )
  expect(hydrationAfterAllergyAdd.advice[0]).toMatchObject({
    requestId: null,
    result: null,
    status: 'stale',
    topicId: 'contrast-kidney-hydration',
  })
  const hydrationRefreshWithAllergy = await s.fixture.request('inpatient-doctor', `${medicalStay.path}/guideline-advice/request`, {
    expectedFingerprint: hydrationAfterAllergyAdd.advice[0]!.fingerprint,
    expectedVersion: 2,
    requestId: null,
    topicId: 'contrast-kidney-hydration',
  })
  expect(hydrationRefreshWithAllergy.status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  expect(modelInput.parse(s.calls.at(-2)!.input).clinicalFacts).toMatchObject({
    medicationAllergies: [
      expect.objectContaining({
        codes: ['clopidogrel'],
        criticality: null,
        display: '氯吡格雷',
        id: allergyId,
        versionId: '1',
      }),
    ],
  })

  s.fixture.runtime.fhir.update(
    { epoch: activeScenario.epoch, workspaceId: activeScenario.workspaceId },
    {
      ...createdAllergy,
      criticality: 'high',
      reaction: [{ description: '严重皮疹伴支气管痉挛' }],
    },
    createdAllergy.meta!.versionId!,
  )
  const hydrationAfterAllergyUpdate = await s.fixture.read(
    'inpatient-doctor',
    `${medicalStay.path}/guideline-advice?topicId=contrast-kidney-hydration`,
    inpatientGuidelineAdviceListSchema,
  )
  expect(hydrationAfterAllergyUpdate.advice[0]).toMatchObject({
    requestId: null,
    result: null,
    status: 'stale',
    topicId: 'contrast-kidney-hydration',
  })
  const hydrationFinalRefresh = await s.fixture.request('inpatient-doctor', `${medicalStay.path}/guideline-advice/request`, {
    expectedFingerprint: hydrationAfterAllergyUpdate.advice[0]!.fingerprint,
    expectedVersion: 3,
    requestId: null,
    topicId: 'contrast-kidney-hydration',
  })
  expect(hydrationFinalRefresh.status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  expect(modelInput.parse(s.calls.at(-2)!.input).clinicalFacts).toMatchObject({
    medicationAllergies: [
      expect.objectContaining({
        codes: ['clopidogrel'],
        criticality: 'high',
        display: '氯吡格雷',
        id: allergyId,
        reactionText: '严重皮疹伴支气管痉挛',
        versionId: '2',
      }),
    ],
  })

  await s.fixture.depart(medicalStay)
  const hydrationAfterDepart = await s.fixture.read(
    'inpatient-doctor',
    `${medicalStay.path}/guideline-advice?topicId=contrast-kidney-hydration`,
    inpatientGuidelineAdviceListSchema,
  )
  const hydrationByMedicalRecords = await s.fixture.read(
    'medical-records',
    `${medicalStay.path}/guideline-advice?topicId=contrast-kidney-hydration`,
    inpatientGuidelineAdviceListSchema,
  )
  expect(hydrationByMedicalRecords).toEqual(hydrationAfterDepart)
  const staleDaptAfterDepart = await s.fixture.read(
    'inpatient-doctor',
    `${medicalStay.path}/guideline-advice?topicId=cad-dapt-and-secondary-prevention`,
    inpatientGuidelineAdviceListSchema,
  )
  expect(staleDaptAfterDepart.advice[0]).toMatchObject({
    requestId: null,
    result: null,
    status: 'frozen',
    topicId: 'cad-dapt-and-secondary-prevention',
  })
  expect(hydrationAfterDepart.advice[0]).toMatchObject({
    requestId: null,
    status: 'frozen',
    topicId: 'contrast-kidney-hydration',
    version: 4,
    result: {
      conclusions: [
        { kind: 'renal-risk-stratification' },
        { kind: 'hydration-and-volume-balance' },
        { kind: 'contrast-dose-control' },
      ],
    },
  })

  // Future T2DM Condition recorded days AFTER medicalStay departed must NOT retroactively populate medicalStay's archived topic read
  const depScenario = await s.fixture.read('admin', '/api/sim/v1/scenario-runs/current', z.object({ epoch: z.string(), workspaceId: z.string() }))
  s.fixture.runtime.fhir.create({ epoch: depScenario.epoch, workspaceId: depScenario.workspaceId }, {
    clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
    code: { coding: [{ code: 'E11.9', display: '2型糖尿病' }], text: '2型糖尿病' },
    id: randomUUID(),
    recordedDate: '2026-09-10T09:00:00+08:00',
    resourceType: 'Condition',
    subject: { reference: `Patient/${medicalStay.patientId}` },
    verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
  })
  // Even a valid FHIR cross-encounter Condition WITHOUT recordedDate/onset/encounter cannot bypass the archived cutoff
  s.fixture.runtime.fhir.create({ epoch: depScenario.epoch, workspaceId: depScenario.workspaceId }, {
    clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
    code: { coding: [{ code: 'E11.9', display: '2型糖尿病' }], text: '2型糖尿病' },
    id: randomUUID(),
    resourceType: 'Condition',
    subject: { reference: `Patient/${medicalStay.patientId}` },
    verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
  })
  const archivedT2dmTopics = await s.fixture.read(
    'medical-records',
    `${medicalStay.path}/guideline-topics?topicId=t2dm-renal-medication`,
    guidelineTopicBundleSchema,
  )
  expect(archivedT2dmTopics.items[0]!.patientIndicators.find(i => i.code === 't2dm-diagnosis')).toMatchObject({
    status: 'missing',
  })
})
