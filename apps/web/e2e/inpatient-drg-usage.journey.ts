import type { Page } from '@playwright/test'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientPciSelectionResponseSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { modelUsageAttemptSchema, modelUsageOverviewSchema } from '@clinmesh/contracts/model-usage'
import { cancelAutomaticMaterialEstimate, pciAgentParameters } from '../../server/tests/fixtures/inpatient-drg-agent.ts'
import { expect, loginPciBrowser, type PciBrowserApp } from './inpatient-pci.fixture.ts'

export async function runDrgUsageJourney(page: Page, app: PciBrowserApp, open: (admissionId: string, name: string) => Promise<void>) {
  const stay = await app.fixture.preparePciAdmission()
  await cancelAutomaticMaterialEstimate(app.fixture, stay)
  const detail = await app.fixture.read('inpatient-doctor', stay.path, inpatientDetailSchema)
  const confirmed = await app.fixture.request('inpatient-doctor', `${stay.path}/pci-selection/confirm`, {
    expectedVersion: 0, parameters: { ...pciAgentParameters, requestId: stay.requestId },
  })
  expect(confirmed.status).toBe(200)
  inpatientPciSelectionResponseSchema.parse(await confirmed.json())
  await loginPciBrowser(page, app, 'inpatient-doctor')
  const reads: URL[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname === '/api/model-usage/overview' || url.pathname === '/api/model-usage/requests') reads.push(url)
  })
  await open(stay.admissionId, detail.admission.patientName)
  const followup = page.getByRole('region', { name: "住院自动跟进", exact: true })
  await followup.getByRole('button', { name: '开启本次住院跟进', exact: true }).click()
  const usage = page.getByRole('region', { name: "本次住院AI用量", exact: true })
  await expect(usage.getByLabel("实际AI请求数", { exact: true })).toHaveText('2')
  await expect(usage.getByLabel('已知输入 Token', { exact: true })).toHaveText('200')
  await expect(usage.getByLabel('已知输出 Token', { exact: true })).toHaveText('40')
  await expect(usage.getByLabel('已知总 Token', { exact: true })).toHaveText('240')
  await expect(usage.getByLabel('估算人民币费用', { exact: true })).toHaveText('未知')
  await expect(usage).toContainText("尚无术中AI调用")
  await expect(usage).toContainText("尚无术后AI调用")
  await usage.getByRole('button', { name: "展开AI请求明细", exact: true }).click()
  const requests = usage.getByRole('table', { name: "本次住院AI请求明细", exact: true })
  await expect(requests.getByRole('row')).toHaveCount(3)
  await expect(requests).toContainText('术前生成')
  await expect(requests).toContainText('术前核验')
  await expect(requests).toContainText('synthetic-drg-model')
  await expect(requests).toContainText('自动')
  await expect(requests).toContainText('未配置价格')
  await expect.poll(() => usage.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  const followupState = inpatientDrgFollowupSchema.parse(await (await app.fixture.request('inpatient-doctor', `${stay.path}/drg/followup`)).json())
  const taskId = followupState.task!.id
  const overview = modelUsageOverviewSchema.parse(await (await page.request.get(`${app.origin}/api/model-usage/overview?caseId=${stay.admissionId}&taskId=${taskId}`)).json())
  expect(overview.totals).toMatchObject({ requests: 2, knownInputTokens: 200, knownOutputTokens: 40, knownTokens: 240 })
  expect(overview.stages?.map(stage => [stage.stage, stage.requests])).toEqual([
    ['preoperative-generation', 1], ['preoperative-verification', 1],
  ])
  await page.goto('about:blank')
  await app.fixture.restart()
  await loginPciBrowser(page, app, 'inpatient-doctor')
  await open(stay.admissionId, detail.admission.patientName)
  await expect(usage.getByLabel("实际AI请求数", { exact: true })).toHaveText('2')
  await expect(usage.getByLabel('已知总 Token', { exact: true })).toHaveText('240')
  await followup.getByLabel('停止跟进理由', { exact: true }).fill('合成用量验收完成，保留已发生消费')
  await followup.getByRole('button', { name: '停止本次跟进', exact: true }).click()
  await expect(followup.getByText('已停止', { exact: true })).toBeVisible()
  await expect(usage.getByLabel("实际AI请求数", { exact: true })).toHaveText('2')
  expect(app.modelFeatures).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
  app.fixture.options.modelPricing = { prices: [{ provider: 'synthetic.invalid', model: 'synthetic-drg-model',
    version: 'synthetic-browser-price-v1', currency: 'CNY', rates: { input: 10000, output: 20000 } }], exchangeRates: [] }
  await page.goto('about:blank')
  await app.fixture.restart()
  await loginPciBrowser(page, app, 'admin')
  expect((await page.request.post(`${app.origin}/api/auth/role`, { headers: { origin: app.origin },
    data: { practitionerRoleId: 'practitioner-role-inpatient-doctor' } })).status()).toBe(200)
  await open(stay.admissionId, detail.admission.patientName)
  await usage.getByRole('button', { name: "展开AI请求明细", exact: true }).click()
  await requests.getByRole('row').filter({ hasText: '术前核验' }).getByRole('button', { name: '查看计量核对', exact: true }).click()
  await usage.getByRole('button', { name: '按当前价表补算', exact: true }).click()
  const correction = page.getByRole('dialog', { name: '按当前价表补算', exact: true })
  await expect.poll(() => correction.evaluate(element => {
    const root = element.getRootNode(), active = root instanceof ShadowRoot ? root.activeElement : document.activeElement
    return element.contains(active)
  })).toBe(true)
  await correction.getByLabel('依据引用', { exact: true }).fill('synthetic-browser-price-v1')
  const repriced = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/reprice'))
  await correction.getByRole('button', { name: '确认补算', exact: true }).click()
  const response = await repriced
  expect(response.status()).toBe(200)
  expect(response.request().postDataJSON()).toEqual({ expectedRevision: 0, evidence: 'synthetic-browser-price-v1' })
  expect(modelUsageAttemptSchema.parse(await response.json())).toMatchObject({
    context: { taskId, caseId: stay.admissionId }, cost: { status: 'price-not-configured', cny: null },
    effectiveCost: { status: 'priced', cny: 1.4 }, corrections: [{ kind: 'reprice', evidence: 'synthetic-browser-price-v1' }],
  })
  await expect(correction).toBeHidden()
  await expect(usage.getByLabel('估算人民币费用', { exact: true })).toHaveText('¥1.40')
  await expect(usage.getByLabel("实际AI请求数", { exact: true })).toHaveText('2')
  expect(app.modelFeatures).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
  for (const url of reads) {
    expect(url.searchParams.get('caseId')).toBe(stay.admissionId)
    expect(url.searchParams.get('taskId')).toBe(taskId)
  }
}
