import { inpatientFullCatalogSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDrgSimulationSchema, inpatientDrgSimulationInputSchema, inpatientMaterialReservationListSchema, type InpatientDrgSimulationInput } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgPayerReviewListSchema } from '@clinmesh/contracts/inpatient-drg-payer'
import { inpatientSurgeryCatalogSchema, inpatientSurgeryResponseSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { archiveDrgBrowserPatient, createDrgBrowserPatient, expect, test } from './inpatient-drg.fixture.ts'

test('当前医嘱草稿隔离迟到评估，取消不签发，过期审阅需重算后签发', async ({ page, browserApp }) => {
  const s = await createDrgBrowserPatient(page, browserApp)
  const catalog = inpatientFullCatalogSchema.parse(await (await s.api.get('/api/his/v1/inpatient/clinical-catalog')).json())
  const medication = catalog.medications[0]!, service = catalog.services[0]!
  await page.goto(`${browserApp.origin}/inpatient`)
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await page.getByRole('tab', { name: '诊断医嘱', exact: true }).click()
  await page.getByLabel('医嘱项目', { exact: true }).click()
  await page.getByRole('option', { name: medication.display, exact: true }).click()
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
  const simulation = page.getByRole('region', { name: 'DRG 与费用推演', exact: true })
  await expect(simulation.getByRole('cell', { name: service.display, exact: true })).toBeVisible()
  release()
  await expect(simulation.getByRole('cell', { name: medication.display, exact: true })).toHaveCount(0)
  expect(inputs[0]!.services).toEqual([])
  expect(inputs.at(-1)!.medications).toEqual([])
  await expect(simulation).toContainText('医院支付参考 RA15 · ¥3,000.00')
  await simulation.getByRole('button', { name: '审阅推演并签发医嘱', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: '确认推演后的医嘱', exact: true })
  await expect(dialog).toContainText(service.display)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  expect(inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json()).orders).toHaveLength(0)
  await simulation.getByRole('button', { name: '审阅推演并签发医嘱', exact: true }).click()
  const clinical = inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json())
  expect((await s.api.post(`${s.path}/orders/issue`, { encounterVersion: clinical.encounterVersion, duration: 'temporary',
    selection: { kind: 'service', serviceId: service.id, serviceVersion: service.version, quantity: 1 } })).status()).toBe(200)
  await dialog.getByRole('button', { name: '确认签发医嘱', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('请刷新依据并重新审阅')
  expect(inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json()).orders).toHaveLength(1)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await simulation.getByRole('button', { name: '重新计算', exact: true }).click()
  await simulation.getByRole('button', { name: '审阅推演并签发医嘱', exact: true }).click()
  await dialog.getByRole('button', { name: '确认签发医嘱', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json()).orders).toHaveLength(2)
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
  await expect(page.getByRole('button', { name: '签发医嘱', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /退款|收款/ })).toHaveCount(0)
  await panel.getByLabel('模拟核定复核说明', { exact: true }).fill('合成页面支付参数复核')
  await panel.getByRole('button', { name: '审阅模拟核定', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: '确认 DRG 模拟核定', exact: true })
  await expect(dialog.getByTestId('drg-payer-preview')).toContainText('核定与归档费用差额 ¥3,000.00')
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
  expect(posts).toBe(1)
  expect(inpatientDrgPayerReviewListSchema.parse(await (await s.api.get(`${s.path}/drg/payer-reviews`)).json()).reviews).toHaveLength(1)
  expect(clinicalReads).toEqual([])
})
