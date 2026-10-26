import { inpatientFullCatalogSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDrgSimulationSchema, inpatientDrgSimulationInputSchema, inpatientMaterialReservationListSchema, type InpatientDrgSimulationInput } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgPayerReviewListSchema } from '@clinmesh/contracts/inpatient-drg-payer'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientSurgeryCatalogSchema, inpatientSurgeryResponseSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { archiveDrgBrowserPatient, createDrgBrowserPatient, expect, test } from './inpatient-drg.fixture.ts'
import { runDrgArchiveJourney } from './inpatient-drg-archive.journey.ts'

test('归档后只展示冻结结果，隐藏页签中的旧推演不再显示', async ({ page, request, browserApp }) => {
  await runDrgArchiveJourney({ page, request, browserApp, open: async () => { await page.goto(`${browserApp.origin}/inpatient`) } })
})

test('多手术计划仅按医生选择推演主操作，正式事实与首页保持原样', async ({ page, browserApp }) => {
  const s = await createDrgBrowserPatient(page, browserApp, '合成计划主操作患者')
  const catalog = inpatientSurgeryCatalogSchema.parse(await (await s.api.get('/api/his/v1/inpatient/surgery-catalog')).json())
  const procedure = catalog.procedures.find(item => item.coding.code === '00.6600')!
  const requestPlan = async (reason: string) => {
    const clinical = inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json())
    const result = inpatientSurgeryResponseSchema.parse(await (await s.api.post(`${s.path}/surgeries/request`, {
      encounterVersion: clinical.encounterVersion, procedureId: procedure.id, catalogVersion: procedure.version,
      plannedFor: '2026-08-24T15:00:00+08:00', reason,
    })).json()).data
    return result.requests.find(item => item.reason === reason)!
  }
  await requestPlan('合成第一个操作计划')
  await page.goto(`${browserApp.origin}/inpatient`)
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await page.getByRole('tab', { name: 'DRG 与费用推演', exact: true }).click()
  const panel = page.getByRole('region', { name: 'DRG 与费用推演', exact: true })
  const projected = panel.getByRole('region', { name: '若计划手术实施', exact: true })
  await expect(projected).toContainText('已分组 · RA25')
  await expect(panel.getByLabel('计划主操作（仅推演）', { exact: true })).toHaveCount(0)
  const second = await requestPlan('合成第二个操作计划')
  await expect(projected).toContainText('分组依据不完整')
  await expect(panel.getByRole('region', { name: '正式事实分组', exact: true })).toContainText('已分组 · RA15')
  await panel.getByLabel('计划主操作（仅推演）', { exact: true }).click()
  const selectedResponse = page.waitForResponse(response => response.url().endsWith(`${s.path}/drg/simulation`)
    && response.request().postDataJSON().input.primarySurgeryRequestId === second.id)
  await page.getByRole('option', { name: `${procedure.coding.code} · ${procedure.coding.display} · ${second.reason}`, exact: true }).click()
  const result = inpatientDrgSimulationSchema.parse(await (await selectedResponse).json())
  expect(result.grouping.formal).toMatchObject({ status: 'grouped', drgCode: 'RA15' })
  expect(result.grouping.projected).toMatchObject({ status: 'grouped', drgCode: 'RA25' })
  await expect(projected).toContainText('已分组 · RA25')
  const surgery = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json())
  expect(surgery.executions).toEqual([])
  expect(surgery.requests).toHaveLength(2)
  const record = inpatientRecordSchema.parse(await (await s.api.get(`${s.path}/record`)).json())
  expect(record.snapshot.clinical).toMatchObject({ mainProcedureExecutionId: null, operations: [] })
})

