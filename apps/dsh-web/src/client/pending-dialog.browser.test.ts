import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test, type Page } from '@playwright/test'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)

async function deferMutation(page: Page, path = 'synthetic-mutation', status = 503): Promise<() => void> {
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  await page.route(`**/${path}`, async route => {
    await released
    await route.fulfill({ status, body: 'synthetic result' })
  })
  return release
}

for (const version of ['18', '19']) {
  test.describe(`pending dialog on React ${version}`, () => {
    let script: string
    let css: string
    let errors: string[]
    test.beforeAll(async () => {
      const react = version === '18' ? 'react18' : 'react'
      const reactDom = version === '18' ? 'react-dom18' : 'react-dom'
      const [result, stylesheet] = await Promise.all([build({
        configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        resolve: { alias: [
          { find: /^react$/, replacement: require.resolve(react) },
          { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
          { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) },
          { find: /^react-dom$/, replacement: require.resolve(reactDom) },
        ] },
        build: { write: false, lib: { entry: fileURLToPath(new URL('./pending-dialog.browser.fixture.tsx', import.meta.url)),
          formats: ['iife'], name: 'PendingDialog' } },
      }), buildSurfaceStyles()])
      const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : [])
      const chunk = outputs.find(output => output.type === 'chunk')
      if (chunk?.type !== 'chunk') throw new Error('Missing pending dialog fixture')
      script = chunk.code
      css = stylesheet
    })
    test.beforeEach(async ({ page }) => {
      errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
      await page.goto('http://localhost/')
      await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`)
    })
    test.afterEach(() => { expect(errors).toEqual([]) })

    test('keeps confirmation open during a request and permits cancellation after failure', async ({ page }) => {
      const release = await deferMutation(page)
      await page.getByRole('button', { name: 'Open confirmation', exact: true }).click()
      const dialog = page.getByRole('alertdialog', { name: 'Synthetic confirmation', exact: true })
      expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
      await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
      await page.keyboard.press('Escape')
      await page.mouse.click(5, 5)
      await expect(dialog).toBeVisible()
      await expect(dialog).toHaveAttribute('aria-busy', 'true')
      await expect(page.getByLabel('Close requests', { exact: true })).toHaveText('0')
      release()
      await expect(page.getByLabel('Mutation result', { exact: true })).toHaveText('failed')
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()
      await expect(dialog).not.toHaveAttribute('aria-busy', 'true')
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByLabel('Close requests', { exact: true })).toHaveText('1')
    })

    for (const mode of ['controlled', 'uncontrolled']) {
      test(`protects every dismissal path in a ${mode} dialog only while pending`, async ({ page }) => {
        const release = await deferMutation(page)
        await page.getByRole('button', { name: `Open ${mode} dialog`, exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'Synthetic dialog', exact: true })
        await dialog.getByRole('button', { name: 'Submit', exact: true }).click()
        await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
        await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled()
        await page.keyboard.press('Escape')
        await page.mouse.click(5, 5)
        await expect(dialog).toBeVisible()
        await expect(dialog).toHaveAttribute('aria-busy', 'true')
        await expect(page.getByLabel('Close requests', { exact: true })).toHaveText('0')
        release()
        await expect(page.getByLabel('Mutation result', { exact: true })).toHaveText('failed')
        await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()
        await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeEnabled()
        await dialog.getByRole('button', { name: 'Close', exact: true }).click()
        await expect(dialog).toHaveCount(0)
        await page.getByRole('button', { name: 'Reopen dialog', exact: true }).click()
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        await page.getByRole('button', { name: 'Reopen dialog', exact: true }).click()
        await page.mouse.click(5, 5)
        await expect(dialog).toHaveCount(0)
        await expect(page.getByLabel('Close requests', { exact: true })).toHaveText('3')
      })
    }

    test('keeps pending state local to each nested dialog', async ({ page }) => {
      const releaseOuter = await deferMutation(page)
      const releaseInner = await deferMutation(page, 'synthetic-nested-mutation')
      await page.getByRole('button', { name: 'Open controlled dialog', exact: true }).click()
      const outer = page.getByRole('dialog', { name: 'Synthetic dialog', exact: true })
      await outer.getByRole('button', { name: 'Submit', exact: true }).click()
      await outer.getByRole('button', { name: 'Open nested confirmation', exact: true }).click()
      const inner = page.getByRole('alertdialog', { name: 'Nested confirmation', exact: true })
      await expect(inner.getByRole('button', { name: 'Nested cancel', exact: true })).toBeEnabled()
      await page.keyboard.press('Escape')
      await expect(inner).toHaveCount(0)
      await expect(outer).toBeVisible()
      await expect(outer.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
      releaseOuter()
      await expect(page.getByLabel('Mutation result', { exact: true })).toHaveText('failed')
      await outer.getByRole('button', { name: 'Open nested confirmation', exact: true }).click()
      await inner.getByRole('button', { name: 'Nested confirm', exact: true }).click()
      await expect(inner.getByRole('button', { name: 'Nested cancel', exact: true })).toBeDisabled()
      await expect(outer.getByRole('button', { name: 'Cancel', exact: true, includeHidden: true })).toBeEnabled()
      await page.keyboard.press('Escape')
      await expect(inner).toBeVisible()
      releaseInner()
      await expect(inner.getByRole('button', { name: 'Nested cancel', exact: true })).toBeEnabled()
      await inner.getByRole('button', { name: 'Nested cancel', exact: true }).click()
      await expect(inner).toHaveCount(0)
      await outer.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(outer).toHaveCount(0)
    })

    for (const mode of ['controlled dialog', 'uncontrolled dialog', 'confirmation']) {
      test(`permits owner actionsRef.close() of a pending ${mode} without cancelling its request`, async ({ page }) => {
        const release = await deferMutation(page, 'synthetic-mutation', 200)
        await page.getByRole('button', { name: `Open ${mode}`, exact: true }).click()
        const dialog = mode === 'confirmation'
          ? page.getByRole('alertdialog', { name: 'Synthetic confirmation', exact: true })
          : page.getByRole('dialog', { name: 'Synthetic dialog', exact: true })
        await dialog.getByRole('button', { name: mode === 'confirmation' ? 'Confirm' : 'Submit', exact: true }).click()
        await expect(dialog).toHaveAttribute('aria-busy', 'true')
        await page.getByRole('button', { name: 'Owner close', exact: true, includeHidden: true })
          .evaluate(element => (element as HTMLButtonElement).click())
        await expect(dialog).toHaveCount(0)
        await expect(page.getByLabel('Mutation result', { exact: true })).toHaveText('pending')
        await expect(page.getByLabel('Close requests', { exact: true })).toHaveText('1')
        release()
        await expect(page.getByLabel('Mutation result', { exact: true })).toHaveText('complete')
      })
    }

    for (const lifecycle of ['close', 'switch', 'unmount']) {
      for (const mode of ['controlled dialog', 'confirmation']) {
        test(`permits host ${lifecycle} of a pending ${mode} without cancelling its request`, async ({ page }) => {
          const release = await deferMutation(page, 'synthetic-mutation', 200)
          await page.getByRole('button', { name: `Open ${mode}`, exact: true }).click()
          const dialog = mode === 'confirmation'
            ? page.getByRole('alertdialog', { name: 'Synthetic confirmation', exact: true })
            : page.getByRole('dialog', { name: 'Synthetic dialog', exact: true })
          await dialog.getByRole('button', { name: mode === 'confirmation' ? 'Confirm' : 'Submit', exact: true }).click()
          await expect(dialog).toHaveAttribute('aria-busy', 'true')
          // The host lifecycle remains available even while the modal makes its controls inert.
          await page.getByRole('button', { name: `Host ${lifecycle}`, exact: true, includeHidden: true })
            .evaluate(element => (element as HTMLButtonElement).click())
          await expect(dialog).toHaveCount(0)
          await expect(page.getByLabel('Mutation result', { exact: true })).toHaveText('pending')
          release()
          await expect(page.getByLabel('Mutation result', { exact: true })).toHaveText('complete')
          await expect(page.getByLabel('Close requests', { exact: true })).toHaveText('0')
        })
      }
    }
  })
}
