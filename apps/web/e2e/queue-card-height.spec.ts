import { expect, test } from './fixtures.ts'
import { expectQueueCardBounds, expectQueueToggle, expectTriageQueueSelection, prepareTriageQueue, queueCardRoles } from './queue-card.journey.ts'

for (const [role, route, region] of queueCardRoles) test(`队列卡片铺满实际工作台：${role}`, async ({ page, browserApp }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${browserApp.origin}/${route}`)
  await page.getByLabel('账户邮箱').fill(`${role}@demo.clinmesh.local`)
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  if (region) await expect(page.getByRole('region', { name: region, exact: true })).toBeVisible()
  for (const width of [1440, 1101, 826]) {
    await page.setViewportSize({ width, height: 900 })
    for (const label of ['亮色', '暗色']) {
      await page.getByRole('button', { name: '用户菜单' }).click()
      await page.getByRole('menuitemradio', { name: label, exact: true }).click()
      await page.keyboard.press('Escape')
      await expectQueueCardBounds(page)
    }
  }
  await expectQueueToggle(page, width => page.setViewportSize({ width, height: 900 }))
})

for (const count of [1, 10]) test(`${count} 人分诊队列卡片等高、末尾可达，窄屏选择后关闭浮层`, async ({ page, browserApp }) => {
  await prepareTriageQueue(page, browserApp, count)
  await page.setViewportSize({ width: 1440, height: 600 })
  await page.goto(`${browserApp.origin}/triage`)
  await page.getByLabel('账户邮箱').fill('triage@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expectTriageQueueSelection(page, width => page.setViewportSize({ width, height: 600 }), count)
})
