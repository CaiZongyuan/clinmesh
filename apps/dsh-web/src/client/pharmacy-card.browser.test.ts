import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { dispenseResponseSchema, pharmacyQueueSchema, prescriptionReviewResponseSchema } from '@clinmesh/contracts/his'
import { startPharmacyCardServer } from '../../../web/e2e/pharmacy-card.fixture.ts'
import { buildNonDoctorCard, mountNonDoctorCard } from './non-doctor-card.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`pharmacy cards on React ${version}`, () => {
  test.beforeAll(async () => { await buildNonDoctorCard(version) })
  test('keeps the reviewed pharmacist note when the visible note changes during approval', async ({ page }) => {
    const server = await startPharmacyCardServer(page, fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await mountNonDoctorCard(page, version, server, 'pharmacist')
      await page.getByLabel('审核意见', { exact: true }).fill('已审阅的药师意见甲')
      await page.getByLabel('延迟批准', { exact: true }).check()
      await page.getByRole('button', { name: '助手准备处方审核', exact: true }).click()
      const review = page.getByRole('region').filter({ hasText: '待人工确认；请在此确认本次操作' })
        .filter({ has: page.getByRole('button', { name: '审核通过', exact: true }) })
      await review.getByRole('button', { name: '审核通过', exact: true }).click()
      await expect(page.getByLabel('批准状态', { exact: true })).toHaveText('等待批准闸门')
      await page.getByLabel('审核意见', { exact: true }).fill('尚未审阅的新意见乙')
      const received = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/prescriptions/${server.item.prescriptionId}/actions/review`))
      await page.getByRole('button', { name: '放行确认', exact: true }).click()
      const response = await received
      expect(response.status()).toBe(200)
      expect(response.request().postDataJSON().input.note).toBe('已审阅的药师意见甲')
      prescriptionReviewResponseSchema.parse(await response.json())
      const queue = pharmacyQueueSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/pharmacy/queue?status=pending`)).json())
      expect(queue.items.find(item => item.prescriptionId === server.item.prescriptionId)?.review?.note).toBe('已审阅的药师意见甲')
    } finally { await server.close() }
  })

  test('dispenses the reviewed partial quantity and preserves later quantity edits', async ({ page }) => {
    const server = await startPharmacyCardServer(page, fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      const reviewed = await page.request.post(`${server.origin}/api/his/v1/prescriptions/${server.item.prescriptionId}/actions/review`, {
        headers: { origin: server.origin, 'idempotency-key': crypto.randomUUID() },
        data: { expectedVersions: { [`Encounter/${server.item.encounterId}`]: server.item.encounterVersion,
          ...Object.fromEntries(server.item.medications.map(item => [`MedicationRequest/${item.medicationRequestId}`, item.medicationRequestVersion])) },
          input: { expectedPrescriptionVersion: server.item.prescriptionVersion, note: '合成审核已核对。' } },
      })
      expect(reviewed.status()).toBe(200)
      const medication = server.item.medications[0]!
      const lot = medication.lots.find(item => item.quantityOnHand >= 4)
      if (lot === undefined) throw new Error('The synthetic stock must support both reviewed and edited quantities')
      await mountNonDoctorCard(page, version, server, 'pharmacist', { 'pharmacy.dispense.draft.set': {
        selections: [{ medicationRequestId: medication.medicationRequestId, lotId: lot.id, quantity: 2 }],
      } })
      await page.getByRole('button', { name: '助手填写 pharmacy.dispense.draft.set', exact: true }).click()
      const quantity = page.getByLabel(`本次发放数量 · ${medication.nameZh}`, { exact: true })
      await expect(quantity).toHaveValue('2')
      await page.getByLabel('延迟批准', { exact: true }).check()
      await page.getByRole('button', { name: '助手准备发药', exact: true }).click()
      const review = page.getByRole('region').filter({ hasText: '待人工确认；请在此确认本次操作' })
        .filter({ has: page.getByRole('button', { name: '确认发药', exact: true }) })
      await review.getByRole('button', { name: '确认发药', exact: true }).click()
      await expect(page.getByLabel('批准状态', { exact: true })).toHaveText('等待批准闸门')
      await quantity.fill('4')
      const received = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/prescriptions/${server.item.prescriptionId}/actions/dispense`))
      await page.getByRole('button', { name: '放行确认', exact: true }).click()
      const response = await received
      expect(response.status()).toBe(200)
      expect(response.request().postDataJSON().input.lotSelections).toEqual([{ lotId: lot.id, expectedVersion: lot.version, quantity: 2 }])
      expect(dispenseResponseSchema.parse(await response.json()).data.status).toBe('partial')
      const queue = pharmacyQueueSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/pharmacy/queue?status=pending`)).json())
      expect(queue.items.find(item => item.prescriptionId === server.item.prescriptionId)?.medications[0]).toMatchObject({ dispensedQuantity: 2, remainingQuantity: 8 })
      await expect(quantity).toHaveValue('4')
    } finally { await server.close() }
  })
})
