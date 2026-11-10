import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import type { Page } from '@playwright/test'
import { expect, test } from '../../../web/e2e/fixtures.ts'
import { startDoctorFirstVisit, startInvestigationBillingServer } from '../../../web/e2e/investigation-billing.fixture.ts'
import { expectFourUnpaidCharges, prepareMultiChargeInvestigations, rejectClinicalMedia } from '../../../web/e2e/multi-charge-payment.fixture.ts'
import { runFourChargeCollectionSuccess } from '../../../web/e2e/multi-charge-collection.journey.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
const artifacts = new Map<string, Promise<string>>()
function buildCollectionSurface(version: string) {
  const existing = artifacts.get(version)
  if (existing) return existing
  const pending = (async () => {
    const styles = await buildSurfaceStyles()
    let freshStylesLoaded = false
    const react = version === '18' ? 'react18' : 'react', reactDom = version === '18' ? 'react-dom18' : 'react-dom'
    const generatedStyles = '\0clinmesh-multi-charge-collection-styles'
    const result = await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      plugins: [{ name: 'multi-charge-collection-styles', enforce: 'pre', resolveId(source) { if (source === './styles.generated.ts') return generatedStyles },
        load(id) { if (id === generatedStyles) { freshStylesLoaded = true; return `export const clinMeshStyles = ${JSON.stringify(styles)}` } } }],
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
      build: { write: false, lib: { entry: fileURLToPath(new URL('./investigation-billing.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'MultiChargeCollectionSurface' } },
    })
    if (!freshStylesLoaded) throw new Error('The collection Surface must bundle freshly built styles from this worktree')
    const script = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk')
    if (script?.type !== 'chunk') throw new Error('Missing the real collection Surface')
    return script.code
  })()
  artifacts.set(version, pending)
  return pending
}

async function openCollectionSurface(page: Page, origin: string, script: string, view: string) {
  await page.route('**/multi-charge-collection-surface?**', route => route.fulfill({ contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>` }))
  await page.route('**/clinmesh-api/**', route => {
    const url = new URL(route.request().url())
    return route.continue({ url: `${origin}${url.pathname.replace('/clinmesh-api', '/api')}${url.search}` })
  })
  await page.goto(`${origin}/multi-charge-collection-surface?view=${encodeURIComponent(view)}`)
}

for (const version of ['18', '19']) test.describe(`真实上游合并收款 React ${version}`, () => {
  let script: string
  test.beforeAll(async () => { test.setTimeout(120_000); script = await buildCollectionSurface(version) })
  test('真实四费组合预览进入一笔合并收款', async ({ page, browser, webRoot }) => {
    test.setTimeout(180_000)
    const server = await startInvestigationBillingServer(webRoot, true)
    const cashierContext = await browser.newContext(), cashier = await cashierContext.newPage()
    const doctorMedia = await rejectClinicalMedia(page), cashierMedia = await rejectClinicalMedia(cashier)
    try {
      await page.setViewportSize({ width: 1600, height: 900 })
      await cashier.setViewportSize({ width: 1600, height: 900 })
      await openCollectionSurface(page, server.origin, script, '/consultation')
      await startDoctorFirstVisit(page, server.password)
      const prepared = await prepareMultiChargeInvestigations(page, server)
      await openCollectionSurface(cashier, server.origin, script, '/billing')
      await cashier.getByLabel('账户邮箱').fill('cashier@demo.clinmesh.local')
      await cashier.getByLabel('账户密码').fill(server.password)
      await cashier.getByRole('button', { name: '登录', exact: true }).click()
      await expect(cashier.getByRole('heading', { name: '门诊收费', exact: true })).toBeVisible()
      await expectFourUnpaidCharges(cashier, server, prepared.chargeIds)
      expect(await cashier.getByRole('region', { name: '本次就诊账单', exact: true }).evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
      await runFourChargeCollectionSuccess(cashier, server, prepared.chargeIds)
      expect(doctorMedia).toEqual([])
      expect(cashierMedia).toEqual([])
    } finally {
      await page.close()
      await cashierContext.close()
      await server.close()
    }
  })
})
