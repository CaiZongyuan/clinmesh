import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  apiErrorSchema, billingCaseSchema, billingQueueSchema, createPatientResponseSchema, doctorQueueSchema,
  firstVisitDraftResponseSchema, laboratoryOrderResponseSchema, paymentPreviewResponseSchema,
  paymentResponseSchema, registrationResponseSchema, triageResponseSchema,
} from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import {
  chargeAdjustmentResponseSchema, refundCaseSchema, refundPreviewResponseSchema, refundResponseSchema,
} from '@clinmesh/contracts/refunds'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { signIn, StubSyntheaProvider } from './fixtures/consultation.ts'
import { completeSyntheticOutpatient, FinancialAcceptanceProvider } from './fixtures/complete-synthetic-outpatient.ts'

type Visit = { caseId: string; chargeItemId: string; patientId: string }
type Preview = z.infer<typeof paymentPreviewResponseSchema>['data']
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function parsed<T>(schema: z.ZodType<T>, result: Response | Promise<Response>): Promise<T> {
  const response = await result
  expect(response.status, await response.clone().text()).toBe(200)
  return schema.parse(await response.json())
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-shared-collection-'))
  cleanups.push(() => rm(directory, { recursive: true }))
  const password = `Test-${randomUUID()}-Aa1!`
  const options = {
    authBaseUrl: 'http://localhost', trustedOrigins: ['http://localhost'],
    authSecret: 'test-auth-secret-with-at-least-32-characters', cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
    databasePath: join(directory, 'hospital.sqlite'), demoPassword: password, migrationMode: 'apply' as const,
    chatCompletionsProvider: new FinancialAcceptanceProvider(), patientPersonaModel: 'synthetic-financial-persona',
    consultationModel: 'synthetic-financial-quality', syntheaProvider: new StubSyntheaProvider(),
  }
  let runtime = await createClinMeshRuntime(options)
  cleanups.push(() => runtime.close())
  const registrar = await signIn(runtime, 'registrar@demo.clinmesh.local', password)
  const triage = await signIn(runtime, 'triage@demo.clinmesh.local', password)
  const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local', password)
  const cashier = await signIn(runtime, 'cashier@demo.clinmesh.local', password)
  function command(cookie: string, path: string, input: unknown, expectedVersions: Record<string, string> = {}, key = randomUUID(), method = 'POST') {
    return runtime.app.request(path, { method,
      headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ input, expectedVersions }),
    })
  }
  async function createVisit(patientId?: string): Promise<Visit> {
    const patient = patientId === undefined
      ? (await parsed(createPatientResponseSchema, await command(registrar, '/api/his/v1/patients', {
        birthDate: '1990-05-10', gender: 'male', identifier: `SYN-COLLECT-${randomUUID()}`, name: '合成共享收款患者',
      }))).data.patient
      : { id: patientId, versionId: '1' }
    const registration = (await parsed(registrationResponseSchema, await command(registrar, '/api/his/v1/registrations/actions/register', {
      departmentId: 'department-general-medicine', locationId: 'location-outpatient', patientId: patient.id,
      visitDate: '2026-08-24', visitTypeId: 'visit-general',
    }, { [`Patient/${patient.id}`]: patient.versionId }))).data
    const encounter = `/api/his/v1/encounters/${registration.encounterId}`
    const handoff = (await parsed(triageResponseSchema, await command(triage, `${encounter}/actions/record-triage`, {
      acuityCode: 'level-3', bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 }, chiefComplaint: '合成发热两天',
      oxygenSaturationPct: 98, pulseBpm: 102, respirationBpm: 20, temperatureC: 38.6,
    }, { [`Encounter/${registration.encounterId}`]: '1', [`Task/${registration.queueTaskId}`]: '1' }))).data
    const queue = await parsed(doctorQueueSchema, await runtime.app.request('/api/his/v1/doctor/queue?pageSize=20', { headers: { cookie: doctor } }))
    const item = queue.items.find(row => row.encounterId === registration.encounterId)!
    expect(item).toBeDefined()
    expect((await command(doctor, `${encounter}/actions/start-first-visit`, {}, {
      [`Encounter/${registration.encounterId}`]: handoff.encounterVersion, [`Task/${handoff.doctorTaskId}`]: '1',
    })).status).toBe(200)
    const draft = (await parsed(firstVisitDraftResponseSchema, await command(doctor, `${encounter}/drafts/first-visit`, {
      assessment: '合成急性发热，待检验明确病原', expectedDraftVersion: 0, historyOfPresentIllness: '两天前出现发热，伴咽痛。',
    }, { [`Encounter/${registration.encounterId}`]: '3' }, randomUUID(), 'PUT'))).data
    const order = (await parsed(laboratoryOrderResponseSchema, await command(doctor, `${encounter}/actions/issue-laboratory-order`, {
      catalogItemId: 'lab-fever-panel', expectedDraftVersion: draft.draftVersion, indicationCode: 'fever',
    }, { [`Encounter/${registration.encounterId}`]: '3', [`Task/${handoff.doctorTaskId}`]: '2' }))).data
    return { caseId: item.caseId, chargeItemId: order.chargeItemId, patientId: patient.id }
  }
  const versions = (visit: Visit, version = 1) => ({ [`ChargeItem/${visit.chargeItemId}`]: String(version) })
  const readBill = (visit: Visit) => parsed(billingCaseSchema, runtime.app.request(`/api/his/v1/billing/cases/${visit.caseId}`, { headers: { cookie: cashier } }))
  const readRefunds = (visit: Visit) => parsed(refundCaseSchema, runtime.app.request(`/api/his/v1/billing/cases/${visit.caseId}/refunds`, { headers: { cookie: cashier } }))
  async function preview(visit: Visit, amountFen: number, version = 1, simulatorRule = 'success', tenders = [{ method: 'mobile', amountFen }]) {
    return (await parsed(paymentPreviewResponseSchema, await command(cashier, '/api/his/v1/payments/actions/preview', {
      caseId: visit.caseId, chargeItemId: visit.chargeItemId, category: 'laboratory', simulatorRule, tenders,
    }, versions(visit, version)))).data
  }
  const confirmPath = (value: Preview) => `/api/his/v1/payments/${value.previewId}/actions/confirm`
  const confirm = (value: Preview, key = randomUUID()) => command(cashier, confirmPath(value), { commitToken: value.commitToken },
    { [`ChargeItem/${value.chargeItemId}`]: String(value.chargeVersion) }, key)
  const receipt = (operationId: string, key: string) => runtime.app.request(
    `/api/his/v1/command-receipts?operationId=${operationId}&idempotencyKey=${key}`, { headers: { cookie: cashier } },
  )
  return {
    get runtime() { return runtime }, options, password, cashier, doctor, command, createVisit, versions, readBill, readRefunds,
    preview, confirm, confirmPath, receipt,
    async restart() { await runtime.close(); runtime = await createClinMeshRuntime(options) },
  }
}

