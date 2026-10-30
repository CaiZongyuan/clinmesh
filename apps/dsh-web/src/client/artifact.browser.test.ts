import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test as base } from '../../../web/e2e/fixtures.ts'
import { selectInpatientStage } from '../../../web/e2e/inpatient-ui.ts'
import { createClinMeshProxyHandler } from '../proxy.ts'

const require = createRequire(import.meta.url)
const test = base.extend<{ proxyOrigin: string }>({
  proxyOrigin: async ({ browserApp }, use) => {
    const server = createServer(createClinMeshProxyHandler({ upstreamOrigin: browserApp.origin }))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Missing proxy test address')
      await use(`http://127.0.0.1:${address.port}`)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    }
  },
})
test.describe.configure({ mode: 'serial' })
test.beforeAll(() => {
  execFileSync('bun', ['run', 'build'], { cwd: fileURLToPath(new URL('../..', import.meta.url)) })
})

for (const version of ['18', '19']) {
  test(`production lazy-CJS opens inpatient funding review with host React ${version}`, async ({ page, browserApp, proxyOrigin }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const login = async (name: string) => expect((await page.request.post(`${browserApp.origin}/api/auth/sign-in/email`, {
      headers: { origin: browserApp.origin }, data: { email: `${name}@demo.clinmesh.local`, password: browserApp.password },
    })).status()).toBe(200)
    const post = (path: string, input: unknown) => page.request.post(`${browserApp.origin}${path}`, {
      headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() }, data: { input },
    })
    await login('registrar')
    const patient = (await (await page.request.post(`${browserApp.origin}/api/his/v1/patients`, {
      headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() },
      data: { expectedVersions: {}, input: { name: '合成产物患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } },
    })).json()).data.patient
    expect((await post('/api/his/v1/inpatient/admissions', {
      expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId,
      admissionRoute: 'direct', wardId: 'ward-general', depositFen: 10000,
    })).status()).toBe(200)
    await login('cashier')
    await page.route(`${browserApp.origin}/artifact-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await page.route('**/clinmesh-api/**', async route => {
      const url = new URL(route.request().url())
      const response = await route.fetch({ url: `${proxyOrigin}${url.pathname}${url.search}` })
      await route.fulfill({ response })
    })
    let directFhirRequests = 0
    await page.route(`${browserApp.origin}/fhir/**`, route => {
      directFhirRequests += 1
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"host route not found"}' })
    })
    await page.goto(`${browserApp.origin}/artifact-contract`)
    expect(await page.evaluate(async id => (await fetch(`/fhir/R5/Patient/${id}`)).status, patient.id)).toBe(404)
    const react = version === '18' ? 'react18' : 'react', reactDom = version === '18' ? 'react-dom18' : 'react-dom'
    const result = await build({
      configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      resolve: { alias: [
        { find: /^react$/, replacement: require.resolve(react) },
        { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
        { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) },
        { find: /^react-dom$/, replacement: require.resolve(reactDom) },
      ] },
      build: { write: false, lib: { entry: fileURLToPath(new URL('./artifact.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'ArtifactHost' } },
    })
    const chunk = (Array.isArray(result) ? result : [result]).flatMap(item => 'output' in item ? item.output : []).find(item => item.type === 'chunk')
    if (chunk?.type !== 'chunk') throw new Error('Missing artifact host fixture')
    await page.addScriptTag({ content: chunk.code })
    await page.addScriptTag({ content: await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8') })
    await page.evaluate(() => window.dispatchEvent(new Event('clinmesh-artifact-mount')))
    await page.getByRole('button', { name: '住院', exact: true }).click()
    const identityResponse = page.waitForResponse(response => response.url().endsWith(`/clinmesh-api/_fhir/R5/Patient/${patient.id}`))
    await page.getByRole('button', { name: '查看合成产物患者', exact: true }).click()
    expect((await identityResponse).status()).toBe(200)
    await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText('女 · 46 岁')
    expect(directFhirRequests).toBe(1)
    await selectInpatientStage(page, '出院')
    const funding = page.getByRole('region', { name: '住院收退款', exact: true })
    await funding.getByLabel('现金金额（元）', { exact: true }).fill('20')
    const actions = page.getByRole('region', { name: '当前操作', exact: true })
    await actions.getByRole('button', { name: '预览收款', exact: true }).click()
    await expect(funding).toContainText('已固定收款预览：预交金 · ¥20.00')
    await expect(actions.getByRole('button', { name: '确认收款', exact: true })).toBeFocused()
    expect(await funding.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    await actions.getByRole('button', { name: '确认收款', exact: true }).click()
    await expect(funding).toContainText('累计预交金：¥120.00')
    expect(errors).toEqual([])
  })
}
