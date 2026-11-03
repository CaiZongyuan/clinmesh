import { test, expect } from './inpatient-drg.fixture.ts'
import { runInpatientDoctorPages } from './inpatient-doctor-pages.journey.ts'
import { selectWorkspaceMode } from './inpatient-ui.ts'

test('住院医生六页按原型组织正文，次级入口与草稿在宽窄明暗下保留', async ({ page, browserApp }, info) => {
  test.setTimeout(120_000)
  await runInpatientDoctorPages(page, browserApp, {
    mount: async role => {
      await page.goto(`${browserApp.origin}/${role === 'cashier' ? 'billing' : 'inpatient'}`)
      await expect(page.getByRole('button', { name: '用户菜单', exact: true })).toBeVisible()
      if (role === 'cashier') await selectWorkspaceMode(page, '住院')
    },
    ...(process.env.CLINMESH_CAPTURE_INPATIENT_PAGES === '1' ? { capture: async (name: string) => {
      const targets = process.env.CLINMESH_CAPTURE_INPATIENT_TARGETS?.split(',')
      if (targets && !targets.includes(name)) return
      const path = info.outputPath(`${name}-1101-light.png`)
      await page.locator('.clinmesh-card-workspace').screenshot({ path, animations: 'disabled' })
      await info.attach(`${name}-${process.env.CLINMESH_CAPTURE_SOURCE_SHA ?? 'unknown-source'}`, { path, contentType: 'image/png' })
    } } : {}),
    appearance: async theme => {
      await page.getByRole('button', { name: '用户菜单', exact: true }).click()
      await page.getByRole('menuitemradio', { name: theme === 'light' ? '亮色' : '暗色', exact: true }).click()
      await page.keyboard.press('Escape')
    },
  })
})
