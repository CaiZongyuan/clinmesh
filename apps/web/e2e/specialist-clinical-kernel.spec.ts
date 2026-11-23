import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import {
  clinicalDocumentDraftResponseSchema,
  clinicalDocumentSignPreviewResponseSchema,
  clinicalDocumentSignResponseSchema,
  confirmDiagnosisResponseSchema,
  diagnosisDraftResponseSchema,
  doctorCaseDetailSchema,
  encounterCompletionResponseSchema,
  issuePrescriptionResponseSchema,
  prescriptionDraftResponseSchema,
  registrationCatalogSchema,
  startVisitResponseSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalResponseSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { authoredCasePackSummarySchema, startSyntheticInpatientCaseResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { startSyntheticCaseResultSchema } from '@clinmesh/contracts/scenario'
import { openBillingDetails } from './billing-payments.fixture.ts'
import { expect, test } from './inpatient-pci.fixture.ts'
import { openInpatientDisclosure, selectInpatientStage } from './inpatient-ui.ts'

async function login(page: Page, origin: string, password: string, role: string, targetPath: string) {
  await page.request.post(`${origin}/api/auth/sign-out`, { headers: { origin } })
  const res = await page.request.post(`${origin}/api/auth/sign-in/email`, {
    data: { email: `${role}@demo.clinmesh.local`, password },
    headers: { origin },
  })
  expect(res.status()).toBe(200)
  await page.goto(`${origin}${targetPath}`)
  await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible()
}

test('专病临床内核最小前端入口回归：五例病例包准备、住院体征/风险评分/指南专题/组套预筛/409越权与混合甲乙丙医保明细', async ({ page, pciApp }) => {
  test.setTimeout(120_000)
  const origin = pciApp.origin
  const password = pciApp.password
  const errors: string[] = []
  const modelJobRequests: string[] = []
  page.on('pageerror', err => errors.push(err.message))
  page.on('request', req => {
    if (req.method() === 'POST' && /\/(patient-persona-jobs|generation-jobs|guideline-advice\/request)$/.test(new URL(req.url()).pathname)) {
      modelJobRequests.push(req.url())
    }
  })

  const apiPost = (path: string, data: unknown, method: 'POST' | 'PUT' = 'POST') =>
    page.request.fetch(`${origin}${path}`, {
      data,
      headers: { 'idempotency-key': randomUUID(), origin },
      method,
    })

  // 1. Admin prepares PCI catalog & 5-case Authored Case Pack on `/scenario-data`
  await login(page, origin, password, 'admin', '/scenario-data')
  const prepRegion = page.getByRole('region', { name: 'PCI 演示准备', exact: true })
  await expect(prepRegion).toBeVisible()
  await prepRegion.getByRole('button', { name: '准备 PCI 目录', exact: true }).click()
  await expect(prepRegion.getByRole('status').filter({ hasText: '目录已准备' })).toBeVisible()
  await prepRegion.getByRole('button', { name: '准备专病病例包（5 例）', exact: true }).click()
  await expect(prepRegion.getByRole('status').filter({ hasText: '5/5 已就绪' })).toBeVisible()

  const packSummary = authoredCasePackSummarySchema.parse(
    await (await page.request.get(`${origin}/api/sim/v1/synthetic-cases/authored-pack`)).json(),
  )
  expect(packSummary.readyCount).toBe(5)
  const ipCase = packSummary.cases.find(item => item.draftId === 'cardio-cad-ckd3b-hydration-pci-v1')!.case!
  const opCase = packSummary.cases.find(item => item.draftId === 'renal-t2dm-htn-ckd4-control-v1')!.case!

  // 2. Admit Case ④ (`cardio-cad-ckd3b-hydration-pci-v1`) -> Ward Nurse records vital signs in Web UI -> Inpatient Doctor checks scores, guideline topic, order-set apply & 409 Clinical Override
  await login(page, origin, password, 'registrar', '/registration')
  const startedIpRes = await apiPost(`/api/his/v1/synthetic-cases/${ipCase.caseId}/actions/start-inpatient-visit`, {
    activeBriefRevision: ipCase.activeBriefRevision!,
    expectedCaseRevision: ipCase.revision,
    expectedEpoch: 'epoch-1',
    wardId: 'ward-general',
  })
  expect(startedIpRes.status()).toBe(200)
  const startedIp = startSyntheticInpatientCaseResponseSchema.parse(await startedIpRes.json()).data

  await login(page, origin, password, 'ward-nurse', '/inpatient')
  const listForNurse = inpatientListSchema.parse(await (await page.request.get(`${origin}/api/his/v1/inpatient/admissions`)).json())
  const regAdm = listForNurse.items.find(item => item.id === startedIp.admissionId)!
  expect((await apiPost(`/api/his/v1/inpatient/admissions/${startedIp.admissionId}/receive`, {
     input: { bedId: 'bed-general-1', encounterVersion: regAdm.versionId },
  })).status()).toBe(200)

  await page.reload()
  await page.getByRole('button', { name: new RegExp(regAdm.patientName) }).click()
  await openInpatientDisclosure(page, '护理生命体征')
  await page.getByLabel('体温 (°C)', { exact: true }).fill('36.6')
  await page.getByLabel('心率 (次/分)', { exact: true }).fill('74')
  await page.getByLabel('呼吸 (次/分)', { exact: true }).fill('18')
  await page.getByLabel('血氧 (%)', { exact: true }).fill('98')
  await page.getByLabel('收缩压 (mmHg)', { exact: true }).fill('128')
  await page.getByLabel('舒张压 (mmHg)', { exact: true }).fill('76')
  await page.getByLabel('体重 (kg，选填)', { exact: true }).fill('70')
  await page.getByRole('button', { name: '记录生命体征', exact: true }).click()
  await expect(page.locator('summary').filter({ hasText: '护理生命体征' })).toContainText('70 kg')

  await login(page, origin, password, 'inpatient-doctor', '/inpatient')
  const clinical = inpatientFullClinicalSchema.parse(
    await (await page.request.get(`${origin}/api/his/v1/inpatient/admissions/${startedIp.admissionId}/clinical`)).json(),
  )
  const confirmedIpDiag = await apiPost(`/api/his/v1/inpatient/admissions/${startedIp.admissionId}/diagnoses/confirm`, {
    input: {
      encounterVersion: clinical.encounterVersion,
      entries: [{ admissionCondition: '1', catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I25.103', role: 'primary' }],
      expectedRevision: clinical.diagnosis.revision,
    },
  })
  expect(confirmedIpDiag.status(), await confirmedIpDiag.text()).toBe(200)
  inpatientFullClinicalResponseSchema.parse(await confirmedIpDiag.json())

  await page.reload()
  await page.getByRole('button', { name: new RegExp(regAdm.patientName) }).click()

  // Clinical risk assessment & score display
  await openInpatientDisclosure(page, '专病风险评估与临床评分')
  await expect(page.getByText('CKD-EPI 2021 估算肾小球滤过率 (eGFR)')).toBeVisible()
  await page.getByLabel('Killip 分级').selectOption('I')
  await page.getByLabel('吸烟状态').selectOption('former')
  await page.getByRole('button', { name: '保存风险评估', exact: true }).click()
  await expect.poll(async () => {
    const res = await page.request.get(`${origin}/api/his/v1/inpatient/admissions/${startedIp.admissionId}/clinical-scores`)
    const json = await res.json() as { riskAssessment?: { revision?: number } }
    return json.riskAssessment?.revision ?? 0
  }).toBe(1)

  // Guideline topic display (zero AI call)
  await openInpatientDisclosure(page, '循证指南专题与参考意见')
  await expect(page.getByLabel('指南专题')).toBeVisible()
  await page.getByLabel('指南专题').selectOption('acute-chest-pain-acs')
  const topicCard = page.getByLabel('同步原文与客观指标核对', { exact: true })
  await expect(topicCard).toContainText('急性胸痛与急性冠脉综合征急诊评估与介入时机')
  await expect(topicCard).toContainText('当前患者客观指标')

  // Order-set draft apply inside InpatientOrderComposer
  await page.getByRole('button', { name: '开立医嘱', exact: true }).click()
  const composer = page.getByRole('dialog', { name: '开立医嘱', exact: true })
  await expect(composer).toBeVisible()
  await composer.getByRole('combobox', { name: '专病组套', exact: true }).click()
  await page.getByRole('option', { name: '冠心病/PCI 二级预防', exact: true }).click()
  await composer.getByRole('button', { name: '套用专病组套', exact: true }).click()
  await expect(composer.getByRole('status').filter({ hasText: '已套用「冠心病/PCI 二级预防」' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(composer).toBeHidden()

  // 409 Clinical Override confirmation on inpatient discharge gate (`DISCHARGE_ANTIPLATELET_MISSING` + `DISCHARGE_STATIN_MISSING`)
  await selectInpatientStage(page, '出院')
  await page.getByLabel('出院处理说明', { exact: true }).fill('患者冠脉情况稳定，拟办理出院门诊衔接')
  await page.getByRole('button', { name: '开出院医嘱', exact: true }).click()
  const alertRegion = page.getByRole('region', { name: '临床质控警示', exact: true })
  await expect(alertRegion).toBeVisible()
  await expect(alertRegion).toContainText('DISCHARGE_ANTIPLATELET_MISSING')
  await alertRegion.getByLabel('受控越权原因').click()
  await page.getByRole('option', { name: '已核对外院或床旁近期检查结果' }).click()
  await alertRegion.getByLabel('医学说明（至少 4 字）').fill('院外自带规律双抗与他汀药物，出院当日即转门诊续方')
  await alertRegion.getByRole('button', { name: '登记说明并重新提交', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText('待出院')

  // 3. Mixed-tier (甲/乙/丙) outpatient prescription insurance breakdown in Cashier `/billing`
  await login(page, origin, password, 'registrar', '/registration')
  const regCat = registrationCatalogSchema.parse(await (await page.request.get(`${origin}/api/his/v1/catalogs/registration`)).json())
  const startedOp = startSyntheticCaseResultSchema.parse((await (await apiPost(
    `/api/his/v1/synthetic-cases/${opCase.caseId}/actions/start-outpatient-visit`,
    {
      activeBriefRevision: opCase.activeBriefRevision!,
      departmentId: regCat.departments[0]!.id,
      expectedCaseRevision: opCase.revision,
      locationId: regCat.locations[0]!.id,
      visitDate: regCat.virtualDate,
      visitTypeId: regCat.visitTypes[0]!.id,
    },
  )).json()).data)

  await login(page, origin, password, 'triage', '/triage')
  const triagedOp = triageResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/actions/record-triage`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: '1', [`Task/${startedOp.queueTaskId}`]: '1' },
      input: {
        acuityCode: 'level-3',
        bloodPressure: { diastolicMmHg: 78, systolicMmHg: 132 },
        chiefComplaint: '高血压合并血脂异常复诊开药',
        oxygenSaturationPct: 98,
        pulseBpm: 72,
        respirationBpm: 18,
        temperatureC: 36.5,
      },
    },
  )).json()).data

  await login(page, origin, password, 'doctor', '/consultation')
  startVisitResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/actions/start-first-visit`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: '2', [`Task/${triagedOp.doctorTaskId}`]: '1' },
      input: {},
    },
  )).json())

  const readOp = async () => doctorCaseDetailSchema.parse(await (await page.request.get(`${origin}/api/his/v1/doctor/cases/${startedOp.outpatientCaseId}`)).json())
  const d1 = await readOp()
  const diagDraft = diagnosisDraftResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/diagnosis/draft`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: d1.encounter.versionId },
      input: {
        entries: [
          { catalogItemId: 'diagnosis-hypertension', role: 'primary' },
          { catalogItemId: 'diagnosis-dyslipidemia', role: 'secondary' },
        ],
        expectedDraftVersion: 0,
      },
    },
    'PUT',
  )).json()).data
  confirmDiagnosisResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/diagnosis/actions/confirm`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: d1.encounter.versionId },
      input: { expectedDraftVersion: diagDraft.draftVersion },
    },
  )).json())

  const d2 = await readOp()
  const rxDraft = prescriptionDraftResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/prescription/draft`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: d2.encounter.versionId },
      input: {
        expectedDraftVersion: 0,
        items: [
          { catalogItemId: 'medication-amlodipine', courseDays: 10, doseText: '5 mg', frequencyCode: 'QD', quantity: 10, routeCode: 'PO' },
          { catalogItemId: 'medication-valsartan', courseDays: 1, doseText: '80 mg', frequencyCode: 'QD', quantity: 1, routeCode: 'PO' },
          { catalogItemId: 'medication-ezetimibe', courseDays: 1, doseText: '10 mg', frequencyCode: 'QD', quantity: 1, routeCode: 'PO' },
        ],
      },
    },
    'PUT',
  )).json()).data
  issuePrescriptionResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/prescription/actions/issue`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: d2.encounter.versionId },
      input: { expectedDraftVersion: rxDraft.draftVersion },
    },
  )).json())

  const d3 = await readOp()
  const docDraft = clinicalDocumentDraftResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/clinical-document/draft`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: d3.encounter.versionId },
      input: {
        document: {
          assessment: '高血压合并血脂异常，开具甲/乙/丙混合降压调脂处方。',
          chiefComplaint: '高血压合并血脂异常复诊开药。',
          disposition: '规律口服氨氯地平、缬沙坦与依折麦布。',
          followUp: '4 周后复查血压与血脂。',
          historyOfPresentIllness: '既往高血压及血脂异常病史。',
          menstrualHistory: '已绝经。',
          obstetricHistory: '孕2产2。',
          physicalExamination: '神清，血压 132/78 mmHg。',
        },
        expectedDraftVersion: 0,
      },
    },
    'PUT',
  )).json()).data
  const d4 = await readOp()
  const signPrev = clinicalDocumentSignPreviewResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/clinical-document/actions/preview-sign`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: d4.encounter.versionId },
      input: { expectedDraftVersion: docDraft.draftVersion },
    },
  )).json()).data
  const d5 = await readOp()
  clinicalDocumentSignResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/clinical-document/actions/sign`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: d5.encounter.versionId },
      input: { commitToken: signPrev.commitToken, previewId: signPrev.previewId },
    },
  )).json())
  const d6 = await readOp()
  encounterCompletionResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/actions/complete`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: d6.encounter.versionId },
      input: {},
    },
  )).json())

  await login(page, origin, password, 'cashier', '/billing')
  await page.getByRole('combobox', { name: '费用类别', exact: true }).click()
  await page.getByRole('option', { name: '药品费用', exact: true }).click()
  await page.locator('[data-agent-selection]').first().click()
  await openBillingDetails(page, '医保待遇')
  const insPanel = page.getByRole('region', { name: '患者医保待遇', exact: true })
  await insPanel.getByRole('button', { name: '患者医保待遇（合成）', exact: true }).click()
  await insPanel.getByLabel('固定合成方案', { exact: true }).click()
  await page.getByRole('option', { name: '合成职工 v1', exact: true }).click()
  await insPanel.getByRole('button', { name: '预览医保待遇', exact: true }).click()
  await expect(insPanel).toContainText('先行自付')
  await expect(insPanel).toContainText('目录外 ¥1.00')
  await expect(insPanel).toContainText('先行 ¥0.08')
  await insPanel.getByRole('button', { name: '审阅医保结算', exact: true }).click()
  const confirmDialog = page.getByRole('alertdialog', { name: '确认医保结算', exact: true })
  await expect(confirmDialog).toContainText('患者现金应付')
  await confirmDialog.getByRole('button', { name: '提交医保结算', exact: true }).click()
  await expect(confirmDialog).toHaveCount(0)

  expect(pciApp.modelCalls).toBe(0)
  expect(modelJobRequests).toEqual([])
  expect(errors).toEqual([])
})
