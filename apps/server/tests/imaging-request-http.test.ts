import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acknowledgeImagingReportResponseSchema,
  apiErrorSchema,
  caseImagingServiceCatalogSchema,
  doctorCaseDetailSchema,
  encounterCompletionPreviewSchema,
  imagingRequestActionResponseSchema,
  imagingRequestDraftResponseSchema,
  issueImagingRequestResponseSchema,
} from '@clinmesh/contracts/his'
import { afterEach, describe, expect, it } from 'vitest'
import { repairImagingAssets } from '../src/infrastructure/imaging-assets/imaging-asset-store.ts'
import type { createClinMeshRuntime } from '../src/runtime.ts'
import { installSyntheticImagingAssets } from './fixtures/imaging-catalog.ts'
import {
  acuteBronchitis,
  agentPageContext,
  authorizeAgentTool,
  caseBundle,
  createImagingRuntime,
  generateCase,
  lungCancer,
  mutation,
  prepareImaging,
  signIn,
  snomed,
  startConsultation,
} from './fixtures/imaging-scenario.ts'

type Runtime = Awaited<ReturnType<typeof createClinMeshRuntime>>

const massCt = 'synthetic-mass-ct'
const massRadiograph = 'synthetic-mass-radiograph'
const clearRadiograph = 'synthetic-clear-radiograph'
const radiographService = 'imaging-chest-radiograph'
const ctService = 'imaging-chest-ct-plain'

const matching = {
  codeSystem: snomed,
  profiles: [
    {
      ageRange: [40, 79],
      assets: { 'chest-ct-plain': massCt, 'chest-radiograph': massRadiograph },
      conditionCodes: [lungCancer.code],
      finding: 'positive',
      id: 'lung-mass-male',
      label: '肺部单发肿块（成年男性）',
      sex: 'male',
    },
    {
      ageRange: [18, 89],
      assets: { 'chest-radiograph': clearRadiograph },
      finding: 'negative',
      id: 'no-nodule',
      indexConditionCodes: [acuteBronchitis.code],
      label: '未见肺结节（急性支气管炎就诊）',
    },
  ],
  ruleVersion: 1,
  schemaVersion: 1,
  sourceExamCodes: {},
  uncoveredConditions: [],
}

