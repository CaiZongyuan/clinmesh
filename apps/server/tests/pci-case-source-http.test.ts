import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { inpatientCommandResponseSchema, inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { inpatientPciDataResponseSchema, pciCaseSourceResponseSchema, startSyntheticInpatientCaseResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'
import { patientPersonaRevisionSchema, syntheticCaseInstanceSchema, syntheticPatientProfileListSchema } from '@clinmesh/contracts/scenario'
import { patientSearchSchema, registrationQueueSchema, sessionContextSchema } from '@clinmesh/contracts/his'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-pci-source-'))
  const password = `Synthetic-${randomUUID()}-Aa1!`
  let modelCalls = 0
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost', authSecret: randomUUID() + randomUUID(),
    cursorSecret: randomUUID() + randomUUID(), demoPassword: password,
    databasePath: join(directory, 'hospital.sqlite'), migrationMode: 'apply', trustedOrigins: ['http://localhost'],
    chatCompletionsProvider: { async completeJson() { modelCalls++; throw new Error('固定 PCI 来源不应调用模型') } },
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
  return { runtime, login, post, modelCalls: () => modelCalls }
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
  const { ready, persona } = await readyPciCase(s, admin)
  const key = randomUUID(), body = { activeBriefRevision: persona.revision, expectedCaseRevision: ready.revision, expectedEpoch: 'epoch-1', wardId: 'ward-general' }
  const path = `/api/his/v1/synthetic-cases/${ready.caseId}/actions/start-inpatient-visit`
  expect((await s.post(admin, path, body)).status).toBe(403)
  expect((await s.post(registrar, path, { ...body, expectedEpoch: 'stale-epoch' })).status).toBe(409)
  expect((await s.post(registrar, path, { ...body, wardId: 'missing-ward' })).status).toBe(404)
  const emptyPatients = patientSearchSchema.parse(await (await s.runtime.app.request(`/api/his/v1/patients?query=${encodeURIComponent('合成冠脉病例甲')}`, { headers: { cookie: registrar } })).json())
  expect(emptyPatients.total).toBe(0)
  const emptyAdmissions = inpatientListSchema.parse(await (await s.runtime.app.request('/api/his/v1/inpatient/admissions', { headers: { cookie: registrar } })).json())
  expect(emptyAdmissions.items).toEqual([])
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
  const admitted = inpatientCommandResponseSchema.parse(await received.json()).data.admission
  expect(admitted.status).toBe('admitted')
  const data = inpatientPciDataResponseSchema.parse(await (await s.post(admin, '/api/his/v1/inpatient/pci-data/prepare', { input: { expectedEpoch: 'epoch-1' } })).json()).data
  const service = data.package.laboratories.find(item => item.referenceConcept.code === '6690-2')!
  const doctor = await s.login('inpatient-doctor'), admissionPath = `/api/his/v1/inpatient/admissions/${admitted.id}`
  const issued = await s.post(doctor, `${admissionPath}/investigations/issue`, { input: {
    encounterVersion: admitted.versionId, catalogVersion: service.version,
    selection: { kind: 'laboratory', catalogItemId: service.id, indicationCode: 'clinical-assessment' },
  } })
  expect(issued.status).toBe(200)
  const lab = inpatientInvestigationsSchema.parse((await issued.json()).data).laboratoryRequests[0]!
  const sent = await s.post(nurse, `${admissionPath}/investigations/send`, { input: {
    requestId: lab.id, expectedRequestVersion: lab.version, serviceRequestVersion: lab.serviceRequestVersion, taskVersion: lab.taskVersion,
  } })
  expect(sent.status).toBe(200)
  while (await s.runtime.dispatcher.dispatchOnce() !== undefined) { /* drain the bounded clinical outbox */ }
  const reported = inpatientInvestigationsSchema.parse(await (await s.runtime.app.request(`${admissionPath}/investigations`, { headers: { cookie: doctor } })).json()).laboratoryRequests[0]!
  expect(reported.status).toBe('reported')
  expect(reported.report!.results).toEqual([expect.objectContaining({ code: '6690-2', value: 6.2, unit: { code: '10*9/L', display: '10*9/L', system: 'http://unitsofmeasure.org' } })])
  const provenances = fhirBundleSchema.parse(await (await s.runtime.app.request(`/fhir/R5/Provenance?target=DiagnosticReport/${reported.report!.diagnosticReportId}`, { headers: { cookie: doctor } })).json())
  expect(provenances.entry?.map(entry => entry.resource?.activity)).toContainEqual({ text: 'Laboratory report issuance from case-truth-exact' })
  expect(s.modelCalls()).toBe(0)
})

