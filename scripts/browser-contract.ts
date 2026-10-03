import { expect, type Page } from '@playwright/test'

export async function readJsonFromBrowser(page: Page, documentContent: string): Promise<unknown> {
  const errors: string[] = []
  const onError = (error: Error) => errors.push(error.message)
  page.on('pageerror', onError)
  try {
    await page.setContent(documentContent)
    await page.waitForFunction(() => document.title !== '', undefined, { timeout: 20_000 })
    expect(errors).toEqual([])
    return JSON.parse(Buffer.from(await page.title(), 'base64').toString('utf8'))
  } finally {
    page.off('pageerror', onError)
  }
}
