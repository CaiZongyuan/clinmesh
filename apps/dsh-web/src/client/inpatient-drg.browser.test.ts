import { runDrgFollowupJourney } from '../../../web/e2e/inpatient-drg-followup.journey.ts'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgPayerReviewListSchema } from '@clinmesh/contracts/inpatient-drg-payer'
import { inpatientFullCatalogSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { archiveDrgBrowserPatient, createDrgBrowserPatient, expect, test } from '../../../web/e2e/inpatient-drg.fixture.ts'
import { buildInpatientDrgFixture } from './inpatient-drg.browser.artifact.ts'
import { runDrgArchiveJourney } from '../../../web/e2e/inpatient-drg-archive.journey.ts'
import { expectStableDrgPolling } from '../../../web/e2e/inpatient-drg-polling.journey.ts'

for (const version of ['18', '19']) test.describe(`inpatient DRG React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientDrgFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientDrgFixture(version) })
  test('后台规则跟进脱离页面继续更新，返回后可停止', async ({ page, browserApp }) => {
    test.setTimeout(60_000)
    const s = await createDrgBrowserPatient(page, browserApp, '合成后台规则Surface患者')
    await page.route(`${browserApp.origin}/drg-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await runDrgFollowupJourney(page, s, async () => {
      await page.goto(`${browserApp.origin}/drg-contract`)
      await page.setContent(`<!doctype html><html data-admission-id="${s.admissionId}"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    })
  })
  test('DRG 多行提示在自动核对期间分组与费用结果保持原位', async ({ page, browserApp }) => {
    test.setTimeout(60_000)
    const s = await createDrgBrowserPatient(page, browserApp)
    await page.route(`${browserApp.origin}/drg-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await page.goto(`${browserApp.origin}/drg-contract`)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.setContent(`<!doctype html><html data-admission-id="${s.admissionId}"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    await expectStableDrgPolling(page, page.getByRole('region', { name: "DRG 预分组", exact: true }), s.path)
  })
  test('归档后只展示冻结结果，隐藏页签中的旧推演不再显示', async ({ page, request, browserApp }) => {
    test.setTimeout(60_000)
    await runDrgArchiveJourney({ page, request, browserApp, open: async () => {
      await page.route(`${browserApp.origin}/drg-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
      await page.goto(`${browserApp.origin}/drg-contract`)
      await page.setContent(`<!doctype html><html data-view="workspace"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    } })
  })
  test('医嘱推演确认在 ShadowRoot 中保持焦点，取消不写入，确认仅签发一次', async ({ page, browserApp }) => {
    test.setTimeout(60_000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const s = await createDrgBrowserPatient(page, browserApp, '合成医嘱审阅Surface患者')
    const catalog = inpatientFullCatalogSchema.parse(await (await s.api.get('/api/his/v1/inpatient/clinical-catalog')).json())
    const medication = catalog.medications.find(item => item.display === '苯磺酸氨氯地平片')!
    const doseText = `1.0${medication.unit}`
    await page.route(`${browserApp.origin}/drg-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await page.goto(`${browserApp.origin}/drg-contract`)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.setContent(`<!doctype html><html data-admission-id="${s.admissionId}" data-view="clinical"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    await page.getByLabel('医嘱项目', { exact: true }).click()
    await page.getByRole('option', { name: medication.display, exact: true }).click()
    await page.getByLabel('每次剂量', { exact: true }).fill(doseText)
    await page.getByRole('button', { name: "预计当前医嘱", exact: true }).click()
    await page.getByRole('button', { name: "审阅预计并开立医嘱", exact: true }).click()
    const dialog = page.getByRole('region', { name: "确认预计后的医嘱", exact: true })
    await expect(dialog).toContainText(doseText)
    await expect.poll(() => dialog.evaluate(element => { const root = element.getRootNode(); return root instanceof ShadowRoot && element.contains(root.activeElement) })).toBe(true)
    const bounds = await dialog.evaluate(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: element.clientWidth, scroll: element.scrollWidth }))
    expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(390); expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    expect(inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json()).orders).toHaveLength(0)
    let posts = 0
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`${s.path}/orders/issue`)) posts++ })
    await page.getByRole('button', { name: "审阅预计并开立医嘱", exact: true }).click()
    await dialog.getByRole('button', { name: "确认开立医嘱", exact: true }).click()
    await expect(dialog).toBeHidden()
    const clinical = inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json())
    expect(clinical.orders).toHaveLength(1)
    expect(clinical.orders[0]).toMatchObject({ catalogItemId: medication.id, doseText, doseQuantity: 1 })
    expect(posts).toBe(1)
    expect(errors).toEqual([])
  })
  test('耗材预留和医保办核定审阅在 ShadowRoot 内保持焦点，窄屏可取消和提交', async ({ page, browserApp }) => {
    test.setTimeout(60_000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const s = await createDrgBrowserPatient(page, browserApp, '合成DRG Surface患者')
    const open = async () => {
      await page.route(`${browserApp.origin}/drg-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
      await page.goto(`${browserApp.origin}/drg-contract`)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.setContent(`<!doctype html><html data-admission-id="${s.admissionId}"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    }
    await open()
    const reserve = page.getByRole('region', { name: '治疗耗材预留', exact: true })
    await reserve.getByLabel('预留耗材', { exact: true }).click()
    await page.getByRole('option', { name: '合成演示缝合材料', exact: true }).click()
    await reserve.getByLabel('预留或释放理由', { exact: true }).fill('合成Surface长中文治疗预留说明，用于核对人工审阅中的数量与材料')
    let reservationPosts = 0
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith(`${s.path}/drg/reservations`)) reservationPosts += 1
    })
    const reservationTrigger = reserve.getByRole('button', { name: '审阅新增预留', exact: true })
    await reservationTrigger.click()
    const reservationDialog = page.getByRole('region', { name: '确认耗材预留变更', exact: true })
    await expect.poll(() => reservationDialog.evaluate(element => { const root = element.getRootNode(); return root instanceof ShadowRoot && element.contains(root.activeElement) })).toBe(true)
    const bounds = await reservationDialog.evaluate(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: element.clientWidth, scroll: element.scrollWidth }))
    expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(390); expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1)
    await expect(reservationDialog.getByRole('button', { name: '确认预留变更', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(reservationDialog).toBeHidden()
    await expect(reservationTrigger).toBeFocused()
    expect(reservationPosts).toBe(0)
    expect(inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json()).reservations).toHaveLength(0)
    await reservationTrigger.click()
    await reservationDialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(reservationTrigger).toBeFocused()
    expect(reservationPosts).toBe(0)
    expect(inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json()).reservations).toHaveLength(0)
    await reserve.getByRole('button', { name: '审阅新增预留', exact: true }).click()
    await reservationDialog.getByRole('button', { name: '确认预留变更', exact: true }).click()
    await expect(reservationDialog).toBeHidden()
    expect(reservationPosts).toBe(1)
    expect(inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json()).reservations).toHaveLength(1)
    await archiveDrgBrowserPatient(s)
    await s.api.login('medical-insurance')
    await open()
    const payer = page.getByRole('region', { name: '医保办 DRG 复核', exact: true })
    await payer.getByLabel('核定说明', { exact: true }).fill('合成Surface归档费用与支付参数复核')
    let assessmentPosts = 0
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith(`${s.path}/drg/payer-review`)) assessmentPosts += 1
    })
    const reviewTrigger = page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: "审阅模拟核定", exact: true })
    await reviewTrigger.click()
    const review = page.getByRole('region', { name: '当前操作', exact: true })
      .filter({ has: page.getByRole('button', { name: '提交模拟核定', exact: true }) })
    const submit = review.getByRole('button', { name: '提交模拟核定', exact: true })
    await expect(submit).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(review).toBeHidden()
    await expect(reviewTrigger).toBeFocused()
    expect(assessmentPosts).toBe(0)
    expect(inpatientDrgPayerReviewListSchema.parse(await (await s.api.get(`${s.path}/drg/payer-reviews`)).json()).reviews).toHaveLength(0)
    await reviewTrigger.click()
    await expect(submit).toBeFocused()
    await review.getByRole('button', { name: '返回', exact: true }).click()
    await expect(review).toBeHidden()
    await expect(reviewTrigger).toBeFocused()
    expect(assessmentPosts).toBe(0)
    await reviewTrigger.click()
    await expect(payer).toContainText('模拟核定支付 ¥3,000.00')
    await expect(payer).toContainText('归档支付预估 ¥3,000.00')
    await expect(payer).toContainText('核定减归档预估 ¥0.00')
    await expect(payer.getByRole('region', { name: "固定病例与编码来源", exact: true })).toContainText('主诊断 I10.x09')
    await expect.poll(() => review.evaluate(element => { const root = element.getRootNode(); return root instanceof ShadowRoot && element.contains(root.activeElement) })).toBe(true)
    await expect(submit).toBeFocused()
    const payerBounds = await review.evaluate(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: element.clientWidth, scroll: element.scrollWidth }))
    expect(payerBounds.left).toBeGreaterThanOrEqual(0); expect(payerBounds.right).toBeLessThanOrEqual(390); expect(payerBounds.scroll).toBeLessThanOrEqual(payerBounds.width + 1)
    await submit.click()
    await expect(review).toBeHidden()
    expect(inpatientDrgPayerReviewListSchema.parse(await (await s.api.get(`${s.path}/drg/payer-reviews`)).json()).reviews).toHaveLength(1)
    expect(assessmentPosts).toBe(1)
    expect(errors).toEqual([])
  })
})
