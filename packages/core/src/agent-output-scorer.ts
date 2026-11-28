import { diffChars } from 'diff'
import {
  EVALUATED_LIVE_AUTHORIZED_LABEL_ZH,
  EVALUATED_SIMULATION_LABEL_ZH,
  SIMULATION_SCORING_DISCLAIMER_ZH,
  agentOutputScoreResultSchema,
  createUnevaluatedAgentOutputState,
  evaluateAgentOutputInputSchema,
  type AgentFabricationFinding,
  type AgentFabricationReasonCode,
  type AgentFactCoverageItem,
  type AgentOutputEvaluationBadge,
  type AgentOutputScoreResult,
  type AgentScoringRubricItem,
  type ClinicianEditMetrics,
  type ClinicianFieldEditDelta,
  type ClinicianFieldEditStatus,
  type DraftStructuredFactClaim,
  type EvaluateAgentOutputInput,
  type EvaluateAgentOutputRequestInput,
} from '@clinmesh/contracts/agent-output-scorer'
import type { ClinicalFact, ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import { conceptVocabularySchema, type ConceptVocabulary } from '@clinmesh/contracts/concept-vocabulary'
import {
  buildTargetCodeSet,
  buildTextConceptSignaturesFromVocabulary,
  buildVocabularyExactCodeMap,
  collectMatchingClauses,
  collectUniqueSentences,
  doesMeasurementMatchFact,
  extractNumericMeasurementsFromText,
  factSatisfiesVerificationBounds,
  findLedgerFactsByItemCodes,
  findSignatureMatchIndexInText,
  matchesLedgerFactKeywords,
  matchesPattern,
  matchesTextConceptSignature,
  measurementSatisfiesVerificationBounds,
  normalizeUnitToken,
  sortFactsMostRecentFirst,
  type TextConceptSignature,
} from './agent-output-scorer-signatures.ts'
import { resolveCanonicalItemCode } from './clinical-fact-ledger.ts'
import { PUBLIC_CONCEPT_VOCABULARY } from './concept-vocabulary.ts'
import { evaluatePackTrigger } from './disease-pack.ts'

export { createUnevaluatedAgentOutputState }
export { buildTextConceptSignaturesFromVocabulary, type TextConceptSignature }

export type AgentOutputScorerErrorCode =
  | 'LIVE_MODEL_SCORING_PERMISSION_REQUIRED'
  | 'SCORER_INVALID_INPUT'

export class AgentOutputScorerError extends Error {
  readonly code: AgentOutputScorerErrorCode

  constructor(code: AgentOutputScorerErrorCode, message: string) {
    super(message)
    this.name = 'AgentOutputScorerError'
    this.code = code
  }
}

function roundRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return Number(value.toFixed(4))
}

