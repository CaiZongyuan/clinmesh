import type { ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import { agentToolCatalog, type AgentToolDefinition } from '@clinmesh/contracts/agent'
import type { ConceptVocabulary } from '@clinmesh/contracts/concept-vocabulary'
import type {
  DiseasePack,
  DiseasePackTriggerNode,
  EffectiveDiseasePack,
} from '@clinmesh/contracts/disease-pack'

type DiseasePackExamCase = DiseasePack['examSuite']['cases'][number]
import { listHisOperations, type HisOperationDefinition } from '@clinmesh/contracts/his-operations'
import {
  clinicalReviewerRecordSchema,
  knowledgeClaimSchema,
  knowledgeSnapshotSchema,
  type ClinicalReviewerRecord,
  type KnowledgeClaim,
  type KnowledgePublicationStatus,
  type KnowledgeSnapshot,
  type KnowledgeTopicCard,
} from '@clinmesh/contracts/knowledge-claims'
import {
  adjudicateConflictInputSchema,
  adjudicateConflictResultSchema,
  conceptMappingImpactReportSchema,
  draftedKnowledgeClaimCandidateSchema,
  guidelineSourceDiffReportSchema,
  offlineKnowledgePipelineResultSchema,
  syntheticTestGuidelineDocSchema,
  type AdjudicateConflictInput,
  type AdjudicateConflictResult,
  type ChangedConceptMappingImpact,
  type ConceptMappingImpactReport,
  type DraftedKnowledgeClaimCandidate,
  type GuidelineClaimConflictItem,
  type GuidelineDiffImpactItem,
  type GuidelineSourceDiffReport,
  type MappingChangeImpactFact,
  type OfflineKnowledgePipelineResult,
  type OfflineKnowledgePipelineTopicMeta,
  type PipelineGuidelinePassage,
  type PipelineSourceDocument,
  type StructuralCheckRejection,
  type StructuralCheckRejectionCode,
  type SyntheticTestGuidelineDoc,
} from '@clinmesh/contracts/knowledge-pipeline'
import {
  evaluateConceptMappingEligibility,
  getConceptAncestors,
  resolveEffectiveConceptVocabulary,
  resolveLedgerFactsForConcept,
  validateAndNormalizeVocabularyOverride,
} from './concept-vocabulary.ts'
import {
  KnowledgeClaimError,
  normalizeAnchorText,
  transitionKnowledgePublicationStatus,
} from './knowledge-claims.ts'

export type KnowledgePipelineErrorCode =
  | 'PIPELINE_INVALID_INPUT'
  | 'CONTROLLED_STREAM_REQUIRED'
  | 'CONFLICT_NOT_FOUND'
  | 'CONFLICT_ALREADY_ADJUDICATED'

export class KnowledgePipelineError extends Error {
  readonly code: KnowledgePipelineErrorCode

  constructor(
    code: KnowledgePipelineErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'KnowledgePipelineError'
    this.code = code
  }
}

export interface ControlledClaimDraftStreamInput {
  readonly sourceDocument: PipelineSourceDocument
  readonly packId: string
  readonly topicId: string
  readonly vocabulary: ConceptVocabulary
}

export interface ControlledClaimDraftStream {
  readonly mode: 'controlled-deterministic'
  draftCandidates(input: ControlledClaimDraftStreamInput): readonly DraftedKnowledgeClaimCandidate[]
}

const RUNTIME_KNOWLEDGE_OR_VOCAB_OP_RE =
  /(?:^|[./_\s-])(?:knowledge|vocabulary|concept-vocabulary|knowledge-claims?|knowledge-topics?|guideline-(?:claims?|diff|adjudicate|draft))(?:$|[./_\s-])/i

/**
 * Count online runtime tools / HIS operations capable of writing knowledge claims or concept vocabulary.
 * AC33 requires this count to remain strictly 0.
 */
export function countOnlineKnowledgeAndVocabularyWriteTools(
  operations: readonly HisOperationDefinition[] = listHisOperations(),
  agentTools: readonly AgentToolDefinition[] = agentToolCatalog,
): number {
  let count = 0
  for (const tool of agentTools) {
    if (tool.mode === 'query') continue
    if (RUNTIME_KNOWLEDGE_OR_VOCAB_OP_RE.test(tool.operationId) || RUNTIME_KNOWLEDGE_OR_VOCAB_OP_RE.test(tool.toolName)) {
      count += 1
    }
  }
  for (const op of operations) {
    if (op.risk === 'read' && op.mode === 'query') continue
    const targetText = `${op.id} ${op.cliPath.join('.')} ${op.http.path}`
    if (RUNTIME_KNOWLEDGE_OR_VOCAB_OP_RE.test(targetText)) {
      count += 1
    }
  }
  return count
}

const ARABIC_THRESHOLD_RE =
  /(?:[<>≤≥]=?\s*)?\d+(?:\.\d+)?(?:\s*(?:%|mg|g|kg|ug|μg|ng|ml|dl|l|u|iu|umol|mmol|mmhg|bpm|次|天|日|周|个月|月|年|片|粒|支|盒|小时|h|d|岁|级|期))?/gi

function findUngroundedNumericDetails(statementZh: string, passageText: string): string[] {
  const ungrounded: string[] = []
  const normalizedPassageLower = passageText.toLowerCase()
  for (const match of statementZh.matchAll(ARABIC_THRESHOLD_RE)) {
    const token = match[0]
    const index = match.index ?? 0
    if (index > 0) {
      const prevChar = statementZh[index - 1]!
      // Ignore code/version identifiers like v2, I21, P2Y12, SGLT2, E11, T2DM
      if (/[A-Za-z0-9_-]/.test(prevChar)) continue
    }
    const afterIndex = index + token.length
    if (afterIndex < statementZh.length && /[A-Za-z_-]/.test(statementZh[afterIndex]!)) {
      // Check if it's an embedded non-unit alphanumeric code like "2160-0"
      const digitsOnly = /^\d+$/.test(token)
      if (digitsOnly && statementZh[afterIndex] === '-') continue
    }
    const numberMatch = token.match(/\d+(?:\.\d+)?/)
    if (numberMatch === null) continue
    const num = numberMatch[0]
    if (!normalizedPassageLower.includes(num)) {
      ungrounded.push(token.trim())
    }
  }
  return ungrounded
}

export interface ValidateDraftedClaimResult {
  readonly valid: boolean
  readonly rejection?: StructuralCheckRejection
  readonly matchedPassage?: PipelineGuidelinePassage
}

/**
 * Perform AC33 structural checks on a drafted claim candidate:
 * 1. Anchor presence & source identity/sha256/version verification
 * 2. Page/locator + quoteFragment whitespace-normalized match
 * 3. Reject any ungrounded detail or optional condition absent from the cited passage
 * 4. Reject unmapped concept codes absent from the concept vocabulary
 */
export function validateDraftedKnowledgeClaim(input: {
  candidate: DraftedKnowledgeClaimCandidate
  sourceDocument: PipelineSourceDocument
  vocabulary: ConceptVocabulary
  packId: string
  topicId: string
}): ValidateDraftedClaimResult {
  const { candidate, sourceDocument, vocabulary } = input

  if (candidate.packId !== input.packId) {
    throw new KnowledgePipelineError(
      'PIPELINE_INVALID_INPUT',
      `候选主张 ${candidate.candidateId} 的 packId (${candidate.packId}) 与目标专病包 ${input.packId} 不一致`,
    )
  }
  if (candidate.topicId !== input.topicId) {
    throw new KnowledgePipelineError(
      'PIPELINE_INVALID_INPUT',
      `候选主张 ${candidate.candidateId} 的 topicId (${candidate.topicId}) 与目标专题 ${input.topicId} 不一致`,
    )
  }

  const reject = (code: StructuralCheckRejectionCode, reasonZh: string): ValidateDraftedClaimResult => ({
    rejection: { candidateId: candidate.candidateId, code, reasonZh },
    valid: false,
  })

  if (candidate.anchor === undefined) {
    return reject('CLAIM_ANCHOR_MISSING', `候选主张 ${candidate.candidateId} 缺少原文锚点（anchor），禁止入卡`)
  }

  const { anchor } = candidate
  if (
    anchor.sourceId !== sourceDocument.sourceId
    || anchor.sha256 !== sourceDocument.sha256
    || anchor.version !== sourceDocument.version
  ) {
    return reject(
      'CLAIM_SOURCE_UNVERIFIED',
      `候选主张 ${candidate.candidateId} 引用的来源 (${anchor.sourceId}@${anchor.version}) 与已核验原件不匹配`,
    )
  }

  const candidatePassages = sourceDocument.passages.filter(passage => (
    passage.page === anchor.page
    && (anchor.locator === undefined || passage.locator === anchor.locator)
  ))
  if (candidatePassages.length === 0) {
    return reject(
      'CLAIM_QUOTE_MISMATCH',
      `原件中未找到页码 ${anchor.page}${anchor.locator ? `（${anchor.locator}）` : ''} 的原文段落`,
    )
  }

  const normalizedQuote = normalizeAnchorText(anchor.quoteFragment)
  const matchedPassage = candidatePassages.find(passage => (
    normalizedQuote.length > 0 && normalizeAnchorText(passage.text).includes(normalizedQuote)
  ))
  if (matchedPassage === undefined) {
    return reject(
      'CLAIM_QUOTE_MISMATCH',
      `候选主张 ${candidate.candidateId} 的逐字引用片段与原件第 ${anchor.page} 页段落不一致`,
    )
  }

  const normalizedPassage = normalizeAnchorText(matchedPassage.text)

  if (candidate.unsupportedDetailClaimed !== undefined) {
    const normalizedDetail = normalizeAnchorText(candidate.unsupportedDetailClaimed)
    if (!normalizedDetail || !normalizedPassage.includes(normalizedDetail)) {
      return reject(
        'CLAIM_UNSUPPORTED_DETAIL',
        `候选主张 ${candidate.candidateId} 包含原文未写的细节声明（${candidate.unsupportedDetailClaimed}），已拦截`,
      )
    }
  }

  if (candidate.optionalConditionsSpecified !== undefined) {
    const opt = candidate.optionalConditionsSpecified
    const checkEntries: Array<{ label: string; value: string | undefined }> = [
      { label: '适用人群说明', value: opt.populationNote },
      { label: '数值阈值说明', value: opt.thresholdNote },
      { label: '商品/数量说明', value: opt.productQuantityNote },
    ]
    for (const entry of checkEntries) {
      if (entry.value === undefined) continue
      const norm = normalizeAnchorText(entry.value)
      if (!norm || !normalizedPassage.includes(norm)) {
        return reject(
          'CLAIM_UNSUPPORTED_DETAIL',
          `候选主张 ${candidate.candidateId} 补充了原文未写的${entry.label}（${entry.value}），拒绝补造`,
        )
      }
    }
    for (const reqTerm of opt.requiredEvidenceTerms ?? []) {
      const norm = normalizeAnchorText(reqTerm)
      if (!norm || !normalizedPassage.includes(norm)) {
        return reject(
          'CLAIM_UNSUPPORTED_DETAIL',
          `候选主张 ${candidate.candidateId} 声明了原文未出现的前提项（${reqTerm}），拒绝补造`,
        )
      }
    }
  }

  const ungroundedNumbers = findUngroundedNumericDetails(candidate.statementZh, matchedPassage.text)
  if (ungroundedNumbers.length > 0) {
    return reject(
      'CLAIM_UNSUPPORTED_DETAIL',
      `候选主张 ${candidate.candidateId} 陈述中包含原文未记载的数值或规格条件（${ungroundedNumbers.join('、')}），已拦截`,
    )
  }

  const knownConceptCodes = new Set(vocabulary.nodes.map(node => node.code))
  const missingConceptCodes = candidate.associatedConceptCodes.filter(code => !knownConceptCodes.has(code))
  if (missingConceptCodes.length > 0) {
    return reject(
      'CLAIM_CONCEPT_UNMAPPED',
      `候选主张 ${candidate.candidateId} 引用了未在概念词表登记的编码：${missingConceptCodes.join(', ')}`,
    )
  }

  return { matchedPassage, valid: true }
}

/**
 * Create a deterministic, zero-network ControlledClaimDraftStream for offline claim generation (AC33).
 */
export function createDeterministicClaimDraftStream(
  source:
    | readonly DraftedKnowledgeClaimCandidate[]
    | ((input: ControlledClaimDraftStreamInput) => readonly DraftedKnowledgeClaimCandidate[]),
): ControlledClaimDraftStream {
  return {
    draftCandidates(input) {
      const raw = typeof source === 'function' ? source(input) : source
      return raw.map(item => draftedKnowledgeClaimCandidateSchema.parse(item))
    },
    mode: 'controlled-deterministic',
  }
}

/**
 * Create a passage-driven deterministic stream when no scripted candidates are supplied.
 * Extracts at most one candidate per passage matching `topicId` (or all passages when `topicIds` is omitted),
 * preserving exact verbatim passage quotes without hallucinating omitted optional fields.
 */
export function createPassageBackedDeterministicDraftStream(): ControlledClaimDraftStream {
  return createDeterministicClaimDraftStream(input => {
    const matchingPassages = input.sourceDocument.passages.filter(passage => (
      passage.topicIds === undefined || passage.topicIds.includes(input.topicId)
    ))
    return matchingPassages.map((passage, index) => {
      const conceptCodes = (passage.conceptCodes !== undefined && passage.conceptCodes.length > 0)
        ? [...passage.conceptCodes]
        : [input.vocabulary.nodes[0]?.code ?? 'coronary-artery-disease']
      const firstSentence = passage.text.trim().split(/(?<=[。.;])/)[0]?.trim() || passage.text.trim()
      const quoteFragment = firstSentence.slice(0, 400)
      return {
        anchor: {
          locator: passage.locator,
          page: passage.page,
          quoteFragment,
          sha256: input.sourceDocument.sha256,
          sourceId: input.sourceDocument.sourceId,
          title: input.sourceDocument.title,
          version: input.sourceDocument.version,
        },
        applicabilityCondition: {
          category: 'diagnosis' as const,
          itemCodes: conceptCodes,
          kind: 'fact' as const,
          presence: 'present' as const,
          requireEligible: true,
        },
        associatedConceptCodes: conceptCodes,
        candidateId: `${input.topicId}-cand-${index + 1}`,
        claimId: `${input.topicId}-claim-${index + 1}`,
        packId: input.packId,
        statementZh: `依据原件原文核验：${quoteFragment}`,
        topicId: input.topicId,
      }
    })
  })
}

function advanceClaimPublicationStatus(
  clinicianReviewer?: ClinicalReviewerRecord,
): { status: KnowledgePublicationStatus; reviewerId: string | null } {
  let status: KnowledgePublicationStatus = 'imported'
  status = transitionKnowledgePublicationStatus({ actorKind: 'pipeline', currentStatus: status, nextStatus: 'draft' })
  status = transitionKnowledgePublicationStatus({ actorKind: 'pipeline', currentStatus: status, nextStatus: 'concept-mapped' })
  status = transitionKnowledgePublicationStatus({ actorKind: 'pipeline', currentStatus: status, nextStatus: 'auto-verified' })

  if (clinicianReviewer === undefined) {
    return { reviewerId: null, status }
  }

  const parsedReviewer = clinicalReviewerRecordSchema.safeParse(clinicianReviewer)
  if (!parsedReviewer.success) {
    throw new KnowledgeClaimError(
      'KNOWLEDGE_CLINICIAN_REVIEWER_REQUIRED',
      '临床审核人记录未通过执业核验（licenseVerified 必须为 true），拒绝推进至正式版',
    )
  }

  status = transitionKnowledgePublicationStatus({
    actorKind: 'clinician-reviewer',
    currentStatus: status,
    nextStatus: 'clinician-reviewed',
    registeredReviewers: [parsedReviewer.data],
    reviewerId: parsedReviewer.data.reviewerId,
  })
  status = transitionKnowledgePublicationStatus({
    actorKind: 'clinician-reviewer',
    currentStatus: status,
    nextStatus: 'published',
    registeredReviewers: [parsedReviewer.data],
    reviewerId: parsedReviewer.data.reviewerId,
  })
  return { reviewerId: parsedReviewer.data.reviewerId, status }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
  } else {
    for (const entry of Object.values(value)) deepFreeze(entry)
  }
  return Object.freeze(value)
}

