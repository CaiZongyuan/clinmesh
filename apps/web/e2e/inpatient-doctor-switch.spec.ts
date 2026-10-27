import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures.ts'

// 医生三栏就地切换患者时，上一患者的未提交诊断草稿不得带入下一患者（Codex P1）。
test('医生就地切换患者后不保留前一患者的诊断草稿', async ({ page, browserApp }) => {
  const { origin, password } = browserApp

  await page.goto(`${origin}/registration`)
  await page.getByLabel('账户邮箱').fill('registrar@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible()
  const names = [`合成草稿甲${randomUUID().slice(0, 6)}`, `合成草稿乙${randomUUID().slice(0, 6)}`]
  const session = await (await page.request.get(`${origin}/api/auth/context`)).json()
  for (const [index, name] of names.entries()) {
    const created = await page.request.post(`${origin}/api/his/v1/patients`, {
      headers: { origin, 'idempotency-key': randomUUID() },
      data: { expectedVersions: {}, input: { name, gender: 'female', birthDate: '1981-03-03', identifier: `SYN-${randomUUID()}` } },
    })
    expect(created.status()).toBe(200)
    const patient = (await created.json()).data.patient
    const registered = await page.request.post(`${origin}/api/his/v1/inpatient/admissions`, {
      headers: { origin, 'idempotency-key': randomUUID() },
      data: { input: { expectedEpoch: session.actor.epoch, patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 } },
    })
    expect(registered.status(), await registered.text()).toBe(200)
    void index
  }
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()

  // 护士接诊分床两名患者，使其可编辑诊断
  await page.goto(`${origin}/inpatient`)
  await page.getByLabel('账户邮箱').fill('ward-nurse@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '病区一览板' })).toBeVisible()
  for (const name of names) {
    await page.getByRole('button', { name: new RegExp(name) }).click()
    await page.getByLabel('目标床位').click()
    await page.getByRole('option', { name: /床/ }).first().click()
    await page.getByRole('button', { name: '接诊并分床', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('操作成功')
    await page.getByRole('button', { name: '返回住院患者' }).click()
  }
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()

  // 医生：先看患者乙（生成其临床查询缓存），再在患者甲添加次诊断草稿，
  // 就地切回乙（查询缓存命中、编辑器不卸载）时草稿不得出现
  await page.goto(`${origin}/inpatient`)
  await page.getByLabel('账户邮箱').fill('inpatient-doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(names[1]!) }).click()
  await page.getByRole('tab', { name: '诊断医嘱', exact: true }).click()
  await expect(page.getByRole('button', { name: '添加次诊断', exact: true })).toBeVisible()

  await page.getByRole('button', { name: new RegExp(names[0]!) }).click()
  await page.getByRole('button', { name: '添加次诊断', exact: true }).click()
  await expect(page.getByText('次诊断 1', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: new RegExp(names[1]!) }).click()
  await expect(page.getByText('次诊断 1', { exact: true })).toHaveCount(0)

  // 切回甲同样不保留草稿：编辑器始终从当前患者的已确认诊断载入
  await page.getByRole('button', { name: new RegExp(names[0]!) }).click()
  await expect(page.getByText('次诊断 1', { exact: true })).toHaveCount(0)
})
