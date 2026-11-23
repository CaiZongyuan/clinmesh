import { authoredCasePackPrepareResponseSchema, authoredCasePackSummarySchema } from '@clinmesh/contracts/inpatient-pci-data'
import { expect, test } from './fixtures.ts'

test('管理员从模拟数据页面准备两例病理病例，丢响应先读原回执，整页刷新后重复准备保留身份', async ({ page, browserApp }) => {
  const modelRequests: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && /\/(patient-persona-jobs|generation-jobs)$/.test(new URL(request.url()).pathname)) modelRequests.push(request.url())
  })
  await page.setViewportSize({ width: 1100, height: 900 })
  await page.goto(`${browserApp.origin}/scenario-data`)
  await page.getByLabel('账户邮箱').fill('admin@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByText('病理覆盖清单', { exact: true }).click()
  const section = page.getByRole('region', { name: '病理病例包准备', exact: true })
  await expect(section).toContainText('既往结直肠息肉切除切片会诊')
  await expect(section).toContainText('既往甲状腺手术切片会诊')
  await expect(section).toContainText('0/2 例已就绪')
  let posts = 0, originalKey = '', receiptReads = 0
  const base = '/api/sim/v1/admin/pathology-case-pack'
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname === '/api/his/v1/command-receipts' && url.searchParams.get('idempotencyKey') === originalKey) receiptReads++
  })
  await page.route(`**${base}/prepare`, async route => {
    posts++
    originalKey = route.request().headers()['idempotency-key']!
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    expect(authoredCasePackPrepareResponseSchema.parse(await response.json()).data.readyCount).toBe(2)
    await route.abort('failed')
  })
  await section.getByRole('button', { name: '准备病理病例包（2 例）', exact: true }).click()
  await expect(section.getByRole('button', { name: '恢复原病理病例准备', exact: true })).toBeVisible()
  await expect(section.getByRole('button', { name: '准备病理病例包（2 例）', exact: true })).toBeDisabled()
  await section.getByRole('button', { name: '恢复原病理病例准备', exact: true }).click()
  await expect(section).toContainText('2/2 例已就绪')
  expect([posts, receiptReads]).toEqual([1, 1])
  await page.unroute(`**${base}/prepare`)
  const original = authoredCasePackSummarySchema.parse(await (await page.request.get(`${browserApp.origin}${base}`)).json())
  await page.reload()
  await page.getByText('病理覆盖清单', { exact: true }).click()
  await expect(section).toContainText('2/2 例已就绪')
  await section.getByRole('button', { name: '准备病理病例包（2 例）', exact: true }).click()
  await expect(section.getByRole('button', { name: '准备病理病例包（2 例）', exact: true })).toBeEnabled()
  const repeated = authoredCasePackSummarySchema.parse(await (await page.request.get(`${browserApp.origin}${base}`)).json())
  expect(repeated.cases.map(item => item.case)).toEqual(original.cases.map(item => item.case))
  expect(modelRequests).toEqual([])
})