/**
 * Run the AC33 offline knowledge claim pipeline:
 * controlled draft stream -> structural verification -> FSM transition (strictly capped at
 * `auto-verified` without a verified ClinicalReviewerRecord) -> immutable KnowledgeSnapshot.
 */
export function runOfflineKnowledgeClaimPipeline(input: {
  sourceDocument: PipelineSourceDocument
  packId: string
  topicId: string
  version: string
  effectiveFrom: string
  snapshotVersion: string
  vocabulary: ConceptVocabulary
  controlledDraftStream: ControlledClaimDraftStream
  clinicianReviewer?: ClinicalReviewerRecord
  topicMetadata?: OfflineKnowledgePipelineTopicMeta
  operations?: readonly HisOperationDefinition[]
  agentTools?: readonly AgentToolDefinition[]
}): OfflineKnowledgePipelineResult {
  if (input.controlledDraftStream.mode !== 'controlled-deterministic') {
    throw new KnowledgePipelineError(
      'CONTROLLED_STREAM_REQUIRED',
      '离线制卡流水线必须使用确定性受控生成流（controlled-deterministic）',
    )
  }

  if (input.clinicianReviewer !== undefined) {
    const reviewerCheck = clinicalReviewerRecordSchema.safeParse(input.clinicianReviewer)
    if (!reviewerCheck.success) {
      throw new KnowledgeClaimError(
        'KNOWLEDGE_CLINICIAN_REVIEWER_REQUIRED',
        '临床审核人未通过执业校验（licenseVerified 必须为 true），禁止签署正式知识卡',
      )
    }
  }

  const runtimeWriteToolsCount = countOnlineKnowledgeAndVocabularyWriteTools(input.operations, input.agentTools)
  if (runtimeWriteToolsCount !== 0) {
    throw new KnowledgePipelineError(
      'PIPELINE_INVALID_INPUT',
      `在线运行时检测到 ${runtimeWriteToolsCount} 个写知识库或写词表工具，违反 AC33 治理约束`,
    )
  }

  const candidates = input.controlledDraftStream.draftCandidates({
    packId: input.packId,
    sourceDocument: input.sourceDocument,
    topicId: input.topicId,
    vocabulary: input.vocabulary,
  })

  const acceptedClaims: KnowledgeClaim[] = []
  const rejectedClaims: StructuralCheckRejection[] = []
  const { reviewerId, status: targetStatus } = advanceClaimPublicationStatus(input.clinicianReviewer)

  for (const rawCandidate of candidates) {
    const candidate = draftedKnowledgeClaimCandidateSchema.parse(rawCandidate)
    const validation = validateDraftedKnowledgeClaim({
      candidate,
      packId: input.packId,
      sourceDocument: input.sourceDocument,
      topicId: input.topicId,
      vocabulary: input.vocabulary,
    })
    if (!validation.valid) {
      rejectedClaims.push(validation.rejection!)
      continue
    }

    const claim = knowledgeClaimSchema.parse({
      anchor: candidate.anchor!,
      applicabilityCondition: candidate.applicabilityCondition,
      associatedConceptCodes: candidate.associatedConceptCodes,
      effectiveFrom: input.effectiveFrom,
      id: candidate.claimId ?? candidate.candidateId,
      packId: input.packId,
      reviewerId,
      statementZh: candidate.statementZh,
      status: targetStatus,
      topicId: input.topicId,
      version: candidate.version ?? input.version,
    })
    acceptedClaims.push(claim)
  }

  let publishedSnapshot: KnowledgeSnapshot | undefined
  if (acceptedClaims.length > 0) {
    const uniqueRefs = new Map<string, KnowledgeTopicCard['references'][number]>()
    for (const claim of acceptedClaims) {
      const refKey = `${claim.anchor.sourceId}@${claim.anchor.version}#${claim.anchor.page}:${claim.anchor.locator ?? ''}:${claim.anchor.quoteFragment}`
      if (!uniqueRefs.has(refKey)) {
        uniqueRefs.set(refKey, claim.anchor)
      }
    }
    const topicCard: KnowledgeTopicCard = {
      effectiveFrom: input.effectiveFrom,
      id: input.topicId,
      limitationsZh: input.topicMetadata?.limitationsZh ?? [
        '离线受控流水线生成；未由认证临床审核人正式签审前仅用于平台仿真核验。',
      ],
      navigationZh: input.topicMetadata?.navigationZh ?? `基于 ${input.sourceDocument.title}（${input.sourceDocument.version}）核验的受控知识卡。`,
      packId: input.packId,
      references: [...uniqueRefs.values()],
      reviewerId,
      status: targetStatus,
      ...(input.topicMetadata?.titleEn === undefined ? {} : { titleEn: input.topicMetadata.titleEn }),
      titleZh: input.topicMetadata?.titleZh ?? `${input.sourceDocument.title} — ${input.topicId}`,
      version: input.version,
    }
    publishedSnapshot = deepFreeze(knowledgeSnapshotSchema.parse({
      claims: acceptedClaims,
      effectiveFrom: input.effectiveFrom,
      snapshotVersion: input.snapshotVersion,
      topics: [topicCard],
    }))
  }

  return deepFreeze(offlineKnowledgePipelineResultSchema.parse({
    acceptedClaims,
    draftedCount: candidates.length,
    modelStreamMode: 'controlled-deterministic',
    ...(publishedSnapshot === undefined ? {} : { publishedSnapshot }),
    rejectedClaims,
    runtimeWriteToolsCount: 0,
  }))
}

