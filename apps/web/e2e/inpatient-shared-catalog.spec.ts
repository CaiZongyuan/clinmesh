import { selectInpatientStage } from './inpatient-ui.ts'
import { randomUUID } from 'node:crypto'
import { createPatientResponseSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientCatalogSearchSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { expect, test } from './fixtures.ts'

test('住院医生可检索共享目录缺项并自行填写本次剂量开立医嘱', async ({ page, browserApp }) => {
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
      name: '合成目录验收患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}`,
    } },
  })).json()).data.patient
  const session = sessionContextSchema.parse(await (await page.request.get(`${origin}/api/auth/context`)).json())
  const admission = inpatientCommandResponseSchema.parse(await (await post('/api/his/v1/inpatient/admissions', {
    expectedEpoch: session.actor.epoch, patientId: patient.id, patientVersion: patient.versionId,
    admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0,
  })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  await login('ward-nurse')
  const received = inpatientCommandResponseSchema.parse(await (await post(`${path}/receive`, {
    encounterVersion: admission.versionId, bedId: 'bed-general-1',
  })).json()).data.admission
  await login('inpatient-doctor')
  expect((await post(`${path}/diagnoses/confirm`, {
    encounterVersion: received.versionId, expectedRevision: 0,
    entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary', admissionCondition: '1' }],
  })).status()).toBe(200)
  let referenceFailure = false
  await page.route('**/api/his/v1/inpatient/catalog-search?**', async route => {
    const query = new URL(route.request().url()).searchParams
    if (query.get('kind') !== 'medication' || query.get('source') !== 'hospital') return route.continue()
    if (referenceFailure) return route.abort('failed')
    const response = await route.fetch()
    const body = inpatientCatalogSearchSchema.parse(await response.json())
    const extras = [
      { id: 'reference-medication-incomplete', referenceId: 'reference-medication-incomplete', display: '合成缺价参考药品', status: 'incomplete' as const, missingFields: ['price' as const, 'unit' as const] },
      { id: 'reference-medication-inactive', referenceId: 'reference-medication-inactive', display: '合成停用参考药品', status: 'inactive' as const, missingFields: [] },
    ]
    await route.fulfill({ json: inpatientCatalogSearchSchema.parse({
      ...body, total: body.items.length + extras.length, items: [...body.items, ...extras],
    }) })
  })
  await page.goto(`${origin}/inpatient`)
  await page.getByRole('button', { name: '查看合成目录验收患者', exact: true }).click()
  await page.getByRole('button', { name: '开立医嘱', exact: true }).click()
  await page.getByRole('button', { name: '查询', exact: true }).click()
  const suggestions = page.getByRole('region', { name: '医嘱项目候选', exact: true })
  await expect(suggestions.getByRole('button', { name: /苯磺酸氨氯地平片/ })).toBeEnabled()
  await suggestions.getByRole('button', { name: /另有 \d+ 项暂不能开立 · 查看原因/ }).click()
  await expect(suggestions).toContainText('合成缺价参考药品')
  await expect(suggestions).toContainText('缺发药单位')
  await expect(suggestions).toContainText('缺院内价格')
  await expect(suggestions).toContainText('合成停用参考药品')
  await expect(suggestions).toContainText('已停用')
  await expect(suggestions.getByRole('button', { name: /合成缺价参考药品|合成停用参考药品/ })).toHaveCount(0)
  referenceFailure = true
  await page.getByLabel('医嘱项目', { exact: true }).fill('恢复查询')
  await expect(suggestions.getByRole('alert')).toContainText('无法连接科灵脉智服务')
  referenceFailure = false
  await suggestions.getByRole('button', { name: '重试目录查询', exact: true }).click()
  await expect(suggestions.getByRole('alert')).toHaveCount(0)
  await page.getByLabel('医嘱项目', { exact: true }).fill('氨氯地平')
  await suggestions.getByRole('button', { name: /苯磺酸氨氯地平片/ }).click()
  await page.getByRole('textbox', { name: '每次剂量', exact: true }).fill('1片')
  await page.getByRole('group', { name: '医嘱时效', exact: true }).getByRole('button', { name: '临时', exact: true }).click()
  const issued = page.waitForResponse(response => response.url().endsWith(`${path}/orders/issue`))
  await page.getByRole('button', { name: '开立所选医嘱（1）', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '开立医嘱', exact: true }).getByText('已成功开立 1 项', { exact: true })).toBeVisible()
  await page.getByRole('dialog', { name: '开立医嘱', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
  expect((await issued).status()).toBe(200)
  await expect(page.locator('article').filter({ hasText: '苯磺酸氨氯地平片' }).filter({ hasText: '待校对' })).toBeVisible()
  const clinical = inpatientFullClinicalSchema.parse(await (await page.request.get(`${origin}${path}/clinical`)).json())
  expect(clinical.orders).toMatchObject([{ catalogItemId: 'medication-amlodipine', doseText: '1片', doseQuantity: 1, unit: '片' }])
  await selectInpatientStage(page, "检查检验")
  await page.getByRole('button', { name: '开立住院检查', exact: true }).click()
  const composer = page.getByRole('dialog', { name: '开立住院检查', exact: true })
  await composer.getByLabel('搜索检查检验目录', { exact: true }).fill('合成未开展参考检验')
  await expect(composer.getByText('没有匹配的可开立项目', { exact: true })).toBeVisible()
  await expect(composer.getByRole('button', { name: '选择合成未开展参考检验', exact: true })).toHaveCount(0)
})
