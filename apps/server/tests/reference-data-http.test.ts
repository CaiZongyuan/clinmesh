import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  referenceDiagnosisCatalogSearchSchema,
  referenceDataProvenanceSchema,
  referenceDataReleaseListSchema,
  referenceLaboratoryCatalogSearchSchema,
  referenceMedicationCatalogSearchSchema,
} from '@clinmesh/contracts/reference-data'
import {
  scenarioDatasetSchema,
  syntheticPatientProfileListSchema,
  syntheticPatientProfileDetailSchema,
} from '@clinmesh/contracts/scenario'
import {
  commandResponseSchema,
  confirmDiagnosisResponseSchema,
  diagnosisDraftResponseSchema,
  doctorCaseDetailSchema,
  issueLaboratoryRequestResponseSchema,
  issuePrescriptionResponseSchema,
  laboratoryRequestDraftResponseSchema,
  prescriptionDraftResponseSchema,
  scenarioStateSchema,
  serviceCatalogSearchSchema,
  startVirtualPatientResponseSchema,
  virtualPatientListSchema,
} from '@clinmesh/contracts/his'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { openReferenceDatabase } from '../src/infrastructure/sqlite/reference-database.ts'
import { canonicalJsonHash } from '../src/application/scenario-data/canonical-json.ts'
import { createReferenceHospitalSelection } from '../src/application/reference-hospital-selection.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import {
  syntheticNhcMedicalServiceSnapshot,
  syntheticWstValueSetSnapshot,
} from '../src/application/scenario-data/medical-service-snapshot.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'

