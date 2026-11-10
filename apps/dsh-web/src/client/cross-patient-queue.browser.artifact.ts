import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import type { Page, TestInfo } from '@playwright/test'
import { expect } from '../../../web/e2e/fixtures.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
const artifacts = new Map<string, Promise<string>>()

export function buildQueueSurface(version: string) {
  const existing = artifacts.get(version)
  if (existing) return existing
  const pending = (async () => {
    const styles = await buildSurfaceStyles()
    let freshStylesLoaded = false
    const react = version === '18' ? 'react18' : 'react', reactDom = version === '18' ? 'react-dom18' : 'react-dom'
    const generatedStyles = '\0clinmesh-cross-patient-queue-styles'
    const result = await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      plugins: [{ name: 'cross-patient-queue-styles', enforce: 'pre', resolveId(source) { if (source === './styles.generated.ts') return generatedStyles },
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
      build: { write: false, lib: { entry: fileURLToPath(new URL('./investigation-billing.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'CrossPatientQueueSurface' } },
    })
    if (!freshStylesLoaded) throw new Error('The queue Surface must bundle freshly built styles from this worktree')
    const script = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk')
    if (script?.type !== 'chunk') throw new Error('Missing the real cross-patient queue Surface')
    return script.code
  })()
  artifacts.set(version, pending)
  return pending
}

export async function openQueueSurface(page: Page, origin: string, script: string, view: string) {
  await page.route('**/cross-patient-queue-surface?**', route => route.fulfill({ contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>` }))
  await page.route('**/clinmesh-api/**', route => {
    const url = new URL(route.request().url())
    const path = url.pathname.startsWith('/clinmesh-api/_fhir/R5/Patient/')
      ? url.pathname.replace('/clinmesh-api/_fhir', '/fhir')
      : url.pathname.replace('/clinmesh-api', '/api')
    return route.continue({ url: `${origin}${path}${url.search}` })
  })
  await page.goto(`${origin}/cross-patient-queue-surface?view=${encodeURIComponent(view)}`)
  await expect(page.locator('.clinmesh-card-workspace')).toBeVisible()
  expect(await page.locator('.clinmesh-card-workspace').evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
}

/** 实际宿主826px/125%/大字/深色下仍能点击具名交接与确认入口。 */
export async function reviewQueueAppearance(page: Page, info?: TestInfo, prefix = 'queue') {
  const root = page.locator('.clinmesh-web-root')
  const patient = page.getByRole('region', { name: '当前住院患者', exact: true })
  if (await patient.count()) {
    await expect(patient).toContainText(/(?:女|男|其他|性别未登记) · (?:\d+ 岁|年龄待核对)/)
    await expect(patient.getByRole('alert').filter({ hasText: '患者基本信息读取失败' })).toHaveCount(0)
  }
  // 等待真实通知生命周期结束，避免布局证据被已完成操作的通知覆盖。
  await expect(page.locator('[data-slot="toast"]')).toHaveCount(0)
  const hostStyle = await page.evaluate(() => document.body.querySelector('div')!.style.cssText)
  const appearance = await root.evaluate(element => ({ dark: element.classList.contains('dark'), theme: element.getAttribute('data-theme'), fontSize: element.getAttribute('data-font-size') }))
  try { for (const zoom of [1, 1.25]) {
    await page.evaluate(zoom => {
      const host = document.body.querySelector('div')!
      host.style.width = `${826 / zoom}px`; host.style.height = `${innerHeight / zoom}px`; host.style.zoom = String(zoom)
    }, zoom)
    await root.evaluate((element, zoom) => {
      element.classList.toggle('dark', zoom > 1)
      element.setAttribute('data-theme', zoom > 1 ? 'dark' : 'light')
      element.setAttribute('data-font-size', zoom > 1 ? 'large' : 'normal')
    }, zoom)
    const namedNext = page.getByRole('button', { name: /^(下一份：|下一位：)/ })
    const action = await namedNext.count() ? namedNext : page.getByRole('button', { name: /^(编码审核通过|开始门诊就诊|审阅模拟核定|继续下一页)$/ }).last()
    await expect(action).toBeVisible()
    await action.scrollIntoViewIfNeeded()
    await expect(action).toBeVisible()
    await action.click({ trial: true })
    const text = await action.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element)
      const box = element.getBoundingClientRect(), text = range.getBoundingClientRect()
      return { left: box.left, right: box.right, textLeft: text.left, textRight: text.right }
    })
    expect(text.textLeft).toBeGreaterThanOrEqual(text.left - 1)
    expect(text.textRight).toBeLessThanOrEqual(text.right + 1)
    if (info) await page.screenshot({ path: info.outputPath(`${prefix}-${zoom === 1 ? 'light' : 'dark-zoom'}.png`) })
  } } finally {
    await page.evaluate(style => { document.body.querySelector('div')!.style.cssText = style }, hostStyle)
    await root.evaluate((element, appearance) => {
      element.classList.toggle('dark', appearance.dark)
      if (appearance.theme === null) element.removeAttribute('data-theme'); else element.setAttribute('data-theme', appearance.theme)
      if (appearance.fontSize === null) element.removeAttribute('data-font-size'); else element.setAttribute('data-font-size', appearance.fontSize)
    }, appearance)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  }
}
