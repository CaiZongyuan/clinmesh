import type { Page, TestInfo } from '@playwright/test'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientMaterialReservationListSchema, inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientSurgerySchema, inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { pciAgentParameters } from '../../server/tests/fixtures/inpatient-drg-agent.ts'
import { expect, loginPciBrowser, type PciBrowserApp } from './inpatient-pci.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'
import { openQueue } from './queue-overlay.fixture.ts'

/** 独立合成备用预留使预计接近参考；采用、换回、确认与术中选择均从真实工作台办理。 */
export async function runEquivalentMaterialJourney(page: Page, app: PciBrowserApp, info: TestInfo, mount: () => Promise<void>) {
  const s = app.fixture, stay = await s.preparePciAdmission([])
  expect((await s.request('inpatient-doctor', `${stay.path}/pci-selection/confirm`, { expectedVersion: 0, parameters: { ...pciAgentParameters, requestId: stay.requestId } })).status).toBe(200)
  await s.runtime.dispatchPending()
  const admission = (await s.read('inpatient-doctor', stay.path, inpatientDetailSchema)).admission
  expect((await s.request('inpatient-doctor', `${stay.path}/drg/reservations`, { encounterVersion: admission.versionId,
    materialId: 'hospital-material-balloon', catalogVersion: 1, quantity: 20, reason: '独立合成备用方案' })).status).toBe(200)
  await loginPciBrowser(page, app, 'inpatient-doctor')
  await mount()
  await openQueue(page)
  await page.getByRole('button', { name: `查看${admission.patientName}`, exact: true }).click()
  await selectInpatientStage(page, '手术')
  const header = page.getByRole('button', { name: 'DRG 费用进度，点击查看 DRG 预分组', exact: true })
  const materials = page.getByRole('region', { name: '手术耗材', exact: true })
  await expect(materials.getByRole('button', { name: '换成这个', exact: true })).toBeVisible()
  await expect(materials).toContainText('单价少 ¥200.00；换后预计 ¥10,865.98')
  await expect(header).toContainText('做完预计 ¥11,065.98')
  for (const width of [1101, 826]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.locator('.clinmesh-card-workspace').evaluate((element, value) => { (element as HTMLElement).style.width = `${value}px` }, width)
    await page.locator('.clinmesh-web-root').evaluate((element, value) => { element.classList.toggle('dark', value === 'dark'); element.setAttribute('data-theme', value); element.setAttribute('data-font-size', 'standard') }, theme)
    await expect.poll(() => materials.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    if (width === 826 && theme === 'dark') await materials.screenshot({ path: info.outputPath('equivalent-advice-1280-dark.png'), animations: 'disabled' })
  }
  await materials.getByRole('button', { name: '换成这个', exact: true }).click()
  await expect(materials.getByRole('button', { name: '换回原耗材', exact: true })).toBeVisible()
  await expect(header).toContainText('做完预计 ¥10,865.98')
  await materials.getByRole('button', { name: '换回原耗材', exact: true }).click()
  await expect(header).toContainText('做完预计 ¥11,065.98')
  await materials.getByRole('button', { name: '换成这个', exact: true }).click()
  await expect(header).toContainText('做完预计 ¥10,865.98')
  const draft = (await s.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates[0]!.draft!
  expect(draft.items).toHaveLength(4)
  expect(draft.items.map(item => item.quantity)).toEqual([1, 1, 1, 1])
  expect(draft.items.some(item => item.materialId === 'hospital-material-pci-stent-equivalent-b')).toBe(true)
  await page.getByRole('button', { name: '确认手术耗材', exact: true }).click()
  await expect(materials).toContainText('已为本计划预留')
  const reserved = await s.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
  const own = reserved.reservations.filter(item => item.requestId === stay.requestId && item.status === 'reserved')
  expect(own).toHaveLength(4)
  expect(own.some(item => item.materialId === 'hospital-material-pci-stent-equivalent-b' && item.quantity === 1 && item.priceFen === 53000)).toBe(true)
  const selection = await s.read('inpatient-doctor', `${stay.path}/pci-selection`, inpatientPciSelectionSchema)
  expect(selection.confirmation!.parameters.approvedMaterialIds).toContain('hospital-material-pci-stent-equivalent-b')
  let request = (await s.read('ward-nurse', `${stay.path}/surgeries`, inpatientSurgerySchema)).requests.find(item => item.id === stay.requestId)!
  expect((await s.request('ward-nurse', `${stay.path}/surgeries/check-preop`, { requestId: stay.requestId, expectedRequestVersion: request.version, note: '合成术前准备已核对' })).status).toBe(200)
  request = (await s.read('inpatient-doctor', `${stay.path}/surgeries`, inpatientSurgerySchema)).requests.find(item => item.id === stay.requestId)!
  expect((await s.request('inpatient-doctor', `${stay.path}/surgeries/confirm-consent`, { requestId: stay.requestId, expectedRequestVersion: request.version, note: '合成签署已确认' })).status).toBe(200)
  request = (await s.read('inpatient-doctor', `${stay.path}/surgeries`, inpatientSurgerySchema)).requests.find(item => item.id === stay.requestId)!
  const started = inpatientSurgeryResponseSchema.parse(await (await s.request('inpatient-doctor', `${stay.path}/surgeries/start`, { requestId: stay.requestId, expectedRequestVersion: request.version, procedureId: stay.procedure.id, catalogVersion: 1, note: '合成开始手术' })).json()).data
  const running = page.getByRole('region', { name: '本台耗材', exact: true })
  await running.getByRole('button', { name: '登记计划外的其他耗材', exact: true }).click()
  const other = running.getByRole('region', { name: '登记计划外的其他耗材', exact: true })
  const original = stay.catalog.materials.find(item => item.id === 'hospital-material-pci-stent')!
  await other.getByLabel('耗材', { exact: true }).click()
  await page.getByRole('option', { name: original.display, exact: true }).click()
  await other.getByLabel('依据', { exact: true }).fill('合成医生核实的额外使用依据')
  await other.getByRole('button', { name: '换成这个', exact: true }).click()
  await expect(other.getByLabel('耗材', { exact: true })).toContainText('合成等效 B')
  await expect(other.getByLabel('数量', { exact: true })).toHaveValue('1')
  await expect(other.getByLabel('依据', { exact: true })).toHaveValue('合成医生核实的额外使用依据')
  await other.getByRole('button', { name: '换回原耗材', exact: true }).click()
  await expect(other.getByLabel('耗材', { exact: true })).toContainText(original.display)
  await other.getByRole('button', { name: '换成这个', exact: true }).click()
  await other.getByRole('button', { name: '登记这笔', exact: true }).click()
  await expect.poll(async () => (await s.read('inpatient-doctor', `${stay.path}/surgeries`, inpatientSurgerySchema)).inProgress.find(item => item.id === started.inProgress[0]!.id)?.materials[0]?.item.id).toBe('hospital-material-pci-stent-equivalent-b')
  const simulation = inpatientDrgSimulationSchema.parse(await (await s.request('inpatient-doctor', `${stay.path}/drg/simulation`, {})).json())
  expect(simulation.formal.chargesFen).toBe(53000)
  await expect(header).toContainText('已用 ¥530.00')
  await page.goto('about:blank')
}
