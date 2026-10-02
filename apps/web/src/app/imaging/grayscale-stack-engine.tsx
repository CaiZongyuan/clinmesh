import type { ImagingSeriesView } from '@clinmesh/contracts/imaging'
import {
  adjustDisplayWindow,
  assembleFrame,
  clampFrameIndex,
  ctWindowPresets,
  defaultDisplayWindow,
  displayAspectRatio,
  fitImage,
  renderGrayscale,
  type DisplayWindow,
  type PixelArray,
} from '@clinmesh/core/imaging-display'
import { Button } from '@clinmesh/ui/components/button'
import { useEffect, useRef, useState } from 'react'
import type { ImagingEngine, ImagingEngineProps } from './imaging-engines.ts'

type FrameStackSeries = Extract<ImagingSeriesView, { kind: 'frame-stack' }>
/** 堆叠帧的像素块位置：第几帧中按行切分的第几块。 */
interface FrameBlockPosition {
  blockIndex: number
  frameIndex: number
}
/** 手动调整的窗及调整时显示的帧。 */
interface WindowOverride {
  frameIndex: number
  window: DisplayWindow
}

/** 已解码帧的缓存上限；超过后按最久未用淘汰。 */
const frameCacheBudgetBytes = 64 * 1024 * 1024
/** 同一阅片器同时进行的像素块请求上限；超出的请求排队，换帧时随请求一起取消。 */
const maxParallelBlockRequests = 4
const presetLabels: Record<typeof ctWindowPresets[number]['id'], [string, string]> = {
  bone: ['骨窗', 'Bone'],
  lung: ['肺窗', 'Lung'],
  mediastinum: ['纵隔窗', 'Mediastinum'],
}

const zoomView = (view: { panX: number; panY: number; zoom: number }, factor: number) => ({
  ...view,
  zoom: Math.min(16, Math.max(0.25, view.zoom * factor)),
})

/**
 * 某一帧使用的窗：CT 的 HU 是绝对值，手动调整的窗用于整组层面；胸片存储值随曝光不同，
 * 手动调整只用于调整时的那一幅，其他幅（如侧位）使用各自的默认窗。
 */
function frameWindow(series: FrameStackSeries, override: WindowOverride | undefined, frameIndex: number): DisplayWindow {
  if (override !== undefined && (series.valueUnit === 'hu' || override.frameIndex === frameIndex)) return override.window
  return defaultDisplayWindow(series, series.frames[frameIndex]!)
}

/**
 * 灰度堆叠引擎：CT 与胸片共用。像素按帧读取并缓存；帧已在摄取时规范为 HU、放射学方向和层面顺序，
 * 窗宽窗位、反相、比例与适配交给无平台依赖的显示规则计算，这里只负责读取、交互和把结果画到 canvas。
 */
