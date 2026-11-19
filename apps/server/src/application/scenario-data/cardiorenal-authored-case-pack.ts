import {
  compileAuthoredCasePack,
  type AuthoredCasePackDefinitionInput,
  type AuthoredLabObservation,
} from './authored-case-pack-compiler.ts'
import type { CaseTruthStage } from './truth-stage.ts'

const wst886 = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026'
const loinc = 'http://loinc.org'
const icd10 = 'http://hl7.org/fhir/sid/icd-10'
const nhsaDiagnosis = 'urn:clinmesh:reference:nhsa-diagnosis'

const indexDateTime = '2026-08-24T08:00:00+08:00'

type LabSpec = {
  codings: AuthoredLabObservation['codings']
  unit: string
  unitDisplay?: string
}

const labCatalog = {
  alt: { codings: [{ code: '1742-6', display: '丙氨酸氨基转移酶', system: loinc, version: '2.83' }], unit: 'U/L' },
  apoa1: {
    codings: [
      { code: '2000604A', display: '载脂蛋白A1测定', system: wst886, version: '2026' },
      { code: '1869-7', display: 'Apolipoprotein A-I', system: loinc, version: '2.83' },
    ],
    unit: 'g/L',
  },
  apob: {
    codings: [
      { code: '2000704A', display: '载脂蛋白B测定', system: wst886, version: '2026' },
      { code: '1884-6', display: 'Apolipoprotein B', system: loinc, version: '2.83' },
    ],
    unit: 'g/L',
  },
  ast: { codings: [{ code: '1920-8', display: '天冬氨酸氨基转移酶', system: loinc, version: '2.83' }], unit: 'U/L' },
  bnp: {
    codings: [
      { code: '2100604A', display: '脑利钠肽测定', system: wst886, version: '2026' },
      { code: '30934-4', display: 'Natriuretic peptide B', system: loinc, version: '2.83' },
    ],
    unit: 'ng/L',
  },
  calcium: {
    codings: [
      { code: '1400705A', display: '总钙测定', system: wst886, version: '2026' },
      { code: '17861-6', display: 'Calcium', system: loinc, version: '2.83' },
    ],
    unit: 'mmol/L',
  },
  chloride: {
    codings: [
      { code: '1400505A', display: '氯测定', system: wst886, version: '2026' },
      { code: '2075-0', display: 'Chloride', system: loinc, version: '2.83' },
    ],
    unit: 'mmol/L',
  },
  ckmb: {
    codings: [
      { code: '2100104A', display: '肌酸激酶同工酶测定', system: wst886, version: '2026' },
      { code: '2157-6', display: 'Creatine kinase.MB', system: loinc, version: '2.83' },
    ],
    unit: 'U/L',
  },
  creatinine: {
    codings: [
      { code: '1700404A', display: '肌酐测定', system: wst886, version: '2026' },
      { code: '2160-0', display: '肌酐:质量浓度:时间点:血清/血浆:定量型', system: loinc, version: '2.83' },
      { code: '14682-9', display: 'Creatinine [Moles/volume] in Serum or Plasma', system: loinc, version: '2.83' },
    ],
    unit: 'umol/L',
    unitDisplay: 'μmol/L',
  },
  ctnt: {
    codings: [
      { code: '2100504A', display: '心肌肌钙蛋白T测定', system: wst886, version: '2026' },
      { code: '6597-9', display: 'Troponin T.cardiac', system: loinc, version: '2.83' },
    ],
    unit: 'ng/mL',
  },
  cystatinC: {
    codings: [
      { code: '1101204A', display: '胱抑素C测定', system: wst886, version: '2026' },
      { code: '33863-2', display: 'Cystatin C', system: loinc, version: '2.83' },
    ],
    unit: 'mg/L',
  },
  dDimer: {
    codings: [
      { code: '0501703A', display: 'D-二聚体测定', system: wst886, version: '2026' },
      { code: '48065-7', display: 'Fibrin D-dimer FEU', system: loinc, version: '2.83' },
    ],
    unit: 'mg/L',
  },
  glucose: {
    codings: [{ code: '2339-0', display: '随机血糖', system: loinc, version: '2.83' }],
    unit: 'mmol/L',
  },
  hba1c: {
    codings: [
      { code: '1100301A', display: '糖化血红蛋白测定', system: wst886, version: '2026' },
      { code: '4548-4', display: 'Hemoglobin A1c/Hemoglobin.total in Blood', system: loinc, version: '2.83' },
    ],
    unit: '%',
  },
  hdl: {
    codings: [
      { code: '2000304A', display: '高密度脂蛋白胆固醇测定', system: wst886, version: '2026' },
      { code: '2085-9', display: 'Cholesterol in HDL', system: loinc, version: '2.83' },
    ],
    unit: 'mmol/L',
  },
  hematocrit: {
    codings: [
      { code: '0100501A', display: '红细胞比容', system: wst886, version: '2026' },
      { code: '20570-8', display: 'Hematocrit [Volume Fraction] of Blood by calculation', system: loinc, version: '2.83' },
    ],
    unit: 'L/L',
  },
  hemoglobin: {
    codings: [
      { code: '0100401A', display: '血红蛋白测定', system: wst886, version: '2026' },
      { code: '718-7', display: 'Hemoglobin [Mass/volume] in Blood', system: loinc, version: '2.83' },
    ],
    unit: 'g/L',
  },
  hsCtni: {
    codings: [
      { code: '2100404B', display: '高敏心肌肌钙蛋白I测定', system: wst886, version: '2026' },
      { code: '2100404A', display: '心肌肌钙蛋白I测定', system: wst886, version: '2026' },
      { code: '89579-7', display: 'Troponin I.cardiac [Mass/volume] High Sensitivity', system: loinc, version: '2.83' },
      { code: '10839-9', display: 'Troponin I.cardiac [Mass/volume] in Serum or Plasma', system: loinc, version: '2.83' },
    ],
    unit: 'ng/mL',
  },
  inr: {
    codings: [
      { code: '0500203A', display: '凝血酶原时间国际标准化比值', system: wst886, version: '2026' },
      { code: '6301-6', display: '组织因子诱导型凝血过程.INR:相对时间:时间点:贫血小板血浆:定量型:凝血功能分析', system: loinc, version: '2.83' },
    ],
    unit: '1',
  },
  ldl: {
    codings: [
      { code: '2000404A', display: '低密度脂蛋白胆固醇测定', system: wst886, version: '2026' },
      { code: '2089-1', display: 'Cholesterol in LDL', system: loinc, version: '2.83' },
      { code: '13457-7', display: 'Cholesterol in LDL [Mass/volume] by calculation', system: loinc, version: '2.83' },
    ],
    unit: 'mmol/L',
  },
  magnesium: {
    codings: [
      { code: '1400305A', display: '镁测定', system: wst886, version: '2026' },
      { code: '19123-9', display: 'Magnesium', system: loinc, version: '2.83' },
    ],
    unit: 'mmol/L',
  },
  mch: {
    codings: [
      { code: '0100701A', display: '平均红细胞血红蛋白含量', system: wst886, version: '2026' },
      { code: '785-6', display: 'MCH', system: loinc, version: '2.83' },
    ],
    unit: 'pg',
  },
  mchc: {
    codings: [
      { code: '0100801A', display: '平均红细胞血红蛋白浓度', system: wst886, version: '2026' },
      { code: '786-4', display: 'MCHC', system: loinc, version: '2.83' },
    ],
    unit: 'g/L',
  },
  mcv: {
    codings: [
      { code: '0100601A', display: '平均红细胞体积', system: wst886, version: '2026' },
      { code: '787-2', display: 'MCV [Entitic mean volume] in Red Blood Cells by Automated count', system: loinc, version: '2.83' },
    ],
    unit: 'fL',
  },
  myoglobin: {
    codings: [
      { code: '2100304A', display: '肌红蛋白测定', system: wst886, version: '2026' },
      { code: '2639-3', display: 'Myoglobin', system: loinc, version: '2.83' },
    ],
    unit: 'ng/mL',
  },
  ntProbnp: {
    codings: [
      { code: '2100704A', display: '氨基末端脑利钠肽前体测定', system: wst886, version: '2026' },
      { code: '33762-6', display: 'Natriuretic peptide.B prohormone N-Terminal', system: loinc, version: '2.83' },
    ],
    unit: 'ng/L',
  },
  phosphorus: {
    codings: [
      { code: '1400404A', display: '无机磷测定', system: wst886, version: '2026' },
      { code: '2777-1', display: 'Phosphate', system: loinc, version: '2.83' },
    ],
    unit: 'mmol/L',
  },
  platelets: {
    codings: [
      { code: '0100301A', display: '血小板计数', system: wst886, version: '2026' },
      { code: '777-3', display: 'Platelets [#/volume] in Blood by Automated count', system: loinc, version: '2.83' },
    ],
    unit: '10*9/L',
  },
  potassium: {
    codings: [
      { code: '1400605A', display: '钾测定', system: wst886, version: '2026' },
      { code: '2823-3', display: '钾:物质的量浓度:时间点:血清/血浆:定量型', system: loinc, version: '2.83' },
    ],
    unit: 'mmol/L',
  },
  rbc: {
    codings: [
      { code: '0100201A', display: '红细胞计数', system: wst886, version: '2026' },
      { code: '789-8', display: 'Erythrocytes [#/volume] in Blood by Automated count', system: loinc, version: '2.83' },
    ],
    unit: '10*12/L',
  },
  sodium: {
    codings: [
      { code: '1400205A', display: '钠测定', system: wst886, version: '2026' },
      { code: '2951-2', display: '钠:物质的量浓度:时间点:血清/血浆:定量型', system: loinc, version: '2.83' },
    ],
    unit: 'mmol/L',
  },
  tc: {
    codings: [
      { code: '2000104A', display: '总胆固醇测定', system: wst886, version: '2026' },
      { code: '2093-3', display: 'Cholesterol [Mass/volume] in Serum or Plasma', system: loinc, version: '2.83' },
    ],
    unit: 'mmol/L',
  },
  tg: {
    codings: [
      { code: '2000204A', display: '甘油三酯测定', system: wst886, version: '2026' },
      { code: '2571-8', display: 'Triglyceride', system: loinc, version: '2.83' },
    ],
    unit: 'mmol/L',
  },
  urea: {
    codings: [
      { code: '1700204A', display: '尿素测定', system: wst886, version: '2026' },
      { code: '3094-0', display: 'Urea nitrogen', system: loinc, version: '2.83' },
    ],
    unit: 'mmol/L',
  },
  uricAcid: {
    codings: [
      { code: '1700304A', display: '尿酸测定', system: wst886, version: '2026' },
      { code: '3084-1', display: 'Urate', system: loinc, version: '2.83' },
    ],
    unit: 'umol/L',
    unitDisplay: 'μmol/L',
  },
  wbc: {
    codings: [
      { code: '0100101A', display: '白细胞计数', system: wst886, version: '2026' },
      { code: '6690-2', display: 'Leukocytes [#/volume] in Blood by Automated count', system: loinc, version: '2.83' },
    ],
    unit: '10*9/L',
  },
} as const satisfies Record<string, LabSpec>

