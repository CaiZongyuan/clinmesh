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
import { resolveCanonicalItemCode } from './clinical-fact-ledger.ts'
import { evaluatePackTrigger } from './disease-pack.ts'

export { createUnevaluatedAgentOutputState }

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

interface TextConceptSignature {
  readonly id: string
  readonly kind: 'modality' | 'measurement'
  readonly labelZh: string
  readonly pattern: RegExp
  readonly ledgerKeywords: readonly string[]
  readonly itemCodes: readonly string[]
  readonly expectsNumeric: boolean
  readonly excludePattern?: RegExp
}

const KNOWN_TEXT_CONCEPT_SIGNATURES: readonly TextConceptSignature[] = [
  {
    id: 'cardiac-mri',
    kind: 'modality',
    labelZh: '心脏MRI',
    pattern: /心脏\s*(?:MRI|核磁共振?|磁共振)|\bCMR\b/iu,
    ledgerKeywords: ['心脏MRI', '心脏核磁', '心脏磁共振', 'CMR', 'MRI'],
    itemCodes: ['24558-9'],
    expectsNumeric: false,
  },
  {
    id: 'coronary-cta',
    kind: 'modality',
    labelZh: '冠脉CT/CTA',
    pattern: /冠(?:状动脉|脉)\s*CTA?/iu,
    ledgerKeywords: ['冠脉CT', '冠状动脉CT', '冠脉CTA', 'CT血管', 'CTA'],
    itemCodes: [],
    expectsNumeric: false,
  },
  {
    id: 'echocardiogram',
    kind: 'modality',
    labelZh: '超声心动图',
    pattern: /超声心动图|心脏(?:超声|彩超)|心超|\bUCG\b/iu,
    ledgerKeywords: ['超声心动图', '心脏超声', '心脏彩超', '心超', 'UCG'],
    itemCodes: ['10230-1', '18043-0', '88062-5'],
    expectsNumeric: false,
  },
  {
    id: 'lvef',
    kind: 'measurement',
    labelZh: '左室射血分数 (LVEF)',
    pattern: /\bLVEF\b|左室?射血分数|射血分数/iu,
    ledgerKeywords: ['LVEF', '射血分数', '超声心动图', '心脏超声', '心脏彩超', '心超'],
    itemCodes: ['10230-1', '18043-0', '88062-5'],
    expectsNumeric: true,
  },
  {
    id: 'coronary-angiography',
    kind: 'modality',
    labelZh: '冠脉造影',
    pattern: /冠(?:状动脉|脉)造影|\bCAG\b/iu,
    ledgerKeywords: ['冠脉造影', '冠状动脉造影', 'CAG', '88.55', '88.56'],
    itemCodes: ['88.5500', '88.5600', '88.55', '88.56'],
    expectsNumeric: false,
  },
  {
    id: 'holter',
    kind: 'modality',
    labelZh: '动态心电图',
    pattern: /动态心电图|\bHolter\b/iu,
    ledgerKeywords: ['动态心电图', 'Holter'],
    itemCodes: [],
    expectsNumeric: false,
  },
  {
    id: 'ecg',
    kind: 'modality',
    labelZh: '心电图',
    pattern: /(?:十二导联|12导联)?心电图|\bECG\b/iu,
    excludePattern: /动态心电图|负荷心电/iu,
    ledgerKeywords: ['心电图', 'ECG'],
    itemCodes: ['11524-6'],
    expectsNumeric: false,
  },
  {
    id: 'chest-ct-xray',
    kind: 'modality',
    labelZh: '胸部影像',
    pattern: /(?:胸部|肺部)\s*(?:CT|平扫|增强|X线)|胸片|\bCTPA\b/iu,
    ledgerKeywords: ['胸部CT', '肺部CT', '胸片', '胸部X线', 'CTPA'],
    itemCodes: [],
    expectsNumeric: false,
  },
  {
    id: 'vascular-abdominal-us',
    kind: 'modality',
    labelZh: '血管/腹部超声',
    pattern: /(?:颈动脉|下肢(?:深)?静脉|腹部)(?:超声|彩超)/iu,
    ledgerKeywords: ['颈动脉', '下肢静脉', '下肢深静脉', '腹部超声', '腹部彩超'],
    itemCodes: [],
    expectsNumeric: false,
  },
  {
    id: 'stress-nuclear',
    kind: 'modality',
    labelZh: '负荷试验/心肌核素',
    pattern: /运动平板|负荷心电|心肌核素|核素显像|\bSPECT\b|\bPET\b/iu,
    ledgerKeywords: ['运动平板', '负荷', '心肌核素', '核素显像', 'SPECT', 'PET'],
    itemCodes: [],
    expectsNumeric: false,
  },
  {
    id: 'troponin',
    kind: 'measurement',
    labelZh: '心肌肌钙蛋白',
    pattern: /高敏(?:心肌)?肌钙蛋白[IT]?|(?:心肌)?肌钙蛋白[IT]?|hs-?cTn[IT]|cTn[IT]/iu,
    ledgerKeywords: ['肌钙蛋白', 'hs-cTnI', 'cTnI', 'cTnT'],
    itemCodes: ['89579-7', '10839-9', '6597-9'],
    expectsNumeric: true,
  },
  {
    id: 'bnp',
    kind: 'measurement',
    labelZh: 'BNP/NT-proBNP',
    pattern: /NT-?proBNP|\bBNP\b|氨基末端脑利钠肽前体|脑利钠肽/iu,
    ledgerKeywords: ['NT-proBNP', 'BNP', '脑利钠肽', '利钠肽'],
    itemCodes: ['30934-4', '33762-6'],
    expectsNumeric: true,
  },
  {
    id: 'd-dimer',
    kind: 'measurement',
    labelZh: 'D-二聚体',
    pattern: /D-?二聚体|D-?dimer/iu,
    ledgerKeywords: ['D-二聚体', 'D-dimer', '二聚体'],
    itemCodes: ['48065-7'],
    expectsNumeric: true,
  },
  {
    id: 'hba1c',
    kind: 'measurement',
    labelZh: '糖化血红蛋白',
    pattern: /糖化血红蛋白|\bHbA1c\b/iu,
    ledgerKeywords: ['糖化血红蛋白', 'HbA1c'],
    itemCodes: ['4548-4'],
    expectsNumeric: true,
  },
  {
    id: 'ldl',
    kind: 'measurement',
    labelZh: 'LDL-C',
    pattern: /\bLDL(?:-?C)?\b|低密度脂蛋白(?:胆固醇)?/iu,
    ledgerKeywords: ['低密度脂蛋白', 'LDL'],
    itemCodes: ['13457-7', '2089-1', '18262-6'],
    expectsNumeric: true,
  },
  {
    id: 'creatinine',
    kind: 'measurement',
    labelZh: '血清肌酐',
    pattern: /(?:血清)?肌酐|\bSCr\b/iu,
    ledgerKeywords: ['肌酐'],
    itemCodes: ['2160-0', '14682-9'],
    expectsNumeric: true,
  },
  {
    id: 'potassium',
    kind: 'measurement',
    labelZh: '血清钾',
    pattern: /(?:血|血清)钾/iu,
    ledgerKeywords: ['钾'],
    itemCodes: ['2823-3'],
    expectsNumeric: true,
  },
  {
    id: 'hemoglobin',
    kind: 'measurement',
    labelZh: '血红蛋白',
    pattern: /血红蛋白/iu,
    excludePattern: /糖化血红蛋白/iu,
    ledgerKeywords: ['血红蛋白'],
    itemCodes: ['718-7'],
    expectsNumeric: true,
  },
]

