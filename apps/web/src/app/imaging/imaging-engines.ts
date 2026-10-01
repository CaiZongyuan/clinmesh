import type { ImagingSeriesView } from '@clinmesh/contracts/imaging'
import type { WorkspaceLocale } from '../workspace-i18n.ts'
import { frameStackEngine } from './grayscale-stack-engine.tsx'

/** 渲染引擎面对的输入：一个序列，以及按引擎自己的像素块位置读取该序列像素的函数。 */
export interface ImagingEngineProps<Series, Position> {
  loadBlock(position: Position, signal: AbortSignal): Promise<Uint8Array>
  locale: WorkspaceLocale
  onFrameShown(): void
  series: Series
}

/**
 * 一种序列 `kind` 的登记条目。位置类型由引擎自己声明（堆叠帧按帧与块，分层瓦片按层级与坐标），
 * 外壳不构造位置，只把引擎给出的位置交给同一条目的 `blockPath` 换成读取路径。
 */
export interface ImagingEngine<Series, Position> {
  /** 序列内的相对读取路径，例如 `frames/3/blocks/0`；不同 `kind` 由不同的像素路由提供。 */
  blockPath(position: Position): string
  Engine(props: ImagingEngineProps<Series, Position>): React.JSX.Element
  /** 外壳工具栏中的序列摘要。 */
  summary(series: Series, locale: WorkspaceLocale): string
}

type SeriesOf<Kind extends ImagingSeriesView['kind']> = Extract<ImagingSeriesView, { kind: Kind }>

/** 每种 `kind` 一个条目；新增像素组织方式时在这里登记引擎，外壳与调用方不变。 */
export const imagingEngines: { [Kind in ImagingSeriesView['kind']]: ImagingEngine<SeriesOf<Kind>, never> } = {
  'frame-stack': frameStackEngine,
}
