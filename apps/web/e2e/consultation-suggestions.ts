import { expect, type Page } from '@playwright/test'

export async function expandHistory(page: Page): Promise<void> {
  const closed = page.locator('[data-consultation-field-suggestions] > details:not([open]) > summary')
  while (await closed.count() > 0) {
    await closed.first().click()
  }
}

export async function applySuggestion(page: Page, quote: string): Promise<void> {
  const pending = page.locator('[data-consultation-addition="pending"]').filter({ hasText: quote })
  await pending.getByRole('button', { name: '应用建议', exact: true }).click()
  await expect(pending).toHaveCount(0)
  await expandHistory(page)
}
