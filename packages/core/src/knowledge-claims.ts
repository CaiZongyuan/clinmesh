import type { ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import type { ConceptVocabulary } from '@clinmesh/contracts/concept-vocabulary'
import {
  SIMULATION_TRIAL_DISCLAIMER_ZH,
  clinicalReviewerRecordSchema,
  type ClinicalReviewerRecord,
  type DiseasePackKnowledgeEvaluation,
  type EvaluatedKnowledgeClaim,
  type EvaluatedKnowledgeTopic,
  type KnowledgeAnchorCitation,
  type KnowledgeClaim,
  type KnowledgeDisplayStage,
  type KnowledgePublicationStatus,
  type KnowledgeSnapshot,
  type KnowledgeTopicCard,
  type KnowledgeVersionComparison,
} from '@clinmesh/contracts/knowledge-claims'
import { evaluatePackTrigger } from './disease-pack.ts'

export type KnowledgeClaimErrorCode =
  | 'KNOWLEDGE_CLINICIAN_REVIEWER_REQUIRED'
  | 'KNOWLEDGE_STATUS_TRANSITION_INVALID'
  | 'KNOWLEDGE_SNAPSHOT_NOT_FOUND'

export class KnowledgeClaimError extends Error {
  readonly code: KnowledgeClaimErrorCode

  constructor(
    code: KnowledgeClaimErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'KnowledgeClaimError'
    this.code = code
  }
}

const VALID_PUBLICATION_TRANSITIONS: Readonly<Record<KnowledgePublicationStatus, readonly KnowledgePublicationStatus[]>> = {
  imported: ['draft', 'rejected', 'retracted'],
  draft: ['concept-mapped', 'rejected', 'retracted'],
  'concept-mapped': ['auto-verified', 'draft', 'rejected', 'retracted'],
  'auto-verified': ['clinician-reviewed', 'concept-mapped', 'rejected', 'superseded', 'retracted'],
  'clinician-reviewed': ['published', 'rejected', 'superseded', 'retracted'],
  published: ['superseded', 'retracted'],
  rejected: ['retracted'],
  superseded: [],
  retracted: [],
}

/**
 * Enforce knowledge claim/card publication state machine & clinician review gate.
 * Developers and automated pipelines can advance at most to `auto-verified`;
 * `clinician-reviewed` and `published` require a verified clinician reviewer.
 */
export function transitionKnowledgePublicationStatus(input: {
  currentStatus: KnowledgePublicationStatus
  nextStatus: KnowledgePublicationStatus
  actorKind: 'pipeline' | 'developer' | 'clinician-reviewer'
  reviewerId?: string | null
  registeredReviewers?: readonly ClinicalReviewerRecord[]
}): KnowledgePublicationStatus {
  if (input.nextStatus === 'clinician-reviewed' || input.nextStatus === 'published') {
    if (input.actorKind !== 'clinician-reviewer') {
      throw new KnowledgeClaimError(
        'KNOWLEDGE_CLINICIAN_REVIEWER_REQUIRED',
        `状态变更为 ${input.nextStatus} 必须由认证临床审核人（clinician-reviewer）执行，当前角色 ${input.actorKind} 最多推进至 auto-verified`,
      )
    }
    const reviewerId = input.reviewerId?.trim()
    if (!reviewerId) {
      throw new KnowledgeClaimError(
        'KNOWLEDGE_CLINICIAN_REVIEWER_REQUIRED',
        `状态变更为 ${input.nextStatus} 必须提供已认证临床审核人 reviewerId`,
      )
    }
    const matchedReviewer = (input.registeredReviewers ?? []).find(reviewer => reviewer.reviewerId === reviewerId)
    const verified = matchedReviewer !== undefined && clinicalReviewerRecordSchema.safeParse(matchedReviewer).success
    if (!verified) {
      throw new KnowledgeClaimError(
        'KNOWLEDGE_CLINICIAN_REVIEWER_REQUIRED',
        `临床审核人 ${reviewerId} 未在已核验执业审核人名单中，拒绝推进至 ${input.nextStatus}`,
      )
    }
  }

  const allowedNext = VALID_PUBLICATION_TRANSITIONS[input.currentStatus]
  if (!allowedNext.includes(input.nextStatus)) {
    throw new KnowledgeClaimError(
      'KNOWLEDGE_STATUS_TRANSITION_INVALID',
      `知识主张状态禁止从 ${input.currentStatus} 直接变更为 ${input.nextStatus}`,
    )
  }

  return input.nextStatus
}

export function resolveKnowledgeDisplayStage(status: KnowledgePublicationStatus): KnowledgeDisplayStage {
  if (status === 'auto-verified') return '试用版'
  if (status === 'clinician-reviewed' || status === 'published') return '正式版'
  if (status === 'superseded' || status === 'retracted') return '已退役'
  return '未发布'
}

function normalizeAnchorText(text: string): string {
  return text
    .replace(/([a-z])-\r?\n([a-z])/g, '$1$2')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s/g, '')
    .toLowerCase()
}

