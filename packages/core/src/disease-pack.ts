import type { ClinicalFact, ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import {
  MANDATORY_FORBIDDEN_PACK_ACTIONS,
  diseasePackSchema,
  effectiveDiseasePackSchema,
  hospitalOverlaySchema,
  type DiseasePack,
  type DiseasePackFactTriggerNode,
  type DiseasePackReadinessItem,
  type DiseasePackStageState,
  type DiseasePackTaskReadinessResult,
  type DiseasePackTimestampField,
  type DiseasePackTriggerNode,
  type EffectiveDiseasePack,
  type HospitalOverlay,
} from '@clinmesh/contracts/disease-pack'
import {
  PUBLIC_VALIDITY_DAYS_BY_ITEM_CODE,
  getPublicValidityDays,
  resolveCanonicalItemCode,
} from './clinical-fact-ledger.ts'

export type DiseasePackErrorCode =
  | 'PACK_CODE_FORBIDDEN'
  | 'PACK_SCHEMA_INVALID'
  | 'PACK_FORMULA_VERSION_NOT_FOUND'
  | 'HOSPITAL_OVERLAY_PACK_MISMATCH'
  | 'HOSPITAL_OVERLAY_SAFETY_RELAXATION_FORBIDDEN'
  | 'TASK_NOT_FOUND_IN_PACK'

export class DiseasePackValidationError extends Error {
  constructor(
    readonly code: DiseasePackErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'DiseasePackValidationError'
  }
}

export interface PlatformFormulaDefinition {
  readonly formulaId: string
  readonly version: number
  readonly titleZh: string
  readonly titleEn: string
  readonly category: 'renal' | 'cardiovascular-risk' | 'lipid'
}

const PLATFORM_FORMULAS: readonly PlatformFormulaDefinition[] = [
  {
    category: 'renal',
    formulaId: 'ckd-epi-2021',
    titleEn: 'CKD-EPI 2021 eGFR',
    titleZh: 'CKD-EPI 2021 估算肾小球滤过率',
    version: 1,
  },
  {
    category: 'renal',
    formulaId: 'cockcroft-gault',
    titleEn: 'Cockcroft-Gault Creatinine Clearance',
    titleZh: 'Cockcroft-Gault 肌酐清除率',
    version: 1,
  },
  {
    category: 'cardiovascular-risk',
    formulaId: 'grace-acs',
    titleEn: 'GRACE ACS Risk Score',
    titleZh: 'GRACE 急性冠脉综合征评分',
    version: 1,
  },
  {
    category: 'cardiovascular-risk',
    formulaId: 'timi-ua-nstemi',
    titleEn: 'TIMI UA/NSTEMI Risk Score',
    titleZh: 'TIMI UA/NSTEMI 危险评分',
    version: 1,
  },
  {
    category: 'cardiovascular-risk',
    formulaId: 'precise-dapt',
    titleEn: 'PRECISE-DAPT Bleeding Score',
    titleZh: 'PRECISE-DAPT 出血风险评分',
    version: 1,
  },
  {
    category: 'lipid',
    formulaId: 'ascvd-ldl-target',
    titleEn: 'ASCVD Risk & LDL-C Goal',
    titleZh: 'ASCVD 危险分层与 LDL-C 目标值',
    version: 1,
  },
]

export const PLATFORM_FORMULA_REGISTRY: ReadonlyMap<string, PlatformFormulaDefinition> = new Map(
  PLATFORM_FORMULAS.map(item => [`${item.formulaId}@${item.version}`, item]),
)

export function hasPlatformFormulaVersion(formulaId: string, version: number): boolean {
  return PLATFORM_FORMULA_REGISTRY.has(`${formulaId}@${version}`)
}

export function listPlatformFormulas(): readonly PlatformFormulaDefinition[] {
  return PLATFORM_FORMULAS
}

const FORBIDDEN_FILENAME_RE = /\.(?:[cm]?[jt]s|jsx|tsx|py|sh|rb|php|pl|exe|dll|so|wasm)$/i
const EXECUTABLE_CODE_PATTERNS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: 'function declaration or expression', re: /\bfunction\b\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\s*)?\(/ },
  { label: 'arrow function syntax', re: /=>/ },
  { label: 'eval call', re: /\beval\s*\(/ },
  { label: 'Function constructor', re: /\bnew\s+Function\b/ },
  { label: 'dynamic import call', re: /\bimport\s*\(/ },
  { label: 'CommonJS require call', re: /\brequire\s*\(/ },
  { label: 'module import/export statement', re: /\b(?:import|export)\s+(?:default\b|const\b|let\b|function\b|class\b|\*|\{)/ },
  { label: 'HTML script tag', re: /<script\b/i },
]

function scanTextForExecutableCode(text: string, sourceLabel: string): void {
  for (const pattern of EXECUTABLE_CODE_PATTERNS) {
    if (pattern.re.test(text)) {
      throw new DiseasePackValidationError(
        'PACK_CODE_FORBIDDEN',
        `Disease pack must be declarative data only; found ${pattern.label} in ${sourceLabel}`,
      )
    }
  }
}

function scanValueForExecutableCode(value: unknown, path: string, seen: Set<object>): void {
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new DiseasePackValidationError(
      'PACK_CODE_FORBIDDEN',
      `Disease pack must contain JSON values only; found ${typeof value} at ${path}`,
    )
  }
  if (typeof value === 'string') {
    scanTextForExecutableCode(value, path)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanValueForExecutableCode(item, `${path}[${index}]`, seen))
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    scanTextForExecutableCode(key, `${path}.<key:${key}>`)
    scanValueForExecutableCode(entry, `${path}.${key}`, seen)
  }
}

export interface PackSourceFileInput {
  readonly filename: string
  readonly content: string
}

/** Reject executable code files, script syntax, or non-JSON values before schema parsing. */
export function scanPackFilesForExecutableCode(files: readonly PackSourceFileInput[]): void {
  for (const file of files) {
    if (FORBIDDEN_FILENAME_RE.test(file.filename.trim())) {
      throw new DiseasePackValidationError(
        'PACK_CODE_FORBIDDEN',
        `Disease pack file ${file.filename} has a forbidden executable extension`,
      )
    }
    scanTextForExecutableCode(file.content, file.filename)
  }
}

/** Parse and strictly validate a declarative Disease Pack and its platform formula references. */
export function validateAndParseDiseasePack(
  rawPack: unknown,
  options?: { files?: readonly PackSourceFileInput[] },
): DiseasePack {
  if (options?.files !== undefined) {
    scanPackFilesForExecutableCode(options.files)
  }
  scanValueForExecutableCode(rawPack, 'pack', new Set())

  const parsed = diseasePackSchema.safeParse(rawPack)
  if (!parsed.success) {
    const issueSummary = parsed.error.issues
      .slice(0, 5)
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')
    throw new DiseasePackValidationError(
      'PACK_SCHEMA_INVALID',
      `Disease pack schema validation failed: ${issueSummary}`,
    )
  }

  const pack = parsed.data
  for (const ref of pack.formulaRefs) {
    if (!hasPlatformFormulaVersion(ref.formulaId, ref.version)) {
      throw new DiseasePackValidationError(
        'PACK_FORMULA_VERSION_NOT_FOUND',
        `Unknown platform formula version referenced by pack ${pack.manifest.id}: ${ref.formulaId}@${ref.version}`,
      )
    }
  }

  return pack
}

export interface PublicLayerPolicyInput {
  readonly validityDaysByItemCode?: Readonly<Record<string, number>>
  readonly examPassThreshold?: number
}

function readOwnNumericRecord(map: Readonly<Record<string, number>> | undefined, key: string): number | undefined {
  return map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined
}

function readOwnTextRecord(map: Readonly<Record<string, string>> | undefined, key: string): string | undefined {
  return map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined
}

function applyTightenedValidityOverrides(
  validityMap: Record<string, number>,
  overrides: ReadonlyArray<{ itemCode: string; maxValidityDays: number }>,
  layerLabel: string,
): void {
  for (const item of overrides) {
    const canonical = resolveCanonicalItemCode(item.itemCode)
    const baseVal = readOwnNumericRecord(validityMap, canonical)
      ?? readOwnNumericRecord(validityMap, item.itemCode)
      ?? getPublicValidityDays(canonical)
    if (baseVal !== null && baseVal !== undefined && item.maxValidityDays > baseVal) {
      throw new DiseasePackValidationError(
        'HOSPITAL_OVERLAY_SAFETY_RELAXATION_FORBIDDEN',
        `${layerLabel} cannot loosen validityDays for ${canonical} from ${baseVal}d to ${item.maxValidityDays}d`,
      )
    }
    validityMap[canonical] = baseVal == null
      ? item.maxValidityDays
      : Math.min(baseVal, item.maxValidityDays)
    if (canonical !== item.itemCode) {
      validityMap[item.itemCode] = validityMap[canonical]!
    }
  }
}

/**
 * Merge publicLayer -> diseasePack -> hospitalOverlay.
 * Localizations replace cleanly, while safety rules may only tighten.
 */
export function mergeThreeLayerPack(input: {
  publicLayer?: PublicLayerPolicyInput | undefined
  diseasePack: DiseasePack
  hospitalOverlay?: unknown
}): EffectiveDiseasePack {
  const pack = input.diseasePack

  let overlay: HospitalOverlay | undefined
  if (input.hospitalOverlay !== undefined) {
    scanValueForExecutableCode(input.hospitalOverlay, 'hospitalOverlay', new Set())
    const parsedOverlay = hospitalOverlaySchema.safeParse(input.hospitalOverlay)
    if (!parsedOverlay.success) {
      const issueSummary = parsedOverlay.error.issues
        .slice(0, 5)
        .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')
      throw new DiseasePackValidationError(
        'PACK_SCHEMA_INVALID',
        `Hospital overlay schema validation failed: ${issueSummary}`,
      )
    }
    overlay = parsedOverlay.data
    if (overlay.packId !== pack.manifest.id) {
      throw new DiseasePackValidationError(
        'HOSPITAL_OVERLAY_PACK_MISMATCH',
        `Hospital overlay packId ${overlay.packId} does not match pack ${pack.manifest.id}`,
      )
    }
  }

  const validityMap: Record<string, number> = {
    ...PUBLIC_VALIDITY_DAYS_BY_ITEM_CODE,
    ...input.publicLayer?.validityDaysByItemCode,
  }

  applyTightenedValidityOverrides(
    validityMap,
    pack.qualityTightenings.validityOverrides,
    `Pack ${pack.manifest.id}`,
  )

  const adjustments = overlay?.safetyAdjustments
  if (adjustments?.redLineRemovals && adjustments.redLineRemovals.length > 0) {
    throw new DiseasePackValidationError(
      'HOSPITAL_OVERLAY_SAFETY_RELAXATION_FORBIDDEN',
      `Hospital overlay ${overlay?.hospitalId} cannot remove red-line rules (${adjustments.redLineRemovals.join(', ')})`,
    )
  }
  if (adjustments?.forbiddenActionRemovals && adjustments.forbiddenActionRemovals.length > 0) {
    throw new DiseasePackValidationError(
      'HOSPITAL_OVERLAY_SAFETY_RELAXATION_FORBIDDEN',
      `Hospital overlay ${overlay?.hospitalId} cannot remove forbidden actions (${adjustments.forbiddenActionRemovals.join(', ')})`,
    )
  }
  if (adjustments?.triggerRemovals && adjustments.triggerRemovals.length > 0) {
    throw new DiseasePackValidationError(
      'HOSPITAL_OVERLAY_SAFETY_RELAXATION_FORBIDDEN',
      `Hospital overlay ${overlay?.hospitalId} cannot remove triggers (${adjustments.triggerRemovals.join(', ')})`,
    )
  }

  if (input.publicLayer?.examPassThreshold !== undefined) {
    const packThreshold = pack.qualityTightenings.examPassThreshold ?? pack.examSuite.passThreshold
    if (packThreshold < input.publicLayer.examPassThreshold || pack.examSuite.passThreshold < input.publicLayer.examPassThreshold) {
      throw new DiseasePackValidationError(
        'HOSPITAL_OVERLAY_SAFETY_RELAXATION_FORBIDDEN',
        `Pack ${pack.manifest.id} cannot lower public examPassThreshold (${input.publicLayer.examPassThreshold})`,
      )
    }
  }

  applyTightenedValidityOverrides(
    validityMap,
    adjustments?.validityOverrides ?? [],
    `Hospital overlay ${overlay?.hospitalId ?? 'unknown'}`,
  )

  const redLineById = new Map(pack.qualityTightenings.redLineRules.map(rule => [rule.id, rule]))
  for (const addition of adjustments?.redLineAdditions ?? []) {
    const existing = redLineById.get(addition.id)
    if (existing !== undefined) {
      if (existing.itemCode !== addition.itemCode || existing.conditionSummary !== addition.conditionSummary) {
        throw new DiseasePackValidationError(
          'HOSPITAL_OVERLAY_SAFETY_RELAXATION_FORBIDDEN',
          `Hospital overlay ${overlay?.hospitalId} cannot weaken or alter existing red-line rule ${addition.id}`,
        )
      }
      continue
    }
    redLineById.set(addition.id, addition)
  }

  const forbiddenActions = [
    ...new Set([
      ...MANDATORY_FORBIDDEN_PACK_ACTIONS,
      ...pack.toolPolicy.forbiddenActions,
      ...(adjustments?.forbiddenActionAdditions ?? []),
    ]),
  ]
  const forbiddenSet = new Set(forbiddenActions)

  const basePassThreshold = Math.max(
    input.publicLayer?.examPassThreshold ?? 0,
    pack.qualityTightenings.examPassThreshold ?? pack.examSuite.passThreshold,
  )
  if (adjustments?.examPassThreshold !== undefined && adjustments.examPassThreshold < basePassThreshold) {
    throw new DiseasePackValidationError(
      'HOSPITAL_OVERLAY_SAFETY_RELAXATION_FORBIDDEN',
      `Hospital overlay ${overlay?.hospitalId} cannot lower examPassThreshold from ${basePassThreshold} to ${adjustments.examPassThreshold}`,
    )
  }
  const effectiveExamPassThreshold = Math.max(basePassThreshold, adjustments?.examPassThreshold ?? 0)

  const effectivePack: DiseasePack = {
    ...pack,
    qualityTightenings: {
      examPassThreshold: effectiveExamPassThreshold,
      redLineRules: [...redLineById.values()],
      validityOverrides: [
        ...pack.qualityTightenings.validityOverrides,
        ...(adjustments?.validityOverrides ?? []),
      ],
    },
    triggers: [...pack.triggers, ...(adjustments?.triggerAdditions ?? [])],
  }

  return effectiveDiseasePackSchema.parse({
    effectiveAllowedTools: pack.toolPolicy.allowedTools.filter(tool => !forbiddenSet.has(tool)),
    effectiveExamPassThreshold,
    effectiveForbiddenActions: forbiddenActions,
    effectiveRedLines: [...redLineById.values()],
    effectiveValidityDaysByItemCode: validityMap,
    ...(overlay === undefined ? {} : { hospitalOverlay: overlay }),
    localizations: overlay?.localizations ?? {},
    pack: effectivePack,
  })
}

export interface TriggerEvaluationOptions {
  readonly asOf?: string
  readonly encounterIdByFactId?: Readonly<Record<string, string>>
  readonly encounterIdByRecordId?: Readonly<Record<string, string>>
}

export interface TriggerEvaluationResult {
  readonly matched: boolean
  readonly matchedFactIds: string[]
  readonly missingReasons: string[]
}

const MS_PER_DAY = 86_400_000

function parseTimestampMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

function readFactTimestampIso(fact: ClinicalFact, field: DiseasePackTimestampField): string | null {
  if (field === 'effectiveAt') return fact.effectiveAt
  if (field === 'reportedAt') return fact.reportedAt
  return fact.ingestedAt
}

function extractNumericFactValue(fact: ClinicalFact): { value: number; unit: string | null } | null {
  const norm = fact.value.normalizedValue
  if (typeof norm === 'number' && Number.isFinite(norm)) {
    return { unit: null, value: norm }
  }
  if (norm !== null && typeof norm === 'object' && 'value' in norm && typeof norm.value === 'number' && Number.isFinite(norm.value)) {
    return { unit: typeof norm.unit === 'string' ? norm.unit : null, value: norm.value }
  }
  return null
}

function resolveEncounterKey(fact: ClinicalFact, field: DiseasePackTimestampField, options?: TriggerEvaluationOptions): string {
  const explicitByFact = readOwnTextRecord(options?.encounterIdByFactId, fact.factId)
  if (explicitByFact) return `enc:${explicitByFact}`
  const explicitByRecord = readOwnTextRecord(options?.encounterIdByRecordId, fact.provenance.recordId)
  if (explicitByRecord) return `enc:${explicitByRecord}`
  const tsIso = readFactTimestampIso(fact, field) ?? fact.ingestedAt
  const ms = parseTimestampMs(tsIso)
  const dayBucket = ms !== null
    ? new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10)
    : tsIso.slice(0, 10)
  return `${fact.provenance.sourceSystemId}::${dayBucket}`
}

