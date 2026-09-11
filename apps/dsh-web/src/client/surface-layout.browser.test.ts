import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { findChrome } from '../../../../scripts/headless-browser.ts'

it('returns from manual fullscreen to the retained native split without remounting the application', async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic', jsxDev: false },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        '@clinmesh/web/application': fileURLToPath(
          new URL('./surface-layout.browser.app.tsx', import.meta.url),
        ),
        'dsh-react-surface/client': fileURLToPath(
          new URL(
            '../../../../vendor/dsh-react-surface/packages/runtime/src/client/contracts.ts',
            import.meta.url,
          ),
        ),
      },
    },
    build: {
      write: false,
      lib: {
        entry: fileURLToPath(new URL('./surface-layout.browser.fixture.tsx', import.meta.url)),
        formats: ['iife'],
        name: 'SurfaceContract',
      },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((result) =>
    'output' in result ? result.output : [],
  )
  const script = outputs.find((entry) => entry.type === 'chunk')
  if (!script || script.type !== 'chunk') throw new Error('Missing browser fixture')
  const browser = await chromium.launch({ executablePath: findChrome() })
  try {
    const page = await browser.newPage({ viewport: { width: 2100, height: 900 } })
    await page.setContent(
      `<!doctype html><html><body><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>`,
    )
    await page.waitForFunction(() => document.title !== '')
    const response: unknown = JSON.parse(Buffer.from(await page.title(), 'base64').toString('utf8'))
    const failure = z.object({ error: z.string() }).safeParse(response)
    if (failure.success) throw new Error(failure.data.error)
    const state = z.object({
      mode: z.string(),
      hiddenNative: z.boolean(),
      draft: z.string(),
      conversationWidth: z.number(),
    })
    const actual = z
      .object({
        initial: state,
        fullscreen: state,
        restored: state,
        resized: z.array(state),
        returnVisible: z.boolean(),
      })
      .parse(response)
    expect(actual.initial).toMatchObject({
      mode: 'workspace',
      hiddenNative: false,
      conversationWidth: 400,
    })
    expect(actual.fullscreen).toMatchObject({ mode: 'full-frame', hiddenNative: true })
    expect(actual.returnVisible).toBe(true)
    expect(actual.restored).toEqual(actual.initial)
    expect(
      actual.resized.every(
        (item) =>
          item.mode === 'workspace' && !item.hiddenNative && item.draft === 'kept clinical draft',
      ),
    ).toBe(true)
    expect(actual.resized.at(-1)).toEqual(actual.initial)
  } finally {
    await browser.close()
  }
}, 30_000)
