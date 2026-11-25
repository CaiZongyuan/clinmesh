import type { ClinicalFact, ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import {
  conceptVocabularySchema,
  type ConceptMapping,
  type ConceptMappingEligibility,
  type ConceptNode,
  type ConceptVocabulary,
} from '@clinmesh/contracts/concept-vocabulary'

export type ConceptVocabularyErrorCode = 'CONCEPT_VOCABULARY_INVALID'

export class ConceptVocabularyError extends Error {
  readonly code: ConceptVocabularyErrorCode

  constructor(
    code: ConceptVocabularyErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ConceptVocabularyError'
    this.code = code
  }
}

const SEED_EFFECTIVE_DATE = '2026-01-01'
const SEED_REVIEWER_ID = 'reviewer-public-seed'
const SEED_VERSION = '2026.01.r1'

function pubNode(
  code: string,
  displayZh: string,
  domain: ConceptNode['domain'],
  parentCode: string | null,
  options?: { displayEn?: string; synonyms?: readonly string[] },
): ConceptNode {
  return {
    code,
    ...(options?.displayEn === undefined ? {} : { displayEn: options.displayEn }),
    displayZh,
    domain,
    layer: 'public',
    parentCode,
    synonyms: options?.synonyms ? [...options.synonyms] : [],
  }
}

function pubExactMapping(
  id: string,
  sourceSystem: string,
  sourceCode: string,
  sourceDisplay: string,
  targetConceptCode: string,
): ConceptMapping {
  return {
    effectiveDate: SEED_EFFECTIVE_DATE,
    id,
    relation: 'exact',
    reviewStatus: 'approved',
    reviewerId: SEED_REVIEWER_ID,
    sourceCode,
    sourceDisplay,
    sourceSystem,
    targetConceptCode,
    version: SEED_VERSION,
  }
}

const PUBLIC_NODES: readonly ConceptNode[] = [
  // Laboratory hierarchy
  pubNode('cardiac-troponin', '心肌肌钙蛋白', 'laboratory', null, {
    displayEn: 'Cardiac Troponin',
    synonyms: ['肌钙蛋白', 'cTn'],
  }),
  pubNode('89579-7', '高敏肌钙蛋白 I (hs-cTnI)', 'laboratory', 'cardiac-troponin', {
    displayEn: 'High-sensitivity Cardiac Troponin I',
    synonyms: ['hs-cTnI', '高敏肌钙蛋白I', '49563-0', '2100404B'],
  }),
  pubNode('10839-9', '常规肌钙蛋白 I (cTnI)', 'laboratory', 'cardiac-troponin', {
    displayEn: 'Conventional Cardiac Troponin I',
    synonyms: ['常规cTnI', '肌钙蛋白I', '6598-7', '2100404A'],
  }),
  pubNode('6597-9', '肌钙蛋白 T (cTnT)', 'laboratory', 'cardiac-troponin', {
    displayEn: 'Cardiac Troponin T',
    synonyms: ['cTnT', '肌钙蛋白T', '67151-1', '42757-5', '2100504A'],
  }),
  pubNode('2160-0', '血清肌酐', 'laboratory', null, {
    displayEn: 'Serum Creatinine',
    synonyms: ['血肌酐', 'SCr', 'Creatinine', '14682-9', '1700404A'],
  }),
  pubNode('lipid-panel', '血脂四项', 'laboratory', null, {
    displayEn: 'Lipid Panel',
    synonyms: ['血脂谱', '血脂'],
  }),
  pubNode('13457-7', '低密度脂蛋白胆固醇 (LDL-C)', 'laboratory', 'lipid-panel', {
    displayEn: 'Low-density Lipoprotein Cholesterol',
    synonyms: ['LDL-C', '低密度脂蛋白胆固醇', '18262-6', '2089-1', '1700303A'],
  }),
  pubNode('2093-3', '总胆固醇 (TC)', 'laboratory', 'lipid-panel', {
    displayEn: 'Total Cholesterol',
    synonyms: ['TC', '总胆固醇', '1700301A'],
  }),
  pubNode('2085-9', '高密度脂蛋白胆固醇 (HDL-C)', 'laboratory', 'lipid-panel', {
    displayEn: 'High-density Lipoprotein Cholesterol',
    synonyms: ['HDL-C', '高密度脂蛋白胆固醇', '1700302A'],
  }),
  pubNode('2571-8', '甘油三酯 (TG)', 'laboratory', 'lipid-panel', {
    displayEn: 'Triglycerides',
    synonyms: ['TG', '甘油三酯', '1700304A'],
  }),
  pubNode('4548-4', '糖化血红蛋白 (HbA1c)', 'laboratory', null, {
    displayEn: 'Hemoglobin A1c',
    synonyms: ['HbA1c', '糖化血红蛋白', '17856-6', '1100301A'],
  }),
  pubNode('48065-7', 'D-二聚体', 'laboratory', null, {
    displayEn: 'D-dimer',
    synonyms: ['D-dimer', 'D二聚体'],
  }),

  // Diagnosis hierarchy
  pubNode('coronary-artery-disease', '冠状动脉粥样硬化性心脏病', 'diagnosis', null, {
    displayEn: 'Coronary Artery Disease',
    synonyms: ['冠心病', '冠状动脉粥样硬化性心脏病', 'CAD', 'I25', 'I25.1', 'I25.103'],
  }),
  pubNode('stable-cad', '稳定性冠心病', 'diagnosis', 'coronary-artery-disease', {
    displayEn: 'Stable Coronary Artery Disease',
    synonyms: ['稳定性冠心病', '慢性冠脉综合征', 'CCS', 'I25.102'],
  }),
  pubNode('acute-coronary-syndrome', '急性冠脉综合征', 'diagnosis', 'coronary-artery-disease', {
    displayEn: 'Acute Coronary Syndrome',
    synonyms: ['急性冠脉综合征', 'ACS', 'I20.0'],
  }),
  pubNode('myocardial-infarction', '心肌梗死', 'diagnosis', 'acute-coronary-syndrome', {
    displayEn: 'Myocardial Infarction',
    synonyms: ['心肌梗死', '心梗', 'MI', 'I21'],
  }),
  pubNode('nstemi', '非ST段抬高型心肌梗死', 'diagnosis', 'myocardial-infarction', {
    displayEn: 'Non-ST-Elevation Myocardial Infarction',
    synonyms: ['NSTEMI', '非ST段抬高型心肌梗死', 'I21.4'],
  }),
  pubNode('stemi', 'ST段抬高型心肌梗死', 'diagnosis', 'myocardial-infarction', {
    displayEn: 'ST-Elevation Myocardial Infarction',
    synonyms: ['STEMI', 'ST段抬高型心肌梗死', 'I21.3'],
  }),
  pubNode('type-2-diabetes', '2型糖尿病', 'diagnosis', null, {
    displayEn: 'Type 2 Diabetes Mellitus',
    synonyms: ['2型糖尿病', 'T2DM', 'E11'],
  }),
  pubNode('chronic-kidney-disease', '慢性肾脏病', 'diagnosis', null, {
    displayEn: 'Chronic Kidney Disease',
    synonyms: ['慢性肾脏病', 'CKD', 'N18'],
  }),
  pubNode('chest-wall-pain', '胸壁痛', 'diagnosis', null, {
    displayEn: 'Chest Wall Pain',
    synonyms: ['胸壁痛', '非心源性胸痛', 'R07.3'],
  }),
  pubNode('familial-hypercholesterolemia', '家族性高胆固醇血症', 'diagnosis', null, {
    displayEn: 'Familial Hypercholesterolemia',
    synonyms: ['家族性高胆固醇血症', 'FH', 'E78.0'],
  }),

  // Vital signs & clinical phenotypes
  pubNode('8480-6', '收缩压', 'vital-sign', null, {
    displayEn: 'Systolic Blood Pressure',
    synonyms: ['收缩压', 'SBP'],
  }),
  pubNode('8462-4', '舒张压', 'vital-sign', null, {
    displayEn: 'Diastolic Blood Pressure',
    synonyms: ['舒张压', 'DBP'],
  }),
  pubNode('smoking-status', '吸烟状态', 'symptom-or-questionnaire', null, {
    displayEn: 'Smoking Status',
    synonyms: ['吸烟状态', '吸烟史'],
  }),
  pubNode('killip-class', 'Killip 心功能分级', 'phenotype', null, {
    displayEn: 'Killip Classification',
    synonyms: ['Killip分级', 'Killip心功能分级'],
  }),

  // Migrated pharmacology-class hierarchy
  pubNode('pharmacology-class', '药理类别', 'medication-class', null, {
    displayEn: 'Pharmacology Class',
  }),
  pubNode('antiplatelet', '抗血小板药', 'medication-class', 'pharmacology-class', {
    displayEn: 'Antiplatelet Agents',
  }),
  pubNode('antiplatelet-aspirin', '阿司匹林类抗血小板药', 'medication-class', 'antiplatelet', {
    displayEn: 'Aspirin Antiplatelet',
  }),
  pubNode('p2y12', 'P2Y12 受体拮抗剂', 'medication-class', 'antiplatelet', {
    displayEn: 'P2Y12 Receptor Inhibitors',
  }),
  pubNode('anticoagulant', '抗凝药', 'medication-class', 'pharmacology-class', {
    displayEn: 'Anticoagulants',
  }),
  pubNode('heparin', '肝素类抗凝药', 'medication-class', 'anticoagulant', {
    displayEn: 'Heparin Anticoagulants',
  }),
  pubNode('lipid-lowering', '调脂药', 'medication-class', 'pharmacology-class', {
    displayEn: 'Lipid-lowering Agents',
  }),
  pubNode('statin', '他汀类调脂药', 'medication-class', 'lipid-lowering', {
    displayEn: 'HMG-CoA Reductase Inhibitors (Statins)',
  }),
  pubNode('ezetimibe', '胆固醇吸收抑制剂（依折麦布）', 'medication-class', 'lipid-lowering', {
    displayEn: 'Cholesterol Absorption Inhibitor (Ezetimibe)',
    synonyms: ['cholesterol-absorption-inhibitor'],
  }),
  pubNode('pcsk9-inhibitor', 'PCSK9 抑制剂', 'medication-class', 'lipid-lowering', {
    displayEn: 'PCSK9 Inhibitors',
  }),
  pubNode('fibrate', '贝特类调脂药', 'medication-class', 'lipid-lowering', {
    displayEn: 'Fibrates',
  }),
  pubNode('antidiabetic', '降糖药', 'medication-class', 'pharmacology-class', {
    displayEn: 'Antidiabetic Agents',
  }),
  pubNode('biguanide', '双胍类降糖药', 'medication-class', 'antidiabetic', {
    displayEn: 'Biguanides',
  }),
  pubNode('sglt2', 'SGLT2 抑制剂', 'medication-class', 'antidiabetic', {
    displayEn: 'SGLT2 Inhibitors',
  }),
  pubNode('dpp4', 'DPP-4 抑制剂', 'medication-class', 'antidiabetic', {
    displayEn: 'DPP-4 Inhibitors',
  }),
  pubNode('glp1', 'GLP-1 受体激动剂', 'medication-class', 'antidiabetic', {
    displayEn: 'GLP-1 Receptor Agonists',
  }),
  pubNode('insulin', '胰岛素类', 'medication-class', 'antidiabetic', {
    displayEn: 'Insulins',
  }),
  pubNode('cardiovascular-therapy', '心血管治疗药物', 'medication-class', 'pharmacology-class', {
    displayEn: 'Cardiovascular Therapy',
  }),
  pubNode('beta-blocker', 'β 受体阻滞剂', 'medication-class', 'cardiovascular-therapy', {
    displayEn: 'Beta Blockers',
  }),
  pubNode('acei', 'ACEI 血管紧张素转换酶抑制剂', 'medication-class', 'cardiovascular-therapy', {
    displayEn: 'ACE Inhibitors',
  }),
  pubNode('arb', 'ARB 血管紧张素受体拮抗剂', 'medication-class', 'cardiovascular-therapy', {
    displayEn: 'Angiotensin Receptor Blockers',
  }),
  pubNode('arni', 'ARNI 脑啡肽酶抑制剂', 'medication-class', 'cardiovascular-therapy', {
    displayEn: 'Angiotensin Receptor-Neprilysin Inhibitors',
  }),
  pubNode('ccb', '钙通道阻滞剂 (CCB)', 'medication-class', 'cardiovascular-therapy', {
    displayEn: 'Calcium Channel Blockers',
    synonyms: ['calcium-channel-blocker'],
  }),
  pubNode('mra', '盐皮质激素受体拮抗剂 (MRA)', 'medication-class', 'cardiovascular-therapy', {
    displayEn: 'Mineralocorticoid Receptor Antagonists',
  }),
  pubNode('nitrate', '硝酸酯类', 'medication-class', 'cardiovascular-therapy', {
    displayEn: 'Nitrates',
  }),
  pubNode('diuretic', '利尿剂', 'medication-class', 'cardiovascular-therapy', {
    displayEn: 'Diuretics',
  }),
  pubNode('loop-diuretic', '袢利尿剂', 'medication-class', 'diuretic', {
    displayEn: 'Loop Diuretics',
  }),
  pubNode('thiazide', '噻嗪类利尿剂', 'medication-class', 'diuretic', {
    displayEn: 'Thiazide Diuretics',
  }),
  pubNode('antibacterial', '抗菌药物', 'medication-class', 'pharmacology-class', {
    displayEn: 'Antibacterial Agents',
  }),
  pubNode('penicillin', '青霉素类', 'medication-class', 'antibacterial', {
    displayEn: 'Penicillins',
  }),
  pubNode('cephalosporin', '头孢菌素类', 'medication-class', 'antibacterial', {
    displayEn: 'Cephalosporins',
  }),
  pubNode('macrolide', '大环内酯类', 'medication-class', 'antibacterial', {
    displayEn: 'Macrolides',
  }),
  pubNode('fluoroquinolone', '氟喹诺酮类', 'medication-class', 'antibacterial', {
    displayEn: 'Fluoroquinolones',
  }),
  pubNode('tetracycline', '四环素类', 'medication-class', 'antibacterial', {
    displayEn: 'Tetracyclines',
  }),
  pubNode('aminoglycoside', '氨基糖苷类', 'medication-class', 'antibacterial', {
    displayEn: 'Aminoglycosides',
  }),
  pubNode('carbapenem', '碳青霉烯类', 'medication-class', 'antibacterial', {
    displayEn: 'Carbapenems',
  }),
  pubNode('contrast', '含碘对比剂', 'medication-class', 'pharmacology-class', {
    displayEn: 'Iodinated Contrast Media',
  }),
]

const PUBLIC_MAPPINGS: readonly ConceptMapping[] = [
  pubExactMapping('pub-map-mi-zh-short', 'clinmesh-zh-alias', '心梗', '心梗', 'myocardial-infarction'),
  pubExactMapping('pub-map-mi-zh-full', 'clinmesh-zh-alias', '心肌梗死', '心肌梗死', 'myocardial-infarction'),
  pubExactMapping('pub-map-cad-zh-short', 'clinmesh-zh-alias', '冠心病', '冠心病', 'coronary-artery-disease'),
  pubExactMapping('pub-map-cad-zh-full', 'clinmesh-zh-alias', '冠状动脉粥样硬化性心脏病', '冠状动脉粥样硬化性心脏病', 'coronary-artery-disease'),
  pubExactMapping('pub-map-icd-i25103', 'nhsa-icd10', 'I25.103', '冠状动脉粥样硬化性心脏病', 'coronary-artery-disease'),
  pubExactMapping('pub-map-icd-i251', 'nhsa-icd10', 'I25.1', '动脉粥样硬化性心脏病', 'coronary-artery-disease'),
  pubExactMapping('pub-map-icd-i214', 'nhsa-icd10', 'I21.4', '急性非ST段抬高型心肌梗死', 'nstemi'),
  pubExactMapping('pub-map-icd-i213', 'nhsa-icd10', 'I21.3', '急性透壁心肌梗死', 'stemi'),
  pubExactMapping('pub-map-icd-e11', 'nhsa-icd10', 'E11', '2型糖尿病', 'type-2-diabetes'),
  pubExactMapping('pub-map-icd-n18', 'nhsa-icd10', 'N18', '慢性肾脏病', 'chronic-kidney-disease'),
  pubExactMapping('pub-map-loinc-14682-9', 'http://loinc.org', '14682-9', '血清肌酐', '2160-0'),
  pubExactMapping('pub-map-cn-1700404A', 'urn:clinmesh:cn-local', '1700404A', '血清肌酐', '2160-0'),
  pubExactMapping('pub-map-loinc-49563-0', 'http://loinc.org', '49563-0', '高敏肌钙蛋白I', '89579-7'),
  pubExactMapping('pub-map-cn-2100404B', 'urn:clinmesh:cn-local', '2100404B', '高敏肌钙蛋白I', '89579-7'),
  pubExactMapping('pub-map-loinc-6598-7', 'http://loinc.org', '6598-7', '常规肌钙蛋白I', '10839-9'),
  pubExactMapping('pub-map-cn-2100404A', 'urn:clinmesh:cn-local', '2100404A', '常规肌钙蛋白I', '10839-9'),
  pubExactMapping('pub-map-loinc-67151-1', 'http://loinc.org', '67151-1', '肌钙蛋白T', '6597-9'),
  pubExactMapping('pub-map-loinc-42757-5', 'http://loinc.org', '42757-5', '肌钙蛋白T', '6597-9'),
  pubExactMapping('pub-map-cn-2100504A', 'urn:clinmesh:cn-local', '2100504A', '肌钙蛋白T', '6597-9'),
  pubExactMapping('pub-map-loinc-17856-6', 'http://loinc.org', '17856-6', '糖化血红蛋白', '4548-4'),
  pubExactMapping('pub-map-cn-1100301A', 'urn:clinmesh:cn-local', '1100301A', '糖化血红蛋白', '4548-4'),
  pubExactMapping('pub-map-cn-1700301A', 'urn:clinmesh:cn-local', '1700301A', '总胆固醇', '2093-3'),
  pubExactMapping('pub-map-cn-1700302A', 'urn:clinmesh:cn-local', '1700302A', 'HDL-C', '2085-9'),
  pubExactMapping('pub-map-loinc-18262-6', 'http://loinc.org', '18262-6', 'LDL-C', '13457-7'),
  pubExactMapping('pub-map-loinc-2089-1', 'http://loinc.org', '2089-1', 'LDL-C', '13457-7'),
  pubExactMapping('pub-map-cn-1700303A', 'urn:clinmesh:cn-local', '1700303A', 'LDL-C', '13457-7'),
  pubExactMapping('pub-map-cn-1700304A', 'urn:clinmesh:cn-local', '1700304A', '甘油三酯', '2571-8'),
  pubExactMapping('pub-map-pharm-ccb', 'urn:clinmesh:pharmacology', 'calcium-channel-blocker', '钙通道阻滞剂', 'ccb'),
  pubExactMapping('pub-map-pharm-ezetimibe', 'urn:clinmesh:pharmacology', 'cholesterol-absorption-inhibitor', '胆固醇吸收抑制剂', 'ezetimibe'),
]

export const PUBLIC_CONCEPT_VOCABULARY: ConceptVocabulary = conceptVocabularySchema.parse({
  mappings: PUBLIC_MAPPINGS,
  nodes: PUBLIC_NODES,
  version: SEED_VERSION,
})

function parseLayerOrThrow(raw: ConceptVocabulary, label: string): ConceptVocabulary {
  const parsed = conceptVocabularySchema.safeParse(raw)
  if (!parsed.success) {
    const summary = parsed.error.issues
      .slice(0, 5)
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')
    throw new ConceptVocabularyError('CONCEPT_VOCABULARY_INVALID', `${label} schema validation failed: ${summary}`)
  }
  return parsed.data
}

/** Return ancestor concept codes ordered from direct parent up to root. */
export function getConceptAncestors(code: string, vocab: ConceptVocabulary): string[] {
  const byCode = new Map(vocab.nodes.map(node => [node.code, node]))
  const start = byCode.get(code)
  if (start === undefined) return []
  const ancestors: string[] = []
  const visited = new Set<string>([code])
  let currentParent = start.parentCode
  while (currentParent !== null) {
    if (visited.has(currentParent)) break
    const parentNode = byCode.get(currentParent)
    if (parentNode === undefined) break
    visited.add(currentParent)
    ancestors.push(currentParent)
    currentParent = parentNode.parentCode
  }
  return ancestors
}

/** Return all descendant concept codes of `code` in breadth-first order. */
export function getConceptDescendants(code: string, vocab: ConceptVocabulary): string[] {
  const exists = vocab.nodes.some(node => node.code === code)
  if (!exists) return []
  const childrenByParent = new Map<string, string[]>()
  for (const node of vocab.nodes) {
    if (node.parentCode === null) continue
    const list = childrenByParent.get(node.parentCode) ?? []
    list.push(node.code)
    childrenByParent.set(node.parentCode, list)
  }
  const descendants: string[] = []
  const visited = new Set<string>([code])
  const queue: string[] = [code]
  while (queue.length > 0) {
    const current = queue.shift()!
    const children = childrenByParent.get(current) ?? []
    for (const child of children) {
      if (visited.has(child)) continue
      visited.add(child)
      descendants.push(child)
      queue.push(child)
    }
  }
  return descendants
}

/**
 * Merge public -> disease-pack -> hospital concept layers while enforcing strict
 * non-overwriting extension and hospital leaf-only constraints.
 */
export function mergeThreeLayerConceptVocabulary(input: {
  publicLayer?: ConceptVocabulary | undefined
  packLayer?: ConceptVocabulary | undefined
  hospitalLayer?: ConceptVocabulary | undefined
}): ConceptVocabulary {
  const publicLayer = parseLayerOrThrow(input.publicLayer ?? PUBLIC_CONCEPT_VOCABULARY, 'publicLayer')
  const packLayer = input.packLayer === undefined ? undefined : parseLayerOrThrow(input.packLayer, 'packLayer')
  const hospitalLayer = input.hospitalLayer === undefined ? undefined : parseLayerOrThrow(input.hospitalLayer, 'hospitalLayer')

  const mergedNodesByCode = new Map<string, ConceptNode>()
  const publicCodes = new Set<string>()
  const packCodes = new Set<string>()
  const hospitalCodes = new Set<string>()

  for (const node of publicLayer.nodes) {
    if (node.layer !== 'public') {
      throw new ConceptVocabularyError(
        'CONCEPT_VOCABULARY_INVALID',
        `publicLayer node ${node.code} must declare layer 'public', received '${node.layer}'`,
      )
    }
    if (mergedNodesByCode.has(node.code)) {
      throw new ConceptVocabularyError('CONCEPT_VOCABULARY_INVALID', `Duplicate public concept node code: ${node.code}`)
    }
    mergedNodesByCode.set(node.code, node)
    publicCodes.add(node.code)
  }

  if (packLayer !== undefined) {
    for (const node of packLayer.nodes) {
      if (node.layer !== 'disease-pack') {
        throw new ConceptVocabularyError(
          'CONCEPT_VOCABULARY_INVALID',
          `packLayer node ${node.code} must declare layer 'disease-pack', received '${node.layer}'`,
        )
      }
      if (publicCodes.has(node.code)) {
        throw new ConceptVocabularyError(
          'CONCEPT_VOCABULARY_INVALID',
          `packLayer cannot overwrite or redefine public concept node '${node.code}'`,
        )
      }
      if (packCodes.has(node.code)) {
        throw new ConceptVocabularyError('CONCEPT_VOCABULARY_INVALID', `Duplicate pack concept node code: ${node.code}`)
      }
      mergedNodesByCode.set(node.code, node)
      packCodes.add(node.code)
    }
  }

  if (hospitalLayer !== undefined) {
    for (const node of hospitalLayer.nodes) {
      if (node.layer !== 'hospital') {
        throw new ConceptVocabularyError(
          'CONCEPT_VOCABULARY_INVALID',
          `hospitalLayer node ${node.code} must declare layer 'hospital', received '${node.layer}'`,
        )
      }
      if (publicCodes.has(node.code) || packCodes.has(node.code)) {
        throw new ConceptVocabularyError(
          'CONCEPT_VOCABULARY_INVALID',
          `hospitalLayer cannot modify or overwrite existing public/pack concept node '${node.code}'`,
        )
      }
      if (hospitalCodes.has(node.code)) {
        throw new ConceptVocabularyError('CONCEPT_VOCABULARY_INVALID', `Duplicate hospital concept node code: ${node.code}`)
      }
      mergedNodesByCode.set(node.code, node)
      hospitalCodes.add(node.code)
    }
  }

  // Validate parentCode existence, layer direction, hospital leaf-only constraint, and acyclicity
  for (const node of mergedNodesByCode.values()) {
    if (node.parentCode === null) continue
    const parent = mergedNodesByCode.get(node.parentCode)
    if (parent === undefined) {
      throw new ConceptVocabularyError(
        'CONCEPT_VOCABULARY_INVALID',
        `Concept node '${node.code}' references missing parentCode '${node.parentCode}'`,
      )
    }
    if (hospitalCodes.has(parent.code)) {
      throw new ConceptVocabularyError(
        'CONCEPT_VOCABULARY_INVALID',
        `Hospital node '${parent.code}' must remain a leaf node and cannot be parentCode of '${node.code}'`,
      )
    }
    if (node.layer === 'public' && parent.layer !== 'public') {
      throw new ConceptVocabularyError(
        'CONCEPT_VOCABULARY_INVALID',
        `Public concept node '${node.code}' cannot point parentCode to non-public node '${parent.code}'`,
      )
    }
  }

  for (const node of mergedNodesByCode.values()) {
    const visited = new Set<string>([node.code])
    let cursor = node.parentCode
    while (cursor !== null) {
      if (visited.has(cursor)) {
        throw new ConceptVocabularyError(
          'CONCEPT_VOCABULARY_INVALID',
          `Concept hierarchy cycle detected involving node '${cursor}'`,
        )
      }
      visited.add(cursor)
      cursor = mergedNodesByCode.get(cursor)?.parentCode ?? null
    }
  }

  const mergedMappings: ConceptMapping[] = []
  const seenMappingIds = new Set<string>()
  for (const layerMappings of [publicLayer.mappings, packLayer?.mappings ?? [], hospitalLayer?.mappings ?? []]) {
    for (const mapping of layerMappings) {
      if (seenMappingIds.has(mapping.id)) {
        throw new ConceptVocabularyError('CONCEPT_VOCABULARY_INVALID', `Duplicate concept mapping id: ${mapping.id}`)
      }
      if (!mergedNodesByCode.has(mapping.targetConceptCode)) {
        throw new ConceptVocabularyError(
          'CONCEPT_VOCABULARY_INVALID',
          `Concept mapping '${mapping.id}' points to unknown targetConceptCode '${mapping.targetConceptCode}'`,
        )
      }
      seenMappingIds.add(mapping.id)
      mergedMappings.push(mapping)
    }
  }

  const version = [publicLayer.version, packLayer?.version, hospitalLayer?.version]
    .filter((part): part is string => part !== undefined)
    .join('+')

  return {
    mappings: mergedMappings,
    nodes: [...mergedNodesByCode.values()],
    version,
  }
}

function normalizeDateToken(rawDate: string | undefined): string | undefined {
  if (rawDate === undefined) return undefined
  const trimmed = rawDate.trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10)
  }
  return trimmed
}

