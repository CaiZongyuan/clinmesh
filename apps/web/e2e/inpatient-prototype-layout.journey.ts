import type { Page, TestInfo } from '@playwright/test'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { createDrgBrowserPatient, archiveDrgBrowserPatient, expect } from './inpatient-drg.fixture.ts'

/** 相同的真实病例、岗位操作和几何断言由 Web 与 React18/19 Surface 各自的生产入口驱动。 */
export async function runInpatientPrototypeMatrix(page: Page, browserApp: { origin: string; password: string }, info: TestInfo, options: {
  prefix: string; mount(role: string): Promise<void>; appearance(theme: string): Promise<void>
}) {
  const archived = await createDrgBrowserPatient(page, browserApp, '合成原型病案')
  await archiveDrgBrowserPatient(archived)
  const active = await createDrgBrowserPatient(page, browserApp, '合成原型在院', 'bed-general-2')
  const next = await createDrgBrowserPatient(page, browserApp, '合成原型在院乙', 'bed-general-3')
  for (const state of [active, next]) {
    await state.api.login('inpatient-doctor')
    const clinical = inpatientFullClinicalSchema.parse(await (await state.api.get(`${state.path}/clinical`)).json())
    expect((await state.api.post(`${state.path}/orders/issue`, { encounterVersion: clinical.encounterVersion, duration: 'temporary',
      selection: { kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1, doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' },
    })).status()).toBe(200)
    await state.api.login('ward-nurse')
    const order = inpatientFullClinicalSchema.parse(await (await state.api.get(`${state.path}/clinical`)).json()).orders[0]!
    expect((await state.api.post(`${state.path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })).status()).toBe(200)
  }
  const roles = ['registrar', 'ward-nurse', 'inpatient-doctor', 'cashier', 'pharmacist', 'medical-records', 'medical-insurance']
  await page.setViewportSize({ width: 1600, height: 1000 })
  for (const role of roles) {
    await active.api.login(role)
    await options.mount(role)
    if (role === 'ward-nurse') await page.getByRole('button', { name: '2床 合成原型在院', exact: true }).click()
    else if (role === 'inpatient-doctor') await page.getByRole('button', { name: '查看合成原型在院', exact: true }).click()
    else if (role === 'pharmacist') await page.getByRole('button', { name: /^查看合成原型在院/ }).first().click()
    else if (role === 'cashier' || role === 'medical-records') await page.getByRole('button', { name: '查看合成原型病案', exact: true }).click()
    if (role === 'medical-insurance') await expect(page.getByRole('heading', { name: '归档时的分组与费用', exact: true })).toBeVisible()
    const workspace = page.locator('.clinmesh-card-workspace')
    for (const width of [1101, 826]) for (const theme of ['light', 'dark']) {
      await workspace.evaluate((element, width) => { (element as HTMLElement).style.width = `${width}px` }, width)
      await options.appearance(theme)
      await expect.poll(() => workspace.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      const buttons = workspace.locator('button:visible')
      expect(await buttons.evaluateAll(elements => elements.filter(element => element.scrollWidth - element.clientWidth > 1).map(element => element.textContent))).toEqual([])
      const path = info.outputPath(`${options.prefix}-${role}-${width}-${theme}.png`)
      await workspace.screenshot({ path, animations: 'disabled' })
      await info.attach(`${role}-${width}-${theme}`, { path, contentType: 'image/png' })
    }
    if (role === 'pharmacist') {
      for (const remaining of [1, 0]) {
        await page.getByRole('button', { name: '全选本页可发药执行单', exact: true }).click()
        await page.getByRole('button', { name: '集中发药', exact: true }).click()
        await page.getByRole('dialog', { name: '集中发药核对', exact: true }).getByRole('button', { name: '确认发药', exact: true }).click()
        const rows = page.getByRole('button', { name: /^查看合成原型在院/ })
        await expect(rows).toHaveCount(remaining)
        if (remaining) await rows.first().click()
        else await expect(page.getByRole('region', { name: '发药逐项结果', exact: true })).toContainText('成功 1/1')
      }
    }
  }
}
