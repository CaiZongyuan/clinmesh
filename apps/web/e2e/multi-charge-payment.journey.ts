import { multiChargePaymentPreviewResponseSchema } from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { expect, type Locator, type Page } from '@playwright/test'
import { readBill } from './billing-payments.fixture.ts'
import type { startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { expectFourUnpaidCharges } from './multi-charge-payment.fixture.ts'

type BillingServer = Pick<Awaited<ReturnType<typeof startInvestigationBillingServer>>, 'origin' | 'caseId'>
export const multiChargeDialog = (page: Page) => page.getByRole('dialog', { name: '选择多项收费', exact: true })

export async function previewSelectedCharges(page: Page, dialog = multiChargeDialog(page)) {
  const received = page.waitForResponse(response => response.request().method() === 'POST'
    && response.url().endsWith('/payments/actions/preview-multi-charge'))
  await dialog.getByRole('button', { name: '预览合并收费', exact: true }).click()
  const response = await received
  expect(response.status()).toBe(200)
  const preview = multiChargePaymentPreviewResponseSchema.parse(await response.json()).data
  await expect(dialog.getByRole('region', { name: '合并收费预览', exact: true })).toBeVisible()
  return preview
}

/** 同一真实旅程同时驱动 standalone、实际 upstream Surface 与最终录屏。 */
export async function runMultiChargePreviewJourney(page: Page, server: BillingServer, chargeIds: string[], onStep: (caption: string) => Promise<void> = async () => {}) {
  const before = await readBill(page, server)
  const charges = await expectFourUnpaidCharges(page, server, chargeIds)
  const previews: Awaited<ReturnType<typeof previewSelectedCharges>>[] = []
  const moneyPosts: string[] = []
  const watch = (request: { method(): string; url(): string }) => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST' && /\/(payments|refunds)\//.test(path)
      && !path.endsWith('/payments/actions/preview-multi-charge')) moneyPosts.push(path)
  }
  page.on('request', watch)
  const trigger = page.getByRole('button', { name: '选择多项收费', exact: true })
  await trigger.click()
  const dialog = multiChargeDialog(page)
  const selected = dialog.getByRole('region', { name: '待处理清单', exact: true })
  const candidates = dialog.getByRole('region', { name: '完整费用清单', exact: true })
  const frozen = dialog.getByRole('region', { name: '合并收费预览', exact: true })
  const filter = dialog.getByLabel('筛选费用', { exact: true })
  const previewButton = dialog.getByRole('button', { name: '预览合并收费', exact: true })
  const collect = async () => {
    const preview = await previewSelectedCharges(page, dialog)
    expect(preview).toMatchObject({ amountFen: 29600, totalFen: 29600, paidFen: 0, insuranceFen: 0, remainingFen: 29600 })
    expect(preview.charges.map(charge => charge.chargeItemId).toSorted()).toEqual(chargeIds.toSorted())
    for (const charge of preview.charges) {
      expect(charge).toMatchObject({ paidFen: 0, insuranceFen: 0, collectionAmountFen: charge.remainingFen })
      const row = frozen.getByRole('row').filter({ hasText: charge.descriptionZh })
      await expect(row).toHaveCount(1)
      await expect(row.getByRole('cell')).toHaveCount(6)
    }
    await expect(frozen).toContainText('预览总额 ¥296.00')
    await expect(frozen).toContainText('本预览尚未收款')
    await expect(dialog.getByRole('button', { name: /确认.*(?:收款|支付)|提交支付/ })).toHaveCount(0)
    previews.push(preview)
    return preview
  }
  try {
    await expect(selected.getByRole('listitem')).toHaveCount(0)
    await expect(previewButton).toBeDisabled()
    const registration = before.charges.find(charge => charge.category === 'registration')
    if (registration) await expect(candidates.getByRole('checkbox', { name: `选择收费：${registration.descriptionZh}`, exact: true })).toBeDisabled()
    for (const [index, charge] of charges.entries()) {
      await filter.fill(charge.descriptionZh)
      await expect(candidates.getByRole('checkbox')).toHaveCount(1)
      await dialog.getByRole('button', { name: '全选本页可收费项目', exact: true }).click()
      await expect(selected.getByRole('listitem')).toHaveCount(index + 1)
      if (index === 0) await expect(previewButton).toBeDisabled()
    }
    await filter.fill('没有匹配的合成收费')
    await expect(candidates).toContainText('没有匹配的费用')
    await expect(selected.getByRole('listitem')).toHaveCount(4)
    for (const charge of charges) await expect(selected).toContainText(charge.descriptionZh)
    await filter.clear()
    await expect(selected).toContainText('本次合计 ¥296.00')
    await onStep('四笔原费用跨三类，筛选保留完整清单；待收合计 ¥296.00')
    await collect()
    await onStep('冻结四项原余额与合计；本预览尚未收款')

    const lastCharge = charges.at(-1)!
    const lastChoice = dialog.getByRole('checkbox', { name: `选择收费：${lastCharge.descriptionZh}`, exact: true })
    await lastChoice.uncheck()
    await expect(frozen).toHaveCount(0)
    await lastChoice.check()
    await expect(frozen).toHaveCount(0)
    await onStep('选择范围变化撤销旧预览，重新选择后须重新预览')
    await collect()
    await dialog.getByLabel('合成现金', { exact: true }).fill('196')
    await expect(frozen).toHaveCount(0)
    await expect(previewButton).toBeDisabled()
    await dialog.getByLabel('合成银行卡', { exact: true }).fill('100')
    await expect(previewButton).toBeEnabled()
    const combined = await collect()
    expect(combined.tenders).toEqual([{ method: 'cash', amountFen: 19600 }, { method: 'bank-card', amountFen: 10000 }])
    await onStep('支付方式变化后重新预览：现金 ¥196.00 ＋ 银行卡 ¥100.00')

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    await expect(frozen).toHaveCount(0)
    await expect(selected.getByRole('listitem')).toHaveCount(4)
    await expect(dialog.getByLabel('合成现金', { exact: true })).toHaveValue('196')
    await expect(dialog.getByLabel('合成银行卡', { exact: true })).toHaveValue('100')
    await page.reload()
    await expect(page.getByRole('heading', { name: '门诊收费', exact: true })).toBeVisible()
    await trigger.click()
    await expect(selected.getByRole('listitem')).toHaveCount(4)
    await expect(dialog.getByLabel('合成现金', { exact: true })).toHaveValue('196')
    await expect(dialog.getByLabel('合成银行卡', { exact: true })).toHaveValue('100')
    await expect(frozen).toHaveCount(0)
    await onStep('关闭与刷新保留完整私稿；旧冻结已撤销，须重新预览')
    await collect()
    const after = await readBill(page, server)
    expect(after.payments).toEqual(before.payments)
    await expectFourUnpaidCharges(page, server, chargeIds)
    expect(moneyPosts).toEqual([])
    await onStep('四项预览完成；本次尚未收款')
    return { chargeIds, categories: charges.map(charge => charge.category), amountFen: 29600, previews, moneyPosts,
      paymentsBefore: before.payments, paymentsAfter: after.payments,
      selectionInvalidated: true, tendersInvalidated: true, cancelInvalidated: true, restoredAfterRefresh: true }
  } finally { page.off('request', watch) }
}

