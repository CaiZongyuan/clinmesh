import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientMaterialEstimatesSchema, inpatientMaterialEstimateResponseSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { modelUsageOverviewSchema, modelUsageListSchema } from '@clinmesh/contracts/model-usage'
import { inpatientPciSelectionResponseSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { agentClientSchema, agentCapabilityGrantSchema } from '@clinmesh/contracts/agent'
import { z } from 'zod'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { createPciPaymentDrgFixture, preparePciPaymentDrgFixture } from './fixtures/pci-payment-drg.ts'
import { pciAgentParameters, pciAgentGeneration, pciAgentVerification } from './fixtures/inpatient-drg-agent.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(respond?: (feature: string, input: unknown, index: number) => unknown | Promise<unknown>, pci = false) {
  const prepared = await preparePciPaymentDrgFixture()
  cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))
  const calls: Array<{ feature: string; input: unknown }> = []
  prepared.options.consultationModel = 'synthetic-estimate-model'
  prepared.options.chatCompletionsProvider = new OpenAIChatCompletionsClient({
    apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid/v1',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)), feature: string = body.response_format?.json_schema?.name ?? body.tools?.[0]?.function?.name
      calls.push({ feature, input: JSON.parse(body.messages[1].content) })
      const content = respond ? await respond(feature, calls.at(-1)!.input, calls.length) : feature === 'inpatient_drg_recommendation'
        ? { items: [{ materialId: 'hospital-material-catheter', catalogVersion: 1, quantity: 2,
            reason: '双根导管造影的独立合成方案', evidenceIds: ['angiography-two-catheter'] }] }
        : { items: [{ materialId: 'hospital-material-catheter', applicable: true, compatible: true,
            quantitySupported: true, evidenceSupported: true, reason: '独立核对两根造影方案与目录' }] }
      if (content instanceof Response) return content
      return Response.json({ id: `synthetic-${calls.length}`, model: 'synthetic-estimate-model',
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
    },
  })
  const fixture = await createPciPaymentDrgFixture(prepared)
  cleanups.push(() => fixture.runtime.close())
  const pciAdmission = pci ? await fixture.preparePciAdmission([]) : null
  const stay = pciAdmission ?? await fixture.admitSyntheticCase(['I25.103'], 'bed-general-1')
  return { prepared, fixture, stay, pciAdmission, calls,
    read: () => fixture.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema) }
}

async function plan(s: Awaited<ReturnType<typeof setup>>, procedureId = 'hospital-surgery-8') {
  const response = await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/request`, {
    encounterVersion: s.stay.encounterVersion, procedureId, catalogVersion: 1,
    plannedFor: '2026-08-24T15:00:00+08:00', reason: '医生确认合成冠脉操作方向',
  })
  expect(response.status).toBe(200)
  return inpatientSurgeryResponseSchema.parse(await response.json()).data.requests.at(-1)!
}

async function save(s: Awaited<ReturnType<typeof setup>>, reason: string) {
  const state = (await s.read()).estimates[0]!
  const response = await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/save`, {
    requestId: state.requestId, expectedVersion: state.version, expectedDraftRevision: state.draft?.revision ?? 0,
    expectedBasisFingerprint: state.basisFingerprint, analysisId: state.analysis?.id ?? null,
    items: [{ materialId: 'hospital-material-catheter', catalogVersion: 1, quantity: 2, reason }], note: reason,
  })
  expect(response.status).toBe(200)
  return inpatientMaterialEstimateResponseSchema.parse(await response.json()).data
}

