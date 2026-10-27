import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { inpatientDrgAgentSchema, inpatientDrgAgentResponseSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { inpatientDrgFollowupResponseSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientPciSelectionResponseSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { apiErrorSchema } from '@clinmesh/contracts/his'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { pciAgentParameters, pciAgentGeneration, pciAgentVerification } from './fixtures/inpatient-drg-agent.ts'
import { createPciPaymentDrgFixture, preparePciPaymentDrgFixture } from './fixtures/pci-payment-drg.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setupAgent(respond?: (feature: string, index: number) => unknown | Promise<unknown>) {
  const prepared = await preparePciPaymentDrgFixture()
  cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))
  const requests: string[] = []
  prepared.options.consultationModel = 'synthetic-drg-model'
  prepared.options.chatCompletionsProvider = new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid/v1',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)), feature = body.response_format.json_schema.name
      requests.push(feature)
      const result = respond === undefined ? feature === 'inpatient_drg_recommendation' ? pciAgentGeneration : pciAgentVerification
        : await respond(feature, requests.length)
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