export interface KnowledgeSourcePassageLookupResult {
  readonly valid: boolean
  readonly passageText?: string
  readonly reason?: string
}

export type KnowledgePassageVerifier = (anchor: KnowledgeAnchorCitation) => KnowledgeSourcePassageLookupResult

export interface VerifyKnowledgeAnchorResult {
  readonly valid: boolean
  readonly passageText?: string
  readonly reason?: string
}

/** Verify a citation anchor against the underlying source corpus and exact quote fragment. */
export function verifyKnowledgeAnchor(
  anchor: KnowledgeAnchorCitation,
  verifySourcePassage: KnowledgePassageVerifier,
): VerifyKnowledgeAnchorResult {
  const lookup = verifySourcePassage(anchor)
  if (!lookup.valid || lookup.passageText === undefined) {
    return {
      reason: lookup.reason ?? 'source-passage-unavailable',
      valid: false,
    }
  }
  const normalizedPassage = normalizeAnchorText(lookup.passageText)
  const normalizedQuote = normalizeAnchorText(anchor.quoteFragment)
  if (!normalizedQuote || !normalizedPassage.includes(normalizedQuote)) {
    return {
      reason: 'quote-fragment-mismatch',
      valid: false,
    }
  }
  return {
    passageText: lookup.passageText,
    valid: true,
  }
}

function resolveSnapshotAtAsOf(
  snapshots: readonly KnowledgeSnapshot[],
  asOf?: string,
): KnowledgeSnapshot {
  if (snapshots.length === 0) {
    throw new KnowledgeClaimError('KNOWLEDGE_SNAPSHOT_NOT_FOUND', '专病包未声明任何知识快照')
  }
  const ordered = snapshots
    .map((snapshot, index) => ({
      effectiveMs: Date.parse(snapshot.effectiveFrom),
      index,
      snapshot,
    }))
    .sort((left, right) => (
      left.effectiveMs - right.effectiveMs
      || left.snapshot.snapshotVersion.localeCompare(right.snapshot.snapshotVersion)
      || left.index - right.index
    ))

  if (asOf === undefined) {
    return ordered[ordered.length - 1]!.snapshot
  }

  const asOfMs = Date.parse(asOf)
  if (Number.isNaN(asOfMs)) {
    throw new KnowledgeClaimError('KNOWLEDGE_SNAPSHOT_NOT_FOUND', `无效的知识评估截止时间 asOf: ${asOf}`)
  }

  const eligible = ordered.filter(entry => !Number.isNaN(entry.effectiveMs) && entry.effectiveMs <= asOfMs)
  if (eligible.length === 0) {
    throw new KnowledgeClaimError(
      'KNOWLEDGE_SNAPSHOT_NOT_FOUND',
      `在截止时间 ${asOf} 之前不存在已生效的知识快照`,
    )
  }
  return eligible[eligible.length - 1]!.snapshot
}

function isPublishableKnowledgeStatus(status: KnowledgePublicationStatus): boolean {
  return status === 'auto-verified' || status === 'clinician-reviewed' || status === 'published'
}

function isRetiredKnowledgeStatus(status: KnowledgePublicationStatus): boolean {
  return status === 'superseded' || status === 'retracted'
}

export interface EvaluateKnowledgeSnapshotInput {
  readonly packId: string
  readonly packVersion: string
  readonly snapshots: readonly KnowledgeSnapshot[]
  readonly ledger: ClinicalFactLedger
  readonly asOf?: string | undefined
  readonly vocabulary?: ConceptVocabulary | undefined
  readonly verifySourcePassage: KnowledgePassageVerifier
  readonly includeRetired?: boolean | undefined
  readonly encounterIdByFactId?: Readonly<Record<string, string>> | undefined
  readonly encounterIdByRecordId?: Readonly<Record<string, string>> | undefined
}

