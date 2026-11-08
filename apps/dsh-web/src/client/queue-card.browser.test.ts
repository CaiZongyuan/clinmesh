import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import type { Page } from '@playwright/test'
import { expect, test } from '../../../web/e2e/fixtures.ts'
import { expectQueueCardBounds, expectQueueToggle, expectTriageQueueSelection, prepareTriageQueue, queueCardRoles } from '../../../web/e2e/queue-card.journey.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
for (const version of ['18', '19']) test.describe(`队列卡片 Surface React ${version}`, () => {
  let script: string, styles: string
  test.beforeAll(async () => {
    test.setTimeout(120_000)
    const react = version === '18' ? 'react18' : 'react', reactDom = version === '18' ? 'react-dom18' : 'react-dom'
    const result = await build({
      configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      resolve: { alias: [
        { find: /^react$/, replacement: require.resolve(react) },
        { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
        { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) },
        { find: /^react-dom$/, replacement: require.resolve(reactDom) },
      ] },
      build: { write: false, lib: { entry: fileURLToPath(new URL('./queue-card.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'QueueCardContract' } },
    })
    const chunk = (Array.isArray(result) ? result : [result]).flatMap(item => 'output' in item ? item.output : []).find(item => item.type === 'chunk')
    if (chunk?.type !== 'chunk') throw new Error('Missing queue card fixture')
    script = chunk.code
    styles = await buildSurfaceStyles()
  })

  async function mount(page: Page, origin: string, route: string) {
    await page.route(`${origin}/queue-card-contract`, handler => handler.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await page.goto(`${origin}/queue-card-contract`)
    await page.setContent(`<!doctype html><html data-route="/${route}"><head><meta charset="UTF-8"><style>body{margin:0}</style><style>${styles}</style></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`)
  }
  const resize = (page: Page, width: number) => page.locator('[data-queue-card-host]').evaluate((element, width) => { element.style.width = `${width}px` }, width)

  for (const [role, route, region] of queueCardRoles) test(`实际工作台队列等高：${role}`, async ({ page, browserApp }) => {
    await page.setViewportSize({ width: 1440, height: 940 })
    await mount(page, browserApp.origin, route)
    await page.getByLabel('账户邮箱').fill(`${role}@demo.clinmesh.local`)
    await page.getByLabel('账户密码').fill(browserApp.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    if (region) await expect(page.getByRole('region', { name: region, exact: true })).toBeVisible()
    for (const width of [1101, 826]) {
      await resize(page, width)
      for (const dark of [false, true]) {
        await page.locator('.clinmesh-web-root').evaluate((element, dark) => element.classList.toggle('dark', dark), dark)
        await expectQueueCardBounds(page)
      }
    }
    await expectQueueToggle(page, width => resize(page, width))
  })

  for (const count of [1, 10]) test(`${count} 人队列等高、末尾可达并在窄容器选择后关闭浮层`, async ({ page, browserApp }) => {
    await prepareTriageQueue(page, browserApp, count)
    await mount(page, browserApp.origin, 'triage')
    await page.locator('[data-queue-card-host]').evaluate(element => { element.style.height = '600px' })
    await page.getByLabel('账户邮箱').fill('triage@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(browserApp.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expectTriageQueueSelection(page, width => resize(page, width), count)
  })
})
