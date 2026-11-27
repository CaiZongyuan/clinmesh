import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { clinicalPromptBundleSchema } from '@clinmesh/contracts/clinical-prompt-cards'
import {
  clinicalQualityCheckSchema,
  clinicalOverrideReasonSchema,
} from '@clinmesh/contracts/clinical-quality'
import {
  diseasePackRuntimeBundleSchema,
  diseasePackRuntimeEntrySchema,
  diseasePackSchema,
} from '@clinmesh/contracts/disease-pack'
import {
  caseLaboratoryCatalogSearchSchema,
  commandResponseSchema,
  createPatientResponseSchema,
  doctorCaseDetailSchema,
  examinationRequestDraftResponseSchema,
  issueExaminationRequestResponseSchema,
  issueLaboratoryRequestResponseSchema,
  laboratoryRequestDraftResponseSchema,
  orderHospitalServiceResponseSchema,
  registrationCatalogSchema,
  registrationResponseSchema,
  scenarioCommandResponseSchema,
  scenarioStateSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { authoredCasePackPrepareResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { inpatientSurgeryCatalogSchema, inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { startSyntheticCaseResultSchema, syntheticCaseInstanceSchema } from '@clinmesh/contracts/scenario'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { signIn } from './fixtures/imaging-scenario.ts'
import {
  signInitialOutpatientDocument,
} from './fixtures/outpatient-order-gate.ts'
import { payOutpatientInvestigation } from './fixtures/pay-outpatient-investigation.ts'

type Runtime = Awaited<ReturnType<typeof createClinMeshRuntime>>

const wstSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026'
const panelSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn'
const datasetReleaseId = 'laboratory-cn@2026-09-01.r1'
const demoPassword = 'Synthetic-Demo-Password-2026!'
const SHA_A = 'a'.repeat(64)

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

async function buildDsapReferenceDb(directory: string) {
  const referenceDatabasePath = join(directory, 'reference.sqlite')
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
    testItem('2100104A', '肌酸激酶同工酶测定', '血清、血浆', 'U/L', 1, [upperRule(24, 2)]),
    testItem('2100304A', '肌红蛋白测定', '血清、血浆', 'ng/mL', 1, [upperRule(72, 10)]),
    testItem('2100404A', '心肌肌钙蛋白I测定', '血清、血浆', 'ng/mL', 3, [upperRule(0.04, 0.002)]),
    testItem('2100404B', '高敏心肌肌钙蛋白I测定', '血清、血浆', 'ng/L', 1, [upperRule(26, 4)]),
    testItem('2100504A', '心肌肌钙蛋白T测定', '血清、血浆', 'ng/mL', 3, [upperRule(0.014, 0.003)]),
    testItem('2100604A', '脑利钠肽测定', '血清、血浆', 'ng/L', 1, [upperRule(100, 5)]),
    testItem('2100704A', '氨基末端脑利钠肽前体测定', '血清、血浆', 'ng/L', 0, [upperRule(125, 15)]),
    testItem('1700404A', '血清肌酐测定', '血清、血浆', 'umol/L', 1, [rangeRule(59, 104)]),
    testItem('0500103A', '凝血酶原时间测定', '血浆', 's', 1, [rangeRule(11, 14)]),
    testItem('0500203A', '活化部分凝血活酶时间测定', '血浆', 's', 1, [rangeRule(25, 37)]),
    testItem('0501703A', 'D-二聚体测定', '血浆', 'mg/L', 2, [upperRule(0.5, 0.05)]),
  ]
  const panels = [
    panelItem('CN-LAB-CARDIAC', '心肌损伤标志物组合', '血清、血浆', ['2100104A', '2100304A', '2100404A', '2100504A', '2100604A', '2100704A']),
    panelItem('CN-LAB-COAGULATION', '凝血筛查组合', '血浆', ['0500103A', '0500203A']),
  ]
  const diagnosisConcepts = [
    { code: 'R07.3', display: '其他胸痛', row: 14001 },
    { code: 'R10.1', display: '上腹痛', row: 14002 },
    { code: 'E11.9', display: '2 型糖尿病', row: 14003 },
    { code: 'Z33', display: '妊娠状态', row: 15010 },
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
    schemaVersion: '1',
  })}\n`
  const manifestPath = join(directory, 'dsap-s9-release.json')
  await writeFile(join(directory, 'dsap-s9-reference.json'), artifactJson)
  await writeFile(manifestPath, `${JSON.stringify({
    createdAt: '2026-09-02T00:00:00.000Z',
    releaseId: 'dsap-s9-pack-reference-v1',
    schemaVersion: '1',
    sources: [{
      acquisitionMethod: 'generated',
      artifactPath: 'dsap-s9-reference.json',
      checksum: createHash('sha256').update(artifactJson).digest('hex'),
      licenseId: 'LicenseRef-Synthetic-Test',
      retrievedAt: '2026-09-02T00:00:00.000Z',
      sourceId: 'cn-health-laboratory-cn',
      sourceUrl: 'https://example.test/laboratory-cn',
      upstreamVersion: '2026-09-01',
    }],
  })}\n`)
  await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
  await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', manifestPath])
  return referenceDatabasePath
}

async function postJson(runtime: Runtime, path: string, cookie: string, body: unknown, method: 'POST' | 'PUT' = 'POST') {
  return runtime.app.request(path, {
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

async function dispatchAll(runtime: Runtime) {
  while ((await runtime.dispatcher.dispatchOnce()) !== undefined) {
    // drain queued jobs
  }
}

async function startGoldenOutpatientVisit(
  runtime: Runtime,
  cookies: { admin: string; doctor: string; triage: string },
  preparedCases: z.infer<typeof authoredCasePackPrepareResponseSchema>['data']['cases'],
  draftId: string,
  chiefComplaint: string,
  acuityCode: 'level-1' | 'level-2' | 'level-3' | 'level-4' = 'level-3',
) {
  const entry = preparedCases.find(item => item.draftId === draftId)!
  expect(entry?.case?.status).toBe('brief-ready')
  const syntheticCase = syntheticCaseInstanceSchema.parse(await (await runtime.app.request(
    `/api/sim/v1/synthetic-cases/${entry.case!.caseId}`,
    { headers: { cookie: cookies.admin } },
  )).json())
  const registration = registrationCatalogSchema.parse(await (await runtime.app.request(
    '/api/his/v1/catalogs/registration',
    { headers: { cookie: cookies.admin } },
  )).json())
  const started = commandResponseSchema(startSyntheticCaseResultSchema).parse(await (await postJson(
    runtime,
    `/api/his/v1/synthetic-cases/${syntheticCase.caseId}/actions/start-outpatient-visit`,
    cookies.admin,
    {
      activeBriefRevision: syntheticCase.activeBriefRevision,
      departmentId: registration.departments[0]!.id,
      expectedCaseRevision: syntheticCase.revision,
      locationId: registration.locations[0]!.id,
      visitDate: registration.virtualDate,
      visitTypeId: registration.visitTypes[0]!.id,
    },
  )).json()).data

  const triage = triageResponseSchema.parse(await (await postJson(
    runtime,
    `/api/his/v1/encounters/${started.encounterId}/actions/record-triage`,
    cookies.triage,
    {
      expectedVersions: { [`Encounter/${started.encounterId}`]: '1', [`Task/${started.queueTaskId}`]: '1' },
      input: {
        acuityCode,
        bloodPressure: { diastolicMmHg: 76, systolicMmHg: 122 },
        chiefComplaint,
        oxygenSaturationPct: 98,
        pulseBpm: 78,
        respirationBpm: 16,
        temperatureC: 36.6,
      },
    },
  )).json()).data

  const firstVisit = await postJson(
    runtime,
    `/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`,
    cookies.doctor,
    {
      expectedVersions: { [`Encounter/${started.encounterId}`]: '2', [`Task/${triage.doctorTaskId}`]: '1' },
      input: {},
    },
  )
  expect(firstVisit.status, await firstVisit.clone().text()).toBe(200)
  return started
}

async function orderAndCompleteExam(
  runtime: Runtime,
  doctorCookie: string,
  caseId: string,
  encounterId: string,
  serviceId: 'examination-ecg-12-lead' | 'examination-tte',
  indication: string,
) {
  const fetchDetail = async () => doctorCaseDetailSchema.parse(await (await runtime.app.request(
    `/api/his/v1/doctor/cases/${caseId}`,
    { headers: { cookie: doctorCookie } },
  )).json())
  const before = await fetchDetail()
  const saved = examinationRequestDraftResponseSchema.parse(await (await postJson(
    runtime,
    `/api/his/v1/encounters/${encounterId}/examination-request/draft`,
    doctorCookie,
    {
      expectedVersions: { [`Encounter/${encounterId}`]: before.encounter.versionId },
      input: {
        expectedDraftVersion: before.examinationRequests?.draftVersion ?? 0,
        indication,
        serviceId,
      },
    },
    'PUT',
  )).json()).data
  const afterDraft = await fetchDetail()
  const issuedRes = await postJson(
    runtime,
    `/api/his/v1/encounters/${encounterId}/examination-request/actions/issue`,
    doctorCookie,
    {
      expectedVersions: { [`Encounter/${encounterId}`]: afterDraft.encounter.versionId },
      input: { expectedDraftVersion: saved.draftVersion },
    },
  )
  expect(issuedRes.status, await issuedRes.clone().text()).toBe(200)
  const issued = issueExaminationRequestResponseSchema.parse(await issuedRes.json()).data.request
  await payOutpatientInvestigation(runtime, {
    caseId,
    category: 'examination',
    chargeItemId: issued.billing!.chargeItemId,
  })
  await dispatchAll(runtime)
  return (await fetchDetail()).examinationRequests!.requests.find(req => req.id === issued.id)!
}

async function orderAndCompleteLab(
  runtime: Runtime,
  doctorCookie: string,
  caseId: string,
  encounterId: string,
  catalogItemId: string,
  indicationCode: string,
) {
  const fetchDetail = async () => doctorCaseDetailSchema.parse(await (await runtime.app.request(
    `/api/his/v1/doctor/cases/${caseId}`,
    { headers: { cookie: doctorCookie } },
  )).json())
  const before = await fetchDetail()
  const saved = laboratoryRequestDraftResponseSchema.parse(await (await postJson(
    runtime,
    `/api/his/v1/encounters/${encounterId}/laboratory-request/draft`,
    doctorCookie,
    {
      expectedVersions: { [`Encounter/${encounterId}`]: before.encounter.versionId },
      input: {
        catalogItemId,
        expectedDraftVersion: before.laboratoryRequests?.draftVersion ?? 0,
        indicationCode,
      },
    },
    'PUT',
  )).json()).data
  const afterDraft = await fetchDetail()
  const issuedRes = await postJson(
    runtime,
    `/api/his/v1/encounters/${encounterId}/laboratory-request/actions/issue`,
    doctorCookie,
    {
      expectedVersions: { [`Encounter/${encounterId}`]: afterDraft.encounter.versionId },
      input: { expectedDraftVersion: saved.draftVersion },
    },
  )
  expect(issuedRes.status, await issuedRes.clone().text()).toBe(200)
  const issued = issueLaboratoryRequestResponseSchema.parse(await issuedRes.json()).data.request
  await payOutpatientInvestigation(runtime, {
    caseId,
    category: 'laboratory',
    chargeItemId: issued.billing!.chargeItemId,
  })
  await dispatchAll(runtime)
  return (await fetchDetail()).laboratoryRequests!.requests.find(req => req.id === issued.id)!
}

async function confirmOutpatientDiagnoses(
  runtime: Runtime,
  doctorCookie: string,
  caseId: string,
  encounterId: string,
  entries: Array<{ catalogItemId: string; role: 'primary' | 'secondary' }>,
) {
  const signed = await signInitialOutpatientDocument(runtime, doctorCookie, caseId)
  const detail = doctorCaseDetailSchema.parse(await (await runtime.app.request(
    `/api/his/v1/doctor/cases/${caseId}`,
    { headers: { cookie: doctorCookie } },
  )).json())
  const draftRes = await postJson(
    runtime,
    `/api/his/v1/encounters/${encounterId}/diagnosis/draft`,
    doctorCookie,
    {
      expectedVersions: { [`Encounter/${encounterId}`]: signed.encounterVersion },
      input: {
        entries,
        expectedDraftVersion: detail.diagnosis?.draftVersion ?? 0,
      },
    },
    'PUT',
  )
  expect(draftRes.status, await draftRes.clone().text()).toBe(200)
  const draft = z.object({ data: z.object({ draftVersion: z.number() }) }).parse(await draftRes.json()).data
  const confirmRes = await postJson(
    runtime,
    `/api/his/v1/encounters/${encounterId}/diagnosis/actions/confirm`,
    doctorCookie,
    {
      expectedVersions: { [`Encounter/${encounterId}`]: signed.encounterVersion },
      input: { expectedDraftVersion: draft.draftVersion },
    },
  )
  expect(confirmRes.status, await confirmRes.clone().text()).toBe(200)
}

describe('DSAP Slice S9: Outpatient Rule-Out, Pack Exit & Silence, Confusable Packs, Inapplicable Boundary & Indication Yellow Cards', () => {
  it('AC18, AC24 & AC31: executes rule-out checklist, audited SQLite pack exit & re-enable, pregnancy inapplicable boundary, CTA yellow card, and inpatient CAG without LLM calls', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-dsap-s9-'))
    const databasePath = join(directory, 'operational.sqlite')
    const referenceDatabasePath = await buildDsapReferenceDb(directory)
    let llmCallCount = 0

    const runtimeOptions = {
      activeReferenceReleaseId: 'dsap-s9-pack-reference-v1',
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      chatCompletionsProvider: {
        completeJson: async () => {
          llmCallCount += 1
          throw new Error('LLM must never run in deterministic S9 flow')
        },
      },
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath,
      demoPassword,
      investigationModel: 'unexpected-investigation-model',
      migrationMode: 'apply' as const,
      referenceDatabasePath,
      trustedOrigins: ['http://localhost'],
    }

    let runtime = await createClinMeshRuntime(runtimeOptions)
    cleanups.push(async () => {
      await runtime.close()
      await rm(directory, { force: true, recursive: true })
    })

    const cookies = {
      admin: await signIn(runtime, 'admin@demo.clinmesh.local'),
      doctor: await signIn(runtime, 'doctor@demo.clinmesh.local'),
      triage: await signIn(runtime, 'triage@demo.clinmesh.local'),
    }

    const currentScenario = scenarioStateSchema.parse(await (await runtime.app.request(
      '/api/sim/v1/scenario-runs/current',
      { headers: { cookie: cookies.admin } },
    )).json())
    const resetResponse = await postJson(runtime, `/api/sim/v1/scenario-runs/${currentScenario.scenarioRunId}/actions/reset`, cookies.admin, {})
    expect(resetResponse.status).toBe(200)
    expect(scenarioCommandResponseSchema.parse(await resetResponse.json()).data.epoch).toBe('epoch-2')

    const preparedRes = await postJson(runtime, '/api/sim/v1/synthetic-cases/golden-pack/prepare', cookies.admin, {
      input: { expectedEpoch: 'epoch-2' },
    })
    expect(preparedRes.status, await preparedRes.clone().text()).toBe(200)
    const prepared = authoredCasePackPrepareResponseSchema.parse(await preparedRes.json()).data

    // =========================================================================
    // Part 1 (AC18): Epigastric pain in 70yo T2DM -> rule-out checklist -> serial normal exit & silence -> restart persistence -> toggle re-enable
    // =========================================================================
    const epiVisit = await startGoldenOutpatientVisit(
      runtime,
      cookies,
      prepared.cases,
      'trap-epigastric-t2dm-ruleout-v1',
      '70 岁老年糖尿病患者上腹隐痛伴轻度恶心 3 小时，拟排除不典型冠脉缺血',
    )
    await confirmOutpatientDiagnoses(
      runtime,
      cookies.doctor,
      epiVisit.outpatientCaseId,
      epiVisit.encounterId,
      [
        { catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:R10.1', role: 'primary' },
        { catalogItemId: 'diagnosis-type-2-diabetes-hyperglycemia', role: 'secondary' },
      ],
    )
    const actorDoctor = await runtime.identity.resolveSessionContext(new Headers({ cookie: cookies.doctor }))
    const epiDetailBeforeEcg = doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${epiVisit.outpatientCaseId}`,
      { headers: { cookie: cookies.doctor } },
    )).json())

    // Trigger CAD evaluation by completing ECG first (activated via chest-pain equivalent / ECG)
    const epiEcg = await orderAndCompleteExam(
      runtime,
      cookies.doctor,
      epiVisit.outpatientCaseId,
      epiVisit.encounterId,
      'examination-ecg-12-lead',
      '高龄糖尿病上腹痛筛查不典型心肌缺血',
    )
    expect(epiEcg.status).toBe('reported')

    const promptsAfterEcg = clinicalPromptBundleSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${epiVisit.outpatientCaseId}/clinical-prompts?timing=encounter-open`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    const packsAfterEcg = diseasePackRuntimeBundleSchema.parse(await (await runtime.app.request(
      `/api/his/v1/outpatient/cases/${epiVisit.outpatientCaseId}/disease-packs`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    const epiFactsDbg = runtime.database.driver.prepare(
      "SELECT resource_type, resource_id, substr(json_extract(content_json, '$.code'), 1, 200) AS code FROM fhir_resource WHERE resource_type IN ('Condition','ServiceRequest','DiagnosticReport','Observation') ORDER BY rowid DESC LIMIT 20",
    ).all()
    expect(packsAfterEcg.packs[0]?.activationStatus, JSON.stringify({ packsAfterEcg, promptsAfterEcg, epiFactsDbg })).toBe('active')
    expect(packsAfterEcg.packs[0]?.exited).not.toBe(true)

    const ruleOutAfterEcg = promptsAfterEcg.cards.find(c => c.category === 'rule-out-checklist')
    expect(ruleOutAfterEcg).toBeDefined()
    expect(ruleOutAfterEcg?.detail).toContain('急性心肌梗死')
    expect(ruleOutAfterEcg?.detail).toContain('急性肺栓塞')
    expect(ruleOutAfterEcg?.detail).toContain('主动脉夹层')
    expect(ruleOutAfterEcg?.detail).toContain('I21.4')
    expect(ruleOutAfterEcg?.detail).toContain('I26.9')
    expect(ruleOutAfterEcg?.detail).toContain('I71.0')
    expect(ruleOutAfterEcg?.detail).toContain('肌钙蛋白')
    expect(ruleOutAfterEcg?.detail).toContain('D-二聚体')
    expect(ruleOutAfterEcg?.detail).not.toContain('12 导联心电图（11524-6）')
    const ruleOutItems = ruleOutAfterEcg!.ruleOutItems
    expect(ruleOutItems.map(item => [item.id, item.status, item.purposeZh])).toEqual([
      ['ecg-12-lead', 'resulted', '排查心梗'],
      ['serial-hs-ctni', 'not-ordered', '排查心肌损伤'],
      ['d-dimer', 'not-ordered', '排查肺栓塞'],
    ])
    expect(ruleOutItems[0]?.resultText).toBeTruthy()
    expect(ruleOutItems[0]?.basedOnFactVersions.length).toBeGreaterThan(0)
    expect(ruleOutItems[1]?.itemCodes).toEqual(['89579-7', '2100404B'])

    // Order & complete 1st troponin + D-dimer
    const epiLabs = caseLaboratoryCatalogSearchSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${epiVisit.outpatientCaseId}/reference-catalogs/laboratory?page=1&pageSize=30`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    const hsTropItem = epiLabs.items.find(item => item.referenceConcept.code === '2100404B')
      ?? epiLabs.items.find(item => item.referenceConcept.code === '2100404A')!
    const ddimerItem = epiLabs.items.find(item => item.referenceConcept.code === '0501703A')!
    expect(hsTropItem).toBeDefined()
    expect(ddimerItem).toBeDefined()

    const trop1 = await orderAndCompleteLab(
      runtime,
      cookies.doctor,
      epiVisit.outpatientCaseId,
      epiVisit.encounterId,
      hsTropItem.id,
      hsTropItem.allowedIndicationCodes[0]!,
    )
    expect(trop1.status).toBe('reported')

    // After 1st normal troponin only -> pack MUST NOT exit yet!
    const packsAfter1Trop = diseasePackRuntimeBundleSchema.parse(await (await runtime.app.request(
      `/api/his/v1/outpatient/cases/${epiVisit.outpatientCaseId}/disease-packs`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    expect(packsAfter1Trop.packs[0]?.activationStatus).toBe('active')
    expect(packsAfter1Trop.packs[0]?.exited).not.toBe(true)

    // Complete 2nd normal troponin AND normal D-dimer -> triggers automatic audited pack exit!
    const trop2 = await orderAndCompleteLab(
      runtime,
      cookies.doctor,
      epiVisit.outpatientCaseId,
      epiVisit.encounterId,
      hsTropItem.id,
      hsTropItem.allowedIndicationCodes[0]!,
    )
    expect(trop2.status).toBe('reported')
    const ddimer = await orderAndCompleteLab(
      runtime,
      cookies.doctor,
      epiVisit.outpatientCaseId,
      epiVisit.encounterId,
      ddimerItem.id,
      ddimerItem.allowedIndicationCodes[0]!,
    )
    expect(ddimer.status).toBe('reported')

    const exitPromptRaw = await runtime.app.request(
      `/api/his/v1/doctor/cases/${epiVisit.outpatientCaseId}/clinical-prompts?timing=report-arrived`,
      { headers: { cookie: cookies.doctor } },
    )
    expect(exitPromptRaw.status, await exitPromptRaw.clone().text()).toBe(200)
    const exitPromptBundle = clinicalPromptBundleSchema.parse(await exitPromptRaw.json())
    const exitCards = exitPromptBundle.cards.filter(c => c.category === 'exit-summary')
    expect(exitCards).toHaveLength(1)
    expect(exitCards[0]?.detail).toContain('退出')
    expect(exitCards[0]?.summary).toMatch(/已退出专病管理路径$/)
    expect(exitCards[0]?.detail).toContain(exitCards[0]!.summary.replace(/已退出专病管理路径$/, ''))

    // Verify SQLite exit state & FHIR AuditEvent + audit_log written
    const packsAfterExit = diseasePackRuntimeBundleSchema.parse(await (await runtime.app.request(
      `/api/his/v1/outpatient/cases/${epiVisit.outpatientCaseId}/disease-packs`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    const exitEntry = packsAfterExit.packs[0]!
    expect(exitEntry.exited).toBe(true)
    expect(exitEntry.activationReason).toBe('pack-exited')
    expect(exitEntry.activationStatus).toBe('inactive')

    const exitRows = runtime.database.driver.prepare(
      'SELECT exit_reason_zh, exit_summary_delivered FROM disease_pack_exit_state WHERE subject_id = ?',
    ).all(epiVisit.outpatientCaseId) as Array<{ exit_reason_zh: string; exit_summary_delivered: number }>
    expect(exitRows).toHaveLength(1)
    expect(exitRows[0]?.exit_summary_delivered).toBe(1)

    const auditRows = runtime.database.driver.prepare(
      "SELECT operation FROM audit_log WHERE operation = 'disease-pack.exit'",
    ).all() as Array<{ operation: string }>
    expect(auditRows.length).toBeGreaterThanOrEqual(1)
    const auditEventRows = runtime.database.driver.prepare(
      "SELECT resource_id FROM fhir_resource WHERE resource_type = 'AuditEvent' AND json_extract(content_json, '$.code.coding[0].code') = 'disease-pack.exit'",
    ).all() as Array<{ resource_id: string }>
    expect(auditEventRows.length).toBeGreaterThanOrEqual(1)

    // Subsequent calls on ALL timings are completely silent!
    for (const timing of ['encounter-open', 'order-draft-select', 'order-sign', 'report-arrived'] as const) {
      const silentBundle = clinicalPromptBundleSchema.parse(await (await runtime.app.request(
        `/api/his/v1/doctor/cases/${epiVisit.outpatientCaseId}/clinical-prompts?timing=${timing}`,
        { headers: { cookie: cookies.doctor } },
      )).json())
      expect(silentBundle.cards.filter(c => c.packId === exitEntry.packId)).toEqual([])
    }

    // Restart durability: close & reopen runtime on same SQLite DB -> still exited & silent!
    await runtime.close()
    runtime = await createClinMeshRuntime(runtimeOptions)
    cookies.admin = await signIn(runtime, 'admin@demo.clinmesh.local')
    cookies.doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
    cookies.triage = await signIn(runtime, 'triage@demo.clinmesh.local')

    const afterRestartPacks = diseasePackRuntimeBundleSchema.parse(await (await runtime.app.request(
      `/api/his/v1/outpatient/cases/${epiVisit.outpatientCaseId}/disease-packs`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    expect(afterRestartPacks.packs[0]?.exited).toBe(true)
    expect(afterRestartPacks.packs[0]?.activationReason).toBe('pack-exited')

    const afterRestartPrompts = clinicalPromptBundleSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${epiVisit.outpatientCaseId}/clinical-prompts?timing=encounter-open`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    expect(afterRestartPrompts.cards.filter(c => c.packId === exitEntry.packId)).toEqual([])

    // Explicit clinician toggle re-enables the exited pack
    const toggleRes = await postJson(
      runtime,
      `/api/his/v1/outpatient/cases/${epiVisit.outpatientCaseId}/disease-packs/${exitEntry.packId}/toggle`,
      cookies.doctor,
      {
        expectedVersion: afterRestartPacks.packs[0]!.manualOverrideVersion,
        note: '患者上腹痛加重，临床医生手动重新开启专病评估',
        overrideMode: 'enabled',
      },
    )
    expect(toggleRes.status, await toggleRes.clone().text()).toBe(200)
    const reenabledEntry = commandResponseSchema(diseasePackRuntimeEntrySchema).parse(await toggleRes.json()).data
    expect(reenabledEntry.activationStatus).toBe('active')
    expect(reenabledEntry.exited).not.toBe(true)

    const promptsAfterReenable = clinicalPromptBundleSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${epiVisit.outpatientCaseId}/clinical-prompts?timing=encounter-open`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    expect(promptsAfterReenable.cards.some(c => c.packId === exitEntry.packId && c.category !== 'exit-summary')).toBe(true)
    expect(epiDetailBeforeEcg.caseId).toBe(epiVisit.outpatientCaseId)
    expect(actorDoctor.actor.actorId).toBeTruthy()

    // =========================================================================
    // Part 2 (AC24): Pregnant chest pain -> inapplicable boundary + checklist + missing items, ZERO treatments, ZERO pointScales in coronary-cad
    // =========================================================================
    const pregVisit = await startGoldenOutpatientVisit(
      runtime,
      cookies,
      prepared.cases,
      'trap-pregnant-chest-pain-v1',
      '孕 28 周胸痛胸闷待查',
    )
    await confirmOutpatientDiagnoses(
      runtime,
      cookies.doctor,
      pregVisit.outpatientCaseId,
      pregVisit.encounterId,
      [
        { catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:R07.3', role: 'primary' },
        { catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:Z33', role: 'secondary' },
      ],
    )
    const pregPacks = diseasePackRuntimeBundleSchema.parse(await (await runtime.app.request(
      `/api/his/v1/outpatient/cases/${pregVisit.outpatientCaseId}/disease-packs`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    expect(pregPacks.packs[0]?.activationStatus).toBe('inapplicable')
    expect(pregPacks.packs[0]?.matchedInapplicableIds).toContain('pregnancy-inapplicable')
    const pregnancyCondition = pregPacks.packs[0]?.matchedInapplicables.find(item => item.id === 'pregnancy-inapplicable')
    expect(pregnancyCondition?.descriptionZh).toContain('妊娠')
    expect(pregnancyCondition?.basedOnFactVersions.length).toBeGreaterThan(0)

    const pregPrompts = clinicalPromptBundleSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${pregVisit.outpatientCaseId}/clinical-prompts?timing=encounter-open`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    const inapplicableCard = pregPrompts.cards.find(c => c.category === 'inapplicable-population')
    expect(inapplicableCard).toBeDefined()
    expect(inapplicableCard?.summary).toContain('超出本包范围，请医生自行决策')
    expect(inapplicableCard?.detail).toContain('妊娠期')
    expect(inapplicableCard?.basedOnFactVersions).toEqual(pregnancyCondition?.basedOnFactVersions)
    expect(pregPrompts.cards.some(c => c.category === 'rule-out-checklist')).toBe(true)
    expect(pregPrompts.cards.some(c => c.category === 'missing-fact')).toBe(false)
    expect(pregPrompts.cards.some(c => ['recommendation', 'order-set-risk', 'guideline-advice'].includes(c.category))).toBe(false)

    // Verify coronary-cad clinical.json on disk declares ZERO pointScales (Pending Item #0)
    const coronaryClinical = JSON.parse(
      await readFile(resolve(import.meta.dirname, '../disease-packs/coronary-cad/clinical.json'), 'utf8'),
    ) as { pointScales?: unknown[] }
    expect(coronaryClinical.pointScales ?? []).toEqual([])

    // =========================================================================
    // Part 3 (AC31): Low-risk chest wall pain -> missing-inputs before ECG+troponin -> CTA 409 yellow card after normal ECG+troponin -> clinicalOverride succeeds
    // =========================================================================
    const lowRiskVisit = await startGoldenOutpatientVisit(
      runtime,
      cookies,
      prepared.cases,
      'trap-low-risk-chest-wall-pain-v1',
      '左侧前胸壁局限性压痛 2 天，按压加重，拟排除心源性胸痛',
    )
    await confirmOutpatientDiagnoses(
      runtime,
      cookies.doctor,
      lowRiskVisit.outpatientCaseId,
      lowRiskVisit.encounterId,
      [{ catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:R07.3', role: 'primary' }],
    )

    // Before ECG + troponin completes, CTA indication check stays in missing-inputs (NO yellow card yet)
    const ctaSearch = z.object({
      items: z.array(z.object({ code: z.string(), id: z.string(), nameZh: z.string() }).loose()),
    }).loose().parse(await (await runtime.app.request(
      '/api/his/v1/catalogs/services?page=1&pageSize=20&query=CTA',
      { headers: { cookie: cookies.doctor } },
    )).json())
    const ctaService = ctaSearch.items.find(s => s.code === 'CT-CORONARY-CTA')
    expect(ctaService?.id).toBe('hospital-service-coronary-cta')
    expect(ctaService?.nameZh).toContain('冠状动脉 CTA')

    const doctorCtx = (await runtime.identity.resolveSessionContext(new Headers({ cookie: cookies.doctor }))).actor
    const preWorkupCheck = runtime.workflow.clinicalQuality.checkOrderIndication({
      asOf: '2026-08-24T09:00:00+08:00',
      candidateCodes: ['hospital-service-coronary-cta', 'CT-CORONARY-CTA'],
      catalogItemId: 'hospital-service-coronary-cta',
      context: doctorCtx,
      gate: 'outpatient-prescription',
      itemCode: 'CT-CORONARY-CTA',
      orderDisplay: '冠状动脉 CTA',
      orderKind: 'imaging',
      subject: { id: lowRiskVisit.outpatientCaseId, kind: 'outpatient', patientId: lowRiskVisit.patientId },
    })
    expect(preWorkupCheck.alerts).toEqual([])

    // Complete normal ECG + normal cardiac troponin
    const lowRiskEcg = await orderAndCompleteExam(
      runtime,
      cookies.doctor,
      lowRiskVisit.outpatientCaseId,
      lowRiskVisit.encounterId,
      'examination-ecg-12-lead',
      '排除缺血性 ST-T 改变',
    )
    expect(lowRiskEcg.status).toBe('reported')
    const lowRiskLabs = caseLaboratoryCatalogSearchSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${lowRiskVisit.outpatientCaseId}/reference-catalogs/laboratory?page=1&pageSize=30`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    const cardiacPanel = lowRiskLabs.items.find(item => item.referenceConcept.code === 'CN-LAB-CARDIAC')
      ?? lowRiskLabs.items.find(item => item.referenceConcept.code === '2100404B')!
    const lowRiskCardiac = await orderAndCompleteLab(
      runtime,
      cookies.doctor,
      lowRiskVisit.outpatientCaseId,
      lowRiskVisit.encounterId,
      cardiacPanel.id,
      cardiacPanel.allowedIndicationCodes[0]!,
    )
    expect(lowRiskCardiac.status).toBe('reported')

    // Now order Coronary CTA WITHOUT clinicalOverride -> blocked by 409 CLINICAL_QUALITY_ALERT (INVESTIGATION_WITHOUT_INDICATION)
    const detailBeforeCta = doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${lowRiskVisit.outpatientCaseId}`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    const srCountBefore = (runtime.database.driver.prepare(
      'SELECT COUNT(*) AS count FROM fhir_resource WHERE resource_type = ?',
    ).get('ServiceRequest') as { count: number }).count

    const blockedCtaRes = await postJson(
      runtime,
      `/api/his/v1/encounters/${lowRiskVisit.encounterId}/services/hospital-service-coronary-cta/actions/order`,
      cookies.doctor,
      {
        expectedVersions: { [`Encounter/${lowRiskVisit.encounterId}`]: detailBeforeCta.encounter.versionId },
        input: {},
      },
    )
    expect(blockedCtaRes.status, await blockedCtaRes.clone().text()).toBe(409)
    const blockedBody = z.object({
      error: z.object({
        clinicalQuality: clinicalQualityCheckSchema,
        code: z.string(),
        message: z.string(),
      }),
    }).parse(await blockedCtaRes.json())
    expect(blockedBody.error.code).toBe('CLINICAL_QUALITY_ALERT')
    expect(blockedBody.error.clinicalQuality.alerts.some(a => a.code === 'INVESTIGATION_WITHOUT_INDICATION')).toBe(true)

    const srCountAfterBlock = (runtime.database.driver.prepare(
      'SELECT COUNT(*) AS count FROM fhir_resource WHERE resource_type = ?',
    ).get('ServiceRequest') as { count: number }).count
    expect(srCountAfterBlock).toBe(srCountBefore)

    // Retry with explicit clinicalOverride -> succeeds 200 and records clinical_quality_override
    const overrideCtaRes = await postJson(
      runtime,
      `/api/his/v1/encounters/${lowRiskVisit.encounterId}/services/hospital-service-coronary-cta/actions/order`,
      cookies.doctor,
      {
        expectedVersions: { [`Encounter/${lowRiskVisit.encounterId}`]: detailBeforeCta.encounter.versionId },
        input: {
          clinicalOverride: {
            acknowledgedAlerts: ['INVESTIGATION_WITHOUT_INDICATION'],
            note: '患者胸痛焦虑且强烈要求行冠脉 CTA 解剖排外',
            reasonCode: clinicalOverrideReasonSchema.options[0]!,
          },
        },
      },
    )
    expect(overrideCtaRes.status, await overrideCtaRes.clone().text()).toBe(200)
    const orderedCta = orderHospitalServiceResponseSchema.parse(await overrideCtaRes.json())
    expect(orderedCta.data.hospitalServiceId).toBe('hospital-service-coronary-cta')
    expect(orderedCta.clinicalQuality?.alerts.some(a => a.code === 'INVESTIGATION_WITHOUT_INDICATION')).toBe(true)

    const overrideRows = runtime.database.driver.prepare(
      "SELECT alerts_json, operation FROM clinical_quality_override WHERE operation = 'hospital-service.order'",
    ).all() as Array<{ alerts_json: string; operation: string }>
    expect(overrideRows.length).toBeGreaterThanOrEqual(1)

    // Confirmed CAD case must NOT auto-exit on normal serial biomarkers, AND inpatient 88.5500 CAG passes with ZERO yellow card
    const registrarCookie = await signIn(runtime, 'registrar@demo.clinmesh.local')
    const wardNurseCookie = await signIn(runtime, 'ward-nurse@demo.clinmesh.local')
    const inpatientDocCookie = await signIn(runtime, 'inpatient-doctor@demo.clinmesh.local')
    const inPatientRes = await postJson(
      runtime,
      '/api/his/v1/patients',
      registrarCookie,
      { expectedVersions: {}, input: { birthDate: '1965-03-12', gender: 'male', identifier: `SYN-INP-${randomUUID()}`, name: '冠心病住院患者' } },
    )
    expect(inPatientRes.status, await inPatientRes.clone().text()).toBe(200)
    const inPatient = createPatientResponseSchema.parse(await inPatientRes.json()).data.patient
    const admRes = await postJson(
      runtime,
      '/api/his/v1/inpatient/admissions',
      registrarCookie,
      { input: { admissionRoute: 'direct', depositFen: 100000, expectedEpoch: 'epoch-2', patientId: inPatient.id, patientVersion: inPatient.versionId, wardId: 'ward-general' } },
    )
    expect(admRes.status, await admRes.clone().text()).toBe(200)
    const registeredAdm = z.object({ data: z.object({ admission: z.object({ id: z.string(), versionId: z.string() }) }) }).parse(await admRes.json()).data.admission
    const recRes = await postJson(
      runtime,
      `/api/his/v1/inpatient/admissions/${registeredAdm.id}/receive`,
      wardNurseCookie,
      { input: { bedId: 'bed-general-1', encounterVersion: registeredAdm.versionId } },
    )
    expect(recRes.status, await recRes.clone().text()).toBe(200)
    const receivedAdm = z.object({ data: z.object({ admission: z.object({ id: z.string(), versionId: z.string() }) }) }).parse(await recRes.json()).data.admission
    const inpPath = `/api/his/v1/inpatient/admissions/${receivedAdm.id}`
    const confirmDxRes = await postJson(
      runtime,
      `${inpPath}/diagnoses/confirm`,
      inpatientDocCookie,
      { input: { encounterVersion: receivedAdm.versionId, entries: [{ admissionCondition: '1', catalogItemId: 'diagnosis-coronary-heart-disease', role: 'primary' }], expectedRevision: 0 } },
    )
    expect(confirmDxRes.status, await confirmDxRes.clone().text()).toBe(200)
    const encAfterDx = z.object({ data: z.object({ encounterVersion: z.string() }) }).parse(await confirmDxRes.json()).data.encounterVersion

    // Add normal ECG + >=2 normal hs-cTnI + normal D-dimer directly on confirmed CAD inpatient -> pack MUST NOT exit!
    const inpActor = (await runtime.identity.resolveSessionContext(new Headers({ cookie: inpatientDocCookie }))).actor
    const recordedTs = '2026-08-24T09:00:00+08:00'
    runtime.fhir.create(inpActor, {
      category: [{ coding: [{ code: 'EXAM' }] }],
      code: { coding: [{ code: '11524-6', display: '十二导联心电图', system: 'http://loinc.org' }] },
      conclusion: '心电图正常',
      effectiveDateTime: recordedTs,
      encounter: { reference: `Encounter/${receivedAdm.id}` },
      id: `inp-ecg-${randomUUID()}`,
      issued: recordedTs,
      resourceType: 'DiagnosticReport',
      status: 'final',
      subject: { reference: `Patient/${inPatient.id}` },
    })
    for (let idx = 1; idx <= 2; idx += 1) {
      runtime.fhir.create(inpActor, {
        category: [{ coding: [{ code: 'laboratory' }] }],
        code: { coding: [{ code: '89579-7', display: '高敏肌钙蛋白 I', system: 'http://loinc.org' }] },
        effectiveDateTime: recordedTs,
        encounter: { reference: `Encounter/${receivedAdm.id}` },
        id: `inp-tni-${idx}-${randomUUID()}`,
        interpretation: [{ coding: [{ code: 'N', system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation' }] }],
        issued: recordedTs,
        resourceType: 'Observation',
        status: 'final',
        subject: { reference: `Patient/${inPatient.id}` },
        valueQuantity: { code: 'ng/L', system: 'http://unitsofmeasure.org', unit: 'ng/L', value: 4 },
      })
    }
    runtime.fhir.create(inpActor, {
      category: [{ coding: [{ code: 'laboratory' }] }],
      code: { coding: [{ code: '48065-7', display: 'D-二聚体', system: 'http://loinc.org' }] },
      effectiveDateTime: recordedTs,
      encounter: { reference: `Encounter/${receivedAdm.id}` },
      id: `inp-ddimer-${randomUUID()}`,
      interpretation: [{ coding: [{ code: 'N', system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation' }] }],
      issued: recordedTs,
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: `Patient/${inPatient.id}` },
      valueQuantity: { code: 'mg/L', system: 'http://unitsofmeasure.org', unit: 'mg/L', value: 0.2 },
    })

    const inpatientPacks = diseasePackRuntimeBundleSchema.parse(await (await runtime.app.request(
      `${inpPath}/disease-packs`,
      { headers: { cookie: inpatientDocCookie } },
    )).json())
    expect(inpatientPacks.packs[0]?.activationStatus).toBe('active')
    expect(inpatientPacks.packs[0]?.exited).not.toBe(true)

    const surgeryCatalog = inpatientSurgeryCatalogSchema.parse(await (await runtime.app.request(
      '/api/his/v1/inpatient/surgery-catalog',
      { headers: { cookie: inpatientDocCookie } },
    )).json())
    const cagProc = surgeryCatalog.procedures.find(p => p.coding.code === '88.5500')!
    const cagRes = await postJson(
      runtime,
      `${inpPath}/surgeries/request`,
      inpatientDocCookie,
      {
        input: {
          anesthesiaMethod: 'local-infiltration',
          catalogVersion: cagProc.version,
          encounterVersion: encAfterDx,
          locationId: 'location-catheterization-lab',
          plannedFor: '2026-08-25T01:00:00.000Z',
          preopOrderPolicy: 'continue-active',
          procedureId: cagProc.id,
          reason: '确诊冠心病患者拟行选择性冠脉造影检查',
          surgeonPractitionerId: 'practitioner-inpatient-doctor',
          surgeryType: 'elective',
        },
      },
    )
    expect(cagRes.status, await cagRes.clone().text()).toBe(200)
    const cagData = inpatientSurgeryResponseSchema.parse(await cagRes.json())
    expect(cagData.clinicalQuality?.alerts.some(a => a.code === 'INVESTIGATION_WITHOUT_INDICATION') ?? false).toBe(false)

    expect(llmCallCount).toBe(0)
  }, 90_000)

  it('AC18 pointScales & AC19 mutually-confusable packs emit low-risk skip guidance and suppress conflicting treatments with one merged differential card', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-dsap-s9-syn-'))
    const packAlpha = diseasePackSchema.parse({
      confusablePacks: [{ differentialHintZh: '需同步鉴别非心源性急性肺栓塞', packId: 'synthetic-diff-beta' }],
      examSuite: { cases: [{ caseId: 'syn-1', expectedActive: true, titleZh: '合成测试' }], passThreshold: 0.8 },
      exitCriteria: [],
      formulaRefs: [],
      inapplicablePopulations: [],
      indicationRules: [],
      knowledgeSnapshots: [],
      manifest: {
        dependencies: [],
        fingerprint: SHA_A,
        id: 'synthetic-scale-alpha',
        packType: 'full',
        specialty: 'synthetic',
        status: 'active',
        supportedTasks: ['pci-preop-guideline-advice'],
        titleEn: 'Synthetic Scale Alpha',
        titleZh: '合成低危评分甲包',
        version: '1.0.0',
      },
      orderSets: [
        {
          id: 'alpha-treatment-set',
          items: [{ channel: 'procedure', key: 'alpha-proc', kind: 'procedure', procedureCode: '00.66', titleZh: '甲包介入治疗' }],
          scopes: ['outpatient'],
          titleZh: '甲包治疗组套',
        },
      ],
      pointScales: [
        {
          criteria: [
            {
              condition: {
                category: 'laboratory',
                itemCodes: ['2160-0'],
                kind: 'fact',
                minValue: 200,
                presence: 'present',
                requireEligible: true,
              },
              id: 'cr-elevated',
              labelZh: '肌酐明显升高',
              points: 2,
            },
          ],
          guidelineCitation: {
            locator: '第 14 页推荐 2',
            sourceTitle: '合成门诊低危胸痛分流共识',
            version: '2026.1',
          },
          id: 'alpha-low-risk-scale',
          riskBands: [
            {
              guidanceZh: '低危分层（0 分）可跳过非必要高成本排查，建议门诊复诊随访',
              labelZh: '低风险',
              maxScore: 0,
              minScore: 0,
              skipTests: true,
            },
            {
              labelZh: '高风险',
              maxScore: null,
              minScore: 1,
            },
          ],
          titleZh: '合成甲包低危风险量表',
        },
      ],
      qualityTightenings: { examPassThreshold: 0.8, redLineRules: [], validityOverrides: [] },
      questionnaireItems: [],
      readinessTasks: [{ criticalItems: [], secondaryItems: [], taskId: 'pci-preop-guideline-advice', titleZh: '评估' }],
      riskTags: [],
      ruleOutChecklist: [
        {
          actionHintZh: '排查心电图与肌钙蛋白',
          id: 'alpha-ruleout',
          requiredTestCodes: ['11524-6'],
          targetConditionCodes: ['I21.4'],
          titleZh: '甲包排查清单',
          trigger: { category: 'diagnosis', itemCodes: ['K21.9'], kind: 'fact', presence: 'present', requireEligible: true },
        },
      ],
      stages: [
        {
          entryCondition: { category: 'diagnosis', itemCodes: ['K21.9'], kind: 'fact', presence: 'present', requireEligible: true },
          id: 'alpha-s1',
          order: 1,
          orderSetIds: ['alpha-treatment-set'],
          questionnaireItemCodes: [],
          taskIds: ['pci-preop-guideline-advice'],
          titleZh: '初诊',
          topicIds: [],
        },
      ],
      toolPolicy: { allowedTools: [], forbiddenActions: [] },
      triggers: [
        {
          condition: { category: 'diagnosis', itemCodes: ['K21.9'], kind: 'fact', presence: 'present', requireEligible: true },
          descriptionZh: 'Reflux symptom trigger',
          id: 'trigger-alpha',
        },
      ],
    })

    const packBeta = diseasePackSchema.parse({
      confusablePacks: [{ differentialHintZh: '需先排除急性冠脉缺血事件', packId: 'synthetic-scale-alpha' }],
      examSuite: { cases: [{ caseId: 'syn-2', expectedActive: true, titleZh: '合成测试' }], passThreshold: 0.8 },
      exitCriteria: [],
      formulaRefs: [],
      inapplicablePopulations: [],
      indicationRules: [],
      knowledgeSnapshots: [],
      manifest: {
        dependencies: [],
        fingerprint: SHA_A,
        id: 'synthetic-diff-beta',
        packType: 'full',
        specialty: 'synthetic',
        status: 'active',
        supportedTasks: ['pci-preop-guideline-advice'],
        titleEn: 'Synthetic Diff Beta',
        titleZh: '合成鉴别乙包',
        version: '1.0.0',
      },
      orderSets: [],
      pointScales: [],
      qualityTightenings: { examPassThreshold: 0.8, redLineRules: [], validityOverrides: [] },
      questionnaireItems: [],
      readinessTasks: [{ criticalItems: [], secondaryItems: [], taskId: 'pci-preop-guideline-advice', titleZh: '评估' }],
      riskTags: [],
      ruleOutChecklist: [
        {
          actionHintZh: '优先查 D-二聚体排查急性肺栓塞',
          id: 'beta-ruleout',
          requiredTestCodes: ['48065-7'],
          targetConditionCodes: ['I26.9'],
          titleZh: '乙包排查清单',
          trigger: { category: 'diagnosis', itemCodes: ['I10'], kind: 'fact', presence: 'present', requireEligible: true },
        },
      ],
      stages: [
        {
          entryCondition: { category: 'diagnosis', itemCodes: ['I10'], kind: 'fact', presence: 'present', requireEligible: true },
          id: 'beta-s1',
          order: 1,
          orderSetIds: [],
          questionnaireItemCodes: [],
          taskIds: ['pci-preop-guideline-advice'],
          titleZh: '鉴别期',
          topicIds: [],
        },
      ],
      toolPolicy: { allowedTools: [], forbiddenActions: [] },
      triggers: [
        {
          condition: { category: 'diagnosis', itemCodes: ['I10'], kind: 'fact', presence: 'present', requireEligible: true },
          descriptionZh: 'Hypertension trigger for second pack',
          id: 'trigger-beta',
        },
      ],
    })

    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'syn.sqlite'),
      demoPassword,
      diseasePacks: [packAlpha, packBeta],
      diseasePackVerifyFingerprint: false,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    cleanups.push(async () => {
      await runtime.close()
      await rm(directory, { force: true, recursive: true })
    })

    const registrar = await signIn(runtime, 'registrar@demo.clinmesh.local')
    const triage = await signIn(runtime, 'triage@demo.clinmesh.local')
    const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
    const registration = registrationCatalogSchema.parse(await (await runtime.app.request(
      '/api/his/v1/catalogs/registration',
      { headers: { cookie: registrar } },
    )).json())
    const patientRes = await postJson(
      runtime,
      '/api/his/v1/patients',
      registrar,
      { expectedVersions: {}, input: { birthDate: '1980-05-05', gender: 'male', identifier: `SYN-${randomUUID()}`, name: '合成双包测试' } },
    )
    expect(patientRes.status, await patientRes.clone().text()).toBe(200)
    const patient = createPatientResponseSchema.parse(await patientRes.json()).data.patient
    const regRes = await postJson(
      runtime,
      '/api/his/v1/registrations/actions/register',
      registrar,
      {
        expectedVersions: { [`Patient/${patient.id}`]: patient.versionId },
        input: {
          departmentId: registration.departments[0]!.id,
          locationId: registration.locations[0]!.id,
          patientId: patient.id,
          visitDate: registration.virtualDate,
          visitTypeId: registration.visitTypes[0]!.id,
        },
      },
    )
    expect(regRes.status, await regRes.clone().text()).toBe(200)
    const reg = registrationResponseSchema.parse(await regRes.json()).data
    const regCaseId = (runtime.database.driver.prepare(
      'SELECT case_id FROM outpatient_case WHERE encounter_id = ?',
    ).get(reg.encounterId) as { case_id: string }).case_id
    const tri = triageResponseSchema.parse(await (await postJson(
      runtime,
      `/api/his/v1/encounters/${reg.encounterId}/actions/record-triage`,
      triage,
      {
        expectedVersions: { [`Encounter/${reg.encounterId}`]: '1', [`Task/${reg.queueTaskId}`]: '1' },
        input: { acuityCode: 'level-3', bloodPressure: { diastolicMmHg: 80, systolicMmHg: 130 }, chiefComplaint: '胸痛待查', oxygenSaturationPct: 98, pulseBpm: 76, respirationBpm: 16, temperatureC: 36.5 },
      },
    )).json()).data
    await postJson(runtime, `/api/his/v1/encounters/${reg.encounterId}/actions/start-first-visit`, doctor, {
      expectedVersions: { [`Encounter/${reg.encounterId}`]: '2', [`Task/${tri.doctorTaskId}`]: '1' },
      input: {},
    })

    // 1. Trigger ONLY synthetic-scale-alpha (K21.9) -> emits point-scale recommendation card
    const actorDoc = await runtime.identity.resolveSessionContext(new Headers({ cookie: doctor }))
    const recordedAt = '2026-08-24T09:00:00+08:00'
    runtime.fhir.create(actorDoc.actor, {
      category: [{ coding: [{ code: 'encounter-diagnosis', system: 'http://terminology.hl7.org/CodeSystem/condition-category' }] }],
      clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
      code: { coding: [{ code: 'K21.9', display: '胃食管反流病', system: 'http://hl7.org/fhir/sid/icd-10' }] },
      encounter: { reference: `Encounter/${reg.encounterId}` },
      id: `cond-k21-${randomUUID()}`,
      recordedDate: recordedAt,
      resourceType: 'Condition',
      subject: { reference: `Patient/${patient.id}` },
      verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
    })

    const singlePrompts = clinicalPromptBundleSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${regCaseId}/clinical-prompts?timing=encounter-open`,
      { headers: { cookie: doctor } },
    )).json())
    const singlePacksDbg = await (await runtime.app.request(
      `/api/his/v1/outpatient/cases/${regCaseId}/disease-packs`,
      { headers: { cookie: doctor } },
    )).json()
    const singleLedgerDbg = runtime.workflow.diseasePacks.readOutpatientPacks(actorDoc.actor, regCaseId)
    const pointScaleCard = singlePrompts.cards.find(c => c.cardId.includes('point-scale:'))
    expect(pointScaleCard, JSON.stringify({ singlePrompts, singlePacksDbg, singleLedgerDbg })).toBeDefined()
    expect(pointScaleCard?.detail).toContain('合成门诊低危胸痛分流共识')
    expect(pointScaleCard?.detail).toContain('第 14 页推荐 2')
    expect(pointScaleCard?.detail).toContain('低危分层')

    // 2. Also trigger synthetic-diff-beta (I10) -> mutually confusable cluster suppresses treatment cards and emits ONE merged differential card
    runtime.fhir.create(actorDoc.actor, {
      category: [{ coding: [{ code: 'encounter-diagnosis', system: 'http://terminology.hl7.org/CodeSystem/condition-category' }] }],
      clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
      code: { coding: [{ code: 'I10', display: '高血压', system: 'http://hl7.org/fhir/sid/icd-10' }] },
      encounter: { reference: `Encounter/${reg.encounterId}` },
      id: `cond-i10-${randomUUID()}`,
      recordedDate: recordedAt,
      resourceType: 'Condition',
      subject: { reference: `Patient/${patient.id}` },
      verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
    })

    const dualPrompts = clinicalPromptBundleSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${regCaseId}/clinical-prompts?timing=encounter-open`,
      { headers: { cookie: doctor } },
    )).json())
    const diffCard = dualPrompts.cards.find(c => c.cardId.includes(':confusable-differential:'))
    expect(diffCard).toBeDefined()
    expect(diffCard?.category).toBe('rule-out-checklist')
    expect(diffCard?.detail).toContain('synthetic-scale-alpha')
    expect(diffCard?.detail).toContain('synthetic-diff-beta')
    expect(diffCard?.detail).toContain('需同步鉴别非心源性急性肺栓塞')
    expect(diffCard?.detail).toContain('需先排除急性冠脉缺血事件')
    expect(dualPrompts.cards.some(c => c.category === 'order-set-risk' || c.category === 'guideline-advice')).toBe(false)
  }, 60_000)
})
