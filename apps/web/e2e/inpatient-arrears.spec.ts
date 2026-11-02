import { randomUUID } from 'node:crypto'
import { insurancePreviewResponseSchema } from '@clinmesh/contracts/insurance'
import { inpatientFinancialSchema, inpatientFinancialResponseSchema } from '@clinmesh/contracts/inpatient-finance'
import { inpatientPaymentPreviewResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { expect, test } from './fixtures.ts'
import { prepareSettledInsurance } from './inpatient-insurance-adjustments.fixture.ts'

test('医生真实入口在结清、医保重审及后续补收之间同步欠费摘要', async ({ page, playwright, browserApp: app }) => {
  await page.setViewportSize({ width: 1680, height: 1000 })
  const { path, admission } = await prepareSettledInsurance(page, app)
  const cashier = await playwright.request.newContext({ baseURL: app.origin, extraHTTPHeaders: { origin: app.origin } })
  try {
    expect((await cashier.post('/api/auth/sign-in/email', { data: { email: 'cashier@demo.clinmesh.local', password: app.password } })).status()).toBe(200)
    const command = async (url: string, input: unknown) => {
      const response = await cashier.post(url, { headers: { 'idempotency-key': randomUUID() }, data: { input } })
      expect(response.status(), await response.text()).toBe(200)
      return response
    }
    await page.request.post(`${app.origin}/api/auth/sign-out`, { headers: { origin: app.origin }, data: {} })
    await page.goto(`${app.origin}/inpatient`)
    await page.getByLabel('账户邮箱').fill('inpatient-doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(app.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    const select = () => page.getByRole('button', { name: '查看合成医保更正患者', exact: true }).click()
    await select()
    const banner = page.getByRole('region', { name: '当前住院患者' })
    const list = page.getByRole('button', { name: '查看合成医保更正患者', exact: true })
    const reminders = page.getByRole('region', { name: '临床提醒', exact: true })
    await expect(banner).toContainText('合成医保更正患者')
    await expect(reminders).not.toContainText('当前需补交')
    await expect(list.getByText('欠费', { exact: true })).toHaveCount(0)
    await expect(reminders).not.toContainText('尚应收')

    const before = inpatientFinancialSchema.parse(await (await cashier.get(`${path}/financial-adjustments`)).json())
    const adjusted = inpatientFinancialResponseSchema.parse(await (await command(`${path}/financial-adjustments`, {
      chargeId: before.charges[0]!.chargeId, direction: 'increase', amountFen: 1000,
      expectedFingerprint: before.fingerprint, reason: '合成医生端欠费回归',
    })).json()).data
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(list.getByText('资金待确认', { exact: true })).toBeVisible()
    await expect(reminders).toContainText('待收费员确认')
    const insurancePath = `${path}/financial-adjustments/${adjusted.adjustments[0]!.adjustmentId}/insurance`
    const cancelled = inpatientFinancialResponseSchema.parse(await (await command(`${insurancePath}/cancel`, {
      settlementId: adjusted.insurance!.active!.id, expectedBalanceVersion: adjusted.insurance!.balance.version, expectedFingerprint: adjusted.fingerprint,
    })).json()).data
    const preview = insurancePreviewResponseSchema.parse(await (await command(`${insurancePath}/preview`, { expectedFingerprint: cancelled.fingerprint })).json()).data
    const replaced = inpatientFinancialResponseSchema.parse(await (await command(`${insurancePath}/confirm`, {
      previewId: preview.previewId, commitToken: preview.commitToken,
    })).json()).data
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(reminders).toContainText('当前需补交 ¥2.00')
    await expect(list.getByText('欠费', { exact: true })).toBeVisible()
    await expect(reminders).toContainText('¥2.00')
    const payment = inpatientPaymentPreviewResponseSchema.parse(await (await command(`${path}/financial-adjustments/payments/preview`, {
      adjustmentId: replaced.adjustments[0]!.adjustmentId, amountFen: 200, expectedFingerprint: replaced.fingerprint,
      tenders: [{ method: 'cash', amountFen: 200 }], simulatorRule: 'success',
    })).json()).data
    await command(`${path}/financial-adjustments/payments/confirm`, { previewId: payment.previewId, commitToken: payment.commitToken })
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(reminders).not.toContainText('当前需补交')
    await expect(list.getByText('欠费', { exact: true })).toHaveCount(0)
    await expect(reminders).not.toContainText('尚应收')
    await page.reload()
    await select()
    await expect(reminders).not.toContainText('当前需补交')
    const detail = await page.request.get(`${app.origin}/api/his/v1/inpatient/admissions/${admission.id}`)
    expect(await detail.json()).toMatchObject({ admission: { outstandingFen: 0, financialStatus: 'settled', status: 'cleared' } })
  } finally { await cashier.dispose() }
})
