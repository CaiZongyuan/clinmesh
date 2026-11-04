import { expect, type Locator, type Page } from '@playwright/test'

/** 门诊收费/药房使用列表头菜单，其余岗位保留分段入口。 */
export async function selectWorkspaceMode(page: Page, mode: '门诊' | '住院') {
  const name = /^(门诊与住院|Outpatient and inpatient)$/
  const menu = page.getByRole('combobox', { name })
  const button = page.getByRole('group', { name }).getByRole('button', { name: mode, exact: true })
  await expect(menu.or(button)).toBeVisible()
  if (await menu.isVisible()) {
    await menu.click()
    await page.getByRole('option', { name: mode, exact: true }).click()
  } else await button.click()
}

/** 页签按岗位和当前事实收纳；通过真实「更多」入口选择同一业务环节。 */
export async function selectInpatientStage(page: Page, name: string) {
  const tab = page.getByRole('tab', { name, exact: true, includeHidden: true })
    .or(page.getByRole('tab', { name: `${name} · 未发生`, exact: true, includeHidden: true }))
  await expect(tab).toHaveCount(1)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  // 元数据可能将刚出现的可选页签移入「更多」，先展开现有入口可保留真实点击路径。
  const more = page.getByRole('button', { name: '更多', exact: true })
  if (await more.isVisible()) await more.click()
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

/** 通过真实次级入口进入操作，重复访问保持已经展开的表单与草稿。 */
export async function openInpatientDisclosure(scope: Page | Locator, title: string) {
  const matcher = title === '耗材与指南评估' ? /^(耗材与指南评估|查看与调整)$/ : title
  const summary = scope.locator('summary:visible').filter({ hasText: matcher })
  await expect(summary).toHaveCount(1)
  if (await summary.locator('..').getAttribute('open') === null) await summary.click()
}

/** 核对当前完成通知后，通过真实关闭入口继续处理下一条。 */
export async function acknowledgeInpatientCompletion(page: Page, title: string) {
  const completed = page.locator('[data-slot="toast"]').filter({ hasText: title })
  await expect(completed).toHaveCount(1)
  const content = completed.locator('[data-slot="toast-content"]')
  if (await content.getAttribute('data-expanded') === null) await page.keyboard.press('F6')
  await expect(content).toHaveAttribute('data-expanded', '')
  await completed.getByRole('button', { name: 'Close toast', exact: true }).click()
  await expect(completed).toHaveCount(0)
}

/** 等待当前可见 DRG 或手术耗材视图挂载，再进入本视图的可用工具；默认折叠另由六页旅程验收。 */
export async function openInpatientDrgTools(page: Page) {
  const panel = page.getByRole('region', { name: /^(DRG 预分组|住院手术)$/ })
  await expect(panel).toBeVisible()
  for (const title of ['查看与调整', '费用依据与明细', '治疗耗材预留', '住院自动跟进', '病案与分组核对', '术后核查与责任交接', '手术耗材建议']) {
    if (await panel.locator('summary:visible').filter({ hasText: title }).count() > 0) await openInpatientDisclosure(panel, title)
  }
}

/** 在对应术前事项中核对完成状态、责任岗位与真实记录时间。 */
export async function expectCompletedSurgeryPreparation(plan: Locator, item: '术前核对' | '手术知情同意书已签', owner: '病区护士' | '住院医生') {
  const preparation = plan.getByRole('region', { name: /^(开始手术还差|术前准备已完成|术前准备记录)$/ })
  const row = preparation.getByRole('listitem').filter({ hasText: item })
  await expect(row).toHaveCount(1)
  await expect(row.getByText(item, { exact: true })).toBeVisible()
  await expect(row.getByText('已完成', { exact: true })).toBeVisible()
  await expect(row.getByText(owner, { exact: true })).toBeVisible()
  const recordedAt = row.locator('time')
  await expect(recordedAt).toBeVisible()
  return recordedAt
}
