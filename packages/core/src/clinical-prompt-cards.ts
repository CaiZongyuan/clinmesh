import type { ClinicalFact, ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import {
  type ClinicalPromptCard,
  type ClinicalPromptDiffStatus,
  type ClinicalPromptFactVersionRef,
  type ClinicalPromptReevaluateDiff,
  type ClinicalPromptRiskTag,
  type ClinicalPromptSafetyBlock,
  type ClinicalPromptSideBySideGroup,
  type ClinicalPromptSuggestion,
  type ClinicalPromptTiming,
  clinicalPromptCardSchema,
} from '@clinmesh/contracts/clinical-prompt-cards'
import {
  clinicalOverrideReasonSchema,
  type ClinicalQualityCheck,
} from '@clinmesh/contracts/clinical-quality'
import type { ConceptVocabulary } from '@clinmesh/contracts/concept-vocabulary'
import {
  MANDATORY_FORBIDDEN_PACK_ACTIONS,
  type DiseasePackRiskTag,
  type DiseasePackRuntimeEntry,
  type EffectiveDiseasePack,
} from '@clinmesh/contracts/disease-pack'
import {
  SIMULATION_TRIAL_DISCLAIMER_ZH,
  type EvaluatedKnowledgeClaim,
  type KnowledgeVersionComparison,
} from '@clinmesh/contracts/knowledge-claims'
import type { MedicationSafetyRule } from '@clinmesh/contracts/medication-safety'
import {
  classDuplicationFindings,
  doseLimitFindings,
  renalMedicationFindings,
  type QualityMedication,
  type RenalFunctionFact,
} from './clinical-quality.ts'
import {
  evaluatePackExit,
  evaluatePackPointScale,
  evaluatePackTrigger,
  type TriggerEvaluationOptions,
} from './disease-pack.ts'
import {
  compareKnowledgeEvaluations,
  evaluateKnowledgeSnapshotForPatient,
  verifyKnowledgeAnchor,
  type KnowledgePassageVerifier,
} from './knowledge-claims.ts'
import { medicationCombinationConflict } from './medication-safety.ts'

export interface PromptMedicationDescriptor {
  allergenCodes?: readonly string[] | undefined
  catalogItemId: string
  code?: string | undefined
  display: string
  doseLimits?: MedicationSafetyRule['doseLimits'] | undefined
  doseText?: string | undefined
  frequencyCode?: string | undefined
  medicationKey?: string | undefined
  pharmacologyClasses: readonly string[]
}

export interface SafetyFilterInput {
  activeMedications?: readonly QualityMedication[] | undefined
  allergyCodes?: ReadonlySet<string> | undefined
  cards: readonly ClinicalPromptCard[]
  effectivePacks: readonly EffectiveDiseasePack[]
  evaluatedEntries?: readonly DiseasePackRuntimeEntry[] | undefined
  inapplicablePackIds?: ReadonlySet<string> | undefined
  ledger: ClinicalFactLedger
  medicationCandidatesByCardId?: ReadonlyMap<string, readonly PromptMedicationDescriptor[]> | undefined
  medicationCatalog?: ReadonlyMap<string, PromptMedicationDescriptor> | undefined
  renal?: RenalFunctionFact | undefined
  retiredOrInactiveClaimIds?: ReadonlySet<string> | undefined
  verifySourcePassage?: KnowledgePassageVerifier | undefined
}

export interface SafetyFilterResult {
  blockedRecords: ClinicalPromptSafetyBlock[]
  visibleCards: ClinicalPromptCard[]
}

const PRESERVED_CATEGORIES_FOR_INAPPLICABLE = new Set<ClinicalPromptCard['category']>([
  'rule-out-checklist',
  'missing-fact',
  'inapplicable-population',
  'exit-summary',
])

const NON_INTERVENTION_DIAGNOSTIC_CATEGORIES = new Set<ClinicalPromptCard['category']>([
  'quality-gate',
  'rule-out-checklist',
  'missing-fact',
  'inapplicable-population',
  'exit-summary',
  'longitudinal-comparison',
  'recognition',
  'phenotype-candidate',
])

const RETIRED_OR_DEACTIVATED_KNOWLEDGE_STATUSES = new Set<ClinicalPromptCard['knowledgeStatus']>([
  'retracted',
  'superseded',
  'retired',
  'rejected',
  'draft',
  'imported',
])

const AUTONOMOUS_FORBIDDEN_PATTERN = /自动开药|直接代开|直接签发病历|自动签署|autonomous-treatment-decision|auto-prescribe-medication|sign-clinical-document/i

function isFactSupersededOrInvalid(fact: ClinicalFact): boolean {
  return fact.relation.supersededByFactId !== null || fact.recordStatus === 'entered-in-error'
}

function isFactExternalUnverified(fact: ClinicalFact): boolean {
  return fact.institutionScope === 'external'
    && (fact.qualityFlags.includes('external-unverified') || !fact.clinicianVerification.verified)
}

function collectConfirmedAllergyTokens(
  ledger: ClinicalFactLedger,
  allergyCodes?: ReadonlySet<string>,
): Set<string> {
  const tokens = new Set<string>()
  if (allergyCodes) {
    for (const code of allergyCodes) {
      const normalized = code.trim().toLowerCase()
      if (normalized.length > 0) tokens.add(normalized)
    }
  }
  for (const fact of ledger.facts) {
    if (fact.category !== 'allergy' || fact.presence !== 'present' || isFactSupersededOrInvalid(fact)) continue
    if (fact.itemCode.code.trim().length > 0) tokens.add(fact.itemCode.code.trim().toLowerCase())
    if (fact.itemCode.display.trim().length > 0) tokens.add(fact.itemCode.display.trim().toLowerCase())
    if (fact.value.rawText.trim().length > 0) tokens.add(fact.value.rawText.trim().toLowerCase())
  }
  return tokens
}

function resolveSuggestionMedicationDescriptors(
  suggestion: ClinicalPromptSuggestion,
  medicationCatalog?: ReadonlyMap<string, PromptMedicationDescriptor>,
): PromptMedicationDescriptor[] {
  const results: PromptMedicationDescriptor[] = []
  const byCatalog = suggestion.catalogItemId ? medicationCatalog?.get(suggestion.catalogItemId) : undefined
  const byKey = suggestion.medicationKey ? medicationCatalog?.get(suggestion.medicationKey) : undefined
  const base = byCatalog ?? byKey
  if (base) {
    results.push({
      ...base,
      ...(suggestion.doseText === undefined ? {} : { doseText: suggestion.doseText }),
      ...(suggestion.frequencyCode === undefined ? {} : { frequencyCode: suggestion.frequencyCode }),
      ...(suggestion.candidateClasses === undefined
        ? {}
        : { pharmacologyClasses: [...new Set([...base.pharmacologyClasses, ...suggestion.candidateClasses])] }),
    })
    return results
  }
  if (
    suggestion.actionKind === 'draft-medication'
    || suggestion.medicationKey !== undefined
    || (suggestion.candidateClasses !== undefined && suggestion.candidateClasses.length > 0)
  ) {
    results.push({
      allergenCodes: [
        ...(suggestion.catalogItemId ? [suggestion.catalogItemId] : []),
        ...(suggestion.medicationKey ? [suggestion.medicationKey] : []),
        ...(suggestion.itemCodes ?? []),
      ],
      catalogItemId: suggestion.catalogItemId ?? suggestion.medicationKey ?? suggestion.id,
      ...(suggestion.itemCodes?.[0] === undefined ? {} : { code: suggestion.itemCodes[0] }),
      display: suggestion.labelZh,
      ...(suggestion.doseText === undefined ? {} : { doseText: suggestion.doseText }),
      ...(suggestion.frequencyCode === undefined ? {} : { frequencyCode: suggestion.frequencyCode }),
      ...(suggestion.medicationKey === undefined ? {} : { medicationKey: suggestion.medicationKey }),
      pharmacologyClasses: suggestion.candidateClasses ?? [],
    })
  }
  return results
}

function descriptorMatchesAllergy(
  descriptor: PromptMedicationDescriptor,
  allergyTokens: ReadonlySet<string>,
): boolean {
  if (allergyTokens.size === 0) return false
  const candidates = [
    descriptor.catalogItemId,
    descriptor.code,
    descriptor.medicationKey,
    ...(descriptor.allergenCodes ?? []),
    ...descriptor.pharmacologyClasses,
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    if (allergyTokens.has(candidate.trim().toLowerCase())) return true
  }
  const displayLower = descriptor.display.toLowerCase()
  for (const token of allergyTokens) {
    if (token.length >= 2 && (displayLower.includes(token) || token.includes(displayLower))) return true
  }
  return false
}

function checkDescriptorRedLines(
  descriptors: readonly PromptMedicationDescriptor[],
  input: {
    activeMedications: readonly QualityMedication[]
    renal?: RenalFunctionFact | undefined
  },
): string | null {
  if (descriptors.length === 0) return null
  const qualityMeds: QualityMedication[] = descriptors.map(d => ({
    catalogItemId: d.catalogItemId,
    display: d.display,
    doseLimits: d.doseLimits,
    doseText: d.doseText,
    frequencyCode: d.frequencyCode,
    pharmacologyClasses: d.pharmacologyClasses,
  }))
  if (input.renal) {
    const renal = renalMedicationFindings(qualityMeds, input.renal)
    if (renal.redLines.length > 0) return renal.redLines.map(r => r.message).join('；')
  }
  const dose = doseLimitFindings(qualityMeds)
  if (dose.length > 0) return dose.map(r => r.message).join('；')

  const dup = classDuplicationFindings(qualityMeds, input.activeMedications)
  if (dup.length > 0) return dup.map(r => r.message).join('；')

  // Guard class duplication inside active meds even when only pharmacology classes were tagged on suggestion
  for (const candidate of qualityMeds) {
    if (candidate.pharmacologyClasses.length === 0) continue
    for (const active of input.activeMedications) {
      if (medicationCombinationConflict(candidate.pharmacologyClasses, active.pharmacologyClasses)) {
        return `药品组合存在药理类别互斥：${candidate.display}与${active.display}不能叠加开立。`
      }
    }
  }
  return null
}

function findUnverifiedExternalFactViolation(
  card: ClinicalPromptCard,
  ledger: ClinicalFactLedger,
): string | null {
  if (NON_INTERVENTION_DIAGNOSTIC_CATEGORIES.has(card.category)) return null
  if (card.suggestions.some(s => s.actionKind === 'verify-external-fact')) return null
  const factsById = new Map(ledger.facts.map(f => [f.factId, f]))
  for (const ref of card.basedOnFactVersions) {
    const fact = factsById.get(ref.factId)
    if (!fact) continue
    if (isFactExternalUnverified(fact)) {
      return `卡片“${card.summary}”将未经本院形式核实的外院事实（${fact.itemCode.display}）当作已确认依据`
    }
  }
  return null
}

function collectInapplicablePackIds(input: SafetyFilterInput): Set<string> {
  const result = new Set<string>(input.inapplicablePackIds ?? [])
  for (const entry of input.evaluatedEntries ?? []) {
    if (entry.activationStatus === 'inapplicable' || entry.matchedInapplicableIds.length > 0) {
      result.add(entry.packId)
    }
  }
  for (const effective of input.effectivePacks) {
    for (const rule of effective.pack.inapplicablePopulations) {
      if (evaluatePackTrigger(rule.condition, input.ledger).matched) {
        result.add(effective.pack.manifest.id)
      }
    }
  }
  return result
}

function checkPackForbiddenActions(
  card: ClinicalPromptCard,
  effectivePacks: readonly EffectiveDiseasePack[],
): { detailZh: string; ruleId: string } | null {
  const matchingPack = card.packId === null
    ? undefined
    : effectivePacks.find(p => p.pack.manifest.id === card.packId)
  const forbiddenActions = new Set<string>(
    matchingPack
      ? matchingPack.effectiveForbiddenActions
      : [...MANDATORY_FORBIDDEN_PACK_ACTIONS, ...effectivePacks.flatMap(p => [...p.effectiveForbiddenActions])],
  )

  for (const suggestion of card.suggestions) {
    if (!suggestion.isDraftOnly) {
      return {
        detailZh: `建议“${suggestion.labelZh}”未标记为草稿限制，违反禁止自动写入边界`,
        ruleId: 'safety:draft-only-violation',
      }
    }
    if (forbiddenActions.has(suggestion.id) || forbiddenActions.has(suggestion.actionKind)) {
      return {
        detailZh: `建议“${suggestion.labelZh}”命中专病包禁用动作策略`,
        ruleId: `safety:forbidden-action:${suggestion.id}`,
      }
    }
    if (AUTONOMOUS_FORBIDDEN_PATTERN.test(suggestion.labelZh)) {
      return {
        detailZh: `建议“${suggestion.labelZh}”包含禁止的自主医疗/自动处方动作`,
        ruleId: 'safety:autonomous-forbidden-action',
      }
    }
  }

  for (const forbidden of forbiddenActions) {
    if (card.cardId === forbidden || card.cardId.endsWith(`:${forbidden}`)) {
      return {
        detailZh: `提示卡“${card.summary}”命中专病包禁用动作 ${forbidden}`,
        ruleId: `safety:forbidden-action:${forbidden}`,
      }
    }
  }
  if (AUTONOMOUS_FORBIDDEN_PATTERN.test(`${card.summary} ${card.detail}`)) {
    return {
      detailZh: `提示卡“${card.summary}”触发强制禁用动作边界`,
      ruleId: 'safety:autonomous-forbidden-action',
    }
  }
  return null
}

/**
 * 展示前确定性安全过滤器（严格 0 模型调用，table-driven 拦截后写入审计，严禁泄露给展示或 Agent）：
 * 1. 药物过敏冲突（allergy-conflict）
 * 2. 平台或专病包红线违规（red-line-violation：eGFR < 30 禁用、极量越界、药理重复、缺项红线）
 * 3. 专病包禁用动作（forbidden-action：auto-prescribe / sign-clinical-document / autonomous-treatment-decision 等）
 * 4. 不适用人群（inapplicable-population：拦截治疗/用药/建议卡，保留排除清单、缺项提示与不适用边界声明）
 * 5. 退役/无效证据或未核实外院关键事实当已确认使用（invalid-citation）
 */
export function filterPromptCardsBeforeDisplay(input: SafetyFilterInput): SafetyFilterResult {
  const allergyTokens = collectConfirmedAllergyTokens(input.ledger, input.allergyCodes)
  const inapplicablePackIds = collectInapplicablePackIds(input)
  const packById = new Map(input.effectivePacks.map(p => [p.pack.manifest.id, p]))
  const activeMedications = input.activeMedications ?? []

  const visibleCards: ClinicalPromptCard[] = []
  const blockedRecords: ClinicalPromptSafetyBlock[] = []

  const recordCardBlock = (
    card: ClinicalPromptCard,
    blockedReason: ClinicalPromptSafetyBlock['blockedReason'],
    ruleId: string,
    detailZh: string,
    suggestionIds: string[] = card.suggestions.map(s => s.id),
  ) => {
    blockedRecords.push({
      blockedReason,
      cardId: card.cardId,
      cardSummary: card.summary,
      detailZh,
      packId: card.packId,
      ruleId,
      suggestionIds,
      timing: card.timing,
    })
  }

  for (const rawCard of input.cards) {
    // Table rule 1: Invalid / withdrawn citation / unverified external critical fact
    if (
      RETIRED_OR_DEACTIVATED_KNOWLEDGE_STATUSES.has(rawCard.knowledgeStatus)
      || rawCard.status === 'retired'
    ) {
      recordCardBlock(
        rawCard,
        'invalid-citation',
        'safety:withdrawn-knowledge-status',
        `提示卡“${rawCard.summary}”依赖已停用或未发布知识状态（${rawCard.knowledgeStatus}），已被安全过滤拦截`,
      )
      continue
    }
    if (rawCard.source.claimId && input.retiredOrInactiveClaimIds?.has(rawCard.source.claimId)) {
      recordCardBlock(
        rawCard,
        'invalid-citation',
        `safety:deactivated-claim:${rawCard.source.claimId}`,
        `提示卡“${rawCard.summary}”引用已退役或停用的知识条款 ${rawCard.source.claimId}，已被安全过滤拦截`,
      )
      continue
    }
    if (rawCard.source.citation && input.verifySourcePassage) {
      const verified = verifyKnowledgeAnchor(rawCard.source.citation, input.verifySourcePassage)
      if (!verified.valid) {
        recordCardBlock(
          rawCard,
          'invalid-citation',
          `safety:invalid-citation:${verified.reason ?? 'anchor-mismatch'}`,
          `提示卡“${rawCard.summary}”原文锚点校验失败（${verified.reason ?? 'anchor-mismatch'}），禁止展示`,
        )
        continue
      }
    }
    if (rawCard.category === 'guideline-advice' && !rawCard.source.citation && !rawCard.source.claimId && !rawCard.source.topicId) {
      recordCardBlock(
        rawCard,
        'invalid-citation',
        'safety:missing-guideline-citation',
        `指南建议卡“${rawCard.summary}”缺少有效知识条款或原文锚点引用`,
      )
      continue
    }
    const unverifiedExternalViolation = findUnverifiedExternalFactViolation(rawCard, input.ledger)
    if (unverifiedExternalViolation !== null) {
      recordCardBlock(rawCard, 'invalid-citation', 'safety:unverified-external-fact', unverifiedExternalViolation)
      continue
    }

    // Table rule 2: Forbidden actions
    const forbiddenViolation = checkPackForbiddenActions(rawCard, input.effectivePacks)
    if (forbiddenViolation !== null) {
      recordCardBlock(rawCard, 'forbidden-action', forbiddenViolation.ruleId, forbiddenViolation.detailZh)
      continue
    }

    // Table rule 3 & 4: Allergy conflicts and platform/pack red-line violations on candidate medications/suggestions
    const explicitCandidates = input.medicationCandidatesByCardId?.get(rawCard.cardId) ?? []
    const cardAllergyHit = explicitCandidates.find(candidate => descriptorMatchesAllergy(candidate, allergyTokens))
    if (cardAllergyHit !== undefined) {
      recordCardBlock(
        rawCard,
        'allergy-conflict',
        `safety:allergy:${cardAllergyHit.catalogItemId}`,
        `候选建议“${rawCard.summary}”涉及患者已确认过敏药物 ${cardAllergyHit.display}，已在展示前拦截`,
      )
      continue
    }

    if (!NON_INTERVENTION_DIAGNOSTIC_CATEGORIES.has(rawCard.category) || rawCard.suggestions.length > 0) {
      const explicitRedLine = checkDescriptorRedLines(explicitCandidates, { activeMedications, renal: input.renal })
      if (explicitRedLine !== null) {
        recordCardBlock(rawCard, 'red-line-violation', 'safety:medication-red-line', explicitRedLine)
        continue
      }
    }

    // Filter individual suggestions against allergy + red lines
    const safeSuggestions: ClinicalPromptSuggestion[] = []
    let strippedDueToAllergy = 0
    let strippedDueToRedLine = 0
    let lastAllergyMsg = ''
    let lastRedLineMsg = ''

    for (const suggestion of rawCard.suggestions) {
      const descriptors = resolveSuggestionMedicationDescriptors(suggestion, input.medicationCatalog)
      const allergyDescriptor = descriptors.find(d => descriptorMatchesAllergy(d, allergyTokens))
      if (allergyDescriptor) {
        strippedDueToAllergy += 1
        lastAllergyMsg = `建议药物 ${allergyDescriptor.display} 与患者已确认过敏史冲突`
        blockedRecords.push({
          blockedReason: 'allergy-conflict',
          cardId: rawCard.cardId,
          cardSummary: rawCard.summary,
          detailZh: lastAllergyMsg,
          packId: rawCard.packId,
          ruleId: `safety:suggestion-allergy:${suggestion.id}`,
          suggestionIds: [suggestion.id],
          timing: rawCard.timing,
        })
        continue
      }

      const redLineMsg = checkDescriptorRedLines(descriptors, { activeMedications, renal: input.renal })
      if (redLineMsg !== null) {
        strippedDueToRedLine += 1
        lastRedLineMsg = redLineMsg
        blockedRecords.push({
          blockedReason: 'red-line-violation',
          cardId: rawCard.cardId,
          cardSummary: rawCard.summary,
          detailZh: redLineMsg,
          packId: rawCard.packId,
          ruleId: `safety:suggestion-red-line:${suggestion.id}`,
          suggestionIds: [suggestion.id],
          timing: rawCard.timing,
        })
        continue
      }

      // Pack-declared red-line rule check when proposing an invasive/intervention draft without required eligible lab
      const pack = rawCard.packId ? packById.get(rawCard.packId) : undefined
      if (pack && suggestion.actionKind === 'draft-order-set') {
        const redLinesToCheck = pack.effectiveRedLines.length > 0
          ? pack.effectiveRedLines
          : pack.pack.qualityTightenings.redLineRules
        const missingRedLine = redLinesToCheck.find(rule => {
          const matching = input.ledger.facts.filter(
            fact => fact.itemCode.code === rule.itemCode && fact.presence === 'present' && fact.eligibleForScoringAndRedLine,
          )
          return matching.length === 0
        })
        if (missingRedLine) {
          strippedDueToRedLine += 1
          lastRedLineMsg = `${missingRedLine.conditionSummary}（缺少合格基线项目 ${missingRedLine.itemCode}）`
          blockedRecords.push({
            blockedReason: 'red-line-violation',
            cardId: rawCard.cardId,
            cardSummary: rawCard.summary,
            detailZh: lastRedLineMsg,
            packId: rawCard.packId,
            ruleId: `safety:pack-red-line:${missingRedLine.id}`,
            suggestionIds: [suggestion.id],
            timing: rawCard.timing,
          })
          continue
        }
      }

      safeSuggestions.push(suggestion)
    }

    const totalStripped = strippedDueToAllergy + strippedDueToRedLine
    if (totalStripped > 0 && safeSuggestions.length === 0) {
      // Every suggestion on the card was unsafe; remove the duplicate suggestion block and block the entire card cleanly.
      const reason = strippedDueToAllergy > 0 ? 'allergy-conflict' : 'red-line-violation'
      const msg = strippedDueToAllergy > 0 ? lastAllergyMsg : lastRedLineMsg
      if (blockedRecords.length > 0 && blockedRecords[blockedRecords.length - 1]!.cardId === rawCard.cardId) {
        blockedRecords[blockedRecords.length - 1]!.ruleId = `safety:card-${reason}`
      } else {
        recordCardBlock(rawCard, reason, `safety:card-${reason}`, msg)
      }
      continue
    }

    // Table rule 5: Inapplicable population (preserve rule-out checklist, missing-fact, inapplicable-population, exit-summary)
    if (
      rawCard.packId !== null
      && inapplicablePackIds.has(rawCard.packId)
      && !PRESERVED_CATEGORIES_FOR_INAPPLICABLE.has(rawCard.category)
    ) {
      recordCardBlock(
        rawCard,
        'inapplicable-population',
        `safety:inapplicable-population:${rawCard.packId}`,
        `专病包 ${rawCard.packId} 当前处于不适用人群状态，已拦截治疗/干预建议卡“${rawCard.summary}”`,
      )
      continue
    }

    visibleCards.push(
      totalStripped > 0 ? { ...rawCard, suggestions: safeSuggestions } : rawCard,
    )
  }

  return { blockedRecords, visibleCards }
}

/** 根据临床事实总账版本检查持久化卡片是否因检验/检查更正或版本失效而陈旧。 */
export function markStalePromptCardsForLedger(
  cards: readonly ClinicalPromptCard[],
  ledger: ClinicalFactLedger,
): ClinicalPromptCard[] {
  const byFactId = new Map<string, ClinicalFact>()
  const byRecordKey = new Map<string, ClinicalFact[]>()
  for (const fact of ledger.facts) {
    byFactId.set(fact.factId, fact)
    byFactId.set(clampPromptRefToken(fact.factId, 128), fact)
    const key = `${clampPromptRefToken(fact.provenance.recordType, 128)}:${clampPromptRefToken(fact.provenance.recordId, 128)}`
    const list = byRecordKey.get(key)
    if (list) list.push(fact)
    else byRecordKey.set(key, [fact])
  }

  return cards.map(card => {
    if (card.basedOnFactVersions.length === 0) return card
    for (const ref of card.basedOnFactVersions) {
      const exactFact = byFactId.get(ref.factId)
      const recordFacts = byRecordKey.get(`${ref.recordType}:${ref.recordId}`) ?? []
      const hasSuperseded =
        (exactFact !== undefined && isFactSupersededOrInvalid(exactFact))
        || recordFacts.some(f => isFactSupersededOrInvalid(f))
      const hasNewerVersion = recordFacts.some(
        f => !isFactSupersededOrInvalid(f) && clampPromptRefToken(f.provenance.recordVersion, 128) !== ref.recordVersion,
      )
      const activeExactMissing = exactFact === undefined && (
        recordFacts.length > 0
          ? recordFacts.every(
              f => isFactSupersededOrInvalid(f) || clampPromptRefToken(f.provenance.recordVersion, 128) !== ref.recordVersion,
            )
          : !ref.factId.startsWith('ev:')
      )

      if (hasSuperseded || hasNewerVersion || activeExactMissing) {
        return {
          ...card,
          stale: true,
          staleReason: card.staleReason ?? `依据事实（${ref.itemCode ?? ref.recordType}/${ref.recordId} v${ref.recordVersion}）已被更正、替换或产生新版本`,
        }
      }
    }
    return card
  })
}

export function attachRiskTagsAndSideBySide(
  cards: readonly ClinicalPromptCard[],
  riskTagsByPackId: ReadonlyMap<string, readonly ClinicalPromptRiskTag[]>,
): { cards: ClinicalPromptCard[]; sideBySideGroups: ClinicalPromptSideBySideGroup[] } {
  const packIdsByGroupKey = new Map<string, Set<string>>()
  for (const card of cards) {
    if (card.packId === null) continue
    const groupKey = card.sideBySideGroupKey ?? `${card.timing}:${card.category}`
    const packs = packIdsByGroupKey.get(groupKey)
    if (packs) packs.add(card.packId)
    else packIdsByGroupKey.set(groupKey, new Set([card.packId]))
  }

  const multiPackGroups = new Map<string, { cardIds: string[]; packIds: string[] }>()
  const updatedCards = cards.map(card => {
    const packRiskTags = card.packId ? (riskTagsByPackId.get(card.packId) ?? []) : []
    const mergedTagsMap = new Map<string, ClinicalPromptRiskTag>()
    for (const tag of [...card.riskTags, ...packRiskTags]) {
      mergedTagsMap.set(tag.id, tag)
    }
    const baseGroupKey = card.sideBySideGroupKey ?? `${card.timing}:${card.category}`
    const packSet = packIdsByGroupKey.get(baseGroupKey)
    const isMultiPack = card.packId !== null && (packSet?.size ?? 0) >= 2
    const sideBySideGroupKey = isMultiPack ? baseGroupKey : card.sideBySideGroupKey

    if (isMultiPack && sideBySideGroupKey !== null) {
      const entry = multiPackGroups.get(sideBySideGroupKey) ?? { cardIds: [], packIds: [] }
      entry.cardIds.push(card.cardId)
      if (!entry.packIds.includes(card.packId!)) entry.packIds.push(card.packId!)
      multiPackGroups.set(sideBySideGroupKey, entry)
    }

    return {
      ...card,
      riskTags: [...mergedTagsMap.values()],
      sideBySideGroupKey,
    }
  })

  const sideBySideGroups: ClinicalPromptSideBySideGroup[] = [...multiPackGroups.entries()].map(
    ([groupKey, data]) => ({
      cardIds: data.cardIds,
      groupKey,
      packIds: data.packIds.toSorted(),
    }),
  )

  return { cards: updatedCards, sideBySideGroups }
}

export function computePromptCardKnowledgeDiff(
  baselineCards: readonly ClinicalPromptCard[],
  latestCards: readonly ClinicalPromptCard[],
  comparisonsByPack: ReadonlyMap<string, KnowledgeVersionComparison>,
): { cards: ClinicalPromptCard[]; diffs: ClinicalPromptReevaluateDiff[]; retiredHiddenClaimIds: string[] } {
  const baselineById = new Map(baselineCards.map(c => [c.cardId, c]))
  const latestById = new Map(latestCards.map(c => [c.cardId, c]))

  const retiredClaimIds = new Set<string>()
  for (const comparison of comparisonsByPack.values()) {
    for (const claimId of comparison.removedOrRetiredClaimIds) retiredClaimIds.add(claimId)
  }

  const diffs: ClinicalPromptReevaluateDiff[] = []
  const annotatedLatestCards: ClinicalPromptCard[] = latestCards.map(latest => {
    const baseline = baselineById.get(latest.cardId)
    let diffStatus: ClinicalPromptDiffStatus = 'unchanged'
    if (!baseline) {
      diffStatus = 'added'
    } else if (
      baseline.summary !== latest.summary
      || baseline.detail !== latest.detail
      || baseline.knowledgeSnapshotVersion !== latest.knowledgeSnapshotVersion
      || baseline.knowledgeStatus !== latest.knowledgeStatus
      || baseline.stale !== latest.stale
    ) {
      diffStatus = 'updated'
    }
    diffs.push({
      cardId: latest.cardId,
      claimId: latest.source.claimId ?? null,
      diffStatus,
      packId: latest.packId,
      summary: latest.summary,
    })
    return { ...latest, diffStatus }
  })

  const retiredHiddenClaimIds: string[] = []
  for (const baseline of baselineCards) {
    if (latestById.has(baseline.cardId)) continue
    const claimId = baseline.source.claimId ?? null
    if (claimId !== null || baseline.knowledgeStatus === 'published' || baseline.knowledgeStatus === 'auto-verified') {
      if (claimId !== null && (retiredClaimIds.has(claimId) || !latestById.has(baseline.cardId))) {
        retiredHiddenClaimIds.push(claimId)
      }
      diffs.push({
        cardId: baseline.cardId,
        claimId,
        diffStatus: 'retired-hidden',
        packId: baseline.packId,
        summary: baseline.summary,
      })
    }
  }

  return {
    cards: annotatedLatestCards,
    diffs,
    retiredHiddenClaimIds: [...new Set(retiredHiddenClaimIds)],
  }
}

export interface EvaluatedPackForPromptBuild {
  effective: EffectiveDiseasePack
  entry: DiseasePackRuntimeEntry
  vocabulary: ConceptVocabulary
  exitSummaryAlreadyEmitted?: boolean | undefined
  exitMatchedFactIds?: readonly string[] | undefined
}

export interface BuildTimingPromptCardsInput {
  activeMedicationClasses?: readonly string[] | undefined
  asOf: string
  candidateMedicationClasses?: readonly string[] | undefined
  encounterIdByRecordId?: Readonly<Record<string, string>> | undefined
  evaluatedPacks: readonly EvaluatedPackForPromptBuild[]
  ledger: ClinicalFactLedger
  qualityCheck?: ClinicalQualityCheck | undefined
  /** 已由其他来源（如首份已签 12 导联心电图的 ST 结论）回答、不应再算缺项的床旁项目代码。 */
  satisfiedBedsideCodes?: readonly string[] | undefined
  selectedTemplateId?: string | undefined
  /** 床旁缺项只在住院提示。 */
  subjectKind: 'outpatient' | 'inpatient'
  templateClassesByTemplateId?: ReadonlyMap<string, readonly string[]> | undefined
  timing: ClinicalPromptTiming
  verifySourcePassage?: KnowledgePassageVerifier | undefined
}

function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Clamps prompt identifier and provenance tokens to schema bounds deterministically. */
export function clampPromptRefToken(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const suffix = `~${fnv1aHex(value)}`
  return `${value.slice(0, maxLength - suffix.length)}${suffix}`
}

function toFactVersionRefs(
  factIds: readonly string[],
  factsById: ReadonlyMap<string, ClinicalFact>,
): ClinicalPromptFactVersionRef[] {
  const seen = new Set<string>()
  const refs: ClinicalPromptFactVersionRef[] = []
  for (const factId of factIds) {
    if (seen.has(factId)) continue
    const fact = factsById.get(factId)
    if (!fact) continue
    seen.add(factId)
    refs.push({
      factId: clampPromptRefToken(fact.factId, 128),
      itemCode: clampPromptRefToken(fact.itemCode.code, 128),
      recordId: clampPromptRefToken(fact.provenance.recordId, 128),
      recordType: clampPromptRefToken(fact.provenance.recordType, 128),
      recordVersion: clampPromptRefToken(fact.provenance.recordVersion, 128),
    })
  }
  return refs
}

export function resolvePackCardKnowledgeStatus(
  effective: EffectiveDiseasePack,
): ClinicalPromptCard['knowledgeStatus'] {
  const snapshots = effective.pack.knowledgeSnapshots ?? []
  if (snapshots.length === 0) return 'auto-verified'
  const latest = [...snapshots].sort((a, b) => Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom)).at(-1)!
  const nonRetired = latest.claims.filter(claim => claim.status !== 'superseded' && claim.status !== 'retracted')
  if (nonRetired.length === 0) return 'auto-verified'
  return nonRetired.every(claim => claim.status === 'published') ? 'published' : 'auto-verified'
}

