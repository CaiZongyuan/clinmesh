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
  if (!await tab.isVisible()) await page.getByRole('button', { name: '更多', exact: true }).click()
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

/** 通过真实次级入口进入操作，重复访问保持已经展开的表单与草稿。 */
export async function openInpatientDisclosure(scope: Page | Locator, title: string) {
  const summary = scope.locator('summary:visible').filter({ hasText: title })
  await expect(summary).toHaveCount(1)
  if (await summary.locator('..').getAttribute('open') === null) await summary.click()
}

/** 等待当前可见 DRG 视图挂载，再进入本视图的可用工具；默认折叠另由六页旅程验收。 */
export async function openInpatientDrgTools(page: Page) {
  const panel = page.getByRole('region', { name: 'DRG 预分组', exact: true })
  await expect(panel).toBeVisible()
  for (const title of ['费用依据与明细', '治疗耗材预留', '住院自动跟进', '病案与分组核对', '术后核查与责任交接', '手术耗材建议']) {
    if (await panel.locator('summary:visible').filter({ hasText: title }).count() > 0) await openInpatientDisclosure(panel, title)
  }
}
