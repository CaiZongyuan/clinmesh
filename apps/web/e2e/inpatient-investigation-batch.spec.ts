import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
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
