import { addSecondaryInpatientWard } from './fixtures/inpatient-secondary-ward.ts'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apiErrorSchema } from '@clinmesh/contracts/his'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientSurgeryCatalogSchema, inpatientSurgeryResponseSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { createClinMeshRuntime, type CreateClinMeshRuntimeOptions } from '../src/runtime.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-surgery-'))
  const password = `Test-${randomUUID()}-Aa1!`
  const options: CreateClinMeshRuntimeOptions = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'), demoPassword: password,
    migrationMode: 'apply', trustedOrigins: ['http://localhost'] }
  const runtime = await createClinMeshRuntime(options)
  cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true }) })
  async function login(name: string) {
    const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }) })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';', 1)[0]!
  }
  async function request(cookie: string, path: string, input?: unknown, key: string = randomUUID()) {
    return runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST', headers: { cookie, origin: 'http://localhost',
      'content-type': 'application/json', 'idempotency-key': key }, ...(input === undefined ? {} : { body: JSON.stringify({ input }) }) })
  }
  const registrar = await login('registrar'), doctor = await login('inpatient-doctor'), nurse = await login('ward-nurse'), cashier = await login('cashier')
  const created = await runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: { cookie: registrar, origin: 'http://localhost',
    'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {}, input: {
      name: '合成手术患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } }) })
  const patient = (await created.json()).data.patient
  const registered = (await (await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })).json()).data.admission
  const admission = (await (await request(nurse, `/api/his/v1/inpatient/admissions/${registered.id}/receive`, {
    encounterVersion: registered.versionId, bedId: 'bed-general-1' })).json()).data.admission
  return { runtime, options, request, login, patient, admission, doctor, nurse, cashier, registrar, path: `/api/his/v1/inpatient/admissions/${admission.id}` }
}