// ── Shared Pack Rule / Trigger Impact Analysis Helpers (AC34 & AC35) ──

function collectCodesFromTriggerNode(
  node: DiseasePackTriggerNode,
  codes: Set<string>,
  patterns: RegExp[],
): void {
  if (node.kind === 'fact') {
    for (const code of node.itemCodes ?? []) codes.add(code)
    if (node.itemCodePattern !== undefined) {
      patterns.push(new RegExp(node.itemCodePattern))
    }
    return
  }
  if (node.kind === 'sequence') {
    collectCodesFromTriggerNode(node.first, codes, patterns)
    collectCodesFromTriggerNode(node.then, codes, patterns)
    return
  }
  if (node.kind === 'allOf' || node.kind === 'anyOf') {
    for (const child of node.nodes) collectCodesFromTriggerNode(child, codes, patterns)
    return
  }
  collectCodesFromTriggerNode(node.node, codes, patterns)
}

function triggerNodeTouchesCodes(
  node: DiseasePackTriggerNode,
  targetCodes: ReadonlySet<string>,
): boolean {
  const codes = new Set<string>()
  const patterns: RegExp[] = []
  collectCodesFromTriggerNode(node, codes, patterns)
  for (const code of codes) {
    if (targetCodes.has(code)) return true
  }
  for (const pattern of patterns) {
    for (const target of targetCodes) {
      if (pattern.test(target)) return true
    }
  }
  return false
}

