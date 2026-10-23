import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import {
  billingCaseSchema,
  clinicalDocumentDraftResponseSchema,
  clinicalDocumentSignPreviewResponseSchema,
  clinicalDocumentSignResponseSchema,
  confirmDiagnosisResponseSchema,
  diagnosisDraftResponseSchema,
  doctorQueueSchema,
  doctorCaseDetailSchema,
  encounterCompletionResponseSchema,
  firstVisitDraftResponseSchema,
  issuePrescriptionResponseSchema,
  laboratoryOrderResponseSchema,
  paymentPreviewResponseSchema,
  paymentResponseSchema,
  pharmacyQueueSchema,
  prescriptionDraftResponseSchema,
  startVisitResponseSchema,
  withdrawPrescriptionResponseSchema,
} from '@clinmesh/contracts/his'
import { createClinMeshRuntime } from '../src/runtime.ts'
import {
  insurancePreviewResponseSchema,
  insuranceResponseSchema,
  insuranceStateSchema,
} from '@clinmesh/contracts/insurance'
import {
  chargeAdjustmentResponseSchema,
  refundPreviewResponseSchema,
  refundResponseSchema,
} from '@clinmesh/contracts/refunds'
import {
  persona,
  signIn,
  startConsultationCase,
  StubSyntheaProvider,
} from './fixtures/consultation.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
async function setup(priceFen = 6800) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-insurance-'))
  const password = 'Synthetic-Demo-Password-2026!'
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost',
    authSecret: 'synthetic-insurance-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters',
    databasePath: join(directory, 'test.sqlite'),
    demoPassword: password,
    migrationMode: 'apply',
    trustedOrigins: ['http://localhost'],
    patientPersonaModel: 'synthetic',
    syntheaProvider: new StubSyntheaProvider(),
    chatCompletionsProvider: {
      async completeJson(input) {
        if (
          input.schemaName === 'clinical_document_quality' ||
          input.schemaName === 'clinical_document_quality_verification'
        ) {
          const payload = z
            .object({
              agentFacts: z.array(z.object({ id: z.string() })),
              issues: z.array(z.unknown()).optional(),
            })
            .parse(input.userPayload)
          return {
            content: JSON.stringify({
              issues:
                input.schemaName === 'clinical_document_quality_verification'
                  ? payload.issues!.map((_, index) => ({ index, supported: true }))
                  : [],
              agentFactChecks: payload.agentFacts.map((fact) => ({ id: fact.id, supported: true })),
            }),
            model: 'synthetic',
          }
        }
        return {
          content: JSON.stringify(
            input.schemaName === 'patient_persona'
              ? persona
              : { conclusion: '白细胞计数升高。', interpretation: 'high', value: 11.2 },
          ),
          model: 'synthetic',
        }
      },
    },
  })
  cleanup.push(async () => {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  })
  const started = await startConsultationCase(runtime, password)
  runtime.database.driver
    .prepare("UPDATE outpatient_catalog SET price_fen=? WHERE item_id='lab-fever-panel'")
    .run(priceFen)
  const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local', password)
  const cashier = await signIn(runtime, 'cashier@demo.clinmesh.local', password)
  const write = (
    path: string,
    input: object,
    cookie = cashier,
    key = randomUUID(),
    expectedVersions: Record<string, string> = {},
  ) =>
    runtime.app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost',
        'idempotency-key': key,
      },
      body: JSON.stringify({ input, expectedVersions }),
    })
  const encounter = `Encounter/${started.encounterId}`,
    task = `Task/${started.doctorTaskId}`
  const visit = startVisitResponseSchema.parse(
    await (
      await write(
        `/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`,
        {},
        doctor,
        randomUUID(),
        { [encounter]: started.encounterVersion, [task]: '1' },
      )
    ).json(),
  ).data
  const draftResponse = await runtime.app.request(
    `/api/his/v1/encounters/${started.encounterId}/drafts/first-visit`,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: doctor,
        origin: 'http://localhost',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        expectedVersions: { [encounter]: visit.encounterVersion },
        input: {
          expectedDraftVersion: 0,
          assessment: '合成医保测试',
          historyOfPresentIllness: '合成发热一天',
        },
      }),
    },
  )
  const draft = firstVisitDraftResponseSchema.parse(await draftResponse.json()).data
  const order = laboratoryOrderResponseSchema.parse(
    await (
      await write(
        `/api/his/v1/encounters/${started.encounterId}/actions/issue-laboratory-order`,
        {
          catalogItemId: 'lab-fever-panel',
          expectedDraftVersion: draft.draftVersion,
          indicationCode: 'fever',
        },
        doctor,
        randomUUID(),
        { [encounter]: visit.encounterVersion, [task]: visit.taskVersion },
      )
    ).json(),
  ).data
  return {
    runtime,
    cashier,
    doctor,
    write,
    started,
    target: { kind: 'outpatient', id: started.outpatientCaseId },
    order,
  }
}

