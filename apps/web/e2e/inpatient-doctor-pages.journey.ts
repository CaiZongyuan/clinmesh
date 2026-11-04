import type { Locator, Page } from '@playwright/test'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientSurgeryCatalogSchema } from '@clinmesh/contracts/inpatient-surgery'
import { archiveDrgBrowserPatient, createDrgBrowserPatient, expect } from './inpatient-drg.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

async function expectBefore(first: Locator, second: Locator) {
  await expect(first).toBeVisible()
  await expect(second).toBeVisible()
  expect(await first.evaluate((node, other) => other !== null && Boolean(node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING), await second.elementHandle())).toBe(true)
}

/** 六页正文分别验收；共享外框或默认页截图不代替这些断言。 */
export async function runInpatientDoctorPages(page: Page, app: { origin: string; password: string }, options: {
  mount(role?: string): Promise<void>; appearance(theme: 'light' | 'dark'): Promise<void>; capture?(name: string): Promise<void>
}) {
  const subject = await createDrgBrowserPatient(page, app, '合成六页住院医生患者')
  const settled = options.capture ? await createDrgBrowserPatient(page, app, '合成代表病案患者', 'bed-general-2') : undefined
  if (settled) await archiveDrgBrowserPatient(settled)
  await subject.api.login('inpatient-doctor')
  const catalog = inpatientSurgeryCatalogSchema.parse(await (await subject.api.get('/api/his/v1/inpatient/surgery-catalog')).json())
  const procedure = catalog.procedures.find(item => item.coding.code === '00.6600')!
  const clinical = () => subject.api.get(`${subject.path}/clinical`).then(response => response.json()).then(value => inpatientFullClinicalSchema.parse(value))
  expect((await subject.api.post(`${subject.path}/surgeries/request`, { encounterVersion: (await clinical()).encounterVersion,
    procedureId: procedure.id, catalogVersion: procedure.version, plannedFor: '2026-08-24T15:00:00+08:00', reason: '合成六页结构验收计划' })).status()).toBe(200)
  expect((await subject.api.post(`${subject.path}/orders/issue`, { encounterVersion: (await clinical()).encounterVersion, duration: 'temporary',
    selection: { kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1, doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' } })).status()).toBe(200)
  await page.setViewportSize({ width: 1600, height: 1000 })
  await options.mount()
  await page.getByRole('button', { name: `查看${subject.name}`, exact: true }).click()
  const workspace = page.locator('.clinmesh-card-workspace')
  for (const stage of ['诊断医嘱', '检查检验', '手术', 'DRG 预分组', '出院', '病案']) {
    await selectInpatientStage(page, stage)
    const panel = page.getByRole('tabpanel', { name: stage, exact: true })
    if (stage === '诊断医嘱') {
      await expectBefore(panel.getByRole('region', { name: '住院诊断摘要', exact: true }), panel.getByRole('region', { name: '住院医嘱', exact: true }))
      await expectBefore(panel.getByRole('region', { name: '住院医嘱', exact: true }), panel.getByRole('region', { name: '开立医嘱', exact: true }))
      const editor = page.getByRole('dialog', { name: '修改住院诊断', exact: true })
      await expect(editor).toHaveCount(0)
      await panel.getByRole('button', { name: '修改诊断', exact: true }).click()
      await editor.getByLabel('搜索诊断名称或编码', { exact: true }).fill('合成未提交检索')
      await editor.getByRole('button', { name: '取消', exact: true }).click()
      await expect(editor).toHaveCount(0)
      await panel.getByRole('button', { name: '修改诊断', exact: true }).click()
      await expect(editor.getByLabel('搜索诊断名称或编码', { exact: true })).toHaveValue('合成未提交检索')
      await editor.getByRole('button', { name: '取消', exact: true }).click()
    } else if (stage === '检查检验') {
      await expectBefore(panel.getByText('暂无检查检验申请', { exact: true }), panel.getByRole('button', { name: '开立住院检查', exact: true }))
      const composer = page.getByRole('dialog', { name: '开立住院检查', exact: true })
      await expect(composer).toHaveCount(0)
      await panel.getByRole('button', { name: '开立住院检查', exact: true }).click()
      await expect(composer.getByLabel('搜索检查检验目录', { exact: true })).toBeVisible()
      await composer.getByRole('button', { name: '取消', exact: true }).click()
      await expect(composer).toHaveCount(0)
    } else if (stage === '手术') {
      await expectBefore(panel.getByRole('region', { name: '当前手术计划', exact: true }), panel.getByRole('region', { name: '开始手术还差', exact: true }))
      await expect(panel.getByRole('region', { name: '开始手术还差', exact: true })).toContainText('病区护士')
      await expect(panel.getByRole('region', { name: '开始手术还差', exact: true })).toContainText('住院医生')
      await expect(panel.getByLabel('计划术式', { exact: true })).toBeHidden()
      await panel.locator('summary').filter({ hasText: '新增手术申请' }).click()
      await expect(panel.getByLabel('计划术式', { exact: true })).toBeVisible()
      await panel.locator('summary').filter({ hasText: '新增手术申请' }).click()
      await expect(page.getByRole('button', { name: '开始手术逐笔登记', exact: true })).toBeDisabled()
    } else if (stage === 'DRG 预分组') {
      const monitor = panel.getByRole('region', { name: '费用与支付参考', exact: true })
      const mix = panel.getByRole('region', { name: '已发生收费构成', exact: true })
      await expectBefore(monitor, mix)
      await expectBefore(mix, panel.getByRole('region', { name: '分组记录核对', exact: true }))
      await expect(monitor).toContainText('RA15')
      await expect(panel.getByRole('region', { name: '做完计划手术后', exact: true })).toContainText('RA25')
      await expect(panel.getByTestId('drg-charges')).toBeVisible()
    } else if (stage === '出院') {
      await expect(panel.getByRole('region', { name: '出院办理状态', exact: true })).toHaveCount(0)
      await expect(panel.getByLabel('出院处理说明', { exact: true })).toBeVisible()
      await expect(panel.getByLabel('离院方式', { exact: true })).toHaveCount(0)
      await panel.getByLabel('出院处理说明', { exact: true }).fill('合成出院说明草稿')
      await expect(page.getByRole('button', { name: '开出院医嘱', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '开出院医嘱', exact: true })).toBeDisabled()
      await expect(panel.getByRole('region', { name: '开出院医嘱前', exact: true })).toContainText('1 项手术申请尚未实施或取消')
      await expect(panel.getByRole('region', { name: '开出院医嘱前', exact: true })).toContainText('在用医嘱')
      await panel.getByRole('button', { name: '去手术', exact: true }).click()
      await expect(page.getByRole('tab', { name: '手术', exact: true })).toHaveAttribute('aria-selected', 'true')
      await selectInpatientStage(page, '出院')
      await expect(panel.getByLabel('出院处理说明', { exact: true })).toHaveValue('合成出院说明草稿')
    } else {
      await expect(panel.getByRole('region', { name: '提交首页前', exact: true })).toContainText('离院信息')
      await expect(panel.getByText('查看病案核心字段', { exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '提交病案首页', exact: true })).toBeDisabled()
      await expect(page.getByRole('region', { name: '当前操作', exact: true })).toContainText('出院结算后才能提交')
    }
    for (const width of [1101, 826]) for (const theme of ['light', 'dark'] as const) {
      await workspace.evaluate((element, width) => { element.style.width = `${width}px` }, width)
      await options.appearance(theme)
      await expect.poll(() => workspace.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      expect(await panel.locator('button:visible').evaluateAll(elements => elements.filter(element => element.scrollWidth - element.clientWidth > 1).map(element => element.textContent))).toEqual([])
      if (width === 1101 && theme === 'light' && options.capture) {
        await panel.evaluate(element => { element.scrollTop = 0 })
        await options.capture(`doctor-${stage}`)
      }
    }
  }
  await selectInpatientStage(page, '出院')
  await expect(page.getByLabel('出院处理说明', { exact: true })).toHaveValue('合成出院说明草稿')
  await subject.api.login('ward-nurse')
  await options.mount()
  await page.getByRole('button', { name: `1床 ${subject.name}`, exact: true }).click()
  await selectInpatientStage(page, '诊断医嘱')
  const nurseOrders = page.getByRole('tab', { name: '诊断医嘱', exact: true })
  await expect(nurseOrders.getByText('1', { exact: true })).toBeVisible()
  const action = page.getByRole('region', { name: '当前操作', exact: true })
  await expect(action).toContainText('还差 1 条医嘱待校对')
  if (options.capture) {
    await workspace.evaluate(element => { element.style.width = '1101px' })
    await options.appearance('light')
    await options.capture('nurse-校对底栏')
  }
  await action.getByRole('button', { name: '校对下一条医嘱', exact: true }).click()
  await expect(action).toContainText('本次医嘱校对已完成')
  await expect(nurseOrders.getByText('1', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('停嘱或按需执行理由', { exact: true })).toHaveCount(0)
  if (settled && options.capture) for (const role of ['cashier', 'medical-records', 'medical-insurance']) {
    await subject.api.login(role)
    await options.mount(role)
    if (role === 'medical-insurance') await expect(page.getByRole('heading', { name: '归档时的分组与费用', exact: true })).toBeVisible()
    else {
      await page.getByRole('button', { name: `查看${settled.name}`, exact: true }).click()
      await selectInpatientStage(page, role === 'cashier' ? '出院' : '病案')
      if (role === 'cashier') await expect(page.locator('summary').filter({ hasText: /^发起财务更正$/ })).toBeVisible()
      else {
        const groupingReview = page.getByRole('region', { name: '病案 DRG 分组复核', exact: true })
        await expect(groupingReview).toContainText('RA15')
        await expectBefore(groupingReview, page.getByRole('region', { name: '患者基本信息', exact: true }))
        await expect(page.getByRole('region', { name: '术后核查与责任交接', exact: true })).toHaveCount(0)
      }
    }
    await workspace.evaluate(element => { element.style.width = '1101px' })
    await options.appearance('light')
    await options.capture(role)
  }
}