function expandTargetCodesWithVocabulary(
  baseCodes: ReadonlySet<string>,
  vocabulary: ConceptVocabulary,
): Set<string> {
  const expanded = new Set<string>(baseCodes)
  for (const code of baseCodes) {
    for (const ancestor of getConceptAncestors(code, vocabulary)) {
      expanded.add(ancestor)
    }
  }
  for (const mapping of vocabulary.mappings) {
    if (mapping.reviewStatus !== 'approved' || mapping.relation !== 'exact') continue
    if (expanded.has(mapping.targetConceptCode)) {
      expanded.add(mapping.sourceCode)
    }
    if (expanded.has(mapping.sourceCode)) {
      expanded.add(mapping.targetConceptCode)
    }
  }
  return expanded
}

interface PackImpactEvaluation {
  readonly affectedRuleIds: string[]
  readonly affectedStageIds: Set<string>
  readonly affectedTaskIds: Set<string>
  readonly affectedTriggerIds: Set<string>
  readonly affectedRedLineIds: Set<string>
  readonly affectedExamCaseIds: string[]
}

function evaluatePackRuleAndExamImpact(input: {
  pack: DiseasePack
  examCases: readonly DiseasePackExamCase[]
  touchedCodes: ReadonlySet<string>
  touchedTopicIds?: ReadonlySet<string>
}): PackImpactEvaluation {
  const affectedRuleIds = new Set<string>()
  const affectedStageIds = new Set<string>()
  const affectedTaskIds = new Set<string>()
  const affectedTriggerIds = new Set<string>()
  const affectedRedLineIds = new Set<string>()
  const touchedTopics = input.touchedTopicIds ?? new Set<string>()

  for (const trigger of input.pack.triggers) {
    if (triggerNodeTouchesCodes(trigger.condition, input.touchedCodes)) {
      affectedTriggerIds.add(trigger.id)
      affectedRuleIds.add(`trigger:${trigger.id}`)
    }
  }

  for (const stage of input.pack.stages) {
    const stageTouchesCode = triggerNodeTouchesCodes(stage.entryCondition, input.touchedCodes)
    const stageTouchesTopic = stage.topicIds.some(topicId => touchedTopics.has(topicId))
    if (stageTouchesCode || stageTouchesTopic) {
      affectedStageIds.add(stage.id)
      affectedRuleIds.add(`stage:${stage.id}`)
      for (const taskId of stage.taskIds) {
        affectedTaskIds.add(taskId)
        affectedRuleIds.add(`readiness-task:${taskId}`)
      }
    }
  }

  for (const task of input.pack.readinessTasks) {
    const taskCodes = [
      ...task.criticalItems.flatMap(item => [item.itemCode, ...(item.alternateItemCodes ?? [])]),
      ...task.secondaryItems.flatMap(item => [item.itemCode, ...(item.alternateItemCodes ?? [])]),
      ...(task.relevantItemCodes ?? []),
    ]
    if (taskCodes.some(code => input.touchedCodes.has(code)) || affectedTaskIds.has(task.taskId)) {
      affectedTaskIds.add(task.taskId)
      affectedRuleIds.add(`readiness-task:${task.taskId}`)
    }
  }

  for (const redLine of input.pack.qualityTightenings.redLineRules) {
    if (input.touchedCodes.has(redLine.itemCode)) {
      affectedRedLineIds.add(redLine.id)
      affectedRuleIds.add(`red-line:${redLine.id}`)
    }
  }

  for (const rule of input.pack.indicationRules ?? []) {
    const pattern = new RegExp(rule.itemCodePattern)
    const patternMatched = [...input.touchedCodes].some(code => pattern.test(code))
    if (patternMatched || triggerNodeTouchesCodes(rule.condition, input.touchedCodes)) {
      affectedRuleIds.add(`indication:${rule.id}`)
    }
  }

  for (const scale of input.pack.pointScales ?? []) {
    if (scale.criteria.some(criterion => triggerNodeTouchesCodes(criterion.condition, input.touchedCodes))) {
      affectedRuleIds.add(`point-scale:${scale.id}`)
    }
  }

  for (const tag of input.pack.riskTags ?? []) {
    if (triggerNodeTouchesCodes(tag.condition, input.touchedCodes)) {
      affectedRuleIds.add(`risk-tag:${tag.id}`)
    }
  }

  for (const exitCriterion of input.pack.exitCriteria ?? []) {
    if (triggerNodeTouchesCodes(exitCriterion.condition, input.touchedCodes)) {
      affectedRuleIds.add(`exit-criterion:${exitCriterion.id}`)
    }
  }

  for (const ruleOut of input.pack.ruleOutChecklist ?? []) {
    if (
      ruleOut.targetConditionCodes.some(code => input.touchedCodes.has(code))
      || triggerNodeTouchesCodes(ruleOut.trigger, input.touchedCodes)
    ) {
      affectedRuleIds.add(`rule-out:${ruleOut.id}`)
    }
  }

  const affectedExamCaseIds = new Set<string>()
  for (const examCase of input.examCases) {
    if (
      (examCase.expectedStageId !== undefined && affectedStageIds.has(examCase.expectedStageId))
      || (examCase.expectedBlockedTaskIds ?? []).some(taskId => affectedTaskIds.has(taskId))
      || ((affectedTriggerIds.size > 0 || affectedRedLineIds.size > 0) && examCase.expectedActive)
    ) {
      affectedExamCaseIds.add(examCase.caseId)
    }
  }

  return {
    affectedExamCaseIds: [...affectedExamCaseIds].sort((a, b) => a.localeCompare(b)),
    affectedRedLineIds,
    affectedRuleIds: [...affectedRuleIds].sort((a, b) => a.localeCompare(b)),
    affectedStageIds,
    affectedTaskIds,
    affectedTriggerIds,
  }
}

