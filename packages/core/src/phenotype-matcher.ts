import type { ClinicalFact, ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import {
  clinicalPromptCardSchema,
  type ClinicalPromptCard,
  type ClinicalPromptFactVersionRef,
  type ClinicalPromptTiming,
} from '@clinmesh/contracts/clinical-prompt-cards'
import type { ConceptVocabulary } from '@clinmesh/contracts/concept-vocabulary'
import {
  phenotypeMatchResultSchema,
  type PhenotypeAgeThresholdBySex,
  type PhenotypeCandidateMatch,
  type PhenotypeCandidateTermMatch,
  type PhenotypeExcludedFactSummary,
  type PhenotypeFactEvidence,
  type PhenotypeFactMatcher,
  type PhenotypeKnowledgeBase,
  type PhenotypeMatchResult,
  type PhenotypeObservationRule,
  type PhenotypeTermMatch,
  type PhenotypeTimelineEntry,
} from '@clinmesh/contracts/phenotype-matcher'
import { resolveCanonicalItemCode } from './clinical-fact-ledger.ts'
import {
  PUBLIC_CONCEPT_VOCABULARY,
  evaluateConceptMappingEligibility,
  getConceptAncestors,
} from './concept-vocabulary.ts'

export { SYNTHETIC_PHENOTYPE_KB } from './phenotype-synthetic-kb.ts'

const MS_PER_DAY = 86_400_000

export interface MatchPhenotypeCandidatesInput {
  readonly asOf?: string | undefined
  readonly encounterIdByFactId?: Readonly<Record<string, string>> | undefined
  readonly encounterIdByRecordId?: Readonly<Record<string, string>> | undefined
  readonly encounterLabelByFactId?: Readonly<Record<string, string>> | undefined
  readonly encounterLabelByRecordId?: Readonly<Record<string, string>> | undefined
  readonly knowledgeBase: PhenotypeKnowledgeBase
  readonly ledger: ClinicalFactLedger
  readonly patientBirthDate?: string | undefined
  readonly patientSex?: 'male' | 'female' | 'other' | 'unknown' | undefined
  readonly timing?: ClinicalPromptTiming | undefined
  readonly vocabulary?: ConceptVocabulary | undefined
}

interface ResolvedFactContext {
  readonly ageAtFactYears: number | null
  readonly encounterKey: string
  readonly encounterLabel: string
  readonly fact: ClinicalFact
  readonly numericValue: number | null
  readonly numericUnit: string | null
  readonly observedAt: string
  readonly observedMs: number
  readonly resolvedConceptCodes: ReadonlySet<string>
}

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

function completedYearsBetween(birthDate: string | undefined, referenceIso: string): number | null {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return null
  const [by, bm, bd] = birthDate.split('-').map(Number)
  const refDate = referenceIso.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(refDate)) return null
  const [ry, rm, rd] = refDate.split('-').map(Number)
  if (
    by === undefined || bm === undefined || bd === undefined
    || ry === undefined || rm === undefined || rd === undefined
  ) {
    return null
  }
  let age = ry - by
  if (rm < bm || (rm === bm && rd < bd)) age -= 1
  return age >= 0 && age <= 130 ? age : null
}

function extractFactNumeric(fact: ClinicalFact): { value: number | null; unit: string | null } {
  const norm = fact.value.normalizedValue
  if (typeof norm === 'number' && Number.isFinite(norm)) {
    return { unit: null, value: norm }
  }
  if (norm !== null && typeof norm === 'object' && 'value' in norm && typeof norm.value === 'number' && Number.isFinite(norm.value)) {
    return { unit: typeof norm.unit === 'string' ? norm.unit : null, value: norm.value }
  }
  return { unit: null, value: null }
}

function resolveFactConceptCodes(
  factCode: string,
  vocabulary: ConceptVocabulary,
  asOfDate: string,
): Set<string> {
  const codes = new Set<string>([factCode])
  const knownNodeCodes = new Set(vocabulary.nodes.map(node => node.code))
  const explicitMappings = vocabulary.mappings.filter(mapping => mapping.sourceCode === factCode)

  if (!knownNodeCodes.has(factCode) && explicitMappings.length === 0) {
    codes.add(resolveCanonicalItemCode(factCode))
  }

  for (const seed of Array.from(codes)) {
    if (knownNodeCodes.has(seed)) {
      for (const ancestor of getConceptAncestors(seed, vocabulary)) {
        codes.add(ancestor)
      }
    }
  }

  for (const mapping of vocabulary.mappings) {
    if (!codes.has(mapping.sourceCode)) continue
    const eligibility = evaluateConceptMappingEligibility(mapping, { asOfDate })
    if (!eligibility.eligibleForScoreAndRedLine) continue
    codes.add(mapping.targetConceptCode)
    for (const ancestor of getConceptAncestors(mapping.targetConceptCode, vocabulary)) {
      codes.add(ancestor)
    }
  }

  return codes
}