function knowledgeBadgeFields(status: ClinicalPromptCard['knowledgeStatus']): {
  trialBadgeZh: ClinicalPromptCard['trialBadgeZh']
  trialDisclaimerZh: ClinicalPromptCard['trialDisclaimerZh']
} {
  if (status === 'auto-verified') {
    return {
      trialBadgeZh: '试用版',
      trialDisclaimerZh: SIMULATION_TRIAL_DISCLAIMER_ZH,
    }
  }
  return {
    trialBadgeZh: null,
    trialDisclaimerZh: null,
  }
}

function isPackExitedEntry(entry: DiseasePackRuntimeEntry): boolean {
  return entry.exited === true || entry.activationReason === 'pack-exited'
}

function evaluateRuleOutMissingChecks(
  ruleOut: NonNullable<EffectiveDiseasePack['pack']['ruleOutChecklist']>[number],
  ledger: ClinicalFactLedger,
  evalOptions: TriggerEvaluationOptions,
): { missingCodes: string[]; missingLabels: string[] } {
  const missingLabels: string[] = []
  const missingCodes: string[] = []

  if (ruleOut.checkItems && ruleOut.checkItems.length > 0) {
    for (const checkItem of ruleOut.checkItems) {
      const node = checkItem.condition ?? (
        checkItem.requiredItemCodes && checkItem.requiredItemCodes.length > 0
          ? {
              kind: 'fact' as const,
              itemCodes: checkItem.requiredItemCodes,
              presence: 'present' as const,
              requireEligible: true,
              ...(checkItem.minCount !== undefined ? { minCount: checkItem.minCount } : {}),
              ...(checkItem.requireNormal ? { abnormal: false } : {}),
            }
          : undefined
      )
      if (!node) continue
      const res = evaluatePackTrigger(node, ledger, evalOptions)
      if (!res.matched) {
        missingLabels.push(checkItem.labelZh)
        for (const code of checkItem.requiredItemCodes ?? []) missingCodes.push(code)
      }
    }
    return { missingCodes: [...new Set(missingCodes)], missingLabels }
  }

  for (const code of ruleOut.requiredTestCodes ?? []) {
    const res = evaluatePackTrigger({
      kind: 'fact',
      itemCodes: [code],
      presence: 'present',
      requireEligible: true,
    }, ledger, evalOptions)
    if (!res.matched) {
      missingLabels.push(code)
      missingCodes.push(code)
    }
  }
  return { missingCodes: [...new Set(missingCodes)], missingLabels }
}

