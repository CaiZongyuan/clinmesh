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
    await page.getByRole('tab', { name: '手术', exact: true }).click()
    await page.getByText('PCI 选型参数与候选依据', { exact: true }).click()
  }
  await show()
  const region = page.getByRole('region', { name: 'PCI 参数与候选', exact: true })
  await expect(region.getByText('尚未确认参数；未知测量保留未知，不从耗材规格反推。')).toBeVisible()
  await region.getByLabel('关联 PCI 手术计划', { exact: true }).click()
  await page.getByRole('option', { name: /合成PCI参数关联计划/ }).click()
  await region.getByLabel('治疗方向与术式', { exact: true }).fill('医生确认的合成单病变择期PCI')
  await region.getByLabel('靶病变部位', { exact: true }).fill('LAD中段')
  await expect(region.getByLabel('病变长度 数值', { exact: true })).toHaveValue('')
  await region.getByRole('button', { name: '确认 PCI 参数', exact: true }).click()
  await expect(region.getByText(/已确认参数 v1/)).toBeVisible()
  const measurements = [ ['病变长度', '12', '病变', 'LAD中段'], ['近端参考直径', '3', '参考管腔', 'LAD近端'], ['远端参考直径', '3', '参考管腔', 'LAD远端'] ] as const
  for (const [label, value, object, site] of measurements) {
    await region.getByLabel(`${label} 数值`, { exact: true }).fill(value)
    await region.getByLabel(`${label} 单位`, { exact: true }).fill('mm')
    await region.getByLabel(`${label} 测量对象`, { exact: true }).click()
    await page.getByRole('option', { name: object, exact: true }).click()
    await region.getByLabel(`${label} 部位`, { exact: true }).fill(site)
    await region.getByLabel(`${label} 方法`, { exact: true }).fill('合成IVUS电动回撤')
    await region.getByLabel(`${label} 来源标识`, { exact: true }).fill('synthetic-report-1')
    await region.getByLabel(`${label} 来源版本`, { exact: true }).fill('1')
    await region.getByLabel(`${label} 来源说明`, { exact: true }).fill('医生手工核对的合成测量')
  }
  for (const label of ['导丝', '导引导管', '球囊', '支架']) {
    await region.getByLabel(`${label} 预计数量`, { exact: true }).fill('1')
    await region.getByLabel(`${label} 数量依据`, { exact: true }).fill('医生独立计划各一件')
  }
  for (const checkbox of await region.getByRole('checkbox').all()) await checkbox.check()
  await region.getByRole('button', { name: '确认 PCI 参数', exact: true }).click()
  await expect(region.getByText(/已确认参数 v2/)).toBeVisible()
  await expect(region.getByText('候选状态：可用于仿真建议', { exact: true })).toHaveCount(4)
  const confirmed = inpatientPciSelectionSchema.parse(await (await s.api.get(`${s.path}/pci-selection`)).json())
  expect(confirmed.confirmation?.parameters.requestId).toBe(requestId)
  expect(confirmed.confirmation?.parameters.measurements.map(item => item.value)).toEqual([12, 3, 3])
  expect(confirmed.candidates.map(item => item.expectedQuantity)).toEqual([1, 1, 1, 1])
  expect(confirmed.candidates.every(item => item.eligibility === 'valid')).toBe(true)
  await show()
  await expect(region.getByText(/已确认参数 v2/)).toBeVisible()
  await expect(region.getByLabel('病变长度 数值', { exact: true })).toHaveValue('12')
  await region.getByLabel('病变长度 单位', { exact: true }).fill('cm')
  await region.getByRole('button', { name: '确认 PCI 参数', exact: true }).click()
  await expect(region.getByText(/已确认参数 v3/)).toBeVisible()
  await expect(region.getByText('候选状态：超出仿真适用范围', { exact: true })).toHaveCount(4)
  const changed = inpatientPciSelectionSchema.parse(await (await s.api.get(`${s.path}/pci-selection`)).json())
  expect(changed.history.map(item => item.version)).toEqual([3, 2, 1])
}
