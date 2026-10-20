import { FhirRepository } from '../src/infrastructure/sqlite/fhir-repository.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from '../src/application/scenario-data/medical-service-snapshot.ts'
import { inpatientDischargeResponseSchema, inpatientSettlementResponseSchema, inpatientSettlementPreviewSchema, inpatientDischargeEventsSchema } from '@clinmesh/contracts/inpatient-discharge'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime, type CreateClinMeshRuntimeOptions } from '../src/runtime.ts'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0))
  await cleanup(); })
async function setup(depositFen = 100000, withReference = false) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-discharge-'))
  const password = `Test-${randomUUID()}-Aa1!`
  const referenceDatabasePath = join(directory, 'reference.sqlite')
  if (withReference) {
    const artifact = JSON.stringify({ schemaVersion: '1', concepts: [{ id: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', domain: 'diagnosis',
          system: 'urn:clinmesh:reference:nhsa-diagnosis', version: '2022', code: 'I10.x09', display: '合成真实目录高血压', status: 'active', sourceLocator: 'cn-health:nhc-icd10-clinical@2022.r4:diagnosis:12457' }],
      medicationProducts: syntheticNhsaMedicationProductSnapshot, services: syntheticNhcMedicalServiceSnapshot, valueSetEntries: syntheticWstValueSetSnapshot })
    await writeFile(join(directory, 'reference.json'), artifact)
    await writeFile(join(directory, 'release.json'), JSON.stringify({ releaseId: 'synthetic-clinical-2022', schemaVersion: '1', createdAt: '2026-08-28T00:00:00.000Z',
      sources: [{ sourceId: 'synthetic-clinical', artifactPath: 'reference.json', acquisitionMethod: 'generated', checksum: createHash('sha256').update(artifact).digest('hex'), licenseId: 'CC0-1.0',
          retrievedAt: '2026-08-28T00:00:00.000Z', sourceUrl: 'https://example.test/clinical', upstreamVersion: '2022' }] }))
    await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
    await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', join(directory, 'release.json')])
  }
  const options: CreateClinMeshRuntimeOptions = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'), ...(withReference ? { referenceDatabasePath, activeReferenceReleaseId: 'synthetic-clinical-2022' } : {}), demoPassword: password,
    migrationMode: 'apply', trustedOrigins: ['http://localhost'] }
  const runtime = await createClinMeshRuntime(options)
  cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true }); })
  async function login(name: string) {
    const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }) })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';', 1)[0]!
  }
  async function request(cookie: string, path: string, input?: unknown, key: string = randomUUID()) {
    const response = await runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST', headers: { cookie, origin: 'http://localhost',
        'content-type': 'application/json', 'idempotency-key': key }, ...(input === undefined ? {} : { body: JSON.stringify({ input }) }) })
    if (response.ok && path.includes('/discharge')) {
      const schema = path.endsWith('/preview') ? inpatientSettlementPreviewSchema : path.endsWith('/settle') ? inpatientSettlementResponseSchema
        : path.endsWith('/discharge') ? inpatientDischargeEventsSchema : inpatientDischargeResponseSchema
      schema.parse(await response.clone().json())
    }
    return response
  }
  const registrar = await login('registrar'), doctor = await login('inpatient-doctor'), nurse = await login('ward-nurse'), cashier = await login('cashier')
  const created = await runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: { cookie: registrar, origin: 'http://localhost',
      'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {}, input: {
        name: '合成出院患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}`
      } }) })
  const patient = (await created.json()).data.patient
  const registered = (await (await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen })).json()).data.admission
  const admission = (await (await request(nurse, `/api/his/v1/inpatient/admissions/${registered.id}/receive`, {
    encounterVersion: registered.versionId, bedId: 'bed-general-1'
  })).json()).data.admission
  return { runtime, options, request, login, patient, admission, doctor, nurse, cashier, registrar, path: `/api/his/v1/inpatient/admissions/${admission.id}` }
}
describe('住院病案首页公共 HTTP', () => {
  it('主管医生提交独立首页修订，四组事实可追溯且明确本次无实际操作，其他岗位不能提交', async () => {
    const s = await setup()
    const initial = await s.request(s.doctor, `${s.path}/record`)
    expect(initial.status).toBe(200)
    const draft = await initial.json()
    expect(draft.snapshot.patient).toMatchObject({ patientId: s.patient.id, name: '合成出院患者', gender: 'female', birthDate: '1980-01-01', admissionCount: 1 })
    expect(draft.snapshot.stay).toMatchObject({ admissionId: s.admission.id, admittedAt: '2026-08-24T09:00:00+08:00', initialWardId: 'ward-general' })
    expect(draft.snapshot.clinical.operations).toEqual([])
    expect(draft.snapshot.fees).toMatchObject({ chargesFen: 0, depositFen: 100000 })
    const input = { expectedRevision: 0, expectedSourcesHash: draft.sourcesHash, mainProcedureExecutionId: null }
    for (const cookie of [s.nurse, s.cashier, s.registrar, await s.login('medical-records')])
      expect((await s.request(cookie, `${s.path}/record/submit`, input)).status).toBe(403)
    const submitted = await s.request(s.doctor, `${s.path}/record/submit`, input)
    expect(submitted.status).toBe(200)
    const result = await submitted.json()
    expect(result.data.revision.revision).toBe(1)
    expect(result.data.revision.snapshot.clinical.operations).toEqual([])
    expect(result.data.recordNumber).not.toBe(s.admission.inpatientNumber)
    expect((await (await s.request(s.doctor, s.path)).json()).admission.versionId).toBe(s.admission.versionId)
  })
  it('未审核不能归档；清床后可窄更正正式诊断；旧修订与来源不能用于审核或归档', async () => {
    const s = await setup(100000, true), coder = await s.login('medical-records')
    await finish(s)
    const diagnosis = await confirm(s)
    expect(diagnosis.status).toBe(200)
    const draft = await (await s.request(s.doctor, `${s.path}/record`)).json()
    const submitted = await s.request(s.doctor, `${s.path}/record/submit`, { expectedRevision: 0, expectedSourcesHash: draft.sourcesHash, mainProcedureExecutionId: null })
    expect(submitted.status).toBe(200)
    const record = (await submitted.json()).data, expected = { expectedRevision: 1, expectedSourcesHash: record.sourcesHash }
    expect((await s.request(coder, `${s.path}/record/archive`, expected)).status).toBe(409)
    expect((await s.request(s.doctor, `${s.path}/record/review`, { ...expected, outcome: 'approved' })).status).toBe(403)
    expect((await s.request(coder, `${s.path}/record/review`, { ...expected, outcome: 'approved' })).status).toBe(200)
    const changed = await confirm(s, '补充病历依据')
    expect(changed.status).toBe(200)
    expect((await s.request(coder, `${s.path}/record/archive`, expected)).status).toBe(409)
    expect((await s.request(coder, `${s.path}/record/review`, { ...expected, outcome: 'approved' })).status).toBe(409)
    const fresh = await (await s.request(s.doctor, `${s.path}/record`)).json()
    expect(fresh.reviewCurrent).toBe(false)
    expect(fresh.sourcesHash).not.toBe(record.sourcesHash)
    expect(fresh.snapshot.fees.chargesFen).toBe(record.snapshot.fees.chargesFen)
    expect((await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: (await changed.json()).data.encounterVersion, duration: 'temporary', selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 } })).status).toBe(409)
  })
  it('归档冻结完整快照、新key禁止更正、原receipt仍重放；共享Patient升级和Scenario完成后归档仍可查', async () => {
    const s = await setup(100000, true), coder = await s.login('medical-records')
    await finish(s)
    const clinical = await (await s.request(s.doctor, `${s.path}/clinical`)).json()
    const diagnosisInput = { encounterVersion: clinical.encounterVersion, expectedRevision: 0, entries: [{ catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', role: 'primary', admissionCondition: '1', note: '归档前确认' }] }, diagnosisKey = randomUUID()
    const diagnosis = await s.request(s.doctor, `${s.path}/diagnoses/confirm`, diagnosisInput, diagnosisKey)
    expect(diagnosis.status).toBe(200)
    const receipt = await diagnosis.json()
    const draft = await (await s.request(s.doctor, `${s.path}/record`)).json()
    expect((await s.request(s.doctor, `${s.path}/record/submit`, { expectedRevision: 0, expectedSourcesHash: draft.sourcesHash, mainProcedureExecutionId: null })).status).toBe(200)
    const expected = { expectedRevision: 1, expectedSourcesHash: draft.sourcesHash }
    expect((await s.request(coder, `${s.path}/record/review`, { ...expected, outcome: 'approved' })).status).toBe(200)
    const key = randomUUID(), archive = await s.request(coder, `${s.path}/record/archive`, expected, key)
    expect(archive.status).toBe(200)
    const archived = await archive.json()
    expect(archived.data.archive.snapshot.clinical.operations).toEqual([])
    expect(await (await s.request(coder, `${s.path}/record/archive`, expected, key)).json()).toEqual(archived)
    expect(await (await s.request(s.doctor, `${s.path}/diagnoses/confirm`, diagnosisInput, diagnosisKey)).json()).toEqual(receipt)
    const change = await confirm(s, '归档后禁止新修订')
    expect(change.status).toBe(409)
    expect((await change.json()).error.code).toBe('INPATIENT_RECORD_ARCHIVED')
    expect((await s.runtime.app.request('/api/auth/role', { method: 'POST', headers: { cookie: s.doctor, origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ practitionerRoleId: 'practitioner-role-inpatient-doctor-surgery' }) })).status).toBe(200)
    const crossScope = await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { ...diagnosisInput, encounterVersion: archived.data.snapshot.fees.encounterVersion, expectedRevision: 1 })
    expect(crossScope.status).toBe(403)
    const session = await (await s.request(coder, '/api/auth/context')).json()
    const repository = new FhirRepository(s.runtime.database), context = { workspaceId: session.actor.workspaceId, epoch: session.actor.epoch }
    const patient = repository.read(context, 'Patient', s.patient.id)
    repository.update(context, { ...patient, name: [{ text: '合成共享患者新姓名' }] }, patient.meta!.versionId!)
    // 等价持久状态fixture：既有最后一次门诊发药会关闭全部已归档的Run；这里不重复搭建门诊闭环。
    s.runtime.database.driver.prepare("UPDATE scenario_run SET status='completed' WHERE scenario_run_id='scenario-run-1'").run()
    const read = await s.request(coder, `${s.path}/record`)
    expect(read.status).toBe(200)
    expect((await read.json()).archive).toEqual(archived.data.archive)
    expect((await s.request(coder, '/api/his/v1/inpatient/admissions')).status).toBe(200)
    expect((await s.request(coder, s.path)).status).toBe(200)
    expect((await s.request(coder, '/api/his/v1/inpatient/catalog')).status).toBe(200)
    expect((await s.request(s.nurse, `${s.path}/record`)).status).toBe(200)
    expect((await s.request(s.nurse, '/api/his/v1/inpatient/transfers/incoming')).status).toBe(200)
    expect((await s.request(s.nurse, '/api/his/v1/inpatient/transfer-catalog')).status).toBe(200)
    // 只读入口使用current不恢复completed Run的写权限。
    const inactiveWrite = await s.request(s.nurse, `${s.path}/transfers/receive`, { encounterVersion: archived.data.snapshot.fees.encounterVersion, transferId: 'synthetic-transfer', expectedTransferVersion: 1, bedId: 'bed-general-1' })
    expect(inactiveWrite.status).toBe(409)
    expect((await inactiveWrite.json()).error.code).toBe('CONTEXT_INACTIVE')
  })
  it('同净额的零元冲正仍使审核失效，分类净额归原费用类别', async () => {
    const s = await setup(100000, true), coder = await s.login('medical-records'), admin = await s.login('admin')
    s.runtime.database.driver.prepare('UPDATE inpatient_bed SET daily_price_fen=0 WHERE bed_id=?').run('bed-general-1')
    expect((await s.request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-25T00:00:00+08:00' })).status).toBe(200)
    expect((await confirm(s)).status).toBe(200)
    const admission = (await (await s.request(s.doctor, s.path)).json()).admission
    const issue = (await (await s.request(s.doctor, `${s.path}/discharge/issue`, { encounterVersion: admission.versionId, reason: '完成治疗' })).json()).data.admission
    expect((await s.request(s.nurse, `${s.path}/discharge/depart`, { encounterVersion: issue.versionId, reason: '已核对', departureMethod: 'home' })).status).toBe(200)
    const draft = await (await s.request(s.doctor, `${s.path}/record`)).json()
    expect((await s.request(s.doctor, `${s.path}/record/submit`, { expectedRevision: 0, expectedSourcesHash: draft.sourcesHash, mainProcedureExecutionId: null })).status).toBe(200)
    expect((await s.request(coder, `${s.path}/record/review`, { expectedRevision: 1, expectedSourcesHash: draft.sourcesHash, outcome: 'approved' })).status).toBe(200)
    const charge = draft.snapshot.fees.charges[0]
    expect((await s.request(s.cashier, `${s.path}/charges/reverse`, { chargeId: charge.id, expectedChargeVersion: charge.version, reason: '合成零元冲正' })).status).toBe(200)
    const changed = await (await s.request(s.doctor, `${s.path}/record`)).json()
    expect(changed.sourcesHash).not.toBe(draft.sourcesHash)
    expect(changed.reviewCurrent).toBe(false)
    expect(changed.snapshot.fees.chargesFen).toBe(0)
    expect(changed.snapshot.fees.categoryNetFen).toEqual({ bed: 0 })
  })
  it('申请不算实施；有实际操作必须显式选择本次执行，来源保留实际编码、术者和材料', async () => {
    const s = await setup(), catalog = await (await s.request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')).json(), procedure = catalog.procedures[0]
    const issued = await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion: s.admission.versionId, procedureId: procedure.id, catalogVersion: procedure.version, plannedFor: '2026-08-24T09:00:00+08:00', reason: '合成手术示教' })
    expect(issued.status).toBe(200)
    let request = (await issued.json()).data.requests[0]
    const before = await (await s.request(s.doctor, `${s.path}/record`)).json()
    expect(before.snapshot.clinical.operations).toEqual([])
    expect((await s.request(s.doctor, `${s.path}/record/submit`, { expectedRevision: 0, expectedSourcesHash: before.sourcesHash, mainProcedureExecutionId: request.id })).status).toBe(409)
    for (const [cookie, action] of [[s.doctor, 'confirm-consent'], [s.nurse, 'check-preop']] as const) {
      const prepared = await s.request(cookie, `${s.path}/surgeries/${action}`, { requestId: request.id, expectedRequestVersion: request.version, note: '准备核对完成' })
      expect(prepared.status).toBe(200)
      request = (await prepared.json()).data.requests[0]
    }
    const executed = await s.request(s.doctor, `${s.path}/surgeries/execute`, { requestId: request.id, expectedRequestVersion: request.version, procedureId: procedure.id, catalogVersion: procedure.version, note: '实际手术示教完成', materials: [] })
    expect(executed.status).toBe(200)
    const execution = (await executed.json()).data.executions[0]
    const draft = await (await s.request(s.doctor, `${s.path}/record`)).json(), input = { expectedRevision: 0, expectedSourcesHash: draft.sourcesHash }
    for (const main of [null, request.id, randomUUID()])
      expect((await s.request(s.doctor, `${s.path}/record/submit`, { ...input, mainProcedureExecutionId: main })).status).toBe(409)
    const submitted = await s.request(s.doctor, `${s.path}/record/submit`, { ...input, mainProcedureExecutionId: execution.id })
    expect(submitted.status).toBe(200)
    expect((await submitted.json()).data.revision.snapshot.clinical.operations[0]).toMatchObject({ id: execution.id, primary: true, actualProcedure: { coding: procedure.coding }, practitionerRoleId: 'practitioner-role-inpatient-doctor', procedureVersion: '1', materials: [] })
  })
  it('首页公开写拒绝缺Cookie或恶意Origin，错误来源不产生修订', async () => {
    const s = await setup(), coder = await s.login('medical-records'), draft = await (await s.request(s.doctor, `${s.path}/record`)).json()
    for (const [action, cookie, input] of [['submit', s.doctor, { expectedRevision: 0, expectedSourcesHash: draft.sourcesHash, mainProcedureExecutionId: null }], ['review', coder, { expectedRevision: 1, expectedSourcesHash: draft.sourcesHash, outcome: 'approved' }], ['archive', coder, { expectedRevision: 1, expectedSourcesHash: draft.sourcesHash }]] as const) {
      for (const headers of [{ cookie, origin: 'https://untrusted.example' }, { origin: 'http://localhost' }]) {
        const response = await s.runtime.app.request(`${s.path}/record/${action}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ input }) })
        expect([401, 403]).toContain(response.status)
      }
    }
    expect((await (await s.request(s.doctor, `${s.path}/record`)).json()).revision).toBeUndefined()
  })
  it('缺核心字段或院内备用编码不能批准；退回须附原因且保留独立审核事实', async () => {
    const s = await setup(), coder = await s.login('medical-records')
    await finish(s)
    let draft = await (await s.request(s.doctor, `${s.path}/record`)).json()
    expect((await s.request(s.doctor, `${s.path}/record/submit`, { expectedRevision: 0, expectedSourcesHash: draft.sourcesHash, mainProcedureExecutionId: null })).status).toBe(200)
    const first = { expectedRevision: 1, expectedSourcesHash: draft.sourcesHash }
    const incomplete = await s.request(coder, `${s.path}/record/review`, { ...first, outcome: 'approved' })
    expect(incomplete.status).toBe(409)
    expect((await incomplete.json()).error.code).toBe('INPATIENT_RECORD_INCOMPLETE')
    const clinical = await (await s.request(s.doctor, `${s.path}/clinical`)).json(), catalog = await (await s.request(s.doctor, '/api/his/v1/inpatient/clinical-catalog')).json()
    expect((await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: clinical.encounterVersion, expectedRevision: 0, entries: [{ catalogItemId: catalog.diagnoses[0].id, role: 'primary', admissionCondition: '1' }] })).status).toBe(200)
    draft = await (await s.request(s.doctor, `${s.path}/record`)).json()
    expect((await s.request(s.doctor, `${s.path}/record/submit`, { expectedRevision: 1, expectedSourcesHash: draft.sourcesHash, mainProcedureExecutionId: null })).status).toBe(200)
    const expected = { expectedRevision: 2, expectedSourcesHash: draft.sourcesHash }
    const unsupported = await s.request(coder, `${s.path}/record/review`, { ...expected, outcome: 'approved' })
    expect(unsupported.status).toBe(409)
    expect((await unsupported.json()).error.code).toBe('INPATIENT_RECORD_CODING_UNSUPPORTED')
    expect((await s.request(coder, `${s.path}/record/review`, { ...expected, outcome: 'returned' })).status).toBe(400)
    const returned = await s.request(coder, `${s.path}/record/review`, { ...expected, outcome: 'returned', reason: '请经正式诊断入口补充临床版编码' })
    expect(returned.status).toBe(200)
    expect((await returned.json()).data.reviews).toMatchObject([{ revision: 2, outcome: 'returned', reason: '请经正式诊断入口补充临床版编码' }])
  })
  it('即使已重新审核且合计不变，原结算逐项资金与当前账不符仍拒绝归档', async () => {
    const s = await setup(100000, true), coder = await s.login('medical-records')
    await finish(s)
    expect((await confirm(s)).status).toBe(200)
    // 受控损坏fixture：合计字段不变，原结算中的预交金明细与真实资金差一分。
    s.runtime.database.driver.prepare("UPDATE inpatient_settlement SET preview_json=json_set(preview_json,'$.transactions[0].amountFen',100001) WHERE admission_id=?").run(s.admission.id)
    const draft = await (await s.request(s.doctor, `${s.path}/record`)).json()
    expect((await s.request(s.doctor, `${s.path}/record/submit`, { expectedRevision: 0, expectedSourcesHash: draft.sourcesHash, mainProcedureExecutionId: null })).status).toBe(200)
    const expected = { expectedRevision: 1, expectedSourcesHash: draft.sourcesHash }
    expect((await s.request(coder, `${s.path}/record/review`, { ...expected, outcome: 'approved' })).status).toBe(200)
    const archive = await s.request(coder, `${s.path}/record/archive`, expected)
    expect(archive.status).toBe(409)
    expect((await archive.json()).error.code).toBe('INPATIENT_RECORD_FINANCIAL_CONFLICT')
    expect((await (await s.request(coder, `${s.path}/record`)).json()).archive).toBeUndefined()
  })

})
async function confirm(s: Awaited<ReturnType<typeof setup>>, note = '本次正式诊断依据') {
  const clinical = await (await s.request(s.doctor, `${s.path}/clinical`)).json()
  return s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: clinical.encounterVersion, expectedRevision: clinical.diagnosis.revision, entries: [{ catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', role: 'primary', admissionCondition: '1', note }] })
}
async function finish(s: Awaited<ReturnType<typeof setup>>) {
  const issued = await (await s.request(s.doctor, `${s.path}/discharge/issue`, { encounterVersion: s.admission.versionId, reason: '治疗完成' })).json()
  expect(issued.data).toBeDefined()
  expect((await s.request(s.nurse, `${s.path}/discharge/depart`, { encounterVersion: issued.data.admission.versionId, reason: '已核对', departureMethod: 'home' })).status).toBe(200)
  const p = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
  const settled = await (await s.request(s.cashier, `${s.path}/discharge/settle`, { encounterVersion: p.encounterVersion, fingerprint: p.fingerprint, expectedChargesFen: p.chargesFen, expectedBalanceFen: p.balanceFen })).json()
  expect((await s.request(s.nurse, `${s.path}/discharge/clear`, { encounterVersion: settled.data.encounterVersion, reason: '床单位已清洁' })).status).toBe(200)
}
