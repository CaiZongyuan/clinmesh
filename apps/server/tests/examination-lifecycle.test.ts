import { rm } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import {
  billingCaseSchema,
  doctorCaseDetailSchema,
  encounterCompletionPreviewSchema,
  examinationRequestSchema,
  triageQueueSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import {
  inpatientInvestigationsSchema,
  inpatientInvestigationResponseSchema,
} from '@clinmesh/contracts/inpatient-investigations'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { insurancePreviewResponseSchema, insuranceResponseSchema } from '@clinmesh/contracts/insurance'
import { refundCaseSchema, refundPreviewResponseSchema, refundResponseSchema } from '@clinmesh/contracts/refunds'
import { z } from 'zod'
import {
  acuteBronchitis,
  caseBundle,
  createImagingRuntime,
  generateCase,
  mutation,
  persona,
  signIn,
  startConsultation,
} from './fixtures/imaging-scenario.ts'
import { payOutpatientInvestigation } from './fixtures/pay-outpatient-investigation.ts'

const created: Awaited<ReturnType<typeof createImagingRuntime>>[] = []
afterEach(async () => {
  for (const item of created.splice(0)) {
    await item.runtime.close()
    await rm(item.directory, { recursive: true, force: true })
  }
})

async function setup(
  cardiovascular = false,
  observations: unknown[] = [],
  history?: { code: string; display?: string },
  formalPulseBpm?: number,
) {
  const bundle = caseBundle({
    gender: 'male',
    index: [{ ...acuteBronchitis, resourceType: 'Condition' }],
    name: '功能检查合成患者',
  })
  const item = await createImagingRuntime(
    [
      {
        ...bundle,
        entry: [
          ...bundle.entry
            .filter((entry) => cardiovascular || entry.resource.id !== 'prior-fact-0')
            .map((entry) =>
              history !== undefined && entry.resource.id === 'prior-fact-0'
                ? {
                    ...entry,
                    resource: {
                      ...entry.resource,
                      code: { coding: [{ ...history, system: 'http://snomed.info/sct' }] },
                    },
                  }
                : entry,
            ),
          ...observations,
        ],
      },
    ],
    { persona: true },
  )
  created.push(item)
  const admin = await signIn(item.runtime),
    source = await generateCase(item.runtime, admin)
  const visit = await startConsultation(item.runtime, admin, source, { pulseBpm: formalPulseBpm ?? 86 })
  const detail = async () =>
    doctorCaseDetailSchema.parse(
      await (
        await item.runtime.app.request(`/api/his/v1/doctor/cases/${visit.outpatientCaseId}`, {
          headers: { cookie: visit.doctor },
        })
      ).json(),
    )
  const issue = async (serviceId = 'examination-ecg-12-lead') => {
    const current = await detail(),
      expectedVersions = { [`Encounter/${visit.encounterId}`]: current.encounter.versionId }
    const saved = await item.runtime.app.request(
      `/api/his/v1/encounters/${visit.encounterId}/examination-request/draft`,
      mutation(
        visit.doctor,
        {
          expectedVersions,
          input: {
            expectedDraftVersion: current.examinationRequests?.draftVersion ?? 0,
            serviceId,
            indication: '胸部不适评估',
          },
        },
        'PUT',
      ),
    )
    expect(saved.status, await saved.clone().text()).toBe(200)
    const issued = await item.runtime.app.request(
      `/api/his/v1/encounters/${visit.encounterId}/examination-request/actions/issue`,
      mutation(visit.doctor, {
        expectedVersions,
        input: { expectedDraftVersion: (await saved.json()).data.draftVersion },
      }),
    )
    expect(issued.status, await issued.clone().text()).toBe(200)
    return examinationRequestSchema.parse((await issued.json()).data.request)
  }
  const completion = async () =>
    encounterCompletionPreviewSchema.parse(
      await (
        await item.runtime.app.request(`/api/his/v1/encounters/${visit.encounterId}/completion`, {
          headers: { cookie: visit.doctor },
        })
      ).json(),
    )
  return { ...item, admin, source, visit, detail, issue, completion }
}
async function dispatchAll(runtime: Awaited<ReturnType<typeof createImagingRuntime>>['runtime']) {
  while ((await runtime.dispatcher.dispatchOnce()) !== undefined) {
    /* Drain controlled deterministic outbox. */
  }
}

it('功能检查门诊合成医保按原申请分配，撤销待遇后才允许临床取消', async () => {
  const s = await setup(),
    request = await s.issue('examination-tte')
  const cashier = await signIn(s.runtime, 'cashier@demo.clinmesh.local')
  const path = `/api/his/v1/insurance/outpatient/${s.visit.outpatientCaseId}`
  const previewResponse = await s.runtime.app.request(
    path + '/preview',
    mutation(cashier, { expectedVersions: {}, input: { planCode: 'employee-v1' } }),
  )
  expect(previewResponse.status, await previewResponse.clone().text()).toBe(200)
  const preview = insurancePreviewResponseSchema.parse(await previewResponse.json()).data
  expect(
    preview.settlement.allocations.find((row) => row.reference === `ChargeItem/${request.billing!.chargeItemId}`),
  ).toMatchObject({
    amountFen: 18000,
    eligibleFen: 16200,
    priorSelfPayFen: 1800,
    outsideFen: 0,
  })
  const confirmedResponse = await s.runtime.app.request(
    path + '/confirm',
    mutation(cashier, {
      expectedVersions: {},
      input: { previewId: preview.previewId, commitToken: preview.commitToken },
    }),
  )
  expect(confirmedResponse.status, await confirmedResponse.clone().text()).toBe(200)
  const confirmed = insuranceResponseSchema.parse(await confirmedResponse.json()).data
  expect((await s.detail()).examinationRequests!.requests[0]!.billing!.insuranceFen).toBeGreaterThan(0)
  const cancelRequest = async () => {
    const current = (await s.detail()).examinationRequests!.requests[0]!
    return s.runtime.app.request(
      `/api/his/v1/examination-requests/${request.id}/actions/cancel`,
      mutation(s.visit.doctor, {
        expectedVersions: {
          [`ServiceRequest/${current.serviceRequestId}`]: current.serviceRequestVersion,
          [`Task/${current.taskId}`]: current.taskVersion,
        },
        input: { expectedRequestVersion: current.version, reasonCode: 'no-longer-needed' },
      }),
    )
  }
  expect((await cancelRequest()).status).toBe(409)
  const cancelledInsurance = await s.runtime.app.request(
    path + '/cancel',
    mutation(cashier, {
      expectedVersions: {},
      input: { settlementId: confirmed.active!.id, expectedBalanceVersion: confirmed.balance.version },
    }),
  )
  expect(cancelledInsurance.status, await cancelledInsurance.clone().text()).toBe(200)
  expect((await cancelRequest()).status).toBe(200)
  expect((await s.detail()).examinationRequests!.requests[0]).toMatchObject({
    status: 'cancelled',
    billing: { insuranceFen: 0, remainingFen: 0, status: 'cancelled' },
  })
})

it('已付费功能检查失败取消后全额冲减，并仅从原收款退款', async () => {
  const s = await setup(true),
    request = await s.issue()
  await payOutpatientInvestigation(s.runtime, {
    caseId: s.visit.outpatientCaseId,
    category: 'examination',
    chargeItemId: request.billing!.chargeItemId,
  })
  await dispatchAll(s.runtime)
  const failed = (await s.detail()).examinationRequests!.requests[0]!
  expect(failed.status).toBe('generation-failed')
  const cancelled = await s.runtime.app.request(
    `/api/his/v1/examination-requests/${request.id}/actions/cancel`,
    mutation(s.visit.doctor, {
      expectedVersions: {
        [`ServiceRequest/${failed.serviceRequestId}`]: failed.serviceRequestVersion,
        [`Task/${failed.taskId}`]: failed.taskVersion,
      },
      input: { expectedRequestVersion: failed.version, reasonCode: 'no-longer-needed' },
    }),
  )
  expect(cancelled.status, await cancelled.clone().text()).toBe(200)
  const cashier = await signIn(s.runtime, 'cashier@demo.clinmesh.local')
  const billingPath = `/api/his/v1/billing/cases/${s.visit.outpatientCaseId}`
  const readRefunds = async () =>
    refundCaseSchema.parse(
      await (await s.runtime.app.request(billingPath + '/refunds', { headers: { cookie: cashier } })).json(),
    )
  const before = await readRefunds(),
    source = before.sources[0]!
  expect(before).toMatchObject({
    adjustedFen: 3000,
    refundedFen: 0,
    refunds: [],
    sources: [{ amountFen: 3000, refundableFen: 3000 }],
  })
  const bill = billingCaseSchema.parse(
    await (await s.runtime.app.request(billingPath, { headers: { cookie: cashier } })).json(),
  )
  const charge = bill.charges.find((charge) => charge.chargeItemId === request.billing!.chargeItemId)!
  const expectedVersions = { [`ChargeItem/${charge.chargeItemId}`]: String(charge.chargeVersion) }
  const previewResponse = await s.runtime.app.request(
    '/api/his/v1/refunds/actions/preview',
    mutation(cashier, {
      expectedVersions,
      input: {
        paymentId: source.sourceId,
        expectedSourceVersion: source.version,
        amountFen: 3000,
        simulatorRule: 'success',
      },
    }),
  )
  expect(previewResponse.status, await previewResponse.clone().text()).toBe(200)
  const preview = refundPreviewResponseSchema.parse(await previewResponse.json()).data
  const refunded = await s.runtime.app.request(
    `/api/his/v1/refunds/${preview.previewId}/actions/confirm`,
    mutation(cashier, { expectedVersions, input: { commitToken: preview.commitToken } }),
  )
  expect(refunded.status, await refunded.clone().text()).toBe(200)
  expect(refundResponseSchema.parse(await refunded.json()).data).toMatchObject({
    outcome: 'success',
    sourceId: source.sourceId,
    amountFen: 3000,
  })
  expect(await readRefunds()).toMatchObject({ adjustedFen: 3000, refundedFen: 3000, sources: [{ refundableFen: 0 }] })
})

it.each([
  { service: 'examination-ecg-12-lead', price: 3000, code: 'ventricular-rate', value: 72, count: 8 },
  { service: 'examination-tte', price: 18000, code: 'lvef', value: 62, count: 5 },
])('无素材包完成 $service 收费、报告、类型隔离和已阅门禁', async ({ service, price, code, value, count }) => {
  const s = await setup(),
    request = await s.issue(service)
  expect(request.billing?.price.priceFen).toBe(price)
  await dispatchAll(s.runtime)
  expect((await s.detail()).examinationRequests?.requests[0]?.status).toBe('issued')
  await payOutpatientInvestigation(s.runtime, {
    caseId: s.visit.outpatientCaseId,
    category: 'examination',
    chargeItemId: request.billing!.chargeItemId,
  })
  await dispatchAll(s.runtime)
  const reported = (await s.detail()).examinationRequests!.requests[0]!,
    report = reported.report!
  expect(reported.status).toBe('reported')
  expect(report.results.find((result) => result.code === code)?.value).toBe(value)
  expect(report.results).toHaveLength(count)
  expect(report).not.toHaveProperty('studyId')
  expect(JSON.stringify(report)).not.toMatch(/hiddenResources|sourceHash|inputHash|snapshotId/)
  const fhir = fhirResourceSchema.parse(
    await (
      await s.runtime.app.request(`/fhir/R5/DiagnosticReport/${report.diagnosticReportId}`, {
        headers: { cookie: s.visit.doctor },
      })
    ).json(),
  )
  expect(fhir.result).toHaveLength(count)
  expect((await s.completion()).items.find((item) => item.code === 'required-reports-acknowledged')).toMatchObject({
    status: 'incomplete',
    target: 'examination',
  })
  for (const kind of ['laboratory', 'imaging', 'pathology']) {
    const wrong = await s.runtime.app.request(
      `/api/his/v1/${kind}-requests/${reported.id}/reports/${report.diagnosticReportId}/actions/acknowledge`,
      mutation(s.visit.doctor, {
        expectedVersions: { [`DiagnosticReport/${report.diagnosticReportId}`]: report.diagnosticReportVersion },
        input: { expectedRequestVersion: reported.version },
      }),
    )
    expect(wrong.status, `${kind}: ${await wrong.clone().text()}`).toBe(409)
  }
  const input = mutation(s.visit.doctor, {
    expectedVersions: { [`DiagnosticReport/${report.diagnosticReportId}`]: report.diagnosticReportVersion },
    input: { expectedRequestVersion: reported.version },
  })
  const path = `/api/his/v1/examination-requests/${reported.id}/reports/${report.diagnosticReportId}/actions/acknowledge`
  const acknowledged = await s.runtime.app.request(path, input)
  expect(acknowledged.status, await acknowledged.clone().text()).toBe(200)
  expect(await (await s.runtime.app.request(path, input)).json()).toEqual(await acknowledged.json())
  expect((await s.detail()).examinationRequests?.requests[0]?.status).toBe('acknowledged')
  expect((await s.completion()).items.find((item) => item.code === 'required-reports-acknowledged')).toMatchObject({
    status: 'complete',
  })
})

it('心血管病史无精确真值时拒绝正常报告，重试不能绕过来源门禁', async () => {
  const s = await setup(true),
    request = await s.issue()
  await payOutpatientInvestigation(s.runtime, {
    caseId: s.visit.outpatientCaseId,
    category: 'examination',
    chargeItemId: request.billing!.chargeItemId,
  })
  await dispatchAll(s.runtime)
  const failed = (await s.detail()).examinationRequests!.requests[0]!
  expect(failed).toMatchObject({
    status: 'generation-failed',
    generationError: { code: 'INVESTIGATION_TRUTH_INCOMPATIBLE' },
  })
  expect(failed.report).toBeUndefined()
  const retry = await s.runtime.app.request(
    `/api/his/v1/examination-requests/${failed.id}/actions/retry`,
    mutation(s.visit.doctor, {
      expectedVersions: { [`Task/${failed.taskId}`]: failed.taskVersion },
      input: { expectedRequestVersion: failed.version },
    }),
  )
  expect(retry.status).toBe(409)
})

it.each([
  { code: '25569003', display: 'Ventricular tachycardia' },
  { code: '233917008', display: 'Atrioventricular conduction block' },
  { code: '85898001', display: 'Cardiomyopathy' },
  { code: '79619009', display: 'Mitral valve stenosis' },
  { code: '25569003' },
])('心血管阳性病史 $display 不得被当成成人正常基线', async (history) => {
  const s = await setup(true, [], history),
    request = await s.issue()
  await payOutpatientInvestigation(s.runtime, {
    caseId: s.visit.outpatientCaseId,
    category: 'examination',
    chargeItemId: request.billing!.chargeItemId,
  })
  await dispatchAll(s.runtime)
  expect((await s.detail()).examinationRequests!.requests[0]).toMatchObject({
    status: 'generation-failed',
    generationError: { code: 'INVESTIGATION_TRUTH_INCOMPATIBLE' },
  })
  expect((await s.detail()).examinationRequests!.requests[0]!.report).toBeUndefined()
})

it.each([undefined, 'Unclassified synthetic condition'])(
  '未知SNOMED病史不凭缺失或阴性关键词推定正常 display=%s',
  async (display) => {
    const s = await setup(true, [], { code: '999999999', ...(display === undefined ? {} : { display }) }),
      request = await s.issue()
    await payOutpatientInvestigation(s.runtime, {
      caseId: s.visit.outpatientCaseId,
      category: 'examination',
      chargeItemId: request.billing!.chargeItemId,
    })
    await dispatchAll(s.runtime)
    expect((await s.detail()).examinationRequests!.requests[0]).toMatchObject({
      status: 'generation-failed',
      generationError: { code: 'INVESTIGATION_UNSUPPORTED' },
    })
    expect((await s.detail()).examinationRequests!.requests[0]!.report).toBeUndefined()
  },
)

it('新确认心血管阳性事实不能复用先前正常快照', async () => {
  const s = await setup(),
    first = await s.issue()
  await payOutpatientInvestigation(s.runtime, {
    caseId: s.visit.outpatientCaseId,
    category: 'examination',
    chargeItemId: first.billing!.chargeItemId,
  })
  await dispatchAll(s.runtime)
  expect((await s.detail()).examinationRequests?.requests[0]?.status).toBe('reported')
  const expectedVersions = { [`Encounter/${s.visit.encounterId}`]: (await s.detail()).encounter.versionId }
  const saved = await s.runtime.app.request(
    `/api/his/v1/encounters/${s.visit.encounterId}/diagnosis/draft`,
    mutation(
      s.visit.doctor,
      {
        expectedVersions,
        input: { expectedDraftVersion: 0, entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary' }] },
      },
      'PUT',
    ),
  )
  expect(saved.status, await saved.clone().text()).toBe(200)
  const confirmed = await s.runtime.app.request(
    `/api/his/v1/encounters/${s.visit.encounterId}/diagnosis/actions/confirm`,
    mutation(s.visit.doctor, {
      expectedVersions,
      input: { expectedDraftVersion: (await saved.json()).data.draftVersion },
    }),
  )
  expect(confirmed.status, await confirmed.clone().text()).toBe(200)
  const second = await s.issue()
  await payOutpatientInvestigation(s.runtime, {
    caseId: s.visit.outpatientCaseId,
    category: 'examination',
    chargeItemId: second.billing!.chargeItemId,
  })
  await dispatchAll(s.runtime)
  const failed = (await s.detail()).examinationRequests?.requests.find((item) => item.id === second.id)
  expect(failed).toMatchObject({
    status: 'generation-failed',
    generationError: { code: 'INVESTIGATION_TRUTH_INCOMPATIBLE' },
  })
  expect(failed?.report).toBeUndefined()
})

it.each([false, true])('普通心率生命体征不声明ECG精确面板，ECG特异部分真值仍拒绝补齐 specific=%s', async (specific) => {
  const observation = {
    fullUrl: 'urn:uuid:index-heart-rate',
    resource: {
      resourceType: 'Observation',
      id: 'index-heart-rate',
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: specific ? '8625-6' : '8867-4' }] },
      subject: { reference: 'urn:uuid:patient' },
      encounter: { reference: 'urn:uuid:index-encounter' },
      effectiveDateTime: '2026-06-01T10:10:00+08:00',
      valueQuantity: {
        value: specific ? 160 : 72,
        code: specific ? 'ms' : '/min',
        unit: specific ? 'ms' : '/min',
        system: 'http://unitsofmeasure.org',
      },
    },
  }
  const s = await setup(false, [observation]),
    request = await s.issue()
  await payOutpatientInvestigation(s.runtime, {
    caseId: s.visit.outpatientCaseId,
    category: 'examination',
    chargeItemId: request.billing!.chargeItemId,
  })
  await dispatchAll(s.runtime)
  const result = (await s.detail()).examinationRequests!.requests[0]!
  if (specific)
    expect(result).toMatchObject({
      status: 'generation-failed',
      generationError: { code: 'INVESTIGATION_TRUTH_INCOMPATIBLE' },
    })
  else {
    expect(result.status).toBe('reported')
    expect(result.report!.results.find((item) => item.code === 'ventricular-rate')).toMatchObject({
      value: 72,
      source: 'adult-reference-baseline',
    })
  }
})