it('窄 Agent Grant 按本次预计操作授权，显式重算续跑不额外要求创建手术权限', async () => {
  const s = await setup(); await plan(s)
  const admin = await s.fixture.login('admin')
  const control = (path: string, input: unknown) => s.fixture.runtime.app.request(path, { method: 'POST',
    headers: { cookie: admin, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(input) })
  const client = agentClientSchema.parse(await (await control('/api/agent/v1/clients', { name: '合成单次预计窄授权验收' })).json())
  const grant = async (operation: string) => agentCapabilityGrantSchema.parse(await (await control('/api/agent/v1/grants', {
    agentClientId: client.agentClientId, operationIds: [operation], practitionerRoleId: 'practitioner-role-inpatient-doctor', ttlSeconds: 3600,
  })).json())
  const write = (token: string, action: string, input: unknown) => s.fixture.runtime.app.request(`${s.stay.path}/material-estimates/${action}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ input }),
  })
  const first = (await s.read()).estimates[0]!
  const requestGrant = await grant('inpatient.material-estimate.request')
  const requested = await write(requestGrant.token, 'request', { requestId: first.requestId, expectedVersion: first.version,
    expectedRequestVersion: first.requestVersion, expectedBasisFingerprint: first.basisFingerprint })
  expect(requested.status, await requested.clone().text()).toBe(200)
  await s.fixture.runtime.dispatchPending()
  const generated = (await s.read()).estimates[0]!
  expect(generated).toMatchObject({ status: 'succeeded', version: 2, draft: { revision: 1 } })
  expect(s.calls).toHaveLength(2)
  const saveGrant = await grant('inpatient.material-estimate.save')
  const saved = await write(saveGrant.token, 'save', { requestId: generated.requestId, expectedVersion: generated.version,
    expectedDraftRevision: generated.draft!.revision, expectedBasisFingerprint: generated.basisFingerprint,
    analysisId: generated.analysis!.id, items: generated.draft!.items, note: '窄授权医生保留人工审阅稿',
  })
  expect(saved.status, await saved.clone().text()).toBe(200)
  const state = inpatientMaterialEstimateResponseSchema.parse(await saved.json()).data
  const confirmation = { requestId: state.requestId, expectedVersion: state.version, expectedDraftRevision: state.draft!.revision,
    expectedBasisFingerprint: state.basisFingerprint, expectedRequestVersion: state.requestVersion,
    encounterVersion: s.stay.encounterVersion, replace: [], reason: '仅本次整批确认授权',
  }
  expect((await write(saveGrant.token, 'confirm', confirmation)).status).toBe(403)
  const confirmGrant = await grant('inpatient.material-estimate.confirm')
  const confirmed = await write(confirmGrant.token, 'confirm', confirmation)
  expect(confirmed.status, await confirmed.clone().text()).toBe(200)
  const cancelGrant = await grant('inpatient.material-estimate.cancel')
  const cancelled = await write(cancelGrant.token, 'cancel', { requestId: state.requestId, expectedVersion: state.version,
    expectedRequestVersion: state.requestVersion, expectedBasisFingerprint: state.basisFingerprint })
  expect(cancelled.status, await cancelled.clone().text()).toBe(200)
  expect(inpatientMaterialEstimateResponseSchema.parse(await cancelled.json()).data.status).toBe('cancelled')
})

it('保存双根导管造影计划即自动预计一次，刷新复用且不启动持续跟进或创建预留收费', async () => {
  const s = await setup()
  expect((await s.read()).estimates).toEqual([])
  const planned = await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/request`, {
    encounterVersion: s.stay.encounterVersion, procedureId: 'hospital-surgery-8', catalogVersion: 1,
    plannedFor: '2026-08-24T15:00:00+08:00', reason: '医生已确认双根导管冠脉造影方向',
  })
  expect(planned.status).toBe(200)
  const requestId = inpatientSurgeryResponseSchema.parse(await planned.json()).data.requests[0]!.id
  await s.fixture.runtime.dispatchPending()
  const first = (await s.read()).estimates[0]!
  expect(first).toMatchObject({ requestId, status: 'succeeded', analysis: { items: [{
    materialId: 'hospital-material-catheter', catalogVersion: 1, quantity: 2, unit: '根', unitPriceFen: 5000, estimatedFen: 10000,
  }] }, draft: { edited: false, items: [{ materialId: 'hospital-material-catheter', quantity: 2 }] } })
  expect((await s.read()).estimates[0]).toEqual(first)
  await s.fixture.runtime.dispatchPending()
  expect(s.calls.map(call => call.feature)).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
  const followup = await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/followup`, inpatientDrgFollowupSchema)
  expect(followup.task).toBeNull()
  expect((await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations).toEqual([])
  expect((await s.fixture.read('cashier', `${s.stay.path}/charges`, inpatientChargesSchema)).charges).toEqual([])
})

it('手改工作稿刷新与同库重启保留；显式重新预计只提供候选差异，版本冲突不覆盖编辑', async () => {
  const s = await setup(); await plan(s); await s.fixture.runtime.dispatchPending()
  const edited = await save(s, '人工保留并核对双导管理由')
  expect(edited.draft).toMatchObject({ revision: 2, edited: true, note: '人工保留并核对双导管理由' })
  await s.fixture.restart(); await s.fixture.runtime.dispatchPending()
  expect((await s.read()).estimates[0]?.draft).toEqual(edited.draft)
  expect(s.calls).toHaveLength(2)
  const requested = await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/request`, {
    requestId: edited.requestId, expectedVersion: edited.version, expectedRequestVersion: edited.requestVersion, expectedBasisFingerprint: edited.basisFingerprint,
  })
  expect(requested.status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  const recomputed = (await s.read()).estimates[0]!
  expect(recomputed.draft).toEqual(edited.draft)
  expect(recomputed.analysis?.id).not.toBe(edited.analysis?.id)
  expect(recomputed.candidateItems).toHaveLength(1)
  expect(s.calls).toHaveLength(4)
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/save`, {
    requestId: edited.requestId, expectedVersion: recomputed.version, expectedDraftRevision: 1,
    expectedBasisFingerprint: recomputed.basisFingerprint, analysisId: null,
    items: edited.draft!.items, note: '过期版本不能覆盖',
  })).status).toBe(409)
  expect((await s.read()).estimates[0]?.draft).toEqual(edited.draft)
})

it('当前工作稿一次原子确认预留，丢回执以原键恢复；再次确认须修改并明确替换原预留', async () => {
  const s = await setup(); await plan(s); await s.fixture.runtime.dispatchPending()
  const edited = await save(s, '统一核对双根造影')
  const input = { requestId: edited.requestId, expectedVersion: edited.version, expectedDraftRevision: edited.draft!.revision,
    expectedBasisFingerprint: edited.basisFingerprint, expectedRequestVersion: edited.requestVersion,
    encounterVersion: s.stay.encounterVersion, replace: [], reason: '一次核对整批预留' }
  const key = randomUUID(), response = await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/confirm`, input, key)
  expect(response.status).toBe(200)
  const receipt = inpatientMaterialEstimateResponseSchema.parse(await response.json())
  const reservations = await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
  expect(reservations.reservations).toMatchObject([{ quantity: 2, priceFen: 5000, unit: '根', status: 'reserved', requestId: edited.requestId }])
  await s.fixture.restart()
  const replay = await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/confirm`, input, key)
  expect(replay.status).toBe(200)
  expect(inpatientMaterialEstimateResponseSchema.parse(await replay.json())).toEqual(receipt)
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/confirm`, input)).status).toBe(409)
  expect((await s.fixture.read('cashier', `${s.stay.path}/charges`, inpatientChargesSchema)).charges).toEqual([])
  expect((await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations).toEqual(reservations.reservations)
  const revised = await save(s, '医生重新审阅同计划整批替换，不能叠加金额')
  const replacementInput = { ...input, expectedDraftRevision: revised.draft!.revision }
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/confirm`, replacementInput)).status).toBe(409)
  expect((await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations).toEqual(reservations.reservations)
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/confirm`, { ...replacementInput,
    replace: reservations.reservations.map(item => ({ reservationId: item.id, expectedVersion: item.version })),
  })).status).toBe(200)
  const replaced = await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
  expect(replaced.reservations.filter(item => item.status === 'reserved')).toMatchObject([{ quantity: 2, priceFen: 5000 }])
  expect(replaced.reservations.filter(item => item.status === 'released')).toHaveLength(1)
})

