import { maxSlideMagnification } from '@clinmesh/contracts/imaging'

/**
 * 病理切片分层瓦片的几何与倍率规则。全部是不依赖 DOM、Node 或浏览器 API 的纯函数，
 * 浏览器阅片引擎、浏览器合同测试与后续服务端按区域裁切共用同一组规则。
 *
 * 坐标约定：图像坐标是第 0 层（最高分辨率）的像素坐标，层级坐标是某一层自身的像素坐标；
 * 屏幕比例是每个第 0 层像素在屏幕上占的像素数。层级选择按设备像素计算，倍率读数与缩放上限按 CSS 像素计算。
 */

export interface PyramidLevel {
  height: number
  micronsPerPixel: number
  tileHeight: number
  tileWidth: number
  width: number
}

export interface PyramidPoint {
  x: number
  y: number
}

export interface PyramidRegion {
  height: number
  width: number
  x: number
  y: number
}

export interface PyramidTile {
  column: number
  row: number
}

/**
 * 一个层级像素在屏幕上至少占多少设备像素时才选用该层；更高分辨率的层级超出显示所需，不再读取。
 * 与 OpenSeadragon 的 `minPixelRatio` 取同一值，引擎实际显示的层级与 `selectPyramidLevel` 一致。
 */
export const minLevelPixelOnScreen = 0.5

/** 10 倍物镜对应的像素间距（µm/px）；倍率 = 10 × 该值 ÷ 屏幕每像素代表的微米数，20 倍约 0.5 µm/px。 */
const micronsPerPixelAt10x = 1

/** 第 `level` 层相对第 0 层每轴的降采样倍数；层级尺寸取整后两轴倍数可能略有差异，因此分别计算。 */
export function levelDownsample(levels: readonly PyramidLevel[], level: number): PyramidPoint {
  const base = levels[0]!
  const target = levels[level]!
  return { x: base.width / target.width, y: base.height / target.height }
}

export function imageToLevel(levels: readonly PyramidLevel[], level: number, point: PyramidPoint): PyramidPoint {
  const downsample = levelDownsample(levels, level)
  return { x: point.x / downsample.x, y: point.y / downsample.y }
}

export function levelToImage(levels: readonly PyramidLevel[], level: number, point: PyramidPoint): PyramidPoint {
  const downsample = levelDownsample(levels, level)
  return { x: point.x * downsample.x, y: point.y * downsample.y }
}

/**
 * 给定屏幕比例（设备像素）时显示的层级：在层级像素不小于 `minLevelPixelOnScreen` 个设备像素的层级中
 * 取分辨率最高者；缩小到连最低分辨率层也不满足时取最低分辨率层。
 */
export function selectPyramidLevel(levels: readonly PyramidLevel[], devicePixelsPerImagePixel: number): number {
  for (let level = 0; level < levels.length; level += 1) {
    if (levelDownsample(levels, level).x * devicePixelsPerImagePixel >= minLevelPixelOnScreen) return level
  }
  return levels.length - 1
}

export function tileGrid(level: PyramidLevel): { columns: number; rows: number } {
  return { columns: Math.ceil(level.width / level.tileWidth), rows: Math.ceil(level.height / level.tileHeight) }
}

/** 一个瓦片在图像坐标中覆盖的区域；行末与列末的瓦片只计层级范围内的部分。 */
export function tileRegion(levels: readonly PyramidLevel[], level: number, tile: PyramidTile): PyramidRegion {
  const { height, tileHeight, tileWidth, width } = levels[level]!
  const x = tile.column * tileWidth
  const y = tile.row * tileHeight
  const origin = levelToImage(levels, level, { x, y })
  const end = levelToImage(levels, level, { x: Math.min(width, x + tileWidth), y: Math.min(height, y + tileHeight) })
  return { height: end.y - origin.y, width: end.x - origin.x, x: origin.x, y: origin.y }
}

/** 层级坐标中一点所在的瓦片；层级范围外的点归入最近的边缘瓦片。 */
export function tileAtLevelPoint(level: PyramidLevel, point: PyramidPoint): PyramidTile {
  const { columns, rows } = tileGrid(level)
  return {
    column: Math.min(columns - 1, Math.max(0, Math.floor(point.x / level.tileWidth))),
    row: Math.min(rows - 1, Math.max(0, Math.floor(point.y / level.tileHeight))),
  }
}

/** 屏幕比例（CSS 像素）对应的等效物镜倍率，按第 0 层像素间距换算，不设上限。 */
export function magnificationAt(micronsPerPixel: number, cssPixelsPerImagePixel: number): number {
  return (10 * micronsPerPixelAt10x * cssPixelsPerImagePixel) / micronsPerPixel
}

/**
 * 允许的最大屏幕比例（CSS 像素）：不把第 0 层像素放大到一个屏幕像素以上，也不超过 20 倍；
 * 第 0 层本身高于 20 倍时，上限按 20 倍对应的比例收紧。
 */
export function maxScreenScale(micronsPerPixel: number): number {
  return Math.min(1, (maxSlideMagnification * micronsPerPixel) / (micronsPerPixelAt10x * 10))
}

/** 倍率读数：保留三位有效数字，最高显示 20×。 */
export function formatMagnification(magnification: number): string {
  return `${Number(Math.min(maxSlideMagnification, magnification).toPrecision(3))}×`
}
