import type { AgentScoringRubricItem } from '@clinmesh/contracts/agent-output-scorer'
import type { ClinicalFact, ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import type { ConceptMapping, ConceptNode, ConceptVocabulary } from '@clinmesh/contracts/concept-vocabulary'
import { resolveCanonicalItemCode } from './clinical-fact-ledger.ts'
import { evaluateConceptMappingEligibility, getConceptDescendants } from './concept-vocabulary.ts'

export interface TextConceptSignature {
  readonly id: string
  readonly kind: 'modality' | 'measurement'
  readonly labelZh: string
  readonly pattern: RegExp
  readonly ledgerKeywords: readonly string[]
  readonly itemCodes: readonly string[]
  readonly ledgerLookupCodes: readonly string[]
  readonly expectsNumeric: boolean
  readonly excludePattern?: RegExp
}

export interface NumericMeasurement {
  readonly value: number
  readonly unit: string | null
  readonly rawMatch: string
}

const SCORER_SIGNATURE_DOMAINS = new Set<string>([
  'laboratory',
  'imaging',
  'procedure',
  'examination',
  'vital-sign',
])

const QUANTITATIVE_MEASUREMENT_TERM_RE = /(?:分数|指数|比值|比例|内径|直径|最大径|厚度|面积|容积|流速|压力|压差|间期|时限|波幅|均值|率$|\b(?:fraction|index|ratio|diameter|thickness|area|volume|velocity|pressure|gradient|interval|duration|rate)\b)/iu
const PURE_NUMERIC_CODE_RE = /^\d+(?:[.-]\d+)*$/u
const ASCII_CODE_PAREN_RE = /^[A-Za-z0-9][A-Za-z0-9.+-]{1,31}$/u

const UNIT_TOKEN_ALIASES: ReadonlyMap<string, string> = new Map([
  ['mg/dl', 'mg/dL'],
  ['mg/l', 'mg/L'],
  ['umol/l', 'umol/L'],
  ['mmol/l', 'mmol/L'],
  ['pmol/l', 'pmol/L'],
  ['meq/l', 'mEq/L'],
  ['g/dl', 'g/dL'],
  ['g/l', 'g/L'],
  ['ng/l', 'ng/L'],
  ['pg/ml', 'ng/L'],
  ['ng/ml', 'ng/mL'],
  ['ug/l', 'ng/mL'],
  ['ug/ml', 'ug/mL'],
  ['iu/l', 'U/L'],
  ['u/l', 'U/L'],
  ['miu/ml', 'mIU/mL'],
  ['miu/l', 'mIU/L'],
  ['uiu/ml', 'mIU/L'],
  ['l/l', 'L/L'],
  ['10*9/l', '10*9/L'],
  ['10^9/l', '10*9/L'],
  ['x10^9/l', '10*9/L'],
  ['k/ul', '10*9/L'],
  ['10*12/l', '10*12/L'],
  ['10^12/l', '10*12/L'],
  ['mm[hg]', 'mmHg'],
  ['mmhg', 'mmHg'],
  ['cel', 'Cel'],
  ['°c', 'Cel'],
  ['c', 'Cel'],
  ['/min', '/min'],
  ['beats/min', '/min'],
  ['bpm', '/min'],
  ['breaths/min', '/min'],
  ['次/分', '/min'],
  ['%', '%'],
])

interface UnitConversionRule {
  readonly fromUnit: string
  readonly toUnit: string
  readonly factor: number
}

const UNIVERSAL_UCUM_BASE_RULES: readonly UnitConversionRule[] = [
  { fromUnit: 'g/dL', toUnit: 'g/L', factor: 10 },
  { fromUnit: 'ng/mL', toUnit: 'ng/L', factor: 1000 },
  { fromUnit: 'mg/L', toUnit: 'ng/mL', factor: 1000 },
  { fromUnit: 'mg/L', toUnit: 'ug/mL', factor: 1 },
  { fromUnit: 'ug/mL', toUnit: 'ng/mL', factor: 1000 },
  { fromUnit: 'mg/dL', toUnit: 'mg/L', factor: 10 },
  { fromUnit: 'mIU/mL', toUnit: 'mIU/L', factor: 1000 },
  { fromUnit: '%', toUnit: 'L/L', factor: 0.01 },
]

function buildBidirectionalConversionMap(
  rules: readonly UnitConversionRule[],
): ReadonlyMap<string, number> {
  const map = new Map<string, number>()
  for (const rule of rules) {
    map.set(`${rule.fromUnit}::${rule.toUnit}`, rule.factor)
    map.set(`${rule.toUnit}::${rule.fromUnit}`, 1 / rule.factor)
  }
  return map
}

const UNIVERSAL_UCUM_CONVERSION_MAP = buildBidirectionalConversionMap(UNIVERSAL_UCUM_BASE_RULES)

interface AnalyteConversionEntry {
  readonly canonicalCodes: readonly string[]
  readonly rules: readonly UnitConversionRule[]
}

const ANALYTE_UCUM_CONVERSION_ENTRIES: readonly AnalyteConversionEntry[] = [
  {
    canonicalCodes: ['2160-0'],
    rules: [{ fromUnit: 'mg/dL', toUnit: 'umol/L', factor: 88.4 }],
  },
  {
    canonicalCodes: ['2093-3', '13457-7', '2085-9'],
    rules: [{ fromUnit: 'mmol/L', toUnit: 'mg/dL', factor: 38.67 }],
  },
  {
    canonicalCodes: ['2571-8'],
    rules: [{ fromUnit: 'mmol/L', toUnit: 'mg/dL', factor: 88.57 }],
  },
  {
    canonicalCodes: ['2345-7', '14749-6'],
    rules: [{ fromUnit: 'mmol/L', toUnit: 'mg/dL', factor: 18.016 }],
  },
  {
    canonicalCodes: ['2823-3', '2951-2'],
    rules: [{ fromUnit: 'mmol/L', toUnit: 'mEq/L', factor: 1 }],
  },
]

const ANALYTE_UCUM_CONVERSION_BY_CODE: ReadonlyMap<string, ReadonlyMap<string, number>> = (() => {
  const byCode = new Map<string, ReadonlyMap<string, number>>()
  for (const entry of ANALYTE_UCUM_CONVERSION_ENTRIES) {
    const map = buildBidirectionalConversionMap(entry.rules)
    for (const code of entry.canonicalCodes) {
      byCode.set(code, map)
    }
  }
  return byCode
})()

export function normalizeUnitToken(rawUnit: string): string {
  const trimmed = rawUnit.trim().replaceAll('µ', 'u').replaceAll('μ', 'u')
  return UNIT_TOKEN_ALIASES.get(trimmed.toLowerCase()) ?? trimmed
}

export function convertNumericUnit(
  value: number,
  fromUnit: string | null,
  toUnit: string | null,
  canonicalCodeOrCandidates: string | readonly string[] | null,
): number | null {
  if (fromUnit === null || toUnit === null) {
    return fromUnit === toUnit ? value : null
  }
  const normFrom = normalizeUnitToken(fromUnit)
  const normTo = normalizeUnitToken(toUnit)
  if (normFrom === normTo) return value

  const pairKey = `${normFrom}::${normTo}`
  const universalFactor = UNIVERSAL_UCUM_CONVERSION_MAP.get(pairKey)
  if (universalFactor !== undefined) {
    return value * universalFactor
  }

  const candidateCodes = canonicalCodeOrCandidates === null
    ? []
    : typeof canonicalCodeOrCandidates === 'string'
      ? [canonicalCodeOrCandidates, resolveCanonicalItemCode(canonicalCodeOrCandidates)]
      : canonicalCodeOrCandidates.flatMap(code => [code, resolveCanonicalItemCode(code)])

  for (const code of candidateCodes) {
    const factor = ANALYTE_UCUM_CONVERSION_BY_CODE.get(code)?.get(pairKey)
    if (factor !== undefined) {
      return value * factor
    }
  }
  return null
}

export function numbersRoughlyEqual(left: number, right: number): boolean {
  const maxAbs = Math.max(Math.abs(left), Math.abs(right))
  return Math.abs(left - right) <= Math.max(1e-4, 0.015 * maxAbs)
}

export function extractNumericMeasurementsFromText(text: string): NumericMeasurement[] {
  const results: NumericMeasurement[] = []
  const re = /(\d+(?:\.\d+)?)\s*(mIU\/mL|[uμµ]IU\/mL|mIU\/L|mmol\/L|pmol\/L|[uμµ]mol\/L|mg\/dL|mg\/L|ng\/mL|ng\/L|pg\/mL|[uμµ]g\/mL|[uμµ]g\/L|g\/dL|g\/L|mEq\/L|IU\/L|U\/L|L\/L|mmHg|\/min|次\/分|bpm|°C|%|mg|g|片|粒|支|年|月|日|天|周|小时|次)?/giu
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

export function extractFactMeasurements(fact: ClinicalFact): NumericMeasurement[] {
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

export function doesMeasurementMatchFact(
  claimedValue: number,
  claimedUnit: string | null,
  fact: ClinicalFact,
  equivalentCodes?: readonly string[],
): boolean {
  const candidateCodes = [
    fact.itemCode.code,
    resolveCanonicalItemCode(fact.itemCode.code),
    ...(equivalentCodes ?? []),
  ]
  for (const candidate of extractFactMeasurements(fact)) {
    if (claimedUnit !== null && candidate.unit !== null) {
      const converted = convertNumericUnit(claimedValue, claimedUnit, candidate.unit, candidateCodes)
      if (converted !== null && numbersRoughlyEqual(converted, candidate.value)) {
        return true
      }
    } else if (numbersRoughlyEqual(claimedValue, candidate.value)) {
      return true
    }
  }
  return false
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function normalizeTermKey(term: string): string {
  return term.replace(/\s+/gu, '').toLowerCase()
}

function expandCompositeTerm(rawTerm: string): string[] {
  const trimmed = rawTerm.trim()
  if (trimmed.length === 0) return []
  const expanded = [trimmed]
  const parenMatch = /^(.+?)\s*[（(]([^（）()]+)[）)]\s*$/u.exec(trimmed)
  if (parenMatch) {
    const base = parenMatch[1]?.trim() ?? ''
    const inner = parenMatch[2]?.trim() ?? ''
    if (base.length >= 2) expanded.push(base)
    if (ASCII_CODE_PAREN_RE.test(inner) && /[A-Za-z]/u.test(inner)) {
      expanded.push(inner)
    }
  }
  return expanded
}

function dedupeAndSortTerms(terms: readonly string[]): string[] {
  const byKey = new Map<string, string>()
  for (const raw of terms) {
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    const key = normalizeTermKey(trimmed)
    if (!byKey.has(key)) {
      byKey.set(key, trimmed)
    }
  }
  return [...byKey.values()].sort((left, right) => {
    const lenDiff = normalizeTermKey(right).length - normalizeTermKey(left).length
    if (lenDiff !== 0) return lenDiff
    return left.localeCompare(right)
  })
}

function encodeSegmentPattern(segment: string): string {
  let out = ''
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!
    const prev = i > 0 ? segment[i - 1]! : ''
    const next = i + 1 < segment.length ? segment[i + 1]! : ''
    if (ch === '-' && /[A-Za-z]/u.test(prev) && /[A-Za-z\p{Script=Han}]/u.test(next)) {
      out += '[-\\s]?'
      continue
    }
    if (
      i > 0
      && ((/\p{Script=Han}/u.test(prev) && /[A-Za-z0-9]/u.test(ch))
        || (/[A-Za-z0-9]/u.test(prev) && /\p{Script=Han}/u.test(ch)))
    ) {
      out += '\\s*'
    }
    out += escapeRegExp(ch)
  }
  return out
}

function termToRegexFragment(term: string): string {
  const trimmed = term.trim()
  const segments = trimmed.split(/\s+/u).filter(Boolean)
  let body = ''
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!
    if (i > 0) {
      const prev = segments[i - 1]!
      const prevEndAscii = /[A-Za-z0-9]$/u.test(prev)
      const curStartAscii = /^[A-Za-z0-9]/u.test(segment)
      body += prevEndAscii && curStartAscii ? '\\s+' : '\\s*'
    }
    body += encodeSegmentPattern(segment)
  }
  const startsAsciiAlnum = /^[A-Za-z0-9]/u.test(trimmed)
  const endsAsciiAlnum = /[A-Za-z0-9]$/u.test(trimmed)
  const prefix = startsAsciiAlnum ? '(?<![A-Za-z0-9])' : ''
  const suffix = endsAsciiAlnum ? '(?![A-Za-z0-9])' : ''
  return `${prefix}${body}${suffix}`
}

function compileTermPattern(term: string): RegExp {
  return new RegExp(termToRegexFragment(term), 'iu')
}

function isTextMatchableTerm(term: string): boolean {
  const normalized = term.replace(/\s+/gu, '')
  if (normalized.length < 2) return false
  return !PURE_NUMERIC_CODE_RE.test(normalized)
}

function classifySignatureKind(node: ConceptNode): {
  kind: 'modality' | 'measurement'
  expectsNumeric: boolean
} {
  if (node.domain === 'laboratory' || node.domain === 'vital-sign') {
    return { expectsNumeric: true, kind: 'measurement' }
  }
  if (node.domain === 'examination') {
    const descriptor = `${node.displayZh} ${node.displayEn ?? ''}`
    if (QUANTITATIVE_MEASUREMENT_TERM_RE.test(descriptor)) {
      return { expectsNumeric: true, kind: 'measurement' }
    }
  }
  return { expectsNumeric: false, kind: 'modality' }
}

function computeNodeDepth(code: string, nodeByCode: ReadonlyMap<string, ConceptNode>): number {
  let depth = 0
  const visited = new Set<string>([code])
  let cursor = nodeByCode.get(code)?.parentCode ?? null
  while (cursor !== null && !visited.has(cursor)) {
    visited.add(cursor)
    depth += 1
    cursor = nodeByCode.get(cursor)?.parentCode ?? null
  }
  return depth
}

/**
 * Build bidirectional equivalence groups across approved, exact, effective concept mappings.
 */
export function buildVocabularyExactCodeMap(
  vocabulary: ConceptVocabulary,
  asOfDate?: string,
): ReadonlyMap<string, ReadonlySet<string>> {
  const adjacency = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    let setA = adjacency.get(a)
    if (!setA) {
      setA = new Set()
      adjacency.set(a, setA)
    }
    setA.add(b)
  }

  for (const mapping of vocabulary.mappings) {
    const eligibility = evaluateConceptMappingEligibility(
      mapping,
      asOfDate === undefined ? undefined : { asOfDate },
    )
    if (!eligibility.eligibleForScoreAndRedLine) continue
    link(mapping.sourceCode, mapping.targetConceptCode)
    link(mapping.targetConceptCode, mapping.sourceCode)
  }

  const visited = new Set<string>()
  const groups = new Map<string, ReadonlySet<string>>()
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue
    const cluster = new Set<string>([start])
    const queue = [start]
    visited.add(start)
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) continue
        visited.add(neighbor)
        cluster.add(neighbor)
        queue.push(neighbor)
      }
    }
    for (const member of cluster) {
      groups.set(member, cluster)
    }
  }
  return groups
}

