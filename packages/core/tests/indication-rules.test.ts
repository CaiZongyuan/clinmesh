import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ClinicalFact, ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import { validateAndParseDiseasePack } from '../src/disease-pack.ts'
import { evaluateOrderIndicationRules } from '../src/indication-rules.ts'

const SHA_A = 'a'.repeat(64)

function makeFact(overrides: Partial<ClinicalFact> = {}): ClinicalFact {
  return {
    abnormal: false,
    category: 'diagnosis',
    clinicianVerification: {
      note: null,
      verified: true,
      verifiedAt: null,
      verifiedByActorId: null,
      verifiedByPractitionerId: null,
    },
    conflictingFactIds: [],
    effectiveAt: '2026-08-24T08:00:00Z',
    eligibleForScoringAndRedLine: true,
    factId: 'fact:local:Condition:cond-1:1',
    ineligibleReasons: [],
    ingestedAt: '2026-08-24T08:00:00Z',
    institutionScope: 'local',
    isExpiredAtAsOf: false,
    itemCode: {
      code: 'R07.4',
      display: '胸痛',
      system: 'http://hl7.org/fhir/sid/icd-10',
    },
    mappingVersion: '1',
    method: null,
    orderedAt: '2026-08-24T08:00:00Z',
    presence: 'present',
    provenance: {
      recordId: 'cond-1',
      recordType: 'Condition',
      recordVersion: '1',
      sourceSystemId: 'local-his',
    },
    qualityFlags: [],
    recordStatus: 'final',
    relation: {
      supersededByFactId: null,
      supersedesFactId: null,
    },
    reportedAt: '2026-08-24T08:00:00Z',
    requiresRecheckPrompt: false,
    specimenOrSite: null,
    suspiciousReasons: [],
    validityDays: null,
    value: {
      normalizedValue: 'R07.4',
      rawText: '胸痛',
    },
    verificationStatus: 'confirmed',
    ...overrides,
  }
}

function makeLedger(facts: ClinicalFact[]): ClinicalFactLedger {
  return {
    facts,
    includeSuperseded: false,
    patientId: 'patient-1',
    subjectId: 'case-1',
    subjectKind: 'outpatient',
    summary: {
      conflictCount: 0,
      eligibleCount: facts.filter(f => f.eligibleForScoringAndRedLine).length,
      expiredCount: 0,
      externalUnverifiedCount: facts.filter(f => f.institutionScope === 'external' && !f.clinicianVerification.verified).length,
      notAskedCount: facts.filter(f => f.presence === 'not-asked').length,
      supersededCount: facts.filter(f => f.relation.supersededByFactId !== null).length,
      suspiciousCount: 0,
      totalFacts: facts.length,
      verifiedExternalCount: 0,
    },
    trace: {
      evaluatedAsOf: '2026-08-24T09:00:00Z',
      hospitalId: 'hospital-demo',
      mappingVersion: '1',
    },
  }
}

function makeIndicationPack(overrides: Record<string, unknown> = {}) {
  return validateAndParseDiseasePack({
    conceptVocabulary: {
      mappings: [
        {
          effectiveDate: '2026-06-01',
          id: 'map-wst-tni',
          relation: 'exact',
          reviewStatus: 'approved',
          reviewerId: 'rev-1',
          sourceCode: '2100404B',
          sourceDisplay: '高敏心肌肌钙蛋白 I (hs-cTnI)',
          sourceSystem: 'urn:clinmesh:wst:test',
          targetConceptCode: '89579-7',
          version: '1.0.0',
        },
      ],
      nodes: [],
      version: '1.0.0',
    },
    examSuite: {
      cases: [{ caseId: 'c1', expectedActive: true, titleZh: '测试' }],
      passThreshold: 0.8,
    },
    exitCriteria: [],
    formulaRefs: [],
    inapplicablePopulations: [],
    indicationRules: [
      {
        condition: {
          kind: 'anyOf',
          nodes: [
            {
              category: 'laboratory',
              itemCodes: ['89579-7'],
              kind: 'fact',
              minValue: 26,
              presence: 'present',
              requireEligible: true,
            },
            {
              category: 'diagnosis',
              itemCodePattern: '^(?:I20|I21|I24|I25)',
              kind: 'fact',
              presence: 'present',
              requireEligible: true,
            },
          ],
        },
        id: 'cta-indication-rule',
        itemCodePattern: '^(?:CT-CORONARY-CTA|imaging-coronary-cta)$',
        orderKind: 'imaging',
        rationaleZh: '心电图及肌钙蛋白正常且未确立冠心病或急性冠脉综合征依据时，不建议直接开立冠脉 CTA',
        requiredItemCodes: ['11524-6|examination-ecg-12-lead', '89579-7|2100404B'],
      },
    ],
    knowledgeSnapshots: [],
    manifest: {
      dependencies: [],
      fingerprint: SHA_A,
      id: 'synthetic-indication-pack',
      packType: 'full',
      specialty: 'synthetic',
      status: 'active',
      supportedTasks: ['pci-preop-guideline-advice'],
      titleEn: 'Synthetic Indication Pack',
      titleZh: '合成适应症核验包',
      version: '1.0.0',
    },
    orderSets: [],
    pointScales: [],
    qualityTightenings: { examPassThreshold: 0.8, redLineRules: [], validityOverrides: [] },
    questionnaireItems: [],
    readinessTasks: [
      { criticalItems: [], secondaryItems: [], taskId: 'pci-preop-guideline-advice', titleZh: '评估' },
    ],
    riskTags: [],
    ruleOutChecklist: [],
    stages: [
      {
        entryCondition: {
          category: 'diagnosis',
          itemCodes: ['R07.4'],
          kind: 'fact',
          presence: 'present',
          requireEligible: true,
        },
        id: 'initial',
        order: 1,
        orderSetIds: [],
        questionnaireItemCodes: [],
        taskIds: ['pci-preop-guideline-advice'],
        titleZh: '初诊评估',
        topicIds: [],
      },
    ],
    toolPolicy: { allowedTools: [], forbiddenActions: [] },
    triggers: [
      {
        condition: {
          category: 'diagnosis',
          itemCodes: ['R07.4'],
          kind: 'fact',
          presence: 'present',
          requireEligible: true,
        },
        descriptionZh: 'Chest pain trigger',
        id: 'trigger-r07',
      },
    ],
    ...overrides,
  })
}

