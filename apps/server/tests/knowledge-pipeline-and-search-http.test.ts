import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentToolCatalog } from '@clinmesh/contracts/agent'
import { diseasePackRuntimeBundleSchema } from '@clinmesh/contracts/disease-pack'
import { apiErrorSchema } from '@clinmesh/contracts/his'
import { listHisOperations } from '@clinmesh/contracts/his-operations'
import type { ClinicalReviewerRecord } from '@clinmesh/contracts/knowledge-claims'
import {
  SYNTHETIC_TEST_GUIDELINE_MARKER,
  adjudicateConflictResultSchema,
  conceptMappingImpactReportSchema,
  guidelineSourceDiffReportSchema,
  offlineGuidelineSearchResponseSchema,
  offlineKnowledgePipelineResultSchema,
  syntheticTestGuidelineDocSchema,
  type DraftedKnowledgeClaimCandidate,
} from '@clinmesh/contracts/knowledge-pipeline'
import { mergeThreeLayerConceptVocabulary, resolveLedgerFactsForConcept } from '@clinmesh/core/concept-vocabulary'
import { evaluatePackTrigger, validateAndParseDiseasePack } from '@clinmesh/core/disease-pack'
import { countOnlineKnowledgeAndVocabularyWriteTools } from '@clinmesh/core/knowledge-pipeline'
import { computeDiseasePackFingerprint } from '../src/application/disease-pack-runtime-service.ts'
import type { GuidelineDocument } from '../src/application/guideline-corpus.ts'
import { GuidelineCorpus } from '../src/infrastructure/sqlite/guideline-corpus.ts'
import { createPciPaymentDrgFixture, preparePciPaymentDrgFixture } from './fixtures/pci-payment-drg.ts'

const SYNTHETIC_PACK_DIR = resolve(import.meta.dirname, 'fixtures/disease-packs/synthetic-test-syndrome-pack')
const SYNTHETIC_GUIDELINES_DIR = resolve(import.meta.dirname, 'fixtures/synthetic-guidelines')

const REVIEWER: ClinicalReviewerRecord = {
  licenseVerified: true,
  nameZh: '陈主任',
  reviewerId: 'clinician-rev-http-560',
  specialty: 'cardiology',
}

function buildSignedPack(unsigned: Record<string, unknown> & { manifest: Record<string, unknown> }) {
  const parsed = validateAndParseDiseasePack(unsigned)
  const fingerprint = computeDiseasePackFingerprint(parsed as unknown as { manifest: Record<string, unknown> })
  return {
    ...unsigned,
    manifest: {
      ...unsigned.manifest,
      fingerprint,
    },
  }
}