function evaluateRubricItemCoverage(input: {
  combinedDraftText: string
  evaluatedAt: string
  exactCodeMap: ReadonlyMap<string, ReadonlySet<string>>
  item: AgentScoringRubricItem
  ledger: ClinicalFactLedger
  signatures: readonly TextConceptSignature[]
  structuredClaims: readonly DraftStructuredFactClaim[]
  uniqueSentences: readonly string[]
  vocabulary: ConceptVocabulary
}): AgentFactCoverageItem {
  const {
    combinedDraftText,
    evaluatedAt,
    exactCodeMap,
    item,
    ledger,
    signatures,
    structuredClaims,
    uniqueSentences,
    vocabulary,
  } = input
  let matchedTriggerFactIds: string[] = []
  if (item.requiredWhenCondition !== undefined) {
    const triggerRes = evaluatePackTrigger(item.requiredWhenCondition, ledger, {
      asOf: evaluatedAt,
      vocabulary,
    })
    if (!triggerRes.matched) {
      return {
        labelZh: item.labelZh,
        matchedLedgerFactIds: [],
        pointsDelta: 0,
        reasonZh: `当前患者临床事实总账未触发此评估条目（${triggerRes.missingReasons.join(', ') || '条件不适用'}）`,
        rubricItemId: item.id,
        status: 'not-applicable',
      }
    }
    matchedTriggerFactIds = triggerRes.matchedFactIds
  }

  const patternMatched = item.expectedPatterns.some(pat => matchesPattern(combinedDraftText, pat))
  if (!patternMatched) {
    const fallbackFactIds = matchedTriggerFactIds.length > 0
      ? matchedTriggerFactIds
      : item.factVerification !== undefined
        ? findLedgerFactsByItemCodes(ledger, item.factVerification.itemCodes, exactCodeMap)
            .filter(f => f.eligibleForScoringAndRedLine)
            .map(f => f.factId)
        : []
    return {
      labelZh: item.labelZh,
      matchedLedgerFactIds: fallbackFactIds,
      pointsDelta: item.omissionPenaltyPoints === 0 ? 0 : -item.omissionPenaltyPoints,
      reasonZh: `Agent 草稿漏写或未明确陈述「${item.labelZh}」`,
      rubricItemId: item.id,
      status: 'omitted',
    }
  }

  if (item.factVerification === undefined) {
    return {
      labelZh: item.labelZh,
      matchedLedgerFactIds: matchedTriggerFactIds,
      pointsDelta: item.positivePoints,
      reasonZh: `草稿准确涵盖「${item.labelZh}」`,
      rubricItemId: item.id,
      status: 'covered-accurate',
    }
  }

  const verification = item.factVerification
  const matchingFacts = findLedgerFactsByItemCodes(ledger, verification.itemCodes, exactCodeMap)
  const eligibleFacts = sortFactsMostRecentFirst(
    matchingFacts.filter(f => f.eligibleForScoringAndRedLine && f.presence !== 'not-asked'),
  )
  const factIdsForResult = matchedTriggerFactIds.length > 0
    ? matchedTriggerFactIds
    : eligibleFacts.map(f => f.factId)

  if (eligibleFacts.length === 0) {
    return {
      labelZh: item.labelZh,
      matchedLedgerFactIds: [],
      pointsDelta: 0,
      reasonZh: `草稿提及「${item.labelZh}」，但总账中无有效可评分临床事实支持`,
      rubricItemId: item.id,
      status: 'covered-inaccurate',
    }
  }

  const latestEligible = eligibleFacts[0]!
  const hasBoundedCriterion = verification.minValue !== undefined || verification.maxValue !== undefined
  if (hasBoundedCriterion && !factSatisfiesVerificationBounds(latestEligible, verification, exactCodeMap)) {
    return {
      labelZh: item.labelZh,
      matchedLedgerFactIds: [latestEligible.factId],
      pointsDelta: 0,
      reasonZh: `草稿陈述「${item.labelZh}」，但总账最新有效数值（${latestEligible.value.rawText}）未满足核验区间`,
      rubricItemId: item.id,
      status: 'covered-inaccurate',
    }
  }

  const targetCodes = buildTargetCodeSet(verification.itemCodes, exactCodeMap)
  const relevantClaims = structuredClaims.filter(claim => (
    claim.itemCode !== undefined
    && (targetCodes.has(claim.itemCode) || targetCodes.has(resolveCanonicalItemCode(claim.itemCode)))
  ))

  for (const claim of relevantClaims) {
    if (!claim.claimedPresent) {
      return {
        labelZh: item.labelZh,
        matchedLedgerFactIds: factIdsForResult,
        pointsDelta: 0,
        reasonZh: `草稿结构化声明否定「${item.labelZh}」，与总账有效事实冲突`,
        rubricItemId: item.id,
        status: 'covered-inaccurate',
      }
    }
    if (claim.claimedNumericValue !== undefined) {
      const claimUnit = claim.claimedUnit ? normalizeUnitToken(claim.claimedUnit) : null
      const matchesAnyEligible = eligibleFacts.some(f => (
        doesMeasurementMatchFact(claim.claimedNumericValue!, claimUnit, f, [...buildTargetCodeSet([f.itemCode.code], exactCodeMap)])
      ))
      if (!matchesAnyEligible) {
        return {
          labelZh: item.labelZh,
          matchedLedgerFactIds: factIdsForResult,
          pointsDelta: 0,
          reasonZh: `草稿声明数值（${claim.claimedNumericValue}${claimUnit ? ` ${claimUnit}` : ''}）与总账事实不符`,
          rubricItemId: item.id,
          status: 'covered-inaccurate',
        }
      }
      const claimCandidateCodes = claim.itemCode ? [...buildTargetCodeSet([claim.itemCode], exactCodeMap)] : []
      if (
        hasBoundedCriterion
        && !relevantClaims.some(other => (
          other.claimedNumericValue !== undefined
          && measurementSatisfiesVerificationBounds(
            {
              rawMatch: String(other.claimedNumericValue),
              unit: other.claimedUnit ? normalizeUnitToken(other.claimedUnit) : null,
              value: other.claimedNumericValue,
            },
            verification,
            other.itemCode ? [...buildTargetCodeSet([other.itemCode], exactCodeMap)] : claimCandidateCodes,
          )
        ))
      ) {
        return {
          labelZh: item.labelZh,
          matchedLedgerFactIds: factIdsForResult,
          pointsDelta: 0,
          reasonZh: `草稿数值（${claim.claimedNumericValue}${claimUnit ? ` ${claimUnit}` : ''}）不符合「${item.labelZh}」核验条件`,
          rubricItemId: item.id,
          status: 'covered-inaccurate',
        }
      }
    }
  }

  const matchedClauses = collectMatchingClauses(
    uniqueSentences,
    item.expectedPatterns,
    verification.itemCodes,
    matchingFacts,
    signatures,
    exactCodeMap,
  )
  const extractedNumbers = matchedClauses.flatMap(clause => extractNumericMeasurementsFromText(clause))
  if (extractedNumbers.length > 0) {
    const qualifyingFacts = hasBoundedCriterion
      ? eligibleFacts.filter(f => factSatisfiesVerificationBounds(f, verification, exactCodeMap))
      : eligibleFacts
    const targetFactsToMatch = qualifyingFacts.length > 0 ? qualifyingFacts : [latestEligible]
    const anyMatchesQualifying = extractedNumbers.some(num => (
      targetFactsToMatch.some(f => (
        doesMeasurementMatchFact(num.value, num.unit, f, [...buildTargetCodeSet([f.itemCode.code], exactCodeMap)])
      ))
    ))
    if (!anyMatchesQualifying) {
      return {
        labelZh: item.labelZh,
        matchedLedgerFactIds: factIdsForResult,
        pointsDelta: 0,
        reasonZh: `草稿文本中「${item.labelZh}」相关数值与总账核验值不一致`,
        rubricItemId: item.id,
        status: 'covered-inaccurate',
      }
    }
  }

  return {
    labelZh: item.labelZh,
    matchedLedgerFactIds: factIdsForResult,
    pointsDelta: item.positivePoints,
    reasonZh: `草稿准确涵盖「${item.labelZh}」且数值与临床事实总账一致`,
    rubricItemId: item.id,
    status: 'covered-accurate',
  }
}

