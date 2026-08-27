import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  referenceDataProvenanceSchema,
  referenceDataReleaseListSchema,
} from '@clinmesh/contracts/reference-data'
import {
  scenarioDatasetSchema,
  syntheticPatientProfileListSchema,
  syntheticPatientProfileSchema,
} from '@clinmesh/contracts/scenario'
import { commandResponseSchema, scenarioStateSchema } from '@clinmesh/contracts/his'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { canonicalJsonHash } from '../src/application/scenario-data/canonical-json.ts'
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
    databasePath?: string
    migrationMode?: 'apply' | 'verify'
    password?: string
    referenceDatabasePath?: string
  } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-reference-http-'))
    temporaryDirectories.push(directory)
    const password = input.password ?? `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
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

  async function createReferenceDatabase(directory: string): Promise<string> {
    const databasePath = join(directory, 'reference.sqlite')
    const artifactJson = `${JSON.stringify({
      concepts: [{
        code: 'R50.9',
        display: '发热，未特指',
        domain: 'diagnosis',
        id: 'diagnosis:fever',
        sourceLocator: 'concepts[0]',
        status: 'active',
        system: 'http://hl7.org/fhir/sid/icd-10',
        version: 'synthetic-2026',
      }],
      schemaVersion: '1',
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
    const { password, runtime } = await createRuntime({ referenceDatabasePath })
    const administratorCookie = await signIn(runtime, password, 'admin@demo.clinmesh.local')
    const doctorCookie = await signIn(runtime, password, 'doctor@demo.clinmesh.local')

    const administratorResponse = await runtime.app.request('/api/sim/v1/reference-data/releases', {
      headers: { cookie: administratorCookie },
    })
    expect(administratorResponse.status).toBe(200)
    expect(referenceDataReleaseListSchema.parse(await administratorResponse.json())).toMatchObject({
      items: [{ conceptCount: 1, releaseId: 'reference-http-test-v1', sourceCount: 1 }],
    })

    const doctorResponse = await runtime.app.request('/api/sim/v1/reference-data/releases', {
      headers: { cookie: doctorCookie },
    })
    expect(doctorResponse.status).toBe(403)
  })

  it('starts without an external reference database and exposes the built-in release to administrators', async () => {
    const { password, runtime } = await createRuntime()
    const cookie = await signIn(runtime, password, 'admin@demo.clinmesh.local')

    const response = await runtime.app.request('/api/sim/v1/reference-data/releases', {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    expect(referenceDataReleaseListSchema.parse(await response.json())).toMatchObject({
      items: [{
        conceptCount: 0,
        contentHash: 'c4f3db18716deead08d407dec4473d2fb30cf4d098fb8cad6cc04ef9fc7384a5',
        releaseId: 'clinmesh-builtin-reference-v1',
        sources: [{
          checksum: 'c2b6041f9f43187433f89ccfbc646d0d6a484afe228ae834e20348cd606874d2',
          licenseId: 'LicenseRef-ClinMesh-Proprietary',
        }],
        status: 'published',
      }],
    })
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
    const profile = syntheticPatientProfileSchema.parse(await profileResponse.json())
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
    expect(installResponse.status).toBe(200)
    const installed = z.object({
      data: z.object({ packageId: z.string(), scenario: scenarioStateSchema }).strict(),
    }).passthrough().parse(await installResponse.json()).data
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
    expect(restarted.runtime.database.driver.prepare(`
      SELECT content_json, content_hash FROM scenario_package
      WHERE workspace_id = ? AND package_id = ?
    `).get('workspace-demo', installed.packageId)).toEqual(legacyDataset)
  })
})
