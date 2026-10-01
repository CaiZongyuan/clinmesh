import type { ImagingSeriesView, ImagingStudyView } from '@clinmesh/contracts/imaging'
import { Button } from '@clinmesh/ui/components/button'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceLocale } from '../workspace-i18n.ts'
import { GrayscaleStackEngine } from './grayscale-stack-engine.tsx'

/** 阅片器的像素来源：一次检查的读取描述，加上按位置读取像素块的函数。 */
export interface ImagingViewerSource {
  loadBlock(
    position: { blockIndex: number; frameIndex: number; seriesIndex: number },
    signal: AbortSignal,
  ): Promise<Uint8Array>
  study: ImagingStudyView
}

/** 渲染引擎的统一接口：外壳按序列的 `kind` 选择引擎，引擎只面对一个序列。 */
export interface ImagingEngineProps<Series extends ImagingSeriesView = ImagingSeriesView> {
  loadBlock(position: { blockIndex: number; frameIndex: number }, signal: AbortSignal): Promise<Uint8Array>
  locale: WorkspaceLocale
  onFrameShown(): void
  series: Series
}

const engines: {
  [Kind in ImagingSeriesView['kind']]: (
    props: ImagingEngineProps<Extract<ImagingSeriesView, { kind: Kind }>>,
  ) => React.JSX.Element
} = {
  'frame-stack': GrayscaleStackEngine,
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

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null && document.fullscreenElement === rootRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  const loadSeriesBlock = useCallback((
    position: { blockIndex: number; frameIndex: number },
    signal: AbortSignal,
  ) => loadBlock({ ...position, seriesIndex }, signal), [loadBlock, seriesIndex])
  const handleFrameShown = useCallback(() => {
    if (reportedRef.current) return
    reportedRef.current = true
    frameShownRef.current?.()
  }, [])

  if (!study.available || series === undefined) {
    return (
      <p className="border p-4 text-sm text-muted-foreground" role="status">
        {zh ? '影像暂不可用。报告仍可阅读；影像恢复后才能确认已阅。' : 'The images are currently unavailable. The report can still be read.'}
      </p>
    )
  }
  const Engine = engines[series.kind]
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
          {series.modality} · {zh ? `${series.frames.length} 幅图像` : `${series.frames.length} images`}
        </span>
        <Button
          className="ml-auto"
          onClick={() => {
            if (fullscreen) void document.exitFullscreen?.()
            else void rootRef.current?.requestFullscreen?.()
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