function matchesFactLeaf(
  node: DiseasePackFactTriggerNode,
  fact: ClinicalFact,
  asOfMs: number | null,
): boolean {
  if (node.category !== undefined && fact.category !== node.category) return false
  if (node.presence !== fact.presence) return false
  if (node.requireEligible && !fact.eligibleForScoringAndRedLine) return false
  if (node.verificationStatus !== undefined && fact.verificationStatus !== node.verificationStatus) return false

  if (node.itemCodes !== undefined) {
    const normalizedMatches = new Set(node.itemCodes.flatMap(code => [code, resolveCanonicalItemCode(code)]))
    const factCode = fact.itemCode.code
    const canonicalFactCode = resolveCanonicalItemCode(factCode)
    if (!normalizedMatches.has(factCode) && !normalizedMatches.has(canonicalFactCode)) return false
  }
  if (node.itemCodePattern !== undefined) {
    const pattern = new RegExp(node.itemCodePattern)
    if (!pattern.test(fact.itemCode.code) && !pattern.test(resolveCanonicalItemCode(fact.itemCode.code))) return false
  }

  if (node.minValue !== undefined || node.maxValue !== undefined || node.unit !== undefined) {
    const numeric = extractNumericFactValue(fact)
    if (numeric === null) return false
    if (node.unit !== undefined && numeric.unit !== node.unit) return false
    if (node.minValue !== undefined && numeric.value < node.minValue) return false
    if (node.maxValue !== undefined && numeric.value > node.maxValue) return false
  }

  if (node.textPattern !== undefined) {
    const regex = new RegExp(node.textPattern, 'i')
    const candidateText = `${fact.itemCode.display} ${fact.value.rawText}`
    if (!regex.test(candidateText)) return false
  }

  if (node.withinDays !== undefined && node.timestampField !== undefined && asOfMs !== null) {
    const tsMs = parseTimestampMs(readFactTimestampIso(fact, node.timestampField))
    if (tsMs === null || tsMs > asOfMs || (asOfMs - tsMs) > node.withinDays * MS_PER_DAY) {
      return false
    }
  }

  return true
}

