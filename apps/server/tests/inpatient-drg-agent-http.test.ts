import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientTransferResponseSchema } from '@clinmesh/contracts/inpatient-transfer'
import { addSecondaryInpatientWard } from './fixtures/inpatient-secondary-ward.ts'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientPaymentsSchema, inpatientPaymentPreviewResponseSchema, inpatientPaymentResponseSchema, inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientDrgPayerReviewPreviewSchema, inpatientDrgPayerReviewListSchema } from '@clinmesh/contracts/inpatient-drg-payer'
import { modelUsageControlSchema, modelUsageListSchema, modelUsageOverviewSchema } from '@clinmesh/contracts/model-usage'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDrgReviewSchema, inpatientDrgReviewResponseSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { inpatientDrgAgentSchema, inpatientDrgAgentResponseSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { inpatientDrgFollowupResponseSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientPciSelectionResponseSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { apiErrorSchema, commandResponseSchema } from '@clinmesh/contracts/his'
import { z } from 'zod'
import { inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { pciAgentParameters, pciAgentGeneration, pciAgentVerification } from './fixtures/inpatient-drg-agent.ts'
import { createPciPaymentDrgFixture, preparePciPaymentDrgFixture } from './fixtures/pci-payment-drg.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setupAgent(respond?: (feature: string, index: number, payload: unknown) => unknown | Promise<unknown>) {
  const prepared = await preparePciPaymentDrgFixture()
  cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))
  const requests: string[] = []
  prepared.options.consultationModel = 'synthetic-drg-model'
  prepared.options.chatCompletionsProvider = new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid/v1',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)), feature = body.response_format.json_schema.name
      requests.push(feature)
      const result = respond === undefined ? feature === 'inpatient_drg_recommendation' ? pciAgentGeneration : pciAgentVerification
        : await respond(feature, requests.length, JSON.parse(body.messages[1].content))
      return Response.json({ id: `synthetic-${requests.length}`, model: 'synthetic-drg-model',
        choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
    } })
  const fixture = await createPciPaymentDrgFixture(prepared)
  cleanups.push(() => fixture.runtime.close())
  const stay = await fixture.preparePciAdmission()
  const parameters = { ...pciAgentParameters, requestId: stay.requestId }
  const confirmed = await fixture.request('inpatient-doctor', `${stay.path}/pci-selection/confirm`, { expectedVersion: 0, parameters })
  expect(confirmed.status).toBe(200)
  inpatientPciSelectionResponseSchema.parse(await confirmed.json())
  return { fixture, stay, requests, parameters,
    read: () => fixture.read('inpatient-doctor', `${stay.path}/drg/agent`, inpatientDrgAgentSchema),
    start: async () => {
      const response = await fixture.request('inpatient-doctor', `${stay.path}/drg/followup/start`, {
        encounterVersion: stay.encounterVersion, expectedTaskVersion: 0,
      })
      expect(response.status).toBe(200)
      return inpatientDrgFollowupResponseSchema.parse(await response.json()).data.task!
    },
  }
}

async function setupPostoperativeAgent(postOutcome: 'verified' | 'unknown' = 'verified') {
  const s = await setupAgent((feature, _index, raw) => {
    const input = z.object({ remaining: z.array(z.object({ materialId: z.string(), quantity: z.number() })),
      proposed: z.array(z.object({ materialId: z.string() }).passthrough()).optional(),
      review: z.object({ issues: z.array(z.object({ key: z.string(), evidence: z.array(z.string()) }).passthrough()) }).passthrough().optional(),
    }).passthrough().parse(raw)
    if (postOutcome === 'unknown' && input.review) throw new Error('Synthetic postoperative transport disconnected after dispatch')
    return feature === 'inpatient_drg_recommendation'
      ? { items: pciAgentGeneration.items.filter(item => input.remaining.some(value => value.materialId === item.materialId && value.quantity > 0)),
          ...(input.review === undefined ? {} : { observations: input.review.issues.map(issue => ({ key: issue.key, explanation: '合成额外用量或记录费用核对说明', evidenceIds: issue.evidence })) }) }
      : { items: pciAgentVerification.items.filter(item => input.proposed?.some(value => value.materialId === item.materialId)),
          ...(input.review === undefined ? {} : { observations: input.review.issues.map(issue => ({ key: issue.key, supported: true, reason: '合成独立核验来源通过' })) }) }
  })
  await s.start(); await s.fixture.runtime.dispatchPending()
  const before = await s.read()
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/agent/confirm`, { analysisId: before.analysis!.id,
    expectedBasisFingerprint: before.basisFingerprint, expectedRevision: 0, note: '术前确认四类各一件',
    items: before.analysis!.items.map(item => ({ materialId: item.materialId, catalogVersion: item.catalogVersion, quantity: item.quantity, reason: '医生核对用途' })) })).status).toBe(200)
  const input = await s.fixture.pciExecutionInput(s.stay)
  const response = await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/execute`, { ...input,
    materials: input.materials.map(item => item.materialId === 'hospital-material-pci-guidewire'
      ? { materialId: item.materialId, catalogVersion: item.catalogVersion, quantity: 2 } : item) })
  expect(response.status).toBe(200)
  const execution = inpatientSurgeryResponseSchema.parse(await response.json()).data.executions[0]!
  await s.fixture.confirmMainProcedure(s.stay, execution.id)
  await s.fixture.runtime.dispatchPending()
  return { ...s, execution, review: () => s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/review`, inpatientDrgReviewSchema) }
}

it('未开启跟进时住院医生可以读取建议状态，读取不发起模型请求', async () => {
  const prepared = await preparePciPaymentDrgFixture()
  cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))
  const fixture = await createPciPaymentDrgFixture(prepared)
  cleanups.push(() => fixture.runtime.close())
  const stay = await fixture.admitSyntheticCase(['I25.103'], 'bed-general-1')
  const response = await fixture.request('inpatient-doctor', `${stay.path}/drg/agent`)
  expect(response.status).toBe(200)
  expect(inpatientDrgAgentSchema.parse(await response.json())).toMatchObject({ admissionId: stay.admissionId, taskId: null,
    status: 'inactive', analysis: null, confirmedPlan: null })
  expect(prepared.modelCalls).toBe(0)
})

it('开启跟进但未确认选型参数时只报告缺项，不调用模型', async () => {
  const prepared = await preparePciPaymentDrgFixture()
  cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))
  const fixture = await createPciPaymentDrgFixture(prepared)
  cleanups.push(() => fixture.runtime.close())
  const stay = await fixture.admitSyntheticCase(['I25.103'], 'bed-general-1')
  const started = await fixture.request('inpatient-doctor', `${stay.path}/drg/followup/start`, {
    encounterVersion: stay.encounterVersion, expectedTaskVersion: 0,
  })
  expect(started.status).toBe(200)
  const taskId = inpatientDrgFollowupResponseSchema.parse(await started.json()).data.task!.id
  await fixture.runtime.dispatchPending()
  const response = await fixture.request('inpatient-doctor', `${stay.path}/drg/agent`)
  expect(response.status).toBe(200)
  expect(inpatientDrgAgentSchema.parse(await response.json())).toMatchObject({ taskId, status: 'incomplete',
    missing: expect.arrayContaining(['尚无医生确认的选型参数']), analysis: null })
  expect(prepared.modelCalls).toBe(0)
})

it('医生仅认可部分候选时只分析该集合，未认可候选的缺项不阻断并可确认计划', async () => {
  const approvedMaterialIds = ['hospital-material-pci-guidewire', 'hospital-material-pci-guiding-catheter']
  const s = await setupAgent((feature, _index, raw) => {
    const input = z.object({ remaining: z.array(z.object({ materialId: z.string(), quantity: z.number() })) }).passthrough().parse(raw)
    expect(input.remaining).toEqual(approvedMaterialIds.map(materialId => ({ materialId, quantity: 1 })))
    return { items: (feature === 'inpatient_drg_recommendation' ? pciAgentGeneration.items : pciAgentVerification.items)
      .filter(item => approvedMaterialIds.includes(item.materialId)) }
  })
  const parameters = { ...s.parameters, approvedMaterialIds,
    plannedQuantities: s.parameters.plannedQuantities.map(item => item.category === 'balloon' ? { ...item, quantity: null } : item) }
  const response = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, { expectedVersion: 1, parameters })
  expect(response.status).toBe(200)
  const selection = inpatientPciSelectionResponseSchema.parse(await response.json()).data
  expect(selection.candidates.filter(item => !approvedMaterialIds.includes(item.materialId))
    .every(item => item.eligibility === 'incomplete' && item.missing.includes('医生尚未认可此具体候选'))).toBe(true)
  await s.start(); await s.fixture.runtime.dispatchPending()
  const state = await s.read()
  expect(state.status).toBe('succeeded')
  expect(state.missing).toEqual([])
  expect(state.analysis?.items.map(item => item.materialId).sort()).toEqual(approvedMaterialIds)
  expect(state.analysis?.sources.materialEvidence).toHaveLength(4)
  expect(s.requests).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
  const confirmation = {
    analysisId: state.analysis!.id, expectedBasisFingerprint: state.basisFingerprint, expectedRevision: 0,
    note: '医生仅确认本次已认可且核验通过的两项候选',
    items: state.analysis!.items.map(item => ({ materialId: item.materialId, catalogVersion: item.catalogVersion,
      quantity: item.quantity, reason: '医生核对本次候选用途' })),
  }
  const injected = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/agent/confirm`, { ...confirmation,
    items: [...confirmation.items, { materialId: 'hospital-material-pci-stent', catalogVersion: 1, quantity: 1, reason: '未认可候选不能加入计划' }],
  })
  expect(injected.status).toBe(409)
  expect(apiErrorSchema.parse(await injected.json()).error.code).toBe('INPATIENT_DRG_PLAN_UNSUPPORTED')
  expect((await s.read()).planHistory).toEqual([])
  const confirmed = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/agent/confirm`, confirmation)
  expect(confirmed.status).toBe(200)
  const confirmedState = inpatientDrgAgentResponseSchema.parse(await confirmed.json()).data
  expect(confirmedState.confirmedPlan?.items.map(item => item.materialId).sort()).toEqual(approvedMaterialIds)
  await s.fixture.runtime.dispatchPending()
  expect(s.requests).toHaveLength(2)
  const changed = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, {
    expectedVersion: 2, parameters: { ...parameters, approvedMaterialIds: ['hospital-material-pci-guidewire'] },
  })
  expect(changed.status).toBe(200)
  expect(await s.read()).toMatchObject({ status: 'queued', analysis: null, lastAnalysis: { id: state.analysis!.id },
    planHistory: confirmedState.planHistory })
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/agent/confirm`, confirmation)).status).toBe(409)
  expect(s.requests).toHaveLength(2)
})

