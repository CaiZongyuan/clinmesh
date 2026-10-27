import type { Page } from '@playwright/test'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientPciSelectionResponseSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { modelUsageOverviewSchema } from '@clinmesh/contracts/model-usage'
import { pciAgentParameters } from '../../server/tests/fixtures/inpatient-drg-agent.ts'
import { expect, loginPciBrowser, type PciBrowserApp } from './inpatient-pci.fixture.ts'

export async function runDrgUsageJourney(page: Page, app: PciBrowserApp, open: (admissionId: string, name: string) => Promise<void>) {
  const stay = await app.fixture.preparePciAdmission()
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
  const followup = page.getByRole('region', { name: '住院后台跟进', exact: true })
  await followup.getByRole('button', { name: '开启本次住院跟进', exact: true }).click()
  const usage = page.getByRole('region', { name: '本次住院模型用量', exact: true })
  await expect(usage.getByLabel('实际模型请求数', { exact: true })).toHaveText('2')
  await expect(usage.getByLabel('已知输入 Token', { exact: true })).toHaveText('200')
  await expect(usage.getByLabel('已知输出 Token', { exact: true })).toHaveText('40')
  await expect(usage.getByLabel('已知总 Token', { exact: true })).toHaveText('240')
  await expect(usage.getByLabel('估算人民币费用', { exact: true })).toHaveText('未知')
  await expect(usage).toContainText('尚无术中模型调用')
  await expect(usage).toContainText('尚无术后模型调用')
  await usage.getByRole('button', { name: '展开模型请求明细', exact: true }).click()
  const requests = usage.getByRole('table', { name: '本次住院模型请求明细', exact: true })
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
  await expect(usage.getByLabel('实际模型请求数', { exact: true })).toHaveText('2')
  await expect(usage.getByLabel('已知总 Token', { exact: true })).toHaveText('240')
  await followup.getByLabel('停止跟进理由', { exact: true }).fill('合成用量验收完成，保留已发生消费')
  await followup.getByRole('button', { name: '停止本次跟进', exact: true }).click()
  await expect(followup.getByText('已停止', { exact: true })).toBeVisible()
  await expect(usage.getByLabel('实际模型请求数', { exact: true })).toHaveText('2')
  expect(app.modelFeatures).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
  for (const url of reads) {
    expect(url.searchParams.get('caseId')).toBe(stay.admissionId)
    expect(url.searchParams.get('taskId')).toBe(taskId)
  }
}
