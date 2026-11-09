import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientInvestigationCatalogSchema, inpatientInvestigationResponseSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { expect, test, loginPciBrowser } from './inpatient-pci.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

const output = process.env.CLINMESH_CAPTURE_ISSUE400
const before = process.env.CLINMESH_CAPTURE_ISSUE400_PHASE === 'before'

test('住院医生减负实机同病例对比', async ({ page, pciApp: app }) => {
  test.skip(!output, '仅在显式请求实机证据时运行')
  test.setTimeout(180_000)
  const directory = output!
  await mkdir(directory, { recursive: true })
  const fixture = app.fixture
  const stay = await fixture.preparePciAdmission()
  const catalog = await fixture.read('inpatient-doctor', '/api/his/v1/inpatient/investigation-catalog', inpatientInvestigationCatalogSchema)
  // 通过公开 Command 准备临床事实，截图和阅读/弹窗操作始终来自生产 Web。
  for (const item of catalog.items.filter(item => item.id.startsWith('hospital-lab-pci-')).slice(0, 4)) {
    const admission = await fixture.read('inpatient-doctor', stay.path, inpatientDetailSchema)
    const response = await fixture.request('inpatient-doctor', `${stay.path}/investigations/issue`, {
      encounterVersion: admission.admission.versionId, catalogVersion: item.version,
      selection: { kind: 'laboratory', catalogItemId: item.id, indicationCode: 'clinical-assessment' },
    })
    expect(response.status).toBe(200)
    const issued = inpatientInvestigationResponseSchema.parse(await response.json()).data.laboratoryRequests.find(request => request.catalogItemId === item.id)!
    expect((await fixture.request('ward-nurse', `${stay.path}/investigations/send`, {
      requestId: issued.id, expectedRequestVersion: issued.version, serviceRequestVersion: issued.serviceRequestVersion, taskVersion: issued.taskVersion,
    })).status).toBe(200)
  }
  for (let index = 0; index < 100; index += 1) if (await fixture.runtime.dispatcher.dispatchOnce() === undefined) break
  const reported = await fixture.read('inpatient-doctor', `${stay.path}/investigations`, inpatientInvestigationsSchema)
  expect(reported.laboratoryRequests).toHaveLength(4)
  expect(reported.laboratoryRequests.every(request => request.status === 'reported')).toBe(true)
  await fixture.dispensePciMedications(stay, 'preoperative')
  const detail = await fixture.read('inpatient-doctor', stay.path, inpatientDetailSchema)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(`${app.origin}/inpatient`)
  await page.getByLabel('账户邮箱').fill('inpatient-doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(app.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('button', { name: `查看${detail.admission.patientName}`, exact: true }).click()
  const workspace = page.locator('.clinmesh-card-workspace')
  const shoot = async (scene: string, width: number) => {
    await page.evaluate(() => document.fonts.ready)
    await workspace.screenshot({ path: join(directory, `${scene}-${width}-light.png`), animations: 'disabled' })
  }
  const size = async (width: number) => {
    await page.setViewportSize({ width: width === 1101 ? 1600 : 1280, height: 1000 })
    await workspace.evaluate((element, width) => { element.style.width = `${width}px` }, width)
  }
  for (const width of [1101, 826]) {
    await size(width)
    await selectInpatientStage(page, '检查检验')
    await expect(page.getByRole('region', { name: '住院检查检验', exact: true })).toContainText('待阅')
    await shoot('01-reported', width)
  }
  // 逐条点击已阅，让相同事实进入下一阅读状态。
  const investigationPanel = page.getByRole('region', { name: '住院检查检验', exact: true })
  for (let index = 0; index < 4; index += 1) {
    await investigationPanel.getByRole('button', { name: '已阅', exact: true }).first().click()
    await expect(investigationPanel.getByRole('button', { name: '已阅', exact: true })).toHaveCount(3 - index)
  }
  for (const width of [1101, 826]) {
    await size(width)
    await shoot('02-acknowledged', width)
    if (before) {
      const entry = investigationPanel.locator('summary').filter({ hasText: /^查看完整报告$/ }).first()
      await entry.click()
      await shoot('03-full-report', width)
      await entry.click()
    } else {
      await investigationPanel.getByRole('button', { name: '查看全文', exact: true }).first().click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.screenshot({ path: join(directory, `03-full-report-${width}-light.png`), animations: 'disabled' })
      await page.keyboard.press('Escape')
    }
    await selectInpatientStage(page, '诊断医嘱')
    if (before) {
      const entry = page.locator('summary').filter({ hasText: /^执行记录/ })
      await entry.click()
      await shoot('04-executions', width)
      await entry.click()
    } else {
      await page.getByRole('button', { name: /^执行记录/ }).first().click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.screenshot({ path: join(directory, `04-executions-${width}-light.png`), animations: 'disabled' })
      await page.keyboard.press('Escape')
    }
    await selectInpatientStage(page, '手术')
    if (before) await page.locator('summary').filter({ hasText: '新增手术申请' }).click()
    else await page.getByRole('button', { name: /申请手术/ }).first().click()
    const form = before ? workspace : page.getByRole('dialog', { name: /申请手术/ })
    await form.getByLabel('计划手术时间（上海时间）', { exact: true }).fill('2026-08-25T09:00')
    await form.getByLabel('手术申请理由', { exact: true }).fill('合成演示：拟行进一步介入治疗')
    if (before) {
      await shoot('05-new-surgery', width)
      await page.locator('summary').filter({ hasText: '新增手术申请' }).click()
    } else {
      await page.screenshot({ path: join(directory, `05-new-surgery-${width}-light.png`), animations: 'disabled' })
      await page.keyboard.press('Escape')
    }
    await selectInpatientStage(page, '检查检验')
  }
  await fixture.executePci(stay)
  await loginPciBrowser(page, app, 'inpatient-doctor')
  await page.reload()
  await page.getByRole('button', { name: `查看${detail.admission.patientName}`, exact: true }).click()
  await selectInpatientStage(page, '手术')
  for (const width of [1101, 826]) {
    await size(width)
    await shoot('06-postoperative-summary', width)
    if (before) {
      const entry = page.locator('summary').filter({ hasText: /^术后耗材更正与历史/ })
      await entry.click()
      await shoot('07-material-correction', width)
      await entry.click()
    } else {
      await page.getByRole('button', { name: '更正耗材', exact: true }).first().click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.screenshot({ path: join(directory, `07-material-correction-${width}-light.png`), animations: 'disabled' })
      await page.keyboard.press('Escape')
    }
  }
  expect(app.modelCalls).toBe(0)
  expect(errors).toEqual([])
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), phase: before ? 'before' : 'after',
    host: 'standalone Web production build, real HTTP listener and temporary SQLite',
    preparation: 'Public Command fixtures create a synthetic PCI stay, four laboratory reports, three administered medication orders and completed surgery. Reading and modal interactions use production UI.',
    widths: [1101, 826], theme: 'light', locale: 'zh-CN', modelCalls: app.modelCalls,
  }, null, 2)}\n`)
})
