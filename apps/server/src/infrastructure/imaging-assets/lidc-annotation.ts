import { createHash } from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import { z } from 'zod'
import { ImagingAssetError, type SeriesGeometry } from './dicom-canonical.ts'
import type { ImagingAnnotation } from './imaging-catalog.ts'

const pointSchema = z.object({ xCoord: z.coerce.number(), yCoord: z.coerce.number() })
/** 没有子元素的 XML 元素被解析成空字符串，按空对象处理。 */
const element = <Schema extends z.ZodType>(schema: Schema) => z.preprocess(value => value === '' ? {} : value, schema)

const ctReadMessageSchema = z.object({
  ResponseHeader: z.object({ SeriesInstanceUid: z.string() }),
  readingSession: z.array(element(z.object({
    nonNodule: z.array(z.object({ imageZposition: z.coerce.number(), locus: pointSchema })).default([]),
    unblindedReadNodule: z.array(z.object({
      characteristics: element(z.object({
        calcification: z.coerce.number().int().optional(),
        texture: z.coerce.number().int().optional(),
      })).optional(),
      roi: z.array(z.object({
        edgeMap: z.array(pointSchema).min(1),
        imageZposition: z.coerce.number(),
        inclusion: z.string().optional(),
      })).min(1),
    })).default([]),
  }))).default([]),
})

const radiographReadMessageSchema = z.object({
  CXRreadingSession: z.array(element(z.object({
    unblindedRead: z.array(z.object({
      characteristics: z.object({
        confidence: z.coerce.number().int().min(1).max(3),
        subtlety: z.coerce.number().int().min(1).max(5).optional(),
      }),
      noduleID: z.string().min(1),
      roi: z.array(z.object({ edgeMap: z.array(pointSchema).min(1), imageSOP_UID: z.string() })).min(1),
    })).default([]),
  }))).default([]),
  ResponseHeader: z.object({ CXRSeriesInstanceUid: z.string() }),
})

const repeatedElements = new Set([
  'CXRreadingSession',
  'edgeMap',
  'nonNodule',
  'readingSession',
  'roi',
  'unblindedRead',
  'unblindedReadNodule',
])

/** 不同读片者的标记相距不超过该距离时视为同一病灶；大结节放宽到其半径。 */
const sameLesionDistanceMm = 5
/** 病灶中心落在图像中线两侧该比例以内时，不能仅凭坐标判断左右。 */
const midlineMarginFraction = 0.05

