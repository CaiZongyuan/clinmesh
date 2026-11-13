import type { ScenarioProductMedicationCatalogItem } from '@clinmesh/contracts/scenario'
import type { MedicationSafetyRule } from '@clinmesh/contracts/medication-safety'
import { medicationCombinationConflict } from '@clinmesh/core/medication-safety'
import { canonicalJsonHash } from './canonical-json.ts'
import { pciDataPackage } from './pci-data.ts'

// 名称、剂量与价格是固定合成目录规则，不能当作临床处方建议。
const definitions = [
  ['aspirin', '阿司匹林肠溶片', 'antiplatelet-aspirin', 'I20,I21,I22,I25,Z95', 100, 50, 300, 300, 'QD', 50],
  ['clopidogrel', '硫酸氢氯吡格雷片', 'p2y12', 'I20,I21,I22,I25,Z95', 75, 75, 300, 300, 'QD', 80],
  ['ticagrelor', '替格瑞洛片', 'p2y12', 'I20,I21,I22,I25,Z95', 90, 60, 180, 180, 'BID', 150],
  ['atorvastatin', '阿托伐他汀钙片', 'statin', 'I20,I21,I22,I25,E78,Z95', 20, 10, 80, 80, 'QN', 70],
  ['rosuvastatin', '瑞舒伐他汀钙片', 'statin', 'I20,I21,I22,I25,E78,Z95', 10, 5, 20, 20, 'QN', 100],
  ['ezetimibe', '依折麦布片', 'ezetimibe', 'E78,I20,I21,I25', 10, 10, 10, 10, 'QD', 100],
  ['perindopril', '培哚普利片', 'acei', 'I10,I11,I12,I13,I25,I50', 4, 2, 8, 8, 'QD', 80],
  ['valsartan', '缬沙坦胶囊', 'arb', 'I10,I11,I12,I13,I50', 80, 40, 160, 320, 'QD', 80],
  ['sacubitril-valsartan', '沙库巴曲缬沙坦钠片', 'arni', 'I50', 50, 25, 200, 400, 'BID', 200],
  ['metoprolol', '琥珀酸美托洛尔缓释片', 'beta-blocker', 'I10,I20,I21,I25,I47,I48,I50', 47.5, 23.75, 190, 190, 'QD', 80],
  ['nitroglycerin', '硝酸甘油片', 'nitrate', 'I20,I21,I25', 0.5, 0.5, 1, 4, 'PRN', 30],
  ['heparin', '肝素钠注射液', 'heparin', 'I20,I21,I25,I26,I80,I82', 1, 1, 2, 8, 'PRN', 200],
  ['enoxaparin', '依诺肝素钠注射液', 'heparin', 'I20,I21,I25,I26,I80,I82', 40, 20, 100, 200, 'BID', 300],
  ['sodium-chloride', '0.9%氯化钠注射液', 'fluid', 'E86,I20,I21,I25,N18,Z', 500, 100, 1000, 3000, 'QD', 100],
  ['furosemide', '呋塞米片', 'loop-diuretic', 'I50,I11,N18,R60', 20, 20, 80, 240, 'QD', 30],
  ['spironolactone', '螺内酯片', 'mra', 'I50,I10,I11,R60', 20, 20, 100, 200, 'QD', 30],
  ['dapagliflozin', '达格列净片', 'sglt2', 'E11,I50,N18', 10, 5, 10, 10, 'QD', 200],
  ['oseltamivir', '磷酸奥司他韦胶囊', 'antiviral', 'J09,J10,J11', 75, 30, 150, 300, 'BID', 760],
  ['amoxicillin', '阿莫西林胶囊', 'penicillin', 'J00,J01,J02,J03,J06,J13,J18,J20,N30,N39', 500, 250, 1000, 3000, 'TID', 50],
] as const

const legacyRules: Record<string, { classes: string[]; prefixes: string[]; basis: number; minimum: number; single: number; daily: number }> = {
  'medication-acetaminophen': { classes: ['analgesic'], prefixes: ['R50', 'R51', 'R52', 'J'], basis: 500, minimum: 250, single: 1000, daily: 4000 },
  'medication-metformin': { classes: ['biguanide'], prefixes: ['E11'], basis: 500, minimum: 250, single: 1000, daily: 3000 },
  'medication-amlodipine': { classes: ['calcium-channel-blocker'], prefixes: ['I10', 'I11', 'I20', 'I25'], basis: 5, minimum: 2.5, single: 10, daily: 10 },
}

export function standardMedicationSafety(id: string): MedicationSafetyRule | undefined {
  if (id === 'medication-pci-iohexol') return { maximumDailyQuantity: 400, pharmacologyClasses: ['contrast'], indicationPrefixes: ['I20', 'I21', 'I25'], doseLimits: { unit: 'mL', minimumSingleDose: 1, maximumSingleDose: 100, maximumDailyDose: 400 } }
  const legacy = legacyRules[id]
  if (legacy) return { maximumDailyQuantity: legacy.daily / legacy.basis, pharmacologyClasses: legacy.classes, indicationPrefixes: legacy.prefixes,
    doseLimits: { unit: 'mg', minimumSingleDose: legacy.minimum, maximumSingleDose: legacy.single, maximumDailyDose: legacy.daily } }
  const definition = definitions.find(([suffix]) => id === `medication-${suffix}` || id === `medication-pci-${suffix}`)
  if (!definition) return undefined
  const [suffix, , pharmacology, indications, , minimum, single, daily] = definition
  const pci = pciDataPackage.medications.find(item => item.id === id)
  const basisAmount = suffix === 'heparin' ? 1 : pci?.hospitalSupplement.doseBasis.amount ?? definition[4]
  return { maximumDailyQuantity: daily / basisAmount, pharmacologyClasses: [pharmacology], indicationPrefixes: indications.split(','), doseLimits: {
    unit: suffix === 'sodium-chloride' || suffix === 'heparin' ? 'mL' : 'mg', minimumSingleDose: minimum, maximumSingleDose: single, maximumDailyDose: daily } }
}