interface ConfusableCluster {
  packIds: string[]
  packs: EvaluatedPackForPromptBuild[]
}

function findMutuallyConfusableClusters(
  evaluatedPacks: readonly EvaluatedPackForPromptBuild[],
): { clusters: ConfusableCluster[]; suppressedPackIds: Set<string> } {
  const activePacks = evaluatedPacks.filter(
    item => item.entry.activationStatus === 'active' && !isPackExitedEntry(item.entry),
  )
  const byId = new Map(activePacks.map(item => [item.effective.pack.manifest.id, item]))
  const adj = new Map<string, Set<string>>()

  for (const item of activePacks) {
    const aId = item.effective.pack.manifest.id
    for (const link of item.effective.pack.confusablePacks ?? []) {
      const other = byId.get(link.packId)
      if (!other || link.packId === aId) continue
      const isMutual = (other.effective.pack.confusablePacks ?? []).some(back => back.packId === aId)
      if (!isMutual) continue
      if (!adj.has(aId)) adj.set(aId, new Set())
      if (!adj.has(link.packId)) adj.set(link.packId, new Set())
      adj.get(aId)!.add(link.packId)
      adj.get(link.packId)!.add(aId)
    }
  }

  const visited = new Set<string>()
  const clusters: ConfusableCluster[] = []
  const suppressedPackIds = new Set<string>()

  for (const startId of [...adj.keys()].sort()) {
    if (visited.has(startId)) continue
    const queue = [startId]
    const component: string[] = []
    visited.add(startId)
    while (queue.length > 0) {
      const current = queue.shift()!
      component.push(current)
      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor)
          queue.push(neighbor)
        }
      }
    }
    if (component.length < 2) continue
    component.sort()
    const packs = component.map(id => byId.get(id)!)
    for (const id of component) suppressedPackIds.add(id)
    clusters.push({ packIds: component, packs })
  }

  return { clusters, suppressedPackIds }
}

