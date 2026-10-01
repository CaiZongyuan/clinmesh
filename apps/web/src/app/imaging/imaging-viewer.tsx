import type { ImagingSeriesView, ImagingStudyView } from '@clinmesh/contracts/imaging'
import { Button } from '@clinmesh/ui/components/button'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceLocale } from '../workspace-i18n.ts'
import { imagingEngines, type ImagingEngine } from './imaging-engines.ts'

/** 阅片器的像素来源：一次检查的读取描述，加上读取一个像素块的函数。 */
export interface ImagingViewerSource {
  /** `path` 是相对检查的像素块路径（如 `series/0/frames/3/blocks/0`），由序列 `kind` 对应的引擎生成。 */
  loadBlock(path: string, signal: AbortSignal): Promise<Uint8Array>
  study: ImagingStudyView
}

/**
 * 阅片外壳：检查与序列导航、全屏与返回、像素不可用时的提示。具体渲染由引擎完成；
 * 调用方用 `key` 区分不同检查，切换检查时整个外壳重建，旧检查未完成的请求随之取消。
 */
export function ImagingViewer({ locale, onFrameShown, source }: {
  locale: WorkspaceLocale
  /** 首次有图像成功显示时调用一次，供确认已阅等依赖“已看到影像”的操作使用。 */
  onFrameShown?: () => void
  source: ImagingViewerSource
}) {
  const zh = locale === 'zh-CN'
  const [seriesIndex, setSeriesIndex] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const reportedRef = useRef(false)
  const frameShownRef = useRef(onFrameShown)
  frameShownRef.current = onFrameShown
  const { loadBlock, study } = source
  const series = study.series[seriesIndex]
  // 外壳不构造像素块位置，只把引擎给出的位置交给同一条目的路径函数，因此位置类型在这里是 never。
  const engine: ImagingEngine<ImagingSeriesView, never> | undefined = series === undefined ? undefined : imagingEngines[series.kind]
  const blockPath = engine?.blockPath

  useEffect(() => {
    // DSH Surface 位于 ShadowRoot 内：document.fullscreenElement 会被重定向为 shadow host，
    // 真正进入全屏的元素要从阅片器所在的根节点读取。
    const onChange = () => {
      const root = rootRef.current
      setFullscreen(root !== null && (root.getRootNode() as Document | ShadowRoot).fullscreenElement === root)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  const loadSeriesBlock = useCallback(
    (position: never, signal: AbortSignal) => loadBlock(`series/${seriesIndex}/${blockPath!(position)}`, signal),
    [blockPath, loadBlock, seriesIndex],
  )
  const handleFrameShown = useCallback(() => {
    if (reportedRef.current) return
    reportedRef.current = true
    frameShownRef.current?.()
  }, [])

  if (!study.available || series === undefined || engine === undefined) {
    return (
      <p className="border p-4 text-sm text-muted-foreground" role="status">
        {zh ? '影像暂不可用。报告仍可阅读；影像恢复后才能确认已阅。' : 'The images are currently unavailable. The report can still be read.'}
      </p>
    )
  }
  const { Engine } = engine
  return (
    <section
      aria-label={zh ? '影像阅片' : 'Image viewer'}
      className={`flex flex-col border bg-background ${fullscreen ? 'h-full' : 'h-[min(70vh,640px)]'}`}
      ref={rootRef}
    >
      <div className="flex flex-wrap items-center gap-2 border-b p-2 text-xs">
        {study.series.length === 1 ? null : study.series.map((_, index) => (
          <Button
            key={index}
            onClick={() => setSeriesIndex(index)}
            size="xs"
            variant={index === seriesIndex ? 'default' : 'outline'}
          >
            {zh ? `序列 ${index + 1}` : `Series ${index + 1}`}
          </Button>
        ))}
        <span className="text-muted-foreground">
          {engine.summary(series, locale)}
        </span>
        <Button
          className="ml-auto"
          onClick={() => {
            // 宿主或浏览器策略可能拒绝全屏，此时保持当前布局。
            if (fullscreen) void document.exitFullscreen?.().catch(() => undefined)
            else void rootRef.current?.requestFullscreen?.().catch(() => undefined)
          }}
          size="xs"
          variant="outline"
        >
          {fullscreen ? (zh ? '退出全屏' : 'Exit full screen') : (zh ? '全屏' : 'Full screen')}
        </Button>
      </div>
      <Engine
        key={seriesIndex}
        loadBlock={loadSeriesBlock}
        locale={locale}
        onFrameShown={handleFrameShown}
        series={series}
      />
    </section>
  )
}
