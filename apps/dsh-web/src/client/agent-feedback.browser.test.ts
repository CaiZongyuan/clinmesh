import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '@playwright/test'
import { z } from 'zod'
import { readJsonFromBrowser } from '../../../../scripts/browser-contract.ts'

const require = createRequire(import.meta.url)

const configurations = ['18', '19'].flatMap(version => [false, true].map(reduced => ({ version, reduced, webgl: true })))
configurations.push({ version: '19', reduced: false, webgl: false })
for (const { version, reduced, webgl } of configurations) {
  test(`preserves editing and static human review on React ${version}, reduced motion=${reduced}, WebGL=${webgl}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' })
    if (!webgl) await page.evaluate(() => {
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { value: () => null })
    })
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
        entry: fileURLToPath(new URL('./agent-feedback.browser.fixture.tsx', import.meta.url)),
        formats: ['iife'], name: 'AgentFeedbackContract',
      } },
    })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => {
      if (!('output' in output)) throw new Error('Unexpected browser watcher')
      return output.output
    })
    const script = outputs.find(output => output.type === 'chunk')
    const css = outputs.filter(output => output.type === 'asset' && output.fileName.endsWith('.css'))
      .map(output => output.type === 'asset' ? String(output.source) : '').join('\n')
    if (script?.type !== 'chunk') throw new Error('Missing browser script')
    const response = await readJsonFromBrowser(page, `<!doctype html><html><head><style>${css}</style></head><body><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    expect(response).not.toHaveProperty('error')
    const actual = z.object({ focused: z.boolean(), highlighted: z.boolean(), aligned: z.boolean(), runningAnimation: z.string(),
      canvasRunning: z.boolean(), darkThemeUpdated: z.boolean(), canvasResized: z.boolean(), ambientAligned: z.boolean(), canvasStopped: z.boolean(), canvasDisposed: z.boolean(),
      ambientHeld: z.boolean(), retainedCanvas: z.boolean(), fastCompleted: z.boolean(), fastCanvasSized: z.boolean(), fastCanvasResized: z.boolean(), fastHeld: z.boolean(), fastStatic: z.boolean(),
      held: z.boolean(), faded: z.boolean(), waiting: z.boolean(), staticWaiting: z.boolean(), staticSubmitting: z.boolean(), staticApproved: z.boolean(), staticRejected: z.boolean(), committed: z.boolean(), approved: z.boolean(),
      consultationRegion: z.boolean(), consultationFormExcluded: z.boolean(), newDoctorBubble: z.boolean(), newPatientBubble: z.boolean(), oldMessageUnchanged: z.boolean(),
      onlyChangedRecordField: z.boolean(), completedRecordField: z.boolean(), sectionInset: z.boolean(),
    }).parse(response)
    expect(actual).toEqual({ focused: true, highlighted: true, aligned: true, runningAnimation: 'none',
      canvasRunning: true, darkThemeUpdated: true, canvasResized: true, ambientAligned: true, canvasStopped: true, canvasDisposed: true,
      ambientHeld: true, retainedCanvas: true, fastCompleted: true, fastCanvasSized: true, fastCanvasResized: true, fastHeld: true, fastStatic: true,
      held: true, faded: true, waiting: true, staticWaiting: true, staticSubmitting: true, staticApproved: true, staticRejected: true, committed: true, approved: true,
      consultationRegion: true, consultationFormExcluded: true, newDoctorBubble: true, newPatientBubble: true, oldMessageUnchanged: true,
      onlyChangedRecordField: true, completedRecordField: true, sectionInset: true,
    })
  })
}