it.each([
  { location: 'hidden', value: 180, unit: '/min' },
  { location: 'hidden', value: 40, unit: '/min' },
  { location: 'hidden', value: 72, unit: '/min', flag: 'H' },
  { location: 'hidden', value: 72, unit: 'unknown' },
  { location: 'history', value: 180, unit: '/min' },
  { location: 'formal', value: 180, unit: '/min' },
])('普通心率异常或不可判定时拒绝正常基线 $location $value $unit $flag', async ({ location, value, unit, flag }) => {
  const observation = { fullUrl: 'urn:uuid:abnormal-heart-rate', resource: { resourceType: 'Observation', id: 'abnormal-heart-rate', status: 'final',
    code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] }, subject: { reference: 'urn:uuid:patient' },
    encounter: { reference: location === 'history' ? 'urn:uuid:prior-encounter' : 'urn:uuid:index-encounter' },
    effectiveDateTime: location === 'history' ? '2025-01-10T09:05:00+08:00' : '2026-06-01T10:10:00+08:00',
    valueQuantity: { value, code: unit, unit, system: 'http://unitsofmeasure.org' },
    ...(flag === undefined ? {} : { interpretation: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: flag }] }] }),
  } }
  const s = await setup(false, location === 'formal' ? [] : [observation], undefined, location === 'formal' ? value : undefined)
  const request = await s.issue()
  await payOutpatientInvestigation(s.runtime, { caseId: s.visit.outpatientCaseId, category: 'examination', chargeItemId: request.billing!.chargeItemId })
  await dispatchAll(s.runtime)
  expect((await s.detail()).examinationRequests!.requests[0]).toMatchObject({ status: 'generation-failed', generationError: { code: 'INVESTIGATION_TRUTH_INCOMPATIBLE' } })
  expect((await s.detail()).examinationRequests!.requests[0]!.report).toBeUndefined()
})

