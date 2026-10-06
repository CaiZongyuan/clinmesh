import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '@playwright/test'
import { z } from 'zod'
import { readJsonFromBrowser } from '../../../../scripts/browser-contract.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
for (const version of ['18', '19']) {
  test(`scrolls only the active doctor section while preserving the header on React ${version}`, async ({ page }) => {
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
        entry: fileURLToPath(new URL('./doctor-section-scroll.browser.fixture.tsx', import.meta.url)),
        formats: ['iife'], name: 'DoctorSectionScroll',
      } },
    })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : [])
    const script = outputs.find(output => output.type === 'chunk')
    if (script?.type !== 'chunk') throw new Error('Missing doctor section scroll fixture')
    const css = await buildSurfaceStyles()
    await page.setViewportSize({ width: 1200, height: 900 })
    const steps = z.array(z.object({ width: z.number(), height: z.number(), section: z.string(), checklistBetweenPatientAndVitals: z.boolean(), checklistBounded: z.boolean(), checklistHorizontal: z.boolean(), checklistEqualWidths: z.boolean(), checklistFullyVisible: z.boolean(), panelScrolled: z.boolean(), endVisible: z.boolean(), headerStable: z.boolean(), panelBounded: z.boolean() }))
      .parse(await readJsonFromBrowser(page, `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>`))
    expect(steps).toHaveLength(12)
    for (const step of steps) {
      expect(step, `${step.section} ${step.width} x ${step.height}`).toMatchObject({ checklistBetweenPatientAndVitals: true, checklistBounded: true, checklistHorizontal: true, checklistEqualWidths: true, checklistFullyVisible: true, panelScrolled: true, endVisible: true, headerStable: true, panelBounded: true })
    }
  })
}
