import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { addSecondaryInpatientWard } from '../../server/tests/fixtures/inpatient-secondary-ward.ts'
import { test, expect, createDrgBrowserPatient } from './inpatient-drg.fixture.ts'
import { prepareSurgeryMaterialsPatient } from './inpatient-surgery-materials.journey.ts'

test('同一手术开始后只计一项待办，医生直接落到手术环节', async ({ page, browserApp }) => {
  const subject = await prepareSurgeryMaterialsPatient(page, browserApp)
  const before = inpatientSurgerySchema.parse(await (await subject.api.get(`${subject.path}/surgeries`)).json())
  const request = before.requests[0]!
  expect((await subject.api.post(`${subject.path}/surgeries/start`, { requestId: request.id, expectedRequestVersion: request.version,
    procedureId: 'hospital-surgery-1', catalogVersion: 1, note: '合成术中待办核对' })).status()).toBe(200)
  await page.goto(`${browserApp.origin}/inpatient`)
  await page.getByRole('button', { name: `查看${subject.name}`, exact: true }).click()
  const surgery = page.getByRole('tab', { name: '手术', exact: true })
  await expect(surgery).toHaveAttribute('aria-selected', 'true')
  await expect(surgery).toHaveAccessibleDescription(/待办 1 项/)
  await expect(page.getByRole('heading', { name: /手术进行中/ })).toBeVisible()
  const action = page.getByRole('region', { name: '当前操作', exact: true })
  await expect(action.getByRole('button', { name: '核实最终耗材并完成手术', exact: true })).toBeVisible()
  await action.getByRole('button', { name: '核实最终耗材并完成手术', exact: true }).click()
  await page.getByLabel('最终用量核实依据', { exact: true }).fill('合成术中主操作核对')
  await expect(action.getByRole('button', { name: '预览本次差额', exact: true })).toBeEnabled()
  expect(inpatientSurgerySchema.parse(await (await subject.api.get(`${subject.path}/surgeries`)).json()).executions).toEqual([])
})

test('多病区待交接是护士待办，打开患者直接落到转科环节', async ({ page, browserApp }) => {
  await addSecondaryInpatientWard(browserApp.runtime)
  const subject = await createDrgBrowserPatient(page, browserApp, '合成转科待办患者')
  const admission = inpatientDetailSchema.parse(await (await subject.api.get(subject.path)).json()).admission
  expect((await subject.api.post(`${subject.path}/transfers/request`, { encounterVersion: admission.versionId,
    targetWardId: 'ward-surgery', reason: '合成多病区交接核对' })).status()).toBe(200)
  await subject.api.login('ward-nurse')
  await page.goto(`${browserApp.origin}/inpatient`)
  const bed = page.getByRole('button', { name: new RegExp(`1床 ${subject.name}`) })
  await expect(bed).toContainText('轮到你 1 项')
  await bed.click()
  const transfer = page.getByRole('tab', { name: '转科交接', exact: true })
  await expect(transfer).toHaveAttribute('aria-selected', 'true')
  await expect(transfer).toHaveAccessibleDescription(/待办 1 项/)
  await expect(page.getByRole('button', { name: '完成原科交接', exact: true })).toBeVisible()
})