it.each([
  { code: '10230-1', display: 'Left ventricular ejection fraction', value: 30, unit: '%', component: false, serviceId: 'examination-tte', expectedStatus: 'generation-failed' },
  { code: '8636-3', display: 'QTc interval', value: 650, unit: 'ms', component: true, serviceId: 'examination-ecg-12-lead', expectedStatus: 'generation-failed' },
  { code: '10230-1', display: 'Left ventricular ejection fraction', value: 62, unit: '%', component: false, serviceId: 'examination-tte', expectedStatus: 'reported' },
])('既往已支持功能指标按正常范围约束基线 $code $value $component', async ({ code, display, value, unit, component, serviceId, expectedStatus }) => {
  const measurement = { code: { coding: [{ system: 'http://loinc.org', code, display }] },
    valueQuantity: { value, code: unit, unit, system: 'http://unitsofmeasure.org' } }
  const observation = { fullUrl: 'urn:uuid:prior-functional-measurement', resource: {
    resourceType: 'Observation', id: 'prior-functional-measurement', status: 'final',
    subject: { reference: 'urn:uuid:patient' }, encounter: { reference: 'urn:uuid:prior-encounter' },
    effectiveDateTime: '2025-01-10T09:05:00+08:00',
    ...(component ? { code: { text: '既往功能指标组合' }, component: [measurement] } : measurement),
  } }
  const s = await setup(false, [observation])
  const request = await s.issue(serviceId)
  await payOutpatientInvestigation(s.runtime, { caseId: s.visit.outpatientCaseId, category: 'examination', chargeItemId: request.billing!.chargeItemId })
  await dispatchAll(s.runtime)
  const result = (await s.detail()).examinationRequests!.requests[0]!
  expect(result.status).toBe(expectedStatus)
  if (expectedStatus === 'generation-failed') {
    expect(result.generationError?.code).toBe('INVESTIGATION_TRUTH_INCOMPATIBLE')
    expect(result.report).toBeUndefined()
  } else {
    expect(result.report?.results.find(item => item.code === 'lvef')).toMatchObject({ value: 62, source: 'adult-reference-baseline' })
  }
})

