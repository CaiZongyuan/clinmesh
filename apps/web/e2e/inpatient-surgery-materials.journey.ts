import { selectInpatientStage } from './inpatient-ui.ts'
import type { Page } from '@playwright/test'
import { inpatientSurgeryResponseSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientDrgSimulationSchema, inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { createDrgBrowserPatient, expect } from './inpatient-drg.fixture.ts'

type Patient = Awaited<ReturnType<typeof createDrgBrowserPatient>>
export async function prepareSurgeryMaterialsPatient(page: Page, app: Parameters<typeof createDrgBrowserPatient>[1]) {
  const s = await createDrgBrowserPatient(page, app, '合成术中耗材逐笔患者')
  const surgery = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  const requested = inpatientSurgeryResponseSchema.parse(await (await s.api.post(`${s.path}/surgeries/request`, {
    encounterVersion: surgery.encounterVersion, procedureId: 'hospital-surgery-1', catalogVersion: 1,
    plannedFor: '2026-08-24T15:00:00+08:00', reason: '合成 PCI 逐笔耗材验证',
  })).json()).data.requests[0]!
  await s.api.login('ward-nurse')
  expect((await s.api.post(`${s.path}/surgeries/check-preop`, { requestId: requested.id, expectedRequestVersion: requested.version, note: '合成术前已核对' })).status()).toBe(200)
  await s.api.login('inpatient-doctor')
  const checked = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json()).requests[0]!
  expect((await s.api.post(`${s.path}/surgeries/confirm-consent`, { requestId: requested.id, expectedRequestVersion: checked.version, note: '合成签署已确认' })).status()).toBe(200)
  expect((await s.api.post(`${s.path}/drg/reservations`, { encounterVersion: surgery.encounterVersion,
    requestId: requested.id, materialId: 'hospital-material-stent', catalogVersion: 1, quantity: 2, reason: '合成两枚支架备用' })).status()).toBe(200)
  return s
}

