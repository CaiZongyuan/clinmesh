import { createHash } from 'node:crypto'
import type {
  PathologyExamCode,
  PathologyExamPreparation,
  PathologyPreparationReason,
  PathologySourceProcedure,
} from '@clinmesh/contracts/pathology'
import { z } from 'zod'
import type { PathologyCatalogAsset, PathologyMatchingRules } from '../infrastructure/imaging-assets/pathology-catalog.ts'
import {
  pathologyFactNames,
  pathologyProfile,
  type PathologyFacts,
} from '../infrastructure/imaging-assets/pathology-matching.ts'
import { pathologyClinicalStatus, pathologyReportContentSha256 } from '../infrastructure/imaging-assets/pathology-report-check.ts'
import type { SourceResource } from './imaging-preparation.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

type ServiceRule = PathologyMatchingRules['services'][number]
type Evidence = PathologyExamPreparation['evidence']

/** 清单中可用于病例匹配的内容：适配规则，以及每份素材派生的事实、安装状态和已发布的报告修订。 */
export interface PathologyMatchingCatalog {
  assets: Map<string, { asset: PathologyCatalogAsset; facts: PathologyFacts; installed: boolean; publishedRevisions: number[] }>
  hash: string
  packId: string
  rules: PathologyMatchingRules
}

/** 病例开始后已经固定的绑定；匹配只能沿用它们，不能替换。 */
export interface BoundSlide {
  assetId: string
  examCode: PathologyExamCode
  matchingProfileId: string
  reportRevision: number
  sourceProcedureReference: string
}

const codeableConceptSchema = z.object({
  coding: z.array(z.object({
    code: z.string().min(1),
    display: z.string().min(1).optional(),
    system: z.string().min(1),
  }).passthrough()).default([]),
}).passthrough()
const sourceResourceSchema = z.object({
  code: codeableConceptSchema.optional(),
  effectiveDateTime: z.string().min(10).optional(),
  performedDateTime: z.string().min(10).optional(),
  performedPeriod: z.object({ start: z.string().min(10) }).passthrough().optional(),
  period: z.object({ start: z.string().min(10) }).passthrough().optional(),
  resourceType: z.string().min(1),
  valueCodeableConcept: codeableConceptSchema.optional(),
}).passthrough()

/** 一个服务可送检的来源手术：既往来源病史中编码相容、早于本次就诊的手术，按手术时间排序。 */
export function pathologySourceProcedures(input: {
  codeSystem: string
  historyResources: SourceResource[]
  service: ServiceRule
  visitStart: string | undefined
}): PathologySourceProcedure[] {
  return input.historyResources.flatMap(({ resource, sourceReference }) => {
    const parsed = sourceResourceSchema.safeParse(resource)
    if (!parsed.success || parsed.data.resourceType !== 'Procedure') return []
    const coding = parsed.data.code?.coding.find(item => item.system === input.codeSystem
      && input.service.sourceProcedureCodes.includes(item.code))
    const performedAt = parsed.data.performedPeriod?.start ?? parsed.data.performedDateTime
    if (coding === undefined || performedAt === undefined) return []
    if (input.visitStart !== undefined && Date.parse(performedAt) >= Date.parse(input.visitStart)) return []
    return [{
      code: coding.code,
      ...(coding.display === undefined ? {} : { display: coding.display }),
      performedAt,
      sourceReference,
    }]
  }).toSorted((left, right) => Date.parse(left.performedAt) - Date.parse(right.performedAt)
    || left.sourceReference.localeCompare(right.sourceReference))
}

/** 本次就诊的开始时间；来源手术须早于它。 */
export function indexVisitStart(indexResources: SourceResource[], indexEncounterReference: string): string | undefined {
  return sourceResourceSchema.safeParse(indexResources
    .find(item => item.sourceReference === indexEncounterReference)?.resource).data?.period?.start
}

