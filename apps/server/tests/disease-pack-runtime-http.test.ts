import { randomUUID } from 'node:crypto'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentPageContextClaim } from '@clinmesh/contracts/agent'
import {
  agentPageBindingRevision,
  agentPageContextBindingSchema,
  agentToolAuthorizationResponseSchema,
  agentToolCatalog,
} from '@clinmesh/contracts/agent'
import {
  diseasePackCatalogListSchema,
  diseasePackRuntimeBundleSchema,
  diseasePackTaskFactsResponseSchema,
  diseasePackTaskReadinessResultSchema,
  diseasePackToggleResponseSchema,
  diseasePackToolAuthorizeResponseSchema,
} from '@clinmesh/contracts/disease-pack'
import { doctorRecommendationStateSchema } from '@clinmesh/contracts/doctor-recommendations'
import { guidelineTopicIdSchema } from '@clinmesh/contracts/guideline-topics'
import {
  apiErrorSchema,
  clinicalCatalogSchema,
  createPatientResponseSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  registrationCatalogSchema,
  registrationResponseSchema,
  startVisitResponseSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientGuidelineAdviceSchema } from '@clinmesh/contracts/inpatient-guideline-advice'
import { orderSetTemplateIdSchema } from '@clinmesh/contracts/order-set-templates'
import { DiseasePackValidationError, validateAndParseDiseasePack } from '@clinmesh/core/disease-pack'
import { computeDiseasePackFingerprint, DiseasePackRegistry } from '../src/application/disease-pack-runtime-service.ts'
import { GuidelineCorpus } from '../src/infrastructure/sqlite/guideline-corpus.ts'
import type { GuidelineDocument } from '../src/application/guideline-corpus.ts'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { createPciPaymentDrgFixture, parsePciResponse, preparePciPaymentDrgFixture, type PciPaymentDrgFixture } from './fixtures/pci-payment-drg.ts'

const SYNTHETIC_PACK_DIR = resolve(import.meta.dirname, 'fixtures/disease-packs/synthetic-test-syndrome-pack')

const pciParagraphs = [
  'In patients undergoing PCI, DES should be used in preference to BMS. Synthetic test passage; assess the clinical population.',
  'IVUS can be useful, particularly in left main or complex coronary artery stenting. OCT is a reasonable alternative, except in ostial left main disease.',
  'Evaluate both proximal and distal reference segments, with lumen, EEM, and plaque measurements. With manual pullback, length cannot be measured without a longitudinal acquisition.',
]

function pciDocuments(): GuidelineDocument[] {
  return [
    {
      id: 'coronary-10-2021',
      hash: '9843131ad84f9a261ceb8857025e656a067496472edabfb6bd2b6297f2c5ff0e',
      title: '合成血运重建指南测试原文',
      pages: [35, 36],
      texts: pciParagraphs.slice(0, 2),
    },
    {
      id: 'coronary-15-2021',
      hash: 'c2018438f6bfe9abf39cdfa813f6a6312de858bb6047ce18d9a01bff222ae9ad',
      title: '合成CVIT测量共识测试原文',
      pages: [6],
      texts: pciParagraphs.slice(2),
    },
  ].map(item => ({
    passages: item.pages.map((page, idx) => ({ locator: `PDF 物理第 ${page} 页`, text: item.texts[idx]! })),
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
      version: '2021',
    },
  }))
}

