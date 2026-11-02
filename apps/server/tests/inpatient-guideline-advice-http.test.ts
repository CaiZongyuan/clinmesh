import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { inpatientGuidelineAdviceSchema, inpatientGuidelineAdviceResponseSchema } from '@clinmesh/contracts/inpatient-guideline-advice'
import { inpatientSurgerySchema, inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { modelUsageListSchema } from '@clinmesh/contracts/model-usage'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { agentClientSchema, agentCapabilityGrantSchema } from '@clinmesh/contracts/agent'
import { pciAgentParameters, pciAgentGeneration, pciAgentVerification } from './fixtures/inpatient-drg-agent.ts'
import { GuidelineCorpus } from '../src/infrastructure/sqlite/guideline-corpus.ts'
import type { GuidelineDocument } from '../src/application/guideline-corpus.ts'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { createPciPaymentDrgFixture, preparePciPaymentDrgFixture } from './fixtures/pci-payment-drg.ts'

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
      status: 'active', license: { id: 'CC0', url: 'https://example.test/license', usage: 'open' }, topics: [],
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
  expect(state.missing.join()).toContain('尚无本次正式造影报告')
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
  await completed.fixture.executePci(completed.stay)
  expect(await completed.read()).toMatchObject({ status: 'frozen', result: original.result })
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
    database.exec("DELETE FROM outbox_event WHERE kind='inpatient.guideline-advice.prepare'; DROP TABLE inpatient_guideline_advice; DELETE FROM schema_migration WHERE migration_id='0108_inpatient-guideline-advice.sql'")
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
  const surgery = await s.fixture.runtime.app.request(`${s.stay.path}/surgeries/request`, { method: 'POST',
    headers: { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ input: {} }) })
  expect(surgery.status).toBe(403)
  expect((await control(`/api/agent/v1/grants/${grant.grantId}/revoke`, {})).status).toBe(200)
  expect(await s.read()).toMatchObject({ status: 'stale', result: null })
  expect(s.calls).toHaveLength(2)
})
