import { selectInpatientStage } from './inpatient-ui.ts'
import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { createPatientResponseSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientSettlementResponseSchema, inpatientSettlementPreviewSchema, inpatientPaymentsSchema, inpatientPaymentResponseSchema } from '@clinmesh/contracts/inpatient-discharge'

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
    if (name === 'cashier') await page.getByRole('button', { name: '住院', exact: true }).click()
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
    if (activeRole === 'cashier') await page.getByRole('button', { name: '住院', exact: true }).click()
    await page.getByRole('button', { name: /合成出院患者/ }).click()
  }
  await login('inpatient-doctor')
  await select()
  await selectInpatientStage(page, "出院")
  await page.getByLabel('出院处理说明', { exact: true }).fill('治疗完成')
  await page.getByRole('button', { name: '开出院医嘱', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText('待出院')
  await login('ward-nurse')
  await select()
  await page.getByLabel('出院处理说明', { exact: true }).fill('已完成护士出区核对')
  await page.getByLabel('离院方式', { exact: true }).click()
  await page.getByRole('option', { name: '医嘱离院', exact: true }).click()
  await page.getByRole('button', { name: "办理出院", exact: true }).click()
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText('已出院 · 待结算')
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
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText('已结算 · 待清床')
  expect(posts).toBe(1)
  const preview = inpatientSettlementPreviewSchema.parse(await (await page.request.get(`${browserApp.origin}${s.path}/discharge/preview`)).json())
  expect(preview.transactions.filter(transaction => transaction.kind === 'refund')).toHaveLength(1)
  expect(preview.settlement?.fingerprint).toBe((originalInput as { fingerprint: string }).fingerprint)
  await expect(page.getByText('已结算，等待病区清床', { exact: true })).toBeVisible()
  await s.login('ward-nurse')
  await s.select()
  await page.getByLabel('出院处理说明', { exact: true }).fill('床单位清洁完成')
  await page.getByRole('button', { name: '清床', exact: true }).click()
  await expect(page.getByText('未分床', { exact: false })).toBeVisible()
})

test('收费员看到的结算预览保持冻结，账目冲正后拒绝原预览，显式重新预览后结算', async ({ page, browserApp }) => {
  await setup(page, browserApp, true)
  await page.getByRole('button', { name: '预览结算', exact: true }).click()
  await expect(page.getByTestId('settlement-net')).toContainText('50.00')
  await selectInpatientStage(page, "费用")
  await page.getByLabel("退费理由", { exact: true }).fill('合成费用核对冲正')
  await page.getByRole('button', { name: "退费", exact: true }).click()
  await expect(page.getByRole('region', { name: '住院费用明细', exact: true })).toContainText('关联退费')
  await selectInpatientStage(page, "出院")
  await expect(page.getByTestId('settlement-net')).toContainText('50.00')
  await page.getByRole('button', { name: '确认结算', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('账目或资金已变化，请重新预览结算')
  await expect(page.getByTestId('settlement-net')).toContainText('50.00')
  await page.getByRole('button', { name: '重新预览结算', exact: true }).click()
  await expect(page.getByTestId('settlement-net')).toContainText('0.00')
  await page.getByRole('button', { name: '确认结算', exact: true }).click()
  await expect(page.getByText('已结算，等待病区清床', { exact: true })).toBeVisible()
})

test('真实清床后费用更正与未知退款丢回执恢复，保留首次结算和清床', async ({ page, browserApp }) => {
  const s = await setup(page, browserApp, true)
  await page.getByRole('button', { name: '预览结算', exact: true }).click()
  await page.getByRole('button', { name: '确认结算', exact: true }).click()
  await expect(page.getByText('已结算，等待病区清床', { exact: true })).toBeVisible()
  await s.login('ward-nurse'); await s.select()
  await page.getByLabel('出院处理说明', { exact: true }).fill('床单位清洁完成')
  await page.getByRole('button', { name: '清床', exact: true }).click()
  await expect(page.getByText('未分床', { exact: false })).toBeVisible()
  await s.login('cashier'); await s.select()
  const frozen = await (await page.request.get(`${browserApp.origin}${s.path}/discharge/preview`)).json()
  const section = page.getByRole('region', { name: '后续财务更正', exact: true })
  await section.getByLabel('更正金额（元）', { exact: true }).fill('20')
  await section.getByLabel('财务更正原因', { exact: true }).fill('合成清床后床日费核对')
  await section.getByRole('button', { name: '审阅财务更正', exact: true }).click()
  await page.getByRole('region', { name: "确认后续财务更正", exact: true }).getByRole('button', { name: '提交财务更正', exact: true }).click()
  await expect(section.getByTestId('financial-current')).toContainText('30.00')
  await section.getByLabel('本次收退金额（元）', { exact: true }).fill('20')
  await section.getByLabel('合成渠道结果', { exact: true }).click()
  await page.getByRole('option', { name: '未知，查询成功', exact: true }).click()
  await section.getByRole('button', { name: '预览后续退款', exact: true }).click()
  let posts = 0, originalKey = ''
  await page.route(`**${s.path}/financial-adjustments/refunds/confirm`, async route => {
    posts += 1; originalKey = route.request().headers()['idempotency-key']!
    expect((await route.fetch()).status()).toBe(200)
    await route.abort('failed')
  })
  await page.getByRole('region', { name: "确认后续退款", exact: true }).getByRole('button', { name: '确认本次收退', exact: true }).click()
  await expect(page.getByRole('region', { name: '确认后续退款', exact: true }).getByRole('alert')).toContainText('无法连接科灵脉智服务')
  await page.reload(); await s.select()
  const receipt = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
  expect(new URL((await receipt).url()).searchParams.get('idempotencyKey')).toBe(originalKey)
  await section.getByRole('button', { name: '查询原后续退款结果', exact: true }).click()
  await expect(section.getByTestId('financial-current')).toContainText("当前已交 ¥30.00")
  expect(posts).toBe(1)
  const after = await (await page.request.get(`${browserApp.origin}${s.path}/discharge/preview`)).json()
  expect(after).toEqual(frozen)
  await expect(page.getByText('已结算并清床', { exact: true })).toBeVisible()
})

test('真实收费员组合预交金丢回执刷新恢复原意图，渠道未知再查询原收款只入账一次', async ({ page, browserApp }) => {
  const s = await setup(page,browserApp)
  await page.setViewportSize({width:390,height:900})
  await page.getByRole('button', { name: '预交金', exact: true }).click()
  await page.getByLabel('现金金额（元）',{exact:true}).fill('40')
  await page.getByLabel('移动支付金额（元）',{exact:true}).fill('60')
  await page.getByRole('button',{name:'未知后查明成功',exact:true}).click()
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: "预览收款", exact: true }).click()
  await expect(page.getByText(/已固定收款预览/)).toContainText('100.00')
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  await page.setViewportSize({width:480,height:900})
  await page.evaluate(()=>{document.documentElement.style.zoom='1.25'})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  let posts = 0
  await page.route(`**${s.path}/payments/confirm`,async route=> {
    posts+=1
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    expect(inpatientPaymentResponseSchema.parse(await response.json()).data.outcome).toBe('ambiguous')
    await route.abort('failed')
  })
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: "确认收款", exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('无法连接科灵脉智服务')
  await page.reload()
  await s.select()
  await page.getByRole('button',{name:'恢复原住院操作',exact:true}).click()
  await expect(page.getByRole('button',{name:'查询原收款',exact:true})).toBeVisible()
  expect(posts).toBe(1)
  await page.getByRole('button',{name:'查询原收款',exact:true}).click()
  await expect(page.getByRole('button',{name:'查询原收款',exact:true})).toHaveCount(0)
  const statement = inpatientPaymentsSchema.parse(await (await page.request.get(`${browserApp.origin}${s.path}/payments`)).json())
  expect(statement.depositFen).toBe(110000)
  expect(statement.payments).toHaveLength(1)
  expect(statement.payments[0]).toMatchObject({outcome:'success',version:2,tenders:[{method:'cash',amountFen:4000},{method:'mobile',amountFen:6000}]})
})

