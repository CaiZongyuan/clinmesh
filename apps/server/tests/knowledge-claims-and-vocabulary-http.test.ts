import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { conceptVocabularyCatalogResponseSchema } from '@clinmesh/contracts/concept-vocabulary'
import { diseasePackRuntimeBundleSchema } from '@clinmesh/contracts/disease-pack'
import {
  apiErrorSchema,
  clinicalCatalogSchema,
  commandResponseSchema,
  confirmDiagnosisResponseSchema,
  diagnosisDraftResponseSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  registrationCatalogSchema,
  scenarioStateSchema,
  startVisitResponseSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { inpatientPciDataResponseSchema, pciCaseSourceResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import {
  SIMULATION_TRIAL_DISCLAIMER_ZH,
  diseasePackKnowledgeEvaluationSchema,
} from '@clinmesh/contracts/knowledge-claims'
import { startSyntheticCaseResultSchema } from '@clinmesh/contracts/scenario'
import { validateAndParseDiseasePack } from '@clinmesh/core/disease-pack'
import { computeDiseasePackFingerprint } from '../src/application/disease-pack-runtime-service.ts'
import type { GuidelineDocument } from '../src/application/guideline-corpus.ts'
import { GuidelineCorpus } from '../src/infrastructure/sqlite/guideline-corpus.ts'
import {
  createPciPaymentDrgFixture,
  parsePciResponse,
  preparePciPaymentDrgFixture,
  type PciPaymentDrgFixture,
} from './fixtures/pci-payment-drg.ts'

const SYNTHETIC_PACK_DIR = resolve(import.meta.dirname, 'fixtures/disease-packs/synthetic-test-syndrome-pack')

const SHA_GUIDE_1 = '9843131ad84f9a261ceb8857025e656a067496472edabfb6bd2b6297f2c5ff0e'
const SHA_GUIDE_2 = 'c2018438f6bfe9abf39cdfa813f6a6312de858bb6047ce18d9a01bff222ae9ad'

const pciParagraphs = [
  'In patients undergoing PCI, DES should be used in preference to BMS. Synthetic test passage; assess the clinical population.',
  'IVUS can be useful, particularly in left main or complex coronary artery stenting. OCT is a reasonable alternative, except in ostial left main disease.',
  'Evaluate both proximal and distal reference segments, with lumen, EEM, and plaque measurements. With manual pullback, length cannot be measured without a longitudinal acquisition.',
]

function pciDocuments(): GuidelineDocument[] {
  return [
    {
      hash: SHA_GUIDE_1,
      id: 'coronary-10-2021',
      pages: [35, 36],
      texts: pciParagraphs.slice(0, 2),
      title: '合成血运重建指南测试原文',
    },
    {
      hash: SHA_GUIDE_2,
      id: 'coronary-15-2021',
      pages: [6],
      texts: pciParagraphs.slice(2),
      title: '合成CVIT测量共识测试原文',
    },
  ].map(item => ({
    passages: item.pages.map((page, idx) => ({ locator: `PDF 物理第 ${page} 页`, text: item.texts[idx]! })),
    source: {
      documentType: 'guideline',
      format: 'pdf',
      id: item.id,
      license: { id: 'CC0', url: 'https://example.test/license', usage: 'open' },
      population: 'adult',
      publisher: '合成验收机构',
      scope: '仅用于合成HTTP合同，非真实临床原件',
      sha256: item.hash,
      specialty: 'cardiology',
      status: 'active',
      title: item.title,
      topics: [],
      url: `https://example.test/${item.id}`,
      version: '2021',
    },
  }))
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

describe('Concept Vocabulary & Knowledge Claims HTTP Contracts (AC8, AC9, AC15)', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!()
    }
  })

  async function setupRuntime(options: {
    withGuidelineCorpus?: boolean
    extraPacks?: readonly unknown[]
  } = {}) {
    const prepared = await preparePciPaymentDrgFixture()
    cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))

    if (options.withGuidelineCorpus) {
      const guidelineDbPath = join(prepared.directory, 'guidelines.sqlite')
      const writer = new GuidelineCorpus({ databasePath: guidelineDbPath })
      cleanups.push(async () => writer.close())
      writer.importDocuments(pciDocuments())
      prepared.options.guidelineDatabasePath = guidelineDbPath
    }

    prepared.options.diseasePackDirs = [SYNTHETIC_PACK_DIR]
    prepared.options.diseasePackVerifyFingerprint = true
    if (options.extraPacks !== undefined) {
      prepared.options.diseasePacks = options.extraPacks
    }

    const fixture = await createPciPaymentDrgFixture(prepared)
    cleanups.push(() => fixture.runtime.close())
    return { fixture }
  }

  function currentEpoch(fixture: PciPaymentDrgFixture): string {
    const row = fixture.runtime.database.driver.prepare(`
      SELECT epoch FROM scenario_run
      WHERE workspace_id = 'workspace-demo' AND status = 'active'
      ORDER BY started_at DESC LIMIT 1
    `).get() as { epoch: string } | undefined
    return row?.epoch ?? 'epoch-1'
  }

  it('exposes 3-layer concept vocabulary catalog with AC9 eligibility rules, synonym query expansion & role gate', async () => {
    const { fixture } = await setupRuntime({ withGuidelineCorpus: true })

    // Role isolation: pharmacist and registrar cannot read clinical concept vocabulary catalog
    const pharmRes = await fixture.request('pharmacist', '/api/his/v1/catalogs/concept-vocabulary')
    expect(pharmRes.status).toBe(403)
    const regRes = await fixture.request('registrar', '/api/his/v1/catalogs/concept-vocabulary')
    expect(regRes.status).toBe(403)

    // Unknown packId returns 404
    const missingPack = await fixture.request('doctor', '/api/his/v1/catalogs/concept-vocabulary?packId=unknown-pack')
    expect(missingPack.status).toBe(404)

    // Doctor reads catalog scoped to synthetic-test-syndrome with synonym expansion for '心梗'
    const catalog = await fixture.read(
      'doctor',
      `/api/his/v1/catalogs/concept-vocabulary?packId=synthetic-test-syndrome&query=${encodeURIComponent('心梗')}&asOf=2026-08-24`,
      conceptVocabularyCatalogResponseSchema,
    )
    expect(catalog.packIds).toEqual(['synthetic-test-syndrome'])
    expect(catalog.vocabulary.nodes.some(n => n.code === 'pharmacology-class')).toBe(true)
    expect(catalog.vocabulary.nodes.some(n => n.code === 'syn-syndrome-dx' && n.layer === 'disease-pack')).toBe(true)
    expect(catalog.expandedQueryTerms).toEqual(expect.arrayContaining(['心梗', '心肌梗死', 'myocardial-infarction']))
    expect(catalog.expandedQueryTerms).not.toContain('SYN-CTNT-PROP')

    const closeRule = catalog.mappingEligibility.find(e => e.mappingId === 'syn-map-ctni-close-hs')!
    expect(closeRule.eligibleForScoreAndRedLine).toBe(false)
    expect(closeRule.usableForHint).toBe(true)
    expect(closeRule.reasonCode).toBe('MAPPING_CLOSE_HINT_ONLY')
    expect(closeRule.explanationZh).toBe('仅作为相近映射提示，不参与临床算分与红线拦截')

    const exactRule = catalog.mappingEligibility.find(e => e.mappingId === 'syn-map-hs-ctni-exact')!
    expect(exactRule.eligibleForScoreAndRedLine).toBe(true)
    expect(exactRule.reasonCode).toBe('ELIGIBLE_EXACT')

    const proposedRule = catalog.mappingEligibility.find(e => e.mappingId === 'syn-map-ctnt-proposed')!
    expect(proposedRule.eligibleForScoreAndRedLine).toBe(false)
    expect(proposedRule.usableForHint).toBe(false)
    expect(proposedRule.reasonCode).toBe('MAPPING_NOT_APPROVED')
  })

  it('AC9 runtime trigger gate: close mapping 10839-9 never triggers hs-cTnI rule while approved exact mapping activates', async () => {
    const hsTnPack = buildSignedPack({
      conceptVocabulary: {
        mappings: [
          {
            effectiveDate: '2026-01-01',
            id: 'hs-pack-close-ctni',
            relation: 'close',
            reviewStatus: 'approved',
            reviewerId: 'reviewer-cardio',
            sourceCode: '10839-9',
            sourceDisplay: '常规cTnI',
            sourceSystem: 'http://loinc.org',
            targetConceptCode: '89579-7',
            version: '1.0.0',
          },
          {
            effectiveDate: '2026-01-01',
            id: 'hs-pack-exact-syn',
            relation: 'exact',
            reviewStatus: 'approved',
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
      },
      examSuite: {
        cases: [{ caseId: 'hs-case-1', expectedActive: true, titleZh: '高敏肌钙蛋白触发例' }],
        passThreshold: 0.8,
      },
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

    const { fixture } = await setupRuntime({ extraPacks: [hsTnPack], withGuidelineCorpus: true })
    const stay = await fixture.preparePciAdmission([])
    const epoch = currentEpoch(fixture)

    // Inject conventional cTnI (10839-9) -> close mapping MUST NOT activate hs-troponin-pack!
    fixture.runtime.fhir.create({ epoch, workspaceId: 'workspace-demo' }, {
      category: [{ coding: [{ code: 'laboratory', system: 'http://terminology.hl7.org/CodeSystem/observation-category' }] }],
      code: { coding: [{ code: '10839-9', display: '肌钙蛋白I (常规 cTnI)', system: 'http://loinc.org' }] },
      effectiveDateTime: '2026-08-24T08:30:00+08:00',
      encounter: { reference: `Encounter/${stay.admissionId}` },
      id: `obs-conv-ctni-${randomUUID()}`,
      issued: '2026-08-24T08:40:00+08:00',
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: `Patient/${stay.patientId}` },
      valueQuantity: { code: 'ng/mL', system: 'http://unitsofmeasure.org', unit: 'ng/mL', value: 100 },
    })

    const afterClose = await fixture.read('inpatient-doctor', `${stay.path}/disease-packs`, diseasePackRuntimeBundleSchema)
    expect(afterClose.packs.find(p => p.packId === 'hs-troponin-pack')?.activationStatus).toBe('inactive')

    // Inject approved+exact mapped code SYN-HS-CTNI -> hs-troponin-pack activates cleanly!
    fixture.runtime.fhir.create({ epoch, workspaceId: 'workspace-demo' }, {
      category: [{ coding: [{ code: 'laboratory', system: 'http://terminology.hl7.org/CodeSystem/observation-category' }] }],
      code: { coding: [{ code: 'SYN-HS-CTNI', display: '合成高敏肌钙蛋白 I', system: 'urn:clinmesh:synthetic' }] },
      effectiveDateTime: '2026-08-24T08:45:00+08:00',
      encounter: { reference: `Encounter/${stay.admissionId}` },
      id: `obs-syn-hs-ctni-${randomUUID()}`,
      issued: '2026-08-24T08:50:00+08:00',
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: `Patient/${stay.patientId}` },
      valueQuantity: { code: 'ng/L', system: 'http://unitsofmeasure.org', unit: 'ng/L', value: 120 },
    })

    const afterExact = await fixture.read('inpatient-doctor', `${stay.path}/disease-packs`, diseasePackRuntimeBundleSchema)
    expect(afterExact.packs.find(p => p.packId === 'hs-troponin-pack')?.activationStatus).toBe('active')
  })

  it('AC8 & historical asOf replay + recheckLatest diff over inpatient & outpatient HTTP routes with zero Case Truth leakage (AC15)', async () => {
    const brokenTopicAndClaimPack = buildSignedPack({
      examSuite: {
        cases: [{ caseId: 'ac8-case-1', expectedActive: true, titleZh: 'AC8 校验例' }],
        passThreshold: 0.8,
      },
      knowledgeSnapshots: [
        {
          claims: [
            {
              anchor: {
                locator: 'PDF 物理第 35 页',
                page: 35,
                quoteFragment: 'In patients undergoing PCI, DES should be used in preference to BMS',
                sha256: SHA_GUIDE_1,
                sourceId: 'coronary-10-2021',
                title: '合成血运重建指南测试原文',
                version: '2021',
              },
              applicabilityCondition: { category: 'diagnosis', itemCodes: ['I25.103'], kind: 'fact', presence: 'present', requireEligible: true },
              associatedConceptCodes: ['coronary-artery-disease'],
              effectiveFrom: '2026-06-01T00:00:00Z',
              id: 'ac8-claim-under-broken-topic',
              packId: 'ac8-anchor-pack',
              reviewerId: null,
              statementZh: '专题引文损坏时应整卡失活',
              status: 'auto-verified',
              topicId: 'ac8-broken-topic',
              version: '1.0.0',
            },
            {
              anchor: {
                locator: 'PDF 物理第 35 页',
                page: 35,
                quoteFragment: 'FABRICATED QUOTE NOT IN CORPUS',
                sha256: SHA_GUIDE_1,
                sourceId: 'coronary-10-2021',
                title: '合成血运重建指南测试原文',
                version: '2021',
              },
              applicabilityCondition: { category: 'diagnosis', itemCodes: ['I25.103'], kind: 'fact', presence: 'present', requireEligible: true },
              associatedConceptCodes: ['coronary-artery-disease'],
              effectiveFrom: '2026-06-01T00:00:00Z',
              id: 'ac8-claim-bad-anchor',
              packId: 'ac8-anchor-pack',
              reviewerId: null,
              statementZh: '无效锚点主张',
              status: 'auto-verified',
              topicId: 'ac8-good-topic',
              version: '1.0.0',
            },
            {
              anchor: {
                locator: 'PDF 物理第 6 页',
                page: 6,
                quoteFragment: 'Evaluate both proximal and distal reference segments, with lumen, EEM, and plaque measurements',
                sha256: SHA_GUIDE_2,
                sourceId: 'coronary-15-2021',
                title: '合成CVIT测量共识测试原文',
                version: '2021',
              },
              applicabilityCondition: { category: 'diagnosis', itemCodes: ['I25.103'], kind: 'fact', presence: 'present', requireEligible: true },
              associatedConceptCodes: ['coronary-artery-disease'],
              effectiveFrom: '2026-06-01T00:00:00Z',
              id: 'ac8-claim-valid-sibling',
              packId: 'ac8-anchor-pack',
              reviewerId: null,
              statementZh: '有效同级主张保持可用',
              status: 'auto-verified',
              topicId: 'ac8-good-topic',
              version: '1.0.0',
            },
          ],
          effectiveFrom: '2026-06-01T00:00:00Z',
          snapshotVersion: 'ac8.v1',
          topics: [
            {
              effectiveFrom: '2026-06-01T00:00:00Z',
              id: 'ac8-broken-topic',
              limitationsZh: ['仿真测试局限'],
              navigationZh: '损坏专题测试卡',
              packId: 'ac8-anchor-pack',
              references: [{
                locator: 'PDF 物理第 999 页',
                page: 999,
                quoteFragment: 'missing page quote',
                sha256: SHA_GUIDE_1,
                sourceId: 'coronary-10-2021',
                title: '合成血运重建指南测试原文',
                version: '2021',
              }],
              reviewerId: null,
              status: 'auto-verified',
              titleZh: '引文失效专题卡',
              version: '1.0.0',
            },
            {
              effectiveFrom: '2026-06-01T00:00:00Z',
              id: 'ac8-good-topic',
              limitationsZh: ['仿真测试局限'],
              navigationZh: '有效专题测试卡',
              packId: 'ac8-anchor-pack',
              references: [{
                locator: 'PDF 物理第 35 页',
                page: 35,
                quoteFragment: 'In patients undergoing PCI, DES should be used in preference to BMS',
                sha256: SHA_GUIDE_1,
                sourceId: 'coronary-10-2021',
                title: '合成血运重建指南测试原文',
                version: '2021',
              }],
              reviewerId: null,
              status: 'auto-verified',
              titleZh: '有效专题卡',
              version: '1.0.0',
            },
          ],
        },
      ],
      manifest: {
        dependencies: [],
        fingerprint: '0'.repeat(64),
        id: 'ac8-anchor-pack',
        packType: 'recognition',
        specialty: 'cardiology',
        status: 'active',
        supportedTasks: ['triage'],
        titleEn: 'AC8 Anchor Isolation Pack',
        titleZh: 'AC8 锚点隔离验证包',
        version: '1.0.0',
      },
      recognitionCard: {
        differentialPackIds: [],
        escalationGuidanceZh: '提示临床复核',
        id: 'ac8-card',
        summaryZh: '锚点验证',
        titleZh: '锚点验证',
      },
      toolPolicy: { allowedTools: ['inpatient.disease-packs.read'], forbiddenActions: [] },
      triggers: [{
        condition: { category: 'diagnosis', itemCodes: ['I25.103'], kind: 'fact', presence: 'present', requireEligible: true },
        id: 'ac8-dx',
      }],
    })

    const { fixture } = await setupRuntime({ extraPacks: [brokenTopicAndClaimPack], withGuidelineCorpus: true })
    const stay = await fixture.preparePciAdmission([])

    // Record a prior historical CAD condition visible since 2026-05-15 so asOf=2026-06-15 has eligible diagnosis facts
    fixture.runtime.fhir.create({ epoch: currentEpoch(fixture), workspaceId: 'workspace-demo' }, {
      clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
      code: { coding: [{ code: 'I25.103', display: '冠状动脉粥样硬化性心脏病', system: 'urn:clinmesh:reference:nhsa-diagnosis' }] },
      id: `cond-historical-cad-${randomUUID()}`,
      onsetDateTime: '2026-05-15T09:00:00+08:00',
      recordedDate: '2026-05-15T09:00:00+08:00',
      resourceType: 'Condition',
      subject: { reference: `Patient/${stay.patientId}` },
      verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-verification' }] },
    })

    // 1. Inpatient historical asOf replay & latest comparison on synthetic-test-syndrome
    const pastKnowledge = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/disease-packs/synthetic-test-syndrome/knowledge?asOf=${encodeURIComponent('2026-06-15T00:00:00Z')}&recheckLatest=true`,
      diseasePackKnowledgeEvaluationSchema,
    )
    expect(pastKnowledge.snapshotVersion).toBe('2026.06.v1')
    expect(pastKnowledge.topics[0]?.active).toBe(true)
    expect(pastKnowledge.topics[0]?.displayStageZh).toBe('试用版')
    expect(pastKnowledge.topics[0]?.trialDisclaimerZh).toBe(SIMULATION_TRIAL_DISCLAIMER_ZH)
    expect(pastKnowledge.claims.map(c => c.id)).toEqual([
      'syn-claim-des-preference',
      'syn-claim-ivus-measurements',
      'syn-claim-legacy-v1',
    ])
    expect(pastKnowledge.claims.every(c => c.active && c.trialDisclaimerZh === SIMULATION_TRIAL_DISCLAIMER_ZH)).toBe(true)

    expect(pastKnowledge.latestComparison).toEqual({
      addedClaimIds: ['syn-claim-oct-left-main-limit'],
      baselineSnapshotVersion: '2026.06.v1',
      latestSnapshotVersion: '2026.08.v2',
      removedOrRetiredClaimIds: ['syn-claim-legacy-v1'],
      statementChanges: [
        {
          claimId: 'syn-claim-ivus-measurements',
          fromStatementZh: 'IVUS 评估须测量近远端参考段管腔、EEM 与斑块指标。',
          toStatementZh: 'IVUS 评估须同时测量近远端参考段管腔、EEM 与斑块指标（手动回撤无法测长）。',
        },
      ],
      statusChanges: [
        {
          claimId: 'syn-claim-legacy-v1',
          fromStatus: 'auto-verified',
          toStatus: 'superseded',
        },
      ],
    })

    // 2. Latest inpatient knowledge view excludes retired syn-claim-legacy-v1 from active claims
    const latestKnowledge = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/disease-packs/synthetic-test-syndrome/knowledge`,
      diseasePackKnowledgeEvaluationSchema,
    )
    expect(latestKnowledge.snapshotVersion).toBe('2026.08.v2')
    expect(latestKnowledge.claims.map(c => c.id)).toEqual([
      'syn-claim-des-preference',
      'syn-claim-ivus-measurements',
      'syn-claim-oct-left-main-limit',
    ])

    // 3. Before any snapshot -> 404 KNOWLEDGE_SNAPSHOT_NOT_FOUND
    const tooEarlyRes = await fixture.request(
      'inpatient-doctor',
      `${stay.path}/disease-packs/synthetic-test-syndrome/knowledge?asOf=${encodeURIComponent('2026-01-01T00:00:00Z')}`,
    )
    expect(tooEarlyRes.status).toBe(404)
    expect(apiErrorSchema.parse(await tooEarlyRes.json()).error.code).toBe('KNOWLEDGE_SNAPSHOT_NOT_FOUND')

    // 4. AC8 anchor isolation over HTTP on ac8-anchor-pack
    const ac8Eval = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/disease-packs/ac8-anchor-pack/knowledge`,
      diseasePackKnowledgeEvaluationSchema,
    )
    const brokenTopic = ac8Eval.topics.find(t => t.id === 'ac8-broken-topic')!
    const goodTopic = ac8Eval.topics.find(t => t.id === 'ac8-good-topic')!
    expect(brokenTopic.active).toBe(false)
    expect(brokenTopic.referencesValid).toBe(false)
    expect(goodTopic.active).toBe(true)

    expect(ac8Eval.claims.find(c => c.id === 'ac8-claim-under-broken-topic')?.active).toBe(false)
    expect(ac8Eval.claims.find(c => c.id === 'ac8-claim-bad-anchor')?.active).toBe(false)
    expect(ac8Eval.claims.find(c => c.id === 'ac8-claim-bad-anchor')?.anchorValid).toBe(false)
    expect(ac8Eval.claims.find(c => c.id === 'ac8-claim-valid-sibling')?.active).toBe(true)

    const inpatientAudits = fixture.runtime.database.driver.prepare(`
      SELECT operation, outcome FROM audit_log
      WHERE operation = 'inpatient.disease-pack-knowledge.read'
    `).all() as Array<{ operation: string; outcome: string }>
    expect(inpatientAudits.some(a => a.outcome === 'success')).toBe(true)
  })

  it('AC15 & outpatient role isolation: evaluates outpatient pack knowledge without leaking Case Truth', async () => {
    const { fixture } = await setupRuntime({ withGuidelineCorpus: true })
    const scenario = await fixture.read('admin', '/api/sim/v1/scenario-runs/current', scenarioStateSchema)
    await parsePciResponse(
      inpatientPciDataResponseSchema,
      await fixture.request('admin', '/api/his/v1/inpatient/pci-data/prepare', { expectedEpoch: scenario.epoch }),
    )
    const pciSource = (await parsePciResponse(
      pciCaseSourceResponseSchema,
      await fixture.request('admin', '/api/sim/v1/synthetic-cases/pci/prepare', { expectedEpoch: scenario.epoch }),
    )).data
    const regCatalog = await fixture.read('registrar', '/api/his/v1/catalogs/registration', registrationCatalogSchema)
    const startedOutRes = await fixture.runtime.app.request(`/api/his/v1/synthetic-cases/${pciSource.case.caseId}/actions/start-outpatient-visit`, {
      body: JSON.stringify({
        activeBriefRevision: pciSource.case.activeBriefRevision,
        departmentId: regCatalog.departments[0]!.id,
        expectedCaseRevision: pciSource.case.revision,
        locationId: regCatalog.locations[0]!.id,
        visitDate: regCatalog.virtualDate,
        visitTypeId: regCatalog.visitTypes[0]!.id,
      }),
      headers: {
        'content-type': 'application/json',
        cookie: await fixture.login('registrar'),
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    const startedOut = await parsePciResponse(commandResponseSchema(startSyntheticCaseResultSchema), startedOutRes)
    const startedData = startedOut.data

    const caseTruthSentinel = 'CASE_TRUTH_SENTINEL_NEVER_LEAK_559'
    fixture.runtime.database.driver.prepare(`
      UPDATE synthetic_case_truth
      SET hidden_resources_json = ?
      WHERE workspace_id = ? AND case_id = ?
    `).run(JSON.stringify([{ secretFlag: caseTruthSentinel }]), scenario.workspaceId, pciSource.case.caseId)

    const triaged = await parsePciResponse(
      triageResponseSchema,
      await fixture.request('triage', `/api/his/v1/encounters/${startedData.encounterId}/actions/record-triage`, {
        acuityCode: 'level-2',
        bloodPressure: { diastolicMmHg: 78, systolicMmHg: 126 },
        chiefComplaint: '活动后胸闷',
        heightCm: 170,
        oxygenSaturationPct: 98,
        pulseBpm: 76,
        respirationBpm: 18,
        temperatureC: 36.6,
        weightKg: 70,
      }, randomUUID(), {
        [`Encounter/${startedData.encounterId}`]: '1',
        [`Task/${startedData.queueTaskId}`]: '1',
      }),
    )
    await parsePciResponse(
      startVisitResponseSchema,
      await fixture.request('doctor', `/api/his/v1/encounters/${startedData.encounterId}/actions/start-first-visit`, {}, randomUUID(), {
        [`Encounter/${startedData.encounterId}`]: triaged.data.encounterVersion,
        [`Task/${triaged.data.doctorTaskId}`]: '1',
      }),
    )
    const queue = await fixture.read('doctor', '/api/his/v1/doctor/queue', doctorQueueSchema)
    const caseItem = queue.items.find(item => item.encounterId === startedData.encounterId)!
    const caseDetail = await fixture.read('doctor', `/api/his/v1/doctor/cases/${caseItem.caseId}`, doctorCaseDetailSchema)

    const clinicalCat = await fixture.read('doctor', '/api/his/v1/catalogs/clinical', clinicalCatalogSchema)
    const cadDx = clinicalCat.diagnoses.find(d => d.code.startsWith('I25'))!
    const doctorCookie = await fixture.login('doctor')
    const dxDraft = await parsePciResponse(
      diagnosisDraftResponseSchema,
      await fixture.runtime.app.request(`http://localhost/api/his/v1/encounters/${startedData.encounterId}/diagnosis/draft`, {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${startedData.encounterId}`]: caseDetail.encounter.versionId },
          input: { entries: [{ catalogItemId: cadDx.id, role: 'primary' }], expectedDraftVersion: 0 },
        }),
        headers: { 'content-type': 'application/json', cookie: doctorCookie, 'idempotency-key': randomUUID(), origin: 'http://localhost' },
        method: 'PUT',
      }),
    )
    await parsePciResponse(
      confirmDiagnosisResponseSchema,
      await fixture.request(
        'doctor',
        `/api/his/v1/encounters/${startedData.encounterId}/diagnosis/actions/confirm`,
        { expectedDraftVersion: dxDraft.data.draftVersion },
        randomUUID(),
        { [`Encounter/${startedData.encounterId}`]: caseDetail.encounter.versionId },
      ),
    )

    // Role isolation: pharmacist cannot read outpatient knowledge
    const outPharmForbidden = await fixture.request(
      'pharmacist',
      `/api/his/v1/outpatient/cases/${caseItem.caseId}/disease-packs/synthetic-test-syndrome/knowledge`,
    )
    expect(outPharmForbidden.status).toBe(403)

    const outpatientKnowledgeRes = await fixture.request(
      'doctor',
      `/api/his/v1/outpatient/cases/${caseItem.caseId}/disease-packs/synthetic-test-syndrome/knowledge`,
    )
    expect(outpatientKnowledgeRes.status).toBe(200)
    const outpatientRawText = await outpatientKnowledgeRes.clone().text()
    expect(outpatientRawText).not.toContain(caseTruthSentinel)
    expect(outpatientRawText).not.toMatch(/caseTruth|case_truth/i)

    const outpatientKnowledge = diseasePackKnowledgeEvaluationSchema.parse(await outpatientKnowledgeRes.json())
    expect(outpatientKnowledge.snapshotVersion).toBe('2026.08.v2')
    expect(outpatientKnowledge.claims.every(c => c.active && c.trialDisclaimerZh === SIMULATION_TRIAL_DISCLAIMER_ZH)).toBe(true)

    const audits = fixture.runtime.database.driver.prepare(`
      SELECT operation, outcome FROM audit_log
      WHERE operation = 'doctor.case.disease-pack-knowledge.read'
    `).all() as Array<{ operation: string; outcome: string }>
    expect(audits.some(a => a.outcome === 'success')).toBe(true)
  })
})
