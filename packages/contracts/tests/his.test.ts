import { describe, expect, it } from 'vitest'
import {
  caseLaboratoryCatalogSearchSchema,
  completedCaseLaboratoryRequestSchema,
  clinicalCatalogSchema,
  completeEncounterRequestSchema,
  completedCaseClinicalDocumentSchema,
  deletePrescriptionDraftRequestSchema,
  diagnosisConfirmationSchema,
  encounterCompletionPreviewSchema,
  encounterCompletionResponseSchema,
  laboratoryRequestSchema,
  laboratoryRequestStateSchema,
  laboratoryResultSchema,
  prescriptionDraftContentSchema,
  publishLaboratoryServicesRequestSchema,
} from '../src/his.ts'

function completedCaseLaboratoryRequestFixture() {
  const report = {
    conclusion: 'C 反应蛋白升高。',
    diagnosticReportId: 'diagnostic-report-crp-1',
    diagnosticReportVersion: '1',
    issuedAt: '2026-08-24T09:00:00+08:00',
    revisionNumber: 1,
    results: [{
      code: '1988-5',
      display: 'C 反应蛋白',
      interpretation: 'high',
      observationId: 'observation-crp-1',
      referenceRange: { text: '0-8 mg/L' },
      unit: {
        code: 'mg/L',
        display: 'mg/L',
        system: 'http://unitsofmeasure.org',
      },
      value: 18.6,
    }],
    specimenId: 'specimen-crp-1',
    status: 'final',
  }
  return {
    report,
    request: {
      catalogItemId: 'lab-crp',
      id: 'laboratory-request-crp-1',
      indicationCode: 'fever',
      previousReports: [],
      report,
      serviceRequestId: 'service-request-crp-1',
      serviceRequestVersion: '2',
      status: 'reported',
      taskId: 'task-crp-1',
      taskVersion: '4',
      version: 4,
    },
  }
}

