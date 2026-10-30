import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { apiErrorSchema, billingCaseSchema, doctorQueueSchema, firstVisitDraftResponseSchema, laboratoryOrderResponseSchema,
  paymentPreviewResponseSchema, paymentResponseSchema, registrationResponseSchema, scenarioStateSchema, triageResponseSchema } from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { inpatientCommandResponseSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDischargeResponseSchema, inpatientPaymentPreviewResponseSchema, inpatientPaymentResponseSchema,
  inpatientPaymentsSchema, inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { insurancePreviewResponseSchema, insuranceResponseSchema } from '@clinmesh/contracts/insurance'
import { inpatientRecordResponseSchema, inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { runDatabaseCli } from '../src/database-cli.ts'
import { openClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { prepareLegacyPaymentCutover } from './fixtures/payment-cutover.ts'
import { createPciPaymentDrgFixture, parsePciResponse, preparePciPaymentDrgFixture, type PciPaymentDrgFixture } from './fixtures/pci-payment-drg.ts'
import { pciGoldenAmounts, pciGoldenLedger } from './fixtures/pci-golden-ledger.ts'

async function prepareOutpatientLaboratory(s: PciPaymentDrgFixture, patientId: string) {
  const registration = (await parsePciResponse(registrationResponseSchema, await s.request('registrar', '/api/his/v1/registrations/actions/register', {
    departmentId: 'department-general-medicine', locationId: 'location-outpatient', patientId, visitDate: '2026-08-24', visitTypeId: 'visit-general',
  }, randomUUID(), { [`Patient/${patientId}`]: '1' }))).data
  const path = `/api/his/v1/encounters/${registration.encounterId}`
  const handoff = (await parsePciResponse(triageResponseSchema, await s.request('triage', `${path}/actions/record-triage`, {
    acuityCode: 'level-3', bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 }, chiefComplaint: '合成发热两天',
    oxygenSaturationPct: 98, pulseBpm: 102, respirationBpm: 20, temperatureC: 38.6,
  }, randomUUID(), { [`Encounter/${registration.encounterId}`]: '1', [`Task/${registration.queueTaskId}`]: '1' }))).data
  const queue = await s.read('doctor', '/api/his/v1/doctor/queue?pageSize=20', doctorQueueSchema)
  const item = queue.items.find(row => row.encounterId === registration.encounterId)!
  expect(item).toBeDefined()
  expect((await s.request('doctor', `${path}/actions/start-first-visit`, {}, randomUUID(), {
    [`Encounter/${registration.encounterId}`]: handoff.encounterVersion, [`Task/${handoff.doctorTaskId}`]: '1',
  })).status).toBe(200)
  const saved = (await parsePciResponse(firstVisitDraftResponseSchema, await s.runtime.app.request(`${path}/drafts/first-visit`, { method: 'PUT',
    headers: { cookie: await s.login('doctor'), origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ input: { assessment: '合成发热待查', expectedDraftVersion: 0, historyOfPresentIllness: '两天前出现发热，伴咽痛。' },
      expectedVersions: { [`Encounter/${registration.encounterId}`]: '3' } }),
  }))).data
  const order = (await parsePciResponse(laboratoryOrderResponseSchema, await s.request('doctor', `${path}/actions/issue-laboratory-order`, {
    catalogItemId: 'lab-fever-panel', expectedDraftVersion: saved.draftVersion, indicationCode: 'fever',
  }, randomUUID(), { [`Encounter/${registration.encounterId}`]: '3', [`Task/${handoff.doctorTaskId}`]: '2' }))).data
  return { caseId: item.caseId, chargeItemId: order.chargeItemId }
}

it('非空旧库显式切换后，从原岗位重建两端资金并联合核对 PCI 冻结与同患者就诊隔离', async () => {
  const prepared = await preparePciPaymentDrgFixture()
  let s: PciPaymentDrgFixture | undefined
  try {
    const historical = await prepareLegacyPaymentCutover(prepared)
    const old = openClinMeshDatabase({ databasePath: prepared.options.databasePath, busyTimeoutMs: 5000 })
    try {
      expect(old.driver.prepare('SELECT amount_fen,outcome FROM payment_transaction').all()).toEqual([{ amount_fen: 6800, outcome: 'success' }])
      expect(old.driver.prepare('SELECT status,financial_status,record_status FROM inpatient_admission').all())
        .toEqual([{ status: 'cleared', financial_status: 'settled', record_status: 'archived' }])
      expect(old.driver.prepare('SELECT COUNT(*) AS count FROM inpatient_record_archive').get()).toEqual({ count: 1 })
      expect(old.driver.prepare('SELECT operation FROM command_receipt WHERE idempotency_key=?').get(historical.start.key))
        .toEqual({ operation: 'synthetic-case.start-outpatient-visit' })
      expect(old.driver.pragma('foreign_key_check')).toEqual([])
    } finally { old.close() }
    await runDatabaseCli(['payment-cutover', '--database', prepared.options.databasePath,
      '--backup', join(prepared.directory, 'before-payment-cutover.sqlite'), '--confirm', 'discard-synthetic-runtime'], {})
    s = await createPciPaymentDrgFixture(prepared)
    const current = await s.read('admin', '/api/sim/v1/scenario-runs/current', scenarioStateSchema)
    expect(current.epoch).not.toBe('epoch-1')
    const oldBill = await s.request('cashier', `/api/his/v1/billing/cases/${historical.legacy.outpatientCaseId}`)
    expect(oldBill.status).toBe(409)
    expect(apiErrorSchema.parse(await oldBill.json()).error.code).toBe('WORKFLOW_CONFLICT')
    expect((await s.request('registrar', `/api/his/v1/inpatient/admissions/${historical.legacy.admissionId}`)).status).toBe(404)
    const staleStart = await s.runtime.app.request(`/api/his/v1/synthetic-cases/${historical.source.case.caseId}/actions/start-outpatient-visit`, {
      method: 'POST', headers: { cookie: await s.login('registrar'), origin: 'http://localhost',
        'content-type': 'application/json', 'idempotency-key': historical.start.key }, body: JSON.stringify(historical.start.request),
    })
    expect(staleStart.status).toBe(409)
    expect(apiErrorSchema.parse(await staleStart.json()).error.code).toBe('WORKFLOW_CONFLICT')

    const stay = await s.preparePciAdmission()
    expect(stay.sourceCaseId).toBe(historical.source.case.caseId)
    expect(stay.patientId).not.toBe(historical.legacy.patientId)
    expect(await s.read('cashier', `${stay.path}/payments`, inpatientPaymentsSchema))
      .toMatchObject({ depositFen: 5000, supplementFen: 0, pendingCount: 0 })
    const outpatient = await prepareOutpatientLaboratory(s, stay.patientId)
    const outpatientPay = async (amountFen: number, rule: string, method: 'cash' | 'mobile', version: string) => {
      const versions = { [`ChargeItem/${outpatient.chargeItemId}`]: version }
      const preview = (await parsePciResponse(paymentPreviewResponseSchema, await s!.request('cashier', '/api/his/v1/payments/actions/preview', {
        caseId: outpatient.caseId, chargeItemId: outpatient.chargeItemId, category: 'laboratory', amountFen,
        simulatorRule: rule, tenders: [{ method, amountFen }],
      }, randomUUID(), versions))).data
      const key = randomUUID()
      const result = await parsePciResponse(paymentResponseSchema, await s!.request('cashier', `/api/his/v1/payments/${preview.previewId}/actions/confirm`,
        { commitToken: preview.commitToken }, key, versions))
      return { result, key }
    }
    const partial = await outpatientPay(1000, 'success', 'cash', '1')
    const pendingOutpatient = await outpatientPay(5800, 'ambiguous', 'mobile', '2')
    expect(pendingOutpatient.result.data.outcome).toBe('ambiguous')
    const next = (await parsePciResponse(inpatientCommandResponseSchema, await s.request('registrar', '/api/his/v1/inpatient/admissions', {
      expectedEpoch: current.epoch, patientId: stay.patientId, patientVersion: '1', admissionRoute: 'direct', wardId: 'ward-general', depositFen: 700,
    }))).data.admission
    const nextPath = `/api/his/v1/inpatient/admissions/${next.id}`
    expect(await s.read('cashier', `${nextPath}/payments`, inpatientPaymentsSchema)).toMatchObject({ depositFen: 700, supplementFen: 0 })
    expect(await s.read('cashier', `${stay.path}/payments`, inpatientPaymentsSchema)).toMatchObject({ depositFen: 5000, supplementFen: 0 })

    await s.completePciLaboratories(stay)
    await s.dispensePciMedications(stay, 'preoperative')
    await s.executeAngiography(stay)
    const execution = await s.executePci(stay)
    await s.dispensePostoperativePciAspirin(stay, execution.id)
    await s.confirmMainProcedure(stay, execution.id)
    const clinical = await s.read('inpatient-doctor', `${stay.path}/clinical`, inpatientFullClinicalSchema)
    expect(clinical.charges).toHaveLength(pciGoldenLedger.length)
    expect(clinical.charges.reduce((sum, row) => sum + row.amountFen, 0)).toBe(pciGoldenAmounts.chargesFen)
    for (const expected of pciGoldenLedger) expect(clinical.charges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: expected.kind, label: expect.stringContaining(expected.label), amountFen: expected.quantity * expected.unitPriceFen }),
    ]))
    expect(prepared.modelCalls).toBe(0)
    await s.depart(stay)
    const insurancePath = `/api/his/v1/insurance/inpatient/${stay.admissionId}`
    const insurancePreview = (await parsePciResponse(insurancePreviewResponseSchema, await s.request('cashier', `${insurancePath}/preview`, {
      planCode: 'employee-v1',
    }, randomUUID(), {}))).data
    const insurance = (await parsePciResponse(insuranceResponseSchema, await s.request('cashier', `${insurancePath}/confirm`, {
      previewId: insurancePreview.previewId, commitToken: insurancePreview.commitToken,
    }, randomUUID(), {}))).data
    expect(insurance.active).toMatchObject({ totalFen: pciGoldenAmounts.chargesFen, fundFen: pciGoldenAmounts.fundFen,
      accountFen: pciGoldenAmounts.accountFen, patientFen: pciGoldenAmounts.patientFen })
    expect(await s.read('cashier', `${stay.path}/payments`, inpatientPaymentsSchema))
      .toMatchObject({ depositFen: 5000, remainingFen: pciGoldenAmounts.supplementFen })
    const reviewed = (await parsePciResponse(inpatientPaymentPreviewResponseSchema, await s.request('cashier', `${stay.path}/payments/preview`, {
      kind: 'supplement', amountFen: pciGoldenAmounts.supplementFen,
      tenders: [{ method: 'cash', amountFen: 10000 }, { method: 'mobile', amountFen: 169645 }], simulatorRule: 'ambiguous',
    }))).data
    const key = randomUUID(), confirmation = { previewId: reviewed.previewId, commitToken: reviewed.commitToken }
    const pending = await parsePciResponse(inpatientPaymentResponseSchema, await s.request('cashier', `${stay.path}/payments/confirm`, confirmation, key))
    expect(pending.data.outcome).toBe('ambiguous')
    const blocked = await s.read('cashier', `${stay.path}/discharge/preview`, inpatientSettlementPreviewSchema)
    const refused = await s.request('cashier', `${stay.path}/discharge/settle`, { encounterVersion: blocked.encounterVersion,
      fingerprint: blocked.fingerprint, expectedChargesFen: blocked.chargesFen, expectedBalanceFen: blocked.balanceFen })
    expect(refused.status).toBe(409)
    expect(apiErrorSchema.parse(await refused.json()).error.code).toBe('INPATIENT_FUNDS_PENDING')
    expect((await s.request('ward-nurse', `${stay.path}/discharge/clear`, { encounterVersion: blocked.encounterVersion, reason: '合成未知资金应阻断清床' })).status).toBe(409)
    await s.restart()
    const receipt = await s.read('cashier', `/api/his/v1/command-receipts?operationId=inpatient.payment.confirm&idempotencyKey=${key}`, commandReceiptLookupSchema)
    expect(inpatientPaymentResponseSchema.parse(receipt.response)).toEqual(pending)
    expect(await parsePciResponse(inpatientPaymentResponseSchema, await s.request('cashier', `${stay.path}/payments/confirm`, confirmation, key))).toEqual(pending)
    expect(await s.read('cashier', `${stay.path}/payments`, inpatientPaymentsSchema))
      .toMatchObject({ pendingCount: 1, remainingFen: pciGoldenAmounts.supplementFen })
    expect((await s.request('cashier', `${nextPath}/payments/recover`, { paymentId: pending.data.paymentId, expectedPaymentVersion: 1 })).status).toBe(409)
    expect((await s.request('cashier', `${stay.path}/payments/recover`, { paymentId: pendingOutpatient.result.data.paymentId, expectedPaymentVersion: 1 })).status).toBe(409)
    expect((await s.request('cashier', `${nextPath}/refunds/preview`, { sourceId: pending.data.paymentId, amountFen: 1, simulatorRule: 'success' })).status).toBe(409)
    await parsePciResponse(paymentResponseSchema, await s.request('cashier', `/api/his/v1/payments/${pendingOutpatient.result.data.paymentId}/actions/recover`, {
      expectedPaymentVersion: 1,
    }, randomUUID(), { [`ChargeItem/${outpatient.chargeItemId}`]: '3' }))
    const bill = await s.read('cashier', `/api/his/v1/billing/cases/${outpatient.caseId}`, billingCaseSchema)
    expect(bill).toMatchObject({ paidFen: 6800, payments: [
      expect.objectContaining({ paymentId: pendingOutpatient.result.data.paymentId, outcome: 'success' }),
      expect.objectContaining({ paymentId: partial.result.data.paymentId, outcome: 'success' }),
    ] })
    expect(await s.read('cashier', `${stay.path}/payments`, inpatientPaymentsSchema)).toMatchObject({ pendingCount: 1, supplementFen: 0 })
    await parsePciResponse(inpatientPaymentResponseSchema, await s.request('cashier', `${stay.path}/payments/recover`, {
      paymentId: pending.data.paymentId, expectedPaymentVersion: 1,
    }))
    const funded = await s.read('cashier', `${stay.path}/payments`, inpatientPaymentsSchema)
    expect(funded).toMatchObject({ depositFen: 5000, supplementFen: 179645, remainingFen: 0, pendingCount: 0 })
    expect(funded.sources.reduce((sum, source) => sum + source.amountFen, 0)).toBe(pciGoldenAmounts.patientFen)
    expect(await s.read('cashier', `${nextPath}/payments`, inpatientPaymentsSchema)).toMatchObject({ depositFen: 700, supplementFen: 0 })
    const ready = await s.read('cashier', `${stay.path}/discharge/preview`, inpatientSettlementPreviewSchema)
    const settled = (await parsePciResponse(inpatientSettlementResponseSchema, await s.request('cashier', `${stay.path}/discharge/settle`, {
      encounterVersion: ready.encounterVersion, fingerprint: ready.fingerprint, expectedChargesFen: ready.chargesFen, expectedBalanceFen: ready.balanceFen,
    }))).data
    await parsePciResponse(inpatientDischargeResponseSchema, await s.request('ward-nurse', `${stay.path}/discharge/clear`, {
      encounterVersion: settled.encounterVersion, reason: '合成查询原款确认后清床',
    }))
    const draft = await s.read('inpatient-doctor', `${stay.path}/record`, inpatientRecordSchema)
    await parsePciResponse(inpatientRecordResponseSchema, await s.request('inpatient-doctor', `${stay.path}/record/submit`, {
      expectedRevision: draft.revision?.revision ?? 0, expectedSourcesHash: draft.sourcesHash, mainProcedureExecutionId: execution.id,
    }))
    const submitted = await s.read('medical-records', `${stay.path}/record`, inpatientRecordSchema)
    await parsePciResponse(inpatientRecordResponseSchema, await s.request('medical-records', `${stay.path}/record/review`, {
      expectedRevision: submitted.revision!.revision, expectedSourcesHash: submitted.sourcesHash, outcome: 'approved', reason: '合成切换后 PCI 病案核对',
    }))
    const checked = await s.read('medical-records', `${stay.path}/record`, inpatientRecordSchema)
    const archived = (await parsePciResponse(inpatientRecordResponseSchema, await s.request('medical-records', `${stay.path}/record/archive`, {
      expectedRevision: checked.revision!.revision, expectedSourcesHash: checked.sourcesHash,
    }))).data
    expect(archived.archive).not.toBeNull()
    const frozen = await s.read('medical-records', stay.path, inpatientDetailSchema)
    expect(frozen.admission).toMatchObject({ status: 'cleared', financialStatus: 'settled', recordStatus: 'archived' })
    const grouping = await parsePciResponse(inpatientDrgSimulationSchema, await s.request('inpatient-doctor', `${stay.path}/drg/simulation`, {}))
    expect(grouping.grouping.formal).toMatchObject({ drgCode: 'FM39' })
    await s.restart()
    expect((await s.read('medical-records', `${stay.path}/record`, inpatientRecordSchema)).archive).toEqual(archived.archive)
    expect(await s.read('cashier', `${stay.path}/payments`, inpatientPaymentsSchema)).toEqual(funded)
    expect((await s.read('cashier', `/api/his/v1/billing/cases/${outpatient.caseId}`, billingCaseSchema)).payments).toEqual(bill.payments)
  } finally {
    if (s === undefined) await rm(prepared.directory, { recursive: true, force: true })
    else await s.close()
  }
}, 60_000)
