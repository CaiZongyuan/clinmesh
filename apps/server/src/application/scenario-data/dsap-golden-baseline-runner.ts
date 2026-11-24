import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clinicalQualityCheckSchema, type ClinicalQualityCheck } from '@clinmesh/contracts/clinical-quality'
import { clinicalScoreBundleSchema, type ClinicalScoreBundle } from '@clinmesh/contracts/clinical-scores'
import { guidelineTopicBundleSchema, type GuidelineTopicBundle } from '@clinmesh/contracts/guideline-topics'
import {
  billingCaseSchema,
  clinicalDocumentDraftResponseSchema,
  clinicalDocumentSignPreviewResponseSchema,
  clinicalDocumentSignResponseSchema,
  commandResponseSchema,
  confirmDiagnosisResponseSchema,
  confirmNoMedicationResponseSchema,
  diagnosisDraftResponseSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  encounterCompletionResponseSchema,
  examinationRequestDraftResponseSchema,
  issueExaminationRequestResponseSchema,
  issueLaboratoryRequestResponseSchema,
  laboratoryRequestDraftResponseSchema,
  paymentPreviewResponseSchema,
  paymentResponseSchema,
  registrationCatalogSchema,
  registrationResponseSchema,
  scenarioCommandResponseSchema,
  scenarioStateSchema,
  startVisitResponseSchema,
  triageResponseSchema,
  caseLaboratoryCatalogSearchSchema,
} from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalResponseSchema } from '@clinmesh/contracts/inpatient-clinical'
import { authoredCasePackPrepareResponseSchema, startSyntheticInpatientCaseResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { orderSetDraftBundleSchema, type OrderSetDraftBundle } from '@clinmesh/contracts/order-set-templates'
import { startSyntheticCaseResultSchema, syntheticCaseInstanceSchema } from '@clinmesh/contracts/scenario'
import { GuidelineCorpus } from '../../infrastructure/sqlite/guideline-corpus.ts'
import { runReferenceDatabaseCli } from '../../reference-database-cli.ts'
import { createClinMeshRuntime } from '../../runtime.ts'
import type { GuidelineDocument } from '../guideline-corpus.ts'
import { listGuidelineTopicDefinitions } from '../guideline-topic-registry.ts'
import type { CompiledAuthoredCase } from './authored-case-pack-compiler.ts'
import { compiledCardiorenalAuthoredCasePack } from './cardiorenal-authored-case-pack.ts'
import { compiledDsapExtraGoldenCasePack, listFrozenDsapGoldenCases } from './dsap-golden-case-pack.ts'
import { createHospitalBaseline } from './hospital-baseline.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from './medical-service-snapshot.ts'
import { syntheticNhsaMedicationProductSnapshot } from './medication-product-snapshot.ts'

type Runtime = Awaited<ReturnType<typeof createClinMeshRuntime>>

const wstSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026'
const panelSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn'
const datasetReleaseId = 'laboratory-cn@2026-09-01.r1'
const referenceReleaseId = 'dsap-golden-baseline-reference-v1'
const demoPassword = 'Synthetic-Demo-Password-2026!'

interface TriageSeed {
  diastolicMmHg: number
  oxygenSaturationPct: number
  pulseBpm: number
  systolicMmHg: number
  weightKg: number
}

const triageSeeds: Readonly<Record<string, TriageSeed>> = {
  'cardio-nstemi-chest-pain-v1': { diastolicMmHg: 90, oxygenSaturationPct: 97, pulseBpm: 96, systolicMmHg: 148, weightKg: 74 },
  'renal-t2dm-htn-ckd4-control-v1': { diastolicMmHg: 86, oxygenSaturationPct: 96, pulseBpm: 84, systolicMmHg: 144, weightKg: 62 },
  'trap-low-risk-chest-wall-pain-v1': { diastolicMmHg: 74, oxygenSaturationPct: 99, pulseBpm: 72, systolicMmHg: 116, weightKg: 56 },
  'fh-premature-cad-clue-v1': { diastolicMmHg: 80, oxygenSaturationPct: 99, pulseBpm: 78, systolicMmHg: 128, weightKg: 72 },
  'trap-epigastric-t2dm-ruleout-v1': { diastolicMmHg: 78, oxygenSaturationPct: 98, pulseBpm: 76, systolicMmHg: 132, weightKg: 68 },
  'trap-external-creatinine-v1': { diastolicMmHg: 88, oxygenSaturationPct: 98, pulseBpm: 80, systolicMmHg: 152, weightKg: 70 },
  'trap-pregnant-chest-pain-v1': { diastolicMmHg: 72, oxygenSaturationPct: 99, pulseBpm: 88, systolicMmHg: 112, weightKg: 64 },
}

const diagnosisMetadata = [
  { code: 'I21.4', display: '急性非ST段抬高型心肌梗死', row: 12510 },
  { code: 'I25.103', display: '冠状动脉粥样硬化性心脏病', row: 12670 },
  { code: 'I20.0', display: '不稳定型心绞痛', row: 12490 },
  { code: 'I50.900', display: '心力衰竭', row: 13195 },
  { code: 'I10', display: '高血压', row: 12457 },
  { code: 'E11.65', display: '2型糖尿病伴高血糖', row: 11205 },
  { code: 'E11.9', display: '2型糖尿病', row: 11210 },
  { code: 'E78.01', display: '家族性高胆固醇血症', row: 11410 },
  { code: 'E78.5', display: '血脂异常', row: 11420 },
  { code: 'N18.3', display: '慢性肾脏病3期', row: 13610 },
  { code: 'N18.4', display: '慢性肾脏病4期', row: 13615 },
  { code: 'R07.3', display: '胸壁疼痛', row: 14001 },
  { code: 'R07.4', display: '未特指的胸痛', row: 14005 },
  { code: 'R10.1', display: '上腹痛', row: 14020 },
  { code: 'Z33', display: '妊娠状态', row: 15010 },
  { code: 'O26.8', display: '其他特指的妊娠相关情况', row: 13810 },
] as const

function buildPinnedGuidelineDatabase(databasePath: string): void {
  const bySource = new Map<string, { sha256: string; sourceId: string; title: string; version: string; pages: Map<number, Set<string>> }>()
  for (const definition of listGuidelineTopicDefinitions()) {
    for (const ref of definition.references) {
      const key = `${ref.sourceId}#${ref.version}#${ref.sha256}`
      let entry = bySource.get(key)
      if (entry === undefined) {
        entry = { pages: new Map(), sha256: ref.sha256, sourceId: ref.sourceId, title: ref.title, version: ref.version }
        bySource.set(key, entry)
      }
      const fragments = entry.pages.get(ref.page) ?? new Set<string>()
      for (const fragment of ref.fragments) fragments.add(fragment)
      entry.pages.set(ref.page, fragments)
    }
  }
  const documents: GuidelineDocument[] = [...bySource.values()].map(entry => ({
    passages: [...entry.pages.entries()].sort(([a], [b]) => a - b).map(([page, fragments]) => ({
      locator: `PDF 物理第 ${page} 页`,
      text: [
        `Synthetic pinned DSAP baseline guideline passage for ${entry.sourceId} (v${entry.version}) page ${page}.`,
        ...fragments,
      ].join('\n'),
    })),
    source: {
      distribution: {
        packageId: 'dsap-baseline-synthetic-guidelines',
        releaseId: 'dsap-baseline-synthetic-guidelines-v1',
        textStatus: 'verified',
        verificationRecord: `verification/${entry.sourceId}.json`,
      },
      documentType: 'guideline',
      format: 'pdf',
      id: entry.sourceId,
      license: { id: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', usage: 'open' },
      publisher: 'ClinMesh 合成指南基准库',
      scope: '仅供专病黄金基准验证，非真实临床指南文本。',
      sha256: entry.sha256,
      status: 'active',
      title: entry.title,
      topics: [{ diagnosisQueries: ['冠状动脉粥样硬化性心脏病'], terms: ['胸痛', '冠心病', '糖尿病', '肾脏病'] }],
      url: `https://example.test/guidelines/${entry.sourceId}`,
      version: entry.version,
    },
  }))
  const corpus = new GuidelineCorpus({ databasePath })
  try {
    corpus.importDocuments(documents)
  } finally {
    corpus.close()
  }
}

async function buildSyntheticReferenceDatabase(directory: string): Promise<string> {
  const referenceDatabasePath = join(directory, 'reference.sqlite')
  const rangeRule = (low: number, high: number, sex: 'all' | 'female' | 'male' = 'all') => ({
    high,
    low,
    notes: '合成成人参考区间',
    referenceKind: 'range' as const,
    sex,
    simulationHigh: high,
    simulationLow: low,
    sourceLocation: '表 1',
    sourceStandard: 'WS/T 886-2026',
    sourceType: 'national-standard' as const,
    sourceVersion: '2026',
  })
  const upperRule = (high: number, simulationLow: number, sex: 'all' | 'female' | 'male' = 'all') => ({
    high,
    notes: '合成成人参考上限',
    referenceKind: 'upper-bound' as const,
    sex,
    simulationHigh: high,
    simulationLow,
    sourceLocation: '表 1',
    sourceStandard: 'WS/T 886-2026',
    sourceType: 'project-curated' as const,
    sourceVersion: '2026-09-01',
  })
  const testItem = (
    code: string,
    display: string,
    specimen: string,
    unitCode: string,
    precision: number,
    rules: Array<ReturnType<typeof rangeRule> | ReturnType<typeof upperRule>>,
  ) => ({
    concept: {
      code,
      display,
      domain: 'laboratory' as const,
      id: `wst-886:2026:${code}`,
      sourceLocator: `synthetic:laboratory-cn:test:${code}`,
      status: 'active' as const,
      system: wstSystem,
      version: '2026',
    },
    definition: {
      adultReferenceRules: rules,
      alternateCodings: [],
      analyte: display,
      category: '临床检验',
      conceptId: `wst-886:2026:${code}`,
      datasetReleaseId,
      healthyStrategy: 'uniform' as const,
      kind: 'laboratory-cn-test' as const,
      precision,
      resultKind: 'quantity' as const,
      scale: '定量',
      sourceLocator: `synthetic:laboratory-cn:test:${code}`,
      sourceVersion: '2026',
      specimen,
      unit: { code: unitCode, display: unitCode, system: 'http://unitsofmeasure.org' as const },
    },
  })
  const panelItem = (code: string, display: string, specimen: string, members: string[]) => ({
    concept: {
      code,
      display,
      domain: 'laboratory' as const,
      id: `laboratory-panel-cn:2026-09-01:${code}`,
      sourceLocator: `synthetic:laboratory-cn:panel:${code}`,
      status: 'active' as const,
      system: panelSystem,
      version: '2026-09-01',
    },
    definition: {
      conceptId: `laboratory-panel-cn:2026-09-01:${code}`,
      datasetReleaseId,
      kind: 'laboratory-cn-panel' as const,
      notes: display,
      sourceLocation: '检验组合',
      sourceLocator: `synthetic:laboratory-cn:panel:${code}`,
      sourceType: 'project-authored' as const,
      sourceVersion: '2026-09-01',
      specimen,
    },
    members: members.map((memberCode, index) => ({
      memberConceptId: `wst-886:2026:${memberCode}`,
      memberOrder: index + 1,
      panelConceptId: `laboratory-panel-cn:2026-09-01:${code}`,
      relationship: 'contains' as const,
      sourceLocator: `synthetic:laboratory-cn:panel:${code}:${index + 1}`,
    })),
  })

  const tests = [
    testItem('0100101A', '白细胞计数', '全血', '10*9/L', 2, [rangeRule(3.5, 9.5)]),
    testItem('0100201A', '红细胞计数', '全血', '10*12/L', 2, [rangeRule(4.3, 5.8, 'male'), rangeRule(3.8, 5.1, 'female')]),
    testItem('0100301A', '血小板计数', '全血', '10*9/L', 0, [rangeRule(125, 350)]),
    testItem('0100401A', '血红蛋白测定', '全血', 'g/L', 0, [rangeRule(130, 175, 'male'), rangeRule(115, 150, 'female')]),
    testItem('0100501A', '红细胞比容', '全血', 'L/L', 2, [rangeRule(0.4, 0.5, 'male'), rangeRule(0.35, 0.45, 'female')]),
    testItem('0100601A', '平均红细胞体积', '全血', 'fL', 1, [rangeRule(82, 100)]),
    testItem('0100701A', '平均红细胞血红蛋白含量', '全血', 'pg', 1, [rangeRule(27, 34)]),
    testItem('0100801A', '平均红细胞血红蛋白浓度', '全血', 'g/L', 0, [rangeRule(316, 354)]),
    testItem('2100104A', '肌酸激酶同工酶测定', '血清、血浆', 'U/L', 1, [upperRule(24, 2)]),
    testItem('2100304A', '肌红蛋白测定', '血清、血浆', 'ng/mL', 1, [upperRule(72, 10)]),
    testItem('2100404A', '心肌肌钙蛋白I测定', '血清、血浆', 'ng/mL', 3, [upperRule(0.04, 0.002)]),
    testItem('2100504A', '心肌肌钙蛋白T测定', '血清、血浆', 'ng/mL', 3, [upperRule(0.014, 0.003)]),
    testItem('2100604A', '脑利钠肽测定', '血清、血浆', 'ng/L', 1, [upperRule(100, 5)]),
    testItem('2100704A', '氨基末端脑利钠肽前体测定', '血清、血浆', 'ng/L', 0, [upperRule(125, 15)]),
    testItem('2000104A', '总胆固醇测定', '血清、血浆', 'mmol/L', 2, [upperRule(5.2, 3.1)]),
    testItem('2000204A', '甘油三酯测定', '血清、血浆', 'mmol/L', 2, [upperRule(1.7, 0.4)]),
    testItem('2000304A', '高密度脂蛋白胆固醇测定', '血清、血浆', 'mmol/L', 2, [rangeRule(1.0, 2.0)]),
    testItem('2000404A', '低密度脂蛋白胆固醇测定', '血清、血浆', 'mmol/L', 2, [upperRule(3.4, 1.5)]),
    testItem('2000604A', '载脂蛋白A1测定', '血清、血浆', 'g/L', 2, [rangeRule(1.0, 1.6)]),
    testItem('2000704A', '载脂蛋白B测定', '血清、血浆', 'g/L', 2, [rangeRule(0.6, 1.1)]),
    testItem('1700204A', '尿素测定', '血清、血浆', 'mmol/L', 2, [rangeRule(2.8, 7.6)]),
    testItem('1700304A', '尿酸测定', '血清、血浆', 'umol/L', 0, [rangeRule(208, 428, 'male'), rangeRule(155, 357, 'female')]),
    testItem('1700404A', '肌酐测定', '血清、血浆', 'umol/L', 0, [rangeRule(57, 97, 'male'), rangeRule(41, 73, 'female')]),
    testItem('1101204A', '胱抑素C测定', '血清、血浆', 'mg/L', 2, [rangeRule(0.51, 1.09)]),
    testItem('1400205A', '钠测定', '血清、血浆', 'mmol/L', 1, [rangeRule(137, 147)]),
    testItem('1400305A', '镁测定', '血清、血浆', 'mmol/L', 2, [rangeRule(0.75, 1.02)]),
    testItem('1400404A', '无机磷测定', '血清、血浆', 'mmol/L', 2, [rangeRule(0.85, 1.51)]),
    testItem('1400505A', '氯测定', '血清、血浆', 'mmol/L', 1, [rangeRule(99, 110)]),
    testItem('1400605A', '钾测定', '血清、血浆', 'mmol/L', 2, [rangeRule(3.5, 5.3)]),
    testItem('1400705A', '总钙测定', '血清、血浆', 'mmol/L', 2, [rangeRule(2.11, 2.52)]),
    testItem('1100301A', '糖化血红蛋白测定', '全血', '%', 1, [rangeRule(4.0, 6.0)]),
    testItem('0500103A', '凝血酶原时间测定', '血浆', 's', 1, [rangeRule(11, 14)]),
    testItem('0500203A', '活化部分凝血活酶时间测定', '血浆', 's', 1, [rangeRule(25, 37)]),
    testItem('0501703A', 'D-二聚体测定', '血浆', 'mg/L', 2, [upperRule(0.5, 0.05)]),
    testItem('1201004A', '促甲状腺激素测定', '血清、血浆', 'mIU/L', 2, [rangeRule(0.27, 4.2)]),
  ]
  const panels = [
    panelItem('CN-LAB-CBC-5DIFF', '血常规（五分类）', '全血', ['0100101A', '0100201A', '0100301A', '0100401A', '0100501A', '0100601A', '0100701A', '0100801A']),
    panelItem('CN-LAB-CARDIAC', '心肌损伤标志物组合', '血清、血浆', ['2100104A', '2100304A', '2100404A', '2100504A', '2100604A', '2100704A']),
    panelItem('CN-LAB-LIPIDS', '血脂组合', '血清、血浆', ['2000104A', '2000204A', '2000304A', '2000404A', '2000604A', '2000704A']),
    panelItem('CN-LAB-RENAL', '肾功能组合', '血清、血浆', ['1700204A', '1700304A', '1700404A', '1101204A']),
    panelItem('CN-LAB-ELECTROLYTES', '电解质组合', '血清、血浆', ['1400205A', '1400305A', '1400404A', '1400505A', '1400605A', '1400705A']),
    panelItem('CN-LAB-HBA1C', '糖化血红蛋白组合', '全血', ['1100301A']),
    panelItem('CN-LAB-COAGULATION', '凝血筛查组合', '血浆', ['0500103A', '0500203A']),
  ]
  const diagnoses = diagnosisMetadata.map(({ code, display, row }) => ({
    code,
    display,
    domain: 'diagnosis' as const,
    id: `nhsa-diagnosis:nhc-icd10-clinical@2022.r4:${code}`,
    sourceLocator: `cn-health:nhc-icd10-clinical@2022.r4:diagnosis:${row}`,
    status: 'active' as const,
    system: 'urn:clinmesh:reference:nhsa-diagnosis',
    version: '2022',
  }))

  const artifactJson = `${JSON.stringify({
    concepts: [...diagnoses, ...tests.map(item => item.concept), ...panels.map(item => item.concept)],
    laboratoryDefinitions: [...tests.map(item => item.definition), ...panels.map(item => item.definition)],
    laboratoryPanelMembers: panels.flatMap(item => item.members),
    laboratorySpecimens: [],
    laboratoryUnits: [],
    medicationProducts: syntheticNhsaMedicationProductSnapshot,
    schemaVersion: '1',
    services: syntheticNhcMedicalServiceSnapshot,
    valueSetEntries: syntheticWstValueSetSnapshot,
  })}\n`
  const manifestPath = join(directory, 'baseline-release.json')
  await writeFile(join(directory, 'baseline-reference.json'), artifactJson)
  await writeFile(manifestPath, `${JSON.stringify({
    createdAt: '2026-09-02T00:00:00.000Z',
    releaseId: referenceReleaseId,
    schemaVersion: '1',
    sources: [{
      acquisitionMethod: 'generated',
      artifactPath: 'baseline-reference.json',
      checksum: createHash('sha256').update(artifactJson).digest('hex'),
      licenseId: 'LicenseRef-Synthetic-Test',
      retrievedAt: '2026-09-02T00:00:00.000Z',
      sourceId: 'cn-health-laboratory-cn',
      sourceUrl: 'https://example.test/dsap-baseline-reference',
      upstreamVersion: '2026-09-01',
    }],
  })}\n`)
  await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
  await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', manifestPath])
  return referenceDatabasePath
}

function normalizeGuidelineTopics(bundle: GuidelineTopicBundle) {
  return bundle.items.map(item => ({
    degradedReason: item.degradedReason,
    fingerprint: item.topic.fingerprint,
    guidelineCount: item.guidelines.length,
    missingPatientInputs: [...item.missingPatientInputs],
    missingSources: [...item.missingSources].sort(),
    patientIndicators: [...item.patientIndicators]
      .map(indicator => ({ code: indicator.code, status: indicator.status, valueText: indicator.valueText }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    population: item.population,
    status: item.status,
    topicId: item.topic.id,
    version: item.topic.version,
  }))
}

function normalizeClinicalScores(bundle: ClinicalScoreBundle) {
  return {
    scores: bundle.scores.map(score => ({
      id: score.id,
      missingInputs: score.status === 'incomplete' ? [...score.missingInputs].sort() : [],
      status: score.status,
      summaryZh: score.summaryZh,
      tierCode: score.tierCode,
      tierLabelZh: score.tierLabelZh,
      unit: score.unit,
      value: score.value,
    })),
    vitalSigns: bundle.vitalSigns === null
      ? null
      : {
          bloodPressure: bundle.vitalSigns.bloodPressure,
          oxygenSaturationPct: bundle.vitalSigns.oxygenSaturationPct,
          pulseBpm: bundle.vitalSigns.pulseBpm,
          respirationBpm: bundle.vitalSigns.respirationBpm,
          temperatureC: bundle.vitalSigns.temperatureC,
          ...(bundle.vitalSigns.weightKg === undefined ? {} : { weightKg: bundle.vitalSigns.weightKg }),
        },
  }
}

function normalizeClinicalQuality(check: ClinicalQualityCheck) {
  const normalizeItem = (item: ClinicalQualityCheck['alerts'][number] | ClinicalQualityCheck['redLines'][number]) => ({
    ...(item.catalogItemId === undefined ? {} : { catalogItemId: item.catalogItemId }),
    code: item.code,
    evidenceTypes: item.evidence.map(ev => ev.reference.split('/')[0]!).sort(),
    message: item.message,
    tier: item.tier,
  })
  return {
    alerts: check.alerts.map(normalizeItem).sort((a, b) => a.code.localeCompare(b.code)),
    gate: check.gate,
    redLines: check.redLines.map(normalizeItem).sort((a, b) => a.code.localeCompare(b.code)),
    ...(check.status === undefined ? {} : { status: check.status }),
  }
}

function normalizeOrderSetDrafts(bundle: OrderSetDraftBundle) {
  return {
    drafts: bundle.drafts.map(draft => ({
      counts: draft.counts,
      items: draft.items.map(item => ({
        disposition: item.disposition,
        key: item.key,
        kind: item.kind,
        reasons: item.reasons.map(reason => ({ code: reason.code, severity: reason.severity })),
      })),
      templateId: draft.template.id,
      version: draft.template.version,
    })),
    patientFacts: {
      allergiesCount: bundle.patientFacts.allergies.length,
      egfr: bundle.patientFacts.egfr.status === 'present'
        ? { status: 'present' as const, valueMlMin173: bundle.patientFacts.egfr.valueMlMin173 }
        : { missingInputs: [...bundle.patientFacts.egfr.missingInputs].sort(), status: 'missing' as const },
      vitalSigns: bundle.patientFacts.vitalSigns.status === 'present'
        ? {
            diastolicMmHg: bundle.patientFacts.vitalSigns.diastolicMmHg,
            pulseBpm: bundle.patientFacts.vitalSigns.pulseBpm,
            source: bundle.patientFacts.vitalSigns.source,
            status: 'present' as const,
            systolicMmHg: bundle.patientFacts.vitalSigns.systolicMmHg,
          }
        : { source: bundle.patientFacts.vitalSigns.source, status: 'missing' as const },
      weight: bundle.patientFacts.weight.status === 'present'
        ? { status: 'present' as const, weightKg: bundle.patientFacts.weight.weightKg }
        : { status: 'missing' as const },
    },
  }
}

function diagnosisCatalogIdForCode(code: string): string {
  return `nhsa-diagnosis:nhc-icd10-clinical@2022.r4:${code}`
}

export async function runDsapGoldenBaseline() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-dsap-golden-baseline-'))
  let runtime: Runtime | undefined
  let llmInvocationCount = 0

  try {
    const guidelineDatabasePath = join(directory, 'guidelines.sqlite')
    buildPinnedGuidelineDatabase(guidelineDatabasePath)
    const referenceDatabasePath = await buildSyntheticReferenceDatabase(directory)

    runtime = await createClinMeshRuntime({
      activeReferenceReleaseId: referenceReleaseId,
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      chatCompletionsProvider: {
        completeJson: async () => {
          llmInvocationCount += 1
          throw new Error('DSAP golden baseline must not fall back to LLM generation')
        },
      },
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'operational.sqlite'),
      demoPassword,
      guidelineDatabasePath,
      investigationModel: 'unexpected-investigation-model',
      migrationMode: 'apply',
      referenceDatabasePath,
      trustedOrigins: ['http://localhost'],
    })
    const activeRuntime = runtime

    const signIn = async (email: string): Promise<string> => {
      const response = await activeRuntime.app.request('/api/auth/sign-in/email', {
        body: JSON.stringify({ email, password: demoPassword }),
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        method: 'POST',
      })
      if (response.status !== 200) throw new Error(`Failed login for ${email}: ${response.status}`)
      return response.headers.get('set-cookie')!.split(';', 1)[0]!
    }

    const requestJson = async (
      path: string,
      cookie: string,
      method: 'GET' | 'POST' | 'PUT' = 'GET',
      body?: unknown,
    ) => {
      const response = await activeRuntime.app.request(path, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          cookie,
          ...(method === 'GET' ? {} : {
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
            origin: 'http://localhost',
          }),
        },
        method,
      })
      if (response.status !== 200) {
        throw new Error(`${method} ${path} failed (${response.status}): ${await response.text()}`)
      }
      return response.json() as Promise<unknown>
    }

    const cookies = {
      admin: await signIn('admin@demo.clinmesh.local'),
      cashier: await signIn('cashier@demo.clinmesh.local'),
      doctor: await signIn('doctor@demo.clinmesh.local'),
      inpatientDoctor: await signIn('inpatient-doctor@demo.clinmesh.local'),
      nurse: await signIn('ward-nurse@demo.clinmesh.local'),
      registrar: await signIn('registrar@demo.clinmesh.local'),
      triage: await signIn('triage@demo.clinmesh.local'),
    }

    const currentScenario = scenarioStateSchema.parse(
      await requestJson('/api/sim/v1/scenario-runs/current', cookies.admin),
    )
    const epoch = scenarioCommandResponseSchema.parse(
      await requestJson(`/api/sim/v1/scenario-runs/${currentScenario.scenarioRunId}/actions/reset`, cookies.admin, 'POST', {}),
    ).data.epoch

    const authoredPrepared = authoredCasePackPrepareResponseSchema.parse(
      await requestJson('/api/sim/v1/synthetic-cases/authored-pack/prepare', cookies.admin, 'POST', {
        input: { expectedEpoch: epoch },
      }),
    ).data
    const goldenPrepared = authoredCasePackPrepareResponseSchema.parse(
      await requestJson('/api/sim/v1/synthetic-cases/golden-pack/prepare', cookies.admin, 'POST', {
        input: { expectedEpoch: epoch },
      }),
    ).data

    const preparedCasesByDraftId = new Map(
      [...authoredPrepared.cases, ...goldenPrepared.cases].map(entry => [entry.draftId, entry.case!]),
    )

    const registrationCatalog = registrationCatalogSchema.parse(
      await requestJson('/api/his/v1/catalogs/registration', cookies.admin),
    )

    const drainOutbox = async () => {
      while ((await activeRuntime.dispatcher.dispatchOnce()) !== undefined) {
        // drain deterministic queue
      }
    }

    const payInvestigation = async (caseId: string, category: 'laboratory' | 'examination', chargeItemId: string) => {
      const billing = billingCaseSchema.parse(await requestJson(`/api/his/v1/billing/cases/${caseId}`, cookies.cashier))
      const charge = billing.charges.find(item => item.chargeItemId === chargeItemId)!
      const expectedVersions = { [`ChargeItem/${charge.chargeItemId}`]: String(charge.chargeVersion) }
      const preview = paymentPreviewResponseSchema.parse(
        await requestJson('/api/his/v1/payments/actions/preview', cookies.cashier, 'POST', {
          expectedVersions,
          input: { caseId, category, chargeItemId, simulatorRule: 'success' },
        }),
      ).data
      const confirmed = paymentResponseSchema.parse(
        await requestJson(`/api/his/v1/payments/${preview.previewId}/actions/confirm`, cookies.cashier, 'POST', {
          expectedVersions,
          input: { commitToken: preview.commitToken },
        }),
      ).data
      if (confirmed.outcome !== 'success') throw new Error(`Payment failed for ${chargeItemId}`)
    }

    const fetchCaseDetail = async (caseId: string) => doctorCaseDetailSchema.parse(
      await requestJson(`/api/his/v1/doctor/cases/${caseId}`, cookies.doctor),
    )

    const prepareOutpatientPrerequisites = async (
      caseId: string,
      compiledCase: CompiledAuthoredCase,
    ) => {
      const detail0 = await fetchCaseDetail(caseId)
      const encounterId = detail0.encounter.id
      const savedDoc = clinicalDocumentDraftResponseSchema.parse(
        await requestJson(`/api/his/v1/encounters/${encounterId}/clinical-document/draft`, cookies.doctor, 'PUT', {
          expectedVersions: { [`Encounter/${encounterId}`]: detail0.encounter.versionId },
          input: {
            document: {
              allergyHistory: '否认已知药物过敏。',
              assessment: '完成初诊病情与辅助检查前评估。',
              auxiliaryExamination: '见已回报检查及检验报告。',
              chiefComplaint: compiledCase.definition.chiefComplaint,
              disposition: '按专病评估流程完善检查并评估处理。',
              familyHistory: '详见既往史与家族史记录。',
              followUp: '按医嘱复诊或随访。',
              historyOfPresentIllness: compiledCase.persona.content.symptomExperience,
              menstrualHistory: '无特殊补充。',
              obstetricHistory: '详见病历记录。',
              physicalExamination: '神志清，生命体征详见分诊记录。',
              priorMedicalHistory: compiledCase.persona.content.knownHistorySummary,
            },
            expectedDraftVersion: detail0.clinicalDocument?.draft?.version ?? 0,
          },
        }),
      ).data
      const preview = clinicalDocumentSignPreviewResponseSchema.parse(
        await requestJson(`/api/his/v1/encounters/${encounterId}/clinical-document/actions/preview-sign`, cookies.doctor, 'POST', {
          expectedVersions: { [`Encounter/${encounterId}`]: detail0.encounter.versionId },
          input: { expectedDraftVersion: savedDoc.draftVersion },
        }),
      ).data
      clinicalDocumentSignResponseSchema.parse(
        await requestJson(`/api/his/v1/encounters/${encounterId}/clinical-document/actions/sign`, cookies.doctor, 'POST', {
          expectedVersions: { [`Encounter/${encounterId}`]: detail0.encounter.versionId },
          input: { commitToken: preview.commitToken, previewId: preview.previewId },
        }),
      )

      const detailAfterSign = await fetchCaseDetail(caseId)
      const conditionsToConfirm = compiledCase.definition.id === 'cardio-nstemi-chest-pain-v1'
        ? compiledCase.definition.indexConditions.slice(0, 1)
        : compiledCase.definition.indexConditions
      const diagEntries = conditionsToConfirm.map((cond, index) => ({
        catalogItemId: diagnosisCatalogIdForCode(cond.code),
        role: (index === 0 ? 'primary' : 'secondary') as 'primary' | 'secondary',
      }))
      const savedDiag = diagnosisDraftResponseSchema.parse(
        await requestJson(`/api/his/v1/encounters/${encounterId}/diagnosis/draft`, cookies.doctor, 'PUT', {
          expectedVersions: { [`Encounter/${encounterId}`]: detailAfterSign.encounter.versionId },
          input: {
            entries: diagEntries,
            expectedDraftVersion: detailAfterSign.diagnosis?.draftVersion ?? 0,
          },
        }),
      ).data
      confirmDiagnosisResponseSchema.parse(
        await requestJson(`/api/his/v1/encounters/${encounterId}/diagnosis/actions/confirm`, cookies.doctor, 'POST', {
          expectedVersions: { [`Encounter/${encounterId}`]: detailAfterSign.encounter.versionId },
          input: { expectedDraftVersion: savedDiag.draftVersion },
        }),
      )
      return encounterId
    }

    const orderAndRunOutpatientLab = async (caseId: string, encounterId: string, catalogItemId: string, indicationCode: string) => {
      const before = await fetchCaseDetail(caseId)
      const saved = laboratoryRequestDraftResponseSchema.parse(
        await requestJson(`/api/his/v1/encounters/${encounterId}/laboratory-request/draft`, cookies.doctor, 'PUT', {
          expectedVersions: { [`Encounter/${encounterId}`]: before.encounter.versionId },
          input: {
            catalogItemId,
            expectedDraftVersion: before.laboratoryRequests?.draftVersion ?? 0,
            indicationCode,
          },
        }),
      ).data
      const afterDraft = await fetchCaseDetail(caseId)
      const issued = issueLaboratoryRequestResponseSchema.parse(
        await requestJson(`/api/his/v1/encounters/${encounterId}/laboratory-request/actions/issue`, cookies.doctor, 'POST', {
          expectedVersions: { [`Encounter/${encounterId}`]: afterDraft.encounter.versionId },
          input: { expectedDraftVersion: saved.draftVersion },
        }),
      ).data.request
      await payInvestigation(caseId, 'laboratory', issued.billing!.chargeItemId)
      await drainOutbox()
      return (await fetchCaseDetail(caseId)).laboratoryRequests!.requests.find(req => req.id === issued.id)!
    }

    const orderAndRunOutpatientExam = async (
      caseId: string,
      encounterId: string,
      serviceId: 'examination-ecg-12-lead' | 'examination-tte',
      indication: string,
    ) => {
      const before = await fetchCaseDetail(caseId)
      const saved = examinationRequestDraftResponseSchema.parse(
        await requestJson(`/api/his/v1/encounters/${encounterId}/examination-request/draft`, cookies.doctor, 'PUT', {
          expectedVersions: { [`Encounter/${encounterId}`]: before.encounter.versionId },
          input: {
            expectedDraftVersion: before.examinationRequests?.draftVersion ?? 0,
            indication,
            serviceId,
          },
        }),
      ).data
      const afterDraft = await fetchCaseDetail(caseId)
      const issued = issueExaminationRequestResponseSchema.parse(
        await requestJson(`/api/his/v1/encounters/${encounterId}/examination-request/actions/issue`, cookies.doctor, 'POST', {
          expectedVersions: { [`Encounter/${encounterId}`]: afterDraft.encounter.versionId },
          input: { expectedDraftVersion: saved.draftVersion },
        }),
      ).data.request
      await payInvestigation(caseId, 'examination', issued.billing!.chargeItemId)
      await drainOutbox()
      return (await fetchCaseDetail(caseId)).examinationRequests!.requests.find(req => req.id === issued.id)!
    }

    const startOutpatientCase = async (compiledCase: CompiledAuthoredCase) => {
      const syntheticSummary = preparedCasesByDraftId.get(compiledCase.definition.id)!
      const syntheticCase = syntheticCaseInstanceSchema.parse(
        await requestJson(`/api/sim/v1/synthetic-cases/${syntheticSummary.caseId}`, cookies.admin),
      )
      const started = commandResponseSchema(startSyntheticCaseResultSchema).parse(
        await requestJson(`/api/his/v1/synthetic-cases/${syntheticCase.caseId}/actions/start-outpatient-visit`, cookies.admin, 'POST', {
          activeBriefRevision: syntheticCase.activeBriefRevision,
          departmentId: registrationCatalog.departments[0]!.id,
          expectedCaseRevision: syntheticCase.revision,
          locationId: registrationCatalog.locations[0]!.id,
          visitDate: registrationCatalog.virtualDate,
          visitTypeId: registrationCatalog.visitTypes[0]!.id,
        }),
      ).data
      const seed = triageSeeds[compiledCase.definition.id]!
      const triage = triageResponseSchema.parse(
        await requestJson(`/api/his/v1/encounters/${started.encounterId}/actions/record-triage`, cookies.triage, 'POST', {
          expectedVersions: { [`Encounter/${started.encounterId}`]: '1', [`Task/${started.queueTaskId}`]: '1' },
          input: {
            acuityCode: 'level-2',
            bloodPressure: { diastolicMmHg: seed.diastolicMmHg, systolicMmHg: seed.systolicMmHg },
            chiefComplaint: compiledCase.definition.chiefComplaint,
            oxygenSaturationPct: seed.oxygenSaturationPct,
            pulseBpm: seed.pulseBpm,
            respirationBpm: 18,
            temperatureC: 36.6,
            weightKg: seed.weightKg,
          },
        }),
      ).data
      startVisitResponseSchema.parse(
        await requestJson(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, cookies.doctor, 'POST', {
          expectedVersions: { [`Encounter/${started.encounterId}`]: '2', [`Task/${triage.doctorTaskId}`]: '1' },
          input: {},
        }),
      )
      await prepareOutpatientPrerequisites(started.outpatientCaseId, compiledCase)
      return started
    }

    const findLabService = async (caseId: string, code: string) => {
      const result = caseLaboratoryCatalogSearchSchema.parse(
        await requestJson(
          `/api/his/v1/doctor/cases/${caseId}/reference-catalogs/laboratory?page=1&pageSize=20&query=${encodeURIComponent(code)}`,
          cookies.doctor,
        ),
      )
      return result.items.find(item => item.referenceConcept.code === code)!
    }

    const caseSnapshots: unknown[] = []
    let inpatientBedCounter = 1
    let stageResolution: unknown = null
    let unprepopulatedEnforcement: unknown = null

    for (const compiledCase of listFrozenDsapGoldenCases()) {
      const draftId = compiledCase.definition.id
      if (compiledCase.definition.recommendedEntry === 'outpatient') {
        const started = await startOutpatientCase(compiledCase)
        const guidelineTopics = normalizeGuidelineTopics(guidelineTopicBundleSchema.parse(
          await requestJson(`/api/his/v1/doctor/cases/${started.outpatientCaseId}/guideline-topics`, cookies.doctor),
        ))
        const clinicalScores = normalizeClinicalScores(clinicalScoreBundleSchema.parse(
          await requestJson(`/api/his/v1/doctor/cases/${started.outpatientCaseId}/clinical-scores`, cookies.doctor),
        ))
        const outpatientCompletionGate = normalizeClinicalQuality(clinicalQualityCheckSchema.parse(
          await requestJson(`/api/his/v1/encounters/${started.encounterId}/clinical-quality?gate=outpatient-completion`, cookies.doctor),
        ))
        const outpatientPrescriptionGate = normalizeClinicalQuality(clinicalQualityCheckSchema.parse(
          await requestJson(`/api/his/v1/encounters/${started.encounterId}/clinical-quality?gate=outpatient-prescription`, cookies.doctor),
        ))
        const orderSetDrafts = normalizeOrderSetDrafts(orderSetDraftBundleSchema.parse(
          await requestJson(`/api/his/v1/doctor/cases/${started.outpatientCaseId}/order-set-drafts`, cookies.doctor),
        ))

        caseSnapshots.push({
          clinicalQualityGates: {
            'outpatient-completion': outpatientCompletionGate,
            'outpatient-prescription': outpatientPrescriptionGate,
          },
          clinicalScores,
          draftId,
          entryPath: 'outpatient',
          guidelineTopics,
          orderSetDrafts,
          recommendedEntry: compiledCase.definition.recommendedEntry,
        })

        if (draftId === 'cardio-nstemi-chest-pain-v1') {
          const cardiacService = await findLabService(started.outpatientCaseId, 'CN-LAB-CARDIAC')
          const lipidsService = await findLabService(started.outpatientCaseId, 'CN-LAB-LIPIDS')

          const initialCardiac = await orderAndRunOutpatientLab(
            started.outpatientCaseId,
            started.encounterId,
            cardiacService.id,
            cardiacService.allowedIndicationCodes[0]!,
          )
          const repeatCardiac = await orderAndRunOutpatientLab(
            started.outpatientCaseId,
            started.encounterId,
            cardiacService.id,
            cardiacService.allowedIndicationCodes[0]!,
          )

          for (const labReq of [initialCardiac, repeatCardiac]) {
            await requestJson(
              `/api/his/v1/laboratory-requests/${labReq.id}/reports/${labReq.report!.diagnosticReportId}/actions/acknowledge`,
              cookies.doctor,
              'POST',
              {
                expectedVersions: { [`DiagnosticReport/${labReq.report!.diagnosticReportId}`]: labReq.report!.diagnosticReportVersion },
                input: { expectedRequestVersion: labReq.version },
              },
            )
          }

          const beforeNoMed = await fetchCaseDetail(started.outpatientCaseId)
          confirmNoMedicationResponseSchema.parse(
            await requestJson(`/api/his/v1/encounters/${started.encounterId}/medication-conclusion/actions/confirm-no-medication`, cookies.doctor, 'POST', {
              expectedVersions: { [`Encounter/${started.encounterId}`]: beforeNoMed.encounter.versionId },
              input: { expectedDraftVersion: beforeNoMed.medicationConclusion?.draftVersion ?? 0 },
            }),
          )

          const completionQuality = clinicalQualityCheckSchema.parse(
            await requestJson(`/api/his/v1/encounters/${started.encounterId}/clinical-quality?gate=outpatient-completion`, cookies.doctor),
          )
          const beforeComplete = await fetchCaseDetail(started.outpatientCaseId)
          encounterCompletionResponseSchema.parse(
            await requestJson(`/api/his/v1/encounters/${started.encounterId}/actions/complete`, cookies.doctor, 'POST', {
              expectedVersions: {
                [`Encounter/${started.encounterId}`]: beforeComplete.encounter.versionId,
              },
              input: completionQuality.alerts.length === 0
                ? {}
                : {
                    clinicalOverride: {
                      acknowledgedAlerts: completionQuality.alerts.map(alert => alert.code),
                      note: '完成初诊阶段检验复查后转入复诊随访阶段。',
                      reasonCode: 'clinical-judgement',
                    },
                  },
            }),
          )

          const revisitReg = registrationResponseSchema.parse(
            await requestJson('/api/his/v1/registrations/actions/register', cookies.registrar, 'POST', {
              expectedVersions: { [`Patient/${beforeComplete.patient.id}`]: beforeComplete.patient.versionId },
              input: {
                departmentId: registrationCatalog.departments[0]!.id,
                locationId: registrationCatalog.locations[0]!.id,
                patientId: beforeComplete.patient.id,
                visitDate: registrationCatalog.virtualDate,
                visitTypeId: registrationCatalog.visitTypes[0]!.id,
              },
            }),
          ).data
          const revisitTriage = triageResponseSchema.parse(
            await requestJson(`/api/his/v1/encounters/${revisitReg.encounterId}/actions/record-triage`, cookies.triage, 'POST', {
              expectedVersions: { [`Encounter/${revisitReg.encounterId}`]: '1', [`Task/${revisitReg.queueTaskId}`]: '1' },
              input: {
                acuityCode: 'level-3',
                bloodPressure: { diastolicMmHg: 78, systolicMmHg: 126 },
                chiefComplaint: '心梗治疗后门诊随访复查肌钙蛋白与血脂。',
                oxygenSaturationPct: 98,
                pulseBpm: 68,
                respirationBpm: 16,
                temperatureC: 36.5,
                weightKg: 74,
              },
            }),
          ).data
          startVisitResponseSchema.parse(
            await requestJson(`/api/his/v1/encounters/${revisitReg.encounterId}/actions/start-first-visit`, cookies.doctor, 'POST', {
              expectedVersions: { [`Encounter/${revisitReg.encounterId}`]: '2', [`Task/${revisitTriage.doctorTaskId}`]: '1' },
              input: {},
            }),
          )
          const queue = doctorQueueSchema.parse(
            await requestJson('/api/his/v1/doctor/queue?pageSize=20', cookies.doctor),
          )
          const revisitCaseId = queue.items.find(item => item.encounterId === revisitReg.encounterId)!.caseId
          await prepareOutpatientPrerequisites(revisitCaseId, compiledCase)

          const followUpCardiac = await orderAndRunOutpatientLab(
            revisitCaseId,
            revisitReg.encounterId,
            cardiacService.id,
            cardiacService.allowedIndicationCodes[0]!,
          )
          const followUpLipids = await orderAndRunOutpatientLab(
            revisitCaseId,
            revisitReg.encounterId,
            lipidsService.id,
            lipidsService.allowedIndicationCodes[0]!,
          )
          const extractResult = (req: Awaited<ReturnType<typeof orderAndRunOutpatientLab>>, code: string) => {
            const item = req.report!.results.find(entry => entry.code === code)!
            return {
              code: item.code,
              interpretation: item.interpretation,
              unit: 'unit' in item ? item.unit.code : null,
              value: item.value,
            }
          }
          stageResolution = {
            caseId: draftId,
            followUp: {
              hsCtni: extractResult(followUpCardiac, '2100404B'),
              ldl: extractResult(followUpLipids, '2000404A'),
            },
            initial: {
              hsCtni: extractResult(initialCardiac, '2100404B'),
            },
            repeat: {
              hsCtni: extractResult(repeatCardiac, '2100404B'),
            },
          }
        }

        if (draftId === 'trap-low-risk-chest-wall-pain-v1') {
          const cardiacService = await findLabService(started.outpatientCaseId, 'CN-LAB-CARDIAC')
          const tshService = await findLabService(started.outpatientCaseId, '1201004A')
          const coagService = await findLabService(started.outpatientCaseId, 'CN-LAB-COAGULATION')

          const ecg = await orderAndRunOutpatientExam(started.outpatientCaseId, started.encounterId, 'examination-ecg-12-lead', '低危胸壁压痛基线心电图排查')
          const cardiac = await orderAndRunOutpatientLab(started.outpatientCaseId, started.encounterId, cardiacService.id, cardiacService.allowedIndicationCodes[0]!)
          const tsh = await orderAndRunOutpatientLab(started.outpatientCaseId, started.encounterId, tshService.id, tshService.allowedIndicationCodes[0]!)
          const coag = await orderAndRunOutpatientLab(started.outpatientCaseId, started.encounterId, coagService.id, coagService.allowedIndicationCodes[0]!)
          const tte = await orderAndRunOutpatientExam(started.outpatientCaseId, started.encounterId, 'examination-tte', '测试未预置超声')

          unprepopulatedEnforcement = {
            caseId: draftId,
            prepopulatedResults: {
              cardiacPanel: {
                analytes: cardiac.report!.results.map(item => ({
                  code: item.code,
                  interpretation: item.interpretation,
                  unit: 'unit' in item ? item.unit.code : null,
                  value: item.value,
                })),
                status: cardiac.status,
              },
              ecg12Lead: {
                impression: ecg.report!.impression,
                status: ecg.status,
              },
            },
            unprepopulatedFailures: {
              examinationTte: { generationError: tte.generationError ?? null, serviceId: 'examination-tte', status: tte.status },
              panelCoagulation: { catalogCode: 'CN-LAB-COAGULATION', generationError: coag.generationError ?? null, status: coag.status },
              singleLabTsh: { catalogCode: '1201004A', generationError: tsh.generationError ?? null, status: tsh.status },
            },
          }
        }
      } else {
        const syntheticSummary = preparedCasesByDraftId.get(draftId)!
        const syntheticCase = syntheticCaseInstanceSchema.parse(
          await requestJson(`/api/sim/v1/synthetic-cases/${syntheticSummary.caseId}`, cookies.admin),
        )
        const started = commandResponseSchema(startSyntheticInpatientCaseResponseSchema.shape.data).parse(
          await requestJson(`/api/his/v1/synthetic-cases/${syntheticCase.caseId}/actions/start-inpatient-visit`, cookies.registrar, 'POST', {
            activeBriefRevision: syntheticCase.activeBriefRevision,
            expectedCaseRevision: syntheticCase.revision,
            expectedEpoch: epoch,
            wardId: 'ward-general',
          }),
        ).data
        const admissionPath = `/api/his/v1/inpatient/admissions/${started.admissionId}`
        const registered = inpatientDetailSchema.parse(await requestJson(admissionPath, cookies.registrar))
        const received = inpatientCommandResponseSchema.parse(
          await requestJson(`${admissionPath}/receive`, cookies.nurse, 'POST', {
            input: {
              bedId: `bed-general-${inpatientBedCounter}`,
              encounterVersion: registered.admission.versionId,
            },
          }),
        ).data.admission
        inpatientBedCounter += 1

        inpatientFullClinicalResponseSchema.parse(
          await requestJson(`${admissionPath}/diagnoses/confirm`, cookies.inpatientDoctor, 'POST', {
            input: {
              encounterVersion: received.versionId,
              entries: compiledCase.definition.indexConditions.map((cond, index) => ({
                admissionCondition: '1' as const,
                catalogItemId: diagnosisCatalogIdForCode(cond.code),
                note: cond.note ?? cond.display,
                role: (index === 0 ? 'primary' : 'secondary') as 'primary' | 'secondary',
              })),
              expectedRevision: 0,
            },
          }),
        )

        const guidelineTopics = normalizeGuidelineTopics(guidelineTopicBundleSchema.parse(
          await requestJson(`${admissionPath}/guideline-topics`, cookies.inpatientDoctor),
        ))
        const clinicalScores = normalizeClinicalScores(clinicalScoreBundleSchema.parse(
          await requestJson(`${admissionPath}/clinical-scores`, cookies.inpatientDoctor),
        ))
        const pciPlanGate = normalizeClinicalQuality(clinicalQualityCheckSchema.parse(
          await requestJson(`${admissionPath}/clinical-quality?gate=inpatient-pci-plan`, cookies.inpatientDoctor),
        ))
        const dischargeGate = normalizeClinicalQuality(clinicalQualityCheckSchema.parse(
          await requestJson(`${admissionPath}/clinical-quality?gate=inpatient-discharge`, cookies.inpatientDoctor),
        ))
        const orderSetDrafts = normalizeOrderSetDrafts(orderSetDraftBundleSchema.parse(
          await requestJson(`${admissionPath}/order-set-drafts`, cookies.inpatientDoctor),
        ))

        caseSnapshots.push({
          clinicalQualityGates: {
            'inpatient-discharge': dischargeGate,
            'inpatient-pci-plan': pciPlanGate,
          },
          clinicalScores,
          draftId,
          entryPath: 'inpatient',
          guidelineTopics,
          orderSetDrafts,
          recommendedEntry: compiledCase.definition.recommendedEntry,
        })
      }
    }

    const hospitalBaseline = createHospitalBaseline(
      syntheticNhsaMedicationProductSnapshot,
      syntheticNhcMedicalServiceSnapshot,
      syntheticWstValueSetSnapshot,
    )
    return {
      baselinePack: {
        authoredPackHash: compiledCardiorenalAuthoredCasePack.contentHash,
        authoredPackId: compiledCardiorenalAuthoredCasePack.id,
        authoredPackVersion: compiledCardiorenalAuthoredCasePack.version,
        extraGoldenPackHash: compiledDsapExtraGoldenCasePack.contentHash,
        extraGoldenPackId: compiledDsapExtraGoldenCasePack.id,
        extraGoldenPackVersion: compiledDsapExtraGoldenCasePack.version,
        frozenCaseIds: listFrozenDsapGoldenCases().map(item => item.definition.id),
        guidelineTopicsCount: listGuidelineTopicDefinitions().length,
        hospital: {
          id: hospitalBaseline.hospital.id,
          name: hospitalBaseline.hospital.name,
        },
        llmInvocationCount,
      },
      cases: caseSnapshots,
      schemaVersion: '1' as const,
      stageResolution,
      unprepopulatedEnforcement,
    }
  } finally {
    await runtime?.close()
    await rm(directory, { force: true, recursive: true })
  }
}

export type DsapGoldenBaselineSnapshot = Awaited<ReturnType<typeof runDsapGoldenBaseline>>
