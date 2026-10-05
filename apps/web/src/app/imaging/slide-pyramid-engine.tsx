import type { ImagingSeriesView } from '@clinmesh/contracts/imaging'
import {
  formatMagnification,
  imageToLevel,
  magnificationAt,
  maxScreenScale,
  minLevelPixelOnScreen,
  tileAtLevelPoint,
  tileGrid,
  tileRegion,
} from '@clinmesh/core/imaging-pyramid'
import { Button } from '@clinmesh/ui/components/button'
import OpenSeadragon from 'openseadragon/build/openseadragon/openseadragon.min.js'
import { useEffect, useRef, useState } from 'react'
import type { ImagingEngine, ImagingEngineProps } from './imaging-engines.ts'

type TiledPyramidSeries = Extract<ImagingSeriesView, { kind: 'tiled-pyramid' }>
/** 分层瓦片的读取位置：第几层（0 为最高分辨率）中第几列、第几行的瓦片。 */
interface PyramidTilePosition {
  column: number
  level: number
  row: number
}

/** 同一阅片器（主视图与导航小图合计）同时进行的瓦片请求上限；超出的请求排队。 */
const maxParallelTileRequests = 6
/** 主视图已解码瓦片的缓存预算，按最大瓦片的 RGBA 字节数折算为条目数。 */
const decodedTileCacheBudgetBytes = 64 * 1024 * 1024

/**
 * RGB 分层瓦片引擎：病理切片使用。平移、连续缩放、导航小图与瓦片调度由 OpenSeadragon 完成；
 * 层级几何、倍率读数和缩放上限来自 `@clinmesh/core/imaging-pyramid`。瓦片只经外壳给出的
 * `loadBlock` 读取（受认证、不缓存），不让 OpenSeadragon 按 URL 自行请求；字节解码为 ImageBitmap，
 * 画到每个瓦片自己的 canvas 后立即释放。
 */