test('真实收费员退款未知刷新后查询原退款，护士不能提前清床，确定资金后重新封账再清床', async ({ page, browserApp }) => {
  const s = await setup(page,browserApp)
  await page.getByRole('button',{name:'预览结算',exact:true}).click()
  await page.getByRole('button',{name:'未知后查明成功',exact:true}).click()
  await page.getByLabel('原入金',{exact:true}).click()
  await page.getByRole('option',{name:/预交金/}).click()
  await page.getByLabel('退款金额（元）',{exact:true}).fill('1000')
  await page.getByRole('button',{name:'预览退款',exact:true}).click()
  await expect(page.getByText(/已固定退款预览/)).toContainText('1,000.00')
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: "确认退款", exact: true }).click()
  await expect(page.getByRole('button',{name:'查询原退款',exact:true})).toBeEnabled()
  await expect(page.getByRole('button',{name:'确认结算',exact:true})).toHaveCount(0)
  await expect(page.getByRole('region', { name: '当前操作', exact: true })).toContainText('结果未知，先查询原支付结果')
  await page.reload()
  await s.select()
  await expect(page.getByRole('button',{name:'查询原退款',exact:true})).toBeVisible()
  await s.login('ward-nurse')
  await s.select()
  await selectInpatientStage(page, '出院')
  await page.getByLabel('出院处理说明',{exact:true}).fill('合成未知资金不得清床')
  await expect(page.getByRole('button',{name:'清床',exact:true})).toBeDisabled()
  await s.login('cashier')
  await s.select()
  await page.getByRole('button',{name:'查询原退款',exact:true}).click()
  await expect(page.getByRole('button',{name:'查询原退款',exact:true})).toHaveCount(0)
  await expect(page.getByTestId('inpatient-funding-balance')).toContainText('0.00')
  await page.getByRole('button',{name:'预览结算',exact:true}).click()
  await page.getByRole('button',{name:'确认结算',exact:true}).click()
  await expect(page.getByText('已结算，等待病区清床',{exact:true})).toBeVisible()
  const statement = inpatientPaymentsSchema.parse(await (await page.request.get(`${browserApp.origin}${s.path}/payments`)).json())
  expect(statement.refunds).toHaveLength(1)
  expect(statement.refunds[0]).toMatchObject({outcome:'success',version:2,amountFen:100000})
  const frozen = inpatientSettlementPreviewSchema.parse(await (await page.request.get(`${browserApp.origin}${s.path}/discharge/preview`)).json())
  expect(frozen.transactions.filter(item=>item.kind==='refund')).toMatchObject([{id:statement.refunds[0]!.refundId,amountFen:-100000}])
  await s.login('ward-nurse')
  await s.select()
  await selectInpatientStage(page, '出院')
  await page.getByLabel('出院处理说明',{exact:true}).fill('合成资金查明后完成清床')
  await page.getByRole('button',{name:'清床',exact:true}).click()
  await expect(page.getByText('未分床',{exact:false})).toBeVisible()
})
