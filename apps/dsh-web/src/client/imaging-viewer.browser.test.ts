import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { ctWindowPresets, windowedGray } from '../../../../packages/core/src/imaging-display.ts'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { readJsonFromHeadlessChrome } from '../../../../scripts/headless-browser.ts'

const require = createRequire(import.meta.url)
const lung = ctWindowPresets.find(preset => preset.id === 'lung')!
const mediastinum = ctWindowPresets.find(preset => preset.id === 'mediastinum')!
const firstFrame = [-1350, -600, 150, 3071, -160, 40, 240, -1024]

it.each(['18', '19'])('renders CT and radiograph pixels by the shared display rules with React %s', async version => {
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
      lib: {
        entry: fileURLToPath(new URL('./imaging-viewer.browser.fixture.tsx', import.meta.url)),
        formats: ['iife'],
        name: 'ImagingViewerContract',
      },
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
    5000,
  )
  const failure = z.object({ error: z.string() }).safeParse(response)
  if (failure.success) throw new Error(failure.data.error)
  const actual = z.object({
    aspect: z.number(),
    frameLabel: z.string(),
    frameShown: z.number(),
    inverted: z.array(z.number()),
    lastFrameMediastinum: z.array(z.number()),
    lung: z.array(z.number()),
    markers: z.array(z.string()),
    mediastinum: z.array(z.number()),
    radiograph: z.array(z.number()),
    radiographSize: z.object({ height: z.number(), width: z.number() }),
    size: z.object({ height: z.number(), width: z.number() }),
    staleAborted: z.boolean(),
    unavailable: z.boolean(),
  }).parse(response)

  // 浏览器 canvas 上的灰度与 Node 中同一组纯函数的结果逐像素一致。
  expect(actual.size).toEqual({ height: 2, width: 4 })
  expect(actual.lung).toEqual(firstFrame.map(value => windowedGray(value, lung)))
  expect(actual.mediastinum).toEqual(firstFrame.map(value => windowedGray(value, mediastinum)))
  // 第三层全部为 40 HU：层面顺序按读取描述，切层后显示的是该层像素。
  expect(actual.lastFrameMediastinum).toEqual(Array.from({ length: 8 }, () => windowedGray(40, mediastinum)))
  expect(actual.frameLabel).toBe('Im 3 / 3')
  // 显示比例按物理间距计算，不按像素数。
  expect(actual.aspect).toBeCloseTo(4, 1)
  expect(actual.frameShown).toBe(1)

  const radiographWindow = { center: 2048, width: 4096 }
  expect(actual.staleAborted).toBe(true)
  expect(actual.radiographSize).toEqual({ height: 2, width: 2 })
  expect(actual.radiograph).toEqual([0, 1024, 3072, 4095].map(value => windowedGray(value, radiographWindow)))
  expect(actual.inverted).toEqual(actual.radiograph.map(gray => 255 - gray))
  // 正位胸片只标左右，不标前后。
  expect(actual.markers).toEqual(['R', 'L'])
  expect(actual.unavailable).toBe(true)
}, 60_000)
