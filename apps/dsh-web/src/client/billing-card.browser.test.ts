import { fileURLToPath } from 'node:url'
import { expect, test, type Locator } from '@playwright/test'
import { billingCaseSchema, paymentPreviewResponseSchema, paymentResponseSchema } from '@clinmesh/contracts/his'
import { refundCaseSchema } from '@clinmesh/contracts/refunds'
import { z } from 'zod'
import { readBill, startBillingBrowserServer, submitPayment } from '../../../web/e2e/billing-payments.fixture.ts'
import { buildNonDoctorCard, mountNonDoctorCard } from './non-doctor-card.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`billing cards on React ${version}`, () => {
  test.beforeAll(async () => { await buildNonDoctorCard(version) })
  for (const change of ['切换合成账户', '切换合成 Actor', '切换合成收费岗位']) test(`invalidates payment preview and confirmation on ${change} without erasing the original draft`, async ({ page }) => {
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      // Only SessionContext props change; this checks frontend ownership, not server authorization.
      await mountNonDoctorCard(page, version, server, 'cashier', {}, { sessionScopeProbe: true })
      const cash = page.getByLabel('合成现金', { exact: true })
      const rule = page.getByRole('combobox', { name: '支付处理结果', exact: true })
      await cash.fill('20')
      await rule.click()
      await page.getByRole('option', { name: '拒绝', exact: true }).click()
      await page.getByRole('button', { name: '预览支付', exact: true }).click()
      await expect(page.getByRole('heading', { name: '支付预览', exact: true })).toBeVisible()
      await page.getByRole('button', { name: '确认支付', exact: true }).click()
      const confirmation = page.getByRole('region', { name: '确认支付', exact: true })
      await expect(confirmation.getByRole('button', { name: '提交支付', exact: true })).toBeFocused()
      let confirmations = 0
      page.on('request', request => { if (request.method() === 'POST' && /\/payments\/[^/]+\/actions\/confirm$/.test(new URL(request.url()).pathname)) confirmations++ })
      const switcher = page.getByRole('button', { name: change, exact: true })
      await switcher.click()
      await expect(page.getByLabel('合成会话作用域', { exact: true })).toContainText('synthetic-collision')
      await expect(cash).toHaveValue('')
      await expect(rule).toContainText('成功')
      await expect(confirmation).toHaveCount(0)
      await expect(page.getByRole('heading', { name: '支付预览', exact: true })).toHaveCount(0)
      await expect(switcher).toBeFocused()
      await expect(page.getByRole('button', { name: '助手准备收款', exact: true })).toBeDisabled()
      const publicState = async () => z.object({ preview: z.unknown().nullable() }).passthrough().parse(JSON.parse((await page.getByLabel('收费公开页面状态', { exact: true }).textContent()) ?? 'null'))
      expect((await publicState()).preview).toBeNull()
      await page.getByRole('button', { name: '恢复原会话作用域', exact: true }).click()
      await expect(cash).toHaveValue('20')
      await expect(rule).toContainText('拒绝')
      await expect(confirmation).toHaveCount(0)
      await expect(page.getByRole('heading', { name: '支付预览', exact: true })).toHaveCount(0)
      expect((await publicState()).preview).toBeNull()
      expect(confirmations).toBe(0)
      expect((await readBill(page, server)).paidFen).toBe(0)
      await rule.click()
      await page.getByRole('option', { name: '成功', exact: true }).click()
      expect((await submitPayment(page)).amountFen).toBe(2000)
      expect(confirmations).toBe(1)
      expect((await readBill(page, server)).paidFen).toBe(2000)
    } finally { await server.close() }
  })

  test('does not revive a delayed preview after leaving and returning to the same actor', async ({ page }) => {
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    let release = () => {}
    let entered = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const requestStarted = new Promise<void>(resolve => { entered = resolve })
    try {
      await mountNonDoctorCard(page, version, server, 'cashier', {}, { sessionScopeProbe: true })
      const cash = page.getByLabel('合成现金', { exact: true })
      await cash.fill('20')
      await page.route(`${server.origin}/api/his/v1/payments/actions/preview`, async route => {
        const response = await route.fetch()
        entered()
        await gate
        await route.fulfill({ response })
      })
      const response = page.waitForResponse(item => item.request().method() === 'POST' && new URL(item.url()).pathname.endsWith('/payments/actions/preview'))
      await page.getByRole('button', { name: '预览支付', exact: true }).click()
      await requestStarted
      await page.getByRole('button', { name: '切换合成 Actor', exact: true }).click()
      await expect(cash).toHaveValue('')
      await page.getByRole('button', { name: '恢复原会话作用域', exact: true }).click()
      await expect(cash).toHaveValue('20')
      release()
      expect((await response).status()).toBe(200)
      await expect(page.getByRole('button', { name: '预览支付', exact: true })).toBeEnabled()
      await expect(page.getByRole('heading', { name: '支付预览', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '助手准备收款', exact: true })).toBeDisabled()
      const state = z.object({ preview: z.unknown().nullable() }).passthrough().parse(JSON.parse((await page.getByLabel('收费公开页面状态', { exact: true }).textContent())!))
      expect(state.preview).toBeNull()
      expect((await readBill(page, server)).paidFen).toBe(0)
    } finally { release(); await server.close() }
  })

  test('does not apply delayed history navigation after a practitioner role round trip', async ({ page }) => {
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    let release = () => {}
    let entered = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const requestStarted = new Promise<void>(resolve => { entered = resolve })
    try {
      await mountNonDoctorCard(page, version, server, 'cashier', { 'billing.case.read': { page: 2 } }, { sessionScopeProbe: true })
      const original = await readBill(page, server)
      await page.route(`${server.origin}/api/his/v1/billing/cases/${server.caseId}?**`, async route => {
        const requested = Number(new URL(route.request().url()).searchParams.get('page') ?? 1)
        if (requested === 2) { entered(); await gate }
        await route.fulfill({ json: billingCaseSchema.parse({ ...original, payments: [], paymentsPagination: { page: requested, pageSize: 20, total: 21 } }) })
      })
      await page.getByRole('button', { name: '刷新账单', exact: true }).click()
      const history = page.getByRole('region', { name: '支付尝试记录', exact: true })
      await expect(history).toContainText('1 / 2')
      await page.getByRole('button', { name: '助手填写 billing.case.read', exact: true }).click()
      await requestStarted
      await page.getByRole('button', { name: '切换合成收费岗位', exact: true }).click()
      await page.getByRole('button', { name: '恢复原会话作用域', exact: true }).click()
      release()
      await expect(page.getByLabel('助手填写结果', { exact: true })).toHaveText('填写完成')
      await expect(history).toContainText('1 / 2')
      await expect(history).not.toContainText('2 / 2')
    } finally { release(); await server.close() }
  })

  test('discards recovery confirmation on identity changes while preserving the original unknown attempt', async ({ page }) => {
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await mountNonDoctorCard(page, version, server, 'cashier', {}, { sessionScopeProbe: true })
      await page.getByLabel('合成现金', { exact: true }).fill('20')
      await page.getByRole('combobox', { name: '支付处理结果', exact: true }).click()
      await page.getByRole('option', { name: '结果未知', exact: true }).click()
      const payment = await submitPayment(page)
      expect(payment.outcome).toBe('ambiguous')
      const action = page.getByRole('region', { name: '当前操作', exact: true })
      await action.getByRole('button', { name: '查询原支付结果', exact: true }).click()
      const recovery = page.getByRole('region', { name: '查询原支付结果', exact: true })
      await expect(recovery).toBeVisible()
      let recoveries = 0
      page.on('request', request => { if (request.method() === 'POST' && /\/payments\/[^/]+\/actions\/recover$/.test(new URL(request.url()).pathname)) recoveries++ })
      await page.getByRole('button', { name: '切换合成 Actor', exact: true }).click()
      await expect(recovery).toHaveCount(0)
      await page.getByRole('button', { name: '恢复原会话作用域', exact: true }).click()
      await expect(recovery).toHaveCount(0)
      expect(recoveries).toBe(0)
      const bill = await readBill(page, server)
      expect(bill.payments.find(item => item.paymentId === payment.paymentId)?.outcome).toBe('ambiguous')
      await action.getByRole('button', { name: '查询原支付结果', exact: true }).click()
      await recovery.getByRole('button', { name: '查询原支付结果', exact: true }).click()
      await expect(recovery).toHaveCount(0)
      expect(recoveries).toBe(1)
      expect((await readBill(page, server)).paidFen).toBe(2000)
    } finally { await server.close() }
  })

  test('rejects an already approved old payment after an identity round trip during its decision gate', async ({ page }) => {
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await mountNonDoctorCard(page, version, server, 'cashier', {}, { sessionScopeProbe: true })
      const cash = page.getByLabel('合成现金', { exact: true })
      await cash.fill('20')
      await page.getByRole('button', { name: '预览支付', exact: true }).click()
      await expect(page.getByRole('heading', { name: '支付预览', exact: true })).toBeVisible()
      await page.getByLabel('延迟批准', { exact: true }).check()
      await page.getByRole('button', { name: '助手准备收款', exact: true }).click()
      const review = page.getByRole('region', { name: '确认支付', exact: true })
      await review.getByRole('button', { name: '提交支付', exact: true }).click()
      await expect(page.getByLabel('批准状态', { exact: true })).toHaveText('等待批准闸门')
      let confirms = 0
      page.on('request', request => { if (request.method() === 'POST' && /\/payments\/[^/]+\/actions\/confirm$/.test(new URL(request.url()).pathname)) confirms++ })
      await page.getByRole('button', { name: '切换合成收费岗位', exact: true }).click()
      await expect(cash).toHaveValue('')
      await page.getByRole('button', { name: '恢复原会话作用域', exact: true }).click()
      await expect(cash).toHaveValue('20')
      await page.getByRole('button', { name: '放行确认', exact: true }).click()
      await expect(review).toHaveCount(0)
      expect(confirms).toBe(0)
      expect((await readBill(page, server)).paidFen).toBe(0)
    } finally { await server.close() }
  })
  test('submits the reviewed payment even after a different preview is prepared during the decision gate', async ({ page }) => {
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await mountNonDoctorCard(page, version, server, 'cashier', { 'billing.payment.preview': {} })
      await expect(page.getByRole('list', { name: '办理流程', exact: true }).getByRole('listitem').filter({ hasText: '缴费' })).toHaveAttribute('aria-current', 'step')
      const cash = page.getByLabel('合成现金', { exact: true })
      await cash.fill('20')
      const firstResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/his/v1/payments/actions/preview')
      await page.getByRole('button', { name: '预览支付', exact: true }).click()
      const first = paymentPreviewResponseSchema.parse(await (await firstResponse).json()).data
      expect(first.amountFen).toBe(2000)
      await page.getByLabel('延迟批准', { exact: true }).check()
      await page.getByRole('button', { name: '助手准备收款', exact: true }).click()
      const review = page.getByRole('region', { name: '确认支付', exact: true })
      await expect(review).toContainText('¥20.00')
      await review.getByRole('button', { name: '提交支付', exact: true }).click()
      await expect(page.getByLabel('批准状态', { exact: true })).toHaveText('等待批准闸门')
      await cash.fill('30')
      const secondResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/his/v1/payments/actions/preview')
      await page.getByRole('button', { name: '助手填写 billing.payment.preview', exact: true }).click()
      const second = paymentPreviewResponseSchema.parse(await (await secondResponse).json()).data
      expect(second.amountFen).toBe(3000)
      expect(second.previewId).not.toBe(first.previewId)
      const received = page.waitForResponse(response => response.request().method() === 'POST' && /\/payments\/[^/]+\/actions\/confirm$/.test(new URL(response.url()).pathname))
      await page.getByRole('button', { name: '放行确认', exact: true }).click()
      const response = await received
      expect(new URL(response.url()).pathname).toContain(first.previewId)
      expect(response.status()).toBe(200)
      const payment = paymentResponseSchema.parse(await response.json()).data
      expect(payment.amountFen).toBe(2000)
      expect((await readBill(page, server)).paidFen).toBe(2000)
      await expect(cash).toHaveValue('30')
    } finally { await server.close() }
  })
  test('reports malformed and excessive tender amounts beside their fields before previewing', async ({ page }) => {
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await mountNonDoctorCard(page, version, server, 'cashier')
      let previewRequests = 0
      page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/payments/actions/preview')) previewRequests += 1 })
      const cash = page.getByLabel('合成现金', { exact: true })
      await cash.fill('0.001')
      await expect(cash).toHaveAttribute('aria-invalid', 'true')
      await expect(page.getByText('请输入大于零、最多两位小数的金额，且合计不超过未收金额。', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '预览支付', exact: true })).toBeDisabled()
      await cash.fill('69')
      await expect(cash).toHaveAttribute('aria-invalid', 'true')
      expect(previewRequests).toBe(0)
      await cash.fill('20')
      await expect(cash).not.toHaveAttribute('aria-invalid', 'true')
      const response = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/payments/actions/preview'))
      await page.getByRole('button', { name: '预览支付', exact: true }).click()
      expect(paymentPreviewResponseSchema.parse(await (await response).json()).data.amountFen).toBe(2000)
    } finally { await server.close() }
  })
  test('retains unpaid corrections and fully refunded history independently of the visible payment page', async ({ page }) => {
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await mountNonDoctorCard(page, version, server, 'cashier')
      const panel = page.getByRole('region', { name: '费用更正与退款', exact: true })
      await expect(panel.getByLabel('费用冲减金额（元）', { exact: true })).toBeEnabled()
      await expect(page.getByRole('heading', { name: '退款', exact: true })).toHaveCount(0)
      expect((await submitPayment(page)).amountFen).toBe(6800)
      await expect(page.getByRole('heading', { name: '退款', exact: true })).toBeVisible()
      await panel.getByLabel('费用冲减金额（元）', { exact: true }).fill('68')
      await panel.getByLabel('费用更正原因', { exact: true }).fill('合成费用全部更正，核准冲减68元。')
      await panel.getByRole('button', { name: '记录费用更正', exact: true }).click()
      const correction = page.getByRole('region', { name: '确认费用更正', exact: true })
      await correction.getByRole('button', { name: '确认费用更正', exact: true }).click()
      await expect(correction).toHaveCount(0)
      await panel.getByLabel('本次退款金额（元）', { exact: true }).fill('68')
      await panel.getByRole('button', { name: '预览退款', exact: true }).click()
      const refund = page.getByRole('region', { name: '确认退款', exact: true })
      await refund.getByRole('button', { name: '确认退款', exact: true }).click()
      await expect(refund).toHaveCount(0)
      const ledger = refundCaseSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/billing/cases/${server.caseId}/refunds`)).json())
      expect(ledger.refundedFen).toBe(6800)
      const bill = await readBill(page, server)
      expect(bill.paidFen).toBe(0)
      // The page projection omits old attempts; the actual refund ledger and writes remain unchanged.
      await page.route(`**/api/his/v1/billing/cases/${server.caseId}?**`, route => route.fulfill({ json: billingCaseSchema.parse({
        ...bill, payments: [], paymentsPagination: { page: 1, pageSize: 20, total: 21 },
      }) }))
      await page.getByRole('button', { name: '刷新账单', exact: true }).click()
      await expect(page.getByRole('region', { name: '支付尝试记录', exact: true })).toContainText('尚无支付尝试')
      await expect(page.getByRole('heading', { name: '退款', exact: true })).toBeVisible()
      await expect(panel).toContainText(ledger.refunds[0]!.refundId)
      await expect(panel).toContainText('退款成功')
    } finally { await server.close() }
  })
  for (const remainsUnknown of [false, true]) test(`focuses each refund confirmation and returns to its trigger when recovery ${remainsUnknown ? 'remains unknown' : 'succeeds'}`, async ({ page }) => {
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    let release = () => {}
    try {
      await mountNonDoctorCard(page, version, server, 'cashier')
      await submitPayment(page)
      let writes = 0
      page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/his/v1/')) writes++ })
      const panel = page.getByRole('region', { name: '费用更正与退款', exact: true })
      await panel.getByLabel('费用冲减金额（元）', { exact: true }).fill('20')
      await panel.getByLabel('费用更正原因', { exact: true }).fill('合成费用更正，核准冲减20元。')
      const correctionTrigger = panel.getByRole('button', { name: '记录费用更正', exact: true })
      const correction = page.getByRole('region', { name: '确认费用更正', exact: true })
      for (const cancel of ['button', 'escape']) {
        await correctionTrigger.click()
        await expect(correction.getByRole('button', { name: '确认费用更正', exact: true })).toBeFocused()
        if (cancel === 'button') await correction.getByRole('button', { name: '取消', exact: true }).click()
        else await page.keyboard.press('Escape')
        await expect(correction).toHaveCount(0)
        await expect(correctionTrigger).toBeFocused()
      }
      await correctionTrigger.click()
      await correction.getByRole('button', { name: '确认费用更正', exact: true }).click()
      await expect(correction).toHaveCount(0)
      await expect(correctionTrigger).toBeFocused()
      await expect(correctionTrigger).toBeDisabled()
      await page.keyboard.press('Enter')
      await correctionTrigger.click({ force: true })
      await expect(correction).toHaveCount(0)

      await panel.getByLabel('本次退款金额（元）', { exact: true }).fill('10')
      await panel.getByRole('combobox', { name: '退款处理结果', exact: true }).click()
      await page.getByRole('option', { name: remainsUnknown ? '查询后仍未知' : '结果未知', exact: true }).click()
      const refundTrigger = panel.getByRole('button', { name: '预览退款', exact: true })
      const refund = page.getByRole('region', { name: '确认退款', exact: true })
      for (const cancel of ['button', 'escape']) {
        await refundTrigger.click()
        await expect(refund.getByRole('button', { name: '确认退款', exact: true })).toBeFocused()
        if (cancel === 'button') await refund.getByRole('button', { name: '取消', exact: true }).click()
        else await page.keyboard.press('Escape')
        await expect(refund).toHaveCount(0)
        await expect(refundTrigger).toBeFocused()
      }
      const gate = new Promise<void>(resolve => { release = resolve })
      let entered = () => {}
      const requestStarted = new Promise<void>(resolve => { entered = resolve })
      await page.route('**/api/his/v1/refunds/*/actions/confirm', async route => {
        const response = await route.fetch()
        entered()
        await gate
        await route.fulfill({ response })
      }, { times: 1 })
      await refundTrigger.click()
      await expect(refund.getByRole('button', { name: '确认退款', exact: true })).toBeFocused()
      await refund.getByRole('button', { name: '确认退款', exact: true }).click()
      await requestStarted
      await page.keyboard.press('Escape')
      await expect(refund).toBeVisible()
      await expect(refund.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
      release()
      await expect(refund).toHaveCount(0)
      await expect(refundTrigger).toBeFocused()
      await expect(refundTrigger).toBeDisabled()
      await page.keyboard.press('Enter')
      await refundTrigger.click({ force: true })
      await expect(refund).toHaveCount(0)

      const recovery = page.getByRole('region', { name: '查询原退款结果', exact: true })
      // The recorded attempt precedes the confirmation with the same button name.
      const recoveryTrigger = panel.getByRole('button', { name: '查询原退款结果', exact: true }).first()
      for (const cancel of ['button', 'escape']) {
        await recoveryTrigger.click()
        await expect(recovery.getByRole('button', { name: '查询原退款结果', exact: true })).toBeFocused()
        if (cancel === 'button') await recovery.getByRole('button', { name: '取消', exact: true }).click()
        else await page.keyboard.press('Escape')
        await expect(recovery).toHaveCount(0)
        await expect(recoveryTrigger).toBeFocused()
      }
      await recoveryTrigger.click()
      await recovery.getByRole('button', { name: '查询原退款结果', exact: true }).click()
      await expect(recovery).toHaveCount(0)
      if (remainsUnknown) await expect(recoveryTrigger).toBeFocused()
      else {
        await expect(recoveryTrigger).toHaveCount(0)
        await expect(refundTrigger).toBeFocused()
      }
      const ledger = refundCaseSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/billing/cases/${server.caseId}/refunds`)).json())
      expect(ledger).toMatchObject(remainsUnknown
        ? { adjustedFen: 2000, refundedFen: 0, reservedFen: 1000, refunds: [{ amountFen: 1000, outcome: 'ambiguous' }] }
        : { adjustedFen: 2000, refundedFen: 1000, reservedFen: 0, refunds: [{ amountFen: 1000, outcome: 'success' }] })
      expect((await readBill(page, server)).paidFen).toBe(remainsUnknown ? 6800 : 5800)
      expect(writes).toBe(6)
    } finally { release(); await server.close() }
  })

  test('invalidates all refund confirmations without returning focus across an identity change', async ({ page }) => {
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await mountNonDoctorCard(page, version, server, 'cashier', {}, { sessionScopeProbe: true })
      await submitPayment(page)
      const panel = page.getByRole('region', { name: '费用更正与退款', exact: true })
      const prepareCorrection = async () => {
        await panel.getByLabel('费用冲减金额（元）', { exact: true }).fill('20')
        await panel.getByLabel('费用更正原因', { exact: true }).fill('合成费用更正，核准冲减20元。')
        await panel.getByRole('button', { name: '记录费用更正', exact: true }).click()
      }
      const changeIdentity = async (name: string, review: Locator) => {
        await expect(review).toBeVisible()
        const switcher = page.getByRole('button', { name, exact: true })
        await switcher.click()
        await expect(review).toHaveCount(0)
        await expect(switcher).toBeFocused()
        await page.getByRole('button', { name: '恢复原会话作用域', exact: true }).click()
        await expect(review).toHaveCount(0)
      }
      await prepareCorrection()
      const correction = page.getByRole('region', { name: '确认费用更正', exact: true })
      await changeIdentity('切换合成账户', correction)
      await prepareCorrection()
      await correction.getByRole('button', { name: '确认费用更正', exact: true }).click()
      await expect(correction).toHaveCount(0)
      await panel.getByLabel('本次退款金额（元）', { exact: true }).fill('10')
      await panel.getByRole('button', { name: '预览退款', exact: true }).click()
      const refund = page.getByRole('region', { name: '确认退款', exact: true })
      await changeIdentity('切换合成 Actor', refund)
      await panel.getByLabel('本次退款金额（元）', { exact: true }).fill('10')
      await panel.getByRole('combobox', { name: '退款处理结果', exact: true }).click()
      await page.getByRole('option', { name: '结果未知', exact: true }).click()
      await panel.getByRole('button', { name: '预览退款', exact: true }).click()
      await refund.getByRole('button', { name: '确认退款', exact: true }).click()
      await expect(refund).toHaveCount(0)
      await panel.getByRole('button', { name: '查询原退款结果', exact: true }).click()
      const recovery = page.getByRole('region', { name: '查询原退款结果', exact: true })
      await changeIdentity('切换合成收费岗位', recovery)
      const ledger = refundCaseSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/billing/cases/${server.caseId}/refunds`)).json())
      expect(ledger).toMatchObject({ adjustedFen: 2000, refundedFen: 0, reservedFen: 1000, refunds: [{ amountFen: 1000, outcome: 'ambiguous' }] })
    } finally { await server.close() }
  })
})
