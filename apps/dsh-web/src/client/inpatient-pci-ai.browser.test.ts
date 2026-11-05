import { expect, test } from '../../../web/e2e/inpatient-pci-ai.fixture.ts'
import { capturePciAiReviewLayouts, preparePciAiReview, runPciAiConfirmHandoffJourney, runPciAiFrozenJourney, runPciAiJourney, runPciAiMissingUnitJourney, runPciAiSaveConcurrencyJourney } from '../../../web/e2e/inpatient-pci-ai.journey.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

test.describe.configure({ mode: 'default' })

for (const version of ['18', '19']) test.describe(`PCI AI review React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => { artifact = await buildInpatientPciFixture(version) })
  test.beforeEach(async ({ page, pciAiApp }) => {
    test.setTimeout(60_000)
    await page.route(`${pciAiApp.origin}/inpatient`, route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><style>${artifact.styles}</style></head><body style="margin:0"><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>` }))
  })
  test('ShadowRoot造影来源、指南原文、一次确认和术中术后费用贯通', async ({ page, pciAiApp }) => {
    await runPciAiJourney(page, pciAiApp)
  })
  test('ShadowRoot确认已落库但回执未完成时先等待再切换岗位', async ({ page, pciAiApp }) => {
    await runPciAiConfirmHandoffJourney(page, pciAiApp)
  })
  test('ShadowRoot保存期间连续输入不锁卡，晚到回执保留新说明与当前元数据', async ({ page, pciAiApp }) => {
    await runPciAiSaveConcurrencyJourney(page, pciAiApp)
  })
  test('ShadowRoot缺单位显式重评仍保留具体缺项与原句', async ({ page, pciAiApp }) => {
    await runPciAiMissingUnitJourney(page, pciAiApp)
  })
  test('ShadowRoot开始手术后的指南历史只读不重评或重发', async ({ page, pciAiApp }) => {
    await runPciAiFrozenJourney(page, pciAiApp)
  })
  test('ShadowRoot新增审阅区三档宽度与浅深主题保持布局及确认条', async ({ page, pciAiApp }) => {
    const { panel } = await preparePciAiReview(page, pciAiApp)
    const calls = [...pciAiApp.calls]
    const layouts = await capturePciAiReviewLayouts(page, panel)
    expect(layouts).toHaveLength(6)
    expect(pciAiApp.calls).toEqual(calls)
  })
})
