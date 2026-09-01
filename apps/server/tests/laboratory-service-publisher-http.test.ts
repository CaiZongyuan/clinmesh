import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  caseLaboratoryCatalogSearchSchema,
  doctorCaseDetailSchema,
  issueLaboratoryRequestResponseSchema,
  laboratoryServiceCandidateSearchSchema,
  laboratoryServicePublicationJobSchema,
  laboratoryServiceSnapshotSchema,
  laboratoryRequestDraftResponseSchema,
  publishLaboratoryServicesResponseSchema,
  startVirtualPatientResponseSchema,
  virtualPatientListSchema,
} from '@clinmesh/contracts/his'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  JsonChatCompletionInput,
  JsonChatCompletionsProvider,
} from '../src/infrastructure/ai/openai-chat-completions.ts'
import { openReferenceDatabase } from '../src/infrastructure/sqlite/reference-database.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'

class LaboratoryEnrichmentProvider implements JsonChatCompletionsProvider {
  calls: JsonChatCompletionInput[] = []
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

  async function createReferenceDatabase(directory: string): Promise<string> {
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
        id: 'laboratory-panel-cn:2026-09-01:CN-LAB-CBC',
        sourceLocator: 'synthetic:laboratory-cn:panel:CN-LAB-CBC',
        status: 'active',
        system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn',
        version: '2026-09-01',
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
        datasetReleaseId: 'laboratory-cn@2026-09-01.r1',
        healthyStrategy: 'uniform',
        kind: 'laboratory-cn-test',
        precision: 1,
        resultKind: 'quantity',
        scale: '定量',
        sourceLocator: 'synthetic:laboratory-cn:test:0100101A',
        sourceVersion: '2026-09-01',
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
        datasetReleaseId: 'laboratory-cn@2026-09-01.r1',
        healthyStrategy: 'uniform',
        kind: 'laboratory-cn-test',
        precision: 1,
        resultKind: 'quantity',
        scale: '定量',
        sourceLocator: 'synthetic:laboratory-cn:test:0100201A',
        sourceVersion: '2026-09-01',
        specimen: '全血',
        unit: {
          code: '10*12/L',
          display: '×10^12/L',
          system: 'http://unitsofmeasure.org',
        },
      }, {
        conceptId: 'laboratory-panel-cn:2026-09-01:CN-LAB-CBC',
        datasetReleaseId: 'laboratory-cn@2026-09-01.r1',
        kind: 'laboratory-cn-panel',
        notes: '合成多叶子 panel',
        sourceLocation: 'fixture/panel/1',
        sourceLocator: 'synthetic:laboratory-cn:panel:CN-LAB-CBC',
        sourceType: 'project-authored',
        sourceVersion: '2026-09-01',
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
        panelConceptId: 'laboratory-panel-cn:2026-09-01:CN-LAB-CBC',
        relationship: 'contains',
        sourceLocator: 'synthetic:laboratory-cn:panel:CN-LAB-CBC:1',
      }, {
        memberConceptId: 'wst-886:2026:0100201A',
        memberOrder: 2,
        panelConceptId: 'laboratory-panel-cn:2026-09-01:CN-LAB-CBC',
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
      releaseId: 'laboratory-service-reference-v1',
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
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      activeReferenceReleaseId: 'laboratory-service-reference-v1',
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      ...(provider === undefined
        ? {}
        : {
            catalogEnrichmentModel: 'catalog-test-model',
            chatCompletionsProvider: provider,
          }),
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'operational.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      referenceDatabasePath,
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    return {
      administratorCookie: await signIn(runtime, password, 'admin@demo.clinmesh.local'),
      doctorCookie: await signIn(runtime, password, 'doctor@demo.clinmesh.local'),
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

  it('paginates orderable Laboratory Service candidates', async () => {
    const { administratorCookie, runtime } = await createRuntime()
    const candidatePages = await Promise.all([1, 2].map(async page => (
      laboratoryServiceCandidateSearchSchema.parse(await (await runtime.app.request(
        `/api/his/v1/admin/laboratory-services/candidates?page=${page}&pageSize=1`,
        { headers: { cookie: administratorCookie } },
      )).json())
    )))
    expect(candidatePages.map(page => page.total)).toEqual([4, 4])
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
      publicationPolicyVersion: 'clinmesh-laboratory-defaults-v1',
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
      ORDER BY service_id
    `).all() as Array<{ service_id: string; version: number }>
    expect(republishedRows).toHaveLength(3)
    expect(republishedRows.find(row => row.service_id === rootService.id)).toMatchObject({
      service_id: rootService.id,
      version: 2,
    })

  })

  it('publishes an enriched panel atomically and exposes only its orderable root to doctors', async () => {
    const provider = new LaboratoryEnrichmentProvider()
    const { administratorCookie, doctorCookie, runtime } = await createRuntime(provider)

    const candidatesResponse = await runtime.app.request(
      '/api/his/v1/admin/laboratory-services/candidates?page=1&pageSize=20&query=58410-2',
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

    const virtualPatients = virtualPatientListSchema.parse(await (await runtime.app.request(
      '/api/his/v1/doctor/virtual-patients',
      { headers: { cookie: doctorCookie } },
    )).json())
    const patient = virtualPatients.items[0]!
    const started = startVirtualPatientResponseSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/virtual-patients/${patient.id}/actions/start`,
      {
        body: JSON.stringify({ expectedVersions: {}, input: { expectedVersion: patient.version } }),
        headers: {
          'content-type': 'application/json',
          cookie: doctorCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )).json()).data
    const doctorCatalogResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}/reference-catalogs/laboratory?page=1&pageSize=20`,
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
          expectedVersions: { [encounterReference]: '1' },
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
          expectedVersions: { [encounterReference]: '1' },
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
          expectedVersions: { [encounterReference]: '1' },
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
        AND json_extract(config_json, '$.laboratoryService.id') IS NOT NULL
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
        AND json_extract(config_json, '$.laboratoryService.id') IS NOT NULL
    `).get()).toEqual({ count: 2, version: 1 })
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
      '/api/his/v1/admin/laboratory-services/candidates?page=1&pageSize=20&query=58410-2',
      { headers: { cookie: administratorCookie } },
    )).json())).toMatchObject({
      items: [{
        error: { code: 'CATALOG_ENRICHMENT_UNAVAILABLE' },
        status: 'failed',
        version: 1,
      }],
    })
  })
})