it('收费员预览职工待遇，按基金及个人账户减少患者应收，保留原费用和独立资金事实', async () => {
  const s = await setup()
  const response = await s.write(`/api/his/v1/insurance/outpatient/${s.target.id}/preview`, {
    planCode: 'employee-v1',
  })
  expect(response.status, await response.clone().text()).toBe(200)
  const preview = (await response.json()) as {
    data: {
      previewId: string
      commitToken: string
      settlement: { fundFen: number; accountFen: number; patientFen: number }
    }
  }
  // 6800检验：10%先行自付，6120目录金额−1000起付，70%基金=3584；账户2000。
  expect(preview.data.settlement).toMatchObject({ fundFen: 3584, accountFen: 2000 })
  const result = await s.write(`/api/his/v1/insurance/outpatient/${s.target.id}/confirm`, {
    previewId: preview.data.previewId,
    commitToken: preview.data.commitToken,
  })
  expect(result.status, await result.clone().text()).toBe(200)
  const bill = billingCaseSchema.parse(
    await (
      await s.runtime.app.request(`/api/his/v1/billing/cases/${s.target.id}`, {
        headers: { cookie: s.cashier },
      })
    ).json(),
  )
  expect(bill.charges.find((item) => item.chargeItemId === s.order.chargeItemId)).toMatchObject({
    amountFen: 6800,
    paidFen: 0,
    remainingFen: 1216,
  })
  expect(bill.payments).toEqual([])
}, 30000)

it('居民方案解释目录外和先行自付，原待遇补偿恢复账户及年度累计，重复撤销不重复累计', async () => {
  const s = await setup(),
    path = `/api/his/v1/insurance/outpatient/${s.target.id}`
  const preview = insurancePreviewResponseSchema.parse(
    await (await s.write(path + '/preview', { planCode: 'resident-v1' })).json(),
  ).data
  expect(preview.settlement).toMatchObject({
    fundFen: 2060,
    accountFen: 0,
    eligibleFen: 6120,
    deductibleFen: 2000,
  })
  expect(
    preview.settlement.allocations.find(
      (row) => row.reference === `ChargeItem/${s.order.chargeItemId}`,
    ),
  ).toMatchObject({ priorSelfPayFen: 680, patientFen: 4740 })
  expect(preview.settlement.allocations.find((row) => row.outsideFen > 0)).toMatchObject({
    eligibleFen: 0,
    fundFen: 0,
    accountFen: 0,
  })
  const key = randomUUID(),
    input = { previewId: preview.previewId, commitToken: preview.commitToken }
  const confirmed = insuranceResponseSchema.parse(
    await (await s.write(path + '/confirm', input, s.cashier, key)).json(),
  ).data
  expect((await s.write(path + '/confirm', input, s.cashier, key)).status).toBe(200)
  expect(confirmed.balance).toMatchObject({
    version: 1,
    outpatientEligibleFen: 6120,
    outpatientFundFen: 2060,
    inpatientEligibleFen: 0,
  })
  const cancelKey = randomUUID(),
    cancel = { settlementId: confirmed.active!.id, expectedBalanceVersion: 1 }
  const cancelled = insuranceResponseSchema.parse(
    await (await s.write(path + '/cancel', cancel, s.cashier, cancelKey)).json(),
  ).data
  expect(cancelled.balance).toMatchObject({
    version: 2,
    outpatientEligibleFen: 0,
    outpatientFundFen: 0,
    accountFen: 0,
  })
  expect(cancelled.history).toHaveLength(2)
  expect(cancelled.history[1]?.reversesId).toBe(confirmed.active!.id)
  expect((await s.write(path + '/cancel', cancel, s.cashier, cancelKey)).status).toBe(200)
  expect((await s.write(path + '/cancel', cancel)).status).toBe(409)
  expect((await s.write(path + '/preview', { planCode: 'employee-v1' })).status).toBe(409)
}, 30000)

