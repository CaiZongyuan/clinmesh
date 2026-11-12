import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import {
  caseLaboratoryCatalogSearchSchema,
  commandResponseSchema,
  correctLaboratoryReportResponseSchema,
  registrationCatalogSchema,
  triageResponseSchema,
  doctorCaseDetailSchema,
  issueLaboratoryRequestResponseSchema,
  laboratoryServiceCandidateSearchSchema,
  laboratoryServicePublicationJobSchema,
  laboratoryServiceSnapshotSchema,
  laboratoryRequestDraftResponseSchema,
  paymentPreviewResponseSchema,
  paymentResponseSchema,
  publishLaboratoryServicesResponseSchema,
  scenarioCommandResponseSchema,
  scenarioStateSchema,
} from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import {
  inpatientInvestigationCatalogSchema,
  inpatientInvestigationResponseSchema,
  inpatientInvestigationsSchema,
} from '@clinmesh/contracts/inpatient-investigations'
import { startSyntheticCaseResultSchema, syntheticCaseInstanceSchema } from '@clinmesh/contracts/scenario'
import { sourceArtifactHash } from '../src/application/scenario-data/provider.ts'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { encodeModelRoute } from '@clinmesh/contracts/model-bridge'
import type {
  JsonChatCompletionInput,
  JsonChatCompletionsProvider,
} from '../src/infrastructure/ai/openai-chat-completions.ts'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { setModelControl } from './fixtures/model-control.ts'
import { openReferenceDatabase } from '../src/infrastructure/sqlite/reference-database.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { referenceDatabaseIsReady } from '../src/reference-readiness.ts'

class LaboratoryEnrichmentProvider implements JsonChatCompletionsProvider {
  calls: JsonChatCompletionInput[] = []
  resolveModel?: (model: string) => Promise<string>
  codeable = false
  misclassifyQuantity = false

  async completeJson(input: JsonChatCompletionInput) {
    this.calls.push(input)
    if (this.misclassifyQuantity) {
      return {
        content: JSON.stringify({
          services: [{
            conclusionTemplate: '血常规结果已完成。',
            nameEn: 'Complete blood count',
            nameZh: '血常规',
            priceFen: 2_500,
            results: [{
              allowedValues: ['normal'],
              conceptId: 'loinc:synthetic:6690-2',
              referenceRange: { text: 'normal' },
              valueType: 'string',
            }],
            rootConceptId: 'loinc:synthetic:58410-2',
            tatMinutes: 20,
          }],
        }),
        model: 'catalog-test-model',
      }
    }
    if (this.codeable) {
      return {
        content: JSON.stringify({
          services: [{
            conclusionTemplate: '合成尿液定性检验已完成。',
            nameEn: 'Synthetic qualitative urine test',
            nameZh: '合成尿液定性检验',
            priceFen: 1_200,
            results: [{
              allowedValues: [{
                code: 'negative',
                display: '阴性',
                system: 'urn:clinmesh:synthetic:laboratory-result',
              }, {
                code: 'positive',
                display: '阳性',
                system: 'urn:clinmesh:synthetic:laboratory-result',
              }],
              conceptId: 'loinc:synthetic:94500-6',
              referenceRange: { text: '阴性' },
              valueType: 'codeable',
            }],
            rootConceptId: 'loinc:synthetic:94500-6',
            tatMinutes: 30,
          }],
        }),
        model: 'catalog-test-model',
      }
    }
    return {
      content: JSON.stringify({
        services: [{
          conclusionTemplate: '血常规结果已完成。',
          nameEn: 'Complete blood count',
          nameZh: '血常规',
          priceFen: 2_500,
          results: [{
            conceptId: 'loinc:synthetic:6690-2',
            referenceRange: { high: 10, low: 4, text: '4.0-10.0 x10^9/L' },
            valueType: 'quantity',
          }],
          rootConceptId: 'loinc:synthetic:58410-2',
          tatMinutes: 20,
        }],
      }),
      model: 'catalog-test-model',
    }
  }
}

