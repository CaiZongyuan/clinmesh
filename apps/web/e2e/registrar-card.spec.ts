import { registrationCatalogSchema, registrationQueueSchema } from '@clinmesh/contracts/his'
import { expect, test } from './fixtures.ts'

test('registers from the queue card, keeps the container layout and reports visit-number copy failure', async ({ page, browserApp }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', { value: async () => { throw new DOMException('Clipboard rejected', 'NotAllowedError') } })
  })
  await page.goto(`${browserApp.origin}/registration`)
  await page.getByLabel('账户邮箱').fill('registrar@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  const queue = page.getByRole('region', { name: '患者选择', exact: true })
  // Below 800px the queue is an overlay; the create form inside it must still submit from the action bar.
  await page.setViewportSize({ width: 760, height: 900 })
  await expect(queue).toHaveCount(0)
  await page.getByRole('button', { name: '展开队列', exact: true }).click()
  for (const label of ['待挂号', '检索', '建档']) await expect(queue.getByRole('tab', { name: label, exact: true })).toBeVisible()
  await queue.getByRole('tab', { name: '建档', exact: true }).click()
  await queue.getByLabel('姓名', { exact: true }).fill('卡片挂号合成患者')
  await queue.getByLabel('临时患者标识', { exact: true }).fill('SYN-REGISTRAR-CARD')
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '创建临时患者', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前患者', exact: true })).toContainText('卡片挂号合成患者')
  const form = page.getByRole('region', { name: '挂号信息', exact: true })
  const records = page.getByRole('region', { name: '挂号记录', exact: true })
  const catalog = registrationCatalogSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/catalogs/registration`)).json())
  await expect(form.getByLabel('就诊日期', { exact: true })).toHaveValue(catalog.virtualDate)
  await expect(form.getByLabel('就诊日期', { exact: true })).not.toBeEditable()
  for (const width of [1101, 826, 760]) {
    await page.setViewportSize({ width, height: 900 })
    if (width >= 800) await expect(queue).toBeVisible()
    else await expect(queue).toHaveCount(0)
    const main = await form.boundingBox(), below = await records.boundingBox()
    // Records share the main card under the registration form; there is no right column.
    expect(below!.y).toBeGreaterThan(main!.y)
    if (width >= 800) expect(main!.x).toBeGreaterThan((await queue.boundingBox())!.x)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  }
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认挂号', exact: true }).click()
  // The toast names the result and who receives the patient next.
  await expect(page.getByText('已交给分诊护士接诊', { exact: true })).toBeVisible()
  const registrations = registrationQueueSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/registrations`)).json())
  const registration = registrations.items.find(item => item.patient.identifier === 'SYN-REGISTRAR-CARD')!
  expect(registration.registrationNumber).toMatch(/^CM-OP-/)
  expect(registration.status).toBe('awaiting-triage')
  await records.getByRole('button', { name: `复制门诊号 ${registration.registrationNumber}`, exact: true }).click()
  await expect(records.getByRole('alert')).toContainText('复制失败，请手动选择门诊号复制')
})
