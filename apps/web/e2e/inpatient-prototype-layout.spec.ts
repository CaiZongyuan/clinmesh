import { expect } from '@playwright/test'
import { test } from './inpatient-drg.fixture.ts'
import { runInpatientPrototypeMatrix } from './inpatient-prototype-layout.journey.ts'
import { selectWorkspaceMode } from './inpatient-ui.ts'

test('七岗位Web真实入口在两档宽度及明暗主题对照住院原型，并连续发药', async ({ page, browserApp }, info) => {
  test.setTimeout(180_000)
  await runInpatientPrototypeMatrix(page, browserApp, info, { prefix: 'web',
    mount: async role => {
      await page.goto(`${browserApp.origin}/${role === 'registrar' ? 'registration' : role === 'pharmacist' ? 'pharmacy' : 'inpatient'}`)
      await expect(page.getByRole('button', { name: '用户菜单', exact: true })).toBeVisible()
      if (['registrar', 'cashier', 'pharmacist'].includes(role)) await selectWorkspaceMode(page, '住院')
    },
    appearance: async theme => {
      await page.getByRole('button', { name: '用户菜单', exact: true }).click()
      await page.getByRole('menuitemradio', { name: theme === 'light' ? '亮色' : '暗色', exact: true }).click()
      await page.keyboard.press('Escape')
    },
  })
})
