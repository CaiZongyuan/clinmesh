import type { Page } from '@playwright/test'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDrgExplanationSchema } from '@clinmesh/contracts/inpatient-drg-explanation'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientDrgRecordChecksSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientFullClinicalSchema, inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { cancelAutomaticMaterialEstimate } from '../../server/tests/fixtures/inpatient-drg-agent.ts'
import { expect, loginPciBrowser, type PciBrowserApp } from './inpatient-pci.fixture.ts'

export async function prepareDrgRecordChecksBrowser(app: PciBrowserApp) {
  const f = app.fixture, stay = await f.preparePciAdmission()
  await cancelAutomaticMaterialEstimate(f, stay)
  const angiography = await f.executeAngiography(stay)
  await f.confirmMainProcedure(stay, angiography.id)
  await f.executePci(stay)
  const checks = await f.read('inpatient-doctor', `${stay.path}/drg/record-checks`, inpatientDrgRecordChecksSchema)
  expect(checks.issues.some(issue => issue.kind === 'primary-procedure-difference')).toBe(true)
  const admission = (await f.read('inpatient-doctor', stay.path, inpatientDetailSchema)).admission
  expect((await f.read('inpatient-doctor', `${stay.path}/drg/followup`, inpatientDrgFollowupSchema)).task).toBeNull()
  return { stay, admission, checks }
}

async function formalFacts(app: PciBrowserApp, path: string) {
  const f = app.fixture
  return {
    record: await f.read('inpatient-doctor', `${path}/record`, inpatientRecordSchema),
    clinical: await f.read('inpatient-doctor', `${path}/clinical`, inpatientFullClinicalSchema),
    investigations: await f.read('inpatient-doctor', `${path}/investigations`, inpatientInvestigationsSchema),
    surgery: await f.read('inpatient-doctor', `${path}/surgeries`, inpatientSurgerySchema),
    charges: await f.read('cashier', `${path}/charges`, inpatientChargesSchema),
  }
}

/** 共用真实住院页面旅程，模型只由外部受控 Provider 返回合成内容。 */
export async function runDrgRecordChecksJourney(page: Page, app: PciBrowserApp,
  prepared: Awaited<ReturnType<typeof prepareDrgRecordChecksBrowser>>, open: () => Promise<void>) {
  await loginPciBrowser(page, app, 'inpatient-doctor')
  const before = await formalFacts(app, prepared.stay.path), requestsBefore = app.modelCalls
  await open()
  await page.getByRole('button', { name: `查看${prepared.admission.patientName}`, exact: true }).click()
  await page.getByRole('tab', { name: 'DRG 与费用推演', exact: true }).click()
  const panel = page.getByRole('region', { name: '分组记录核对', exact: true })
  await expect(panel).toContainText('实际 PCI')
  await expect(panel).toContainText('首页')
  await expect(page.getByRole('button', { name: '开启本次住院跟进', exact: true })).toBeVisible()
  expect(app.modelCalls).toBe(requestsBefore)

  await panel.getByRole('button', { name: '前往病案首页原记录', exact: true }).first().click()
  await expect(page.getByRole('tab', { name: '病案', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'DRG 与费用推演', exact: true }).click()
  await panel.getByRole('button', { name: '前往手术原记录', exact: true }).first().click()
  await expect(page.getByRole('tab', { name: '手术', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'DRG 与费用推演', exact: true }).click()

  await panel.getByRole('button', { name: '展开 AI 解释', exact: true }).click()
  await expect(panel.getByText('解释已完成独立核验，来源如下。', { exact: true })).toBeVisible()
  await expect(panel.getByText('合成分组解释保留实际手术、首页与计划的原来源，主操作仍由医生核实。', { exact: true }).first()).toBeVisible()
  expect(app.modelCalls).toBe(requestsBefore + 2)
  await panel.getByRole('button', { name: '收起 AI 解释', exact: true }).click()
  await panel.getByRole('button', { name: '展开 AI 解释', exact: true }).click()
  await panel.getByRole('button', { name: '刷新分组核对', exact: true }).click()
  await expect(panel.getByText('解释已完成独立核验，来源如下。', { exact: true })).toBeVisible()
  expect(app.modelCalls).toBe(requestsBefore + 2)
  expect(await formalFacts(app, prepared.stay.path)).toEqual(before)
  const after = await app.fixture.read('inpatient-doctor', `${prepared.stay.path}/drg/record-checks`, inpatientDrgRecordChecksSchema)
  expect(after.fingerprint).toBe(prepared.checks.fingerprint)
  expect((await app.fixture.read('inpatient-doctor', `${prepared.stay.path}/drg/followup`, inpatientDrgFollowupSchema)).task).toBeNull()

  await app.fixture.confirmMainProcedure(prepared.stay, (await app.fixture.read('inpatient-doctor', `${prepared.stay.path}/surgeries`, inpatientSurgerySchema)).executions
    .find(execution => execution.requestId === prepared.stay.requestId)!.id)
  await panel.getByRole('button', { name: '刷新分组核对', exact: true }).click()
  await expect(panel.getByText('核对依据已变化，旧解释已失效；可按当前依据重新请求。', { exact: true })).toBeVisible()
  await expect(panel.getByText('合成分组解释保留实际手术、首页与计划的原来源，主操作仍由医生核实。', { exact: true })).toHaveCount(0)
  expect(app.modelCalls).toBe(requestsBefore + 2)
  expect((await app.fixture.read('inpatient-doctor', `${prepared.stay.path}/drg/record-checks/explanation`, inpatientDrgExplanationSchema)).result).toBeNull()
}

export async function runDrgRecordChecksReadFailureJourney(page: Page, app: PciBrowserApp,
  prepared: Awaited<ReturnType<typeof prepareDrgRecordChecksBrowser>>, open: () => Promise<void>) {
  await loginPciBrowser(page, app, 'inpatient-doctor')
  const requestsBefore = app.modelCalls
  await page.route(`**${prepared.stay.path}/drg/record-checks`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_READ_FAILURE', message: '合成读取失败' } }) }))
  await open()
  await page.getByRole('button', { name: `查看${prepared.admission.patientName}`, exact: true }).click()
  await page.getByRole('tab', { name: 'DRG 与费用推演', exact: true }).click()
  const panel = page.getByRole('region', { name: '分组记录核对', exact: true })
  await expect(panel).toContainText('分组核对读取失败')
  await expect(panel).not.toContainText('当前无本范围核对差异')
  await page.unroute(`**${prepared.stay.path}/drg/record-checks`)
  await panel.getByRole('button', { name: '刷新分组核对', exact: true }).click()
  await expect(panel).toContainText('实际 PCI')
  expect(app.modelCalls).toBe(requestsBefore)
}