async function settle(s: Awaited<ReturnType<typeof setup>>) {
  const path = `/api/his/v1/insurance/outpatient/${s.target.id}`
  const preview = insurancePreviewResponseSchema.parse(
    await (await s.write(path + '/preview', { planCode: 'employee-v1' })).json(),
  ).data
  const response = await s.write(path + '/confirm', {
    previewId: preview.previewId,
    commitToken: preview.commitToken,
  })
  expect(response.status, await response.clone().text()).toBe(200)
  return insuranceResponseSchema.parse(await response.json()).data
}

it('未结算检验冲减后按净费用计算待遇，患者只支付净额中的个人负担', async () => {
  const s = await setup()
  await adjustLaboratory(s, 1000)
  const state = await settle(s)
  // 净费用5800：先行580、目录内5220、起付1000、基金2954、账户2000、患者846。
  expect(state.active?.allocations.find(row => row.reference === `ChargeItem/${s.order.chargeItemId}`)).toMatchObject({
    amountFen: 5800, priorSelfPayFen: 580, eligibleFen: 5220, deductibleFen: 1000,
    fundFen: 2954, accountFen: 2000, patientFen: 846,
  })
  await pay(s, 'laboratory')
  const bill = billingCaseSchema.parse(await (await s.runtime.app.request(
    `/api/his/v1/billing/cases/${s.target.id}`, { headers: { cookie: s.cashier } },
  )).json())
  expect(bill.charges.find(row => row.chargeItemId === s.order.chargeItemId)).toMatchObject({
    amountFen: 5800, insuranceFen: 4954, paidFen: 846, remainingFen: 0, status: 'paid',
  })
  expect((await s.runtime.dispatcher.dispatchOnce())?.status).toBe('completed')
}, 30000)

async function laboratoryCharge(s: Awaited<ReturnType<typeof setup>>) {
  const bill = billingCaseSchema.parse(await (await s.runtime.app.request(
    `/api/his/v1/billing/cases/${s.target.id}`, { headers: { cookie: s.cashier } },
  )).json())
  return bill.charges.find(row => row.chargeItemId === s.order.chargeItemId)!
}

async function adjustLaboratory(s: Awaited<ReturnType<typeof setup>>, amountFen: number) {
  const charge = await laboratoryCharge(s)
  const response = await s.write(
    `/api/his/v1/billing/cases/${s.target.id}/adjustments`,
    { chargeItemId: charge.chargeItemId, amountFen, reason: '合成检验费用错误，核准冲减。' },
    s.cashier,
    randomUUID(),
    { [`ChargeItem/${charge.chargeItemId}`]: String(charge.chargeVersion) },
  )
  expect(response.status, await response.clone().text()).toBe(200)
  return chargeAdjustmentResponseSchema.parse(await response.json()).data
}

it('冲减后个人账户全覆盖净费用时直接放行，不要求补交原价差额', async () => {
  const s = await setup(2000)
  await adjustLaboratory(s, 1000)
  const state = await settle(s)
  expect(state.active?.allocations.find(row => row.reference === `ChargeItem/${s.order.chargeItemId}`)).toMatchObject({
    amountFen: 1000, fundFen: 0, accountFen: 1000, patientFen: 0,
  })
  expect(await laboratoryCharge(s)).toMatchObject({
    amountFen: 1000, insuranceFen: 1000, paidFen: 0, remainingFen: 0, status: 'paid',
  })
  expect((await s.runtime.dispatcher.dispatchOnce())?.status).toBe('completed')
  expect(await s.runtime.dispatcher.dispatchOnce()).toBeUndefined()
}, 30000)