function invalid(message: string): ImagingAssetError {
  return new ImagingAssetError('IMAGING_ANNOTATION_INVALID', message)
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** 规范显示方向下行向患者左侧：图像左半是患者右侧。 */
function sideOf(canonicalX: number, columns: number): 'left' | 'right' {
  const center = (columns - 1) / 2
  if (Math.abs(canonicalX - center) < columns * midlineMarginFraction) {
    throw invalid('A marked lesion lies too close to the image midline to derive its side')
  }
  return canonicalX < center ? 'right' : 'left'
}

interface Mark {
  calcification?: number | undefined
  longAxisMm?: number
  positionMm: [number, number, number]
  reader: number
  sliceMm: number
  texture?: number | undefined
  x: number
}

function distance(left: Mark, right: Mark): number {
  return Math.hypot(...left.positionMm.map((value, index) => value - right.positionMm[index]!))
}

/** 单链聚类：与簇内任一标记足够近即并入该簇。 */
function cluster(marks: Mark[]): Mark[][] {
  const clusters: Mark[][] = []
  for (const mark of marks) {
    const joined = clusters.filter(members => members.some(member => (
      distance(member, mark) <= Math.max(sameLesionDistanceMm, (member.longAxisMm ?? 0) / 2, (mark.longAxisMm ?? 0) / 2)
    )))
    if (joined.length === 0) {
      clusters.push([mark])
      continue
    }
    joined[0]!.push(mark, ...joined.slice(1).flat())
    for (const merged of joined.slice(1)) clusters.splice(clusters.indexOf(merged), 1)
  }
  return clusters
}

function ctAnnotation(
  message: z.infer<typeof ctReadMessageSchema>,
  geometry: SeriesGeometry,
): Pick<Extract<ImagingAnnotation, { kind: 'lidc-ct' }>, 'nodules' | 'nonNoduleMarks' | 'readerCount'> {
  const first = geometry.frames[0]!
  const spacing = first.pixelSpacingMm
  const positions = geometry.frames.map(frame => frame.positionMm)
  if (spacing === null || positions.some(position => position === undefined) || positions.length < 2) {
    throw invalid('The installed CT geometry has no pixel spacing or slice positions')
  }
  const sliceGapMm = Math.abs(positions[0]! - positions[1]!)
  const frameIndexOf = (sliceMm: number): number => {
    const index = positions.reduce<number>((nearest, position, candidate) => (
      Math.abs(position! - sliceMm) < Math.abs(positions[nearest]! - sliceMm) ? candidate : nearest
    ), 0)
    if (Math.abs(positions[index]! - sliceMm) > sliceGapMm * 0.6) {
      throw invalid(`The annotated slice position ${sliceMm} is outside the installed CT series`)
    }
    return index
  }
  const positionMm = (points: Array<{ xCoord: number; yCoord: number }>, sliceMm: number): Mark['positionMm'] => [
    mean(points.map(point => point.xCoord)) * spacing[1],
    mean(points.map(point => point.yCoord)) * spacing[0],
    sliceMm,
  ]

  const large: Mark[] = []
  const small: Mark[] = []
  const nonNodules: Mark[] = []
  for (const [reader, session] of message.readingSession.entries()) {
    for (const nodule of session.unblindedReadNodule) {
      const rois = nodule.roi.filter(roi => roi.inclusion?.trim().toUpperCase() !== 'FALSE')
      const points = rois.flatMap(roi => roi.edgeMap)
      if (points.length === 0) continue
      const x = mean(points.map(point => point.xCoord))
      if (points.length === 1) {
        // 小于 3 mm 的结节只标一个中心点，没有轮廓和特征评分。
        const sliceMm = rois[0]!.imageZposition
        small.push({ positionMm: positionMm(points, sliceMm), reader, sliceMm, x })
        continue
      }
      // 长径取各层轮廓内最远两点的面内距离；所在层面取长径最大的一层。
      let longAxisMm = 0
      let sliceMm = rois[0]!.imageZposition
      for (const roi of rois) {
        for (const [index, from] of roi.edgeMap.entries()) {
          for (const to of roi.edgeMap.slice(index + 1)) {
            const extent = Math.hypot((from.xCoord - to.xCoord) * spacing[1], (from.yCoord - to.yCoord) * spacing[0])
            if (extent > longAxisMm) {
              longAxisMm = extent
              sliceMm = roi.imageZposition
            }
          }
        }
      }
      large.push({
        calcification: nodule.characteristics?.calcification,
        longAxisMm,
        positionMm: positionMm(points, mean(rois.flatMap(roi => roi.edgeMap.map(() => roi.imageZposition)))),
        reader,
        sliceMm,
        texture: nodule.characteristics?.texture,
        x,
      })
    }
    for (const mark of session.nonNodule) {
      nonNodules.push({
        positionMm: positionMm([mark.locus], mark.imageZposition),
        reader,
        sliceMm: mark.imageZposition,
        x: mark.locus.xCoord,
      })
    }
  }

  const summarize = (members: Mark[], sizeClass: '3mm-or-larger' | 'under-3mm') => {
    if (new Set(members.map(member => member.reader)).size !== members.length) {
      throw invalid('One reader has several marks in the same lesion cluster; the annotation is ambiguous')
    }
    const x = mean(members.map(member => member.x))
    const textures = members.flatMap(member => member.texture ?? []).toSorted((left, right) => left - right)
    const calcifications = members.flatMap(member => member.calcification ?? [])
    // 官方量表：texture 1 为磨玻璃、3 为部分实性、5 为实性；calcification 6 为无钙化。
    const texture = textures[Math.floor((textures.length - 1) / 2)]
    return {
      agreement: members.length,
      ...(calcifications.length === 0
        ? {}
        : { calcified: calcifications.filter(value => value !== 6).length * 2 > calcifications.length }),
      frameIndex: frameIndexOf(mean(members.map(member => member.sliceMm))),
      ...(sizeClass === 'under-3mm'
        ? {}
        : { longAxisMm: Math.round(mean(members.map(member => member.longAxisMm!)) * 10) / 10 }),
      side: sideOf(geometry.transform.flipHorizontal ? first.columns - 1 - x : x, first.columns),
      sizeClass,
      ...(texture === undefined
        ? {}
        : { texture: texture <= 2 ? 'ground-glass' as const : texture === 3 ? 'part-solid' as const : 'solid' as const }),
      x,
    }
  }
  const ordered = [
    ...cluster(large).map(members => summarize(members, '3mm-or-larger')),
    ...cluster(small).map(members => summarize(members, 'under-3mm')),
  ].toSorted((left, right) => (
    left.sizeClass.localeCompare(right.sizeClass) || left.frameIndex - right.frameIndex || left.x - right.x
  ))
  return {
    nodules: ordered.map(({ x: _x, ...nodule }, index) => ({ ...nodule, id: `n${index + 1}` })),
    nonNoduleMarks: cluster(nonNodules).length,
    readerCount: message.readingSession.length,
  }
}

type RadiographRead = z.infer<typeof radiographReadMessageSchema>['CXRreadingSession'][number]['unblindedRead'][number]

function radiographAnnotation(
  message: z.infer<typeof radiographReadMessageSchema>,
  geometry: SeriesGeometry,
  sopInstanceUids: string[],
): Pick<Extract<ImagingAnnotation, { kind: 'lidc-radiograph' }>, 'nodules' | 'readerCount'> {
  const readerCount = message.CXRreadingSession.length
  const reads = new Map<string, RadiographRead[]>()
  for (const session of message.CXRreadingSession) {
    for (const read of session.unblindedRead) reads.set(read.noduleID, [...reads.get(read.noduleID) ?? [], read])
  }
  return {
    nodules: [...reads.values()].map((nodule, index) => {
      const frames = new Set(nodule.flatMap(read => read.roi.map(roi => sopInstanceUids.indexOf(roi.imageSOP_UID))))
      const frame = frames.size === 1 ? geometry.frames[[...frames][0]!] : undefined
      if (frame?.view !== 'frontal') {
        throw invalid('Radiograph marks must refer to one frontal image of the installed series')
      }
      const x = mean(nodule.flatMap(read => read.roi.flatMap(roi => roi.edgeMap.map(point => point.xCoord))))
        / geometry.transform.downsampleFactor
      const ratings = nodule.map(read => ({
        confidence: read.characteristics.confidence,
        ...(read.characteristics.subtlety === undefined ? {} : { subtlety: read.characteristics.subtlety }),
      }))
      // 胸片读片量表没有公开定义；只把全体读片者一致的两端评分当作确定结论，其余一律存疑。
      const rated = ratings.length === readerCount
      const visibility = rated && ratings.every(rating => rating.confidence === 3 && (rating.subtlety ?? 0) >= 4)
        ? 'visible' as const
        : rated && ratings.every(rating => rating.confidence === 1)
          ? 'not-visible' as const
          : 'indeterminate' as const
      return {
        id: `n${index + 1}`,
        ratings,
        side: sideOf(geometry.transform.flipHorizontal ? frame.columns - 1 - x : x, frame.columns),
        visibility,
      }
    }),
    readerCount,
  }
}

/**
 * 从一份 LIDC 读片 XML 导出素材的结构化标注。CT 读片（LidcReadMessage）按读片者合并结节，
 * 胸片读片（IdriReadMessage）记录每个结节在胸片上的可见性评分；坐标按已安装序列的几何换算。
 */
export function lidcAnnotation(input: {
  fileName: string
  geometry: SeriesGeometry
  seriesInstanceUid: string
  /** 已安装序列各帧对应的来源实例 UID，顺序与帧一致。 */
  sopInstanceUids: string[]
  xml: Uint8Array
}): ImagingAnnotation {
  let document: Record<string, unknown>
  try {
    document = new XMLParser({
      ignoreAttributes: true,
      isArray: name => repeatedElements.has(name),
      parseTagValue: false,
      trimValues: true,
    }).parse(Buffer.from(input.xml)) as Record<string, unknown>
  } catch (error) {
    throw invalid(`The annotation file ${input.fileName} is not valid XML: ${String(error)}`)
  }
  const source = { file: input.fileName, sha256: createHash('sha256').update(input.xml).digest('hex') }
  const assertSeries = (seriesInstanceUid: string) => {
    if (seriesInstanceUid.trim() !== input.seriesInstanceUid) {
      throw invalid(`The annotation file ${input.fileName} does not describe series ${input.seriesInstanceUid}`)
    }
  }
  if (input.geometry.modality === 'CT') {
    const message = ctReadMessageSchema.safeParse(document.LidcReadMessage)
    if (!message.success) throw invalid(`The annotation file ${input.fileName} is not a LIDC CT read message`)
    assertSeries(message.data.ResponseHeader.SeriesInstanceUid)
    return { kind: 'lidc-ct', ...ctAnnotation(message.data, input.geometry), source }
  }
  const message = radiographReadMessageSchema.safeParse(document.IdriReadMessage)
  if (!message.success) throw invalid(`The annotation file ${input.fileName} is not a LIDC radiograph read message`)
  assertSeries(message.data.ResponseHeader.CXRSeriesInstanceUid)
  return {
    kind: 'lidc-radiograph',
    ...radiographAnnotation(message.data, input.geometry, input.sopInstanceUids),
    source,
  }
}
