import type { Page } from '@playwright/test'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { expect, type createDrgBrowserPatient } from './inpatient-drg.fixture.ts'

type Patient = Awaited<ReturnType<typeof createDrgBrowserPatient>>
export async function runDrgFollowupJourney(page: Page, s: Patient, open: () => Promise<void>) {
  const panel = page.getByRole('region', { name: '住院后台跟进', exact: true })
  await open()
  await panel.getByRole('button', { name: '开启本次住院跟进', exact: true }).click()
  await expect(panel.getByText('正在跟进', { exact: true })).toBeVisible()
  await expect(panel).toContainText('规则核对本次未调用模型')
  await expect.poll(async () => inpatientDrgFollowupSchema.parse(await (await s.api.get(`${s.path}/drg/followup`)).json()).task?.ruleStatus).toBe('complete')
  const original = inpatientDrgFollowupSchema.parse(await (await s.api.get(`${s.path}/drg/followup`)).json()).task!
  await page.goto('about:blank')
  await s.api.login('admin')
  const clock = await (await s.api.get('/api/sim/v1/scenario-runs/current')).json()
  expect((await s.api.post('/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
    expectedVirtualTime: clock.virtualTime, targetVirtualTime: new Date(Date.parse(clock.virtualTime) + 86_400_000).toISOString(),
  })).status()).toBe(200)
  await s.api.login('inpatient-doctor')
  await expect.poll(async () => inpatientDrgFollowupSchema.parse(await (await s.api.get(`${s.path}/drg/followup`)).json()).task?.simulation?.formal.chargesFen).toBe(5000)
  await open()
  await expect(panel).toContainText('后台正式收费')
  const restored = inpatientDrgFollowupSchema.parse(await (await s.api.get(`${s.path}/drg/followup`)).json())
  expect(restored.task?.id).toBe(original.id)
  await panel.getByLabel('停止跟进理由', { exact: true }).fill('合成浏览器验收结束')
  await panel.getByRole('button', { name: '停止本次跟进', exact: true }).click()
  await expect(panel.getByText('已停止', { exact: true })).toBeVisible()
}