function buildConfusableDifferentialCard(
  cluster: ConfusableCluster,
  timing: ClinicalPromptTiming,
  asOf: string,
  encounterIdByRecordId: Readonly<Record<string, string>> | undefined,
  ledger: ClinicalFactLedger,
  factsById: ReadonlyMap<string, ClinicalFact>,
  snapshotVersionsByPackId: ReadonlyMap<string, string>,
): ClinicalPromptCard {
  const clusterSet = new Set(cluster.packIds)
  const groupKey = `confusable-differential:${cluster.packIds.join('+')}`
  const primary = cluster.packs[0]!
  const primaryPackId = primary.effective.pack.manifest.id
  const primaryPackVersion = primary.effective.pack.manifest.version

  const packTitles = cluster.packs.map(p => `${p.effective.pack.manifest.titleZh}（${p.effective.pack.manifest.id}）`)
  const differentialHints: string[] = []
  const suggestions: ClinicalPromptSuggestion[] = []
  const matchedFactIds = new Set<string>()
  const missingItemLabels: string[] = []

  for (const packItem of cluster.packs) {
    const pid = packItem.effective.pack.manifest.id
    const evalOpts: TriggerEvaluationOptions = {
      asOf,
      ...(encounterIdByRecordId ? { encounterIdByRecordId } : {}),
      vocabulary: packItem.vocabulary,
    }
    for (const link of packItem.effective.pack.confusablePacks ?? []) {
      if (!clusterSet.has(link.packId)) continue
      differentialHints.push(`${pid} ↔ ${link.packId}：${link.differentialHintZh}`)
    }
    for (const ruleOut of packItem.effective.pack.ruleOutChecklist ?? []) {
      const res = evaluatePackTrigger(ruleOut.trigger, ledger, evalOpts)
      if (res.matched) {
        for (const fid of res.matchedFactIds) matchedFactIds.add(fid)
      }
      const { missingCodes, missingLabels } = evaluateRuleOutMissingChecks(ruleOut, ledger, evalOpts)
      missingItemLabels.push(...missingLabels)
      suggestions.push({
        actionKind: 'review-differential',
        id: `differential-${pid}-${ruleOut.id}`,
        isDraftOnly: true,
        itemCodes: [...new Set([...ruleOut.targetConditionCodes, ...missingCodes])].slice(0, 16),
        labelZh: `${packItem.effective.pack.manifest.titleZh}：核对${ruleOut.titleZh}`,
      })
    }
  }

  if (suggestions.length === 0) {
    for (const packItem of cluster.packs) {
      suggestions.push({
        actionKind: 'review-differential',
        id: `differential-${packItem.effective.pack.manifest.id}`,
        isDraftOnly: true,
        itemCodes: [],
        labelZh: `并排鉴别 ${packItem.effective.pack.manifest.titleZh}（${packItem.effective.pack.manifest.id}）`,
      })
    }
  }

  const uniqueMissing = [...new Set(missingItemLabels)]
  const missingPart = uniqueMissing.length > 0 ? `；待补鉴别检查：${uniqueMissing.join('、')}` : ''
  const clusterStatus: ClinicalPromptCard['knowledgeStatus'] = cluster.packs.every(
    packItem => resolvePackCardKnowledgeStatus(packItem.effective) === 'published',
  )
    ? 'published'
    : 'auto-verified'
  const clusterBadge = knowledgeBadgeFields(clusterStatus)

  return clinicalPromptCardSchema.parse({
    basedOnFactVersions: toFactVersionRefs([...matchedFactIds], factsById),
    blockingTier: 'none',
    cardId: `${timing}:${groupKey}`,
    category: 'rule-out-checklist',
    deliveryMode: 'display',
    detail: `同时触发互为易混淆专病包 ${packTitles.join('、')}，已暂停各自独立治疗与用药建议，请先完成并排鉴别排查：${differentialHints.join('；')}${missingPart}`,
    indicator: 'warning',
    knowledgeSnapshotVersion: snapshotVersionsByPackId.get(primaryPackId) ?? null,
    knowledgeStatus: clusterStatus,
    overrideReasons: [...clinicalOverrideReasonSchema.options],
    packId: primaryPackId,
    packVersion: primaryPackVersion,
    riskTags: [],
    sideBySideGroupKey: groupKey,
    source: { label: `易混淆专病鉴别 · ${cluster.packIds.join(' / ')}` },
    suggestions: suggestions.slice(0, 12),
    summary: `易混淆病种并排鉴别（${cluster.packs.map(p => p.effective.pack.manifest.titleZh).join(' vs ')}）`,
    timing,
    ...clusterBadge,
  })
}

