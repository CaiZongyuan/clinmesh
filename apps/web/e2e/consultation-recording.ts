import { expect, type Page } from '@playwright/test'

export async function expandHistory(page: Page): Promise<void> {
  const closed = page.locator('[data-consultation-field-sources]:not([open]) > summary')
  while (await closed.count() > 0) await closed.first().click()
}

export async function waitForRecordedHistory(page: Page, quote: string): Promise<void> {
  await expect(page.locator('[data-consultation-field-sources]')).not.toHaveCount(0)
  await expandHistory(page)
  await expect(page.locator('[data-consultation-addition="applied"]').filter({ hasText: quote })).not.toHaveCount(0)
}
