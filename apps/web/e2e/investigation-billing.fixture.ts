import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { confirmDoctorPreparationResponseSchema } from '@clinmesh/contracts/doctor-recommendations'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { createInvestigationReferenceDatabase } from './investigation-workspace.fixture.ts'

/** 只准备待诊病例，所有正式申请和应收均由浏览器中的医生工作流创建。 */
export async function startInvestigationBillingServer(webRoot: string) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-investigation-billing-'))
  let app: Awaited<ReturnType<typeof startBrowserServer>> | undefined
  try {
    const referenceDatabasePath = await createInvestigationReferenceDatabase(directory)
    app = await startBrowserServer(webRoot, {
      activeReferenceReleaseId: 'investigation-e2e-v1', referenceDatabasePath,
      patientPersonaModel: 'synthetic-persona', syntheaProvider: new StubSyntheaProvider(),
      chatCompletionsProvider: { completeJson: async input => {
        expect(input.schemaName).toBe('patient_persona')
        return { model: input.model, content: JSON.stringify(persona) }
      } },
    })
    const started = await startConsultationCase(app.runtime, app.password, app.origin)
    const server = app
    return { ...server, caseId: started.outpatientCaseId, async close() {
      try { await server.close() }
      finally { await rm(directory, { recursive: true, force: true }) }
    } }
  } catch (error) {
    try { await app?.close() }
    finally { await rm(directory, { recursive: true, force: true }) }
    throw error
  }
}

export async function openDoctorFirstVisit(page: Page, server: { origin: string; password: string }) {
  await page.goto(`${server.origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(server.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('tab', { name: '待诊', exact: true }).click()
  await page.getByRole('button', { name: /^选择病例 / }).click()
  await page.getByRole('button', { name: '开始首诊', exact: true }).click()
  await page.getByRole('tab', { name: '检验检查', exact: true }).click()
}

export async function issueDoctorLaboratoryRequest(page: Page, item: { query: string; name: string; code: string }) {
  const laboratory = page.getByRole('tabpanel', { name: /^检验 \d+$/ })
  await laboratory.getByRole('button', { name: '添加检验', exact: true }).click()
  const composer = page.getByRole('dialog', { name: '选择检验项目', exact: true })
  await composer.getByLabel('搜索检验目录', { exact: true }).fill(item.query)
  await composer.getByRole('button', { name: '执行检验目录搜索', exact: true }).click()
  await composer.getByRole('button', { name: `选择 ${item.name} ${item.code}`, exact: true }).click()
  await expect(composer.getByText('本院门诊价格：¥8.00 / 项目 · 数量 1', { exact: true })).toBeVisible()
  await composer.getByRole('button', { name: '加入检验申请', exact: true }).click()
  await expect(composer).toHaveCount(0)
  const pending = laboratory.getByRole('region', { name: '待开具检验', exact: true })
  await expect(pending.getByText('本院门诊价格：¥8.00 / 项目 · 数量 1', { exact: true })).toBeVisible()
  const issued = page.waitForResponse(response => response.url().endsWith('/recommendations/laboratory/actions/confirm'))
  await pending.getByRole('button', { name: /^开具选中项目/ }).click()
  const response = await issued
  expect(response.status()).toBe(200)
  const id = confirmDoctorPreparationResponseSchema.parse(await response.json()).data.recordIds[0]
  if (id === undefined) throw new Error('Expected the original laboratory request identity')
  await expect(laboratory.getByRole('region', { name: '申请收费信息', exact: true }).getByText('待缴费', { exact: true })).toBeVisible()
  return id
}

export async function readDoctorBillingCase(page: Page, server: { origin: string; caseId: string }) {
  const response = await page.request.get(`${server.origin}/api/his/v1/doctor/cases/${server.caseId}`)
  expect(response.status()).toBe(200)
  return doctorCaseDetailSchema.parse(await response.json())
}
