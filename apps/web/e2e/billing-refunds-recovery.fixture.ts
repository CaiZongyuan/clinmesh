import { expect, type Locator, type Page } from '@playwright/test'
import { z } from 'zod'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { chargeAdjustmentResponseSchema, refundCaseSchema, refundPreviewResponseSchema, refundResponseSchema } from '@clinmesh/contracts/refunds'

export async function verifyRefundWriteRecovery(
  page: Page,
  server: { origin: string; caseId: string },
  reopen: () => Promise<void>,
  verifyDialog: (dialog: Locator) => Promise<void> = async () => {},
) {
  const panel = page.getByRole('region', { name: '费用更正与退款', exact: true })
  const read = async () => {
    const response = await page.request.get(`${server.origin}/api/his/v1/billing/cases/${server.caseId}/refunds`)
    expect(response.status()).toBe(200)
    return refundCaseSchema.parse(await response.json())
  }
  async function loseAndRestore<T>(operation: string, path: string, schema: z.ZodType<T>, dialog: Locator, action: string) {
    await verifyDialog(dialog)
    let posts = 0
    let originalKey = ''
    let committed!: T
    let finish!: () => void
    const lost = new Promise<void>(resolve => { finish = resolve })
    await page.route(path, async route => {
      if (route.request().method() !== 'POST') return route.continue()
      posts += 1
      originalKey = route.request().headers()['idempotency-key'] ?? ''
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      committed = schema.parse(await response.json())
      await route.abort('failed')
      finish()
    })
    await dialog.getByRole('button', { name: action, exact: true }).click()
    await lost
    await expect(dialog.getByRole('alert').filter({ hasText: '原操作结果待确认' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '恢复原费用更正或退款', exact: true })).toBeEnabled()
    const cancel = dialog.getByRole('button', { name: '取消', exact: true })
    await expect(cancel).toBeEnabled()
    if (operation === 'refund.confirm') await page.keyboard.press('Escape')
    else await cancel.click()
    await expect(dialog).toHaveCount(0)
    await expect(panel.getByRole('alert').filter({ hasText: '原操作结果待确认' })).toBeVisible()
    await expect(panel.getByRole('button', { name: '恢复原费用更正或退款', exact: true })).toBeEnabled()
    await expect(panel.getByRole('button', { name: '记录费用更正', exact: true })).toBeDisabled()
    await expect(panel.getByRole('button', { name: '预览退款', exact: true })).toBeDisabled()
    await reopen()
    const recover = panel.getByRole('button', { name: '恢复原费用更正或退款', exact: true })
    await expect(recover).toBeVisible()
    await expect(panel.getByRole('button', { name: '记录费用更正', exact: true })).toBeDisabled()
    await expect(panel.getByRole('button', { name: '预览退款', exact: true })).toBeDisabled()
    const receipt = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/his/v1/command-receipts'
        && url.searchParams.get('operationId') === operation && url.searchParams.get('idempotencyKey') === originalKey
    })
    await recover.click()
    const response = await receipt
    expect(response.status()).toBe(200)
    expect(commandReceiptLookupSchema.parse(await response.json()).status).toBe('completed')
    await expect(recover).toHaveCount(0)
    expect(posts).toBe(1)
    return committed
  }
  await panel.getByLabel('费用冲减金额（元）', { exact: true }).fill('20')
  await panel.getByLabel('费用更正原因', { exact: true }).fill('合成费用录入错误，核准冲减20元。')
  await panel.getByRole('button', { name: '记录费用更正', exact: true }).click()
  const correction = await loseAndRestore('billing.charge.adjust', '**/api/his/v1/billing/cases/*/adjustments',
    chargeAdjustmentResponseSchema, page.getByRole('alertdialog', { name: '确认费用更正', exact: true }), '确认费用更正')
  expect(await read()).toMatchObject({ adjustedFen: 2000, adjustments: [{ adjustmentId: correction.data.adjustmentId }] })
  expect((await read()).adjustments).toHaveLength(1)

  await panel.getByLabel('本次退款金额（元）', { exact: true }).fill('10')
  await panel.getByLabel('退款处理结果', { exact: true }).click()
  await page.getByRole('option', { name: '结果未知', exact: true }).click()
  let previewPosts = 0
  let previewKey = ''
  let originalPreviewId = ''
  await page.route('**/api/his/v1/refunds/actions/preview', async route => {
    previewPosts += 1
    previewKey = route.request().headers()['idempotency-key'] ?? ''
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    originalPreviewId = refundPreviewResponseSchema.parse(await response.json()).data.previewId
    await route.abort('failed')
  })
  await panel.getByRole('button', { name: '预览退款', exact: true }).click()
  await expect(panel.getByRole('alert').filter({ hasText: '原操作结果待确认' })).toBeVisible()
  await reopen()
  await expect(panel.getByRole('button', { name: '预览退款', exact: true })).toBeDisabled()
  const previewReceipt = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/his/v1/command-receipts'
      && url.searchParams.get('operationId') === 'refund.preview' && url.searchParams.get('idempotencyKey') === previewKey
  })
  await panel.getByRole('button', { name: '恢复原费用更正或退款', exact: true }).click()
  const previewResponse = await previewReceipt
  expect(previewResponse.status()).toBe(200)
  const previewLookup = commandReceiptLookupSchema.parse(await previewResponse.json())
  expect(previewLookup.status).toBe('completed')
  if (previewLookup.status !== 'completed') throw new Error('Missing original refund preview receipt')
  expect(refundPreviewResponseSchema.parse(previewLookup.response).data.previewId).toBe(originalPreviewId)
  expect(previewPosts).toBe(1)
  await expect(page.getByRole('alertdialog', { name: '确认退款', exact: true })).toBeVisible()
  const refund = await loseAndRestore('refund.confirm', '**/api/his/v1/refunds/*/actions/confirm',
    refundResponseSchema, page.getByRole('alertdialog', { name: '确认退款', exact: true }), '提交退款')
  expect(await read()).toMatchObject({ refundedFen: 0, reservedFen: 1000, refunds: [{ refundId: refund.data.refundId, outcome: 'ambiguous' }] })

  await panel.getByRole('button', { name: '查询原退款结果', exact: true }).click()
  await loseAndRestore('refund.recover', '**/api/his/v1/refunds/*/actions/recover',
    refundResponseSchema, page.getByRole('alertdialog', { name: '查询原退款结果', exact: true }), '查询原退款结果')
  const ledger = await read()
  expect(ledger).toMatchObject({ adjustedFen: 2000, refundedFen: 1000, reservedFen: 0,
    refunds: [{ refundId: refund.data.refundId, initialOutcome: 'ambiguous', outcome: 'success', tenders: [{ method: 'cash', amountFen: 1000 }] }] })
  expect(ledger.adjustments).toHaveLength(1)
  expect(ledger.refunds).toHaveLength(1)
}
