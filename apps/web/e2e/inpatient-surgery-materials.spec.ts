import { selectInpatientStage } from './inpatient-ui.ts'
import { expect, test } from './inpatient-drg.fixture.ts'
import { inpatientSurgerySchema, inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { prepareSurgeryMaterialsPatient, runSurgeryMaterialsJourney, prepareFinalMaterialsPatient, runFinalMaterialsJourney, preparePostoperativeMaterialsPatient, runPostoperativeMaterialsJourney, runPostoperativeRecoveryConflictJourney } from './inpatient-surgery-materials.journey.ts'

test('术后补登记恢复冲突在弹窗显示，保留输入并刷新后成功提交', async ({ page, browserApp }) => {
  const s = await preparePostoperativeMaterialsPatient(page, browserApp)
  await runPostoperativeRecoveryConflictJourney(page, s, () => page.goto(`${browserApp.origin}/inpatient`).then(() => undefined))
})

test('术后补登记漏记球囊、恢复丢失回执并保留更正入口', async ({ page, browserApp }) => {
  const s = await preparePostoperativeMaterialsPatient(page, browserApp)
  await runPostoperativeMaterialsJourney(page, s, () => page.goto(`${browserApp.origin}/inpatient`).then(() => undefined), 'workspace')
})

test('实际手术更新后保留首次待办落点和医生当前手术页签', async ({ page, browserApp }) => {
  const s = await prepareSurgeryMaterialsPatient(page, browserApp)
  await page.goto(`${browserApp.origin}/inpatient`)
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  const stage = page.getByRole('tab', { name: '手术', exact: true })
  await expect(stage).toHaveAttribute('aria-selected', 'true')
  await selectInpatientStage(page, '手术')
  await page.getByRole('button', { name: '整台补录', exact: true }).click()
  const batch = page.getByRole('dialog', { name: '整台补录', exact: true })
  await batch.getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: '00.6600 · 经皮冠状动脉腔内血管成形术[PTCA]', exact: true }).click()
  await batch.getByLabel('补录依据', { exact: true }).fill('合成手术页签更新保持')
  const executed = page.waitForResponse(response => response.url().endsWith(`${s.path}/surgeries/execute`) && response.request().method() === 'POST')
  await batch.getByRole('button', { name: '记录实际手术', exact: true }).click()
  const response = await executed
  expect(response.status()).toBe(200)
  const result = inpatientSurgeryResponseSchema.parse(await response.json()).data
  expect(result.executions).toHaveLength(1)
  const execution = result.executions[0]!
  const price = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(execution.actualProcedure.chargeDefinition.priceFen / 100)
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText(`累计费用 ${price}`)
  await expect(stage).toHaveAttribute('aria-selected', 'true')
  const done = page.getByRole('region', { name: '最终耗材', exact: true })
  await expect(done).toContainText(execution.actualProcedure.coding.code)
  await expect(done).toContainText(execution.actualProcedure.coding.display)
})

test('术中分次耗材、额外使用、更正和完成从真实住院入口提交', async ({ page, browserApp }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const s = await prepareSurgeryMaterialsPatient(page, browserApp)
  await runSurgeryMaterialsJourney(page, s, () => page.goto(`${browserApp.origin}/inpatient`).then(() => undefined))
  expect(errors).toEqual([])
})

test('最终用量在同处减少、归零、新增并明确处理预留，丢回执先恢复', async ({ page, browserApp }) => {
  const s = await prepareFinalMaterialsPatient(page, browserApp)
  await runFinalMaterialsJourney(page, s, () => page.goto(`${browserApp.origin}/inpatient`).then(() => undefined))
})

test('目录同版本计价单位变化拒绝旧确认，保留编辑并展示重新预览的真实依据', async ({ page, browserApp }) => {
  const s = await prepareFinalMaterialsPatient(page, browserApp)
  await page.goto(`${browserApp.origin}/inpatient`)
  await page.getByRole('button', { name: `查看${s.name}`, exact: true }).click()
  await selectInpatientStage(page, "手术")
  await page.getByRole('button', { name: '核实最终耗材并完成手术', exact: true }).click()
  const review = page.getByRole('dialog', { name: '核实最终耗材并完成手术', exact: true })
  await review.getByRole('button', { name: '新增最终耗材', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '选择最终耗材', exact: true })
  await picker.getByLabel('搜索耗材', { exact: true }).fill('合成演示缝合材料')
  await picker.getByRole('button', { name: '加入合成演示缝合材料', exact: true }).click()
  await picker.getByRole('button', { name: '完成选择', exact: true }).click()
  await review.getByLabel('核实说明', { exact: true }).fill('合成同版本目录计价单位重新核实')
  await page.getByRole('button', { name: '预览本次差额', exact: true }).click()
  await expect(review).toContainText('¥20.00/包')
  await expect(review.getByRole('region', { name: '本次差额', exact: true })).toContainText('合成演示缝合材料 补登 1 包')
  browserApp.runtime.database.driver.exec("UPDATE inpatient_surgery_catalog SET snapshot_json=json_set(snapshot_json,'$.chargeDefinition.unit','盒') WHERE item_id='hospital-material-suture'")
  await page.getByRole('button', { name: '确认完成手术', exact: true }).click()
  await expect(review).toContainText('核实依据已变化，请重新预览差额后确认')
  await expect(page.getByRole('button', { name: '确认完成手术', exact: true })).toHaveCount(0)
  expect(inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json()).executions).toEqual([])
  await review.getByRole('button', { name: '刷新核实依据，保留编辑', exact: true }).click()
  await expect(review.getByLabel('合成演示缝合材料 · 最终总量 4', { exact: true })).toHaveValue('1')
  await page.getByRole('button', { name: '预览本次差额', exact: true }).click()
  await expect(review).toContainText('¥20.00/盒')
  await expect(review.getByRole('region', { name: '本次差额', exact: true })).toContainText('合成演示缝合材料 补登 1 盒')
  await expect(review).toContainText('计价依据已变化，请按本次预览的单价及单位重新核实数量。')
  await expect(page.getByRole('button', { name: '确认完成手术', exact: true })).toBeEnabled()
})
