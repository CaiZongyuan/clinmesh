import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { PathologyAssetLibrary } from '../infrastructure/imaging-assets/pathology-asset-library.ts'
import type { PathologyCatalogAsset } from '../infrastructure/imaging-assets/pathology-catalog.ts'
import {
  pathologyAssetPublication,
  pathologyReportContentSha256,
} from '../infrastructure/imaging-assets/pathology-report-check.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { PathologyPreparationRepository } from '../infrastructure/sqlite/pathology-preparation-repository.ts'
import type { PathologyResult } from './pathology-request-service.ts'

export type PathologyResultUnavailableReason =
  | 'ASSET_CHANGED'
  | 'ASSET_NOT_INSTALLED'
  | 'CASE_NOT_PREPARED'
  | 'REPORT_REVISION_NOT_PUBLISHED'
  | 'REQUEST_NOT_FOUND'

/** 一次会诊无法从已核对的切片素材取得结果；`reason` 只供管理员与日志使用，不进入临床读模型。 */
export class PathologyResultUnavailableError extends Error {
  readonly reason: PathologyResultUnavailableReason

  constructor(reason: PathologyResultUnavailableReason) {
    super(`The pathology result is unavailable: ${reason}`)
    this.name = 'PathologyResultUnavailableError'
    this.reason = reason
  }
}

/**
 * 在命令之外解析一次病理会诊应使用的切片与报告内容：按申请所选的来源手术读取病例的固定绑定，确认清单中的
 * 素材版本与报告修订仍与绑定一致，并核对切片确已安装。运行时不选片、不改绑定。
 */
export class PathologyResultResolver {
  readonly #database: ClinMeshDatabase
  readonly #library: PathologyAssetLibrary
  readonly #preparations: PathologyPreparationRepository

  constructor(input: {
    database: ClinMeshDatabase
    library: PathologyAssetLibrary
    preparations: PathologyPreparationRepository
  }) {
    this.#database = input.database
    this.#library = input.library
    this.#preparations = input.preparations
  }

  /** 首次报告：使用绑定固定的素材版本与报告修订，发布前逐字节核对切片文件。 */
  async resolveForRequest(workspaceId: string, epoch: string, requestId: string): Promise<PathologyResult> {
    const request = z.object({
      exam_code: z.string().min(1),
      source_hash: z.string().min(1),
      source_procedure_reference: z.string().min(1),
      synthetic_case_id: z.string().min(1),
    }).strict().optional().parse(this.#database.driver.prepare(`
      SELECT detail.exam_code, detail.source_procedure_reference,
        materialization.case_id AS synthetic_case_id, synthetic_case.source_hash
      FROM laboratory_request AS request
      JOIN pathology_request_detail AS detail
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
        AND request.request_kind = 'pathology'
    `).get(workspaceId, epoch, requestId))
    const binding = request === undefined
      ? undefined
      : this.#preparations.bindingRecord({
          caseId: request.synthetic_case_id,
          examCode: request.exam_code,
          sourceHash: request.source_hash,
          sourceProcedureReference: request.source_procedure_reference,
          workspaceId,
        })
    if (binding === undefined) throw new PathologyResultUnavailableError('CASE_NOT_PREPARED')
    const asset = await this.#asset(binding.assetId, binding.assetOutput)
    const result = this.#result(asset, binding.reportRevision)
    if (result.reportContentSha256 !== binding.reportContentSha256) {
      throw new PathologyResultUnavailableError('REPORT_REVISION_NOT_PUBLISHED')
    }
    if (!await this.#library.verified(asset)) throw new PathologyResultUnavailableError('ASSET_NOT_INSTALLED')
    return result
  }

  /** 更正：同一会诊的切片不变，取该素材另一份已核对发布的报告修订。 */
  async resolveCorrection(
    workspaceId: string,
    epoch: string,
    requestId: string,
    reportRevision: number,
  ): Promise<PathologyResult> {
    const study = this.#study(workspaceId, epoch, requestId)
    if (study === undefined) throw new PathologyResultUnavailableError('REQUEST_NOT_FOUND')
    return this.#result(await this.#asset(study.assetId, study.assetOutput), reportRevision)
  }

  /** 一次已发布会诊的切片当前是否可读且与清单哈希一致；确认已阅前要求可读。 */
  async studyAvailable(workspaceId: string, epoch: string, requestId: string): Promise<boolean> {
    const study = this.#study(workspaceId, epoch, requestId)
    if (study === undefined) return false
    try {
      return await this.#library.open(await this.#asset(study.assetId, study.assetOutput)) !== undefined
    } catch (error) {
      if (error instanceof PathologyResultUnavailableError) return false
      throw error
    }
  }

  #study(workspaceId: string, epoch: string, requestId: string) {
    const row = z.object({ asset_id: z.string().min(1), asset_output_json: z.string().min(1) }).strict().optional()
      .parse(this.#database.driver.prepare(`
        SELECT asset_id, asset_output_json FROM pathology_study
        WHERE workspace_id = ? AND epoch = ? AND request_id = ?
      `).get(workspaceId, epoch, requestId))
    return row === undefined ? undefined : { assetId: row.asset_id, assetOutput: JSON.parse(row.asset_output_json) as unknown }
  }

  async #asset(assetId: string, expectedOutput: unknown): Promise<PathologyCatalogAsset> {
    const asset = (await this.#library.catalog())?.assets.find(candidate => candidate.assetId === assetId)
    if (asset === undefined || !isDeepStrictEqual(asset.output, expectedOutput)) {
      throw new PathologyResultUnavailableError('ASSET_CHANGED')
    }
    return asset
  }

  #result(asset: PathologyCatalogAsset, reportRevision: number): PathologyResult {
    const report = asset.reports?.find(candidate => candidate.revision === reportRevision)
    if (report === undefined || !pathologyAssetPublication(asset).publishedRevisions.includes(reportRevision)) {
      throw new PathologyResultUnavailableError('REPORT_REVISION_NOT_PUBLISHED')
    }
    return {
      assetId: asset.assetId,
      assetOutput: asset.output,
      diagnosis: report.diagnosis,
      immunohistochemistry: report.immunohistochemistry,
      microscopy: report.microscopy,
      note: report.note,
      reportContentSha256: pathologyReportContentSha256(asset, report),
      reportRevision,
      slideCount: report.specimen.slideCount,
    }
  }
}
