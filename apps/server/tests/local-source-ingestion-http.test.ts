import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { agentCapabilityGrantSchema, agentClientSchema } from '@clinmesh/contracts/agent'
import { clinicalFactLedgerSchema } from '@clinmesh/contracts/clinical-fact-ledger'
import { clinicalScoreBundleSchema } from '@clinmesh/contracts/clinical-scores'
import {
  apiErrorSchema,
  commandResponseSchema,
  createPatientResponseSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  registrationCatalogSchema,
  registrationResponseSchema,
  scenarioStateSchema,
  startVisitResponseSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { inpatientPciDataResponseSchema, pciCaseSourceResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import {
  confirmIdentityQuarantineMergeResponseSchema,
  ingestLocalSourceBatchResponseSchema,
  listIdentityQuarantineResponseSchema,
  PRIMARY_LOCAL_SOURCE_SYSTEM_ID,
  SIM_LIS_V2_SOURCE_SYSTEM_ID,
} from '@clinmesh/contracts/local-source-ingestion'
import { startSyntheticCaseResultSchema } from '@clinmesh/contracts/scenario'
import { compareSourceSystemLedgers } from '@clinmesh/core/local-source-ingestion'
import {
  createPciPaymentDrgFixture,
  parsePciResponse,
  preparePciPaymentDrgFixture,
  type PciPaymentDrgFixture,
} from './fixtures/pci-payment-drg.ts'

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
  options: { key?: string; includeOrigin?: boolean } = {},
) {
  return fixture.runtime.app.request(path, {
    method: 'POST',
    headers: {
      cookie: await fixture.login(role),
      ...(options.includeOrigin === false ? {} : { origin: 'http://localhost' }),
      'content-type': 'application/json',
      'idempotency-key': options.key ?? randomUUID(),
    },
    body: JSON.stringify(body),
  })
}

async function startDoctorVisit(
  fixture: PciPaymentDrgFixture,
  encounterId: string,
  queueTaskId: string,
  chiefComplaint: string,
) {
  const triaged = await parsePciResponse(
    triageResponseSchema,
    await fixture.request('triage', `/api/his/v1/encounters/${encounterId}/actions/record-triage`, {
      acuityCode: 'level-2',
      bloodPressure: { diastolicMmHg: 82, systolicMmHg: 136 },
      chiefComplaint,
      heightCm: 170,
      oxygenSaturationPct: 98,
      pulseBpm: 80,
      respirationBpm: 18,
      temperatureC: 36.6,
      weightKg: 70,
    }, randomUUID(), {
      [`Encounter/${encounterId}`]: '1',
      [`Task/${queueTaskId}`]: '1',
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
  const item = queue.items.find(row => row.encounterId === encounterId)!
  const detail = await fixture.read('doctor', `/api/his/v1/doctor/cases/${item.caseId}`, doctorCaseDetailSchema)
  return {
    caseId: item.caseId,
    encounterId,
    detail,
  }
}

async function registerAndStartVisit(
  fixture: PciPaymentDrgFixture,
  regCatalog: z.infer<typeof registrationCatalogSchema>,
  patientInput: {
    name: string
    birthDate: string
    gender: 'male' | 'female'
    nationalId: string
  },
) {
  const createdPatient = await parsePciResponse(
    createPatientResponseSchema,
    await fixture.request(
      'registrar',
      '/api/his/v1/patients',
      {
        birthDate: patientInput.birthDate,
        gender: patientInput.gender,
        identifier: patientInput.nationalId,
        name: patientInput.name,
      },
      randomUUID(),
      {},
    ),
  )
  const registration = await parsePciResponse(
    registrationResponseSchema,
    await fixture.request(
      'registrar',
      '/api/his/v1/registrations/actions/register',
      {
        departmentId: regCatalog.departments[0]!.id,
        locationId: regCatalog.locations[0]!.id,
        patientId: createdPatient.data.patient.id,
        visitDate: regCatalog.virtualDate,
        visitTypeId: regCatalog.visitTypes[0]!.id,
      },
      randomUUID(),
      { [`Patient/${createdPatient.data.patient.id}`]: '1' },
    ),
  )
  const visit = await startDoctorVisit(
    fixture,
    registration.data.encounterId,
    registration.data.queueTaskId,
    '胸闷复诊检验比对',
  )
  return {
    patientId: createdPatient.data.patient.id,
    ...visit,
  }
}

describe('Intra-Hospital Second Source System, Patient Quarantine & Batch Completeness (S3 #556)', () => {
  it('enforces AC37 source agnosticism across primary HIS and clinmesh-sim-lis-v2, AC38 quarantine/homonym safety, AC39 batch completeness, and AC15 truth isolation', async () => {
    const prepared = await preparePciPaymentDrgFixture()
    const fixture = await createPciPaymentDrgFixture(prepared)
    fixtures.push(fixture)

    const scenario = await fixture.read('admin', '/api/sim/v1/scenario-runs/current', scenarioStateSchema)
    await parsePciResponse(
      inpatientPciDataResponseSchema,
      await fixture.request('admin', '/api/his/v1/inpatient/pci-data/prepare', { expectedEpoch: scenario.epoch }),
    )
    const pciSource = (await parsePciResponse(
      pciCaseSourceResponseSchema,
      await fixture.request('admin', '/api/sim/v1/synthetic-cases/pci/prepare', { expectedEpoch: scenario.epoch }),
    )).data
    const regCatalog = await fixture.read('registrar', '/api/his/v1/catalogs/registration', registrationCatalogSchema)

    // Materialize Patient A (from fixed PCI case) + inject Case Truth sentinel for AC15
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
    const caseTruthSentinel = 'CASE_TRUTH_S3_SECRET_DO_NOT_EXPOSED_20261124'
    fixture.runtime.database.driver.prepare(`
      UPDATE synthetic_case_truth
      SET hidden_resources_json = ?
      WHERE workspace_id = ? AND case_id = ?
    `).run(JSON.stringify([{ secretNote: caseTruthSentinel }]), scenario.workspaceId, pciSource.case.caseId)

    const visitA = await startDoctorVisit(fixture, startedOut.encounterId, startedOut.queueTaskId, '急性胸痛评估')
    const patientAFhir = fixture.runtime.fhir.read(
      { workspaceId: scenario.workspaceId, epoch: scenario.epoch },
      'Patient',
      visitA.detail.patient.id,
    ) as {
      id: string
      birthDate?: string
      name?: Array<{ text?: string }>
      identifier?: Array<{ system?: string; value?: string }>
      telecom?: Array<{ system?: string; value?: string }>
    }
    const nationalId = patientAFhir.identifier?.find(i => i.system === 'urn:oid:1.2.156.112605.1.1')?.value
    expect(nationalId).toBeTruthy()
    const patientADemographics = {
      id: visitA.detail.patient.id,
      name: patientAFhir.name?.[0]?.text ?? visitA.detail.patient.name,
      birthDate: patientAFhir.birthDate!,
      nationalId: nationalId!,
      phone: patientAFhir.telecom?.find(t => t.system === 'phone')?.value ?? null,
    }

    // Create Agent token scoped to doctor.case.clinical-fact-ledger.read
    const adminCookie = await fixture.login('admin')
    const agentClientRes = await fixture.runtime.app.request('/api/agent/v1/clients', {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        origin: 'http://localhost',
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ name: 'S3 Ledger Verification Agent' }),
    })
    expect(agentClientRes.status).toBe(200)
    const agentClient = agentClientSchema.parse(await agentClientRes.json())
    const agentGrantRes = await fixture.runtime.app.request('/api/agent/v1/grants', {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        origin: 'http://localhost',
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        agentClientId: agentClient.agentClientId,
        operationIds: ['doctor.case.clinical-fact-ledger.read'],
        practitionerRoleId: 'practitioner-role-outpatient-doctor',
        ttlSeconds: 3600,
      }),
    })
    expect(agentGrantRes.status).toBe(200)
    const agentGrant = agentCapabilityGrantSchema.parse(await agentGrantRes.json())

    // Advance virtual time to 2026-08-24T12:00:00+08:00 so all ingested labs fall <= asOf
    await fixture.request('admin', `/api/sim/v1/scenario-runs/${scenario.scenarioRunId}/actions/advance-time`, {
      expectedVirtualTime: scenario.virtualTime,
      targetVirtualTime: new Date(Math.max(Date.parse(scenario.virtualTime) + 60_000, Date.parse('2026-08-24T12:00:00+08:00'))).toISOString(),
    })

    // --- 1. Security checks on batch ingestion endpoint ---
    const missingOriginRes = await postRawJson(
      fixture,
      'admin',
      '/api/sim/v1/local-ingestion/batches',
      {
        sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
        batchId: 'batch-rejected-origin',
        expectedItemCount: 1,
        specimen_barcode: 'SB-ORIGIN',
        patient_ref: {
          externalPatientId: patientADemographics.id,
          localPatientId: patientADemographics.id,
          fullName: patientADemographics.name,
          birthDate: patientADemographics.birthDate,
          nationalId: patientADemographics.nationalId,
        },
        records: [{
          externalReportId: 'r-origin',
          orderId: 'o-origin',
          analyte_local_code: 'CREA',
          analyte_label: '肌酐',
          result_num: 1.33,
          uom_text: 'mg/dL',
          collected_ts: '2026-08-24T08:15:00+08:00',
          released_ts: '2026-08-24T09:00:00+08:00',
          report_status: 'final',
          version: 1,
        }],
      },
      { includeOrigin: false },
    )
    expect(missingOriginRes.status).toBe(403)

    const doctorIngestForbidden = await postRawJson(
      fixture,
      'doctor',
      '/api/sim/v1/local-ingestion/batches',
      {
        sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
        batchId: 'batch-forbidden-role',
        expectedItemCount: 1,
        specimen_barcode: 'SB-ROLE',
        patient_ref: {
          externalPatientId: patientADemographics.id,
          localPatientId: patientADemographics.id,
          fullName: patientADemographics.name,
          birthDate: patientADemographics.birthDate,
          nationalId: patientADemographics.nationalId,
        },
        records: [{
          externalReportId: 'r-role',
          orderId: 'o-role',
          analyte_local_code: 'CREA',
          analyte_label: '肌酐',
          result_num: 1.33,
          uom_text: 'mg/dL',
          collected_ts: '2026-08-24T08:15:00+08:00',
          released_ts: '2026-08-24T09:00:00+08:00',
          report_status: 'final',
          version: 1,
        }],
      },
    )
    expect(doctorIngestForbidden.status).toBe(403)

    // --- 2. AC37: Compare Primary HIS vs clinmesh-sim-lis-v2 on identical clinical measurements ---
    const visitPrimary = await registerAndStartVisit(fixture, regCatalog, {
      name: '刘建国',
      birthDate: '1964-06-18',
      gender: 'male',
      nationalId: '110101196406180019',
    })
    const visitSimV2 = await registerAndStartVisit(fixture, regCatalog, {
      name: '赵志明',
      birthDate: '1964-06-18',
      gender: 'male',
      nationalId: '110101196406180035',
    })

    const primaryRes = await postRawJson(fixture, 'admin', '/api/sim/v1/local-ingestion/batches', {
      sourceSystemId: PRIMARY_LOCAL_SOURCE_SYSTEM_ID,
      batchId: 'batch-ac37-primary',
      expectedItemCount: 4,
      ingestedAt: '2026-08-24T09:10:00+08:00',
      specimenBarcode: 'SB-AC37-001',
      patientRef: {
        externalPatientId: visitPrimary.patientId,
        localPatientId: visitPrimary.patientId,
        fullName: '刘建国',
        birthDate: '1964-06-18',
        nationalId: '110101196406180019',
      },
      records: [
        {
          externalReportId: 'his-cr-1',
          orderId: 'ord-ac37-1',
          loincCode: '2160-0',
          display: '血清肌酐',
          value: 117.572,
          unit: 'umol/L',
          effectiveDateTime: '2026-08-24T08:10:00+08:00',
          issued: '2026-08-24T09:00:00+08:00',
          orderedAt: '2026-08-24T08:00:00+08:00',
          status: 'final',
          version: 1,
          specimenLabel: 'Serum',
          methodText: 'Enzymatic',
        },
        {
          externalReportId: 'his-tn-1',
          orderId: 'ord-ac37-2',
          loincCode: '89579-7',
          display: '高敏肌钙蛋白I (hs-cTnI)',
          value: 52,
          unit: 'ng/L',
          effectiveDateTime: '2026-08-24T08:12:00+08:00',
          issued: '2026-08-24T08:50:00+08:00',
          orderedAt: '2026-08-24T08:00:00+08:00',
          status: 'final',
          version: 1,
          specimenLabel: 'Venous blood',
          interpretationCode: 'H',
        },
        {
          externalReportId: 'his-ldl-1',
          orderId: 'ord-ac37-3',
          loincCode: '13457-7',
          display: '低密度脂蛋白胆固醇 (LDL-C)',
          value: 2,
          unit: 'mmol/L',
          effectiveDateTime: '2026-08-24T08:14:00+08:00',
          issued: '2026-08-24T09:02:00+08:00',
          status: 'final',
          version: 1,
        },
        {
          externalReportId: 'his-hba1c-1',
          orderId: 'ord-ac37-4',
          loincCode: '4548-4',
          display: '糖化血红蛋白 (HbA1c)',
          value: 7.4,
          unit: '%',
          effectiveDateTime: '2026-08-24T08:16:00+08:00',
          issued: '2026-08-24T09:04:00+08:00',
          status: 'final',
          version: 1,
        },
      ],
    })
    expect(primaryRes.status).toBe(200)
    const primaryIngest = ingestLocalSourceBatchResponseSchema.parse(await primaryRes.json()).data
    expect(primaryIngest.identityCandidate.decision).toBe('matched')
    expect(primaryIngest.identityCandidate.confidenceScore).toBeGreaterThanOrEqual(0.9)
    expect(primaryIngest.visibleInClinicalLedger).toBe(true)

    const simV2Res = await postRawJson(fixture, 'admin', '/api/sim/v1/local-ingestion/batches', {
      sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
      batchId: 'batch-ac37-simv2',
      expectedItemCount: 4,
      ingestedAt: '2026-08-24T09:10:00+08:00',
      specimen_barcode: 'SB-AC37-001',
      patient_ref: {
        externalPatientId: visitSimV2.patientId,
        localPatientId: visitSimV2.patientId,
        fullName: '赵志明',
        birthDate: '1964-06-18',
        nationalId: '110101196406180035',
      },
      records: [
        {
          externalReportId: 'lis2-cr-1',
          orderId: 'ord-ac37-1',
          analyte_local_code: 'CREA',
          analyte_label: '肌酐',
          result_num: 1.33,
          uom_text: 'mg/dL',
          collected_ts: '2026-08-24T08:10:00+08:00',
          released_ts: '2026-08-24T09:00:00+08:00',
          ordered_ts: '2026-08-24T08:00:00+08:00',
          report_status: 'final',
          version: 1,
          specimen_type: '血清',
          method_text: '酶法',
        },
        {
          externalReportId: 'lis2-tn-1',
          orderId: 'ord-ac37-2',
          analyte_local_code: 'HS-CTNI',
          analyte_label: '高敏肌钙蛋白I',
          result_num: 0.052,
          uom_text: 'ng/mL',
          collected_ts: '2026-08-24T08:12:00+08:00',
          released_ts: '2026-08-24T08:50:00+08:00',
          ordered_ts: '2026-08-24T08:00:00+08:00',
          report_status: 'final',
          version: 1,
          specimen_type: '静脉血',
          interpretation_flag: '偏高',
        },
        {
          externalReportId: 'lis2-ldl-1',
          orderId: 'ord-ac37-3',
          analyte_local_code: 'LDL-C',
          analyte_label: '低密度脂蛋白',
          result_num: 77.34,
          uom_text: 'mg/dL',
          collected_ts: '2026-08-24T08:14:00+08:00',
          released_ts: '2026-08-24T09:02:00+08:00',
          report_status: 'final',
          version: 1,
        },
        {
          externalReportId: 'lis2-hba1c-1',
          orderId: 'ord-ac37-4',
          analyte_local_code: 'HBA1C',
          analyte_label: '糖化血红蛋白',
          result_num: 7.4,
          uom_text: '%',
          collected_ts: '2026-08-24T08:16:00+08:00',
          released_ts: '2026-08-24T09:04:00+08:00',
          report_status: 'final',
          version: 1,
        },
      ],
    })
    expect(simV2Res.status).toBe(200)
    const simV2Ingest = ingestLocalSourceBatchResponseSchema.parse(await simV2Res.json()).data
    expect(simV2Ingest.identityCandidate.decision).toBe('matched')
    expect(simV2Ingest.visibleInClinicalLedger).toBe(true)

    const primaryLedger = await fixture.read(
      'doctor',
      `/api/his/v1/outpatient/cases/${visitPrimary.caseId}/clinical-fact-ledger?categories=laboratory`,
      clinicalFactLedgerSchema,
    )
    const simV2Ledger = await fixture.read(
      'doctor',
      `/api/his/v1/outpatient/cases/${visitSimV2.caseId}/clinical-fact-ledger?categories=laboratory`,
      clinicalFactLedgerSchema,
    )
    expect(primaryLedger.facts).toHaveLength(4)
    expect(simV2Ledger.facts).toHaveLength(4)

    const ac37Result = compareSourceSystemLedgers({
      leftSourceSystemId: PRIMARY_LOCAL_SOURCE_SYSTEM_ID,
      leftLedger: primaryLedger,
      rightSourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
      rightLedger: simV2Ledger,
      categories: ['laboratory'],
    })
    expect(ac37Result).toEqual({
      identicalNormalizedFacts: true,
      mismatches: [],
      sourceSystemsCompared: [PRIMARY_LOCAL_SOURCE_SYSTEM_ID, SIM_LIS_V2_SOURCE_SYSTEM_ID],
      comparedFactCount: 4,
    })

    // Clinical scores must also match across both sources
    const primaryScores = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visitPrimary.caseId}/clinical-scores`,
      clinicalScoreBundleSchema,
    )
    const simV2Scores = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visitSimV2.caseId}/clinical-scores`,
      clinicalScoreBundleSchema,
    )
    const primaryEgfr = primaryScores.scores.find(s => s.id === 'ckd-epi-2021-egfr')!
    const simV2Egfr = simV2Scores.scores.find(s => s.id === 'ckd-epi-2021-egfr')!
    expect(primaryEgfr.status).toBe('complete')
    expect(simV2Egfr.status).toBe('complete')
    expect(simV2Egfr.value).toBe(primaryEgfr.value)
    const primaryGrace = primaryScores.scores.find(s => s.id === 'grace-acs')!
    const simV2Grace = simV2Scores.scores.find(s => s.id === 'grace-acs')!
    expect(primaryGrace.missingInputs).not.toContain('serumCreatinine')
    expect(primaryGrace.missingInputs).not.toContain('elevatedCardiacBiomarker')
    expect(simV2Grace.missingInputs).not.toContain('serumCreatinine')
    expect(simV2Grace.missingInputs).not.toContain('elevatedCardiacBiomarker')

    // --- 3. AC38 Rule 1: Homonym & external/local ID collision with different birthDate MUST NEVER merge ---
    const homonymRes = await postRawJson(fixture, 'admin', '/api/sim/v1/local-ingestion/batches', {
      sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
      batchId: 'batch-homonym-collision',
      expectedItemCount: 1,
      specimen_barcode: 'SB-HOMONYM',
      patient_ref: {
        externalPatientId: patientADemographics.id,
        localPatientId: patientADemographics.id,
        fullName: patientADemographics.name,
        birthDate: '1999-12-31',
        nationalId: '110101199912310099',
        phone: patientADemographics.phone,
      },
      records: [{
        externalReportId: 'lis2-homonym-cr',
        orderId: 'ord-hom-1',
        analyte_local_code: 'CREA',
        analyte_label: '肌酐',
        result_num: 9.9,
        uom_text: 'mg/dL',
        collected_ts: '2026-08-24T08:20:00+08:00',
        released_ts: '2026-08-24T09:10:00+08:00',
        report_status: 'final',
        version: 1,
      }],
    })
    expect(homonymRes.status).toBe(200)
    const homonymIngest = ingestLocalSourceBatchResponseSchema.parse(await homonymRes.json()).data
    expect(homonymIngest.identityCandidate.decision).toBe('distinct-patient')
    expect(homonymIngest.identityCandidate.resolutionStatus).toBe('rejected-distinct')
    expect(homonymIngest.identityCandidate.matchedLocalPatientId).toBeNull()
    expect(homonymIngest.identityCandidate.confidenceScore).toBeLessThan(0.3)
    expect(homonymIngest.visibleInClinicalLedger).toBe(false)

    // Patient A's ledger MUST NOT include the homonym creatinine 9.9 mg/dL
    const patientALedgerAfterHomonym = await fixture.read(
      'doctor',
      `/api/his/v1/outpatient/cases/${visitA.caseId}/clinical-fact-ledger`,
      clinicalFactLedgerSchema,
    )
    expect(patientALedgerAfterHomonym.facts.some(f => f.provenance.sourceSystemId === SIM_LIS_V2_SOURCE_SYSTEM_ID)).toBe(false)

    // --- 4. AC39: Incomplete batch (6/10 -> 0 visible in ledger, agent tool, scores; 10/10 -> all 10 visible) ---
    const firstSixRecords = Array.from({ length: 6 }, (_, idx) => ({
      externalReportId: `chunk-rep-${idx + 1}`,
      orderId: `chunk-ord-${idx + 1}`,
      analyte_local_code: idx === 0 ? 'CREA' : idx === 1 ? 'K' : idx === 2 ? 'NA' : idx === 3 ? 'HBA1C' : idx === 4 ? 'WBC' : 'HB',
      analyte_label: idx === 0 ? '肌酐' : idx === 1 ? '血清钾' : idx === 2 ? '血清钠' : idx === 3 ? '糖化血红蛋白' : idx === 4 ? '白细胞' : '血红蛋白',
      result_num: idx === 0 ? 1.5 : idx === 1 ? 4.3 : idx === 2 ? 140 : idx === 3 ? 6.8 : idx === 4 ? 7.2 : 13.1,
      uom_text: idx === 0 ? 'mg/dL' : idx <= 2 ? 'mmol/L' : idx === 3 ? '%' : idx === 4 ? '10*9/L' : 'g/dL',
      collected_ts: '2026-08-24T08:05:00+08:00',
      released_ts: `2026-08-24T09:0${idx}:00+08:00`,
      report_status: 'final' as const,
      version: 1,
    }))
    const lastFourRecords = [
      { externalReportId: 'chunk-rep-7', orderId: 'chunk-ord-7', analyte_local_code: 'HS-CTNI', analyte_label: '高敏肌钙蛋白I', result_num: 0.06, uom_text: 'ng/mL', collected_ts: '2026-08-24T08:05:00+08:00', released_ts: '2026-08-24T09:06:00+08:00', report_status: 'final' as const, version: 1 },
      { externalReportId: 'chunk-rep-8', orderId: 'chunk-ord-8', analyte_local_code: 'TC', analyte_label: '总胆固醇', result_num: 5.2, uom_text: 'mmol/L', collected_ts: '2026-08-24T08:05:00+08:00', released_ts: '2026-08-24T09:07:00+08:00', report_status: 'final' as const, version: 1 },
      { externalReportId: 'chunk-rep-9', orderId: 'chunk-ord-9', analyte_local_code: 'HDL-C', analyte_label: '高密度脂蛋白', result_num: 1.1, uom_text: 'mmol/L', collected_ts: '2026-08-24T08:05:00+08:00', released_ts: '2026-08-24T09:08:00+08:00', report_status: 'final' as const, version: 1 },
      { externalReportId: 'chunk-rep-10', orderId: 'chunk-ord-10', analyte_local_code: 'LDL-C', analyte_label: '低密度脂蛋白', result_num: 3.1, uom_text: 'mmol/L', collected_ts: '2026-08-24T08:05:00+08:00', released_ts: '2026-08-24T09:09:00+08:00', report_status: 'final' as const, version: 1 },
    ]

    const chunk1Res = await postRawJson(fixture, 'admin', '/api/sim/v1/local-ingestion/batches', {
      sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
      batchId: 'batch-ac39-ten',
      expectedItemCount: 10,
      specimen_barcode: 'SB-AC39',
      patient_ref: {
        externalPatientId: patientADemographics.id,
        localPatientId: patientADemographics.id,
        fullName: patientADemographics.name,
        birthDate: patientADemographics.birthDate,
        nationalId: patientADemographics.nationalId,
        phone: patientADemographics.phone,
      },
      records: firstSixRecords,
    })
    expect(chunk1Res.status).toBe(200)
    const chunk1Data = ingestLocalSourceBatchResponseSchema.parse(await chunk1Res.json()).data
    expect(chunk1Data.batch.batchStatus).toBe('incomplete')
    expect(chunk1Data.batch.receivedItemCount).toBe(6)
    expect(chunk1Data.batch.expectedItemCount).toBe(10)
    expect(chunk1Data.visibleInClinicalLedger).toBe(false)

    // Verify 0 records from incomplete batch are visible to doctor, agent ledger tool, or scores
    const doctorLedgerWhileIncomplete = await fixture.read(
      'doctor',
      `/api/his/v1/outpatient/cases/${visitA.caseId}/clinical-fact-ledger`,
      clinicalFactLedgerSchema,
    )
    expect(doctorLedgerWhileIncomplete.facts.some(f => f.provenance.sourceSystemId === SIM_LIS_V2_SOURCE_SYSTEM_ID)).toBe(false)

    const agentLedgerWhileIncompleteRes = await fixture.runtime.app.request(
      `/api/his/v1/outpatient/cases/${visitA.caseId}/clinical-fact-ledger`,
      { headers: { authorization: `Bearer ${agentGrant.token}` } },
    )
    expect(agentLedgerWhileIncompleteRes.status).toBe(200)
    const agentRawTextWhileIncomplete = await agentLedgerWhileIncompleteRes.clone().text()
    expect(agentRawTextWhileIncomplete).not.toContain(caseTruthSentinel) // AC15
    const agentLedgerWhileIncomplete = clinicalFactLedgerSchema.parse(await agentLedgerWhileIncompleteRes.json())
    expect(agentLedgerWhileIncomplete.facts.some(f => f.provenance.sourceSystemId === SIM_LIS_V2_SOURCE_SYSTEM_ID)).toBe(false)

    const scoresWhileIncomplete = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visitA.caseId}/clinical-scores`,
      clinicalScoreBundleSchema,
    )
    const egfrWhileIncomplete = scoresWhileIncomplete.scores.find(s => s.id === 'ckd-epi-2021-egfr')!
    expect(egfrWhileIncomplete.status).toBe('incomplete')
    expect(egfrWhileIncomplete.missingInputs).toContain('serumCreatinine')
    const graceWhileIncomplete = scoresWhileIncomplete.scores.find(s => s.id === 'grace-acs')!
    expect(graceWhileIncomplete.missingInputs).toContain('serumCreatinine')
    expect(graceWhileIncomplete.missingInputs).toContain('elevatedCardiacBiomarker')

    // Deliver chunk 2 (remaining 4/10) -> batch becomes 'complete' and all 10 appear!
    const chunk2Res = await postRawJson(fixture, 'admin', '/api/sim/v1/local-ingestion/batches', {
      sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
      batchId: 'batch-ac39-ten',
      expectedItemCount: 10,
      specimen_barcode: 'SB-AC39',
      patient_ref: {
        externalPatientId: patientADemographics.id,
        localPatientId: patientADemographics.id,
        fullName: patientADemographics.name,
        birthDate: patientADemographics.birthDate,
        nationalId: patientADemographics.nationalId,
        phone: patientADemographics.phone,
      },
      records: lastFourRecords,
    })
    expect(chunk2Res.status).toBe(200)
    const chunk2Data = ingestLocalSourceBatchResponseSchema.parse(await chunk2Res.json()).data
    expect(chunk2Data.batch.batchStatus).toBe('complete')
    expect(chunk2Data.batch.receivedItemCount).toBe(10)
    expect(chunk2Data.visibleInClinicalLedger).toBe(true)

    const doctorLedgerComplete = await fixture.read(
      'doctor',
      `/api/his/v1/outpatient/cases/${visitA.caseId}/clinical-fact-ledger`,
      clinicalFactLedgerSchema,
    )
    const simV2CompleteFacts = doctorLedgerComplete.facts.filter(
      f => f.provenance.sourceSystemId === SIM_LIS_V2_SOURCE_SYSTEM_ID,
    )
    expect(simV2CompleteFacts).toHaveLength(10)

    const agentLedgerCompleteRes = await fixture.runtime.app.request(
      `/api/his/v1/outpatient/cases/${visitA.caseId}/clinical-fact-ledger`,
      { headers: { authorization: `Bearer ${agentGrant.token}` } },
    )
    expect(agentLedgerCompleteRes.status).toBe(200)
    const agentLedgerComplete = clinicalFactLedgerSchema.parse(await agentLedgerCompleteRes.json())
    expect(agentLedgerComplete.facts.filter(f => f.provenance.sourceSystemId === SIM_LIS_V2_SOURCE_SYSTEM_ID)).toHaveLength(10)

    const scoresComplete = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visitA.caseId}/clinical-scores`,
      clinicalScoreBundleSchema,
    )
    const egfrComplete = scoresComplete.scores.find(s => s.id === 'ckd-epi-2021-egfr')!
    expect(egfrComplete.status).toBe('complete')
    const graceComplete = scoresComplete.scores.find(s => s.id === 'grace-acs')!
    expect(graceComplete.missingInputs).not.toContain('serumCreatinine')
    expect(graceComplete.missingInputs).not.toContain('elevatedCardiacBiomarker')

    // --- 5. AC38 Rule 3: Unlinked second-system patient below threshold -> quarantine until registrar/admin confirm-merge ---
    const quarantinedIngestRes = await postRawJson(fixture, 'admin', '/api/sim/v1/local-ingestion/batches', {
      sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
      batchId: 'batch-ac38-quarantine',
      expectedItemCount: 1,
      specimen_barcode: 'SB-QUAR-1',
      patient_ref: {
        externalPatientId: 'lis2-ext-unlinked-999',
        fullName: patientADemographics.name,
        birthDate: patientADemographics.birthDate,
        nationalId: patientADemographics.nationalId,
        phone: '13999998888',
      },
      records: [{
        externalReportId: 'lis2-quar-tg-1',
        orderId: 'ord-quar-1',
        analyte_local_code: 'TG',
        analyte_label: '甘油三酯',
        result_num: 2.65,
        uom_text: 'mmol/L',
        collected_ts: '2026-08-24T08:25:00+08:00',
        released_ts: '2026-08-24T09:15:00+08:00',
        report_status: 'final',
        version: 1,
      }],
    })
    expect(quarantinedIngestRes.status).toBe(200)
    const quarantinedData = ingestLocalSourceBatchResponseSchema.parse(await quarantinedIngestRes.json()).data
    expect(quarantinedData.identityCandidate.decision).toBe('quarantined')
    expect(quarantinedData.identityCandidate.resolutionStatus).toBe('pending-review')
    expect(quarantinedData.identityCandidate.confidenceScore).toBeLessThan(0.9)
    expect(quarantinedData.identityCandidate.matchedLocalPatientId).toBe(patientADemographics.id)
    expect(quarantinedData.visibleInClinicalLedger).toBe(false)

    // Still excluded from Patient A ledger until manual confirmation
    const ledgerBeforeMerge = await fixture.read(
      'doctor',
      `/api/his/v1/outpatient/cases/${visitA.caseId}/clinical-fact-ledger?itemCodes=2571-8`,
      clinicalFactLedgerSchema,
    )
    expect(ledgerBeforeMerge.facts).toHaveLength(0)

    // RBAC: doctor, nurse, pharmacist MUST receive 403 on identity-quarantine endpoints
    for (const forbiddenRole of ['doctor', 'ward-nurse', 'pharmacist'] as const) {
      const listForbidden = await fixture.request(forbiddenRole, '/api/his/v1/identity-quarantine')
      expect(listForbidden.status).toBe(403)
      const mergeForbidden = await postRawJson(
        fixture,
        forbiddenRole,
        `/api/his/v1/identity-quarantine/${quarantinedData.identityCandidate.candidateId}/confirm-merge`,
        { decision: 'confirm-merge', targetPatientId: patientADemographics.id, auditNote: '越权合并' },
      )
      expect(mergeForbidden.status).toBe(403)
    }

    // Registrar lists pending quarantine queue
    const pendingList = await fixture.read(
      'registrar',
      '/api/his/v1/identity-quarantine?resolutionStatus=pending-review',
      listIdentityQuarantineResponseSchema,
    )
    expect(pendingList.pendingCount).toBe(1)
    expect(pendingList.items[0]?.candidateId).toBe(quarantinedData.identityCandidate.candidateId)

    // Attempting to confirm-merge into a patient whose birthDate differs MUST fail with 422!
    const wrongBirthDateMergeRes = await postRawJson(
      fixture,
      'registrar',
      `/api/his/v1/identity-quarantine/${quarantinedData.identityCandidate.candidateId}/confirm-merge`,
      {
        decision: 'confirm-merge',
        targetPatientId: visitPrimary.patientId,
        auditNote: '测试错档校验',
      },
    )
    expect(wrongBirthDateMergeRes.status).toBe(422)
    expect(apiErrorSchema.parse(await wrongBirthDateMergeRes.json()).error.code).toBe('BIRTH_DATE_MISMATCH_MERGE_FORBIDDEN')

    // Registrar confirms merge with idempotency key -> releases TG observation into ledger + writes AuditEvent & ActionTrace
    const mergeIdempotencyKey = randomUUID()
    const confirmRes = await postRawJson(
      fixture,
      'registrar',
      `/api/his/v1/identity-quarantine/${quarantinedData.identityCandidate.candidateId}/confirm-merge`,
      {
        decision: 'confirm-merge',
        targetPatientId: patientADemographics.id,
        auditNote: '核对身份证号与出生日期一致，确认跨系统并档',
      },
      { key: mergeIdempotencyKey },
    )
    expect(confirmRes.status).toBe(200)
    const confirmBody = confirmIdentityQuarantineMergeResponseSchema.parse(await confirmRes.json())
    expect(confirmBody.data.candidate.resolutionStatus).toBe('confirmed-merged')
    expect(confirmBody.data.candidate.matchedLocalPatientId).toBe(patientADemographics.id)
    expect(confirmBody.data.candidate.auditNote).toBe('核对身份证号与出生日期一致，确认跨系统并档')
    expect(confirmBody.data.releasedObservationCount).toBe(1)

    // Replay with identical idempotency key succeeds without duplicate mutation
    const replayConfirmRes = await postRawJson(
      fixture,
      'registrar',
      `/api/his/v1/identity-quarantine/${quarantinedData.identityCandidate.candidateId}/confirm-merge`,
      {
        decision: 'confirm-merge',
        targetPatientId: patientADemographics.id,
        auditNote: '核对身份证号与出生日期一致，确认跨系统并档',
      },
      { key: mergeIdempotencyKey },
    )
    expect(replayConfirmRes.status).toBe(200)
    expect(confirmIdentityQuarantineMergeResponseSchema.parse(await replayConfirmRes.json()).data.releasedObservationCount).toBe(1)

    // Verify AuditEvent & ActionTrace recorded
    const scope = { workspaceId: scenario.workspaceId, epoch: scenario.epoch } as const
    const auditEvent = fixture.runtime.fhir.read(scope, 'AuditEvent', confirmBody.auditId) as {
      resourceType?: string
      outcome?: { code?: { code?: string } }
    }
    expect(auditEvent.resourceType).toBe('AuditEvent')
    expect(auditEvent.outcome?.code?.code).toBe('0')

    const traceRow = z.object({ outcome: z.string(), actor_id: z.string(), effect_json: z.string() }).parse(
      fixture.runtime.database.driver.prepare(`
        SELECT outcome, actor_id, effect_json FROM action_trace
        WHERE workspace_id = ? AND epoch = ? AND operation = 'identity-quarantine.confirm-merge'
        ORDER BY sequence DESC LIMIT 1
      `).get(scenario.workspaceId, scenario.epoch),
    )
    expect(traceRow.outcome).toBe('success')
    expect(JSON.parse(traceRow.effect_json)).toContainEqual(
      expect.objectContaining({
        kind: 'updated',
        reference: `IdentityQuarantine/${quarantinedData.identityCandidate.candidateId}`,
      }),
    )

    // Now Patient A's ledger includes the released TG observation
    const ledgerAfterMerge = await fixture.read(
      'doctor',
      `/api/his/v1/outpatient/cases/${visitA.caseId}/clinical-fact-ledger?itemCodes=2571-8`,
      clinicalFactLedgerSchema,
    )
    expect(ledgerAfterMerge.facts).toHaveLength(1)
    expect(ledgerAfterMerge.facts[0]?.value.normalizedValue).toEqual({ unit: 'mmol/L', value: 2.65 })
    expect(ledgerAfterMerge.facts[0]?.provenance.sourceSystemId).toBe(SIM_LIS_V2_SOURCE_SYSTEM_ID)

    // Subsequent batch with the same confirmed externalPatientId + matching demographics auto-matches
    const followUpMatchedRes = await postRawJson(fixture, 'admin', '/api/sim/v1/local-ingestion/batches', {
      sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
      batchId: 'batch-ac38-after-link',
      expectedItemCount: 1,
      specimen_barcode: 'SB-LINKED-2',
      patient_ref: {
        externalPatientId: 'lis2-ext-unlinked-999',
        fullName: patientADemographics.name,
        birthDate: patientADemographics.birthDate,
        nationalId: patientADemographics.nationalId,
        phone: patientADemographics.phone,
      },
      records: [{
        externalReportId: 'lis2-linked-psa-check',
        orderId: 'ord-linked-2',
        analyte_local_code: 'K',
        analyte_label: '血清钾',
        result_num: 4.1,
        uom_text: 'mmol/L',
        collected_ts: '2026-08-24T08:30:00+08:00',
        released_ts: '2026-08-24T09:20:00+08:00',
        report_status: 'final',
        version: 1,
      }],
    })
    expect(followUpMatchedRes.status).toBe(200)
    const followUpData = ingestLocalSourceBatchResponseSchema.parse(await followUpMatchedRes.json()).data
    expect(followUpData.identityCandidate.decision).toBe('matched')
    expect(followUpData.identityCandidate.confidenceScore).toBeGreaterThanOrEqual(0.9)
    expect(followUpData.visibleInClinicalLedger).toBe(true)

    // AC15 sentinel check across identity-quarantine & clinical-scores
    const quarantineText = await (await fixture.request('registrar', '/api/his/v1/identity-quarantine')).text()
    const adminQuarantineRes = await fixture.request('admin', '/api/his/v1/identity-quarantine')
    expect(adminQuarantineRes.status).toBe(200)
    const scoresText = await (await fixture.request('doctor', `/api/his/v1/doctor/cases/${visitA.caseId}/clinical-scores`)).text()
    expect(quarantineText).not.toContain(caseTruthSentinel)
    expect(scoresText).not.toContain(caseTruthSentinel)

    // Reject-distinct keeps quarantined records excluded from patient ledger permanently
    const rejectCandidateIngest = await postRawJson(fixture, 'admin', '/api/sim/v1/local-ingestion/batches', {
      sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
      batchId: 'batch-ac38-reject-case',
      expectedItemCount: 1,
      specimen_barcode: 'SB-REJECT-1',
      patient_ref: {
        externalPatientId: 'lis2-ext-reject-777',
        fullName: patientADemographics.name,
        birthDate: patientADemographics.birthDate,
        nationalId: patientADemographics.nationalId,
        phone: '13700000000',
      },
      records: [{
        externalReportId: 'lis2-reject-cr',
        orderId: 'ord-reject-1',
        analyte_local_code: 'CREA',
        analyte_label: '肌酐',
        result_num: 8.8,
        uom_text: 'mg/dL',
        collected_ts: '2026-08-24T08:35:00+08:00',
        released_ts: '2026-08-24T09:25:00+08:00',
        report_status: 'final',
        version: 1,
      }],
    })
    expect(rejectCandidateIngest.status).toBe(200)
    const rejectCandidate = ingestLocalSourceBatchResponseSchema.parse(await rejectCandidateIngest.json()).data
    expect(rejectCandidate.identityCandidate.decision).toBe('quarantined')

    const rejectRes = await postRawJson(
      fixture,
      'admin',
      `/api/his/v1/identity-quarantine/${rejectCandidate.identityCandidate.candidateId}/confirm-merge`,
      { decision: 'reject-distinct', auditNote: '电话与就诊院区核实确系他院误传重号，拒绝并档' },
    )
    expect(rejectRes.status).toBe(200)
    const rejectBody = confirmIdentityQuarantineMergeResponseSchema.parse(await rejectRes.json())
    expect(rejectBody.data.candidate.resolutionStatus).toBe('rejected-distinct')
    expect(rejectBody.data.candidate.matchedLocalPatientId).toBeNull()
    expect(rejectBody.data.releasedObservationCount).toBe(0)

    const ledgerAfterReject = await fixture.read(
      'doctor',
      `/api/his/v1/outpatient/cases/${visitA.caseId}/clinical-fact-ledger?itemCodes=2160-0`,
      clinicalFactLedgerSchema,
    )
    expect(ledgerAfterReject.facts.some(f => Number((f.value.normalizedValue as { value?: number })?.value) === 8.8)).toBe(false)
  })
})