function buildPointScaleCard(
  scale: NonNullable<EffectiveDiseasePack['pack']['pointScales']>[number],
  packId: string,
  packVersion: string,
  packKnowledgeStatus: ClinicalPromptCard['knowledgeStatus'],
  snapshotVersion: string | null,
  activeRiskTags: ClinicalPromptRiskTag[],
  ledger: ClinicalFactLedger,
  evalOptions: TriggerEvaluationOptions,
  factsById: ReadonlyMap<string, ClinicalFact>,
): ClinicalPromptCard {
  const scaleResult = evaluatePackPointScale(scale, ledger, evalOptions)
  const matchedBand = scale.riskBands.find(item => (
    scaleResult.score >= item.minScore && (item.maxScore === null || scaleResult.score <= item.maxScore)
  ))
  const isLowRiskSkip = matchedBand?.skipTests === true
    || (matchedBand !== undefined && /低危|阴性|无需|免于|skip|low/i.test(`${matchedBand.labelZh} ${matchedBand.guidanceZh ?? ''}`))
  const guidance = matchedBand?.guidanceZh
    ?? (isLowRiskSkip ? '当前为低危分层，可考虑免于进一步侵入性或非必要排查。' : '')
  const citationText = `${scale.guidelineCitation.sourceTitle}（${scale.guidelineCitation.version}，${scale.guidelineCitation.locator}）`
  const matchedCriteriaFactIds = scale.criteria
    .filter(c => scaleResult.matchedCriteriaIds.includes(c.id))
    .flatMap(c => evaluatePackTrigger(c.condition, ledger, evalOptions).matchedFactIds)
  const badge = knowledgeBadgeFields(packKnowledgeStatus)

  return clinicalPromptCardSchema.parse({
    basedOnFactVersions: toFactVersionRefs(matchedCriteriaFactIds, factsById),
    blockingTier: 'none',
    cardId: `encounter-open:point-scale:${packId}:${scale.id}`,
    category: 'recommendation',
    deliveryMode: 'display',
    detail: `${scale.titleZh}评分：${scaleResult.score} 分，风险分层：${scaleResult.bandLabelZh ?? '未分级'}。${guidance ? `${guidance} ` : ''}指南依据：${citationText}`,
    indicator: isLowRiskSkip ? 'info' : 'warning',
    knowledgeSnapshotVersion: snapshotVersion,
    knowledgeStatus: packKnowledgeStatus,
    overrideReasons: [...clinicalOverrideReasonSchema.options],
    packId,
    packVersion,
    riskTags: activeRiskTags,
    sideBySideGroupKey: 'encounter-open:point-scale',
    source: { label: `${scale.titleZh} · ${citationText}` },
    suggestions: [],
    summary: `${scale.titleZh}：${scaleResult.score} 分（${scaleResult.bandLabelZh ?? '已评估'}）${isLowRiskSkip ? ' - 低危可免检' : ''}`,
    timing: 'encounter-open',
    ...badge,
  })
}

function evaluateRiskTagsForPack(
  tag: DiseasePackRiskTag,
  input: BuildTimingPromptCardsInput,
  evalOptions: { asOf: string; encounterIdByRecordId?: Readonly<Record<string, string>>; vocabulary: ConceptVocabulary },
  combinedMedicationClasses: ReadonlySet<string>,
): { matched: boolean; matchedFactIds: string[] } {
  const triggerResult = evaluatePackTrigger(tag.condition, input.ledger, evalOptions)
  if (tag.candidateMedicationClasses !== undefined && tag.candidateMedicationClasses.length > 0) {
    if (input.timing !== 'order-draft-select') {
      return { matched: false, matchedFactIds: [] }
    }
    const allClassesSelected = tag.candidateMedicationClasses.every((cls: string) => combinedMedicationClasses.has(cls))
    if (!allClassesSelected) return { matched: false, matchedFactIds: [] }
    return { matched: triggerResult.matched, matchedFactIds: triggerResult.matchedFactIds }
  }
  if (tag.timing !== undefined && tag.timing !== input.timing) {
    return { matched: false, matchedFactIds: [] }
  }
  return { matched: triggerResult.matched, matchedFactIds: triggerResult.matchedFactIds }
}

function claimToPromptCard(
  claim: EvaluatedKnowledgeClaim,
  snapshotVersion: string | null,
  packVersion: string,
  timing: ClinicalPromptTiming,
  factsById: ReadonlyMap<string, ClinicalFact>,
): ClinicalPromptCard {
  const badge = knowledgeBadgeFields(claim.status)
  return clinicalPromptCardSchema.parse({
    basedOnFactVersions: toFactVersionRefs(claim.matchedFactIds, factsById),
    blockingTier: 'none',
    cardId: `${timing}:claim:${claim.packId}:${claim.id}`,
    category: 'guideline-advice',
    deliveryMode: 'display',
    detail: `${claim.statementZh}（来源：${claim.anchor.title} ${claim.anchor.version} ${claim.anchor.locator}）`,
    diffStatus: null,
    dismissal: null,
    indicator: 'info',
    knowledgeSnapshotVersion: snapshotVersion,
    knowledgeStatus: claim.status,
    longitudinalComparison: null,
    overrideReasons: [...clinicalOverrideReasonSchema.options],
    packId: claim.packId,
    packVersion,
    riskTags: [],
    sideBySideGroupKey: `${timing}:guideline-advice`,
    source: {
      citation: claim.anchor,
      claimId: claim.id,
      label: `${claim.anchor.title} (${claim.anchor.version})`,
      topicId: claim.topicId,
    },
    stale: false,
    staleReason: null,
    status: 'active',
    suggestions: [
      {
        actionKind: 'review-guideline',
        id: `review-${claim.id}`,
        isDraftOnly: true,
        itemCodes: claim.associatedConceptCodes.slice(0, 16),
        labelZh: `核对指南条款：${claim.statementZh.slice(0, 60)}`,
      },
    ],
    summary: claim.statementZh.length > 90 ? `${claim.statementZh.slice(0, 87)}...` : claim.statementZh,
    timing,
    ...badge,
  })
}

