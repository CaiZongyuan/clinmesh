import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fhirBundleSchema, fhirResourceSchema } from '@clinmesh/contracts/fhir'
import {
  scenarioDatasetListSchema,
  scenarioDatasetSchema,
  scenarioProviderCapabilitiesListSchema,
} from '@clinmesh/contracts/scenario'
import {
  apiErrorSchema,
  clinicalCatalogSchema,
  commandResponseSchema,
  createPatientResponseSchema,
  patientSearchSchema,
  registrationCatalogSchema,
  scenarioCommandResponseSchema,
  scenarioStateSchema,
  sessionContextSchema,
} from '@clinmesh/contracts/his'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readServerConfig } from '../src/config.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'

const betterAuthErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
})

const betterAuthSignInResponseSchema = z.object({
  redirect: z.literal(false),
  token: z.string().min(1),
  user: z.object({
    email: z.email(),
    id: z.string().min(1),
    name: z.string().min(1),
  }),
})

const betterAuthSignOutResponseSchema = z.object({
  success: z.literal(true),
})

describe('trusted session and Scenario HTTP contract', () => {
  const runtimes: Array<Awaited<ReturnType<typeof createClinMeshRuntime>>> = []
  const temporaryDirectories: string[] = []

  const createTestRuntime = async (prefix: string) => {
    const directory = await mkdtemp(join(tmpdir(), prefix))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    return { password, runtime }
  }

  const signInSyntheticAccount = async (
    runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
    password: string,
    email: string,
  ): Promise<string> => {
    const response = await runtime.app.request('/api/auth/sign-in/email', {
      body: JSON.stringify({ email, password }),
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
  }

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
  })

  it('allows a seeded account to obtain only its server-bound role context and rejects public sign-up', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-auth-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)

    const signUpResponse = await runtime.app.request('/api/auth/sign-up/email', {
      body: JSON.stringify({
        email: 'unapproved@demo.clinmesh.local',
        name: '未授权账户',
        password,
      }),
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(signUpResponse.status).toBe(403)

    const signInResponse = await runtime.app.request('/api/auth/sign-in/email', {
      body: JSON.stringify({
        email: 'registrar@demo.clinmesh.local',
        password,
      }),
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(signInResponse.status).toBe(200)
    const cookie = signInResponse.headers.get('set-cookie')?.split(';', 1)[0]
    expect(cookie).toBeDefined()

    const contextResponse = await runtime.app.request(
      '/api/auth/context?workspaceId=workspace-forged&epoch=epoch-forged',
      { headers: { cookie: cookie ?? '' } },
    )
    expect(contextResponse.status).toBe(200)
    expect(sessionContextSchema.parse(await contextResponse.json())).toMatchObject({
      actor: {
        actorId: 'actor-registrar',
        epoch: 'epoch-1',
        practitionerId: 'practitioner-registrar',
        practitionerRoleId: 'practitioner-role-registrar',
        roleCode: 'registrar',
        scenarioRunId: 'scenario-run-1',
        workspaceId: 'workspace-demo',
      },
      availableRoles: [{
        code: 'registrar',
        id: 'practitioner-role-registrar',
      }],
    })
  })

  it('rejects an untrusted origin without ending the authenticated session', async () => {
    const { password, runtime } = await createTestRuntime('clinmesh-untrusted-sign-out-http-')
    const cookie = await signInSyntheticAccount(runtime, password, 'doctor@demo.clinmesh.local')

    const signOutResponse = await runtime.app.request('/api/auth/sign-out', {
      body: '{}',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'https://untrusted.example',
      },
      method: 'POST',
    })
    expect(signOutResponse.status).toBe(403)
    expect(betterAuthErrorSchema.parse(await signOutResponse.json())).toEqual({
      code: 'INVALID_ORIGIN',
      message: 'Invalid origin',
    })

    const contextResponse = await runtime.app.request('/api/auth/context', {
      headers: { cookie },
    })
    expect(contextResponse.status).toBe(200)
    expect(sessionContextSchema.parse(await contextResponse.json()).actor).toMatchObject({
      actorId: 'actor-outpatient-doctor',
      roleCode: 'outpatient-doctor',
    })
  })

  it('allows the documented Vite origin to end a session under the default local configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-vite-sign-out-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const config = readServerConfig({
      CLINMESH_AUTH_SECRET: 'test-auth-secret-with-at-least-32-characters',
      CLINMESH_CURSOR_SECRET: 'test-cursor-secret-with-at-least-32-characters',
      CLINMESH_DATABASE_PATH: join(directory, 'clinmesh.sqlite'),
      CLINMESH_DEMO_PASSWORD: password,
    })
    const runtime = await createClinMeshRuntime({
      authBaseUrl: config.authBaseUrl,
      authSecret: config.authSecret,
      cursorSecret: config.cursorSecret,
      databasePath: config.databasePath,
      demoPassword: config.demoPassword,
      migrationMode: 'apply',
      trustedOrigins: config.trustedOrigins,
    })
    runtimes.push(runtime)

    const signInResponse = await runtime.app.request(`${config.authBaseUrl}/api/auth/sign-in/email`, {
      body: JSON.stringify({
        email: 'doctor@demo.clinmesh.local',
        password,
      }),
      headers: {
        'content-type': 'application/json',
        origin: config.authBaseUrl,
      },
      method: 'POST',
    })
    expect(signInResponse.status).toBe(200)
    expect(betterAuthSignInResponseSchema.parse(await signInResponse.clone().json())).toMatchObject({
      redirect: false,
      user: { email: 'doctor@demo.clinmesh.local' },
    })
    const cookie = signInResponse.headers.get('set-cookie')?.split(';', 1)[0] ?? ''

    const signOutResponse = await runtime.app.request(`${config.authBaseUrl}/api/auth/sign-out`, {
      body: '{}',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://127.0.0.1:51888',
      },
      method: 'POST',
    })
    expect(signOutResponse.status).toBe(200)
    expect(betterAuthSignOutResponseSchema.parse(await signOutResponse.json())).toEqual({ success: true })

    const contextResponse = await runtime.app.request(`${config.authBaseUrl}/api/auth/context`, {
      headers: { cookie },
    })
    expect(contextResponse.status).toBe(401)
    expect(apiErrorSchema.parse(await contextResponse.json())).toMatchObject({
      error: { code: 'AUTHENTICATION_REQUIRED' },
    })
  })

  it('lets the Super Administrator select and restore every synthetic Acting Practitioner Context', async () => {
    const { password, runtime } = await createTestRuntime('clinmesh-role-http-')
    const cookie = await signInSyntheticAccount(runtime, password, 'admin@demo.clinmesh.local')
    const expectedRoles = [{
      code: 'administrator',
      id: 'practitioner-role-administrator',
      locationId: 'location-administrator',
      organizationId: 'organization-clinmesh',
      practitionerId: 'practitioner-administrator',
      practitionerName: '合成管理员',
    }, {
      code: 'cashier',
      id: 'practitioner-role-cashier',
      locationId: 'location-cashier',
      organizationId: 'organization-clinmesh',
      practitionerId: 'practitioner-cashier',
      practitionerName: '合成收费员',
    }, {
      code: 'outpatient-doctor',
      id: 'practitioner-role-outpatient-doctor',
      locationId: 'location-outpatient-doctor',
      organizationId: 'organization-clinmesh',
      practitionerId: 'practitioner-outpatient-doctor',
      practitionerName: '合成门诊医生',
    }, {
      code: 'pharmacist',
      id: 'practitioner-role-pharmacist',
      locationId: 'location-pharmacist',
      organizationId: 'organization-clinmesh',
      practitionerId: 'practitioner-pharmacist',
      practitionerName: '合成药师',
    }, {
      code: 'registrar',
      id: 'practitioner-role-registrar',
      locationId: 'location-registrar',
      organizationId: 'organization-clinmesh',
      practitionerId: 'practitioner-registrar',
      practitionerName: '合成挂号员',
    }, {
      code: 'triage-nurse',
      id: 'practitioner-role-triage-nurse',
      locationId: 'location-triage-nurse',
      organizationId: 'organization-clinmesh',
      practitionerId: 'practitioner-triage-nurse',
      practitionerName: '合成分诊护士',
    }] as const

    const initialContextResponse = await runtime.app.request('/api/auth/context', {
      headers: { cookie },
    })
    expect(initialContextResponse.status).toBe(200)
    const initialContext = sessionContextSchema.parse(await initialContextResponse.json())
    expect(initialContext.availableRoles).toEqual(expectedRoles)

    for (const role of expectedRoles) {
      const selectedResponse = await runtime.app.request('/api/auth/role', {
        body: JSON.stringify({
          actorId: 'actor-forged',
          practitionerId: 'practitioner-forged',
          practitionerRoleId: role.id,
          workspaceId: 'workspace-forged',
        }),
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: 'http://localhost',
        },
        method: 'POST',
      })
      expect(selectedResponse.status).toBe(200)
      const expectedActor = {
        actorId: 'actor-administrator',
        locationId: role.locationId,
        organizationId: role.organizationId,
        practitionerId: role.practitionerId,
        practitionerRoleId: role.id,
        roleCode: role.code,
        workspaceId: 'workspace-demo',
      }
      expect(sessionContextSchema.parse(await selectedResponse.json())).toMatchObject({ actor: expectedActor })

      const restoredResponse = await runtime.app.request('/api/auth/context', {
        headers: { cookie },
      })
      expect(restoredResponse.status).toBe(200)
      expect(sessionContextSchema.parse(await restoredResponse.json())).toMatchObject({ actor: expectedActor })
    }
  })

  it('rejects Acting Practitioner selection without a trusted origin', async () => {
    const { password, runtime } = await createTestRuntime('clinmesh-role-csrf-http-')
    const cookie = await signInSyntheticAccount(runtime, password, 'registrar@demo.clinmesh.local')
    const csrfResponse = await runtime.app.request('/api/auth/role', {
      body: JSON.stringify({ practitionerRoleId: 'practitioner-role-registrar' }),
      headers: {
        'content-type': 'application/json',
        cookie,
      },
      method: 'POST',
    })
    expect(csrfResponse.status).toBe(403)
    expect(apiErrorSchema.parse(await csrfResponse.json())).toMatchObject({ error: { code: 'CSRF_REJECTED' } })
  })

  it('rejects an Acting Practitioner Context not granted to the account', async () => {
    const { password, runtime } = await createTestRuntime('clinmesh-role-forbidden-http-')
    const cookie = await signInSyntheticAccount(runtime, password, 'registrar@demo.clinmesh.local')
    const forbiddenResponse = await runtime.app.request('/api/auth/role', {
      body: JSON.stringify({
        actorId: 'actor-forged',
        practitionerId: 'practitioner-outpatient-doctor',
        practitionerRoleId: 'practitioner-role-outpatient-doctor',
      }),
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(forbiddenResponse.status).toBe(403)
    expect(apiErrorSchema.parse(await forbiddenResponse.json())).toMatchObject({ error: { code: 'ROLE_NOT_ALLOWED' } })
  })

  it('rejects invalid Acting Practitioner selection input', async () => {
    const { password, runtime } = await createTestRuntime('clinmesh-role-invalid-http-')
    const cookie = await signInSyntheticAccount(runtime, password, 'registrar@demo.clinmesh.local')
    const invalidResponse = await runtime.app.request('/api/auth/role', {
      body: JSON.stringify({ practitionerRoleId: '' }),
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(invalidResponse.status).toBe(400)
    expect(apiErrorSchema.parse(await invalidResponse.json())).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  })

  it('records the authenticated administrator and Acting Practitioner in a business AuditEvent', async () => {
    const { password, runtime } = await createTestRuntime('clinmesh-acting-audit-http-')
    const cookie = await signInSyntheticAccount(runtime, password, 'admin@demo.clinmesh.local')
    const selectionResponse = await runtime.app.request('/api/auth/role', {
      body: JSON.stringify({ practitionerRoleId: 'practitioner-role-registrar' }),
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(selectionResponse.status).toBe(200)

    const createResponse = await runtime.app.request('/api/his/v1/patients', {
      body: JSON.stringify({
        expectedVersions: {},
        input: {
          birthDate: '1990-06-15',
          gender: 'female',
          identifier: `CM-AUDIT-${randomUUID()}`,
          name: '合成审计患者',
        },
      }),
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(createResponse.status).toBe(200)
    const created = createPatientResponseSchema.parse(await createResponse.json())
    const auditResponse = await runtime.app.request(`/fhir/R5/AuditEvent/${created.auditId}`, {
      headers: { cookie },
    })
    expect(auditResponse.status).toBe(200)
    expect(fhirResourceSchema.parse(await auditResponse.json())).toMatchObject({
      agent: expect.arrayContaining([
        expect.objectContaining({
          requestor: true,
          type: { text: 'Authenticated actor' },
          who: {
            identifier: {
              system: 'https://caizongyuan.github.io/clinmesh/identifier/actor',
              value: 'actor-administrator',
            },
          },
        }),
        expect.objectContaining({
          requestor: false,
          role: expect.arrayContaining([expect.objectContaining({
            coding: [expect.objectContaining({
              code: 'practitioner-role-registrar',
            })],
            text: 'registrar',
          })]),
          type: { text: 'Acting practitioner' },
          who: {
            identifier: {
              system: 'https://caizongyuan.github.io/clinmesh/identifier/practitioner',
              value: 'practitioner-registrar',
            },
          },
        }),
      ]),
    })
  })

  it('rejects an idempotency replay after the administrator changes Acting Practitioner Context', async () => {
    const { password, runtime } = await createTestRuntime('clinmesh-acting-replay-http-')
    const cookie = await signInSyntheticAccount(runtime, password, 'admin@demo.clinmesh.local')
    const selectRole = (practitionerRoleId: string) => runtime.app.request('/api/auth/role', {
      body: JSON.stringify({ practitionerRoleId }),
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect((await selectRole('practitioner-role-registrar')).status).toBe(200)

    const idempotencyKey = randomUUID()
    const body = JSON.stringify({
      expectedVersions: {},
      input: {
        birthDate: '1990-06-15',
        gender: 'female',
        identifier: `CM-REPLAY-${randomUUID()}`,
        name: '合成重放患者',
      },
    })
    const createPatient = () => runtime.app.request('/api/his/v1/patients', {
      body,
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': idempotencyKey,
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect((await createPatient()).status).toBe(200)

    expect((await selectRole('practitioner-role-outpatient-doctor')).status).toBe(200)
    const replayResponse = await createPatient()

    expect(replayResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await replayResponse.json())).toMatchObject({
      error: { code: 'IDEMPOTENCY_KEY_REUSED' },
    })
  })

  it('lets only an administrator generate and read a persisted Scenario Dataset', async () => {
    const { password, runtime } = await createTestRuntime('clinmesh-scenario-dataset-http-')
    const adminCookie = await signInSyntheticAccount(runtime, password, 'admin@demo.clinmesh.local')
    const generationRequest = {
      modules: ['fever'],
      name: '合成发热门诊数据',
      population: {
        age: { maximum: 65, minimum: 18 },
        count: 1,
        gender: 'any',
      },
      providerId: 'builtin',
      seeds: { clinical: 7331, population: 4242 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    }
    const generateResponse = await runtime.app.request(
      '/api/sim/v1/scenario-datasets/actions/generate',
      {
        body: JSON.stringify(generationRequest),
        headers: {
          'content-type': 'application/json',
          cookie: adminCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )

    expect(generateResponse.status).toBe(200)
    const generated = commandResponseSchema(scenarioDatasetSchema).parse(await generateResponse.json())
    expect(generated.data).toMatchObject({
      content: { schemaVersion: '1' },
      diagnostics: [],
      name: generationRequest.name,
      providerId: 'builtin',
      version: 1,
      workspaceId: 'workspace-demo',
    })
    expect(generated.data.content.patients).toHaveLength(1)

    const readResponse = await runtime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(generated.data.datasetId)}`,
      { headers: { cookie: adminCookie } },
    )
    expect(readResponse.status).toBe(200)
    expect(scenarioDatasetSchema.parse(await readResponse.json())).toEqual(generated.data)

    const listResponse = await runtime.app.request(
      '/api/sim/v1/scenario-datasets?page=1&pageSize=20',
      { headers: { cookie: adminCookie } },
    )
    expect(listResponse.status).toBe(200)
    expect(scenarioDatasetListSchema.parse(await listResponse.json())).toEqual({
      items: [{
        contentHash: generated.data.contentHash,
        createdAt: generated.data.createdAt,
        datasetId: generated.data.datasetId,
        diagnosticCounts: { error: 0, warning: 0 },
        name: generationRequest.name,
        patientCount: 1,
        providerId: 'builtin',
        updatedAt: generated.data.updatedAt,
        version: 1,
      }],
      page: 1,
      pageSize: 20,
      total: 1,
    })

    const secondGenerationResponse = await runtime.app.request(
      '/api/sim/v1/scenario-datasets/actions/generate',
      {
        body: JSON.stringify({ ...generationRequest, name: '糖尿病随访数据' }),
        headers: {
          'content-type': 'application/json',
          cookie: adminCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(secondGenerationResponse.status).toBe(200)
    commandResponseSchema(scenarioDatasetSchema).parse(await secondGenerationResponse.json())
    const searchResponse = await runtime.app.request(
      `/api/sim/v1/scenario-datasets?page=1&pageSize=20&search=${encodeURIComponent('发热门诊')}`,
      { headers: { cookie: adminCookie } },
    )
    expect(searchResponse.status).toBe(200)
    expect(scenarioDatasetListSchema.parse(await searchResponse.json())).toMatchObject({
      items: [{ datasetId: generated.data.datasetId, name: generationRequest.name }],
      page: 1,
      pageSize: 20,
      total: 1,
    })

    const registrarCookie = await signInSyntheticAccount(runtime, password, 'registrar@demo.clinmesh.local')
    const forbiddenResponse = await runtime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(generated.data.datasetId)}`,
      { headers: { cookie: registrarCookie } },
    )
    expect(forbiddenResponse.status).toBe(403)
    expect(apiErrorSchema.parse(await forbiddenResponse.json())).toMatchObject({
      error: { code: 'ROLE_NOT_ALLOWED' },
    })
  })

  it('reports optional Scenario Provider capabilities only to an administrator', async () => {
    const { password, runtime } = await createTestRuntime('clinmesh-scenario-provider-http-')
    const adminCookie = await signInSyntheticAccount(runtime, password, 'admin@demo.clinmesh.local')
    const capabilitiesResponse = await runtime.app.request('/api/sim/v1/scenario-providers', {
      headers: { cookie: adminCookie },
    })

    expect(capabilitiesResponse.status).toBe(200)
    expect(scenarioProviderCapabilitiesListSchema.parse(await capabilitiesResponse.json())).toEqual({
      items: [{
        available: true,
        maxPopulation: 10,
        modules: ['fever', 'type-2-diabetes'],
        providerId: 'builtin',
        providerName: 'ClinMesh 内置生成器',
      }, {
        available: false,
        maxPopulation: 10,
        modules: ['fever', 'type-2-diabetes'],
        providerId: 'synthea',
        providerName: 'Synthea',
        unavailableReason: '未配置 Synthea Provider',
      }],
    })

    const registrarCookie = await signInSyntheticAccount(runtime, password, 'registrar@demo.clinmesh.local')
    const forbiddenResponse = await runtime.app.request('/api/sim/v1/scenario-providers', {
      headers: { cookie: registrarCookie },
    })
    expect(forbiddenResponse.status).toBe(403)
  })

  it('keeps an invalid Dataset editable and rejects stale expected versions', async () => {
    const { password, runtime } = await createTestRuntime('clinmesh-scenario-edit-http-')
    const cookie = await signInSyntheticAccount(runtime, password, 'admin@demo.clinmesh.local')
    const generateResponse = await runtime.app.request(
      '/api/sim/v1/scenario-datasets/actions/generate',
      {
        body: JSON.stringify({
          modules: ['fever'],
          name: '待编辑数据',
          population: { age: { maximum: 65, minimum: 18 }, count: 1, gender: 'any' },
          providerId: 'builtin',
          seeds: { clinical: 7, population: 11 },
          timeRange: { end: '2026-08-01', start: '2020-01-01' },
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
    const generated = commandResponseSchema(scenarioDatasetSchema)
      .parse(await generateResponse.json()).data
    const invalidContent = {
      ...generated.content,
      catalog: {
        ...generated.content.catalog,
        medications: [{
          ...generated.content.catalog.medications[0]!,
          workflow: {
            ...generated.content.catalog.medications[0]!.workflow,
            allowedCombinationIds: ['missing-combination-medication'],
            allowedDiagnosisCodes: ['MISSING-DIAGNOSIS'],
          },
        }, ...generated.content.catalog.medications.slice(1)],
      },
      inventory: [{
        ...generated.content.inventory[0]!,
        itemId: 'missing-medication',
      }],
      patients: [{
        ...generated.content.patients[0]!,
        fhirHistory: [...generated.content.patients[0]!.fhirHistory, {
          clinicalStatus: 'active',
          code: { display: '悬空就诊诊断' },
          encounterId: 'history-encounter-missing',
          id: 'history-condition-dangling',
          resourceType: 'Condition' as const,
        }],
        investigations: [{
          ...generated.content.patients[0]!.investigations[0]!,
          result: { message: '错误标记为本院未开展', outcome: 'catalog-boundary' as const },
        }],
        longitudinalHistory: [{
          ...generated.content.patients[0]!.longitudinalHistory[0]!,
          endedAt: '2025-01-01T00:00:00Z',
          mappedCode: null,
          occurredAt: '2026-01-01T00:00:00Z',
        }, ...generated.content.patients[0]!.longitudinalHistory.slice(1)],
      }],
    }
    const update = (expectedVersion: number, idempotencyKey: string) => runtime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(generated.datasetId)}`,
      {
        body: JSON.stringify({
          expectedVersion,
          input: { content: invalidContent, name: '存在引用问题的数据' },
        }),
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': idempotencyKey,
          origin: 'http://localhost',
        },
        method: 'PUT',
      },
    )

    const updateResponse = await update(1, randomUUID())
    expect(updateResponse.status).toBe(200)
    const updated = commandResponseSchema(scenarioDatasetSchema)
      .parse(await updateResponse.json()).data
    expect(updated).toMatchObject({
      name: '存在引用问题的数据',
      version: 2,
    })
    expect(updated.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CATALOG_REFERENCE_MISSING', path: 'inventory[0].itemId' }),
      expect.objectContaining({ code: 'CLINICAL_CODE_UNMAPPED', path: 'patients[0].longitudinalHistory[0].mappedCode' }),
      expect.objectContaining({ code: 'CLINICAL_TIME_INVERTED', path: 'patients[0].longitudinalHistory[0].endedAt' }),
      expect.objectContaining({ code: 'FHIR_HISTORY_REFERENCE_MISSING', path: 'patients[0].fhirHistory[3].encounterId' }),
      expect.objectContaining({ code: 'INVESTIGATION_CATALOG_CONFLICT', path: 'patients[0].investigations[0].result.outcome' }),
      expect.objectContaining({ code: 'MEDICATION_COMBINATION_REFERENCE_MISSING', path: 'catalog.medications[0].workflow.allowedCombinationIds[0]' }),
      expect.objectContaining({ code: 'MEDICATION_DIAGNOSIS_REFERENCE_MISSING', path: 'catalog.medications[0].workflow.allowedDiagnosisCodes[0]' }),
    ]))

    const invalidInstallResponse = await runtime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(generated.datasetId)}/actions/install`,
      {
        body: JSON.stringify({ expectedVersion: 2 }),
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(invalidInstallResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await invalidInstallResponse.json())).toMatchObject({
      error: { code: 'DATASET_INVALID' },
    })

    const staleResponse = await update(1, randomUUID())
    expect(staleResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await staleResponse.json())).toMatchObject({
      error: { code: 'DATASET_VERSION_CONFLICT' },
    })
  })

  it('resets from an immutable package after its source Dataset is edited and deleted', async () => {
    const { password, runtime } = await createTestRuntime('clinmesh-scenario-package-http-')
    const cookie = await signInSyntheticAccount(runtime, password, 'admin@demo.clinmesh.local')
    const headers = (idempotencyKey = randomUUID()) => ({
      'content-type': 'application/json',
      cookie,
      'idempotency-key': idempotencyKey,
      origin: 'http://localhost',
    })
    const generateResponse = await runtime.app.request(
      '/api/sim/v1/scenario-datasets/actions/generate',
      {
        body: JSON.stringify({
          modules: ['type-2-diabetes'],
          name: '糖尿病门诊数据',
          population: { age: { maximum: 70, minimum: 45 }, count: 1, gender: 'male' },
          providerId: 'builtin',
          seeds: { clinical: 101, population: 202 },
          timeRange: { end: '2026-08-01', start: '2016-08-01' },
          timeZone: 'Asia/Shanghai',
        }),
        headers: headers(),
        method: 'POST',
      },
    )
    const generated = commandResponseSchema(scenarioDatasetSchema)
      .parse(await generateResponse.json()).data
    const generatedPatient = generated.content.patients[0]!
    expect(generatedPatient).toMatchObject({
      diagnosisSpace: { primary: expect.objectContaining({ code: 'E11.65' }) },
      encounter: { openingStatement: '这两个月总是口渴，水喝得很多，人也瘦了。' },
      investigations: expect.arrayContaining([
        expect.objectContaining({ catalogItemId: 'lab-hba1c', sourceLevel: 'L1' }),
      ]),
      patientKnowledge: expect.objectContaining({
        chiefComplaint: '口渴、多饮两个月，体重下降。',
      }),
      symptomResponses: expect.arrayContaining([
        expect.objectContaining({ id: 'symptom-foot-numbness', passive: true }),
      ]),
    })
    expect(generated.content.catalog.medications.find(item => (
      item.id === 'medication-metformin'
    ))).toMatchObject({
      drugConcept: { conceptId: 'drug-concept-metformin-hcl-500mg-oral-tablet' },
      product: {
        code: 'CM-NHSA-PRODUCT-METFORMIN',
        id: 'nhsa-medication-product:nhsa-medication-products-2026-08-07:CM-NHSA-PRODUCT-METFORMIN',
      },
      regulatoryVerification: { result: 'synthetic-match' },
    })
    const installResponse = await runtime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(generated.datasetId)}/actions/install`,
      {
        body: JSON.stringify({ expectedVersion: 1 }),
        headers: headers(),
        method: 'POST',
      },
    )
    expect(installResponse.status).toBe(200)
    const installed = commandResponseSchema(z.object({
      packageId: z.string().min(1),
      scenario: scenarioStateSchema,
    }).strict()).parse(await installResponse.json()).data
    expect(installed.scenario).toMatchObject({
      epoch: 'epoch-2',
      scenarioId: installed.packageId,
      scenarioRunId: 'scenario-run-2',
    })
    expect(runtime.database.driver.prepare(`
      SELECT policy_code, fact_code, trigger_code
      FROM scenario_reveal_policy
      WHERE workspace_id = ? AND epoch = ?
    `).all('workspace-demo', installed.scenario.epoch)).toEqual([{
      fact_code: `objective-primary-diagnosis-${generatedPatient.id}`,
      policy_code: `policy-primary-diagnosis-${generatedPatient.id}`,
      trigger_code: 'evaluator-only',
    }])
    const conditionResponse = await runtime.app.request(
      `/fhir/R5/Condition?patient=Patient/${generatedPatient.id}&_total=accurate`,
      { headers: { cookie } },
    )
    expect(conditionResponse.status).toBe(200)
    expect(fhirBundleSchema.parse(await conditionResponse.json())).toMatchObject({
      entry: expect.arrayContaining([
        expect.objectContaining({
          resource: expect.objectContaining({
            code: expect.objectContaining({ text: '2型糖尿病伴高血糖' }),
            resourceType: 'Condition',
          }),
        }),
      ]),
      total: 2,
    })

    const doctorCookie = await signInSyntheticAccount(
      runtime,
      password,
      'doctor@demo.clinmesh.local',
    )
    const clinicalCatalogResponse = await runtime.app.request(
      '/api/his/v1/catalogs/clinical',
      { headers: { cookie: doctorCookie } },
    )
    expect(clinicalCatalogResponse.status).toBe(200)
    expect(clinicalCatalogSchema.parse(await clinicalCatalogResponse.json())).toMatchObject({
      diagnoses: expect.arrayContaining([
        expect.objectContaining({ code: 'E11.65', nameZh: '2型糖尿病伴高血糖' }),
      ]),
      laboratory: expect.arrayContaining([
        expect.objectContaining({ id: 'lab-hba1c', nameZh: '糖化血红蛋白' }),
      ]),
      medications: expect.arrayContaining([
        expect.objectContaining({ id: 'medication-metformin', nameZh: '盐酸二甲双胍片' }),
        expect.objectContaining({ id: 'medication-amlodipine', nameZh: '苯磺酸氨氯地平片' }),
      ]),
    })
    const installedMedicationSnapshots = runtime.database.driver.prepare(`
      SELECT item_id, config_json FROM outpatient_catalog
      WHERE workspace_id = ? AND epoch = ? AND kind = 'medication'
      ORDER BY item_id
    `).all('workspace-demo', installed.scenario.epoch) as Array<{
      config_json: string
      item_id: string
    }>
    expect(installedMedicationSnapshots).toHaveLength(3)
    expect(installedMedicationSnapshots.map(row => ({
      config: JSON.parse(row.config_json) as unknown,
      id: row.item_id,
    }))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        config: expect.objectContaining({
          allowedDiagnosisCatalogItemIds: ['diagnosis-type-2-diabetes-hyperglycemia'],
          product: expect.objectContaining({
            id: 'nhsa-medication-product:nhsa-medication-products-2026-08-07:CM-NHSA-PRODUCT-METFORMIN',
          }),
          regulatoryVerification: expect.objectContaining({ result: 'synthetic-match' }),
        }),
        id: 'medication-metformin',
      }),
      expect.objectContaining({
        config: expect.objectContaining({
          allowedDiagnosisCatalogItemIds: ['diagnosis-hypertension'],
          product: expect.objectContaining({
            id: 'nhsa-medication-product:nhsa-medication-products-2026-08-07:CM-NHSA-PRODUCT-AMLODIPINE',
          }),
          regulatoryVerification: expect.objectContaining({ result: 'synthetic-match' }),
        }),
        id: 'medication-amlodipine',
      }),
    ]))
    expect(runtime.database.driver.prepare(`
      SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'reference_medication_product'
    `).get()).toBeUndefined()

    const registrarCookie = await signInSyntheticAccount(
      runtime,
      password,
      'registrar@demo.clinmesh.local',
    )
    const registrationCatalogResponse = await runtime.app.request(
      '/api/his/v1/catalogs/registration',
      { headers: { cookie: registrarCookie } },
    )
    expect(registrationCatalogResponse.status).toBe(200)
    expect(registrationCatalogSchema.parse(await registrationCatalogResponse.json())).toMatchObject({
      departments: expect.arrayContaining([
        expect.objectContaining({ id: 'department-general-medicine' }),
      ]),
      visitTypes: expect.arrayContaining([
        expect.objectContaining({ id: 'visit-general' }),
      ]),
    })

    for (const [resourceType, resourceId] of [
      ['Medication', 'medication-metformin'],
      ['InventoryItem', 'lot-metformin-synthetic-001'],
    ] as const) {
      const response = await runtime.app.request(`/fhir/R5/${resourceType}/${resourceId}`, {
        headers: { cookie },
      })
      expect(response.status).toBe(200)
      const resource = fhirResourceSchema.parse(await response.json())
      expect(resource).toMatchObject({
        id: resourceId,
        resourceType,
      })
      if (resourceType === 'Medication') {
        expect(resource).toMatchObject({
          code: {
            coding: expect.arrayContaining([
              expect.objectContaining({
                code: 'METFORMIN',
                system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/synthetic-medication',
              }),
              expect.objectContaining({
                code: 'CM-NHSA-PRODUCT-METFORMIN',
                system: 'urn:clinmesh:reference:nhsa-medication-product',
              }),
            ]),
          },
        })
      }
    }

    const editedContent = {
      ...generated.content,
      patients: [{ ...generated.content.patients[0]!, name: '已修改但不应进入快照' }],
    }
    const updateResponse = await runtime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(generated.datasetId)}`,
      {
        body: JSON.stringify({
          expectedVersion: 1,
          input: { content: editedContent, name: generated.name },
        }),
        headers: headers(),
        method: 'PUT',
      },
    )
    expect(updateResponse.status).toBe(200)

    const deleteIdempotencyKey = randomUUID()
    const deleteResponse = await runtime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(generated.datasetId)}`,
      {
        body: JSON.stringify({ expectedVersion: 2 }),
        headers: headers(deleteIdempotencyKey),
        method: 'DELETE',
      },
    )
    expect(deleteResponse.status).toBe(200)
    const deleteResult = commandResponseSchema(z.object({
      datasetId: z.string().min(1),
      deleted: z.literal(true),
    }).strict()).parse(await deleteResponse.json())
    expect(deleteResult).toMatchObject({
      data: { datasetId: generated.datasetId, deleted: true },
    })
    expect((await runtime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(generated.datasetId)}`,
      { headers: { cookie } },
    )).status).toBe(404)
    const deleteReplayResponse = await runtime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(generated.datasetId)}`,
      {
        body: JSON.stringify({ expectedVersion: 2 }),
        headers: headers(deleteIdempotencyKey),
        method: 'DELETE',
      },
    )
    expect(deleteReplayResponse.status).toBe(200)
    expect(commandResponseSchema(z.object({
      datasetId: z.string().min(1),
      deleted: z.literal(true),
    }).strict()).parse(await deleteReplayResponse.json())).toEqual(deleteResult)

    const resetResponse = await runtime.app.request(
      `/api/sim/v1/scenario-runs/${installed.scenario.scenarioRunId}/actions/reset`,
      { body: '{}', headers: headers(), method: 'POST' },
    )
    expect(resetResponse.status).toBe(200)
    expect(scenarioCommandResponseSchema.parse(await resetResponse.json()).data).toMatchObject({
      initialStateHash: installed.scenario.initialStateHash,
      scenarioId: installed.packageId,
    })
  })

  it('preserves a Dataset patient unknown gender through installation', async () => {
    const { password, runtime } = await createTestRuntime('clinmesh-scenario-gender-http-')
    const cookie = await signInSyntheticAccount(runtime, password, 'admin@demo.clinmesh.local')
    const headers = () => ({
      'content-type': 'application/json',
      cookie,
      'idempotency-key': randomUUID(),
      origin: 'http://localhost',
    })
    const generatedResponse = await runtime.app.request(
      '/api/sim/v1/scenario-datasets/actions/generate',
      {
        body: JSON.stringify({
          modules: ['fever'],
          name: '四态性别安装数据',
          population: { age: { maximum: 40, minimum: 40 }, count: 1, gender: 'female' },
          providerId: 'builtin',
          seeds: { clinical: 7331, population: 4242 },
          timeRange: { end: '2026-08-01', start: '2020-01-01' },
          timeZone: 'Asia/Shanghai',
        }),
        headers: headers(),
        method: 'POST',
      },
    )
    const generated = commandResponseSchema(scenarioDatasetSchema)
      .parse(await generatedResponse.json()).data
    const patient = generated.content.patients[0]!
    const updatedResponse = await runtime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(generated.datasetId)}`,
      {
        body: JSON.stringify({
          expectedVersion: 1,
          input: {
            content: {
              ...generated.content,
              patients: [{ ...patient, gender: 'unknown' }],
            },
            name: generated.name,
          },
        }),
        headers: headers(),
        method: 'PUT',
      },
    )
    expect(updatedResponse.status).toBe(200)
    const installResponse = await runtime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(generated.datasetId)}/actions/install`,
      {
        body: JSON.stringify({ expectedVersion: 2 }),
        headers: headers(),
        method: 'POST',
      },
    )
    expect(installResponse.status).toBe(200)

    const patientResponse = await runtime.app.request(`/fhir/R5/Patient/${patient.id}`, {
      headers: { cookie },
    })
    expect(patientResponse.status).toBe(200)
    expect(fhirResourceSchema.parse(await patientResponse.json())).toMatchObject({
      gender: 'unknown',
      id: patient.id,
      resourceType: 'Patient',
    })
  })

  it('lets only an administrator reset to one deterministic new Epoch per idempotency key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-reset-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)

    const signIn = async (email: string): Promise<string> => {
      const response = await runtime.app.request('/api/auth/sign-in/email', {
        body: JSON.stringify({ email, password }),
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost',
        },
        method: 'POST',
      })
      expect(response.status).toBe(200)
      return response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    }

    const registrarCookie = await signIn('registrar@demo.clinmesh.local')
    const forbiddenResponse = await runtime.app.request(
      '/api/sim/v1/scenario-runs/scenario-run-1/actions/reset',
      {
        body: '{}',
        headers: {
          'content-type': 'application/json',
          cookie: registrarCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(forbiddenResponse.status).toBe(403)
    expect(apiErrorSchema.parse(await forbiddenResponse.json())).toMatchObject({ error: { code: 'ROLE_NOT_ALLOWED' } })

    const adminCookie = await signIn('admin@demo.clinmesh.local')
    const missingIdempotencyResponse = await runtime.app.request(
      '/api/sim/v1/scenario-runs/scenario-run-1/actions/reset',
      {
        body: '{}',
        headers: {
          'content-type': 'application/json',
          cookie: adminCookie,
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(missingIdempotencyResponse.status).toBe(400)
    expect(apiErrorSchema.parse(await missingIdempotencyResponse.json())).toMatchObject({
      error: { code: 'INVALID_INPUT' },
    })

    const initialResponse = await runtime.app.request('/api/sim/v1/scenario-runs/current', {
      headers: { cookie: adminCookie },
    })
    expect(initialResponse.status).toBe(200)
    const initial = scenarioStateSchema.parse(await initialResponse.json())
    expect(initial).toMatchObject({
      epoch: 'epoch-1',
      scenarioRunId: 'scenario-run-1',
    })

    const idempotencyKey = randomUUID()
    const reset = () => runtime.app.request(
      `/api/sim/v1/scenario-runs/${initial.scenarioRunId}/actions/reset`,
      {
        body: JSON.stringify({
          epoch: 'epoch-forged',
          workspaceId: 'workspace-forged',
        }),
        headers: {
          'content-type': 'application/json',
          cookie: adminCookie,
          'idempotency-key': idempotencyKey,
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    const resetResponse = await reset()
    expect(resetResponse.status).toBe(200)
    const resetResult = scenarioCommandResponseSchema.parse(await resetResponse.json())
    expect(resetResult.data).toMatchObject({
      epoch: 'epoch-2',
      initialStateHash: initial.initialStateHash,
      scenarioRunId: 'scenario-run-2',
      workspaceId: 'workspace-demo',
    })

    const replayResponse = await reset()
    expect(replayResponse.status).toBe(200)
    expect(scenarioCommandResponseSchema.parse(await replayResponse.json())).toEqual(resetResult)

    const currentResponse = await runtime.app.request('/api/sim/v1/scenario-runs/current', {
      headers: { cookie: adminCookie },
    })
    expect(scenarioStateSchema.parse(await currentResponse.json())).toMatchObject({
      epoch: 'epoch-2',
      initialStateHash: initial.initialStateHash,
      scenarioRunId: 'scenario-run-2',
    })
  })

  it('installs the density Scenario through the administrator seam without accepting an unreviewed golden label', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-install-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const signInResponse = await runtime.app.request('/api/auth/sign-in/email', {
      body: JSON.stringify({
        email: 'admin@demo.clinmesh.local',
        password,
      }),
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    const cookie = signInResponse.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    const install = (kind: string, idempotencyKey = randomUUID()) => runtime.app.request(
      '/api/sim/v1/scenarios/actions/install',
      {
        body: JSON.stringify({ kind }),
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': idempotencyKey,
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )

    const goldenResponse = await install('golden')
    expect(goldenResponse.status).toBe(400)
    expect(apiErrorSchema.parse(await goldenResponse.json())).toMatchObject({ error: { code: 'INVALID_INPUT' } })

    const idempotencyKey = randomUUID()
    const densityResponse = await install('density', idempotencyKey)
    expect(densityResponse.status).toBe(200)
    const density = scenarioCommandResponseSchema.parse(await densityResponse.json())
    expect(density.data).toMatchObject({
      epoch: 'epoch-2',
      kind: 'density',
      scenarioId: 'density-fever-outpatient-v3',
      scenarioRunId: 'scenario-run-2',
    })
    expect(scenarioCommandResponseSchema.parse(
      await (await install('density', idempotencyKey)).json(),
    )).toEqual(density)

    const selectRegistrarResponse = await runtime.app.request('/api/auth/role', {
      body: JSON.stringify({ practitionerRoleId: 'practitioner-role-registrar' }),
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(selectRegistrarResponse.status).toBe(200)
    const patientPage = async (page: number) => {
      const response = await runtime.app.request(
        `/api/his/v1/patients?query=${encodeURIComponent('合成密度')}&pageSize=25&page=${page}`,
        { headers: { cookie } },
      )
      return {
        body: patientSearchSchema.parse(await response.json()),
        status: response.status,
      }
    }
    const firstPatientPage = await patientPage(1)
    const secondPatientPage = await patientPage(2)
    expect(firstPatientPage).toMatchObject({
      body: { page: 1, pageSize: 25, total: 120 },
      status: 200,
    })
    expect(secondPatientPage).toMatchObject({
      body: { page: 2, pageSize: 25, total: 120 },
      status: 200,
    })
    expect(firstPatientPage.body.items).toHaveLength(25)
    expect(secondPatientPage.body.items).toHaveLength(25)
    expect(new Set([
      ...firstPatientPage.body.items.map(item => item.id),
      ...secondPatientPage.body.items.map(item => item.id),
    ])).toHaveProperty('size', 50)
    const invalidPatientPage = await runtime.app.request(
      `/api/his/v1/patients?query=${encodeURIComponent('合成密度')}&pageSize=25&page=0`,
      { headers: { cookie } },
    )
    expect(invalidPatientPage.status).toBe(400)

    for (const [resourceType, total] of [
      ['Organization', 1],
      ['Location', 8],
      ['Practitioner', 6],
      ['PractitionerRole', 6],
      ['Medication', 4],
    ] as const) {
      const response = await runtime.app.request(
        `/fhir/R5/${resourceType}?_count=20&_total=accurate`,
        { headers: { cookie } },
      )
      expect(response.status).toBe(200)
      expect(fhirBundleSchema.parse(await response.json())).toMatchObject({ total })
    }
    const patientsResponse = await runtime.app.request(
      '/fhir/R5/Patient?_count=25&_total=accurate',
      { headers: { cookie } },
    )
    expect(patientsResponse.status).toBe(200)
    expect(fhirBundleSchema.parse(await patientsResponse.json())).toMatchObject({
      entry: expect.any(Array),
      link: [
        expect.objectContaining({ relation: 'self' }),
        expect.objectContaining({ relation: 'next' }),
      ],
      total: 120,
    })
  })
})
