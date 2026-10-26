import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { inpatientCommandResponseSchema, inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { pciCaseSourceResponseSchema, startSyntheticInpatientCaseResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { patientPersonaRevisionSchema, syntheticCaseInstanceSchema } from '@clinmesh/contracts/scenario'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-pci-source-'))
  const password = `Synthetic-${randomUUID()}-Aa1!`
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost', authSecret: randomUUID() + randomUUID(),
    cursorSecret: randomUUID() + randomUUID(), demoPassword: password,
    databasePath: join(directory, 'hospital.sqlite'), migrationMode: 'apply', trustedOrigins: ['http://localhost'],
    chatCompletionsProvider: { async completeJson() { throw new Error('固定 PCI 来源不应调用模型') } },
  })
  cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  async function login(role: string) {
    const result = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email: `${role}@demo.clinmesh.local`, password }),
    })
    expect(result.status).toBe(200)
    return result.headers.get('set-cookie')!.split(';', 1)[0]!
  }
  function post(cookie: string, path: string, body: unknown, key = randomUUID()) {
    return runtime.app.request(path, { method: 'POST', headers: { cookie, origin: 'http://localhost',
      'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) })
  }
  return { runtime, login, post }
}

it('固定 PCI 来源准备生成独立作者来源和 Case Truth，可幂等读取且不产生就诊或收费', async () => {
  const s = await setup(), admin = await s.login('admin')
  const key = randomUUID()
  const first = await s.post(admin, '/api/sim/v1/synthetic-cases/pci/prepare', { input: { expectedEpoch: 'epoch-1' } }, key)
  expect(first.status).toBe(200)
  const prepared = await first.json()
  expect(prepared.data.case).toMatchObject({ status: 'brief-pending', revision: 1 })
  const profile = await (await s.runtime.app.request(`/api/sim/v1/synthetic-patients/${prepared.data.profileId}`, { headers: { cookie: admin } })).json()
  expect(profile.source).toMatchObject({ providerId: 'clinmesh-authored', hash: prepared.data.sourceHash })
  const truth = await (await s.runtime.app.request(`/api/sim/v1/admin/synthetic-cases/${prepared.data.case.caseId}/truth`, { headers: { cookie: admin } })).json()
  expect(truth.items.filter((item: { resource: { resourceType: string } }) => item.resource.resourceType === 'Observation')).toHaveLength(9)
  expect(truth.items.some((item: { resource: { resourceType: string } }) => item.resource.resourceType === 'Procedure')).toBe(false)
  const replay = await (await s.post(admin, '/api/sim/v1/synthetic-cases/pci/prepare', { input: { expectedEpoch: 'epoch-1' } }, key)).json()
  expect(replay).toEqual(prepared)
  const repeated = await (await s.post(admin, '/api/sim/v1/synthetic-cases/pci/prepare', { input: { expectedEpoch: 'epoch-1' } })).json()
  expect(repeated.data.case.caseId).toBe(prepared.data.case.caseId)
  expect(repeated.effects).toEqual([])
})

it('选用手工 Persona 后从固定来源直接入院，保留病例绑定、幂等回放且无门诊登记或费用', async () => {
  const s = await setup(), admin = await s.login('admin'), registrar = await s.login('registrar')
  const prepared = pciCaseSourceResponseSchema.parse(await (await s.post(admin,
    '/api/sim/v1/synthetic-cases/pci/prepare', { input: { expectedEpoch: 'epoch-1' } })).json()).data
  const casePath = `/api/sim/v1/synthetic-cases/${prepared.case.caseId}`
  const edit = await s.post(admin, `${casePath}/patient-persona-revisions`, { input: { content: {
    chiefComplaint: '活动后胸闷三个月，加重一周，休息可缓解。', knownHistorySummary: '无已知药物过敏，静息无胸痛。',
    medicationMemory: '近期未自行加药。', openingStatement: '医生您好，最近一活动胸口就闷，休息后会好。',
    persona: { attitude: '愿意配合检查', character: '平和', healthLiteracy: '普通', speechStyle: '简短清楚' },
    symptomExperience: '步行数百米后胸口闷，停下休息几分钟会缓解，没有晕厥。',
  } } })
  expect(edit.status).toBe(200)
  const persona = patientPersonaRevisionSchema.parse((await edit.json()).data)
  const selected = await s.runtime.app.request(`${casePath}/patient-persona-revisions/active`, { method: 'PUT',
    headers: { cookie: admin, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ personaRevision: persona.revision, expectedCaseRevision: prepared.case.revision }),
  })
  expect(selected.status).toBe(200)
  const ready = syntheticCaseInstanceSchema.parse((await selected.json()).data)
  const key = randomUUID(), body = { activeBriefRevision: persona.revision, expectedCaseRevision: ready.revision, expectedEpoch: 'epoch-1', wardId: 'ward-general' }
  const path = `/api/his/v1/synthetic-cases/${ready.caseId}/actions/start-inpatient-visit`
  const response = await s.post(registrar, path, body, key)
  expect(response.status).toBe(200)
  const started = startSyntheticInpatientCaseResponseSchema.parse(await response.json())
  expect(started.data).toMatchObject({ syntheticCaseId: ready.caseId, status: 'registered' })
  const admissions = inpatientListSchema.parse(await (await s.runtime.app.request('/api/his/v1/inpatient/admissions', { headers: { cookie: registrar } })).json())
  expect(admissions.items.filter(item => item.patientId === started.data.patientId)).toEqual([
    expect.objectContaining({ id: started.data.admissionId, admissionRoute: 'direct', depositFen: 0, chargesFen: 0 }),
  ])
  const replay = startSyntheticInpatientCaseResponseSchema.parse(await (await s.post(registrar, path, body, key)).json())
  expect(replay.auditId).toBe(started.auditId)
  expect((await s.post(registrar, path, body)).status).toBe(409)
  const nurse = await s.login('ward-nurse')
  const received = await s.post(nurse, `/api/his/v1/inpatient/admissions/${started.data.admissionId}/receive`, {
    input: { encounterVersion: admissions.items.find(item => item.id === started.data.admissionId)!.versionId, bedId: 'bed-general-1' },
  })
  expect(received.status).toBe(200)
  expect(inpatientCommandResponseSchema.parse(await received.json()).data.admission.status).toBe('admitted')
})
