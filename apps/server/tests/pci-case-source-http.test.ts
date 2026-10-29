import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { inpatientCommandResponseSchema, inpatientDetailSchema, inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { inpatientPciDataResponseSchema, pciCaseSourceResponseSchema, startSyntheticInpatientCaseResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'
import { administratorCaseTruthSchema, patientPersonaJobSchema, patientPersonaRevisionListSchema, patientPersonaRevisionSchema, syntheticCaseInstanceSchema, syntheticPatientProfileDetailSchema, syntheticPatientProfileListSchema } from '@clinmesh/contracts/scenario'
import { patientSearchSchema, registrationQueueSchema, sessionContextSchema } from '@clinmesh/contracts/his'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function setup(completePersona?: () => Promise<{ content: string; model: string }>) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-pci-source-'))
  const password = `Synthetic-${randomUUID()}-Aa1!`
  let modelCalls = 0
  const options = {
    authBaseUrl: 'http://localhost', authSecret: randomUUID() + randomUUID(),
    cursorSecret: randomUUID() + randomUUID(), demoPassword: password,
    databasePath: join(directory, 'hospital.sqlite'), migrationMode: 'apply' as const, trustedOrigins: ['http://localhost'],
    patientPersonaModel: 'synthetic',
    chatCompletionsProvider: { async completeJson() {
      modelCalls++
      if (completePersona !== undefined) return completePersona()
      throw new Error('固定 PCI 来源不应调用模型')
    } },
  }
  let runtime = await createClinMeshRuntime(options)
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
  return { get runtime() { return runtime }, login, post, modelCalls: () => modelCalls,
    async restart() { await runtime.close(); runtime = await createClinMeshRuntime(options) },
  }
}

it('固定 PCI 来源准备生成独立作者来源和 Case Truth，可幂等读取且不产生就诊或收费', async () => {
  const s = await setup(), admin = await s.login('admin')
  const doctor = await s.login('inpatient-doctor')
  const readClinicalFacts = () => Promise.all(['Patient', 'Encounter', 'Condition', 'DiagnosticReport', 'MedicationRequest', 'Procedure', 'ChargeItem'].map(async resourceType => {
    const response = await s.runtime.app.request(`/fhir/R5/${resourceType}`, { headers: { cookie: doctor } })
    expect(response.status).toBe(200)
    return fhirBundleSchema.parse(await response.json())
  }))
  const before = await readClinicalFacts()
  const key = randomUUID()
  const first = await s.post(admin, '/api/sim/v1/synthetic-cases/pci/prepare', { input: { expectedEpoch: 'epoch-1' } }, key)
  expect(first.status).toBe(200)
  const prepared = pciCaseSourceResponseSchema.parse(await first.json())
  expect(prepared.data.case).toMatchObject({ status: 'brief-ready', revision: 2, activeBriefRevision: 1 })
  const personas = patientPersonaRevisionListSchema.parse(await (await s.runtime.app.request(
    `/api/sim/v1/synthetic-cases/${prepared.data.case.caseId}/patient-persona-revisions`, { headers: { cookie: admin } },
  )).json())
  expect(personas.activeRevision).toBe(1)
  expect(personas.items).toHaveLength(1)
  expect(personas.items[0]).toMatchObject({ model: 'clinmesh-authored-template', content: {
    chiefComplaint: '活动后胸闷三个月，加重一周，休息可缓解。',
    openingStatement: '医生您好，最近一活动胸口就闷，休息后会好。',
    knownHistorySummary: '无已知药物过敏，静息无胸痛。', medicationMemory: '近期未自行加药。',
    symptomExperience: '步行数百米后胸口闷，停下休息几分钟会缓解，没有晕厥。',
    persona: { attitude: '愿意配合检查', character: '平和', healthLiteracy: '普通', speechStyle: '简短清楚' },
  } })
  const profile = syntheticPatientProfileDetailSchema.parse(await (await s.runtime.app.request(`/api/sim/v1/synthetic-patients/${prepared.data.profileId}`, { headers: { cookie: admin } })).json())
  expect(profile.source).toMatchObject({ providerId: 'clinmesh-authored', hash: prepared.data.sourceHash })
  const truth = administratorCaseTruthSchema.parse(await (await s.runtime.app.request(`/api/sim/v1/admin/synthetic-cases/${prepared.data.case.caseId}/truth`, { headers: { cookie: admin } })).json())
  expect(truth.items.filter((item: { resource: { resourceType: string } }) => item.resource.resourceType === 'Observation')).toHaveLength(9)
  expect(truth.items.some((item: { resource: { resourceType: string } }) => item.resource.resourceType === 'Procedure')).toBe(false)
  const replay = await (await s.post(admin, '/api/sim/v1/synthetic-cases/pci/prepare', { input: { expectedEpoch: 'epoch-1' } }, key)).json()
  expect(replay).toEqual(prepared)
  const repeated = await (await s.post(admin, '/api/sim/v1/synthetic-cases/pci/prepare', { input: { expectedEpoch: 'epoch-1' } })).json()
  expect(repeated.data.case.caseId).toBe(prepared.data.case.caseId)
  expect(repeated.effects).toEqual([])
  await s.runtime.dispatchPatientPersonaJobs()
  await s.runtime.dispatchScenarioGenerationJobs()
  await s.runtime.dispatchPending()
  expect(await readClinicalFacts()).toEqual(before)
  expect(s.modelCalls()).toBe(0)
})

it('重复准备保护已选人工修订及未选工作稿，不回退首个模板', async () => {
  const s = await setup(), admin = await s.login('admin')
  const original = await readyPciCase(s, admin)
  const path = `/api/sim/v1/synthetic-cases/${original.ready.caseId}`
  const content = { ...original.persona.content, openingStatement: '医生您好，最近胸口发闷，我想再检查一下。' }
  const edited = await s.post(admin, `${path}/patient-persona-revisions`, { input: { content } })
  expect(edited.status).toBe(200)
  const manual = patientPersonaRevisionSchema.parse((await edited.json()).data)
  const selection = await s.runtime.app.request(`${path}/patient-persona-revisions/active`, { method: 'PUT',
    headers: { cookie: admin, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ personaRevision: manual.revision, expectedCaseRevision: original.ready.revision }),
  })
  expect(selection.status).toBe(200)
  const selected = syntheticCaseInstanceSchema.parse((await selection.json()).data)
  expect((await s.post(admin, `${path}/patient-persona-revisions`, { input: { content: { ...content, medicationMemory: '尚未选用的人工工作稿。' } } })).status).toBe(200)
  const readRevisions = async () => patientPersonaRevisionListSchema.parse(await (await s.runtime.app.request(`${path}/patient-persona-revisions`, { headers: { cookie: admin } })).json())
  const before = await readRevisions()
  const repeated = pciCaseSourceResponseSchema.parse(await (await s.post(admin, '/api/sim/v1/synthetic-cases/pci/prepare', { input: { expectedEpoch: 'epoch-1' } })).json())
  expect(repeated.data.case).toEqual(selected)
  expect(repeated.effects).toEqual([])
  expect(await readRevisions()).toEqual(before)
  expect(s.modelCalls()).toBe(0)
})