describe('Laboratory Service Publisher HTTP contract', () => {
  const runtimes: Array<Awaited<ReturnType<typeof createClinMeshRuntime>>> = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
    await Promise.all(temporaryDirectories.splice(0).map(path => (
      rm(path, { force: true, recursive: true })
    )))
  })

  async function createReferenceDatabase(
    directory: string,
    options: {
      laboratoryDatasetReleaseId?: string
      laboratorySourceVersion?: string
      referenceReleaseId?: string
    } = {},
  ): Promise<string> {
    const laboratoryDatasetReleaseId = options.laboratoryDatasetReleaseId
      ?? 'laboratory-cn@2026-09-01.r1'
    const laboratorySourceVersion = options.laboratorySourceVersion ?? '2026-09-01'
    const laboratoryPanelConceptId = `laboratory-panel-cn:${laboratorySourceVersion}:CN-LAB-CBC`
    const referenceReleaseId = options.referenceReleaseId ?? 'laboratory-service-reference-v1'
    const databasePath = join(directory, 'reference.sqlite')
    const artifact = {
      concepts: [{
        code: '58410-2',
        display: '血常规组合',
        domain: 'laboratory',
        id: 'loinc:synthetic:58410-2',
        sourceLocator: 'synthetic:loinc:58410-2',
        status: 'active',
        system: 'http://loinc.org',
        version: '2.83',
      }, {
        code: '6690-2',
        display: '白细胞计数',
        domain: 'laboratory',
        id: 'loinc:synthetic:6690-2',
        sourceLocator: 'synthetic:loinc:6690-2',
        status: 'active',
        system: 'http://loinc.org',
        version: '2.83',
      }, {
        code: '8310-5',
        display: '体温',
        domain: 'other',
        id: 'loinc:synthetic:8310-5',
        sourceLocator: 'synthetic:loinc:8310-5',
        status: 'active',
        system: 'http://loinc.org',
        version: '2.83',
      }, {
        code: '94500-6',
        display: '合成尿液定性检验',
        domain: 'laboratory',
        id: 'loinc:synthetic:94500-6',
        sourceLocator: 'synthetic:loinc:94500-6',
        status: 'active',
        system: 'http://loinc.org',
        version: '2.83',
      }, {
        code: '0100101A',
        display: '白细胞计数',
        domain: 'laboratory',
        id: 'wst-886:2026:0100101A',
        sourceLocator: 'synthetic:laboratory-cn:test:0100101A',
        status: 'active',
        system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026',
        version: '2026',
      }, {
        code: '0100201A',
        display: '红细胞计数',
        domain: 'laboratory',
        id: 'wst-886:2026:0100201A',
        sourceLocator: 'synthetic:laboratory-cn:test:0100201A',
        status: 'active',
        system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026',
        version: '2026',
      }, {
        code: 'CN-LAB-CBC',
        display: '合成血常规',
        domain: 'laboratory',
        id: laboratoryPanelConceptId,
        sourceLocator: 'synthetic:laboratory-cn:panel:CN-LAB-CBC',
        status: 'active',
        system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn',
        version: laboratorySourceVersion,
      }],
      laboratoryDefinitions: [{
        classCode: 'PANEL.HEM',
        classType: 1,
        component: 'Complete blood count panel',
        conceptId: 'loinc:synthetic:58410-2',
        methodType: null,
        orderObservation: 'Order',
        panelType: 'Panel',
        property: '-',
        scaleType: '-',
        sourceLocator: 'synthetic:definition:58410-2',
        system: 'Blood',
        timeAspect: 'Pt',
      }, {
        classCode: 'HEM/BC',
        classType: 1,
        component: 'Leukocytes',
        conceptId: 'loinc:synthetic:6690-2',
        methodType: null,
        orderObservation: 'Both',
        panelType: null,
        property: 'NCnc',
        scaleType: 'Qn',
        sourceLocator: 'synthetic:definition:6690-2',
        system: 'Blood',
        timeAspect: 'Pt',
      }, {
        classCode: 'CLIN',
        classType: 2,
        component: 'Body temperature',
        conceptId: 'loinc:synthetic:8310-5',
        methodType: null,
        orderObservation: 'Observation',
        panelType: null,
        property: 'Temp',
        scaleType: 'Qn',
        sourceLocator: 'synthetic:definition:8310-5',
        system: 'Patient',
        timeAspect: 'Pt',
      }, {
        classCode: 'MICRO',
        classType: 1,
        component: 'Synthetic qualitative analyte',
        conceptId: 'loinc:synthetic:94500-6',
        methodType: null,
        orderObservation: 'Both',
        panelType: null,
        property: 'PrThr',
        scaleType: 'Nom',
        sourceLocator: 'synthetic:definition:94500-6',
        system: 'Urine',
        timeAspect: 'Pt',
      }, {
        adultReferenceRules: [{
          high: 9.5,
          low: 3.5,
          notes: '成人静脉血',
          referenceKind: 'range',
          sex: 'all',
          simulationHigh: 9.5,
          simulationLow: 3.5,
          sourceLocation: '表 1',
          sourceStandard: 'WS/T 405-2012',
          sourceType: 'national-standard',
          sourceVersion: '2012',
        }],
        alternateCodings: [{ code: '6690-2', system: 'http://loinc.org', version: '2.83' }],
        analyte: '白细胞(数量)',
        category: '血细胞分析',
        conceptId: 'wst-886:2026:0100101A',
        datasetReleaseId: laboratoryDatasetReleaseId,
        healthyStrategy: 'uniform',
        kind: 'laboratory-cn-test',
        precision: 1,
        resultKind: 'quantity',
        scale: '定量',
        sourceLocator: 'synthetic:laboratory-cn:test:0100101A',
        sourceVersion: laboratorySourceVersion,
        specimen: '全血',
        unit: {
          code: '10*9/L',
          display: '×10^9/L',
          system: 'http://unitsofmeasure.org',
        },
      }, {
        adultReferenceRules: [{
          high: 5.8,
          low: 4.3,
          notes: '成年男性静脉血',
          referenceKind: 'range',
          sex: 'male',
          simulationHigh: 5.8,
          simulationLow: 4.3,
          sourceLocation: '表 1',
          sourceStandard: 'WS/T 405-2012',
          sourceType: 'national-standard',
          sourceVersion: '2012',
        }, {
          high: 5.1,
          low: 3.8,
          notes: '成年女性静脉血',
          referenceKind: 'range',
          sex: 'female',
          simulationHigh: 5.1,
          simulationLow: 3.8,
          sourceLocation: '表 1',
          sourceStandard: 'WS/T 405-2012',
          sourceType: 'national-standard',
          sourceVersion: '2012',
        }],
        alternateCodings: [{ code: '789-8', system: 'http://loinc.org', version: '2.83' }],
        analyte: '红细胞(数量)',
        category: '血细胞分析',
        conceptId: 'wst-886:2026:0100201A',
        datasetReleaseId: laboratoryDatasetReleaseId,
        healthyStrategy: 'uniform',
        kind: 'laboratory-cn-test',
        precision: 1,
        resultKind: 'quantity',
        scale: '定量',
        sourceLocator: 'synthetic:laboratory-cn:test:0100201A',
        sourceVersion: laboratorySourceVersion,
        specimen: '全血',
        unit: {
          code: '10*12/L',
          display: '×10^12/L',
          system: 'http://unitsofmeasure.org',
        },
      }, {
        conceptId: laboratoryPanelConceptId,
        datasetReleaseId: laboratoryDatasetReleaseId,
        kind: 'laboratory-cn-panel',
        notes: '合成多叶子 panel',
        sourceLocation: 'fixture/panel/1',
        sourceLocator: 'synthetic:laboratory-cn:panel:CN-LAB-CBC',
        sourceType: 'project-authored',
        sourceVersion: laboratorySourceVersion,
        specimen: '全血',
      }],
      laboratoryPanelMembers: [{
        memberConceptId: 'loinc:synthetic:6690-2',
        memberOrder: 1,
        panelConceptId: 'loinc:synthetic:58410-2',
        relationship: 'contains',
        sourceLocator: 'synthetic:panel:58410-2:6690-2',
      }, {
        memberConceptId: 'wst-886:2026:0100101A',
        memberOrder: 1,
        panelConceptId: laboratoryPanelConceptId,
        relationship: 'contains',
        sourceLocator: 'synthetic:laboratory-cn:panel:CN-LAB-CBC:1',
      }, {
        memberConceptId: 'wst-886:2026:0100201A',
        memberOrder: 2,
        panelConceptId: laboratoryPanelConceptId,
        relationship: 'contains',
        sourceLocator: 'synthetic:laboratory-cn:panel:CN-LAB-CBC:2',
      }],
      laboratorySpecimens: [{
        conceptId: 'loinc:synthetic:58410-2',
        display: '血液',
        linkType: 'Primary',
        partName: 'Blood',
        partNumber: 'LP7057-5',
        sourceLocator: 'synthetic:specimen:58410-2',
      }, {
        conceptId: 'loinc:synthetic:6690-2',
        display: '血液',
        linkType: 'Primary',
        partName: 'Blood',
        partNumber: 'LP7057-5',
        sourceLocator: 'synthetic:specimen:6690-2',
      }, {
        conceptId: 'loinc:synthetic:94500-6',
        display: '尿液',
        linkType: 'Primary',
        partName: 'Urine',
        partNumber: 'LP7681-2',
        sourceLocator: 'synthetic:specimen:94500-6',
      }],
      laboratoryUnits: [{
        code: '10*9/L',
        conceptId: 'loinc:synthetic:6690-2',
        kind: 'example',
        ordinal: 1,
        sourceLocator: 'synthetic:unit:6690-2',
      }],
      schemaVersion: '1',
    }
    const artifactJson = `${JSON.stringify(artifact)}\n`
    const artifactPath = join(directory, 'reference.json')
    const manifestPath = join(directory, 'release.json')
    await writeFile(artifactPath, artifactJson)
    await writeFile(manifestPath, `${JSON.stringify({
      createdAt: '2026-09-01T07:00:00.000Z',
      releaseId: referenceReleaseId,
      schemaVersion: '1',
      sources: [{
        acquisitionMethod: 'generated',
        artifactPath: 'reference.json',
        checksum: createHash('sha256').update(artifactJson).digest('hex'),
        licenseId: 'LicenseRef-Synthetic-Test',
        retrievedAt: '2026-09-01T07:00:00.000Z',
        sourceId: 'synthetic-loinc',
        sourceUrl: 'https://example.test/synthetic-loinc',
        upstreamVersion: '2.83-test',
      }],
    })}\n`)
    await runReferenceDatabaseCli(['migrate', '--database', databasePath])
    await runReferenceDatabaseCli([
      'import', '--database', databasePath, '--manifest', manifestPath,
    ])
    return databasePath
  }

  async function signIn(
    runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
    password: string,
    email: string,
  ): Promise<string> {
    const response = await runtime.app.request('/api/auth/sign-in/email', {
      body: JSON.stringify({ email, password }),
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      method: 'POST',
    })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
  }

  async function createRuntime(provider?: LaboratoryEnrichmentProvider) {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-laboratory-publisher-'))
    temporaryDirectories.push(directory)
    const referenceDatabasePath = await createReferenceDatabase(directory)
    const operationalDatabasePath = join(directory, 'operational.sqlite')
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      activeReferenceReleaseId: 'laboratory-service-reference-v1',
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      ...(provider === undefined
        ? {}
        : {
            catalogEnrichmentModel: 'catalog-test-model',
          }),
      patientPersonaModel: 'brief-fixture',
      chatCompletionsProvider: {
        ...(provider?.resolveModel === undefined ? {} : { resolveModel: async (model: string) => model === 'brief-fixture' ? model : provider.resolveModel!(model) }),
        completeJson: async input => {
          if (input.model !== 'brief-fixture' && provider !== undefined) return provider.completeJson(input)
          return { model: 'brief-fixture', content: JSON.stringify({
            chiefComplaint: '咽痛两天', knownHistorySummary: '既往体健。', openingStatement: '医生您好，我咽痛两天了。',
            medicationMemory: '没吃过药。', symptomExperience: '两天前开始嗓子痛。',
            persona: { character: '随和', speechStyle: '简洁', healthLiteracy: '一般', attitude: '信任医生' },
          }) }
        },
      },
      syntheaProvider: {
        capabilities: async () => ({ available: true, maxPopulation: 1, modules: [], providerId: 'synthea', providerName: 'Synthea' }),
        generate: async () => {
          const bundle = { resourceType: 'Bundle', type: 'collection', entry: [
            { fullUrl: 'urn:uuid:patient', resource: { resourceType: 'Patient', id: 'patient', birthDate: '1970-01-01', gender: 'female', name: [{ text: '合成检验患者' }] } },
            { fullUrl: 'urn:uuid:encounter', resource: { resourceType: 'Encounter', id: 'encounter', status: 'finished', subject: { reference: 'urn:uuid:patient' }, period: { start: '2026-06-01T10:00:00+08:00', end: '2026-06-01T10:30:00+08:00' }, reasonCode: [{ text: '咽痛' }] } },
            { fullUrl: 'urn:uuid:condition', resource: { resourceType: 'Condition', id: 'condition', subject: { reference: 'urn:uuid:patient' }, encounter: { reference: 'urn:uuid:encounter' }, code: { coding: [{ code: '195662009', display: '急性病毒性咽炎', system: 'http://snomed.info/sct' }] }, recordedDate: '2026-06-01T10:05:00+08:00' } },
          ] }
          return { kind: 'synthea-r4', sources: [{ format: 'fhir-r4-bundle', hash: sourceArtifactHash(bundle), patientId: 'patient', raw: bundle }] }
        },
      },
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: operationalDatabasePath,
      demoPassword: password,
      migrationMode: 'apply',
      referenceDatabasePath,
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    return {
      administratorCookie: await signIn(runtime, password, 'admin@demo.clinmesh.local'),
      directory,
      doctorCookie: await signIn(runtime, password, 'doctor@demo.clinmesh.local'),
      triageCookie: await signIn(runtime, password, 'triage@demo.clinmesh.local'),
      operationalDatabasePath,
      password,
      referenceDatabasePath,
      runtime,
    }
  }

  function editReferenceDatabase(
    databasePath: string,
    edit: (database: ReturnType<typeof openReferenceDatabase>) => void,
  ): void {
    const database = openReferenceDatabase({ busyTimeoutMs: 5_000, databasePath })
    try {
      edit(database)
    } finally {
      database.close()
    }
  }

  async function publishCbc(
    runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
    administratorCookie: string,
    expectedVersion: number,
    idempotencyKey = randomUUID(),
  ) {
    const response = await runtime.app.request(
      '/api/his/v1/admin/laboratory-services/actions/publish',
      {
        body: JSON.stringify({
          input: {
            entries: [{ conceptId: 'loinc:synthetic:58410-2', expectedVersion }],
          },
        }),
        headers: {
          'content-type': 'application/json',
          cookie: administratorCookie,
          'idempotency-key': idempotencyKey,
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    return { response, value: await response.clone().json() }
  }

  async function publishLaboratoryCnPanel(
    runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
    administratorCookie: string,
    conceptId = 'laboratory-panel-cn:2026-09-01:CN-LAB-CBC',
  ) {
    const response = await runtime.app.request(
      '/api/his/v1/admin/laboratory-services/actions/publish',
      {
        body: JSON.stringify({
          input: { entries: [{ conceptId, expectedVersion: 0 }] },
        }),
        headers: {
          'content-type': 'application/json',
          cookie: administratorCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(response.status).toBe(200)
    await runtime.dispatchLaboratoryServicePublicationJobs()
  }

  async function startMaterializedCase(fixture: Awaited<ReturnType<typeof createRuntime>>) {
    const { runtime, administratorCookie, triageCookie, doctorCookie } = fixture
    const post = async (path: string, cookie: string, body: unknown) => {
      const response = await runtime.app.request(path, {
        method: 'POST', body: JSON.stringify(body), headers: {
          'content-type': 'application/json', cookie, 'idempotency-key': randomUUID(), origin: 'http://localhost',
        },
      })
      expect(response.status, await response.clone().text()).toBe(200)
      return response.json()
    }
    await post('/api/sim/v1/scenario-generation-jobs', administratorCookie, {
      name: '合成检验病例', population: { age: { maximum: 65, minimum: 18 }, count: 1, gender: 'any' },
      providerId: 'synthea', seeds: { clinical: 7331, population: 4242 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' }, timeZone: 'Asia/Shanghai',
    })
    const generation = await runtime.scenarioData.processNextGenerationJob()
    expect(generation?.status).toBe('succeeded')
    const caseId = generation!.caseIds[0]!
    await post(`/api/sim/v1/synthetic-cases/${caseId}/patient-persona-jobs`, administratorCookie, {})
    expect((await runtime.patientPersona.processNext())?.status).toBe('succeeded')
    const syntheticCase = syntheticCaseInstanceSchema.parse(await (await runtime.app.request(
      `/api/sim/v1/synthetic-cases/${caseId}`, { headers: { cookie: administratorCookie } },
    )).json())
    const catalog = registrationCatalogSchema.parse(await (await runtime.app.request(
      '/api/his/v1/catalogs/registration', { headers: { cookie: administratorCookie } },
    )).json())
    const started = commandResponseSchema(startSyntheticCaseResultSchema).parse(await post(
      `/api/his/v1/synthetic-cases/${caseId}/actions/start-outpatient-visit`, administratorCookie, {
        activeBriefRevision: syntheticCase.activeBriefRevision, expectedCaseRevision: syntheticCase.revision,
        departmentId: catalog.departments[0]!.id, locationId: catalog.locations[0]!.id,
        visitDate: catalog.virtualDate, visitTypeId: catalog.visitTypes[0]!.id,
      },
    )).data
    const triage = triageResponseSchema.parse(await post(
      `/api/his/v1/encounters/${started.encounterId}/actions/record-triage`, triageCookie, {
        expectedVersions: { [`Encounter/${started.encounterId}`]: '1', [`Task/${started.queueTaskId}`]: '1' },
        input: { acuityCode: 'level-3', chiefComplaint: '咽痛两天', temperatureC: 36.6,
          pulseBpm: 84, respirationBpm: 18, oxygenSaturationPct: 98,
          bloodPressure: { diastolicMmHg: 82, systolicMmHg: 128 } },
      },
    )).data
    await post(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, doctorCookie, {
      expectedVersions: { [`Encounter/${started.encounterId}`]: '2', [`Task/${triage.doctorTaskId}`]: '1' }, input: {},
    })
    return { ...started, caseId: started.outpatientCaseId }
  }

  async function issuePublishedLaboratoryService(
    fixture: Awaited<ReturnType<typeof createRuntime>>,
    serviceId: string,
  ) {
    const { runtime, doctorCookie } = fixture
    const started = await startMaterializedCase(fixture)
    const encounterReference = `Encounter/${started.encounterId}`
    const draft = laboratoryRequestDraftResponseSchema.parse(await (await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [encounterReference]: '3' },
          input: {
            catalogItemId: serviceId,
            expectedDraftVersion: 0,
            indicationCode: 'clinical-evaluation',
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
    )).json()).data
    return issueLaboratoryRequestResponseSchema.parse(await (await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/actions/issue`,
      {
        body: JSON.stringify({
          expectedVersions: { [encounterReference]: '3' },
          input: { expectedDraftVersion: draft.draftVersion },
        }),
        headers: {
          'content-type': 'application/json',
          cookie: doctorCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )).json()).data.request
  }

  it.each(['policy', 'task-journal'])('publishes deterministic work behind a %s refusal and resumes the original job after recovery', async failure => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-catalog-queue-recovery-'))
    temporaryDirectories.push(directory)
    let sent = 0
    const runtime = await createClinMeshRuntime({
      activeReferenceReleaseId: 'laboratory-service-reference-v1',
      authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
      cursorSecret: 'synthetic-cursor-secret-at-least-32-characters', databasePath: join(directory, 'operational.sqlite'),
      demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply', trustedOrigins: ['http://localhost'],
      referenceDatabasePath: await createReferenceDatabase(directory), catalogEnrichmentModel: 'catalog-test-model',
      chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic', baseUrl: 'https://synthetic.invalid',
        fetch: async () => {
          sent++
          return Response.json({ choices: [{ message: { content: JSON.stringify({ services: [{
            conclusionTemplate: '血常规结果已完成。', nameEn: 'Complete blood count', nameZh: '血常规', priceFen: 2500,
            results: [{ conceptId: 'loinc:synthetic:6690-2', referenceRange: { high: 10, low: 4, text: '4.0-10.0 x10^9/L' }, valueType: 'quantity' }],
            rootConceptId: 'loinc:synthetic:58410-2', tatMinutes: 20,
          }] }) } }] })
        } }),
    })
    runtimes.push(runtime)
    const cookie = await signIn(runtime, 'Synthetic-Demo-Password-2026!', 'admin@demo.clinmesh.local')
    await setModelControl(runtime, cookie, { enabled: failure !== 'policy', requests: null, automaticRetries: true })
    if (failure === 'task-journal') runtime.database.driver.exec(`CREATE TRIGGER synthetic_task_journal_unavailable BEFORE INSERT ON model_task_step
      BEGIN SELECT RAISE(ABORT, 'synthetic unavailable'); END`)
    const first = await publishCbc(runtime, cookie, 0)
    expect(first.response.status).toBe(200)
    const jobId = publishLaboratoryServicesResponseSchema.parse(first.value).data.jobId
    const read = async () => laboratoryServicePublicationJobSchema.parse(await (await runtime.app.request(
      `/api/his/v1/admin/laboratory-services/jobs/${jobId}`, { headers: { cookie } })).json())
    await runtime.dispatchLaboratoryServicePublicationJobs()
    expect(await read()).toMatchObject({ status: 'queued' })
    const response = await runtime.app.request('/api/his/v1/admin/laboratory-services/actions/publish', {
      method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ input: { entries: [{ conceptId: 'laboratory-panel-cn:2026-09-01:CN-LAB-CBC', expectedVersion: 0 }] } }),
    })
    expect(response.status).toBe(200)
    const deterministicJobId = publishLaboratoryServicesResponseSchema.parse(await response.json()).data.jobId
    await runtime.dispatchLaboratoryServicePublicationJobs()
    await runtime.dispatchLaboratoryServicePublicationJobs()
    expect(laboratoryServicePublicationJobSchema.parse(await (await runtime.app.request(
      `/api/his/v1/admin/laboratory-services/jobs/${deterministicJobId}`, { headers: { cookie } })).json())).toMatchObject({ status: 'succeeded' })
    expect(await read()).toMatchObject({ status: 'queued' })
    expect(sent).toBe(0)
    if (failure === 'task-journal') runtime.database.driver.exec('DROP TRIGGER synthetic_task_journal_unavailable')
    await setModelControl(runtime, cookie, { enabled: true, requests: null, automaticRetries: true })
    await expect.poll(async () => (await read()).status).toBe('succeeded')
    expect(await read()).toMatchObject({ jobId, status: 'succeeded' })
    expect(sent).toBe(1)
  })

  it('makes every laboratory-cn panel and test orderable without manual publication', async () => {
    const fixture = await createRuntime()
    const response = await fixture.runtime.app.request(
      '/api/his/v1/admin/laboratory-services/candidates?page=1&pageSize=20',
      { headers: { cookie: fixture.administratorCookie } },
    )
    const candidates = laboratoryServiceCandidateSearchSchema.parse(await response.json())
    expect(referenceDatabaseIsReady(fixture.referenceDatabasePath, '.', 'laboratory-service-reference-v1')).toBe(true)
    expect(referenceDatabaseIsReady(fixture.referenceDatabasePath, '.', 'new-release')).toBe(false)
    expect(candidates.total).toBe(3)
    expect(candidates.items.every(item => item.sourceDataset.datasetId === 'laboratory-cn' && item.status === 'published')).toBe(true)
    const started = await startMaterializedCase(fixture)
    const catalog = caseLaboratoryCatalogSearchSchema.parse(await (await fixture.runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}/reference-catalogs/laboratory?page=1&pageSize=20`,
      { headers: { cookie: fixture.doctorCookie } },
    )).json())
    expect(catalog.items.filter(item => candidates.items.some(candidate => candidate.publishedServiceId === item.id))).toHaveLength(3)
    fixture.runtime.laboratoryServicePublisher.ensureDefaultServices()
    const unchanged = caseLaboratoryCatalogSearchSchema.parse(await (await fixture.runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}/reference-catalogs/laboratory?page=1&pageSize=20`,
      { headers: { cookie: fixture.doctorCookie } },
    )).json())
    expect(unchanged).toEqual(catalog)
    const reset = await fixture.runtime.app.request('/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', {
      method: 'POST', body: '{}', headers: { cookie: fixture.administratorCookie,
        origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    })
    expect(reset.status).toBe(200)
    const afterReset = laboratoryServiceCandidateSearchSchema.parse(await (await fixture.runtime.app.request(
      '/api/his/v1/admin/laboratory-services/candidates?page=1&pageSize=20',
      { headers: { cookie: fixture.administratorCookie } },
    )).json())
    expect(afterReset.items.map(item => item.publishedServiceId)).toEqual(candidates.items.map(item => item.publishedServiceId))

  })

  it.each([
    { panelSpecimen: '全血、血清', leafSpecimen: '全血', expected: '全血' },
    { panelSpecimen: '混合标本', leafSpecimen: '血清', expected: '混合标本' },
  ])('publishes declared specimen alternatives and mixed panels: $panelSpecimen', async ({ panelSpecimen, leafSpecimen, expected }) => {
    const fixture = await createRuntime()
    editReferenceDatabase(fixture.referenceDatabasePath, database => {
      database.driver.prepare(`UPDATE reference_laboratory_definition
        SET definition_json = json_set(definition_json, '$.specimen', ?)
        WHERE concept_id = 'laboratory-panel-cn:2026-09-01:CN-LAB-CBC'`).run(panelSpecimen)
      database.driver.prepare(`UPDATE reference_laboratory_definition
        SET definition_json = json_set(definition_json, '$.specimen', ?)
        WHERE concept_id = 'wst-886:2026:0100101A'`).run(leafSpecimen)
    })
    await publishLaboratoryCnPanel(fixture.runtime, fixture.administratorCookie)
    const row = fixture.runtime.database.driver.prepare(`SELECT config_json FROM hospital_service_catalog
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
      AND json_extract(config_json, '$.laboratoryService.referenceConcept.code') = 'CN-LAB-CBC'`).get() as { config_json: string }
    expect(laboratoryServiceSnapshotSchema.parse(JSON.parse(row.config_json).laboratoryService).specimen.display).toBe(expected)
  })

  it('paginates orderable Laboratory Service candidates', async () => {
    const { administratorCookie, runtime } = await createRuntime()
    const candidatePages = await Promise.all([1, 2].map(async page => (
      laboratoryServiceCandidateSearchSchema.parse(await (await runtime.app.request(
        `/api/his/v1/admin/laboratory-services/candidates?page=${page}&pageSize=1`,
        { headers: { cookie: administratorCookie } },
      )).json())
    )))
    expect(candidatePages.map(page => page.total)).toEqual([3, 3])
    expect(new Set(candidatePages.flatMap(page => page.items.map(item => item.concept.id))).size)
      .toBe(2)
  })

  it('filters laboratory-cn panel candidates and exposes their publication provenance', async () => {
    const { administratorCookie, runtime } = await createRuntime()
    const response = await runtime.app.request(
      '/api/his/v1/admin/laboratory-services/candidates?page=1&pageSize=20'
        + '&sourceDataset=laboratory-cn&panelOnly=true',
      { headers: { cookie: administratorCookie } },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      items: [{
        adultApplicability: {
          minimumAgeYears: 18,
          patientSexes: ['female', 'male'],
        },
        concept: {
          code: 'CN-LAB-CBC',
          id: 'laboratory-panel-cn:2026-09-01:CN-LAB-CBC',
        },
        memberCount: 2,
        referenceSources: [{
          sourceStandard: 'WS/T 405-2012',
          sourceType: 'national-standard',
          sourceVersion: '2012',
        }],
        sourceDataset: {
          datasetId: 'laboratory-cn',
          releaseId: 'laboratory-cn@2026-09-01.r1',
        },
        specimen: '全血',
        standardStatus: {
          effectiveOn: '2026-11-01',
          mode: 'future-standard-preview',
          standard: 'WS/T 886-2026',
        },
      }],
      total: 1,
    })
  })

  it('publishes a laboratory-cn panel deterministically without an AI provider', async () => {
    const { administratorCookie, runtime } = await createRuntime()
    const response = await runtime.app.request(
      '/api/his/v1/admin/laboratory-services/actions/publish',
      {
        body: JSON.stringify({
          input: {
            entries: [{
              conceptId: 'laboratory-panel-cn:2026-09-01:CN-LAB-CBC',
              expectedVersion: 0,
            }],
          },
        }),
        headers: {
          'content-type': 'application/json',
          cookie: administratorCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(response.status).toBe(200)
    const jobId = publishLaboratoryServicesResponseSchema.parse(await response.json()).data.jobId
    await runtime.dispatchLaboratoryServicePublicationJobs()

    expect(laboratoryServicePublicationJobSchema.parse(await (await runtime.app.request(
      `/api/his/v1/admin/laboratory-services/jobs/${jobId}`,
      { headers: { cookie: administratorCookie } },
    )).json())).toMatchObject({
      publishedServiceIds: expect.arrayContaining([
        expect.stringMatching(/^hospital-laboratory-service-/),
      ]),
      status: 'succeeded',
    })
    const rows = runtime.database.driver.prepare(`
      SELECT service_id, config_json FROM hospital_service_catalog
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND json_extract(config_json, '$.laboratoryService.sourceDataset.datasetId') = 'laboratory-cn'
        AND (json_extract(config_json, '$.laboratoryService.doctorOrderable') = 0
          OR json_extract(config_json, '$.laboratoryService.referenceConcept.code') = 'CN-LAB-CBC')
      ORDER BY json_extract(config_json, '$.laboratoryService.doctorOrderable') DESC, service_id
    `).all() as Array<{ config_json: string; service_id: string }>
    expect(rows).toHaveLength(3)
    const rootService = laboratoryServiceSnapshotSchema.parse(
      JSON.parse(rows[0]!.config_json).laboratoryService,
    )
    expect(rootService).toMatchObject({
      componentServiceIds: expect.arrayContaining([rows[1]!.service_id, rows[2]!.service_id]),
      doctorOrderable: true,
      nameZh: '合成血常规',
      priceFen: 0,
      publicationPolicyVersion: 'clinmesh-laboratory-defaults-v2',
      reportDefinition: {
        conclusionTemplate: '本报告为 ClinMesh 合成检验结果，仅用于仿真。',
        results: [
          expect.objectContaining({
            adultReferenceRules: [expect.objectContaining({ sex: 'all' })],
            alternateCodings: [{ code: '6690-2', system: 'http://loinc.org', version: '2.83' }],
            healthyStrategy: 'uniform',
            precision: 1,
          }),
          expect.objectContaining({
            adultReferenceRules: [
              expect.objectContaining({ sex: 'male' }),
              expect.objectContaining({ sex: 'female' }),
            ],
          }),
        ],
      },
      sourceDataset: {
        datasetId: 'laboratory-cn',
        releaseId: 'laboratory-cn@2026-09-01.r1',
      },
      standardStatus: {
        effectiveOn: '2026-11-01',
        mode: 'future-standard-preview',
        standard: 'WS/T 886-2026',
      },
      tatMinutes: 180,
    })
    expect(rootService.reportDefinition.results.map(result => result.referenceConcept.code))
      .toEqual(['0100101A', '0100201A'])

    const republishCandidates = laboratoryServiceCandidateSearchSchema.parse(
      await (await runtime.app.request(
        '/api/his/v1/admin/laboratory-services/candidates?page=1&pageSize=20'
          + '&sourceDataset=laboratory-cn&panelOnly=true',
        { headers: { cookie: administratorCookie } },
      )).json(),
    )
    expect(republishCandidates.items[0]).toMatchObject({
      publishedServiceId: rootService.id,
      status: 'published',
      version: 1,
    })
    const republishResponse = await runtime.app.request(
      '/api/his/v1/admin/laboratory-services/actions/publish',
      {
        body: JSON.stringify({
          input: {
            entries: [{
              conceptId: 'laboratory-panel-cn:2026-09-01:CN-LAB-CBC',
              expectedVersion: 1,
            }],
          },
        }),
        headers: {
          'content-type': 'application/json',
          cookie: administratorCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(republishResponse.status).toBe(200)
    await runtime.dispatchLaboratoryServicePublicationJobs()
    const republishedRows = runtime.database.driver.prepare(`
      SELECT service_id, version FROM hospital_service_catalog
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND json_extract(config_json, '$.laboratoryService.sourceDataset.datasetId') = 'laboratory-cn'
        AND (json_extract(config_json, '$.laboratoryService.doctorOrderable') = 0
          OR json_extract(config_json, '$.laboratoryService.referenceConcept.code') = 'CN-LAB-CBC')
      ORDER BY service_id
    `).all() as Array<{ service_id: string; version: number }>
    expect(republishedRows).toHaveLength(3)
    expect(republishedRows.find(row => row.service_id === rootService.id)).toMatchObject({
      service_id: rootService.id,
      version: 3,
    })

  })

  it('keeps a panel service identity across Reference Releases without changing an issued snapshot', async () => {
    const first = await createRuntime()
    await publishLaboratoryCnPanel(first.runtime, first.administratorCookie)
    const firstRow = first.runtime.database.driver.prepare(`
      SELECT service_id, version, config_json FROM hospital_service_catalog
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND json_extract(config_json, '$.laboratoryService.sourceDataset.datasetId') = 'laboratory-cn'
        AND json_extract(config_json, '$.laboratoryService.doctorOrderable') = 1
        AND json_array_length(json_extract(config_json, '$.laboratoryService.componentServiceIds')) > 0
    `).get() as { config_json: string; service_id: string; version: number }
    const firstService = laboratoryServiceSnapshotSchema.parse(
      JSON.parse(firstRow.config_json).laboratoryService,
    )
    const issued = await issuePublishedLaboratoryService(
      first,
      firstService.id,
    )
    const issuedSnapshotJson = (first.runtime.database.driver.prepare(`
      SELECT service_snapshot_json FROM laboratory_request
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1' AND request_id = ?
    `).get(issued.id) as { service_snapshot_json: string }).service_snapshot_json

    await first.runtime.close()
    runtimes.splice(runtimes.indexOf(first.runtime), 1)
    await createReferenceDatabase(first.directory, {
      laboratoryDatasetReleaseId: 'laboratory-cn@2026-10-01.r1',
      laboratorySourceVersion: '2026-10-01',
      referenceReleaseId: 'laboratory-service-reference-v2',
    })
    const secondRuntime = await createClinMeshRuntime({
      activeReferenceReleaseId: 'laboratory-service-reference-v2',
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: first.operationalDatabasePath,
      demoPassword: first.password,
      migrationMode: 'apply',
      referenceDatabasePath: first.referenceDatabasePath,
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(secondRuntime)
    const secondAdministratorCookie = await signIn(
      secondRuntime,
      first.password,
      'admin@demo.clinmesh.local',
    )
    await publishLaboratoryCnPanel(
      secondRuntime,
      secondAdministratorCookie,
      'laboratory-panel-cn:2026-10-01:CN-LAB-CBC',
    )

    const secondRow = secondRuntime.database.driver.prepare(`
      SELECT service_id, version, config_json FROM hospital_service_catalog
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND json_extract(config_json, '$.laboratoryService.sourceDataset.datasetId') = 'laboratory-cn'
        AND json_extract(config_json, '$.laboratoryService.doctorOrderable') = 1
        AND json_array_length(json_extract(config_json, '$.laboratoryService.componentServiceIds')) > 0
    `).get() as { config_json: string; service_id: string; version: number }
    const secondService = laboratoryServiceSnapshotSchema.parse(
      JSON.parse(secondRow.config_json).laboratoryService,
    )
    expect(secondRow).toMatchObject({ service_id: firstRow.service_id, version: 4 })
    expect(secondService).toMatchObject({
      id: firstService.id,
      referenceConcept: { id: 'laboratory-panel-cn:2026-10-01:CN-LAB-CBC' },
      referenceReleaseId: 'laboratory-service-reference-v2',
      sourceDataset: { releaseId: 'laboratory-cn@2026-10-01.r1' },
    })
    const persistedIssuedSnapshotJson = (secondRuntime.database.driver.prepare(`
      SELECT service_snapshot_json FROM laboratory_request
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1' AND request_id = ?
    `).get(issued.id) as { service_snapshot_json: string }).service_snapshot_json
    expect(persistedIssuedSnapshotJson).toBe(issuedSnapshotJson)
    expect(laboratoryServiceSnapshotSchema.parse(JSON.parse(persistedIssuedSnapshotJson)))
      .toMatchObject({
        id: firstService.id,
        referenceReleaseId: 'laboratory-service-reference-v1',
        sourceDataset: { releaseId: 'laboratory-cn@2026-09-01.r1' },
        version: 2,
      })
  })

  it.each([
    {
      mutate: (databasePath: string) => {
        editReferenceDatabase(databasePath, database => {
          database.driver.prepare(`
            UPDATE reference_concept SET status = 'inactive'
            WHERE release_id = 'laboratory-service-reference-v1'
              AND concept_id = 'wst-886:2026:0100101A'
          `).run()
        })
      },
      scenario: 'an inactive panel member',
    },
    {
      mutate: (databasePath: string) => {
        editReferenceDatabase(databasePath, database => {
          database.driver.prepare(`
            UPDATE reference_laboratory_definition
            SET definition_json = json_set(definition_json, '$.specimen', '血清')
            WHERE release_id = 'laboratory-service-reference-v1'
              AND concept_id = 'wst-886:2026:0100101A'
          `).run()
        })
      },
      scenario: 'a panel specimen conflict',
    },
  ])('rejects $scenario before publishing laboratory-cn services', async ({ mutate }) => {
    const { administratorCookie, referenceDatabasePath, runtime } = await createRuntime()
    mutate(referenceDatabasePath)
    const response = await runtime.app.request(
      '/api/his/v1/admin/laboratory-services/actions/publish',
      {
        body: JSON.stringify({
          input: {
            entries: [{
              conceptId: 'laboratory-panel-cn:2026-09-01:CN-LAB-CBC',
              expectedVersion: 0,
            }],
          },
        }),
        headers: {
          'content-type': 'application/json',
          cookie: administratorCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(response.status).toBe(200)
    const jobId = publishLaboratoryServicesResponseSchema.parse(await response.json()).data.jobId
    await runtime.dispatchLaboratoryServicePublicationJobs()
    expect(laboratoryServicePublicationJobSchema.parse(await (await runtime.app.request(
      `/api/his/v1/admin/laboratory-services/jobs/${jobId}`,
      { headers: { cookie: administratorCookie } },
    )).json())).toMatchObject({
      error: { code: 'LABORATORY_PANEL_INVALID' },
      publishedServiceIds: [],
      status: 'failed',
    })
  })

  it.each([false, true])('rechecks the publishing Agent grant before dispatch (revoked: %s)', async revoked => {
    const provider = new LaboratoryEnrichmentProvider()
    const { administratorCookie, runtime } = await createRuntime(provider)
    const administratorHeaders = new Headers({ cookie: administratorCookie, origin: 'http://localhost' })
    const client = await runtime.identity.createAgentClient(administratorHeaders, { name: 'Synthetic catalog Agent' }, randomUUID())
    const grant = await runtime.identity.createAgentGrant(administratorHeaders, {
      agentClientId: client.agentClientId, operationIds: ['admin.laboratory-services.publish'],
      practitionerRoleId: 'practitioner-role-administrator', ttlSeconds: 600,
    }, randomUUID())
    const response = await runtime.app.request('/api/his/v1/admin/laboratory-services/actions/publish', {
      method: 'POST', headers: { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ input: { entries: [{ conceptId: 'loinc:synthetic:58410-2', expectedVersion: 0 }] } }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    const { jobId } = publishLaboratoryServicesResponseSchema.parse(await response.json()).data
    if (revoked) await runtime.identity.revokeAgentGrant(administratorHeaders, grant.grantId, randomUUID())
    await runtime.dispatchLaboratoryServicePublicationJobs()
    const job = laboratoryServicePublicationJobSchema.parse(await (await runtime.app.request(
      `/api/his/v1/admin/laboratory-services/jobs/${jobId}`, { headers: { cookie: administratorCookie } },
    )).json())
    expect(job).toMatchObject(revoked ? { status: 'failed', error: { code: 'ROLE_NOT_ALLOWED' }, publishedServiceIds: [] }
      : { status: 'succeeded', error: null, publishedServiceIds: [expect.any(String), expect.any(String)] })
    expect(provider.calls).toHaveLength(revoked ? 0 : 1)
  })

  it('publishes an enriched panel atomically and exposes only its orderable root to doctors', async () => {
    const provider = new LaboratoryEnrichmentProvider()
    const fixture = await createRuntime(provider)
    const { administratorCookie, doctorCookie, runtime } = fixture

    const candidatesResponse = await runtime.app.request(
      '/api/his/v1/admin/laboratory-services/candidates?page=1&pageSize=20&sourceDataset=loinc-zh-cn&query=58410-2',
      { headers: { cookie: administratorCookie } },
    )
    if (candidatesResponse.status !== 200) {
      throw new Error(`Laboratory Service candidates failed: ${await candidatesResponse.text()}`)
    }
    const candidates = laboratoryServiceCandidateSearchSchema.parse(
      await candidatesResponse.json(),
    )
    expect(candidates).toMatchObject({
      items: [{
        concept: { code: '58410-2', id: 'loinc:synthetic:58410-2' },
        status: 'unconfigured',
        version: 0,
      }],
      referenceReleaseId: 'laboratory-service-reference-v1',
      total: 1,
    })

    const { response: publishResponse, value: publishValue } = await publishCbc(
      runtime,
      administratorCookie,
      0,
    )
    expect(publishResponse.status).toBe(200)
    const job = publishLaboratoryServicesResponseSchema.parse(
      publishValue,
    ).data
    expect(job).toMatchObject({
      conceptIds: ['loinc:synthetic:58410-2'],
      status: 'queued',
    })

    await runtime.dispatchLaboratoryServicePublicationJobs()
    const jobResponse = await runtime.app.request(
      `/api/his/v1/admin/laboratory-services/jobs/${job.jobId}`,
      { headers: { cookie: administratorCookie } },
    )
    expect(jobResponse.status).toBe(200)
    expect(laboratoryServicePublicationJobSchema.parse(await jobResponse.json())).toMatchObject({
      publishedServiceIds: expect.arrayContaining([
        expect.stringMatching(/^hospital-laboratory-service-/),
      ]),
      status: 'succeeded',
    })
    expect(provider.calls).toHaveLength(1)

    const started = await startMaterializedCase(fixture)
    const doctorCatalogResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}/reference-catalogs/laboratory?page=1&pageSize=20&query=58410-2`,
      { headers: { cookie: doctorCookie } },
    )
    expect(doctorCatalogResponse.status).toBe(200)
    const responseJson = await doctorCatalogResponse.json()
    expect(JSON.stringify(responseJson)).not.toContain('resultGeneration')
    const doctorCatalog = caseLaboratoryCatalogSearchSchema.parse(responseJson)
    expect(doctorCatalog).toMatchObject({
      items: [{
        doctorOrderable: true,
        nameZh: '血常规',
        referenceConcept: {
          code: '58410-2',
          id: 'loinc:synthetic:58410-2',
        },
        reportDefinition: {
          results: [{
            referenceConcept: { code: '6690-2', id: 'loinc:synthetic:6690-2' },
            unit: { code: '10*9/L' },
            valueType: 'quantity',
          }],
        },
      }],
      total: 1,
    })
    const searchCatalog = async (query: string) => {
      const response = await runtime.app.request(
        `/api/his/v1/doctor/cases/${started.caseId}/reference-catalogs/laboratory?page=1&pageSize=20&query=${encodeURIComponent(query)}`,
        { headers: { cookie: doctorCookie } },
      )
      expect(response.status).toBe(200)
      return caseLaboratoryCatalogSearchSchema.parse(await response.json())
    }
    expect((await searchCatalog('血常规 血')).total).toBe(2)
    expect((await searchCatalog('血常规 不存在')).total).toBe(0)

    const publishedService = doctorCatalog.items[0]!
    const encounterReference = `Encounter/${started.encounterId}`
    const mutationHeaders = () => ({
      'content-type': 'application/json',
      cookie: doctorCookie,
      'idempotency-key': randomUUID(),
      origin: 'http://localhost',
    })
    const bypassResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [encounterReference]: '3' },
          input: {
            catalogItemId: 'loinc:synthetic:58410-2',
            expectedDraftVersion: 0,
            indicationCode: 'clinical-evaluation',
          },
        }),
        headers: mutationHeaders(),
        method: 'PUT',
      },
    )
    expect(bypassResponse.status).toBe(409)

    const draftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [encounterReference]: '3' },
          input: {
            catalogItemId: publishedService.id,
            expectedDraftVersion: 0,
            indicationCode: 'clinical-evaluation',
          },
        }),
        headers: mutationHeaders(),
        method: 'PUT',
      },
    )
    expect(draftResponse.status).toBe(200)
    const draft = laboratoryRequestDraftResponseSchema.parse(await draftResponse.json()).data
    const detailWithDraft = doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )).json())
    expect(detailWithDraft.laboratoryRequests?.draft).toMatchObject({
      catalogItemId: publishedService.id,
      laboratoryService: {
        id: publishedService.id,
        referenceConcept: { id: 'loinc:synthetic:58410-2' },
        version: 1,
      },
    })

    const issueResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/actions/issue`,
      {
        body: JSON.stringify({
          expectedVersions: { [encounterReference]: '3' },
          input: { expectedDraftVersion: draft.draftVersion },
        }),
        headers: mutationHeaders(),
        method: 'POST',
      },
    )
    expect(issueResponse.status).toBe(200)
    const issued = issueLaboratoryRequestResponseSchema.parse(await issueResponse.json())
    expect(issued).toMatchObject({
      data: {
        request: {
          catalogItemId: publishedService.id,
          laboratoryService: {
            id: publishedService.id,
            reportDefinition: { results: [{ referenceConcept: { code: '6690-2' } }] },
            version: 1,
          },
        },
      },
    })
    expect(runtime.database.driver.prepare(`
      SELECT COUNT(*) AS count FROM hospital_service_catalog
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
      AND json_extract(config_json, '$.laboratoryService.doctorOrderable') = 0
      AND json_extract(config_json, '$.laboratoryService.referenceConcept.system') = 'http://loinc.org'
    `).get()).toEqual({ count: 1 })
  })

  it.each([
    {
      mutate: (databasePath: string) => {
        editReferenceDatabase(databasePath, (database) => {
          database.driver.prepare(`
            INSERT INTO reference_laboratory_panel_member (
              release_id, panel_concept_id, member_concept_id, member_order,
              relationship, source_id, source_locator
            ) VALUES (
              'laboratory-service-reference-v1', 'loinc:synthetic:6690-2',
              'loinc:synthetic:58410-2', 1, 'contains', 'synthetic-loinc',
              'synthetic:test:cycle'
            )
          `).run()
        })
      },
      scenario: 'a cyclic panel graph',
    },
    {
      mutate: (databasePath: string) => {
        editReferenceDatabase(databasePath, (database) => {
          const insert = database.driver.prepare(`
            INSERT INTO reference_laboratory_panel_member (
              release_id, panel_concept_id, member_concept_id, member_order,
              relationship, source_id, source_locator
            ) VALUES (
              'laboratory-service-reference-v1', 'loinc:synthetic:58410-2',
              'loinc:synthetic:6690-2', ?, 'contains', 'synthetic-loinc', ?
            )
          `)
          database.driver.transaction(() => {
            for (let index = 0; index < 512; index += 1) {
              insert.run(index + 2, `synthetic:test:edge-bound:${index}`)
            }
          })()
        })
      },
      scenario: 'a panel graph above the edge bound',
    },
  ])('rejects $scenario before enrichment without partial services', async ({ mutate }) => {
    const provider = new LaboratoryEnrichmentProvider()
    const { administratorCookie, referenceDatabasePath, runtime } = await createRuntime(provider)
    mutate(referenceDatabasePath)

    const queued = await publishCbc(runtime, administratorCookie, 0)
    expect(queued.response.status).toBe(200)
    const jobId = publishLaboratoryServicesResponseSchema.parse(queued.value).data.jobId
    await runtime.dispatchLaboratoryServicePublicationJobs()

    const jobResponse = await runtime.app.request(
      `/api/his/v1/admin/laboratory-services/jobs/${jobId}`,
      { headers: { cookie: administratorCookie } },
    )
    expect(jobResponse.status).toBe(200)
    expect(laboratoryServicePublicationJobSchema.parse(await jobResponse.json())).toMatchObject({
      error: { code: 'LABORATORY_PANEL_INVALID' },
      publishedServiceIds: [],
      status: 'failed',
    })
    expect(provider.calls).toHaveLength(0)
    expect(runtime.database.driver.prepare(`
      SELECT COUNT(*) AS count FROM hospital_service_catalog
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND json_extract(config_json, '$.laboratoryService.referenceConcept.system') = 'http://loinc.org'
    `).get()).toEqual({ count: 0 })
  })

  it('publishes a codeable qualitative Laboratory Service from a nominal LOINC', async () => {
    const provider = new LaboratoryEnrichmentProvider()
    provider.codeable = true
    const { administratorCookie, runtime } = await createRuntime(provider)
    const response = await runtime.app.request(
      '/api/his/v1/admin/laboratory-services/actions/publish',
      {
        body: JSON.stringify({
          input: {
            entries: [{ conceptId: 'loinc:synthetic:94500-6', expectedVersion: 0 }],
          },
        }),
        headers: {
          'content-type': 'application/json',
          cookie: administratorCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(response.status).toBe(200)
    await runtime.dispatchLaboratoryServicePublicationJobs()
    const row = runtime.database.driver.prepare(`
      SELECT config_json FROM hospital_service_catalog
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND code = 'CM-LAB-94500-6'
    `).get() as { config_json: string }
    expect(laboratoryServiceSnapshotSchema.parse(
      JSON.parse(row.config_json).laboratoryService,
    )).toMatchObject({
      reportDefinition: {
        results: [{
          allowedValues: [{ code: 'negative' }, { code: 'positive' }],
          valueType: 'codeable',
        }],
      },
      specimen: { code: 'LP7681-2', display: '尿液' },
    })
  })

  it('rejects a stale candidate version and keeps an invalid republish atomic and idempotent', async () => {
    const provider = new LaboratoryEnrichmentProvider()
    const { administratorCookie, runtime } = await createRuntime(provider)
    const initial = await publishCbc(runtime, administratorCookie, 0)
    expect(initial.response.status).toBe(200)
    await runtime.dispatchLaboratoryServicePublicationJobs()

    const stale = await publishCbc(runtime, administratorCookie, 0)
    expect(stale.response.status).toBe(409)
    expect(runtime.database.driver.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND operation = 'laboratory-service-publication.create' AND outcome = 'failed'
    `).get()).toEqual({ count: 1 })
    provider.misclassifyQuantity = true
    const idempotencyKey = randomUUID()
    const first = await publishCbc(runtime, administratorCookie, 1, idempotencyKey)
    const repeated = await publishCbc(runtime, administratorCookie, 1, idempotencyKey)
    expect(first.response.status).toBe(200)
    expect(repeated.response.status).toBe(200)
    expect(repeated.value).toEqual(first.value)
    const failedJobId = publishLaboratoryServicesResponseSchema.parse(first.value).data.jobId

    await runtime.dispatchLaboratoryServicePublicationJobs()
    expect(laboratoryServicePublicationJobSchema.parse(await (await runtime.app.request(
      `/api/his/v1/admin/laboratory-services/jobs/${failedJobId}`,
      { headers: { cookie: administratorCookie } },
    )).json())).toMatchObject({
      error: { code: 'CATALOG_ENRICHMENT_INVALID' },
      publishedServiceIds: [],
      status: 'failed',
    })
    expect(provider.calls).toHaveLength(2)
    expect(runtime.database.driver.prepare(`
      SELECT COUNT(*) AS count, MAX(version) AS version
      FROM hospital_service_catalog
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND json_extract(config_json, '$.laboratoryService.referenceConcept.system') = 'http://loinc.org'
    `).get()).toEqual({ count: 2, version: 1 })
  })

  it('pins LOINC enrichment when queued and skips model resolution for deterministic publication', async () => {
    const provider = new LaboratoryEnrichmentProvider()
    const routeA = encodeModelRoute({ provider: 'synthetic-a', model: 'same-model' })
    const routeB = encodeModelRoute({ provider: 'synthetic-b', model: 'same-model' })
    let route = routeA
    let resolutions = 0
    provider.resolveModel = async () => { resolutions++; return route }
    const { administratorCookie, runtime } = await createRuntime(provider)
    await publishLaboratoryCnPanel(runtime, administratorCookie)
    expect(resolutions).toBe(0)
    expect(provider.calls).toHaveLength(0)
    expect((await publishCbc(runtime, administratorCookie, 0)).response.status).toBe(200)
    route = routeB
    await runtime.dispatchLaboratoryServicePublicationJobs()
    expect(provider.calls[0]?.model).toBe(routeA)
    expect((await publishCbc(runtime, administratorCookie, 1)).response.status).toBe(200)
    await runtime.dispatchLaboratoryServicePublicationJobs()
    expect(provider.calls[1]?.model).toBe(routeB)
  })

  it('persists a failed publication state when Catalog Enrichment is unavailable', async () => {
    const { administratorCookie, runtime } = await createRuntime()
    const queued = await publishCbc(runtime, administratorCookie, 0)
    expect(queued.response.status).toBe(200)
    const jobId = publishLaboratoryServicesResponseSchema.parse(queued.value).data.jobId

    await runtime.dispatchLaboratoryServicePublicationJobs()
    expect(laboratoryServicePublicationJobSchema.parse(await (await runtime.app.request(
      `/api/his/v1/admin/laboratory-services/jobs/${jobId}`,
      { headers: { cookie: administratorCookie } },
    )).json())).toMatchObject({
      error: { code: 'CATALOG_ENRICHMENT_UNAVAILABLE' },
      status: 'failed',
    })
    expect(laboratoryServiceCandidateSearchSchema.parse(await (await runtime.app.request(
      '/api/his/v1/admin/laboratory-services/candidates?page=1&pageSize=20&sourceDataset=loinc-zh-cn&query=58410-2',
      { headers: { cookie: administratorCookie } },
    )).json())).toMatchObject({
      items: [{
        error: { code: 'CATALOG_ENRICHMENT_UNAVAILABLE' },
        status: 'failed',
        version: 1,
      }],
    })
  })

  describe('cardiology defaults in a fresh Epoch without prepare-pci-data', () => {
    type SyntheticPatient = {
      birthDate: string
      gender: 'female' | 'male'
      observations: Array<{ code: string; unit: string; value: number }>
    }
    type PublishedService = {
      inpatientBilling: { priceFen: number } | undefined
      service: ReturnType<typeof laboratoryServiceSnapshotSchema.parse>
    }
    let directory = ''
    let runtime: Awaited<ReturnType<typeof createClinMeshRuntime>> | undefined
    let nextPatient: SyntheticPatient = { birthDate: '1972-05-14', gender: 'female', observations: [] }
    let investigationModelCalls = 0
    let byCode = new Map<string, PublishedService>()
    const cookies = { admin: '', cashier: '', doctor: '', inpatientDoctor: '', nurse: '', registrar: '', triage: '' }
    const current = () => {
      if (runtime === undefined) throw new Error('cardiology runtime is not ready')
      return runtime
    }
    const service = (code: string) => {
      const entry = byCode.get(code)
      if (entry === undefined) throw new Error(`missing published service ${code}`)
      return entry.service
    }

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'clinmesh-cardiology-lab-defaults-'))
      const databasePath = join(directory, 'cardiology-reference.sqlite')
      const wstSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026'
      const panelSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn'
      const datasetReleaseId = 'laboratory-cn@2026-09-01.r1'
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

      // 编码与单位对齐锁定的 laboratory-cn@2026-09-01.r1：0100401A 为血红蛋白 g/L，0100501A 为红细胞比容 L/L，心肌标志物为 ng/mL。
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
      const artifactJson = `${JSON.stringify({
        concepts: [...tests.map(item => item.concept), ...panels.map(item => item.concept)],
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
        releaseId: 'cardiology-reference-v1',
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
      await runReferenceDatabaseCli(['migrate', '--database', databasePath])
      await runReferenceDatabaseCli(['import', '--database', databasePath, '--manifest', manifestPath])

      const password = `Test-${randomUUID()}-Aa1!`
      runtime = await createClinMeshRuntime({
        activeReferenceReleaseId: 'cardiology-reference-v1',
        authBaseUrl: 'http://localhost',
        authSecret: 'test-auth-secret-with-at-least-32-characters',
        chatCompletionsProvider: {
          completeJson: async (input) => {
            if (input.model !== 'brief-fixture') investigationModelCalls += 1
            return {
              content: JSON.stringify({
                chiefComplaint: '活动后胸闷三天',
                knownHistorySummary: '高血压五年。',
                medicationMemory: '氨氯地平每日一片。',
                openingStatement: '医生您好，我这几天走路胸闷。',
                persona: { attitude: '配合', character: '温和', healthLiteracy: '一般', speechStyle: '清晰' },
                symptomExperience: '爬楼时胸口发紧。',
              }),
              model: 'brief-fixture',
            }
          },
        },
        cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
        databasePath: join(directory, 'operational.sqlite'),
        demoPassword: password,
        investigationModel: 'unexpected-investigation-model',
        migrationMode: 'apply',
        patientPersonaModel: 'brief-fixture',
        referenceDatabasePath: databasePath,
        syntheaProvider: {
          capabilities: async () => ({ available: true, maxPopulation: 1, modules: [], providerId: 'synthea', providerName: 'Synthea' }),
          generate: async () => {
            const bundle = {
              entry: [
                { fullUrl: 'urn:uuid:patient', resource: { birthDate: nextPatient.birthDate, gender: nextPatient.gender, id: 'patient', name: [{ text: '合成心内患者' }], resourceType: 'Patient' } },
                { fullUrl: 'urn:uuid:encounter', resource: { id: 'encounter', period: { end: '2026-06-01T10:30:00+08:00', start: '2026-06-01T10:00:00+08:00' }, reasonCode: [{ text: '胸闷' }], resourceType: 'Encounter', status: 'finished', subject: { reference: 'urn:uuid:patient' } } },
                { fullUrl: 'urn:uuid:condition', resource: { code: { coding: [{ code: '53741008', display: '冠状动脉粥样硬化性心脏病', system: 'http://snomed.info/sct' }] }, encounter: { reference: 'urn:uuid:encounter' }, id: 'condition', recordedDate: '2026-06-01T10:05:00+08:00', resourceType: 'Condition', subject: { reference: 'urn:uuid:patient' } } },
                ...nextPatient.observations.map((obs, idx) => ({
                  fullUrl: `urn:uuid:obs-${idx}`,
                  resource: {
                    code: { coding: [{ code: obs.code, system: 'http://loinc.org' }] },
                    effectiveDateTime: '2026-06-01T10:15:00+08:00',
                    encounter: { reference: 'urn:uuid:encounter' },
                    id: `obs-${idx}`,
                    resourceType: 'Observation',
                    status: 'final',
                    subject: { reference: 'urn:uuid:patient' },
                    valueQuantity: { code: obs.unit, system: 'http://unitsofmeasure.org', unit: obs.unit, value: obs.value },
                  },
                })),
              ],
              resourceType: 'Bundle',
              type: 'collection',
            }
            return { kind: 'synthea-r4', sources: [{ format: 'fhir-r4-bundle', hash: sourceArtifactHash(bundle), patientId: 'patient', raw: bundle }] }
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

      // 重置进入全新 epoch-2，且不调用 prepare-pci-data。
      const currentScenario = scenarioStateSchema.parse(await (await ready.app.request(
        '/api/sim/v1/scenario-runs/current',
        { headers: { cookie: cookies.admin } },
      )).json())
      const resetResponse = await postJson(
        `/api/sim/v1/scenario-runs/${currentScenario.scenarioRunId}/actions/reset`,
        cookies.admin,
        {},
      )
      expect(resetResponse.status).toBe(200)
      expect(scenarioCommandResponseSchema.parse(await resetResponse.json()).data.epoch).toBe('epoch-2')

      const activeServices = ready.database.driver.prepare(`
        SELECT config_json FROM hospital_service_catalog
        WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2' AND active = 1
          AND json_extract(config_json, '$.laboratoryService.doctorOrderable') = 1
      `).all() as Array<{ config_json: string }>
      byCode = new Map(activeServices.map((row) => {
        const parsed = JSON.parse(row.config_json) as { inpatientInvestigationBilling?: { priceFen: number }; laboratoryService: unknown }
        const published = laboratoryServiceSnapshotSchema.parse(parsed.laboratoryService)
        return [published.referenceConcept.code, { inpatientBilling: parsed.inpatientInvestigationBilling, service: published }] as const
      }))
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

    async function materializeOutpatientVisit(patient: SyntheticPatient) {
      nextPatient = patient
      const ready = current()
      expect((await postJson('/api/sim/v1/scenario-generation-jobs', cookies.admin, {
        name: '合成心内门诊病例',
        population: { age: { maximum: 75, minimum: 1 }, count: 1, gender: 'any' },
        providerId: 'synthea',
        seeds: { clinical: Math.floor(Math.random() * 100_000) + 1, population: Math.floor(Math.random() * 100_000) + 1 },
        timeRange: { end: '2026-08-01', start: '2020-01-01' },
        timeZone: 'Asia/Shanghai',
      })).status).toBe(200)
      const generated = await ready.scenarioData.processNextGenerationJob()
      const caseId = generated!.caseIds[0]!
      expect((await postJson(`/api/sim/v1/synthetic-cases/${caseId}/patient-persona-jobs`, cookies.admin, {})).status).toBe(200)
      expect((await ready.patientPersona.processNext())?.status).toBe('succeeded')
      const syntheticCase = syntheticCaseInstanceSchema.parse(await (await ready.app.request(
        `/api/sim/v1/synthetic-cases/${caseId}`,
        { headers: { cookie: cookies.admin } },
      )).json())
      const registration = registrationCatalogSchema.parse(await (await ready.app.request(
        '/api/his/v1/catalogs/registration',
        { headers: { cookie: cookies.admin } },
      )).json())
      const started = commandResponseSchema(startSyntheticCaseResultSchema).parse(await (await postJson(
        `/api/his/v1/synthetic-cases/${caseId}/actions/start-outpatient-visit`,
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
            bloodPressure: { diastolicMmHg: 80, systolicMmHg: 132 },
            chiefComplaint: '活动后胸闷三天',
            oxygenSaturationPct: 98,
            pulseBpm: 78,
            respirationBpm: 18,
            temperatureC: 36.5,
          },
        },
      )).json()).data
      expect((await postJson(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, cookies.doctor, {
        expectedVersions: { [`Encounter/${started.encounterId}`]: '2', [`Task/${triage.doctorTaskId}`]: '1' },
        input: {},
      })).status).toBe(200)
      return { ...started, draftVersion: 0 }
    }

    async function orderPayAndDispatch(visit: { draftVersion: number; encounterId: string; outpatientCaseId: string }, serviceId: string) {
      const draftResponse = await postJson(`/api/his/v1/encounters/${visit.encounterId}/laboratory-request/draft`, cookies.doctor, {
        expectedVersions: { [`Encounter/${visit.encounterId}`]: '3' },
        input: { catalogItemId: serviceId, expectedDraftVersion: visit.draftVersion, indicationCode: 'clinical-evaluation' },
      }, 'PUT')
      expect(draftResponse.status, await draftResponse.clone().text()).toBe(200)
      const draft = laboratoryRequestDraftResponseSchema.parse(await draftResponse.json()).data
      const issueResponse = await postJson(`/api/his/v1/encounters/${visit.encounterId}/laboratory-request/actions/issue`, cookies.doctor, {
        expectedVersions: { [`Encounter/${visit.encounterId}`]: '3' },
        input: { expectedDraftVersion: draft.draftVersion },
      })
      expect(issueResponse.status, await issueResponse.clone().text()).toBe(200)
      const issued = issueLaboratoryRequestResponseSchema.parse(await issueResponse.json()).data
      const chargeItemId = issued.request.billing!.chargeItemId
      const preview = paymentPreviewResponseSchema.parse(await (await postJson('/api/his/v1/payments/actions/preview', cookies.cashier, {
        expectedVersions: { [`ChargeItem/${chargeItemId}`]: '1' },
        input: { caseId: visit.outpatientCaseId, category: 'laboratory', chargeItemId, simulatorRule: 'success' },
      })).json()).data
      expect(paymentResponseSchema.parse(await (await postJson(
        `/api/his/v1/payments/${preview.previewId}/actions/confirm`,
        cookies.cashier,
        {
          expectedVersions: { [`ChargeItem/${chargeItemId}`]: String(preview.chargeVersion) },
          input: { commitToken: preview.commitToken },
        },
      )).json()).data.outcome).toBe('success')
      await current().dispatchPending()
      visit.draftVersion = issued.draftVersion
      return issued.request.id
    }

    async function doctorCase(caseId: string) {
      return doctorCaseDetailSchema.parse(await (await current().app.request(
        `/api/his/v1/doctor/cases/${caseId}`,
        { headers: { cookie: cookies.doctor } },
      )).json())
    }

    it('publishes hs-cTnI, aligns CN-LAB-CARDIAC and prices every required panel and item for outpatient and inpatient use', async () => {
      expect(service('2100404B')).toMatchObject({
        doctorOrderable: true,
        nameZh: '高敏心肌肌钙蛋白I测定',
        outpatientBilling: expect.objectContaining({ priceFen: 8_000 }),
        reportDefinition: {
          results: [expect.objectContaining({
            alternateCodings: expect.arrayContaining([{ code: '89579-7', system: 'http://loinc.org', version: '2.83' }]),
            criticalMaximum: 100,
            unit: { code: 'ng/L', display: 'ng/L', system: 'http://unitsofmeasure.org' },
          })],
        },
        specimen: expect.objectContaining({ display: '血清、血浆' }),
      })
      expect(byCode.get('2100404B')?.inpatientBilling?.priceFen).toBe(8_000)
      expect(service('CN-LAB-CARDIAC').reportDefinition.results.map(result => result.referenceConcept.code)).toContain('2100404B')
      expect(service('CN-LAB-CBC-5DIFF').reportDefinition.results.find(result => result.referenceConcept.code === '0100401A'))
        .toMatchObject({ criticalMaximum: 200, criticalMinimum: 60, unit: expect.objectContaining({ code: 'g/L' }) })

      const requiredPricedCodes = [
        'CN-LAB-CBC-5DIFF', '0100101A', '0100201A', '0100301A', '0100401A', '0100501A', '0100601A', '0100701A', '0100801A',
        'CN-LAB-CARDIAC', '2100404B', '2100404A', '2100704A', '2100104A', '2100304A', '2100504A', '2100604A',
        'CN-LAB-LIPIDS', '2000104A', '2000204A', '2000304A', '2000404A', '2000604A', '2000704A',
        'CN-LAB-RENAL', '1700404A', '1700204A', '1700304A', '1101204A',
        'CN-LAB-ELECTROLYTES', '1400605A', '1400205A', '1400505A', '1400705A', '1400305A', '1400404A',
        'CN-LAB-HBA1C', '1100301A',
        'CN-LAB-COAGULATION', '0501703A',
      ]
      for (const code of requiredPricedCodes) {
        expect(service(code).outpatientBilling?.priceFen, `missing outpatient price for ${code}`).toBeGreaterThan(0)
        expect(byCode.get(code)?.inpatientBilling?.priceFen, `missing inpatient price for ${code}`).toBeGreaterThan(0)
      }

      const inpatientCatalog = inpatientInvestigationCatalogSchema.parse(await (await current().app.request(
        '/api/his/v1/inpatient/investigation-catalog',
        { headers: { cookie: cookies.inpatientDoctor } },
      )).json())
      for (const code of ['CN-LAB-CBC-5DIFF', 'CN-LAB-CARDIAC', '2100404B', '2100704A', 'CN-LAB-LIPIDS', 'CN-LAB-RENAL', 'CN-LAB-ELECTROLYTES', '1100301A', '0501703A']) {
        expect(inpatientCatalog.items.find(item => item.id === service(code).id)).toMatchObject({ available: true, kind: 'laboratory' })
      }
    })

    it('resolves an adult outpatient without Case Truth from the Adult Reference Baseline with non-critical flags and no model call', async () => {
      const visit = await materializeOutpatientVisit({ birthDate: '1972-05-14', gender: 'female', observations: [] })
      const modelCallsBefore = investigationModelCalls
      for (const code of ['CN-LAB-CARDIAC', 'CN-LAB-RENAL', 'CN-LAB-CBC-5DIFF']) await orderPayAndDispatch(visit, service(code).id)
      expect(investigationModelCalls).toBe(modelCallsBefore)
      const detail = await doctorCase(visit.outpatientCaseId)
      const report = (code: string) => detail.laboratoryRequests?.requests.find(request => request.catalogItemId === service(code).id)?.report
      expect(report('CN-LAB-CARDIAC')?.results.find(item => item.code === '2100404B')).toMatchObject({
        critical: false,
        interpretation: 'normal',
        referenceRange: { high: 16 },
      })
      expect(report('CN-LAB-RENAL')?.results.every(item => 'critical' in item ? item.critical !== true : true)).toBe(true)
      expect(report('CN-LAB-CBC-5DIFF')?.results.map(item => item.code)).toEqual(expect.arrayContaining(['0100401A', '0100501A']))
    })

    it('rejects an adult-only baseline request for a pediatric outpatient', async () => {
      const visit = await materializeOutpatientVisit({ birthDate: '2014-06-01', gender: 'male', observations: [] })
      const response = await postJson(`/api/his/v1/encounters/${visit.encounterId}/laboratory-request/draft`, cookies.doctor, {
        expectedVersions: { [`Encounter/${visit.encounterId}`]: '3' },
        input: { catalogItemId: service('2100404B').id, expectedDraftVersion: 0, indicationCode: 'clinical-evaluation' },
      }, 'PUT')
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: { code: 'LABORATORY_ADULT_REFERENCE_NOT_APPLICABLE' } })
    })

    it('converts Case Truth units into catalog units and flags critical values', async () => {
      const visit = await materializeOutpatientVisit({
        birthDate: '1965-04-12',
        gender: 'male',
        observations: [
          { code: '89579-7', unit: 'pg/mL', value: 280 },
          { code: '33762-6', unit: 'pg/mL', value: 6_200 },
          { code: '2160-0', unit: 'mg/dL', value: 0.9 },
          { code: '2823-3', unit: 'meq/L', value: 6.5 },
          { code: '48065-7', unit: 'ng/mL{FEU}', value: 6_200 },
          { code: '4544-3', unit: '%', value: 42 },
        ],
      })
      const modelCallsBefore = investigationModelCalls
      for (const code of ['2100404B', '2100704A', '1700404A', '1400605A', '0501703A', '0100501A']) await orderPayAndDispatch(visit, service(code).id)
      expect(investigationModelCalls).toBe(modelCallsBefore)
      const detail = await doctorCase(visit.outpatientCaseId)
      const result = (code: string) => detail.laboratoryRequests?.requests
        .find(request => request.catalogItemId === service(code).id)?.report?.results.find(item => item.code === code)
      expect(result('2100404B')).toMatchObject({ critical: true, interpretation: 'high', referenceRange: { high: 34 }, value: 280 })
      expect(result('2100704A')).toMatchObject({ critical: true, interpretation: 'high', value: 6_200 })
      expect(result('1700404A')).toMatchObject({ critical: false, interpretation: 'normal', value: 79.56 })
      expect(result('1400605A')).toMatchObject({ critical: true, interpretation: 'high', value: 6.5 })
      expect(result('0501703A')).toMatchObject({ critical: true, interpretation: 'high', value: 6.2 })
      expect(result('0100501A')).toMatchObject({ critical: false, interpretation: 'normal', value: 0.42 })
    })

    it('converts lipid Case Truth from mg/dL into mmol/L', async () => {
      const visit = await materializeOutpatientVisit({
        birthDate: '1965-04-12',
        gender: 'male',
        observations: [
          { code: '2093-3', unit: 'mg/dL', value: 193.35 },
          { code: '2571-8', unit: 'mg/dL', value: 177.14 },
        ],
      })
      await orderPayAndDispatch(visit, service('CN-LAB-LIPIDS').id)
      const detail = await doctorCase(visit.outpatientCaseId)
      const results = detail.laboratoryRequests?.requests.find(request => request.catalogItemId === service('CN-LAB-LIPIDS').id)?.report?.results
      expect(results?.find(item => item.code === '2000104A')).toMatchObject({ interpretation: 'normal', value: 5 })
      expect(results?.find(item => item.code === '2000204A')).toMatchObject({ interpretation: 'high', value: 2 })
    })

    it('recomputes the critical flag when a LIS report correction returns a value to normal', async () => {
      const visit = await materializeOutpatientVisit({
        birthDate: '1965-04-12',
        gender: 'male',
        observations: [{ code: '89579-7', unit: 'pg/mL', value: 280 }],
      })
      const requestId = await orderPayAndDispatch(visit, service('2100404B').id)
      const request = (await doctorCase(visit.outpatientCaseId)).laboratoryRequests!.requests.find(item => item.id === requestId)!
      expect(request.report?.results[0]).toMatchObject({ critical: true })
      const corrected = await postJson(
        `/api/his/v1/laboratory-requests/${request.id}/reports/${request.report!.diagnosticReportId}/actions/correct`,
        cookies.admin,
        {
          expectedVersions: { [`DiagnosticReport/${request.report!.diagnosticReportId}`]: request.report!.diagnosticReportVersion },
          input: {
            conclusion: '标本复测后高敏肌钙蛋白I正常。',
            expectedRequestVersion: request.version,
            reason: '溶血干扰复测更正',
            results: [{ code: '2100404B', value: 12 }],
          },
        },
      )
      expect(corrected.status, await corrected.clone().text()).toBe(200)
      correctLaboratoryReportResponseSchema.parse(await corrected.json())
      expect((await doctorCase(visit.outpatientCaseId)).laboratoryRequests?.requests.find(item => item.id === requestId)?.report?.results[0])
        .toMatchObject({ critical: false, interpretation: 'normal', value: 12 })
    })

    it('issues, sends and reports a default-priced inpatient cardiac panel with its synthetic inpatient charge', async () => {
      const ready = current()
      // 住院检验结果来自同一合成病例来源，因此由合成门诊就诊患者办理入院。
      const visit = await materializeOutpatientVisit({ birthDate: '1968-03-02', gender: 'male', observations: [] })
      const patient = fhirResourceSchema.parse(await (await ready.app.request(
        `/fhir/R5/Patient/${visit.patientId}`,
        { headers: { cookie: cookies.registrar } },
      )).json())
      const registered = inpatientCommandResponseSchema.parse(await (await postJson('/api/his/v1/inpatient/admissions', cookies.registrar, {
        input: { admissionRoute: 'direct', depositFen: 100_000, expectedEpoch: 'epoch-2', patientId: patient.id, patientVersion: patient.meta!.versionId, wardId: 'ward-general' },
      })).json()).data.admission
      const path = `/api/his/v1/inpatient/admissions/${registered.id}`
      const received = inpatientCommandResponseSchema.parse(await (await postJson(`${path}/receive`, cookies.nurse, {
        input: { bedId: 'bed-general-1', encounterVersion: registered.versionId },
      })).json()).data.admission
      const catalog = inpatientInvestigationCatalogSchema.parse(await (await ready.app.request(
        '/api/his/v1/inpatient/investigation-catalog',
        { headers: { cookie: cookies.inpatientDoctor } },
      )).json())
      const cardiac = catalog.items.find(item => item.id === service('CN-LAB-CARDIAC').id)!
      const issuedResponse = await postJson(`${path}/investigations/issue`, cookies.inpatientDoctor, {
        input: {
          catalogVersion: cardiac.version,
          encounterVersion: received.versionId,
          selection: { catalogItemId: cardiac.id, indicationCode: cardiac.indicationCodes[0]!, kind: 'laboratory' },
        },
      })
      expect(issuedResponse.status, await issuedResponse.clone().text()).toBe(200)
      const request = inpatientInvestigationResponseSchema.parse(await issuedResponse.json()).data.laboratoryRequests
        .find(item => item.catalogItemId === cardiac.id)!
      const sentResponse = await postJson(`${path}/investigations/send`, cookies.nurse, {
        input: { expectedRequestVersion: request.version, requestId: request.id, serviceRequestVersion: request.serviceRequestVersion, taskVersion: request.taskVersion },
      })
      expect(sentResponse.status, await sentResponse.clone().text()).toBe(200)
      await ready.dispatchPending()
      const reported = inpatientInvestigationsSchema.parse(await (await ready.app.request(
        `${path}/investigations`,
        { headers: { cookie: cookies.nurse } },
      )).json()).laboratoryRequests.find(item => item.id === request.id)
      expect(reported).toMatchObject({ status: 'reported' })
      expect(reported?.report?.results.find(item => item.code === '2100404B')).toMatchObject({ critical: false, interpretation: 'normal' })
      const charges = inpatientChargesSchema.parse(await (await ready.app.request(
        `${path}/charges`,
        { headers: { cookie: cookies.cashier } },
      )).json())
      expect(charges.charges.map(charge => charge.amountFen)).toContain(byCode.get('CN-LAB-CARDIAC')!.inpatientBilling!.priceFen)
    })
  })
})
