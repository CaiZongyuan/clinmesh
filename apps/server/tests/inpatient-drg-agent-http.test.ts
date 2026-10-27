import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { inpatientDrgAgentSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { inpatientDrgFollowupResponseSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientPciSelectionResponseSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { pciAgentParameters, pciAgentGeneration, pciAgentVerification } from './fixtures/inpatient-drg-agent.ts'
import { createPciPaymentDrgFixture, preparePciPaymentDrgFixture } from './fixtures/pci-payment-drg.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

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
})
