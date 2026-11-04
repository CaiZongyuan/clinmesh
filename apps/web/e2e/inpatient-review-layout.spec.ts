import { expect, test } from './inpatient-drg.fixture.ts'
import { runInpatientReviewLayout } from './inpatient-review-layout.journey.ts'
import { selectWorkspaceMode } from './inpatient-ui.ts'

test('住院医生紧凑头部、术前清单与单页药房保留原型层级', async ({ page, browserApp }, info) => {
  test.setTimeout(90_000)
  await runInpatientReviewLayout(page, browserApp, info, {
    capture: true,
    mount: async role => {
      await page.goto(`${browserApp.origin}/${role === 'pharmacist' ? 'pharmacy' : 'inpatient'}`)
      if (role === 'pharmacist') await selectWorkspaceMode(page, '住院')
    },
    appearance: async theme => {
      await page.getByRole('button', { name: '用户菜单' }).click()
      await page.getByRole('menuitemradio', { name: theme === 'dark' ? '暗色' : '亮色', exact: true }).click()
      await page.keyboard.press('Escape')
      await expect(page.locator('.clinmesh-web-root')).toHaveAttribute('data-theme', theme)
    },
  })
})
