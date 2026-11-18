import {
  orderSetTemplateSchema,
  type OrderSetScope,
  type OrderSetScreeningRule,
  type OrderSetTemplate,
  type OrderSetTemplateId,
  type OrderSetTemplateItem,
  type OrderSetTemplateOption,
} from '@clinmesh/contracts/order-set-templates'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

const version = '2026-11-18.r1'
const wst = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026'
const panel = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn'
const loinc = 'http://loinc.org'
const both: OrderSetScope[] = ['outpatient', 'inpatient']
const inpatientOnly: OrderSetScope[] = ['inpatient']

const lab = (referenceSystem: string, referenceCode: string): OrderSetTemplateOption => ({ kind: 'laboratory', referenceCode, referenceSystem })
const exam = (examCode: 'ecg-12-lead' | 'tte', indication: string): OrderSetTemplateOption => ({ examCode, indication, kind: 'examination' })
const medication = (
  medicationKey: string,
  doseText: string,
  frequencyCode: 'QD' | 'BID' | 'QN' | 'PRN' | 'ONCE',
  extra: { inpatientDuration?: 'long' | 'temporary'; instructionsZh?: string; prnQuantity?: number; rules?: OrderSetScreeningRule[] } = {},
): OrderSetTemplateOption => ({
  courseDays: 7,
  doseText,
  frequencyCode,
  inpatientDuration: extra.inpatientDuration ?? 'long',
  ...(extra.instructionsZh === undefined ? {} : { instructionsZh: extra.instructionsZh }),
  kind: 'medication',
  medicationKey,
  ...(extra.prnQuantity === undefined ? {} : { prnQuantity: extra.prnQuantity }),
  rules: extra.rules ?? [],
})
const rule = (
  input: OrderSetScreeningRule['input'],
  comparator: OrderSetScreeningRule['comparator'],
  threshold: number | null,
  action: OrderSetScreeningRule['action'],
  rationaleZh: string,
): OrderSetScreeningRule => ({ action, comparator, input, rationaleZh, threshold })

// 检验条目按院内服务的参考编码身份匹配；首选组合缺失时依序回退到同一临床目的的已发布单项。
const hsCtni: OrderSetTemplateItem = {
  key: 'hs-ctni',
  kind: 'laboratory',
  options: [lab(wst, '2100404B'), lab(wst, '2100404A'), lab(panel, 'CN-LAB-CARDIAC')],
  rationaleZh: '心肌肌钙蛋白是急性心肌损伤判定依据；单次阴性不能排除 NSTE-ACS，须按时间窗复测。',
  rules: [],
  scopes: both,
  titleEn: 'High-sensitivity cardiac troponin I',
  titleZh: '高敏心肌肌钙蛋白 I',
}
const renal: OrderSetTemplateItem = {
  key: 'renal-function',
  kind: 'laboratory',
  options: [lab(panel, 'CN-LAB-RENAL'), lab(wst, '1700404A'), lab(loinc, '2160-0')],
  rationaleZh: '血肌酐用于 eGFR 计算，决定抗栓、对比剂与经肾排泄药物的使用边界。',
  rules: [],
  scopes: both,
  titleEn: 'Renal function',
  titleZh: '肾功能',
}
const electrolytes: OrderSetTemplateItem = {
  key: 'electrolytes',
  kind: 'laboratory',
  options: [lab(panel, 'CN-LAB-ELECTROLYTES'), lab(wst, '1400605A'), lab(loinc, '2823-3')],
  rationaleZh: '血钾等电解质异常影响心律失常风险及 RAAS 抑制剂、利尿剂使用。',
  rules: [],
  scopes: both,
  titleEn: 'Electrolytes',
  titleZh: '电解质',
}
const ecg = (indication: string): OrderSetTemplateItem => ({
  key: 'ecg-12-lead',
  kind: 'examination',
  options: [exam('ecg-12-lead', indication)],
  rationaleZh: '12 导联心电图识别 ST 段抬高/压低、心律失常与传导阻滞，是胸痛首诊与入院基线必查项目。',
  rules: [],
  scopes: both,
  titleEn: '12-lead ECG',
  titleZh: '常规 12 导联心电图',
})

const bloodPressureRules = [
  rule('systolicMmHg', 'below', 90, 'exclude', '收缩压 < 90 mmHg 时不在组套中起始降压或扩血管药物'),
  rule('systolicMmHg', 'below', 100, 'caution', '血压偏低，起始前须复测并评估容量与灌注'),
]
const heartRateRules = [
  rule('pulseBpm', 'below', 50, 'exclude', '心动过缓时不在组套中起始 β 受体阻滞剂'),
  rule('pulseBpm', 'below', 60, 'caution', '心率偏慢，起始需从低剂量开始并监测心率'),
]