function GrayscaleStackEngine({ loadBlock, locale, onFrameShown, series }: ImagingEngineProps<FrameStackSeries, FrameBlockPosition>) {
  const zh = locale === 'zh-CN'
  const [frameIndex, setFrameIndex] = useState(0)
  const [windowOverride, setWindowOverride] = useState<WindowOverride>()
  const [invert, setInvert] = useState(false)
  const [view, setView] = useState({ panX: 0, panY: 0, zoom: 1 })
  const [dragMode, setDragMode] = useState<'pan' | 'window'>('pan')
  const [viewport, setViewport] = useState({ height: 0, width: 0 })
  const [shown, setShown] = useState<{ frameIndex: number; pixels: PixelArray }>()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<ImageData>(undefined)
  const cacheRef = useRef(new Map<number, PixelArray>())
  const requestGateRef = useRef({ active: 0, waiting: [] as Array<() => void> })
  const dragRef = useRef<{ x: number; y: number }>(undefined)
  // 拖动位移先累积，每个动画帧最多更新一次平移或窗。
  const dragDeltaRef = useRef({ frame: 0, x: 0, y: 0 })
  const frameShownRef = useRef(onFrameShown)
  frameShownRef.current = onFrameShown
  const frameCount = series.frames.length
  // 比例、方向标记和默认窗跟随画面上实际显示的帧：新帧读取完成前仍按旧帧放置旧像素。
  const shownIndex = shown?.frameIndex ?? frameIndex
  const shownFrame = series.frames[shownIndex]!
  const displayWindow = frameWindow(series, windowOverride, shownIndex)

  // 读取当前帧并预取相邻帧；卸载或换帧时取消尚未完成的请求，迟到的结果不会被显示。
  useEffect(() => {
    const controller = new AbortController()
    const cache = cacheRef.current
    const gate = requestGateRef.current
    const loadLimited = async (position: FrameBlockPosition): Promise<Uint8Array> => {
      if (gate.active < maxParallelBlockRequests) gate.active += 1
      else await new Promise<void>(resolve => gate.waiting.push(resolve))
      try {
        return await loadBlock(position, controller.signal)
      } finally {
        // 有排队请求时把名额直接交给它，名额数不会因交接而超出上限。
        const next = gate.waiting.shift()
        if (next === undefined) gate.active -= 1
        else next()
      }
    }
    const load = async (index: number): Promise<PixelArray> => {
      const cached = cache.get(index)
      if (cached !== undefined) {
        cache.delete(index)
        cache.set(index, cached)
        return cached
      }
      const description = series.frames[index]!
      const blocks = await Promise.all(description.blocks.map((_, blockIndex) => (
        loadLimited({ blockIndex, frameIndex: index })
      )))
      const pixels = assembleFrame(description, blocks, series.pixelFormat)
      cache.set(index, pixels)
      let bytes = 0
      for (const entry of cache.values()) bytes += entry.byteLength
      for (const oldest of cache.keys()) {
        if (bytes <= frameCacheBudgetBytes || oldest === index) break
        bytes -= cache.get(oldest)!.byteLength
        cache.delete(oldest)
      }
      return pixels
    }
    setFailed(false)
    load(frameIndex).then((pixels) => {
      if (controller.signal.aborted) return
      setShown({ frameIndex, pixels })
      for (const neighbor of [frameIndex + 1, frameIndex - 1]) {
        if (series.frames[neighbor] !== undefined) void load(neighbor).catch(() => undefined)
      }
    }, () => {
      if (!controller.signal.aborted) setFailed(true)
    })
    return () => controller.abort()
  }, [attempt, frameIndex, loadBlock, series])

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const measure = () => setViewport({ height: container.clientHeight, width: container.clientWidth })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // React 的 wheel 监听是被动的，无法阻止页面或 DSH 宿主随翻片滚动、Ctrl+滚轮缩放浏览器；这里用非被动的原生监听。
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.deltaY === 0) return
      if (event.ctrlKey || frameCount === 1) setView(current => zoomView(current, event.deltaY < 0 ? 1.1 : 1 / 1.1))
      else setFrameIndex(current => clampFrameIndex(current + (event.deltaY > 0 ? 1 : -1), frameCount))
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [frameCount])

  const { center, width } = displayWindow
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || shown === undefined) return
    const { columns, rows } = series.frames[shown.frameIndex]!
    const context = canvas.getContext('2d')
    if (context === null) return
    // 调窗时每个动画帧都重绘：同尺寸的帧复用同一块画布缓冲区，尺寸变化时才重新分配。
    let image = imageRef.current
    if (image?.width !== columns || image.height !== rows) {
      canvas.width = columns
      canvas.height = rows
      image = new ImageData(new Uint8ClampedArray(columns * rows * 4), columns, rows)
      imageRef.current = image
    }
    renderGrayscale({ invert, output: image.data, pixels: shown.pixels, window: { center, width } })
    context.putImageData(image, 0, 0)
    frameShownRef.current()
  }, [center, invert, series, shown, width])

  const stepFrame = (delta: number) => setFrameIndex(current => clampFrameIndex(current + delta, frameCount))
  const zoomBy = (factor: number) => setView(current => zoomView(current, factor))
  const endDrag = () => { dragRef.current = undefined }
  const placement = fitImage({
    aspectRatio: displayAspectRatio(shownFrame),
    panX: view.panX,
    panY: view.panY,
    viewportHeight: Math.max(1, viewport.height),
    viewportWidth: Math.max(1, viewport.width),
    zoom: view.zoom,
  })
  // 规范显示方向：图像左侧是患者右侧；CT 上方为前、下方为后。侧位片不标左右。
  const sideMarkers = series.valueUnit === 'hu' || shownFrame.view === 'frontal'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        aria-label={zh ? '影像显示区' : 'Image display'}
        className="relative min-h-0 flex-1 touch-none overflow-hidden bg-black outline-none"
        data-imaging-viewport
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'PageDown') stepFrame(1)
          else if (event.key === 'ArrowUp' || event.key === 'PageUp') stepFrame(-1)
          else return
          event.preventDefault()
        }}
        onPointerDown={(event) => {
          dragRef.current = { x: event.clientX, y: event.clientY }
          event.currentTarget.setPointerCapture?.(event.pointerId)
        }}
        onPointerMove={(event) => {
          const last = dragRef.current
          if (last === undefined) return
          const pending = dragDeltaRef.current
          pending.x += event.clientX - last.x
          pending.y += event.clientY - last.y
          dragRef.current = { x: event.clientX, y: event.clientY }
          if (pending.frame !== 0) return
          pending.frame = requestAnimationFrame(() => {
            const { x, y } = pending
            Object.assign(pending, { frame: 0, x: 0, y: 0 })
            if (dragMode === 'pan') setView(current => ({ ...current, panX: current.panX + x, panY: current.panY + y }))
            // 调窗：左右拖动改变窗宽，上下拖动改变窗位。
            else {
              setWindowOverride(current => ({
                frameIndex: shownIndex,
                window: adjustDisplayWindow(frameWindow(series, current, shownIndex), { center: y * 2, width: x * 4 }),
              }))
            }
          })
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        ref={containerRef}
        role="application"
        tabIndex={0}
      >
        <canvas
          className="absolute"
          ref={canvasRef}
          style={{ height: placement.height, left: placement.x, top: placement.y, width: placement.width }}
        />
        {sideMarkers ? (
          <>
            <span className="pointer-events-none absolute left-2 top-1/2 text-xs text-white/80">R</span>
            <span className="pointer-events-none absolute right-2 top-1/2 text-xs text-white/80">L</span>
          </>
        ) : null}
        {series.valueUnit === 'hu' ? (
          <>
            <span className="pointer-events-none absolute left-1/2 top-2 text-xs text-white/80">A</span>
            <span className="pointer-events-none absolute bottom-2 left-1/2 text-xs text-white/80">P</span>
          </>
        ) : null}
        <span className="pointer-events-none absolute bottom-2 left-2 text-xs text-white/80">
          {zh ? `窗位 ${Math.round(center)} / 窗宽 ${Math.round(width)}` : `C ${Math.round(center)} / W ${Math.round(width)}`}
        </span>
        {failed ? (
          // 阻止按下事件冒泡到视口，避免视口捕获指针后重试按钮收不到点击。
          <div
            className="absolute inset-x-0 top-1/2 flex flex-col items-center gap-2 text-sm text-white"
            onPointerDown={event => event.stopPropagation()}
            role="alert"
          >
            <p>{zh ? '影像读取失败' : 'The image could not be loaded'}</p>
            <Button onClick={() => setAttempt(current => current + 1)} size="xs" variant="outline">{zh ? '重试' : 'Retry'}</Button>
          </div>
        ) : shown?.frameIndex !== frameIndex ? (
          <p className="pointer-events-none absolute right-2 top-2 text-xs text-white/80">{zh ? '加载中…' : 'Loading…'}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t bg-background p-2 text-xs">
        {frameCount === 1 ? null : (
          <label className="flex min-w-48 flex-1 items-center gap-2">
            <span className="whitespace-nowrap">Im {frameIndex + 1} / {frameCount}</span>
            <input
              aria-label={zh ? '图像序号' : 'Image number'}
              className="min-w-0 flex-1"
              max={frameCount}
              min={1}
              onChange={event => setFrameIndex(clampFrameIndex(Number(event.target.value) - 1, frameCount))}
              type="range"
              value={frameIndex + 1}
            />
          </label>
        )}
        {series.valueUnit === 'hu'
          ? ctWindowPresets.map(preset => (
              <Button
                key={preset.id}
                onClick={() => setWindowOverride({ frameIndex: shownIndex, window: { center: preset.center, width: preset.width } })}
                size="xs"
                variant={center === preset.center && width === preset.width ? 'default' : 'outline'}
              >
                {presetLabels[preset.id][zh ? 0 : 1]}
              </Button>
            ))
          : (
              <Button aria-pressed={invert} onClick={() => setInvert(current => !current)} size="xs" variant={invert ? 'default' : 'outline'}>
                {zh ? '反相' : 'Invert'}
              </Button>
            )}
        <Button
          aria-pressed={dragMode === 'window'}
          onClick={() => setDragMode(current => current === 'pan' ? 'window' : 'pan')}
          size="xs"
          variant={dragMode === 'window' ? 'default' : 'outline'}
        >
          {zh ? '拖动调窗' : 'Drag to window'}
        </Button>
        <Button aria-label={zh ? '放大' : 'Zoom in'} onClick={() => zoomBy(1.25)} size="xs" variant="outline">+</Button>
        <Button aria-label={zh ? '缩小' : 'Zoom out'} onClick={() => zoomBy(0.8)} size="xs" variant="outline">−</Button>
        <Button
          onClick={() => {
            setView({ panX: 0, panY: 0, zoom: 1 })
            setInvert(false)
            setWindowOverride(undefined)
          }}
          size="xs"
          variant="outline"
        >
          {zh ? '复位' : 'Reset'}
        </Button>
      </div>
    </div>
  )
}

export const frameStackEngine: ImagingEngine<FrameStackSeries, FrameBlockPosition> = {
  blockPath: position => `frames/${position.frameIndex}/blocks/${position.blockIndex}`,
  Engine: GrayscaleStackEngine,
  summary: (series, locale) => `${series.modality} · ${locale === 'zh-CN' ? `${series.frames.length} 幅图像` : `${series.frames.length} images`}`,
}
