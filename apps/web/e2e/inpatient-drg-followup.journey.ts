import type { Page } from '@playwright/test'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { expect, type createDrgBrowserPatient } from './inpatient-drg.fixture.ts'

type Patient = Awaited<ReturnType<typeof createDrgBrowserPatient>>
export async function runDrgFollowupJourney(page: Page, s: Patient, open: () => Promise<void>) {
  const header = page.getByRole('region', { name: '当前住院患者', exact: true })
  const toggle = header.getByRole('button', { name: '助手自动跟进', exact: true })
  await open()
  await toggle.click()
  const enableDialog = page.getByRole('dialog', { name: '开启助手自动跟进', exact: true })
  await expect(enableDialog).toContainText('开启后，本次住院内诊断、手术或费用变化时，助手自动')
  await enableDialog.getByRole('button', { name: '开启', exact: true }).click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
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
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  const restored = inpatientDrgFollowupSchema.parse(await (await s.api.get(`${s.path}/drg/followup`)).json())
  expect(restored.task?.id).toBe(original.id)
  await toggle.click()
  const stopDialog = page.getByRole('dialog', { name: '停止助手自动跟进', exact: true })
  await stopDialog.getByLabel('停止理由（必填）', { exact: true }).fill('合成浏览器验收结束')
  await stopDialog.getByRole('button', { name: '确认停止', exact: true }).click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
}
