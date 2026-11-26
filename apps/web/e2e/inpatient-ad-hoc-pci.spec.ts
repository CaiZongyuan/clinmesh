import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { scenarioStateSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalResponseSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientPciDataResponseSchema, pciCaseSourceResponseSchema, startSyntheticInpatientCaseResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { parsePciResponse } from '../../server/tests/fixtures/pci-payment-drg.ts'
import { expect, loginPciBrowser, test, type PciBrowserApp } from './inpatient-pci.fixture.ts'
import { openInpatientDrgTools, selectInpatientStage } from './inpatient-ui.ts'

async function prepareStandbyCagThroughPages(page: Page, app: PciBrowserApp, reason: string) {
  const s = app.fixture
  const scenario = await s.read('admin', '/api/sim/v1/scenario-runs/current', scenarioStateSchema)
  await parsePciResponse(
    inpatientPciDataResponseSchema,
    await s.request('admin', '/api/his/v1/inpatient/pci-data/prepare', { expectedEpoch: scenario.epoch }),
  )
  const source = (
    await parsePciResponse(
      pciCaseSourceResponseSchema,
      await s.request('admin', '/api/sim/v1/synthetic-cases/pci/prepare', { expectedEpoch: scenario.epoch }),
    )
  ).data
  const registrarCookie = await s.login('registrar')
  const startRes = await s.runtime.app.request(
    `/api/his/v1/synthetic-cases/${source.case.caseId}/actions/start-inpatient-visit`,
    {
      method: 'POST',
      headers: {
        cookie: registrarCookie,
        origin: 'http://localhost',
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        activeBriefRevision: source.case.activeBriefRevision,
        expectedCaseRevision: source.case.revision,
        expectedEpoch: scenario.epoch,
        wardId: 'ward-general',
      }),
    },
  )
  const started = (await parsePciResponse(startSyntheticInpatientCaseResponseSchema, startRes)).data
  const path = `/api/his/v1/inpatient/admissions/${started.admissionId}`
  const registered = await s.read('registrar', path, inpatientDetailSchema)
  const admission = (
    await parsePciResponse(
      inpatientCommandResponseSchema,
      await s.request('ward-nurse', `${path}/receive`, {
        encounterVersion: registered.admission.versionId,
        bedId: 'bed-general-1',
      }),
    )
  ).data.admission
  await parsePciResponse(
    inpatientFullClinicalResponseSchema,
    await s.request('inpatient-doctor', `${path}/diagnoses/confirm`, {
      encounterVersion: admission.versionId,
      expectedRevision: 0,
      entries: [
        {
          catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I25.103',
          role: 'primary',
          admissionCondition: '1',
          note: '本院确认冠心病（同台造影转 PCI 浏览器验收）',
        },
      ],
    }),
  )
  const catalog = await s.read('inpatient-doctor', '/api/his/v1/inpatient/surgery-catalog', inpatientSurgeryCatalogSchema)
  const angioProc = catalog.procedures.find(item => item.coding.code === '88.5500')!
  const pciProc = catalog.procedures.find(item => item.coding.code === '36.0700')!

  const open = async (role: string) => {
    await loginPciBrowser(page, app, role)
    await page.goto(`${app.origin}/inpatient`)
    await page.getByRole('button', { name: new RegExp(admission.patientName) }).click()
  }

  // 1. 住院医生开立单份带 standbyAdHocPci 勾选的冠脉造影申请并确认造影导管预留
  await open('inpatient-doctor')
  await selectInpatientStage(page, '手术')
  await page.getByRole('button', { name: '申请手术', exact: true }).first().click()
  const reqDialog = page.getByRole('dialog', { name: '申请手术', exact: true })
  await reqDialog.getByLabel('计划术式', { exact: true }).click()
  await page.getByRole('option', { name: `${angioProc.coding.code} · ${angioProc.coding.display}`, exact: true }).click()
  const standbyBox = reqDialog.getByRole('checkbox', { name: /备选同台介入治疗/ })
  await expect(standbyBox).toBeVisible()
  await standbyBox.check()
  await reqDialog.getByLabel('计划手术时间', { exact: true }).fill('2026-08-24T15:00')
  await reqDialog.getByLabel('手术申请理由', { exact: true }).fill(reason)
  await reqDialog.getByRole('button', { name: '提交手术申请', exact: true }).click()
  await expect(page.getByRole('region', { name: '住院手术', exact: true })).toContainText('必要时同台转行 PCI')
  await s.runtime.dispatchPending()
  const cagMaterials = page.getByRole('region', { name: '手术耗材', exact: true })
  await expect(cagMaterials.getByRole('button', { name: '取消本次预计', exact: true })).toHaveCount(0)
  await expect(cagMaterials).toContainText('助手这次未能预填耗材')
  await cagMaterials.getByRole('spinbutton', { name: '预计数量：合成演示导管', exact: true }).fill('1')
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认手术耗材', exact: true }).click()
  await expect(cagMaterials).toContainText('你 · 已确认')

  // 2. 病区护士完成唯一一次术前核对
  await open('ward-nurse')
  await selectInpatientStage(page, '手术')
  await page.getByLabel('术前核对说明', { exact: true }).fill('同台造影及备选 PCI 术前核对完成')
  await page.getByRole('button', { name: '术前核对', exact: true }).click()
  await expect.poll(async () => (await s.read('ward-nurse', `${path}/surgeries`, inpatientSurgerySchema)).requests[0]?.preopCheck !== undefined).toBe(true)

  // 3. 住院医生签署唯一一次联合知情同意书
  await open('inpatient-doctor')
  await selectInpatientStage(page, '手术')
  await page.getByRole('button', { name: '确认已签', exact: true }).click()
  const consentDialog = page.getByRole('dialog', { name: '手术知情同意书', exact: true })
  await expect(
    consentDialog.getByRole('article', {
      name: '冠状动脉造影及必要时同台经皮冠状动脉介入治疗（PCI）知情同意书',
      exact: true,
    }),
  ).toBeVisible()
  await consentDialog.getByLabel('签署备注', { exact: true }).fill('联合知情同意书已签署')
  await consentDialog.getByRole('button', { name: '确认手术知情同意书已签', exact: true }).click()
  await expect(page.getByRole('region', { name: '住院手术', exact: true })).toContainText('已就绪')

  // 4. 阶段 1：实施冠脉造影（带对比剂与抗凝套餐），进入 standby-pci 待同台决策
  await page.getByRole('button', { name: '整台补录', exact: true }).click()
  const batch = page.getByRole('dialog', { name: '整台补录', exact: true })
  await batch.getByRole('button', { name: /冠脉造影\/PCI 对比剂与抗凝套餐/ }).click()
  await batch.getByLabel('补录依据', { exact: true }).fill('同台冠脉造影完成，导管留待后续核对')
  await batch.getByRole('button', { name: '记录实际手术', exact: true }).click()

  return { s, path, admission, angioProc, pciProc }
}

