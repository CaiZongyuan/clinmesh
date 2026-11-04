import { expect, type Page } from '@playwright/test'

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
