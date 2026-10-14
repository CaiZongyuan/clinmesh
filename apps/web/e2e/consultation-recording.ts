import { expect, type Page } from '@playwright/test'

export async function waitForRecordedHistory(page: Page, quote: string): Promise<void> {
  const fields = page.locator('[data-clinical-document-field] input, [data-clinical-document-field] textarea')
  await expect.poll(async () => fields.evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value))
    .then(values => values.some(value => value.includes(quote)))).toBe(true)
}