async function pay(s: Awaited<ReturnType<typeof setup>>, category: 'laboratory' | 'medication', amountFen?: number) {
  const bill = billingCaseSchema.parse(
    await (
      await s.runtime.app.request(`/api/his/v1/billing/cases/${s.target.id}`, {
        headers: { cookie: s.cashier },
      })
    ).json(),
  )
  const charge = bill.charges.find((row) => row.category === category)!
  const expected = { [`ChargeItem/${charge.chargeItemId}`]: String(charge.chargeVersion) }
  const previewResponse = await s.write(
    '/api/his/v1/payments/actions/preview',
    { caseId: s.target.id, category, simulatorRule: 'success', ...(amountFen === undefined ? {} : { tenders: [{ method: 'cash', amountFen }] }) },
    s.cashier,
    randomUUID(),
    expected,
  )
  expect(previewResponse.status, await previewResponse.clone().text()).toBe(200)
  const preview = paymentPreviewResponseSchema.parse(await previewResponse.json()).data
  const response = await s.write(
    `/api/his/v1/payments/${preview.previewId}/actions/confirm`,
    { commitToken: preview.commitToken },
    s.cashier,
    randomUUID(),
    expected,
  )
  expect(response.status, await response.clone().text()).toBe(200)
  return paymentResponseSchema.parse(await response.json()).data
}

it('未知退款阻断新收款和费用更正，原退款恢复后按净余额继续收款', async () => {
  const s = await setup()
  const payment = await pay(s, 'laboratory', 3000)
  await adjustLaboratory(s, 1000)
  const charge = await laboratoryCharge(s)
  const expected = { [`ChargeItem/${charge.chargeItemId}`]: String(charge.chargeVersion) }
  const paymentInput = { caseId: s.target.id, category: 'laboratory', simulatorRule: 'success' }
  const pendingPaymentResponse = await s.write('/api/his/v1/payments/actions/preview', paymentInput, s.cashier, randomUUID(), expected)
  expect(pendingPaymentResponse.status, await pendingPaymentResponse.clone().text()).toBe(200)
  const pendingPayment = paymentPreviewResponseSchema.parse(await pendingPaymentResponse.json()).data
  const refundPreviewResponse = await s.write('/api/his/v1/refunds/actions/preview', {
    paymentId: payment.paymentId, amountFen: 1000, expectedSourceVersion: 1, simulatorRule: 'ambiguous',
  }, s.cashier, randomUUID(), expected)
  expect(refundPreviewResponse.status, await refundPreviewResponse.clone().text()).toBe(200)
  const refundPreview = refundPreviewResponseSchema.parse(await refundPreviewResponse.json()).data
  const refundResponse = await s.write(`/api/his/v1/refunds/${refundPreview.previewId}/actions/confirm`, {
    commitToken: refundPreview.commitToken,
  }, s.cashier, randomUUID(), expected)
  expect(refundResponse.status, await refundResponse.clone().text()).toBe(200)
  const refund = refundResponseSchema.parse(await refundResponse.json()).data
  expect(refund.outcome).toBe('ambiguous')
  expect((await s.write(`/api/his/v1/payments/${pendingPayment.previewId}/actions/confirm`, {
    commitToken: pendingPayment.commitToken,
  }, s.cashier, randomUUID(), expected)).status).toBe(409)
  expect((await s.write('/api/his/v1/payments/actions/preview', paymentInput, s.cashier, randomUUID(), expected)).status).toBe(409)
  expect((await s.write(`/api/his/v1/billing/cases/${s.target.id}/adjustments`, {
    chargeItemId: charge.chargeItemId, amountFen: 100, reason: '合成费用更正，须先查明原退款。',
  }, s.cashier, randomUUID(), expected)).status).toBe(409)
  const recoveredResponse = await s.write(`/api/his/v1/refunds/${refund.refundId}/actions/recover`, {
    expectedRefundVersion: refund.version,
  }, s.cashier, randomUUID(), expected)
  expect(recoveredResponse.status, await recoveredResponse.clone().text()).toBe(200)
  expect(refundResponseSchema.parse(await recoveredResponse.json()).data).toMatchObject({
    refundId: refund.refundId, sourceId: payment.paymentId, outcome: 'success',
  })
  expect(await laboratoryCharge(s)).toMatchObject({ paidFen: 2000, remainingFen: 3800, status: 'billable' })
  await pay(s, 'laboratory')
  expect(await laboratoryCharge(s)).toMatchObject({ amountFen: 5800, paidFen: 5800, remainingFen: 0, status: 'paid' })
  expect((await s.runtime.dispatcher.dispatchOnce())?.status).toBe('completed')
}, 30000)

