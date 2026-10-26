import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  billingCaseSchema, doctorCaseDetailSchema, issueLaboratoryRequestResponseSchema,
  laboratoryRequestActionResponseSchema, laboratoryRequestDraftResponseSchema, sessionContextSchema, startVisitResponseSchema,
} from '@clinmesh/contracts/his'
import { insurancePreviewResponseSchema, insuranceResponseSchema, insuranceStateSchema } from '@clinmesh/contracts/insurance'
import { refundCaseSchema } from '@clinmesh/contracts/refunds'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider, useSyntheticLaboratoryCatalog } from './fixtures/consultation.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-investigation-insurance-'))
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-insurance-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters', databasePath: join(directory, 'test.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply', trustedOrigins: ['http://localhost'],
    patientPersonaModel: 'synthetic', syntheaProvider: new StubSyntheaProvider(),
    chatCompletionsProvider: { async completeJson() { return { content: JSON.stringify(persona), model: 'synthetic' } } },
  })
  cleanup.push(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
  // Arrange only the synthetic hospital catalog. Requests and charges use their public HTTP Commands.
  useSyntheticLaboratoryCatalog(runtime)
  runtime.database.driver.prepare("UPDATE outpatient_catalog SET price_fen=800 WHERE item_id IN ('lab-cbc','lab-crp')").run()
  const started = await startConsultationCase(runtime)
  const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const cashier = await signIn(runtime, 'cashier@demo.clinmesh.local')
  const auth = sessionContextSchema.parse(await (await runtime.app.request('/api/auth/context', { headers: { cookie: doctor } })).json())
  const systemContext = {
    actorId: 'actor-lis-system', roleCode: 'lis-system', epoch: auth.actor.epoch,
    scenarioRunId: auth.actor.scenarioRunId, workspaceId: auth.actor.workspaceId,
  }
  const write = (path: string, input: object, cookie = cashier, expectedVersions: Record<string, string> = {}, method = 'POST') => runtime.app.request(path, {
    method, body: JSON.stringify({ expectedVersions, input }),
    headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost', 'idempotency-key': randomUUID() },
  })
  const visit = await write(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, {}, doctor, {
    [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1',
  })
  expect(visit.status, await visit.clone().text()).toBe(200)
  startVisitResponseSchema.parse(await visit.json())
  const readDetail = async () => doctorCaseDetailSchema.parse(await (await runtime.app.request(
    `/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie: doctor } },
  )).json())
  const readBill = async () => billingCaseSchema.parse(await (await runtime.app.request(
    `/api/his/v1/billing/cases/${started.outpatientCaseId}`, { headers: { cookie: cashier } },
  )).json())
  const readRefunds = async () => refundCaseSchema.parse(await (await runtime.app.request(
    `/api/his/v1/billing/cases/${started.outpatientCaseId}/refunds`, { headers: { cookie: cashier } },
  )).json())
  const issue = async (catalogItemId: string) => {
    const detail = await readDetail()
    const expectedVersions = { [`Encounter/${started.encounterId}`]: detail.encounter.versionId }
    const draftResponse = await write(`/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`, {
      catalogItemId, expectedDraftVersion: detail.laboratoryRequests?.draftVersion ?? 0, indicationCode: 'fever',
    }, doctor, expectedVersions, 'PUT')
    expect(draftResponse.status, await draftResponse.clone().text()).toBe(200)
    const draft = laboratoryRequestDraftResponseSchema.parse(await draftResponse.json()).data
    const issuedResponse = await write(`/api/his/v1/encounters/${started.encounterId}/laboratory-request/actions/issue`, {
      expectedDraftVersion: draft.draftVersion,
    }, doctor, expectedVersions)
    expect(issuedResponse.status, await issuedResponse.clone().text()).toBe(200)
    return issueLaboratoryRequestResponseSchema.parse(await issuedResponse.json()).data.request
  }
  const insurancePath = `/api/his/v1/insurance/outpatient/${started.outpatientCaseId}`
  const settle = async () => {
    const response = await write(`${insurancePath}/preview`, { planCode: 'employee-v1' })
    expect(response.status, await response.clone().text()).toBe(200)
    const preview = insurancePreviewResponseSchema.parse(await response.json()).data
    const confirmed = await write(`${insurancePath}/confirm`, { previewId: preview.previewId, commitToken: preview.commitToken })
    expect(confirmed.status, await confirmed.clone().text()).toBe(200)
    return insuranceResponseSchema.parse(await confirmed.json()).data
  }
  const cancelInsurance = async () => {
    const state = insuranceStateSchema.parse(await (await runtime.app.request(insurancePath, { headers: { cookie: cashier } })).json())
    const settlement = state.active!
    const year = state.annualBalances.find(balance => balance.year === settlement.year)!
    const response = await write(`${insurancePath}/cancel`, { settlementId: settlement.id, expectedBalanceVersion: year.version })
    expect(response.status, await response.clone().text()).toBe(200)
    return insuranceResponseSchema.parse(await response.json()).data
  }
  const readRequest = async (requestId: string) => {
    const request = (await readDetail()).laboratoryRequests?.requests.find(item => item.id === requestId)
    if (request === undefined) throw new Error('Missing original investigation request')
    return request
  }
  const cancelRequest = async (requestId: string) => {
    const request = await readRequest(requestId)
    return write(`/api/his/v1/laboratory-requests/${requestId}/actions/cancel`, {
      expectedRequestVersion: request.version, reasonCode: 'no-longer-needed',
    }, doctor, {
      [`ServiceRequest/${request.serviceRequestId}`]: request.serviceRequestVersion,
      [`Task/${request.taskId}`]: request.taskVersion,
    })
  }
  const accept = (requestId: string, eventId = randomUUID()) => runtime.workflow.acceptLaboratoryRequest({ context: systemContext, eventId, requestId })
  const start = (requestId: string) => runtime.workflow.startLaboratoryRequest({ context: systemContext, eventId: randomUUID(), requestId })
  return { readDetail, readRequest, readBill, readRefunds, issue, settle, cancelInsurance, cancelRequest, accept, start }
}

describe('独立门诊检查的医保覆盖与放行时序', () => {
  it('同次就诊两项独立检验分别关联原费用，待遇全覆盖只放行对应原申请一次', async () => {
    const s = await setup()
    const first = await s.issue('lab-cbc'), second = await s.issue('lab-crp')
    expect(first.billing?.chargeItemId).not.toBe(second.billing?.chargeItemId)
    const before = (await s.readBill()).charges.filter(charge => charge.category === 'laboratory')
    expect(before).toHaveLength(2)
    expect(before).toEqual(expect.arrayContaining([
      expect.objectContaining({ chargeItemId: first.billing!.chargeItemId, requestId: first.id, amountFen: 800, paidFen: 0, remainingFen: 800 }),
      expect.objectContaining({ chargeItemId: second.billing!.chargeItemId, requestId: second.id, amountFen: 800, paidFen: 0, remainingFen: 800 }),
    ]))
    const state = await s.settle()
    // Registration stays outside coverage; both original investigation fees are fully covered.
    expect(state.active).toMatchObject({ fundFen: 308, accountFen: 1292, patientFen: 2000 })
    for (const request of [first, second]) {
      const allocation = state.active!.allocations.find(item => item.reference === `ChargeItem/${request.billing!.chargeItemId}`)!
      expect(allocation).toMatchObject({ amountFen: 800, patientFen: 0 })
      expect(allocation.fundFen + allocation.accountFen).toBe(800)
    }
    const firstAcceptance = randomUUID()
    expect(s.accept(first.id, firstAcceptance).data.status).toBe('accepted')
    const requests = (await s.readDetail()).laboratoryRequests!.requests
    expect(requests.find(request => request.id === first.id)).toMatchObject({ status: 'accepted', billing: { insuranceFen: 800, paidFen: 0, releasedAt: expect.any(String) } })
    expect(requests.find(request => request.id === second.id)).toMatchObject({ status: 'issued', billing: { insuranceFen: 800, paidFen: 0 } })
    expect(requests.find(request => request.id === second.id)!.billing?.releasedAt).toBeUndefined()
    expect(s.accept(second.id).data.status).toBe('accepted')
    const released = (await s.readDetail()).laboratoryRequests!.requests
    expect(s.accept(first.id, firstAcceptance).data.status).toBe('accepted')
    expect((await s.readDetail()).laboratoryRequests!.requests).toEqual(released)
    expect((await s.readBill()).payments).toEqual([])
  }, 30_000)

  it('受理前撤销待遇使旧受理事件重新检查资金，原申请等待补足而不执行', async () => {
    const s = await setup(), request = await s.issue('lab-cbc')
    await s.settle()
    expect(await s.readRequest(request.id)).toMatchObject({ status: 'issued', billing: { insuranceFen: 800, remainingFen: 0 } })
    await s.cancelInsurance()
    expect(() => s.accept(request.id)).toThrow('原检查申请尚未收齐费用')
    expect(await s.readRequest(request.id)).toMatchObject({ status: 'issued', billing: { insuranceFen: 0, remainingFen: 800 } })
    expect((await s.readRequest(request.id)).billing?.releasedAt).toBeUndefined()
    expect(() => s.start(request.id)).toThrow('cannot start execution')
    await s.settle()
    expect(s.accept(request.id).data.status).toBe('accepted')
    expect(await s.readRequest(request.id)).toMatchObject({ status: 'accepted', billing: { releasedAt: expect.any(String) } })
  }, 30_000)

  it('受理后撤销待遇保留首次放行快照，原申请可开始且不会重新受理', async () => {
    const s = await setup(), request = await s.issue('lab-cbc')
    await s.settle()
    expect(s.accept(request.id).data.status).toBe('accepted')
    const releasedAt = (await s.readRequest(request.id)).billing!.releasedAt
    expect(releasedAt).toBeTypeOf('string')
    await s.cancelInsurance()
    expect(await s.readRequest(request.id)).toMatchObject({
      status: 'accepted', billing: { insuranceFen: 0, remainingFen: 800, releasedAt },
    })
    const cancellation = await s.cancelRequest(request.id)
    expect(cancellation.status, await cancellation.clone().text()).toBe(409)
    expect(await cancellation.json()).toMatchObject({ error: { code: 'LABORATORY_REQUEST_NOT_CANCELLABLE' } })
    expect(s.start(request.id).data.status).toBe('in-progress')
    expect(await s.readRequest(request.id)).toMatchObject({ status: 'in-progress', billing: { releasedAt, remainingFen: 800 } })
    expect(() => s.accept(request.id)).toThrow('cannot be accepted')
    expect((await s.readRequest(request.id)).billing!.releasedAt).toBe(releasedAt)
  }, 30_000)

  it('有效医保分配阻止临床取消，撤销原待遇后取消全额冲减且不虚构退款', async () => {
    const s = await setup(), request = await s.issue('lab-cbc')
    await s.settle()
    const covered = await s.readBill()
    const denied = await s.cancelRequest(request.id)
    expect(denied.status, await denied.clone().text()).toBe(409)
    expect(await denied.json()).toMatchObject({ error: { code: 'WORKFLOW_CONFLICT' } })
    expect(await s.readBill()).toEqual(covered)
    expect((await s.readRefunds()).adjustments).toEqual([])
    await s.cancelInsurance()
    const response = await s.cancelRequest(request.id)
    expect(response.status, await response.clone().text()).toBe(200)
    const cancelled = laboratoryRequestActionResponseSchema.parse(await response.json()).data.request
    expect(cancelled).toMatchObject({ id: request.id, status: 'cancelled' })
    expect(await s.readRequest(request.id)).toMatchObject({ billing: { status: 'cancelled', paidFen: 0, insuranceFen: 0, remainingFen: 0 } })
    expect((await s.readBill()).charges.find(charge => charge.chargeItemId === request.billing!.chargeItemId))
      .toMatchObject({ amountFen: 0, paidFen: 0, remainingFen: 0 })
    expect(await s.readRefunds()).toMatchObject({ adjustedFen: 800, refundedFen: 0, refunds: [], sources: [],
      adjustments: [{ chargeItemId: request.billing!.chargeItemId, amountFen: 800 }] })
    expect(s.accept(request.id).data.status).toBe('cancelled')
    expect(() => s.start(request.id)).toThrow('cannot start execution')
    expect((await s.readRequest(request.id)).billing?.releasedAt).toBeUndefined()
  }, 30_000)
})
