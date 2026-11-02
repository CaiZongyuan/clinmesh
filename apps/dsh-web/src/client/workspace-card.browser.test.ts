import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test, type Page } from '@playwright/test'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)

function contrast(foreground: string, background: string): number {
  const luminance = (value: string) => value.match(/[\d.]+/g)!.map(Number).slice(0, 3).map(channel => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0)
  const left = luminance(foreground), right = luminance(background)
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05)
}

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
    async function mount(page: Page, mode = 'review') {
      await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
      await page.goto('http://localhost/')
      await page.setContent(`<!doctype html><html><head><style>${styles}</style></head><body><script>window.workspaceCardMode=${JSON.stringify(mode)};${script.replaceAll('</script', '<\\/script')}</script></body></html>`)
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
      await expect(review.getByRole('button', { name: 'Confirm verification' })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.getByLabel('Decision log')).toHaveText('No decisions')
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

    test('removes the entire queue column and follows the content container width', async ({ page }, testInfo) => {
      await mount(page, 'layout')
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
      for (const width of [944, 720, 400]) {
        await page.evaluate(width => { document.querySelector('div')!.style.width = `${width}px` }, width)
        await expect(queue).toBeVisible()
        const queueBox = await queue.boundingBox(), workBox = await work.boundingBox(), resultsBox = await results.boundingBox()
        if (width < 900) expect(resultsBox!.y).toBeGreaterThan(workBox!.y)
        if (width >= 600) expect(workBox!.x).toBeGreaterThan(queueBox!.x)
        else expect(workBox!.y).toBeGreaterThan(queueBox!.y)
        const firstPatient = await page.getByRole('button', { name: 'Queue patient one', exact: true }).boundingBox()
        const secondPatient = await page.getByRole('button', { name: 'Queue patient two', exact: true }).boundingBox()
        if (width < 600) expect(secondPatient!.x).toBeGreaterThan(firstPatient!.x)
        else expect(secondPatient!.y).toBeGreaterThan(firstPatient!.y)
        const overflows = await page.locator('main').evaluate(element => element.scrollWidth > element.clientWidth)
        expect(overflows).toBe(false)
        if (version === '19') {
          await page.locator('main').screenshot({ path: testInfo.outputPath(`workspace-${width}-light.png`), animations: 'disabled' })
          await page.locator('main').evaluate(element => element.classList.add('dark'))
          await page.locator('main').screenshot({ path: testInfo.outputPath(`workspace-${width}-dark.png`), animations: 'disabled' })
          await page.locator('main').evaluate(element => element.classList.remove('dark'))
        }
      }
    })

    test('keeps the active tab visible and allows existing tools to select a tab inside More', async ({ page }) => {
      await mount(page, 'layout')
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
      await mount(page, 'layout')
      const note = page.getByRole('textbox', { name: 'Order note', exact: true })
      await page.getByRole('button', { name: 'Fill with assistant', exact: true }).click()
      await expect(note).toHaveValue('Prepared value')
      await expect(page.getByText('Assistant', { exact: true })).toBeVisible()
      await expect(note).toHaveCSS('border-style', 'dashed')
      await note.fill('Human checked value')
      await expect(page.getByText('Assistant', { exact: true })).toHaveCount(0)
      await expect(note).toHaveCSS('border-style', 'solid')
    })

    test('keeps the header focused on patient work and groups role changes in the person menu', async ({ page }) => {
      await mount(page, 'shell')
      const header = page.locator('header')
      await expect(header.getByText('Synthetic current patient', { exact: true })).toBeVisible()
      await expect(header.getByText('Assistant not connected', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Toggle navigation', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toHaveCount(0)
      await expect(header.getByRole('button', { name: 'Fullscreen ClinMesh', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'User menu', exact: true }).click()
      for (const group of ['Outpatient', 'Inpatient', 'System']) await expect(page.getByRole('group', { name: group, exact: true })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeVisible()
      await page.getByRole('menuitemradio', { name: 'Ward nurse · 病区护士', exact: true }).click()
      await expect(page.getByLabel('Chosen role')).toHaveText('nurse-role')
    })

    test('keeps keyboard navigation among visible tabs when the remaining tabs are inside More', async ({ page }) => {
      await mount(page, 'layout')
      await page.evaluate(() => { document.querySelector('div')!.style.width = '720px' })
      const visibleTabs = page.getByRole('tab')
      await expect(visibleTabs).toHaveCount(2)
      const first = visibleTabs.nth(0), second = visibleTabs.nth(1)
      await first.focus()
      await page.keyboard.press('ArrowRight')
      await expect(second).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(second).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('ArrowRight')
      await expect(first).toBeFocused()
    })

    test('retains the Surface fullscreen and conversation actions without a local theme selector', async ({ page }) => {
      await mount(page, 'surface')
      await expect(page.locator('header').getByText('Assistant ready', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'User menu', exact: true }).click()
      await expect(page.getByRole('menuitemradio', { name: 'Dark', exact: true })).toHaveCount(0)
      await page.getByRole('menuitem', { name: 'Collapse conversation', exact: true }).click()
      await expect(page.getByLabel('Conversation collapsed')).toHaveText('true')
      await page.getByRole('button', { name: 'Fullscreen ClinMesh', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Return to DSH split view', exact: true })).toBeVisible()
      await expect(page.locator('header').getByText('Synthetic current patient', { exact: true })).toBeVisible()
    })

    test('keeps the fallback review visible inside a full-height workspace shell', async ({ page }) => {
      await mount(page, 'shell')
      await page.getByRole('button', { name: 'Prepare shell order', exact: true }).click()
      const review = page.getByRole('region', { name: 'Review shell order', exact: true })
      await expect(review.getByRole('button', { name: 'Confirm shell order', exact: true })).toBeInViewport()
      await review.getByRole('button', { name: 'Confirm shell order', exact: true }).click()
      await expect(page.getByLabel('Shell review result')).toHaveText('Shell command submitted')
    })

    test('enters and exits standalone fullscreen while retaining the current patient', async ({ page }) => {
      await mount(page, 'shell')
      await page.getByRole('button', { name: 'Fullscreen ClinMesh', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible()
      await expect(page.locator('header').getByText('Synthetic current patient', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Fullscreen ClinMesh', exact: true })).toBeVisible()
    })

    test('explains an unavailable native fullscreen action', async ({ page }) => {
      await page.addInitScript(() => { Object.defineProperty(Element.prototype, 'requestFullscreen', { value: undefined, configurable: true }) })
      await mount(page, 'shell')
      const fullscreen = page.getByRole('button', { name: 'Fullscreen ClinMesh', exact: true })
      await expect(fullscreen).toBeDisabled()
      await expect(fullscreen).toHaveAttribute('title', 'Fullscreen is unavailable in this browser')
      await expect(page.locator('header').getByText('Synthetic current patient', { exact: true })).toBeVisible()
    })

    test('keeps text, status, primary actions and control boundaries readable in both themes', async ({ page }) => {
      await mount(page)
      const themes = await page.locator('main').evaluate(element => {
        const probe = document.createElement('span')
        element.append(probe)
        const readColor = (variable: string) => { probe.style.color = `var(${variable})`; return getComputedStyle(probe).color }
        const read = () => ({
          card: readColor('--card'), primary: readColor('--primary'), primaryText: readColor('--primary-foreground'), input: readColor('--input'),
          text: ['--foreground', '--muted-foreground', '--success', '--warning', '--destructive', '--info'].map(readColor),
        })
        const light = read()
        element.classList.add('dark')
        const dark = read()
        probe.remove()
        return [light, dark]
      })
      for (const theme of themes) {
        for (const text of theme.text) expect(contrast(text, theme.card)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(theme.primaryText, theme.primary)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(theme.input, theme.card)).toBeGreaterThanOrEqual(3)
      }
    })
  })
}
