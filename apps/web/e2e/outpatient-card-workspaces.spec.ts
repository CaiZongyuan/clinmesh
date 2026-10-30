import {
  createPatientResponseSchema,
  registrationCatalogSchema,
  registrationResponseSchema,
} from '@clinmesh/contracts/his'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'

async function signIn(page: Page, origin: string, role: string, password: string, path: string) {
  await page.goto(`${origin}${path}`)
  await page.getByLabel('账户邮箱').fill(`${role}@demo.clinmesh.local`)
  await page.getByLabel('账户密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

test('分诊体征在原位说明范围并阻止错误提交，完成后流程转到接诊', async ({ page, browserApp }) => {
  await signIn(page, browserApp.origin, 'registrar', browserApp.password, '/registration')
  await expect(page.getByRole('heading', { name: '门诊挂号', exact: true })).toBeVisible()
  const headers = { origin: browserApp.origin, 'idempotency-key': crypto.randomUUID() }
  const patientResponse = await page.request.post(`${browserApp.origin}/api/his/v1/patients`, {
    headers,
    data: { expectedVersions: {}, input: {
      birthDate: '1990-01-01', gender: 'female', identifier: 'SYN-CARD-TRIAGE', name: '卡片分诊患者',
    } },
  })
  expect(patientResponse.status()).toBe(200)
  const patient = createPatientResponseSchema.parse(await patientResponse.json()).data.patient
  const catalog = registrationCatalogSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/catalogs/registration`)).json())
  const registration = await page.request.post(`${browserApp.origin}/api/his/v1/registrations/actions/register`, {
    headers: { origin: browserApp.origin, 'idempotency-key': crypto.randomUUID() },
    data: { expectedVersions: { [`Patient/${patient.id}`]: patient.versionId }, input: {
      patientId: patient.id, departmentId: catalog.departments[0]!.id, locationId: catalog.locations[0]!.id,
      visitTypeId: catalog.visitTypes[0]!.id, visitDate: catalog.virtualDate,
    } },
  })
  expect(registration.status()).toBe(200)
  registrationResponseSchema.parse(await registration.json())
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  await signIn(page, browserApp.origin, 'triage', browserApp.password, '/triage')
  await page.getByRole('button', { name: '选择病例 卡片分诊患者', exact: true }).click()
  const currentPatient = page.getByRole('region', { name: '当前患者', exact: true })
  await expect(currentPatient).toContainText('卡片分诊患者')
  const triageQueue = page.getByRole('region', { name: '分诊队列', exact: true })
  const risk = page.getByRole('region', { name: '风险信息', exact: true })
  const [queueBox, patientBox, riskBox] = await Promise.all([triageQueue.boundingBox(), currentPatient.boundingBox(), risk.boundingBox()])
  expect(queueBox).not.toBeNull()
  expect(patientBox).not.toBeNull()
  expect(riskBox).not.toBeNull()
  expect(queueBox!.x + queueBox!.width).toBeLessThanOrEqual(patientBox!.x)
  expect(patientBox!.x + patientBox!.width).toBeLessThanOrEqual(riskBox!.x)
  await page.getByRole('button', { name: '收起队列', exact: true }).click()
  await expect(triageQueue).toHaveCount(0)
  expect((await currentPatient.boundingBox())!.width).toBeGreaterThan(patientBox!.width)
  await page.getByRole('button', { name: '展开队列', exact: true }).click()
  await expect(triageQueue).toBeVisible()
  await expect(page.getByText('默认值不是测量结果', { exact: true })).toBeVisible()
  const temperature = page.getByLabel('体温（°C）', { exact: true })
  await temperature.fill('46')
  await expect(temperature).toHaveAttribute('aria-invalid', 'true')
  await expect(temperature).toHaveAccessibleDescription(/请输入30–45范围内的有效数值/)
  const complete = page.getByRole('button', { name: '完成分诊', exact: true })
  await expect(complete).toBeDisabled()
  await temperature.fill('37.2')
  await expect(temperature).not.toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('还差：主诉', { exact: true })).toBeVisible()
  const acuity = page.getByRole('group', { name: '分诊级别', exact: true })
  await expect(acuity.getByRole('button')).toHaveCount(4)
  await acuity.getByRole('button', { name: '二级 · 危重', exact: true }).click()
  await expect(acuity.getByRole('button', { name: '二级 · 危重', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(acuity.getByRole('button', { name: '三级 · 急症', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await page.getByLabel('主诉', { exact: true }).fill('头晕三天，分诊范围验证。')
  await expect(complete).toBeEnabled()
  const triageRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/actions/record-triage'))
  await complete.click()
  expect((await triageRequest).postDataJSON()).toMatchObject({ input: { acuityCode: 'level-2', temperatureC: 37.2 } })
  await expect(page.getByText('分诊完成', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '已分诊', exact: true }).click()
  await page.getByRole('button', { name: '选择病例 卡片分诊患者', exact: true }).click()
  const flow = page.getByRole('list', { name: '办理流程', exact: true })
  await expect(flow.getByRole('listitem').filter({ hasText: '接诊' })).toHaveAttribute('aria-current', 'step')
  await expect(flow.getByRole('listitem').filter({ hasText: '分诊' })).not.toHaveAttribute('aria-current', 'step')
})

test('分诊只提供可办理的队列，空队列说明去哪里处理', async ({ page, browserApp }) => {
  await signIn(page, browserApp.origin, 'triage', browserApp.password, '/triage')
  await expect(page.getByRole('tab', { name: '待分诊', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: '已分诊', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: '异常', exact: true })).toHaveCount(0)
  await expect(page.getByText('暂无待分诊患者，请先由挂号员办理挂号。', { exact: true })).toBeVisible()
})

test('挂号成功后流程标出分诊，下一位患者仍从挂号办理', async ({ page, browserApp }) => {
  await signIn(page, browserApp.origin, 'registrar', browserApp.password, '/registration')
  const queue = page.getByRole('region', { name: '患者选择', exact: true })
  const action = page.getByRole('region', { name: '当前操作', exact: true })
  const flow = page.getByRole('list', { name: '办理流程', exact: true })
  await queue.getByRole('tab', { name: '建档', exact: true }).click()
  await queue.getByLabel('姓名', { exact: true }).fill('流程挂号合成患者')
  await queue.getByLabel('临时患者标识', { exact: true }).fill('SYN-FLOW-REGISTRATION')
  await action.getByRole('button', { name: '创建临时患者', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前患者', exact: true })).toContainText('流程挂号合成患者')
  await expect(flow.getByRole('listitem').filter({ hasText: '挂号' })).toHaveAttribute('aria-current', 'step')
  await action.getByRole('button', { name: '确认挂号', exact: true }).click()
  await expect(action).toContainText('已完成挂号，等待分诊护士接诊')
  await expect(flow.getByRole('listitem').filter({ hasText: '分诊' })).toHaveAttribute('aria-current', 'step')
  await expect(flow.getByRole('listitem').filter({ hasText: '挂号' })).not.toHaveAttribute('aria-current', 'step')
  await queue.getByRole('tab', { name: '建档', exact: true }).click()
  await queue.getByLabel('姓名', { exact: true }).fill('流程下一位合成患者')
  await queue.getByLabel('临时患者标识', { exact: true }).fill('SYN-FLOW-NEXT')
  await action.getByRole('button', { name: '创建临时患者', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前患者', exact: true })).toContainText('流程下一位合成患者')
  await expect(flow.getByRole('listitem').filter({ hasText: '挂号' })).toHaveAttribute('aria-current', 'step')
  await expect(flow.getByRole('listitem').filter({ hasText: '分诊' })).not.toHaveAttribute('aria-current', 'step')
})

test('挂号员在队列内切换门诊与住院，保留同一住院登记表单', async ({ page, browserApp }) => {
  await signIn(page, browserApp.origin, 'registrar', browserApp.password, '/registration')
  const queue = page.getByRole('region', { name: '患者选择', exact: true })
  await queue.getByRole('button', { name: '住院', exact: true }).click()
  await expect(page.getByRole('region', { name: '住院工作台', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: '入院途径', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: '住院登记', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '门诊', exact: true }).click()
  await expect(queue).toBeVisible()
  await expect(queue.getByRole('tab', { name: '待挂号病例', exact: true })).toBeVisible()
})

test('分诊队列读取失败有明确名称和重试，恢复后显示真实空队列', async ({ page, browserApp }) => {
  let attempts = 0
  await page.route(/\/api\/his\/v1\/triage\/queue\?/, route => {
    attempts += 1
    return attempts === 1
      ? route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Synthetic queue failure' } } })
      : route.continue()
  })
  await signIn(page, browserApp.origin, 'triage', browserApp.password, '/triage')
  const queue = page.getByRole('region', { name: '分诊队列', exact: true })
  await expect(queue.getByText('分诊队列读取失败', { exact: true })).toBeVisible()
  await queue.getByRole('button', { name: '重试分诊队列', exact: true }).click()
  await expect(queue.getByText('暂无待分诊患者，请先由挂号员办理挂号。', { exact: true })).toBeVisible()
  expect(attempts).toBe(2)
})
