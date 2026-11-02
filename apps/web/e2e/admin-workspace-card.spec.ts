import { expect, test } from './fixtures.ts'

test('管理员在演示准备与患者库之间切换，保留准备输入和生成入口', async ({ page, browserApp }) => {
  await page.goto(`${browserApp.origin}/scenario-data`)
  await page.getByLabel('账户邮箱').fill('admin@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  const preparation = page.getByRole('tab', { name: '演示准备', exact: true })
  await expect(preparation).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('form', { name: '场景虚拟时间', exact: true })).toBeVisible()
  await page.getByLabel('推进到（北京时间）', { exact: true }).fill('2026-11-01T08:00')
  await page.getByRole('button', { name: '生成患者', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '生成患者', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('tab', { name: '患者库', exact: true }).click()
  await expect(page.getByRole('tabpanel', { name: '患者库', exact: true })).toBeVisible()
  await expect(page.getByRole('form', { name: '场景虚拟时间', exact: true })).toHaveCount(0)
  await preparation.click()
  await expect(page.getByLabel('推进到（北京时间）', { exact: true })).toHaveValue('2026-11-01T08:00')
  await expect(page.getByRole('button', { name: '重置数据', exact: true })).toBeVisible()
})

test('患者列表读取失败不冒充空库，管理员可原位重试', async ({ page, browserApp }) => {
  let attempts = 0
  await page.route(/\/api\/sim\/v1\/synthetic-patients\?/, route => {
    attempts += 1
    return attempts === 1 ? route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Synthetic profile list failure' } } }) : route.continue()
  })
  await page.goto(`${browserApp.origin}/scenario-data`)
  await page.getByLabel('账户邮箱').fill('admin@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('tab', { name: '患者库', exact: true }).click()
  const queue = page.getByRole('region', { name: '患者库队列', exact: true })
  const panel = page.getByRole('tabpanel', { name: '患者库', exact: true })
  await expect(queue.getByText('患者列表读取失败', { exact: true })).toBeVisible()
  await expect(panel.getByText('还没有合成患者', { exact: true })).toHaveCount(0)
  await queue.getByRole('button', { name: '重试患者列表', exact: true }).click()
  await expect(queue.getByText('还没有合成患者', { exact: true })).toBeVisible()
  await expect(panel.getByText('还没有合成患者', { exact: true })).toBeVisible()
  expect(attempts).toBe(2)
})
