import { inpatientDischargeResponseSchema, inpatientSettlementResponseSchema, inpatientSettlementPreviewSchema, inpatientDischargeEventsSchema } from '@clinmesh/contracts/inpatient-discharge'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime, type CreateClinMeshRuntimeOptions } from '../src/runtime.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function setup(depositFen = 100000) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-discharge-'))
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
      name: '合成出院患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } }) })
  const patient = (await created.json()).data.patient
  const registered = (await (await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen })).json()).data.admission
  const admission = (await (await request(nurse, `/api/his/v1/inpatient/admissions/${registered.id}/receive`, {
    encounterVersion: registered.versionId, bedId: 'bed-general-1' })).json()).data.admission
  return { runtime, options, request, login, patient, admission, doctor, nurse, cashier, registrar, path: `/api/his/v1/inpatient/admissions/${admission.id}` }
}

describe('住院出院与结算公共 HTTP', () => {
  it('医生出院医嘱只进入待出院并保床，其他岗位拒绝且未出区不能结算', async () => {
    const s = await setup(), input = { encounterVersion: s.admission.versionId, reason: '完成本次住院治疗' }
    for (const cookie of [s.nurse, s.cashier, s.registrar, await s.login('admin'), await s.login('pharmacist'), await s.login('medical-records')]) expect((await s.request(cookie, `${s.path}/discharge/issue`, input)).status).toBe(403)
    const issued = await s.request(s.doctor, `${s.path}/discharge/issue`, input)
    expect(issued.status).toBe(200)
    const result = await issued.json()
    expect(result.data.admission).toMatchObject({ status: 'discharge-pending', financialStatus: 'open', bedId: 'bed-general-1' })
    const preview = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
    const settled = await s.request(s.cashier, `${s.path}/discharge/settle`, { encounterVersion: result.data.admission.versionId,
      fingerprint: preview.fingerprint, expectedChargesFen: preview.chargesFen, expectedBalanceFen: preview.balanceFen })
    expect(settled.status).toBe(409)
    expect((await (await s.request(s.doctor, s.path)).json()).admission.status).toBe('discharge-pending')
  })
  it('护士出区保留原床并记录实际离院方式和完整事件，召回追加逆向事件及新床位period', async () => {
    const s = await setup()
    const issued = await (await s.request(s.doctor, `${s.path}/discharge/issue`, { encounterVersion: s.admission.versionId, reason: '治疗完成' })).json()
    const input = { encounterVersion: issued.data.admission.versionId, reason: '已完成出区核对', departureMethod: 'home' }
    expect((await s.request(s.doctor, `${s.path}/discharge/depart`, input)).status).toBe(403)
    const key = randomUUID(), departed = await s.request(s.nurse, `${s.path}/discharge/depart`, input, key)
    expect(departed.status).toBe(200)
    const result = await departed.json()
    expect(result.data.admission).toMatchObject({ status: 'departed', financialStatus: 'open', bedId: 'bed-general-1' })
    expect(await (await s.request(s.nurse, `${s.path}/discharge/depart`, input, key)).json()).toEqual(result)
    const before = await (await s.request(s.doctor, `/fhir/R5/Encounter/${s.admission.id}`)).json()
    expect(before.status).toBe('discharged')
    expect(before.location[0]).toMatchObject({ status: 'completed', period: { end: '2026-08-24T09:00:00+08:00' } })
    const recalled = await s.request(s.doctor, `${s.path}/discharge/recall`, { encounterVersion: result.data.admission.versionId, reason: '出区后病情变化召回' })
    expect(recalled.status).toBe(200)
    expect((await recalled.json()).data.admission).toMatchObject({ status: 'admitted', bedId: 'bed-general-1', financialStatus: 'open' })
    const events = await (await s.request(s.doctor, `${s.path}/discharge`)).json()
    expect(events.events.map((event: { kind: string }) => event.kind)).toEqual(['issue','depart','recall'])
    expect(events.events[1].departureMethod).toBe('home')
    expect(events.events[2].reversesEventId).toBe(events.events[1].id)
    const after = await (await s.request(s.doctor, `/fhir/R5/Encounter/${s.admission.id}`)).json()
    expect(after.location).toHaveLength(2)
    expect(after.location[0]).toEqual(before.location[0])
    expect(after.location[1].status).toBe('active')
    expect((await s.request(s.cashier, `${s.path}/discharge`)).status).toBe(403)
  })

  it('待出院可申请停嘱和核停但不得新增执行；仍在院床日费继续，出区后停止', async () => {
    const s = await setup(), admin = await s.login('admin')
    const catalog = await (await s.request(s.doctor, '/api/his/v1/inpatient/clinical-catalog')).json(), service = catalog.services[0]
    const selection = { kind: 'service', serviceId: service.id, serviceVersion: service.version, quantity: 1 }
    const orderResponse = await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: s.admission.versionId, duration: 'temporary', selection })
    expect(orderResponse.status).toBe(200)
    const order = (await orderResponse.json()).data.orders[0]
    const verified = await (await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })).json()
    const issued = await (await s.request(s.doctor, `${s.path}/discharge/issue`, { encounterVersion: s.admission.versionId, reason: '完成治疗' })).json()
    const departure = { encounterVersion: issued.data.admission.versionId, reason: '护士核对', departureMethod: 'home' }
    expect((await s.request(s.nurse, `${s.path}/discharge/depart`, departure)).status).toBe(409)
    expect((await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: issued.data.admission.versionId, duration: 'temporary', selection })).status).toBe(409)
    expect((await s.request(s.nurse, `${s.path}/executions/complete`, { executionId: verified.data.executions[0].id, expectedExecutionVersion: 1 })).status).toBe(409)
    const stop = await s.request(s.doctor, `${s.path}/orders/request-stop`, { orderId: order.id, expectedOrderVersion: 2, reason: '出院停嘱' })
    expect(stop.status).toBe(200)
    const stopped = await s.request(s.nurse, `${s.path}/orders/verify-stop`, { orderId: order.id, expectedOrderVersion: 3 })
    expect(stopped.status).toBe(200)
    expect((await stopped.json()).data.executions[0].status).toBe('cancelled')
    const advance = await s.request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-25T00:00:00+08:00' })
    expect(advance.status).toBe(200)
    expect((await advance.json()).data.bedChargesCreated).toBe(1)
    const departed = await s.request(s.nurse, `${s.path}/discharge/depart`, departure)
    expect(departed.status).toBe(200)
    const later = await s.request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: '2026-08-25T00:00:00+08:00', targetVirtualTime: '2026-08-26T00:00:00+08:00' })
    expect(later.status).toBe(200)
    expect((await later.json()).data.bedChargesCreated).toBe(0)
  })

  it.each([[100000,-95000,'refund'],[1000,4000,'supplement'],[5000,0,undefined]] as const)('预交%d分结算差额%d分，独立结算后才能清床且资金原key重放', async (deposit, balance, kind) => {
    const s = await setup(deposit), admin = await s.login('admin')
    const advance = await s.request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-25T00:00:00+08:00' })
    expect(advance.status).toBe(200)
    const issue = (await (await s.request(s.doctor, `${s.path}/discharge/issue`, { encounterVersion: s.admission.versionId, reason: '治疗完成' })).json()).data.admission
    const departure = await s.request(s.nurse, `${s.path}/discharge/depart`, { encounterVersion: issue.versionId, reason: '完成出区核对', departureMethod: 'home' })
    expect(departure.status).toBe(200)
    const departed = (await departure.json()).data.admission
    expect((await s.request(s.nurse, `${s.path}/discharge/clear`, { encounterVersion: departed.versionId, reason: '清床' })).status).toBe(409)
    const preview = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
    expect(preview).toMatchObject({ chargesFen: 5000, depositFen: deposit, balanceFen: balance })
    const key = randomUUID(), input = { encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint, expectedChargesFen: 5000, expectedBalanceFen: balance }
    const settled = await s.request(s.cashier, `${s.path}/discharge/settle`, input, key)
    expect(settled.status).toBe(200)
    const response = await settled.json(), data = response.data
    expect(data.financialStatus).toBe('settled')
    expect(data.settlement).toMatchObject({ chargesFen: 5000, depositFen: deposit, balanceFen: balance, fingerprint: preview.fingerprint })
    expect(data.transactions.filter((transaction: { kind: string }) => transaction.kind !== 'deposit')).toHaveLength(kind === undefined ? 0 : 1)
    if (kind) expect(data.transactions.at(-1)).toMatchObject({ kind, amountFen: kind === 'refund' ? balance : balance })
    if (kind === 'refund') expect(data.transactions.at(-1).sourceDepositId).toBe(data.transactions[0].id)
    expect(await (await s.request(s.cashier, `${s.path}/discharge/settle`, input, key)).json()).toEqual(response)
    expect((await s.request(s.cashier, `${s.path}/discharge/settle`, { ...input, encounterVersion: data.encounterVersion })).status).toBe(409)
    expect((await s.request(s.doctor, `${s.path}/discharge/recall`, { encounterVersion: data.encounterVersion, reason: '结算后不得召回' })).status).toBe(409)
    expect((await (await s.request(s.doctor, s.path)).json()).admission).toMatchObject({ status: 'departed', bedId: 'bed-general-1' })
    const cleared = await s.request(s.nurse, `${s.path}/discharge/clear`, { encounterVersion: data.encounterVersion, reason: '完成床单位清洁' })
    expect(cleared.status).toBe(200)
    const admission = (await cleared.json()).data.admission
    expect(admission.status).toBe('cleared')
    expect(admission.bedId).toBeUndefined()
    const beds = await (await s.request(s.nurse, '/api/his/v1/inpatient/catalog')).json()
    expect(beds.beds.find((bed: { id: string }) => bed.id === 'bed-general-1').admissionId).toBeUndefined()
    if (kind === undefined) {
      const registered = await s.request(s.registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch:'epoch-1',patientId:s.patient.id,
        patientVersion:s.patient.versionId,admissionRoute:'direct',wardId:'ward-general',depositFen:0 })
      expect(registered.status).toBe(200)
      const next = (await registered.json()).data.admission
      expect(next.id).not.toBe(s.admission.id)
      const received = await s.request(s.nurse, `/api/his/v1/inpatient/admissions/${next.id}/receive`, { encounterVersion:next.versionId,bedId:'bed-general-1' })
      expect(received.status).toBe(200)
      expect((await received.json()).data.admission.bedId).toBe('bed-general-1')
    }
    expect(JSON.stringify(data)).not.toMatch(/diagnosis|doseText|departureMethod|reason/)
  })

  it.each([5000,0])('费用%d分冲正使原预览失效；零元冲正同净额仍核逐项指纹，显式重新预览才可提交', async price => {
    const s = await setup(), admin = await s.login('admin')
    s.runtime.database.driver.prepare('UPDATE inpatient_bed SET daily_price_fen=? WHERE bed_id=?').run(price, 'bed-general-1')
    await s.request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-25T00:00:00+08:00' })
    await depart(s)
    const preview = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
    expect(preview.chargesFen).toBe(price)
    const input = { encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint, expectedChargesFen: preview.chargesFen, expectedBalanceFen: preview.balanceFen }
    const amountMismatch = await s.request(s.cashier, `${s.path}/discharge/settle`, { ...input, expectedChargesFen:price+1 })
    expect(amountMismatch.status).toBe(409)
    expect((await amountMismatch.json()).error.code).toBe('INPATIENT_SETTLEMENT_PREVIEW_STALE')
    const charge = preview.charges[0]
    expect((await s.request(s.cashier, `${s.path}/charges/reverse`, { chargeId: charge.id, expectedChargeVersion: charge.version, reason: '合成退费核对' })).status).toBe(200)
    const rejected = await s.request(s.cashier, `${s.path}/discharge/settle`, input)
    expect(rejected.status).toBe(409)
    expect((await rejected.json()).error.code).toBe('INPATIENT_SETTLEMENT_PREVIEW_STALE')
    const refreshed = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
    expect(refreshed.encounterVersion).toBe(preview.encounterVersion)
    expect(refreshed.fingerprint).not.toBe(preview.fingerprint)
    expect(refreshed.chargesFen).toBe(0)
    expect((await s.request(s.cashier, `${s.path}/discharge/settle`, { encounterVersion: refreshed.encounterVersion, fingerprint: refreshed.fingerprint,
      expectedChargesFen: 0, expectedBalanceFen: refreshed.balanceFen })).status).toBe(200)
    expect((await s.request(s.cashier, `${s.path}/charges/reverse`, { chargeId: charge.id, expectedChargeVersion: charge.version, reason: '封账后禁止' })).status).toBe(409)
  })

  it('召回与结算竞争仅一个成功，召回不恢复医嘱且原结算快照不能盲重做', async () => {
    const s = await setup()
    await depart(s)
    const preview = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
    expect((await s.request(s.doctor, `${s.path}/discharge/recall`, { encounterVersion: preview.encounterVersion, reason: '返回病区' })).status).toBe(200)
    expect((await s.request(s.cashier, `${s.path}/discharge/settle`, { encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint,
      expectedChargesFen: preview.chargesFen, expectedBalanceFen: preview.balanceFen })).status).toBe(409)
    expect((await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()).financialStatus).toBe('open')
  })

  it.each(['projection','audit'])('结算%s失败时状态、资金和结算快照整事务回滚，原key可安全重试', async failure => {
    const s = await setup()
    await depart(s)
    const preview = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
    const key = randomUUID(), input = { encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint, expectedChargesFen: preview.chargesFen, expectedBalanceFen: preview.balanceFen }
    s.runtime.database.driver.exec(failure === 'projection'
      ? "CREATE TRIGGER fail_discharge BEFORE UPDATE ON fhir_resource WHEN NEW.resource_type='Account' BEGIN SELECT RAISE(ABORT,'synthetic projection failure'); END;"
      : "CREATE TRIGGER fail_discharge BEFORE INSERT ON audit_log WHEN NEW.operation='inpatient.discharge.settle' AND NEW.outcome='success' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;")
    expect((await s.request(s.cashier, `${s.path}/discharge/settle`, input, key)).status).toBe(500)
    expect(await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()).toEqual(preview)
    s.runtime.database.driver.exec('DROP TRIGGER fail_discharge')
    expect((await s.request(s.cashier, `${s.path}/discharge/settle`, input, key)).status).toBe(200)
  })

  it.each(['issue','depart','recall','clear','settle'] as const)('出院%s拒绝Cookie缺失或恶意Origin且不改事实，可信Origin可办', async action => {
    const s = await setup()
    let admission = s.admission, cookie = s.doctor
    if (action === 'depart') {
      const issued = await s.request(s.doctor, `${s.path}/discharge/issue`, { encounterVersion: admission.versionId, reason: '治疗完成' })
      admission = (await issued.json()).data.admission
      cookie = s.nurse
    } else if (action !== 'issue') admission = await depart(s)
    let input: Record<string, unknown> = { encounterVersion: admission.versionId, reason: '合成Origin验证', ...(action === 'depart' ? { departureMethod: 'home' } : {}) }
    if (action === 'settle' || action === 'clear') {
      const preview = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
      const settlement = { encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint, expectedChargesFen: preview.chargesFen, expectedBalanceFen: preview.balanceFen }
      if (action === 'settle') { input = settlement; cookie = s.cashier }
      else {
        const settled = await s.request(s.cashier, `${s.path}/discharge/settle`, settlement)
        input = { encounterVersion: (await settled.json()).data.encounterVersion, reason: '清床' }; cookie = s.nurse
      }
    }
    const before = await (await s.request(s.doctor, s.path)).json()
    for (const origin of [undefined,'https://untrusted.example']) {
      const rejected = await s.runtime.app.request(`${s.path}/discharge/${action}`, { method:'POST',headers:{cookie,
        'content-type':'application/json','idempotency-key':randomUUID(),...(origin === undefined ? {} : {origin})},body:JSON.stringify({input}) })
      expect(rejected.status).toBe(403)
      expect((await rejected.json()).error.code).toBe('CSRF_REJECTED')
    }
    expect(await (await s.request(s.doctor, s.path)).json()).toEqual(before)
    expect((await s.request(cookie, `${s.path}/discharge/${action}`, input)).status).toBe(200)
  })

  it('纯Agent Bearer保留无Origin例外，原回执仅原岗位可恢复', async () => {
    const s = await setup(), admin = await s.login('admin')
    const control = (path: string, input: unknown) => s.runtime.app.request(path, { method:'POST',headers:{cookie:admin,origin:'http://localhost',
      'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify(input) })
    const client = await (await control('/api/agent/v1/clients',{name:'合成出院Agent'})).json()
    const grantResponse = await control('/api/agent/v1/grants',{agentClientId:client.agentClientId,operationIds:['inpatient.discharge.issue'],
      practitionerRoleId:'practitioner-role-inpatient-doctor',ttlSeconds:3600})
    expect(grantResponse.status).toBe(200)
    const grant = await grantResponse.json(), key = randomUUID()
    const requested = await s.runtime.app.request(`${s.path}/discharge/issue`, { method:'POST',headers:{authorization:`Bearer ${grant.token}`,
      'content-type':'application/json','idempotency-key':key},body:JSON.stringify({input:{encounterVersion:s.admission.versionId,reason:'合成Bearer出院申请'}}) })
    expect(requested.status).toBe(200)
    const forbidden = await s.request(s.nurse, `/api/his/v1/command-receipts?operationId=inpatient.discharge.issue&idempotencyKey=${key}`)
    expect([403,404]).toContain(forbidden.status)
    expect((await (await s.request(s.doctor, s.path)).json()).admission.status).toBe('discharge-pending')
  })

  it('未收口手术阻断出院，取消后才可办理；当前其他科室没有出院权', async () => {
    const s = await setup()
    const surgery = await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion:s.admission.versionId,procedureId:'hospital-surgery-4',catalogVersion:1,
      plannedFor:'2026-08-25T01:00:00.000Z',reason:'合成手术在途' })
    expect(surgery.status).toBe(200)
    const input = { encounterVersion:s.admission.versionId,reason:'出院核对' }
    const rejected = await s.request(s.doctor, `${s.path}/discharge/issue`, input)
    expect(rejected.status).toBe(409)
    expect((await rejected.json()).error.code).toBe('INPATIENT_SURGERY_PENDING')
    const request = (await surgery.json()).data.requests[0]
    expect((await s.request(s.doctor, `${s.path}/surgeries/cancel`, { requestId:request.id,expectedRequestVersion:request.version,note:'无需实施' })).status).toBe(200)
    const role = await s.runtime.app.request('/api/auth/role', { method:'POST',headers:{cookie:s.doctor,origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({practitionerRoleId:'practitioner-role-inpatient-doctor-surgery'}) })
    expect(role.status).toBe(200)
    expect((await s.request(s.doctor, `${s.path}/discharge/issue`, input)).status).toBe(403)
    await s.runtime.app.request('/api/auth/role', { method:'POST',headers:{cookie:s.doctor,origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({practitionerRoleId:'practitioner-role-inpatient-doctor'}) })
    expect((await s.request(s.doctor, `${s.path}/discharge/issue`, input)).status).toBe(200)
  })

})

async function depart(s: Awaited<ReturnType<typeof setup>>) {
  const current = (await (await s.request(s.doctor, s.path)).json()).admission
  const issued = await s.request(s.doctor, `${s.path}/discharge/issue`, { encounterVersion: current.versionId, reason: '治疗完成' })
  expect(issued.status).toBe(200)
  const admission = (await issued.json()).data.admission
  const result = await s.request(s.nurse, `${s.path}/discharge/depart`, { encounterVersion: admission.versionId, reason: '已核对', departureMethod: 'home' })
  expect(result.status).toBe(200)
  return (await result.json()).data.admission
}
