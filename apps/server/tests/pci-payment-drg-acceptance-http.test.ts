import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apiErrorSchema, commandResponseSchema } from '@clinmesh/contracts/his'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientSurgerySchema, inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientDrgPregroupResultSchema } from '@clinmesh/contracts/inpatient-drg'
import { inpatientDrgSimulationSchema, inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgPayerReviewPreviewSchema, inpatientDrgPayerReviewListSchema } from '@clinmesh/contracts/inpatient-drg-payer'
import { inpatientRecordSchema, inpatientRecordResponseSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientDischargeEventsSchema, inpatientDischargeResponseSchema, inpatientPaymentsSchema, inpatientPaymentPreviewResponseSchema,
  inpatientPaymentResponseSchema, inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { insurancePreviewResponseSchema, insuranceResponseSchema } from '@clinmesh/contracts/insurance'
import { inpatientFinancialSchema, inpatientFinancialResponseSchema, inpatientFinancialRefundPreviewResponseSchema } from '@clinmesh/contracts/inpatient-finance'
import { refundResponseSchema } from '@clinmesh/contracts/refunds'
import { createPciPaymentDrgFixture, preparePciPaymentDrgFixture, parsePciResponse, type PciPaymentDrgFixture } from './fixtures/pci-payment-drg.ts'
import { loadDrgRules } from '../src/infrastructure/reference-data/drg-rules-package.ts'
import { groupDrgCase } from '../src/application/drg-grouping.ts'

describe('同一次合成冠心病 PCI 的支付、待遇与 DRG 联合验收', () => {
  let s: PciPaymentDrgFixture
  let prepared: Awaited<ReturnType<typeof preparePciPaymentDrgFixture>>
  let stay: Awaited<ReturnType<PciPaymentDrgFixture['preparePciAdmission']>>
  beforeAll(async () => {
    prepared = await preparePciPaymentDrgFixture()
  })
  beforeAll(async () => {
    s = await createPciPaymentDrgFixture(prepared)
  })
  beforeAll(async () => {
    for (const role of ['registrar', 'inpatient-doctor', 'ward-nurse', 'pharmacist', 'cashier', 'medical-records', 'medical-insurance']) await s.login(role)
    stay = await s.preparePciAdmission()
  })
  afterAll(async () => { await s?.close() })

  it.each([
    ['I50.900', 'FR25'],
    ['J18.900', 'ES45'],
  ])('%s 心衰与肺炎的固定成人输入保持公开对照病组 %s', async (code, drgCode) => {
    const rules = await loadDrgRules(s.drgRulesDirectory)
    const result = groupDrgCase(rules, { diagnoses: [{ code, role: 'main' }], operations: [], gender: 'male', ageYears: 60,
      ageDays: null, birthWeightGrams: null, dischargeMode: 'home', inpatientDays: 3 })
    expect(result).toMatchObject({ status: 'grouped', drgCode })
  })

  it.each([
    ['I50.900', 'FR25', 600000, 'bed-general-2'],
    ['J18.900', 'ES45', 300000, 'bed-general-3'],
  ] as const)('%s 独立 HTTP 入院保持病组 %s 与合成支付参考 %i 分', async (code, drgCode, referenceFen, bedId) => {
    const historical = await s.admitSyntheticCase([code], bedId)
    const pregroup = await s.read('inpatient-doctor', `${historical.path}/drg/pregroup`, inpatientDrgPregroupResultSchema)
    expect(pregroup).toMatchObject({ frozen: false, result: { status: 'grouped', drgCode } })
    const simulation = await parsePciResponse(inpatientDrgSimulationSchema, await s.request('inpatient-doctor', `${historical.path}/drg/simulation`, {}))
    expect(simulation.grouping.formal).toMatchObject({ status: 'grouped', drgCode })
    expect(simulation.paymentReference).toMatchObject({ drgCode, referenceFen, parameterVersion: '2026-demo-3' })
    expect(simulation.grouping.projected).toBeNull()
    expect(simulation.formal.chargesFen).toBe(0)
  })

  it('贯通计划与实际药耗费用、未知资金门禁、归档核定及后续医保更正退款恢复', async () => {
    const path = stay.path
    const planned = await parsePciResponse(inpatientDrgSimulationSchema, await s.request('inpatient-doctor', `${path}/drg/simulation`, {}))
    expect(planned.grouping.formal).toMatchObject({ status: 'grouped', drgCode: 'FR59' })
    expect(planned.grouping.projected).toMatchObject({ status: 'grouped', drgCode: 'FM39' })
    expect(planned.formal.chargesFen).toBe(0)
    expect(planned.committed.items).toMatchObject([{ kind: 'surgery', quantity: 1, estimatedFen: 180000 }])
    expect(planned.reserved.items).toHaveLength(4)
    expect(planned.reserved.items.reduce((sum, item) => sum + item.estimatedFen!, 0)).toBe(126598)
    expect(planned.coverage.estimatedTotalFen).toBe(306598)
    expect(planned.paymentReference).toMatchObject({ drgCode: 'FR59', referenceFen: 400000, parameterVersion: '2026-demo-3' })
    const live = await s.read('inpatient-doctor', `${path}/drg/pregroup`, inpatientDrgPregroupResultSchema)
    expect(live).toMatchObject({ recordRevision: 0, frozen: false, result: { drgCode: 'FR59' } })

    const currentAdmission = await s.read('inpatient-doctor', path, inpatientDetailSchema)
    const otherPlan = (await parsePciResponse(inpatientSurgeryResponseSchema, await s.request('inpatient-doctor', `${path}/surgeries/request`, {
      encounterVersion: currentAdmission.admission.versionId, procedureId: stay.procedure.id, catalogVersion: stay.procedure.version,
      plannedFor: '2026-08-24T16:00:00+08:00', reason: '合成另一个计划不得挪用原PCI预留' }))).data.requests.find(item => item.id !== stay.requestId)!
    const mismatchedReservation = await s.request('inpatient-doctor', `${path}/surgeries/execute`, await s.pciExecutionInput(stay, otherPlan.id))
    expect(mismatchedReservation.status).toBe(409)
    expect(apiErrorSchema.parse(await mismatchedReservation.json()).error.code).toBe('INPATIENT_RESERVATION_CONFLICT')
    expect((await s.read('inpatient-doctor', `${path}/clinical`, inpatientFullClinicalSchema)).charges).toEqual([])
    expect((await s.read('inpatient-doctor', `${path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations).toEqual(stay.reservations)
    const otherReady = (await s.read('inpatient-doctor', `${path}/surgeries`, inpatientSurgerySchema)).requests.find(item => item.id === otherPlan.id)!
    await parsePciResponse(inpatientSurgeryResponseSchema, await s.request('inpatient-doctor', `${path}/surgeries/cancel`, {
      requestId: otherPlan.id, expectedRequestVersion: otherReady.version, note: '取消未实施的合成冲突计划' }))
    const investigations = await s.completePciLaboratories(stay)
    expect(prepared.modelCalls).toBe(0)
    expect(investigations.laboratoryRequests.every(item => item.report?.acknowledgement !== undefined)).toBe(true)
    expect(investigations.laboratoryRequests.flatMap(item => item.report!.results).map(item => [item.code, item.value]).sort()).toEqual([
      ['1742-6', 25], ['1920-8', 24], ['2160-0', 0.9], ['2823-3', 4.2], ['2951-2', 141],
      ['6301-6', 1], ['6690-2', 6.2], ['718-7', 145], ['777-3', 220],
    ])
    const supplied = await s.dispensePciMedications(stay)
    expect(supplied).toHaveLength(5)
    const angiography = await s.executeAngiography(stay)
    await s.confirmMainProcedure(stay, angiography.id)
    const angiographyStage = await parsePciResponse(inpatientDrgSimulationSchema, await s.request('inpatient-doctor', `${path}/drg/simulation`, {}))
    expect(angiographyStage.grouping.formal).toMatchObject({ status: 'grouped', drgCode: 'FM59' })
    expect(angiographyStage.paymentReference).toBeNull()
    expect(angiographyStage.incompleteness.paymentReferenceMissing).toBe(true)
    expect(angiographyStage.grouping.projected).toMatchObject({ status: 'grouped', drgCode: 'FM39' })
    const execution = await s.executePci(stay)
    const dispensed = await parsePciResponse(inpatientDrgSimulationSchema, await s.request('inpatient-doctor', `${path}/drg/simulation`, {}))
    expect(dispensed.formal.chargesFen).toBe(403568)
    expect(dispensed.committed.items, '发药已计费的执行不再重复列为待执行承诺').toEqual([])
    expect(dispensed.coverage.estimatedTotalFen).toBe(403568)
    const clinical = await s.read('inpatient-doctor', `${path}/clinical`, inpatientFullClinicalSchema)
    expect(clinical.charges.filter(charge => charge.kind === 'material')).toHaveLength(4)
    expect(clinical.charges.filter(charge => charge.kind === 'medication')).toHaveLength(5)
    expect(clinical.charges.filter(charge => charge.kind === 'laboratory')).toHaveLength(9)
    expect(clinical.charges.filter(charge => charge.kind === 'surgery')).toHaveLength(2)
    const replaced = await s.read('inpatient-doctor', `${path}/drg/reservations`, inpatientMaterialReservationListSchema)
    expect(replaced.reservations.every(item => item.status === 'replaced' && item.replacedByMaterialUseId !== undefined)).toBe(true)
    const actual = await parsePciResponse(inpatientDrgSimulationSchema, await s.request('inpatient-doctor', `${path}/drg/simulation`, {}))
    expect(actual.reserved.items).toEqual([])
    expect(actual.committed.items).toEqual([])
    expect(actual.formal.chargesFen).toBe(403568)
    expect(actual.coverage.estimatedTotalFen).toBe(403568)
    // 同时有造影和支架时，错误的主操作即使成功分组也不等于正确 PCI 病组。
    expect(actual.grouping.formal).toMatchObject({ status: 'grouped', drgCode: 'FM59' })
    expect(actual.paymentReference).toBeNull()
    await s.confirmMainProcedure(stay, execution.id)

    await s.depart(stay)
    const insurancePath = `/api/his/v1/insurance/inpatient/${stay.admissionId}`
    const insurancePreview = (await parsePciResponse(insurancePreviewResponseSchema,
      await s.request('cashier', `${insurancePath}/preview`, { planCode: 'employee-v1' }, randomUUID(), {}))).data
    const originalInsurance = (await parsePciResponse(insuranceResponseSchema, await s.request('cashier', `${insurancePath}/confirm`, {
      previewId: insurancePreview.previewId, commitToken: insurancePreview.commitToken }, randomUUID(), {}))).data
    expect(originalInsurance.active).toMatchObject({ totalFen: 403568, eligibleFen: 276173, fundFen: 216937, accountFen: 2000, patientFen: 184631 })
    const firstFunds = await s.read('cashier', `${path}/payments`, inpatientPaymentsSchema)
    expect(firstFunds).toMatchObject({ depositFen: 5000, remainingFen: 179631 })
    const money = (await parsePciResponse(inpatientPaymentPreviewResponseSchema, await s.request('cashier', `${path}/payments/preview`, {
      kind: 'supplement', amountFen: 179631, tenders: [{ method: 'cash', amountFen: 10000 }, { method: 'mobile', amountFen: 169631 }], simulatorRule: 'ambiguous' }))).data
    const pendingPayment = (await parsePciResponse(inpatientPaymentResponseSchema, await s.request('cashier', `${path}/payments/confirm`, {
      previewId: money.previewId, commitToken: money.commitToken }))).data
    expect(pendingPayment.outcome).toBe('ambiguous')
    const pendingPreview = await s.read('cashier', `${path}/discharge/preview`, inpatientSettlementPreviewSchema)
    const pendingSettlement = await s.request('cashier', `${path}/discharge/settle`, {
      encounterVersion: pendingPreview.encounterVersion, fingerprint: pendingPreview.fingerprint,
      expectedChargesFen: pendingPreview.chargesFen, expectedBalanceFen: pendingPreview.balanceFen })
    expect(pendingSettlement.status).toBe(409)
    expect(apiErrorSchema.parse(await pendingSettlement.json()).error.code).toBe('INPATIENT_FUNDS_PENDING')
    expect((await s.request('ward-nurse', `${path}/discharge/clear`, { encounterVersion: pendingPreview.encounterVersion, reason: '未知资金不得清床' })).status).toBe(409)
    const firstRecovery = { paymentId: pendingPayment.paymentId, expectedPaymentVersion: pendingPayment.version }, firstRecoveryKey = randomUUID()
    const recoveredPayment = await parsePciResponse(inpatientPaymentResponseSchema, await s.request('cashier', `${path}/payments/recover`, firstRecovery, firstRecoveryKey))
    expect(recoveredPayment.data).toMatchObject({ paymentId: pendingPayment.paymentId, outcome: 'success', version: 2 })
    expect(await parsePciResponse(inpatientPaymentResponseSchema, await s.request('cashier', `${path}/payments/recover`, firstRecovery, firstRecoveryKey))).toEqual(recoveredPayment)
    const ready = await s.read('cashier', `${path}/discharge/preview`, inpatientSettlementPreviewSchema)
    const firstSettlement = (await parsePciResponse(inpatientSettlementResponseSchema, await s.request('cashier', `${path}/discharge/settle`, {
      encounterVersion: ready.encounterVersion, fingerprint: ready.fingerprint, expectedChargesFen: ready.chargesFen, expectedBalanceFen: ready.balanceFen }))).data
    await parsePciResponse(inpatientDischargeResponseSchema, await s.request('ward-nurse', `${path}/discharge/clear`, {
      encounterVersion: firstSettlement.encounterVersion, reason: '原资金确定后清床' }))

    const draft = await s.read('inpatient-doctor', `${path}/record`, inpatientRecordSchema)
    await parsePciResponse(inpatientRecordResponseSchema, await s.request('inpatient-doctor', `${path}/record/submit`, {
      expectedRevision: 2, expectedSourcesHash: draft.sourcesHash, mainProcedureExecutionId: execution.id }))
    const submitted = await s.read('medical-records', `${path}/record`, inpatientRecordSchema)
    expect(submitted.snapshot.clinical.mainProcedureExecutionId).toBe(execution.id)
    const selected = await parsePciResponse(inpatientDrgSimulationSchema, await s.request('inpatient-doctor', `${path}/drg/simulation`, {}))
    expect(selected.grouping.formal).toMatchObject({ status: 'grouped', drgCode: 'FM39' })
    expect(selected.paymentReference).toMatchObject({ drgCode: 'FM39', referenceFen: 1200000, parameterSetId: 'clinmesh-synthetic-pci-payment', parameterVersion: '2026-10-25.r1' })
    await parsePciResponse(inpatientRecordResponseSchema, await s.request('medical-records', `${path}/record/review`, {
      expectedRevision: 3, expectedSourcesHash: submitted.sourcesHash, outcome: 'approved', reason: '合成冠心病PCI实际手术编码核对' }))
    const reviewed = await s.read('medical-records', `${path}/record`, inpatientRecordSchema)
    const archived = (await parsePciResponse(inpatientRecordResponseSchema, await s.request('medical-records', `${path}/record/archive`, {
      expectedRevision: 3, expectedSourcesHash: reviewed.sourcesHash }))).data
    const frozenGrouping = await s.read('medical-insurance', `${path}/drg/pregroup`, inpatientDrgPregroupResultSchema)
    expect(frozenGrouping).toMatchObject({ frozen: true, result: { drgCode: 'FM39' },
      paymentEstimate: { drgCode: 'FM39', referenceFen: 1200000, parameterVersion: '2026-10-25.r1' } })
    const preview = await s.read('medical-insurance', `${path}/drg/payer-review-preview`, inpatientDrgPayerReviewPreviewSchema)
    expect(preview.note).toContain('FM39 权重与基础费率均为合成医院演示参数')
    expect(preview).toMatchObject({ drgCode: 'FM39', simulatedPaymentFen: 1200000, hospitalChargesFen: 403568, differenceFen: 796432,
      paymentEstimate: frozenGrouping.paymentEstimate, estimateDifferenceFen: 0,
      caseSummary: { groupingInput: { diagnoses: [{ code: 'I25.103', role: 'main' }] } } })
    expect(preview.caseSummary.groupingInput.operations).toEqual(expect.arrayContaining([
      { code: '88.5500', primary: false }, { code: '36.0700', primary: true },
    ]))
    expect(preview.caseSummary.operations).toHaveLength(2)
    const payer = (await parsePciResponse(commandResponseSchema(inpatientDrgPayerReviewListSchema), await s.request('medical-insurance', `${path}/drg/payer-review`, {
      encounterVersion: preview.encounterVersion, expectedFingerprint: preview.fingerprint, reason: '合成医保办PCI差异复核' }))).data
    expect(payer.reviews).toHaveLength(1)
    expect(payer.reviews[0]).toMatchObject({ drgCode: 'FM39', simulatedPaymentFen: 1200000, archiveSourcesHash: archived.archive!.sourcesHash,
      parameterSetId: preview.parameterSetId, parameterVersion: preview.parameterVersion, note: preview.note })
    const clinicalFrozen = await s.read('inpatient-doctor', `${path}/clinical`, inpatientFullClinicalSchema)
    const departureFrozen = await s.read('ward-nurse', `${path}/discharge`, inpatientDischargeEventsSchema)
    const clearedAdmission = await s.read('medical-records', path, inpatientDetailSchema)

    const before = await s.read('cashier', `${path}/financial-adjustments`, inpatientFinancialSchema)
    const materialCharge = clinical.charges.find(charge => charge.kind === 'material')!
    const adjusted = (await parsePciResponse(inpatientFinancialResponseSchema, await s.request('cashier', `${path}/financial-adjustments`, {
      chargeId: materialCharge.id, direction: 'decrease', amountFen: 1000, expectedFingerprint: before.fingerprint, reason: '合成PCI原耗材费用关联更正' }))).data
    const adjustmentId = adjusted.adjustments[0]!.adjustmentId, cycle = `${path}/financial-adjustments/${adjustmentId}/insurance`
    const compensated = (await parsePciResponse(inpatientFinancialResponseSchema, await s.request('cashier', `${cycle}/cancel`, {
      settlementId: originalInsurance.active!.id, expectedBalanceVersion: adjusted.insurance!.balance.version, expectedFingerprint: adjusted.fingerprint }))).data
    const replacement = (await parsePciResponse(insurancePreviewResponseSchema, await s.request('cashier', `${cycle}/preview`, {
      expectedFingerprint: compensated.fingerprint }))).data
    const replacementBill = (await parsePciResponse(inpatientFinancialResponseSchema, await s.request('cashier', `${cycle}/confirm`, {
      previewId: replacement.previewId, commitToken: replacement.commitToken }))).data
    expect(replacementBill).toMatchObject({ currentChargesFen: 402568, currentFundsFen: 184631, remainingRefundFen: 1000, remainingCollectFen: 0 })
    expect(replacementBill.insurance!.cycles[0]).toMatchObject({ adjustmentId, originalSettlementId: originalInsurance.active!.id,
      replacementSettlementId: replacementBill.insurance!.active!.id })
    expect(replacementBill.insurance!.active).toMatchObject({ fundFen: 216937, accountFen: 2000, patientFen: 183631 })
    expect(replacementBill.insurance!.active!.reversesId).toBeUndefined()
    const source = replacementBill.sources.find(item => item.sourceKind === 'inpatient-deposit')!
    const refundPreview = (await parsePciResponse(inpatientFinancialRefundPreviewResponseSchema, await s.request('cashier', `${path}/financial-adjustments/refunds/preview`, {
      adjustmentId, sourceKind: source.sourceKind, sourceId: source.sourceId, amountFen: 1000, expectedFingerprint: replacementBill.fingerprint,
      expectedSourceVersion: source.version, simulatorRule: 'ambiguous' }))).data
    const refundConfirmation = { previewId: refundPreview.previewId, commitToken: refundPreview.commitToken }, refundKey = randomUUID()
    const ambiguousRefund = await parsePciResponse(refundResponseSchema, await s.request('cashier', `${path}/financial-adjustments/refunds/confirm`, refundConfirmation, refundKey))
    expect(ambiguousRefund.data).toMatchObject({ amountFen: 1000, outcome: 'ambiguous', sourceId: source.sourceId })
    expect((await s.read('cashier', `${path}/financial-adjustments`, inpatientFinancialSchema)).adjustments[0]!.status).toBe('unknown')
    await s.restart()
    expect(await parsePciResponse(refundResponseSchema, await s.request('cashier', `${path}/financial-adjustments/refunds/confirm`, refundConfirmation, refundKey))).toEqual(ambiguousRefund)
    const recovery = { refundId: ambiguousRefund.data.refundId, expectedRefundVersion: 1 }, recoveryKey = randomUUID()
    const resolved = await parsePciResponse(refundResponseSchema, await s.request('cashier', `${path}/financial-adjustments/refunds/recover`, recovery, recoveryKey))
    expect(resolved.data).toMatchObject({ refundId: ambiguousRefund.data.refundId, outcome: 'success', version: 2 })
    expect(await parsePciResponse(refundResponseSchema, await s.request('cashier', `${path}/financial-adjustments/refunds/recover`, recovery, recoveryKey))).toEqual(resolved)
    const final = await s.read('cashier', `${path}/financial-adjustments`, inpatientFinancialSchema)
    expect(final).toMatchObject({ status: 'cleared', recordStatus: 'archived', currentChargesFen: 402568, currentFundsFen: 183631,
      remainingRefundFen: 0, remainingCollectFen: 0, reservedFen: 0 })
    expect(final.adjustments[0]!.status).toBe('completed')
    expect(final.refunds).toHaveLength(1)
    expect(final.insurance).toEqual(replacementBill.insurance)
    expect(final.firstSettlement).toEqual(before.firstSettlement)
    expect((await s.read('medical-records', `${path}/record`, inpatientRecordSchema)).archive).toEqual(archived.archive)
    expect(await s.read('medical-insurance', `${path}/drg/pregroup`, inpatientDrgPregroupResultSchema)).toEqual(frozenGrouping)
    expect(await s.read('medical-insurance', `${path}/drg/payer-reviews`, inpatientDrgPayerReviewListSchema)).toEqual(payer)
    const original = await s.read('cashier', `${path}/discharge/preview`, inpatientSettlementPreviewSchema)
    expect(original.insurance).toEqual(firstSettlement.insurance)
    expect(original.transactions).toEqual(firstSettlement.transactions)
    expect(original.settlement).toEqual(firstSettlement.settlement)
    expect(await s.read('inpatient-doctor', `${path}/clinical`, inpatientFullClinicalSchema)).toEqual(clinicalFrozen)
    expect(await s.read('ward-nurse', `${path}/discharge`, inpatientDischargeEventsSchema)).toEqual(departureFrozen)
    expect(await s.read('medical-records', path, inpatientDetailSchema)).toEqual(clearedAdmission)
  })
})
