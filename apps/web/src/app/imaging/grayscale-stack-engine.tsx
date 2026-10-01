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
import type { ImagingEngineProps } from './imaging-viewer.tsx'

type FrameStackSeries = Extract<ImagingSeriesView, { kind: 'frame-stack' }>

/** 已解码帧的缓存上限；超过后按最久未用淘汰。 */
const frameCacheBudgetBytes = 256 * 1024 * 1024
const presetLabels: Record<typeof ctWindowPresets[number]['id'], [string, string]> = {
  bone: ['骨窗', 'Bone'],
  lung: ['肺窗', 'Lung'],
  mediastinum: ['纵隔窗', 'Mediastinum'],
}

/**
 * 灰度堆叠引擎：CT 与胸片共用。像素按帧读取并缓存，窗宽窗位、反相、比例与层面顺序全部交给
 * 无平台依赖的显示规则计算，这里只负责读取、交互和把结果画到 canvas。
 */
export function GrayscaleStackEngine({ loadBlock, locale, onFrameShown, series }: ImagingEngineProps<FrameStackSeries>) {
  const zh = locale === 'zh-CN'
  const [frameIndex, setFrameIndex] = useState(0)
  const [displayWindow, setDisplayWindow] = useState<DisplayWindow>(() => defaultDisplayWindow(series, series.frames[0]!))
  const [invert, setInvert] = useState(false)
  const [view, setView] = useState({ panX: 0, panY: 0, zoom: 1 })
  const [dragMode, setDragMode] = useState<'pan' | 'window'>('pan')
  const [viewport, setViewport] = useState({ height: 0, width: 0 })
  const [shown, setShown] = useState<{ frameIndex: number; pixels: PixelArray }>()
  const [failed, setFailed] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cacheRef = useRef(new Map<number, PixelArray>())
  const dragRef = useRef<{ x: number; y: number }>(undefined)
  const frameShownRef = useRef(onFrameShown)
  frameShownRef.current = onFrameShown
  const frame = series.frames[frameIndex]!

  // 读取当前帧并预取相邻帧；卸载或换帧时取消尚未完成的请求，迟到的结果不会被显示。
  useEffect(() => {
    const controller = new AbortController()
    const cache = cacheRef.current
    const load = async (index: number): Promise<PixelArray> => {
      const cached = cache.get(index)
      if (cached !== undefined) {
        cache.delete(index)
        cache.set(index, cached)
        return cached
      }
      const description = series.frames[index]!
      const blocks = await Promise.all(description.blocks.map((_, blockIndex) => (
        loadBlock({ blockIndex, frameIndex: index }, controller.signal)
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
  }, [frameIndex, loadBlock, series])

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

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || shown === undefined) return
    const description = series.frames[shown.frameIndex]!
    const context = canvas.getContext('2d')
    if (context === null) return
    canvas.width = description.columns
    canvas.height = description.rows
    const rgba = renderGrayscale({ invert, pixels: shown.pixels, window: displayWindow })
    context.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, description.columns, description.rows), 0, 0)
    frameShownRef.current()
  }, [displayWindow, invert, series, shown])

  const stepFrame = (delta: number) => setFrameIndex(current => clampFrameIndex(current + delta, series.frames.length))
  const zoomBy = (factor: number) => setView(current => ({
    ...current,
    zoom: Math.min(16, Math.max(0.25, current.zoom * factor)),
  }))
  const placement = fitImage({
    aspectRatio: displayAspectRatio(frame),
    panX: view.panX,
    panY: view.panY,
    viewportHeight: Math.max(1, viewport.height),
    viewportWidth: Math.max(1, viewport.width),
    zoom: view.zoom,
  })
  // 规范显示方向：图像左侧是患者右侧；CT 上方为前、下方为后。侧位片不标左右。
  const sideMarkers = series.valueUnit === 'hu' || frame.view === 'frontal'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
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
          const deltaX = event.clientX - last.x
          const deltaY = event.clientY - last.y
          dragRef.current = { x: event.clientX, y: event.clientY }
          if (dragMode === 'pan') setView(current => ({ ...current, panX: current.panX + deltaX, panY: current.panY + deltaY }))
          // 调窗：左右拖动改变窗宽，上下拖动改变窗位。
          else setDisplayWindow(current => adjustDisplayWindow(current, { center: deltaY * 2, width: deltaX * 4 }))
        }}
        onPointerUp={() => { dragRef.current = undefined }}
        onWheel={(event) => {
          if (event.ctrlKey || series.frames.length === 1) zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1)
          else stepFrame(event.deltaY > 0 ? 1 : -1)
        }}
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
          {zh ? `窗位 ${Math.round(displayWindow.center)} / 窗宽 ${Math.round(displayWindow.width)}` : `C ${Math.round(displayWindow.center)} / W ${Math.round(displayWindow.width)}`}
        </span>
        {failed ? (
          <p className="absolute inset-x-0 top-1/2 text-center text-sm text-white" role="alert">
            {zh ? '影像读取失败' : 'The image could not be loaded'}
          </p>
        ) : shown?.frameIndex !== frameIndex ? (
          <p className="pointer-events-none absolute right-2 top-2 text-xs text-white/80">{zh ? '加载中…' : 'Loading…'}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t bg-background p-2 text-xs">
        {series.frames.length === 1 ? null : (
          <label className="flex min-w-48 flex-1 items-center gap-2">
            <span className="whitespace-nowrap">Im {frameIndex + 1} / {series.frames.length}</span>
            <input
              aria-label={zh ? '图像序号' : 'Image number'}
              className="min-w-0 flex-1"
              max={series.frames.length}
              min={1}
              onChange={event => setFrameIndex(clampFrameIndex(Number(event.target.value) - 1, series.frames.length))}
              type="range"
              value={frameIndex + 1}
            />
          </label>
        )}
        {series.valueUnit === 'hu'
          ? ctWindowPresets.map(preset => (
              <Button
                key={preset.id}
                onClick={() => setDisplayWindow({ center: preset.center, width: preset.width })}
                size="xs"
                variant={displayWindow.center === preset.center && displayWindow.width === preset.width ? 'default' : 'outline'}
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
            setDisplayWindow(defaultDisplayWindow(series, frame))
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