export async function clearMultiChargeDraftJourney(dialog: Locator) {
  const filter = dialog.getByLabel('筛选费用', { exact: true })
  const selected = dialog.getByRole('region', { name: '待处理清单', exact: true })
  await filter.fill('合成')
  await dialog.getByRole('button', { name: '清空选择', exact: true }).click()
  await expect(selected.getByRole('listitem')).toHaveCount(0)
  await expect(filter).toHaveValue('合成')
  await expect(dialog.getByLabel('合成现金', { exact: true })).toHaveValue('196')
  await expect(dialog.getByLabel('合成银行卡', { exact: true })).toHaveValue('100')
  await dialog.getByRole('button', { name: '丢弃草稿', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '确认丢弃草稿', exact: true })).toBeVisible()
  await expect(filter).toHaveValue('合成')
  await dialog.getByRole('button', { name: '确认丢弃草稿', exact: true }).click()
  await expect(filter).toHaveValue('')
  await expect(dialog.getByLabel('合成现金', { exact: true })).toHaveValue('')
  await expect(dialog.getByLabel('合成银行卡', { exact: true })).toHaveValue('')
}

export async function recoverMultiChargePreviewJourney(page: Page, server: BillingServer, mode: 'after-commit' | 'before-send' | 'corrupted-draft') {
  const dialog = multiChargeDialog(page)
  if (!(await dialog.isVisible())) await page.getByRole('button', { name: '选择多项收费', exact: true }).click()
  await dialog.getByLabel('筛选费用', { exact: true }).clear()
  await dialog.getByRole('button', { name: '全选本页可收费项目', exact: true }).click()
  const paymentsBefore = (await readBill(page, server)).payments
  const posts: { key: string; body: unknown }[] = []
  let committedPreviewId: string | undefined
  const pattern = '**/payments/actions/preview-multi-charge'
  await page.route(pattern, async route => {
    posts.push({ key: await route.request().headerValue('idempotency-key') ?? '', body: route.request().postDataJSON() })
    if (posts.length > 1) return route.fallback()
    if (mode !== 'before-send') {
      const url = new URL(route.request().url())
      const response = await route.fetch({ url: `${server.origin}${url.pathname.replace('/clinmesh-api', '/api')}${url.search}` })
      expect(response.status()).toBe(200)
      committedPreviewId = multiChargePaymentPreviewResponseSchema.parse(await response.json()).data.previewId
    }
    await route.abort('failed')
  })
  try {
    await dialog.getByRole('button', { name: '预览合并收费', exact: true }).click()
    const recover = dialog.getByRole('button', { name: '查询原预览结果', exact: true })
    await expect(recover).toBeEnabled()
    await expect(dialog.getByRole('button', { name: '预览合并收费', exact: true })).toBeDisabled()
    await expect(dialog.getByLabel('合成现金', { exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '丢弃草稿', exact: true })).toBeDisabled()
    expect(posts).toHaveLength(1)
    expect(posts[0]!.key.length).toBeGreaterThanOrEqual(8)
    if (mode === 'corrupted-draft') expect(await page.evaluate(() => {
      const keys = Object.keys(sessionStorage).filter(key => key.startsWith('clinmesh.multi-charge-draft:'))
      for (const key of keys) sessionStorage.setItem(key, '{')
      return keys.length
    })).toBeGreaterThan(0)
    await page.reload()
    await expect(page.getByRole('heading', { name: '门诊收费', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '选择多项收费', exact: true }).click()
    await expect(recover).toBeEnabled()
    const receiptResponse = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname.endsWith('/command-receipts') && url.searchParams.get('operationId') === 'payment.multi-charge.preview'
        && url.searchParams.get('idempotencyKey') === posts[0]!.key
    })
    await recover.click()
    const receipt = await receiptResponse
    expect(receipt.status()).toBe(mode === 'before-send' ? 404 : 200)
    if (mode !== 'before-send') {
      const result = commandReceiptLookupSchema.parse(await receipt.json())
      expect(result).toMatchObject({ idempotencyKey: posts[0]!.key, operationId: 'payment.multi-charge.preview', status: 'completed' })
      expect(multiChargePaymentPreviewResponseSchema.parse(result.response).data.previewId).toBe(committedPreviewId)
    }
    const frozen = dialog.getByRole('region', { name: '合并收费预览', exact: true })
    await expect(recover).toHaveCount(0)
    expect(posts).toHaveLength(mode === 'before-send' ? 2 : 1)
    if (mode === 'before-send') expect(posts[1]).toEqual(posts[0])
    if (mode === 'corrupted-draft') {
      await expect(frozen).toHaveCount(0)
      await expect(dialog).toContainText('已找到原预览，费用或草稿已变化，请重新预览。')
      await dialog.getByRole('button', { name: '丢弃草稿', exact: true }).click()
      await dialog.getByRole('button', { name: '确认丢弃草稿', exact: true }).click()
      await dialog.getByRole('button', { name: '全选本页可收费项目', exact: true }).click()
      await previewSelectedCharges(page, dialog)
      expect(posts).toHaveLength(2)
      expect(posts[1]!.key).not.toBe(posts[0]!.key)
    }
    await expect(frozen).toContainText('预览总额 ¥296.00')
    expect((await readBill(page, server)).payments).toEqual(paymentsBefore)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  } finally { await page.unroute(pattern) }
}

