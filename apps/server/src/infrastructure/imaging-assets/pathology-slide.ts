import openJpegFactory from '@cornerstonejs/codec-openjpeg/decodewasmjs'
import { createHash } from 'node:crypto'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import dcmjs from 'dcmjs'
import jpeg from 'jpeg-js'
import { maximumPixelBlockBytes, numberAttribute, numberList, textAttribute } from './dicom-canonical.ts'
import { ImagingAssetError, sha256 } from './imaging-pack-store.ts'
import type { PathologyAssetOutput, PathologyLevelOutput } from './pathology-catalog.ts'

/**
 * 摄取规则版本；层级选择、转码、降采样或打包格式变化会改变输出字节，必须递增并重新登记输出哈希。
 * 编码与解码库的版本同时记录在输出参数中，升级依赖同样需要重新登记。
 */
export const pathologyIngestVersion = 1

/** 固定的摄取参数；库版本与 `apps/server/package.json` 锁定的版本一致，由测试核对。 */
export const pathologyIngestParameters: PathologyAssetOutput['parameters'] = {
  downsample: {
    domain: 'srgb-code-values',
    edge: 'in-bounds-mean',
    method: 'box',
    padding: 'white',
    rounding: 'half-up',
  },
  jpeg2000Decoder: { library: '@cornerstonejs/codec-openjpeg', version: '1.3.6' },
  jpegEncoder: {
    chromaSubsampling: '4:4:4',
    colorModel: 'YCbCr',
    library: 'jpeg-js',
    process: 'baseline',
    quality: 85,
    version: '0.4.4',
  },
}

const wholeSlideImageStorage = '1.2.840.10008.5.1.4.1.1.77.1.6'
const jpegBaseline = '1.2.840.10008.1.2.4.50'
const jpeg2000Syntaxes = new Set(['1.2.840.10008.1.2.4.90', '1.2.840.10008.1.2.4.91'])
const explicitVrLittleEndian = '1.2.840.10008.1.2.1'
/** 安装的最高倍率；更高倍率的层级只作为降采样来源。 */
const maximumMagnification = 20
const twentyTimesMicronsPerPixel = 0.5
const magnificationTolerance = 0.05
const jpegColorModels: Record<string, JpegColorModel> = { RGB: 'RGB', YBR_FULL: 'YCbCr', YBR_FULL_422: 'YCbCr' }
const jpeg2000Photometrics = new Set(['RGB', 'YBR_ICT', 'YBR_RCT'])

function invalid(message: string): ImagingAssetError {
  return new ImagingAssetError('PATHOLOGY_DICOM_INVALID', message)
}

type Dataset = Record<string, unknown>

function requiredNumber(dataset: Dataset, name: string): number {
  const value = numberAttribute(dataset, name)
  if (value === undefined) throw invalid(`The DICOM attribute ${name} is required`)
  return value
}

/** 序列的第一个条目；dcmjs 把序列还原为条目数组。 */
function firstItem(dataset: Dataset | undefined, name: string): Dataset | undefined {
  const items = dataset?.[name]
  return Array.isArray(items) ? items[0] as Dataset | undefined : undefined
}

/** 一个来源实例中摄取需要的属性与按帧切分的压缩码流。 */
export interface SlideInstance {
  columns: number
  dimensionOrganization?: string | undefined
  frames: Uint8Array[]
  iccProfile?: Uint8Array | undefined
  imageType: string[]
  numberOfFrames: number
  photometric?: string | undefined
  pixelSpacingMm?: [number, number] | undefined
  rows: number
  seriesInstanceUid?: string | undefined
  sopClassUid?: string | undefined
  sopInstanceUid?: string | undefined
  studyInstanceUid?: string | undefined
  totalColumns?: number | undefined
  totalRows?: number | undefined
  transferSyntaxUid: string
  /** 其余必须为单值或缺省的属性，用于拒绝摄取不支持的组织方式。 */
  unsupported: string[]
  samples: { bitsAllocated?: number | undefined; bitsStored?: number | undefined; planar?: number | undefined; representation?: number | undefined; samplesPerPixel?: number | undefined }
}