/** Pure trigger combinator AST evaluator over ClinicalFactLedger facts. */
export function evaluatePackTrigger(
  node: DiseasePackTriggerNode,
  ledger: ClinicalFactLedger,
  options?: TriggerEvaluationOptions,
): TriggerEvaluationResult {
  const asOfMs = parseTimestampMs(options?.asOf ?? ledger.trace.evaluatedAsOf)

  if (node.kind === 'fact') {
    const matchedFacts = ledger.facts.filter(fact => matchesFactLeaf(node, fact, asOfMs))
    if (matchedFacts.length > 0) {
      return {
        matched: true,
        matchedFactIds: matchedFacts.map(fact => fact.factId),
        missingReasons: [],
      }
    }
    const label = node.itemCodes?.join('/') ?? node.itemCodePattern ?? node.category ?? 'fact'
    return {
      matched: false,
      matchedFactIds: [],
      missingReasons: [`missing:${label}`],
    }
  }

  if (node.kind === 'sequence') {
    const firstResult = evaluatePackTrigger(node.first, ledger, options)
    const thenResult = evaluatePackTrigger(node.then, ledger, options)
    if (!firstResult.matched || !thenResult.matched) {
      return {
        matched: false,
        matchedFactIds: [],
        missingReasons: [...firstResult.missingReasons, ...thenResult.missingReasons],
      }
    }
    const factsById = new Map(ledger.facts.map(fact => [fact.factId, fact]))
    const firstFacts = firstResult.matchedFactIds
      .map(id => factsById.get(id))
      .filter((fact): fact is ClinicalFact => fact !== undefined)
    const thenFacts = thenResult.matchedFactIds
      .map(id => factsById.get(id))
      .filter((fact): fact is ClinicalFact => fact !== undefined)

    for (const firstFact of firstFacts) {
      const firstMs = parseTimestampMs(readFactTimestampIso(firstFact, node.timestampField))
      if (firstMs === null) continue
      const firstEnc = resolveEncounterKey(firstFact, node.timestampField, options)

      for (const thenFact of thenFacts) {
        if (firstFact.factId === thenFact.factId) continue
        const thenMs = parseTimestampMs(readFactTimestampIso(thenFact, node.timestampField))
        if (thenMs === null) continue
        if (node.requireDistinctEncounters === true) {
          const thenEnc = resolveEncounterKey(thenFact, node.timestampField, options)
          if (firstEnc === thenEnc) continue
          if (thenMs < firstMs) continue
        } else if (thenMs <= firstMs) {
          continue
        }
        if (node.maxGapDays !== undefined && (thenMs - firstMs) > node.maxGapDays * MS_PER_DAY) {
          continue
        }
        return {
          matched: true,
          matchedFactIds: [firstFact.factId, thenFact.factId],
          missingReasons: [],
        }
      }
    }
    return {
      matched: false,
      matchedFactIds: [],
      missingReasons: [`sequence-not-satisfied:${node.timestampField}`],
    }
  }

  if (node.kind === 'allOf') {
    const matchedFactIds: string[] = []
    const missingReasons: string[] = []
    let allMatched = true
    for (const child of node.nodes) {
      const res = evaluatePackTrigger(child, ledger, options)
      if (!res.matched) {
        allMatched = false
        missingReasons.push(...res.missingReasons)
      } else {
        matchedFactIds.push(...res.matchedFactIds)
      }
    }
    return allMatched
      ? { matched: true, matchedFactIds: [...new Set(matchedFactIds)], missingReasons: [] }
      : { matched: false, matchedFactIds: [], missingReasons }
  }

  if (node.kind === 'anyOf') {
    const missingReasons: string[] = []
    for (const child of node.nodes) {
      const res = evaluatePackTrigger(child, ledger, options)
      if (res.matched) {
        return res
      }
      missingReasons.push(...res.missingReasons)
    }
    return { matched: false, matchedFactIds: [], missingReasons }
  }

  const inner = evaluatePackTrigger(node.node, ledger, options)
  return inner.matched
    ? { matched: false, matchedFactIds: [], missingReasons: ['negated-condition-matched'] }
    : { matched: true, matchedFactIds: [], missingReasons: [] }
}