test('外部医嘱变化后页面自动标记评估过期，并锁定已经打开的确认', async ({ page, browserApp }) => {
  const s = await createDrgBrowserPatient(page, browserApp, '合成主动过期患者')
  const catalog = inpatientFullCatalogSchema.parse(await (await s.api.get('/api/his/v1/inpatient/clinical-catalog')).json())
  const service = catalog.services[0]!
  await page.goto(`${browserApp.origin}/inpatient`)
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await page.getByLabel('医嘱项目', { exact: true }).click()
  await page.getByRole('option', { name: service.display, exact: true }).click()
  await page.getByRole('button', { name: '推演当前医嘱', exact: true }).click()
  const panel = page.getByRole('region', { name: 'DRG 与费用推演', exact: true })
  const reviewButton = panel.getByRole('button', { name: '审阅推演并签发医嘱', exact: true })
  await expect(reviewButton).toBeEnabled()
  const externalOrder = async () => {
    const clinical = inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json())
    expect((await s.api.post(`${s.path}/orders/issue`, { encounterVersion: clinical.encounterVersion, duration: 'temporary',
      selection: { kind: 'service', serviceId: service.id, serviceVersion: service.version, quantity: 1 } })).status()).toBe(200)
  }
  await externalOrder()
  await expect(panel.getByRole('alert')).toContainText('评估已过期')
  await expect(reviewButton).toBeDisabled()
  // 自动轮询取得新结果后仍须人工重新计算，不能静默解锁旧审阅。
  const cycle = page.waitForResponse(response => response.url().endsWith(`${s.path}/drg/simulation`))
  await cycle
  await expect(reviewButton).toBeDisabled()
  await panel.getByRole('button', { name: '重新计算', exact: true }).click()
  await reviewButton.click()
  const dialog = page.getByRole('alertdialog', { name: '确认推演后的医嘱', exact: true })
  await externalOrder()
  await expect(dialog.getByRole('alert')).toContainText('评估已过期')
  await expect(dialog.getByRole('button', { name: '确认签发医嘱', exact: true })).toBeDisabled()
  expect(inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json()).orders).toHaveLength(2)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await panel.getByRole('button', { name: '重新计算', exact: true }).click()
  await reviewButton.click()
  await dialog.getByRole('button', { name: '确认签发医嘱', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json()).orders).toHaveLength(3)
})

test('当前医嘱草稿隔离迟到评估，取消不签发，重新审阅后签发当前草稿', async ({ page, browserApp }) => {
  const s = await createDrgBrowserPatient(page, browserApp)
  const catalog = inpatientFullCatalogSchema.parse(await (await s.api.get('/api/his/v1/inpatient/clinical-catalog')).json())
  const medication = catalog.medications[0]!, service = catalog.services[0]!
  await page.goto(`${browserApp.origin}/inpatient`)
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await page.getByRole('tab', { name: '诊断医嘱', exact: true }).click()
  await page.getByLabel('医嘱项目', { exact: true }).click()
  await page.getByRole('option', { name: medication.display, exact: true }).click()
  await page.getByLabel('每次剂量', { exact: true }).fill(`1${medication.unit}`)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const inputs: InpatientDrgSimulationInput[] = []
  await page.route(`**${s.path}/drg/simulation`, async route => {
    const input = inpatientDrgSimulationInputSchema.parse(route.request().postDataJSON().input)
    inputs.push(input)
    const response = await route.fetch()
    inpatientDrgSimulationSchema.parse(await response.json())
    if (input.medications.length > 0) await held
    await route.fulfill({ response }).catch(() => {})
  })
  await page.getByRole('button', { name: '推演当前医嘱', exact: true }).click()
  await expect.poll(() => inputs.length).toBe(1)
  await page.getByLabel('医嘱项目', { exact: true }).click()
  await page.getByRole('option', { name: service.display, exact: true }).click()
  await expect(page.getByRole('listbox')).toBeHidden()
  const simulation = page.getByRole('region', { name: 'DRG 与费用推演', exact: true })
  await expect(simulation.getByRole('cell', { name: service.display, exact: true })).toBeVisible()
  release()
  await expect(simulation.getByRole('cell', { name: medication.display, exact: true })).toHaveCount(0)
  expect(inputs[0]!.services).toEqual([])
  expect(inputs[0]!.medications[0]).toMatchObject({ doseText: `1${medication.unit}`, doseQuantity: 1 })
  expect(inputs.at(-1)!.medications).toEqual([])
  await expect(simulation).toContainText('医院支付参考 RA15 · ¥3,000.00')
  await simulation.getByRole('button', { name: '审阅推演并签发医嘱', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: '确认推演后的医嘱', exact: true })
  await expect(dialog).toContainText(service.display)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  expect(inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json()).orders).toHaveLength(0)
  await simulation.getByRole('button', { name: '审阅推演并签发医嘱', exact: true }).click()
  await dialog.getByRole('button', { name: '确认签发医嘱', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json()).orders).toHaveLength(1)
})

