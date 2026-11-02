import { inpatientMaterialEstimateResponseSchema, inpatientMaterialEstimatesSchema, type InpatientMaterialEstimate } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientGuidelineAdviceListSchema } from '@clinmesh/contracts/inpatient-guideline-advice'
import { inpatientAngiographyReportsSchema } from '@clinmesh/contracts/inpatient-angiography'
import { expect, openPciAiPatient, pciAiGuidelineDocuments, pciAiQuotes, preparePciAiPatient, test } from './inpatient-pci-ai.fixture.ts'
import { preparePciAiPlan, preparePciAiReview, requestPciAiSurgery, runPciAiJourney } from './inpatient-pci-ai.journey.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

test('正式造影报告带入PCI草稿，同屏审阅指南与费用后一次确认，术中规则费用和术后差异无需跟进', async ({ page, pciAiApp }) => {
  await runPciAiJourney(page, pciAiApp)
})

test('无造影报告时页面保留具体测量缺项和有条件类别原句，不生成固定产品或测量', async ({ page, pciAiApp: app }) => {
  const stay = await preparePciAiPatient(app)
  await openPciAiPatient(page, app, 'inpatient-doctor', stay.patientName)
  await selectInpatientStage(page, '手术')
  const planned = await requestPciAiSurgery(page, app, stay.path, '36.0700', '缺少造影报告的PCI计划')
  const guide = page.getByRole('region', { name: '指南参考意见', exact: true })
  await expect(guide).toContainText('缺少病变长度。')
  await expect(guide).toContainText('缺少近端参考管径。')
  await expect(guide).toContainText('缺少远端参考管径。')
  await expect(guide.getByText('有条件的参考', { exact: true })).toHaveCount(3)
  await guide.getByText('查看尺寸与测量要求依据', { exact: true }).click()
  for (const quote of pciAiQuotes[2]) await expect(guide.getByRole('group', { name: '尺寸与测量要求依据', exact: true })).toContainText(quote)
  await expect(guide).not.toContainText('hospital-material-pci-')
  const state = (await app.fixture.read('inpatient-doctor', `${stay.path}/guideline-advice`, inpatientGuidelineAdviceListSchema)).advice.find(item => item.requestId === planned.id)!
  expect(state.status).toBe('incomplete')
  expect(state.result?.conclusions.every(item => item.applicability === 'conditional')).toBe(true)
  expect((await app.fixture.read('inpatient-doctor', `${stay.path}/angiography-reports`, inpatientAngiographyReportsSchema)).reports).toEqual([])
  expect(app.calls).toEqual([{ kind: 'guideline', phase: 'pci', feature: 'inpatient_drg_recommendation' }, { kind: 'guideline', phase: 'pci', feature: 'inpatient_drg_verification' }])
})

test('页面清空测量单位后旧指南失效，显式重评保留缺项和原句且不补造单位', async ({ page, pciAiApp: app }) => {
  const { stay, planned, panel, selection } = await preparePciAiReview(page, app)
  const parameters = panel.getByRole('region', { name: '报告带入的 PCI 参数', exact: true })
  const guide = page.getByRole('region', { name: '指南参考意见', exact: true })
  const read = async () => (await app.fixture.read('inpatient-doctor', `${stay.path}/guideline-advice`, inpatientGuidelineAdviceListSchema)).advice.find(item => item.requestId === planned.id)!
  await parameters.getByLabel('病变长度 单位', { exact: true }).fill('')
  await panel.getByRole('button', { name: '保存选型草稿', exact: true }).click()
  await expect.poll(async () => (await read()).status).toBe('stale')
  await expect(guide).toContainText('患者资料、计划、目录或指南依据已变化')
  await expect(guide.getByText('查看支架类别依据', { exact: true })).toHaveCount(0)
  expect(app.calls.filter(call => call.kind === 'guideline')).toHaveLength(2)
  await guide.getByRole('button', { name: '按当前依据重新评估指南', exact: true }).click()
  await expect.poll(async () => (await read()).status).toBe('incomplete')
  await expect(guide).toContainText('病变长度缺少单位。')
  await expect(guide.getByText('有条件的参考', { exact: true })).toHaveCount(3)
  await guide.getByText('查看尺寸与测量要求依据', { exact: true }).click()
  for (const quote of pciAiQuotes[2]) await expect(guide.getByRole('group', { name: '尺寸与测量要求依据', exact: true })).toContainText(quote)
  await expect(parameters.getByLabel('病变长度 单位', { exact: true })).toHaveValue('')
  const draft = (await selection()).drafts!.find(item => item.requestId === planned.id)!
  expect(draft.parameters.measurements.find(item => item.kind === 'lesion-length')?.unit).toBeNull()
  const report = (await app.fixture.read('inpatient-doctor', `${stay.path}/angiography-reports`, inpatientAngiographyReportsSchema)).reports.find(item => item.id === draft.reportId)!
  expect(report.measurements.find(item => item.kind === 'lesion-length')?.unit).toBe('mm')
  expect(app.calls.filter(call => call.kind === 'guideline')).toHaveLength(4)
  expect(app.calls.filter(call => call.kind === 'material')).toHaveLength(4)
})

