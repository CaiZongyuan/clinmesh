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

test('分诊体征在原位说明范围并阻止错误提交，修正后可完成分诊', async ({ page, browserApp }) => {
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
  await page.getByLabel('主诉', { exact: true }).fill('头晕三天，分诊范围验证。')
  await expect(complete).toBeEnabled()
  await complete.click()
  await expect(page.getByText('分诊完成', { exact: true })).toBeVisible()
})

test('分诊只提供可办理的队列，空队列说明去哪里处理', async ({ page, browserApp }) => {
  await signIn(page, browserApp.origin, 'triage', browserApp.password, '/triage')
  await expect(page.getByRole('tab', { name: '待分诊', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: '已分诊', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: '异常', exact: true })).toHaveCount(0)
  await expect(page.getByText('暂无待分诊患者，请先由挂号员办理挂号。', { exact: true })).toBeVisible()
})
