import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { v7 as uuidv7 } from 'uuid'
import {
  clinicalScoreBundleSchema,
  outpatientRiskAssessmentResponseSchema,
} from '@clinmesh/contracts/clinical-scores'
import { fhirBundleSchema, fhirResourceSchema } from '@clinmesh/contracts/fhir'
import {
  createPatientResponseSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  registrationCatalogSchema,
  registrationResponseSchema,
  scenarioStateSchema,
  startVisitResponseSchema,
  triageQueueSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { inpatientFullClinicalResponseSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import {
  createPciPaymentDrgFixture,
  parsePciResponse,
  preparePciPaymentDrgFixture,
  type PciPaymentDrgFixture,
} from './fixtures/pci-payment-drg.ts'

const fixtures: PciPaymentDrgFixture[] = []
afterEach(async () => {
  for (const item of fixtures.splice(0)) await item.close()
})

function insertSyntheticLabReport(
  fixture: PciPaymentDrgFixture,
  options: {
    caseId: string
    encounterId: string
    epoch: string
    issuedAt?: string
    patientId: string
    results: Array<{
      code: string
      display: string
      high?: number
      interpretationCode?: string
      system?: string
      unit: string
      value: number
    }>
    workspaceId: string
  },
) {
  const scope = { workspaceId: options.workspaceId, epoch: options.epoch } as const
  const now = options.issuedAt ?? '2026-10-25T09:30:00+08:00'
  const obsIds: string[] = []
  for (const item of options.results) {
    const obs = fixture.runtime.fhir.create(scope, {
      resourceType: 'Observation',
      id: uuidv7(),
      status: 'final',
      code: {
        coding: [{ code: item.code, display: item.display, system: item.system ?? 'urn:clinmesh:wst:886-2026' }],
        text: item.display,
      },
      subject: { reference: `Patient/${options.patientId}` },
      encounter: { reference: `Encounter/${options.encounterId}` },
      effectiveDateTime: now,
      valueQuantity: { code: item.unit, system: 'http://unitsofmeasure.org', unit: item.unit, value: item.value },
      ...(item.high === undefined ? {} : { referenceRange: [{ high: { value: item.high } }] }),
      ...(item.interpretationCode === undefined
        ? {}
        : { interpretation: [{ coding: [{ code: item.interpretationCode }] }] }),
    })
    obsIds.push(obs.id)
  }
  const report = fixture.runtime.fhir.create(scope, {
    resourceType: 'DiagnosticReport',
    id: uuidv7(),
    status: 'final',
    code: { text: '合成心内专科检验报告' },
    subject: { reference: `Patient/${options.patientId}` },
    encounter: { reference: `Encounter/${options.encounterId}` },
    issued: now,
    result: obsIds.map(id => ({ reference: `Observation/${id}` })),
    conclusion: '合成检验已完成。',
  })
  const serviceRequest = fixture.runtime.fhir.create(scope, {
    resourceType: 'ServiceRequest',
    id: uuidv7(),
    status: 'completed',
    intent: 'order',
    code: { text: '合成心内专科检验' },
    subject: { reference: `Patient/${options.patientId}` },
    encounter: { reference: `Encounter/${options.encounterId}` },
  })
  const task = fixture.runtime.fhir.create(scope, {
    resourceType: 'Task',
    id: uuidv7(),
    status: 'completed',
    intent: 'order',
    for: { reference: `Patient/${options.patientId}` },
    focus: { reference: `ServiceRequest/${serviceRequest.id}` },
  })
  const requestId = uuidv7()
  fixture.runtime.database.driver.prepare(`
    INSERT INTO laboratory_request (
      workspace_id, epoch, request_id, case_id, request_kind, catalog_item_id, reference_json,
      indication_code, service_snapshot_json, service_request_id, execution_task_id,
      diagnostic_report_id, status, version, authored_by, authored_at, reported_at
    ) VALUES (?, ?, ?, ?, 'laboratory', 'synthetic-lab-cardiac', '{}', 'clinical-assessment', '{}', ?, ?, ?, 'reported', 1, 'actor-test', ?, ?)
  `).run(options.workspaceId, options.epoch, requestId, options.caseId, serviceRequest.id, task.id, report.id, now, now)
  return { obsIds, reportId: report.id, requestId }
}

function insertSyntheticEcgReport(
  fixture: PciPaymentDrgFixture,
  options: {
    anteriorText: string
    caseId: string
    conclusion: string
    encounterId: string
    epoch: string
    interpretation: 'abnormal' | 'normal'
    patientId: string
    workspaceId: string
  },
) {
  const scope = { workspaceId: options.workspaceId, epoch: options.epoch } as const
  const now = '2026-10-25T09:45:00+08:00'
  const report = fixture.runtime.fhir.create(scope, {
    resourceType: 'DiagnosticReport',
    id: uuidv7(),
    status: 'final',
    code: { text: '常规 12 导联心电图报告' },
    subject: { reference: `Patient/${options.patientId}` },
    encounter: { reference: `Encounter/${options.encounterId}` },
    issued: now,
    conclusion: options.conclusion,
  })
  const serviceRequest = fixture.runtime.fhir.create(scope, {
    resourceType: 'ServiceRequest',
    id: uuidv7(),
    status: 'completed',
    intent: 'order',
    code: { text: '常规 12 导联心电图' },
    subject: { reference: `Patient/${options.patientId}` },
    encounter: { reference: `Encounter/${options.encounterId}` },
  })
  const task = fixture.runtime.fhir.create(scope, {
    resourceType: 'Task',
    id: uuidv7(),
    status: 'completed',
    intent: 'order',
    for: { reference: `Patient/${options.patientId}` },
    focus: { reference: `ServiceRequest/${serviceRequest.id}` },
  })
  const requestId = uuidv7()
  fixture.runtime.database.driver.prepare(`
    INSERT INTO laboratory_request (
      workspace_id, epoch, request_id, case_id, request_kind, catalog_item_id,
      indication_code, service_snapshot_json, service_request_id, execution_task_id,
      diagnostic_report_id, status, version, authored_by, authored_at, reported_at
    ) VALUES (?, ?, ?, ?, 'examination', 'examination-ecg-12-lead', 'clinical-evaluation', '{}', ?, ?, ?, 'reported', 1, 'actor-test', ?, ?)
  `).run(options.workspaceId, options.epoch, requestId, options.caseId, serviceRequest.id, task.id, report.id, now, now)
  fixture.runtime.database.driver.prepare(`
    INSERT INTO examination_request_detail (workspace_id, epoch, request_id, exam_code, indication)
    VALUES (?, ?, ?, 'ecg-12-lead', '胸闷待查')
  `).run(options.workspaceId, options.epoch, requestId)
  fixture.runtime.database.driver.prepare(`
    INSERT INTO examination_report_content (
      workspace_id, epoch, diagnostic_report_id, request_id, case_id, content_json, issued_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(options.workspaceId, options.epoch, report.id, requestId, options.caseId, JSON.stringify({
    conclusion: options.conclusion,
    results: [
      { code: 'st-t-anterior', display: '前壁导联组 ST-T', value: options.anteriorText, referenceRange: { text: '未见明显异常' }, interpretation: options.interpretation },
      { code: 'st-t-inferior', display: '下壁导联组 ST-T', value: '未见明显异常', referenceRange: { text: '未见明显异常' }, interpretation: 'normal' },
      { code: 'st-t-lateral', display: '侧壁导联组 ST-T', value: '未见明显异常', referenceRange: { text: '未见明显异常' }, interpretation: 'normal' },
    ],
  }), now)
  return report.id
}

describe('Clinical Risk Assessment & Deterministic Clinical Scores HTTP', () => {
  it('records inpatient nursing vitals and risk assessment idempotently with Provenance, rejects query overrides, and computes all 6 scores from objective records', async () => {
    const prepared = await preparePciPaymentDrgFixture()
    const fixture = await createPciPaymentDrgFixture(prepared)
    fixtures.push(fixture)
    const stay = await fixture.preparePciAdmission([])

    // 1. Before vitals/labs/risk assessment: all scores requiring missing inputs return incomplete, never defaulted
    const initialScores = await fixture.read('inpatient-doctor', `${stay.path}/clinical-scores`, clinicalScoreBundleSchema)
    expect(initialScores.vitalSigns).toBeNull()
    expect(initialScores.riskAssessment.revision).toBe(0)
    expect(initialScores.riskAssessment.values).toEqual({
      anginaEpisodes24h: null,
      aspirinUsedLast7Days: null,
      cardiacArrestOnAdmission: null,
      familyHistoryPrematureCad: null,
      killipClass: null,
      knownCoronaryStenosisGe50: null,
      priorBleedingHistory: null,
      smokingStatus: null,
      stSegmentDeviation: null,
    })
    for (const id of ['ckd-epi-2021-egfr', 'cockcroft-gault-crcl', 'grace-acs', 'timi-ua-nstemi', 'precise-dapt']) {
      const score = initialScores.scores.find(item => item.id === id)!
      expect(score.status).toBe('incomplete')
      expect(score.missingInputs.length).toBeGreaterThan(0)
    }

    // Rejects caller attempts to pass unpersisted override parameters on GET
    const overrideAttempt = await fixture.request('inpatient-doctor', `${stay.path}/clinical-scores?serumCreatinine=80&weightKg=70`)
    expect(overrideAttempt.status).toBe(400)

    // 2. Ward nurse records inpatient vital signs (idempotent replay + Provenance + CAS conflict)
    const clinicalBefore = await fixture.read('ward-nurse', `${stay.path}/clinical`, inpatientFullClinicalSchema)
    expect(clinicalBefore.latestVitalSigns).toBeUndefined()
    const vitalsKey = randomUUID()
    const vitalsPayload = {
      bloodPressure: { diastolicMmHg: 82, systolicMmHg: 138 },
      encounterVersion: clinicalBefore.encounterVersion,
      expectedRevision: 0,
      heightCm: 172,
      oxygenSaturationPct: 97,
      pulseBpm: 88,
      respirationBpm: 19,
      temperatureC: 36.8,
      weightKg: 74,
    }
    const recordedVitals = await parsePciResponse(
      inpatientFullClinicalResponseSchema,
      await fixture.request('ward-nurse', `${stay.path}/vital-signs`, vitalsPayload, vitalsKey),
    )
    expect(recordedVitals.data.latestVitalSigns).toMatchObject({
      bloodPressure: { diastolicMmHg: 82, systolicMmHg: 138 },
      heightCm: 172,
      pulseBpm: 88,
      revision: 1,
      weightKg: 74,
    })
    // Same idempotency key replays identical receipt
    const replayedVitals = await parsePciResponse(
      inpatientFullClinicalResponseSchema,
      await fixture.request('ward-nurse', `${stay.path}/vital-signs`, vitalsPayload, vitalsKey),
    )
    expect(replayedVitals.auditId).toBe(recordedVitals.auditId)

    // Stale expectedRevision conflicts with 409
    const staleVitals = await fixture.request('ward-nurse', `${stay.path}/vital-signs`, vitalsPayload, randomUUID())
    expect(staleVitals.status).toBe(409)

    // Verify FHIR Observation + Provenance exist
    const vitalObs = await fixture.read('inpatient-doctor', `/fhir/R5/Observation/${recordedVitals.data.latestVitalSigns!.observationId}`, fhirResourceSchema)
    expect(vitalObs.status).toBe('final')
    const vitalProv = await fixture.read('inpatient-doctor', `/fhir/R5/Provenance/${recordedVitals.data.latestVitalSigns!.provenanceId}`, fhirResourceSchema)
    expect(vitalProv).toMatchObject({ resourceType: 'Provenance' })

    // 3. Complete angiography + PCI baseline labs (WBC 6.2 10*9/L, Hb 145 g/L, SCr 0.9 mg/dL) + add Troponin & LDL-C
    const scenario = await fixture.read('admin', '/api/sim/v1/scenario-runs/current', scenarioStateSchema)
    await fixture.executeAngiography(stay)
    await fixture.runtime.dispatcher.dispatchOnce({ kinds: ['inpatient.angiography.report'] })
    await fixture.completePciLaboratories(stay)
    insertSyntheticLabReport(fixture, {
      caseId: stay.admissionId,
      encounterId: stay.admissionId,
      epoch: scenario.epoch,
      patientId: stay.patientId,
      results: [
        { code: '2100404B', display: '高敏心肌肌钙蛋白I', high: 0.04, interpretationCode: 'H', unit: 'ng/mL', value: 0.36 },
        { code: '2000404A', display: '低密度脂蛋白胆固醇', high: 3.4, unit: 'mmol/L', value: 2.35 },
      ],
      workspaceId: scenario.workspaceId,
    })

    // 4. Record partial Clinical Risk Assessment first — unsubmitted fields stay null ("未记录")
    const clinicalAfterLabs = await fixture.read('inpatient-doctor', `${stay.path}/clinical`, inpatientFullClinicalSchema)
    const clinicalCookie = await fixture.login('inpatient-doctor')
    const putRisk = (expectedRevision: number, fields: Record<string, unknown>, key = randomUUID()) =>
      fixture.runtime.app.request(`http://localhost${stay.path}/risk-assessment`, {
        body: JSON.stringify({
          input: {
            encounterVersion: clinicalAfterLabs.encounterVersion,
            expectedRevision,
            fields,
          },
        }),
        headers: {
          'content-type': 'application/json',
          cookie: clinicalCookie,
          'idempotency-key': key,
          origin: 'http://localhost',
        },
        method: 'PUT',
      })

    const partialRisk = await parsePciResponse(
      inpatientFullClinicalResponseSchema,
      await putRisk(0, { cardiacArrestOnAdmission: false, killipClass: 'II', stSegmentDeviation: false }),
    )
    expect(partialRisk.data.riskAssessment).toMatchObject({
      effectiveStSegmentDeviation: { source: 'bedside', value: false },
      revision: 1,
      values: {
        anginaEpisodes24h: null,
        aspirinUsedLast7Days: null,
        cardiacArrestOnAdmission: false,
        killipClass: 'II',
        priorBleedingHistory: null,
        smokingStatus: null,
        stSegmentDeviation: false,
      },
    })

    // Issued 12-lead ECG report with ST depression overrides bedside false -> true!
    const ecgReportId = insertSyntheticEcgReport(fixture, {
      anteriorText: 'V2-V5 导联 ST 段水平型压低 0.15 mV',
      caseId: stay.admissionId,
      conclusion: '窦性心律，前壁导联 ST 段压低。',
      encounterId: stay.admissionId,
      epoch: scenario.epoch,
      interpretation: 'abnormal',
      patientId: stay.patientId,
      workspaceId: scenario.workspaceId,
    })

    // Before knownCoronaryStenosisGe50 is recorded (and QCA-only angiography has no vessel stenosis %), TIMI stays incomplete
    const beforeStenosisScores = await fixture.read('inpatient-doctor', `${stay.path}/clinical-scores`, clinicalScoreBundleSchema)
    expect(beforeStenosisScores.scores.find(item => item.id === 'timi-ua-nstemi')).toMatchObject({
      missingInputs: expect.arrayContaining(['knownCoronaryStenosisGe50']),
      status: 'incomplete',
    })

    // Fill remaining risk fields (revision 1 -> 2), preserving killipClass & cardiacArrestOnAdmission!
    const fullRisk = await parsePciResponse(
      inpatientFullClinicalResponseSchema,
      await putRisk(1, {
        anginaEpisodes24h: 2,
        aspirinUsedLast7Days: true,
        familyHistoryPrematureCad: false,
        knownCoronaryStenosisGe50: true,
        priorBleedingHistory: 'negative',
        smokingStatus: 'current',
      }),
    )
    expect(fullRisk.data.riskAssessment?.revision).toBe(2)
    expect(fullRisk.data.riskAssessment?.values.killipClass).toBe('II')
    expect(fullRisk.data.riskAssessment?.effectiveStSegmentDeviation).toEqual({
      source: 'ecg-report',
      sourceReference: `DiagnosticReport/${ecgReportId}`,
      value: true,
      versionId: '1',
    })

    // 5. All 6 scores now evaluate to 'complete' with deterministic values and exact versioned sourceReferences
    const completedScores = await fixture.read('inpatient-doctor', `${stay.path}/clinical-scores`, clinicalScoreBundleSchema)
    expect(completedScores.scores.every(score => score.status === 'complete')).toBe(true)
    const grace = completedScores.scores.find(item => item.id === 'grace-acs')!
    expect(grace.status).toBe('complete')
    if (grace.status === 'complete') {
      expect(grace.sourceReferences).toContainEqual(expect.objectContaining({ reference: `DiagnosticReport/${ecgReportId}`, versionId: '1' }))
    }

    // Later normal convalescent troponin report must NOT erase the initially elevated admission troponin in GRACE or TIMI
    const timiBeforeFollowupTn = completedScores.scores.find(item => item.id === 'timi-ua-nstemi')!
    insertSyntheticLabReport(fixture, {
      caseId: stay.admissionId,
      encounterId: stay.admissionId,
      epoch: scenario.epoch,
      issuedAt: '2026-10-29T09:30:00+08:00',
      patientId: stay.patientId,
      results: [
        { code: '2100404B', display: '高敏心肌肌钙蛋白I', high: 0.04, interpretationCode: 'N', unit: 'ng/mL', value: 0.01 },
      ],
      workspaceId: scenario.workspaceId,
    })
    const afterFollowupNormalTn = await fixture.read('inpatient-doctor', `${stay.path}/clinical-scores`, clinicalScoreBundleSchema)
    expect(afterFollowupNormalTn.scores.find(item => item.id === 'grace-acs')?.value).toBe(grace.value)
    expect(afterFollowupNormalTn.scores.find(item => item.id === 'timi-ua-nstemi')?.value).toBe(timiBeforeFollowupTn.value)
    const ascvd = completedScores.scores.find(item => item.id === 'ascvd-ldl-target')!
    expect(ascvd).toMatchObject({
      status: 'complete',
      ldlGoalEvaluation: { atGoal: false, currentLdlMmolL: 2.35 },
    })
    const crclBefore = completedScores.scores.find(item => item.id === 'cockcroft-gault-crcl')!
    expect(crclBefore.status).toBe('complete')

    // 6. Revising inpatient vitals (revision 1 -> 2, weight 74 -> 62 kg) supersedes old Observation and updates CrCl & sourceReferences
    const revisedVitals = await parsePciResponse(
      inpatientFullClinicalResponseSchema,
      await fixture.request('ward-nurse', `${stay.path}/vital-signs`, {
        ...vitalsPayload,
        encounterVersion: fullRisk.data.encounterVersion,
        expectedRevision: 1,
        weightKg: 62,
      }, randomUUID()),
    )
    expect(revisedVitals.data.latestVitalSigns?.revision).toBe(2)
    const supersededObs = await fixture.read('inpatient-doctor', `/fhir/R5/Observation/${recordedVitals.data.latestVitalSigns!.observationId}`, fhirResourceSchema)
    expect(supersededObs.status).toBe('entered-in-error')
    const scoresAfterVitalRev = await fixture.read('inpatient-doctor', `${stay.path}/clinical-scores`, clinicalScoreBundleSchema)
    const crclAfter = scoresAfterVitalRev.scores.find(item => item.id === 'cockcroft-gault-crcl')!
    expect(crclAfter.status).toBe('complete')
    if (crclBefore.status === 'complete' && crclAfter.status === 'complete') {
      expect(crclAfter.value).toBeLessThan(crclBefore.value)
      expect(crclAfter.sourceReferences).toContainEqual(expect.objectContaining({
        reference: `Observation/${revisedVitals.data.latestVitalSigns!.observationId}`,
        versionId: '1',
      }))
    }
  }, 60_000)

  it('persists optional outpatient triage heightCm/weightKg with Provenance and evaluates outpatient clinical scores', async () => {
    const prepared = await preparePciPaymentDrgFixture()
    const fixture = await createPciPaymentDrgFixture(prepared)
    fixtures.push(fixture)

    // Create a fresh adult outpatient visit
    const scenario = await fixture.read('admin', '/api/sim/v1/scenario-runs/current', scenarioStateSchema)
    const createdPatient = await parsePciResponse(
      createPatientResponseSchema,
      await fixture.request('registrar', '/api/his/v1/patients', {
        birthDate: '1968-05-10',
        gender: 'female',
        identifier: `SYN-${randomUUID()}`,
        name: '合成门诊评分患者',
      }, randomUUID(), {}),
    )
    const patient = createdPatient.data.patient
    const patientId = patient.id
    const regCatalog = await fixture.read('registrar', '/api/his/v1/catalogs/registration', registrationCatalogSchema)
    const registered = await parsePciResponse(
      registrationResponseSchema,
      await fixture.request('registrar', '/api/his/v1/registrations/actions/register', {
        departmentId: regCatalog.departments[0]!.id,
        locationId: regCatalog.locations[0]!.id,
        patientId,
        visitDate: regCatalog.virtualDate,
        visitTypeId: regCatalog.visitTypes[0]!.id,
      }, randomUUID(), { [`Patient/${patientId}`]: patient.versionId }),
    )
    const encounterId = registered.data.encounterId

    // Triage records weightKg=64.5 and heightCm=162
    const triaged = await parsePciResponse(
      triageResponseSchema,
      await fixture.request('triage', `/api/his/v1/encounters/${encounterId}/actions/record-triage`, {
        acuityCode: 'level-2',
        bloodPressure: { diastolicMmHg: 86, systolicMmHg: 146 },
        chiefComplaint: '发作性胸骨后闷痛 2 天',
        heightCm: 162,
        oxygenSaturationPct: 98,
        pulseBpm: 94,
        respirationBpm: 20,
        temperatureC: 36.6,
        weightKg: 64.5,
      }, randomUUID(), {
        [`Encounter/${encounterId}`]: '1',
        [`Task/${registered.data.queueTaskId}`]: '1',
      }),
    )
    expect(triaged.effects.some(effect => effect.reference.startsWith('Provenance/'))).toBe(true)

    const completedTriageQueue = await fixture.read('triage', '/api/his/v1/triage/queue?status=completed&page=1&pageSize=20', triageQueueSchema)
    expect(completedTriageQueue.items.find(item => item.encounterId === encounterId)?.triage).toMatchObject({
      heightCm: 162,
      weightKg: 64.5,
    })

    await parsePciResponse(
      startVisitResponseSchema,
      await fixture.request('doctor', `/api/his/v1/encounters/${encounterId}/actions/start-first-visit`, {}, randomUUID(), {
        [`Encounter/${encounterId}`]: triaged.data.encounterVersion,
        [`Task/${triaged.data.doctorTaskId}`]: '1',
      }),
    )
    const doctorQueue = await fixture.read('doctor', '/api/his/v1/doctor/queue', doctorQueueSchema)
    const caseItem = doctorQueue.items.find(item => item.encounterId === encounterId)!
    expect(caseItem.presentation?.vitalSigns).toMatchObject({ heightCm: 162, weightKg: 64.5 })
    const detail = await fixture.read('doctor', `/api/his/v1/doctor/cases/${caseItem.caseId}`, doctorCaseDetailSchema)
    expect(detail.triage).toMatchObject({ heightCm: 162, weightKg: 64.5 })

    // Insert dual-track labs (SCr in umol/L, Hb in g/dL, lipids in mg/dL, WBC, Troponin)
    insertSyntheticLabReport(fixture, {
      caseId: caseItem.caseId,
      encounterId,
      epoch: scenario.epoch,
      patientId,
      results: [
        { code: '1700404A', display: '血清肌酐', high: 84, unit: 'umol/L', value: 88.4 },
        { code: '718-7', display: '血红蛋白', system: 'http://loinc.org', unit: 'g/dL', value: 12.8 },
        { code: '6690-2', display: '白细胞计数', system: 'http://loinc.org', unit: '10*9/L', value: 8.4 },
        { code: '2100404B', display: '高敏肌钙蛋白I', high: 0.04, interpretationCode: 'N', unit: 'ng/mL', value: 0.01 },
        { code: '2000104A', display: '总胆固醇', unit: 'mg/dL', value: 212 },
        { code: '2000304A', display: '高密度脂蛋白胆固醇', unit: 'mg/dL', value: 46 },
        { code: '2000404A', display: '低密度脂蛋白胆固醇', unit: 'mg/dL', value: 135 },
      ],
      workspaceId: scenario.workspaceId,
    })

    // Primary prevention without smokingStatus returns incomplete on ascvd-ldl-target
    const beforeSmoking = await fixture.read('doctor', `/api/his/v1/doctor/cases/${caseItem.caseId}/clinical-scores`, clinicalScoreBundleSchema)
    expect(beforeSmoking.scores.find(item => item.id === 'ckd-epi-2021-egfr')?.status).toBe('complete')
    expect(beforeSmoking.scores.find(item => item.id === 'cockcroft-gault-crcl')?.status).toBe('complete')
    expect(beforeSmoking.scores.find(item => item.id === 'ascvd-ldl-target')).toMatchObject({
      missingInputs: ['smokingStatus'],
      status: 'incomplete',
    })

    // Record outpatient risk assessment via PUT /api/his/v1/encounters/:encounterId/risk-assessment
    const doctorCookie = await fixture.login('doctor')
    const riskRes = await fixture.runtime.app.request(`http://localhost/api/his/v1/encounters/${encounterId}/risk-assessment`, {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${encounterId}`]: detail.encounter.versionId },
        input: {
          expectedRevision: 0,
          fields: {
            anginaEpisodes24h: 1,
            aspirinUsedLast7Days: false,
            cardiacArrestOnAdmission: false,
            killipClass: 'I',
            knownCoronaryStenosisGe50: false,
            priorBleedingHistory: 'negative',
            smokingStatus: 'never',
            stSegmentDeviation: false,
          },
        },
      }),
      headers: {
        'content-type': 'application/json',
        cookie: doctorCookie,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'PUT',
    })
    const recordedRisk = await parsePciResponse(outpatientRiskAssessmentResponseSchema, riskRes)
    expect(recordedRisk.data.riskAssessment.revision).toBe(1)

    const afterRisk = await fixture.read('doctor', `/api/his/v1/doctor/cases/${caseItem.caseId}/clinical-scores`, clinicalScoreBundleSchema)
    expect(afterRisk.scores.every(item => item.status === 'complete')).toBe(true)

    // Unconfirmed 'provisional' Condition must NOT be treated as confirmed ASCVD secondary prevention
    fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
      code: { coding: [{ code: 'I21.4', display: '急性非ST段抬高型心肌梗死' }] },
      encounter: { reference: `Encounter/${encounterId}` },
      id: uuidv7(),
      resourceType: 'Condition',
      subject: { reference: `Patient/${patientId}` },
      verificationStatus: { coding: [{ code: 'provisional', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
    })
    // Compound negated ECG conclusion must resolve to value: false even if bedside stSegmentDeviation is true
    await parsePciResponse(
      outpatientRiskAssessmentResponseSchema,
      await fixture.runtime.app.request(`http://localhost/api/his/v1/encounters/${encounterId}/risk-assessment`, {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${encounterId}`]: detail.encounter.versionId },
          input: { expectedRevision: 1, fields: { stSegmentDeviation: true } },
        }),
        headers: {
          'content-type': 'application/json',
          cookie: doctorCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'PUT',
      }),
    )
    const normalEcgId = insertSyntheticEcgReport(fixture, {
      anteriorText: '无 ST 段抬高或压低',
      caseId: caseItem.caseId,
      conclusion: '窦性心律，未见 ST 段抬高或 ST 段压低。',
      encounterId,
      epoch: scenario.epoch,
      interpretation: 'normal',
      patientId,
      workspaceId: scenario.workspaceId,
    })
    const afterNegatedEcg = await fixture.read('doctor', `/api/his/v1/doctor/cases/${caseItem.caseId}/clinical-scores`, clinicalScoreBundleSchema)
    expect(afterNegatedEcg.riskAssessment.effectiveStSegmentDeviation).toEqual({
      source: 'ecg-report',
      sourceReference: `DiagnosticReport/${normalEcgId}`,
      value: false,
      versionId: '1',
    })
    expect(afterNegatedEcg.scores.find(item => item.id === 'ascvd-ldl-target')?.tierCode).not.toBe('ultra-high')

    // Same historical stroke copied across two Condition records (same onset or carried forward without new onset) counts as 1 event -> very-high (<1.8), NOT ultra-high
    for (const copyIdx of [1, 2]) {
      fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
        clinicalStatus: { coding: [{ code: 'resolved', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
        code: { coding: [{ code: 'I63.9', display: `既往脑梗死延续记录 #${copyIdx}` }] },
        ...(copyIdx === 1 ? { onsetDateTime: '2022-04-10T08:00:00+08:00' } : {}),
        id: uuidv7(),
        resourceType: 'Condition',
        subject: { reference: `Patient/${patientId}` },
        verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
      })
    }
    const afterCopiedSingleStroke = await fixture.read('doctor', `/api/his/v1/doctor/cases/${caseItem.caseId}/clinical-scores`, clinicalScoreBundleSchema)
    expect(afterCopiedSingleStroke.scores.find(item => item.id === 'ascvd-ldl-target')).toMatchObject({
      status: 'complete',
      tierCode: 'very-high',
      value: 1.8,
    })

    // Adding a genuinely repeated second stroke with a distinct onset date reaches >=2 severe ASCVD events -> ultra-high (<1.4)
    fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      clinicalStatus: { coding: [{ code: 'resolved', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
      code: { coding: [{ code: 'I63.9', display: '第二次缺血性脑卒中' }] },
      id: uuidv7(),
      onsetDateTime: '2024-09-18T10:30:00+08:00',
      resourceType: 'Condition',
      subject: { reference: `Patient/${patientId}` },
      verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
    })
    const afterResolvedStrokes = await fixture.read('doctor', `/api/his/v1/doctor/cases/${caseItem.caseId}/clinical-scores`, clinicalScoreBundleSchema)
    expect(afterResolvedStrokes.scores.find(item => item.id === 'ascvd-ldl-target')).toMatchObject({
      status: 'complete',
      tierCode: 'ultra-high',
      value: 1.4,
    })

    // Subsequent non-triage vital-signs Observation on the same Encounter must NOT hijack triage Observation provenance
    const triageObsRef = triaged.effects.find(effect => effect.reference.startsWith('Observation/'))!.reference
    fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      category: [{ coding: [{ code: 'vital-signs', display: 'Vital Signs', system: 'http://terminology.hl7.org/CodeSystem/observation-category' }] }],
      code: { text: 'Follow-up clinic vital signs' },
      effectiveDateTime: '2026-11-17T12:00:00+08:00',
      encounter: { reference: `Encounter/${encounterId}` },
      id: uuidv7(),
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: `Patient/${patientId}` },
    })
    const afterLaterVitalObs = await fixture.read('doctor', `/api/his/v1/doctor/cases/${caseItem.caseId}/clinical-scores`, clinicalScoreBundleSchema)
    expect(`Observation/${afterLaterVitalObs.vitalSigns?.observationId}`).toBe(triageObsRef)
    expect(afterLaterVitalObs.scores.find(item => item.id === 'cockcroft-gault-crcl')?.sourceReferences).toContainEqual(
      expect.objectContaining({ reference: triageObsRef }),
    )

    const provenances = await fixture.read('doctor', `/fhir/R5/Provenance?target=Observation/${recordedRisk.data.riskAssessment.observationId}`, fhirBundleSchema)
    expect(provenances.entry?.length).toBe(1)
  }, 60_000)
})
