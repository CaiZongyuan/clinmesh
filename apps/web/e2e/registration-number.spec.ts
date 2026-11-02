import {
  createPatientResponseSchema, doctorCaseDetailSchema, registrationCatalogSchema,
  registrationQueueSchema, registrationResponseSchema,
} from '@clinmesh/contracts/his'
import { expect, test } from './fixtures.ts'

test('keeps one complete visit number across registration, triage and the doctor banner at narrow width', async ({ page, context, browserApp }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.setViewportSize({ width: 390, height: 900 })
  const signIn = async (role: string, path: string) => {
    await page.goto(`${browserApp.origin}${path}`)
    await page.getByLabel('账户邮箱').fill(`${role}@demo.clinmesh.local`)
    await page.getByLabel('账户密码').fill(browserApp.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }
  const signOut = async () => {
    await page.getByRole('button', { name: '用户菜单' }).click()
    await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
    await expect(page.getByRole('heading', { name: '登录科灵脉智' })).toBeVisible()
  }
  const write = async (path: string, expectedVersions: Record<string, string>, input: object) => {
    const response = await page.request.post(`${browserApp.origin}${path}`, {
      headers: { origin: browserApp.origin, 'idempotency-key': crypto.randomUUID() },
      data: { expectedVersions, input },
    })
    expect(response.status()).toBe(200)
    return response.json()
  }
  const copy = async (region: import('@playwright/test').Locator, number: string) => {
    await region.getByRole('button', { name: `复制门诊号 ${number}`, exact: true }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(number)
  }
  await signIn('registrar', '/registration')
  await expect(page.getByRole('heading', { name: '门诊挂号', exact: true })).toBeVisible()
  const patient = createPatientResponseSchema.parse(await write('/api/his/v1/patients', {}, {
    birthDate: '1990-01-01', gender: 'female', identifier: 'SYN-PATIENT-NUMBER-253', name: '号码核对合成患者',
  })).data.patient
  const catalog = registrationCatalogSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/catalogs/registration`)).json())
  const registration = registrationResponseSchema.parse(await write('/api/his/v1/registrations/actions/register', {
    [`Patient/${patient.id}`]: patient.versionId,
  }, { patientId: patient.id, departmentId: catalog.departments[0]!.id, locationId: catalog.locations[0]!.id,
    visitTypeId: catalog.visitTypes[0]!.id, visitDate: catalog.virtualDate })).data
  const records = registrationQueueSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/registrations`)).json())
  const item = records.items.find(item => item.registrationId === registration.registrationId)!
  expect(item.registrationNumber).not.toBe(patient.identifier)
  await page.reload()
  const row = page.getByRole('row').filter({ hasText: '号码核对合成患者' })
  await expect(row).toContainText(item.registrationNumber)
  await copy(row, item.registrationNumber)
  await signOut()
  await signIn('triage', '/triage')
  const assessment = page.getByRole('region', { name: '分诊评估', exact: true })
  const triagePatient = page.getByRole('region', { name: '当前患者', exact: true })
  await expect(triagePatient.locator('[data-registration-number-value]')).toHaveText(item.registrationNumber)
  await expect(triagePatient).toContainText(`患者号：${patient.identifier}`)
  await copy(triagePatient, item.registrationNumber)
  await assessment.getByLabel('主诉', { exact: true }).fill('头晕三天，合成号码核对场景。')
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '完成分诊', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前操作', exact: true })).toContainText('分诊完成')
  await signOut()
  await signIn('doctor', '/consultation')
  await page.getByRole('tab', { name: '待诊', exact: true }).click()
  await page.getByRole('button', { name: '选择病例 号码核对合成患者', exact: true }).click()
  const banner = page.getByRole('region', { name: '当前患者', exact: true })
  await expect(banner.locator('[data-registration-number-value]')).toHaveText(item.registrationNumber)
  await expect(banner).toContainText('主诉：头晕三天，合成号码核对场景。')
  await copy(banner, item.registrationNumber)
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true,
    value: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) }))
  await banner.getByRole('button', { name: `复制门诊号 ${item.registrationNumber}`, exact: true }).click()
  await expect(banner.getByRole('alert')).toHaveText('复制失败，请手动选择门诊号复制')
  const detail = doctorCaseDetailSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/doctor/cases/${item.caseId}`)).json())
  expect(detail.registrationNumber).toBe(item.registrationNumber)
  const bounds = await banner.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }))
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1)
})