function resolveEncounterKey(
  fact: ClinicalFact,
  observedAt: string,
  observedMs: number,
  input: Pick<MatchPhenotypeCandidatesInput, 'encounterIdByFactId' | 'encounterIdByRecordId'>,
): string {
  const byFact = input.encounterIdByFactId && Object.hasOwn(input.encounterIdByFactId, fact.factId)
    ? input.encounterIdByFactId[fact.factId]
    : undefined
  if (byFact) return `enc:${byFact}`
  const byRecord = input.encounterIdByRecordId && Object.hasOwn(input.encounterIdByRecordId, fact.provenance.recordId)
    ? input.encounterIdByRecordId[fact.provenance.recordId]
    : undefined
  if (byRecord) return `enc:${byRecord}`
  const dayBucket = Number.isFinite(observedMs)
    ? new Date(observedMs + 8 * 3_600_000).toISOString().slice(0, 10)
    : observedAt.slice(0, 10)
  return `${fact.provenance.sourceSystemId}::${dayBucket}`
}

function resolveEncounterLabel(
  fact: ClinicalFact,
  observedAt: string,
  observedMs: number,
  input: Pick<MatchPhenotypeCandidatesInput, 'encounterIdByFactId' | 'encounterIdByRecordId' | 'encounterLabelByFactId' | 'encounterLabelByRecordId'>,
): string {
  const labelByFact = input.encounterLabelByFactId && Object.hasOwn(input.encounterLabelByFactId, fact.factId)
    ? input.encounterLabelByFactId[fact.factId]
    : undefined
  if (labelByFact) return labelByFact
  const labelByRecord = input.encounterLabelByRecordId && Object.hasOwn(input.encounterLabelByRecordId, fact.provenance.recordId)
    ? input.encounterLabelByRecordId[fact.provenance.recordId]
    : undefined
  if (labelByRecord) return labelByRecord

  const dayStr = Number.isFinite(observedMs)
    ? new Date(observedMs + 8 * 3_600_000).toISOString().slice(0, 10)
    : observedAt.slice(0, 10)
  const encId =
    (input.encounterIdByFactId && Object.hasOwn(input.encounterIdByFactId, fact.factId)
      ? input.encounterIdByFactId[fact.factId]
      : undefined)
    ?? (input.encounterIdByRecordId && Object.hasOwn(input.encounterIdByRecordId, fact.provenance.recordId)
      ? input.encounterIdByRecordId[fact.provenance.recordId]
      : undefined)
  if (encId) return `${dayStr} (${encId})`
  return fact.institutionScope === 'external'
    ? `${dayStr} (外院历史记录)`
    : `${dayStr} (本院就诊记录)`
}

function partitionLedgerFacts(
  ledger: ClinicalFactLedger,
  asOfMs: number | null,
): { eligibleFacts: ClinicalFact[]; excludedSummary: PhenotypeExcludedFactSummary } {
  const eligibleFacts: ClinicalFact[] = []
  let conflictCount = 0
  let externalUnverifiedCount = 0
  let notAskedOrErrorCount = 0
  let supersededCount = 0
  let suspiciousCount = 0

  for (const fact of ledger.facts) {
    if (fact.relation.supersededByFactId !== null) {
      supersededCount += 1
      continue
    }
    if (fact.recordStatus === 'entered-in-error' || fact.presence === 'not-asked') {
      notAskedOrErrorCount += 1
      continue
    }
    if (fact.ineligibleReasons.includes('clinician-rejected')) {
      notAskedOrErrorCount += 1
      continue
    }
    if (fact.qualityFlags.includes('external-unverified') || (fact.institutionScope === 'external' && !fact.clinicianVerification.verified)) {
      externalUnverifiedCount += 1
      continue
    }
    if (fact.qualityFlags.includes('suspicious') || fact.suspiciousReasons.length > 0) {
      suspiciousCount += 1
      continue
    }
    if (fact.qualityFlags.includes('conflict')) {
      conflictCount += 1
      continue
    }
    if (asOfMs !== null) {
      const ingestedMs = parseIsoMs(fact.ingestedAt)
      if (ingestedMs !== null && ingestedMs > asOfMs) continue
      const effectiveMs = parseIsoMs(fact.effectiveAt ?? fact.reportedAt ?? fact.ingestedAt)
      if (effectiveMs !== null && effectiveMs > asOfMs) continue
    }
    eligibleFacts.push(fact)
  }

  return {
    eligibleFacts,
    excludedSummary: {
      conflictCount,
      externalUnverifiedCount,
      notAskedOrErrorCount,
      supersededCount,
      suspiciousCount,
    },
  }
}

