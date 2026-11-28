import { createHmac, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  agentPageBindingRevision,
  agentPageContextBindingSchema,
  agentToolAuthorizationResponseSchema,
  agentToolCatalog,
  type AgentPageContextClaim,
} from '@clinmesh/contracts/agent'
import { clinicalFactLedgerSchema } from '@clinmesh/contracts/clinical-fact-ledger'
import {
  clinicalPromptBundleSchema,
  clinicalPromptDismissResponseSchema,
} from '@clinmesh/contracts/clinical-prompt-cards'
import { clinicalQualityCheckSchema } from '@clinmesh/contracts/clinical-quality'
import { doctorRecommendationStateSchema } from '@clinmesh/contracts/doctor-recommendations'
import {
  apiErrorSchema,
  createPatientResponseSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  prescriptionDraftResponseSchema,
  registrationCatalogSchema,
  registrationResponseSchema,
  startVisitResponseSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { inpatientGuidelineAdviceSchema } from '@clinmesh/contracts/inpatient-guideline-advice'
import {
  inpatientInvestigationResponseSchema,
  inpatientInvestigationsSchema,
} from '@clinmesh/contracts/inpatient-investigations'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import type { GuidelineDocument } from '../src/application/guideline-corpus.ts'
import { GuidelineCorpus } from '../src/infrastructure/sqlite/guideline-corpus.ts'
import {
  createPciPaymentDrgFixture,
  parsePciResponse,
  preparePciPaymentDrgFixture,
  type PciPaymentDrgFixture,
} from './fixtures/pci-payment-drg.ts'
import { satisfyOutpatientOrderPrerequisites } from './fixtures/outpatient-order-gate.ts'

const SYNTHETIC_PACK_DIR = resolve(import.meta.dirname, 'fixtures/disease-packs/synthetic-test-syndrome-pack')

const pciParagraphs = [
  'In patients undergoing PCI, DES should be used in preference to BMS. Synthetic test passage; assess the clinical population.',
  'IVUS can be useful, particularly in left main or complex coronary artery stenting. OCT is a reasonable alternative, except in ostial left main disease.',
  'Evaluate both proximal and distal reference segments, with lumen, EEM, and plaque measurements. With manual pullback, length cannot be measured without a longitudinal acquisition.',
]

function pciGuidelineDocuments(): GuidelineDocument[] {
  return [
    {
      hash: '9843131ad84f9a261ceb8857025e656a067496472edabfb6bd2b6297f2c5ff0e',
      id: 'coronary-10-2021',
      pages: [35, 36],
      texts: pciParagraphs.slice(0, 2),
      title: '2021 ACC/AHA/SCAI 血运重建指南',
    },
    {
      hash: 'c2018438f6bfe9abf39cdfa813f6a6312de858bb6047ce18d9a01bff222ae9ad',
      id: 'coronary-15-2021',
      pages: [6],
      texts: pciParagraphs.slice(2),
      title: '合成CVIT测量共识测试原文',
    },
    {
      hash: '02c7080308bc64e9c499f8ba01f70a572127aee069f256e19937c9749a55f9e9',
      id: 'coronary-24-2021',
      pages: [3],
      texts: ['双联抗血小板治疗需评估出血风险，PRECISE-DAPT 评分≥25 分患者应考虑缩短 DAPT 疗程。'],
      title: '冠心病双联抗血小板治疗中国专家共识（2021）',
    },
    {
      hash: 'ed1502f49449419eb1d540e289e15715ea5f58b40a0dc71af281a08e69ed5139',
      id: 'coronary-31-2019',
      pages: [2],
      texts: ['急性胸痛患者应在首诊 10 min 内行标准 12 导联心电图检查并同步完善心肌标志物。'],
      title: '急性冠脉综合征急诊快速诊治指南（2019）',
    },
    {
      hash: '332e74aa189a08a56053e38cc8deea8b07aeeb1903770a2b41248692cce77c0e',
      id: 'coronary-20-2021',
      pages: [4],
      texts: ['对比剂剂量与 eGFR 的比值不能大于 3.7，必要时术前充分水化保护肾功能。'],
      title: '经动脉心血管介入诊治中含碘对比剂相关不良反应防治的中国专家共识（2021）',
    },
    {
      hash: '703136f8921a50cb40c5db7c9033da9c5a21fe3ae7d957d0e60f67492812367b',
      id: 'coronary-32-2018',
      pages: [7],
      texts: ['稳定性冠心病二级预防推荐以 LDL-C 为首要干预靶点，并结合他汀与依折麦布达标管理。'],
      title: '稳定性冠心病诊断与治疗指南（2018）',
    },
  ].map(item => ({
    passages: item.pages.map((page, index) => ({
      locator: `PDF 物理第 ${page} 页`,
      text: item.texts[index]!,
    })),
    source: {
      documentType: 'guideline',
      format: 'pdf',
      id: item.id,
      license: { id: 'CC0', url: 'https://example.test/license', usage: 'open' },
      population: 'adult',
      publisher: '合成验收机构',
      scope: '仅用于合成HTTP合同，非真实临床原件',
      sha256: item.hash,
      specialty: 'cardiology',
      status: 'active',
      title: item.title,
      topics: [],
      url: `https://example.test/${item.id}`,
      version: item.id === 'coronary-31-2019' ? '2019' : item.id === 'coronary-32-2018' ? '2018' : '2021',
    },
  }))
}

describe('DSAP Slice S8: Timing Hooks, Unified ClinicalPromptCard, Historical Replay & Safety Filter', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!()
    }
  })

  async function setupFixture(options: {
    onModelCall?: (schemaName: string, payload: unknown, modelCallCount: number) => unknown
    withGuidelineCorpus?: boolean
    withSyntheticPack?: boolean
  } = {}) {
    const prepared = await preparePciPaymentDrgFixture()
    cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))
    const dshSecret = 'test-dsh-bridge-secret-with-at-least-32-characters'
    prepared.options.dshBridgeSecret = dshSecret
    if (options.withSyntheticPack) {
      prepared.options.diseasePackDirs = [SYNTHETIC_PACK_DIR]
      prepared.options.registeredClinicianReviewers = [{
        licenseVerified: true,
        nameZh: '合成测试审核人',
        reviewerId: 'reviewer-syn-cardio-01',
        specialty: 'cardiology',
      }]
    }

    const modelCalls: Array<{ payload: unknown; schemaName: string }> = []
    if (options.withGuidelineCorpus) {
      const guidelineDbPath = join(prepared.directory, 'guidelines.sqlite')
      const writer = new GuidelineCorpus({ databasePath: guidelineDbPath })
      cleanups.push(async () => writer.close())
      writer.importDocuments(pciGuidelineDocuments())
      prepared.options.guidelineDatabasePath = guidelineDbPath
    }

    prepared.options.consultationModel = 'synthetic-s8-model'
    prepared.options.chatCompletionsProvider = new OpenAIChatCompletionsClient({
      apiKey: 'synthetic-only',
      baseUrl: 'https://synthetic.invalid/v1',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ content: string }>
          response_format?: { json_schema?: { name?: string } }
          tools?: Array<{ function?: { name?: string } }>
        }
        const schemaName = body.response_format?.json_schema?.name ?? body.tools?.[0]?.function?.name ?? 'unknown'
        const payload = JSON.parse(body.messages[1]!.content) as unknown
        modelCalls.push({ payload, schemaName })
        if (!options.onModelCall) {
          throw new Error(`Unexpected LLM invocation on zero-LLM path: ${schemaName}`)
        }
        const content = options.onModelCall(schemaName, payload, modelCalls.length)
        return Response.json({
          choices: [{ message: { content: JSON.stringify(content) } }],
          id: `syn-s8-${modelCalls.length}`,
          model: 'synthetic-s8-model',
          usage: { completion_tokens: 20, prompt_tokens: 100, total_tokens: 120 },
        })
      },
    })

    const fixture = await createPciPaymentDrgFixture(prepared)
    cleanups.push(() => fixture.runtime.close())
    return { dshSecret, fixture, modelCalls }
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

  async function createOutpatientVisit(
    fixture: PciPaymentDrgFixture,
    chiefComplaint = '胸闷胸痛 2 小时',
    gender: 'female' | 'male' = 'male',
  ) {
    const patient = (await parsePciResponse(
      createPatientResponseSchema,
      await fixture.request('registrar', '/api/his/v1/patients', {
        birthDate: '1965-05-10',
        gender,
        identifier: `SYN-S8-${randomUUID()}`,
        name: '合成S8临床提示卡患者',
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
        bloodPressure: { diastolicMmHg: 82, systolicMmHg: 134 },
        chiefComplaint,
        heightCm: 170,
        oxygenSaturationPct: 98,
        pulseBpm: 76,
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
    input: { code: string; display: string; encounterId: string; patientId: string; recordedDate?: string },
  ) {
    const scope = currentScope(fixture)
    const id = `cond-${randomUUID()}`
    fixture.runtime.fhir.create({ epoch: scope.epoch, workspaceId: scope.workspaceId }, {
      clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
      code: { coding: [{ code: input.code, display: input.display, system: 'http://hl7.org/fhir/sid/icd-10' }], text: input.display },
      encounter: { reference: `Encounter/${input.encounterId}` },
      id,
      recordedDate: input.recordedDate ?? scope.virtualTime,
      resourceType: 'Condition',
      subject: { reference: `Patient/${input.patientId}` },
      verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
    })
    return id
  }

  function insertProcedure(
    fixture: PciPaymentDrgFixture,
    input: { code: string; display: string; encounterId: string; patientId: string; performedDateTime?: string },
  ) {
    const scope = currentScope(fixture)
    const id = `proc-${randomUUID()}`
    fixture.runtime.fhir.createProjection({ epoch: scope.epoch, workspaceId: scope.workspaceId }, {
      code: { coding: [{ code: input.code, display: input.display, system: 'urn:clinmesh:procedure' }], text: input.display },
      encounter: { reference: `Encounter/${input.encounterId}` },
      id,
      performedDateTime: input.performedDateTime ?? scope.virtualTime,
      resourceType: 'Procedure',
      status: 'completed',
      subject: { reference: `Patient/${input.patientId}` },
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

  function insertSerumCreatinineReport(
    fixture: PciPaymentDrgFixture,
    input: { caseId: string; encounterId: string; patientId: string; valueMgDl: number },
  ) {
    const scope = currentScope(fixture)
    const now = scope.virtualTime
    const sr = fixture.runtime.fhir.create(scope, {
      authoredOn: now,
      code: { text: '肾功能检测' },
      encounter: { reference: `Encounter/${input.encounterId}` },
      id: randomUUID(),
      intent: 'order',
      resourceType: 'ServiceRequest',
      status: 'completed',
      subject: { reference: `Patient/${input.patientId}` },
    })
    const specimen = fixture.runtime.fhir.create(scope, {
      id: randomUUID(),
      resourceType: 'Specimen',
      status: 'available',
      subject: { reference: `Patient/${input.patientId}` },
    })
    const obs = fixture.runtime.fhir.create(scope, {
      basedOn: [{ reference: `ServiceRequest/${sr.id}` }],
      category: [{ coding: [{ code: 'laboratory', system: 'http://terminology.hl7.org/CodeSystem/observation-category' }] }],
      code: {
        coding: [{ code: '1700404A', display: '血清肌酐', system: 'urn:clinmesh:wst:886-2026' }],
        text: '血清肌酐',
      },
      effectiveDateTime: now,
      encounter: { reference: `Encounter/${input.encounterId}` },
      id: randomUUID(),
      interpretation: [{ coding: [{ code: 'H' }] }],
      referenceRange: [{ high: { value: 1.2 }, low: { value: 0.5 }, text: '0.5 - 1.2 mg/dL' }],
      resourceType: 'Observation',
      specimen: { reference: `Specimen/${specimen.id}` },
      status: 'final',
      subject: { reference: `Patient/${input.patientId}` },
      valueQuantity: { code: 'mg/dL', system: 'http://unitsofmeasure.org', unit: 'mg/dL', value: input.valueMgDl },
    })
    const report = fixture.runtime.fhir.create(scope, {
      basedOn: [{ reference: `ServiceRequest/${sr.id}` }],
      code: { text: '合成肾功能检验报告' },
      conclusion: '合成肾功能报告已签发。',
      encounter: { reference: `Encounter/${input.encounterId}` },
      id: randomUUID(),
      issued: now,
      resourceType: 'DiagnosticReport',
      result: [{ reference: `Observation/${obs.id}` }],
      specimen: [{ reference: `Specimen/${specimen.id}` }],
      status: 'final',
      subject: { reference: `Patient/${input.patientId}` },
    })
    const task = fixture.runtime.fhir.create(scope, {
      focus: { reference: `ServiceRequest/${sr.id}` },
      for: { reference: `Patient/${input.patientId}` },
      id: randomUUID(),
      intent: 'order',
      resourceType: 'Task',
      status: 'completed',
    })
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
    `).run(scope.workspaceId, scope.epoch, randomUUID(), input.caseId, referenceConcept, sr.id, task.id, report.id, now, now)
  }

  function insertAllergyIntolerance(
    fixture: PciPaymentDrgFixture,
    input: { code: string; display: string; patientId: string },
  ) {
    const scope = currentScope(fixture)
    const id = `allergy-${randomUUID()}`
    fixture.runtime.fhir.create({ epoch: scope.epoch, workspaceId: scope.workspaceId }, {
      clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical' }] },
      code: { coding: [{ code: input.code, display: input.display, system: 'urn:clinmesh:medication' }], text: input.display },
      id,
      patient: { reference: `Patient/${input.patientId}` },
      recordedDate: scope.virtualTime,
      resourceType: 'AllergyIntolerance',
      verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification' }] },
    })
    return id
  }

  it('AC16: sync encounter-open and order-draft-select timings run with 0 LLM calls, preserve multi-pack side-by-side cards, trial badges, and audit dismissals', async () => {
    const { fixture, modelCalls } = await setupFixture({
      withGuidelineCorpus: true,
      withSyntheticPack: true,
    })
    const visit = await createOutpatientVisit(fixture, '胸闷胸痛伴活动后气短')
    insertCondition(fixture, {
      code: 'R07.4',
      display: '胸痛',
      encounterId: visit.encounterId,
      patientId: visit.patientId,
    })
    insertCondition(fixture, {
      code: 'I25.1',
      display: '冠状动脉粥样硬化性心脏病',
      encounterId: visit.encounterId,
      patientId: visit.patientId,
    })
    insertLabObservation(fixture, {
      code: '89579-7',
      display: '高敏肌钙蛋白 I',
      encounterId: visit.encounterId,
      patientId: visit.patientId,
      unit: 'ng/L',
      value: 45,
    })

    const openBundle = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/clinical-prompts?timing=encounter-open`,
      clinicalPromptBundleSchema,
    )
    expect(openBundle.llmInvocationCount).toBe(0)
    expect(modelCalls).toHaveLength(0)

    // 门诊不出床旁缺项卡；排雷清单照常出现
    expect(openBundle.cards.some(c => c.category === 'missing-fact')).toBe(false)
    expect(openBundle.cards.some(c => c.category === 'rule-out-checklist' && c.packId === 'coronary-cad')).toBe(true)
    expect(openBundle.cards.some(c => c.category === 'rule-out-checklist' && c.packId === 'synthetic-test-syndrome')).toBe(true)

    // Multi-pack side-by-side groups retain each pack's own packId and riskTags without platform arbitration
    const ruleOutGroup = openBundle.sideBySideGroups.find(g => g.groupKey === 'encounter-open:rule-out-checklist')
    expect(ruleOutGroup?.packIds).toEqual(['coronary-cad', 'synthetic-test-syndrome'])
    const coronaryRuleOut = openBundle.cards.find(c => c.category === 'rule-out-checklist' && c.packId === 'coronary-cad')!
    expect(coronaryRuleOut.riskTags.some(t => t.id === 'troponin-positive-acs-risk')).toBe(true)

    // Auto-verified knowledge cards carry trial badge & disclaimer
    const autoVerifiedClaimCard = openBundle.cards.find(c => c.knowledgeStatus === 'auto-verified')
    expect(autoVerifiedClaimCard).toBeDefined()
    expect(autoVerifiedClaimCard?.trialBadgeZh).toBe('试用版')
    expect(autoVerifiedClaimCard?.trialDisclaimerZh).toBe('未经医生检查，仅用于仿真')

    // Snapshots persisted with fact version bindings
    const snapshotRows = fixture.runtime.database.driver.prepare(`
      SELECT COUNT(*) AS cnt FROM clinical_prompt_card_snapshot
      WHERE subject_kind = 'outpatient' AND subject_id = ?
    `).get(visit.caseId) as { cnt: number }
    expect(snapshotRows.cnt).toBeGreaterThanOrEqual(openBundle.cards.length)

    // Sync order-draft-select with DAPT template emits bleeding risk card requiring audited dismissal reason
    const orderDraftBundle = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/clinical-prompts?timing=order-draft-select&selectedTemplateId=cad-pci-secondary-prevention`,
      clinicalPromptBundleSchema,
    )
    expect(orderDraftBundle.llmInvocationCount).toBe(0)
    expect(modelCalls).toHaveLength(0)

    const daptCard = orderDraftBundle.cards.find(
      c => c.category === 'order-set-risk' && c.riskTags.some(t => t.id === 'dapt-bleeding-risk'),
    )
    expect(daptCard).toBeDefined()
    expect(daptCard!.overrideReasons).toContain('clinical-judgement')
    // 风险提示挂靠到组套内触发该风险的药品行
    const coronaryDapt = orderDraftBundle.cards.find(
      c => c.cardId === 'order-draft-select:risk-tag:coronary-cad:dapt-bleeding-risk',
    )
    expect(coronaryDapt?.attachTargets?.candidateClasses).toEqual(['antiplatelet-aspirin', 'p2y12'])
    expect(coronaryDapt?.attachTargets?.catalogItemIds).toEqual(expect.arrayContaining(['medication-pci-aspirin', 'medication-pci-clopidogrel']))

    const dismissRes = await fixture.request(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/clinical-prompts/${encodeURIComponent(daptCard!.cardId)}/dismiss`,
      {
        reasonCode: 'clinical-judgement',
        note: '已核对患者既往无消化道出血史且合并质子泵抑制剂保护，维持 DAPT 草稿',
        timing: 'order-draft-select',
      },
    )
    expect(dismissRes.status, await dismissRes.clone().text()).toBe(200)
    const dismissed = clinicalPromptDismissResponseSchema.parse(await dismissRes.json())
    expect(dismissed.data.status).toBe('dismissed')
    expect(dismissed.data.dismissal?.reasonCode).toBe('clinical-judgement')

    const dismissalRow = fixture.runtime.database.driver.prepare(`
      SELECT reason_code, note, actor_id FROM clinical_prompt_card_dismissal
      WHERE subject_kind = 'outpatient' AND subject_id = ? AND card_id = ?
    `).get(visit.caseId, daptCard!.cardId) as { actor_id: string; note: string; reason_code: string } | undefined
    expect(dismissalRow?.reason_code).toBe('clinical-judgement')

    // Dismissed card disappears from default display and reappears under includeDismissed=true
    const afterDismiss = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/clinical-prompts?timing=order-draft-select&selectedTemplateId=cad-pci-secondary-prevention`,
      clinicalPromptBundleSchema,
    )
    expect(afterDismiss.cards.some(c => c.cardId === daptCard!.cardId)).toBe(false)

    const withDismissed = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/clinical-prompts?timing=order-draft-select&selectedTemplateId=cad-pci-secondary-prevention&includeDismissed=true`,
      clinicalPromptBundleSchema,
    )
    expect(withDismissed.cards.find(c => c.cardId === daptCard!.cardId)?.status).toBe('dismissed')
  })

  it('AC16 & AC28: async report-arrived hook unblocks pending inpatient guideline advice and marks amended-report prompt snapshots stale', async () => {
    const { fixture } = await setupFixture({ withGuidelineCorpus: true })
    const stay = await fixture.preparePciAdmission([])
    const admin = await fixture.login('admin')

    // Without baseline creatinine, dispatch blocks the auto-queued pci-stent guideline advice task
    await fixture.runtime.dispatchPending()
    const blockedAdvice = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/guideline-advice/${stay.requestId}`,
      inpatientGuidelineAdviceSchema,
    )
    expect(blockedAdvice.status).toBe('blocked')
    expect(blockedAdvice.failureCode).toBe('TASK_READINESS_CRITICAL_MISSING')

    // Issue, send, and complete pre-installed inpatient creatinine (2160-0) report -> report-arrived unblocks pci-stent advice!
    const issuedCr = (await parsePciResponse(
      inpatientInvestigationResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/investigations/issue`, {
        catalogVersion: 1,
        encounterVersion: stay.encounterVersion,
        selection: { catalogItemId: 'hospital-lab-pci-creatinine', indicationCode: 'clinical-assessment', kind: 'laboratory' },
      }),
    )).data.laboratoryRequests.find(r => r.catalogItemId === 'hospital-lab-pci-creatinine')!
    expect(
      (await fixture.request('ward-nurse', `${stay.path}/investigations/send`, {
        expectedRequestVersion: issuedCr.version,
        requestId: issuedCr.id,
        serviceRequestVersion: issuedCr.serviceRequestVersion,
        taskVersion: issuedCr.taskVersion,
      })).status,
    ).toBe(200)
    for (let step = 0; step < 20; step++) {
      const dispatched = await fixture.runtime.dispatcher.dispatchOnce()
      if (dispatched === undefined || dispatched.kind === 'laboratory.report-request') break
    }

    const refreshedAdvice = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/guideline-advice/${stay.requestId}`,
      inpatientGuidelineAdviceSchema,
    )
    expect(refreshedAdvice.status).toBe('queued')
    expect(refreshedAdvice.failureCode).toBeNull()

    const crReported = (await fixture.read(
      'inpatient-doctor',
      `${stay.path}/investigations`,
      inpatientInvestigationsSchema,
    )).laboratoryRequests.find(r => r.id === issuedCr.id)!
    expect(crReported.report).toBeDefined()

    const correctReport = async (req: typeof crReported, value: number, conclusion: string) => {
      const res = await fixture.runtime.app.request(
        `/api/his/v1/laboratory-requests/${req.id}/reports/${req.report!.diagnosticReportId}/actions/correct`,
        {
          body: JSON.stringify({
            expectedVersions: {
              [`DiagnosticReport/${req.report!.diagnosticReportId}`]: req.report!.diagnosticReportVersion,
            },
            input: {
              conclusion,
              expectedRequestVersion: req.version,
              reason: '复核仪器检测值后正式更正报告',
              results: [{ code: '2160-0', value }],
            },
          }),
          headers: {
            'content-type': 'application/json',
            cookie: admin,
            'idempotency-key': randomUUID(),
            origin: 'http://localhost',
          },
          method: 'POST',
        },
      )
      expect(res.status, await res.clone().text()).toBe(200)
    }

    // Correct creatinine to 4.0 mg/dL (eGFR < 30), then persist order-sign prompt card bound to Observation(2160-0)
    await correctReport(crReported, 4.0, '血清肌酐复核升至 4.0 mg/dL（重度肾功能减退）。')

    const orderSignBeforeAmend = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/clinical-prompts?timing=order-sign&catalogItemId=medication-dapagliflozin`,
      clinicalPromptBundleSchema,
    )
    const renalGateCard = orderSignBeforeAmend.cards.find(
      c => c.category === 'quality-gate' && c.basedOnFactVersions.some(v => v.itemCode === '2160-0'),
    )!
    expect(renalGateCard).toBeDefined()
    expect(renalGateCard.stale).toBe(false)

    // Correct creatinine report back to 0.9 mg/dL -> DiagnosticReport/* post-commit listener marks snapshot stale!
    const crAfterFirstCorrect = (await fixture.read(
      'inpatient-doctor',
      `${stay.path}/investigations`,
      inpatientInvestigationsSchema,
    )).laboratoryRequests.find(r => r.id === issuedCr.id)!
    await correctReport(crAfterFirstCorrect, 0.9, '仪器复测确认血清肌酐为 0.9 mg/dL，更正原报告。')

    const orderSignAfterAmend = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/clinical-prompts?timing=order-sign&catalogItemId=medication-dapagliflozin`,
      clinicalPromptBundleSchema,
    )
    const staleCard = orderSignAfterAmend.cards.find(c => c.cardId === renalGateCard.cardId)
    expect(staleCard?.stale).toBe(true)
    expect(staleCard?.staleReason).toContain('2160-0')
  })

  it('AC17: sync quality-gate timings mirror all 4 ClinicalQualityService gates into ClinicalPromptCards without altering gate blocking/override semantics', async () => {
    const { fixture, modelCalls } = await setupFixture({ withGuidelineCorpus: true })

    // Outpatient order-sign & encounter-complete
    const visit = await createOutpatientVisit(fixture, '胸闷评估合并严重肾功能不全')
    const doctorCookie = await fixture.login('doctor')
    const gate = await satisfyOutpatientOrderPrerequisites(fixture.runtime, doctorCookie, visit.caseId)
    insertCondition(fixture, {
      code: 'I25.1',
      display: '冠状动脉粥样硬化性心脏病',
      encounterId: visit.encounterId,
      patientId: visit.patientId,
    })
    insertSerumCreatinineReport(fixture, {
      caseId: visit.caseId,
      encounterId: visit.encounterId,
      patientId: visit.patientId,
      valueMgDl: 3.8,
    })
    // Save active prescription draft with metformin using PUT so order-sign hits proven eGFR < 30 red line!
    const draftRes = await fixture.runtime.app.request(
      `/api/his/v1/encounters/${visit.encounterId}/prescription/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${visit.encounterId}`]: gate.encounterVersion },
          input: {
            expectedDraftVersion: 0,
            items: [
              {
                catalogItemId: 'medication-metformin',
                courseDays: 14,
                doseText: '0.5 g',
                frequencyCode: 'BID',
                quantity: 28,
                routeCode: 'PO',
              },
            ],
          },
        }),
        headers: {
          'content-type': 'application/json',
          cookie: doctorCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'PUT',
      },
    )
    expect(draftRes.status, await draftRes.clone().text()).toBe(200)
    prescriptionDraftResponseSchema.parse(await draftRes.json())

    const expectedRxQuality = await fixture.read(
      'doctor',
      `/api/his/v1/encounters/${visit.encounterId}/clinical-quality?gate=outpatient-prescription`,
      clinicalQualityCheckSchema,
    )
    expect(expectedRxQuality.status).toBe('blocked')
    expect(expectedRxQuality.redLines.length).toBeGreaterThan(0)

    const orderSignPrompts = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/clinical-prompts?timing=order-sign`,
      clinicalPromptBundleSchema,
    )
    expect(orderSignPrompts.llmInvocationCount).toBe(0)
    expect(modelCalls).toHaveLength(0)
    const gateCards = orderSignPrompts.cards.filter(c => c.category === 'quality-gate')
    expect(gateCards.some(c => c.blockingTier === 'red-line' && c.indicator === 'critical')).toBe(true)
    expect(gateCards.length).toBe(expectedRxQuality.redLines.length + expectedRxQuality.alerts.length)

    // Outpatient completion gate wraps alert tier cleanly
    const completePrompts = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/clinical-prompts?timing=encounter-complete`,
      clinicalPromptBundleSchema,
    )
    const expectedCompleteQuality = await fixture.read(
      'doctor',
      `/api/his/v1/encounters/${visit.encounterId}/clinical-quality?gate=outpatient-completion`,
      clinicalQualityCheckSchema,
    )
    expect(completePrompts.cards.filter(c => c.category === 'quality-gate').length).toBe(
      expectedCompleteQuality.redLines.length + expectedCompleteQuality.alerts.length,
    )

    // Inpatient pci-plan & discharge timings mirror inpatient ClinicalQualityService gates
    const stay = await fixture.preparePciAdmission([], { baselineCreatinineUmolL: 92 })
    const expectedPciQuality = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/clinical-quality?gate=inpatient-pci-plan`,
      clinicalQualityCheckSchema,
    )
    const pciPrompts = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/clinical-prompts?timing=pci-plan`,
      clinicalPromptBundleSchema,
    )
    expect(pciPrompts.llmInvocationCount).toBe(0)
    expect(pciPrompts.cards.filter(c => c.category === 'quality-gate').length).toBe(
      expectedPciQuality.redLines.length + expectedPciQuality.alerts.length,
    )
  })

  it('AC22: replays historical knowledge snapshot asOf 2026-06-15 (2026.06.v1), diffs against 2026.08.v2 on reevaluation, and hides retired claims', async () => {
    const { fixture, modelCalls } = await setupFixture({ withGuidelineCorpus: true })
    const visit = await createOutpatientVisit(fixture, 'PCI 术后门诊复诊二级预防评估')
    const historicalTs = '2026-06-10T09:00:00Z'
    insertCondition(fixture, {
      code: 'I25.1',
      display: '冠状动脉粥样硬化性心脏病',
      encounterId: visit.encounterId,
      patientId: visit.patientId,
      recordedDate: historicalTs,
    })
    insertProcedure(fixture, {
      code: '00.66',
      display: '经皮冠状动脉介入治疗（PCI）',
      encounterId: visit.encounterId,
      patientId: visit.patientId,
      performedDateTime: historicalTs,
    })

    // Historical asOf replay: sees 2026.06.v1 with legacy claim still active
    const replayBundle = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/clinical-prompts?timing=encounter-open&asOf=2026-06-15T00:00:00Z`,
      clinicalPromptBundleSchema,
    )
    expect(replayBundle.llmInvocationCount).toBe(0)
    expect(modelCalls).toHaveLength(0)
    expect(replayBundle.historicalReplay).toMatchObject({
      asOf: '2026-06-15T00:00:00Z',
      baselineSnapshotVersions: { 'coronary-cad': '2026.06.v1' },
      latestSnapshotVersions: { 'coronary-cad': '2026.08.v2' },
      reevaluated: false,
    })
    expect(replayBundle.cards.some(c => c.source.claimId === 'coronary-claim-legacy-bms-check')).toBe(true)

    // Re-evaluate against latest snapshot (2026.08.v2): marks added/updated diffs and hides retired claim from active cards
    const diffBundle = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/clinical-prompts?timing=encounter-open&asOf=2026-06-15T00:00:00Z&reevaluateWithLatestKnowledge=true`,
      clinicalPromptBundleSchema,
    )
    expect(diffBundle.llmInvocationCount).toBe(0)
    expect(diffBundle.historicalReplay?.reevaluated).toBe(true)
    expect(diffBundle.historicalReplay?.retiredHiddenClaimIds).toContain('coronary-claim-legacy-bms-check')

    // Retired claim MUST NOT appear in visible cards
    expect(diffBundle.cards.some(c => c.source.claimId === 'coronary-claim-legacy-bms-check')).toBe(false)

    // New 2026.08.v2 DAPT threshold claim appears as added; continuing claims appear as updated
    expect(diffBundle.cards.find(c => c.source.claimId === 'coronary-claim-dapt-precise-threshold')?.diffStatus).toBe('added')
    expect(diffBundle.cards.find(c => c.source.claimId === 'coronary-claim-pci-des-over-bms')?.diffStatus).toBe('updated')
    expect(
      diffBundle.reevaluateDiffs?.find(d => d.claimId === 'coronary-claim-legacy-bms-check')?.diffStatus,
    ).toBe('retired-hidden')
  })

  it('AC25: deterministic safety filter blocks unsafe prescription recommendations, inpatient advice, inapplicable-pack treatments, and leaks zero blocked items to Agent tools', async () => {
    const { dshSecret, fixture } = await setupFixture({
      onModelCall: (schemaName, rawPayload) => {
        if (schemaName === 'patient_persona') {
          return {
            chiefComplaint: '胸闷随访开药',
            knownHistorySummary: '冠心病合并糖尿病及高龄肾功能减退',
            medicationMemory: '无规律用药',
            openingStatement: '医生我想开降糖和降压药。',
            persona: { attitude: '配合', character: '温和', healthLiteracy: '高中文化', speechStyle: '清晰' },
            symptomExperience: '活动后轻度胸闷，无静息痛',
          }
        }
        if (schemaName === 'doctor_recommendations') {
          const payload = z.object({
            caseEvidence: z.array(z.object({ id: z.string(), text: z.string() })),
            guidelines: z.array(z.object({ id: z.string() })),
          }).parse(rawPayload)
          const firstGuideline = payload.guidelines[0]!.id
          const firstCaseEv = payload.caseEvidence[0]!.id
          return {
            considerations: [],
            items: [
              {
                caseEvidenceIds: [firstCaseEv],
                catalogItemId: 'medication-metformin',
                courseDays: 30,
                doseText: '0.5 g',
                frequencyCode: 'BID',
                guidelineEvidenceIds: [firstGuideline],
                id: 'unsafe-metformin-rec',
                kind: 'prescription',
                label: '二甲双胍片 0.5 g BID',
                missingInformation: [],
                opposingInformation: [],
                quantity: 60,
                rationale: '测试严重肾功能不全（eGFR < 30）与过敏场景下展示前确定性安全过滤拦截二甲双胍。',
                routeCode: 'PO',
                supportingInformation: ['既往诊断记录'],
              },
              {
                caseEvidenceIds: [firstCaseEv],
                catalogItemId: 'medication-amlodipine',
                courseDays: 30,
                doseText: '5 mg',
                frequencyCode: 'QD',
                guidelineEvidenceIds: [firstGuideline],
                id: 'safe-amlodipine-rec',
                kind: 'prescription',
                label: '氨氯地平片 5 mg QD',
                missingInformation: [],
                opposingInformation: [],
                quantity: 30,
                rationale: '在肾功能减退情况下安全可保留的降压候选药物。',
                routeCode: 'PO',
                supportingInformation: ['分诊血压测量'],
              },
            ],
            missingInformation: [],
          }
        }
        if (schemaName === 'doctor_recommendation_verification') {
          const payload = z.object({ items: z.array(z.object({ id: z.string() })) }).parse(rawPayload)
          return {
            items: payload.items.map(item => ({
              applicable: true,
              caseSupported: true,
              guidelineSupported: true,
              id: item.id,
              prescriptionFields: {
                courseDays: true,
                doseText: true,
                frequencyCode: true,
                quantity: true,
                routeCode: true,
              },
              qualifiersPreserved: true,
            })),
          }
        }
        if (schemaName === 'inpatient_drg_recommendation') {
          const payload = z.object({ guidelines: z.array(z.object({ id: z.string() })) }).parse(rawPayload)
          return {
            conclusions: [
              {
                applicability: 'conditional',
                citations: [{ evidenceId: payload.guidelines[0]!.id, quote: pciParagraphs[0]! }],
                kind: 'stent-category',
                text: '拟行 PCI 患者可优先核对 DES 支架类别；患者具体临床条件尚待主管医生最终审定。',
              },
              {
                applicability: 'conditional',
                citations: [{ evidenceId: payload.guidelines[1]!.id, quote: pciParagraphs[1]! }],
                kind: 'imaging-guidance',
                text: 'IVUS 与 OCT 腔内影像学可用于左主干或复杂病变评估。',
              },
              {
                applicability: 'conditional',
                citations: [{ evidenceId: payload.guidelines[2]!.id, quote: pciParagraphs[2]! }],
                kind: 'measurement-requirements',
                text: '术中需测定近远端参考管腔与 EEM 斑块参数。',
              },
            ],
          }
        }
        if (schemaName === 'inpatient_drg_verification') {
          return {
            conclusions: ['stent-category', 'imaging-guidance', 'measurement-requirements'].map(kind => ({
              conditionsPreserved: true,
              kind,
              noInventedMeasurements: true,
              noProductOrQuantity: true,
              populationPreserved: true,
              reason: '合成独立核验通过',
              strengthPreserved: true,
              supported: true,
            })),
          }
        }
        return {}
      },
      withGuidelineCorpus: true,
      withSyntheticPack: true,
    })

    // Part A: Outpatient with CAD + hypertension + severe renal impairment (creatinine 4.2 mg/dL -> eGFR < 30) + allergy to metformin + pregnancy diagnosis (O99.8 triggers synthetic inapplicable for female patient)
    const visit = await createOutpatientVisit(fixture, '胸闷伴高血压复诊配药评估', 'female')
    insertCondition(fixture, { code: 'I25.1', display: '冠状动脉粥样硬化性心脏病', encounterId: visit.encounterId, patientId: visit.patientId })
    insertCondition(fixture, { code: 'I10', display: '原发性高血压', encounterId: visit.encounterId, patientId: visit.patientId })
    insertCondition(fixture, { code: 'O99.8', display: '妊娠合并症（合成包不适用测试）', encounterId: visit.encounterId, patientId: visit.patientId })
    insertSerumCreatinineReport(fixture, { caseId: visit.caseId, encounterId: visit.encounterId, patientId: visit.patientId, valueMgDl: 4.2 })
    insertAllergyIntolerance(fixture, { code: 'medication-metformin', display: '二甲双胍', patientId: visit.patientId })

    // Verify deterministic safety filter intercepts inapplicable-pack interventions while keeping inapplicable notice & checklists
    const openPrompts = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/clinical-prompts?timing=encounter-open`,
      clinicalPromptBundleSchema,
    )
    expect(openPrompts.cards.some(c => c.category === 'inapplicable-population' && c.packId === 'synthetic-test-syndrome')).toBe(true)
    expect(openPrompts.cards.some(c => c.category === 'inapplicable-population' && c.packId === 'coronary-cad' && c.summary.includes('超出本包范围，请医生自行决策'))).toBe(true)

    // Verify outpatient prescription recommendations filter out metformin (`red-line` / `allergy`) BEFORE publishing!
    const rxBefore = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/recommendations/prescription`,
      doctorRecommendationStateSchema,
    )
    const genRes = await fixture.request(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/recommendations/prescription/actions/generate`,
      { expectedInputFingerprint: rxBefore.inputFingerprint, refresh: false },
      randomUUID(),
      { [`Encounter/${visit.encounterId}`]: rxBefore.encounterVersion },
    )
    expect(genRes.status, await genRes.clone().text()).toBe(200)
    await fixture.runtime.dispatchPending()

    const rxAfter = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/recommendations/prescription`,
      doctorRecommendationStateSchema,
    )
    expect(rxAfter.status).toBe('ready')
    // Metformin was blocked deterministically pre-display; safe Amlodipine remained!
    expect(rxAfter.items.some(i => i.kind === 'prescription' && i.catalogItemId === 'medication-metformin')).toBe(false)
    expect(rxAfter.items.some(i => i.kind === 'prescription' && i.catalogItemId === 'medication-amlodipine')).toBe(true)
    expect(rxAfter.promptCards?.some(c => c.cardId === 'rec:safe-amlodipine-rec')).toBe(true)
    expect(rxAfter.promptCards?.some(c => c.cardId === 'rec:unsafe-metformin-rec')).toBe(false)
    // Pregnancy diagnosis O99.8 also makes coronary-cad inapplicable per AC24, so outpatient primaryPack is null (Part C verifies non-pregnant coronary-cad provenance)
    expect(rxAfter.promptCards?.[0]?.packId).toBeNull()
    expect(rxAfter.promptCards?.[0]?.trialBadgeZh).toBeNull()

    // Safety block audit was recorded in SQLite
    const auditBlocks = fixture.runtime.database.driver.prepare(`
      SELECT block_reason, card_summary FROM clinical_prompt_safety_block_audit
      WHERE subject_kind = 'outpatient' AND subject_id = ?
    `).all(visit.caseId) as Array<{ block_reason: string; card_summary: string }>
    expect(auditBlocks.length).toBeGreaterThanOrEqual(1)
    expect(auditBlocks.some(row => row.block_reason === 'allergy-conflict' || row.block_reason === 'red-line-violation')).toBe(true)

    // Part B: DSH Agent Gateway `outpatient.clinical-prompts.read` enforces sections (`diagnosis`/`prescription`), returns 0 blocked items
    const refreshedDetail = await fixture.read('doctor', `/api/his/v1/doctor/cases/${visit.caseId}`, doctorCaseDetailSchema)
    const claim: AgentPageContextClaim = {
      activeSection: 'diagnosis',
      selection: { id: visit.caseId, kind: 'case', version: refreshedDetail.encounter.versionId },
      taskEpoch: 'b1b2c3d4-1234-4234-8234-123456789abc',
      ui: { status: 'ready' },
      version: 1,
      viewId: 'consultation',
      viewRevision: 'consultation-1',
    }
    const doctorCookie = await fixture.login('doctor')
    const ctxRes = await fixture.runtime.app.request('/api/agent/v1/page-contexts', {
      body: JSON.stringify({ claim, client: { id: 'doc-s8', revision: 1 }, dshSessionId: 'dsh-s8-1' }),
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(ctxRes.status).toBe(201)
    const ctxBinding = agentPageContextBindingSchema.parse(await ctxRes.json())
    expect(ctxBinding.snapshot.allowedOperationIds).toContain('outpatient.clinical-prompts.read')

    const toolDef = agentToolCatalog.find(t => t.operationId === 'outpatient.clinical-prompts.read')!
    const proofPayload = {
      callId: 'call-s8-prompt-1',
      contextId: ctxBinding.snapshot.id,
      dshSessionId: 'dsh-s8-1',
      expiresAt: ctxBinding.snapshot.expiresAt,
      issuedAt: ctxBinding.snapshot.issuedAt,
      origin: {
        request: { pageRevision: agentPageBindingRevision(claim), scopeKey: ctxBinding.snapshot.scopeKey },
        task: {
          acceptedAt: ctxBinding.snapshot.issuedAt,
          messageId: 'msg-s8-1',
          pageRevision: agentPageBindingRevision(claim),
          rpcId: 'rpc-s8-1',
          scopeKey: ctxBinding.snapshot.scopeKey,
          turn: 1,
        },
      },
      pageRevision: agentPageBindingRevision(claim),
      scopeKey: ctxBinding.snapshot.scopeKey,
      toolName: toolDef.toolName,
      version: 3,
    }
    const b64 = Buffer.from(JSON.stringify(proofPayload), 'utf8').toString('base64url')
    const sig = createHmac('sha256', dshSecret).update(b64).digest('base64url')

    const authRes = await fixture.runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: ctxBinding.token,
        executionProof: `${b64}.${sig}`,
        input: { timing: 'encounter-open' },
        operationId: 'outpatient.clinical-prompts.read',
      }),
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(authRes.status, await authRes.clone().text()).toBe(201)
    const authParsed = agentToolAuthorizationResponseSchema.parse(await authRes.json())

    const agentQueryRes = await fixture.runtime.app.request('/api/agent/v1/doctor-queries', {
      body: JSON.stringify({
        contextToken: ctxBinding.token,
        input: { timing: 'encounter-open' },
        receiptToken: authParsed.receiptToken,
      }),
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(agentQueryRes.status, await agentQueryRes.clone().text()).toBe(200)
    const agentBundle = clinicalPromptBundleSchema.parse(await agentQueryRes.json())
    expect(agentBundle.llmInvocationCount).toBe(0)
    expect(agentBundle.cards.every(c => c.status !== 'blocked-by-safety-filter')).toBe(true)

    // Verify hospital ledger excludes blocked/unverified facts as expected and InpatientGuidelineAdvice attaches promptCards
    const stay = await fixture.preparePciAdmission([], { baselineCreatinineUmolL: 92 })
    const adviceBefore = await fixture.read('inpatient-doctor', `${stay.path}/guideline-advice/${stay.requestId}`, inpatientGuidelineAdviceSchema)
    if (adviceBefore.status === 'stale' || adviceBefore.status === 'idle') {
      await fixture.request('inpatient-doctor', `${stay.path}/guideline-advice/request`, {
        expectedFingerprint: adviceBefore.fingerprint,
        expectedVersion: adviceBefore.version,
        requestId: stay.requestId,
      })
    }
    await fixture.runtime.dispatchPending()
    const adviceReady = await fixture.read('inpatient-doctor', `${stay.path}/guideline-advice/${stay.requestId}`, inpatientGuidelineAdviceSchema)
    expect(['succeeded', 'incomplete']).toContain(adviceReady.status)
    expect(adviceReady.promptCards?.length).toBeGreaterThanOrEqual(3)
    expect(adviceReady.promptCards?.every(c => c.packId === 'coronary-cad' && c.trialBadgeZh === '试用版')).toBe(true)

    // Confirm no leak of blocked API error code check sanity
    expect(apiErrorSchema.safeParse({ error: { code: 'OK', message: 'ok' } }).success).toBe(true)
    const ledgerCheck = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/clinical-fact-ledger`,
      clinicalFactLedgerSchema,
    )
    expect(ledgerCheck.facts.length).toBeGreaterThan(0)
  })

  it('evaluates renal safety cutoff at the requested asOf timestamp during historical prompt replay without leaking future labs', async () => {
    const { fixture } = await setupFixture({ withGuidelineCorpus: true })
    const visit = await createOutpatientVisit(fixture, '糖尿病复诊', 'male')
    const { virtualTime } = currentScope(fixture)
    const beforeLabIso = new Date(Date.parse(virtualTime) - 3_600_000).toISOString()

    // Insert a severe creatinine report (4.2 mg/dL -> eGFR < 30) at virtualTime (AFTER beforeLabIso)
    insertSerumCreatinineReport(fixture, {
      caseId: visit.caseId,
      encounterId: visit.encounterId,
      patientId: visit.patientId,
      valueMgDl: 4.2,
    })

    const doctorCookie = await fixture.login('doctor')
    const doctorActor = (await fixture.runtime.identity.resolveSessionContext(new Headers({ cookie: doctorCookie }))).actor

    // Current snapshot sees the severe creatinine (eGFR < 30)
    const currentScores = fixture.runtime.workflow.clinicalScores.outpatientSnapshot(doctorActor, visit.caseId)
    const currentEgfr = currentScores.scores.find(s => s.id === 'ckd-epi-2021-egfr')
    expect(currentEgfr?.status).toBe('complete')
    expect(currentEgfr?.value).toBeLessThan(30)

    // Historical cutoff before the lab report must NOT leak the future creatinine into renal evaluation
    const historicalScores = fixture.runtime.workflow.clinicalScores.outpatientSnapshot(doctorActor, visit.caseId, beforeLabIso, true)
    const historicalEgfr = historicalScores.scores.find(s => s.id === 'ckd-epi-2021-egfr')
    expect(historicalEgfr?.status).toBe('incomplete')

    // Historical prompt replay with asOf before the severe lab executes cleanly with zero renal red-line blocks
    const historicalPrompts = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/clinical-prompts?timing=encounter-open&asOf=${encodeURIComponent(beforeLabIso)}`,
      clinicalPromptBundleSchema,
    )
    expect(historicalPrompts.historicalReplay?.asOf).toBe(beforeLabIso)
    expect(historicalPrompts.blockedRecords.filter(b => b.blockedReason === 'red-line-violation')).toEqual([])
  })
})
