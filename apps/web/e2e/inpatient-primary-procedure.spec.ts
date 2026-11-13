import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientDrgPregroupResultSchema } from '@clinmesh/contracts/inpatient-drg'
import { expect, test, loginPciBrowser } from './inpatient-pci.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

test('在院保存主操作后预分组生效，刷新保留且可重新选择，首页提交仍受结算门禁保护', async ({ page, pciApp: app }) => {
  test.setTimeout(120_000)
  const s = app.fixture
  const stay = await s.preparePciAdmission()
  await s.completePciLaboratories(stay)
  const angiography = await s.executeAngiography(stay)
  const pci = await s.executePci(stay)
  const readRecord = () => s.read('inpatient-doctor', `${stay.path}/record`, inpatientRecordSchema)
  const readGrouping = () => s.read('inpatient-doctor', `${stay.path}/drg/pregroup`, inpatientDrgPregroupResultSchema)
  const before = await readRecord()
  expect((await readGrouping()).result).toMatchObject({ status: 'invalid-input', reason: '存在操作但缺少主操作标记' })
  await loginPciBrowser(page, app, 'inpatient-doctor')
  await page.goto(`${app.origin}/inpatient`)
  await page.getByRole('button', { name: new RegExp(before.snapshot.patient.name) }).click()
  await selectInpatientStage(page, '病案')
  const save = page.getByRole('button', { name: '保存主操作，更新预分组', exact: true })
  await expect(save).toBeDisabled()
  const choose = async (code: string, id: string, group: string) => {
    await page.getByRole('radio', { name: new RegExp(`^${code.replace('.', '\\.')}`) }).check()
    // 本地勾选并不改变正式事实。
    expect((await readRecord()).snapshot.clinical.mainProcedureExecutionId).not.toBe(id)
    await save.click()
    await expect.poll(async () => (await readRecord()).snapshot.clinical.mainProcedureExecutionId).toBe(id)
    expect((await readGrouping()).result).toMatchObject({ status: 'grouped', drgCode: group })
    await expect(save).toBeDisabled()
  }
  await choose('36.0700', pci.id, 'FM39')
  await page.reload()
  await page.getByRole('button', { name: new RegExp(before.snapshot.patient.name) }).click()
  await selectInpatientStage(page, '病案')
  await expect(page.getByRole('radio', { name: /^36\.0700/ })).toBeChecked()
  await choose('88.5500', angiography.id, 'FM59')
  await choose('36.0700', pci.id, 'FM39')
  expect((await readRecord()).revision?.revision).toBe((before.revision?.revision ?? 0) + 3)
  await expect(page.getByRole('button', { name: /提交病案首页/ })).toBeDisabled()
  await selectInpatientStage(page, 'DRG 预分组')
  const summary = page.getByRole('region', { name: '费用与支付参考', exact: true })
  await expect(summary).toContainText('FM39')
  await expect(summary).toContainText('¥12,000.00')
  await s.depart(stay)
  await page.reload()
  await page.getByRole('button', { name: new RegExp(before.snapshot.patient.name) }).click()
  await selectInpatientStage(page, '病案')
  await expect(save).toHaveCount(0)
  await expect(page.getByRole('button', { name: /提交病案首页/ })).toBeDisabled()
  const departed = await readRecord()
  expect(departed.revision?.sourcesHash).not.toBe(departed.sourcesHash)
  expect(app.modelCalls).toBe(0)
})