function convertNumericUnit(
  value: number,
  fromUnit: string | null,
  matcher: PhenotypeFactMatcher,
): number | null {
  if (matcher.unit === undefined) return value
  if (fromUnit === null) return null
  if (fromUnit === matcher.unit) return value
  const multipliers = matcher.unitMultipliers
  if (!multipliers) return null
  if (Object.hasOwn(multipliers, fromUnit)) {
    return value * multipliers[fromUnit]!
  }
  const lowerUnit = fromUnit.toLowerCase()
  for (const [key, mult] of Object.entries(multipliers)) {
    if (key.toLowerCase() === lowerUnit) return value * mult
  }
  return null
}

function resolveAgeLimit(
  threshold: PhenotypeAgeThresholdBySex,
  patientSex: MatchPhenotypeCandidatesInput['patientSex'],
): number {
  if (patientSex === 'male' && threshold.maleYears !== undefined) return threshold.maleYears
  if (patientSex === 'female' && threshold.femaleYears !== undefined) return threshold.femaleYears
  return threshold.defaultYears
}

function factMatchesRuleMatcher(
  ctx: ResolvedFactContext,
  matcher: PhenotypeFactMatcher,
  patientSex: MatchPhenotypeCandidatesInput['patientSex'],
): boolean {
  const { fact } = ctx
  if (matcher.categories !== undefined && !matcher.categories.includes(fact.category)) return false
  if (matcher.presence !== fact.presence) return false

  if (matcher.conceptCodes !== undefined || matcher.codePatterns !== undefined) {
    const matchesConcept = matcher.conceptCodes !== undefined
      && matcher.conceptCodes.some(code => ctx.resolvedConceptCodes.has(code))
    const matchesPattern = matcher.codePatterns !== undefined
      && matcher.codePatterns.some(rawPattern => {
        const regex = new RegExp(rawPattern)
        return [...ctx.resolvedConceptCodes].some(code => regex.test(code))
      })
    if (!matchesConcept && !matchesPattern) return false
  }

  const candidateText = `${fact.itemCode.display} ${fact.value.rawText}`

  if (matcher.textPattern !== undefined) {
    const regex = new RegExp(matcher.textPattern, 'i')
    if (!regex.test(candidateText)) return false
  }

  if (matcher.minValue !== undefined || matcher.maxValue !== undefined || matcher.unit !== undefined) {
    if (ctx.numericValue === null) return false
    const converted = convertNumericUnit(ctx.numericValue, ctx.numericUnit, matcher)
    if (converted === null || !Number.isFinite(converted)) return false
    if (matcher.minValue !== undefined && converted < matcher.minValue) return false
    if (matcher.maxValue !== undefined && converted > matcher.maxValue) return false
  }

  if (matcher.maxAgeAtFactYears !== undefined) {
    const limit = resolveAgeLimit(matcher.maxAgeAtFactYears, patientSex)
    if (ctx.ageAtFactYears !== null) {
      if (ctx.ageAtFactYears >= limit) return false
    } else if (matcher.maxAgeFallbackTextPattern !== undefined) {
      const fallbackRe = new RegExp(matcher.maxAgeFallbackTextPattern, 'i')
      if (!fallbackRe.test(candidateText)) return false
    } else {
      return false
    }
  }

  return true
}