describe('HIS contracts', () => {
  it('accepts Reference IDs in completed-case laboratory facts', () => {
    expect(completedCaseLaboratoryRequestSchema.parse({
      catalogItemId: 'laboratory:white-cell-count',
      correctionSupported: false,
      id: 'laboratory-request-1',
      indicationCode: 'clinical-evaluation',
      previousReports: [],
      serviceRequestId: 'service-request-1',
      serviceRequestVersion: '1',
      status: 'issued',
      taskId: 'task-1',
      taskVersion: '1',
      version: 1,
    }).catalogItemId).toBe('laboratory:white-cell-count')
  })

  it('binds the case laboratory catalog to published Hospital Services', () => {
    const referenceConcept = {
      code: '6690-2',
      display: '白细胞计数',
      id: 'loinc:synthetic:6690-2',
      sourceLocator: 'concepts[0]',
      system: 'http://loinc.org',
      version: '2.83',
    }
    const item = {
      allowedIndicationCodes: ['clinical-evaluation'],
      componentServiceIds: [],
      doctorOrderable: true,
      executingDepartmentId: 'department-laboratory',
      id: 'hospital-laboratory-service-wbc',
      localCode: 'CM-LAB-6690-2',
      nameEn: 'White blood cell count',
      nameZh: '白细胞计数',
      priceFen: 800,
      referenceConcept,
      referenceReleaseId: 'release-1',
      reportDefinition: {
        conclusionTemplate: '白细胞计数结果已完成。',
        results: [{
          referenceConcept,
          referenceRange: { high: 10, low: 4, text: '4.0-10.0 x10^9/L' },
          unit: {
            code: '10*9/L',
            display: '10*9/L',
            system: 'http://unitsofmeasure.org',
          },
          valueType: 'quantity',
        }],
      },
      specimen: { code: 'LP7057-5', display: '血液' },
      serviceKind: 'laboratory',
      tatMinutes: 20,
      version: 1,
    }
    const search = {
      items: [item],
      page: 1,
      pageSize: 20,
      total: 1,
    }
    expect(caseLaboratoryCatalogSearchSchema.safeParse(search).success).toBe(true)
    expect(caseLaboratoryCatalogSearchSchema.safeParse({
      ...search,
      items: [referenceConcept],
    }).success).toBe(false)
  })

  it('bounds one Laboratory Service publication batch at fifty roots', () => {
    const entries = Array.from({ length: 50 }, (_, index) => ({
      conceptId: `loinc:synthetic:${index}`,
      expectedVersion: 0,
    }))
    expect(publishLaboratoryServicesRequestSchema.safeParse({ input: { entries } }).success)
      .toBe(true)
    expect(publishLaboratoryServicesRequestSchema.safeParse({
      input: { entries: [...entries, { conceptId: 'loinc:synthetic:overflow', expectedVersion: 0 }] },
    }).success).toBe(false)
  })

  it('treats confirmations created before diagnosis revisions as revision one', () => {
    const confirmation = diagnosisConfirmationSchema.parse({
      confirmedAt: '2026-08-24T09:00:00+08:00',
      entries: [{
        catalogItemId: 'diagnosis-fever',
        code: 'R50.9',
        conditionId: 'condition-1',
        conditionVersion: '1',
        display: '发热，未特指',
        role: 'primary',
        system: 'http://hl7.org/fhir/sid/icd-10',
      }],
      id: 'confirmation-1',
      provenanceId: 'provenance-1',
    })
    expect(confirmation.revisionNumber).toBe(1)
  })

  it('requires every stable Encounter completion condition with a Chinese status and navigation target', () => {
    const preview = {
      canComplete: false,
      encounterId: 'encounter-1',
      encounterVersion: '4',
      items: [
        {
          code: 'primary-diagnosis-confirmed',
          status: 'complete',
          statusText: '已确认主诊断',
          target: 'diagnosis',
        },
        {
          code: 'clinical-document-signed',
          status: 'incomplete',
          statusText: '待签署结构化病历',
          target: 'clinical-document',
        },
        {
          code: 'required-reports-acknowledged',
          status: 'complete',
          statusText: '必要报告已全部确认已阅',
          target: 'laboratory',
        },
        {
          code: 'medication-conclusion-recorded',
          status: 'incomplete',
          statusText: '待记录用药结论',
          target: 'medication-conclusion',
        },
        {
          code: 'no-pending-drafts',
          status: 'complete',
          statusText: '无未处理临床草稿',
          target: 'clinical-document',
        },
        {
          code: 'disposition-complete',
          status: 'incomplete',
          statusText: '待完善处置',
          target: 'clinical-document',
        },
        {
          code: 'follow-up-complete',
          status: 'incomplete',
          statusText: '待完善随访安排',
          target: 'clinical-document',
        },
      ],
    }

    expect(encounterCompletionPreviewSchema.safeParse(preview).success).toBe(true)
    expect(encounterCompletionPreviewSchema.safeParse({
      ...preview,
      items: preview.items.slice(0, -1),
    }).success).toBe(false)
    expect(encounterCompletionPreviewSchema.safeParse({
      ...preview,
      items: preview.items.map((item, index) => index === 0
        ? { ...item, code: 'diagnosis-ready' }
        : item),
    }).success).toBe(false)
    expect(encounterCompletionPreviewSchema.safeParse({
      ...preview,
      items: preview.items.map((item, index) => index === 0
        ? { ...item, statusText: 'Complete' }
        : item),
    }).success).toBe(false)
  })

  it('limits Encounter completion commands to the expected Encounter version', () => {
    expect(completeEncounterRequestSchema.safeParse({
      expectedVersions: { 'Encounter/encounter-1': '4' },
      input: {},
    }).success).toBe(true)
    expect(completeEncounterRequestSchema.safeParse({
      expectedVersions: { 'Encounter/encounter-1': '4' },
      input: { completeScenario: true },
    }).success).toBe(false)
    for (const expectedVersions of [
      {},
      { 'Encounter/encounter-1': '4', 'Task/task-1': '2' },
      { 'Encounter/encounter-1': '4', 'Encounter/encounter-2': '1' },
      { 'Encounter/encounter-1': 'latest' },
    ]) {
      expect(completeEncounterRequestSchema.safeParse({
        expectedVersions,
        input: {},
      }).success).toBe(false)
    }
    expect(encounterCompletionResponseSchema.safeParse({
      auditId: 'audit-1',
      data: {
        completedAt: '2026-08-25T10:30:00+08:00',
        encounterId: 'encounter-1',
        encounterVersion: '5',
        status: 'completed',
      },
      effects: [{
        kind: 'updated',
        reference: 'Encounter/encounter-1',
        versionId: '5',
      }],
      requestId: 'request-1',
      warnings: [],
    }).success).toBe(true)
  })

  it('validates FHIR expected-version records before a command is accepted', () => {
    const input = { expectedDraftVersion: 1 }
    expect(deletePrescriptionDraftRequestSchema.safeParse({
      expectedVersions: { 'Encounter/encounter-1': '4' },
      input,
    }).success).toBe(true)
    for (const expectedVersions of [
      { 'Encounter/encounter-1': 'latest' },
      { 'not-a-fhir-reference': '4' },
    ]) {
      expect(deletePrescriptionDraftRequestSchema.safeParse({
        expectedVersions,
        input,
      }).success).toBe(false)
    }
  })

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
      prescriptionConclusionSupported: true,
    }).success).toBe(true)
    const { allowedCourseDays: _allowedCourseDays, ...missingCourseControl } = medication
    expect(clinicalCatalogSchema.safeParse({
      diagnoses: [],
      laboratory: [],
      medications: [missingCourseControl],
      prescriptionConclusionSupported: true,
    }).success).toBe(false)
    const {
      allowedCourseDays: _legacyAllowedCourseDays,
      allowedQuantities: _legacyAllowedQuantities,
      defaultCourseDays: _legacyDefaultCourseDays,
      defaultQuantity: _legacyDefaultQuantity,
      ...legacyMedication
    } = medication
    expect(clinicalCatalogSchema.safeParse({
      diagnoses: [],
      laboratory: [],
      medications: [legacyMedication],
      prescriptionConclusionSupported: false,
    }).success).toBe(true)
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

  it('accepts dynamic laboratory catalog IDs, including external reference IDs', () => {
    expect(laboratoryRequestStateSchema.safeParse({
      draft: {
        catalogItemId: 'lab-fever-panel',
        indicationCode: 'fever',
      },
      draftVersion: 1,
      reportingSupported: true,
      requests: [],
    }).success).toBe(true)
    expect(laboratoryRequestStateSchema.safeParse({
      draft: {
        catalogItemId: 'catalog/lab-fever-panel',
        indicationCode: 'fever',
      },
      draftVersion: 1,
      reportingSupported: true,
      requests: [],
    }).success).toBe(true)
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

  it('rejects inconsistent completed-case laboratory report revisions', () => {
    const { report, request } = completedCaseLaboratoryRequestFixture()

    expect(completedCaseLaboratoryRequestSchema.safeParse(request).success).toBe(true)
    expect(completedCaseLaboratoryRequestSchema.safeParse({
      ...request,
      report: {
        ...report,
        revisionOfDiagnosticReportId: 'diagnostic-report-crp-0',
      },
    }).success).toBe(false)
    expect(completedCaseLaboratoryRequestSchema.safeParse({
      ...request,
      report: {
        ...report,
        revisionNumber: 2,
        revisionOfDiagnosticReportId: 'diagnostic-report-crp-0',
        revisionReason: '复核仪器原始数据。',
      },
    }).success).toBe(true)
    expect(completedCaseLaboratoryRequestSchema.safeParse({
      ...request,
      report: {
        ...report,
        revisionNumber: 2,
        revisionOfDiagnosticReportId: 'diagnostic-report-crp-0',
      },
    }).success).toBe(false)
  })

  it('rejects unpaired completed-case laboratory task references', () => {
    const { request } = completedCaseLaboratoryRequestFixture()

    expect(completedCaseLaboratoryRequestSchema.safeParse(request).success).toBe(true)
    expect(completedCaseLaboratoryRequestSchema.safeParse({
      ...request,
      taskVersion: undefined,
    }).success).toBe(false)
    expect(completedCaseLaboratoryRequestSchema.safeParse({
      ...request,
      taskId: undefined,
    }).success).toBe(false)
  })

  it('rejects completed-case laboratory reports that contradict request status', () => {
    const { report, request } = completedCaseLaboratoryRequestFixture()

    expect(completedCaseLaboratoryRequestSchema.safeParse(request).success).toBe(true)
    expect(completedCaseLaboratoryRequestSchema.safeParse({
      ...request,
      status: 'issued',
    }).success).toBe(false)
    expect(completedCaseLaboratoryRequestSchema.safeParse({
      ...request,
      status: 'acknowledged',
    }).success).toBe(false)
    expect(completedCaseLaboratoryRequestSchema.safeParse({
      ...request,
      report: {
        ...report,
        acknowledgement: {
          acknowledgedAt: '2026-08-24T09:05:00+08:00',
          acknowledgedBy: 'practitioner-outpatient-doctor',
          id: 'acknowledgement-crp-1',
        },
      },
    }).success).toBe(false)
  })

  it('defaults missing completed-case correction capabilities to unavailable', () => {
    const document = {
      bundleId: 'bundle-legacy-1',
      compositionId: 'composition-legacy-1',
      compositionVersion: '1',
      content: {
        assessment: '甲型流感，生命体征稳定。',
        plan: '口服抗病毒药物，对症处理。',
      },
      documentId: 'document-legacy-1',
      provenanceId: 'provenance-legacy-1',
      revisionNumber: 1,
      signedAt: '2026-08-24T08:20:00+08:00',
    }
    const { request } = completedCaseLaboratoryRequestFixture()

    expect(completedCaseClinicalDocumentSchema.parse(document).correctionSupported).toBe(false)
    expect(completedCaseClinicalDocumentSchema.parse({
      ...document,
      correctionSupported: true,
    }).correctionSupported).toBe(true)
    expect(completedCaseLaboratoryRequestSchema.parse(request).correctionSupported).toBe(false)
    expect(completedCaseLaboratoryRequestSchema.parse({
      ...request,
      correctionSupported: true,
    }).correctionSupported).toBe(true)
  })
})