it('PCI 正式参数自动带入，缺单位不派发；首次生成核验计量并保持有限数量范围', async () => {
  const s = await setup(feature => feature === 'inpatient_drg_recommendation' ? pciAgentGeneration : pciAgentVerification, true)
  if (!s.pciAdmission) throw new Error('PCI fixture requires a planned request')
  expect((await s.read()).estimates[0]).toMatchObject({ status: 'incomplete', draft: null })
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toHaveLength(0)
  const parameters = { ...pciAgentParameters, requestId: s.pciAdmission.requestId }
  const incomplete = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, { expectedVersion: 0,
    parameters: { ...parameters, measurements: parameters.measurements.map(item => ({ ...item, unit: null })) } })
  expect(incomplete.status).toBe(200)
  inpatientPciSelectionResponseSchema.parse(await incomplete.json())
  await s.fixture.runtime.dispatchPending()
  expect((await s.read()).estimates[0]?.status).toBe('incomplete')
  expect(s.calls).toHaveLength(0)
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, { expectedVersion: 1, parameters })).status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  const state = (await s.read()).estimates[0]!
  expect(state).toMatchObject({ status: 'succeeded', draft: { edited: false, items: expect.arrayContaining([
    { materialId: 'hospital-material-pci-stent', catalogVersion: 1, quantity: 1, reason: '已核对合成支架组合' },
  ]) } })
  expect(state.analysis?.items).toHaveLength(4)
  const usagePath = `caseId=${s.stay.admissionId}&taskId=${state.id}`
  const usage = await s.fixture.read('inpatient-doctor', `/api/model-usage/overview?${usagePath}`, modelUsageOverviewSchema)
  expect(usage.totals).toMatchObject({ requests: 2, knownInputTokens: 200, knownOutputTokens: 40 })
  const attempts = await s.fixture.read('inpatient-doctor', `/api/model-usage/requests?${usagePath}`, modelUsageListSchema)
  expect(attempts.items.map(item => item.context.stage).sort()).toEqual(['estimate-1-generation', 'estimate-1-verification'])
  expect(attempts.items.every(item => item.context.sources.some(source => source.id === `ServiceRequest/${state.requestId}`))).toBe(true)
  const input = z.object({ estimate: z.object({ diagnosis: z.object({ entries: z.array(z.unknown()) }) }),
    selection: z.object({ confirmation: z.object({ parameters: z.object({ measurements: z.array(z.object({ value: z.number(), unit: z.string() })) }) }) }) }).parse(s.calls[0]!.input)
  expect(input.selection.confirmation.parameters.measurements.map(item => [item.value, item.unit])).toEqual([[12, 'mm'], [3, 'mm'], [3, 'mm']])
  expect(input.estimate.diagnosis.entries.length).toBeGreaterThan(0)
  expect(JSON.stringify(s.calls)).not.toMatch(/caseDraft|caseTruth|plannedStentCount|FM39|FM59/)
  const otherRequest = await plan(s, s.pciAdmission.procedure.id)
  const other = (await s.read()).estimates.find(item => item.requestId === otherRequest.id)!
  expect(other.status).toBe('incomplete')
  expect(other.candidates.every(item => item.eligibility !== 'valid' && item.expectedQuantity === null)).toBe(true)
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toHaveLength(2)
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, { expectedVersion: 2,
    parameters: { ...parameters, plannedQuantities: parameters.plannedQuantities.map(item => item.category === 'stent' ? { ...item, quantity: 2 } : item) },
  })).status).toBe(200)
  const changed = (await s.read()).estimates[0]!
  expect(changed.status).toBe('stale')
  expect(changed.candidates.find(item => item.materialId === 'hospital-material-pci-stent')?.eligibility).toBe('inapplicable')
  expect(changed.draft).toEqual(state.draft)
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/request`, { requestId: changed.requestId,
    expectedVersion: changed.version, expectedRequestVersion: changed.requestVersion, expectedBasisFingerprint: changed.basisFingerprint,
  })).status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  expect((await s.read()).estimates[0]?.status).toBe('incomplete')
  expect(s.calls).toHaveLength(2)
})

it('模型不可用保留原因且不阻断计划，医生仍可用有效院内方案一次确认', async () => {
  const s = await setup()
  // 测试装配关闭模型边界；产品不引入验收开关，也不读取本机真实 Provider。
  s.prepared.options.chatCompletionsProvider = { completeJson: async () => { throw new Error('Unavailable synthetic provider must not dispatch') } }
  await s.fixture.restart()
  await plan(s); await s.fixture.runtime.dispatchPending()
  const state = (await s.read()).estimates[0]!
  expect(state).toMatchObject({ status: 'blocked', failureCode: 'MODEL_METERING_UNAVAILABLE', draft: null })
  const saved = await save(s, '模型不可用，医生按有效双根造影院内方案独立核对')
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/confirm`, {
    requestId: saved.requestId, expectedVersion: saved.version, expectedDraftRevision: saved.draft!.revision,
    expectedBasisFingerprint: saved.basisFingerprint, expectedRequestVersion: saved.requestVersion,
    encounterVersion: s.stay.encounterVersion, replace: [], reason: '人工核对有效院内方案后确认',
  })).status).toBe(200)
  expect(s.calls).toHaveLength(0)
})

