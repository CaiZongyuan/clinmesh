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
            '../../../../vendor/dsh-react-surface/packages/runtime/src/client/index.tsx',
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
      controlInHeader: z.boolean(),
      hasTopToolbar: z.boolean(),
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
        brandsBeforeOpen: z.array(z.string()),
        brandsAfterClose: z.array(z.string()),
        collapsed: z.object({ hidden: z.boolean(), sidebarActive: z.boolean(), right: z.string(), expandable: z.boolean(), fileHidden: z.boolean() }),
        retainedCollapse: z.boolean(),
        expanded: state.extend({ nativeDraft: z.string(), selectedFile: z.string(), scrollTop: z.number(), nativeVisible: z.boolean() }),
        closedRestored: z.boolean(),
        menuAboveWorkspace: z.boolean(),
        fullscreenFileAboveWorkspace: z.boolean(),
        floatingFileAboveWorkspace: z.boolean(),
        collapseReachableAfterFileExit: z.boolean(),
        floatsHidden: z.boolean(),
        floatsRestored: z.boolean(),
        floatsReleased: z.boolean(),
        overlayRestored: z.boolean(),
        unmountedRestored: z.boolean(),
        firstFileWidth: z.number(),
        retainedFileWidth: z.number(),
        preexistingFileWidth: z.number(),
        fullscreenFileWidth: z.number(),
      })
      .parse(response)
    expect(actual.initial).toMatchObject({
      controlInHeader: true,
      hasTopToolbar: false,
      mode: 'workspace',
      hiddenNative: false,
      conversationWidth: 392,
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
    expect(actual.brandsBeforeOpen).toEqual(['sidebar.brand.mark', 'sidebar.brand.name'])
    expect(actual.brandsAfterClose).toEqual(actual.brandsBeforeOpen)
    expect(actual.collapsed).toEqual({ hidden: true, sidebarActive: true, right: '0px', expandable: true, fileHidden: true })
    expect(actual.retainedCollapse).toBe(true)
    expect(actual.expanded).toMatchObject({ ...actual.initial, nativeDraft: 'kept native draft', selectedFile: 'synthetic.txt', scrollTop: 120, nativeVisible: true })
    expect(actual.closedRestored).toBe(true)
    expect(actual.menuAboveWorkspace).toBe(true)
    expect(actual.fullscreenFileAboveWorkspace).toBe(true)
    expect(actual.floatingFileAboveWorkspace).toBe(true)
    expect(actual.collapseReachableAfterFileExit).toBe(true)
    expect(actual.floatsHidden).toBe(true)
    expect(actual.floatsRestored).toBe(true)
    expect(actual.floatsReleased).toBe(true)
    expect(actual.overlayRestored).toBe(true)
    expect(actual.unmountedRestored).toBe(true)
    expect(actual.firstFileWidth).toBe(360)
    expect(actual.retainedFileWidth).toBe(410)
    expect(actual.preexistingFileWidth).toBe(922)
    expect(actual.fullscreenFileWidth).toBe(922)
  } finally {
    await browser.close()
  }
}, 30_000)
