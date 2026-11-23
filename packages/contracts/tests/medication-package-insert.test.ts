import { describe, expect, it } from 'vitest'
import {
  SYNTHETIC_PACKAGE_INSERT_DISCLAIMER,
  medicationPackageInsertSchema,
} from '@clinmesh/contracts/medication-safety'
import { clinicalCatalogSchema, issuedPrescriptionItemSchema } from '@clinmesh/contracts/his'
import { inpatientCatalogSearchSchema, inpatientFullCatalogSchema, inpatientOrderSchema } from '@clinmesh/contracts/inpatient-clinical'
import { getHisOperation } from '@clinmesh/contracts/his-operations'

const sampleInsert = {
  genericName: '苯磺酸氨氯地平片',
  specificationAndForm: '片剂 · 5 mg · 30片/盒',
  indicationsSummary: '适用于高血压及冠心病慢性稳定型或血管痉挛性心绞痛（ICD-10：I10、I11、I20、I25）。',
  dosageAndAdministration: '口服，常规起始与维持剂量每次 5 mg，每日一次（QD）；按疗效可调整至每次 2.5–10 mg，单日最大剂量 10 mg。',
  contraindications: '对二氢吡啶类钙通道阻滞剂或本品辅料过敏、严重低血压及心源性休克禁用。',
  precautions: '起始及加量期监测血压、心率与踝部水肿；重度肝功能不全者自低剂量起始缓慢滴定。',
  adverseReactions: '常见踝部及下肢水肿、面部潮红、头痛、头晕、心悸与乏力。',
  disclaimer: SYNTHETIC_PACKAGE_INSERT_DISCLAIMER,
} as const

describe('medicationPackageInsertSchema and read-only catalog contracts', () => {
  it('enforces the structured sections and exact synthetic educational disclaimer', () => {
    expect(medicationPackageInsertSchema.parse(sampleInsert)).toEqual(sampleInsert)
    expect(medicationPackageInsertSchema.safeParse({
      ...sampleInsert,
      disclaimer: '国药准字法定说明书',
    }).success).toBe(false)
    expect(medicationPackageInsertSchema.safeParse({
      ...sampleInsert,
      precautions: '   ',
    }).success).toBe(false)
    expect(medicationPackageInsertSchema.safeParse({
      ...sampleInsert,
      extraField: 'unexpected',
    }).success).toBe(false)
  })

  it('keeps packageInsert optional on outpatient and inpatient catalog DTOs without leaking into issued snapshots', () => {
    const baseOutpatientMedication = {
      id: 'medication-amlodipine',
      nameEn: 'Amlodipine tablets',
      nameZh: '苯磺酸氨氯地平片',
      priceFen: 1500,
      version: 1,
      allowedCombinationIds: [],
      allowedCourseDays: [30],
      allowedDoseTexts: ['5 mg'],
      allowedFrequencyCodes: ['QD'],
      allowedQuantities: [30],
      defaultCourseDays: 30,
      defaultDoseText: '5 mg',
      defaultFrequencyCode: 'QD',
      defaultQuantity: 30,
    }
    expect(clinicalCatalogSchema.safeParse({
      diagnoses: [],
      laboratory: [],
      medications: [baseOutpatientMedication, { ...baseOutpatientMedication, id: 'medication-amlodipine-2', packageInsert: sampleInsert }],
      prescriptionConclusionSupported: true,
    }).success).toBe(true)

    const baseInpatientMedication = {
      id: 'medication-amlodipine',
      display: '苯磺酸氨氯地平片',
      version: 1,
      priceFen: 1500,
      unit: '片',
      doses: [{ doseText: '5 mg', quantity: 1 }],
      frequencyCodes: ['QD'],
      lots: [],
    }
    expect(inpatientFullCatalogSchema.safeParse({
      diagnoses: [],
      medications: [baseInpatientMedication, { ...baseInpatientMedication, id: 'medication-amlodipine-2', packageInsert: sampleInsert }],
      services: [],
    }).success).toBe(true)
    expect(inpatientCatalogSearchSchema.safeParse({
      kind: 'medication',
      source: 'hospital',
      page: 1,
      pageSize: 20,
      total: 1,
      items: [{
        id: 'medication-amlodipine',
        display: '苯磺酸氨氯地平片',
        status: 'available',
        missingFields: [],
        catalogItemId: 'medication-amlodipine',
        catalogVersion: 1,
        medication: { ...baseInpatientMedication, packageInsert: sampleInsert },
      }],
    }).success).toBe(true)

    expect(issuedPrescriptionItemSchema.safeParse({
      catalogItemId: 'medication-amlodipine',
      courseDays: 30,
      display: '苯磺酸氨氯地平片',
      doseText: '5 mg',
      frequencyCode: 'QD',
      medicationRequestId: 'med-req-1',
      medicationRequestVersion: '1',
      quantity: 30,
      totalFen: 45000,
      unitPriceFen: 1500,
      packageInsert: sampleInsert,
    }).success).toBe(false)

    expect(inpatientOrderSchema.safeParse({
      id: 'order-1',
      admissionId: 'adm-1',
      kind: 'medication',
      duration: 'long',
      catalogItemId: 'medication-amlodipine',
      catalogVersion: 1,
      display: '苯磺酸氨氯地平片',
      doseText: '5 mg',
      doseQuantity: 1,
      unit: '片',
      frequencyCode: 'QD',
      state: 'signed',
      version: 1,
      requestVersion: '1',
      signedAt: '2026-11-20T09:00:00+08:00',
      signedBy: 'actor-doctor',
      organizationId: 'org-1',
      packageInsert: sampleInsert,
    }).success).toBe(false)
  })

  it('bumps catalog read operation versions for optional packageInsert projection', () => {
    expect(getHisOperation('catalog.clinical.read').version).toBe(3)
    expect(getHisOperation('inpatient.catalog.search').version).toBe(3)
    expect(getHisOperation('inpatient.clinical.catalog').version).toBe(4)
  })
})