export interface PackActivationEvaluation {
  readonly active: boolean
  readonly activationStatus: 'active' | 'inactive' | 'inapplicable'
  readonly activationReason:
    | 'trigger-matched'
    | 'not-triggered'
    | 'manual-enabled'
    | 'manual-disabled'
    | 'inapplicable-population'
    | 'pack-draft'
    | 'pack-retired'
  readonly matchedTriggerIds: string[]
  readonly matchedInapplicableIds: string[]
}

/** Determine whether an effective disease pack is active, inactive, or excluded for this ledger. */
export function evaluatePackActivation(
  effectivePack: EffectiveDiseasePack,
  ledger: ClinicalFactLedger,
  options?: TriggerEvaluationOptions & { manualOverride?: 'enabled' | 'disabled' | null },
): PackActivationEvaluation {
  const matchedInapplicableIds = effectivePack.pack.inapplicablePopulations
    .filter(pop => evaluatePackTrigger(pop.condition, ledger, options).matched)
    .map(pop => pop.id)

  const matchedTriggerIds = effectivePack.pack.triggers
    .filter(trigger => evaluatePackTrigger(trigger.condition, ledger, options).matched)
    .map(trigger => trigger.id)

  if (effectivePack.pack.manifest.status === 'retired') {
    return {
      activationReason: 'pack-retired',
      activationStatus: 'inactive',
      active: false,
      matchedInapplicableIds,
      matchedTriggerIds,
    }
  }

  if (options?.manualOverride === 'disabled') {
    return {
      activationReason: 'manual-disabled',
      activationStatus: 'inactive',
      active: false,
      matchedInapplicableIds,
      matchedTriggerIds,
    }
  }

  if (matchedInapplicableIds.length > 0) {
    return {
      activationReason: 'inapplicable-population',
      activationStatus: 'inapplicable',
      active: false,
      matchedInapplicableIds,
      matchedTriggerIds,
    }
  }

  if (options?.manualOverride === 'enabled') {
    return {
      activationReason: 'manual-enabled',
      activationStatus: 'active',
      active: true,
      matchedInapplicableIds,
      matchedTriggerIds,
    }
  }

  if (effectivePack.pack.manifest.status === 'draft') {
    return {
      activationReason: 'pack-draft',
      activationStatus: 'inactive',
      active: false,
      matchedInapplicableIds,
      matchedTriggerIds,
    }
  }

  if (matchedTriggerIds.length > 0) {
    return {
      activationReason: 'trigger-matched',
      activationStatus: 'active',
      active: true,
      matchedInapplicableIds,
      matchedTriggerIds,
    }
  }

  return {
    activationReason: 'not-triggered',
    activationStatus: 'inactive',
    active: false,
    matchedInapplicableIds,
    matchedTriggerIds,
  }
}