const workerReply = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('result'), status: z.number().int(), body: z.unknown() }),
  z.object({ kind: z.literal('error'), message: z.string() }),
])

async function openWorker(databasePath: string, password: string) {
  const child = fork(fileURLToPath(new URL('./fixtures/shared-payment-collection-worker.ts', import.meta.url)), [databasePath, password], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    // Each independent process proves its own cold initialization, without a shared transform cache.
    env: { ...process.env, TSX_DISABLE_CACHE: '1' },
  })
  let stderr = ''
  child.stderr!.on('data', chunk => { stderr += String(chunk) })
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>(resolve => {
      const fallback = setTimeout(() => child.kill(), 5000)
      child.once('exit', () => { clearTimeout(fallback); resolve() })
      if (child.connected) child.send({ kind: 'close' })
      else child.kill()
    })
  })
  async function message(timeoutMs = 15_000) {
    return new Promise<z.infer<typeof workerReply>>((resolve, reject) => {
      const timeout = setTimeout(() => { detach(); reject(new Error(`收款工作进程未响应：${stderr}`)) }, timeoutMs)
      const received = (raw: unknown) => {
        detach()
        try { resolve(workerReply.parse(raw)) } catch (error) { reject(error) }
      }
      const failed = (code: number | null) => { detach(); reject(new Error(`收款工作进程退出 ${code}：${stderr}`)) }
      function detach() { clearTimeout(timeout); child.off('message', received); child.off('exit', failed) }
      child.once('message', received)
      child.once('exit', failed)
    })
  }
  expect((await message(30_000)).kind).toBe('ready')
  return {
    child,
    async run(input: { path: string; cookie: string; key: string; body: unknown; startAt: number }) {
      const result = message()
      child.send({ kind: 'run', ...input })
      const response = await result
      if (response.kind !== 'result') throw new Error(JSON.stringify(response))
      return response
    },
  }
}

