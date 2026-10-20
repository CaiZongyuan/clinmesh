import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures.ts'
import { inpatientPharmacyResponseSchema, inpatientChargesResponseSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { createPatientResponseSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'

test('住院医生确认诊断和临时药嘱，护士校对、药师发药后护士真实给药', async ({ page, browserApp }) => {
  const login = async (name: string, first = false) => {
    if (!first) { await page.getByRole('button', { name: '用户菜单' }).click(); await page.getByRole('menuitem', { name: '退出登录' }).click() }
    await page.getByLabel('账户邮箱').fill(`${name}@demo.clinmesh.local`)
    await page.getByLabel('账户密码').fill(browserApp.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible()
  }
  await page.goto(`${browserApp.origin}/registration`)
  await login('registrar', true)
  const request = async (path: string, input: unknown) => page.request.post(`${browserApp.origin}${path}`, { headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() }, data: { input } })
  const patient = createPatientResponseSchema.parse(await (await page.request.post(`${browserApp.origin}/api/his/v1/patients`, {
    headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() }, data: { expectedVersions: {}, input: { name: '合成住院用药患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } },
  })).json()).data.patient
  const session = sessionContextSchema.parse(await (await page.request.get(`${browserApp.origin}/api/auth/context`)).json())
  const admission = inpatientCommandResponseSchema.parse(await (await request('/api/his/v1/inpatient/admissions', { expectedEpoch: session.actor.epoch,
    patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })).json()).data.admission
  await login('ward-nurse')
  expect((await request(`/api/his/v1/inpatient/admissions/${admission.id}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })).status()).toBe(200)
  await login('inpatient-doctor')
  await page.getByRole('button', { name: '查看合成住院用药患者', exact: true }).click()
  await page.getByLabel('住院诊断', { exact: true }).click()
  await page.getByRole('option', { name: /2型糖尿病伴高血糖/ }).click()
  await page.getByLabel('主诊断入院病情',{exact:true}).click()
  await page.getByRole('option',{name:'1 · 有',exact:true}).click()
  await page.getByRole('button', { name: '添加次诊断', exact: true }).click()
  await page.getByLabel('次诊断 1', { exact: true }).click()
  await page.getByRole('option', { name: '高血压', exact: true }).click()
  await page.getByLabel('次诊断 1 入院病情', { exact: true }).click()
  await page.getByRole('option', { name: '2 · 临床未确定', exact: true }).click()
  await page.getByLabel('次诊断 1 备注', { exact: true }).fill('合成入院待确认备注')
  await page.getByRole('button', { name: '添加次诊断', exact: true }).click()
  await page.getByLabel('次诊断 2', { exact: true }).click()
  await page.getByRole('option', { name: '发热，未特指', exact: true }).click()
  await page.getByLabel('次诊断 2 入院病情', { exact: true }).click()
  await page.getByRole('option', { name: '3 · 情况不明', exact: true }).click()
  await page.getByRole('button', { name: '上移次诊断 2', exact: true }).click()
  // Only the external reference page is synthetic; confirmation and the clinical journey use the real server.
  await page.route('**/api/his/v1/reference-catalogs/diagnoses?**', async route => {
    const pageNumber = Number(new URL(route.request().url()).searchParams.get('page'))
    await route.fulfill({ json: { items: [], page: pageNumber, pageSize: 20, total: 40, releaseId: 'synthetic-ui-paging' } })
  })
  await page.getByLabel('诊断目录检索', { exact: true }).fill('糖尿病')
  await page.getByRole('button', { name: '查询诊断', exact: true }).click()
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible()
  await expect(page.getByLabel('次诊断 1', { exact: true })).toContainText('发热')
  await expect(page.getByLabel('次诊断 2', { exact: true })).toContainText('高血压')
  await page.getByRole('button', { name: '确认住院诊断', exact: true }).click()
  await expect(page.getByText('主诊断：2型糖尿病伴高血糖', { exact: true })).toBeVisible()
  await expect(page.getByText('次诊断：发热，未特指', { exact: true })).toBeVisible()
  await expect(page.getByText('次诊断：高血压', { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: '查看合成住院用药患者', exact: true }).click()
  await expect(page.getByLabel('次诊断 2 备注', { exact: true })).toHaveValue('合成入院待确认备注')
  await page.getByRole('button', { name: '确认住院诊断', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('操作成功')
  await expect(page.getByText('次诊断：发热，未特指', { exact: true })).toBeVisible()
  await expect(page.getByText('次诊断：高血压', { exact: true })).toBeVisible()

  await page.getByLabel('医嘱项目', { exact: true }).click()
  await page.getByRole('option', { name: '盐酸二甲双胍片', exact: true }).click()
  await page.getByLabel('医嘱时效', { exact: true }).click()
  await page.getByRole('option', { name: '临时', exact: true }).click()
  await page.getByRole('button', { name: '签发医嘱', exact: true }).click()
  await expect(page.getByText('盐酸二甲双胍片 · 待校对', { exact: true })).toBeVisible()
  await login('ward-nurse')
  await page.getByRole('button', { name: '查看合成住院用药患者', exact: true }).click()
  await page.getByRole('button', { name: '校对医嘱', exact: true }).click()
  await expect(page.getByText('盐酸二甲双胍片 · 待执行', { exact: true })).toBeVisible()
  await login('pharmacist')
  await page.getByRole('tab', { name: '住院药房', exact: true }).click()
  await page.getByRole('button', { name: '查看合成住院用药患者', exact: true }).click()
  let dispensePosts=0
  let originalKey:string|undefined
  await page.route(`**/api/his/v1/inpatient/admissions/${admission.id}/executions/dispense`,async route=>{
    dispensePosts+=1;originalKey=route.request().headers()['idempotency-key']
    const response=await route.fetch();expect(response.status()).toBe(200);inpatientPharmacyResponseSchema.parse(await response.json());await route.abort('failed')
  })
  await page.getByRole('button', { name: '发药', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('无法连接科灵脉智服务')
  await page.reload()
  await page.getByRole('tab', { name: '住院药房', exact: true }).click()
  await page.getByRole('button', { name: '查看合成住院用药患者', exact: true }).click()
  const receipt=page.waitForRequest(request=>request.url().includes('/command-receipts?'))
  await page.getByRole('button',{name:'恢复原住院操作',exact:true}).click()
  expect(new URL((await receipt).url()).searchParams.get('idempotencyKey')).toBe(originalKey)
  await expect(page.getByRole('status')).toContainText('操作成功')
  expect(dispensePosts).toBe(1)

  await expect(page.getByText('盐酸二甲双胍片 · 已发药', { exact: true })).toBeVisible()
  await login('ward-nurse')
  await page.getByRole('button', { name: '查看合成住院用药患者', exact: true }).click()
  await page.getByRole('button', { name: '给药', exact: true }).click()
  await expect(page.getByText('盐酸二甲双胍片 · 已完成', { exact: true })).toBeVisible()
  const administrations = fhirBundleSchema.parse(await (await page.request.get(`${browserApp.origin}/fhir/R5/MedicationAdministration?encounter=Encounter/${admission.id}&_total=accurate`)).json())
  expect(administrations.total).toBe(1)
  expect(administrations.entry![0]!.resource).toMatchObject({ status: 'completed', medication: { reference: { reference: 'Medication/medication-metformin' } } })
  await login('cashier')
  await page.getByRole('tab', { name: '住院费用', exact: true }).click()
  await page.getByRole('button', { name: '查看合成住院用药患者', exact: true }).click()
  await expect(page.getByLabel('住院费用明细')).toContainText('盐酸二甲双胍片 1片')
  await expect(page.getByLabel('住院诊疗', { exact: true })).toHaveCount(0)
  await page.getByLabel('冲正理由', { exact: true }).fill('合成费用纠错')
  let reversalPosts = 0
  let reversalKey: string | undefined
  await page.route(`**/api/his/v1/inpatient/admissions/${admission.id}/charges/reverse`, async route => {
    reversalPosts += 1; reversalKey = route.request().headers()['idempotency-key']
    const response = await route.fetch(); expect(response.status()).toBe(200); inpatientChargesResponseSchema.parse(await response.json()); await route.abort('failed')
  })
  await page.getByRole('button', { name: '冲正', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('无法连接科灵脉智服务')
  await page.reload()
  await page.getByRole('tab', { name: '住院费用', exact: true }).click()
  await page.getByRole('button', { name: '查看合成住院用药患者', exact: true }).click()
  const reversalReceipt = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
  expect(new URL((await reversalReceipt).url()).searchParams.get('idempotencyKey')).toBe(reversalKey)
  await expect(page.getByRole('status')).toContainText('操作成功')
  await expect(page.getByLabel('住院费用明细')).toContainText('关联冲正')
  expect(reversalPosts).toBe(1)

})