/**
 * Evaluate AC9 eligibility of a SKOS concept mapping.
 * Only `approved` + `exact` mappings within `effectiveDate` participate in scoring or red-line gates.
 */
export function evaluateConceptMappingEligibility(
  mapping: ConceptMapping,
  options?: { asOfDate?: string },
): ConceptMappingEligibility {
  const asOfDate = normalizeDateToken(options?.asOfDate)
  const base = {
    effectiveDate: mapping.effectiveDate,
    mappingId: mapping.id,
    relation: mapping.relation,
    reviewStatus: mapping.reviewStatus,
    sourceCode: mapping.sourceCode,
    targetConceptCode: mapping.targetConceptCode,
  }

  if (asOfDate !== undefined && mapping.effectiveDate > asOfDate) {
    return {
      ...base,
      eligibleForScoreAndRedLine: false,
      explanationZh: `映射尚未生效（生效日期 ${mapping.effectiveDate} 晚于评估日期 ${asOfDate}），不可使用`,
      reasonCode: 'MAPPING_NOT_EFFECTIVE',
      usableForHint: false,
    }
  }

  if (mapping.reviewStatus === 'deprecated') {
    return {
      ...base,
      eligibleForScoreAndRedLine: false,
      explanationZh: '映射已废止（deprecated），不参与临床算分、红线拦截或提示',
      reasonCode: 'MAPPING_DEPRECATED',
      usableForHint: false,
    }
  }

  if (mapping.reviewStatus !== 'approved' || mapping.reviewerId === null || mapping.reviewerId.trim().length === 0) {
    return {
      ...base,
      eligibleForScoreAndRedLine: false,
      explanationZh: `映射状态为 ${mapping.reviewStatus}，未获临床审核批准（approved），不可参与算分、红线拦截或提示`,
      reasonCode: 'MAPPING_NOT_APPROVED',
      usableForHint: false,
    }
  }

  if (mapping.relation === 'exact') {
    return {
      ...base,
      eligibleForScoreAndRedLine: true,
      explanationZh: '已审核批准的完全等价映射（exact），可参与临床算分与红线拦截',
      reasonCode: 'ELIGIBLE_EXACT',
      usableForHint: true,
    }
  }

  if (mapping.relation === 'close') {
    return {
      ...base,
      eligibleForScoreAndRedLine: false,
      explanationZh: '仅作为相近映射提示，不参与临床算分与红线拦截',
      reasonCode: 'MAPPING_CLOSE_HINT_ONLY',
      usableForHint: true,
    }
  }

  if (mapping.relation === 'broader') {
    return {
      ...base,
      eligibleForScoreAndRedLine: false,
      explanationZh: '仅作为上位映射提示，不参与临床算分与红线拦截',
      reasonCode: 'MAPPING_BROADER_NOT_ELIGIBLE',
      usableForHint: true,
    }
  }

  return {
    ...base,
    eligibleForScoreAndRedLine: false,
    explanationZh: '仅作为下位映射提示，不参与临床算分与红线拦截',
    reasonCode: 'MAPPING_NARROWER_NOT_ELIGIBLE',
    usableForHint: true,
  }
}