it('同版本人工计划保留主动删项，认可集合扩大后按新版本重评并保留旧计划', async () => {
  const s = await setupAgent((feature, _index, raw) => {
    const input = z.object({ remaining: z.array(z.object({ materialId: z.string(), quantity: z.number() })),
      proposed: z.array(z.object({ materialId: z.string() }).passthrough()).optional() }).passthrough().parse(raw)
    return { items: feature === 'inpatient_drg_recommendation'
      ? pciAgentGeneration.items.filter(item => input.remaining.some(value => value.materialId === item.materialId && value.quantity > 0))
      : pciAgentVerification.items.filter(item => input.proposed?.some(value => value.materialId === item.materialId)) }
  })
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, {
    expectedVersion: 1, parameters: { ...s.parameters, approvedMaterialIds: ['hospital-material-pci-guidewire', 'hospital-material-pci-guiding-catheter'] },
  })).status).toBe(200)
  await s.start(); await s.fixture.runtime.dispatchPending()
  const initial = await s.read()
  expect(initial.analysis?.items).toHaveLength(2)
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/agent/confirm`, {
    analysisId: initial.analysis!.id, expectedBasisFingerprint: initial.basisFingerprint, expectedRevision: 0,
    note: '在已认可集合内人工保留导丝一项', items: initial.analysis!.items.filter(item => item.materialId === 'hospital-material-pci-guidewire')
      .map(item => ({ materialId: item.materialId, catalogVersion: item.catalogVersion, quantity: item.quantity, reason: '医生本次计划仅保留导丝' })),
  })).status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  const subset = await s.read()
  expect(subset.status).toBe('succeeded')
  expect(subset.analysis?.items.map(item => item.materialId)).toEqual(['hospital-material-pci-guidewire'])
  expect(subset.analysis?.sources.selectionVersion).toBe(2)
  expect(s.requests).toHaveLength(4)
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, {
    expectedVersion: 2, parameters: s.parameters,
  })).status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  const expanded = await s.read()
  expect(expanded.status).toBe('succeeded')
  expect(expanded.analysis?.items.map(item => item.materialId).sort()).toEqual([
    'hospital-material-pci-balloon', 'hospital-material-pci-guidewire', 'hospital-material-pci-guiding-catheter', 'hospital-material-pci-stent',
  ])
  expect(expanded.analysis?.sources.selectionVersion).toBe(3)
  expect(expanded.planHistory).toEqual(subset.planHistory)
  expect(s.requests).toEqual([
    'inpatient_drg_recommendation', 'inpatient_drg_verification',
    'inpatient_drg_recommendation', 'inpatient_drg_verification',
    'inpatient_drg_recommendation', 'inpatient_drg_verification',
  ])
})

it.each([
  { name: '没有认可产品', approvedMaterialIds: [], missing: '尚无医生认可的具体耗材候选', missingQuantity: false },
  { name: '仅有未知产品', approvedMaterialIds: ['hospital-material-unknown'], missing: 'hospital-material-unknown: 不在已发布的 PCI 候选中', missingQuantity: false },
  { name: '已知与未知产品混合', approvedMaterialIds: ['hospital-material-pci-guidewire', 'hospital-material-unknown'], missing: 'hospital-material-unknown: 不在已发布的 PCI 候选中', missingQuantity: false },
  { name: '已认可产品缺少数量依据', approvedMaterialIds: ['hospital-material-pci-stent'], missing: 'hospital-material-pci-stent: 缺少医生独立确认的预计数量及依据', missingQuantity: true },
])('认可集合：$name 时明确缺项且不派发模型', async ({ approvedMaterialIds, missing, missingQuantity }) => {
  const s = await setupAgent()
  const response = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, {
    expectedVersion: 1, parameters: { ...s.parameters, approvedMaterialIds,
      plannedQuantities: s.parameters.plannedQuantities.map(item => missingQuantity && item.category === 'stent' ? { ...item, quantity: null } : item) },
  })
  expect(response.status).toBe(200)
  await s.start(); await s.fixture.runtime.dispatchPending()
  expect(await s.read()).toMatchObject({ status: 'incomplete', analysis: null, missing: expect.arrayContaining([missing]) })
  expect(s.requests).toEqual([])
})

it('模型不能用未认可的支架替换已认可的导丝，保持无建议且不进入独立核验', async () => {
  const s = await setupAgent(feature => ({ items: (feature === 'inpatient_drg_recommendation' ? pciAgentGeneration.items : pciAgentVerification.items)
    .filter(item => item.materialId === 'hospital-material-pci-stent') }))
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, {
    expectedVersion: 1, parameters: { ...s.parameters, approvedMaterialIds: ['hospital-material-pci-guidewire'] },
  })).status).toBe(200)
  await s.start(); await s.fixture.runtime.dispatchPending()
  const result = await s.read()
  expect(result.analysis).toBeNull()
  expect(result.confirmedPlan).toBeNull()
  expect(['failed', 'unknown']).toContain(result.status)
  expect(result.failureCode).not.toBeNull()
  expect(s.requests.length).toBeGreaterThan(0)
  expect(s.requests.every(feature => feature === 'inpatient_drg_recommendation')).toBe(true)
})

it('医生确认参数后后台生成并独立核验术前建议，同依据刷新与重启复用成功结果', async () => {
  const prepared = await preparePciPaymentDrgFixture()
  cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))
  const dispatched: string[] = []
  prepared.options.consultationModel = 'synthetic-drg-model'
  prepared.options.chatCompletionsProvider = new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid/v1',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)), feature = body.response_format.json_schema.name
      dispatched.push(feature)
      expect(body.messages[1].content).toContain('synthetic-ivus-report')
      const result = feature === 'inpatient_drg_recommendation' ? pciAgentGeneration : pciAgentVerification
      return Response.json({ id: `synthetic-${dispatched.length}`, model: 'synthetic-drg-model',
        choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
    } })
  const fixture = await createPciPaymentDrgFixture(prepared)
  cleanups.push(() => fixture.runtime.close())
  const stay = await fixture.preparePciAdmission()
  const selection = await fixture.request('inpatient-doctor', `${stay.path}/pci-selection/confirm`, {
    expectedVersion: 0, parameters: { ...pciAgentParameters, requestId: stay.requestId },
  })
  expect(selection.status).toBe(200)
  inpatientPciSelectionResponseSchema.parse(await selection.json())
  const started = await fixture.request('inpatient-doctor', `${stay.path}/drg/followup/start`, {
    encounterVersion: stay.encounterVersion, expectedTaskVersion: 0,
  })
  expect(started.status).toBe(200)
  inpatientDrgFollowupResponseSchema.parse(await started.json())
  await fixture.runtime.dispatchPending()
  const read = () => fixture.read('inpatient-doctor', `${stay.path}/drg/agent`, inpatientDrgAgentSchema)
  const result = await read()
  expect(result.status).toBe('succeeded')
  expect(result.analysis?.stage).toBe('preoperative')
  expect(result.analysis).toMatchObject({ sources: { selectionVersion: 1,
    evidencePackageId: 'clinmesh-pci-selection-evidence', evidencePackageVersion: '2026-10-27.r1',
    materialEvidence: expect.arrayContaining([expect.objectContaining({ id: 'pci-evidence-stent', synthetic: true })]),
  } })
  expect(result.analysis?.items.map(item => item.materialId).sort()).toEqual([
    'hospital-material-pci-balloon', 'hospital-material-pci-guidewire', 'hospital-material-pci-guiding-catheter', 'hospital-material-pci-stent',
  ])
  expect(result.analysis?.items.reduce((sum, item) => sum + item.estimatedFen, 0)).toBe(126598)
  expect(dispatched).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
  await fixture.runtime.dispatchPending()
  expect(await read()).toEqual(result)
  await fixture.restart()
  await fixture.runtime.dispatchPending()
  expect(await read()).toEqual(result)
  expect(dispatched).toHaveLength(2)
  const key = randomUUID(), confirmation = { analysisId: result.analysis!.id, expectedBasisFingerprint: result.basisFingerprint,
    expectedRevision: 0, note: '医生逐项审阅并确认合成术前计划',
    items: result.analysis!.items.map(item => ({ materialId: item.materialId, catalogVersion: item.catalogVersion,
      quantity: item.quantity, reason: '医生确认本次计划用途与数量' })),
  }
  const confirmed = await fixture.request('inpatient-doctor', `${stay.path}/drg/agent/confirm`, confirmation, key)
  expect(confirmed.status).toBe(200)
  const receipt = inpatientDrgAgentResponseSchema.parse(await confirmed.json())
  expect(receipt.data.confirmedPlan).toMatchObject({ revision: 1, analysisId: result.analysis!.id,
    basisFingerprint: result.basisFingerprint, items: expect.any(Array) })
  expect(inpatientDrgAgentResponseSchema.parse(await (await fixture.request('inpatient-doctor', `${stay.path}/drg/agent/confirm`, confirmation, key)).json())).toEqual(receipt)
  expect(dispatched).toHaveLength(2)
})

it('关键参数更新立即使旧建议失效，旧确认及错误岗位均不能提交计划', async () => {
  const s = await setupAgent()
  await s.start()
  await s.fixture.runtime.dispatchPending()
  const original = await s.read(), input = { analysisId: original.analysis!.id, expectedBasisFingerprint: original.basisFingerprint,
    expectedRevision: 0, note: '核对权限与失效', items: original.analysis!.items.map(item => ({ materialId: item.materialId,
      catalogVersion: item.catalogVersion, quantity: item.quantity, reason: '原计划' })) }
  expect((await s.fixture.request('ward-nurse', `${s.stay.path}/drg/agent/confirm`, input)).status).toBe(403)
  const changed = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, { expectedVersion: 1,
    parameters: { ...s.parameters, measurements: s.parameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, value: 13 } : item) } })
  expect(changed.status).toBe(200)
  inpatientPciSelectionResponseSchema.parse(await changed.json())
  const current = await s.read()
  expect(current.basisFingerprint).not.toBe(original.basisFingerprint)
  expect(current.status).not.toBe('succeeded')
  const rejected = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/agent/confirm`, input)
  expect(rejected.status).toBe(409)
  expect(apiErrorSchema.parse(await rejected.json()).error.code).toBe('INPATIENT_DRG_AGENT_STALE')
  expect((await s.read()).confirmedPlan).toBeNull()
  expect(s.requests).toHaveLength(2)
})

