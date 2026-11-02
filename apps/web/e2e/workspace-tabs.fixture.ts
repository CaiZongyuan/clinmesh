import { expect, type Page } from '@playwright/test'

export async function openWorkspaceTab(page: Page, name: string) {
  const tab = page.getByRole('tab', { name, exact: true, includeHidden: true })
  await expect(tab).toHaveCount(1)
  // 待办数加载后页签变宽，可见的页签可能随后才收进「更多」；重试直到页签真正可见。
  await expect(async () => {
    const more = page.getByRole('button', { name: /^(更多|More)$/, exact: true })
    if (!await tab.isVisible() && await more.isVisible()) await more.click()
    await expect(tab).toBeVisible({ timeout: 1000 })
  }).toPass()
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}
