import { inpatientInvestigationCatalogSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { test, expect } from './inpatient-investigation.fixture.ts'
import { prepareInpatientInvestigations } from './inpatient-investigation-batch.journey.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

test('同类住院检查连续添加、刷新草稿、部分成功及原回执恢复不重复开单', async ({ page, browserApp, source }) => {
  const { admission, path } = await prepareInpatientInvestigations(page, browserApp, source)
  const open = async () => {
    await page.goto(`${browserApp.origin}/inpatient`)
    await page.getByRole('button', { name: `查看${admission.patientName}`, exact: true }).click()
    await selectInpatientStage(page, '检查检验')
    await page.getByRole('button', { name: '开立住院检查', exact: true }).click()
    return page.getByRole('dialog', { name: '开立住院检查', exact: true })
  }
  let dialog = await open()
  await dialog.getByRole('button', { name: '选择合成白细胞计数', exact: true }).click()
  await dialog.getByRole('button', { name: '选择合成血红蛋白', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '开立所选检验（2）', exact: true })).toBeEnabled()
  await page.reload()
  dialog = await open()
  await expect(dialog.getByRole('checkbox')).toHaveCount(2)
  const posts: string[] = []
  await page.route(`**${path}/investigations/issue`, async route => {
    posts.push(route.request().headers()['idempotency-key']!)
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    if (posts.length === 2) await route.abort('failed')
    else await route.fulfill({ response })
  })
  await dialog.getByRole('button', { name: '开立所选检验（2）', exact: true }).click()
  await expect(dialog).toContainText('已成功开立 1 项')
  await expect(dialog).toContainText('结果待确认，请恢复原操作')
  expect(posts).toHaveLength(2)
  expect(new Set(posts).size).toBe(2)
  await page.reload()
  dialog = await open()
  await dialog.getByRole('button', { name: '恢复原开立：合成血红蛋白', exact: true }).click()
  await expect(dialog).toContainText('已成功开立 2 项')
  await expect(dialog.getByRole('checkbox')).toHaveCount(0)
  expect(posts).toHaveLength(2)
  const state = inpatientInvestigationsSchema.parse(await (await page.request.get(`${browserApp.origin}${path}/investigations`)).json())
  expect(state.laboratoryRequests).toHaveLength(2)
  expect(state.laboratoryRequests.every(request => request.status === 'issued')).toBe(true)
  expect(state.sent).toEqual([])
})

test('目录冲突后暂停后续开立，刷新重选再提交且不重复生成申请', async ({ page, browserApp, source }) => {
  const { admission, path } = await prepareInpatientInvestigations(page, browserApp, source)
  const catalog = inpatientInvestigationCatalogSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/inpatient/investigation-catalog`)).json())
  const changed = catalog.items.find(item => item.display === '合成白细胞计数')!
  await page.goto(`${browserApp.origin}/inpatient`)
  await page.getByRole('button', { name: `查看${admission.patientName}`, exact: true }).click()
  await selectInpatientStage(page, '检查检验')
  await page.getByRole('button', { name: '开立住院检查', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '开立住院检查', exact: true })
  await dialog.getByRole('button', { name: '选择合成白细胞计数', exact: true }).click()
  await dialog.getByRole('button', { name: '选择合成血红蛋白', exact: true }).click()
  // 模拟另一位目录维护者的并发更新；结果只通过真实页面与公开 HTTP 验证。
  browserApp.runtime.database.driver.prepare(`UPDATE hospital_service_catalog
    SET version=version+1, config_json=json_set(config_json,'$.laboratoryService.version',version+1)
    WHERE service_id=?`).run(changed.id)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route(`**${path}/investigations/issue`, async route => { await held; await route.continue() })
  await dialog.getByRole('button', { name: '开立所选检验（2）', exact: true }).click()
  const busy = dialog.getByRole('button', { name: '正在开立…', exact: true })
  try {
    await expect(busy).toBeDisabled()
    await expect(busy).toHaveAttribute('aria-busy', 'true')
    await expect(busy.locator('[data-slot="spinner"]')).toBeVisible()
    expect(await busy.evaluate(element => getComputedStyle(element).borderTopStyle)).not.toBe('dashed')
  } finally { release() }
  await expect(dialog).toContainText('目录或价格已变化，请移除后重新选择')
  await expect(dialog.getByRole('checkbox')).toHaveCount(2)
  const beforeRetry = inpatientInvestigationsSchema.parse(await (await page.request.get(`${browserApp.origin}${path}/investigations`)).json())
  expect(beforeRetry.laboratoryRequests).toHaveLength(0)
  await dialog.getByRole('button', { name: '刷新目录', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '刷新目录', exact: true })).toBeEnabled()
  const draft = dialog.getByRole('region', { name: '待开：合成白细胞计数', exact: true })
  await draft.getByRole('button', { name: '移除项目', exact: true }).click()
  await dialog.getByRole('button', { name: '选择合成白细胞计数', exact: true }).click()
  await dialog.getByRole('button', { name: '开立所选检验（2）', exact: true }).click()
  await expect(dialog).toContainText('已成功开立 2 项')
  const state = inpatientInvestigationsSchema.parse(await (await page.request.get(`${browserApp.origin}${path}/investigations`)).json())
  expect(state.laboratoryRequests).toHaveLength(2)
  expect(new Set(state.laboratoryRequests.map(request => request.id)).size).toBe(2)
  expect(state.sent).toEqual([])
})
