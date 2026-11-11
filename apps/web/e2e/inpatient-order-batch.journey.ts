import type { Page } from '@playwright/test'
import { inpatientFullCatalogSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { createDrgBrowserPatient, expect } from './inpatient-drg.fixture.ts'
import { openQueue } from './queue-overlay.fixture.ts'

/** 原生页面、真实 Command 与回执回读；不读取影像或切片。 */
export async function runInpatientOrderBatchJourney(page: Page, app: { origin: string }, subject: Awaited<ReturnType<typeof createDrgBrowserPatient>>,
  step: (text: string) => Promise<void> = async () => undefined) {
  const catalog = inpatientFullCatalogSchema.parse(await (await subject.api.get('/api/his/v1/inpatient/clinical-catalog')).json())
  const rejected = catalog.medications.find(item => item.id === 'medication-metformin')!
  const medication = catalog.medications.find(item => item.id === 'medication-amlodipine')!
  const service = catalog.services[0]!
  expect(rejected).toBeDefined(); expect(medication).toBeDefined()
  const read = async () => inpatientFullClinicalSchema.parse(await (await page.request.get(app.origin + subject.path + '/clinical')).json())
  let posts = 0, receiptReads = 0, originalKey: string | undefined, originalBody: unknown
  page.on('request', request => { if (request.url().includes('/command-receipts?')) receiptReads++ })
  await page.route(`**${subject.path}/orders/issue`, async route => {
    posts++
    const input = route.request().postDataJSON().input
    const response = await route.fetch()
    if (input.selection.kind === 'service') {
      expect(response.status()).toBe(200)
      originalKey = route.request().headers()['idempotency-key']; originalBody = input
      await route.abort('failed')
    } else await route.fulfill({ response })
  })
  await page.goto(`${app.origin}/inpatient`)
  await openQueue(page)
  await page.getByRole('button', { name: `查看${subject.name}`, exact: true }).click()
  await expect(page.getByLabel('医嘱项目', { exact: true })).toHaveCount(0)
  await step('01 · 页面只留开立入口，药品与护理在同一弹窗连续加入')
  await page.getByRole('button', { name: '开立医嘱', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '开立医嘱', exact: true })
  await dialog.getByLabel('医嘱项目', { exact: true }).fill(rejected.display)
  await dialog.getByRole('button', { name: `选择${rejected.display}`, exact: true }).click()
  await dialog.getByLabel('医嘱项目', { exact: true }).fill(service.display)
  await dialog.getByRole('button', { name: `选择${service.display}`, exact: true }).click()
  await expect(dialog.getByRole('button', { name: '开立所选医嘱（2）', exact: true })).toBeInViewport()
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  const drug = dialog.getByRole('region', { name: `待开：${rejected.display}`, exact: true })
  await drug.getByRole('group', { name: '医嘱时效', exact: true }).getByRole('button', { name: '临时', exact: true }).click()
  const nursing = dialog.getByRole('region', { name: `待开：${service.display}`, exact: true })
  await nursing.getByRole('group', { name: '医嘱时效', exact: true }).getByRole('button', { name: '长期', exact: true }).click()
  await step('02 · 每条时效、剂量和频次独立；关闭及刷新保留两条草稿')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.reload()
  await openQueue(page)
  await page.getByRole('button', { name: `查看${subject.name}`, exact: true }).click()
  await page.getByRole('button', { name: '开立医嘱', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '开立医嘱', exact: true })
  await expect(dialog.getByRole('checkbox')).toHaveCount(2)
  await expect(drug.getByRole('button', { name: '临时', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await dialog.getByRole('button', { name: '开立所选医嘱（2）', exact: true }).click()
  await expect(dialog.getByRole('region', { name: `待开：${rejected.display}`, exact: true }).getByRole('alert')).toContainText('适应症')
  await expect(dialog.getByRole('button', { name: `恢复原开立：${service.display}`, exact: true })).toBeEnabled()
  expect(posts).toBe(2)
  expect((await read()).orders).toHaveLength(1)
  expect(originalKey).toBeTruthy(); expect(originalBody).toMatchObject({ selection: { kind: 'service', serviceId: service.id } })
  await step('03 · 药品适应症拒绝保留原行；护理已生效但响应丢失，停止队列')
  await page.reload()
  await openQueue(page)
  await page.getByRole('button', { name: `查看${subject.name}`, exact: true }).click()
  await page.getByRole('button', { name: '开立医嘱', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '开立医嘱', exact: true })
  await dialog.getByRole('button', { name: `恢复原开立：${service.display}`, exact: true }).click()
  await expect(dialog.getByText('已成功开立 1 项', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '开立所选医嘱（1）', exact: true })).toBeEnabled()
  expect(posts).toBe(2); expect(receiptReads).toBe(1)
  const receipt = await page.request.get(`${app.origin}/api/his/v1/command-receipts?${new URLSearchParams({ operationId: 'inpatient.order.issue', idempotencyKey: originalKey! })}`)
  expect(receipt.status()).toBe(200)
  await step('04 · 刷新后读取原回执恢复护理，不重发成功项；修正失败药品')
  await drug.getByRole('button', { name: '移除项目', exact: true }).click()
  await dialog.getByLabel('医嘱项目', { exact: true }).fill(medication.display)
  await dialog.getByRole('button', { name: `选择${medication.display}`, exact: true }).click()
  const corrected = dialog.getByRole('region', { name: `待开：${medication.display}`, exact: true })
  await corrected.getByLabel('每次剂量', { exact: true }).fill(`1${medication.unit}`)
  await corrected.getByRole('button', { name: '临时', exact: true }).click()
  await dialog.getByRole('button', { name: '开立所选医嘱（1）', exact: true }).click()
  await expect(dialog.getByText('已成功开立 2 项', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  const result = await read()
  expect(posts).toBe(3)
  expect(result.orders).toHaveLength(2)
  expect(result.orders.every(order => order.state === 'signed')).toBe(true)
  expect(result.orders.find(order => order.kind === 'medication')).toMatchObject({ catalogItemId: medication.id, doseQuantity: 1, duration: 'temporary' })
  expect(result.orders.find(order => order.kind === 'service')).toMatchObject({ catalogItemId: service.id, duration: 'long' })
  expect(result.executions).toEqual([]); expect(result.dispenses).toEqual([]); expect(result.chargesFen).toBe(0)
  await expect(page.getByRole('region', { name: '住院医嘱', exact: true }).getByText('待校对', { exact: true })).toHaveCount(2)
  await step('05 · 两条正式医嘱均待护士校对；未生成给药、教育、发药或费用事实')
  return { posts, receiptReads, originalKey, orders: result.orders.map(order => ({ id: order.id, display: order.display, state: order.state })), executions: result.executions.length, chargesFen: result.chargesFen }
}
