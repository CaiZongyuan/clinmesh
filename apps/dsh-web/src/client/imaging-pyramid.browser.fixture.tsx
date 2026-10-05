import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { ImagingSeriesView, ImagingStudyView } from '@clinmesh/contracts/imaging'
import {
  formatMagnification,
  imageToLevel,
  magnificationAt,
  maxScreenScale,
  selectPyramidLevel,
  tileAtLevelPoint,
  tileGrid,
  tileRegion,
} from '../../../../packages/core/src/imaging-pyramid.ts'
import { ImagingViewer, type ImagingViewerSource } from '../../../web/src/app/imaging/imaging-viewer.tsx'
import { createStyledRoot } from './styled-root.ts'

type PyramidSeries = Extract<ImagingSeriesView, { kind: 'tiled-pyramid' }>
type Rgb = [number, number, number]

// 合成 20× 金字塔：10× 之后跳到约 2.25×，最低层两轴降采样倍数不同（992/112 与 704/80）。
const levels: PyramidSeries['levels'] = [
  { height: 704, magnification: 20, micronsPerPixel: 0.5, tileHeight: 256, tileWidth: 256, width: 992 },
  { height: 352, magnification: 10, micronsPerPixel: 1, tileHeight: 256, tileWidth: 256, width: 496 },
  { height: 80, magnification: 2.25, micronsPerPixel: 4.4, tileHeight: 128, tileWidth: 128, width: 112 },
]
const imageCenter = { x: levels[0]!.width / 2, y: levels[0]!.height / 2 }
const slide = (slideLabel: string): PyramidSeries => ({ colorManaged: false, kind: 'tiled-pyramid', levels, modality: 'SM', slideLabel, tileFormat: 'jpeg' })
const study = (studyId: string): ImagingStudyView => ({
  available: true,
  examCode: 'breast-slide-consultation',
  series: [slide('A1'), slide('A2')],
  studyId,
})

/** 每个瓦片一种均匀颜色：红色分量区分颜色组与层级，绿色区分列，蓝色区分行。 */
function tileColor(family: number, level: number, column: number, row: number): Rgb {
  return [30 + 70 * family + 20 * level, 40 + 50 * column, 40 + 60 * row]
}

const tileCache = new Map<string, Promise<Uint8Array>>()
/** 按完整瓦片尺寸编码 JPEG；超出层级范围的填充部分为品红，显示时必须被裁掉。 */
function tileBytes(family: number, level: number, column: number, row: number): Promise<Uint8Array> {
  const key = `${family}/${level}/${column}/${row}`
  const cached = tileCache.get(key)
  if (cached !== undefined) return cached
  const target = levels[level]!
  const canvas = document.createElement('canvas')
  canvas.width = target.tileWidth
  canvas.height = target.tileHeight
  const context = canvas.getContext('2d')!
  context.fillStyle = 'rgb(255, 0, 255)'
  context.fillRect(0, 0, canvas.width, canvas.height)
  const [red, green, blue] = tileColor(family, level, column, row)
  context.fillStyle = `rgb(${red}, ${green}, ${blue})`
  context.fillRect(0, 0, Math.min(target.tileWidth, target.width - column * target.tileWidth), Math.min(target.tileHeight, target.height - row * target.tileHeight))
  const bytes = new Promise<Uint8Array>((resolve, reject) => canvas.toBlob((blob) => {
    if (blob === null) reject(new Error('JPEG encoding failed'))
    else void blob.arrayBuffer().then(buffer => resolve(new Uint8Array(buffer)))
  }, 'image/jpeg', 0.95))
  tileCache.set(key, bytes)
  return bytes
}

function position(path: string) {
  const match = /^series\/(\d+)\/levels\/(\d+)\/tiles\/(\d+)\/(\d+)$/.exec(path)
  if (match === null) throw new Error(`Unexpected tile path ${path}`)
  const [, series, level, column, row] = match.map(Number)
  return { column: column!, level: level!, row: row!, series: series! }
}

const settle = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))
async function waitFor(label: string, predicate: () => boolean, timeout = 10_000) {
  for (let waited = 0; !predicate(); waited += 25) {
    if (waited > timeout) throw new Error(`Timed out waiting for ${label}`)
    await settle(25)
  }
}