function classifyNonBackingReason(facts: readonly ClinicalFact[]): {
  reasonCode: AgentFabricationReasonCode
  reasonZh: string
} {
  if (facts.some(f => f.qualityFlags.includes('external-unverified') || f.ineligibleReasons.includes('external-unverified'))) {
    return {
      reasonCode: 'UNVERIFIED_EXTERNAL_USED_AS_FACT',
      reasonZh: '草稿将未经本院医生核验的外院记录作为已证实临床事实陈述',
    }
  }
  if (facts.some(f => (
    f.qualityFlags.includes('suspicious')
    || f.qualityFlags.includes('conflict')
    || f.ineligibleReasons.includes('clinician-rejected')
  ))) {
    return {
      reasonCode: 'CONTRADICTORY_VALUE',
      reasonZh: '草稿将总账中标记为可疑、冲突或已被医生否决的非有效记录作为确认事实陈述',
    }
  }
  return {
    reasonCode: 'NONEXISTENT_LAB_OR_EXAM',
    reasonZh: '草稿断言了临床事实总账中无有效记录支撑的检验或检查结果',
  }
}

function matchLedgerFactsForTextSignature(
  ledger: ClinicalFactLedger,
  sig: TextConceptSignature,
  exactCodeMap: ReadonlyMap<string, ReadonlySet<string>>,
): ClinicalFact[] {
  const codeSet = buildTargetCodeSet(sig.ledgerLookupCodes, exactCodeMap)
  return ledger.facts.filter(fact => {
    if (codeSet.size > 0 && (codeSet.has(fact.itemCode.code) || codeSet.has(resolveCanonicalItemCode(fact.itemCode.code)))) {
      return true
    }
    const haystack = `${fact.itemCode.code} ${fact.itemCode.display} ${fact.value.rawText} ${fact.method ?? ''}`
    return matchesLedgerFactKeywords(sig, haystack)
  })
}

function matchLedgerFactsForStructuredClaim(
  ledger: ClinicalFactLedger,
  claim: DraftStructuredFactClaim,
  signatures: readonly TextConceptSignature[],
  exactCodeMap: ReadonlyMap<string, ReadonlySet<string>>,
): ClinicalFact[] {
  if (claim.itemCode !== undefined) {
    const byCode = findLedgerFactsByItemCodes(ledger, [claim.itemCode], exactCodeMap)
    if (byCode.length > 0) return byCode
  }
  for (const sig of signatures) {
    if (matchesTextConceptSignature(sig, claim.statementZh)) {
      const matched = matchLedgerFactsForTextSignature(ledger, sig, exactCodeMap)
      if (matched.length > 0) return matched
    }
  }
  if (claim.itemCode === undefined && claim.category !== undefined) {
    const normalizedStatement = claim.statementZh.toLowerCase()
    return ledger.facts.filter(fact => (
      fact.category === claim.category
      && (
        normalizedStatement.includes(fact.itemCode.display.toLowerCase())
        || normalizedStatement.includes(fact.itemCode.code.toLowerCase())
      )
    ))
  }
  return []
}

function recordFlaggedClaim(
  flaggedClaimTexts: Set<string>,
  flaggedItemCodes: Set<string>,
  claim: DraftStructuredFactClaim,
  exactCodeMap: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  flaggedClaimTexts.add(claim.statementZh.replace(/\s+/gu, '').toLowerCase())
  if (claim.itemCode !== undefined) {
    for (const eq of buildTargetCodeSet([claim.itemCode], exactCodeMap)) {
      flaggedItemCodes.add(eq)
    }
  }
}