/**
 * Derive text concept extraction signatures purely from active ConceptVocabulary nodes
 * in clinical measurement/modality domains plus approved exact effective mappings.
 */
export function buildTextConceptSignaturesFromVocabulary(
  vocabulary: ConceptVocabulary,
  options?: { asOfDate?: string },
): TextConceptSignature[] {
  const asOfDate = options?.asOfDate
  const nodeByCode = new Map(vocabulary.nodes.map(node => [node.code, node]))
  const mappingsByTarget = new Map<string, ConceptMapping[]>()

  for (const mapping of vocabulary.mappings) {
    const eligibility = evaluateConceptMappingEligibility(
      mapping,
      asOfDate === undefined ? undefined : { asOfDate },
    )
    if (!eligibility.eligibleForScoreAndRedLine) continue
    const list = mappingsByTarget.get(mapping.targetConceptCode) ?? []
    list.push(mapping)
    mappingsByTarget.set(mapping.targetConceptCode, list)
  }

  const activeNodes = vocabulary.nodes.filter(node => SCORER_SIGNATURE_DOMAINS.has(node.domain))

  interface PreparedNodeEntry {
    readonly node: ConceptNode
    readonly textTerms: readonly string[]
    readonly ledgerKeywords: readonly string[]
    readonly ownItemCodes: readonly string[]
    readonly ledgerLookupCodes: readonly string[]
    readonly kind: 'modality' | 'measurement'
    readonly expectsNumeric: boolean
    readonly depth: number
  }

  const prepared: PreparedNodeEntry[] = []

  for (const node of activeNodes) {
    const eligibleMappings = mappingsByTarget.get(node.code) ?? []
    const rawTerms = [
      node.displayZh,
      ...(node.displayEn === undefined ? [] : [node.displayEn]),
      ...node.synonyms,
      node.code,
      ...eligibleMappings.flatMap(mapping => [mapping.sourceDisplay, mapping.sourceCode]),
    ]
    const expandedTerms = rawTerms.flatMap(expandCompositeTerm)
    const ledgerKeywords = dedupeAndSortTerms(expandedTerms.filter(t => t.trim().length >= 2))
    const textTerms = dedupeAndSortTerms(expandedTerms.filter(isTextMatchableTerm))
    if (textTerms.length === 0) continue

    const ownItemCodes = [...new Set([
      node.code,
      ...eligibleMappings.map(mapping => mapping.sourceCode),
    ])]
    const descendantCodes = getConceptDescendants(node.code, vocabulary)
    const descendantMappedCodes = descendantCodes.flatMap(descCode => (
      (mappingsByTarget.get(descCode) ?? []).map(mapping => mapping.sourceCode)
    ))
    const ledgerLookupCodes = [...new Set([
      ...ownItemCodes,
      ...descendantCodes,
      ...descendantMappedCodes,
    ])]
    const { kind, expectsNumeric } = classifySignatureKind(node)

    prepared.push({
      depth: computeNodeDepth(node.code, nodeByCode),
      expectsNumeric,
      kind,
      ledgerKeywords,
      ledgerLookupCodes,
      node,
      ownItemCodes,
      textTerms,
    })
  }

  const signatures: Array<TextConceptSignature & { depth: number; maxTermLen: number }> = []

  for (const entry of prepared) {
    const compiledTermPatterns = entry.textTerms.map(term => ({
      norm: normalizeTermKey(term),
      pattern: compileTermPattern(term),
    }))
    const ownNormSet = new Set(compiledTermPatterns.map(item => item.norm))

    const excludeCandidates: string[] = []
    for (const other of prepared) {
      if (other.node.code === entry.node.code) continue
      for (const otherTerm of other.textTerms) {
        const otherNorm = normalizeTermKey(otherTerm)
        if (ownNormSet.has(otherNorm)) continue
        if (compiledTermPatterns.some(item => item.pattern.test(otherTerm) || item.pattern.test(otherTerm.replace(/\s+/gu, '')))) {
          excludeCandidates.push(otherTerm)
        }
      }
    }

    const excludeTerms = dedupeAndSortTerms(excludeCandidates)
    const pattern = new RegExp(entry.textTerms.map(termToRegexFragment).join('|'), 'iu')
    const excludePattern = excludeTerms.length > 0
      ? new RegExp(excludeTerms.map(termToRegexFragment).join('|'), 'iu')
      : undefined
    const maxTermLen = normalizeTermKey(entry.textTerms[0]!).length

    signatures.push({
      depth: entry.depth,
      expectsNumeric: entry.expectsNumeric,
      ...(excludePattern === undefined ? {} : { excludePattern }),
      id: entry.node.code,
      itemCodes: entry.ownItemCodes,
      kind: entry.kind,
      labelZh: entry.node.displayZh,
      ledgerKeywords: entry.ledgerKeywords,
      ledgerLookupCodes: entry.ledgerLookupCodes,
      maxTermLen,
      pattern,
    })
  }

  signatures.sort((left, right) => (
    right.depth - left.depth
    || right.maxTermLen - left.maxTermLen
    || left.id.localeCompare(right.id)
  ))

  return signatures.map(({ depth: _depth, maxTermLen: _maxTermLen, ...sig }) => sig)
}