type LabKey = keyof typeof labCatalog

function lab(
  key: LabKey,
  value: number,
  options: {
    idSuffix?: string
    interpretation?: 'H' | 'L' | 'N'
    stage?: CaseTruthStage
  } = {},
): AuthoredLabObservation {
  const spec = labCatalog[key]
  const id = options.idSuffix === undefined
    ? options.stage === undefined ? key : `${key}-${options.stage}`
    : `${key}-${options.idSuffix}`
  return {
    codings: [...spec.codings],
    id,
    ...(options.interpretation === undefined ? {} : { interpretation: options.interpretation }),
    ...(options.stage === undefined ? {} : { stage: options.stage }),
    unit: spec.unit,
    ...('unitDisplay' in spec ? { unitDisplay: spec.unitDisplay } : {}),
    value,
  }
}

function baselineLabs(overrides: Partial<Record<LabKey, number>> & { female?: boolean } = {}): AuthoredLabObservation[] {
  const f = overrides.female === true
  const defaults: Record<LabKey, number> = {
    alt: 24,
    apoa1: 1.25,
    apob: 0.95,
    ast: 22,
    bnp: 45,
    calcium: 2.32,
    chloride: 103,
    ckmb: 12,
    creatinine: f ? 68 : 82,
    ctnt: 0.006,
    cystatinC: 0.88,
    dDimer: 0.22,
    glucose: 5.6,
    hba1c: 5.6,
    hdl: f ? 1.32 : 1.15,
    hematocrit: f ? 0.39 : 0.44,
    hemoglobin: f ? 128 : 146,
    hsCtni: 0.008,
    inr: 1.0,
    ldl: 3.1,
    magnesium: 0.88,
    mch: 30.2,
    mchc: 334,
    mcv: 90.5,
    myoglobin: 36,
    ntProbnp: 80,
    phosphorus: 1.12,
    platelets: 225,
    potassium: 4.1,
    rbc: f ? 4.35 : 4.85,
    sodium: 141,
    tc: 5.1,
    tg: 1.45,
    urea: 5.4,
    uricAcid: f ? 290 : 350,
    wbc: 6.4,
  }
  const merged = { ...defaults, ...overrides }
  return (Object.keys(labCatalog) as LabKey[]).map(key => lab(key, merged[key]))
}

