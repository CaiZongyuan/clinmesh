import { describe, expect, it } from 'vitest'
import { medicationRouteCodes, medicationRouteSchema } from '@clinmesh/contracts/medication-safety'
import {
  referenceMedicationCatalogItemSchema,
  referenceMedicationCatalogSearchSchema,
  referenceMedicationProductSchema,
} from '@clinmesh/contracts/reference-data'
import {
  clinicalCatalogSchema,
  issuedPrescriptionItemSchema,
  pharmacyQueueSchema,
  prescriptionConflictReasonSchema,
  prescriptionDraftItemSchema,
  savePrescriptionDraftRequestSchema,
} from '@clinmesh/contracts/his'
import {
  inpatientFullCatalogSchema,
  inpatientOrderIssueInputSchema,
  inpatientOrderSchema,
  inpatientPharmacySchema,
} from '@clinmesh/contracts/inpatient-clinical'
import { orderSetDraftBundleSchema, orderSetTemplateSchema } from '@clinmesh/contracts/order-set-templates'
import {
  doctorPreparationSelectionSchema,
  doctorRecommendationSuggestionSchema,
} from '@clinmesh/contracts/doctor-recommendations'
import { doctorInpatientHistoryRecordSchema } from '../src/doctor-history.ts'
import { getHisOperation } from '@clinmesh/contracts/his-operations'

