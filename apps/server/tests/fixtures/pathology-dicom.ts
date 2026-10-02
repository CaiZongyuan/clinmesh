import openJpegFactory from '@cornerstonejs/codec-openjpeg/wasmjs'
import jpeg from 'jpeg-js'

export const jpegBaselineSyntax = '1.2.840.10008.1.2.4.50'
export const jpeg2000Syntax = '1.2.840.10008.1.2.4.91'
export const explicitVrLittleEndianSyntax = '1.2.840.10008.1.2.1'
/** 合成切片所属的来源检查；清单条目的 `studyInstanceUid` 必须与之一致。 */
export const syntheticSlideStudyUid = '2.25.7000'
/** 写入每个合成实例头部的虚构患者标识；安装输出、清单与命令结果中都不应出现。 */
export const syntheticPatientIdentifiers = ['SYNTH^PATHOLOGY^PATIENT', 'SYNTH-PATIENT-0001', 'SYNTH-SLIDE-0001-DX1']

const longVrs = new Set(['OB', 'SQ', 'UN'])

function element(tag: string, vr: string, value: Uint8Array): Buffer {
  const header = Buffer.alloc(longVrs.has(vr) ? 12 : 8)
  header.writeUInt16LE(Number.parseInt(tag.slice(0, 4), 16), 0)
  header.writeUInt16LE(Number.parseInt(tag.slice(4), 16), 2)
  header.write(vr, 4, 'latin1')
  if (longVrs.has(vr)) header.writeUInt32LE(value.byteLength, 8)
  else header.writeUInt16LE(value.byteLength, 6)
  return Buffer.concat([header, value])
}

function textElement(tag: string, vr: string, value: string): Buffer {
  const padded = value.length % 2 === 0 ? value : `${value}${vr === 'UI' ? '\0' : ' '}`
  return element(tag, vr, Buffer.from(padded, 'latin1'))
}

function unsignedElement(tag: string, vr: 'UL' | 'US', value: number): Buffer {
  const bytes = Buffer.alloc(vr === 'US' ? 2 : 4)
  if (vr === 'US') bytes.writeUInt16LE(value)
  else bytes.writeUInt32LE(value)
  return element(tag, vr, bytes)
}

function item(tag: number, content: Uint8Array, length = content.byteLength): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt16LE(0xfffe, 0)
  header.writeUInt16LE(tag, 2)
  header.writeUInt32LE(length, 4)
  return Buffer.concat([header, content])
}

/** 未定义长度的序列，条目同样以结束符收尾；真实切片的序列两种长度写法都会出现。 */
function undefinedLengthSequence(tag: string, items: Buffer[]): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16LE(Number.parseInt(tag.slice(0, 4), 16), 0)
  header.writeUInt16LE(Number.parseInt(tag.slice(4), 16), 2)
  header.write('SQ', 4, 'latin1')
  header.writeUInt32LE(0xffffffff, 8)
  return Buffer.concat([
    header,
    ...items.map(content => Buffer.concat([item(0xe000, content, 0xffffffff), item(0xe00d, Buffer.alloc(0))])),
    item(0xe0dd, Buffer.alloc(0)),
  ])
}

function definedLengthSequence(tag: string, items: Buffer[]): Buffer {
  return element(tag, 'SQ', Buffer.concat(items.map(content => item(0xe000, content))))
}

export interface SyntheticSlideLevel {
  /** 追加或覆盖数据集元素（标签 → 已编码元素；undefined 表示移除）。 */
  elements?: Record<string, Buffer | undefined>
  /** 每个瓦片一个压缩码流；未压缩实例给出单个原始像素缓冲。 */
  frames: Uint8Array[]
  height: number
  iccProfile?: Uint8Array
  imageType?: string
  micronsPerPixel: number
  photometric: string
  seriesInstanceUid: string
  sopInstanceUid: string
  studyInstanceUid?: string
  tileSize: number
  transferSyntaxUid: string
  width: number
}