it.each([false, true])('旧版未选来源保留原键回执，新准备补齐就绪（已有人工修订：%s）', async manual => {
  const s = await setup(), admin = await s.login('admin'), key = randomUUID()
  const preparePath = '/api/sim/v1/synthetic-cases/pci/prepare', body = { input: { expectedEpoch: 'epoch-1' } }
  const initial = pciCaseSourceResponseSchema.parse(await (await s.post(admin, preparePath, body, key)).json())
  const casePath = `/api/sim/v1/synthetic-cases/${initial.data.case.caseId}`
  // 安装旧版本持久化前置：已有来源及原回执，但没有自动模板或活动档案。
  const legacy = { ...initial, data: { ...initial.data, case: { ...initial.data.case, status: 'brief-pending', activeBriefRevision: null, revision: 1 } } }
  s.runtime.database.driver.prepare('UPDATE synthetic_case_instance SET active_brief_revision=NULL, status=?, revision=1 WHERE case_id=?').run('brief-pending', initial.data.case.caseId)
  s.runtime.database.driver.prepare('DELETE FROM patient_persona_revision WHERE case_id=?').run(initial.data.case.caseId)
  s.runtime.database.driver.prepare('UPDATE command_receipt SET response_json=? WHERE idempotency_key=?').run(JSON.stringify(legacy), key)
  if (manual) {
    const persona = { chiefComplaint: '一活动就胸闷。', openingStatement: '医生您好，我走路胸闷。', knownHistorySummary: '无已知药物过敏。', medicationMemory: '未自行加药。', symptomExperience: '停下休息会缓解。',
      persona: { attitude: '愿意配合', character: '平和', healthLiteracy: '普通', speechStyle: '简短' } }
    for (const openingStatement of ['第一份人工档案。', '保留这份最新人工档案。']) {
      expect((await s.post(admin, `${casePath}/patient-persona-revisions`, { input: { content: { ...persona, openingStatement } } })).status).toBe(200)
    }
  }
  expect(pciCaseSourceResponseSchema.parse(await (await s.post(admin, preparePath, body, key)).json())).toEqual(legacy)
  const upgraded = pciCaseSourceResponseSchema.parse(await (await s.post(admin, preparePath, body)).json())
  expect(upgraded.data.case).toMatchObject({ caseId: initial.data.case.caseId, status: 'brief-ready', activeBriefRevision: manual ? 2 : 1, profileRevision: 1 })
  const revisions = patientPersonaRevisionListSchema.parse(await (await s.runtime.app.request(`${casePath}/patient-persona-revisions`, { headers: { cookie: admin } })).json())
  expect(revisions.items).toHaveLength(manual ? 2 : 1)
  expect(revisions.items[0]).toMatchObject(manual
    ? { model: 'administrator-manual', content: { openingStatement: '保留这份最新人工档案。' } }
    : { model: 'clinmesh-authored-template' })
  expect(s.modelCalls()).toBe(0)
})

