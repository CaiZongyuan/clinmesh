import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { apiErrorSchema, billingCaseSchema, createPatientResponseSchema, doctorQueueSchema, firstVisitDraftResponseSchema,
  laboratoryOrderResponseSchema, paymentPreviewResponseSchema, paymentResponseSchema, registrationResponseSchema, triageResponseSchema } from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDischargeResponseSchema, inpatientPaymentPreviewResponseSchema, inpatientPaymentResponseSchema,
  inpatientPaymentsSchema, inpatientRefundPreviewResponseSchema, inpatientSettlementPreviewSchema } from '@clinmesh/contracts/inpatient-discharge'
import { refundResponseSchema } from '@clinmesh/contracts/refunds'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { signIn } from './fixtures/consultation.ts'
import { openPaymentCollectionWorker } from './fixtures/payment-collection-worker-client.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function parsed<T>(schema: z.ZodType<T>, response: Response | Promise<Response>) {
  const result = await response
  expect(result.status, await result.clone().text()).toBe(200)
  return schema.parse(await result.json())
}
type Stay = { id: string; patientId: string; path: string; versionId: string }
type Preview = z.infer<typeof inpatientPaymentPreviewResponseSchema>['data']

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-collection-'))
  cleanups.push(() => rm(directory, { recursive: true }))
  const password = `Test-${randomUUID()}-Aa1!`
  const options = { authBaseUrl: 'http://localhost', trustedOrigins: ['http://localhost'],
    authSecret: 'test-auth-secret-with-at-least-32-characters', cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
    databasePath: join(directory, 'hospital.sqlite'), demoPassword: password, migrationMode: 'apply' as const }
  let runtime = await createClinMeshRuntime(options)
  cleanups.push(() => runtime.close())
  const registrar = await signIn(runtime, 'registrar@demo.clinmesh.local', password)
  const cashier = await signIn(runtime, 'cashier@demo.clinmesh.local', password)
  const nurse = await signIn(runtime, 'ward-nurse@demo.clinmesh.local', password)
  const doctor = await signIn(runtime, 'inpatient-doctor@demo.clinmesh.local', password)
  function request(cookie: string, path: string, input?: unknown, key = randomUUID(), expectedVersions?: Record<string, string>) {
    return runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key },
      ...(input === undefined ? {} : { body: JSON.stringify({ input, ...(expectedVersions === undefined ? {} : { expectedVersions }) }) }) })
  }
  async function admit(patientId?: string, depositFen = 0): Promise<Stay> {
    const patient = patientId === undefined ? (await parsed(createPatientResponseSchema, request(registrar, '/api/his/v1/patients', {
      name: '合成共享住院收款患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` }, randomUUID(), {}))).data.patient
      : { id: patientId, versionId: '1' }
    const admission = (await parsed(inpatientCommandResponseSchema, request(registrar, '/api/his/v1/inpatient/admissions', {
      expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen }))).data.admission
    return { id: admission.id, patientId: patient.id, path: `/api/his/v1/inpatient/admissions/${admission.id}`, versionId: admission.versionId }
  }
  const funds = (stay: Stay) => parsed(inpatientPaymentsSchema, request(cashier, `${stay.path}/payments`))
  const receipt = (operationId: string, key: string) => request(cashier, `/api/his/v1/command-receipts?operationId=${operationId}&idempotencyKey=${key}`)
  const preview = async (stay: Stay, kind: 'deposit' | 'supplement', amountFen: number, simulatorRule = 'success') =>
    (await parsed(inpatientPaymentPreviewResponseSchema, request(cashier, `${stay.path}/payments/preview`, {
      kind, amountFen, tenders: [{ method: 'mobile', amountFen }], simulatorRule }))).data
  const confirm = (stay: Stay, reviewed: Preview, key = randomUUID()) => request(cashier, `${stay.path}/payments/confirm`, {
    previewId: reviewed.previewId, commitToken: reviewed.commitToken }, key)
  async function depart(stay: Stay) {
    const received = (await parsed(inpatientCommandResponseSchema, request(nurse, `${stay.path}/receive`, {
      encounterVersion: stay.versionId, bedId: 'bed-general-1' }))).data.admission
    const issued = (await parsed(inpatientDischargeResponseSchema, request(doctor, `${stay.path}/discharge/issue`, {
      encounterVersion: received.versionId, reason: '合成共享资金出院核对' }))).data.admission
    await parsed(inpatientDischargeResponseSchema, request(nurse, `${stay.path}/discharge/depart`, {
      encounterVersion: issued.versionId, reason: '合成资金隔离出区核对', departureMethod: 'home' }))
  }
  async function outpatient(patientId: string) {
    const triage = await signIn(runtime, 'triage@demo.clinmesh.local', password)
    const outpatientDoctor = await signIn(runtime, 'doctor@demo.clinmesh.local', password)
    const registration = (await parsed(registrationResponseSchema, request(registrar, '/api/his/v1/registrations/actions/register', {
      departmentId: 'department-general-medicine', locationId: 'location-outpatient', patientId,
      visitDate: '2026-08-24', visitTypeId: 'visit-general' }, randomUUID(), { [`Patient/${patientId}`]: '1' }))).data
    const path = `/api/his/v1/encounters/${registration.encounterId}`
    const handoff = (await parsed(triageResponseSchema, request(triage, `${path}/actions/record-triage`, {
      acuityCode: 'level-3', bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 }, chiefComplaint: '合成发热两天',
      oxygenSaturationPct: 98, pulseBpm: 102, respirationBpm: 20, temperatureC: 38.6,
    }, randomUUID(), { [`Encounter/${registration.encounterId}`]: '1', [`Task/${registration.queueTaskId}`]: '1' }))).data
    const queue = await parsed(doctorQueueSchema, request(outpatientDoctor, '/api/his/v1/doctor/queue?pageSize=20'))
    const item = queue.items.find(row => row.encounterId === registration.encounterId)!
    expect(item).toBeDefined()
    expect((await request(outpatientDoctor, `${path}/actions/start-first-visit`, {}, randomUUID(), {
      [`Encounter/${registration.encounterId}`]: handoff.encounterVersion, [`Task/${handoff.doctorTaskId}`]: '1' })).status).toBe(200)
    const draft = await runtime.app.request(`${path}/drafts/first-visit`, { method: 'PUT',
      headers: { cookie: outpatientDoctor, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ input: { assessment: '合成急性发热，待检验明确病原', expectedDraftVersion: 0, historyOfPresentIllness: '两天前出现发热，伴咽痛。' },
        expectedVersions: { [`Encounter/${registration.encounterId}`]: '3' } }) })
    const saved = (await parsed(firstVisitDraftResponseSchema, draft)).data
    const order = (await parsed(laboratoryOrderResponseSchema, request(outpatientDoctor, `${path}/actions/issue-laboratory-order`, {
      catalogItemId: 'lab-fever-panel', expectedDraftVersion: saved.draftVersion, indicationCode: 'fever',
    }, randomUUID(), { [`Encounter/${registration.encounterId}`]: '3', [`Task/${handoff.doctorTaskId}`]: '2' }))).data
    return { caseId: item.caseId, chargeItemId: order.chargeItemId }
  }
  return { get runtime() { return runtime }, options, password, registrar, cashier, doctor, nurse,
    request, admit, funds, receipt, preview, confirm, depart, outpatient,
    async restart() { await runtime.close(); runtime = await createClinMeshRuntime(options) } }
}

describe('住院使用共享收款内核的公开合同', () => {
  it('独立进程补缴同键只记一笔，异载荷拒绝，不同键竞争按当前差额恢复', async () => {
    const s = await setup(), stay = await s.admit()
    // Existing public fees arise from the ward's ordinary daily charging workflow.
    const received = (await parsed(inpatientCommandResponseSchema, s.request(s.nurse, `${stay.path}/receive`, { encounterVersion: stay.versionId, bedId: 'bed-general-1' }))).data.admission
    const admin = await signIn(s.runtime, 'admin@demo.clinmesh.local', s.password)
    expect((await s.request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
      expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-25T00:00:00+08:00' })).status).toBe(200)
    const issued = (await parsed(inpatientDischargeResponseSchema, s.request(s.doctor, `${stay.path}/discharge/issue`, {
      encounterVersion: received.versionId, reason: '合成补缴竞争出院核对' }))).data.admission
    await parsed(inpatientDischargeResponseSchema, s.request(s.nurse, `${stay.path}/discharge/depart`, {
      encounterVersion: issued.versionId, reason: '合成补缴竞争出区核对', departureMethod: 'home' }))
    expect((await s.funds(stay)).remainingFen).toBe(5000)
    const first = await s.preview(stay, 'supplement', 2000), key = randomUUID()
    const workers = await Promise.all([0, 1].map(() => openPaymentCollectionWorker(s.options.databasePath, s.password, cleanup => cleanups.push(cleanup))))
    expect(workers[0]!.pid).not.toBe(workers[1]!.pid)
    const race = (previews: [Preview, Preview], keys: [string, string]) => {
      const startAt = Date.now() + 100
      return Promise.all(workers.map((worker, index) => worker.run({ path: `${stay.path}/payments/confirm`, cookie: s.cashier,
        key: keys[index]!, startAt, body: { input: { previewId: previews[index]!.previewId, commitToken: previews[index]!.commitToken } } })))
    }
    const same = await race([first, first], [key, key])
    expect(same.map(result => result.status)).toEqual([200, 200])
    const accepted = inpatientPaymentResponseSchema.parse(same[0]!.body)
    expect(inpatientPaymentResponseSchema.parse(same[1]!.body)).toEqual(accepted)
    expect(inpatientPaymentResponseSchema.parse((await parsed(commandReceiptLookupSchema, s.receipt('inpatient.payment.confirm', key))).response)).toEqual(accepted)
    const changed = await s.request(s.cashier, `${stay.path}/payments/confirm`, { previewId: first.previewId, commitToken: `${first.commitToken}-changed` }, key)
    expect(changed.status).toBe(409)
    expect(apiErrorSchema.parse(await changed.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    const previews: [Preview, Preview] = [await s.preview(stay, 'supplement', 3000), await s.preview(stay, 'supplement', 3000)]
    const keys: [string, string] = [randomUUID(), randomUUID()]
    const different = await race(previews, keys)
    expect(different.map(result => result.status).sort()).toEqual([200, 409])
    expect((await s.receipt('inpatient.payment.confirm', keys[different.findIndex(result => result.status === 409)]!)).status).toBe(404)
    const current = await s.funds(stay)
    expect(current).toMatchObject({ depositFen: 0, supplementFen: 5000, remainingFen: 0, pendingCount: 0 })
    expect(current.payments).toHaveLength(2)
    expect(new Set(current.sources.map(source => source.id)).size).toBe(2)
    expect(current.sources.reduce((sum, source) => sum + source.amountFen, 0)).toBe(5000)
    // Deposits retain the existing policy: they can exceed current charges.
    const deposit = await s.preview(stay, 'deposit', 7000)
    await parsed(inpatientPaymentResponseSchema, s.confirm(stay, deposit))
    expect(await s.funds(stay)).toMatchObject({ depositFen: 7000, supplementFen: 5000, remainingFen: -7000 })
    expect((await parsed(inpatientSettlementPreviewSchema, s.request(s.cashier, `${stay.path}/discharge/preview`))).chargesFen).toBe(5000)
  }, 45_000)

  it('同患者两次住院及门诊的原尝试、原款退款与支付方式跨重启保持原就诊', async () => {
    const s = await setup(), first = await s.admit(undefined, 1000), second = await s.admit(first.patientId)
    const original = (await s.funds(first)).sources[0]!
    const tenders = [{ method: 'bank-card', amountFen: 2000 }, { method: 'mobile', amountFen: 500 }]
    const reviewed = (await parsed(inpatientPaymentPreviewResponseSchema, s.request(s.cashier, `${second.path}/payments/preview`, {
      kind: 'deposit', amountFen: 2500, tenders, simulatorRule: 'ambiguous' }))).data
    expect((await s.confirm(first, reviewed)).status).toBe(409)
    const key = randomUUID(), payment = (await parsed(inpatientPaymentResponseSchema, s.confirm(second, reviewed, key))).data
    expect(payment.outcome).toBe('ambiguous')
    const visit = await s.outpatient(first.patientId), versions = { [`ChargeItem/${visit.chargeItemId}`]: '1' }
    const outpatientPreview = (await parsed(paymentPreviewResponseSchema, s.request(s.cashier, '/api/his/v1/payments/actions/preview', {
      caseId: visit.caseId, chargeItemId: visit.chargeItemId, category: 'laboratory', simulatorRule: 'ambiguous',
      tenders: [{ method: 'cash', amountFen: 6800 }] }, randomUUID(), versions))).data
    const outpatientPayment = (await parsed(paymentResponseSchema, s.request(s.cashier, `/api/his/v1/payments/${outpatientPreview.previewId}/actions/confirm`,
      { commitToken: outpatientPreview.commitToken }, randomUUID(), versions))).data
    await s.restart()
    expect(await s.funds(first)).toMatchObject({ depositFen: 1000, payments: [], sources: [{ id: original.id, amountFen: 1000 }] })
    expect(await s.funds(second)).toMatchObject({ depositFen: 0, payments: [{ paymentId: payment.paymentId, outcome: 'ambiguous', tenders }] })
    const recovery = { paymentId: payment.paymentId, expectedPaymentVersion: 1 }
    expect((await s.request(s.cashier, `${first.path}/payments/recover`, recovery)).status).toBe(409)
    expect((await s.request(s.cashier, `${second.path}/payments/recover`, { ...recovery, paymentId: outpatientPayment.paymentId })).status).toBe(409)
    expect((await s.request(s.cashier, `/api/his/v1/payments/${payment.paymentId}/actions/recover`, { expectedPaymentVersion: 1 }, randomUUID(),
      { [`ChargeItem/${visit.chargeItemId}`]: '2' })).status).toBe(409)
    await parsed(inpatientPaymentResponseSchema, s.request(s.cashier, `${second.path}/payments/recover`, recovery))
    await parsed(paymentResponseSchema, s.request(s.cashier, `/api/his/v1/payments/${outpatientPayment.paymentId}/actions/recover`,
      { expectedPaymentVersion: 1 }, randomUUID(), { [`ChargeItem/${visit.chargeItemId}`]: '2' }))
    expect((await s.request(s.cashier, `${first.path}/refunds/preview`, { sourceId: payment.paymentId, amountFen: 1, simulatorRule: 'success' })).status).toBe(409)
    await s.depart(second)
    expect((await s.request(s.cashier, `${second.path}/refunds/preview`, { sourceId: outpatientPayment.paymentId, amountFen: 1, simulatorRule: 'success' })).status).toBe(409)
    expect((await s.request(s.cashier, '/api/his/v1/refunds/actions/preview', { paymentId: payment.paymentId, amountFen: 1,
      expectedSourceVersion: 1, simulatorRule: 'success' }, randomUUID(), { [`ChargeItem/${visit.chargeItemId}`]: '3' })).status).toBe(409)
    const refundPreview = (await parsed(inpatientRefundPreviewResponseSchema, s.request(s.cashier, `${second.path}/refunds/preview`, {
      sourceId: payment.paymentId, amountFen: 1000, simulatorRule: 'ambiguous' }))).data
    const refundKey = randomUUID(), refund = await parsed(refundResponseSchema, s.request(s.cashier, `${second.path}/refunds/confirm`, {
      previewId: refundPreview.previewId, commitToken: refundPreview.commitToken }, refundKey))
    expect(refund.data).toMatchObject({ sourceId: payment.paymentId, ownerId: second.id, outcome: 'ambiguous', tenders: [{ method: 'bank-card', amountFen: 1000 }] })
    await s.restart()
    expect(await s.funds(second)).toMatchObject({ refundedFen: 0, pendingCount: 1, sources: [{ id: payment.paymentId, reservedFen: 1000, refundableFen: 1500 }] })
    expect((await s.request(s.cashier, `${first.path}/refunds/recover`, { refundId: refund.data.refundId, expectedRefundVersion: 1 })).status).toBe(409)
    expect((await s.request(s.cashier, `/api/his/v1/refunds/${refund.data.refundId}/actions/recover`, { expectedRefundVersion: 1 }, randomUUID(),
      { [`ChargeItem/${visit.chargeItemId}`]: '3' })).status).toBe(409)
    await parsed(refundResponseSchema, s.request(s.cashier, `${second.path}/refunds/recover`, { refundId: refund.data.refundId, expectedRefundVersion: 1 }))
    expect(await s.funds(first)).toMatchObject({ depositFen: 1000, refundedFen: 0, sources: [{ id: original.id, refundableFen: 1000 }] })
    expect(await s.funds(second)).toMatchObject({ depositFen: 2500, refundedFen: 1000, pendingCount: 0,
      payments: [{ paymentId: payment.paymentId, initialOutcome: 'ambiguous', outcome: 'success', tenders }],
      sources: [{ id: payment.paymentId, refundedFen: 1000, reservedFen: 0, refundableFen: 1500 }] })
    const bill = await parsed(billingCaseSchema, s.request(s.cashier, `/api/his/v1/billing/cases/${visit.caseId}`))
    expect(bill).toMatchObject({ paidFen: 6800, payments: [{ paymentId: outpatientPayment.paymentId, outcome: 'success' }] })
    expect(inpatientPaymentResponseSchema.parse((await parsed(commandReceiptLookupSchema, s.receipt('inpatient.payment.confirm', key))).response).data).toEqual(payment)
    expect(refundResponseSchema.parse((await parsed(commandReceiptLookupSchema, s.receipt('inpatient.refund.confirm', refundKey))).response)).toEqual(refund)
  })

  it.each(['confirm', 'recover'] as const)('共享收款 %s 已写资金事实后住院入账故障整体回滚，原意图恢复只入账一次', async action => {
    const s = await setup(), stay = await s.admit()
    const reviewed = await s.preview(stay, 'deposit', 2500, action === 'confirm' ? 'success' : 'ambiguous')
    const original = action === 'recover' ? (await parsed(inpatientPaymentResponseSchema, s.confirm(stay, reviewed))).data : undefined
    const before = await s.funds(stay), key = randomUUID()
    const path = `${stay.path}/payments/${action}`, input = original === undefined
      ? { previewId: reviewed.previewId, commitToken: reviewed.commitToken }
      : { paymentId: original.paymentId, expectedPaymentVersion: 1 }
    // Inject precisely at the inpatient owner write after a common collection fact/resolution exists.
    s.runtime.database.driver.exec(`CREATE TEMP TRIGGER fail_inpatient_collection_write BEFORE INSERT ON inpatient_deposit
      WHEN NEW.admission_id='${stay.id}' AND EXISTS (
        SELECT 1 FROM collection_transaction WHERE owner_id=NEW.admission_id
          ${action === 'recover' ? 'AND payment_id IN (SELECT payment_id FROM collection_resolution)' : ''}
      ) BEGIN SELECT RAISE(ABORT,'injected inpatient collection business failure'); END`)
    const failed = await s.request(s.cashier, path, input, key)
    expect(failed.status).toBe(500)
    expect((await s.receipt(`inpatient.payment.${action}`, key)).status).toBe(404)
    expect(await s.funds(stay)).toEqual(before)
    s.runtime.database.driver.exec('DROP TRIGGER fail_inpatient_collection_write')
    const accepted = await parsed(inpatientPaymentResponseSchema, s.request(s.cashier, path, input, key))
    expect(accepted.data).toMatchObject({ outcome: 'success', amountFen: 2500 })
    expect(await parsed(inpatientPaymentResponseSchema, s.request(s.cashier, path, input, key))).toEqual(accepted)
    const current = await s.funds(stay)
    expect(current).toMatchObject({ depositFen: 2500, pendingCount: 0, sources: [{ id: accepted.data.paymentId, amountFen: 2500 }] })
    expect(current.payments).toHaveLength(1)
    expect(current.sources).toHaveLength(1)
    expect((await parsed(commandReceiptLookupSchema, s.receipt(`inpatient.payment.${action}`, key))).status).toBe('completed')
    await s.restart()
    expect(await s.funds(stay)).toEqual(current)
  })
})
