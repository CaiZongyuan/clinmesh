import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { apiErrorSchema, casePathologyServiceCatalogSchema, doctorCaseDetailSchema, issuePathologyRequestResponseSchema, pathologyRequestDraftResponseSchema } from '@clinmesh/contracts/his'
import { CommandExecutor } from '../src/application/command-executor.ts'
import { externalPathologyCatalogSchema, externalPathologyReportHash } from '../src/application/pathology-external-catalog.ts'
import { AuthoredCasePackService } from '../src/application/scenario-data/authored-case-pack-service.ts'
import { compiledPathologyAuthoredCasePack } from '../src/application/scenario-data/pathology-authored-case-pack.ts'
import { PatientPersonaRepository } from '../src/infrastructure/sqlite/patient-persona-repository.ts'
import { SyntheticCaseRepository } from '../src/infrastructure/sqlite/synthetic-case-repository.ts'
import { SyntheticPatientProfileRepository } from '../src/infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { mutation, signIn, startConsultation } from './fixtures/imaging-scenario.ts'
import { payOutpatientInvestigation } from './fixtures/pay-outpatient-investigation.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

for (const organ of ['colorectal', 'thyroid'] as const) it(`completes the ${organ} public consultation lifecycle with frozen original fee and same-slide correction`, async () => {
  const output = { kind: 'pathjx' as const, instanceId: 'synthetic-instance', assetKey: `synthetic-${organ}`, contentHash: (organ === 'thyroid' ? 'a' : 'b').repeat(64), organ, specimenType: organ === 'thyroid' ? 'surgical_resection' : 'polypectomy', stain: 'HE' as const }
  const report = { revision: 1, diagnosis: `${organ} 合成会诊诊断`, immunohistochemistry: '未提供免疫组化切片。', microscopy: '既往标本 H&E 组织，合成测试所见。', note: '纯合成测试，不作医学诊断。' }
  const review = (value: typeof report) => ({ ...value, review: { conclusion: 'approved' as const, contentHash: externalPathologyReportHash({ output }, value), reviewedAt: '2026-11-20T00:00:00Z', reviewer: 'Synthetic Reviewer' } })
  const asset = externalPathologyCatalogSchema.parse({ packId: 'synthetic-pathjx-slides', ruleVersion: 1, assets: [{
    assetId: `synthetic-${organ}-slide`, diagnosis: { system: 'http://snomed.info/sct', code: organ === 'thyroid' ? '237495005' : '68496003' },
    examCode: `${organ}-slide-consultation`, license: { source: 'https://example.invalid/synthetic', identifier: 'synthetic', attribution: 'Synthetic fixture', deidentified: true, synthetic: true },
    output, sourceSpecimenType: organ === 'thyroid' ? 'prior-thyroid-surgical-specimen' : 'prior-colorectal-polypectomy', reports: [review(report)],
  }] }).assets[0]!
  let available = true
  const directory = await mkdtemp(join(tmpdir(), `clinmesh-${organ}-http-`))
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters', cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'runtime.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', autoDispatchIntervalMs: 0, migrationMode: 'apply', trustedOrigins: ['http://localhost'],
    pathologyExternalSource: { catalog: async () => ({ packId: 'synthetic-pathjx-slides', ruleVersion: 1, assets: [asset] }), available: async (_asset, workspaceId) => available && workspaceId === 'workspace-demo' },
  })
  cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
  const admin = await signIn(runtime), context = (await runtime.identity.resolveSessionContext(new Headers({ cookie: admin }))).actor
  const cases = new SyntheticCaseRepository(runtime.database), profiles = new SyntheticPatientProfileRepository(runtime.database)
  const pack = new AuthoredCasePackService(new CommandExecutor(runtime.database, runtime.fhir), profiles, cases, new PatientPersonaRepository(runtime.database, cases), compiledPathologyAuthoredCasePack)
  const selected = pack.prepare(context, { expectedEpoch: context.epoch }, `prepare-${organ}`).data.cases.find(item => item.draftId.includes(organ))!.case!
  const prep = await runtime.app.request('/api/sim/v1/admin/pathology-preparations', mutation(admin, { input: { caseIds: [selected.caseId] } }))
  expect(prep.status, await prep.clone().text()).toBe(200)
  const visit = await startConsultation(runtime, admin, selected.caseId)
  const detail = async () => {
    const response = await runtime.app.request(`/api/his/v1/doctor/cases/${visit.outpatientCaseId}`, { headers: { cookie: visit.doctor } })
    expect(response.status).toBe(200)
    return doctorCaseDetailSchema.parse(await response.json())
  }
  const catalogResponse = await runtime.app.request(`/api/his/v1/doctor/cases/${visit.outpatientCaseId}/pathology-services`, { headers: { cookie: visit.doctor } })
  expect(catalogResponse.status).toBe(200)
  const service = casePathologyServiceCatalogSchema.parse(await catalogResponse.json()).items.find(item => item.service.examCode === `${organ}-slide-consultation`)!
  expect(service).toMatchObject({ available: true, sourceProcedures: [expect.objectContaining({ specimenType: asset.sourceSpecimenType })] })
  const expectedVersions = { [`Encounter/${visit.encounterId}`]: '3' }
  const draftResponse = await runtime.app.request(`/api/his/v1/encounters/${visit.encounterId}/pathology-request/draft`, mutation(visit.doctor, {
    expectedVersions, input: { expectedDraftVersion: 0, purpose: '复核既往标本切片', serviceId: service.service.id, sourceProcedureReference: service.sourceProcedures[0]!.sourceReference },
  }, 'PUT'))
  expect(draftResponse.status, await draftResponse.clone().text()).toBe(200)
  const draft = pathologyRequestDraftResponseSchema.parse(await draftResponse.json()).data
  const issueResponse = await runtime.app.request(`/api/his/v1/encounters/${visit.encounterId}/pathology-request/actions/issue`, mutation(visit.doctor, { expectedVersions, input: { expectedDraftVersion: draft.draftVersion } }))
  expect(issueResponse.status, await issueResponse.clone().text()).toBe(200)
  const issued = issuePathologyRequestResponseSchema.parse(await issueResponse.json()).data
  expect(issued.request.billing!.price.priceFen).toBe(20000)
  await payOutpatientInvestigation(runtime, { caseId: visit.outpatientCaseId, category: 'pathology', chargeItemId: issued.request.billing!.chargeItemId })
  const events: string[] = []
  while (true) { const event = await runtime.dispatcher.dispatchOnce(); if (event === undefined) break; events.push(event.kind) }
  expect(events).toEqual(['pathology.accept-request', 'pathology.start-request', 'pathology.report-request'])
  const reported = (await detail()).pathologyRequests!.requests[0]!, currentReport = reported.report!
  expect(currentReport).toMatchObject({ diagnosis: report.diagnosis, specimen: { slideCount: 1 } })
  expect(JSON.stringify(await detail())).not.toContain(output.assetKey)
  const doctorContext = (await runtime.identity.resolveSessionContext(new Headers({ cookie: visit.doctor }))).actor
  expect(runtime.workflow.pathology.readingAccess(doctorContext, reported.id, currentReport.diagnosticReportId)).toMatchObject({ assetId: asset.assetId, assetOutput: output, caseId: visit.outpatientCaseId, encounterId: visit.encounterId, writable: true })
  expect(runtime.workflow.pathology.readingAccess(doctorContext, reported.id, 'other-report')).toBeUndefined()
  const path = (action: string) => `/api/his/v1/pathology-requests/${reported.id}/reports/${currentReport.diagnosticReportId}/actions/${action}`
  const acknowledge = () => runtime.app.request(path('acknowledge'), mutation(visit.doctor, {
    expectedVersions: { [`DiagnosticReport/${currentReport.diagnosticReportId}`]: currentReport.diagnosticReportVersion, [`ServiceRequest/${reported.serviceRequestId}`]: reported.serviceRequestVersion, [`Task/${reported.taskId}`]: reported.taskVersion }, input: { expectedRequestVersion: reported.version },
  }))
  available = false
  const blocked = await acknowledge()
  expect(blocked.status).toBe(409)
  expect(apiErrorSchema.parse(await blocked.json()).error.code).toBe('IMAGING_STUDY_UNAVAILABLE')
  expect((await detail()).pathologyRequests!.requests[0]!.report!.diagnosis).toBe(report.diagnosis)
  available = true
  expect((await acknowledge()).status).toBe(200)
  const acknowledged = (await detail()).pathologyRequests!.requests[0]!
  asset.reports.push(review({ ...report, revision: 2, microscopy: '同一切片已核对的第二版镜下所见。' }))
  const corrected = await runtime.app.request(path('correct'), mutation(admin, { expectedVersions: { [`DiagnosticReport/${currentReport.diagnosticReportId}`]: currentReport.diagnosticReportVersion }, input: { expectedRequestVersion: acknowledged.version, reason: '采用同片已复核报告修订', reportRevision: 2 } }))
  expect(corrected.status, await corrected.clone().text()).toBe(200)
  const result = (await detail()).pathologyRequests!.requests[0]!
  expect(result.report).toMatchObject({ revisionNumber: 2, microscopy: '同一切片已核对的第二版镜下所见。', studyId: currentReport.studyId })
  expect(result.report!.acknowledgement).toBeUndefined()
  expect(result.previousReports[0]).toMatchObject({ diagnosticReportId: currentReport.diagnosticReportId, acknowledgement: expect.any(Object) })
  expect(result.billing!.chargeItemId).toBe(issued.request.billing!.chargeItemId)
  expect(runtime.workflow.pathology.readingAccess(doctorContext, result.id, currentReport.diagnosticReportId)?.writable).toBe(false)
})
