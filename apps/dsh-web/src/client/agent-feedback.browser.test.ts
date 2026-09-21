import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { readJsonFromHeadlessChrome } from '../../../../scripts/headless-browser.ts'

const require = createRequire(import.meta.url)

it.each(['18', '19'])('preserves editing and human review with action feedback on React %s', async version => {
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
  const response = await readJsonFromHeadlessChrome(`<!doctype html><html><head><style>${css}</style></head><body><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>`, 6000)
  expect(response).not.toHaveProperty('error')
  const actual = z.object({ delayed: z.boolean(), focused: z.boolean(), highlighted: z.boolean(), aligned: z.boolean(), runningAnimation: z.boolean(), held: z.boolean(), faded: z.boolean(), waiting: z.boolean(), staticWaiting: z.boolean(), committed: z.boolean(), approved: z.boolean(),
    consultationRegionExcluded: z.boolean(), consultationFormExcluded: z.boolean(), newDoctorBubble: z.boolean(), newPatientBubble: z.boolean(), oldMessageUnchanged: z.boolean(),
    onlyChangedRecordField: z.boolean(), completedRecordField: z.boolean(), sectionLabelOnly: z.boolean(),
    stableLayout: z.boolean(), inputReachable: z.boolean(), clipped: z.boolean(), scrollAligned: z.boolean(), dialogLayer: z.boolean(),
  }).parse(response)
  expect(actual).toEqual({ delayed: true, focused: true, highlighted: true, aligned: true, runningAnimation: true, held: true, faded: true, waiting: true, staticWaiting: true, committed: true, approved: true,
    consultationRegionExcluded: true, consultationFormExcluded: true, newDoctorBubble: true, newPatientBubble: true, oldMessageUnchanged: true,
    onlyChangedRecordField: true, completedRecordField: true, sectionLabelOnly: true,
    stableLayout: true, inputReachable: true, clipped: true, scrollAligned: true, dialogLayer: true,
  })
}, 30_000)
