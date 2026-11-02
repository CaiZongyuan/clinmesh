import { openWorkspaceTab } from './workspace-tabs.fixture.ts'
import { expect, type Page } from '@playwright/test'
import { readBill, submitPayment } from './billing-payments.fixture.ts'
import { issueDoctorImagingOrPathologyRequest, issueDoctorLaboratoryRequest, readDoctorBillingCase, type startInvestigationBillingServer } from './investigation-billing.fixture.ts'

type BillingServer = Awaited<ReturnType<typeof startInvestigationBillingServer>>
type InvestigationIds = Record<'laboratory' | 'hemoglobin' | 'imaging' | 'pathology', string>
const kinds = ['laboratory', 'hemoglobin', 'imaging', 'pathology'] as const
const investigationEvents = kinds.flatMap(kind => ['accept', 'start', 'report'].map(action => `${kind === 'hemoglobin' ? 'laboratory' : kind}.${action}-request`))

/** 所有正式申请均来自当前医生页面；可复用同次就诊已有的未缴检验申请。 */
export async function issueBillableInvestigations(doctor: Page, laboratory?: string): Promise<InvestigationIds> {
  const laboratoryId = laboratory ?? await issueDoctorLaboratoryRequest(doctor, { query: '白细胞', name: '合成白细胞计数', code: '0100101A' })
  await doctor.getByRole('tab', { name: /^检验 \d+$/ }).click()
  const hemoglobin = await issueDoctorLaboratoryRequest(doctor, { query: '血红蛋白', name: '合成血红蛋白', code: '0100501A' })
  return {
    laboratory: laboratoryId,
    hemoglobin,
    imaging: await issueDoctorImagingOrPathologyRequest(doctor, 'imaging'),
    pathology: await issueDoctorImagingOrPathologyRequest(doctor, 'pathology'),
  }
}

/** 仅泵送三类真实检查 outbox 事件，不调用模型、不直接变更临床状态或写报告。 */
async function dispatchInvestigations(server: BillingServer) {
  const handled: string[] = []
  for (let count = 0; count < 30; count += 1) {
    const event = await server.runtime.dispatcher.dispatchOnce({ kinds: investigationEvents })
    if (event === undefined) return handled
    handled.push(event.kind)
  }
  throw new Error('Investigation outbox exceeded the bounded synthetic journey')
}