describe('Reference Data HTTP contract', () => {
  const runtimes: Array<Awaited<ReturnType<typeof createClinMeshRuntime>>> = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
  })

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

  async function createRuntime(input: {
    activeReferenceReleaseId?: string
    databasePath?: string
    migrationMode?: 'apply' | 'verify'
    password?: string
    referenceDatabasePath?: string
    referenceSelection?: ReturnType<typeof createReferenceHospitalSelection>
  } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-http-'))
    temporaryDirectories.push(directory)
    const password = input.password ?? `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      ...(input.activeReferenceReleaseId === undefined
        ? {}
        : { activeReferenceReleaseId: input.activeReferenceReleaseId }),
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: input.databasePath ?? join(directory, 'operational.sqlite'),
      demoPassword: password,
      migrationMode: input.migrationMode ?? 'apply',
      ...(input.referenceDatabasePath === undefined
        ? {}
        : { referenceDatabasePath: input.referenceDatabasePath }),
      ...(input.referenceSelection === undefined
        ? {}
        : { referenceSelection: input.referenceSelection }),
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    return { password, runtime }
  }

  async function addUpdatedReferenceRelease(directory: string, databasePath: string): Promise<void> {
    const artifact = `${JSON.stringify({
      concepts: [{
        code: 'I10',
        display: '新版原发性高血压',
        domain: 'diagnosis',
        id: 'diagnosis:hypertension',
        sourceLocator: 'updated[0]',
        status: 'active',
        system: 'urn:clinmesh:reference:nhsa-diagnosis',
        version: '2023',
      }, {
        code: '58410-2',
        display: '新版血常规组合',
        domain: 'laboratory',
        id: 'laboratory:cbc-panel',
        sourceLocator: 'updated[1]',
        status: 'active',
        system: 'http://loinc.org',
        version: '2.84',
      }],
      medicationProducts: syntheticNhsaMedicationProductSnapshot.map((product, index) => (
        index === 0 ? { ...product, genericName: `新版${product.genericName}` } : product
      )),
      schemaVersion: '1',
      services: syntheticNhcMedicalServiceSnapshot,
      valueSetEntries: syntheticWstValueSetSnapshot,
    })}\n`
    const artifactPath = join(directory, 'updated-reference.json')
    const manifestPath = join(directory, 'updated-release.json')
    await writeFile(artifactPath, artifact)
    await writeFile(manifestPath, `${JSON.stringify({
      createdAt: '2026-08-29T00:00:00.000Z',
      releaseId: 'reference-http-test-v2',
      schemaVersion: '1',
      sources: [{
        acquisitionMethod: 'generated',
        artifactPath: 'updated-reference.json',
        checksum: createHash('sha256').update(artifact).digest('hex'),
        licenseId: 'CC0-1.0',
        retrievedAt: '2026-08-29T00:00:00.000Z',
        sourceId: 'synthetic-updated-reference',
        sourceUrl: 'https://example.test/reference/synthetic-updated',
        upstreamVersion: 'synthetic-2026-v2',
      }],
    })}\n`)
    await runReferenceDatabaseCli([
      'import', '--database', databasePath, '--manifest', manifestPath,
    ])
  }

  async function createReferenceDatabase(directory: string): Promise<string> {
    const databasePath = join(directory, 'reference.sqlite')
    const artifactJson = `${JSON.stringify({
      concepts: [{
        code: 'R50.900',
        display: '发热',
        domain: 'diagnosis',
        id: 'diagnosis:fever',
        sourceLocator: 'concepts[0]',
        status: 'active',
        system: 'urn:clinmesh:reference:nhsa-diagnosis',
        version: '2022',
      }, {
        code: 'I10',
        display: '原发性高血压',
        domain: 'diagnosis',
        id: 'diagnosis:hypertension',
        sourceLocator: 'concepts[1]',
        status: 'active',
        system: 'urn:clinmesh:reference:nhsa-diagnosis',
        version: '2022',
      }, {
        code: '8310-5',
        display: '体温',
        domain: 'laboratory',
        id: 'laboratory:body-temperature',
        sourceLocator: 'concepts[2]',
        status: 'active',
        system: 'http://loinc.org',
        version: '2.83',
      }, {
        code: '58410-2',
        display: '血常规组合',
        domain: 'laboratory',
        id: 'laboratory:cbc-panel',
        sourceLocator: 'concepts[3]',
        status: 'active',
        system: 'http://loinc.org',
        version: '2.83',
      }, ...Array.from({ length: 120 }, (_, index) => ({
        code: `Z${String(index).padStart(3, '0')}`,
        display: `目录诊断 ${String(index).padStart(3, '0')}`,
        domain: 'diagnosis',
        id: `diagnosis:catalog-${String(index).padStart(3, '0')}`,
        sourceLocator: `concepts[${index + 4}]`,
        status: 'active',
        system: 'urn:clinmesh:reference:nhsa-diagnosis',
        version: '2022',
      }))],
      medicationProducts: syntheticNhsaMedicationProductSnapshot,
      schemaVersion: '1',
      services: syntheticNhcMedicalServiceSnapshot,
      valueSetEntries: syntheticWstValueSetSnapshot,
    })}\n`
    const checksum = createHash('sha256').update(artifactJson).digest('hex')
    await writeFile(join(directory, 'concepts.json'), artifactJson)
    await writeFile(join(directory, 'release.json'), `${JSON.stringify({
      createdAt: '2026-08-28T00:00:00.000Z',
      releaseId: 'reference-http-test-v1',
      schemaVersion: '1',
      sources: [{
        acquisitionMethod: 'bundled-fixture',
        artifactPath: 'concepts.json',
        checksum,
        licenseId: 'CC0-1.0',
        publishedAt: '2026-08-28',
        retrievedAt: '2026-08-28T00:00:00.000Z',
        sourceId: 'synthetic-diagnosis',
        sourceUrl: 'https://example.test/reference/synthetic-diagnosis',
        upstreamVersion: 'synthetic-2026',
      }],
    })}\n`)
    await runReferenceDatabaseCli(['migrate', '--database', databasePath])
    await runReferenceDatabaseCli([
      'import', '--database', databasePath, '--manifest', join(directory, 'release.json'),
    ])
    return databasePath
  }

  it('shows the configured release to administrators and rejects ordinary roles', async () => {
    const referenceDirectory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-source-'))
    temporaryDirectories.push(referenceDirectory)
    const referenceDatabasePath = await createReferenceDatabase(referenceDirectory)
    const searchDatabase = openReferenceDatabase({
      busyTimeoutMs: 5_000,
      databasePath: referenceDatabasePath,
      readonly: true,
    })
    const queryPlan = z.array(z.object({ detail: z.string() }).passthrough()).parse(
      searchDatabase.driver.prepare(`
        EXPLAIN QUERY PLAN
        SELECT reference_concept.concept_id
        FROM reference_concept
        JOIN reference_concept_fts
          ON reference_concept_fts.rowid = reference_concept.rowid
        WHERE reference_concept.release_id = ?
          AND reference_concept.domain = 'diagnosis'
          AND reference_concept_fts MATCH ?
        LIMIT 20
      `).all('reference-http-test-v1', '"目录诊断"'),
    )
    expect(queryPlan.some(row => /VIRTUAL TABLE INDEX/i.test(row.detail))).toBe(true)
    searchDatabase.close()
    const { password, runtime } = await createRuntime({
      activeReferenceReleaseId: 'reference-http-test-v1',
      referenceDatabasePath,
    })
    const administratorCookie = await signIn(runtime, password, 'admin@demo.clinmesh.local')
    const doctorCookie = await signIn(runtime, password, 'doctor@demo.clinmesh.local')

    const administratorResponse = await runtime.app.request('/api/sim/v1/reference-data/releases', {
      headers: { cookie: administratorCookie },
    })
    expect(administratorResponse.status).toBe(200)
    expect(referenceDataReleaseListSchema.parse(await administratorResponse.json())).toMatchObject({
      items: [{ conceptCount: 124, releaseId: 'reference-http-test-v1', sourceCount: 1 }],
    })

    const doctorResponse = await runtime.app.request('/api/sim/v1/reference-data/releases', {
      headers: { cookie: doctorCookie },
    })
    expect(doctorResponse.status).toBe(403)
  })

  it('searches the current diagnosis, medication, and laboratory catalogs with bounded pages', async () => {
    const referenceDirectory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-search-'))
    temporaryDirectories.push(referenceDirectory)
    const referenceDatabasePath = await createReferenceDatabase(referenceDirectory)
    const { password, runtime } = await createRuntime({ referenceDatabasePath })
    const doctorCookie = await signIn(runtime, password, 'doctor@demo.clinmesh.local')

    const diagnosesResponse = await runtime.app.request(
      '/api/his/v1/reference-catalogs/diagnoses?page=1&pageSize=1&query=%E5%8E%9F%E5%8F%91%E6%80%A7',
      { headers: { cookie: doctorCookie } },
    )
    if (diagnosesResponse.status !== 200) {
      throw new Error(`Diagnosis catalog search failed: ${await diagnosesResponse.text()}`)
    }
    expect(referenceDiagnosisCatalogSearchSchema.parse(await diagnosesResponse.json())).toEqual({
      items: [{
        code: 'I10',
        display: '原发性高血压',
        domain: 'diagnosis',
        id: 'diagnosis:hypertension',
        sourceLocator: 'concepts[1]',
        status: 'active',
        system: 'urn:clinmesh:reference:nhsa-diagnosis',
        version: '2022',
      }],
      page: 1,
      pageSize: 1,
      releaseId: 'reference-http-test-v1',
      total: 1,
    })

    const diagnosisPageResponse = await runtime.app.request(
      '/api/his/v1/reference-catalogs/diagnoses?page=2&pageSize=10&query=%E7%9B%AE%E5%BD%95%E8%AF%8A%E6%96%AD',
      { headers: { cookie: doctorCookie } },
    )
    expect(diagnosisPageResponse.status).toBe(200)
    const diagnosisPage = referenceDiagnosisCatalogSearchSchema.parse(
      await diagnosisPageResponse.json(),
    )
    expect(diagnosisPage).toMatchObject({ page: 2, pageSize: 10, total: 120 })
    expect(diagnosisPage.items).toHaveLength(10)
    expect(diagnosisPage.items[0]).toMatchObject({ code: 'Z010', display: '目录诊断 010' })

    const medicationsResponse = await runtime.app.request(
      '/api/his/v1/reference-catalogs/medications?page=1&pageSize=2&query=%E5%AF%B9%E4%B9%99%E9%85%B0%E6%B0%A8%E5%9F%BA%E9%85%9A',
      { headers: { cookie: doctorCookie } },
    )
    expect(medicationsResponse.status).toBe(200)
    expect(referenceMedicationCatalogSearchSchema.parse(await medicationsResponse.json()))
      .toMatchObject({
        items: [expect.objectContaining({
          code: 'CM-NHSA-PRODUCT-ACETAMINOPHEN',
          genericName: '对乙酰氨基酚片',
          status: 'active',
        })],
        page: 1,
        pageSize: 2,
        releaseId: 'reference-http-test-v1',
        total: 1,
      })

    const laboratoryResponse = await runtime.app.request(
      '/api/his/v1/reference-catalogs/laboratory?page=1&pageSize=20&query=%E8%A1%80%E5%B8%B8%E8%A7%84',
      { headers: { cookie: doctorCookie } },
    )
    expect(laboratoryResponse.status).toBe(200)
    expect(referenceLaboratoryCatalogSearchSchema.parse(await laboratoryResponse.json()))
      .toMatchObject({
        items: [{ code: '58410-2', display: '血常规组合', status: 'active' }],
        releaseId: 'reference-http-test-v1',
        total: 1,
      })

    const shortQuery = await runtime.app.request(
      '/api/his/v1/reference-catalogs/diagnoses?page=1&pageSize=20&query=%E8%A1%80',
      { headers: { cookie: doctorCookie } },
    )
    expect(shortQuery.status).toBe(400)
    const clientRelease = await runtime.app.request(
      '/api/his/v1/reference-catalogs/diagnoses?page=1&pageSize=20&query=%E5%8E%9F%E5%8F%91%E6%80%A7&releaseId=other',
      { headers: { cookie: doctorCookie } },
    )
    expect(clientRelease.status).toBe(400)
  })

  it('freezes selected Reference coding when the system current release changes', async () => {
    const referenceDirectory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-snapshots-'))
    const operationalDirectory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-snapshot-db-'))
    temporaryDirectories.push(referenceDirectory, operationalDirectory)
    const referenceDatabasePath = await createReferenceDatabase(referenceDirectory)
    await addUpdatedReferenceRelease(referenceDirectory, referenceDatabasePath)
    const databasePath = join(operationalDirectory, 'operational.sqlite')
    const password = `Test-${randomUUID()}-Aa1!`
    const first = await createRuntime({
      activeReferenceReleaseId: 'reference-http-test-v1',
      databasePath,
      password,
      referenceDatabasePath,
    })
    const doctorCookie = await signIn(first.runtime, password, 'doctor@demo.clinmesh.local')
    const headers = () => ({
      'content-type': 'application/json',
      cookie: doctorCookie,
      'idempotency-key': randomUUID(),
      origin: 'http://localhost',
    })
    const candidates = virtualPatientListSchema.parse(await (await first.runtime.app.request(
      '/api/his/v1/doctor/virtual-patients',
      { headers: { cookie: doctorCookie } },
    )).json())
    const candidate = candidates.items[0]
    if (candidate === undefined) throw new Error('Expected a Virtual Patient candidate')
    const startResponse = await first.runtime.app.request(
      `/api/his/v1/doctor/virtual-patients/${candidate.id}/actions/start`,
      {
        body: JSON.stringify({ expectedVersions: {}, input: { expectedVersion: candidate.version } }),
        headers: headers(),
        method: 'POST',
      },
    )
    const started = startVirtualPatientResponseSchema.parse(await startResponse.json()).data
    const encounterReference = `Encounter/${started.encounterId}`

    const diagnosisDraftResponse = await first.runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/diagnosis/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [encounterReference]: '1' },
          input: {
            entries: [{ catalogItemId: 'diagnosis:hypertension', role: 'primary' }],
            expectedDraftVersion: 0,
          },
        }),
        headers: headers(),
        method: 'PUT',
      },
    )
    expect(diagnosisDraftResponse.status).toBe(200)
    const diagnosisDraft = diagnosisDraftResponseSchema.parse(
      await diagnosisDraftResponse.json(),
    ).data
    const diagnosisResponse = await first.runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/diagnosis/actions/confirm`,
      {
        body: JSON.stringify({
          expectedVersions: { [encounterReference]: '1' },
          input: { expectedDraftVersion: diagnosisDraft.draftVersion },
        }),
        headers: headers(),
        method: 'POST',
      },
    )
    expect(diagnosisResponse.status).toBe(200)
    const diagnosis = confirmDiagnosisResponseSchema.parse(await diagnosisResponse.json()).data
    expect(diagnosis.confirmation.entries[0]).toMatchObject({
      code: 'I10',
      display: '原发性高血压',
      system: 'urn:clinmesh:reference:nhsa-diagnosis',
    })

    const product = syntheticNhsaMedicationProductSnapshot[0]!
    const prescriptionDraftResponse = await first.runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/prescription/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [encounterReference]: diagnosis.encounterVersion },
          input: {
            expectedDraftVersion: 0,
            items: [{
              catalogItemId: product.id,
              courseDays: 3,
              doseText: product.strength,
              frequencyCode: 'QD',
              quantity: 1,
            }],
          },
        }),
        headers: headers(),
        method: 'PUT',
      },
    )
    expect(prescriptionDraftResponse.status).toBe(200)
    const prescriptionDraft = prescriptionDraftResponseSchema.parse(
      await prescriptionDraftResponse.json(),
    ).data
    const prescriptionResponse = await first.runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/prescription/actions/issue`,
      {
        body: JSON.stringify({
          expectedVersions: { [encounterReference]: diagnosis.encounterVersion },
          input: { expectedDraftVersion: prescriptionDraft.draftVersion },
        }),
        headers: headers(),
        method: 'POST',
      },
    )
    expect(prescriptionResponse.status).toBe(200)
    const prescription = issuePrescriptionResponseSchema.parse(
      await prescriptionResponse.json(),
    ).data.prescription
    expect(prescription.items[0]).toMatchObject({
      catalogItemId: product.id,
      display: product.genericName,
    })

    const laboratoryDraftResponse = await first.runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [encounterReference]: diagnosis.encounterVersion },
          input: {
            catalogItemId: 'laboratory:cbc-panel',
            expectedDraftVersion: 0,
            indicationCode: 'clinical-evaluation',
          },
        }),
        headers: headers(),
        method: 'PUT',
      },
    )
    expect(laboratoryDraftResponse.status).toBe(200)
    const laboratoryDraft = laboratoryRequestDraftResponseSchema.parse(
      await laboratoryDraftResponse.json(),
    ).data
    const laboratoryResponse = await first.runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/actions/issue`,
      {
        body: JSON.stringify({
          expectedVersions: { [encounterReference]: diagnosis.encounterVersion },
          input: { expectedDraftVersion: laboratoryDraft.draftVersion },
        }),
        headers: headers(),
        method: 'POST',
      },
    )
    expect(laboratoryResponse.status).toBe(200)
    expect(issueLaboratoryRequestResponseSchema.parse(await laboratoryResponse.json()).data.request)
      .toMatchObject({
        referenceConcept: { code: '58410-2', display: '血常规组合', version: '2.83' },
      })

    expect(JSON.parse((first.runtime.database.driver.prepare(`
      SELECT coding_snapshot_json FROM diagnosis_entry LIMIT 1
    `).get() as { coding_snapshot_json: string }).coding_snapshot_json)).toMatchObject({
      display: '原发性高血压', version: '2022',
    })
    expect(JSON.parse((first.runtime.database.driver.prepare(`
      SELECT medication_snapshot_json FROM prescription_item LIMIT 1
    `).get() as { medication_snapshot_json: string }).medication_snapshot_json)).toMatchObject({
      genericName: product.genericName,
    })
    expect(JSON.parse((first.runtime.database.driver.prepare(`
      SELECT reference_json FROM laboratory_request LIMIT 1
    `).get() as { reference_json: string }).reference_json)).toMatchObject({
      display: '血常规组合', version: '2.83',
    })

    await first.runtime.close()
    runtimes.splice(runtimes.indexOf(first.runtime), 1)
    const second = await createRuntime({
      activeReferenceReleaseId: 'reference-http-test-v2',
      databasePath,
      migrationMode: 'verify',
      password,
      referenceDatabasePath,
    })
    const restartedDoctorCookie = await signIn(
      second.runtime,
      password,
      'doctor@demo.clinmesh.local',
    )
    const detailResponse = await second.runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: restartedDoctorCookie } },
    )
    expect(detailResponse.status).toBe(200)
    const detail = doctorCaseDetailSchema.parse(await detailResponse.json())
    expect(detail.diagnosis?.confirmation?.entries[0]?.display).toBe('原发性高血压')
    expect(detail.medicationConclusion?.prescription?.items[0]?.display).toBe(product.genericName)
    expect(detail.laboratoryRequests?.requests[0]?.referenceConcept?.display).toBe('血常规组合')
    expect(JSON.stringify(detail)).not.toMatch(/新版原发性高血压|新版血常规组合/)
  })

  it('starts without an external reference database and exposes the built-in release to administrators', async () => {
    const { password, runtime } = await createRuntime()
    const cookie = await signIn(runtime, password, 'admin@demo.clinmesh.local')

    const response = await runtime.app.request('/api/sim/v1/reference-data/releases', {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    const release = referenceDataReleaseListSchema.parse(await response.json()).items[0]
    expect(release).toMatchObject({
        conceptCount: 0,
        contentHash: 'bc1e7ca7e11e31851acd651705ab627b45ff459c79dcca3aa1ebb32c81ae0b5e',
        medicationProductCount: 3,
        releaseId: 'clinmesh-hospital-reference-fixture-2026-08-28',
        serviceCount: 9,
        status: 'published',
        valueSetEntryCount: 6,
    })
    expect(release?.sources.map(source => source.checksum)).toEqual([
      'b72aa94f14b640dc9bc2952d687728995cc06a137da734b2b74bbffb64256c93',
      '8ed125b9d880f39ff0e7a503229e4bd1d69772ec86ee6c19808d6c68eca3954b',
      '36fc6be3ab504b8f48f1cacedaac2aaae42c648ee8cd2bb6cded99a130b05a13',
    ])
  })

  it('materializes exact diagnosis and laboratory reference concepts from a selection', async () => {
    const referenceDirectory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-selection-'))
    temporaryDirectories.push(referenceDirectory)
    const referenceDatabasePath = await createReferenceDatabase(referenceDirectory)
    const productBindings = ([
      ['medication-acetaminophen', 'CM-NHSA-PRODUCT-ACETAMINOPHEN'],
      ['medication-metformin', 'CM-NHSA-PRODUCT-METFORMIN'],
      ['medication-amlodipine', 'CM-NHSA-PRODUCT-AMLODIPINE'],
    ] as const).map(([catalogItemId, code]) => ({
      catalogItemId,
      coding: {
        code,
        system: 'urn:clinmesh:reference:nhsa-medication-product',
        version: 'nhsa-medication-products-2026-08-07',
      },
      kind: 'medication-product' as const,
    }))
    const selection = createReferenceHospitalSelection({
      bindings: [{
        catalogItemId: 'diagnosis-fever',
        coding: {
          code: 'R50.900',
          system: 'urn:clinmesh:reference:nhsa-diagnosis',
          version: '2022',
        },
        kind: 'diagnosis',
      }, {
        catalogItemId: 'lab-cbc',
        coding: { code: '58410-2', system: 'http://loinc.org', version: '2.83' },
        kind: 'laboratory',
      }, ...productBindings],
      referenceReleaseId: 'reference-http-test-v1',
      schemaVersion: '1',
      selectionId: 'reference-http-selection',
      version: '1',
    })
    const { password, runtime } = await createRuntime({
      referenceDatabasePath,
      referenceSelection: selection,
    })
    const cookie = await signIn(runtime, password, 'admin@demo.clinmesh.local')
    const generateResponse = await runtime.app.request('/api/sim/v1/scenario-datasets/actions/generate', {
      body: JSON.stringify({
        modules: ['fever'],
        name: '参考概念物化测试',
        population: { age: { maximum: 50, minimum: 30 }, count: 1, gender: 'female' },
        providerId: 'builtin',
        seeds: { clinical: 7331, population: 4242 },
        timeRange: { end: '2026-08-01', start: '2016-08-01' },
        timeZone: 'Asia/Shanghai',
      }),
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(generateResponse.status).toBe(200)
    const dataset = commandResponseSchema(scenarioDatasetSchema)
      .parse(await generateResponse.json()).data
    expect(dataset.content.catalog.diagnoses.find(item => item.id === 'diagnosis-fever'))
      .toHaveProperty('referenceConcept.code', 'R50.900')
    expect(dataset.content.catalog.investigations.find(item => item.id === 'lab-cbc'))
      .toHaveProperty('referenceConcept.display', '血常规组合')

    const installResponse = await runtime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(dataset.datasetId)}/actions/install`,
      {
        body: JSON.stringify({ expectedVersion: dataset.version }),
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(installResponse.status).toBe(200)
    const activeEpoch = z.object({ active_epoch: z.string() }).parse(
      runtime.database.driver.prepare(
        'SELECT active_epoch FROM workspace WHERE workspace_id = ?',
      ).get('workspace-demo'),
    ).active_epoch
    expect(runtime.database.driver.prepare(`
      SELECT code_system, code, name_zh FROM diagnosis_catalog
      WHERE workspace_id = ? AND epoch = ? AND item_id = 'diagnosis-fever'
    `).get('workspace-demo', activeEpoch)).toEqual({
      code: 'R50.900',
      code_system: 'urn:clinmesh:reference:nhsa-diagnosis',
      name_zh: '发热',
    })
    const laboratoryRow = z.object({ config_json: z.string() }).parse(
      runtime.database.driver.prepare(`
        SELECT config_json FROM outpatient_catalog
        WHERE workspace_id = ? AND epoch = ? AND item_id = 'lab-cbc'
      `).get('workspace-demo', activeEpoch),
    )
    expect(JSON.parse(laboratoryRow.config_json)).toMatchObject({
      referenceConcept: {
        code: '58410-2',
        display: '血常规组合',
        system: 'http://loinc.org',
        version: '2.83',
      },
    })
  })

  it('compiles the disease catalog closure from one complete configured reference release', async () => {
    const referenceDirectory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-products-'))
    temporaryDirectories.push(referenceDirectory)
    const referenceDatabasePath = await createReferenceDatabase(referenceDirectory)
    const diagnosisArtifact = `${JSON.stringify({
      concepts: [{
        code: 'I10',
        display: 'Synthetic newer diagnosis',
        domain: 'diagnosis',
        id: 'diagnosis:newer',
        sourceLocator: 'concepts[0]',
        status: 'active',
        system: 'http://hl7.org/fhir/sid/icd-10',
        version: 'synthetic-2026-08-29',
      }],
      schemaVersion: '1',
    })}\n`
    await writeFile(join(referenceDirectory, 'newer-diagnosis.json'), diagnosisArtifact)
    await writeFile(join(referenceDirectory, 'newer-release.json'), `${JSON.stringify({
      createdAt: '2026-08-29T00:00:00.000Z',
      releaseId: 'reference-newer-diagnosis-only-v1',
      schemaVersion: '1',
      sources: [{
        acquisitionMethod: 'generated',
        artifactPath: 'newer-diagnosis.json',
        checksum: createHash('sha256').update(diagnosisArtifact).digest('hex'),
        licenseId: 'LicenseRef-ClinMesh-Proprietary',
        retrievedAt: '2026-08-29T00:00:00.000Z',
        sourceId: 'newer-diagnosis-only',
        sourceUrl: 'https://example.test/reference/newer-diagnosis-only',
        upstreamVersion: 'synthetic-2026-08-29',
      }],
    })}\n`)
    await runReferenceDatabaseCli([
      'import', '--database', referenceDatabasePath,
      '--manifest', join(referenceDirectory, 'newer-release.json'),
    ])
    const { password, runtime } = await createRuntime({
      activeReferenceReleaseId: 'reference-http-test-v1',
      referenceDatabasePath,
    })
    const cookie = await signIn(runtime, password, 'admin@demo.clinmesh.local')

    const generateResponse = await runtime.app.request('/api/sim/v1/scenario-datasets/actions/generate', {
      body: JSON.stringify({
        modules: ['type-2-diabetes'],
        name: '药品产品来源编译测试',
        population: { age: { maximum: 70, minimum: 45 }, count: 1, gender: 'male' },
        providerId: 'builtin',
        seeds: { clinical: 101, population: 202 },
        timeRange: { end: '2026-08-01', start: '2016-08-01' },
        timeZone: 'Asia/Shanghai',
      }),
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(generateResponse.status).toBe(200)
    const dataset = commandResponseSchema(scenarioDatasetSchema)
      .parse(await generateResponse.json()).data
    expect(dataset.content.reproduction).toHaveProperty(
      'referenceData.releaseId',
      'reference-http-test-v1',
    )
    expect(dataset.content.catalog.medications.map(medication => (
      'product' in medication ? medication.product.id : null
    ))).toEqual([
      'nhsa-medication-product:nhsa-medication-products-2026-08-07:CM-NHSA-PRODUCT-METFORMIN',
    ])
    expect(dataset.content.catalog.services?.map(service => service.nationalService.id)).toEqual(
      syntheticNhcMedicalServiceSnapshot.filter(service => [
        'CM-NHC-SERVICE-CBC',
        'CM-NHC-SERVICE-WBC',
        'CM-NHC-SERVICE-HGB',
        'CM-NHC-SERVICE-RBC',
        'CM-NHC-SERVICE-MCV',
        'CM-NHC-SERVICE-HCT',
        'CM-NHC-SERVICE-HBA1C',
        'CM-NHC-SERVICE-FUNDUS',
        'CM-NHC-SERVICE-DIABETES-EDUCATION',
      ].includes(service.code)).map(service => service.id),
    )
  })

  it('fixes the configured release identity in generated Dataset and Profile facts', async () => {
    const referenceDirectory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-provenance-'))
    temporaryDirectories.push(referenceDirectory)
    const referenceDatabasePath = await createReferenceDatabase(referenceDirectory)
    const { password, runtime } = await createRuntime({ referenceDatabasePath })
    const cookie = await signIn(runtime, password, 'admin@demo.clinmesh.local')

    const generationRequest = {
        modules: ['fever'],
        name: '参考数据来源固定测试',
        population: { age: { maximum: 70, minimum: 18 }, count: 1, gender: 'any' },
        providerId: 'builtin',
        seeds: { clinical: 7331, population: 4242 },
        timeRange: { end: '2026-08-01', start: '1996-08-01' },
        timeZone: 'Asia/Shanghai',
    }
    const generateResponse = await runtime.app.request('/api/sim/v1/scenario-datasets/actions/generate', {
      body: JSON.stringify(generationRequest),
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    if (generateResponse.status !== 200) {
      throw new Error(`Dataset generation failed: ${generateResponse.status} ${await generateResponse.text()}`)
    }
    const dataset = commandResponseSchema(scenarioDatasetSchema).parse(await generateResponse.json()).data
    expect(dataset.content.reproduction).toHaveProperty('referenceData', {
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      releaseId: 'reference-http-test-v1',
    })

    const profilesResponse = await runtime.app.request('/api/sim/v1/synthetic-patients', {
      headers: { cookie },
    })
    const profileId = syntheticPatientProfileListSchema.parse(await profilesResponse.json()).items[0]?.profileId
    if (profileId === undefined) throw new Error('Expected a generated Synthetic Patient Profile')
    const profileResponse = await runtime.app.request(
      `/api/sim/v1/synthetic-patients/${encodeURIComponent(profileId)}`,
      { headers: { cookie } },
    )
    expect(profileResponse.status).toBe(200)
    const profile = syntheticPatientProfileDetailSchema.parse(await profileResponse.json())
    expect(profile.source).toHaveProperty(
      'referenceData',
      {
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        releaseId: 'reference-http-test-v1',
      },
    )
    const revision = z.object({ reference_data_json: z.string() }).parse(
      runtime.database.driver.prepare(`
        SELECT reference_data_json
        FROM synthetic_patient_profile_revision
        WHERE workspace_id = ? AND profile_id = ? AND revision = 1
      `).get('workspace-demo', profileId),
    )
    expect(referenceDataProvenanceSchema.parse(JSON.parse(revision.reference_data_json)))
      .toEqual(profile.source.referenceData)
  })

  it('resets an installed Package after the external reference database is removed', async () => {
    const referenceDirectory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-offline-'))
    const operationalDirectory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-operational-'))
    temporaryDirectories.push(referenceDirectory, operationalDirectory)
    const referenceDatabasePath = await createReferenceDatabase(referenceDirectory)
    const databasePath = join(operationalDirectory, 'operational.sqlite')
    const password = `Test-${randomUUID()}-Aa1!`
    const first = await createRuntime({ databasePath, password, referenceDatabasePath })
    const cookie = await signIn(first.runtime, password, 'admin@demo.clinmesh.local')
    const generateResponse = await first.runtime.app.request(
      '/api/sim/v1/scenario-datasets/actions/generate',
      {
        body: JSON.stringify({
          modules: ['fever'],
          name: '离线重置来源固定测试',
          population: { age: { maximum: 70, minimum: 18 }, count: 1, gender: 'any' },
          providerId: 'builtin',
          seeds: { clinical: 7331, population: 4242 },
          timeRange: { end: '2026-08-01', start: '1996-08-01' },
          timeZone: 'Asia/Shanghai',
        }),
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(generateResponse.status).toBe(200)
    const dataset = commandResponseSchema(scenarioDatasetSchema).parse(await generateResponse.json()).data
    const legacyContent = JSON.parse(JSON.stringify(
      dataset.content,
      (key, value: unknown) => key === 'unit'
        && typeof value === 'object'
        && value !== null
        && 'system' in value
        && value.system === 'http://unitsofmeasure.org'
        && 'display' in value
        ? value.display
        : value,
    )) as unknown
    const legacyDataset = {
      content_hash: canonicalJsonHash(legacyContent),
      content_json: JSON.stringify(legacyContent),
    }
    first.runtime.database.driver.prepare(`
      UPDATE scenario_dataset SET content_json = ?, content_hash = ?
      WHERE workspace_id = ? AND dataset_id = ?
    `).run(
      legacyDataset.content_json,
      legacyDataset.content_hash,
      'workspace-demo',
      dataset.datasetId,
    )
    const readResponse = await first.runtime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(dataset.datasetId)}`,
      { headers: { cookie } },
    )
    expect(readResponse.status).toBe(200)
    const readDataset = scenarioDatasetSchema.parse(await readResponse.json())
    expect(readDataset.contentHash).toBe(legacyDataset.content_hash)
    expect(readDataset.content.catalog.investigations[0]?.unit).toMatchObject({
      system: 'http://unitsofmeasure.org',
      version: '2.2',
    })
    expect(readDataset.diagnostics).toEqual([])
    const installResponse = await first.runtime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(dataset.datasetId)}/actions/install`,
      {
        body: JSON.stringify({ expectedVersion: dataset.version }),
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    const installBody = await installResponse.json()
    expect({ body: installBody, status: installResponse.status }).toMatchObject({ status: 200 })
    const installed = z.object({
      data: z.object({ packageId: z.string(), scenario: scenarioStateSchema }).strict(),
    }).passthrough().parse(installBody).data
    const packageRow = first.runtime.database.driver.prepare(`
      SELECT content_json, content_hash FROM scenario_package
      WHERE workspace_id = ? AND package_id = ?
    `).get('workspace-demo', installed.packageId) as {
      content_hash: string
      content_json: string
    } | undefined
    expect(packageRow).toBeDefined()
    expect(scenarioDatasetSchema.shape.content.parse(JSON.parse(packageRow?.content_json ?? '{}')).reproduction)
      .toHaveProperty('referenceData.releaseId', 'reference-http-test-v1')
    expect(packageRow).toEqual(legacyDataset)

    const updateResponse = await first.runtime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(dataset.datasetId)}`,
      {
        body: JSON.stringify({
          expectedVersion: readDataset.version,
          input: { content: readDataset.content, name: `${readDataset.name}已编辑` },
        }),
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'PUT',
      },
    )
    expect(updateResponse.status).toBe(200)
    const updatedDataset = commandResponseSchema(scenarioDatasetSchema)
      .parse(await updateResponse.json()).data
    expect(updatedDataset.contentHash).toBe(canonicalJsonHash(updatedDataset.content))
    expect(updatedDataset.contentHash).not.toBe(legacyDataset.content_hash)

    await first.runtime.close()
    runtimes.splice(runtimes.indexOf(first.runtime), 1)
    await rm(referenceDirectory, { force: true, recursive: true })
    const restarted = await createRuntime({ databasePath, migrationMode: 'verify', password })
    const restartedCookie = await signIn(
      restarted.runtime,
      password,
      'admin@demo.clinmesh.local',
    )
    const resetResponse = await restarted.runtime.app.request(
      `/api/sim/v1/scenario-runs/${encodeURIComponent(installed.scenario.scenarioRunId)}/actions/reset`,
      {
        body: JSON.stringify({}),
        headers: {
          'content-type': 'application/json',
          cookie: restartedCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(resetResponse.status).toBe(200)
    expect(commandResponseSchema(scenarioStateSchema).parse(await resetResponse.json()).data).toMatchObject({
      scenarioId: installed.packageId,
    })
    const serviceCatalogResponse = await restarted.runtime.app.request(
      '/api/his/v1/catalogs/services?page=1&pageSize=20',
      { headers: { cookie: restartedCookie } },
    )
    expect(serviceCatalogSearchSchema.parse(await serviceCatalogResponse.json())).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: 'hospital-service-cbc' }),
      ]),
      total: 6,
    })
    expect(restarted.runtime.database.driver.prepare(`
      SELECT content_json, content_hash FROM scenario_package
      WHERE workspace_id = ? AND package_id = ?
    `).get('workspace-demo', installed.packageId)).toEqual(legacyDataset)
  })
})
