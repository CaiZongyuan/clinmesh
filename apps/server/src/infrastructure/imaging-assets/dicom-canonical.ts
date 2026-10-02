import dcmjs from 'dcmjs'
import { z } from 'zod'
import { ImagingAssetError } from './imaging-pack-store.ts'

// dcmjs 对隐式 VR 中的多义 VR 逐实例打印提示；解析失败会抛出异常，不依赖日志。
dcmjs.log.level = 'silent'

export type ImagingExamCode = 'chest-ct-plain' | 'chest-radiograph'
export type ImagingModality = 'CR' | 'CT' | 'DX'
export type PatientDirection = 'A' | 'F' | 'H' | 'L' | 'P' | 'R'

/** 转码规则版本；规则变化会改变输出字节，必须递增并重新登记输出哈希。 */
export const imagingTranscoderVersion = 1

/** 单个像素块上限，与像素读取路由的响应上限一致。 */
export const maximumPixelBlockBytes = 2 * 1024 * 1024
const maximumFrameSide = 4096
const chestCtMinimumCoverageMm = 150
const huMinimum = -1024
const huMaximum = 3071
const standardViewPositions = new Set(['AP', 'LL', 'LLD', 'LLO', 'PA', 'RL', 'RLD', 'RLO'])
const uncompressedTransferSyntaxes = new Set([
  '1.2.840.10008.1.2',
  '1.2.840.10008.1.2.1',
])

const pixelBlockSchema = z.object({
  length: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  rowCount: z.number().int().positive(),
  rowStart: z.number().int().nonnegative(),
}).strict()

const seriesFrameGeometrySchema = z.object({
  blocks: z.array(pixelBlockSchema).min(1),
  columns: z.number().int().positive(),
  pixelSpacingMm: z.tuple([z.number().positive(), z.number().positive()]).nullable(),
  positionMm: z.number().optional(),
  rows: z.number().int().positive(),
  view: z.enum(['frontal', 'lateral']).optional(),
  viewPosition: z.string().min(1).optional(),
  window: z.object({ center: z.number(), width: z.number().positive() }).strict().optional(),
}).strict()

/** 已安装序列的几何描述；字段顺序即 `series.json` 的规范序列化顺序。 */
export const seriesGeometrySchema = z.object({
  frames: z.array(seriesFrameGeometrySchema).min(1),
  modality: z.enum(['CR', 'CT', 'DX']),
  pixelFormat: z.enum(['int16', 'uint16']),
  schemaVersion: z.literal(1),
  sliceOrder: z.literal('superior-to-inferior').optional(),
  transcoderVersion: z.number().int().positive(),
  transform: z.object({
    downsampleFactor: z.number().int().positive(),
    flipHorizontal: z.boolean(),
    flipVertical: z.boolean(),
    inverted: z.boolean(),
  }).strict(),
  valueUnit: z.enum(['hu', 'stored']),
}).strict()

export type PixelBlock = z.infer<typeof pixelBlockSchema>
export type SeriesGeometry = z.infer<typeof seriesGeometrySchema>

export interface CanonicalSeries {
  /** 每一帧对应的输入实例下标，顺序与 `geometry.frames` 一致。 */
  frameInstances: number[]
  frames: Uint8Array
  geometry: SeriesGeometry
}

type Dataset = Record<string, unknown>

interface ParsedInstance {
  dataset: Dataset
  transferSyntaxUid: string
}

function parseInstance(bytes: Uint8Array): ParsedInstance {
  let dictionary
  try {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    dictionary = dcmjs.data.DicomMessage.readFile(buffer)
  } catch (error) {
    throw new ImagingAssetError('IMAGING_DICOM_INVALID', `The DICOM instance cannot be parsed: ${String(error)}`)
  }
  const meta = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dictionary.meta)
  return {
    dataset: dcmjs.data.DicomMetaDictionary.naturalizeDataset(dictionary.dict),
    transferSyntaxUid: String(meta.TransferSyntaxUID ?? ''),
  }
}

function firstValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value
}

function numberAttribute(dataset: Dataset, name: string): number | undefined {
  const value = Number(firstValue(dataset[name]))
  return dataset[name] === undefined || dataset[name] === '' || !Number.isFinite(value) ? undefined : value
}

function requiredNumber(dataset: Dataset, name: string): number {
  const value = numberAttribute(dataset, name)
  if (value === undefined) {
    throw new ImagingAssetError('IMAGING_DICOM_INVALID', `The DICOM attribute ${name} is required`)
  }
  return value
}

