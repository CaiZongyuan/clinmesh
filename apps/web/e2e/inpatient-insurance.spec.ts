import { randomUUID } from 'node:crypto'
import { createPatientResponseSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDischargeResponseSchema, inpatientSettlementPreviewSchema, inpatientPaymentsSchema } from '@clinmesh/contracts/inpatient-discharge'
import { insuranceStateSchema } from '@clinmesh/contracts/insurance'
import { expect, test } from './fixtures.ts'

for (const scenario of [
  { plan: 'employee-v1', option: '合成职工 v1', depositFen: 1000, fundFen: 8000, accountFen: 2000, patientFen: 5000, balance: '40.00' },
  { plan: 'resident-v1', option: '合成居民 v1', depositFen: 20000, fundFen: 3000, accountFen: 0, patientFen: 12000, balance: '80.00' },
] as const) {
  test(`真实住院收费入口核对 ${scenario.plan}、撤销补偿及预交金多退少补`, async ({ page, browserApp }) => {
    const { origin, password } = browserApp
    const signIn = async (role: string) => {
      expect((await page.request.post(`${origin}/api/auth/sign-in/email`, { headers: { origin },
        data: { email: `${role}@demo.clinmesh.local`, password } })).status()).toBe(200)
    }
    const command = (path: string, input: unknown, expectedVersions?: Record<string, string>) => page.request.post(origin + path, {
      headers: { origin, 'idempotency-key': randomUUID() }, data: { input, ...(expectedVersions === undefined ? {} : { expectedVersions }) },
    })
    await signIn('registrar')
    const patient = createPatientResponseSchema.parse(await (await command('/api/his/v1/patients', {
      name: '合成医保住院患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}`,
    }, {})).json()).data.patient
    const registered = inpatientCommandResponseSchema.parse(await (await command('/api/his/v1/inpatient/admissions', {
      expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId,
      admissionRoute: 'direct', wardId: 'ward-general', depositFen: scenario.depositFen,
    })).json()).data.admission
    const path = `/api/his/v1/inpatient/admissions/${registered.id}`
    await signIn('ward-nurse')
    const received = inpatientCommandResponseSchema.parse(await (await command(`${path}/receive`, {
      encounterVersion: registered.versionId, bedId: 'bed-general-1',
    })).json()).data.admission
    await signIn('admin')
    expect((await command('/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
      expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-27T00:00:00+08:00',
    })).status()).toBe(200)
    await signIn('inpatient-doctor')
    const issued = inpatientDischargeResponseSchema.parse(await (await command(`${path}/discharge/issue`, {
      encounterVersion: received.versionId, reason: '合成治疗完成',
    })).json()).data.admission
    await signIn('ward-nurse')
    expect((await command(`${path}/discharge/depart`, { encounterVersion: issued.versionId,
      reason: '合成出区核对', departureMethod: 'home' })).status()).toBe(200)
    await page.request.post(`${origin}/api/auth/sign-out`, { headers: { origin }, data: {} })
    await page.goto(`${origin}/billing`)
    await page.getByLabel('账户邮箱').fill('cashier@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible()
    await page.getByRole('tab', { name: '住院费用', exact: true }).click()
    await page.getByRole('button', { name: '查看合成医保住院患者', exact: true }).click()
    const panel = page.getByRole('region', { name: '患者医保待遇', exact: true })
    await panel.getByRole('button', { name: '患者医保待遇（合成）', exact: true }).click()
    await panel.getByLabel('固定合成方案', { exact: true }).click()
    await page.getByRole('option', { name: scenario.option, exact: true }).click()
    const settleBenefits = async () => {
      await panel.getByRole('button', { name: '预览医保待遇', exact: true }).click()
      await panel.getByRole('button', { name: '审阅医保结算', exact: true }).click()
      const dialog = page.getByRole('alertdialog', { name: '确认医保结算', exact: true })
      await expect(dialog).toContainText('患者现金应付')
      await dialog.getByRole('button', { name: '提交医保结算', exact: true }).click()
      await expect(dialog).toHaveCount(0)
    }
    await settleBenefits()
    await panel.getByRole('button', { name: '撤销原待遇', exact: true }).click()
    const cancellation = page.getByRole('alertdialog', { name: '确认撤销医保', exact: true })
    await cancellation.getByRole('button', { name: '提交撤销', exact: true }).click()
    await expect(cancellation).toHaveCount(0)
    const insurancePath = `${origin}/api/his/v1/insurance/inpatient/${registered.id}`
    const cancelled = insuranceStateSchema.parse(await (await page.request.get(insurancePath)).json())
    expect(cancelled.activeSettlements).toEqual([])
    expect(cancelled.balance.inpatientEligibleFen).toBe(0)
    await settleBenefits()
    await page.getByRole('button', { name: '预览结算', exact: true }).click()
    await expect(page.getByTestId('settlement-net')).toContainText('150.00')
    await expect(page.getByTestId('settlement-refund')).toContainText(scenario.balance)
    const funding = page.getByRole('region', { name: '住院收退款', exact: true })
    await funding.getByRole('button', { name: '未知后查明成功', exact: true }).click()
    if (scenario.plan === 'employee-v1') {
      await funding.getByRole('button', { name: '出区补缴', exact: true }).click()
      await funding.getByLabel('现金金额（元）', { exact: true }).fill('10')
      await funding.getByLabel('银行卡金额（元）', { exact: true }).fill('30')
      await funding.getByRole('button', { name: '预览收款', exact: true }).click()
      await funding.getByRole('button', { name: '确认已审阅收款', exact: true }).click()
    } else {
      await funding.getByLabel('原入金', { exact: true }).click()
      await page.getByRole('option', { name: /预交金/ }).click()
      await funding.getByLabel('退款金额（元）', { exact: true }).fill('80')
      await funding.getByRole('button', { name: '预览退款', exact: true }).click()
      await funding.getByRole('button', { name: '确认已审阅退款', exact: true }).click()
    }
    await expect(page.getByRole('button', { name: '确认结算', exact: true })).toBeDisabled()
    await expect(panel.getByRole('button', { name: '撤销原待遇', exact: true })).toBeDisabled()
    await page.reload()
    await page.getByRole('tab', { name: '住院费用', exact: true }).click()
    await page.getByRole('button', { name: '查看合成医保住院患者', exact: true }).click()
    await funding.getByRole('button', { name: scenario.plan === 'employee-v1' ? '查询原收款' : '查询原退款', exact: true }).click()
    await expect(funding.getByTestId('inpatient-funding-balance')).toContainText('0.00')
    const funds = inpatientPaymentsSchema.parse(await (await page.request.get(`${origin}${path}/payments`)).json())
    expect(funds.pendingCount).toBe(0)
    if (scenario.plan === 'employee-v1') {
      expect(funds.payments).toMatchObject([{ outcome: 'success', version: 2, amountFen: 4000,
        tenders: [{ method: 'cash', amountFen: 1000 }, { method: 'bank-card', amountFen: 3000 }] }])
    } else {
      expect(funds.refunds).toMatchObject([{ outcome: 'success', version: 2, amountFen: 8000 }])
    }
    await page.getByRole('button', { name: '预览结算', exact: true }).click()
    await page.getByRole('button', { name: '确认结算', exact: true }).click()
    await expect(page.getByText('已结算，等待病区清床', { exact: true })).toBeVisible()
    const frozen = inpatientSettlementPreviewSchema.parse(await (await page.request.get(`${origin}${path}/discharge/preview`)).json())
    expect(frozen).toMatchObject({ chargesFen: 15000, insurance: {
      fundFen: scenario.fundFen, accountFen: scenario.accountFen, patientFen: scenario.patientFen,
    } })
    expect(frozen.transactions.reduce((sum, transaction) => sum + transaction.amountFen, 0)).toBe(scenario.patientFen)
    const finalInsurance = insuranceStateSchema.parse(await (await page.request.get(insurancePath)).json())
    expect(finalInsurance.history).toHaveLength(3)
    expect(finalInsurance.balance).toMatchObject({ inpatientEligibleFen: 15000, inpatientFundFen: scenario.fundFen, accountFen: 0 })
  })
}