function readDicom(bytes: Uint8Array, options?: { ignoreErrors: boolean }): { dataset: Dataset; meta: Dataset } {
  let dictionary
  try {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    dictionary = dcmjs.data.DicomMessage.readFile(buffer, options)
  } catch (error) {
    throw invalid(`The DICOM instance cannot be parsed: ${String(error)}`)
  }
  return {
    dataset: dcmjs.data.DicomMetaDictionary.naturalizeDataset(dictionary.dict),
    meta: dcmjs.data.DicomMetaDictionary.naturalizeDataset(dictionary.meta),
  }
}

/**
 * 从文件开头的字节读取 File Meta 中的 MediaStorageSOPInstanceUID，用于在不下载整个实例时识别它。
 * 数据集在片段末尾被截断，因此忽略数据集的解析错误，只取完整的 File Meta。
 */
export function dicomMetaSopInstanceUid(head: Uint8Array): string | undefined {
  return textAttribute(readDicom(head, { ignoreErrors: true }).meta, 'MediaStorageSOPInstanceUID')
}

/** 解析一个切片 DICOM 实例；封装像素数据按片段切分，基本偏移表允许为空。 */
export function parseSlideInstance(bytes: Uint8Array): SlideInstance {
  const { dataset, meta } = readDicom(bytes)
  const transferSyntaxUid = textAttribute(meta, 'TransferSyntaxUID') ?? ''
  const pixelData = dataset.PixelData
  // 封装像素数据由 dcmjs 按片段切分，每个片段对应一帧；未压缩的像素数据不切分，由后续的压缩方式检查拒绝。
  const frames = transferSyntaxUid !== explicitVrLittleEndian && Array.isArray(pixelData)
    ? pixelData.map(frame => new Uint8Array(frame as ArrayBuffer))
    : []
  const spacing = numberList(firstItem(firstItem(dataset, 'SharedFunctionalGroupsSequence'), 'PixelMeasuresSequence') ?? {}, 'PixelSpacing', 2)
  const opticalPaths = dataset.OpticalPathSequence
  const opticalPath = firstItem(dataset, 'OpticalPathSequence')
  const iccProfile = Array.isArray(opticalPath?.ICCProfile) ? opticalPath.ICCProfile[0] as ArrayBuffer | undefined : undefined
  const unsupported: string[] = []
  if (dataset.ConcatenationUID !== undefined) unsupported.push('concatenation')
  if ((Array.isArray(opticalPaths) && opticalPaths.length > 1) || (numberAttribute(dataset, 'NumberOfOpticalPaths') ?? 1) > 1) {
    unsupported.push('multiple optical paths')
  }
  if ((numberAttribute(dataset, 'TotalPixelMatrixFocalPlanes') ?? 1) > 1) unsupported.push('multiple focal planes')
  if (textAttribute(dataset, 'BurnedInAnnotation') === 'YES') unsupported.push('burned-in annotation')
  return {
    columns: requiredNumber(dataset, 'Columns'),
    dimensionOrganization: textAttribute(dataset, 'DimensionOrganizationType'),
    frames,
    iccProfile: iccProfile === undefined ? undefined : new Uint8Array(iccProfile),
    imageType: Array.isArray(dataset.ImageType) ? dataset.ImageType.map(String) : (textAttribute(dataset, 'ImageType') ?? '').split('\\'),
    numberOfFrames: numberAttribute(dataset, 'NumberOfFrames') ?? 1,
    photometric: textAttribute(dataset, 'PhotometricInterpretation'),
    pixelSpacingMm: spacing?.every(value => value > 0) === true ? [spacing[0]!, spacing[1]!] : undefined,
    rows: requiredNumber(dataset, 'Rows'),
    samples: {
      bitsAllocated: numberAttribute(dataset, 'BitsAllocated'),
      bitsStored: numberAttribute(dataset, 'BitsStored'),
      planar: numberAttribute(dataset, 'PlanarConfiguration'),
      representation: numberAttribute(dataset, 'PixelRepresentation'),
      samplesPerPixel: numberAttribute(dataset, 'SamplesPerPixel'),
    },
    seriesInstanceUid: textAttribute(dataset, 'SeriesInstanceUID'),
    sopClassUid: textAttribute(dataset, 'SOPClassUID'),
    sopInstanceUid: textAttribute(dataset, 'SOPInstanceUID'),
    studyInstanceUid: textAttribute(dataset, 'StudyInstanceUID'),
    totalColumns: numberAttribute(dataset, 'TotalPixelMatrixColumns'),
    totalRows: numberAttribute(dataset, 'TotalPixelMatrixRows'),
    transferSyntaxUid,
    unsupported,
  }
}

