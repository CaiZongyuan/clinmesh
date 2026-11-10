import { expect, test as base } from '../../../web/e2e/fixtures.ts'
import { createInvestigationSendBatchApp, openInvestigationSendBatchPatient, prepareInvestigationSendBatchPatient, runInvestigationSendBatchJourney } from '../../../web/e2e/inpatient-investigation-send-batch.journey.ts'
import { buildInpatientDrgFixture } from './inpatient-drg.browser.artifact.ts'
import { inpatientInvestigationResponseSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { advanceVirtualTimeResponseSchema } from '@clinmesh/contracts/inpatient'
import { sessionContextSchema } from '@clinmesh/contracts/his'
import { z } from 'zod'

const test = base.extend({ browserApp: async ({ webRoot }, use) => {
  const app = await createInvestigationSendBatchApp(webRoot, { longNames: true })
  try { await use(app) } finally { await app.close() }
} })

for (const version of ['18', '19']) test.describe(`React ${version} Surface 同患者集中送检`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientDrgFixture>>
  test.beforeAll(async () => { test.setTimeout(60_000); artifact = await buildInpatientDrgFixture(version) })
  test('长中文标本核对在窄屏明暗、缩放和键盘下可达，原回执恢复不连发余项', async ({ page, browserApp }, testInfo) => {
    test.setTimeout(90_000)
    const errors: string[] = [], pixelRequests: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(/\/(?:pixels|tiles|dicom)(?:\/|\?)/, async route => { pixelRequests.push(new URL(route.request().url()).pathname); await route.abort() })
    const s = await prepareInvestigationSendBatchPatient(page, browserApp)
    const url = `${browserApp.origin}/investigation-send-batch-contract`
    await page.route(url, route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html data-view="workspace"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>` }))
    await page.setViewportSize({ width: 390, height: 844 })
    let reviewed = false
    const evidence = await runInvestigationSendBatchJourney(page, s, async () => { await page.goto(url) }, async caption => {
      if (caption.startsWith('病区护士选择')) {
        await page.screenshot({ path: testInfo.outputPath('send-drafts-390.png'), animations: 'disabled' })
      }
      const dialog = page.getByRole('dialog', { name: '集中送检核对', exact: true })
      if (await dialog.isVisible() && !reviewed) {
        reviewed = true
        expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
        const root = page.locator('.clinmesh-web-root')
        await expect(root).toHaveAttribute('data-font-size', 'large')
        const bounds = await dialog.boundingBox()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
        expect(bounds!.y).toBeGreaterThanOrEqual(0)
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844)
        const confirm = dialog.getByRole('button', { name: '确认送检', exact: true })
        await confirm.click({ trial: true })
        const body = dialog.locator('.overflow-y-auto')
        expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
        const before = await dialog.getByRole('heading', { name: '集中送检核对', exact: true }).boundingBox()
        await body.evaluate(element => { element.scrollTop = element.scrollHeight })
        await expect(dialog.getByRole('article').last()).toBeInViewport()
        expect((await dialog.getByRole('heading', { name: '集中送检核对', exact: true }).boundingBox())!.y).toBe(before!.y)
        await expect(confirm).toBeInViewport()
        for (const width of [390, 1101, 826]) for (const theme of ['light', 'dark']) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
          await root.evaluate((element, value) => { element.classList.toggle('dark', value === 'dark'); element.setAttribute('data-theme', value) }, theme)
          await confirm.click({ trial: true })
          await body.evaluate(element => { element.scrollTop = element.scrollHeight })
          await expect(dialog.getByRole('article').last()).toBeInViewport()
          await expect(confirm).toBeInViewport()
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await page.screenshot({ path: testInfo.outputPath(`send-review-${width}-${theme}.png`), animations: 'disabled' })
        }
        await page.setViewportSize({ width: 390, height: 844 })
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        const trigger = page.getByRole('button', { name: '集中送检', exact: true })
        await expect(trigger).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(dialog).toBeVisible()
        await page.setViewportSize({ width: 480, height: 900 })
        await page.evaluate(() => { document.documentElement.style.zoom = '1.25' })
        await confirm.click({ trial: true })
        await expect(confirm).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: testInfo.outputPath('send-review-125-dark.png'), animations: 'disabled' })
        await page.evaluate(() => { document.documentElement.style.zoom = '' })
        await page.setViewportSize({ width: 390, height: 844 })
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
    expect(reviewed).toBe(true)
    expect(evidence).toMatchObject({ posts: 3, sent: 3, reports: 0, charges: 0 })
    expect(errors).toEqual([])
    expect(pixelRequests).toEqual([])
  })
  if (version === '19') test('取消历史占页仍只全选本页可办申请，跨页搜索保留完整草稿且丢弃和登出分别清理', async ({ page, browserApp }, testInfo) => {
    test.setTimeout(90_000)
    const s = await prepareInvestigationSendBatchPatient(page, browserApp)
    const cancel = async (request: typeof s.requests[number]) => {
      const response = await s.api.post(`${s.path}/investigations/cancel`, { requestId: request.id,
        expectedRequestVersion: request.version, serviceRequestVersion: request.serviceRequestVersion, taskVersion: request.taskVersion })
      expect(response.status()).toBe(200)
      inpatientInvestigationResponseSchema.parse(await response.json())
    }
    await s.api.login('inpatient-doctor')
    for (const request of s.requests) await cancel(request)
    for (let index = 0; index < 6; index += 1) await cancel(await s.issue('合成白细胞计数'))
    // 公开时钟把9条取消历史、首条待办和后两条待办放在明确的相邻页边界。
    const advanceMinute = async () => {
      await s.api.login('admin')
      const clock = z.object({ virtualTime: z.iso.datetime({ offset: true }) }).parse(await (await s.api.get('/api/sim/v1/scenario-runs/current')).json())
      const session = sessionContextSchema.parse(await (await s.api.get('/api/auth/context')).json())
      const response = await s.api.post(`/api/sim/v1/scenario-runs/${session.actor.scenarioRunId}/actions/advance-time`, {
        expectedVirtualTime: clock.virtualTime, targetVirtualTime: new Date(Date.parse(clock.virtualTime) + 60_000).toISOString(),
      })
      expect(response.status()).toBe(200)
      advanceVirtualTimeResponseSchema.parse(await response.json())
      await s.api.login('inpatient-doctor')
    }
    await advanceMinute()
    await s.issue('合成白细胞计数')
    await advanceMinute()
    await s.issue('合成血红蛋白')
    await s.issue('合成血常规')
    await s.api.login('ward-nurse')
    const before = inpatientInvestigationsSchema.parse(await (await s.api.get(`${s.path}/investigations`)).json())
    expect(before.laboratoryRequests.filter(request => request.status === 'cancelled')).toHaveLength(9)
    expect(before.laboratoryRequests.filter(request => request.status === 'issued')).toHaveLength(3)
    expect(before.sent).toEqual([])
    const url = `${browserApp.origin}/investigation-send-pagination-contract`
    await page.route(url, route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html data-view="workspace"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>` }))
    await page.setViewportSize({ width: 826, height: 1000 })
    const open = async () => { await page.goto(url) }
    await openInvestigationSendBatchPatient(page, s, open)
    const panel = page.getByRole('region', { name: '集中送检', exact: true })
    const choices = panel.getByRole('checkbox', { name: /^选择送检：/ })
    const drafts = panel.getByRole('region', { name: '送检待处理清单', exact: true })
    await expect(choices).toHaveCount(10)
    await expect(panel.getByText('当前状态不可送检。', { exact: true })).toHaveCount(9)
    await panel.getByRole('button', { name: '全选本页可送检申请', exact: true }).click()
    await expect(drafts).toContainText(/已选\s*1\s*项/)
    await expect(drafts.getByRole('checkbox', { name: /^待送检选择：/ })).toHaveCount(1)
    await panel.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(choices).toHaveCount(2)
    for (const choice of await choices.all()) await expect(choice).not.toBeChecked()
    await expect(drafts).toContainText(/已选\s*1\s*项/)
    await panel.getByRole('button', { name: '全选本页可送检申请', exact: true }).click()
    await expect(drafts).toContainText(/已选\s*3\s*项/)
    await panel.getByRole('button', { name: '上一页', exact: true }).click()
    await expect(choices).toHaveCount(10)
    await panel.getByRole('textbox', { name: '搜索送检申请', exact: true }).fill('合成血红蛋白')
    await expect(choices).toHaveCount(2)
    await expect(drafts.getByRole('checkbox', { name: /^待送检选择：/ })).toHaveCount(3)
    await page.getByRole('button', { name: '集中送检', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '集中送检核对', exact: true })
    await expect(dialog.getByRole('article')).toHaveCount(3)
    await page.screenshot({ path: testInfo.outputPath('send-cross-page-search-review-826.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await panel.getByRole('button', { name: '清空选择', exact: true }).click()
    await expect(drafts).toContainText(/已选\s*0\s*项/)
    await expect(drafts.getByRole('checkbox', { name: /^待送检选择：/ })).toHaveCount(3)
    await panel.getByRole('button', { name: '丢弃送检清单', exact: true }).click()
    const discard = page.getByRole('dialog', { name: '丢弃送检清单', exact: true })
    await discard.getByRole('button', { name: '保留清单', exact: true }).click()
    await expect(drafts).toBeVisible()
    await panel.getByRole('button', { name: '丢弃送检清单', exact: true }).click()
    await discard.getByRole('button', { name: '确认丢弃', exact: true }).click()
    await expect(drafts).toHaveCount(0)
    await panel.getByRole('button', { name: '全选本页可送检申请', exact: true }).click()
    await expect(drafts).toContainText(/已选\s*1\s*项/)
    await page.goto(`${browserApp.origin}/inpatient`)
    await page.getByRole('button', { name: '用户菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
    await page.getByLabel('账户邮箱').fill('ward-nurse@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(browserApp.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('button', { name: '用户菜单', exact: true })).toBeVisible()
    await openInvestigationSendBatchPatient(page, s, open)
    await expect(drafts).toHaveCount(0)
    for (const choice of await choices.all()) await expect(choice).not.toBeChecked()
    const after = inpatientInvestigationsSchema.parse(await (await s.api.get(`${s.path}/investigations`)).json())
    expect(after).toEqual(before)
  })
})
