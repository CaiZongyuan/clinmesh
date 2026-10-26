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
  const referencePages: number[] = []
  await page.route('**/api/his/v1/inpatient/catalog-search?**', async route => {
    const query = new URL(route.request().url()).searchParams
    if (query.get('source') !== 'reference') return route.continue()
    if (referenceFailure) return route.abort('failed')
    const pageNumber = Number(query.get('page') ?? 1)
    referencePages.push(pageNumber)
    const kind = query.get('kind')
    const candidate = kind === 'laboratory'
      ? { id: 'reference-laboratory-incomplete', referenceId: 'reference-laboratory-incomplete', display: '合成未开展参考检验', status: 'incomplete', missingFields: ['hospital-mapping'] }
      : pageNumber === 1
      ? { id: 'reference-medication-incomplete', referenceId: 'reference-medication-incomplete', display: '合成缺价参考药品', status: 'incomplete', missingFields: ['price', 'unit'] }
      : { id: 'reference-medication-inactive', referenceId: 'reference-medication-inactive', display: '合成停用参考药品', status: 'inactive', missingFields: [] }
    await route.fulfill({ json: inpatientCatalogSearchSchema.parse({
      kind, source: 'reference', page: pageNumber, pageSize: 20, total: kind === 'laboratory' ? 1 : 21,
      releaseId: 'synthetic-reference-ui-v1', items: [candidate],
    }) })
  })
  await page.goto(`${origin}/inpatient`)
  await page.getByRole('button', { name: '查看合成目录验收患者', exact: true }).click()
  await page.getByRole('button', { name: '搜索共享药品目录', exact: true }).click()
  const hospital = page.getByRole('region', { name: '院内药品', exact: true })
  const reference = page.getByRole('region', { name: '参考药品', exact: true })
  await expect(hospital.getByRole('button', { name: '选择苯磺酸氨氯地平片', exact: true })).toBeEnabled()
  await expect(reference).toContainText('待补资料')
  await expect(reference).toContainText('缺发药单位')
  await expect(reference).toContainText('缺院内价格')
  await expect(reference.getByRole('button', { name: '选择合成缺价参考药品', exact: true })).toBeDisabled()
  await reference.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(reference).toContainText('已停用')
  await expect(reference.getByRole('button', { name: '选择合成停用参考药品', exact: true })).toBeDisabled()
  expect(referencePages).toContain(1)
  expect(referencePages).toContain(2)
  await expect(hospital).toContainText('第 1 页')
  referenceFailure = true
  await page.getByLabel('药品搜索词', { exact: true }).fill('恢复查询')
  await page.getByRole('button', { name: '搜索药品', exact: true }).click()
  await expect(reference.getByRole('alert')).toContainText('无法连接科灵脉智服务')
  referenceFailure = false
  await reference.getByRole('button', { name: '重试目录查询', exact: true }).click()
  await expect(reference.getByRole('alert')).toHaveCount(0)
  await expect(reference).toContainText('合成缺价参考药品')
  await page.getByLabel('药品搜索词', { exact: true }).fill('氨氯地平')
  await page.getByRole('button', { name: '搜索药品', exact: true }).click()
  await hospital.getByRole('button', { name: '选择苯磺酸氨氯地平片', exact: true }).click()
  await page.getByRole('textbox', { name: '每次剂量', exact: true }).fill('1片')
  await page.getByLabel('医嘱时效', { exact: true }).click()
  await page.getByRole('option', { name: '临时', exact: true }).click()
  const issued = page.waitForResponse(response => response.url().endsWith(`${path}/orders/issue`))
  await page.getByRole('button', { name: '签发医嘱', exact: true }).click()
  expect((await issued).status()).toBe(200)
  await expect(page.getByText('苯磺酸氨氯地平片 · 待校对', { exact: true })).toBeVisible()
  const clinical = inpatientFullClinicalSchema.parse(await (await page.request.get(`${origin}${path}/clinical`)).json())
  expect(clinical.orders).toMatchObject([{ catalogItemId: 'medication-amlodipine', doseText: '1片', doseQuantity: 1, unit: '片' }])
  await page.getByRole('tab', { name: '检查检验', exact: true }).click()
  await page.getByRole('button', { name: '搜索共享检验目录', exact: true }).click()
  const referenceLaboratory = page.getByRole('region', { name: '参考检验', exact: true })
  await expect(referenceLaboratory).toContainText('尚未建立院内项目')
  await expect(referenceLaboratory.getByRole('button', { name: '选择合成未开展参考检验', exact: true })).toBeDisabled()
})
