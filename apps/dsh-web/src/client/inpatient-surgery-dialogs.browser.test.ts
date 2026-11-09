import { test, expect, loginPciBrowser } from '../../../web/e2e/inpatient-pci.fixture.ts'
import { selectInpatientStage } from '../../../web/e2e/inpatient-ui.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`Surgery dialogs React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientPciFixture(version) })
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
    const correctionTrigger = page.getByRole('button', { name: '更正耗材', exact: true })
    await correctionTrigger.click()
    const correction = page.getByRole('dialog', { name: '术后耗材更正与历史', exact: true })
    expect(await correction.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    await correction.getByRole('button', { name: /^更正 / }).first().click()
    await correction.getByLabel('更正依据', { exact: true }).fill('保留合成更正草稿')
    await expect(correction.getByRole('button', { name: '确认更正', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(correction).toBeHidden()
    await expect(correctionTrigger).toBeFocused()
    await correctionTrigger.click()
    await expect(correction.getByLabel('更正依据', { exact: true })).toHaveValue('保留合成更正草稿')
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })
})