export type JpegColorModel = 'RGB' | 'YCbCr'

/**
 * 检查一个 JPEG 瓦片的码流：基线 DCT、8 位三分量、尺寸与瓦片一致，只含 JFIF/Adobe 应用段，不含注释段。
 * 返回浏览器解码时使用的颜色模型，规则与 libjpeg 一致：有 JFIF 段为 YCbCr；否则 Adobe APP14 transform=0 为 RGB；
 * 两者都没有时分量标识为 R、G、B 的是 RGB，其余为 YCbCr。`explicit` 表示码流自身给出了颜色依据
 *（JFIF、Adobe、RGB 分量标识或色度降采样）；没有依据的码流只能按 DICOM 声明的颜色空间解释。
 */
export function inspectJpegTile(tile: Uint8Array, width: number, height: number): { explicit: boolean; model: JpegColorModel } {
  const reject = (reason: string) => new ImagingAssetError('PATHOLOGY_TILE_INVALID', `A JPEG tile ${reason}`)
  // DICOM 片段按偶数长度存储，奇数长度的码流后补一个 0x00。
  const end = tile.at(-1) === 0 ? tile.byteLength - 1 : tile.byteLength
  if (tile[0] !== 0xff || tile[1] !== 0xd8 || tile[end - 2] !== 0xff || tile[end - 1] !== 0xd9) {
    throw reject('does not start with SOI and end with EOI')
  }
  let offset = 2
  let frame: { componentIds: string; height: number; precision: number; subsampled: boolean; width: number } | undefined
  let jfif = false
  let adobeTransform: number | undefined
  while (offset + 4 <= end) {
    if (tile[offset] !== 0xff) throw reject('has a malformed marker segment')
    const marker = tile[offset + 1]!
    const length = (tile[offset + 2]! << 8) | tile[offset + 3]!
    const segment = tile.subarray(offset + 4, offset + 2 + length)
    if (marker === 0xda) break
    if (marker === 0xfe) throw reject('carries a comment segment')
    if (marker >= 0xe1 && marker <= 0xef && marker !== 0xee) throw reject('carries an unsupported application segment')
    if (marker === 0xe0) jfif ||= Buffer.from(segment.subarray(0, 4)).toString('latin1') === 'JFIF'
    if (marker === 0xee && Buffer.from(segment.subarray(0, 5)).toString('latin1') === 'Adobe') adobeTransform = segment[11]
    if (marker >= 0xc1 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      throw reject('is not baseline DCT')
    }
    if (marker === 0xc0) {
      const threeComponents = segment[5] === 3
      frame = {
        componentIds: threeComponents ? String.fromCharCode(segment[6]!, segment[9]!, segment[12]!) : '',
        height: (segment[1]! << 8) | segment[2]!,
        precision: segment[0]!,
        subsampled: threeComponents && (segment[7] !== segment[10] || segment[7] !== segment[13]),
        width: (segment[3]! << 8) | segment[4]!,
      }
    }
    offset += 2 + length
  }
  if (frame === undefined) throw reject('has no baseline frame header')
  if (frame.precision !== 8 || frame.componentIds === '') throw reject('is not 8-bit three-component')
  if (frame.width !== width || frame.height !== height) throw reject(`is ${frame.width}x${frame.height}, expected ${width}x${height}`)
  if (jfif) return { explicit: true, model: 'YCbCr' }
  if (adobeTransform !== undefined) return { explicit: true, model: adobeTransform === 0 ? 'RGB' : 'YCbCr' }
  if (frame.componentIds === 'RGB') return { explicit: true, model: 'RGB' }
  return { explicit: frame.subsampled, model: 'YCbCr' }
}