export async function runSurgeryMaterialsJourney(page: Page, s: Patient, open: () => Promise<void>) {
  const actions = page.getByRole('region', { name: '当前操作', exact: true })
  await open()
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await selectInpatientStage(page, "手术")
  await page.getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: '00.6600 · 经皮冠状动脉腔内血管成形术[PTCA]', exact: true }).click()
  await page.getByLabel('手术记录说明', { exact: true }).fill('合成开始术中逐笔记录')
  await page.getByRole('button', { name: '开始手术逐笔登记', exact: true }).click()
  const panel = page.getByRole('region', { name: '术中耗材逐笔登记', exact: true })
  await expect(panel).toContainText('手术进行中')
  await panel.getByLabel('本笔耗材产品', { exact: true }).click()
  await page.getByRole('option', { name: '合成演示冠脉支架', exact: true }).click()
  await panel.getByLabel('本笔消耗预留', { exact: true }).click()
  await page.getByRole('option', { name: /合成演示冠脉支架 · 余量 2/ }).click()
  await panel.getByLabel('本笔使用或更正依据', { exact: true }).fill('合成第一枚支架实际使用')
  await panel.getByRole('button', { name: '确认登记本笔使用', exact: true }).click()
  await expect(panel).toContainText('合成演示冠脉支架 × 1个')
  const partial = inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json()).reservations[0]!
  expect(partial).toMatchObject({ consumedQuantity: 1, remainingQuantity: 1, status: 'reserved' })
  expect(inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json()).executions).toEqual([])
  await expect(panel.getByLabel('本笔消耗预留', { exact: true })).toContainText('余量 1')
  await panel.getByLabel('本笔使用或更正依据', { exact: true }).fill('同一部分预留核实更正原使用说明')
  await panel.getByRole('button', { name: '更正为当前选择 合成演示冠脉支架', exact: true }).click()
  await expect.poll(async () => inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json()).inProgress[0]?.materialHistory.length).toBe(2)
  const correctedReservation = inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json()).reservations[0]!
  expect(correctedReservation).toMatchObject({ consumedQuantity: 1, remainingQuantity: 1, status: 'reserved' })
  await selectInpatientStage(page, "DRG 预分组")
  await expect(page.getByRole('region', { name: '治疗耗材预留', exact: true })).toContainText('已用 1 · 余量 1')
  await selectInpatientStage(page, "手术")
  await panel.getByLabel('本笔耗材产品', { exact: true }).click()
  await page.getByRole('option', { name: '合成演示冠脉球囊', exact: true }).click()
  await panel.getByLabel('本笔使用或更正依据', { exact: true }).fill('合成临时增加球囊')
  await panel.getByRole('button', { name: '确认登记本笔使用', exact: true }).click()
  await expect(panel).toContainText('合成演示冠脉球囊 × 1个')
  await panel.getByLabel('本笔实际数量', { exact: true }).fill('2')
  await panel.getByLabel('本笔使用或更正依据', { exact: true }).fill('合成核实球囊实际为两枚')
  await panel.getByRole('button', { name: '更正为当前选择 合成演示冠脉球囊', exact: true }).click()
  await expect(panel).toContainText('合成演示冠脉球囊 × 2个')
  const evaluated = inpatientDrgSimulationSchema.parse(await (await s.api.post(`${s.path}/drg/simulation`, {})).json())
  expect(evaluated.formal.chargesFen).toBe(160000)
  await actions.getByRole('button', { name: '核实最终耗材并完成手术', exact: true }).click()
  const review = panel.getByRole('region', { name: '核实最终耗材', exact: true })
  await review.getByRole('checkbox', { name: /释放完成后的余量/ }).check()
  await review.getByLabel('最终用量核实依据', { exact: true }).fill('合成 PCI 手术结束并明确释放备用余量')
  await actions.getByRole('button', { name: '预览本次差额', exact: true }).click()
  await expect(review).toContainText('本次材料差额合计 ¥0.00')
  await actions.getByRole('button', { name: '确认完成本次手术', exact: true }).click()
  await expect(page.getByText('实际实施：00.6600 · 经皮冠状动脉腔内血管成形术[PTCA]', { exact: true })).toBeVisible()
  const final = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  expect(final.inProgress).toEqual([])
  expect(final.executions).toHaveLength(1)
  expect(final.executions[0]!.materialHistory).toHaveLength(4)
  const completion = inpatientDrgSimulationSchema.parse(await (await s.api.post(`${s.path}/drg/simulation`, {})).json())
  expect(completion.formal.chargesFen).toBe(280000)
  expect(completion.reserved.items).toEqual([])
}

export async function prepareFinalMaterialsPatient(page: Page, app: Parameters<typeof createDrgBrowserPatient>[1]) {
  const s = await prepareSurgeryMaterialsPatient(page, app)
  let state = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  const request = state.requests[0]!
  expect((await s.api.post(`${s.path}/drg/reservations`, { encounterVersion: state.encounterVersion, requestId: request.id,
    materialId: 'hospital-material-balloon', catalogVersion: 1, quantity: 2, reason: '合成未选备用球囊' })).status()).toBe(200)
  state = inpatientSurgeryResponseSchema.parse(await (await s.api.post(`${s.path}/surgeries/start`, { requestId: request.id,
    expectedRequestVersion: request.version, procedureId: 'hospital-surgery-1', catalogVersion: 1, note: '合成最终总量核实开始' })).json()).data
  for (const materialId of ['hospital-material-stent', 'hospital-material-balloon']) {
    const reservation = inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json()).reservations.find(item => item.materialId === materialId)!
    state = inpatientSurgeryResponseSchema.parse(await (await s.api.post(`${s.path}/surgeries/record-material`, {
      requestId: request.id, expectedRequestVersion: state.requests[0]!.version, executionId: state.inProgress[0]!.id, note: '合成核实前逐笔记录',
      material: { materialId, catalogVersion: 1, quantity: materialId === 'hospital-material-stent' ? 2 : 1,
        ...(materialId === 'hospital-material-stent' ? { reservationId: reservation.id, expectedReservationVersion: reservation.version } : {}) },
    })).json()).data
  }
  return s
}

