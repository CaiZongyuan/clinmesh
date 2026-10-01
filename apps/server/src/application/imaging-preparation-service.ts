import { isDeepStrictEqual } from 'node:util'
import {
  administratorImagingPreparationSchema,
  imagingCoverageSchema,
  imagingPreparationBatchSchema,
  type ImagingCoverage,
  type ImagingPreparationReason,
} from '@clinmesh/contracts/imaging'
import type { z } from 'zod'
import { imagingAssetInstalled } from '../infrastructure/imaging-assets/imaging-asset-store.ts'
import { loadImagingCatalog } from '../infrastructure/imaging-assets/imaging-catalog.ts'
import {
  imagingAssetPublication,
  imagingReportContentSha256,
} from '../infrastructure/imaging-assets/imaging-report-check.ts'
import type { ImagingPreparationRepository } from '../infrastructure/sqlite/imaging-preparation-repository.ts'
import type { SyntheticCaseRepository } from '../infrastructure/sqlite/synthetic-case-repository.ts'
import type { SyntheticPatientProfileRepository } from '../infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import {
  imagingExamCodes,
  imagingMatchingCatalogHash,
  matchCaseImaging,
  type ImagingMatchingCatalog,
} from './imaging-preparation.ts'

type ImagingPreparationErrorCode =
  | 'CASE_NOT_FOUND'
  | 'IMAGING_CATALOG_INVALID'
  | 'IMAGING_CATALOG_UNAVAILABLE'
  | 'ROLE_NOT_ALLOWED'

export class ImagingPreparationError extends Error {
  readonly code: ImagingPreparationErrorCode
  readonly status: 403 | 404 | 409

  constructor(code: ImagingPreparationErrorCode, message: string) {
    super(message)
    this.name = 'ImagingPreparationError'
    this.code = code
    this.status = code === 'ROLE_NOT_ALLOWED' ? 403 : code === 'CASE_NOT_FOUND' ? 404 : 409
  }
}

const batchLimit = 50

/**
 * 病例影像准备：管理员按当前素材清单为患者库中的病例确定每项检查的素材，结果以不可变修订保存。
 * 病例与素材的绑定属于 Workspace，跨 Epoch 保留；病例开始前跟随最新修订，开始后只追加、不替换。
 */
export class ImagingPreparationService {
  readonly #assetDirectory: string | undefined
  readonly #cases: SyntheticCaseRepository
  readonly #catalogDirectory: string | undefined
  readonly #commands: CommandExecutor
  readonly #preparations: ImagingPreparationRepository
  readonly #profiles: SyntheticPatientProfileRepository

  constructor(input: {
    assetDirectory?: string | undefined
    cases: SyntheticCaseRepository
    catalogDirectory?: string | undefined
    commands: CommandExecutor
    preparations: ImagingPreparationRepository
    profiles: SyntheticPatientProfileRepository
  }) {
    this.#assetDirectory = input.assetDirectory
    this.#cases = input.cases
    this.#catalogDirectory = input.catalogDirectory
    this.#commands = input.commands
    this.#preparations = input.preparations
    this.#profiles = input.profiles
  }

