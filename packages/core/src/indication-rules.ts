import type { ClinicalFact, ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import type { ClinicalQualityAlert, ClinicalQualityCheck } from '@clinmesh/contracts/clinical-quality'
import type { ConceptVocabulary } from '@clinmesh/contracts/concept-vocabulary'
import type {
  DiseasePack,
  DiseasePackRuntimeEntry,
  EffectiveDiseasePack,
} from '@clinmesh/contracts/disease-pack'
import { resolveCanonicalItemCode } from './clinical-fact-ledger.ts'
import type { QualityEvidence } from './clinical-quality.ts'
import { resolveEffectiveConceptVocabulary } from './concept-vocabulary.ts'
import { evaluatePackTrigger, type TriggerEvaluationOptions } from './disease-pack.ts'

export type PackSourceSummary = NonNullable<ClinicalQualityCheck['sourcePacks']>[number]

export type OrderIndicationOrderKind =
  | 'examination'
  | 'imaging'
  | 'laboratory'
  | 'medication'
  | 'pathology'
  | 'procedure'

export type OrderIndicationStatus = 'indicated' | 'missing-inputs' | 'no-indication' | 'not-applicable'

export type IndicationRulePackInput =
  | DiseasePack
  | EffectiveDiseasePack
  | {
      active?: boolean | undefined
      effective?: EffectiveDiseasePack | undefined
      entry?: Pick<DiseasePackRuntimeEntry, 'activationReason' | 'activationStatus' | 'exited'> | undefined
      pack?: DiseasePack | undefined
      vocabulary?: ConceptVocabulary | undefined
    }

export interface EvaluateOrderIndicationInput {
  asOf?: string | undefined
  candidateCodes?: readonly string[] | undefined
  catalogItemId?: string | undefined
  encounterIdByRecordId?: Readonly<Record<string, string>> | undefined
  itemCode: string
  ledger: ClinicalFactLedger
  orderDisplay?: string | undefined
  orderKind: OrderIndicationOrderKind
  packs: readonly IndicationRulePackInput[]
  vocabulary?: ConceptVocabulary | undefined
}

export interface OrderIndicationEvaluationResult {
  alerts: ClinicalQualityAlert[]
  matchedRuleIds: string[]
  missingInputs: string[]
  missingMessageZh: string | null
  sourcePacks: PackSourceSummary[]
  status: OrderIndicationStatus
}

const DEFAULT_REQUIRED_ITEM_LABELS: Readonly<Record<string, string>> = {
  '10839-9': '心肌肌钙蛋白 I',
  '11524-6': '12 导联心电图',
  '2100404A': '心肌肌钙蛋白 I',
  '2100404B': '高敏心肌肌钙蛋白 I (hs-cTnI)',
  '2100504A': '心肌肌钙蛋白 T',
  '2160-0': '血清肌酐',
  '48065-7': 'D-二聚体',
  '6597-9': '心肌肌钙蛋白 T',
  '89579-7': '高敏心肌肌钙蛋白 I (hs-cTnI)',
  'ECG-12': '12 导联心电图',
  'examination-ecg-12-lead': '12 导联心电图',
}

interface NormalizedPackInput {
  active: boolean
  pack: DiseasePack
  vocabulary: ConceptVocabulary
}

function normalizePackInput(
  raw: IndicationRulePackInput,
  fallbackVocabulary?: ConceptVocabulary,
): NormalizedPackInput | null {
  if ('manifest' in raw) {
    const pack = raw
    return {
      active: pack.manifest.status !== 'retired',
      pack,
      vocabulary: fallbackVocabulary ?? resolveEffectiveConceptVocabulary(
        pack.conceptVocabulary === undefined ? {} : { packLayer: pack.conceptVocabulary },
      ),
    }
  }
  if ('pack' in raw && raw.pack !== undefined && 'effectiveAllowedTools' in raw) {
    const effective = raw as EffectiveDiseasePack
    return {
      active: effective.pack.manifest.status !== 'retired',
      pack: effective.pack,
      vocabulary: fallbackVocabulary ?? resolveEffectiveConceptVocabulary({
        ...(effective.hospitalOverlay?.conceptVocabulary === undefined ? {} : { hospitalLayer: effective.hospitalOverlay.conceptVocabulary }),
        ...(effective.pack.conceptVocabulary === undefined ? {} : { packLayer: effective.pack.conceptVocabulary }),
      }),
    }
  }
  const wrapper = raw as {
    active?: boolean | undefined
    effective?: EffectiveDiseasePack | undefined
    entry?: Pick<DiseasePackRuntimeEntry, 'activationReason' | 'activationStatus' | 'exited'> | undefined
    pack?: DiseasePack | undefined
    vocabulary?: ConceptVocabulary | undefined
  }
  const effective = wrapper.effective
  const pack = wrapper.pack ?? effective?.pack
  if (!pack) return null
  const isActive = wrapper.active !== undefined
    ? wrapper.active
    : wrapper.entry !== undefined
      ? wrapper.entry.activationStatus === 'active' && wrapper.entry.exited !== true && wrapper.entry.activationReason !== 'pack-exited'
      : pack.manifest.status !== 'retired'
  const vocabulary = wrapper.vocabulary ?? fallbackVocabulary ?? resolveEffectiveConceptVocabulary({
    ...(effective?.hospitalOverlay?.conceptVocabulary === undefined ? {} : { hospitalLayer: effective.hospitalOverlay.conceptVocabulary }),
    ...(pack.conceptVocabulary === undefined ? {} : { packLayer: pack.conceptVocabulary }),
  })
  return { active: isActive, pack, vocabulary }
}

function collectApprovedAliases(
  codes: readonly string[],
  vocabulary: ConceptVocabulary,
  asOfDate: string,
): Set<string> {
  const expanded = new Set<string>()
  const addCodeAndCanonical = (code: string) => {
    expanded.add(code)
    expanded.add(resolveCanonicalItemCode(code))
  }
  for (const code of codes) {
    addCodeAndCanonical(code)
  }
  for (const mapping of vocabulary.mappings) {
    if (mapping.reviewStatus !== 'approved' || mapping.relation !== 'exact') continue
    if (mapping.effectiveDate > asOfDate) continue
    if (expanded.has(mapping.sourceCode) || expanded.has(mapping.targetConceptCode)) {
      addCodeAndCanonical(mapping.sourceCode)
      addCodeAndCanonical(mapping.targetConceptCode)
    }
  }
  for (const node of vocabulary.nodes) {
    const related = [node.code, ...(node.synonyms ?? [])]
    if (related.some(code => expanded.has(code) || expanded.has(resolveCanonicalItemCode(code)))) {
      for (const code of related) addCodeAndCanonical(code)
    }
  }
  return expanded
}

function resolveRequiredItemLabel(rawEntry: string, vocabulary: ConceptVocabulary): string {
  const primary = rawEntry.split('|')[0]!.trim()
  const node = vocabulary.nodes.find(n => n.code === primary || (n.synonyms ?? []).includes(primary))
  if (node) return node.displayZh
  return DEFAULT_REQUIRED_ITEM_LABELS[primary] ?? DEFAULT_REQUIRED_ITEM_LABELS[resolveCanonicalItemCode(primary)] ?? primary
}

function findMatchingCompletedFacts(
  reqEntry: string,
  facts: readonly ClinicalFact[],
  vocabulary: ConceptVocabulary,
  asOfDate: string,
): ClinicalFact[] {
  const tokens = reqEntry.split('|').map(t => t.trim()).filter(Boolean)
  const acceptedCodes = collectApprovedAliases(tokens, vocabulary, asOfDate)
  return facts.filter(fact => {
    if (!fact.eligibleForScoringAndRedLine) return false
    if (fact.provenance.recordType === 'ServiceRequest') return false
    if (fact.presence === 'not-asked') return false
    const factCodes = collectApprovedAliases([fact.itemCode.code], vocabulary, asOfDate)
    return [...factCodes].some(code => acceptedCodes.has(code))
  })
}

function toEvidenceList(facts: readonly ClinicalFact[]): QualityEvidence[] {
  const seen = new Set<string>()
  const result: QualityEvidence[] = []
  for (const fact of facts) {
    const reference = `${fact.provenance.recordType}/${fact.provenance.recordId}`
    if (seen.has(reference)) continue
    seen.add(reference)
    result.push({
      label: `${fact.itemCode.display}：${fact.value.rawText}`.slice(0, 240),
      reference,
      versionId: fact.provenance.recordVersion,
    })
    if (result.length >= 8) break
  }
  return result
}

/**
 * Pure order-save indication evaluator across active DiseasePacks.
 * Strictly consumes ClinicalFactLedger, DiseasePack indicationRules, and ConceptVocabulary;
 * must never inspect DRG grouping, headroom, or reimbursement data.
 */
export function evaluateOrderIndicationRules(
  input: EvaluateOrderIndicationInput,
): OrderIndicationEvaluationResult {
  const effectiveAsOf = input.asOf ?? input.ledger.trace.evaluatedAsOf
  const asOfDate = effectiveAsOf.slice(0, 10)
  const itemCodesToMatch = [...new Set([input.itemCode, ...(input.candidateCodes ?? [])].filter(Boolean))]

  const matchedRuleIds: string[] = []
  const sourcePacksById = new Map<string, PackSourceSummary>()
  const missingInputs: string[] = []
  const noIndicationAlerts: ClinicalQualityAlert[] = []
  let anyIndicated = false
  let anyMissingInputs = false

  for (const rawPack of input.packs) {
    const normalized = normalizePackInput(rawPack, input.vocabulary)
    if (!normalized || !normalized.active) continue
    const { pack, vocabulary } = normalized
    const rules = pack.indicationRules ?? []
    if (rules.length === 0) continue

    const evalOptions: TriggerEvaluationOptions = {
      asOf: effectiveAsOf,
      ...(input.encounterIdByRecordId ? { encounterIdByRecordId: input.encounterIdByRecordId } : {}),
      vocabulary,
    }

    for (const rule of rules) {
      if (rule.orderKind !== input.orderKind) continue
      const pattern = new RegExp(rule.itemCodePattern)
      if (!itemCodesToMatch.some(code => pattern.test(code))) continue

      matchedRuleIds.push(rule.id)
      sourcePacksById.set(pack.manifest.id, {
        packId: pack.manifest.id,
        packVersion: pack.manifest.version,
        titleZh: pack.manifest.titleZh,
      })

      const requiredFacts: ClinicalFact[] = []
      let ruleMissing = false
      for (const reqEntry of rule.requiredItemCodes ?? []) {
        const matched = findMatchingCompletedFacts(reqEntry, input.ledger.facts, vocabulary, asOfDate)
        if (matched.length === 0) {
          ruleMissing = true
          missingInputs.push(resolveRequiredItemLabel(reqEntry, vocabulary))
        } else {
          requiredFacts.push(...matched)
        }
      }

      if (ruleMissing) {
        anyMissingInputs = true
        continue
      }

      const conditionResult = evaluatePackTrigger(rule.condition, input.ledger, evalOptions)
      if (conditionResult.matched) {
        anyIndicated = true
        continue
      }

      const display = input.orderDisplay ?? input.itemCode
      const conditionFacts = requiredFacts.length > 0
        ? requiredFacts
        : input.ledger.facts.filter(f => f.eligibleForScoringAndRedLine && f.provenance.recordType !== 'ServiceRequest').slice(0, 4)

      const evidence = toEvidenceList(conditionFacts)
      noIndicationAlerts.push({
        basis: {
          foundZh: evidence.length === 0 ? '未查到相关结果' : evidence.map(item => item.label).join('；').slice(0, 500),
          judgementZh: `${display}暂无明确临床适应症，如仍需开立请填写理由`,
          needZh: rule.rationaleZh,
        },
        ...(input.catalogItemId === undefined ? {} : { catalogItemId: input.catalogItemId }),
        code: 'INVESTIGATION_WITHOUT_INDICATION',
        evidence,
        message: `${display}缺乏明确临床适应症：${rule.rationaleZh}`,
        ruleId: rule.id,
        tier: 'alert',
      })
    }
  }

  const uniqueMissing = [...new Set(missingInputs)]
  const sourcePacks = [...sourcePacksById.values()]

  if (matchedRuleIds.length === 0) {
    return {
      alerts: [],
      matchedRuleIds: [],
      missingInputs: [],
      missingMessageZh: null,
      sourcePacks: [],
      status: 'not-applicable',
    }
  }

  if (anyIndicated) {
    return {
      alerts: [],
      matchedRuleIds,
      missingInputs: [],
      missingMessageZh: null,
      sourcePacks,
      status: 'indicated',
    }
  }

  if (anyMissingInputs) {
    return {
      alerts: [],
      matchedRuleIds,
      missingInputs: uniqueMissing,
      missingMessageZh: `缺项待补：需先完成${uniqueMissing.join('、')}正式评估后再核对适应症`,
      sourcePacks,
      status: 'missing-inputs',
    }
  }

  return {
    alerts: noIndicationAlerts,
    matchedRuleIds,
    missingInputs: [],
    missingMessageZh: null,
    sourcePacks,
    status: 'no-indication',
  }
}