function evaluateTopicCard(
  topic: KnowledgeTopicCard,
  verifySourcePassage: KnowledgePassageVerifier,
): {
  evaluated: Omit<EvaluatedKnowledgeTopic, 'activeClaimCount' | 'totalClaimCount'>
} {
  const deactivationReasons: string[] = []
  let referencesValid = true

  for (const reference of topic.references) {
    const check = verifyKnowledgeAnchor(reference, verifySourcePassage)
    if (!check.valid) {
      referencesValid = false
      deactivationReasons.push(`reference:${reference.sourceId}#p${reference.page}:${check.reason ?? 'invalid'}`)
    }
  }

  if (!isPublishableKnowledgeStatus(topic.status)) {
    deactivationReasons.push(`status:${topic.status}`)
  }

  const displayStageZh = resolveKnowledgeDisplayStage(topic.status)
  const trialDisclaimerZh = topic.status === 'auto-verified' ? SIMULATION_TRIAL_DISCLAIMER_ZH : null
  const active = isPublishableKnowledgeStatus(topic.status) && referencesValid

  return {
    evaluated: {
      active,
      deactivationReasons,
      displayStageZh,
      effectiveFrom: topic.effectiveFrom,
      id: topic.id,
      limitationsZh: [...topic.limitationsZh],
      navigationZh: topic.navigationZh,
      packId: topic.packId,
      references: [...topic.references],
      referencesValid,
      reviewerId: topic.reviewerId,
      status: topic.status,
      ...(topic.supersededByVersion === undefined ? {} : { supersededByVersion: topic.supersededByVersion }),
      ...(topic.titleEn === undefined ? {} : { titleEn: topic.titleEn }),
      titleZh: topic.titleZh,
      trialDisclaimerZh,
      version: topic.version,
    },
  }
}

function evaluateClaim(
  claim: KnowledgeClaim,
  parentTopic: Omit<EvaluatedKnowledgeTopic, 'activeClaimCount' | 'totalClaimCount'> | undefined,
  input: EvaluateKnowledgeSnapshotInput,
  effectiveAsOf: string,
): EvaluatedKnowledgeClaim {
  const deactivationReasons: string[] = []

  const anchorCheck = verifyKnowledgeAnchor(claim.anchor, input.verifySourcePassage)
  const anchorValid = anchorCheck.valid
  if (!anchorValid) {
    deactivationReasons.push(`anchor:${anchorCheck.reason ?? 'invalid'}`)
  }

  if (parentTopic === undefined) {
    deactivationReasons.push('topic-missing')
  } else if (!parentTopic.active) {
    deactivationReasons.push('topic-deactivated')
  }

  if (!isPublishableKnowledgeStatus(claim.status)) {
    deactivationReasons.push(`status:${claim.status}`)
  }

  const triggerResult = evaluatePackTrigger(claim.applicabilityCondition, input.ledger, {
    asOf: effectiveAsOf,
    ...(input.encounterIdByFactId === undefined ? {} : { encounterIdByFactId: input.encounterIdByFactId }),
    ...(input.encounterIdByRecordId === undefined ? {} : { encounterIdByRecordId: input.encounterIdByRecordId }),
    ...(input.vocabulary === undefined ? {} : { vocabulary: input.vocabulary }),
  })
  if (!triggerResult.matched) {
    deactivationReasons.push('applicability-not-matched')
  }

  const displayStageZh = resolveKnowledgeDisplayStage(claim.status)
  const trialDisclaimerZh = claim.status === 'auto-verified' ? SIMULATION_TRIAL_DISCLAIMER_ZH : null
  const active = isPublishableKnowledgeStatus(claim.status)
    && parentTopic?.active === true
    && anchorValid
    && triggerResult.matched

  return {
    active,
    anchor: claim.anchor,
    anchorValid,
    applicable: triggerResult.matched,
    associatedConceptCodes: [...claim.associatedConceptCodes],
    deactivationReasons,
    displayStageZh,
    effectiveFrom: claim.effectiveFrom,
    id: claim.id,
    matchedFactIds: triggerResult.matchedFactIds,
    packId: claim.packId,
    reviewerId: claim.reviewerId,
    statementZh: claim.statementZh,
    status: claim.status,
    ...(claim.supersededByClaimId === undefined ? {} : { supersededByClaimId: claim.supersededByClaimId }),
    topicId: claim.topicId,
    trialDisclaimerZh,
    version: claim.version,
  }
}

/**
 * Evaluate the active knowledge snapshot at `asOf` (or latest snapshot when `asOf` is omitted)
 * against a patient's ClinicalFactLedger and source passage verifier (AC8).
 */