it.each([false, true])('旧版排队 Persona 在固定准备和重启后不再派发（已有人工修订：%s）', async manual => {
  const s = await setup(), admin = await s.login('admin'), registrar = await s.login('registrar')
  const original = await pendingPciCase(s, admin)
  const caseId = original.ready.caseId
  if (manual) expect((await s.post(admin, `/api/sim/v1/synthetic-cases/${caseId}/patient-persona-revisions`, {
    input: { content: original.persona.content },
  })).status).toBe(200)
  const jobs = []
  for (let index = 0; index < 2; index++) {
    const queued = await s.post(admin, `/api/sim/v1/synthetic-cases/${caseId}/patient-persona-jobs`, {})
    expect(queued.status).toBe(200)
    jobs.push(patientPersonaJobSchema.parse((await queued.json()).data))
  }
  const prepared = pciCaseSourceResponseSchema.parse(await (await s.post(admin,
    '/api/sim/v1/synthetic-cases/pci/prepare', { input: { expectedEpoch: 'epoch-1' } })).json())
  await s.restart()
  await s.runtime.dispatchPatientPersonaJobs()
  expect(s.modelCalls()).toBe(0)
  for (const job of jobs) {
    const stopped = patientPersonaJobSchema.parse(await (await s.runtime.app.request(
      `/api/sim/v1/patient-persona-jobs/${job.jobId}`, { headers: { cookie: admin } },
    )).json())
    expect(stopped).toMatchObject({ status: 'failed', error: { code: 'PERSONA_JOB_SUPERSEDED' }, resultRevision: null })
    expect(prepared.effects).toContainEqual({ kind: 'updated', reference: `PatientPersonaJob/${job.jobId}`, versionId: 'failed' })
  }
  const revisions = patientPersonaRevisionListSchema.parse(await (await s.runtime.app.request(
    `/api/sim/v1/synthetic-cases/${caseId}/patient-persona-revisions`, { headers: { cookie: admin } },
  )).json())
  expect(revisions.items).toHaveLength(1)
  expect(revisions.items[0]!.model).toBe(manual ? 'administrator-manual' : 'clinmesh-authored-template')
  expect((await s.post(registrar, `/api/his/v1/synthetic-cases/${caseId}/actions/start-inpatient-visit`, {
    activeBriefRevision: prepared.data.case.activeBriefRevision, expectedCaseRevision: prepared.data.case.revision,
    expectedEpoch: 'epoch-1', wardId: 'ward-general',
  })).status).toBe(200)
})

