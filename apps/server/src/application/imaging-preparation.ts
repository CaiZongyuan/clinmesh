import { createHash } from 'node:crypto'
import type {
  ImagingExamCode,
  ImagingExamPreparation,
  ImagingPreparationReason,
} from '@clinmesh/contracts/imaging'
import { z } from 'zod'
import type {
  ImagingCatalogAsset,
  ImagingMatchingRules,
} from '../infrastructure/imaging-assets/imaging-catalog.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

export const imagingExamCodes: ImagingExamCode[] = ['chest-ct-plain', 'chest-radiograph']

type MatchingProfile = ImagingMatchingRules['profiles'][number]
type Fact = ImagingExamPreparation['evidence']['facts'][number]

/** 清单中可用于病例匹配的内容：适配规则，以及规则引用的素材各自已发布的报告修订。 */
export interface ImagingMatchingCatalog {
  assets: Map<string, { asset: ImagingCatalogAsset; publishedRevisions: number[] }>
  hash: string
  packId: string
  rules: ImagingMatchingRules
}

export interface SourceResource {
  resource: unknown
  sourceReference: string
}

/** 病例开始后已经固定的绑定；匹配只能沿用它们，不能替换。 */
export interface BoundExam {
  assetId: string
  examCode: ImagingExamCode
  matchingProfileId: string
  reportRevision: number
}

const codingSchema = z.object({
  code: z.string().min(1),
  display: z.string().min(1).optional(),
  system: z.string().min(1),
}).passthrough()
const codeableConceptSchema = z.object({ coding: z.array(codingSchema).default([]) }).passthrough()
const sourceResourceSchema = z.object({
  abatementDateTime: z.string().optional(),
  code: codeableConceptSchema.optional(),
  period: z.object({ start: z.string().min(10) }).passthrough().optional(),
  procedureCode: z.array(codeableConceptSchema).optional(),
  resourceType: z.string().min(1),
}).passthrough()

interface CodedResource {
  abated: boolean
  code: string
  display?: string
  resourceType: string
  scope: 'history' | 'index'
  sourceReference: string
}

/**
 * `visitStart` 是本次就诊的开始时间。来源在导出时已经写下之后的病程，疾病是否“已缓解”按就诊当时判断：
 * 就诊之后才缓解的疾病（包括本次就诊诊断的急性病）在就诊时仍是现症。
 */
function codedResources(
  resources: SourceResource[],
  scope: CodedResource['scope'],
  codeSystem: string,
  visitStart: string | undefined,
): CodedResource[] {
  return resources.flatMap(({ resource, sourceReference }) => {
    const parsed = sourceResourceSchema.safeParse(resource)
    if (!parsed.success) return []
    const abatement = parsed.data.abatementDateTime
    const abated = abatement !== undefined
      && (visitStart === undefined || Date.parse(abatement) <= Date.parse(visitStart))
    // R4 ImagingStudy 把检查编码放在 procedureCode，Condition 与 Procedure 放在 code。
    const concepts = parsed.data.resourceType === 'ImagingStudy'
      ? parsed.data.procedureCode ?? []
      : parsed.data.code === undefined ? [] : [parsed.data.code]
    return concepts.flatMap(concept => concept.coding)
      .filter(coding => coding.system === codeSystem)
      .map(coding => ({
        abated,
        code: coding.code,
        ...(coding.display === undefined ? {} : { display: coding.display }),
        resourceType: parsed.data.resourceType,
        scope,
        sourceReference,
      }))
  })
}

function evidence({ code, display, scope, sourceReference }: CodedResource): Fact {
  return { code, ...(display === undefined ? {} : { display }), scope, sourceReference }
}

/** 本次就诊开始当天的周岁。 */
function ageYears(birthDate: string, indexDate: string): number {
  const years = Number(indexDate.slice(0, 4)) - Number(birthDate.slice(0, 4))
  return indexDate.slice(5, 10) < birthDate.slice(5, 10) ? years - 1 : years
}

/**
 * 依据来源编码为一个病例的每项检查确定素材。
 *
 * 一个病例只使用一个适配条目，胸片与 CT 因此来自同一来源受试者。未缓解的来源疾病命中“未覆盖”清单时不配片；
 * 命中阳性条目的疾病决定影像表现，只有不存在这类疾病时才考虑阴性条目，且阴性条目要求本次就诊的疾病在明确
 * 列出的范围内。来源没有依据的病例不会被当作正常。
 */
