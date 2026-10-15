import { expect, type Page } from '@playwright/test'

export async function expandHistory(page: Page): Promise<void> {
  const closed = page.locator('[data-consultation-field-suggestions] > details:not([open]) > summary')
  while (await closed.count() > 0) {
    await closed.first().click()
  }
}

export async function confirmRecordedAddition(page: Page, quote: string): Promise<void> {
  const applied = page.locator('[data-consultation-addition="applied"]').filter({ hasText: quote })
  await expect(applied).toHaveAttribute('data-consultation-review', 'unreviewed')
  await expect(applied.getByRole('button', { name: '应用建议', exact: true })).toHaveCount(0)
  await applied.getByRole('button', { name: '确认已核对', exact: true }).click()
  await expect(applied).toHaveAttribute('data-consultation-review', 'confirmed')
  await expandHistory(page)
}
