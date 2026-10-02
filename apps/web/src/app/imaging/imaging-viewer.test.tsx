// @vitest-environment jsdom
import type { ImagingStudyView } from '@clinmesh/contracts/imaging'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  it('reads blocks by the path of the series kind and evicts the least recently used frames beyond 64 MiB', async () => {
    // 每帧 16 MiB：缓存最多保留四帧。
    const columns = 2048
    const rows = 4096
    const frameBytes = columns * rows * 2
    const large: ImagingStudyView = {
      ...study,
      series: [{
        ...study.series[0]!,
        frames: Array.from({ length: 5 }, () => ({
          blocks: [{ length: frameBytes, rowCount: rows, rowStart: 0 }],
          columns,
          pixelSpacingMm: null,
          rows,
        })),
      }],
    }
    const paths: string[] = []
    render(<ImagingViewer locale="zh-CN" source={{ loadBlock: async (path) => { paths.push(path); return new Uint8Array(frameBytes) }, study: large }} />)
    const viewport = screen.getByRole('application', { name: '影像显示区' })
    const settle = async (frame: number, requests: number) => {
      await waitFor(() => expect(screen.getByText(`Im ${frame} / 5`)).toBeTruthy())
      await waitFor(() => expect(paths).toHaveLength(requests))
      await waitFor(() => expect(screen.queryByText('加载中…')).toBeNull())
      // 让邻帧预取完成解码并写入缓存。
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    }

    await settle(1, 2)
    expect(paths).toEqual(['series/0/frames/0/blocks/0', 'series/0/frames/1/blocks/0'])
    for (const [frame, requests] of [[2, 3], [3, 4], [4, 5], [5, 5]] as const) {
      fireEvent.keyDown(viewport, { key: 'ArrowDown' })
      await settle(frame, requests)
    }
    // 第五帧读入时超出 64 MiB，最久未用的第一、二帧先后被淘汰，回到第一帧需要重新读取；最近用过的第五帧仍在缓存中。
    fireEvent.change(screen.getByLabelText('图像序号'), { target: { value: '1' } })
    await settle(1, 7)
    expect(paths.slice(5)).toEqual(['series/0/frames/0/blocks/0', 'series/0/frames/1/blocks/0'])
    fireEvent.change(screen.getByLabelText('图像序号'), { target: { value: '5' } })
    await settle(5, 7)
  }, 30_000)

  it('pages with the wheel without scrolling or zooming the page', async () => {
    render(<ImagingViewer locale="zh-CN" source={{ loadBlock: async () => new Uint8Array(blockBytes), study }} />)
    const viewport = screen.getByRole('application', { name: '影像显示区' })
    expect(fireEvent.wheel(viewport, { deltaY: 100 })).toBe(false)
    expect(screen.getByText('Im 2 / 2')).toBeTruthy()
    expect(fireEvent.wheel(viewport, { ctrlKey: true, deltaY: -100 })).toBe(false)
    expect(screen.getByText('Im 2 / 2')).toBeTruthy()
  })

  it('uses the default window of the radiograph frame on screen and resets to it', async () => {
    const twoViews: ImagingStudyView = {
      ...study,
      series: [{
        ...study.series[0]!,
        frames: [
          study.series[0]!.frames[0]!,
          { ...study.series[0]!.frames[0]!, view: 'lateral', window: { center: 1_000, width: 500 } },
        ],
      }],
    }
    const user = userEvent.setup()
    render(<ImagingViewer locale="zh-CN" source={{ loadBlock: async () => new Uint8Array(blockBytes), study: twoViews }} />)
    const viewport = screen.getByRole('application', { name: '影像显示区' })
    await waitFor(() => expect(screen.queryByText('加载中…')).toBeNull())
    expect(screen.getByText('窗位 2000 / 窗宽 4000')).toBeTruthy()
    expect(screen.getByText('R')).toBeTruthy()

    fireEvent.keyDown(viewport, { key: 'ArrowDown' })
    expect(await screen.findByText('窗位 1000 / 窗宽 500')).toBeTruthy()
    // 侧位片不标左右。
    expect(screen.queryByText('R')).toBeNull()

    // 拖动调窗只作用于当前这一幅，每个动画帧最多更新一次。
    await user.click(screen.getByRole('button', { name: '拖动调窗' }))
    fireEvent.pointerDown(viewport, { clientX: 0, clientY: 0 })
    fireEvent.pointerMove(viewport, { clientX: 10, clientY: 5 })
    fireEvent.pointerMove(viewport, { clientX: 20, clientY: 10 })
    fireEvent.pointerUp(viewport)
    expect(await screen.findByText('窗位 1020 / 窗宽 580')).toBeTruthy()
    fireEvent.keyDown(viewport, { key: 'ArrowUp' })
    expect(await screen.findByText('窗位 2000 / 窗宽 4000')).toBeTruthy()
    fireEvent.keyDown(viewport, { key: 'ArrowDown' })
    expect(await screen.findByText('窗位 1020 / 窗宽 580')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '复位' }))
    expect(screen.getByText('窗位 1000 / 窗宽 500')).toBeTruthy()
  })

  it('offers a retry when a frame cannot be read', async () => {
    let fail = true
    const user = userEvent.setup()
    render(<ImagingViewer locale="zh-CN" source={{
      loadBlock: async () => {
        if (fail) throw new Error('offline')
        return new Uint8Array(blockBytes)
      },
      study,
    }} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('影像读取失败')
    fail = false
    await user.click(within(alert).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    await waitFor(() => expect(screen.queryByText('加载中…')).toBeNull())
  })
})
