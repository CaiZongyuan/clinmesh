import { expect, type Page } from '@playwright/test'
import { inpatientCatalogSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'

/** 通过公开住院状态与真实床位行证明清床，不把已释放床位描述为尚未分床。 */
export async function expectInpatientBedCleared(page: Page, origin: string, admissionPath: string) {
  await expect.poll(async () => {
    const { admission } = inpatientDetailSchema.parse(await (await page.request.get(`${origin}${admissionPath}`)).json())
    return { status: admission.status, bedId: admission.bedId ?? null }
  }).toEqual({ status: 'cleared', bedId: null })
  const toggle = page.getByRole('button', { name: '展开队列', exact: true })
  if (await toggle.isVisible()) await toggle.click()
  const catalog = inpatientCatalogSchema.parse(await (await page.request.get(origin + '/api/his/v1/inpatient/catalog')).json())
  const released = catalog.beds.find(bed => bed.id === 'bed-general-1')!
  const bed = page.getByRole('region', { name: '住院病区', exact: true }).getByRole('listitem').filter({ hasText: new RegExp('^' + released.name + '\\s*空床') })
  await expect(bed).toHaveCount(1)
  await bed.scrollIntoViewIfNeeded()
  await expect(bed).toContainText('空床')
  await expect(bed).toContainText(new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(released.dailyPriceFen / 100) + '/日')
}