// ── AC34 Guideline Source Diff Report & Expert Adjudication Queue ──

function passageKey(passage: PipelineGuidelinePassage, pageCounts: ReadonlyMap<number, number>): string {
  return (pageCounts.get(passage.page) ?? 0) > 1
    ? `${passage.page}::${passage.locator}`
    : `${passage.page}`
}

function buildPageCounts(passages: readonly PipelineGuidelinePassage[]): Map<number, number> {
  const counts = new Map<number, number>()
  for (const passage of passages) {
    counts.set(passage.page, (counts.get(passage.page) ?? 0) + 1)
  }
  return counts
}

function haveSameConceptSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every(item => rightSet.has(item))
}

function candidateTargetsExistingClaim(
  cand: DraftedKnowledgeClaimCandidate,
  claim: KnowledgeClaim,
  sourceIds: ReadonlySet<string>,
): boolean {
  if (claim.id === cand.claimId) return true
  if (cand.anchor !== undefined && sourceIds.has(claim.anchor.sourceId)) {
    return claim.anchor.page === cand.anchor.page
  }
  return (
    claim.topicId === cand.topicId
    && !sourceIds.has(claim.anchor.sourceId)
    && haveSameConceptSet(claim.associatedConceptCodes, cand.associatedConceptCodes)
  )
}

function buildEffectiveVocabulary(pack: DiseasePack, override?: ConceptVocabulary): ConceptVocabulary {
  if (override !== undefined) return validateAndNormalizeVocabularyOverride(override)
  return resolveEffectiveConceptVocabulary(
    pack.conceptVocabulary === undefined ? {} : { packLayer: pack.conceptVocabulary },
  )
}

/**
 * Compare synthetic v1 vs v2 guideline documents against an EffectiveDiseasePack and KnowledgeSnapshot (AC34).
 * Produces impacted topics, claims, rules, exam cases, and populates `expertAdjudicationQueue` for conflicts
 * while keeping existing claims in `snapshot` 100% untouched before explicit clinician adjudication.
 */