it('未付费取消保持原收费冲减且不产生报告', async () => {
  const s = await setup(),
    request = await s.issue()
  const cancel = await s.runtime.app.request(
    `/api/his/v1/examination-requests/${request.id}/actions/cancel`,
    mutation(s.visit.doctor, {
      expectedVersions: {
        [`ServiceRequest/${request.serviceRequestId}`]: request.serviceRequestVersion,
        [`Task/${request.taskId}`]: request.taskVersion,
      },
      input: { expectedRequestVersion: request.version, reasonCode: 'no-longer-needed' },
    }),
  )
  expect(cancel.status, await cancel.clone().text()).toBe(200)
  await dispatchAll(s.runtime)
  expect((await s.detail()).examinationRequests?.requests[0]).toMatchObject({ status: 'cancelled' })
  const cashier = await signIn(s.runtime, 'cashier@demo.clinmesh.local')
  const bill = billingCaseSchema.parse(
    await (
      await s.runtime.app.request(`/api/his/v1/billing/cases/${s.visit.outpatientCaseId}`, {
        headers: { cookie: cashier },
      })
    ).json(),
  )
  expect(bill.charges.find((charge) => charge.chargeItemId === request.billing!.chargeItemId)).toMatchObject({
    remainingFen: 0,
  })
})

