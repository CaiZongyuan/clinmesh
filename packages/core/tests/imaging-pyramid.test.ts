import { describe, expect, it } from 'vitest'
import {
  formatMagnification,
  imageToLevel,
  levelDownsample,
  levelToImage,
  magnificationAt,
  maxScreenScale,
  selectPyramidLevel,
  tileAtLevelPoint,
  tileGrid,
  tileRegion,
  type PyramidLevel,
} from '../src/imaging-pyramid.ts'

// 原生 20× 切片的典型层级：20×、10×、5× 之后跳到 1.25×（相差 4 倍），最低层尺寸取整后两轴倍数不同。
const levels: PyramidLevel[] = [
  { height: 700, micronsPerPixel: 0.5, tileHeight: 256, tileWidth: 256, width: 1000 },
  { height: 350, micronsPerPixel: 1, tileHeight: 256, tileWidth: 256, width: 500 },
  { height: 175, micronsPerPixel: 2, tileHeight: 128, tileWidth: 128, width: 250 },
  { height: 43, micronsPerPixel: 8, tileHeight: 128, tileWidth: 128, width: 62 },
]

describe('slide pyramid geometry', () => {
  it('derives per-axis downsample from level sizes and converts between image and level coordinates', () => {
    expect(levelDownsample(levels, 0)).toEqual({ x: 1, y: 1 })
    expect(levelDownsample(levels, 2)).toEqual({ x: 4, y: 4 })
    const lowest = levelDownsample(levels, 3)
    expect(lowest.x).toBeCloseTo(1000 / 62, 12)
    expect(lowest.y).toBeCloseTo(700 / 43, 12)
    expect(imageToLevel(levels, 1, { x: 600, y: 300 })).toEqual({ x: 300, y: 150 })
    expect(levelToImage(levels, 2, { x: 128, y: 100 })).toEqual({ x: 512, y: 400 })
    // 最低层的右下角回到图像右下角，不因两轴倍数不同而偏移。
    const corner = levelToImage(levels, 3, { x: 62, y: 43 })
    expect(corner.x).toBeCloseTo(1000, 9)
    expect(corner.y).toBeCloseTo(700, 9)
  })

  it('selects the sharpest level whose pixel still covers at least half a device pixel', () => {
    expect(selectPyramidLevel(levels, 1)).toBe(0)
    expect(selectPyramidLevel(levels, 0.5)).toBe(0)
    expect(selectPyramidLevel(levels, 0.49)).toBe(1)
    expect(selectPyramidLevel(levels, 0.25)).toBe(1)
    expect(selectPyramidLevel(levels, 0.2)).toBe(2)
    // 5× 到 1.25× 之间没有层级：一个 5× 像素不足半个设备像素时直接用 1.25×，不读取超出显示所需的层级。
    expect(selectPyramidLevel(levels, 0.13)).toBe(2)
    expect(selectPyramidLevel(levels, 0.12)).toBe(3)
    // 缩得比最低层还小时仍显示最低层。
    expect(selectPyramidLevel(levels, 0.001)).toBe(3)
  })

  it('lays out the tile grid, truncates edge tiles to the level size and locates the tile under a point', () => {
    expect(tileGrid(levels[0]!)).toEqual({ columns: 4, rows: 3 })
    expect(tileGrid(levels[1]!)).toEqual({ columns: 2, rows: 2 })
    expect(tileGrid(levels[3]!)).toEqual({ columns: 1, rows: 1 })
    expect(tileRegion(levels, 0, { column: 3, row: 2 })).toEqual({ height: 188, width: 232, x: 768, y: 512 })
    expect(tileRegion(levels, 1, { column: 1, row: 1 })).toEqual({ height: 188, width: 488, x: 512, y: 512 })
    expect(tileAtLevelPoint(levels[0]!, { x: 999.5, y: 0 })).toEqual({ column: 3, row: 0 })
    expect(tileAtLevelPoint(levels[0]!, { x: 1000, y: 700 })).toEqual({ column: 3, row: 2 })
  })

  it('derives the magnification readout from pixel spacing and caps it at 20×', () => {
    expect(magnificationAt(0.5, 1)).toBe(20)
    expect(magnificationAt(0.5, 0.5)).toBe(10)
    expect(magnificationAt(0.2527, 1)).toBeCloseTo(39.57, 2)
    expect(formatMagnification(magnificationAt(0.5, 0.0625))).toBe('1.25×')
    expect(formatMagnification(magnificationAt(0.5, 0.483))).toBe('9.66×')
    expect(formatMagnification(magnificationAt(0.4942, 1))).toBe('20×')
    expect(formatMagnification(magnificationAt(0.2527, 1))).toBe('20×')
    // 原生 20× 不放大到像素以上；第 0 层高于 20× 时缩放上限按 20× 收紧。
    expect(maxScreenScale(0.5)).toBe(1)
    expect(maxScreenScale(1)).toBe(1)
    expect(maxScreenScale(0.25)).toBe(0.5)
    expect(magnificationAt(0.25, maxScreenScale(0.25))).toBe(20)
  })
})
