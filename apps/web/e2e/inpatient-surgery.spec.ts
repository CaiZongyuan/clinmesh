import { expectCompletedSurgeryPreparation, selectInpatientStage } from './inpatient-ui.ts'
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
    await page.getByRole('button', { name: /合成手术患者/ }).click()
    await selectInpatientStage(page, "手术")
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
  await page.getByRole('button', { name: '申请手术', exact: true }).first().click()
  await page.getByLabel('计划术式', { exact: true }).click()
  await page.getByRole('option', { name: /47.0100 · 腹腔镜下阑尾切除术/ }).click()
  await page.getByLabel('计划手术时间（上海时间）', { exact: true }).fill('2026-08-25T09:00')
  await page.getByLabel('手术申请理由', { exact: true }).fill('合成示教申请')
  await page.getByRole('button', { name: '提交手术申请', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前手术计划', exact: true })).toContainText('腹腔镜下阑尾切除术')
  await expect(page.getByRole('region', { name: '当前手术计划', exact: true })).toContainText('待准备')
  await page.getByRole('button', { name: '确认已签', exact: true }).click()
  await page.getByLabel('签署说明', { exact: true }).fill('确认已签署合成同意书')
  await page.getByRole('button', { name: "确认手术知情同意书已签", exact: true }).click()
  const consentTime = await expectCompletedSurgeryPreparation(page.getByRole('region', { name: '当前手术计划', exact: true }), '手术知情同意书已签', '住院医生')
  const confirmed = inpatientSurgerySchema.parse(await (await page.request.get(`${browserApp.origin}${path}/surgeries`)).json()).requests[0]!.consentConfirmation!
  await expect(consentTime).toHaveAttribute('datetime', confirmed.recordedAt)
  await expect(page.getByRole('button', { name: '等病区护士术前核对', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '整台补录', exact: true })).toHaveCount(0)
  await login('ward-nurse')
  await selectPatient()
  await page.getByLabel('术前核对说明', { exact: true }).fill('已核对合成术前检查')
  await page.getByRole('button', { name: "术前核对", exact: true }).click()
  await expect(page.getByRole('region', { name: '当前手术计划', exact: true }).getByText('已就绪', { exact: true })).toBeVisible()
  await login('inpatient-doctor')
  await selectPatient()
  await page.getByRole('button', { name: '整台补录', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '整台补录', exact: true })
  await dialog.getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: /51.2300 · 腹腔镜下胆囊切除术/ }).click()
  await expect(dialog.getByRole('spinbutton')).toHaveCount(0)
  await expect(dialog.getByText('179 项耗材因计价单位未确认而未启用', { exact: true })).toBeVisible()
  await dialog.getByLabel('搜索手术耗材', { exact: true }).fill('TJ2023')
  const unavailable = dialog.getByRole('button', { name: /^添加 / })
  await expect(unavailable.first()).toBeVisible()
  for (const button of await unavailable.all()) await expect(button).toBeDisabled()
  await expect(dialog.getByText('计价单位未确认，暂不可用', { exact: true }).first()).toBeVisible()
  await dialog.getByLabel('搜索手术耗材', { exact: true }).fill('合成演示缝合材料')
  await dialog.getByRole('button', { name: '添加 合成演示缝合材料', exact: true }).click()
  await dialog.getByLabel('合成演示缝合材料实际用量', { exact: true }).fill('2')
  await expect(dialog.getByRole('spinbutton')).toHaveCount(1)
  await dialog.getByLabel('搜索手术耗材', { exact: true }).fill('HN-PACING-2026-8')
  await dialog.getByRole('button', { name: /添加 .*HN-PACING-2026-8$/ }).click()
  await expect(dialog.getByRole('spinbutton')).toHaveCount(2)
  await expect(dialog.getByText('¥11,990.00/台', { exact: true })).toBeVisible()
  await dialog.getByLabel('补录依据', { exact: true }).fill('实际实施胆囊切除术，合成缝合材料两包')
  let posts = 0, originalKey: string | undefined
  await page.route(`**${path}/surgeries/execute`, async route => {
    posts += 1
    originalKey = route.request().headers()['idempotency-key']
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    inpatientSurgeryResponseSchema.parse(await response.json())
    await route.abort('failed')
  })
  await dialog.getByRole('button', { name: '记录实际手术', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('无法连接科灵脉智服务')
  await page.reload()
  await selectPatient()
  const receipt = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
  expect(new URL((await receipt).url()).searchParams.get('idempotencyKey')).toBe(originalKey)
  await page.getByRole('button', { name: '申请手术', exact: true }).first().click()
  await expect(page.getByLabel('计划术式', { exact: true })).toBeEnabled()
  await page.getByRole('dialog', { name: '申请手术', exact: true }).getByRole('button', { name: '取消', exact: true }).click()
  expect(posts).toBe(1)
  const done = page.getByRole('region', { name: '最终耗材', exact: true })
  await expect(done).toContainText('51.2300')
  await expect(done).toContainText('腹腔镜下胆囊切除术')
  await expect(done).toContainText('合成演示缝合材料')
  await expect(done).toContainText('2 包')
  const surgery = inpatientSurgerySchema.parse(await (await page.request.get(`${browserApp.origin}${path}/surgeries`)).json())
  expect(surgery.executions).toHaveLength(1)
  expect(surgery.executions[0]!.materials.find(material => material.item.id === 'hospital-material-cv-8')).toMatchObject({ quantity: 1, amountFen: 1199000 })
  await selectInpatientStage(page, "诊断医嘱")
  await page.getByRole('button', { name: '开立医嘱', exact: true }).click()
  await page.getByLabel('医嘱项目', { exact: true }).fill('糖尿病健康教育')
  await page.getByRole('region', { name: '医嘱项目候选', exact: true }).getByRole('button', { name: /糖尿病健康教育/ }).click()
  await page.getByLabel('术后医嘱关联手术', { exact: true }).click()
  await page.getByRole('option', { name: /51.2300 · 腹腔镜下胆囊切除术/ }).click()
  await page.getByRole('group', { name: '医嘱时效', exact: true }).getByRole('button', { name: '临时', exact: true }).click()
  await page.getByRole('button', { name: '开立所选医嘱（1）', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '开立医嘱', exact: true }).getByText('已成功开立 1 项', { exact: true })).toBeVisible()
  await page.getByRole('dialog', { name: '开立医嘱', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('article').filter({ hasText: '糖尿病健康教育' }).filter({ hasText: '待校对' })).toBeVisible()
  await expect(page.getByText('术后医嘱 · 腹腔镜下胆囊切除术', { exact: true })).toBeVisible()
})
