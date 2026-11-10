import { selectInpatientStage } from './inpatient-ui.ts'
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
  await expect(page.getByRole('heading', { name: "本病区" })).toBeVisible()
  for (const name of names) {
    await page.getByRole('button', { name: new RegExp(name) }).click()
    await page.getByRole('group', { name: '目标床位' }).getByRole('button', { name: /床/, disabled: false }).first().click()
    await page.getByRole('button', { name: '接诊并分床', exact: true }).click()
    await expect(page.getByText(`已完成本次操作 · ${name} · 已完成接诊分床`, { exact: true })).toBeVisible()
  }
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()

  // 医生：先看患者乙（生成其临床查询缓存），再在患者甲添加次诊断草稿，
  // 就地切回乙（查询缓存命中、编辑器不卸载）时草稿不得出现
  await page.route('**/api/his/v1/reference-catalogs/diagnoses?**', route => route.fulfill({ json: {
    items: [{ id: 'diagnosis-hypertension', code: 'I10', display: '高血压', domain: 'diagnosis', sourceLocator: 'synthetic', status: 'active', system: 'http://hl7.org/fhir/sid/icd-10', version: '1' }],
    page: 1, pageSize: 20, total: 1, releaseId: 'synthetic-doctor-switch',
  } }))
  await page.goto(`${origin}/inpatient`)
  await page.getByLabel('账户邮箱').fill('inpatient-doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(names[1]!) }).click()
  await selectInpatientStage(page, "诊断医嘱")
  const summary = page.getByRole('region', { name: '住院诊断摘要', exact: true })
  await summary.getByRole('button', { name: '添加诊断', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '确认住院诊断', exact: true })
  await expect(dialog.getByLabel('搜索诊断名称或编码', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()

  await page.getByRole('button', { name: new RegExp(names[0]!) }).click()
  await summary.getByRole('button', { name: '添加诊断', exact: true }).click()
  await dialog.getByLabel('搜索诊断名称或编码', { exact: true }).fill('高血压')
  await dialog.getByRole('button', { name: /加入.*高血压/ }).first().click()
  await expect(dialog.getByRole('region', { name: '本次住院诊断', exact: true })).toContainText('1 条')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()

  await page.getByRole('button', { name: new RegExp(names[1]!) }).click()
  await summary.getByRole('button', { name: '添加诊断', exact: true }).click()
  await expect(dialog.getByRole('region', { name: '本次住院诊断', exact: true })).toContainText('0 条')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()

  // 切回甲同样不保留草稿：编辑器始终从当前患者的已确认诊断载入
  await page.getByRole('button', { name: new RegExp(names[0]!) }).click()
  await summary.getByRole('button', { name: '添加诊断', exact: true }).click()
  await expect(dialog.getByRole('region', { name: '本次住院诊断', exact: true })).toContainText('0 条')
})
