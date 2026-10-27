import type { Locator, Page } from '@playwright/test'
import { expect } from './inpatient-drg.fixture.ts'

export async function expectStableDrgPolling(page: Page, panel: Locator, path: string) {
  const grouping = panel.getByRole('region', { name: '正式事实分组', exact: true })
  const recalculate = panel.getByRole('button', { name: '重新计算', exact: true })
  await expect(grouping).toContainText('已分组 · RA15')
  await expect(recalculate).toBeEnabled()
  const offset = () => grouping.evaluate(element => {
    const panel = element.closest('section[aria-label="DRG 与费用推演"]')!
    return element.getBoundingClientRect().top - panel.getBoundingClientRect().top
  })
  const before = await offset()
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
    expect(await offset(), '后台核对不应挤动分组与费用结果').toBeCloseTo(before, 0)
  } finally { release() }
  await expect(recalculate).toBeEnabled()
  expect(await offset(), '后台核对完成后结果保持原位').toBeCloseTo(before, 0)
}
