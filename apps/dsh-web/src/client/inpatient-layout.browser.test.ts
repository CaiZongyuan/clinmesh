import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '@playwright/test'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
for (const version of ['18', '19']) {
  test(`住院共享结构在 React ${version} ShadowRoot 的两档宽度与明暗主题保持头部、页签和操作完整`, async ({ page }, info) => {
    const react = version === '18' ? 'react18' : 'react', reactDom = version === '18' ? 'react-dom18' : 'react-dom'
    const result = await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') }, resolve: { alias: [
        { find: /^react$/, replacement: require.resolve(react) }, { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
        { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) }, { find: /^react-dom$/, replacement: require.resolve(reactDom) },
      ] }, build: { write: false, lib: { entry: fileURLToPath(new URL('./inpatient-layout.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'InpatientSharedLayout' } } })
    const script = (Array.isArray(result) ? result : [result]).flatMap(result => 'output' in result ? result.output : []).find(item => item.type === 'chunk')
    if (script?.type !== 'chunk') throw new Error('Missing inpatient layout fixture')
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.setContent(`<!doctype html><html><head><style>${await buildSurfaceStyles()}</style></head><body><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    const patient = page.getByRole('region', { name: '当前住院患者', exact: true })
    await expect(patient.getByRole('heading', { name: '合成住院患者', exact: true })).toBeVisible()
    expect(await patient.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    for (const width of [1101, 826]) for (const theme of ['light', 'dark']) {
      await page.evaluate(({ width, theme }) => {
        const host = document.body.querySelector('div')!
        host.style.width = `${width}px`
        host.shadowRoot!.querySelector('main')!.classList.toggle('dark', theme === 'dark')
      }, { width, theme })
      const head = await patient.getByRole('heading').boundingBox(), number = await patient.locator('[data-inpatient-number]').boundingBox()
      expect(number!.y).toBeGreaterThan(head!.y + head!.height)
      await expect(page.getByRole('button', { name: '确认医嘱', exact: true })).toBeInViewport()
      await expect(page.getByRole('button', { name: '确认医嘱', exact: true })).toHaveCSS('border-top-style', 'dashed')
      await expect.poll(() => page.locator('main').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      await expect(page.getByText('轮到你：逐条校对医嘱', { exact: true })).toBeVisible()
      await page.screenshot({ path: info.outputPath(`inpatient-structure-react${version}-${width}-${theme}.png`), animations: 'disabled' })
    }
    await page.getByRole('button', { name: '校对医嘱', exact: true }).click()
    await expect(page.getByText('已校对', { exact: true })).toBeVisible()
    await page.evaluate(() => { document.body.querySelector('div')!.style.width = '360px' })
    await page.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('menuitem').filter({ has: page.getByText('病案', { exact: true }) }).click()
    await expect(page.getByRole('tab', { name: '病案', exact: true })).toHaveAttribute('aria-selected', 'true')
    expect(errors).toEqual([])
  })
}