function toFactEvidence(ctx: ResolvedFactContext): PhenotypeFactEvidence {
  const { fact } = ctx
  return {
    category: fact.category,
    encounterKey: ctx.encounterKey,
    encounterLabel: ctx.encounterLabel,
    factId: fact.factId,
    institutionScope: fact.institutionScope,
    itemCode: fact.itemCode.code,
    itemDisplay: fact.itemCode.display,
    normalizedNumericValue: ctx.numericValue,
    observedAt: ctx.observedAt,
    recordId: fact.provenance.recordId,
    recordType: fact.provenance.recordType,
    recordVersion: fact.provenance.recordVersion,
    unit: ctx.numericUnit,
    valueText: fact.value.rawText,
    verified: fact.institutionScope === 'local' || fact.clinicianVerification.verified,
  }
}

function evaluatePhenotypeRule(
  rule: PhenotypeObservationRule,
  resolvedFacts: readonly ResolvedFactContext[],
  patientSex: MatchPhenotypeCandidatesInput['patientSex'],
): PhenotypeTermMatch | null {
  const matchers = rule.alternativeMatchers ? [rule.matcher, ...rule.alternativeMatchers] : [rule.matcher]
  const matchingContexts = resolvedFacts
    .filter(ctx => matchers.some(matcher => factMatchesRuleMatcher(ctx, matcher, patientSex)))
    .toSorted((a, b) => (a.observedMs !== b.observedMs ? a.observedMs - b.observedMs : a.fact.factId.localeCompare(b.fact.factId)))

  if (matchingContexts.length === 0) return null

  const distinctEncounters = new Set(matchingContexts.map(ctx => ctx.encounterKey))
  const earliestMs = matchingContexts[0]!.observedMs
  const latestMs = matchingContexts[matchingContexts.length - 1]!.observedMs
  const spanDays = Number(((latestMs - earliestMs) / MS_PER_DAY).toFixed(2))

  if (rule.evaluationKind === 'cross-time-persistence') {
    const requiredEncounters = rule.minDistinctEncounters ?? 2
    const requiredSpanDays = rule.minSpanDays ?? 0
    if (distinctEncounters.size < requiredEncounters || spanDays < requiredSpanDays) {
      return null
    }
  }

  return {
    distinctEncounterCount: distinctEncounters.size,
    domain: rule.domain,
    earliestAt: matchingContexts[0]!.observedAt,
    evidences: matchingContexts.map(toFactEvidence),
    labelEn: rule.labelEn,
    labelZh: rule.labelZh,
    latestAt: matchingContexts[matchingContexts.length - 1]!.observedAt,
    matchCount: matchingContexts.length,
    phenotypeCode: rule.phenotypeCode,
    spanDays,
  }
}

function buildCrossTimeTimeline(
  matchedPhenotypes: readonly PhenotypeCandidateTermMatch[],
): PhenotypeTimelineEntry[] {
  const entries: PhenotypeTimelineEntry[] = []
  const seen = new Set<string>()
  for (const term of matchedPhenotypes) {
    for (const ev of term.evidences) {
      const key = `${term.phenotypeCode}::${ev.factId}`
      if (seen.has(key)) continue
      seen.add(key)
      entries.push({
        encounterLabel: ev.encounterLabel,
        factId: ev.factId,
        institutionScope: ev.institutionScope,
        itemCode: ev.itemCode,
        itemDisplay: ev.itemDisplay,
        observedAt: ev.observedAt,
        phenotypeCode: term.phenotypeCode,
        phenotypeLabelZh: term.labelZh,
        valueText: ev.valueText,
        verified: ev.verified,
      })
    }
  }
  return entries.toSorted((a, b) => {
    const diff = Date.parse(a.observedAt) - Date.parse(b.observedAt)
    if (diff !== 0) return diff
    const phenoCmp = a.phenotypeCode.localeCompare(b.phenotypeCode)
    return phenoCmp !== 0 ? phenoCmp : a.factId.localeCompare(b.factId)
  })
}

function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function clampPromptRefToken(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const suffix = `~${fnv1aHex(value)}`
  return `${value.slice(0, maxLength - suffix.length)}${suffix}`
}