it('生成期间的依据变化使迟到结果停止发布，不继续核验失效建议', async () => {
  let entered!: () => void, release!: () => void
  const received = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const s = await setupAgent(async (_feature, index) => { if (index === 1) { entered(); await gate }; return pciAgentGeneration })
  await s.start()
  const running = s.fixture.runtime.dispatchPending()
  try {
    await received
    const changed = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, { expectedVersion: 1,
      parameters: { ...s.parameters, measurements: s.parameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, value: null } : item) } })
    expect(changed.status).toBe(200)
    release()
    await running
    expect(await s.read()).toMatchObject({ status: 'incomplete', analysis: null, confirmedPlan: null })
    expect(s.requests).toEqual(['inpatient_drg_recommendation'])
  } finally { release(); await running }
})

it('模型结果未知在重启后保持待核查，不自动重发或将其当零用量', async () => {
  const s = await setupAgent(() => { throw new Error('Synthetic transport disconnected after dispatch') })
  await s.start()
  await s.fixture.runtime.dispatchPending()
  expect(await s.read()).toMatchObject({ status: 'unknown', failureCode: 'MODEL_OUTCOME_UNKNOWN', analysis: null })
  expect(s.requests).toHaveLength(1)
  await s.fixture.restart()
  await s.fixture.runtime.dispatchPending()
  expect(await s.read()).toMatchObject({ status: 'unknown', failureCode: 'MODEL_OUTCOME_UNKNOWN' })
  expect(s.requests).toHaveLength(1)
})

it('术中使用保留实际事实并只建议剩余部分，已用导丝不再计入后续建议', async () => {
  const s = await setupAgent((feature, _index, raw) => {
    if (feature === 'inpatient_drg_recommendation') {
      const input = z.object({ remaining: z.array(z.object({ materialId: z.string(), quantity: z.number() })) }).passthrough().parse(raw)
      return { items: pciAgentGeneration.items.filter(item => input.remaining.some(remaining => remaining.materialId === item.materialId && remaining.quantity > 0)) }
    }
    const input = z.object({ proposed: z.array(z.object({ materialId: z.string() }).passthrough()) }).passthrough().parse(raw)
    return { items: pciAgentVerification.items.filter(item => input.proposed.some(proposed => proposed.materialId === item.materialId)) }
  })
  await s.start()
  await s.fixture.runtime.dispatchPending()
  const { materials: _materials, ...ready } = await s.fixture.pciExecutionInput(s.stay)
  const started = await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/start`, ready)
  expect(started.status).toBe(200)
  const surgery = inpatientSurgeryResponseSchema.parse(await started.json()).data
  const reservation = s.stay.reservations.find(item => item.materialId === 'hospital-material-pci-guidewire')!
  const recorded = await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/record-material`, {
    requestId: s.stay.requestId, expectedRequestVersion: surgery.requests.find(item => item.id === s.stay.requestId)!.version,
    executionId: surgery.inProgress[0]!.id, note: '合成术中已使用一根导丝',
    material: { materialId: 'hospital-material-pci-guidewire', catalogVersion: 1, quantity: 1,
      reservationId: reservation.id, expectedReservationVersion: reservation.version },
  })
  expect(recorded.status).toBe(200)
  inpatientSurgeryResponseSchema.parse(await recorded.json())
  expect((await s.read()).stage).toBe('intraoperative')
  await s.fixture.runtime.dispatchPending()
  const result = await s.read()
  expect(result.status).toBe('succeeded')
  expect(result.analysis?.stage).toBe('intraoperative')
  expect(result.analysis?.items.map(item => item.materialId).sort()).toEqual([
    'hospital-material-pci-balloon', 'hospital-material-pci-guiding-catheter', 'hospital-material-pci-stent',
  ])
  expect(result.analysis?.items.reduce((sum, item) => sum + item.estimatedFen, 0)).toBe(106598)
})

it('超出各一件合成协议的预计数量在术前和术中均不派发建议', async () => {
  const s = await setupAgent()
  const selected = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, { expectedVersion: 1,
    parameters: { ...s.parameters, plannedQuantities: s.parameters.plannedQuantities.map(item => item.category === 'stent'
      ? { ...item, quantity: 2, basis: '合成边界输入两枚支架，不能冒充已核验方案' } : item) },
  })
  expect(selected.status).toBe(200)
  expect(inpatientPciSelectionResponseSchema.parse(await selected.json()).data.candidates
    .find(item => item.materialId === 'hospital-material-pci-stent')).toMatchObject({ eligibility: 'inapplicable', expectedQuantity: 2,
      missing: expect.arrayContaining(['预计数量不在已核验的单病变各一件仿真范围']) })
  await s.start(); await s.fixture.runtime.dispatchPending()
  expect(await s.read()).toMatchObject({ status: 'incomplete', stage: 'preoperative', analysis: null })
  const { materials: _materials, ...ready } = await s.fixture.pciExecutionInput(s.stay)
  const started = await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/start`, ready)
  expect(started.status).toBe(200)
  const surgery = inpatientSurgeryResponseSchema.parse(await started.json()).data
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/record-material`, {
    requestId: s.stay.requestId, expectedRequestVersion: surgery.requests.find(item => item.id === s.stay.requestId)!.version,
    executionId: surgery.inProgress[0]!.id, note: '即使已用一枚，也不能把未核验的原两枚方案变为有效',
    material: { materialId: 'hospital-material-pci-stent', catalogVersion: 1, quantity: 1 },
  })).status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  expect(await s.read()).toMatchObject({ status: 'incomplete', stage: 'intraoperative', analysis: null,
    missing: expect.arrayContaining(['hospital-material-pci-stent: 预计数量不在已核验的单病变各一件仿真范围']) })
  expect(s.requests).toEqual([])
})