interface NumericMeasurement {
  readonly value: number
  readonly unit: string | null
  readonly rawMatch: string
}

function roundRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return Number(value.toFixed(4))
}

function normalizeUnitToken(rawUnit: string): string {
  const trimmed = rawUnit.trim().replaceAll('µ', 'u').replaceAll('μ', 'u')
  const lower = trimmed.toLowerCase()
  if (lower === 'mg/dl') return 'mg/dL'
  if (lower === 'umol/l') return 'umol/L'
  if (lower === 'mmol/l') return 'mmol/L'
  if (lower === 'meq/l') return 'mEq/L'
  if (lower === 'g/dl') return 'g/dL'
  if (lower === 'g/l') return 'g/L'
  if (lower === 'ng/l' || lower === 'pg/ml') return 'ng/L'
  if (lower === 'ng/ml' || lower === 'ug/l') return 'ng/mL'
  if (lower === 'iu/l' || lower === 'u/l') return 'U/L'
  if (lower === 'miu/ml') return 'mIU/mL'
  if (lower === '10*9/l' || lower === '10^9/l' || lower === 'x10^9/l' || lower === 'k/ul') return '10*9/L'
  if (lower === '10*12/l' || lower === '10^12/l') return '10*12/L'
  if (lower === 'mm[hg]' || lower === 'mmhg') return 'mmHg'
  if (lower === 'cel' || lower === '°c' || lower === 'c') return 'Cel'
  if (lower === '/min' || lower === 'beats/min' || lower === 'bpm' || lower === 'breaths/min' || lower === '次/分') return '/min'
  if (lower === '%') return '%'
  return trimmed
}

