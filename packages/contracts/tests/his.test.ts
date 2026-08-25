import { describe, expect, it } from 'vitest'
import {
  clinicalCatalogSchema,
  laboratoryRequestSchema,
  laboratoryRequestStateSchema,
  laboratoryResultSchema,
  prescriptionDraftContentSchema,
} from '../src/his.ts'

describe('HIS contracts', () => {
  it('requires controlled course and quantity values in medication drafts', () => {
    const medication = {
      allowedCombinationIds: ['medication-acetaminophen'],
      allowedCourseDays: [5],
      allowedDoseTexts: ['75 mg'],
      allowedFrequencyCodes: ['BID'],
      allowedQuantities: [10],
      defaultCourseDays: 5,
      defaultDoseText: '75 mg',
      defaultFrequencyCode: 'BID',
      defaultQuantity: 10,
      id: 'medication-oseltamivir',
      nameEn: 'Oseltamivir phosphate capsules',
      nameZh: '磷酸奥司他韦胶囊',
      priceFen: 760,
      version: 1,
    }
    expect(clinicalCatalogSchema.safeParse({
      diagnoses: [],
      laboratory: [],
      medications: [medication],
    }).success).toBe(true)
    const { allowedCourseDays: _allowedCourseDays, ...missingCourseControl } = medication
    expect(clinicalCatalogSchema.safeParse({
      diagnoses: [],
      laboratory: [],
      medications: [missingCourseControl],
    }).success).toBe(false)
    expect(prescriptionDraftContentSchema.safeParse({
      items: [{
        catalogItemId: medication.id,
        courseDays: 5,
        doseText: '75 mg',
        frequencyCode: 'BID',
        quantity: 10,
      }],
    }).success).toBe(true)
    expect(prescriptionDraftContentSchema.safeParse({
      items: [{
        catalogItemId: medication.id,
        doseText: '75 mg',
        frequencyCode: 'BID',
        quantity: 10,
      }],
    }).success).toBe(false)
  })

  it('rejects unsupported catalog items in a laboratory request draft', () => {
    expect(laboratoryRequestStateSchema.safeParse({
      draft: {
        catalogItemId: 'lab-fever-panel',
        indicationCode: 'fever',
      },
      draftVersion: 1,
      reportingSupported: true,
      requests: [],
    }).success).toBe(false)
  })

  it('requires an explicit Scenario reporting capability in the request read model', () => {
    const state = { draftVersion: 0, requests: [] }

    expect(laboratoryRequestStateSchema.safeParse(state).success).toBe(false)
    expect(laboratoryRequestStateSchema.safeParse({
      ...state,
      reportingSupported: false,
    }).success).toBe(true)
    expect(laboratoryRequestStateSchema.safeParse({
      ...state,
      reportingSupported: true,
    }).success).toBe(true)
  })

  it('validates numeric laboratory results, UCUM units, ranges, and interpretation flags', () => {
    const result = {
      code: '1988-5',
      display: 'C 反应蛋白',
      interpretation: 'high',
      observationId: 'observation-crp-1',
      referenceRange: { high: 8, low: 0, text: '0-8 mg/L' },
      unit: {
        code: 'mg/L',
        display: 'mg/L',
        system: 'http://unitsofmeasure.org',
      },
      value: 18.6,
    }
    expect(laboratoryResultSchema.safeParse(result).success).toBe(true)
    expect(laboratoryResultSchema.safeParse({ ...result, value: '18.6' }).success).toBe(false)
    expect(laboratoryResultSchema.safeParse({
      ...result,
      interpretation: 'critical',
    }).success).toBe(false)
    expect(laboratoryResultSchema.safeParse({
      ...result,
      interpretation: 'normal',
    }).success).toBe(false)
    expect(laboratoryResultSchema.safeParse({
      ...result,
      referenceRange: { high: 0, low: 8, text: 'invalid' },
    }).success).toBe(false)
    expect(laboratoryResultSchema.safeParse({
      ...result,
      unit: { ...result.unit, system: 'https://example.test/units' },
    }).success).toBe(false)
  })

  it('keeps formal request status and report presence consistent', () => {
    const result = laboratoryResultSchema.parse({
      code: '1988-5',
      display: 'C 反应蛋白',
      interpretation: 'high',
      observationId: 'observation-crp-1',
      referenceRange: { high: 8, low: 0, text: '0-8 mg/L' },
      unit: {
        code: 'mg/L',
        display: 'mg/L',
        system: 'http://unitsofmeasure.org',
      },
      value: 18.6,
    })
    const report = {
      conclusion: 'C 反应蛋白升高。',
      diagnosticReportId: 'diagnostic-report-crp-1',
      diagnosticReportVersion: '1',
      issuedAt: '2026-08-24T09:00:00+08:00',
      revisionNumber: 1,
      results: [result],
      specimenId: 'specimen-crp-1',
      status: 'final',
    }
    const request = {
      catalogItemId: 'lab-crp',
      id: 'laboratory-request-crp-1',
      indicationCode: 'fever',
      previousReports: [],
      serviceRequestId: 'service-request-crp-1',
      serviceRequestVersion: '2',
      taskId: 'task-crp-1',
      taskVersion: '4',
      version: 4,
    }
    expect(laboratoryRequestSchema.safeParse({ ...request, status: 'reported' }).success).toBe(false)
    expect(laboratoryRequestSchema.safeParse({
      ...request,
      report,
      status: 'in-progress',
    }).success).toBe(false)
    expect(laboratoryRequestSchema.safeParse({ ...request, report, status: 'reported' }).success).toBe(true)
    expect(laboratoryRequestSchema.safeParse({
      ...request,
      report: { ...report, revisionOfDiagnosticReportId: 'diagnostic-report-crp-0' },
      status: 'reported',
    }).success).toBe(false)
    expect(laboratoryRequestSchema.safeParse({
      ...request,
      report: { ...report, revisionReason: '复核仪器原始数据。' },
      status: 'reported',
    }).success).toBe(false)
    expect(laboratoryRequestSchema.safeParse({
      ...request,
      report,
      status: 'acknowledged',
    }).success).toBe(false)
    expect(laboratoryRequestSchema.safeParse({
      ...request,
      report: {
        ...report,
        acknowledgement: {
          acknowledgedAt: '2026-08-24T09:05:00+08:00',
          acknowledgedBy: 'practitioner-outpatient-doctor',
          id: 'acknowledgement-crp-1',
        },
      },
      status: 'acknowledged',
    }).success).toBe(true)
  })
})
