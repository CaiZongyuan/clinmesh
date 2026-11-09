import { confirmDoctorPreparationResponseSchema } from '@clinmesh/contracts/doctor-recommendations'
import { test as base, expect } from './fixtures.ts'
import { openDoctorFirstVisit, readDoctorBillingCase, startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { openWorkspaceTab } from './workspace-tabs.fixture.ts'

const test = base.extend<{ pathologyServer: Awaited<ReturnType<typeof startInvestigationBillingServer>> }>({
  pathologyServer: async ({ webRoot }, use) => {
    const server = await startInvestigationBillingServer(webRoot, true, true)
    try { await use(server) } finally { await server.close() }
  },
})

test('restores two manual pathology drafts and recovers a partial confirmation without repeating its successful request or charge', async ({ page, pathologyServer: server }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const pixels: string[] = []
  await page.route('**/api/his/v1/imaging-studies/**', async route => { pixels.push(route.request().url()); await route.abort() })
  await openDoctorFirstVisit(page, server)
  const enter = async () => {
    await openWorkspaceTab(page, '检验检查')
    await page.getByRole('tab', { name: /^病理会诊 \d+$/ }).click()
  }
  await enter()
  const pending = page.getByRole('region', { name: '待开具病理会诊', exact: true })
  await pending.getByRole('button', { name: '添加病理会诊', exact: true }).click()
  const composer = page.getByRole('dialog', { name: '选择病理会诊', exact: true })
  for (const [name, purpose] of [['乳腺切片病理会诊', '复核第一台手术的病理类型。'], ['合成第二病理会诊', '核对第二台手术切缘。']]) {
    await composer.getByRole('button', { name: new RegExp(`^${name}`) }).click()
    if (name === '合成第二病理会诊') {
      await composer.getByRole('combobox', { name: '送检的既往手术', exact: true }).click()
      await page.getByRole('option', { name: /合成乳腺病灶切除术/ }).click()
    }
    await composer.getByLabel('会诊目的', { exact: true }).fill(purpose!)
    await composer.getByRole('button', { name: '加入病理会诊', exact: true }).click()
    await expect(composer).toBeVisible()
  }
  await composer.getByRole('button', { name: '关闭', exact: true }).click()
  await page.reload()
  await enter()
  await expect(pending.getByRole('checkbox')).toHaveCount(2)
  await expect(pending.getByText('复核第一台手术的病理类型。', { exact: true })).toBeVisible()
  await expect(pending.getByText('核对第二台手术切缘。', { exact: true })).toBeVisible()
  expect((await readDoctorBillingCase(page, server)).pathologyRequests?.requests).toHaveLength(0)
  const changed = server.runtime.database.driver.prepare(`UPDATE hospital_service_catalog SET version=version+1,
    config_json=json_set(config_json, '$.pathologyService.version', version+1,
      '$.pathologyService.outpatientBilling.version', 2, '$.pathologyService.outpatientBilling.priceFen', 21000)
    WHERE service_id='synthetic-pathology-second'`).run()
  expect(changed.changes).toBe(1)
  const posts: Array<{ key: string | undefined; body: unknown }> = []
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/recommendations/pathology/actions/confirm')) {
      posts.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() })
    }
  })
  await page.route('**/recommendations/pathology/actions/confirm', async route => {
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    await route.abort('failed')
  }, { times: 1 })
  await pending.getByRole('button', { name: '开具选中项目（2）', exact: true }).click()
  await expect(pending.getByRole('button', { name: '恢复原开立', exact: true })).toBeVisible()
  await expect(pending.getByRole('button', { name: '恢复原开立', exact: true })).toBeEnabled()
  expect((await readDoctorBillingCase(page, server)).pathologyRequests?.requests).toHaveLength(1)
  await page.reload()
  await enter()
  const receipt = page.waitForResponse(response => response.url().includes('/recommendations/pathology/confirmations/'))
  await pending.getByRole('button', { name: '恢复原开立', exact: true }).click()
  const result = confirmDoctorPreparationResponseSchema.parse(await (await receipt).json()).data
  expect(result.results?.map(item => item.status)).toEqual(['succeeded', 'failed'])
  expect((await receipt).url()).toContain(posts[0]!.key!)
  expect(posts).toHaveLength(1)
  await expect(pending.getByText('成功 1 项，失败 1 项。失败输入已保留。', { exact: true })).toBeVisible()
  await expect(pending.getByRole('checkbox')).toHaveCount(1)
  await expect(pending.getByRole('checkbox', { name: '选择合成第二病理会诊', exact: true })).toBeChecked()
  await pending.getByRole('button', { name: '添加病理会诊', exact: true }).click()
  await composer.getByRole('button', { name: /^合成第二病理会诊/ }).click()
  await expect(composer.getByText('¥210.00 / 次会诊 × 1', { exact: true })).toBeVisible()
  await composer.getByRole('combobox', { name: '送检的既往手术', exact: true }).click()
  await page.getByRole('option', { name: /合成乳腺病灶切除术/ }).click()
  await composer.getByLabel('会诊目的', { exact: true }).fill('核对第二台手术切缘。')
  await composer.getByRole('button', { name: '加入病理会诊', exact: true }).click()
  await composer.getByRole('button', { name: '关闭', exact: true }).click()
  await pending.getByRole('button', { name: '开具选中项目（1）', exact: true }).click()
  await expect.poll(async () => (await readDoctorBillingCase(page, server)).pathologyRequests?.requests.length).toBe(2)
  expect(posts).toHaveLength(2)
  expect(posts[1]!.key).not.toBe(posts[0]!.key)
  const records = (await readDoctorBillingCase(page, server)).pathologyRequests!.requests
  expect(new Set(records.map(item => item.service.id)).size).toBe(2)
  expect(new Set(records.map(item => item.sourceProcedure.sourceReference)).size).toBe(2)
  expect(records.map(item => item.purpose).sort()).toEqual(['复核第一台手术的病理类型。', '核对第二台手术切缘。'].sort())
  expect(new Set(records.map(item => item.billing?.chargeItemId)).size).toBe(2)
  expect(records.map(item => item.billing?.remainingFen).sort()).toEqual([20000, 21000].sort())
  await page.reload()
  await enter()
  await expect(pending.getByRole('checkbox')).toHaveCount(0)
  expect((await readDoctorBillingCase(page, server)).pathologyRequests?.requests).toHaveLength(2)
  expect(pixels).toEqual([])
})