function convertNumericUnit(
  value: number,
  fromUnit: string | null,
  toUnit: string | null,
  canonicalCode: string | null,
): number | null {
  if (fromUnit === null || toUnit === null) {
    return fromUnit === toUnit ? value : null
  }
  const normFrom = normalizeUnitToken(fromUnit)
  const normTo = normalizeUnitToken(toUnit)
  if (normFrom === normTo) return value

  if (canonicalCode === '2160-0') {
    if (normFrom === 'mg/dL' && normTo === 'umol/L') return value * 88.4
    if (normFrom === 'umol/L' && normTo === 'mg/dL') return value / 88.4
  }
  if (canonicalCode === '2093-3' || canonicalCode === '13457-7' || canonicalCode === '2085-9') {
    if (normFrom === 'mmol/L' && normTo === 'mg/dL') return value * 38.67
    if (normFrom === 'mg/dL' && normTo === 'mmol/L') return value / 38.67
  }
  if (canonicalCode === '2571-8') {
    if (normFrom === 'mmol/L' && normTo === 'mg/dL') return value * 88.57
    if (normFrom === 'mg/dL' && normTo === 'mmol/L') return value / 88.57
  }
  if (canonicalCode === '89579-7' || canonicalCode === '10839-9' || canonicalCode === '6597-9' || canonicalCode === '2857-1') {
    if (normFrom === 'ng/mL' && normTo === 'ng/L') return value * 1000
    if (normFrom === 'ng/L' && normTo === 'ng/mL') return value / 1000
  }
  if (canonicalCode === '718-7') {
    if (normFrom === 'g/dL' && normTo === 'g/L') return value * 10
    if (normFrom === 'g/L' && normTo === 'g/dL') return value / 10
  }
  return null
}

function numbersRoughlyEqual(left: number, right: number): boolean {
  const maxAbs = Math.max(Math.abs(left), Math.abs(right))
  return Math.abs(left - right) <= Math.max(1e-4, 0.015 * maxAbs)
}