export function buildGuidelineSourceDiffReport(input: {
  v1Document: SyntheticTestGuidelineDoc
  v2Document: SyntheticTestGuidelineDoc
  effectivePack: EffectiveDiseasePack
  snapshot: KnowledgeSnapshot
  v2Candidates?: readonly DraftedKnowledgeClaimCandidate[]
  vocabulary?: ConceptVocabulary
}): GuidelineSourceDiffReport {
  const v1 = syntheticTestGuidelineDocSchema.parse(input.v1Document)
  const v2 = syntheticTestGuidelineDocSchema.parse(input.v2Document)
  const snapshot = knowledgeSnapshotSchema.parse(input.snapshot)
  const vocabulary = buildEffectiveVocabulary(input.effectivePack.pack, input.vocabulary)
  const v2Candidates = (input.v2Candidates ?? []).map(c => draftedKnowledgeClaimCandidateSchema.parse(c))

  const v1Counts = buildPageCounts(v1.passages)
  const v2Counts = buildPageCounts(v2.passages)
  const v1ByKey = new Map(v1.passages.map(p => [passageKey(p, v1Counts), p]))
  const v2ByKey = new Map(v2.passages.map(p => [passageKey(p, v2Counts), p]))
  const allKeys = [...new Set([...v1ByKey.keys(), ...v2ByKey.keys()])]
  const sourceIds = new Set([v1.sourceId, v2.sourceId])

  const changedPassages: GuidelineDiffImpactItem[] = []
  const totalAffectedTopicIds = new Set<string>()
  const totalAffectedClaimIds = new Set<string>()
  const totalAffectedRuleIds = new Set<string>()
  const totalAffectedExamCaseIds = new Set<string>()

  for (const key of allKeys) {
    const p1 = v1ByKey.get(key)
    const p2 = v2ByKey.get(key)
    if (p1 !== undefined && p2 !== undefined && p1.text === p2.text && p1.locator === p2.locator) {
      continue
    }

    const changeKind: GuidelineDiffImpactItem['changeKind'] =
      p1 === undefined ? 'added' : p2 === undefined ? 'removed' : 'modified'
    const page = (p2 ?? p1)!.page
    const locator = (p2 ?? p1)!.locator

    const passageTopicIds = new Set<string>([...(p1?.topicIds ?? []), ...(p2?.topicIds ?? [])])
    for (const topic of snapshot.topics) {
      const touchesRef = topic.references.some(ref => (
        sourceIds.has(ref.sourceId) && ref.page === page
      ))
      if (touchesRef || passageTopicIds.has(topic.id)) {
        passageTopicIds.add(topic.id)
      }
    }

    const passageClaimIds = new Set<string>()
    const touchedConceptCodes = new Set<string>([...(p1?.conceptCodes ?? []), ...(p2?.conceptCodes ?? [])])

    for (const claim of snapshot.claims) {
      if (sourceIds.has(claim.anchor.sourceId) && claim.anchor.page === page) {
        passageClaimIds.add(claim.id)
        for (const code of claim.associatedConceptCodes) touchedConceptCodes.add(code)
      }
    }

    for (const cand of v2Candidates) {
      if (cand.anchor?.page !== page) continue
      for (const code of cand.associatedConceptCodes) touchedConceptCodes.add(code)
      for (const claim of snapshot.claims) {
        if (claim.status === 'superseded' || claim.status === 'retracted' || claim.status === 'rejected') continue
        if (candidateTargetsExistingClaim(cand, claim, sourceIds)) {
          passageClaimIds.add(claim.id)
        }
      }
    }

    const expandedCodes = expandTargetCodesWithVocabulary(touchedConceptCodes, vocabulary)
    const packImpact = evaluatePackRuleAndExamImpact({
      examCases: input.effectivePack.pack.examSuite.cases,
      pack: input.effectivePack.pack,
      touchedCodes: expandedCodes,
      touchedTopicIds: passageTopicIds,
    })

    const item: GuidelineDiffImpactItem = {
      affectedClaimIds: [...passageClaimIds].sort((a, b) => a.localeCompare(b)),
      affectedExamCaseIds: packImpact.affectedExamCaseIds,
      affectedRuleIds: packImpact.affectedRuleIds,
      affectedTopicIds: [...passageTopicIds].sort((a, b) => a.localeCompare(b)),
      changeKind,
      locator,
      page,
      ...(p1 === undefined ? {} : { v1Text: p1.text }),
      ...(p2 === undefined ? {} : { v2Text: p2.text }),
    }
    changedPassages.push(item)

    for (const id of item.affectedTopicIds) totalAffectedTopicIds.add(id)
    for (const id of item.affectedClaimIds) totalAffectedClaimIds.add(id)
    for (const id of item.affectedRuleIds) totalAffectedRuleIds.add(id)
    for (const id of item.affectedExamCaseIds) totalAffectedExamCaseIds.add(id)
  }

  const conflicts: GuidelineClaimConflictItem[] = []
  const seenConflictIds = new Set<string>()
  for (const cand of v2Candidates) {
    for (const claim of snapshot.claims) {
      if (claim.status === 'superseded' || claim.status === 'retracted' || claim.status === 'rejected') continue
      if (claim.topicId !== cand.topicId) continue
      if (!candidateTargetsExistingClaim(cand, claim, sourceIds)) continue
      const contentChanged = claim.statementZh !== cand.statementZh
        || (cand.anchor !== undefined && claim.anchor.quoteFragment !== cand.anchor.quoteFragment)
      if (!contentChanged) continue

      const conflictId = `conflict-${claim.id}-${cand.candidateId}`
      if (seenConflictIds.has(conflictId)) continue
      seenConflictIds.add(conflictId)
      totalAffectedClaimIds.add(claim.id)
      totalAffectedTopicIds.add(claim.topicId)

      conflicts.push({
        candidateClaim: structuredClone(cand),
        conflictId,
        existingClaim: structuredClone(claim),
        existingClaimId: claim.id,
        reasonZh: `新版合成指南（${v2.version}）候选主张与现有主张 ${claim.id} 表述或引文不一致，已送入专家裁决队列；裁决前原主张保持不变`,
        status: 'pending-adjudication',
        topicId: claim.topicId,
      })
    }
  }

  const unchangedExistingClaimIds = snapshot.claims
    .filter(claim => !totalAffectedClaimIds.has(claim.id))
    .map(claim => claim.id)

  return guidelineSourceDiffReportSchema.parse({
    affectedClaimIds: [...totalAffectedClaimIds].sort((a, b) => a.localeCompare(b)),
    affectedExamCaseIds: [...totalAffectedExamCaseIds].sort((a, b) => a.localeCompare(b)),
    affectedRuleIds: [...totalAffectedRuleIds].sort((a, b) => a.localeCompare(b)),
    affectedTopicIds: [...totalAffectedTopicIds].sort((a, b) => a.localeCompare(b)),
    changedPassages,
    conflicts,
    expertAdjudicationQueue: conflicts.map(item => structuredClone(item)),
    packId: input.effectivePack.pack.manifest.id,
    snapshot: structuredClone(snapshot),
    syntheticDisclaimerZh: v2.disclaimerZh,
    unchangedExistingClaimIds,
    v1Sha256: v1.sha256,
    v1SourceId: v1.sourceId,
    v1Version: v1.version,
    v2Sha256: v2.sha256,
    v2SourceId: v2.sourceId,
    v2Version: v2.version,
  })
}

