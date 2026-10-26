import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'
import { refundCaseSchema } from '@clinmesh/contracts/refunds'
import {
  apiErrorSchema, billingCaseSchema, doctorCaseDetailSchema, imagingRequestDraftResponseSchema,
  issueImagingRequestResponseSchema, issueLaboratoryRequestResponseSchema, laboratoryRequestDraftResponseSchema,
  laboratoryServiceSnapshotSchema, paymentPreviewResponseSchema, paymentResponseSchema, sessionContextSchema,
  laboratoryRequestActionResponseSchema,
  type LaboratoryServiceSnapshot,
} from '@clinmesh/contracts/his'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { installSyntheticImagingAssets } from './fixtures/imaging-catalog.ts'
import {
  caseBundle, createImagingRuntime, generateCase, lungCancer, mutation, prepareImaging, signIn, snomed, startConsultation,
} from './fixtures/imaging-scenario.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function setup() {
  const bundle = caseBundle({ gender: 'male', index: [{ ...lungCancer, resourceType: 'Condition' }], name: '门诊价格边界合成病例' })
  const created = await createImagingRuntime([{ ...bundle, entry: [...bundle.entry, {
    fullUrl: 'urn:uuid:billing-wbc-source', resource: {
      resourceType: 'Observation', id: 'billing-wbc-source', status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '6690-2', display: '白细胞计数' }] },
      subject: { reference: 'urn:uuid:patient' }, encounter: { reference: 'urn:uuid:index-encounter' },
      effectiveDateTime: '2026-06-01T10:10:00+08:00',
      valueQuantity: { value: 7.2, unit: '10^9/L', system: 'http://unitsofmeasure.org', code: '10*9/L' },
    },
  }] }], { persona: true })
  let runtime = created.runtime
  cleanups.push(async () => { await runtime.close(); await rm(created.directory, { recursive: true, force: true }) })
  await installSyntheticImagingAssets({
    assetDirectory: created.assetDirectory, catalogDirectory: created.catalogDirectory,
    assets: [{ assetId: 'billing-boundary-radiograph', examCode: 'chest-radiograph' }, { assetId: 'billing-boundary-ct', examCode: 'chest-ct-plain' }],
    matching: {
      codeSystem: snomed, ruleVersion: 1, schemaVersion: 1, sourceExamCodes: {}, uncoveredConditions: [],
      profiles: [{ ageRange: [18, 89], conditionCodes: [lungCancer.code], finding: 'positive', sex: 'male',
        id: 'billing-boundary-lung', label: '合成胸部检查',
        assets: { 'chest-radiograph': 'billing-boundary-radiograph', 'chest-ct-plain': 'billing-boundary-ct' } }],
    },
  })
  const admin = await signIn(runtime)
  const actor = sessionContextSchema.parse(await (await runtime.app.request('/api/auth/context', { headers: { cookie: admin } })).json()).actor
  const concept = { id: 'loinc:synthetic:6690-2', system: 'http://loinc.org', code: '6690-2', display: '白细胞计数', version: '2.83', sourceLocator: 'synthetic:loinc:6690-2' }
  const laboratoryService = laboratoryServiceSnapshotSchema.parse({
    id: 'synthetic-outpatient-wbc', version: 1, serviceKind: 'laboratory', doctorOrderable: true,
    localCode: 'SYN-OP-WBC', nameZh: '合成白细胞计数', referenceConcept: concept,
    referenceReleaseId: 'synthetic-laboratory-release', componentServiceIds: [], executingDepartmentId: 'department-laboratory',
    allowedIndicationCodes: ['clinical-assessment'], specimen: { code: '119297000', display: '血液标本' }, tatMinutes: 20, priceFen: 800,
    outpatientBilling: { id: 'synthetic-outpatient-wbc-price', version: 1, priceFen: 800, currency: 'CNY', unit: '项目',
      source: 'synthetic-outpatient-boundary-fixture', effectiveOn: '2026-08-24' },
    reportDefinition: { conclusionTemplate: '白细胞计数结果已完成。', results: [{ referenceConcept: concept, valueType: 'quantity',
      referenceRange: { low: 4, high: 10, text: '4.0-10.0 x10^9/L' },
      unit: { system: 'http://unitsofmeasure.org', code: '10*9/L', display: '10^9/L' } }] },
  })
  // 目录是合成外部配置；所有申请、应收与付款仍经公共 HTTP 入口生成。
  runtime.database.driver.prepare(`INSERT INTO hospital_service_catalog
    (workspace_id,epoch,service_id,code,name_zh,name_en,version,active,config_json) VALUES(?,?,?,?,?,?,1,1,?)`)
    .run(actor.workspaceId, actor.epoch, laboratoryService.id, laboratoryService.localCode, laboratoryService.nameZh, laboratoryService.nameZh,
      JSON.stringify({ laboratoryService, availableScopes: ['outpatient'] }))
  const sourceCaseId = await generateCase(runtime, admin)
  await prepareImaging(runtime, admin, [sourceCaseId])
  const visit = await startConsultation(runtime, admin, sourceCaseId)
  let cashier = await signIn(runtime, 'cashier@demo.clinmesh.local')
  let doctor = visit.doctor
  const expectedVersions = { [`Encounter/${visit.encounterId}`]: '3' }
  const readCase = async () => doctorCaseDetailSchema.parse(await (await runtime.app.request(`/api/his/v1/doctor/cases/${visit.outpatientCaseId}`, { headers: { cookie: doctor } })).json())
  const readBill = async () => billingCaseSchema.parse(await (await runtime.app.request(`/api/his/v1/billing/cases/${visit.outpatientCaseId}`, { headers: { cookie: cashier } })).json())
  const readResourceCounts = async () => {
    const counts = await Promise.all([
      `/fhir/R5/ServiceRequest?encounter=Encounter/${visit.encounterId}&_total=accurate`,
      '/fhir/R5/ChargeItem?_total=accurate',
    ].map(async path => {
      const response = await runtime.app.request(path, { headers: { cookie: doctor } })
      expect(response.status).toBe(200)
      const total = fhirBundleSchema.parse(await response.json()).total
      expect(total).toBeTypeOf('number')
      return total
    }))
    return counts
  }
  const saveDraft = (kind: 'laboratory' | 'imaging', expectedDraftVersion = 0, serviceId = 'imaging-chest-radiograph') => runtime.app.request(
    `/api/his/v1/encounters/${visit.encounterId}/${kind}-request/draft`, mutation(doctor, { expectedVersions,
      input: kind === 'laboratory' ? { catalogItemId: laboratoryService.id, indicationCode: 'clinical-assessment', expectedDraftVersion }
        : { serviceId, indication: '合成门诊收费边界检查', expectedDraftVersion },
    }, 'PUT'))
  const issue = (kind: 'laboratory' | 'imaging', expectedDraftVersion: number, cookie = doctor) => runtime.app.request(
    `/api/his/v1/encounters/${visit.encounterId}/${kind}-request/actions/issue`, mutation(cookie, { expectedVersions, input: { expectedDraftVersion } }))
  async function orderImaging(serviceId: string, expectedDraftVersion = 0) {
    const draftResponse = await saveDraft('imaging', expectedDraftVersion, serviceId)
    expect(draftResponse.status, await draftResponse.clone().text()).toBe(200)
    const response = await issue('imaging', imagingRequestDraftResponseSchema.parse(await draftResponse.json()).data.draftVersion)
    expect(response.status, await response.clone().text()).toBe(200)
    return issueImagingRequestResponseSchema.parse(await response.json()).data.request
  }
  const preview = (category: 'laboratory' | 'imaging', chargeItemId: string, chargeVersion = 1, cookie = cashier) => runtime.app.request(
    '/api/his/v1/payments/actions/preview', mutation(cookie, {
      expectedVersions: { [`ChargeItem/${chargeItemId}`]: String(chargeVersion) },
      input: { caseId: visit.outpatientCaseId, category, chargeItemId, simulatorRule: 'success' },
    }))
  return {
    ...created, ...visit, get runtime() { return runtime }, get cashier() { return cashier }, get doctor() { return doctor },
    actor, laboratoryService, readCase, readBill, readResourceCounts, saveDraft, issue, orderImaging, preview,
    configureLaboratory(service: LaboratoryServiceSnapshot) {
      runtime.database.driver.prepare(`UPDATE hospital_service_catalog SET version=?,config_json=json_set(config_json,'$.laboratoryService',json(?))
        WHERE workspace_id=? AND epoch=? AND service_id=?`).run(service.version, JSON.stringify(service), actor.workspaceId, actor.epoch, service.id)
    },
    removeImagingPrice() {
      runtime.database.driver.prepare(`UPDATE hospital_service_catalog SET config_json=json_remove(config_json,'$.imagingService.outpatientBilling')
        WHERE workspace_id=? AND epoch=? AND service_id='imaging-chest-radiograph'`).run(actor.workspaceId, actor.epoch)
    },
    async restart() {
      await runtime.close()
      runtime = await createClinMeshRuntime(created.runtimeOptions)
      cashier = await signIn(runtime, 'cashier@demo.clinmesh.local')
      doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
    },
  }
}

