import { test, loginPciBrowser } from '../../../web/e2e/inpatient-pci.fixture.ts'
import { runPciBrowserJourney } from '../../../web/e2e/inpatient-pci.journey.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`PCI golden journey React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientPciFixture(version) })
  test('生产住院工作台在 ShadowRoot 贯通 PCI 归档、12000元核定与更正退款', async ({ page, pciApp: app }) => {
    test.setTimeout(180_000)
    await page.route(`${app.origin}/pci-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await runPciBrowserJourney(page, app, async (role, name) => {
      await loginPciBrowser(page, app, role)
      await page.goto(`${app.origin}/pci-contract`)
      await page.setContent(`<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
      // 护士一览板床位格与医生三栏列表以患者名定位；其余岗位保留表格"查看"按钮
      if (role === 'ward-nurse' || role === 'inpatient-doctor' || role === 'medical-insurance') await page.getByRole('button', { name: new RegExp(name) }).click()
      else await page.getByRole('button', { name: `查看${name}`, exact: true }).click()
    })
  })
})