it('旧版 Persona 正在生成时拒绝固定准备，原任务完成后可沿原键继续', async () => {
  let markEntered!: () => void
  const entered = new Promise<void>(resolve => { markEntered = resolve })
  let finish!: (value: { content: string; model: string }) => void
  const completion = new Promise<{ content: string; model: string }>(resolve => { finish = resolve })
  const s = await setup(async () => { markEntered(); return completion }), admin = await s.login('admin')
  const original = await pendingPciCase(s, admin), caseId = original.ready.caseId
  const queued = await s.post(admin, `/api/sim/v1/synthetic-cases/${caseId}/patient-persona-jobs`, {})
  const job = patientPersonaJobSchema.parse((await queued.json()).data)
  const processing = s.runtime.dispatchPatientPersonaJobs()
  await entered
  const key = randomUUID(), path = '/api/sim/v1/synthetic-cases/pci/prepare', body = { input: { expectedEpoch: 'epoch-1' } }
  try {
    const rejected = await s.post(admin, path, body, key)
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ error: { code: 'PCI_SOURCE_PERSONA_RUNNING' } })
    const pending = patientPersonaRevisionListSchema.parse(await (await s.runtime.app.request(
      `/api/sim/v1/synthetic-cases/${caseId}/patient-persona-revisions`, { headers: { cookie: admin } },
    )).json())
    expect(pending).toMatchObject({ activeRevision: null, items: [] })
  } finally {
    finish({ content: JSON.stringify(original.persona.content), model: 'synthetic' })
    await processing
  }
  const completed = patientPersonaJobSchema.parse(await (await s.runtime.app.request(
    `/api/sim/v1/patient-persona-jobs/${job.jobId}`, { headers: { cookie: admin } },
  )).json())
  expect(completed).toMatchObject({ status: 'succeeded', resultRevision: 1 })
  const prepared = pciCaseSourceResponseSchema.parse(await (await s.post(admin, path, body, key)).json())
  expect(prepared.data.case).toMatchObject({ status: 'brief-ready', activeBriefRevision: 1, revision: 2 })
  expect(prepared.effects).toEqual([])
  expect(s.modelCalls()).toBe(1)
})

it('旧版就绪选用失败时回滚排队任务终止，恢复原键后整体成功', async () => {
  const s = await setup(), admin = await s.login('admin'), original = await pendingPciCase(s, admin)
  const queued = await s.post(admin, `/api/sim/v1/synthetic-cases/${original.ready.caseId}/patient-persona-jobs`, {})
  const job = patientPersonaJobSchema.parse((await queued.json()).data)
  const readJob = async () => patientPersonaJobSchema.parse(await (await s.runtime.app.request(
    `/api/sim/v1/patient-persona-jobs/${job.jobId}`, { headers: { cookie: admin } },
  )).json())
  s.runtime.database.driver.exec("CREATE TRIGGER fail_pci_persona_selection BEFORE UPDATE ON synthetic_case_instance WHEN NEW.active_brief_revision IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic persona selection failure'); END")
  const key = randomUUID(), path = '/api/sim/v1/synthetic-cases/pci/prepare', body = { input: { expectedEpoch: 'epoch-1' } }
  expect((await s.post(admin, path, body, key)).status).toBe(500)
  expect(await readJob()).toEqual(job)
  s.runtime.database.driver.exec('DROP TRIGGER fail_pci_persona_selection')
  expect((await s.post(admin, path, body, key)).status).toBe(200)
  expect(await readJob()).toMatchObject({ status: 'failed', error: { code: 'PERSONA_JOB_SUPERSEDED' } })
  expect(s.modelCalls()).toBe(0)
})

it('重复准备已有选用病例时保留操作者明确排队的 Persona 任务', async () => {
  const s = await setup(), admin = await s.login('admin'), original = await readyPciCase(s, admin)
  const queued = await s.post(admin, `/api/sim/v1/synthetic-cases/${original.ready.caseId}/patient-persona-jobs`, {})
  const job = patientPersonaJobSchema.parse((await queued.json()).data)
  const prepared = pciCaseSourceResponseSchema.parse(await (await s.post(admin,
    '/api/sim/v1/synthetic-cases/pci/prepare', { input: { expectedEpoch: 'epoch-1' } })).json())
  expect(prepared.data.case).toEqual(original.ready)
  expect(prepared.effects).toEqual([])
  expect(patientPersonaJobSchema.parse(await (await s.runtime.app.request(
    `/api/sim/v1/patient-persona-jobs/${job.jobId}`, { headers: { cookie: admin } },
  )).json())).toEqual(job)
})

