import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures.ts'

test('登记员真实入口办理住院，病区护士接诊分床后可查询费用账户', async ({ page, browserApp }) => {
  await page.goto(`${browserApp.origin}/registration`)
  await page.getByLabel('账户邮箱').fill('registrar@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('tab', { name: '住院登记', exact: true })).toBeVisible()
  const name = `合成住院患者${randomUUID().slice(0, 8)}`
  const created = await page.request.post(`${browserApp.origin}/api/his/v1/patients`, {
    headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() },
    data: { expectedVersions: {}, input: { name, gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } },
  })
  expect(created.status()).toBe(200)
  await page.getByRole('tab', { name: '住院登记', exact: true }).click()
  await page.getByLabel('搜索住院患者').fill(name)
  await page.getByRole('button', { name: '搜索患者', exact: true }).click()
  await page.getByLabel('住院患者', { exact: true }).click()
  await page.getByRole('option', { name: new RegExp(name) }).click()
  await page.getByLabel('入院病区').click()
  await page.getByRole('option', { name: '内科病区', exact: true }).click()
  await page.getByLabel('预交金（元）').fill('1000.00')
  await page.getByRole('button', { name: '办理住院', exact: true }).click()
  await expect(page.getByRole('cell', { name, exact: true })).toBeVisible()
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()
  await page.getByLabel('账户邮箱').fill('ward-nurse@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('button', { name: `查看${name}`, exact: true }).click()
  await page.getByLabel('目标床位').click()
  await page.getByRole('option', { name: /1床/ }).click()
  await page.getByRole('button', { name: '接诊并分床', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('操作成功')
  await expect(page.getByText('当前床位：1床', { exact: true })).toBeVisible()
})
