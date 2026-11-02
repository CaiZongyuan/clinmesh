import { expect, type Page } from '@playwright/test'

// Surface 窄于 800px 时队列收起为浮层，读写队列前先从顶栏展开。
export async function openQueue(page: Page) {
  if (page.viewportSize()!.width < 800) await page.getByRole('button', { name: '展开队列', exact: true }).click()
}

// 窄屏选中病例后浮层收起，读不到「在诊」页签，改以开始首诊按钮消失确认病例进入在诊。
export async function expectConsultationStarted(page: Page) {
  if (page.viewportSize()!.width < 800) await expect(page.getByRole('button', { name: '开始首诊', exact: true })).toHaveCount(0)
  else await expect(page.getByRole('tab', { name: '在诊', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')
}

// 在浮层里操作非患者条目（刷新、筛选）后浮层仍开着，用 Esc 收起再操作主卡。
export async function closeQueue(page: Page) {
  if (page.viewportSize()!.width < 800) {
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '展开队列', exact: true })).toHaveAttribute('aria-expanded', 'false')
  }
}
