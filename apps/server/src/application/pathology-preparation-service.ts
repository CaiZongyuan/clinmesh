import { isDeepStrictEqual } from 'node:util'
import {
  administratorPathologyPreparationSchema,
  pathologyCoverageSchema,
  pathologyPreparationBatchSchema,
  type PathologyCoverage,
  type PathologyExamCode,
  type PathologyPreparationReason,
  type PathologySourceProcedure,
} from '@clinmesh/contracts/pathology'
import type {
  ScenarioGenerationTarget,
  SyntheaKeepCriteria,
} from '@clinmesh/contracts/scenario'
import type { z } from 'zod'
import { ImagingCatalogInvalidError } from '../infrastructure/imaging-assets/imaging-pack-library.ts'
import type { PathologyAssetLibrary } from '../infrastructure/imaging-assets/pathology-asset-library.ts'
import {
  pathologyAssetFacts,
  pathologyFactNames,
  pathologyProfile,
} from '../infrastructure/imaging-assets/pathology-matching.ts'
import {
  pathologyAssetPublication,
  pathologyReportContentSha256,
} from '../infrastructure/imaging-assets/pathology-report-check.ts'
import type { PathologyPreparationRepository } from '../infrastructure/sqlite/pathology-preparation-repository.ts'
import type { SyntheticCaseRepository } from '../infrastructure/sqlite/synthetic-case-repository.ts'
import type { SyntheticPatientProfileRepository } from '../infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import type { SourceResource } from './imaging-preparation.ts'
import {
  indexVisitStart,
  matchCasePathology,
  pathologyMatchingCatalogHash,
  pathologySourceProcedures,
  type PathologyMatchingCatalog,
} from './pathology-preparation.ts'

type PathologyPreparationErrorCode =
  | 'CASE_NOT_FOUND'
  | 'PATHOLOGY_CATALOG_INVALID'
  | 'PATHOLOGY_CATALOG_UNAVAILABLE'
  | 'ROLE_NOT_ALLOWED'

export class PathologyPreparationError extends Error {
  readonly code: PathologyPreparationErrorCode
  readonly status: 403 | 404 | 409

  constructor(code: PathologyPreparationErrorCode, message: string) {
    super(message)
    this.name = 'PathologyPreparationError'
    this.code = code
    this.status = code === 'ROLE_NOT_ALLOWED' ? 403 : code === 'CASE_NOT_FOUND' ? 404 : 409
  }
}

const batchLimit = 50

/**
 * 病例病理准备：管理员按当前病理素材清单为患者库中的病例确定每个可送检来源手术的切片素材，结果以不可变修订保存。
 * 病例、来源手术与素材的绑定属于 Workspace，跨 Epoch 保留；病例开始前跟随最新修订，开始后只追加、不替换。
 */
export class PathologyPreparationService {
  readonly #cases: SyntheticCaseRepository
  readonly #commands: CommandExecutor
  readonly #library: PathologyAssetLibrary
  readonly #preparations: PathologyPreparationRepository
  readonly #profiles: SyntheticPatientProfileRepository

  constructor(input: {
    cases: SyntheticCaseRepository
    commands: CommandExecutor
    library: PathologyAssetLibrary
    preparations: PathologyPreparationRepository
    profiles: SyntheticPatientProfileRepository
  }) {
    this.#cases = input.cases
    this.#commands = input.commands
    this.#library = input.library
    this.#preparations = input.preparations
    this.#profiles = input.profiles
  }