function projectCandidateToPromptCard(
  candidate: PhenotypeCandidateMatch,
  timing: ClinicalPromptTiming,
  suggestedWorkupItemCodes: readonly string[],
): ClinicalPromptCard {
  const factVersionRefs: ClinicalPromptFactVersionRef[] = []
  const seenFactIds = new Set<string>()
  for (const term of candidate.matchedPhenotypes) {
    for (const ev of term.evidences) {
      if (seenFactIds.has(ev.factId)) continue
      seenFactIds.add(ev.factId)
      factVersionRefs.push({
        factId: clampPromptRefToken(ev.factId, 128),
        itemCode: clampPromptRefToken(ev.itemCode, 64),
        recordId: clampPromptRefToken(ev.recordId, 128),
        recordType: clampPromptRefToken(ev.recordType, 64),
        recordVersion: clampPromptRefToken(ev.recordVersion, 64),
      })
    }
  }

  const timelineText = candidate.crossTimeTimeline
    .slice(0, 6)
    .map(item => `${item.observedAt.slice(0, 10)} ${item.phenotypeLabelZh}（${item.itemDisplay}: ${item.valueText}）`)
    .join('；')
  const confidencePct = Math.round(candidate.confidenceScore * 100)
  const workupText = candidate.recommendedWorkupZh.join('；')

  return clinicalPromptCardSchema.parse({
    basedOnFactVersions: factVersionRefs.slice(0, 64),
    blockingTier: 'none',
    cardId: `${timing}:phenotype-candidate:${candidate.diseaseId}`,
    category: 'phenotype-candidate',
    deliveryMode: 'display',
    detail: `跨时间表型识别发现疑似${candidate.titleZh}线索（匹配 ${candidate.matchedPhenotypeCount} 项特征，置信度 ${confidencePct}%）：${timelineText}。建议复核与确认检查：${workupText}。${candidate.referralSuggestionZh}`,
    diffStatus: null,
    dismissal: null,
    indicator: candidate.confidenceScore >= 0.75 ? 'warning' : 'info',
    knowledgeSnapshotVersion: null,
    knowledgeStatus: 'published',
    longitudinalComparison: null,
    overrideReasons: ['clinical-judgement', 'result-pending-follow-up'],
    packId: candidate.packId,
    packVersion: candidate.packVersion,
    riskTags: [],
    sideBySideGroupKey: `${timing}:phenotype-candidate`,
    source: { label: `${candidate.titleZh} · 跨时间表型识别` },
    stale: false,
    staleReason: null,
    status: 'active',
    suggestions: [
      {
        actionKind: 'review-differential',
        id: `review-phenotype-${candidate.diseaseId}`,
        isDraftOnly: true,
        ...(suggestedWorkupItemCodes.length === 0 ? {} : { itemCodes: [...suggestedWorkupItemCodes] }),
        labelZh: `复核疑似${candidate.titleZh}表型线索及建议检查`,
      },
    ],
    summary: `疑似${candidate.titleZh}（${candidate.matchedPhenotypeCount} 项跨期特征，置信度 ${confidencePct}%）`,
    timing,
    trialBadgeZh: null,
    trialDisclaimerZh: null,
  })
}

/**
 * Pure deterministic cross-time phenotype matcher (AC30).
 * Executes zero LLM calls and contains zero hardcoded disease pack IDs or
 * disease-specific conditional branches; all matching rules come from the
 * caller-supplied `knowledgeBase` and `vocabulary`.
 */