describe('evaluateOrderIndicationRules', () => {
  it('returns missing-inputs instead of firing no-indication when required tests are incomplete, ordered-only, or ineligible', () => {
    const pack = makeIndicationPack()
    const orderedOnlyEcg = makeFact({
      category: 'examination',
      factId: 'fact:local:ServiceRequest:sr-ecg:1',
      itemCode: { code: '11524-6', display: '12 导联心电图', system: 'http://loinc.org' },
      provenance: { recordId: 'sr-ecg', recordType: 'ServiceRequest', recordVersion: '1', sourceSystemId: 'local-his' },
      value: { normalizedValue: null, rawText: '已开立心电图' },
    })
    const externalUnverifiedTrop = makeFact({
      category: 'laboratory',
      clinicianVerification: {
        note: null,
        verified: false,
        verifiedAt: null,
        verifiedByActorId: null,
        verifiedByPractitionerId: null,
      },
      eligibleForScoringAndRedLine: false,
      factId: 'fact:external:Observation:ext-tni:1',
      institutionScope: 'external',
      itemCode: { code: '2100404B', display: '外院 hs-cTnI', system: 'urn:clinmesh:wst:test' },
      provenance: { recordId: 'ext-tni', recordType: 'Observation', recordVersion: '1', sourceSystemId: 'ext-his' },
      value: { normalizedValue: { unit: 'ng/L', value: 4 }, rawText: '4 ng/L' },
    })

    const result = evaluateOrderIndicationRules({
      candidateCodes: ['hospital-service-coronary-cta'],
      catalogItemId: 'hospital-service-coronary-cta',
      itemCode: 'CT-CORONARY-CTA',
      ledger: makeLedger([makeFact(), orderedOnlyEcg, externalUnverifiedTrop]),
      orderDisplay: '冠状动脉 CTA',
      orderKind: 'imaging',
      packs: [pack],
    })

    expect(result.status).toBe('missing-inputs')
    expect(result.alerts).toEqual([])
    expect(result.missingInputs).toEqual(['十二导联心电图', '高敏肌钙蛋白 I (hs-cTnI)'])
    expect(result.missingMessageZh).toContain('缺项待补')
  })

  it('fires INVESTIGATION_WITHOUT_INDICATION yellow alert when required inputs are completed and condition is false', () => {
    const pack = makeIndicationPack()
    const ecgNormal = makeFact({
      category: 'examination',
      factId: 'fact:local:DiagnosticReport:ecg-1:1',
      itemCode: { code: 'examination-ecg-12-lead', display: '12 导联心电图', system: 'urn:clinmesh:exam' },
      provenance: { recordId: 'ecg-1', recordType: 'DiagnosticReport', recordVersion: '1', sourceSystemId: 'ris' },
      value: { normalizedValue: 'normal', rawText: '窦性心律，未见明显 ST-T 异常' },
    })
    const tropNormal = makeFact({
      category: 'laboratory',
      factId: 'fact:local:Observation:tni-1:1',
      itemCode: { code: '2100404B', display: '高敏心肌肌钙蛋白 I', system: 'urn:clinmesh:wst:test' },
      provenance: { recordId: 'tni-1', recordType: 'Observation', recordVersion: '1', sourceSystemId: 'lis' },
      value: { normalizedValue: { unit: 'ng/L', value: 3.2 }, rawText: '3.2 ng/L' },
    })

    const result = evaluateOrderIndicationRules({
      catalogItemId: 'hospital-service-coronary-cta',
      itemCode: 'CT-CORONARY-CTA',
      ledger: makeLedger([makeFact(), ecgNormal, tropNormal]),
      orderDisplay: '冠状动脉 CTA',
      orderKind: 'imaging',
      packs: [pack],
    })

    expect(result.status).toBe('no-indication')
    expect(result.alerts).toHaveLength(1)
    expect(result.alerts[0]?.code).toBe('INVESTIGATION_WITHOUT_INDICATION')
    expect(result.alerts[0]?.tier).toBe('alert')
    expect(result.alerts[0]?.message).toContain('冠状动脉 CTA')
    expect(result.alerts[0]?.message).toContain('缺乏明确临床适应症')
    expect(result.alerts[0]?.evidence.length).toBeGreaterThanOrEqual(2)
    expect(result.alerts[0]?.message).not.toMatch(/规则/)
    expect(result.alerts[0]?.ruleId).toEqual(expect.any(String))
    expect(result.alerts[0]?.basis?.needZh.length).toBeGreaterThan(0)
    expect(result.alerts[0]?.basis?.foundZh).toContain('心电图')
    expect(result.alerts[0]?.basis?.judgementZh).toContain('冠状动脉 CTA')
    expect(result.sourcePacks).toEqual([
      { packId: 'synthetic-indication-pack', packVersion: '1.0.0', titleZh: '合成适应症核验包' },
    ])
  })

  it('returns indicated when required inputs are present (via approved alias) and condition matches', () => {
    const pack = makeIndicationPack()
    const ecg = makeFact({
      category: 'examination',
      factId: 'fact:local:DiagnosticReport:ecg-1:1',
      itemCode: { code: '11524-6', display: '12 导联心电图', system: 'http://loinc.org' },
      provenance: { recordId: 'ecg-1', recordType: 'DiagnosticReport', recordVersion: '1', sourceSystemId: 'ris' },
      value: { normalizedValue: 'normal', rawText: '正常' },
    })
    const tropElevated = makeFact({
      abnormal: true,
      category: 'laboratory',
      factId: 'fact:local:Observation:tni-1:1',
      itemCode: { code: '2100404B', display: '高敏心肌肌钙蛋白 I', system: 'urn:clinmesh:wst:test' },
      provenance: { recordId: 'tni-1', recordType: 'Observation', recordVersion: '1', sourceSystemId: 'lis' },
      value: { normalizedValue: { unit: 'ng/L', value: 180 }, rawText: '180 ng/L' },
    })

    const result = evaluateOrderIndicationRules({
      itemCode: 'CT-CORONARY-CTA',
      ledger: makeLedger([makeFact(), ecg, tropElevated]),
      orderDisplay: '冠状动脉 CTA',
      orderKind: 'imaging',
      packs: [pack],
    })

    expect(result.status).toBe('indicated')
    expect(result.alerts).toEqual([])
  })

  it('ignores retired, exited, or inapplicable packs and unmatched order kinds/codes', () => {
    const activePack = makeIndicationPack()
    const retiredPack = makeIndicationPack({
      manifest: {
        dependencies: [],
        fingerprint: SHA_A,
        id: 'retired-pack',
        packType: 'full',
        specialty: 'synthetic',
        status: 'retired',
        supportedTasks: ['pci-preop-guideline-advice'],
        titleEn: 'Retired Pack',
        titleZh: '退役包',
        version: '1.0.0',
      },
    })

    const exitedEval = evaluateOrderIndicationRules({
      itemCode: 'CT-CORONARY-CTA',
      ledger: makeLedger([]),
      orderKind: 'imaging',
      packs: [
        { entry: { activationReason: 'pack-exited', activationStatus: 'inactive', exited: true }, pack: activePack },
        retiredPack,
      ],
    })
    expect(exitedEval.status).toBe('not-applicable')
    expect(exitedEval.alerts).toEqual([])

    const wrongKind = evaluateOrderIndicationRules({
      itemCode: 'CT-CORONARY-CTA',
      ledger: makeLedger([]),
      orderKind: 'medication',
      packs: [activePack],
    })
    expect(wrongKind.status).toBe('not-applicable')
  })

  it('never imports or accesses DRG modules or grouping concepts in indication-rules.ts', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/indication-rules.ts'), 'utf8')
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(withoutComments.toLowerCase()).not.toContain('drg')
    expect(withoutComments.toLowerCase()).not.toContain('headroom')
    expect(withoutComments.toLowerCase()).not.toContain('reimburse')
    expect(source).not.toContain('coronary-cad')
  })
})
