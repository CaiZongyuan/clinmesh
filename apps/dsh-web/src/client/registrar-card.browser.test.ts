import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { createPatientResponseSchema, patientSearchSchema, registrationCatalogSchema, registrationQueueSchema } from '@clinmesh/contracts/his'
import { startBrowserServer } from '../../../server/tests/browser-server.ts'
import { buildNonDoctorCard, mountNonDoctorCard } from './non-doctor-card.browser.artifact.ts'

async function createRegistrarPatient(page: Page, server: { origin: string }, name: string, identifier: string) {
  const response = await page.request.post(`${server.origin}/api/his/v1/patients`, {
    headers: { origin: server.origin, 'idempotency-key': crypto.randomUUID() },
    data: { expectedVersions: {}, input: { name, identifier, birthDate: '1990-01-01', gender: 'female' } },
  })
  expect(response.status()).toBe(200)
  return createPatientResponseSchema.parse(await response.json()).data.patient
}

for (const version of ['18', '19']) test.describe(`registrar cards on React ${version}`, () => {
  test.beforeAll(async () => { await buildNonDoctorCard(version) })
  test('submits the reviewed patient snapshot and preserves edits made while the decision gate waits', async ({ page }) => {
    const server = await startBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await mountNonDoctorCard(page, version, server, 'registrar')
      await page.getByRole('tab', { name: '建档', exact: true }).click()
      await page.getByLabel('姓名', { exact: true }).fill('已审阅患者甲')
      await page.getByLabel('临时患者标识', { exact: true }).fill('SYN-REVIEWED-PATIENT-A')
      await page.getByLabel('延迟批准', { exact: true }).check()
      await page.getByRole('button', { name: '助手准备建档', exact: true }).click()
      const review = page.getByRole('region', { name: '创建临时患者', exact: true })
      await expect(review).toContainText('已审阅患者甲')
      await review.getByRole('button', { name: '创建临时患者', exact: true }).click()
      await expect(page.getByLabel('批准状态', { exact: true })).toHaveText('等待批准闸门')
      await page.getByLabel('姓名', { exact: true }).fill('后来填写患者乙')
      await page.getByLabel('临时患者标识', { exact: true }).fill('SYN-UNREVIEWED-PATIENT-B')
      const received = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/his/v1/patients')
      await page.getByRole('button', { name: '放行确认', exact: true }).click()
      const response = await received
      expect(response.status()).toBe(200)
      const patient = createPatientResponseSchema.parse(await response.json()).data.patient
      expect(patient).toMatchObject({ name: '已审阅患者甲', identifier: 'SYN-REVIEWED-PATIENT-A' })
      await expect(page.getByLabel('姓名', { exact: true })).toHaveValue('后来填写患者乙')
      await expect(page.getByLabel('临时患者标识', { exact: true })).toHaveValue('SYN-UNREVIEWED-PATIENT-B')
    } finally { await server.close() }
  })

  test('registers the reviewed patient when another patient is selected while approval waits', async ({ page }) => {
    const server = await startBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await mountNonDoctorCard(page, version, server, 'registrar')
      const create = async (name: string, identifier: string) => {
        const response = await page.request.post(`${server.origin}/api/his/v1/patients`, {
          headers: { origin: server.origin, 'idempotency-key': crypto.randomUUID() },
          data: { expectedVersions: {}, input: { name, identifier, birthDate: '1990-01-01', gender: 'female' } },
        })
        expect(response.status()).toBe(200)
        return createPatientResponseSchema.parse(await response.json()).data.patient
      }
      const first = await create('快照挂号甲', 'SYN-REGISTRATION-SNAPSHOT-A')
      const second = await create('快照挂号乙', 'SYN-REGISTRATION-SNAPSHOT-B')
      await page.getByRole('tab', { name: '检索', exact: true }).click()
      await page.getByLabel('姓名、门诊号或合成标识', { exact: true }).fill('快照挂号')
      await page.getByRole('button', { name: '搜索', exact: true }).click()
      await page.getByRole('button', { name: '选择患者 快照挂号甲', exact: true }).click()
      await page.getByLabel('延迟批准', { exact: true }).check()
      await page.getByRole('button', { name: '助手准备挂号', exact: true }).click()
      const review = page.getByRole('region', { name: '挂号信息', exact: true }).filter({ hasText: '待人工确认；请在此确认本次操作' })
      await expect(review).toContainText(first.name)
      await review.getByRole('button', { name: '确认挂号', exact: true }).click()
      await expect(page.getByLabel('批准状态', { exact: true })).toHaveText('等待批准闸门')
      await page.getByRole('button', { name: '选择患者 快照挂号乙', exact: true }).click()
      const received = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/his/v1/registrations/actions/register')
      await page.getByRole('button', { name: '放行确认', exact: true }).click()
      const response = await received
      expect(response.status()).toBe(200)
      expect(response.request().postDataJSON().input.patientId).toBe(first.id)
      const queue = registrationQueueSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/registrations`)).json())
      expect(queue.items.some(item => item.patient.id === first.id)).toBe(true)
      expect(queue.items.some(item => item.patient.id === second.id)).toBe(false)
      await expect(page.getByRole('button', { name: '已选择患者 快照挂号乙', exact: true })).toHaveAttribute('aria-pressed', 'true')
    } finally { await server.close() }
  })

  test('marks actual assistant draft fields independently and removes old patient provenance', async ({ page }) => {
    const server = await startBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await mountNonDoctorCard(page, version, server, 'registrar', {
        'registration.patient.draft.set': { name: '助手填写甲', identifier: 'SYN-ASSISTED-REGISTRAR', birthDate: '1988-01-02', gender: 'female' },
      })
      const other = await createRegistrarPatient(page, server, '来源隔离乙', 'SYN-OTHER-REGISTRAR')
      await page.getByRole('button', { name: '助手填写 registration.patient.draft.set', exact: true }).click()
      const queue = page.getByRole('region', { name: '患者选择', exact: true })
      await expect(queue.getByText('助手', { exact: true })).toHaveCount(4)
      await expect(queue.getByRole('textbox', { name: '姓名', exact: true })).toHaveValue('助手填写甲')
      await queue.getByRole('textbox', { name: '姓名', exact: true }).fill('人工改名')
      await expect(queue.getByText('助手', { exact: true })).toHaveCount(3)
      await expect(queue.getByLabel('出生日期', { exact: true })).toHaveCSS('border-style', 'dashed')
      await queue.getByRole('combobox', { name: '性别', exact: true }).click()
      await page.getByRole('option', { name: '男', exact: true }).click()
      await expect(queue.getByText('助手', { exact: true })).toHaveCount(2)
      await expect(queue.getByRole('textbox', { name: '临时患者标识', exact: true })).toHaveCSS('border-style', 'dashed')
      const notCreated = patientSearchSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/patients?query=${encodeURIComponent('助手填写甲')}`)).json())
      expect(notCreated.items).toHaveLength(0)
      await queue.getByRole('tab', { name: '检索', exact: true }).click()
      await queue.getByLabel('姓名、门诊号或合成标识', { exact: true }).fill(other.name)
      await queue.getByRole('button', { name: '搜索', exact: true }).click()
      await queue.getByRole('button', { name: `选择患者 ${other.name}`, exact: true }).click()
      await queue.getByRole('tab', { name: '建档', exact: true }).click()
      await expect(queue.getByRole('textbox', { name: '姓名', exact: true })).toHaveValue('')
      await expect(queue.getByText('助手', { exact: true })).toHaveCount(0)
    } finally { await server.close() }
  })

  test('loads today on demand across the Beijing midnight boundary and retains all historical pages', async ({ page }) => {
    const server = await startBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      const login = await page.request.post(`${server.origin}/api/auth/sign-in/email`, {
        headers: { origin: server.origin }, data: { email: 'registrar@demo.clinmesh.local', password: server.password },
      })
      expect(login.status()).toBe(200)
      const patient = await createRegistrarPatient(page, server, '日期边界合成患者', 'SYN-REGISTRATION-DATE')
      const catalog = registrationCatalogSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/catalogs/registration`)).json())
      const registered = await page.request.post(`${server.origin}/api/his/v1/registrations/actions/register`, {
        headers: { origin: server.origin, 'idempotency-key': crypto.randomUUID() },
        data: { expectedVersions: { [`Patient/${patient.id}`]: patient.versionId }, input: {
          patientId: patient.id, departmentId: catalog.departments[0]!.id, locationId: catalog.locations[0]!.id,
          visitTypeId: catalog.visitTypes[0]!.id, visitDate: catalog.virtualDate,
        } },
      })
      expect(registered.status()).toBe(200)
      const original = registrationQueueSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/registrations`)).json()).items[0]!
      // Only the read projection is synthetic. Literal UTC timestamps independently specify the Beijing date boundary.
      const rows = Array.from({ length: 41 }, (_, index) => ({ ...original,
        caseId: `${original.caseId}-${index}`, registrationId: `${original.registrationId}-${index}`,
        registrationNumber: `CM-OP-20261031-${String(index + 1).padStart(4, '0')}`,
        arrivedAt: index < 20 ? '2026-10-31T04:00:00.000Z' : index === 20 ? '2026-10-30T16:00:00.000Z'
          : index === 40 ? '2026-10-29T00:00:00.000Z' : '2026-10-30T15:59:59.000Z',
        patient: { ...original.patient, id: `${original.patient.id}-${index}`,
          name: index < 20 ? `今日记录${index + 1}` : index === 20 ? '北京时间零点记录' : index === 40 ? '历史分页末条' : `昨日记录${index - 20}` },
      }))
      const requestedPages: number[] = []
      await page.route('**/api/his/v1/catalogs/registration', route => route.fulfill({ json: { ...catalog, virtualDate: '2026-10-31' } }))
      await page.route('**/api/his/v1/registrations?**', route => {
        const number = Number(new URL(route.request().url()).searchParams.get('page') ?? 1)
        requestedPages.push(number)
        return route.fulfill({ json: registrationQueueSchema.parse({ page: number, pageSize: 20, total: rows.length, items: rows.slice((number - 1) * 20, number * 20) }) })
      })
      await mountNonDoctorCard(page, version, server, 'registrar')
      const records = page.getByRole('region', { name: '挂号记录', exact: true })
      await expect(records.getByText('已加载 20 条今日记录', { exact: true })).toBeVisible()
      await expect(records.getByRole('button', { name: '加载更多今日记录', exact: true })).toBeEnabled()
      expect(requestedPages).toEqual([1])
      await records.getByRole('button', { name: '加载更多今日记录', exact: true }).click()
      await expect(records.getByText('已加载 21 条今日记录', { exact: true })).toBeVisible()
      await expect(records.getByText('北京时间零点记录', { exact: true })).toBeVisible()
      await expect(records.getByText('昨日记录1', { exact: true })).toHaveCount(0)
      await expect(records.getByRole('button', { name: '加载更多今日记录', exact: true })).toHaveCount(0)
      expect(requestedPages).toEqual([1, 2])
      await records.getByRole('button', { name: '全部', exact: true }).click()
      const navigation = records.getByRole('navigation', { name: '挂号记录', exact: true })
      await navigation.getByRole('button', { name: '下一页', exact: true }).click()
      await expect(records.getByText('昨日记录1', { exact: true })).toBeVisible()
      await navigation.getByRole('button', { name: '下一页', exact: true }).click()
      await expect(records.getByText('历史分页末条', { exact: true })).toBeVisible()
      expect(requestedPages.slice(-3)).toEqual([1, 2, 3])
    } finally { await server.close() }
  })
})
