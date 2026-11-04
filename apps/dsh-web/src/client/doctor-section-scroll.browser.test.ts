import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '@playwright/test'
import { z } from 'zod'
import { readJsonFromBrowser } from '../../../../scripts/browser-contract.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
for (const version of ['18', '19']) {
  test(`keeps doctor content reachable in a single column and its identity stable in columns on React ${version}`, async ({ page }) => {
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
    const resultData = await readJsonFromBrowser(page, `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    const failure = z.object({ error: z.string() }).safeParse(resultData)
    if (failure.success) throw new Error(failure.data.error)
    const { steps, typography, completed } = z.object({
      steps: z.array(z.object({ width: z.number(), height: z.number(), section: z.string(), progressBelowIdentity: z.boolean(), progressBounded: z.boolean(), contentScrolled: z.boolean(), endVisible: z.boolean(), headerStable: z.boolean(), identityReachable: z.boolean(), viewportBounded: z.boolean() })),
      completed: z.array(z.object({ width: z.number(), height: z.number(), clippedBefore: z.boolean(), scrolled: z.boolean(), endVisible: z.boolean(), viewportBounded: z.boolean() })),
      typography: z.array(z.object({ locale: z.string(), fontSize: z.enum(['standard', 'larger', 'large']), width: z.number(), progressFontSize: z.number(), textVisible: z.boolean(), noHorizontalOverflow: z.boolean(), endVisible: z.boolean() })),
    })
      .parse(resultData)
    expect(steps).toHaveLength(12)
    for (const step of steps) {
      expect(step, `${step.section} ${step.width} x ${step.height}`).toMatchObject({ progressBelowIdentity: true, progressBounded: true, contentScrolled: true, endVisible: true, identityReachable: true, viewportBounded: true })
      if (step.width >= 600) expect(step.headerStable, `${step.section} ${step.width} x ${step.height}`).toBe(true)
    }
    expect(typography).toHaveLength(18)
    for (const step of typography) {
      expect(step, `${step.locale} ${step.fontSize} ${step.width}`).toMatchObject({ textVisible: true, noHorizontalOverflow: true, endVisible: true })
      expect(step.progressFontSize).toBeCloseTo(({ standard: 12, larger: 13.5, large: 15 })[step.fontSize], 1)
    }
    expect(completed).toHaveLength(3)
    for (const step of completed) {
      expect(step, `completed ${step.width} x ${step.height}`).toMatchObject({ clippedBefore: true, scrolled: true, endVisible: true, viewportBounded: true })
    }
  })
}
