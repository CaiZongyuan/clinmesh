import { expect, type Page } from '@playwright/test'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgPregroupResultSchema } from '@clinmesh/contracts/inpatient-drg'
import { inpatientDrgPayerReviewListSchema } from '@clinmesh/contracts/inpatient-drg-payer'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientPaymentsSchema, inpatientSettlementPreviewSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientFinancialSchema } from '@clinmesh/contracts/inpatient-finance'
import type { PciBrowserApp } from './inpatient-pci.fixture.ts'
import { executePciMedicationThroughPages, type OpenPciPatient } from './inpatient-pci-preparation.journey.ts'
import { pciGoldenAmounts, pciGoldenLedger } from '../../server/tests/fixtures/pci-golden-ledger.ts'

/** Shared production-workspace journey; fixture setup uses public Commands and synthetic providers. */
export async function runPciBrowserJourney(page: Page, app: PciBrowserApp, open: OpenPciPatient,
  preparedStay?: Awaited<ReturnType<PciBrowserApp['fixture']['preparePciAdmission']>>) {
  const s = app.fixture
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const stay = preparedStay ?? await s.preparePciAdmission()
  // Surface contracts isolate the production inpatient workspace; Web supplies the complete page-created stay.
  if (!preparedStay) {
    await s.completePciLaboratories(stay)
    await s.dispensePciMedications(stay, 'preoperative')
    const angiography = await s.executeAngiography(stay)
    await s.confirmMainProcedure(stay, angiography.id)
  }
  const admission = (await s.read('inpatient-doctor', stay.path, inpatientDetailSchema)).admission
  const planned = (await s.read('inpatient-doctor', `${stay.path}/surgeries`, inpatientSurgerySchema)).requests.find(item => item.id === stay.requestId)!
  const stage = (name: string) => page.getByRole('tab', { name, exact: true }).click()
  const readRecord = () => s.read('medical-records', `${stay.path}/record`, inpatientRecordSchema)
  const readGrouping = () => s.read('medical-insurance', `${stay.path}/drg/pregroup`, inpatientDrgPregroupResultSchema)
  const readBill = () => s.read('cashier', `${stay.path}/financial-adjustments`, inpatientFinancialSchema)

  await open('inpatient-doctor', admission.patientName)
  await stage('DRG 与费用推演')
  const drg = page.getByRole('region', { name: 'DRG 与费用推演', exact: true })
  await expect(drg.getByRole('region', { name: '正式事实分组', exact: true })).toContainText('FM59')
  await expect(drg.getByRole('region', { name: '若计划手术实施', exact: true })).toContainText('FM39')

  await open('ward-nurse', admission.patientName)
  await stage('手术')
  const surgeryPlan = () => page.getByRole('region', { name: '住院手术', exact: true }).locator('article').filter({ hasText: planned.reason })
  await surgeryPlan().getByLabel('手术记录说明', { exact: true }).fill('合成PCI检验结果及术前核对完成')
  await surgeryPlan().getByRole('button', { name: '核对术前检查', exact: true }).click()
  await expect(surgeryPlan()).toContainText('术前检查：已核对')

  await open('inpatient-doctor', admission.patientName)
  await stage('手术')
  await surgeryPlan().getByLabel('手术记录说明', { exact: true }).fill('合成PCI知情同意已签署并完成支架植入')
  await surgeryPlan().getByRole('button', { name: '确认知情同意已签署', exact: true }).click()
  await expect(surgeryPlan()).toContainText('已就绪')
  await surgeryPlan().getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: `${stay.procedure.coding.code} · ${stay.procedure.coding.display}`, exact: true }).click()
  for (const reservation of stay.reservations) {
    await surgeryPlan().getByLabel('手术耗材', { exact: true }).click()
    await page.getByRole('option', { name: reservation.materialDisplay, exact: true }).click()
    const replacement = surgeryPlan().getByLabel(`${reservation.materialDisplay}实际用量`, { exact: true }).locator('..').getByLabel('替换治疗预留', { exact: true })
    await replacement.click()
    await page.getByRole('option', { name: `${reservation.materialDisplay} × ${reservation.quantity} · ${reservation.reason}`, exact: true }).click()
  }
  let executionPosts = 0
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`${stay.path}/surgeries/execute`)) executionPosts++ })
  await surgeryPlan().getByRole('button', { name: '记录实际手术', exact: true }).click()
  await expect(surgeryPlan()).toContainText('已实施')
  const surgery = await s.read('inpatient-doctor', `${stay.path}/surgeries`, inpatientSurgerySchema)
  const pci = surgery.executions.find(item => item.requestId === stay.requestId)!
  expect(pci.actualProcedure.coding.code).toBe('36.0700')
  expect(pci.materials).toHaveLength(4)
  expect(executionPosts).toBe(1)
  const reservations = await s.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
  expect(reservations.reservations.every(item => item.status === 'replaced' && item.replacedByMaterialUseId !== undefined)).toBe(true)
  await executePciMedicationThroughPages(page, app, open, stay, ['aspirin'], pci.id)
  const clinical = await s.read('inpatient-doctor', `${stay.path}/clinical`, inpatientFullClinicalSchema)
  expect(clinical.charges.filter(item => item.kind === 'material')).toHaveLength(4)
  expect(clinical.charges.filter(item => item.kind === 'medication')).toHaveLength(6)
  expect(clinical.chargesFen).toBe(403618)
  const unmatched = [...clinical.charges]
  for (const row of pciGoldenLedger) {
    const index = unmatched.findIndex(item => item.kind === row.kind && item.label.includes(row.label) && item.amountFen === row.quantity * row.unitPriceFen)
    expect(index, `${row.kind}: ${row.label}`).toBeGreaterThanOrEqual(0)
    unmatched.splice(index, 1)
  }
  expect(unmatched).toEqual([])
  await open('inpatient-doctor', admission.patientName)

  const submitPciRecord = async () => {
    const before = await readRecord()
    await stage('病案')
    await page.getByLabel('确认本次主操作', { exact: true }).click()
    await page.getByRole('option', { name: `${stay.procedure.coding.code} · ${stay.procedure.coding.display}`, exact: true }).click()
    await page.getByRole('button', { name: '提交首页修订', exact: true }).click()
    await expect.poll(async () => (await readRecord()).revision?.revision).toBe((before.revision?.revision ?? 0) + 1)
    expect((await readRecord()).snapshot.clinical.mainProcedureExecutionId).toBe(pci.id)
  }
  await submitPciRecord()
  await stage('DRG 与费用推演')
  await expect(drg.getByRole('region', { name: '正式事实分组', exact: true })).toContainText('FM39')
  await expect(drg).toContainText('¥12,000.00')
  await expect(drg).toContainText('¥4,036.18')
  await stage('出院结算')
  await page.getByLabel('出院处理说明', { exact: true }).fill('合成PCI临床治疗完成')
  await page.getByRole('button', { name: '开出院医嘱', exact: true }).click()
  await expect.poll(async () => (await s.read('ward-nurse', stay.path, inpatientDetailSchema)).admission.status).toBe('discharge-pending')
  await open('ward-nurse', admission.patientName)
  await stage('出院结算')
  await page.getByLabel('出院处理说明', { exact: true }).fill('合成PCI出区核对完成')
  await page.getByLabel('离院方式', { exact: true }).click()
  await page.getByRole('option', { name: '医嘱离院', exact: true }).click()
  await page.getByRole('button', { name: '办理出区', exact: true }).click()
  await expect.poll(async () => (await s.read('cashier', stay.path, inpatientDetailSchema)).admission.status).toBe('departed')

  await open('cashier', admission.patientName)
  const insurance = page.getByRole('region', { name: '患者医保待遇', exact: true })
  await insurance.getByRole('button', { name: '患者医保待遇（合成）', exact: true }).click()
  await insurance.getByLabel('固定合成方案', { exact: true }).click()
  await page.getByRole('option', { name: '合成职工 v1', exact: true }).click()
  await insurance.getByRole('button', { name: '预览医保待遇', exact: true }).click()
  await insurance.getByRole('button', { name: '审阅医保结算', exact: true }).click()
  const benefitsReview = page.getByRole('alertdialog', { name: '确认医保结算', exact: true })
  await expect.poll(() => benefitsReview.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return bounds.top >= 0 && bounds.bottom <= window.innerHeight
  })).toBe(true)
  await benefitsReview.getByRole('button', { name: '提交医保结算', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  const funds = await s.read('cashier', `${stay.path}/payments`, inpatientPaymentsSchema)
  expect(funds).toMatchObject({ depositFen: 5000, remainingFen: 179645 })
  const funding = page.getByRole('region', { name: '住院收退款', exact: true })
  await funding.getByRole('button', { name: '出区补缴', exact: true }).click()
  await funding.getByLabel('现金金额（元）', { exact: true }).fill('100')
  await funding.getByLabel('银行卡金额（元）', { exact: true }).fill(((funds.remainingFen - 10000) / 100).toFixed(2))
  await funding.getByRole('button', { name: '未知后查明成功', exact: true }).click()
  await funding.getByRole('button', { name: '预览收款', exact: true }).click()
  await funding.getByRole('button', { name: '确认已审阅收款', exact: true }).click()
  await expect(funding).toContainText('资金结果未知，请查询原尝试')
  const pendingFunds = await s.read('cashier', `${stay.path}/payments`, inpatientPaymentsSchema)
  expect(pendingFunds).toMatchObject({ pendingCount: 1, supplementFen: 0, remainingFen: 179645 })
  const pendingPayment = pendingFunds.payments.find(item => item.outcome === 'ambiguous')!
  await page.getByRole('button', { name: '预览结算', exact: true }).click()
  await expect(page.getByRole('button', { name: '确认结算', exact: true })).toBeDisabled()
  await open('ward-nurse', admission.patientName)
  await stage('出院结算')
  await expect(page.getByRole('button', { name: '清床', exact: true })).toBeDisabled()
  expect((await s.read('ward-nurse', stay.path, inpatientDetailSchema)).admission).toMatchObject({ status: 'departed', financialStatus: 'open' })
  await open('cashier', admission.patientName)
  let recoveries = 0
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`${stay.path}/payments/recover`)) recoveries++ })
  await funding.getByRole('button', { name: '查询原收款', exact: true }).click()
  await expect(funding.getByTestId('inpatient-funding-balance')).toContainText('¥0.00')
  await expect(funding.getByRole('button', { name: '查询原收款', exact: true })).toHaveCount(0)
  const recoveredFunds = await s.read('cashier', `${stay.path}/payments`, inpatientPaymentsSchema)
  expect(recoveredFunds).toMatchObject({ pendingCount: 0, supplementFen: 179645, remainingFen: 0 })
  expect(recoveredFunds.payments.filter(item => item.kind === 'supplement')).toMatchObject([{ paymentId: pendingPayment.paymentId, outcome: 'success', amountFen: 179645 }])
  expect(recoveries).toBe(1)
  await page.getByRole('button', { name: '预览结算', exact: true }).click()
  await expect(page.getByTestId('settlement-net')).toContainText('4,036.18')
  await page.getByRole('button', { name: '确认结算', exact: true }).click()
  await expect(page.getByText('已结算，等待病区清床', { exact: true })).toBeVisible()
  const firstSettlement = await s.read('cashier', `${stay.path}/discharge/preview`, inpatientSettlementPreviewSchema)
  await open('ward-nurse', admission.patientName)
  await stage('出院结算')
  await page.getByLabel('出院处理说明', { exact: true }).fill('合成PCI床单位清洁完成')
  await page.getByRole('button', { name: '清床', exact: true }).click()
  await expect.poll(async () => (await s.read('medical-records', stay.path, inpatientDetailSchema)).admission.status).toBe('cleared')

  await open('inpatient-doctor', admission.patientName)
  await submitPciRecord()
  await open('medical-records', admission.patientName)
  await page.getByLabel('编码审核说明', { exact: true }).fill('合成PCI主诊断、两项实际操作与费用核对')
  await page.getByRole('button', { name: '编码审核通过', exact: true }).click()
  await expect(page.getByRole('button', { name: '归档病案', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '归档病案', exact: true }).click()
  await expect(page.getByText(/病案已归档，只读可查/)).toBeVisible()
  const archived = await readRecord(), frozen = await readGrouping()
  expect(frozen).toMatchObject({ frozen: true, result: { status: 'grouped', drgCode: 'FM39' }, paymentEstimate: { referenceFen: 1200000 } })

  await open('medical-insurance', admission.patientName)
  const payer = page.getByRole('region', { name: '医保办 DRG 复核', exact: true })
  await expect(payer.getByTestId('drg-payer-preview')).toContainText('模拟核定支付 ¥12,000.00')
  await expect(payer.getByTestId('drg-payer-preview')).toContainText('核定减归档预估 ¥0.00')
  await expect(payer.getByTestId('drg-payer-preview')).toContainText('核定与归档费用差额 ¥7,963.82')
  await payer.getByLabel('模拟核定复核说明', { exact: true }).fill('合成PCI归档主操作及医院支付参数复核')
  await payer.getByRole('button', { name: '审阅模拟核定', exact: true }).click()
  const assessment = page.getByRole('alertdialog', { name: '确认 DRG 模拟核定', exact: true })
  await expect(assessment.getByRole('region', { name: '冻结病例与编码来源', exact: true })).toContainText('主操作 36.0700')
  await assessment.getByRole('button', { name: '提交模拟核定', exact: true }).click()
  await expect(assessment).toBeHidden()
  const payerReviews = await s.read('medical-insurance', `${stay.path}/drg/payer-reviews`, inpatientDrgPayerReviewListSchema)
  expect(payerReviews.reviews).toMatchObject([{ drgCode: 'FM39', hospitalChargesFen: 403618, simulatedPaymentFen: 1200000, differenceFen: 796382, estimateDifferenceFen: 0 }])

  await open('cashier', admission.patientName)
  const correction = page.getByRole('region', { name: '后续财务更正', exact: true })
  await correction.getByLabel('更正关联原费用', { exact: true }).click()
  const stentCharge = clinical.charges.find(item => item.kind === 'material' && item.label.includes('支架'))!
  const stentOption = `${stentCharge.label} · ${new Intl.NumberFormat('zh-CN', { currency: 'CNY', style: 'currency' }).format(stentCharge.amountFen / 100)}`
  await page.getByRole('option', { name: stentOption, exact: true }).click()
  await correction.getByLabel('更正金额（元）', { exact: true }).fill('10')
  await correction.getByLabel('财务更正原因', { exact: true }).fill('合成PCI支架费用核对冲减')
  await correction.getByRole('button', { name: '审阅财务更正', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '提交财务更正', exact: true }).click()
  const laterInsurance = correction.getByRole('region', { name: '后续医保更正', exact: true })
  await laterInsurance.getByRole('button', { name: '审阅原待遇补偿', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认补偿原待遇', exact: true }).click()
  await laterInsurance.getByRole('button', { name: '预览更正医保', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认更正待遇', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  const corrected = await readBill()
  expect(corrected.remainingRefundFen).toBe(pciGoldenAmounts.correctionFen)
  const originalDeposit = corrected.sources.find(item => item.sourceKind === 'inpatient-deposit')!
  await correction.getByLabel('退款原交易', { exact: true }).click()
  await page.getByRole('option', { name: `${originalDeposit.sourceId} · ¥50.00`, exact: true }).click()
  await correction.getByLabel('本次收退金额（元）', { exact: true }).fill((corrected.remainingRefundFen / 100).toFixed(2))
  await correction.getByRole('button', { name: '预览后续退款', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认本次收退', exact: true }).click()
  await expect(correction.getByText('调整完成', { exact: false })).toBeVisible()
  const finalBill = await readBill()
  expect(finalBill).toMatchObject({ status: 'cleared', recordStatus: 'archived', frozenChargesFen: 403618, currentChargesFen: 402618, remainingRefundFen: 0, remainingCollectFen: 0 })
  expect(finalBill.refunds).toHaveLength(1)
  expect(finalBill.refunds[0]).toMatchObject({ outcome: 'success', amountFen: 1000, sourceId: originalDeposit.sourceId })
  expect((await readRecord()).archive).toEqual(archived.archive)
  expect(await readGrouping()).toEqual(frozen)
  const unchanged = await s.read('cashier', `${stay.path}/discharge/preview`, inpatientSettlementPreviewSchema)
  expect(unchanged.settlement).toEqual(firstSettlement.settlement)
  expect(unchanged.insurance).toEqual(firstSettlement.insurance)
  expect(unchanged.transactions).toEqual(firstSettlement.transactions)
  expect(errors).toEqual([])
}