it.each(['completed', 'closed'] as const)('%s Run 可重放直接入院原回执，但拒绝新入院意图', async status => {
  const s = await setup(), admin = await s.login('admin'), registrar = await s.login('registrar')
  const { ready, persona } = await readyPciCase(s, admin)
  const key = randomUUID(), body = { activeBriefRevision: persona.revision, expectedCaseRevision: ready.revision, expectedEpoch: 'epoch-1', wardId: 'ward-general' }
  const path = `/api/his/v1/synthetic-cases/${ready.caseId}/actions/start-inpatient-visit`
  const first = await s.post(registrar, path, body, key)
  expect(first.status).toBe(200)
  const started = startSyntheticInpatientCaseResponseSchema.parse(await first.json())
  // 仅设置生命周期前置，回执恢复与拒绝结果仍经真实认证 HTTP 验证。
  s.runtime.database.driver.prepare('UPDATE scenario_run SET status=? WHERE scenario_run_id=?').run(status, 'scenario-run-1')

  const replay = await s.post(registrar, path, body, key)
  expect(replay.status).toBe(200)
  expect(startSyntheticInpatientCaseResponseSchema.parse(await replay.json())).toEqual(started)
  const changed = await s.post(registrar, path, { ...body, wardId: 'missing-ward' }, key)
  expect(changed.status).toBe(409)
  expect(await changed.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } })
  const fresh = await s.post(registrar, path, body)
  expect(fresh.status).toBe(409)
  expect(await fresh.json()).toMatchObject({ error: { code: 'CONTEXT_INACTIVE' } })
  const admissions = inpatientListSchema.parse(await (await s.runtime.app.request('/api/his/v1/inpatient/admissions', { headers: { cookie: registrar } })).json())
  expect(admissions.items.map(item => item.id)).toEqual([started.data.admissionId])
  expect(s.modelCalls()).toBe(0)
})

it('来源准备拒绝非管理员、失效Epoch、缺少Origin及任意病例载荷', async () => {
  const s = await setup(), admin = await s.login('admin'), registrar = await s.login('registrar')
  const path = '/api/sim/v1/synthetic-cases/pci/prepare'
  expect((await s.post(registrar, path, { input: { expectedEpoch: 'epoch-1' } })).status).toBe(403)
  const stale = await s.post(admin, path, { input: { expectedEpoch: 'stale-epoch' } })
  expect(stale.status).toBe(409)
  expect(await stale.json()).toMatchObject({ error: { code: 'PCI_SOURCE_EPOCH_CONFLICT' } })
  expect((await s.post(admin, path, { input: { expectedEpoch: 'epoch-1', bundle: {} } })).status).toBe(400)
  const originMissing = await s.runtime.app.request(path, { method: 'POST', headers: { cookie: admin,
    'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ input: { expectedEpoch: 'epoch-1' } }) })
  expect(originMissing.status).toBe(403)
  expect(syntheticPatientProfileListSchema.parse(await (await s.runtime.app.request('/api/sim/v1/synthetic-patients', { headers: { cookie: admin } })).json()).total).toBe(0)
})

async function readyPciCase(s: Awaited<ReturnType<typeof setup>>, admin: string, epoch = 'epoch-1') {
  const prepared = pciCaseSourceResponseSchema.parse(await (await s.post(admin,
    '/api/sim/v1/synthetic-cases/pci/prepare', { input: { expectedEpoch: epoch } })).json()).data
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
  return { ready, persona, prepared }
}

it('保留患者库重置会重放直接住院，清空后准备新病例身份仍可再次直接入院', async () => {
  const s = await setup(), admin = await s.login('admin'), registrar = await s.login('registrar')
  const readProfiles = async () => syntheticPatientProfileListSchema.parse(await (await s.runtime.app.request('/api/sim/v1/synthetic-patients', { headers: { cookie: admin } })).json())
  const context = async () => sessionContextSchema.parse(await (await s.runtime.app.request('/api/auth/context', { headers: { cookie: admin } })).json()).actor
  const start = async (ready: Awaited<ReturnType<typeof readyPciCase>>['ready'], epoch: string) => {
    const response = await s.post(registrar, `/api/his/v1/synthetic-cases/${ready.caseId}/actions/start-inpatient-visit`, {
      activeBriefRevision: ready.activeBriefRevision, expectedCaseRevision: ready.revision, expectedEpoch: epoch, wardId: 'ward-general',
    })
    expect(response.status).toBe(200)
    return startSyntheticInpatientCaseResponseSchema.parse(await response.json()).data
  }
  const original = await readyPciCase(s, admin)
  const first = await start(original.ready, 'epoch-1')
  expect((await readProfiles()).items.find(item => item.profileId === original.prepared.profileId)?.activeVisit).toBe(true)
  const reset = async (clearPatientLibrary: boolean) => {
    const current = await context()
    const response = await s.post(admin, `/api/sim/v1/scenario-runs/${current.scenarioRunId}/actions/reset`, { clearPatientLibrary })
    expect(response.status).toBe(200)
    return context()
  }
  await reset(false)
  const replayed = inpatientListSchema.parse(await (await s.runtime.app.request('/api/his/v1/inpatient/admissions', { headers: { cookie: registrar } })).json())
  expect(replayed.items).toHaveLength(1)
  expect(replayed.items[0]).toMatchObject({ status: 'registered', depositFen: 0, chargesFen: 0 })
  expect(replayed.items[0]!.id).not.toBe(first.admissionId)
  expect((await readProfiles()).items.find(item => item.profileId === original.prepared.profileId)?.activeVisit).toBe(true)
  const registrations = registrationQueueSchema.parse(await (await s.runtime.app.request('/api/his/v1/registrations', { headers: { cookie: registrar } })).json())
  expect(registrations.total).toBe(0)
  const cleared = await reset(true)
  expect((await readProfiles()).total).toBe(0)
  const next = await readyPciCase(s, admin, cleared.epoch)
  expect(next.prepared.profileId).toBe(original.prepared.profileId)
  expect(next.prepared.sourceHash).toBe(original.prepared.sourceHash)
  expect(next.ready.profileRevision).toBe(original.ready.profileRevision + 1)
  expect(next.ready.caseId).not.toBe(original.ready.caseId)
  await start(next.ready, cleared.epoch)
})
