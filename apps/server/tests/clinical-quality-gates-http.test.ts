import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import {
  clinicalQualityCheckSchema,
  clinicalQualityReceiptSchema,
  type ClinicalOverrideInput,
} from '@clinmesh/contracts/clinical-quality'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import {
  apiErrorSchema,
  clinicalDocumentDraftResponseSchema,
  clinicalDocumentSignPreviewResponseSchema,
  clinicalDocumentSignResponseSchema,
  confirmDiagnosisResponseSchema,
  confirmNoMedicationResponseSchema,
  createPatientResponseSchema,
  diagnosisDraftResponseSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  encounterCompletionResponseSchema,
  issuePrescriptionResponseSchema,
  prescriptionDraftResponseSchema,
  registrationCatalogSchema,
  registrationResponseSchema,
  scenarioStateSchema,
  startVisitResponseSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { advanceVirtualTimeResponseSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientAngiographyReportSchema } from '@clinmesh/contracts/inpatient-angiography'
import { inpatientFullCatalogSchema, inpatientFullClinicalResponseSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDischargeResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientMaterialEstimateResponseSchema, inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientPciSelectionResponseSchema, inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientRecordResponseSchema, inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientSurgeryCatalogSchema, inpatientSurgeryResponseSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import {
  createPciPaymentDrgFixture,
  parsePciResponse,
  preparePciPaymentDrgFixture,
  type PciPaymentDrgFixture,
} from './fixtures/pci-payment-drg.ts'
import { defaultOutpatientGateDocument } from './fixtures/outpatient-order-gate.ts'

const fixtures: PciPaymentDrgFixture[] = []

afterEach(async () => {
  for (const item of fixtures.splice(0)) await item.close()
})

async function createOutpatientVisit(
  fixture: PciPaymentDrgFixture,
  options: { birthDate: string; chiefComplaint: string; gender: 'female' | 'male'; name: string },
) {
  const createdPatient = await parsePciResponse(
    createPatientResponseSchema,
    await fixture.request('registrar', '/api/his/v1/patients', {
      birthDate: options.birthDate,
      gender: options.gender,
      identifier: `SYN-${randomUUID()}`,
      name: options.name,
    }, randomUUID(), {}),
  )
  const patient = createdPatient.data.patient
  const regCatalog = await fixture.read('registrar', '/api/his/v1/catalogs/registration', registrationCatalogSchema)
  const registered = await parsePciResponse(
    registrationResponseSchema,
    await fixture.request('registrar', '/api/his/v1/registrations/actions/register', {
      departmentId: regCatalog.departments[0]!.id,
      locationId: regCatalog.locations[0]!.id,
      patientId: patient.id,
      visitDate: regCatalog.virtualDate,
      visitTypeId: regCatalog.visitTypes[0]!.id,
    }, randomUUID(), { [`Patient/${patient.id}`]: patient.versionId }),
  )
  const encounterId = registered.data.encounterId
  const triaged = await parsePciResponse(
    triageResponseSchema,
    await fixture.request('triage', `/api/his/v1/encounters/${encounterId}/actions/record-triage`, {
      acuityCode: 'level-2',
      bloodPressure: { diastolicMmHg: 82, systolicMmHg: 132 },
      chiefComplaint: options.chiefComplaint,
      heightCm: 166,
      oxygenSaturationPct: 98,
      pulseBpm: 84,
      respirationBpm: 18,
      temperatureC: 36.8,
      weightKg: 65,
    }, randomUUID(), {
      [`Encounter/${encounterId}`]: '1',
      [`Task/${registered.data.queueTaskId}`]: '1',
    }),
  )
  await parsePciResponse(
    startVisitResponseSchema,
    await fixture.request('doctor', `/api/his/v1/encounters/${encounterId}/actions/start-first-visit`, {}, randomUUID(), {
      [`Encounter/${encounterId}`]: triaged.data.encounterVersion,
      [`Task/${triaged.data.doctorTaskId}`]: '1',
    }),
  )
  const queue = await fixture.read('doctor', '/api/his/v1/doctor/queue', doctorQueueSchema)
  const caseItem = queue.items.find(item => item.encounterId === encounterId)!
  const detail = await fixture.read('doctor', `/api/his/v1/doctor/cases/${caseItem.caseId}`, doctorCaseDetailSchema)
  return { caseId: caseItem.caseId, detail, encounterId, patient }
}

async function confirmOutpatientDiagnosis(
  fixture: PciPaymentDrgFixture,
  encounterId: string,
  encounterVersion: string,
  entries: Array<{ catalogItemId: string; role: 'primary' | 'secondary' }>,
  expectedDraftVersion = 0,
) {
  const cookie = await fixture.login('doctor')
  const draftRes = await fixture.runtime.app.request(`http://localhost/api/his/v1/encounters/${encounterId}/diagnosis/draft`, {
    body: JSON.stringify({
      expectedVersions: { [`Encounter/${encounterId}`]: encounterVersion },
      input: { entries, expectedDraftVersion },
    }),
    headers: { 'content-type': 'application/json', cookie, 'idempotency-key': randomUUID(), origin: 'http://localhost' },
    method: 'PUT',
  })
  const saved = await parsePciResponse(diagnosisDraftResponseSchema, draftRes)
  return parsePciResponse(
    confirmDiagnosisResponseSchema,
    await fixture.request(
      'doctor',
      `/api/his/v1/encounters/${encounterId}/diagnosis/actions/confirm`,
      { expectedDraftVersion: saved.data.draftVersion },
      randomUUID(),
      { [`Encounter/${encounterId}`]: encounterVersion },
    ),
  )
}

async function saveOutpatientPrescriptionDraft(
  fixture: PciPaymentDrgFixture,
  encounterId: string,
  encounterVersion: string,
  items: Array<{ catalogItemId: string; courseDays: number; doseText: string; frequencyCode: string; quantity: number; routeCode?: string }>,
  expectedDraftVersion = 0,
) {
  const cookie = await fixture.login('doctor')
  const draftRes = await fixture.runtime.app.request(`http://localhost/api/his/v1/encounters/${encounterId}/prescription/draft`, {
    body: JSON.stringify({
      expectedVersions: { [`Encounter/${encounterId}`]: encounterVersion },
      input: { expectedDraftVersion, items: items.map(item => ({ routeCode: 'PO', ...item })) },
    }),
    headers: { 'content-type': 'application/json', cookie, 'idempotency-key': randomUUID(), origin: 'http://localhost' },
    method: 'PUT',
  })
  return parsePciResponse(prescriptionDraftResponseSchema, draftRes)
}

function insertSerumCreatinineReport(
  fixture: PciPaymentDrgFixture,
  options: { caseId: string; encounterId: string; epoch: string; patientId: string; valueMgDl: number; workspaceId: string },
) {
  const scope = { workspaceId: options.workspaceId, epoch: options.epoch } as const
  const now = '2026-08-24T09:30:00+08:00'
  const sr = fixture.runtime.fhir.create(scope, {
    resourceType: 'ServiceRequest',
    id: uuidv7(),
    status: 'completed',
    intent: 'order',
    authoredOn: now,
    code: { text: '肾功能检测' },
    subject: { reference: `Patient/${options.patientId}` },
    encounter: { reference: `Encounter/${options.encounterId}` },
  })
  const specimen = fixture.runtime.fhir.create(scope, {
    resourceType: 'Specimen',
    id: uuidv7(),
    status: 'available',
    subject: { reference: `Patient/${options.patientId}` },
  })
  const specimenReference = `Specimen/${specimen.id}`
  const obs = fixture.runtime.fhir.create(scope, {
    resourceType: 'Observation',
    id: uuidv7(),
    status: 'final',
    basedOn: [{ reference: `ServiceRequest/${sr.id}` }],
    specimen: { reference: specimenReference },
    code: {
      coding: [{ code: '1700404A', display: '血清肌酐', system: 'urn:clinmesh:wst:886-2026' }],
      text: '血清肌酐',
    },
    interpretation: [{ coding: [{ code: 'H' }] }],
    referenceRange: [{ low: { value: 0.5 }, high: { value: 1.2 }, text: '0.5 - 1.2 mg/dL' }],
    subject: { reference: `Patient/${options.patientId}` },
    encounter: { reference: `Encounter/${options.encounterId}` },
    effectiveDateTime: now,
    valueQuantity: { code: 'mg/dL', system: 'http://unitsofmeasure.org', unit: 'mg/dL', value: options.valueMgDl },
  })
  const report = fixture.runtime.fhir.create(scope, {
    resourceType: 'DiagnosticReport',
    id: uuidv7(),
    status: 'final',
    basedOn: [{ reference: `ServiceRequest/${sr.id}` }],
    specimen: [{ reference: specimenReference }],
    code: { text: '合成肾功能检验报告' },
    subject: { reference: `Patient/${options.patientId}` },
    encounter: { reference: `Encounter/${options.encounterId}` },
    issued: now,
    result: [{ reference: `Observation/${obs.id}` }],
    conclusion: '合成肾功能报告已签发。',
  })
  const task = fixture.runtime.fhir.create(scope, {
    resourceType: 'Task',
    id: uuidv7(),
    status: 'completed',
    intent: 'order',
    for: { reference: `Patient/${options.patientId}` },
    focus: { reference: `ServiceRequest/${sr.id}` },
  })
  const requestId = uuidv7()
  const referenceConcept = JSON.stringify({
    code: '1700404A',
    display: '血清肌酐',
    id: 'nhc-service:wst-886@2026:1700404A',
    sourceLocator: 'synthetic:creatinine',
    system: 'urn:clinmesh:wst:886-2026',
    version: '2026',
  })
  fixture.runtime.database.driver.prepare(`
    INSERT INTO laboratory_request (
      workspace_id, epoch, request_id, case_id, request_kind, catalog_item_id, reference_json,
      indication_code, service_snapshot_json, service_request_id, execution_task_id,
      diagnostic_report_id, status, version, authored_by, authored_at, reported_at
    ) VALUES (?, ?, ?, ?, 'laboratory', 'hospital-lab-pci-creatinine', ?, 'clinical-assessment', NULL, ?, ?, ?, 'reported', 1, 'actor-test', ?, ?)
  `).run(options.workspaceId, options.epoch, requestId, options.caseId, referenceConcept, sr.id, task.id, report.id, now, now)
}

function assertOverrideAuditAndTrace(
  fixture: PciPaymentDrgFixture,
  options: {
    auditId: string
    epoch: string
    gate: string
    operation: string
    override: ClinicalOverrideInput
    overrideId: string
    workspaceId: string
  },
) {
  const row = z.object({
    gate: z.string(),
    note: z.string(),
    operation: z.string(),
    override_id: z.string(),
    reason_code: z.string(),
  }).parse(
    fixture.runtime.database.driver.prepare(
      'SELECT override_id, gate, operation, reason_code, note FROM clinical_quality_override WHERE workspace_id=? AND epoch=? AND override_id=?',
    ).get(options.workspaceId, options.epoch, options.overrideId),
  )
  expect(row).toEqual({
    gate: options.gate,
    note: options.override.note,
    operation: options.operation,
    override_id: options.overrideId,
    reason_code: options.override.reasonCode,
  })

  const auditEvent = fhirResourceSchema.parse(
    fixture.runtime.fhir.read({ workspaceId: options.workspaceId, epoch: options.epoch }, 'AuditEvent', options.auditId),
  ) as { entity?: Array<{ detail?: Array<{ type?: { text?: string }; valueString?: string }>; what?: { identifier?: { value?: string } } }> }
  const overrideEntity = auditEvent.entity?.find(item => item.what?.identifier?.value === `ClinicalQualityOverride/${options.overrideId}`)
  expect(overrideEntity).toBeDefined()
  expect(overrideEntity?.detail).toEqual(expect.arrayContaining([
    { type: { text: 'clinical-quality-gate' }, valueString: options.gate },
    { type: { text: 'clinical-override-reason' }, valueString: options.override.reasonCode },
    { type: { text: 'clinical-override-note' }, valueString: options.override.note },
  ]))

  const trace = z.object({ effect_json: z.string(), outcome: z.string() }).parse(
    fixture.runtime.database.driver.prepare(
      'SELECT outcome, effect_json FROM action_trace WHERE workspace_id=? AND epoch=? AND operation=? ORDER BY sequence DESC LIMIT 1',
    ).get(options.workspaceId, options.epoch, options.operation),
  )
  expect(trace.outcome).toBe('success')
  expect(JSON.parse(trace.effect_json)).toContainEqual(
    expect.objectContaining({ kind: 'created', reference: `ClinicalQualityOverride/${options.overrideId}` }),
  )
}

describe('Two-tier clinical quality gates HTTP integration', () => {
  it('enforces outpatient prescription & completion gates, distinguishes missing creatinine from proven eGFR < 30, blocks Tier-1 red lines with override, and persists/replays Tier-2 overrides', async () => {
    const prepared = await preparePciPaymentDrgFixture()
    const fixture = await createPciPaymentDrgFixture(prepared)
    fixtures.push(fixture)
    const scenario = await fixture.read('admin', '/api/sim/v1/scenario-runs/current', scenarioStateSchema)

    // --- 1. Outpatient Prescription: missing creatinine (Tier-2 alert) vs proven eGFR < 30 (Tier-1 red line) ---
    const renalVisit = await createOutpatientVisit(fixture, {
      birthDate: '1952-03-14',
      chiefComplaint: '口渴多饮伴血糖升高复诊',
      gender: 'female',
      name: '合成糖肾质控患者',
    })
    await confirmOutpatientDiagnosis(fixture, renalVisit.encounterId, renalVisit.detail.encounter.versionId, [
      { catalogItemId: 'diagnosis-type-2-diabetes-hyperglycemia', role: 'primary' },
      { catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I25.103', role: 'secondary' },
    ])
    const afterDiag = await fixture.read('doctor', `/api/his/v1/doctor/cases/${renalVisit.caseId}`, doctorCaseDetailSchema)
    const savedMetformin = await saveOutpatientPrescriptionDraft(fixture, renalVisit.encounterId, afterDiag.encounter.versionId, [
      { catalogItemId: 'medication-metformin', courseDays: 7, doseText: '500mg', frequencyCode: 'BID', quantity: 14 },
    ])

    // Read-only preflight reports RENAL_CREATININE_MISSING (Tier-2 alert, NOT red-line) and writes audit entry
    const auditCountBefore = z.object({ count: z.number() }).parse(
      fixture.runtime.database.driver.prepare('SELECT COUNT(*) AS count FROM audit_log WHERE workspace_id=? AND epoch=? AND operation=?')
        .get(scenario.workspaceId, scenario.epoch, 'encounter.clinical-quality.read'),
    ).count
    const preflightMissingCr = await fixture.read(
      'doctor',
      `/api/his/v1/encounters/${renalVisit.encounterId}/clinical-quality?gate=outpatient-prescription`,
      clinicalQualityCheckSchema,
    )
    expect(preflightMissingCr.redLines).toEqual([])
    expect(preflightMissingCr.alerts).toMatchObject([{ code: 'RENAL_CREATININE_MISSING', tier: 'alert', catalogItemId: 'medication-metformin' }])
    const auditCountAfter = z.object({ count: z.number() }).parse(
      fixture.runtime.database.driver.prepare('SELECT COUNT(*) AS count FROM audit_log WHERE workspace_id=? AND epoch=? AND operation=?')
        .get(scenario.workspaceId, scenario.epoch, 'encounter.clinical-quality.read'),
    ).count
    expect(auditCountAfter).toBe(auditCountBefore + 1)
    const outpatientQueryOverrideRes = await fixture.request(
      'doctor',
      `/api/his/v1/encounters/${renalVisit.encounterId}/clinical-quality?gate=outpatient-prescription&encounterId=other-encounter`,
    )
    expect(outpatientQueryOverrideRes.status).toBe(400)

    // Issuing without clinicalOverride returns 409 CLINICAL_QUALITY_ALERT and creates zero formal facts
    const issueWithoutOverride = await fixture.request(
      'doctor',
      `/api/his/v1/encounters/${renalVisit.encounterId}/prescription/actions/issue`,
      { expectedDraftVersion: savedMetformin.data.draftVersion },
      randomUUID(),
      { [`Encounter/${renalVisit.encounterId}`]: afterDiag.encounter.versionId },
    )
    expect(issueWithoutOverride.status).toBe(409)
    expect(apiErrorSchema.parse(await issueWithoutOverride.json()).error).toMatchObject({
      code: 'CLINICAL_QUALITY_ALERT',
      clinicalQuality: {
        gate: 'outpatient-prescription',
        redLines: [],
        alerts: [expect.objectContaining({ code: 'RENAL_CREATININE_MISSING' })],
      },
    })
    expect((await fixture.read('doctor', `/api/his/v1/doctor/cases/${renalVisit.caseId}`, doctorCaseDetailSchema)).medicationConclusion?.prescription).toBeUndefined()

    // Also verify confirmPreparation rejects without clinicalOverride when RENAL_CREATININE_MISSING is active
    const prepBlocked = await fixture.request(
      'doctor',
      `/api/his/v1/doctor/cases/${renalVisit.caseId}/recommendations/prescription/actions/confirm`,
      {
        expectedDraftVersion: savedMetformin.data.draftVersion,
        resolveExistingDraft: true,
        selections: [{
          kind: 'prescription',
          source: 'manual',
          catalogItemId: 'medication-dapagliflozin',
          doseText: '10 mg',
          frequencyCode: 'QD',
          routeCode: 'PO',
          courseDays: 7,
          quantity: 1,
        }],
      },
      randomUUID(),
      { [`Encounter/${renalVisit.encounterId}`]: afterDiag.encounter.versionId },
    )
    expect(prepBlocked.status).toBe(409)
    expect(apiErrorSchema.parse(await prepBlocked.json()).error.code).toBe('CLINICAL_QUALITY_ALERT')

    // Now insert formal serum creatinine = 3.4 mg/dL (proven eGFR < 30 mL/min/1.73m2) -> flips to Tier-1 RED LINE!
    insertSerumCreatinineReport(fixture, {
      caseId: renalVisit.caseId,
      encounterId: renalVisit.encounterId,
      epoch: scenario.epoch,
      patientId: renalVisit.patient.id,
      valueMgDl: 3.4,
      workspaceId: scenario.workspaceId,
    })
    const preflightLowEgfr = await fixture.read(
      'doctor',
      `/api/his/v1/encounters/${renalVisit.encounterId}/clinical-quality?gate=outpatient-prescription`,
      clinicalQualityCheckSchema,
    )
    expect(preflightLowEgfr.alerts).toEqual([])
    expect(preflightLowEgfr.redLines).toMatchObject([{ code: 'RENAL_CONTRAINDICATED_MEDICATION', tier: 'red-line', catalogItemId: 'medication-metformin' }])

    // Even when a valid clinicalOverride is attached, Tier-1 red line STILL hard-rejects with 409 CLINICAL_QUALITY_RED_LINE!
    const redLineOverrideAttempt: ClinicalOverrideInput = {
      reasonCode: 'emergency-care',
      note: '试图越权开立二甲双胍验证硬性拦截',
      acknowledgedAlerts: ['RENAL_CREATININE_MISSING'],
    }
    const redLineRes = await fixture.request(
      'doctor',
      `/api/his/v1/encounters/${renalVisit.encounterId}/prescription/actions/issue`,
      { clinicalOverride: redLineOverrideAttempt, expectedDraftVersion: savedMetformin.data.draftVersion },
      randomUUID(),
      { [`Encounter/${renalVisit.encounterId}`]: afterDiag.encounter.versionId },
    )
    expect(redLineRes.status).toBe(409)
    expect(apiErrorSchema.parse(await redLineRes.json()).error).toMatchObject({
      code: 'CLINICAL_QUALITY_RED_LINE',
      clinicalQuality: {
        redLines: [expect.objectContaining({ code: 'RENAL_CONTRAINDICATED_MEDICATION' })],
      },
    })

    // Dapagliflozin via confirmPreparation is also hard-blocked with 409 CLINICAL_QUALITY_RED_LINE even with override!
    const dapaRedLineRes = await fixture.request(
      'doctor',
      `/api/his/v1/doctor/cases/${renalVisit.caseId}/recommendations/prescription/actions/confirm`,
      {
        clinicalOverride: redLineOverrideAttempt,
        expectedDraftVersion: savedMetformin.data.draftVersion,
        resolveExistingDraft: true,
        selections: [{
          kind: 'prescription',
          source: 'manual',
          catalogItemId: 'medication-dapagliflozin',
          doseText: '10 mg',
          frequencyCode: 'QD',
          routeCode: 'PO',
          courseDays: 1,
          quantity: 1,
        }],
      },
      randomUUID(),
      { [`Encounter/${renalVisit.encounterId}`]: afterDiag.encounter.versionId },
    )
    expect(dapaRedLineRes.status).toBe(409)
    expect(apiErrorSchema.parse(await dapaRedLineRes.json()).error.code).toBe('CLINICAL_QUALITY_RED_LINE')

    // Also verify allergy conflict, dose limit exceeded, and class duplication remain hard-blocked even with clinicalOverride
    fixture.runtime.fhir.create({ workspaceId: scenario.workspaceId, epoch: scenario.epoch }, {
      resourceType: 'AllergyIntolerance',
      id: uuidv7(),
      category: ['medication'],
      clinicalStatus: { coding: [{ code: 'active' }] },
      verificationStatus: { coding: [{ code: 'confirmed' }] },
      code: { coding: [{ code: 'ATORVASTATIN', display: '阿托伐他汀过敏' }] },
      patient: { reference: `Patient/${renalVisit.patient.id}` },
    })
    const statinAllergyDraft = await saveOutpatientPrescriptionDraft(
      fixture,
      renalVisit.encounterId,
      afterDiag.encounter.versionId,
      [{ catalogItemId: 'medication-pci-atorvastatin', courseDays: 1, doseText: '20 mg', frequencyCode: 'QN', quantity: 1 }],
      savedMetformin.data.draftVersion,
    )
    const preflightRedLines = await fixture.read(
      'doctor',
      `/api/his/v1/encounters/${renalVisit.encounterId}/clinical-quality?gate=outpatient-prescription`,
      clinicalQualityCheckSchema,
    )
    expect(preflightRedLines.redLines.map(item => item.code)).toContain('MEDICATION_ALLERGY_CONFLICT')
    const allergyIssueRes = await fixture.request(
      'doctor',
      `/api/his/v1/encounters/${renalVisit.encounterId}/prescription/actions/issue`,
      { clinicalOverride: redLineOverrideAttempt, expectedDraftVersion: statinAllergyDraft.data.draftVersion },
      randomUUID(),
      { [`Encounter/${renalVisit.encounterId}`]: afterDiag.encounter.versionId },
    )
    expect(allergyIssueRes.status).toBe(409)
    expect(apiErrorSchema.parse(await allergyIssueRes.json()).error).toMatchObject({
      code: 'WORKFLOW_CONFLICT',
      reason: 'PRESCRIPTION_ALLERGY_CONFLICT',
      clinicalQuality: {
        status: 'blocked',
        redLines: [expect.objectContaining({ code: 'MEDICATION_ALLERGY_CONFLICT', catalogItemId: 'medication-pci-atorvastatin' })],
      },
    })

    // Dose limit exceeded & class duplication on outpatient draft write also attach structured `clinicalQuality` (`status: 'blocked'`)
    const doctorCookie = await fixture.login('doctor')
    const extremeDoseDraftRes = await fixture.runtime.app.request(`http://localhost/api/his/v1/encounters/${renalVisit.encounterId}/prescription/draft`, {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${renalVisit.encounterId}`]: afterDiag.encounter.versionId },
        input: {
          expectedDraftVersion: statinAllergyDraft.data.draftVersion,
          items: [{ catalogItemId: 'medication-rosuvastatin', courseDays: 1, doseText: '80 mg', frequencyCode: 'QN', routeCode: 'PO', quantity: 1 }],
        },
      }),
      headers: { 'content-type': 'application/json', cookie: doctorCookie, 'idempotency-key': randomUUID(), origin: 'http://localhost' },
      method: 'PUT',
    })
    expect(extremeDoseDraftRes.status).toBe(409)
    expect(apiErrorSchema.parse(await extremeDoseDraftRes.json()).error).toMatchObject({
      code: 'CATALOG_CONFLICT',
      reason: 'PRESCRIPTION_DOSAGE_NOT_ALLOWED',
      clinicalQuality: {
        status: 'blocked',
        redLines: [expect.objectContaining({ code: 'MEDICATION_DOSE_LIMIT_EXCEEDED', catalogItemId: 'medication-rosuvastatin' })],
      },
    })

    const dupClassDraftRes = await fixture.runtime.app.request(`http://localhost/api/his/v1/encounters/${renalVisit.encounterId}/prescription/draft`, {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${renalVisit.encounterId}`]: afterDiag.encounter.versionId },
        input: {
          expectedDraftVersion: statinAllergyDraft.data.draftVersion,
          items: [
            { catalogItemId: 'medication-pci-clopidogrel', courseDays: 1, doseText: '75 mg', frequencyCode: 'QD', routeCode: 'PO', quantity: 1 },
            { catalogItemId: 'medication-ticagrelor', courseDays: 1, doseText: '90 mg', frequencyCode: 'BID', routeCode: 'PO', quantity: 2 },
          ],
        },
      }),
      headers: { 'content-type': 'application/json', cookie: doctorCookie, 'idempotency-key': randomUUID(), origin: 'http://localhost' },
      method: 'PUT',
    })
    expect(dupClassDraftRes.status).toBe(409)
    expect(apiErrorSchema.parse(await dupClassDraftRes.json()).error).toMatchObject({
      code: 'CATALOG_CONFLICT',
      reason: 'PRESCRIPTION_COMBINATION_NOT_ALLOWED',
      clinicalQuality: {
        status: 'blocked',
        redLines: [expect.objectContaining({ code: 'MEDICATION_CLASS_DUPLICATION', catalogItemId: 'medication-ticagrelor' })],
      },
    })

    const zeroOverridesCount = z.object({ count: z.number() }).parse(
      fixture.runtime.database.driver.prepare('SELECT COUNT(*) AS count FROM clinical_quality_override WHERE workspace_id=? AND epoch=? AND patient_id=?')
        .get(scenario.workspaceId, scenario.epoch, renalVisit.patient.id),
    ).count
    expect(zeroOverridesCount).toBe(0)
    expect((await fixture.read('doctor', `/api/his/v1/doctor/cases/${renalVisit.caseId}`, doctorCaseDetailSchema)).medicationConclusion?.prescription).toBeUndefined()

    // --- 2. Outpatient Prescription: viral URI + antibiotic Tier-2 alert -> atomic Clinical Override + receipt + Audit + Trace + replay ---
    const viralVisit = await createOutpatientVisit(fixture, {
      birthDate: '1988-09-12',
      chiefComplaint: '咽痒流清涕 2 天',
      gender: 'male',
      name: '合成上感抗菌药患者',
    })
    await confirmOutpatientDiagnosis(fixture, viralVisit.encounterId, viralVisit.detail.encounter.versionId, [
      { catalogItemId: 'diagnosis-acute-upper-respiratory-infection', role: 'primary' },
    ])
    const viralAfterDiag = await fixture.read('doctor', `/api/his/v1/doctor/cases/${viralVisit.caseId}`, doctorCaseDetailSchema)
    const amoxDraft = await saveOutpatientPrescriptionDraft(fixture, viralVisit.encounterId, viralAfterDiag.encounter.versionId, [
      { catalogItemId: 'medication-amoxicillin', courseDays: 1, doseText: '500 mg', frequencyCode: 'TID', quantity: 1 },
    ])

    const abxBlocked = await fixture.request(
      'doctor',
      `/api/his/v1/encounters/${viralVisit.encounterId}/prescription/actions/issue`,
      { expectedDraftVersion: amoxDraft.data.draftVersion },
      randomUUID(),
      { [`Encounter/${viralVisit.encounterId}`]: viralAfterDiag.encounter.versionId },
    )
    expect(abxBlocked.status).toBe(409)
    expect(apiErrorSchema.parse(await abxBlocked.json()).error).toMatchObject({
      code: 'CLINICAL_QUALITY_ALERT',
      clinicalQuality: {
        alerts: [expect.objectContaining({ code: 'ANTIBIOTIC_WITHOUT_BACTERIAL_INDICATION' })],
      },
    })

    // Mismatched acknowledgedAlerts still rejected with 409
    const abxWrongCode = await fixture.request(
      'doctor',
      `/api/his/v1/encounters/${viralVisit.encounterId}/prescription/actions/issue`,
      {
        clinicalOverride: {
          reasonCode: 'clinical-judgement',
          note: '确认代码不匹配的测试说明',
          acknowledgedAlerts: ['RENAL_CREATININE_MISSING'],
        },
        expectedDraftVersion: amoxDraft.data.draftVersion,
      },
      randomUUID(),
      { [`Encounter/${viralVisit.encounterId}`]: viralAfterDiag.encounter.versionId },
    )
    expect(abxWrongCode.status).toBe(409)

    // Valid clinicalOverride commits atomically and supports same-key idempotent replay
    const abxOverride: ClinicalOverrideInput = {
      reasonCode: 'external-result-verified',
      note: '外院血常规白细胞及中性粒细胞显著升高伴扁桃体脓性渗出',
      acknowledgedAlerts: ['ANTIBIOTIC_WITHOUT_BACTERIAL_INDICATION'],
    }
    const abxKey = randomUUID()
    const issuedAbx = await parsePciResponse(
      issuePrescriptionResponseSchema,
      await fixture.request(
        'doctor',
        `/api/his/v1/encounters/${viralVisit.encounterId}/prescription/actions/issue`,
        { clinicalOverride: abxOverride, expectedDraftVersion: amoxDraft.data.draftVersion },
        abxKey,
        { [`Encounter/${viralVisit.encounterId}`]: viralAfterDiag.encounter.versionId },
      ),
    )
    const abxQualityReceipt = clinicalQualityReceiptSchema.parse(issuedAbx.clinicalQuality)
    expect(abxQualityReceipt).toMatchObject({
      gate: 'outpatient-prescription',
      override: { note: abxOverride.note, reasonCode: abxOverride.reasonCode },
      alerts: [expect.objectContaining({ code: 'ANTIBIOTIC_WITHOUT_BACTERIAL_INDICATION' })],
    })
    assertOverrideAuditAndTrace(fixture, {
      auditId: issuedAbx.auditId,
      epoch: scenario.epoch,
      gate: 'outpatient-prescription',
      operation: 'encounter.issue-prescription',
      override: abxOverride,
      overrideId: abxQualityReceipt.overrideId,
      workspaceId: scenario.workspaceId,
    })

    // Same-key replay returns identical auditId & overrideId without creating a duplicate row
    const replayedAbx = await parsePciResponse(
      issuePrescriptionResponseSchema,
      await fixture.request(
        'doctor',
        `/api/his/v1/encounters/${viralVisit.encounterId}/prescription/actions/issue`,
        { clinicalOverride: abxOverride, expectedDraftVersion: amoxDraft.data.draftVersion },
        abxKey,
        { [`Encounter/${viralVisit.encounterId}`]: viralAfterDiag.encounter.versionId },
      ),
    )
    expect(replayedAbx.auditId).toBe(issuedAbx.auditId)
    expect(replayedAbx.clinicalQuality?.overrideId).toBe(abxQualityReceipt.overrideId)
    expect(z.object({ count: z.number() }).parse(
      fixture.runtime.database.driver.prepare('SELECT COUNT(*) AS count FROM clinical_quality_override WHERE workspace_id=? AND epoch=? AND patient_id=?')
        .get(scenario.workspaceId, scenario.epoch, viralVisit.patient.id),
    ).count).toBe(1)

    const prepAbxVisit = await createOutpatientVisit(fixture, {
      birthDate: '1990-04-18',
      chiefComplaint: '咽干鼻塞 1 天',
      gender: 'female',
      name: '合成推荐处方越权审计患者',
    })
    await confirmOutpatientDiagnosis(fixture, prepAbxVisit.encounterId, prepAbxVisit.detail.encounter.versionId, [
      { catalogItemId: 'diagnosis-acute-upper-respiratory-infection', role: 'primary' },
    ])
    const prepAbxAfterDiag = await fixture.read('doctor', `/api/his/v1/doctor/cases/${prepAbxVisit.caseId}`, doctorCaseDetailSchema)
    const prepAbxConfirmed = await parsePciResponse(
      z.object({ auditId: z.string(), clinicalQuality: clinicalQualityReceiptSchema }).loose(),
      await fixture.request(
        'doctor',
        `/api/his/v1/doctor/cases/${prepAbxVisit.caseId}/recommendations/prescription/actions/confirm`,
        {
          clinicalOverride: abxOverride,
          expectedDraftVersion: 0,
          selections: [{
            kind: 'prescription',
            source: 'manual',
            catalogItemId: 'medication-amoxicillin',
            doseText: '500 mg',
            frequencyCode: 'TID',
            routeCode: 'PO',
            courseDays: 1,
            quantity: 1,
          }],
        },
        randomUUID(),
        { [`Encounter/${prepAbxVisit.encounterId}`]: prepAbxAfterDiag.encounter.versionId },
      ),
    )
    assertOverrideAuditAndTrace(fixture, {
      auditId: prepAbxConfirmed.auditId,
      epoch: scenario.epoch,
      gate: 'outpatient-prescription',
      operation: 'doctor.recommendations.confirm',
      override: abxOverride,
      overrideId: prepAbxConfirmed.clinicalQuality.overrideId,
      workspaceId: scenario.workspaceId,
    })

    // --- 3. Outpatient Completion Gate: acute chest pain without ECG or troponin ---
    const chestPainVisit = await createOutpatientVisit(fixture, {
      birthDate: '1965-07-20',
      chiefComplaint: '突发胸骨后压榨性胸痛 2 小时',
      gender: 'male',
      name: '合成急性胸痛完诊患者',
    })
    fixture.runtime.database.driver
      .prepare('INSERT INTO consultation (workspace_id, epoch, case_id, version) VALUES (?, ?, ?, 1)')
      .run(scenario.workspaceId, scenario.epoch, chestPainVisit.caseId)
    await confirmOutpatientDiagnosis(fixture, chestPainVisit.encounterId, chestPainVisit.detail.encounter.versionId, [
      { catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I25.103', role: 'primary' },
    ])
    let cpCase = await fixture.read('doctor', `/api/his/v1/doctor/cases/${chestPainVisit.caseId}`, doctorCaseDetailSchema)
    const cookie = await fixture.login('doctor')
    const savedDoc = await parsePciResponse(
      clinicalDocumentDraftResponseSchema,
      await fixture.runtime.app.request(`http://localhost/api/his/v1/encounters/${chestPainVisit.encounterId}/clinical-document/draft`, {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${chestPainVisit.encounterId}`]: cpCase.encounter.versionId },
          input: {
            expectedDraftVersion: cpCase.clinicalDocument?.draft?.version ?? 0,
            document: {
              ...defaultOutpatientGateDocument,
              chiefComplaint: '突发胸骨后压榨性胸痛 2 小时。',
              historyOfPresentIllness: '患者 2 小时前出现胸痛，外院急诊已查心电图与肌钙蛋白。',
              physicalExamination: '神志清，心率 84 次/分，律齐。',
              assessment: '冠心病待排。',
              disposition: '携外院结果转急诊留观随访。',
              followUp: '胸痛加重立即急诊。',
            },
          },
        }),
        headers: { 'content-type': 'application/json', cookie, 'idempotency-key': randomUUID(), origin: 'http://localhost' },
        method: 'PUT',
      }),
    )
    const signPreview = await parsePciResponse(
      clinicalDocumentSignPreviewResponseSchema,
      await fixture.request(
        'doctor',
        `/api/his/v1/encounters/${chestPainVisit.encounterId}/clinical-document/actions/preview-sign`,
        { expectedDraftVersion: savedDoc.data.draftVersion },
        randomUUID(),
        { [`Encounter/${chestPainVisit.encounterId}`]: cpCase.encounter.versionId },
      ),
    )
    await parsePciResponse(
      clinicalDocumentSignResponseSchema,
      await fixture.request(
        'doctor',
        `/api/his/v1/encounters/${chestPainVisit.encounterId}/clinical-document/actions/sign`,
        { commitToken: signPreview.data.commitToken, previewId: signPreview.data.previewId },
        randomUUID(),
        { [`Encounter/${chestPainVisit.encounterId}`]: cpCase.encounter.versionId },
      ),
    )
    cpCase = await fixture.read('doctor', `/api/his/v1/doctor/cases/${chestPainVisit.caseId}`, doctorCaseDetailSchema)
    await parsePciResponse(
      confirmNoMedicationResponseSchema,
      await fixture.request(
        'doctor',
        `/api/his/v1/encounters/${chestPainVisit.encounterId}/medication-conclusion/actions/confirm-no-medication`,
        { expectedDraftVersion: cpCase.medicationConclusion?.draftVersion ?? 0 },
        randomUUID(),
        { [`Encounter/${chestPainVisit.encounterId}`]: cpCase.encounter.versionId },
      ),
    )
    cpCase = await fixture.read('doctor', `/api/his/v1/doctor/cases/${chestPainVisit.caseId}`, doctorCaseDetailSchema)

    const preflightCompletion = await fixture.read(
      'doctor',
      `/api/his/v1/encounters/${chestPainVisit.encounterId}/clinical-quality?gate=outpatient-completion`,
      clinicalQualityCheckSchema,
    )
    expect(preflightCompletion.alerts).toMatchObject([{ code: 'CHEST_PAIN_WORKUP_INCOMPLETE', tier: 'alert' }])

    const completeBlocked = await fixture.request(
      'doctor',
      `/api/his/v1/encounters/${chestPainVisit.encounterId}/actions/complete`,
      {},
      randomUUID(),
      { [`Encounter/${chestPainVisit.encounterId}`]: cpCase.encounter.versionId },
    )
    expect(completeBlocked.status).toBe(409)
    expect(apiErrorSchema.parse(await completeBlocked.json()).error).toMatchObject({
      code: 'CLINICAL_QUALITY_ALERT',
      clinicalQuality: { alerts: [expect.objectContaining({ code: 'CHEST_PAIN_WORKUP_INCOMPLETE' })] },
    })

    const completionOverride: ClinicalOverrideInput = {
      reasonCode: 'external-result-verified',
      note: '已核对外院急诊12导联心电图及高敏肌钙蛋白I阴性报告原件',
      acknowledgedAlerts: ['CHEST_PAIN_WORKUP_INCOMPLETE'],
    }
    const completeKey = randomUUID()
    const completed = await parsePciResponse(
      encounterCompletionResponseSchema,
      await fixture.request(
        'doctor',
        `/api/his/v1/encounters/${chestPainVisit.encounterId}/actions/complete`,
        { clinicalOverride: completionOverride },
        completeKey,
        { [`Encounter/${chestPainVisit.encounterId}`]: cpCase.encounter.versionId },
      ),
    )
    expect(completed.data.status).toBe('completed')
    const completionReceipt = clinicalQualityReceiptSchema.parse(completed.clinicalQuality)
    assertOverrideAuditAndTrace(fixture, {
      auditId: completed.auditId,
      epoch: scenario.epoch,
      gate: 'outpatient-completion',
      operation: 'encounter.complete',
      override: completionOverride,
      overrideId: completionReceipt.overrideId,
      workspaceId: scenario.workspaceId,
    })

    const replayedComplete = await parsePciResponse(
      encounterCompletionResponseSchema,
      await fixture.request(
        'doctor',
        `/api/his/v1/encounters/${chestPainVisit.encounterId}/actions/complete`,
        { clinicalOverride: completionOverride },
        completeKey,
        { [`Encounter/${chestPainVisit.encounterId}`]: cpCase.encounter.versionId },
      ),
    )
    expect(replayedComplete.auditId).toBe(completed.auditId)
  }, 90_000)

  it('enforces inpatient order, non-ischemic PCI plan, discharge & post-discharge record gates, carry-over, and post-recall re-evaluation', async () => {
    const prepared = await preparePciPaymentDrgFixture()
    const fixture = await createPciPaymentDrgFixture(prepared)
    fixtures.push(fixture)
    const scenario = await fixture.read('admin', '/api/sim/v1/scenario-runs/current', scenarioStateSchema)

    // Admit patient with CAD (I25.103) + Heart Failure (I50.900, matches dapagliflozin/spironolactone)
    const stay = await fixture.preparePciAdmission([])
    const initialClinical = await fixture.read('inpatient-doctor', `${stay.path}/clinical`, inpatientFullClinicalSchema)
    await parsePciResponse(
      inpatientFullClinicalResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/diagnoses/confirm`, {
        encounterVersion: initialClinical.encounterVersion,
        expectedRevision: initialClinical.diagnosis.revision,
        entries: [
          { catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I25.103', role: 'primary', admissionCondition: '1' },
          { catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I50.900', role: 'secondary', admissionCondition: '1' },
        ],
      }),
    )
    const catalog = await fixture.read('inpatient-doctor', '/api/his/v1/inpatient/clinical-catalog', inpatientFullCatalogSchema)
    const spironolactone = catalog.medications.find(item => item.id === 'medication-spironolactone')!
    const dapagliflozin = catalog.medications.find(item => item.id === 'medication-dapagliflozin')!
    const atorvastatin = catalog.medications.find(item => item.id === 'medication-pci-atorvastatin')!
    const rosuvastatin = catalog.medications.find(item => item.id === 'medication-rosuvastatin')!

    // Preflight dose limit: tablet formulation ("2 片" = 20 mg) converts via inpatientDoseBasis without false positive; extreme dose ("10 片" = 100 mg > 80 mg) blocks
    const preflightValidTablet = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/clinical-quality?gate=inpatient-order&catalogItemId=${atorvastatin.id}&doseText=${encodeURIComponent('2 片')}&frequencyCode=QN`,
      clinicalQualityCheckSchema,
    )
    expect(preflightValidTablet).toMatchObject({ status: 'pass', redLines: [], alerts: [] })

    const preflightDoseLimit = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/clinical-quality?gate=inpatient-order&catalogItemId=${atorvastatin.id}&doseText=${encodeURIComponent('10 片')}&frequencyCode=QN`,
      clinicalQualityCheckSchema,
    )
    expect(preflightDoseLimit).toMatchObject({
      status: 'blocked',
      redLines: [expect.objectContaining({ code: 'MEDICATION_DOSE_LIMIT_EXCEEDED', catalogItemId: atorvastatin.id })],
    })

    // --- 1. Inpatient Order Gate: missing creatinine vs proven eGFR < 30 ---
    const preflightOrderMissingCr = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/clinical-quality?gate=inpatient-order&catalogItemId=${spironolactone.id}&doseText=20%20mg&frequencyCode=QD`,
      clinicalQualityCheckSchema,
    )
    expect(preflightOrderMissingCr.redLines).toEqual([])
    expect(preflightOrderMissingCr.alerts).toMatchObject([{ code: 'RENAL_CREATININE_MISSING', catalogItemId: spironolactone.id }])

    let clinical = await fixture.read('inpatient-doctor', `${stay.path}/clinical`, inpatientFullClinicalSchema)
    const blockedOrderRes = await fixture.request('inpatient-doctor', `${stay.path}/orders/issue`, {
      encounterVersion: clinical.encounterVersion,
      duration: 'temporary',
      selection: {
        kind: 'medication',
        catalogItemId: spironolactone.id,
        catalogVersion: spironolactone.version,
        doseText: '20 mg',
        doseQuantity: 1,
        frequencyCode: 'ONCE',
        routeCode: 'PO',
      },
    })
    expect(blockedOrderRes.status).toBe(409)
    expect(apiErrorSchema.parse(await blockedOrderRes.json()).error.code).toBe('CLINICAL_QUALITY_ALERT')

    const mraOverride: ClinicalOverrideInput = {
      reasonCode: 'result-pending-follow-up',
      note: '已同步开立急查肾功能与电解质，首剂螺内酯后按回报调整',
      acknowledgedAlerts: ['RENAL_CREATININE_MISSING'],
    }
    const mraOrderKey = randomUUID()
    const issuedMra = await parsePciResponse(
      inpatientFullClinicalResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/orders/issue`, {
        clinicalOverride: mraOverride,
        encounterVersion: clinical.encounterVersion,
        duration: 'temporary',
        selection: {
          kind: 'medication',
          catalogItemId: spironolactone.id,
          catalogVersion: spironolactone.version,
          doseText: '20 mg',
          doseQuantity: 1,
          frequencyCode: 'ONCE',
        routeCode: 'PO',
        },
      }, mraOrderKey),
    )
    const mraReceipt = clinicalQualityReceiptSchema.parse(issuedMra.clinicalQuality)
    assertOverrideAuditAndTrace(fixture, {
      auditId: issuedMra.auditId,
      epoch: scenario.epoch,
      gate: 'inpatient-order',
      operation: 'inpatient.order.issue',
      override: mraOverride,
      overrideId: mraReceipt.overrideId,
      workspaceId: scenario.workspaceId,
    })
    // Stop & verify-stop the temporary MRA order so discharge won't be blocked by active orders later
    const mraOrder = issuedMra.data.orders.find(item => item.catalogItemId === spironolactone.id)!
    const stopReq = await parsePciResponse(
      inpatientFullClinicalResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/orders/request-stop`, {
        orderId: mraOrder.id,
        expectedOrderVersion: mraOrder.version,
        reason: '测试收口停嘱',
      }),
    )
    await parsePciResponse(
      inpatientFullClinicalResponseSchema,
      await fixture.request('ward-nurse', `${stay.path}/orders/verify-stop`, {
        orderId: mraOrder.id,
        expectedOrderVersion: stopReq.data.orders.find(item => item.id === mraOrder.id)!.version,
      }),
    )

    // Insert proven low eGFR (< 30, SCr = 3.6 mg/dL) -> dapagliflozin is hard-blocked with 409 CLINICAL_QUALITY_RED_LINE even with override!
    insertSerumCreatinineReport(fixture, {
      caseId: stay.admissionId,
      encounterId: stay.admissionId,
      epoch: scenario.epoch,
      patientId: stay.patientId,
      valueMgDl: 3.6,
      workspaceId: scenario.workspaceId,
    })
    clinical = await fixture.read('inpatient-doctor', `${stay.path}/clinical`, inpatientFullClinicalSchema)
    const dapaOrderBlocked = await fixture.request('inpatient-doctor', `${stay.path}/orders/issue`, {
      clinicalOverride: mraOverride,
      encounterVersion: clinical.encounterVersion,
      duration: 'temporary',
      selection: {
        kind: 'medication',
        catalogItemId: dapagliflozin.id,
        catalogVersion: dapagliflozin.version,
        doseText: '10 mg',
        doseQuantity: 1,
        frequencyCode: 'ONCE',
        routeCode: 'PO',
      },
    })
    expect(dapaOrderBlocked.status).toBe(409)
    expect(apiErrorSchema.parse(await dapaOrderBlocked.json()).error).toMatchObject({
      code: 'CLINICAL_QUALITY_RED_LINE',
      clinicalQuality: {
        redLines: [expect.objectContaining({ code: 'RENAL_CONTRAINDICATED_MEDICATION', catalogItemId: dapagliflozin.id })],
      },
    })

    // Also verify class duplication red line (`MEDICATION_CLASS_DUPLICATION`) on inpatient preflight & hard-block on issue even with override!
    const issuedAtorva = await parsePciResponse(
      inpatientFullClinicalResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/orders/issue`, {
        encounterVersion: clinical.encounterVersion,
        duration: 'temporary',
        selection: {
          kind: 'medication',
          catalogItemId: atorvastatin.id,
          catalogVersion: atorvastatin.version,
          doseText: '20 mg',
          doseQuantity: 2,
          frequencyCode: 'ONCE',
        routeCode: 'PO',
        },
      }),
    )
    const preflightDup = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/clinical-quality?gate=inpatient-order&catalogItemId=${rosuvastatin.id}&doseText=10%20mg&frequencyCode=QN`,
      clinicalQualityCheckSchema,
    )
    expect(preflightDup.redLines.map(item => item.code)).toContain('MEDICATION_CLASS_DUPLICATION')
    const dupOrderBlocked = await fixture.request('inpatient-doctor', `${stay.path}/orders/issue`, {
      clinicalOverride: mraOverride,
      encounterVersion: issuedAtorva.data.encounterVersion,
      duration: 'temporary',
      selection: {
        kind: 'medication',
        catalogItemId: rosuvastatin.id,
        catalogVersion: rosuvastatin.version,
        doseText: '10 mg',
        doseQuantity: 1,
        frequencyCode: 'ONCE',
        routeCode: 'PO',
      },
    })
    expect(dupOrderBlocked.status).toBe(409)
    expect(apiErrorSchema.parse(await dupOrderBlocked.json()).error).toMatchObject({
      code: 'CATALOG_CONFLICT',
      reason: 'MEDICATION_COMBINATION_NOT_ALLOWED',
      clinicalQuality: {
        status: 'blocked',
        redLines: [expect.objectContaining({ code: 'MEDICATION_CLASS_DUPLICATION', catalogItemId: rosuvastatin.id })],
      },
    })
    const atorvaOrder = issuedAtorva.data.orders.find(item => item.catalogItemId === atorvastatin.id)!
    const stopAtorva = await parsePciResponse(
      inpatientFullClinicalResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/orders/request-stop`, {
        orderId: atorvaOrder.id,
        expectedOrderVersion: atorvaOrder.version,
        reason: '测试互斥停嘱',
      }),
    )
    const stoppedAtorva = await parsePciResponse(
      inpatientFullClinicalResponseSchema,
      await fixture.request('ward-nurse', `${stay.path}/orders/verify-stop`, {
        orderId: atorvaOrder.id,
        expectedOrderVersion: stopAtorva.data.orders.find(item => item.id === atorvaOrder.id)!.version,
      }),
    )

    // Also verify inpatient dose-limit & allergy red lines on `orders/issue` return `error.clinicalQuality` (`status: 'blocked'`) alongside legacy `reason`
    const doseOrderBlocked = await fixture.request('inpatient-doctor', `${stay.path}/orders/issue`, {
      clinicalOverride: mraOverride,
      encounterVersion: stoppedAtorva.data.encounterVersion,
      duration: 'temporary',
      selection: {
        kind: 'medication',
        catalogItemId: rosuvastatin.id,
        catalogVersion: rosuvastatin.version,
        doseText: '80 mg',
        doseQuantity: 8,
        frequencyCode: 'ONCE',
        routeCode: 'PO',
      },
    })
    expect(doseOrderBlocked.status).toBe(409)
    expect(apiErrorSchema.parse(await doseOrderBlocked.json()).error).toMatchObject({
      code: 'CATALOG_CONFLICT',
      reason: 'MEDICATION_DOSAGE_NOT_ALLOWED',
      clinicalQuality: {
        status: 'blocked',
        redLines: [expect.objectContaining({ code: 'MEDICATION_DOSE_LIMIT_EXCEEDED', catalogItemId: rosuvastatin.id })],
      },
    })

    fixture.runtime.fhir.create({ workspaceId: scenario.workspaceId, epoch: scenario.epoch }, {
      resourceType: 'AllergyIntolerance',
      id: uuidv7(),
      category: ['medication'],
      clinicalStatus: { coding: [{ code: 'active' }] },
      verificationStatus: { coding: [{ code: 'confirmed' }] },
      code: { coding: [{ code: 'ROSUVASTATIN', display: '瑞舒伐他汀过敏' }] },
      patient: { reference: `Patient/${stay.patientId}` },
    })
    const allergyOrderBlocked = await fixture.request('inpatient-doctor', `${stay.path}/orders/issue`, {
      clinicalOverride: mraOverride,
      encounterVersion: stoppedAtorva.data.encounterVersion,
      duration: 'temporary',
      selection: {
        kind: 'medication',
        catalogItemId: rosuvastatin.id,
        catalogVersion: rosuvastatin.version,
        doseText: '10 mg',
        doseQuantity: 1,
        frequencyCode: 'ONCE',
        routeCode: 'PO',
      },
    })
    expect(allergyOrderBlocked.status).toBe(409)
    expect(apiErrorSchema.parse(await allergyOrderBlocked.json()).error).toMatchObject({
      code: 'CATALOG_CONFLICT',
      reason: 'MEDICATION_ALLERGY_CONFLICT',
      clinicalQuality: {
        status: 'blocked',
        redLines: [expect.objectContaining({ code: 'MEDICATION_ALLERGY_CONFLICT', catalogItemId: rosuvastatin.id })],
      },
    })

    // --- 2. Inpatient Gate 3: non-ischemic lesion (FFR = 0.86 > 0.80) on surgery.request & pci-selection.confirm ---
    const angioExec = await fixture.executeAngiography(stay)
    await fixture.runtime.dispatchPending()
    const scheduledAngio = z.object({ report_id: z.string() }).parse(
      fixture.runtime.database.driver
        .prepare('SELECT report_id FROM inpatient_angiography_report WHERE workspace_id=? AND epoch=? AND admission_id=? AND procedure_id=?')
        .get(scenario.workspaceId, scenario.epoch, stay.admissionId, angioExec.id),
    )
    const nonIschemicReport = inpatientAngiographyReportSchema.parse({
      id: scheduledAngio.report_id,
      version: 1,
      admissionId: stay.admissionId,
      procedureId: angioExec.id,
      status: 'final',
      synthetic: true,
      targetSite: '前降支中段',
      measurements: [
        { kind: 'lesion-length', object: 'lesion', site: '前降支中段', value: 12, unit: 'mm', method: 'QCA', source: { reference: `DiagnosticReport/${scheduledAngio.report_id}`, version: '1', note: '合成QCA', synthetic: true } },
        { kind: 'proximal-reference-diameter', object: 'reference-lumen', site: '前降支中段', value: 3, unit: 'mm', method: 'QCA', source: { reference: `DiagnosticReport/${scheduledAngio.report_id}`, version: '1', note: '合成QCA', synthetic: true } },
        { kind: 'distal-reference-diameter', object: 'reference-lumen', site: '前降支中段', value: 3, unit: 'mm', method: 'QCA', source: { reference: `DiagnosticReport/${scheduledAngio.report_id}`, version: '1', note: '合成QCA', synthetic: true } },
      ],
      vessels: [{
        vessel: 'LAD',
        segment: '前降支中段',
        stenosisPercent: 60,
        timiFlow: 3,
        lesionCharacteristics: '局限性临界病变',
        ffr: 0.86,
      }],
      conclusion: '前降支中段临界狭窄，功能学非缺血病变（FFR 0.86）。',
      missing: [],
      issuedAt: '2026-08-24T10:00:00+08:00',
    })
    fixture.runtime.database.driver
      .prepare('UPDATE inpatient_angiography_report SET report_json=? WHERE workspace_id=? AND epoch=? AND admission_id=? AND procedure_id=?')
      .run(JSON.stringify(nonIschemicReport), scenario.workspaceId, scenario.epoch, stay.admissionId, angioExec.id)

    const preflightPci = await fixture.read('inpatient-doctor', `${stay.path}/clinical-quality?gate=inpatient-pci-plan`, clinicalQualityCheckSchema)
    expect(preflightPci).toMatchObject({ status: 'alert', alerts: [{ code: 'PCI_NON_ISCHEMIC_LESION', tier: 'alert' }] })
    const inpatientQueryOverrideRes = await fixture.request('inpatient-doctor', `${stay.path}/clinical-quality?gate=inpatient-pci-plan&admissionId=other-admission`)
    expect(inpatientQueryOverrideRes.status).toBe(400)

    // Step 2 `material-estimates/confirm` CANNOT bypass Gate 3 when pre-report PCI request (`stay.requestId`) has auto-generated `inpatient_pci_selection_draft` and `confirmation === null`!
    const estimatesBefore = await fixture.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)
    const targetEst = estimatesBefore.estimates.find(item => item.requestId === stay.requestId)!
    const savedEst = (await parsePciResponse(
      inpatientMaterialEstimateResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/material-estimates/save`, {
        requestId: stay.requestId,
        expectedVersion: targetEst.version,
        expectedDraftRevision: targetEst.draft?.revision ?? 0,
        expectedBasisFingerprint: targetEst.basisFingerprint,
        analysisId: null,
        items: targetEst.candidates.filter(c => c.item !== null && c.materialId !== 'hospital-material-pci-stent-equivalent-b').map(c => ({ materialId: c.materialId, catalogVersion: c.catalogVersion, quantity: 1, reason: c.quantityBasis })),
        note: '拟确认耗材测试门禁',
      }),
    )).data
    const resList = await fixture.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
    const bypassAttempt = await fixture.request('inpatient-doctor', `${stay.path}/material-estimates/confirm`, {
      requestId: stay.requestId,
      expectedVersion: savedEst.version,
      expectedDraftRevision: savedEst.draft!.revision,
      expectedBasisFingerprint: savedEst.basisFingerprint,
      expectedRequestVersion: savedEst.requestVersion,
      encounterVersion: resList.encounterVersion,
      expectedReservationFingerprint: resList.reservationSets.find(s => s.requestId === stay.requestId)!.fingerprint,
      reason: '尝试绕过PCI选型门禁确认耗材',
    })
    expect(bypassAttempt.status).toBe(409)
    expect(apiErrorSchema.parse(await bypassAttempt.json()).error).toMatchObject({
      code: 'CLINICAL_QUALITY_ALERT',
      clinicalQuality: { alerts: [expect.objectContaining({ code: 'PCI_NON_ISCHEMIC_LESION' })] },
    })

    // Even if a newer ischemic angiography report exists on the same admission, confirming `stay.requestId` evaluates its bound `scheduledAngio.report_id` (FFR 0.86)!
    const angioProc = stay.catalog.procedures.find(item => item.coding.code === '88.5500')!
    const admBefore2 = await fixture.read('inpatient-doctor', stay.path, inpatientDetailSchema)
    const req2Resp = await parsePciResponse(inpatientSurgeryResponseSchema, await fixture.request('inpatient-doctor', `${stay.path}/surgeries/request`, {
      anesthesiaMethod: 'local-infiltration', preopOrderPolicy: 'continue-active',
      encounterVersion: admBefore2.admission.versionId,
      locationId: 'location-catheterization-lab',
      procedureId: angioProc.id,
      catalogVersion: angioProc.version,
      plannedFor: '2026-08-24T15:30:00+08:00',
      reason: '复查冠脉造影',
      surgeonPractitionerId: 'practitioner-inpatient-doctor',
      surgeryType: 'elective',
    }))
    const angioReq2Id = req2Resp.data.requests.find(item => item.plannedProcedure.id === angioProc.id && item.status === 'requested')!.id
    const clinicalBefore2 = await fixture.read('inpatient-doctor', `${stay.path}/clinical`, inpatientFullClinicalSchema)
    for (const [role, action] of [['ward-nurse', 'check-preop'], ['inpatient-doctor', 'confirm-consent']] as const) {
      const surg = await fixture.read('inpatient-doctor', `${stay.path}/surgeries`, inpatientSurgerySchema)
      await parsePciResponse(inpatientSurgeryResponseSchema, await fixture.request(role, `${stay.path}/surgeries/${action}`, {
        requestId: angioReq2Id,
        expectedRequestVersion: surg.requests.find(item => item.id === angioReq2Id)!.version,
        ...(action === 'confirm-consent'
          ? { expectedDiagnosisRevision: clinicalBefore2.diagnosis.revision, patientChoice: 'agree', signerName: admBefore2.admission.patientName, signerRole: 'patient' }
          : {}),
        note: '复查造影术前准备',
      }))
    }
    await fixture.dispensePciMedications(stay, 'intraoperative')
    const surgReady2 = await fixture.read('inpatient-doctor', `${stay.path}/surgeries`, inpatientSurgerySchema)
    const angioExec2 = (await parsePciResponse(inpatientSurgeryResponseSchema, await fixture.request('inpatient-doctor', `${stay.path}/surgeries/execute`, {
      requestId: angioReq2Id,
      expectedRequestVersion: surgReady2.requests.find(item => item.id === angioReq2Id)!.version,
      procedureId: angioProc.id,
      catalogVersion: angioProc.version,
      note: '复查冠脉造影执行',
      materials: [],
    }))).data.executions.find(item => item.requestId === angioReq2Id)!
    await fixture.runtime.dispatchPending()
    const scheduledAngio2 = z.object({ report_id: z.string() }).parse(
      fixture.runtime.database.driver
        .prepare('SELECT report_id FROM inpatient_angiography_report WHERE workspace_id=? AND epoch=? AND admission_id=? AND procedure_id=?')
        .get(scenario.workspaceId, scenario.epoch, stay.admissionId, angioExec2.id),
    )
    const newerIschemicReport = inpatientAngiographyReportSchema.parse({
      ...nonIschemicReport,
      id: scheduledAngio2.report_id,
      procedureId: angioExec2.id,
      issuedAt: '2026-08-24T11:30:00+08:00',
      vessels: [{
        vessel: 'RCA',
        segment: '右冠中段',
        stenosisPercent: 85,
        timiFlow: 3,
        lesionCharacteristics: '缺血病变',
        ffr: 0.72,
      }],
    })
    fixture.runtime.database.driver
      .prepare('UPDATE inpatient_angiography_report SET report_json=? WHERE workspace_id=? AND epoch=? AND admission_id=? AND procedure_id=?')
      .run(JSON.stringify(newerIschemicReport), scenario.workspaceId, scenario.epoch, stay.admissionId, angioExec2.id)

    const selBefore = await fixture.read('inpatient-doctor', `${stay.path}/pci-selection`, inpatientPciSelectionSchema)
    const confirmPciBlocked = await fixture.request('inpatient-doctor', `${stay.path}/pci-selection/confirm`, {
      expectedVersion: selBefore.confirmation?.version ?? 0,
      parameters: {
        requestId: stay.requestId,
        treatmentPlan: '拟行前降支支架置入',
        targetSite: '前降支中段',
        measurements: [],
        plannedQuantities: [],
        approvedMaterialIds: [],
      },
    })
    expect(confirmPciBlocked.status).toBe(409)
    expect(apiErrorSchema.parse(await confirmPciBlocked.json()).error).toMatchObject({
      code: 'CLINICAL_QUALITY_ALERT',
      clinicalQuality: {
        alerts: [expect.objectContaining({
          code: 'PCI_NON_ISCHEMIC_LESION',
          evidence: [expect.objectContaining({ reference: `DiagnosticReport/${scheduledAngio.report_id}` })],
        })],
      },
    })
    fixture.runtime.database.driver
      .prepare('DELETE FROM inpatient_angiography_report WHERE workspace_id=? AND epoch=? AND report_id=?')
      .run(scenario.workspaceId, scenario.epoch, scheduledAngio2.report_id)

    // Cancel the initial request, then verify `inpatient.surgery.request` for PCI (`36.0700`) is also gated and carries over to `pci-selection.confirm`
    const surgeriesBefore = await fixture.read('inpatient-doctor', `${stay.path}/surgeries`, inpatientSurgerySchema)
    const initialReq = surgeriesBefore.requests.find(item => item.id === stay.requestId)!
    await parsePciResponse(
      inpatientSurgeryResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/surgeries/cancel`, {
        requestId: initialReq.id,
        expectedRequestVersion: initialReq.version,
        note: '先取消旧计划以验证新 PCI 申请质控门禁',
      }),
    )
    const surgeryCatalog = await fixture.read('inpatient-doctor', '/api/his/v1/inpatient/surgery-catalog', inpatientSurgeryCatalogSchema)
    const pciProc = surgeryCatalog.procedures.find(item => item.coding.code === '36.0700')!
    const surgeriesNow = await fixture.read('inpatient-doctor', `${stay.path}/surgeries`, inpatientSurgerySchema)
    const pciReqBlocked = await fixture.request('inpatient-doctor', `${stay.path}/surgeries/request`, {
      anesthesiaMethod: 'local-infiltration', preopOrderPolicy: 'continue-active',
      encounterVersion: surgeriesNow.encounterVersion,
      locationId: 'location-catheterization-lab',
      procedureId: pciProc.id,
      catalogVersion: pciProc.version,
      plannedFor: '2026-08-24T16:00:00.000Z',
      reason: '申请PCI支架植入',
      surgeonPractitionerId: 'practitioner-inpatient-doctor',
      surgeryType: 'elective',
    })
    expect(pciReqBlocked.status).toBe(409)
    expect(apiErrorSchema.parse(await pciReqBlocked.json()).error.code).toBe('CLINICAL_QUALITY_ALERT')

    const pciOverride: ClinicalOverrideInput = {
      reasonCode: 'clinical-judgement',
      note: '腔内影像示薄纤维帽易损斑块伴反复静息胸痛，经心脏团队讨论拟介入处理',
      acknowledgedAlerts: ['PCI_NON_ISCHEMIC_LESION'],
    }
    const createdPciReq = await parsePciResponse(
      inpatientSurgeryResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/surgeries/request`, {
        anesthesiaMethod: 'local-infiltration', preopOrderPolicy: 'continue-active',
        clinicalOverride: pciOverride,
        encounterVersion: surgeriesNow.encounterVersion,
        locationId: 'location-catheterization-lab',
        procedureId: pciProc.id,
        catalogVersion: pciProc.version,
        plannedFor: '2026-08-24T16:00:00.000Z',
        reason: '申请PCI支架植入',
        surgeonPractitionerId: 'practitioner-inpatient-doctor',
        surgeryType: 'elective',
      }),
    )
    expect(clinicalQualityReceiptSchema.parse(createdPciReq.clinicalQuality)).toMatchObject({
      gate: 'inpatient-pci-plan',
      override: { reasonCode: 'clinical-judgement' },
    })
    const newReq = createdPciReq.data.requests.find(item => item.status === 'requested')!

    // No silent carry-over: `inpatient.pci-selection.confirm` also requires its own explicit `clinicalOverride` and writes its own audit receipt!
    const selAfterReq = await fixture.read('inpatient-doctor', `${stay.path}/pci-selection`, inpatientPciSelectionSchema)
    const selectionWithoutOverride = await fixture.request('inpatient-doctor', `${stay.path}/pci-selection/confirm`, {
      expectedVersion: selAfterReq.confirmation?.version ?? 0,
      parameters: {
        requestId: newReq.id,
        treatmentPlan: '拟行前降支支架置入',
        targetSite: '前降支中段',
        measurements: [],
        plannedQuantities: [],
        approvedMaterialIds: [],
      },
    })
    expect(selectionWithoutOverride.status).toBe(409)
    const confirmedSelection = await parsePciResponse(
      inpatientPciSelectionResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/pci-selection/confirm`, {
        clinicalOverride: pciOverride,
        expectedVersion: selAfterReq.confirmation?.version ?? 0,
        parameters: {
          requestId: newReq.id,
          treatmentPlan: '拟行前降支支架置入',
          targetSite: '前降支中段',
          measurements: [],
          plannedQuantities: [],
          approvedMaterialIds: [],
        },
      }),
    )
    expect(confirmedSelection.data.confirmation?.version).toBe((selAfterReq.confirmation?.version ?? 0) + 1)
    expect(clinicalQualityReceiptSchema.parse(confirmedSelection.clinicalQuality)).toMatchObject({
      gate: 'inpatient-pci-plan',
      override: { reasonCode: 'clinical-judgement' },
    })

    // Even after a prior PCI selection confirmation exists on the admission, editing the draft (`confirmedSelectionVersion === null`) still blocks `material-estimates/confirm`!
    const initialDraftParams = selAfterReq.drafts!.find(item => item.requestId === newReq.id)!.parameters
    const confirmedDraftVer = confirmedSelection.data.drafts!.find(item => item.requestId === newReq.id)!.version
    await parsePciResponse(
      inpatientPciSelectionResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/pci-selection/save`, {
        requestId: newReq.id,
        expectedDraftVersion: confirmedDraftVer,
        parameters: initialDraftParams,
      }),
    )
    const estAfterPriorConfirm = (await fixture.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates.find(item => item.requestId === newReq.id)!
    const savedEstAfterPriorConfirm = (await parsePciResponse(
      inpatientMaterialEstimateResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/material-estimates/save`, {
        requestId: newReq.id,
        expectedVersion: estAfterPriorConfirm.version,
        expectedDraftRevision: estAfterPriorConfirm.draft?.revision ?? 0,
        expectedBasisFingerprint: estAfterPriorConfirm.basisFingerprint,
        analysisId: null,
        items: estAfterPriorConfirm.candidates.filter(c => c.item !== null && c.materialId !== 'hospital-material-pci-stent-equivalent-b').map(c => ({ materialId: c.materialId, catalogVersion: c.catalogVersion, quantity: 1, reason: c.quantityBasis })),
        note: '已有历史确认后再次修改未确认选型草稿验证门禁',
      }),
    )).data
    const resAfterPriorConfirm = await fixture.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
    const bypassAfterPriorConfirm = await fixture.request('inpatient-doctor', `${stay.path}/material-estimates/confirm`, {
      requestId: newReq.id,
      expectedVersion: savedEstAfterPriorConfirm.version,
      expectedDraftRevision: savedEstAfterPriorConfirm.draft!.revision,
      expectedBasisFingerprint: savedEstAfterPriorConfirm.basisFingerprint,
      expectedRequestVersion: savedEstAfterPriorConfirm.requestVersion,
      encounterVersion: resAfterPriorConfirm.encounterVersion,
      expectedReservationFingerprint: resAfterPriorConfirm.reservationSets.find(s => s.requestId === newReq.id)!.fingerprint,
      reason: '验证未确认草稿不可借由已有历史确认绕过门禁',
    })
    expect(bypassAfterPriorConfirm.status).toBe(409)
    expect(apiErrorSchema.parse(await bypassAfterPriorConfirm.json()).error).toMatchObject({
      code: 'CLINICAL_QUALITY_ALERT',
      clinicalQuality: { alerts: [expect.objectContaining({ code: 'PCI_NON_ISCHEMIC_LESION' })] },
    })

    // Cancel pending surgery so discharge can proceed
    await parsePciResponse(
      inpatientSurgeryResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/surgeries/cancel`, {
        requestId: newReq.id,
        expectedRequestVersion: newReq.version,
        note: '改为保守药物治疗准备出院',
      }),
    )

    // --- 3. Inpatient Gate 4: Discharge & Post-Discharge Record Submission + Recall Re-evaluation ---
    const preflightDischarge = await fixture.read('inpatient-doctor', `${stay.path}/clinical-quality?gate=inpatient-discharge`, clinicalQualityCheckSchema)
    expect(preflightDischarge.alerts.map(item => item.code)).toEqual(['DISCHARGE_ANTIPLATELET_MISSING', 'DISCHARGE_STATIN_MISSING'])

    // In-stay `inpatient.record.submit` (while still admitted) saves pre-grouping snapshot WITHOUT triggering discharge alerts
    const inStayRecord = await fixture.read('inpatient-doctor', `${stay.path}/record`, inpatientRecordSchema)
    const inStaySubmit = await parsePciResponse(
      inpatientRecordResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/record/submit`, {
        expectedRevision: inStayRecord.revision?.revision ?? 0,
        expectedSourcesHash: inStayRecord.sourcesHash,
        mainProcedureExecutionId: angioExec.id,
      }),
    )
    expect(inStaySubmit.data.revision?.revision).toBe(1)

    // `inpatient.discharge.issue` without override -> 409 CLINICAL_QUALITY_ALERT
    const admBeforeDischarge = await fixture.read('inpatient-doctor', stay.path, inpatientDetailSchema)
    const dischargeBlocked = await fixture.request('inpatient-doctor', `${stay.path}/discharge/issue`, {
      encounterVersion: admBeforeDischarge.admission.versionId,
      reason: '病情平稳拟出院',
    })
    expect(dischargeBlocked.status).toBe(409)
    expect(apiErrorSchema.parse(await dischargeBlocked.json()).error).toMatchObject({
      code: 'CLINICAL_QUALITY_ALERT',
      clinicalQuality: {
        alerts: [
          expect.objectContaining({ code: 'DISCHARGE_ANTIPLATELET_MISSING' }),
          expect.objectContaining({ code: 'DISCHARGE_STATIN_MISSING' }),
        ],
      },
    })

    // Issue discharge WITH valid clinicalOverride -> 200
    const dischargeOverride: ClinicalOverrideInput = {
      reasonCode: 'documented-contraindication',
      note: '合并近期消化道出血高危及转氨酶异常，暂缓抗血小板与他汀长期医嘱',
      acknowledgedAlerts: ['DISCHARGE_ANTIPLATELET_MISSING', 'DISCHARGE_STATIN_MISSING'],
    }
    const issuedDischarge1 = await parsePciResponse(
      inpatientDischargeResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/discharge/issue`, {
        clinicalOverride: dischargeOverride,
        encounterVersion: admBeforeDischarge.admission.versionId,
        reason: '记录禁忌说明后开立出院医嘱',
      }),
    )
    expect(issuedDischarge1.data.admission.status).toBe('discharge-pending')
    expect(clinicalQualityReceiptSchema.parse(issuedDischarge1.clinicalQuality)).toMatchObject({
      gate: 'inpatient-discharge',
      override: { reasonCode: 'documented-contraindication' },
    })

    // Depart -> advance virtual time 5m -> Recall -> re-issuing discharge WITHOUT override must NOT reuse pre-recall override!
    const departed1 = await parsePciResponse(
      inpatientDischargeResponseSchema,
      await fixture.request('ward-nurse', `${stay.path}/discharge/depart`, {
        encounterVersion: issuedDischarge1.data.admission.versionId,
        reason: '护士办理离院',
        departureMethod: 'home',
      }),
    )
    const currentScenario = await fixture.read('admin', '/api/sim/v1/scenario-runs/current', scenarioStateSchema)
    await parsePciResponse(
      advanceVirtualTimeResponseSchema,
      await fixture.request('admin', `/api/sim/v1/scenario-runs/${currentScenario.scenarioRunId}/actions/advance-time`, {
        expectedVirtualTime: currentScenario.virtualTime,
        targetVirtualTime: new Date(Date.parse(currentScenario.virtualTime) + 5 * 60_000).toISOString(),
      }),
    )
    const recalled = await parsePciResponse(
      inpatientDischargeResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/discharge/recall`, {
        encounterVersion: departed1.data.admission.versionId,
        reason: '出院召回继续观察',
      }),
    )
    expect(recalled.data.admission.status).toBe('admitted')

    const postRecallBlocked = await fixture.request('inpatient-doctor', `${stay.path}/discharge/issue`, {
      encounterVersion: recalled.data.admission.versionId,
      reason: '召回后未带越权说明重开出院医嘱',
    })
    expect(postRecallBlocked.status).toBe(409)
    expect(apiErrorSchema.parse(await postRecallBlocked.json()).error.code).toBe('CLINICAL_QUALITY_ALERT')

    // Re-issue discharge with override, depart, settle, clear bed, and verify `inpatient.record.submit` carries over current cycle's override!
    const issuedDischarge2 = await parsePciResponse(
      inpatientDischargeResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/discharge/issue`, {
        clinicalOverride: dischargeOverride,
        encounterVersion: recalled.data.admission.versionId,
        reason: '召回复评后带禁忌说明开出院医嘱',
      }),
    )
    expect(issuedDischarge2.data.admission.status).toBe('discharge-pending')
    // Pre-departure `discharge-pending` primary-procedure snapshot save does NOT re-trigger the post-departure discharge gate
    const pendingRecord = await fixture.read('inpatient-doctor', `${stay.path}/record`, inpatientRecordSchema)
    const savedInPending = await parsePciResponse(
      inpatientRecordResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/record/submit`, {
        expectedRevision: pendingRecord.revision?.revision ?? 0,
        expectedSourcesHash: pendingRecord.sourcesHash,
        mainProcedureExecutionId: angioExec2.id,
      }),
    )
    expect(savedInPending.clinicalQuality).toBeUndefined()

    const departed2 = await parsePciResponse(
      inpatientDischargeResponseSchema,
      await fixture.request('ward-nurse', `${stay.path}/discharge/depart`, {
        encounterVersion: issuedDischarge2.data.admission.versionId,
        reason: '二次办理离院',
        departureMethod: 'home',
      }),
    )
    expect(departed2.data.admission.status).toBe('departed')
    const postDischargeRecord = await fixture.read('inpatient-doctor', `${stay.path}/record`, inpatientRecordSchema)
    const postDischargeWithoutOverride = await fixture.request('inpatient-doctor', `${stay.path}/record/submit`, {
      expectedRevision: postDischargeRecord.revision?.revision ?? 0,
      expectedSourcesHash: postDischargeRecord.sourcesHash,
      mainProcedureExecutionId: angioExec.id,
    })
    expect(postDischargeWithoutOverride.status).toBe(409)
    const submittedRecord = await parsePciResponse(
      inpatientRecordResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/record/submit`, {
        clinicalOverride: dischargeOverride,
        expectedRevision: postDischargeRecord.revision?.revision ?? 0,
        expectedSourcesHash: postDischargeRecord.sourcesHash,
        mainProcedureExecutionId: angioExec.id,
      }),
    )
    expect(submittedRecord.data.revision?.revision).toBe(3)
    expect(clinicalQualityReceiptSchema.parse(submittedRecord.clinicalQuality)).toMatchObject({
      gate: 'inpatient-discharge',
      override: { reasonCode: 'documented-contraindication' },
    })

    // --- 4. Post-discharge `inpatient.record.submit` direct gate when CAD diagnosis is added after discharge ---
    const nonCadStay = await fixture.admitSyntheticCase(['I10.x09'], 'bed-general-2')
    // Non-CAD discharge succeeds without override
    await fixture.depart(nonCadStay)
    // Doctor corrects diagnosis to CAD (`I25.103`) in the post-discharge unarchived window
    const nonCadClin = await fixture.read('inpatient-doctor', `${nonCadStay.path}/clinical`, inpatientFullClinicalSchema)
    await parsePciResponse(
      inpatientFullClinicalResponseSchema,
      await fixture.request('inpatient-doctor', `${nonCadStay.path}/diagnoses/confirm`, {
        encounterVersion: nonCadClin.encounterVersion,
        expectedRevision: nonCadClin.diagnosis.revision,
        entries: [{
          catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I25.103',
          role: 'primary',
          admissionCondition: '1',
        }],
      }),
    )
    const recordBefore = await fixture.read('inpatient-doctor', `${nonCadStay.path}/record`, inpatientRecordSchema)
    const recordSubmitBlocked = await fixture.request('inpatient-doctor', `${nonCadStay.path}/record/submit`, {
      expectedRevision: recordBefore.revision?.revision ?? 0,
      expectedSourcesHash: recordBefore.sourcesHash,
      mainProcedureExecutionId: null,
    })
    expect(recordSubmitBlocked.status).toBe(409)
    expect(apiErrorSchema.parse(await recordSubmitBlocked.json()).error).toMatchObject({
      code: 'CLINICAL_QUALITY_ALERT',
      clinicalQuality: {
        alerts: [
          expect.objectContaining({ code: 'DISCHARGE_ANTIPLATELET_MISSING' }),
          expect.objectContaining({ code: 'DISCHARGE_STATIN_MISSING' }),
        ],
      },
    })

    const recordOverride: ClinicalOverrideInput = {
      reasonCode: 'patient-informed-refusal',
      note: '患者及家属签署知情说明拒绝长期服用抗血小板与他汀药物',
      acknowledgedAlerts: ['DISCHARGE_ANTIPLATELET_MISSING', 'DISCHARGE_STATIN_MISSING'],
    }
    const recordSubmitted = await parsePciResponse(
      inpatientRecordResponseSchema,
      await fixture.request('inpatient-doctor', `${nonCadStay.path}/record/submit`, {
        clinicalOverride: recordOverride,
        expectedRevision: recordBefore.revision?.revision ?? 0,
        expectedSourcesHash: recordBefore.sourcesHash,
        mainProcedureExecutionId: null,
      }),
    )
    expect(clinicalQualityReceiptSchema.parse(recordSubmitted.clinicalQuality)).toMatchObject({
      gate: 'inpatient-discharge',
      override: { reasonCode: 'patient-informed-refusal' },
    })

    // --- 5. Same-timestamp virtual clock ordering: stopping statin BEFORE discharge.issue blocks discharge, whereas stopping AFTER discharge.issue for depart passes record.submit ---
    const sameTsStay = await fixture.admitSyntheticCase(['I25.103'], 'bed-general-3')
    const aspirin = catalog.medications.find(item => item.id === 'medication-pci-aspirin')!
    let sameTsClin = await fixture.read('inpatient-doctor', `${sameTsStay.path}/clinical`, inpatientFullClinicalSchema)
    for (const [med, doseText, doseQuantity, freq] of [[aspirin, '100 mg', 1, 'QD'], [atorvastatin, '20 mg', 2, 'QN']] as const) {
      sameTsClin = (await parsePciResponse(
        inpatientFullClinicalResponseSchema,
        await fixture.request('inpatient-doctor', `${sameTsStay.path}/orders/issue`, {
          encounterVersion: sameTsClin.encounterVersion,
          duration: 'long',
          selection: { kind: 'medication', catalogItemId: med.id, catalogVersion: med.version, doseText, doseQuantity, frequencyCode: freq, routeCode: 'PO' },
        }),
      )).data
    }
    const statinBeforeIssue = sameTsClin.orders.find(item => item.catalogItemId === atorvastatin.id)!
    const stopStatinBefore = await parsePciResponse(
      inpatientFullClinicalResponseSchema,
      await fixture.request('inpatient-doctor', `${sameTsStay.path}/orders/request-stop`, {
        orderId: statinBeforeIssue.id,
        expectedOrderVersion: statinBeforeIssue.version,
        reason: '出院前同虚拟时刻停他汀验证',
      }),
    )
    await parsePciResponse(
      inpatientFullClinicalResponseSchema,
      await fixture.request('ward-nurse', `${sameTsStay.path}/orders/verify-stop`, {
        orderId: statinBeforeIssue.id,
        expectedOrderVersion: stopStatinBefore.data.orders.find(item => item.id === statinBeforeIssue.id)!.version,
      }),
    )
    const sameTsAdm1 = (await fixture.read('inpatient-doctor', sameTsStay.path, z.object({ admission: z.object({ versionId: z.string() }) }))).admission
    const issueMissingStatin = await fixture.request('inpatient-doctor', `${sameTsStay.path}/discharge/issue`, {
      encounterVersion: sameTsAdm1.versionId,
      reason: '同虚拟时刻停他汀后拟出院',
    })
    expect(issueMissingStatin.status).toBe(409)
    expect(apiErrorSchema.parse(await issueMissingStatin.json()).error).toMatchObject({
      code: 'CLINICAL_QUALITY_ALERT',
      clinicalQuality: { alerts: [{ code: 'DISCHARGE_STATIN_MISSING' }] },
    })

    // Re-issue long-term statin -> discharge.issue passes WITHOUT override, then stop orders at the SAME virtual clock to depart -> record.submit ALSO passes WITHOUT override!
    sameTsClin = (await parsePciResponse(
      inpatientFullClinicalResponseSchema,
      await fixture.request('inpatient-doctor', `${sameTsStay.path}/orders/issue`, {
        encounterVersion: sameTsAdm1.versionId,
        duration: 'long',
        selection: { kind: 'medication', catalogItemId: atorvastatin.id, catalogVersion: atorvastatin.version, doseText: '20 mg', doseQuantity: 2, frequencyCode: 'QN', routeCode: 'PO' },
      }),
    )).data
    const sameTsIssued = await parsePciResponse(
      inpatientDischargeResponseSchema,
      await fixture.request('inpatient-doctor', `${sameTsStay.path}/discharge/issue`, {
        encounterVersion: sameTsClin.encounterVersion,
        reason: '补齐他汀后开立出院医嘱',
      }),
    )
    expect(sameTsIssued.clinicalQuality).toBeUndefined()
    for (const activeOrder of sameTsClin.orders.filter(item => item.state !== 'stopped')) {
      const stopReq = await parsePciResponse(
        inpatientFullClinicalResponseSchema,
        await fixture.request('inpatient-doctor', `${sameTsStay.path}/orders/request-stop`, {
          orderId: activeOrder.id,
          expectedOrderVersion: activeOrder.version,
          reason: '出院医嘱开立后办理出区停嘱',
        }),
      )
      await parsePciResponse(
        inpatientFullClinicalResponseSchema,
        await fixture.request('ward-nurse', `${sameTsStay.path}/orders/verify-stop`, {
          orderId: activeOrder.id,
          expectedOrderVersion: stopReq.data.orders.find(item => item.id === activeOrder.id)!.version,
        }),
      )
    }
    const sameTsAdm2 = (await fixture.read('inpatient-doctor', sameTsStay.path, z.object({ admission: z.object({ versionId: z.string() }) }))).admission
    await parsePciResponse(
      inpatientDischargeResponseSchema,
      await fixture.request('ward-nurse', `${sameTsStay.path}/discharge/depart`, {
        encounterVersion: sameTsAdm2.versionId,
        reason: '完成停嘱后办理出区',
        departureMethod: 'home',
      }),
    )
    const sameTsRecord = await fixture.read('inpatient-doctor', `${sameTsStay.path}/record`, inpatientRecordSchema)
    const sameTsSubmitted = await parsePciResponse(
      inpatientRecordResponseSchema,
      await fixture.request('inpatient-doctor', `${sameTsStay.path}/record/submit`, {
        expectedRevision: sameTsRecord.revision?.revision ?? 0,
        expectedSourcesHash: sameTsRecord.sourcesHash,
        mainProcedureExecutionId: null,
      }),
    )
    expect(sameTsSubmitted.clinicalQuality).toBeUndefined()
  }, 120_000)
})