test('同台冠脉造影直接转 PCI（Ad-hoc PCI）：单申请联合同意书、免二次核对、单次专科护理计费与显式主操作 FM39', async ({ page, pciApp: app }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  const writes: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (['POST', 'PUT'].includes(request.method())) writes.push(new URL(request.url()).pathname)
  })

  const { s, path, pciProc } = await prepareStandbyCagThroughPages(page, app, '同台造影备选 PCI 验收申请')

  const decisionCard = page.getByRole('region', { name: '待同台决策', exact: true })
  await expect(decisionCard).toBeVisible()
  const convertBtn = page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '同台转行 PCI', exact: true })
  await expect(convertBtn).toBeDisabled()

  // 5. 派发确定性造影报告 -> 解锁并点击「同台转行 PCI」
  await s.runtime.dispatchPending()
  await expect(convertBtn).toBeEnabled({ timeout: 15_000 })
  await decisionCard.getByLabel('决策说明（选填）', { exact: true }).fill('LAD 近段 90% 狭窄，同台转行支架置入')
  await convertBtn.click()

  // 6. 已转同台 PCI：免二次知情同意与核对 -> 确认选型参数与 4 项 PCI 耗材预留
  const surgeryRegion = page.getByRole('region', { name: '住院手术', exact: true })
  await expect(surgeryRegion).toContainText('同台转 PCI · 已免二次核对与知情同意')
  await s.runtime.dispatchPending()
  await expect(page.getByRole('region', { name: '选型参数', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '确认选型参数', exact: true }).click()
  const stepTwo = page.getByRole('region', { name: '手术耗材', exact: true })
  await expect(stepTwo).toBeVisible()
  await expect(stepTwo.getByRole('button', { name: '取消本次预计', exact: true })).toHaveCount(0)
  await expect(stepTwo).toContainText('助手这次未能预填耗材')
  const qtyInputs = stepTwo.getByRole('spinbutton', { name: /^预计数量：/ })
  await expect(qtyInputs).toHaveCount(4)
  for (const input of await qtyInputs.all()) {
    await input.fill('1')
  }
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认手术耗材', exact: true }).click()
  await expect(stepTwo).toContainText('已为本计划预留')

  // 7. 阶段 2：直接开始同台 PCI -> 逐笔登记 4 项预留耗材 -> 核实完成并验证单次专科护理不重复计收
  await page.getByRole('button', { name: '开始同台 PCI', exact: true }).click()
  const startDialog = page.getByRole('dialog', { name: '开始手术', exact: true })
  await startDialog.getByRole('button', { name: '开始手术', exact: true }).click()
  const intraopTable = page.getByRole('table', { name: '术中耗材按行登记', exact: true })
  await expect(intraopTable).toBeVisible()
  for (let i = 0; i < 4; i += 1) {
    const useBtn = intraopTable.getByRole('button', { name: /^用 1 / }).first()
    await expect(useBtn).toBeVisible()
    await useBtn.click()
    await expect.poll(async () => (await s.read('inpatient-doctor', `${path}/surgeries`, inpatientSurgerySchema)).inProgress[0]?.materials.length).toBe(i + 1)
  }

  await page.getByRole('button', { name: '核实最终耗材并完成手术', exact: true }).click()
  const completeDialog = page.getByRole('dialog', { name: '核实最终耗材并完成手术', exact: true })
  await expect(completeDialog).toContainText('已包含于同台造影阶段，不重复计收')
  await completeDialog.getByRole('button', { name: '确认完成手术', exact: true }).click()

  // 8. 完成后验证单次专科护理行、显式「确认 36.0700 为在院主操作」按钮与 FM39 预分组
  const finalCard = page.getByRole('region', { name: '最终耗材', exact: true })
  await expect(finalCard).toContainText(pciProc.coding.code)
  await expect(finalCard).toContainText('同台转 PCI')
  await expect(finalCard).toContainText('已包含于同台造影阶段，不重复计收')
  const confirmPrimaryBtn = finalCard.getByRole('button', { name: '确认 36.0700 为在院主操作', exact: true })
  await expect(confirmPrimaryBtn).toBeVisible()
  await confirmPrimaryBtn.click()
  await expect(finalCard).toContainText('已确认为在院主操作')

  await selectInpatientStage(page, 'DRG 预分组')
  await openInpatientDrgTools(page)
  await expect(page.getByRole('region', { name: '费用与支付参考', exact: true })).toContainText('FM39')

  // 9. 验证病案页折叠区展示单份联合通知单与双阶段操作，且全院仅计收 1 笔术中介入专科护理费（80 元）
  await selectInpatientStage(page, '病案')
  await page.getByText('查看手术通知单与知情同意书', { exact: true }).click()
  await expect(page.getByRole('region', { name: '住院病案首页核心字段集', exact: true })).toContainText('同台转 PCI')

  const finalClinical = await s.read('inpatient-doctor', `${path}/clinical`, inpatientFullClinicalSchema)
  expect(finalClinical.charges.filter(item => item.kind === 'surgery').map(item => item.amountFen).sort((a, b) => a - b)).toEqual([80000, 180000])
  expect(finalClinical.charges.filter(item => item.kind === 'service' && item.label.includes('术中介入专科护理'))).toHaveLength(1)
  expect(finalClinical.charges.filter(item => item.kind === 'material')).toHaveLength(4)

  // 校验写入次数：仅 1 次手术申请、1 次术前核对、1 次联合知情同意、1 次同台转 PCI
  const count = (suffix: string) => writes.filter(p => p.endsWith(suffix)).length
  expect(count('/surgeries/request')).toBe(1)
  expect(count('/surgeries/check-preop')).toBe(1)
  expect(count('/surgeries/confirm-consent')).toBe(1)
  expect(count('/surgeries/convert-to-pci')).toBe(1)
  expect(app.modelCalls).toBe(0)
  expect(errors).toEqual([])
})