it.each([false, true])('停止后同依据重新开启沿原任务继续未派发工作，旧事件已处理=%s', async dispatchStopped => {
  const s = await setupAgent(), task = await s.start()
  const stopped = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/followup/stop`, {
    encounterVersion: s.stay.encounterVersion, expectedTaskVersion: task.version, reason: '合成暂停尚未派发的跟进',
  })
  expect(stopped.status).toBe(200)
  const stopState = inpatientDrgFollowupResponseSchema.parse(await stopped.json()).data.task!
  if (dispatchStopped) await s.fixture.runtime.dispatchPending()
  expect(s.requests).toEqual([])
  const restarted = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/followup/start`, {
    encounterVersion: s.stay.encounterVersion, expectedTaskVersion: stopState.version,
  })
  expect(restarted.status).toBe(200)
  const resumed = inpatientDrgFollowupResponseSchema.parse(await restarted.json()).data.task!
  expect(resumed.id).toBe(task.id)
  await s.fixture.runtime.dispatchPending()
  const result = await s.read()
  expect(result).toMatchObject({ taskId: task.id, status: 'succeeded' })
  expect(s.requests).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
  const stopAgain = inpatientDrgFollowupResponseSchema.parse(await (await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/followup/stop`, {
    encounterVersion: s.stay.encounterVersion, expectedTaskVersion: resumed.version, reason: '合成停止已成功分析',
  })).json()).data.task!
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/followup/start`, {
    encounterVersion: s.stay.encounterVersion, expectedTaskVersion: stopAgain.version,
  })).status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  expect((await s.read()).analysis?.id).toBe(result.analysis!.id)
  expect(s.requests).toHaveLength(2)
})

it('术后对照人工计划与实际耗材，额外用量进入医生待办并保留阶段 DRG 与正式费用', async () => {
  const s = await setupAgent((feature, _index, raw) => {
    const input = z.object({ remaining: z.array(z.object({ materialId: z.string(), quantity: z.number() })),
      proposed: z.array(z.object({ materialId: z.string() }).passthrough()).optional(),
      review: z.object({ issues: z.array(z.object({ key: z.string(), evidence: z.array(z.string()) }).passthrough()) }).passthrough().optional(),
    }).passthrough().parse(raw)
    return feature === 'inpatient_drg_recommendation'
      ? { items: pciAgentGeneration.items.filter(item => input.remaining.some(value => value.materialId === item.materialId && value.quantity > 0)),
          ...(input.review === undefined ? {} : { observations: input.review.issues.map(issue => ({ key: issue.key, explanation: '合成受控分析：实际较计划多一根导丝，需术者核实用途', evidenceIds: issue.evidence })) }) }
      : { items: pciAgentVerification.items.filter(item => input.proposed?.some(value => value.materialId === item.materialId)),
          ...(input.review === undefined ? {} : { observations: input.review.issues.map(issue => ({ key: issue.key, supported: true, reason: '已核对本次合成计划与逐项使用' })) }) }
  })
  await s.start()
  await s.fixture.runtime.dispatchPending()
  const before = await s.read()
  const planned = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/agent/confirm`, { analysisId: before.analysis!.id,
    expectedBasisFingerprint: before.basisFingerprint, expectedRevision: 0, note: '术前确认四类耗材各一件',
    items: before.analysis!.items.map(item => ({ materialId: item.materialId, catalogVersion: item.catalogVersion, quantity: item.quantity, reason: '医生逐项确认' })) })
  expect(planned.status).toBe(200)
  inpatientDrgAgentResponseSchema.parse(await planned.json())
  const input = await s.fixture.pciExecutionInput(s.stay)
  const executed = await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/execute`, { ...input,
    materials: input.materials.map(item => item.materialId === 'hospital-material-pci-guidewire'
      ? { materialId: item.materialId, catalogVersion: item.catalogVersion, quantity: 2 } : item) })
  expect(executed.status).toBe(200)
  const execution = inpatientSurgeryResponseSchema.parse(await executed.json()).data.executions[0]!
  await s.fixture.confirmMainProcedure(s.stay, execution.id)
  await s.fixture.runtime.dispatchPending()
  const response = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/review`)
  expect(response.status).toBe(200)
  const fees = await s.fixture.read('cashier', `${s.stay.path}/charges`, inpatientChargesSchema)
  expect(fees.charges.filter(item => item.kind === 'surgery').map(item => item.amountFen)).toEqual([180000])
  const guidewire = execution.materials.find(item => item.item.id === 'hospital-material-pci-guidewire')!
  expect(guidewire).toMatchObject({ quantity: 2, amountFen: 40000 })
  expect(fees.charges.find(item => item.sourceId === guidewire.id)?.amountFen).toBe(40000)
  expect(fees.chargesFen).toBe(326598)
  expect(inpatientDrgReviewSchema.parse(await response.json())).toMatchObject({ status: 'complete',
    summary: { formalDrgCode: 'FM39', formalChargesFen: 326598 },
    todos: [expect.objectContaining({ kind: 'extra-use', materialId: 'hospital-material-pci-guidewire', ownerRole: 'inpatient-doctor', status: 'pending' })],
  })
})

it('岗位待办必须通过正式事实复查解决，人工处置不重跑同依据模型', async () => {
  const s = await setupPostoperativeAgent(), initial = await s.review(), todo = initial.todos.find(item => item.kind === 'extra-use')!
  const input = { todoId: todo.id, expectedTodoVersion: todo.version, expectedFingerprint: initial.fingerprint,
    action: 'resolve', note: '仅点击关闭不能证明业务已经更正' }
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/review/todos/act`, input)).status).toBe(409)
  expect((await s.fixture.request('cashier', `${s.stay.path}/drg/review/todos/act`, { ...input, action: 'dismiss', note: '越岗判断' })).status).toBe(403)
  const key = randomUUID(), processing = { ...input, action: 'in-progress', note: '术者核实额外导丝用途' }
  const acted = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/review/todos/act`, processing, key)
  expect(acted.status).toBe(200)
  const receipt = inpatientDrgReviewResponseSchema.parse(await acted.json())
  expect(receipt.data.todos.find(item => item.id === todo.id)).toMatchObject({ status: 'in-progress' })
  expect(await (await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/review/todos/act`, processing, key)).json()).toEqual(receipt)
  const count = s.requests.length
  await s.fixture.runtime.dispatchPending()
  expect(s.requests).toHaveLength(count)
  const surgery = inpatientSurgeryResponseSchema.parse(await (await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/correct-material`, {
    requestId: s.stay.requestId, expectedRequestVersion: (await s.fixture.read('inpatient-doctor', `${s.stay.path}/surgeries`, inpatientSurgeryResponseSchema.shape.data)).requests[0]!.version,
    executionId: s.execution.id, materialUseId: s.execution.materials.find(item => item.item.id === 'hospital-material-pci-guidewire')!.id,
    note: '核实仅使用一根，原额外一根为录入错误', replacement: { materialId: 'hospital-material-pci-guidewire', catalogVersion: 1, quantity: 1 },
  })).json()).data
  expect(surgery.executions[0]!.materials.find(item => item.item.id === 'hospital-material-pci-guidewire')?.quantity).toBe(1)
  const rechecked = await s.review()
  expect(rechecked.resolvedTodos.find(item => item.id === todo.id)).toMatchObject({ status: 'resolved', reason: expect.stringContaining('最新业务事实') })
  expect(rechecked.todos.some(item => item.kind === 'extra-use')).toBe(false)
  const financial = await s.fixture.read('cashier', `${s.stay.path}/drg/review`, inpatientDrgReviewSchema)
  expect(financial.summary.formalDrgCode).toBeNull()
  expect(financial.simulation).toBeNull()
  expect(financial.comparisons).toEqual([])
  expect(financial.todos.every(item => item.ownerRole === 'cashier')).toBe(true)
})

it('术前冻结计划按选型确认身份及版本绑定原手术，不被同身份的新版本改指另一手术', async () => {
  const s = await setupPostoperativeAgent(), state = await s.fixture.read('inpatient-doctor', `${s.stay.path}/surgeries`, inpatientSurgeryResponseSchema.shape.data)
  const requested = inpatientSurgeryResponseSchema.parse(await (await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/request`, {
    encounterVersion: state.encounterVersion, procedureId: s.stay.procedure.id, catalogVersion: s.stay.procedure.version,
    plannedFor: '2026-08-24T15:00:00+08:00', reason: '医生新增另一 PCI 计划，原术前计划保持冻结',
  })).json()).data.requests.at(-1)!
  const confirmed = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, { expectedVersion: 1,
    parameters: { ...s.parameters, requestId: requested.id } })
  expect(confirmed.status).toBe(200)
  inpatientPciSelectionResponseSchema.parse(await confirmed.json())
  await s.fixture.runtime.dispatchPending()
  const nextPlan = await s.read()
  expect(nextPlan).toMatchObject({ status: 'succeeded', stage: 'preoperative' })
  const confirmedSecond = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/agent/confirm`, { analysisId: nextPlan.analysis!.id,
    expectedBasisFingerprint: nextPlan.basisFingerprint, expectedRevision: nextPlan.confirmedPlan!.revision, note: '第二次手术独立确认人工计划，第一台未解决问题继续保留',
    items: nextPlan.analysis!.items.map(item => ({ materialId: item.materialId, catalogVersion: item.catalogVersion, quantity: item.quantity, reason: '医生确认第二台手术用途' })) })
  expect(confirmedSecond.status).toBe(200); inpatientDrgAgentResponseSchema.parse(await confirmedSecond.json())
  const second = await s.fixture.pciExecutionInput(s.stay, requested.id)
  const execution = await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/execute`, { ...second,
    materials: second.materials.map(({ reservationId: _reservation, ...item }) => ({ ...item, quantity: 1 })) })
  expect(execution.status).toBe(200)
  inpatientSurgeryResponseSchema.parse(await execution.json())
  const review = await s.review(), extra = review.todos.find(item => item.kind === 'extra-use')
  expect(extra).toMatchObject({ materialId: 'hospital-material-pci-guidewire', plannedQuantity: 1, actualQuantity: 2, status: 'pending' })
  expect(extra!.evidence).toContain(`InpatientSurgeryMaterial/${s.execution.materials.find(item => item.item.id === 'hospital-material-pci-guidewire')!.id}`)
})

