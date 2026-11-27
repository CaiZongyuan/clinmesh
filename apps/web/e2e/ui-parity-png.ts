import { deflateSync, inflateSync } from 'node:zlib'

export interface DecodedPng {
  width: number
  height: number
  rgba: Uint8Array
}

export interface PngDiffResult {
  width: number
  height: number
  dimensionMismatch: boolean
  totalPixels: number
  diffPixels: number
  diffRatio: number
  bodyTotalPixels: number
  bodyDiffPixels: number
  bodyDiffRatio: number
  diffPng?: Buffer
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

export function decodePng(buffer: Buffer): DecodedPng {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG signature')
  }
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idatChunks: Buffer[] = []

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]!
      colorType = data[9]!
      if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
        throw new Error(`Unsupported PNG format: bitDepth=${bitDepth}, colorType=${colorType}`)
      }
    } else if (type === 'IDAT') {
      idatChunks.push(data)
    } else if (type === 'IEND') {
      break
    }
  }

  const raw = inflateSync(Buffer.concat(idatChunks))
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const reconstructed = new Uint8Array(height * stride)

  let src = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[src++]!
    const rowOffset = y * stride
    const prevOffset = (y - 1) * stride
    for (let x = 0; x < stride; x++) {
      const value = raw[src++]!
      const left = x >= channels ? reconstructed[rowOffset + x - channels]! : 0
      const up = y > 0 ? reconstructed[prevOffset + x]! : 0
      const upLeft = y > 0 && x >= channels ? reconstructed[prevOffset + x - channels]! : 0
      let decoded: number
      if (filter === 0) decoded = value
      else if (filter === 1) decoded = (value + left) & 0xff
      else if (filter === 2) decoded = (value + up) & 0xff
      else if (filter === 3) decoded = (value + ((left + up) >> 1)) & 0xff
      else if (filter === 4) decoded = (value + paethPredictor(left, up, upLeft)) & 0xff
      else throw new Error(`Unsupported PNG filter: ${filter}`)
      reconstructed[rowOffset + x] = decoded
    }
  }

  if (channels === 4) {
    return { width, height, rgba: reconstructed }
  }

  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < reconstructed.length; i += 3, j += 4) {
    rgba[j] = reconstructed[i]!
    rgba[j + 1] = reconstructed[i + 1]!
    rgba[j + 2] = reconstructed[i + 2]!
    rgba[j + 3] = 255
  }
  return { width, height, rgba }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let c = 0xffffffff
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function makeChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4
  const scanlines = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1)
    scanlines[dst] = 0
    scanlines.set(rgba.subarray(y * stride, (y + 1) * stride), dst + 1)
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', deflateSync(scanlines)),
    makeChunk('IEND', Buffer.alloc(0)),
  ])
}

export function diffPngBuffers(
  baselineBuffer: Buffer,
  actualBuffer: Buffer,
  options: { channelTolerance?: number; headerHeightPx?: number } = {},
): PngDiffResult {
  const tolerance = options.channelTolerance ?? 2
  const headerHeightPx = options.headerHeightPx ?? 49
  const base = decodePng(baselineBuffer)
  const actual = decodePng(actualBuffer)

  if (base.width !== actual.width || base.height !== actual.height) {
    const total = Math.max(base.width * base.height, actual.width * actual.height)
    return {
      width: actual.width,
      height: actual.height,
      dimensionMismatch: true,
      totalPixels: total,
      diffPixels: total,
      diffRatio: 1,
      bodyTotalPixels: total,
      bodyDiffPixels: total,
      bodyDiffRatio: 1,
    }
  }

  const totalPixels = base.width * base.height
  const diffRgba = new Uint8Array(totalPixels * 4)
  let diffPixels = 0
  let bodyTotalPixels = 0
  let bodyDiffPixels = 0

  for (let y = 0; y < base.height; y++) {
    const inBody = y >= headerHeightPx
    for (let x = 0; x < base.width; x++) {
      const idx = (y * base.width + x) * 4
      const dr = Math.abs(base.rgba[idx]! - actual.rgba[idx]!)
      const dg = Math.abs(base.rgba[idx + 1]! - actual.rgba[idx + 1]!)
      const db = Math.abs(base.rgba[idx + 2]! - actual.rgba[idx + 2]!)
      const da = Math.abs(base.rgba[idx + 3]! - actual.rgba[idx + 3]!)
      const changed = dr > tolerance || dg > tolerance || db > tolerance || da > tolerance
      if (inBody) bodyTotalPixels++
      if (changed) {
        diffPixels++
        if (inBody) bodyDiffPixels++
        diffRgba[idx] = 255
        diffRgba[idx + 1] = 32
        diffRgba[idx + 2] = 96
        diffRgba[idx + 3] = 255
      } else {
        const lum = Math.round(
          (actual.rgba[idx]! * 0.299 + actual.rgba[idx + 1]! * 0.587 + actual.rgba[idx + 2]! * 0.114) * 0.35 + 160,
        )
        diffRgba[idx] = lum
        diffRgba[idx + 1] = lum
        diffRgba[idx + 2] = lum
        diffRgba[idx + 3] = 255
      }
    }
  }

  return {
    width: base.width,
    height: base.height,
    dimensionMismatch: false,
    totalPixels,
    diffPixels,
    diffRatio: totalPixels > 0 ? diffPixels / totalPixels : 0,
    bodyTotalPixels,
    bodyDiffPixels,
    bodyDiffRatio: bodyTotalPixels > 0 ? bodyDiffPixels / bodyTotalPixels : 0,
    ...(diffPixels > 0 ? { diffPng: encodePng(base.width, base.height, diffRgba) } : {}),
  }
}
