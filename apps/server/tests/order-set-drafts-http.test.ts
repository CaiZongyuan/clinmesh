import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { v7 as uuidv7 } from 'uuid'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import {
  apiErrorSchema,
  clinicalCatalogSchema,
  commandResponseSchema,
  confirmDiagnosisResponseSchema,
  diagnosisDraftResponseSchema,
  doctorCaseDetailSchema,
  examinationRequestDraftResponseSchema,
  issueExaminationRequestResponseSchema,
  issueLaboratoryRequestResponseSchema,
  issuePrescriptionResponseSchema,
  laboratoryRequestDraftResponseSchema,
  prescriptionDraftResponseSchema,
  registrationCatalogSchema,
  scenarioCommandResponseSchema,
  scenarioStateSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalResponseSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationResponseSchema } from '@clinmesh/contracts/inpatient-investigations'
import { orderSetDraftBundleSchema, orderSetTemplateIds, orderSetTemplateListSchema } from '@clinmesh/contracts/order-set-templates'
import { startSyntheticCaseResultSchema, syntheticCaseInstanceSchema } from '@clinmesh/contracts/scenario'
import { sourceArtifactHash } from '../src/application/scenario-data/provider.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'

type ClinMeshRuntime = Awaited<ReturnType<typeof createClinMeshRuntime>>

async function signIn(runtime: ClinMeshRuntime, password: string, email: string): Promise<string> {
  const response = await runtime.app.request('/api/auth/sign-in/email', {
    body: JSON.stringify({ email, password }),
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    method: 'POST',
  })
  expect(response.status).toBe(200)
  return response.headers.get('set-cookie')!.split(';', 1)[0]!
}

const wstSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026'
const panelSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn'
const datasetReleaseId = 'laboratory-cn@2026-09-01.r1'