/**
 * Resolve medication pharmacology class codes through the 3-layer concept vocabulary,
 * returning each matched canonical class and its pharmacology ancestors.
 */
export function resolvePharmacologyClassesFromVocabulary(
  codes: readonly string[],
  vocab: ConceptVocabulary = PUBLIC_CONCEPT_VOCABULARY,
): string[] {
  const medNodesByCode = new Map(
    vocab.nodes.filter(node => node.domain === 'medication-class').map(node => [node.code, node]),
  )
  const resolved = new Set<string>()

  for (const rawCode of codes) {
    const code = rawCode.trim()
    if (!code) continue

    let targetCode: string | undefined
    if (medNodesByCode.has(code)) {
      targetCode = code
    } else {
      const exactMapping = vocab.mappings.find(mapping => (
        mapping.sourceCode === code
        && medNodesByCode.has(mapping.targetConceptCode)
        && evaluateConceptMappingEligibility(mapping).eligibleForScoreAndRedLine
      ))
      if (exactMapping !== undefined) {
        targetCode = exactMapping.targetConceptCode
      }
    }

    if (targetCode === undefined) continue
    resolved.add(targetCode)
    for (const ancestor of getConceptAncestors(targetCode, vocab)) {
      if (medNodesByCode.has(ancestor)) {
        resolved.add(ancestor)
      }
    }
  }

  return [...resolved]
}