/** 按指定触发时机与只读临床事实总账构建统一 ClinicalPromptCard 集合（零模型调用）。 */
function buildRecognitionPromptCard(input: {
  activeRiskTags: readonly ClinicalPromptRiskTag[]
  effective: EffectiveDiseasePack
  packKnowledgeStatus: ClinicalPromptCard['knowledgeStatus']
  snapshotVersion: string | null
  timing: 'encounter-open' | 'report-arrived'
}): ClinicalPromptCard {
  const rc = input.effective.pack.recognitionCard!
  const packId = input.effective.pack.manifest.id
  const badge = knowledgeBadgeFields(input.packKnowledgeStatus)
  return clinicalPromptCardSchema.parse({
    basedOnFactVersions: [],
    blockingTier: 'none',
    cardId: `${input.timing}:recognition:${packId}:${rc.id}`,
    category: 'recognition',
    deliveryMode: 'display',
    detail: `${rc.summaryZh}；${rc.escalationGuidanceZh}`,
    indicator: 'warning',
    knowledgeSnapshotVersion: input.snapshotVersion,
    knowledgeStatus: input.packKnowledgeStatus,
    overrideReasons: [],
    packId,
    packVersion: input.effective.pack.manifest.version,
    riskTags: [...input.activeRiskTags],
    sideBySideGroupKey: `${input.timing}:recognition`,
    source: { label: `${input.effective.pack.manifest.titleZh} · 线索识别` },
    suggestions: [],
    summary: rc.titleZh,
    timing: input.timing,
    ...badge,
  })
}

