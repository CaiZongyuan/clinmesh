/**
 * 灰度影像（CT 与胸片）的显示规则。全部是不依赖 DOM、Node 或浏览器 API 的纯函数，
 * 浏览器阅片器与服务端渲染使用同一组规则，保证同一像素在各处显示一致。
 */

export type PixelFormat = 'int16' | 'uint16'
export type PixelArray = Int16Array | Uint16Array

export interface DisplayWindow {
  center: number
  width: number
}

interface FrameShape {
  blocks: ReadonlyArray<{ length: number; rowCount: number; rowStart: number }>
  columns: number
  rows: number
}

/** CT 显示预设，单位为 HU。 */
export const ctWindowPresets = [
  { center: -600, id: 'lung', width: 1500 },
  { center: 40, id: 'mediastinum', width: 400 },
  { center: 300, id: 'bone', width: 1500 },
] as const

/** 按小端序解码 16 位像素；逐字节读取，结果不随运行平台的字节序变化。 */
export function decodePixels(bytes: Uint8Array, pixelFormat: PixelFormat): PixelArray {
  if (bytes.byteLength % 2 !== 0) throw new RangeError('16-bit pixel data must have an even byte length')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const pixels = pixelFormat === 'int16' ? new Int16Array(bytes.byteLength / 2) : new Uint16Array(bytes.byteLength / 2)
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = pixelFormat === 'int16' ? view.getInt16(index * 2, true) : view.getUint16(index * 2, true)
  }
  return pixels
}

/** 把一帧按行切分的像素块拼成完整帧；块的数量或长度与描述不符时拒绝。 */
export function assembleFrame(frame: FrameShape, blocks: readonly Uint8Array[], pixelFormat: PixelFormat): PixelArray {
  if (blocks.length !== frame.blocks.length) throw new RangeError('The frame block count does not match its description')
  const pixels = pixelFormat === 'int16'
    ? new Int16Array(frame.columns * frame.rows)
    : new Uint16Array(frame.columns * frame.rows)
  for (const [index, description] of frame.blocks.entries()) {
    const block = blocks[index]!
    if (block.byteLength !== description.length || description.length !== description.rowCount * frame.columns * 2) {
      throw new RangeError('A pixel block does not match its description')
    }
    pixels.set(decodePixels(block, pixelFormat), description.rowStart * frame.columns)
  }
  return pixels
}

/** DICOM 线性窗：把一个像素值映射为 0–255 的灰度。 */
export function windowedGray(value: number, displayWindow: DisplayWindow): number {
  const center = displayWindow.center - 0.5
  const range = Math.max(1, displayWindow.width) - 1
  if (value <= center - range / 2) return 0
  if (value > center + range / 2) return 255
  return Math.round(((value - center) / range + 0.5) * 255)
}

/**
 * 渲染为不透明的 RGBA 灰度；`invert` 反转黑白。先按窗算出整个 16 位取值范围的灰度查找表，
 * 每个像素只查表，大幅胸片连续调窗时不逐像素做窗运算。传入 `output` 时写入并复用该缓冲区。
 */
export function renderGrayscale(input: {
  invert?: boolean
  output?: Uint8ClampedArray
  pixels: PixelArray
  window: DisplayWindow
}): Uint8ClampedArray {
  const offset = input.pixels instanceof Int16Array ? 32768 : 0
  const table = new Uint8Array(65536)
  for (let index = 0; index < table.length; index += 1) {
    const gray = windowedGray(index - offset, input.window)
    table[index] = input.invert === true ? 255 - gray : gray
  }
  const output = input.output ?? new Uint8ClampedArray(input.pixels.length * 4)
  for (let index = 0; index < input.pixels.length; index += 1) {
    const shown = table[input.pixels[index]! + offset]!
    output[index * 4] = shown
    output[index * 4 + 1] = shown
    output[index * 4 + 2] = shown
    output[index * 4 + 3] = 255
  }
  return output
}

/** CT 默认肺窗；胸片使用安装时算出的默认窗，缺少时显示全部 16 位范围。 */
export function defaultDisplayWindow(
  series: { valueUnit: 'hu' | 'stored' },
  frame: { window?: DisplayWindow | undefined },
): DisplayWindow {
  if (series.valueUnit === 'hu') return { center: ctWindowPresets[0].center, width: ctWindowPresets[0].width }
  return frame.window ?? { center: 32768, width: 65536 }
}

export function adjustDisplayWindow(
  displayWindow: DisplayWindow,
  delta: { center: number; width: number },
): DisplayWindow {
  return {
    center: displayWindow.center + delta.center,
    width: Math.max(1, displayWindow.width + delta.width),
  }
}

/** 显示宽高比按物理尺寸计算；`pixelSpacingMm` 为 [行间距, 列间距]，缺少时按像素数。 */
export function displayAspectRatio(frame: {
  columns: number
  pixelSpacingMm: readonly [number, number] | null
  rows: number
}): number {
  const [rowSpacing, columnSpacing] = frame.pixelSpacingMm ?? [1, 1]
  return (frame.columns * columnSpacing) / (frame.rows * rowSpacing)
}

/** 在视口内等比放置图像：先完整适配视口，再按缩放放大并按平移偏移。 */
export function fitImage(input: {
  aspectRatio: number
  panX: number
  panY: number
  viewportHeight: number
  viewportWidth: number
  zoom: number
}): { height: number; width: number; x: number; y: number } {
  const fitsWidth = input.viewportWidth / input.viewportHeight <= input.aspectRatio
  const width = (fitsWidth ? input.viewportWidth : input.viewportHeight * input.aspectRatio) * input.zoom
  const height = (fitsWidth ? input.viewportWidth / input.aspectRatio : input.viewportHeight) * input.zoom
  return {
    height,
    width,
    x: (input.viewportWidth - width) / 2 + input.panX,
    y: (input.viewportHeight - height) / 2 + input.panY,
  }
}

export function clampFrameIndex(index: number, frameCount: number): number {
  return Math.min(Math.max(0, index), Math.max(0, frameCount - 1))
}
