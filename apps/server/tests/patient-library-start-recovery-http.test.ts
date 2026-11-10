import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiErrorSchema, commandResponseSchema, registrationCatalogSchema, registrationQueueSchema } from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { patientPersonaRevisionSchema, scenarioGenerationJobSchema, startSyntheticCaseResultSchema, syntheticCaseInstanceSchema, syntheticPatientProfileDetailSchema } from '@clinmesh/contracts/scenario'
import { expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { persona, signIn, StubSyntheaProvider } from './fixtures/consultation.ts'

it('recovers an administrator patient-library start after a runtime restart without creating a second visit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-library-start-recovery-'))
  const options = {
    authBaseUrl: 'http://localhost',
    authSecret: 'synthetic-library-test-secret-with-at-least-32-characters',
    cursorSecret: 'synthetic-library-cursor-secret-with-at-least-32-characters',
    databasePath: join(directory, 'clinmesh.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!',
    syntheaProvider: new StubSyntheaProvider(),
    trustedOrigins: ['http://localhost'],
  }
  let runtime = await createClinMeshRuntime({ ...options, migrationMode: 'apply' })
  let closed = false
  try {
    const cookie = await signIn(runtime, 'admin@demo.clinmesh.local')
    const request = (path: string, body: unknown, key = randomUUID(), method = 'POST') => runtime.app.request(path, {
      body: JSON.stringify(body), method,
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost', 'idempotency-key': key },
    })
    const generationResponse = await request('/api/sim/v1/scenario-generation-jobs', {
      name: '合成患者库恢复', population: { age: { maximum: 65, minimum: 18 }, count: 1, gender: 'any' },
      providerId: 'synthea', seeds: { clinical: 7331, population: 4242 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' }, timeZone: 'Asia/Shanghai',
    })
    expect(generationResponse.status).toBe(200)
    const queued = commandResponseSchema(scenarioGenerationJobSchema).parse(await generationResponse.json()).data
    const generated = await runtime.scenarioData.processNextGenerationJob()
    expect(generated).toMatchObject({ jobId: queued.jobId, status: 'succeeded' })
    const caseId = generated?.caseIds[0], profileId = generated?.profileIds[0]
    if (caseId === undefined || profileId === undefined) throw new Error('Missing generated synthetic patient')
    const casePath = `/api/sim/v1/synthetic-cases/${caseId}`
    const revisionResponse = await request(`${casePath}/patient-persona-revisions`, { input: { content: persona } })
    expect(revisionResponse.status).toBe(200)
    const revision = commandResponseSchema(patientPersonaRevisionSchema).parse(await revisionResponse.json()).data
    const before = syntheticCaseInstanceSchema.parse(await (await runtime.app.request(casePath, { headers: { cookie } })).json())
    const activatedResponse = await request(`${casePath}/patient-persona-revisions/active`, {
      personaRevision: revision.revision, expectedCaseRevision: before.revision,
    }, randomUUID(), 'PUT')
    expect(activatedResponse.status).toBe(200)
    const ready = commandResponseSchema(syntheticCaseInstanceSchema).parse(await activatedResponse.json()).data
    expect(ready.status).toBe('brief-ready')
    const catalog = registrationCatalogSchema.parse(await (await runtime.app.request('/api/his/v1/catalogs/registration', { headers: { cookie } })).json())
    const department = catalog.departments[0], location = catalog.locations[0], visitType = catalog.visitTypes[0]
    if (department === undefined || location === undefined || visitType === undefined) throw new Error('Missing registration catalog')
    const body = {
      activeBriefRevision: revision.revision, expectedCaseRevision: ready.revision,
      departmentId: department.id, locationId: location.id, visitDate: catalog.virtualDate, visitTypeId: visitType.id,
    }
    const key = randomUUID(), operationId = 'registration.synthetic-case.start'
    const receiptPath = `/api/his/v1/command-receipts?${new URLSearchParams({ operationId, idempotencyKey: key })}`
    const absent = await runtime.app.request(receiptPath, { headers: { cookie } })
    expect(absent.status).toBe(404)
    expect(apiErrorSchema.parse(await absent.json()).error.code).toBe('COMMAND_RECEIPT_NOT_FOUND')
    const startPath = `/api/his/v1/synthetic-cases/${caseId}/actions/start-outpatient-visit`
    const startedResponse = await request(startPath, body, key)
    expect(startedResponse.status).toBe(200)
    const started = commandResponseSchema(startSyntheticCaseResultSchema).parse(await startedResponse.json())
    expect(started.data.syntheticCaseId).toBe(caseId)

    await runtime.close()
    closed = true
    runtime = await createClinMeshRuntime({ ...options, migrationMode: 'verify' })
    closed = false
    const receiptResponse = await runtime.app.request(receiptPath, { headers: { cookie } })
    expect(receiptResponse.status).toBe(200)
    const receipt = commandReceiptLookupSchema.parse(await receiptResponse.json())
    expect(receipt).toMatchObject({ operationId, idempotencyKey: key, status: 'completed' })
    expect(commandResponseSchema(startSyntheticCaseResultSchema).parse(receipt.response)).toEqual(started)
    const replay = await request(startPath, body, key)
    expect(replay.status).toBe(200)
    expect(commandResponseSchema(startSyntheticCaseResultSchema).parse(await replay.json())).toEqual(started)
    const duplicate = await request(startPath, body)
    expect(duplicate.status).toBe(409)
    const profile = syntheticPatientProfileDetailSchema.parse(await (await runtime.app.request(`/api/sim/v1/synthetic-patients/${profileId}`, { headers: { cookie } })).json())
    expect(profile.case).toMatchObject({ caseId, status: 'started' })
    const registrar = await signIn(runtime, 'registrar@demo.clinmesh.local')
    const queueResponse = await runtime.app.request('/api/his/v1/registrations?page=1&pageSize=20', { headers: { cookie: registrar } })
    expect(queueResponse.status).toBe(200)
    const queue = registrationQueueSchema.parse(await queueResponse.json())
    expect(queue.items.filter(item => item.encounterId === started.data.encounterId)).toHaveLength(1)
    const otherActor = await runtime.app.request(receiptPath, { headers: { cookie: registrar } })
    expect(otherActor.status).toBe(404)
    expect(apiErrorSchema.parse(await otherActor.json()).error.code).toBe('COMMAND_RECEIPT_NOT_FOUND')
  } finally {
    if (!closed) await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