function extractNumericMeasurementsFromText(text: string): NumericMeasurement[] {
  const results: NumericMeasurement[] = []
  const re = /(\d+(?:\.\d+)?)\s*(mmol\/L|umol\/L|[μµ]mol\/L|mg\/dL|ng\/mL|ng\/L|pg\/mL|ug\/L|g\/dL|g\/L|mEq\/L|mIU\/mL|U\/L|IU\/L|mmHg|\/min|次\/分|bpm|%|mg|g|片|粒|支|年|月|日|天|周|小时|次)?/giu
  const thresholdPrefixRe = /(?:<=|>=|<|>|≤|≥|目标值?为?|参考(?:范围|值)?|正常(?:值|上限)|上限|下限|ULN)\s*$/iu
  const nonLabUnits = new Set(['mg', 'g', '片', '粒', '支', '年', '月', '日', '天', '周', '小时', '次'])

  for (const match of text.matchAll(re)) {
    const rawNum = match[1]
    if (rawNum === undefined) continue
    const idx = match.index ?? 0
    const before = text.slice(Math.max(0, idx - 12), idx)
    if (thresholdPrefixRe.test(before)) continue
    if (idx > 0 && /[-/.A-Za-z0-9]$/u.test(text.slice(idx - 1, idx))) continue

    const rawUnit = match[2] ?? null
    if (rawUnit !== null && nonLabUnits.has(rawUnit.toLowerCase())) continue

    const numericValue = Number(rawNum)
    if (!Number.isFinite(numericValue)) continue
    results.push({
      rawMatch: match[0],
      unit: rawUnit === null ? null : normalizeUnitToken(rawUnit),
      value: numericValue,
    })
  }
  return results
}

function extractFactMeasurements(fact: ClinicalFact): NumericMeasurement[] {
  const candidates: NumericMeasurement[] = []
  const norm = fact.value.normalizedValue
  if (typeof norm === 'number' && Number.isFinite(norm)) {
    candidates.push({ rawMatch: String(norm), unit: null, value: norm })
  } else if (
    norm !== null
    && typeof norm === 'object'
    && 'value' in norm
    && typeof norm.value === 'number'
    && Number.isFinite(norm.value)
  ) {
    candidates.push({
      rawMatch: `${norm.value} ${norm.unit}`,
      unit: normalizeUnitToken(norm.unit),
      value: norm.value,
    })
  }
  for (const parsed of extractNumericMeasurementsFromText(fact.value.rawText)) {
    if (!candidates.some(c => numbersRoughlyEqual(c.value, parsed.value) && c.unit === parsed.unit)) {
      candidates.push(parsed)
    }
  }
  return candidates
}

function doesMeasurementMatchFact(
  claimedValue: number,
  claimedUnit: string | null,
  fact: ClinicalFact,
): boolean {
  const canonicalCode = resolveCanonicalItemCode(fact.itemCode.code)
  for (const candidate of extractFactMeasurements(fact)) {
    if (claimedUnit !== null && candidate.unit !== null) {
      const converted = convertNumericUnit(claimedValue, claimedUnit, candidate.unit, canonicalCode)
      if (converted !== null && numbersRoughlyEqual(converted, candidate.value)) {
        return true
      }
    } else if (numbersRoughlyEqual(claimedValue, candidate.value)) {
      return true
    }
  }
  return false
}

function factTimestampMs(fact: ClinicalFact): number {
  const iso = fact.effectiveAt ?? fact.reportedAt ?? fact.ingestedAt
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : 0
}

function sortFactsMostRecentFirst(facts: readonly ClinicalFact[]): ClinicalFact[] {
  return [...facts].sort((a, b) => {
    const diff = factTimestampMs(b) - factTimestampMs(a)
    if (diff !== 0) return diff
    return b.factId.localeCompare(a.factId)
  })
}

function matchesPattern(text: string, pattern: string): boolean {
  if (text.toLowerCase().includes(pattern.toLowerCase())) {
    return true
  }
  try {
    return new RegExp(pattern, 'iu').test(text)
  } catch {
    return false
  }
}

function collectUniqueSentences(draftText: string, draftFields: Readonly<Record<string, string>>): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  const sources = [draftText, ...Object.values(draftFields)]
  for (const source of sources) {
    for (const rawSentence of source.split(/[。\n；;！？!?]+/u)) {
      const trimmed = rawSentence.trim()
      if (trimmed.length === 0) continue
      const normKey = trimmed.replace(/\s+/gu, '').toLowerCase()
      if (seen.has(normKey)) continue
      seen.add(normKey)
      unique.push(trimmed)
    }
  }
  return unique
}