it('有效医保费用先撤销待遇再冲减，保留原现金与待遇历史且不重复放行', async () => {
  const s = await setup()
  const state = await settle(s)
  const payment = await pay(s, 'laboratory')
  const charge = await laboratoryCharge(s)
  const response = await s.write(`/api/his/v1/billing/cases/${s.target.id}/adjustments`, {
    chargeItemId: charge.chargeItemId, amountFen: 1000, reason: '合成检验费用错误，核准冲减。',
  }, s.cashier, randomUUID(), { [`ChargeItem/${charge.chargeItemId}`]: String(charge.chargeVersion) })
  expect(response.status, await response.clone().text()).toBe(409)
  expect(await laboratoryCharge(s)).toMatchObject({ amountFen: 6800, insuranceFen: 5584, paidFen: 1216, status: 'paid' })
  const path = `/api/his/v1/insurance/outpatient/${s.target.id}`
  const cancelledResponse = await s.write(path + '/cancel', {
    settlementId: state.active!.id, expectedBalanceVersion: state.balance.version,
  })
  expect(cancelledResponse.status, await cancelledResponse.clone().text()).toBe(200)
  const cancelled = insuranceResponseSchema.parse(await cancelledResponse.json()).data
  expect(cancelled.history).toHaveLength(2)
  expect(cancelled.history[1]?.reversesId).toBe(state.active!.id)
  expect(cancelled.activeSettlements).toEqual([])
  await adjustLaboratory(s, 1000)
  expect(await laboratoryCharge(s)).toMatchObject({ amountFen: 5800, insuranceFen: 0, paidFen: 1216, remainingFen: 4584 })
  await pay(s, 'laboratory')
  const bill = billingCaseSchema.parse(await (await s.runtime.app.request(
    `/api/his/v1/billing/cases/${s.target.id}`, { headers: { cookie: s.cashier } },
  )).json())
  expect(bill.payments.find(row => row.paymentId === payment.paymentId)).toMatchObject({ amountFen: 1216, outcome: 'success' })
  expect(bill.charges.find(row => row.chargeItemId === charge.chargeItemId)).toMatchObject({ amountFen: 5800, paidFen: 5800, remainingFen: 0, status: 'paid' })
  expect((await s.runtime.dispatcher.dispatchOnce())?.status).toBe('completed')
  expect(await s.runtime.dispatcher.dispatchOnce()).toBeUndefined()
}, 30000)

async function issueMedication(s: Awaited<ReturnType<typeof setup>>) {
  expect((await s.runtime.dispatcher.dispatchOnce())?.status).toBe('completed')
  const task = doctorQueueSchema.parse(
    await (
      await s.runtime.app.request('/api/his/v1/doctor/queue?pageSize=20', {
        headers: { cookie: s.doctor },
      })
    ).json(),
  ).items[0]!
  const encounter = `Encounter/${s.started.encounterId}`,
    taskRef = `Task/${task.taskId}`
  const visit = await s.write(
    `/api/his/v1/encounters/${s.started.encounterId}/actions/start-revisit`,
    {},
    s.doctor,
    randomUUID(),
    { [encounter]: '5', [taskRef]: '1' },
  )
  expect(visit.status, await visit.clone().text()).toBe(200)
  const put = async (path: string, input: object, version: string) => {
    const response = await s.runtime.app.request(
      `/api/his/v1/encounters/${s.started.encounterId}/${path}`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie: s.doctor,
          origin: 'http://localhost',
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify({ expectedVersions: { [encounter]: version }, input }),
      },
    )
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json()
  }
  const diagnosis = diagnosisDraftResponseSchema.parse(
    await put(
      'diagnosis/draft',
      {
        entries: [{ catalogItemId: 'diagnosis-influenza', role: 'primary' }],
        expectedDraftVersion: 0,
      },
      '6',
    ),
  ).data
  const confirmed = confirmDiagnosisResponseSchema.parse(
    await (
      await s.write(
        `/api/his/v1/encounters/${s.started.encounterId}/diagnosis/actions/confirm`,
        { expectedDraftVersion: diagnosis.draftVersion },
        s.doctor,
        randomUUID(),
        { [encounter]: '6' },
      )
    ).json(),
  ).data
  const prescription = prescriptionDraftResponseSchema.parse(
    await put(
      'prescription/draft',
      {
        items: [
          {
            catalogItemId: 'medication-oseltamivir',
            courseDays: 5,
            doseText: '75 mg',
            frequencyCode: 'BID',
            quantity: 10,
          },
        ],
        expectedDraftVersion: 0,
      },
      confirmed.encounterVersion,
    ),
  ).data
  const issuedResponse = await s.write(
    `/api/his/v1/encounters/${s.started.encounterId}/prescription/actions/issue`,
    { expectedDraftVersion: prescription.draftVersion },
    s.doctor,
    randomUUID(),
    { [encounter]: confirmed.encounterVersion },
  )
  expect(issuedResponse.status, await issuedResponse.clone().text()).toBe(200)
  const signed = issuePrescriptionResponseSchema.parse(await issuedResponse.json()).data
  return signed
}