export function buildTimingPromptCards(input: BuildTimingPromptCardsInput): {
  cards: ClinicalPromptCard[]
  retiredOrInactiveClaimIds: Set<string>
  riskTagsByPackId: Map<string, ClinicalPromptRiskTag[]>
  snapshotVersionsByPackId: Map<string, string>
} {
  const factsById = new Map(input.ledger.facts.map(f => [f.factId, f]))
  const activeFactsByCode = new Map<string, ClinicalFact[]>()
  for (const fact of input.ledger.facts) {
    if (isFactSupersededOrInvalid(fact)) continue
    const list = activeFactsByCode.get(fact.itemCode.code)
    if (list) list.push(fact)
    else activeFactsByCode.set(fact.itemCode.code, [fact])
  }

  const cards: ClinicalPromptCard[] = []
  const retiredOrInactiveClaimIds = new Set<string>()
  const riskTagsByPackId = new Map<string, ClinicalPromptRiskTag[]>()
  const snapshotVersionsByPackId = new Map<string, string>()

  const templateClasses = input.selectedTemplateId
    ? (input.templateClassesByTemplateId?.get(input.selectedTemplateId) ?? [])
    : []
  const combinedMedicationClasses = new Set<string>([
    ...(input.activeMedicationClasses ?? []),
    ...(input.candidateMedicationClasses ?? []),
    ...templateClasses,
  ])

  const confusable = findMutuallyConfusableClusters(input.evaluatedPacks)

  for (const packItem of input.evaluatedPacks) {
    const { effective, entry, vocabulary, exitMatchedFactIds, exitSummaryAlreadyEmitted } = packItem
    const packId = effective.pack.manifest.id
    const packVersion = effective.pack.manifest.version
    const packStatus = resolvePackCardKnowledgeStatus(effective)
    const packBadge = knowledgeBadgeFields(packStatus)
    const evalOptions = {
      asOf: input.asOf,
      ...(input.encounterIdByRecordId ? { encounterIdByRecordId: input.encounterIdByRecordId } : {}),
      vocabulary,
    }

    const snapshots = effective.pack.knowledgeSnapshots ?? []
    const asOfMs = Date.parse(input.asOf)
    const hasEligibleSnapshot = snapshots.some(s => {
      const ms = Date.parse(s.effectiveFrom)
      return !Number.isNaN(ms) && ms <= asOfMs
    })
    const effectiveVerifier: KnowledgePassageVerifier = input.verifySourcePassage
      ?? (anchor => ({ passageText: anchor.quoteFragment, valid: true }))
    const knowledgeEval = hasEligibleSnapshot
      ? evaluateKnowledgeSnapshotForPatient({
          asOf: input.asOf,
          ...(input.encounterIdByRecordId ? { encounterIdByRecordId: input.encounterIdByRecordId } : {}),
          includeRetired: true,
          ledger: input.ledger,
          packId,
          packVersion,
          snapshots,
          verifySourcePassage: effectiveVerifier,
          vocabulary,
        })
      : undefined

    const snapshotVersion = knowledgeEval?.snapshotVersion ?? null
    if (snapshotVersion !== null) snapshotVersionsByPackId.set(packId, snapshotVersion)
    if (knowledgeEval) {
      for (const claim of knowledgeEval.claims) {
        const deactivated = RETIRED_OR_DEACTIVATED_KNOWLEDGE_STATUSES.has(claim.status)
          || !claim.anchorValid
          || claim.deactivationReasons.some(r => r === 'topic-deactivated' || r === 'topic-missing')
        if (deactivated) retiredOrInactiveClaimIds.add(claim.id)
      }
      for (const retiredId of Object.keys(knowledgeEval.retiredClaimStatuses ?? {})) {
        retiredOrInactiveClaimIds.add(retiredId)
      }
    }

    // Exited pack: emit ONE final exit-summary card on transition, then silence all timings.
    if (isPackExitedEntry(entry)) {
      if (!exitSummaryAlreadyEmitted) {
        const exitEval = evaluatePackExit(effective, input.ledger, evalOptions)
        const factIds = exitMatchedFactIds && exitMatchedFactIds.length > 0
          ? [...exitMatchedFactIds]
          : exitEval.matchedFactIds
        const exitReasonZh = entry.exitReasonZh ?? exitEval.exitReasonZh ?? `${effective.pack.manifest.titleZh}已满足退出条件`
        cards.push(clinicalPromptCardSchema.parse({
          basedOnFactVersions: toFactVersionRefs(factIds, factsById),
          blockingTier: 'none',
          cardId: `exit-summary:${packId}`,
          category: 'exit-summary',
          deliveryMode: 'display',
          detail: `${effective.pack.manifest.titleZh}已退出专病管理路径：${exitReasonZh}。后续时机将不再弹出该包提示，如需重新启用可通过人工开关开启。`,
          indicator: 'info',
          knowledgeSnapshotVersion: snapshotVersion,
          knowledgeStatus: 'published',
          overrideReasons: [],
          packId,
          packVersion,
          riskTags: [],
          sideBySideGroupKey: null,
          source: { label: `${effective.pack.manifest.titleZh} · 路径退出` },
          suggestions: [],
          summary: `${effective.pack.manifest.titleZh}已退出：${exitReasonZh.slice(0, 60)}`,
          timing: input.timing,
          trialBadgeZh: null,
          trialDisclaimerZh: null,
        }))
      }
      continue
    }

    const isInapplicable = entry.activationStatus === 'inapplicable'
    const isActive = entry.activationStatus === 'active'
    if (!isActive && !isInapplicable) continue

    const isConfusableSuppressed = isActive && confusable.suppressedPackIds.has(packId)
    const activeRiskTags: ClinicalPromptRiskTag[] = []
    if (isActive && !isConfusableSuppressed) {
      for (const tag of effective.pack.riskTags ?? []) {
        const evaluated = evaluateRiskTagsForPack(tag, input, evalOptions, combinedMedicationClasses)
        if (!evaluated.matched) continue
        activeRiskTags.push({ id: tag.id, labelZh: tag.labelZh, severity: tag.severity })
      }
      if (activeRiskTags.length > 0) riskTagsByPackId.set(packId, activeRiskTags)
    }

    if (isInapplicable && input.timing === 'encounter-open') {
      const matchedLabels = effective.pack.inapplicablePopulations
        .filter(item => entry.matchedInapplicableIds.includes(item.id))
        .map(item => item.descriptionZh)
      const matchedConditionText = matchedLabels.join('；') || '命中专病包不适用条件'
      cards.push(clinicalPromptCardSchema.parse({
        basedOnFactVersions: [],
        blockingTier: 'none',
        cardId: `encounter-open:inapplicable:${packId}`,
        category: 'inapplicable-population',
        deliveryMode: 'display',
        detail: `${effective.pack.manifest.titleZh}命中不适用人群条件（${matchedConditionText}），已超出本包范围，请医生自行决策。已停用该包治疗、用药与血运重建建议，仅保留高危病因排查与关键缺项核对边界。`,
        indicator: 'warning',
        knowledgeSnapshotVersion: snapshotVersion,
        knowledgeStatus: packStatus,
        overrideReasons: [],
        packId,
        packVersion,
        riskTags: [],
        sideBySideGroupKey: null,
        source: { label: effective.pack.manifest.titleZh },
        suggestions: [],
        summary: `${effective.pack.manifest.titleZh}（${matchedLabels[0] ?? '不适用人群'}）：超出本包范围，请医生自行决策`,
        timing: 'encounter-open',
        ...packBadge,
      }))
    }

    const activeStage = entry.currentStageId === null
      ? undefined
      : effective.pack.stages.find(s => s.id === entry.currentStageId)

    if (input.timing === 'encounter-open') {
      // 1. Bedside missing questionnaire prompts (preserved for both active & inapplicable diagnostic boundaries)
      const questionnaireCodes = activeStage?.questionnaireItemCodes?.length
        ? activeStage.questionnaireItemCodes
        : (effective.pack.questionnaireItems ?? []).map(item => item.code)
      for (const qItem of effective.pack.questionnaireItems ?? []) {
        if (input.subjectKind !== 'inpatient') break
        if (!questionnaireCodes.includes(qItem.code)) continue
        if (input.satisfiedBedsideCodes?.includes(qItem.code)) continue
        const existingFacts = activeFactsByCode.get(qItem.code) ?? []
        const hasAskedAnswer = existingFacts.some(f => f.presence !== 'not-asked')
        if (hasAskedAnswer) continue
        cards.push(clinicalPromptCardSchema.parse({
          basedOnFactVersions: [],
          blockingTier: 'none',
          cardId: `encounter-open:missing-question:${packId}:${qItem.code}`,
          category: 'missing-fact',
          deliveryMode: 'display',
          detail: `${effective.pack.manifest.titleZh}${activeStage ? `（${activeStage.titleZh}）` : ''}需要核对床旁问诊项目“${qItem.labelZh}”，当前总账状态为没问到，须补问并录入后再采纳依赖该项的危险分层或方案。`,
          indicator: 'warning',
          knowledgeSnapshotVersion: snapshotVersion,
          knowledgeStatus: packStatus,
          overrideReasons: [...clinicalOverrideReasonSchema.options],
          packId,
          packVersion,
          riskTags: activeRiskTags,
          sideBySideGroupKey: 'encounter-open:missing-fact',
          source: { label: `${effective.pack.manifest.titleZh} · 床旁问诊核对` },
          suggestions: [
            {
              actionKind: 'record-bedside-item',
              id: `ask-${qItem.code}`,
              isDraftOnly: true,
              itemCodes: [qItem.code],
              labelZh: `补充询问并记录${qItem.labelZh}`,
            },
          ],
          summary: `${qItem.labelZh}：没问到`,
          timing: 'encounter-open',
          ...packBadge,
        }))
      }

      // 2. Rule-out checklists (preserved for inapplicable boundary; merged into single card when mutually confusable)
      if (!isConfusableSuppressed) {
        for (const ruleOut of effective.pack.ruleOutChecklist ?? []) {
          const res = evaluatePackTrigger(ruleOut.trigger, input.ledger, evalOptions)
          if (!res.matched) continue
          const { missingCodes, missingLabels } = evaluateRuleOutMissingChecks(ruleOut, input.ledger, evalOptions)
          const codesText = ruleOut.targetConditionCodes.length > 0
            ? `（重点排查诊断编码：${ruleOut.targetConditionCodes.join('、')}）`
            : ''
          const missingText = missingLabels.length > 0
            ? `；尚缺排查项：${missingLabels.join('、')}`
            : (ruleOut.checkItems && ruleOut.checkItems.length > 0 ? '；必备排查项已齐备' : '')
          cards.push(clinicalPromptCardSchema.parse({
            basedOnFactVersions: toFactVersionRefs(res.matchedFactIds, factsById),
            blockingTier: 'none',
            cardId: `encounter-open:rule-out:${packId}:${ruleOut.id}`,
            category: 'rule-out-checklist',
            deliveryMode: 'display',
            detail: `${ruleOut.actionHintZh}${codesText}${missingText}`,
            indicator: 'warning',
            knowledgeSnapshotVersion: snapshotVersion,
            knowledgeStatus: packStatus,
            overrideReasons: [...clinicalOverrideReasonSchema.options],
            packId,
            packVersion,
            riskTags: activeRiskTags,
            sideBySideGroupKey: 'encounter-open:rule-out-checklist',
            source: { label: `${effective.pack.manifest.titleZh} · 鉴别排查清单` },
            suggestions: [
              {
                actionKind: 'review-differential',
                id: `differential-${ruleOut.id}`,
                isDraftOnly: true,
                itemCodes: [...new Set([...ruleOut.targetConditionCodes, ...missingCodes])].slice(0, 16),
                labelZh: `核对${ruleOut.titleZh}`,
              },
            ],
            summary: missingLabels.length > 0 ? `${ruleOut.titleZh}（尚缺：${missingLabels.join('、')}）` : ruleOut.titleZh,
            timing: 'encounter-open',
            ...packBadge,
          }))
        }
      }

      // Everything below is active-pack & non-confusable-suppressed clinical advice/treatment/scoring
      if (isActive && !isConfusableSuppressed) {
        // 3. Risk tags active at encounter-open
        for (const tag of effective.pack.riskTags ?? []) {
          const evaluated = evaluateRiskTagsForPack(tag, input, evalOptions, combinedMedicationClasses)
          if (!evaluated.matched) continue
          cards.push(clinicalPromptCardSchema.parse({
            basedOnFactVersions: toFactVersionRefs(evaluated.matchedFactIds, factsById),
            blockingTier: 'none',
            cardId: `encounter-open:risk-tag:${packId}:${tag.id}`,
            category: 'indication-alert',
            deliveryMode: 'display',
            detail: `${tag.descriptionZh ?? tag.labelZh}（专病包风险标签：${tag.id}）`,
            indicator: tag.severity,
            knowledgeSnapshotVersion: snapshotVersion,
            knowledgeStatus: packStatus,
            overrideReasons: [...clinicalOverrideReasonSchema.options],
            packId,
            packVersion,
            riskTags: [{ id: tag.id, labelZh: tag.labelZh, severity: tag.severity }],
            sideBySideGroupKey: 'encounter-open:indication-alert',
            source: { label: `${effective.pack.manifest.titleZh} · 风险标签` },
            suggestions: [],
            summary: tag.labelZh,
            timing: 'encounter-open',
            ...packBadge,
          }))
        }

        // 4. Longitudinal comparison (e.g. LDL-C 纵向对比)
        if (entry.followUpLdlSummary) {
          cards.push(clinicalPromptCardSchema.parse({
            basedOnFactVersions: toFactVersionRefs(
              [entry.followUpLdlSummary.baselineFactId, entry.followUpLdlSummary.latestFactId],
              factsById,
            ),
            blockingTier: 'none',
            cardId: `encounter-open:longitudinal-ldl:${packId}`,
            category: 'longitudinal-comparison',
            deliveryMode: 'display',
            detail: entry.followUpLdlSummary.comparisonTextZh,
            indicator: entry.followUpLdlSummary.atGoal ? 'info' : 'warning',
            knowledgeSnapshotVersion: snapshotVersion,
            knowledgeStatus: packStatus,
            longitudinalComparison: {
              currentValueText: `${entry.followUpLdlSummary.latestLdlMmolL}`,
              labelZh: 'LDL-C 纵向达标复查',
              previousValueText: `${entry.followUpLdlSummary.baselineLdlMmolL}`,
              unit: 'mmol/L',
            },
            overrideReasons: [],
            packId,
            packVersion,
            riskTags: activeRiskTags,
            sideBySideGroupKey: 'encounter-open:longitudinal-comparison',
            source: { label: `${effective.pack.manifest.titleZh} · 纵向对照` },
            suggestions: [],
            summary: entry.followUpLdlSummary.comparisonTextZh,
            timing: 'encounter-open',
            ...packBadge,
          }))
        }

        // 5. Point scales (data-driven from pack.pointScales)
        for (const scale of effective.pack.pointScales ?? []) {
          cards.push(buildPointScaleCard(
            scale,
            packId,
            packVersion,
            packStatus,
            snapshotVersion,
            activeRiskTags,
            input.ledger,
            evalOptions,
            factsById,
          ))
        }

        // 6. Recognition cards for recognition packs
        if (effective.pack.manifest.packType === 'recognition' && effective.pack.recognitionCard) {
          cards.push(buildRecognitionPromptCard({
            activeRiskTags,
            effective,
            packKnowledgeStatus: packStatus,
            snapshotVersion,
            timing: 'encounter-open',
          }))
        }

        // 7. Active knowledge snapshot claims scoped to active stage topics
        if (knowledgeEval) {
          const stageTopicIds = activeStage?.topicIds
          for (const claim of knowledgeEval.claims) {
            if (!claim.active || !claim.applicable) continue
            if (stageTopicIds && stageTopicIds.length > 0 && !stageTopicIds.includes(claim.topicId)) continue
            cards.push(claimToPromptCard(claim, snapshotVersion, packVersion, 'encounter-open', factsById))
          }
        }
      }
    }

    if (isActive && !isConfusableSuppressed && input.timing === 'order-draft-select') {
      for (const tag of effective.pack.riskTags ?? []) {
        const evaluated = evaluateRiskTagsForPack(tag, input, evalOptions, combinedMedicationClasses)
        if (!evaluated.matched) continue
        cards.push(clinicalPromptCardSchema.parse({
          basedOnFactVersions: toFactVersionRefs(evaluated.matchedFactIds, factsById),
          blockingTier: tag.severity === 'critical' ? 'alert' : 'none',
          cardId: `order-draft-select:risk-tag:${packId}:${tag.id}`,
          category: 'order-set-risk',
          deliveryMode: 'display',
          detail: `${tag.descriptionZh ?? tag.labelZh}${input.selectedTemplateId ? `（所选组套：${input.selectedTemplateId}）` : ''}`,
          indicator: tag.severity,
          knowledgeSnapshotVersion: snapshotVersion,
          knowledgeStatus: packStatus,
          overrideReasons: [...clinicalOverrideReasonSchema.options],
          packId,
          packVersion,
          riskTags: [{ id: tag.id, labelZh: tag.labelZh, severity: tag.severity }],
          sideBySideGroupKey: 'order-draft-select:order-set-risk',
          source: { label: `${effective.pack.manifest.titleZh} · 医嘱草稿风险核对` },
          suggestions: [],
          summary: tag.labelZh,
          timing: 'order-draft-select',
          ...packBadge,
        }))
      }
    }

    if (isActive && input.timing === 'report-arrived') {
      // Newly arrived abnormal/critical findings & unverified external facts & longitudinal LDL comparison
      for (const fact of input.ledger.facts) {
        if (isFactSupersededOrInvalid(fact)) continue
        if (isFactExternalUnverified(fact)) {
          cards.push(clinicalPromptCardSchema.parse({
            basedOnFactVersions: toFactVersionRefs([fact.factId], factsById),
            blockingTier: 'none',
            cardId: clampPromptRefToken(`report-arrived:external-unverified:${packId}:${fact.factId}`, 128),
            category: 'missing-fact',
            deliveryMode: 'display',
            detail: `发现外院未核实事实“${fact.itemCode.display}”（${fact.value.rawText}），当前不作为确认或评分依据，请形式核实后再使用。`,
            indicator: 'warning',
            knowledgeSnapshotVersion: snapshotVersion,
            knowledgeStatus: packStatus,
            overrideReasons: [...clinicalOverrideReasonSchema.options],
            packId,
            packVersion,
            riskTags: activeRiskTags,
            sideBySideGroupKey: 'report-arrived:missing-fact',
            source: { label: `${effective.pack.manifest.titleZh} · 报告到达复核` },
            suggestions: [
              {
                actionKind: 'verify-external-fact',
                id: clampPromptRefToken(`verify-${fact.provenance.recordId}`, 128),
                isDraftOnly: true,
                itemCodes: [clampPromptRefToken(fact.itemCode.code, 128)],
                labelZh: `形式核实外院${fact.itemCode.display}`,
              },
            ],
            summary: `外院${fact.itemCode.display}待形式核实`,
            timing: 'report-arrived',
            ...packBadge,
          }))
        }
      }
      if (isActive && !isConfusableSuppressed) {
        if (effective.pack.manifest.packType === 'recognition' && effective.pack.recognitionCard) {
          cards.push(buildRecognitionPromptCard({
            activeRiskTags,
            effective,
            packKnowledgeStatus: packStatus,
            snapshotVersion,
            timing: 'report-arrived',
          }))
        }
        for (const tag of effective.pack.riskTags ?? []) {
          const evaluated = evaluateRiskTagsForPack(tag, input, evalOptions, combinedMedicationClasses)
          if (!evaluated.matched) continue
          cards.push(clinicalPromptCardSchema.parse({
            basedOnFactVersions: toFactVersionRefs(evaluated.matchedFactIds, factsById),
            blockingTier: 'none',
            cardId: `report-arrived:risk-tag:${packId}:${tag.id}`,
            category: 'indication-alert',
            deliveryMode: 'display',
            detail: `${tag.descriptionZh ?? tag.labelZh}（报告到达/修订后自动触发）`,
            indicator: tag.severity,
            knowledgeSnapshotVersion: snapshotVersion,
            knowledgeStatus: packStatus,
            overrideReasons: [...clinicalOverrideReasonSchema.options],
            packId,
            packVersion,
            riskTags: [{ id: tag.id, labelZh: tag.labelZh, severity: tag.severity }],
            sideBySideGroupKey: 'report-arrived:indication-alert',
            source: { label: `${effective.pack.manifest.titleZh} · 报告事件` },
            suggestions: [],
            summary: tag.labelZh,
            timing: 'report-arrived',
            ...packBadge,
          }))
        }
        if (entry.followUpLdlSummary) {
          cards.push(clinicalPromptCardSchema.parse({
            basedOnFactVersions: toFactVersionRefs(
              [entry.followUpLdlSummary.baselineFactId, entry.followUpLdlSummary.latestFactId],
              factsById,
            ),
            blockingTier: 'none',
            cardId: `report-arrived:longitudinal-ldl:${packId}`,
            category: 'longitudinal-comparison',
            deliveryMode: 'display',
            detail: entry.followUpLdlSummary.comparisonTextZh,
            indicator: entry.followUpLdlSummary.atGoal ? 'info' : 'warning',
            knowledgeSnapshotVersion: snapshotVersion,
            knowledgeStatus: packStatus,
            longitudinalComparison: {
              currentValueText: `${entry.followUpLdlSummary.latestLdlMmolL}`,
              labelZh: 'LDL-C 纵向达标复查',
              previousValueText: `${entry.followUpLdlSummary.baselineLdlMmolL}`,
              unit: 'mmol/L',
            },
            overrideReasons: [],
            packId,
            packVersion,
            riskTags: activeRiskTags,
            sideBySideGroupKey: 'report-arrived:longitudinal-comparison',
            source: { label: `${effective.pack.manifest.titleZh} · 报告到达纵向对照` },
            suggestions: [],
            summary: entry.followUpLdlSummary.comparisonTextZh,
            timing: 'report-arrived',
            ...packBadge,
          }))
        }
      }
    }
  }

  // Emit ONE merged differential workup card for each mutually-confusable active cluster
  if (input.timing === 'encounter-open') {
    for (const cluster of confusable.clusters) {
      cards.push(buildConfusableDifferentialCard(
        cluster,
        input.timing,
        input.asOf,
        input.encounterIdByRecordId,
        input.ledger,
        factsById,
        snapshotVersionsByPackId,
      ))
    }
  }

  // Quality gate timings map deterministically into unified ClinicalPromptCard[] without duplicating rules
  if (
    input.qualityCheck
    && (
      input.timing === 'order-sign'
      || input.timing === 'encounter-complete'
      || input.timing === 'pci-plan'
      || input.timing === 'discharge'
    )
  ) {
    const primaryPackId = input.qualityCheck.packId ?? null
    const primaryPackVersion = input.qualityCheck.packVersion ?? null
    const primarySnapshotVersion = primaryPackId ? (snapshotVersionsByPackId.get(primaryPackId) ?? null) : null
    const primaryRiskTags = primaryPackId ? (riskTagsByPackId.get(primaryPackId) ?? []) : []

    const evidenceFactRefs = (evidence: ClinicalQualityCheck['redLines'][number]['evidence']): ClinicalPromptFactVersionRef[] => {
      const refs: ClinicalPromptFactVersionRef[] = []
      for (const ev of evidence) {
        const parts = ev.reference.split('/')
        const recordType = parts[0] ?? 'Reference'
        const recordId = parts[1] ?? ev.reference
        const matched = input.ledger.facts.find(
          f => f.provenance.recordType === recordType && f.provenance.recordId === recordId && !isFactSupersededOrInvalid(f),
        )
        if (matched) {
          refs.push({
            factId: matched.factId,
            itemCode: matched.itemCode.code,
            recordId: matched.provenance.recordId,
            recordType: matched.provenance.recordType,
            recordVersion: matched.provenance.recordVersion,
          })
        } else {
          refs.push({
            factId: `ev:${ev.reference}`,
            recordId,
            recordType,
            recordVersion: ev.versionId ?? '1',
          })
        }
      }
      return refs
    }

    for (const redLine of input.qualityCheck.redLines) {
      cards.push(clinicalPromptCardSchema.parse({
        basedOnFactVersions: evidenceFactRefs(redLine.evidence),
        blockingTier: 'red-line',
        cardId: `${input.timing}:quality:${redLine.code}${redLine.catalogItemId ? `:${redLine.catalogItemId}` : ''}`,
        category: 'quality-gate',
        deliveryMode: 'display',
        detail: redLine.message,
        indicator: 'critical',
        knowledgeSnapshotVersion: primarySnapshotVersion,
        knowledgeStatus: 'published',
        overrideReasons: [],
        packId: primaryPackId,
        packVersion: primaryPackVersion,
        riskTags: primaryRiskTags,
        sideBySideGroupKey: null,
        source: { label: `事中质控红线 · ${input.qualityCheck.gate}` },
        suggestions: [],
        summary: redLine.message.length > 90 ? `${redLine.message.slice(0, 87)}...` : redLine.message,
        timing: input.timing,
        trialBadgeZh: null,
        trialDisclaimerZh: null,
      }))
    }
    for (const alert of input.qualityCheck.alerts) {
      cards.push(clinicalPromptCardSchema.parse({
        basedOnFactVersions: evidenceFactRefs(alert.evidence),
        blockingTier: 'alert',
        cardId: `${input.timing}:quality:${alert.code}${alert.catalogItemId ? `:${alert.catalogItemId}` : ''}`,
        category: 'quality-gate',
        deliveryMode: 'display',
        detail: alert.message,
        indicator: 'warning',
        knowledgeSnapshotVersion: primarySnapshotVersion,
        knowledgeStatus: 'published',
        overrideReasons: [...clinicalOverrideReasonSchema.options],
        packId: primaryPackId,
        packVersion: primaryPackVersion,
        riskTags: primaryRiskTags,
        sideBySideGroupKey: null,
        source: { label: `事中质控警示 · ${input.qualityCheck.gate}` },
        suggestions: [],
        summary: alert.message.length > 90 ? `${alert.message.slice(0, 87)}...` : alert.message,
        timing: input.timing,
        trialBadgeZh: null,
        trialDisclaimerZh: null,
      }))
    }
  }

  return {
    cards,
    retiredOrInactiveClaimIds,
    riskTagsByPackId,
    snapshotVersionsByPackId,
  }
}

export { compareKnowledgeEvaluations }
