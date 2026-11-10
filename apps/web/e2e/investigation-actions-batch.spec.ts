import { expect, test } from './fixtures.ts'
import { issueDoctorLaboratoryRequest, openDoctorFirstVisit, readDoctorBillingCase, startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { prepareInpatientInvestigationActions, runInpatientInvestigationCancelJourney } from './investigation-actions-batch.journey.ts'

test('门诊医生在真实检验入口选择同次就诊两项申请集中取消', async ({ page, webRoot }) => {
  const app = await startInvestigationBillingServer(webRoot)
  try {
    await openDoctorFirstVisit(page, app)
    const whiteCell = await issueDoctorLaboratoryRequest(page, { query: '白细胞', name: '合成白细胞计数', code: '0100101A' })
    const haemoglobin = await issueDoctorLaboratoryRequest(page, { query: '血红蛋白', name: '合成血红蛋白', code: '0100501A' })
    const before = await readDoctorBillingCase(page, app)
    expect(before.laboratoryRequests?.requests.map(request => request.id).sort()).toEqual([whiteCell, haemoglobin].sort())
    expect(before.laboratoryRequests?.requests.every(request => request.status === 'issued')).toBe(true)
    const laboratory = page.getByRole('tabpanel', { name: /^检验 \d+$/ })
    await expect(laboratory.getByRole('checkbox', { name: /^选择取消.*合成(白细胞计数|血红蛋白)/ })).toHaveCount(2)
  } finally {
    await app.close()
  }
})

test('住院医生从真实检查检验入口集中核对并取消两项待送检申请', async ({ page, webRoot }) => {
  const app = await startInvestigationBillingServer(webRoot)
  try {
    const patient = await prepareInpatientInvestigationActions(page, app)
    await runInpatientInvestigationCancelJourney(page, patient)
  } finally {
    await app.close()
  }
})
