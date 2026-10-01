import { describe, expect, it } from 'vitest'
import {
  adjustDisplayWindow,
  assembleFrame,
  clampFrameIndex,
  ctWindowPresets,
  decodePixels,
  defaultDisplayWindow,
  displayAspectRatio,
  fitImage,
  renderGrayscale,
  windowedGray,
} from '../src/imaging-display.ts'

describe('imaging display rules', () => {
  it('decodes little-endian 16-bit pixels the same way on every platform', () => {
    const bytes = Uint8Array.from([0x00, 0xfc, 0xff, 0x0b])
    expect(Array.from(decodePixels(bytes, 'int16'))).toEqual([-1024, 3071])
    expect(Array.from(decodePixels(bytes, 'uint16'))).toEqual([64512, 3071])
    // 像素块可能位于更大缓冲区的任意偏移。
    const shifted = new Uint8Array([9, ...bytes]).subarray(1)
    expect(Array.from(decodePixels(shifted, 'int16'))).toEqual([-1024, 3071])
  })

  it('assembles row blocks into one frame and rejects blocks that do not match the description', () => {
    const frame = {
      blocks: [{ length: 8, rowCount: 2, rowStart: 0 }, { length: 4, rowCount: 1, rowStart: 2 }],
      columns: 2,
      rows: 3,
    }
    const first = new Uint8Array(new Int16Array([1, 2, 3, 4]).buffer)
    const second = new Uint8Array(new Int16Array([5, 6]).buffer)
    expect(Array.from(assembleFrame(frame, [first, second], 'int16'))).toEqual([1, 2, 3, 4, 5, 6])
    expect(() => assembleFrame(frame, [first], 'int16')).toThrow()
    expect(() => assembleFrame(frame, [first, first], 'int16')).toThrow()
  })

  it('maps values through the linear window used for HU and stored values', () => {
    const lung = ctWindowPresets.find(preset => preset.id === 'lung')!
    const mediastinum = ctWindowPresets.find(preset => preset.id === 'mediastinum')!
    expect(lung).toMatchObject({ center: -600, width: 1500 })
    expect([-1400, -1350, -600, 150, 400].map(value => windowedGray(value, lung))).toEqual([0, 0, 128, 255, 255])
    expect([-200, -160, 40, 240].map(value => windowedGray(value, mediastinum))).toEqual([0, 0, 128, 255])
    // 同一 HU 在肺窗与纵隔窗下灰度不同：软组织在肺窗中接近白，在纵隔窗中是中灰。
    expect(windowedGray(40, lung)).toBeGreaterThan(windowedGray(40, mediastinum))
    // 窗宽为 1 时退化为阈值：不大于 center - 0.5 的值为黑，其余为白。
    expect(windowedGray(4, { center: 5, width: 1 })).toBe(0)
    expect(windowedGray(5, { center: 5, width: 1 })).toBe(255)
  })

  it('renders opaque gray RGBA and inverts on request', () => {
    const pixels = new Int16Array([-1350, -600, 150])
    const window = { center: -600, width: 1500 }
    expect(Array.from(renderGrayscale({ pixels, window }))).toEqual([
      0, 0, 0, 255,
      128, 128, 128, 255,
      255, 255, 255, 255,
    ])
    expect(Array.from(renderGrayscale({ invert: true, pixels, window }))).toEqual([
      255, 255, 255, 255,
      127, 127, 127, 255,
      0, 0, 0, 255,
    ])
  })

  it('renders every 16-bit value exactly as the window function and reuses a given buffer', () => {
    const window = { center: 1889, width: 1917 }
    const unsigned = Uint16Array.from({ length: 65536 }, (_, index) => index)
    const signed = Int16Array.from({ length: 65536 }, (_, index) => index - 32768)
    for (const pixels of [unsigned, signed]) {
      const rendered = renderGrayscale({ pixels, window })
      expect(Array.from(pixels).every((value, index) => rendered[index * 4] === windowedGray(value, window))).toBe(true)
    }
    const output = new Uint8ClampedArray(8)
    expect(renderGrayscale({ invert: true, output, pixels: new Uint16Array([0, 65535]), window })).toBe(output)
    expect(Array.from(output)).toEqual([255, 255, 255, 255, 0, 0, 0, 255])
  })

  it('chooses the default window from the value unit and the frame', () => {
    expect(defaultDisplayWindow({ valueUnit: 'hu' }, {})).toEqual({ center: -600, width: 1500 })
    expect(defaultDisplayWindow({ valueUnit: 'stored' }, { window: { center: 1889, width: 1917 } }))
      .toEqual({ center: 1889, width: 1917 })
    expect(defaultDisplayWindow({ valueUnit: 'stored' }, {})).toEqual({ center: 32768, width: 65536 })
    expect(adjustDisplayWindow({ center: 40, width: 400 }, { center: 10, width: -500 })).toEqual({ center: 50, width: 1 })
  })

  it('keeps the physical aspect ratio and places the image inside the viewport', () => {
    expect(displayAspectRatio({ columns: 512, pixelSpacingMm: [0.7, 0.7], rows: 512 })).toBe(1)
    // 间距顺序为 [行间距, 列间距]：宽度按列间距、高度按行间距计算。
    expect(displayAspectRatio({ columns: 3, pixelSpacingMm: [0.7, 0.8], rows: 2 })).toBeCloseTo(2.4 / 1.4)
    expect(displayAspectRatio({ columns: 1736, pixelSpacingMm: null, rows: 2022 })).toBeCloseTo(1736 / 2022)

    expect(fitImage({ aspectRatio: 2, panX: 0, panY: 0, viewportHeight: 100, viewportWidth: 100, zoom: 1 }))
      .toEqual({ height: 50, width: 100, x: 0, y: 25 })
    expect(fitImage({ aspectRatio: 0.5, panX: 0, panY: 0, viewportHeight: 100, viewportWidth: 100, zoom: 1 }))
      .toEqual({ height: 100, width: 50, x: 25, y: 0 })
    expect(fitImage({ aspectRatio: 2, panX: 10, panY: -5, viewportHeight: 100, viewportWidth: 100, zoom: 2 }))
      .toEqual({ height: 100, width: 200, x: -40, y: -5 })
  })

  it('keeps frame navigation inside the series', () => {
    expect([-3, 0, 2, 9].map(index => clampFrameIndex(index, 3))).toEqual([0, 0, 2, 2])
  })
})