export async function runFinalMaterialsJourney(page: Page, s: Patient, open: () => Promise<void>) {
  const actions = page.getByRole('region', { name: '当前操作', exact: true })
  await open()
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await selectInpatientStage(page, "手术")
  const panel = page.getByRole('region', { name: '术中耗材逐笔登记', exact: true })
  await expect(panel).toBeVisible()
  await actions.getByRole('button', { name: '核实最终耗材并完成手术', exact: true }).click()
  let review = page.getByRole('region', { name: '核实最终耗材', exact: true })
  await review.getByLabel('最终用量核实依据', { exact: true }).fill('合成取消审阅不写业务事实')
  await review.getByRole('button', { name: '取消本次核实', exact: true }).click()
  expect(inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json()).executions).toEqual([])
  await actions.getByRole('button', { name: '核实最终耗材并完成手术', exact: true }).click()
  review = page.getByRole('region', { name: '核实最终耗材', exact: true })
  await review.getByLabel('合成演示冠脉支架 · 最终总量 1', { exact: true }).fill('1')
  await review.getByLabel('合成演示冠脉球囊 · 最终总量 2', { exact: true }).fill('0')
  await review.getByRole('checkbox', { name: /释放完成后的余量 · 合成演示冠脉支架/ }).check()
  await review.getByLabel('新增最终耗材', { exact: true }).click()
  await page.getByRole('option', { name: '合成演示缝合材料', exact: true }).click()
  await review.getByLabel('最终用量核实依据', { exact: true }).fill('核实支架一枚、球囊未用并新增缝线，保留未选预留')
  await actions.getByRole('button', { name: '预览本次差额', exact: true }).click()
  await expect(review).toContainText('本次材料差额合计 -¥1,180.00')
  await expect(review).toContainText('未选预留保留 · 合成演示冠脉球囊')
  await review.getByLabel('合成演示缝合材料 · 最终总量 4', { exact: true }).fill('2')
  await expect(actions.getByRole('button', { name: '确认完成本次手术', exact: true })).toHaveCount(0)
  await review.getByLabel('合成演示缝合材料 · 最终总量 4', { exact: true }).fill('1')
  await review.getByRole('button', { name: '刷新核实依据，保留编辑', exact: true }).click()
  await actions.getByRole('button', { name: '预览本次差额', exact: true }).click()
  await expect(actions.getByRole('button', { name: '确认完成本次手术', exact: true })).toBeEnabled()
  let posts = 0, originalKey: string | undefined
  await page.route('**/surgeries/complete', async route => {
    posts += 1
    originalKey = route.request().headers()['idempotency-key']
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    inpatientSurgeryResponseSchema.parse(await response.json())
    await route.abort('failed')
  })
  await actions.getByRole('button', { name: '确认完成本次手术', exact: true }).click()
  await expect(page.getByRole('button', { name: '恢复原住院操作', exact: true })).toBeVisible()
  const receiptRequest = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
  expect(new URL((await receiptRequest).url()).searchParams.get('idempotencyKey')).toBe(originalKey)
  await expect(page.getByText('实际实施：00.6600 · 经皮冠状动脉腔内血管成形术[PTCA]', { exact: true })).toBeVisible()
  expect(posts).toBe(1)
  const final = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  expect(final.inProgress).toEqual([])
  expect(final.executions[0]!.materials.map(item => [item.item.id, item.quantity])).toEqual([
    ['hospital-material-stent', 1], ['hospital-material-suture', 1],
  ])
  const reservationList = inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json())
  expect(reservationList.reservations.find(item => item.materialId === 'hospital-material-balloon')).toMatchObject({ status: 'reserved', remainingQuantity: 2 })
  expect(reservationList.reservations.find(item => item.materialId === 'hospital-material-stent')).toMatchObject({ status: 'released', consumedQuantity: 1 })
  const simulation = inpatientDrgSimulationSchema.parse(await (await s.api.post(`${s.path}/drg/simulation`, {})).json())
  expect(simulation.formal.chargesFen).toBe(202000)
}