it('选用失败整体回滚来源、模板和回执，原键可继续准备', async () => {
  const s = await setup(), admin = await s.login('admin'), key = randomUUID()
  s.runtime.database.driver.exec("CREATE TRIGGER fail_pci_persona_selection BEFORE UPDATE ON synthetic_case_instance WHEN NEW.active_brief_revision IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic persona selection failure'); END")
  const body = { input: { expectedEpoch: 'epoch-1' } }, path = '/api/sim/v1/synthetic-cases/pci/prepare'
  expect((await s.post(admin, path, body, key)).status).toBe(500)
  const profiles = syntheticPatientProfileListSchema.parse(await (await s.runtime.app.request('/api/sim/v1/synthetic-patients', { headers: { cookie: admin } })).json())
  expect(profiles.total).toBe(0)
  s.runtime.database.driver.exec('DROP TRIGGER fail_pci_persona_selection')
  const completed = pciCaseSourceResponseSchema.parse(await (await s.post(admin, path, body, key)).json())
  expect(completed.data.case).toMatchObject({ status: 'brief-ready', activeBriefRevision: 1, profileRevision: 1, revision: 2 })
  const revisions = patientPersonaRevisionListSchema.parse(await (await s.runtime.app.request(`/api/sim/v1/synthetic-cases/${completed.data.case.caseId}/patient-persona-revisions`, { headers: { cookie: admin } })).json())
  expect(revisions.items).toHaveLength(1)
  expect(s.modelCalls()).toBe(0)
})

it('准备后直接入院并由护士分床，保留病例绑定、幂等回放且无门诊登记或费用', async () => {
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
  const consumed = pciCaseSourceResponseSchema.parse(await (await s.post(admin,
    '/api/sim/v1/synthetic-cases/pci/prepare', { input: { expectedEpoch: 'epoch-1' } })).json())
  expect(consumed.data.case).toMatchObject({ status: 'started', activeBriefRevision: persona.revision, caseId: ready.caseId })
  expect(consumed.effects).toEqual([])
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
  const revisions = patientPersonaRevisionListSchema.parse(await (await s.runtime.app.request(`${casePath}/patient-persona-revisions`, { headers: { cookie: admin } })).json())
  const persona = revisions.items.find(item => item.revision === prepared.case.activeBriefRevision)!
  expect(persona).toBeDefined()
  return { ready: prepared.case, persona, prepared }
}

async function pendingPciCase(s: Awaited<ReturnType<typeof setup>>, admin: string) {
  const original = await readyPciCase(s, admin)
  // 安装旧版本前置：来源已建立，但 Persona 尚未生成。
  s.runtime.database.driver.prepare('UPDATE synthetic_case_instance SET active_brief_revision=NULL, status=?, revision=1 WHERE case_id=?').run('brief-pending', original.ready.caseId)
  s.runtime.database.driver.prepare('DELETE FROM patient_persona_revision WHERE case_id=?').run(original.ready.caseId)
  return original
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
  for (const path of ['/api/his/v1/inpatient/admissions', ...['', '/payments', '/financial-adjustments'].map(suffix => `/api/his/v1/inpatient/admissions/${first.admissionId}${suffix}`)]) {
    expect((await s.runtime.app.request(path, { headers: { cookie: admin } })).status).toBe(403)
  }
  const reset = async (clearPatientLibrary: boolean) => {
    const current = await context()
    const response = await s.post(admin, `/api/sim/v1/scenario-runs/${current.scenarioRunId}/actions/reset`, { clearPatientLibrary })
    expect(response.status, await response.text()).toBe(200)
    return context()
  }
  await reset(false)
  const replayed = inpatientListSchema.parse(await (await s.runtime.app.request('/api/his/v1/inpatient/admissions', { headers: { cookie: registrar } })).json())
  expect(replayed.items).toHaveLength(1)
  expect(replayed.items[0]).toMatchObject({ status: 'registered', depositFen: 0, chargesFen: 0, outstandingFen: 0 })
  expect(replayed.items[0]!.id).not.toBe(first.admissionId)
  const detail = inpatientDetailSchema.parse(await (await s.runtime.app.request(`/api/his/v1/inpatient/admissions/${replayed.items[0]!.id}`, { headers: { cookie: registrar } })).json())
  expect(detail.admission).toEqual(replayed.items[0])
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
