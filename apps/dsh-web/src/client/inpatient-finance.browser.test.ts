import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '../../../web/e2e/fixtures.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
for (const version of ['18', '19']) {
  test(`结算后更正与退款审阅弹窗在 React ${version} 的 Surface ShadowRoot 内保持焦点和布局`, async ({ page, browserApp }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const login = async (name: string) => expect((await page.request.post(`${browserApp.origin}/api/auth/sign-in/email`, { headers: { origin: browserApp.origin }, data: { email: `${name}@demo.clinmesh.local`, password: browserApp.password } })).status()).toBe(200)
    const post = (path: string, input: unknown) => page.request.post(`${browserApp.origin}${path}`, { headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() }, data: { input } })
    await login('registrar')
    const patient = (await (await page.request.post(`${browserApp.origin}/api/his/v1/patients`, { headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() }, data: { expectedVersions: {}, input: { name: '合成财务Surface患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } } })).json()).data.patient
    const admission = (await (await post('/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 10000 })).json()).data.admission
    const path = `/api/his/v1/inpatient/admissions/${admission.id}`
    await login('ward-nurse')
    const received = (await (await post(`${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })).json()).data.admission
    await login('admin')
    expect((await post('/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-25T00:00:00+08:00' })).status()).toBe(200)
    await login('inpatient-doctor')
    const issued = (await (await post(`${path}/discharge/issue`, { encounterVersion: received.versionId, reason: '合成治疗完成' })).json()).data.admission
    await login('ward-nurse')
    expect((await post(`${path}/discharge/depart`, { encounterVersion: issued.versionId, reason: '合成出区核对完成', departureMethod: 'home' })).status()).toBe(200)
    await login('cashier')
    const preview = await (await page.request.get(`${browserApp.origin}${path}/discharge/preview`)).json()
    expect((await post(`${path}/discharge/settle`, { encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint, expectedChargesFen: preview.chargesFen, expectedBalanceFen: preview.balanceFen })).status()).toBe(200)
    await page.route(`${browserApp.origin}/finance-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await page.goto(`${browserApp.origin}/finance-contract`)
    const react = version === '18' ? 'react18' : 'react', reactDom = version === '18' ? 'react-dom18' : 'react-dom'
    const result = await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false }, define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      resolve: { alias: [{ find: /^react$/, replacement: require.resolve(react) }, { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) }, { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) }, { find: /^react-dom$/, replacement: require.resolve(reactDom) }] },
      build: { write: false, lib: { entry: fileURLToPath(new URL('./inpatient-finance.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'InpatientFinance' } } })
    const chunk = (Array.isArray(result) ? result : [result]).flatMap(item => 'output' in item ? item.output : []).find(item => item.type === 'chunk')
    if (chunk?.type !== 'chunk') throw new Error('Missing inpatient finance fixture')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.setContent(`<!doctype html><html data-admission-id="${admission.id}"><head><style>${await buildSurfaceStyles()}</style></head><body><script>${chunk.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    const panel = page.getByRole('region', { name: '后续财务更正', exact: true })
    await panel.getByLabel('更正金额（元）', { exact: true }).fill('20')
    await panel.getByLabel('财务更正原因', { exact: true }).fill('合成Surface床日费核对')
    await panel.getByRole('button', { name: '审阅财务更正', exact: true }).click()
    const correction = page.getByRole('alertdialog', { name: '确认后续财务更正', exact: true })
    await expect(correction).toBeVisible()
    expect(await correction.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    await expect.poll(() => correction.evaluate(element => { const root = element.getRootNode(); return root instanceof ShadowRoot && element.contains(root.activeElement) })).toBe(true)
    await correction.getByRole('button', { name: '提交财务更正', exact: true }).click()
    await expect(panel.getByTestId('financial-current')).toContainText('30.00')
    await panel.getByLabel('本次收退金额（元）', { exact: true }).fill('20')
    await panel.getByRole('button', { name: '预览后续退款', exact: true }).click()
    const refund = page.getByRole('alertdialog', { name: '确认后续退款', exact: true })
    await expect(refund).toBeVisible()
    const bounds = await refund.evaluate(element => ({ inShadow: element.getRootNode() instanceof ShadowRoot, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: element.clientWidth, scroll: element.scrollWidth }))
    expect(bounds.inShadow).toBe(true); expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(390); expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1)
    await refund.getByRole('button', { name: '确认本次收退', exact: true }).click()
    await expect(refund).toBeHidden()
    await expect(panel.getByTestId('financial-current')).toContainText('当前净资金 ¥30.00')
    expect(errors).toEqual([])
  })
}