it('报告事务失败后的人工重试和相同病例 Epoch 重放复用固定结果快照', async () => {
  const s = await setup(),
    request = await s.issue()
  // A temporary database failure models a report publication failure after result resolution.
  s.runtime.database.driver.exec(
    "CREATE TEMP TRIGGER examination_report_fault BEFORE INSERT ON examination_report_content BEGIN SELECT RAISE(ABORT,'synthetic report publication failure'); END",
  )
  await payOutpatientInvestigation(s.runtime, {
    caseId: s.visit.outpatientCaseId,
    category: 'examination',
    chargeItemId: request.billing!.chargeItemId,
  })
  await dispatchAll(s.runtime)
  const snapshots = () =>
    z
      .array(z.object({ snapshot_id: z.string(), input_hash: z.string(), result_json: z.string() }))
      .parse(
        s.runtime.database.driver
          .prepare('SELECT snapshot_id,input_hash,result_json FROM investigation_result_snapshot')
          .all(),
      )
  const original = snapshots()
  expect(original).toHaveLength(1)
  const failed = (await s.detail()).examinationRequests!.requests[0]!
  expect(failed.status).toBe('generation-failed')
  s.runtime.database.driver.exec('DROP TRIGGER examination_report_fault')
  const retry = await s.runtime.app.request(
    `/api/his/v1/examination-requests/${failed.id}/actions/retry`,
    mutation(s.visit.doctor, {
      expectedVersions: { [`Task/${failed.taskId}`]: failed.taskVersion },
      input: { expectedRequestVersion: failed.version },
    }),
  )
  expect(retry.status, await retry.clone().text()).toBe(200)
  await dispatchAll(s.runtime)
  expect((await s.detail()).examinationRequests?.requests[0]?.status).toBe('reported')
  expect(snapshots()).toEqual(original)
  const reset = await s.runtime.app.request(
    '/api/sim/v1/scenario-runs/scenario-run-1/actions/reset',
    mutation(s.admin, {}),
  )
  expect(reset.status).toBe(200)
  const triageNurse = await signIn(s.runtime, 'triage@demo.clinmesh.local')
  const queued = triageQueueSchema
    .parse(await (await s.runtime.app.request('/api/his/v1/triage/queue', { headers: { cookie: triageNurse } })).json())
    .items.find((item) => item.patient.name === '功能检查合成患者')!
  expect(queued).toBeDefined()
  const triaged = await s.runtime.app.request(
    `/api/his/v1/encounters/${queued.encounterId}/actions/record-triage`,
    mutation(triageNurse, {
      expectedVersions: {
        [`Encounter/${queued.encounterId}`]: queued.encounterVersion,
        [`Task/${queued.taskId}`]: queued.taskVersion,
      },
      input: {
        acuityCode: 'level-3',
        bloodPressure: { diastolicMmHg: 80, systolicMmHg: 122 },
        chiefComplaint: persona.chiefComplaint,
        oxygenSaturationPct: 98,
        pulseBpm: 86,
        respirationBpm: 18,
        temperatureC: 36.7,
      },
    }),
  )
  expect(triaged.status, await triaged.clone().text()).toBe(200)
  const triage = triageResponseSchema.parse(await triaged.json()).data
  const doctor = await signIn(s.runtime, 'doctor@demo.clinmesh.local')
  const start = await s.runtime.app.request(
    `/api/his/v1/encounters/${queued.encounterId}/actions/start-first-visit`,
    mutation(doctor, {
      expectedVersions: { [`Encounter/${queued.encounterId}`]: '2', [`Task/${triage.doctorTaskId}`]: '1' },
      input: {},
    }),
  )
  expect(start.status, await start.clone().text()).toBe(200)
  const visit = { doctor, encounterId: queued.encounterId, outpatientCaseId: queued.caseId }
  const saved = await s.runtime.app.request(
    `/api/his/v1/encounters/${visit.encounterId}/examination-request/draft`,
    mutation(
      visit.doctor,
      {
        expectedVersions: { [`Encounter/${visit.encounterId}`]: '3' },
        input: { expectedDraftVersion: 0, serviceId: 'examination-ecg-12-lead', indication: '胸部不适评估' },
      },
      'PUT',
    ),
  )
  expect(saved.status, await saved.clone().text()).toBe(200)
  const issued = await s.runtime.app.request(
    `/api/his/v1/encounters/${visit.encounterId}/examination-request/actions/issue`,
    mutation(visit.doctor, {
      expectedVersions: { [`Encounter/${visit.encounterId}`]: '3' },
      input: { expectedDraftVersion: 1 },
    }),
  )
  expect(issued.status, await issued.clone().text()).toBe(200)
  const replayed = examinationRequestSchema.parse((await issued.json()).data.request)
  await payOutpatientInvestigation(s.runtime, {
    caseId: visit.outpatientCaseId,
    category: 'examination',
    chargeItemId: replayed.billing!.chargeItemId,
  })
  await dispatchAll(s.runtime)
  expect(snapshots()).toEqual(original)
})

