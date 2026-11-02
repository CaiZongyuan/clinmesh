import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { dispenseResponseSchema, pharmacyQueueSchema, prescriptionReviewResponseSchema } from '@clinmesh/contracts/his'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { z } from 'zod'
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
      await expect(quantity).toHaveValue('4')
      await expect(quantity).toHaveCSS('border-style', 'solid')
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

  test('manual review focuses confirmation and Escape returns to its trigger without submitting', async ({ page }) => {
    const server = await startPharmacyCardServer(page, fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await mountNonDoctorCard(page, version, server, 'pharmacist')
      const trigger = page.getByRole('button', { name: '审阅处方审核', exact: true })
      await expect(trigger).toBeDisabled()
      await page.getByLabel('审核意见', { exact: true }).fill('合成键盘取消审核意见')
      let writes = 0
      page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/actions/review')) writes++ })
      await trigger.click()
      const confirm = page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '审核通过', exact: true })
      await expect(confirm).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(confirm).toHaveCount(0)
      await expect(trigger).toBeFocused()
      expect(writes).toBe(0)
      const queue = pharmacyQueueSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/pharmacy/queue?status=pending`)).json())
      expect(queue.items[0]?.review).toBeUndefined()
    } finally { await server.close() }
  })

  test('failed manual confirmation regains focus and can be cancelled without a review effect', async ({ page }) => {
    const server = await startPharmacyCardServer(page, fileURLToPath(new URL('../../../web/', import.meta.url)))
    let releaseFailure = () => {}
    const failureGate = new Promise<void>(resolve => { releaseFailure = resolve })
    try {
      await page.route(`${server.origin}/api/his/v1/prescriptions/${server.item.prescriptionId}/actions/review`, async route => {
        await failureGate
        await route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: '合成审核渠道暂不可用' } } })
      })
      await mountNonDoctorCard(page, version, server, 'pharmacist')
      await page.getByLabel('审核意见', { exact: true }).fill('合成失败后取消审核意见')
      const trigger = page.getByRole('button', { name: '审阅处方审核', exact: true })
      await trigger.click()
      const confirm = page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '审核通过', exact: true })
      await confirm.click()
      await expect(confirm).toBeDisabled()
      releaseFailure()
      await expect(page.getByRole('alert')).toBeVisible()
      await expect(confirm).toBeEnabled()
      await expect(confirm).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(confirm).toHaveCount(0)
      await expect(trigger).toBeFocused()
      const queue = pharmacyQueueSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/pharmacy/queue?status=pending`)).json())
      expect(queue.items[0]?.review).toBeUndefined()
    } finally { releaseFailure(); await server.close() }
  })

  test('keeps separate prescription drafts and clears only manually edited assistant markers', async ({ page }) => {
    const server = await startPharmacyCardServer(page, fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      // The second queue row exercises client draft isolation; no command targets that synthetic row.
      await page.route(`${server.origin}/api/his/v1/pharmacy/queue?**`, async route => {
        const response = await route.fetch(), queue = pharmacyQueueSchema.parse(await response.json())
        await route.fulfill({ response, json: { ...queue, total: 2, items: [server.item, { ...server.item,
          prescriptionId: 'synthetic-other-prescription', prescriptionNumber: 'CM-RX-SYNTHETIC-OTHER',
          encounterId: 'synthetic-other-encounter', caseId: 'synthetic-other-case',
        }] } })
      })
      await mountNonDoctorCard(page, version, server, 'pharmacist', { 'pharmacy.review.draft.set': { note: '助手准备的处方甲意见' } })
      await page.getByRole('button', { name: '助手填写 pharmacy.review.draft.set', exact: true }).click()
      const note = page.getByLabel('审核意见', { exact: true })
      await expect(note).toHaveValue('助手准备的处方甲意见')
      await expect(note).toHaveCSS('border-style', 'dashed')
      await note.fill('人工修改的处方甲意见')
      await expect(note).toHaveValue('人工修改的处方甲意见')
      await expect(note).toHaveCSS('border-style', 'solid')
      const first = page.getByRole('listitem').filter({ hasText: server.item.prescriptionNumber }).getByRole('button')
      const second = page.getByRole('listitem').filter({ hasText: 'CM-RX-SYNTHETIC-OTHER' }).getByRole('button')
      await second.click()
      await expect(note).toHaveValue('')
      await note.fill('处方乙的独立人工意见')
      await first.click()
      await expect(note).toHaveValue('人工修改的处方甲意见')
      await second.click()
      await expect(note).toHaveValue('处方乙的独立人工意见')
    } finally { await server.close() }
  })

  test('isolates account workspace and epoch drafts even when prescription IDs collide', async ({ page }) => {
    const server = await startPharmacyCardServer(page, fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await mountNonDoctorCard(page, version, server, 'pharmacist', { 'pharmacy.review.draft.set': { note: '原作用域的助手审核意见' } }, { sessionScopeProbe: true })
      await page.getByRole('button', { name: '助手填写 pharmacy.review.draft.set', exact: true }).click()
      const note = page.getByLabel('审核意见', { exact: true })
      await expect(note).toHaveValue('原作用域的助手审核意见')
      await expect(note).toHaveCSS('border-style', 'dashed')
      let writes = 0
      page.on('request', request => { if (request.method() === 'POST' && /\/actions\/(review|dispense)$/.test(request.url())) writes++ })
      for (const kind of ['账户', '工作区', '轮次']) {
        await page.getByRole('button', { name: `切换合成${kind}`, exact: true }).click()
        await expect(page.getByLabel('合成会话作用域', { exact: true })).toContainText('synthetic-collision')
        await expect(note).toHaveValue('')
        await note.fill(`合成${kind}的独立意见`)
        await expect(note).toHaveCSS('border-style', 'solid')
        await page.getByRole('button', { name: '恢复原会话作用域', exact: true }).click()
        await expect(note).toHaveValue('原作用域的助手审核意见')
        await expect(note).toHaveCSS('border-style', 'dashed')
      }
      expect(writes).toBe(0)
    } finally { await server.close() }
  })

  test('uses FEFO stock details warns inline and completes a reviewed partial dispense despite allergy warnings', async ({ page }) => {
    const server = await startPharmacyCardServer(page, fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      const medication = server.item.medications[0]!, originalLot = medication.lots[0]!
      const context = { workspaceId: 'workspace-demo', epoch: 'epoch-1' }, lotId = 'synthetic-earliest-pharmacy-lot'
      const original = fhirResourceSchema.parse(await (await page.request.get(`${server.origin}/fhir/R5/InventoryItem/${originalLot.id}`)).json())
      const projected = { ...original, id: lotId, identifier: [{ system: 'urn:clinmesh:synthetic-pharmacy-lot', value: 'SYN-FIRST-EXPIRY' }],
        netContent: { value: 3, unit: 'unit', system: 'http://unitsofmeasure.org', code: '1' },
        instance: { lotNumber: 'SYN-FIRST-EXPIRY', expiry: '2026-08-30', location: { reference: `Location/${originalLot.locationId}` } } }
      delete projected.meta
      server.runtime.fhir.createProjection(context, projected)
      // Inventory maintenance has no public command; only initial stock is arranged in the temporary fixture.
      server.runtime.database.driver.prepare(`INSERT INTO inventory_lot
        (workspace_id,epoch,lot_id,medication_id,location_id,lot_number,expires_on,quantity_on_hand,version)
        VALUES(?,?,?,?,?,'SYN-FIRST-EXPIRY','2026-08-30',3,1)`).run(context.workspaceId, context.epoch, lotId, medication.medicationId, originalLot.locationId)
      server.runtime.fhir.create(context, { resourceType: 'AllergyIntolerance', id: 'synthetic-pharmacy-other-allergy',
        patient: { reference: `Patient/${server.item.patient.id}` }, category: ['medication'],
        clinicalStatus: { coding: [{ code: 'active' }] }, verificationStatus: { coding: [{ code: 'confirmed' }] },
        code: { coding: [{ code: 'synthetic-penicillin', display: '合成青霉素过敏' }], text: '合成青霉素过敏' } })
      await mountNonDoctorCard(page, version, server, 'pharmacist', { 'pharmacy.dispense.draft.set': {
        selections: [{ medicationRequestId: medication.medicationRequestId, lotId, quantity: 2 }],
      } })
      await expect(page.getByRole('tab', { name: '异常', exact: true })).toHaveCount(0)
      await expect(page.getByText('合成青霉素过敏', { exact: true })).toBeVisible()
      const lot = page.getByRole('combobox', { name: `库存批次 · ${medication.nameZh}`, exact: true })
      await expect(lot).toContainText('SYN-FIRST-EXPIRY')
      await lot.click()
      await expect(page.getByRole('option', { name: /SYN-FIRST-EXPIRY.*库存 3.*2026-08-30/ })).toBeVisible()
      await page.getByRole('option', { name: /SYN-FIRST-EXPIRY.*库存 3.*2026-08-30/ }).click()
      await page.getByLabel('审核意见', { exact: true }).fill('合成审核已核对，与本处方不同的过敏仅提示')
      await page.getByRole('button', { name: '审阅处方审核', exact: true }).click()
      await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '审核通过', exact: true }).click()
      const quantity = page.getByLabel(`本次发放数量 · ${medication.nameZh}`, { exact: true })
      await expect(page.getByRole('button', { name: '助手填写 pharmacy.dispense.draft.set', exact: true })).toBeEnabled()
      await quantity.fill('4')
      await expect(quantity).toHaveAttribute('aria-invalid', 'true')
      await expect(page.getByText('库存仅剩 3，请减少数量或选择其他批次。', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '审阅发药', exact: true })).toBeDisabled()
      await page.getByRole('button', { name: '助手填写 pharmacy.dispense.draft.set', exact: true }).click()
      await expect(quantity).toHaveValue('2')
      await expect(quantity).toHaveCSS('border-style', 'dashed')
      await expect(lot).toHaveCSS('border-style', 'dashed')
      await quantity.fill('3')
      await expect(quantity).toHaveValue('3')
      await expect(quantity).toHaveCSS('border-style', 'solid')
      await lot.click()
      await page.getByRole('option', { name: new RegExp(originalLot.lotNumber) }).click()
      await expect(lot).toHaveCSS('border-style', 'solid')
      await lot.click()
      await page.getByRole('option', { name: /SYN-FIRST-EXPIRY/ }).click()
      await quantity.fill('2')
      await page.getByRole('button', { name: '审阅发药', exact: true }).click()
      const action = page.getByRole('region', { name: '当前操作', exact: true })
      await expect(action).toContainText('SYN-FIRST-EXPIRY')
      await expect(action).toContainText('确认后按以上批次扣减库存')
      const before = pharmacyQueueSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/pharmacy/queue?status=pending`)).json())
      expect(before.items[0]?.medications[0]?.dispensedQuantity).toBe(0)
      const received = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/actions/dispense'))
      await action.getByRole('button', { name: '确认发药', exact: true }).click()
      const response = await received
      expect(response.status()).toBe(200)
      expect(response.request().postDataJSON().input.lotSelections).toEqual([{ lotId, expectedVersion: 1, quantity: 2 }])
      expect(dispenseResponseSchema.parse(await response.json()).data.status).toBe('partial')
      const after = pharmacyQueueSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/pharmacy/queue?status=pending`)).json())
      expect(after.items[0]?.medications[0]).toMatchObject({ dispensedQuantity: 2, remainingQuantity: 8 })
      expect(after.items[0]?.medications[0]?.lots.find(item => item.id === lotId)?.quantityOnHand).toBe(1)
      const inventory = z.object({ netContent: z.object({ value: z.number() }) }).parse(await (await page.request.get(`${server.origin}/fhir/R5/InventoryItem/${lotId}`)).json())
      expect(inventory.netContent.value).toBe(1)
    } finally { await server.close() }
  })
})
