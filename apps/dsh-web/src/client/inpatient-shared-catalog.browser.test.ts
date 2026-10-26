import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { createPatientResponseSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { expect, test } from '../../../web/e2e/fixtures.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)

for (const version of ['18', '19']) test.describe(`住院共享目录 React ${version}`, () => {
  let artifact: { code: string; styles: string }
  test.beforeAll(async () => {
    const react = version === '18' ? 'react18' : 'react'
    const reactDom = version === '18' ? 'react-dom18' : 'react-dom'
    const result = await build({
      configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      resolve: { alias: [
        { find: /^react$/, replacement: require.resolve(react) },
        { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
        { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) },
        { find: /^react-dom$/, replacement: require.resolve(reactDom) },
      ] },
      build: { write: false, lib: { entry: fileURLToPath(new URL('./inpatient-shared-catalog.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'InpatientSharedCatalog' } },
    })
    const chunk = (Array.isArray(result) ? result : [result]).flatMap(item => 'output' in item ? item.output : []).find(item => item.type === 'chunk')
    if (chunk?.type !== 'chunk') throw new Error('Missing inpatient shared catalog fixture')
    artifact = { code: chunk.code, styles: await buildSurfaceStyles() }
  })

  test('医生在 ShadowRoot 内填写制剂单位剂量并通过真实服务端签发', async ({ page, browserApp }) => {
    const origin = browserApp.origin
    const login = async (role: string) => expect((await page.request.post(`${origin}/api/auth/sign-in/email`, {
      headers: { origin }, data: { email: `${role}@demo.clinmesh.local`, password: browserApp.password },
    })).status()).toBe(200)
    const post = (path: string, input: unknown) => page.request.post(`${origin}${path}`, {
      headers: { origin, 'idempotency-key': randomUUID() }, data: { input },
    })
    await login('registrar')
    const patient = createPatientResponseSchema.parse(await (await page.request.post(`${origin}/api/his/v1/patients`, {
      headers: { origin, 'idempotency-key': randomUUID() }, data: { expectedVersions: {}, input: {
        name: '合成Surface目录患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}`,
      } },
    })).json()).data.patient
    const session = sessionContextSchema.parse(await (await page.request.get(`${origin}/api/auth/context`)).json())
    const registered = inpatientCommandResponseSchema.parse(await (await post('/api/his/v1/inpatient/admissions', {
      expectedEpoch: session.actor.epoch, patientId: patient.id, patientVersion: patient.versionId,
      admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0,
    })).json()).data.admission
    const path = `/api/his/v1/inpatient/admissions/${registered.id}`
    await login('ward-nurse')
    const admission = inpatientCommandResponseSchema.parse(await (await post(`${path}/receive`, {
      encounterVersion: registered.versionId, bedId: 'bed-general-1',
    })).json()).data.admission
    await login('inpatient-doctor')
    expect((await post(`${path}/diagnoses/confirm`, {
      encounterVersion: admission.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary', admissionCondition: '1' }],
    })).status()).toBe(200)
    await page.route(`${origin}/inpatient-catalog-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await page.goto(`${origin}/inpatient-catalog-contract`)
    await page.setViewportSize({ width: 390, height: 844 })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent(`<!doctype html><html data-admission-id="${admission.id}"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    await page.getByLabel('医嘱项目', { exact: true }).click()
    const option = page.getByRole('option', { name: '苯磺酸氨氯地平片', exact: true })
    expect(await option.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    await option.click()
    const dose = page.getByRole('textbox', { name: '每次剂量', exact: true })
    await dose.fill('2片')
    await expect(page.getByRole('button', { name: '签发医嘱', exact: true })).toBeDisabled()
    await dose.fill('1片')
    await page.getByLabel('医嘱时效', { exact: true }).click()
    await page.getByRole('option', { name: '临时', exact: true }).click()
    const issued = page.waitForResponse(response => response.url().endsWith(`${path}/orders/issue`))
    await page.getByRole('button', { name: '签发医嘱', exact: true }).click()
    expect((await issued).status()).toBe(200)
    await expect(page.getByText('苯磺酸氨氯地平片 · 待校对', { exact: true })).toBeVisible()
    const clinical = inpatientFullClinicalSchema.parse(await (await page.request.get(`${origin}${path}/clinical`)).json())
    expect(clinical.orders).toMatchObject([{ catalogItemId: 'medication-amlodipine', doseText: '1片', doseQuantity: 1, unit: '片' }])
    expect(await dose.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(errors).toEqual([])
  })
})
