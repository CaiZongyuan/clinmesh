import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  referenceDiagnosisCatalogSearchSchema,
  referenceDataReleaseListSchema,
  referenceLaboratoryCatalogSearchSchema,
  referenceMedicationCatalogSearchSchema,
} from '@clinmesh/contracts/reference-data'
import {
  confirmDiagnosisResponseSchema,
  diagnosisDraftResponseSchema,
  doctorCaseDetailSchema,
  issueLaboratoryRequestResponseSchema,
  issuePrescriptionResponseSchema,
  laboratoryRequestDraftResponseSchema,
  prescriptionDraftResponseSchema,
  startVirtualPatientResponseSchema,
  virtualPatientListSchema,
} from '@clinmesh/contracts/his'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { openReferenceDatabase } from '../src/infrastructure/sqlite/reference-database.ts'
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
        laboratory: {
          category: 'hematology',
          resultType: 'panel',
          specimen: 'blood',
        },
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
        laboratory: {
          category: 'hematology',
          resultType: 'panel',
          specimen: 'blood',
        },
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

    const twoCharacterLaboratoryQuery = await runtime.app.request(
      '/api/his/v1/reference-catalogs/laboratory?page=1&pageSize=20&query=%E8%A1%80%E5%B8%B8',
      { headers: { cookie: doctorCookie } },
    )
    expect(twoCharacterLaboratoryQuery.status).toBe(200)
    expect(referenceLaboratoryCatalogSearchSchema.parse(
      await twoCharacterLaboratoryQuery.json(),
    )).toMatchObject({ items: [{ code: '58410-2' }], total: 1 })

    const twoCharacterMedicationQuery = await runtime.app.request(
      '/api/his/v1/reference-catalogs/medications?page=1&pageSize=20&query=%E5%AF%B9%E4%B9%99',
      { headers: { cookie: doctorCookie } },
    )
    expect(twoCharacterMedicationQuery.status).toBe(200)
    expect(referenceMedicationCatalogSearchSchema.parse(
      await twoCharacterMedicationQuery.json(),
    )).toMatchObject({ items: [expect.objectContaining({ genericName: '对乙酰氨基酚片' })], total: 1 })

    const oneCharacterQuery = await runtime.app.request(
      '/api/his/v1/reference-catalogs/diagnoses?page=1&pageSize=20&query=%E8%A1%80',
      { headers: { cookie: doctorCookie } },
    )
    expect(oneCharacterQuery.status).toBe(400)
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
        referenceConcept: {
          code: '58410-2',
          display: '血常规组合',
          laboratory: { category: 'hematology', resultType: 'panel', specimen: 'blood' },
          version: '2.83',
        },
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
      display: '血常规组合',
      laboratory: { category: 'hematology', resultType: 'panel', specimen: 'blood' },
      version: '2.83',
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
    expect(detail.laboratoryRequests?.requests[0]?.referenceConcept).toMatchObject({
      display: '血常规组合',
      laboratory: { category: 'hematology', resultType: 'panel', specimen: 'blood' },
    })
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
})