test('同台备选冠脉造影单纯造影结束（finalize-standby）：仅保留造影记录与 1 笔专科护理费并预分组 FM59', async ({ page, pciApp: app }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  const writes: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (['POST', 'PUT'].includes(request.method())) writes.push(new URL(request.url()).pathname)
  })

  const { s, path, admission, angioProc } = await prepareStandbyCagThroughPages(page, app, '同台造影评估单纯结束验收')
  const decisionCard = page.getByRole('region', { name: '待同台决策', exact: true })
  await expect(decisionCard).toBeVisible()
  await s.runtime.dispatchPending()
  await decisionCard.getByLabel('决策说明（选填）', { exact: true }).fill('造影评估暂行保守观察，本次仅完成造影')
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '仅完成造影，结束本台手术', exact: true }).click()

  const finalCard = page.getByRole('region', { name: '最终耗材', exact: true })
  await expect(finalCard).toContainText(angioProc.coding.code)
  await expect(finalCard).toContainText('术中介入专科护理')

  const surgeries = await s.read('inpatient-doctor', `${path}/surgeries`, inpatientSurgerySchema)
  expect(surgeries.requests[0]?.status).toBe('completed')
  expect(surgeries.executions).toHaveLength(1)

  // 未显式确认主操作前，绝不自动改写病案首页；确认 88.5500 为主操作后刷新为 FM59
  await selectInpatientStage(page, 'DRG 预分组')
  await openInpatientDrgTools(page)
  await expect(page.getByRole('region', { name: '费用与支付参考', exact: true })).toContainText('存在操作但缺少主操作标记')
  await s.confirmMainProcedure({ path }, surgeries.executions[0]!.id)
  await page.reload()
  await page.getByRole('button', { name: new RegExp(admission.patientName) }).click()
  await selectInpatientStage(page, 'DRG 预分组')
  await openInpatientDrgTools(page)
  await expect(page.getByRole('region', { name: '费用与支付参考', exact: true })).toContainText('FM59')

  const finalClinical = await s.read('inpatient-doctor', `${path}/clinical`, inpatientFullClinicalSchema)
  expect(finalClinical.charges.filter(item => item.kind === 'surgery').map(item => item.amountFen)).toEqual([80000])
  expect(finalClinical.charges.filter(item => item.kind === 'service' && item.label.includes('术中介入专科护理'))).toHaveLength(1)
  expect(writes.filter(p => p.endsWith('/surgeries/finalize-standby'))).toHaveLength(1)
  expect(writes.filter(p => p.endsWith('/surgeries/convert-to-pci'))).toHaveLength(0)
  expect(app.modelCalls).toBe(0)
  expect(errors).toEqual([])
})