export interface ResolvedConceptLedgerMatch {
  readonly fact: ClinicalFact
  readonly matchKind: 'direct-concept' | 'descendant-concept' | 'mapped-concept'
  readonly matchedConceptCode: string
  readonly mapping?: ConceptMapping
  readonly eligibility?: ConceptMappingEligibility
}

export interface RejectedConceptLedgerMatch {
  readonly fact: ClinicalFact
  readonly mapping: ConceptMapping
  readonly eligibility: ConceptMappingEligibility
}

export interface ResolveLedgerFactsResult {
  readonly targetConceptCode: string
  readonly mode: 'scoring-or-redline' | 'hint'
  readonly asOfDate: string
  readonly matchedConceptCodes: string[]
  readonly facts: ClinicalFact[]
  readonly matches: ResolvedConceptLedgerMatch[]
  readonly hintOnlyMatches: RejectedConceptLedgerMatch[]
  readonly excludedMatches: RejectedConceptLedgerMatch[]
}

/**
 * Resolve facts from a ClinicalFactLedger for a target concept under explicit governance mode.
 * In `scoring-or-redline` mode, ONLY direct/descendant canonical concepts and approved+exact
 * mappings within effectiveDate are accepted; `close`/`broader`/`narrower`/unapproved facts are rejected.
 */