test('无可用指南来源时页面明确来源缺口，独立有效清单与费用仍可一次确认', async ({ page, pciAiNoSourcesApp: app }) => {
  const { stay, planned, panel, selection } = await preparePciAiPlan(page, app)
  const guide = page.getByRole('region', { name: '指南参考意见', exact: true })
  await expect(guide).toContainText('本专题暂无可用指南原文，不能提供指南参考意见。')
  await expect(guide).toContainText('物理第35页不可用')
  await expect(guide.getByText('查看支架类别依据', { exact: true })).toHaveCount(0)
  const state = (await app.fixture.read('inpatient-doctor', `${stay.path}/guideline-advice`, inpatientGuidelineAdviceListSchema)).advice.find(item => item.requestId === planned.id)!
  expect(state).toMatchObject({ status: 'no-evidence', result: null })
  await expect(panel.getByRole('region', { name: '住院费用与医保参考', exact: true })).toContainText('预计住院总费用')
  await panel.getByRole('textbox', { name: '耗材清单说明', exact: true }).fill('无指南原文时人工核对独立清单依据')
  await expect.poll(async () => (await app.fixture.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates.find(item => item.requestId === planned.id)?.draft?.note).toBe('无指南原文时人工核对独立清单依据')
  await panel.getByRole('checkbox', { name: '已核对选型参数、材料、数量、费用、依据及原预留处理', exact: true }).check()
  await page.getByRole('button', { name: '确认选型、清单与预留', exact: true }).click()
  await expect.poll(async () => (await selection()).confirmation?.parameters.requestId).toBe(planned.id)
  expect(app.calls.filter(call => call.kind === 'guideline')).toHaveLength(0)
  expect(app.calls.filter(call => call.kind === 'material')).toHaveLength(4)
})

test('来源撤回后旧指南与原句停止展示，人工清单依据保持独立并可一次确认', async ({ page, pciAiApp: app }) => {
  const { stay, planned, panel, selection, catalog } = await preparePciAiReview(page, app)
  const wire = catalog.materials.find(item => item.id === 'hospital-material-pci-guidewire')!
  const read = async () => (await app.fixture.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates.find(item => item.requestId === planned.id)!
  await panel.getByRole('textbox', { name: `预计理由：${wire.display}`, exact: true }).fill('医生人工核对导丝用途及独立数量依据')
  await panel.getByRole('textbox', { name: '耗材清单说明', exact: true }).fill('人工清单仅依据正式报告与有效院内耗材方案')
  await expect.poll(async () => (await read()).draft?.note).toBe('人工清单仅依据正式报告与有效院内耗材方案')
  const before = await read()
  expect(before.draft?.edited).toBe(true)
  expect(before.draft?.items.find(item => item.materialId === wire.id)?.reason).toBe('医生人工核对导丝用途及独立数量依据')
  const calls = [...app.calls], source = pciAiGuidelineDocuments()[0]!
  app.writer.importDocument({ ...source, source: { ...source.source, status: 'withdrawn' }, passages: [] })
  const guide = page.getByRole('region', { name: '指南参考意见', exact: true })
  await guide.getByRole('button', { name: '刷新指南状态', exact: true }).click()
  await expect(guide).toContainText('本专题暂无可用指南原文，不能提供指南参考意见。')
  await expect(guide.locator('blockquote')).toHaveCount(0)
  await expect(guide.getByText('查看支架类别依据', { exact: true })).toHaveCount(0)
  const guideline = (await app.fixture.read('inpatient-doctor', `${stay.path}/guideline-advice`, inpatientGuidelineAdviceListSchema)).advice.find(item => item.requestId === planned.id)!
  expect(guideline).toMatchObject({ status: 'no-evidence', result: null })
  const independent = await read()
  expect(independent.basisFingerprint).toBe(before.basisFingerprint)
  expect(independent.draft).toEqual(before.draft)
  await expect(panel.getByRole('textbox', { name: '耗材清单说明', exact: true })).toHaveValue('人工清单仅依据正式报告与有效院内耗材方案')
  await panel.getByRole('checkbox', { name: '已核对选型参数、材料、数量、费用、依据及原预留处理', exact: true }).check()
  await page.getByRole('button', { name: '确认选型、清单与预留', exact: true }).click()
  await expect.poll(async () => (await selection()).confirmation?.parameters.requestId).toBe(planned.id)
  expect((await read()).draft?.confirmedRevision).toBe(before.draft!.revision)
  expect(app.calls).toEqual(calls)
})

test('指南请求结果未知时刷新重开与核查原用量都不重发模型或丢失独立材料清单', async ({ page, pciAiUnknownGuidelineApp: app }) => {
  const posted: string[] = []
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/guideline-advice/request')) posted.push(request.url()) })
  const { stay, planned, panel } = await preparePciAiPlan(page, app)
  const guide = page.getByRole('region', { name: '指南参考意见', exact: true })
  await expect(guide).toContainText('原模型请求结果未知')
  await expect(guide).not.toContainText('MODEL_OUTCOME_UNKNOWN')
  await expect(guide.getByRole('button', { name: '按当前依据重新评估指南', exact: true })).toHaveCount(0)
  const read = async () => (await app.fixture.read('inpatient-doctor', `${stay.path}/guideline-advice`, inpatientGuidelineAdviceListSchema)).advice.find(item => item.requestId === planned.id)!
  const original = await read()
  expect(original).toMatchObject({ status: 'unknown', result: null })
  expect(app.calls.filter(call => call.kind === 'guideline')).toEqual([{ kind: 'guideline', phase: 'pci', feature: 'inpatient_drg_recommendation' }])
  await guide.getByRole('button', { name: '核查原请求与实际用量', exact: true }).click()
  await expect(guide.getByRole('region', { name: '本次住院AI用量', exact: true }).getByLabel('实际AI请求数', { exact: true })).toHaveText('1')
  await guide.getByRole('button', { name: '刷新指南状态', exact: true }).click()
  await openPciAiPatient(page, app, 'inpatient-doctor', stay.patientName)
  await selectInpatientStage(page, '手术')
  await expect(guide).toContainText('原模型请求结果未知')
  await guide.getByRole('button', { name: '核查原请求与实际用量', exact: true }).click()
  await expect(guide.getByRole('region', { name: '本次住院AI用量', exact: true }).getByLabel('实际AI请求数', { exact: true })).toHaveText('1')
  await expect(panel).toContainText('AI 预计与独立核验已完成')
  expect(await read()).toMatchObject({ status: 'unknown', taskId: original.taskId, version: original.version })
  expect(app.calls.filter(call => call.kind === 'guideline')).toHaveLength(1)
  expect(app.calls.filter(call => call.kind === 'material')).toHaveLength(4)
  expect(posted).toEqual([])
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
