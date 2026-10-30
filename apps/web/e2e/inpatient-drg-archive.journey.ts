import { selectInpatientStage } from './inpatient-ui.ts'
import type { APIRequestContext, Page } from '@playwright/test'
import { inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { archiveDrgBrowserPatient, createDrgBrowserPatient, drgBrowserApi, expect } from './inpatient-drg.fixture.ts'

export async function runDrgArchiveJourney(input: {
  page: Page
  request: APIRequestContext
  browserApp: { origin: string; password: string }
  open: () => Promise<void>
}) {
  const { page, request, browserApp } = input
  const s = await createDrgBrowserPatient({ request }, browserApp, '合成归档缓存患者')
  await drgBrowserApi(page, browserApp).login('inpatient-doctor')
  await input.open()
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await selectInpatientStage(page, 'DRG 预分组')
  const panel = page.getByRole('region', { name: "DRG 预分组", exact: true })
  await expect(panel.getByRole('region', { name: "按当前诊断和手术", exact: true })).toContainText('已分组 · RA15')
  await expect(panel.getByTestId('drg-charges')).toContainText('已发生收费 ¥0.00')
  await expect(panel.getByRole('table')).toBeVisible()

  // 隐藏页签保留原推演，由独立认证会话完成归档，医生会话继续读取同一次住院。
  await selectInpatientStage(page, "病案")
  await archiveDrgBrowserPatient(s)
  const refreshed = page.waitForResponse(response => response.url().endsWith('/api/his/v1/inpatient/admissions'))
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  const admissions = inpatientListSchema.parse(await (await refreshed).json())
  expect(admissions.items.find(item => item.id === s.admissionId)?.recordStatus).toBe('archived')
  await selectInpatientStage(page, 'DRG 预分组')
  const frozen = panel.getByRole('region', { name: "归档分组", exact: true })
  await expect(frozen).toContainText('已分组 · RA15')
  await expect(panel.getByRole('region', { name: "按当前诊断和手术", exact: true })).toHaveCount(0)
  await expect(panel.getByTestId('drg-charges')).toHaveCount(0)
  await expect(panel.getByRole('table')).toHaveCount(0)

  const regrouped = page.waitForResponse(response => response.url().endsWith(`${s.path}/drg/pregroup`))
  await panel.getByRole('button', { name: '刷新固定结果', exact: true }).click()
  expect((await regrouped).status()).toBe(200)
  await expect(frozen).toContainText('已分组 · RA15')
  await expect(panel.getByTestId('drg-charges')).toHaveCount(0)
}