/**
 * Resolve one pending conflict in `expertAdjudicationQueue` using a license-verified clinician reviewer (AC34).
 */
export function adjudicateGuidelineClaimConflict(input: {
  report: GuidelineSourceDiffReport
  snapshot: KnowledgeSnapshot
  adjudication: AdjudicateConflictInput
  effectiveFrom?: string
  nowIso?: string
}): AdjudicateConflictResult {
  const reviewerCheck = clinicalReviewerRecordSchema.safeParse((input.adjudication as { reviewer?: unknown }).reviewer)
  if (!reviewerCheck.success) {
    throw new KnowledgeClaimError(
      'KNOWLEDGE_CLINICIAN_REVIEWER_REQUIRED',
      '冲突裁决必须由已核验执业临床审核人（licenseVerified: true）签署',
    )
  }
  const adjudication = adjudicateConflictInputSchema.parse(input.adjudication)
  const report = guidelineSourceDiffReportSchema.parse(input.report)
  const snapshot = knowledgeSnapshotSchema.parse(input.snapshot)

  const targetConflict = report.expertAdjudicationQueue.find(item => item.conflictId === adjudication.conflictId)
  if (targetConflict === undefined) {
    throw new KnowledgePipelineError('CONFLICT_NOT_FOUND', `专家裁决队列中未找到冲突条目 ${adjudication.conflictId}`)
  }
  if (targetConflict.status !== 'pending-adjudication') {
    throw new KnowledgePipelineError('CONFLICT_ALREADY_ADJUDICATED', `冲突条目 ${adjudication.conflictId} 已完成裁决`)
  }

  const adjudicatedAt = input.nowIso ?? input.effectiveFrom ?? snapshot.effectiveFrom
  const resolvedConflict: GuidelineClaimConflictItem = {
    ...structuredClone(targetConflict),
    adjudication: {
      adjudicatedAt,
      decision: adjudication.decision,
      rationaleZh: adjudication.rationaleZh,
      reviewer: adjudication.reviewer,
    },
    status: adjudication.decision === 'keep-existing' ? 'kept-existing' : 'adopted-new',
  }

  const nextSnapshot = structuredClone(snapshot)
  if (adjudication.decision === 'adopt-new') {
    if (targetConflict.candidateClaim.anchor === undefined) {
      throw new KnowledgePipelineError(
        'PIPELINE_INVALID_INPUT',
        `候选主张 ${targetConflict.candidateClaim.candidateId} 缺少原文锚点，禁止通过裁决采纳`,
      )
    }
    const existingIndex = nextSnapshot.claims.findIndex(c => c.id === targetConflict.existingClaimId)
    const adoptedId = targetConflict.candidateClaim.claimId ?? `${targetConflict.existingClaimId}-adjudicated`
    if (existingIndex >= 0 && adoptedId === targetConflict.existingClaimId) {
      throw new KnowledgePipelineError(
        'PIPELINE_INVALID_INPUT',
        `新采纳主张编号 ${adoptedId} 不得与被替代旧主张一致，必须保留 superseded 历史记录`,
      )
    }
    const { status: publishedStatus } = advanceClaimPublicationStatus(adjudication.reviewer)
    const adoptedClaim: KnowledgeClaim = {
      anchor: targetConflict.candidateClaim.anchor,
      applicabilityCondition: targetConflict.candidateClaim.applicabilityCondition,
      associatedConceptCodes: [...targetConflict.candidateClaim.associatedConceptCodes],
      effectiveFrom: input.effectiveFrom ?? adjudicatedAt,
      id: adoptedId,
      packId: targetConflict.candidateClaim.packId,
      reviewerId: adjudication.reviewer.reviewerId,
      statementZh: targetConflict.candidateClaim.statementZh,
      status: publishedStatus,
      topicId: targetConflict.candidateClaim.topicId,
      version: targetConflict.candidateClaim.version ?? targetConflict.existingClaim.version,
    }

    if (existingIndex >= 0) {
      const currentClaim = nextSnapshot.claims[existingIndex]!
      const supersededStatus = transitionKnowledgePublicationStatus({
        actorKind: 'clinician-reviewer',
        currentStatus: currentClaim.status,
        nextStatus: 'superseded',
        registeredReviewers: [adjudication.reviewer],
        reviewerId: adjudication.reviewer.reviewerId,
      })
      nextSnapshot.claims[existingIndex] = {
        ...currentClaim,
        status: supersededStatus,
        supersededByClaimId: adoptedId,
      }
    }
    nextSnapshot.claims.push(adoptedClaim)
  }

  const updateConflictList = (items: readonly GuidelineClaimConflictItem[]) => items.map(item => (
    item.conflictId === adjudication.conflictId ? resolvedConflict : structuredClone(item)
  ))

  const updatedReport: GuidelineSourceDiffReport = {
    ...structuredClone(report),
    conflicts: updateConflictList(report.conflicts),
    expertAdjudicationQueue: updateConflictList(report.expertAdjudicationQueue),
    snapshot: nextSnapshot,
  }

  return adjudicateConflictResultSchema.parse({
    resolvedConflict,
    updatedReport,
    updatedSnapshot: nextSnapshot,
  })
}

// ── AC35 Concept Mapping Impact Report ──

/**
 * Analyze downstream impact of concept mapping relation/status downgrades (e.g. `exact` -> `close` or `deprecated`)
 * across historical ledger facts, pack rules, knowledge claims, and exam suite cases (AC35).
 */