export async function collectAndObserveInvestigationReports(doctor: Page, cashier: Page, server: BillingServer, ids: InvestigationIds) {
  const requests = (detail: Awaited<ReturnType<typeof readDoctorBillingCase>>) => ({
    laboratory: detail.laboratoryRequests?.requests.find(item => item.id === ids.laboratory),
    hemoglobin: detail.laboratoryRequests?.requests.find(item => item.id === ids.hemoglobin),
    imaging: detail.imagingRequests?.requests.find(item => item.id === ids.imaging),
    pathology: detail.pathologyRequests?.requests.find(item => item.id === ids.pathology),
  })
  expect(await dispatchInvestigations(server)).toEqual([])
  const issued = requests(await readDoctorBillingCase(doctor, server))
  for (const kind of kinds) expect(issued[kind]).toMatchObject({ id: ids[kind], status: 'issued', billing: { status: 'pending', paidFen: 0 } })
  for (const kind of kinds) expect(issued[kind]?.report).toBeUndefined()

  for (const [kind, category] of [['laboratory', '检验费用'], ['hemoglobin', '检验费用'], ['imaging', '放射费用'], ['pathology', '病理会诊费用']] as const) {
    await cashier.getByRole('tab', { name: category, exact: true }).click()
    await cashier.getByRole('tab', { name: '待缴', exact: true }).click()
    if (kind === 'laboratory' || kind === 'hemoglobin') await cashier.getByRole('listitem').filter({ hasText: kind === 'laboratory' ? '合成白细胞计数' : '合成血红蛋白' }).click()
    await expect(cashier.getByRole('region', { name: '当前费用来源', exact: true }).getByText(`申请：${ids[kind]}`, { exact: true })).toBeVisible()
    if (kind === 'laboratory') {
      await cashier.getByLabel('合成现金', { exact: true }).fill('3')
      expect((await submitPayment(cashier)).outcome).toBe('success')
      expect((await readBill(cashier, server)).charges.find(charge => charge.chargeItemId === issued.laboratory?.billing?.chargeItemId))
        .toMatchObject({ paidFen: 300, remainingFen: 500 })
      expect(await dispatchInvestigations(server)).toEqual([])
      for (const request of Object.values(requests(await readDoctorBillingCase(doctor, server)))) expect(request?.status).toBe('issued')
      await cashier.getByLabel('合成现金', { exact: true }).fill('2')
      await cashier.getByLabel('合成银行卡', { exact: true }).fill('3')
    }
    expect((await submitPayment(cashier)).outcome).toBe('success')
    const bill = await readBill(cashier, server)
    const payments = bill.payments.filter(payment => payment.chargeItemId === issued[kind]?.billing?.chargeItemId)
    expect(payments).toHaveLength(kind === 'laboratory' ? 2 : 1)
    if (kind === 'laboratory') expect(payments.find(payment => payment.amountFen === 500)?.tenders).toEqual([
      { method: 'cash', amountFen: 200 }, { method: 'bank-card', amountFen: 300 },
    ])
    expect(bill.charges.find(charge => charge.chargeItemId === issued[kind]?.billing?.chargeItemId)).toMatchObject({ paidFen: issued[kind]?.billing?.price.priceFen, remainingFen: 0 })
  }

  expect((await dispatchInvestigations(server)).sort()).toEqual(investigationEvents.toSorted())
  const reported = requests(await readDoctorBillingCase(doctor, server))
  for (const kind of kinds) {
    expect(reported[kind], `${kind}: ${JSON.stringify(reported[kind]?.generationError)}`).toMatchObject({ id: ids[kind], status: 'reported', billing: { status: 'paid', remainingFen: 0, releasedAt: expect.any(String) } })
    expect(reported[kind]?.billing?.chargeItemId).toBe(issued[kind]?.billing?.chargeItemId)
    expect(reported[kind]?.report?.diagnosticReportId).toEqual(expect.any(String))
  }
  expect(new Set(kinds.map(kind => reported[kind]?.report?.diagnosticReportId)).size).toBe(4)

  await doctor.reload()
  await openWorkspaceTab(doctor, '检验检查')
  await doctor.getByRole('tab', { name: /^检验 \d+$/ }).click()
  await doctor.getByRole('button', { name: '合成白细胞计数 已报告', exact: true }).click()
  await expect(doctor.getByRole('heading', { name: '合成白细胞计数 · 检验报告', exact: true })).toBeVisible()
  await expect(doctor.getByRole('table').getByText('11.2', { exact: true })).toBeVisible()
  await doctor.getByRole('button', { name: '合成血红蛋白 已报告', exact: true }).click()
  await expect(doctor.getByRole('heading', { name: '合成血红蛋白 · 检验报告', exact: true })).toBeVisible()
  await expect(doctor.getByRole('table').getByText('135', { exact: true })).toBeVisible()
  await doctor.getByRole('tab', { name: /^放射检查 \d+$/ }).click()
  await doctor.getByRole('button', { name: '胸片 已报告', exact: true }).click()
  await expect(doctor.getByText(reported.imaging!.report!.impression, { exact: true })).toBeVisible()
  await expect(doctor.getByRole('button', { name: '打开影像', exact: true })).toBeVisible()
  await doctor.getByRole('tab', { name: /^病理会诊 \d+$/ }).click()
  await doctor.getByRole('button', { name: '乳腺切片病理会诊 报告已出', exact: true }).click()
  await expect(doctor.getByText(reported.pathology!.report!.diagnosis, { exact: true })).toBeVisible()
  await expect(doctor.getByRole('button', { name: '打开切片', exact: true })).toBeVisible()
}