function detectFabrications(input: {
  exactCodeMap: ReadonlyMap<string, ReadonlySet<string>>
  fabricationPenaltyPoints: number
  ledger: ClinicalFactLedger
  signatures: readonly TextConceptSignature[]
  structuredClaims: readonly DraftStructuredFactClaim[]
  uniqueSentences: readonly string[]
}): AgentFabricationFinding[] {
  const { exactCodeMap, signatures } = input
  const findings: AgentFabricationFinding[] = []
  const coveredSignatureIdsBySentence = new Set<string>()
  const flaggedClaimTexts = new Set<string>()
  const flaggedItemCodes = new Set<string>()

  // Track 1: Explicit structuredClaims emitted alongside or parsed from the Agent draft
  for (const claim of input.structuredClaims) {
    const matchedFacts = matchLedgerFactsForStructuredClaim(input.ledger, claim, signatures, exactCodeMap)
    const eligibleFacts = matchedFacts.filter(f => f.eligibleForScoringAndRedLine && f.presence !== 'not-asked')
    const ineligibleFacts = matchedFacts.filter(f => !f.eligibleForScoringAndRedLine || f.presence === 'not-asked')

    if (!claim.claimedPresent) {
      if (eligibleFacts.some(f => f.presence === 'present')) {
        findings.push({
          claimId: claim.claimId,
          ...(claim.itemCode === undefined ? {} : { itemCode: claim.itemCode }),
          penaltyPoints: input.fabricationPenaltyPoints,
          reasonCode: 'CONTRADICTORY_VALUE',
          reasonZh: `草稿否定「${claim.statementZh}」，与总账已证实阳性事实相矛盾`,
          relatedLedgerFactIds: eligibleFacts.map(f => f.factId),
          statementZh: claim.statementZh,
        })
        recordFlaggedClaim(flaggedClaimTexts, flaggedItemCodes, claim, exactCodeMap)
      }
      continue
    }

    if (matchedFacts.length === 0) {
      findings.push({
        claimId: claim.claimId,
        ...(claim.itemCode === undefined ? {} : { itemCode: claim.itemCode }),
        penaltyPoints: input.fabricationPenaltyPoints,
        reasonCode: 'NONEXISTENT_LAB_OR_EXAM',
        reasonZh: `草稿声明了临床事实总账中不存在的检验/检查或临床事实：${claim.statementZh}`,
        relatedLedgerFactIds: [],
        statementZh: claim.statementZh,
      })
      recordFlaggedClaim(flaggedClaimTexts, flaggedItemCodes, claim, exactCodeMap)
      continue
    }

    if (eligibleFacts.length === 0) {
      const classified = classifyNonBackingReason(ineligibleFacts)
      findings.push({
        claimId: claim.claimId,
        ...(claim.itemCode === undefined ? {} : { itemCode: claim.itemCode }),
        penaltyPoints: input.fabricationPenaltyPoints,
        reasonCode: classified.reasonCode,
        reasonZh: classified.reasonZh,
        relatedLedgerFactIds: ineligibleFacts.map(f => f.factId),
        statementZh: claim.statementZh,
      })
      recordFlaggedClaim(flaggedClaimTexts, flaggedItemCodes, claim, exactCodeMap)
      continue
    }

    const allAbsent = eligibleFacts.every(f => f.presence === 'absent')
    if (allAbsent) {
      findings.push({
        claimId: claim.claimId,
        ...(claim.itemCode === undefined ? {} : { itemCode: claim.itemCode }),
        penaltyPoints: input.fabricationPenaltyPoints,
        reasonCode: 'CONTRADICTORY_VALUE',
        reasonZh: `草稿声称「${claim.statementZh}」为阳性/存在，但总账有效事实记录为阴性或不存在`,
        relatedLedgerFactIds: eligibleFacts.map(f => f.factId),
        statementZh: claim.statementZh,
      })
      recordFlaggedClaim(flaggedClaimTexts, flaggedItemCodes, claim, exactCodeMap)
      continue
    }

    if (claim.claimedNumericValue !== undefined) {
      const claimUnit = claim.claimedUnit ? normalizeUnitToken(claim.claimedUnit) : null
      const matchesEligible = eligibleFacts.some(f => (
        doesMeasurementMatchFact(claim.claimedNumericValue!, claimUnit, f, [...buildTargetCodeSet([f.itemCode.code], exactCodeMap)])
      ))
      if (!matchesEligible) {
        const matchesIneligible = ineligibleFacts.some(f => (
          doesMeasurementMatchFact(claim.claimedNumericValue!, claimUnit, f, [...buildTargetCodeSet([f.itemCode.code], exactCodeMap)])
        ))
        const classified = matchesIneligible
          ? classifyNonBackingReason(ineligibleFacts)
          : {
              reasonCode: 'CONTRADICTORY_VALUE' as const,
              reasonZh: `草稿陈述数值（${claim.claimedNumericValue}${claimUnit ? ` ${claimUnit}` : ''}）与总账有效事实矛盾`,
            }
        findings.push({
          claimId: claim.claimId,
          ...(claim.itemCode === undefined ? {} : { itemCode: claim.itemCode }),
          penaltyPoints: input.fabricationPenaltyPoints,
          reasonCode: classified.reasonCode,
          reasonZh: classified.reasonZh,
          relatedLedgerFactIds: (matchesIneligible ? ineligibleFacts : eligibleFacts).map(f => f.factId),
          statementZh: claim.statementZh,
        })
        recordFlaggedClaim(flaggedClaimTexts, flaggedItemCodes, claim, exactCodeMap)
      }
    }
  }

  // Track 2: Deterministic text detection for vocabulary concepts not backed by ledger
  const assertionMarkerRe = /(?:显示|提示|示|测得|为|达标|正常|异常|升高|降低|回落|阳性|阴性|压低|抬高|狭窄|阻塞|未见(?:明显)?(?:心肌|异常|梗死|水肿|狭窄|病变|出血|积液|结节|占位|肿块|钙化|渗出|实变)|无(?:明显)?(?:异常|狭窄|水肿|结节|占位))/iu
  const nonFindingOrderOrAbsentRe = /(?:^|[^未])(?:建议(?:完善|复查|行|申请|加做)|拟(?:行|查|复查|申请)|尚未(?:行|做|查)|未(?:行|做|查)|暂缺|缺少|无.*(?:记录|结果|报告)|未见.*(?:检查记录|结果|报告)|待查)/iu
  const unverifiedQualifierRe = /(?:尚未?(?:经本院)?核验|未经核实|未证实|待核实|需复核|建议复查)/iu

  let textClaimCounter = 0

  for (const sentence of input.uniqueSentences) {
    const normSentence = sentence.replace(/\s+/gu, '').toLowerCase()
    if (flaggedClaimTexts.has(normSentence)) continue
    if ([...flaggedClaimTexts].some(ct => ct.length >= 6 && (normSentence.includes(ct) || ct.includes(normSentence)))) {
      continue
    }

    const clauses = sentence.split(/[，,]+/u).map(c => c.trim()).filter(Boolean)
    const pendingMissingExamInSentence: {
      clauses: string[]
      itemCodes: string[]
      kind: 'modality' | 'measurement'
      labelZh: string
      sigIds: string[]
    }[] = []
    const emittedClauseNonBackingKeys = new Set<string>()

    for (const clause of clauses) {
      const clauseMeasurements = extractNumericMeasurementsFromText(clause)
      const hasNumericAssertion = clauseMeasurements.length > 0
      const isFactualAssertion = hasNumericAssertion || assertionMarkerRe.test(clause)
      if (!isFactualAssertion) continue
      if (!hasNumericAssertion && nonFindingOrderOrAbsentRe.test(clause)) continue
      if (nonFindingOrderOrAbsentRe.test(clause) && !assertionMarkerRe.test(clause)) continue

      const matchedSigsInClause = signatures
        .map(sig => ({ matchIndex: findSignatureMatchIndexInText(sig, clause), sig }))
        .filter(entry => entry.matchIndex !== -1)
        .sort((a, b) => a.matchIndex - b.matchIndex)

      for (const { matchIndex, sig } of matchedSigsInClause) {
        if (sig.itemCodes.some(code => flaggedItemCodes.has(code) || flaggedItemCodes.has(resolveCanonicalItemCode(code)))) {
          continue
        }

        const dedupKey = `${normSentence}::${sig.id}`
        if (coveredSignatureIdsBySentence.has(dedupKey)) continue
        coveredSignatureIdsBySentence.add(dedupKey)

        const nextSigEntry = matchedSigsInClause.find(other => other.matchIndex > matchIndex)
        const sigMeasurements = matchedSigsInClause.length > 1
          ? extractNumericMeasurementsFromText(
              clause.slice(matchIndex, nextSigEntry === undefined ? clause.length : nextSigEntry.matchIndex),
            )
          : clauseMeasurements

        const matchedFacts = matchLedgerFactsForTextSignature(input.ledger, sig, exactCodeMap)
        const eligibleFacts = matchedFacts.filter(f => f.eligibleForScoringAndRedLine && f.presence !== 'not-asked')
        const ineligibleFacts = matchedFacts.filter(f => !f.eligibleForScoringAndRedLine || f.presence === 'not-asked')

        if (matchedFacts.length === 0) {
          if (sig.kind === 'measurement' && pendingMissingExamInSentence.some(item => item.kind === 'modality')) {
            const target = pendingMissingExamInSentence.find(item => item.kind === 'modality')!
            target.clauses.push(clause)
            target.sigIds.push(sig.id)
          } else if (sig.kind === 'modality' && pendingMissingExamInSentence.some(item => item.kind === 'measurement')) {
            const target = pendingMissingExamInSentence.find(item => item.kind === 'measurement')!
            target.kind = 'modality'
            target.labelZh = sig.labelZh
            target.clauses.push(clause)
            target.itemCodes = [...new Set([...sig.itemCodes, ...target.itemCodes])]
            target.sigIds.push(sig.id)
          } else {
            pendingMissingExamInSentence.push({
              clauses: [clause],
              itemCodes: [...sig.itemCodes],
              kind: sig.kind,
              labelZh: sig.labelZh,
              sigIds: [sig.id],
            })
          }
          continue
        }

        if (eligibleFacts.length === 0) {
          if (
            ineligibleFacts.some(f => f.qualityFlags.includes('external-unverified'))
            && unverifiedQualifierRe.test(sentence)
          ) {
            continue
          }
          const classified = classifyNonBackingReason(ineligibleFacts)
          const clauseKey = `${clause}::${classified.reasonCode}`
          if (emittedClauseNonBackingKeys.has(clauseKey)) continue
          emittedClauseNonBackingKeys.add(clauseKey)
          textClaimCounter += 1
          findings.push({
            claimId: `text-claim-${textClaimCounter}`,
            ...(sig.itemCodes[0] === undefined ? {} : { itemCode: sig.itemCodes[0] }),
            penaltyPoints: input.fabricationPenaltyPoints,
            reasonCode: classified.reasonCode,
            reasonZh: `${classified.reasonZh}（${sig.labelZh}）`,
            relatedLedgerFactIds: ineligibleFacts.map(f => f.factId),
            statementZh: clause,
          })
          continue
        }

        if (sig.expectsNumeric && sigMeasurements.length > 0) {
          const allMatchedInEligible = sigMeasurements.every(num => (
            eligibleFacts.some(f => (
              doesMeasurementMatchFact(num.value, num.unit, f, [...buildTargetCodeSet([f.itemCode.code], exactCodeMap)])
            ))
          ))
          if (!allMatchedInEligible) {
            const unmatched = sigMeasurements.filter(num => (
              !eligibleFacts.some(f => (
                doesMeasurementMatchFact(num.value, num.unit, f, [...buildTargetCodeSet([f.itemCode.code], exactCodeMap)])
              ))
            ))
            const matchesIneligible = unmatched.some(num => (
              ineligibleFacts.some(f => (
                doesMeasurementMatchFact(num.value, num.unit, f, [...buildTargetCodeSet([f.itemCode.code], exactCodeMap)])
              ))
            ))
            if (matchesIneligible && unverifiedQualifierRe.test(sentence)) {
              continue
            }
            const classified = matchesIneligible
              ? classifyNonBackingReason(ineligibleFacts)
              : {
                  reasonCode: 'CONTRADICTORY_VALUE' as const,
                  reasonZh: `草稿中「${sig.labelZh}」数值（${unmatched.map(u => u.rawMatch).join('、')}）与临床事实总账不一致`,
                }
            textClaimCounter += 1
            findings.push({
              claimId: `text-claim-${textClaimCounter}`,
              ...(sig.itemCodes[0] === undefined ? {} : { itemCode: sig.itemCodes[0] }),
              penaltyPoints: input.fabricationPenaltyPoints,
              reasonCode: classified.reasonCode,
              reasonZh: classified.reasonZh,
              relatedLedgerFactIds: (matchesIneligible ? ineligibleFacts : eligibleFacts).map(f => f.factId),
              statementZh: clause,
            })
          }
        }
      }
    }

    for (const missingGroup of pendingMissingExamInSentence) {
      textClaimCounter += 1
      const combinedClause = missingGroup.clauses.length > 1
        ? sentence
        : missingGroup.clauses[0]!
      findings.push({
        claimId: `text-claim-${textClaimCounter}`,
        ...(missingGroup.itemCodes[0] === undefined ? {} : { itemCode: missingGroup.itemCodes[0] }),
        penaltyPoints: input.fabricationPenaltyPoints,
        reasonCode: 'NONEXISTENT_LAB_OR_EXAM',
        reasonZh: `草稿编造了临床事实总账中不存在的「${missingGroup.labelZh}」检查或检验结果`,
        relatedLedgerFactIds: [],
        statementZh: combinedClause,
      })
    }
  }

  return findings
}

