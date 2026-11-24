import { describe, expect, it } from 'vitest'
import type { InpatientBaseStockMedication, InpatientProcedureNursingBinding } from '@clinmesh/contracts/inpatient-surgery'
import {
  DEFAULT_INTRAOPERATIVE_MEDICATION_NOTE,
  buildSurgicalMedicationPackages,
  linkedNursingForProcedureId,
  packagesForProcedureCode,
  validateSurgicalMedicationSelection,
} from '../src/inpatient-surgery-medications.ts'

const sampleMedications: readonly InpatientBaseStockMedication[] = [
  {
    id: 'medication-pci-heparin',
    version: 1,
    code: 'HEPARIN',
    display: '肝素钠注射液',
    unit: 'mL',
    priceFen: 200,
    strength: '2 mL:12500 IU',
    packageDescription: '2 mL/支',
    defaultRouteCode: 'IV',
    allowedRouteCodes: ['IV', 'IVGTT', 'IH'],
    doses: [{ doseText: '1 mL', quantity: 1 }],
    doseBasis: { amount: 6250, unit: 'IU' },
    maxDoseQuantity: 2,
    safety: {
      maximumDailyQuantity: 8,
      pharmacologyClasses: ['heparin'],
      indicationPrefixes: ['I20', 'I21', 'I25'],
      doseLimits: { unit: 'mL', minimumSingleDose: 1, maximumSingleDose: 2, maximumDailyDose: 8 },
    },
  },
  {
    id: 'medication-surgical-lidocaine',
    version: 1,
    code: 'CM-SURG-LIDOCAINE',
    display: '盐酸利多卡因注射液',
    unit: 'mL',
    priceFen: 120,
    strength: '5 mL:100 mg',
    packageDescription: '5 mL/支',
    defaultRouteCode: 'IH',
    allowedRouteCodes: ['IH', 'IM', 'IV'],
    doses: [{ doseText: '5 mL', quantity: 5 }, { doseText: '100 mg', quantity: 5 }],
    doseBasis: { amount: 20, unit: 'mg' },
    maxDoseQuantity: 15,
    safety: {
      maximumDailyQuantity: 30,
      pharmacologyClasses: ['local-anesthetic'],
      indicationPrefixes: ['I', 'K', 'Z'],
      doseLimits: { unit: 'mg', minimumSingleDose: 20, maximumSingleDose: 300, maximumDailyDose: 600 },
    },
  },
  {
    id: 'medication-nitroglycerin',
    version: 1,
    code: 'NITROGLYCERIN',
    display: '硝酸甘油片',
    unit: '片',
    priceFen: 30,
    strength: '0.5 mg',
    packageDescription: '100片/瓶',
    defaultRouteCode: 'SL',
    allowedRouteCodes: ['SL', 'PO'],
    doses: [{ doseText: '0.5 mg', quantity: 1 }],
    doseBasis: { amount: 0.5, unit: 'mg' },
    maxDoseQuantity: 2,
    safety: {
      maximumDailyQuantity: 8,
      pharmacologyClasses: ['nitrate'],
      indicationPrefixes: ['I20', 'I21', 'I25'],
      doseLimits: { unit: 'mg', minimumSingleDose: 0.5, maximumSingleDose: 1, maximumDailyDose: 4 },
    },
  },
]

