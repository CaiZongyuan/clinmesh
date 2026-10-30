import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test, type Page } from '@playwright/test'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)

for (const version of ['18', '19']) {
  test.describe(`flat workspace on React ${version}`, () => {
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
          entry: fileURLToPath(new URL('./workspace-card.browser.fixture.tsx', import.meta.url)),
          formats: ['iife'], name: 'WorkspaceCardContract',
        } },
      })
      const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => {
        if (!('output' in output)) throw new Error('Unexpected browser watcher')
        return output.output
      })
      const chunk = outputs.find(output => output.type === 'chunk')
      if (chunk?.type !== 'chunk') throw new Error('Missing workspace fixture')
      script = chunk.code
      styles = await buildSurfaceStyles()
    })
    async function mount(page: Page, layout = false) {
      await page.setContent(`<!doctype html><html><head><style>${styles}</style></head><body><script>window.workspaceCardMode=${layout};${script.replaceAll('</script', '<\\/script')}</script></body></html>`)
    }

    test('keeps human review inline and records the decision before the command', async ({ page }) => {
      await mount(page)
      await page.getByRole('button', { name: 'Prepare order', exact: true }).click()
      await expect(page.getByRole('alertdialog')).toHaveCount(0)
      const review = page.getByRole('region', { name: 'Prepare verification', exact: true })
      await expect(review).toBeVisible()
      await expect(review.getByRole('button', { name: 'Confirm verification', exact: true })).toBeFocused()
      await review.getByRole('button', { name: 'Confirm verification', exact: true }).click()
      await expect(page.getByLabel('Review result')).toHaveText('approved: approved,command')
      await expect(page.getByRole('button', { name: 'Prepare order', exact: true })).toBeFocused()
      await expect(review).toHaveCount(0)
    })

    test('requires acknowledgement, rejects a second request and allows explicit refusal', async ({ page }) => {
      await mount(page)
      await page.getByRole('button', { name: 'Prepare checked order', exact: true }).click()
      const review = page.getByRole('region', { name: 'Prepare verification', exact: true })
      await expect(review.getByRole('button', { name: 'Confirm verification' })).toBeDisabled()
      await expect(page.getByLabel('Review result')).toHaveText('No command submitted')
      await page.getByRole('button', { name: 'Prepare replacement', exact: true }).click()
      await expect(page.getByLabel('Review result')).toContainText('Another ClinMesh Agent review is pending')
      await expect(page.getByRole('region', { name: 'Replacement verification' })).toHaveCount(0)
      await review.getByRole('checkbox', { name: 'I checked the order' }).check()
      await expect(review.getByRole('button', { name: 'Confirm verification' })).toBeEnabled()
      await review.getByRole('button', { name: 'Do not use', exact: true }).click()
      await expect(page.getByLabel('Review result')).toHaveText('rejected: rejected')
    })

    test('moves a row review to the action bar and preserves a fallback when the bar unmounts', async ({ page }) => {
      await mount(page)
      await page.getByRole('button', { name: 'Prepare row order', exact: true }).click()
      await expect(page.getByRole('article', { name: 'Synthetic order' }).getByRole('region', { name: 'Prepare verification' })).toBeVisible()
      await page.getByRole('button', { name: 'Hide order row', exact: true }).click()
      const review = page.getByRole('region', { name: 'Prepare verification', exact: true })
      await expect(review).toBeVisible()
      await page.getByRole('button', { name: 'Hide action bar', exact: true }).click()
      await expect(review).toBeVisible()
      await review.getByRole('button', { name: 'Confirm verification' }).click()
      await expect(page.getByLabel('Review result')).toHaveText('approved: approved,command')
    })

    test('aborts or unmounts pending review without submitting a command', async ({ page }) => {
      await mount(page)
      await page.getByRole('button', { name: 'Prepare order', exact: true }).click()
      await page.getByRole('button', { name: 'Abort request', exact: true }).click()
      await expect(page.getByLabel('Review result')).toContainText('cancelled')
      await expect(page.getByRole('region', { name: 'Prepare verification' })).toHaveCount(0)
      await page.getByRole('button', { name: 'Prepare order', exact: true }).click()
      await page.getByRole('button', { name: 'Unmount workspace', exact: true }).click()
      await expect(page.getByLabel('Review result')).toContainText('closed')
      await expect(page.getByRole('region', { name: 'Prepare verification' })).toHaveCount(0)
    })

    test('does not submit when the trusted decision gate rejects the review', async ({ page }) => {
      await mount(page)
      await page.getByRole('button', { name: 'Prepare expired order', exact: true }).click()
      await page.getByRole('button', { name: 'Confirm verification', exact: true }).click()
      await expect(page.getByLabel('Review result')).toHaveText('The page context expired')
      await expect(page.getByRole('region', { name: 'Prepare verification' })).toHaveCount(0)
    })

    test('uses neutral primary actions and inherits host tokens in both themes', async ({ page }) => {
      await mount(page)
      const action = page.getByRole('button', { name: 'Prepare order', exact: true })
      await expect(action).toHaveCSS('background-color', 'rgb(15, 17, 21)')
      await expect(page.locator('main')).toHaveCSS('font-size', '14px')
      await page.evaluate(() => {
        document.body.style.setProperty('--dsw-alias-button-primary-fill', '#25282d')
        document.body.style.setProperty('--dsw-alias-label-primary', '#171b22')
      })
      await expect(action).toHaveCSS('background-color', 'rgb(37, 40, 45)')
      await expect(page.locator('main')).toHaveCSS('color', 'rgb(23, 27, 34)')
      await page.evaluate(() => {
        document.body.style.removeProperty('--dsw-alias-button-primary-fill')
        document.body.style.removeProperty('--dsw-alias-label-primary')
        document.querySelector('div')!.shadowRoot!.querySelector('main')!.classList.add('dark')
      })
      await expect(action).toHaveCSS('background-color', 'rgb(249, 250, 251)')
    })

    test('removes the entire queue column and follows the content container width', async ({ page }) => {
      await mount(page, true)
      const queue = page.getByRole('region', { name: 'Patient queue' })
      const work = page.getByRole('region', { name: 'Current work' })
      const results = page.getByRole('complementary', { name: 'Read-only results' })
      const wideQueue = await queue.boundingBox(), wideWork = await work.boundingBox(), wideResults = await results.boundingBox()
      expect(wideQueue).not.toBeNull(); expect(wideWork).not.toBeNull(); expect(wideResults).not.toBeNull()
      expect(wideWork!.x).toBeGreaterThan(wideQueue!.x)
      expect(wideResults!.x).toBeGreaterThan(wideWork!.x)
      await page.getByRole('button', { name: 'Hide queue', exact: true }).click()
      await expect(queue).toHaveCount(0)
      const expanded = await work.boundingBox()
      expect(expanded!.width).toBeGreaterThan(wideWork!.width)
      await page.getByRole('button', { name: 'Show queue', exact: true }).click()
      for (const width of [720, 400]) {
        await page.evaluate(width => { document.querySelector('div')!.style.width = `${width}px` }, width)
        await expect(queue).toBeVisible()
        const queueBox = await queue.boundingBox(), workBox = await work.boundingBox(), resultsBox = await results.boundingBox()
        expect(resultsBox!.y).toBeGreaterThan(workBox!.y)
        if (width === 720) expect(workBox!.x).toBeGreaterThan(queueBox!.x)
        else expect(workBox!.y).toBeGreaterThan(queueBox!.y)
        const overflows = await page.locator('main').evaluate(element => element.scrollWidth > element.clientWidth)
        expect(overflows).toBe(false)
      }
    })

    test('keeps the active tab visible and allows existing tools to select a tab inside More', async ({ page }) => {
      await mount(page, true)
      await expect(page.getByRole('tab', { name: 'Clinical orders', exact: true })).toBeVisible()
      await expect(page.getByRole('tab', { name: 'Clinical orders', exact: true })).toHaveAccessibleDescription('In progress, 3 pending')
      await page.getByRole('button', { name: 'Open records section', exact: true }).click()
      await expect(page.getByRole('tab', { name: 'Medical records', exact: true })).toBeVisible()
      await expect(page.getByRole('tab', { name: 'Medical records', exact: true })).toHaveAttribute('aria-selected', 'true')
      await page.getByRole('button', { name: 'More', exact: true }).click()
      await page.getByRole('tab', { name: 'Surgery preparation', exact: true }).click()
      await page.getByRole('button', { name: 'Less', exact: true }).click()
      await expect(page.getByRole('tab', { name: 'Surgery preparation', exact: true })).toBeVisible()
      await page.evaluate(() => { document.querySelector('div')!.style.width = '400px' })
      await expect(page.getByRole('tab', { name: 'Surgery preparation', exact: true })).toBeVisible()
      expect(await page.locator('main').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
    })

    test('marks assistant-filled fields until a person edits the value', async ({ page }) => {
      await mount(page, true)
      const note = page.getByRole('textbox', { name: 'Order note', exact: true })
      await page.getByRole('button', { name: 'Fill with assistant', exact: true }).click()
      await expect(note).toHaveValue('Prepared value')
      await expect(page.getByText('Assistant', { exact: true })).toBeVisible()
      await expect(note).toHaveCSS('border-style', 'dashed')
      await note.fill('Human checked value')
      await expect(page.getByText('Assistant', { exact: true })).toHaveCount(0)
      await expect(note).toHaveCSS('border-style', 'solid')
    })
  })
}