it('相同分组缺项消除后再次出现重新开启待办，切换规则配置不重复保存同依据', async () => {
  const s = await setupPostoperativeAgent(), rules = s.fixture.options.drgRulesDirectory!
  delete s.fixture.options.drgRulesDirectory
  await s.fixture.restart()
  const first = await s.review(), missing = first.todos.find(item => item.kind === 'grouping-incomplete')!
  expect(missing.status).toBe('pending')
  s.fixture.options.drgRulesDirectory = rules
  await s.fixture.restart()
  expect((await s.review()).resolvedTodos.find(item => item.id === missing.id)?.status).toBe('resolved')
  delete s.fixture.options.drgRulesDirectory
  await s.fixture.restart()
  const repeated = await s.review()
  expect(repeated.todos.find(item => item.id === missing.id)).toMatchObject({ status: 'pending' })
  expect(repeated.todos.filter(item => item.kind === 'grouping-incomplete')).toHaveLength(1)
})

it('独立核验明确否决不发布建议，也不把语义否决当格式错误重发', async () => {
  const s = await setupAgent(feature => feature === 'inpatient_drg_recommendation' ? pciAgentGeneration : {
    items: pciAgentVerification.items.map(item => ({ ...item, applicable: false, reason: '独立核验否决本次临床适用' })),
  })
  await s.start(); await s.fixture.runtime.dispatchPending()
  expect(await s.read()).toMatchObject({ status: 'failed', analysis: null })
  expect(s.requests).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
})

it.each(['disabled', 'verification-limit'] as const)('控制拒绝%s解除后复用同任务及成功步骤，真实用量不包含拒绝或规则检查', async mode => {
  const s = await setupAgent(), cookie = await s.fixture.login('admin')
  const update = async (expectedVersion: number, enabled: boolean, requests: number | null) => {
    const response = await s.fixture.runtime.app.request('/api/model-usage/control', { method: 'PUT', headers: {
      cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersion, enabled, requests, automaticRetries: true }) })
    expect(response.status).toBe(200)
  }
  await update(1, mode !== 'disabled', mode === 'disabled' ? null : 1)
  const task = await s.start(); await s.fixture.runtime.dispatchPending()
  expect(await s.read()).toMatchObject({ taskId: task.id, status: 'blocked', failureCode: mode === 'disabled' ? 'MODEL_DISABLED' : 'MODEL_REQUEST_LIMIT', analysis: null })
  expect(s.requests).toEqual(mode === 'disabled' ? [] : ['inpatient_drg_recommendation'])
  await update(2, true, mode === 'disabled' ? null : 2); await s.fixture.runtime.dispatchPending()
  expect(await s.read()).toMatchObject({ taskId: task.id, status: 'succeeded' })
  expect(s.requests).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
  const usage = await s.fixture.read('inpatient-doctor', `/api/model-usage/overview?caseId=${s.stay.admissionId}&taskId=${task.id}`, modelUsageOverviewSchema)
  expect(usage.totals).toMatchObject({ requests: 2, knownTokens: 240, knownInputTokens: 200, knownOutputTokens: 40 })
  expect((await s.fixture.read('admin', '/api/model-usage/control', modelUsageControlSchema)).workspace.version).toBe(3)
})

it.each(['provider', 'model', 'metering'] as const)('模型配置缺失%s恢复后自动续接原任务，不消耗拒绝预算或重复已成功请求', async missing => {
  const s = await setupAgent(), provider = s.fixture.options.chatCompletionsProvider!, model = s.fixture.options.consultationModel!
  const investigationModel = s.fixture.options.investigationModel!
  if (missing === 'provider') delete s.fixture.options.chatCompletionsProvider
  else if (missing === 'model') { delete s.fixture.options.consultationModel; delete s.fixture.options.investigationModel }
  else s.fixture.options.chatCompletionsProvider = { completeJson: input => provider.completeJson(input) }
  await s.fixture.restart()
  const task = await s.start()
  await s.fixture.runtime.dispatchPending()
  const blocked = await s.read()
  expect(blocked).toMatchObject({ taskId: task.id, status: 'blocked', failureCode: 'MODEL_METERING_UNAVAILABLE', analysis: null })
  await s.fixture.runtime.dispatchPending()
  expect(s.requests).toEqual([])
  const waiting = await s.fixture.read('admin', '/api/model-usage/control', modelUsageControlSchema)
  s.fixture.options.chatCompletionsProvider = provider
  s.fixture.options.consultationModel = model
  s.fixture.options.investigationModel = investigationModel
  await s.fixture.restart()
  await s.fixture.runtime.dispatchPending()
  const recovered = await s.read()
  expect(recovered).toMatchObject({ taskId: task.id, status: 'succeeded', basisFingerprint: blocked.basisFingerprint,
    analysis: { revision: 1 } })
  expect(waiting.waiting).toBe(1)
  expect(s.requests).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
  const control = await s.fixture.read('admin', '/api/model-usage/control', modelUsageControlSchema)
  expect(control).toMatchObject({ waiting: 0, workspace: { version: waiting.workspace.version } })
  const usage = await s.fixture.read('inpatient-doctor', `/api/model-usage/overview?caseId=${s.stay.admissionId}&taskId=${task.id}`, modelUsageOverviewSchema)
  expect(usage.totals).toMatchObject({ requests: 2, knownTokens: 240, knownInputTokens: 200, knownOutputTokens: 40 })
  await s.fixture.runtime.dispatchPending()
  await s.fixture.restart(); await s.fixture.runtime.dispatchPending()
  expect((await s.read()).analysis?.id).toBe(recovered.analysis!.id)
  expect(s.requests).toHaveLength(2)
})

it('病例用量触发原因引用实际变化的选型确认版本，来源保持可追溯', async () => {
  const s = await setupAgent(), task = await s.start()
  await s.fixture.runtime.dispatchPending()
  const response = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, { expectedVersion: 1,
    parameters: { ...s.parameters, measurements: s.parameters.measurements.map(item => ({ ...item, source: { ...item.source, version: '2' } })) } })
  expect(response.status).toBe(200)
  const changed = inpatientPciSelectionResponseSchema.parse(await response.json()).data.confirmation!
  await s.fixture.runtime.dispatchPending()
  const usage = await s.fixture.read('inpatient-doctor', `/api/model-usage/requests?caseId=${s.stay.admissionId}&taskId=${task.id}`, modelUsageListSchema)
  expect(usage.items.some(item => item.context.sources.some(source => source.kind === 'document' && source.relationship === 'trigger'
    && source.id === `InpatientPciSelection/${changed.id}/version/2`))).toBe(true)
  expect(s.requests).toHaveLength(4)
})

