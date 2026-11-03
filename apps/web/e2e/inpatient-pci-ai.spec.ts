import { inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientGuidelineAdviceListSchema } from '@clinmesh/contracts/inpatient-guideline-advice'
import { inpatientAngiographyReportsSchema } from '@clinmesh/contracts/inpatient-angiography'
import { expect, openPciAiPatient, pciAiGuidelineDocuments, pciAiQuotes, preparePciAiPatient, test } from './inpatient-pci-ai.fixture.ts'
import { capturePciAiReviewLayouts, preparePciAiPlan, preparePciAiReview, requestPciAiSurgery, runPciAiConfirmHandoffJourney, runPciAiFrozenJourney, runPciAiJourney, runPciAiMenuFocusJourney, runPciAiMissingUnitJourney, runPciAiSaveConcurrencyJourney } from './inpatient-pci-ai.journey.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

test('正式造影报告带入PCI草稿，同屏审阅指南与费用后一次确认，术中规则费用和术后差异无需跟进', async ({ page, pciAiApp }) => {
  await runPciAiJourney(page, pciAiApp)
})

test('PCI确认已落库但回执未完成时先等待再切换岗位', async ({ page, pciAiApp }) => {
  await runPciAiConfirmHandoffJourney(page, pciAiApp)
})

test('PCI新增审阅区在1101和826及760容器宽度的浅深主题无溢出且确认条可用', async ({ page, pciAiApp: app }) => {
  const { panel } = await preparePciAiReview(page, app)
  const calls = [...app.calls]
  const layouts = await capturePciAiReviewLayouts(page, panel)
  expect(layouts).toHaveLength(6)
  expect(app.calls).toEqual(calls)
})

test('后台核对期间用户菜单保留焦点，Escape只关闭菜单而不取消PCI确认', async ({ page, pciAiApp }) => {
  await runPciAiMenuFocusJourney(page, pciAiApp)
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
  await runPciAiMissingUnitJourney(page, app)
})

test('30mm超出合成范围时具体清单不可确认，指南重评仅保留有条件类别与测量原句', async ({ page, pciAiApp: app }) => {
  const { stay, planned, panel, selection } = await preparePciAiReview(page, app)
  const parameters = panel.getByRole('region', { name: '报告带入的 PCI 参数', exact: true })
  const guide = page.getByRole('region', { name: '指南参考意见', exact: true })
  await parameters.getByLabel('病变长度 数值', { exact: true }).fill('30')
  await panel.getByRole('button', { name: '保存选型参数', exact: true }).click()
  await expect(panel.getByRole('alert').filter({ hasText: '测量不在已核验仿真范围' })).toBeVisible()
  await expect(page.getByRole('button', { name: '确认选型、清单与预留', exact: true })).toBeDisabled()
  await guide.getByRole('button', { name: '按当前依据重新评估指南', exact: true }).click()
  const read = async () => (await app.fixture.read('inpatient-doctor', `${stay.path}/guideline-advice`, inpatientGuidelineAdviceListSchema)).advice.find(item => item.requestId === planned.id)!
  await expect.poll(async () => (await read()).status).toBe('incomplete')
  await expect(guide).toContainText('缺少本计划适用的具体耗材候选')
  await expect(guide.getByText('有条件的参考', { exact: true })).toHaveCount(3)
  await guide.getByText('查看尺寸与测量要求依据', { exact: true }).click()
  for (const quote of pciAiQuotes[2]) await expect(guide.getByRole('group', { name: '尺寸与测量要求依据', exact: true })).toContainText(quote)
  const state = await read()
  expect(state.result?.conclusions.every(item => item.applicability === 'conditional')).toBe(true)
  expect(state.result?.conclusions.map(item => item.text).join('\n')).not.toMatch(/hospital-material|每类[一1]|固定[一1]|必须.*[一1][件枚根]/)
  const draft = (await selection()).drafts!.find(item => item.requestId === planned.id)!
  expect(draft.parameters.measurements.find(item => item.kind === 'lesion-length')).toMatchObject({ value: 30, unit: 'mm' })
  const report = (await app.fixture.read('inpatient-doctor', `${stay.path}/angiography-reports`, inpatientAngiographyReportsSchema)).reports.find(item => item.id === draft.reportId)!
  expect(report.measurements.find(item => item.kind === 'lesion-length')).toMatchObject({ value: 12, unit: 'mm' })
  await panel.getByRole('checkbox', { name: '已核对选型参数、材料、数量、费用、依据及原预留处理', exact: true }).check()
  await expect(page.getByRole('button', { name: '确认选型、清单与预留', exact: true })).toBeDisabled()
  expect((await selection()).confirmation).toBeNull()
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

test('护士只读审阅保留正式测量清单与费用，不开放编辑确认或产生业务写入', async ({ page, pciAiApp: app }) => {
  const { stay, planned, panel } = await preparePciAiReview(page, app)
  const before = (await app.fixture.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates.find(item => item.requestId === planned.id)!
  const calls = [...app.calls], posts: string[] = []
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith(stay.path)) posts.push(request.url()) })
  await openPciAiPatient(page, app, 'ward-nurse', stay.patientName)
  await selectInpatientStage(page, '手术')
  await expect(panel).toContainText('当前岗位或病案状态只允许查看。')
  const measurement = panel.getByRole('region', { name: '报告带入的 PCI 参数', exact: true }).getByLabel('病变长度 数值', { exact: true })
  await expect(measurement).toHaveValue('12')
  await expect(measurement).toBeDisabled()
  await expect(panel.getByRole('textbox', { name: '耗材清单说明', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '确认选型、清单与预留', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('region', { name: '住院费用与医保参考', exact: true })).toContainText('预计住院总费用')
  await expect(page.getByRole('region', { name: '指南参考意见', exact: true })).toHaveCount(0)
  const after = (await app.fixture.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates.find(item => item.requestId === planned.id)!
  expect(after.draft).toEqual(before.draft)
  expect(posts).toEqual([])
  expect(app.calls).toEqual(calls)
})

test('医生开始手术后同计划指南保留原句历史只读，不能重评或确认术前清单', async ({ page, pciAiApp: app }) => {
  await runPciAiFrozenJourney(page, app)
})

test('清单自动保存期间继续输入不锁卡或交接，晚到回执保留新说明及最新元数据后仍可一次确认', async ({ page, pciAiApp: app }) => {
  await runPciAiSaveConcurrencyJourney(page, app)
})