it.each(['正式核查', '岗位授权撤销', 'Epoch重置'] as const)('%s在生成途中变化使晚到结果失效，不自动再派发', async change => {
  let entered!: () => void, release!: () => void
  const received = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const s = await setup(async () => { entered(); await gate; return { items: [{ materialId: 'hospital-material-catheter', catalogVersion: 1,
    quantity: 2, reason: '生成时的旧合成资料', evidenceIds: ['angiography-two-catheter'] }] } })
  const planned = await plan(s)
  const running = s.fixture.runtime.dispatchPending()
  try {
    await received
    if (change === '正式核查') {
      expect((await s.fixture.request('ward-nurse', `${s.stay.path}/surgeries/check-preop`, {
        requestId: planned.id, expectedRequestVersion: planned.version, note: '正式术前核查更新使原计划版本变化',
      })).status).toBe(200)
    } else if (change === '岗位授权撤销') {
      // 身份基础设施变更夹具；业务结果仍由公开 Query 核对。
      s.fixture.runtime.database.driver.prepare('DELETE FROM membership_practitioner_role WHERE practitioner_role_id=?')
        .run('practitioner-role-inpatient-doctor')
    } else {
      expect((await s.fixture.runtime.app.request('/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', { method: 'POST',
        headers: { cookie: await s.fixture.login('admin'), origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: '{}',
      })).status).toBe(200)
    }
    release(); await running
    if (change === 'Epoch重置') expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates`)).status).toBe(404)
    else expect((await s.fixture.read('medical-records', `${s.stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates[0])
      .toMatchObject({ status: 'stale', analysis: null, draft: null })
    await s.fixture.runtime.dispatchPending(); await s.fixture.restart(); await s.fixture.runtime.dispatchPending()
    expect(s.calls).toHaveLength(1)
  } finally { release(); await running }
})

it('单根造影有独立数量依据，正式输入隔离PCI及隐藏作者事实', async () => {
  const s = await setup(feature => feature === 'inpatient_drg_recommendation'
    ? { items: [{ materialId: 'hospital-material-catheter', catalogVersion: 1, quantity: 1, reason: '正式单根导管计划', evidenceIds: ['angiography-one-catheter'] }] }
    : { items: [{ materialId: 'hospital-material-catheter', applicable: true, compatible: true, quantitySupported: true, evidenceSupported: true, reason: '独立核对单根方案' }] })
  await plan(s, 'hospital-surgery-7'); await s.fixture.runtime.dispatchPending()
  expect((await s.read()).estimates[0]).toMatchObject({ status: 'succeeded', analysis: { items: [{ quantity: 1, estimatedFen: 5000 }] } })
  const input = z.object({ estimate: z.object({ request: z.object({ plannedProcedure: z.object({ coding: z.object({ code: z.string() }) }) }),
    diagnosis: z.object({ revision: z.number() }), candidates: z.array(z.object({ materialId: z.string() })) }),
    selection: z.object({ confirmation: z.null(), candidates: z.array(z.unknown()) }) }).parse(s.calls[0]!.input)
  expect(input.estimate.request.plannedProcedure.coding.code).toBe('88.5500')
  expect(input.estimate.diagnosis.revision).toBe(1)
  expect(input.estimate.candidates.map(item => item.materialId)).toEqual(['hospital-material-catheter'])
  expect(input.selection.candidates).toEqual([])
  expect(JSON.stringify(s.calls)).not.toMatch(/caseDraft|caseTruth|plannedStentCount|FM39|FM59|Hidden Fact/)
})

it.each(['错误数量', '混入PCI材料', '独立核验拒绝'] as const)('%s不能成为可确认AI预计，仍允许有依据院内方案人工继续', async kind => {
  const s = await setup(feature => feature === 'inpatient_drg_recommendation'
    ? { items: [{ materialId: kind === '混入PCI材料' ? 'hospital-material-pci-stent' : 'hospital-material-catheter', catalogVersion: 1,
        quantity: kind === '错误数量' ? 1 : 2, reason: '合成反例输出', evidenceIds: ['angiography-two-catheter'] }] }
    : { items: [{ materialId: 'hospital-material-catheter', applicable: true, compatible: false, quantitySupported: true, evidenceSupported: true, reason: '独立核验明确拒绝兼容声明' }] })
  await plan(s); await s.fixture.runtime.dispatchPending()
  const state = (await s.read()).estimates[0]!
  expect(state.status).toBe('failed')
  expect(state.failureCode).toBe('INPATIENT_DRG_AGENT_INVALID')
  expect(state.analysis).toBeNull()
  expect(state.draft).toBeNull()
  const fallback = await save(s, '医生按当前有效双根造影院内方案核对，保留AI失败原因')
  const response = await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/confirm`, {
    requestId: fallback.requestId, expectedVersion: fallback.version, expectedDraftRevision: fallback.draft!.revision,
    expectedBasisFingerprint: fallback.basisFingerprint, expectedRequestVersion: fallback.requestVersion,
    encounterVersion: s.stay.encounterVersion, replace: [], reason: '使用已核验院内方案',
  })
  expect(response.status).toBe(200)
  expect((await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations)
    .toMatchObject([{ materialId: 'hospital-material-catheter', quantity: 2 }])
})

it('生成校验错误被修复后，独立核验的请求失败仍归为普通模型失败', async () => {
  let generations = 0
  const s = await setup(feature => feature === 'inpatient_drg_recommendation'
    ? { items: [{ materialId: 'hospital-material-catheter', catalogVersion: 1, quantity: ++generations === 1 ? 1 : 2,
      reason: '受控格式修复后数量符合双根造影方案', evidenceIds: ['angiography-two-catheter'] }] }
    : Response.json({ error: { message: 'Synthetic verification unavailable' } }, { status: 500 }))
  await plan(s); await s.fixture.runtime.dispatchPending()
  expect((await s.read()).estimates[0]).toMatchObject({ status: 'failed', failureCode: 'INPATIENT_DRG_AGENT_FAILED', analysis: null, draft: null })
  expect(generations).toBe(2)
})

it('模型结果未知先核查原尝试，刷新重启和显式重算都不重复派发', async () => {
  const s = await setup(() => { throw new Error('Synthetic connection lost after dispatch') })
  await plan(s); await s.fixture.runtime.dispatchPending()
  const state = (await s.read()).estimates[0]!
  expect(state).toMatchObject({ status: 'unknown', failureCode: 'MODEL_OUTCOME_UNKNOWN', analysis: null, draft: null })
  await s.fixture.restart(); await s.fixture.runtime.dispatchPending()
  expect((await s.read()).estimates[0]?.status).toBe('unknown')
  const response = await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/request`, {
    requestId: state.requestId, expectedVersion: state.version, expectedRequestVersion: state.requestVersion, expectedBasisFingerprint: state.basisFingerprint,
  })
  expect(response.status).toBe(409)
  expect(s.calls).toHaveLength(1)
})

