import { randomUUID } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentHumanRoleCodeSchema, agentToolsForContext, agentViewsForRole, doctorCaseSectionSchema, inpatientStageSchema } from '@clinmesh/contracts/agent'
import { clinicalFactLedgerSchema } from '@clinmesh/contracts/clinical-fact-ledger'
import { clinicalPromptBundleSchema } from '@clinmesh/contracts/clinical-prompt-cards'
import { conceptVocabularyCatalogResponseSchema } from '@clinmesh/contracts/concept-vocabulary'
import { diseasePackCatalogListSchema, diseasePackRuntimeBundleSchema } from '@clinmesh/contracts/disease-pack'
import {
  EXAM_FAILURE_LAYERS,
  EXAM_PUBLIC_TRAP_KINDS,
  diseasePackActivationGateResponseSchema,
  dsapExamRunResponseSchema,
} from '@clinmesh/contracts/disease-pack-exam'
import { apiErrorSchema, createPatientResponseSchema, doctorCaseDetailSchema, doctorQueueSchema, registrationCatalogSchema, registrationResponseSchema, startVisitResponseSchema, triageResponseSchema } from '@clinmesh/contracts/his'
import { diseasePackKnowledgeEvaluationSchema } from '@clinmesh/contracts/knowledge-claims'
import { validateAndParseDiseasePack } from '@clinmesh/core/disease-pack'
import { computeDiseasePackFingerprint } from '../src/application/disease-pack-runtime-service.ts'
import { createPciPaymentDrgFixture, parsePciResponse, preparePciPaymentDrgFixture, type PciPaymentDrgFixture } from './fixtures/pci-payment-drg.ts'
import { payOutpatientInvestigation } from './fixtures/pay-outpatient-investigation.ts'
import { satisfyOutpatientOrderPrerequisites } from './fixtures/outpatient-order-gate.ts'

const SYNTHETIC_PACK_DIR = resolve(import.meta.dirname, 'fixtures/disease-packs/synthetic-test-syndrome-pack')

