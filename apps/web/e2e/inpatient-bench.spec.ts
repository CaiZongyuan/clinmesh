import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures.ts'

// 新岗位界面结构断言：护士一览板、医生右栏提醒与医保办核定台。
test('护士一览板、医生右栏提醒与医保办核定台呈现真实岗位界面', async ({ page, browserApp }) => {
  const { origin, password } = browserApp

  await page.goto(`${origin}/registration`)
  await page.getByLabel('账户邮箱').fill('registrar@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible()
  const name = `合成纸张岗位${randomUUID().slice(0, 6)}`
  const created = await page.request.post(`${origin}/api/his/v1/patients`, {
    headers: { origin, 'idempotency-key': randomUUID() },
    data: { expectedVersions: {}, input: { name, gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } },
  })
  expect(created.status()).toBe(200)
  const patient = (await created.json()).data.patient
  const session = await (await page.request.get(`${origin}/api/auth/context`)).json()
  const registered = await page.request.post(`${origin}/api/his/v1/inpatient/admissions`, {
    headers: { origin, 'idempotency-key': randomUUID() },
    data: { input: { expectedEpoch: session.actor.epoch, patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 } },
  })
  expect(registered.status(), await registered.text()).toBe(200)
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()

  // 护士站：一览板床位格与待接诊横幅；接诊分床后床位格可见
  await page.goto(`${origin}/inpatient`)
  await page.getByLabel('账户邮箱').fill('ward-nurse@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: "本病区" })).toBeVisible()
  await expect(page.getByLabel("新入院")).toContainText(name)
  await page.getByRole('button', { name: new RegExp(name) }).click()
  await page.getByLabel('目标床位').click()
  await page.getByRole('option', { name: /1床/ }).click()
  await page.getByRole('button', { name: '接诊并分床', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已完成本次操作')
  await page.getByRole('button', { name: '返回住院患者' }).click()
  await expect(page.getByRole('button', { name: new RegExp(`1床 ${name}`) })).toBeVisible()
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()

  // 医保办：核定队列与历史核定，不再渲染空白
  await page.goto(`${origin}/inpatient`)
  await page.getByLabel('账户邮箱').fill('medical-insurance@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('region', { name: '医保办核定工作台', exact: true })).toBeVisible()
  await expect(page.getByLabel('核定队列')).toBeVisible()
  await expect(page.getByLabel('历史核定')).toBeVisible()
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()

  // 住院医生：三栏右栏聚合真实提醒（空态即真实事实）；右栏 1080px 容器断点起显示
  await page.setViewportSize({ width: 1720, height: 900 })
  await page.goto(`${origin}/inpatient`)
  await page.getByLabel('账户邮箱').fill('inpatient-doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(name) }).click()
  await expect(page.getByRole('region', { name: '临床提醒', exact: true })).toBeVisible()
  await expect(page.getByText("目前没有提醒")).toBeVisible()
})