export function findSignatureMatchIndexInText(sig: TextConceptSignature, text: string): number {
  const firstMatch = sig.pattern.exec(text)
  if (firstMatch === null) return -1
  if (sig.excludePattern === undefined) return firstMatch.index
  const stripped = text.replace(
    new RegExp(sig.excludePattern.source, 'giu'),
    match => ' '.repeat(match.length),
  )
  const match = sig.pattern.exec(stripped)
  return match === null ? -1 : match.index
}

export function matchesTextConceptSignature(sig: TextConceptSignature, text: string): boolean {
  return findSignatureMatchIndexInText(sig, text) !== -1
}

export function matchesLedgerFactKeywords(sig: TextConceptSignature, haystack: string): boolean {
  if (matchesTextConceptSignature(sig, haystack)) return true
  return sig.ledgerKeywords.some(kw => {
    const trimmed = kw.trim()
    if (!PURE_NUMERIC_CODE_RE.test(trimmed) || trimmed.length < 2) return false
    const boundary = new RegExp(`(?<![A-Za-z0-9.-])${escapeRegExp(trimmed)}(?![A-Za-z0-9.-])`, 'iu')
    return boundary.test(haystack)
  })
}

export function factTimestampMs(fact: ClinicalFact): number {
  const iso = fact.effectiveAt ?? fact.reportedAt ?? fact.ingestedAt
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : 0
}

