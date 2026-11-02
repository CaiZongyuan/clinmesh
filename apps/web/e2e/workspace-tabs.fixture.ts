import { expect, type Page } from '@playwright/test'

export async function openWorkspaceTab(page: Page, name: string) {
  const tab = page.getByRole('tab', { name, exact: true, includeHidden: true })
  await expect(tab).toHaveCount(1)
  if (!await tab.isVisible()) await page.getByRole('button', { name: /^(更多|More)$/, exact: true }).click()
  await expect(tab).toBeVisible()
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}