function collectMatchingClauses(
  sentences: readonly string[],
  patterns: readonly string[],
  verificationCodes: readonly string[] = [],
  ledgerFacts: readonly ClinicalFact[] = [],
): string[] {
  const matched: string[] = []
  const targetCodeSet = buildTargetCodeSet(verificationCodes)
  const matchingSignatures = KNOWN_TEXT_CONCEPT_SIGNATURES.filter(sig => (
    sig.itemCodes.some(code => targetCodeSet.has(code) || targetCodeSet.has(resolveCanonicalItemCode(code)))
  ))
  const factDisplayTerms = ledgerFacts
    .map(fact => fact.itemCode.display.trim())
    .filter(display => display.length >= 2)

  for (const sentence of sentences) {
    const sentenceMatchesPattern = patterns.some(pat => matchesPattern(sentence, pat))
    const clauses = sentence.split(/[，,]+/u).map(c => c.trim()).filter(Boolean)
    let sentenceAddedClause = false

    for (const clause of clauses) {
      const clauseMatchesPattern = patterns.some(pat => matchesPattern(clause, pat))
      const clauseMatchesVerificationConcept = sentenceMatchesPattern && (
        matchingSignatures.some(sig => !sig.excludePattern?.test(clause) && sig.pattern.test(clause))
        || factDisplayTerms.some(term => clause.toLowerCase().includes(term.toLowerCase()))
      )
      if (clauseMatchesPattern || clauseMatchesVerificationConcept) {
        matched.push(clause)
        sentenceAddedClause = true
      }
    }

    if (!sentenceAddedClause && sentenceMatchesPattern) {
      matched.push(sentence)
    }
  }
  return matched
}

function buildTargetCodeSet(itemCodes: readonly string[]): Set<string> {
  return new Set(itemCodes.flatMap(code => [code, resolveCanonicalItemCode(code)]))
}

function findLedgerFactsByItemCodes(ledger: ClinicalFactLedger, itemCodes: readonly string[]): ClinicalFact[] {
  const codeSet = buildTargetCodeSet(itemCodes)
  return ledger.facts.filter(fact => (
    codeSet.has(fact.itemCode.code) || codeSet.has(resolveCanonicalItemCode(fact.itemCode.code))
  ))
}

function factSatisfiesVerificationBounds(
  fact: ClinicalFact,
  verification: NonNullable<AgentScoringRubricItem['factVerification']>,
): boolean {
  if (!fact.eligibleForScoringAndRedLine || fact.presence === 'not-asked') return false
  if (verification.minValue === undefined && verification.maxValue === undefined && verification.unit === undefined) {
    return fact.presence === 'present'
  }
  const canonicalCode = resolveCanonicalItemCode(fact.itemCode.code)
  const measurements = extractFactMeasurements(fact)
  if (measurements.length === 0) return false
  return measurements.some(m => {
    let val = m.value
    if (verification.unit !== undefined && m.unit !== null) {
      const converted = convertNumericUnit(m.value, m.unit, verification.unit, canonicalCode)
      if (converted === null) return false
      val = converted
    }
    if (verification.minValue !== undefined && val < verification.minValue) return false
    if (verification.maxValue !== undefined && val > verification.maxValue) return false
    return true
  })
}

function measurementSatisfiesVerificationBounds(
  measurement: NumericMeasurement,
  verification: NonNullable<AgentScoringRubricItem['factVerification']>,
  canonicalCode: string | null,
): boolean {
  let val = measurement.value
  if (verification.unit !== undefined && measurement.unit !== null) {
    const converted = convertNumericUnit(measurement.value, measurement.unit, verification.unit, canonicalCode)
    if (converted === null) return false
    val = converted
  }
  if (verification.minValue !== undefined && val < verification.minValue) return false
  if (verification.maxValue !== undefined && val > verification.maxValue) return false
  return true
}

