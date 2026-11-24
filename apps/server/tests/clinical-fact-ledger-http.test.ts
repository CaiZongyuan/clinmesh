import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import {
  clinicalFactLedgerSchema,
  clinicalFactVerificationResponseSchema,
} from '@clinmesh/contracts/clinical-fact-ledger'
import { clinicalQualityCheckSchema } from '@clinmesh/contracts/clinical-quality'
import { clinicalScoreBundleSchema } from '@clinmesh/contracts/clinical-scores'
import {
  apiErrorSchema,
  commandResponseSchema,
  confirmDiagnosisResponseSchema,
  diagnosisDraftResponseSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  prescriptionDraftResponseSchema,
  registrationCatalogSchema,
  scenarioStateSchema,
  startVisitResponseSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { inpatientPciDataResponseSchema, pciCaseSourceResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { startSyntheticCaseResultSchema } from '@clinmesh/contracts/scenario'
import {
  createPciPaymentDrgFixture,
  parsePciResponse,
  preparePciPaymentDrgFixture,
  type PciPaymentDrgFixture,
} from './fixtures/pci-payment-drg.ts'
import { signInitialOutpatientDocument } from './fixtures/outpatient-order-gate.ts'

const fixtures: PciPaymentDrgFixture[] = []

afterEach(async () => {
  while (fixtures.length > 0) {
    await fixtures.pop()!.close()
  }
})

async function postRawJson(
  fixture: PciPaymentDrgFixture,
  role: string,
  path: string,
  body: unknown,
  key = randomUUID(),
) {
  return fixture.runtime.app.request(path, {
    method: 'POST',
    headers: {
      cookie: await fixture.login(role),
      origin: 'http://localhost',
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify(body),
  })
}

async function startDoctorCaseFromTriage(
  fixture: PciPaymentDrgFixture,
  options: {
    encounterId: string
    queueTaskId: string
    chiefComplaint: string
  },
) {
  const triaged = await parsePciResponse(
    triageResponseSchema,
    await fixture.request('triage', `/api/his/v1/encounters/${options.encounterId}/actions/record-triage`, {
      acuityCode: 'level-2',
      bloodPressure: { diastolicMmHg: 80, systolicMmHg: 130 },
      chiefComplaint: options.chiefComplaint,
      heightCm: 165,
      oxygenSaturationPct: 98,
      pulseBpm: 78,
      respirationBpm: 18,
      temperatureC: 36.7,
      weightKg: 60,
    }, randomUUID(), {
      [`Encounter/${options.encounterId}`]: '1',
      [`Task/${options.queueTaskId}`]: '1',
    }),
  )
  await parsePciResponse(
    startVisitResponseSchema,
    await fixture.request('doctor', `/api/his/v1/encounters/${options.encounterId}/actions/start-first-visit`, {}, randomUUID(), {
      [`Encounter/${options.encounterId}`]: triaged.data.encounterVersion,
      [`Task/${triaged.data.doctorTaskId}`]: '1',
    }),
  )
  const queue = await fixture.read('doctor', '/api/his/v1/doctor/queue', doctorQueueSchema)
  const item = queue.items.find(row => row.encounterId === options.encounterId)!
  const detail = await fixture.read('doctor', `/api/his/v1/doctor/cases/${item.caseId}`, doctorCaseDetailSchema)
  return { caseId: item.caseId, detail, encounterId: options.encounterId }
}

async function confirmOutpatientPrimaryDiagnosis(
  fixture: PciPaymentDrgFixture,
  encounterId: string,
  encounterVersion: string,
  catalogItemId: string,
) {
  const cookie = await fixture.login('doctor')
  const draftRes = await fixture.runtime.app.request(`http://localhost/api/his/v1/encounters/${encounterId}/diagnosis/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie, 'idempotency-key': randomUUID(), origin: 'http://localhost' },
    body: JSON.stringify({
      expectedVersions: { [`Encounter/${encounterId}`]: encounterVersion },
      input: { entries: [{ catalogItemId, role: 'primary' }], expectedDraftVersion: 0 },
    }),
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

function insertLabReport(
  fixture: PciPaymentDrgFixture,
  options: {
    workspaceId: string
    epoch: string
    caseId: string
    encounterId: string
    patientId: string
    authoredAt: string
    reportedAt: string
    reportStatus?: 'final' | 'amended'
    supersedesReportId?: string
    specimenId?: string
    observations: Array<{
      id?: string
      coding: Array<{ code: string; display: string; system?: string }>
      valueQuantity?: { value: number; unit: string }
      status?: 'final' | 'amended' | 'entered-in-error'
    }>
  },
) {
  const scope = { workspaceId: options.workspaceId, epoch: options.epoch } as const
  const sr = fixture.runtime.fhir.create(scope, {
    resourceType: 'ServiceRequest',
    id: uuidv7(),
    status: 'completed',
    intent: 'order',
    authoredOn: options.authoredAt,
    code: { text: '检验申请' },
    subject: { reference: `Patient/${options.patientId}` },
    encounter: { reference: `Encounter/${options.encounterId}` },
  })
  const specimenId = options.specimenId ?? uuidv7()
  try {
    fixture.runtime.fhir.read(scope, 'Specimen', specimenId)
  } catch {
    fixture.runtime.fhir.create(scope, {
      resourceType: 'Specimen',
      id: specimenId,
      status: 'available',
      type: { text: '静脉血清' },
      subject: { reference: `Patient/${options.patientId}` },
    })
  }
  const obsIds: string[] = []
  for (const obsInput of options.observations) {
    const obsId = obsInput.id ?? uuidv7()
    fixture.runtime.fhir.create(scope, {
      resourceType: 'Observation',
      id: obsId,
      status: obsInput.status ?? options.reportStatus ?? 'final',
      basedOn: [{ reference: `ServiceRequest/${sr.id}` }],
      specimen: { reference: `Specimen/${specimenId}`, display: '静脉血清' },
      code: {
        coding: obsInput.coding.map(c => ({ code: c.code, display: c.display, system: c.system ?? 'http://loinc.org' })),
        text: obsInput.coding[0]!.display,
      },
      subject: { reference: `Patient/${options.patientId}` },
      encounter: { reference: `Encounter/${options.encounterId}` },
      effectiveDateTime: options.reportedAt,
      issued: options.reportedAt,
      ...(obsInput.valueQuantity ? { valueQuantity: { value: obsInput.valueQuantity.value, unit: obsInput.valueQuantity.unit, code: obsInput.valueQuantity.unit } } : {}),
    })
    obsIds.push(obsId)
  }

  const task = fixture.runtime.fhir.create(scope, {
    resourceType: 'Task',
    id: uuidv7(),
    status: 'completed',
    intent: 'order',
    for: { reference: `Patient/${options.patientId}` },
    encounter: { reference: `Encounter/${options.encounterId}` },
    authoredOn: options.authoredAt,
  })
  const report = fixture.runtime.fhir.create(scope, {
    resourceType: 'DiagnosticReport',
    id: uuidv7(),
    status: options.reportStatus ?? 'final',
    category: [{ coding: [{ code: 'LAB', system: 'http://terminology.hl7.org/CodeSystem/v2-0074' }] }],
    basedOn: [{ reference: `ServiceRequest/${sr.id}` }],
    code: { coding: [{ code: 'LAB-PANEL', display: '临床检验报告' }], text: '临床检验报告' },
    subject: { reference: `Patient/${options.patientId}` },
    encounter: { reference: `Encounter/${options.encounterId}` },
    effectiveDateTime: options.reportedAt,
    issued: options.reportedAt,
    result: obsIds.map(id => ({ reference: `Observation/${id}` })),
  })

  const requestId = uuidv7()
  fixture.runtime.database.driver.prepare(`
    INSERT INTO laboratory_request (
      workspace_id, epoch, request_id, case_id, request_kind, catalog_item_id, reference_json,
      indication_code, service_snapshot_json, service_request_id, execution_task_id,
      diagnostic_report_id, status, version, authored_by, authored_at, reported_at
    ) VALUES (?, ?, ?, ?, 'laboratory', 'synthetic-lab-cardiac', '{}', 'clinical-assessment', '{}', ?, ?, ?, 'reported', 1, 'actor-test', ?, ?)
  `).run(options.workspaceId, options.epoch, requestId, options.caseId, sr.id, task.id, report.id, options.authoredAt, options.reportedAt)

  if (options.supersedesReportId) {
    fixture.runtime.database.driver.prepare(`
      INSERT INTO laboratory_report_revision (
        workspace_id, epoch, revision_id, request_id, diagnostic_report_id,
        revision_of_diagnostic_report_id, provenance_id, reason, corrected_by, corrected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '修订肌酐测定结果', 'actor-lab', ?)
    `).run(options.workspaceId, options.epoch, uuidv7(), requestId, report.id, options.supersedesReportId, uuidv7(), options.reportedAt)
  }

  return { obsIds, reportId: report.id, requestId, specimenId }
}

describe('Clinical Fact Ledger & Fact Verification HTTP integration (S2 #555)', () => {
  it('transcribes all 8 categories, protects Case Truth (AC15), enforces QC flags & external verification into scores and metformin red-line (AC21)', async () => {
    const prepared = await preparePciPaymentDrgFixture()
    const fixture = await createPciPaymentDrgFixture(prepared)
    fixtures.push(fixture)
    const scenario = await fixture.read('admin', '/api/sim/v1/scenario-runs/current', scenarioStateSchema)

    // Materialize a real outpatient synthetic case with visible source history + Case Truth sentinel
    await parsePciResponse(
      inpatientPciDataResponseSchema,
      await fixture.request('admin', '/api/his/v1/inpatient/pci-data/prepare', { expectedEpoch: scenario.epoch }),
    )
    const pciSource = (await parsePciResponse(
      pciCaseSourceResponseSchema,
      await fixture.request('admin', '/api/sim/v1/synthetic-cases/pci/prepare', { expectedEpoch: scenario.epoch }),
    )).data
    const regCatalog = await fixture.read('registrar', '/api/his/v1/catalogs/registration', registrationCatalogSchema)
    const startedOut = commandResponseSchema(startSyntheticCaseResultSchema).parse(
      await (await postRawJson(
        fixture,
        'registrar',
        `/api/his/v1/synthetic-cases/${pciSource.case.caseId}/actions/start-outpatient-visit`,
        {
          activeBriefRevision: pciSource.case.activeBriefRevision,
          departmentId: regCatalog.departments[0]!.id,
          expectedCaseRevision: pciSource.case.revision,
          locationId: regCatalog.locations[0]!.id,
          visitDate: regCatalog.virtualDate,
          visitTypeId: regCatalog.visitTypes[0]!.id,
        },
      )).json(),
    ).data

    // Inject Case Truth hidden sentinel and verify AC15 non-leakage, plus inject an external severe creatinine (3.8 mg/dL)
    const caseTruthSentinel = 'CASE_TRUTH_SECRET_SENTINEL_NEVER_EXPOSE_987654'
    fixture.runtime.database.driver.prepare(`
      UPDATE synthetic_case_truth
      SET hidden_resources_json = ?
      WHERE workspace_id = ? AND case_id = ?
    `).run(JSON.stringify([{ secretFlag: caseTruthSentinel }]), scenario.workspaceId, pciSource.case.caseId)

    const extCrSourceRef = 'Observation/ext-severe-cr-1'
    fixture.runtime.database.driver.prepare(`
      INSERT INTO synthetic_case_visible_resource (workspace_id, case_id, source_reference, resource_type, resource_json)
      VALUES (?, ?, ?, 'Observation', ?)
    `).run(
      scenario.workspaceId,
      pciSource.case.caseId,
      extCrSourceRef,
      JSON.stringify({
        code: { coding: [{ code: '2160-0', system: 'http://loinc.org', display: '外院血清肌酐' }] },
        effectiveDateTime: '2026-08-20T09:00:00+08:00',
        issued: '2026-08-20T10:00:00+08:00',
        status: 'final',
        valueQuantity: { value: 3.8, unit: 'mg/dL' },
      }),
    )
    fixture.runtime.database.driver.prepare(`
      INSERT INTO synthetic_case_visible_history (workspace_id, case_id, sequence, source_reference, resource_type, clinical_date, title)
      VALUES (?, ?, 999, ?, 'Observation', '2026-08-20T10:00:00+08:00', '外院近期血清肌酐升高')
    `).run(scenario.workspaceId, pciSource.case.caseId, extCrSourceRef)

    const visit = await startDoctorCaseFromTriage(fixture, {
      encounterId: startedOut.encounterId,
      queueTaskId: startedOut.queueTaskId,
      chiefComplaint: '胸闷伴血糖升高复诊',
    })
    const patientId = visit.detail.patient.id
    const scope = { workspaceId: scenario.workspaceId, epoch: scenario.epoch } as const

    // Confirm diabetes diagnosis and add allergy + medication + procedure + examination + bedside questionnaire (some null -> not-asked)
    const afterDiag = await confirmOutpatientPrimaryDiagnosis(
      fixture,
      visit.encounterId,
      visit.detail.encounter.versionId,
      'diagnosis-type-2-diabetes-hyperglycemia',
    )
    fixture.runtime.fhir.create(scope, {
      resourceType: 'AllergyIntolerance',
      id: uuidv7(),
      verificationStatus: { coding: [{ code: 'confirmed' }] },
      code: { coding: [{ code: 'allergy-penicillin', display: '青霉素' }] },
      patient: { reference: `Patient/${patientId}` },
      recordedDate: '2026-08-24T08:15:00+08:00',
    })
    fixture.runtime.fhir.createProjection(scope, {
      resourceType: 'Procedure',
      id: uuidv7(),
      status: 'completed',
      code: { coding: [{ code: '88.55', display: '冠脉造影术' }] },
      subject: { reference: `Patient/${patientId}` },
      performedDateTime: '2026-08-20T11:00:00+08:00',
    })
    fixture.runtime.fhir.create(scope, {
      resourceType: 'DiagnosticReport',
      id: uuidv7(),
      status: 'final',
      category: [{ coding: [{ code: 'ECG' }] }],
      code: { coding: [{ code: '11524-6', display: '十二导联心电图' }] },
      subject: { reference: `Patient/${patientId}` },
      effectiveDateTime: '2026-08-24T08:45:00+08:00',
      issued: '2026-08-24T08:50:00+08:00',
      conclusion: '窦性心律，未见急性ST段抬高',
    })
    fixture.runtime.fhir.create(scope, {
      resourceType: 'MedicationRequest',
      id: uuidv7(),
      status: 'active',
      intent: 'order',
      subject: { reference: `Patient/${patientId}` },
      medicationCodeableConcept: { coding: [{ code: 'aspirin', display: '阿司匹林肠溶片' }] },
      authoredOn: '2026-08-24T08:55:00+08:00',
      dosageInstruction: [{ text: '100 mg PO QD' }],
    })
    // Record partial bedside questionnaire preserving null -> 'not-asked'
    const putCookie = await fixture.login('doctor')
    const putRiskRes = await fixture.runtime.app.request(`http://localhost/api/his/v1/encounters/${visit.encounterId}/risk-assessment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: putCookie, 'idempotency-key': randomUUID(), origin: 'http://localhost' },
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${visit.encounterId}`]: afterDiag.data.encounterVersion },
        input: { expectedRevision: 0, fields: { killipClass: 'I', smokingStatus: 'never' } },
      }),
    })
    expect(putRiskRes.status).toBe(200)

    // Insert local troponin panel demonstrating method separation (hs-cTnI, cTnI, cTnT on SAME specimen), PLUS QC violations!
    const cardiacSpecimenId = uuidv7()
    insertLabReport(fixture, {
      workspaceId: scenario.workspaceId,
      epoch: scenario.epoch,
      caseId: visit.caseId,
      encounterId: visit.encounterId,
      patientId,
      authoredAt: '2026-08-24T08:00:00+08:00',
      reportedAt: '2026-08-24T09:00:00+08:00',
      specimenId: cardiacSpecimenId,
      observations: [
        { coding: [{ code: '2100404B', display: 'hs-cTnI' }], valueQuantity: { value: 48, unit: 'ng/L' } },
        { coding: [{ code: '10839-9', display: '常规 cTnI' }], valueQuantity: { value: 0.3, unit: 'ng/mL' } },
        { coding: [{ code: '2100504A', display: 'cTnT' }], valueQuantity: { value: 62, unit: 'ng/L' } },
      ],
    })

    // Suspicious QC observations: disallowed unit, implausible value, reportedAt < orderedAt, male pregnancy
    insertLabReport(fixture, {
      workspaceId: scenario.workspaceId,
      epoch: scenario.epoch,
      caseId: visit.caseId,
      encounterId: visit.encounterId,
      patientId,
      authoredAt: '2026-08-24T08:00:00+08:00',
      reportedAt: '2026-08-24T09:00:00+08:00',
      observations: [
        { id: 'obs-bad-unit', coding: [{ code: '2160-0', display: '血清肌酐' }], valueQuantity: { value: 110, unit: 'mmol/L' } },
        { id: 'obs-neg-cr', coding: [{ code: '2160-0', display: '血清肌酐' }], valueQuantity: { value: -2, unit: 'mg/dL' } },
        { id: 'obs-male-hcg', coding: [{ code: '21198-7', display: '血清 hCG 妊娠试验' }], valueQuantity: { value: 12, unit: 'mIU/mL' } },
      ],
    })
    insertLabReport(fixture, {
      workspaceId: scenario.workspaceId,
      epoch: scenario.epoch,
      caseId: visit.caseId,
      encounterId: visit.encounterId,
      patientId,
      authoredAt: '2026-08-24T09:30:00+08:00',
      reportedAt: '2026-08-24T08:30:00+08:00', // reported before ordered!
      observations: [
        { id: 'obs-early-cr', coding: [{ code: '2160-0', display: '血清肌酐' }], valueQuantity: { value: 3.1, unit: 'mg/dL' } },
      ],
    })

    const sc1 = await fixture.read('admin', '/api/sim/v1/scenario-runs/current', scenarioStateSchema)
    await fixture.request('admin', `/api/sim/v1/scenario-runs/${sc1.scenarioRunId}/actions/advance-time`, {
      expectedVirtualTime: sc1.virtualTime,
      targetVirtualTime: new Date(Math.max(Date.parse(sc1.virtualTime) + 60_000, Date.parse('2026-08-24T10:00:00+08:00'))).toISOString(),
    })

    // Role isolation: non-doctor roles (pharmacist, registrar & ward-nurse) must get 403!
    const pharmacistForbidden = await fixture.request('pharmacist', `/api/his/v1/outpatient/cases/${visit.caseId}/clinical-fact-ledger`)
    expect(pharmacistForbidden.status).toBe(403)
    const registrarForbidden = await fixture.request('registrar', `/api/his/v1/outpatient/cases/${visit.caseId}/clinical-fact-ledger`)
    expect(registrarForbidden.status).toBe(403)
    const nurseForbidden = await fixture.request('ward-nurse', `/api/his/v1/outpatient/cases/${visit.caseId}/clinical-fact-ledger`)
    expect(nurseForbidden.status).toBe(403)

    // Responsible doctor reads full ledger
    const ledgerRes = await fixture.request('doctor', `/api/his/v1/outpatient/cases/${visit.caseId}/clinical-fact-ledger`)
    expect(ledgerRes.status).toBe(200)
    const rawLedgerText = await ledgerRes.clone().text()
    expect(rawLedgerText).not.toContain(caseTruthSentinel) // AC15
    const ledger = clinicalFactLedgerSchema.parse(await ledgerRes.json())

    // All 8 categories represented
    expect(new Set(ledger.facts.map(f => f.category))).toEqual(new Set([
      'diagnosis',
      'allergy',
      'laboratory',
      'examination',
      'vital-sign',
      'medication',
      'procedure',
      'bedside-questionnaire',
    ]))

    // Troponin assays separated on the same specimen
    const troponins = ledger.facts.filter(f => f.specimenOrSite?.specimenId === cardiacSpecimenId)
    expect(troponins.map(t => [t.itemCode.code, t.method])).toEqual([
      ['10839-9', 'cTnI'],
      ['6597-9', 'cTnT'],
      ['89579-7', 'hs-cTnI'],
    ])
    expect(troponins.every(t => t.qualityFlags.length === 0 && t.eligibleForScoringAndRedLine)).toBe(true)

    // Bedside questionnaire preserves not-asked
    const arrestNotAsked = ledger.facts.find(f => f.category === 'bedside-questionnaire' && f.itemCode.code === 'cardiac-arrest-on-admission')!
    expect(arrestNotAsked.presence).toBe('not-asked')
    expect(arrestNotAsked.value.normalizedValue).toBeNull()

    // Suspicious flags enforced
    expect(ledger.facts.find(f => f.provenance.recordId === 'obs-bad-unit')?.suspiciousReasons).toContain('unit-not-allowed')
    expect(ledger.facts.find(f => f.provenance.recordId === 'obs-neg-cr')?.suspiciousReasons).toContain('out-of-plausible-range')
    expect(ledger.facts.find(f => f.provenance.recordId === 'obs-early-cr')?.suspiciousReasons).toContain('reported-before-ordered')
    expect(ledger.facts.find(f => f.provenance.recordId === 'obs-male-hcg')?.suspiciousReasons).toContain('sex-contradiction')

    // External severe creatinine starts unverified & ineligible
    const extCrFact = ledger.facts.find(
      f => f.provenance.sourceSystemId === 'clinmesh-visible-source-history' && f.provenance.recordId === extCrSourceRef,
    )!
    expect(extCrFact.institutionScope).toBe('external')
    expect(extCrFact.qualityFlags).toContain('external-unverified')
    expect(extCrFact.requiresRecheckPrompt).toBe(true)
    expect(extCrFact.eligibleForScoringAndRedLine).toBe(false)

    // Draft metformin -> scores must exclude ALL suspicious & unverified external creatinine -> RENAL_CREATININE_MISSING alert!
    const draftCookie = await fixture.login('doctor')
    const draftRes = await fixture.runtime.app.request(`http://localhost/api/his/v1/encounters/${visit.encounterId}/prescription/draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: draftCookie, 'idempotency-key': randomUUID(), origin: 'http://localhost' },
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${visit.encounterId}`]: afterDiag.data.encounterVersion },
        input: {
          expectedDraftVersion: 0,
          items: [{ catalogItemId: 'medication-metformin', courseDays: 7, doseText: '500mg', frequencyCode: 'BID', quantity: 14, routeCode: 'PO' }],
        },
      }),
    })
    const savedDraft = await parsePciResponse(prescriptionDraftResponseSchema, draftRes)
    expect(savedDraft.data.draftVersion).toBe(1)
    const scoresBeforeVerify = await fixture.read('doctor', `/api/his/v1/doctor/cases/${visit.caseId}/clinical-scores`, clinicalScoreBundleSchema)
    expect(scoresBeforeVerify.scores.find(s => s.id === 'ckd-epi-2021-egfr')?.status).toBe('incomplete')
    const qualityBeforeVerify = await fixture.read(
      'doctor',
      `/api/his/v1/encounters/${visit.encounterId}/clinical-quality?gate=outpatient-prescription`,
      clinicalQualityCheckSchema,
    )
    expect(qualityBeforeVerify.redLines).toEqual([])
    expect(qualityBeforeVerify.alerts).toMatchObject([{ code: 'RENAL_CREATININE_MISSING' }])

    // Non-doctor role cannot verify facts
    const pharmacistVerifyRes = await fixture.request(
      'pharmacist',
      `/api/his/v1/outpatient/cases/${visit.caseId}/clinical-fact-verifications`,
      { factId: extCrFact.factId, note: '越权核实' },
    )
    expect(pharmacistVerifyRes.status).toBe(403)

    // Mismatched expectedSourceVersion must fail cleanly with 409 CLINICAL_FACT_VERSION_CONFLICT
    const versionConflictRes = await fixture.request(
      'doctor',
      `/api/his/v1/outpatient/cases/${visit.caseId}/clinical-fact-verifications`,
      {
        factId: extCrFact.factId,
        decision: 'verified',
        expectedSourceVersion: '999',
        note: '错误来源版本验证',
      },
    )
    expect(versionConflictRes.status).toBe(409)
    expect(apiErrorSchema.parse(await versionConflictRes.json()).error.code).toBe('CLINICAL_FACT_VERSION_CONFLICT')

    // Responsible doctor formally verifies external severe creatinine (3.8 mg/dL) with matching expectedSourceVersion, plus tests idempotent replay
    const verifyKey = randomUUID()
    const verifyRes = await fixture.request(
      'doctor',
      `/api/his/v1/outpatient/cases/${visit.caseId}/clinical-fact-verifications`,
      {
        factId: extCrFact.factId,
        decision: 'verified',
        expectedSourceVersion: extCrFact.provenance.recordVersion,
        note: '已核对患者携带来院外院化验单原件',
      },
      verifyKey,
    )
    expect(verifyRes.status).toBe(200)
    const verifyBody = clinicalFactVerificationResponseSchema.parse(await verifyRes.json())
    expect(verifyBody.data.fact.clinicianVerification.verified).toBe(true)
    expect(verifyBody.data.fact.requiresRecheckPrompt).toBe(false)
    expect(verifyBody.data.fact.eligibleForScoringAndRedLine).toBe(true)

    // Idempotent replay returns identical verificationId
    const replayRes = await fixture.request(
      'doctor',
      `/api/his/v1/outpatient/cases/${visit.caseId}/clinical-fact-verifications`,
      {
        factId: extCrFact.factId,
        decision: 'verified',
        expectedSourceVersion: extCrFact.provenance.recordVersion,
        note: '已核对患者携带来院外院化验单原件',
      },
      verifyKey,
    )
    expect(replayRes.status).toBe(200)
    expect(clinicalFactVerificationResponseSchema.parse(await replayRes.json()).data.verification.verificationId)
      .toBe(verifyBody.data.verification.verificationId)

    // AuditEvent and ActionTrace recorded
    const traceRow = z.object({ outcome: z.string(), effect_json: z.string() }).parse(
      fixture.runtime.database.driver.prepare(`
        SELECT outcome, effect_json FROM action_trace
        WHERE workspace_id = ? AND epoch = ? AND operation = 'doctor.case.clinical-fact-verification.record'
        ORDER BY sequence DESC LIMIT 1
      `).get(scenario.workspaceId, scenario.epoch),
    )
    expect(traceRow.outcome).toBe('success')
    expect(JSON.parse(traceRow.effect_json)).toContainEqual(
      expect.objectContaining({ kind: 'created', reference: `ClinicalFactVerification/${verifyBody.data.verification.verificationId}` }),
    )
    const auditEvent = fixture.runtime.fhir.read(scope, 'AuditEvent', verifyBody.auditId) as {
      resourceType?: string
      action?: string
      outcome?: { code?: { code?: string } }
    }
    expect(auditEvent.resourceType).toBe('AuditEvent')
    expect(auditEvent.outcome?.code?.code).toBe('0')

    // Immediately after verifying external creatinine (3.8 mg/dL -> eGFR < 30), scores complete and metformin hits Tier-1 RED LINE!
    const scoresAfterVerify = await fixture.read('doctor', `/api/his/v1/doctor/cases/${visit.caseId}/clinical-scores`, clinicalScoreBundleSchema)
    const egfrScore = scoresAfterVerify.scores.find(s => s.id === 'ckd-epi-2021-egfr')!
    expect(egfrScore.status).toBe('complete')
    if (egfrScore.status === 'complete') {
      expect(egfrScore.value).toBeLessThan(30)
    }

    const qualityAfterVerify = await fixture.read(
      'doctor',
      `/api/his/v1/encounters/${visit.encounterId}/clinical-quality?gate=outpatient-prescription`,
      clinicalQualityCheckSchema,
    )
    expect(qualityAfterVerify.redLines).toMatchObject([{ code: 'RENAL_CONTRAINDICATED_MEDICATION', catalogItemId: 'medication-metformin' }])

    const signedDoc = await signInitialOutpatientDocument(
      fixture.runtime,
      await fixture.login('doctor'),
      visit.caseId,
    )

    const issueBlocked = await fixture.request(
      'doctor',
      `/api/his/v1/encounters/${visit.encounterId}/prescription/actions/issue`,
      { expectedDraftVersion: 1 },
      randomUUID(),
      { [`Encounter/${visit.encounterId}`]: signedDoc.encounterVersion },
    )
    expect(issueBlocked.status).toBe(409)
    expect(apiErrorSchema.parse(await issueBlocked.json()).error.code).toBe('CLINICAL_QUALITY_RED_LINE')
  })

  it('handles intra-specimen conflicts, point-in-time asOf report amendments (AC2), and inpatient ledger & verification', async () => {
    const prepared = await preparePciPaymentDrgFixture()
    const fixture = await createPciPaymentDrgFixture(prepared)
    fixtures.push(fixture)
    const scenario = await fixture.read('admin', '/api/sim/v1/scenario-runs/current', scenarioStateSchema)

    const stay = await fixture.admitSyntheticCase(['I25.103'], 'bed-general-1')

    // v1 creatinine report at 09:00, amended to v2 at 11:00
    const repV1 = insertLabReport(fixture, {
      workspaceId: scenario.workspaceId,
      epoch: scenario.epoch,
      caseId: stay.admissionId,
      encounterId: stay.admissionId,
      patientId: stay.patientId,
      authoredAt: '2026-08-24T08:00:00+08:00',
      reportedAt: '2026-08-24T09:00:00+08:00',
      reportStatus: 'final',
      observations: [{ id: 'obs-ip-cr-v1', coding: [{ code: '2160-0', display: '血清肌酐' }], valueQuantity: { value: 1.0, unit: 'mg/dL' } }],
    })
    insertLabReport(fixture, {
      workspaceId: scenario.workspaceId,
      epoch: scenario.epoch,
      caseId: stay.admissionId,
      encounterId: stay.admissionId,
      patientId: stay.patientId,
      authoredAt: '2026-08-24T08:00:00+08:00',
      reportedAt: '2026-08-24T11:00:00+08:00',
      reportStatus: 'amended',
      supersedesReportId: repV1.reportId,
      observations: [{ id: 'obs-ip-cr-v2', coding: [{ code: '2160-0', display: '血清肌酐' }], valueQuantity: { value: 1.4, unit: 'mg/dL' } }],
    })

    // Query at midpoint asOf = 10:00 -> ONLY v1 visible and active!
    const at1000 = await fixture.read(
      'inpatient-doctor',
      `/api/his/v1/inpatient/admissions/${stay.admissionId}/clinical-fact-ledger?asOf=${encodeURIComponent('2026-08-24T10:00:00+08:00')}&categories=laboratory`,
      clinicalFactLedgerSchema,
    )
    expect(at1000.facts).toHaveLength(1)
    expect(at1000.facts[0]?.provenance.recordId).toBe('obs-ip-cr-v1')
    expect(at1000.facts[0]?.recordStatus).toBe('final')
    expect(at1000.facts[0]?.relation.supersededByFactId).toBeNull()

    // Query at 12:00 -> ONLY v2 visible by default; includeSuperseded=true exposes both
    const at1200 = await fixture.read(
      'inpatient-doctor',
      `/api/his/v1/inpatient/admissions/${stay.admissionId}/clinical-fact-ledger?asOf=${encodeURIComponent('2026-08-24T12:00:00+08:00')}&categories=laboratory`,
      clinicalFactLedgerSchema,
    )
    expect(at1200.facts).toHaveLength(1)
    expect(at1200.facts[0]?.provenance.recordId).toBe('obs-ip-cr-v2')
    expect(at1200.facts[0]?.recordStatus).toBe('amended')
    expect(at1200.facts[0]?.relation.supersedesFactId).toContain('obs-ip-cr-v1')

    const at1200All = await fixture.read(
      'inpatient-doctor',
      `/api/his/v1/inpatient/admissions/${stay.admissionId}/clinical-fact-ledger?asOf=${encodeURIComponent('2026-08-24T12:00:00+08:00')}&categories=laboratory&includeSuperseded=true`,
      clinicalFactLedgerSchema,
    )
    expect(at1200All.facts).toHaveLength(2)
    expect(at1200All.facts.find(f => f.provenance.recordId === 'obs-ip-cr-v1')?.eligibleForScoringAndRedLine).toBe(false)

    // Separate inpatient stay with ONLY a conflicting same-specimen creatinine draw -> incomplete until verified!
    const conflictStay = await fixture.admitSyntheticCase(['I25.103'], 'bed-general-2')
    const sharedSpecimenId = uuidv7()
    insertLabReport(fixture, {
      workspaceId: scenario.workspaceId,
      epoch: scenario.epoch,
      caseId: conflictStay.admissionId,
      encounterId: conflictStay.admissionId,
      patientId: conflictStay.patientId,
      authoredAt: '2026-08-24T08:00:00+08:00',
      reportedAt: '2026-08-24T09:10:00+08:00',
      specimenId: sharedSpecimenId,
      observations: [
        { id: 'obs-ip-conf-a', coding: [{ code: '2160-0', display: '血清肌酐' }], valueQuantity: { value: 1.1, unit: 'mg/dL' } },
        { id: 'obs-ip-conf-b', coding: [{ code: '1700404A', display: '血清肌酐' }], valueQuantity: { value: 3.4, unit: 'mg/dL' } },
      ],
    })

    // Advance scenario virtual time past 12:00 so normal reads reflect all reports cleanly
    const currentScenario = await fixture.read('admin', '/api/sim/v1/scenario-runs/current', scenarioStateSchema)
    const targetMs = Math.max(Date.parse(currentScenario.virtualTime) + 60_000, Date.parse('2026-08-24T12:30:00+08:00'))
    const targetVirtualTime = new Date(targetMs).toISOString()
    const advRes = await fixture.request('admin', `/api/sim/v1/scenario-runs/${currentScenario.scenarioRunId}/actions/advance-time`, {
      expectedVirtualTime: currentScenario.virtualTime,
      targetVirtualTime,
    })
    expect(advRes.status).toBe(200)

    const conflictLedger = await fixture.read(
      'inpatient-doctor',
      `/api/his/v1/inpatient/admissions/${conflictStay.admissionId}/clinical-fact-ledger?itemCodes=2160-0`,
      clinicalFactLedgerSchema,
    )
    const confA = conflictLedger.facts.find(f => f.provenance.recordId === 'obs-ip-conf-a')!
    const confB = conflictLedger.facts.find(f => f.provenance.recordId === 'obs-ip-conf-b')!
    expect(confA.qualityFlags).toContain('conflict')
    expect(confB.qualityFlags).toContain('conflict')
    expect(confA.conflictingFactIds).toEqual([confB.factId])
    expect(confA.eligibleForScoringAndRedLine).toBe(false)
    expect(confB.eligibleForScoringAndRedLine).toBe(false)

    // While unverified, inpatient score MUST stay incomplete (neither conflicting value auto-picked)
    const ipScoresBefore = await fixture.read('inpatient-doctor', `${conflictStay.path}/clinical-scores`, clinicalScoreBundleSchema)
    expect(ipScoresBefore.scores.find(s => s.id === 'ckd-epi-2021-egfr')?.status).toBe('incomplete')

    // Nurse cannot read inpatient clinical-fact-ledger or verify
    const nurseIpForbidden = await fixture.request('ward-nurse', `/api/his/v1/inpatient/admissions/${conflictStay.admissionId}/clinical-fact-ledger`)
    expect(nurseIpForbidden.status).toBe(403)

    // Inpatient doctor mismatched expectedSourceVersion fails 409, then matching version verifies confB (3.4 mg/dL)
    const ipVersionConflict = await fixture.request(
      'inpatient-doctor',
      `/api/his/v1/inpatient/admissions/${conflictStay.admissionId}/clinical-fact-verifications`,
      {
        factId: confB.factId,
        decision: 'verified',
        expectedSourceVersion: '999',
        note: '错版本检查',
      },
    )
    expect(ipVersionConflict.status).toBe(409)
    expect(apiErrorSchema.parse(await ipVersionConflict.json()).error.code).toBe('CLINICAL_FACT_VERSION_CONFLICT')

    const ipVerifyRes = await fixture.request(
      'inpatient-doctor',
      `/api/his/v1/inpatient/admissions/${conflictStay.admissionId}/clinical-fact-verifications`,
      {
        factId: confB.factId,
        decision: 'verified',
        expectedSourceVersion: confB.provenance.recordVersion,
        note: '检验科复核确认3.4mg/dL准确',
      },
    )
    expect(ipVerifyRes.status).toBe(200)
    const ipVerified = clinicalFactVerificationResponseSchema.parse(await ipVerifyRes.json())
    expect(ipVerified.data.fact.clinicianVerification.verified).toBe(true)
    expect(ipVerified.data.fact.eligibleForScoringAndRedLine).toBe(true)

    // Verified confB now participates cleanly in inpatient clinical scores
    const ipScores = await fixture.read('inpatient-doctor', `${conflictStay.path}/clinical-scores`, clinicalScoreBundleSchema)
    expect(ipScores.scores.find(s => s.id === 'ckd-epi-2021-egfr')?.status).toBe('complete')

    // Expired local observation is marked isExpiredAtAsOf & excluded from eligibleForScoringAndRedLine (AC2 / D1)
    insertLabReport(fixture, {
      workspaceId: scenario.workspaceId,
      epoch: scenario.epoch,
      caseId: conflictStay.admissionId,
      encounterId: conflictStay.admissionId,
      patientId: conflictStay.patientId,
      authoredAt: '2026-01-01T08:00:00+08:00',
      reportedAt: '2026-01-01T09:00:00+08:00',
      observations: [{ id: 'obs-ip-expired-cr', coding: [{ code: '2160-0', display: '血清肌酐' }], valueQuantity: { value: 1.5, unit: 'mg/dL' } }],
    })
    const expiredCheckLedger = await fixture.read(
      'inpatient-doctor',
      `/api/his/v1/inpatient/admissions/${conflictStay.admissionId}/clinical-fact-ledger?itemCodes=2160-0`,
      clinicalFactLedgerSchema,
    )
    const expiredCrFact = expiredCheckLedger.facts.find(f => f.provenance.recordId === 'obs-ip-expired-cr')!
    expect(expiredCrFact.isExpiredAtAsOf).toBe(true)
    expect(expiredCrFact.eligibleForScoringAndRedLine).toBe(false)
    expect(expiredCrFact.ineligibleReasons).toContain('expired')
  })
})
