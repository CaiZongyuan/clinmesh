import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { createDrgBrowserPatient, expect, test } from '../../../web/e2e/inpatient-drg.fixture.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)

for (const version of ['18', '19']) test.describe(`报告与执行记录弹窗 React ${version}`, () => {
  let artifact: { code: string; styles: string }
  test.beforeAll(async () => {
    const react = version === '18' ? 'react18' : 'react', reactDom = version === '18' ? 'react-dom18' : 'react-dom'
    const result = await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false }, define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      resolve: { alias: [{ find: /^react$/, replacement: require.resolve(react) }, { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) }, { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) }, { find: /^react-dom$/, replacement: require.resolve(reactDom) }] },
      build: { write: false, lib: { entry: fileURLToPath(new URL('./inpatient-report-dialogs.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'InpatientReportDialogs' } } })
    const chunk = (Array.isArray(result) ? result : [result]).flatMap(item => 'output' in item ? item.output : []).find(item => item.type === 'chunk')
    if (chunk?.type !== 'chunk') throw new Error('Missing inpatient report dialog fixture')
    artifact = { code: chunk.code, styles: await buildSurfaceStyles() }
  })

  test('ShadowRoot 中全文和执行记录支持键盘、焦点归还与宽窄明暗中英文', async ({ page, browserApp }) => {
    test.setTimeout(120_000)
    const subject = await createDrgBrowserPatient(page, browserApp, '合成报告阅读患者')
    const clinical = () => subject.api.get(`${subject.path}/clinical`).then(response => response.json()).then(value => inpatientFullClinicalSchema.parse(value))
    expect((await subject.api.post(`${subject.path}/orders/issue`, { encounterVersion: (await clinical()).encounterVersion, duration: 'temporary',
      selection: { kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1, doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' } })).status()).toBe(200)
    const order = (await clinical()).orders[0]!
    await subject.api.login('ward-nurse')
    expect((await subject.api.post(`${subject.path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })).status()).toBe(200)
    await subject.api.login('inpatient-doctor')
    const report = { diagnosticReportId: 'synthetic-report', diagnosticReportVersion: '1', issuedAt: '2026-08-24T09:40:00+08:00', revisionNumber: 1, specimenId: 'synthetic-specimen', status: 'final', conclusion: '合成当前报告结论',
      acknowledgement: { id: 'synthetic-ack', acknowledgedAt: '2026-08-24T10:00:00+08:00', acknowledgedBy: 'synthetic-doctor' },
      results: [{ code: 'synthetic-lab', display: '合成检验指标', value: 11.2, interpretation: 'high', observationId: 'synthetic-observation', referenceRange: { high: 10, text: '4–10' }, unit: { code: '10*9/L', display: '10^9/L', system: 'http://unitsofmeasure.org' } }] }
    const facts = inpatientInvestigationsSchema.parse({ admissionId: subject.admissionId, sent: [], imagingRequests: [], laboratoryRequests: [{ id: 'synthetic-request', catalogItemId: 'synthetic-lab', indicationCode: 'screening', serviceRequestId: 'synthetic-service-request', serviceRequestVersion: '1', taskId: 'synthetic-task', taskVersion: '1', status: 'acknowledged', version: 1,
      referenceConcept: { id: 'synthetic-lab', code: 'synthetic-lab', display: '合成完整检验', system: 'https://example.test/lab', version: '1', sourceLocator: 'synthetic-fixture' }, report,
      previousReports: [{ ...report, diagnosticReportId: 'synthetic-prior-report', conclusion: '合成既往报告结论' }] }] })
    await page.route(`**${subject.path}/investigations`, route => route.fulfill({ json: facts }))
    await page.route(`${browserApp.origin}/inpatient-report-dialog-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${browserApp.origin}/inpatient-report-dialog-contract`)
    await page.setContent(`<!doctype html><html data-admission-id="${subject.admissionId}"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    for (const english of [false, true]) {
      if (english) await page.getByRole('button', { name: 'Switch language', exact: true }).click()
      for (const width of [1101, 826]) for (const dark of [false, true]) {
        await page.setViewportSize({ width, height: 900 })
        await page.locator('.clinmesh-web-root').evaluate((element, dark) => { element.classList.toggle('dark', dark) }, dark)
        const reportTrigger = page.getByRole('button', { name: english ? 'View full report' : '查看全文', exact: true })
        await expect(page.getByRole('table')).toHaveCount(0)
        await reportTrigger.click()
        const reportDialog = page.getByRole('dialog', { name: /合成完整检验/ })
        await expect(reportDialog.getByRole('table')).toHaveCount(2)
        await expect(reportDialog).toContainText('合成既往报告结论')
        expect(await reportDialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
        expect(await reportDialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
        await page.keyboard.press('Escape')
        await expect(reportDialog).toHaveCount(0)
        await expect(reportTrigger).toBeFocused()
        const executionTrigger = page.getByRole('button', { name: english ? /^Execution records \(\d+\)$/ : /^执行记录 \(\d+\)$/ })
        await executionTrigger.click()
        const executionDialog = page.getByRole('dialog', { name: english ? /Execution records/ : /执行记录/ })
        await expect(executionDialog.getByRole('article')).toHaveCount(1)
        expect(await executionDialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
        await page.keyboard.press('Escape')
        await expect(executionDialog).toHaveCount(0)
        await expect(executionTrigger).toBeFocused()
      }
    }
    expect(errors).toEqual([])
  })
})