test('实际手术显式引用治疗预留并替换，正式费用与预留不重复计入', async ({ page, browserApp }) => {
  const s = await createDrgBrowserPatient(page, browserApp, '合成预留替换患者')
  const catalog = inpatientSurgeryCatalogSchema.parse(await (await s.api.get('/api/his/v1/inpatient/surgery-catalog')).json())
  const procedure = catalog.procedures[0]!, material = catalog.materials.find(item => item.id === 'material-suture') ?? catalog.materials.find(item => item.display === '合成演示缝合材料')!
  const clinical = inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json())
  const requested = inpatientSurgeryResponseSchema.parse(await (await s.api.post(`${s.path}/surgeries/request`, { encounterVersion: clinical.encounterVersion,
    procedureId: procedure.id, catalogVersion: procedure.version, plannedFor: '2026-08-24T15:00:00+08:00', reason: '合成预留替换验证' })).json()).data.requests[0]!
  expect((await s.api.post(`${s.path}/drg/reservations`, { encounterVersion: clinical.encounterVersion, materialId: material.id, catalogVersion: material.version,
    quantity: 2, requestId: requested.id, reason: '合成明确替换预留' })).status()).toBe(200)
  expect((await s.api.post(`${s.path}/surgeries/confirm-consent`, { requestId: requested.id, expectedRequestVersion: requested.version, note: '合成知情同意已签署' })).status()).toBe(200)
  await s.api.login('ward-nurse')
  const consent = inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json()).requests[0]!
  expect((await s.api.post(`${s.path}/surgeries/check-preop`, { requestId: requested.id, expectedRequestVersion: consent.version, note: '合成术前核对完成' })).status()).toBe(200)
  await s.api.login('inpatient-doctor')
  await page.goto(`${browserApp.origin}/inpatient`)
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await page.getByRole('tab', { name: '手术', exact: true }).click()
  await page.getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: `${procedure.coding.code} · ${procedure.coding.display}`, exact: true }).click()
  await page.getByLabel('手术耗材', { exact: true }).click()
  await page.getByRole('option', { name: material.display, exact: true }).click()
  await page.getByLabel('替换治疗预留', { exact: true }).click()
  await page.getByRole('option', { name: `${material.display} × 2 · 合成明确替换预留`, exact: true }).click()
  await expect(page.getByLabel(`${material.display}实际用量`, { exact: true })).toHaveValue('2')
  await expect(page.getByLabel(`${material.display}实际用量`, { exact: true })).toBeDisabled()
  await page.getByLabel('手术记录说明', { exact: true }).fill('合成实际用量替换同一预留')
  await page.getByRole('button', { name: '记录实际手术', exact: true }).click()
  await expect(page.getByText(`实际实施：${procedure.coding.code} · ${procedure.coding.display}`, { exact: true })).toBeVisible()
  expect(inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json()).reservations[0]!.status).toBe('replaced')
  const simulation = inpatientDrgSimulationSchema.parse(await (await s.api.post(`${s.path}/drg/simulation`, {})).json())
  expect(simulation.reserved.items).toEqual([])
  expect(simulation.formal.items.filter(item => item.kind === 'material')).toHaveLength(1)
})