describe('门诊独立检查的价格、原费用与权限边界', () => {
  it.each(['payment-first', 'cancellation-first'] as const)('取消与原付款并发时保留唯一冲减和确定退款责任（%s）', async order => {
    const s = await setup()
    expect((await s.saveDraft('laboratory')).status).toBe(200)
    const issued = await s.issue('laboratory', 1)
    expect(issued.status).toBe(200)
    const request = issueLaboratoryRequestResponseSchema.parse(await issued.json()).data.request
    const chargeItemId = request.billing!.chargeItemId
    const previewResponse = await s.preview('laboratory', chargeItemId)
    expect(previewResponse.status).toBe(200)
    const preview = paymentPreviewResponseSchema.parse(await previewResponse.json()).data
    const cancel = () => s.runtime.app.request(`/api/his/v1/laboratory-requests/${request.id}/actions/cancel`, mutation(s.doctor, {
      expectedVersions: { [`ServiceRequest/${request.serviceRequestId}`]: request.serviceRequestVersion,
        [`Task/${request.taskId}`]: request.taskVersion },
      input: { expectedRequestVersion: request.version, reasonCode: 'no-longer-needed' },
    }))
    const confirm = () => s.runtime.app.request(`/api/his/v1/payments/${preview.previewId}/actions/confirm`, mutation(s.cashier, {
      expectedVersions: { [`ChargeItem/${chargeItemId}`]: String(preview.chargeVersion) }, input: { commitToken: preview.commitToken },
    }))
    const paymentFirst = order === 'payment-first' ? confirm() : undefined
    const cancellation = cancel()
    const [payment, cancelled] = await Promise.all([paymentFirst ?? confirm(), cancellation])
    expect(cancelled.status, await cancelled.clone().text()).toBe(200)
    expect(laboratoryRequestActionResponseSchema.parse(await cancelled.json()).data.request.status).toBe('cancelled')
    expect([200, 409]).toContain(payment.status)
    const receivedFen = payment.status === 200 ? 800 : 0
    if (payment.status === 200) expect(paymentResponseSchema.parse(await payment.json()).data.outcome).toBe('success')
    else expect(apiErrorSchema.parse(await payment.json()).error.code).toBe('EXPECTED_VERSION_CONFLICT')

    await s.runtime.dispatchPending()
    const latest = (await s.readCase()).laboratoryRequests!.requests.find(item => item.id === request.id)!
    expect(latest).toMatchObject({ status: 'cancelled', billing: { chargeItemId, paidFen: receivedFen, remainingFen: 0 } })
    expect(latest.report).toBeUndefined()
    expect(latest.billing!.releasedAt).toBeUndefined()
    const bill = await s.readBill()
    expect(bill.charges.filter(item => item.requestId === request.id)).toEqual([
      expect.objectContaining({ chargeItemId, amountFen: 0, paidFen: receivedFen, status: 'cancelled' }),
    ])
    expect(bill.payments).toHaveLength(receivedFen === 0 ? 0 : 1)
    const refunds = await s.runtime.app.request(`/api/his/v1/billing/cases/${s.outpatientCaseId}/refunds`, { headers: { cookie: s.cashier } })
    expect(refunds.status).toBe(200)
    const ledger = refundCaseSchema.parse(await refunds.json())
    expect(ledger.adjustments).toEqual([expect.objectContaining({ chargeItemId, amountFen: 800 })])
    expect(ledger.refunds).toEqual([])
    expect(ledger.sources.reduce((total, source) => total + source.refundableFen, 0)).toBe(receivedFen)
  })

  it.each(['laboratory', 'imaging'] as const)('%s 缺少有效价格时保留草稿，正式开立不留下原申请或费用', async kind => {
    const s = await setup()
    if (kind === 'laboratory') s.configureLaboratory({ ...s.laboratoryService, priceFen: 0, outpatientBilling: undefined })
    else s.removeImagingPrice()
    const billBefore = await s.readBill()
    const resourcesBefore = await s.readResourceCounts()
    const draft = await s.saveDraft(kind)
    expect(draft.status, await draft.clone().text()).toBe(200)
    const blocked = await s.issue(kind, 1)
    expect(blocked.status).toBe(409)
    expect(apiErrorSchema.parse(await blocked.json()).error.code).toBe('CATALOG_CONFLICT')
    const detail = await s.readCase()
    const state = kind === 'laboratory' ? detail.laboratoryRequests : detail.imagingRequests
    expect(state).toMatchObject({ draftVersion: 1, draft: expect.any(Object), requests: [] })
    expect(await s.readBill()).toEqual(billBefore)
    expect(await s.readResourceCounts()).toEqual(resourcesBefore)
    await s.restart()
    expect(await s.readBill()).toEqual(billBefore)
    expect(await s.readResourceCounts()).toEqual(resourcesBefore)
    expect((kind === 'laboratory' ? (await s.readCase()).laboratoryRequests : (await s.readCase()).imagingRequests)?.requests).toEqual([])
  })

  it.each(['service', 'price'] as const)('完整检验服务的 %s 版本改变后要求重新保存并审阅，开立后价格保持原快照', async change => {
    const s = await setup()
    expect((await s.saveDraft('laboratory')).status).toBe(200)
    const updated = change === 'service' ? { ...s.laboratoryService, version: 2 }
      : { ...s.laboratoryService, outpatientBilling: { ...s.laboratoryService.outpatientBilling!, version: 2, priceFen: 900 } }
    s.configureLaboratory(updated)
    const blocked = await s.issue('laboratory', 1)
    expect(blocked.status).toBe(409)
    expect(apiErrorSchema.parse(await blocked.json()).error.code).toBe('CATALOG_CONFLICT')
    expect((await s.readCase()).laboratoryRequests).toMatchObject({ draftVersion: 1, requests: [] })
    const saved = await s.saveDraft('laboratory', 1)
    expect(saved.status).toBe(200)
    const response = await s.issue('laboratory', laboratoryRequestDraftResponseSchema.parse(await saved.json()).data.draftVersion)
    expect(response.status, await response.clone().text()).toBe(200)
    const request = issueLaboratoryRequestResponseSchema.parse(await response.json()).data.request
    const amountFen = change === 'price' ? 900 : 800
    expect(request.billing).toMatchObject({ price: { priceFen: amountFen, version: change === 'price' ? 2 : 1 }, remainingFen: amountFen })
    s.configureLaboratory({ ...updated, version: updated.version + 1,
      outpatientBilling: { ...updated.outpatientBilling!, version: 3, priceFen: 1000 } })
    await s.restart()
    expect((await s.readCase()).laboratoryRequests?.requests.find(item => item.id === request.id)?.billing).toEqual(request.billing)
    expect((await s.readBill()).charges.find(item => item.requestId === request.id)).toMatchObject({ amountFen, price: request.billing!.price })
  })

  it('两笔放射与一笔检验费用精确收款，跨类别及跨岗拒绝且重启保留原交易', async () => {
    const s = await setup()
    const radiograph = await s.orderImaging('imaging-chest-radiograph')
    const ct = await s.orderImaging('imaging-chest-ct-plain', 2)
    expect((await s.saveDraft('laboratory')).status).toBe(200)
    const labResponse = await s.issue('laboratory', 1)
    expect(labResponse.status, await labResponse.clone().text()).toBe(200)
    const laboratory = issueLaboratoryRequestResponseSchema.parse(await labResponse.json()).data.request
    const radiographCharge = radiograph.billing!.chargeItemId
    const laboratoryCharge = laboratory.billing!.chargeItemId
    const before = await s.readBill()
    expect((await s.preview('laboratory', radiographCharge)).status).toBe(409)
    expect((await s.preview('imaging', laboratoryCharge)).status).toBe(409)
    expect((await s.preview('imaging', radiographCharge, 1, s.doctor)).status).toBe(403)
    expect((await s.issue('imaging', 1, s.cashier)).status).toBe(403)
    expect(await s.readBill()).toEqual(before)
    const previewResponse = await s.preview('imaging', radiographCharge)
    expect(previewResponse.status).toBe(200)
    const preview = paymentPreviewResponseSchema.parse(await previewResponse.json()).data
    expect(preview).toMatchObject({ amountFen: 8000, chargeItemId: radiographCharge, allocations: [{ amountFen: 8000, chargeItemId: radiographCharge }] })
    const key = randomUUID()
    const confirm = async () => {
      const request = mutation(s.cashier, { expectedVersions: { [`ChargeItem/${radiographCharge}`]: String(preview.chargeVersion) }, input: { commitToken: preview.commitToken } })
      request.headers['idempotency-key'] = key
      return s.runtime.app.request(`/api/his/v1/payments/${preview.previewId}/actions/confirm`, request)
    }
    const confirmed = await confirm()
    expect(confirmed.status).toBe(200)
    const receipt = paymentResponseSchema.parse(await confirmed.json())
    const after = await s.readBill()
    expect(after.charges.find(item => item.requestId === radiograph.id)).toMatchObject({ chargeItemId: radiographCharge, paidFen: 8000, remainingFen: 0 })
    expect(after.charges.find(item => item.requestId === ct.id)).toMatchObject({ paidFen: 0, remainingFen: 30000 })
    expect(after.charges.find(item => item.requestId === laboratory.id)).toMatchObject({ chargeItemId: laboratoryCharge, paidFen: 0, remainingFen: 800 })
    expect((await s.readCase()).laboratoryRequests?.requests.find(item => item.id === laboratory.id)).toMatchObject({ status: 'issued', billing: { status: 'pending' } })
    await s.restart()
    expect(await s.readBill()).toEqual(after)
    expect(paymentResponseSchema.parse(await (await confirm()).json())).toEqual(receipt)
    expect(await s.readBill()).toEqual(after)
    const labPreviewResponse = await s.preview('laboratory', laboratoryCharge)
    expect(labPreviewResponse.status).toBe(200)
    const labPreview = paymentPreviewResponseSchema.parse(await labPreviewResponse.json()).data
    expect(labPreview).toMatchObject({ amountFen: 800, chargeItemId: laboratoryCharge, allocations: [{ amountFen: 800, chargeItemId: laboratoryCharge }] })
    const paidLab = await s.runtime.app.request(`/api/his/v1/payments/${labPreview.previewId}/actions/confirm`, mutation(s.cashier, {
      expectedVersions: { [`ChargeItem/${laboratoryCharge}`]: String(labPreview.chargeVersion) }, input: { commitToken: labPreview.commitToken },
    }))
    expect(paidLab.status, await paidLab.clone().text()).toBe(200)
    expect(paymentResponseSchema.parse(await paidLab.json()).data.outcome).toBe('success')
    const finalBill = await s.readBill()
    expect(finalBill.charges.find(item => item.requestId === radiograph.id)).toMatchObject({ paidFen: 8000, remainingFen: 0 })
    expect(finalBill.charges.find(item => item.requestId === laboratory.id)).toMatchObject({ paidFen: 800, remainingFen: 0 })
    expect(finalBill.charges.find(item => item.requestId === ct.id)).toMatchObject({ paidFen: 0, remainingFen: 30000 })
  })
})