async function recomputeDirManifestFingerprint(packDir: string, mutate?: (rawPack: Record<string, unknown>) => void) {
  const manifestPath = join(packDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  const rawPack: Record<string, unknown> = { manifest }
  const splitFiles = ['triggers.json', 'stages.json', 'readiness.json', 'clinical.json', 'exam-suite.json', 'recognition-card.json', 'vocabulary.json', 'knowledge.json']
  const dirFiles = new Set(await readdir(packDir))
  for (const name of splitFiles) {
    if (dirFiles.has(name)) {
      Object.assign(rawPack, JSON.parse(await readFile(join(packDir, name), 'utf8')))
    }
  }
  if (mutate !== undefined) {
    mutate(rawPack)
    if (dirFiles.has('stages.json') && rawPack.stages !== undefined) {
      await writeFile(join(packDir, 'stages.json'), `${JSON.stringify({ stages: rawPack.stages }, null, 2)}\n`)
    }
    if (dirFiles.has('exam-suite.json') && rawPack.examSuite !== undefined) {
      await writeFile(join(packDir, 'exam-suite.json'), `${JSON.stringify({ examSuite: rawPack.examSuite }, null, 2)}\n`)
    }
    if (dirFiles.has('vocabulary.json') && rawPack.conceptVocabulary !== undefined) {
      await writeFile(join(packDir, 'vocabulary.json'), `${JSON.stringify({ conceptVocabulary: rawPack.conceptVocabulary }, null, 2)}\n`)
    }
    if (dirFiles.has('knowledge.json') && rawPack.knowledgeSnapshots !== undefined) {
      await writeFile(join(packDir, 'knowledge.json'), `${JSON.stringify({ knowledgeSnapshots: rawPack.knowledgeSnapshots }, null, 2)}\n`)
    }
  }
  const parsed = validateAndParseDiseasePack(rawPack)
  const fp = computeDiseasePackFingerprint(parsed as unknown as { manifest: Record<string, unknown> })
  ;(rawPack.manifest as Record<string, unknown>).fingerprint = fp
  await writeFile(manifestPath, `${JSON.stringify(rawPack.manifest, null, 2)}\n`)
}

describe('DSAP Slice S11: Exam Runner, 7 Public Traps, 5-Layer Attribution, AC10 Gate, AC26 Report, AC27 & AC28', () => {
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

  async function postAdminJson(fixture: PciPaymentDrgFixture, role: string, path: string, body: unknown, idempotencyKey?: string) {
    const cookie = await fixture.login(role)
    return fixture.runtime.app.request(path, {
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        cookie,
        ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
  }

  it('AC10 & AC26: runs machine-only exam & 7 public traps via HTTP, blocks failing pack activation (409 DSAP_EXAM_GATE_FAILED), and attributes unit faults to data-normalization', async () => {
    const { fixture, prepared } = await setupFixture()

    // Non-admin role cannot invoke admin exam runner
    const doctorDenied = await postAdminJson(fixture, 'doctor', '/api/his/v1/admin/disease-packs/exam/run', {})
    expect(doctorDenied.status).toBe(403)

    // 1. Run full machine exam suite + all 7 public traps on default registered packs
    const examRes = await postAdminJson(fixture, 'admin', '/api/his/v1/admin/disease-packs/exam/run', {})
    expect(examRes.status, await examRes.clone().text()).toBe(200)
    const examData = dsapExamRunResponseSchema.parse(await examRes.json())
    expect(examData.passed).toBe(true)
    expect(examData.llmInvocationCount).toBe(0)
    expect(prepared.modelCalls).toBe(0)

    const { report } = examData
    expect(report.llmInvocationCount).toBe(0)
    expect(report.migrationDiffCount).toBe(0)
    expect(report.coronaryRegressionPassed).toBe(true)
    expect(report.sourceSystemAgnostic.concluded).toBe(true)
    expect(report.packAdditionAudit.platformChangesZero).toBe(true)
    expect(Object.keys(report.failureSummaryByLayer).sort()).toEqual([...EXAM_FAILURE_LAYERS].sort())
    expect(report.publicTrapRun.passed).toBe(true)
    expect(report.publicTrapRun.passedTraps).toBe(7)
    expect(report.publicTrapRun.caseResults.map(c => c.publicTrapKind)).toEqual([...EXAM_PUBLIC_TRAP_KINDS])

    const coronaryRun = report.packRuns.find(r => r.packId === 'coronary-cad')!
    expect(coronaryRun.passed).toBe(true)
    expect(coronaryRun.categoriesCovered).toEqual(expect.arrayContaining([
      'standard-mild',
      'inpatient-severe',
      'missing-critical-data',
      'red-line-violation',
      'multi-disease-conflict',
      'over-testing-mild',
    ]))
    const fhRun = report.packRuns.find(r => r.packId === 'familial-hypercholesterolemia')!
    expect(fhRun.passed).toBe(true)

    // 2. Unit-conversion fault injection -> strictly attributed to layer: 'data-normalization'
    const faultRes = await postAdminJson(fixture, 'admin', '/api/his/v1/admin/disease-packs/exam/run', {
      injectFault: 'unit-conversion',
      packId: 'coronary-cad',
    })
    expect(faultRes.status).toBe(200)
    const faultData = dsapExamRunResponseSchema.parse(await faultRes.json())
    expect(faultData.passed).toBe(false)
    expect(faultData.report.failureSummaryByLayer['data-normalization'].failureCount).toBeGreaterThan(0)
    expect(
      faultData.report.packRuns[0]!.caseResults
        .filter(c => !c.passed)
        .every(c => c.attributedLayer === 'data-normalization'),
    ).toBe(true)

    // 3. AC10 Activation Gate: passing draft pack activates cleanly; corrupted draft pack returns 409 DSAP_EXAM_GATE_FAILED
    const passingDraftDir = await mkdtemp(join(tmpdir(), 'clinmesh-draft-pass-'))
    cleanups.push(() => rm(passingDraftDir, { recursive: true, force: true }))
    await cp(SYNTHETIC_PACK_DIR, passingDraftDir, { recursive: true })
    await recomputeDirManifestFingerprint(passingDraftDir, (raw) => {
      ;(raw.manifest as Record<string, unknown>).id = 'synthetic-draft-pass'
      ;(raw.manifest as Record<string, unknown>).status = 'draft'
      if (raw.conceptVocabulary && typeof raw.conceptVocabulary === 'object') {
        const vocab = raw.conceptVocabulary as { nodes?: Array<Record<string, unknown>> }
        for (const node of vocab.nodes ?? []) {
          if (node.packId !== undefined) node.packId = 'synthetic-draft-pass'
        }
      }
      if (Array.isArray(raw.knowledgeSnapshots)) {
        for (const snap of raw.knowledgeSnapshots as Array<{ claims?: Array<Record<string, unknown>>; topics?: Array<Record<string, unknown>> }>) {
          for (const claim of snap.claims ?? []) claim.packId = 'synthetic-draft-pass'
          for (const topic of snap.topics ?? []) topic.packId = 'synthetic-draft-pass'
        }
      }
    })

    const activateKey = randomUUID()
    const activateOkRes = await postAdminJson(
      fixture,
      'admin',
      '/api/his/v1/admin/disease-packs/synthetic-draft-pass/activate',
      { note: '验证通过后启用', packDir: passingDraftDir },
      activateKey,
    )
    expect(activateOkRes.status, await activateOkRes.clone().text()).toBe(200)
    const activated = diseasePackActivationGateResponseSchema.parse(await activateOkRes.json())
    expect(activated.activated).toBe(true)
    expect(activated.blocksActivation).toBe(false)
    expect(activated.gateDecision).toBe('approved')
    expect(activated.previousStatus).toBe('draft')
    expect(activated.status).toBe('active')
    expect(activated.llmInvocationCount).toBe(0)

    // Same-key replay succeeds idempotently
    const replayActivateRes = await postAdminJson(
      fixture,
      'admin',
      '/api/his/v1/admin/disease-packs/synthetic-draft-pass/activate',
      { note: '验证通过后启用', packDir: passingDraftDir },
      activateKey,
    )
    expect(replayActivateRes.status).toBe(200)

    // Corrupted pack exam suite -> exam/run fails AND activate returns 409 DSAP_EXAM_GATE_FAILED
    const failingDraftDir = await mkdtemp(join(tmpdir(), 'clinmesh-draft-fail-'))
    cleanups.push(() => rm(failingDraftDir, { recursive: true, force: true }))
    await cp(SYNTHETIC_PACK_DIR, failingDraftDir, { recursive: true })
    await recomputeDirManifestFingerprint(failingDraftDir, (raw) => {
      ;(raw.manifest as Record<string, unknown>).id = 'synthetic-draft-fail'
      ;(raw.manifest as Record<string, unknown>).status = 'draft'
      if (raw.conceptVocabulary && typeof raw.conceptVocabulary === 'object') {
        const vocab = raw.conceptVocabulary as { nodes?: Array<Record<string, unknown>> }
        for (const node of vocab.nodes ?? []) {
          if (node.packId !== undefined) node.packId = 'synthetic-draft-fail'
        }
      }
      if (Array.isArray(raw.knowledgeSnapshots)) {
        for (const snap of raw.knowledgeSnapshots as Array<{ claims?: Array<Record<string, unknown>>; topics?: Array<Record<string, unknown>> }>) {
          for (const claim of snap.claims ?? []) claim.packId = 'synthetic-draft-fail'
          for (const topic of snap.topics ?? []) topic.packId = 'synthetic-draft-fail'
        }
      }
      const suite = raw.examSuite as { cases: Array<Record<string, unknown>>; passThreshold: number }
      suite.cases[0]!.expectedStageId = 'intentionally-broken-stage'
      suite.cases[1]!.expectedActive = false
      suite.passThreshold = 0.95
    })

    const failExamRes = await postAdminJson(fixture, 'admin', '/api/his/v1/admin/disease-packs/exam/run', {
      packDir: failingDraftDir,
      packId: 'synthetic-draft-fail',
    })
    expect(failExamRes.status).toBe(200)
    const failExam = dsapExamRunResponseSchema.parse(await failExamRes.json())
    expect(failExam.passed).toBe(false)
    expect(failExam.report.activationGateSummary.blockedPacks[0]?.packId).toBe('synthetic-draft-fail')

    const blockActivateRes = await postAdminJson(
      fixture,
      'admin',
      '/api/his/v1/admin/disease-packs/synthetic-draft-fail/activate',
      { packDir: failingDraftDir },
      randomUUID(),
    )
    expect(blockActivateRes.status).toBe(409)
    const blockPayload = await blockActivateRes.json() as {
      error: {
        code: string
        details: {
          blocksActivation: boolean
          failedCases: Array<{ attributedLayer: string | null }>
          layerFailures: Record<string, number>
          packId: string
        }
      }
    }
    expect(apiErrorSchema.parse(blockPayload).error.code).toBe('DSAP_EXAM_GATE_FAILED')
    expect(blockPayload.error.details.blocksActivation).toBe(true)
    expect(blockPayload.error.details.packId).toBe('synthetic-draft-fail')
    expect(blockPayload.error.details.failedCases.length).toBeGreaterThan(0)
    expect(blockPayload.error.details.layerFailures.workflow).toBeGreaterThan(0)

    // AC10: Corrupting a clinical rule threshold (maxGapDays: 30 -> 1) WITHOUT changing examSuite fails exam & blocks activation
    const thresholdFailDir = await mkdtemp(join(tmpdir(), 'clinmesh-threshold-fail-'))
    cleanups.push(() => rm(thresholdFailDir, { recursive: true, force: true }))
    await cp(SYNTHETIC_PACK_DIR, thresholdFailDir, { recursive: true })
    await recomputeDirManifestFingerprint(thresholdFailDir, (raw) => {
      ;(raw.manifest as Record<string, unknown>).id = 'synthetic-threshold-fail'
      ;(raw.manifest as Record<string, unknown>).status = 'draft'
      if (raw.conceptVocabulary && typeof raw.conceptVocabulary === 'object') {
        const vocab = raw.conceptVocabulary as { nodes?: Array<Record<string, unknown>> }
        for (const node of vocab.nodes ?? []) {
          if (node.packId !== undefined) node.packId = 'synthetic-threshold-fail'
        }
      }
      if (Array.isArray(raw.knowledgeSnapshots)) {
        for (const snap of raw.knowledgeSnapshots as Array<{ claims?: Array<Record<string, unknown>>; topics?: Array<Record<string, unknown>> }>) {
          for (const claim of snap.claims ?? []) claim.packId = 'synthetic-threshold-fail'
          for (const topic of snap.topics ?? []) topic.packId = 'synthetic-threshold-fail'
        }
      }
      const stages = raw.stages as Array<{ entryCondition?: { maxGapDays?: number }; id: string }>
      const followupStage = stages.find(s => s.id === 'cross-encounter-followup')!
      followupStage.entryCondition!.maxGapDays = 1
    })

    const thresholdBlockRes = await postAdminJson(
      fixture,
      'admin',
      '/api/his/v1/admin/disease-packs/synthetic-threshold-fail/activate',
      { packDir: thresholdFailDir },
      randomUUID(),
    )
    expect(thresholdBlockRes.status).toBe(409)
    expect(apiErrorSchema.parse(await thresholdBlockRes.json()).error.code).toBe('DSAP_EXAM_GATE_FAILED')
    expect(prepared.modelCalls).toBe(0)
  }, 60_000)

  it('AC27, AC28 & AC15: loads full synthetic-test-syndrome-pack dynamically, proves all format reservations over HTTP, isolates default runtime, and leaks zero Case Truth', async () => {
    // 1. Default runtime NEVER loads or exposes synthetic-test-syndrome-pack
    const { fixture: defaultFixture } = await setupFixture({ withSyntheticPack: false })
    const defaultCatalog = await defaultFixture.read('doctor', '/api/his/v1/catalogs/disease-packs', diseasePackCatalogListSchema)
    expect(defaultCatalog.items.map(i => i.id)).not.toContain('synthetic-test-syndrome')

    // 2. Dynamic fixture runtime loads synthetic-test-syndrome-pack and runs all 6 exam categories cleanly
    const { fixture, prepared } = await setupFixture({ withSyntheticPack: true })
    const examRes = await postAdminJson(fixture, 'admin', '/api/his/v1/admin/disease-packs/exam/run', {
      packId: 'synthetic-test-syndrome',
    })
    expect(examRes.status, await examRes.clone().text()).toBe(200)
    const exam = dsapExamRunResponseSchema.parse(await examRes.json())
    expect(exam.passed).toBe(true)
    expect(exam.report.packRuns[0]!.categoriesCovered).toEqual(expect.arrayContaining([
      'standard-mild',
      'inpatient-severe',
      'missing-critical-data',
      'red-line-violation',
      'multi-disease-conflict',
      'over-testing-mild',
    ]))

    // Verify EVERY schema feature is populated on synthetic-test-syndrome-pack
    const synPack = fixture.runtime.diseasePacks.registry.getEffective('synthetic-test-syndrome').pack
    expect(synPack.triggers.some(t => t.condition.kind === 'allOf')).toBe(true)
    expect(synPack.stages.some(s => s.entryCondition.kind === 'sequence')).toBe(true)
    expect(synPack.inapplicablePopulations.length).toBeGreaterThan(0)
    expect(synPack.readinessTasks.length).toBeGreaterThan(0)
    expect(synPack.ruleOutChecklist?.length).toBeGreaterThan(0)
    expect(synPack.exitCriteria?.length).toBeGreaterThan(0)
    expect(synPack.confusablePacks?.length).toBeGreaterThan(0)
    expect(synPack.questionnaireItems?.length).toBeGreaterThan(0)
    expect(synPack.orderSets?.length).toBeGreaterThan(0)
    expect(synPack.pointScales?.length).toBeGreaterThan(0)
    expect(synPack.formulaRefs.length).toBeGreaterThan(0)
    expect(synPack.indicationRules?.length).toBeGreaterThan(0)
    expect(synPack.qualityTightenings.redLineRules.length).toBeGreaterThan(0)
    expect(synPack.riskTags?.length).toBeGreaterThan(0)
    expect(synPack.guidelineTopics?.length).toBeGreaterThan(0)
    expect(synPack.toolPolicy.allowedTools.length).toBeGreaterThan(0)
    expect(new Set(synPack.conceptVocabulary?.mappings.map(m => m.reviewStatus))).toEqual(
      new Set(['proposed', 'reviewed', 'approved', 'deprecated']),
    )
    expect(new Set(synPack.conceptVocabulary?.mappings.map(m => m.relation))).toEqual(
      new Set(['exact', 'close', 'broader', 'narrower']),
    )
    const lifecycleStatuses = new Set(
      (synPack.knowledgeSnapshots ?? []).flatMap(snap => snap.claims.map(c => c.status)),
    )
    expect(lifecycleStatuses).toEqual(new Set([
      'imported',
      'draft',
      'concept-mapped',
      'auto-verified',
      'clinician-reviewed',
      'published',
      'rejected',
      'superseded',
      'retracted',
    ]))

    // 3. AC28 HTTP runtime format reservations verification
    // 3a. Concept vocabulary 4 review statuses + effectiveDate check over HTTP
    const vocabCatalog = await fixture.read(
      'doctor',
      '/api/his/v1/catalogs/concept-vocabulary?packId=synthetic-test-syndrome&asOf=2026-08-24',
      conceptVocabularyCatalogResponseSchema,
    )
    expect(vocabCatalog.mappingEligibility.find(e => e.mappingId === 'syn-map-future-effective')?.reasonCode).toBe('MAPPING_NOT_EFFECTIVE')
    expect(vocabCatalog.mappingEligibility.find(e => e.mappingId === 'syn-map-deprecated-narrower')?.reasonCode).toBe('MAPPING_DEPRECATED')
    expect(vocabCatalog.mappingEligibility.find(e => e.mappingId === 'syn-map-reviewed-broader')?.reasonCode).toBe('MAPPING_NOT_APPROVED')
    expect(vocabCatalog.mappingEligibility.find(e => e.mappingId === 'syn-map-hs-ctni-exact')?.reasonCode).toBe('ELIGIBLE_EXACT')

    // 3b. Outpatient visit -> ledger provenance + hospitalId + knowledge lifecycle + prompt card deliveryMode/stale + AC15 zero CaseTruth leakage
    const patient = (await parsePciResponse(
      createPatientResponseSchema,
      await fixture.request('registrar', '/api/his/v1/patients', {
        birthDate: '1965-05-10',
        gender: 'male',
        identifier: `SYN-AC28-${randomUUID()}`,
        name: '合成格式预留验证患者',
      }, randomUUID(), {}),
    )).data.patient
    const regCat = await fixture.read('registrar', '/api/his/v1/catalogs/registration', registrationCatalogSchema)
    const reg = (await parsePciResponse(
      registrationResponseSchema,
      await fixture.request('registrar', '/api/his/v1/registrations/actions/register', {
        departmentId: regCat.departments[0]!.id,
        locationId: regCat.locations[0]!.id,
        patientId: patient.id,
        visitDate: regCat.virtualDate,
        visitTypeId: regCat.visitTypes[0]!.id,
      }, randomUUID(), { [`Patient/${patient.id}`]: patient.versionId }),
    )).data
    const triaged = await parsePciResponse(
      triageResponseSchema,
      await fixture.request('triage', `/api/his/v1/encounters/${reg.encounterId}/actions/record-triage`, {
        acuityCode: 'level-2',
        bloodPressure: { diastolicMmHg: 78, systolicMmHg: 126 },
        chiefComplaint: '冠心病复诊核验',
        heightCm: 170,
        oxygenSaturationPct: 98,
        pulseBpm: 76,
        respirationBpm: 18,
        temperatureC: 36.6,
        weightKg: 70,
      }, randomUUID(), { [`Encounter/${reg.encounterId}`]: '1', [`Task/${reg.queueTaskId}`]: '1' }),
    )
    await parsePciResponse(
      startVisitResponseSchema,
      await fixture.request('doctor', `/api/his/v1/encounters/${reg.encounterId}/actions/start-first-visit`, {}, randomUUID(), {
        [`Encounter/${reg.encounterId}`]: triaged.data.encounterVersion,
        [`Task/${triaged.data.doctorTaskId}`]: '1',
      }),
    )
    const queue = await fixture.read('doctor', '/api/his/v1/doctor/queue', doctorQueueSchema)
    const caseId = queue.items.find(r => r.encounterId === reg.encounterId)!.caseId

    // Confirm I25.103 diagnosis via FHIR/service & check ledger trace.hospitalId + provenance.sourceSystemId
    const doctorCookie = await fixture.login('doctor')
    await satisfyOutpatientOrderPrerequisites(fixture.runtime, doctorCookie, caseId)
    const scopeRow = fixture.runtime.database.driver.prepare(`
      SELECT workspace_id, epoch FROM scenario_run WHERE status = 'active' ORDER BY started_at DESC LIMIT 1
    `).get() as { epoch: string; workspace_id: string }
    fixture.runtime.fhir.create({ epoch: scopeRow.epoch, workspaceId: scopeRow.workspace_id }, {
      clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
      code: { coding: [{ code: 'I25.103', display: '冠状动脉粥样硬化性心脏病', system: 'http://hl7.org/fhir/sid/icd-10' }], text: '冠心病' },
      encounter: { reference: `Encounter/${reg.encounterId}` },
      id: `cond-ac28-${randomUUID()}`,
      recordedDate: '2026-08-24T09:00:00+08:00',
      resourceType: 'Condition',
      subject: { reference: `Patient/${patient.id}` },
      verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
    })

    const ledger = await fixture.read('doctor', `/api/his/v1/outpatient/cases/${caseId}/clinical-fact-ledger`, clinicalFactLedgerSchema)
    expect(ledger.trace.hospitalId).toBeTruthy()
    expect(ledger.facts.every(f => f.provenance.sourceSystemId.length > 0)).toBe(true)

    const packsBundle = await fixture.read('doctor', `/api/his/v1/outpatient/cases/${caseId}/disease-packs`, diseasePackRuntimeBundleSchema)
    expect(packsBundle.packs.find(p => p.packId === 'coronary-cad')?.packType).toBe('full')
    expect(packsBundle.packs.find(p => p.packId === 'familial-hypercholesterolemia')?.packType).toBe('recognition')

    const knowledgeAtV2 = await fixture.read(
      'doctor',
      `/api/his/v1/outpatient/cases/${caseId}/disease-packs/synthetic-test-syndrome/knowledge?includeRetired=true`,
      diseasePackKnowledgeEvaluationSchema,
    )
    expect(knowledgeAtV2.retiredClaimStatuses?.['syn-claim-retracted-v2']).toBe('retracted')

    const prompts = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${caseId}/clinical-prompts?timing=encounter-open`,
      clinicalPromptBundleSchema,
    )
    expect(prompts.llmInvocationCount).toBe(0)
    expect(prompts.cards.every(c => c.deliveryMode === 'display')).toBe(true)

    // AC15: CaseTruth never appears on clinician endpoints
    const detail = await fixture.read('doctor', `/api/his/v1/doctor/cases/${caseId}`, doctorCaseDetailSchema)
    expect(JSON.stringify(detail)).not.toContain('caseTruth')
    expect(JSON.stringify(packsBundle)).not.toContain('caseTruth')
    expect(JSON.stringify(exam)).not.toContain('caseTruth')
    expect(prepared.modelCalls).toBe(0)
    void payOutpatientInvestigation
  }, 60_000)

  it('keeps clinician Agent tools <= 32 per (role, view, section)', () => {
    for (const role of agentHumanRoleCodeSchema.options) {
      for (const view of agentViewsForRole(role)) {
        if (view === 'consultation') {
          for (const section of doctorCaseSectionSchema.options) {
            expect(agentToolsForContext(role, view, section).length).toBeLessThanOrEqual(32)
          }
        } else if (view === 'inpatient') {
          for (const stage of inpatientStageSchema.options) {
            expect(agentToolsForContext(role, view, stage).length).toBeLessThanOrEqual(32)
          }
        } else {
          expect(agentToolsForContext(role, view).length).toBeLessThanOrEqual(32)
        }
      }
    }
  })
})
