import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test, type Page } from '@playwright/test'
import { z } from 'zod'
import { readJsonFromBrowser } from '../../../../scripts/browser-contract.ts'
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
      entry: fileURLToPath(new URL('./queue-rail.browser.fixture.tsx', import.meta.url)),
      formats: ['iife'], name: 'QueueRailContract',
    } },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : [])
  const script = outputs.find(output => output.type === 'chunk')
  if (script?.type !== 'chunk') throw new Error('Missing queue rail browser fixture')
  const artifact = { script: script.code, styles: await buildSurfaceStyles() }
  artifacts.set(version, artifact)
  return artifact
}

async function mount(page: Page, version: string) {
  const { script, styles } = await buildFixture(version)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
  await page.goto('http://localhost/')
  expect(z.object({ ready: z.literal(true) }).parse(await readJsonFromBrowser(page,
    `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style><style data-fixture>${styles}</style></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`,
  ))).toEqual({ ready: true })
}

async function expectNoFixtureErrors(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('queue-rail-errors')))
  const actual = z.object({ errors: z.array(z.string()) }).parse(
    JSON.parse(Buffer.from(await page.title(), 'base64').toString('utf8')),
  )
  expect(actual.errors).toEqual([])
}

for (const version of ['18', '19']) {
  test(`care workflow toggle removes the queue column and preserves drafts across case selection (${version})`, async ({ page }) => {
    await mount(page, version)
    const column = page.locator('[data-workspace-id="outpatient-doctor"] .clinmesh-card-queue')
    const main = page.locator('[data-doctor-region="detail"]')
    const hide = page.getByRole('button', { name: '收起队列', exact: true })
    const show = page.getByRole('button', { name: '展开队列', exact: true })
    await expect(column).toBeVisible()
    await expect(column.getByRole('button', { name: /^选择病例 / })).toHaveCount(2)
    await expect(hide).toHaveAttribute('aria-expanded', 'true')
    const history = page.getByLabel('现病史', { exact: true })
    const draft = '收起队列和切换患者后保留的未提交病史。'
    await history.fill(draft)
    const expandedWidth = await main.evaluate(element => element.getBoundingClientRect().width)
    await hide.click()
    await expect(column).toHaveCount(0)
    await expect(show).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('button', { name: '选择病例 合成浏览器患者' })).toHaveCount(0)
    await expect(history).toHaveValue(draft)
    await expect.poll(() => main.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(expandedWidth)
    await show.click()
    await expect(page.getByRole('button', { name: '选择病例 合成浏览器患者' })).toBeVisible()
    await expect(page.getByRole('button', { name: '选择病例 合成第二病例患者' })).toBeVisible()
    await page.getByRole('button', { name: '选择病例 合成第二病例患者' }).click()
    await expect(page.getByRole('region', { name: '当前患者' }).getByRole('heading', { name: '合成第二病例患者', exact: true })).toBeVisible()
    await expect(history).not.toHaveValue(draft)
    await page.getByRole('button', { name: '选择病例 合成浏览器患者' }).click()
    await expect(page.getByRole('region', { name: '当前患者' })).toBeVisible()
    await expect(history).toHaveValue(draft)
    await hide.click()
    await expect(show).toHaveAttribute('aria-expanded', 'false')
    await expect(column).toHaveCount(0)
    await expect(page.getByRole('button', { name: '选择病例 合成浏览器患者' })).toHaveCount(0)
    await expectNoFixtureErrors(page)
  })

  test(`care workflow queue toggle stays usable across themes font sizes and narrow widths without overflow (${version})`, async ({ page }) => {
    await mount(page, version)
    const draft = '外观变化与队列开合期间保留的未提交病史。'
    await page.getByLabel('现病史', { exact: true }).fill(draft)
    for (const locale of ['zh-CN', 'en-US'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        for (const fontSize of ['standard', 'larger', 'large'] as const) {
          for (const width of [1280, 390]) {
            await test.step(`${locale} ${theme} ${fontSize} ${width}`, async () => {
              await page.setViewportSize({ width, height: 900 })
              await page.evaluate(({ locale, theme, fontSize, width }) => {
                document.getElementById('queue-rail-host')!.style.width = `${width}px`
                window.dispatchEvent(new CustomEvent('queue-rail-appearance', { detail: { locale, theme, fontSize } }))
              }, { locale, theme, fontSize, width })
              const root = page.locator('[data-clinmesh-app="web"]')
              await expect(root).toHaveAttribute('lang', locale)
              await expect(root).toHaveAttribute('data-font-size', fontSize)
              await expect(root).toHaveAttribute('data-theme', theme)
              const hide = page.getByRole('button', { name: locale === 'zh-CN' ? '收起队列' : 'Hide queue', exact: true })
              const show = page.getByRole('button', { name: locale === 'zh-CN' ? '展开队列' : 'Show queue', exact: true })
              const column = page.locator('[data-workspace-id="outpatient-doctor"] .clinmesh-card-queue')
              const history = page.getByLabel(locale === 'zh-CN' ? '现病史' : 'History of present illness', { exact: true })
              const expectCollapsed = async () => {
                await expect(show).toBeVisible()
                await expect(show).toHaveAttribute('aria-expanded', 'false')
                await expect(column).toHaveCount(0)
                await expect(history).toHaveValue(draft)
                expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
              }
              const expectOpen = async () => {
                await expect(hide).toBeVisible()
                await expect(hide).toHaveAttribute('aria-expanded', 'true')
                await expect(column).toBeVisible()
                await expect(column.getByRole('button', { name: locale === 'zh-CN' ? /^选择病例 / : /^Select case / })).toHaveCount(2)
                await expect(history).toHaveValue(draft)
                expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
              }
              // 800px 以下队列默认收起为浮层，展开后再收起；宽屏队列默认展开，收起后再展开。
              if (width < 800) {
                await expectCollapsed()
                await show.click()
                await expectOpen()
                await hide.click()
                await expectCollapsed()
              } else {
                await expectOpen()
                await hide.click()
                await expectCollapsed()
                await show.click()
                await expectOpen()
              }
            })
          }
        }
      }
    }
    await expectNoFixtureErrors(page)
  })
}