export function standardMedicationDoseBasis(id: string) {
  const legacy = legacyRules[id]
  if (legacy) return { amount: legacy.basis, unit: 'mg' }
  const definition = definitions.find(([suffix]) => id === `medication-${suffix}` || id === `medication-pci-${suffix}`)
  if (!definition) return undefined
  const pci = pciDataPackage.medications.find(item => item.id === id)
  return pci?.hospitalSupplement.doseBasis ?? { amount: definition[4], unit: standardMedicationSafety(id)!.doseLimits.unit }
}

export function standardMedicationCatalog(): ScenarioProductMedicationCatalogItem[] {
  return definitions.map(([suffix, name, category, indications, dose, , , , frequency, priceFen]) => {
    const pci = pciDataPackage.medications.find(item => item.id === `medication-pci-${suffix}`)
    const id = pci?.id ?? `medication-${suffix}`
    const unit = suffix === 'sodium-chloride' ? '瓶' : suffix === 'heparin' ? 'mL' : suffix === 'enoxaparin' ? '支'
      : ['valsartan', 'oseltamivir', 'amoxicillin'].includes(suffix) ? '粒' : '片'
    const oral = unit === '片' || unit === '粒'
    const basis = standardMedicationDoseBasis(id)!, safety = standardMedicationSafety(id)!, doseText = `${dose} ${safety.doseLimits.unit}`
    const product = pci?.product ?? { id: `synthetic-medication-product-${suffix}`, code: `CM-NHSA-PRODUCT-${suffix.toUpperCase()}`,
      version: 'clinmesh-synthetic-medications-2026-11-13', system: 'urn:clinmesh:reference:nhsa-medication-product' as const,
      approvalNumber: `CM-SYNTHETIC-${suffix.toUpperCase()}`, brandName: null, dosageForm: unit === '片' ? '片剂' : unit === '粒' ? '胶囊剂' : '注射剂', genericName: name,
      manufacturer: '仁和仿真制药厂', packageDescription: `合成单${unit}品规`, strength: `${basis.amount} ${basis.unit}` }
    const { sourceLocator: _locator, status: _status, ...snapshot } = { ...product, sourceLocator: '', status: 'active' }
    return { id, code: suffix.toUpperCase(), name, priceFen, active: true, status: 'active' as const, organizationId: 'hospital-synthetic-renhe',
      availableScopes: ['outpatient', 'inpatient'], category, defaultDose: doseText, defaultFrequency: frequency, defaultRoute: pci?.hospitalSupplement.route ?? (oral ? '口服' : '注射'),
      dosageForm: snapshot.dosageForm, unit, restriction: '固定合成药事规则，仅用于仿真。', product: { ...snapshot, system: 'urn:clinmesh:reference:nhsa-medication-product' },
      drugConcept: { code: `CM-DRUG-${suffix.toUpperCase()}`, conceptId: `drug-concept-${suffix}`, display: name, kind: 'drug-concept' as const,
        system: 'urn:clinmesh:reference:drug-concept' as const, version: 'clinmesh-synthetic-medications-2026-11-13' },
      regulatoryVerification: { evidenceUrl: 'https://www.nmpa.gov.cn/datasearch/home-index.html', result: 'synthetic-match' as const,
        source: 'nmpa-manual-check' as const, verifiedAt: '2026-11-13T00:00:00+08:00', verifiedFieldsHash: canonicalJsonHash({ approvalNumber: snapshot.approvalNumber, genericName: snapshot.genericName, manufacturer: snapshot.manufacturer }) },
      workflow: { allowedCombinationIds: [], allowedCourseDays: Array.from({ length: 30 }, (_, i) => i + 1), allowedDiagnosisCodes: indications.split(','),
        allowedDoseTexts: [doseText], allowedFrequencyCodes: ['QD', 'BID', 'TID', 'QN', 'PRN', 'ONCE'], allowedQuantities: [1],
        defaultCourseDays: 1, defaultQuantity: 1, safety } }
  })
}

export function enableStandardMedicationRules(medications: ScenarioProductMedicationCatalogItem[]): ScenarioProductMedicationCatalogItem[] {
  return medications.map(medication => {
    const safety = standardMedicationSafety(medication.id)
    if (!safety) return medication
    return { ...medication, availableScopes: ['outpatient', 'inpatient'], workflow: { ...medication.workflow, safety,
      allowedCourseDays: Array.from({ length: 30 }, (_, i) => i + 1), allowedQuantities: medication.workflow.allowedQuantities,
      allowedFrequencyCodes: ['QD', 'BID', 'TID', 'QN', 'PRN', 'ONCE'],
      allowedCombinationIds: medications.filter(other => other.id !== medication.id && !medicationCombinationConflict(safety.pharmacologyClasses, standardMedicationSafety(other.id)?.pharmacologyClasses ?? [])).map(other => other.id) } }
  })
}