it('停止后的责任交接保留未解决待办，重新开启同任务清除旧轮交接标记', async () => {
  const s = await setupPostoperativeAgent()
  const taskResponse = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/followup`)
  const task = (await taskResponse.json()).task
  const stopped = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/followup/stop`, {
    encounterVersion: s.stay.encounterVersion, expectedTaskVersion: task.version, reason: '医生停止并交接当前问题',
  })
  expect(stopped.status).toBe(200)
  const stoppedTask = inpatientDrgFollowupResponseSchema.parse(await stopped.json()).data.task!
  const before = await s.review(), extra = before.todos.find(item => item.kind === 'extra-use')!, count = s.requests.length
  const response = await s.fixture.request('medical-records', `${s.stay.path}/drg/review/handoff`, { expectedVersion: before.version, note: '未解决额外使用仍由当前住院医生负责' })
  expect(response.status).toBe(200)
  const handed = inpatientDrgReviewResponseSchema.parse(await response.json()).data
  expect(handed.handedOver?.role).toBe('medical-records')
  expect(handed.todos.find(item => item.id === extra.id)).toMatchObject({ status: 'pending', ownerRole: 'inpatient-doctor' })
  await s.fixture.runtime.dispatchPending()
  expect(s.requests).toHaveLength(count)
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/followup/start`, {
    encounterVersion: s.stay.encounterVersion, expectedTaskVersion: stoppedTask.version,
  })).status).toBe(200)
  const resumed = await s.review()
  expect(resumed.taskId).toBe(before.taskId)
  expect(resumed.handedOver).toBeNull()
  expect(resumed.todos.find(item => item.id === extra.id)?.status).toBe('pending')
})

it('同一PCI住院贯通三阶段真实模型、逐笔更正、岗位复查、归档交接与用量对账', async () => {
  const s = await setupAgent((feature, _index, raw) => {
    const input = z.object({ remaining: z.array(z.object({ materialId: z.string(), quantity: z.number() })),
      proposed: z.array(z.object({ materialId: z.string() }).passthrough()).optional(),
      review: z.object({ issues: z.array(z.object({ key: z.string(), evidence: z.array(z.string()) }).passthrough()) }).passthrough().optional(),
    }).passthrough().parse(raw)
    return feature === 'inpatient_drg_recommendation'
      ? { items: pciAgentGeneration.items.filter(item => input.remaining.some(value => value.materialId === item.materialId && value.quantity > 0)),
          ...(input.review ? { observations: input.review.issues.map(issue => ({ key: issue.key, explanation: '合成解释保留额外使用与已更正记录的来源，仍需对应岗位核实。', evidenceIds: issue.evidence })) } : {}) }
      : { items: pciAgentVerification.items.filter(item => input.proposed?.some(value => value.materialId === item.materialId)),
          ...(input.review ? { observations: input.review.issues.map(issue => ({ key: issue.key, supported: true, reason: '合成独立核验已核对正式计划、实际、费用与原来源' })) } : {}) }
  })
  const task = await s.start(); await s.fixture.runtime.dispatchPending()
  const pre = await s.read()
  const plan = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/agent/confirm`, { analysisId: pre.analysis!.id,
    expectedBasisFingerprint: pre.basisFingerprint, expectedRevision: 0, note: '医生术前人工确认四类产品各一件',
    items: pre.analysis!.items.map(item => ({ materialId: item.materialId, catalogVersion: item.catalogVersion, quantity: item.quantity, reason: '合成单病变预计数量与用途已核实' })) })
  expect(plan.status).toBe(200); inpatientDrgAgentResponseSchema.parse(await plan.json())
  const backup = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/reservations`, { encounterVersion: s.stay.encounterVersion,
    requestId: s.stay.requestId, materialId: 'hospital-material-pci-guidewire', catalogVersion: 1, quantity: 2, reason: '合成备选两根，人工计划预计一根，不反推患者需求' })
  expect(backup.status).toBe(200)
  const backupReservation = (await backup.json()).data.reservations.at(-1)
  const { materials: _bulk, ...ready } = await s.fixture.pciExecutionInput(s.stay)
  const begun = await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/start`, ready)
  expect(begun.status).toBe(200)
  let surgery = inpatientSurgeryResponseSchema.parse(await begun.json()).data
  const executionId = surgery.inProgress[0]!.id
  const record = async (material: { materialId: string; catalogVersion: number; quantity: number; reservationId?: string; expectedReservationVersion?: number }, note: string) => {
    const response = await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/record-material`, { requestId: s.stay.requestId,
      expectedRequestVersion: surgery.requests.find(item => item.id === s.stay.requestId)!.version, executionId, material, note })
    expect(response.status).toBe(200)
    surgery = inpatientSurgeryResponseSchema.parse(await response.json()).data
    return surgery.inProgress[0]!.materials.at(-1)!
  }
  const firstWire = await record({ materialId: 'hospital-material-pci-guidewire', catalogVersion: 1, quantity: 1,
    reservationId: backupReservation.id, expectedReservationVersion: backupReservation.version }, '合成第一根导丝实际使用并消耗部分预留')
  await s.fixture.runtime.dispatchPending()
  expect(await s.read()).toMatchObject({ status: 'succeeded', stage: 'intraoperative' })
  expect((await s.read()).analysis!.items.map(item => item.materialId).sort()).toEqual([
    'hospital-material-pci-balloon', 'hospital-material-pci-guiding-catheter', 'hospital-material-pci-stent',
  ])
  await record({ materialId: 'hospital-material-pci-guidewire', catalogVersion: 1, quantity: 1 }, '合成术中额外导丝，新增用途待术者最终核实')
  for (const materialId of ['hospital-material-pci-guiding-catheter', 'hospital-material-pci-stent']) {
    const reserved = s.stay.reservations.find(item => item.materialId === materialId)!
    await record({ materialId, catalogVersion: 1, quantity: 1, reservationId: reserved.id, expectedReservationVersion: reserved.version }, '合成确认计划内实际使用')
  }
  const wrongBalloon = await record({ materialId: 'hospital-material-pci-balloon', catalogVersion: 1, quantity: 2 }, '合成球囊数量待术后核实')
  const completed = await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/complete`, { requestId: s.stay.requestId,
    expectedRequestVersion: surgery.requests.find(item => item.id === s.stay.requestId)!.version, executionId, note: '合成PCI手术完成，收拢未用备用余量' })
  expect(completed.status).toBe(200); surgery = inpatientSurgeryResponseSchema.parse(await completed.json()).data
  await s.fixture.confirmMainProcedure(s.stay, executionId)
  const originalFees = await s.fixture.read('cashier', `${s.stay.path}/charges`, inpatientChargesSchema)
  const wrongCharge = originalFees.charges.find(item => item.sourceId === wrongBalloon.id)!
  expect((await s.fixture.request('cashier', `${s.stay.path}/charges/reverse`, { chargeId: wrongCharge.id,
    expectedChargeVersion: wrongCharge.version, reason: '合成确认数量错误后先冲正原两件费用' })).status).toBe(200)
  const financial = await s.fixture.read('cashier', `${s.stay.path}/drg/review`, inpatientDrgReviewSchema)
  const mismatch = financial.todos.find(item => item.kind === 'billing-mismatch')!
  expect(financial.model).toBeNull()
  const processing = await s.fixture.request('cashier', `${s.stay.path}/drg/review/todos/act`, { todoId: mismatch.id,
    expectedTodoVersion: mismatch.version, expectedFingerprint: financial.fingerprint, action: 'in-progress', note: '收费员正按原账核实数量更正' })
  expect(processing.status).toBe(200); inpatientDrgReviewResponseSchema.parse(await processing.json())
  const corrected = await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/correct-material`, { requestId: s.stay.requestId,
    expectedRequestVersion: surgery.requests.find(item => item.id === s.stay.requestId)!.version, executionId, materialUseId: wrongBalloon.id,
    replacement: { materialId: 'hospital-material-pci-balloon', catalogVersion: 1, quantity: 1 }, note: '术者核实实际一件，原两件属于录入错误，保留原使用和已冲正费用' })
  expect(corrected.status).toBe(200); inpatientSurgeryResponseSchema.parse(await corrected.json())
  await s.fixture.runtime.dispatchPending()
  const review = await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/review`, inpatientDrgReviewSchema)
  expect(review.summary).toMatchObject({ formalDrgCode: 'FM39', formalChargesFen: 326598 })
  expect(review.resolvedTodos.find(item => item.id === mismatch.id)?.status).toBe('resolved')
  expect(review.model).toMatchObject({ current: true, status: 'succeeded' })
  expect(review.model!.observations.map(item => item.key).sort()).toEqual([
    `extra-use:${executionId}:hospital-material-pci-guidewire@1`, `replacement:${executionId}:${wrongBalloon.id}`,
  ].sort())
  const replacement = review.todos.find(item => item.kind === 'replacement')!, extra = review.todos.find(item => item.kind === 'extra-use')!
  const dismissed = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/review/todos/act`, { todoId: replacement.id,
    expectedTodoVersion: replacement.version, expectedFingerprint: review.fingerprint, action: 'dismiss', note: '原数量录入错误及原费用更正来源均已明确，无需进一步处理该提示' })
  expect(dismissed.status).toBe(200); inpatientDrgReviewResponseSchema.parse(await dismissed.json())
  const latest = await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/review`, inpatientDrgReviewSchema)
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/review/todos/act`, { todoId: extra.id,
    expectedTodoVersion: extra.version, expectedFingerprint: latest.fingerprint, action: 'recheck', note: '额外导丝用途仍需核实，不能因关闭提示声称解决' })).status).toBe(200)
  const query = `caseId=${s.stay.admissionId}&taskId=${task.id}`
  const before = await s.fixture.read('inpatient-doctor', `/api/model-usage/overview?${query}`, modelUsageOverviewSchema)
  expect(before.totals).toMatchObject({ requests: 6, knownTokens: 720, knownInputTokens: 600, knownOutputTokens: 120 })
  const attempts = await s.fixture.read('inpatient-doctor', `/api/model-usage/requests?${query}`, modelUsageListSchema)
  for (const phase of ['preoperative', 'intraoperative', 'postoperative']) expect(attempts.items.filter(item => item.context.stage.startsWith(phase))).toHaveLength(2)
  expect(attempts.items.some(item => item.context.stage === 'intraoperative-generation' && item.context.sources.some(source => source.relationship === 'trigger'
    && source.id === `InpatientSurgeryMaterial/${firstWire.id}`))).toBe(true)
  await s.fixture.depart(s.stay)
  const funds = await s.fixture.read('cashier', `${s.stay.path}/payments`, inpatientPaymentsSchema)
  expect(funds.remainingFen).toBeGreaterThan(0)
  const money = await s.fixture.request('cashier', `${s.stay.path}/payments/preview`, { kind: 'supplement', amountFen: funds.remainingFen,
    tenders: [{ method: 'cash', amountFen: funds.remainingFen }], simulatorRule: 'success' })
  expect(money.status).toBe(200)
  const preview = inpatientPaymentPreviewResponseSchema.parse(await money.json()).data
  const paid = await s.fixture.request('cashier', `${s.stay.path}/payments/confirm`, { previewId: preview.previewId, commitToken: preview.commitToken })
  expect(paid.status).toBe(200); expect(inpatientPaymentResponseSchema.parse(await paid.json()).data.outcome).toBe('success')
  const settlement = await s.fixture.read('cashier', `${s.stay.path}/discharge/preview`, inpatientSettlementPreviewSchema)
  const settled = await s.fixture.request('cashier', `${s.stay.path}/discharge/settle`, { encounterVersion: settlement.encounterVersion,
    fingerprint: settlement.fingerprint, expectedChargesFen: settlement.chargesFen, expectedBalanceFen: settlement.balanceFen })
  expect(settled.status).toBe(200)
  const closed = inpatientSettlementResponseSchema.parse(await settled.json()).data
  expect((await s.fixture.request('ward-nurse', `${s.stay.path}/discharge/clear`, { encounterVersion: closed.encounterVersion, reason: '合成清床' })).status).toBe(200)
  await s.fixture.confirmMainProcedure(s.stay, executionId)
  const recordState = await s.fixture.read('medical-records', `${s.stay.path}/record`, inpatientRecordSchema)
  expect((await s.fixture.request('medical-records', `${s.stay.path}/record/review`, { expectedRevision: recordState.revision!.revision,
    expectedSourcesHash: recordState.sourcesHash, outcome: 'approved' })).status).toBe(200)
  const approved = await s.fixture.read('medical-records', `${s.stay.path}/record`, inpatientRecordSchema)
  expect((await s.fixture.request('medical-records', `${s.stay.path}/record/archive`, { expectedRevision: approved.revision!.revision,
    expectedSourcesHash: approved.sourcesHash })).status).toBe(200)
  const frozen = await s.fixture.read('medical-records', `${s.stay.path}/drg/review`, inpatientDrgReviewSchema), count = s.requests.length
  expect(frozen.status).toBe('frozen')
  const handoff = await s.fixture.request('medical-records', `${s.stay.path}/drg/review/handoff`, { expectedVersion: frozen.version, note: '病案已归档，额外导丝用途未解决仍由病例住院医生岗位负责' })
  expect(handoff.status).toBe(200)
  expect(inpatientDrgReviewResponseSchema.parse(await handoff.json()).data.todos.find(item => item.id === extra.id)).toMatchObject({ status: 'pending', ownerRole: 'inpatient-doctor' })
  const payer = await s.fixture.read('medical-insurance', `${s.stay.path}/drg/payer-review-preview`, inpatientDrgPayerReviewPreviewSchema)
  const payerResult = await s.fixture.request('medical-insurance', `${s.stay.path}/drg/payer-review`, { encounterVersion: payer.encounterVersion, expectedFingerprint: payer.fingerprint, reason: '归档后的合成核定不得恢复临床分析' })
  expect(payerResult.status).toBe(200); commandResponseSchema(inpatientDrgPayerReviewListSchema).parse(await payerResult.json())
  await s.fixture.runtime.dispatchPending(); await s.fixture.restart(); await s.fixture.runtime.dispatchPending()
  expect(s.requests).toHaveLength(count)
  const after = await s.fixture.read('inpatient-doctor', `/api/model-usage/overview?${query}`, modelUsageOverviewSchema)
  expect(after.totals).toEqual(before.totals)
  const retained = await s.fixture.read('medical-records', `${s.stay.path}/drg/review`, inpatientDrgReviewSchema)
  expect(retained.handedOver).not.toBeNull()
  expect(retained.todos.find(item => item.id === extra.id)?.status).toBe('pending')
})

it('病例责任转科后原岗位不能交接，有效岗位仅接手保留结果而不延长旧后台授权', async () => {
  const s = await setupPostoperativeAgent(), before = await s.review(), count = s.requests.length
  await addSecondaryInpatientWard(s.fixture.runtime)
  const admission = (await s.fixture.read('inpatient-doctor', s.stay.path, inpatientDetailSchema)).admission
  const requested = await s.fixture.request('inpatient-doctor', `${s.stay.path}/transfers/request`, { encounterVersion: admission.versionId,
    targetWardId: 'ward-surgery', reason: '合成责任转移，原后台授权不能随页面迁移' })
  expect(requested.status).toBe(200)
  const transfer = inpatientTransferResponseSchema.parse(await requested.json()).data.transfers[0]!
  const handed = await s.fixture.request('ward-nurse', `${s.stay.path}/transfers/handover`, { encounterVersion: admission.versionId,
    transferId: transfer.id, expectedTransferVersion: transfer.version })
  expect(handed.status).toBe(200)
  const handover = inpatientTransferResponseSchema.parse(await handed.json()).data.transfers[0]!
  const role = await s.fixture.runtime.app.request('/api/auth/role', { method: 'POST', headers: { cookie: await s.fixture.login('ward-nurse'),
    origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ practitionerRoleId: 'practitioner-role-ward-nurse-surgery' }) })
  expect(role.status).toBe(200)
  const received = await s.fixture.request('ward-nurse', `${s.stay.path}/transfers/receive`, { encounterVersion: admission.versionId,
    transferId: transfer.id, expectedTransferVersion: handover.version, bedId: 'bed-surgery-1' })
  expect(received.status).toBe(200); inpatientTransferResponseSchema.parse(await received.json())
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/review/handoff`, { expectedVersion: before.version, note: '原责任已失效，不得沿用旧岗位交接' })).status).toBe(403)
  const frozen = await s.fixture.read('medical-records', `${s.stay.path}/drg/review`, inpatientDrgReviewSchema)
  expect(frozen.status).toBe('frozen')
  expect(frozen.freezeReason).toContain('授权或责任已变化')
  const result = await s.fixture.request('medical-records', `${s.stay.path}/drg/review/handoff`, { expectedVersion: frozen.version, note: '未解决用途由转科后的当前病例医生岗位继续核实' })
  expect(result.status).toBe(200)
  expect(inpatientDrgReviewResponseSchema.parse(await result.json()).data.todos.find(item => item.kind === 'extra-use')).toMatchObject({ ownerRole: 'inpatient-doctor', status: 'pending' })
  await s.fixture.runtime.dispatchPending(); await s.fixture.restart(); await s.fixture.runtime.dispatchPending()
  expect(s.requests).toHaveLength(count)
})

