import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clinicalFactLedgerSchema,
  clinicalFactVerificationResponseSchema,
} from '@clinmesh/contracts/clinical-fact-ledger'
import { clinicalQualityCheckSchema } from '@clinmesh/contracts/clinical-quality'
import {
  bedsideQuestionnaireResponseSchema,
  bedsideQuestionnaireStateSchema,
  clinicalScoreBundleSchema,
} from '@clinmesh/contracts/clinical-scores'
import { diseasePackRuntimeBundleSchema } from '@clinmesh/contracts/disease-pack'
import { guidelineTopicBundleSchema } from '@clinmesh/contracts/guideline-topics'
import {
  commandResponseSchema,
  createPatientResponseSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  prescriptionDraftResponseSchema,
  registrationCatalogSchema,
  registrationResponseSchema,
  scenarioStateSchema,
  startVisitResponseSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalResponseSchema } from '@clinmesh/contracts/inpatient-clinical'
import { pciCaseSourceResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import {
  orderSetDraftBundleSchema,
  orderSetTemplateListSchema,
} from '@clinmesh/contracts/order-set-templates'
import { startSyntheticCaseResultSchema } from '@clinmesh/contracts/scenario'
import { listHospitalGeneralLabPanels } from '../src/application/order-set-template-registry.ts'
import { listGuidelineTopicDefinitions } from '../src/application/guideline-topic-registry.ts'
import { DiseasePackRegistry } from '../src/application/disease-pack-runtime-service.ts'
import {
  createPciPaymentDrgFixture,
  parsePciResponse,
  preparePciPaymentDrgFixture,
  type PciPaymentDrgFixture,
} from './fixtures/pci-payment-drg.ts'

const SYNTHETIC_PACK_DIR = resolve(import.meta.dirname, 'fixtures/disease-packs/synthetic-test-syndrome-pack')

describe('Coronary Migration (S5): Data Pack, Hospital Separation, Bedside Questionnaire & Provenance', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!()
    }
  })

  async function setupFixture(options: { withSyntheticPack?: boolean } = {}) {
    const prepared = await preparePciPaymentDrgFixture()
    cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))
    if (options.withSyntheticPack) {
      prepared.options.diseasePackDirs = [SYNTHETIC_PACK_DIR]
    }
    const fixture = await createPciPaymentDrgFixture(prepared)
    cleanups.push(() => fixture.runtime.close())
    return { fixture, prepared }
  }

  async function sendRawJson(
    fixture: PciPaymentDrgFixture,
    role: string,
    path: string,
    method: 'POST' | 'PUT',
    body: unknown,
  ) {
    const cookie = await fixture.login(role)
    return fixture.runtime.app.request(path, {
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method,
    })
  }

  function currentScope(fixture: PciPaymentDrgFixture) {
    const row = fixture.runtime.database.driver.prepare(`
      SELECT workspace_id, epoch FROM scenario_run
      WHERE status = 'active'
      ORDER BY started_at DESC LIMIT 1
    `).get() as { epoch: string; workspace_id: string }
    const timeRow = fixture.runtime.database.driver.prepare(`
      SELECT virtual_time FROM scenario_epoch_state
      WHERE workspace_id = ? AND epoch = ?
    `).get(row.workspace_id, row.epoch) as { virtual_time: string }
    return { epoch: row.epoch, virtualTime: timeRow.virtual_time, workspaceId: row.workspace_id }
  }

  async function createOutpatientPatient(fixture: PciPaymentDrgFixture, birthDate = '1965-05-10') {
    return (await parsePciResponse(
      createPatientResponseSchema,
      await fixture.request('registrar', '/api/his/v1/patients', {
        birthDate,
        gender: 'male',
        identifier: `SYN-COR-${randomUUID()}`,
        name: '合成冠脉迁移验收患者',
      }, randomUUID(), {}),
    )).data.patient
  }

  async function startOutpatientVisitForPatient(
    fixture: PciPaymentDrgFixture,
    patient: { id: string; versionId: string },
    chiefComplaint = '胸闷胸痛评估',
  ) {
    const catalog = await fixture.read('registrar', '/api/his/v1/catalogs/registration', registrationCatalogSchema)
    const registered = (await parsePciResponse(
      registrationResponseSchema,
      await fixture.request('registrar', '/api/his/v1/registrations/actions/register', {
        departmentId: catalog.departments[0]!.id,
        locationId: catalog.locations[0]!.id,
        patientId: patient.id,
        visitDate: catalog.virtualDate,
        visitTypeId: catalog.visitTypes[0]!.id,
      }, randomUUID(), {
        [`Patient/${patient.id}`]: patient.versionId,
      }),
    )).data

    const triaged = await parsePciResponse(
      triageResponseSchema,
      await fixture.request('triage', `/api/his/v1/encounters/${registered.encounterId}/actions/record-triage`, {
        acuityCode: 'level-2',
        bloodPressure: { diastolicMmHg: 76, systolicMmHg: 128 },
        chiefComplaint,
        heightCm: 170,
        oxygenSaturationPct: 98,
        pulseBpm: 74,
        respirationBpm: 18,
        temperatureC: 36.6,
        weightKg: 72,
      }, randomUUID(), {
        [`Encounter/${registered.encounterId}`]: '1',
        [`Task/${registered.queueTaskId}`]: '1',
      }),
    )

    await parsePciResponse(
      startVisitResponseSchema,
      await fixture.request('doctor', `/api/his/v1/encounters/${registered.encounterId}/actions/start-first-visit`, {}, randomUUID(), {
        [`Encounter/${registered.encounterId}`]: triaged.data.encounterVersion,
        [`Task/${triaged.data.doctorTaskId}`]: '1',
      }),
    )

    const queue = await fixture.read('doctor', '/api/his/v1/doctor/queue', doctorQueueSchema)
    const item = queue.items.find(row => row.encounterId === registered.encounterId)!
    const detail = await fixture.read('doctor', `/api/his/v1/doctor/cases/${item.caseId}`, doctorCaseDetailSchema)
    return { caseId: item.caseId, detail, encounterId: registered.encounterId, patientId: registered.patientId }
  }

  function insertCondition(
    fixture: PciPaymentDrgFixture,
    input: { code: string; display: string; encounterId: string; note?: string; patientId: string; recordedDate?: string },
  ) {
    const scope = currentScope(fixture)
    const id = `cond-${randomUUID()}`
    fixture.runtime.fhir.create({ epoch: scope.epoch, workspaceId: scope.workspaceId }, {
      clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
      code: { coding: [{ code: input.code, display: input.display, system: 'http://hl7.org/fhir/sid/icd-10' }], text: input.display },
      encounter: { reference: `Encounter/${input.encounterId}` },
      id,
      ...(input.note === undefined ? {} : { note: [{ text: input.note }] }),
      recordedDate: input.recordedDate ?? scope.virtualTime,
      resourceType: 'Condition',
      subject: { reference: `Patient/${input.patientId}` },
      verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
    })
    return id
  }

  function insertLabObservation(
    fixture: PciPaymentDrgFixture,
    input: { code: string; display: string; effectiveAt?: string; encounterId: string; patientId: string; unit: string; value: number },
  ) {
    const scope = currentScope(fixture)
    const id = `obs-${randomUUID()}`
    const ts = input.effectiveAt ?? scope.virtualTime
    fixture.runtime.fhir.create({ epoch: scope.epoch, workspaceId: scope.workspaceId }, {
      category: [{ coding: [{ code: 'laboratory', system: 'http://terminology.hl7.org/CodeSystem/observation-category' }] }],
      code: { coding: [{ code: input.code, display: input.display, system: 'http://loinc.org' }], text: input.display },
      effectiveDateTime: ts,
      encounter: { reference: `Encounter/${input.encounterId}` },
      id,
      issued: ts,
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: `Patient/${input.patientId}` },
      valueQuantity: { code: input.unit, system: 'http://unitsofmeasure.org', unit: input.unit, value: input.value },
    })
    return id
  }

  function insertActiveServiceRequest(
    fixture: PciPaymentDrgFixture,
    input: { code: string; display: string; encounterId: string; patientId: string; system: string },
  ) {
    const scope = currentScope(fixture)
    const id = `sr-${randomUUID()}`
    fixture.runtime.fhir.create({ epoch: scope.epoch, workspaceId: scope.workspaceId }, {
      authoredOn: scope.virtualTime,
      code: { coding: [{ code: input.code, display: input.display, system: input.system }], text: input.display },
      encounter: { reference: `Encounter/${input.encounterId}` },
      id,
      intent: 'order',
      resourceType: 'ServiceRequest',
      status: 'active',
      subject: { reference: `Patient/${input.patientId}` },
    })
    return id
  }

  it('AC3 & AC3b: triggers coronary-cad from structured cues despite free-text denial, activates stable CAD without chest pain, and isolates hospital general layer for orthopedic patients', async () => {
    const registry = new DiseasePackRegistry()
    const coronary = registry.getEffective('coronary-cad')
    expect(coronary.pack.manifest.status).toBe('active')
    expect(coronary.pack.stages.map(s => s.id)).toEqual(['initial-visit', 'pci-preop', 'pci-postop', 'discharge', 'follow-up'])
    expect(coronary.pack.guidelineTopics?.map(t => t.id)).toEqual([
      'acute-chest-pain-acs',
      'coronary-revascularization-indication',
      'pci-stent',
      'contrast-kidney-hydration',
      'cad-dapt-and-secondary-prevention',
    ])
    expect(listGuidelineTopicDefinitions(registry).map(t => t.id)).toContain('t2dm-renal-medication')
    expect(listHospitalGeneralLabPanels().map(p => p.code)).toEqual([
      'CN-LAB-CBC',
      'CN-LAB-CBC-5DIFF',
      'CN-LAB-LIVER',
      'CN-LAB-RENAL',
      'CN-LAB-ELECTROLYTES',
      'CN-LAB-COAGULATION',
    ])

    const { fixture } = await setupFixture()

    // Case 1: Epigastric pain (R10.1) + T2DM (E11.9) + ordered ECG ServiceRequest + explicit "否认胸痛" note STILL activates coronary-cad
    const p1 = await createOutpatientPatient(fixture)
    const v1 = await startOutpatientVisitForPatient(fixture, p1, '上腹痛伴糖尿病，否认胸痛')
    insertCondition(fixture, { code: 'R10.1', display: '上腹痛', encounterId: v1.encounterId, note: '患者否认胸痛及放射痛', patientId: p1.id })
    insertCondition(fixture, { code: 'E11.9', display: '2型糖尿病', encounterId: v1.encounterId, patientId: p1.id })
    insertActiveServiceRequest(fixture, {
      code: '11524-6',
      display: '常规 12 导联心电图',
      encounterId: v1.encounterId,
      patientId: p1.id,
      system: 'http://loinc.org',
    })
    const packs1 = await fixture.read('doctor', `/api/his/v1/outpatient/cases/${v1.caseId}/disease-packs`, diseasePackRuntimeBundleSchema)
    expect(packs1.packs.find(p => p.packId === 'coronary-cad')).toMatchObject({
      activationReason: 'trigger-matched',
      activationStatus: 'active',
      currentStageId: 'initial-visit',
      matchedTriggerIds: expect.arrayContaining(['acute-chest-pain-workup']),
    })

    // Case 2: Control epigastric pain WITHOUT T2DM / ECG / Troponin does NOT activate coronary-cad
    const p2 = await createOutpatientPatient(fixture)
    const v2 = await startOutpatientVisitForPatient(fixture, p2, '单纯上腹隐痛')
    insertCondition(fixture, { code: 'R10.1', display: '上腹痛', encounterId: v2.encounterId, patientId: p2.id })
    const packs2 = await fixture.read('doctor', `/api/his/v1/outpatient/cases/${v2.caseId}/disease-packs`, diseasePackRuntimeBundleSchema)
    expect(packs2.packs.find(p => p.packId === 'coronary-cad')?.activationStatus).toBe('inactive')

    // Case 3: Stable CAD (I25.103) without chest pain activates coronary-cad (`AC3b`)
    const p3 = await createOutpatientPatient(fixture)
    const v3 = await startOutpatientVisitForPatient(fixture, p3, '择期冠脉评估')
    insertCondition(fixture, { code: 'I25.103', display: '冠状动脉粥样硬化性心脏病', encounterId: v3.encounterId, patientId: p3.id })
    const packs3 = await fixture.read('doctor', `/api/his/v1/outpatient/cases/${v3.caseId}/disease-packs`, diseasePackRuntimeBundleSchema)
    expect(packs3.packs.find(p => p.packId === 'coronary-cad')).toMatchObject({
      activationStatus: 'active',
      matchedTriggerIds: expect.arrayContaining(['cad-or-acs-diagnosis']),
    })

    // Case 4: Orthopedic patient (non-CAD) activates 0 packs, yet hospital baseline templates remain available without pack provenance (`AC3b`)
    const orthoStay = await fixture.admitSyntheticCase(['I10.x09'], 'bed-general-1')
    insertCondition(fixture, { code: 'S72.0', display: '股骨颈骨折', encounterId: orthoStay.admissionId, patientId: orthoStay.patientId })
    const orthoPacks = await fixture.read('inpatient-doctor', `${orthoStay.path}/disease-packs`, diseasePackRuntimeBundleSchema)
    expect(orthoPacks.packs.every(p => p.activationStatus !== 'active')).toBe(true)

    const catalogTemplates = await fixture.read('inpatient-doctor', '/api/his/v1/catalogs/order-set-templates?scope=inpatient', orderSetTemplateListSchema)
    expect(catalogTemplates.items.map(t => t.id)).toContain('general-surgery-postop-standard')

    const orthoDrafts = await fixture.read('inpatient-doctor', `${orthoStay.path}/order-set-drafts`, orderSetDraftBundleSchema)
    expect(orthoDrafts.packId).toBeUndefined()
    expect(orthoDrafts.sourcePacks).toBeUndefined()
  })

  it('AC1: excludes external unverified creatinine from CKD-EPI, Cockcroft-Gault, GRACE, and renal quality checks until verified', async () => {
    const { fixture } = await setupFixture()
    const scenario = await fixture.read('admin', '/api/sim/v1/scenario-runs/current', scenarioStateSchema)
    const pciSource = (await parsePciResponse(
      pciCaseSourceResponseSchema,
      await fixture.request('admin', '/api/sim/v1/synthetic-cases/pci/prepare', { expectedEpoch: scenario.epoch }),
    )).data
    const regCatalog = await fixture.read('registrar', '/api/his/v1/catalogs/registration', registrationCatalogSchema)
    const started = (await parsePciResponse(
      commandResponseSchema(startSyntheticCaseResultSchema),
      await sendRawJson(fixture, 'registrar', `/api/his/v1/synthetic-cases/${pciSource.case.caseId}/actions/start-outpatient-visit`, 'POST', {
        activeBriefRevision: pciSource.case.activeBriefRevision,
        departmentId: regCatalog.departments[0]!.id,
        expectedCaseRevision: pciSource.case.revision,
        locationId: regCatalog.locations[0]!.id,
        visitDate: regCatalog.virtualDate,
        visitTypeId: regCatalog.visitTypes[0]!.id,
      }),
    )).data

    const extCrRef = 'Observation/ext-severe-cr-s5'
    fixture.runtime.database.driver.prepare(`
      INSERT INTO synthetic_case_visible_resource (workspace_id, case_id, source_reference, resource_type, resource_json)
      VALUES (?, ?, ?, 'Observation', ?)
    `).run(
      scenario.workspaceId,
      pciSource.case.caseId,
      extCrRef,
      JSON.stringify({
        code: { coding: [{ code: '2160-0', display: '外院血清肌酐', system: 'http://loinc.org' }] },
        effectiveDateTime: '2026-08-20T09:00:00+08:00',
        issued: '2026-08-20T10:00:00+08:00',
        status: 'final',
        valueQuantity: { unit: 'umol/L', value: 320 },
      }),
    )
    fixture.runtime.database.driver.prepare(`
      INSERT INTO synthetic_case_visible_history (workspace_id, case_id, sequence, source_reference, resource_type, clinical_date, title)
      VALUES (?, ?, 999, ?, 'Observation', '2026-08-20T10:00:00+08:00', '外院近期血清肌酐升高')
    `).run(scenario.workspaceId, pciSource.case.caseId, extCrRef)

    const triaged = await parsePciResponse(
      triageResponseSchema,
      await fixture.request('triage', `/api/his/v1/encounters/${started.encounterId}/actions/record-triage`, {
        acuityCode: 'level-2',
        bloodPressure: { diastolicMmHg: 80, systolicMmHg: 132 },
        chiefComplaint: '胸痛待查伴外院化验',
        heightCm: 170,
        oxygenSaturationPct: 98,
        pulseBpm: 84,
        respirationBpm: 18,
        temperatureC: 36.7,
        weightKg: 70,
      }, randomUUID(), {
        [`Encounter/${started.encounterId}`]: '1',
        [`Task/${started.queueTaskId}`]: '1',
      }),
    )
    await parsePciResponse(
      startVisitResponseSchema,
      await fixture.request('doctor', `/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, {}, randomUUID(), {
        [`Encounter/${started.encounterId}`]: triaged.data.encounterVersion,
        [`Task/${triaged.data.doctorTaskId}`]: '1',
      }),
    )
    const queue = await fixture.read('doctor', '/api/his/v1/doctor/queue', doctorQueueSchema)
    const visit = queue.items.find(r => r.encounterId === started.encounterId)!
    const detail = await fixture.read('doctor', `/api/his/v1/doctor/cases/${visit.caseId}`, doctorCaseDetailSchema)
    insertCondition(fixture, { code: 'I21.4', display: '急性非ST段抬高型心肌梗死', encounterId: visit.encounterId, patientId: detail.patient.id })

    // 1. Before verification: external creatinine is excluded from scores, order sets, & renal quality checks
    const draftSaveRes = await sendRawJson(
      fixture,
      'doctor',
      `/api/his/v1/encounters/${visit.encounterId}/prescription/draft`,
      'PUT',
      {
        expectedVersions: { [`Encounter/${visit.encounterId}`]: detail.encounter.versionId },
        input: {
          expectedDraftVersion: 0,
          items: [{ catalogItemId: 'medication-metformin', courseDays: 7, doseText: '500mg', frequencyCode: 'BID', quantity: 14, routeCode: 'PO' }],
        },
      },
    )
    expect(draftSaveRes.status, await draftSaveRes.clone().text()).toBe(200)
    prescriptionDraftResponseSchema.parse(await draftSaveRes.json())

    const ledgerBefore = await fixture.read(
      'doctor',
      `/api/his/v1/outpatient/cases/${visit.caseId}/clinical-fact-ledger`,
      clinicalFactLedgerSchema,
    )
    const extFact = ledgerBefore.facts.find(f => f.provenance.recordId === extCrRef)!
    expect(extFact.qualityFlags).toContain('external-unverified')
    expect(extFact.eligibleForScoringAndRedLine).toBe(false)

    const qualityBefore = await fixture.read(
      'doctor',
      `/api/his/v1/encounters/${visit.encounterId}/clinical-quality?gate=outpatient-prescription`,
      clinicalQualityCheckSchema,
    )
    expect(qualityBefore.redLines).toEqual([])
    expect(qualityBefore.alerts.map(a => a.code)).toContain('RENAL_CREATININE_MISSING')

    const draftsBefore = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/order-set-drafts?templateId=chest-pain-stat-workup`,
      orderSetDraftBundleSchema,
    )
    expect(draftsBefore.patientFacts.egfr.status).toBe('missing')

    const scoresBefore = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/clinical-scores`,
      clinicalScoreBundleSchema,
    )
    for (const scoreId of ['ckd-epi-2021-egfr', 'cockcroft-gault-crcl', 'grace-acs'] as const) {
      const score = scoresBefore.scores.find(s => s.id === scoreId)!
      expect(score.status).toBe('incomplete')
      if (score.status === 'incomplete') {
        expect(score.missingInputs).toContain('serumCreatinine')
      }
    }

    // 2. Verify external creatinine via clinical-fact-verifications -> scores, order sets, & renal red line immediately compute
    const verifyRes = await fixture.request(
      'doctor',
      `/api/his/v1/outpatient/cases/${visit.caseId}/clinical-fact-verifications`,
      { decision: 'verified', expectedSourceVersion: extFact.provenance.recordVersion, factId: extFact.factId, note: '已核对原始纸质检验单一致' },
    )
    expect(verifyRes.status).toBe(200)
    const verifiedFact = clinicalFactVerificationResponseSchema.parse(await verifyRes.json()).data.fact
    expect(verifiedFact.eligibleForScoringAndRedLine).toBe(true)

    const scoresAfter = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/clinical-scores`,
      clinicalScoreBundleSchema,
    )
    expect(scoresAfter.scores.find(s => s.id === 'ckd-epi-2021-egfr')?.status).toBe('complete')
    expect(scoresAfter.scores.find(s => s.id === 'cockcroft-gault-crcl')?.status).toBe('complete')
    const graceAfter = scoresAfter.scores.find(s => s.id === 'grace-acs')!
    expect(graceAfter.status === 'incomplete' ? graceAfter.missingInputs : []).not.toContain('serumCreatinine')

    const qualityAfter = await fixture.read(
      'doctor',
      `/api/his/v1/encounters/${visit.encounterId}/clinical-quality?gate=outpatient-prescription`,
      clinicalQualityCheckSchema,
    )
    expect(qualityAfter.redLines.map(r => r.code)).toContain('RENAL_CONTRAINDICATED_MEDICATION')

    const draftsAfter = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/order-set-drafts?templateId=chest-pain-stat-workup`,
      orderSetDraftBundleSchema,
    )
    expect(draftsAfter.patientFacts.egfr.status).toBe('present')
  })

  it('AC3c: deduplicates multi-pack questionnaire items by code, emits unrecorded items as 没问到 / not-asked, and stays bidirectional with 9-field risk-assessment', async () => {
    const { fixture } = await setupFixture({ withSyntheticPack: true })
    const p = await createOutpatientPatient(fixture)
    const visit = await startOutpatientVisitForPatient(fixture, p, '冠心病稳定期复诊')
    // Triggers BOTH coronary-cad and synthetic-test-syndrome simultaneously
    insertCondition(fixture, { code: 'I25.103', display: '冠状动脉粥样硬化性心脏病', encounterId: visit.encounterId, patientId: p.id })

    const qBefore = await fixture.read(
      'doctor',
      `/api/his/v1/outpatient/cases/${visit.caseId}/bedside-questionnaire`,
      bedsideQuestionnaireStateSchema,
    )
    const smokingItems = qBefore.items.filter(item => item.code === 'smoking-status')
    expect(smokingItems).toHaveLength(1)
    expect(smokingItems[0]!.packIds).toEqual(['coronary-cad', 'synthetic-test-syndrome'])
    expect(smokingItems[0]!.presence).toBe('not-asked')
    expect(smokingItems[0]!.valueText).toBe('没问到')

    // Ledger emits active pack unrecorded questionnaire items as not-asked & ineligible
    const ledgerBefore = await fixture.read(
      'doctor',
      `/api/his/v1/outpatient/cases/${visit.caseId}/clinical-fact-ledger?categories=bedside-questionnaire`,
      clinicalFactLedgerSchema,
    )
    const unaskedSmoking = ledgerBefore.facts.find(f => f.itemCode.code === 'smoking-status')!
    expect(unaskedSmoking.presence).toBe('not-asked')
    expect(unaskedSmoking.value).toEqual({ normalizedValue: null, rawText: '没问到' })
    expect(unaskedSmoking.eligibleForScoringAndRedLine).toBe(false)

    // Record via generalized bedside-questionnaire PUT -> updates legacy 9-field risk assessment too
    const recRes = await sendRawJson(
      fixture,
      'doctor',
      `/api/his/v1/outpatient/cases/${visit.caseId}/bedside-questionnaire`,
      'PUT',
      {
        input: {
          answers: [
            { code: 'smoking-status', textValue: 'current' },
            { booleanValue: true, code: 'known-coronary-stenosis-ge-50' },
            { code: 'killip-class', textValue: 'I' },
          ],
          encounterVersion: qBefore.encounterVersion,
          expectedRevision: qBefore.revision,
        },
      },
    )
    expect(recRes.status, await recRes.clone().text()).toBe(200)
    const recData = bedsideQuestionnaireResponseSchema.parse(await recRes.json()).data
    expect(recData.legacyRiskAssessment.values.smokingStatus).toBe('current')
    expect(recData.legacyRiskAssessment.values.knownCoronaryStenosisGe50).toBe(true)
    expect(recData.items.find(i => i.code === 'smoking-status')?.presence).toBe('present')

    const scores = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/clinical-scores`,
      clinicalScoreBundleSchema,
    )
    expect(scores.riskAssessment.values.smokingStatus).toBe('current')
    expect(scores.riskAssessment.values.killipClass).toBe('I')
  })

  it('AC14 & AC23: populates source pack provenance on all 8 specialist tools and tracks full NSTEMI -> PCI -> discharge -> 1-month outpatient follow-up journey with longitudinal LDL-C', async () => {
    const { fixture } = await setupFixture()
    const patient = await createOutpatientPatient(fixture, '1962-04-15')

    // Step 1: Outpatient Initial NSTEMI encounter (baseline LDL-C = 3.6 mmol/L, creatinine = 86 umol/L)
    const v1 = await startOutpatientVisitForPatient(fixture, patient, '胸骨后压榨性疼痛 2 小时')
    insertCondition(fixture, { code: 'I21.4', display: '急性非ST段抬高型心肌梗死', encounterId: v1.encounterId, patientId: patient.id })
    insertLabObservation(fixture, { code: '13457-7', display: '低密度脂蛋白胆固醇 (LDL-C)', encounterId: v1.encounterId, patientId: patient.id, unit: 'mmol/L', value: 3.6 })
    insertLabObservation(fixture, { code: '2160-0', display: '血清肌酐', encounterId: v1.encounterId, patientId: patient.id, unit: 'umol/L', value: 86 })

    const outScores = await fixture.read('doctor', `/api/his/v1/doctor/cases/${v1.caseId}/clinical-scores`, clinicalScoreBundleSchema)
    const outTopics = await fixture.read('doctor', `/api/his/v1/doctor/cases/${v1.caseId}/guideline-topics`, guidelineTopicBundleSchema)
    const outQuality = await fixture.read('doctor', `/api/his/v1/encounters/${v1.encounterId}/clinical-quality?gate=outpatient-completion`, clinicalQualityCheckSchema)
    const outOrderSets = await fixture.read('doctor', `/api/his/v1/doctor/cases/${v1.caseId}/order-set-drafts`, orderSetDraftBundleSchema)
    for (const bundle of [outScores, outTopics, outQuality, outOrderSets]) {
      expect(bundle.packId).toBe('coronary-cad')
      expect(bundle.packVersion).toBe('2026-11-26.r1')
      expect(bundle.sourcePacks?.map(s => s.packId)).toContain('coronary-cad')
    }

    // Step 2: Inpatient admission for PCI -> PCI preop -> PCI execution -> postop -> discharge
    const stay = await fixture.preparePciAdmission([], { baselineCreatinineUmolL: 86 })
    const inPatientId = stay.patientId
    // Seed NSTEMI + baseline LDL 3.6 mmol/L on the PCI stay patient as well for full inpatient->follow-up trajectory
    const stayDetail = await fixture.read('inpatient-doctor', stay.path, inpatientDetailSchema)
    insertCondition(fixture, { code: 'I21.4', display: '急性非ST段抬高型心肌梗死', encounterId: stay.admissionId, patientId: inPatientId })
    insertLabObservation(fixture, {
      code: '13457-7',
      display: '低密度脂蛋白胆固醇 (LDL-C)',
      effectiveAt: '2026-08-24T08:00:00+08:00',
      encounterId: stay.admissionId,
      patientId: inPatientId,
      unit: 'mmol/L',
      value: 3.6,
    })

    const inPacksPreop = await fixture.read('inpatient-doctor', `${stay.path}/disease-packs`, diseasePackRuntimeBundleSchema)
    expect(inPacksPreop.packs.find(p => p.packId === 'coronary-cad')?.currentStageId).toBe('pci-preop')

    const inQBefore = await fixture.read('inpatient-doctor', `${stay.path}/bedside-questionnaire`, bedsideQuestionnaireStateSchema)
    const inQRes = await sendRawJson(fixture, 'inpatient-doctor', `${stay.path}/bedside-questionnaire`, 'PUT', {
      input: {
        answers: [{ code: 'smoking-status', textValue: 'former' }],
        encounterVersion: stayDetail.admission.versionId,
        expectedRevision: inQBefore.revision,
      },
    })
    expect(inQRes.status, await inQRes.clone().text()).toBe(200)
    expect(bedsideQuestionnaireResponseSchema.parse(await inQRes.json()).data.legacyRiskAssessment.values.smokingStatus).toBe('former')

    const inScores = await fixture.read('inpatient-doctor', `${stay.path}/clinical-scores`, clinicalScoreBundleSchema)
    const inTopics = await fixture.read('inpatient-doctor', `${stay.path}/guideline-topics`, guidelineTopicBundleSchema)
    const inQuality = await fixture.read('inpatient-doctor', `${stay.path}/clinical-quality?gate=inpatient-pci-plan`, clinicalQualityCheckSchema)
    const inOrderSets = await fixture.read('inpatient-doctor', `${stay.path}/order-set-drafts`, orderSetDraftBundleSchema)
    for (const bundle of [inScores, inTopics, inQuality, inOrderSets]) {
      expect(bundle.packId).toBe('coronary-cad')
      expect(bundle.packVersion).toBe('2026-11-26.r1')
      expect(bundle.sourcePacks?.map(s => s.packId)).toContain('coronary-cad')
    }

    // Execute PCI & discharge patient cleanly
    await fixture.executePci(stay)
    const inPacksPostop = await fixture.read('inpatient-doctor', `${stay.path}/disease-packs`, diseasePackRuntimeBundleSchema)
    expect(inPacksPostop.packs.find(p => p.packId === 'coronary-cad')?.currentStageId).toBe('pci-postop')
    await fixture.depart(stay)
    const inPacksDischarge = await fixture.read('inpatient-doctor', `${stay.path}/disease-packs`, diseasePackRuntimeBundleSchema)
    expect(inPacksDischarge.packs.find(p => p.packId === 'coronary-cad')?.currentStageId).toBe('discharge')

    // Step 3: Advance virtual clock 1 month & register outpatient follow-up visit for SAME patient (`inPatientId`)
    const scopeBeforeAdvance = currentScope(fixture)
    const advRes = await fixture.request('admin', '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
      expectedVirtualTime: scopeBeforeAdvance.virtualTime,
      targetVirtualTime: '2026-09-24T09:30:00+08:00',
    })
    expect(advRes.status, await advRes.clone().text()).toBe(200)

    const patVersion = String(
      (fixture.runtime.fhir.read({ epoch: scopeBeforeAdvance.epoch, workspaceId: scopeBeforeAdvance.workspaceId }, 'Patient', inPatientId).meta?.versionId ?? '1'),
    )
    const followUpVisit = await startOutpatientVisitForPatient(fixture, { id: inPatientId, versionId: patVersion }, '冠心病 PCI 术后 1 月随访')
    insertLabObservation(fixture, {
      code: '13457-7',
      display: '低密度脂蛋白胆固醇 (LDL-C)',
      effectiveAt: '2026-09-24T09:15:00+08:00',
      encounterId: followUpVisit.encounterId,
      patientId: inPatientId,
      unit: 'mmol/L',
      value: 1.25,
    })

    const followUpPacks = await fixture.read('doctor', `/api/his/v1/outpatient/cases/${followUpVisit.caseId}/disease-packs`, diseasePackRuntimeBundleSchema)
    const followUpCoronary = followUpPacks.packs.find(p => p.packId === 'coronary-cad')!
    expect(followUpCoronary.activationStatus).toBe('active')
    expect(followUpCoronary.currentStageId).toBe('follow-up')
    expect(followUpCoronary.readinessTasks.map(r => r.taskId)).toEqual(['followup-review'])
    expect(followUpCoronary.followUpLdlSummary).toMatchObject({
      atGoal: true,
      baselineLdlMmolL: 3.6,
      deltaMmolL: -2.35,
      latestLdlMmolL: 1.25,
    })
    expect(followUpCoronary.followUpLdlSummary?.comparisonTextZh).toContain('3.6 -> 1.25 mmol/L')

    const stageAuditRows = fixture.runtime.database.driver.prepare(`
      SELECT to_stage_id FROM disease_pack_stage_audit
      WHERE workspace_id = ? AND epoch = ? AND subject_id = ? AND pack_id = 'coronary-cad'
      ORDER BY julianday(recorded_at) ASC, rowid ASC
    `).all(scopeBeforeAdvance.workspaceId, scopeBeforeAdvance.epoch, followUpVisit.caseId) as Array<{ to_stage_id: string }>
    expect(stageAuditRows.map(r => r.to_stage_id)).toContain('follow-up')

    // Follow-up restricts pack topics & order sets to secondary prevention only (`AC23`)
    const followUpTopics = await fixture.read('doctor', `/api/his/v1/doctor/cases/${followUpVisit.caseId}/guideline-topics`, guidelineTopicBundleSchema)
    const packOwnedTopics = followUpTopics.items.filter(item => item.packId === 'coronary-cad').map(item => item.topic.id)
    expect(packOwnedTopics).toEqual(['cad-dapt-and-secondary-prevention'])

    const followUpOrderSets = await fixture.read('doctor', `/api/his/v1/doctor/cases/${followUpVisit.caseId}/order-set-drafts`, orderSetDraftBundleSchema)
    const packOwnedOrderSets = followUpOrderSets.drafts.filter(d => d.packId === 'coronary-cad').map(d => d.template.id)
    expect(packOwnedOrderSets).toEqual(['cad-pci-secondary-prevention'])
    void stayDetail
    void inpatientFullClinicalResponseSchema
  })
})