/** 真实退出与重登保持同一 SPA，验证存储拒绝删除时延后清理仍隔离旧私稿。 */
export async function logoutMultiChargeDraftJourney(page: Page, server: BillingServer & { password: string }, restricted = false) {
  const dialog = multiChargeDialog(page)
  if (!(await dialog.isVisible())) await page.getByRole('button', { name: '选择多项收费', exact: true }).click()
  await dialog.getByRole('button', { name: '全选本页可收费项目', exact: true }).click()
  await expect(dialog.getByRole('region', { name: '待处理清单', exact: true }).getByRole('listitem')).toHaveCount(4)
  await dialog.getByLabel('合成现金', { exact: true }).fill('196')
  await dialog.getByLabel('合成银行卡', { exact: true }).fill('100')
  await dialog.getByRole('combobox', { name: '支付处理结果', exact: true }).click()
  await page.getByRole('option', { name: '结果未知', exact: true }).click()
  await page.keyboard.press('Escape')
  if (restricted) await page.evaluate(() => {
    document.documentElement.dataset.issue426DenyDraftRemoval = 'true'
    const nativeRemove = Storage.prototype.removeItem
    Storage.prototype.removeItem = function (key: string) {
      if (key.startsWith('clinmesh.multi-charge-draft:') && document.documentElement.dataset.issue426DenyDraftRemoval === 'true') {
        throw new DOMException('Synthetic restricted storage', 'SecurityError')
      }
      nativeRemove.call(this, key)
    }
  })
  await page.getByRole('button', { name: '用户菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  await expect(page.getByLabel('账户邮箱')).toBeVisible()
  await page.getByLabel('账户邮箱').fill('cashier@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(server.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '门诊收费', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '选择多项收费', exact: true }).click()
  await expect(dialog.getByRole('region', { name: '待处理清单', exact: true }).getByRole('listitem')).toHaveCount(0)
  await expect(dialog.getByLabel('合成现金', { exact: true })).toHaveValue('')
  await expect(dialog.getByLabel('合成银行卡', { exact: true })).toHaveValue('')
  await expect(dialog.getByRole('combobox', { name: '支付处理结果', exact: true })).toContainText('成功')
  await expect(dialog.getByRole('region', { name: '合并收费预览', exact: true })).toHaveCount(0)
  if (restricted) {
    await expect(dialog).toContainText('草稿存储不可用')
    await expect(dialog.getByRole('button', { name: '预览合并收费', exact: true })).toBeDisabled()
    await page.evaluate(() => { delete document.documentElement.dataset.issue426DenyDraftRemoval })
    await dialog.getByRole('button', { name: '重试保存草稿', exact: true }).click()
    await expect(dialog.getByText('草稿存储不可用', { exact: true })).toHaveCount(0)
    await expect(dialog.getByRole('region', { name: '待处理清单', exact: true }).getByRole('listitem')).toHaveCount(0)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
}
