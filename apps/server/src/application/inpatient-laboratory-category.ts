import type { InpatientLaboratoryCategory } from '@clinmesh/contracts/his'

const hematologyCodes = new Set([
  'CN-LAB-CBC',
  'CN-LAB-CBC-5DIFF',
  'CN-LAB-COAGULATION',
  '6690-2',
  '718-7',
  '777-3',
  '6301-6',
])

const cardiacMetabolicCodes = new Set([
  'CN-LAB-CARDIAC',
  'CN-LAB-LIPIDS',
  'CN-LAB-FASTING-GLUCOSE',
  'CN-LAB-HBA1C',
  '1100301A',
  '1700104A',
  '1701204A',
])

const urinalysisInfectionCodes = new Set([
  'CN-LAB-URINALYSIS',
  'CN-LAB-INFLAMMATION',
  'CN-LAB-HBV-5',
  '1101405A',
  '1101504A',
])

const endocrineTumorCodes = new Set([
  'CN-LAB-THYROID',
  'CN-LAB-TUMOR-BASIC',
  '1102804A',
])

export function classifyInpatientLaboratoryCategory(input: {
  hasPciSupplement?: boolean | undefined
  localCode?: string | undefined
  referenceCode?: string | undefined
}): InpatientLaboratoryCategory {
  if (input.hasPciSupplement === true || input.localCode?.startsWith('PCI-LAB-') === true) {
    return 'preop-routine'
  }
  const code = input.referenceCode?.trim() ?? ''
  if (hematologyCodes.has(code) || code.startsWith('01') || code.startsWith('03') || code.startsWith('05')) {
    return 'hematology-coagulation'
  }
  if (cardiacMetabolicCodes.has(code) || code.startsWith('20') || code.startsWith('21')) {
    return 'cardiac-metabolic'
  }
  if (urinalysisInfectionCodes.has(code) || code.startsWith('06') || code.startsWith('24')) {
    return 'urinalysis-infection'
  }
  if (endocrineTumorCodes.has(code) || code.startsWith('12') || code.startsWith('16')) {
    return 'endocrine-tumor'
  }
  return 'biochemistry'
}
