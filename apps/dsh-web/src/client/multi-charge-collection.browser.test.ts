import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { build } from 'vite'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { expect, test } from '../../../web/e2e/fixtures.ts'
import { startDoctorFirstVisit, startInvestigationBillingServer } from '../../../web/e2e/investigation-billing.fixture.ts'
import { expectFourUnpaidCharges, prepareMultiChargeInvestigations, rejectClinicalMedia } from '../../../web/e2e/multi-charge-payment.fixture.ts'
import { runFourChargeCollectionSuccess } from '../../../web/e2e/multi-charge-collection.journey.ts'
import { runMultiChargeAllocationRefund } from '../../../web/e2e/multi-charge-allocation-refund.journey.ts'
import { runCrossPatientCollectionRecovery, runDeclinedAndUnknownCollection } from '../../../web/e2e/multi-charge-collection-recovery.journey.ts'
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

const longLaboratoryName = '合成白细胞计数（门诊感染风险评估、当前费用余额及原项目来源逐项核对用合成长中文名称）'

/** 新确认、分配和恢复入口补充窄屏放大文字证据；原表格七组矩阵沿用既有合同。 */
async function reviewCollectionControls(page: Page, info: TestInfo, version: string, stage: string, region: Locator) {
  if (!['collection-confirmation', 'unknown-collection-confirmation', 'collection-recovery', 'allocation-options', 'allocation-long-value', 'allocation-selected-value', 'refund-confirmation', 'refund-recovery'].includes(stage)) return
  const root = page.locator('.clinmesh-web-root')
  for (const { width, zoom } of [{ width: 1600, zoom: 1 }, { width: 826, zoom: 1.25 }]) {
    await page.evaluate(({ width, zoom }) => {
      const host = document.body.querySelector('div')!
      host.style.width = `${width / zoom}px`; host.style.height = `${innerHeight / zoom}px`; host.style.zoom = String(zoom)
    }, { width, zoom })
    await root.evaluate((element, zoom) => {
      element.classList.toggle('dark', zoom > 1)
      element.setAttribute('data-theme', zoom > 1 ? 'dark' : 'light')
      element.setAttribute('data-font-size', zoom > 1 ? 'large' : 'normal')
    }, zoom)
    await region.scrollIntoViewIfNeeded()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await region.evaluate(async element => { await Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)) })
    const evidence = await region.evaluate(element => {
      const shadow = element.getRootNode()
      if (!(shadow instanceof ShadowRoot)) throw new Error('Expected real upstream ShadowRoot controls')
      const bounds = element.getBoundingClientRect().toJSON()
      const options = Array.from(element.querySelectorAll('[role="option"]'), option => {
        const walker = document.createTreeWalker(option, NodeFilter.SHOW_TEXT), lines = [], textStyles = []
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent?.trim()) continue
          const range = document.createRange(); range.selectNodeContents(walker.currentNode)
          lines.push(...Array.from(range.getClientRects(), rect => rect.toJSON()))
          const parent = walker.currentNode.parentElement!
          textStyles.push({ text: walker.currentNode.textContent, whiteSpace: getComputedStyle(parent).whiteSpace,
            overflowX: getComputedStyle(parent).overflowX, flexShrink: getComputedStyle(parent).flexShrink, className: parent.className })
        }
        return { text: option.textContent, bounds: option.getBoundingClientRect().toJSON(), lines, textStyles }
      })
      const value = element.querySelector('[data-slot="select-value"]')
      const valueRange = value === null ? undefined : (() => {
        const range = document.createRange(); range.selectNodeContents(value)
        return { text: value.textContent, bounds: value.getBoundingClientRect().toJSON(),
          lines: Array.from(range.getClientRects(), rect => rect.toJSON()),
          whiteSpace: getComputedStyle(value).whiteSpace, flexShrink: getComputedStyle(value).flexShrink,
          display: getComputedStyle(value).display, lineClamp: getComputedStyle(value).webkitLineClamp, className: value.className }
      })()
      return { bounds, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, options, value: valueRange,
        host: shadow.host.getBoundingClientRect().toJSON() }
    })
    const controls = []
    for (const button of await region.getByRole('button').all()) {
      if (!(await button.isVisible())) continue
      const name = await button.innerText()
      if (!['确认合并收款', '确认退款', '查询原退款结果', '查询原合并收款'].includes(name)) continue
      await button.scrollIntoViewIfNeeded()
      controls.push({ name, bounds: await button.boundingBox() })
      await expect(button).toBeInViewport()
    }
    const filename = `collection-controls-react${version}-${stage}-${width}-${zoom}.json`
    await writeFile(info.outputPath(filename), JSON.stringify({ version, stage, width, zoom, evidence, controls }, null, 2) + '\n')
    await info.attach(filename, { contentType: 'application/json', path: info.outputPath(filename) })
    expect(evidence.scrollWidth - evidence.clientWidth, `${stage}: no horizontal clipping`).toBeLessThanOrEqual(1)
    for (const option of evidence.options) for (const line of option.lines) {
      expect(line.left, `${stage}: complete allocation label inside option`).toBeGreaterThanOrEqual(option.bounds.left - 1)
      expect(line.right, `${stage}: complete allocation label inside option`).toBeLessThanOrEqual(option.bounds.right + 1)
    }
    if (zoom > 1) for (const option of evidence.options.filter(option => option.text?.includes(longLaboratoryName))) {
      expect(option.lines.length, 'Long original allocation labels wrap into readable lines').toBeGreaterThan(1)
    }
    if (evidence.value !== undefined) {
      for (const line of evidence.value.lines) {
        expect(line.left, `${stage}: selected allocation text stays inside trigger`).toBeGreaterThanOrEqual(evidence.bounds.left - 1)
        expect(line.right, `${stage}: selected allocation text stays inside trigger`).toBeLessThanOrEqual(evidence.bounds.right + 1)
        expect(line.top, `${stage}: selected allocation text stays inside trigger`).toBeGreaterThanOrEqual(evidence.bounds.top - 1)
        expect(line.bottom, `${stage}: selected allocation text stays inside trigger`).toBeLessThanOrEqual(evidence.bounds.bottom + 1)
      }
      if (zoom > 1 && stage === 'allocation-long-value') expect(evidence.value.lines.length).toBeGreaterThan(1)
    }
  }
  await page.evaluate(() => { const host = document.body.querySelector('div')!; host.style.width = '1600px'; host.style.height = `${innerHeight}px`; host.style.zoom = '1' })
  await root.evaluate(element => { element.classList.remove('dark'); element.setAttribute('data-theme', 'light'); element.setAttribute('data-font-size', 'normal') })
}

