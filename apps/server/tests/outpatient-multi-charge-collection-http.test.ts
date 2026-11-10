import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  apiErrorSchema, billingCaseSchema, doctorCaseDetailSchema, issueLaboratoryRequestResponseSchema,
  laboratoryRequestDraftResponseSchema, multiChargePaymentPreviewResponseSchema, paymentPreviewResponseSchema,
  paymentResponseSchema, startVisitResponseSchema, multiChargePaymentResponseSchema,
} from '@clinmesh/contracts/his'
import { chargeAdjustmentResponseSchema, refundCaseSchema, refundPreviewResponseSchema, refundResponseSchema } from '@clinmesh/contracts/refunds'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { sourceArtifactHash } from '../src/application/scenario-data/provider.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider, useSyntheticLaboratoryCatalog } from './fixtures/consultation.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

class DistinctPatientProvider extends StubSyntheaProvider {
  private sequence = 0
  override async generate() {
    const corpus = await super.generate(), sequence = ++this.sequence
    return { ...corpus, sources: corpus.sources.map(source => {
      const raw = z.object({ entry: z.array(z.object({ resource: z.object({ resourceType: z.string() }).loose() }).loose()) }).loose().parse(source.raw)
      const patient = raw.entry.find(entry => entry.resource.resourceType === 'Patient')!.resource
      patient.name = [{ text: `合成多费用患者${sequence}` }]
      return { ...source, raw, hash: sourceArtifactHash(raw) }
    }) }
  }
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-multi-charge-http-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const options = {
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-multi-charge-secret-at-least-32-characters',
    cursorSecret: 'synthetic-multi-charge-cursor-at-least-32-characters', databasePath: join(directory, 'test.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply' as const, trustedOrigins: ['http://localhost'],
    patientPersonaModel: 'synthetic', syntheaProvider: new DistinctPatientProvider(),
    chatCompletionsProvider: { async completeJson() { return { content: JSON.stringify(persona), model: 'synthetic' } } },
  }
  let runtime = await createClinMeshRuntime(options)
  cleanups.push(() => runtime.close())
  // Only the external synthetic catalog is arranged directly; all clinical and money facts use HTTP.
  useSyntheticLaboratoryCatalog(runtime)
  runtime.database.driver.prepare("UPDATE outpatient_catalog SET price_fen=800 WHERE item_id IN ('lab-cbc','lab-crp')").run()
  const started = await startConsultationCase(runtime)
  let doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
  let cashier = await signIn(runtime, 'cashier@demo.clinmesh.local')
  const write = (path: string, input: object, expectedVersions: Record<string, string> = {}, cookie = cashier, key = randomUUID(), method = 'POST') => runtime.app.request(path, {
    method, body: JSON.stringify({ expectedVersions, input }),
    headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost', 'idempotency-key': key },
  })
  const readDetailFor = async (caseId: string) => doctorCaseDetailSchema.parse(await (await runtime.app.request(
    `/api/his/v1/doctor/cases/${caseId}`, { headers: { cookie: doctor } },
  )).json())
  const readBillFor = async (caseId: string) => billingCaseSchema.parse(await (await runtime.app.request(
    `/api/his/v1/billing/cases/${caseId}`, { headers: { cookie: cashier } },
  )).json())
  async function prepareVisit(visit: Awaited<ReturnType<typeof startConsultationCase>>) {
    const startedVisit = await write(`/api/his/v1/encounters/${visit.encounterId}/actions/start-first-visit`, {}, {
      [`Encounter/${visit.encounterId}`]: visit.encounterVersion, [`Task/${visit.doctorTaskId}`]: '1',
    }, doctor)
    expect(startedVisit.status, await startedVisit.clone().text()).toBe(200)
    startVisitResponseSchema.parse(await startedVisit.json())
    for (const catalogItemId of ['lab-cbc', 'lab-crp']) {
      const detail = await readDetailFor(visit.outpatientCaseId)
      const expectedVersions = { [`Encounter/${visit.encounterId}`]: detail.encounter.versionId }
      const draftResponse = await write(`/api/his/v1/encounters/${visit.encounterId}/laboratory-request/draft`, {
        catalogItemId, expectedDraftVersion: detail.laboratoryRequests?.draftVersion ?? 0, indicationCode: 'fever',
      }, expectedVersions, doctor, randomUUID(), 'PUT')
      expect(draftResponse.status, await draftResponse.clone().text()).toBe(200)
      const draft = laboratoryRequestDraftResponseSchema.parse(await draftResponse.json()).data
      const issued = await write(`/api/his/v1/encounters/${visit.encounterId}/laboratory-request/actions/issue`, {
        expectedDraftVersion: draft.draftVersion,
      }, expectedVersions, doctor)
      expect(issued.status, await issued.clone().text()).toBe(200)
      issueLaboratoryRequestResponseSchema.parse(await issued.json())
    }
  }
  await prepareVisit(started)
  const readBill = () => readBillFor(started.outpatientCaseId), readDetail = () => readDetailFor(started.outpatientCaseId)
  return {
    write, readBill, readDetail,
    get runtime() { return runtime },
    readPage: async (page: number) => billingCaseSchema.parse(await (await runtime.app.request(
      `/api/his/v1/billing/cases/${started.outpatientCaseId}?page=${page}&pageSize=1`, { headers: { cookie: cashier } },
    )).json()),
    readRefunds: async () => refundCaseSchema.parse(await (await runtime.app.request(
      `/api/his/v1/billing/cases/${started.outpatientCaseId}/refunds`, { headers: { cookie: cashier } },
    )).json()),
    caseId: started.outpatientCaseId, get doctor() { return doctor },
    async anotherCase() {
      const visit = await startConsultationCase(runtime)
      await prepareVisit(visit)
      return { caseId: visit.outpatientCaseId, readBill: () => readBillFor(visit.outpatientCaseId), readDetail: () => readDetailFor(visit.outpatientCaseId) }
    },
    receipt: (key: string, operationId = 'payment.multi-charge.confirm') => runtime.app.request(
      `/api/his/v1/command-receipts?operationId=${operationId}&idempotencyKey=${key}`, { headers: { cookie: cashier } },
    ),
    async restart() {
      await runtime.close()
      runtime = await createClinMeshRuntime(options)
      doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
      cashier = await signIn(runtime, 'cashier@demo.clinmesh.local')
    },
  }
}

type Subject = Awaited<ReturnType<typeof setup>>
type Bill = z.infer<typeof billingCaseSchema>
const versions = (charges: Bill['charges']) => Object.fromEntries(charges.map(charge => [`ChargeItem/${charge.chargeItemId}`, String(charge.chargeVersion)]))
const laboratories = (bill: Bill) => bill.charges.filter(charge => charge.category === 'laboratory')
const multiResult = multiChargePaymentResponseSchema
async function parsed<T>(schema: z.ZodType<T>, response: Response | Promise<Response>) {
  const result = await response
  expect(result.status, await result.clone().text()).toBe(200)
  return schema.parse(await result.json())
}
async function preview(s: Subject, rule = 'success', tenders?: Array<{ method: string; amountFen: number }>) {
  const charges = laboratories(await s.readBill())
  return (await parsed(multiChargePaymentPreviewResponseSchema, s.write('/api/his/v1/payments/actions/preview-multi-charge', {
    caseId: s.caseId, chargeItemIds: charges.map(charge => charge.chargeItemId), simulatorRule: rule, ...(tenders ? { tenders } : {}),
  }, versions(charges)))).data
}
type Frozen = Awaited<ReturnType<typeof preview>>
const frozenVersions = (frozen: Frozen) => Object.fromEntries(frozen.charges.map(charge => [`ChargeItem/${charge.chargeItemId}`, String(charge.chargeVersion)]))
const confirmPath = (frozen: Frozen) => `/api/his/v1/payments/${frozen.previewId}/actions/confirm-multi-charge`
const confirm = (s: Subject, frozen: Frozen, key = randomUUID()) => s.write(confirmPath(frozen), { commitToken: frozen.commitToken }, frozenVersions(frozen), undefined, key)
const counts = (s: Subject) => z.object({ payments: z.number(), allocations: z.number(), paymentResolutions: z.number(), refunds: z.number(), refundResolutions: z.number() }).parse(s.runtime.database.driver.prepare(`
  SELECT (SELECT COUNT(*) FROM collection_transaction) AS payments,
    (SELECT COUNT(*) FROM outpatient_payment_allocation) AS allocations,
    (SELECT COUNT(*) FROM collection_resolution) AS paymentResolutions,
    (SELECT COUNT(*) FROM refund_transaction) AS refunds,
    (SELECT COUNT(*) FROM refund_resolution) AS refundResolutions`).get())
async function paySingle(s: Subject, charge: Bill['charges'][number], amountFen: number) {
  const frozen = (await parsed(paymentPreviewResponseSchema, s.write('/api/his/v1/payments/actions/preview', {
    caseId: s.caseId, chargeItemId: charge.chargeItemId, category: charge.category, simulatorRule: 'success', tenders: [{ method: 'mobile', amountFen }],
  }, versions([charge])))).data
  return (await parsed(paymentResponseSchema, s.write(`/api/his/v1/payments/${frozen.previewId}/actions/confirm`, {
    commitToken: frozen.commitToken,
  }, versions([charge])))).data
}
async function refundPreview(s: Subject, paymentId: string, chargeItemId: string, amountFen: number, rule = 'success', legacy = false) {
  const bill = await s.readBill(), statement = await s.readRefunds()
  const charge = bill.charges.find(item => item.chargeItemId === chargeItemId)!
  const source = statement.sources.find(item => item.sourceId === paymentId)!
  const result = await s.write(`/api/his/v1/refunds/actions/${legacy ? 'preview' : 'preview-allocation'}`, {
    paymentId, ...(!legacy ? { chargeItemId } : {}), amountFen, expectedSourceVersion: source.version, simulatorRule: rule,
  }, versions([charge]))
  return { response: result, expected: versions([charge]) }
}
async function confirmRefund(s: Subject, reviewed: Awaited<ReturnType<typeof refundPreview>>, key = randomUUID()) {
  const frozen = (await parsed(refundPreviewResponseSchema, reviewed.response)).data
  return parsed(refundResponseSchema, s.write(`/api/his/v1/refunds/${frozen.previewId}/actions/confirm`, {
    commitToken: frozen.commitToken,
  }, reviewed.expected, undefined, key))
}

describe('门诊合并收款与原分配退款的独立公共 HTTP 合同', () => {
  it.each(['success', 'decline', 'ambiguous'] as const)('整笔 %s 只有一款两分配，跨重启同回执与原键重放不重复生效', async rule => {
    const s = await setup(), before = await s.readBill(), beforeCounts = counts(s)
    const frozen = await preview(s, rule, [{ method: 'cash', amountFen: 600 }, { method: 'bank-card', amountFen: 1000 }])
    const key = randomUUID(), attempts = await Promise.all([confirm(s, frozen, key), confirm(s, frozen, key)])
    const result = await parsed(multiResult, attempts[0]!), payment = result.data
    expect(await parsed(multiResult, attempts[1]!)).toEqual(result)
    expect(payment).toMatchObject({ kind: 'multi-charge', caseId: s.caseId, patientId: before.patient.id, encounterId: before.encounterId,
      amountFen: 1600, outcome: rule === 'decline' ? 'declined' : rule })
    expect(payment.allocations).toHaveLength(2)
    expect(payment.allocations.reduce((sum, item) => sum + item.amountFen, 0)).toBe(payment.amountFen)
    expect(payment.tenders.reduce((sum, item) => sum + item.amountFen, 0)).toBe(payment.amountFen)
    expect(counts(s)).toEqual({ ...beforeCounts, payments: beforeCounts.payments + 1, allocations: beforeCounts.allocations + 2 })
    const after = await s.readBill()
    expect(after.payments).toHaveLength(1)
    expect(after.payments[0]).not.toHaveProperty('chargeItemId')
    expect(after.payments[0]).toMatchObject({ kind: 'multi-charge', paymentId: payment.paymentId, amountFen: 1600, allocations: expect.arrayContaining(
      frozen.charges.map(charge => ({ chargeItemId: charge.chargeItemId, amountFen: 800 })),
    ) })
    expect(after.charges.find(charge => charge.category === 'registration')).toEqual(before.charges.find(charge => charge.category === 'registration'))
    expect(laboratories(after).map(charge => charge.paidFen)).toEqual(rule === 'success' ? [800, 800] : [0, 0])
    await s.restart()
    const receipt = await parsed(commandReceiptLookupSchema, s.receipt(key))
    expect(receipt.status).toBe('completed')
    expect(multiResult.parse(receipt.response)).toEqual(result)
    expect(await parsed(multiResult, confirm(s, frozen, key))).toEqual(result)
    const different = await s.write(confirmPath(frozen), { commitToken: `${frozen.commitToken}-other` }, frozenVersions(frozen), undefined, key)
    expect(different.status).toBe(409)
    expect(apiErrorSchema.parse(await different.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    expect(await s.readBill()).toEqual(after)
    expect(counts(s)).toEqual({ ...beforeCounts, payments: beforeCounts.payments + 1, allocations: beforeCounts.allocations + 2 })
  })

  it.each(['ambiguous', 'ambiguous-decline', 'ambiguous-pending'] as const)('未知原款 %s 阻断全部分配，跨重启只查询原交易并保持临床唯一放行', async rule => {
    const s = await setup(), frozen = await preview(s, rule), original = (await parsed(multiResult, confirm(s, frozen))).data
    const beforeCounts = counts(s)
    expect(original.outcome).toBe('ambiguous')
    const unknownBill = await s.readBill(), charges = laboratories(unknownBill)
    for (const charge of charges) {
      const blocked = await s.write('/api/his/v1/payments/actions/preview', {
        caseId: s.caseId, category: charge.category, chargeItemId: charge.chargeItemId, simulatorRule: 'success',
      }, versions([charge]))
      expect(blocked.status).toBe(409)
      const adjustment = await s.write(`/api/his/v1/billing/cases/${s.caseId}/adjustments`, {
        chargeItemId: charge.chargeItemId, amountFen: 1, reason: '合成未决资金阻断验证',
      }, versions([charge]))
      expect(adjustment.status).toBe(409)
    }
    await s.restart()
    const path = `/api/his/v1/payments/${original.paymentId}/actions/recover-multi-charge`, key = randomUUID()
    const wrong = await s.write(path, { expectedPaymentVersion: 1 }, versions([charges[0]!]))
    expect(wrong.status).toBe(409)
    const recovered = await parsed(multiResult, s.write(path, { expectedPaymentVersion: 1 }, versions(charges), undefined, key))
    expect(recovered.data).toMatchObject({ paymentId: original.paymentId, amountFen: 1600,
      outcome: rule === 'ambiguous' ? 'success' : rule === 'ambiguous-decline' ? 'declined' : 'ambiguous' })
    expect(await parsed(multiResult, s.write(path, { expectedPaymentVersion: 1 }, versions(charges), undefined, key))).toEqual(recovered)
    const expectedCounts = { ...beforeCounts, paymentResolutions: beforeCounts.paymentResolutions + (rule === 'ambiguous-pending' ? 0 : 1) }
    expect(counts(s)).toEqual(expectedCounts)
    const after = await s.readBill()
    expect(after.payments).toHaveLength(1)
    expect(laboratories(after).map(charge => charge.paidFen)).toEqual(rule === 'ambiguous' ? [800, 800] : [0, 0])
    if (rule === 'ambiguous') {
      await s.runtime.dispatchPending()
      const released = await s.readDetail()
      expect(released.laboratoryRequests?.requests.every(request => request.billing?.releasedAt !== undefined)).toBe(true)
      await s.restart()
      const current = laboratories(await s.readBill())
      await parsed(multiResult, s.write(path, { expectedPaymentVersion: 2 }, versions(current)))
      await s.runtime.dispatchPending()
      expect(await s.readDetail()).toEqual(released)
      expect(counts(s)).toEqual(expectedCounts)
    } else {
      expect((await s.readDetail()).laboratoryRequests?.requests.every(request => request.billing?.releasedAt === undefined)).toBe(true)
    }
  })

  it('任一冻结费用版本变化、缺项、多余项、错误token与跨岗确认整笔拒绝，竞争预览不能超收', async () => {
    const s = await setup(), frozen = await preview(s), competing = await preview(s)
    const before = await s.readBill(), beforeCounts = counts(s), valid = frozenVersions(frozen), first = frozen.charges[0]!
    const invalid = [
      { input: { commitToken: `${frozen.commitToken}-invalid` }, expected: valid },
      { input: { commitToken: frozen.commitToken }, expected: {} },
      { input: { commitToken: frozen.commitToken }, expected: { [`ChargeItem/${first.chargeItemId}`]: String(first.chargeVersion) } },
      { input: { commitToken: frozen.commitToken }, expected: { ...valid, 'ChargeItem/not-selected': '1' } },
      { input: { commitToken: frozen.commitToken }, expected: { ...valid, [`ChargeItem/${first.chargeItemId}`]: '999' } },
    ]
    for (const example of invalid) expect((await s.write(confirmPath(frozen), example.input, example.expected)).status).toBe(409)
    expect((await s.write(confirmPath(frozen), { commitToken: frozen.commitToken }, valid, s.doctor)).status).toBe(403)
    expect(await s.readBill()).toEqual(before)
    expect(counts(s)).toEqual(beforeCounts)
    await parsed(multiResult, confirm(s, frozen))
    const conflict = await confirm(s, competing)
    expect(conflict.status).toBe(409)
    expect((await s.readBill()).payments).toHaveLength(1)
    expect(counts(s)).toEqual({ ...beforeCounts, payments: beforeCounts.payments + 1, allocations: beforeCounts.allocations + 2 })
  })

  it('旧单项分次款保持原形状，历史每页一整笔且多项分配完整、总额与方式不重复', async () => {
    const s = await setup(), charge = laboratories(await s.readBill())[0]!
    const old = await paySingle(s, charge, 300)
    const frozen = await preview(s, 'success', [{ method: 'cash', amountFen: 500 }, { method: 'bank-card', amountFen: 800 }])
    expect(frozen.amountFen).toBe(1300)
    expect(frozen.charges.find(item => item.chargeItemId === charge.chargeItemId)).toMatchObject({ paidFen: 300, collectionAmountFen: 500 })
    const collected = (await parsed(multiResult, confirm(s, frozen))).data
    const pages = [await s.readPage(1), await s.readPage(2)]
    for (const page of pages) {
      expect(page.paymentsPagination).toMatchObject({ pageSize: 1, total: 2 })
      expect(page.payments).toHaveLength(1)
    }
    const history = pages.flatMap(page => page.payments)
    expect(new Set(history.map(item => item.paymentId)).size).toBe(2)
    const original = history.find(item => item.paymentId === old.paymentId)!
    expect(original).toMatchObject({ chargeItemId: charge.chargeItemId, amountFen: 300, outcome: 'success' })
    expect(original).not.toHaveProperty('allocations')
    const multi = history.find(item => item.paymentId === collected.paymentId)!
    expect(multi).toMatchObject({ kind: 'multi-charge', amountFen: 1300, allocations: expect.arrayContaining([
      { chargeItemId: charge.chargeItemId, amountFen: 500 },
      { chargeItemId: frozen.charges.find(item => item.chargeItemId !== charge.chargeItemId)!.chargeItemId, amountFen: 800 },
    ]), tenders: [{ method: 'cash', amountFen: 500 }, { method: 'bank-card', amountFen: 800 }] })
    expect(multi).not.toHaveProperty('chargeItemId')
    expect(laboratories(await s.readBill()).map(item => item.paidFen)).toEqual([800, 800])
    expect((await s.readPage(3)).payments).toEqual([])
  })

  it.each(['confirm', 'recover'] as const)('合并 %s 资金已写入后业务失败整笔回滚，原键只执行一次', async action => {
    const s = await setup(), frozen = await preview(s, action === 'recover' ? 'ambiguous' : 'success')
    const original = action === 'recover' ? (await parsed(multiResult, confirm(s, frozen))).data : undefined
    const bill = await s.readBill(), before = counts(s), key = randomUUID()
    const expected = versions(laboratories(bill))
    const path = original ? `/api/his/v1/payments/${original.paymentId}/actions/recover-multi-charge` : confirmPath(frozen)
    const input = original ? { expectedPaymentVersion: 1 } : { commitToken: frozen.commitToken }
    // This trigger fails only after a new money fact exists, inside the public Command's business writes.
    s.runtime.database.driver.exec(`CREATE TEMP TRIGGER fail_multi_charge_business_write BEFORE UPDATE ON charge_record
      WHEN OLD.category='laboratory' AND EXISTS (
        SELECT 1 FROM ${action === 'recover' ? 'collection_resolution' : 'collection_transaction'}
      ) BEGIN SELECT RAISE(ABORT,'synthetic multi-charge business write failure'); END`)
    const failed = await s.write(path, input, expected, undefined, key)
    expect(failed.status).toBe(500)
    expect((await s.receipt(key, `payment.multi-charge.${action}`)).status).toBe(404)
    expect(counts(s)).toEqual(before)
    expect(await s.readBill()).toEqual(bill)
    s.runtime.database.driver.exec('DROP TRIGGER fail_multi_charge_business_write')
    const result = await parsed(multiResult, s.write(path, input, expected, undefined, key))
    expect(result.data.outcome).toBe('success')
    expect(await parsed(multiResult, s.write(path, input, expected, undefined, key))).toEqual(result)
    expect(counts(s)).toEqual({ ...before,
      payments: before.payments + (original ? 0 : 1),
      allocations: before.allocations + (original ? 0 : 2),
      paymentResolutions: before.paymentResolutions + (original ? 1 : 0),
    })
    expect(laboratories(await s.readBill()).map(charge => charge.paidFen)).toEqual([800, 800])
  })

  it('退款按原款内指定分配核额度，未知预占跨重启恢复，原方式与跨原款依据不重复', async () => {
    const s = await setup(), initial = laboratories(await s.readBill()), first = initial[0]!, second = initial[1]!
    const old = await paySingle(s, first, 300)
    const frozen = await preview(s, 'success', [{ method: 'cash', amountFen: 500 }, { method: 'bank-card', amountFen: 800 }])
    const payment = (await parsed(multiResult, confirm(s, frozen))).data
    await s.runtime.dispatchPending()
    const clinical = await s.readDetail()
    expect(clinical.laboratoryRequests?.requests.every(request => request.billing?.releasedAt !== undefined)).toBe(true)
    for (const [chargeItemId, amountFen] of [[first.chargeItemId, 600], [second.chargeItemId, 800]] satisfies Array<[string, number]>) {
      const current = (await s.readBill()).charges.find(item => item.chargeItemId === chargeItemId)!
      await parsed(chargeAdjustmentResponseSchema, s.write(`/api/his/v1/billing/cases/${s.caseId}/adjustments`, {
        chargeItemId, amountFen, reason: '合成原费用核准冲减并核对原分配退款',
      }, versions([current])))
    }
    const before = counts(s), statement = await s.readRefunds()
    const multiSource = statement.sources.find(item => item.sourceId === payment.paymentId)!
    expect(multiSource).toMatchObject({ kind: 'multi-charge', amountFen: 1300, refundedFen: 0, reservedFen: 0, allocations: expect.arrayContaining([
      expect.objectContaining({ chargeItemId: first.chargeItemId, amountFen: 500, refundableFen: 500 }),
      expect.objectContaining({ chargeItemId: second.chargeItemId, amountFen: 800, refundableFen: 800 }),
    ]) })
    expect(multiSource).not.toHaveProperty('chargeItemId')
    // 501 is below the source total and the 600 basis, but exceeds this original 500 allocation.
    expect((await refundPreview(s, payment.paymentId, first.chargeItemId, 501)).response.status).toBe(409)
    expect((await refundPreview(s, payment.paymentId, second.chargeItemId, 1301)).response.status).toBe(409)
    // The legacy wire cannot silently treat a multi-charge source as its first charge.
    expect((await refundPreview(s, payment.paymentId, first.chargeItemId, 1, 'success', true)).response.status).toBe(409)
    const key = randomUUID(), refund = await confirmRefund(s, await refundPreview(s, payment.paymentId, first.chargeItemId, 400, 'ambiguous'), key)
    expect(refund.data).toMatchObject({ sourceId: payment.paymentId, basisId: `outpatient-charge:${first.chargeItemId}`,
      amountFen: 400, outcome: 'ambiguous', tenders: [{ method: 'cash', amountFen: 400 }] })
    expect(await s.readRefunds()).toMatchObject({ refundedFen: 0, reservedFen: 400 })
    expect((await refundPreview(s, old.paymentId, first.chargeItemId, 1, 'success', true)).response.status).toBe(409)
    await s.restart()
    const receipt = await parsed(commandReceiptLookupSchema, s.receipt(key, 'refund.confirm'))
    expect(refundResponseSchema.parse(receipt.response)).toEqual(refund)
    const charge = (await s.readBill()).charges.find(item => item.chargeItemId === first.chargeItemId)!
    const otherCharge = (await s.readBill()).charges.find(item => item.chargeItemId === second.chargeItemId)!
    const recoverPath = `/api/his/v1/refunds/${refund.data.refundId}/actions/recover`
    expect((await s.write(recoverPath, { expectedRefundVersion: 1 }, versions([otherCharge]))).status).toBe(409)
    const recoverKey = randomUUID(), recovered = await parsed(refundResponseSchema, s.write(recoverPath, { expectedRefundVersion: 1 }, versions([charge]), undefined, recoverKey))
    expect(recovered.data).toMatchObject({ refundId: refund.data.refundId, sourceId: payment.paymentId, outcome: 'success', amountFen: 400 })
    expect(await parsed(refundResponseSchema, s.write(recoverPath, { expectedRefundVersion: 1 }, versions([charge]), undefined, recoverKey))).toEqual(recovered)
    expect(counts(s)).toEqual({ ...before, refunds: before.refunds + 1, refundResolutions: before.refundResolutions + 1 })
    expect(await s.readRefunds()).toMatchObject({ refundedFen: 400, reservedFen: 0 })
    // The old 300 source still has 300, but only 200 of this charge's cross-source basis remains.
    expect((await refundPreview(s, old.paymentId, first.chargeItemId, 201, 'success', true)).response.status).toBe(409)
    const oldRefund = await confirmRefund(s, await refundPreview(s, old.paymentId, first.chargeItemId, 200, 'success', true))
    expect(oldRefund.data.tenders).toEqual([{ method: 'mobile', amountFen: 200 }])
    const secondRefund = await confirmRefund(s, await refundPreview(s, payment.paymentId, second.chargeItemId, 800))
    expect(secondRefund.data.tenders).toEqual([{ method: 'cash', amountFen: 100 }, { method: 'bank-card', amountFen: 700 }])
    const final = await s.readRefunds()
    expect(final).toMatchObject({ adjustedFen: 1400, refundedFen: 1400, reservedFen: 0 })
    expect(final.sources.find(item => item.sourceId === payment.paymentId)).toMatchObject({ amountFen: 1300, refundedFen: 1200, reservedFen: 0 })
    expect(final.sources.find(item => item.sourceId === old.paymentId)).toMatchObject({ amountFen: 300, refundedFen: 200 })
    expect((await refundPreview(s, payment.paymentId, first.chargeItemId, 1)).response.status).toBe(409)
    expect(counts(s)).toEqual({ ...before, refunds: before.refunds + 3, refundResolutions: before.refundResolutions + 1 })
    const after = await s.readDetail()
    expect(after.laboratoryRequests?.requests.map(request => ({ id: request.id, status: request.status, releasedAt: request.billing?.releasedAt, report: request.report })))
      .toEqual(clinical.laboratoryRequests?.requests.map(request => ({ id: request.id, status: request.status, releasedAt: request.billing?.releasedAt, report: request.report })))
  }, 30_000)
})

