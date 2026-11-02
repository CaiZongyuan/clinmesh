import { inpatientMaterialEstimateResponseSchema, inpatientMaterialEstimatesSchema, type InpatientMaterialEstimate } from '@clinmesh/contracts/inpatient-material-estimate'
import { expect, test } from './inpatient-pci-ai.fixture.ts'
import { preparePciAiReview, runPciAiJourney } from './inpatient-pci-ai.journey.ts'

test('正式造影报告带入PCI草稿，同屏审阅指南与费用后一次确认，术中规则费用和术后差异无需跟进', async ({ page, pciAiApp }) => {
  await runPciAiJourney(page, pciAiApp)
})

test('清单自动保存期间继续输入不锁卡或交接，晚到回执保留新说明及最新元数据后仍可一次确认', async ({ page, pciAiApp: app }) => {
  const { stay, planned, panel, selection, errors } = await preparePciAiReview(page, app)
  const f = app.fixture, note = panel.getByRole('textbox', { name: '耗材清单说明', exact: true })
  const read = async () => (await f.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates.find(item => item.requestId === planned.id)!
  const initial = await read()
  expect(initial.draft?.revision).toBe(1)
  expect(initial.draft?.analysisId).toBe(initial.analysis?.id)
  const completed = page.getByText(`已完成本次操作 · ${stay.patientName}`, { exact: true })
  await expect(completed).toHaveCount(0)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const requests: Array<{ expectedDraftRevision: number; expectedBasisFingerprint: string; analysisId: string | null; note: string }> = []
  const saved: InpatientMaterialEstimate[] = []
  await page.route(`**${stay.path}/material-estimates/save`, async route => {
    requests.push(route.request().postDataJSON().input)
    if (requests.length === 1) await gate
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    saved.push(inpatientMaterialEstimateResponseSchema.parse(await response.json()).data)
    await route.fulfill({ response })
  })
  try {
    await note.fill('第一版正在保存的清单说明')
    await expect.poll(() => requests.length).toBe(1)
    await expect(note).toBeEditable()
    expect(await note.evaluate(element => element.closest('[inert]') === null)).toBe(true)
    await note.fill('保存期间继续输入的最新说明')
    await expect(note).toHaveValue('保存期间继续输入的最新说明')
    await expect(completed).toHaveCount(0)
    release()
    await expect.poll(async () => (await read()).draft?.note).toBe('保存期间继续输入的最新说明')
    await expect.poll(() => saved.length).toBe(2)
    expect(requests.map(request => request.expectedDraftRevision)).toEqual([1, 2])
    expect(saved.map(state => state.draft?.revision)).toEqual([2, 3])
    expect(requests[1]).toMatchObject({ expectedBasisFingerprint: saved[0]!.basisFingerprint, analysisId: saved[0]!.draft!.analysisId, note: '保存期间继续输入的最新说明' })
    const latest = await read()
    expect(latest.draft).toMatchObject({ revision: 3, basisFingerprint: latest.basisFingerprint, analysisId: latest.analysis!.id, note: '保存期间继续输入的最新说明' })
    await expect(note).toHaveValue('保存期间继续输入的最新说明')
    await expect(completed).toHaveCount(0)
    await panel.getByRole('checkbox', { name: '已核对选型参数、材料、数量、费用、依据及原预留处理', exact: true }).check()
    await page.getByRole('button', { name: '确认选型、清单与预留', exact: true }).click()
    await expect.poll(async () => (await selection()).confirmation?.parameters.requestId).toBe(planned.id)
    expect((await read()).draft?.confirmedRevision).toBe(3)
    expect(errors).toEqual([])
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }) }
})
