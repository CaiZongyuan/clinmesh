import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures.ts'
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
  await page.getByRole('button', { name: '确认住院诊断', exact: true }).click()
  await expect(page.getByText('主诊断：2型糖尿病伴高血糖', { exact: true })).toBeVisible()
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
    const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('failed')
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
})