/** 写出一个只含合成像素与虚构标识的 TILED_FULL 切片实例；基本偏移表为空，与真实来源一致。 */
export function syntheticSlideLevel(level: SyntheticSlideLevel): Uint8Array {
  const sopClassUid = '1.2.840.10008.5.1.4.1.1.77.1.6'
  const metaElements = Buffer.concat([
    element('00020001', 'OB', Buffer.from([0, 1])),
    textElement('00020002', 'UI', sopClassUid),
    textElement('00020003', 'UI', level.sopInstanceUid),
    textElement('00020010', 'UI', level.transferSyntaxUid),
    textElement('00020012', 'UI', '2.25.900000000000000000000000000000000001'),
  ])
  const spacing = String(level.micronsPerPixel / 1000)
  const [patientName, patientId, containerIdentifier] = syntheticPatientIdentifiers
  const encapsulated = level.transferSyntaxUid !== explicitVrLittleEndianSyntax
  const pixelData = encapsulated
    ? Buffer.concat([
        Buffer.from([0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0, 0, 0xff, 0xff, 0xff, 0xff]),
        item(0xe000, Buffer.alloc(0)),
        ...level.frames.map(frame => item(0xe000, frame.byteLength % 2 === 0 ? frame : Buffer.concat([frame, Buffer.from([0])]))),
        item(0xe0dd, Buffer.alloc(0)),
      ])
    : element('7fe00010', 'OB', level.frames[0]!)
  const elements: Record<string, Buffer | undefined> = {
    '00080008': textElement('00080008', 'CS', level.imageType ?? 'DERIVED\\PRIMARY\\VOLUME\\NONE'),
    '00080016': textElement('00080016', 'UI', sopClassUid),
    '00080018': textElement('00080018', 'UI', level.sopInstanceUid),
    '00100010': textElement('00100010', 'PN', patientName!),
    '00100020': textElement('00100020', 'LO', patientId!),
    '0020000d': textElement('0020000d', 'UI', level.studyInstanceUid ?? syntheticSlideStudyUid),
    '0020000e': textElement('0020000e', 'UI', level.seriesInstanceUid),
    '00209311': textElement('00209311', 'CS', 'TILED_FULL'),
    '00280002': unsignedElement('00280002', 'US', 3),
    '00280004': textElement('00280004', 'CS', level.photometric),
    '00280006': unsignedElement('00280006', 'US', 0),
    '00280008': textElement('00280008', 'IS', String(encapsulated ? level.frames.length : 1)),
    '00280010': unsignedElement('00280010', 'US', level.tileSize),
    '00280011': unsignedElement('00280011', 'US', level.tileSize),
    '00280100': unsignedElement('00280100', 'US', 8),
    '00280101': unsignedElement('00280101', 'US', 8),
    '00280102': unsignedElement('00280102', 'US', 7),
    '00280103': unsignedElement('00280103', 'US', 0),
    '00280301': textElement('00280301', 'CS', 'NO'),
    '00400512': textElement('00400512', 'LO', containerIdentifier!),
    '00480006': unsignedElement('00480006', 'UL', level.width),
    '00480007': unsignedElement('00480007', 'UL', level.height),
    '00480105': undefinedLengthSequence('00480105', [Buffer.concat([
      textElement('00480106', 'SH', '1'),
      ...(level.iccProfile === undefined ? [] : [element('00282000', 'OB', level.iccProfile)]),
    ])]),
    '52009229': definedLengthSequence('52009229', [
      definedLengthSequence('00289110', [textElement('00280030', 'DS', `${spacing}\\${spacing}`)]),
    ]),
    ...level.elements,
  }
  const dataset = Buffer.concat(Object.keys(elements).toSorted().flatMap(tag => elements[tag] ?? []))
  const groupLength = Buffer.alloc(4)
  groupLength.writeUInt32LE(metaElements.byteLength)
  return new Uint8Array(Buffer.concat([
    Buffer.alloc(128),
    Buffer.from('DICM', 'latin1'),
    element('00020000', 'UL', groupLength),
    metaElements,
    dataset,
    pixelData,
  ]))
}

export { textElement as syntheticTextElement, unsignedElement as syntheticUnsignedElement }

