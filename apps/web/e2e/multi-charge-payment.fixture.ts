import { expect, type Page } from '@playwright/test'
import { readBill } from './billing-payments.fixture.ts'
import { issueBillableInvestigations } from './investigation-billing-execution.fixture.ts'
import { issueDoctorLaboratoryRequest, readDoctorBillingCase, type startInvestigationBillingServer } from './investigation-billing.fixture.ts'

type BillingServer = Pick<Awaited<ReturnType<typeof startInvestigationBillingServer>>, 'origin' | 'caseId'>

/** 正式申请、价格和费用均由医生页面生成；此处只从公开读取核对尚未收款/放行。 */
export async function prepareMultiChargeInvestigations(doctor: Page, server: BillingServer, laboratoryName?: string) {
  const laboratory = laboratoryName === undefined ? undefined : await issueDoctorLaboratoryRequest(doctor, { query: '白细胞', name: laboratoryName, code: '0100101A' })
  const ids = await issueBillableInvestigations(doctor, laboratory)
  const detail = await readDoctorBillingCase(doctor, server)
  const requests = [
    ...detail.laboratoryRequests!.requests,
    ...detail.imagingRequests!.requests,
    ...detail.pathologyRequests!.requests,
  ].filter(request => Object.values(ids).includes(request.id))
  expect(requests).toHaveLength(4)
  for (const request of requests) {
    expect(request).toMatchObject({ status: 'issued', billing: { status: 'pending', paidFen: 0 } })
    expect(request.billing?.releasedAt).toBeUndefined()
    expect(request.report).toBeUndefined()
  }
  return { requestIds: Object.values(ids), chargeIds: requests.map(request => request.billing!.chargeItemId) }
}

export async function expectFourUnpaidCharges(cashier: Page, server: BillingServer, chargeIds: string[]) {
  const bill = await readBill(cashier, server)
  const charges = bill.charges.filter(charge => chargeIds.includes(charge.chargeItemId))
  expect(charges).toHaveLength(4)
  expect(charges.map(charge => charge.category).toSorted()).toEqual(['imaging', 'laboratory', 'laboratory', 'pathology'])
  expect(charges.map(charge => charge.remainingFen).toSorted((a, b) => a - b)).toEqual([800, 800, 8000, 20000])
  for (const charge of charges) expect(charge).toMatchObject({ paidFen: 0, insuranceFen: 0 })
  expect(bill.payments.filter(payment => payment.kind === 'multi-charge'
    ? payment.allocations.some(allocation => chargeIds.includes(allocation.chargeItemId))
    : chargeIds.includes(payment.chargeItemId))).toEqual([])
  return charges
}

/** 收费验收始终停在文字工作区；不请求影像、切片的元数据与像素。 */
export async function rejectClinicalMedia(page: Page) {
  const requested: string[] = []
  await page.route(/\/(?:imaging-studies|imaging-assets|pathology-assets)\/|\/(?:blocks|tiles)\//, async route => {
    requested.push(new URL(route.request().url()).pathname)
    await route.abort('blockedbyclient')
  })
  return requested
}
