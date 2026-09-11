import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { readJsonFromHeadlessChrome } from '../../../../scripts/headless-browser.ts'

const require = createRequire(import.meta.url)

it.each(['18', '19'])('opens and operates a ShadowRoot menu with React %s', async version => {
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
      lib: { entry: fileURLToPath(new URL('./menu.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'MenuContract' },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => {
    if (!('output' in output)) throw new Error('Unexpected browser build watcher')
    return output.output
  })
  const script = outputs.find(output => output.type === 'chunk')
  if (!script || script.type !== 'chunk') throw new Error('Missing browser script')
  const response = await readJsonFromHeadlessChrome(
    `<!doctype html><html><body><script>window.onerror = message => { document.title = btoa(JSON.stringify({ error: String(message) })) }</script><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>`,
    3000,
  )
  const failure = z.object({ error: z.string() }).safeParse(response)
  if (failure.success) throw new Error(failure.data.error)
  const actual = z.object({
    cycles: z.array(z.object({ visible: z.boolean(), anchored: z.boolean() })),
    closures: z.array(z.boolean()),
    keyboardFocusedItem: z.boolean(),
    selected: z.boolean(), closed: z.boolean(),
  }).parse(response)
  expect(actual).toEqual({
    cycles: [{ visible: true, anchored: true }, { visible: true, anchored: true }],
    closures: [true, true],
    keyboardFocusedItem: true,
    selected: true,
    closed: true,
  })
}, 30_000)