async function concurrentConfirm(s: Awaited<ReturnType<typeof setup>>, workers: Array<Awaited<ReturnType<typeof openWorker>>>, previews: [Preview, Preview], keys: [string, string]) {
  const startAt = Date.now() + 100
  return Promise.all(workers.map((worker, index) => {
    const value = previews[index]!
    return worker.run({ path: s.confirmPath(value), cookie: s.cashier, key: keys[index]!, startAt,
      body: { input: { commitToken: value.commitToken }, expectedVersions: { [`ChargeItem/${value.chargeItemId}`]: String(value.chargeVersion) } },
    })
  }))
}

describe('共享收款内核的门诊公共合同', () => {
  it('独立进程同键并发仅创建一个回执，异载荷拒绝，不同键竞争不能超收', async () => {
    const s = await setup(), visit = await s.createVisit()
    const reviewed = await s.preview(visit, 2000), key = randomUUID()
    const workers = await Promise.all([openWorker(s.options.databasePath, s.password), openWorker(s.options.databasePath, s.password)])
    expect(workers[0]!.child.pid).not.toBe(workers[1]!.child.pid)
    const same = await concurrentConfirm(s, workers, [reviewed, reviewed], [key, key])
    expect(same.map(result => result.status)).toEqual([200, 200])
    const accepted = paymentResponseSchema.parse(same[0]!.body)
    expect(paymentResponseSchema.parse(same[1]!.body)).toEqual(accepted)
    const lookedUp = await parsed(commandReceiptLookupSchema, await s.receipt('payment.confirm', key))
    expect(lookedUp.status).toBe('completed')
    expect(paymentResponseSchema.parse(lookedUp.response)).toEqual(accepted)
    const changed = await s.command(s.cashier, s.confirmPath(reviewed), { commitToken: `${reviewed.commitToken}-changed` }, s.versions(visit), key)
    expect(changed.status).toBe(409)
    expect(apiErrorSchema.parse(await changed.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    const competing: [Preview, Preview] = [await s.preview(visit, 4800, 2), await s.preview(visit, 4800, 2)]
    const keys: [string, string] = [randomUUID(), randomUUID()]
    const different = await concurrentConfirm(s, workers, competing, keys)
    expect(different.map(result => result.status).sort()).toEqual([200, 409])
    const losing = different.findIndex(result => result.status === 409)
    expect((await s.receipt('payment.confirm', keys[losing]!)).status).toBe(404)
    const bill = await s.readBill(visit)
    expect(bill.paidFen).toBe(6800)
    expect(bill.payments).toHaveLength(2)
    expect(new Set(bill.payments.map(payment => payment.paymentId)).size).toBe(2)
    expect(bill.charges.find(charge => charge.chargeItemId === visit.chargeItemId)).toMatchObject({ paidFen: 6800, remainingFen: 0 })
  }, 45_000)

  it('同一患者两次门诊的未知原款、支付方式与退款引用跨重启保持原就诊', async () => {
    const s = await setup()
    // Another public registration keeps the Scenario active after the first patient's completed visit.
    await s.createVisit()
    expect(await completeSyntheticOutpatient(s.runtime, s.password)).toMatchObject({ status: 'completed', scenarioStatus: 'active' })
    const completed = (await parsed(billingQueueSchema, s.runtime.app.request('/api/his/v1/billing/queue?category=medication&status=paid&pageSize=20',
      { headers: { cookie: s.cashier } }))).items[0]!
    expect(completed).toBeDefined()
    const first: Visit = { caseId: completed.caseId, chargeItemId: completed.chargeItemId, patientId: completed.patient.id }
    const original = (await s.readBill(first)).payments[0]!
    const second = await s.createVisit(first.patientId)
    const tenders = [{ method: 'bank-card', amountFen: 2000 }, { method: 'mobile', amountFen: 4800 }]
    const reviewed = await s.preview(second, 6800, 1, 'ambiguous', tenders), key = randomUUID()
    const payment = (await parsed(paymentResponseSchema, await s.confirm(reviewed, key))).data
    expect(payment.outcome).toBe('ambiguous')
    await s.restart()
    expect((await s.readBill(first)).payments).toMatchObject([{ paymentId: original.paymentId, outcome: 'success' }])
    expect((await s.readBill(second)).payments).toMatchObject([{ paymentId: payment.paymentId, outcome: 'ambiguous', tenders }])
    const wrongCharge = await s.command(s.cashier, '/api/his/v1/payments/actions/preview', {
      caseId: second.caseId, chargeItemId: first.chargeItemId, category: 'medication', simulatorRule: 'success',
    }, s.versions(first, completed.chargeVersion))
    expect(wrongCharge.status).toBe(409)
    const recoveryPath = `/api/his/v1/payments/${payment.paymentId}/actions/recover`
    expect((await s.command(s.cashier, recoveryPath, { expectedPaymentVersion: 1 }, s.versions(first, completed.chargeVersion))).status).toBe(409)
    const recovered = await parsed(paymentResponseSchema, await s.command(s.cashier, recoveryPath, { expectedPaymentVersion: 1 }, s.versions(second, 2)))
    expect(recovered.data).toMatchObject({ paymentId: payment.paymentId, outcome: 'success' })
    expect((await s.readBill(first)).payments).toHaveLength(1)
    expect((await s.readBill(second)).paidFen).toBe(6800)
    await parsed(chargeAdjustmentResponseSchema, await s.command(s.cashier, `/api/his/v1/billing/cases/${first.caseId}/adjustments`, {
      chargeItemId: first.chargeItemId, amountFen: 1000, reason: '合成原费用核准冲减并按原款退款',
    }, s.versions(first, completed.chargeVersion)))
    const refundInput = { paymentId: original.paymentId, amountFen: 1000, expectedSourceVersion: 1, simulatorRule: 'ambiguous' }
    const refundVersions = s.versions(first, completed.chargeVersion + 1)
    expect((await s.command(s.cashier, '/api/his/v1/refunds/actions/preview', refundInput, s.versions(second, 3))).status).toBe(409)
    const frozen = (await parsed(refundPreviewResponseSchema, await s.command(s.cashier, '/api/his/v1/refunds/actions/preview', refundInput, refundVersions))).data
    const refundKey = randomUUID()
    const refund = await parsed(refundResponseSchema, await s.command(s.cashier, `/api/his/v1/refunds/${frozen.previewId}/actions/confirm`,
      { commitToken: frozen.commitToken }, refundVersions, refundKey))
    expect(refund.data).toMatchObject({ sourceId: original.paymentId, ownerId: first.caseId, outcome: 'ambiguous',
      tenders: [{ method: 'cash', amountFen: 1000 }] })
    await s.restart()
    const statement = await s.readRefunds(first)
    expect(statement).toMatchObject({ reservedFen: 1000, refundedFen: 0, refunds: [refund.data] })
    expect(await s.readRefunds(second)).toMatchObject({ sources: [{ sourceId: payment.paymentId }], refunds: [], reservedFen: 0 })
    expect(paymentResponseSchema.parse((await parsed(commandReceiptLookupSchema, await s.receipt('payment.confirm', key))).response).data).toEqual(payment)
    expect(refundResponseSchema.parse((await parsed(commandReceiptLookupSchema, await s.receipt('refund.confirm', refundKey))).response)).toEqual(refund)
    expect((await s.command(s.cashier, `/api/his/v1/refunds/${refund.data.refundId}/actions/recover`, { expectedRefundVersion: 1 }, s.versions(second, 3))).status).toBe(409)
    await parsed(refundResponseSchema, await s.command(s.cashier, `/api/his/v1/refunds/${refund.data.refundId}/actions/recover`, { expectedRefundVersion: 1 }, refundVersions))
    expect(await s.readRefunds(first)).toMatchObject({ refundedFen: 1000, reservedFen: 0, refunds: [{ sourceId: original.paymentId, outcome: 'success' }] })
    expect((await s.readBill(first)).paidFen).toBe(original.amountFen - 1000)
    expect((await s.readBill(second)).paidFen).toBe(6800)
  })

  it.each(['confirm', 'recover'] as const)('收款 %s 的资金已写入后业务故障整体回滚，原意图恢复只记一次', async action => {
    const s = await setup(), visit = await s.createVisit()
    const reviewed = await s.preview(visit, 6800, 1, action === 'recover' ? 'ambiguous' : 'success')
    const original = action === 'recover' ? (await parsed(paymentResponseSchema, await s.confirm(reviewed))).data : undefined
    const before = await s.readBill(visit), key = randomUUID(), version = action === 'recover' ? 2 : 1
    const path = original === undefined ? s.confirmPath(reviewed) : `/api/his/v1/payments/${original.paymentId}/actions/recover`
    const input = original === undefined ? { commitToken: reviewed.commitToken } : { expectedPaymentVersion: 1 }
    // Arrange a failure only after the new collection fact/resolution exists, at the business-owner write.
    s.runtime.database.driver.prepare('SELECT payment_id FROM collection_transaction LIMIT 1').all()
    s.runtime.database.driver.exec(`CREATE TEMP TRIGGER fail_collection_business_write BEFORE UPDATE ON charge_record
      WHEN OLD.charge_item_id='${visit.chargeItemId}' AND EXISTS (
        SELECT 1 FROM collection_transaction WHERE ${action === 'confirm' ? '1=1' : 'payment_id IN (SELECT payment_id FROM collection_resolution)'}
      ) BEGIN SELECT RAISE(ABORT,'injected shared collection business failure'); END`)
    const failed = await s.command(s.cashier, path, input, s.versions(visit, version), key)
    expect(failed.status).toBe(500)
    expect((await s.receipt(`payment.${action}`, key)).status).toBe(404)
    const rolledBack = await s.readBill(visit)
    expect(rolledBack.payments).toEqual(before.payments)
    expect(rolledBack.charges).toEqual(before.charges)
    expect(rolledBack.paidFen).toBe(0)
    s.runtime.database.driver.exec('DROP TRIGGER fail_collection_business_write')
    const retried = await parsed(paymentResponseSchema, await s.command(s.cashier, path, input, s.versions(visit, version), key))
    expect(retried.data.outcome).toBe('success')
    expect(await parsed(paymentResponseSchema, await s.command(s.cashier, path, input, s.versions(visit, version), key))).toEqual(retried)
    const after = await s.readBill(visit)
    expect(after.paidFen).toBe(6800)
    expect(after.payments).toHaveLength(1)
    expect(after.payments[0]!.paymentId).toBe(retried.data.paymentId)
    expect((await parsed(commandReceiptLookupSchema, await s.receipt(`payment.${action}`, key))).status).toBe('completed')
  })
})
