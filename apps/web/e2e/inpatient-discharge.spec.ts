import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { createPatientResponseSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientSettlementResponseSchema, inpatientSettlementPreviewSchema } from '@clinmesh/contracts/inpatient-discharge'

async function setup(page: Page, app: { origin: string; password: string }, withCharge = false) {
  let first = true, activeRole = ''
  const login = async (name: string) => {
    if (!first) { await page.getByRole('button', { name: '用户菜单' }).click(); await page.getByRole('menuitem', { name: '退出登录' }).click() }
    first = false
    activeRole = name
    await page.getByLabel('账户邮箱').fill(`${name}@demo.clinmesh.local`)
    await page.getByLabel('账户密码').fill(app.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible()
    if (name === 'cashier') await page.getByRole('tab', { name: '住院费用', exact: true }).click()
  }
  const request = (path: string, input: unknown) => page.request.post(`${app.origin}${path}`, { headers: { origin: app.origin, 'idempotency-key': randomUUID() }, data: { input } })
  await page.goto(`${app.origin}/registration`)
  await login('registrar')
  const patient = createPatientResponseSchema.parse(await (await page.request.post(`${app.origin}/api/his/v1/patients`, {
    headers: { origin: app.origin, 'idempotency-key': randomUUID() }, data: { expectedVersions: {}, input: { name: '合成出院患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } },
  })).json()).data.patient
  const session = sessionContextSchema.parse(await (await page.request.get(`${app.origin}/api/auth/context`)).json())
  const admission = inpatientCommandResponseSchema.parse(await (await request('/api/his/v1/inpatient/admissions', { expectedEpoch: session.actor.epoch,
    patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  await login('ward-nurse')
  expect((await request(`${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })).status()).toBe(200)
  if (withCharge) {
    await login('admin')
    expect((await request('/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-25T00:00:00+08:00' })).status()).toBe(200)
  }
  const select = async () => {
    if (activeRole === 'cashier') await page.getByRole('tab', { name: '住院费用', exact: true }).click()
    await page.getByRole('button', { name: '查看合成出院患者', exact: true }).click()
  }
  await login('inpatient-doctor')
  await select()
  await page.getByLabel('出院处理说明', { exact: true }).fill('治疗完成')
  await page.getByRole('button', { name: '开出院医嘱', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('操作成功')
  await login('ward-nurse')
  await select()
  await page.getByLabel('出院处理说明', { exact: true }).fill('已完成护士出区核对')
  await page.getByLabel('离院方式', { exact: true }).click()
  await page.getByRole('option', { name: '医嘱离院', exact: true }).click()
  await page.getByRole('button', { name: '办理出区', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('操作成功')
  await login('cashier')
  await select()
  return { path, login, select, request }
}

test('真实出院结算丢回执后刷新恢复原指纹和幂等键，仅一次退款，护士再清床', async ({ page, browserApp }) => {
  const s = await setup(page, browserApp)
  await page.getByRole('button', { name: '预览结算', exact: true }).click()
  await expect(page.getByTestId('settlement-refund')).toContainText('1,000.00')
  let posts = 0, key: string | undefined, originalInput: unknown
  await page.route(`**${s.path}/discharge/settle`, async route => {
    posts += 1
    key = route.request().headers()['idempotency-key']
    originalInput = route.request().postDataJSON().input
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    inpatientSettlementResponseSchema.parse(await response.json())
    await route.abort('failed')
  })
  await page.getByRole('button', { name: '确认结算', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('无法连接科灵脉智服务')
  await page.reload()
  await s.select()
  const receipt = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
  expect(new URL((await receipt).url()).searchParams.get('idempotencyKey')).toBe(key)
  await expect(page.getByRole('status')).toContainText('操作成功')
  expect(posts).toBe(1)
  const preview = inpatientSettlementPreviewSchema.parse(await (await page.request.get(`${browserApp.origin}${s.path}/discharge/preview`)).json())
  expect(preview.transactions.filter(transaction => transaction.kind === 'refund')).toHaveLength(1)
  expect(preview.settlement?.fingerprint).toBe((originalInput as { fingerprint: string }).fingerprint)
  await expect(page.getByText('已结算，等待病区清床', { exact: true })).toBeVisible()
  await s.login('ward-nurse')
  await s.select()
  await page.getByLabel('出院处理说明', { exact: true }).fill('床单位清洁完成')
  await page.getByRole('button', { name: '清床', exact: true }).click()
  await expect(page.getByText('当前床位：未分床', { exact: true })).toBeVisible()
})

test('收费员看到的结算预览保持冻结，账目冲正后拒绝原预览，显式重新预览后结算', async ({ page, browserApp }) => {
  await setup(page, browserApp, true)
  await page.getByRole('button', { name: '预览结算', exact: true }).click()
  await expect(page.getByTestId('settlement-net')).toContainText('50.00')
  await page.getByLabel('冲正理由', { exact: true }).fill('合成费用核对冲正')
  await page.getByRole('button', { name: '冲正', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('操作成功')
  await expect(page.getByTestId('settlement-net')).toContainText('50.00')
  await page.getByRole('button', { name: '确认结算', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('账目或资金已变化，请重新预览结算')
  await expect(page.getByTestId('settlement-net')).toContainText('50.00')
  await page.getByRole('button', { name: '重新预览结算', exact: true }).click()
  await expect(page.getByTestId('settlement-net')).toContainText('0.00')
  await page.getByRole('button', { name: '确认结算', exact: true }).click()
  await expect(page.getByText('已结算，等待病区清床', { exact: true })).toBeVisible()
})
