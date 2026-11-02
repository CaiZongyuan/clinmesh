import { selectInpatientStage } from './inpatient-ui.ts'
import { inpatientFullCatalogSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { createDrgBrowserPatient, expect, test, writeDrgBrowserRules } from './inpatient-drg.fixture.ts'

async function openReviewedService(page: Page, browserApp: Parameters<typeof createDrgBrowserPatient>[1]) {
  const s = await createDrgBrowserPatient(page, browserApp)
  const catalog = inpatientFullCatalogSchema.parse(await (await s.api.get('/api/his/v1/inpatient/clinical-catalog')).json())
  const service = catalog.services[0]!
  await page.goto(`${browserApp.origin}/inpatient`)
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await page.getByLabel('医嘱项目', { exact: true }).click()
  await page.getByRole('option', { name: service.display, exact: true }).click()
  await page.getByRole('button', { name: "预计当前医嘱", exact: true }).click()
  const panel = page.getByRole('region', { name: "DRG 预分组", exact: true })
  const reviewButton = panel.getByRole('button', { name: "审阅预计并开立医嘱", exact: true })
  await reviewButton.click()
  const dialog = page.getByRole('region', { name: "确认预计后的医嘱", exact: true })
  await expect(dialog.getByRole('button', { name: "确认开立医嘱", exact: true })).toBeEnabled()
  return { ...s, service, panel, dialog, reviewButton }
}

test('价目变化后已打开的医嘱确认被锁定，必须重新计算审阅', async ({ page, browserApp }) => {
  const s = await openReviewedService(page, browserApp)
  // No runtime price-maintenance Command exists; change only this test's temporary catalog input.
  browserApp.runtime.database.driver.prepare("UPDATE hospital_service_catalog SET config_json=json_set(config_json,'$.chargeDefinition.priceFen',4321) WHERE service_id=?").run(s.service.id)
  const updated = inpatientFullCatalogSchema.parse(await (await s.api.get('/api/his/v1/inpatient/clinical-catalog')).json())
  expect(updated.services.find(item => item.id === s.service.id)).toMatchObject({ version: s.service.version, priceFen: 4321 })
  await expect(s.dialog.getByRole('alert')).toContainText('评估已过期')
  await expect(s.dialog.getByRole('button', { name: "确认开立医嘱", exact: true })).toBeDisabled()
  expect(inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json()).orders).toEqual([])
  await s.dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(s.panel.getByTestId('drg-charges')).toContainText("费用预计 ¥43.21")
  await expect(s.reviewButton).toBeDisabled()
  await s.panel.getByRole('button', { name: '重新计算', exact: true }).click()
  await s.reviewButton.click()
  await s.dialog.getByRole('button', { name: "确认开立医嘱", exact: true }).click()
  await expect(s.dialog).toBeHidden()
  expect(inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json()).orders).toHaveLength(1)
})

test('服务重启加载新规则后旧确认保持锁定，重新审阅才能签发', async ({ page, browserApp }) => {
  const s = await openReviewedService(page, browserApp)
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-drg-browser-next-'))
  try {
    await writeDrgBrowserRules(directory, 'synthetic-browser-3')
    await browserApp.restart({ drgRulesDirectory: directory })
    await expect(s.dialog.getByRole('alert')).toContainText('评估已过期')
    await expect(s.dialog.getByRole('button', { name: "确认开立医嘱", exact: true })).toBeDisabled()
    await s.dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(s.panel).toContainText("规则修订：synthetic-browser-3")
    await expect(s.reviewButton).toBeDisabled()
    expect(inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json()).orders).toEqual([])
    await s.panel.getByRole('button', { name: '重新计算', exact: true }).click()
    await s.reviewButton.click()
    await s.dialog.getByRole('button', { name: "确认开立医嘱", exact: true }).click()
    await expect(s.dialog).toBeHidden()
    expect(inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json()).orders).toHaveLength(1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('切换患者后上一患者的迟到重新计算不能覆盖当前患者结果', async ({ page, browserApp }) => {
  const first = await createDrgBrowserPatient(page, browserApp, '合成迟到患者甲')
  const second = await createDrgBrowserPatient(page, browserApp, '合成当前患者乙', 'bed-general-2')
  const catalog = inpatientFullCatalogSchema.parse(await (await first.api.get('/api/his/v1/inpatient/clinical-catalog')).json())
  const service = catalog.services[0]!
  const clinical = inpatientFullClinicalSchema.parse(await (await first.api.get(`${first.path}/clinical`)).json())
  expect((await first.api.post(`${first.path}/orders/issue`, { encounterVersion: clinical.encounterVersion, duration: 'temporary',
    selection: { kind: 'service', serviceId: service.id, serviceVersion: service.version, quantity: 1 } })).status()).toBe(200)
  await page.goto(`${browserApp.origin}/inpatient`)
  await page.getByRole('button', { name: `查看${first.name}`, exact: true }).click()
  await selectInpatientStage(page, "DRG 预分组")
  const panel = page.getByRole('region', { name: "DRG 预分组", exact: true })
  await expect(panel.getByRole('cell', { name: service.display, exact: true })).toBeVisible()

  let release!: () => void
  let finish!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const delivered = new Promise<void>(resolve => { finish = resolve })
  let fetched = false
  await page.route(`**${first.path}/drg/simulation`, async route => {
    const response = await route.fetch()
    expect(inpatientDrgSimulationSchema.parse(await response.json()).admissionId).toBe(first.admissionId)
    fetched = true
    await held
    try { await route.fulfill({ response }) } catch { /* Patient switch aborts the obsolete request. */ }
    finally { finish() }
  })
  try {
    await panel.getByRole('button', { name: '重新计算', exact: true }).click()
    await expect.poll(() => fetched).toBe(true)
    await page.getByRole('button', { name: `查看${second.name}`, exact: true }).click()
    await selectInpatientStage(page, "DRG 预分组")
    await expect(panel.getByTestId('drg-charges')).toHaveText("已发生收费 ¥0.00 · 含计划、预留及待提交项目的费用预计 ¥0.00")
    release()
    await delivered
    await expect(panel.getByRole('cell', { name: service.display, exact: true })).toHaveCount(0)
    await expect(panel.getByTestId('drg-charges')).toHaveText("已发生收费 ¥0.00 · 含计划、预留及待提交项目的费用预计 ¥0.00")
    const current = inpatientDrgSimulationSchema.parse(await (await second.api.post(`${second.path}/drg/simulation`, {})).json())
    expect(current).toMatchObject({ admissionId: second.admissionId, formal: { chargesFen: 0 }, committed: { items: [] } })
    expect(inpatientFullClinicalSchema.parse(await (await second.api.get(`${second.path}/clinical`)).json()).orders).toEqual([])
  } finally { release() }
})
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
