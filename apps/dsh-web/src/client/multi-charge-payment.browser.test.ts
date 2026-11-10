import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import type { Page } from '@playwright/test'
import { expect, test } from '../../../web/e2e/fixtures.ts'
import { startDoctorFirstVisit, startInvestigationBillingServer } from '../../../web/e2e/investigation-billing.fixture.ts'
import { expectFourUnpaidCharges, prepareMultiChargeInvestigations, rejectClinicalMedia } from '../../../web/e2e/multi-charge-payment.fixture.ts'
import { clearMultiChargeDraftJourney, multiChargeDialog, runMultiChargePreviewJourney } from '../../../web/e2e/multi-charge-payment.journey.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
const artifacts = new Map<string, Promise<string>>()
function buildMultiChargeSurface(version: string) {
  const existing = artifacts.get(version)
  if (existing) return existing
  const pending = (async () => {
    const styles = await buildSurfaceStyles()
    const react = version === '18' ? 'react18' : 'react', reactDom = version === '18' ? 'react-dom18' : 'react-dom'
    const generatedStyles = '\0clinmesh-multi-charge-styles'
    const result = await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      plugins: [{ name: 'multi-charge-styles', resolveId(source) { if (source === './styles.generated.ts') return generatedStyles },
        load(id) { if (id === generatedStyles) return `export const clinMeshStyles = ${JSON.stringify(styles)}` } }],
      resolve: { alias: [
        { find: '@clinmesh/web/application', replacement: fileURLToPath(new URL('../../../web/src/app/web-app.tsx', import.meta.url)) },
        { find: '@clinmesh/web/runtime', replacement: fileURLToPath(new URL('../../../web/src/app/web-runtime.tsx', import.meta.url)) },
        { find: /^react$/, replacement: require.resolve(react) },
        { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
        { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) },
        { find: /^react-dom$/, replacement: require.resolve(reactDom) },
        { find: '@deepseek-ai/dsh-client-ui-primitives', replacement: fileURLToPath(new URL('./dsh-ui-primitives.test-stub.tsx', import.meta.url)) },
        { find: 'dsh-react-surface/client', replacement: fileURLToPath(new URL('../../../../vendor/dsh-react-surface/packages/runtime/src/client/index.tsx', import.meta.url)) },
      ] },
      build: { write: false, lib: { entry: fileURLToPath(new URL('./investigation-billing.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'MultiChargeSurface' } },
    })
    const script = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk')
    if (script?.type !== 'chunk') throw new Error('Missing the real cashier Surface')
    return script.code
  })()
  artifacts.set(version, pending)
  return pending
}

async function openSurface(page: Page, origin: string, script: string, view: string) {
  await page.route('**/multi-charge-surface?**', route => route.fulfill({ contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>` }))
  await page.route('**/clinmesh-api/**', route => {
    const url = new URL(route.request().url())
    return route.continue({ url: `${origin}${url.pathname.replace('/clinmesh-api', '/api')}${url.search}` })
  })
  await page.goto(`${origin}/multi-charge-surface?view=${encodeURIComponent(view)}`)
}

for (const version of ['18', '19']) test.describe(`真实上游多费用预览 React ${version}`, () => {
  let script: string
  test.beforeAll(async () => { test.setTimeout(120_000); script = await buildMultiChargeSurface(version) })
  test('医生原费用在收费员 ShadowRoot 中跨类别选择并冻结预览，尚未收款', async ({ page, browser, webRoot }) => {
    test.setTimeout(120_000)
    const server = await startInvestigationBillingServer(webRoot, true)
    const cashierContext = await browser.newContext()
    const cashier = await cashierContext.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    cashier.on('pageerror', error => errors.push(error.message))
    const doctorMedia = await rejectClinicalMedia(page), cashierMedia = await rejectClinicalMedia(cashier)
    try {
      await openSurface(page, server.origin, script, '/consultation')
      await startDoctorFirstVisit(page, server.password)
      const prepared = await prepareMultiChargeInvestigations(page, server)
      await openSurface(cashier, server.origin, script, '/billing')
      await cashier.getByLabel('账户邮箱').fill('cashier@demo.clinmesh.local')
      await cashier.getByLabel('账户密码').fill(server.password)
      await cashier.getByRole('button', { name: '登录', exact: true }).click()
      await expect(cashier.getByRole('heading', { name: '门诊收费', exact: true })).toBeVisible()
      await expectFourUnpaidCharges(cashier, server, prepared.chargeIds)
      const bill = cashier.getByRole('region', { name: '本次就诊账单', exact: true })
      await expect(bill).toBeVisible()
      expect(await bill.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
      await runMultiChargePreviewJourney(cashier, server, prepared.chargeIds)
      const dialog = multiChargeDialog(cashier)
      expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
      await clearMultiChargeDraftJourney(dialog)
      await expectFourUnpaidCharges(cashier, server, prepared.chargeIds)
      expect(errors).toEqual([])
      expect(doctorMedia).toEqual([])
      expect(cashierMedia).toEqual([])
    } finally {
      await page.close()
      await cashierContext.close()
      await server.close()
    }
  })
})