function numberList(dataset: Dataset, name: string, length: number): number[] | undefined {
  const value = dataset[name]
  if (!Array.isArray(value) || value.length !== length) return undefined
  const numbers = value.map(Number)
  return numbers.every(Number.isFinite) ? numbers : undefined
}

function textAttribute(dataset: Dataset, name: string): string | undefined {
  const value = firstValue(dataset[name])
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  return text === '' ? undefined : text
}

interface DecodedFrame {
  columns: number
  rows: number
  values: Int32Array
}

/** 按 BitsStored 截取低位存储值（要求 HighBit = BitsStored - 1），有符号数做符号扩展。 */
function decodePixels(dataset: Dataset): DecodedFrame {
  const rows = requiredNumber(dataset, 'Rows')
  const columns = requiredNumber(dataset, 'Columns')
  const bitsAllocated = requiredNumber(dataset, 'BitsAllocated')
  const bitsStored = requiredNumber(dataset, 'BitsStored')
  const highBit = requiredNumber(dataset, 'HighBit')
  const pixelRepresentation = requiredNumber(dataset, 'PixelRepresentation')
  const samplesPerPixel = numberAttribute(dataset, 'SamplesPerPixel') ?? 1
  const numberOfFrames = numberAttribute(dataset, 'NumberOfFrames') ?? 1
  const photometric = textAttribute(dataset, 'PhotometricInterpretation')
  if (
    bitsAllocated !== 16
    || bitsStored < 1
    || bitsStored > 16
    || highBit !== bitsStored - 1
    || (pixelRepresentation !== 0 && pixelRepresentation !== 1)
    || samplesPerPixel !== 1
    || numberOfFrames !== 1
    || (photometric !== 'MONOCHROME1' && photometric !== 'MONOCHROME2')
    || !Number.isInteger(rows) || rows < 1
    || !Number.isInteger(columns) || columns < 1
  ) {
    throw new ImagingAssetError(
      'IMAGING_PIXEL_FORMAT_UNSUPPORTED',
      'Only single-frame 16-bit monochrome pixel data with HighBit = BitsStored - 1 is supported',
    )
  }
  const pixelData = dataset.PixelData
  const buffer = Array.isArray(pixelData) ? pixelData[0] : undefined
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < rows * columns * 2) {
    throw new ImagingAssetError('IMAGING_DICOM_INVALID', 'The DICOM pixel data is missing or truncated')
  }
  const view = new DataView(buffer)
  const mask = bitsStored === 16 ? 0xffff : (1 << bitsStored) - 1
  const signBit = 1 << (bitsStored - 1)
  const values = new Int32Array(rows * columns)
  for (let index = 0; index < values.length; index += 1) {
    const stored = view.getUint16(index * 2, true) & mask
    values[index] = pixelRepresentation === 1 && (stored & signBit) !== 0 ? stored - (mask + 1) : stored
  }
  return { columns, rows, values }
}

function storedRange(dataset: Dataset): { maximum: number; minimum: number } {
  const bitsStored = requiredNumber(dataset, 'BitsStored')
  return requiredNumber(dataset, 'PixelRepresentation') === 1
    ? { maximum: 2 ** (bitsStored - 1) - 1, minimum: -(2 ** (bitsStored - 1)) }
    : { maximum: 2 ** bitsStored - 1, minimum: 0 }
}

/** PixelPaddingValue 的 VR 随 PixelRepresentation 变化；隐式 VR 下按无符号读出时换回有符号值。 */
function pixelPaddingValue(dataset: Dataset): number | undefined {
  const value = numberAttribute(dataset, 'PixelPaddingValue')
  if (value === undefined) return undefined
  return numberAttribute(dataset, 'PixelRepresentation') === 1 && value > 0x7fff ? value - 0x10000 : value
}

function transform(frame: DecodedFrame, flipHorizontal: boolean, flipVertical: boolean): Int32Array {
  if (!flipHorizontal && !flipVertical) return frame.values
  const output = new Int32Array(frame.values.length)
  for (let row = 0; row < frame.rows; row += 1) {
    const sourceRow = flipVertical ? frame.rows - 1 - row : row
    for (let column = 0; column < frame.columns; column += 1) {
      const sourceColumn = flipHorizontal ? frame.columns - 1 - column : column
      output[row * frame.columns + column] = frame.values[sourceRow * frame.columns + sourceColumn]!
    }
  }
  return output
}

