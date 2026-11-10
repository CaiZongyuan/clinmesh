import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { refundCaseSchema, refundPreviewResponseSchema, refundResponseSchema } from '@clinmesh/contracts/refunds'
import { expect, type Locator, type Page } from '@playwright/test'
import { openBillingDetails, readBill } from './billing-payments.fixture.ts'
import { readDoctorBillingCase } from './investigation-billing.fixture.ts'
import { openWorkspaceTab } from './workspace-tabs.fixture.ts'

/** 只对明确选择的原分配冲减退款，未知退款预占原分配，恢复仍使用同一退款。 */
export async function runMultiChargeAllocationRefund(page: Page, doctor: Page, server: { origin: string; caseId: string }, paymentId: string, reviewUi: (stage: string, region: Locator) => Promise<void> = async () => {}) {
  const readRefunds = async () => {
    const response = await page.request.get(`${server.origin}/api/his/v1/billing/cases/${server.caseId}/refunds`)
    expect(response.status()).toBe(200)
    return refundCaseSchema.parse(await response.json())
  }
  const before = await readBill(page, server)
  const charge = before.charges.find(item => item.category === 'imaging')!
  const clinical = await readDoctorBillingCase(doctor, server)
  const request = clinical.imagingRequests!.requests.find(item => item.billing?.chargeItemId === charge.chargeItemId)!
  await openWorkspaceTab(doctor, '检验检查')
  await doctor.getByRole('tab', { name: /^放射检查 \d+$/ }).click()
  const cancelled = doctor.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/${request.id}/actions/cancel`))
  await doctor.getByRole('button', { name: '取消申请', exact: true }).click()
  expect((await cancelled).status()).toBe(200)
  await expect(doctor.getByText('已取消，原付款由收费员按原交易退款。', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '刷新账单', exact: true }).click()
  await openBillingDetails(page, '费用更正与退款')
  const panel = page.getByRole('region', { name: '费用更正与退款', exact: true })
  const original = await readRefunds()
  expect(original.sources).toHaveLength(1)
  expect(original.sources[0]).toMatchObject({ kind: 'multi-charge', sourceId: paymentId, amountFen: 29600 })
  expect(original.sources[0]).not.toHaveProperty('chargeItemId')
  const source = original.sources[0]!
  if (source.kind !== 'multi-charge') throw new Error('Expected one complete combined payment refund source')
  expect(source.allocations).toHaveLength(4)
  await panel.getByLabel('本次退款金额（元）', { exact: true }).fill('10')
  // 原整笔交易存在也不能静默选择第一项；必须由操作者指定原分配。
  await expect(panel.getByRole('button', { name: '预览退款', exact: true })).toBeDisabled()
  await panel.getByLabel('原收款项目', { exact: true }).click()
  await expect(page.getByRole('option')).toHaveCount(4)
  await reviewUi('allocation-options', page.getByRole('listbox'))
  const laboratory = before.charges.find(item => item.category === 'laboratory')!
  await page.getByRole('option').filter({ hasText: laboratory.descriptionZh }).click()
  await expect(panel.getByRole('button', { name: '预览退款', exact: true })).toBeDisabled()
  await reviewUi('allocation-long-value', panel.getByLabel('原收款项目', { exact: true }))
  await panel.getByLabel('原收款项目', { exact: true }).click()
  await page.getByRole('option', { name: new RegExp(`^${charge.descriptionZh} · 原收 ¥80\\.00 · 可退 ¥`) }).click()
  await reviewUi('allocation-selected-value', panel.getByLabel('原收款项目', { exact: true }))
  await panel.getByLabel('退款处理结果', { exact: true }).click()
  await page.getByRole('option', { name: '结果未知', exact: true }).click()
  const previewed = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/refunds/actions/preview-allocation'))
  await panel.getByRole('button', { name: '预览退款', exact: true }).click()
  const previewResponse = await previewed
  expect(previewResponse.status()).toBe(200)
  const preview = refundPreviewResponseSchema.parse(await previewResponse.json()).data
  expect(preview).toMatchObject({ sourceId: paymentId, chargeItemId: charge.chargeItemId, amountFen: 1000 })
  expect(previewResponse.request().postDataJSON().input).toMatchObject({ paymentId, chargeItemId: charge.chargeItemId, amountFen: 1000 })
  const review = page.getByRole('region', { name: '确认退款', exact: true })
  await expect(review).toContainText(charge.descriptionZh)
  await reviewUi('refund-confirmation', review)
  const submitted = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/refunds/${preview.previewId}/actions/confirm`))
  await review.getByRole('button', { name: '确认退款', exact: true }).click()
  const refund = refundResponseSchema.parse(await (await submitted).json()).data
  expect(refund).toMatchObject({ sourceId: paymentId, basisId: `outpatient-charge:${charge.chargeItemId}`, amountFen: 1000, outcome: 'ambiguous' })
  await expect(review).toHaveCount(0)
  const reserved = await readRefunds()
  expect(reserved).toMatchObject({ refundedFen: 0, reservedFen: 1000 })
  const reservedSource = reserved.sources[0]!
  if (reservedSource.kind !== 'multi-charge') throw new Error('Missing original combined source')
  expect(reservedSource).toMatchObject({ amountFen: 29600, reservedFen: 1000 })
  expect(reservedSource.allocations.find(item => item.chargeItemId === charge.chargeItemId)).toMatchObject({ amountFen: 8000, reservedFen: 1000 })
  for (const allocation of reservedSource.allocations.filter(item => item.chargeItemId !== charge.chargeItemId)) expect(allocation).toMatchObject({ refundedFen: 0, reservedFen: 0 })
  await expect(panel.getByRole('button', { name: '预览退款', exact: true })).toBeDisabled()
  await reviewUi('refund-reserved', panel)
  await page.reload()
  await expect(page.getByRole('heading', { name: '门诊收费', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '已缴', exact: true }).click()
  await openBillingDetails(page, '费用更正与退款')
  await panel.getByRole('button', { name: '查询原退款结果', exact: true }).click()
  const recovery = page.getByRole('region', { name: '查询原退款结果', exact: true })
  await reviewUi('refund-recovery', recovery)
  let recoveryPosts = 0, originalKey = ''
  let finish!: (value: ReturnType<typeof refundResponseSchema.parse>['data']) => void
  const committed = new Promise<ReturnType<typeof refundResponseSchema.parse>['data']>(resolve => { finish = resolve })
  const pattern = /\/refunds\/[^/]+\/actions\/recover$/
  await page.route(pattern, async route => {
    recoveryPosts += 1
    originalKey = route.request().headers()['idempotency-key'] ?? ''
    const url = new URL(route.request().url())
    const response = await route.fetch({ url: `${server.origin}${url.pathname.replace('/clinmesh-api', '/api')}${url.search}` })
    expect(response.status()).toBe(200)
    const value = refundResponseSchema.parse(await response.json()).data
    await route.abort('failed')
    finish(value)
  })
  await recovery.getByRole('button', { name: '查询原退款结果', exact: true }).click()
  const recovered = await committed
  expect(recovered).toMatchObject({ refundId: refund.refundId, outcome: 'success', tenders: [{ method: 'cash', amountFen: 1000 }] })
  await expect(recovery.getByRole('button', { name: '恢复原费用更正或退款', exact: true })).toBeVisible()
  await page.reload()
  const receipt = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname.endsWith('/his/v1/command-receipts') && url.searchParams.get('operationId') === 'refund.recover'
      && url.searchParams.get('idempotencyKey') === originalKey
  })
  await page.getByRole('button', { name: '恢复原费用操作', exact: true }).click()
  const lookup = commandReceiptLookupSchema.parse(await (await receipt).json())
  expect(lookup.status).toBe('completed')
  await expect(page.getByRole('button', { name: '恢复原费用操作', exact: true })).toHaveCount(0)
  const after = await readRefunds()
  expect(after).toMatchObject({ refundedFen: 1000, reservedFen: 0 })
  expect(after.refunds).toHaveLength(1)
  expect(after.refunds[0]).toMatchObject({ refundId: refund.refundId, sourceId: paymentId, basisId: `outpatient-charge:${charge.chargeItemId}`, outcome: 'success' })
  const afterSource = after.sources[0]!
  if (afterSource.kind !== 'multi-charge') throw new Error('Missing original combined source')
  expect(afterSource).toMatchObject({ amountFen: 29600, refundedFen: 1000, reservedFen: 0 })
  expect(afterSource.allocations.find(item => item.chargeItemId === charge.chargeItemId)).toMatchObject({ amountFen: 8000, refundedFen: 1000, reservedFen: 0 })
  for (const allocation of afterSource.allocations.filter(item => item.chargeItemId !== charge.chargeItemId)) expect(allocation).toMatchObject({ refundedFen: 0, reservedFen: 0 })
  expect((await readBill(page, server)).payments).toEqual(before.payments)
  expect(recoveryPosts).toBe(1)
  await openBillingDetails(page, '费用更正与退款')
  await reviewUi('refund-recovered', panel)
  await page.unroute(pattern)
  return { cancelledRequestId: request.id, preview, refund, recovered, original, reserved, after }
}