describe('Cardiology Order Set Templates & Patient-Screened Draft Assembly HTTP', () => {
  let directory = ''
  let runtime: ClinMeshRuntime | undefined
  let nextPatient = { birthDate: '1965-04-12', gender: 'male' as 'male' | 'female' }
  const cookies = { admin: '', cashier: '', doctor: '', inpatientDoctor: '', nurse: '', registrar: '', triage: '' }
  const current = () => runtime!

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'clinmesh-order-set-drafts-'))
    const referenceDatabasePath = join(directory, 'reference.sqlite')
    const rangeRule = (low: number, high: number, sex: 'all' | 'female' | 'male' = 'all') => ({
      high,
      low,
      notes: '合成成人参考区间',
      referenceKind: 'range' as const,
      sex,
      simulationHigh: high,
      simulationLow: low,
      sourceLocation: '表 1',
      sourceStandard: 'WS/T 886-2026',
      sourceType: 'national-standard' as const,
      sourceVersion: '2026',
    })
    const upperRule = (high: number, simulationLow: number, sex: 'all' | 'female' | 'male' = 'all') => ({
      high,
      notes: '合成成人参考上限',
      referenceKind: 'upper-bound' as const,
      sex,
      simulationHigh: high,
      simulationLow,
      sourceLocation: '表 1',
      sourceStandard: 'WS/T 886-2026',
      sourceType: 'project-curated' as const,
      sourceVersion: '2026-09-01',
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
      testItem('0100101A', '白细胞计数', '全血', '10*9/L', 2, [rangeRule(3.5, 9.5)]),
      testItem('0100201A', '红细胞计数', '全血', '10*12/L', 2, [rangeRule(4.3, 5.8, 'male'), rangeRule(3.8, 5.1, 'female')]),
      testItem('0100301A', '血小板计数', '全血', '10*9/L', 0, [rangeRule(125, 350)]),
      testItem('0100401A', '血红蛋白测定', '全血', 'g/L', 0, [rangeRule(130, 175, 'male'), rangeRule(115, 150, 'female')]),
      testItem('0100501A', '红细胞比容', '全血', 'L/L', 2, [rangeRule(0.4, 0.5, 'male'), rangeRule(0.35, 0.45, 'female')]),
      testItem('0100601A', '平均红细胞体积', '全血', 'fL', 1, [rangeRule(82, 100)]),
      testItem('0100701A', '平均红细胞血红蛋白含量', '全血', 'pg', 1, [rangeRule(27, 34)]),
      testItem('0100801A', '平均红细胞血红蛋白浓度', '全血', 'g/L', 0, [rangeRule(316, 354)]),
      testItem('2100104A', '肌酸激酶同工酶测定', '血清、血浆', 'U/L', 1, [upperRule(24, 2)]),
      testItem('2100304A', '肌红蛋白测定', '血清、血浆', 'ng/mL', 1, [upperRule(72, 10)]),
      testItem('2100404A', '心肌肌钙蛋白I测定', '血清、血浆', 'ng/mL', 3, [upperRule(0.04, 0.002)]),
      testItem('2100504A', '心肌肌钙蛋白T测定', '血清、血浆', 'ng/mL', 3, [upperRule(0.014, 0.003)]),
      testItem('2100604A', '脑利钠肽测定', '血清、血浆', 'ng/L', 1, [upperRule(100, 5)]),
      testItem('2100704A', '氨基末端脑利钠肽前体测定', '血清、血浆', 'ng/L', 0, [upperRule(125, 15)]),
      testItem('2000104A', '总胆固醇测定', '血清、血浆', 'mmol/L', 2, [upperRule(5.2, 3.1)]),
      testItem('2000204A', '甘油三酯测定', '血清、血浆', 'mmol/L', 2, [upperRule(1.7, 0.4)]),
      testItem('2000304A', '高密度脂蛋白胆固醇测定', '血清、血浆', 'mmol/L', 2, [rangeRule(1.0, 2.0)]),
      testItem('2000404A', '低密度脂蛋白胆固醇测定', '血清、血浆', 'mmol/L', 2, [upperRule(3.4, 1.5)]),
      testItem('2000604A', '载脂蛋白A1测定', '血清、血浆', 'g/L', 2, [rangeRule(1.0, 1.6)]),
      testItem('2000704A', '载脂蛋白B测定', '血清、血浆', 'g/L', 2, [rangeRule(0.6, 1.1)]),
      testItem('1700204A', '尿素测定', '血清、血浆', 'mmol/L', 2, [rangeRule(2.8, 7.6)]),
      testItem('1700304A', '尿酸测定', '血清、血浆', 'umol/L', 0, [rangeRule(208, 428, 'male'), rangeRule(155, 357, 'female')]),
      testItem('1700404A', '肌酐测定', '血清、血浆', 'umol/L', 0, [rangeRule(57, 97, 'male'), rangeRule(41, 73, 'female')]),
      testItem('1101204A', '胱抑素C测定', '血清、血浆', 'mg/L', 2, [rangeRule(0.51, 1.09)]),
      testItem('1400205A', '钠测定', '血清、血浆', 'mmol/L', 1, [rangeRule(137, 147)]),
      testItem('1400305A', '镁测定', '血清、血浆', 'mmol/L', 2, [rangeRule(0.75, 1.02)]),
      testItem('1400404A', '无机磷测定', '血清、血浆', 'mmol/L', 2, [rangeRule(0.85, 1.51)]),
      testItem('1400505A', '氯测定', '血清、血浆', 'mmol/L', 1, [rangeRule(99, 110)]),
      testItem('1400605A', '钾测定', '血清、血浆', 'mmol/L', 2, [rangeRule(3.5, 5.3)]),
      testItem('1400705A', '总钙测定', '血清、血浆', 'mmol/L', 2, [rangeRule(2.11, 2.52)]),
      testItem('1100301A', '糖化血红蛋白测定', '全血', '%', 1, [rangeRule(4.0, 6.0)]),
      testItem('0501703A', 'D-二聚体测定', '血浆', 'mg/L', 2, [upperRule(0.5, 0.05)]),
    ]
    const panels = [
      panelItem('CN-LAB-CBC-5DIFF', '血常规（五分类）', '全血', ['0100101A', '0100201A', '0100301A', '0100401A', '0100501A', '0100601A', '0100701A', '0100801A']),
      panelItem('CN-LAB-CARDIAC', '心肌损伤标志物组合', '血清、血浆', ['2100104A', '2100304A', '2100404A', '2100504A', '2100604A', '2100704A']),
      panelItem('CN-LAB-LIPIDS', '血脂组合', '血清、血浆', ['2000104A', '2000204A', '2000304A', '2000404A', '2000604A', '2000704A']),
      panelItem('CN-LAB-RENAL', '肾功能组合', '血清、血浆', ['1700204A', '1700304A', '1700404A', '1101204A']),
      panelItem('CN-LAB-ELECTROLYTES', '电解质组合', '血清、血浆', ['1400205A', '1400305A', '1400404A', '1400505A', '1400605A', '1400705A']),
      panelItem('CN-LAB-HBA1C', '糖化血红蛋白组合', '全血', ['1100301A']),
      panelItem('CN-LAB-COAGULATION', '凝血筛查组合', '血浆', ['0501703A']),
    ]
    const diagnosisConcepts = [
      { code: 'I25.103', display: '冠状动脉粥样硬化性心脏病', row: 12670 },
      { code: 'I10.x09', display: '高血压', row: 12457 },
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
    const manifestPath = join(directory, 'cardiology-release.json')
    await writeFile(join(directory, 'cardiology-reference.json'), artifactJson)
    await writeFile(manifestPath, `${JSON.stringify({
      createdAt: '2026-09-02T00:00:00.000Z',
      releaseId: 'cardiology-order-set-reference-v1',
      schemaVersion: '1',
      sources: [{
        acquisitionMethod: 'generated',
        artifactPath: 'cardiology-reference.json',
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

    const password = `Test-${randomUUID()}-Aa1!`
    runtime = await createClinMeshRuntime({
      activeReferenceReleaseId: 'cardiology-order-set-reference-v1',
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      chatCompletionsProvider: {
        completeJson: async () => ({
          content: JSON.stringify({
            chiefComplaint: '突发胸骨后闷痛两小时',
            knownHistorySummary: '既往高血压病史。',
            medicationMemory: '平时规律服药。',
            openingStatement: '医生您好，我胸口闷痛两小时了。',
            persona: { attitude: '配合', character: '温和', healthLiteracy: '一般', speechStyle: '清晰' },
            symptomExperience: '胸骨后压榨感。',
          }),
          model: 'brief-fixture',
        }),
      },
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'operational.sqlite'),
      demoPassword: password,
      investigationModel: 'unexpected-investigation-model',
      migrationMode: 'apply',
      patientPersonaModel: 'brief-fixture',
      referenceDatabasePath,
      syntheaProvider: {
        capabilities: async () => ({ available: true, maxPopulation: 1, modules: [], providerId: 'synthea', providerName: 'Synthea' }),
        generate: async () => {
          const pid = `patient-${randomUUID()}`
          const bundle = {
            entry: [
              { fullUrl: 'urn:uuid:patient', resource: { birthDate: nextPatient.birthDate, gender: nextPatient.gender, id: pid, name: [{ text: '合成组套患者' }], resourceType: 'Patient' } },
              { fullUrl: 'urn:uuid:encounter', resource: { id: `enc-${pid}`, period: { end: '2026-06-01T10:30:00+08:00', start: '2026-06-01T10:00:00+08:00' }, reasonCode: [{ text: '胸痛' }], resourceType: 'Encounter', status: 'finished', subject: { reference: 'urn:uuid:patient' } } },
              { fullUrl: 'urn:uuid:condition', resource: { code: { coding: [{ code: '386661006', display: '2 型糖尿病', system: 'http://snomed.info/sct' }] }, encounter: { reference: 'urn:uuid:encounter' }, id: `cond-${pid}`, recordedDate: '2026-06-01T10:05:00+08:00', resourceType: 'Condition', subject: { reference: 'urn:uuid:patient' } } },
            ],
            resourceType: 'Bundle',
            type: 'collection',
          }
          return { kind: 'synthea-r4', sources: [{ format: 'fhir-r4-bundle', hash: sourceArtifactHash(bundle), patientId: pid, raw: bundle }] }
        },
      },
      trustedOrigins: ['http://localhost'],
    })

    const ready = current()
    cookies.admin = await signIn(ready, password, 'admin@demo.clinmesh.local')
    cookies.doctor = await signIn(ready, password, 'doctor@demo.clinmesh.local')
    cookies.triage = await signIn(ready, password, 'triage@demo.clinmesh.local')
    cookies.cashier = await signIn(ready, password, 'cashier@demo.clinmesh.local')
    cookies.inpatientDoctor = await signIn(ready, password, 'inpatient-doctor@demo.clinmesh.local')
    cookies.registrar = await signIn(ready, password, 'registrar@demo.clinmesh.local')
    cookies.nurse = await signIn(ready, password, 'ward-nurse@demo.clinmesh.local')

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

  async function postJson(path: string, cookie: string, body: unknown, method: 'POST' | 'PUT' = 'POST') {
    return current().app.request(path, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', cookie, 'idempotency-key': randomUUID(), origin: 'http://localhost' },
      method,
    })
  }

  async function startOutpatientVisit(options: {
    birthDate?: string
    diastolicMmHg?: number
    gender?: 'male' | 'female'
    pulseBpm?: number
    systolicMmHg?: number
    weightKg?: number
  } = {}) {
    nextPatient = { birthDate: options.birthDate ?? '1965-04-12', gender: options.gender ?? 'male' }
    const ready = current()
    expect((await postJson('/api/sim/v1/scenario-generation-jobs', cookies.admin, {
      name: '合成专病组套门诊病例',
      population: { age: { maximum: 75, minimum: 18 }, count: 1, gender: 'any' },
      providerId: 'synthea',
      seeds: { clinical: Math.floor(Math.random() * 100_000) + 1, population: Math.floor(Math.random() * 100_000) + 1 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    })).status).toBe(200)
    const generated = await ready.scenarioData.processNextGenerationJob()
    expect(generated, JSON.stringify(generated)).toMatchObject({ status: 'succeeded' })
    const syntheticCaseId = generated!.caseIds[0]!
    expect((await postJson(`/api/sim/v1/synthetic-cases/${syntheticCaseId}/patient-persona-jobs`, cookies.admin, {})).status).toBe(200)
    expect((await ready.patientPersona.processNext())?.status).toBe('succeeded')
    const syntheticCase = syntheticCaseInstanceSchema.parse(await (await ready.app.request(
      `/api/sim/v1/synthetic-cases/${syntheticCaseId}`,
      { headers: { cookie: cookies.admin } },
    )).json())
    const registration = registrationCatalogSchema.parse(await (await ready.app.request(
      '/api/his/v1/catalogs/registration',
      { headers: { cookie: cookies.admin } },
    )).json())
    const started = commandResponseSchema(startSyntheticCaseResultSchema).parse(await (await postJson(
      `/api/his/v1/synthetic-cases/${syntheticCaseId}/actions/start-outpatient-visit`,
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
          acuityCode: 'level-2',
          bloodPressure: { diastolicMmHg: options.diastolicMmHg ?? 80, systolicMmHg: options.systolicMmHg ?? 132 },
          chiefComplaint: '突发胸骨后闷痛两小时',
          oxygenSaturationPct: 98,
          pulseBpm: options.pulseBpm ?? 76,
          respirationBpm: 18,
          temperatureC: 36.6,
          ...(options.weightKg === undefined ? {} : { weightKg: options.weightKg }),
        },
      },
    )).json()).data
    expect((await postJson(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, cookies.doctor, {
      expectedVersions: { [`Encounter/${started.encounterId}`]: '2', [`Task/${triage.doctorTaskId}`]: '1' },
      input: {},
    })).status).toBe(200)
    return started
  }

  function insertSerumCreatinineReport(options: {
    caseId: string
    encounterId: string
    issuedAt?: string
    patientId: string
    umolPerL: number
  }) {
    const scope = { epoch: 'epoch-2', workspaceId: 'workspace-demo' } as const
    const now = options.issuedAt ?? '2026-08-24T09:10:00+08:00'
    const scrConfigRow = current().database.driver.prepare(`
      SELECT config_json FROM hospital_service_catalog
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND active = 1
        AND json_extract(config_json, '$.laboratoryService.referenceConcept.code') = '1700404A'
      LIMIT 1
    `).get() as { config_json: string }
    const scrService = (JSON.parse(scrConfigRow.config_json) as { laboratoryService: { id: string; referenceConcept: unknown } }).laboratoryService
    const sr = current().fhir.create(scope, {
      code: { text: '合成肾功能' },
      encounter: { reference: `Encounter/${options.encounterId}` },
      id: uuidv7(),
      intent: 'order',
      resourceType: 'ServiceRequest',
      status: 'completed',
      subject: { reference: `Patient/${options.patientId}` },
    })
    const specimen = current().fhir.create(scope, {
      collection: { collectedDateTime: now },
      id: uuidv7(),
      request: [{ reference: `ServiceRequest/${sr.id}` }],
      resourceType: 'Specimen',
      status: 'available',
      subject: { reference: `Patient/${options.patientId}` },
      type: { coding: [{ code: 'serum', display: '血清' }], text: '血清' },
    })
    const obs = current().fhir.create(scope, {
      basedOn: [{ reference: `ServiceRequest/${sr.id}` }],
      code: { coding: [{ code: '1700404A', display: '肌酐测定', system: wstSystem }], text: '肌酐测定' },
      effectiveDateTime: now,
      encounter: { reference: `Encounter/${options.encounterId}` },
      id: uuidv7(),
      interpretation: [{ coding: [{ code: options.umolPerL > 97 ? 'H' : 'N', system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation' }] }],
      referenceRange: [{ high: { unit: 'umol/L', value: 97 }, low: { unit: 'umol/L', value: 57 }, text: '57-97 umol/L' }],
      resourceType: 'Observation',
      specimen: { reference: `Specimen/${specimen.id}` },
      status: 'final',
      subject: { reference: `Patient/${options.patientId}` },
      valueQuantity: { code: 'umol/L', system: 'http://unitsofmeasure.org', unit: 'umol/L', value: options.umolPerL },
    })
    const report = current().fhir.create(scope, {
      basedOn: [{ reference: `ServiceRequest/${sr.id}` }],
      code: { text: '合成肾功能报告' },
      conclusion: '合成检验已完成。',
      encounter: { reference: `Encounter/${options.encounterId}` },
      id: uuidv7(),
      issued: now,
      resourceType: 'DiagnosticReport',
      result: [{ reference: `Observation/${obs.id}` }],
      specimen: [{ reference: `Specimen/${specimen.id}` }],
      status: 'final',
      subject: { reference: `Patient/${options.patientId}` },
    })
    const task = current().fhir.create(scope, {
      focus: { reference: `ServiceRequest/${sr.id}` },
      for: { reference: `Patient/${options.patientId}` },
      id: uuidv7(),
      intent: 'order',
      resourceType: 'Task',
      status: 'completed',
    })
    current().database.driver.prepare(`
      INSERT INTO laboratory_request (
        workspace_id, epoch, request_id, case_id, request_kind, catalog_item_id, reference_json,
        indication_code, service_snapshot_json, service_request_id, execution_task_id,
        diagnostic_report_id, status, version, authored_by, authored_at, reported_at
      ) VALUES ('workspace-demo', 'epoch-2', ?, ?, 'laboratory', ?, ?, 'clinical-evaluation', ?, ?, ?, ?, 'reported', 1, 'actor-test', ?, ?)
    `).run(
      uuidv7(),
      options.caseId,
      scrService.id,
      JSON.stringify(scrService.referenceConcept),
      JSON.stringify(scrService),
      sr.id,
      task.id,
      report.id,
      now,
      now,
    )
  }

  function addConfirmedMedicationAllergy(patientId: string, code: string, display: string) {
    return current().fhir.create({ epoch: 'epoch-2', workspaceId: 'workspace-demo' }, {
      category: ['medication'],
      clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical' }] },
      code: {
        coding: [{ code, display, system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/synthetic-medication' }],
        text: `${display}过敏`,
      },
      criticality: 'high',
      id: `allergy-${randomUUID()}`,
      patient: { reference: `Patient/${patientId}` },
      recordedDate: '2026-08-24T08:30:00+08:00',
      resourceType: 'AllergyIntolerance',
      verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification' }] },
    })
  }

  it('lists all four version-bound order set template definitions and enforces role and scope filters', async () => {
    const allResponse = await current().app.request('/api/his/v1/catalogs/order-set-templates', {
      headers: { cookie: cookies.doctor },
    })
    expect(allResponse.status).toBe(200)
    const all = orderSetTemplateListSchema.parse(await allResponse.json())
    expect(all.items.map(item => item.id)).toEqual([...orderSetTemplateIds])
    for (const template of all.items) {
      expect(template.version).toBe('2026-11-18.r1')
      expect(template.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    }

    const outpatientOnly = orderSetTemplateListSchema.parse(await (await current().app.request(
      '/api/his/v1/catalogs/order-set-templates?scope=outpatient',
      { headers: { cookie: cookies.inpatientDoctor } },
    )).json())
    expect(outpatientOnly.items.map(item => item.id)).toEqual([
      'chest-pain-stat-workup',
      'cad-pci-secondary-prevention',
    ])

    const cashierDenied = await current().app.request('/api/his/v1/catalogs/order-set-templates', {
      headers: { cookie: cookies.cashier },
    })
    expect(cashierDenied.status).toBe(403)
    expect(apiErrorSchema.parse(await cashierDenied.json()).error.code).toBe('ROLE_NOT_ALLOWED')
  })

  it('screens outpatient order sets across normal, missing-input, and contraindicated states with zero formal side-effects, then issues via formal commands', async () => {
    const visit = await startOutpatientVisit({ pulseBpm: 76, systolicMmHg: 128, weightKg: 70 })
    const clinicalCatalog = clinicalCatalogSchema.parse(await (await current().app.request(
      '/api/his/v1/catalogs/clinical',
      { headers: { cookie: cookies.doctor } },
    )).json())
    const cadDiagnosis = clinicalCatalog.diagnoses.find(item => item.code.startsWith('I25'))!

    // 1. Missing triage vitals and missing eGFR must flag pending-verification instead of assuming normal
    const savedTriage = current().database.driver.prepare(
      "SELECT * FROM triage_record WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND case_id = ?",
    ).get(visit.outpatientCaseId) as Record<string, unknown>
    current().database.driver.prepare(
      "DELETE FROM triage_record WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND case_id = ?",
    ).run(visit.outpatientCaseId)

    const missingBundle = orderSetDraftBundleSchema.parse(await (await current().app.request(
      `/api/his/v1/doctor/cases/${visit.outpatientCaseId}/order-set-drafts`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    expect(missingBundle.patientFacts.vitalSigns).toEqual({ source: 'triage', status: 'missing' })
    expect(missingBundle.patientFacts.egfr.status).toBe('missing')
    const missingSecondary = missingBundle.drafts.find(draft => draft.template.id === 'cad-pci-secondary-prevention')!
    expect(missingSecondary.items.find(item => item.key === 'beta-blocker')).toMatchObject({
      disposition: 'needs-review',
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'vital-signs-missing', severity: 'pending-verification' })]),
    })
    expect(missingSecondary.items.find(item => item.key === 'acei')).toMatchObject({
      disposition: 'needs-review',
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'vital-signs-missing', severity: 'pending-verification' }),
        expect.objectContaining({ code: 'egfr-missing', severity: 'pending-verification' }),
      ]),
    })

    // Restore triage vitals and add normal serum creatinine (78 umol/L -> normal eGFR) BEFORE confirming ICD-10 diagnosis:
    // pre-screening must NOT downgrade drugs to needs-review on unconfirmed ICD-10 diagnosis
    const triageCols = Object.keys(savedTriage)
    current().database.driver.prepare(
      `INSERT INTO triage_record (${triageCols.join(', ')}) VALUES (${triageCols.map(col => `@${col}`).join(', ')})`,
    ).run(savedTriage)

    insertSerumCreatinineReport({
      caseId: visit.outpatientCaseId,
      encounterId: visit.encounterId,
      patientId: visit.patientId,
      umolPerL: 78,
    })

    // Snapshot formal counts before calling order-set-drafts to verify zero formal side-effects
    const countBefore = {
      charges: (current().database.driver.prepare(
        "SELECT COUNT(*) AS count FROM charge_record WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND case_id = ?",
      ).get(visit.outpatientCaseId) as { count: number }).count,
      labs: (current().database.driver.prepare(
        "SELECT COUNT(*) AS count FROM laboratory_request WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND case_id = ?",
      ).get(visit.outpatientCaseId) as { count: number }).count,
      prescriptions: (current().database.driver.prepare(
        "SELECT COUNT(*) AS count FROM prescription WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND case_id = ?",
      ).get(visit.outpatientCaseId) as { count: number }).count,
    }

    const normalBundle = orderSetDraftBundleSchema.parse(await (await current().app.request(
      `/api/his/v1/doctor/cases/${visit.outpatientCaseId}/order-set-drafts`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    expect(normalBundle.drafts.map(draft => draft.template.id)).toEqual([
      'chest-pain-stat-workup',
      'cad-pci-secondary-prevention',
    ])
    const chestPain = normalBundle.drafts[0]!
    expect(chestPain.counts).toEqual({ excluded: 0, needsReview: 0, ready: 5, unavailable: 0 })
    const secondaryPrevention = normalBundle.drafts[1]!
    expect(secondaryPrevention.counts).toEqual({ excluded: 0, needsReview: 0, ready: 6, unavailable: 0 })

    // Zero formal side-effects invariant
    expect({
      charges: (current().database.driver.prepare(
        "SELECT COUNT(*) AS count FROM charge_record WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND case_id = ?",
      ).get(visit.outpatientCaseId) as { count: number }).count,
      labs: (current().database.driver.prepare(
        "SELECT COUNT(*) AS count FROM laboratory_request WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND case_id = ?",
      ).get(visit.outpatientCaseId) as { count: number }).count,
      prescriptions: (current().database.driver.prepare(
        "SELECT COUNT(*) AS count FROM prescription WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND case_id = ?",
      ).get(visit.outpatientCaseId) as { count: number }).count,
    }).toEqual(countBefore)

    const diagDraft = diagnosisDraftResponseSchema.parse(await (await postJson(
      `/api/his/v1/encounters/${visit.encounterId}/diagnosis/draft`,
      cookies.doctor,
      {
        expectedVersions: { [`Encounter/${visit.encounterId}`]: '3' },
        input: { entries: [{ catalogItemId: cadDiagnosis.id, role: 'primary' }], expectedDraftVersion: 0 },
      },
      'PUT',
    )).json()).data
    const diagConfirmed = confirmDiagnosisResponseSchema.parse(await (await postJson(
      `/api/his/v1/encounters/${visit.encounterId}/diagnosis/actions/confirm`,
      cookies.doctor,
      {
        expectedVersions: { [`Encounter/${visit.encounterId}`]: '3' },
        input: { expectedDraftVersion: diagDraft.draftVersion },
      },
    )).json()).data
    let encounterVersion = diagConfirmed.encounterVersion

    // Inpatient-only template requested on an outpatient case returns 409 ORDER_SET_SCOPE_NOT_APPLICABLE
    const scopeConflict = await current().app.request(
      `/api/his/v1/doctor/cases/${visit.outpatientCaseId}/order-set-drafts?templateId=cin-perioperative-hydration`,
      { headers: { cookie: cookies.doctor } },
    )
    expect(scopeConflict.status).toBe(409)
    expect(apiErrorSchema.parse(await scopeConflict.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT', reason: 'ORDER_SET_SCOPE_NOT_APPLICABLE' },
    })

    // 2. Formal issuance handoff: issue ECG + hs-cTnI + secondary prevention prescription from pre-assembled candidates
    const ecgCandidate = chestPain.items.find(item => item.key === 'ecg-12-lead')!.candidate!
    expect(ecgCandidate.kind).toBe('examination')
    if (ecgCandidate.kind === 'examination') {
      const savedExam = examinationRequestDraftResponseSchema.parse(await (await postJson(
        `/api/his/v1/encounters/${visit.encounterId}/examination-request/draft`,
        cookies.doctor,
        {
          expectedVersions: { [`Encounter/${visit.encounterId}`]: encounterVersion },
          input: { expectedDraftVersion: 0, indication: ecgCandidate.indication, serviceId: ecgCandidate.serviceId },
        },
        'PUT',
      )).json()).data
      const issuedExam = await postJson(
        `/api/his/v1/encounters/${visit.encounterId}/examination-request/actions/issue`,
        cookies.doctor,
        {
          expectedVersions: { [`Encounter/${visit.encounterId}`]: encounterVersion },
          input: { expectedDraftVersion: savedExam.draftVersion },
        },
      )
      expect(issuedExam.status).toBe(200)
      expect(issueExaminationRequestResponseSchema.parse(await issuedExam.json()).data.request.service.id).toBe('examination-ecg-12-lead')
    }

    const hsCtniCandidate = chestPain.items.find(item => item.key === 'hs-ctni')!.candidate!
    expect(hsCtniCandidate.kind).toBe('laboratory')
    if (hsCtniCandidate.kind === 'laboratory') {
      const savedLab = laboratoryRequestDraftResponseSchema.parse(await (await postJson(
        `/api/his/v1/encounters/${visit.encounterId}/laboratory-request/draft`,
        cookies.doctor,
        {
          expectedVersions: { [`Encounter/${visit.encounterId}`]: encounterVersion },
          input: { catalogItemId: hsCtniCandidate.catalogItemId, expectedDraftVersion: 0, indicationCode: hsCtniCandidate.indicationCode },
        },
        'PUT',
      )).json()).data
      const issuedLab = await postJson(
        `/api/his/v1/encounters/${visit.encounterId}/laboratory-request/actions/issue`,
        cookies.doctor,
        {
          expectedVersions: { [`Encounter/${visit.encounterId}`]: encounterVersion },
          input: { expectedDraftVersion: savedLab.draftVersion },
        },
      )
      expect(issuedLab.status).toBe(200)
      expect(issueLaboratoryRequestResponseSchema.parse(await issuedLab.json()).data.request.catalogItemId).toBe(hsCtniCandidate.catalogItemId)
    }

    const prescriptionItems = secondaryPrevention.items.flatMap(item =>
      item.candidate?.kind === 'medication' && item.candidate.outpatient !== null
        ? [{
            catalogItemId: item.candidate.catalogItemId,
            courseDays: item.candidate.outpatient.courseDays,
            doseText: item.candidate.doseText,
            frequencyCode: item.candidate.frequencyCode,
            quantity: item.candidate.outpatient.quantity,
          }]
        : [],
    )
    expect(prescriptionItems).toHaveLength(6)
    const savedRx = prescriptionDraftResponseSchema.parse(await (await postJson(
      `/api/his/v1/encounters/${visit.encounterId}/prescription/draft`,
      cookies.doctor,
      {
        expectedVersions: { [`Encounter/${visit.encounterId}`]: encounterVersion },
        input: { expectedDraftVersion: 0, items: prescriptionItems },
      },
      'PUT',
    )).json()).data
    const issuedRx = await postJson(
      `/api/his/v1/encounters/${visit.encounterId}/prescription/actions/issue`,
      cookies.doctor,
      {
        expectedVersions: { [`Encounter/${visit.encounterId}`]: encounterVersion },
        input: { expectedDraftVersion: savedRx.draftVersion },
      },
    )
    expect(issuedRx.status, await issuedRx.clone().text()).toBe(200)
    expect(issuePrescriptionResponseSchema.parse(await issuedRx.json()).data.prescription.items).toHaveLength(6)

    // 3. Contraindicated outpatient: bradycardia + hypotension + severe renal impairment + aspirin & clopidogrel allergies
    const contraindicatedVisit = await startOutpatientVisit({ pulseBpm: 46, systolicMmHg: 84, weightKg: 65 })
    insertSerumCreatinineReport({
      caseId: contraindicatedVisit.outpatientCaseId,
      encounterId: contraindicatedVisit.encounterId,
      patientId: contraindicatedVisit.patientId,
      umolPerL: 265,
    })
    addConfirmedMedicationAllergy(contraindicatedVisit.patientId, 'ASPIRIN', '阿司匹林')
    addConfirmedMedicationAllergy(contraindicatedVisit.patientId, 'CLOPIDOGREL', '硫酸氢氯吡格雷')

    const contraBundle = orderSetDraftBundleSchema.parse(await (await current().app.request(
      `/api/his/v1/doctor/cases/${contraindicatedVisit.outpatientCaseId}/order-set-drafts?templateId=cad-pci-secondary-prevention`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    const contraDraft = contraBundle.drafts[0]!
    expect(contraDraft.counts).toEqual({ excluded: 5, needsReview: 0, ready: 1, unavailable: 0 })
    expect(contraDraft.items.find(item => item.key === 'aspirin')).toMatchObject({
      candidate: null,
      disposition: 'excluded',
      matchedCatalogId: 'medication-pci-aspirin',
      reasons: expect.arrayContaining([
        expect.objectContaining({
          allergen: { code: 'ASPIRIN', display: '阿司匹林' },
          code: 'allergy-contraindication',
          severity: 'exclude',
        }),
      ]),
    })
    expect(contraDraft.items.find(item => item.key === 'p2y12-inhibitor')).toMatchObject({
      candidate: null,
      disposition: 'excluded',
      matchedCatalogId: 'medication-pci-clopidogrel',
      reasons: expect.arrayContaining([
        expect.objectContaining({
          allergen: { code: 'CLOPIDOGREL', display: '硫酸氢氯吡格雷' },
          code: 'allergy-contraindication',
          severity: 'exclude',
        }),
      ]),
    })
    expect(contraDraft.items.find(item => item.key === 'statin')).toMatchObject({
      disposition: 'ready',
      matchedCatalogId: 'medication-pci-atorvastatin',
    })
    expect(contraDraft.items.find(item => item.key === 'beta-blocker')).toMatchObject({
      candidate: null,
      disposition: 'excluded',
      matchedCatalogId: 'medication-metoprolol',
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'pulse-below-threshold', observedValue: 46, severity: 'exclude', threshold: 50 }),
        expect.objectContaining({ code: 'systolic-below-threshold', observedValue: 84, severity: 'exclude', threshold: 90 }),
      ]),
    })
    expect(contraDraft.items.find(item => item.key === 'acei')).toMatchObject({
      candidate: null,
      disposition: 'excluded',
      matchedCatalogId: 'medication-perindopril',
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'systolic-below-threshold', severity: 'exclude', threshold: 90 }),
        expect.objectContaining({ code: 'egfr-below-threshold', severity: 'exclude', threshold: 30 }),
      ]),
    })
    expect(contraDraft.items.find(item => item.key === 'nitroglycerin-prn')).toMatchObject({
      candidate: null,
      disposition: 'excluded',
      matchedCatalogId: 'medication-nitroglycerin',
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'systolic-below-threshold', severity: 'exclude', threshold: 90 })]),
    })
    const contraDetail = doctorCaseDetailSchema.parse(await (await current().app.request(
      `/api/his/v1/doctor/cases/${contraindicatedVisit.outpatientCaseId}`,
      { headers: { cookie: cookies.doctor } },
    )).json())
    expect(contraDetail.medicationConclusion?.prescription).toBeUndefined()
  })

  it('screens all four inpatient order sets using nursing vital signs and eGFR, preserves zero formal side-effects, and issues via inpatient commands', async () => {
    const visit = await startOutpatientVisit()
    const patient = fhirResourceSchema.parse(await (await current().app.request(
      `/fhir/R5/Patient/${visit.patientId}`,
      { headers: { cookie: cookies.registrar } },
    )).json())
    const registered = inpatientCommandResponseSchema.parse(await (await postJson('/api/his/v1/inpatient/admissions', cookies.registrar, {
      input: {
        admissionRoute: 'direct',
        depositFen: 200_000,
        expectedEpoch: 'epoch-2',
        patientId: patient.id,
        patientVersion: patient.meta!.versionId,
        wardId: 'ward-general',
      },
    })).json()).data.admission
    const admissionPath = `/api/his/v1/inpatient/admissions/${registered.id}`
    const received = inpatientCommandResponseSchema.parse(await (await postJson(`${admissionPath}/receive`, cookies.nurse, {
      input: { bedId: 'bed-general-1', encounterVersion: registered.versionId },
    })).json()).data.admission
    let encounterVersion = received.versionId

    // 1. Before nursing vitals, creatinine, or confirmed diagnosis: missing vitals/weight/eGFR flagged as pending-verification
    const initialInpatient = orderSetDraftBundleSchema.parse(await (await current().app.request(
      `${admissionPath}/order-set-drafts`,
      { headers: { cookie: cookies.inpatientDoctor } },
    )).json())
    expect(initialInpatient.drafts.map(draft => draft.template.id)).toEqual([...orderSetTemplateIds])
    expect(initialInpatient.patientFacts.vitalSigns).toEqual({ source: 'inpatient-nursing', status: 'missing' })
    expect(initialInpatient.patientFacts.weight).toEqual({ status: 'missing' })
    expect(initialInpatient.patientFacts.egfr.status).toBe('missing')

    const baselineDraft = initialInpatient.drafts.find(draft => draft.template.id === 'cad-admission-baseline')!
    expect(baselineDraft.counts).toEqual({ excluded: 0, needsReview: 0, ready: 10, unavailable: 0 })

    const hydrationMissing = initialInpatient.drafts.find(draft => draft.template.id === 'cin-perioperative-hydration')!
    expect(hydrationMissing.items.find(item => item.key === 'isotonic-saline-hydration')).toMatchObject({
      disposition: 'needs-review',
      reasons: [
        expect.objectContaining({ code: 'egfr-missing', severity: 'pending-verification' }),
        expect.objectContaining({ code: 'weight-missing', severity: 'pending-verification' }),
      ],
    })
    const initialSecondary = initialInpatient.drafts.find(draft => draft.template.id === 'cad-pci-secondary-prevention')!
    expect(initialSecondary.items.find(item => item.key === 'aspirin')?.disposition).toBe('ready')
    expect(initialSecondary.items.find(item => item.key === 'p2y12-inhibitor')?.disposition).toBe('ready')
    expect(initialSecondary.items.find(item => item.key === 'statin')?.disposition).toBe('ready')

    // 2. Confirm CAD diagnosis, record nursing vitals with weight, and add eGFR ~42 mL/min/1.73m² (creatinine 155 umol/L -> high CIN risk)
    const confirmedDiag = inpatientFullClinicalResponseSchema.parse(await (await postJson(`${admissionPath}/diagnoses/confirm`, cookies.inpatientDoctor, {
      input: {
        encounterVersion,
        entries: [{
          admissionCondition: '1',
          catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I25.103',
          role: 'primary',
        }],
        expectedRevision: 0,
      },
    })).json()).data
    encounterVersion = confirmedDiag.encounterVersion

    expect((await postJson(`${admissionPath}/vital-signs`, cookies.nurse, {
      input: {
        bloodPressure: { diastolicMmHg: 76, systolicMmHg: 126 },
        encounterVersion,
        expectedRevision: 0,
        oxygenSaturationPct: 98,
        pulseBpm: 72,
        respirationBpm: 18,
        temperatureC: 36.6,
        weightKg: 68,
      },
    })).status).toBe(200)

    insertSerumCreatinineReport({
      caseId: registered.id,
      encounterId: registered.id,
      patientId: patient.id,
      umolPerL: 155,
    })

    const inpatientCountBefore = {
      charges: (current().database.driver.prepare(
        "SELECT COUNT(*) AS count FROM inpatient_charge WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND admission_id = ?",
      ).get(registered.id) as { count: number }).count,
      investigations: (current().database.driver.prepare(
        "SELECT COUNT(*) AS count FROM inpatient_investigation WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND admission_id = ?",
      ).get(registered.id) as { count: number }).count,
      orders: (current().database.driver.prepare(
        "SELECT COUNT(*) AS count FROM inpatient_order WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND admission_id = ?",
      ).get(registered.id) as { count: number }).count,
    }

    const cinReadyBundle = orderSetDraftBundleSchema.parse(await (await current().app.request(
      `${admissionPath}/order-set-drafts`,
      { headers: { cookie: cookies.inpatientDoctor } },
    )).json())
    expect(cinReadyBundle.patientFacts.vitalSigns).toMatchObject({
      pulseBpm: 72,
      source: 'inpatient-nursing',
      status: 'present',
      systolicMmHg: 126,
    })
    expect(cinReadyBundle.patientFacts.weight).toMatchObject({ status: 'present', weightKg: 68 })
    expect(cinReadyBundle.patientFacts.egfr.status).toBe('present')

    const hydrationReady = cinReadyBundle.drafts.find(draft => draft.template.id === 'cin-perioperative-hydration')!
    expect(hydrationReady.counts).toEqual({ excluded: 0, needsReview: 0, ready: 2, unavailable: 0 })
    const salineCandidate = hydrationReady.items.find(item => item.key === 'isotonic-saline-hydration')!.candidate!
    expect(salineCandidate).toMatchObject({
      doseText: '1000 mL',
      frequencyCode: 'ONCE',
      inpatient: { doseQuantity: 2, duration: 'temporary' },
      kind: 'medication',
    })

    // ACEI in secondary prevention receives a caution (needs-review) because 30 <= eGFR < 60, while other 5 drugs are ready
    const secondaryInpatient = cinReadyBundle.drafts.find(draft => draft.template.id === 'cad-pci-secondary-prevention')!
    expect(secondaryInpatient.items.find(item => item.key === 'acei')).toMatchObject({
      disposition: 'needs-review',
      reasons: [expect.objectContaining({ code: 'egfr-below-threshold', severity: 'caution', threshold: 60 })],
    })
    expect(secondaryInpatient.counts).toEqual({ excluded: 0, needsReview: 1, ready: 5, unavailable: 0 })

    // Zero formal side-effects invariant on inpatient tables
    expect({
      charges: (current().database.driver.prepare(
        "SELECT COUNT(*) AS count FROM inpatient_charge WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND admission_id = ?",
      ).get(registered.id) as { count: number }).count,
      investigations: (current().database.driver.prepare(
        "SELECT COUNT(*) AS count FROM inpatient_investigation WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND admission_id = ?",
      ).get(registered.id) as { count: number }).count,
      orders: (current().database.driver.prepare(
        "SELECT COUNT(*) AS count FROM inpatient_order WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND admission_id = ?",
      ).get(registered.id) as { count: number }).count,
    }).toEqual(inpatientCountBefore)

    // 3. Formal inpatient issuance handoff: issue TTE + creatinine recheck + isotonic saline + ready secondary prevention orders
    const tteCandidate = cinReadyBundle.drafts
      .find(draft => draft.template.id === 'cad-admission-baseline')!
      .items.find(item => item.key === 'tte')!.candidate!
    if (tteCandidate.kind === 'examination') {
      const tteIssued = await postJson(`${admissionPath}/investigations/issue`, cookies.inpatientDoctor, {
        input: {
          catalogVersion: tteCandidate.catalogVersion,
          encounterVersion,
          selection: { indication: tteCandidate.indication, kind: 'examination', serviceId: tteCandidate.serviceId },
        },
      })
      expect(tteIssued.status, await tteIssued.clone().text()).toBe(200)
      expect(inpatientInvestigationResponseSchema.parse(await tteIssued.json()).data.examinationRequests[0]?.service.examCode).toBe('tte')
    }

    const scrCandidate = hydrationReady.items.find(item => item.key === 'creatinine-recheck')!.candidate!
    if (scrCandidate.kind === 'laboratory') {
      const scrIssued = await postJson(`${admissionPath}/investigations/issue`, cookies.inpatientDoctor, {
        input: {
          catalogVersion: scrCandidate.catalogVersion,
          encounterVersion,
          selection: { catalogItemId: scrCandidate.catalogItemId, indicationCode: scrCandidate.indicationCode, kind: 'laboratory' },
        },
      })
      expect(scrIssued.status, await scrIssued.clone().text()).toBe(200)
    }

    if (salineCandidate.kind === 'medication' && salineCandidate.inpatient !== null) {
      const salineOrder = await postJson(`${admissionPath}/orders/issue`, cookies.inpatientDoctor, {
        input: {
          duration: salineCandidate.inpatient.duration,
          encounterVersion,
          selection: {
            catalogItemId: salineCandidate.catalogItemId,
            catalogVersion: salineCandidate.catalogVersion,
            doseQuantity: salineCandidate.inpatient.doseQuantity,
            doseText: salineCandidate.doseText,
            frequencyCode: salineCandidate.frequencyCode,
            kind: 'medication',
          },
        },
      })
      expect(salineOrder.status, await salineOrder.clone().text()).toBe(200)
      encounterVersion = inpatientFullClinicalResponseSchema.parse(await salineOrder.json()).data.encounterVersion
    }

    // 4. Subsequent nursing vitals showing bradycardia/hypotension + severe renal impairment + atorvastatin allergy
    expect((await postJson(`${admissionPath}/vital-signs`, cookies.nurse, {
      input: {
        bloodPressure: { diastolicMmHg: 54, systolicMmHg: 85 },
        encounterVersion,
        expectedRevision: 1,
        oxygenSaturationPct: 96,
        pulseBpm: 45,
        respirationBpm: 20,
        temperatureC: 36.5,
      },
    })).status).toBe(200)
    addConfirmedMedicationAllergy(patient.id, 'ATORVASTATIN', '阿托伐他汀钙')
    // Insert newer severe renal impairment creatinine (310 umol/L -> eGFR < 30)
    insertSerumCreatinineReport({
      caseId: registered.id,
      encounterId: registered.id,
      issuedAt: '2026-08-24T11:00:00+08:00',
      patientId: patient.id,
      umolPerL: 310,
    })

    const deteriorated = orderSetDraftBundleSchema.parse(await (await current().app.request(
      `${admissionPath}/order-set-drafts?templateId=cad-pci-secondary-prevention`,
      { headers: { cookie: cookies.inpatientDoctor } },
    )).json()).drafts[0]!
    // Weight from earlier revision (68 kg) is retained even when latest vitals revision omitted weightKg
    expect(deteriorated.items.find(item => item.key === 'statin')).toMatchObject({
      candidate: null,
      disposition: 'excluded',
      matchedCatalogId: 'medication-pci-atorvastatin',
      reasons: [
        expect.objectContaining({
          allergen: { code: 'ATORVASTATIN', display: '阿托伐他汀钙' },
          code: 'allergy-contraindication',
          severity: 'exclude',
        }),
      ],
    })
    expect(deteriorated.items.find(item => item.key === 'beta-blocker')?.disposition).toBe('excluded')
    expect(deteriorated.items.find(item => item.key === 'acei')?.disposition).toBe('excluded')
    expect(deteriorated.items.find(item => item.key === 'nitroglycerin-prn')?.disposition).toBe('excluded')
    expect(deteriorated.counts).toEqual({ excluded: 4, needsReview: 0, ready: 2, unavailable: 0 })

    // 5. Distinguish catalog-unavailable vs catalog-unpriced on inpatient investigations
    const bnpRow = current().database.driver.prepare(`
      SELECT service_id, config_json FROM hospital_service_catalog
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND active = 1
        AND json_extract(config_json, '$.laboratoryService.referenceConcept.code') = '2100704A'
      LIMIT 1
    `).get() as { config_json: string; service_id: string }
    const bnpConfig = JSON.parse(bnpRow.config_json) as Record<string, unknown>
    const withoutBilling = { ...bnpConfig }
    delete withoutBilling.inpatientInvestigationBilling
    current().database.driver.prepare(
      "UPDATE hospital_service_catalog SET config_json = ? WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND service_id = ?",
    ).run(JSON.stringify(withoutBilling), bnpRow.service_id)
    const unpricedBaseline = orderSetDraftBundleSchema.parse(await (await current().app.request(
      `${admissionPath}/order-set-drafts?templateId=cad-admission-baseline`,
      { headers: { cookie: cookies.inpatientDoctor } },
    )).json()).drafts[0]!
    expect(unpricedBaseline.items.find(item => item.key === 'nt-probnp')).toMatchObject({
      candidate: null,
      disposition: 'unavailable',
      matchedCatalogId: null,
      reasons: [expect.objectContaining({ code: 'catalog-unpriced', severity: 'unavailable' })],
    })

    const notOffered = { ...bnpConfig, laboratoryService: { ...(bnpConfig.laboratoryService as Record<string, unknown>), reportDefinition: undefined } }
    current().database.driver.prepare(
      "UPDATE hospital_service_catalog SET config_json = ? WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND service_id = ?",
    ).run(JSON.stringify(notOffered), bnpRow.service_id)
    const unavailableBaseline = orderSetDraftBundleSchema.parse(await (await current().app.request(
      `${admissionPath}/order-set-drafts?templateId=cad-admission-baseline`,
      { headers: { cookie: cookies.inpatientDoctor } },
    )).json()).drafts[0]!
    expect(unavailableBaseline.items.find(item => item.key === 'nt-probnp')).toMatchObject({
      candidate: null,
      disposition: 'unavailable',
      matchedCatalogId: null,
      reasons: [expect.objectContaining({ code: 'catalog-unavailable', severity: 'unavailable' })],
    })
    current().database.driver.prepare(
      "UPDATE hospital_service_catalog SET config_json = ? WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND service_id = ?",
    ).run(bnpRow.config_json, bnpRow.service_id)
  })
})
