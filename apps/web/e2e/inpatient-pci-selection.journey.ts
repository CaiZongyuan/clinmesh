import { selectInpatientStage } from './inpatient-ui.ts'
import type { Page } from '@playwright/test'
import { inpatientSurgerySchema, inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { createDrgBrowserPatient, expect } from './inpatient-drg.fixture.ts'

export async function runPciSelectionJourney(page: Page, app: { origin: string; password: string }, open: () => Promise<void>) {
  const s = await createDrgBrowserPatient(page, app, '合成PCI参数患者')
  await s.api.login('admin')
  expect((await s.api.post('/api/his/v1/inpatient/pci-data/prepare', { expectedEpoch: 'epoch-1' })).status()).toBe(200)
  await s.api.login('inpatient-doctor')
  const surgery = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  const requested = inpatientSurgeryResponseSchema.parse(await (await s.api.post(`${s.path}/surgeries/request`, { encounterVersion: surgery.encounterVersion, procedureId: 'hospital-surgery-3', catalogVersion: 1, plannedFor: '2026-08-25T09:00:00+08:00', reason: '合成PCI参数关联计划' })).json())
  const requestId = requested.data.requests[0]!.id
  const show = async () => {
    await open()
    await page.getByRole('button', { name: /合成PCI参数患者/ }).click()
    await selectInpatientStage(page, "手术")
  }
  await show()
  const region = page.getByRole('region', { name: '选型参数', exact: true })
  const actions = page.getByRole('region', { name: '当前操作', exact: true })
  await expect(region).toContainText('报告没写的测量可以留空')
  await expect(region.getByLabel('靶病变部位', { exact: true })).toHaveValue('')
  await expect(region.getByLabel('病变长度 (mm)', { exact: true })).toHaveValue('')
  await region.getByLabel('治疗方向与术式', { exact: true }).fill('医生确认的合成单病变择期PCI')
  await region.getByLabel('靶病变部位', { exact: true }).fill('LAD中段')
  await region.getByLabel('病变长度 (mm)', { exact: true }).fill('12')
  await region.getByLabel('近端参考管径 (mm)', { exact: true }).fill('3')
  await region.getByLabel('远端参考管径 (mm)', { exact: true }).fill('3')
  await actions.getByRole('button', { name: '确认选型参数', exact: true }).click()
  await expect(region).toContainText('你 · 已确认')
  await expect(region).toContainText('LAD中段 · 病变长度 12 mm · 参考直径 3 / 3 mm')
  const confirmed = inpatientPciSelectionSchema.parse(await (await s.api.get(`${s.path}/pci-selection`)).json())
  expect(confirmed.confirmation?.parameters.requestId).toBe(requestId)
  expect(confirmed.confirmation?.parameters.measurements.map(item => item.value)).toEqual([12, 3, 3])
  expect(confirmed.candidates.map(item => item.expectedQuantity)).toEqual([1, 1, 1, 1])
  expect(confirmed.candidates.every(item => item.eligibility === 'valid')).toBe(true)
  await show()
  await expect(region).toContainText('你 · 已确认')
  await region.getByRole('button', { name: '修改', exact: true }).click()
  await expect(region.getByLabel('病变长度 (mm)', { exact: true })).toHaveValue('12')
  await region.getByLabel('病变长度 (mm)', { exact: true }).fill('30')
  await actions.getByRole('button', { name: '确认选型参数', exact: true }).click()
  await expect(region).toContainText('LAD中段 · 病变长度 30 mm · 参考直径 3 / 3 mm')
  const changed = inpatientPciSelectionSchema.parse(await (await s.api.get(`${s.path}/pci-selection`)).json())
  expect(changed.candidates.every(item => item.eligibility === 'inapplicable')).toBe(true)
  expect(changed.history.map(item => item.version)).toEqual([2, 1])
}
