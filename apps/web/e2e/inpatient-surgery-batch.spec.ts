import { test, expect } from './inpatient-drg.fixture.ts'
import { prepareSurgeryBatchPatient, runSurgeryBatchJourney, runSurgeryBatchConflictJourney } from './inpatient-surgery-batch.journey.ts'

test('同一患者连续双材整台补录、私稿刷新、余量全选清空及双回执恢复', async ({ page, browserApp }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const s = await prepareSurgeryBatchPatient(page, browserApp)
  await runSurgeryBatchJourney(page, s, async () => { await page.goto(`${browserApp.origin}/inpatient`) }, async caption => {
    if (!caption.startsWith('目录搜索时完整清单')) return
    await page.setViewportSize({ width: 480, height: 900 })
    await page.evaluate(() => { document.documentElement.style.zoom = '1.25' })
    const picker = page.getByRole('dialog', { name: '选择最终耗材', exact: true })
    const selected = picker.getByRole('region', { name: '完整待提交耗材清单', exact: true })
    const footer = picker.getByRole('button', { name: '完成选择', exact: true })
    const footerBefore = await footer.boundingBox()
    await selected.locator(':scope > div').evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect(selected.getByRole('button', { name: '移除此新增项 4', exact: true })).toBeInViewport()
    await expect(footer).toBeInViewport()
    expect(await footer.boundingBox()).toEqual(footerBefore)
    expect(await picker.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth
    })).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.evaluate(() => { document.documentElement.style.zoom = '' })
    await page.setViewportSize({ width: 1280, height: 720 })
  })
  expect(errors).toEqual([])
})

test('所选预留被另一操作释放后真实409保留整台私稿且没有部分费用', async ({ page, browserApp }) => {
  const s = await prepareSurgeryBatchPatient(page, browserApp)
  await runSurgeryBatchConflictJourney(page, s, async () => { await page.goto(`${browserApp.origin}/inpatient`) })
})
