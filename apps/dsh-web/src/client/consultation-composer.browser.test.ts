import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { chromium } from 'playwright-core'
import { findChrome } from '../../../../scripts/headless-browser.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
it.each(['18', '19'])('keeps the consultation composer visible below scrolling history on React %s', async version => {
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
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    await page.waitForFunction(() => document.title !== '')
    const steps = z.array(z.object({ width: z.number(), height: z.number(), historyScrolled: z.boolean(), composerStable: z.boolean(), composerVisible: z.boolean(), buttonInside: z.boolean(), glowOutside: z.boolean(), buttonHit: z.boolean(), historyHeight: z.number() }))
      .parse(JSON.parse(Buffer.from(await page.title(), 'base64').toString('utf8')))
    expect(steps).toHaveLength(3)
    for (const step of steps) {
      expect(step, `${step.width} x ${step.height}`).toMatchObject({ historyScrolled: true, composerStable: true, composerVisible: true, buttonInside: true, glowOutside: true, buttonHit: true })
      expect(step.historyHeight).toBeGreaterThan(80)
    }
  } finally { await browser.close() }
}, 30_000)