async function completeMedicationEncounter(s: Awaited<ReturnType<typeof setup>>) {
  const detail = doctorCaseDetailSchema.parse(await (await s.runtime.app.request(`/api/his/v1/doctor/cases/${s.target.id}`, { headers: { cookie: s.doctor } })).json())
  const expected = { [`Encounter/${s.started.encounterId}`]: detail.encounter.versionId }
  const path = `/api/his/v1/encounters/${s.started.encounterId}`
  const draftResponse = await s.runtime.app.request(path + '/clinical-document/draft', {
    method: 'PUT', headers: { cookie: s.doctor, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: expected, input: { expectedDraftVersion: 0, document: {
      assessment: '合成流感诊断依据完整。', chiefComplaint: '合成发热伴咽痛一天。', disposition: '门诊抗病毒治疗。',
      followUp: '持续发热或气促时复诊。', historyOfPresentIllness: '一天前开始发热咽痛，无呼吸困难。', physicalExamination: '神志清楚，咽部充血，双肺呼吸音清。',
    } } }),
  })
  expect(draftResponse.status, await draftResponse.clone().text()).toBe(200)
  const draft = clinicalDocumentDraftResponseSchema.parse(await draftResponse.json()).data
  const preview = clinicalDocumentSignPreviewResponseSchema.parse(await (await s.write(path + '/clinical-document/actions/preview-sign', {
    expectedDraftVersion: draft.draftVersion,
  }, s.doctor, randomUUID(), expected)).json()).data
  const signed = await s.write(path + '/clinical-document/actions/sign', { previewId: preview.previewId, commitToken: preview.commitToken }, s.doctor, randomUUID(), expected)
  expect(signed.status, await signed.clone().text()).toBe(200)
  clinicalDocumentSignResponseSchema.parse(await signed.json())
  const completed = await s.write(path + '/actions/complete', {}, s.doctor, randomUUID(), expected)
  expect(completed.status, await completed.clone().text()).toBe(200)
  encounterCompletionResponseSchema.parse(await completed.json())
}

it('未完诊处方即使可由个人账户全额覆盖，也拒绝医保预览且不进入药房', async () => {
  const s = await setup(0), path = `/api/his/v1/insurance/outpatient/${s.target.id}`
  await settle(s)
  s.runtime.database.driver.prepare("UPDATE outpatient_catalog SET price_fen=100 WHERE item_id='medication-oseltamivir'").run()
  const signed = await issueMedication(s)
  const read = async () => insuranceStateSchema.parse(await (await s.runtime.app.request(path, { headers: { cookie: s.cashier } })).json())
  const before = await read()
  const response = await s.write(path + '/preview', { planCode: 'employee-v1' })
  expect(response.status, await response.clone().text()).toBe(409)
  expect(await response.json()).toMatchObject({ error: { code: 'INSURANCE_FUNDS_CONFLICT' } })
  expect(await read()).toEqual(before)
  const queue = pharmacyQueueSchema.parse(await (await s.runtime.app.request('/api/his/v1/pharmacy/queue?status=pending&pageSize=20', { headers: { cookie: await signIn(s.runtime, 'pharmacist@demo.clinmesh.local', 'Synthetic-Demo-Password-2026!') } })).json())
  expect(queue.items.some(item => item.prescriptionId === signed.prescription.id)).toBe(false)
}, 60000)