const definitions: Array<Omit<OrderSetTemplate, 'fingerprint'>> = [
  {
    descriptionZh: '急性胸痛首诊急查：首诊 10 分钟内 12 导联心电图，同时送检高敏肌钙蛋白、D-二聚体、肾功能与电解质，用于 ACS、肺栓塞等高危病因初筛；不含抗栓或其他治疗医嘱。',
    id: 'chest-pain-stat-workup',
    items: [
      ecg('急性胸痛首诊，10 分钟内完成 12 导联心电图评估 ST 段改变'),
      hsCtni,
      {
        key: 'd-dimer',
        kind: 'laboratory',
        options: [lab(wst, '0501703A'), lab(panel, 'CN-LAB-COAGULATION')],
        rationaleZh: 'D-二聚体用于低中度可能性急性肺栓塞与主动脉夹层的排除性评估，阳性须结合影像。',
        rules: [],
        scopes: both,
        titleEn: 'D-dimer',
        titleZh: 'D-二聚体',
      },
      renal,
      electrolytes,
    ],
    scopes: both,
    titleEn: 'Chest pain stat work-up',
    titleZh: '胸痛首诊急查',
    version,
  },
  {
    descriptionZh: '冠心病入院基线评估：常规 12 导联心电图、经胸超声心动图及血常规（五分类）、肾功能、电解质、血脂、糖化血红蛋白、高敏心肌肌钙蛋白 I、NT-proBNP 与凝血功能，为介入决策、抗栓与他汀治疗提供基线。',
    id: 'cad-admission-baseline',
    items: [
      { ...ecg('冠心病入院基线心电图'), scopes: inpatientOnly },
      {
        key: 'tte',
        kind: 'examination',
        options: [exam('tte', '冠心病入院评估左室射血分数、室壁运动与瓣膜功能')],
        rationaleZh: '左室射血分数与节段性室壁运动影响血运重建策略、β 受体阻滞剂与 RAAS 抑制剂选择。',
        rules: [],
        scopes: inpatientOnly,
        titleEn: 'Transthoracic echocardiography',
        titleZh: '经胸超声心动图',
      },
      {
        key: 'cbc',
        kind: 'laboratory',
        options: [lab(panel, 'CN-LAB-CBC-5DIFF'), lab(panel, 'CN-LAB-CBC'), lab(loinc, '718-7')],
        rationaleZh: '血红蛋白与血小板是抗栓出血风险（PRECISE-DAPT）与介入前评估的必要基线。',
        rules: [],
        scopes: inpatientOnly,
        titleEn: 'Complete blood count',
        titleZh: '血常规（五分类）',
      },
      { ...renal, scopes: inpatientOnly },
      { ...electrolytes, scopes: inpatientOnly },
      {
        key: 'lipids',
        kind: 'laboratory',
        options: [lab(panel, 'CN-LAB-LIPIDS'), lab(wst, '2000404A')],
        rationaleZh: '降脂治疗前基线 LDL-C 决定 ASCVD 分层目标值与达标评估。',
        rules: [],
        scopes: inpatientOnly,
        titleEn: 'Lipid panel',
        titleZh: '血脂',
      },
      {
        key: 'hba1c',
        kind: 'laboratory',
        options: [lab(panel, 'CN-LAB-HBA1C'), lab(wst, '1100301A')],
        rationaleZh: '筛查合并糖尿病，影响危险分层与降糖药物选择。',
        rules: [],
        scopes: inpatientOnly,
        titleEn: 'Glycated hemoglobin',
        titleZh: '糖化血红蛋白',
      },
      { ...hsCtni, scopes: inpatientOnly },
      {
        key: 'nt-probnp',
        kind: 'laboratory',
        options: [lab(wst, '2100704A')],
        rationaleZh: 'NT-proBNP 评估心功能不全与预后。',
        rules: [],
        scopes: inpatientOnly,
        titleEn: 'NT-proBNP',
        titleZh: '氨基末端脑利钠肽前体',
      },
      {
        key: 'coagulation',
        kind: 'laboratory',
        options: [lab(panel, 'CN-LAB-COAGULATION'), lab(wst, '0501703A'), lab(loinc, '6301-6')],
        rationaleZh: '介入及抗凝前评估凝血功能。',
        rules: [],
        scopes: inpatientOnly,
        titleEn: 'Coagulation panel',
        titleZh: '凝血功能',
      },
    ],
    scopes: inpatientOnly,
    titleEn: 'CAD admission baseline',
    titleZh: '冠心病入院基线评估',
    version,
  },
  {
    descriptionZh: '对比剂肾损高危围术期水化：造影前 3–12 h 至术后 6–24 h 以 0.9% 氯化钠按 1 mL/kg/h 静脉水化（合并心衰或 LVEF ≤35% 时减至 0.5 mL/kg/h），术后 48–72 h 复查血肌酐。',
    id: 'cin-perioperative-hydration',
    items: [
      {
        key: 'isotonic-saline-hydration',
        kind: 'medication',
        options: [medication('sodium-chloride', '1000 mL', 'ONCE', { inpatientDuration: 'temporary', instructionsZh: '静脉滴注，按 1 mL/kg/h 调整滴速，覆盖造影前 3–12 h 至术后 6–24 h' })],
        rationaleZh: '等渗盐水静脉水化是对比剂相关急性肾损伤高危患者的预防措施。',
        rules: [
          rule('egfr', 'at-least', 60, 'caution', 'eGFR ≥ 60 不属于对比剂肾损高危，水化应按临床评估决定'),
          rule('weightKg', 'required', null, 'caution', '水化滴速按体重 1 mL/kg/h 核定'),
        ],
        scopes: inpatientOnly,
        titleEn: 'Isotonic saline hydration',
        titleZh: '0.9% 氯化钠围术期水化',
      },
      {
        key: 'creatinine-recheck',
        kind: 'laboratory',
        options: [lab(wst, '1700404A'), lab(loinc, '2160-0'), lab(panel, 'CN-LAB-RENAL')],
        rationaleZh: '术后 48–72 h 复查血肌酐，较基线升高 ≥ 26.5 μmol/L 或 ≥ 50% 提示对比剂相关急性肾损伤。',
        rules: [],
        scopes: inpatientOnly,
        titleEn: 'Serum creatinine recheck',
        titleZh: '血肌酐复查',
      },
    ],
    scopes: inpatientOnly,
    titleEn: 'Contrast nephropathy perioperative hydration',
    titleZh: '对比剂肾损高危围术期水化',
    version,
  },
  {
    descriptionZh: '冠心病/PCI 二级预防标准用药：阿司匹林联合氯吡格雷双联抗血小板、阿托伐他汀、美托洛尔、培哚普利及按需硝酸甘油；存在药物过敏、心动过缓、低血压或严重肾损时自动剔除或标记受限条目，缺体征或肾功能时标记待核实。',
    id: 'cad-pci-secondary-prevention',
    items: [
      {
        key: 'aspirin',
        kind: 'medication',
        options: [medication('aspirin', '100 mg', 'QD')],
        rationaleZh: '阿司匹林长期抗血小板是冠心病二级预防基础。',
        rules: [],
        scopes: both,
        titleEn: 'Aspirin',
        titleZh: '阿司匹林',
      },
      {
        key: 'p2y12-inhibitor',
        kind: 'medication',
        options: [medication('clopidogrel', '75 mg', 'QD')],
        rationaleZh: 'PCI 术后与阿司匹林组成双联抗血小板治疗。',
        rules: [],
        scopes: both,
        titleEn: 'Clopidogrel (P2Y12 inhibitor)',
        titleZh: '氯吡格雷（P2Y12 抑制剂）',
      },
      {
        key: 'statin',
        kind: 'medication',
        options: [medication('atorvastatin', '20 mg', 'QN')],
        rationaleZh: '他汀降低 LDL-C 并稳定冠脉斑块。',
        rules: [],
        scopes: both,
        titleEn: 'Atorvastatin',
        titleZh: '阿托伐他汀',
      },
      {
        key: 'beta-blocker',
        kind: 'medication',
        options: [medication('metoprolol', '47.5 mg', 'QD')],
        rationaleZh: 'β 受体阻滞剂改善心肌缺血与心梗后预后，起始前须核对心率与血压。',
        rules: [...heartRateRules, ...bloodPressureRules],
        scopes: both,
        titleEn: 'Beta blocker',
        titleZh: 'β 受体阻滞剂',
      },
      {
        key: 'acei',
        kind: 'medication',
        options: [medication('perindopril', '4 mg', 'QD')],
        rationaleZh: 'ACEI 用于合并高血压、糖尿病、左室功能不全或慢性肾病的冠心病患者，起始前须核对血压与肾功能。',
        rules: [
          ...bloodPressureRules,
          rule('egfr', 'below', 30, 'exclude', 'eGFR < 30 时不在组套中直接起始 ACEI，须专科评估剂量与血钾'),
          rule('egfr', 'below', 60, 'caution', '肾功能下降须按肌酐清除率减量并监测血钾与肌酐'),
        ],
        scopes: both,
        titleEn: 'ACE inhibitor',
        titleZh: '血管紧张素转换酶抑制剂',
      },
      {
        key: 'nitroglycerin-prn',
        kind: 'medication',
        options: [medication('nitroglycerin', '0.5 mg', 'PRN', { instructionsZh: '心绞痛发作时舌下含服，5 分钟不缓解可重复，最多 3 次', prnQuantity: 10 })],
        rationaleZh: '硝酸甘油按需缓解心绞痛发作；低血压时禁用。',
        rules: [rule('systolicMmHg', 'below', 90, 'exclude', '收缩压 < 90 mmHg 时禁用硝酸酯类')],
        scopes: both,
        titleEn: 'Nitroglycerin as needed',
        titleZh: '硝酸甘油（按需）',
      },
    ],
    scopes: both,
    titleEn: 'CAD/PCI secondary prevention',
    titleZh: '冠心病/PCI 二级预防',
    version,
  },
]

/** 组套定义随代码发布；指纹覆盖全部条目、候选与筛选规则，任何内容变化都会改变版本绑定。 */
export const orderSetTemplates: readonly OrderSetTemplate[] = Object.freeze(definitions.map(definition =>
  orderSetTemplateSchema.parse({ ...definition, fingerprint: canonicalJsonHash(definition) })))

export function orderSetTemplate(id: OrderSetTemplateId): OrderSetTemplate {
  return orderSetTemplates.find(template => template.id === id)!
}
