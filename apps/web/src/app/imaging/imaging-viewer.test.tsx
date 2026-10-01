// @vitest-environment jsdom
import type { ImagingStudyView } from '@clinmesh/contracts/imaging'
import { act, cleanup, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImagingViewer } from './imaging-viewer.tsx'

const blockBytes = 4
/** 两帧、每帧六个像素块的胸片式检查：一次显示加邻帧预取共十二个块请求。 */
const study: ImagingStudyView = {
  available: true,
  examCode: 'chest-radiograph',
  series: [{
    frames: [0, 1].map(() => ({
      blocks: Array.from({ length: 6 }, (_, index) => ({ length: blockBytes, rowCount: 1, rowStart: index })),
      columns: 2,
      pixelSpacingMm: [1, 1] as [number, number],
      rows: 6,
      view: 'frontal' as const,
      window: { center: 2_000, width: 4_000 },
    })),
    kind: 'frame-stack',
    modality: 'DX',
    pixelFormat: 'uint16',
    valueUnit: 'stored',
  }],
  studyId: 'study-1',
}

describe('imaging viewer', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData: () => undefined } as never)
    vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} })
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('tracks full screen inside a shadow root, where the document reports the shadow host', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const container = document.createElement('div')
    shadow.append(container)
    const view = render(
      <ImagingViewer locale="zh-CN" source={{ loadBlock: async () => new Uint8Array(blockBytes), study }} />,
      { container },
    )
    const section = within(container).getByRole('region', { name: '影像阅片' })
    const setFullscreenElement = async (inner: Element | null) => {
      // 浏览器把 document.fullscreenElement 重定向为 shadow host，真正的元素只在 ShadowRoot 上可见。
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: inner === null ? null : host })
      Object.defineProperty(shadow, 'fullscreenElement', { configurable: true, value: inner })
      await act(async () => { document.dispatchEvent(new Event('fullscreenchange')) })
    }
    try {
      await setFullscreenElement(section)
      expect(within(container).getByRole('button', { name: '退出全屏' })).toBeTruthy()
      await setFullscreenElement(null)
      expect(within(container).getByRole('button', { name: '全屏' })).toBeTruthy()
    } finally {
      Reflect.deleteProperty(document, 'fullscreenElement')
      view.unmount()
      host.remove()
    }
  })

  it('keeps at most four pixel block requests in flight', async () => {
    let active = 0
    let peak = 0
    let loaded = 0
    const onFrameShown = vi.fn()
    render(
      <ImagingViewer
        locale="zh-CN"
        onFrameShown={onFrameShown}
        source={{
          loadBlock: async () => {
            active += 1
            peak = Math.max(peak, active)
            await new Promise(resolve => setTimeout(resolve, 5))
            active -= 1
            loaded += 1
            return new Uint8Array(blockBytes)
          },
          study,
        }}
      />,
    )

    await waitFor(() => expect(loaded).toBe(12))
    expect(onFrameShown).toHaveBeenCalledTimes(1)
    expect(peak).toBe(4)
  })
})
