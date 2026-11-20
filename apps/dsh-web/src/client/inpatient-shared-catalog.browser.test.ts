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
    await page.getByRole('button', { name: '开立医嘱', exact: true }).click()
    const composer = page.getByRole('dialog', { name: '开立医嘱', exact: true })
    await composer.getByLabel('医嘱项目', { exact: true }).fill('氨氯地平')
    const suggestions = composer.getByRole('region', { name: '医嘱项目候选', exact: true })
    const option = suggestions.getByRole('button', { name: /苯磺酸氨氯地平片/ })
    expect(await option.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    const candidateInsertTrigger = suggestions.getByRole('button', { name: '说明书', exact: true }).first()
    const suggestionBounds = await suggestions.evaluate(element => ({
      clientWidth: element.clientWidth,
      right: element.getBoundingClientRect().right,
      scrollWidth: element.scrollWidth,
    }))
    const triggerRight = await candidateInsertTrigger.evaluate(element => element.getBoundingClientRect().right)
    expect(suggestionBounds.scrollWidth).toBeLessThanOrEqual(suggestionBounds.clientWidth + 1)
    expect(triggerRight).toBeLessThanOrEqual(suggestionBounds.right + 1)
    await option.click()
    const dose = composer.getByRole('textbox', { name: '每次剂量', exact: true })
    await dose.fill('3片')
    await expect(composer.getByRole('button', { name: '开立所选医嘱（1）', exact: true })).toBeDisabled()
    await dose.fill('1片')
    const frequency = composer.getByRole('combobox', { name: '医嘱频次', exact: true })
    await frequency.click()
    await expect(page.getByRole('option', { name: /每日三次/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /每晚一次/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /仅一次/ })).toBeDisabled()
    await page.getByRole('option', { name: /每日一次/ }).click()
    await composer.getByRole('group', { name: '医嘱时效', exact: true }).getByRole('button', { name: '临时', exact: true }).click()
    await frequency.click()
    await page.getByRole('option', { name: /仅一次/ }).click()
    expect(await dose.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    const draftRow = composer.getByRole('region', { name: '待开：苯磺酸氨氯地平片', exact: true })
    await draftRow.getByRole('button', { name: '说明书', exact: true }).click()
    const insertSheet = page.getByRole('dialog', { name: '药品说明书摘要', exact: true })
    await expect(insertSheet).toBeVisible()
    expect(await insertSheet.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    expect(await page.evaluate(() => document.body.querySelector('[data-medication-package-insert]') === null)).toBe(true)
    await expect(insertSheet).toContainText('合成教学参考，非真实上市产品法定说明书')
    await expect(insertSheet).toContainText('单日最大剂量不超过 10 mg')
    await page.keyboard.press('Escape')
    await expect(insertSheet).toBeHidden()
    await expect(composer).toBeVisible()
    await expect(dose).toHaveValue('1片')
    await draftRow.getByRole('button', { name: '说明书', exact: true }).click()
    await expect(insertSheet).toBeVisible()
    await page.locator('[data-slot="sheet-overlay"]').click({ position: { x: 16, y: 200 } })
    await expect(insertSheet).toBeHidden()
    await expect(composer).toBeVisible()
    await expect(dose).toHaveValue('1片')
    await draftRow.getByRole('button', { name: '说明书', exact: true }).click()
    await expect(insertSheet).toBeVisible()
    await insertSheet.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(insertSheet).toBeHidden()
    await expect(composer).toBeVisible()
    await expect(dose).toHaveValue('1片')
    const issued = page.waitForResponse(response => response.url().endsWith(`${path}/orders/issue`))
    await composer.getByRole('button', { name: '开立所选医嘱（1）', exact: true }).click()
    expect((await issued).status()).toBe(200)
    await composer.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(composer).toBeHidden()
    await expect(page.locator('article').filter({ hasText: '苯磺酸氨氯地平片' }).filter({ hasText: '待校对' })).toBeVisible()
    const clinical = inpatientFullClinicalSchema.parse(await (await page.request.get(`${origin}${path}/clinical`)).json())
    expect(clinical.orders).toMatchObject([{ catalogItemId: 'medication-amlodipine', doseText: '1片', doseQuantity: 1, unit: '片', frequencyCode: 'ONCE' }])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByRole('button', { name: '开立医嘱', exact: true }).click()
    await composer.getByLabel('医嘱项目', { exact: true }).fill('培哚普利')
    await composer.getByRole('region', { name: '医嘱项目候选', exact: true }).getByRole('button', { name: /培哚普利片/ }).click()
    const aceiIssued = page.waitForResponse(response => response.url().endsWith(`${path}/orders/issue`))
    await composer.getByRole('button', { name: '开立所选医嘱（1）', exact: true }).click()
    expect((await aceiIssued).status()).toBe(200)
    await expect(composer).toContainText('已成功开立 2 项')
    await composer.getByLabel('医嘱项目', { exact: true }).fill('缬沙坦')
    await composer.getByRole('region', { name: '医嘱项目候选', exact: true }).getByRole('button', { name: /选择缬沙坦胶囊/ }).click()
    await composer.getByRole('button', { name: '开立所选医嘱（1）', exact: true }).click()
    await expect(composer.getByRole('alert')).toContainText('药品组合存在药理类别互斥')
    expect(errors).toEqual([])
  })
})
