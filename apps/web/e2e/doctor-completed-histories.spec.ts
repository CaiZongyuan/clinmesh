import { doctorCompletedCaseDetailSchema, doctorCompletedCaseListSchema } from '@clinmesh/contracts/his'
import { expect, test } from './fixtures.ts'

test('shows family and allergy history from signed originals and revisions in the completed case library', async ({ page, browserApp }) => {
  const originalContent = {
    assessment: '症状稳定，门诊观察。', chiefComplaint: '头晕一周。', disposition: '门诊随访。',
    followUp: '症状加重及时就诊。', historyOfPresentIllness: '患者自述站立时头晕。',
    physicalExamination: '生命体征稳定。', familyHistory: '父亲患高血压。', allergyHistory: '青霉素用药后皮疹。',
  }
  const detail = doctorCompletedCaseDetailSchema.parse({
    caseId: 'completed-history-case', completedAt: '2026-10-14T09:00:00+08:00',
    encounter: { id: 'completed-history-encounter', status: 'completed', versionId: '6' },
    patient: { id: 'completed-history-patient', identifier: 'SYNTHETIC-HISTORY', name: '合成病史患者', synthetic: true, versionId: '1' },
    clinicalDocuments: [{
      bundleId: 'history-bundle-original', compositionId: 'history-original', compositionVersion: '1',
      content: originalContent, documentId: 'history-document-original', provenanceId: 'history-provenance-original',
      revisionNumber: 1, signedAt: '2026-10-14T08:30:00+08:00',
    }, {
      bundleId: 'history-bundle-revised', compositionId: 'history-revised', compositionVersion: '1',
      content: { ...originalContent, familyHistory: '', allergyHistory: '过敏药物待进一步核实。' },
      documentId: 'history-document-revised', provenanceId: 'history-provenance-revised',
      revisionNumber: 2, revisionOfCompositionId: 'history-original', revisionReason: '核实病史并清空未确认的家族史。',
      signedAt: '2026-10-14T08:45:00+08:00',
    }],
    laboratoryRequests: [], timeline: [],
  })
  await page.route('**/api/his/v1/doctor/completed-cases?*', route => route.fulfill({ json: doctorCompletedCaseListSchema.parse({
    items: [{ caseId: detail.caseId, completedAt: detail.completedAt, encounterId: detail.encounter.id,
      encounterVersion: detail.encounter.versionId, patient: detail.patient }],
    page: 1, pageSize: 20, total: 1,
  }) }))
  await page.route(`**/api/his/v1/doctor/completed-cases/${detail.caseId}`, route => route.fulfill({ json: detail }))
  await page.goto(`${browserApp.origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('tab', { name: '完诊', exact: true }).click()
  const flow = page.getByRole('list', { name: '办理流程', exact: true })
  await expect(flow.locator('[aria-current="step"]')).toHaveCount(0)
  await expect(flow.getByText(/已完成/)).toHaveCount(0)
  await page.getByRole('button', { name: '查看病例 合成病史患者', exact: true }).click()
  const region = page.getByRole('region', { name: '已完诊病例详情', exact: true })
  await expect(flow.getByText('接诊 · 已完成', { exact: true })).toBeVisible()
  await expect(flow.getByText(/已完成/)).toHaveCount(1)
  await expect(flow.locator('[aria-current="step"]')).toHaveCount(0)
  const original = region.getByRole('listitem').filter({ has: page.getByText('Composition/history-original', { exact: true }) })
  const revised = region.getByRole('listitem').filter({ has: page.getByText('Composition/history-revised', { exact: true }) })
  await expect(original.getByText('家族史', { exact: true })).toBeVisible()
  await expect(original.getByText(originalContent.familyHistory, { exact: true })).toBeVisible()
  await expect(original.getByText('过敏史', { exact: true })).toBeVisible()
  await expect(original.getByText(originalContent.allergyHistory, { exact: true })).toBeVisible()
  await expect(revised.getByText('家族史', { exact: true })).toBeVisible()
  await expect(revised.getByText('未记录', { exact: true })).toBeVisible()
  await expect(revised.getByText('过敏史', { exact: true })).toBeVisible()
  await expect(revised.getByText('过敏药物待进一步核实。', { exact: true })).toBeVisible()
  await expect(revised.getByText(originalContent.familyHistory, { exact: true })).toHaveCount(0)
  await expect(revised.getByText(originalContent.allergyHistory, { exact: true })).toHaveCount(0)
})