  async prepareBatch(input: { caseIds?: string[] | undefined; context: ActorContext; idempotencyKey: string }) {
    this.#assertAdministrator(input.context)
    const catalog = await this.#matchingCatalog()
    if (catalog === undefined) {
      throw new PathologyPreparationError(
        'PATHOLOGY_CATALOG_UNAVAILABLE',
        'The pathology asset catalog or its matching rules are not available',
      )
    }
    const { workspaceId } = input.context
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: pathologyPreparationBatchSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: { caseIds: input.caseIds ?? null, catalogHash: catalog.hash },
      operation: 'pathology-preparation.prepare',
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
        const exams = matchCasePathology({
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
            reference: `PathologyCasePreparation/${caseId}`,
            versionId: String(preparation.revision),
          })
          if (!started) this.#preparations.clearBindings(workspaceId, caseId, source.case.sourceHash)
          for (const exam of exams) {
            for (const procedure of exam.sourceProcedures) {
              if (procedure.assetId === undefined || (started && existing.some(binding => binding.examCode === exam.examCode
                && binding.sourceProcedureReference === procedure.sourceReference))) continue
              const { asset } = catalog.assets.get(procedure.assetId)!
              this.#preparations.bind({
                assetId: asset.assetId,
                assetOutput: asset.output,
                boundAt: now,
                caseId,
                examCode: exam.examCode,
                matchingProfileId: exam.matchingProfileId!,
                preparationRevision: preparation.revision,
                reportContentSha256: pathologyReportContentSha256(
                  asset,
                  asset.reports!.find(report => report.revision === procedure.reportRevision)!,
                ),
                reportRevision: procedure.reportRevision!,
                sourceHash: source.case.sourceHash,
                sourceProcedureReference: procedure.sourceReference,
                workspaceId,
              })
            }
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
    if (found === undefined) throw new PathologyPreparationError('CASE_NOT_FOUND', 'The Synthetic Case was not found')
    return this.#casePreparation(context.workspaceId, caseId, found.sourceHash)
  }

  async coverage(context: ActorContext): Promise<PathologyCoverage> {
    this.#assertAdministrator(context)
    const catalog = await this.#matchingCatalog()
    const total = this.#preparations.libraryCaseCount(context.workspaceId)
    if (catalog === undefined) {
      return { cases: { exams: [], prepared: 0, total }, catalog: null, gaps: [], profiles: [] }
    }
    const preparations = this.#preparations.latestForLibrary(context.workspaceId)
    const profiles = new Map<string, PathologyCoverage['profiles'][number]>()
    const gaps: PathologyCoverage['gaps'] = []
    for (const { asset, facts, installed, publishedRevisions } of catalog.assets.values()) {
      const state = {
        assetId: asset.assetId,
        blockers: [...new Set(pathologyAssetPublication(asset).reasons.map(reason => reason.code))],
        installed,
        published: publishedRevisions.length > 0,
      }
      const missing = pathologyFactNames.filter(name => facts[name] === undefined)
      if (missing.length > 0) {
        gaps.push({ ...state, missing })
        continue
      }
      // 素材不声明所属服务：规则中的每个服务都按素材的同一组事实派生画像。
      for (const service of catalog.rules.services) {
        const profile = pathologyProfile(service, facts)!
        const entry = profiles.get(profile.id)
        if (entry === undefined) profiles.set(profile.id, { ...profile, assets: [state], examCode: service.examCode })
        else entry.assets.push(state)
      }
    }
    return pathologyCoverageSchema.parse({
      cases: {
        exams: catalog.rules.services.map(({ examCode }) => {
          const exams = preparations.flatMap(preparation => preparation.exams.filter(exam => exam.examCode === examCode))
          const unsupported = new Map<PathologyPreparationReason, number>()
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
      gaps,
      profiles: [...profiles.values()].toSorted((left, right) => left.id.localeCompare(right.id)),
    })
  }

  /**
   * 医生侧的会诊开展情况：当前有就绪切片的会诊项目，以及该次本院就诊对应病例中各项会诊可送检的既往手术。
   * 送检手术只读取病例的可见来源病史，按服务的手术编码过滤并早于本次就诊，不依赖病例真值中的疾病、匹配结论
   * 或素材占用。清单不可用或无效时没有可开展的会诊，也没有可送检手术；清单问题只报告给管理员。
   */
  async offering(
    context: Pick<ActorContext, 'epoch' | 'workspaceId'>,
    visit: { encounterId: string } | { outpatientCaseId: string },
  ): Promise<{
    readyExamCodes: Set<PathologyExamCode>
    sourceProcedures: Map<PathologyExamCode, PathologySourceProcedure[]>
  }> {
    const sourceProcedures = new Map<PathologyExamCode, PathologySourceProcedure[]>()
    let rules: PathologyMatchingCatalog['rules'] | undefined
    let readyExamCodes = new Set<PathologyExamCode>()
    try {
      rules = (await this.#matchingCatalog())?.rules
      readyExamCodes = await this.#library.readyExamCodes()
    } catch (error) {
      if (!(error instanceof PathologyPreparationError) && !(error instanceof ImagingCatalogInvalidError)) throw error
      return { readyExamCodes: new Set(), sourceProcedures }
    }
    const caseId = this.#preparations.materializedCase(context.workspaceId, context.epoch, visit)
    const truth = caseId === undefined ? undefined : this.#cases.getTruthForSimulator(context.workspaceId, caseId)
    if (rules === undefined || caseId === undefined || truth === undefined) return { readyExamCodes, sourceProcedures }
    const historyResources = this.#cases.getVisibleResourcesForSimulator(context.workspaceId, caseId)
    const visitStart = indexVisitStart(truth.hiddenResources, truth.indexEncounterReference)
    for (const service of rules.services) {
      sourceProcedures.set(service.examCode, pathologySourceProcedures({
        codeSystem: rules.codeSystem,
        historyResources,
        service,
        visitStart,
      }))
    }
    return { readyExamCodes, sourceProcedures }
  }

  /** 定向生成可选的适配条目：五项事实齐全且有已发布、已安装素材的事实组合。只返回条目标识、名称与适用人群。 */
  async generationTargets(context: ActorContext) {
    this.#assertAdministrator(context)
    const catalog = await this.#matchingCatalog()
    return {
      items: catalog === undefined
        ? []
        : this.#publishedProfiles(catalog).map(({ profile, service }) => ({
            ageRange: service.generationAgeRange,
            kind: 'pathology-profile' as const,
            label: profile.label,
            minimumHistoryYears: service.generationHistoryYears,
            profileId: profile.id,
            sex: service.sex,
          })),
    }
  }

  /**
   * 由适配条目推导交给 Synthea 的保留条件，只用于提高命中率；患者是否满足条目仍由 `generationTargetMet` 判定。
   * 须做过任一可送检手术，且五项事实的 Observation 取值与条目一致；条目不存在或没有已发布且已安装素材时返回 undefined。
   */
  async generationKeep(target: ScenarioGenerationTarget): Promise<SyntheaKeepCriteria | undefined> {
    const catalog = await this.#matchingCatalog()
    const found = catalog === undefined
      ? undefined
      : this.#publishedProfiles(catalog).find(item => item.profile.id === target.profileId)
    if (catalog === undefined || found === undefined) return undefined
    return {
      activeAny: found.service.sourceProcedureCodes,
      activeNone: [],
      observations: pathologyFactNames.map((name) => {
        const rule = catalog.rules.facts[name]
        return { code: rule.code, valueAny: (rule.values as Record<string, string[]>)[found.profile.facts[name]]! }
      }),
    }
  }

  /** 定向生成导出的病史至少覆盖的年数；条目不存在或没有已发布且已安装素材时返回 undefined。 */
  async generationHistoryYears(target: ScenarioGenerationTarget): Promise<number | undefined> {
    const catalog = await this.#matchingCatalog()
    if (catalog === undefined) return undefined
    return this.#publishedProfiles(catalog).find(item => item.profile.id === target.profileId)?.service.generationHistoryYears
  }

  /** 新生成的患者按当前规则是否由目标条目配到切片；与病理准备使用同一匹配规则。 */
  async generationTargetMet(target: ScenarioGenerationTarget, candidate: {
    gender: string
    historyResources: SourceResource[]
    indexEncounterReference: string
    indexResources: SourceResource[]
    sourceHash: string
  }): Promise<boolean> {
    const catalog = await this.#matchingCatalog()
    if (catalog === undefined) return false
    return matchCasePathology({ ...candidate, bound: [], catalog })
      .some(exam => exam.status === 'ready' && exam.matchingProfileId === target.profileId)
  }

  #publishedProfiles(catalog: PathologyMatchingCatalog) {
    const profiles = new Map<string, {
      profile: NonNullable<ReturnType<typeof pathologyProfile>>
      service: PathologyMatchingCatalog['rules']['services'][number]
    }>()
    for (const { facts, installed, publishedRevisions } of catalog.assets.values()) {
      if (!installed || publishedRevisions.length === 0) continue
      for (const service of catalog.rules.services) {
        const profile = pathologyProfile(service, facts)
        if (profile !== undefined) profiles.set(profile.id, { profile, service })
      }
    }
    return [...profiles.values()].toSorted((left, right) => left.profile.id.localeCompare(right.profile.id))
  }

  /** 适配规则与每份素材的派生事实、安装和发布状态；清单目录或适配规则缺失时没有可用清单，内容无效时报告给管理员。 */
  async #matchingCatalog(): Promise<PathologyMatchingCatalog | undefined> {
    let catalog: Awaited<ReturnType<PathologyAssetLibrary['catalog']>>
    try {
      catalog = await this.#library.catalog()
    } catch (error) {
      if (!(error instanceof ImagingCatalogInvalidError)) throw error
      throw new PathologyPreparationError('PATHOLOGY_CATALOG_INVALID', error.message)
    }
    if (catalog?.matching === undefined) return undefined
    const assets: PathologyMatchingCatalog['assets'] = new Map(await Promise.all(catalog.assets.map(async asset => [asset.assetId, {
      asset,
      facts: pathologyAssetFacts(asset.clinical),
      installed: await this.#library.installed(asset),
      publishedRevisions: pathologyAssetPublication(asset).publishedRevisions.toSorted((left, right) => left - right),
    }] as const)))
    return {
      assets,
      hash: pathologyMatchingCatalogHash(catalog.matching, assets),
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
      throw new PathologyPreparationError('CASE_NOT_FOUND', 'The Synthetic Case was not found')
    }
    return { case: found, profile, truth }
  }

  #casePreparation(
    workspaceId: string,
    caseId: string,
    sourceHash: string,
  ): z.infer<typeof administratorPathologyPreparationSchema> {
    return {
      bindings: this.#preparations.bindings(workspaceId, caseId, sourceHash),
      caseId,
      preparation: this.#preparations.latest(workspaceId, caseId) ?? null,
      started: this.#preparations.started(workspaceId, caseId),
    }
  }

  #assertAdministrator(context: ActorContext): void {
    if (context.roleCode !== 'administrator') {
      throw new PathologyPreparationError('ROLE_NOT_ALLOWED', 'Only an administrator can manage pathology preparation')
    }
  }
}
