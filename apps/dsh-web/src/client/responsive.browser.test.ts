import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '@playwright/test'
import { z } from 'zod'
import { readJsonFromBrowser } from '../../../../scripts/browser-contract.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

test('adapts navigation to the Surface width and retains edits across resize', async ({ page }) => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic', jsxDev: false },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      write: false,
      lib: {
        entry: fileURLToPath(new URL('./responsive.browser.fixture.tsx', import.meta.url)),
        formats: ['iife'],
        name: 'ResponsiveContract',
      },
    },
  })
  const output = (Array.isArray(result) ? result : [result]).flatMap((result) =>
    'output' in result ? result.output : [],
  )
  const script = output.find((entry) => entry.type === 'chunk')
  if (!script || script.type !== 'chunk') throw new Error('Missing browser fixture')
  const styles = await buildSurfaceStyles()
  await page.setViewportSize({ width: 1600, height: 900 })
  const response = await readJsonFromBrowser(page,
    `<!doctype html><html><head><style data-fixture>${styles}</style></head><body><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>`,
  )
  const failure = z.object({ error: z.string() }).safeParse(response)
  if (failure.success) throw new Error(failure.data.error)
  expect(z.object({ phase: z.literal('catalog-open') }).parse(response)).toEqual({ phase: 'catalog-open' })
  const catalog = page.getByRole('dialog', { name: 'Select medication', exact: true })
  await expect(catalog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(catalog).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new Event('responsive-catalog-dismissed')))
  await page.waitForFunction(() => JSON.parse(atob(document.title)).phase === 'navigation-ready')
  await page.getByRole('button', { name: 'Navigation', exact: true }).click()
  const navigation = page.getByRole('dialog', { name: 'Navigation', exact: true })
  await expect(navigation).toBeVisible()
  await expect(navigation.getByRole('link', { name: 'Cases', exact: true })).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('responsive-navigation-opened')))
  await page.waitForFunction(() => JSON.parse(atob(document.title)).phase === 'complete')
  const completed = await page.evaluate(() => JSON.parse(atob(document.title)))
  const actual = z
    .object({
      steps: z.array(
        z.object({
          width: z.number(),
          surfaceWidth: z.number(),
          workspaceWidth: z.number(),
          compact: z.boolean(),
          draft: z.string(),
          recordDraft: z.string(),
          recordFocused: z.boolean(),
          recordWidth: z.number(),
          recordBounded: z.boolean(),
          queueAlongside: z.boolean(),
          queueOverlayClosed: z.boolean(),
          queueSwitch: z.boolean(),
          asideAbsent: z.boolean(),
        }),
      ),
      navigationVisible: z.boolean(),
      catalogClosed: z.boolean(),
      catalogWidth: z.number(),
    })
    .parse(completed)
  expect(actual.steps.map(({ width, draft, recordDraft }) => ({ width, draft, recordDraft }))).toEqual(
    [1400, 640, 360, 1024].map((width) => ({
      width,
      draft: 'retained draft',
      recordDraft: 'retained case draft',
    })),
  )
  expect(actual.steps.some(step => step.workspaceWidth >= 800)).toBe(true)
  expect(actual.steps.some(step => step.workspaceWidth < 800)).toBe(true)
  for (const step of actual.steps) {
    expect(step.compact).toBe(step.surfaceWidth < 768)
    expect(step.recordFocused).toBe(true)
    expect(step.recordBounded).toBe(true)
    expect(step.queueSwitch).toBe(true)
    expect(step.asideAbsent).toBe(true)
    // 800px 以下队列收起为浮层，主卡占满宽度；宽屏队列在主卡左侧。
    if (step.workspaceWidth < 800) {
      expect(step.recordWidth).toBeGreaterThanOrEqual(step.workspaceWidth - 40)
      expect(step.queueOverlayClosed).toBe(true)
    } else {
      expect(step.queueAlongside).toBe(true)
    }
  }
  expect(actual.catalogWidth).toBeGreaterThan(1000)
  expect(actual.catalogClosed).toBe(true)
  expect(actual.navigationVisible).toBe(true)
})
