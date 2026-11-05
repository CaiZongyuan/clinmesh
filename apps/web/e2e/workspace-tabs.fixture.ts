import { expect, type Page } from '@playwright/test'

export async function openWorkspaceTab(page: Page, name: string) {
  const tab = page.getByRole('tab', { name, exact: true, includeHidden: true })
  await expect(tab).toHaveCount(1)
  // 待办数加载后页签变宽，可见的页签可能随后才收进「更多」，包括刚确认可见之后；连同点击一起重试。
  await expect(async () => {
    const more = page.getByRole('button', { name: /^(更多|More)$/, exact: true })
    if (await tab.isVisible()) await tab.click({ timeout: 1000 })
    else if (await more.isVisible()) {
      await more.click({ timeout: 1000 })
      await page.getByRole('menuitem').filter({ has: page.getByText(name, { exact: true }) }).click({ timeout: 1000 })
    }
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 1000 })
  }).toPass()
}
