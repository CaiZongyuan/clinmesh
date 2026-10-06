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
  const actual = z
    .object({
      steps: z.array(
        z.object({
          width: z.number(),
          compact: z.boolean(),
          draft: z.string(),
          recordWidth: z.number(),
          queueSwitch: z.boolean(),
          contextSwitch: z.boolean(),
        }),
      ),
      navigationVisible: z.boolean(),
      catalogWidth: z.number(),
    })
    .parse(response)
  expect(actual.steps.map(({ width, compact, draft }) => ({ width, compact, draft }))).toEqual(
    [1400, 640, 360, 1024].map((width) => ({
      width,
      compact: width < 768,
      draft: 'retained draft',
    })),
  )
  for (const step of actual.steps.filter((step) => step.width <= 640)) {
    expect(step.recordWidth).toBeGreaterThanOrEqual(step.width - 40)
    expect(step.queueSwitch).toBe(true)
    expect(step.contextSwitch).toBe(true)
  }
  expect(actual.catalogWidth).toBeGreaterThan(1000)
  expect(actual.navigationVisible).toBe(true)
})