/** Evaluate ordered pathway stages for a pack and determine the highest active stageId. */
export function evaluatePackStages(
  effectivePack: EffectiveDiseasePack,
  ledger: ClinicalFactLedger,
  options?: TriggerEvaluationOptions,
): { currentStageId: string | null; stages: DiseasePackStageState[] } {
  const ordered = [...effectivePack.pack.stages].sort((a, b) => a.order - b.order)
  let currentStageId: string | null = null
  const stages: DiseasePackStageState[] = ordered.map(stage => {
    const res = evaluatePackTrigger(stage.entryCondition, ledger, options)
    if (res.matched) {
      currentStageId = stage.id
    }
    return {
      active: res.matched,
      id: stage.id,
      matchedFactIds: res.matchedFactIds,
      order: stage.order,
      orderSetIds: [...stage.orderSetIds],
      questionnaireItemCodes: [...stage.questionnaireItemCodes],
      taskIds: [...stage.taskIds],
      ...(stage.titleEn === undefined ? {} : { titleEn: stage.titleEn }),
      titleZh: stage.titleZh,
      topicIds: [...stage.topicIds],
    }
  })
  return { currentStageId, stages }
}

function collectCandidateCodesForItem(item: DiseasePackReadinessItem): Set<string> {
  const raw = [item.itemCode, ...(item.alternateItemCodes ?? [])]
  return new Set(raw.flatMap(code => [code, resolveCanonicalItemCode(code)]))
}