/** 按码流的颜色模型解码 JPEG 瓦片为交错 RGB，与浏览器解码一致。 */
function decodeJpegTile(tile: Uint8Array, model: JpegColorModel): Uint8Array {
  try {
    return jpeg.decode(tile, {
      colorTransform: model === 'YCbCr',
      formatAsRGBA: false,
      tolerantDecoding: false,
      useTArray: true,
    }).data
  } catch (error) {
    throw new ImagingAssetError('PATHOLOGY_TILE_INVALID', `A JPEG tile cannot be decoded: ${String(error)}`)
  }
}

type OpenJpegDecoder = InstanceType<Awaited<ReturnType<typeof openJpegFactory>>['J2KDecoder']>
let openJpegDecoder: Promise<OpenJpegDecoder> | undefined

/** 用 OpenJPEG 解码 JPEG 2000 瓦片为交错 RGB；码流须为单一瓦片尺寸的 8 位无符号三分量。 */
async function decodeJpeg2000Tile(tile: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const reject = (reason: string) => new ImagingAssetError('PATHOLOGY_TILE_INVALID', `A JPEG 2000 tile ${reason}`)
  if (tile[0] !== 0xff || tile[1] !== 0x4f || tile[2] !== 0xff || tile[3] !== 0x51) throw reject('is not a raw codestream')
  // OpenJPEG 逐瓦片向标准输出打印解码日志；失败以异常报告，不依赖日志。
  openJpegDecoder ??= openJpegFactory({ print: () => {}, printErr: () => {} }).then(module => new module.J2KDecoder())
  const decoder = await openJpegDecoder
  try {
    decoder.getEncodedBuffer(tile.byteLength).set(tile)
    decoder.decode()
  } catch (error) {
    throw reject(`cannot be decoded: ${String(error)}`)
  }
  const info = decoder.getFrameInfo()
  if (info.width !== width || info.height !== height || info.componentCount !== 3 || info.bitsPerSample !== 8 || info.isSigned) {
    throw reject(`decodes to ${info.width}x${info.height}x${info.componentCount} at ${info.bitsPerSample} bits, expected ${width}x${height} RGB`)
  }
  return decoder.getDecodedBuffer().slice()
}

/** 以固定参数把交错 RGB 瓦片编码为基线 JPEG（jpeg-js：JFIF、YCbCr 4:4:4）。 */
function encodeJpegTile(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  for (let source = 0, target = 0; source < rgb.length; source += 3, target += 4) {
    rgba[target] = rgb[source]!
    rgba[target + 1] = rgb[source + 1]!
    rgba[target + 2] = rgb[source + 2]!
    rgba[target + 3] = 255
  }
  return new Uint8Array(jpeg.encode({ data: rgba, height, width }, pathologyIngestParameters.jpegEncoder.quality).data)
}

interface SourceLevel {
  codec: 'jpeg-baseline' | 'jpeg2000'
  frames: Uint8Array[]
  height: number
  iccProfile?: Uint8Array | undefined
  input: number
  /** 每个 JPEG 瓦片解码时使用的颜色模型，与浏览器解码一致。 */
  jpegModels?: JpegColorModel[]
  magnification: number
  micronsPerPixel: number
  tileHeight: number
  tileWidth: number
  tilesAcross: number
  tilesDown: number
  width: number
}

/** 名义倍率：20 倍对应 0.5 µm/像素，相邻名义倍率相差 2 倍；偏离名义值超过 5% 的层级不受支持。 */
function nominalMagnification(micronsPerPixel: number): number {
  const steps = Math.round(Math.log2(micronsPerPixel / twentyTimesMicronsPerPixel))
  if (Math.abs(micronsPerPixel / (twentyTimesMicronsPerPixel * 2 ** steps) - 1) > magnificationTolerance || steps < -1) {
    throw new ImagingAssetError('PATHOLOGY_LEVEL_UNSUPPORTED', `A pyramid level has an unsupported pixel spacing of ${micronsPerPixel} µm`)
  }
  return maximumMagnification / 2 ** steps
}

