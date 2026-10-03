import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { ctWindowPresets, windowedGray } from '../../../../packages/core/src/imaging-display.ts'
import {
  formatMagnification,
  magnificationAt,
  selectPyramidLevel,
} from '../../../../packages/core/src/imaging-pyramid.ts'
import { build } from 'vite'
import { expect, test } from '@playwright/test'
import { z } from 'zod'
import { readJsonFromBrowser } from '../../../../scripts/browser-contract.ts'

const require = createRequire(import.meta.url)
const lung = ctWindowPresets.find(preset => preset.id === 'lung')!
const mediastinum = ctWindowPresets.find(preset => preset.id === 'mediastinum')!
const firstFrame = [-1350, -600, 150, 3071, -160, 40, 240, -1024]

/** 把一个浏览器 fixture 连同指定版本的 React 打成单个脚本，放进不依赖网络的页面。 */
async function fixturePage(fixture: string, version: string): Promise<string> {
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
        entry: fileURLToPath(new URL(fixture, import.meta.url)),
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
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>window.onerror = message => { document.title = btoa(JSON.stringify({ error: String(message) })) }</script><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>`
}

for (const version of ['18', '19']) {
  test(`renders CT and radiograph pixels by the shared display rules with React ${version}`, async ({ page }) => {
    test.setTimeout(60_000)
    const response = await readJsonFromBrowser(page, await fixturePage('./imaging-viewer.browser.fixture.tsx', version))
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
      wheelFrameLabel: z.string(),
      wheelPrevented: z.boolean(),
    }).parse(response)

    // 浏览器 canvas 上的灰度与 Node 中同一组纯函数的结果逐像素一致。
    expect(actual.size).toEqual({ height: 2, width: 4 })
    expect(actual.lung).toEqual(firstFrame.map(value => windowedGray(value, lung)))
    expect(actual.mediastinum).toEqual(firstFrame.map(value => windowedGray(value, mediastinum)))
    // 第三层全部为 40 HU：层面顺序按读取描述，切层后显示的是该层像素。
    expect(actual.lastFrameMediastinum).toEqual(Array.from({ length: 8 }, () => windowedGray(40, mediastinum)))
    expect(actual.frameLabel).toBe('Im 3 / 3')
    expect(actual.wheelPrevented).toBe(true)
    expect(actual.wheelFrameLabel).toBe('Im 2 / 3')
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
  })
}

// 与 fixture 中的合成金字塔一致：20×、10× 之后跳到约 2.25×。
const slideLevels = [
  { height: 704, micronsPerPixel: 0.5, tileHeight: 256, tileWidth: 256, width: 992 },
  { height: 352, micronsPerPixel: 1, tileHeight: 256, tileWidth: 256, width: 496 },
  { height: 80, micronsPerPixel: 4.4, tileHeight: 128, tileWidth: 128, width: 112 },
]
/** fixture 的瓦片颜色：红色分量区分颜色组与层级，绿色区分列，蓝色区分行。 */
const tileColor = (family: number, level: number, column: number, row: number) => [30 + 70 * family + 20 * level, 40 + 50 * column, 40 + 60 * row]
const rgbSchema = z.tuple([z.number(), z.number(), z.number()])
const censusSchema = z.object({ families: z.tuple([z.number(), z.number(), z.number()]), magenta: z.number(), opaque: z.number() })

for (const version of ['18', '19']) {
  test(`renders slide pyramid tiles at their positions and drops stale tiles with React ${version}`, async ({ page }) => {
    test.setTimeout(90_000)
    const html = await fixturePage('./imaging-pyramid.browser.fixture.tsx', version)
    // OpenSeadragon 的缩放动画与瓦片调度按真实渲染帧推进：固定视口，并给整个场景长于通用读取的等待时间。
    await page.setViewportSize({ height: 600, width: 800 })
    await page.setContent(html)
    await page.waitForFunction(() => document.title.length > 0, undefined, { timeout: 45_000 })
    const response: unknown = JSON.parse(Buffer.from(await page.title(), 'base64').toString('utf8'))
    const failure = z.object({ error: z.string() }).safeParse(response)
    if (failure.success) throw new Error(failure.data.error)
    const actual = z.object({
      caseAborted: z.boolean(),
      caseCensus: censusSchema,
      colorNote: z.boolean(),
      devicePixelRatio: z.number(),
      directRequests: z.number(),
      errors: z.array(z.string()),
      firstPaths: z.array(z.string()),
      frameShown: z.number(),
      heldAborted: z.boolean(),
      heldBeforeSwitch: z.number(),
      heldPeak: z.number(),
      home: z.object({ offsetX: z.number(), offsetY: z.number(), scale: z.number() }),
      homeCensus: censusSchema,
      homeReadout: z.string(),
      homeSamples: z.array(z.object({ column: z.number(), level: z.number(), rgb: rgbSchema, row: z.number() })),
      navigatorCenter: rgbSchema,
      peak: z.number(),
      resourceRequests: z.number(),
      staleRequestsAfterSwitch: z.number(),
      summary: z.string(),
      switchCenter: z.boolean(),
      switchCensus: censusSchema,
      viewerRemoved: z.boolean(),
      wheelPrevented: z.boolean(),
      zoomSteps: z.array(z.object({ column: z.number(), level: z.number(), readout: z.string(), row: z.number(), scale: z.number() })),
    }).parse(response)
    const near = (rgb: number[], expected: number[]) => rgb.every((value, index) => Math.abs(value - expected[index]!) <= 12)

    expect(actual.errors).toEqual([])
    expect(actual.devicePixelRatio).toBe(1)
    // 瓦片只经外壳的 loadBlock 读取：阅片器没有自行发起任何请求，路径由登记条目生成。
    expect(actual.directRequests).toBe(0)
    expect(actual.resourceRequests).toBe(0)
    expect(actual.firstPaths.every(path => /^series\/0\/levels\/[0-2]\/tiles\/\d+\/\d+$/.test(path))).toBe(true)
    expect(actual.firstPaths).toContain('series/0/levels/2/tiles/0/0')
    expect(actual.summary).toBe('SM · 切片 A1 · 最高 20×')
    expect(actual.colorNote).toBe(true)

    // 首屏完整显示切片：显示的层级与 core 的层级选择一致，该层每个瓦片的中心像素都是该瓦片的颜色。
    const homeLevel = selectPyramidLevel(slideLevels, actual.home.scale)
    expect(homeLevel).toBe(1)
    expect(actual.homeSamples.map(sample => [sample.level, sample.column, sample.row])).toEqual([[1, 0, 0], [1, 1, 0], [1, 0, 1], [1, 1, 1]])
    for (const sample of actual.homeSamples) {
      expect(near(sample.rgb, tileColor(0, sample.level, sample.column, sample.row)), JSON.stringify(sample)).toBe(true)
    }
    expect(actual.homeReadout).toBe(formatMagnification(magnificationAt(0.5, actual.home.scale)))
    // 不透明像素只来自第一张切片，面积等于切片在屏幕上的面积；边缘瓦片的填充部分被裁掉。
    // JPEG 色度上采样会让填充色渗入有效范围最外侧一两列像素，因此图像右缘允许不超过 0.5% 的偏色像素。
    expect(actual.homeCensus.magenta).toBe(0)
    expect(actual.homeCensus.families[1] + actual.homeCensus.families[2]).toBeLessThan(actual.homeCensus.opaque * 0.005)
    const shownArea = 992 * 704 * actual.home.scale ** 2
    expect(Math.abs(actual.homeCensus.opaque - shownArea) / shownArea).toBeLessThan(0.02)
    // 导航小图显示同一张切片。
    expect(actual.navigatorCenter[0]).toBeLessThan(85)
    expect(actual.navigatorCenter[2]).toBeLessThan(200)
    expect(actual.frameShown).toBe(1)

    // 连续缩放：倍率读数由像素间距换算，放大到第 0 层像素后停在 20×，此时视图中心是第 0 层第 1 列第 1 行的瓦片。
    const firstZoom = Math.min(1, actual.home.scale * 2)
    expect(actual.zoomSteps.map(step => [step.readout, step.level, step.column, step.row])).toEqual([
      [formatMagnification(magnificationAt(0.5, firstZoom)), selectPyramidLevel(slideLevels, firstZoom), 1, 1],
      ['20×', 0, 1, 1],
    ])
    expect(actual.zoomSteps[1]!.scale).toBe(1)
    expect(actual.wheelPrevented).toBe(true)

    // 并发上限：主视图与导航小图合计最多六个瓦片请求。
    expect(actual.peak).toBeLessThanOrEqual(6)
    expect(actual.heldPeak).toBe(6)
    expect(actual.heldBeforeSwitch).toBe(6)
    // 切换切片：旧请求被取消且不再发起，迟到的旧瓦片不显示。
    expect(actual.heldAborted).toBe(true)
    expect(actual.staleRequestsAfterSwitch).toBe(0)
    expect(actual.switchCenter).toBe(true)
    expect(actual.switchCensus.families[0] + actual.switchCensus.magenta).toBe(0)
    expect(actual.switchCensus.families[1]).toBeGreaterThan(actual.switchCensus.opaque * 0.995)
    // 切换病例：同上。
    expect(actual.caseAborted).toBe(true)
    expect(actual.caseCensus.families[0] + actual.caseCensus.families[1] + actual.caseCensus.magenta).toBe(0)
    expect(actual.caseCensus.families[2]).toBe(actual.caseCensus.opaque)
    expect(actual.viewerRemoved).toBe(true)
  })
}