function effectiveMaxAgeDaysForItem(
  item: DiseasePackReadinessItem,
  effectiveValidityDaysByItemCode: Readonly<Record<string, number>>,
): number | null {
  const candidates = [item.itemCode, resolveCanonicalItemCode(item.itemCode), ...(item.alternateItemCodes ?? [])]
  let tightened: number | null = item.maxAgeDays ?? null
  for (const code of candidates) {
    const fromLayer = readOwnNumericRecord(effectiveValidityDaysByItemCode, code)
      ?? readOwnNumericRecord(effectiveValidityDaysByItemCode, resolveCanonicalItemCode(code))
    if (fromLayer !== undefined) {
      tightened = tightened === null ? fromLayer : Math.min(tightened, fromLayer)
    }
  }
  return tightened
}

function factWithinAge(
  fact: ClinicalFact,
  maxAgeDays: number | null,
  asOfMs: number | null,
): { valid: boolean; reason?: string } {
  if (maxAgeDays === null || asOfMs === null) return { valid: true }
  const tsIso = fact.effectiveAt ?? fact.reportedAt ?? fact.ingestedAt
  const tsMs = parseTimestampMs(tsIso)
  if (tsMs === null || tsMs > asOfMs || (asOfMs - tsMs) > maxAgeDays * MS_PER_DAY) {
    return { reason: `expired-beyond-${maxAgeDays}d`, valid: false }
  }
  return { valid: true }
}

