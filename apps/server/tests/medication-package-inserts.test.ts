import { describe, expect, it } from 'vitest'
import {
  SYNTHETIC_PACKAGE_INSERT_DISCLAIMER,
  medicationPackageInsertSchema,
} from '@clinmesh/contracts/medication-safety'
import { createHospitalBaseline } from '../src/application/scenario-data/hospital-baseline.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import {
  syntheticNhcMedicalServiceSnapshot,
  syntheticWstValueSetSnapshot,
} from '../src/application/scenario-data/medical-service-snapshot.ts'
import { standardMedicationSafety } from '../src/application/scenario-data/standard-medications.ts'
import { standardMedicationPackageInsert } from '../src/application/scenario-data/medication-package-inserts.ts'
import { inpatientMedicationConfigSchema, inpatientMedicationMissingFields } from '../src/application/inpatient-medication-config.ts'

describe('synthetic medication package inserts and clinical rule alignment', () => {
  const baseline = createHospitalBaseline(
    syntheticNhsaMedicationProductSnapshot,
    syntheticNhcMedicalServiceSnapshot,
    syntheticWstValueSetSnapshot,
  )

  it('provides schema-valid synthetic package inserts for all 22 baseline medications plus PCI iohexol', () => {
    expect(baseline.catalog.medications).toHaveLength(22)
    for (const medication of baseline.catalog.medications) {
      expect(medication.packageInsert, medication.id).toBeDefined()
      const parsed = medicationPackageInsertSchema.parse(medication.packageInsert)
      expect(parsed.disclaimer).toBe(SYNTHETIC_PACKAGE_INSERT_DISCLAIMER)
      expect(parsed.genericName).toBe(medication.name)
      const safety = standardMedicationSafety(medication.id)!
      expect(safety, medication.id).toBeDefined()
      expect(parsed.dosageAndAdministration).toContain(String(safety.doseLimits.maximumDailyDose))
    }

    const iohexol = standardMedicationPackageInsert('medication-pci-iohexol')
    expect(iohexol).toBeDefined()
    const parsedIohexol = medicationPackageInsertSchema.parse(iohexol)
    expect(parsedIohexol.genericName).toBe('碘海醇注射液')
    expect(parsedIohexol.disclaimer).toBe(SYNTHETIC_PACKAGE_INSERT_DISCLAIMER)
    expect(parsedIohexol.dosageAndAdministration).toContain('400')
    expect(parsedIohexol.precautions).toContain('血肌酐')
  })

  it('aligns contraindications and precautions with pharmacology exclusions, quality gates, and order-set thresholds', () => {
    const metformin = standardMedicationPackageInsert('medication-metformin')!
    expect(metformin.contraindications).toContain('eGFR < 30')
    expect(metformin.precautions).toContain('血肌酐')

    const dapagliflozin = standardMedicationPackageInsert('medication-dapagliflozin')!
    expect(dapagliflozin.contraindications).toContain('eGFR < 30')
    expect(dapagliflozin.precautions).toContain('血肌酐')

    const spironolactone = standardMedicationPackageInsert('medication-spironolactone')!
    expect(spironolactone.contraindications).toContain('高钾血症')
    expect(spironolactone.precautions).toContain('血肌酐')

    const amoxicillin = standardMedicationPackageInsert('medication-amoxicillin')!
    expect(amoxicillin.contraindications).toContain('青霉素')
    expect(amoxicillin.precautions).toContain('病毒')

    const metoprolol = standardMedicationPackageInsert('medication-metoprolol')!
    expect(metoprolol.contraindications).toContain('50')
    expect(metoprolol.contraindications).toContain('90')
    expect(metoprolol.precautions).toContain('60')
    expect(metoprolol.precautions).toContain('100')

    const perindopril = standardMedicationPackageInsert('medication-perindopril')!
    expect(perindopril.contraindications).toContain('ARB')
    expect(perindopril.contraindications).toContain('ARNI')
    expect(perindopril.precautions).toContain('eGFR')
    expect(perindopril.precautions).toContain('血钾')

    const valsartan = standardMedicationPackageInsert('medication-valsartan')!
    expect(valsartan.contraindications).toContain('ACEI')
    expect(valsartan.contraindications).toContain('ARNI')

    const arni = standardMedicationPackageInsert('medication-sacubitril-valsartan')!
    expect(arni.contraindications).toContain('ACEI')
    expect(arni.contraindications).toContain('36')

    const clopidogrel = standardMedicationPackageInsert('medication-pci-clopidogrel')!
    expect(clopidogrel.contraindications).toContain('P2Y12')
    const ticagrelor = standardMedicationPackageInsert('medication-ticagrelor')!
    expect(ticagrelor.contraindications).toContain('P2Y12')

    const atorvastatin = standardMedicationPackageInsert('medication-pci-atorvastatin')!
    expect(atorvastatin.contraindications).toContain('他汀')
    const rosuvastatin = standardMedicationPackageInsert('medication-rosuvastatin')!
    expect(rosuvastatin.contraindications).toContain('他汀')

    const nitroglycerin = standardMedicationPackageInsert('medication-nitroglycerin')!
    expect(nitroglycerin.dosageAndAdministration).toContain('舌下含服')
    expect(nitroglycerin.dosageAndAdministration).toContain('必要时（PRN）')
    expect(nitroglycerin.contraindications).toContain('90')

    const saline = standardMedicationPackageInsert('medication-sodium-chloride')!
    expect(saline.dosageAndAdministration).toContain('1 mL/kg/h')
    expect(saline.precautions).toContain('0.5 mL/kg/h')
  })

  it('never treats missing or malformed packageInsert as an inpatient catalog missing field or parse error', () => {
    const baseConfig = {
      availableScopes: ['outpatient', 'inpatient'],
      unit: '片',
      product: {
        id: 'prod-1',
        system: 'urn:clinmesh:reference:nhsa-medication-product',
        version: '1',
        strength: '5 mg',
        dosageForm: '片剂',
        packageDescription: '30片/盒',
      },
      inpatientDoses: [{ doseText: '5 mg', quantity: 1 }],
      inpatientDoseBasis: { amount: 5, unit: 'mg' },
      inpatientMaxDoseQuantity: 2,
      allowedFrequencyCodes: ['QD'],
      allowedCombinationIds: [],
      inpatientBillingTrigger: 'dispense',
      safety: standardMedicationSafety('medication-amlodipine'),
    }
    expect(inpatientMedicationMissingFields(baseConfig, 1500)).toEqual([])
    for (const invalidInsert of [null, { genericName: '' }, 'invalid']) {
      const malformed = { ...baseConfig, packageInsert: invalidInsert }
      expect(inpatientMedicationMissingFields(malformed, 1500)).toEqual([])
      expect(inpatientMedicationConfigSchema.parse(malformed).packageInsert).toBeUndefined()
    }
  })
})
