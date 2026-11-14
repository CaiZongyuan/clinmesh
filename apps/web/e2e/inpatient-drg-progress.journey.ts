import type { Page, TestInfo } from '@playwright/test'
import { inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientSurgeryResponseSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { createDrgBrowserPatient, expect } from './inpatient-drg.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'
import { openQueue } from './queue-overlay.fixture.ts'

const money = (fen: number) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(fen / 100)

/** 真实患者入口 + 公开 HTTP 回读；截图只包含无影像的患者头部。 */
export async function runDrgProgressJourney(page: Page, app: { origin: string; password: string }, info: TestInfo, mount: () => Promise<void>) {
  const s = await createDrgBrowserPatient(page, app, '合成全程DRG进度患者')
  await mount()
  await openQueue(page)
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  const header = page.getByRole('button', { name: 'DRG 费用进度，点击查看 DRG 预分组', exact: true })
  await expect(header).toContainText('当前病组 RA15')
  await expect(header).toContainText('支付参考 ¥3,000.00')
  for (const name of ['诊断医嘱', '检查检验', '手术', 'DRG 预分组', '出院', '病案']) {
    await selectInpatientStage(page, name)
    await expect(header).toBeVisible()
  }
  await header.click()
  await expect(page.getByRole('tab', { name: 'DRG 预分组', exact: true })).toHaveAttribute('aria-selected', 'true')
  const workspace = page.locator('.clinmesh-card-workspace')
  for (const host of [1600, 1280]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: host, height: host === 1600 ? 1000 : 800 })
    const surface = host === 1600 ? 1101 : 826
    await workspace.evaluate((element, width) => { (element as HTMLElement).style.width = `${width}px` }, surface)
    await page.locator('.clinmesh-web-root').evaluate((element, value) => {
      element.classList.toggle('dark', value === 'dark'); element.setAttribute('data-theme', value); element.setAttribute('data-font-size', 'standard')
    }, theme)
    await expect.poll(() => header.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const bounds = await header.evaluate(element => {
      const box = element.getBoundingClientRect(), texts: string[] = []
      for (const child of element.querySelectorAll('b, .clinmesh-inpatient-drg-progress-group > span:last-child')) {
        const range = document.createRange(); range.selectNodeContents(child)
        for (const rect of range.getClientRects()) if (rect.left < box.left - 1 || rect.right > box.right + 1) texts.push(child.textContent ?? '')
      }
      return texts
    })
    expect(bounds).toEqual([])
    await header.screenshot({ path: info.outputPath(`drg-progress-${host}-${theme}.png`), animations: 'disabled' })
  }
  // 本计划的进行中事实继续参与预计分组；登记后费用在一次刷新周期内更新。
  const before = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  const requested = inpatientSurgeryResponseSchema.parse(await (await s.api.post(`${s.path}/surgeries/request`, {
    encounterVersion: before.encounterVersion, procedureId: 'hospital-surgery-1', catalogVersion: 1, plannedFor: '2026-08-24T15:00:00+08:00', reason: '合成全程费用进度验证',
  })).json()).data.requests[0]!
  await s.api.login('ward-nurse')
  expect((await s.api.post(`${s.path}/surgeries/check-preop`, { requestId: requested.id, expectedRequestVersion: requested.version, note: '合成术前已核对' })).status()).toBe(200)
  await s.api.login('inpatient-doctor')
  let current = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json()).requests[0]!
  expect((await s.api.post(`${s.path}/surgeries/confirm-consent`, { requestId: current.id, expectedRequestVersion: current.version, note: '合成签署已确认' })).status()).toBe(200)
  current = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json()).requests[0]!
  const running = inpatientSurgeryResponseSchema.parse(await (await s.api.post(`${s.path}/surgeries/start`, {
    requestId: current.id, expectedRequestVersion: current.version, procedureId: 'hospital-surgery-1', catalogVersion: 1, note: '合成开始手术',
  })).json()).data
  await expect(header).toContainText('按计划手术预计 RA25')
  await expect(header).toContainText('暂无支付参考')
  const record = await s.api.post(`${s.path}/surgeries/record-material`, {
    requestId: current.id, expectedRequestVersion: running.requests[0]!.version, executionId: running.inProgress[0]!.id,
    material: { materialId: 'hospital-material-balloon', catalogVersion: 1, quantity: 1 }, note: '合成实际使用一只球囊',
  })
  expect(record.status()).toBe(200)
  const simulation = inpatientDrgSimulationSchema.parse(await (await s.api.post(`${s.path}/drg/simulation`, {})).json())
  await expect(header).toContainText(`已用 ${money(simulation.formal.chargesFen)}`)
  await expect(page.getByRole('region', { name: '费用与支付参考', exact: true })).toContainText(money(simulation.formal.chargesFen))
  await s.api.login('ward-nurse')
  await mount()
  await openQueue(page)
  await page.getByRole('button', { name: `1床 ${s.name}`, exact: true }).click()
  await expect(header).toHaveCount(0)
  await page.goto('about:blank')
}