export function sortFactsMostRecentFirst(facts: readonly ClinicalFact[]): ClinicalFact[] {
  return [...facts].sort((a, b) => {
    const diff = factTimestampMs(b) - factTimestampMs(a)
    if (diff !== 0) return diff
    return b.factId.localeCompare(a.factId)
  })
}

export function matchesPattern(text: string, pattern: string): boolean {
  if (text.toLowerCase().includes(pattern.toLowerCase())) {
    return true
  }
  try {
    return new RegExp(pattern, 'iu').test(text)
  } catch {
    return false
  }
}

export function collectUniqueSentences(
  draftText: string,
  draftFields: Readonly<Record<string, string>>,
): string[] {
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

export function buildTargetCodeSet(
  itemCodes: readonly string[],
  exactCodeMap: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): Set<string> {
  const codes = new Set<string>()
  for (const code of itemCodes) {
    codes.add(code)
    const canonical = resolveCanonicalItemCode(code)
    codes.add(canonical)
    for (const eq of exactCodeMap.get(code) ?? []) codes.add(eq)
    for (const eq of exactCodeMap.get(canonical) ?? []) codes.add(eq)
  }
  return codes
}

export function findLedgerFactsByItemCodes(
  ledger: ClinicalFactLedger,
  itemCodes: readonly string[],
  exactCodeMap: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): ClinicalFact[] {
  const codeSet = buildTargetCodeSet(itemCodes, exactCodeMap)
  return ledger.facts.filter(fact => (
    codeSet.has(fact.itemCode.code) || codeSet.has(resolveCanonicalItemCode(fact.itemCode.code))
  ))
}

export function collectMatchingClauses(
  sentences: readonly string[],
  patterns: readonly string[],
  verificationCodes: readonly string[] = [],
  ledgerFacts: readonly ClinicalFact[] = [],
  signatures: readonly TextConceptSignature[] = [],
  exactCodeMap: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): string[] {
  const matched: string[] = []
  const targetCodeSet = buildTargetCodeSet(verificationCodes, exactCodeMap)
  const matchingSignatures = signatures.filter(sig => (
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
        matchingSignatures.some(sig => matchesTextConceptSignature(sig, clause))
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

export function factSatisfiesVerificationBounds(
  fact: ClinicalFact,
  verification: NonNullable<AgentScoringRubricItem['factVerification']>,
  exactCodeMap: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): boolean {
  if (!fact.eligibleForScoringAndRedLine || fact.presence === 'not-asked') return false
  if (verification.minValue === undefined && verification.maxValue === undefined && verification.unit === undefined) {
    return fact.presence === 'present'
  }
  const candidateCodes = [...buildTargetCodeSet([fact.itemCode.code], exactCodeMap)]
  const measurements = extractFactMeasurements(fact)
  if (measurements.length === 0) return false
  return measurements.some(m => {
    let val = m.value
    if (verification.unit !== undefined && m.unit !== null) {
      const converted = convertNumericUnit(m.value, m.unit, verification.unit, candidateCodes)
      if (converted === null) return false
      val = converted
    }
    if (verification.minValue !== undefined && val < verification.minValue) return false
    if (verification.maxValue !== undefined && val > verification.maxValue) return false
    return true
  })
}

export function measurementSatisfiesVerificationBounds(
  measurement: NumericMeasurement,
  verification: NonNullable<AgentScoringRubricItem['factVerification']>,
  candidateCodes: readonly string[],
): boolean {
  let val = measurement.value
  if (verification.unit !== undefined && measurement.unit !== null) {
    const converted = convertNumericUnit(measurement.value, measurement.unit, verification.unit, candidateCodes)
    if (converted === null) return false
    val = converted
  }
  if (verification.minValue !== undefined && val < verification.minValue) return false
  if (verification.maxValue !== undefined && val > verification.maxValue) return false
  return true
}
