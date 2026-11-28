import type { ClinicalFact, ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import {
  SIMULATION_TRIAL_DISCLAIMER_ZH,
  type ClinicalReviewerRecord,
  type KnowledgeAnchorCitation,
  type KnowledgeSnapshot,
} from '@clinmesh/contracts/knowledge-claims'
import { describe, expect, it } from 'vitest'
import {
  KnowledgeClaimError,
  compareKnowledgeEvaluations,
  evaluateKnowledgeSnapshotForPatient,
  resolveKnowledgeDisplayStage,
  transitionKnowledgePublicationStatus,
  verifyKnowledgeAnchor,
  type KnowledgePassageVerifier,
} from './knowledge-claims.ts'

const SHA_GUIDE_1 = '9843131ad84f9a261ceb8857025e656a067496472edabfb6bd2b6297f2c5ff0e'
const SHA_GUIDE_2 = 'c2018438f6bfe9abf39cdfa813f6a6312de858bb6047ce18d9a01bff222ae9ad'

const REVIEWER: ClinicalReviewerRecord = {
  licenseVerified: true,
  nameZh: '李主任',
  reviewerId: 'clinician-rev-001',
  specialty: 'cardiology',
}

function makeFact(overrides: Partial<ClinicalFact> & Pick<ClinicalFact, 'factId' | 'category' | 'itemCode' | 'value'>): ClinicalFact {
  return {
    clinicianVerification: {
      note: null,
      verified: false,
      verifiedAt: null,
      verifiedByActorId: null,
      verifiedByPractitionerId: null,
    },
    conflictingFactIds: [],
    effectiveAt: '2026-08-24T09:00:00+08:00',
    eligibleForScoringAndRedLine: true,
    ineligibleReasons: [],
    ingestedAt: '2026-08-24T09:05:00+08:00',
    institutionScope: 'local',
    isExpiredAtAsOf: false,
    mappingVersion: '2026-11-24.r1',
    method: null,
    orderedAt: '2026-08-24T08:40:00+08:00',
    presence: 'present',
    provenance: {
      recordId: overrides.factId,
      recordType: 'Condition',
      recordVersion: '1',
      sourceSystemId: 'clinmesh-his-fhir',
    },
    qualityFlags: [],
    recordStatus: 'final',
    relation: { supersededByFactId: null, supersedesFactId: null },
    reportedAt: '2026-08-24T09:10:00+08:00',
    requiresRecheckPrompt: false,
    specimenOrSite: null,
    suspiciousReasons: [],
    validityDays: 30,
    verificationStatus: 'confirmed',
    ...overrides,
  }
}

function makeLedger(asOf = '2026-08-24T12:00:00+08:00'): ClinicalFactLedger {
  const dxFact = makeFact({
    category: 'diagnosis',
    factId: 'fact-dx-cad',
    itemCode: { code: 'I25.103', display: '冠心病', system: 'urn:clinmesh:reference:nhsa-diagnosis' },
    value: { normalizedValue: { code: 'I25.103', display: '冠心病' }, rawText: '冠心病' },
  })
  return {
    facts: [dxFact],
    includeSuperseded: false,
    patientId: 'pat-k1',
    subjectId: 'adm-k1',
    subjectKind: 'inpatient',
    summary: {
      conflictCount: 0,
      eligibleCount: 1,
      expiredCount: 0,
      externalUnverifiedCount: 0,
      notAskedCount: 0,
      supersededCount: 0,
      suspiciousCount: 0,
      totalFacts: 1,
      verifiedExternalCount: 0,
    },
    trace: {
      evaluatedAsOf: asOf,
      hospitalId: 'hospital-synthetic-clinmesh',
      mappingVersion: '2026-11-24.r1',
    },
  }
}

const VALID_CORPUS_PASSAGES: Record<string, string> = {
  [`coronary-10-2021@${SHA_GUIDE_1}#35`]: 'In patients undergoing PCI, DES should be used in preference to BMS. Synthetic test passage.',
  [`coronary-10-2021@${SHA_GUIDE_1}#36`]: 'IVUS can be useful in left main or complex coronary artery stenting. OCT is a reasonable alternative, except in ostial left main disease.',
  [`coronary-15-2021@${SHA_GUIDE_2}#6`]: 'Evaluate both proximal and distal reference segments, with lumen, EEM, and plaque measurements.',
}

const corpusVerifier: KnowledgePassageVerifier = (anchor) => {
  const key = `${anchor.sourceId}@${anchor.sha256}#${anchor.page}`
  const text = VALID_CORPUS_PASSAGES[key]
  if (text === undefined) {
    return { reason: 'source-passage-not-found', valid: false }
  }
  return { passageText: text, valid: true }
}

function validAnchor(overrides: Partial<KnowledgeAnchorCitation> = {}): KnowledgeAnchorCitation {
  return {
    locator: 'PDF 物理第 35 页',
    page: 35,
    quoteFragment: 'In patients undergoing PCI, DES should be used in preference to BMS',
    sha256: SHA_GUIDE_1,
    sourceId: 'coronary-10-2021',
    title: '合成血运重建指南测试原文',
    version: '2021',
    ...overrides,
  }
}

describe('knowledge-claims state machine and AC8 evaluation', () => {
  it('enforces publication FSM and clinician reviewer gate (developers/pipeline max out at auto-verified)', () => {
    expect(transitionKnowledgePublicationStatus({
      actorKind: 'pipeline',
      currentStatus: 'imported',
      nextStatus: 'draft',
    })).toBe('draft')

    expect(transitionKnowledgePublicationStatus({
      actorKind: 'developer',
      currentStatus: 'draft',
      nextStatus: 'concept-mapped',
    })).toBe('concept-mapped')

    expect(transitionKnowledgePublicationStatus({
      actorKind: 'pipeline',
      currentStatus: 'concept-mapped',
      nextStatus: 'auto-verified',
    })).toBe('auto-verified')

    // Developer / pipeline MUST NOT reach clinician-reviewed or published
    expect(() => transitionKnowledgePublicationStatus({
      actorKind: 'developer',
      currentStatus: 'auto-verified',
      nextStatus: 'clinician-reviewed',
      registeredReviewers: [REVIEWER],
      reviewerId: REVIEWER.reviewerId,
    })).toThrowError(KnowledgeClaimError)

    try {
      transitionKnowledgePublicationStatus({
        actorKind: 'pipeline',
        currentStatus: 'auto-verified',
        nextStatus: 'published',
      })
    } catch (error) {
      expect((error as KnowledgeClaimError).code).toBe('KNOWLEDGE_CLINICIAN_REVIEWER_REQUIRED')
    }

    // Unregistered reviewer must fail clinician gate
    try {
      transitionKnowledgePublicationStatus({
        actorKind: 'clinician-reviewer',
        currentStatus: 'auto-verified',
        nextStatus: 'clinician-reviewed',
        registeredReviewers: [REVIEWER],
        reviewerId: 'unknown-reviewer',
      })
    } catch (error) {
      expect((error as KnowledgeClaimError).code).toBe('KNOWLEDGE_CLINICIAN_REVIEWER_REQUIRED')
    }

    // Verified clinician-reviewer advances cleanly to clinician-reviewed -> published
    expect(transitionKnowledgePublicationStatus({
      actorKind: 'clinician-reviewer',
      currentStatus: 'auto-verified',
      nextStatus: 'clinician-reviewed',
      registeredReviewers: [REVIEWER],
      reviewerId: REVIEWER.reviewerId,
    })).toBe('clinician-reviewed')

    expect(transitionKnowledgePublicationStatus({
      actorKind: 'clinician-reviewer',
      currentStatus: 'clinician-reviewed',
      nextStatus: 'published',
      registeredReviewers: [REVIEWER],
      reviewerId: REVIEWER.reviewerId,
    })).toBe('published')

    // Only published maps to '正式版'; clinician-reviewed stays '未发布' and auto-verified is '试用版'
    expect(resolveKnowledgeDisplayStage('auto-verified')).toBe('试用版')
    expect(resolveKnowledgeDisplayStage('clinician-reviewed')).toBe('未发布')
    expect(resolveKnowledgeDisplayStage('published')).toBe('正式版')
    expect(resolveKnowledgeDisplayStage('superseded')).toBe('已退役')
    expect(resolveKnowledgeDisplayStage('retracted')).toBe('已退役')

    // Invalid jump or transition out of retracted fails with KNOWLEDGE_STATUS_TRANSITION_INVALID
    try {
      transitionKnowledgePublicationStatus({
        actorKind: 'clinician-reviewer',
        currentStatus: 'imported',
        nextStatus: 'published',
        registeredReviewers: [REVIEWER],
        reviewerId: REVIEWER.reviewerId,
      })
    } catch (error) {
      expect((error as KnowledgeClaimError).code).toBe('KNOWLEDGE_STATUS_TRANSITION_INVALID')
    }

    try {
      transitionKnowledgePublicationStatus({
        actorKind: 'clinician-reviewer',
        currentStatus: 'retracted',
        nextStatus: 'published',
        registeredReviewers: [REVIEWER],
        reviewerId: REVIEWER.reviewerId,
      })
    } catch (error) {
      expect((error as KnowledgeClaimError).code).toBe('KNOWLEDGE_STATUS_TRANSITION_INVALID')
    }
  })

  it('AC8: deactivates entire topic card on invalid topic reference, isolates invalid claim anchor to that claim only, and enforces trial disclaimer', () => {
    expect(verifyKnowledgeAnchor(validAnchor(), corpusVerifier).valid).toBe(true)
    expect(verifyKnowledgeAnchor(validAnchor({ quoteFragment: 'nonexistent quote' }), corpusVerifier)).toEqual({
      reason: 'quote-fragment-mismatch',
      valid: false,
    })

    const topicBadRefSnapshot: KnowledgeSnapshot = {
      claims: [
        {
          anchor: validAnchor(),
          applicabilityCondition: { category: 'diagnosis', itemCodes: ['I25.103'], kind: 'fact', presence: 'present', requireEligible: true },
          associatedConceptCodes: ['coronary-artery-disease'],
          effectiveFrom: '2026-06-01T00:00:00Z',
          id: 'claim-under-bad-topic',
          packId: 'synthetic-test-syndrome',
          reviewerId: null,
          statementZh: '有效主张但专题引文损坏',
          status: 'auto-verified',
          topicId: 'topic-bad-ref',
          version: '1.0.0',
        },
      ],
      effectiveFrom: '2026-06-01T00:00:00Z',
      snapshotVersion: 'v1-bad-topic',
      topics: [
        {
          effectiveFrom: '2026-06-01T00:00:00Z',
          id: 'topic-bad-ref',
          limitationsZh: ['仿真局限说明'],
          navigationZh: '专题导航',
          packId: 'synthetic-test-syndrome',
          references: [
            validAnchor(),
            validAnchor({ page: 999, quoteFragment: 'missing page' }),
          ],
          reviewerId: null,
          status: 'auto-verified',
          titleZh: '专题引文损坏测试卡',
          version: '1.0.0',
        },
      ],
    }

    const badTopicEval = evaluateKnowledgeSnapshotForPatient({
      ledger: makeLedger(),
      packId: 'synthetic-test-syndrome',
      packVersion: '1.0.0',
      snapshots: [topicBadRefSnapshot],
      verifySourcePassage: corpusVerifier,
    })
    expect(badTopicEval.topics[0]!.active).toBe(false)
    expect(badTopicEval.topics[0]!.referencesValid).toBe(false)
    expect(badTopicEval.topics[0]!.displayStageZh).toBe('试用版')
    expect(badTopicEval.topics[0]!.trialDisclaimerZh).toBe(SIMULATION_TRIAL_DISCLAIMER_ZH)
    expect(badTopicEval.claims[0]!.active).toBe(false)
    expect(badTopicEval.claims[0]!.deactivationReasons).toContain('topic-deactivated')

    // Valid topic card with 1 invalid-anchor claim & 1 valid sibling claim
    const siblingIsolationSnapshot: KnowledgeSnapshot = {
      claims: [
        {
          anchor: validAnchor({ quoteFragment: 'fabricated sentence not in source' }),
          applicabilityCondition: { category: 'diagnosis', itemCodes: ['I25.103'], kind: 'fact', presence: 'present', requireEligible: true },
          associatedConceptCodes: ['coronary-artery-disease'],
          effectiveFrom: '2026-06-01T00:00:00Z',
          id: 'claim-bad-anchor',
          packId: 'synthetic-test-syndrome',
          reviewerId: null,
          statementZh: '锚点失效的主张',
          status: 'auto-verified',
          topicId: 'topic-good',
          version: '1.0.0',
        },
        {
          anchor: validAnchor({
            locator: 'PDF 物理第 6 页',
            page: 6,
            quoteFragment: 'Evaluate both proximal and distal reference segments, with lumen, EEM, and plaque measurements',
            sha256: SHA_GUIDE_2,
            sourceId: 'coronary-15-2021',
          }),
          applicabilityCondition: { category: 'diagnosis', itemCodes: ['I25.103'], kind: 'fact', presence: 'present', requireEligible: true },
          associatedConceptCodes: ['coronary-artery-disease'],
          effectiveFrom: '2026-06-01T00:00:00Z',
          id: 'claim-good-sibling',
          packId: 'synthetic-test-syndrome',
          reviewerId: null,
          statementZh: '锚点完整的同级主张',
          status: 'auto-verified',
          topicId: 'topic-good',
          version: '1.0.0',
        },
      ],
      effectiveFrom: '2026-06-01T00:00:00Z',
      snapshotVersion: 'v1-sibling',
      topics: [
        {
          effectiveFrom: '2026-06-01T00:00:00Z',
          id: 'topic-good',
          limitationsZh: ['仿真局限说明'],
          navigationZh: '专题导航',
          packId: 'synthetic-test-syndrome',
          references: [validAnchor()],
          reviewerId: null,
          status: 'auto-verified',
          titleZh: '专题引文有效测试卡',
          version: '1.0.0',
        },
      ],
    }

    const siblingEval = evaluateKnowledgeSnapshotForPatient({
      ledger: makeLedger(),
      packId: 'synthetic-test-syndrome',
      packVersion: '1.0.0',
      snapshots: [siblingIsolationSnapshot],
      verifySourcePassage: corpusVerifier,
    })
    expect(siblingEval.topics[0]!.active).toBe(true)
    expect(siblingEval.topics[0]!.activeClaimCount).toBe(1)
    expect(siblingEval.topics[0]!.totalClaimCount).toBe(2)

    const badClaim = siblingEval.claims.find(c => c.id === 'claim-bad-anchor')!
    const goodClaim = siblingEval.claims.find(c => c.id === 'claim-good-sibling')!
    expect(badClaim.anchorValid).toBe(false)
    expect(badClaim.active).toBe(false)
    expect(goodClaim.anchorValid).toBe(true)
    expect(goodClaim.active).toBe(true)
    expect(goodClaim.displayStageZh).toBe('试用版')
    expect(goodClaim.trialDisclaimerZh).toBe('未经医生检查，仅用于仿真')
  })

  it('replays historical asOf snapshots, excludes retired items in latest view, and computes structured diff', () => {
    const v1: KnowledgeSnapshot = {
      claims: [
        {
          anchor: validAnchor(),
          applicabilityCondition: { category: 'diagnosis', itemCodes: ['I25.103'], kind: 'fact', presence: 'present', requireEligible: true },
          associatedConceptCodes: ['coronary-artery-disease'],
          effectiveFrom: '2026-06-01T00:00:00Z',
          id: 'claim-1',
          packId: 'synthetic-test-syndrome',
          reviewerId: null,
          statementZh: '第一版表述',
          status: 'auto-verified',
          topicId: 'topic-1',
          version: '1.0.0',
        },
        {
          anchor: validAnchor(),
          applicabilityCondition: { category: 'diagnosis', itemCodes: ['I25.103'], kind: 'fact', presence: 'present', requireEligible: true },
          associatedConceptCodes: ['coronary-artery-disease'],
          effectiveFrom: '2026-06-01T00:00:00Z',
          id: 'claim-retired',
          packId: 'synthetic-test-syndrome',
          reviewerId: null,
          statementZh: '将在 v2 退役的主张',
          status: 'auto-verified',
          topicId: 'topic-1',
          version: '1.0.0',
        },
      ],
      effectiveFrom: '2026-06-01T00:00:00Z',
      snapshotVersion: '2026.06.v1',
      topics: [{
        effectiveFrom: '2026-06-01T00:00:00Z',
        id: 'topic-1',
        limitationsZh: ['仿真局限'],
        navigationZh: '导航',
        packId: 'synthetic-test-syndrome',
        references: [validAnchor()],
        reviewerId: null,
        status: 'auto-verified',
        titleZh: '专题1',
        version: '1.0.0',
      }],
    }

    const v2: KnowledgeSnapshot = {
      claims: [
        {
          anchor: validAnchor(),
          applicabilityCondition: { category: 'diagnosis', itemCodes: ['I25.103'], kind: 'fact', presence: 'present', requireEligible: true },
          associatedConceptCodes: ['coronary-artery-disease'],
          effectiveFrom: '2026-08-24T00:00:00Z',
          id: 'claim-1',
          packId: 'synthetic-test-syndrome',
          reviewerId: REVIEWER.reviewerId,
          statementZh: '第二版修订表述',
          status: 'published',
          topicId: 'topic-1',
          version: '2.0.0',
        },
        {
          anchor: validAnchor(),
          applicabilityCondition: { category: 'diagnosis', itemCodes: ['I25.103'], kind: 'fact', presence: 'present', requireEligible: true },
          associatedConceptCodes: ['coronary-artery-disease'],
          effectiveFrom: '2026-08-24T00:00:00Z',
          id: 'claim-retired',
          packId: 'synthetic-test-syndrome',
          reviewerId: null,
          statementZh: '将在 v2 退役的主张',
          status: 'superseded',
          supersededByClaimId: 'claim-1',
          topicId: 'topic-1',
          version: '2.0.0',
        },
        {
          anchor: validAnchor({
            locator: 'PDF 物理第 36 页',
            page: 36,
            quoteFragment: 'OCT is a reasonable alternative, except in ostial left main disease',
          }),
          applicabilityCondition: { category: 'diagnosis', itemCodes: ['I25.103'], kind: 'fact', presence: 'present', requireEligible: true },
          associatedConceptCodes: ['coronary-artery-disease'],
          effectiveFrom: '2026-08-24T00:00:00Z',
          id: 'claim-new-v2',
          packId: 'synthetic-test-syndrome',
          reviewerId: null,
          statementZh: 'v2 新增主张',
          status: 'auto-verified',
          topicId: 'topic-1',
          version: '2.0.0',
        },
      ],
      effectiveFrom: '2026-08-24T00:00:00Z',
      snapshotVersion: '2026.08.v2',
      topics: [{
        effectiveFrom: '2026-08-24T00:00:00Z',
        id: 'topic-1',
        limitationsZh: ['仿真局限'],
        navigationZh: '导航',
        packId: 'synthetic-test-syndrome',
        references: [validAnchor()],
        reviewerId: REVIEWER.reviewerId,
        status: 'published',
        titleZh: '专题1',
        version: '2.0.0',
      }],
    }

    const pastEval = evaluateKnowledgeSnapshotForPatient({
      asOf: '2026-06-15T00:00:00Z',
      ledger: makeLedger('2026-06-15T00:00:00Z'),
      packId: 'synthetic-test-syndrome',
      packVersion: '1.0.0',
      snapshots: [v1, v2],
      verifySourcePassage: corpusVerifier,
    })
    expect(pastEval.snapshotVersion).toBe('2026.06.v1')
    expect(pastEval.claims.map(c => c.id)).toEqual(['claim-1', 'claim-retired'])
    expect(pastEval.claims.every(c => c.active && c.trialDisclaimerZh === SIMULATION_TRIAL_DISCLAIMER_ZH)).toBe(true)

    const latestEval = evaluateKnowledgeSnapshotForPatient({
      ledger: makeLedger('2026-08-24T12:00:00+08:00'),
      packId: 'synthetic-test-syndrome',
      packVersion: '1.0.0',
      snapshots: [v1, v2],
      verifySourcePassage: corpusVerifier,
    })
    expect(latestEval.snapshotVersion).toBe('2026.08.v2')
    expect(latestEval.claims.map(c => c.id)).toEqual(['claim-1', 'claim-new-v2'])
    expect(latestEval.claims.find(c => c.id === 'claim-1')?.displayStageZh).toBe('正式版')
    expect(latestEval.claims.find(c => c.id === 'claim-1')?.trialDisclaimerZh).toBeNull()

    const diff = compareKnowledgeEvaluations(pastEval, latestEval)
    expect(diff.addedClaimIds).toEqual(['claim-new-v2'])
    expect(diff.removedOrRetiredClaimIds).toEqual(['claim-retired'])
    expect(diff.statusChanges).toEqual([
      { claimId: 'claim-1', fromStatus: 'auto-verified', toStatus: 'published' },
      { claimId: 'claim-retired', fromStatus: 'auto-verified', toStatus: 'superseded' },
    ])
    expect(diff.statementChanges).toEqual([
      { claimId: 'claim-1', fromStatementZh: '第一版表述', toStatementZh: '第二版修订表述' },
    ])
  })
})
