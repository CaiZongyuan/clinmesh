import { expect, test } from './inpatient-drg.fixture.ts'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { prepareSurgeryMaterialsPatient, runSurgeryMaterialsJourney, prepareFinalMaterialsPatient, runFinalMaterialsJourney } from './inpatient-surgery-materials.journey.ts'

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
  await page.getByRole('tab', { name: '手术', exact: true }).click()
  await page.getByRole('button', { name: '核实最终耗材并完成手术', exact: true }).click()
  const review = page.getByRole('region', { name: '核实最终耗材', exact: true })
  await review.getByLabel('新增最终耗材', { exact: true }).click()
  await page.getByRole('option', { name: '合成演示缝合材料', exact: true }).click()
  await review.getByLabel('最终用量核实依据', { exact: true }).fill('合成同版本目录计价单位重新核实')
  await review.getByRole('button', { name: '预览本次差额', exact: true }).click()
  await expect(review).toContainText('本次确认计价依据 · hospital-material-suture · v1 · ¥20.00/包')
  browserApp.runtime.database.driver.exec("UPDATE inpatient_surgery_catalog SET snapshot_json=json_set(snapshot_json,'$.chargeDefinition.unit','盒') WHERE item_id='hospital-material-suture'")
  await review.getByRole('button', { name: '确认完成本次手术', exact: true }).click()
  await expect(review).toContainText('核实依据已变化，请重新预览差额后确认')
  await expect(review.getByRole('button', { name: '确认完成本次手术', exact: true })).toHaveCount(0)
  expect(inpatientSurgerySchema.parse(await (await s.api.get(`${s.path}/surgeries`)).json()).executions).toEqual([])
  await review.getByRole('button', { name: '刷新核实依据，保留编辑', exact: true }).click()
  await expect(review.getByLabel('合成演示缝合材料 · 最终总量 4', { exact: true })).toHaveValue('1')
  await review.getByRole('button', { name: '预览本次差额', exact: true }).click()
  await expect(review).toContainText('本次确认计价依据 · hospital-material-suture · v1 · ¥20.00/盒')
  await expect(review).toContainText('计价依据已变化，请按本次预览的单价及单位重新核实数量。')
  await expect(review.getByRole('button', { name: '确认完成本次手术', exact: true })).toBeEnabled()
})