it('零基金和账户支付的处方须先撤销待遇，补偿年度累计后才能撤方', async () => {
  const s = await setup(0), path = `/api/his/v1/insurance/outpatient/${s.target.id}`
  const settleResident = async () => {
    const preview = insurancePreviewResponseSchema.parse(await (await s.write(path + '/preview', { planCode: 'resident-v1' })).json()).data
    const response = await s.write(path + '/confirm', { previewId: preview.previewId, commitToken: preview.commitToken })
    expect(response.status, await response.clone().text()).toBe(200)
    return insuranceResponseSchema.parse(await response.json()).data
  }
  await settleResident()
  s.runtime.database.driver.prepare("UPDATE outpatient_catalog SET price_fen=100 WHERE item_id='medication-oseltamivir'").run()
  const signed = await issueMedication(s)
  await completeMedicationEncounter(s)
  const before = await settleResident()
  expect(before.active).toMatchObject({ fundFen: 0, accountFen: 0, eligibleFen: 800 })
  expect(before.balance.eligibleFen).toBe(800)
  const readBill = async () => billingCaseSchema.parse(await (await s.runtime.app.request(`/api/his/v1/billing/cases/${s.target.id}`, { headers: { cookie: s.cashier } })).json())
  const readInsurance = async () => insuranceStateSchema.parse(await (await s.runtime.app.request(path, { headers: { cookie: s.cashier } })).json())
  const withdraw = () => s.write(`/api/his/v1/prescriptions/${signed.prescription.id}/actions/withdraw`, {
    expectedPrescriptionVersion: signed.prescription.version,
  }, s.doctor, randomUUID(), Object.fromEntries(signed.prescription.items.map(item => [
    `MedicationRequest/${item.medicationRequestId}`, item.medicationRequestVersion,
  ])))
  const originalBill = await readBill()
  const denied = await withdraw()
  expect(denied.status, await denied.clone().text()).toBe(409)
  expect(await denied.json()).toMatchObject({ error: { code: 'WORKFLOW_CONFLICT' } })
  expect(await readBill()).toEqual(originalBill)
  expect(await readInsurance()).toEqual(before)
  const cancel = { settlementId: before.active!.id, expectedBalanceVersion: before.balance.version }, cancelKey = randomUUID()
  const cancelledResponse = await s.write(path + '/cancel', cancel, s.cashier, cancelKey)
  expect(cancelledResponse.status, await cancelledResponse.clone().text()).toBe(200)
  const cancelled = insuranceResponseSchema.parse(await cancelledResponse.json()).data
  expect(cancelled.balance.eligibleFen).toBe(0)
  expect(cancelled.history.filter(item => item.reversesId === before.active!.id)).toHaveLength(1)
  expect((await s.write(path + '/cancel', cancel, s.cashier, cancelKey)).status).toBe(200)
  const withdrawn = await withdraw()
  expect(withdrawn.status, await withdrawn.clone().text()).toBe(200)
  expect(withdrawPrescriptionResponseSchema.parse(await withdrawn.json()).data.status).toBe('withdrawn')
  expect((await readBill()).charges.filter(row => row.category === 'medication')).toEqual([])
  const after = await readInsurance()
  expect(after.balance.eligibleFen).toBe(0)
  expect(after.history).toEqual(cancelled.history)
  expect(after.activeSettlements.some(item => item.id === before.active!.id)).toBe(false)
}, 60000)

