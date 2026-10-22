import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures.ts'
import { createPatientResponseSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDischargeResponseSchema, inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientFinancialSchema } from '@clinmesh/contracts/inpatient-finance'
import { insurancePreviewResponseSchema } from '@clinmesh/contracts/insurance'

test('真实收费入口追加医保更正、退患者差额，丢回执刷新恢复且未知原退款只退一次', async ({ page, browserApp: app }) => {
  const loginApi = async (name: string) => {
    expect((await page.request.post(`${app.origin}/api/auth/sign-in/email`, { headers: { origin: app.origin },
      data: { email: `${name}@demo.clinmesh.local`, password: app.password } })).status()).toBe(200)
  }
  const request = (path: string, input: unknown, expectedVersions?: object) => page.request.post(`${app.origin}${path}`, {
    headers: { origin: app.origin, 'idempotency-key': randomUUID() }, data: { input, ...(expectedVersions ? { expectedVersions } : {}) },
  })
  await loginApi('registrar')
  const patient = createPatientResponseSchema.parse(await (await request('/api/his/v1/patients', {
    name: '合成医保更正患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}`,
  }, {})).json()).data.patient
  const admission = inpatientCommandResponseSchema.parse(await (await request('/api/his/v1/inpatient/admissions', {
    expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 5000,
  })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  await loginApi('ward-nurse')
  const received = inpatientCommandResponseSchema.parse(await (await request(`${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })).json()).data.admission
  await loginApi('admin')
  expect((await request('/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
    expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-27T00:00:00+08:00',
  })).status()).toBe(200)
  await loginApi('inpatient-doctor')
  const issued = inpatientDischargeResponseSchema.parse(await (await request(`${path}/discharge/issue`, { encounterVersion: received.versionId, reason: '合成治疗完成' })).json()).data.admission
  await loginApi('ward-nurse')
  inpatientDischargeResponseSchema.parse(await (await request(`${path}/discharge/depart`, { encounterVersion: issued.versionId, reason: '合成出区核对完成', departureMethod: 'home' })).json())
  await loginApi('cashier')
  const insurance = insurancePreviewResponseSchema.parse(await (await request(`/api/his/v1/insurance/inpatient/${admission.id}/preview`, { planCode: 'employee-v1' }, {})).json()).data
  expect((await request(`/api/his/v1/insurance/inpatient/${admission.id}/confirm`, { previewId: insurance.previewId, commitToken: insurance.commitToken }, {})).status()).toBe(200)
  const preview = inpatientSettlementPreviewSchema.parse(await (await page.request.get(`${app.origin}${path}/discharge/preview`)).json())
  const settled = inpatientSettlementResponseSchema.parse(await (await request(`${path}/discharge/settle`, {
    encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint, expectedChargesFen: preview.chargesFen, expectedBalanceFen: preview.balanceFen,
  })).json()).data
  await loginApi('ward-nurse')
  expect((await request(`${path}/discharge/clear`, { encounterVersion: settled.encounterVersion, reason: '合成床位清洁完成' })).status()).toBe(200)
  await loginApi('cashier')
  const select = async () => {
    await page.getByRole('tab', { name: '住院费用', exact: true }).click()
    await page.getByRole('button', { name: '查看合成医保更正患者', exact: true }).click()
    await page.getByRole('tab', { name: '出院结算', exact: true }).click()
  }
  await page.goto(`${app.origin}/billing`)
  await select()
  const section = page.getByRole('region', { name: '后续财务更正', exact: true })
  await section.getByLabel('更正金额（元）', { exact: true }).fill('10')
  await section.getByLabel('财务更正原因', { exact: true }).fill('合成医保床日费用冲减')
  await section.getByRole('button', { name: '审阅财务更正', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '提交财务更正', exact: true }).click()
  const revised = section.getByRole('region', { name: '后续医保更正', exact: true })
  await revised.getByRole('button', { name: '审阅原待遇补偿', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认补偿原待遇', exact: true }).click()
  await revised.getByRole('button', { name: '预览更正医保', exact: true }).click()
  await expect(page.getByTestId('financial-insurance-review')).toContainText('48.00')
  await page.getByRole('alertdialog').getByRole('button', { name: '确认更正待遇', exact: true }).click()
  await expect(revised.getByTestId('financial-insurance-active')).toContainText('48.00')
  await section.getByLabel('本次收退金额（元）', { exact: true }).fill('2')
  await section.getByLabel('合成渠道结果', { exact: true }).click()
  await page.getByRole('option', { name: '未知，查询成功', exact: true }).click()
  await section.getByRole('button', { name: '预览后续退款', exact: true }).click()
  let posts = 0, originalKey = '', aborted = false
  await page.route(`**${path}/financial-adjustments/refunds/confirm`, async route => {
    posts += 1; originalKey = route.request().headers()['idempotency-key']!
    expect((await route.fetch()).status()).toBe(200)
    await route.abort('failed')
    aborted = true
  })
  await page.getByRole('alertdialog').getByRole('button', { name: '确认本次收退', exact: true }).click()
  await expect.poll(() => aborted).toBe(true)
  await page.reload()
  await select()
  const receiptRequest = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
  expect(new URL((await receiptRequest).url()).searchParams.get('idempotencyKey')).toBe(originalKey)
  await expect(section.getByText('资金结果未知', { exact: false })).toBeVisible()
  await section.getByRole('button', { name: '查询原后续退款结果', exact: true }).click()
  await expect(section.getByText('调整完成', { exact: false })).toBeVisible()
  expect(posts).toBe(1)
  const bill = inpatientFinancialSchema.parse(await (await page.request.get(`${app.origin}${path}/financial-adjustments`)).json())
  expect(bill).toMatchObject({ currentFundsFen: 4800, remainingRefundFen: 0, status: 'cleared' })
  expect(bill.refunds).toHaveLength(1)
  const frozen = inpatientSettlementPreviewSchema.parse(await (await page.request.get(`${app.origin}${path}/discharge/preview`)).json())
  expect(frozen.insurance).toEqual(settled.insurance)
  expect(frozen.transactions).toEqual(settled.transactions)
  expect(frozen.settlement).toEqual(settled.settlement)
})
