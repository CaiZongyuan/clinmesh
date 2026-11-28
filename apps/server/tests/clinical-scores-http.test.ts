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
import { insertSyntheticEcgReport } from './fixtures/synthetic-ecg-report.ts'

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
  const now = options.issuedAt ?? '2026-08-24T09:30:00+08:00'
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
    const admissionCardiacReport = insertSyntheticLabReport(fixture, {
      caseId: stay.admissionId,
      encounterId: stay.admissionId,
      epoch: scenario.epoch,
      issuedAt: recordedVitals.data.latestVitalSigns!.recordedAt,
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

    // Stable CAD (I25.103) alone without UA/NSTEMI encounter presentation keeps GRACE and TIMI incomplete while PRECISE-DAPT completes under planned 36.0700 PCI stenting
    const stableCadScores = await fixture.read('inpatient-doctor', `${stay.path}/clinical-scores`, clinicalScoreBundleSchema)
    expect(stableCadScores.scores.find(s => s.id === 'precise-dapt')?.status).toBe('complete')
    expect(stableCadScores.scores.find(s => s.id === 'timi-ua-nstemi')).toMatchObject({
      missingInputs: ['uaNstemiPresentation'],
      status: 'incomplete',
    })
    expect(stableCadScores.scores.find(s => s.id === 'grace-acs')).toMatchObject({
      missingInputs: ['acsPresentation'],
      status: 'incomplete',
    })

    // Confirming NSTEMI (I21.4) with recordedDate only (no onsetDateTime) activates GRACE and TIMI UA/NSTEMI,
    // while ASCVD LDL-C target preserves uncertainty ('cadOnsetAge') instead of treating recordedDate as CAD onset
    const nstemiCondition = fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
      code: { coding: [{ code: 'I21.4', display: '急性非ST段抬高型心肌梗死' }], text: '急性非ST段抬高型心肌梗死' },
      encounter: { reference: `Encounter/${stay.admissionId}` },
      id: uuidv7(),
      recordedDate: '2026-10-25T09:50:00+08:00',
      resourceType: 'Condition',
      subject: { reference: `Patient/${stay.patientId}` },
      verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
    })
    const beforeCadOnsetScores = await fixture.read('inpatient-doctor', `${stay.path}/clinical-scores`, clinicalScoreBundleSchema)
    expect(beforeCadOnsetScores.scores.find(item => item.id === 'grace-acs')?.status).toBe('complete')
    expect(beforeCadOnsetScores.scores.find(item => item.id === 'timi-ua-nstemi')?.status).toBe('complete')
    expect(beforeCadOnsetScores.scores.find(item => item.id === 'ascvd-ldl-target')).toMatchObject({
      missingInputs: ['cadOnsetAge'],
      status: 'incomplete',
    })

    // Documenting explicit onsetDateTime on the patient's CAD/MI Conditions resolves cadOnsetAge -> all 6 scores complete!
    const stayConditions = fixture.runtime.fhir.search(
      { epoch: scenario.epoch, workspaceId: scenario.workspaceId },
      'Condition',
      new URLSearchParams({ _count: '50', patient: `Patient/${stay.patientId}` }),
    )
    for (const cond of stayConditions.resources) {
      fixture.runtime.fhir.update(
        { epoch: scenario.epoch, workspaceId: scenario.workspaceId },
        {
          ...cond,
          onsetDateTime: cond.id === nstemiCondition.id ? '2026-10-25T08:00:00+08:00' : '2024-06-01T09:00:00+08:00',
        },
        cond.meta?.versionId ?? '1',
      )
    }

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
    const preciseBefore = completedScores.scores.find(item => item.id === 'precise-dapt')!
    expect(crclBefore.status).toBe('complete')

    // 6. Subsequent nursing vitals & serial chemistry update CrCl/eGFR with latest values while GRACE preserves initial admission vitals & initial creatinine
    const revisedVitals = await parsePciResponse(
      inpatientFullClinicalResponseSchema,
      await fixture.request('ward-nurse', `${stay.path}/vital-signs`, {
        ...vitalsPayload,
        bloodPressure: { diastolicMmHg: 58, systolicMmHg: 86 },
        encounterVersion: fullRisk.data.encounterVersion,
        expectedRevision: 1,
        pulseBpm: 152,
        weightKg: 62,
      }, randomUUID()),
    )
    expect(revisedVitals.data.latestVitalSigns?.revision).toBe(2)
    const initialVitalObs = await fixture.read('inpatient-doctor', `/fhir/R5/Observation/${recordedVitals.data.latestVitalSigns!.observationId}`, fhirResourceSchema)
    expect(initialVitalObs.status).toBe('final')
    insertSyntheticLabReport(fixture, {
      caseId: stay.admissionId,
      encounterId: stay.admissionId,
      epoch: scenario.epoch,
      issuedAt: '2026-10-30T09:30:00+08:00',
      patientId: stay.patientId,
      results: [
        { code: '1700404A', display: '血清肌酐', high: 84, unit: 'mg/dL', value: 3.2 },
      ],
      workspaceId: scenario.workspaceId,
    })
    const scoresAfterVitalRev = await fixture.read('inpatient-doctor', `${stay.path}/clinical-scores`, clinicalScoreBundleSchema)
    const crclAfter = scoresAfterVitalRev.scores.find(item => item.id === 'cockcroft-gault-crcl')!
    expect(crclAfter.status).toBe('complete')
    expect(scoresAfterVitalRev.scores.find(item => item.id === 'grace-acs')?.value).toBe(grace.value)
    expect(scoresAfterVitalRev.scores.find(item => item.id === 'precise-dapt')?.value).toBe(preciseBefore.value)
    if (crclBefore.status === 'complete' && crclAfter.status === 'complete') {
      expect(crclAfter.value).toBeLessThan(crclBefore.value)
      expect(crclAfter.sourceReferences).toContainEqual(expect.objectContaining({
        reference: `Observation/${revisedVitals.data.latestVitalSigns!.observationId}`,
        versionId: '1',
      }))
    }

    // 7. Correcting an admission lab report days after angiography/medications overwrites replacement Observation.effectiveDateTime to correction time,
    // yet GRACE & TIMI preserve the root specimen acquisition time via laboratory_report_revision while referencing the corrected Observation
    const lateCorrectionTime = '2026-11-01T10:00:00+08:00'
    const correctedTnObs = fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      code: { coding: [{ code: '2100404B', display: '高敏心肌肌钙蛋白I', system: 'urn:clinmesh:wst:886-2026' }], text: '高敏心肌肌钙蛋白I' },
      effectiveDateTime: lateCorrectionTime,
      encounter: { reference: `Encounter/${stay.admissionId}` },
      id: uuidv7(),
      interpretation: [{ coding: [{ code: 'H' }] }],
      issued: lateCorrectionTime,
      referenceRange: [{ high: { value: 0.04 } }],
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: `Patient/${stay.patientId}` },
      valueQuantity: { code: 'ng/mL', system: 'http://unitsofmeasure.org', unit: 'ng/mL', value: 0.42 },
    })
    const correctedLdlObs = fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      code: { coding: [{ code: '2000404A', display: '低密度脂蛋白胆固醇', system: 'urn:clinmesh:wst:886-2026' }], text: '低密度脂蛋白胆固醇' },
      effectiveDateTime: lateCorrectionTime,
      encounter: { reference: `Encounter/${stay.admissionId}` },
      id: uuidv7(),
      issued: lateCorrectionTime,
      referenceRange: [{ high: { value: 3.4 } }],
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: `Patient/${stay.patientId}` },
      valueQuantity: { code: 'mmol/L', system: 'http://unitsofmeasure.org', unit: 'mmol/L', value: 2.25 },
    })
    const correctedDr = fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      code: { text: '合成心内专科检验报告（已更正）' },
      conclusion: '肌钙蛋白复核更正。',
      effectiveDateTime: lateCorrectionTime,
      encounter: { reference: `Encounter/${stay.admissionId}` },
      id: uuidv7(),
      issued: lateCorrectionTime,
      resourceType: 'DiagnosticReport',
      result: [{ reference: `Observation/${correctedTnObs.id}` }, { reference: `Observation/${correctedLdlObs.id}` }],
      status: 'final',
      subject: { reference: `Patient/${stay.patientId}` },
    })
    fixture.runtime.database.driver.prepare(`
      INSERT INTO laboratory_report_revision (
        workspace_id, epoch, revision_id, request_id, diagnostic_report_id,
        revision_of_diagnostic_report_id, provenance_id, reason, corrected_by, corrected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '复核仪器定标偏差', 'actor-test', ?)
    `).run(
      scenario.workspaceId,
      scenario.epoch,
      uuidv7(),
      admissionCardiacReport.requestId,
      correctedDr.id,
      admissionCardiacReport.reportId,
      uuidv7(),
      lateCorrectionTime,
    )
    fixture.runtime.database.driver.prepare(`
      UPDATE laboratory_request
      SET diagnostic_report_id = ?, reported_at = ?, version = version + 1
      WHERE workspace_id = ? AND epoch = ? AND request_id = ?
    `).run(correctedDr.id, lateCorrectionTime, scenario.workspaceId, scenario.epoch, admissionCardiacReport.requestId)

    const scoresAfterLateCorrection = await fixture.read('inpatient-doctor', `${stay.path}/clinical-scores`, clinicalScoreBundleSchema)
    const graceAfterCorrection = scoresAfterLateCorrection.scores.find(item => item.id === 'grace-acs')!
    expect(graceAfterCorrection.status).toBe('complete')
    expect(graceAfterCorrection.value).toBe(grace.value)
    expect(graceAfterCorrection.sourceReferences).toContainEqual(expect.objectContaining({
      reference: `Observation/${correctedTnObs.id}`,
      versionId: '1',
    }))
    expect(scoresAfterLateCorrection.scores.find(item => item.id === 'timi-ua-nstemi')?.status).toBe('complete')
    expect(scoresAfterLateCorrection.scores.find(item => item.id === 'ascvd-ldl-target')).toMatchObject({
      ldlGoalEvaluation: { atGoal: false, currentLdlMmolL: 2.25 },
      status: 'complete',
    })
  }, 120_000)

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

    // Inverted blood pressure (80/120 mmHg) is rejected at triage recording with 400
    const invertedBpRes = await fixture.request('triage', `/api/his/v1/encounters/${encounterId}/actions/record-triage`, {
      acuityCode: 'level-2',
      bloodPressure: { diastolicMmHg: 120, systolicMmHg: 80 },
      chiefComplaint: '发作性胸骨后闷痛 2 天',
      oxygenSaturationPct: 98,
      pulseBpm: 94,
      respirationBpm: 20,
      temperatureC: 36.6,
    }, randomUUID(), {
      [`Encounter/${encounterId}`]: '1',
      [`Task/${registered.data.queueTaskId}`]: '1',
    })
    expect(invertedBpRes.status).toBe(400)

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

    // Undifferentiated outpatient without UA/NSTEMI diagnosis or PCI/DAPT completes general renal/ASCVD scores while withholding GRACE, TIMI, and PRECISE-DAPT
    const afterRisk = await fixture.read('doctor', `/api/his/v1/doctor/cases/${caseItem.caseId}/clinical-scores`, clinicalScoreBundleSchema)
    expect(afterRisk.scores.find(item => item.id === 'ckd-epi-2021-egfr')?.status).toBe('complete')
    expect(afterRisk.scores.find(item => item.id === 'cockcroft-gault-crcl')?.status).toBe('complete')
    expect(afterRisk.scores.find(item => item.id === 'ascvd-ldl-target')?.status).toBe('complete')
    expect(afterRisk.scores.find(item => item.id === 'grace-acs')).toMatchObject({
      missingInputs: ['acsPresentation'],
      status: 'incomplete',
    })
    expect(afterRisk.scores.find(item => item.id === 'timi-ua-nstemi')).toMatchObject({
      missingInputs: ['uaNstemiPresentation'],
      status: 'incomplete',
    })
    expect(afterRisk.scores.find(item => item.id === 'precise-dapt')).toMatchObject({
      missingInputs: ['pciDaptIndication'],
      status: 'incomplete',
    })

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
      conclusion: '窦性心律，未见 ST 段抬高或 ST 段压低但 T 波轻度平低。',
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
    expect(afterNegatedEcg.scores.find(item => item.id === 'grace-acs')?.status).toBe('complete')
    expect(afterNegatedEcg.scores.find(item => item.id === 'timi-ua-nstemi')?.status).toBe('complete')
    expect(afterNegatedEcg.scores.find(item => item.id === 'precise-dapt')?.status).toBe('incomplete')

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

    // Two separate acute MI Conditions created with recordedDate (>28 days apart, without onsetDateTime or identifier) count as 2 severe events -> ultra-high (<1.4)
    const recurrentPatient = (await parsePciResponse(
      createPatientResponseSchema,
      await fixture.request('registrar', '/api/his/v1/patients', {
        birthDate: '1965-03-10',
        gender: 'male',
        identifier: `REC-${randomUUID()}`,
        name: '合成复发心梗与月度处方患者',
      }, randomUUID(), {}),
    )).data.patient
    const recReg = (await parsePciResponse(
      registrationResponseSchema,
      await fixture.request('registrar', '/api/his/v1/registrations/actions/register', {
        departmentId: regCatalog.departments[0]!.id,
        locationId: regCatalog.locations[0]!.id,
        patientId: recurrentPatient.id,
        visitDate: regCatalog.virtualDate,
        visitTypeId: regCatalog.visitTypes[0]!.id,
      }, randomUUID(), { [`Patient/${recurrentPatient.id}`]: recurrentPatient.versionId }),
    )).data
    const recTriaged = await parsePciResponse(
      triageResponseSchema,
      await fixture.request('triage', `/api/his/v1/encounters/${recReg.encounterId}/actions/record-triage`, {
        acuityCode: 'level-2',
        bloodPressure: { diastolicMmHg: 78, systolicMmHg: 124 },
        chiefComplaint: '复发性胸痛 1 小时',
        oxygenSaturationPct: 97,
        pulseBpm: 84,
        respirationBpm: 18,
        temperatureC: 36.6,
      }, randomUUID(), {
        [`Encounter/${recReg.encounterId}`]: '1',
        [`Task/${recReg.queueTaskId}`]: '1',
      }),
    )
    await parsePciResponse(
      startVisitResponseSchema,
      await fixture.request('doctor', `/api/his/v1/encounters/${recReg.encounterId}/actions/start-first-visit`, {}, randomUUID(), {
        [`Encounter/${recReg.encounterId}`]: recTriaged.data.encounterVersion,
        [`Task/${recTriaged.data.doctorTaskId}`]: '1',
      }),
    )
    const recQueue = await fixture.read('doctor', '/api/his/v1/doctor/queue', doctorQueueSchema)
    const recCase = recQueue.items.find(item => item.encounterId === recReg.encounterId)!
    for (const recordedDate of ['2025-05-10T09:00:00+08:00', '2026-08-24T09:00:00+08:00']) {
      fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
        clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
        code: { coding: [{ code: 'I21.9', display: '急性心肌梗死（未特指亚型）' }] },
        ...(recordedDate.startsWith('2026') ? { encounter: { reference: `Encounter/${recReg.encounterId}` } } : {}),
        id: uuidv7(),
        recordedDate,
        resourceType: 'Condition',
        subject: { reference: `Patient/${recurrentPatient.id}` },
        verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
      })
    }
    // Rhythm-only ECG report (no ST-T lead documentation) must NOT satisfy UA/NSTEMI subtype applicability for generic I21.9
    const rhythmOnlyDr = fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      code: { text: '常规 12 导联心电图报告' },
      conclusion: '窦性心律，心率 84 次/分。',
      encounter: { reference: `Encounter/${recReg.encounterId}` },
      id: uuidv7(),
      issued: '2026-08-24T09:15:00+08:00',
      resourceType: 'DiagnosticReport',
      status: 'final',
      subject: { reference: `Patient/${recurrentPatient.id}` },
    })
    const rhythmReqId = uuidv7()
    fixture.runtime.database.driver.prepare(`
      INSERT INTO laboratory_request (
        workspace_id, epoch, request_id, case_id, request_kind, catalog_item_id,
        indication_code, service_snapshot_json, service_request_id, execution_task_id,
        diagnostic_report_id, status, version, authored_by, authored_at, reported_at
      ) VALUES (?, ?, ?, ?, 'examination', 'examination-ecg-12-lead', 'clinical-evaluation', '{}', ?, ?, ?, 'reported', 1, 'actor-test', '2026-08-24T09:10:00+08:00', '2026-08-24T09:15:00+08:00')
    `).run(scenario.workspaceId, scenario.epoch, rhythmReqId, recCase.caseId, uuidv7(), uuidv7(), rhythmOnlyDr.id)
    fixture.runtime.database.driver.prepare(`
      INSERT INTO examination_request_detail (workspace_id, epoch, request_id, exam_code, indication)
      VALUES (?, ?, ?, 'ecg-12-lead', '胸痛待查')
    `).run(scenario.workspaceId, scenario.epoch, rhythmReqId)
    fixture.runtime.database.driver.prepare(`
      INSERT INTO examination_report_content (
        workspace_id, epoch, diagnostic_report_id, request_id, case_id, content_json, issued_at
      ) VALUES (?, ?, ?, ?, ?, ?, '2026-08-24T09:15:00+08:00')
    `).run(scenario.workspaceId, scenario.epoch, rhythmOnlyDr.id, rhythmReqId, recCase.caseId, JSON.stringify({
      conclusion: '窦性心律，心率 84 次/分。',
      results: [{ code: 'ventricular-rate', display: '心室率', value: '84 次/分' }],
    }))
    // 3-month ('mo') antihypertensive MedicationRequest authored 40 days earlier stays active (not discarded as 3 days)
    const htnMedReq = fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      authoredOn: '2026-07-15T09:00:00+08:00',
      dosageInstruction: [{ timing: { repeat: { boundsDuration: { code: 'mo', system: 'http://unitsofmeasure.org', unit: 'mo', value: 3 } } } }],
      id: uuidv7(),
      intent: 'order',
      medication: { concept: { text: '苯磺酸氨氯地平片 5mg' } },
      reason: [{ concept: { coding: [{ code: 'I10', display: '原发性高血压' }], text: '原发性高血压' } }],
      resourceType: 'MedicationRequest',
      status: 'active',
      subject: { reference: `Patient/${recurrentPatient.id}` },
    })
    const recScores = await fixture.read('doctor', `/api/his/v1/doctor/cases/${recCase.caseId}/clinical-scores`, clinicalScoreBundleSchema)
    expect(recScores.scores.find(s => s.id === 'ascvd-ldl-target')).toMatchObject({
      status: 'complete',
      tierCode: 'ultra-high',
      value: 1.4,
    })
    expect(recScores.scores.find(s => s.id === 'ascvd-ldl-target')?.sourceReferences).toContainEqual(
      expect.objectContaining({ reference: `MedicationRequest/${htnMedReq.id}` }),
    )
    expect(recScores.scores.find(s => s.id === 'timi-ua-nstemi')?.missingInputs).toContain('uaNstemiPresentation')

    const provenances = await fixture.read('doctor', `/fhir/R5/Provenance?target=Observation/${recordedRisk.data.riskAssessment.observationId}`, fhirBundleSchema)
    expect(provenances.entry?.length).toBe(1)

    // Statin-treated patient preserves pretreatment baseline LDL-C >= 4.9 mmol/L for high-risk stratification while evaluating goal attainment on latest treated LDL-C (even without serum creatinine)
    const lipidPatient = createPatientResponseSchema.parse(
      await (
        await fixture.request('registrar', '/api/his/v1/patients', {
          birthDate: '1975-06-15',
          gender: 'female',
          identifier: `OP-LIPID-${randomUUID()}`,
          name: '合成降脂基线分层患者',
        }, randomUUID(), {})
      ).json(),
    ).data.patient
    const lipidReg = registrationResponseSchema.parse(
      await (
        await fixture.request('registrar', '/api/his/v1/registrations/actions/register', {
          departmentId: regCatalog.departments[0]!.id,
          locationId: regCatalog.locations[0]!.id,
          patientId: lipidPatient.id,
          visitDate: regCatalog.virtualDate,
          visitTypeId: regCatalog.visitTypes[0]!.id,
        }, randomUUID(), { [`Patient/${lipidPatient.id}`]: lipidPatient.versionId })
      ).json(),
    ).data
    const lipidTriage = triageResponseSchema.parse(
      await (
        await fixture.request('triage', `/api/his/v1/encounters/${lipidReg.encounterId}/actions/record-triage`, {
          acuityCode: 'level-3',
          bloodPressure: { diastolicMmHg: 78, systolicMmHg: 122 },
          chiefComplaint: '血脂随访复查',
          oxygenSaturationPct: 98,
          pulseBpm: 72,
          respirationBpm: 16,
          temperatureC: 36.5,
        }, randomUUID(), {
          [`Encounter/${lipidReg.encounterId}`]: '1',
          [`Task/${lipidReg.queueTaskId}`]: '1',
        })
      ).json(),
    ).data
    await fixture.request('doctor', `/api/his/v1/encounters/${lipidReg.encounterId}/actions/start-first-visit`, {}, randomUUID(), {
      [`Encounter/${lipidReg.encounterId}`]: lipidTriage.encounterVersion,
      [`Task/${lipidTriage.doctorTaskId}`]: '1',
    })
    const lipidCase = (await fixture.read('doctor', '/api/his/v1/doctor/queue', doctorQueueSchema))
      .items.find(item => item.encounterId === lipidReg.encounterId)!

    const preStatinLab = insertSyntheticLabReport(fixture, {
      caseId: lipidCase.caseId,
      encounterId: lipidReg.encounterId,
      epoch: scenario.epoch,
      issuedAt: '2026-07-01T09:00:00+08:00',
      patientId: lipidPatient.id,
      results: [
        { code: '2000404A', display: '低密度脂蛋白胆固醇', high: 3.4, unit: 'mmol/L', value: 5.2 },
      ],
      workspaceId: scenario.workspaceId,
    })
    const statinMedReq = fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      authoredOn: '2026-07-02T10:00:00+08:00',
      dosageInstruction: [{ timing: { repeat: { boundsDuration: { code: 'mo', system: 'http://unitsofmeasure.org', unit: 'mo', value: 3 } } } }],
      id: uuidv7(),
      intent: 'order',
      medication: { concept: { text: '阿托伐他汀钙片 20mg' } },
      resourceType: 'MedicationRequest',
      status: 'active',
      subject: { reference: `Patient/${lipidPatient.id}` },
    })
    const postStatinLab = insertSyntheticLabReport(fixture, {
      caseId: lipidCase.caseId,
      encounterId: lipidReg.encounterId,
      epoch: scenario.epoch,
      issuedAt: '2026-08-20T09:00:00+08:00',
      patientId: lipidPatient.id,
      results: [
        { code: '2000404A', display: '低密度脂蛋白胆固醇', high: 3.4, unit: 'mmol/L', value: 2.1 },
      ],
      workspaceId: scenario.workspaceId,
    })

    const lipidScores = await fixture.read('doctor', `/api/his/v1/doctor/cases/${lipidCase.caseId}/clinical-scores`, clinicalScoreBundleSchema)
    const lipidAscvd = lipidScores.scores.find(s => s.id === 'ascvd-ldl-target')!
    expect(lipidAscvd).toMatchObject({
      ldlGoalEvaluation: {
        atGoal: true,
        currentLdlMmolL: 2.1,
        targetLdlMmolL: 2.6,
      },
      status: 'complete',
      tierCode: 'high',
      value: 2.6,
    })
    expect(lipidAscvd.sourceReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reference: `Observation/${preStatinLab.obsIds[0]}` }),
        expect.objectContaining({ reference: `Observation/${postStatinLab.obsIds[0]}` }),
        expect.objectContaining({ reference: `MedicationRequest/${statinMedReq.id}` }),
      ]),
    )

    // Completed temporary statin order ends after administration washout (28d) rather than permanently suppressing later untreated lipids;
    // and pretreatment same-specimen TC+HDL pair remains usable even when a newer TC-only pretreatment lab exists
    const tempOrderPatient = createPatientResponseSchema.parse(
      await (
        await fixture.request('registrar', '/api/his/v1/patients', {
          birthDate: '1976-04-10',
          gender: 'female',
          identifier: `OP-TEMP-STATIN-${randomUUID()}`,
          name: '合成临时他汀洗脱期患者',
        }, randomUUID(), {})
      ).json(),
    ).data.patient
    const tempReg = registrationResponseSchema.parse(
      await (
        await fixture.request('registrar', '/api/his/v1/registrations/actions/register', {
          departmentId: regCatalog.departments[0]!.id,
          locationId: regCatalog.locations[0]!.id,
          patientId: tempOrderPatient.id,
          visitDate: regCatalog.virtualDate,
          visitTypeId: regCatalog.visitTypes[0]!.id,
        }, randomUUID(), { [`Patient/${tempOrderPatient.id}`]: tempOrderPatient.versionId })
      ).json(),
    ).data
    const tempTriage = triageResponseSchema.parse(
      await (
        await fixture.request('triage', `/api/his/v1/encounters/${tempReg.encounterId}/actions/record-triage`, {
          acuityCode: 'level-3',
          bloodPressure: { diastolicMmHg: 88, systolicMmHg: 146 },
          chiefComplaint: '既往单次他汀后复查血脂',
          heightCm: 165,
          oxygenSaturationPct: 98,
          pulseBpm: 74,
          respirationBpm: 16,
          temperatureC: 36.5,
          weightKg: 62,
        }, randomUUID(), {
          [`Encounter/${tempReg.encounterId}`]: '1',
          [`Task/${tempReg.queueTaskId}`]: '1',
        })
      ).json(),
    ).data
    await fixture.request('doctor', `/api/his/v1/encounters/${tempReg.encounterId}/actions/start-first-visit`, {}, randomUUID(), {
      [`Encounter/${tempReg.encounterId}`]: tempTriage.encounterVersion,
      [`Task/${tempTriage.doctorTaskId}`]: '1',
    })
    const tempCase = (await fixture.read('doctor', '/api/his/v1/doctor/queue', doctorQueueSchema))
      .items.find(item => item.encounterId === tempReg.encounterId)!

    // Historical completed MedicationRequest with explicit MedicationAdministration completion evidence from 6 months ago (>28d washout) does NOT block current untreated lipid panel
    const completedMedReq = fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      authoredOn: '2026-01-10T10:00:00+08:00',
      id: uuidv7(),
      intent: 'order',
      medication: { concept: { text: '阿托伐他汀钙片 20mg' } },
      resourceType: 'MedicationRequest',
      status: 'completed',
      subject: { reference: `Patient/${tempOrderPatient.id}` },
    })
    fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      id: uuidv7(),
      medication: { concept: { text: '阿托伐他汀钙片 20mg' } },
      occurenceDateTime: '2026-01-25T10:00:00+08:00',
      recorded: '2026-01-25T10:00:00+08:00',
      request: { reference: `MedicationRequest/${completedMedReq.id}` },
      resourceType: 'MedicationAdministration',
      status: 'completed',
      subject: { reference: `Patient/${tempOrderPatient.id}` },
    })
    // Combined clinical-sign flow MedicationRequest (status='active', no FHIR boundsDuration, stored course_days=14 in prescription_item)
    // with split deliveries on 2026-06-15 and 2026-06-28 anchors the 14d course to the FIRST delivery (2026-06-15 + 14d + 28d washout = 2026-07-27 < 2026-08-01 blood draw)
    // instead of restarting the full 14d course at the second delivery (which would falsely suppress the 2026-08-01 pretreatment panel through 2026-08-09)
    const signedShortMedReq = fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      authoredOn: '2026-06-15T10:00:00+08:00',
      dosageInstruction: [{ text: '20mg QD' }],
      id: uuidv7(),
      intent: 'order',
      medication: { concept: { text: '阿托伐他汀钙片 20mg' } },
      resourceType: 'MedicationRequest',
      status: 'active',
      subject: { reference: `Patient/${tempOrderPatient.id}` },
    })
    const signedShortPrescriptionId = uuidv7()
    fixture.runtime.database.driver.prepare(`
      INSERT INTO prescription (
        workspace_id, epoch, prescription_id, case_id, prescription_number, status, version, authored_by, authored_at
      ) VALUES (?, ?, ?, ?, ?, 'dispensed', 1, 'actor-test', '2026-06-15T10:00:00+08:00')
    `).run(scenario.workspaceId, scenario.epoch, signedShortPrescriptionId, tempCase.caseId, `RX-SHORT-${randomUUID().slice(0, 8)}`)
    fixture.runtime.database.driver.prepare(`
      INSERT INTO prescription_item (
        workspace_id, epoch, prescription_id, medication_request_id, medication_id, medication_snapshot_json, quantity, dose_text, frequency_code, route_code, course_days
      ) VALUES (?, ?, ?, ?, 'medication-atorvastatin', '{}', 2, '20mg', 'QD', 'PO', 14)
    `).run(scenario.workspaceId, scenario.epoch, signedShortPrescriptionId, signedShortMedReq.id)
    for (const handedOver of ['2026-06-15T10:30:00+08:00', '2026-06-28T10:30:00+08:00']) {
      fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
        authorizingPrescription: [{ reference: `MedicationRequest/${signedShortMedReq.id}` }],
        id: uuidv7(),
        medication: { concept: { text: '阿托伐他汀钙片 20mg' } },
        resourceType: 'MedicationDispense',
        status: 'completed',
        subject: { reference: `Patient/${tempOrderPatient.id}` },
        whenHandedOver: handedOver,
      })
    }
    // External active MedicationRequest with no request-level boundsDuration but finite MedicationDispense.daysSupply=30d from 2025 expires after 30d + 28d washout instead of staying active forever
    const externalSuppliedReq = fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      authoredOn: '2025-06-01T09:00:00+08:00',
      id: uuidv7(),
      intent: 'order',
      medication: { concept: { text: '匹伐他汀钙片 2mg' } },
      resourceType: 'MedicationRequest',
      status: 'active',
      subject: { reference: `Patient/${tempOrderPatient.id}` },
    })
    fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      authorizingPrescription: [{ reference: `MedicationRequest/${externalSuppliedReq.id}` }],
      daysSupply: { code: 'd', system: 'http://unitsofmeasure.org', unit: 'd', value: 30 },
      id: uuidv7(),
      medication: { concept: { text: '匹伐他汀钙片 2mg' } },
      resourceType: 'MedicationDispense',
      status: 'completed',
      subject: { reference: `Patient/${tempOrderPatient.id}` },
      whenHandedOver: '2025-06-01T09:30:00+08:00',
    })

    // Same-specimen TC=6.5 + HDL=1.1 (non-HDL=5.4 >= 5.2), followed by a newer standalone TC-only=5.3 before active statin
    const pairedPanel = insertSyntheticLabReport(fixture, {
      caseId: tempCase.caseId,
      encounterId: tempReg.encounterId,
      epoch: scenario.epoch,
      issuedAt: '2026-08-01T09:00:00+08:00',
      patientId: tempOrderPatient.id,
      results: [
        { code: '1700404A', display: '血清肌酐', high: 84, unit: 'umol/L', value: 65 },
        { code: '2000104A', display: '总胆固醇', high: 5.2, unit: 'mmol/L', value: 6.5 },
        { code: '2000304A', display: '高密度脂蛋白胆固醇', high: 1.8, unit: 'mmol/L', value: 1.1 },
      ],
      workspaceId: scenario.workspaceId,
    })
    insertSyntheticLabReport(fixture, {
      caseId: tempCase.caseId,
      encounterId: tempReg.encounterId,
      epoch: scenario.epoch,
      issuedAt: '2026-08-05T09:00:00+08:00',
      patientId: tempOrderPatient.id,
      results: [
        { code: '2000104A', display: '总胆固醇', high: 5.2, unit: 'mmol/L', value: 5.3 },
      ],
      workspaceId: scenario.workspaceId,
    })
    await fixture.runtime.app.request(`http://localhost/api/his/v1/encounters/${tempReg.encounterId}/risk-assessment`, {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${tempReg.encounterId}`]: String(Number(tempTriage.encounterVersion) + 1) },
        input: {
          expectedRevision: 0,
          fields: { smokingStatus: 'current' },
        },
      }),
      headers: {
        'content-type': 'application/json',
        cookie: await fixture.login('doctor'),
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'PUT',
    })
    const tempScores = await fixture.read('doctor', `/api/his/v1/doctor/cases/${tempCase.caseId}/clinical-scores`, clinicalScoreBundleSchema)
    const tempAscvd = tempScores.scores.find(s => s.id === 'ascvd-ldl-target')!
    expect(tempAscvd).toMatchObject({
      status: 'complete',
      tierCode: 'high',
      value: 2.6,
    })
    expect(tempAscvd.sourceReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reference: `Observation/${pairedPanel.obsIds[1]}` }),
        expect.objectContaining({ reference: `Observation/${pairedPanel.obsIds[2]}` }),
      ]),
    )

    // Outpatient statin with planned effectiveDosePeriod.start BEFORE blood draw (2026-08-01T08:30) but actual MedicationDispense.whenHandedOver AFTER blood draw (2026-08-06T10:00) anchors exposure start to actual dispense so the 2026-08-01 specimen stays pretreatment baseline
    const preDrawAuthoredStatin = fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      authoredOn: '2026-08-01T08:30:00+08:00',
      dosageInstruction: [{ timing: { repeat: { boundsDuration: { code: 'mo', system: 'http://unitsofmeasure.org', unit: 'mo', value: 3 }, boundsPeriod: { start: '2026-08-01T08:30:00+08:00' } } } }],
      effectiveDosePeriod: { start: '2026-08-01T08:30:00+08:00' },
      id: uuidv7(),
      intent: 'order',
      medication: { concept: { text: '瑞舒伐他汀钙片 10mg' } },
      resourceType: 'MedicationRequest',
      status: 'active',
      subject: { reference: `Patient/${tempOrderPatient.id}` },
    })
    fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      authorizingPrescription: [{ reference: `MedicationRequest/${preDrawAuthoredStatin.id}` }],
      id: uuidv7(),
      medication: { concept: { text: '瑞舒伐他汀钙片 10mg' } },
      resourceType: 'MedicationDispense',
      status: 'completed',
      subject: { reference: `Patient/${tempOrderPatient.id}` },
      whenHandedOver: '2026-08-06T10:00:00+08:00',
    })
    // Second 30d refill on externalSuppliedReq handed over on 2026-08-10 (after its 2025-06-01 30d supply washed out) keeps separate dispense intervals rather than bridging 2025-06..2026-10 across the 2026-08-01 baseline specimen
    fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      authorizingPrescription: [{ reference: `MedicationRequest/${externalSuppliedReq.id}` }],
      daysSupply: { code: 'd', system: 'http://unitsofmeasure.org', unit: 'd', value: 30 },
      id: uuidv7(),
      medication: { concept: { text: '匹伐他汀钙片 2mg' } },
      resourceType: 'MedicationDispense',
      status: 'completed',
      subject: { reference: `Patient/${tempOrderPatient.id}` },
      whenHandedOver: '2026-08-10T10:00:00+08:00',
    })
    insertSyntheticLabReport(fixture, {
      caseId: tempCase.caseId,
      encounterId: tempReg.encounterId,
      epoch: scenario.epoch,
      issuedAt: '2026-08-20T09:00:00+08:00',
      patientId: tempOrderPatient.id,
      results: [
        { code: '2000404A', display: '低密度脂蛋白胆固醇', high: 3.4, unit: 'mmol/L', value: 2.0 },
      ],
      workspaceId: scenario.workspaceId,
    })
    const treatedPairedScores = await fixture.read('doctor', `/api/his/v1/doctor/cases/${tempCase.caseId}/clinical-scores`, clinicalScoreBundleSchema)
    expect(treatedPairedScores.scores.find(s => s.id === 'ascvd-ldl-target')).toMatchObject({
      ldlGoalEvaluation: { atGoal: true, currentLdlMmolL: 2.0, targetLdlMmolL: 2.6 },
      status: 'complete',
      tierCode: 'high',
      value: 2.6,
    })

    // Conversely, a completed MedicationRequest with NO boundsDuration and NO completion evidence keeps end unknown rather than washing out 28d after authoredOn
    const unknownEndPatient = createPatientResponseSchema.parse(
      await (
        await fixture.request('registrar', '/api/his/v1/patients', {
          birthDate: '1976-04-10',
          gender: 'female',
          identifier: `OP-UNKNOWN-END-${randomUUID()}`,
          name: '合成无终止证据他汀患者',
        }, randomUUID(), {})
      ).json(),
    ).data.patient
    const unknownEndReg = registrationResponseSchema.parse(
      await (
        await fixture.request('registrar', '/api/his/v1/registrations/actions/register', {
          departmentId: regCatalog.departments[0]!.id,
          locationId: regCatalog.locations[0]!.id,
          patientId: unknownEndPatient.id,
          visitDate: regCatalog.virtualDate,
          visitTypeId: regCatalog.visitTypes[0]!.id,
        }, randomUUID(), { [`Patient/${unknownEndPatient.id}`]: unknownEndPatient.versionId })
      ).json(),
    ).data
    const unknownEndTriage = triageResponseSchema.parse(
      await (
        await fixture.request('triage', `/api/his/v1/encounters/${unknownEndReg.encounterId}/actions/record-triage`, {
          acuityCode: 'level-3',
          bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 },
          chiefComplaint: '既往他汀疗程不明随访',
          oxygenSaturationPct: 98,
          pulseBpm: 70,
          respirationBpm: 16,
          temperatureC: 36.5,
        }, randomUUID(), {
          [`Encounter/${unknownEndReg.encounterId}`]: '1',
          [`Task/${unknownEndReg.queueTaskId}`]: '1',
        })
      ).json(),
    ).data
    await fixture.request('doctor', `/api/his/v1/encounters/${unknownEndReg.encounterId}/actions/start-first-visit`, {}, randomUUID(), {
      [`Encounter/${unknownEndReg.encounterId}`]: unknownEndTriage.encounterVersion,
      [`Task/${unknownEndTriage.doctorTaskId}`]: '1',
    })
    const unknownEndCase = (await fixture.read('doctor', '/api/his/v1/doctor/queue', doctorQueueSchema))
      .items.find(item => item.encounterId === unknownEndReg.encounterId)!
    fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      authoredOn: '2026-01-01T09:00:00+08:00',
      id: uuidv7(),
      intent: 'order',
      medication: { concept: { text: '阿托伐他汀钙片 20mg' } },
      resourceType: 'MedicationRequest',
      status: 'completed',
      subject: { reference: `Patient/${unknownEndPatient.id}` },
    })
    // Lipid panel drawn on March 15 (during a 90-day course whose end was unrecorded): must NOT be treated as untreated baseline
    insertSyntheticLabReport(fixture, {
      caseId: unknownEndCase.caseId,
      encounterId: unknownEndReg.encounterId,
      epoch: scenario.epoch,
      issuedAt: '2026-03-15T09:00:00+08:00',
      patientId: unknownEndPatient.id,
      results: [
        { code: '1700404A', display: '血清肌酐', high: 84, unit: 'umol/L', value: 62 },
        { code: '2000104A', display: '总胆固醇', high: 5.2, unit: 'mmol/L', value: 3.9 },
        { code: '2000304A', display: '高密度脂蛋白胆固醇', high: 1.8, unit: 'mmol/L', value: 1.3 },
        { code: '2000404A', display: '低密度脂蛋白胆固醇', high: 3.4, unit: 'mmol/L', value: 2.1 },
      ],
      workspaceId: scenario.workspaceId,
    })
    await fixture.runtime.app.request(`http://localhost/api/his/v1/encounters/${unknownEndReg.encounterId}/risk-assessment`, {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${unknownEndReg.encounterId}`]: String(Number(unknownEndTriage.encounterVersion) + 1) },
        input: {
          expectedRevision: 0,
          fields: { smokingStatus: 'never' },
        },
      }),
      headers: {
        'content-type': 'application/json',
        cookie: await fixture.login('doctor'),
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'PUT',
    })
    const unknownEndScores = await fixture.read('doctor', `/api/his/v1/doctor/cases/${unknownEndCase.caseId}/clinical-scores`, clinicalScoreBundleSchema)
    expect(unknownEndScores.scores.find(s => s.id === 'ascvd-ldl-target')).toMatchObject({
      missingInputs: expect.arrayContaining(['ldlCholesterol']),
      status: 'incomplete',
    })

    // Signing an inpatient statin order BEFORE its first dose is administered must NOT mark subsequent pre-dose baseline LDL-C >= 4.9 as treated
    const preDoseStay = await fixture.admitSyntheticCase(['I10.x09'], 'bed-general-2')
    const preDoseOrderId = uuidv7()
    fixture.runtime.database.driver.prepare(`
      INSERT INTO inpatient_order (
        workspace_id, epoch, order_id, admission_id, kind, duration, catalog_item_id, catalog_version,
        display, dose_text, dose_quantity, unit, frequency_code, route_code, price_fen, state, organization_id, signed_at, signed_by
      ) VALUES (?, ?, ?, ?, 'medication', 'long', 'medication-pci-atorvastatin', 1, '阿托伐他汀钙片', '20 mg', 1, '片', 'QN', 'PO', 70, 'signed', 'hospital-synthetic-renhe', '2026-08-24T09:00:00+08:00', 'actor-test')
    `).run(scenario.workspaceId, scenario.epoch, preDoseOrderId, preDoseStay.admissionId)
    fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      authoredOn: '2026-08-24T09:00:00+08:00',
      encounter: { reference: `Encounter/${preDoseStay.admissionId}` },
      id: preDoseOrderId,
      intent: 'order',
      medication: { concept: { text: '阿托伐他汀钙片' }, reference: { display: '阿托伐他汀钙片', reference: 'Medication/medication-pci-atorvastatin' } },
      resourceType: 'MedicationRequest',
      status: 'active',
      subject: { reference: `Patient/${preDoseStay.patientId}` },
    })
    // Baseline lipid panel collected at 09:30 (after order signature at 09:00, BEFORE first evening QN administration at 22:00)
    insertSyntheticLabReport(fixture, {
      caseId: preDoseStay.admissionId,
      encounterId: preDoseStay.admissionId,
      epoch: scenario.epoch,
      issuedAt: '2026-08-24T09:30:00+08:00',
      patientId: preDoseStay.patientId,
      results: [
        { code: '2000404A', display: '低密度脂蛋白胆固醇', high: 3.4, unit: 'mmol/L', value: 5.1 },
      ],
      workspaceId: scenario.workspaceId,
    })
    // First dose administered at 22:00, followed by treated LDL-C = 2.2 mmol/L two weeks later
    const firstAdmin = fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      encounter: { reference: `Encounter/${preDoseStay.admissionId}` },
      id: uuidv7(),
      medication: { reference: { reference: 'Medication/medication-pci-atorvastatin' } },
      occurenceDateTime: '2026-08-24T22:00:00+08:00',
      recorded: '2026-08-24T22:00:00+08:00',
      request: { reference: `MedicationRequest/${preDoseOrderId}` },
      resourceType: 'MedicationAdministration',
      status: 'completed',
      subject: { reference: `Patient/${preDoseStay.patientId}` },
    })
    fixture.runtime.database.driver.prepare(`
      INSERT INTO inpatient_execution (
        workspace_id, epoch, execution_id, order_id, scheduled_for, status, version, administration_id
      ) VALUES (?, ?, ?, ?, '2026-08-24T22:00:00+08:00', 'completed', 2, ?)
    `).run(scenario.workspaceId, scenario.epoch, uuidv7(), preDoseOrderId, firstAdmin.id)
    insertSyntheticLabReport(fixture, {
      caseId: preDoseStay.admissionId,
      encounterId: preDoseStay.admissionId,
      epoch: scenario.epoch,
      issuedAt: '2026-09-07T08:00:00+08:00',
      patientId: preDoseStay.patientId,
      results: [
        { code: '2000404A', display: '低密度脂蛋白胆固醇', high: 3.4, unit: 'mmol/L', value: 2.2 },
      ],
      workspaceId: scenario.workspaceId,
    })
    const preDoseScores = await fixture.read('inpatient-doctor', `${preDoseStay.path}/clinical-scores`, clinicalScoreBundleSchema)
    expect(preDoseScores.scores.find(s => s.id === 'ascvd-ldl-target')).toMatchObject({
      ldlGoalEvaluation: { atGoal: true, currentLdlMmolL: 2.2, targetLdlMmolL: 2.6 },
      status: 'complete',
      tierCode: 'high',
      value: 2.6,
    })

    // Out-of-order overdue execution administration (08:00 scheduled administered at 22:00 after 20:00 scheduled administered at 21:00)
    // selects 21:00 as actual earliest dose so a 21:30 lipid specimen is NOT misclassified as pre-exposure baseline
    const outOfOrderStay = await fixture.admitSyntheticCase(['I10.x09'], 'bed-general-1')
    const outOfOrderId = uuidv7()
    fixture.runtime.database.driver.prepare(`
      INSERT INTO inpatient_order (
        workspace_id, epoch, order_id, admission_id, kind, duration, catalog_item_id, catalog_version,
        display, dose_text, dose_quantity, unit, frequency_code, route_code, price_fen, state, organization_id, signed_at, signed_by
      ) VALUES (?, ?, ?, ?, 'medication', 'long', 'medication-pci-atorvastatin', 1, '阿托伐他汀钙片', '20 mg', 1, '片', 'BID', 'PO', 70, 'verified', 'hospital-synthetic-renhe', '2026-08-24T07:30:00+08:00', 'actor-test')
    `).run(scenario.workspaceId, scenario.epoch, outOfOrderId, outOfOrderStay.admissionId)
    fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      authoredOn: '2026-08-24T07:30:00+08:00',
      encounter: { reference: `Encounter/${outOfOrderStay.admissionId}` },
      id: outOfOrderId,
      intent: 'order',
      medication: { concept: { text: '阿托伐他汀钙片' } },
      resourceType: 'MedicationRequest',
      status: 'active',
      subject: { reference: `Patient/${outOfOrderStay.patientId}` },
    })
    const lateMorningAdmin = fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      encounter: { reference: `Encounter/${outOfOrderStay.admissionId}` },
      id: uuidv7(),
      medication: { reference: { reference: 'Medication/medication-pci-atorvastatin' } },
      occurenceDateTime: '2026-08-24T22:00:00+08:00',
      recorded: '2026-08-24T22:00:00+08:00',
      request: { reference: `MedicationRequest/${outOfOrderId}` },
      resourceType: 'MedicationAdministration',
      status: 'completed',
      subject: { reference: `Patient/${outOfOrderStay.patientId}` },
    })
    const earlierEveningAdmin = fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      encounter: { reference: `Encounter/${outOfOrderStay.admissionId}` },
      id: uuidv7(),
      medication: { reference: { reference: 'Medication/medication-pci-atorvastatin' } },
      occurenceDateTime: '2026-08-24T21:00:00+08:00',
      recorded: '2026-08-24T21:00:00+08:00',
      request: { reference: `MedicationRequest/${outOfOrderId}` },
      resourceType: 'MedicationAdministration',
      status: 'completed',
      subject: { reference: `Patient/${outOfOrderStay.patientId}` },
    })
    fixture.runtime.database.driver.prepare(`
      INSERT INTO inpatient_execution (workspace_id, epoch, execution_id, order_id, scheduled_for, status, version, administration_id)
      VALUES (?, ?, ?, ?, '2026-08-24T08:00:00+08:00', 'completed', 2, ?),
             (?, ?, ?, ?, '2026-08-24T20:00:00+08:00', 'completed', 2, ?)
    `).run(
      scenario.workspaceId, scenario.epoch, uuidv7(), outOfOrderId, lateMorningAdmin.id,
      scenario.workspaceId, scenario.epoch, uuidv7(), outOfOrderId, earlierEveningAdmin.id,
    )
    // Specimen at 21:30 is AFTER the 21:00 dose -> treated (no untreated baseline -> incomplete rather than low-risk)
    insertSyntheticLabReport(fixture, {
      caseId: outOfOrderStay.admissionId,
      encounterId: outOfOrderStay.admissionId,
      epoch: scenario.epoch,
      issuedAt: '2026-08-24T21:30:00+08:00',
      patientId: outOfOrderStay.patientId,
      results: [
        { code: '1700404A', display: '血清肌酐', high: 84, unit: 'umol/L', value: 65 },
        { code: '2000104A', display: '总胆固醇', high: 5.2, unit: 'mmol/L', value: 3.8 },
        { code: '2000304A', display: '高密度脂蛋白胆固醇', high: 1.8, unit: 'mmol/L', value: 1.3 },
        { code: '2000404A', display: '低密度脂蛋白胆固醇', high: 3.4, unit: 'mmol/L', value: 2.0 },
      ],
      workspaceId: scenario.workspaceId,
    })
    const outOfOrderScores = await fixture.read('inpatient-doctor', `${outOfOrderStay.path}/clinical-scores`, clinicalScoreBundleSchema)
    expect(outOfOrderScores.scores.find(s => s.id === 'ascvd-ldl-target')).toMatchObject({
      missingInputs: expect.arrayContaining(['ldlCholesterol']),
      status: 'incomplete',
    })

    // Inconclusive rhythm-only presentation ECG at 2026-08-24T09:15 on recCase is NOT overridden by a later serial ECG at 12:00 showing ST depression
    const laterSerialEcgDr = fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      code: { text: '复查 12 导联心电图' },
      conclusion: 'V2-V4 导联 ST 段压低 0.15 mV。',
      encounter: { reference: `Encounter/${recReg.encounterId}` },
      id: uuidv7(),
      issued: '2026-08-24T12:00:00+08:00',
      resourceType: 'DiagnosticReport',
      status: 'final',
      subject: { reference: `Patient/${recurrentPatient.id}` },
    })
    const laterSerialEcgReqId = uuidv7()
    fixture.runtime.database.driver.prepare(`
      INSERT INTO laboratory_request (
        workspace_id, epoch, request_id, case_id, request_kind, catalog_item_id,
        indication_code, service_snapshot_json, service_request_id, execution_task_id,
        diagnostic_report_id, status, version, authored_by, authored_at, reported_at
      ) VALUES (?, ?, ?, ?, 'examination', 'examination-ecg-12-lead', 'clinical-evaluation', '{}', ?, ?, ?, 'reported', 1, 'actor-test', '2026-08-24T11:55:00+08:00', '2026-08-24T12:00:00+08:00')
    `).run(scenario.workspaceId, scenario.epoch, laterSerialEcgReqId, recCase.caseId, uuidv7(), uuidv7(), laterSerialEcgDr.id)
    fixture.runtime.database.driver.prepare(`
      INSERT INTO examination_request_detail (workspace_id, epoch, request_id, exam_code, indication)
      VALUES (?, ?, ?, 'ecg-12-lead', '动态复查')
    `).run(scenario.workspaceId, scenario.epoch, laterSerialEcgReqId)
    fixture.runtime.database.driver.prepare(`
      INSERT INTO examination_report_content (
        workspace_id, epoch, diagnostic_report_id, request_id, case_id, content_json, issued_at
      ) VALUES (?, ?, ?, ?, ?, ?, '2026-08-24T12:00:00+08:00')
    `).run(scenario.workspaceId, scenario.epoch, laterSerialEcgDr.id, laterSerialEcgReqId, recCase.caseId, JSON.stringify({
      conclusion: 'V2-V4 导联 ST 段压低 0.15 mV。',
      results: [{ code: 'st-t-anterior', display: '前壁导联', value: 'V2-V4 ST 段压低 0.15 mV' }],
    }))
    const recAfterLaterEcg = await fixture.read('doctor', `/api/his/v1/doctor/cases/${recCase.caseId}/clinical-scores`, clinicalScoreBundleSchema)
    expect(recAfterLaterEcg.riskAssessment.effectiveStSegmentDeviation).toBeNull()

    // Stopped inpatient statin order whose final administered dose was Jan 1 (formally stopped Feb 1) finishes 28d washout on Jan 29 so Jan 31 LDL-C is untreated
    fixture.runtime.database.driver.prepare(`
      UPDATE inpatient_order SET state = 'stopped', stopped_at = '2026-02-01T10:00:00+08:00' WHERE order_id = ?
    `).run(outOfOrderId)
    fixture.runtime.database.driver.prepare(`DELETE FROM inpatient_execution WHERE order_id = ?`).run(outOfOrderId)
    const jan1Admin = fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      encounter: { reference: `Encounter/${outOfOrderStay.admissionId}` },
      id: uuidv7(),
      medication: { reference: { reference: 'Medication/medication-pci-atorvastatin' } },
      occurenceDateTime: '2026-01-01T10:00:00+08:00',
      recorded: '2026-01-01T10:00:00+08:00',
      request: { reference: `MedicationRequest/${outOfOrderId}` },
      resourceType: 'MedicationAdministration',
      status: 'completed',
      subject: { reference: `Patient/${outOfOrderStay.patientId}` },
    })
    fixture.runtime.database.driver.prepare(`
      INSERT INTO inpatient_execution (workspace_id, epoch, execution_id, order_id, scheduled_for, status, version, administration_id)
      VALUES (?, ?, ?, ?, '2026-01-01T10:00:00+08:00', 'completed', 2, ?)
    `).run(scenario.workspaceId, scenario.epoch, uuidv7(), outOfOrderId, jan1Admin.id)
    insertSyntheticLabReport(fixture, {
      caseId: outOfOrderStay.admissionId,
      encounterId: outOfOrderStay.admissionId,
      epoch: scenario.epoch,
      issuedAt: '2026-01-31T09:00:00+08:00',
      patientId: outOfOrderStay.patientId,
      results: [
        { code: '2000404A', display: '低密度脂蛋白胆固醇', high: 3.4, unit: 'mmol/L', value: 5.0 },
      ],
      workspaceId: scenario.workspaceId,
    })
    fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      authoredOn: '2026-08-10T09:00:00+08:00',
      dosageInstruction: [{ timing: { repeat: { boundsDuration: { code: 'mo', system: 'http://unitsofmeasure.org', unit: 'mo', value: 3 } } } }],
      id: uuidv7(),
      intent: 'order',
      medication: { concept: { text: '瑞舒伐他汀钙片 10mg' } },
      resourceType: 'MedicationRequest',
      status: 'active',
      subject: { reference: `Patient/${outOfOrderStay.patientId}` },
    })
    const afterFinalDoseWashout = await fixture.read('inpatient-doctor', `${outOfOrderStay.path}/clinical-scores`, clinicalScoreBundleSchema)
    expect(afterFinalDoseWashout.scores.find(s => s.id === 'ascvd-ldl-target')).toMatchObject({
      ldlGoalEvaluation: { atGoal: true, currentLdlMmolL: 2.0, targetLdlMmolL: 2.6 },
      status: 'complete',
      tierCode: 'high',
      value: 2.6,
    })

    // Actual nursing vitals (with weightKg=70) & first creatinine recorded on hospital day 3 (2026-08-27, >24h after 2026-08-24 admission):
    // current eGFR & CrCl succeed, while GRACE & PRECISE-DAPT reject delayed vitals/weight/creatinine WITHOUT falling back to current values!
    fixture.runtime.database.driver.prepare(`
      DELETE FROM laboratory_request WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).run(scenario.workspaceId, scenario.epoch, outOfOrderStay.admissionId)
    const outOfOrderClinical = await fixture.read('ward-nurse', `${outOfOrderStay.path}/clinical`, inpatientFullClinicalSchema)
    const day3VitalsRes = await fixture.request('ward-nurse', `${outOfOrderStay.path}/vital-signs`, {
      bloodPressure: { diastolicMmHg: 76, systolicMmHg: 128 },
      encounterVersion: outOfOrderClinical.encounterVersion,
      expectedRevision: 0,
      heightCm: 170,
      oxygenSaturationPct: 98,
      pulseBpm: 82,
      respirationBpm: 18,
      temperatureC: 36.6,
      weightKg: 70,
    }, randomUUID())
    expect(day3VitalsRes.status).toBe(200)
    fixture.runtime.database.driver.prepare(`
      UPDATE inpatient_vital_signs SET recorded_at = '2026-08-27T09:00:00+08:00'
      WHERE workspace_id = ? AND epoch = ? AND admission_id = ?
    `).run(scenario.workspaceId, scenario.epoch, outOfOrderStay.admissionId)
    insertSyntheticLabReport(fixture, {
      caseId: outOfOrderStay.admissionId,
      encounterId: outOfOrderStay.admissionId,
      epoch: scenario.epoch,
      issuedAt: '2026-08-27T09:30:00+08:00',
      patientId: outOfOrderStay.patientId,
      results: [
        { code: '1700404A', display: '血清肌酐', high: 84, unit: 'umol/L', value: 88.4 },
        { code: '0100101A', display: '白细胞计数', unit: '10*9/L', value: 7.5 },
        { code: '0100401A', display: '血红蛋白', unit: 'g/L', value: 138 },
      ],
      workspaceId: scenario.workspaceId,
    })
    // Troponin obtained within 24h of admission (2026-08-24T11:30) but AFTER inpatient treatment/execution is excluded from presentation GRACE/TIMI scoring
    insertSyntheticLabReport(fixture, {
      caseId: outOfOrderStay.admissionId,
      encounterId: outOfOrderStay.admissionId,
      epoch: scenario.epoch,
      issuedAt: '2026-08-24T11:30:00+08:00',
      patientId: outOfOrderStay.patientId,
      results: [
        { code: '2100404B', display: '高敏心肌肌钙蛋白I', high: 0.04, interpretationCode: 'H', unit: 'ng/mL', value: 1.25 },
      ],
      workspaceId: scenario.workspaceId,
    })
    fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
      code: { coding: [{ code: 'I21.4', display: '急性心内膜下心肌梗死' }], text: '急性心内膜下心肌梗死' },
      encounter: { reference: `Encounter/${outOfOrderStay.admissionId}` },
      id: uuidv7(),
      recordedDate: '2026-08-24T09:00:00+08:00',
      resourceType: 'Condition',
      subject: { reference: `Patient/${outOfOrderStay.patientId}` },
      verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
    })
    fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
      code: { coding: [{ code: 'Z95.5', display: '冠状动脉支架置入术后状态' }], text: '冠状动脉支架置入术后状态' },
      id: uuidv7(),
      recordedDate: '2026-08-01T09:00:00+08:00',
      resourceType: 'Condition',
      subject: { reference: `Patient/${outOfOrderStay.patientId}` },
      verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
    })
    const daptReqIds: string[] = []
    for (const medText of ['阿司匹林肠溶片 100mg', '替格瑞洛片 90mg']) {
      const daptReq = fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
        authoredOn: '2026-08-10T09:00:00+08:00',
        dosageInstruction: [{ timing: { repeat: { boundsDuration: { code: 'mo', system: 'http://unitsofmeasure.org', unit: 'mo', value: 6 } } } }],
        id: uuidv7(),
        intent: 'order',
        medication: { concept: { text: medText } },
        resourceType: 'MedicationRequest',
        status: 'active',
        subject: { reference: `Patient/${outOfOrderStay.patientId}` },
      })
      daptReqIds.push(daptReq.id)
    }
    // Signed/active outpatient DAPT requests without pharmacy dispense handover do NOT make PRECISE-DAPT applicable
    const undispensedDaptScores = await fixture.read('inpatient-doctor', `${outOfOrderStay.path}/clinical-scores`, clinicalScoreBundleSchema)
    expect(undispensedDaptScores.scores.find(s => s.id === 'precise-dapt')?.missingInputs).toContain('pciDaptIndication')

    // Partial dispense of aspirin alone still requires P2Y12 handover before PRECISE-DAPT becomes applicable
    fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      authorizingPrescription: [{ reference: `MedicationRequest/${daptReqIds[0]!}` }],
      id: uuidv7(),
      resourceType: 'MedicationDispense',
      status: 'completed',
      subject: { reference: `Patient/${outOfOrderStay.patientId}` },
      whenHandedOver: '2026-08-10T09:30:00+08:00',
      whenPrepared: '2026-08-10T09:20:00+08:00',
    })
    const partialDaptScores = await fixture.read('inpatient-doctor', `${outOfOrderStay.path}/clinical-scores`, clinicalScoreBundleSchema)
    expect(partialDaptScores.scores.find(s => s.id === 'precise-dapt')?.missingInputs).toContain('pciDaptIndication')

    // Once P2Y12 is also dispensed, ongoing DAPT applicability is satisfied while post-24h baseline labs remain gated out
    fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      authorizingPrescription: [{ reference: `MedicationRequest/${daptReqIds[1]!}` }],
      id: uuidv7(),
      resourceType: 'MedicationDispense',
      status: 'completed',
      subject: { reference: `Patient/${outOfOrderStay.patientId}` },
      whenHandedOver: '2026-08-10T09:30:00+08:00',
      whenPrepared: '2026-08-10T09:20:00+08:00',
    })
    const lateFirstVitalsScores = await fixture.read('inpatient-doctor', `${outOfOrderStay.path}/clinical-scores`, clinicalScoreBundleSchema)
    expect(lateFirstVitalsScores.vitalSigns).not.toBeNull()
    expect(lateFirstVitalsScores.scores.find(s => s.id === 'ckd-epi-2021-egfr')?.status).toBe('complete')
    expect(lateFirstVitalsScores.scores.find(s => s.id === 'cockcroft-gault-crcl')?.status).toBe('complete')
    expect(lateFirstVitalsScores.scores.find(s => s.id === 'grace-acs')).toMatchObject({
      missingInputs: expect.arrayContaining(['heartRateBpm', 'systolicBpMmHg', 'serumCreatinine', 'elevatedCardiacBiomarker']),
      status: 'incomplete',
    })
    expect(lateFirstVitalsScores.scores.find(s => s.id === 'timi-ua-nstemi')).toMatchObject({
      missingInputs: expect.arrayContaining(['elevatedCardiacBiomarker']),
      status: 'incomplete',
    })
    const preciseAfterDispense = lateFirstVitalsScores.scores.find(s => s.id === 'precise-dapt')!
    expect(preciseAfterDispense.missingInputs).not.toContain('pciDaptIndication')
    expect(preciseAfterDispense).toMatchObject({
      missingInputs: expect.arrayContaining(['weightKg', 'serumCreatinine', 'wbc', 'hemoglobin']),
      status: 'incomplete',
    })

    // Non-responsible outpatient doctor cannot read another doctor's outpatient clinical scores (returns 403)
    const prevResp = fixture.runtime.database.driver.prepare(`
      SELECT practitioner_role_id FROM outpatient_case_responsibility
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).get(scenario.workspaceId, scenario.epoch, lipidCase.caseId) as { practitioner_role_id: string }
    fixture.runtime.database.driver.prepare(`
      UPDATE outpatient_case_responsibility SET practitioner_role_id = 'practitioner-role-administrator'
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).run(scenario.workspaceId, scenario.epoch, lipidCase.caseId)
    const crossDoctorRead = await fixture.request('doctor', `/api/his/v1/doctor/cases/${lipidCase.caseId}/clinical-scores`)
    expect(crossDoctorRead.status).toBe(403)
    fixture.runtime.database.driver.prepare(`
      UPDATE outpatient_case_responsibility SET practitioner_role_id = ?
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).run(prevResp.practitioner_role_id, scenario.workspaceId, scenario.epoch, lipidCase.caseId)

    // Completed outpatient encounter evaluates longitudinal Conditions at its actualPeriod.end cutoff rather than leaking future visit diagnoses
    const currentLipidEnc = fixture.runtime.fhir.read({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, 'Encounter', lipidReg.encounterId)
    fixture.runtime.fhir.update(
      { epoch: scenario.epoch, workspaceId: scenario.workspaceId },
      {
        ...currentLipidEnc,
        actualPeriod: { end: '2026-08-24T13:00:00+08:00', start: '2026-08-24T09:00:00+08:00' },
        status: 'completed',
      },
      currentLipidEnc.meta?.versionId ?? '1',
    )
    fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
      code: { coding: [{ code: 'I21.0', display: '急性前壁心肌梗死' }], text: '急性前壁心肌梗死' },
      id: uuidv7(),
      recordedDate: '2026-09-15T10:00:00+08:00',
      resourceType: 'Condition',
      subject: { reference: `Patient/${lipidPatient.id}` },
      verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
    })
    const archivedLipidScores = await fixture.read('doctor', `/api/his/v1/doctor/cases/${lipidCase.caseId}/clinical-scores`, clinicalScoreBundleSchema)
    expect(archivedLipidScores.scores.find(s => s.id === 'ascvd-ldl-target')).toMatchObject({
      ldlGoalEvaluation: { atGoal: true, currentLdlMmolL: 2.1, targetLdlMmolL: 2.6 },
      status: 'complete',
      tierCode: 'high',
      value: 2.6,
    })

    // On a completed encounter (cutoff 2026-08-24T13:00), same-encounter DAPT prescriptions handed over only AFTER the encounter ended (14:30) do NOT retrospectively activate PRECISE-DAPT
    fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
      clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
      code: { coding: [{ code: 'Z95.5', display: '冠状动脉支架置入术后状态' }], text: '冠状动脉支架置入术后状态' },
      id: uuidv7(),
      onsetDateTime: '2025-05-01T09:00:00+08:00',
      recordedDate: '2026-08-01T09:00:00+08:00',
      resourceType: 'Condition',
      subject: { reference: `Patient/${lipidPatient.id}` },
      verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
    })
    for (const medText of ['阿司匹林肠溶片 100mg', '替格瑞洛片 90mg']) {
      const postCutoffReq = fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
        authoredOn: '2026-08-24T12:50:00+08:00',
        dosageInstruction: [{ timing: { repeat: { boundsDuration: { code: 'mo', system: 'http://unitsofmeasure.org', unit: 'mo', value: 6 } } } }],
        encounter: { reference: `Encounter/${lipidReg.encounterId}` },
        id: uuidv7(),
        intent: 'order',
        medication: { concept: { text: medText } },
        resourceType: 'MedicationRequest',
        status: 'active',
        subject: { reference: `Patient/${lipidPatient.id}` },
      })
      fixture.runtime.fhir.create({ epoch: scenario.epoch, workspaceId: scenario.workspaceId }, {
        authorizingPrescription: [{ reference: `MedicationRequest/${postCutoffReq.id}` }],
        encounter: { reference: `Encounter/${lipidReg.encounterId}` },
        id: uuidv7(),
        resourceType: 'MedicationDispense',
        status: 'completed',
        subject: { reference: `Patient/${lipidPatient.id}` },
        whenHandedOver: '2026-08-24T14:30:00+08:00',
        whenPrepared: '2026-08-24T14:20:00+08:00',
      })
    }
    const archivedPostHandoverScores = await fixture.read('doctor', `/api/his/v1/doctor/cases/${lipidCase.caseId}/clinical-scores`, clinicalScoreBundleSchema)
    expect(archivedPostHandoverScores.scores.find(s => s.id === 'precise-dapt')?.missingInputs).toContain('pciDaptIndication')
  }, 120_000)
})
