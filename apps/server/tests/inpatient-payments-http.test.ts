import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiErrorSchema, createPatientResponseSchema } from '@clinmesh/contracts/his'
import { advanceVirtualTimeResponseSchema, inpatientCommandResponseSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientChargesResponseSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDischargeResponseSchema, inpatientPaymentPreviewResponseSchema, inpatientPaymentResponseSchema, inpatientPaymentsSchema, inpatientRefundPreviewResponseSchema, inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { refundResponseSchema } from '@clinmesh/contracts/refunds'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-payments-'))
  const password = `Test-${randomUUID()}-Aa1!`
  const options = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'), demoPassword: password,
    migrationMode: 'apply' as const, trustedOrigins: ['http://localhost'] }
  let runtime = await createClinMeshRuntime(options)
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
  const registrar = await login('registrar'), cashier = await login('cashier'), doctor = await login('inpatient-doctor'), nurse = await login('ward-nurse')
  const created = await runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: { cookie: registrar, origin: 'http://localhost',
    'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {}, input: {
      name: '合成共享支付患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } }) })
  expect(created.status).toBe(200)
  const patient = createPatientResponseSchema.parse(await created.json()).data.patient
  const registered = await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 1000 })
  expect(registered.status).toBe(200)
  const admission = inpatientCommandResponseSchema.parse(await registered.json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  return { admission, path, request, login, cashier, doctor, nurse, registrar, runtime: () => runtime,
    restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(options) } }
}

