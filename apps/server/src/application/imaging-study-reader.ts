import { isDeepStrictEqual } from 'node:util'
import {
  administratorImagingAssetSchema,
  imagingStudyViewSchema,
  type ImagingExamCode,
  type ImagingSeriesView,
  type ImagingStudyView,
} from '@clinmesh/contracts/imaging'
import type { ImagingAssetLibrary } from '../infrastructure/imaging-assets/imaging-asset-library.ts'
import type { InstalledImagingSeries } from '../infrastructure/imaging-assets/imaging-asset-store.ts'
import type { ImagingCatalogAsset } from '../infrastructure/imaging-assets/imaging-catalog.ts'
import { checkImagingReport, imagingAssetPublication } from '../infrastructure/imaging-assets/imaging-report-check.ts'
import type { ActorContext } from './command-executor.ts'

type ImagingStudyReadErrorCode = 'IMAGING_STUDY_NOT_FOUND' | 'IMAGING_STUDY_UNAVAILABLE' | 'ROLE_NOT_ALLOWED'

export class ImagingStudyReadError extends Error {
  readonly code: ImagingStudyReadErrorCode
  readonly status: 403 | 404 | 409

  constructor(code: ImagingStudyReadErrorCode, message: string) {
    super(message)
    this.name = 'ImagingStudyReadError'
    this.code = code
    this.status = code === 'ROLE_NOT_ALLOWED' ? 403 : code === 'IMAGING_STUDY_NOT_FOUND' ? 404 : 409
  }
}

/** 一次本院检查在当前影像来源中的位置；由拥有检查记录的放射适配器在完成授权后给出。 */
export interface ImagingStudyAccess {
  assetId: string
  assetOutput: unknown
  examCode: ImagingExamCode
}

function seriesView(series: InstalledImagingSeries): ImagingSeriesView {
  const { geometry } = series
  return {
    frames: geometry.frames.map(frame => ({
      blocks: frame.blocks.map(({ length, rowCount, rowStart }) => ({ length, rowCount, rowStart })),
      columns: frame.columns,
      pixelSpacingMm: frame.pixelSpacingMm,
      ...(frame.positionMm === undefined ? {} : { positionMm: frame.positionMm }),
      rows: frame.rows,
      ...(frame.view === undefined ? {} : { view: frame.view }),
      ...(frame.viewPosition === undefined ? {} : { viewPosition: frame.viewPosition }),
      ...(frame.window === undefined ? {} : { window: frame.window }),
    })),
    kind: 'frame-stack',
    modality: geometry.modality,
    pixelFormat: geometry.pixelFormat,
    valueUnit: geometry.valueUnit,
  }
}

/**
 * 影像读取边界：阅片器只凭本院检查标识读取显示所需的几何与有界像素块。
 * 当前唯一的影像来源是本地已安装素材；文件位置、素材标识与安装方式不出现在读取结果中。
 */
export class ImagingStudyReader {
  readonly #library: ImagingAssetLibrary
  readonly #studyAccess: (context: ActorContext, studyId: string) => ImagingStudyAccess | undefined

  constructor(input: {
    library: ImagingAssetLibrary
    /** 校验岗位、Workspace/Epoch、病例责任与发布状态；检查不存在时返回 undefined。 */
    studyAccess: (context: ActorContext, studyId: string) => ImagingStudyAccess | undefined
  }) {
    this.#library = input.library
    this.#studyAccess = input.studyAccess
  }

  async describeStudy(context: ActorContext, studyId: string): Promise<ImagingStudyView> {
    const access = this.#requiredAccess(context, studyId)
    const series = await this.#openSeries(access)
    return imagingStudyViewSchema.parse({
      available: series !== undefined,
      examCode: access.examCode,
      series: series?.map(seriesView) ?? [],
      studyId,
    })
  }

  async readStudyBlock(
    context: ActorContext,
    studyId: string,
    position: { blockIndex: number; frameIndex: number; seriesIndex: number },
  ): Promise<Uint8Array> {
    const series = await this.#openSeries(this.#requiredAccess(context, studyId))
    if (series === undefined) {
      throw new ImagingStudyReadError('IMAGING_STUDY_UNAVAILABLE', 'The imaging study pixels are not available')
    }
    return await this.#readBlock(series, position)
  }

  /** 管理员复核素材：标注、报告修订及其自动检查结果、发布状态和可直接阅片的读取描述。 */
  async describeAsset(context: ActorContext, assetId: string) {
    const asset = await this.#assetForAdministrator(context, assetId)
    const series = await this.#library.open(asset)
    return administratorImagingAssetSchema.parse({
      ...(asset.annotation === undefined ? {} : { annotation: asset.annotation }),
      assetId: asset.assetId,
      publication: imagingAssetPublication(asset),
      reports: (asset.reports ?? []).map(report => ({
        checkIssues: checkImagingReport(asset, report).issues,
        findings: report.findings,
        impression: report.impression,
        ...(report.review === undefined ? {} : { review: report.review }),
        revision: report.revision,
        technique: report.technique,
      })),
      study: {
        available: series !== undefined,
        examCode: asset.examCode,
        series: series?.map(seriesView) ?? [],
        studyId: asset.assetId,
      },
    })
  }

  async readAssetBlock(
    context: ActorContext,
    assetId: string,
    position: { blockIndex: number; frameIndex: number; seriesIndex: number },
  ): Promise<Uint8Array> {
    const series = await this.#library.open(await this.#assetForAdministrator(context, assetId))
    if (series === undefined) {
      throw new ImagingStudyReadError('IMAGING_STUDY_UNAVAILABLE', 'The imaging asset pixels are not installed')
    }
    return await this.#readBlock(series, position)
  }

  #requiredAccess(context: ActorContext, studyId: string): ImagingStudyAccess {
    const access = this.#studyAccess(context, studyId)
    if (access === undefined) throw new ImagingStudyReadError('IMAGING_STUDY_NOT_FOUND', 'The imaging study was not found')
    return access
  }

  /** 清单中的素材仍是检查发布时的版本且像素已安装时返回各序列，否则视为暂不可读。 */
  async #openSeries(access: ImagingStudyAccess): Promise<InstalledImagingSeries[] | undefined> {
    const asset = (await this.#library.catalog())?.assets.find(candidate => candidate.assetId === access.assetId)
    if (asset === undefined || !isDeepStrictEqual(asset.output, access.assetOutput)) return undefined
    return await this.#library.open(asset)
  }

  async #readBlock(
    series: InstalledImagingSeries[],
    position: { blockIndex: number; frameIndex: number; seriesIndex: number },
  ): Promise<Uint8Array> {
    const target = series[position.seriesIndex]
    if (target?.geometry.frames[position.frameIndex]?.blocks[position.blockIndex] === undefined) {
      throw new ImagingStudyReadError('IMAGING_STUDY_NOT_FOUND', 'The requested pixel block does not exist')
    }
    return await target.readBlock(position.frameIndex, position.blockIndex)
  }

  async #assetForAdministrator(context: ActorContext, assetId: string): Promise<ImagingCatalogAsset> {
    if (context.roleCode !== 'administrator') {
      throw new ImagingStudyReadError('ROLE_NOT_ALLOWED', 'Only an administrator can preview imaging assets')
    }
    const asset = (await this.#library.catalog())?.assets.find(candidate => candidate.assetId === assetId)
    if (asset === undefined) throw new ImagingStudyReadError('IMAGING_STUDY_NOT_FOUND', 'The imaging asset was not found')
    return asset
  }
}