function SlidePyramidEngine({ loadBlock, locale, onFrameShown, series }: ImagingEngineProps<TiledPyramidSeries, PyramidTilePosition>) {
  const zh = locale === 'zh-CN'
  const [magnification, setMagnification] = useState<string>()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<OpenSeadragon.Viewer>(undefined)
  // 外壳在切换序列时整体重建引擎；这里用最新引用读取，避免同一序列内因回调变化重建阅片器。
  const loadBlockRef = useRef(loadBlock)
  loadBlockRef.current = loadBlock
  const frameShownRef = useRef(onFrameShown)
  frameShownRef.current = onFrameShown

  useEffect(() => {
    const element = containerRef.current
    if (element === null) return
    const { levels } = series
    const base = levels[0]!
    // OpenSeadragon 的层级从最低分辨率起编号，契约的层级从最高分辨率起编号。
    const levelOf = (viewerLevel: number) => levels.length - 1 - viewerLevel
    // 行末与列末瓦片在层级范围内的像素尺寸。
    const validTileSize = (level: number, column: number, row: number) => {
      const { height, tileHeight, tileWidth, width } = levels[level]!
      return { height: Math.min(tileHeight, height - row * tileHeight), width: Math.min(tileWidth, width - column * tileWidth) }
    }
    const controllers = new Set<AbortController>()
    const gate = { active: 0, waiting: [] as Array<() => void> }
    const loadTile = async (position: PyramidTilePosition, signal: AbortSignal): Promise<Uint8Array> => {
      if (gate.active < maxParallelTileRequests) gate.active += 1
      else await new Promise<void>(resolve => gate.waiting.push(resolve))
      try {
        signal.throwIfAborted()
        return await loadBlockRef.current(position, signal)
      } finally {
        // 有排队请求时把名额直接交给它，名额数不会因交接而超出上限。
        const next = gate.waiting.shift()
        if (next === undefined) gate.active -= 1
        else next()
      }
    }

    const source = Object.assign(new OpenSeadragon.TileSource({
      height: base.height,
      maxLevel: levels.length - 1,
      minLevel: 0,
      tileHeight: base.tileHeight,
      tileOverlap: 0,
      tileWidth: base.tileWidth,
      width: base.width,
    }), {
      // 层级之间的倍数来自实际层级尺寸，不假定逐级减半；瓦片位置与裁切按 core 的几何规则计算。
      getLevelScale: (viewerLevel: number) => levels[levelOf(viewerLevel)]!.width / base.width,
      getNumTiles: (viewerLevel: number) => {
        const { columns, rows } = tileGrid(levels[levelOf(viewerLevel)]!)
        return new OpenSeadragon.Point(columns, rows)
      },
      getTileWidth: (viewerLevel: number) => levels[levelOf(viewerLevel)]!.tileWidth,
      getTileHeight: (viewerLevel: number) => levels[levelOf(viewerLevel)]!.tileHeight,
      // OpenSeadragon 的归一化坐标两轴都以图像宽度为 1。
      getTileAtPoint: (viewerLevel: number, point: OpenSeadragon.Point) => {
        const level = levelOf(viewerLevel)
        const tile = tileAtLevelPoint(levels[level]!, imageToLevel(levels, level, { x: point.x * base.width, y: point.y * base.width }))
        return new OpenSeadragon.Point(tile.column, tile.row)
      },
      getTileBounds: (viewerLevel: number, column: number, row: number, isSource?: boolean) => {
        const level = levelOf(viewerLevel)
        if (isSource === true) {
          const size = validTileSize(level, column, row)
          return new OpenSeadragon.Rect(0, 0, size.width, size.height)
        }
        const region = tileRegion(levels, level, { column, row })
        return new OpenSeadragon.Rect(region.x / base.width, region.y / base.width, region.width / base.width, region.height / base.width)
      },
      // 只作为瓦片缓存键；读取不经过 URL。
      getTileUrl: (viewerLevel: number, column: number, row: number) => `${levelOf(viewerLevel)}/${column}/${row}`,
      downloadTileStart: (job: OpenSeadragon.ImageJob) => {
        const controller = new AbortController()
        controllers.add(controller)
        job.userData.controller = controller
        const position = { column: job.tile.x, level: levelOf(job.tile.level), row: job.tile.y }
        loadTile(position, controller.signal)
          .then(bytes => createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })))
          .then((bitmap) => {
            try {
              // 已取消（切换切片、病例或卸载）的瓦片即使解码完成也不交给阅片器。
              if (controller.signal.aborted) return
              // 边缘瓦片可能按完整瓦片尺寸编码：只保留层级范围内的部分，缩放插值不会取到填充像素。
              const size = validTileSize(position.level, position.column, position.row)
              const canvas = document.createElement('canvas')
              canvas.width = Math.min(bitmap.width, size.width)
              canvas.height = Math.min(bitmap.height, size.height)
              const context = canvas.getContext('2d')
              if (context === null) throw new Error('Canvas 2D is unavailable')
              context.drawImage(bitmap, 0, 0)
              job.finish(context, null, 'context2d')
            } finally {
              bitmap.close()
            }
          })
          .catch(() => {
            if (controller.signal.aborted) return
            setFailed(true)
            job.fail('The slide tile could not be loaded', null)
          })
          .finally(() => controllers.delete(controller))
      },
      // OpenSeadragon 超时放弃瓦片时调用，同时取消对应请求。
      downloadTileAbort: (job: OpenSeadragon.ImageJob) => {
        (job.userData.controller as AbortController | undefined)?.abort()
      },
    })

    setFailed(false)
    const viewer = OpenSeadragon({
      // 二维 canvas 绘制：瓦片缓存就是每瓦片一个 canvas，不占用 WebGL 上下文（主视图与导航小图各需一个）。
      drawer: 'canvas',
      element,
      imageLoaderLimit: maxParallelTileRequests,
      maxImageCacheCount: Math.max(1, Math.floor(decodedTileCacheBudgetBytes / Math.max(...levels.map(level => level.tileWidth * level.tileHeight * 4)))),
      maxZoomPixelRatio: maxScreenScale(base.micronsPerPixel),
      minPixelRatio: minLevelPixelOnScreen,
      navigatorAutoFade: false,
      // 内置按钮从 `prefixUrl` 读取图片；按钮由本组件提供，阅片器不请求任何 URL。
      showNavigationControl: false,
      showNavigator: true,
    })
    viewerRef.current = viewer
    viewer.addHandler('open', () => {
      viewer.world.getItemAt(0).addHandler('fully-loaded-change', (event) => {
        if (event.fullyLoaded) frameShownRef.current()
      })
    })
    viewer.addHandler('update-viewport', () => {
      const zoom = viewer.viewport.viewportToImageZoom(viewer.viewport.getZoom(true))
      setMagnification(formatMagnification(magnificationAt(base.micronsPerPixel, zoom)))
    })
    viewer.open({ tileSource: source })
    return () => {
      for (const controller of controllers) controller.abort()
      viewerRef.current = undefined
      viewer.destroy()
    }
  }, [attempt, series])

  const zoomBy = (factor: number) => {
    const viewport = viewerRef.current?.viewport
    viewport?.zoomBy(factor)
    viewport?.applyConstraints()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1 bg-black">
        <div aria-label={zh ? '切片显示区' : 'Slide display'} className="absolute inset-0" data-slide-viewport ref={containerRef} role="application" />
        {failed ? (
          <div className="absolute inset-x-0 top-1/2 flex flex-col items-center gap-2 text-sm text-white" role="alert">
            <p>{zh ? '切片读取失败' : 'The slide could not be loaded'}</p>
            <Button onClick={() => setAttempt(current => current + 1)} size="xs" variant="outline">{zh ? '重试' : 'Retry'}</Button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t bg-background p-2 text-xs">
        <span data-slide-magnification>{magnification ?? '—'}</span>
        <Button aria-label={zh ? '放大' : 'Zoom in'} onClick={() => zoomBy(2)} size="xs" variant="outline">+</Button>
        <Button aria-label={zh ? '缩小' : 'Zoom out'} onClick={() => zoomBy(0.5)} size="xs" variant="outline">−</Button>
        <Button onClick={() => viewerRef.current?.viewport.goHome()} size="xs" variant="outline">{zh ? '复位' : 'Reset'}</Button>
        <span className="ml-auto text-muted-foreground">
          {zh ? '未做颜色管理：按切片原始颜色值显示' : 'No colour management: shown with the slide’s stored colour values'}
        </span>
      </div>
    </div>
  )
}

export const tiledPyramidEngine: ImagingEngine<TiledPyramidSeries, PyramidTilePosition> = {
  blockPath: position => `levels/${position.level}/tiles/${position.column}/${position.row}`,
  Engine: SlidePyramidEngine,
  summary: (series, locale) => `${series.modality} · ${locale === 'zh-CN' ? `切片 ${series.slideLabel}` : `Slide ${series.slideLabel}`} · ${locale === 'zh-CN' ? '最高' : 'up to'} ${formatMagnification(series.levels[0]!.magnification)}`,
}