export function matchCaseImaging(input: {
  birthDate: string
  bound: BoundExam[]
  catalog: ImagingMatchingCatalog
  gender: string
  historyResources: SourceResource[]
  indexEncounterReference: string
  indexResources: SourceResource[]
  sourceHash: string
}): ImagingExamPreparation[] {
  const { rules } = input.catalog
  const visitStart = sourceResourceSchema.safeParse(input.indexResources
    .find(item => item.sourceReference === input.indexEncounterReference)?.resource).data?.period?.start
  const index = codedResources(input.indexResources, 'index', rules.codeSystem, visitStart)
  const all = [...index, ...codedResources(input.historyResources, 'history', rules.codeSystem, visitStart)]
  const activeConditions = all.filter(item => item.resourceType === 'Condition' && !item.abated)
  const sourceExams = (examCode: ImagingExamCode) => index
    .filter(item => (item.resourceType === 'Procedure' || item.resourceType === 'ImagingStudy')
      && rules.sourceExamCodes[examCode]?.includes(item.code) === true)
    .map(({ code, display, sourceReference }) => ({
      code,
      ...(display === undefined ? {} : { display }),
      sourceReference,
    }))

  let facts: Fact[] = []
  let failure: { reason: ImagingPreparationReason; status: 'conflict' | 'unsupported' } | undefined
  let profile: MatchingProfile | undefined
  const uncoveredCodes = new Set(rules.uncoveredConditions.flatMap(condition => condition.codes))
  const uncovered = activeConditions.filter(item => uncoveredCodes.has(item.code))
  const positiveCodes = new Set(rules.profiles.flatMap(item => item.finding === 'positive' ? item.conditionCodes : []))
  const positive = activeConditions.filter(item => positiveCodes.has(item.code))
  if (uncovered.length > 0) {
    facts = uncovered.map(evidence)
    failure = { reason: 'UNCOVERED_CONDITION', status: 'unsupported' }
  } else {
    let candidates: MatchingProfile[]
    if (positive.length > 0) {
      candidates = rules.profiles.filter(item => item.finding === 'positive'
        && positive.some(condition => item.conditionCodes.includes(condition.code)))
      facts = positive.map(evidence)
      const conflictCodes = new Set(candidates.flatMap(item => item.finding === 'positive' ? item.conflictProcedureCodes : []))
      const conflicts = all.filter(item => item.resourceType === 'Procedure' && conflictCodes.has(item.code))
      if (conflicts.length > 0) {
        facts = [...facts, ...conflicts.map(evidence)]
        failure = { reason: 'FIXED_FACT_CONFLICT', status: 'conflict' }
      }
    } else {
      const indexConditions = index.filter(item => item.resourceType === 'Condition' && !item.abated)
      const matches = (item: MatchingProfile) => item.finding === 'negative'
        && indexConditions.some(condition => item.indexConditionCodes.includes(condition.code))
      candidates = rules.profiles.filter(matches)
      const matchedCodes = new Set(candidates.flatMap(item => item.finding === 'negative' ? item.indexConditionCodes : []))
      facts = indexConditions.filter(condition => matchedCodes.has(condition.code)).map(evidence)
    }
    if (failure === undefined && candidates.length === 0) {
      failure = { reason: 'NO_APPLICABLE_RULE', status: 'unsupported' }
    } else if (failure === undefined) {
      const age = visitStart === undefined ? undefined : ageYears(input.birthDate, visitStart)
      const eligible = candidates.filter(item => age !== undefined
        && age >= item.ageRange[0] && age <= item.ageRange[1]
        && (item.sex === undefined || item.sex === input.gender))
      // 多个条目同样适用时按病例来源身份稳定取一个，同一病例每次得到相同选择。
      profile = eligible.toSorted((left, right) => (
        createHash('sha256').update(`${input.sourceHash}:${left.id}`).digest('hex')
          .localeCompare(createHash('sha256').update(`${input.sourceHash}:${right.id}`).digest('hex'))
      ))[0]
      if (profile === undefined) failure = { reason: 'NO_ASSET_FOR_DEMOGRAPHICS', status: 'unsupported' }
    }
  }
  // 已有固定绑定的病例只能在同一条目内追加，保证后追加的检查与已绑定的检查相互一致。
  const boundProfileId = input.bound[0]?.matchingProfileId
  if (boundProfileId !== undefined) profile = rules.profiles.find(item => item.id === boundProfileId)

  return imagingExamCodes.map((examCode) => {
    const base = { evidence: { facts, sourceExams: sourceExams(examCode) }, examCode }
    const bound = input.bound.find(item => item.examCode === examCode)
    if (bound !== undefined) {
      return {
        ...base,
        assetId: bound.assetId,
        matchingProfileId: bound.matchingProfileId,
        reportRevision: bound.reportRevision,
        status: 'ready' as const,
      }
    }
    // 没有选中条目时必有失败原因；已绑定病例的条目若已从规则中移除，未绑定的检查不再有规则可用。
    if (profile === undefined) {
      return { ...base, ...(failure ?? { reason: 'NO_APPLICABLE_RULE' as const, status: 'unsupported' as const }) }
    }
    const assetId = profile.assets[examCode]
    const reportRevision = assetId === undefined
      ? undefined
      : input.catalog.assets.get(assetId)?.publishedRevisions.at(-1)
    if (assetId === undefined || reportRevision === undefined) {
      return {
        ...base,
        matchingProfileId: profile.id,
        reason: assetId === undefined ? 'PROFILE_LACKS_EXAM' as const : 'ASSET_NOT_PUBLISHED' as const,
        status: 'unsupported' as const,
      }
    }
    return { ...base, assetId, matchingProfileId: profile.id, reportRevision, status: 'ready' as const }
  })
}

/** 规则与其引用素材的身份；任何一项变化都意味着既有准备结果需要重新评估。 */
export function imagingMatchingCatalogHash(
  rules: ImagingMatchingRules,
  assets: ImagingMatchingCatalog['assets'],
): string {
  return canonicalJsonHash({
    assets: [...assets.entries()].map(([assetId, { asset, publishedRevisions }]) => ({
      assetId,
      output: asset.output,
      publishedRevisions,
    })),
    rules,
  })
}