async function run() {
  const errors: string[] = []
  window.addEventListener('error', event => errors.push(String(event.message)))
  window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
  // 瓦片只能经 loadBlock 读取：阅片器自己发起的任何网络请求都会被记录。
  let directRequests = 0
  const originalFetch = window.fetch
  window.fetch = ((...args: Parameters<typeof fetch>) => { directRequests += 1; return originalFetch(...args) }) as typeof fetch
  const originalOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['open']>) {
    directRequests += 1
    return originalOpen.apply(this, args)
  } as XMLHttpRequest['open']

  const host = document.createElement('div')
  host.style.cssText = 'width: 800px; height: 700px;'
  document.body.append(host)
  const { root: container } = createStyledRoot(host)
  const root = createRoot(container)
  const viewport = () => container.querySelector<HTMLElement>('[data-slide-viewport]')!
  const canvases = () => [...viewport().querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)
  const readout = () => container.querySelector('[data-slide-magnification]')?.textContent ?? ''
  const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)!
  const rgbAt = (canvas: HTMLCanvasElement, x: number, y: number): Rgb => {
    const [red, green, blue] = canvas.getContext('2d')!.getImageData(Math.round(x), Math.round(y), 1, 1).data
    return [red!, green!, blue!]
  }
  const near = (actual: Rgb, expected: Rgb) => actual.every((value, index) => Math.abs(value - expected[index]!) <= 12)
  // 主视图 canvas 上所有不透明像素中，红色分量落在某个颜色组范围内的像素数，以及品红填充像素数。
  const census = () => {
    const canvas = canvases()[0]!
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    const families = [0, 0, 0]
    let magenta = 0
    let opaque = 0
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] !== 255) continue
      opaque += 1
      const [red, green, blue] = [data[index]!, data[index + 1]!, data[index + 2]!]
      if (red > 200 && green < 90 && blue > 200) magenta += 1
      else if (red < 85) families[0]! += 1
      else if (red < 155) families[1]! += 1
      else families[2]! += 1
    }
    return { families, magenta, opaque }
  }
  // 当前视图的屏幕比例：复位后图像在显示区内等比完整显示并居中。
  const homeView = () => {
    const { clientHeight, clientWidth } = viewport()
    const scale = Math.min(clientWidth / levels[0]!.width, clientHeight / levels[0]!.height)
    return { offsetX: (clientWidth - levels[0]!.width * scale) / 2, offsetY: (clientHeight - levels[0]!.height * scale) / 2, scale }
  }
  // 以图像中心为缩放中心时，图像点在 canvas 上的设备像素坐标。
  const toCanvas = (scale: number, point: { x: number; y: number }) => {
    const { clientHeight, clientWidth } = viewport()
    return {
      x: (clientWidth / 2 + (point.x - levels[0]!.width / 2) * scale) * devicePixelRatio,
      y: (clientHeight / 2 + (point.y - levels[0]!.height / 2) * scale) * devicePixelRatio,
    }
  }
  const centerTile = (scale: number) => {
    const level = selectPyramidLevel(levels, scale * devicePixelRatio)
    const tile = tileAtLevelPoint(levels[level]!, imageToLevel(levels, level, imageCenter))
    return { level, ...tile }
  }
  const centerMatches = (family: number, scale: number) => {
    const { column, level, row } = centerTile(scale)
    const point = toCanvas(scale, imageCenter)
    return near(rgbAt(canvases()[0]!, point.x, point.y), tileColor(family, level, column, row))
  }

  // 一、首屏：层级选择、瓦片位置、边缘裁切、导航小图、倍率读数、并发上限与缩放上限。
  let frameShown = 0
  let active = 0
  let peak = 0
  const firstPaths: string[] = []
  const firstSource: ImagingViewerSource = {
    loadBlock: async (path) => {
      firstPaths.push(path)
      active += 1
      peak = Math.max(peak, active)
      await settle(5)
      active -= 1
      const tile = position(path)
      return await tileBytes(tile.series, tile.level, tile.column, tile.row)
    },
    study: study('slide-study-1'),
  }
  flushSync(() => root.render(<ImagingViewer key="first" locale="zh-CN" onFrameShown={() => { frameShown += 1 }} source={firstSource} />))
  const home = homeView()
  const homeLevel = selectPyramidLevel(levels, home.scale * devicePixelRatio)
  await waitFor('first slide', () => frameShown === 1 && readout() === formatMagnification(magnificationAt(0.5, home.scale)))
  const homeSamples = []
  const { columns, rows } = tileGrid(levels[homeLevel]!)
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const region = tileRegion(levels, homeLevel, { column, row })
      const point = toCanvas(home.scale, { x: region.x + region.width / 2, y: region.y + region.height / 2 })
      homeSamples.push({ column, level: homeLevel, rgb: rgbAt(canvases()[0]!, point.x, point.y), row })
    }
  }
  const homeCensus = census()
  const navigator = canvases()[1]!
  const navigatorCenter = rgbAt(navigator, navigator.width / 2, navigator.height / 2)
  const homeReadout = readout()
  const summary = [...container.querySelectorAll('span')].map(item => item.textContent).find(text => text?.startsWith('SM')) ?? ''
  const colorNote = container.textContent?.includes('未做颜色管理') === true

  const zoomSteps = []
  for (const factor of [2, 4]) {
    const scale = Math.min(home.scale * factor, maxScreenScale(0.5))
    button('放大').click()
    await waitFor(`zoom ×${factor}`, () => readout() === formatMagnification(magnificationAt(0.5, scale)) && centerMatches(0, scale))
    zoomSteps.push({ readout: readout(), ...centerTile(scale), scale })
  }
  button('复位').click()
  await waitFor('home again', () => readout() === homeReadout && centerMatches(0, home.scale))
  // 滚轮缩放阻止默认滚动，页面与 DSH 宿主不随之滚动。
  const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 400, clientY: 200, deltaY: -100 })
  viewport().querySelector('.openseadragon-canvas')!.dispatchEvent(wheel)

  // 二、切片切换：第一张切片的请求全部挂起，并发数停在上限；切换后旧请求被取消，迟到的旧瓦片不显示。
  const held: Array<{ path: string; release(): void; signal: AbortSignal }> = []
  let heldActive = 0
  let heldPeak = 0
  let staleRequestsAfterSwitch = 0
  let switched = false
  const switchSource: ImagingViewerSource = {
    loadBlock: async (path, signal) => {
      const tile = position(path)
      if (tile.series === 1) return await tileBytes(1, tile.level, tile.column, tile.row)
      if (switched) staleRequestsAfterSwitch += 1
      heldActive += 1
      heldPeak = Math.max(heldPeak, heldActive)
      const bytes = await tileBytes(0, tile.level, tile.column, tile.row)
      return await new Promise<Uint8Array>(resolve => held.push({ path, release: () => resolve(bytes), signal }))
    },
    study: study('slide-study-2'),
  }
  flushSync(() => root.render(<ImagingViewer key="switch" locale="zh-CN" source={switchSource} />))
  await waitFor('held requests', () => held.length >= 6)
  await settle(400)
  const heldBeforeSwitch = held.length
  switched = true
  button('序列 2').click()
  await waitFor('second slide', () => centerMatches(1, home.scale))
  for (const request of held) request.release()
  await settle(500)
  const switchCensus = census()
  const switchCenter = centerMatches(1, home.scale)

  // 三、切换病例：前一病例挂起的请求被取消，迟到的旧瓦片不显示在新病例中。
  const caseHeld: Array<{ release(): void; signal: AbortSignal }> = []
  flushSync(() => root.render(<ImagingViewer key="case-a" locale="zh-CN" source={{
    loadBlock: async (path, signal) => {
      const tile = position(path)
      const bytes = await tileBytes(0, tile.level, tile.column, tile.row)
      return await new Promise<Uint8Array>(resolve => caseHeld.push({ release: () => resolve(bytes), signal }))
    },
    study: study('slide-study-a'),
  }} />))
  await waitFor('held case requests', () => caseHeld.length >= 1)
  flushSync(() => root.render(<ImagingViewer key="case-b" locale="zh-CN" source={{
    loadBlock: async (path) => {
      const tile = position(path)
      return await tileBytes(2, tile.level, tile.column, tile.row)
    },
    study: study('slide-study-b'),
  }} />))
  await waitFor('new case', () => centerMatches(2, home.scale))
  for (const request of caseHeld) request.release()
  await settle(500)
  const caseCensus = census()

  // 四、读取失败时提示并可重试。
  let failing = true
  flushSync(() => root.render(<ImagingViewer key="failing" locale="zh-CN" source={{
    loadBlock: async (path) => {
      if (failing) throw new Error('tile unavailable')
      const tile = position(path)
      return await tileBytes(0, tile.level, tile.column, tile.row)
    },
    study: study('slide-study-failing'),
  }} />))
  await waitFor('failure alert', () => container.querySelector('[role="alert"]')?.textContent?.includes('切片读取失败') === true)
  failing = false
  button('重试').click()
  await waitFor('retried slide', () => container.querySelector('[role="alert"]') === null && centerMatches(0, home.scale))

  flushSync(() => root.render(<></>))
  const result = {
    caseAborted: caseHeld.every(request => request.signal.aborted),
    caseCensus,
    colorNote,
    devicePixelRatio,
    directRequests,
    errors,
    firstPaths,
    frameShown,
    heldAborted: held.every(request => request.signal.aborted),
    heldBeforeSwitch,
    heldPeak,
    home,
    homeCensus,
    homeReadout,
    homeSamples,
    navigatorCenter,
    peak,
    resourceRequests: performance.getEntriesByType('resource').length,
    staleRequestsAfterSwitch,
    summary,
    switchCenter,
    switchCensus,
    viewerRemoved: container.querySelector('canvas') === null,
    wheelPrevented: wheel.defaultPrevented,
    zoomSteps,
  }
  document.title = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(result))))
}

run().catch((error) => {
  document.title = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ error: String(error) }))))
})
