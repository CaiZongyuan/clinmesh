import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { ImagingStudyView } from '@clinmesh/contracts/imaging'
import { ImagingViewer, type ImagingViewerSource } from '../../../web/src/app/imaging/imaging-viewer.tsx'

/** 灰度堆叠序列的像素块路径：`series/{序列}/frames/{帧}/blocks/{块}`。 */
function position(path: string): { blockIndex: number; frameIndex: number } {
  const [, frameIndex, blockIndex] = /^series\/0\/frames\/(\d+)\/blocks\/(\d+)$/.exec(path)!.map(Number)
  return { blockIndex: blockIndex!, frameIndex: frameIndex! }
}

function bytes(values: number[], signed: boolean): Uint8Array {
  const array = signed ? Int16Array.from(values) : Uint16Array.from(values)
  return new Uint8Array(array.buffer)
}

// 4×2 的三层 CT：每层第一个像素分别是空气、肺与软组织，其余像素覆盖两个窗的两端。
const ctFrames = [
  [-1350, -600, 150, 3071, -160, 40, 240, -1024],
  [-600, -600, -600, -600, -600, -600, -600, -600],
  [40, 40, 40, 40, 40, 40, 40, 40],
]
const ctStudy: ImagingStudyView = {
  available: true,
  examCode: 'chest-ct-plain',
  series: [{
    frames: ctFrames.map((_, index) => ({
      // 每层切成两个按行的像素块。
      blocks: [{ length: 8, rowCount: 1, rowStart: 0 }, { length: 8, rowCount: 1, rowStart: 1 }],
      columns: 4,
      // 行间距 1 mm、列间距 2 mm：物理宽高比为 (4×2)/(2×1) = 4。
      pixelSpacingMm: [1, 2] as [number, number],
      positionMm: -index,
      rows: 2,
    })),
    kind: 'frame-stack',
    modality: 'CT',
    pixelFormat: 'int16',
    valueUnit: 'hu',
  }],
  studyId: 'study-ct',
}
const radiographStudy: ImagingStudyView = {
  available: true,
  examCode: 'chest-radiograph',
  series: [{
    frames: [{
      blocks: [{ length: 8, rowCount: 2, rowStart: 0 }],
      columns: 2,
      pixelSpacingMm: null,
      rows: 2,
      view: 'frontal',
      window: { center: 2048, width: 4096 },
    }],
    kind: 'frame-stack',
    modality: 'DX',
    pixelFormat: 'uint16',
    valueUnit: 'stored',
  }],
  studyId: 'study-radiograph',
}

async function run() {
  const host = document.createElement('div')
  host.style.cssText = 'width: 800px; height: 700px;'
  document.body.append(host)
  const container = host.attachShadow({ mode: 'open' }).appendChild(document.createElement('div'))
  const root = createRoot(container)
  const settle = (milliseconds = 60) => new Promise(resolve => setTimeout(resolve, milliseconds))
  const canvas = () => container.querySelector('canvas')!
  const grays = () => {
    const element = canvas()
    const data = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
    return Array.from({ length: data.length / 4 }, (_, index) => data[index * 4]!)
  }
  const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label)!

  let frameShown = 0
  const ctSource: ImagingViewerSource = {
    loadBlock: async (path) => {
      const { blockIndex, frameIndex } = position(path)
      return bytes(ctFrames[frameIndex]!.slice(blockIndex * 4, blockIndex * 4 + 4), true)
    },
    study: ctStudy,
  }
  flushSync(() => root.render(
    <ImagingViewer key="ct" locale="zh-CN" onFrameShown={() => { frameShown += 1 }} source={ctSource} />,
  ))
  await settle()
  const lung = grays()
  const size = { height: canvas().height, width: canvas().width }
  const rect = canvas().getBoundingClientRect()
  const aspect = rect.width / rect.height
  button('纵隔窗').click()
  await settle()
  const mediastinum = grays()
  const slider = container.querySelector('input[type="range"]') as HTMLInputElement
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '3')
  slider.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  const lastFrameMediastinum = grays()
  const label = () => [...container.querySelectorAll('span')].find(item => item.textContent?.startsWith('Im '))?.textContent
  const frameLabel = label()
  // 滚轮翻片由非被动监听阻止默认滚动，页面与 DSH 宿主不随之滚动。
  const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 })
  container.querySelector('[data-imaging-viewport]')!.dispatchEvent(wheel)
  await settle()
  const wheelFrameLabel = label()

  // 切换到另一次检查：前一次检查尚未返回的像素块被取消，迟到的结果不会显示。
  let staleAborted = false
  const releaseStale: Array<() => void> = []
  const slowSource: ImagingViewerSource = {
    loadBlock: (path, signal) => new Promise((resolve) => {
      const { blockIndex, frameIndex } = position(path)
      signal.addEventListener('abort', () => { staleAborted = true })
      releaseStale.push(() => resolve(bytes(ctFrames[frameIndex]!.slice(blockIndex * 4, blockIndex * 4 + 4), true)))
    }),
    study: { ...ctStudy, studyId: 'study-slow' },
  }
  flushSync(() => root.render(<ImagingViewer key="slow" locale="zh-CN" source={slowSource} />))
  await settle()
  const radiographPixels = [0, 1024, 3072, 4095]
  flushSync(() => root.render(
    <ImagingViewer
      key="radiograph"
      locale="zh-CN"
      source={{ loadBlock: async () => bytes(radiographPixels, false), study: radiographStudy }}
    />,
  ))
  await settle()
  for (const release of releaseStale) release()
  await settle()
  const radiograph = grays()
  const radiographSize = { height: canvas().height, width: canvas().width }
  const markers = [...container.querySelectorAll('span')].map(item => item.textContent).filter(text => text === 'R' || text === 'L' || text === 'A' || text === 'P')
  button('反相').click()
  await settle()
  const inverted = grays()

  flushSync(() => root.render(
    <ImagingViewer key="missing" locale="zh-CN" source={{ loadBlock: async () => new Uint8Array(), study: { ...ctStudy, available: false, series: [] } }} />,
  ))
  await settle()
  document.title = btoa(JSON.stringify({
    aspect,
    frameLabel,
    frameShown,
    inverted,
    lastFrameMediastinum,
    lung,
    markers,
    mediastinum,
    radiograph,
    radiographSize,
    size,
    staleAborted,
    unavailable: container.querySelector('canvas') === null && container.textContent?.includes('影像暂不可用') === true,
    wheelFrameLabel,
    wheelPrevented: wheel.defaultPrevented,
  }))
}

run().catch((error) => { document.title = btoa(JSON.stringify({ error: String(error) })) })