it('术后模型结果未知仍保留确定性差异与责任，停止交接和重启均不重发', async () => {
  const s = await setupPostoperativeAgent('unknown'), review = await s.review()
  expect(review.summary).toMatchObject({ formalDrgCode: 'FM39', formalChargesFen: 326598 })
  expect(review.todos.find(item => item.kind === 'extra-use')?.status).toBe('pending')
  expect(review.model).toMatchObject({ current: false, status: 'unknown', failureCode: 'MODEL_OUTCOME_UNKNOWN' })
  expect(s.requests).toHaveLength(3)
  const state = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/followup`), task = (await state.json()).task
  const stopped = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/followup/stop`, { encounterVersion: s.stay.encounterVersion,
    expectedTaskVersion: task.version, reason: '保留术后未知请求，先交接核查责任' })
  expect(stopped.status).toBe(200); inpatientDrgFollowupResponseSchema.parse(await stopped.json())
  const frozen = await s.review()
  const handed = await s.fixture.request('medical-records', `${s.stay.path}/drg/review/handoff`, { expectedVersion: frozen.version, note: '模型结果未知与额外使用均保留待核查，不自动重发或解决' })
  expect(handed.status).toBe(200)
  expect(inpatientDrgReviewResponseSchema.parse(await handed.json()).data.model?.status).toBe('unknown')
  await s.fixture.restart(); await s.fixture.runtime.dispatchPending()
  const retained = await s.fixture.read('medical-records', `${s.stay.path}/drg/review`, inpatientDrgReviewSchema)
  expect(retained.model?.status).toBe('unknown')
  expect(retained.todos.find(item => item.kind === 'extra-use')?.status).toBe('pending')
  expect(s.requests).toHaveLength(3)
})