const exactTte = [
  { code: 'lvef', value: 35, unit: '%' },
  { code: 'lvedd', value: 62, unit: 'mm' },
  { code: 'regional-wall-motion', value: '前壁运动减弱' },
  { code: 'valves', value: '二尖瓣少量反流' },
  { code: 'diastolic-function', value: '左室舒张功能减低' },
].map((item, index) => ({
  fullUrl: `urn:uuid:exact-tte-${index}`,
  resource: {
    resourceType: 'Observation',
    id: `exact-tte-${index}`,
    status: 'final',
    code: {
      coding: [
        { system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/examination-service', code: item.code },
      ],
    },
    subject: { reference: 'urn:uuid:patient' },
    encounter: { reference: 'urn:uuid:index-encounter' },
    effectiveDateTime: '2026-06-01T10:10:00+08:00',
    ...(typeof item.value === 'number'
      ? { valueQuantity: { value: item.value, unit: item.unit, system: 'http://unitsofmeasure.org', code: item.unit } }
      : { valueString: item.value }),
  },
}))

it.each([false, true])('同一TTE指标的冲突精确真值不受数组顺序影响 reverse=%s', async (reverse) => {
  const duplicate = {
    ...exactTte[0]!,
    fullUrl: 'urn:uuid:conflicting-lvef',
    resource: {
      ...exactTte[0]!.resource,
      id: 'conflicting-lvef',
      valueQuantity: { value: 62, unit: '%', code: '%', system: 'http://unitsofmeasure.org' },
    },
  }
  const observations = [...exactTte, duplicate]
  const s = await setup(true, reverse ? observations.reverse() : observations),
    request = await s.issue('examination-tte')
  await payOutpatientInvestigation(s.runtime, {
    caseId: s.visit.outpatientCaseId,
    category: 'examination',
    chargeItemId: request.billing!.chargeItemId,
  })
  await dispatchAll(s.runtime)
  expect((await s.detail()).examinationRequests!.requests[0]).toMatchObject({
    status: 'generation-failed',
    generationError: { code: 'INVESTIGATION_TRUTH_INCOMPATIBLE' },
  })
  expect((await s.detail()).examinationRequests!.requests[0]!.report).toBeUndefined()
})

it('同一TTE指标的相同精确真值可以去重签发', async () => {
  const duplicate = {
    ...exactTte[0]!,
    fullUrl: 'urn:uuid:duplicate-lvef',
    resource: { ...exactTte[0]!.resource, id: 'duplicate-lvef' },
  }
  const s = await setup(true, [...exactTte, duplicate]),
    request = await s.issue('examination-tte')
  await payOutpatientInvestigation(s.runtime, {
    caseId: s.visit.outpatientCaseId,
    category: 'examination',
    chargeItemId: request.billing!.chargeItemId,
  })
  await dispatchAll(s.runtime)
  expect((await s.detail()).examinationRequests!.requests[0]).toMatchObject({ status: 'reported' })
  expect(
    (await s.detail()).examinationRequests!.requests[0]!.report?.results.find((result) => result.code === 'lvef'),
  ).toMatchObject({ value: 35 })
})

it.each([true, false])('精确 TTE 真值 complete=%s 保留异常数值并拒绝补造缺失结果', async (complete) => {
  const s = await setup(true, complete ? exactTte : exactTte.slice(0, 1)),
    request = await s.issue('examination-tte')
  await payOutpatientInvestigation(s.runtime, {
    caseId: s.visit.outpatientCaseId,
    category: 'examination',
    chargeItemId: request.billing!.chargeItemId,
  })
  await dispatchAll(s.runtime)
  const result = (await s.detail()).examinationRequests!.requests[0]!
  if (complete) {
    expect(result.status).toBe('reported')
    expect(result.report?.results.find((item) => item.code === 'lvef')).toMatchObject({
      value: 35,
      interpretation: 'low',
      source: 'case-truth-exact',
    })
  } else {
    expect(result).toMatchObject({
      status: 'generation-failed',
      generationError: { code: 'INVESTIGATION_TRUTH_INCOMPATIBLE' },
    })
    expect(result.report).toBeUndefined()
  }
})

it('无素材包住院 ECG/TTE 由护士送检、执行计费并按功能检查已阅', async () => {
  const s = await setup(),
    registrar = await signIn(s.runtime, 'registrar@demo.clinmesh.local')
  const doctor = await signIn(s.runtime, 'inpatient-doctor@demo.clinmesh.local'),
    nurse = await signIn(s.runtime, 'ward-nurse@demo.clinmesh.local')
  const request = (cookie: string, path: string, input?: unknown) =>
    s.runtime.app.request(path, input === undefined ? { headers: { cookie } } : mutation(cookie, { input }))
  const patient = fhirResourceSchema.parse(
    await (await request(registrar, `/fhir/R5/Patient/${s.visit.patientId}`)).json(),
  )
  const registered = await request(registrar, '/api/his/v1/inpatient/admissions', {
    expectedEpoch: 'epoch-1',
    patientId: patient.id,
    patientVersion: patient.meta!.versionId,
    admissionRoute: 'direct',
    wardId: 'ward-general',
    depositFen: 100000,
  })
  expect(registered.status, await registered.clone().text()).toBe(200)
  const registration = inpatientCommandResponseSchema.parse(await registered.json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${registration.id}`
  const admission = inpatientCommandResponseSchema.parse(
    await (
      await request(nurse, `${path}/receive`, { encounterVersion: registration.versionId, bedId: 'bed-general-1' })
    ).json(),
  ).data.admission
  for (const serviceId of ['examination-ecg-12-lead', 'examination-tte']) {
    const response = await request(doctor, `${path}/investigations/issue`, {
      encounterVersion: admission.versionId,
      catalogVersion: 1,
      selection: { kind: 'examination', serviceId, indication: '住院心功能评估' },
    })
    expect(response.status, await response.clone().text()).toBe(200)
    const issued = inpatientInvestigationResponseSchema
      .parse(await response.json())
      .data.examinationRequests.find((item) => item.service.id === serviceId)!
    const sent = await request(nurse, `${path}/investigations/send`, {
      requestId: issued.id,
      expectedRequestVersion: issued.version,
      serviceRequestVersion: issued.serviceRequestVersion,
      taskVersion: issued.taskVersion,
    })
    expect(sent.status, await sent.clone().text()).toBe(200)
  }
  await dispatchAll(s.runtime)
  const facts = inpatientInvestigationsSchema.parse(await (await request(doctor, `${path}/investigations`)).json())
  expect(facts.examinationRequests.map((item) => item.status)).toEqual(['reported', 'reported'])
  for (const reported of facts.examinationRequests) {
    const report = reported.report!
    const ack = await request(doctor, `${path}/investigations/acknowledge`, {
      requestId: reported.id,
      expectedRequestVersion: reported.version,
      serviceRequestVersion: reported.serviceRequestVersion,
      taskVersion: reported.taskVersion,
      diagnosticReportId: report.diagnosticReportId,
      diagnosticReportVersion: report.diagnosticReportVersion,
    })
    expect(ack.status, await ack.clone().text()).toBe(200)
  }
  const cashier = await signIn(s.runtime, 'cashier@demo.clinmesh.local')
  const charges = inpatientChargesSchema.parse(await (await request(cashier, `${path}/charges`)).json())
  expect(charges.charges.map((item) => ({ kind: item.kind, amount: item.amountFen }))).toEqual([
    { kind: 'examination', amount: 3000 },
    { kind: 'examination', amount: 18000 },
  ])
})
