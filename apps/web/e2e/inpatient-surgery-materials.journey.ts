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
  await open()
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await page.getByRole('tab', { name: '手术', exact: true }).click()
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
  await page.getByRole('tab', { name: 'DRG 与费用推演', exact: true }).click()
  await expect(page.getByRole('region', { name: '治疗耗材预留', exact: true })).toContainText('已用 1 · 余量 1')
  await page.getByRole('tab', { name: '手术', exact: true }).click()
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
  await panel.getByLabel('本笔使用或更正依据', { exact: true }).fill('合成 PCI 手术结束并收拢备用余量')
  await panel.getByRole('button', { name: '确认完成本次手术', exact: true }).click()
  await expect(page.getByText('实际实施：00.6600 · 经皮冠状动脉腔内血管成形术[PTCA]', { exact: true })).toBeVisible()
  const final = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  expect(final.inProgress).toEqual([])
  expect(final.executions).toHaveLength(1)
  expect(final.executions[0]!.materialHistory).toHaveLength(4)
  const completion = inpatientDrgSimulationSchema.parse(await (await s.api.post(`${s.path}/drg/simulation`, {})).json())
  expect(completion.formal.chargesFen).toBe(280000)
  expect(completion.reserved.items).toEqual([])
}
