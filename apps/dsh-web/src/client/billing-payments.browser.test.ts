import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { z } from 'zod'
import { paymentResponseSchema } from '@clinmesh/contracts/his'
import { readJsonFromBrowser } from '../../../../scripts/browser-contract.ts'
import { expectBillingFits, readBill, startBillingBrowserServer, submitPayment } from '../../../web/e2e/billing-payments.fixture.ts'
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
    return { inShadow: root instanceof ShadowRoot, focused: root instanceof ShadowRoot && element.contains(root.activeElement),
      left: box.left, right: box.right, width: element.clientWidth, scrollWidth: element.scrollWidth }
  })
  expect(bounds.inShadow).toBe(true)
  expect(bounds.focused).toBe(true)
  expect(bounds.left).toBeGreaterThanOrEqual(-1)
  expect(bounds.right).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1)
  expect(await page.evaluate(() => document.querySelector('[role="alertdialog"]') === null)).toBe(true)
}

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