export function buildConceptMappingImpactReport(input: {
  beforeVocabulary: ConceptVocabulary
  afterVocabulary: ConceptVocabulary
  effectivePack: EffectiveDiseasePack
  ledger: ClinicalFactLedger
  snapshots: readonly KnowledgeSnapshot[]
  examCases?: readonly DiseasePackExamCase[]
  asOfDate?: string
}): ConceptMappingImpactReport {
  const asOfDate = (input.asOfDate ?? input.ledger.trace.evaluatedAsOf.slice(0, 10)).slice(0, 10)
  const afterById = new Map(input.afterVocabulary.mappings.map(mapping => [mapping.id, mapping]))

  const changedMappings: ChangedConceptMappingImpact[] = []
  const downgradedMappingIds: string[] = []
  const downgradedEntries: Array<{
    beforeMapping: ConceptVocabulary['mappings'][number]
    eligibility: ReturnType<typeof evaluateConceptMappingEligibility>
  }> = []

  for (const beforeMapping of input.beforeVocabulary.mappings) {
    const afterMapping = afterById.get(beforeMapping.id)
    const beforeEligibility = evaluateConceptMappingEligibility(beforeMapping, { asOfDate })

    const effectiveAfterMapping = afterMapping ?? {
      ...beforeMapping,
      reviewStatus: 'deprecated' as const,
    }
    const afterEligibility = evaluateConceptMappingEligibility(effectiveAfterMapping, { asOfDate })

    const changed = afterMapping === undefined
      || beforeMapping.relation !== afterMapping.relation
      || beforeMapping.reviewStatus !== afterMapping.reviewStatus
      || beforeMapping.targetConceptCode !== afterMapping.targetConceptCode
      || beforeMapping.effectiveDate !== afterMapping.effectiveDate

    if (!changed) continue

    changedMappings.push({
      eligibilityReasonCode: afterEligibility.reasonCode,
      explanationZh: afterEligibility.explanationZh,
      fromRelation: beforeMapping.relation,
      fromReviewStatus: beforeMapping.reviewStatus,
      mappingId: beforeMapping.id,
      sourceCode: beforeMapping.sourceCode,
      sourceSystem: beforeMapping.sourceSystem,
      stillEligibleForScoringAndRedLine: afterEligibility.eligibleForScoreAndRedLine,
      targetConceptCode: beforeMapping.targetConceptCode,
      toRelation: effectiveAfterMapping.relation,
      toReviewStatus: effectiveAfterMapping.reviewStatus,
      wasEligibleForScoringAndRedLine: beforeEligibility.eligibleForScoreAndRedLine,
    })

    if (beforeEligibility.eligibleForScoreAndRedLine && !afterEligibility.eligibleForScoreAndRedLine) {
      downgradedMappingIds.push(beforeMapping.id)
      downgradedEntries.push({
        beforeMapping,
        eligibility: afterEligibility,
      })
    }
  }

  const affectedHistoricalFacts: MappingChangeImpactFact[] = []
  const affectedHistoricalFactIdSet = new Set<string>()
  const touchedCodes = new Set<string>()

  for (const entry of downgradedEntries) {
    const { beforeMapping, eligibility } = entry
    touchedCodes.add(beforeMapping.sourceCode)
    touchedCodes.add(beforeMapping.targetConceptCode)
    for (const ancestor of getConceptAncestors(beforeMapping.targetConceptCode, input.beforeVocabulary)) {
      touchedCodes.add(ancestor)
    }

    const scoringAfter = resolveLedgerFactsForConcept({
      asOfDate,
      ledger: input.ledger,
      mode: 'scoring-or-redline',
      targetConceptCode: beforeMapping.targetConceptCode,
      vocabulary: input.afterVocabulary,
    })
    const stillEligibleFactIds = new Set(scoringAfter.facts.map(fact => fact.factId))

    for (const fact of input.ledger.facts) {
      if (fact.recordStatus === 'entered-in-error' || fact.presence === 'not-asked') continue
      if (fact.itemCode.code !== beforeMapping.sourceCode) continue
      if (stillEligibleFactIds.has(fact.factId)) continue

      affectedHistoricalFactIdSet.add(fact.factId)
      affectedHistoricalFacts.push({
        category: fact.category,
        explanationZh: eligibility.explanationZh,
        factId: fact.factId,
        itemCode: fact.itemCode.code,
        mappingId: beforeMapping.id,
        reasonCode: eligibility.reasonCode,
        sourceSystem: fact.itemCode.system,
        stillEligibleForScoringAndRedLine: false,
        targetConceptCode: beforeMapping.targetConceptCode,
      })
    }
  }

  const packImpact = evaluatePackRuleAndExamImpact({
    examCases: input.examCases ?? input.effectivePack.pack.examSuite.cases,
    pack: input.effectivePack.pack,
    touchedCodes,
  })

  const affectedClaimIds = new Set<string>()
  for (const snapshot of input.snapshots) {
    for (const claim of snapshot.claims) {
      if (claim.status === 'retracted') continue
      const matchesConcept = claim.associatedConceptCodes.some(code => touchedCodes.has(code))
      const matchesApplicability = triggerNodeTouchesCodes(claim.applicabilityCondition, touchedCodes)
      if (matchesConcept || matchesApplicability) {
        affectedClaimIds.add(claim.id)
      }
    }
  }

  const sortedFactIds = [...affectedHistoricalFactIdSet].sort((a, b) => a.localeCompare(b))
  const sortedClaimIds = [...affectedClaimIds].sort((a, b) => a.localeCompare(b))
  const summaryZh = downgradedMappingIds.length === 0
    ? '未发现导致算分/红线准入降级的概念映射变更。'
    : `共检测到 ${downgradedMappingIds.length} 条映射退出算分与红线准入（${downgradedMappingIds.join(', ')}），影响 ${sortedFactIds.length} 条历史事实、${packImpact.affectedRuleIds.length} 条规则、${sortedClaimIds.length} 条知识主张及 ${packImpact.affectedExamCaseIds.length} 条回归考卷。`

  return conceptMappingImpactReportSchema.parse({
    affectedClaimIds: sortedClaimIds,
    affectedExamCaseIds: packImpact.affectedExamCaseIds,
    affectedHistoricalFactIds: sortedFactIds,
    affectedHistoricalFacts,
    affectedRuleIds: packImpact.affectedRuleIds,
    afterVocabularyVersion: input.afterVocabulary.version,
    asOfDate,
    beforeVocabularyVersion: input.beforeVocabulary.version,
    changedMappings,
    downgradedMappingIds,
    packId: input.effectivePack.pack.manifest.id,
    summaryZh,
  })
}
