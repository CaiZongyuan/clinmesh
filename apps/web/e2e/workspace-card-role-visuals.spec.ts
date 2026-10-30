import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'

const roles = [
  ['registrar', 'registration'], ['triage-nurse', 'triage'], ['doctor', 'consultation'],
  ['cashier', 'billing'], ['pharmacist', 'pharmacy'], ['inpatient-doctor', 'inpatient'],
  ['ward-nurse', 'inpatient'], ['medical-records', 'inpatient'], ['medical-insurance', 'inpatient'],
  ['admin', 'scenario-data'],
] as const

async function capture(page: Page, name: string) {
  for (const width of [944, 720, 400]) {
    await page.setViewportSize({ width, height: 900 })
    for (const [theme, label] of [['light', '亮色'], ['dark', '暗色']] as const) {
      await page.getByRole('button', { name: '用户菜单' }).click()
      await page.getByRole('menuitemradio', { name: label, exact: true }).click()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0)
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      const path = test.info().outputPath(`${name}-${width}-${theme}.png`)
      await page.screenshot({ path, animations: 'disabled' })
      await test.info().attach(`${name}-${width}-${theme}`, { path, contentType: 'image/png' })
    }
  }
}

for (const [role, route] of roles) test(`全岗位卡片空状态与真实导航：${role}`, async ({ page, browserApp }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${browserApp.origin}/${route}`)
  await page.getByLabel('账户邮箱').fill(`${role === 'triage-nurse' ? 'triage' : role}@demo.clinmesh.local`)
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  await capture(page, `${role}-empty`)
  if (role === 'registrar' || role === 'cashier' || role === 'pharmacist') {
    await page.getByRole('button', { name: '住院', exact: true }).click()
    await capture(page, `${role}-inpatient-empty`)
  }
  if (role === 'admin') {
    await page.getByRole('tab', { name: '患者库', exact: true }).click()
    await capture(page, 'admin-library-empty')
    await page.goto(`${browserApp.origin}/settings`)
    await expect(page.getByRole('heading', { name: '外观', exact: true })).toBeVisible()
    await capture(page, 'settings-appearance')
  }
  expect(errors).toEqual([])
})
