import { expect, type Page } from '@playwright/test'

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
