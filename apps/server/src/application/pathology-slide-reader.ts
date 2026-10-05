import { isDeepStrictEqual } from 'node:util'
import { imagingStudyViewSchema, type ImagingSeriesView, type ImagingStudyView } from '@clinmesh/contracts/imaging'
import { administratorPathologyAssetSchema, type PathologyExamCode } from '@clinmesh/contracts/pathology'
import type { PathologyAssetLibrary } from '../infrastructure/imaging-assets/pathology-asset-library.ts'
import type { InstalledPathologySlide } from '../infrastructure/imaging-assets/pathology-asset-store.ts'
import type { PathologyCatalogAsset } from '../infrastructure/imaging-assets/pathology-catalog.ts'
import { pathologyAssetFacts } from '../infrastructure/imaging-assets/pathology-matching.ts'
import { checkPathologyReport, pathologyAssetPublication } from '../infrastructure/imaging-assets/pathology-report-check.ts'
import type { ActorContext } from './command-executor.ts'
import { ImagingStudyReadError } from './imaging-study-reader.ts'

/** 一次本院病理会诊的切片在当前素材来源中的位置；由拥有会诊记录的病理适配器在完成授权后给出。 */
export interface PathologyStudyAccess {
  assetId: string
  assetOutput: unknown
  examCode: PathologyExamCode
  /** 本院为这张切片给出的显示标签，不是素材或来源标识。 */
  slideLabel: string
}

export interface SlideTilePosition {
  column: number
  level: number
  row: number
  seriesIndex: number
}

function seriesView(slide: InstalledPathologySlide, slideLabel: string): ImagingSeriesView {
  return {
    colorManaged: false,
    kind: 'tiled-pyramid',
    levels: slide.levels.map(({ height, magnification, micronsPerPixel, tileHeight, tileWidth, width }) => (
      { height, magnification, micronsPerPixel, tileHeight, tileWidth, width }
    )),
    modality: 'SM',
    slideLabel,
    tileFormat: 'jpeg',
  }
}

/**
 * 病理切片的读取边界：阅片器只凭本院检查标识读取层级几何与单个 JPEG 瓦片。
 * 一次会诊含一张切片，对应读取描述中的一个序列；文件位置、素材标识与安装方式不出现在读取结果中。
 */
export class PathologySlideReader {
  readonly #library: PathologyAssetLibrary
  readonly #studyAccess: (context: ActorContext, studyId: string) => PathologyStudyAccess | undefined

  constructor(input: {
    library: PathologyAssetLibrary
    /** 校验岗位、Workspace/Epoch、病例责任与发布状态；不是病理检查或检查不存在时返回 undefined。 */
    studyAccess: (context: ActorContext, studyId: string) => PathologyStudyAccess | undefined
  }) {
    this.#library = input.library
    this.#studyAccess = input.studyAccess
  }

  /** 检查不是当前执行者可读的病理检查时返回 undefined，由调用方交给其他影像来源判断。 */
  async describeStudy(context: ActorContext, studyId: string): Promise<ImagingStudyView | undefined> {
    const access = this.#studyAccess(context, studyId)
    if (access === undefined) return undefined
    const slide = await this.#openSlide(access)
    return imagingStudyViewSchema.parse({
      available: slide !== undefined,
      examCode: access.examCode,
      series: slide === undefined ? [] : [seriesView(slide, access.slideLabel)],
      studyId,
    })
  }

  async readStudyTile(context: ActorContext, studyId: string, position: SlideTilePosition): Promise<Uint8Array> {
    const access = this.#studyAccess(context, studyId)
    if (access === undefined) throw new ImagingStudyReadError('IMAGING_STUDY_NOT_FOUND', 'The imaging study was not found')
    const slide = await this.#openSlide(access)
    if (slide === undefined) {
      throw new ImagingStudyReadError('IMAGING_STUDY_UNAVAILABLE', 'The slide pixels are not available')
    }
    return await this.#readTile(slide, position)
  }

  /** 管理员复核切片素材：来源临床字段与派生事实、报告修订及其自动检查结果、发布状态和可直接阅片的读取描述。 */
  async describeAsset(context: ActorContext, assetId: string) {
    const asset = await this.#assetForAdministrator(context, assetId)
    const slide = await this.#library.open(asset)
    return administratorPathologyAssetSchema.parse({
      assetId: asset.assetId,
      clinical: asset.clinical,
      facts: pathologyAssetFacts(asset.clinical),
      publication: pathologyAssetPublication(asset),
      reports: (asset.reports ?? []).map(report => ({
        checkIssues: checkPathologyReport(asset, report).issues,
        diagnosis: report.diagnosis,
        immunohistochemistry: report.immunohistochemistry,
        microscopy: report.microscopy,
        note: report.note,
        ...(report.review === undefined ? {} : { review: report.review }),
        revision: report.revision,
      })),
      study: {
        available: slide !== undefined,
        examCode: 'breast-slide-consultation',
        series: slide === undefined ? [] : [seriesView(slide, '1')],
        studyId: asset.assetId,
      },
    })
  }

  async readAssetTile(context: ActorContext, assetId: string, position: SlideTilePosition): Promise<Uint8Array> {
    const slide = await this.#library.open(await this.#assetForAdministrator(context, assetId))
    if (slide === undefined) {
      throw new ImagingStudyReadError('IMAGING_STUDY_UNAVAILABLE', 'The slide pixels are not installed')
    }
    return await this.#readTile(slide, position)
  }

  /** 清单中的素材仍是会诊发布时的版本且切片已安装时返回切片，否则视为暂不可读。 */
  async #openSlide(access: PathologyStudyAccess): Promise<InstalledPathologySlide | undefined> {
    const asset = (await this.#library.catalog())?.assets.find(candidate => candidate.assetId === access.assetId)
    if (asset === undefined || !isDeepStrictEqual(asset.output, access.assetOutput)) return undefined
    return await this.#library.open(asset)
  }

  async #readTile(slide: InstalledPathologySlide, position: SlideTilePosition): Promise<Uint8Array> {
    const level = slide.levels[position.level]
    if (
      position.seriesIndex !== 0
      || level === undefined
      || position.column >= Math.ceil(level.width / level.tileWidth)
      || position.row >= Math.ceil(level.height / level.tileHeight)
    ) {
      throw new ImagingStudyReadError('IMAGING_STUDY_NOT_FOUND', 'The requested slide tile does not exist')
    }
    return await slide.readTile(position.level, position.column, position.row)
  }

  async #assetForAdministrator(context: ActorContext, assetId: string): Promise<PathologyCatalogAsset> {
    if (context.roleCode !== 'administrator') {
      throw new ImagingStudyReadError('ROLE_NOT_ALLOWED', 'Only an administrator can preview pathology assets')
    }
    const asset = (await this.#library.catalog())?.assets.find(candidate => candidate.assetId === assetId)
    if (asset === undefined) throw new ImagingStudyReadError('IMAGING_STUDY_NOT_FOUND', 'The pathology asset was not found')
    return asset
  }
}
