import { randomUUID } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import { confirmDoctorPreparationRequestSchema, confirmDoctorPreparationResponseSchema } from '@clinmesh/contracts/doctor-recommendations'
import { fhirBundleSchema, fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { clinicalCatalogSchema, diagnosisDraftResponseSchema, doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { test as base } from './fixtures.ts'
import { closeQueue, expectConsultationStarted, openQueue } from './queue-overlay.fixture.ts'
import { openWorkspaceTab } from './workspace-tabs.fixture.ts'

export const test = base.extend<{ consultationCase: Awaited<ReturnType<typeof startConsultationCase>> }>({
  browserApp: async ({ webRoot }, use) => {
    const app = await startBrowserServer(webRoot, {
      patientPersonaModel: 'synthetic-persona', syntheaProvider: new StubSyntheaProvider(),
      chatCompletionsProvider: { completeJson: async input => {
        if (input.schemaName !== 'patient_persona') throw new Error(`Unexpected synthetic schema: ${input.schemaName}`)
        return { model: input.model, content: JSON.stringify({ ...persona, chiefComplaint: '发热、咽痛伴肌痛两天',
          symptomExperience: '两天前开始发热、咽痛和肌肉酸痛，未自行服药。', openingStatement: '医生您好，我发烧、喉咙痛两天了。' }) }
      } },
    })
    try { await use(app) } finally { await app.close() }
  },
  consultationCase: async ({ browserApp }, use) => {
    await use(await startConsultationCase(browserApp.runtime, browserApp.password, browserApp.origin,
      { chiefComplaint: '发热、咽痛伴肌痛两天', temperatureC: 38.5 }))
  },
})
export { expect }

export async function runOutpatientDiagnosisBatchJourney({ page, browserApp, consultationCase, step = async () => {} }: {
  page: Page; browserApp: { origin: string; password: string }; consultationCase: { outpatientCaseId: string }
  step?: (caption: string) => Promise<void>
}) {
  const posts: Array<{ key: string; body: unknown }> = [], receiptReads: string[] = [], errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST' && path.endsWith('/recommendations/diagnosis/actions/confirm')) {
      posts.push({ key: request.headers()['idempotency-key']!, body: request.postDataJSON() })
    }
    if (request.method() === 'GET' && path.includes('/recommendations/diagnosis/confirmations/')) receiptReads.push(path)
  })
  await page.route(/\/recommendations\/(diagnosis|prescription|laboratory|imaging|pathology)$/, route => route.abort('failed'))
  await page.goto(`${browserApp.origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await openQueue(page)
  await page.getByRole('tab', { name: '待诊', exact: true }).click()
  await page.getByRole('button', { name: /^选择病例 / }).click()
  await page.getByRole('button', { name: '开始首诊', exact: true }).click()
  await expectConsultationStarted(page)
  await closeQueue(page)
  const readCase = async () => {
    const response = await page.request.get(`${browserApp.origin}/api/his/v1/doctor/cases/${consultationCase.outpatientCaseId}`)
    expect(response.status()).toBe(200)
    return doctorCaseDetailSchema.parse(await response.json())
  }
  const readConditions = async () => {
    const detail = await readCase()
    const response = await page.request.get(`${browserApp.origin}/fhir/R5/Condition?encounter=Encounter/${detail.encounter.id}&_total=accurate`)
    expect(response.status()).toBe(200)
    return fhirBundleSchema.parse(await response.json())
  }
  const catalog = clinicalCatalogSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/catalogs/clinical`)).json())
  const fever = catalog.diagnoses.find(item => item.code === 'R50.9')
  const influenza = catalog.diagnoses.find(item => item.id === 'diagnosis-influenza')
  if (fever === undefined || influenza === undefined) throw new Error('Synthetic diagnosis catalog missing fever or influenza')
  const notes = ['合成诊断：本次发热症状已核实。', '合成诊断：结合问诊表现复核流感为主诊断。']
  await openWorkspaceTab(page, '诊断')
  const pending = page.getByRole('region', { name: '待确认诊断', exact: true })
  await step('01 · 门诊医生：从真实待诊队列接诊，同窗连续加入两条诊断')
  await page.getByRole('button', { name: '添加诊断', exact: true }).click()
  const composer = page.getByRole('dialog', { name: '选择诊断', exact: true })
  for (const [index, diagnosis] of [fever, influenza].entries()) {
    await composer.getByRole('button', { name: `选择 ${diagnosis.nameZh} ${diagnosis.code}`, exact: true }).click()
    await expect(composer.getByRole('button', { name: index === 0 ? '主诊断' : '次诊断', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(composer.getByLabel('诊断备注', { exact: true })).toHaveValue('')
    await composer.getByLabel('诊断备注', { exact: true }).fill(notes[index]!)
    await composer.getByRole('button', { name: '加入诊断', exact: true }).click()
    await expect(composer).toBeVisible()
    await expect(composer.getByText(`待确认 ${index + 1} 项 · 最多 8 项`, { exact: true })).toBeVisible()
  }
  await step('02 · 同窗回看两条备注，将第二条改为主诊断，原主诊断自动降为次诊断')
  await composer.getByRole('button', { name: `编辑待确认诊断 ${influenza.nameZh}`, exact: true }).click()
  const editor = page.getByRole('dialog', { name: '编辑诊断', exact: true })
  await expect(editor.getByLabel('诊断备注', { exact: true })).toHaveValue(notes[1]!)
  await editor.getByRole('button', { name: '主诊断', exact: true }).click()
  await editor.getByRole('button', { name: '保存修改', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await pending.getByRole('button', { name: `编辑诊断 ${fever.nameZh}`, exact: true }).click()
  await expect(editor.getByRole('button', { name: '次诊断', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(editor.getByLabel('诊断备注', { exact: true })).toHaveValue(notes[0]!)
  await editor.getByRole('button', { name: '完成选择', exact: true }).click()
  const reopen = async () => {
    await page.reload()
    await openQueue(page)
    await page.getByRole('tab', { name: '在诊', exact: true }).click()
    await page.getByRole('button', { name: /^选择病例 / }).click()
    await closeQueue(page)
    await openWorkspaceTab(page, '诊断')
    await expect(pending.getByRole('checkbox')).toHaveCount(2)
  }
  await step('03 · 刷新保留两条诊断；清空选择不删除草稿，仅选择次诊断时禁止确认')
  await reopen()
  await pending.getByRole('button', { name: '清空选择', exact: true }).click()
  const confirm = pending.getByRole('button', { name: /^确认选中诊断/ })
  await expect(confirm).toBeDisabled()
  await expect(pending.getByRole('checkbox')).toHaveCount(2)
  await pending.getByRole('checkbox', { name: `选择${fever.nameZh}`, exact: true }).click()
  await expect(confirm).toBeDisabled()
  expect(posts).toHaveLength(0)
  await pending.getByRole('button', { name: '全选可办理项目', exact: true }).click()
  await step('04 · 并发草稿版本变化，服务端拒绝整组确认；两条输入保留且未生成 Condition')
  let conflicted = false
  await page.route('**/recommendations/diagnosis/actions/confirm', async route => {
    const original = confirmDoctorPreparationRequestSchema.parse(route.request().postDataJSON())
    const detail = await readCase()
    const saved = await page.request.put(`${browserApp.origin}/api/his/v1/encounters/${detail.encounter.id}/diagnosis/draft`, {
      headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() },
      data: { expectedVersions: { [`Encounter/${detail.encounter.id}`]: detail.encounter.versionId }, input: {
        expectedDraftVersion: detail.diagnosis?.draftVersion ?? 0,
        entries: original.input.selections.map(selection => {
          if (selection.kind !== 'diagnosis') throw new Error('Expected diagnosis selection')
          return { catalogItemId: selection.catalogItemId, role: selection.role, note: selection.note }
        }),
      } },
    })
    expect(saved.status(), await saved.text()).toBe(200)
    diagnosisDraftResponseSchema.parse(await saved.json())
    const response = await route.fetch()
    expect(response.status(), await response.text()).toBe(409)
    conflicted = true
    await route.fulfill({ response })
  })
  await confirm.click()
  await expect.poll(() => conflicted).toBe(true)
  await expect(pending.getByRole('checkbox')).toHaveCount(2)
  expect((await readCase()).diagnosis?.confirmation).toBeUndefined()
  expect((await readConditions()).total).toBe(0)
  await page.unroute('**/recommendations/diagnosis/actions/confirm')
  await step('05 · 刷新核对保留的主次与备注，再一次确认完整两条诊断组')
  await reopen()
  for (const [index, diagnosis] of [fever, influenza].entries()) {
    await pending.getByRole('button', { name: `编辑诊断 ${diagnosis.nameZh}`, exact: true }).click()
    await expect(editor.getByLabel('诊断备注', { exact: true })).toHaveValue(notes[index]!)
    await expect(editor.getByRole('button', { name: index === 0 ? '次诊断' : '主诊断', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await editor.getByRole('button', { name: '完成选择', exact: true }).click()
  }
  let dropped = false
  let originalReceipt: ReturnType<typeof confirmDoctorPreparationResponseSchema.parse> | undefined
  await page.route('**/recommendations/diagnosis/actions/confirm', async route => {
    const response = await route.fetch()
    expect(response.status(), await response.text()).toBe(200)
    originalReceipt = confirmDoctorPreparationResponseSchema.parse(await response.json())
    dropped = true
    await route.abort('failed')
  })
  await confirm.click()
  await expect.poll(() => dropped).toBe(true)
  await expect(pending.getByText('原确认结果待恢复', { exact: true })).toBeVisible()
  expect(posts).toHaveLength(2)
  const frozen = confirmDoctorPreparationRequestSchema.parse(posts[1]!.body)
  expect(frozen.input.selections).toMatchObject([
    { catalogItemId: fever.id, role: 'secondary', note: notes[0] },
    { catalogItemId: influenza.id, role: 'primary', note: notes[1] },
  ])
  await step('06 · 确认已生效但响应丢失；刷新只读取原回执，确认版本不增加')
  await page.unroute('**/recommendations/diagnosis/actions/confirm')
  await reopen()
  const recoveredResponse = page.waitForResponse(response => response.request().method() === 'GET'
    && new URL(response.url()).pathname.endsWith(`/recommendations/diagnosis/confirmations/${posts[1]!.key}`))
  await pending.getByRole('button', { name: '恢复原确认', exact: true }).click()
  const recovered = await recoveredResponse
  expect(recovered.status()).toBe(200)
  expect(confirmDoctorPreparationResponseSchema.parse(await recovered.json())).toEqual(originalReceipt)
  await expect(pending.getByText('原确认结果待恢复', { exact: true })).toHaveCount(0)
  await expect(pending.getByRole('checkbox')).toHaveCount(0)
  expect(posts).toHaveLength(2)
  expect(receiptReads).toHaveLength(1)
  expect(receiptReads[0]).toContain(posts[1]!.key)
  const final = await readCase()
  expect(final.diagnosis?.confirmation?.revisionNumber).toBe(1)
  expect(final.diagnosis?.confirmation?.entries).toMatchObject([
    { catalogItemId: fever.id, role: 'secondary', note: notes[0] },
    { catalogItemId: influenza.id, role: 'primary', note: notes[1] },
  ])
  const conditions = await readConditions()
  expect(conditions.total).toBe(2)
  const entries = final.diagnosis!.confirmation!.entries
  expect(conditions.entry?.map(entry => entry.resource.id).sort()).toEqual(entries.map(entry => entry.conditionId).sort())
  for (const [index, diagnosis] of [fever, influenza].entries()) expect(conditions.entry?.map(entry => entry.resource)).toEqual(expect.arrayContaining([
    expect.objectContaining({ resourceType: 'Condition', id: entries[index]!.conditionId,
      code: expect.objectContaining({ coding: [expect.objectContaining({ code: diagnosis.code })] }), note: [{ text: notes[index] }] }),
  ]))
  const encounterResponse = await page.request.get(`${browserApp.origin}/fhir/R5/Encounter/${final.encounter.id}`)
  expect(encounterResponse.status()).toBe(200)
  const encounter = fhirResourceSchema.parse(await encounterResponse.json())
  expect(encounter).toMatchObject({ diagnosis: entries.map(entry => ({
    condition: [{ reference: { reference: `Condition/${entry.conditionId}` } }], use: [{ coding: [expect.objectContaining({ code: entry.role })] }],
  })) })
  const records = page.getByRole('region', { name: '诊断列表', exact: true })
  for (const diagnosis of [fever, influenza]) await expect(records.getByRole('cell', { name: diagnosis.nameZh, exact: true })).toBeVisible()
  await step('07 · 两条正式 Condition、恰好一条主诊断；原回执恢复完成，无重复确认')
  expect(errors).toEqual([])
  return { posts: posts.length, receiptReads: receiptReads.length, originalKey: posts[1]!.key,
    confirmation: final.diagnosis!.confirmation!, conditions: conditions.total, pageErrors: errors }
}
