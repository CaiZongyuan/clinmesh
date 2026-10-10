import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '@playwright/test'
import { z } from 'zod'
import { readJsonFromBrowser } from '../../../../scripts/browser-contract.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
for (const version of ['18', '19']) {
  test(`keeps the consultation composer visible below scrolling history on React ${version}`, async ({ page }) => {
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
        entry: fileURLToPath(new URL('./consultation-composer.browser.fixture.tsx', import.meta.url)),
        formats: ['iife'], name: 'ConsultationComposer',
      } },
    })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : [])
    const script = outputs.find(output => output.type === 'chunk')
    if (script?.type !== 'chunk') throw new Error('Missing composer fixture')
    const css = await buildSurfaceStyles()
    await page.setViewportSize({ width: 1200, height: 900 })
    const steps = z.array(z.object({ width: z.number(), height: z.number(), historyScrolled: z.boolean(), composerStable: z.boolean(), composerVisible: z.boolean(), buttonInside: z.boolean(), glowOutside: z.boolean(), buttonHit: z.boolean(), historyHeight: z.number(), delegateVisible: z.boolean(), delegateSubmitted: z.boolean(), retryReadable: z.boolean(), retryInteractive: z.boolean() }))
      .parse(await readJsonFromBrowser(page, `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>`))
    expect(steps).toHaveLength(3)
    for (const step of steps) {
      expect(step, `${step.width} x ${step.height}`).toMatchObject({ historyScrolled: true, composerStable: true, composerVisible: true, buttonInside: true, glowOutside: true, buttonHit: true, delegateVisible: true, delegateSubmitted: true, retryReadable: true, retryInteractive: true })
      expect(step.historyHeight).toBeGreaterThan(80)
    }
  })
}