for (const version of ['18', '19']) test.describe(`真实上游合并收款 React ${version}`, () => {
  let script: string
  test.beforeAll(async () => { test.setTimeout(120_000); script = await buildCollectionSurface(version) })
  for (const scenario of ['success-refund', 'unknown-recovery', 'cross-patient-recovery', 'late-patient-result'] as const) test(`真实四费合并收款 ${scenario}`, async ({ page, browser, webRoot }, info) => {
    test.setTimeout(180_000)
    const server = await startInvestigationBillingServer(webRoot, true, { '0100101A': longLaboratoryName })
    const cashierContext = await browser.newContext(), cashier = await cashierContext.newPage()
    const doctorMedia = await rejectClinicalMedia(page), cashierMedia = await rejectClinicalMedia(cashier)
    const errors: string[] = []
    cashier.on('pageerror', error => errors.push(error.message))
    try {
      await page.setViewportSize({ width: 1600, height: 900 })
      await cashier.setViewportSize({ width: 1600, height: 900 })
      await openCollectionSurface(page, server.origin, script, '/consultation')
      await startDoctorFirstVisit(page, server.password)
      const prepared = await prepareMultiChargeInvestigations(page, server, longLaboratoryName)
      await openCollectionSurface(cashier, server.origin, script, '/billing')
      await cashier.getByLabel('账户邮箱').fill('cashier@demo.clinmesh.local')
      await cashier.getByLabel('账户密码').fill(server.password)
      await cashier.getByRole('button', { name: '登录', exact: true }).click()
      await expect(cashier.getByRole('heading', { name: '门诊收费', exact: true })).toBeVisible()
      await expectFourUnpaidCharges(cashier, server, prepared.chargeIds)
      expect(await cashier.getByRole('region', { name: '本次就诊账单', exact: true }).evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
      const review = (stage: string, region: Locator) => reviewCollectionControls(cashier, info, version, stage, region)
      if (scenario === 'success-refund') {
        const proof = await runFourChargeCollectionSuccess(cashier, server, prepared.chargeIds, review)
        await runMultiChargeAllocationRefund(cashier, page, server, proof.payment.paymentId, review)
      } else if (scenario === 'unknown-recovery') await runDeclinedAndUnknownCollection(cashier, server, prepared.chargeIds, review)
      else await runCrossPatientCollectionRecovery(cashier, page, server, prepared.chargeIds, scenario === 'late-patient-result' ? 'late-success' : 'lost-response')
      expect(doctorMedia).toEqual([])
      expect(cashierMedia).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await page.close()
      await cashierContext.close()
      await server.close()
    }
  })
})
