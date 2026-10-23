import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { z } from 'zod'
import { billingCaseSchema, billingQueueSchema, paymentResponseSchema } from '@clinmesh/contracts/his'
import { readJsonFromBrowser } from '../../../../scripts/browser-contract.ts'
import { expectBillingFits, readBill, startBillingBrowserServer, submitPayment } from '../../../web/e2e/billing-payments.fixture.ts'
import { verifyRefundWriteRecovery } from '../../../web/e2e/billing-refunds-recovery.fixture.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
const artifacts = new Map<string, { script: string; styles: string }>()
async function buildFixture(version: string) {
  const existing = artifacts.get(version)
  if (existing !== undefined) return existing
  const react = version === '18' ? 'react18' : 'react'
  const reactDom = version === '18' ? 'react-dom18' : 'react-dom'
  const result = await build({
    configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    resolve: { alias: [
      { find: /^react$/, replacement: require.resolve(react) },
      { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
      { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) },
      { find: /^react-dom$/, replacement: require.resolve(reactDom) },
    ] },
    build: { write: false, lib: {
      entry: fileURLToPath(new URL('./billing-payments.browser.fixture.tsx', import.meta.url)),
      formats: ['iife'], name: 'BillingPaymentsContract',
    } },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : [])
  const script = outputs.find(output => output.type === 'chunk')
  if (script?.type !== 'chunk') throw new Error('Missing billing browser fixture')
  const artifact = { script: script.code, styles: await buildSurfaceStyles() }
  artifacts.set(version, artifact)
  return artifact
}

async function expectShadowDialog(page: Page, dialog: Locator) {
  await expect(dialog).toBeVisible()
  const bounds = await dialog.evaluate(element => {
    const root = element.getRootNode()
    const box = element.getBoundingClientRect()
    return { inShadow: root instanceof ShadowRoot,
      left: box.left, right: box.right, width: element.clientWidth, scrollWidth: element.scrollWidth }
  })
  expect(bounds.inShadow).toBe(true)
  // CI 双 worker 负载下焦点落位可能晚于可见断言（React 19 路径实测复现），轮询等待而非单次采样。
  await expect.poll(async () => dialog.evaluate(element => {
    const root = element.getRootNode()
    return root instanceof ShadowRoot && element.contains(root.activeElement)
  })).toBe(true)
  expect(bounds.left).toBeGreaterThanOrEqual(-1)
  expect(bounds.right).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1)
  expect(await page.evaluate(() => document.querySelector('[role="alertdialog"]') === null)).toBe(true)
}

