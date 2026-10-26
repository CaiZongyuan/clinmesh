import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import type { Page } from '@playwright/test'
import { expect, test } from '../../../web/e2e/fixtures.ts'
import { readBill } from '../../../web/e2e/billing-payments.fixture.ts'
import { issueDoctorLaboratoryRequest, readDoctorBillingCase, startDoctorFirstVisit, startInvestigationBillingServer } from '../../../web/e2e/investigation-billing.fixture.ts'
import { refundCancelledInvestigation } from '../../../web/e2e/investigation-billing-cancellation.fixture.ts'
import { collectAndObserveInvestigationReports, issueBillableInvestigations } from '../../../web/e2e/investigation-billing-execution.fixture.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
const artifacts = new Map<string, string>()
async function buildSurfaceFixture(version: string) {
  const existing = artifacts.get(version)
  if (existing !== undefined) return existing
  const styles = await buildSurfaceStyles()
  const react = version === '18' ? 'react18' : 'react'
  const reactDom = version === '18' ? 'react-dom18' : 'react-dom'
  const generatedStyles = '\0clinmesh-investigation-styles'
  const result = await build({
    configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    plugins: [{ name: 'synthetic-surface-styles', resolveId(source) { if (source === './styles.generated.ts') return generatedStyles },
      load(id) { if (id === generatedStyles) return `export const clinMeshStyles = ${JSON.stringify(styles)}` } }],
    resolve: { alias: [
      { find: /^react$/, replacement: require.resolve(react) },
      { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
      { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) },
      { find: /^react-dom$/, replacement: require.resolve(reactDom) },
      { find: '@deepseek-ai/dsh-client-ui-primitives', replacement: fileURLToPath(new URL('./dsh-ui-primitives.test-stub.tsx', import.meta.url)) },
      { find: 'dsh-react-surface/client', replacement: fileURLToPath(new URL('../../../../vendor/dsh-react-surface/packages/runtime/src/client/index.tsx', import.meta.url)) },
    ] },
    build: { write: false, lib: { entry: fileURLToPath(new URL('./investigation-billing.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'InvestigationBillingSurface' } },
  })
  const script = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk')
  if (script?.type !== 'chunk') throw new Error('Missing the real ClinMesh Surface fixture')
  artifacts.set(version, script.code)
  return script.code
}

async function openSurface(page: Page, origin: string, script: string, view: string) {
  await page.route('**/investigation-surface?**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>` }))
  await page.route('**/clinmesh-api/**', route => {
    const url = new URL(route.request().url())
    return route.continue({ url: `${origin}${url.pathname.replace('/clinmesh-api', '/api')}${url.search}` })
  })
  await page.goto(`${origin}/investigation-surface?view=${encodeURIComponent(view)}`)
}

for (const version of ['18', '19']) {
  test(`real ClinMesh Surface returns paid investigation reports and recovers cancellation refunds with React ${version}`, async ({ page, browser, webRoot }) => {
    test.setTimeout(180_000)
    const server = await startInvestigationBillingServer(webRoot, true)
    const cashierContext = await browser.newContext()
    const cashier = await cashierContext.newPage()
    const errors: string[] = []
    const pixelRequests: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    cashier.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (request.url().includes('/blocks/')) pixelRequests.push(request.url()) })
    cashier.on('request', request => { if (request.url().includes('/blocks/')) pixelRequests.push(request.url()) })
    try {
      const script = await buildSurfaceFixture(version)
      await openSurface(page, server.origin, script, '/consultation')
      await startDoctorFirstVisit(page, server.password)
      const id = await issueDoctorLaboratoryRequest(page, { query: '白细胞', name: '合成白细胞计数', code: '0100101A' })
      const request = (await readDoctorBillingCase(page, server)).laboratoryRequests!.requests.find(item => item.id === id)!
      expect(request.billing).toMatchObject({ status: 'pending', remainingFen: 800 })
      expect(request.report).toBeUndefined()
      await openSurface(cashier, server.origin, script, '/billing')
      await cashier.getByLabel('账户邮箱').fill('cashier@demo.clinmesh.local')
      await cashier.getByLabel('账户密码').fill(server.password)
      await cashier.getByRole('button', { name: '登录', exact: true }).click()
      const origin = cashier.getByRole('region', { name: '当前费用来源', exact: true })
      await expect(origin.getByText(`申请：${id}`, { exact: true })).toBeVisible()
      expect(await origin.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
      await expect(cashier.getByRole('tab', { name: '放射费用', exact: true })).toBeVisible()
      await expect(cashier.getByRole('tab', { name: '病理会诊费用', exact: true })).toBeVisible()
      await expect(cashier.getByRole('tab', { name: '药品费用', exact: true })).toBeVisible()
      await refundCancelledInvestigation(page, cashier, server, 'imaging')
      await refundCancelledInvestigation(page, cashier, server, 'pathology')
      const ids = await issueBillableInvestigations(page, id)
      await collectAndObserveInvestigationReports(page, cashier, server, ids)
      const bill = await readBill(cashier, server)
      expect(bill.charges.find(charge => charge.chargeItemId === request.billing!.chargeItemId)).toMatchObject({ paidFen: 800, remainingFen: 0 })
      expect(bill.payments).toHaveLength(6)
      expect(bill.payments.filter(payment => payment.chargeItemId === request.billing!.chargeItemId)).toHaveLength(2)
      expect(errors).toEqual([])
      expect(pixelRequests).toEqual([])
    } finally {
      await page.close()
      await cashierContext.close()
      await server.close()
    }
  })
}