export const cardiorenalAuthoredCasePackDefinition: AuthoredCasePackDefinitionInput = {
  id: 'clinmesh-cardiorenal-authored-case-pack',
  name: '心血管与慢病专病合成病例包',
  nameEn: 'Cardiorenal Specialist Synthetic Case Pack',
  version: '2026-11-19.r1',
  cases: [
    // Case ①: 高危胸痛 NSTEMI（门诊首诊 -> 转住院造影单支架 PCI -> 出院后门诊随访）
    {
      id: 'cardio-nstemi-chest-pain-v1',
      title: '病例① 高危非 ST 段抬高型心肌梗死（门诊转住院 PCI 与随访）',
      titleEn: 'Case 1: High-risk NSTEMI (outpatient to inpatient PCI & follow-up)',
      recommendedEntry: 'outpatient',
      plannedStentCount: 1,
      patient: {
        id: 'authored-cardio-nstemi-01',
        name: '陈志远',
        birthDate: '1959-09-15',
        gender: 'male',
      },
      indexDateTime,
      chiefComplaint: '间断胸骨后闷痛 6 小时，伴出汗与轻微气促。',
      indexConditions: [
        {
          id: 'nstemi',
          system: icd10,
          code: 'I21.4',
          display: '急性非ST段抬高型心肌梗死',
          note: '高危 NSTEMI：前壁 ST 段压低伴高敏肌钙蛋白 I 明显升高并动态上升。',
        },
        {
          id: 'cad',
          system: nhsaDiagnosis,
          version: '2022',
          code: 'I25.103',
          display: '冠状动脉粥样硬化性心脏病',
        },
      ],
      visibleHistory: [
        {
          id: 'htn-lipids-2025',
          encounterDateTime: '2025-10-12T09:30:00+08:00',
          reasonText: '外院门诊随访血压与血脂',
          conditions: [
            { id: 'htn', system: icd10, code: 'I10', display: '高血压', note: '病史 8 年，平素口服降压药，血压控制一般。' },
            { id: 'dyslipidemia', system: icd10, code: 'E78.5', display: '血脂异常', note: '既往低密度脂蛋白胆固醇偏高，未规律服用降脂药。' },
          ],
          observations: [
            lab('creatinine', 102, { idSuffix: 'hist-2025' }),
            lab('ldl', 3.52, { idSuffix: 'hist-2025' }),
          ],
          medications: [
            { id: 'amlodipine', code: 'CM-DRUG-AMLODIPINE-5MG-ORAL-TABLET', display: '苯磺酸氨氯地平片', dosageText: '5 mg 每日一次 口服' },
          ],
        },
      ],
      laboratories: [
        ...baselineLabs({
          alt: 28,
          ast: 46,
          bnp: 165,
          ckmb: 38,
          creatinine: 118,
          ctnt: 0.24,
          cystatinC: 1.24,
          dDimer: 0.32,
          glucose: 6.4,
          hba1c: 5.9,
          hdl: 1.05,
          hemoglobin: 142,
          hsCtni: 0.68,
          inr: 1.02,
          ldl: 3.6,
          myoglobin: 110,
          ntProbnp: 420,
          platelets: 232,
          potassium: 4.15,
          sodium: 140,
          tc: 5.85,
          tg: 1.95,
          urea: 7.4,
          uricAcid: 398,
          wbc: 8.6,
        }).filter(item => !['hsCtni', 'ctnt', 'ckmb', 'myoglobin'].includes(item.id)),
        lab('hsCtni', 0.68, { interpretation: 'H', stage: 'initial' }),
        lab('hsCtni', 1.45, { interpretation: 'H', stage: 'repeat' }),
        lab('hsCtni', 0.012, { interpretation: 'N', stage: 'follow-up' }),
        lab('ctnt', 0.24, { interpretation: 'H', stage: 'initial' }),
        lab('ctnt', 0.42, { interpretation: 'H', stage: 'repeat' }),
        lab('ctnt', 0.008, { interpretation: 'N', stage: 'follow-up' }),
        lab('ckmb', 38, { interpretation: 'H', stage: 'initial' }),
        lab('ckmb', 14, { interpretation: 'N', stage: 'follow-up' }),
        lab('myoglobin', 110, { interpretation: 'H', stage: 'initial' }),
        lab('myoglobin', 42, { interpretation: 'N', stage: 'follow-up' }),
        lab('ldl', 1.25, { interpretation: 'N', stage: 'follow-up' }),
        lab('tc', 3.1, { interpretation: 'N', stage: 'follow-up' }),
        lab('tg', 1.35, { interpretation: 'N', stage: 'follow-up' }),
        lab('hdl', 1.15, { interpretation: 'N', stage: 'follow-up' }),
        lab('creatinine', 112, { interpretation: 'H', stage: 'follow-up' }),
      ],
      ecgs: [
        {
          stage: 'initial',
          rhythm: '窦性心律',
          ventricularRateBpm: 96,
          prIntervalMs: 164,
          qrsDurationMs: 92,
          qtcIntervalMs: 428,
          stTAnterior: 'V2-V5 导联 ST 段水平型压低 0.15-0.20 mV，伴 T 波倒置',
          stTInferior: '未见明显异常',
          stTLateral: '未见明显异常',
          conclusion: '窦性心律，前壁导联 V2-V5 ST段压低伴 T 波倒置，提示前壁心肌缺血，未见 ST 段抬高。',
        },
        {
          stage: 'follow-up',
          rhythm: '窦性心律',
          ventricularRateBpm: 68,
          prIntervalMs: 162,
          qrsDurationMs: 90,
          qtcIntervalMs: 416,
          stTAnterior: 'V2-V5 导联 ST 段回落至等电位线，T 波浅倒置较前明显改善',
          stTInferior: '未见明显异常',
          stTLateral: '未见明显异常',
          conclusion: '窦性心律，前壁导联 ST 段较前明显回落，复查心电图趋于稳定。',
        },
      ],
      ttes: [
        {
          lvefPercent: 52,
          lveddMm: 51,
          regionalWallMotion: '左室前壁中远段运动轻度减弱',
          valves: '二尖瓣少量反流',
          diastolicFunction: '左室舒张功能 I 级减低',
          conclusion: '左室前壁中远段运动轻度减弱，LVEF 52%，二尖瓣少量反流。',
        },
      ],
      angiography: {
        vessels: [
          { vessel: 'LM', segment: '左主干', stenosisPercent: 0, timiFlow: 3, lesionCharacteristics: '管壁光滑，未见明显狭窄' },
          { vessel: 'LAD', segment: 'LAD 近段', stenosisPercent: 90, timiFlow: 2, lesionCharacteristics: '偏心性重度狭窄，边缘欠光滑伴轻度充盈缺损' },
          { vessel: 'LCX', segment: 'LCX 中段', stenosisPercent: 35, timiFlow: 3, lesionCharacteristics: '局限性轻度管壁不规则' },
          { vessel: 'RCA', segment: 'RCA 中段', stenosisPercent: 40, timiFlow: 3, lesionCharacteristics: '局限性轻中度斑块，血流通畅' },
        ],
        conclusion: '前降支近段 90% 重度偏心狭窄伴 TIMI 2 级血流，符合罪犯病变表现，具备经皮冠脉介入治疗指征。',
        qca: {
          targetSite: 'LAD 近段',
          lesionLengthMm: 15,
          proximalReferenceDiameterMm: 3.0,
          distalReferenceDiameterMm: 3.0,
        },
      },
      persona: {
        version: 'cardio-nstemi-chest-pain-persona-v1',
        content: {
          chiefComplaint: '今天早上开始胸口闷痛阵阵发作，已有六个小时，有时还出虚汗。',
          openingStatement: '医生您好，我今天凌晨起胸口一阵阵发闷、发紧，刚才走来医院又有点冒汗。',
          knownHistorySummary: '高血压八年、血脂异常几年，没有已知药物过敏，平时偶尔忘吃降脂药。',
          symptomExperience: '胸骨后压榨样闷痛每次持续十来分钟，向左肩背隐约放射，休息后稍微减轻但反复发作，没有晕倒或咳血。',
          medicationMemory: '每天早上吃一片氨氯地平，近期没吃阿司匹林或止痛药。',
          persona: { character: '略焦虑但配合', speechStyle: '条理清晰', healthLiteracy: '普通', attitude: '希望尽快查明原因并配合诊治' },
        },
      },
    },

    // Case ②: 择期 LAD 重度狭窄单支架 PCI（直接住院 -> 造影 FFR 0.72 -> PCI -> 出院随访）
    {
      id: 'cardio-elective-lad-pci-v1',
      title: '病例② 择期前降支重度狭窄 PCI（直接住院与随访）',
      titleEn: 'Case 2: Elective severe LAD stenosis PCI (direct inpatient & follow-up)',
      recommendedEntry: 'inpatient',
      plannedStentCount: 1,
      patient: {
        id: 'authored-cardio-elective-lad-02',
        name: '林建国',
        birthDate: '1964-06-22',
        gender: 'male',
      },
      indexDateTime,
      chiefComplaint: '劳力后胸骨后压迫感 4 个月，近 2 周爬楼 2 层即诱发。',
      indexConditions: [
        {
          id: 'cad',
          system: nhsaDiagnosis,
          version: '2022',
          code: 'I25.103',
          display: '冠状动脉粥样硬化性心脏病',
          note: '择期评估前降支中段重度狭窄，静息心肌标志物正常。',
        },
      ],
      visibleHistory: [
        {
          id: 'htn-lipids-2026',
          encounterDateTime: '2026-02-10T10:00:00+08:00',
          reasonText: '外院体检及慢病复诊',
          conditions: [
            { id: 'htn', system: icd10, code: 'I10', display: '高血压', note: '规律服药，血压约 132/80 mmHg。' },
            { id: 'dyslipidemia', system: icd10, code: 'E78.5', display: '血脂异常' },
          ],
          observations: [
            lab('creatinine', 80, { idSuffix: 'hist-2026' }),
            lab('ldl', 3.3, { idSuffix: 'hist-2026' }),
          ],
          medications: [
            { id: 'amlodipine', code: 'CM-DRUG-AMLODIPINE-5MG-ORAL-TABLET', display: '苯磺酸氨氯地平片', dosageText: '5 mg 每日一次 口服' },
          ],
        },
      ],
      laboratories: [
        ...baselineLabs({
          creatinine: 82,
          dDimer: 0.22,
          hba1c: 5.7,
          hdl: 1.12,
          hemoglobin: 148,
          hsCtni: 0.01,
          inr: 1.0,
          ldl: 3.25,
          ntProbnp: 85,
          platelets: 218,
          potassium: 4.2,
          sodium: 141,
          tc: 5.4,
          tg: 1.55,
          wbc: 6.3,
        }),
        lab('ldl', 1.32, { interpretation: 'N', stage: 'follow-up' }),
        lab('tc', 3.15, { interpretation: 'N', stage: 'follow-up' }),
        lab('creatinine', 84, { interpretation: 'N', stage: 'follow-up' }),
      ],
      ecgs: [
        {
          rhythm: '窦性心律',
          ventricularRateBpm: 70,
          prIntervalMs: 158,
          qrsDurationMs: 88,
          qtcIntervalMs: 408,
          stTAnterior: '未见明显异常',
          stTInferior: '未见明显异常',
          stTLateral: '未见明显异常',
          conclusion: '窦性心律，未见明显 ST-T 异常。',
        },
      ],
      ttes: [
        {
          lvefPercent: 60,
          lveddMm: 48,
          regionalWallMotion: '未见节段性室壁运动异常',
          valves: '瓣膜结构及启闭未见明显异常',
          diastolicFunction: '左室舒张功能未见明显异常',
          conclusion: '心脏各房室大小正常，未见节段性室壁运动异常，LVEF 60%。',
        },
      ],
      angiography: {
        vessels: [
          { vessel: 'LM', segment: '左主干', stenosisPercent: 0, timiFlow: 3, lesionCharacteristics: '管壁光滑，未见明显狭窄' },
          { vessel: 'LAD', segment: 'LAD 中段', stenosisPercent: 85, timiFlow: 3, lesionCharacteristics: '局限性重度同心狭窄，边界较清', ffr: 0.72 },
          { vessel: 'LCX', segment: 'LCX 中段', stenosisPercent: 20, timiFlow: 3, lesionCharacteristics: '轻度管壁不规则' },
          { vessel: 'RCA', segment: 'RCA 中段', stenosisPercent: 25, timiFlow: 3, lesionCharacteristics: '轻度管壁不规则' },
        ],
        conclusion: '前降支中段 85% 重度局限性狭窄，FFR 0.72 提示明确心肌缺血，具备择期单支架 PCI 指征。',
        qca: {
          targetSite: 'LAD 中段',
          lesionLengthMm: 12,
          proximalReferenceDiameterMm: 3.0,
          distalReferenceDiameterMm: 3.0,
        },
      },
      persona: {
        version: 'cardio-elective-lad-pci-persona-v1',
        content: {
          chiefComplaint: '活动后胸口发闷四个月，最近两周爬两层楼就胸口发紧，歇几分钟能缓解。',
          openingStatement: '医生您好，我这几个月一快走或者爬楼梯胸口就发紧，歇一会儿就好，想住院把原因查清楚。',
          knownHistorySummary: '高血压和血脂异常几年，无已知药物过敏，平时休息时不痛。',
          symptomExperience: '每次上两层楼或快走三百米胸口就发沉发紧，停下来休息三五分钟完全缓解，夜间能平卧。',
          medicationMemory: '规律口服氨氯地平每日一片，未自行加服其他药物。',
          persona: { character: '沉稳', speechStyle: '简明直接', healthLiteracy: '中等', attitude: '愿意配合住院检查和后续安排' },
        },
      },
    },

    // Case ③: 临界狭窄 FFR 阴性保守 GDMT（女性，直接住院 -> 造影 FFR 0.86 -> 避免过度 PCI）
    {
      id: 'cardio-borderline-ffr-gdmt-v1',
      title: '病例③ 临界病变 FFR 阴性药物优化管理（女性直接住院与随访）',
      titleEn: 'Case 3: Borderline LAD stenosis FFR-negative GDMT (female inpatient & follow-up)',
      recommendedEntry: 'inpatient',
      plannedStentCount: 0,
      patient: {
        id: 'authored-cardio-borderline-ffr-03',
        name: '周秀兰',
        birthDate: '1966-11-05',
        gender: 'female',
      },
      indexDateTime,
      chiefComplaint: '间断活动后轻微胸闷 2 个月，拟入院评估心脏及血管情况。',
      indexConditions: [
        {
          id: 'cad',
          system: nhsaDiagnosis,
          version: '2022',
          code: 'I25.103',
          display: '冠状动脉粥样硬化性心脏病',
          note: '临界病变 FFR 0.86 阴性，无血运重建指征，推荐优化药物治疗（GDMT）。',
        },
      ],
      visibleHistory: [
        {
          id: 'htn-lipids-2026',
          encounterDateTime: '2026-03-08T09:00:00+08:00',
          reasonText: '社区慢病随访',
          conditions: [
            { id: 'htn', system: icd10, code: 'I10', display: '高血压' },
            { id: 'dyslipidemia', system: icd10, code: 'E78.5', display: '血脂异常' },
          ],
          observations: [
            lab('creatinine', 70, { idSuffix: 'hist-2026' }),
            lab('ldl', 3.12, { idSuffix: 'hist-2026' }),
          ],
          medications: [
            { id: 'amlodipine', code: 'CM-DRUG-AMLODIPINE-5MG-ORAL-TABLET', display: '苯磺酸氨氯地平片', dosageText: '5 mg 每日一次 口服' },
          ],
        },
      ],
      laboratories: [
        ...baselineLabs({
          creatinine: 72,
          dDimer: 0.2,
          female: true,
          hba1c: 5.6,
          hdl: 1.34,
          hemoglobin: 128,
          hsCtni: 0.008,
          inr: 0.98,
          ldl: 3.05,
          ntProbnp: 78,
          platelets: 230,
          potassium: 4.05,
          sodium: 140,
          tc: 5.15,
          tg: 1.4,
          wbc: 5.9,
        }),
        lab('ldl', 1.35, { interpretation: 'N', stage: 'follow-up' }),
        lab('tc', 3.2, { interpretation: 'N', stage: 'follow-up' }),
        lab('creatinine', 74, { interpretation: 'N', stage: 'follow-up' }),
      ],
      ecgs: [
        {
          rhythm: '窦性心律',
          ventricularRateBpm: 72,
          prIntervalMs: 156,
          qrsDurationMs: 86,
          qtcIntervalMs: 412,
          stTAnterior: '未见明显异常',
          stTInferior: '未见明显异常',
          stTLateral: '未见明显异常',
          conclusion: '窦性心律，未见明显 ST-T 异常。',
        },
      ],
      ttes: [
        {
          lvefPercent: 62,
          lveddMm: 46,
          regionalWallMotion: '未见节段性室壁运动异常',
          valves: '瓣膜结构及启闭未见明显异常',
          diastolicFunction: '左室舒张功能未见明显异常',
          conclusion: '心内结构及左室收缩、舒张功能未见明显异常，LVEF 62%。',
        },
      ],
      angiography: {
        vessels: [
          { vessel: 'LM', segment: '左主干', stenosisPercent: 0, timiFlow: 3, lesionCharacteristics: '管壁光滑，未见明显狭窄' },
          { vessel: 'LAD', segment: 'LAD 中段', stenosisPercent: 60, timiFlow: 3, lesionCharacteristics: '局限性中度临界狭窄，斑块形态规整', ffr: 0.86 },
          { vessel: 'LCX', segment: 'LCX 中段', stenosisPercent: 25, timiFlow: 3, lesionCharacteristics: '轻度管壁不规则' },
          { vessel: 'RCA', segment: 'RCA 中段', stenosisPercent: 30, timiFlow: 3, lesionCharacteristics: '轻度管壁不规则' },
        ],
        conclusion: '前降支中段 60% 临界狭窄，FFR 0.86 为功能学阴性（非缺血病变），暂无需介入支架植入，建议规范指南导向药物治疗（GDMT）及随访。',
      },
      persona: {
        version: 'cardio-borderline-ffr-gdmt-persona-v1',
        content: {
          chiefComplaint: '最近两个月干家务或快走时偶尔觉得胸口发闷，休息很快缓解。',
          openingStatement: '医生您好，我最近走路快了偶尔胸口发闷，想检查清楚看看要不要做进一步处理。',
          knownHistorySummary: '既往有高血压和血脂异常，无药物过敏史，平时生活能够完全自理。',
          symptomExperience: '偶尔提重物或快走十来分钟胸口微微发闷，坐下歇两三分钟就好，没有大汗、心慌或夜间憋醒。',
          medicationMemory: '每天按时吃氨氯地平一片，没吃过其他心脏药物。',
          persona: { character: '细致谨慎', speechStyle: '温和清楚', healthLiteracy: '中等', attitude: '关注是否必须放支架，愿意听从规范评估' },
        },
      },
    },

    // Case ④: 冠心病合并 CKD 3b 期水化保护与 PCI（68 岁男，Scr 175 -> eGFR 36.1 G3b，术后复查 168，随访 170）
    {
      id: 'cardio-cad-ckd3b-hydration-pci-v1',
      title: '病例④ 冠心病合并 CKD 3b 期围术期水化与 PCI（住院与随访）',
      titleEn: 'Case 4: CAD with CKD 3b perioperative hydration & PCI (inpatient & follow-up)',
      recommendedEntry: 'inpatient',
      plannedStentCount: 1,
      patient: {
        id: 'authored-cardio-cad-ckd3b-04',
        name: '赵德明',
        birthDate: '1958-05-10',
        gender: 'male',
      },
      indexDateTime,
      chiefComplaint: '活动后胸闷气短 3 个月，加重 1 周，既往肾功能减退史。',
      indexConditions: [
        {
          id: 'cad',
          system: nhsaDiagnosis,
          version: '2022',
          code: 'I25.103',
          display: '冠状动脉粥样硬化性心脏病',
        },
        {
          id: 'ckd3b',
          system: icd10,
          code: 'N18.3',
          display: '慢性肾脏病3期',
          note: 'CKD 3b 期（基线 Scr 175 μmol/L，eGFR 36.1 mL/min/1.73m²），介入前需等渗盐水围术期水化并限制对比剂用量。',
        },
      ],
      visibleHistory: [
        {
          id: 'ckd3b-htn-2026',
          encounterDateTime: '2026-01-15T09:00:00+08:00',
          reasonText: '外院肾内科及高血压慢病随访（>90 天慢性肾脏病证据）',
          conditions: [
            { id: 'ckd3', system: icd10, code: 'N18.3', display: '慢性肾脏病3期', note: '既往多次复查血肌酐 170-180 μmol/L，病程超过 2 年。' },
            { id: 'htn', system: icd10, code: 'I10', display: '高血压' },
            { id: 'dyslipidemia', system: icd10, code: 'E78.5', display: '血脂异常' },
          ],
          observations: [
            lab('creatinine', 172, { idSuffix: 'hist-202601' }),
            lab('potassium', 4.4, { idSuffix: 'hist-202601' }),
          ],
          medications: [
            { id: 'amlodipine', code: 'CM-DRUG-AMLODIPINE-5MG-ORAL-TABLET', display: '苯磺酸氨氯地平片', dosageText: '5 mg 每日一次 口服' },
          ],
        },
      ],
      laboratories: [
        ...baselineLabs({
          creatinine: 175,
          cystatinC: 1.82,
          dDimer: 0.28,
          hba1c: 5.8,
          hdl: 1.08,
          hemoglobin: 126,
          hsCtni: 0.015,
          inr: 1.02,
          ldl: 3.18,
          ntProbnp: 145,
          platelets: 205,
          potassium: 4.5,
          sodium: 140,
          tc: 5.3,
          tg: 1.65,
          urea: 10.6,
          uricAcid: 445,
          wbc: 6.7,
        }),
        lab('creatinine', 168, { interpretation: 'H', stage: 'repeat' }),
        lab('urea', 9.8, { interpretation: 'H', stage: 'repeat' }),
        lab('potassium', 4.4, { interpretation: 'N', stage: 'repeat' }),
        lab('creatinine', 170, { interpretation: 'H', stage: 'follow-up' }),
        lab('ldl', 1.3, { interpretation: 'N', stage: 'follow-up' }),
        lab('tc', 3.12, { interpretation: 'N', stage: 'follow-up' }),
      ],
      ecgs: [
        {
          rhythm: '窦性心律',
          ventricularRateBpm: 74,
          prIntervalMs: 164,
          qrsDurationMs: 92,
          qtcIntervalMs: 418,
          stTAnterior: '未见明显异常',
          stTInferior: '未见明显异常',
          stTLateral: '未见明显异常',
          conclusion: '窦性心律，未见明显 ST-T 异常。',
        },
      ],
      ttes: [
        {
          lvefPercent: 56,
          lveddMm: 49,
          regionalWallMotion: '未见节段性室壁运动异常',
          valves: '主动脉瓣轻度钙化，未见明显反流或狭窄',
          diastolicFunction: '左室舒张功能 I 级减低',
          conclusion: '左室收缩功能保留（LVEF 56%），无心力衰竭表现，围术期水化耐受性可。',
        },
      ],
      angiography: {
        vessels: [
          { vessel: 'LM', segment: '左主干', stenosisPercent: 0, timiFlow: 3, lesionCharacteristics: '管壁轻度不规则，未见明显狭窄' },
          { vessel: 'LAD', segment: 'LAD 中段', stenosisPercent: 85, timiFlow: 3, lesionCharacteristics: '局限性重度偏心狭窄伴轻度钙化', ffr: 0.74 },
          { vessel: 'LCX', segment: 'LCX 中段', stenosisPercent: 30, timiFlow: 3, lesionCharacteristics: '轻度管壁不规则' },
          { vessel: 'RCA', segment: 'RCA 中段', stenosisPercent: 35, timiFlow: 3, lesionCharacteristics: '轻度斑块，血流正常' },
        ],
        conclusion: '前降支中段 85% 重度狭窄，FFR 0.74 证实缺血，合并 CKD 3b 期需在等渗盐水充分水化与低对比剂策略下行单支架 PCI。',
        qca: {
          targetSite: 'LAD 中段',
          lesionLengthMm: 14,
          proximalReferenceDiameterMm: 3.0,
          distalReferenceDiameterMm: 3.0,
        },
      },
      persona: {
        version: 'cardio-cad-ckd3b-hydration-pci-persona-v1',
        content: {
          chiefComplaint: '走路或上楼时胸口发闷三个月，最近一周走两百米就气短发紧。',
          openingStatement: '医生您好，我最近一走路胸口就发闷气短，我肾功能本来就不太好，想住院安全查一下。',
          knownHistorySummary: '已知慢性肾脏病3期两年多、高血压和血脂异常，无药物过敏，平时尿量正常、没有明显脚肿。',
          symptomExperience: '平时步行两百米左右胸口发紧气短，停下休息几分钟能缓解，夜间能平躺，没有少尿或明显浮肿。',
          medicationMemory: '规律口服氨氯地平每日一片，近期未自行服用止痛药或中草药。',
          persona: { character: '踏实谨慎', speechStyle: '语速平稳', healthLiteracy: '中等', attitude: '特别关心检查用药会不会伤肾，愿意配合保护措施' },
        },
      },
    },

    // Case ⑤: 门诊 2 型糖尿病 + 高血压 + CKD 4 期（64 岁女，Scr 184.6 -> eGFR 26.0 G4，红线拦截二甲双胍/达格列净）
    {
      id: 'renal-t2dm-htn-ckd4-control-v1',
      title: '病例⑤ 2 型糖尿病合并高血压与 CKD 4 期慢病门诊调控（女性）',
      titleEn: 'Case 5: Outpatient T2DM, hypertension & CKD stage 4 control (female)',
      recommendedEntry: 'outpatient',
      plannedStentCount: 0,
      patient: {
        id: 'authored-renal-t2dm-ckd4-05',
        name: '王淑芬',
        birthDate: '1962-03-18',
        gender: 'female',
      },
      indexDateTime,
      chiefComplaint: '近期自测空腹及餐后血糖偏高 1 个月，复诊调整降糖及降压方案。',
      indexConditions: [
        {
          id: 't2dm-hyperglycemia',
          system: icd10,
          code: 'E11.65',
          display: '2型糖尿病伴高血糖',
          note: 'HbA1c 8.2%，合并 CKD 4 期（eGFR 26.0 mL/min/1.73m²），禁用二甲双胍及达格列净。',
        },
        {
          id: 'htn',
          system: icd10,
          code: 'I10',
          display: '高血压',
        },
        {
          id: 'ckd4',
          system: icd10,
          code: 'N18.4',
          display: '慢性肾脏病4期',
        },
        {
          id: 'dyslipidemia',
          system: icd10,
          code: 'E78.5',
          display: '血脂异常',
        },
      ],
      visibleHistory: [
        {
          id: 't2dm-htn-ckd4-2025',
          encounterDateTime: '2025-11-20T09:00:00+08:00',
          reasonText: '外院慢病联合随访（>90 天慢性肾脏病 4 期证据）',
          conditions: [
            { id: 't2dm', system: icd10, code: 'E11.9', display: '2型糖尿病', note: '病史 12 年。' },
            { id: 'htn', system: icd10, code: 'I10', display: '高血压', note: '病史 10 年。' },
            { id: 'ckd4', system: icd10, code: 'N18.4', display: '慢性肾脏病4期', note: '近一年肾功能持续重度减退。' },
          ],
          observations: [
            lab('creatinine', 178, { idSuffix: 'hist-202511' }),
            lab('hba1c', 7.9, { idSuffix: 'hist-202511' }),
            lab('potassium', 4.7, { idSuffix: 'hist-202511' }),
          ],
          medications: [
            { id: 'amlodipine', code: 'CM-DRUG-AMLODIPINE-5MG-ORAL-TABLET', display: '苯磺酸氨氯地平片', dosageText: '5 mg 每日一次 口服' },
          ],
        },
      ],
      laboratories: baselineLabs({
        creatinine: 184.6,
        cystatinC: 2.35,
        dDimer: 0.24,
        female: true,
        glucose: 10.6,
        hba1c: 8.2,
        hdl: 1.18,
        hemoglobin: 112,
        hsCtni: 0.011,
        inr: 1.0,
        ldl: 3.1,
        ntProbnp: 115,
        platelets: 215,
        potassium: 4.8,
        sodium: 140,
        tc: 5.35,
        tg: 1.85,
        urea: 13.8,
        uricAcid: 410,
        wbc: 6.2,
      }),
      ecgs: [
        {
          rhythm: '窦性心律',
          ventricularRateBpm: 76,
          prIntervalMs: 160,
          qrsDurationMs: 88,
          qtcIntervalMs: 416,
          stTAnterior: '未见明显异常',
          stTInferior: '未见明显异常',
          stTLateral: '未见明显异常',
          conclusion: '窦性心律，未见明显 ST-T 异常。',
        },
      ],
      ttes: [
        {
          lvefPercent: 61,
          lveddMm: 47,
          regionalWallMotion: '未见节段性室壁运动异常',
          valves: '瓣膜结构及启闭未见明显异常',
          diastolicFunction: '左室舒张功能 I 级减低',
          conclusion: '左室收缩功能正常（LVEF 61%），左室舒张功能轻度减低。',
        },
      ],
      persona: {
        version: 'renal-t2dm-htn-ckd4-control-persona-v1',
        content: {
          chiefComplaint: '最近一个月在家测血糖比以前高，想复查指标并请医生帮忙调整方案。',
          openingStatement: '医生您好，我最近在家扎手指测空腹血糖老是偏高，想来查一下化验并调整一下平时吃的药。',
          knownHistorySummary: '已知2型糖尿病十二年、高血压十年、慢性肾脏病4期一年多，没有已知药物过敏。',
          symptomExperience: '平时偶有口干和轻度乏力，没有胸痛、呼吸困难、恶心呕吐或明显水肿。',
          medicationMemory: '每天规律口服氨氯地平一片，之前在外面停掉了伤肾的降糖药，目前还没重新定好降糖方案。',
          persona: { character: '认真细心', speechStyle: '叙述清楚', healthLiteracy: '较高', attitude: '重视肾功能安全，配合规律化验和调药' },
        },
      },
    },
  ],
}

export const compiledCardiorenalAuthoredCasePack = compileAuthoredCasePack(cardiorenalAuthoredCasePackDefinition)