function evaluateReadinessItem(
  item: DiseasePackReadinessItem,
  ledger: ClinicalFactLedger,
  effectiveValidityDaysByItemCode: Readonly<Record<string, number>>,
  asOfMs: number | null,
): { satisfied: boolean; matchedFactIds: string[]; ineligibleReasons: string[] } {
  const codeSet = collectCandidateCodesForItem(item)
  const matchingFacts = ledger.facts.filter(fact => {
    if (item.category !== undefined && fact.category !== item.category) return false
    const code = fact.itemCode.code
    return codeSet.has(code) || codeSet.has(resolveCanonicalItemCode(code))
  })
  const maxAgeDays = effectiveMaxAgeDaysForItem(item, effectiveValidityDaysByItemCode)
  const eligibleIds: string[] = []
  const ineligibleReasons: string[] = []

  for (const fact of matchingFacts) {
    if (fact.presence === 'not-asked') {
      ineligibleReasons.push('not-asked')
      continue
    }
    if (!fact.eligibleForScoringAndRedLine) {
      ineligibleReasons.push(...(fact.ineligibleReasons.length > 0 ? fact.ineligibleReasons : ['not-eligible']))
      continue
    }
    const ageCheck = factWithinAge(fact, maxAgeDays, asOfMs)
    if (!ageCheck.valid) {
      ineligibleReasons.push(ageCheck.reason!)
      continue
    }
    eligibleIds.push(fact.factId)
  }

  if (eligibleIds.length > 0) {
    return { ineligibleReasons: [], matchedFactIds: eligibleIds, satisfied: true }
  }
  return {
    ineligibleReasons: ineligibleReasons.length > 0 ? [...new Set(ineligibleReasons)] : ['missing'],
    matchedFactIds: [],
    satisfied: false,
  }
}

/** Evaluate 3-tier task readiness (critical vs secondary items; ineligible/unverified facts count as missing). */
export function evaluateTaskReadiness(
  effectivePack: EffectiveDiseasePack,
  taskId: string,
  ledger: ClinicalFactLedger,
  options?: { asOf?: string },
): DiseasePackTaskReadinessResult {
  const declaration = effectivePack.pack.readinessTasks.find(task => task.taskId === taskId)
  if (declaration === undefined) {
    throw new DiseasePackValidationError(
      'TASK_NOT_FOUND_IN_PACK',
      `Task ${taskId} is not declared in disease pack ${effectivePack.pack.manifest.id}`,
    )
  }

  const asOfMs = parseTimestampMs(options?.asOf ?? ledger.trace.evaluatedAsOf)
  const matchedFactIds: string[] = []
  const missingCriticalItems: DiseasePackTaskReadinessResult['missingCriticalItems'] = []
  const missingSecondaryItems: DiseasePackTaskReadinessResult['missingSecondaryItems'] = []

  for (const item of declaration.criticalItems) {
    const res = evaluateReadinessItem(item, ledger, effectivePack.effectiveValidityDaysByItemCode, asOfMs)
    if (res.satisfied) {
      matchedFactIds.push(...res.matchedFactIds)
    } else {
      missingCriticalItems.push({
        ineligibleReasons: res.ineligibleReasons,
        itemCode: item.itemCode,
        labelZh: item.labelZh,
        tier: 'critical',
      })
    }
  }

  for (const item of declaration.secondaryItems) {
    const res = evaluateReadinessItem(item, ledger, effectivePack.effectiveValidityDaysByItemCode, asOfMs)
    if (res.satisfied) {
      matchedFactIds.push(...res.matchedFactIds)
    } else {
      missingSecondaryItems.push({
        ineligibleReasons: res.ineligibleReasons,
        itemCode: item.itemCode,
        labelZh: item.labelZh,
        tier: 'secondary',
      })
    }
  }

  const status: DiseasePackTaskReadinessResult['status'] =
    missingCriticalItems.length > 0
      ? 'missing-critical'
      : missingSecondaryItems.length > 0
        ? 'missing-secondary'
        : 'ready'

  const annotations = status === 'missing-secondary'
    ? missingSecondaryItems.map(item => `缺${item.labelZh}`)
    : []

  return {
    annotations,
    canProceed: status !== 'missing-critical',
    matchedFactIds: [...new Set(matchedFactIds)],
    missingCriticalItems,
    missingSecondaryItems,
    packId: effectivePack.pack.manifest.id,
    status,
    taskId: declaration.taskId,
    titleZh: declaration.titleZh,
  }
}