it.each(['unknown', 'succeeded'] as const)('在途生成停止后重新开启，原请求结局%s不能被新授权版本吞掉', async outcome => {
  let acknowledge!: () => void, release!: () => void
  const began = new Promise<void>(resolve => { acknowledge = resolve })
  const held = new Promise<unknown>((resolve, reject) => { release = () => outcome === 'unknown'
    ? reject(new Error('Synthetic in-flight transport lost after reopening')) : resolve(pciAgentGeneration) })
  const s = await setupAgent(feature => {
    if (feature === 'inpatient_drg_recommendation') { acknowledge(); return held }
    return pciAgentVerification
  }), task = await s.start()
  const running = s.fixture.runtime.dispatchPending()
  try {
    await began
    const stopped = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/followup/stop`, { encounterVersion: s.stay.encounterVersion,
      expectedTaskVersion: task.version, reason: '合成请求在途时停止' })
    expect(stopped.status).toBe(200)
    const stopState = inpatientDrgFollowupResponseSchema.parse(await stopped.json()).data.task!
    const reopened = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/followup/start`, { encounterVersion: s.stay.encounterVersion,
      expectedTaskVersion: stopState.version })
    expect(reopened.status).toBe(200); expect(inpatientDrgFollowupResponseSchema.parse(await reopened.json()).data.task!.id).toBe(task.id)
    release(); await running; await s.fixture.runtime.dispatchPending()
    if (outcome === 'unknown') {
      expect(await s.read()).toMatchObject({ taskId: task.id, status: 'unknown', failureCode: 'MODEL_OUTCOME_UNKNOWN' })
      expect(s.requests).toEqual(['inpatient_drg_recommendation'])
    } else {
      expect(await s.read()).toMatchObject({ taskId: task.id, status: 'succeeded' })
      expect(s.requests).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
    }
    await s.fixture.restart(); await s.fixture.runtime.dispatchPending()
    expect((await s.read()).status).toBe(outcome)
    expect(s.requests).toHaveLength(outcome === 'unknown' ? 1 : 2)
  } finally { release(); await running }
})

it('独立冠脉造影不产生PCI缺计划误报，真正没有人工计划的PCI仍保留缺项', async () => {
  const s = await setupAgent()
  await s.start()
  const angiography = await s.fixture.executeAngiography(s.stay)
  expect(angiography.actualProcedure.coding.code).toBe('88.5500')
  const afterAngiography = await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/review`, inpatientDrgReviewSchema)
  expect(afterAngiography.todos.some(item => item.kind === 'missing-plan' && item.executionId === angiography.id)).toBe(false)
  expect(afterAngiography.comparisons.some(item => item.executionId === angiography.id)).toBe(false)
  const pci = await s.fixture.executePci(s.stay)
  await s.fixture.confirmMainProcedure(s.stay, pci.id)
  const reviewed = await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/review`, inpatientDrgReviewSchema)
  expect(reviewed.todos.filter(item => item.kind === 'missing-plan').map(item => item.executionId)).toEqual([pci.id])
  expect(reviewed.comparisons.some(item => item.executionId === angiography.id)).toBe(false)
  expect(reviewed.comparisons.filter(item => item.executionId === pci.id)).toHaveLength(4)
  expect(s.requests).toEqual([])
})

it('第二台PCI没有自己的冻结计划时使用本次参数，不继承第一台CLI确认的耗材子集', async () => {
  const s = await setupAgent((feature, _index, raw) => {
    const input = z.object({ remaining: z.array(z.object({ materialId: z.string(), quantity: z.number() })),
      proposed: z.array(z.object({ materialId: z.string() }).passthrough()).optional(),
      review: z.object({ issues: z.array(z.object({ key: z.string(), evidence: z.array(z.string()) }).passthrough()) }).passthrough().optional(),
    }).passthrough().parse(raw)
    return feature === 'inpatient_drg_recommendation'
      ? { items: pciAgentGeneration.items.filter(item => input.remaining.some(value => value.materialId === item.materialId && value.quantity > 0)),
          ...(input.review === undefined ? {} : { observations: input.review.issues.map(issue => ({ key: issue.key, explanation: '合成核查保留原手术的计划与实际依据', evidenceIds: issue.evidence })) }) }
      : { items: pciAgentVerification.items.filter(item => input.proposed?.some(value => value.materialId === item.materialId)),
          ...(input.review === undefined ? {} : { observations: input.review.issues.map(issue => ({ key: issue.key, supported: true, reason: '合成来源独立核验' })) }) }
  })
  await s.start(); await s.fixture.runtime.dispatchPending()
  const first = await s.read(), guidewire = first.analysis!.items.find(item => item.materialId === 'hospital-material-pci-guidewire')!
  const confirmed = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/agent/confirm`, { analysisId: first.analysis!.id,
    expectedBasisFingerprint: first.basisFingerprint, expectedRevision: 0, note: '第一台人工仅确认导丝，其他产品没有纳入此计划',
    items: [{ materialId: guidewire.materialId, catalogVersion: guidewire.catalogVersion, quantity: guidewire.quantity, reason: '医生对第一台计划作子集确认' }] })
  expect(confirmed.status).toBe(200)
  expect(inpatientDrgAgentResponseSchema.parse(await confirmed.json()).data.confirmedPlan?.items).toHaveLength(1)
  const firstExecution = await s.fixture.executePci(s.stay)
  await s.fixture.confirmMainProcedure(s.stay, firstExecution.id)
  const original = await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/review`, inpatientDrgReviewSchema)
  const originalIssues = original.todos.filter(item => item.executionId === firstExecution.id && item.kind === 'unplanned-product')
  expect(originalIssues).toHaveLength(3)
  const state = await s.fixture.read('inpatient-doctor', `${s.stay.path}/surgeries`, inpatientSurgeryResponseSchema.shape.data)
  const requested = await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/request`, { encounterVersion: state.encounterVersion,
    procedureId: s.stay.procedure.id, catalogVersion: s.stay.procedure.version, plannedFor: '2026-08-24T15:00:00+08:00', reason: '医生另开第二台PCI计划' })
  expect(requested.status).toBe(200)
  const secondRequest = inpatientSurgeryResponseSchema.parse(await requested.json()).data.requests.at(-1)!
  const selected = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, { expectedVersion: 1,
    parameters: { ...s.parameters, requestId: secondRequest.id } })
  expect(selected.status).toBe(200); inpatientPciSelectionResponseSchema.parse(await selected.json())
  await s.fixture.runtime.dispatchPending()
  const second = await s.read()
  expect(second).toMatchObject({ status: 'succeeded', stage: 'preoperative' })
  expect(second.analysis!.items.map(item => item.materialId).sort()).toEqual([
    'hospital-material-pci-balloon', 'hospital-material-pci-guidewire', 'hospital-material-pci-guiding-catheter', 'hospital-material-pci-stent',
  ])
  expect(second.analysis!.items.map(item => item.quantity)).toEqual([1, 1, 1, 1])
  const retained = await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/review`, inpatientDrgReviewSchema)
  for (const issue of originalIssues) expect(retained.todos.find(item => item.id === issue.id)).toMatchObject({ status: 'pending', executionId: firstExecution.id })
})
