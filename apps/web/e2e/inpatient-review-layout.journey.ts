import type { Page, TestInfo } from '@playwright/test'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { createDrgBrowserPatient, expect } from './inpatient-drg.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

/** 只观察文字界面；检查检验只读 DOM，不打开影像或采集该页截图。 */
export async function runInpatientReviewLayout(page: Page, app: { origin: string; password: string }, info: TestInfo, options: {
  mount(role: string): Promise<void>; appearance(theme: 'light' | 'dark'): Promise<void>; capture?: boolean
}) {
  const subject = await createDrgBrowserPatient(page, app, '合成住院布局复核')
  const clinical = async () => inpatientFullClinicalSchema.parse(await (await subject.api.get(`${subject.path}/clinical`)).json())
  const catalog = inpatientSurgeryCatalogSchema.parse(await (await subject.api.get('/api/his/v1/inpatient/surgery-catalog')).json())
  const procedure = catalog.procedures.find(item => item.coding.code === '00.6600')!
  expect((await subject.api.post(`${subject.path}/surgeries/request`, { encounterVersion: (await clinical()).encounterVersion,
    procedureId: procedure.id, catalogVersion: procedure.version, plannedFor: '2026-08-24T15:00:00+08:00', reason: '合成布局复核手术' })).status()).toBe(200)
  const request = inpatientSurgerySchema.parse(await (await subject.api.get(`${subject.path}/surgeries`)).json()).requests[0]!
  expect((await subject.api.post(`${subject.path}/orders/issue`, { encounterVersion: (await clinical()).encounterVersion, duration: 'temporary',
    selection: { kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1, doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' } })).status()).toBe(200)
  await subject.api.login('ward-nurse')
  const order = (await clinical()).orders[0]!
  expect((await subject.api.post(`${subject.path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })).status()).toBe(200)
  await subject.api.login('inpatient-doctor')
  await page.setViewportSize({ width: 1600, height: 1000 })
  await options.mount('inpatient-doctor')
  await page.getByRole('button', { name: `查看${subject.name}`, exact: true }).click()
  const workspace = page.locator('.clinmesh-card-workspace')
  await selectInpatientStage(page, '手术')
  await page.getByRole('button', { name: '确认已签', exact: true }).click()
  const consent = page.getByRole('button', { name: '确认手术知情同意书已签', exact: true })
  await expect(consent).toBeDisabled()
  await expect(consent).toHaveCSS('border-style', 'dashed')
  await page.getByLabel('签署说明', { exact: true }).fill('合成已核对知情同意书')
  await expect(consent).toBeEnabled()
  await expect(consent).toHaveCSS('border-style', 'solid')
  const consentPath = `${app.origin}${subject.path}/surgeries/confirm-consent`
  let releaseConsent!: () => void
  const pendingConsent = new Promise<void>(resolve => { releaseConsent = resolve })
  let reachedConsent = false
  // 此拦截随独立 context 销毁；响应后有并发 refetch，不在 response 事件后立即 unroute。
  await page.route(consentPath, async route => { reachedConsent = true; await pendingConsent; await route.continue() })
  await consent.click()
  let consentStatus: number | undefined
  try {
    // 提交时主区为 inert；只观察可见文字与样式，不对不可交互控件执行操作。
    const submitting = page.locator('button').filter({ hasText: /^正在确认知情同意书$/ })
    await expect(submitting).toBeVisible()
    await expect.poll(() => reachedConsent).toBe(true)
    await expect(submitting).toHaveAttribute('aria-busy', 'true')
    await expect(submitting).toHaveCSS('border-style', 'solid')
  } finally {
    const response = page.waitForResponse(value => value.url() === consentPath && value.request().method() === 'POST')
    releaseConsent()
    consentStatus = (await response).status()
  }
  expect(consentStatus).toBe(200)
  const confirmed = inpatientSurgerySchema.parse(await (await subject.api.get(`${subject.path}/surgeries`)).json()).requests.find(item => item.id === request.id)
  expect(confirmed?.consentConfirmation?.note).toBe('合成已核对知情同意书')
  const queue = workspace.locator('.clinmesh-card-queue')
  const refresh = queue.getByRole('button', { name: '刷新', exact: true })
  await expect(refresh.locator('svg')).toHaveCount(1)
  await expect(refresh).toHaveText('')
  const preparation = page.getByRole('region', { name: '开始手术还差', exact: true })
  await expect(preparation.getByText('术前核对', { exact: true })).toBeVisible()
  await expect(preparation.getByText('病区护士', { exact: true })).toBeVisible()
  await expect(preparation.getByText('手术知情同意书已签', { exact: true })).toBeVisible()
  await expect(preparation.getByText('已完成', { exact: true })).toBeVisible()
  await expect(preparation.locator('time')).toHaveCount(1)
  await expect(workspace.locator('.clinmesh-card-patient')).not.toContainText('等病区护士完成术前核对')
  await expect(workspace.locator('.clinmesh-card-main')).not.toHaveAttribute('data-busy')
  expect((await subject.api.post(`${subject.path}/drg/followup/start`, { encounterVersion: (await clinical()).encounterVersion, expectedTaskVersion: 0 })).status()).toBe(200)
  await refresh.click()
  const assistant = page.getByRole('region', { name: '助手已准备', exact: true })
  await expect(assistant.getByRole('button')).toHaveCount(1)
  for (const width of [1101, 826]) for (const theme of ['light', 'dark'] as const) {
    await workspace.evaluate((element, width) => { element.style.width = `${width}px` }, width)
    await options.appearance(theme)
    await expect.poll(() => workspace.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await expect.poll(() => workspace.locator('.clinmesh-card-patient').evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(width === 1101 ? 190 : 220)
    await expect.poll(() => assistant.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(width === 1101 ? 34 : 64)
    for (const chip of await assistant.getByRole('button').all()) {
      const lineHeight = await chip.evaluate(element => parseFloat(getComputedStyle(element).lineHeight))
      expect(await chip.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(lineHeight + 10)
    }
    if (options.capture && (width === 1101 && theme === 'light' || width === 826 && theme === 'dark')) {
      await workspace.screenshot({ path: info.outputPath(`doctor-surgery-${width}-${theme}.png`), animations: 'disabled' })
    }
  }
  const appearanceRoot = page.locator('.clinmesh-web-root')
  const standardScale = await appearanceRoot.evaluate(element => parseFloat(getComputedStyle(element).getPropertyValue('--clinmesh-font-scale')))
  const standardFont = await assistant.getByRole('button').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize))
  await appearanceRoot.evaluate(element => { element.setAttribute('data-font-size', 'large') })
  const largeScale = await appearanceRoot.evaluate(element => parseFloat(getComputedStyle(element).getPropertyValue('--clinmesh-font-scale')))
  expect(largeScale).toBeGreaterThan(standardScale)
  const largeFont = standardFont * largeScale / standardScale
  for (const chip of await assistant.getByRole('button').all()) {
    // 属性已生效时字号仍可能正在过渡；到达目标字号后再检查文字与布局。
    await expect.poll(() => chip.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(largeFont, 3)
    const type = await chip.evaluate(element => ({ font: parseFloat(getComputedStyle(element).fontSize), line: parseFloat(getComputedStyle(element).lineHeight) }))
    expect(type.font).toBeGreaterThan(standardFont)
    expect(type.line).toBeGreaterThanOrEqual(type.font * 1.2)
    expect(await chip.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  }
  await appearanceRoot.evaluate(element => { element.setAttribute('data-font-size', 'standard') })
  for (const chip of await assistant.getByRole('button').all()) {
    await expect.poll(() => chip.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(standardFont, 3)
  }
  await selectInpatientStage(page, '检查检验')
  const investigations = page.getByRole('tabpanel', { name: '检查检验', exact: true })
  await expect(investigations.getByText('暂无检查检验申请', { exact: true })).toBeVisible()
  await investigations.getByRole('button', { name: '开立住院检查', exact: true }).click()
  const composer = page.getByRole('dialog', { name: '开立住院检查', exact: true })
  await expect(composer.getByLabel('搜索检查检验目录', { exact: true })).toBeVisible()
  await composer.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(composer).toHaveCount(0)

  await subject.api.login('pharmacist')
  await options.mount('pharmacist')
  const pharmacy = page.getByRole('region', { name: '住院药房', exact: true })
  await expect(pharmacy.getByRole('button', { name: /^查看合成住院布局复核/ })).toHaveCount(1)
  await expect(pharmacy.getByText('药品计数仅限本页患者', { exact: true })).toBeHidden()
  await expect(pharmacy.getByText('待发页仅列在院患者，已发页可查全部历史。', { exact: true })).toHaveCount(0)
  await expect(pharmacy.getByRole('button', { name: '上一页', exact: true })).toHaveCount(0)
  await expect(pharmacy.getByRole('button', { name: '下一页', exact: true })).toHaveCount(0)
  await expect(pharmacy.getByText(/第 1 \/ 1 页/)).toHaveCount(0)
  await expect(pharmacy.getByRole('button', { name: '刷新', exact: true }).locator('svg')).toHaveCount(1)
}
