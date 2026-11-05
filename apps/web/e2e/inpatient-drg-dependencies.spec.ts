import type { Locator } from '@playwright/test'
import { openInpatientDrgTools, selectInpatientStage } from './inpatient-ui.ts'
import { inpatientFullCatalogSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDrgSimulationSchema, type InpatientDrgSimulation } from '@clinmesh/contracts/inpatient-drg-simulation'
import { createDrgBrowserPatient, expect, test, writeDrgBrowserRules } from './inpatient-drg.fixture.ts'

const money = (fen: number) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(fen / 100)

async function expectComparisonAmounts(panel: Locator, result: InpatientDrgSimulation) {
  const pendingFen = result.committed.items.filter(item => item.kind !== 'surgery').reduce((sum, item) => sum + (item.estimatedFen ?? 0), 0)
  await expect(panel.getByRole('region', { name: '费用与支付参考', exact: true })).toContainText('已发生收费 ' + money(result.formal.chargesFen))
  await expect(panel.getByRole('region', { name: '费用与支付参考', exact: true })).toContainText('已开未记费医嘱 ' + money(pendingFen))
}

async function openReviewedService(page: Page, browserApp: Parameters<typeof createDrgBrowserPatient>[1]) {
  const s = await createDrgBrowserPatient(page, browserApp)
  const catalog = inpatientFullCatalogSchema.parse(await (await s.api.get('/api/his/v1/inpatient/clinical-catalog')).json())
  const service = catalog.services[0]!
  await page.goto(`${browserApp.origin}/inpatient`)
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await page.getByLabel('医嘱项目', { exact: true }).fill(service.display)
  await page.getByRole('region', { name: '医嘱项目候选', exact: true }).getByRole('button', { name: new RegExp(service.display) }).click()
  await page.getByRole('button', { name: '费用预计', exact: true }).click()
  const estimate = page.getByRole('region', { name: '费用预计', exact: true })
  const issueButton = page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '开立医嘱', exact: true })
  await expect(issueButton).toBeEnabled()
  return { ...s, service, estimate, issueButton, draft: { medications: [], services: [{ serviceId: service.id, serviceVersion: service.version, quantity: 1 }] } }
}

test('价目变化后已打开的医嘱确认被锁定，必须重新计算审阅', async ({ page, browserApp }) => {
  const s = await openReviewedService(page, browserApp)
  // No runtime price-maintenance Command exists; change only this test's temporary catalog input.
  browserApp.runtime.database.driver.prepare("UPDATE hospital_service_catalog SET config_json=json_set(config_json,'$.chargeDefinition.priceFen',4321) WHERE service_id=?").run(s.service.id)
  const updated = inpatientFullCatalogSchema.parse(await (await s.api.get('/api/his/v1/inpatient/clinical-catalog')).json())
  expect(updated.services.find(item => item.id === s.service.id)).toMatchObject({ version: s.service.version, priceFen: 4321 })
  await expect(s.estimate.getByRole('alert')).toContainText('评估已过期')
  await expect(s.issueButton).toBeDisabled()
  expect(inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json()).orders).toEqual([])
  const changed = inpatientDrgSimulationSchema.parse(await (await s.api.post(s.path + '/drg/simulation', s.draft)).json())
  expect(changed.coverage.estimatedTotalFen).toBe(4321)
  await expect(s.estimate).toContainText(money(changed.coverage.estimatedTotalFen))
  await expect(s.issueButton).toBeDisabled()
  await s.estimate.getByRole('button', { name: '重新预计', exact: true }).click()
  await expect(s.issueButton).toBeEnabled()
  await s.issueButton.click()
  await expect.poll(async () => inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json()).orders.length).toBe(1)
})

test('服务重启加载新规则后旧确认保持锁定，重新审阅才能签发', async ({ page, browserApp }) => {
  const s = await openReviewedService(page, browserApp)
  const previous = inpatientDrgSimulationSchema.parse(await (await s.api.post(s.path + '/drg/simulation', s.draft)).json())
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-drg-browser-next-'))
  try {
    await writeDrgBrowserRules(directory, 'synthetic-browser-3')
    await browserApp.restart({ drgRulesDirectory: directory })
    await expect(s.estimate.getByRole('alert')).toContainText('评估已过期')
    await expect(s.issueButton).toBeDisabled()
    const changed = inpatientDrgSimulationSchema.parse(await (await s.api.post(s.path + '/drg/simulation', s.draft)).json())
    expect(changed.rulesVersion).toBe('synthetic-browser-3')
    expect(changed.fingerprint).not.toBe(previous.fingerprint)
    await expect(s.estimate).toContainText(money(changed.coverage.estimatedTotalFen))
    await expect(s.issueButton).toBeDisabled()
    expect(inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json()).orders).toEqual([])
    await s.estimate.getByRole('button', { name: '重新预计', exact: true }).click()
    await expect(s.issueButton).toBeEnabled()
    await s.issueButton.click()
    await expect.poll(async () => inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json()).orders.length).toBe(1)
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
  await openInpatientDrgTools(page)
  const panel = page.getByRole('region', { name: "DRG 预分组", exact: true })
  await expect(panel.getByRole('region', { name: '费用与支付参考', exact: true })).toContainText('已开未记费医嘱 ' + money(service.priceFen))

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
    await page.getByRole('button', { name: '重新计算', exact: true }).click()
    await expect.poll(() => fetched).toBe(true)
    await page.getByRole('button', { name: `查看${second.name}`, exact: true }).click()
    await selectInpatientStage(page, "DRG 预分组")
    await openInpatientDrgTools(page)
    const expected = inpatientDrgSimulationSchema.parse(await (await second.api.post(second.path + '/drg/simulation', {})).json())
    expect(expected).toMatchObject({ admissionId: second.admissionId, formal: { chargesFen: 0 }, coverage: { estimatedTotalFen: 0 } })
    await expectComparisonAmounts(panel, expected)
    release()
    await delivered
    await expect(panel.getByRole('region', { name: '费用与支付参考', exact: true })).not.toContainText('已开未记费医嘱 ' + money(service.priceFen))
    await expectComparisonAmounts(panel, expected)
    const current = inpatientDrgSimulationSchema.parse(await (await second.api.post(`${second.path}/drg/simulation`, {})).json())
    expect(current).toMatchObject({ admissionId: second.admissionId, formal: { chargesFen: 0 }, committed: { items: [] } })
    expect(current.fingerprint).toBe(expected.fingerprint)
    expect(inpatientFullClinicalSchema.parse(await (await second.api.get(`${second.path}/clinical`)).json()).orders).toEqual([])
  } finally { release() }
})
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