describe('Offline Knowledge Pipeline, Diff/Impact Reports & Synonym Search (AC33–AC36)', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!()
    }
  })

  async function setupRuntime(options: {
    extraDocs?: GuidelineDocument[]
    extraPacks?: readonly unknown[]
    registeredClinicianReviewers?: readonly ClinicalReviewerRecord[]
  } = {}) {
    const prepared = await preparePciPaymentDrgFixture()
    cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))

    const guidelineDbPath = join(prepared.directory, 'guidelines.sqlite')
    const writer = new GuidelineCorpus({ databasePath: guidelineDbPath })
    cleanups.push(async () => writer.close())
    if (options.extraDocs !== undefined && options.extraDocs.length > 0) {
      writer.importDocuments(options.extraDocs)
    }
    prepared.options.guidelineDatabasePath = guidelineDbPath
    prepared.options.diseasePackDirs = [SYNTHETIC_PACK_DIR]
    prepared.options.diseasePackVerifyFingerprint = true
    prepared.options.registeredClinicianReviewers = [
      {
        licenseVerified: true,
        nameZh: '合成测试审核人',
        reviewerId: 'reviewer-syn-cardio-01',
        specialty: 'cardiology',
      },
      ...(options.registeredClinicianReviewers ?? []),
    ]
    if (options.extraPacks !== undefined) {
      prepared.options.diseasePacks = options.extraPacks
    }

    const fixture = await createPciPaymentDrgFixture(prepared)
    cleanups.push(() => fixture.runtime.close())
    return { fixture, guidelineDbPath, writer }
  }

  function currentEpoch(fixture: Awaited<ReturnType<typeof createPciPaymentDrgFixture>>): string {
    const row = fixture.runtime.database.driver.prepare(`
      SELECT epoch FROM scenario_run
      WHERE workspace_id = 'workspace-demo' AND status = 'active'
      ORDER BY started_at DESC LIMIT 1
    `).get() as { epoch: string } | undefined
    return row?.epoch ?? 'epoch-1'
  }

  it('AC33: guarantees 0 online write-knowledge/vocabulary tools and enforces controlled deterministic offline pipeline', async () => {
    // Verify online catalogs contain ZERO knowledge/vocabulary write operations or agent tools
    expect(countOnlineKnowledgeAndVocabularyWriteTools()).toBe(0)
    const nonReadAgentKnowledgeTools = agentToolCatalog.filter(tool => (
      tool.mode !== 'query'
      && /(?:^|[./_-])(?:knowledge|vocabulary|concept-vocabulary|guideline-(?:claims?|diff|adjudicate|draft))(?:$|[./_-])/i
        .test(`${tool.operationId} ${tool.toolName}`)
    ))
    expect(nonReadAgentKnowledgeTools).toEqual([])
    const nonReadHisKnowledgeOps = listHisOperations().filter(op => (
      op.risk !== 'read'
      && /(?:^|[./_-])(?:knowledge|vocabulary|concept-vocabulary|guideline-(?:claims?|diff|adjudicate|draft))(?:$|[./_-])/i
        .test(`${op.id} ${op.cliPath.join('.')} ${op.http.path}`)
    ))
    expect(nonReadHisKnowledgeOps).toEqual([])

    const { fixture, preparedModelCalls } = await (async () => {
      const prepared = await preparePciPaymentDrgFixture()
      cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))
      prepared.options.diseasePackDirs = [SYNTHETIC_PACK_DIR]
      prepared.options.diseasePackVerifyFingerprint = true
      prepared.options.registeredClinicianReviewers = [{
        licenseVerified: true,
        nameZh: '合成测试审核人',
        reviewerId: 'reviewer-syn-cardio-01',
        specialty: 'cardiology',
      }]
      const fx = await createPciPaymentDrgFixture(prepared)
      cleanups.push(() => fx.runtime.close())
      return { fixture: fx, preparedModelCalls: () => prepared.modelCalls }
    })()

    const v1Doc = syntheticTestGuidelineDocSchema.parse(
      JSON.parse(readFileSync(join(SYNTHETIC_GUIDELINES_DIR, 'synthetic-syndrome-guideline-v1.json'), 'utf8')),
    )

    // Non-admin roles receive 403 on all offline endpoints
    for (const role of ['doctor', 'pharmacist', 'registrar'] as const) {
      const denied = await fixture.request(role, '/api/his/v1/offline/knowledge-claims/draft-pipeline', {
        effectiveFrom: '2026-06-01T00:00:00Z',
        packId: 'synthetic-test-syndrome',
        snapshotVersion: '2026.06.v1',
        sourceDocument: v1Doc,
        topicId: 'syn-pci-guidance-card',
        version: '1.0.0',
      })
      expect(denied.status).toBe(403)
    }

    // Online Agent capability grant is rejected with 403 on offline pipeline endpoints
    const adminCookie = await fixture.login('admin')
    const clientRes = await fixture.runtime.app.request('/api/agent/v1/clients', {
      body: JSON.stringify({ name: 'ac33-check-agent' }),
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(clientRes.status).toBe(200)
    const { agentClientId } = (await clientRes.json()) as { agentClientId: string }
    const grantRes = await fixture.runtime.app.request('/api/agent/v1/grants', {
      body: JSON.stringify({
        agentClientId,
        operationIds: ['catalog.concept-vocabulary.read'],
        practitionerRoleId: 'practitioner-role-administrator',
        ttlSeconds: 300,
      }),
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(grantRes.status).toBe(200)
    const { token: agentToken } = (await grantRes.json()) as { token: string }
    const agentDenied = await fixture.runtime.app.request('/api/his/v1/offline/knowledge-claims/draft-pipeline', {
      body: JSON.stringify({
        effectiveFrom: '2026-06-01T00:00:00Z',
        packId: 'synthetic-test-syndrome',
        snapshotVersion: '2026.06.v1',
        sourceDocument: v1Doc,
        topicId: 'syn-pci-guidance-card',
        version: '1.0.0',
      }),
      headers: {
        authorization: `Bearer ${agentToken}`,
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(agentDenied.status).toBe(403)

    const validAnchor = {
      locator: 'PDF 物理第 35 页',
      page: 35,
      quoteFragment: 'In patients undergoing PCI, DES should be used in preference to BMS',
      sha256: v1Doc.sha256,
      sourceId: v1Doc.sourceId,
      title: v1Doc.title,
      version: v1Doc.version,
    }
    const condition = {
      category: 'diagnosis' as const,
      itemCodes: ['I25.103', 'SYN-DX-01'],
      kind: 'fact' as const,
      presence: 'present' as const,
      requireEligible: true,
    }

    const candidates: DraftedKnowledgeClaimCandidate[] = [
      {
        anchor: validAnchor,
        applicabilityCondition: condition,
        associatedConceptCodes: ['coronary-artery-disease', 'syn-syndrome-dx'],
        candidateId: 'http-cand-valid',
        claimId: 'syn-claim-des-v1',
        packId: 'synthetic-test-syndrome',
        statementZh: '拟行 PCI 的冠脉病变患者优先选择 DES 而非 BMS。',
        topicId: 'syn-pci-guidance-card',
      },
      {
        anchor: validAnchor,
        applicabilityCondition: condition,
        associatedConceptCodes: ['coronary-artery-disease'],
        candidateId: 'http-cand-ungrounded',
        optionalConditionsSpecified: {
          productQuantityNote: '28片/盒',
          thresholdNote: 'eGFR < 30 mL/min',
        },
        packId: 'synthetic-test-syndrome',
        statementZh: '拟行 PCI 的患者优先选择 DES。',
        topicId: 'syn-pci-guidance-card',
      },
      {
        anchor: { ...validAnchor, quoteFragment: 'NONEXISTENT QUOTE' },
        applicabilityCondition: condition,
        associatedConceptCodes: ['coronary-artery-disease'],
        candidateId: 'http-cand-bad-quote',
        packId: 'synthetic-test-syndrome',
        statementZh: '无效引文主张',
        topicId: 'syn-pci-guidance-card',
      },
      {
        applicabilityCondition: condition,
        associatedConceptCodes: ['coronary-artery-disease'],
        candidateId: 'http-cand-no-anchor',
        packId: 'synthetic-test-syndrome',
        statementZh: '缺锚点主张',
        topicId: 'syn-pci-guidance-card',
      },
      {
        anchor: validAnchor,
        applicabilityCondition: condition,
        associatedConceptCodes: ['unknown-concept-xyz'],
        candidateId: 'http-cand-unmapped',
        packId: 'synthetic-test-syndrome',
        statementZh: '未知概念编码主张',
        topicId: 'syn-pci-guidance-card',
      },
    ]

    const trialRes = await fixture.request('admin', '/api/his/v1/offline/knowledge-claims/draft-pipeline', {
      candidates,
      effectiveFrom: '2026-06-01T00:00:00Z',
      packId: 'synthetic-test-syndrome',
      snapshotVersion: '2026.06.v1',
      sourceDocument: v1Doc,
      topicId: 'syn-pci-guidance-card',
      version: '1.0.0',
    })
    expect(trialRes.status).toBe(200)
    const trial = offlineKnowledgePipelineResultSchema.parse(await trialRes.json())
    expect(preparedModelCalls()).toBe(0)
    expect(trial.modelStreamMode).toBe('controlled-deterministic')
    expect(trial.runtimeWriteToolsCount).toBe(0)
    expect(trial.acceptedClaims).toHaveLength(1)
    expect(trial.acceptedClaims[0]!.status).toBe('auto-verified')
    expect(trial.acceptedClaims[0]!.reviewerId).toBeNull()
    expect(trial.rejectedClaims.map(r => r.code)).toEqual([
      'CLAIM_UNSUPPORTED_DETAIL',
      'CLAIM_QUOTE_MISMATCH',
      'CLAIM_ANCHOR_MISSING',
      'CLAIM_CONCEPT_UNMAPPED',
    ])

    // Offline draft pipeline strictly caps at auto-verified; even with clinicianReviewer it rejects 403
    const pubRes = await fixture.request('admin', '/api/his/v1/offline/knowledge-claims/draft-pipeline', {
      candidates: [candidates[0]!],
      clinicianReviewer: REVIEWER,
      effectiveFrom: '2026-06-01T00:00:00Z',
      packId: 'synthetic-test-syndrome',
      snapshotVersion: '2026.06.v1-pub',
      sourceDocument: v1Doc,
      topicId: 'syn-pci-guidance-card',
      version: '1.0.0',
    })
    expect(pubRes.status).toBe(403)
    expect(apiErrorSchema.parse(await pubRes.json()).error.code).toBe('KNOWLEDGE_CLINICIAN_REVIEWER_REQUIRED')

    const auditRows = fixture.runtime.database.driver.prepare(`
      SELECT operation, outcome FROM audit_log WHERE operation = 'offline.knowledge-claims.draft-pipeline'
    `).all() as Array<{ operation: string; outcome: string }>
    expect(auditRows.some(r => r.outcome === 'success')).toBe(true)
  })

  it('AC34: builds synthetic v1 -> v2 guideline diff report and holds conflicts in expert adjudication queue without overwriting existing claims', async () => {
    const { fixture } = await setupRuntime({ registeredClinicianReviewers: [REVIEWER] })
    const v1Doc = syntheticTestGuidelineDocSchema.parse(
      JSON.parse(readFileSync(join(SYNTHETIC_GUIDELINES_DIR, 'synthetic-syndrome-guideline-v1.json'), 'utf8')),
    )
    const v2Doc = syntheticTestGuidelineDocSchema.parse(
      JSON.parse(readFileSync(join(SYNTHETIC_GUIDELINES_DIR, 'synthetic-syndrome-guideline-v2.json'), 'utf8')),
    )
    expect(v1Doc.syntheticTestMarker).toBe(SYNTHETIC_TEST_GUIDELINE_MARKER)
    expect(v2Doc.disclaimerZh).toContain('不冒充真实临床指南')

    // Build baseline v1 snapshot via offline pipeline
    const v1PipeRes = await fixture.request('admin', '/api/his/v1/offline/knowledge-claims/draft-pipeline', {
      effectiveFrom: '2026-06-01T00:00:00Z',
      packId: 'synthetic-test-syndrome',
      snapshotVersion: '2026.06.v1',
      sourceDocument: v1Doc,
      topicId: 'syn-pci-guidance-card',
      version: '1.0.0',
    })
    expect(v1PipeRes.status).toBe(200)
    const v1Snapshot = offlineKnowledgePipelineResultSchema.parse(await v1PipeRes.json()).publishedSnapshot!
    expect(v1Snapshot.claims).toHaveLength(2)

    const v2ConflictCandidate: DraftedKnowledgeClaimCandidate = {
      anchor: {
        locator: 'PDF 物理第 35 页',
        page: 35,
        quoteFragment: 'In patients undergoing PCI, new-generation DES should be used in preference to BMS',
        sha256: v2Doc.sha256,
        sourceId: v2Doc.sourceId,
        title: v2Doc.title,
        version: v2Doc.version,
      },
      applicabilityCondition: {
        category: 'diagnosis',
        itemCodes: ['I25.103', 'SYN-DX-01'],
        kind: 'fact',
        presence: 'present',
        requireEligible: true,
      },
      associatedConceptCodes: ['coronary-artery-disease', 'syn-syndrome-dx'],
      candidateId: 'v2-des-cand',
      claimId: 'syn-pci-guidance-card-claim-1-v2',
      packId: 'synthetic-test-syndrome',
      statementZh: 'v2 修订主张：PCI 治疗优先选用新一代药物洗脱支架（DES）并评估出血及支架内血栓风险。',
      topicId: 'syn-pci-guidance-card',
      version: '2.0.0',
    }

    const diffRes = await fixture.request('admin', '/api/his/v1/offline/guidelines/diff-report', {
      packId: 'synthetic-test-syndrome',
      snapshot: v1Snapshot,
      v1Document: v1Doc,
      v2Candidates: [v2ConflictCandidate],
      v2Document: v2Doc,
    })
    expect(diffRes.status).toBe(200)
    const report = guidelineSourceDiffReportSchema.parse(await diffRes.json())
    expect(report.syntheticDisclaimerZh).toContain('不冒充真实临床指南')
    expect(report.changedPassages.map(p => [p.page, p.changeKind])).toEqual([
      [35, 'modified'],
      [37, 'added'],
    ])
    expect(report.affectedTopicIds).toEqual(['syn-pci-guidance-card'])
    expect(report.affectedClaimIds).toEqual(['syn-pci-guidance-card-claim-1'])
    expect(report.unchangedExistingClaimIds).toEqual(['syn-pci-guidance-card-claim-2'])
    expect(report.affectedRuleIds).toEqual(expect.arrayContaining([
      'trigger:synthetic-dx-trigger',
      'stage:baseline-assessment',
      'readiness-task:pci-preop-guideline-advice',
      'indication:creatinine-workup-indication',
    ]))
    expect(report.affectedExamCaseIds).toEqual([
      'syn-exam-case-1',
      'syn-exam-inpatient-severe',
      'syn-exam-red-line',
      'syn-exam-standard-mild',
    ])

    // Conflict enters expertAdjudicationQueue while existing claim remains untouched
    expect(report.expertAdjudicationQueue).toHaveLength(1)
    const queued = report.expertAdjudicationQueue[0]!
    expect(queued.status).toBe('pending-adjudication')
    expect(queued.existingClaim.statementZh).toBe(v1Snapshot.claims[0]!.statementZh)
    expect(queued.existingClaim.status).toBe('auto-verified')
    expect(report.snapshot.claims[0]!.statementZh).toBe(v1Snapshot.claims[0]!.statementZh)
    expect(report.snapshot.claims[0]!.status).toBe('auto-verified')

    // Unverified reviewer fails adjudication with 403 KNOWLEDGE_CLINICIAN_REVIEWER_REQUIRED
    const badAdjudicate = await fixture.request('admin', '/api/his/v1/offline/guidelines/adjudicate-conflict', {
      adjudication: {
        conflictId: queued.conflictId,
        decision: 'adopt-new',
        rationaleZh: '未核验执业',
        reviewer: { ...REVIEWER, licenseVerified: false },
      },
      report,
      snapshot: v1Snapshot,
    })
    expect(badAdjudicate.status).toBe(403)
    expect(apiErrorSchema.parse(await badAdjudicate.json()).error.code).toBe('KNOWLEDGE_CLINICIAN_REVIEWER_REQUIRED')

    // Unregistered reviewer claiming licenseVerified: true fails adjudication with 403 KNOWLEDGE_CLINICIAN_REVIEWER_REQUIRED
    const forgedAdjudicate = await fixture.request('admin', '/api/his/v1/offline/guidelines/adjudicate-conflict', {
      adjudication: {
        conflictId: queued.conflictId,
        decision: 'adopt-new',
        rationaleZh: '自称持证但未在服务端名单登记',
        reviewer: { ...REVIEWER, reviewerId: 'forged-reviewer-999' },
      },
      report,
      snapshot: v1Snapshot,
    })
    expect(forgedAdjudicate.status).toBe(403)
    expect(apiErrorSchema.parse(await forgedAdjudicate.json()).error.code).toBe('KNOWLEDGE_CLINICIAN_REVIEWER_REQUIRED')

    // Missing conflictId returns 404 CONFLICT_NOT_FOUND (not 500 INTERNAL_ERROR)
    const missingConflictRes = await fixture.request('admin', '/api/his/v1/offline/guidelines/adjudicate-conflict', {
      adjudication: {
        conflictId: 'nonexistent-conflict-id',
        decision: 'keep-existing',
        rationaleZh: '测试未知冲突编号映射 404',
        reviewer: REVIEWER,
      },
      report,
      snapshot: v1Snapshot,
    })
    expect(missingConflictRes.status).toBe(404)
    expect(apiErrorSchema.parse(await missingConflictRes.json()).error.code).toBe('CONFLICT_NOT_FOUND')

    // Verified clinician adjudicates and adopts the new claim
    const okAdjudicate = await fixture.request('admin', '/api/his/v1/offline/guidelines/adjudicate-conflict', {
      adjudication: {
        conflictId: queued.conflictId,
        decision: 'adopt-new',
        rationaleZh: '核对 v2 修订原文后批准替换旧主张',
        reviewer: REVIEWER,
      },
      effectiveFrom: '2026-08-24T00:00:00Z',
      report,
      snapshot: v1Snapshot,
    })
    expect(okAdjudicate.status).toBe(200)
    const adjudicated = adjudicateConflictResultSchema.parse(await okAdjudicate.json())
    expect(adjudicated.resolvedConflict.status).toBe('adopted-new')
    expect(adjudicated.updatedSnapshot.claims.find(c => c.id === queued.existingClaimId)?.status).toBe('superseded')
    expect(adjudicated.updatedSnapshot.claims.find(c => c.id === 'syn-pci-guidance-card-claim-1-v2')).toMatchObject({
      reviewerId: REVIEWER.reviewerId,
      status: 'published',
    })
  })

  it('AC35: reports historical facts, pack rules, claims & exam cases affected when exact mapping downgrades to close and excludes it from runtime scoring/red-line', async () => {
    const exactPackVocab = {
      mappings: [
        {
          effectiveDate: '2026-01-01',
          id: 'hs-pack-exact-syn',
          relation: 'exact' as const,
          reviewStatus: 'approved' as const,
          reviewerId: 'reviewer-cardio',
          sourceCode: 'SYN-HS-CTNI',
          sourceDisplay: '合成高敏肌钙蛋白I',
          sourceSystem: 'urn:clinmesh:synthetic',
          targetConceptCode: '89579-7',
          version: '1.0.0',
        },
      ],
      nodes: [],
      version: '1.0.0',
    }
    const downgradedPackVocab = {
      mappings: [
        {
          effectiveDate: '2026-01-01',
          id: 'hs-pack-exact-syn',
          notesZh: '降级为相近映射，退出算分与红线拦截',
          relation: 'close' as const,
          reviewStatus: 'approved' as const,
          reviewerId: 'reviewer-cardio',
          sourceCode: 'SYN-HS-CTNI',
          sourceDisplay: '合成高敏肌钙蛋白I',
          sourceSystem: 'urn:clinmesh:synthetic',
          targetConceptCode: '89579-7',
          version: '1.1.0',
        },
      ],
      nodes: [],
      version: '1.1.0',
    }

    const hsTnPack = buildSignedPack({
      conceptVocabulary: exactPackVocab,
      examSuite: {
        cases: [{ caseId: 'hs-case-1', expectedActive: true, titleZh: '高敏肌钙蛋白触发例' }],
        passThreshold: 0.8,
      },
      knowledgeSnapshots: [
        {
          claims: [
            {
              anchor: {
                locator: 'PDF 物理第 1 页',
                page: 1,
                quoteFragment: 'High-sensitivity troponin I >= 50 ng/L requires urgent evaluation',
                sha256: 'a'.repeat(64),
                sourceId: 'syn-troponin-src',
                title: '合成高敏肌钙蛋白指导意见',
                version: '1.0.0',
              },
              applicabilityCondition: {
                category: 'laboratory',
                itemCodes: ['89579-7'],
                kind: 'fact',
                minValue: 50,
                presence: 'present',
                requireEligible: true,
              },
              associatedConceptCodes: ['89579-7'],
              effectiveFrom: '2026-06-01T00:00:00Z',
              id: 'hs-claim-urgent-eval',
              packId: 'hs-troponin-pack',
              reviewerId: null,
              statementZh: '高敏肌钙蛋白 I >= 50 ng/L 需立即评估。',
              status: 'auto-verified',
              topicId: 'hs-troponin-topic',
              version: '1.0.0',
            },
          ],
          effectiveFrom: '2026-06-01T00:00:00Z',
          snapshotVersion: '1.0.0',
          topics: [
            {
              effectiveFrom: '2026-06-01T00:00:00Z',
              id: 'hs-troponin-topic',
              limitationsZh: ['合成测试'],
              navigationZh: '合成高敏肌钙蛋白导航',
              packId: 'hs-troponin-pack',
              references: [{
                locator: 'PDF 物理第 1 页',
                page: 1,
                quoteFragment: 'High-sensitivity troponin I >= 50 ng/L requires urgent evaluation',
                sha256: 'a'.repeat(64),
                sourceId: 'syn-troponin-src',
                title: '合成高敏肌钙蛋白指导意见',
                version: '1.0.0',
              }],
              reviewerId: null,
              status: 'auto-verified',
              titleZh: '高敏肌钙蛋白专题',
              version: '1.0.0',
            },
          ],
        },
      ],
      manifest: {
        dependencies: [],
        fingerprint: '0'.repeat(64),
        id: 'hs-troponin-pack',
        packType: 'recognition',
        specialty: 'cardiology',
        status: 'active',
        supportedTasks: ['triage'],
        titleEn: 'High-sensitivity Troponin Recognition Pack',
        titleZh: '高敏肌钙蛋白识别专病包',
        version: '1.0.0',
      },
      qualityTightenings: {
        examPassThreshold: 0.8,
        redLineRules: [
          {
            conditionSummary: '高敏肌钙蛋白升高红线拦截未复核出院',
            id: 'hs-ctni-red-line',
            itemCode: '89579-7',
          },
        ],
        validityOverrides: [],
      },
      recognitionCard: {
        differentialPackIds: [],
        escalationGuidanceZh: '提示进一步心内科急诊评估',
        id: 'hs-troponin-card',
        summaryZh: '高敏肌钙蛋白升高识别',
        titleZh: '高敏肌钙蛋白升高',
      },
      toolPolicy: { allowedTools: ['inpatient.disease-packs.read'], forbiddenActions: [] },
      triggers: [
        {
          condition: {
            category: 'laboratory',
            itemCodes: ['89579-7'],
            kind: 'fact',
            minValue: 50,
            presence: 'present',
            requireEligible: true,
          },
          id: 'hs-ctni-elevated',
        },
      ],
    })

    const { fixture } = await setupRuntime({ extraPacks: [hsTnPack] })
    const stay = await fixture.preparePciAdmission([])
    const epoch = currentEpoch(fixture)

    const obsId = `obs-syn-hs-ctni-${randomUUID()}`
    fixture.runtime.fhir.create({ epoch, workspaceId: 'workspace-demo' }, {
      category: [{ coding: [{ code: 'laboratory', system: 'http://terminology.hl7.org/CodeSystem/observation-category' }] }],
      code: { coding: [{ code: 'SYN-HS-CTNI', display: '合成高敏肌钙蛋白 I', system: 'urn:clinmesh:synthetic' }] },
      effectiveDateTime: '2026-08-24T08:45:00+08:00',
      encounter: { reference: `Encounter/${stay.admissionId}` },
      id: obsId,
      issued: '2026-08-24T08:50:00+08:00',
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: `Patient/${stay.patientId}` },
      valueQuantity: { code: 'ng/L', system: 'http://unitsofmeasure.org', unit: 'ng/L', value: 120 },
    })

    // Confirm pack activates before downgrade
    const beforePacks = await fixture.read('inpatient-doctor', `${stay.path}/disease-packs`, diseasePackRuntimeBundleSchema)
    expect(beforePacks.packs.find(p => p.packId === 'hs-troponin-pack')?.activationStatus).toBe('active')

    // Call offline impact-report endpoint
    const impactRes = await fixture.request('admin', '/api/his/v1/offline/concept-mappings/impact-report', {
      admissionId: stay.admissionId,
      afterVocabulary: downgradedPackVocab,
      asOfDate: '2026-08-24',
      packId: 'hs-troponin-pack',
    })
    expect(impactRes.status).toBe(200)
    const impact = conceptMappingImpactReportSchema.parse(await impactRes.json())
    expect(impact.downgradedMappingIds).toEqual(['hs-pack-exact-syn'])
    expect(impact.affectedHistoricalFactIds).toHaveLength(1)
    expect(impact.affectedHistoricalFacts[0]).toMatchObject({
      itemCode: 'SYN-HS-CTNI',
      mappingId: 'hs-pack-exact-syn',
      reasonCode: 'MAPPING_CLOSE_HINT_ONLY',
      stillEligibleForScoringAndRedLine: false,
    })
    expect(impact.affectedRuleIds).toEqual(expect.arrayContaining([
      'trigger:hs-ctni-elevated',
      'red-line:hs-ctni-red-line',
    ]))
    expect(impact.affectedClaimIds).toEqual(['hs-claim-urgent-eval'])
    expect(impact.affectedExamCaseIds).toEqual(['hs-case-1'])

    // Prove downgraded vocabulary excludes historical fact from scoring & trigger evaluation
    const ledger = fixture.runtime.workflow.clinicalFactLedger.buildInternalLedger(
      { actorId: 'test', epoch, roleCode: 'administrator', scenarioRunId: 'run-1', workspaceId: 'workspace-demo' },
      { id: stay.admissionId, kind: 'inpatient', patientId: stay.patientId },
      { asOf: '2026-08-24T12:00:00+08:00', includeSuperseded: false },
    )
    const afterMergedVocab = mergeThreeLayerConceptVocabulary({ packLayer: downgradedPackVocab })
    expect(resolveLedgerFactsForConcept({
      asOfDate: '2026-08-24',
      ledger,
      mode: 'scoring-or-redline',
      targetConceptCode: '89579-7',
      vocabulary: afterMergedVocab,
    }).facts).toEqual([])
    const effective = fixture.runtime.workflow.diseasePacks.registry.getEffective('hs-troponin-pack')
    expect(evaluatePackTrigger(
      effective.pack.triggers[0]!.condition,
      ledger,
      { asOf: '2026-08-24T12:00:00+08:00', vocabulary: afterMergedVocab },
    ).matched).toBe(false)
  })

  it('AC36: expands GuidelineCorpus.search("心梗") to match "心肌梗死" passages via approved exact synonyms only', async () => {
    const miDoc: GuidelineDocument = {
      passages: [
        {
          locator: 'PDF 物理第 12 页',
          text: '急性心肌梗死患者应立即完善12导联心电图及高敏肌钙蛋白检查。',
        },
        {
          locator: 'PDF 物理第 13 页',
          text: 'Limitations of retrospective observational studies should be noted.',
        },
      ],
      source: {
        documentType: 'guideline',
        format: 'pdf',
        id: 'synthetic-mi-guideline',
        license: { id: 'CC0', url: 'https://example.test/license', usage: 'open' },
        population: 'adult',
        publisher: '合成心血管指南机构',
        scope: '仅用于同义扩展检索测试',
        sha256: 'e'.repeat(64),
        specialty: 'cardiology',
        status: 'active',
        title: '合成急性心肌梗死诊疗测试指南',
        topics: [{ diagnosisQueries: ['心肌梗死'], terms: ['心肌梗死'] }],
        url: 'https://example.test/mi-guideline',
        version: '2026',
      },
    }

    const closeDistractorDoc: GuidelineDocument = {
      passages: [
        {
          locator: 'PDF 物理第 5 页',
          text: '心前区不适患者需排除非心源性因素。',
        },
        {
          locator: 'PDF 物理第 6 页',
          text: '未审核别名仅用于待审测试，不应通过同义扩展召回。',
        },
      ],
      source: {
        documentType: 'guideline',
        format: 'pdf',
        id: 'synthetic-close-distractor',
        license: { id: 'CC0', url: 'https://example.test/license', usage: 'open' },
        population: 'adult',
        publisher: '合成对照机构',
        scope: '仅用于非exact/未审核过滤验证',
        sha256: 'f'.repeat(64),
        specialty: 'cardiology',
        status: 'active',
        title: '合成胸痛鉴别测试指南',
        topics: [{ diagnosisQueries: ['胸壁痛'], terms: ['心前区不适'] }],
        url: 'https://example.test/distractor',
        version: '2026',
      },
    }

    const vocabWithUnapproved = mergeThreeLayerConceptVocabulary({
      packLayer: {
        mappings: [
          {
            effectiveDate: '2026-01-01',
            id: 'test-close-mi-alias',
            relation: 'close',
            reviewStatus: 'approved',
            reviewerId: 'rev-1',
            sourceCode: 'CLOSE-CHEST-DISCOMFORT',
            sourceDisplay: '心前区不适',
            sourceSystem: 'urn:syn',
            targetConceptCode: 'myocardial-infarction',
            version: '1.0.0',
          },
          {
            effectiveDate: '2026-01-01',
            id: 'test-proposed-mi-alias',
            relation: 'exact',
            reviewStatus: 'proposed',
            reviewerId: null,
            sourceCode: 'PROP-MI-ALIAS',
            sourceDisplay: '未审核别名',
            sourceSystem: 'urn:syn',
            targetConceptCode: 'myocardial-infarction',
            version: '1.0.0',
          },
        ],
        nodes: [],
        version: '1.0.0',
      },
    })

    const { fixture, writer } = await setupRuntime({ extraDocs: [miDoc, closeDistractorDoc] })

    // Direct GuidelineCorpus.search('心梗')
    const direct = writer.search('心梗', { vocabulary: vocabWithUnapproved })
    expect(direct.guidelines.map(item => item.text)).toEqual([miDoc.passages[0]!.text])
    expect(direct.diagnosisQueries).toEqual(['心肌梗死'])
    expect(direct.expandedTerms).toEqual(expect.arrayContaining([
      {
        conceptCode: 'myocardial-infarction',
        expandedTerm: '心肌梗死',
        mappingId: 'pub-map-mi-zh-full',
        queryTerm: '心梗',
      },
    ]))
    expect(direct.expandedTerms?.some(item => item.expandedTerm === '心前区不适' || item.expandedTerm === '未审核别名')).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(direct))).toBeLessThanOrEqual(48 * 1024)

    // Backwards compatibility: unmatched query retains exact 4 keys without expandedTerms
    const miss = writer.search('unknown-nonexistent-condition', { vocabulary: vocabWithUnapproved })
    expect(Object.keys(miss).sort()).toEqual(['diagnosisQueries', 'guidelines', 'inactiveSources', 'revision'])
    expect(miss.guidelines).toEqual([])

    // Offline HTTP search route returns identical synonym-expanded match
    const httpRes = await fixture.request('admin', '/api/his/v1/offline/guidelines/search', {
      population: 'adult',
      query: '心梗',
      vocabulary: vocabWithUnapproved,
    })
    expect(httpRes.status).toBe(200)
    const parsedHttp = offlineGuidelineSearchResponseSchema.parse(await httpRes.json())
    expect(parsedHttp.guidelines.map(item => item.text)).toEqual([miDoc.passages[0]!.text])
    expect(parsedHttp.expandedTerms).toEqual(direct.expandedTerms)

    // Unknown keys alongside { input } wrapper MUST reject 400 under strict wrapper check
    const bogusWrapperRes = await fixture.runtime.app.request('/api/his/v1/offline/guidelines/search', {
      body: JSON.stringify({
        expectedVersions: { unexpected: '1' },
        input: { population: 'adult', query: '心梗' },
      }),
      headers: {
        'content-type': 'application/json',
        cookie: await fixture.login('admin'),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(bogusWrapperRes.status).toBe(400)

    // Large passages with expandedTerms still respect the 48 KiB JSON byte ceiling
    const largeMiDoc: GuidelineDocument = {
      passages: Array.from({ length: 10 }, (_, idx) => ({
        locator: `大段落第 ${idx + 1} 节`,
        text: `急性心肌梗死。${'合成长段落用于校验序列化预算。'.repeat(650)}必须完成诊断核对。`,
      })),
      source: {
        ...miDoc.source,
        id: 'synthetic-large-mi-guideline',
        sha256: 'd'.repeat(64),
        title: '合成大体积心肌梗死测试指南',
      },
    }
    writer.importDocument(largeMiDoc)
    const budgeted = writer.search('心梗', { vocabulary: vocabWithUnapproved })
    expect(budgeted.guidelines.length).toBeGreaterThan(0)
    expect(budgeted.guidelines.length).toBeLessThanOrEqual(8)
    expect(budgeted.expandedTerms).toBeDefined()
    expect(Buffer.byteLength(JSON.stringify(budgeted))).toBeLessThanOrEqual(48 * 1024)
  })
})