export function resolveLedgerFactsForConcept(input: {
  ledger: ClinicalFactLedger
  targetConceptCode: string
  vocabulary: ConceptVocabulary
  asOfDate?: string
  mode: 'scoring-or-redline' | 'hint'
}): ResolveLedgerFactsResult {
  const asOfDate = normalizeDateToken(input.asOfDate) ?? input.ledger.trace.evaluatedAsOf.slice(0, 10)
  const descendants = new Set(getConceptDescendants(input.targetConceptCode, input.vocabulary))
  const acceptedConceptTargets = new Set([input.targetConceptCode, ...descendants])

  const matches: ResolvedConceptLedgerMatch[] = []
  const hintOnlyMatches: RejectedConceptLedgerMatch[] = []
  const excludedMatches: RejectedConceptLedgerMatch[] = []

  for (const fact of input.ledger.facts) {
    if (fact.recordStatus === 'entered-in-error' || fact.presence === 'not-asked') continue

    const code = fact.itemCode.code
    if (acceptedConceptTargets.has(code)) {
      if (input.mode === 'scoring-or-redline' && !fact.eligibleForScoringAndRedLine) {
        continue
      }
      matches.push({
        fact,
        matchKind: code === input.targetConceptCode ? 'direct-concept' : 'descendant-concept',
        matchedConceptCode: code,
      })
      continue
    }

    const candidateMappings = input.vocabulary.mappings.filter(mapping => (
      mapping.sourceCode === code && acceptedConceptTargets.has(mapping.targetConceptCode)
    ))
    if (candidateMappings.length === 0) continue

    const evaluated = candidateMappings.map(mapping => ({
      eligibility: evaluateConceptMappingEligibility(mapping, { asOfDate }),
      mapping,
    }))

    const eligibleMatch = input.mode === 'scoring-or-redline'
      ? evaluated.find(entry => entry.eligibility.eligibleForScoreAndRedLine)
      : evaluated.find(entry => entry.eligibility.eligibleForScoreAndRedLine)
        ?? evaluated.find(entry => entry.eligibility.usableForHint)

    if (eligibleMatch !== undefined) {
      if (input.mode === 'scoring-or-redline' && !fact.eligibleForScoringAndRedLine) {
        continue
      }
      matches.push({
        eligibility: eligibleMatch.eligibility,
        fact,
        matchKind: 'mapped-concept',
        matchedConceptCode: eligibleMatch.mapping.targetConceptCode,
        mapping: eligibleMatch.mapping,
      })
      continue
    }

    const fallback = evaluated[0]!
    excludedMatches.push({
      eligibility: fallback.eligibility,
      fact,
      mapping: fallback.mapping,
    })
    if (input.mode === 'scoring-or-redline' && fallback.eligibility.usableForHint) {
      hintOnlyMatches.push({
        eligibility: fallback.eligibility,
        fact,
        mapping: fallback.mapping,
      })
    }
  }

  return {
    asOfDate,
    excludedMatches,
    facts: matches.map(item => item.fact),
    hintOnlyMatches,
    matchedConceptCodes: [...new Set(matches.map(item => item.matchedConceptCode))],
    matches,
    mode: input.mode,
    targetConceptCode: input.targetConceptCode,
  }
}