it('检验已收患者额后新增处方可继续结算，原检验待遇仍有效', async () => {
  const s = await setup()
  const first = await settle(s)
  await pay(s, 'laboratory')
  const signed = await issueMedication(s)
  await completeMedicationEncounter(s)
  const second = await settle(s)
  expect(second.activeSettlements).toHaveLength(2)
  expect(second.active?.source.charges.map((row) => row.coverage.code)).toEqual([
    `synthetic-op-medication:Prescription/${signed.prescription.id}`,
  ])
  const bill = billingCaseSchema.parse(
    await (
      await s.runtime.app.request(`/api/his/v1/billing/cases/${s.target.id}`, {
        headers: { cookie: s.cashier },
      })
    ).json(),
  )
  expect(bill.charges.find((row) => row.chargeItemId === s.order.chargeItemId)).toMatchObject({
    remainingFen: 0,
    insuranceFen: first.active!.fundFen + first.active!.accountFen,
    paidFen: 1216,
  })
}, 60000)

it('个人账户全覆盖放行后可撤销并补收，不重复临床放行', async () => {
  const s = await setup(1000),
    state = await settle(s),
    path = `/api/his/v1/insurance/outpatient/${s.target.id}`
  expect(state.active).toMatchObject({ fundFen: 0, accountFen: 1000 })
  const cancelled = await s.write(path + '/cancel', {
    settlementId: state.active!.id,
    expectedBalanceVersion: state.balance.version,
  })
  expect(cancelled.status, await cancelled.clone().text()).toBe(200)
  await pay(s, 'laboratory')
  expect((await s.runtime.dispatcher.dispatchOnce())?.status).toBe('completed')
  expect(await s.runtime.dispatcher.dispatchOnce()).toBeUndefined()
  const bill = billingCaseSchema.parse(
    await (
      await s.runtime.app.request(`/api/his/v1/billing/cases/${s.target.id}`, {
        headers: { cookie: s.cashier },
      })
    ).json(),
  )
  expect(bill.charges.find((row) => row.chargeItemId === s.order.chargeItemId)).toMatchObject({
    remainingFen: 0,
    paidFen: 1000,
    insuranceFen: 0,
  })
}, 60000)

it.each([
  ['employee-v1', 100000, 2000],
  ['resident-v1', 50000, 0],
] as const)(
  '高额普通门诊明确执行 %s 年度封顶，不用目录外或个人账户补足基金',
  async (planCode, fundFen, accountFen) => {
    const s = await setup(1000000),
      path = `/api/his/v1/insurance/outpatient/${s.target.id}`
    const preview = insurancePreviewResponseSchema.parse(
      await (await s.write(path + '/preview', { planCode })).json(),
    ).data
    expect(preview.settlement).toMatchObject({ fundFen, accountFen, eligibleFen: 900000 })
    expect(
      preview.settlement.allocations.find(
        (row) => row.reference === `ChargeItem/${s.order.chargeItemId}`,
      )?.patientFen,
    ).toBe(1000000 - fundFen - accountFen)
  },
  30000,
)

it('竞争确认只保存一份待遇，旧余额预览失效；跨岗及缺少Origin拒绝且不写待遇', async () => {
  const s = await setup(),
    path = `/api/his/v1/insurance/outpatient/${s.target.id}`
  expect((await s.write(path + '/preview', { planCode: 'employee-v1' }, s.doctor)).status).toBe(403)
  const missingOrigin = await s.runtime.app.request(path + '/preview', {
    method: 'POST',
    headers: {
      cookie: s.cashier,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({ input: { planCode: 'employee-v1' }, expectedVersions: {} }),
  })
  expect(missingOrigin.status).toBe(403)
  const before = insuranceStateSchema.parse(
    await (await s.runtime.app.request(path, { headers: { cookie: s.cashier } })).json(),
  )
  expect(before.history).toHaveLength(0)
  const a = insurancePreviewResponseSchema.parse(
    await (await s.write(path + '/preview', { planCode: 'employee-v1' })).json(),
  ).data
  const b = insurancePreviewResponseSchema.parse(
    await (await s.write(path + '/preview', { planCode: 'employee-v1' })).json(),
  ).data
  const results = await Promise.all(
    [a, b].map((preview) =>
      s.write(path + '/confirm', {
        previewId: preview.previewId,
        commitToken: preview.commitToken,
      }),
    ),
  )
  expect(results.map((row) => row.status).sort()).toEqual([200, 409])
  const state = insuranceStateSchema.parse(
    await (await s.runtime.app.request(path, { headers: { cookie: s.cashier } })).json(),
  )
  expect(state.history).toHaveLength(1)
  expect(state.balance.version).toBe(1)
}, 30000)
