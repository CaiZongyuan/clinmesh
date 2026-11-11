import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import {
  acknowledgeImagingReportResponseSchema,
  acknowledgeLaboratoryReportResponseSchema,
  acknowledgePathologyReportResponseSchema,
  apiErrorSchema,
  doctorCaseDetailSchema,
  imagingRequestDraftResponseSchema,
  issueImagingRequestResponseSchema,
  issueLaboratoryRequestResponseSchema,
  issuePathologyRequestResponseSchema,
  laboratoryRequestDraftResponseSchema,
  laboratoryServiceSnapshotSchema,
  pathologyRequestDraftResponseSchema,
  sessionContextSchema,
} from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { installSyntheticImagingAssets } from './fixtures/imaging-catalog.ts'
import {
  createImagingRuntime, generateCase, mutation, prepareImaging, signIn, snomed, startConsultation,
} from './fixtures/imaging-scenario.ts'
import { installSyntheticPathologySlides } from './fixtures/pathology-catalog.ts'
import { breastCaseBundle, preparePathology } from './fixtures/pathology-scenario.ts'
import { payOutpatientInvestigation } from './fixtures/pay-outpatient-investigation.ts'

const kinds = ['laboratory', 'imaging', 'pathology'] as const
const schemas = {
  laboratory: acknowledgeLaboratoryReportResponseSchema,
  imaging: acknowledgeImagingReportResponseSchema,
  pathology: acknowledgePathologyReportResponseSchema,
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

/** 同患者三类正式报告；仅目录配置为合成输入，业务状态全部由公共 HTTP 与受控出站执行产生。 */
async function setup() {
  const source = breastCaseBundle({ name: '连续报告已阅合成患者' })
  const created = await createImagingRuntime([{ ...source, entry: [...source.entry, {
    fullUrl: 'urn:uuid:report-reader-fever', resource: {
      resourceType: 'Condition', id: 'report-reader-fever',
      code: { coding: [{ system: snomed, code: '386661006', display: '发热' }] },
      encounter: { reference: 'urn:uuid:index-encounter' }, subject: { reference: 'urn:uuid:patient' },
      recordedDate: '2026-06-01T10:05:00+08:00',
    },
  }, {
    fullUrl: 'urn:uuid:report-reader-wbc', resource: {
      resourceType: 'Observation', id: 'report-reader-wbc', status: 'final',
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
    assets: [{ assetId: 'report-reader-radiograph', examCode: 'chest-radiograph' }],
    matching: {
      codeSystem: snomed, ruleVersion: 1, schemaVersion: 1, sourceExamCodes: {}, uncoveredConditions: [],
      profiles: [{ ageRange: [18, 90], indexConditionCodes: ['386661006'], finding: 'negative', sex: 'female',
        id: 'report-reader-chest', label: '合成连续阅读胸片', assets: { 'chest-radiograph': 'report-reader-radiograph' } }],
    },
  })
  await installSyntheticPathologySlides({
    assetDirectory: created.pathologyAssetDirectory, catalogDirectory: created.pathologyCatalogDirectory,
    slides: [{ assetId: 'report-reader-slide' }],
  })
  const admin = await signIn(runtime)
  const context = await runtime.app.request('/api/auth/context', { headers: { cookie: admin } })
  expect(context.status).toBe(200)
  const actor = sessionContextSchema.parse(await context.json()).actor
  const concept = { id: 'loinc:synthetic:6690-2', system: 'http://loinc.org', code: '6690-2', display: '白细胞计数',
    version: '2.83', sourceLocator: 'synthetic:loinc:6690-2' }
  const laboratoryService = laboratoryServiceSnapshotSchema.parse({
    id: 'synthetic-reader-wbc', version: 1, serviceKind: 'laboratory', doctorOrderable: true,
    localCode: 'SYN-READER-WBC', nameZh: '合成白细胞计数', referenceConcept: concept,
    referenceReleaseId: 'synthetic-reader-release', componentServiceIds: [], executingDepartmentId: 'department-laboratory',
    allowedIndicationCodes: ['clinical-assessment'], specimen: { code: '119297000', display: '血液标本' }, tatMinutes: 20, priceFen: 800,
    outpatientBilling: { id: 'synthetic-reader-wbc-price', version: 1, priceFen: 800, currency: 'CNY', unit: '项目',
      source: 'synthetic-report-reader-fixture', effectiveOn: '2026-08-24' },
    reportDefinition: { conclusionTemplate: '白细胞计数结果已完成。', results: [{ referenceConcept: concept, valueType: 'quantity',
      referenceRange: { low: 4, high: 10, text: '4.0-10.0 x10^9/L' },
      unit: { system: 'http://unitsofmeasure.org', code: '10*9/L', display: '10^9/L' } }] },
  })
  runtime.database.driver.prepare(`INSERT INTO hospital_service_catalog
    (workspace_id,epoch,service_id,code,name_zh,name_en,version,active,config_json) VALUES(?,?,?,?,?,?,1,1,?)`)
    .run(actor.workspaceId, actor.epoch, laboratoryService.id, laboratoryService.localCode, laboratoryService.nameZh,
      laboratoryService.nameZh, JSON.stringify({ laboratoryService, availableScopes: ['outpatient'] }))
  const sourceCaseId = await generateCase(runtime, admin)
  await prepareImaging(runtime, admin, [sourceCaseId])
  await preparePathology(runtime, admin, [sourceCaseId])
  const visit = await startConsultation(runtime, admin, sourceCaseId)
  let doctor = visit.doctor
  const expectedVersions = { [`Encounter/${visit.encounterId}`]: '3' }
  for (const kind of kinds) {
    const input = kind === 'laboratory'
      ? { catalogItemId: laboratoryService.id, indicationCode: 'clinical-assessment', expectedDraftVersion: 0 }
      : kind === 'imaging'
        ? { serviceId: 'imaging-chest-radiograph', indication: '合成连续报告阅读', expectedDraftVersion: 0 }
        : { serviceId: 'pathology-breast-slide-consultation', sourceProcedureReference: 'urn:uuid:procedure-0',
            purpose: '合成既往切片复核', expectedDraftVersion: 0 }
    const draftResponse = await runtime.app.request(`/api/his/v1/encounters/${visit.encounterId}/${kind}-request/draft`,
      mutation(doctor, { expectedVersions, input }, 'PUT'))
    expect(draftResponse.status, await draftResponse.clone().text()).toBe(200)
    const draftSchema = { laboratory: laboratoryRequestDraftResponseSchema, imaging: imagingRequestDraftResponseSchema,
      pathology: pathologyRequestDraftResponseSchema }[kind]
    const { draftVersion } = draftSchema.parse(await draftResponse.json()).data
    const issued = await runtime.app.request(`/api/his/v1/encounters/${visit.encounterId}/${kind}-request/actions/issue`,
      mutation(doctor, { expectedVersions, input: { expectedDraftVersion: draftVersion } }))
    expect(issued.status, await issued.clone().text()).toBe(200)
    const issueSchema = { laboratory: issueLaboratoryRequestResponseSchema, imaging: issueImagingRequestResponseSchema,
      pathology: issuePathologyRequestResponseSchema }[kind]
    const { request } = issueSchema.parse(await issued.json()).data
    await payOutpatientInvestigation(runtime, {
      caseId: visit.outpatientCaseId, category: kind, chargeItemId: request.billing!.chargeItemId,
    })
  }
  await runtime.dispatchPending()
  const readCase = async () => {
    const response = await runtime.app.request(`/api/his/v1/doctor/cases/${visit.outpatientCaseId}`, { headers: { cookie: doctor } })
    expect(response.status).toBe(200)
    return doctorCaseDetailSchema.parse(await response.json())
  }
  const detail = await readCase()
  const attempts = kinds.map(kind => {
    const request = detail[`${kind}Requests`]!.requests[0]!
    expect(request.status).toBe('reported')
    expect(request.report).toBeDefined()
    const report = request.report!
    return { kind, request, report, key: randomUUID(), operationId: `${kind}-report.acknowledge`, body: {
      expectedVersions: { [`DiagnosticReport/${report.diagnosticReportId}`]: report.diagnosticReportVersion },
      input: { expectedRequestVersion: request.version },
    } }
  })
  const readResources = async () => Promise.all(attempts.flatMap(({ request, report }) => [
    `DiagnosticReport/${report.diagnosticReportId}`, `ServiceRequest/${request.serviceRequestId}`, `Task/${request.taskId}`,
  ]).map(async reference => {
    const response = await runtime.app.request(`/fhir/R5/${reference}`, { headers: { cookie: doctor } })
    expect(response.status).toBe(200)
    return fhirResourceSchema.parse(await response.json())
  }))
  return {
    attempts, readCase, readResources,
    acknowledge(attempt: typeof attempts[number]) {
      const options = mutation(doctor, attempt.body)
      options.headers['idempotency-key'] = attempt.key
      return runtime.app.request(
        `/api/his/v1/${attempt.kind}-requests/${attempt.request.id}/reports/${attempt.report.diagnosticReportId}/actions/acknowledge`, options)
    },
    async lookup(attempt: typeof attempts[number]) {
      const response = await runtime.app.request(`/api/his/v1/command-receipts?${new URLSearchParams({
        operationId: attempt.operationId, idempotencyKey: attempt.key,
      })}`, { headers: { cookie: doctor } })
      expect(response.status).toBe(200)
      const receipt = commandReceiptLookupSchema.parse(await response.json())
      expect(receipt).toMatchObject({ operationId: attempt.operationId, idempotencyKey: attempt.key, status: 'completed' })
      return schemas[attempt.kind].parse(receipt.response)
    },
    async restart() {
      await runtime.close()
      runtime = await createClinMeshRuntime(created.runtimeOptions)
      doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
    },
  }
}

describe('门诊同患者多份报告的独立已阅合同', () => {
  it('三类报告依次确认，响应丢失经原回执与重启重放恢复唯一事实且不改签发资源', async () => {
    const s = await setup()
    const beforeResources = await s.readResources()
    const [first, lost, unsent] = s.attempts
    const firstResponse = await s.acknowledge(first!)
    expect(firstResponse.status).toBe(200)
    const firstReceipt = schemas[first!.kind].parse(await firstResponse.json())
    // 第二项实际提交成功后丢弃响应体；第三项留待恢复完成后明确提交。
    expect((await s.acknowledge(lost!)).status).toBe(200)
    const recovered = await s.lookup(lost!)
    const pending = await s.readCase()
    expect(pending.pathologyRequests!.requests[0]).toMatchObject({ id: unsent!.request.id, status: 'reported', version: unsent!.request.version })
    expect(pending.pathologyRequests!.requests[0]!.report!.acknowledgement).toBeUndefined()
    await s.restart()
    expect(await s.lookup(lost!)).toEqual(recovered)
    expect(await s.lookup(first!)).toEqual(firstReceipt)
    for (const [attempt, receipt] of [[first!, firstReceipt], [lost!, recovered]] as const) {
      const replay = await s.acknowledge(attempt)
      expect(replay.status).toBe(200)
      expect(schemas[attempt.kind].parse(await replay.json())).toEqual(receipt)
    }
    const lastResponse = await s.acknowledge(unsent!)
    expect(lastResponse.status).toBe(200)
    const lastReceipt = schemas[unsent!.kind].parse(await lastResponse.json())
    const receipts = [firstReceipt, recovered, lastReceipt]
    expect(new Set(receipts.map(receipt => receipt.data.acknowledgementId)).size).toBe(3)
    const after = await s.readCase()
    for (const [index, attempt] of s.attempts.entries()) {
      const receipt = receipts[index]!
      expect(receipt.data).toMatchObject({ requestId: attempt.request.id, diagnosticReportId: attempt.report.diagnosticReportId,
        requestVersion: attempt.request.version + 1, status: 'acknowledged',
        acknowledgedBy: expect.any(String), acknowledgedAt: expect.any(String) })
      expect(receipt.effects).toEqual([{ kind: 'created', reference: `ReportAcknowledgement/${receipt.data.acknowledgementId}`, versionId: '1' }])
      const requests = after[`${attempt.kind}Requests`]!.requests
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ id: attempt.request.id, status: 'acknowledged', version: attempt.request.version + 1,
        report: { status: 'final', diagnosticReportId: attempt.report.diagnosticReportId,
          diagnosticReportVersion: attempt.report.diagnosticReportVersion,
          acknowledgement: { id: receipt.data.acknowledgementId, acknowledgedAt: receipt.data.acknowledgedAt, acknowledgedBy: receipt.data.acknowledgedBy } } })
      const duplicate = await s.acknowledge({ ...attempt, key: randomUUID() })
      expect(duplicate.status).toBe(200)
      const duplicateReceipt = schemas[attempt.kind].parse(await duplicate.json())
      expect(duplicateReceipt.data).toEqual(receipt.data)
      expect(duplicateReceipt.effects).toEqual([])
      expect(await s.lookup(attempt)).toEqual(receipt)
    }
    expect(await s.readCase()).toEqual(after)
    expect(await s.readResources()).toEqual(beforeResources)
    for (const resource of beforeResources.filter(resource => resource.resourceType === 'DiagnosticReport')) {
      expect(resource.status).toBe('final')
    }
  })

  it.each(kinds)('%s 拒绝旧报告资源版本与旧申请版本且不污染其他报告', async kind => {
    const s = await setup()
    const before = await s.readCase()
    const beforeResources = await s.readResources()
    const target = s.attempts.find(attempt => attempt.kind === kind)!
    for (const stale of [
      { body: { ...target.body, expectedVersions: { [`DiagnosticReport/${target.report.diagnosticReportId}`]: '0' } },
        code: 'EXPECTED_VERSION_CONFLICT' },
      { body: { ...target.body, input: { expectedRequestVersion: target.request.version - 1 } },
        code: `${kind.toUpperCase()}_REQUEST_VERSION_CONFLICT` },
    ]) {
      const response = await s.acknowledge({ ...target, key: randomUUID(), body: stale.body })
      expect(response.status).toBe(409)
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe(stale.code)
      expect(await s.readCase()).toEqual(before)
      expect(await s.readResources()).toEqual(beforeResources)
    }
    const other = s.attempts.find(attempt => attempt.kind !== kind)!
    const response = await s.acknowledge(other)
    expect(response.status).toBe(200)
    const receipt = schemas[other.kind].parse(await response.json())
    const after = await s.readCase()
    for (const attempt of s.attempts) {
      if (attempt.kind === other.kind) {
        expect(after[`${attempt.kind}Requests`]!.requests[0]).toMatchObject({
          id: attempt.request.id, status: 'acknowledged', version: attempt.request.version + 1,
          report: { acknowledgement: { id: receipt.data.acknowledgementId } },
        })
      } else {
        expect(after[`${attempt.kind}Requests`]).toEqual(before[`${attempt.kind}Requests`])
      }
    }
    expect(await s.readResources()).toEqual(beforeResources)
  })
})
