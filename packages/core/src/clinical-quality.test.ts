import { describe, expect, it } from 'vitest'
import {
  antibioticIndicationFindings,
  chestPainWorkupFindings,
  classDuplicationFindings,
  clinicalOverrideCovers,
  dischargeSecondaryPreventionFindings,
  doseLimitFindings,
  nonIschemicPciFindings,
  renalMedicationFindings,
} from './clinical-quality.ts'

const metformin = { catalogItemId: 'medication-metformin', display: '盐酸二甲双胍片', pharmacologyClasses: ['biguanide'] }
const dapagliflozin = { catalogItemId: 'medication-dapagliflozin', display: '达格列净片', pharmacologyClasses: ['sglt2'] }
const spironolactone = { catalogItemId: 'medication-spironolactone', display: '螺内酯片', pharmacologyClasses: ['mra'] }
const amoxicillin = { catalogItemId: 'medication-amoxicillin', display: '阿莫西林胶囊', pharmacologyClasses: ['penicillin'] }
const evidence = { label: 'eGFR', reference: 'Observation/scr-1', versionId: '1' }

describe('clinical quality rules', () => {
  it('blocks proven eGFR < 30 biguanide/SGLT2 but only warns when creatinine is missing', () => {
    const proven = renalMedicationFindings([metformin, dapagliflozin, spironolactone], { status: 'measured', egfr: 24.6, evidence: [evidence] })
    expect(proven.redLines.map(item => item.catalogItemId)).toEqual(['medication-metformin', 'medication-dapagliflozin'])
    expect(proven.redLines[0]).toMatchObject({ code: 'RENAL_CONTRAINDICATED_MEDICATION', tier: 'red-line', evidence: [evidence] })
    expect(proven.alerts).toEqual([])
    expect(renalMedicationFindings([metformin], { status: 'measured', egfr: 30, evidence: [evidence] })).toEqual({ redLines: [], alerts: [] })
    const missing = renalMedicationFindings([metformin, spironolactone, amoxicillin], { status: 'creatinine-missing' })
    expect(missing.redLines).toEqual([])
    expect(missing.alerts.map(item => [item.code, item.catalogItemId])).toEqual([
      ['RENAL_CREATININE_MISSING', 'medication-metformin'], ['RENAL_CREATININE_MISSING', 'medication-spironolactone']])
    expect(renalMedicationFindings([metformin], { status: 'not-computable' })).toEqual({ redLines: [], alerts: [] })
  })

  it('flags duplicated pharmacology classes against candidates and active orders', () => {
    const clopidogrel = { catalogItemId: 'medication-clopidogrel', display: '氯吡格雷', pharmacologyClasses: ['p2y12'] }
    const ticagrelor = { catalogItemId: 'medication-ticagrelor', display: '替格瑞洛', pharmacologyClasses: ['p2y12'] }
    const aspirin = { catalogItemId: 'medication-aspirin', display: '阿司匹林', pharmacologyClasses: ['antiplatelet-aspirin'] }
    expect(classDuplicationFindings([aspirin, clopidogrel])).toEqual([])
    expect(classDuplicationFindings([ticagrelor], [clopidogrel])).toEqual([expect.objectContaining({ code: 'MEDICATION_CLASS_DUPLICATION', catalogItemId: 'medication-ticagrelor' })])
    expect(classDuplicationFindings([aspirin, aspirin])).toHaveLength(1)
  })

  it('blocks single-dose and daily-dose limit violations via shared medication safety limits', () => {
    const limits = { unit: 'mg' as const, minimumSingleDose: 250, maximumSingleDose: 1000, maximumDailyDose: 2000 }
    expect(doseLimitFindings([{ ...metformin, doseLimits: limits, doseText: '500mg', frequencyCode: 'BID' }])).toEqual([])
    expect(doseLimitFindings([{ ...metformin, doseLimits: limits, doseText: '1500mg', frequencyCode: 'QD' }]))
      .toEqual([expect.objectContaining({ code: 'MEDICATION_DOSE_LIMIT_EXCEEDED', tier: 'red-line', catalogItemId: 'medication-metformin' })])
    expect(doseLimitFindings([{ ...metformin, doseLimits: limits, doseText: '1000mg', frequencyCode: 'TID' }]))
      .toEqual([expect.objectContaining({ code: 'MEDICATION_DOSE_LIMIT_EXCEEDED', tier: 'red-line', catalogItemId: 'medication-metformin' })])
  })

  it('warns about antibiotics only when every confirmed diagnosis is a simple viral infection', () => {
    expect(antibioticIndicationFindings([amoxicillin], ['J00.x00', 'J10.100'])).toEqual([expect.objectContaining({ code: 'ANTIBIOTIC_WITHOUT_BACTERIAL_INDICATION' })])
    expect(antibioticIndicationFindings([amoxicillin], ['J00.x00', 'J02.000'])).toEqual([])
    expect(antibioticIndicationFindings([metformin], ['J00.x00'])).toEqual([])
    expect(antibioticIndicationFindings([amoxicillin], [])).toEqual([])
  })

  it('requires ECG and troponin before completing an acute chest pain encounter', () => {
    const presentation = { label: '胸痛 2 小时', reference: 'Observation/triage' }
    expect(chestPainWorkupFindings({})).toEqual([])
    expect(chestPainWorkupFindings({ presentation })[0]?.message).toContain('12 导联心电图与心肌肌钙蛋白')
    expect(chestPainWorkupFindings({ presentation, ecg: { label: 'ECG', reference: 'DiagnosticReport/ecg' } })[0]?.message).toContain('心肌肌钙蛋白')
    expect(chestPainWorkupFindings({ presentation, ecg: { label: 'ECG', reference: 'DiagnosticReport/ecg' }, troponin: { label: 'cTn', reference: 'Observation/tn' } })).toEqual([])
  })

  it('flags PCI plans for non-ischemic intermediate lesions (FFR > 0.80) without any ischemic vessel', () => {
    const report = { label: '冠脉造影', reference: 'DiagnosticReport/angio' }
    expect(nonIschemicPciFindings([{ vessel: 'LAD', segment: '近段', stenosisPercent: 60, ffr: 0.86 }], report))
      .toEqual([expect.objectContaining({ code: 'PCI_NON_ISCHEMIC_LESION', evidence: [report] })])
    expect(nonIschemicPciFindings([{ vessel: 'LAD', segment: '近段', stenosisPercent: 60, ffr: 0.86 }, { vessel: 'RCA', segment: '中段', stenosisPercent: 75, ffr: 0.72 }], report)).toEqual([])
    expect(nonIschemicPciFindings([{ vessel: 'LAD', segment: '近段', stenosisPercent: 60, ffr: 0.86 }, { vessel: 'LCX', segment: '远段', stenosisPercent: 95 }], report)).toEqual([])
    expect(nonIschemicPciFindings([{ vessel: 'LAD', segment: '近段', stenosisPercent: 70 }], report)).toEqual([])
  })

  it('requires antiplatelet and statin long-term orders at CAD discharge', () => {
    const cad = { label: '冠心病', reference: 'Condition/cad' }
    expect(dischargeSecondaryPreventionFindings({ longTermClasses: [] })).toEqual([])
    expect(dischargeSecondaryPreventionFindings({ cad, longTermClasses: ['beta-blocker'] }).map(item => item.code)).toEqual(['DISCHARGE_ANTIPLATELET_MISSING', 'DISCHARGE_STATIN_MISSING'])
    expect(dischargeSecondaryPreventionFindings({ cad, longTermClasses: ['p2y12', 'statin'] })).toEqual([])
  })

  it('accepts an override only when it acknowledges every current alert', () => {
    const alerts = dischargeSecondaryPreventionFindings({ cad: { label: '冠心病', reference: 'Condition/cad' }, longTermClasses: [] })
    const override = { reasonCode: 'documented-contraindication' as const, note: '活动性消化道出血，暂停抗栓', acknowledgedAlerts: ['DISCHARGE_ANTIPLATELET_MISSING' as const] }
    expect(clinicalOverrideCovers(undefined, alerts)).toBe(false)
    expect(clinicalOverrideCovers(override, alerts)).toBe(false)
    expect(clinicalOverrideCovers({ ...override, acknowledgedAlerts: ['DISCHARGE_ANTIPLATELET_MISSING', 'DISCHARGE_STATIN_MISSING'] }, alerts)).toBe(true)
  })
})
