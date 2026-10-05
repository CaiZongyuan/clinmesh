import {
  pathologyCaseBindingSchema,
  pathologyCasePreparationSchema,
  type PathologyCaseBinding,
  type PathologyCasePreparation,
} from '@clinmesh/contracts/pathology'
import { z } from 'zod'
import type { ClinMeshDatabase } from './database.ts'

const preparationRowSchema = z.object({
  case_id: z.string().min(1),
  catalog_hash: z.string().regex(/^[a-f0-9]{64}$/),
  catalog_pack_id: z.string().min(1),
  created_at: z.iso.datetime({ offset: true }),
  exams_json: z.string().min(1),
  profile_id: z.string().min(1),
  profile_revision: z.number().int().positive(),
  revision: z.number().int().positive(),
  rule_version: z.number().int().positive(),
  source_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

const bindingRowSchema = z.object({
  asset_id: z.string().min(1),
  bound_at: z.iso.datetime({ offset: true }),
  exam_code: z.string().min(1),
  matching_profile_id: z.string().min(1),
  preparation_revision: z.number().int().positive(),
  report_revision: z.number().int().positive(),
  source_procedure_reference: z.string().min(1),
}).strict()

const selectPreparation = `
  SELECT case_id, revision, profile_id, profile_revision, source_hash,
    catalog_pack_id, rule_version, catalog_hash, exams_json, created_at
  FROM pathology_case_preparation
`

/** 当前患者库中的病例：不含已退役病例。 */
const libraryCase = `
  FROM synthetic_case_instance AS synthetic_case
  WHERE synthetic_case.workspace_id = ? AND synthetic_case.status != 'retired'
`

const latestPreparation = `
  SELECT preparation.catalog_hash
  FROM pathology_case_preparation AS preparation
  WHERE preparation.workspace_id = synthetic_case.workspace_id
    AND preparation.case_id = synthetic_case.case_id
  ORDER BY preparation.revision DESC
  LIMIT 1
`

export class PathologyPreparationRepository {
  readonly #database: ClinMeshDatabase

  constructor(database: ClinMeshDatabase) {
    this.#database = database
  }

  latest(workspaceId: string, caseId: string): PathologyCasePreparation | undefined {
    const row = this.#database.driver.prepare(`${selectPreparation}
      WHERE workspace_id = ? AND case_id = ?
      ORDER BY revision DESC
      LIMIT 1
    `).get(workspaceId, caseId)
    return row === undefined ? undefined : this.#mapPreparation(preparationRowSchema.parse(row))
  }

  /** 当前患者库每个病例最近一次准备的结果，用于覆盖统计。 */
  latestForLibrary(workspaceId: string): PathologyCasePreparation[] {
    return z.array(preparationRowSchema).parse(this.#database.driver.prepare(`${selectPreparation}
      WHERE workspace_id = ?
        AND case_id IN (SELECT synthetic_case.case_id ${libraryCase})
        AND revision = (
          SELECT MAX(latest.revision)
          FROM pathology_case_preparation AS latest
          WHERE latest.workspace_id = pathology_case_preparation.workspace_id
            AND latest.case_id = pathology_case_preparation.case_id
        )
      ORDER BY case_id
    `).all(workspaceId, workspaceId)).map(row => this.#mapPreparation(row))
  }

  libraryCaseCount(workspaceId: string): number {
    return z.object({ total: z.number().int().nonnegative() }).parse(this.#database.driver.prepare(`
      SELECT COUNT(*) AS total ${libraryCase}
    `).get(workspaceId)).total
  }

  /** 尚未按当前规则与素材版本准备过的病例。 */
  casesNeedingPreparation(workspaceId: string, catalogHash: string, limit: number): {
    caseIds: string[]
    total: number
  } {
    const pending = `${libraryCase} AND COALESCE((${latestPreparation}), '') != ?`
    return {
      caseIds: z.array(z.object({ case_id: z.string().min(1) })).parse(this.#database.driver.prepare(`
        SELECT synthetic_case.case_id ${pending}
        ORDER BY synthetic_case.case_id
        LIMIT ?
      `).all(workspaceId, catalogHash, limit)).map(row => row.case_id),
      total: z.object({ total: z.number().int().nonnegative() }).parse(this.#database.driver.prepare(`
        SELECT COUNT(*) AS total ${pending}
      `).get(workspaceId, catalogHash)).total,
    }
  }

  /** 病例是否在任一 Epoch 开始过；开始后的绑定不再替换。 */
  started(workspaceId: string, caseId: string): boolean {
    return this.#database.driver.prepare(`
      SELECT 1 AS present
      FROM synthetic_case_materialization
      WHERE workspace_id = ? AND case_id = ?
      LIMIT 1
    `).get(workspaceId, caseId) !== undefined
  }

  /** 本院门诊病例（按病例或就诊标识）在当前 Epoch 对应的合成病例；不是由合成病例开始的就诊返回 undefined。 */
  materializedCase(
    workspaceId: string,
    epoch: string,
    key: { encounterId: string } | { outpatientCaseId: string },
  ): string | undefined {
    const [column, value] = 'encounterId' in key
      ? ['encounter_id', key.encounterId] as const
      : ['outpatient_case_id', key.outpatientCaseId] as const
    return z.object({ case_id: z.string().min(1) }).strict().optional().parse(this.#database.driver.prepare(`
      SELECT case_id FROM synthetic_case_materialization
      WHERE workspace_id = ? AND epoch = ? AND ${column} = ?
    `).get(workspaceId, epoch, value))?.case_id
  }

  append(preparation: Omit<PathologyCasePreparation, 'revision'>, workspaceId: string, actorId: string): PathologyCasePreparation {
    const revision = (this.latest(workspaceId, preparation.caseId)?.revision ?? 0) + 1
    const parsed = pathologyCasePreparationSchema.parse({ ...preparation, revision })
    this.#database.driver.prepare(`
      INSERT INTO pathology_case_preparation (
        workspace_id, case_id, revision, profile_id, profile_revision, source_hash,
        catalog_pack_id, rule_version, catalog_hash, exams_json, created_by_actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workspaceId,
      parsed.caseId,
      parsed.revision,
      parsed.profileId,
      parsed.profileRevision,
      parsed.sourceHash,
      parsed.catalog.packId,
      parsed.catalog.ruleVersion,
      parsed.catalog.hash,
      JSON.stringify(parsed.exams),
      actorId,
      parsed.createdAt,
    )
    return parsed
  }

  bindings(workspaceId: string, caseId: string, sourceHash: string): PathologyCaseBinding[] {
    return z.array(bindingRowSchema).parse(this.#database.driver.prepare(`
      SELECT exam_code, source_procedure_reference, preparation_revision, matching_profile_id,
        asset_id, report_revision, bound_at
      FROM pathology_case_binding
      WHERE workspace_id = ? AND case_id = ? AND source_hash = ?
      ORDER BY exam_code, source_procedure_reference
    `).all(workspaceId, caseId, sourceHash)).map(row => pathologyCaseBindingSchema.parse({
      assetId: row.asset_id,
      boundAt: row.bound_at,
      examCode: row.exam_code,
      matchingProfileId: row.matching_profile_id,
      preparationRevision: row.preparation_revision,
      reportRevision: row.report_revision,
      sourceProcedureReference: row.source_procedure_reference,
    }))
  }

  /** 执行会诊时使用的固定绑定，含绑定时的素材版本与报告内容哈希。 */
  bindingRecord(input: {
    caseId: string
    examCode: string
    sourceHash: string
    sourceProcedureReference: string
    workspaceId: string
  }): {
    assetId: string
    assetOutput: unknown
    reportContentSha256: string
    reportRevision: number
  } | undefined {
    const row = z.object({
      asset_id: z.string().min(1),
      asset_output_json: z.string().min(1),
      report_content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      report_revision: z.number().int().positive(),
    }).strict().optional().parse(this.#database.driver.prepare(`
      SELECT asset_id, asset_output_json, report_revision, report_content_sha256
      FROM pathology_case_binding
      WHERE workspace_id = ? AND case_id = ? AND source_hash = ? AND exam_code = ?
        AND source_procedure_reference = ?
    `).get(input.workspaceId, input.caseId, input.sourceHash, input.examCode, input.sourceProcedureReference))
    return row === undefined
      ? undefined
      : {
          assetId: row.asset_id,
          assetOutput: JSON.parse(row.asset_output_json),
          reportContentSha256: row.report_content_sha256,
          reportRevision: row.report_revision,
        }
  }

  clearBindings(workspaceId: string, caseId: string, sourceHash: string): void {
    this.#database.driver.prepare(`
      DELETE FROM pathology_case_binding
      WHERE workspace_id = ? AND case_id = ? AND source_hash = ?
    `).run(workspaceId, caseId, sourceHash)
  }

  bind(input: PathologyCaseBinding & {
    assetOutput: unknown
    caseId: string
    reportContentSha256: string
    sourceHash: string
    workspaceId: string
  }): void {
    this.#database.driver.prepare(`
      INSERT INTO pathology_case_binding (
        workspace_id, case_id, source_hash, exam_code, source_procedure_reference, preparation_revision,
        matching_profile_id, asset_id, asset_output_json, report_revision, report_content_sha256, bound_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.workspaceId,
      input.caseId,
      input.sourceHash,
      input.examCode,
      input.sourceProcedureReference,
      input.preparationRevision,
      input.matchingProfileId,
      input.assetId,
      JSON.stringify(input.assetOutput),
      input.reportRevision,
      input.reportContentSha256,
      input.boundAt,
    )
  }

  #mapPreparation(row: z.infer<typeof preparationRowSchema>): PathologyCasePreparation {
    return pathologyCasePreparationSchema.parse({
      caseId: row.case_id,
      catalog: { hash: row.catalog_hash, packId: row.catalog_pack_id, ruleVersion: row.rule_version },
      createdAt: row.created_at,
      exams: JSON.parse(row.exams_json),
      profileId: row.profile_id,
      profileRevision: row.profile_revision,
      revision: row.revision,
      sourceHash: row.source_hash,
    })
  }
}
