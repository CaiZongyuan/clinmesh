import { inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { expect, test as base } from './fixtures.ts'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'

const test = base.extend({
  browserApp: async ({ webRoot }, use) => {
    const app = await startBrowserServer(webRoot, { syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic-persona',
      chatCompletionsProvider: { completeJson: async input => ({ model: input.model, content: JSON.stringify(persona) }) } })
    try { await use(app) } finally { await app.close() }
  },
})

test('门诊开具住院证后按可见交接提示由登记员转收，病区护士接诊分床', async ({ page, browserApp }) => {
  await startConsultationCase(browserApp.runtime, browserApp.password, browserApp.origin)
  let first = true
  const login = async (name: string) => {
    if (!first) { await page.getByRole('button', { name: '用户菜单' }).click(); await page.getByRole('menuitem', { name: '退出登录' }).click() }
    first = false
    await page.getByLabel('账户邮箱').fill(`${name}@demo.clinmesh.local`)
    await page.getByLabel('账户密码').fill(browserApp.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible()
  }
  await page.goto(`${browserApp.origin}/consultation`)
  await login('doctor')
  await page.getByRole('tab', { name: '待诊', exact: true }).click()
  await page.getByText('张琴', { exact: true }).first().click()
  await page.getByRole('button', { name: '开始首诊', exact: true }).click()
  await expect(page.getByRole('button', { name: '开始首诊', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '开具住院证', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '开具住院证', exact: true })
  await expect(dialog.getByLabel('收治病区')).toContainText('住院病区')
  await dialog.getByLabel('住院原因').fill('门诊评估后需继续住院观察')
  await dialog.getByRole('button', { name: '确认开具住院证', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('登记员 → 住院登记 → 门诊住院证转收')
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('status', { name: '住院证交接', exact: true })).toContainText('登记员 → 住院登记 → 门诊住院证转收')
  await login('registrar')
  await page.getByRole('tab', { name: '住院登记', exact: true }).click()
  await page.getByLabel('入院途径').click()
  await page.getByRole('option', { name: '门诊住院证转收', exact: true }).click()
  await page.getByLabel('住院证', { exact: true }).click()
  await page.getByRole('option', { name: '张琴 · 门诊评估后需继续住院观察', exact: true }).click()
  await expect(page.getByLabel('入院病区')).toHaveValue('住院病区')
  await page.getByLabel('预交金（元）').fill('1000.00')
  await page.getByRole('button', { name: '办理住院', exact: true }).click()
  const banner = page.getByRole('region', { name: '当前住院患者', exact: true })
  await expect(banner).toContainText('张琴')
  await expect(page.getByText('负责岗位：病区护士', { exact: true })).toBeVisible()
  const admission = inpatientListSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/inpatient/admissions`)).json()).items[0]!
  expect(admission).toMatchObject({ admissionRoute: 'outpatient', wardId: 'ward-general', depositFen: 100000, status: 'registered' })
  expect(admission.referralId).toBeTruthy()
  await login('ward-nurse')
  await page.getByRole('button', { name: '查看张琴', exact: true }).click()
  await expect(page.getByRole('tab', { name: '入科分床', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByLabel('目标床位').click()
  await page.getByRole('option', { name: /1床/ }).click()
  await page.getByRole('button', { name: '接诊并分床', exact: true }).click()
  await expect(banner).toContainText('住院号')
  await expect(banner.getByRole('button', { name: `复制住院号 ${admission.inpatientNumber}` })).toBeVisible()
  await expect(banner).toContainText('1床')
  await expect(page.getByRole('tab', { name: '诊断医嘱', exact: true })).toHaveAttribute('aria-selected', 'true')
})