/** Return all explicitly declared item codes (critical, secondary, alternates, relevantItemCodes) for a task. */
export function collectDeclaredTaskItemCodes(
  effectivePack: EffectiveDiseasePack,
  taskId: string,
): string[] {
  const declaration = effectivePack.pack.readinessTasks.find(task => task.taskId === taskId)
  if (declaration === undefined) {
    throw new DiseasePackValidationError(
      'TASK_NOT_FOUND_IN_PACK',
      `Task ${taskId} is not declared in disease pack ${effectivePack.pack.manifest.id}`,
    )
  }
  const declared = new Set<string>()
  const addCode = (code: string) => {
    declared.add(code)
    declared.add(resolveCanonicalItemCode(code))
  }
  for (const item of [...declaration.criticalItems, ...declaration.secondaryItems]) {
    addCode(item.itemCode)
    for (const alt of item.alternateItemCodes ?? []) addCode(alt)
  }
  for (const code of declaration.relevantItemCodes ?? []) addCode(code)
  return [...declared].sort((a, b) => a.localeCompare(b))
}

/**
 * Narrow ClinicalFactLedger to ONLY the facts required by a specific task (AC32),
 * recalculating summary counts over the scoped subset.
 */
export function filterLedgerForTaskView(
  effectivePack: EffectiveDiseasePack,
  taskId: string,
  ledger: ClinicalFactLedger,
): ClinicalFactLedger {
  const declaration = effectivePack.pack.readinessTasks.find(task => task.taskId === taskId)
  if (declaration === undefined) {
    throw new DiseasePackValidationError(
      'TASK_NOT_FOUND_IN_PACK',
      `Task ${taskId} is not declared in disease pack ${effectivePack.pack.manifest.id}`,
    )
  }

  const allowedCodes = new Set(collectDeclaredTaskItemCodes(effectivePack, taskId))
  const explicitCategoriesWithItems = new Set<ClinicalFact['category']>()
  for (const item of [...declaration.criticalItems, ...declaration.secondaryItems]) {
    if (item.category !== undefined) {
      explicitCategoriesWithItems.add(item.category)
    }
  }
  const allowedWholeCategories = new Set(
    (declaration.relevantCategories ?? []).filter(cat => !explicitCategoriesWithItems.has(cat)),
  )

  const scopedFacts = ledger.facts.filter(fact => (
    allowedCodes.has(fact.itemCode.code)
    || allowedCodes.has(resolveCanonicalItemCode(fact.itemCode.code))
    || allowedWholeCategories.has(fact.category)
  ))

  return {
    ...ledger,
    facts: scopedFacts,
    summary: {
      conflictCount: scopedFacts.filter(f => f.qualityFlags.includes('conflict')).length,
      eligibleCount: scopedFacts.filter(f => f.eligibleForScoringAndRedLine).length,
      expiredCount: scopedFacts.filter(f => f.isExpiredAtAsOf).length,
      externalUnverifiedCount: scopedFacts.filter(f => f.qualityFlags.includes('external-unverified')).length,
      notAskedCount: scopedFacts.filter(f => f.presence === 'not-asked').length,
      supersededCount: scopedFacts.filter(f => f.relation.supersededByFactId !== null).length,
      suspiciousCount: scopedFacts.filter(f => f.qualityFlags.includes('suspicious')).length,
      totalFacts: scopedFacts.length,
      verifiedExternalCount: scopedFacts.filter(f => f.institutionScope === 'external' && f.clinicianVerification.verified).length,
    },
  }
}

/** Pure declarative point-scale evaluator backed by pack data and TriggerNodes. */
export function evaluatePackPointScale(
  scale: NonNullable<DiseasePack['pointScales']>[number],
  ledger: ClinicalFactLedger,
  options?: TriggerEvaluationOptions,
): {
  id: string
  score: number
  bandLabelZh: string | null
  matchedCriteriaIds: string[]
  guidelineCitation: NonNullable<DiseasePack['pointScales']>[number]['guidelineCitation']
} {
  let score = 0
  const matchedCriteriaIds: string[] = []
  for (const criterion of scale.criteria) {
    if (evaluatePackTrigger(criterion.condition, ledger, options).matched) {
      score += criterion.points
      matchedCriteriaIds.push(criterion.id)
    }
  }
  const band = scale.riskBands.find(item => (
    score >= item.minScore && (item.maxScore === null || score <= item.maxScore)
  ))
  return {
    bandLabelZh: band?.labelZh ?? null,
    guidelineCitation: scale.guidelineCitation,
    id: scale.id,
    matchedCriteriaIds,
    score,
  }
}