describe('住院手术公共 HTTP 与真实 SQLite', () => {
  it('手术目录保留231条心血管来源、表价及未知单位，不伪造可收费定义', async () => {
    const s = await setup()
    const response = await s.request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')
    expect(response.status).toBe(200)
    const catalog = inpatientSurgeryCatalogSchema.parse(await response.json())
    expect(catalog.procedures).toHaveLength(8)
    expect(catalog.materials).toHaveLength(236)
    for (const [id, unit, priceFen] of [
      ['hospital-material-stent', '个', 80000],
      ['hospital-material-balloon', '个', 40000],
      ['hospital-material-guidewire', '根', 20000],
    ] as const) {
      const item = catalog.materials.find(item => item.id === id)
      expect(item).toMatchObject({ chargeDefinition: { unit, priceFen, synthetic: true } })
      expect(item).not.toHaveProperty('reference')
    }
    const imported = catalog.materials.filter((item: { reference?: unknown }) => item.reference !== undefined)
    expect(imported).toHaveLength(231)
    expect(imported.filter(item => 'chargeDefinition' in item)).toHaveLength(52)
    expect(imported.filter(item => 'unavailableReason' in item && item.unavailableReason === 'unit-unconfirmed')).toHaveLength(179)
    expect(imported.find((item: { id: string }) => item.id === 'hospital-material-cv-8')).toMatchObject({
      chargeDefinition: { priceFen: 1199000, unit: '台', synthetic: true },
      reference: { category: '常规起搏类', specification: null, unit: '台', priceFen: 1199000,
        effectiveFrom: '2026-08-01', effectiveThrough: null, sourceId: 'HN-PACING-2026',
        workbookSha256: '76147edf46552c906750bb2a8697596cd47acf3450c322168f92a5b8e2348cc3', row: 8,
        original: { '中选价格（元）': '11990', '原表计价单位': '台' },
        source: { '原件 SHA-256': '20ff7320ba7c7f657a1bfa644e081e7f16c65be1885953da8c566c25dc53eee8' } },
    })
    const unknownUnit = imported.find((item: { id: string }) => item.id === 'hospital-material-cv-60')
    expect(unknownUnit).toMatchObject({ unavailableReason: 'unit-unconfirmed', reference: {
      unit: null, specification: null, priceFen: 20000, effectiveFrom: '2023-04-15', sourceId: 'TJ2023-1',
      applicability: '历史参考；原通知规定到期未接续品种继续执行，具体品种后续接续和现行状态未核实',
    } })
    expect(unknownUnit).not.toHaveProperty('chargeDefinition')
    expect(imported.find((item: { id: string }) => item.id === 'hospital-material-cv-238')).toMatchObject({
      reference: { priceFen: 84600, effectiveThrough: '2025-12-31', sourceId: 'ZJ-STENT-2' },
    })
    expect(imported.find((item: { id: string }) => item.id === 'hospital-material-cv-19')).toMatchObject({
      chargeDefinition: { priceFen: 3200000 }, reference: { priceFen: 3200000, baseSupplyPriceFen: 2880000 },
    })
    expect(imported.find((item: { id: string }) => item.id === 'hospital-material-cv-108')).toMatchObject({ reference: { priceFen: 31740 } })
    expect(imported.find((item: { id: string }) => item.id === 'hospital-material-cv-120')).toMatchObject({ reference: { priceFen: 54720 } })
  })

  it('缺计价单位耗材拒绝实际使用且不产生Procedure或费用，明确单位按表价计费', async () => {
    const s = await setup(), prepared = await readySurgery(s, false), row = prepared.requests[0]
    const input = { requestId: row.id, expectedRequestVersion: row.version, procedureId: 'hospital-surgery-4', catalogVersion: 1,
      note: '按已确认表价记录合成耗材使用', materials: [{ materialId: 'hospital-material-cv-60', catalogVersion: 1, quantity: 2 }] }
    const rejected = await s.request(s.doctor, `${s.path}/surgeries/execute`, input)
    expect(rejected.status).toBe(409)
    expect(apiErrorSchema.parse(await rejected.json()).error.code).toBe('CATALOG_CONFLICT')
    expect(inpatientSurgerySchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries`)).json())).toEqual(prepared)
    expect(fhirBundleSchema.parse(await (await s.request(s.doctor, `/fhir/R5/Procedure?encounter=Encounter/${s.admission.id}&_total=accurate`)).json()).total).toBe(0)
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).charges).toEqual([])
    const executed = await s.request(s.doctor, `${s.path}/surgeries/execute`, { ...input,
      materials: [{ materialId: 'hospital-material-cv-8', catalogVersion: 1, quantity: 2 }] })
    expect(executed.status).toBe(200)
    expect(inpatientSurgeryResponseSchema.parse(await executed.json()).data.executions[0]!.materials[0]).toMatchObject({ quantity: 2, amountFen: 2398000,
      item: { id: 'hospital-material-cv-8', chargeDefinition: { priceFen: 1199000, unit: '台' }, reference: { sourceId: 'HN-PACING-2026' } } })
    const charges = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).charges
    expect(charges.map(item => item.amountFen)).toEqual([200000, 2398000])
  })

  it.each(['request','check-preop','confirm-consent','cancel','execute'])('手术%s拒绝缺失或恶意Origin且不写入，可信Origin正常', async action => {
    const s = await setup(), cookie = action === 'check-preop' ? s.nurse : s.doctor
    let input: Record<string,unknown> = { encounterVersion:s.admission.versionId,procedureId:'hospital-surgery-4',catalogVersion:1,
      plannedFor:'2026-08-25T01:00:00.000Z',reason:'合成Origin门禁验证' }
    if (action === 'execute') {
      const state = await readySurgery(s, false), row = state.requests[0]
      input = { requestId:row.id,expectedRequestVersion:row.version,procedureId:'hospital-surgery-4',catalogVersion:1,materials:[],note:'合成实际实施' }
    } else if (action !== 'request') {
      const requested = await s.request(s.doctor, `${s.path}/surgeries/request`, input)
      expect(requested.status).toBe(200)
      const row = (await requested.json()).data.requests[0]
      input = { requestId:row.id,expectedRequestVersion:row.version,note:'合成准备或取消' }
    }
    const before = await (await s.request(s.doctor, `${s.path}/surgeries`)).json()
    for (const origin of [undefined,'https://untrusted.example']) {
      const rejected = await s.runtime.app.request(`${s.path}/surgeries/${action}`, { method:'POST',headers:{cookie,
        'content-type':'application/json','idempotency-key':randomUUID(),...(origin === undefined ? {} : {origin})},body:JSON.stringify({input}) })
      expect(rejected.status).toBe(403)
      expect((await rejected.json()).error.code).toBe('CSRF_REJECTED')
    }
    expect(await (await s.request(s.doctor, `${s.path}/surgeries`)).json()).toEqual(before)
    expect((await s.request(cookie, `${s.path}/surgeries/${action}`, input)).status).toBe(200)
  })

  it('纯Agent Bearer的手术写入沿用现有无Origin例外', async () => {
    const s = await setup(), admin = await s.login('admin')
    const control = (path:string,input:unknown) => s.runtime.app.request(path,{method:'POST',headers:{cookie:admin,origin:'http://localhost',
      'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify(input)})
    const clientResponse = await control('/api/agent/v1/clients',{name:'合成手术Agent'})
    expect(clientResponse.status).toBe(200)
    const client = await clientResponse.json()
    const grantResponse = await control('/api/agent/v1/grants',{agentClientId:client.agentClientId,operationIds:['inpatient.surgery.request'],
      practitionerRoleId:'practitioner-role-inpatient-doctor',ttlSeconds:3600})
    expect(grantResponse.status).toBe(200)
    const grant = await grantResponse.json()
    const requested = await s.runtime.app.request(`${s.path}/surgeries/request`, { method:'POST',headers:{authorization:`Bearer ${grant.token}`,
      'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({input:{encounterVersion:s.admission.versionId,
        procedureId:'hospital-surgery-4',catalogVersion:1,plannedFor:'2026-08-25T01:00:00.000Z',reason:'合成Bearer手术申请'}}) })
    expect(requested.status).toBe(200)
    expect((await (await s.request(s.doctor, `${s.path}/surgeries`)).json()).requests).toHaveLength(1)
  })

  it('混合时区的申请及实际执行按时间点排序，保留毫秒与稳定顺序', async () => {
    const s = await setup(), admin = await s.login('admin')
    const first = await readySurgery(s)
    const firstRequest = first.requests[0], firstExecution = first.executions[0]
    expect(first.virtualTime).toBe('2026-08-24T09:00:00+08:00')
    const requestIds = [firstRequest.id], executionIds = [firstExecution.id]
    let current = first.virtualTime
    for (const target of ['2026-08-24T01:00:00.001Z','2026-08-24T01:00:00.002Z']) {
      const advanced = await s.request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: current, targetVirtualTime: target })
      expect(advanced.status).toBe(200)
      const next = await readySurgery(s)
      requestIds.push(next.requests.find((row: { id: string }) => !requestIds.includes(row.id)).id)
      executionIds.push(next.executions.find((row: { id: string }) => !executionIds.includes(row.id)).id)
      current = target
    }
    const actual = await (await s.request(s.doctor, `${s.path}/surgeries`)).json()
    expect.soft(actual.requests.map((row: { id: string }) => row.id)).toEqual(requestIds)
    expect.soft(actual.executions.map((row: { id: string }) => row.id)).toEqual(executionIds)
    expect.soft(actual.requests.map((row: { requestedAt: string }) => row.requestedAt)).toEqual([
      '2026-08-24T09:00:00+08:00','2026-08-24T01:00:00.001Z','2026-08-24T01:00:00.002Z',
    ])
    expect(actual.executions.map((row: { performedAt: string }) => row.performedAt)).toEqual([
      '2026-08-24T09:00:00+08:00','2026-08-24T01:00:00.001Z','2026-08-24T01:00:00.002Z',
    ])
  })

  it('两个准备回执与公开审计关联真实申请版本，旧key重放不增加事件', async () => {
    const s = await setup()
    const requested = await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion: s.admission.versionId,
      procedureId:'hospital-surgery-4',catalogVersion:1,plannedFor:'2026-08-25T01:00:00.000Z',reason:'合成准备审计验证' })
    expect(requested.status).toBe(200)
    const id = (await requested.json()).data.requests[0].id
    const auditCount = async () => (await (await s.request(s.doctor, '/fhir/R5/AuditEvent?_total=accurate&_count=100')).json()).total
    const initialCount = await auditCount()
    const replays: Array<{ cookie:string; action:string; input:{requestId:string;expectedRequestVersion:number;note:string}; key:string; response:unknown }> = []
    for (const [cookie,action,version] of [[s.nurse,'check-preop',2],[s.doctor,'confirm-consent',3]] as const) {
      const input = { requestId:id,expectedRequestVersion:version-1,note:'合成准备责任确认' }, key = randomUUID()
      const prepared = await s.request(cookie, `${s.path}/surgeries/${action}`, input, key)
      expect(prepared.status).toBe(200)
      const response = await prepared.json(), reference = `InpatientSurgeryRequest/${id}`
      const effects = [{ kind:'updated',reference,versionId:String(version) }]
      expect.soft(response.effects).toEqual(effects)
      expect(response.data.requests[0].version).toBe(version)
      const receipt = await (await s.request(cookie, `/api/his/v1/command-receipts?operationId=inpatient.surgery.${action}&idempotencyKey=${key}`)).json()
      expect.soft(receipt.response.effects).toEqual(effects)
      const audit = await (await s.request(cookie, `/fhir/R5/AuditEvent/${response.auditId}`)).json()
      expect.soft(audit.entity).toEqual([{ role:{text:'updated'},what:{identifier:{
        system:'https://caizongyuan.github.io/clinmesh/identifier/command-effect-reference',value:reference,
      }} }])
      replays.push({cookie,action,input,key,response})
    }
    const requestResource = await (await s.request(s.doctor, `/fhir/R5/ServiceRequest/${id}`)).json()
    expect(requestResource.meta.versionId).toBe('1')
    expect(await auditCount()).toBe(initialCount + 2)
    for (const replay of replays) expect(await (await s.request(replay.cookie, `${s.path}/surgeries/${replay.action}`, replay.input, replay.key)).json()).toEqual(replay.response)
    expect(await auditCount()).toBe(initialCount + 2)
  })

  it('双准备门禁，计划与实际独立，执行和费用原子且原键重放', async () => {
    const s = await setup()
    const catalogResponse = await s.request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')
    expect(catalogResponse.status).toBe(200)
    const catalog = await catalogResponse.json()
    expect(catalog.procedures.map((item: { coding: { code: string } }) => item.coding.code)).toContain('00.6600x008')
    const planned = catalog.procedures.find((item: { coding: { code: string } }) => item.coding.code === '47.0100')
    const actual = catalog.procedures.find((item: { coding: { code: string } }) => item.coding.code === '51.2300')
    const material = catalog.materials.find((item: { id: string }) => item.id === 'hospital-material-suture')
    const requested = await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion: s.admission.versionId,
      procedureId: planned.id, catalogVersion: planned.version, plannedFor: '2026-08-25T01:00:00.000Z', reason: '合成示教手术申请' })
    expect(requested.status).toBe(200)
    let state = (await requested.json()).data
    const id = state.requests[0].id
    const execute = () => ({ requestId: id, expectedRequestVersion: state.requests[0].version, procedureId: actual.id,
      catalogVersion: actual.version, note: '实际实施术式与计划不同', materials: [{ materialId: material.id, catalogVersion: material.version, quantity: 2 }] })
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, execute())).status).toBe(409)
    expect(state.executions).toEqual([])
    const checked = await s.request(s.nurse, `${s.path}/surgeries/check-preop`, { requestId: id, expectedRequestVersion: state.requests[0].version, note: '已核对术前检查' })
    expect(checked.status).toBe(200)
    state = (await checked.json()).data
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, execute())).status).toBe(409)
    const consent = await s.request(s.doctor, `${s.path}/surgeries/confirm-consent`, { requestId: id, expectedRequestVersion: state.requests[0].version, note: '确认已签署知情同意书' })
    expect(consent.status).toBe(200)
    state = (await consent.json()).data
    expect(state.requests[0].status).toBe('ready')
    const key = randomUUID(), input = execute()
    const completed = await s.request(s.doctor, `${s.path}/surgeries/execute`, input, key)
    expect(completed.status).toBe(200)
    const body = await completed.json()
    expect(await (await s.request(s.doctor, `${s.path}/surgeries/execute`, input, key)).json()).toEqual(body)
    state = body.data
    expect(state.executions).toHaveLength(1)
    expect(state.requests[0].plannedProcedure.coding.code).toBe('47.0100')
    expect(state.executions[0]).toMatchObject({ requestId: id, actualProcedure: { coding: { code: '51.2300' } }, materials: [{ quantity: 2 }] })
    const procedures = await (await s.request(s.doctor, `/fhir/R5/Procedure?encounter=Encounter/${s.admission.id}&_total=accurate`)).json()
    expect(procedures.total).toBe(1)
    const metadata = await (await s.request(s.doctor, '/fhir/R5/metadata')).json()
    const capability = metadata.rest[0].resource.find((item: { type: string }) => item.type === 'Procedure')
    expect(capability.interaction.map((item: { code: string }) => item.code)).toEqual(['read','vread','history-instance','search-type'])
    expect(capability.searchParam.map((item: { name: string }) => item.name)).toEqual(['patient','encounter'])
    expect((await s.request(s.doctor, '/fhir/R5/Procedure?status=completed')).status).toBe(400)
    expect((await (await s.request(s.doctor, `/fhir/R5/Procedure?patient=Patient/${s.patient.id}&_total=accurate`)).json()).total).toBe(1)
    expect(procedures.entry[0].resource).toMatchObject({ status: 'completed', code: { coding: [{ code: '51.2300' }] },
      subject: { reference: `Patient/${s.patient.id}` }, basedOn: [{ reference: `ServiceRequest/${id}` }] })
    const ledger = await (await s.request(s.cashier, `${s.path}/charges`)).json()
    expect(ledger.charges.map((charge: { kind: string; amountFen: number }) => ({ kind: charge.kind, amountFen: charge.amountFen }))).toEqual([
      { kind: 'surgery', amountFen: actual.chargeDefinition.priceFen }, { kind: 'material', amountFen: material.chargeDefinition.priceFen * 2 }])
    expect((await s.request(s.doctor, `${s.path}/surgeries/cancel`, { requestId: id, expectedRequestVersion: state.requests[0].version, note: '不能取消已实施事实' })).status).toBe(409)
  })

  it('岗位、当前病区、目录身份、旧版本和取消竞争均受门禁', async () => {
    const s = await setup()
    const request = { encounterVersion: s.admission.versionId, procedureId: 'hospital-surgery-1', catalogVersion: 1,
      plannedFor: '2026-08-25T01:00:00.000Z', reason: '合成申请' }
    expect((await s.request(s.nurse, `${s.path}/surgeries/request`, request)).status).toBe(403)
    expect((await s.request(s.cashier, `${s.path}/surgeries`)).status).toBe(403)
    for (const value of [{ ...request, procedureId: '00.6600' }, { ...request, catalogVersion: 999 }, { ...request, plannedFor: '2026-01-01T00:00:00Z' }]) {
      expect((await s.request(s.doctor, `${s.path}/surgeries/request`, value)).status).toBe(409)
    }
    const requested = await s.request(s.doctor, `${s.path}/surgeries/request`, request)
    expect(requested.status).toBe(200)
    const row = (await requested.json()).data.requests[0]
    const action = { requestId: row.id, expectedRequestVersion: row.version, note: '确认已签署' }
    expect((await s.request(s.nurse, `${s.path}/surgeries/confirm-consent`, action)).status).toBe(403)
    expect((await s.request(s.doctor, `${s.path}/surgeries/check-preop`, action)).status).toBe(403)
    const consent = await s.request(s.doctor, `${s.path}/surgeries/confirm-consent`, action)
    expect(consent.status).toBe(200)
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, { ...action, expectedRequestVersion: 2, ...request, materials: [] })).status).toBe(400)
    const execution = { requestId: row.id, expectedRequestVersion: 2, procedureId: 'hospital-surgery-1', catalogVersion: 1, materials: [], note: '仅同意未核对不能执行' }
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, execution)).status).toBe(409)
    expect((await s.request(s.nurse, `${s.path}/surgeries/check-preop`, action)).status).toBe(409)
    await addSecondaryInpatientWard(s.runtime)
    const switched = await s.runtime.app.request('/api/auth/role', { method: 'POST', headers: { cookie: s.nurse, origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ practitionerRoleId: 'practitioner-role-ward-nurse-surgery' }) })
    expect(switched.status).toBe(200)
    expect((await s.request(s.nurse, `${s.path}/surgeries`)).status).toBe(403)
    const cancelInput = { requestId: row.id, expectedRequestVersion: 2, note: '取消合成未实施计划' }
    const race = await Promise.all([s.request(s.doctor, `${s.path}/surgeries/cancel`, cancelInput), s.request(s.doctor, `${s.path}/surgeries/confirm-consent`, cancelInput)])
    expect(race.map(result => result.status).sort()).toEqual([200,409])
    const cancelled = await race.find(result => result.status === 200)!.json()
    expect(cancelled.effects).toEqual([
      {kind:'updated',reference:`InpatientSurgeryRequest/${row.id}`,versionId:'3'},
      {kind:'updated',reference:`ServiceRequest/${row.id}`,versionId:'2'},
    ])
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, { ...execution, expectedRequestVersion: 3 })).status).toBe(409)
    const final = await (await s.request(s.doctor, `${s.path}/surgeries`)).json()
    expect(final.executions).toEqual([])
    expect(final.requests[0]).toMatchObject({ status: 'cancelled', consentConfirmation: { note: '确认已签署' }, cancellation: { note: '取消合成未实施计划' } })
  })

  it.each(['projection','billing'])('%s 写入失败回滚实施、耗材和费用，原键可安全重试', async failure => {
    const s = await setup(), state = await readySurgery(s, false), row = state.requests[0]
    const input = { requestId: row.id, expectedRequestVersion: row.version, procedureId: 'hospital-surgery-4', catalogVersion: 1,
      materials: [{ materialId: 'hospital-material-suture', catalogVersion: 1, quantity: 2 }], note: '失败后不留部分事实' }
    const key = randomUUID()
    s.runtime.database.driver.exec(failure === 'projection'
      ? "CREATE TRIGGER fail_surgery BEFORE INSERT ON fhir_resource WHEN NEW.resource_type='Procedure' BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END;"
      : "CREATE TRIGGER fail_surgery BEFORE INSERT ON inpatient_charge WHEN NEW.kind='material' BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END;")
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, input, key)).status).toBe(500)
    const failed = await (await s.request(s.doctor, `${s.path}/surgeries`)).json()
    expect(failed.executions).toEqual([])
    expect(failed.requests[0].status).toBe('ready')
    expect((await (await s.request(s.cashier, `${s.path}/charges`)).json()).charges).toEqual([])
    const procedures = await (await s.request(s.doctor, `/fhir/R5/Procedure?encounter=Encounter/${s.admission.id}&_total=accurate`)).json()
    expect(procedures.total).toBe(0)
    s.runtime.database.driver.exec('DROP TRIGGER fail_surgery')
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, input, key)).status).toBe(200)
    expect((await (await s.request(s.cashier, `${s.path}/charges`)).json()).chargesFen).toBe(204000)
  })

  it('已就绪申请的取消与实施竞争只提交一个结局', async () => {
    const s = await setup(), state = await readySurgery(s, false), row = state.requests[0]
    const common = { requestId: row.id, expectedRequestVersion: row.version, note: '合成取消与实施竞争' }
    const responses = await Promise.all([
      s.request(s.doctor, `${s.path}/surgeries/execute`, { ...common, procedureId: 'hospital-surgery-4', catalogVersion: 1, materials: [] }),
      s.request(s.doctor, `${s.path}/surgeries/cancel`, common),
    ])
    expect(responses.map(response => response.status).sort()).toEqual([200,409])
    const final = await (await s.request(s.doctor, `${s.path}/surgeries`)).json()
    const ledger = await (await s.request(s.cashier, `${s.path}/charges`)).json()
    if (final.requests[0].status === 'completed') {
      expect(final.executions).toHaveLength(1)
      expect(ledger.chargesFen).toBe(200000)
    } else {
      expect(final.requests[0].status).toBe('cancelled')
      expect(final.executions).toEqual([])
      expect(ledger.charges).toEqual([])
    }
  })

  it('已有Epoch重启只补缺失目录，不覆盖已冻结的院内配置', async () => {
    const s = await setup()
    s.runtime.database.driver.exec("DELETE FROM inpatient_surgery_catalog WHERE item_id='hospital-material-catheter'")
    s.runtime.database.driver.exec("UPDATE inpatient_surgery_catalog SET snapshot_json=json_set(snapshot_json,'$.chargeDefinition.priceFen',123456) WHERE item_id='hospital-surgery-4'")
    await s.runtime.close()
    const reopened = await createClinMeshRuntime(s.options)
    cleanups.push(() => reopened.close())
    const response = await reopened.app.request('/api/his/v1/inpatient/surgery-catalog', { headers: { cookie:s.doctor } })
    expect(response.status).toBe(200)
    const catalog = await response.json()
    expect(catalog.procedures).toHaveLength(8)
    expect(catalog.materials).toHaveLength(236)
    expect(catalog.procedures.find((item: { id: string }) => item.id === 'hospital-surgery-4').chargeDefinition.priceFen).toBe(123456)
  })

  it('心血管目录重启补缺不调旧价，旧耗材实施快照与原receipt仍可恢复，新Epoch重新安装全量', async () => {
    const s = await setup(), prepared = await readySurgery(s, false), key = randomUUID()
    const input = { requestId: prepared.requests[0].id, expectedRequestVersion: 3, procedureId: 'hospital-surgery-4', catalogVersion: 1,
      note: '保留旧格式耗材实施', materials: [{ materialId: 'hospital-material-suture', catalogVersion: 1, quantity: 2 }] }
    const completed = await s.request(s.doctor, `${s.path}/surgeries/execute`, input, key)
    expect(completed.status).toBe(200)
    const original = inpatientSurgeryResponseSchema.parse(await completed.json()), admin = await s.login('admin')
    expect(original.data.executions[0]!.materials[0]!.item).not.toHaveProperty('reference')
    s.runtime.database.driver.prepare("DELETE FROM inpatient_surgery_catalog WHERE item_id='hospital-material-cv-238'").run()
    s.runtime.database.driver.prepare("UPDATE inpatient_surgery_catalog SET snapshot_json=json_set(snapshot_json,'$.chargeDefinition.priceFen',123) WHERE item_id='hospital-material-cv-8'").run()
    await s.runtime.close()
    const reopened = await createClinMeshRuntime(s.options)
    cleanups.push(() => reopened.close())
    const request = (cookie: string, path: string, body?: unknown, idempotencyKey = randomUUID()) => reopened.app.request(path, {
      method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const catalog = inpatientSurgeryCatalogSchema.parse(await (await request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')).json())
    expect(catalog.materials).toHaveLength(236)
    expect(new Set(catalog.materials.map((item: { id: string }) => item.id)).size).toBe(236)
    const retained = catalog.materials.find(item => item.id === 'hospital-material-cv-8')!
    expect('chargeDefinition' in retained && retained.chargeDefinition.priceFen).toBe(123)
    expect(inpatientSurgeryResponseSchema.parse(await (await request(s.doctor, `${s.path}/surgeries/execute`, { input }, key)).json())).toEqual(original)
    expect(inpatientSurgerySchema.parse(await (await request(s.doctor, `${s.path}/surgeries`)).json())).toEqual(original.data)
    expect((await request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', {})).status).toBe(200)
    const resetCatalog = inpatientSurgeryCatalogSchema.parse(await (await request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')).json())
    expect(resetCatalog.materials).toHaveLength(236)
    const installed = resetCatalog.materials.find(item => item.id === 'hospital-material-cv-8')!
    expect('chargeDefinition' in installed && installed.chargeDefinition.priceFen).toBe(1199000)
  })

  it('术后医嘱只接受本次已实施事实并仍须护士校对', async () => {
    const s = await setup()
    const input = { encounterVersion: s.admission.versionId, duration: 'temporary', surgeryExecutionId: 'missing',
      selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 } }
    const rejected = await s.request(s.doctor, `${s.path}/orders/issue`, input)
    expect(rejected.status).toBe(409)
    expect((await rejected.json()).error.code).toBe('INPATIENT_SURGERY_EXECUTION_REQUIRED')
    const state = await readySurgery(s)
    expect((await s.request(s.doctor, `${s.path}/orders/issue`, { ...input, surgeryExecutionId: state.requests[0].id })).status).toBe(409)
    const createdOther = await s.runtime.app.request('/api/his/v1/patients', { method:'POST', headers:{cookie:s.registrar,origin:'http://localhost','content-type':'application/json','idempotency-key':randomUUID()},
      body:JSON.stringify({expectedVersions:{},input:{name:'合成其他住院患者',gender:'male',birthDate:'1980-01-01',identifier:`SYN-${randomUUID()}`}}) })
    expect(createdOther.status).toBe(200)
    const otherPatient = (await createdOther.json()).data.patient
    const registeredOther = await s.request(s.registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch:'epoch-1',patientId:otherPatient.id,
      patientVersion:otherPatient.versionId,admissionRoute:'direct',wardId:'ward-general',depositFen:0 })
    const other = (await registeredOther.json()).data.admission
    const receivedOther = await s.request(s.nurse, `/api/his/v1/inpatient/admissions/${other.id}/receive`, { encounterVersion:other.versionId,bedId:'bed-general-2' })
    expect(receivedOther.status).toBe(200)
    const foreign = await s.request(s.doctor, `/api/his/v1/inpatient/admissions/${other.id}/orders/issue`, { ...input,
      encounterVersion:(await receivedOther.json()).data.admission.versionId,surgeryExecutionId:state.executions[0].id })
    expect(foreign.status).toBe(409)
    expect((await foreign.json()).error.code).toBe('INPATIENT_SURGERY_EXECUTION_REQUIRED')
    const issued = await s.request(s.doctor, `${s.path}/orders/issue`, { ...input, surgeryExecutionId: state.executions[0].id })
    expect(issued.status).toBe(200)
    let clinical = (await issued.json()).data
    expect(clinical.orders[0]).toMatchObject({ surgeryExecutionId: state.executions[0].id, state: 'signed' })
    expect(clinical.executions).toEqual([])
    const requestResource = await (await s.request(s.doctor, `/fhir/R5/ServiceRequest/${clinical.orders[0].id}`)).json()
    expect(requestResource.supportingInfo).toEqual([{ reference: { reference: `Procedure/${state.executions[0].id}` } }])
    expect(requestResource).not.toHaveProperty('supportingInformation')
    const verified = await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: clinical.orders[0].id, expectedOrderVersion: 1 })
    expect(verified.status).toBe(200)
    clinical = (await verified.json()).data
    expect(clinical.executions[0].status).toBe('pending')
    const diagnosis = await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: s.admission.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary', admissionCondition: '1' }] })
    expect(diagnosis.status).toBe(200)
    const medication = await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: (await diagnosis.json()).data.encounterVersion,
      duration: 'temporary', surgeryExecutionId: state.executions[0].id, selection: { kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1,
        doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' } })
    expect(medication.status).toBe(200)
    const medicationOrder = (await medication.json()).data.orders.find((item: { kind: string }) => item.kind === 'medication')
    const medicationRequest = await (await s.request(s.doctor, `/fhir/R5/MedicationRequest/${medicationOrder.id}`)).json()
    expect(medicationRequest.supportingInformation).toEqual([{ reference: `Procedure/${state.executions[0].id}` }])
    const checkedMedication = await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: medicationOrder.id, expectedOrderVersion: 1 })
    expect(checkedMedication.status).toBe(200)
    const execution = (await checkedMedication.json()).data.executions.find((item: { orderId: string }) => item.orderId === medicationOrder.id)
    expect((await s.request(s.nurse, `${s.path}/executions/administer`, { executionId: execution.id, expectedExecutionVersion: execution.version })).status).toBe(409)
  })

})

async function readySurgery(s: Awaited<ReturnType<typeof setup>>, complete = true) {
  const requested = await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion: s.admission.versionId,
    procedureId: 'hospital-surgery-4', catalogVersion: 1, plannedFor: '2026-08-25T01:00:00.000Z', reason: '合成手术测试' })
  expect(requested.status).toBe(200)
  const requestedBody = await requested.json()
  let state = requestedBody.data
  const id = requestedBody.effects[0].reference.split('/')[1]
  const checked = await s.request(s.nurse, `${s.path}/surgeries/check-preop`, { requestId: id, expectedRequestVersion: 1, note: '已核对检查' })
  expect(checked.status).toBe(200)
  const consent = await s.request(s.doctor, `${s.path}/surgeries/confirm-consent`, { requestId: id, expectedRequestVersion: 2, note: '确认同意已签署' })
  expect(consent.status).toBe(200)
  state = (await consent.json()).data
  if (complete) {
    const executed = await s.request(s.doctor, `${s.path}/surgeries/execute`, { requestId: id, expectedRequestVersion: 3,
      procedureId: 'hospital-surgery-4', catalogVersion: 1, materials: [], note: '合成实际实施' })
    expect(executed.status).toBe(200)
    state = (await executed.json()).data
  }
  return state
}
