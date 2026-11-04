import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '../../../web/e2e/inpatient-drg.fixture.ts'
import { runWorkspaceModePresentation } from '../../../web/e2e/workspace-mode-presentation.journey.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
for (const version of ['18', '19']) test.describe(`模式控件样式 React ${version}`, () => {
  let script: string, styles: string
  test.beforeAll(async () => {
    const react = version === '18' ? 'react18' : 'react', dom = version === '18' ? 'react-dom18' : 'react-dom'
    const built = await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') }, resolve: { alias: [
        { find: /^react$/, replacement: require.resolve(react) },
        { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
        { find: 'react-dom/client', replacement: require.resolve(`${dom}/client`) },
        { find: /^react-dom$/, replacement: require.resolve(dom) },
      ] }, build: { write: false, lib: { entry: fileURLToPath(new URL('./workspace-mode-presentation.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'WorkspaceModePresentation' } } })
    const chunks = (Array.isArray(built) ? built : [built]).flatMap(result => 'output' in result ? result.output : [])
    const chunk = chunks.find(result => result.type === 'chunk')
    if (chunk?.type !== 'chunk') throw new Error('Missing mode presentation fixture')
    script = chunk.code
    styles = await buildSurfaceStyles()
  })
  test('收费员和药师切换两种模式保持下拉框与完整样式', async ({ page, browserApp }) => {
    test.setTimeout(90_000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(`${browserApp.origin}/mode-presentation-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await runWorkspaceModePresentation(page, browserApp, {
      mount: async () => {
        await page.goto(`${browserApp.origin}/mode-presentation-contract`)
        await page.setContent(`<!doctype html><html><head><style>${styles}</style></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`)
        await expect(page.locator('.clinmesh-card-workspace')).toBeVisible()
        expect(await page.locator('.clinmesh-card-workspace').evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
      },
      appearance: async theme => {
        await page.locator('.clinmesh-web-root').evaluate((element, value) => {
          element.classList.toggle('dark', value === 'dark')
          element.setAttribute('data-theme', value)
        }, theme)
      },
    })
    expect(errors).toEqual([])
  })
})