export function computeClinicianEditMetrics(
  draftFields: Readonly<Record<string, string>>,
  clinicianFinalFields: Readonly<Record<string, string>>,
): ClinicianEditMetrics {
  const keys = [...new Set([...Object.keys(draftFields), ...Object.keys(clinicianFinalFields)])]
    .sort((a, b) => a.localeCompare(b))

  const fields: ClinicianFieldEditDelta[] = []
  let modifiedFieldsCount = 0
  let unchangedFieldsCount = 0
  let addedFieldsCount = 0
  let deletedFieldsCount = 0
  let totalAddedChars = 0
  let totalRemovedChars = 0
  let totalDraftChars = 0
  let totalFinalChars = 0

  for (const fieldKey of keys) {
    const draftValue = Object.hasOwn(draftFields, fieldKey) ? draftFields[fieldKey]! : ''
    const finalValue = Object.hasOwn(clinicianFinalFields, fieldKey) ? clinicianFinalFields[fieldKey]! : ''
    const draftChars = draftValue.length
    const finalChars = finalValue.length
    totalDraftChars += draftChars
    totalFinalChars += finalChars

    let addedChars = 0
    let removedChars = 0
    let status: ClinicianFieldEditStatus

    if (draftValue === finalValue) {
      status = 'unchanged'
      unchangedFieldsCount += 1
    } else if (draftChars === 0 && finalChars > 0) {
      status = 'added'
      addedChars = finalChars
      addedFieldsCount += 1
    } else if (draftChars > 0 && finalChars === 0) {
      status = 'deleted'
      removedChars = draftChars
      deletedFieldsCount += 1
    } else {
      status = 'modified'
      modifiedFieldsCount += 1
      for (const part of diffChars(draftValue, finalValue)) {
        if (part.added) addedChars += part.value.length
        else if (part.removed) removedChars += part.value.length
      }
    }

    totalAddedChars += addedChars
    totalRemovedChars += removedChars
    const fieldDenom = draftChars + finalChars
    const editRatio = fieldDenom === 0 ? 0 : roundRatio((addedChars + removedChars) / fieldDenom)

    fields.push({
      addedChars,
      draftChars,
      editRatio,
      fieldKey,
      finalChars,
      removedChars,
      status,
    })
  }

  const totalDenom = totalDraftChars + totalFinalChars
  const overallEditRatio = totalDenom === 0
    ? 0
    : roundRatio((totalAddedChars + totalRemovedChars) / totalDenom)

  return {
    addedFieldsCount,
    deletedFieldsCount,
    fields,
    modifiedFieldsCount,
    overallEditRatio,
    totalAddedChars,
    totalFields: fields.length,
    totalRemovedChars,
    unchangedFieldsCount,
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Pre-validation per-run authorization gate for live-model scoring mode. */
export function assertLiveModelScoringPermitted(rawInput: unknown): void {
  if (rawInput === null || typeof rawInput !== 'object') return
  const candidate = rawInput as { mode?: unknown; liveRunPermit?: unknown }
  if (candidate.mode !== 'live-model') return
  const permit = candidate.liveRunPermit
  const granted = permit !== null
    && typeof permit === 'object'
    && (permit as { explicitUserPermissionGranted?: unknown }).explicitUserPermissionGranted === true
    && isNonEmptyString((permit as { runId?: unknown }).runId)
    && isNonEmptyString((permit as { authorizedByActorId?: unknown }).authorizedByActorId)
    && isNonEmptyString((permit as { authorizedAt?: unknown }).authorizedAt)
  if (!granted) {
    throw new AgentOutputScorerError(
      'LIVE_MODEL_SCORING_PERMISSION_REQUIRED',
      '对真实模型输出评分必须获得用户针对当次运行的明确许可（含有效 runId 与授权签名）',
    )
  }
}

function filterLedgerAtEvaluatedAt(ledger: ClinicalFactLedger, evaluatedAt: string): ClinicalFactLedger {
  const cutoffMs = Date.parse(evaluatedAt)
  if (Number.isNaN(cutoffMs)) return ledger
  const facts = ledger.facts.filter(fact => {
    const ingestedMs = Date.parse(fact.ingestedAt)
    return Number.isNaN(ingestedMs) || ingestedMs <= cutoffMs
  })
  return { ...ledger, facts }
}

export function scoreAgentDraftOutput(params: {
  conceptVocabulary?: ConceptVocabulary | undefined
  evaluatedAt?: string | undefined
  input: EvaluateAgentOutputRequestInput
  ledger: ClinicalFactLedger
}): AgentOutputScoreResult {
  // Gate check FIRST: never score or touch live-model mode without explicit per-run permit
  assertLiveModelScoringPermitted(params.input)

  const parsedResult = evaluateAgentOutputInputSchema.safeParse(params.input)
  if (!parsedResult.success) {
    const summary = parsedResult.error.issues
      .slice(0, 5)
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')
    throw new AgentOutputScorerError(
      'SCORER_INVALID_INPUT',
      `Agent 输出评分入参校验失败: ${summary}`,
    )
  }

  let effectiveVocabulary: ConceptVocabulary
  if (params.conceptVocabulary === undefined) {
    effectiveVocabulary = PUBLIC_CONCEPT_VOCABULARY
  } else {
    const vocabResult = conceptVocabularySchema.safeParse(params.conceptVocabulary)
    if (!vocabResult.success) {
      const summary = vocabResult.error.issues
        .slice(0, 5)
        .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')
      throw new AgentOutputScorerError(
        'SCORER_INVALID_INPUT',
        `Agent 输出评分概念词表校验失败: ${summary}`,
      )
    }
    effectiveVocabulary = vocabResult.data
  }

  const parsedInput: EvaluateAgentOutputInput = parsedResult.data
  const evaluatedAt = params.evaluatedAt ?? parsedInput.asOf ?? params.ledger.trace.evaluatedAsOf
  if (Number.isNaN(Date.parse(evaluatedAt))) {
    throw new AgentOutputScorerError('SCORER_INVALID_INPUT', `无效的评测时间 evaluatedAt: ${evaluatedAt}`)
  }

  const effectiveLedger = filterLedgerAtEvaluatedAt(params.ledger, evaluatedAt)
  const asOfDate = evaluatedAt.slice(0, 10)
  const signatures = buildTextConceptSignaturesFromVocabulary(effectiveVocabulary, { asOfDate })
  const exactCodeMap = buildVocabularyExactCodeMap(effectiveVocabulary, asOfDate)

  const badge: AgentOutputEvaluationBadge = parsedInput.mode === 'controlled-stream'
    ? {
        disclaimerZh: SIMULATION_SCORING_DISCLAIMER_ZH,
        labelZh: EVALUATED_SIMULATION_LABEL_ZH,
        status: 'evaluated-simulation',
      }
    : {
        labelZh: EVALUATED_LIVE_AUTHORIZED_LABEL_ZH,
        runId: parsedInput.liveRunPermit!.runId,
        status: 'evaluated-live-authorized',
      }

  const combinedDraftText = [parsedInput.draftText, ...Object.values(parsedInput.draftFields)]
    .filter(text => text.trim().length > 0)
    .join('\n')
  const uniqueSentences = collectUniqueSentences(parsedInput.draftText, parsedInput.draftFields)

  const coverageItems: AgentFactCoverageItem[] = []
  const omissions: AgentFactCoverageItem[] = []
  let positiveScore = 0
  let omissionPenalty = 0
  let maxPossiblePositiveScore = 0
  let applicableCount = 0
  let accurateCount = 0

  for (const item of parsedInput.rubric.items) {
    const itemCoverage = evaluateRubricItemCoverage({
      combinedDraftText,
      evaluatedAt,
      exactCodeMap,
      item,
      ledger: effectiveLedger,
      signatures,
      structuredClaims: parsedInput.structuredClaims,
      uniqueSentences,
      vocabulary: effectiveVocabulary,
    })
    coverageItems.push(itemCoverage)
    if (itemCoverage.status === 'not-applicable') continue

    applicableCount += 1
    maxPossiblePositiveScore += item.positivePoints
    if (itemCoverage.status === 'covered-accurate') {
      positiveScore += item.positivePoints
      accurateCount += 1
    } else if (itemCoverage.status === 'omitted') {
      omissionPenalty += item.omissionPenaltyPoints
      omissions.push(itemCoverage)
    }
  }

  const fabrications = detectFabrications({
    exactCodeMap,
    fabricationPenaltyPoints: parsedInput.rubric.fabricationPenaltyPoints,
    ledger: effectiveLedger,
    signatures,
    structuredClaims: parsedInput.structuredClaims,
    uniqueSentences,
  })
  const fabricationPenalty = fabrications.reduce((sum, item) => sum + item.penaltyPoints, 0)
  const netScore = Number((positiveScore - omissionPenalty - fabricationPenalty).toFixed(4))
  const keyFactCoverageRate = applicableCount === 0 ? 1 : roundRatio(accurateCount / applicableCount)

  const clinicianEditMetrics = parsedInput.clinicianFinalFields === undefined
    ? null
    : computeClinicianEditMetrics(parsedInput.draftFields, parsedInput.clinicianFinalFields)

  return agentOutputScoreResultSchema.parse({
    badge,
    clinicianEditMetrics,
    coverageItems,
    evaluatedAt,
    fabricationPenalty,
    fabrications,
    keyFactCoverageRate,
    maxPossiblePositiveScore,
    mode: parsedInput.mode,
    netScore,
    omissionPenalty,
    omissions,
    packId: parsedInput.rubric.packId,
    positiveScore,
    rubricId: parsedInput.rubric.rubricId,
    taskId: parsedInput.rubric.taskId,
    zeroLiveModelCalls: true,
  })
}
