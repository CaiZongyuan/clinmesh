import { test, loginPciBrowser } from './inpatient-pci.fixture.ts'
import { runPciBrowserJourney } from './inpatient-pci.journey.ts'

test('真实 Web PCI 黄金主线贯通实际手术、医保结算、归档核定与更正退款', async ({ page, pciApp: app }) => {
  test.setTimeout(180_000)
  await runPciBrowserJourney(page, app, async (role, name) => {
    await loginPciBrowser(page, app, role)
    await page.goto(`${app.origin}/${role === 'cashier' ? 'billing' : 'inpatient'}`)
    if (role === 'cashier') await page.getByRole('tab', { name: '住院费用', exact: true }).click()
    // 护士一览板床位格与医生三栏列表以患者名定位；其余岗位保留表格"查看"按钮
    if (role === 'ward-nurse' || role === 'inpatient-doctor') await page.getByRole('button', { name: new RegExp(name) }).click()
    else await page.getByRole('button', { name: `查看${name}`, exact: true }).click()
  })
})