describe('inpatient surgical base-stock medication pure rules', () => {
  it('builds procedure-scoped packages and marks uninstalled items explicitly without dropping installed items', () => {
    const withoutIohexol = buildSurgicalMedicationPackages(sampleMedications)
    const cathPackages = packagesForProcedureCode(withoutIohexol, '88.5500')
    expect(cathPackages.map(pkg => pkg.id)).toEqual([
      'catheterization-contrast-anticoagulation',
      'catheterization-local-anesthesia-vasodilator',
    ])
    const contrastPkg = cathPackages[0]!
    expect(contrastPkg.items).toEqual([
      expect.objectContaining({
        medicationId: 'medication-pci-iohexol',
        available: false,
        catalogVersion: null,
        priceFen: null,
        unavailableReason: 'not-installed',
      }),
      expect.objectContaining({
        medicationId: 'medication-pci-heparin',
        available: true,
        catalogVersion: 1,
        priceFen: 200,
        quantity: 1,
        routeCode: 'IV',
      }),
    ])

    const iohexol: InpatientBaseStockMedication = {
      id: 'medication-pci-iohexol',
      version: 2,
      code: 'XV08ABD107B002010100014',
      display: '碘海醇注射液',
      unit: 'mL',
      priceFen: 150,
      strength: '100mL:35g(I)',
      packageDescription: '100mL/瓶',
      defaultRouteCode: 'IV',
      allowedRouteCodes: ['IV', 'IVGTT'],
      doses: [{ doseText: '50 mL', quantity: 50 }],
      doseBasis: { amount: 1, unit: 'mL' },
      maxDoseQuantity: 100,
      safety: {
        maximumDailyQuantity: 400,
        pharmacologyClasses: ['contrast'],
        indicationPrefixes: ['I20', 'I21', 'I25'],
        doseLimits: { unit: 'mL', minimumSingleDose: 1, maximumSingleDose: 100, maximumDailyDose: 400 },
      },
    }
    const withIohexol = buildSurgicalMedicationPackages([...sampleMedications, iohexol])
    expect(packagesForProcedureCode(withIohexol, '36.0700')[0]?.items[0]).toMatchObject({
      medicationId: 'medication-pci-iohexol',
      available: true,
      catalogVersion: 2,
      priceFen: 150,
      quantity: 50,
      routeCode: 'IV',
    })
    expect(packagesForProcedureCode(withIohexol, '51.2300').map(pkg => pkg.id)).toEqual([
      'general-surgery-perioperative-fluid',
    ])
  })

  it('validates controlled route, integer preparation conversion, and single-dose limits', () => {
    const lidocaine = sampleMedications.find(item => item.id === 'medication-surgical-lidocaine')!
    const heparin = sampleMedications.find(item => item.id === 'medication-pci-heparin')!

    expect(validateSurgicalMedicationSelection(lidocaine, {
      medicationId: lidocaine.id,
      catalogVersion: 1,
      doseText: '100 mg',
      quantity: 5,
      routeCode: 'IH',
    })).toEqual({ ok: true, quantity: 5 })

    expect(validateSurgicalMedicationSelection(heparin, {
      medicationId: heparin.id,
      catalogVersion: 1,
      doseText: '6250 IU',
      quantity: 1,
      routeCode: 'IV',
    })).toEqual({ ok: true, quantity: 1 })

    expect(validateSurgicalMedicationSelection(lidocaine, {
      medicationId: lidocaine.id,
      catalogVersion: 1,
      doseText: '100 mg',
      quantity: 5,
      routeCode: 'PO',
    })).toEqual({ ok: false, reason: 'MEDICATION_ROUTE_NOT_ALLOWED' })

    expect(validateSurgicalMedicationSelection(lidocaine, {
      medicationId: lidocaine.id,
      catalogVersion: 1,
      doseText: '30 mg',
      quantity: 2,
      routeCode: 'IH',
    })).toEqual({ ok: false, reason: 'MEDICATION_DOSAGE_NOT_ALLOWED' })

    expect(validateSurgicalMedicationSelection(lidocaine, {
      medicationId: lidocaine.id,
      catalogVersion: 1,
      doseText: '400 mg',
      quantity: 20,
      routeCode: 'IH',
    })).toEqual({ ok: false, reason: 'MEDICATION_DOSAGE_NOT_ALLOWED' })

    expect(DEFAULT_INTRAOPERATIVE_MEDICATION_NOTE).toBe('按本台手术台内基数用药登记')
  })

  it('resolves linked intraoperative nursing bindings only for configured procedures', () => {
    const bindings: readonly InpatientProcedureNursingBinding[] = [
      {
        serviceId: 'hospital-service-intraoperative-interventional-nursing',
        serviceVersion: 1,
        display: '术中介入专科护理',
        unit: '次',
        priceFen: 8000,
        procedureIds: ['hospital-surgery-3', 'hospital-surgery-7'],
      },
    ]
    expect(linkedNursingForProcedureId(bindings, 'hospital-surgery-3')).toMatchObject({
      serviceId: 'hospital-service-intraoperative-interventional-nursing',
      priceFen: 8000,
    })
    expect(linkedNursingForProcedureId(bindings, 'hospital-surgery-4')).toBeUndefined()
  })
})
