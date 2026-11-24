import {
  compileAuthoredCasePack,
  type AuthoredCasePackDefinitionInput,
  type AuthoredLabObservation,
  type CompiledAuthoredCase,
} from './authored-case-pack-compiler.ts'
import { compiledCardiorenalAuthoredCasePack } from './cardiorenal-authored-case-pack.ts'
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

export const dsapExtraGoldenCasePackDefinition: AuthoredCasePackDefinitionInput = {
  id: 'clinmesh-dsap-golden-extra-case-pack',
  name: 'DSAP 专病评估补充黄金病例包',
  nameEn: 'DSAP Extended Frozen Golden Case Pack',
  version: '2026-11-24.r1',
  cases: [
    {
      id: 'trap-low-risk-chest-wall-pain-v1',
      title: '黄金病例⑥ 低危胸壁压痛（按压可诱发与 PERC 阴性）',
      titleEn: 'Golden Case 6: Low-risk chest wall pain (reproducible tenderness & PERC negative)',
      recommendedEntry: 'outpatient',
      plannedStentCount: 0,
      patient: {
        id: 'authored-dsap-chest-wall-06',
        name: '林若安',
        birthDate: '1992-05-14',
        gender: 'female',
      },
      indexDateTime,
      chiefComplaint: '左侧前胸壁局限性隐痛 2 天，按压及转身时加重。',
      indexConditions: [
        {
          id: 'chest-wall-pain',
          system: icd10,
          code: 'R07.3',
          display: '胸壁疼痛',
          note: '低危非心源性表现：局部按压可诱发疼痛，12 导联心电图正常，PERC 阴性，首复次 hs-cTnI 与 D-二聚体阴性；未预置 TSH 与 TTE。',
        },
      ],
      visibleHistory: [],
      laboratories: [
        ...baselineLabs({
          female: true,
          bnp: 28,
          ckmb: 10,
          creatinine: 62,
          ctnt: 0.004,
          dDimer: 0.18,
          hsCtni: 0.004,
          ldl: 2.35,
          myoglobin: 26,
          ntProbnp: 42,
          tc: 4.15,
          tg: 1.05,
        }).filter(item => !['hsCtni', 'ctnt'].includes(item.id)),
        lab('hsCtni', 0.004, { interpretation: 'N', stage: 'initial' }),
        lab('hsCtni', 0.005, { interpretation: 'N', stage: 'repeat' }),
        lab('ctnt', 0.004, { interpretation: 'N', stage: 'initial' }),
        lab('ctnt', 0.004, { interpretation: 'N', stage: 'repeat' }),
      ],
      ecgs: [
        {
          stage: 'initial',
          rhythm: '窦性心律',
          ventricularRateBpm: 72,
          prIntervalMs: 152,
          qrsDurationMs: 86,
          qtcIntervalMs: 408,
          stTAnterior: '未见 ST 段偏移及 T 波异常',
          stTInferior: '未见 ST 段偏移及 T 波异常',
          stTLateral: '未见 ST 段偏移及 T 波异常',
          conclusion: '窦性心律，心电图未见明显 ST-T 缺血性改变。',
        },
      ],
      ttes: [],
      persona: {
        version: 'dsap-low-risk-chest-wall-persona-v1',
        content: {
          chiefComplaint: '这两天左边肋骨靠前这一小块地方隐隐作痛，一按压或者转身的时候更痛。',
          openingStatement: '医生您好，我前天起左边胸口靠下那一块肋骨按着有点痛，深吸气或抬手也会牵着痛一下。',
          knownHistorySummary: '既往身体健康，没有长期慢性病，没有已知药物过敏，未服用雌激素类药物，近期无手术外伤史，也无单侧下肢肿痛。',
          symptomExperience: '痛点很固定，用手指能指出来，按上去压痛明显，没有憋气、大汗、咳血或向肩背放散的感觉。',
          medicationMemory: '目前没有日常用药，这两天也没吃止痛药。',
          persona: { character: '冷静配合', speechStyle: '表达具体明确', healthLiteracy: '较好', attitude: '希望确认是否仅需对症观察' },
        },
      },
    },
    {
      id: 'fh-premature-cad-clue-v1',
      title: '黄金病例⑦ 早发冠心病伴家族性高胆固醇血症线索',
      titleEn: 'Golden Case 7: Premature CAD with familial hypercholesterolemia clues',
      recommendedEntry: 'outpatient',
      plannedStentCount: 0,
      patient: {
        id: 'authored-dsap-fh-07',
        name: '周明远',
        birthDate: '1988-03-18',
        gender: 'male',
      },
      indexDateTime,
      chiefComplaint: '快走及上坡时胸骨后紧缩感 3 周，多年外院血脂显著升高。',
      indexConditions: [
        {
          id: 'premature-cad',
          system: nhsaDiagnosis,
          version: '2022',
          code: 'I25.103',
          display: '冠状动脉粥样硬化性心脏病',
          note: '38 岁男性早发冠心病，多年度 LDL-C 持续显著升高并伴一级亲属早发心肌梗死家族史。',
        },
        {
          id: 'fh-hyperchol',
          system: icd10,
          code: 'E78.01',
          display: '家族性高胆固醇血症',
          note: '2023 年 LDL-C 5.50 mmol/L、2025 年 LDL-C 5.80 mmol/L、本次 LDL-C 6.10 mmol/L，伴父亲 46 岁早发冠心病家族史。',
        },
      ],
      visibleHistory: [
        {
          id: 'lipid-check-2023',
          encounterDateTime: '2023-09-12T09:00:00+08:00',
          reasonText: '外院年度体检血脂异常评估',
          conditions: [
            { id: 'dyslipidemia-2023', system: icd10, code: 'E78.5', display: '血脂异常', note: '未经降脂药物干预时 LDL-C 显著升高至 5.50 mmol/L。' },
          ],
          observations: [
            lab('ldl', 5.5, { idSuffix: 'hist-2023', interpretation: 'H' }),
            lab('tc', 7.65, { idSuffix: 'hist-2023', interpretation: 'H' }),
            lab('apob', 1.58, { idSuffix: 'hist-2023', interpretation: 'H' }),
            lab('creatinine', 76, { idSuffix: 'hist-2023', interpretation: 'N' }),
          ],
          medications: [],
        },
        {
          id: 'lipid-followup-2025',
          encounterDateTime: '2025-07-18T09:30:00+08:00',
          reasonText: '外院复查血脂及家族早发心血管病史登记',
          conditions: [
            { id: 'dyslipidemia-2025', system: icd10, code: 'E78.5', display: '血脂异常', note: '复查 LDL-C 仍达 5.80 mmol/L，嘱进一步评估遗传性高胆固醇。' },
            { id: 'fhx-cad-2025', system: icd10, code: 'Z82.4', display: '缺血性心脏病及其他循环系统疾病家族史', note: '父亲 46 岁发生急性心肌梗死并接受支架植入。' },
          ],
          observations: [
            lab('ldl', 5.8, { idSuffix: 'hist-2025', interpretation: 'H' }),
            lab('tc', 7.98, { idSuffix: 'hist-2025', interpretation: 'H' }),
            lab('apob', 1.66, { idSuffix: 'hist-2025', interpretation: 'H' }),
            lab('hdl', 1.06, { idSuffix: 'hist-2025', interpretation: 'N' }),
            lab('tg', 1.52, { idSuffix: 'hist-2025', interpretation: 'N' }),
            lab('creatinine', 78, { idSuffix: 'hist-2025', interpretation: 'N' }),
          ],
          medications: [
            { id: 'atorvastatin', code: 'CM-DRUG-ATORVASTATIN-20MG-ORAL-TABLET', display: '阿托伐他汀钙片', dosageText: '20 mg 每晚一次 口服（间断停药半年）' },
          ],
        },
      ],
      laboratories: [
        ...baselineLabs({
          apob: 1.78,
          creatinine: 80,
          ctnt: 0.006,
          dDimer: 0.21,
          hdl: 1.08,
          hsCtni: 0.009,
          ldl: 6.1,
          tc: 8.32,
          tg: 1.62,
        }).filter(item => !['hsCtni', 'ldl'].includes(item.id)),
        lab('hsCtni', 0.009, { interpretation: 'N', stage: 'initial' }),
        lab('ldl', 6.1, { interpretation: 'H', stage: 'initial' }),
        lab('ldl', 2.4, { interpretation: 'H', stage: 'follow-up' }),
      ],
      ecgs: [
        {
          stage: 'initial',
          rhythm: '窦性心律',
          ventricularRateBpm: 78,
          prIntervalMs: 158,
          qrsDurationMs: 90,
          qtcIntervalMs: 416,
          stTAnterior: '未见明显 ST 段偏移',
          stTInferior: '下壁导联 T 波略低平',
          stTLateral: '未见明显异常',
          conclusion: '窦性心律，下壁导联 T 波轻度低平，未见急性 ST 段抬高或典型压低。',
        },
      ],
      ttes: [
        {
          lvefPercent: 60,
          lveddMm: 48,
          regionalWallMotion: '静息状态下左室各壁运动正常',
          valves: '各瓣膜启闭正常，未见明显反流',
          diastolicFunction: '左室舒张功能正常',
          conclusion: '心脏结构及静息收缩功能正常（LVEF 60%）。',
        },
      ],
      persona: {
        version: 'dsap-fh-premature-cad-persona-v1',
        content: {
          chiefComplaint: '最近三周走快一点或者上坡时胸口中间会发紧发闷，停下来几分钟能缓过来。',
          openingStatement: '医生您好，我今年才三十八岁，近三周快步走胸口老发闷，而且体检好几年都说低密度脂蛋白特别高。',
          knownHistorySummary: '三四年前开始每年体检低密度脂蛋白都到 5 点几以上，2023 年 5.5、去年外院测到 5.8，平时不抽烟；我父亲 46 岁那年突发心梗放过支架。',
          symptomExperience: '发作时胸骨后压迫发紧约五分钟，休息可以缓解，静息时不痛，没有大汗或晕厥。',
          medicationMemory: '去年外院开过阿托伐他汀，自己觉得没症状加上担心伤肝，断断续续吃了两个月就停了半年多。',
          persona: { character: '认真配合但对长期用药有顾虑', speechStyle: '主动提供多年体检数值与家族史', healthLiteracy: '较高', attitude: '希望系统评估原因并调整治疗' },
        },
      },
    },
    {
      id: 'trap-epigastric-t2dm-ruleout-v1',
      title: '黄金病例⑧ 高龄 2 型糖尿病上腹痛非典型胸痛排查',
      titleEn: 'Golden Case 8: Elderly T2DM with epigastric pain atypical ACS rule-out trap',
      recommendedEntry: 'outpatient',
      plannedStentCount: 0,
      patient: {
        id: 'authored-dsap-epigastric-08',
        name: '孙文华',
        birthDate: '1956-04-10',
        gender: 'male',
      },
      indexDateTime,
      chiefComplaint: '上腹部隐痛伴反酸饱胀 3 小时，否认典型胸痛。',
      indexConditions: [
        {
          id: 'epigastric-pain',
          system: icd10,
          code: 'R10.1',
          display: '上腹痛',
          note: '70 岁 2 型糖尿病患者以上腹部不适就诊，自诉否认典型胸痛；规范完成心电图、首复次 hs-cTnI 与 D-二聚体排查后均呈阴性。',
        },
        {
          id: 't2dm',
          system: icd10,
          code: 'E11.9',
          display: '2型糖尿病',
        },
      ],
      visibleHistory: [
        {
          id: 't2dm-clinic-2025',
          encounterDateTime: '2025-11-18T09:00:00+08:00',
          reasonText: '外院内分泌科复诊 2 型糖尿病',
          conditions: [
            { id: 't2dm-hist', system: icd10, code: 'E11.9', display: '2型糖尿病', note: '病史 12 年，口服二甲双胍控制血糖，既往无冠心病史。' },
          ],
          observations: [
            lab('hba1c', 7.4, { idSuffix: 'hist-2025', interpretation: 'H' }),
            lab('glucose', 8.1, { idSuffix: 'hist-2025', interpretation: 'H' }),
            lab('creatinine', 76, { idSuffix: 'hist-2025', interpretation: 'N' }),
          ],
          medications: [
            { id: 'metformin', code: 'CM-DRUG-METFORMIN-500MG-ORAL-TABLET', display: '盐酸二甲双胍缓释片', dosageText: '500 mg 每日两次 口服' },
          ],
        },
      ],
      laboratories: [
        ...baselineLabs({
          creatinine: 78,
          ctnt: 0.005,
          dDimer: 0.26,
          glucose: 8.4,
          hba1c: 7.5,
          hsCtni: 0.007,
          ldl: 2.8,
          tc: 4.8,
        }).filter(item => !['hsCtni', 'ctnt'].includes(item.id)),
        lab('hsCtni', 0.007, { interpretation: 'N', stage: 'initial' }),
        lab('hsCtni', 0.008, { interpretation: 'N', stage: 'repeat' }),
        lab('ctnt', 0.005, { interpretation: 'N', stage: 'initial' }),
        lab('ctnt', 0.006, { interpretation: 'N', stage: 'repeat' }),
      ],
      ecgs: [
        {
          stage: 'initial',
          rhythm: '窦性心律',
          ventricularRateBpm: 76,
          prIntervalMs: 168,
          qrsDurationMs: 90,
          qtcIntervalMs: 418,
          stTAnterior: '未见 ST 段抬高或压低',
          stTInferior: '未见 ST 段偏移及 T 波倒置',
          stTLateral: '未见明显异常',
          conclusion: '窦性心律，12 导联心电图未见急性心肌缺血性 ST-T 改变。',
        },
      ],
      ttes: [
        {
          lvefPercent: 61,
          lveddMm: 47,
          regionalWallMotion: '各壁运动协调正常',
          valves: '主动脉瓣轻度钙化，未见明显反流或狭窄',
          diastolicFunction: '左室舒张功能 I 级减低（符合年龄）',
          conclusion: '静息左室收缩功能正常（LVEF 61%），未见节段性室壁运动异常。',
        },
      ],
      persona: {
        version: 'dsap-epigastric-t2dm-persona-v1',
        content: {
          chiefComplaint: '今天早上吃完早饭后胃口正上方隐隐发胀作痛三个小时，否认典型胸痛。',
          openingStatement: '医生，我主要是心窝下面靠胃这里一阵阵闷痛、有点反酸，否认典型胸痛，家里人担心我年纪大又有 2 型糖尿病让我来看看。',
          knownHistorySummary: '2型糖尿病十二年，平时按时吃二甲双胍，糖化血红蛋白在 7.4% 左右，没有已知药物过敏。',
          symptomExperience: '位置偏在上腹部剑突下，稍微有一点反酸和嗳气，否认典型胸痛，也没有出冷汗、呼吸困难或向下颌肩背放散。',
          medicationMemory: '每天早晚各吃一片二甲双胍缓释片，今天早上也正常服药了。',
          persona: { character: '沉稳但略谨慎', speechStyle: '朴实直白', healthLiteracy: '一般', attitude: '配合医生完成必要排查' },
        },
      },
    },
    {
      id: 'trap-external-creatinine-v1',
      title: '黄金病例⑨ 外院未核实肌酐升高伴胸痛（未复查不可视作院内可信结果）',
      titleEn: 'Golden Case 9: Chest pain with unverified external creatinine 220 umol/L',
      recommendedEntry: 'outpatient',
      plannedStentCount: 0,
      patient: {
        id: 'authored-dsap-ext-cr-09',
        name: '马国强',
        birthDate: '1962-11-05',
        gender: 'male',
      },
      indexDateTime,
      chiefComplaint: '间断胸闷胸痛 5 小时，携带外院肌酐 220 μmol/L 化验单。',
      indexConditions: [
        {
          id: 'unstable-angina',
          system: icd10,
          code: 'I20.0',
          display: '不稳定型心绞痛',
          note: '胸痛待查伴外院肌酐 220 umol/L，未开立本院肾功能检验前不可把外院记录当作正式 eGFR；院内预置初诊肌酐 198 / 复查 186 / 住院 182 umol/L。',
        },
        {
          id: 'ckd-stage3',
          system: icd10,
          code: 'N18.3',
          display: '慢性肾脏病 3 期',
          note: '须经本院检验正式复核血肌酐及 eGFR。',
        },
      ],
      visibleHistory: [
        {
          id: 'external-cr-2026',
          encounterDateTime: '2026-08-21T14:00:00+08:00',
          reasonText: '外院门诊查血肌酐升高（220 μmol/L，未带完整肾功复核）',
          conditions: [
            { id: 'htn-hist', system: icd10, code: 'I10', display: '高血压', note: '高血压病史 10 年，近期血压控制尚可。' },
          ],
          observations: [
            lab('creatinine', 220, { idSuffix: 'hist-external', interpretation: 'H' }),
          ],
          medications: [
            { id: 'amlodipine', code: 'CM-DRUG-AMLODIPINE-5MG-ORAL-TABLET', display: '苯磺酸氨氯地平片', dosageText: '5 mg 每日一次 口服' },
          ],
        },
      ],
      laboratories: [
        ...baselineLabs({
          creatinine: 198,
          ctnt: 0.008,
          cystatinC: 1.68,
          dDimer: 0.28,
          hemoglobin: 128,
          hsCtni: 0.011,
          potassium: 4.65,
          urea: 11.2,
        }).filter(item => !['creatinine', 'hsCtni', 'ctnt'].includes(item.id)),
        lab('creatinine', 198, { interpretation: 'H', stage: 'initial' }),
        lab('creatinine', 186, { interpretation: 'H', stage: 'repeat' }),
        lab('creatinine', 182, { interpretation: 'H', stage: 'inpatient' }),
        lab('hsCtni', 0.011, { interpretation: 'N', stage: 'initial' }),
        lab('hsCtni', 0.013, { interpretation: 'N', stage: 'repeat' }),
        lab('ctnt', 0.008, { interpretation: 'N', stage: 'initial' }),
      ],
      ecgs: [
        {
          stage: 'initial',
          rhythm: '窦性心律',
          ventricularRateBpm: 80,
          prIntervalMs: 162,
          qrsDurationMs: 92,
          qtcIntervalMs: 422,
          stTAnterior: 'V4-V6 导联 T 波低平',
          stTInferior: '未见明显 ST 段偏移',
          stTLateral: 'I、aVL 导联 ST 段大致等电位线',
          conclusion: '窦性心律，部分胸前导联 T 波低平，需结合动态肌钙蛋白复查评估。',
        },
      ],
      ttes: [
        {
          lvefPercent: 58,
          lveddMm: 49,
          regionalWallMotion: '静息未见明显节段性室壁运动异常',
          valves: '二尖瓣少量反流',
          diastolicFunction: '左室舒张功能 I 级减低',
          conclusion: '左室收缩功能正常（LVEF 58%），二尖瓣少量反流。',
        },
      ],
      persona: {
        version: 'dsap-external-creatinine-persona-v1',
        content: {
          chiefComplaint: '今天早上起胸口一阵阵发闷发痛五个小时，三天前在外面医院抽血说血肌酐高到 220。',
          openingStatement: '医生您好，我今天胸口老闷痛，前几天在区里医院查了张单子说血肌酐 220 偏高，今天来您这还没来得及重新抽血。',
          knownHistorySummary: '高血压十年，以前没查出过别的大毛病，三天前外院化验血肌酐 220，没有药物过敏。',
          symptomExperience: '胸骨中段发闷疼痛每次大约十分钟，走路时明显一点，休息能缓一些，没有喘不上气或浮肿少尿。',
          medicationMemory: '每天早晨吃一片氨氯地平片，没吃保肾药也没吃阿司匹林。',
          persona: { character: '比较担心用药和造影影响肾脏', speechStyle: '条理清楚', healthLiteracy: '中等', attitude: '主动出示外院化验单但需院内重新检查确认' },
        },
      },
    },
    {
      id: 'trap-pregnant-chest-pain-v1',
      title: '黄金病例⑩ 妊娠期胸痛特殊人群评估（妊娠安全性提示）',
      titleEn: 'Golden Case 10: Pregnant chest pain special-population assessment',
      recommendedEntry: 'outpatient',
      plannedStentCount: 0,
      patient: {
        id: 'authored-dsap-pregnant-10',
        name: '许晴雯',
        birthDate: '1995-07-22',
        gender: 'female',
      },
      indexDateTime,
      chiefComplaint: '孕 24 周活动后胸闷伴轻微胸前区不适 4 小时。',
      indexConditions: [
        {
          id: 'pregnancy',
          system: icd10,
          code: 'Z33',
          display: '妊娠状态',
          note: '孕 24 周妊娠期特殊人群。',
        },
        {
          id: 'preg-related',
          system: icd10,
          code: 'O26.8',
          display: '其他特指的妊娠相关情况',
          note: '妊娠期胸痛评估，须充分考量妊娠禁忌药物与胎儿辐射防护。',
        },
        {
          id: 'chest-pain-nos',
          system: icd10,
          code: 'R07.4',
          display: '未特指的胸痛',
        },
      ],
      visibleHistory: [
        {
          id: 'prenatal-2026',
          encounterDateTime: '2026-08-10T09:30:00+08:00',
          reasonText: '外院产科常规产检（孕 22 周）',
          conditions: [
            { id: 'pregnancy-hist', system: icd10, code: 'Z33', display: '妊娠状态', note: '单胎妊娠，定期产检血压血糖正常。' },
            { id: 'preg-related-hist', system: icd10, code: 'O26.8', display: '其他特指的妊娠相关情况', note: '妊娠期轻度生理性稀释性贫血观察。' },
          ],
          observations: [
            lab('hemoglobin', 114, { idSuffix: 'hist-preg', interpretation: 'L' }),
            lab('creatinine', 52, { idSuffix: 'hist-preg', interpretation: 'N' }),
          ],
          medications: [],
        },
      ],
      laboratories: [
        ...baselineLabs({
          female: true,
          creatinine: 54,
          ctnt: 0.004,
          dDimer: 0.62,
          hematocrit: 0.34,
          hemoglobin: 112,
          hsCtni: 0.005,
          ldl: 2.85,
          tc: 5.2,
          urea: 3.4,
        }).filter(item => !['hsCtni', 'ctnt', 'dDimer'].includes(item.id)),
        lab('hsCtni', 0.005, { interpretation: 'N', stage: 'initial' }),
        lab('hsCtni', 0.006, { interpretation: 'N', stage: 'repeat' }),
        lab('ctnt', 0.004, { interpretation: 'N', stage: 'initial' }),
        lab('dDimer', 0.62, { interpretation: 'H', stage: 'initial' }),
      ],
      ecgs: [
        {
          stage: 'initial',
          rhythm: '窦性心律',
          ventricularRateBpm: 88,
          prIntervalMs: 148,
          qrsDurationMs: 84,
          qtcIntervalMs: 412,
          stTAnterior: '未见明显 ST-T 缺血性改变',
          stTInferior: '未见 ST 段偏移',
          stTLateral: '未见 ST 段偏移',
          conclusion: '窦性心律（88 次/分），心电图未见明显急性心肌缺血改变。',
        },
      ],
      ttes: [
        {
          lvefPercent: 64,
          lveddMm: 46,
          regionalWallMotion: '静息状态下左室各壁运动正常',
          valves: '轻度生理性三尖瓣反流，余瓣膜正常',
          diastolicFunction: '左室舒张功能正常',
          conclusion: '妊娠期高动力循环表现，左室收缩功能正常（LVEF 64%），未见节段性室壁运动异常及心包积液。',
        },
      ],
      persona: {
        version: 'dsap-pregnant-chest-pain-persona-v1',
        content: {
          chiefComplaint: '现在怀孕 24 周，今天早上走动后觉得胸口有些闷、隐隐有点不舒服四个小时了。',
          openingStatement: '医生您好，我现在处于妊娠状态，怀孕六个多月（24 周），今天走几步就觉得胸口发闷发紧，怕影响宝宝所以过来看看。',
          knownHistorySummary: '目前孕 24 周规律产检，两周前产检说血红蛋白稍微偏低一点，血压血糖一直正常，没有其他慢病或药物过敏。',
          symptomExperience: '活动多时胸口有轻微闷胀感，坐下休息一会儿会轻很多，没有剧烈撕裂痛、咳血或单腿肿胀，胎动如常。',
          medicationMemory: '只吃产科发的复合维生素和钙片，平时特别注意哪些药和带辐射检查孕妇不能用。',
          persona: { character: '非常谨慎并重视母胎安全', speechStyle: '温和清晰', healthLiteracy: '较好', attitude: '配合抽血、心电图与超声，但对用药和射线极度谨慎' },
        },
      },
    },
  ],
}

export const compiledDsapExtraGoldenCasePack = compileAuthoredCasePack(dsapExtraGoldenCasePackDefinition)

export function listFrozenDsapGoldenCases(): readonly CompiledAuthoredCase[] {
  return [
    ...compiledCardiorenalAuthoredCasePack.cases,
    ...compiledDsapExtraGoldenCasePack.cases,
  ]
}