  async prepareBatch(input: { caseIds?: string[] | undefined; context: ActorContext; idempotencyKey: string }) {
    this.#assertAdministrator(input.context)
    const catalog = await this.#matchingCatalog()
    if (catalog === undefined) {
      throw new ImagingPreparationError(
        'IMAGING_CATALOG_UNAVAILABLE',
        'The imaging asset catalog or its matching rules are not available',
      )
    }
    const { workspaceId } = input.context
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: imagingPreparationBatchSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: { caseIds: input.caseIds ?? null, catalogHash: catalog.hash },
      operation: 'imaging-preparation.prepare',
    }, () => {
      const pending = input.caseIds === undefined
        ? this.#preparations.casesNeedingPreparation(workspaceId, catalog.hash, batchLimit)
        : { caseIds: input.caseIds, total: input.caseIds.length }
      const now = new Date().toISOString()
      const effects: Array<{ kind: 'created'; reference: string; versionId: string }> = []
      const prepared = pending.caseIds.map((caseId) => {
        const source = this.#caseSource(workspaceId, caseId)
        const started = this.#preparations.started(workspaceId, caseId)
        const existing = this.#preparations.bindings(workspaceId, caseId, source.case.sourceHash)
        const exams = matchCaseImaging({
          birthDate: source.profile.demographics.birthDate,
          // 未开始的病例重新选择；已开始的病例沿用已固定的绑定。
          bound: started ? existing : [],
          catalog,
          gender: source.profile.demographics.gender,
          historyResources: this.#cases.getVisibleResourcesForSimulator(workspaceId, caseId),
          indexEncounterReference: source.truth.indexEncounterReference,
          indexResources: source.truth.hiddenResources,
          sourceHash: source.case.sourceHash,
        })
        const latest = this.#preparations.latest(workspaceId, caseId)
        if (latest?.catalog.hash !== catalog.hash || !isDeepStrictEqual(latest.exams, exams)) {
          const preparation = this.#preparations.append({
            caseId,
            catalog: { hash: catalog.hash, packId: catalog.packId, ruleVersion: catalog.rules.ruleVersion },
            createdAt: now,
            exams,
            profileId: source.case.profileId,
            profileRevision: source.case.profileRevision,
            sourceHash: source.case.sourceHash,
          }, workspaceId, input.context.actorId)
          effects.push({
            kind: 'created',
            reference: `ImagingCasePreparation/${caseId}`,
            versionId: String(preparation.revision),
          })
          if (!started) this.#preparations.clearBindings(workspaceId, caseId, source.case.sourceHash)
          for (const exam of exams) {
            if (exam.status !== 'ready' || (started && existing.some(binding => binding.examCode === exam.examCode))) continue
            const { asset } = catalog.assets.get(exam.assetId!)!
            this.#preparations.bind({
              assetId: asset.assetId,
              assetOutput: asset.output,
              boundAt: now,
              caseId,
              examCode: exam.examCode,
              matchingProfileId: exam.matchingProfileId!,
              preparationRevision: preparation.revision,
              reportContentSha256: imagingReportContentSha256(
                asset,
                asset.reports!.find(report => report.revision === exam.reportRevision)!,
              ),
              reportRevision: exam.reportRevision!,
              sourceHash: source.case.sourceHash,
              workspaceId,
            })
          }
        }
        return this.#casePreparation(workspaceId, caseId, source.case.sourceHash)
      })
      return { data: { prepared, remaining: pending.total - prepared.length }, effects }
    })
  }

  getCasePreparation(context: ActorContext, caseId: string) {
    this.#assertAdministrator(context)
    const found = this.#cases.get(context.workspaceId, caseId)
    if (found === undefined) throw new ImagingPreparationError('CASE_NOT_FOUND', 'The Synthetic Case was not found')
    return this.#casePreparation(context.workspaceId, caseId, found.sourceHash)
  }

  async coverage(context: ActorContext): Promise<ImagingCoverage> {
    this.#assertAdministrator(context)
    const catalog = await this.#matchingCatalog()
    const total = this.#preparations.libraryCaseCount(context.workspaceId)
    if (catalog === undefined) {
      return { cases: { exams: [], prepared: 0, total }, catalog: null, exams: [], uncovered: [] }
    }
    const installed = new Map<string, boolean>()
    for (const [assetId, { asset }] of catalog.assets) {
      installed.set(assetId, this.#assetDirectory !== undefined
        && await imagingAssetInstalled({ asset, assetDirectory: this.#assetDirectory }))
    }
    const preparations = this.#preparations.latestForLibrary(context.workspaceId)
    return imagingCoverageSchema.parse({
      cases: {
        exams: imagingExamCodes.map((examCode) => {
          const exams = preparations.flatMap(preparation => preparation.exams.filter(exam => exam.examCode === examCode))
          const unsupported = new Map<ImagingPreparationReason, number>()
          for (const exam of exams) {
            if (exam.status === 'unsupported') unsupported.set(exam.reason!, (unsupported.get(exam.reason!) ?? 0) + 1)
          }
          return {
            conflict: exams.filter(exam => exam.status === 'conflict').length,
            examCode,
            ready: exams.filter(exam => exam.status === 'ready').length,
            unsupported: [...unsupported.entries()]
              .map(([reason, count]) => ({ count, reason }))
              .toSorted((left, right) => left.reason.localeCompare(right.reason)),
          }
        }),
        prepared: preparations.length,
        total,
      },
      catalog: { hash: catalog.hash, packId: catalog.packId, ruleVersion: catalog.rules.ruleVersion },
      exams: imagingExamCodes.map(examCode => ({
        examCode,
        profiles: catalog.rules.profiles.map((profile) => {
          const assetId = profile.assets[examCode]
          const entry = assetId === undefined ? undefined : catalog.assets.get(assetId)
          return {
            ageRange: profile.ageRange,
            asset: entry === undefined
              ? null
              : {
                  assetId: entry.asset.assetId,
                  blockers: [...new Set(imagingAssetPublication(entry.asset).reasons.map(reason => reason.code))],
                  installed: installed.get(entry.asset.assetId) ?? false,
                  published: entry.publishedRevisions.length > 0,
                },
            conditionCodes: profile.finding === 'positive' ? profile.conditionCodes : profile.indexConditionCodes,
            finding: profile.finding,
            id: profile.id,
            label: profile.label,
            ...(profile.sex === undefined ? {} : { sex: profile.sex }),
          }
        }),
      })),
      uncovered: catalog.rules.uncoveredConditions,
    })
  }

  /** 每次读取磁盘上的清单，清单更新后无需重启即可重新准备。目录或适配规则缺失时没有可用清单；内容无效时报告给管理员。 */
  async #matchingCatalog(): Promise<ImagingMatchingCatalog | undefined> {
    if (this.#catalogDirectory === undefined) return undefined
    let catalog: Awaited<ReturnType<typeof loadImagingCatalog>>
    try {
      catalog = await loadImagingCatalog(this.#catalogDirectory)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw new ImagingPreparationError(
        'IMAGING_CATALOG_INVALID',
        `The imaging asset catalog cannot be loaded: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (catalog.matching === undefined) return undefined
    const referenced = new Set(catalog.matching.profiles.flatMap(profile => Object.values(profile.assets)))
    const assets: ImagingMatchingCatalog['assets'] = new Map(catalog.assets
      .filter(asset => referenced.has(asset.assetId))
      .map(asset => [asset.assetId, {
        asset,
        publishedRevisions: imagingAssetPublication(asset).publishedRevisions.toSorted((left, right) => left - right),
      }]))
    return {
      assets,
      hash: imagingMatchingCatalogHash(catalog.matching, assets),
      packId: catalog.manifest.packId,
      rules: catalog.matching,
    }
  }

  #caseSource(workspaceId: string, caseId: string) {
    const found = this.#cases.get(workspaceId, caseId)
    const truth = found === undefined ? undefined : this.#cases.getTruthForSimulator(workspaceId, caseId)
    const profile = found === undefined
      ? undefined
      : this.#profiles.getRevision(workspaceId, found.profileId, found.profileRevision)
    if (found === undefined || truth === undefined || profile === undefined) {
      throw new ImagingPreparationError('CASE_NOT_FOUND', 'The Synthetic Case was not found')
    }
    return { case: found, profile, truth }
  }

  #casePreparation(
    workspaceId: string,
    caseId: string,
    sourceHash: string,
  ): z.infer<typeof administratorImagingPreparationSchema> {
    return {
      bindings: this.#preparations.bindings(workspaceId, caseId, sourceHash),
      caseId,
      preparation: this.#preparations.latest(workspaceId, caseId) ?? null,
      started: this.#preparations.started(workspaceId, caseId),
    }
  }

  #assertAdministrator(context: ActorContext): void {
    if (context.roleCode !== 'administrator') {
      throw new ImagingPreparationError('ROLE_NOT_ALLOWED', 'Only an administrator can manage imaging preparation')
    }
  }
}
