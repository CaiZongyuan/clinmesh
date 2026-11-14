import { pciAgentParameters } from '../../../server/tests/fixtures/inpatient-drg-agent.ts'
import { test, expect, loginPciBrowser } from '../../../web/e2e/inpatient-pci.fixture.ts'
import { selectInpatientStage } from '../../../web/e2e/inpatient-ui.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`Surgery dialogs React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientPciFixture(version) })
  test('ShadowRoot开始手术模态弹窗保留焦点、说明选项与发送期间关闭保护', async ({ page, pciApp: app }) => {
    test.setTimeout(60_000)
    const stay = await app.fixture.preparePciAdmission()
    expect((await app.fixture.request('inpatient-doctor', `${stay.path}/pci-selection/confirm`, { expectedVersion: 0, parameters: { ...pciAgentParameters, requestId: stay.requestId } })).status).toBe(200)
    await app.fixture.pciExecutionInput(stay)
    await page.route(`${app.origin}/start-dialog-contract`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><style>${artifact.styles}</style></head><body style="margin:0"><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>` }))
    await loginPciBrowser(page, app, 'inpatient-doctor')
    await page.goto(`${app.origin}/start-dialog-contract`)
    await page.getByRole('button', { name: /合成冠脉病例甲/ }).click()
    await selectInpatientStage(page, '手术')
    const trigger = page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '开始手术', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '开始手术', exact: true })
    expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    for (const width of [1600, 1280]) for (const theme of ['light', 'dark']) {
      const height = width === 1600 ? 1000 : 800
      await page.setViewportSize({ width, height })
      await page.locator('.clinmesh-web-root').evaluate((element, theme) => { element.classList.toggle('dark', theme === 'dark'); element.dataset.theme = theme }, theme)
      await expect(dialog.getByRole('button', { name: '开始手术', exact: true })).toBeInViewport()
      expect(await dialog.evaluate(element => { const box = element.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth })).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await dialog.getByRole('button', { name: '术前准备已完成，按计划开始手术', exact: true }).click()
    await expect(dialog.getByLabel('开始说明', { exact: true })).toHaveValue('术前准备已完成，按计划开始手术')
    let release!: () => void, posts = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    await page.route(`**${stay.path}/surgeries/start`, async route => { posts += 1; await gate; await route.continue() })
    try {
      await dialog.getByRole('button', { name: '开始手术', exact: true }).click()
      await expect.poll(() => posts).toBe(1)
      await page.keyboard.press('Escape')
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
    } finally { release() }
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('region', { name: '本台耗材', exact: true })).toBeVisible()
    expect(posts).toBe(1)
  })
  test('ShadowRoot 申请理由助手草稿可编辑并保留人工修改', async ({ page, pciApp: app }) => {
    test.setTimeout(60_000)
    const stay = await app.fixture.preparePciAdmission([])
    await page.route(`${app.origin}/request-reason-contract`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>` }))
    await page.route(`**${stay.path}/surgeries/request-reason`, route => route.fulfill({ json: {
      admissionId: stay.admissionId, taskId: 'synthetic-request-reason', fingerprint: 'a'.repeat(64), status: 'succeeded',
      reason: '已核对主诊断和最近正式冠脉造影报告，拟进一步介入治疗。', failureCode: null,
    } }))
    await loginPciBrowser(page, app, 'inpatient-doctor')
    await page.goto(`${app.origin}/request-reason-contract`)
    await page.getByRole('button', { name: /合成冠脉病例甲/ }).click()
    await selectInpatientStage(page, '手术')
    const trigger = page.getByRole('button', { name: '申请手术', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '申请手术', exact: true })
    expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    const reason = dialog.getByLabel('手术申请理由', { exact: true })
    await expect(reason).toHaveValue('已核对主诊断和最近正式冠脉造影报告，拟进一步介入治疗。')
    await expect(dialog.getByText('助手', { exact: true })).toBeVisible()
    await reason.fill('医生修改后的申请理由')
    await expect(dialog.getByText('助手', { exact: true })).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
    await trigger.click()
    await expect(dialog.getByLabel('手术申请理由', { exact: true })).toHaveValue('医生修改后的申请理由')
  })
  test('ShadowRoot 申请、预留与术后更正保留键盘、草稿和提交保护', async ({ page, pciApp: app }) => {
    test.setTimeout(90_000)
    const stay = await app.fixture.preparePciAdmission()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(`${app.origin}/surgery-dialog-contract`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>` }))
    const open = async () => {
      await loginPciBrowser(page, app, 'inpatient-doctor')
      await page.goto(`${app.origin}/surgery-dialog-contract`)
      await page.getByRole('button', { name: /合成冠脉病例甲/ }).click()
      await selectInpatientStage(page, '手术')
    }
    await open()
    const maintenance = page.getByRole('button', { name: '手工预留维护', exact: true })
    await maintenance.click()
    const reservation = page.getByRole('dialog', { name: '手工预留维护', exact: true })
    await expect(reservation).toBeVisible()
    expect(await reservation.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    await reservation.getByLabel('新增预留共同理由', { exact: true }).fill('合成预留草稿')
    await page.keyboard.press('Escape')
    await expect(reservation).toBeHidden()
    await expect(maintenance).toBeFocused()
    await maintenance.click()
    await expect(reservation.getByLabel('新增预留共同理由', { exact: true })).toHaveValue('合成预留草稿')
    await page.keyboard.press('Escape')

    const trigger = page.getByRole('button', { name: '申请手术', exact: true })
    await trigger.click()
    const request = page.getByRole('dialog', { name: '申请手术', exact: true })
    await request.getByLabel('计划术式', { exact: true }).click()
    await page.getByRole('option', { name: /51.2300/ }).click()
    await request.getByLabel('计划手术时间（上海时间）', { exact: true }).fill('2026-11-09T14:00')
    await request.getByLabel('手术申请理由', { exact: true }).fill('保留合成申请草稿')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let posts = 0
    await page.route(`**${stay.path}/surgeries/request`, async route => {
      posts += 1
      await gate
      await route.fulfill({ status: 409, json: { error: { code: 'VERSION_CONFLICT', message: '合成申请版本冲突' } } })
    })
    try {
      await request.getByRole('button', { name: '提交手术申请', exact: true }).click()
      await expect.poll(() => posts).toBe(1)
      await page.keyboard.press('Escape')
      await expect(request).toBeVisible()
      await expect(request.getByRole('button', { name: '提交手术申请', exact: true })).toBeDisabled()
    } finally { release() }
    await expect(request.getByRole('alert')).toBeVisible()
    await expect(request.getByLabel('手术申请理由', { exact: true })).toHaveValue('保留合成申请草稿')
    await page.keyboard.press('Escape')
    await expect(request).toBeHidden()
    await expect(trigger).toBeFocused()
    expect(posts).toBe(1)

    await app.fixture.executePci(stay)
    await open()
    await expect(page.getByRole('region', { name: '最终耗材', exact: true })).toBeVisible()
    const correctionTrigger = page.getByRole('button', { name: '补登记与更正耗材', exact: true })
    await correctionTrigger.click()
    const correction = page.getByRole('dialog', { name: '术后耗材补登记、更正与历史', exact: true })
    expect(await correction.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    await correction.getByRole('button', { name: /^更正 / }).first().click()
    await correction.getByLabel('共同更正依据', { exact: true }).fill('保留合成更正草稿')
    await expect(correction.getByRole('button', { name: '集中核对更正', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(correction).toBeHidden()
    await expect(correctionTrigger).toBeFocused()
    await correctionTrigger.click()
    await expect(correction.getByLabel('共同更正依据', { exact: true })).toHaveValue('保留合成更正草稿')
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })
})
