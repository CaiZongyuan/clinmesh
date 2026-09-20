import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { readJsonFromHeadlessChrome } from '../../../../scripts/headless-browser.ts'

const require = createRequire(import.meta.url)

const dialogResultSchema = z.object({
  inputFound: z.boolean(),
  calls: z.array(z.tuple([z.string(), z.number()])),
  selectionStates: z.array(z.string().nullable()),
  confirmDisabled: z.array(z.boolean()),
  confirmations: z.number(),
  catalogHighlighted: z.boolean().optional(),
  productHighlighted: z.boolean().optional(),
  packageHighlighted: z.boolean().optional(),
})

it.each(['18', '19'])('opens clinical catalog dialogs, toggles selection and debounces search with React %s', async version => {
  const react = version === '18' ? 'react18' : 'react'
  const reactDom = version === '18' ? 'react-dom18' : 'react-dom'
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic', jsxDev: false },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    resolve: { alias: [
      { find: /^react$/, replacement: require.resolve(react) },
      { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
      { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) },
      { find: /^react-dom$/, replacement: require.resolve(reactDom) },
    ] },
    build: {
      write: false,
      lib: { entry: fileURLToPath(new URL('./catalog-dialogs.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'CatalogDialogsContract' },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => {
    if (!('output' in output)) throw new Error('Unexpected browser build watcher')
    return output.output
  })
  const script = outputs.find(output => output.type === 'chunk')
  const css = outputs.filter(output => output.type === 'asset' && output.fileName.endsWith('.css'))
    .map(output => output.type === 'asset' ? String(output.source) : '').join('\n')
  if (!script || script.type !== 'chunk') throw new Error('Missing browser script')
  const response = await readJsonFromHeadlessChrome(
    `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><script>window.onerror = message => { document.title = btoa(JSON.stringify({ error: String(message) })) }</script><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>`,
    8000,
  )
  const failure = z.object({ error: z.string() }).safeParse(response)
  if (failure.success) throw new Error(failure.data.error)
  const actual = z.object({
    diagnosis: dialogResultSchema,
    laboratory: dialogResultSchema,
    medication: dialogResultSchema,
    windowErrors: z.array(z.string()),
  }).parse(response)
  expect(actual.windowErrors).toEqual([])
  for (const dialog of [actual.diagnosis, actual.laboratory, actual.medication]) {
    expect(dialog.inputFound).toBe(true)
    expect(dialog.selectionStates).toEqual(['false', 'true', 'false', 'true'])
    expect(dialog.confirmDisabled).toEqual([true, false, true, false])
    expect(dialog.confirmations).toBe(1)
  }
  expect(actual.diagnosis.calls).toEqual([['', 1]])
  expect(actual.laboratory.calls).toEqual([['', 1], ['血常规', 1]])
  expect(actual.medication.calls).toEqual([['', 1]])
  expect(actual.diagnosis.catalogHighlighted).toBe(true)
  expect(actual.medication.catalogHighlighted).toBe(true)
  expect(actual.medication.productHighlighted).toBe(true)
  expect(actual.medication.packageHighlighted).toBe(true)
}, 30_000)
