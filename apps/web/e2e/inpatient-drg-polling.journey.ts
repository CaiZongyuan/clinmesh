import type { Locator, Page } from '@playwright/test'
import { expect } from './inpatient-drg.fixture.ts'

export async function expectStableDrgPolling(page: Page, panel: Locator, path: string) {
  const grouping = panel.getByRole('region', { name: '正式事实分组', exact: true })
  const recalculate = panel.getByRole('button', { name: '重新计算', exact: true })
  await expect(grouping).toContainText('已分组 · RA15')
  await expect(recalculate).toBeEnabled()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  // A narrow viewport alone leaves this short notice on one line.
  await panel.evaluate(element => { element.style.width = '200px' })
  const measure = () => panel.evaluate(element => {
    const hint = element.querySelector<HTMLParagraphElement>('p[role="status"]')!
    const style = getComputedStyle(hint), top = element.getBoundingClientRect().top
    const text = document.createRange()
    text.selectNodeContents(hint)
    return { lines: text.getClientRects().length, height: hint.getBoundingClientRect().height, lineHeight: Number.parseFloat(style.lineHeight), visibility: style.visibility,
      groupingTop: element.querySelector('section[aria-label="正式事实分组"]')!.getBoundingClientRect().top - top,
      chargesTop: element.querySelector('[data-testid="drg-charges"]')!.getBoundingClientRect().top - top }
  })
  const before = await measure()
  expect(before.lines, '提示必须实际换行').toBeGreaterThanOrEqual(2)
  expect(before.height, '隐藏提示须保留多行高度').toBeGreaterThan(before.lineHeight * 1.5)
  expect(before.visibility).toBe('hidden')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const polling = new Promise<void>(resolve => { started = resolve })
  await page.route(`**${path}/drg/simulation`, async route => {
    const response = await route.fetch()
    started()
    await held
    await route.fulfill({ response })
  })
  try {
    await polling
    await expect(recalculate).toBeDisabled()
    await expect(grouping).toBeVisible()
    const during = await measure()
    expect(during.visibility).toBe('visible')
    expect(during.height).toBeCloseTo(before.height, 0)
    expect(during.groupingTop, '后台核对不应挤动分组').toBeCloseTo(before.groupingTop, 0)
    expect(during.chargesTop, '后台核对不应挤动费用').toBeCloseTo(before.chargesTop, 0)
  } finally { release() }
  await expect(recalculate).toBeEnabled()
  const after = await measure()
  expect(after.visibility).toBe('hidden')
  expect(after.height).toBeCloseTo(before.height, 0)
  expect(after.groupingTop, '后台核对完成后分组保持原位').toBeCloseTo(before.groupingTop, 0)
  expect(after.chargesTop, '后台核对完成后费用保持原位').toBeCloseTo(before.chargesTop, 0)
}
