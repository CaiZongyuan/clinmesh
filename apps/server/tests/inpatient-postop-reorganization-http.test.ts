import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { clinicalQualityCheckSchema } from '@clinmesh/contracts/clinical-quality'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import {
  apiErrorSchema,
  commandResponseSchema,
  registrationCatalogSchema,
  scenarioCommandResponseSchema,
  scenarioStateSchema,
} from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import {
  inpatientChargesSchema,
  inpatientFullCatalogSchema,
  inpatientFullClinicalResponseSchema,
  inpatientFullClinicalSchema,
} from '@clinmesh/contracts/inpatient-clinical'
import {
  inpatientInvestigationCatalogSchema,
  inpatientInvestigationResponseSchema,
  inpatientInvestigationsSchema,
} from '@clinmesh/contracts/inpatient-investigations'
import { inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import {
  inpatientSurgeryCatalogSchema,
  inpatientSurgeryCompletionPreviewSchema,
  inpatientSurgeryResponseSchema,
  inpatientSurgerySchema,
  type PreopOrderPolicy,
} from '@clinmesh/contracts/inpatient-surgery'
import {
  orderSetDraftBundleSchema,
  orderSetTemplateListSchema,
} from '@clinmesh/contracts/order-set-templates'
import { startSyntheticCaseResultSchema, syntheticCaseInstanceSchema } from '@clinmesh/contracts/scenario'
import { sourceArtifactHash } from '../src/application/scenario-data/provider.ts'
import { applyMigrations, openClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'

type ClinMeshRuntime = Awaited<ReturnType<typeof createClinMeshRuntime>>

const wstSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026'
const panelSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn'
const datasetReleaseId = 'laboratory-cn@2026-09-01.r1'

async function signIn(runtime: ClinMeshRuntime, password: string, email: string): Promise<string> {
  const response = await runtime.app.request('/api/auth/sign-in/email', {
    body: JSON.stringify({ email, password }),
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    method: 'POST',
  })
  expect(response.status).toBe(200)
  return response.headers.get('set-cookie')!.split(';', 1)[0]!
}

describe('手术通知单停续术前医嘱策略与术后成套医嘱模板重整', () => {
  let directory = ''
  let runtime: ClinMeshRuntime | undefined
  const cookies = { admin: '', cashier: '', doctor: '', nurse: '', registrar: '' }
  const current = () => runtime!

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'clinmesh-postop-reorg-'))
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
    const panelItem = (code: string, display: string, specimen: string, memberCodes: string[]) => ({
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
      members: memberCodes.map((memberCode, index) => ({
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
      testItem('0100301A', '血红蛋白测定', '全血', 'g/L', 0, [rangeRule(130, 175, 'male'), rangeRule(115, 150, 'female')]),
      testItem('0100401A', '血小板计数', '全血', '10*9/L', 0, [rangeRule(125, 350)]),
      testItem('2100404B', '高敏心肌肌钙蛋白I测定', '血清、血浆', 'ng/L', 1, [upperRule(34.2, 2.0, 'male'), upperRule(15.6, 1.5, 'female')]),
      testItem('1700204A', '尿素测定', '血清、血浆', 'mmol/L', 2, [rangeRule(2.8, 7.6)]),
      testItem('1700304A', '尿酸测定', '血清、血浆', 'umol/L', 0, [rangeRule(208, 428, 'male'), rangeRule(155, 357, 'female')]),
      testItem('1700404A', '肌酐测定', '血清、血浆', 'umol/L', 0, [rangeRule(57, 97, 'male'), rangeRule(41, 73, 'female')]),
      testItem('1400205A', '钠测定', '血清、血浆', 'mmol/L', 1, [rangeRule(137, 147)]),
      testItem('1400505A', '氯测定', '血清、血浆', 'mmol/L', 1, [rangeRule(99, 110)]),
      testItem('1400605A', '钾测定', '血清、血浆', 'mmol/L', 2, [rangeRule(3.5, 5.3)]),
    ]
    const panels = [
      panelItem('CN-LAB-CBC-5DIFF', '血常规（五分类）', '全血', ['0100101A', '0100201A', '0100301A', '0100401A']),
      panelItem('CN-LAB-RENAL', '肾功能组合', '血清、血浆', ['1700204A', '1700304A', '1700404A']),
      panelItem('CN-LAB-ELECTROLYTES', '电解质组合', '血清、血浆', ['1400205A', '1400505A', '1400605A']),
    ]
    const diagnosisConcepts = [
      { code: 'I25.103', display: '冠状动脉粥样硬化性心脏病', row: 12670 },
      { code: 'I10.x09', display: '高血压', row: 12457 },
      { code: 'K80.200', display: '胆囊结石', row: 14120 },
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
    const manifestPath = join(directory, 'postop-reference-manifest.json')
    await writeFile(join(directory, 'postop-reference.json'), artifactJson)
    await writeFile(manifestPath, `${JSON.stringify({
      createdAt: '2026-09-02T00:00:00.000Z',
      releaseId: 'postop-reorg-reference-v1',
      schemaVersion: '1',
      sources: [{
        acquisitionMethod: 'generated',
        artifactPath: 'postop-reference.json',
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
      activeReferenceReleaseId: 'postop-reorg-reference-v1',
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      chatCompletionsProvider: {
        completeJson: async () => ({
          content: JSON.stringify({
            chiefComplaint: '胸闷或右上腹痛就诊',
            knownHistorySummary: '既往高血压病史。',
            medicationMemory: '规律服药。',
            openingStatement: '医生您好，我来做住院手术治疗。',
            persona: { attitude: '配合', character: '温和', healthLiteracy: '一般', speechStyle: '清晰' },
            symptomExperience: '活动后胸闷或餐后右上腹不适。',
          }),
          model: 'brief-fixture',
        }),
      },
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'hospital.sqlite'),
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
              { fullUrl: 'urn:uuid:patient', resource: { birthDate: '1965-04-12', gender: 'male', id: pid, name: [{ text: '合成术后重整患者' }], resourceType: 'Patient' } },
              { fullUrl: 'urn:uuid:encounter', resource: { id: `enc-${pid}`, period: { end: '2026-06-01T10:30:00+08:00', start: '2026-06-01T10:00:00+08:00' }, reasonCode: [{ text: '冠心病或胆囊结石' }], resourceType: 'Encounter', status: 'finished', subject: { reference: 'urn:uuid:patient' } } },
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
    cookies.registrar = await signIn(ready, password, 'registrar@demo.clinmesh.local')
    cookies.doctor = await signIn(ready, password, 'inpatient-doctor@demo.clinmesh.local')
    cookies.nurse = await signIn(ready, password, 'ward-nurse@demo.clinmesh.local')
    cookies.cashier = await signIn(ready, password, 'cashier@demo.clinmesh.local')

    const currentScenario = scenarioStateSchema.parse(await (await ready.app.request(
      '/api/sim/v1/scenario-runs/current',
      { headers: { cookie: cookies.admin } },
    )).json())
    const resetRes = await ready.app.request(`/api/sim/v1/scenario-runs/${currentScenario.scenarioRunId}/actions/reset`, {
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json', cookie: cookies.admin, 'idempotency-key': randomUUID(), origin: 'http://localhost' },
      method: 'POST',
    })
    expect(resetRes.status).toBe(200)
    expect(scenarioCommandResponseSchema.parse(await resetRes.json()).data.epoch).toBe('epoch-2')
  }, 60_000)

  afterAll(async () => {
    await runtime?.close()
    if (directory !== '') await rm(directory, { force: true, recursive: true })
  })

  async function request(cookie: string, path: string, input?: unknown, key: string = randomUUID()) {
    return current().app.request(path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        cookie,
        origin: 'http://localhost',
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      ...(input === undefined ? {} : { body: JSON.stringify({ input }) }),
    })
  }

  async function rawPost(cookie: string, path: string, body: unknown) {
    return current().app.request(path, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', cookie, 'idempotency-key': randomUUID(), origin: 'http://localhost' },
      method: 'POST',
    })
  }

  async function createAdmission(bedId: string) {
    const ready = current()
    expect((await rawPost(cookies.admin, '/api/sim/v1/scenario-generation-jobs', {
      name: '合成术后重整病例',
      population: { age: { maximum: 75, minimum: 18 }, count: 1, gender: 'any' },
      providerId: 'synthea',
      seeds: { clinical: Math.floor(Math.random() * 100_000) + 1, population: Math.floor(Math.random() * 100_000) + 1 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    })).status).toBe(200)
    const generated = await ready.scenarioData.processNextGenerationJob()
    expect(generated).toMatchObject({ status: 'succeeded' })
    const syntheticCaseId = generated!.caseIds[0]!
    expect((await rawPost(cookies.admin, `/api/sim/v1/synthetic-cases/${syntheticCaseId}/patient-persona-jobs`, {})).status).toBe(200)
    expect((await ready.patientPersona.processNext())?.status).toBe('succeeded')
    const syntheticCase = syntheticCaseInstanceSchema.parse(await (await ready.app.request(
      `/api/sim/v1/synthetic-cases/${syntheticCaseId}`,
      { headers: { cookie: cookies.admin } },
    )).json())
    const registration = registrationCatalogSchema.parse(await (await ready.app.request(
      '/api/his/v1/catalogs/registration',
      { headers: { cookie: cookies.admin } },
    )).json())
    const started = commandResponseSchema(startSyntheticCaseResultSchema).parse(await (await rawPost(
      cookies.admin,
      `/api/his/v1/synthetic-cases/${syntheticCaseId}/actions/start-outpatient-visit`,
      {
        activeBriefRevision: syntheticCase.activeBriefRevision,
        departmentId: registration.departments[0]!.id,
        expectedCaseRevision: syntheticCase.revision,
        locationId: registration.locations[0]!.id,
        visitDate: registration.virtualDate,
        visitTypeId: registration.visitTypes[0]!.id,
      },
    )).json()).data

    const patient = fhirResourceSchema.parse(await (await request(cookies.registrar, `/fhir/R5/Patient/${started.patientId}`)).json())
    const registered = inpatientCommandResponseSchema.parse(await (await request(cookies.registrar, '/api/his/v1/inpatient/admissions', {
      admissionRoute: 'direct',
      depositFen: 200000,
      expectedEpoch: 'epoch-2',
      patientId: patient.id,
      patientVersion: patient.meta!.versionId,
      wardId: 'ward-general',
    })).json()).data.admission
    const admission = inpatientCommandResponseSchema.parse(await (await request(cookies.nurse, `/api/his/v1/inpatient/admissions/${registered.id}/receive`, {
      bedId,
      encounterVersion: registered.versionId,
    })).json()).data.admission

    return {
      admission,
      patient: { id: patient.id, name: '合成术后重整患者' },
      path: `/api/his/v1/inpatient/admissions/${admission.id}`,
    }
  }

  function insertSerumCreatinineReport(admissionId: string, patientId: string, umolPerL: number) {
    const scope = { epoch: 'epoch-2', workspaceId: 'workspace-demo' } as const
    const now = '2026-08-24T09:10:00+08:00'
    const scrConfigRow = current().database.driver.prepare(`
      SELECT config_json FROM hospital_service_catalog
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND active = 1
        AND json_extract(config_json, '$.laboratoryService.referenceConcept.code') = '1700404A'
      LIMIT 1
    `).get() as { config_json: string }
    const scrService = (JSON.parse(scrConfigRow.config_json) as { laboratoryService: { id: string; referenceConcept: unknown } }).laboratoryService
    const sr = current().fhir.create(scope, {
      code: { text: '合成肾功能' },
      encounter: { reference: `Encounter/${admissionId}` },
      id: uuidv7(),
      intent: 'order',
      resourceType: 'ServiceRequest',
      status: 'completed',
      subject: { reference: `Patient/${patientId}` },
    })
    const specimen = current().fhir.create(scope, {
      collection: { collectedDateTime: now },
      id: uuidv7(),
      request: [{ reference: `ServiceRequest/${sr.id}` }],
      resourceType: 'Specimen',
      status: 'available',
      subject: { reference: `Patient/${patientId}` },
      type: { coding: [{ code: 'serum', display: '血清' }], text: '血清' },
    })
    const obs = current().fhir.create(scope, {
      basedOn: [{ reference: `ServiceRequest/${sr.id}` }],
      code: { coding: [{ code: '1700404A', display: '肌酐测定', system: wstSystem }], text: '肌酐测定' },
      effectiveDateTime: now,
      encounter: { reference: `Encounter/${admissionId}` },
      id: uuidv7(),
      interpretation: [{ coding: [{ code: umolPerL > 97 ? 'H' : 'N', system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation' }] }],
      referenceRange: [{ high: { unit: 'umol/L', value: 97 }, low: { unit: 'umol/L', value: 57 }, text: '57-97 umol/L' }],
      resourceType: 'Observation',
      specimen: { reference: `Specimen/${specimen.id}` },
      status: 'final',
      subject: { reference: `Patient/${patientId}` },
      valueQuantity: { code: 'umol/L', system: 'http://unitsofmeasure.org', unit: 'umol/L', value: umolPerL },
    })
    const report = current().fhir.create(scope, {
      basedOn: [{ reference: `ServiceRequest/${sr.id}` }],
      code: { text: '合成肾功能报告' },
      conclusion: '合成检验已完成。',
      encounter: { reference: `Encounter/${admissionId}` },
      id: uuidv7(),
      issued: now,
      resourceType: 'DiagnosticReport',
      result: [{ reference: `Observation/${obs.id}` }],
      specimen: [{ reference: `Specimen/${specimen.id}` }],
      status: 'final',
      subject: { reference: `Patient/${patientId}` },
    })
    const task = current().fhir.create(scope, {
      focus: { reference: `ServiceRequest/${sr.id}` },
      for: { reference: `Patient/${patientId}` },
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
      admissionId,
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

  function addAllergy(patientId: string, code: string, display: string) {
    current().fhir.create({ epoch: 'epoch-2', workspaceId: 'workspace-demo' }, {
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

  async function prepareSurgery(
    stay: Awaited<ReturnType<typeof createAdmission>>,
    options: {
      anesthesiaMethod: 'local-infiltration' | 'general'
      locationId: 'location-catheterization-lab' | 'location-operating-center'
      preopOrderPolicy: PreopOrderPolicy
      procedureCode: string
      reason: string
      standbyAdHocPci?: boolean
    },
  ) {
    const surgeryCatalog = inpatientSurgeryCatalogSchema.parse(
      await (await request(cookies.doctor, '/api/his/v1/inpatient/surgery-catalog')).json(),
    )
    const procedure = surgeryCatalog.procedures.find(item => item.coding.code === options.procedureCode)!
    const currentSurgery = inpatientSurgerySchema.parse(await (await request(cookies.doctor, `${stay.path}/surgeries`)).json())
    const clinical = inpatientFullClinicalSchema.parse(await (await request(cookies.doctor, `${stay.path}/clinical`)).json())
    const reqRes = await request(cookies.doctor, `${stay.path}/surgeries/request`, {
      anesthesiaMethod: options.anesthesiaMethod,
      catalogVersion: procedure.version,
      encounterVersion: currentSurgery.encounterVersion,
      locationId: options.locationId,
      plannedFor: '2026-08-25T10:00:00+08:00',
      preopOrderPolicy: options.preopOrderPolicy,
      procedureId: procedure.id,
      reason: options.reason,
      ...(options.standbyAdHocPci ? { standbyAdHocPci: true } : {}),
      surgeonPractitionerId: 'practitioner-inpatient-doctor',
      surgeryType: 'elective',
    })
    expect(reqRes.status, await reqRes.clone().text()).toBe(200)
    const created = inpatientSurgeryResponseSchema.parse(await reqRes.json()).data.requests.at(-1)!
    const preopRes = await request(cookies.nurse, `${stay.path}/surgeries/check-preop`, {
      expectedRequestVersion: created.version,
      note: '术前双准备核对完成',
      requestId: created.id,
    })
    expect(preopRes.status).toBe(200)
    const consentRes = await request(cookies.doctor, `${stay.path}/surgeries/confirm-consent`, {
      expectedDiagnosisRevision: clinical.diagnosis.revision,
      expectedRequestVersion: created.version + 1,
      note: '已核对知情同意书签署',
      patientChoice: 'agree',
      requestId: created.id,
      signerName: stay.patient.name,
      signerRole: 'patient',
    })
    expect(consentRes.status, await consentRes.clone().text()).toBe(200)
    const ready = inpatientSurgeryResponseSchema.parse(await consentRes.json()).data.requests.find(item => item.id === created.id)!
    return { procedure, ready }
  }

  it('0123 迁移回填已有手术申请默认策略为 continue-active 并建立术后医技关联表且外键完整', async () => {
    const migrationDir = await mkdtemp(join(tmpdir(), 'clinmesh-0123-migration-'))
    const migrationFile = '0123_surgery-preop-policy-and-postop-investigations.sql'
    const db = openClinMeshDatabase({ databasePath: join(migrationDir, 'hospital.sqlite'), busyTimeoutMs: 5000 })
    try {
      const preMigrations = join(migrationDir, 'pre-0123')
      await mkdir(preMigrations)
      await Promise.all(
        (await readdir('drizzle'))
          .filter(file => file.endsWith('.sql') && file < migrationFile)
          .map(file => copyFile(join('drizzle', file), join(preMigrations, file))),
      )
      applyMigrations(db, preMigrations)
      const scope = { workspaceId: 'synthetic-0123', epoch: 'epoch-1', scenarioRunId: 'run-1' }
      const now = '2026-11-25T09:00:00.000Z'
      new WorkspaceRepository(db).install({ ...scope, scenarioId: 'synthetic-0123', workspaceName: '合成0123迁移验证' })
      db.driver.prepare("INSERT INTO scenario_definition(scenario_id,version,kind,schema_version) VALUES('synthetic-0123','1','candidate','1')").run()
      db.driver.prepare(
        "INSERT INTO scenario_epoch_state(workspace_id,epoch,scenario_run_id,scenario_id,deterministic_seed,virtual_time,initial_state_hash) VALUES(?,?,'run-1','synthetic-0123',1,?,?)",
      ).run(scope.workspaceId, scope.epoch, now, '0'.repeat(64))
      db.driver.prepare("INSERT INTO inpatient_ward(workspace_id,epoch,ward_id,organization_id,name) VALUES(?,?,'ward-1','org-1','合成病区')").run(scope.workspaceId, scope.epoch)
      db.driver.prepare(
        `INSERT INTO inpatient_admission(workspace_id,epoch,admission_id,patient_id,inpatient_number,admission_route,ward_id,organization_id,status,financial_status,record_status,registered_at,admitted_at)
         VALUES(?,?,'adm-1','pat-1','ZY-0123','direct','ward-1','org-1','admitted','open','open',?,?)`,
      ).run(scope.workspaceId, scope.epoch, now, now)
      db.driver.prepare(
        `INSERT INTO inpatient_surgery_request(workspace_id,epoch,request_id,admission_id,version,status,planned_procedure_json,planned_for,reason,requested_at,requested_by,organization_id)
         VALUES(?,?,'req-pre0123','adm-1',1,'requested','{}',?,'升级前已有申请',?,'doctor','org-1')`,
      ).run(scope.workspaceId, scope.epoch, now, now)

      expect(applyMigrations(db).applied).toEqual([migrationFile, '0124_clinical-fact-verification.sql', '0125_local-source-ingestion.sql', '0126_disease-pack-runtime.sql', '0127_bedside-questionnaire-answers.sql', '0128_clinical-prompt-cards.sql'])
      expect(db.driver.pragma('foreign_key_check')).toEqual([])
      const row = z.object({ preop_order_policy: z.literal('continue-active') }).parse(
        db.driver.prepare("SELECT preop_order_policy FROM inpatient_surgery_request WHERE request_id = 'req-pre0123'").get(),
      )
      expect(row.preop_order_policy).toBe('continue-active')
      expect(db.driver.prepare('SELECT COUNT(*) AS c FROM inpatient_postoperative_investigation').get()).toEqual({ c: 0 })
    } finally {
      db.close()
      await rm(migrationDir, { recursive: true, force: true })
    }
  })

  it('PCI 手术采用 continue-active 策略时保留术前在执长嘱，零漂移耗材基准与病案哈希，术后组套精确区分 skipped 与 excluded 并绑定术后医技及病房护理', async () => {
    const stay = await createAdmission('bed-general-1')
    const otherStay = await createAdmission('bed-general-2')

    const templateList = orderSetTemplateListSchema.parse(
      await (await request(cookies.doctor, '/api/his/v1/catalogs/order-set-templates')).json(),
    )
    expect(templateList.items.map(item => item.id)).toEqual(
      expect.arrayContaining(['pci-postop-standard', 'general-surgery-postop-standard']),
    )

    const clinicalCatalog = inpatientFullCatalogSchema.parse(
      await (await request(cookies.doctor, '/api/his/v1/inpatient/clinical-catalog')).json(),
    )
    expect(clinicalCatalog.services.map(item => item.id)).toEqual(expect.arrayContaining([
      'hospital-service-postop-ecg-monitoring',
      'hospital-service-postop-puncture-immobilization',
      'hospital-service-postop-wound-vital-nursing',
    ]))

    const diagRes = await request(cookies.doctor, `${stay.path}/diagnoses/confirm`, {
      encounterVersion: stay.admission.versionId,
      entries: [{ admissionCondition: '1', catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I25.103', role: 'primary' }],
      expectedRevision: 0,
    })
    expect(diagRes.status, await diagRes.clone().text()).toBe(200)
    let encounterVersion = inpatientFullClinicalResponseSchema.parse(await diagRes.json()).data.encounterVersion

    expect((await request(cookies.nurse, `${stay.path}/vital-signs`, {
      bloodPressure: { diastolicMmHg: 78, systolicMmHg: 128 },
      encounterVersion,
      expectedRevision: 0,
      oxygenSaturationPct: 98,
      pulseBpm: 72,
      respirationBpm: 18,
      temperatureC: 36.6,
      weightKg: 70,
    })).status).toBe(200)
    insertSerumCreatinineReport(stay.admission.id, stay.patient.id, 155)

    // 术前开立并校对阿司匹林、替格瑞洛（与氯吡格雷同属 p2y12 互斥）与瑞舒伐他汀（与阿托伐他汀同属 statin 互斥）
    const medByName = (keyword: string) => {
      const found = clinicalCatalog.medications.find(item => item.display.includes(keyword))
      if (!found) throw new Error(`Missing medication containing ${keyword}`)
      return found
    }
    const issueAndVerifyMed = async (keyword: string, doseText: string, doseQuantity: number, frequencyCode: 'QD' | 'BID' | 'QN') => {
      const med = medByName(keyword)
      const issued = await request(cookies.doctor, `${stay.path}/orders/issue`, {
        duration: 'long',
        encounterVersion,
        selection: {
          catalogItemId: med.id,
          catalogVersion: med.version,
          doseQuantity,
          doseText,
          frequencyCode,
          kind: 'medication',
          routeCode: 'PO',
        },
      })
      expect(issued.status, await issued.clone().text()).toBe(200)
      const data = inpatientFullClinicalResponseSchema.parse(await issued.json()).data
      encounterVersion = data.encounterVersion
      const order = data.orders.at(-1)!
      expect((await request(cookies.nurse, `${stay.path}/orders/verify`, {
        expectedOrderVersion: order.version,
        orderId: order.id,
      })).status).toBe(200)
      return order.id
    }

    const aspirinOrderId = await issueAndVerifyMed('阿司匹林', '100 mg', 1, 'QD')
    const ticagrelorOrderId = await issueAndVerifyMed('替格瑞洛', '90 mg', 1, 'BID')
    const rosuvastatinOrderId = await issueAndVerifyMed('瑞舒伐他汀', '10 mg', 1, 'QN')

    // 开立一项在途 hs-cTnI（应导致术后模板跳过 hs-cTnI）
    const invCatalog = inpatientInvestigationCatalogSchema.parse(
      await (await request(cookies.doctor, '/api/his/v1/inpatient/investigation-catalog')).json(),
    )
    const hsCtni = invCatalog.items.find(item => item.kind === 'laboratory' && item.display.includes('肌钙蛋白'))!
    const inFlightHsCtni = await request(cookies.doctor, `${stay.path}/investigations/issue`, {
      catalogVersion: hsCtni.version,
      encounterVersion,
      selection: { catalogItemId: hsCtni.id, indicationCode: hsCtni.indicationCodes[0]!, kind: 'laboratory' },
    })
    expect(inFlightHsCtni.status, await inFlightHsCtni.clone().text()).toBe(200)

    // 申请 PCI 手术（36.0700）并显式设置 preopOrderPolicy = 'continue-active'
    const recordBefore = inpatientRecordSchema.parse(await (await request(cookies.doctor, `${stay.path}/record`)).json())
    const { procedure, ready } = await prepareSurgery(stay, {
      anesthesiaMethod: 'local-infiltration',
      locationId: 'location-catheterization-lab',
      preopOrderPolicy: 'continue-active',
      procedureCode: '36.0700',
      reason: '前降支重度狭窄拟行药物洗脱支架置入',
    })
    expect(ready.preopOrderPolicy).toBe('continue-active')
    expect(ready.consentConfirmation?.document?.templateVersion).toBe('2026-11-23.r1')

    // 校验 FHIR ServiceRequest.orderDetail 写入 preop-order-policy 参数
    const sr = z.object({
      orderDetail: z.array(z.object({
        parameter: z.array(z.object({
          code: z.object({ coding: z.array(z.object({ code: z.string() })) }),
          valueCodeableConcept: z.object({ coding: z.array(z.object({ code: z.string() })) }),
        })),
      })),
    }).loose().parse(await (await request(cookies.doctor, `/fhir/R5/ServiceRequest/${ready.id}`)).json())
    expect(sr.orderDetail[0]?.parameter).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: { coding: [expect.objectContaining({ code: 'preop-order-policy' })] },
        valueCodeableConcept: expect.objectContaining({ coding: [expect.objectContaining({ code: 'continue-active' })] }),
      }),
    ]))

    // 校验零漂移：material estimate basisFingerprint 与病案首页 sourcesHash 不受 preopOrderPolicy 影响
    const estimatesBefore = inpatientMaterialEstimatesSchema.parse(
      await (await request(cookies.doctor, `${stay.path}/material-estimates`)).json(),
    )
    const basisBefore = estimatesBefore.estimates.find(item => item.requestId === ready.id)?.basisFingerprint
      ?? estimatesBefore.unprepared.find(item => item.requestId === ready.id)?.basisFingerprint
    expect(basisBefore).toMatch(/^[a-f0-9]{64}$/)
    current().database.driver
      .prepare("UPDATE inpatient_surgery_request SET preop_order_policy = 'stop-on-completion' WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND request_id = ?")
      .run(ready.id)
    const estimatesFlipped = inpatientMaterialEstimatesSchema.parse(
      await (await request(cookies.doctor, `${stay.path}/material-estimates`)).json(),
    )
    const basisFlipped = estimatesFlipped.estimates.find(item => item.requestId === ready.id)?.basisFingerprint
      ?? estimatesFlipped.unprepared.find(item => item.requestId === ready.id)?.basisFingerprint
    expect(basisFlipped).toBe(basisBefore)
    const recordAfterFlip = inpatientRecordSchema.parse(await (await request(cookies.doctor, `${stay.path}/record`)).json())
    expect(recordAfterFlip.sourcesHash).toBe(recordBefore.sourcesHash)
    current().database.driver
      .prepare("UPDATE inpatient_surgery_request SET preop_order_policy = 'continue-active' WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND request_id = ?")
      .run(ready.id)

    // 分步实施 PCI：start -> preview-completion -> complete
    const startedRes = await request(cookies.doctor, `${stay.path}/surgeries/start`, {
      catalogVersion: procedure.version,
      expectedRequestVersion: ready.version,
      procedureId: procedure.id,
      requestId: ready.id,
    })
    expect(startedRes.status, await startedRes.clone().text()).toBe(200)
    const running = inpatientSurgeryResponseSchema.parse(await startedRes.json()).data.inProgress[0]!
    const startedReq = inpatientSurgerySchema.parse(await (await request(cookies.doctor, `${stay.path}/surgeries`)).json())
      .requests.find(item => item.id === ready.id)!

    // 进行中手术禁止作为术后模板或术后医技的 surgeryExecutionId
    const inProgressDraftDenied = await request(cookies.doctor, `${stay.path}/order-set-drafts?surgeryExecutionId=${running.id}`)
    expect(inProgressDraftDenied.status).toBe(409)
    expect(apiErrorSchema.parse(await inProgressDraftDenied.json()).error.code).toBe('INPATIENT_SURGERY_EXECUTION_REQUIRED')

    const previewRes = await request(cookies.doctor, `${stay.path}/surgeries/preview-completion`, {
      executionId: running.id,
      expectedRequestVersion: startedReq.version,
      finalMaterials: [],
      releaseReservations: [],
      requestId: ready.id,
    })
    expect(previewRes.status, await previewRes.clone().text()).toBe(200)
    const preview = inpatientSurgeryCompletionPreviewSchema.parse(await previewRes.json())
    expect(preview.preopOrderPolicy).toBe('continue-active')
    expect(preview.autoStopPreopOrders).toEqual([])

    const completeRes = await request(cookies.doctor, `${stay.path}/surgeries/complete`, {
      executionId: running.id,
      expectedRequestVersion: startedReq.version,
      reconciliation: {
        expectedFingerprint: preview.fingerprint,
        finalMaterials: [],
        releaseReservations: [],
      },
      requestId: ready.id,
    })
    expect(completeRes.status, await completeRes.clone().text()).toBe(200)
    const execution = inpatientSurgeryResponseSchema.parse(await completeRes.json()).data.executions[0]!

    // continue-active：术前三条在执长嘱均维持 verified 未停用
    const clinicalAfterPci = inpatientFullClinicalSchema.parse(await (await request(cookies.doctor, `${stay.path}/clinical`)).json())
    for (const orderId of [aspirinOrderId, ticagrelorOrderId, rosuvastatinOrderId]) {
      expect(clinicalAfterPci.orders.find(item => item.id === orderId)?.state).toBe('verified')
    }

    // 读取术后成套医嘱草稿（不传 templateId，按已完成 PCI 编码自动匹配 pci-postop-standard），验证零正式副作用
    const countBefore = {
      charges: (current().database.driver.prepare('SELECT COUNT(*) AS c FROM inpatient_charge WHERE admission_id = ?').get(stay.admission.id) as { c: number }).c,
      investigations: (current().database.driver.prepare('SELECT COUNT(*) AS c FROM inpatient_investigation WHERE admission_id = ?').get(stay.admission.id) as { c: number }).c,
      orders: (current().database.driver.prepare('SELECT COUNT(*) AS c FROM inpatient_order WHERE admission_id = ?').get(stay.admission.id) as { c: number }).c,
    }
    const postopBundleRes = await request(cookies.doctor, `${stay.path}/order-set-drafts?surgeryExecutionId=${execution.id}`)
    expect(postopBundleRes.status, await postopBundleRes.clone().text()).toBe(200)
    const postopBundle = orderSetDraftBundleSchema.parse(await postopBundleRes.json())
    expect(postopBundle.target).toMatchObject({
      admissionId: stay.admission.id,
      preopOrderPolicy: 'continue-active',
      scope: 'inpatient',
      surgeryExecutionId: execution.id,
      surgeryProcedureCode: '36.0700',
    })
    expect(postopBundle.drafts).toHaveLength(1)
    const pciDraft = postopBundle.drafts[0]!
    expect(pciDraft.template.id).toBe('pci-postop-standard')
    expect(pciDraft.items.find(item => item.key === 'aspirin')).toMatchObject({
      candidate: null,
      disposition: 'skipped',
      reasons: [expect.objectContaining({ code: 'already-active-order', severity: 'skip', sourceReference: `MedicationRequest/${aspirinOrderId}` })],
    })
    expect(pciDraft.items.find(item => item.key === 'p2y12-inhibitor')).toMatchObject({
      candidate: null,
      disposition: 'skipped',
      reasons: [expect.objectContaining({ code: 'mutually-exclusive-active-order', severity: 'skip', sourceReference: `MedicationRequest/${ticagrelorOrderId}` })],
    })
    expect(pciDraft.items.find(item => item.key === 'statin')).toMatchObject({
      candidate: null,
      disposition: 'skipped',
      reasons: [expect.objectContaining({ code: 'mutually-exclusive-active-order', severity: 'skip', sourceReference: `MedicationRequest/${rosuvastatinOrderId}` })],
    })
    expect(pciDraft.items.find(item => item.key === 'postop-hs-ctni')).toMatchObject({
      candidate: null,
      disposition: 'skipped',
      reasons: [expect.objectContaining({ code: 'in-flight-investigation', severity: 'skip' })],
    })
    expect(pciDraft.items.find(item => item.key === 'postop-cbc')?.disposition).toBe('ready')
    expect(pciDraft.items.find(item => item.key === 'postop-ecg-monitoring')).toMatchObject({
      candidate: {
        duration: 'temporary',
        kind: 'service',
        serviceId: 'hospital-service-postop-ecg-monitoring',
      },
      disposition: 'ready',
    })
    expect('routeCode' in pciDraft.items.find(item => item.key === 'postop-ecg-monitoring')!.candidate!).toBe(false)
    expect(pciDraft.counts.skipped).toBe(4)

    // 零副作用校验
    expect({
      charges: (current().database.driver.prepare('SELECT COUNT(*) AS c FROM inpatient_charge WHERE admission_id = ?').get(stay.admission.id) as { c: number }).c,
      investigations: (current().database.driver.prepare('SELECT COUNT(*) AS c FROM inpatient_investigation WHERE admission_id = ?').get(stay.admission.id) as { c: number }).c,
      orders: (current().database.driver.prepare('SELECT COUNT(*) AS c FROM inpatient_order WHERE admission_id = ?').get(stay.admission.id) as { c: number }).c,
    }).toEqual(countBefore)

    // 硬禁忌优先级高于 skipped：添加阿司匹林确认过敏后，即使术前在用也必须转为 excluded
    addAllergy(stay.patient.id, 'ASPIRIN', '阿司匹林')
    const allergyBundle = orderSetDraftBundleSchema.parse(
      await (await request(cookies.doctor, `${stay.path}/order-set-drafts?surgeryExecutionId=${execution.id}`)).json(),
    )
    expect(allergyBundle.drafts[0]!.items.find(item => item.key === 'aspirin')).toMatchObject({
      disposition: 'excluded',
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'allergy-contraindication', severity: 'exclude' }),
        expect.objectContaining({ code: 'already-active-order', severity: 'skip' }),
      ]),
    })

    // 普通住院组套请求（未传 surgeryExecutionId）不得返回绑定术式的术后模板，显式请求术后模板但未绑手术或术式不匹配均应 409 拒绝
    const ordinaryDrafts = orderSetDraftBundleSchema.parse(
      await (await request(cookies.doctor, `${stay.path}/order-set-drafts`)).json(),
    )
    expect(ordinaryDrafts.drafts.map(draft => draft.template.id)).not.toContain('pci-postop-standard')
    expect(ordinaryDrafts.drafts.map(draft => draft.template.id)).not.toContain('general-surgery-postop-standard')

    const postopWithoutSurgery = await request(cookies.doctor, `${stay.path}/order-set-drafts?templateId=pci-postop-standard`)
    expect(postopWithoutSurgery.status).toBe(409)
    expect(apiErrorSchema.parse(await postopWithoutSurgery.json()).error.code).toBe('ORDER_SET_SCOPE_NOT_APPLICABLE')

    const postopMismatchedProcedure = await request(
      cookies.doctor,
      `${stay.path}/order-set-drafts?surgeryExecutionId=${execution.id}&templateId=general-surgery-postop-standard`,
    )
    expect(postopMismatchedProcedure.status).toBe(409)
    expect(apiErrorSchema.parse(await postopMismatchedProcedure.json()).error.code).toBe('ORDER_SET_SCOPE_NOT_APPLICABLE')

    const postopMatchedExplicitRes = await request(
      cookies.doctor,
      `${stay.path}/order-set-drafts?surgeryExecutionId=${execution.id}&templateId=pci-postop-standard`,
    )
    expect(postopMatchedExplicitRes.status, await postopMatchedExplicitRes.clone().text()).toBe(200)
    expect(orderSetDraftBundleSchema.parse(await postopMatchedExplicitRes.json()).drafts.map(draft => draft.template.id)).toEqual([
      'pci-postop-standard',
    ])

    // 跨住院 surgeryExecutionId 校验拒绝
    const crossAdmissionDraft = await request(cookies.doctor, `${otherStay.path}/order-set-drafts?surgeryExecutionId=${execution.id}`)
    expect(crossAdmissionDraft.status).toBe(409)
    expect(apiErrorSchema.parse(await crossAdmissionDraft.json()).error.code).toBe('INPATIENT_SURGERY_EXECUTION_REQUIRED')

    // 术后医技开立（检验 + 心电图）附带 surgeryExecutionId -> 落库关联表并写入 FHIR ServiceRequest.supportingInfo
    const ecgCandidate = pciDraft.items.find(item => item.key === 'postop-ecg-12-lead')!.candidate!
    const cbcCandidate = pciDraft.items.find(item => item.key === 'postop-cbc')!.candidate!
    expect(ecgCandidate.kind).toBe('examination')
    expect(cbcCandidate.kind).toBe('laboratory')
    if (ecgCandidate.kind === 'examination' && cbcCandidate.kind === 'laboratory') {
      const issuedEcgRes = await request(cookies.doctor, `${stay.path}/investigations/issue`, {
        catalogVersion: ecgCandidate.catalogVersion,
        encounterVersion: clinicalAfterPci.encounterVersion,
        selection: { indication: ecgCandidate.indication, kind: 'examination', serviceId: ecgCandidate.serviceId },
        surgeryExecutionId: execution.id,
      })
      expect(issuedEcgRes.status, await issuedEcgRes.clone().text()).toBe(200)
      const ecgInv = inpatientInvestigationResponseSchema.parse(await issuedEcgRes.json()).data.examinationRequests[0]!
      expect(ecgInv.surgeryExecutionId).toBe(execution.id)
      const ecgSr = z.object({
        supportingInfo: z.array(z.object({ reference: z.object({ reference: z.string() }) })),
      }).loose().parse(await (await request(cookies.doctor, `/fhir/R5/ServiceRequest/${ecgInv.serviceRequestId}`)).json())
      expect(ecgSr.supportingInfo).toEqual([{ reference: { reference: `Procedure/${execution.id}` } }])

      const issuedCbcRes = await request(cookies.doctor, `${stay.path}/investigations/issue`, {
        catalogVersion: cbcCandidate.catalogVersion,
        encounterVersion: clinicalAfterPci.encounterVersion,
        selection: { catalogItemId: cbcCandidate.catalogItemId, indicationCode: cbcCandidate.indicationCode, kind: 'laboratory' },
        surgeryExecutionId: execution.id,
      })
      expect(issuedCbcRes.status, await issuedCbcRes.clone().text()).toBe(200)
      const invSnapshot = inpatientInvestigationsSchema.parse(await (await request(cookies.doctor, `${stay.path}/investigations`)).json())
      expect(invSnapshot.laboratoryRequests.find(item => item.catalogItemId === cbcCandidate.catalogItemId)?.surgeryExecutionId).toBe(execution.id)
      expect(invSnapshot.examinationRequests.find(item => item.id === ecgInv.id)?.surgeryExecutionId).toBe(execution.id)

      const badInv = await request(cookies.doctor, `${otherStay.path}/investigations/issue`, {
        catalogVersion: ecgCandidate.catalogVersion,
        encounterVersion: otherStay.admission.versionId,
        selection: { indication: ecgCandidate.indication, kind: 'examination', serviceId: ecgCandidate.serviceId },
        surgeryExecutionId: execution.id,
      })
      expect(badInv.status).toBe(409)
      expect(apiErrorSchema.parse(await badInv.json()).error.code).toBe('INPATIENT_SURGERY_EXECUTION_REQUIRED')
    }

    // 病房术后护理服务（kind=service，执行触发计费）：开立 -> 护士校对 -> 护士完成 -> 正式入账 6000 分
    const nursingCandidate = pciDraft.items.find(item => item.key === 'postop-ecg-monitoring')!.candidate!
    expect(nursingCandidate.kind).toBe('service')
    if (nursingCandidate.kind === 'service') {
      const issuedNursing = await request(cookies.doctor, `${stay.path}/orders/issue`, {
        duration: nursingCandidate.duration,
        encounterVersion: clinicalAfterPci.encounterVersion,
        selection: {
          kind: 'service',
          quantity: nursingCandidate.quantity,
          serviceId: nursingCandidate.serviceId,
          serviceVersion: nursingCandidate.serviceVersion,
        },
        surgeryExecutionId: execution.id,
      })
      expect(issuedNursing.status, await issuedNursing.clone().text()).toBe(200)
      const nursingOrder = inpatientFullClinicalResponseSchema.parse(await issuedNursing.json()).data.orders.at(-1)!
      expect(nursingOrder.surgeryExecutionId).toBe(execution.id)
      const verifiedNursing = await request(cookies.nurse, `${stay.path}/orders/verify`, {
        expectedOrderVersion: nursingOrder.version,
        orderId: nursingOrder.id,
      })
      expect(verifiedNursing.status).toBe(200)
      const nursingExec = inpatientFullClinicalResponseSchema.parse(await verifiedNursing.json()).data.executions
        .find(item => item.orderId === nursingOrder.id)!
      const completedNursing = await request(cookies.nurse, `${stay.path}/executions/complete`, {
        executionId: nursingExec.id,
        expectedExecutionVersion: nursingExec.version,
      })
      expect(completedNursing.status, await completedNursing.clone().text()).toBe(200)
      const charges = inpatientChargesSchema.parse(await (await request(cookies.cashier, `${stay.path}/charges`)).json())
      expect(charges.charges).toEqual(expect.arrayContaining([
        expect.objectContaining({ amountFen: 6000, kind: 'service', label: '术后持续心电监护' }),
      ]))
    }
  })

  it('普外全麻手术采用 stop-on-completion 在分步 complete 与整台 execute 均原子停用术前长期医嘱并保留临时医嘱，支持停嘱待核停期间即时重开术后医嘱及出院质控停嘱溯源', async () => {
    const stay = await createAdmission('bed-general-3')
    const catalog = inpatientFullCatalogSchema.parse(
      await (await request(cookies.doctor, '/api/his/v1/inpatient/clinical-catalog')).json(),
    )

    // 确认胆囊结石（K80.200）、高血压（I10.x09）与冠心病（I25.103），确保 0.9% 氯化钠 K 前缀适应证、氨氯地平与阿司匹林均合法
    const diagRes = await request(cookies.doctor, `${stay.path}/diagnoses/confirm`, {
      encounterVersion: stay.admission.versionId,
      entries: [
        { admissionCondition: '1', catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:K80.200', role: 'primary' },
        { admissionCondition: '1', catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', role: 'secondary' },
        { admissionCondition: '1', catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I25.103', role: 'secondary' },
      ],
      expectedRevision: 0,
    })
    expect(diagRes.status, await diagRes.clone().text()).toBe(200)
    let encounterVersion = inpatientFullClinicalResponseSchema.parse(await diagRes.json()).data.encounterVersion

    expect((await request(cookies.nurse, `${stay.path}/vital-signs`, {
      bloodPressure: { diastolicMmHg: 80, systolicMmHg: 132 },
      encounterVersion,
      expectedRevision: 0,
      oxygenSaturationPct: 99,
      pulseBpm: 76,
      respirationBpm: 18,
      temperatureC: 36.7,
      weightKg: 66,
    })).status).toBe(200)

    const amlodipine = catalog.medications.find(item => item.id === 'medication-amlodipine')!
    const saline = catalog.medications.find(item => item.id === 'medication-sodium-chloride')!
    const education = catalog.services.find(item => item.id === 'hospital-service-diabetes-education')!

    // 1. 术前长期药嘱（氨氯地平）+ 术前长期服务医嘱（健康教育）+ 术前临时药嘱（ONCE 盐水）
    const longMedRes = await request(cookies.doctor, `${stay.path}/orders/issue`, {
      duration: 'long',
      encounterVersion,
      selection: {
        catalogItemId: amlodipine.id,
        catalogVersion: amlodipine.version,
        doseQuantity: 1,
        doseText: '5 mg',
        frequencyCode: 'QD',
        kind: 'medication',
        routeCode: 'PO',
      },
    })
    expect(longMedRes.status, await longMedRes.clone().text()).toBe(200)
    let clinical = inpatientFullClinicalResponseSchema.parse(await longMedRes.json()).data
    encounterVersion = clinical.encounterVersion
    const longMedOrder = clinical.orders.at(-1)!
    expect((await request(cookies.nurse, `${stay.path}/orders/verify`, { expectedOrderVersion: longMedOrder.version, orderId: longMedOrder.id })).status).toBe(200)

    const longServiceRes = await request(cookies.doctor, `${stay.path}/orders/issue`, {
      duration: 'long',
      encounterVersion,
      selection: { kind: 'service', quantity: 1, serviceId: education.id, serviceVersion: education.version },
    })
    expect(longServiceRes.status, await longServiceRes.clone().text()).toBe(200)
    clinical = inpatientFullClinicalResponseSchema.parse(await longServiceRes.json()).data
    encounterVersion = clinical.encounterVersion
    const longServiceOrder = clinical.orders.at(-1)!

    const metoprolol = catalog.medications.find(item => item.display.includes('美托洛尔'))!
    const tempMedRes = await request(cookies.doctor, `${stay.path}/orders/issue`, {
      duration: 'temporary',
      encounterVersion,
      selection: {
        catalogItemId: metoprolol.id,
        catalogVersion: metoprolol.version,
        doseQuantity: 1,
        doseText: '47.5 mg',
        frequencyCode: 'ONCE',
        kind: 'medication',
        routeCode: 'PO',
      },
    })
    expect(tempMedRes.status, await tempMedRes.clone().text()).toBe(200)
    clinical = inpatientFullClinicalResponseSchema.parse(await tempMedRes.json()).data
    encounterVersion = clinical.encounterVersion
    const tempMedOrder = clinical.orders.at(-1)!
    expect((await request(cookies.nurse, `${stay.path}/orders/verify`, { expectedOrderVersion: tempMedOrder.version, orderId: tempMedOrder.id })).status).toBe(200)

    // 2. 分步路径（腹腔镜胆囊切除 51.2300，stop-on-completion）
    const { procedure, ready } = await prepareSurgery(stay, {
      anesthesiaMethod: 'general',
      locationId: 'location-operating-center',
      preopOrderPolicy: 'stop-on-completion',
      procedureCode: '51.2300',
      reason: '胆囊结石伴慢性胆囊炎拟行全麻腹腔镜胆囊切除术',
    })
    expect(ready.preopOrderPolicy).toBe('stop-on-completion')

    const startRes = await request(cookies.doctor, `${stay.path}/surgeries/start`, {
      catalogVersion: procedure.version,
      expectedRequestVersion: ready.version,
      procedureId: procedure.id,
      requestId: ready.id,
    })
    expect(startRes.status).toBe(200)
    const running = inpatientSurgeryResponseSchema.parse(await startRes.json()).data.inProgress[0]!
    const startedReq = inpatientSurgerySchema.parse(await (await request(cookies.doctor, `${stay.path}/surgeries`)).json())
      .requests.find(item => item.id === ready.id)!

    const previewRes = await request(cookies.doctor, `${stay.path}/surgeries/preview-completion`, {
      executionId: running.id,
      expectedRequestVersion: startedReq.version,
      finalMaterials: [],
      releaseReservations: [],
      requestId: ready.id,
    })
    expect(previewRes.status, await previewRes.clone().text()).toBe(200)
    const preview = inpatientSurgeryCompletionPreviewSchema.parse(await previewRes.json())
    expect(preview.preopOrderPolicy).toBe('stop-on-completion')
    expect(preview.autoStopPreopOrders.map(item => item.orderId).toSorted()).toEqual([longMedOrder.id, longServiceOrder.id].toSorted())
    expect(preview.autoStopPreopOrders.some(item => item.orderId === tempMedOrder.id)).toBe(false)

    // 预览后若术前在执长嘱集合变化（例如新开阿司匹林长嘱），旧指纹必须 409 失效
    const aspirin = catalog.medications.find(item => item.display.includes('阿司匹林'))!
    const extraLongRes = await request(cookies.doctor, `${stay.path}/orders/issue`, {
      duration: 'long',
      encounterVersion: (await (await request(cookies.doctor, `${stay.path}/clinical`)).json()).encounterVersion,
      selection: {
        catalogItemId: aspirin.id,
        catalogVersion: aspirin.version,
        doseQuantity: 1,
        doseText: '100 mg',
        frequencyCode: 'QD',
        kind: 'medication',
        routeCode: 'PO',
      },
    })
    expect(extraLongRes.status, await extraLongRes.clone().text()).toBe(200)
    const aspirinLongOrder = inpatientFullClinicalResponseSchema.parse(await extraLongRes.json()).data.orders.at(-1)!
    const staleComplete = await request(cookies.doctor, `${stay.path}/surgeries/complete`, {
      executionId: running.id,
      expectedRequestVersion: startedReq.version,
      reconciliation: { expectedFingerprint: preview.fingerprint, finalMaterials: [], releaseReservations: [] },
      requestId: ready.id,
    })
    expect(staleComplete.status).toBe(409)
    expect(apiErrorSchema.parse(await staleComplete.json()).error.code).toBe('INPATIENT_SURGERY_REVIEW_CONFLICT')

    // 重新预览并完成手术 -> 三条长嘱全部原子转为 stop-requested，临时医嘱仍为 verified
    const freshPreview = inpatientSurgeryCompletionPreviewSchema.parse(await (await request(cookies.doctor, `${stay.path}/surgeries/preview-completion`, {
      executionId: running.id,
      expectedRequestVersion: startedReq.version,
      finalMaterials: [],
      releaseReservations: [],
      requestId: ready.id,
    })).json())
    expect(freshPreview.autoStopPreopOrders).toHaveLength(3)

    const completeRes = await request(cookies.doctor, `${stay.path}/surgeries/complete`, {
      executionId: running.id,
      expectedRequestVersion: startedReq.version,
      reconciliation: { expectedFingerprint: freshPreview.fingerprint, finalMaterials: [], releaseReservations: [] },
      requestId: ready.id,
    })
    expect(completeRes.status, await completeRes.clone().text()).toBe(200)
    const choleExec = inpatientSurgeryResponseSchema.parse(await completeRes.json()).data.executions[0]!

    const clinicalAfter = inpatientFullClinicalSchema.parse(await (await request(cookies.doctor, `${stay.path}/clinical`)).json())
    for (const stoppedId of [longMedOrder.id, longServiceOrder.id, aspirinLongOrder.id]) {
      const order = clinicalAfter.orders.find(item => item.id === stoppedId)!
      expect(order.state).toBe('stop-requested')
      expect(order.stopReason).toContain('腹腔镜下胆囊切除术')
    }
    expect(clinicalAfter.orders.find(item => item.id === tempMedOrder.id)?.state).toBe('verified')

    // 校验 FHIR MedicationRequest 同步更新扩展与 clinmesh-stop-reason 备注
    const stoppedMedFhir = z.object({
      extension: z.array(z.object({ url: z.string(), valueCode: z.string().optional() })).optional(),
      note: z.array(z.object({ id: z.string().optional(), text: z.string() })).optional(),
    }).loose().parse(fhirResourceSchema.parse(await (await request(cookies.doctor, `/fhir/R5/MedicationRequest/${longMedOrder.id}`)).json()))
    expect(stoppedMedFhir.extension).toEqual(expect.arrayContaining([
      expect.objectContaining({ valueCode: 'stop-requested' }),
    ]))
    expect(stoppedMedFhir.note).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'clinmesh-stop-reason' }),
    ]))

    // 3. 护士尚未 verify-stop 时，医生立即读取普外术后成套模板（general-surgery-postop-standard）并立即重开氨氯地平与术后盐水补液，不被 stop-requested 阻断
    const postopBundle = orderSetDraftBundleSchema.parse(
      await (await request(cookies.doctor, `${stay.path}/order-set-drafts?surgeryExecutionId=${choleExec.id}`)).json(),
    )
    expect(postopBundle.drafts).toHaveLength(1)
    expect(postopBundle.drafts[0]!.template.id).toBe('general-surgery-postop-standard')
    expect(postopBundle.drafts[0]!.items.find(item => item.key === 'postop-wound-vital-nursing')).toMatchObject({
      candidate: { kind: 'service', serviceId: 'hospital-service-postop-wound-vital-nursing' },
      disposition: 'ready',
    })

    const reorderAmlodipine = await request(cookies.doctor, `${stay.path}/orders/issue`, {
      duration: 'long',
      encounterVersion: clinicalAfter.encounterVersion,
      selection: {
        catalogItemId: amlodipine.id,
        catalogVersion: amlodipine.version,
        doseQuantity: 1,
        doseText: '5 mg',
        frequencyCode: 'QD',
        kind: 'medication',
        routeCode: 'PO',
      },
      surgeryExecutionId: choleExec.id,
    })
    expect(reorderAmlodipine.status, await reorderAmlodipine.clone().text()).toBe(200)
    const reorderedAmlodipine = inpatientFullClinicalResponseSchema.parse(await reorderAmlodipine.json()).data.orders.at(-1)!

    const postopSaline = await request(cookies.doctor, `${stay.path}/orders/issue`, {
      duration: 'temporary',
      encounterVersion: (await (await request(cookies.doctor, `${stay.path}/clinical`)).json()).encounterVersion,
      selection: {
        catalogItemId: saline.id,
        catalogVersion: saline.version,
        doseQuantity: 2,
        doseText: '1000 mL',
        frequencyCode: 'ONCE',
        instructions: '术后禁食期间等渗静脉补液',
        kind: 'medication',
        routeCode: 'IVGTT',
      },
      surgeryExecutionId: choleExec.id,
    })
    expect(postopSaline.status, await postopSaline.clone().text()).toBe(200)

    // 4. 护士核停自动停嘱的术前长期药嘱 -> 状态转为 stopped 且未执行任务取消
    const currentStoppedMed = inpatientFullClinicalSchema.parse(await (await request(cookies.doctor, `${stay.path}/clinical`)).json())
      .orders.find(item => item.id === longMedOrder.id)!
    const verifyStopRes = await request(cookies.nurse, `${stay.path}/orders/verify-stop`, {
      expectedOrderVersion: currentStoppedMed.version,
      orderId: currentStoppedMed.id,
    })
    expect(verifyStopRes.status, await verifyStopRes.clone().text()).toBe(200)
    const afterVerifyStop = inpatientFullClinicalResponseSchema.parse(await verifyStopRes.json()).data
    expect(afterVerifyStop.orders.find(item => item.id === longMedOrder.id)?.state).toBe('stopped')
    expect(afterVerifyStop.executions.filter(item => item.orderId === longMedOrder.id).every(item => item.status === 'cancelled')).toBe(true)

    // 5. 整台一次性 execute 路径同样支持 stop-on-completion 原子停嘱（停用刚才重开的氨氯地平长嘱）
    const { procedure: herniaProc, ready: herniaReady } = await prepareSurgery(stay, {
      anesthesiaMethod: 'general',
      locationId: 'location-operating-center',
      preopOrderPolicy: 'stop-on-completion',
      procedureCode: '53.0001',
      reason: '右侧腹股沟疝同期修补演示一次性实施停嘱',
    })
    const executeRes = await request(cookies.doctor, `${stay.path}/surgeries/execute`, {
      catalogVersion: herniaProc.version,
      expectedRequestVersion: herniaReady.version,
      materials: [],
      procedureId: herniaProc.id,
      requestId: herniaReady.id,
    })
    expect(executeRes.status, await executeRes.clone().text()).toBe(200)
    const clinicalAfterExecute = inpatientFullClinicalSchema.parse(await (await request(cookies.doctor, `${stay.path}/clinical`)).json())
    expect(clinicalAfterExecute.orders.find(item => item.id === reorderedAmlodipine.id)?.state).toBe('stop-requested')

    // 6. 出院质控识别经手术完成自动停嘱的冠心病二级预防阿司匹林停嘱记录（action_trace 含 inpatient.surgery.complete / execute）
    const stopTraces = current().database.driver.prepare(
      "SELECT operation FROM action_trace WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND operation IN ('inpatient.surgery.complete', 'inpatient.surgery.execute')",
    ).all()
    expect(stopTraces.length).toBeGreaterThanOrEqual(2)
    const quality = clinicalQualityCheckSchema.parse(
      await (await request(cookies.doctor, `${stay.path}/clinical-quality?gate=inpatient-discharge`)).json(),
    )
    expect(quality.alerts.map(alert => alert.code)).toContain('DISCHARGE_ANTIPLATELET_MISSING')

    // 7. 备选同台 PCI（standbyAdHocPci=true）+ stop-on-completion：第一阶段造影进入 standby-pci 不提前停嘱，待 finalize-standby 收口为 completed 时原子停用术前长期医嘱
    const clinicalBeforeStandby = inpatientFullClinicalSchema.parse(await (await request(cookies.doctor, `${stay.path}/clinical`)).json())
    const issuedForStandby = await request(cookies.doctor, `${stay.path}/orders/issue`, {
      duration: 'long',
      encounterVersion: clinicalBeforeStandby.encounterVersion,
      selection: {
        catalogItemId: amlodipine.id,
        catalogVersion: amlodipine.version,
        doseQuantity: 1,
        doseText: '5 mg',
        frequencyCode: 'QD',
        kind: 'medication',
        routeCode: 'PO',
      },
    })
    expect(issuedForStandby.status, await issuedForStandby.clone().text()).toBe(200)
    const standbyLongOrder = inpatientFullClinicalResponseSchema.parse(await issuedForStandby.json()).data.orders.at(-1)!
    expect((await request(cookies.nurse, `${stay.path}/orders/verify`, { expectedOrderVersion: standbyLongOrder.version, orderId: standbyLongOrder.id })).status).toBe(200)

    const { procedure: angioProc, ready: angioReady } = await prepareSurgery(stay, {
      anesthesiaMethod: 'general',
      locationId: 'location-catheterization-lab',
      preopOrderPolicy: 'stop-on-completion',
      procedureCode: '88.5500',
      reason: '冠脉造影备选同台 PCI 且采用全麻停嘱策略',
      standbyAdHocPci: true,
    })
    const startedStandby = inpatientSurgeryResponseSchema.parse(await (await request(cookies.doctor, `${stay.path}/surgeries/start`, {
      catalogVersion: angioProc.version,
      expectedRequestVersion: angioReady.version,
      procedureId: angioProc.id,
      requestId: angioReady.id,
    })).json()).data
    const startedStandbyReq = startedStandby.requests.find(item => item.id === angioReady.id)!
    const runningStandbyExec = startedStandby.inProgress.find(item => item.requestId === angioReady.id)!

    const standbyPreviewRes = await request(cookies.doctor, `${stay.path}/surgeries/preview-completion`, {
      executionId: runningStandbyExec.id,
      expectedRequestVersion: startedStandbyReq.version,
      finalMaterials: [],
      releaseReservations: [],
      requestId: angioReady.id,
    })
    expect(standbyPreviewRes.status, await standbyPreviewRes.clone().text()).toBe(200)
    const standbyPreview = inpatientSurgeryCompletionPreviewSchema.parse(await standbyPreviewRes.json())
    expect(standbyPreview.preopOrderPolicy).toBe('stop-on-completion')
    expect(standbyPreview.autoStopPreopOrders).toEqual([])

    const standbyCompleteRes = await request(cookies.doctor, `${stay.path}/surgeries/complete`, {
      executionId: runningStandbyExec.id,
      expectedRequestVersion: startedStandbyReq.version,
      reconciliation: {
        expectedFingerprint: standbyPreview.fingerprint,
        finalMaterials: [],
        releaseReservations: [],
      },
      requestId: angioReady.id,
    })
    expect(standbyCompleteRes.status, await standbyCompleteRes.clone().text()).toBe(200)
    const standbyReq = inpatientSurgeryResponseSchema.parse(await standbyCompleteRes.json()).data.requests.find(item => item.id === angioReady.id)!
    expect(standbyReq.status).toBe('standby-pci')
    const clinicalMidStandby = inpatientFullClinicalSchema.parse(await (await request(cookies.doctor, `${stay.path}/clinical`)).json())
    expect(clinicalMidStandby.orders.find(item => item.id === standbyLongOrder.id)?.state).toBe('verified')

    // 若在 standby-pci 期间已提前开立关联本台手术（同一 requestId）的术后长期护理医嘱，finalize-standby 收口时只停术前长嘱、不误停本台术后医嘱
    const ecgMonitor = catalog.services.find(item => item.id === 'hospital-service-postop-ecg-monitoring')!
    const sameSurgeryPostopRes = await request(cookies.doctor, `${stay.path}/orders/issue`, {
      duration: 'long',
      encounterVersion: clinicalMidStandby.encounterVersion,
      selection: { kind: 'service', quantity: 1, serviceId: ecgMonitor.id, serviceVersion: ecgMonitor.version },
      surgeryExecutionId: runningStandbyExec.id,
    })
    expect(sameSurgeryPostopRes.status, await sameSurgeryPostopRes.clone().text()).toBe(200)
    const sameSurgeryPostopOrder = inpatientFullClinicalResponseSchema.parse(await sameSurgeryPostopRes.json()).data.orders.at(-1)!

    const finalizeRes = await request(cookies.doctor, `${stay.path}/surgeries/finalize-standby`, {
      expectedRequestVersion: standbyReq.version,
      note: '造影评估仅需药物保守，结束本台手术',
      requestId: angioReady.id,
    })
    expect(finalizeRes.status, await finalizeRes.clone().text()).toBe(200)
    expect(inpatientSurgeryResponseSchema.parse(await finalizeRes.json()).data.requests.find(item => item.id === angioReady.id)?.status).toBe('completed')
    const clinicalFinalStandby = inpatientFullClinicalSchema.parse(await (await request(cookies.doctor, `${stay.path}/clinical`)).json())
    expect(clinicalFinalStandby.orders.find(item => item.id === standbyLongOrder.id)?.state).toBe('stop-requested')
    expect(clinicalFinalStandby.orders.find(item => item.id === sameSurgeryPostopOrder.id)?.state).toBe('signed')
  })
})
