import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures.ts'
import { createPatientResponseSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientSurgerySchema, inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'

test('手术双准备、实际术式与耗材、丢回执恢复及术后医嘱走真实入口', async ({ page, browserApp }) => {
  const login = async (name: string, first = false) => {
    if (!first) { await page.getByRole('button', { name: '用户菜单' }).click(); await page.getByRole('menuitem', { name: '退出登录' }).click() }
    await page.getByLabel('账户邮箱').fill(`${name}@demo.clinmesh.local`)
    await page.getByLabel('账户密码').fill(browserApp.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible()
  }
  const selectPatient = async () => {
    await page.getByRole('button', { name: '查看合成手术患者', exact: true }).click()
    await page.getByRole('tab', { name: '手术', exact: true }).click()
  }
  await page.goto(`${browserApp.origin}/registration`)
  await login('registrar', true)
  const request = async (path: string, input: unknown) => page.request.post(`${browserApp.origin}${path}`, { headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() }, data: { input } })
  const patient = createPatientResponseSchema.parse(await (await page.request.post(`${browserApp.origin}/api/his/v1/patients`, {
    headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() }, data: { expectedVersions: {}, input: { name: '合成手术患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } },
  })).json()).data.patient
  const session = sessionContextSchema.parse(await (await page.request.get(`${browserApp.origin}/api/auth/context`)).json())
  const admission = inpatientCommandResponseSchema.parse(await (await request('/api/his/v1/inpatient/admissions', { expectedEpoch: session.actor.epoch,
    patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  await login('ward-nurse')
  expect((await request(`${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })).status()).toBe(200)
  await login('inpatient-doctor')
  await selectPatient()
  await page.getByLabel('计划术式', { exact: true }).click()
  await page.getByRole('option', { name: /47.0100 · 腹腔镜下阑尾切除术/ }).click()
  await page.getByLabel('计划手术时间（上海时间）', { exact: true }).fill('2026-08-25T09:00')
  await page.getByLabel('手术申请理由', { exact: true }).fill('合成示教申请')
  await page.getByRole('button', { name: '申请手术', exact: true }).click()
  await expect(page.getByText('腹腔镜下阑尾切除术 · 待准备', { exact: true })).toBeVisible()
  await page.getByLabel('手术记录说明', { exact: true }).fill('确认已签署合成同意书')
  await page.getByRole('button', { name: '确认知情同意已签署', exact: true }).click()
  await expect(page.getByText(/知情同意：已确认签署/)).toBeVisible()
  await expect(page.getByRole('button', { name: '记录实际手术', exact: true })).toBeDisabled()
  await login('ward-nurse')
  await selectPatient()
  await page.getByLabel('手术记录说明', { exact: true }).fill('已核对合成术前检查')
  await page.getByRole('button', { name: '核对术前检查', exact: true }).click()
  await expect(page.getByText('腹腔镜下阑尾切除术 · 已就绪', { exact: true })).toBeVisible()
  await login('inpatient-doctor')
  await selectPatient()
  await page.getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: /51.2300 · 腹腔镜下胆囊切除术/ }).click()
  await page.getByLabel('合成演示缝合材料实际用量', { exact: true }).fill('2')
  await page.getByLabel('手术记录说明', { exact: true }).fill('实际实施胆囊切除术，合成缝合材料两包')
  let posts = 0, originalKey: string | undefined
  await page.route(`**${path}/surgeries/execute`, async route => {
    posts += 1
    originalKey = route.request().headers()['idempotency-key']
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    inpatientSurgeryResponseSchema.parse(await response.json())
    await route.abort('failed')
  })
  await page.getByRole('button', { name: '记录实际手术', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('无法连接科灵脉智服务')
  await page.reload()
  await selectPatient()
  const receipt = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
  expect(new URL((await receipt).url()).searchParams.get('idempotencyKey')).toBe(originalKey)
  await expect(page.getByRole('status')).toContainText('操作成功')
  expect(posts).toBe(1)
  await expect(page.getByText('实际实施：51.2300 · 腹腔镜下胆囊切除术', { exact: true })).toBeVisible()
  await expect(page.getByText('合成演示缝合材料 · 2包', { exact: true })).toBeVisible()
  const surgery = inpatientSurgerySchema.parse(await (await page.request.get(`${browserApp.origin}${path}/surgeries`)).json())
  expect(surgery.executions).toHaveLength(1)
  await page.getByRole('tab', { name: '诊断医嘱', exact: true }).click()
  await page.getByLabel('术后关联手术', { exact: true }).click()
  await page.getByRole('option', { name: /51.2300 · 腹腔镜下胆囊切除术/ }).click()
  await page.getByLabel('医嘱项目', { exact: true }).click()
  await page.getByRole('option', { name: '糖尿病健康教育', exact: true }).click()
  await page.getByLabel('医嘱时效', { exact: true }).click()
  await page.getByRole('option', { name: '临时', exact: true }).click()
  await page.getByRole('button', { name: '签发医嘱', exact: true }).click()
  await expect(page.getByText('糖尿病健康教育 · 待校对', { exact: true })).toBeVisible()
  await expect(page.getByText('术后医嘱 · 腹腔镜下胆囊切除术', { exact: true })).toBeVisible()
})