describe('MedicationRoute contracts and operation catalog versions', () => {
  it('defines the eight controlled medication routes and rejects unknown route codes', () => {
    expect(medicationRouteCodes).toEqual(['PO', 'IVGTT', 'IV', 'IM', 'IH', 'SL', 'TOP', 'INH'])
    for (const code of medicationRouteCodes) {
      expect(medicationRouteSchema.parse(code)).toBe(code)
    }
    expect(medicationRouteSchema.safeParse('ORAL').success).toBe(false)
    expect(prescriptionConflictReasonSchema.parse('PRESCRIPTION_ROUTE_NOT_ALLOWED')).toBe('PRESCRIPTION_ROUTE_NOT_ALLOWED')
  })

  it('keeps referenceMedicationProductSchema hash-row clean while requiring derived route metadata on catalog search items', () => {
    const rawProduct = {
      id: 'nhsa-med-1',
      system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/nhsa-medication-product',
      version: '2026-09',
      code: 'X001',
      genericName: '硝酸甘油片',
      brandName: null,
      dosageForm: '片剂',
      strength: '0.5mg',
      packageDescription: '100片/瓶',
      manufacturer: '合成制药厂',
      approvalNumber: '国药准字H00000001',
      status: 'active' as const,
      sourceLocator: 'nhsa:1',
    }
    expect(referenceMedicationProductSchema.parse(rawProduct)).toEqual(rawProduct)
    expect(referenceMedicationProductSchema.safeParse({ ...rawProduct, defaultRouteCode: 'SL' }).success).toBe(false)

    const catalogItem = { ...rawProduct, defaultRouteCode: 'SL' as const, allowedRouteCodes: ['SL' as const, 'PO' as const] }
    expect(referenceMedicationCatalogItemSchema.parse(catalogItem)).toEqual(catalogItem)
    expect(referenceMedicationCatalogItemSchema.safeParse({ ...rawProduct, defaultRouteCode: 'IV', allowedRouteCodes: ['SL'] }).success).toBe(false)
    expect(referenceMedicationCatalogSearchSchema.safeParse({
      items: [catalogItem],
      page: 1,
      pageSize: 20,
      releaseId: 'rel-1',
      total: 1,
    }).success).toBe(true)
  })

  it('enforces routeCode across outpatient catalog, draft, issued prescription, pharmacy queue, and revisit/prescription agent tools', () => {
    expect(clinicalCatalogSchema.safeParse({
      diagnoses: [],
      laboratory: [],
      medications: [{
        id: 'medication-nitroglycerin',
        nameEn: 'Nitroglycerin tablets',
        nameZh: '硝酸甘油片',
        priceFen: 30,
        version: 1,
        allowedCombinationIds: [],
        allowedCourseDays: [1, 7],
        allowedDoseTexts: ['0.5 mg'],
        allowedFrequencyCodes: ['PRN'],
        allowedQuantities: [1, 10],
        allowedRouteCodes: ['SL', 'PO'],
        defaultCourseDays: 1,
        defaultDoseText: '0.5 mg',
        defaultFrequencyCode: 'PRN',
        defaultQuantity: 10,
        defaultRouteCode: 'SL',
      }],
      prescriptionConclusionSupported: true,
    }).success).toBe(true)

    const draftItem = {
      catalogItemId: 'medication-nitroglycerin',
      courseDays: 1,
      doseText: '0.5 mg',
      frequencyCode: 'PRN',
      quantity: 10,
      routeCode: 'SL' as const,
    }
    expect(prescriptionDraftItemSchema.parse(draftItem)).toEqual(draftItem)
    expect(savePrescriptionDraftRequestSchema.safeParse({
      expectedVersions: { 'Encounter/enc-1': '1' },
      input: { expectedDraftVersion: 0, items: [{ ...draftItem, routeCode: undefined }] },
    }).success).toBe(false)

    expect(issuedPrescriptionItemSchema.safeParse({
      ...draftItem,
      display: '硝酸甘油片',
      medicationRequestId: 'mr-1',
      medicationRequestVersion: '1',
    }).success).toBe(true)

    expect(pharmacyQueueSchema.safeParse({
      items: [{
        allergyWarnings: [],
        authoredBy: 'actor-doc',
        caseId: 'case-1',
        encounterId: 'enc-1',
        encounterVersion: '2',
        medications: [{
          dispensedQuantity: 0,
          doseText: '0.5 mg',
          frequencyCode: 'PRN',
          lots: [],
          medicationId: 'medication-nitroglycerin',
          medicationRequestId: 'mr-1',
          medicationRequestVersion: '1',
          nameEn: 'Nitroglycerin',
          nameZh: '硝酸甘油片',
          quantity: 10,
          remainingQuantity: 10,
          routeCode: 'SL',
          unitPriceFen: 30,
        }],
        patient: { birthDate: '1970-01-01', gender: 'male', id: 'pat-1', identifier: 'P1', name: '张合成', synthetic: true, versionId: '1' },
        prescriptionId: 'rx-1',
        prescriptionNumber: 'CM-RX-20261123-0001',
        prescriptionStatus: 'paid',
        prescriptionVersion: 1,
        status: 'awaiting-review',
      }],
      page: 1,
      pageSize: 20,
      total: 1,
    }).success).toBe(true)
  })

  it('enforces medication routeCode on inpatient medication orders while forbidding routeCode on service orders', () => {
    expect(inpatientFullCatalogSchema.safeParse({
      diagnoses: [],
      medications: [{
        id: 'medication-pci-heparin',
        display: '肝素钠注射液',
        version: 1,
        priceFen: 200,
        unit: 'mL',
        defaultRouteCode: 'IV',
        allowedRouteCodes: ['IV', 'IVGTT', 'IH'],
        doses: [{ doseText: '1 mL', quantity: 1 }],
        frequencyCodes: ['PRN'],
        lots: [],
      }],
      services: [],
    }).success).toBe(true)

    expect(inpatientOrderIssueInputSchema.safeParse({
      admissionId: 'adm-1',
      duration: 'temporary',
      encounterVersion: '1',
      selection: {
        kind: 'medication',
        catalogItemId: 'medication-pci-heparin',
        catalogVersion: 1,
        doseQuantity: 1,
        doseText: '1 mL',
        frequencyCode: 'ONCE',
        routeCode: 'IV',
      },
    }).success).toBe(true)

    expect(inpatientOrderIssueInputSchema.safeParse({
      admissionId: 'adm-1',
      duration: 'temporary',
      encounterVersion: '1',
      selection: {
        kind: 'service',
        serviceId: 'hospital-service-diabetes-education',
        serviceVersion: 1,
        quantity: 1,
        routeCode: 'PO',
      },
    }).success).toBe(false)

    const baseOrder = {
      id: 'ord-1',
      admissionId: 'adm-1',
      duration: 'long' as const,
      catalogItemId: 'medication-pci-heparin',
      catalogVersion: 1,
      display: '肝素钠注射液',
      doseText: '1 mL',
      doseQuantity: 1,
      unit: 'mL',
      frequencyCode: 'PRN' as const,
      state: 'signed' as const,
      version: 1,
      requestVersion: '1',
      signedAt: '2026-11-23T09:00:00+08:00',
      signedBy: 'actor-doc',
      organizationId: 'org-1',
    }
    expect(inpatientOrderSchema.safeParse({ ...baseOrder, kind: 'medication', routeCode: 'IH' }).success).toBe(true)
    expect(inpatientOrderSchema.safeParse({ ...baseOrder, kind: 'medication' }).success).toBe(false)
    expect(inpatientOrderSchema.safeParse({ ...baseOrder, kind: 'service' }).success).toBe(true)
    expect(inpatientOrderSchema.safeParse({ ...baseOrder, kind: 'service', routeCode: 'PO' }).success).toBe(false)

    expect(inpatientPharmacySchema.safeParse({
      admission: { admissionId: 'adm-1', inpatientNumber: 'IP-1', patientId: 'pat-1', patientName: '张合成', status: 'admitted', wardId: 'ward-general' },
      dispenses: [],
      executions: [],
      medicationAllergies: [],
      medications: [],
      orders: [{ ...baseOrder, kind: 'medication', routeCode: 'IH' }],
    }).success).toBe(true)
  })

  it('includes routeCode in order set templates/drafts, AI prescription recommendations, and prior inpatient history', () => {
    expect(orderSetTemplateSchema.safeParse({
      id: 'cin-perioperative-hydration',
      version: '2026-11-23.r1',
      fingerprint: 'a'.repeat(64),
      scopes: ['inpatient'],
      titleZh: '水化',
      titleEn: 'Hydration',
      descriptionZh: '水化组套',
      items: [{
        key: 'saline',
        kind: 'medication',
        scopes: ['inpatient'],
        titleZh: '氯化钠',
        titleEn: 'Saline',
        rationaleZh: '静脉水化',
        rules: [],
        options: [{
          kind: 'medication',
          medicationKey: 'sodium-chloride',
          doseText: '1000 mL',
          frequencyCode: 'ONCE',
          routeCode: 'IVGTT',
          courseDays: 1,
          inpatientDuration: 'temporary',
          rules: [],
        }],
      }],
    }).success).toBe(true)

    expect(orderSetDraftBundleSchema.safeParse({
      evaluatedAt: '2026-11-23T09:00:00+08:00',
      target: { scope: 'outpatient', caseId: 'case-1', encounterId: 'enc-1', encounterVersion: '1' },
      patientFacts: {
        allergies: [],
        egfr: { status: 'missing', missingInputs: ['serumCreatinine'] },
        vitalSigns: { status: 'missing', source: 'triage' },
        weight: { status: 'missing' },
      },
      drafts: [{
        fingerprint: 'b'.repeat(64),
        counts: { ready: 1, needsReview: 0, excluded: 0, unavailable: 0 },
        template: {
          id: 'cad-pci-secondary-prevention',
          version: '2026-11-23.r1',
          fingerprint: 'c'.repeat(64),
          scopes: ['outpatient', 'inpatient'],
          titleZh: '二级预防',
          titleEn: 'Secondary prevention',
          descriptionZh: '二级预防组套',
        },
        items: [{
          key: 'nitroglycerin-prn',
          kind: 'medication',
          titleZh: '硝酸甘油（按需）',
          disposition: 'ready',
          matchedCatalogId: 'medication-nitroglycerin',
          reasons: [],
          candidate: {
            kind: 'medication',
            catalogItemId: 'medication-nitroglycerin',
            catalogVersion: 1,
            display: '硝酸甘油片',
            doseText: '0.5 mg',
            frequencyCode: 'PRN',
            routeCode: 'SL',
            instructionsZh: '舌下含服',
            inpatient: null,
            outpatient: { courseDays: 30, quantity: 10 },
          },
        }],
      }],
    }).success).toBe(true)

    expect(doctorRecommendationSuggestionSchema.safeParse({
      id: 'rec-1',
      kind: 'prescription',
      label: '硝酸甘油片',
      catalogItemId: 'medication-nitroglycerin',
      doseText: '0.5 mg',
      frequencyCode: 'PRN',
      routeCode: null,
      courseDays: 1,
      quantity: 10,
      rationale: '按需缓解心绞痛',
      supportingInformation: [],
      opposingInformation: [],
      missingInformation: ['处方给药途径缺少依据'],
      caseEvidenceIds: ['ev-1'],
      guidelineEvidenceIds: ['gl-1'],
    }).success).toBe(true)

    expect(doctorPreparationSelectionSchema.safeParse({
      kind: 'prescription',
      source: 'agent',
      suggestionId: 'rec-1',
      catalogItemId: 'medication-nitroglycerin',
      doseText: '0.5 mg',
      frequencyCode: 'PRN',
      routeCode: null,
      courseDays: 1,
      quantity: 10,
    }).success).toBe(false)

    expect(doctorInpatientHistoryRecordSchema.safeParse({
      kind: 'inpatient',
      admissionId: 'adm-1',
      admittedAt: '2026-11-10T08:00:00+08:00',
      dischargedAt: '2026-11-15T10:00:00+08:00',
      diagnoses: [],
      procedures: [],
      medications: [{ display: '依诺肝素钠注射液', doseText: '40 mg', frequencyCode: 'BID', routeCode: 'IH', state: 'completed' }],
      reports: [],
    }).success).toBe(true)
  })

  it('bumps all affected HIS operation versions', () => {
    expect(getHisOperation('reference.medications.search').version).toBe(4)
    expect(getHisOperation('catalog.clinical.read').version).toBe(4)
    expect(getHisOperation('catalog.order-set-templates.list').version).toBe(3)
    expect(getHisOperation('doctor.case.history.read').version).toBe(3)
    expect(getHisOperation('doctor.completed-cases.get').version).toBe(8)
    expect(getHisOperation('doctor.case.get').version).toBe(23)
    expect(getHisOperation('doctor.case.order-set-drafts.read').version).toBe(2)
    expect(getHisOperation('encounter.prescription.draft.set').version).toBe(4)
    expect(getHisOperation('encounter.prescription.issue').version).toBe(7)
    expect(getHisOperation('pharmacy.queue.list').version).toBe(2)
    expect(getHisOperation('inpatient.pharmacy.read').version).toBe(4)
    expect(getHisOperation('inpatient.catalog.search').version).toBe(4)
    expect(getHisOperation('inpatient.clinical.catalog').version).toBe(5)
    expect(getHisOperation('inpatient.clinical.read').version).toBe(6)
    expect(getHisOperation('inpatient.vital-signs.record').version).toBe(3)
    expect(getHisOperation('inpatient.risk-assessment.record').version).toBe(3)
    expect(getHisOperation('inpatient.order-set-drafts.read').version).toBe(3)
    expect(getHisOperation('inpatient.diagnosis.confirm').version).toBe(5)
    expect(getHisOperation('inpatient.order.issue').version).toBe(10)
    expect(getHisOperation('inpatient.order.verify').version).toBe(5)
    expect(getHisOperation('inpatient.order.request-stop').version).toBe(5)
    expect(getHisOperation('inpatient.order.verify-stop').version).toBe(5)
    expect(getHisOperation('inpatient.execution.dispense').version).toBe(4)
    expect(getHisOperation('inpatient.execution.administer').version).toBe(5)
    expect(getHisOperation('inpatient.execution.complete').version).toBe(5)
    expect(getHisOperation('inpatient.execution.request-prn').version).toBe(6)
  })
})