function evaluateRubricItemCoverage(
  item: AgentScoringRubricItem,
  ledger: ClinicalFactLedger,
  evaluatedAt: string,
  combinedDraftText: string,
  uniqueSentences: readonly string[],
  structuredClaims: readonly DraftStructuredFactClaim[],
): AgentFactCoverageItem {
  let matchedTriggerFactIds: string[] = []
  if (item.requiredWhenCondition !== undefined) {
    const triggerRes = evaluatePackTrigger(item.requiredWhenCondition, ledger, { asOf: evaluatedAt })
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
        ? findLedgerFactsByItemCodes(ledger, item.factVerification.itemCodes)
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
  const matchingFacts = findLedgerFactsByItemCodes(ledger, verification.itemCodes)
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
  if (hasBoundedCriterion && !factSatisfiesVerificationBounds(latestEligible, verification)) {
    return {
      labelZh: item.labelZh,
      matchedLedgerFactIds: [latestEligible.factId],
      pointsDelta: 0,
      reasonZh: `草稿陈述「${item.labelZh}」，但总账最新有效数值（${latestEligible.value.rawText}）未满足核验区间`,
      rubricItemId: item.id,
      status: 'covered-inaccurate',
    }
  }

  const targetCodes = buildTargetCodeSet(verification.itemCodes)
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
      const matchesAnyEligible = eligibleFacts.some(f => doesMeasurementMatchFact(claim.claimedNumericValue!, claimUnit, f))
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
      const canonicalClaimCode = claim.itemCode ? resolveCanonicalItemCode(claim.itemCode) : null
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
            other.itemCode ? resolveCanonicalItemCode(other.itemCode) : canonicalClaimCode,
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
  )
  const extractedNumbers = matchedClauses.flatMap(clause => extractNumericMeasurementsFromText(clause))
  if (extractedNumbers.length > 0) {
    const qualifyingFacts = hasBoundedCriterion
      ? eligibleFacts.filter(f => factSatisfiesVerificationBounds(f, verification))
      : eligibleFacts
    const targetFactsToMatch = qualifyingFacts.length > 0 ? qualifyingFacts : [latestEligible]
    const anyMatchesQualifying = extractedNumbers.some(num => (
      targetFactsToMatch.some(f => doesMeasurementMatchFact(num.value, num.unit, f))
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
): ClinicalFact[] {
  const codeSet = buildTargetCodeSet(sig.itemCodes)
  return ledger.facts.filter(fact => {
    if (codeSet.size > 0 && (codeSet.has(fact.itemCode.code) || codeSet.has(resolveCanonicalItemCode(fact.itemCode.code)))) {
      return true
    }
    const haystack = `${fact.itemCode.display} ${fact.value.rawText} ${fact.method ?? ''}`.toLowerCase()
    return sig.ledgerKeywords.some(kw => haystack.includes(kw.toLowerCase()))
  })
}

function matchLedgerFactsForStructuredClaim(
  ledger: ClinicalFactLedger,
  claim: DraftStructuredFactClaim,
): ClinicalFact[] {
  if (claim.itemCode !== undefined) {
    const byCode = findLedgerFactsByItemCodes(ledger, [claim.itemCode])
    if (byCode.length > 0) return byCode
  }
  for (const sig of KNOWN_TEXT_CONCEPT_SIGNATURES) {
    if (sig.excludePattern?.test(claim.statementZh)) continue
    if (sig.pattern.test(claim.statementZh)) {
      const matched = matchLedgerFactsForTextSignature(ledger, sig)
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

function detectFabrications(input: {
  fabricationPenaltyPoints: number
  ledger: ClinicalFactLedger
  structuredClaims: readonly DraftStructuredFactClaim[]
  uniqueSentences: readonly string[]
}): AgentFabricationFinding[] {
  const findings: AgentFabricationFinding[] = []
  const coveredSignatureIdsBySentence = new Set<string>()
  const flaggedClaimTexts = new Set<string>()
  const flaggedItemCodes = new Set<string>()

  // Track 1: Explicit structuredClaims emitted alongside or parsed from the Agent draft
  for (const claim of input.structuredClaims) {
    const matchedFacts = matchLedgerFactsForStructuredClaim(input.ledger, claim)
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
        flaggedClaimTexts.add(claim.statementZh.replace(/\s+/gu, '').toLowerCase())
        if (claim.itemCode) flaggedItemCodes.add(resolveCanonicalItemCode(claim.itemCode))
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
      flaggedClaimTexts.add(claim.statementZh.replace(/\s+/gu, '').toLowerCase())
      if (claim.itemCode) flaggedItemCodes.add(resolveCanonicalItemCode(claim.itemCode))
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
      flaggedClaimTexts.add(claim.statementZh.replace(/\s+/gu, '').toLowerCase())
      if (claim.itemCode) flaggedItemCodes.add(resolveCanonicalItemCode(claim.itemCode))
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
      flaggedClaimTexts.add(claim.statementZh.replace(/\s+/gu, '').toLowerCase())
      if (claim.itemCode) flaggedItemCodes.add(resolveCanonicalItemCode(claim.itemCode))
      continue
    }

    if (claim.claimedNumericValue !== undefined) {
      const claimUnit = claim.claimedUnit ? normalizeUnitToken(claim.claimedUnit) : null
      const matchesEligible = eligibleFacts.some(f => doesMeasurementMatchFact(claim.claimedNumericValue!, claimUnit, f))
      if (!matchesEligible) {
        const matchesIneligible = ineligibleFacts.some(f => doesMeasurementMatchFact(claim.claimedNumericValue!, claimUnit, f))
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
        flaggedClaimTexts.add(claim.statementZh.replace(/\s+/gu, '').toLowerCase())
        if (claim.itemCode) flaggedItemCodes.add(resolveCanonicalItemCode(claim.itemCode))
      }
    }
  }

  // Track 2: Deterministic text detection for known exams/labs not backed by ledger
  const assertionMarkerRe = /(?:显示|提示|示|测得|为|达标|正常|异常|升高|降低|回落|阳性|阴性|压低|抬高|狭窄|阻塞|未见(?:明显)?(?:心肌|异常|梗死|水肿|狭窄|病变|出血|积液)|无(?:明显)?(?:异常|狭窄|水肿))/iu
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

      for (const sig of KNOWN_TEXT_CONCEPT_SIGNATURES) {
        if (sig.excludePattern?.test(clause)) continue
        if (!sig.pattern.test(clause)) continue
        if (sig.itemCodes.some(code => flaggedItemCodes.has(resolveCanonicalItemCode(code)))) continue

        const dedupKey = `${normSentence}::${sig.id}`
        if (coveredSignatureIdsBySentence.has(dedupKey)) continue
        coveredSignatureIdsBySentence.add(dedupKey)

        const matchedFacts = matchLedgerFactsForTextSignature(input.ledger, sig)
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

        if (sig.expectsNumeric && clauseMeasurements.length > 0) {
          const allMatchedInEligible = clauseMeasurements.every(num => (
            eligibleFacts.some(f => doesMeasurementMatchFact(num.value, num.unit, f))
          ))
          if (!allMatchedInEligible) {
            const unmatched = clauseMeasurements.filter(num => (
              !eligibleFacts.some(f => doesMeasurementMatchFact(num.value, num.unit, f))
            ))
            const matchesIneligible = unmatched.some(num => (
              ineligibleFacts.some(f => doesMeasurementMatchFact(num.value, num.unit, f))
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

  const parsedInput: EvaluateAgentOutputInput = parsedResult.data
  const evaluatedAt = params.evaluatedAt ?? parsedInput.asOf ?? params.ledger.trace.evaluatedAsOf
  if (Number.isNaN(Date.parse(evaluatedAt))) {
    throw new AgentOutputScorerError('SCORER_INVALID_INPUT', `无效的评测时间 evaluatedAt: ${evaluatedAt}`)
  }

  const effectiveLedger = filterLedgerAtEvaluatedAt(params.ledger, evaluatedAt)

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
    const itemCoverage = evaluateRubricItemCoverage(
      item,
      effectiveLedger,
      evaluatedAt,
      combinedDraftText,
      uniqueSentences,
      parsedInput.structuredClaims,
    )
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
    fabricationPenaltyPoints: parsedInput.rubric.fabricationPenaltyPoints,
    ledger: effectiveLedger,
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