async function mountBilling(page: Page, version: string, server: { origin: string; password: string }) {
  const login = await page.request.post(`${server.origin}/api/auth/sign-in/email`, {
    headers: { origin: server.origin }, data: { email: 'cashier@demo.clinmesh.local', password: server.password },
  })
  expect(login.status()).toBe(200)
  await page.route(`${server.origin}/billing`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
  await page.goto(`${server.origin}/billing`)
  const { script, styles } = await buildFixture(version)
  expect(z.object({ ready: z.literal(true) }).parse(await readJsonFromBrowser(page,
    `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style><style data-fixture>${styles}</style></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`,
  ))).toEqual({ ready: true })
  await expect(page.getByRole('heading', { name: '收费队列', exact: true })).toBeVisible()
}

for (const version of ['18', '19']) test.describe(`billing asynchronous responses on React ${version}`, () => {
  test.beforeAll(async () => { await buildFixture(version) })
  test('reviews original-payment refunds and recovery inside the Surface shadow root', async ({ page }) => {
    test.setTimeout(120000)
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await mountBilling(page, version, server)
      await submitPayment(page)
      await verifyRefundWriteRecovery(page, server, async () => {
        await mountBilling(page, version, server)
        await page.getByRole('tab', { name: '已缴', exact: true }).click()
      }, dialog => expectShadowDialog(page, dialog))
    } finally { await server.close() }
  })
  test('reviews and compensates real insurance benefits inside the ShadowRoot',async({page})=>{
    test.setTimeout(120000)
    const server=await startBillingBrowserServer(fileURLToPath(new URL('../../../web/',import.meta.url)))
    try{
      await mountBilling(page,version,server)
      const panel=page.getByRole('region',{name:'患者医保待遇',exact:true})
      await panel.getByRole('button',{name:'患者医保待遇（合成）',exact:true}).click()
      await panel.getByRole('button',{name:'预览医保待遇',exact:true}).click()
      await panel.getByRole('button',{name:'审阅医保结算',exact:true}).click()
      const review=page.getByRole('alertdialog',{name:'确认医保结算',exact:true})
      await expectShadowDialog(page,review)
      // The HTTP matrix owns staleness semantics; this boundary checks visible modal feedback.
      const confirmPath=`**/api/his/v1/insurance/outpatient/${server.caseId}/confirm`
      await page.route(confirmPath,route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({
        error:{code:'INSURANCE_PREVIEW_STALE',message:'费用或患者年度余额已变化，请重新预览',type:'conflict',outcome:'definitely_not_sent',retryable:false},
      })}),{times:1})
      await review.getByRole('button',{name:'提交医保结算',exact:true}).click()
      await expect(review.getByRole('alert')).toContainText('医保预览已失效，请刷新费用与年度余额，重新预览并核对待遇。')
      await expect(review.getByRole('alert')).not.toContainText('费用或患者年度余额已变化')
      await review.getByRole('button',{name:'返回核对',exact:true}).click()
      await panel.getByRole('button',{name:'预览医保待遇',exact:true}).click()
      await panel.getByRole('button',{name:'审阅医保结算',exact:true}).click()
      await page.route(confirmPath,async route=>{expect((await route.fetch()).status()).toBe(200);await route.abort('failed')},{times:1})
      await review.getByRole('button',{name:'提交医保结算',exact:true}).click()
      await expect(review.getByRole('alert').filter({hasText:'原操作结果待确认'})).toBeVisible()
      await review.getByRole('button',{name:'恢复原医保操作',exact:true}).click()
      await expect(review).toHaveCount(0)
      await panel.getByRole('button',{name:'撤销原待遇',exact:true}).click()
      const cancel=page.getByRole('alertdialog',{name:'确认撤销医保',exact:true})
      await expectShadowDialog(page,cancel)
      await cancel.getByRole('button',{name:'提交撤销',exact:true}).click()
      await expect(cancel).toHaveCount(0)
      expect((await readBill(page,server)).charges.find(row=>row.chargeItemId===server.chargeItemId)?.remainingFen).toBe(6800)
    }finally{await server.close()}
  })
  for (const replaceSelection of [false, true]) test(`binds a delayed real confirmation to its original selection (queue replacement: ${replaceSelection})`, async ({ page }) => {
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    let releaseResponse = () => {}
    let completeRequest = () => {}
    const committed = new Promise<void>(resolve => { completeRequest = resolve })
    const released = new Promise<void>(resolve => { releaseResponse = resolve })
    let replaceQueue = false
    let originalQueue: z.infer<typeof billingQueueSchema> | undefined
    try {
      // Only pagination and the second queue/bill projection are synthetic. A's preview,
      // confirmation, authentication and ledger use the real HTTP server and SQLite.
      await page.route('**/api/his/v1/billing/queue?**', async route => {
        const response = await route.fetch()
        const queue = billingQueueSchema.parse(await response.json())
        if (queue.items.some(item => item.chargeItemId === server.chargeItemId)) originalQueue = queue
        const original = originalQueue?.items.find(item => item.chargeItemId === server.chargeItemId)
        if (original === undefined) return route.fulfill({ response })
        const second = { ...original, chargeItemId: 'synthetic-charge-b', caseId: 'synthetic-case-b',
          descriptionZh: '合成费用 B', descriptionEn: 'Synthetic charge B', patient: { ...original.patient, name: '合成患者 B' } }
        const projected = billingQueueSchema.parse({ ...queue, items: replaceQueue ? [second] : [original, second], page: 1, pageSize: 2, total: 4 })
        await route.fulfill({ response, json: projected })
      })
      await page.route('**/api/his/v1/billing/cases/synthetic-case-b?**', async route => {
        const response = await page.request.get(`${server.origin}/api/his/v1/billing/cases/${server.caseId}`)
        const original = billingCaseSchema.parse(await response.json())
        const charge = original.charges.find(item => item.chargeItemId === server.chargeItemId)!
        await route.fulfill({ json: billingCaseSchema.parse({ ...original, caseId: 'synthetic-case-b',
          patient: { ...original.patient, name: '合成患者 B' }, charges: [{ ...charge,
            chargeItemId: 'synthetic-charge-b', descriptionZh: '合成费用 B', paidFen: 0, remainingFen: charge.amountFen }],
          payments: [], paidFen: 0, remainingFen: charge.amountFen, totalFen: charge.amountFen }) })
      })
      await mountBilling(page, version, server)
      await page.getByLabel('合成现金', { exact: true }).fill(replaceSelection ? '68' : '20')
      await page.getByRole('button', { name: '预览支付', exact: true }).click()
      await page.getByRole('button', { name: '确认支付', exact: true }).click()
      await page.route('**/api/his/v1/payments/*/actions/confirm', async route => {
        const response = await route.fetch()
        expect(response.status()).toBe(200)
        paymentResponseSchema.parse(await response.json())
        completeRequest()
        const timer = setTimeout(releaseResponse, 10_000)
        try { await released; await route.fulfill({ response }) }
        finally { clearTimeout(timer) }
      })
      const confirmation = page.getByRole('alertdialog', { name: '确认支付', exact: true })
      await confirmation.getByRole('button', { name: '提交支付', exact: true }).click()
      await committed
      for (const tab of await page.getByRole('tab', { includeHidden: true }).all()) await expect(tab).toBeDisabled()
      const second = page.locator('[data-agent-selection="synthetic-charge-b"]')
      await expect(second).toBeDisabled()
      const next = page.getByRole('button', { name: '下一页', exact: true, includeHidden: true })
      await expect(next).toBeDisabled()
      await expect(page.getByLabel('合成现金', { exact: true })).toBeDisabled()
      const agentResult = await page.evaluate(() => new Promise(resolve => {
        window.addEventListener('billing-payments-agent-result', event => {
          if (event instanceof CustomEvent) resolve(event.detail)
        }, { once: true })
        window.dispatchEvent(new CustomEvent('billing-payments-agent-select', { detail: { chargeItemId: 'synthetic-charge-b' } }))
      }))
      expect(z.object({ error: z.string() }).parse(agentResult).error).toContain('支付服务不可用')
      if (replaceSelection) {
        replaceQueue = true
        await page.evaluate(() => window.dispatchEvent(new Event('billing-payments-refresh-queue')))
        await expect(page.locator('[data-agent-selection="' + server.chargeItemId + '"]')).toHaveCount(0)
        await expect(page.locator('[aria-label="本次就诊账单"]')).toContainText('合成费用 B')
      }
      releaseResponse()
      await expect(next).toBeEnabled()
      const bill = await readBill(page, server)
      expect(bill.payments).toHaveLength(1)
      expect(bill.paidFen).toBe(replaceSelection ? 6800 : 2000)
      await expect(page.getByRole('tab', { name: '待缴', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')
      if (replaceSelection) {
        await expect(page.locator('[aria-label="本次就诊账单"]')).toContainText('合成费用 B')
        await expect(page.locator('[data-agent-selection="' + server.chargeItemId + '"]')).toHaveCount(0)
        await expect(page.getByText('支付成功', { exact: true })).toHaveCount(0)
      } else {
        await expect(confirmation).toHaveCount(0)
        await expect(page.getByRole('region', { name: '本次就诊账单', exact: true })).toContainText('¥20.00')
      }
    } finally { releaseResponse(); await server.close() }
  })
})

for (const version of ['18', '19']) test.describe(`billing dialogs on React ${version}`, () => {
  test.beforeAll(async () => { await buildFixture(version) })
  test('keeps payment confirmation and recovery review in ShadowRoot with keyboard cancellation and no extra collection', async ({ page }) => {
    // The document is supplied below; only the real HTTP API and file-backed SQLite are used here.
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      const login = await page.request.post(`${server.origin}/api/auth/sign-in/email`, {
        headers: { origin: server.origin }, data: { email: 'cashier@demo.clinmesh.local', password: server.password },
      })
      expect(login.status()).toBe(200)
      await page.route(`${server.origin}/billing`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
      await page.goto(`${server.origin}/billing`)
      const { script, styles } = await buildFixture(version)
      expect(z.object({ ready: z.literal(true) }).parse(await readJsonFromBrowser(page,
        `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style><style data-fixture>${styles}</style></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`,
      ))).toEqual({ ready: true })
      await expect(page.getByRole('heading', { name: '收费队列', exact: true })).toBeVisible()
      await expectBillingFits(page)
      await page.getByLabel('合成现金', { exact: true }).fill('20')
      await page.getByRole('button', { name: '预览支付', exact: true }).click()
      await page.getByRole('button', { name: '确认支付', exact: true }).click()
      const confirmation = page.getByRole('alertdialog', { name: '确认支付', exact: true })
      await expectShadowDialog(page, confirmation)
      await expect(confirmation).toContainText('¥20.00')
      expect((await readBill(page, server)).payments).toHaveLength(0)
      await confirmation.getByRole('button', { name: '取消', exact: true }).focus()
      await page.keyboard.press('Enter')
      await expect(confirmation).toHaveCount(0)
      expect((await readBill(page, server)).payments).toHaveLength(0)
      expect((await submitPayment(page)).outcome).toBe('success')

      await page.getByLabel('支付处理结果', { exact: true }).click()
      await page.getByRole('option', { name: '结果未知', exact: true }).click()
      const unknown = await submitPayment(page)
      expect(unknown.outcome).toBe('ambiguous')
      const bill = page.getByRole('region', { name: '本次就诊账单', exact: true })
      await bill.getByRole('button', { name: '查询原支付结果', exact: true }).click()
      const review = page.getByRole('alertdialog', { name: '查询原支付结果', exact: true })
      await expectShadowDialog(page, review)
      await expect(review).toContainText(unknown.paymentId)
      await expect(review).toContainText('¥48.00')
      await review.getByRole('button', { name: '取消', exact: true }).focus()
      await page.keyboard.press('Enter')
      await expect(review).toHaveCount(0)
      const before = await readBill(page, server)
      expect(before.payments).toHaveLength(2)
      expect(before.payments.find(payment => payment.paymentId === unknown.paymentId)?.outcome).toBe('ambiguous')
      await bill.getByRole('button', { name: '查询原支付结果', exact: true }).click()
      const recovered = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname.endsWith(`/payments/${unknown.paymentId}/actions/recover`))
      await review.getByRole('button', { name: '查询原支付结果', exact: true }).click()
      const response = await recovered
      expect(response.status()).toBe(200)
      expect(paymentResponseSchema.parse(await response.json()).data).toMatchObject({ paymentId: unknown.paymentId, outcome: 'success' })
      await expect(review).toHaveCount(0)
      expect((await readBill(page, server)).payments.map(payment => payment.paymentId)).toEqual(before.payments.map(payment => payment.paymentId))
      await expect(bill).toBeVisible()
      await expect(bill).toContainText('原结果未知')
      await page.evaluate(() => window.dispatchEvent(new Event('billing-payments-errors')))
      expect(z.object({ errors: z.array(z.string()) }).parse(JSON.parse(Buffer.from(await page.title(), 'base64').toString('utf8'))).errors).toEqual([])
    } finally { await server.close() }
  })
})