test('医保办独立复核入口展示服务端预览，取消不写入，响应丢失刷新后仅恢复原回执', async ({ page, browserApp }) => {
  const s = await createDrgBrowserPatient(page, browserApp)
  await archiveDrgBrowserPatient(s)
  await s.api.login('medical-insurance')
  const clinicalReads: string[] = []
  page.on('request', request => { if (/\/clinical(?:-catalog)?$|\/payments$|\/refunds$/.test(new URL(request.url()).pathname)) clinicalReads.push(request.url()) })
  await page.goto(`${browserApp.origin}/inpatient`)
  const select = () => page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await select()
  const panel = page.getByRole('region', { name: '医保办 DRG 复核', exact: true })
  await expect(panel.getByTestId('drg-payer-preview')).toContainText('模拟核定支付 ¥3,000.00')
  await expect(panel.getByTestId('drg-payer-preview')).toContainText('归档支付预估 ¥3,000.00')
  await expect(panel.getByTestId('drg-payer-preview')).toContainText('核定减归档预估 ¥0.00')
  const grouping = panel.getByRole('region', { name: '归档冻结分组', exact: true })
  await grouping.getByText('查看分组依据', { exact: true }).click()
  await expect(grouping).toContainText('命中编码 I10.x09')
  const sources = panel.getByRole('region', { name: '冻结病例与编码来源', exact: true })
  await expect(sources).toContainText('主诊断 I10.x09')
  await sources.getByText('查看冻结分组输入与来源', { exact: true }).click()
  await expect(sources).toContainText('nhc-icd10-clinical@2022.r4')
  await expect(sources).toContainText('cn-health:nhc-icd10-clinical@2022.r4:diagnosis:12457')
  await expect(page.getByRole('button', { name: '签发医嘱', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /退款|收款/ })).toHaveCount(0)
  await panel.getByLabel('模拟核定复核说明', { exact: true }).fill('合成页面支付参数复核')
  await panel.getByRole('button', { name: '审阅模拟核定', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: '确认 DRG 模拟核定', exact: true })
  await expect(dialog.getByTestId('drg-payer-preview')).toContainText('核定与归档费用差额 ¥3,000.00')
  await expect(dialog.getByTestId('drg-payer-preview')).toContainText('核定减归档预估 ¥0.00')
  await expect(dialog.getByRole('region', { name: '冻结病例与编码来源', exact: true })).toContainText('主诊断 I10.x09')
  await expect(dialog).toContainText('合成参数版本')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  expect(inpatientDrgPayerReviewListSchema.parse(await (await s.api.get(`${s.path}/drg/payer-reviews`)).json()).reviews).toHaveLength(0)
  let posts = 0, originalKey: string | undefined
  await page.route(`**${s.path}/drg/payer-review`, async route => {
    posts++
    originalKey = route.request().headers()['idempotency-key']
    expect(route.request().postDataJSON().input.expectedFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect((await route.fetch()).status()).toBe(200)
    await route.abort('failed')
  })
  await panel.getByRole('button', { name: '审阅模拟核定', exact: true }).click()
  await dialog.getByRole('button', { name: '提交模拟核定', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('无法连接科灵脉智服务')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('region', { name: '待确认操作', exact: true })).toBeVisible()
  await page.reload()
  await select()
  const receipt = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
  expect(new URL((await receipt).url()).searchParams.get('idempotencyKey')).toBe(originalKey)
  await expect(panel.getByRole('cell', { name: /合成页面支付参数复核/ })).toBeVisible()
  await expect(panel.getByRole('columnheader', { name: '核定减归档预估', exact: true })).toBeVisible()
  await expect(panel.getByRole('columnheader', { name: '归档支付预估', exact: true })).toBeVisible()
  expect(posts).toBe(1)
  expect(inpatientDrgPayerReviewListSchema.parse(await (await s.api.get(`${s.path}/drg/payer-reviews`)).json()).reviews).toHaveLength(1)
  expect(clinicalReads).toEqual([])
})
