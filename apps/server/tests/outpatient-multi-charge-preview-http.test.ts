import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  apiErrorSchema, billingCaseSchema, doctorCaseDetailSchema, issueLaboratoryRequestResponseSchema,
  laboratoryRequestDraftResponseSchema, multiChargePaymentPreviewResponseSchema, paymentPreviewResponseSchema,
  paymentResponseSchema, startVisitResponseSchema,
} from '@clinmesh/contracts/his'
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
    write, readBill, readDetail, caseId: started.outpatientCaseId, get doctor() { return doctor },
    async anotherCase() {
      const visit = await startConsultationCase(runtime)
      await prepareVisit(visit)
      return { caseId: visit.outpatientCaseId, readBill: () => readBillFor(visit.outpatientCaseId), readDetail: () => readDetailFor(visit.outpatientCaseId) }
    },
    receipt: (key: string) => runtime.app.request(
      `/api/his/v1/command-receipts?operationId=payment.multi-charge.preview&idempotencyKey=${key}`, { headers: { cookie: cashier } },
    ),
    async restart() {
      await runtime.close()
      runtime = await createClinMeshRuntime(options)
      doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
      cashier = await signIn(runtime, 'cashier@demo.clinmesh.local')
    },
  }
}

describe('门诊多费用预览的独立公共 HTTP 合同', () => {
  it('冻结两项余额且旧确认不能消费，原回执与同键重放跨真实重启不形成收款或放行', async () => {
    const s = await setup()
    const bill = await s.readBill()
    const charges = bill.charges.filter(charge => charge.category === 'laboratory')
    expect(charges).toHaveLength(2)
    const input = {
      caseId: s.caseId, chargeItemIds: charges.map(charge => charge.chargeItemId), simulatorRule: 'success',
    }
    const versions = Object.fromEntries(charges.map(charge => [`ChargeItem/${charge.chargeItemId}`, String(charge.chargeVersion)]))
    const before = await s.readDetail(), key = randomUUID()
    const response = await s.write('/api/his/v1/payments/actions/preview-multi-charge', input, versions, undefined, key)
    expect(response.status, await response.clone().text()).toBe(200)
    const frozen = multiChargePaymentPreviewResponseSchema.parse(await response.json())
    expect(frozen.data).toMatchObject({ totalFen: 1600, remainingFen: 1600, amountFen: 1600, paidFen: 0, insuranceFen: 0,
      charges: [expect.objectContaining({ amountFen: 800, remainingFen: 800, collectionAmountFen: 800 }),
        expect.objectContaining({ amountFen: 800, remainingFen: 800, collectionAmountFen: 800 })],
      tenders: [{ method: 'cash', amountFen: 1600 }],
    })
    const cannotConfirm = async () => {
      const result = await s.write(`/api/his/v1/payments/${frozen.data.previewId}/actions/confirm`, { commitToken: frozen.data.commitToken }, versions)
      expect(result.status).toBe(409)
      expect(apiErrorSchema.parse(await result.json()).error.code).toBe('WORKFLOW_CONFLICT')
    }
    await cannotConfirm()
    expect(await s.readBill()).toEqual(bill)
    expect(await s.readDetail()).toEqual(before)
    await s.restart()
    const receipt = await s.receipt(key)
    expect(receipt.status).toBe(200)
    const original = commandReceiptLookupSchema.parse(await receipt.json())
    expect(original.status).toBe('completed')
    expect(multiChargePaymentPreviewResponseSchema.parse(original.response)).toEqual(frozen)
    const repeated = await s.write('/api/his/v1/payments/actions/preview-multi-charge', input, versions, undefined, key)
    expect(repeated.status).toBe(200)
    expect(multiChargePaymentPreviewResponseSchema.parse(await repeated.json()).data).toEqual(frozen.data)
    const changed = await s.write('/api/his/v1/payments/actions/preview-multi-charge', { ...input, simulatorRule: 'decline' }, versions, undefined, key)
    expect(changed.status).toBe(409)
    expect(apiErrorSchema.parse(await changed.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    await cannotConfirm()
    expect(await s.readBill()).toEqual(bill)
    expect(await s.readDetail()).toEqual(before)
  })

  it('保留原单项不足额付款，按更新余额冻结两项并阻断含未知原款的整次预览', async () => {
    const s = await setup()
    const charges = (await s.readBill()).charges.filter(charge => charge.category === 'laboratory')
    const charge = charges[0]!
    const versions = { [`ChargeItem/${charge.chargeItemId}`]: String(charge.chargeVersion) }
    const partialPreview = await s.write('/api/his/v1/payments/actions/preview', {
      caseId: s.caseId, category: 'laboratory', chargeItemId: charge.chargeItemId, simulatorRule: 'success',
      tenders: [{ method: 'mobile', amountFen: 300 }],
    }, versions)
    expect(partialPreview.status, await partialPreview.clone().text()).toBe(200)
    const partial = paymentPreviewResponseSchema.parse(await partialPreview.json()).data
    const collected = await s.write(`/api/his/v1/payments/${partial.previewId}/actions/confirm`, { commitToken: partial.commitToken }, versions)
    expect(collected.status, await collected.clone().text()).toBe(200)
    expect(paymentResponseSchema.parse(await collected.json()).data).toMatchObject({ amountFen: 300, remainingFen: 500, outcome: 'success' })
    const paidBill = await s.readBill(), beforeDetail = await s.readDetail()
    const latest = paidBill.charges.filter(charge => charge.category === 'laboratory')
    const latestVersions = Object.fromEntries(latest.map(charge => [`ChargeItem/${charge.chargeItemId}`, String(charge.chargeVersion)]))
    const combined = await s.write('/api/his/v1/payments/actions/preview-multi-charge', {
      caseId: s.caseId, chargeItemIds: latest.map(charge => charge.chargeItemId), simulatorRule: 'success',
      tenders: [{ method: 'cash', amountFen: 500 }, { method: 'bank-card', amountFen: 800 }],
    }, latestVersions)
    expect(combined.status, await combined.clone().text()).toBe(200)
    const frozen = multiChargePaymentPreviewResponseSchema.parse(await combined.json()).data
    expect(frozen).toMatchObject({ amountFen: 1300, remainingFen: 1300, paidFen: 300, totalFen: 1600 })
    expect(frozen.charges.find(item => item.chargeItemId === charge.chargeItemId)).toMatchObject({ paidFen: 300, collectionAmountFen: 500 })
    expect(await s.readBill()).toEqual(paidBill)
    expect(await s.readDetail()).toEqual(beforeDetail)
    const originalPreview = await s.write('/api/his/v1/payments/actions/preview', {
      caseId: s.caseId, category: 'laboratory', chargeItemId: charge.chargeItemId, simulatorRule: 'ambiguous',
    }, { [`ChargeItem/${charge.chargeItemId}`]: latestVersions[`ChargeItem/${charge.chargeItemId}`]! })
    expect(originalPreview.status).toBe(200)
    const unknownPreview = paymentPreviewResponseSchema.parse(await originalPreview.json()).data
    const unknown = await s.write(`/api/his/v1/payments/${unknownPreview.previewId}/actions/confirm`, { commitToken: unknownPreview.commitToken },
      { [`ChargeItem/${charge.chargeItemId}`]: String(unknownPreview.chargeVersion) })
    expect(unknown.status).toBe(200)
    expect(paymentResponseSchema.parse(await unknown.json()).data.outcome).toBe('ambiguous')
    const unknownBill = await s.readBill()
    const rejected = await s.write('/api/his/v1/payments/actions/preview-multi-charge', {
      caseId: s.caseId, chargeItemIds: latest.map(charge => charge.chargeItemId), simulatorRule: 'success',
    }, Object.fromEntries(unknownBill.charges.filter(item => item.category === 'laboratory').map(item => [`ChargeItem/${item.chargeItemId}`, String(item.chargeVersion)])))
    expect(rejected.status).toBe(409)
    expect(apiErrorSchema.parse(await rejected.json()).error.code).toBe('WORKFLOW_CONFLICT')
    expect(await s.readBill()).toEqual(unknownBill)
    expect((await s.readDetail()).laboratoryRequests?.requests.every(request => request.status === 'issued' && request.billing?.releasedAt === undefined)).toBe(true)
  })

  it('重复、缺失或多余版本、失效费用及付款合计不符均整次拒绝且不改变原账', async () => {
    const s = await setup(), bill = await s.readBill(), detail = await s.readDetail()
    const charges = bill.charges.filter(charge => charge.category === 'laboratory')
    const ids = charges.map(charge => charge.chargeItemId)
    const versions = Object.fromEntries(charges.map(charge => [`ChargeItem/${charge.chargeItemId}`, String(charge.chargeVersion)]))
    const input = { caseId: s.caseId, chargeItemIds: ids, simulatorRule: 'success' }
    const path = '/api/his/v1/payments/actions/preview-multi-charge'
    const invalid: Array<{ input: object; versions: Record<string, string>; status: number }> = [
      { input: { ...input, chargeItemIds: [ids[0], ids[0]] }, versions, status: 400 },
      { input, versions: { [`ChargeItem/${ids[0]}`]: '1' }, status: 409 },
      { input, versions: { ...versions, 'ChargeItem/unselected': '1' }, status: 409 },
      { input, versions: { ...versions, [`ChargeItem/${ids[0]}`]: '999' }, status: 409 },
      { input: { ...input, chargeItemIds: [ids[0], 'not-in-this-visit'] }, versions: { [`ChargeItem/${ids[0]}`]: '1', 'ChargeItem/not-in-this-visit': '1' }, status: 409 },
      { input: { ...input, tenders: [{ method: 'cash', amountFen: 1599 }] }, versions, status: 409 },
      { input: { ...input, tenders: [{ method: 'cash', amountFen: 800 }, { method: 'cash', amountFen: 800 }] }, versions, status: 400 },
      { input: { ...input, chargeItemIds: Array.from({ length: 21 }, (_, index) => `unselected-${index}`) }, versions: {}, status: 400 },
    ]
    const registration = bill.charges.find(charge => charge.category === 'registration')
    expect(registration).toBeDefined()
    invalid.push({ input: { ...input, chargeItemIds: [ids[0], registration!.chargeItemId] },
      versions: { [`ChargeItem/${ids[0]}`]: '1', [`ChargeItem/${registration!.chargeItemId}`]: String(registration!.chargeVersion) }, status: 409 })
    for (const example of invalid) {
      const response = await s.write(path, example.input, example.versions)
      expect(response.status, await response.clone().text()).toBe(example.status)
      apiErrorSchema.parse(await response.json())
    }
    const forbidden = await s.write(path, input, versions, s.doctor)
    expect(forbidden.status).toBe(403)
    apiErrorSchema.parse(await forbidden.json())
    expect(await s.readBill()).toEqual(bill)
    expect(await s.readDetail()).toEqual(detail)
  })

  it('两位实际就诊患者的合法费用不能混选，任何一方原账与临床记录均不改变', async () => {
    const s = await setup(), other = await s.anotherCase()
    const firstBill = await s.readBill(), secondBill = await other.readBill()
    expect(firstBill.patient.id).not.toBe(secondBill.patient.id)
    expect(firstBill.encounterId).not.toBe(secondBill.encounterId)
    const firstDetail = await s.readDetail(), secondDetail = await other.readDetail()
    const first = firstBill.charges.find(charge => charge.category === 'laboratory')!
    const second = secondBill.charges.find(charge => charge.category === 'laboratory')!
    const response = await s.write('/api/his/v1/payments/actions/preview-multi-charge', {
      caseId: s.caseId, chargeItemIds: [first.chargeItemId, second.chargeItemId], simulatorRule: 'success',
    }, { [`ChargeItem/${first.chargeItemId}`]: String(first.chargeVersion), [`ChargeItem/${second.chargeItemId}`]: String(second.chargeVersion) })
    expect(response.status).toBe(409)
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('WORKFLOW_CONFLICT')
    expect(await s.readBill()).toEqual(firstBill)
    expect(await other.readBill()).toEqual(secondBill)
    expect(await s.readDetail()).toEqual(firstDetail)
    expect(await other.readDetail()).toEqual(secondDetail)
  }, 30_000)
})