describe('Imaging request HTTP contract', () => {
  const runtimes: Runtime[] = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
  })

  /** 一个已安装并发布素材的运行时，病例已完成影像准备并进入医生接诊。 */
  async function consultation(bundle: unknown) {
    const created = await createImagingRuntime([bundle], { persona: true })
    temporaryDirectories.push(created.directory)
    runtimes.push(created.runtime)
    await installSyntheticImagingAssets({
      assetDirectory: created.assetDirectory,
      assets: [
        { assetId: massCt, examCode: 'chest-ct-plain' },
        { assetId: massRadiograph, examCode: 'chest-radiograph' },
        { assetId: clearRadiograph, examCode: 'chest-radiograph' },
      ],
      catalogDirectory: created.catalogDirectory,
      matching,
    })
    const administrator = await signIn(created.runtime)
    const syntheticCaseId = await generateCase(created.runtime, administrator)
    await prepareImaging(created.runtime, administrator, [syntheticCaseId])
    const visit = await startConsultation(created.runtime, administrator, syntheticCaseId)
    return { ...created, ...visit, administrator, syntheticCaseId }
  }

  async function caseDetail(runtime: Runtime, doctor: string, caseId: string) {
    const response = await runtime.app.request(`/api/his/v1/doctor/cases/${caseId}`, { headers: { cookie: doctor } })
    expect(response.status).toBe(200)
    return doctorCaseDetailSchema.parse(await response.json())
  }

  async function completionPreview(runtime: Runtime, doctor: string, encounterId: string) {
    const response = await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/completion`,
      { headers: { cookie: doctor } },
    )
    expect(response.status).toBe(200)
    return encounterCompletionPreviewSchema.parse(await response.json())
  }

  async function saveDraft(
    runtime: Runtime,
    doctor: string,
    encounterId: string,
    input: { expectedDraftVersion: number; indication: string; serviceId: string },
  ) {
    return await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/imaging-request/draft`,
      mutation(doctor, { expectedVersions: { [`Encounter/${encounterId}`]: '3' }, input }, 'PUT'),
    )
  }

  async function issue(runtime: Runtime, doctor: string, encounterId: string, expectedDraftVersion: number) {
    return await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/imaging-request/actions/issue`,
      mutation(doctor, { expectedVersions: { [`Encounter/${encounterId}`]: '3' }, input: { expectedDraftVersion } }),
    )
  }

  /** 保存草稿并开立，返回正式申请。 */
  async function order(
    visit: { doctor: string; encounterId: string; runtime: Runtime },
    serviceId: string,
    expectedDraftVersion = 0,
  ) {
    const draft = await saveDraft(visit.runtime, visit.doctor, visit.encounterId, {
      expectedDraftVersion,
      indication: '咳嗽两周，排查肺部病变',
      serviceId,
    })
    expect(draft.status).toBe(200)
    const { draftVersion } = imagingRequestDraftResponseSchema.parse(await draft.json()).data
    const issued = await issue(visit.runtime, visit.doctor, visit.encounterId, draftVersion)
    expect(issued.status).toBe(200)
    return issueImagingRequestResponseSchema.parse(await issued.json()).data.request
  }

  async function dispatchAll(runtime: Runtime): Promise<string[]> {
    const kinds: string[] = []
    while (true) {
      const event = await runtime.dispatcher.dispatchOnce()
      if (event === undefined) return kinds
      kinds.push(`${event.kind}:${event.status}`)
    }
  }

  it('orders a chest radiograph, publishes the report, and gates completion on acknowledgement', async () => {
    const visit = await consultation(caseBundle({
      gender: 'male',
      index: [{ ...lungCancer, resourceType: 'Condition' }],
      name: '肺癌男',
    }))
    const { doctor, encounterId, outpatientCaseId, runtime } = visit

    const services = caseImagingServiceCatalogSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${outpatientCaseId}/imaging-services`,
      { headers: { cookie: doctor } },
    )).json())
    expect(services.items.map(item => [item.service.id, item.service.examCode, item.available])).toEqual([
      [ctService, 'chest-ct-plain', true],
      [radiographService, 'chest-radiograph', true],
    ])
    expect(services.items[0]?.service).toMatchObject({ bodySite: '胸部', method: '平扫（不使用造影剂）', modality: 'CT' })

    // 草稿：两类草稿互不覆盖，未处理的放射草稿阻止完诊。
    const draft = await saveDraft(runtime, doctor, encounterId, {
      expectedDraftVersion: 0,
      indication: '咳嗽两周，排查肺部病变',
      serviceId: radiographService,
    })
    expect(draft.status).toBe(200)
    expect(imagingRequestDraftResponseSchema.parse(await draft.json()).data).toEqual({
      caseId: outpatientCaseId,
      draftVersion: 1,
    })
    const drafted = await caseDetail(runtime, doctor, outpatientCaseId)
    expect(drafted.imagingRequests).toMatchObject({
      draft: { indication: '咳嗽两周，排查肺部病变', service: { id: radiographService } },
      draftVersion: 1,
      requests: [],
    })
    expect(drafted.laboratoryRequests?.draft).toBeUndefined()
    expect((await completionPreview(runtime, doctor, encounterId)).items
      .find(item => item.code === 'no-pending-drafts')).toMatchObject({ status: 'incomplete', target: 'imaging' })

    const stale = await issue(runtime, doctor, encounterId, 7)
    expect(stale.status).toBe(409)
    expect(apiErrorSchema.parse(await stale.json()).error.code).toBe('IMAGING_REQUEST_VERSION_CONFLICT')

    const issued = await issue(runtime, doctor, encounterId, 1)
    expect(issued.status).toBe(200)
    const request = issueImagingRequestResponseSchema.parse(await issued.json()).data.request
    expect(request).toMatchObject({
      indication: '咳嗽两周，排查肺部病变',
      service: { examCode: 'chest-radiograph', id: radiographService },
      status: 'issued',
      version: 1,
    })

    // 同一服务只能有一条进行中申请。
    const duplicateDraft = await saveDraft(runtime, doctor, encounterId, {
      expectedDraftVersion: 2,
      indication: '重复开立',
      serviceId: radiographService,
    })
    expect(duplicateDraft.status).toBe(200)
    const duplicate = await issue(runtime, doctor, encounterId, 3)
    expect(duplicate.status).toBe(409)
    expect(apiErrorSchema.parse(await duplicate.json()).error.code).toBe('IMAGING_REQUEST_DUPLICATE')
    const cleared = await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/imaging-request/draft`,
      mutation(doctor, { expectedVersions: { [`Encounter/${encounterId}`]: '3' }, input: { expectedDraftVersion: 3 } }, 'DELETE'),
    )
    expect(cleared.status).toBe(200)

    expect(await dispatchAll(runtime)).toEqual([
      'imaging.accept-request:completed',
      'imaging.start-request:completed',
      'imaging.report-request:completed',
    ])

    const reported = await caseDetail(runtime, doctor, outpatientCaseId)
    const reportedRequest = reported.imagingRequests!.requests[0]!
    expect(reportedRequest).toMatchObject({
      id: request.id,
      report: {
        findings: '双肺野未见明确结节影。',
        impression: '胸片未见明确肺结节影。',
        revisionNumber: 1,
        status: 'final',
        technique: '胸部正位片。',
      },
      status: 'reported',
    })
    // 检查时间与签发时间都取开单时的 Virtual Time。
    expect(reportedRequest.report?.examinedAt).toBe(reportedRequest.report?.issuedAt)
    // 临床读模型不返回素材标识、适配条目、来源 UID 或报告内容修订号。
    expect(JSON.stringify(reported)).not.toMatch(/synthetic-mass|lung-mass-male|SYNTHETIC-0001|2\.25\.4|reportRevision/)
    // 放射报告不作为含正文的对话卡片注入患者对话。
    expect(reported.consultation?.turns.filter(turn => turn.kind === 'report-card')).toEqual([])

    const gate = (await completionPreview(runtime, doctor, encounterId)).items
      .find(item => item.code === 'required-reports-acknowledged')
    expect(gate).toMatchObject({ status: 'incomplete' })

    // 检验操作作用于放射申请时返回稳定冲突。
    const laboratoryAcknowledge = await runtime.app.request(
      `/api/his/v1/laboratory-requests/${request.id}/reports/${reportedRequest.report!.diagnosticReportId}/actions/acknowledge`,
      mutation(doctor, {
        expectedVersions: {
          [`DiagnosticReport/${reportedRequest.report!.diagnosticReportId}`]: reportedRequest.report!.diagnosticReportVersion,
          [`ServiceRequest/${reportedRequest.serviceRequestId}`]: reportedRequest.serviceRequestVersion,
          [`Task/${reportedRequest.taskId}`]: reportedRequest.taskVersion,
        },
        input: { expectedRequestVersion: reportedRequest.version },
      }),
    )
    expect(laboratoryAcknowledge.status).toBe(409)

    const acknowledge = await runtime.app.request(
      `/api/his/v1/imaging-requests/${request.id}/reports/${reportedRequest.report!.diagnosticReportId}/actions/acknowledge`,
      mutation(doctor, {
        expectedVersions: {
          [`DiagnosticReport/${reportedRequest.report!.diagnosticReportId}`]: reportedRequest.report!.diagnosticReportVersion,
          [`ServiceRequest/${reportedRequest.serviceRequestId}`]: reportedRequest.serviceRequestVersion,
          [`Task/${reportedRequest.taskId}`]: reportedRequest.taskVersion,
        },
        input: { expectedRequestVersion: reportedRequest.version },
      }),
    )
    expect(acknowledge.status).toBe(200)
    expect(acknowledgeImagingReportResponseSchema.parse(await acknowledge.json()).data).toMatchObject({
      requestId: request.id,
      status: 'acknowledged',
    })
    const acknowledged = await caseDetail(runtime, doctor, outpatientCaseId)
    expect(acknowledged.imagingRequests!.requests[0]).toMatchObject({
      report: { acknowledgement: { acknowledgedAt: reportedRequest.report!.issuedAt } },
      status: 'acknowledged',
    })
    expect((await completionPreview(runtime, doctor, encounterId)).items
      .find(item => item.code === 'required-reports-acknowledged')).toMatchObject({ status: 'complete' })
  })

  it('tells the patient model that an examination took place without its findings or impression', async () => {
    const visit = await consultation(caseBundle({
      gender: 'male',
      index: [{ ...lungCancer, resourceType: 'Condition' }],
      name: '肺癌男',
    }))
    const { doctor, encounterId, modelRequests, outpatientCaseId, runtime } = visit
    // 胸片已出报告，CT 仍在等待执行。
    await order(visit, radiographService)
    await dispatchAll(runtime)
    await order(visit, ctService, 2)
    const detail = await caseDetail(runtime, doctor, outpatientCaseId)
    const radiograph = detail.imagingRequests!.requests.find(request => request.service.id === radiographService)!
    expect(radiograph.status).toBe('reported')
    const queueItem = (await (await runtime.app.request('/api/his/v1/doctor/queue', { headers: { cookie: doctor } })).json() as {
      items: Array<{ caseId: string; taskId: string; taskVersion: string }>
    }).items.find(item => item.caseId === outpatientCaseId)!

    const ask = await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/actions/ask-consultation-question`,
      mutation(doctor, {
        expectedVersions: {
          [`Encounter/${encounterId}`]: detail.encounter.versionId,
          [`Task/${queueItem.taskId}`]: queueItem.taskVersion,
        },
        input: { expectedConsultationVersion: detail.consultation!.version, message: '拍完片子感觉怎么样？' },
      }),
    )
    expect(ask.status).toBe(200)

    const payload = modelRequests.findLast(request => request.schemaName === 'patient_dialogue_reply')?.userPayload
    expect(payload).toMatchObject({
      // 患者只知道自己做过哪项检查、什么时候做的；未执行的 CT 不出现。
      examinationExperiences: [{ examinedAt: radiograph.report!.examinedAt, name: '胸片' }],
      heldReports: [],
      specimenExperiences: [],
    })
    expect(JSON.stringify(payload)).not.toMatch(/结节|肿块|synthetic-mass|lung-mass-male|胸部正位片/)
  })

  it('publishes imaging Agent tools from the trusted case state without widening laboratory tools', async () => {
    const visit = await consultation(caseBundle({
      gender: 'male',
      index: [{ ...lungCancer, resourceType: 'Condition' }],
      name: '肺癌男',
    }))
    const { doctor, encounterId, outpatientCaseId, runtime } = visit
    const context = async (viewRevision: string) => await agentPageContext(runtime, doctor, {
      activeSection: 'laboratory',
      caseId: outpatientCaseId,
      encounterVersion: (await caseDetail(runtime, doctor, outpatientCaseId)).encounter.versionId,
      viewRevision,
    })

    const empty = (await context('imaging-empty')).snapshot.allowedOperationIds
    expect(empty).toContain('outpatient.imaging.draft.set')
    expect(empty.filter(id => id.startsWith('outpatient.imaging.'))).toEqual(['outpatient.imaging.draft.set'])
    expect(empty).not.toContain('outpatient.report.acknowledge.propose')

    // 胸片报告已发布、CT 申请尚未执行、另有一份草稿。
    await order(visit, radiographService)
    await dispatchAll(runtime)
    const ct = await order(visit, ctService, 2)
    expect((await saveDraft(runtime, doctor, encounterId, {
      expectedDraftVersion: 4,
      indication: '复查',
      serviceId: radiographService,
    })).status).toBe(200)
    const detail = await caseDetail(runtime, doctor, outpatientCaseId)
    const radiograph = detail.imagingRequests!.requests.find(request => request.service.id === radiographService)!
    expect(radiograph.status).toBe('reported')

    const binding = await context('imaging-reported')
    const allowed = binding.snapshot.allowedOperationIds
    expect(allowed.filter(id => id.startsWith('outpatient.imaging.')).sort()).toEqual([
      'outpatient.imaging.cancel.propose',
      'outpatient.imaging.draft.set',
      'outpatient.imaging.issue.propose',
    ])
    expect(allowed).toContain('outpatient.report.acknowledge.propose')
    // 放射申请不开放检验的取消与更正提案；普通医生账号没有放射更正提案。
    expect(allowed).not.toContain('outpatient.laboratory.cancel.propose')
    expect(allowed).not.toContain('outpatient.report.correct.propose')
    expect(allowed).not.toContain('outpatient.imaging.correct.propose')
    // Page Context 只含操作标识与受信选择，不含素材、适配或像素信息。
    expect(JSON.stringify(binding.snapshot)).not.toMatch(/synthetic-mass|lung-mass-male|studyId|pixel/)

    const authorize = async (operationId: string, toolName: string, input: unknown) => (
      await authorizeAgentTool(runtime, doctor, binding, { input, operationId, toolName })
    ).status
    expect(await authorize('outpatient.imaging.cancel.propose', 'clinmesh_prepare_cancel_imaging', { requestId: ct.id }))
      .toBe(201)
    // 输入与当前受信资源不符按过期上下文拒绝（409）；未发布的操作按无权限拒绝（403）。
    expect(await authorize('outpatient.imaging.cancel.propose', 'clinmesh_prepare_cancel_imaging', { requestId: radiograph.id }))
      .toBe(409)
    expect(await authorize('outpatient.imaging.retry.propose', 'clinmesh_prepare_retry_imaging', { requestId: ct.id }))
      .toBe(403)
    expect(await authorize('outpatient.report.acknowledge.propose', 'clinmesh_prepare_acknowledge_report', { requestId: radiograph.id }))
      .toBe(201)
    expect(await authorize('outpatient.report.acknowledge.propose', 'clinmesh_prepare_acknowledge_report', { requestId: ct.id }))
      .toBe(409)
    // 导航阅片只接受本病例已有报告的放射申请。
    expect(await authorize('outpatient.section.select', 'clinmesh_select_doctor_section', {
      imagingRequestId: radiograph.id,
      section: 'laboratory',
    })).toBe(201)
    expect(await authorize('outpatient.section.select', 'clinmesh_select_doctor_section', {
      imagingRequestId: ct.id,
      section: 'laboratory',
    })).toBe(409)

    // 同一账号兼有管理员岗位时才发布放射更正提案。
    const administratorAsDoctor = await signIn(runtime)
    expect((await runtime.app.request('/api/auth/role', mutation(
      administratorAsDoctor,
      { practitionerRoleId: 'practitioner-role-outpatient-doctor' },
    ))).status).toBe(200)
    const administratorBinding = await agentPageContext(runtime, administratorAsDoctor, {
      activeSection: 'laboratory',
      caseId: outpatientCaseId,
      encounterVersion: detail.encounter.versionId,
      viewRevision: 'imaging-administrator',
    })
    expect(administratorBinding.snapshot.allowedOperationIds).toContain('outpatient.imaging.correct.propose')
    expect(administratorBinding.snapshot.allowedOperationIds).not.toContain('outpatient.report.correct.propose')
    expect((await authorizeAgentTool(runtime, administratorAsDoctor, administratorBinding, {
      input: { reason: '报告内容已重新核对', reportRevision: 1, requestId: radiograph.id },
      operationId: 'outpatient.imaging.correct.propose',
      toolName: 'clinmesh_prepare_correct_imaging_report',
    })).status).toBe(201)
    expect((await authorizeAgentTool(runtime, administratorAsDoctor, administratorBinding, {
      input: { reason: '报告内容已重新核对', reportRevision: 1, requestId: ct.id },
      operationId: 'outpatient.imaging.correct.propose',
      toolName: 'clinmesh_prepare_correct_imaging_report',
    })).status).toBe(409)
  })

  it('ends an unprepared or unavailable examination as generation-failed and recovers by retry or cancel', async () => {
    const visit = await consultation(caseBundle({
      gender: 'female',
      index: [{ ...acuteBronchitis, resourceType: 'Condition' }],
      name: '支气管炎成人',
    }))
    const { assetDirectory, catalogDirectory, doctor, outpatientCaseId, runtime } = visit

    // 适配条目没有 CT 素材：执行以统一的生成失败结束，不生成报告。
    const ct = await order(visit, ctService)
    expect(await dispatchAll(runtime)).toEqual([
      'imaging.accept-request:completed',
      'imaging.start-request:completed',
      'imaging.report-request:completed',
    ])
    const failedCt = (await caseDetail(runtime, doctor, outpatientCaseId)).imagingRequests!.requests[0]!
    expect(failedCt).toMatchObject({
      generationError: { code: 'IMAGING_RESULT_UNAVAILABLE' },
      id: ct.id,
      status: 'generation-failed',
    })
    expect(failedCt.report).toBeUndefined()
    // 医生看到的失败信息不透露适配原因。
    expect(JSON.stringify(failedCt)).not.toMatch(/PROFILE_LACKS_EXAM|no-nodule/)

    const actionBody = (request: typeof failedCt) => ({
      expectedVersions: {
        [`ServiceRequest/${request.serviceRequestId}`]: request.serviceRequestVersion,
        [`Task/${request.taskId}`]: request.taskVersion,
      },
      input: { expectedRequestVersion: request.version },
    })
    const cancelled = await runtime.app.request(
      `/api/his/v1/imaging-requests/${ct.id}/actions/cancel`,
      mutation(doctor, {
        ...actionBody(failedCt),
        input: { expectedRequestVersion: failedCt.version, reasonCode: 'no-longer-needed' },
      }),
    )
    expect(cancelled.status).toBe(200)
    expect(imagingRequestActionResponseSchema.parse(await cancelled.json()).data.request.status).toBe('cancelled')

    // 素材文件丢失：目录显示未开展，已开立的胸片执行失败；修复后重试成功。
    await rm(join(assetDirectory, 'installed', clearRadiograph), { recursive: true })
    await rm(join(assetDirectory, 'installed', 'synthetic-mass-radiograph'), { recursive: true })
    const services = caseImagingServiceCatalogSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${outpatientCaseId}/imaging-services`,
      { headers: { cookie: doctor } },
    )).json())
    expect(services.items.map(item => [item.service.id, item.available])).toEqual([
      [ctService, true],
      [radiographService, false],
    ])
    const radiograph = await order(visit, radiographService, 2)
    await dispatchAll(runtime)
    const failedRadiograph = (await caseDetail(runtime, doctor, outpatientCaseId)).imagingRequests!.requests
      .find(request => request.id === radiograph.id)!
    expect(failedRadiograph).toMatchObject({
      generationError: { code: 'IMAGING_RESULT_UNAVAILABLE' },
      status: 'generation-failed',
    })

    expect(await repairImagingAssets({ assetDirectory, assetIds: [clearRadiograph], catalogDirectory })).toEqual({
      assets: [{ assetId: clearRadiograph, status: 'repaired' }],
    })
    const retried = await runtime.app.request(
      `/api/his/v1/imaging-requests/${radiograph.id}/actions/retry`,
      mutation(doctor, actionBody(failedRadiograph)),
    )
    expect(retried.status).toBe(200)
    expect(await dispatchAll(runtime)).toEqual(['imaging.report-request:completed'])
    const recovered = (await caseDetail(runtime, doctor, outpatientCaseId)).imagingRequests!.requests
      .find(request => request.id === radiograph.id)!
    expect(recovered).toMatchObject({ report: { findings: '双肺野未见明确结节影。' }, status: 'reported' })
    expect(recovered.generationError).toBeUndefined()
  })

  /** 开立并执行到报告发布，返回带报告的申请。 */
  async function reportedRequest(
    visit: { doctor: string; encounterId: string; outpatientCaseId: string; runtime: Runtime },
    serviceId: string,
    expectedDraftVersion = 0,
  ) {
    const request = await order(visit, serviceId, expectedDraftVersion)
    await dispatchAll(visit.runtime)
    const projected = (await caseDetail(visit.runtime, visit.doctor, visit.outpatientCaseId)).imagingRequests!.requests
      .find(item => item.id === request.id)!
    expect(projected.status).toBe('reported')
    return projected
  }

  function reportVersions(request: Awaited<ReturnType<typeof reportedRequest>>) {
    return {
      expectedVersions: {
        [`DiagnosticReport/${request.report!.diagnosticReportId}`]: request.report!.diagnosticReportVersion,
        [`ServiceRequest/${request.serviceRequestId}`]: request.serviceRequestVersion,
        [`Task/${request.taskId}`]: request.taskVersion,
      },
      input: { expectedRequestVersion: request.version },
    }
  }

  it('corrects a report only from another reviewed revision of the same asset and asks for acknowledgement again', async () => {
    const visit = await consultation(caseBundle({
      gender: 'male',
      index: [{ ...lungCancer, resourceType: 'Condition' }],
      name: '肺癌男',
    }))
    const { administrator, assetDirectory, catalogDirectory, doctor, encounterId, outpatientCaseId, runtime } = visit
    const reported = await reportedRequest(visit, radiographService)
    const reportPath = (request: typeof reported, action: string) => (
      `/api/his/v1/imaging-requests/${request.id}/reports/${request.report!.diagnosticReportId}/actions/${action}`
    )
    expect((await runtime.app.request(reportPath(reported, 'acknowledge'), mutation(doctor, reportVersions(reported)))).status)
      .toBe(200)
    const acknowledged = (await caseDetail(runtime, doctor, outpatientCaseId)).imagingRequests!.requests[0]!
    const correction = (reportRevision: number, cookie = administrator) => runtime.app.request(
      reportPath(acknowledged, 'correct'),
      mutation(cookie, {
        expectedVersions: {
          [`DiagnosticReport/${acknowledged.report!.diagnosticReportId}`]: acknowledged.report!.diagnosticReportVersion,
        },
        input: { expectedRequestVersion: acknowledged.version, reason: '更正印象措辞', reportRevision },
      }),
    )

    // 素材维护流程为同一素材追加了第二份已核对的报告内容修订。
    await installSyntheticImagingAssets({
      assetDirectory,
      assets: [
        { assetId: massCt, examCode: 'chest-ct-plain' },
        { assetId: massRadiograph, examCode: 'chest-radiograph', reportRevisions: 2 },
        { assetId: clearRadiograph, examCode: 'chest-radiograph' },
      ],
      catalogDirectory,
      matching,
    })

    // 医生不能更正；管理员不能自由改写，也不能选择未发布或与当前相同的内容修订。
    expect((await correction(2, doctor)).status).toBe(403)
    expect((await correction(9)).status).toBe(409)
    expect((await correction(1)).status).toBe(409)

    const corrected = await correction(2)
    expect(corrected.status).toBe(200)
    const current = (await caseDetail(runtime, doctor, outpatientCaseId)).imagingRequests!.requests[0]!
    expect(current).toMatchObject({
      previousReports: [{
        acknowledgement: { id: acknowledged.report!.acknowledgement!.id },
        diagnosticReportId: acknowledged.report!.diagnosticReportId,
        impression: '胸片未见明确肺结节影。',
        revisionNumber: 1,
      }],
      report: {
        impression: '胸片未见明确肺结节影。（第 2 版措辞）',
        revisionNumber: 2,
        revisionOfDiagnosticReportId: acknowledged.report!.diagnosticReportId,
        revisionReason: '更正印象措辞',
        // 更正不更换像素：仍是同一次本院检查。
        studyId: acknowledged.report!.studyId,
      },
      status: 'reported',
    })
    expect(current.report?.acknowledgement).toBeUndefined()
    expect((await completionPreview(runtime, doctor, encounterId)).items
      .find(item => item.code === 'required-reports-acknowledged')).toMatchObject({ status: 'incomplete' })

    // 再次确认旧报告只返回原有确认，不能代替对当前报告的确认。
    await runtime.app.request(
      reportPath(acknowledged, 'acknowledge'),
      mutation(doctor, { ...reportVersions(acknowledged), input: { expectedRequestVersion: current.version } }),
    )
    expect((await completionPreview(runtime, doctor, encounterId)).items
      .find(item => item.code === 'required-reports-acknowledged')).toMatchObject({ status: 'incomplete' })
    // 旧报告不能再被更正。
    expect((await correction(1)).status).toBe(409)
    expect((await runtime.app.request(reportPath(current, 'acknowledge'), mutation(doctor, reportVersions(current)))).status)
      .toBe(200)
    expect((await completionPreview(runtime, doctor, encounterId)).items
      .find(item => item.code === 'required-reports-acknowledged')).toMatchObject({ status: 'complete' })
  })

  it('keeps the report readable but blocks acknowledgement while the pixels are missing', async () => {
    const visit = await consultation(caseBundle({
      gender: 'male',
      index: [{ ...lungCancer, resourceType: 'Condition' }],
      name: '肺癌男',
    }))
    const { assetDirectory, catalogDirectory, doctor, outpatientCaseId, runtime } = visit
    const reported = await reportedRequest(visit, ctService)
    const acknowledge = () => runtime.app.request(
      `/api/his/v1/imaging-requests/${reported.id}/reports/${reported.report!.diagnosticReportId}/actions/acknowledge`,
      mutation(doctor, reportVersions(reported)),
    )

    await rm(join(assetDirectory, 'installed', massCt), { recursive: true })
    const blocked = await acknowledge()
    expect(blocked.status).toBe(409)
    expect(apiErrorSchema.parse(await blocked.json()).error.code).toBe('IMAGING_STUDY_UNAVAILABLE')
    // 像素丢失不撤销已签报告。
    expect((await caseDetail(runtime, doctor, outpatientCaseId)).imagingRequests!.requests[0]).toMatchObject({
      report: { findings: '双肺未见明确结节。' },
      status: 'reported',
    })

    await repairImagingAssets({ assetDirectory, assetIds: [massCt], catalogDirectory })
    expect((await acknowledge()).status).toBe(200)
  })

  it('projects the hospital study as a read-only FHIR ImagingStudy without asset or source identity', async () => {
    const visit = await consultation(caseBundle({
      gender: 'male',
      index: [{ ...lungCancer, resourceType: 'Condition' }],
      name: '肺癌男',
    }))
    const { administrator, doctor, encounterId, patientId, runtime } = visit
    const ct = await reportedRequest(visit, ctService)
    const radiograph = await reportedRequest(visit, radiographService, 2)
    expect(radiograph.report!.studyId).not.toBe(ct.report!.studyId)

    const study = await runtime.app.request(`/fhir/R5/ImagingStudy/${ct.report!.studyId}`, { headers: { cookie: doctor } })
    expect(study.status).toBe(200)
    const resource = await study.json() as Record<string, unknown>
    expect(resource).toMatchObject({
      basedOn: [{ reference: `ServiceRequest/${ct.serviceRequestId}` }],
      description: '胸部 CT 平扫',
      encounter: { reference: `Encounter/${encounterId}` },
      modality: [{ coding: [{ code: 'CT' }] }],
      resourceType: 'ImagingStudy',
      status: 'available',
      subject: { reference: `Patient/${patientId}` },
    })
    // 本院检查使用新生成的 UID；素材标识、来源 UID 与来源受试者不出现。
    expect(JSON.stringify(resource)).not.toMatch(/synthetic-mass|SYNTHETIC-0001|2\.25\.4/)
    const search = await runtime.app.request(
      `/fhir/R5/ImagingStudy?patient=${encodeURIComponent(`Patient/${patientId}`)}`,
      { headers: { cookie: doctor } },
    )
    expect(search.status).toBe(200)
    const bundle = await search.json() as { entry?: Array<{ resource: { id: string } }> }
    expect(bundle.entry?.map(entry => entry.resource.id).toSorted())
      .toEqual([ct.report!.studyId, radiograph.report!.studyId].toSorted())
    const report = await (await runtime.app.request(
      `/fhir/R5/DiagnosticReport/${ct.report!.diagnosticReportId}`,
      { headers: { cookie: doctor } },
    )).json() as Record<string, unknown>
    expect(report).toMatchObject({
      category: [{ coding: [{ code: 'RAD' }] }],
      conclusion: '胸部 CT 平扫未见明确肺结节。',
      study: [{ reference: `ImagingStudy/${ct.report!.studyId}` }],
    })
    expect(report.specimen).toBeUndefined()
    expect(report.result).toBeUndefined()
    // 通用 FHIR 写入不接受只读投影。
    const write = await runtime.app.request(`/fhir/R5/ImagingStudy/${ct.report!.studyId}`, {
      body: JSON.stringify(resource),
      headers: { 'content-type': 'application/fhir+json', cookie: doctor, origin: 'http://localhost' },
      method: 'PUT',
    })
    expect(write.status).toBeGreaterThanOrEqual(400)

    // 重置后旧 Epoch 的检查不再可读。
    const reset = await runtime.app.request(
      '/api/sim/v1/scenario-runs/scenario-run-1/actions/reset',
      mutation(administrator, {}),
    )
    expect(reset.status).toBe(200)
    const stale = await runtime.app.request(
      `/fhir/R5/ImagingStudy/${ct.report!.studyId}`,
      { headers: { cookie: await signIn(runtime, 'doctor@demo.clinmesh.local') } },
    )
    expect(stale.status).toBe(404)
  })

  it('cancels an issued request before execution and ignores the late acceptance', async () => {
    const visit = await consultation(caseBundle({
      gender: 'male',
      index: [{ ...lungCancer, resourceType: 'Condition' }],
      name: '肺癌男',
    }))
    const { doctor, outpatientCaseId, runtime } = visit
    const request = await order(visit, ctService)

    const cancelled = await runtime.app.request(
      `/api/his/v1/imaging-requests/${request.id}/actions/cancel`,
      mutation(doctor, {
        expectedVersions: {
          [`ServiceRequest/${request.serviceRequestId}`]: request.serviceRequestVersion,
          [`Task/${request.taskId}`]: request.taskVersion,
        },
        input: { expectedRequestVersion: request.version, reasonCode: 'no-longer-needed' },
      }),
    )
    expect(cancelled.status).toBe(200)
    expect(await dispatchAll(runtime)).toEqual(['imaging.accept-request:completed'])
    const detail = await caseDetail(runtime, doctor, outpatientCaseId)
    expect(detail.imagingRequests!.requests[0]).toMatchObject({ id: request.id, status: 'cancelled' })
    expect(detail.imagingRequests!.requests[0]?.report).toBeUndefined()
  })
})
