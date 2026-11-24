import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  apiErrorSchema,
  caseLaboratoryCatalogSearchSchema,
  commandResponseSchema,
  doctorCaseDetailSchema,
  examinationRequestDraftResponseSchema,
  issueExaminationRequestResponseSchema,
  issueLaboratoryRequestResponseSchema,
  laboratoryRequestDraftResponseSchema,
  registrationCatalogSchema,
  scenarioCommandResponseSchema,
  scenarioStateSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import {
  authoredCasePackPrepareResponseSchema,
  authoredCasePackSummarySchema,
} from '@clinmesh/contracts/inpatient-pci-data'
import {
  startSyntheticCaseResultSchema,
  syntheticCaseInstanceSchema,
} from '@clinmesh/contracts/scenario'
import { personaLeaksDiagnosis } from '../src/application/patient-persona-service.ts'
import { compiledCardiorenalAuthoredCasePack } from '../src/application/scenario-data/cardiorenal-authored-case-pack.ts'
import {
  compiledDsapExtraGoldenCasePack,
  listFrozenDsapGoldenCases,
} from '../src/application/scenario-data/dsap-golden-case-pack.ts'
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

describe('DSAP Golden Case Pack & Strict Pre-populated Investigation Resolution HTTP', () => {
  let directory = ''
  let runtime: Runtime | undefined
  let llmCallCount = 0
  const cookies = { admin: '', doctor: '', triage: '' }
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
      // drain outbox tasks
    }
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'clinmesh-dsap-golden-pack-'))
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
      testItem('2100504A', '心肌肌钙蛋白T测定', '血清、血浆', 'ng/mL', 3, [upperRule(0.014, 0.003)]),
      testItem('2100604A', '脑利钠肽测定', '血清、血浆', 'ng/L', 1, [upperRule(100, 5)]),
      testItem('2100704A', '氨基末端脑利钠肽前体测定', '血清、血浆', 'ng/L', 0, [upperRule(125, 15)]),
      testItem('0500103A', '凝血酶原时间测定', '血浆', 's', 1, [rangeRule(11, 14)]),
      testItem('0500203A', '活化部分凝血活酶时间测定', '血浆', 's', 1, [rangeRule(25, 37)]),
      testItem('0501703A', 'D-二聚体测定', '血浆', 'mg/L', 2, [upperRule(0.5, 0.05)]),
      testItem('1201004A', '促甲状腺激素测定', '血清、血浆', 'mIU/L', 2, [rangeRule(0.27, 4.2)]),
    ]
    const panels = [
      panelItem('CN-LAB-CARDIAC', '心肌损伤标志物组合', '血清、血浆', ['2100104A', '2100304A', '2100404A', '2100504A', '2100604A', '2100704A']),
      panelItem('CN-LAB-COAGULATION', '凝血筛查组合', '血浆', ['0500103A', '0500203A']),
    ]
    const diagnosisConcepts = [
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
      schemaVersion: '1',
    })}\n`
    const manifestPath = join(directory, 'dsap-golden-release.json')
    await writeFile(join(directory, 'dsap-golden-reference.json'), artifactJson)
    await writeFile(manifestPath, `${JSON.stringify({
      createdAt: '2026-09-02T00:00:00.000Z',
      releaseId: 'dsap-golden-pack-reference-v1',
      schemaVersion: '1',
      sources: [{
        acquisitionMethod: 'generated',
        artifactPath: 'dsap-golden-reference.json',
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

    runtime = await createClinMeshRuntime({
      activeReferenceReleaseId: 'dsap-golden-pack-reference-v1',
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      chatCompletionsProvider: {
        completeJson: async () => {
          llmCallCount += 1
          throw new Error('LLM fallback must never be invoked for clinmesh-authored golden cases')
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
    cookies.triage = await signIn(ready, 'triage@demo.clinmesh.local')

    const currentScenario = scenarioStateSchema.parse(await (await ready.app.request(
      '/api/sim/v1/scenario-runs/current',
      { headers: { cookie: cookies.admin } },
    )).json())
    const resetResponse = await postJson(`/api/sim/v1/scenario-runs/${currentScenario.scenarioRunId}/actions/reset`, cookies.admin, {})
    expect(resetResponse.status).toBe(200)
    expect(scenarioCommandResponseSchema.parse(await resetResponse.json()).data.epoch).toBe('epoch-2')
  }, 60_000)

  afterAll(async () => {
    await runtime?.close()
    if (directory !== '') await rm(directory, { force: true, recursive: true })
  })

  it('keeps the original 5 authored cases untouched and freezes 5 extra DSAP golden cases without persona leaks', () => {
    expect(compiledCardiorenalAuthoredCasePack.cases).toHaveLength(5)
    expect(compiledDsapExtraGoldenCasePack.cases.map(item => item.definition.id)).toEqual([
      'trap-low-risk-chest-wall-pain-v1',
      'fh-premature-cad-clue-v1',
      'trap-epigastric-t2dm-ruleout-v1',
      'trap-external-creatinine-v1',
      'trap-pregnant-chest-pain-v1',
    ])
    const allFrozen = listFrozenDsapGoldenCases()
    expect(allFrozen).toHaveLength(10)
    for (const compiledCase of allFrozen) {
      const bundle = compiledCase.source.raw as {
        entry: Array<{ fullUrl: string; resource: { code?: unknown; id: string; resourceType: string } }>
      }
      const hiddenSet = new Set(compiledCase.compiled.hiddenResourceReferences)
      const visibleSet = new Set(compiledCase.compiled.visibleResourceReferences)
      expect(personaLeaksDiagnosis(
        compiledCase.persona.content,
        bundle.entry.filter(item => hiddenSet.has(item.fullUrl)).map(item => item.resource),
        bundle.entry.filter(item => visibleSet.has(item.fullUrl)).map(item => item.resource),
      )).toBe(false)
    }
  })

  it('prepares golden-pack via dedicated admin endpoints and enforces strict pre-populated investigations without fallback', async () => {
    const ready = current()
    const forbidden = await ready.app.request('/api/sim/v1/synthetic-cases/golden-pack', {
      headers: { cookie: cookies.doctor },
    })
    expect(forbidden.status).toBe(403)
    expect(apiErrorSchema.parse(await forbidden.json()).error.code).toBe('ROLE_NOT_ALLOWED')

    const authoredBefore = authoredCasePackSummarySchema.parse(await (await ready.app.request(
      '/api/sim/v1/synthetic-cases/authored-pack',
      { headers: { cookie: cookies.admin } },
    )).json())
    expect(authoredBefore).toMatchObject({ readyCount: 0, totalCount: 5 })

    const goldenBefore = authoredCasePackSummarySchema.parse(await (await ready.app.request(
      '/api/sim/v1/synthetic-cases/golden-pack',
      { headers: { cookie: cookies.admin } },
    )).json())
    expect(goldenBefore).toMatchObject({ readyCount: 0, totalCount: 5 })

    const conflict = await postJson('/api/sim/v1/synthetic-cases/golden-pack/prepare', cookies.admin, {
      input: { expectedEpoch: 'epoch-1' },
    })
    expect(conflict.status).toBe(409)
    expect(apiErrorSchema.parse(await conflict.json()).error.code).toBe('AUTHORED_CASE_PACK_EPOCH_CONFLICT')

    const preparedResponse = await postJson('/api/sim/v1/synthetic-cases/golden-pack/prepare', cookies.admin, {
      input: { expectedEpoch: 'epoch-2' },
    })
    expect(preparedResponse.status, await preparedResponse.clone().text()).toBe(200)
    const prepared = authoredCasePackPrepareResponseSchema.parse(await preparedResponse.json()).data
    expect(prepared).toMatchObject({ readyCount: 5, totalCount: 5 })

    const authoredStillUntouched = authoredCasePackSummarySchema.parse(await (await ready.app.request(
      '/api/sim/v1/synthetic-cases/authored-pack',
      { headers: { cookie: cookies.admin } },
    )).json())
    expect(authoredStillUntouched).toMatchObject({ readyCount: 0, totalCount: 5 })

    const chestWallEntry = prepared.cases.find(item => item.draftId === 'trap-low-risk-chest-wall-pain-v1')!
    expect(chestWallEntry.case?.status).toBe('brief-ready')
    const syntheticCase = syntheticCaseInstanceSchema.parse(await (await ready.app.request(
      `/api/sim/v1/synthetic-cases/${chestWallEntry.case!.caseId}`,
      { headers: { cookie: cookies.admin } },
    )).json())
    const registration = registrationCatalogSchema.parse(await (await ready.app.request(
      '/api/his/v1/catalogs/registration',
      { headers: { cookie: cookies.admin } },
    )).json())
    const started = commandResponseSchema(startSyntheticCaseResultSchema).parse(await (await postJson(
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
      `/api/his/v1/encounters/${started.encounterId}/actions/record-triage`,
      cookies.triage,
      {
        expectedVersions: { [`Encounter/${started.encounterId}`]: '1', [`Task/${started.queueTaskId}`]: '1' },
        input: {
          acuityCode: 'level-3',
          bloodPressure: { diastolicMmHg: 74, systolicMmHg: 116 },
          chiefComplaint: '左侧前胸壁局限性隐痛 2 天，按压加重。',
          oxygenSaturationPct: 99,
          pulseBpm: 72,
          respirationBpm: 16,
          temperatureC: 36.5,
        },
      },
    )).json()).data

    expect((await postJson(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, cookies.doctor, {
      expectedVersions: { [`Encounter/${started.encounterId}`]: '2', [`Task/${triage.doctorTaskId}`]: '1' },
      input: {},
    })).status).toBe(200)

    const prereq = await satisfyOutpatientOrderPrerequisites(ready, cookies.doctor, started.outpatientCaseId, {
      diagnosisCatalogItemId: 'diagnosis-coronary-heart-disease',
    })

    const publishedLabs = caseLaboratoryCatalogSearchSchema.parse(await (await ready.app.request(
      `/api/his/v1/doctor/cases/${started.outpatientCaseId}/reference-catalogs/laboratory?page=1&pageSize=20`,
      { headers: { cookie: cookies.doctor } },
    )).json())

    const fetchCaseDetail = async () => doctorCaseDetailSchema.parse(await (await ready.app.request(
      `/api/his/v1/doctor/cases/${started.outpatientCaseId}`,
      { headers: { cookie: cookies.doctor } },
    )).json())

    const orderAndRunLab = async (catalogItemId: string, indicationCode: string) => {
      const detailBefore = await fetchCaseDetail()
      const saved = laboratoryRequestDraftResponseSchema.parse(await (await postJson(
        `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
        cookies.doctor,
        {
          expectedVersions: { [`Encounter/${started.encounterId}`]: detailBefore.encounter.versionId },
          input: {
            catalogItemId,
            expectedDraftVersion: detailBefore.laboratoryRequests?.draftVersion ?? 0,
            indicationCode,
          },
        },
        'PUT',
      )).json()).data
      const detailDraft = await fetchCaseDetail()
      const issuedResponse = await postJson(
        `/api/his/v1/encounters/${started.encounterId}/laboratory-request/actions/issue`,
        cookies.doctor,
        {
          expectedVersions: { [`Encounter/${started.encounterId}`]: detailDraft.encounter.versionId },
          input: { expectedDraftVersion: saved.draftVersion },
        },
      )
      expect(issuedResponse.status, await issuedResponse.clone().text()).toBe(200)
      const issued = issueLaboratoryRequestResponseSchema.parse(await issuedResponse.json()).data.request
      await payOutpatientInvestigation(ready, {
        caseId: started.outpatientCaseId,
        category: 'laboratory',
        chargeItemId: issued.billing!.chargeItemId,
      })
      await dispatchAll()
      return (await fetchCaseDetail()).laboratoryRequests!.requests.find(req => req.id === issued.id)!
    }

    const orderAndRunExam = async (serviceId: 'examination-ecg-12-lead' | 'examination-tte') => {
      const detailBefore = await fetchCaseDetail()
      const saved = examinationRequestDraftResponseSchema.parse(await (await postJson(
        `/api/his/v1/encounters/${started.encounterId}/examination-request/draft`,
        cookies.doctor,
        {
          expectedVersions: { [`Encounter/${started.encounterId}`]: detailBefore.encounter.versionId },
          input: {
            expectedDraftVersion: detailBefore.examinationRequests?.draftVersion ?? 0,
            indication: '评估低危胸壁压痛与心肺基础情况',
            serviceId,
          },
        },
        'PUT',
      )).json()).data
      const detailDraft = await fetchCaseDetail()
      const issued = issueExaminationRequestResponseSchema.parse(await (await postJson(
        `/api/his/v1/encounters/${started.encounterId}/examination-request/actions/issue`,
        cookies.doctor,
        {
          expectedVersions: { [`Encounter/${started.encounterId}`]: detailDraft.encounter.versionId },
          input: { expectedDraftVersion: saved.draftVersion },
        },
      )).json()).data.request
      await payOutpatientInvestigation(ready, {
        caseId: started.outpatientCaseId,
        category: 'examination',
        chargeItemId: issued.billing!.chargeItemId,
      })
      await dispatchAll()
      return (await fetchCaseDetail()).examinationRequests!.requests.find(req => req.id === issued.id)!
    }

    const ecgResult = await orderAndRunExam('examination-ecg-12-lead')
    expect(ecgResult.status).toBe('reported')
    expect(ecgResult.report?.impression).toContain('窦性心律')

    const cardiacService = publishedLabs.items.find(entry => entry.referenceConcept.code === 'CN-LAB-CARDIAC')!
    expect(cardiacService).toBeDefined()
    const cardiacResult = await orderAndRunLab(cardiacService.id, cardiacService.allowedIndicationCodes[0]!)
    expect(cardiacResult.status).toBe('reported')

    const tshItem = publishedLabs.items.find(entry => entry.referenceConcept.code === '1201004A')!
    expect(tshItem).toBeDefined()
    const tshResult = await orderAndRunLab(tshItem.id, tshItem.allowedIndicationCodes[0]!)
    expect(tshResult.status).toBe('generation-failed')
    expect(tshResult.generationError).toEqual({
      code: 'INVESTIGATION_UNSUPPORTED',
      message: '本病例未预置该检查',
    })

    const coagService = publishedLabs.items.find(entry => entry.referenceConcept.code === 'CN-LAB-COAGULATION')!
    expect(coagService).toBeDefined()
    const coagResult = await orderAndRunLab(coagService.id, coagService.allowedIndicationCodes[0]!)
    expect(coagResult.status).toBe('generation-failed')
    expect(coagResult.generationError).toEqual({
      code: 'INVESTIGATION_UNSUPPORTED',
      message: '本病例未预置该检查',
    })

    const tteResult = await orderAndRunExam('examination-tte')
    expect(tteResult.status).toBe('generation-failed')
    expect(tteResult.generationError).toEqual({
      code: 'INVESTIGATION_UNSUPPORTED',
      message: '本病例未预置该检查',
    })

    expect(llmCallCount).toBe(0)
    expect(prereq.encounterId).toBe(started.encounterId)
  }, 60_000)
})