for (const version of ['18', '19']) test.describe(`billing pagination on React ${version}`, () => {
  test.beforeAll(async () => { await buildFixture(version) })
  test('reads older payment history and recovers the original attempt on that page', async ({ page }) => {
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    let delayHistoryRead = false
    let releaseHistoryRead = () => {}
    let historyReadStarted = () => {}
    const released = new Promise<void>(resolve => { releaseHistoryRead = resolve })
    const started = new Promise<void>(resolve => { historyReadStarted = resolve })
    try {
      await page.route('**/api/his/v1/billing/queue?**', async route => {
        const response = await route.fetch()
        const queue = billingQueueSchema.parse(await response.json())
        const original = queue.items[0]
        if (original === undefined) return route.fulfill({ response })
        await route.fulfill({ response, json: billingQueueSchema.parse({ ...queue, total: 2,
          items: [original, { ...original, chargeItemId: 'synthetic-charge-b', caseId: 'synthetic-case-b',
            patient: { ...original.patient, name: '合成患者 B' } }] }) })
      })
      await mountBilling(page, version, server)
      // The older history is projected; the unknown attempt and its recovery use real HTTP and SQLite.
      await page.route(url => /^\/api\/his\/v1\/billing\/cases\/[^/]+$/.test(url.pathname), async route => {
        const source = new URL(route.request().url())
        source.searchParams.set('page', '1')
        const otherCase = source.pathname.endsWith('/synthetic-case-b')
        if (otherCase) source.pathname = `/api/his/v1/billing/cases/${server.caseId}`
        const response = await route.fetch({ url: source.toString() })
        const bill = billingCaseSchema.parse(await response.json())
        if (otherCase) return route.fulfill({ response, json: billingCaseSchema.parse({ ...bill,
          caseId: 'synthetic-case-b', patient: { ...bill.patient, name: '合成患者 B' }, payments: [],
          paymentsPagination: { page: 1, pageSize: 20, total: 0 } }) })
        const original = bill.payments[0]
        if (original === undefined) return route.fulfill({ response })
        const historyPage = Number(new URL(route.request().url()).searchParams.get('page') ?? '1')
        const payments = historyPage === 2 ? [original] : Array.from({ length: 20 }, (_, index) => ({
          ...original, paymentId: `synthetic-history-${index}`, initialOutcome: 'declined', outcome: 'declined',
        }))
        if (delayHistoryRead && historyPage === 2) {
          delayHistoryRead = false
          historyReadStarted()
          const timer = setTimeout(releaseHistoryRead, 10_000)
          try { await released } finally { clearTimeout(timer) }
        }
        await route.fulfill({ response, json: billingCaseSchema.parse({ ...bill, payments,
          paymentsPagination: { page: historyPage, pageSize: 20, total: 21 } }) })
      })
      await page.getByLabel('支付处理结果', { exact: true }).click()
      await page.getByRole('option', { name: '结果未知', exact: true }).click()
      await page.getByLabel('合成现金', { exact: true }).fill('20')
      const payment = await submitPayment(page)
      expect(payment.outcome).toBe('ambiguous')
      const bill = page.getByRole('region', { name: '本次就诊账单', exact: true })
      const history = bill.getByRole('navigation', { name: '支付尝试记录', exact: true })
      await expect(bill.getByRole('button', { name: '查询原支付结果', exact: true })).toHaveCount(0)
      await history.getByRole('button', { name: '下一页', exact: true }).click()
      await expect(bill).toContainText(payment.paymentId)
      await page.locator('[data-agent-selection="synthetic-charge-b"]').click()
      await expect(bill.getByRole('navigation')).toHaveCount(0)
      await page.locator(`[data-agent-selection="${server.chargeItemId}"]`).click()
      await expect(history).toContainText('1 / 2')
      delayHistoryRead = true
      const agentRead = page.evaluate(() => new Promise(resolve => {
        window.addEventListener('billing-payments-agent-result', event => {
          if (event instanceof CustomEvent) resolve(event.detail)
        }, { once: true })
        window.dispatchEvent(new CustomEvent('billing-payments-agent-read', { detail: { page: 2 } }))
      }))
      await started
      await history.getByRole('button', { name: '下一页', exact: true }).click()
      await expect(history).toContainText('2 / 2')
      await history.getByRole('button', { name: '上一页', exact: true }).click()
      await expect(history).toContainText('1 / 2')
      releaseHistoryRead()
      expect(z.object({ result: billingCaseSchema }).parse(await agentRead).result.paymentsPagination.page).toBe(2)
      await expect(history).toContainText('1 / 2')
      await history.getByRole('button', { name: '下一页', exact: true }).click()
      await bill.getByRole('button', { name: '查询原支付结果', exact: true }).click()
      const review = page.getByRole('alertdialog', { name: '查询原支付结果', exact: true })
      const recovered = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname.endsWith(`/payments/${payment.paymentId}/actions/recover`))
      await review.getByRole('button', { name: '查询原支付结果', exact: true }).click()
      expect((await recovered).status()).toBe(200)
      await expect(review).toHaveCount(0)
      await expect(bill).toContainText('¥20.00')
      expect((await readBill(page, server)).paidFen).toBe(2000)
    } finally { releaseHistoryRead(); await server.close() }
  })

  test('keeps the partially collected bill selected on page two', async ({ page }) => {
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await page.route('**/api/his/v1/billing/queue?**', async route => {
        const source = new URL(route.request().url())
        const requestedPage = Number(source.searchParams.get('page') ?? '1')
        source.searchParams.set('page', '1')
        const response = await page.request.get(source.toString())
        const queue = billingQueueSchema.parse(await response.json())
        const original = queue.items.find(item => item.chargeItemId === server.chargeItemId)
        if (original === undefined) throw new Error('Missing real receivable')
        const other = { ...original, chargeItemId: 'synthetic-charge-b', caseId: 'synthetic-case-b',
          descriptionZh: 'Synthetic charge B', descriptionEn: 'Synthetic charge B',
          patient: { ...original.patient, name: 'Synthetic patient B' } }
        await route.fulfill({ json: billingQueueSchema.parse({ ...queue,
          items: [requestedPage === 2 ? original : other], page: requestedPage, pageSize: 1, total: 2 }) })
      })
      await page.route('**/api/his/v1/billing/cases/synthetic-case-b?**', async route => {
        const response = await page.request.get(`${server.origin}/api/his/v1/billing/cases/${server.caseId}`)
        const original = billingCaseSchema.parse(await response.json())
        const charge = original.charges.find(item => item.chargeItemId === server.chargeItemId)!
        await route.fulfill({ json: billingCaseSchema.parse({ ...original, caseId: 'synthetic-case-b',
          patient: { ...original.patient, name: 'Synthetic patient B' }, charges: [{ ...charge,
            chargeItemId: 'synthetic-charge-b', descriptionZh: 'Synthetic charge B', paidFen: 0,
            remainingFen: charge.amountFen }], payments: [], paidFen: 0,
          remainingFen: charge.amountFen, totalFen: charge.amountFen }) })
      })
      await mountBilling(page, version, server)
      await expect(page.locator('[data-agent-selection="synthetic-charge-b"]')).toBeVisible()
      await page.getByRole('button', { name: '下一页', exact: true }).click()
      const original = page.locator(`[data-agent-selection="${server.chargeItemId}"]`)
      await expect(original).toBeVisible()
      await page.getByLabel('合成现金', { exact: true }).fill('20')
      const result = await submitPayment(page)
      expect(result.outcome).toBe('success')
      expect((await readBill(page, server)).paidFen).toBe(2000)
      await expect(page.getByRole('button', { name: '预览支付', exact: true })).toBeEnabled()
      await expect(original).toBeVisible()
    } finally { await server.close() }
  })
})
