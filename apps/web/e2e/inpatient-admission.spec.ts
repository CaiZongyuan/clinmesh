import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures.ts'
import { inpatientCommandResponseSchema, inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { createPatientResponseSchema, sessionContextSchema } from '@clinmesh/contracts/his'

test('登记员真实入口办理住院，病区护士接诊分床后可查询费用账户', async ({ page, browserApp }) => {
  await page.goto(`${browserApp.origin}/registration`)
  await page.getByLabel('账户邮箱').fill('registrar@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('tab', { name: '住院登记', exact: true })).toBeVisible()
  const name = `合成住院患者${randomUUID().slice(0, 8)}`
  const created = await page.request.post(`${browserApp.origin}/api/his/v1/patients`, {
    headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() },
    data: { expectedVersions: {}, input: { name, gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } },
  })
  expect(created.status()).toBe(200)
  await page.getByRole('tab', { name: '住院登记', exact: true }).click()
  await page.getByLabel('搜索住院患者').fill(name)
  await page.getByRole('button', { name: '搜索患者', exact: true }).click()
  await page.getByLabel('住院患者', { exact: true }).click()
  await page.getByRole('option', { name: new RegExp(name) }).click()
  await expect(page.getByLabel('入院病区')).toHaveValue('住院病区')
  await page.getByLabel('预交金（元）').fill('1000.00')
  await page.getByRole('button', { name: '办理住院', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText(name)
  await expect(page.getByText('负责岗位：病区护士', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()
  await page.getByLabel('账户邮箱').fill('ward-nurse@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('button', { name: `查看${name}`, exact: true }).click()
  await page.getByLabel('目标床位').click()
  await page.getByRole('option', { name: /1床/ }).click()
  await page.getByRole('button', { name: '接诊并分床', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('操作成功')
  await expect(page.getByText('住院病区 · 1床', { exact: true })).toBeVisible()
  const banner = page.getByRole('region', { name: '当前住院患者', exact: true })
  await expect(banner).toContainText(name)
  await expect(banner).toContainText('住院号')
  await expect(page.getByRole('tab', { name: '诊断医嘱', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel')).toHaveCount(1)
  await expect(page.getByRole('region', { name: '住院手术', exact: true })).toHaveCount(0)
  await page.getByRole('tab', { name: '出院结算', exact: true }).click()
  await page.getByLabel('出院处理说明', { exact: true }).fill('待交接的原护理说明')
  await page.getByRole('tab', { name: '入科分床', exact: true }).click()
  await expect(banner).toContainText(name)
  await page.getByRole('tab', { name: '出院结算', exact: true }).click()
  await expect(page.getByLabel('出院处理说明', { exact: true })).toHaveValue('待交接的原护理说明')
  await page.setViewportSize({ width: 390, height: 700 })
  await expect(banner).toBeVisible()
  await expect(page.getByRole('tabpanel')).toHaveCount(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect(page.getByRole('tab', { name: '转科交接', exact: true })).toHaveCount(0)
})

test('住院登记已提交但回执丢失，刷新后恢复原意图仅收取一次预交金', async ({ page, browserApp }) => {
  await page.goto(`${browserApp.origin}/registration`)
  await page.getByLabel('账户邮箱').fill('registrar@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('tab', { name: '住院登记', exact: true }).click()
  const name = `合成回执患者${randomUUID().slice(0, 8)}`
  const created = await page.request.post(`${browserApp.origin}/api/his/v1/patients`, {
    headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() },
    data: { expectedVersions: {}, input: { name, gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } },
  })
  expect(created.status()).toBe(200)
  await page.getByLabel('搜索住院患者').fill(name)
  await page.getByRole('button', { name: '搜索患者', exact: true }).click()
  await page.getByLabel('住院患者', { exact: true }).click()
  await page.getByRole('option', { name: new RegExp(name) }).click()
  await expect(page.getByLabel('入院病区')).toHaveValue('住院病区')
  await page.getByLabel('预交金（元）').fill('1000.00')
  let originalKey: string | undefined
  let originalInput: unknown
  let posts = 0
  await page.route('**/api/his/v1/inpatient/admissions', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    posts += 1
    originalKey = route.request().headers()['idempotency-key']
    originalInput = route.request().postDataJSON()
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    await route.abort('failed')
  })
  await page.getByRole('button', { name: '办理住院', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('无法连接科灵脉智服务，请检查网络连接后重试。')
  await page.reload()
  await page.getByRole('tab', { name: '住院登记', exact: true }).click()
  await expect(page.getByRole('button', { name: '恢复原住院操作', exact: true })).toBeVisible()
  let receiptKey: string | null = null
  await page.route('**/api/his/v1/command-receipts?*', async route => {
    receiptKey = new URL(route.request().url()).searchParams.get('idempotencyKey')
    await route.continue()
  })
  await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('操作成功')
  expect(receiptKey).toBe(originalKey)
  expect(posts).toBe(1)
  expect(originalInput).toMatchObject({ input: { depositFen: 100000 } })
  const admissions = await (await page.request.get(`${browserApp.origin}/api/his/v1/inpatient/admissions`)).json()
  expect(admissions.items).toHaveLength(1)
  expect(admissions.items[0]).toMatchObject({ patientName: name, depositFen: 100000 })
  const depositCount = browserApp.runtime.database.driver.prepare('SELECT COUNT(*) count FROM inpatient_deposit').get()
  expect(depositCount).toEqual({ count: 1 })
})

test('互换床位提交后丢回执，刷新读取新版本后恢复也不会再交换回原床', async ({ page, browserApp }) => {
  await page.goto(`${browserApp.origin}/registration`)
  await page.getByLabel('账户邮箱').fill('registrar@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('tab', { name: '住院登记', exact: true })).toBeVisible()
  const context = sessionContextSchema.parse(await (await page.request.get(`${browserApp.origin}/api/auth/context`)).json())
  const create = async (name: string) => {
    const headers = { origin: browserApp.origin, 'idempotency-key': randomUUID() }
    const patient = createPatientResponseSchema.parse(await (await page.request.post(`${browserApp.origin}/api/his/v1/patients`, {
      headers, data: { expectedVersions: {}, input: { name, gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } },
    })).json()).data.patient
    return inpatientCommandResponseSchema.parse(await (await page.request.post(`${browserApp.origin}/api/his/v1/inpatient/admissions`, {
      headers: { ...headers, 'idempotency-key': randomUUID() }, data: { input: { expectedEpoch: context.actor.epoch,
        patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0 } },
    })).json()).data.admission
  }
  const a = await create('合成互换甲')
  const b = await create('合成互换乙')
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()
  await page.getByLabel('账户邮箱').fill('ward-nurse@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '查看合成互换甲', exact: true })).toBeVisible()
  for (const [admission, bedId] of [[a, 'bed-general-1'], [b, 'bed-general-2']] as const) {
    const response = await page.request.post(`${browserApp.origin}/api/his/v1/inpatient/admissions/${admission.id}/receive`, {
      headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() }, data: { input: { encounterVersion: admission.versionId, bedId } },
    })
    expect(response.status()).toBe(200)
  }
  await page.reload()
  await page.getByRole('button', { name: '查看合成互换甲', exact: true }).click()
  await page.getByRole('tab', { name: '入科分床', exact: true }).click()
  await page.getByLabel('换床患者').click()
  await page.getByRole('option', { name: /合成互换乙/ }).click()
  let key: string | undefined
  let posts = 0
  await page.route(`**/api/his/v1/inpatient/admissions/${a.id}/swap-bed`, async route => {
    posts += 1
    key = route.request().headers()['idempotency-key']
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    await route.abort('failed')
  })
  await page.getByRole('button', { name: '互换床位', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('无法连接科灵脉智服务，请检查网络连接后重试。')
  const saved = await page.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith('clinmesh.inpatient-intent:'))?.[1])
  await page.reload()
  await page.getByRole('button', { name: '查看合成互换甲', exact: true }).click()
  await expect(page.getByText('住院病区 · 2床', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith('clinmesh.inpatient-intent:'))?.[1])).toBe(saved)
  const receipt = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
  expect(new URL((await receipt).url()).searchParams.get('idempotencyKey')).toBe(key)
  await expect(page.getByRole('status')).toContainText('操作成功')
  expect(posts).toBe(1)
  const items = inpatientListSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/inpatient/admissions`)).json()).items
  expect(items.find(item => item.id === a.id)?.bedId).toBe('bed-general-2')
  expect(items.find(item => item.id === b.id)?.bedId).toBe('bed-general-1')
})

test('虚拟时间推进回执丢失后保持原时间输入和key恢复，不重复推进revision', async ({ page, browserApp }) => {
  await page.goto(`${browserApp.origin}/scenario-data`)
  await page.getByLabel('账户邮箱').fill('admin@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByLabel('推进到（北京时间）').fill('2026-08-25T09:00')
  const posts: Array<{ input: unknown; key: string | undefined }> = []
  await page.route('**/api/sim/v1/scenario-runs/*/actions/advance-time', async route => {
    posts.push({ input: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] })
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    if (posts.length === 1) await route.abort('failed')
    else await route.fulfill({ response })
  })
  await page.getByRole('button', { name: '推进虚拟时间', exact: true }).click()
  const clock = page.getByRole('form', { name: '场景虚拟时间', exact: true })
  await expect(clock.getByRole('alert')).toContainText('无法连接科灵脉智服务，请检查网络连接后重试。')
  await page.reload()
  await page.getByRole('button', { name: '恢复原时间推进', exact: true }).click()
  await expect(clock.getByRole('status')).toContainText('已推进，新增0笔床位费')
  expect(posts).toHaveLength(2)
  expect(posts[1]).toEqual(posts[0])
  expect(browserApp.runtime.database.driver.prepare('SELECT clock_revision FROM scenario_epoch_state WHERE epoch=?').get('epoch-1'))
    .toEqual({ clock_revision: 2 })
})
