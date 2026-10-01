import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { ImagingAssetLibrary } from '../infrastructure/imaging-assets/imaging-asset-library.ts'
import type { ImagingCatalogAsset } from '../infrastructure/imaging-assets/imaging-catalog.ts'
import {
  imagingAssetPublication,
  imagingReportContentSha256,
} from '../infrastructure/imaging-assets/imaging-report-check.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ImagingPreparationRepository } from '../infrastructure/sqlite/imaging-preparation-repository.ts'
import type { ImagingResult } from './imaging-request-service.ts'

export type ImagingResultUnavailableReason =
  | 'ASSET_CHANGED'
  | 'ASSET_NOT_INSTALLED'
  | 'CASE_NOT_PREPARED'
  | 'REPORT_REVISION_NOT_PUBLISHED'
  | 'REQUEST_NOT_FOUND'

/** 一次检查无法从已核对素材取得结果；`reason` 只供管理员与日志使用，不进入临床读模型。 */
export class ImagingResultUnavailableError extends Error {
  readonly reason: ImagingResultUnavailableReason

  constructor(reason: ImagingResultUnavailableReason) {
    super(`The imaging result is unavailable: ${reason}`)
    this.name = 'ImagingResultUnavailableError'
    this.reason = reason
  }
}

/**
 * 在命令之外解析一次放射检查应使用的素材与报告内容：读取病例的固定绑定，确认清单中的素材版本与
 * 报告修订仍与绑定一致，并核对像素确已安装。运行时不选片、不改绑定。
 */
export class ImagingResultResolver {
  readonly #database: ClinMeshDatabase
  readonly #library: ImagingAssetLibrary
  readonly #preparations: ImagingPreparationRepository

  constructor(input: {
    database: ClinMeshDatabase
    library: ImagingAssetLibrary
    preparations: ImagingPreparationRepository
  }) {
    this.#database = input.database
    this.#library = input.library
    this.#preparations = input.preparations
  }

  /** 首次报告：使用绑定固定的素材版本与报告修订，发布前逐字节核对像素。 */
  async resolveForRequest(workspaceId: string, epoch: string, requestId: string): Promise<ImagingResult> {
    const request = z.object({
      exam_code: z.string().min(1),
      source_hash: z.string().min(1),
      synthetic_case_id: z.string().min(1),
    }).strict().optional().parse(this.#database.driver.prepare(`
      SELECT detail.exam_code, materialization.case_id AS synthetic_case_id, synthetic_case.source_hash
      FROM laboratory_request AS request
      JOIN imaging_request_detail AS detail
        ON detail.workspace_id = request.workspace_id
       AND detail.epoch = request.epoch
       AND detail.request_id = request.request_id
      JOIN synthetic_case_materialization AS materialization
        ON materialization.workspace_id = request.workspace_id
       AND materialization.epoch = request.epoch
       AND materialization.outpatient_case_id = request.case_id
      JOIN synthetic_case_instance AS synthetic_case
        ON synthetic_case.workspace_id = materialization.workspace_id
       AND synthetic_case.case_id = materialization.case_id
      WHERE request.workspace_id = ? AND request.epoch = ? AND request.request_id = ?
        AND request.request_kind = 'imaging'
    `).get(workspaceId, epoch, requestId))
    const binding = request === undefined
      ? undefined
      : this.#preparations.bindingRecord(workspaceId, request.synthetic_case_id, request.source_hash, request.exam_code)
    if (binding === undefined) throw new ImagingResultUnavailableError('CASE_NOT_PREPARED')
    const asset = await this.#asset(binding.assetId, binding.assetOutput)
    const result = this.#result(asset, binding.reportRevision)
    if (result.reportContentSha256 !== binding.reportContentSha256) {
      throw new ImagingResultUnavailableError('REPORT_REVISION_NOT_PUBLISHED')
    }
    if (!await this.#library.verified(asset)) throw new ImagingResultUnavailableError('ASSET_NOT_INSTALLED')
    return result
  }

  /** 更正：同一检查的素材不变，取该素材另一份已核对发布的报告修订。 */
  async resolveCorrection(
    workspaceId: string,
    epoch: string,
    requestId: string,
    reportRevision: number,
  ): Promise<ImagingResult> {
    const study = this.#study(workspaceId, epoch, requestId)
    if (study === undefined) throw new ImagingResultUnavailableError('REQUEST_NOT_FOUND')
    return this.#result(await this.#asset(study.assetId, study.assetOutput), reportRevision)
  }

  /** 一次已发布检查的像素当前是否可读；确认已阅前要求可读。 */
  async studyAvailable(workspaceId: string, epoch: string, requestId: string): Promise<boolean> {
    const study = this.#study(workspaceId, epoch, requestId)
    if (study === undefined) return false
    try {
      return await this.#library.installed(await this.#asset(study.assetId, study.assetOutput))
    } catch (error) {
      if (error instanceof ImagingResultUnavailableError) return false
      throw error
    }
  }

  #study(workspaceId: string, epoch: string, requestId: string) {
    const row = z.object({ asset_id: z.string().min(1), asset_output_json: z.string().min(1) }).strict().optional()
      .parse(this.#database.driver.prepare(`
        SELECT asset_id, asset_output_json FROM imaging_study
        WHERE workspace_id = ? AND epoch = ? AND request_id = ?
      `).get(workspaceId, epoch, requestId))
    return row === undefined ? undefined : { assetId: row.asset_id, assetOutput: JSON.parse(row.asset_output_json) as unknown }
  }

  async #asset(assetId: string, expectedOutput: unknown): Promise<ImagingCatalogAsset> {
    const asset = (await this.#library.catalog())?.assets.find(candidate => candidate.assetId === assetId)
    if (asset === undefined || !isDeepStrictEqual(asset.output, expectedOutput)) {
      throw new ImagingResultUnavailableError('ASSET_CHANGED')
    }
    return asset
  }

  #result(asset: ImagingCatalogAsset, reportRevision: number): ImagingResult {
    const report = asset.reports?.find(candidate => candidate.revision === reportRevision)
    if (report === undefined || !imagingAssetPublication(asset).publishedRevisions.includes(reportRevision)) {
      throw new ImagingResultUnavailableError('REPORT_REVISION_NOT_PUBLISHED')
    }
    return {
      assetId: asset.assetId,
      assetOutput: asset.output,
      findings: report.findings,
      impression: report.impression,
      reportContentSha256: imagingReportContentSha256(asset, report),
      reportRevision,
      technique: report.technique,
    }
  }
}
