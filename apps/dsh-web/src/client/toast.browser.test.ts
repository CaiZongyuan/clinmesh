import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test, type Page } from '@playwright/test'
import { buildSurfaceStyles } from '../surface-styles.ts'
import { acknowledgeInpatientCompletion } from '../../../web/e2e/inpatient-ui.ts'

const require = createRequire(import.meta.url)

for (const version of ['18', '19']) {
  test.describe(`toast pointer access on React ${version}`, () => {
    let script: string
    let styles: string
    test.beforeAll(async () => {
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
          entry: fileURLToPath(new URL('./toast.browser.fixture.tsx', import.meta.url)),
          formats: ['iife'], name: 'ToastPointerContract',
        } },
      })
      const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => {
        if (!('output' in output)) throw new Error('Unexpected browser watcher')
        return output.output
      })
      const chunk = outputs.find(output => output.type === 'chunk')
      if (chunk?.type !== 'chunk') throw new Error('Missing toast fixture')
      script = chunk.code
      styles = await buildSurfaceStyles()
    })

    async function mount(page: Page) {
      await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
      await page.goto('http://localhost/')
      await page.setContent(`<!doctype html><html><head><style>${styles}</style></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`)
    }

    test('lets a parked pointer confirm beneath notification text and transparent stacked bodies', async ({ page }) => {
      await mount(page)
      const confirm = page.getByRole('button', { name: '确认本次收退', exact: true })
      const bounds = await confirm.boundingBox()
      if (!bounds) throw new Error('Missing confirmation button')
      const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      await page.mouse.move(point.x, point.y)
      const show = page.getByRole('button', { name: '显示完成通知', exact: true })
      await show.focus()
      await page.keyboard.press('Enter')
      const title = page.getByText('本次操作已完成', { exact: true })
      await expect(title).toBeVisible()
      const toast = page.locator('[data-slot="toast"]').first()
      await expect(toast).toBeInViewport({ ratio: 1 })
      const toastBounds = await toast.boundingBox()
      if (!toastBounds) throw new Error('Missing overlapping toast')
      expect(point.x).toBeGreaterThan(toastBounds.x)
      expect(point.x).toBeLessThan(toastBounds.x + toastBounds.width)
      expect(point.y).toBeGreaterThan(toastBounds.y)
      expect(point.y).toBeLessThan(toastBounds.y + toastBounds.height)
      await page.mouse.move(point.x + 1, point.y)
      await page.mouse.click(point.x, point.y)
      await expect(page.getByLabel('确认次数')).toHaveText('1')
      await show.focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('[data-slot="toast-content"][data-behind]')).toHaveCount(1)
      await expect(page.locator('[data-slot="toast-content"][data-behind] [data-slot="toast-close"]')).toHaveCSS('pointer-events', 'none')
      await page.mouse.click(point.x, point.y)
      await expect(page.getByLabel('确认次数')).toHaveText('2')
    })

    test('keeps explicit notification actions and dismissal accessible to the pointer', async ({ page }) => {
      await mount(page)
      await page.getByRole('button', { name: '显示可操作通知', exact: true }).click()
      await page.getByRole('button', { name: '查看回执', exact: true }).click()
      await expect(page.getByLabel('通知操作次数')).toHaveText('1')
      await expect(page.getByLabel('确认次数')).toHaveText('0')
      await page.getByRole('button', { name: '查看回执', exact: true }).focus()
      await page.keyboard.press('Enter')
      await expect(page.getByLabel('通知操作次数')).toHaveText('2')
      await page.getByRole('button', { name: 'Close toast', exact: true }).click()
      await expect(page.locator('[data-slot="toast"]')).toHaveCount(0)
      await expect(page.getByLabel('确认次数')).toHaveText('0')
    })

    test('keeps automatic dismissal running while the pointer rests over notification text', async ({ page }) => {
      await mount(page)
      const confirm = page.getByRole('button', { name: '确认本次收退', exact: true })
      const bounds = await confirm.boundingBox()
      if (!bounds) throw new Error('Missing confirmation button')
      const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      await page.mouse.move(point.x, point.y)
      await page.getByRole('button', { name: '显示短通知', exact: true }).focus()
      await page.keyboard.press('Enter')
      const toast = page.locator('[data-slot="toast"]')
      await expect(toast).toBeInViewport({ ratio: 1 })
      await page.mouse.move(point.x + 1, point.y)
      await expect(toast).toHaveCount(0)
      await expect(page.getByLabel('确认次数')).toHaveText('0')
    })

    for (const stacked of [false, true]) {
      test(`acknowledges a collapsed completion through keyboard expansion, stacked=${stacked}`, async ({ page }) => {
        await mount(page)
        await page.mouse.move(0, 0)
        await page.getByRole('button', { name: '显示完成通知', exact: true }).focus()
        await page.keyboard.press('Enter')
        const completed = page.locator('[data-slot="toast"]').filter({ hasText: '本次操作已完成' })
        await expect(completed).toBeInViewport({ ratio: 1 })
        if (stacked) {
          await page.getByRole('button', { name: '显示另一条通知', exact: true }).focus()
          await page.keyboard.press('Enter')
          await expect(completed.locator('[data-slot="toast-content"]')).toHaveAttribute('data-behind', '')
          await expect(completed.locator('[data-slot="toast-close"]')).toHaveCSS('pointer-events', 'none')
        }
        await expect(completed.locator('[data-slot="toast-close"]')).toHaveAttribute('aria-hidden', 'true')
        await acknowledgeInpatientCompletion(page, '本次操作已完成')
        await expect(completed).toHaveCount(0)
        await expect(page.getByLabel('确认次数')).toHaveText('0')
        if (stacked) {
          await expect(page.getByText('下一项任务就绪', { exact: true })).toBeVisible()
          await page.getByRole('button', { name: '显示另一条通知', exact: true }).focus()
          await page.keyboard.press('F6')
          await expect(page.locator('[data-slot="toast-viewport"]')).toBeFocused()
          await acknowledgeInpatientCompletion(page, '下一项任务就绪')
          await expect(page.locator('[data-slot="toast"]')).toHaveCount(0)
        }
      })
    }
  })
}
