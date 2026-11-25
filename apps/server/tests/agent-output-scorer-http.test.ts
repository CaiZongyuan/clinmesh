import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SIMULATION_SCORING_DISCLAIMER_ZH,
  UNEVALUATED_AGENT_OUTPUT_LABEL_ZH,
  agentOutputScoreResultSchema,
  createUnevaluatedAgentOutputState,
  type AgentScoringRubricInput,
} from '@clinmesh/contracts/agent-output-scorer'
import {
  apiErrorSchema,
  createPatientResponseSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  registrationCatalogSchema,
  registrationResponseSchema,
  startVisitResponseSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { createPciPaymentDrgFixture, parsePciResponse, preparePciPaymentDrgFixture, type PciPaymentDrgFixture } from './fixtures/pci-payment-drg.ts'

describe('AC40 Agent Output Scorer & Clinician Edit Distance Tracker HTTP Contract', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!()
    }
  })

  function currentEpoch(fixture: PciPaymentDrgFixture): string {
    const row = fixture.runtime.database.driver.prepare(`
      SELECT epoch FROM scenario_run
      WHERE workspace_id = 'workspace-demo' AND status = 'active'
      ORDER BY started_at DESC LIMIT 1
    `).get() as { epoch: string } | undefined
    return row?.epoch ?? 'epoch-1'
  }

  function currentVirtualTime(fixture: PciPaymentDrgFixture): string {
    const epoch = currentEpoch(fixture)
    const row = fixture.runtime.database.driver.prepare(`
      SELECT virtual_time FROM scenario_epoch_state
      WHERE workspace_id = 'workspace-demo' AND epoch = ?
    `).get(epoch) as { virtual_time: string } | undefined
    return row?.virtual_time ?? '2026-08-24T09:00:00+08:00'
  }

  async function startOutpatientVisitForDoctor(fixture: PciPaymentDrgFixture) {
    const patient = (await parsePciResponse(
      createPatientResponseSchema,
      await fixture.request('registrar', '/api/his/v1/patients', {
        birthDate: '1959-09-15',
        gender: 'male',
        identifier: `SYN-SCORER-${randomUUID()}`,
        name: '陈志远',
      }, randomUUID(), {}),
    )).data.patient
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
        bloodPressure: { diastolicMmHg: 76, systolicMmHg: 124 },
        chiefComplaint: 'NSTEMI PCI术后门诊随访',
        heightCm: 172,
        oxygenSaturationPct: 99,
        pulseBpm: 72,
        respirationBpm: 18,
        temperatureC: 36.5,
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

  function insertFollowupClinicalFacts(fixture: PciPaymentDrgFixture, patientId: string, encounterId: string) {
    const context = { epoch: currentEpoch(fixture), workspaceId: 'workspace-demo' }
    const now = currentVirtualTime(fixture)
    const earlier = '2026-08-10T08:30:00+08:00'

    fixture.runtime.fhir.create(context, {
      category: [{ coding: [{ code: 'laboratory', system: 'http://terminology.hl7.org/CodeSystem/observation-category' }] }],
      code: { coding: [{ code: '13457-7', display: '低密度脂蛋白胆固醇 (LDL-C)', system: 'http://loinc.org' }], text: 'LDL-C' },
      effectiveDateTime: earlier,
      encounter: { reference: `Encounter/${encounterId}` },
      id: `obs-ldl-baseline-${randomUUID()}`,
      issued: earlier,
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: `Patient/${patientId}` },
      valueQuantity: { code: 'mmol/L', system: 'http://unitsofmeasure.org', unit: 'mmol/L', value: 3.6 },
    })
    fixture.runtime.fhir.create(context, {
      category: [{ coding: [{ code: 'laboratory', system: 'http://terminology.hl7.org/CodeSystem/observation-category' }] }],
      code: { coding: [{ code: '13457-7', display: '低密度脂蛋白胆固醇 (LDL-C)', system: 'http://loinc.org' }], text: 'LDL-C' },
      effectiveDateTime: now,
      encounter: { reference: `Encounter/${encounterId}` },
      id: `obs-ldl-followup-${randomUUID()}`,
      issued: now,
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: `Patient/${patientId}` },
      valueQuantity: { code: 'mmol/L', system: 'http://unitsofmeasure.org', unit: 'mmol/L', value: 1.25 },
    })
    fixture.runtime.fhir.create(context, {
      category: [{ coding: [{ code: 'laboratory', system: 'http://terminology.hl7.org/CodeSystem/observation-category' }] }],
      code: { coding: [{ code: '2160-0', display: '血清肌酐', system: 'http://loinc.org' }], text: '血清肌酐' },
      effectiveDateTime: now,
      encounter: { reference: `Encounter/${encounterId}` },
      id: `obs-creat-${randomUUID()}`,
      issued: now,
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: `Patient/${patientId}` },
      valueQuantity: { code: 'umol/L', system: 'http://unitsofmeasure.org', unit: 'umol/L', value: 112 },
    })
    for (const med of [
      { code: 'aspirin', display: '阿司匹林肠溶片' },
      { code: 'ticagrelor', display: '替格瑞洛片' },
      { code: 'atorvastatin', display: '阿托伐他汀钙片' },
    ]) {
      fixture.runtime.fhir.create(context, {
        authoredOn: now,
        id: `med-${med.code}-${randomUUID()}`,
        intent: 'order',
        medicationCodeableConcept: { coding: [{ code: med.code, display: med.display }] },
        resourceType: 'MedicationRequest',
        status: 'active',
        subject: { reference: `Patient/${patientId}` },
      })
    }
  }

  const followupRubric: AgentScoringRubricInput = {
    fabricationPenaltyPoints: 5,
    items: [
      {
        expectedPatterns: ['LDL 已达标', 'LDL(?:-?C)?.*(?:已达标|达标)'],
        factVerification: {
          itemCodes: ['13457-7'],
          maxValue: 1.4,
          unit: 'mmol/L',
        },
        id: 'ldl-achieved',
        labelZh: 'LDL 已达标',
        omissionPenaltyPoints: 3,
        positivePoints: 4,
        requiredWhenCondition: {
          category: 'laboratory',
          itemCodes: ['13457-7'],
          kind: 'fact',
          maxValue: 1.4,
          presence: 'present',
          requireEligible: true,
          unit: 'mmol/L',
        },
      },
      {
        expectedPatterns: ['双联抗血小板|阿司匹林.*替格瑞洛'],
        id: 'dapt-maintained',
        labelZh: '双联抗血小板治疗维持',
        omissionPenaltyPoints: 2,
        positivePoints: 3,
        requiredWhenCondition: {
          kind: 'allOf',
          nodes: [
            { category: 'medication', itemCodes: ['aspirin'], kind: 'fact', presence: 'present', requireEligible: true },
            { category: 'medication', itemCodes: ['ticagrelor'], kind: 'fact', presence: 'present', requireEligible: true },
          ],
        },
      },
      {
        expectedPatterns: ['阿托伐他汀|他汀'],
        id: 'statin-maintained',
        labelZh: '他汀治疗维持',
        omissionPenaltyPoints: 2,
        positivePoints: 3,
      },
      {
        expectedPatterns: ['肌酐'],
        factVerification: {
          itemCodes: ['2160-0'],
          maxValue: 133,
          unit: 'umol/L',
        },
        id: 'creatinine-checked',
        labelZh: '血清肌酐核对',
        omissionPenaltyPoints: 1,
        positivePoints: 2,
      },
    ],
    packId: 'coronary-cad',
    rubricId: 'cardio-followup-http-v1',
    taskId: 'followup-review',
    version: '1.0.0',
  }

  it('scores AC40 controlled drafts against real outpatient ledger, tracks clinician edits, and enforces live-model gate & AC15', async () => {
    const prepared = await preparePciPaymentDrgFixture()
    cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))
    const fixture = await createPciPaymentDrgFixture(prepared)
    cleanups.push(() => fixture.runtime.close())

    // Default unevaluated badge helper check
    expect(createUnevaluatedAgentOutputState().badge.labelZh).toBe(UNEVALUATED_AGENT_OUTPUT_LABEL_ZH)

    const visit = await startOutpatientVisitForDoctor(fixture)
    insertFollowupClinicalFacts(fixture, visit.patientId, visit.encounterId)

    // 1. Draft A (omits "LDL 已达标") + clinician final edits
    const draftARes = await fixture.request('doctor', '/api/his/v1/evaluation/agent-output-score', {
      clinicianFinalFields: {
        assessment: 'NSTEMI PCI 术后随访，LDL-C 降至 1.25 mmol/L，LDL 已达标；血清肌酐 112 umol/L。',
        followUp: '1个月后心内科门诊复查血脂、肝功能及肌酶。',
        plan: '继续阿司匹林联合替格瑞洛双联抗血小板及阿托伐他汀钙片治疗。',
      },
      draftFields: {
        assessment: 'NSTEMI PCI 术后随访，血清肌酐 112 umol/L。',
        plan: '继续阿司匹林联合替格瑞洛双联抗血小板及阿托伐他汀钙片治疗。',
      },
      draftText: 'NSTEMI PCI 术后随访：血清肌酐 112 umol/L。继续双联抗血小板（阿司匹林+替格瑞洛）及阿托伐他汀治疗。',
      mode: 'controlled-stream',
      rubric: followupRubric,
      subjectId: visit.caseId,
      subjectKind: 'outpatient',
    })
    expect(draftARes.status).toBe(200)
    const draftAText = await draftARes.text()
    expect(draftAText).not.toMatch(/caseTruth|case_truth/i)
    const draftA = agentOutputScoreResultSchema.parse(JSON.parse(draftAText))

    expect(draftA.zeroLiveModelCalls).toBe(true)
    expect(prepared.modelCalls).toBe(0)
    expect(draftA.badge).toEqual({
      disclaimerZh: SIMULATION_SCORING_DISCLAIMER_ZH,
      labelZh: '受控流仿真已评测',
      status: 'evaluated-simulation',
    })
    expect(draftA.omissions.map(o => o.rubricItemId)).toEqual(['ldl-achieved'])
    expect(draftA.omissionPenalty).toBe(3)
    expect(draftA.fabrications).toEqual([])
    expect(draftA.keyFactCoverageRate).toBe(0.75)
    expect(draftA.positiveScore).toBe(8)
    expect(draftA.netScore).toBe(5)
    expect(draftA.clinicianEditMetrics).not.toBeNull()
    expect(draftA.clinicianEditMetrics?.totalFields).toBe(3)
    expect(draftA.clinicianEditMetrics?.modifiedFieldsCount).toBe(1)
    expect(draftA.clinicianEditMetrics?.addedFieldsCount).toBe(1)
    expect(draftA.clinicianEditMetrics?.unchangedFieldsCount).toBe(1)
    expect(draftA.clinicianEditMetrics?.totalAddedChars).toBeGreaterThan(0)

    // 2. Draft B (covers key facts + fabricates "心脏MRI未见心肌水肿，LVEF 65%")
    const draftBRes = await fixture.request('doctor', '/api/his/v1/evaluation/agent-output-score', {
      draftFields: {
        assessment: 'LDL-C 由 3.6 降至 1.25 mmol/L，LDL 已达标；肌酐 112 umol/L。心脏MRI未见心肌水肿，LVEF 65%。',
        plan: '继续双联抗血小板（阿司匹林+替格瑞洛）及阿托伐他汀治疗。',
      },
      draftText: 'LDL-C 由 3.6 降至 1.25 mmol/L，LDL 已达标；肌酐 112 umol/L。心脏MRI未见心肌水肿，LVEF 65%。继续双联抗血小板及阿托伐他汀治疗。',
      mode: 'controlled-stream',
      rubric: followupRubric,
      subjectId: visit.caseId,
      subjectKind: 'outpatient',
    })
    expect(draftBRes.status).toBe(200)
    const draftB = agentOutputScoreResultSchema.parse(await draftBRes.json())
    expect(draftB.omissions).toEqual([])
    expect(draftB.keyFactCoverageRate).toBe(1)
    expect(draftB.positiveScore).toBe(12)
    expect(draftB.fabrications).toHaveLength(1)
    expect(draftB.fabrications[0]?.reasonCode).toBe('NONEXISTENT_LAB_OR_EXAM')
    expect(draftB.fabrications[0]?.statementZh).toContain('心脏MRI')
    expect(draftB.fabricationPenalty).toBe(5)
    expect(draftB.netScore).toBe(7)
    expect(draftB.clinicianEditMetrics).toBeNull()

    // 3. Live-model without explicit permit MUST reject 403 LIVE_MODEL_SCORING_PERMISSION_REQUIRED
    const unpermittedLiveRes = await fixture.request('doctor', '/api/his/v1/evaluation/agent-output-score', {
      draftFields: {
        assessment: 'LDL 已达标（1.25 mmol/L），肌酐 112 umol/L。',
        plan: '继续阿司匹林+替格瑞洛双联抗血小板与阿托伐他汀。',
      },
      draftText: 'LDL 已达标，肌酐 112 umol/L，继续双联抗血小板及阿托伐他汀。',
      mode: 'live-model',
      rubric: followupRubric,
      subjectId: visit.caseId,
      subjectKind: 'outpatient',
    })
    expect(unpermittedLiveRes.status).toBe(403)
    expect(apiErrorSchema.parse(await unpermittedLiveRes.json()).error.code).toBe('LIVE_MODEL_SCORING_PERMISSION_REQUIRED')

    // 4. Live-model WITH explicit permit succeeds with 0 real LLM calls, and administrator role is also allowed
    const permittedLiveRes = await fixture.request('admin', '/api/his/v1/evaluation/agent-output-score', {
      draftFields: {
        assessment: 'LDL 已达标（1.25 mmol/L），肌酐 112 umol/L。',
        plan: '继续阿司匹林+替格瑞洛双联抗血小板与阿托伐他汀。',
      },
      draftText: 'LDL 已达标，肌酐 112 umol/L，继续阿司匹林联合替格瑞洛双联抗血小板及阿托伐他汀。',
      liveRunPermit: {
        authorizedAt: '2026-08-24T09:05:00+08:00',
        authorizedByActorId: 'actor-administrator',
        explicitUserPermissionGranted: true,
        runId: 'run-live-explicit-01',
      },
      mode: 'live-model',
      rubric: followupRubric,
      subjectId: visit.caseId,
      subjectKind: 'outpatient',
    })
    expect(permittedLiveRes.status).toBe(200)
    const permittedLive = agentOutputScoreResultSchema.parse(await permittedLiveRes.json())
    expect(permittedLive.zeroLiveModelCalls).toBe(true)
    expect(permittedLive.badge).toEqual({
      labelZh: '真实模型本次授权已评测',
      runId: 'run-live-explicit-01',
      status: 'evaluated-live-authorized',
    })
    expect(prepared.modelCalls).toBe(0)

    // 5. Disallowed role (registrar) rejected 403
    const registrarRes = await fixture.request('registrar', '/api/his/v1/evaluation/agent-output-score', {
      draftFields: { assessment: 'test' },
      draftText: 'test',
      mode: 'controlled-stream',
      rubric: followupRubric,
      subjectId: visit.caseId,
      subjectKind: 'outpatient',
    })
    expect(registrarRes.status).toBe(403)

    // 6. Verify audit trail persisted in SQLite audit_log + FHIR AuditEvent
    const auditRows = fixture.runtime.database.driver.prepare(`
      SELECT operation, outcome FROM audit_log
      WHERE operation = 'evaluation.agent-output-score'
      ORDER BY sequence ASC
    `).all() as Array<{ operation: string; outcome: string }>
    expect(auditRows.filter(r => r.outcome === 'success').length).toBeGreaterThanOrEqual(3)
    expect(auditRows.some(r => r.outcome === 'failed')).toBe(true)

    // 7. Inpatient PCI stay with real synthetic_case_truth in DB leaks zero Case Truth (AC15)
    const stay = await fixture.preparePciAdmission([])
    insertFollowupClinicalFacts(fixture, stay.patientId, stay.admissionId)
    const inpatientScoreRes = await fixture.request('inpatient-doctor', '/api/his/v1/evaluation/agent-output-score', {
      draftFields: {
        assessment: 'LDL-C 1.25 mmol/L，LDL 已达标；肌酐 112 umol/L。',
        plan: '继续阿司匹林联合替格瑞洛双联抗血小板及阿托伐他汀。',
      },
      draftText: 'LDL 已达标，肌酐 112 umol/L，继续阿司匹林联合替格瑞洛双联抗血小板及阿托伐他汀。',
      mode: 'controlled-stream',
      rubric: followupRubric,
      subjectId: stay.admissionId,
      subjectKind: 'inpatient',
    })
    expect(inpatientScoreRes.status).toBe(200)
    const inpatientJson = await inpatientScoreRes.text()
    expect(inpatientJson).not.toMatch(/caseTruth|case_truth/i)
    const inpatientScore = agentOutputScoreResultSchema.parse(JSON.parse(inpatientJson))
    expect(inpatientScore.netScore).toBe(12)
    expect(prepared.modelCalls).toBe(0)
  })
})
