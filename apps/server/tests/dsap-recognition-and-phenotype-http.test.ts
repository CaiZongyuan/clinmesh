import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  clinicalFactLedgerSchema,
  clinicalFactVerificationResponseSchema,
} from '@clinmesh/contracts/clinical-fact-ledger'
import { clinicalPromptBundleSchema } from '@clinmesh/contracts/clinical-prompt-cards'
import { clinicalQualityCheckSchema } from '@clinmesh/contracts/clinical-quality'
import {
  diseasePackCatalogListSchema,
  diseasePackRuntimeBundleSchema,
  diseasePackToolAuthorizeResponseSchema,
} from '@clinmesh/contracts/disease-pack'
import {
  apiErrorSchema,
  caseLaboratoryCatalogSearchSchema,
  commandResponseSchema,
  doctorCaseDetailSchema,
  encounterCompletionPreviewSchema,
  encounterCompletionResponseSchema,
  issueLaboratoryRequestResponseSchema,
  issuePrescriptionResponseSchema,
  laboratoryRequestDraftResponseSchema,
  prescriptionDraftResponseSchema,
  registrationCatalogSchema,
  scenarioCommandResponseSchema,
  scenarioStateSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import {
  authoredCasePackPrepareResponseSchema,
  startSyntheticInpatientCaseResponseSchema,
} from '@clinmesh/contracts/inpatient-pci-data'
import {
  startSyntheticCaseResultSchema,
  syntheticCaseInstanceSchema,
} from '@clinmesh/contracts/scenario'
import { resolveEffectiveConceptVocabulary } from '@clinmesh/core/concept-vocabulary'
import { evaluatePackTrigger } from '@clinmesh/core/disease-pack'
import { SYNTHETIC_PHENOTYPE_KB, matchPhenotypeCandidates } from '@clinmesh/core/phenotype-matcher'
import {
  DiseasePackRegistry,
  computeDiseasePackFingerprint,
} from '../src/application/disease-pack-runtime-service.ts'
import { listFrozenDsapGoldenCases } from '../src/application/scenario-data/dsap-golden-case-pack.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { signIn } from './fixtures/imaging-scenario.ts'
import { satisfyOutpatientOrderPrerequisites } from './fixtures/outpatient-order-gate.ts'
import { payOutpatientInvestigation } from './fixtures/pay-outpatient-investigation.ts'

type Runtime = Awaited<ReturnType<typeof createClinMeshRuntime>>

const wstSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026'
const panelSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn'
const datasetReleaseId = 'laboratory-cn@2026-09-01.r1'
const demoPassword = 'Synthetic-Demo-Password-2026!'

describe('DSAP FH Recognition Pack (AC29) & Cross-Time Phenotype Matcher HTTP (AC30)', () => {
  let directory = ''
  let referenceDatabasePath = ''
  let runtime: Runtime | undefined
  let llmCallCount = 0
  let currentEpoch = 'epoch-2'
  const cookies = {
    admin: '',
    doctor: '',
    inpatientDoctor: '',
    registrar: '',
    triage: '',
    wardNurse: '',
  }
  const current = () => runtime!

  async function postJson(path: string, cookie: string, body: unknown, method: 'POST' | 'PUT' = 'POST') {
    return current().app.request(path, {
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

  async function dispatchAll() {
    while ((await current().dispatcher.dispatchOnce()) !== undefined) {
      // drain queued tasks
    }
  }

  async function prepareBothFrozenPacks(expectedEpoch: string) {
    const authoredRes = await postJson('/api/sim/v1/synthetic-cases/authored-pack/prepare', cookies.admin, {
      input: { expectedEpoch },
    })
    expect(authoredRes.status, await authoredRes.clone().text()).toBe(200)
    const authored = authoredCasePackPrepareResponseSchema.parse(await authoredRes.json()).data

    const goldenRes = await postJson('/api/sim/v1/synthetic-cases/golden-pack/prepare', cookies.admin, {
      input: { expectedEpoch },
    })
    expect(goldenRes.status, await goldenRes.clone().text()).toBe(200)
    const golden = authoredCasePackPrepareResponseSchema.parse(await goldenRes.json()).data

    return [...authored.cases, ...golden.cases]
  }

  async function openOutpatientVisit(caseId: string, chiefComplaint: string) {
    const ready = current()
    const syntheticCase = syntheticCaseInstanceSchema.parse(await (await ready.app.request(
      `/api/sim/v1/synthetic-cases/${caseId}`,
      { headers: { cookie: cookies.admin } },
    )).json())
    const registration = registrationCatalogSchema.parse(await (await ready.app.request(
      '/api/his/v1/catalogs/registration',
      { headers: { cookie: cookies.admin } },
    )).json())
    const startRes = await postJson(
      `/api/his/v1/synthetic-cases/${syntheticCase.caseId}/actions/start-outpatient-visit`,
      cookies.registrar,
      {
        activeBriefRevision: syntheticCase.activeBriefRevision,
        departmentId: registration.departments[0]!.id,
        expectedCaseRevision: syntheticCase.revision,
        locationId: registration.locations[0]!.id,
        visitDate: registration.virtualDate,
        visitTypeId: registration.visitTypes[0]!.id,
      },
    )
    expect(startRes.status, await startRes.clone().text()).toBe(200)
    const started = commandResponseSchema(startSyntheticCaseResultSchema).parse(await startRes.json()).data

    const triageRes = await postJson(
      `/api/his/v1/encounters/${started.encounterId}/actions/record-triage`,
      cookies.triage,
      {
        expectedVersions: { [`Encounter/${started.encounterId}`]: '1', [`Task/${started.queueTaskId}`]: '1' },
        input: {
          acuityCode: 'level-3',
          bloodPressure: { diastolicMmHg: 78, systolicMmHg: 124 },
          chiefComplaint,
          oxygenSaturationPct: 99,
          pulseBpm: 76,
          respirationBpm: 16,
          temperatureC: 36.6,
        },
      },
    )
    expect(triageRes.status, await triageRes.clone().text()).toBe(200)
    const triage = triageResponseSchema.parse(await triageRes.json()).data

    const firstVisitRes = await postJson(
      `/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`,
      cookies.doctor,
      {
        expectedVersions: { [`Encounter/${started.encounterId}`]: '2', [`Task/${triage.doctorTaskId}`]: '1' },
        input: {},
      },
    )
    expect(firstVisitRes.status, await firstVisitRes.clone().text()).toBe(200)
    return started
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'clinmesh-dsap-fh-recognition-'))
    referenceDatabasePath = join(directory, 'reference.sqlite')
    const upperRule = (high: number, simulationLow: number) => ({
      high,
      notes: '合成成人参考上限',
      referenceKind: 'upper-bound' as const,
      sex: 'all' as const,
      simulationHigh: high,
      simulationLow,
      sourceLocation: '表 1',
      sourceStandard: 'WS/T 886-2026',
      sourceType: 'project-curated' as const,
      sourceVersion: '2026-09-01',
    })
    const rangeRule = (low: number, high: number) => ({
      high,
      low,
      notes: '合成成人参考区间',
      referenceKind: 'range' as const,
      sex: 'all' as const,
      simulationHigh: high,
      simulationLow: low,
      sourceLocation: '表 1',
      sourceStandard: 'WS/T 886-2026',
      sourceType: 'national-standard' as const,
      sourceVersion: '2026',
    })
    const testItem = (
      code: string,
      display: string,
      specimen: string,
      unitCode: string,
      precision: number,
      rules: Array<ReturnType<typeof rangeRule> | ReturnType<typeof upperRule>>,
    ) => ({
      concept: {
        code,
        display,
        domain: 'laboratory' as const,
        id: `wst-886:2026:${code}`,
        sourceLocator: `synthetic:laboratory-cn:test:${code}`,
        status: 'active' as const,
        system: wstSystem,
        version: '2026',
      },
      definition: {
        adultReferenceRules: rules,
        alternateCodings: [],
        analyte: display,
        category: '临床检验',
        conceptId: `wst-886:2026:${code}`,
        datasetReleaseId,
        healthyStrategy: 'uniform' as const,
        kind: 'laboratory-cn-test' as const,
        precision,
        resultKind: 'quantity' as const,
        scale: '定量',
        sourceLocator: `synthetic:laboratory-cn:test:${code}`,
        sourceVersion: '2026',
        specimen,
        unit: { code: unitCode, display: unitCode, system: 'http://unitsofmeasure.org' as const },
      },
    })
    const panelItem = (code: string, display: string, specimen: string, members: string[]) => ({
      concept: {
        code,
        display,
        domain: 'laboratory' as const,
        id: `laboratory-panel-cn:2026-09-01:${code}`,
        sourceLocator: `synthetic:laboratory-cn:panel:${code}`,
        status: 'active' as const,
        system: panelSystem,
        version: '2026-09-01',
      },
      definition: {
        conceptId: `laboratory-panel-cn:2026-09-01:${code}`,
        datasetReleaseId,
        kind: 'laboratory-cn-panel' as const,
        notes: display,
        sourceLocation: '检验组合',
        sourceLocator: `synthetic:laboratory-cn:panel:${code}`,
        sourceType: 'project-authored' as const,
        sourceVersion: '2026-09-01',
        specimen,
      },
      members: members.map((memberCode, index) => ({
        memberConceptId: `wst-886:2026:${memberCode}`,
        memberOrder: index + 1,
        panelConceptId: `laboratory-panel-cn:2026-09-01:${code}`,
        relationship: 'contains' as const,
        sourceLocator: `synthetic:laboratory-cn:panel:${code}:${index + 1}`,
      })),
    })

    const tests = [
      testItem('2000104A', '总胆固醇测定', '血清、血浆', 'mmol/L', 2, [upperRule(5.2, 3.1)]),
      testItem('2000204A', '甘油三酯测定', '血清、血浆', 'mmol/L', 2, [upperRule(1.7, 0.5)]),
      testItem('2000304A', '高密度脂蛋白胆固醇测定', '血清、血浆', 'mmol/L', 2, [rangeRule(1.0, 2.0)]),
      testItem('2000404A', '低密度脂蛋白胆固醇测定', '血清、血浆', 'mmol/L', 2, [upperRule(3.4, 1.5)]),
      testItem('2000604A', '载脂蛋白A1测定', '血清、血浆', 'g/L', 2, [rangeRule(1.0, 1.6)]),
      testItem('2000704A', '载脂蛋白B测定', '血清、血浆', 'g/L', 2, [rangeRule(0.6, 1.1)]),
      testItem('2100104A', '肌酸激酶同工酶测定', '血清、血浆', 'U/L', 1, [upperRule(24, 2)]),
      testItem('2100304A', '肌红蛋白测定', '血清、血浆', 'ng/mL', 1, [upperRule(72, 10)]),
      testItem('2100404A', '心肌肌钙蛋白I测定', '血清、血浆', 'ng/mL', 3, [upperRule(0.04, 0.002)]),
      testItem('2100504A', '心肌肌钙蛋白T测定', '血清、血浆', 'ng/mL', 3, [upperRule(0.014, 0.003)]),
      testItem('2100604A', '脑利钠肽测定', '血清、血浆', 'ng/L', 1, [upperRule(100, 5)]),
      testItem('2100704A', '氨基末端脑利钠肽前体测定', '血清、血浆', 'ng/L', 0, [upperRule(125, 15)]),
      testItem('1700404A', '肌酐测定', '血清、血浆', 'umol/L', 0, [rangeRule(57, 97)]),
      testItem('1201004A', '促甲状腺激素测定', '血清、血浆', 'mIU/L', 2, [rangeRule(0.27, 4.2)]),
    ]
    const panels = [
      panelItem('CN-LAB-LIPIDS', '血脂全套组合', '血清、血浆', ['2000104A', '2000204A', '2000304A', '2000404A', '2000604A', '2000704A']),
      panelItem('CN-LAB-CARDIAC', '心肌损伤标志物组合', '血清、血浆', ['2100104A', '2100304A', '2100404A', '2100504A', '2100604A', '2100704A']),
    ]
    const diagnosisConcepts = [
      { code: 'I25.103', display: '冠状动脉粥样硬化性心脏病', row: 12670 },
      { code: 'E78.01', display: '家族性高胆固醇血症', row: 11204 },
      { code: 'N04.9', display: '肾病综合征', row: 13890 },
      { code: 'R07.3', display: '其他胸痛', row: 14001 },
    ].map(({ code, display, row }) => ({
      code,
      display,
      domain: 'diagnosis' as const,
      id: `nhsa-diagnosis:nhc-icd10-clinical@2022.r4:${code}`,
      sourceLocator: `cn-health:nhc-icd10-clinical@2022.r4:diagnosis:${row}`,
      status: 'active' as const,
      system: 'urn:clinmesh:reference:nhsa-diagnosis',
      version: '2022',
    }))

    const artifactJson = `${JSON.stringify({
      concepts: [...diagnosisConcepts, ...tests.map(item => item.concept), ...panels.map(item => item.concept)],
      laboratoryDefinitions: [...tests.map(item => item.definition), ...panels.map(item => item.definition)],
      laboratoryPanelMembers: panels.flatMap(item => item.members),
      laboratorySpecimens: [],
      laboratoryUnits: [],
      medicationProducts: syntheticNhsaMedicationProductSnapshot,
      schemaVersion: '1',
    })}\n`
    const manifestPath = join(directory, 'dsap-fh-release.json')
    await writeFile(join(directory, 'dsap-fh-reference.json'), artifactJson)
    await writeFile(manifestPath, `${JSON.stringify({
      createdAt: '2026-09-02T00:00:00.000Z',
      releaseId: 'dsap-fh-recognition-reference-v1',
      schemaVersion: '1',
      sources: [{
        acquisitionMethod: 'generated',
        artifactPath: 'dsap-fh-reference.json',
        checksum: createHash('sha256').update(artifactJson).digest('hex'),
        licenseId: 'LicenseRef-Synthetic-Test',
        retrievedAt: '2026-09-02T00:00:00.000Z',
        sourceId: 'cn-health-fh-recognition',
        sourceUrl: 'https://example.test/fh-recognition',
        upstreamVersion: '2026-09-01',
      }],
    })}\n`)
    await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
    await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', manifestPath])

    runtime = await createClinMeshRuntime({
      activeReferenceReleaseId: 'dsap-fh-recognition-reference-v1',
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      chatCompletionsProvider: {
        completeJson: async () => {
          llmCallCount += 1
          throw new Error('LLM fallback must never be called during deterministic recognition/phenotype matching')
        },
      },
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'operational.sqlite'),
      demoPassword,
      investigationModel: 'unexpected-investigation-model',
      migrationMode: 'apply',
      referenceDatabasePath,
      trustedOrigins: ['http://localhost'],
    })

    const ready = current()
    cookies.admin = await signIn(ready, 'admin@demo.clinmesh.local')
    cookies.doctor = await signIn(ready, 'doctor@demo.clinmesh.local')
    cookies.inpatientDoctor = await signIn(ready, 'inpatient-doctor@demo.clinmesh.local')
    cookies.registrar = await signIn(ready, 'registrar@demo.clinmesh.local')
    cookies.triage = await signIn(ready, 'triage@demo.clinmesh.local')
    cookies.wardNurse = await signIn(ready, 'ward-nurse@demo.clinmesh.local')

    const scenario = scenarioStateSchema.parse(await (await ready.app.request(
      '/api/sim/v1/scenario-runs/current',
      { headers: { cookie: cookies.admin } },
    )).json())
    const resetRes = await postJson(`/api/sim/v1/scenario-runs/${scenario.scenarioRunId}/actions/reset`, cookies.admin, {})
    expect(resetRes.status).toBe(200)
    currentEpoch = scenarioCommandResponseSchema.parse(await resetRes.json()).data.epoch
    expect(currentEpoch).toBe('epoch-2')
  }, 60_000)

  afterAll(async () => {
    await runtime?.close()
    if (directory !== '') await rm(directory, { force: true, recursive: true })
  })

  it('auto-discovers familial-hypercholesterolemia recognition pack with valid SHA-256 fingerprint', async () => {
    const ready = current()
    const registry = new DiseasePackRegistry()
    const effective = registry.getEffective('familial-hypercholesterolemia')
    expect(effective).toBeDefined()
    expect(effective!.pack.manifest.packType).toBe('recognition')
    expect(effective!.pack.manifest.status).toBe('active')
    expect(computeDiseasePackFingerprint(effective!.pack)).toMatch(/^[a-f0-9]{64}$/)

    const catalogRes = await ready.app.request('/api/his/v1/catalogs/disease-packs', {
      headers: { cookie: cookies.doctor },
    })
    expect(catalogRes.status).toBe(200)
    const catalog = diseasePackCatalogListSchema.parse(await catalogRes.json())
    expect(catalog.items.map(item => item.id)).toEqual(expect.arrayContaining([
      'coronary-cad',
      'familial-hypercholesterolemia',
    ]))
    const fhCatalog = catalog.items.find(item => item.id === 'familial-hypercholesterolemia')!
    expect(fhCatalog.packType).toBe('recognition')
    expect(fhCatalog.status).toBe('active')
    expect(fhCatalog.fingerprint).toBe(effective!.pack.manifest.fingerprint)
  })

  it('activates familial-hypercholesterolemia ONLY on fh-premature-cad-clue-v1 and stays inactive across all other 9 frozen golden cases', async () => {
    const ready = current()
    const frozenDefinitions = listFrozenDsapGoldenCases()
    expect(frozenDefinitions).toHaveLength(10)

    const preparedCases = await prepareBothFrozenPacks(currentEpoch)
    expect(preparedCases).toHaveLength(10)

    const activationByDraftId = new Map<string, { status: string; reason: string }>()
    const startedOutpatientByDraftId = new Map<string, Awaited<ReturnType<typeof openOutpatientVisit>>>()
    let inpatientBedIndex = 0

    for (const def of frozenDefinitions) {
      const entry = preparedCases.find(item => item.draftId === def.definition.id)!
      expect(entry.case, `Missing prepared case for ${def.definition.id}`).toBeDefined()
      const preparedCaseId = entry.case!.caseId

      if (def.definition.recommendedEntry === 'inpatient') {
        inpatientBedIndex += 1
        const bedId = `bed-general-${inpatientBedIndex}`
        const syntheticCase = syntheticCaseInstanceSchema.parse(await (await ready.app.request(
          `/api/sim/v1/synthetic-cases/${preparedCaseId}`,
          { headers: { cookie: cookies.admin } },
        )).json())
        const startInpatientRes = await postJson(
          `/api/his/v1/synthetic-cases/${syntheticCase.caseId}/actions/start-inpatient-visit`,
          cookies.registrar,
          {
            activeBriefRevision: syntheticCase.activeBriefRevision,
            expectedCaseRevision: syntheticCase.revision,
            expectedEpoch: currentEpoch,
            wardId: 'ward-general',
          },
        )
        expect(startInpatientRes.status, await startInpatientRes.clone().text()).toBe(200)
        const inpatientStarted = startSyntheticInpatientCaseResponseSchema.parse(await startInpatientRes.json()).data

        const detail = inpatientDetailSchema.parse(await (await ready.app.request(
          `/api/his/v1/inpatient/admissions/${inpatientStarted.admissionId}`,
          { headers: { cookie: cookies.wardNurse } },
        )).json())
        const receiveRes = await postJson(
          `/api/his/v1/inpatient/admissions/${inpatientStarted.admissionId}/receive`,
          cookies.wardNurse,
          { input: { bedId, encounterVersion: detail.admission.versionId } },
        )
        expect(receiveRes.status, await receiveRes.clone().text()).toBe(200)
        inpatientCommandResponseSchema.parse(await receiveRes.json())

        const bundleRes = await ready.app.request(
          `/api/his/v1/inpatient/admissions/${inpatientStarted.admissionId}/disease-packs`,
          { headers: { cookie: cookies.inpatientDoctor } },
        )
        expect(bundleRes.status).toBe(200)
        const bundle = diseasePackRuntimeBundleSchema.parse(await bundleRes.json())
        const fhRuntime = bundle.packs.find(pack => pack.packId === 'familial-hypercholesterolemia')!
        activationByDraftId.set(def.definition.id, {
          reason: fhRuntime.activationReason,
          status: fhRuntime.activationStatus,
        })
      } else {
        const started = await openOutpatientVisit(preparedCaseId, def.definition.chiefComplaint)
        startedOutpatientByDraftId.set(def.definition.id, started)

        const bundleRes = await ready.app.request(
          `/api/his/v1/outpatient/cases/${started.outpatientCaseId}/disease-packs`,
          { headers: { cookie: cookies.doctor } },
        )
        expect(bundleRes.status).toBe(200)
        const bundle = diseasePackRuntimeBundleSchema.parse(await bundleRes.json())
        const fhRuntime = bundle.packs.find(pack => pack.packId === 'familial-hypercholesterolemia')!
        activationByDraftId.set(def.definition.id, {
          reason: fhRuntime.activationReason,
          status: fhRuntime.activationStatus,
        })
      }
    }

    for (const def of frozenDefinitions) {
      const outcome = activationByDraftId.get(def.definition.id)!
      if (def.definition.id === 'fh-premature-cad-clue-v1') {
        expect(outcome.status).toBe('active')
      } else {
        expect(outcome.status, `Expected ${def.definition.id} NOT to activate FH`).toBe('inactive')
        expect(outcome.reason).toBe('not-triggered')
      }
    }

    // Verify negative outpatient golden controls also yield 0 candidates in matchPhenotypeCandidates
    const registry = new DiseasePackRegistry()
    const fhPack = registry.getEffective('familial-hypercholesterolemia')!.pack
    const effectiveVocab = resolveEffectiveConceptVocabulary({
      packLayer: fhPack.conceptVocabulary,
    })

    for (const negativeDraftId of ['trap-low-risk-chest-wall-pain-v1', 'trap-external-creatinine-v1']) {
      const negVisit = startedOutpatientByDraftId.get(negativeDraftId)!
      const negLedger = clinicalFactLedgerSchema.parse(await (await ready.app.request(
        `/api/his/v1/outpatient/cases/${negVisit.outpatientCaseId}/clinical-fact-ledger`,
        { headers: { cookie: cookies.doctor } },
      )).json())
      const negDef = frozenDefinitions.find(d => d.definition.id === negativeDraftId)!.definition
      const negMatch = matchPhenotypeCandidates({
        knowledgeBase: SYNTHETIC_PHENOTYPE_KB,
        ledger: negLedger,
        patientBirthDate: negDef.patient.birthDate,
        patientSex: negDef.patient.gender,
        vocabulary: effectiveVocab,
      })
      expect(negMatch.llmInvocationCount).toBe(0)
      expect(negMatch.candidates).toHaveLength(0)
    }

    // Deep verification on FH golden case WITHOUT E78.01 diagnosis
    const fhVisit = startedOutpatientByDraftId.get('fh-premature-cad-clue-v1')!
    const unverifiedLedger = clinicalFactLedgerSchema.parse(await (await ready.app.request(
      `/api/his/v1/outpatient/cases/${fhVisit.outpatientCaseId}/clinical-fact-ledger`,
      { headers: { cookie: cookies.doctor } },
    )).json())

    // Before clinician verification, matchPhenotypeCandidates excludes external-unverified facts
    const preVerifMatch = matchPhenotypeCandidates({
      knowledgeBase: SYNTHETIC_PHENOTYPE_KB,
      ledger: unverifiedLedger,
      patientBirthDate: '1988-03-18',
      patientSex: 'male',
      vocabulary: effectiveVocab,
    })
    expect(preVerifMatch.llmInvocationCount).toBe(0)
    expect(preVerifMatch.excludedFactSummary.externalUnverifiedCount).toBeGreaterThanOrEqual(3)
    expect(preVerifMatch.candidates).toHaveLength(0)

    // Clinician verifies all external history facts (2023 LDL, 2025 LDL, Z82.4 family history)
    for (const fact of unverifiedLedger.facts.filter(f => f.institutionScope === 'external')) {
      const verRes = await postJson(
        `/api/his/v1/outpatient/cases/${fhVisit.outpatientCaseId}/clinical-fact-verifications`,
        cookies.doctor,
        {
          decision: 'verified',
          expectedSourceVersion: fact.provenance.recordVersion,
          factId: fact.factId,
          note: '核对确认外院跨期血脂及早发心肌梗死家族史',
        },
      )
      expect(verRes.status, await verRes.clone().text()).toBe(200)
      clinicalFactVerificationResponseSchema.parse(await verRes.json())
    }

    // Confirm ONLY CAD (diagnosis-coronary-heart-disease / I25.103), WITHOUT E78.01, and run CN-LAB-LIPIDS
    await satisfyOutpatientOrderPrerequisites(ready, cookies.doctor, fhVisit.outpatientCaseId, {
      diagnosisCatalogItemId: 'diagnosis-coronary-heart-disease',
    })
    const publishedLabs = caseLaboratoryCatalogSearchSchema.parse(await (await ready.app.request(
      `/api/his/v1/doctor/cases/${fhVisit.outpatientCaseId}/reference-catalogs/laboratory?page=1&pageSize=20`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    const lipidsService = publishedLabs.items.find(item => item.referenceConcept.code === 'CN-LAB-LIPIDS')!
    expect(lipidsService).toBeDefined()

    const detailBeforeLab = doctorCaseDetailSchema.parse(await (await ready.app.request(
      `/api/his/v1/doctor/cases/${fhVisit.outpatientCaseId}`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    const savedLabDraft = laboratoryRequestDraftResponseSchema.parse(await (await postJson(
      `/api/his/v1/encounters/${fhVisit.encounterId}/laboratory-request/draft`,
      cookies.doctor,
      {
        expectedVersions: { [`Encounter/${fhVisit.encounterId}`]: detailBeforeLab.encounter.versionId },
        input: {
          catalogItemId: lipidsService.id,
          expectedDraftVersion: detailBeforeLab.laboratoryRequests?.draftVersion ?? 0,
          indicationCode: lipidsService.allowedIndicationCodes[0]!,
        },
      },
      'PUT',
    )).json()).data
    const detailDraft = doctorCaseDetailSchema.parse(await (await ready.app.request(
      `/api/his/v1/doctor/cases/${fhVisit.outpatientCaseId}`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    const issuedLab = issueLaboratoryRequestResponseSchema.parse(await (await postJson(
      `/api/his/v1/encounters/${fhVisit.encounterId}/laboratory-request/actions/issue`,
      cookies.doctor,
      {
        expectedVersions: { [`Encounter/${fhVisit.encounterId}`]: detailDraft.encounter.versionId },
        input: { expectedDraftVersion: savedLabDraft.draftVersion },
      },
    )).json()).data.request
    await payOutpatientInvestigation(ready, {
      caseId: fhVisit.outpatientCaseId,
      category: 'laboratory',
      chargeItemId: issuedLab.billing!.chargeItemId,
    })
    await dispatchAll()

    const detailAfterDispatch = doctorCaseDetailSchema.parse(await (await ready.app.request(
      `/api/his/v1/doctor/cases/${fhVisit.outpatientCaseId}`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    const reportedLipids = detailAfterDispatch.laboratoryRequests!.requests.find(r => r.id === issuedLab.id)!
    expect(reportedLipids.status).toBe('reported')
    const ackLabRes = await postJson(
      `/api/his/v1/laboratory-requests/${reportedLipids.id}/reports/${reportedLipids.report!.diagnosticReportId}/actions/acknowledge`,
      cookies.doctor,
      {
        expectedVersions: {
          [`DiagnosticReport/${reportedLipids.report!.diagnosticReportId}`]: reportedLipids.report!.diagnosticReportVersion,
        },
        input: { expectedRequestVersion: reportedLipids.version },
      },
    )
    expect(ackLabRes.status, await ackLabRes.clone().text()).toBe(200)

    // Check FH recognition pack activation without E78.01 + recognitionCard clues
    const postLabBundle = diseasePackRuntimeBundleSchema.parse(await (await ready.app.request(
      `/api/his/v1/outpatient/cases/${fhVisit.outpatientCaseId}/disease-packs`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    const fhActive = postLabBundle.packs.find(pack => pack.packId === 'familial-hypercholesterolemia')!
    expect(fhActive.activationStatus).toBe('active')
    expect(fhActive.matchedTriggerIds).toEqual(expect.arrayContaining([
      'fh-longitudinal-ldl-and-cad-or-fhx',
      'fh-fhx-and-marked-ldl-cross-time',
    ]))
    expect(fhActive.matchedTriggerIds).not.toContain('fh-confirmed-diagnosis')
    expect(fhActive.recognitionCard).not.toBeNull()
    expect(fhActive.recognitionCard!.id).toBe('fh-cross-time-recognition')
    expect(fhActive.recognitionCard!.differentialPackIds).toContain('coronary-cad')
    expect(fhActive.recognitionCard!.summaryZh).toContain('4.9')
    expect(fhActive.recognitionCard!.summaryZh).toContain('Z82.4')
    expect(fhActive.recognitionCard!.escalationGuidanceZh).toContain('LDLR')
    expect(fhActive.recognitionCard!.escalationGuidanceZh).toContain('肌腱黄色瘤')

    // Verify cross-time matchedFactIds directly on the verified HTTP ledger
    const verifiedLedger = clinicalFactLedgerSchema.parse(await (await ready.app.request(
      `/api/his/v1/outpatient/cases/${fhVisit.outpatientCaseId}/clinical-fact-ledger`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    const longTrigger = fhPack.triggers.find(t => t.id === 'fh-longitudinal-ldl-and-cad-or-fhx')!
    const triggerEval = evaluatePackTrigger(longTrigger.condition, verifiedLedger)
    expect(triggerEval.matched).toBe(true)
    expect(triggerEval.matchedFactIds.length).toBeGreaterThanOrEqual(3)

    // Tool policy: read-only authorized (200), write / forbidden action denied (403)
    const readAuthRes = await postJson(
      `/api/his/v1/outpatient/cases/${fhVisit.outpatientCaseId}/disease-packs/familial-hypercholesterolemia/tools/authorize`,
      cookies.doctor,
      { operationId: 'outpatient.disease-packs.read' },
    )
    expect(readAuthRes.status).toBe(200)
    expect(diseasePackToolAuthorizeResponseSchema.parse(await readAuthRes.json()).authorized).toBe(true)

    const forbiddenWriteRes = await postJson(
      `/api/his/v1/outpatient/cases/${fhVisit.outpatientCaseId}/disease-packs/familial-hypercholesterolemia/tools/authorize`,
      cookies.doctor,
      { operationId: 'outpatient.prescription.issue' },
    )
    expect(forbiddenWriteRes.status).toBe(403)
    expect(apiErrorSchema.parse(await forbiddenWriteRes.json()).error.code).toBe('DSAP_TOOL_POLICY_DENIED')

    const forbiddenActionRes = await postJson(
      `/api/his/v1/outpatient/cases/${fhVisit.outpatientCaseId}/disease-packs/familial-hypercholesterolemia/tools/authorize`,
      cookies.doctor,
      { actionTag: 'auto-prescribe-medication', operationId: 'outpatient.disease-packs.read' },
    )
    expect(forbiddenActionRes.status).toBe(403)
    expect(apiErrorSchema.parse(await forbiddenActionRes.json()).error.code).toBe('DSAP_TOOL_POLICY_DENIED')

    // Non-blocking: quality gates & prescription + encounter completion never blocked by FH recognition pack
    const rxGate = clinicalQualityCheckSchema.parse(await (await ready.app.request(
      `/api/his/v1/encounters/${fhVisit.encounterId}/clinical-quality?gate=outpatient-prescription`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    expect(rxGate.sourcePacks).not.toContain('familial-hypercholesterolemia')
    expect(rxGate.alerts.some(alert => alert.code.startsWith('FH_'))).toBe(false)
    expect(rxGate.redLines.some(rule => rule.code.startsWith('FH_'))).toBe(false)

    const detailForRx = doctorCaseDetailSchema.parse(await (await ready.app.request(
      `/api/his/v1/doctor/cases/${fhVisit.outpatientCaseId}`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    const rxDraftRes = await postJson(
      `/api/his/v1/encounters/${fhVisit.encounterId}/prescription/draft`,
      cookies.doctor,
      {
        expectedVersions: { [`Encounter/${fhVisit.encounterId}`]: detailForRx.encounter.versionId },
        input: {
          expectedDraftVersion: 0,
          items: [
            {
              catalogItemId: 'medication-pci-aspirin',
              courseDays: 30,
              doseText: '100 mg',
              frequencyCode: 'QD',
              quantity: 30,
              routeCode: 'PO',
            },
            {
              catalogItemId: 'medication-pci-atorvastatin',
              courseDays: 30,
              doseText: '20 mg',
              frequencyCode: 'QN',
              quantity: 30,
              routeCode: 'PO',
            },
          ],
        },
      },
      'PUT',
    )
    expect(rxDraftRes.status, await rxDraftRes.clone().text()).toBe(200)
    const rxDraft = prescriptionDraftResponseSchema.parse(await rxDraftRes.json()).data

    const detailAfterRxDraft = doctorCaseDetailSchema.parse(await (await ready.app.request(
      `/api/his/v1/doctor/cases/${fhVisit.outpatientCaseId}`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    const rxGateAfterDraft = clinicalQualityCheckSchema.parse(await (await ready.app.request(
      `/api/his/v1/encounters/${fhVisit.encounterId}/clinical-quality?gate=outpatient-prescription`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    expect(rxGateAfterDraft.sourcePacks).not.toContain('familial-hypercholesterolemia')
    expect(rxGateAfterDraft.redLines.some(rule => rule.code.startsWith('FH_'))).toBe(false)

    const acknowledgedRxAlerts = rxGateAfterDraft.alerts.map(a => a.code)
    const rxIssueRes = await postJson(
      `/api/his/v1/encounters/${fhVisit.encounterId}/prescription/actions/issue`,
      cookies.doctor,
      {
        expectedVersions: { [`Encounter/${fhVisit.encounterId}`]: detailAfterRxDraft.encounter.versionId },
        input: {
          expectedDraftVersion: rxDraft.draftVersion,
          ...(acknowledgedRxAlerts.length === 0
            ? {}
            : {
                clinicalOverride: {
                  acknowledgedAlerts: acknowledgedRxAlerts,
                  note: '确认本次处方仅测试识别包非阻断属性',
                  reasonCode: 'clinical-judgement' as const,
                },
              }),
        },
      },
    )
    expect(rxIssueRes.status, await rxIssueRes.clone().text()).toBe(200)
    issuePrescriptionResponseSchema.parse(await rxIssueRes.json())

    const completionGate = clinicalQualityCheckSchema.parse(await (await ready.app.request(
      `/api/his/v1/encounters/${fhVisit.encounterId}/clinical-quality?gate=outpatient-completion`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    expect(completionGate.sourcePacks).not.toContain('familial-hypercholesterolemia')
    expect(completionGate.alerts.some(alert => alert.code.startsWith('FH_'))).toBe(false)
    expect(completionGate.redLines.some(rule => rule.code.startsWith('FH_'))).toBe(false)

    const preview = encounterCompletionPreviewSchema.parse(await (await ready.app.request(
      `/api/his/v1/encounters/${fhVisit.encounterId}/completion`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    expect(preview.canComplete, JSON.stringify(preview.items)).toBe(true)

    const detailForComplete = doctorCaseDetailSchema.parse(await (await ready.app.request(
      `/api/his/v1/doctor/cases/${fhVisit.outpatientCaseId}`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    const acknowledgedCompletionAlerts = completionGate.alerts.map(a => a.code)
    const completedRes = await postJson(
      `/api/his/v1/encounters/${fhVisit.encounterId}/actions/complete`,
      cookies.doctor,
      {
        expectedVersions: { [`Encounter/${fhVisit.encounterId}`]: detailForComplete.encounter.versionId },
        input: acknowledgedCompletionAlerts.length === 0
          ? {}
          : {
              clinicalOverride: {
                acknowledgedAlerts: acknowledgedCompletionAlerts,
                note: '确认完成接诊并由专病随访门诊进一步完善 FH 基因与家系评估',
                reasonCode: 'clinical-judgement' as const,
              },
            },
      },
    )
    expect(completedRes.status, await completedRes.clone().text()).toBe(200)
    encounterCompletionResponseSchema.parse(await completedRes.json())

    // Run deterministic AC30 matchPhenotypeCandidates over the live verified HTTP ledger
    const phenotypeResult = matchPhenotypeCandidates({
      knowledgeBase: SYNTHETIC_PHENOTYPE_KB,
      ledger: verifiedLedger,
      patientBirthDate: '1988-03-18',
      patientSex: 'male',
      timing: 'encounter-open',
      vocabulary: effectiveVocab,
    })
    expect(phenotypeResult.llmInvocationCount).toBe(0)
    expect(llmCallCount).toBe(0)
    expect(phenotypeResult.candidates).toHaveLength(1)

    const fhCandidate = phenotypeResult.candidates[0]!
    expect(fhCandidate.diseaseId).toBe('familial-hypercholesterolemia')
    expect(fhCandidate.packId).toBe('familial-hypercholesterolemia')
    expect(fhCandidate.confidenceScore).toBe(1)
    expect(fhCandidate.matchedPhenotypeCount).toBeGreaterThanOrEqual(4)
    expect(fhCandidate.matchedPhenotypes.map(m => m.phenotypeCode)).toEqual(expect.arrayContaining([
      'PHENO-SEVERE-HYPER-LDL',
      'PHENO-PERSISTENT-SEVERE-HYPER-LDL',
      'PHENO-PREMATURE-CAD',
      'PHENO-FAMILY-HISTORY-PREMATURE-CAD',
    ]))
    expect(fhCandidate.crossTimeTimeline[0]?.observedAt.startsWith('2023-09-12')).toBe(true)
    expect(fhCandidate.crossTimeTimeline.some(entry => entry.observedAt.startsWith('2025-07-18'))).toBe(true)
    expect(fhCandidate.crossTimeTimeline.some(entry => entry.observedAt.startsWith('2026-'))).toBe(true)

    expect(phenotypeResult.promptCards).toHaveLength(1)
    expect(phenotypeResult.promptCards[0]!.category).toBe('phenotype-candidate')
    expect(phenotypeResult.promptCards[0]!.blockingTier).toBe('none')
    expect(phenotypeResult.promptCards[0]!.deliveryMode).toBe('display')
    expect(phenotypeResult.promptCards[0]!.suggestions.every(s => s.isDraftOnly)).toBe(true)

    // Verify live HTTP prompt bundle emits non-blocking recognition & phenotype-candidate cards on both timings with 0 LLM calls
    for (const timing of ['encounter-open', 'report-arrived'] as const) {
      const promptRes = await ready.app.request(
        `/api/his/v1/doctor/cases/${fhVisit.outpatientCaseId}/clinical-prompts?timing=${timing}`,
        { headers: { cookie: cookies.doctor } },
      )
      expect(promptRes.status).toBe(200)
      const promptBundle = clinicalPromptBundleSchema.parse(await promptRes.json())
      const recognitionCard = promptBundle.cards.find(
        c => c.category === 'recognition' && c.packId === 'familial-hypercholesterolemia',
      )
      expect(recognitionCard).toBeDefined()
      expect(recognitionCard!.blockingTier).toBe('none')
      expect(recognitionCard!.deliveryMode).toBe('display')

      // 识别卡与表型候选卡合并为同一处提示，不出两条内容重叠的卡
      expect(promptBundle.cards.filter(c => c.packId === 'familial-hypercholesterolemia')).toHaveLength(1)
      expect(promptBundle.cards.some(c => c.category === 'phenotype-candidate')).toBe(false)
      expect(recognitionCard!.detail).toContain('跨时间表型识别发现疑似')
      expect(recognitionCard!.detail).toContain(fhCandidate.recommendedWorkupZh[0]!)
      expect(recognitionCard!.basedOnFactVersions.length).toBeGreaterThan(0)
      expect(recognitionCard!.suggestions.length).toBeGreaterThan(0)
      expect(recognitionCard!.suggestions.every(s => s.isDraftOnly)).toBe(true)
      expect(recognitionCard!.knowledgeStatus).toBe('auto-verified')
      expect(recognitionCard!.trialBadgeZh).toBe('试用版')
    }
    expect(llmCallCount).toBe(0)
  }, 60_000)

  it('marks familial-hypercholesterolemia inapplicable and suppresses phenotype candidate when secondary hyperlipidemia (N04.9) is diagnosed', async () => {
    const isolatedRuntime = await createClinMeshRuntime({
      activeReferenceReleaseId: 'dsap-fh-recognition-reference-v1',
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      chatCompletionsProvider: {
        completeJson: async () => {
          llmCallCount += 1
          throw new Error('LLM fallback must never be called during inapplicable population verification')
        },
      },
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'operational-inapplicable.sqlite'),
      demoPassword,
      investigationModel: 'unexpected-investigation-model',
      migrationMode: 'apply',
      referenceDatabasePath,
      trustedOrigins: ['http://localhost'],
    })

    try {
      const isoPost = (path: string, cookie: string, body: unknown, method: 'POST' | 'PUT' = 'POST') => (
        isolatedRuntime.app.request(path, {
          body: JSON.stringify(body),
          headers: {
            'content-type': 'application/json',
            cookie,
            'idempotency-key': randomUUID(),
            origin: 'http://localhost',
          },
          method,
        })
      )
      const isoAdmin = await signIn(isolatedRuntime, 'admin@demo.clinmesh.local')
      const isoDoctor = await signIn(isolatedRuntime, 'doctor@demo.clinmesh.local')
      const isoRegistrar = await signIn(isolatedRuntime, 'registrar@demo.clinmesh.local')
      const isoTriage = await signIn(isolatedRuntime, 'triage@demo.clinmesh.local')

      const scenario = scenarioStateSchema.parse(await (await isolatedRuntime.app.request(
        '/api/sim/v1/scenario-runs/current',
        { headers: { cookie: isoAdmin } },
      )).json())
      const resetRes = await isoPost(`/api/sim/v1/scenario-runs/${scenario.scenarioRunId}/actions/reset`, isoAdmin, {})
      expect(resetRes.status).toBe(200)
      const epoch = scenarioCommandResponseSchema.parse(await resetRes.json()).data.epoch

      const goldenRes = await isoPost('/api/sim/v1/synthetic-cases/golden-pack/prepare', isoAdmin, {
        input: { expectedEpoch: epoch },
      })
      expect(goldenRes.status, await goldenRes.clone().text()).toBe(200)
      const golden = authoredCasePackPrepareResponseSchema.parse(await goldenRes.json()).data
      const fhEntry = golden.cases.find(item => item.draftId === 'fh-premature-cad-clue-v1')!

      const syntheticCase = syntheticCaseInstanceSchema.parse(await (await isolatedRuntime.app.request(
        `/api/sim/v1/synthetic-cases/${fhEntry.case!.caseId}`,
        { headers: { cookie: isoAdmin } },
      )).json())
      const registration = registrationCatalogSchema.parse(await (await isolatedRuntime.app.request(
        '/api/his/v1/catalogs/registration',
        { headers: { cookie: isoAdmin } },
      )).json())
      const startRes = await isoPost(
        `/api/his/v1/synthetic-cases/${syntheticCase.caseId}/actions/start-outpatient-visit`,
        isoRegistrar,
        {
          activeBriefRevision: syntheticCase.activeBriefRevision,
          departmentId: registration.departments[0]!.id,
          expectedCaseRevision: syntheticCase.revision,
          locationId: registration.locations[0]!.id,
          visitDate: registration.virtualDate,
          visitTypeId: registration.visitTypes[0]!.id,
        },
      )
      expect(startRes.status, await startRes.clone().text()).toBe(200)
      const started = commandResponseSchema(startSyntheticCaseResultSchema).parse(await startRes.json()).data

      const triageRes = await isoPost(
        `/api/his/v1/encounters/${started.encounterId}/actions/record-triage`,
        isoTriage,
        {
          expectedVersions: { [`Encounter/${started.encounterId}`]: '1', [`Task/${started.queueTaskId}`]: '1' },
          input: {
            acuityCode: 'level-3',
            bloodPressure: { diastolicMmHg: 78, systolicMmHg: 124 },
            chiefComplaint: '既往高血脂合并水肿评估',
            oxygenSaturationPct: 99,
            pulseBpm: 76,
            respirationBpm: 16,
            temperatureC: 36.6,
          },
        },
      )
      expect(triageRes.status).toBe(200)
      const triage = triageResponseSchema.parse(await triageRes.json()).data

      expect((await isoPost(
        `/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`,
        isoDoctor,
        {
          expectedVersions: { [`Encounter/${started.encounterId}`]: '2', [`Task/${triage.doctorTaskId}`]: '1' },
          input: {},
        },
      )).status).toBe(200)

      // Confirm N04.9 nephrotic syndrome (secondary hyperlipidemia exclusion)
      await satisfyOutpatientOrderPrerequisites(isolatedRuntime, isoDoctor, started.outpatientCaseId, {
        diagnosisCatalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:N04.9',
      })

      // Verify external LDL/Z82.4 facts
      const ledgerBeforeVerif = clinicalFactLedgerSchema.parse(await (await isolatedRuntime.app.request(
        `/api/his/v1/outpatient/cases/${started.outpatientCaseId}/clinical-fact-ledger`,
        { headers: { cookie: isoDoctor } },
      )).json())
      for (const fact of ledgerBeforeVerif.facts.filter(f => f.institutionScope === 'external')) {
        const verRes = await isoPost(
          `/api/his/v1/outpatient/cases/${started.outpatientCaseId}/clinical-fact-verifications`,
          isoDoctor,
          {
            decision: 'verified',
            expectedSourceVersion: fact.provenance.recordVersion,
            factId: fact.factId,
            note: '核对历史血脂及家族史',
          },
        )
        expect(verRes.status).toBe(200)
      }

      const bundle = diseasePackRuntimeBundleSchema.parse(await (await isolatedRuntime.app.request(
        `/api/his/v1/outpatient/cases/${started.outpatientCaseId}/disease-packs`,
        { headers: { cookie: isoDoctor } },
      )).json())
      const fhPackState = bundle.packs.find(pack => pack.packId === 'familial-hypercholesterolemia')!
      expect(fhPackState.activationStatus).toBe('inapplicable')
      expect(fhPackState.matchedInapplicableIds).toContain('nephrotic-syndrome-secondary-hyperlipidemia')

      const verifiedLedger = clinicalFactLedgerSchema.parse(await (await isolatedRuntime.app.request(
        `/api/his/v1/outpatient/cases/${started.outpatientCaseId}/clinical-fact-ledger`,
        { headers: { cookie: isoDoctor } },
      )).json())
      const phenotypeMatch = matchPhenotypeCandidates({
        knowledgeBase: SYNTHETIC_PHENOTYPE_KB,
        ledger: verifiedLedger,
        patientBirthDate: '1988-03-18',
        patientSex: 'male',
      })
      expect(phenotypeMatch.llmInvocationCount).toBe(0)
      expect(phenotypeMatch.candidates.some(c => c.diseaseId === 'familial-hypercholesterolemia')).toBe(false)

      const promptRes = await isolatedRuntime.app.request(
        `/api/his/v1/doctor/cases/${started.outpatientCaseId}/clinical-prompts?timing=encounter-open`,
        { headers: { cookie: isoDoctor } },
      )
      expect(promptRes.status).toBe(200)
      const promptBundle = clinicalPromptBundleSchema.parse(await promptRes.json())
      expect(promptBundle.cards.some(c => c.packId === 'familial-hypercholesterolemia' && c.category === 'recognition')).toBe(false)
      expect(promptBundle.cards.some(c => c.packId === 'familial-hypercholesterolemia' && c.category === 'phenotype-candidate')).toBe(false)
      expect(llmCallCount).toBe(0)
    } finally {
      await isolatedRuntime.close()
    }
  }, 60_000)
})