function roundMicrons(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** 校验一个组织金字塔层级的几何、像素格式与压缩方式，并检查每个瓦片码流的尺寸与颜色模型。 */
function sourceLevel(instance: SlideInstance, input: number): SourceLevel {
  const reject = (code: string, reason: string) => new ImagingAssetError(code, `Pyramid level ${instance.sopInstanceUid ?? '<none>'} ${reason}`)
  const isJpeg = instance.transferSyntaxUid === jpegBaseline
  if (!isJpeg && !jpeg2000Syntaxes.has(instance.transferSyntaxUid)) {
    throw reject('PATHOLOGY_TRANSFER_SYNTAX_UNSUPPORTED', `uses the unsupported transfer syntax ${instance.transferSyntaxUid}`)
  }
  if (instance.unsupported.length > 0) throw reject('PATHOLOGY_LEVEL_UNSUPPORTED', `uses ${instance.unsupported.join(', ')}`)
  const { bitsAllocated, bitsStored, planar, representation, samplesPerPixel } = instance.samples
  if (samplesPerPixel !== 3 || bitsAllocated !== 8 || bitsStored !== 8 || (representation ?? 0) !== 0 || (planar ?? 0) !== 0) {
    throw reject('PATHOLOGY_COLOR_UNSUPPORTED', 'is not 8-bit interleaved three-sample color')
  }
  const photometric = instance.photometric ?? ''
  // JPEG 瓦片由浏览器按码流自身的颜色标记解码；JPEG 2000 由 OpenJPEG 按码流解码为 RGB。
  const declaredModel = isJpeg ? jpegColorModels[photometric] : undefined
  if (isJpeg ? declaredModel === undefined : !jpeg2000Photometrics.has(photometric)) {
    throw reject('PATHOLOGY_COLOR_UNSUPPORTED', `uses the unsupported photometric interpretation ${photometric || '<none>'}`)
  }
  if (instance.dimensionOrganization !== 'TILED_FULL') throw reject('PATHOLOGY_LEVEL_UNSUPPORTED', 'is not TILED_FULL')
  const { pixelSpacingMm, totalColumns, totalRows } = instance
  if (pixelSpacingMm === undefined || totalColumns === undefined || totalRows === undefined) {
    throw reject('PATHOLOGY_DICOM_INVALID', 'lacks pixel spacing or total pixel matrix dimensions')
  }
  if (Math.abs(pixelSpacingMm[0] / pixelSpacingMm[1] - 1) > 0.01) throw reject('PATHOLOGY_LEVEL_UNSUPPORTED', 'has non-square pixels')
  const tilesAcross = Math.ceil(totalColumns / instance.columns)
  const tilesDown = Math.ceil(totalRows / instance.rows)
  if (instance.numberOfFrames !== tilesAcross * tilesDown || instance.frames.length !== instance.numberOfFrames) {
    throw reject('PATHOLOGY_LEVEL_UNSUPPORTED', 'does not store exactly one fragment per tile of the total pixel matrix')
  }
  // 码流自带颜色依据的瓦片以码流为准（同一层级可以混有不同编码的瓦片，例如来源的填充瓦片）；
  // 没有依据的瓦片，浏览器会按 YCbCr 解码，DICOM 声明为 RGB 时无法判断哪一个正确，整张拒绝。
  const jpegModels = isJpeg
    ? instance.frames.map((frame) => {
        const { explicit, model } = inspectJpegTile(frame, instance.columns, instance.rows)
        if (!explicit && model !== declaredModel) {
          throw reject('PATHOLOGY_COLOR_UNSUPPORTED', `has JPEG tiles without color markers that a browser would not decode as ${photometric}`)
        }
        return model
      })
    : undefined
  const micronsPerPixel = roundMicrons(pixelSpacingMm[1] * 1000)
  return {
    codec: isJpeg ? 'jpeg-baseline' : 'jpeg2000',
    frames: instance.frames,
    height: totalRows,
    iccProfile: instance.iccProfile,
    input,
    ...(jpegModels === undefined ? {} : { jpegModels }),
    magnification: nominalMagnification(micronsPerPixel),
    micronsPerPixel,
    tileHeight: instance.rows,
    tileWidth: instance.columns,
    tilesAcross,
    tilesDown,
    width: totalColumns,
  }
}

async function decodeSourceTile(level: SourceLevel, column: number, row: number): Promise<Uint8Array> {
  const index = row * level.tilesAcross + column
  const frame = level.frames[index]!
  return level.codec === 'jpeg2000'
    ? await decodeJpeg2000Tile(frame, level.tileWidth, level.tileHeight)
    : decodeJpegTile(frame, level.jpegModels![index]!)
}

/**
 * 按瓦片顺序写出一个层级：`<n>.tiles` 依次存放每个瓦片的 JPEG 码流，`<n>.index` 是 (瓦片数 + 1) 个
 * 小端 uint64 累计偏移，第 k 个瓦片（行优先）占 [offset[k], offset[k+1])。
 */
async function writeLevelPack(
  directory: string,
  levelIndex: number,
  tileCount: number,
  tileAt: (index: number) => Promise<Uint8Array>,
): Promise<{ index: { bytes: number; sha256: string }; tiles: PathologyLevelOutput['tiles'] }> {
  await mkdir(join(directory, 'levels'), { recursive: true })
  const handle = await open(join(directory, 'levels', `${levelIndex}.tiles`), 'w')
  const hash = createHash('sha256')
  const offsets = Buffer.alloc((tileCount + 1) * 8)
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  let position = 0
  let largestBytes = 0
  const flush = async () => {
    const chunk = Buffer.concat(pending)
    await handle.write(chunk, 0, chunk.byteLength)
    pending = []
    pendingBytes = 0
  }
  try {
    for (let index = 0; index < tileCount; index += 1) {
      const tile = await tileAt(index)
      if (tile.byteLength > maximumPixelBlockBytes) {
        throw new ImagingAssetError('PATHOLOGY_TILE_TOO_LARGE', `A tile of ${tile.byteLength} bytes exceeds the pixel block limit`)
      }
      offsets.writeBigUInt64LE(BigInt(position), index * 8)
      hash.update(tile)
      pending.push(tile)
      pendingBytes += tile.byteLength
      position += tile.byteLength
      largestBytes = Math.max(largestBytes, tile.byteLength)
      if (pendingBytes >= 4 * 1024 * 1024) await flush()
    }
    await flush()
  } finally {
    await handle.close()
  }
  offsets.writeBigUInt64LE(BigInt(position), tileCount * 8)
  await writeFile(join(directory, 'levels', `${levelIndex}.index`), offsets)
  return {
    index: { bytes: offsets.byteLength, sha256: sha256(offsets) },
    tiles: { bytes: position, count: tileCount, largestBytes, sha256: hash.digest('hex') },
  }
}

/**
 * 按 factor×factor 区域均值从来源层级生成一个输出瓦片：每个输出像素取来源中落在总像素矩阵内的像素的
 * 各通道 sRGB 码值均值并四舍五入（半数进位）；超出输出层级尺寸的填充像素为白色。
 */
async function derivedTile(source: SourceLevel, factor: number, column: number, row: number): Promise<Uint8Array> {
  const { tileHeight, tileWidth } = source
  const blockWidth = tileWidth / factor
  const blockHeight = tileHeight / factor
  const output = new Uint8Array(tileWidth * tileHeight * 3).fill(255)
  for (let j = 0; j < factor; j += 1) {
    for (let i = 0; i < factor; i += 1) {
      const sourceColumn = column * factor + i
      const sourceRow = row * factor + j
      if (sourceColumn >= source.tilesAcross || sourceRow >= source.tilesDown) continue
      const pixels = await decodeSourceTile(source, sourceColumn, sourceRow)
      const originX = sourceColumn * tileWidth
      const originY = sourceRow * tileHeight
      for (let y = 0; y < blockHeight; y += 1) {
        const top = y * factor
        if (originY + top >= source.height) break
        const rowsIn = Math.min(factor, source.height - originY - top)
        const outputRow = (j * blockHeight + y) * tileWidth
        for (let x = 0; x < blockWidth; x += 1) {
          const left = x * factor
          if (originX + left >= source.width) break
          const columnsIn = Math.min(factor, source.width - originX - left)
          const count = rowsIn * columnsIn
          let red = 0
          let green = 0
          let blue = 0
          for (let dy = 0; dy < rowsIn; dy += 1) {
            let sample = ((top + dy) * tileWidth + left) * 3
            for (let dx = 0; dx < columnsIn; dx += 1) {
              red += pixels[sample]!
              green += pixels[sample + 1]!
              blue += pixels[sample + 2]!
              sample += 3
            }
          }
          const target = (outputRow + i * blockWidth + x) * 3
          output[target] = Math.floor((red * 2 + count) / (count * 2))
          output[target + 1] = Math.floor((green * 2 + count) / (count * 2))
          output[target + 2] = Math.floor((blue * 2 + count) / (count * 2))
        }
      }
    }
  }
  return encodeJpegTile(output, tileWidth, tileHeight)
}

type PlannedLevel =
  | { kind: 'source'; magnification: number; source: SourceLevel }
  | { factor: number; kind: 'derived'; magnification: number; source: SourceLevel }

/**
 * 层级选择：只保留组织金字塔（VOLUME）层级，丢弃缩略图、标签图与宏观图；安装 20 倍及以下的原生层级。
 * 没有原生 20 倍时从 40 倍按 2×2 区域均值生成；没有原生 10 倍时从最近的更高倍率原生层级生成。
 */
function planLevels(levels: SourceLevel[]): PlannedLevel[] {
  const byMagnification = new Map<number, SourceLevel>()
  for (const level of levels) {
    if (byMagnification.has(level.magnification)) {
      throw new ImagingAssetError('PATHOLOGY_LEVEL_DUPLICATE', `The slide has more than one ${level.magnification}x level`)
    }
    byMagnification.set(level.magnification, level)
  }
  const derive = (magnification: number): PlannedLevel | undefined => {
    for (let factor = 2; factor <= 4; factor *= 2) {
      const source = byMagnification.get(magnification * factor)
      if (source === undefined) continue
      if (source.tileWidth % factor !== 0 || source.tileHeight % factor !== 0) {
        throw new ImagingAssetError('PATHOLOGY_LEVEL_UNSUPPORTED', `The ${source.magnification}x tile size cannot be divided by ${factor}`)
      }
      return { factor, kind: 'derived', magnification, source }
    }
    return undefined
  }
  const planned: PlannedLevel[] = []
  for (const magnification of [maximumMagnification, maximumMagnification / 2]) {
    const native = byMagnification.get(magnification)
    const level = native === undefined ? derive(magnification) : { kind: 'source' as const, magnification, source: native }
    if (level === undefined) {
      throw new ImagingAssetError('PATHOLOGY_LEVEL_MISSING', `The slide has no level to install or derive ${magnification}x from`)
    }
    planned.push(level)
  }
  for (const level of levels.toSorted((left, right) => right.magnification - left.magnification)) {
    if (level.magnification < maximumMagnification / 2) planned.push({ kind: 'source', magnification: level.magnification, source: level })
  }
  return planned
}

/** 同一张切片的层级必须描述同一物理范围：层级尺寸与 20 倍层级按像素间距换算一致（允许 1% 或 2 像素）。 */
function assertConsistentGeometry(levels: SourceLevel[]): void {
  const reference = levels.reduce((finest, level) => level.micronsPerPixel < finest.micronsPerPixel ? level : finest)
  for (const level of levels) {
    for (const [size, referenceSize] of [[level.width, reference.width], [level.height, reference.height]] as const) {
      const expected = referenceSize * reference.micronsPerPixel / level.micronsPerPixel
      if (Math.abs(size - expected) > Math.max(2, expected * 0.01)) {
        throw new ImagingAssetError('PATHOLOGY_LEVEL_UNSUPPORTED', `The ${level.magnification}x level size disagrees with its pixel spacing`)
      }
    }
  }
}

/**
 * 把一张切片的来源实例规范化并写入安装目录。`source` 给出请求的 UID，实例必须与之一致。
 * 返回登记输出与使用到的实例（输入下标，按倍率从高到低）；未使用的实例（缩略图等）不保留也不登记。
 */
export async function installPathologySlide(input: {
  directory: string
  instances: Array<{ bytes: Uint8Array; sopInstanceUid: string }>
  source: { seriesInstanceUid: string; studyInstanceUid: string }
}): Promise<{ instanceOrder: number[]; output: PathologyAssetOutput }> {
  const volume: SourceLevel[] = []
  for (const [index, instance] of input.instances.entries()) {
    const parsed = parseSlideInstance(instance.bytes)
    if (
      parsed.sopInstanceUid !== instance.sopInstanceUid
      || parsed.seriesInstanceUid !== input.source.seriesInstanceUid
      || parsed.studyInstanceUid !== input.source.studyInstanceUid
    ) {
      throw new ImagingAssetError(
        'IMAGING_SOURCE_UID_MISMATCH',
        `The source instance ${instance.sopInstanceUid} does not carry the requested Study/Series/SOP Instance UIDs`,
      )
    }
    if (parsed.sopClassUid !== wholeSlideImageStorage) {
      throw new ImagingAssetError('PATHOLOGY_DICOM_INVALID', `The source instance ${instance.sopInstanceUid} is not a whole slide image`)
    }
    const flavor = parsed.imageType[2]
    if (flavor === 'THUMBNAIL' || flavor === 'LABEL' || flavor === 'OVERVIEW') continue
    if (flavor !== 'VOLUME') {
      throw new ImagingAssetError('PATHOLOGY_LEVEL_UNSUPPORTED', `The source instance ${instance.sopInstanceUid} has an unsupported image type`)
    }
    volume.push(sourceLevel(parsed, index))
  }
  if (volume.length === 0) throw new ImagingAssetError('PATHOLOGY_LEVEL_MISSING', 'The slide has no pyramid levels')
  assertConsistentGeometry(volume)
  const planned = planLevels(volume)
  const used = [...new Set(planned.map(level => level.source))]
    .toSorted((left, right) => right.magnification - left.magnification)
  const iccProfiles = used.map(level => level.iccProfile === undefined ? '' : sha256(level.iccProfile))
  if (new Set(iccProfiles).size > 1) {
    throw new ImagingAssetError('PATHOLOGY_ICC_INCONSISTENT', 'The pyramid levels carry different ICC profiles')
  }
  const iccProfile = used[0]!.iccProfile
  if (iccProfile !== undefined) await writeFile(join(input.directory, 'icc-profile.icc'), iccProfile)

  const levels: PathologyLevelOutput[] = []
  for (const [levelIndex, level] of planned.entries()) {
    const { source } = level
    const factor = level.kind === 'derived' ? level.factor : 1
    const width = Math.ceil(source.width / factor)
    const height = Math.ceil(source.height / factor)
    const tilesAcross = Math.ceil(width / source.tileWidth)
    const tilesDown = Math.ceil(height / source.tileHeight)
    const pack = await writeLevelPack(input.directory, levelIndex, tilesAcross * tilesDown, async (index) => {
      const column = index % tilesAcross
      const row = Math.floor(index / tilesAcross)
      if (level.kind === 'derived') return await derivedTile(source, factor, column, row)
      if (source.codec === 'jpeg-baseline') return source.frames[index]!
      return encodeJpegTile(await decodeSourceTile(source, column, row), source.tileWidth, source.tileHeight)
    })
    const sourceInstance = used.indexOf(source)
    levels.push({
      height,
      index: pack.index,
      magnification: level.magnification,
      micronsPerPixel: roundMicrons(source.micronsPerPixel * factor),
      origin: level.kind === 'derived'
        ? { factor, kind: 'derived', method: 'box', sourceInstance }
        : { kind: 'source', sourceCodec: source.codec, sourceInstance, tiles: source.codec === 'jpeg-baseline' ? 'copied' : 'transcoded' },
      tileHeight: source.tileHeight,
      tileWidth: source.tileWidth,
      tiles: pack.tiles,
      width,
    })
  }
  return {
    instanceOrder: used.map(level => level.input),
    output: {
      ...(iccProfile === undefined ? {} : { iccProfile: { bytes: iccProfile.byteLength, sha256: sha256(iccProfile) } }),
      ingestVersion: pathologyIngestVersion,
      levels,
      parameters: pathologyIngestParameters,
    },
  }
}