/**
 * 依据既往来源病史为一个病例的每项病理会诊确定切片素材。
 *
 * 病例须符合服务的性别、带有适用诊断并有可送检的来源手术。来源 Observation 给出的受体、淋巴结与 T 类别是固定事实，
 * 取每项最新的一次结果；素材的派生事实与之逐项比较：全部一致的素材可用，任一项矛盾的素材冲突，一方缺少某项而其余
 * 不矛盾时无法确认。有可用素材时就绪；否则只要存在无法确认的素材就记为未覆盖，全部素材都矛盾时记为冲突。
 * 匹配只读取既往来源病史，不读取本次病例真值。
 */
export function matchCasePathology(input: {
  bound: BoundSlide[]
  catalog: PathologyMatchingCatalog
  gender: string
  historyResources: SourceResource[]
  indexEncounterReference: string
  indexResources: SourceResource[]
  sourceHash: string
}): PathologyExamPreparation[] {
  const { rules } = input.catalog
  const visitStart = indexVisitStart(input.indexResources, input.indexEncounterReference)
  const history = input.historyResources.flatMap(({ resource, sourceReference }) => {
    const parsed = sourceResourceSchema.safeParse(resource)
    return parsed.success ? [{ resource: parsed.data, sourceReference }] : []
  })

  const facts: PathologyFacts = {}
  const factEvidence: Evidence['facts'] = []
  for (const name of pathologyFactNames) {
    const rule = rules.facts[name]
    const latest = history
      .filter(item => item.resource.resourceType === 'Observation'
        && item.resource.code?.coding.some(coding => coding.system === rules.observationSystem && coding.code === rule.code) === true)
      .toSorted((left, right) => Date.parse(right.resource.effectiveDateTime ?? '') - Date.parse(left.resource.effectiveDateTime ?? ''))[0]
    const valueCoding = latest?.resource.valueCodeableConcept?.coding.find(coding => coding.system === rules.codeSystem)
    const value = valueCoding === undefined
      ? undefined
      : Object.entries(rule.values).find(([, codes]) => codes.includes(valueCoding.code))?.[0] as PathologyFacts[typeof name]
    if (latest === undefined || valueCoding === undefined || value === undefined) continue
    facts[name] = value
    const display = latest.resource.code?.coding.find(coding => coding.code === rule.code)?.display
    factEvidence.push({
      code: rule.code,
      ...(display === undefined ? {} : { display }),
      fact: name,
      sourceReference: latest.sourceReference,
      value,
      valueCode: valueCoding.code,
    })
  }

  return rules.services.map((service) => {
    const conditions = history.flatMap(({ resource, sourceReference }) => {
      if (resource.resourceType !== 'Condition') return []
      const coding = resource.code?.coding.find(item => item.system === rules.codeSystem && service.conditionCodes.includes(item.code))
      return coding === undefined
        ? []
        : [{ code: coding.code, ...(coding.display === undefined ? {} : { display: coding.display }), sourceReference }]
    })
    const applicable = input.gender === service.sex && conditions.length > 0
    const procedures = applicable
      ? pathologySourceProcedures({ codeSystem: rules.codeSystem, historyResources: input.historyResources, service, visitStart })
      : []
    const evidence = { conditions, facts: applicable ? factEvidence : [] }

    let failure: { reason: PathologyPreparationReason; status: 'conflict' | 'unsupported' } | undefined
    let compatible: string[] = []
    if (!applicable) failure = { reason: 'NO_APPLICABLE_RULE', status: 'unsupported' }
    else if (procedures.length === 0) failure = { reason: 'NO_SOURCE_PROCEDURE', status: 'unsupported' }
    else {
      const published = [...input.catalog.assets.entries()].filter(([, entry]) => entry.publishedRevisions.length > 0)
      const relation = (assetFacts: PathologyFacts) => pathologyFactNames
        .some(name => facts[name] !== undefined && assetFacts[name] !== undefined && facts[name] !== assetFacts[name])
        ? 'conflict'
        : pathologyFactNames.some(name => facts[name] === undefined || assetFacts[name] === undefined) ? 'unknown' : 'compatible'
      const relations = published.map(([assetId, entry]) => ({ assetId, installed: entry.installed, relation: relation(entry.facts) }))
      compatible = relations.filter(item => item.installed && item.relation === 'compatible').map(item => item.assetId)
      if (published.length === 0) failure = { reason: 'ASSET_NOT_PUBLISHED', status: 'unsupported' }
      else if (compatible.length > 0) failure = undefined
      else if (relations.some(item => item.relation === 'compatible')) failure = { reason: 'ASSET_NOT_INSTALLED', status: 'unsupported' }
      else if (relations.some(item => item.relation === 'unknown')) failure = { reason: 'FACT_UNKNOWN', status: 'unsupported' }
      else failure = { reason: 'FIXED_FACT_CONFLICT', status: 'conflict' }
    }
    const profileId = pathologyProfile(service, facts)?.id

    // 已有固定绑定的来源手术沿用绑定；其余手术只在当前规则判为就绪时取得素材。
    const sourceProcedures = procedures.map((procedure) => {
      const bound = input.bound.find(item => item.examCode === service.examCode
        && item.sourceProcedureReference === procedure.sourceReference)
      // 多份素材同样可用时按病例来源身份与来源手术稳定取一份，同一病例每次得到相同选择。
      const assetId = bound?.assetId ?? compatible.toSorted((left, right) => (
        createHash('sha256').update(`${input.sourceHash}:${procedure.sourceReference}:${left}`).digest('hex')
          .localeCompare(createHash('sha256').update(`${input.sourceHash}:${procedure.sourceReference}:${right}`).digest('hex'))
      ))[0]
      const entry = assetId === undefined ? undefined : input.catalog.assets.get(assetId)
      const reportRevision = bound?.reportRevision ?? entry?.publishedRevisions.at(-1)
      const histologicType = entry === undefined ? undefined : pathologyClinicalStatus(entry.asset.clinical).histologicType
      return {
        ...procedure,
        ...(assetId === undefined || reportRevision === undefined ? {} : { assetId, reportRevision }),
        supplements: histologicType === undefined ? [] : [{ fact: 'histologic-type' as const, value: histologicType }],
      }
    })
    const boundProfileId = input.bound.find(item => item.examCode === service.examCode)?.matchingProfileId
    if (sourceProcedures.some(procedure => procedure.assetId !== undefined)) {
      return {
        evidence,
        examCode: service.examCode,
        matchingProfileId: boundProfileId ?? profileId!,
        sourceProcedures,
        status: 'ready' as const,
      }
    }
    return {
      evidence,
      examCode: service.examCode,
      ...(profileId === undefined ? {} : { matchingProfileId: profileId }),
      sourceProcedures,
      ...(failure ?? { reason: 'NO_APPLICABLE_RULE' as const, status: 'unsupported' as const }),
    }
  })
}

/** 规则与每份素材的事实、层级、安装、发布状态和已发布报告签署内容的身份；任何一项变化都意味着既有准备结果需要重新评估。 */
export function pathologyMatchingCatalogHash(
  rules: PathologyMatchingRules,
  assets: PathologyMatchingCatalog['assets'],
): string {
  return canonicalJsonHash({
    assets: [...assets.entries()].map(([assetId, { asset, facts, installed, publishedRevisions }]) => ({
      assetId,
      facts,
      histologicType: asset.clinical.histologicType,
      installed,
      output: asset.output,
      // 同一修订号改动后重新签署时，绑定记录的报告内容哈希随之失效。
      publishedReports: (asset.reports ?? [])
        .filter(report => publishedRevisions.includes(report.revision))
        .map(report => pathologyReportContentSha256(asset, report)),
      publishedRevisions,
    })),
    rules,
  })
}