export function matchPhenotypeCandidates(rawInput: MatchPhenotypeCandidatesInput): PhenotypeMatchResult {
  const evaluatedAsOf = rawInput.asOf ?? rawInput.ledger.trace.evaluatedAsOf
  const asOfMs = parseIsoMs(evaluatedAsOf)
  const asOfDate = evaluatedAsOf.slice(0, 10)
  const vocabulary = rawInput.vocabulary ?? PUBLIC_CONCEPT_VOCABULARY
  const knowledgeBase = rawInput.knowledgeBase
  const timing: ClinicalPromptTiming = rawInput.timing ?? 'encounter-open'

  const { eligibleFacts, excludedSummary } = partitionLedgerFacts(rawInput.ledger, asOfMs)

  const resolvedFacts: ResolvedFactContext[] = eligibleFacts.map(fact => {
    const observedAt = fact.effectiveAt ?? fact.reportedAt ?? fact.ingestedAt
    const observedMs = parseIsoMs(observedAt) ?? 0
    const numeric = extractFactNumeric(fact)
    return {
      ageAtFactYears: completedYearsBetween(rawInput.patientBirthDate, observedAt),
      encounterKey: resolveEncounterKey(fact, observedAt, observedMs, rawInput),
      encounterLabel: resolveEncounterLabel(fact, observedAt, observedMs, rawInput),
      fact,
      numericUnit: numeric.unit,
      numericValue: numeric.value,
      observedAt,
      observedMs,
      resolvedConceptCodes: resolveFactConceptCodes(fact.itemCode.code, vocabulary, asOfDate),
    }
  })

  const matchedPhenotypeTerms: PhenotypeTermMatch[] = []
  const matchedByCode = new Map<string, PhenotypeTermMatch>()
  for (const rule of knowledgeBase.phenotypeRules) {
    const match = evaluatePhenotypeRule(rule, resolvedFacts, rawInput.patientSex)
    if (match === null) continue
    matchedPhenotypeTerms.push(match)
    matchedByCode.set(rule.phenotypeCode, match)
  }

  matchedPhenotypeTerms.sort((a, b) => {
    const diff = Date.parse(a.earliestAt) - Date.parse(b.earliestAt)
    return diff !== 0 ? diff : a.phenotypeCode.localeCompare(b.phenotypeCode)
  })

  const diagnosisFacts = resolvedFacts.filter(ctx => ctx.fact.category === 'diagnosis' && ctx.fact.presence === 'present')

  const candidates: PhenotypeCandidateMatch[] = []
  const suggestedCodesByDiseaseId = new Map<string, readonly string[]>()

  for (const spec of knowledgeBase.candidates) {
    const hasExclusion = spec.exclusionDiagnosisPatterns.some(rawPattern => {
      const re = new RegExp(rawPattern)
      return diagnosisFacts.some(ctx => [...ctx.resolvedConceptCodes].some(code => re.test(code)))
    })
    if (hasExclusion) continue

    const matchedTerms: PhenotypeCandidateTermMatch[] = []
    for (const weighted of spec.weightedTerms) {
      const term = matchedByCode.get(weighted.phenotypeCode)
      if (term === undefined) continue
      matchedTerms.push({
        ...term,
        rationaleZh: weighted.rationaleZh,
        weight: weighted.weight,
      })
    }

    if (matchedTerms.length < spec.minMatchedTerms) continue
    if (
      spec.requiredAnyPhenotypeCodes.length > 0
      && !spec.requiredAnyPhenotypeCodes.some(code => matchedByCode.has(code))
    ) {
      continue
    }

    const rawWeightedScore = Number(
      matchedTerms.reduce((sum, item) => sum + item.weight, 0).toFixed(4),
    )
    const confidenceScore = Number(
      Math.min(1, rawWeightedScore / spec.scoreNormalizationBase).toFixed(4),
    )
    if (confidenceScore < spec.minScoreThreshold) continue

    const crossTimeTimeline = buildCrossTimeTimeline(matchedTerms)
    suggestedCodesByDiseaseId.set(spec.diseaseId, spec.suggestedWorkupItemCodes)
    candidates.push({
      confidenceScore,
      crossTimeTimeline,
      diseaseId: spec.diseaseId,
      matchedPhenotypeCount: matchedTerms.length,
      matchedPhenotypes: matchedTerms,
      packId: spec.packId,
      packVersion: spec.packVersion,
      rawWeightedScore,
      recommendedWorkupZh: [...spec.recommendedWorkupZh],
      referralSuggestionZh: spec.referralSuggestionZh,
      specialty: spec.specialty,
      titleEn: spec.titleEn,
      titleZh: spec.titleZh,
    })
  }

  candidates.sort((a, b) => {
    if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore
    if (b.matchedPhenotypeCount !== a.matchedPhenotypeCount) return b.matchedPhenotypeCount - a.matchedPhenotypeCount
    return a.diseaseId.localeCompare(b.diseaseId)
  })

  const promptCards = candidates.map(candidate => (
    projectCandidateToPromptCard(
      candidate,
      timing,
      suggestedCodesByDiseaseId.get(candidate.diseaseId) ?? [],
    )
  ))

  return phenotypeMatchResultSchema.parse({
    candidates,
    eligibleFactCount: eligibleFacts.length,
    evaluatedAsOf,
    excludedFactSummary: excludedSummary,
    knowledgeBaseVersion: knowledgeBase.version,
    llmInvocationCount: 0,
    matchedPhenotypeTerms,
    promptCards,
  })
}
