import { expect, test } from '../../../web/e2e/inpatient-drg.fixture.ts'
import { prepareSurgeryMaterialsPatient, runSurgeryMaterialsJourney, prepareFinalMaterialsPatient, runFinalMaterialsJourney } from '../../../web/e2e/inpatient-surgery-materials.journey.ts'
import { buildInpatientDrgFixture } from './inpatient-drg.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`React ${version} Surface手术耗材`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientDrgFixture>>
  test.beforeAll(async () => {
    test.setTimeout(60_000)
    artifact = await buildInpatientDrgFixture(version)
  })

  test('术中逐笔耗材、更正与完成保持同一手术', async ({ page, browserApp }) => {
    test.setTimeout(60_000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const s = await prepareSurgeryMaterialsPatient(page, browserApp)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.route(`${browserApp.origin}/surgery-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await runSurgeryMaterialsJourney(page, s, async () => {
      await page.goto(`${browserApp.origin}/surgery-contract`)
      await page.setContent(`<!doctype html><html data-view="workspace"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    })
    expect(errors).toEqual([])
  })

  test('一处核实最终用量及预留差额并恢复原回执', async ({ page, browserApp }) => {
    test.setTimeout(60_000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const s = await prepareFinalMaterialsPatient(page, browserApp)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.route(`${browserApp.origin}/surgery-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await runFinalMaterialsJourney(page, s, async () => {
      await page.goto(`${browserApp.origin}/surgery-contract`)
      await page.setContent(`<!doctype html><html data-view="workspace"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    })
    expect(errors).toEqual([])
  })
})