/** 以整数因子做区域均值下采样；结果按四舍五入取整，保证跨平台字节一致。 */
function downsample(frame: DecodedFrame, factor: number): DecodedFrame {
  if (factor === 1) return frame
  const rows = Math.floor(frame.rows / factor)
  const columns = Math.floor(frame.columns / factor)
  const values = new Int32Array(rows * columns)
  const area = factor * factor
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      let sum = 0
      for (let offsetRow = 0; offsetRow < factor; offsetRow += 1) {
        for (let offsetColumn = 0; offsetColumn < factor; offsetColumn += 1) {
          sum += frame.values[(row * factor + offsetRow) * frame.columns + column * factor + offsetColumn]!
        }
      }
      values[row * columns + column] = Math.round(sum / area)
    }
  }
  return { columns, rows, values }
}

class FrameWriter {
  readonly #chunks: Uint8Array[] = []
  #offset = 0

  append(values: Int32Array, rows: number, columns: number, format: SeriesGeometry['pixelFormat']): PixelBlock[] {
    const rowBytes = columns * 2
    const rowsPerBlock = Math.max(1, Math.floor(maximumPixelBlockBytes / rowBytes))
    const blocks: PixelBlock[] = []
    for (let rowStart = 0; rowStart < rows; rowStart += rowsPerBlock) {
      const rowCount = Math.min(rowsPerBlock, rows - rowStart)
      const block = new Uint8Array(rowCount * rowBytes)
      const view = new DataView(block.buffer)
      for (let index = 0; index < rowCount * columns; index += 1) {
        const value = values[rowStart * columns + index]!
        if (format === 'int16') view.setInt16(index * 2, value, true)
        else view.setUint16(index * 2, value, true)
      }
      blocks.push({ length: block.byteLength, offset: this.#offset, rowCount, rowStart })
      this.#chunks.push(block)
      this.#offset += block.byteLength
    }
    return blocks
  }

  bytes(): Uint8Array {
    const output = new Uint8Array(this.#offset)
    let offset = 0
    for (const chunk of this.#chunks) {
      output.set(chunk, offset)
      offset += chunk.byteLength
    }
    return output
  }
}

function assertTransferSyntax(instance: ParsedInstance): void {
  if (!uncompressedTransferSyntaxes.has(instance.transferSyntaxUid)) {
    throw new ImagingAssetError(
      'IMAGING_TRANSFER_SYNTAX_UNSUPPORTED',
      `The transfer syntax ${instance.transferSyntaxUid || '<missing>'} is not supported`,
    )
  }
}

function pixelSpacing(dataset: Dataset): [number, number] | null {
  const spacing = numberList(dataset, 'PixelSpacing', 2) ?? numberList(dataset, 'ImagerPixelSpacing', 2)
  return spacing === undefined || spacing.some(value => value <= 0) ? null : [spacing[0]!, spacing[1]!]
}

/** CT 只接受 PixelSpacing；ImagerPixelSpacing 是探测器平面间距，不能代替患者平面间距。 */
function ctPixelSpacing(dataset: Dataset): [number, number] {
  const spacing = numberList(dataset, 'PixelSpacing', 2)
  if (spacing === undefined || spacing.some(value => value <= 0)) {
    throw new ImagingAssetError('IMAGING_DICOM_INVALID', 'Each CT slice requires a positive PixelSpacing')
  }
  return [spacing[0]!, spacing[1]!]
}

function hasContrast(dataset: Dataset): boolean {
  return ['ContrastBolusAgent', 'ContrastBolusRoute', 'ContrastBolusVolume', 'ContrastBolusIngredient']
    .some(name => textAttribute(dataset, name) !== undefined)
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-3
}

function canonicalizeChestCt(instances: ParsedInstance[]): CanonicalSeries {
  const first = instances[0]!.dataset
  const orientation = numberList(first, 'ImageOrientationPatient', 6)
  if (orientation === undefined) {
    throw new ImagingAssetError('IMAGING_ORIENTATION_UNSUPPORTED', 'The CT series has no ImageOrientationPatient')
  }
  const [rowX, rowY, rowZ, columnX, columnY, columnZ] = orientation as [number, number, number, number, number, number]
  // 只接受轴位：行方向沿 ±X、列方向沿 ±Y，翻转到行向患者左侧、列向患者后方的放射学显示方向。
  if (!(nearlyEqual(Math.abs(rowX), 1) && nearlyEqual(rowY, 0) && nearlyEqual(rowZ, 0)
    && nearlyEqual(columnX, 0) && nearlyEqual(Math.abs(columnY), 1) && nearlyEqual(columnZ, 0))) {
    throw new ImagingAssetError('IMAGING_ORIENTATION_UNSUPPORTED', 'Only axial CT series are supported')
  }
  const flipHorizontal = rowX < 0
  const flipVertical = columnY < 0
  const rows = requiredNumber(first, 'Rows')
  const columns = requiredNumber(first, 'Columns')
  const spacing = ctPixelSpacing(first)
  const slices = instances.map(({ dataset }, instance) => {
    if (textAttribute(dataset, 'Modality') !== 'CT') {
      throw new ImagingAssetError('IMAGING_MODALITY_MISMATCH', 'A chest CT asset may contain only CT instances')
    }
    // HU 越大越亮是 CT 的显示约定；MONOCHROME1 的 CT 不做反相，直接拒绝。
    if (textAttribute(dataset, 'PhotometricInterpretation') !== 'MONOCHROME2') {
      throw new ImagingAssetError('IMAGING_PIXEL_FORMAT_UNSUPPORTED', 'CT slices must be MONOCHROME2')
    }
    if (hasContrast(dataset)) {
      throw new ImagingAssetError('IMAGING_CONTRAST_NOT_ALLOWED', 'A plain chest CT asset cannot use contrast')
    }
    const instanceOrientation = numberList(dataset, 'ImageOrientationPatient', 6)
    const instanceSpacing = ctPixelSpacing(dataset)
    if (
      requiredNumber(dataset, 'Rows') !== rows
      || requiredNumber(dataset, 'Columns') !== columns
      || instanceOrientation === undefined
      || instanceOrientation.some((value, index) => !nearlyEqual(value, orientation[index]!))
      || instanceSpacing.some((value, index) => !nearlyEqual(value, spacing[index]!))
    ) {
      throw new ImagingAssetError('IMAGING_SERIES_INCONSISTENT', 'CT slices must share size, spacing and orientation')
    }
    const position = numberList(dataset, 'ImagePositionPatient', 3)
    if (position === undefined) {
      throw new ImagingAssetError('IMAGING_DICOM_INVALID', 'Each CT slice requires ImagePositionPatient')
    }
    return { dataset, instance, z: position[2]! }
  }).toSorted((left, right) => right.z - left.z)

  const gaps = slices.slice(1).map((slice, index) => slices[index]!.z - slice.z)
  const sortedGaps = gaps.toSorted((left, right) => left - right)
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)] ?? 0
  if (gaps.length === 0 || medianGap <= 0 || gaps.some(gap => gap < medianGap * 0.5 || gap > medianGap * 1.5)) {
    throw new ImagingAssetError('IMAGING_SERIES_NONCONTIGUOUS', 'CT slices must be distinct and evenly spaced')
  }
  const coverage = slices[0]!.z - slices.at(-1)!.z + medianGap
  if (coverage < chestCtMinimumCoverageMm) {
    throw new ImagingAssetError(
      'IMAGING_COVERAGE_INSUFFICIENT',
      `The CT series covers ${coverage} mm; at least ${chestCtMinimumCoverageMm} mm is required`,
    )
  }

  const writer = new FrameWriter()
  const frames = slices.map(({ dataset, z }) => {
    const decoded = decodePixels(dataset)
    const slope = numberAttribute(dataset, 'RescaleSlope') ?? 1
    const intercept = numberAttribute(dataset, 'RescaleIntercept') ?? 0
    const padding = pixelPaddingValue(dataset)
    const hu = decoded.values.map(value => (
      value === padding
        ? huMinimum
        : Math.min(huMaximum, Math.max(huMinimum, Math.round(value * slope + intercept)))
    ))
    const oriented = transform({ ...decoded, values: hu }, flipHorizontal, flipVertical)
    return {
      blocks: writer.append(oriented, rows, columns, 'int16'),
      columns,
      pixelSpacingMm: spacing,
      positionMm: z,
      rows,
    }
  })
  return {
    frameInstances: slices.map(slice => slice.instance),
    frames: writer.bytes(),
    geometry: {
      frames,
      modality: 'CT',
      pixelFormat: 'int16',
      schemaVersion: 1,
      sliceOrder: 'superior-to-inferior',
      transcoderVersion: imagingTranscoderVersion,
      transform: { downsampleFactor: 1, flipHorizontal, flipVertical, inverted: false },
      valueUnit: 'hu',
    },
  }
}

/** 正位片行向患者左侧；侧位片行向患者后方；列向足侧。行方向沿左右即正位，沿前后即侧位。 */
function radiographFlips(
  dataset: Dataset,
  override: [PatientDirection, PatientDirection] | undefined,
): { flipHorizontal: boolean; flipVertical: boolean; view: 'frontal' | 'lateral' } {
  const declared = Array.isArray(dataset.PatientOrientation)
    ? dataset.PatientOrientation.map(value => String(value).trim().charAt(0))
    : undefined
  const [rowDirection, columnDirection] = override ?? declared ?? []
  const horizontal: Record<string, boolean> = { A: true, L: false, P: false, R: true }
  const vertical: Record<string, boolean> = { F: false, H: true }
  if (
    rowDirection === undefined || columnDirection === undefined
    || !(rowDirection in horizontal) || !(columnDirection in vertical)
  ) {
    throw new ImagingAssetError(
      'IMAGING_ORIENTATION_UNSUPPORTED',
      'The radiograph orientation must be declared by PatientOrientation or the asset catalog',
    )
  }
  return {
    flipHorizontal: horizontal[rowDirection]!,
    flipVertical: vertical[columnDirection]!,
    view: rowDirection === 'L' || rowDirection === 'R' ? 'frontal' : 'lateral',
  }
}

/**
 * 胸片默认窗取像素直方图的 0.5% 与 99.5% 分位。公开数据集里的 WindowCenter/WindowWidth 常在去标识时失真
 * （例如无符号像素配负的窗位），不能作为默认显示依据。
 */
function percentileWindow(values: Int32Array, maximum: number): { center: number; width: number } {
  const histogram = new Uint32Array(maximum + 1)
  for (const value of values) histogram[value]! += 1
  const lowRank = Math.max(1, Math.ceil(values.length * 0.005))
  const highRank = Math.ceil(values.length * 0.995)
  let cumulative = 0
  let low: number | undefined
  let high = maximum
  for (let value = 0; value <= maximum; value += 1) {
    cumulative += histogram[value]!
    if (low === undefined && cumulative >= lowRank) low = value
    if (cumulative >= highRank) {
      high = value
      break
    }
  }
  return { center: Math.round(((low ?? 0) + high) / 2), width: Math.max(1, high - (low ?? 0)) }
}

function canonicalizeChestRadiograph(
  instances: ParsedInstance[],
  modality: ImagingModality,
  override: [PatientDirection, PatientDirection] | undefined,
): CanonicalSeries {
  const writer = new FrameWriter()
  let seriesTransform: SeriesGeometry['transform'] | undefined
  // 按采集顺序排帧：同一检查的正位通常先于侧位；缺少 InstanceNumber 时按实例 UID 排。
  const ordered = instances.map(({ dataset }, instance) => ({ dataset, instance })).toSorted((left, right) => (
    (numberAttribute(left.dataset, 'InstanceNumber') ?? Infinity) - (numberAttribute(right.dataset, 'InstanceNumber') ?? Infinity)
    || String(left.dataset.SOPInstanceUID).localeCompare(String(right.dataset.SOPInstanceUID))
  ))
  const frames = ordered.map(({ dataset }) => {
    if (textAttribute(dataset, 'Modality') !== modality) {
      throw new ImagingAssetError('IMAGING_MODALITY_MISMATCH', `The radiograph instance is not ${modality}`)
    }
    if (textAttribute(dataset, 'BurnedInAnnotation')?.toUpperCase() === 'YES') {
      throw new ImagingAssetError('IMAGING_BURNED_IN_ANNOTATION', 'Radiographs with burned-in annotation are not allowed')
    }
    const slope = numberAttribute(dataset, 'RescaleSlope') ?? 1
    const intercept = numberAttribute(dataset, 'RescaleIntercept') ?? 0
    if (slope !== 1 || intercept !== 0) {
      throw new ImagingAssetError('IMAGING_PIXEL_FORMAT_UNSUPPORTED', 'Radiograph rescale must be identity')
    }
    const decoded = decodePixels(dataset)
    const { maximum, minimum } = storedRange(dataset)
    if (minimum < 0) {
      throw new ImagingAssetError('IMAGING_PIXEL_FORMAT_UNSUPPORTED', 'Radiograph pixels must be unsigned')
    }
    const inverted = textAttribute(dataset, 'PhotometricInterpretation') === 'MONOCHROME1'
    const { flipHorizontal, flipVertical, view } = radiographFlips(dataset, override)
    const factor = Math.max(1, Math.ceil(Math.max(decoded.rows, decoded.columns) / maximumFrameSide))
    const normalized = downsample({
      ...decoded,
      values: inverted ? decoded.values.map(value => maximum - value) : decoded.values,
    }, factor)
    const oriented = transform(normalized, flipHorizontal, flipVertical)
    const frameTransform = { downsampleFactor: factor, flipHorizontal, flipVertical, inverted }
    if (seriesTransform !== undefined && JSON.stringify(seriesTransform) !== JSON.stringify(frameTransform)) {
      throw new ImagingAssetError('IMAGING_SERIES_INCONSISTENT', 'Radiograph frames must share one display transform')
    }
    seriesTransform = frameTransform
    const spacing = pixelSpacing(dataset)
    // 只保留 DICOM 定义的投照体位取值；设备自定义的文本不进入几何描述。
    const declaredViewPosition = textAttribute(dataset, 'ViewPosition')?.toUpperCase()
    const viewPosition = declaredViewPosition !== undefined && standardViewPositions.has(declaredViewPosition)
      ? declaredViewPosition
      : undefined
    return {
      blocks: writer.append(oriented, normalized.rows, normalized.columns, 'uint16'),
      columns: normalized.columns,
      pixelSpacingMm: spacing === null ? null : [spacing[0] * factor, spacing[1] * factor] as [number, number],
      rows: normalized.rows,
      view,
      ...(viewPosition === undefined ? {} : { viewPosition }),
      window: percentileWindow(normalized.values, maximum),
    }
  })
  return {
    frameInstances: ordered.map(frame => frame.instance),
    frames: writer.bytes(),
    geometry: {
      frames,
      modality,
      pixelFormat: 'uint16',
      schemaVersion: 1,
      transcoderVersion: imagingTranscoderVersion,
      transform: seriesTransform!,
      valueUnit: 'stored',
    },
  }
}

/**
 * 校验并规范化一个来源序列：只接受未压缩的单帧灰度图，CT 输出为按从头到足排序、
 * 放射学方向的 HU，胸片输出为 MONOCHROME2 方向、行向患者左侧的存储值。
 * 每个实例的 Study/Series/SOP Instance UID 必须与请求的来源 UID 一致，`sopInstanceUids` 与 `instances` 一一对应。
 */
export function canonicalizeSeries(input: {
  examCode: ImagingExamCode
  instances: Uint8Array[]
  modality: ImagingModality
  orientation?: [PatientDirection, PatientDirection]
  source: { seriesInstanceUid: string; sopInstanceUids: string[]; studyInstanceUid: string }
}): CanonicalSeries {
  if (input.instances.length === 0) {
    throw new ImagingAssetError('IMAGING_DICOM_INVALID', 'A series requires at least one instance')
  }
  const parsed = input.instances.map(parseInstance)
  parsed.forEach(assertTransferSyntax)
  for (const [index, { dataset }] of parsed.entries()) {
    const sopInstanceUid = input.source.sopInstanceUids[index]
    if (
      textAttribute(dataset, 'SOPInstanceUID') !== sopInstanceUid
      || textAttribute(dataset, 'SeriesInstanceUID') !== input.source.seriesInstanceUid
      || textAttribute(dataset, 'StudyInstanceUID') !== input.source.studyInstanceUid
    ) {
      throw new ImagingAssetError(
        'IMAGING_SOURCE_UID_MISMATCH',
        `The source instance ${sopInstanceUid ?? '<none>'} does not carry the requested Study/Series/SOP Instance UIDs`,
      )
    }
  }
  if (input.examCode === 'chest-ct-plain') {
    if (input.modality !== 'CT') {
      throw new ImagingAssetError('IMAGING_MODALITY_MISMATCH', 'A plain chest CT asset must use CT series')
    }
    return canonicalizeChestCt(parsed)
  }
  if (input.modality === 'CT') {
    throw new ImagingAssetError('IMAGING_MODALITY_MISMATCH', 'A chest radiograph asset must use DX or CR series')
  }
  return canonicalizeChestRadiograph(parsed, input.modality, input.orientation)
}