it('在途取消使晚到结果停止发布，人工工作稿不被后台结果覆盖', async () => {
  let entered!: () => void, release!: () => void
  const received = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const s = await setup(async () => { entered(); await gate; return { items: [{ materialId: 'hospital-material-catheter', catalogVersion: 1,
    quantity: 2, reason: '晚到合成结果', evidenceIds: ['angiography-two-catheter'] }] } })
  await plan(s)
  const running = s.fixture.runtime.dispatchPending()
  try {
    await received
    const state = (await s.read()).estimates[0]!
    const saved = await save(s, '生成中人工保存的计划说明')
    expect(saved.draft?.edited).toBe(true)
    const response = await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/cancel`, {
      requestId: state.requestId, expectedVersion: state.version, expectedRequestVersion: state.requestVersion, expectedBasisFingerprint: state.basisFingerprint,
    })
    expect(response.status).toBe(200)
    release(); await running
    const cancelled = (await s.read()).estimates[0]!
    expect(cancelled).toMatchObject({ status: 'cancelled', analysis: null, draft: saved.draft })
    expect(s.calls).toHaveLength(1)
    expect((await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations).toEqual([])
  } finally { release(); await running }
})

it('目录变化明确失效，旧工作稿不能静默按新价格确认且读取不重算', async () => {
  const s = await setup(); await plan(s); await s.fixture.runtime.dispatchPending()
  const state = await save(s, '原目录核对')
  s.fixture.runtime.database.driver.exec(`UPDATE inpatient_surgery_catalog SET version=2,
    snapshot_json=json_set(snapshot_json,'$.version',2,'$.chargeDefinition.priceFen',6000) WHERE item_id='hospital-material-catheter'`)
  const changed = (await s.read()).estimates[0]!
  expect(changed.status).toBe('stale')
  expect(changed.basisFingerprint).not.toBe(state.basisFingerprint)
  expect(changed.candidates[0]).toMatchObject({ eligibility: 'unavailable', item: null })
  expect(changed.draft).toEqual(state.draft)
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/confirm`, {
    requestId: state.requestId, expectedVersion: state.version, expectedDraftRevision: state.draft!.revision,
    expectedBasisFingerprint: state.basisFingerprint, expectedRequestVersion: state.requestVersion,
    encounterVersion: s.stay.encounterVersion, replace: [], reason: '旧价格禁止静默确认',
  })).status).toBe(409)
  expect(s.calls).toHaveLength(2)
})

it('Scenario Run 完成后医生、护士和病案仍可读取预计与工作稿快照，不派发模型', async () => {
  const s = await setup(); await plan(s); await s.fixture.runtime.dispatchPending()
  const original = await save(s, 'Run 完成后的历史只读稿')
  s.fixture.runtime.database.driver.prepare("UPDATE scenario_run SET status='completed' WHERE scenario_run_id='scenario-run-1'").run()
  for (const role of ['inpatient-doctor', 'ward-nurse', 'medical-records']) {
    const response = await s.fixture.request(role, `${s.stay.path}/material-estimates`)
    expect(response.status, await response.clone().text()).toBe(200)
    const frozen = inpatientMaterialEstimatesSchema.parse(await response.json())
    expect(frozen.estimates[0]).toMatchObject({ status: 'stale', draft: original.draft, analysis: original.analysis })
    expect(frozen.unprepared).toEqual([])
  }
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toHaveLength(2)
})