async function depart(s: Awaited<ReturnType<typeof setup>>, withCharge = false) {
  const received = inpatientCommandResponseSchema.parse(await (await s.request(s.nurse, `${s.path}/receive`, { encounterVersion: s.admission.versionId, bedId: 'bed-general-1' })).json()).data.admission
  if (withCharge) {
    const advanced = await s.request(await s.login('admin'), '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
      expectedVirtualTime:'2026-08-24T09:00:00+08:00',targetVirtualTime:'2026-08-25T00:00:00+08:00',
    })
    expect(advanced.status).toBe(200)
    advanceVirtualTimeResponseSchema.parse(await advanced.json())
  }
  const issued = inpatientDischargeResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/discharge/issue`, { encounterVersion: received.versionId, reason:'合成出院' })).json()).data.admission
  const departed = await s.request(s.nurse, `${s.path}/discharge/depart`, { encounterVersion: issued.versionId, reason:'合成出区',departureMethod:'home' })
  expect(departed.status).toBe(200)
  inpatientDischargeResponseSchema.parse(await departed.json())
}

async function settle(s: Awaited<ReturnType<typeof setup>>) {
  const preview = inpatientSettlementPreviewSchema.parse(await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json())
  return s.request(s.cashier, `${s.path}/discharge/settle`, { encounterVersion:preview.encounterVersion,fingerprint:preview.fingerprint,
    expectedChargesFen:preview.chargesFen,expectedBalanceFen:preview.balanceFen })
}

describe('住院共享资金公共 HTTP', () => {
  it('收款窄合同隔离岗位、拒绝篡改金额，并发确认仅一个唯一尝试', async () => {
    const s = await setup(), input = {kind:'deposit',amountFen:100,tenders:[{method:'cash',amountFen:100}],simulatorRule:'success'}
    for (const cookie of [s.doctor,s.nurse,s.registrar]) {
      expect((await s.request(cookie, `${s.path}/payments`)).status).toBe(403)
      expect((await s.request(cookie, `${s.path}/payments/preview`,input)).status).toBe(403)
    }
    expect((await s.request(s.cashier, `${s.path}/payments/preview`,{...input,amountFen:101})).status).toBe(400)
    const reviewed = inpatientPaymentPreviewResponseSchema.parse(await (await s.request(s.cashier, `${s.path}/payments/preview`,input)).json()).data
    const confirmation = {previewId:reviewed.previewId,commitToken:reviewed.commitToken}
    expect((await s.request(s.cashier, `${s.path}/payments/confirm`,{...confirmation,amountFen:500})).status).toBe(400)
    expect((await s.request(s.doctor, `${s.path}/payments/confirm`,confirmation)).status).toBe(403)
    const results = await Promise.all([s.request(s.cashier, `${s.path}/payments/confirm`,confirmation),s.request(s.cashier, `${s.path}/payments/confirm`,confirmation)])
    expect(results.map(result=>result.status).sort()).toEqual([200,409])
    inpatientPaymentResponseSchema.parse(await results.find(result => result.status === 200)!.json())
    const statement = inpatientPaymentsSchema.parse(await (await s.request(s.cashier, `${s.path}/payments`)).json())
    expect(statement.payments).toHaveLength(1)
    expect(statement.depositFen).toBe(1100)
  })
  it('收款预览校逐项明细；零元冲正不改净额仍使旧预览失效', async () => {
    const s = await setup()
    s.runtime().database.driver.prepare("UPDATE inpatient_bed SET daily_price_fen=0 WHERE bed_id='bed-general-1'").run()
    await depart(s,true)
    const input = {kind:'deposit',amountFen:100,tenders:[{method:'cash',amountFen:100}],simulatorRule:'success'}
    const reviewed = inpatientPaymentPreviewResponseSchema.parse(await (await s.request(s.cashier, `${s.path}/payments/preview`,input)).json()).data
    const old = inpatientSettlementPreviewSchema.parse(await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()), charge = old.charges[0]!
    const reversed = await s.request(s.cashier, `${s.path}/charges/reverse`,{chargeId:charge.id,expectedChargeVersion:charge.version,reason:'合成零元明细更正'})
    expect(reversed.status).toBe(200)
    inpatientChargesResponseSchema.parse(await reversed.json())
    const rejected = await s.request(s.cashier, `${s.path}/payments/confirm`,{previewId:reviewed.previewId,commitToken:reviewed.commitToken})
    expect(rejected.status).toBe(409)
    expect(apiErrorSchema.parse(await rejected.json()).error.code).toBe('INPATIENT_PAYMENT_PREVIEW_STALE')
    const fresh = inpatientSettlementPreviewSchema.parse(await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json())
    expect(fresh.chargesFen).toBe(old.chargesFen)
    expect(fresh.fingerprint).not.toBe(old.fingerprint)
  })
  it.each([['ambiguous-decline','declined','INPATIENT_FUNDS_REQUIRED'],['ambiguous-pending','ambiguous','INPATIENT_FUNDS_PENDING']] as const)('补缴%s查询为%s，原入金不改且默认结算不能绕过', async (simulatorRule,outcome,error) => {
    const s = await setup()
    await depart(s,true)
    const input = {kind:'supplement',amountFen:4000,tenders:[{method:'mobile',amountFen:4000}],simulatorRule}
    const reviewed = inpatientPaymentPreviewResponseSchema.parse(await (await s.request(s.cashier, `${s.path}/payments/preview`,input)).json()).data
    const attempt = inpatientPaymentResponseSchema.parse(await (await s.request(s.cashier, `${s.path}/payments/confirm`,{previewId:reviewed.previewId,commitToken:reviewed.commitToken})).json()).data
    expect(attempt.outcome).toBe('ambiguous')
    const recovered = await s.request(s.cashier, `${s.path}/payments/recover`,{paymentId:attempt.paymentId,expectedPaymentVersion:1})
    expect(inpatientPaymentResponseSchema.parse(await recovered.json()).data.outcome).toBe(outcome)
    const blocked = await settle(s)
    expect(blocked.status).toBe(409)
    expect(apiErrorSchema.parse(await blocked.json()).error.code).toBe(error)
    const statement = inpatientPaymentsSchema.parse(await (await s.request(s.cashier, `${s.path}/payments`)).json())
    expect(statement).toMatchObject({depositFen:1000,supplementFen:0,remainingFen:4000})
  })
  it('成功补缴后费用冲正可按补缴原方式退回，首次冻结账保留全部原款和负数关联', async () => {
    const s = await setup()
    await depart(s,true)
    const input = {kind:'supplement',amountFen:4000,tenders:[{method:'mobile',amountFen:4000}],simulatorRule:'ambiguous'}
    const reviewed = inpatientPaymentPreviewResponseSchema.parse(await (await s.request(s.cashier, `${s.path}/payments/preview`,input)).json()).data
    const attempt = inpatientPaymentResponseSchema.parse(await (await s.request(s.cashier, `${s.path}/payments/confirm`,{previewId:reviewed.previewId,commitToken:reviewed.commitToken})).json()).data
    const recovered = await s.request(s.cashier, `${s.path}/payments/recover`,{paymentId:attempt.paymentId,expectedPaymentVersion:1})
    expect(recovered.status).toBe(200)
    inpatientPaymentResponseSchema.parse(await recovered.json())
    const charge = inpatientSettlementPreviewSchema.parse(await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()).charges[0]!
    const reversed = await s.request(s.cashier, `${s.path}/charges/reverse`,{chargeId:charge.id,expectedChargeVersion:charge.version,reason:'合成原补缴退费'})
    expect(reversed.status).toBe(200)
    inpatientChargesResponseSchema.parse(await reversed.json())
    const statement = inpatientPaymentsSchema.parse(await (await s.request(s.cashier, `${s.path}/payments`)).json())
    for (const source of statement.sources) {
      const refundPreview = inpatientRefundPreviewResponseSchema.parse(await (await s.request(s.cashier, `${s.path}/refunds/preview`,{sourceId:source.id,amountFen:source.amountFen,simulatorRule:'success'})).json()).data
      const confirmed = await s.request(s.cashier, `${s.path}/refunds/confirm`,{previewId:refundPreview.previewId,commitToken:refundPreview.commitToken})
      expect(confirmed.status).toBe(200)
      const refund = refundResponseSchema.parse(await confirmed.json()).data
      if(source.id===attempt.paymentId) expect(refund.tenders).toEqual(input.tenders)
    }
    const frozen = await settle(s)
    expect(frozen.status).toBe(200)
    const result = inpatientSettlementResponseSchema.parse(await frozen.json()).data
    expect(result.transactions.reduce((sum,item)=>sum+item.amountFen,0)).toBe(0)
    expect(result.transactions.find(item=>item.kind==='refund' && item.sourceSupplementId===attempt.paymentId)).toMatchObject({amountFen:-4000,kind:'refund'})
    expect(result.transactions.filter(item=>item.kind==='supplement')).toHaveLength(1)
  })
  it('收费员按已审阅预览收取组合预交金，刷新及原key重放不重复记账', async () => {
    const s = await setup()
    const input = { kind: 'deposit', amountFen: 2500, tenders: [{ method: 'cash', amountFen: 1000 }, { method: 'mobile', amountFen: 1500 }], simulatorRule: 'success' }
    const preview = await s.request(s.cashier, `${s.path}/payments/preview`, input)
    expect(preview.status).toBe(200)
    const reviewed = inpatientPaymentPreviewResponseSchema.parse(await preview.json()).data
    expect(reviewed).toMatchObject({ amountFen: 2500, expectedOutcome: 'success', tenders: input.tenders })
    const key = randomUUID(), confirmation = { previewId: reviewed.previewId, commitToken: reviewed.commitToken }
    const confirmed = await s.request(s.cashier, `${s.path}/payments/confirm`, confirmation, key)
    expect(confirmed.status).toBe(200)
    const result = inpatientPaymentResponseSchema.parse(await confirmed.json())
    expect(result.data).toMatchObject({ amountFen: 2500, outcome: 'success', kind: 'deposit' })
    expect(inpatientPaymentResponseSchema.parse(await (await s.request(s.cashier, `${s.path}/payments/confirm`, confirmation, key)).json())).toEqual(result)
    expect(inpatientDetailSchema.parse(await (await s.request(s.cashier, s.path)).json()).admission.depositFen).toBe(3500)
    const statement = inpatientPaymentsSchema.parse(await (await s.request(s.cashier, `${s.path}/payments`)).json())
    expect(statement.payments).toHaveLength(1)
    expect(statement.payments[0]!.tenders).toEqual(input.tenders)
  })
  it('预交金未知跨重启保留，查询原尝试后唯一入账；未查明前不能重收或封账', async () => {
    const s = await setup()
    const input = { kind: 'deposit', amountFen: 2000, tenders: [{ method: 'cash', amountFen: 2000 }], simulatorRule: 'ambiguous' }
    const reviewed = inpatientPaymentPreviewResponseSchema.parse(await (await s.request(s.cashier, `${s.path}/payments/preview`, input)).json()).data
    const first = await s.request(s.cashier, `${s.path}/payments/confirm`, { previewId: reviewed.previewId, commitToken: reviewed.commitToken })
    expect(first.status).toBe(200)
    const attempt = inpatientPaymentResponseSchema.parse(await first.json()).data
    expect(attempt.outcome).toBe('ambiguous')
    expect((await s.request(s.cashier, `${s.path}/payments/preview`, input)).status).toBe(409)
    const received = inpatientCommandResponseSchema.parse(await (await s.request(s.nurse, `${s.path}/receive`, { encounterVersion: s.admission.versionId, bedId: 'bed-general-1' })).json()).data.admission
    const issued = inpatientDischargeResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/discharge/issue`, { encounterVersion: received.versionId, reason: '合成临床出院' })).json()).data.admission
    const departed = await s.request(s.nurse, `${s.path}/discharge/depart`, { encounterVersion: issued.versionId, reason: '合成出区', departureMethod: 'home' })
    expect(departed.status).toBe(200)
    inpatientDischargeResponseSchema.parse(await departed.json())
    const preview = inpatientSettlementPreviewSchema.parse(await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json())
    const blocked = await s.request(s.cashier, `${s.path}/discharge/settle`, { encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint, expectedChargesFen: 0, expectedBalanceFen: -1000 })
    expect(blocked.status).toBe(409)
    expect(apiErrorSchema.parse(await blocked.json()).error.code).toBe('INPATIENT_FUNDS_PENDING')
    await s.restart()
    const key = randomUUID(), recovery = { paymentId: attempt.paymentId, expectedPaymentVersion: 1 }
    const recovered = await s.request(s.cashier, `${s.path}/payments/recover`, recovery, key)
    expect(recovered.status).toBe(200)
    const result = inpatientPaymentResponseSchema.parse(await recovered.json())
    expect(result.data).toMatchObject({ outcome: 'success', version: 2 })
    expect(inpatientPaymentResponseSchema.parse(await (await s.request(s.cashier, `${s.path}/payments/recover`, recovery, key)).json())).toEqual(result)
    expect(inpatientDetailSchema.parse(await (await s.request(s.cashier, s.path)).json()).admission.depositFen).toBe(3000)
  })
  it('首次退款未知阻止封账和清床，查询原退款后保留冻结账且不重复退', async () => {
    const s = await setup()
    const received = inpatientCommandResponseSchema.parse(await (await s.request(s.nurse, `${s.path}/receive`, { encounterVersion: s.admission.versionId, bedId: 'bed-general-1' })).json()).data.admission
    const issued = inpatientDischargeResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/discharge/issue`, { encounterVersion: received.versionId, reason: '合成出院' })).json()).data.admission
    inpatientDischargeResponseSchema.parse(await (await s.request(s.nurse, `${s.path}/discharge/depart`, { encounterVersion: issued.versionId, reason: '合成出区', departureMethod: 'home' })).json())
    const statement = inpatientPaymentsSchema.parse(await (await s.request(s.cashier, `${s.path}/payments`)).json())
    const reviewedResponse = await s.request(s.cashier, `${s.path}/refunds/preview`, { sourceId: statement.sources[0]!.id, amountFen: 1000, simulatorRule: 'ambiguous' })
    expect(reviewedResponse.status).toBe(200)
    const reviewed = inpatientRefundPreviewResponseSchema.parse(await reviewedResponse.json()).data
    const refund = refundResponseSchema.parse(await (await s.request(s.cashier, `${s.path}/refunds/confirm`, { previewId: reviewed.previewId, commitToken: reviewed.commitToken })).json()).data
    expect(refund.outcome).toBe('ambiguous')
    const preview = inpatientSettlementPreviewSchema.parse(await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json())
    const settle = { encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint, expectedChargesFen: 0, expectedBalanceFen: -1000 }
    expect((await s.request(s.cashier, `${s.path}/discharge/settle`, settle)).status).toBe(409)
    expect((await s.request(s.nurse, `${s.path}/discharge/clear`, { encounterVersion: preview.encounterVersion, reason: '不得清床' })).status).toBe(409)
    expect((await s.request(s.cashier, `${s.path}/refunds/preview`, { sourceId: statement.sources[0]!.id, amountFen: 1, simulatorRule: 'success' })).status).toBe(409)
    const recovery = { refundId: refund.refundId, expectedRefundVersion: 1 }, key = randomUUID()
    const recovered = await s.request(s.cashier, `${s.path}/refunds/recover`, recovery, key)
    expect(recovered.status).toBe(200)
    const receipt = refundResponseSchema.parse(await recovered.json())
    expect(receipt.data).toMatchObject({ refundId: refund.refundId, outcome: 'success', version: 2 })
    expect(refundResponseSchema.parse(await (await s.request(s.cashier, `${s.path}/refunds/recover`, recovery, key)).json())).toEqual(receipt)
    expect((await s.request(s.cashier, `${s.path}/discharge/settle`, settle)).status).toBe(409)
    const fresh = inpatientSettlementPreviewSchema.parse(await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json())
    const frozen = await s.request(s.cashier, `${s.path}/discharge/settle`, { encounterVersion: fresh.encounterVersion, fingerprint: fresh.fingerprint, expectedChargesFen: 0, expectedBalanceFen: -1000 })
    expect(frozen.status).toBe(200)
    const result = inpatientSettlementResponseSchema.parse(await frozen.json()).data
    expect(result.transactions).toHaveLength(2)
    expect(result.transactions.find(item => item.kind === 'refund')).toMatchObject({ id: refund.refundId, sourceDepositId: statement.sources[0]!.id, amountFen: -1000 })
    const cleared = await s.request(s.nurse, `${s.path}/discharge/clear`, { encounterVersion: result.encounterVersion, reason: '资金确定后清床' })
    expect(cleared.status).toBe(200)
    inpatientDischargeResponseSchema.parse(await cleared.json())
  })
})