/**
 * Expand a search query using ONLY node displays/synonyms and approved `exact` mappings.
 * Never expands via unapproved (`proposed`, `reviewed`), `deprecated`, or non-exact (`close`, `broader`, `narrower`) mappings.
 */
export function expandSearchQueryWithApprovedSynonyms(
  query: string,
  vocabulary: ConceptVocabulary,
): string[] {
  const trimmed = query.trim()
  if (!trimmed) return []

  const lowerQuery = trimmed.toLowerCase()
  const approvedExactMappings = vocabulary.mappings.filter(mapping => (
    mapping.reviewStatus === 'approved' && mapping.relation === 'exact'
  ))

  const matchesTerm = (term: string): boolean => {
    const lowerTerm = term.trim().toLowerCase()
    if (!lowerTerm) return false
    if (lowerQuery === lowerTerm) return true
    if (lowerTerm.length >= 2 && lowerQuery.includes(lowerTerm)) return true
    return false
  }

  const matchedNodeCodes = new Set<string>()
  for (const node of vocabulary.nodes) {
    const nodeTerms = [
      node.code,
      node.displayZh,
      ...(node.displayEn === undefined ? [] : [node.displayEn]),
      ...node.synonyms,
    ]
    if (nodeTerms.some(matchesTerm)) {
      matchedNodeCodes.add(node.code)
    }
  }

  for (const mapping of approvedExactMappings) {
    if (matchesTerm(mapping.sourceCode) || matchesTerm(mapping.sourceDisplay)) {
      matchedNodeCodes.add(mapping.targetConceptCode)
    }
  }

  const expanded = new Set<string>([trimmed])
  const nodeByCode = new Map(vocabulary.nodes.map(node => [node.code, node]))

  for (const code of matchedNodeCodes) {
    const node = nodeByCode.get(code)
    if (node === undefined) continue
    expanded.add(node.code)
    expanded.add(node.displayZh)
    if (node.displayEn !== undefined) expanded.add(node.displayEn)
    for (const syn of node.synonyms) expanded.add(syn)
    for (const mapping of approvedExactMappings) {
      if (mapping.targetConceptCode === code) {
        expanded.add(mapping.sourceCode)
        expanded.add(mapping.sourceDisplay)
      }
    }
  }

  return [...expanded]
}