describe('Disease Pack Runtime, 3-Layer Overlay, Readiness & Agent Gateway', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!()
    }
  })

  async function setupRuntimeWithSyntheticPack(options: {
    verifyFingerprint?: boolean
    withOverlay?: unknown
    withGuidelineCorpus?: boolean
    skipSyntheticPack?: boolean
  } = {}) {
    const prepared = await preparePciPaymentDrgFixture()
    cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))
    const modelCalls: Array<{ feature: string }> = []

    if (options.withGuidelineCorpus) {
      const guidelineDbPath = join(prepared.directory, 'guidelines.sqlite')
      const writer = new GuidelineCorpus({ databasePath: guidelineDbPath })
      cleanups.push(async () => writer.close())
      writer.importDocuments(pciDocuments())
      prepared.options.guidelineDatabasePath = guidelineDbPath
      prepared.options.consultationModel = 'synthetic-guideline-model'
      prepared.options.chatCompletionsProvider = new OpenAIChatCompletionsClient({
        apiKey: 'synthetic-only',
        baseUrl: 'https://synthetic.invalid/v1',
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body))
          const feature: string = body.response_format?.json_schema?.name ?? body.tools?.[0]?.function?.name
          modelCalls.push({ feature })
          const input = JSON.parse(body.messages[1].content) as { guidelines?: Array<{ id: string }> }
          const fallback = feature === 'inpatient_drg_recommendation'
            ? {
                conclusions: [
                  {
                    applicability: 'conditional',
                    citations: [{ evidenceId: input.guidelines![0]!.id, quote: pciParagraphs[0]! }],
                    kind: 'stent-category',
                    text: '已提出PCI计划，可核对DES相对BMS的类别依据；部分风险资料尚待补全。',
                  },
                  {
                    applicability: 'conditional',
                    citations: [{ evidenceId: input.guidelines![1]!.id, quote: pciParagraphs[1]! }],
                    kind: 'imaging-guidance',
                    text: 'IVUS可用于左主干或复杂支架指导；OCT作为替代保留左主干开口限制。',
                  },
                  {
                    applicability: 'conditional',
                    citations: [{ evidenceId: input.guidelines![2]!.id, quote: pciParagraphs[2]! }],
                    kind: 'measurement-requirements',
                    text: '需区分近远端参考管径及管腔、EEM和斑块测量。',
                  },
                ],
              }
            : {
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
          return Response.json({
            choices: [{ message: { content: JSON.stringify(fallback) } }],
            id: `syn-guideline-${randomUUID()}`,
            model: 'synthetic-guideline-model',
            usage: { completion_tokens: 20, prompt_tokens: 100, total_tokens: 120 },
          })
        },
      })
    }

    const dshSecret = 'test-dsh-bridge-secret-with-at-least-32-characters'
    prepared.options.dshBridgeSecret = dshSecret
    if (!options.skipSyntheticPack) {
      prepared.options.diseasePackDirs = [SYNTHETIC_PACK_DIR]
      prepared.options.registeredClinicianReviewers = [{
        licenseVerified: true,
        nameZh: '合成测试审核人',
        reviewerId: 'reviewer-syn-cardio-01',
        specialty: 'cardiology',
      }]
    }
    if (options.verifyFingerprint !== undefined) {
      prepared.options.diseasePackVerifyFingerprint = options.verifyFingerprint
    }
    if (options.withOverlay !== undefined) {
      prepared.options.hospitalOverlays = [options.withOverlay]
    }

    const fixture = await createPciPaymentDrgFixture(prepared)
    cleanups.push(() => fixture.runtime.close())
    return { dshSecret, fixture, modelCalls, prepared }
  }

  async function startOutpatientVisitForDoctor(fixture: PciPaymentDrgFixture, chiefComplaint = '胸闷待查') {
    const patient = (await parsePciResponse(
      createPatientResponseSchema,
      await fixture.request('registrar', '/api/his/v1/patients', {
        birthDate: '1966-05-20',
        gender: 'male',
        identifier: `SYN-DSAP-${randomUUID()}`,
        name: '合成专病验证患者',
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
        bloodPressure: { diastolicMmHg: 78, systolicMmHg: 126 },
        chiefComplaint,
        heightCm: 170,
        oxygenSaturationPct: 98,
        pulseBpm: 76,
        respirationBpm: 18,
        temperatureC: 36.6,
        weightKg: 70,
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

  function insertLocalObservation(
    fixture: PciPaymentDrgFixture,
    input: {
      patientId: string
      encounterId: string
      id?: string
      code: string
      display: string
      value: number
      unit: string
      effectiveAt?: string
      issuedAt?: string
      categoryCode?: string
    },
  ) {
    const id = input.id ?? `obs-${randomUUID()}`
    const timestamp = input.effectiveAt ?? currentVirtualTime(fixture)
    fixture.runtime.fhir.create({ epoch: currentEpoch(fixture), workspaceId: 'workspace-demo' }, {
      category: [{ coding: [{ code: input.categoryCode ?? 'laboratory', system: 'http://terminology.hl7.org/CodeSystem/observation-category' }] }],
      code: { coding: [{ code: input.code, display: input.display, system: 'http://loinc.org' }], text: input.display },
      effectiveDateTime: timestamp,
      encounter: { reference: `Encounter/${input.encounterId}` },
      id,
      issued: input.issuedAt ?? timestamp,
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: `Patient/${input.patientId}` },
      valueQuantity: { code: input.unit, system: 'http://unitsofmeasure.org', unit: input.unit, value: input.value },
    })
    return id
  }

  it('AC4 & AC6: accepts open slugs in contracts, validates unregistered topics/templates cleanly (404), and rejects executable pack files', async () => {
    expect(guidelineTopicIdSchema.parse('synthetic-custom-topic-01')).toBe('synthetic-custom-topic-01')
    expect(orderSetTemplateIdSchema.parse('synthetic-custom-orderset-01')).toBe('synthetic-custom-orderset-01')

    const { fixture } = await setupRuntimeWithSyntheticPack({ verifyFingerprint: true })
    const visit = await startOutpatientVisitForDoctor(fixture)

    // Unregistered topicId or templateId must fail cleanly with 404 (not 500!)
    const badTopic = await fixture.request(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/guideline-topics?topicId=synthetic-unregistered-topic`,
    )
    expect(badTopic.status).toBe(404)
    expect(apiErrorSchema.parse(await badTopic.json()).error.code).toBe('GUIDELINE_TOPIC_NOT_FOUND')

    const badTemplate = await fixture.request(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/order-set-drafts?templateId=synthetic-unregistered-template`,
    )
    expect(badTemplate.status).toBe(404)
    expect(apiErrorSchema.parse(await badTemplate.json()).error.code).toBe('ORDER_SET_TEMPLATE_NOT_FOUND')

    // Catalog lists both built-in coronary draft & dynamically loaded pure-JSON pack with verified SHA-256
    const catalog = await fixture.read('doctor', '/api/his/v1/catalogs/disease-packs', diseasePackCatalogListSchema)
    expect(catalog.items.map(i => i.id)).toEqual(expect.arrayContaining(['coronary-cad', 'synthetic-test-syndrome']))
    expect(catalog.items.find(i => i.id === 'synthetic-test-syndrome')?.status).toBe('active')

    // Reject directory containing an executable .ts file
    const dirtyDir = await mkdtemp(join(tmpdir(), 'clinmesh-dirty-pack-'))
    cleanups.push(() => rm(dirtyDir, { recursive: true, force: true }))
    await cp(SYNTHETIC_PACK_DIR, dirtyDir, { recursive: true })
    await writeFile(join(dirtyDir, 'hook.ts'), 'export function inject() { return 1 }\n')

    const registry = new DiseasePackRegistry({ includeBuiltinDraftPacks: false })
    expect(() => registry.loadDirectory(dirtyDir)).toThrow(DiseasePackValidationError)
    try {
      registry.loadDirectory(dirtyDir)
    } catch (error) {
      expect((error as DiseasePackValidationError).code).toBe('PACK_CODE_FORBIDDEN')
    }

    // Default verifyFingerprint=true must reject a tampered manifest fingerprint even when option is omitted
    const tamperedDir = await mkdtemp(join(tmpdir(), 'clinmesh-tampered-pack-'))
    cleanups.push(() => rm(tamperedDir, { recursive: true, force: true }))
    await cp(SYNTHETIC_PACK_DIR, tamperedDir, { recursive: true })
    await writeFile(join(tamperedDir, 'manifest.json'), JSON.stringify({
      dependencies: [],
      fingerprint: 'f'.repeat(64),
      id: 'tampered-pack',
      packType: 'recognition',
      specialty: 'synthetic-medicine',
      status: 'active',
      supportedTasks: ['early-triage-recognition'],
      titleEn: 'Tampered Pack',
      titleZh: '篡改校验包',
      version: '1.0.0',
    }))
    await writeFile(join(tamperedDir, 'recognition-card.json'), JSON.stringify({
      recognitionCard: {
        differentialPackIds: [],
        escalationGuidanceZh: '提示急诊科进一步检查',
        id: 'tamper-card',
        summaryZh: '摘要',
        titleZh: '标题',
      },
    }))
    expect(() => new DiseasePackRegistry({ includeBuiltinDraftPacks: false, packDirs: [tamperedDir] }))
      .toThrow(DiseasePackValidationError)
  })

  it('AC5: applies 3-layer overlay localization & safety tightening, rejects overlay weakening', async () => {
    const { fixture } = await setupRuntimeWithSyntheticPack({
      verifyFingerprint: true,
      withOverlay: {
        hospitalId: 'hospital-alpha',
        localizations: {
          catalogBindings: { 'CAT-CREAT-01': 'LOCAL-CREAT-99' },
          codingMappings: { 'SYN-DX-01': 'I25.103' },
        },
        packId: 'synthetic-test-syndrome',
        safetyAdjustments: {
          examPassThreshold: 0.9,
          forbiddenActionAdditions: ['hospital-forbidden-export'],
          validityOverrides: [{ itemCode: '2160-0', maxValidityDays: 7 }],
        },
        version: '1.0.0',
      },
    })
    const visit = await startOutpatientVisitForDoctor(fixture)
    const packs = await fixture.read(
      'doctor',
      `/api/his/v1/outpatient/cases/${visit.caseId}/disease-packs`,
      diseasePackRuntimeBundleSchema,
    )
    const synPack = packs.packs.find(p => p.packId === 'synthetic-test-syndrome')!
    expect(synPack.localizations.catalogBindings).toEqual({ 'CAT-CREAT-01': 'LOCAL-CREAT-99' })
    expect(synPack.forbiddenActions).toContain('hospital-forbidden-export')
    expect(synPack.forbiddenActions).toEqual(expect.arrayContaining([
      'auto-prescribe-medication',
      'sign-clinical-document',
      'autonomous-treatment-decision',
    ]))

    // Attempting to apply an overlay that relaxes validityDays or removes red lines must reject cleanly
    expect(() => fixture.runtime.diseasePacks.registry.applyHospitalOverlay({
      hospitalId: 'hospital-alpha',
      packId: 'synthetic-test-syndrome',
      safetyAdjustments: { validityOverrides: [{ itemCode: '2160-0', maxValidityDays: 21 }] },
    })).toThrow(DiseasePackValidationError)
  })

  it('evaluates trigger activation, cross-encounter sequence stage transition, toggle persistence & restart durability', async () => {
    const { fixture } = await setupRuntimeWithSyntheticPack({ verifyFingerprint: true })
    const stay = await fixture.preparePciAdmission([])

    // Initially preparePciAdmission has CAD/I25 diagnosis? Check baseline activation
    const initial = await fixture.read('inpatient-doctor', `${stay.path}/disease-packs`, diseasePackRuntimeBundleSchema)
    const synInitial = initial.packs.find(p => p.packId === 'synthetic-test-syndrome')!
    expect(synInitial.activationStatus).toBe('active')
    expect(synInitial.currentStageId).toBe('baseline-assessment')

    // Inject creatinine on the SAME encounter -> sequence trigger with requireDistinctEncounters must NOT advance stage
    insertLocalObservation(fixture, {
      code: '2160-0',
      display: '血清肌酐',
      encounterId: stay.admissionId,
      patientId: stay.patientId,
      unit: 'umol/L',
      value: 92,
    })
    const sameEnc = await fixture.read('inpatient-doctor', `${stay.path}/disease-packs`, diseasePackRuntimeBundleSchema)
    expect(sameEnc.packs.find(p => p.packId === 'synthetic-test-syndrome')?.currentStageId).toBe('baseline-assessment')

    // Inject creatinine on a DISTINCT prior/followup Encounter within maxGapDays -> stage advances to cross-encounter-followup
    const secondEncId = `enc-followup-${randomUUID()}`
    fixture.runtime.fhir.create({ epoch: currentEpoch(fixture), workspaceId: 'workspace-demo' }, {
      id: secondEncId,
      resourceType: 'Encounter',
      status: 'completed',
      subject: { reference: `Patient/${stay.patientId}` },
    })
    insertLocalObservation(fixture, {
      code: '2160-0',
      display: '血清肌酐',
      encounterId: secondEncId,
      patientId: stay.patientId,
      unit: 'umol/L',
      value: 95,
    })
    const distinctEnc = await fixture.read('inpatient-doctor', `${stay.path}/disease-packs`, diseasePackRuntimeBundleSchema)
    expect(distinctEnc.packs.find(p => p.packId === 'synthetic-test-syndrome')?.currentStageId).toBe('cross-encounter-followup')

    // Toggle disabled with Command + idempotency + expectedVersion, restart runtime, verify persisted + stage audit written
    const toggleKey = randomUUID()
    const disabledRes = await fixture.request(
      'inpatient-doctor',
      `${stay.path}/disease-packs/synthetic-test-syndrome/toggle`,
      { expectedVersion: 0, note: '临床人工关闭核对', overrideMode: 'disabled' },
      toggleKey,
    )
    expect(disabledRes.status).toBe(200)
    const disabledParsed = diseasePackToggleResponseSchema.parse(await disabledRes.json())
    expect(disabledParsed.data.activationStatus).toBe('inactive')
    expect(disabledParsed.data.manualOverride).toBe('disabled')
    expect(disabledParsed.data.manualOverrideVersion).toBe(1)

    // Same-key replay succeeds cleanly without re-executing
    const replayRes = await fixture.request(
      'inpatient-doctor',
      `${stay.path}/disease-packs/synthetic-test-syndrome/toggle`,
      { expectedVersion: 0, note: '临床人工关闭核对', overrideMode: 'disabled' },
      toggleKey,
    )
    expect(replayRes.status).toBe(200)
    expect(diseasePackToggleResponseSchema.parse(await replayRes.json()).data.manualOverrideVersion).toBe(1)

    // Enable again -> version increments to 2 and records stage transition audit
    const enabledRes = await fixture.request(
      'inpatient-doctor',
      `${stay.path}/disease-packs/synthetic-test-syndrome/toggle`,
      { expectedVersion: 1, overrideMode: 'enabled' },
    )
    expect(enabledRes.status).toBe(200)
    expect(diseasePackToggleResponseSchema.parse(await enabledRes.json()).data.activationStatus).toBe('active')

    // Stale expectedVersion fails 409
    const staleRes = await fixture.request(
      'inpatient-doctor',
      `${stay.path}/disease-packs/synthetic-test-syndrome/toggle`,
      { expectedVersion: 1, overrideMode: 'disabled' },
    )
    expect(staleRes.status).toBe(409)

    await fixture.restart()
    const afterRestart = await fixture.read('inpatient-doctor', `${stay.path}/disease-packs`, diseasePackRuntimeBundleSchema)
    expect(afterRestart.packs.find(p => p.packId === 'synthetic-test-syndrome')?.manualOverride).toBe('enabled')
    expect(afterRestart.packs.find(p => p.packId === 'synthetic-test-syndrome')?.manualOverrideVersion).toBe(2)

    const auditCount = fixture.runtime.database.driver.prepare(`
      SELECT COUNT(*) AS cnt FROM disease_pack_stage_audit
      WHERE subject_kind = 'inpatient' AND subject_id = ? AND pack_id = 'synthetic-test-syndrome'
    `).get(stay.admissionId) as { cnt: number }
    expect(auditCount.cnt).toBeGreaterThanOrEqual(1)
  })

  it('AC20 & AC32: enforces PCI pre-op creatinine red-line refusal, pre-LLM automatic block, suspicious rejection, smoking annotation & task-scoped filtering', async () => {
    const { fixture, modelCalls } = await setupRuntimeWithSyntheticPack({ withGuidelineCorpus: true })
    const stay = await fixture.preparePciAdmission([])

    // 1. Missing creatinine -> readiness returns missing-critical, automatic advice starts 'blocked', dispatchPending() runs 0 model calls, AND manual request refuses 409
    const initialReadiness = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/disease-packs/synthetic-test-syndrome/tasks/pci-preop-guideline-advice/readiness`,
      diseasePackTaskReadinessResultSchema,
    )
    expect(initialReadiness.status).toBe('missing-critical')
    expect(initialReadiness.canProceed).toBe(false)
    expect(initialReadiness.missingCriticalItems[0]?.labelZh).toBe('血清肌酐 / eGFR')

    const initialAdvice = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/guideline-advice/${stay.requestId}`,
      inpatientGuidelineAdviceSchema,
    )
    expect(initialAdvice.status).toBe('blocked')
    expect(initialAdvice.failureCode).toBe('TASK_READINESS_CRITICAL_MISSING')
    expect(initialAdvice.result).toBeNull()

    await fixture.runtime.dispatchPending()
    expect(modelCalls).toHaveLength(0)

    const blockedDraft = await fixture.request(
      'inpatient-doctor',
      `${stay.path}/guideline-advice/request`,
      {
        expectedFingerprint: initialAdvice.fingerprint,
        expectedVersion: initialAdvice.version,
        requestId: stay.requestId,
      },
    )
    expect(blockedDraft.status).toBe(409)
    expect(apiErrorSchema.parse(await blockedDraft.json()).error.code).toBe('TASK_READINESS_CRITICAL_MISSING')
    expect(modelCalls).toHaveLength(0)

    // 2. Suspicious out-of-range creatinine MUST NOT satisfy critical requirement!
    insertLocalObservation(fixture, {
      code: '2160-0',
      display: '血清肌酐',
      encounterId: stay.admissionId,
      patientId: stay.patientId,
      unit: 'umol/L',
      value: 999999,
    })
    const suspiciousReadiness = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/disease-packs/synthetic-test-syndrome/tasks/pci-preop-guideline-advice/readiness`,
      diseasePackTaskReadinessResultSchema,
    )
    expect(suspiciousReadiness.status).toBe('missing-critical')
    expect(suspiciousReadiness.canProceed).toBe(false)
    expect(suspiciousReadiness.missingCriticalItems[0]?.ineligibleReasons).toContain('suspicious:out-of-plausible-range')

    // 3. Valid creatinine + 60 unrelated labs, NO smoking status -> missing-secondary with annotation '缺吸烟状态' + filtered facts
    insertLocalObservation(fixture, {
      code: '2160-0',
      display: '血清肌酐',
      encounterId: stay.admissionId,
      patientId: stay.patientId,
      unit: 'umol/L',
      value: 96,
    })
    for (let i = 0; i < 60; i++) {
      insertLocalObservation(fixture, {
        code: `UNREL-${i}`,
        display: `无关实验室项目 ${i}`,
        encounterId: stay.admissionId,
        patientId: stay.patientId,
        unit: 'U/L',
        value: 20 + i,
      })
    }

    const secondaryReadiness = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/disease-packs/synthetic-test-syndrome/tasks/pci-preop-guideline-advice/readiness`,
      diseasePackTaskReadinessResultSchema,
    )
    expect(secondaryReadiness.status).toBe('missing-secondary')
    expect(secondaryReadiness.canProceed).toBe(true)
    expect(secondaryReadiness.annotations).toEqual(['缺吸烟状态'])

    // Now drafting guideline advice succeeds and annotates '缺吸烟状态' both in missing[] and draft limitations
    const refreshedAdvice = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/guideline-advice/${stay.requestId}`,
      inpatientGuidelineAdviceSchema,
    )
    expect(refreshedAdvice.status).toBe('stale')
    expect(refreshedAdvice.missing).toContain('缺吸烟状态')
    const allowedDraft = await fixture.request(
      'inpatient-doctor',
      `${stay.path}/guideline-advice/request`,
      {
        expectedFingerprint: refreshedAdvice.fingerprint,
        expectedVersion: refreshedAdvice.version,
        requestId: stay.requestId,
      },
    )
    expect(allowedDraft.status).toBe(200)

    await fixture.runtime.dispatchPending()
    expect(modelCalls.length).toBeGreaterThanOrEqual(2)
    const draftedAdvice = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/guideline-advice/${stay.requestId}`,
      inpatientGuidelineAdviceSchema,
    )
    expect(draftedAdvice.status).toBe('incomplete')
    expect(draftedAdvice.missing).toContain('缺吸烟状态')
    expect(draftedAdvice.result?.limitations).toContain('资料缺项标注：缺吸烟状态')

    // AC32: Task-scoped ledger filtering excludes all 60 unrelated UNREL-* labs!
    const scopedFacts = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/disease-packs/synthetic-test-syndrome/tasks/pci-preop-guideline-advice/facts`,
      diseasePackTaskFactsResponseSchema,
    )
    expect(scopedFacts.declaredItemCodes).toEqual(expect.arrayContaining(['2160-0', 'smoking-status']))
    expect(scopedFacts.readiness.annotations).toEqual(['缺吸烟状态'])
    expect(scopedFacts.ledger.facts.every(f => !f.itemCode.code.startsWith('UNREL-'))).toBe(true)
    expect(scopedFacts.ledger.facts.some(f => f.itemCode.code === '2160-0')).toBe(true)
    expect(scopedFacts.ledger.summary.totalFacts).toBe(scopedFacts.ledger.facts.length)
    expect(scopedFacts.ledger.summary.totalFacts).toBeLessThan(15)

    // AC32 followup-review scope: includes LDL-C, BP, discharge-time & active meds, strictly excludes creatinine & 60 UNREL-* labs!
    insertLocalObservation(fixture, {
      code: '13457-7',
      display: '低密度脂蛋白胆固醇 (LDL-C)',
      encounterId: stay.admissionId,
      patientId: stay.patientId,
      unit: 'mmol/L',
      value: 2.1,
    })
    insertLocalObservation(fixture, {
      categoryCode: 'vital-signs',
      code: '8480-6',
      display: '收缩压',
      encounterId: stay.admissionId,
      patientId: stay.patientId,
      unit: 'mmHg',
      value: 124,
    })
    insertLocalObservation(fixture, {
      categoryCode: 'vital-signs',
      code: '8462-4',
      display: '舒张压',
      encounterId: stay.admissionId,
      patientId: stay.patientId,
      unit: 'mmHg',
      value: 76,
    })
    fixture.runtime.fhir.create({ epoch: currentEpoch(fixture), workspaceId: 'workspace-demo' }, {
      code: { coding: [{ code: 'discharge-time', display: '出院时间' }] },
      effectiveDateTime: currentVirtualTime(fixture),
      encounter: { reference: `Encounter/${stay.admissionId}` },
      id: `obs-discharge-${randomUUID()}`,
      issued: currentVirtualTime(fixture),
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: `Patient/${stay.patientId}` },
      valueString: currentVirtualTime(fixture),
    })
    fixture.runtime.fhir.create({ epoch: currentEpoch(fixture), workspaceId: 'workspace-demo' }, {
      authoredOn: currentVirtualTime(fixture),
      id: `med-followup-${randomUUID()}`,
      intent: 'order',
      medicationCodeableConcept: { coding: [{ code: 'atorvastatin', display: '阿托伐他汀' }] },
      resourceType: 'MedicationRequest',
      status: 'active',
      subject: { reference: `Patient/${stay.patientId}` },
    })

    const followupFacts = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/disease-packs/synthetic-test-syndrome/tasks/followup-review/facts`,
      diseasePackTaskFactsResponseSchema,
    )
    expect(followupFacts.declaredItemCodes).toEqual(expect.arrayContaining(['13457-7', '8480-6', '8462-4', 'discharge-time']))
    expect(followupFacts.ledger.facts.map(f => f.itemCode.code)).toEqual(
      expect.arrayContaining(['13457-7', '8480-6', '8462-4', 'discharge-time', 'atorvastatin']),
    )
    expect(followupFacts.ledger.facts.some(f => f.itemCode.code === '2160-0')).toBe(false)
    expect(followupFacts.ledger.facts.some(f => f.itemCode.code.startsWith('UNREL-'))).toBe(false)
    expect(followupFacts.ledger.facts.some(f => f.category === 'diagnosis')).toBe(false)

    // 4. Record smoking-status -> ready!
    const clinicalAfterLabs = await fixture.read('inpatient-doctor', `${stay.path}/clinical`, inpatientFullClinicalSchema)
    const riskRes = await fixture.runtime.app.request(`http://localhost${stay.path}/risk-assessment`, {
      body: JSON.stringify({
        input: {
          encounterVersion: clinicalAfterLabs.encounterVersion,
          expectedRevision: clinicalAfterLabs.riskAssessment?.revision ?? 0,
          fields: { smokingStatus: 'never' },
        },
      }),
      headers: {
        'content-type': 'application/json',
        cookie: await fixture.login('inpatient-doctor'),
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'PUT',
    })
    expect(riskRes.status).toBe(200)
    const readyNow = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/disease-packs/synthetic-test-syndrome/tasks/pci-preop-guideline-advice/readiness`,
      diseasePackTaskReadinessResultSchema,
    )
    expect(readyNow.status).toBe('ready')
    expect(readyNow.canProceed).toBe(true)
    expect(readyNow.annotations).toEqual([])
  })

  it('AC7 & AC15: enforces pack toolPolicy whitelist & forbiddenActions with AuditEvent, binds DSH Agent tools, and leaks zero Case Truth', async () => {
    const { dshSecret, fixture } = await setupRuntimeWithSyntheticPack({ verifyFingerprint: true })
    const visit = await startOutpatientVisitForDoctor(fixture)

    // Confirm CAD/I25 diagnosis so synthetic-test-syndrome activates for outpatient case
    const catalog = await fixture.read('doctor', '/api/his/v1/catalogs/clinical', clinicalCatalogSchema)
    const cadDx = catalog.diagnoses.find(d => d.code.startsWith('I25'))!
    const dxDraft = await fixture.runtime.app.request(`http://localhost/api/his/v1/encounters/${visit.encounterId}/diagnosis/draft`, {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${visit.encounterId}`]: visit.detail.encounter.versionId },
        input: { entries: [{ catalogItemId: cadDx.id, role: 'primary' }], expectedDraftVersion: 0 },
      }),
      headers: {
        'content-type': 'application/json',
        cookie: await fixture.login('doctor'),
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'PUT',
    })
    expect(dxDraft.status).toBe(200)
    const dxDraftData = (await dxDraft.json() as { data: { draftVersion: number } }).data
    const dxConfirm = await fixture.request(
      'doctor',
      `/api/his/v1/encounters/${visit.encounterId}/diagnosis/actions/confirm`,
      { expectedDraftVersion: dxDraftData.draftVersion },
      randomUUID(),
      { [`Encounter/${visit.encounterId}`]: visit.detail.encounter.versionId },
    )
    expect(dxConfirm.status).toBe(200)

    // 1. Disallowed tool rejected with 403 DSAP_TOOL_POLICY_DENIED + AuditEvent persisted
    const deniedTool = await fixture.request(
      'doctor',
      `/api/his/v1/outpatient/cases/${visit.caseId}/disease-packs/synthetic-test-syndrome/tools/authorize`,
      { operationId: 'outpatient.prescription.issue.propose' },
    )
    expect(deniedTool.status).toBe(403)
    expect(apiErrorSchema.parse(await deniedTool.json()).error.code).toBe('DSAP_TOOL_POLICY_DENIED')

    // 2. Mandatory forbidden action rejected even if caller passes actionTag
    const forbiddenTool = await fixture.request(
      'doctor',
      `/api/his/v1/outpatient/cases/${visit.caseId}/disease-packs/synthetic-test-syndrome/tools/authorize`,
      { actionTag: 'auto-prescribe-medication', operationId: 'outpatient.disease-packs.read' },
    )
    expect(forbiddenTool.status).toBe(403)
    expect(apiErrorSchema.parse(await forbiddenTool.json()).error.code).toBe('DSAP_TOOL_POLICY_DENIED')

    const deniedAudits = fixture.runtime.database.driver.prepare(`
      SELECT operation, outcome FROM audit_log
      WHERE operation = 'DSAP_TOOL_POLICY_DENIED'
    `).all() as Array<{ operation: string; outcome: string }>
    expect(deniedAudits.length).toBeGreaterThanOrEqual(2)
    expect(deniedAudits.every(row => row.outcome === 'failed')).toBe(true)

    // Verify FHIR AuditEvent projection also recorded DSAP_TOOL_POLICY_DENIED
    const auditEvents = fixture.runtime.fhir.search(
      { epoch: currentEpoch(fixture), workspaceId: 'workspace-demo' },
      'AuditEvent',
      new URLSearchParams({ _count: '100' }),
    ).resources as Array<{ code?: { coding?: Array<{ code?: string }> } }>
    expect(auditEvents.some(ev => ev.code?.coding?.some(c => c.code === 'DSAP_TOOL_POLICY_DENIED'))).toBe(true)

    // 3. Allowed tool authorized cleanly
    const allowedRes = await fixture.request(
      'doctor',
      `/api/his/v1/outpatient/cases/${visit.caseId}/disease-packs/synthetic-test-syndrome/tools/authorize`,
      { operationId: 'outpatient.disease-packs.read' },
    )
    expect(allowedRes.status).toBe(200)
    expect(diseasePackToolAuthorizeResponseSchema.parse(await allowedRes.json()).authorized).toBe(true)

    // 4. DSH Agent integration: create PageContext in diagnosis section -> authorize & query generic pack tool
    const refreshedDetail = await fixture.read('doctor', `/api/his/v1/doctor/cases/${visit.caseId}`, doctorCaseDetailSchema)
    const claim: AgentPageContextClaim = {
      activeSection: 'diagnosis',
      selection: { id: visit.caseId, kind: 'case', version: refreshedDetail.encounter.versionId },
      taskEpoch: 'a1b2c3d4-1234-4234-8234-123456789abc',
      ui: { status: 'ready' },
      version: 1,
      viewId: 'consultation',
      viewRevision: 'consultation-1',
    }
    const doctorCookie = await fixture.login('doctor')
    const ctxRes = await fixture.runtime.app.request('/api/agent/v1/page-contexts', {
      body: JSON.stringify({ claim, client: { id: 'doc-client', revision: 1 }, dshSessionId: 'dsh-dsap-1' }),
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(ctxRes.status).toBe(201)
    const ctxBinding = agentPageContextBindingSchema.parse(await ctxRes.json())
    expect(ctxBinding.snapshot.allowedOperationIds).toEqual(expect.arrayContaining([
      'outpatient.disease-packs.read',
      'outpatient.disease-pack-task-facts.read',
    ]))

    const signProof = (toolName: string, callId: string) => {
      const payload = {
        callId,
        contextId: ctxBinding.snapshot.id,
        dshSessionId: 'dsh-dsap-1',
        expiresAt: ctxBinding.snapshot.expiresAt,
        issuedAt: ctxBinding.snapshot.issuedAt,
        origin: {
          request: { pageRevision: agentPageBindingRevision(claim), scopeKey: ctxBinding.snapshot.scopeKey },
          task: {
            acceptedAt: ctxBinding.snapshot.issuedAt,
            messageId: 'msg-1',
            pageRevision: agentPageBindingRevision(claim),
            rpcId: 'rpc-1',
            scopeKey: ctxBinding.snapshot.scopeKey,
            turn: 1,
          },
        },
        pageRevision: agentPageBindingRevision(claim),
        scopeKey: ctxBinding.snapshot.scopeKey,
        toolName,
        version: 3,
      }
      const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
      const sig = createHmac('sha256', dshSecret).update(b64).digest('base64url')
      return `${b64}.${sig}`
    }

    const toolDef = agentToolCatalog.find(t => t.operationId === 'outpatient.disease-packs.read')!
    const authRes = await fixture.runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: ctxBinding.token,
        executionProof: signProof(toolDef.toolName, 'call-pack-1'),
        input: {},
        operationId: 'outpatient.disease-packs.read',
        packId: 'synthetic-test-syndrome',
      }),
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(authRes.status).toBe(201)
    const authParsed = agentToolAuthorizationResponseSchema.parse(await authRes.json())

    const queryRes = await fixture.runtime.app.request('/api/agent/v1/doctor-queries', {
      body: JSON.stringify({
        contextToken: ctxBinding.token,
        input: {},
        receiptToken: authParsed.receiptToken,
      }),
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(queryRes.status).toBe(200)
    const queryJson = await queryRes.text()
    expect(queryJson).not.toMatch(/caseTruth|case_truth/i)
    const querieJsonCheck = diseasePackRuntimeBundleSchema.parse(JSON.parse(queryJson))
    expect(querieJsonCheck.packs.find(p => p.packId === 'synthetic-test-syndrome')?.activationStatus).toBe('active')

    // Replaying call-pack-1 MUST return 409 AGENT_CALL_REPLAYED without duplicating DSAP_TOOL_POLICY_AUTHORIZED audits
    const authCountBeforeReplay = (fixture.runtime.database.driver.prepare(`
      SELECT COUNT(*) AS cnt FROM audit_log WHERE operation = 'DSAP_TOOL_POLICY_AUTHORIZED'
    `).get() as { cnt: number }).cnt
    const replayAuthRes = await fixture.runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: ctxBinding.token,
        executionProof: signProof(toolDef.toolName, 'call-pack-1'),
        input: {},
        operationId: 'outpatient.disease-packs.read',
        packId: 'synthetic-test-syndrome',
      }),
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(replayAuthRes.status).toBe(409)
    expect(apiErrorSchema.parse(await replayAuthRes.json()).error.code).toBe('AGENT_CALL_REPLAYED')
    const authCountAfterReplay = (fixture.runtime.database.driver.prepare(`
      SELECT COUNT(*) AS cnt FROM audit_log WHERE operation = 'DSAP_TOOL_POLICY_AUTHORIZED'
    `).get() as { cnt: number }).cnt
    expect(authCountAfterReplay).toBe(authCountBeforeReplay)

    // Calling /api/agent/v1/tool-calls WITHOUT packId still enforces active pack forbiddenActions & allowedTools whitelist (403 DSAP_TOOL_POLICY_DENIED + AuditEvent)
    const noPackForbiddenRes = await fixture.runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        actionTag: 'auto-prescribe-medication',
        contextToken: ctxBinding.token,
        executionProof: signProof(toolDef.toolName, 'call-no-pack-forbidden'),
        input: {},
        operationId: 'outpatient.disease-packs.read',
      }),
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(noPackForbiddenRes.status).toBe(403)
    expect(apiErrorSchema.parse(await noPackForbiddenRes.json()).error.code).toBe('DSAP_TOOL_POLICY_DENIED')

    // Disable coronary-cad for this check so ONLY synthetic-test-syndrome is active; calling WITHOUT packId for a tool outside its allowedTools still returns 403 DSAP_TOOL_POLICY_DENIED
    await fixture.request(
      'doctor',
      `/api/his/v1/outpatient/cases/${visit.caseId}/disease-packs/coronary-cad/toggle`,
      { overrideMode: 'disabled' },
    )
    const nonWhitelistedDef = agentToolCatalog.find(item => item.operationId === 'outpatient.order-set-drafts.read')!
    const noPackUnlistedRes = await fixture.runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: ctxBinding.token,
        executionProof: signProof(nonWhitelistedDef.toolName, 'call-no-pack-unlisted'),
        input: {},
        operationId: 'outpatient.order-set-drafts.read',
      }),
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(noPackUnlistedRes.status).toBe(403)
    expect(apiErrorSchema.parse(await noPackUnlistedRes.json()).error.code).toBe('DSAP_TOOL_POLICY_DENIED')

    // Disabling synthetic pack causes gateway authorization with packId to reject 409 DSAP_PACK_INACTIVE
    const toggleOff = await fixture.request(
      'doctor',
      `/api/his/v1/outpatient/cases/${visit.caseId}/disease-packs/synthetic-test-syndrome/toggle`,
      { overrideMode: 'disabled' },
    )
    expect(toggleOff.status).toBe(200)
    const inactiveAuth = await fixture.runtime.app.request('/api/agent/v1/disease-packs/tools/authorize', {
      body: JSON.stringify({
        operationId: 'outpatient.disease-packs.read',
        packId: 'synthetic-test-syndrome',
        subjectId: visit.caseId,
        subjectKind: 'outpatient',
      }),
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(inactiveAuth.status).toBe(409)
    expect(apiErrorSchema.parse(await inactiveAuth.json()).error.code).toBe('DSAP_PACK_INACTIVE')
  })

  it('auto-activates disk coronary-cad pack to block readiness with 0 LLM calls, and toggles explicit draft pack manually', async () => {
    const unsignedDraft = {
      examSuite: {
        cases: [{ caseId: 'draft-case-1', expectedActive: true, expectedBlockedTaskIds: [], expectedStageId: 'draft-stage', titleZh: '合成草案验证' }],
        passThreshold: 0.85,
      },
      formulaRefs: [],
      inapplicablePopulations: [],
      manifest: {
        dependencies: [],
        fingerprint: '0'.repeat(64),
        id: 'synthetic-draft-pack',
        packType: 'full' as const,
        specialty: 'cardiology',
        status: 'draft' as const,
        supportedTasks: ['pci-stent'],
        titleEn: 'Synthetic Draft Pack',
        titleZh: '合成草案专病包',
        version: '1.0.0',
      },
      qualityTightenings: { examPassThreshold: 0.85, redLineRules: [], validityOverrides: [] },
      readinessTasks: [{ criticalItems: [], secondaryItems: [], taskId: 'pci-stent', titleZh: '草案核对' }],
      stages: [
        {
          entryCondition: {
            category: 'diagnosis' as const,
            itemCodePattern: '^I25',
            kind: 'fact' as const,
            presence: 'present' as const,
            requireEligible: true,
          },
          id: 'draft-stage',
          order: 1,
          orderSetIds: [],
          questionnaireItemCodes: [],
          taskIds: ['pci-stent'],
          titleEn: 'Draft Stage',
          titleZh: '草案评估期',
          topicIds: [],
        },
      ],
      toolPolicy: { allowedTools: ['inpatient.disease-packs.read'], forbiddenActions: [] },
      triggers: [
        {
          condition: {
            category: 'diagnosis' as const,
            itemCodePattern: '^I25',
            kind: 'fact' as const,
            presence: 'present' as const,
            requireEligible: true,
          },
          descriptionZh: '草案触发器测试',
          id: 'draft-cad-trigger',
        },
      ],
    }
    const draftPack = validateAndParseDiseasePack({
      ...unsignedDraft,
      manifest: { ...unsignedDraft.manifest, fingerprint: computeDiseasePackFingerprint(unsignedDraft) },
    })
    const { fixture, modelCalls } = await setupRuntimeWithSyntheticPack({ skipSyntheticPack: true, withGuidelineCorpus: true })
    // Verify active disk coronary-cad blocks readiness immediately before LLM dispatch
    const stay = await fixture.preparePciAdmission([])
    await fixture.runtime.dispatchPending()
    expect(modelCalls).toHaveLength(0)
    const adviceBlocked = await fixture.read(
      'inpatient-doctor',
      `${stay.path}/guideline-advice/${stay.requestId}`,
      inpatientGuidelineAdviceSchema,
    )
    expect(adviceBlocked.status).toBe('blocked')
    expect(adviceBlocked.failureCode).toBe('TASK_READINESS_CRITICAL_MISSING')

    const autoPacks = await fixture.read('inpatient-doctor', `${stay.path}/disease-packs`, diseasePackRuntimeBundleSchema)
    expect(autoPacks.packs.find(p => p.packId === 'coronary-cad')).toMatchObject({
      activationReason: 'trigger-matched',
      activationStatus: 'active',
    })

    // Also verify explicit status: 'draft' pack does NOT auto-activate and requires manual toggle
    const draftPrep = await preparePciPaymentDrgFixture()
    cleanups.push(() => rm(draftPrep.directory, { recursive: true, force: true }))
    draftPrep.options.diseasePacks = [draftPack]
    const draftFixture = await createPciPaymentDrgFixture(draftPrep)
    cleanups.push(() => draftFixture.runtime.close())
    const draftStay = await draftFixture.admitSyntheticCase(['I25.103'], 'bed-general-1')
    const beforeDraftToggle = await draftFixture.read('inpatient-doctor', `${draftStay.path}/disease-packs`, diseasePackRuntimeBundleSchema)
    expect(beforeDraftToggle.packs.find(p => p.packId === 'synthetic-draft-pack')).toMatchObject({
      activationReason: 'pack-draft',
      activationStatus: 'inactive',
    })
    const enableDraftRes = await draftFixture.request(
      'inpatient-doctor',
      `${draftStay.path}/disease-packs/synthetic-draft-pack/toggle`,
      { expectedVersion: 0, note: '手动启用草案测试专病包', overrideMode: 'enabled' },
    )
    expect(enableDraftRes.status).toBe(200)
    const enabledDraft = diseasePackToggleResponseSchema.parse(await enableDraftRes.json()).data
    expect(enabledDraft.activationStatus).toBe('active')
    expect(enabledDraft.activationReason).toBe('manual-enabled')
  })

  it('enforces default publicLayer examPassThreshold, registered reviewer publication gate, and outpatient 3-tier prescription readiness gate', async () => {
    // 1. Default publicLayer floor prevents a hospital overlay from lowering examPassThreshold below 0.8
    const defaultRegistry = new DiseasePackRegistry({
      includeBuiltinDraftPacks: false,
      packDirs: [SYNTHETIC_PACK_DIR],
      registeredClinicianReviewers: [{
        licenseVerified: true,
        nameZh: '合成测试审核人',
        reviewerId: 'reviewer-syn-cardio-01',
        specialty: 'cardiology',
      }],
      verifyFingerprint: true,
    })
    expect(() => defaultRegistry.applyHospitalOverlay({
      hospitalId: 'hospital-relax',
      packId: 'synthetic-test-syndrome',
      safetyAdjustments: { examPassThreshold: 0.7 },
    })).toThrow(DiseasePackValidationError)

    // 2. Unregistered reviewer cannot publish claims/topics inside a pack (PACK_UNVERIFIED_PUBLICATION)
    const { fixture: regFixture } = await setupRuntimeWithSyntheticPack()
    const basePack = regFixture.runtime.workflow.diseasePacks.registry.getEffective('synthetic-test-syndrome').pack
    const forgedPubUnsigned = {
      ...basePack,
      knowledgeSnapshots: (basePack.knowledgeSnapshots ?? []).map(snap => ({
        ...snap,
        claims: snap.claims.map(claim => ({ ...claim, reviewerId: 'forged-reviewer', status: 'published' as const })),
      })),
    }
    const forgedPubPack = {
      ...forgedPubUnsigned,
      manifest: { ...forgedPubUnsigned.manifest, fingerprint: computeDiseasePackFingerprint(forgedPubUnsigned) },
    }
    try {
      new DiseasePackRegistry({
        includeBuiltinDraftPacks: false,
        packs: [forgedPubPack],
        registeredClinicianReviewers: [],
        verifyFingerprint: true,
      })
      expect.unreachable('should reject unverified publication reviewer')
    } catch (error) {
      expect((error as DiseasePackValidationError).code).toBe('PACK_UNVERIFIED_PUBLICATION')
    }

    // 3. Outpatient 3-tier prescription readiness gate (via T2DM pack):
    //    Tier 1 (missing-critical: no 2160-0 creatinine) -> missingInformation surfaces 血清肌酐, BOTH recommendation generate AND outpatient.prescription.draft.set fail 409 TASK_READINESS_CRITICAL_MISSING
    //    Tier 2 (missing-secondary: valid creatinine, no 4548-4 HbA1c) -> missingInformation surfaces 缺糖化血红蛋白 (HbA1c), prescription draft allowed (201)
    //    Tier 3 (ready: both valid creatinine and HbA1c) -> neither missing label remains
    const { dshSecret, fixture } = await setupRuntimeWithSyntheticPack({ skipSyntheticPack: true })
    const visit = await startOutpatientVisitForDoctor(fixture)
    const doctorCookie = await fixture.login('doctor')
    const catalog = await fixture.read('doctor', '/api/his/v1/catalogs/clinical', clinicalCatalogSchema)
    const t2dmDx = catalog.diagnoses.find(d => d.code.startsWith('E11'))
    const confirmedDx = t2dmDx ?? catalog.diagnoses.find(d => !d.code.startsWith('I2')) ?? catalog.diagnoses[0]!
    const dxDraft = await fixture.runtime.app.request(`http://localhost/api/his/v1/encounters/${visit.encounterId}/diagnosis/draft`, {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${visit.encounterId}`]: visit.detail.encounter.versionId },
        input: { entries: [{ catalogItemId: confirmedDx.id, role: 'primary' }], expectedDraftVersion: 0 },
      }),
      headers: {
        'content-type': 'application/json',
        cookie: doctorCookie,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'PUT',
    })
    expect(dxDraft.status).toBe(200)
    const dxDraftData = (await dxDraft.json() as { data: { draftVersion: number } }).data
    const dxConfirm = await fixture.request(
      'doctor',
      `/api/his/v1/encounters/${visit.encounterId}/diagnosis/actions/confirm`,
      { expectedDraftVersion: dxDraftData.draftVersion },
      randomUUID(),
      { [`Encounter/${visit.encounterId}`]: visit.detail.encounter.versionId },
    )
    expect(dxConfirm.status).toBe(200)
    if (t2dmDx === undefined) {
      fixture.runtime.fhir.create({ epoch: currentEpoch(fixture), workspaceId: 'workspace-demo' }, {
        clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
        code: { coding: [{ code: 'E11.9', display: '2型糖尿病', system: 'http://hl7.org/fhir/sid/icd-10' }], text: '2型糖尿病' },
        encounter: { reference: `Encounter/${visit.encounterId}` },
        id: `cond-t2dm-${randomUUID()}`,
        recordedDate: currentVirtualTime(fixture),
        resourceType: 'Condition',
        subject: { reference: `Patient/${visit.patientId}` },
        verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
      })
    }

    const rxCatalog = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/recommendations/prescription`,
      doctorRecommendationStateSchema,
    )
    expect(rxCatalog.missingInformation.some(msg => msg.includes('血清肌酐'))).toBe(true)

    const blockedRxGen = await fixture.request(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/recommendations/prescription/actions/generate`,
      { expectedInputFingerprint: rxCatalog.inputFingerprint, refresh: true },
      randomUUID(),
      { [`Encounter/${rxCatalog.encounterId}`]: rxCatalog.encounterVersion },
    )
    expect(blockedRxGen.status).toBe(409)
    expect(apiErrorSchema.parse(await blockedRxGen.json()).error.code).toBe('TASK_READINESS_CRITICAL_MISSING')

    const rxDetail = await fixture.read('doctor', `/api/his/v1/doctor/cases/${visit.caseId}`, doctorCaseDetailSchema)
    const rxClaim: AgentPageContextClaim = {
      activeSection: 'prescription',
      selection: { id: visit.caseId, kind: 'case', version: rxDetail.encounter.versionId },
      taskEpoch: 'b1b2c3d4-2345-4345-8345-23456789abcd',
      ui: { status: 'ready' },
      version: 1,
      viewId: 'consultation',
      viewRevision: 'consultation-1',
    }
    fixture.runtime.database.driver.prepare(`
      INSERT OR IGNORE INTO consultation (workspace_id, epoch, case_id, version)
      VALUES ('workspace-demo', ?, ?, 1)
    `).run(currentEpoch(fixture), visit.caseId)
    const rxCtxRes = await fixture.runtime.app.request('/api/agent/v1/page-contexts', {
      body: JSON.stringify({ claim: rxClaim, client: { id: 'doc-client', revision: 1 }, dshSessionId: 'dsh-dsap-rx-1' }),
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(rxCtxRes.status).toBe(201)
    const rxCtx = agentPageContextBindingSchema.parse(await rxCtxRes.json())
    const draftDef = agentToolCatalog.find(item => item.operationId === 'outpatient.prescription.draft.set')!
    const signDraftProof = (callId: string) => {
      const draftProofPayload = {
        callId,
        contextId: rxCtx.snapshot.id,
        dshSessionId: 'dsh-dsap-rx-1',
        expiresAt: rxCtx.snapshot.expiresAt,
        issuedAt: rxCtx.snapshot.issuedAt,
        origin: {
          request: { pageRevision: agentPageBindingRevision(rxClaim), scopeKey: rxCtx.snapshot.scopeKey },
          task: { acceptedAt: rxCtx.snapshot.issuedAt, contextId: rxCtx.snapshot.id, messageId: 'm-1', pageRevision: agentPageBindingRevision(rxClaim), rpcId: 'r-1', scopeKey: rxCtx.snapshot.scopeKey, turn: 1 },
        },
        pageRevision: agentPageBindingRevision(rxClaim),
        scopeKey: rxCtx.snapshot.scopeKey,
        toolName: draftDef.toolName,
        version: 3,
      }
      const draftB64 = Buffer.from(JSON.stringify(draftProofPayload), 'utf8').toString('base64url')
      return `${draftB64}.${createHmac('sha256', dshSecret).update(draftB64).digest('base64url')}`
    }
    const med = catalog.medications[0]!
    const draftPayload = {
      items: [{
        catalogItemId: med.id,
        courseDays: 7,
        doseText: med.defaultDoseText,
        frequencyCode: med.defaultFrequencyCode,
        quantity: 1,
        routeCode: med.defaultRouteCode,
      }],
    }
    const blockedDraftNoPack = await fixture.runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: rxCtx.token,
        executionProof: signDraftProof('call-rx-readiness-1'),
        input: draftPayload,
        operationId: 'outpatient.prescription.draft.set',
      }),
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(blockedDraftNoPack.status, await blockedDraftNoPack.clone().text()).toBe(409)
    expect(apiErrorSchema.parse(await blockedDraftNoPack.json()).error.code).toBe('TASK_READINESS_CRITICAL_MISSING')

    // Tier 2: insert valid creatinine (2160-0), missing HbA1c (4548-4) -> missing-secondary annotation, draft proceeds (201)
    insertLocalObservation(fixture, {
      code: '2160-0',
      display: '血清肌酐',
      encounterId: visit.encounterId,
      patientId: visit.patientId,
      unit: 'umol/L',
      value: 88,
    })
    const secondaryRxCatalog = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/recommendations/prescription`,
      doctorRecommendationStateSchema,
    )
    expect(secondaryRxCatalog.missingInformation.some(msg => msg.includes('HbA1c'))).toBe(true)
    expect(secondaryRxCatalog.missingInformation.every(msg => !msg.includes('血清肌酐'))).toBe(true)

    const allowedDraftTier2 = await fixture.runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: rxCtx.token,
        executionProof: signDraftProof('call-rx-readiness-2'),
        input: draftPayload,
        operationId: 'outpatient.prescription.draft.set',
      }),
      headers: { 'content-type': 'application/json', cookie: doctorCookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(allowedDraftTier2.status, await allowedDraftTier2.clone().text()).toBe(201)

    // Tier 3: insert valid HbA1c (4548-4) -> ready, no missing readiness labels remain
    insertLocalObservation(fixture, {
      code: '4548-4',
      display: '糖化血红蛋白 (HbA1c)',
      encounterId: visit.encounterId,
      patientId: visit.patientId,
      unit: '%',
      value: 7.2,
    })
    const readyRxCatalog = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${visit.caseId}/recommendations/prescription`,
      doctorRecommendationStateSchema,
    )
    expect(readyRxCatalog.missingInformation.every(msg => !msg.includes('血清肌酐') && !msg.includes('HbA1c'))).toBe(true)
  })
})
