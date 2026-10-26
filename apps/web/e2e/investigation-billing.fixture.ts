import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { expect, type Page } from '@playwright/test'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { confirmDoctorPreparationResponseSchema } from '@clinmesh/contracts/doctor-recommendations'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { sourceArtifactHash } from '../../server/src/application/scenario-data/provider.ts'
import { installSyntheticImagingAssets } from '../../server/tests/fixtures/imaging-catalog.ts'
import { installSyntheticPathologySlides } from '../../server/tests/fixtures/pathology-catalog.ts'
import { createInvestigationReferenceDatabase } from './investigation-workspace.fixture.ts'

/** 只准备待诊病例，所有正式申请和应收均由浏览器中的医生工作流创建。 */
export async function startInvestigationBillingServer(webRoot: string, allKinds = false) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-investigation-billing-'))
  let app: Awaited<ReturnType<typeof startBrowserServer>> | undefined
  try {
    const referenceDatabasePath = await createInvestigationReferenceDatabase(directory)
    const assets = { imagingAssetDirectory: join(directory, 'imaging-assets'), imagingCatalogDirectory: join(directory, 'imaging-catalog'),
      pathologyAssetDirectory: join(directory, 'pathology-assets'), pathologyCatalogDirectory: join(directory, 'pathology-catalog') }
    if (allKinds) {
      await installSyntheticImagingAssets({ assetDirectory: assets.imagingAssetDirectory, catalogDirectory: assets.imagingCatalogDirectory,
        assets: [{ assetId: 'synthetic-billing-radiograph', examCode: 'chest-radiograph' }] })
      await installSyntheticPathologySlides({ assetDirectory: assets.pathologyAssetDirectory, catalogDirectory: assets.pathologyCatalogDirectory,
        slides: [{ assetId: 'synthetic-billing-slide' }] })
    }
    app = await startBrowserServer(webRoot, {
      ...assets,
      activeReferenceReleaseId: 'investigation-e2e-v1', referenceDatabasePath,
      patientPersonaModel: 'synthetic-persona', syntheaProvider: new class extends StubSyntheaProvider {
        override async generate() {
          const corpus = await super.generate()
          if (!allKinds) return corpus
          return { ...corpus, sources: corpus.sources.map(source => {
            const raw = z.object({ entry: z.array(z.object({ resource: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough().parse(source.raw)
            raw.entry.push({ fullUrl: 'urn:uuid:synthetic-breast-procedure', resource: {
              code: { coding: [{ code: '392021009', display: '乳房肿块切除术', system: 'http://snomed.info/sct' }] },
              encounter: { reference: 'urn:uuid:prior-encounter' }, id: 'synthetic-breast-procedure',
              performedPeriod: { end: '2025-01-10T09:05:00+08:00', start: '2025-01-10T09:05:00+08:00' },
              resourceType: 'Procedure', status: 'completed', subject: { reference: 'urn:uuid:patient' },
            } })
            return { ...source, raw, hash: sourceArtifactHash(raw) }
          }) }
        }
      }(),
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
  await startDoctorFirstVisit(page, server.password)
}

export async function startDoctorFirstVisit(page: Page, password: string) {
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '门诊诊疗', exact: true })).toBeVisible()
  const queueRail = page.getByRole('button', { name: /^候诊队列 ·/ })
  if (await queueRail.isVisible()) await queueRail.click()
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

export async function issueDoctorImagingOrPathologyRequest(page: Page, kind: 'imaging' | 'pathology') {
  const imaging = kind === 'imaging'
  await page.getByRole('tab', { name: imaging ? /^放射检查 \d+$/ : /^病理会诊 \d+$/ }).click()
  await page.getByRole('button', { name: imaging ? '添加放射检查' : '添加病理会诊', exact: true }).click()
  const composer = page.getByRole('dialog', { name: imaging ? '选择放射检查' : '选择病理会诊', exact: true })
  await composer.getByRole('button', { name: imaging ? /^胸片/ : /^乳腺切片病理会诊/ }).click()
  await composer.getByLabel(imaging ? '检查指征' : '会诊目的', { exact: true }).fill(imaging ? '咳嗽两周，合成收费验证。' : '复核既往手术切片，合成收费验证。')
  await composer.getByRole('button', { name: '保存草稿', exact: true }).click()
  await expect(composer).toHaveCount(0)
  const pending = page.getByRole('region', { name: imaging ? '待开具放射检查' : '待开具病理会诊', exact: true })
  await expect(pending.getByText(imaging ? '本院门诊价格：¥80.00 / 次检查 · 数量 1' : '本院门诊价格：¥200.00 / 次会诊 · 数量 1', { exact: true })).toBeVisible()
  const issued = page.waitForResponse(response => response.url().endsWith(`/recommendations/${kind}/actions/confirm`))
  await pending.getByRole('button', { name: /^开具选中项目/ }).click()
  const response = await issued
  expect(response.status()).toBe(200)
  const id = confirmDoctorPreparationResponseSchema.parse(await response.json()).data.recordIds[0]
  if (id === undefined) throw new Error('Expected the original investigation request identity')
  await expect(page.getByRole('region', { name: '申请收费信息', exact: true }).getByText('待缴费', { exact: true })).toBeVisible()
  return id
}