export function evaluateKnowledgeSnapshotForPatient(
  input: EvaluateKnowledgeSnapshotInput,
): DiseasePackKnowledgeEvaluation {
  const snapshot = resolveSnapshotAtAsOf(input.snapshots, input.asOf)
  const effectiveAsOf = input.asOf ?? input.ledger.trace.evaluatedAsOf
  const includeRetired = input.includeRetired === true

  const retiredTopicIds = new Set<string>()
  const topicEvalById = new Map<string, Omit<EvaluatedKnowledgeTopic, 'activeClaimCount' | 'totalClaimCount'>>()
  const visibleTopicDrafts: Array<Omit<EvaluatedKnowledgeTopic, 'activeClaimCount' | 'totalClaimCount'>> = []

  for (const topic of snapshot.topics) {
    const retired = isRetiredKnowledgeStatus(topic.status)
    if (retired) retiredTopicIds.add(topic.id)
    const { evaluated } = evaluateTopicCard(topic, input.verifySourcePassage)
    topicEvalById.set(topic.id, evaluated)
    if (!retired || includeRetired) {
      visibleTopicDrafts.push(evaluated)
    }
  }

  const retiredClaimStatuses: Record<string, 'superseded' | 'retracted'> = {}
  const evaluatedClaims: EvaluatedKnowledgeClaim[] = []

  for (const claim of snapshot.claims) {
    const claimRetired = claim.status === 'superseded' || claim.status === 'retracted'
    if (claimRetired) {
      retiredClaimStatuses[claim.id] = claim.status as 'superseded' | 'retracted'
    } else if (retiredTopicIds.has(claim.topicId)) {
      retiredClaimStatuses[claim.id] = 'superseded'
    }

    if ((claimRetired || retiredTopicIds.has(claim.topicId)) && !includeRetired) {
      continue
    }

    const parentTopic = topicEvalById.get(claim.topicId)
    evaluatedClaims.push(evaluateClaim(claim, parentTopic, input, effectiveAsOf))
  }

  const topics: EvaluatedKnowledgeTopic[] = visibleTopicDrafts.map(topic => {
    const topicClaims = evaluatedClaims.filter(claim => claim.topicId === topic.id)
    return {
      ...topic,
      activeClaimCount: topicClaims.filter(claim => claim.active).length,
      totalClaimCount: topicClaims.length,
    }
  })

  return {
    asOf: effectiveAsOf,
    claims: evaluatedClaims,
    packId: input.packId,
    packVersion: input.packVersion,
    ...(Object.keys(retiredClaimStatuses).length === 0 ? {} : { retiredClaimStatuses }),
    snapshotEffectiveFrom: snapshot.effectiveFrom,
    snapshotVersion: snapshot.snapshotVersion,
    topics,
  }
}

/** Compare a historical baseline evaluation against a latest evaluation. */
export function compareKnowledgeEvaluations(
  baselineEval: DiseasePackKnowledgeEvaluation,
  latestEval: DiseasePackKnowledgeEvaluation,
): KnowledgeVersionComparison {
  const baselineById = new Map(baselineEval.claims.map(claim => [claim.id, claim]))
  const latestById = new Map(latestEval.claims.map(claim => [claim.id, claim]))
  const latestRetired = latestEval.retiredClaimStatuses ?? {}

  const addedClaimIds: string[] = []
  const removedOrRetiredClaimIds: string[] = []
  const statusChanges: KnowledgeVersionComparison['statusChanges'] = []
  const statementChanges: KnowledgeVersionComparison['statementChanges'] = []

  for (const [claimId, latestClaim] of latestById) {
    if (isRetiredKnowledgeStatus(latestClaim.status)) continue
    if (!baselineById.has(claimId)) {
      addedClaimIds.push(claimId)
    }
  }

  for (const [claimId, baselineClaim] of baselineById) {
    const latestClaim = latestById.get(claimId)
    const retiredStatus = Object.hasOwn(latestRetired, claimId) ? latestRetired[claimId] : undefined

    if (latestClaim === undefined) {
      removedOrRetiredClaimIds.push(claimId)
      if (retiredStatus !== undefined && retiredStatus !== baselineClaim.status) {
        statusChanges.push({
          claimId,
          fromStatus: baselineClaim.status,
          toStatus: retiredStatus,
        })
      }
      continue
    }

    if (isRetiredKnowledgeStatus(latestClaim.status) && !isRetiredKnowledgeStatus(baselineClaim.status)) {
      removedOrRetiredClaimIds.push(claimId)
    }
    if (baselineClaim.status !== latestClaim.status) {
      statusChanges.push({
        claimId,
        fromStatus: baselineClaim.status,
        toStatus: latestClaim.status,
      })
    }
    if (baselineClaim.statementZh !== latestClaim.statementZh) {
      statementChanges.push({
        claimId,
        fromStatementZh: baselineClaim.statementZh,
        toStatementZh: latestClaim.statementZh,
      })
    }
  }

  return {
    addedClaimIds: addedClaimIds.sort((a, b) => a.localeCompare(b)),
    baselineSnapshotVersion: baselineEval.snapshotVersion,
    latestSnapshotVersion: latestEval.snapshotVersion,
    removedOrRetiredClaimIds: removedOrRetiredClaimIds.sort((a, b) => a.localeCompare(b)),
    statementChanges: statementChanges.sort((a, b) => a.claimId.localeCompare(b.claimId)),
    statusChanges: statusChanges.sort((a, b) => a.claimId.localeCompare(b.claimId)),
  }
}
