import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures.ts'

// 纸张编辑风作用域与新岗位界面断言：主题提升到应用根（弹层同主题），离开住院壳后恢复。
test('护士一览板、医生右栏提醒与医保办核定台在纸张主题下呈现', async ({ page, browserApp }) => {
  const { origin, password } = browserApp
  const rootTheme = () => page.evaluate(() => document.querySelector('[data-clinmesh-app="web"]')?.getAttribute('data-palette') ?? null)

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

  // 护士站：一览板床位格与待接诊横幅，纸张主题挂到应用根；接诊分床后床位格可见
  await page.goto(`${origin}/inpatient`)
  await page.getByLabel('账户邮箱').fill('ward-nurse@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '病区一览板' })).toBeVisible()
  await expect(page.getByLabel('待接诊')).toContainText(name)
  expect(await rootTheme()).toBe('paper')
  await page.getByRole('button', { name: new RegExp(name) }).click()
  await page.getByLabel('目标床位').click()
  await page.getByRole('option', { name: /1床/ }).click()
  await page.getByRole('button', { name: '接诊并分床', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('操作成功')
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
  expect(await rootTheme()).toBe('paper')
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()

  // 住院医生：三栏右栏聚合真实提醒（空态即真实事实）
  await page.goto(`${origin}/inpatient`)
  await page.getByLabel('账户邮箱').fill('inpatient-doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(name) }).click()
  await expect(page.getByRole('region', { name: '临床提醒', exact: true })).toBeVisible()
  await expect(page.getByText('暂待办提醒。')).toBeVisible()
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()

  // 门诊医生：离开住院壳后纸张主题被清理，门诊保持方向四
  await page.goto(`${origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible()
  expect(await rootTheme()).toBeNull()
})