/** 合成切片的像素：颜色随 20 倍坐标线性变化，便于在有损压缩后按容差核对位置与降采样；`scale` 是该层一个像素对应的 20 倍像素数。 */
export function syntheticPixel(x: number, y: number, scale: number): [number, number, number] {
  return [Math.round(40 + x * scale), Math.round(60 + y * scale * 2), Math.round(220 - (x + y) * scale)]
}

/** 按行优先顺序给出一个层级全部瓦片的交错 RGB 像素；超出层级尺寸的填充像素为白色。 */
export function syntheticTiles(width: number, height: number, tileSize: number, scale: number): Uint8Array[] {
  const tiles: Uint8Array[] = []
  for (let row = 0; row < Math.ceil(height / tileSize); row += 1) {
    for (let column = 0; column < Math.ceil(width / tileSize); column += 1) {
      const tile = new Uint8Array(tileSize * tileSize * 3).fill(255)
      for (let y = 0; y < tileSize && row * tileSize + y < height; y += 1) {
        for (let x = 0; x < tileSize && column * tileSize + x < width; x += 1) {
          tile.set(syntheticPixel(column * tileSize + x, row * tileSize + y, scale), (y * tileSize + x) * 3)
        }
      }
      tiles.push(tile)
    }
  }
  return tiles
}

/** jpeg-js 编码的基线 JPEG（JFIF、YCbCr 4:4:4），对应 DICOM 的 YBR_FULL。 */
export function encodeJpegTile(rgb: Uint8Array, tileSize: number): Uint8Array {
  const rgba = new Uint8Array(tileSize * tileSize * 4).fill(255)
  for (let pixel = 0; pixel < tileSize * tileSize; pixel += 1) rgba.set(rgb.subarray(pixel * 3, pixel * 3 + 3), pixel * 4)
  return new Uint8Array(jpeg.encode({ data: rgba, height: tileSize, width: tileSize }, 95).data)
}

/** 去掉 JFIF 段，得到不带任何颜色标记的码流。 */
export function withoutJfif(tile: Uint8Array): Uint8Array {
  const jfifLength = 2 + ((tile[4]! << 8) | tile[5]!)
  return new Uint8Array(Buffer.concat([tile.subarray(0, 2), tile.subarray(2 + jfifLength)]))
}

/** 把 JFIF 瓦片改写成来源切片的形态：去掉 JFIF 段，换成 Adobe APP14（transform=0 时分量按 RGB 解释）。 */
export function asAdobeTile(tile: Uint8Array, transform = 0): Uint8Array {
  const bare = withoutJfif(tile)
  const adobe = Buffer.from([0xff, 0xee, 0x00, 0x0e, 0x41, 0x64, 0x6f, 0x62, 0x65, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, transform])
  return new Uint8Array(Buffer.concat([bare.subarray(0, 2), adobe, bare.subarray(2)]))
}

/** 在 SOI 之后插入一个注释段。 */
export function withJpegComment(tile: Uint8Array, comment: string): Uint8Array {
  const text = Buffer.from(comment, 'latin1')
  const header = Buffer.from([0xff, 0xfe, (text.byteLength + 2) >> 8, (text.byteLength + 2) & 0xff])
  return new Uint8Array(Buffer.concat([tile.subarray(0, 2), header, text, tile.subarray(2)]))
}

let openJpegEncoder: ReturnType<typeof openJpegFactory> | undefined

/** 用 OpenJPEG 无损编码一个 RGB 瓦片为 JPEG 2000 原始码流。 */
export async function encodeJpeg2000Tile(rgb: Uint8Array, tileSize: number): Promise<Uint8Array> {
  openJpegEncoder ??= openJpegFactory()
  const encoder = new (await openJpegEncoder).J2KEncoder()
  encoder.getDecodedBuffer({
    bitsPerSample: 8,
    componentCount: 3,
    height: tileSize,
    isSigned: false,
    isUsingColorSpace: false,
    width: tileSize,
  }).set(rgb)
  encoder.setDecompositions(2)
  encoder.setQuality(true, 0)
  encoder.encode()
  return encoder.getEncodedBuffer().slice()
}
