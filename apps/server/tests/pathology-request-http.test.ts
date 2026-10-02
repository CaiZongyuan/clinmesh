import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acknowledgePathologyReportResponseSchema,
  apiErrorSchema,
  casePathologyServiceCatalogSchema,
  doctorCaseDetailSchema,
  encounterCompletionPreviewSchema,
  issuePathologyRequestResponseSchema,
  pathologyRequestActionResponseSchema,
  pathologyRequestDraftResponseSchema,
} from '@clinmesh/contracts/his'
import { imagingStudyViewSchema } from '@clinmesh/contracts/imaging'
import jpeg from 'jpeg-js'
import { afterEach, describe, expect, it } from 'vitest'
import { repairPathologyAssets } from '../src/infrastructure/imaging-assets/pathology-asset-store.ts'
import type { createClinMeshRuntime } from '../src/runtime.ts'
import {
  agentPageContext,
  authorizeAgentTool,
  createImagingRuntime,
  generateCase,
  mutation,
  signIn,
  startConsultation,
} from './fixtures/imaging-scenario.ts'
import { installSyntheticPathologySlides, type SyntheticSlide } from './fixtures/pathology-catalog.ts'
import {
  breastCaseBundle,
  breastLesionExcision,
  lumpectomy,
  preparePathology,
  receptorPositive,
  type BreastCase,
} from './fixtures/pathology-scenario.ts'

type Runtime = Awaited<ReturnType<typeof createClinMeshRuntime>>

const luminal = 'synthetic-slide-luminal'
const service = 'pathology-breast-slide-consultation'
const procedureReference = 'urn:uuid:procedure-0'

describe('Pathology consultation request HTTP contract', () => {
  const runtimes: Runtime[] = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
  })

  /** 一个已安装并发布切片的运行时，病例已完成病理准备并进入医生接诊。 */
  async function consultation(breastCase: BreastCase, slides: SyntheticSlide[] = [{ assetId: luminal }]) {
    const created = await createImagingRuntime([breastCaseBundle(breastCase)], { persona: true })
    temporaryDirectories.push(created.directory)
    runtimes.push(created.runtime)
    const install = (current: SyntheticSlide[]) => installSyntheticPathologySlides({
      assetDirectory: created.pathologyAssetDirectory,
      catalogDirectory: created.pathologyCatalogDirectory,
      slides: current,
    })
    if (slides.length > 0) await install(slides)
    const administrator = await signIn(created.runtime)
    const syntheticCaseId = await generateCase(created.runtime, administrator)
    if (slides.length > 0) await preparePathology(created.runtime, administrator, [syntheticCaseId])
    const visit = await startConsultation(created.runtime, administrator, syntheticCaseId)
    return { ...created, ...visit, administrator, install, syntheticCaseId }
  }

  async function caseDetail(runtime: Runtime, doctor: string, caseId: string) {
    const response = await runtime.app.request(`/api/his/v1/doctor/cases/${caseId}`, { headers: { cookie: doctor } })
    expect(response.status).toBe(200)
    return doctorCaseDetailSchema.parse(await response.json())
  }

  async function completionItem(runtime: Runtime, doctor: string, encounterId: string, code: string) {
    const response = await runtime.app.request(`/api/his/v1/encounters/${encounterId}/completion`, { headers: { cookie: doctor } })
    expect(response.status).toBe(200)
    return encounterCompletionPreviewSchema.parse(await response.json()).items.find(item => item.code === code)
  }

  async function services(runtime: Runtime, doctor: string, caseId: string) {
    const response = await runtime.app.request(
      `/api/his/v1/doctor/cases/${caseId}/pathology-services`,
      { headers: { cookie: doctor } },
    )
    expect(response.status).toBe(200)
    return casePathologyServiceCatalogSchema.parse(await response.json())
  }

  async function saveDraft(
    runtime: Runtime,
    doctor: string,
    encounterId: string,
    input: { expectedDraftVersion: number; purpose?: string; sourceProcedureReference?: string },
  ) {
    return await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/pathology-request/draft`,
      mutation(doctor, {
        expectedVersions: { [`Encounter/${encounterId}`]: '3' },
        input: {
          expectedDraftVersion: input.expectedDraftVersion,
          purpose: input.purpose ?? '外院手术切片复核，明确病理类型',
          serviceId: service,
          sourceProcedureReference: input.sourceProcedureReference ?? procedureReference,
        },
      }, 'PUT'),
    )
  }

  async function issue(runtime: Runtime, doctor: string, encounterId: string, expectedDraftVersion: number) {
    return await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/pathology-request/actions/issue`,
      mutation(doctor, { expectedVersions: { [`Encounter/${encounterId}`]: '3' }, input: { expectedDraftVersion } }),
    )
  }

  /** 保存草稿并开立，返回正式申请。 */
  async function order(
    visit: { doctor: string; encounterId: string; runtime: Runtime },
    expectedDraftVersion = 0,
    sourceProcedureReference = procedureReference,
  ) {
    const draft = await saveDraft(visit.runtime, visit.doctor, visit.encounterId, { expectedDraftVersion, sourceProcedureReference })
    expect(draft.status).toBe(200)
    const { draftVersion } = pathologyRequestDraftResponseSchema.parse(await draft.json()).data
    const issued = await issue(visit.runtime, visit.doctor, visit.encounterId, draftVersion)
    expect(issued.status).toBe(200)
    return issuePathologyRequestResponseSchema.parse(await issued.json()).data.request
  }

  async function dispatchAll(runtime: Runtime): Promise<string[]> {
    const kinds: string[] = []
    while (true) {
      const event = await runtime.dispatcher.dispatchOnce()
      if (event === undefined) return kinds
      kinds.push(`${event.kind}:${event.status}`)
    }
  }

  /** 开立并执行到报告发布，返回带报告的申请。 */
  async function reportedRequest(
    visit: { doctor: string; encounterId: string; outpatientCaseId: string; runtime: Runtime },
    expectedDraftVersion = 0,
  ) {
    const request = await order(visit, expectedDraftVersion)
    await dispatchAll(visit.runtime)
    const projected = (await caseDetail(visit.runtime, visit.doctor, visit.outpatientCaseId)).pathologyRequests!.requests
      .find(item => item.id === request.id)!
    expect(projected.status).toBe('reported')
    return projected
  }

  type Reported = Awaited<ReturnType<typeof reportedRequest>>

  function reportVersions(request: Reported) {
    return {
      expectedVersions: {
        [`DiagnosticReport/${request.report!.diagnosticReportId}`]: request.report!.diagnosticReportVersion,
        [`ServiceRequest/${request.serviceRequestId}`]: request.serviceRequestVersion,
        [`Task/${request.taskId}`]: request.taskVersion,
      },
      input: { expectedRequestVersion: request.version },
    }
  }

  const reportPath = (request: Reported, action: string, kind = 'pathology') => (
    `/api/his/v1/${kind}-requests/${request.id}/reports/${request.report!.diagnosticReportId}/actions/${action}`
  )

  it('orders a slide consultation for a visible source procedure, publishes the report and gates completion', async () => {
    const visit = await consultation({ name: '乳腺随访', procedures: [lumpectomy, breastLesionExcision] })
    const { doctor, encounterId, outpatientCaseId, patientId, runtime } = visit

    const catalog = await services(runtime, doctor, outpatientCaseId)
    expect(catalog.items).toHaveLength(1)
    expect(catalog.items[0]).toMatchObject({
      available: true,
      service: {
        bodySite: '乳腺',
        department: '病理科',
        examCode: 'breast-slide-consultation',
        id: service,
        name: '乳腺切片病理会诊',
        stain: 'HE',
      },
    })
    // 可送检手术只来自可见来源病史，按手术时间排列；不含素材、适配条目或受体信息。
    expect(catalog.items[0]?.sourceProcedures).toEqual([
      { code: lumpectomy.code, display: lumpectomy.display, performedAt: '2022-04-01T08:00:00+08:00', sourceReference: procedureReference },
      { code: breastLesionExcision.code, display: breastLesionExcision.display, performedAt: '2022-04-02T08:00:00+08:00', sourceReference: 'urn:uuid:procedure-1' },
    ])
    expect(JSON.stringify(catalog)).not.toMatch(/synthetic-slide|breast-er|85337|10828004/)

    // 草稿：与检验、放射草稿互不覆盖，未处理的会诊草稿阻止完诊。
    const unknownProcedure = await saveDraft(runtime, doctor, encounterId, {
      expectedDraftVersion: 0,
      sourceProcedureReference: 'urn:uuid:er',
    })
    expect(unknownProcedure.status).toBe(409)
    expect(apiErrorSchema.parse(await unknownProcedure.json()).error.code).toBe('PATHOLOGY_SOURCE_PROCEDURE_UNAVAILABLE')
    const draft = await saveDraft(runtime, doctor, encounterId, { expectedDraftVersion: 0 })
    expect(draft.status).toBe(200)
    expect(pathologyRequestDraftResponseSchema.parse(await draft.json()).data).toEqual({ caseId: outpatientCaseId, draftVersion: 1 })
    const drafted = await caseDetail(runtime, doctor, outpatientCaseId)
    expect(drafted.pathologyRequests).toMatchObject({
      draft: {
        purpose: '外院手术切片复核，明确病理类型',
        service: { id: service },
        sourceProcedure: { code: lumpectomy.code, sourceReference: procedureReference },
      },
      draftVersion: 1,
      requests: [],
    })
    expect(drafted.imagingRequests?.draft).toBeUndefined()
    expect(drafted.laboratoryRequests?.draft).toBeUndefined()
    expect(await completionItem(runtime, doctor, encounterId, 'no-pending-drafts'))
      .toMatchObject({ status: 'incomplete', target: 'pathology' })

    const stale = await issue(runtime, doctor, encounterId, 7)
    expect(stale.status).toBe(409)
    expect(apiErrorSchema.parse(await stale.json()).error.code).toBe('PATHOLOGY_REQUEST_VERSION_CONFLICT')

    const issued = await issue(runtime, doctor, encounterId, 1)
    expect(issued.status).toBe(200)
    const request = issuePathologyRequestResponseSchema.parse(await issued.json()).data.request
    expect(request).toMatchObject({
      purpose: '外院手术切片复核，明确病理类型',
      service: { examCode: 'breast-slide-consultation', id: service },
      sourceProcedure: { code: lumpectomy.code, performedAt: '2022-04-01T08:00:00+08:00', sourceReference: procedureReference },
      status: 'issued',
      version: 1,
    })

    // 同一服务只能有一条进行中的会诊，另一次手术的会诊也要等前一条出报告或取消。
    expect((await saveDraft(runtime, doctor, encounterId, {
      expectedDraftVersion: 2,
      sourceProcedureReference: 'urn:uuid:procedure-1',
    })).status).toBe(200)
    const duplicate = await issue(runtime, doctor, encounterId, 3)
    expect(duplicate.status).toBe(409)
    expect(apiErrorSchema.parse(await duplicate.json()).error.code).toBe('PATHOLOGY_REQUEST_DUPLICATE')
    const cleared = await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/pathology-request/draft`,
      mutation(doctor, { expectedVersions: { [`Encounter/${encounterId}`]: '3' }, input: { expectedDraftVersion: 3 } }, 'DELETE'),
    )
    expect(cleared.status).toBe(200)

    // 受理即收片登记，开始即阅片中，随后发布报告。
    const lifecycle = [
      'pathology.accept-request:completed',
      'pathology.start-request:completed',
      'pathology.report-request:completed',
    ]
    expect(await dispatchAll(runtime)).toEqual(lifecycle)
    const second = await order(visit, 4, 'urn:uuid:procedure-1')
    expect(await dispatchAll(runtime)).toEqual(lifecycle)

    const reported = await caseDetail(runtime, doctor, outpatientCaseId)
    const [first, other] = reported.pathologyRequests!.requests
    expect(first).toMatchObject({
      id: request.id,
      report: {
        diagnosis: '乳腺浸润性导管癌。原始资料未提供组织学分级。',
        immunohistochemistry: '以下结果引自原始病理资料，本次会诊未提供免疫组化切片。ER：阳性；PR：阳性；HER2：阴性（FISH 阴性）。',
        microscopy: '送检切片为 HE 染色乳腺组织，见浸润性癌，浸润纤维间质。',
        note: '本次会诊切片为原发灶组织，未包含淋巴结；淋巴结情况以原病例记录为准。',
        revisionNumber: 1,
        // 标本信息取申请所选的来源手术。
        specimen: {
          procedure: { code: lumpectomy.code, display: lumpectomy.display, performedAt: '2022-04-01T08:00:00+08:00' },
          slideCount: 1,
          stain: 'HE',
        },
        status: 'final',
      },
      status: 'reported',
    })
    // 收片与签发时间都取开单时的 Virtual Time。
    expect(first?.report?.receivedAt).toBe(first?.report?.issuedAt)
    // 同一病例的两次会诊各有自己的本院检查与标本。
    expect(other).toMatchObject({ id: second.id, sourceProcedure: { code: breastLesionExcision.code }, status: 'reported' })
    expect(other?.report?.studyId).not.toBe(first?.report?.studyId)
    expect(other?.report?.specimen.specimenId).not.toBe(first?.report?.specimen.specimenId)
    // 临床读模型不返回素材标识、适配条目、来源切片或报告内容修订号。
    expect(JSON.stringify(reported)).not.toMatch(/synthetic-slide|breast-er|SYNTHETIC-|2\.25\.72|reportRevision/)
    // 病理报告不作为含正文的对话卡片注入患者对话。
    expect(reported.consultation?.turns.filter(turn => turn.kind === 'report-card')).toEqual([])
    expect(await completionItem(runtime, doctor, encounterId, 'required-reports-acknowledged')).toMatchObject({ status: 'incomplete' })

    // 检验与放射的操作作用于病理申请时返回稳定冲突。
    for (const kind of ['laboratory', 'imaging']) {
      expect((await runtime.app.request(reportPath(first!, 'acknowledge', kind), mutation(doctor, reportVersions(first!)))).status, kind)
        .toBe(409)
    }

    // 阅片：本院检查描述为一张切片的分层瓦片，瓦片只面向责任医生。
    const study = await runtime.app.request(`/api/his/v1/imaging-studies/${first!.report!.studyId}`, { headers: { cookie: doctor } })
    expect(study.status).toBe(200)
    expect(study.headers.get('cache-control')).toBe('private, no-store')
    const view = imagingStudyViewSchema.parse(await study.json())
    expect(view).toMatchObject({ available: true, examCode: 'breast-slide-consultation', studyId: first!.report!.studyId })
    expect(view.series).toHaveLength(1)
    const [series] = view.series
    if (series?.kind !== 'tiled-pyramid') throw new Error('Expected a tiled-pyramid series')
    expect(series.levels.map(level => level.magnification)).toEqual([20, 10, 5])
    expect(series).toMatchObject({ colorManaged: false, modality: 'SM', slideLabel: '1', tileFormat: 'jpeg' })
    const tile = await runtime.app.request(
      `/api/his/v1/imaging-studies/${first!.report!.studyId}/series/0/levels/0/tiles/2/1`,
      { headers: { cookie: doctor } },
    )
    expect(tile.status).toBe(200)
    expect(tile.headers.get('cache-control')).toBe('private, no-store')
    expect(jpeg.decode(new Uint8Array(await tile.arrayBuffer()), { useTArray: true }).width).toBe(16)

    const acknowledge = await runtime.app.request(reportPath(first!, 'acknowledge'), mutation(doctor, reportVersions(first!)))
    expect(acknowledge.status).toBe(200)
    expect(acknowledgePathologyReportResponseSchema.parse(await acknowledge.json()).data)
      .toMatchObject({ requestId: request.id, status: 'acknowledged' })
    // 另一次会诊的报告尚未确认，完诊仍被阻止。
    expect(await completionItem(runtime, doctor, encounterId, 'required-reports-acknowledged')).toMatchObject({ status: 'incomplete' })
    expect((await runtime.app.request(reportPath(other!, 'acknowledge'), mutation(doctor, reportVersions(other!)))).status).toBe(200)
    expect(await completionItem(runtime, doctor, encounterId, 'required-reports-acknowledged')).toMatchObject({ status: 'complete' })
    expect((await caseDetail(runtime, doctor, outpatientCaseId)).pathologyRequests!.requests[0]).toMatchObject({
      report: { acknowledgement: { acknowledgedAt: first!.report!.issuedAt } },
      status: 'acknowledged',
    })

    // FHIR：Specimen、SM ImagingStudy、DiagnosticReport 与 Provenance 相互关联，不含素材或来源标识。
    const read = async (reference: string) => {
      const response = await runtime.app.request(`/fhir/R5/${reference}`, { headers: { cookie: doctor } })
      expect(response.status, reference).toBe(200)
      return await response.json() as Record<string, unknown>
    }
    const specimen = await read(`Specimen/${first!.report!.specimen.specimenId}`)
    expect(specimen).toMatchObject({
      // 采集时间取所选来源手术的时间；来源手术不是本院 Procedure，不写 collection.procedure。
      collection: { bodySite: { concept: { text: '乳腺' } }, collectedDateTime: '2022-04-01T08:00:00+08:00' },
      processing: [{ description: 'HE 染色' }],
      receivedTime: first!.report!.receivedAt,
      request: [{ reference: `ServiceRequest/${first!.serviceRequestId}` }],
      subject: { reference: `Patient/${patientId}` },
      type: { coding: [{ code: 'TISS' }] },
    })
    expect((specimen.collection as Record<string, unknown>).procedure).toBeUndefined()
    const imagingStudy = await read(`ImagingStudy/${first!.report!.studyId}`)
    expect(imagingStudy).toMatchObject({
      basedOn: [{ reference: `ServiceRequest/${first!.serviceRequestId}` }],
      description: '乳腺切片病理会诊',
      encounter: { reference: `Encounter/${encounterId}` },
      modality: [{ coding: [{ code: 'SM' }] }],
      numberOfSeries: 1,
      series: [{
        modality: { coding: [{ code: 'SM' }] },
        specimen: [{ reference: `Specimen/${first!.report!.specimen.specimenId}` }],
      }],
      status: 'available',
    })
    const diagnosticReport = await read(`DiagnosticReport/${first!.report!.diagnosticReportId}`)
    expect(diagnosticReport).toMatchObject({
      basedOn: [{ reference: `ServiceRequest/${first!.serviceRequestId}` }],
      category: [{ coding: [{ code: 'SP' }] }],
      conclusion: '乳腺浸润性导管癌。原始资料未提供组织学分级。',
      specimen: [{ reference: `Specimen/${first!.report!.specimen.specimenId}` }],
      study: [{ reference: `ImagingStudy/${first!.report!.studyId}` }],
    })
    const provenance = await (await runtime.app.request(
      `/fhir/R5/Provenance?target=${encodeURIComponent(`DiagnosticReport/${first!.report!.diagnosticReportId}`)}`,
      { headers: { cookie: doctor } },
    )).json() as { entry?: Array<{ resource: Record<string, unknown> }> }
    expect(provenance.entry).toHaveLength(1)
    expect(provenance.entry?.[0]?.resource).toMatchObject({
      target: expect.arrayContaining([{ reference: `Specimen/${first!.report!.specimen.specimenId}` }]),
    })
    expect(JSON.stringify([specimen, imagingStudy, diagnosticReport, provenance]))
      .not.toMatch(/synthetic-slide|SYNTHETIC-|2\.25\.72|breast-er/)
    const write = await runtime.app.request(`/fhir/R5/ImagingStudy/${first!.report!.studyId}`, {
      body: JSON.stringify(imagingStudy),
      headers: { 'content-type': 'application/fhir+json', cookie: doctor, origin: 'http://localhost' },
      method: 'PUT',
    })
    expect(write.status).toBeGreaterThanOrEqual(400)
  })

  it('offers the consultation by hospital capability, not by the case, and lists no procedure the doctor cannot see', async () => {
    // 手术记在本次就诊中的病例：服务照常显示为已开展，但没有可送检的既往手术。
    const visit = await consultation({ name: '手术在本次就诊', procedures: [{ ...lumpectomy, indexVisit: true }] })
    const { assetDirectory: _radiology, doctor, encounterId, outpatientCaseId, pathologyAssetDirectory, runtime } = visit

    const catalog = await services(runtime, doctor, outpatientCaseId)
    expect(catalog.items.map(item => [item.service.id, item.available, item.sourceProcedures])).toEqual([[service, true, []]])
    const hidden = await saveDraft(runtime, doctor, encounterId, { expectedDraftVersion: 0 })
    expect(hidden.status).toBe(409)
    expect(apiErrorSchema.parse(await hidden.json()).error.code).toBe('PATHOLOGY_SOURCE_PROCEDURE_UNAVAILABLE')

    // 其他岗位不能读取会诊目录。
    const registrar = await signIn(runtime, 'registrar@demo.clinmesh.local')
    expect((await runtime.app.request(
      `/api/his/v1/doctor/cases/${outpatientCaseId}/pathology-services`,
      { headers: { cookie: registrar } },
    )).status).toBe(403)

    // 切片文件丢失后本院不再开展该会诊。
    await rm(join(pathologyAssetDirectory, 'installed', luminal), { recursive: true })
    expect((await services(runtime, doctor, outpatientCaseId)).items[0]?.available).toBe(false)
  })

  it('does not issue a consultation the hospital does not offer or whose source procedure is no longer selectable', async () => {
    const visit = await consultation({ name: '乳腺随访' })
    const { doctor, encounterId, outpatientCaseId, pathologyAssetDirectory, pathologyCatalogDirectory, runtime } = visit

    expect((await saveDraft(runtime, doctor, encounterId, { expectedDraftVersion: 0 })).status).toBe(200)
    // 适配规则不再把该手术列为可送检：草稿保留，但不能开立。
    const matchingPath = join(pathologyCatalogDirectory, 'matching.json')
    const matching = JSON.parse(await readFile(matchingPath, 'utf8'))
    await writeFile(matchingPath, JSON.stringify({
      ...matching,
      services: [{ ...matching.services[0], sourceProcedureCodes: [breastLesionExcision.code] }],
    }))
    const unselectable = await issue(runtime, doctor, encounterId, 1)
    expect(unselectable.status).toBe(409)
    expect(apiErrorSchema.parse(await unselectable.json()).error.code).toBe('PATHOLOGY_SOURCE_PROCEDURE_UNAVAILABLE')
    await writeFile(matchingPath, JSON.stringify(matching))

    // 本院当前未开展的会诊可以保留草稿，但不能开立。
    await rm(join(pathologyAssetDirectory, 'installed', luminal), { recursive: true })
    const notOffered = await issue(runtime, doctor, encounterId, 1)
    expect(notOffered.status).toBe(409)
    expect(apiErrorSchema.parse(await notOffered.json()).error.code).toBe('CATALOG_CONFLICT')
    expect((await caseDetail(runtime, doctor, outpatientCaseId)).pathologyRequests).toMatchObject({ draftVersion: 1, requests: [] })
  })

  it('ends a consultation without a compatible slide as generation-failed and recovers by retry or cancel', async () => {
    // HER2 阳性的病例与已发布切片矛盾：会诊可以开立，但不会得到伪造的报告。
    const visit = await consultation({ her2: receptorPositive, name: '受体矛盾' })
    const { administrator, doctor, install, outpatientCaseId, pathologyAssetDirectory, pathologyCatalogDirectory, runtime, syntheticCaseId } = visit

    const request = await order(visit)
    expect(await dispatchAll(runtime)).toEqual([
      'pathology.accept-request:completed',
      'pathology.start-request:completed',
      'pathology.report-request:completed',
    ])
    const failed = (await caseDetail(runtime, doctor, outpatientCaseId)).pathologyRequests!.requests[0]!
    expect(failed).toMatchObject({
      generationError: { code: 'PATHOLOGY_RESULT_UNAVAILABLE' },
      id: request.id,
      status: 'generation-failed',
    })
    expect(failed.report).toBeUndefined()
    // 医生看到的失败信息不透露匹配原因。
    expect(JSON.stringify(failed)).not.toMatch(/FIXED_FACT_CONFLICT|breast-er|HER2/)

    const actionBody = (current: typeof failed) => ({
      expectedVersions: {
        [`ServiceRequest/${current.serviceRequestId}`]: current.serviceRequestVersion,
        [`Task/${current.taskId}`]: current.taskVersion,
      },
      input: { expectedRequestVersion: current.version },
    })
    // 素材库补充了相符的切片并重新准备后，重试取得报告。
    await install([{ assetId: luminal }, { assetId: 'synthetic-slide-her2', clinical: { fish: 'Positive' } }])
    await preparePathology(runtime, administrator, [syntheticCaseId])
    const retried = await runtime.app.request(
      `/api/his/v1/pathology-requests/${request.id}/actions/retry`,
      mutation(doctor, actionBody(failed)),
    )
    expect(retried.status).toBe(200)
    expect(await dispatchAll(runtime)).toEqual(['pathology.report-request:completed'])
    const recovered = (await caseDetail(runtime, doctor, outpatientCaseId)).pathologyRequests!.requests[0]!
    expect(recovered).toMatchObject({
      report: { immunohistochemistry: expect.stringContaining('HER2：阳性') },
      status: 'reported',
    })
    expect(recovered.generationError).toBeUndefined()

    // 切片文件丢失：报告保留，但不开放新的确认；修复后可以确认。
    await rm(join(pathologyAssetDirectory, 'installed', 'synthetic-slide-her2'), { recursive: true })
    const blocked = await runtime.app.request(reportPath(recovered, 'acknowledge'), mutation(doctor, reportVersions(recovered)))
    expect(blocked.status).toBe(409)
    expect(apiErrorSchema.parse(await blocked.json()).error.code).toBe('IMAGING_STUDY_UNAVAILABLE')
    const unavailable = await runtime.app.request(
      `/api/his/v1/imaging-studies/${recovered.report!.studyId}`,
      { headers: { cookie: doctor } },
    )
    expect(await unavailable.json()).toMatchObject({ available: false, series: [] })
    expect(await repairPathologyAssets({
      assetDirectory: pathologyAssetDirectory,
      assetIds: ['synthetic-slide-her2'],
      catalogDirectory: pathologyCatalogDirectory,
    })).toEqual({ assets: [{ assetId: 'synthetic-slide-her2', status: 'repaired' }] })
    expect((await runtime.app.request(reportPath(recovered, 'acknowledge'), mutation(doctor, reportVersions(recovered)))).status)
      .toBe(200)

    // 另一条未取得结果的会诊可以取消。
    const another = await order(visit, 2)
    await rm(join(pathologyAssetDirectory, 'installed', 'synthetic-slide-her2'), { recursive: true })
    await dispatchAll(runtime)
    const failedAgain = (await caseDetail(runtime, doctor, outpatientCaseId)).pathologyRequests!.requests
      .find(item => item.id === another.id)!
    expect(failedAgain.status).toBe('generation-failed')
    const cancelled = await runtime.app.request(
      `/api/his/v1/pathology-requests/${another.id}/actions/cancel`,
      mutation(doctor, {
        ...actionBody(failedAgain),
        input: { expectedRequestVersion: failedAgain.version, reasonCode: 'no-longer-needed' },
      }),
    )
    expect(cancelled.status).toBe(200)
    expect(pathologyRequestActionResponseSchema.parse(await cancelled.json()).data.request.status).toBe('cancelled')
  })

  it('cancels an issued consultation before the slide is received and ignores the late acceptance', async () => {
    const visit = await consultation({ name: '乳腺随访' })
    const { doctor, outpatientCaseId, runtime } = visit
    const request = await order(visit)

    const cancelled = await runtime.app.request(
      `/api/his/v1/pathology-requests/${request.id}/actions/cancel`,
      mutation(doctor, {
        expectedVersions: {
          [`ServiceRequest/${request.serviceRequestId}`]: request.serviceRequestVersion,
          [`Task/${request.taskId}`]: request.taskVersion,
        },
        input: { expectedRequestVersion: request.version, reasonCode: 'no-longer-needed' },
      }),
    )
    expect(cancelled.status).toBe(200)
    expect(await dispatchAll(runtime)).toEqual(['pathology.accept-request:completed'])
    const detail = await caseDetail(runtime, doctor, outpatientCaseId)
    expect(detail.pathologyRequests!.requests[0]).toMatchObject({ id: request.id, status: 'cancelled' })
    expect(detail.pathologyRequests!.requests[0]?.report).toBeUndefined()
  })

  it('corrects a report only from another reviewed revision of the same slide and asks for acknowledgement again', async () => {
    const visit = await consultation({ name: '乳腺随访' })
    const { administrator, doctor, encounterId, install, outpatientCaseId, runtime } = visit
    const reported = await reportedRequest(visit)
    expect((await runtime.app.request(reportPath(reported, 'acknowledge'), mutation(doctor, reportVersions(reported)))).status)
      .toBe(200)
    const acknowledged = (await caseDetail(runtime, doctor, outpatientCaseId)).pathologyRequests!.requests[0]!
    const correctionBody = (reportRevision: number, cookie = administrator) => mutation(cookie, {
      expectedVersions: {
        [`DiagnosticReport/${acknowledged.report!.diagnosticReportId}`]: acknowledged.report!.diagnosticReportVersion,
      },
      input: { expectedRequestVersion: acknowledged.version, reason: '更正镜下所见措辞', reportRevision },
    })
    const correction = (reportRevision: number, cookie = administrator) => (
      runtime.app.request(reportPath(acknowledged, 'correct'), correctionBody(reportRevision, cookie))
    )

    // 素材维护流程为同一切片追加了第二份已核对的报告内容修订。
    await install([{ assetId: luminal, reportRevisions: 2 }])

    // 医生不能更正；管理员不能自由改写，也不能选择未发布或与当前相同的内容修订。
    expect((await correction(2, doctor)).status).toBe(403)
    expect((await correction(9)).status).toBe(409)
    expect((await correction(1)).status).toBe(409)

    const body = correctionBody(2)
    const corrected = await runtime.app.request(reportPath(acknowledged, 'correct'), body)
    expect(corrected.status).toBe(200)
    const correctedBody = await corrected.json()
    // 响应丢失后以相同幂等键重试：即使清单此后撤下了该修订，仍返回已提交的结果。
    await install([{ assetId: luminal }])
    const replayed = await runtime.app.request(reportPath(acknowledged, 'correct'), body)
    expect(replayed.status).toBe(200)
    expect(await replayed.json()).toEqual(correctedBody)

    const current = (await caseDetail(runtime, doctor, outpatientCaseId)).pathologyRequests!.requests[0]!
    expect(current).toMatchObject({
      previousReports: [{
        acknowledgement: { id: acknowledged.report!.acknowledgement!.id },
        diagnosticReportId: acknowledged.report!.diagnosticReportId,
        microscopy: '送检切片为 HE 染色乳腺组织，见浸润性癌，浸润纤维间质。',
        revisionNumber: 1,
      }],
      report: {
        microscopy: '送检切片为 HE 染色乳腺组织，见浸润性癌，浸润纤维间质（第 二 次修订）。',
        revisionNumber: 2,
        revisionOfDiagnosticReportId: acknowledged.report!.diagnosticReportId,
        revisionReason: '更正镜下所见措辞',
        // 更正不更换切片与标本：仍是同一次本院检查。
        specimen: { specimenId: acknowledged.report!.specimen.specimenId },
        studyId: acknowledged.report!.studyId,
      },
      status: 'reported',
    })
    expect(current.report?.acknowledgement).toBeUndefined()
    expect(await completionItem(runtime, doctor, encounterId, 'required-reports-acknowledged')).toMatchObject({ status: 'incomplete' })
    // 旧报告不能再被更正；确认当前报告后门禁解除。
    expect((await correction(1)).status).toBe(409)
    expect((await runtime.app.request(reportPath(current, 'acknowledge'), mutation(doctor, reportVersions(current)))).status)
      .toBe(200)
    expect(await completionItem(runtime, doctor, encounterId, 'required-reports-acknowledged')).toMatchObject({ status: 'complete' })
  })

  it('reads slide tiles only for the responsible doctor of a published consultation in the current epoch', async () => {
    const visit = await consultation({ name: '乳腺随访' })
    const { administrator, doctor, runtime } = visit
    const reported = await reportedRequest(visit)
    const studyPath = `/api/his/v1/imaging-studies/${reported.report!.studyId}`
    const tilePath = `${studyPath}/series/0/levels/0/tiles/0/0`

    expect((await runtime.app.request(tilePath, { headers: { cookie: doctor } })).status).toBe(200)
    // 越界的层级、行列与序列，以及猜测的检查标识都按不存在处理。
    for (const path of ['levels/3/tiles/0/0', 'levels/0/tiles/3/0', 'levels/0/tiles/0/2']) {
      expect((await runtime.app.request(`${studyPath}/series/0/${path}`, { headers: { cookie: doctor } })).status, path).toBe(404)
    }
    expect((await runtime.app.request(`${studyPath}/series/1/levels/0/tiles/0/0`, { headers: { cookie: doctor } })).status).toBe(404)
    expect((await runtime.app.request(
      '/api/his/v1/imaging-studies/00000000-0000-7000-8000-000000000000/series/0/levels/0/tiles/0/0',
      { headers: { cookie: doctor } },
    )).status).toBe(404)
    // 素材标识不是检查标识。
    expect((await runtime.app.request(`/api/his/v1/imaging-studies/${luminal}`, { headers: { cookie: doctor } })).status).toBe(404)
    // 其他岗位与未登录请求不能读取。
    for (const email of ['registrar@demo.clinmesh.local', 'triage@demo.clinmesh.local', 'admin@demo.clinmesh.local']) {
      const cookie = await signIn(runtime, email)
      expect((await runtime.app.request(studyPath, { headers: { cookie } })).status, email).toBe(403)
      expect((await runtime.app.request(tilePath, { headers: { cookie } })).status, email).toBe(403)
    }
    expect((await runtime.app.request(tilePath)).status).toBe(401)

    // 重置后旧 Epoch 的检查不再可读。
    expect((await runtime.app.request('/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', mutation(administrator, {}))).status)
      .toBe(200)
    const nextDoctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
    expect((await runtime.app.request(studyPath, { headers: { cookie: nextDoctor } })).status).toBe(404)
    expect((await runtime.app.request(tilePath, { headers: { cookie: nextDoctor } })).status).toBe(404)
  })

  it('publishes pathology Agent tools from the trusted case state without widening imaging or laboratory tools', async () => {
    const visit = await consultation({ name: '乳腺随访', procedures: [lumpectomy, breastLesionExcision] })
    const { doctor, encounterId, outpatientCaseId, runtime } = visit
    const context = async (viewRevision: string, activeSection = 'laboratory') => await agentPageContext(runtime, doctor, {
      activeSection,
      caseId: outpatientCaseId,
      encounterVersion: (await caseDetail(runtime, doctor, outpatientCaseId)).encounter.versionId,
      viewRevision,
    })

    const empty = (await context('pathology-empty')).snapshot.allowedOperationIds
    expect(empty.filter(id => id.startsWith('outpatient.pathology.'))).toEqual(['outpatient.pathology.draft.set'])
    expect(empty).not.toContain('outpatient.report.acknowledge.propose')
    // 病理 Tool 只在“检验检查”栏目发布。
    expect((await context('pathology-record', 'record')).snapshot.allowedOperationIds
      .filter(id => id.startsWith('outpatient.pathology.'))).toEqual([])

    // 第一次手术的会诊已出报告，第二次手术的会诊尚未执行，另有一份草稿。
    const reported = await reportedRequest(visit)
    const pending = await order(visit, 2, 'urn:uuid:procedure-1')
    expect((await saveDraft(runtime, doctor, encounterId, { expectedDraftVersion: 4 })).status).toBe(200)

    const binding = await context('pathology-reported')
    const allowed = binding.snapshot.allowedOperationIds
    expect(allowed.filter(id => id.startsWith('outpatient.pathology.')).sort()).toEqual([
      'outpatient.pathology.cancel.propose',
      'outpatient.pathology.draft.set',
      'outpatient.pathology.issue.propose',
    ])
    expect(allowed).toContain('outpatient.report.acknowledge.propose')
    // 病理申请不开放检验或放射的取消、重试与更正提案；普通医生账号没有病理更正提案。
    for (const operation of [
      'outpatient.laboratory.cancel.propose',
      'outpatient.report.correct.propose',
      'outpatient.imaging.cancel.propose',
      'outpatient.imaging.retry.propose',
      'outpatient.pathology.correct.propose',
    ]) expect(allowed, operation).not.toContain(operation)
    // Page Context 只含操作标识与受信选择，不含素材、适配条目、来源手术或像素信息。
    expect(JSON.stringify(binding.snapshot)).not.toMatch(/synthetic-slide|breast-er|studyId|pixel|urn:uuid:procedure/)

    const authorize = async (operationId: string, toolName: string, input: unknown) => (
      await authorizeAgentTool(runtime, doctor, binding, { input, operationId, toolName })
    ).status
    expect(await authorize('outpatient.pathology.cancel.propose', 'clinmesh_prepare_cancel_pathology', { requestId: pending.id }))
      .toBe(201)
    // 输入与当前受信资源不符按过期上下文拒绝（409）；未发布的操作按无权限拒绝（403）。
    expect(await authorize('outpatient.pathology.cancel.propose', 'clinmesh_prepare_cancel_pathology', { requestId: reported.id }))
      .toBe(409)
    expect(await authorize('outpatient.pathology.retry.propose', 'clinmesh_prepare_retry_pathology', { requestId: pending.id }))
      .toBe(403)
    // 放射提案不能指向病理申请。
    expect(await authorize('outpatient.imaging.cancel.propose', 'clinmesh_prepare_cancel_imaging', { requestId: pending.id }))
      .toBe(403)
    expect(await authorize('outpatient.report.acknowledge.propose', 'clinmesh_prepare_acknowledge_report', { requestId: reported.id }))
      .toBe(201)
    expect(await authorize('outpatient.report.acknowledge.propose', 'clinmesh_prepare_acknowledge_report', { requestId: pending.id }))
      .toBe(409)
    // 导航阅片只接受本病例已有报告的病理申请，且不与放射申请混用。
    const select = (input: Record<string, string>) => authorize(
      'outpatient.section.select',
      'clinmesh_select_doctor_section',
      { ...input, section: 'laboratory' },
    )
    expect(await select({ pathologyRequestId: reported.id })).toBe(201)
    expect(await select({ pathologyRequestId: pending.id })).toBe(409)
    expect(await select({ imagingRequestId: reported.id })).toBe(409)
    expect(await authorize('outpatient.pathology.draft.set', 'clinmesh_fill_pathology_draft', {
      purpose: '复核',
      serviceId: service,
      sourceProcedureReference: procedureReference,
    })).toBe(201)
    expect(await authorize('outpatient.pathology.draft.set', 'clinmesh_fill_pathology_draft', {
      assetId: luminal,
      purpose: '复核',
      serviceId: service,
      sourceProcedureReference: procedureReference,
    })).toBeGreaterThanOrEqual(400)

    // 同一账号兼有管理员岗位时才发布病理更正提案。
    const administratorAsDoctor = await signIn(runtime)
    expect((await runtime.app.request('/api/auth/role', mutation(
      administratorAsDoctor,
      { practitionerRoleId: 'practitioner-role-outpatient-doctor' },
    ))).status).toBe(200)
    const administratorBinding = await agentPageContext(runtime, administratorAsDoctor, {
      activeSection: 'laboratory',
      caseId: outpatientCaseId,
      encounterVersion: (await caseDetail(runtime, doctor, outpatientCaseId)).encounter.versionId,
      viewRevision: 'pathology-administrator',
    })
    expect(administratorBinding.snapshot.allowedOperationIds).toContain('outpatient.pathology.correct.propose')
    expect(administratorBinding.snapshot.allowedOperationIds).not.toContain('outpatient.imaging.correct.propose')
    const correct = async (requestId: string) => (await authorizeAgentTool(runtime, administratorAsDoctor, administratorBinding, {
      input: { reason: '报告内容已重新核对', reportRevision: 1, requestId },
      operationId: 'outpatient.pathology.correct.propose',
      toolName: 'clinmesh_prepare_correct_pathology_report',
    })).status
    expect(await correct(reported.id)).toBe(201)
    expect(await correct(pending.id)).toBe(409)
  })

  it('tells the patient model only that the slide consultation was accepted', async () => {
    const visit = await consultation({ name: '乳腺随访' })
    const { doctor, encounterId, modelRequests, outpatientCaseId, runtime } = visit
    await reportedRequest(visit)
    const detail = await caseDetail(runtime, doctor, outpatientCaseId)
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
        input: { expectedConsultationVersion: detail.consultation!.version, message: '切片交给病理科了吗？' },
      }),
    )
    expect(ask.status).toBe(200)

    const payload = modelRequests.findLast(request => request.schemaName === 'patient_dialogue_reply')?.userPayload
    expect(payload).toMatchObject({
      examinationExperiences: [],
      heldReports: [],
      slideConsultationsAccepted: [{ name: '乳腺切片病理会诊' }],
      specimenExperiences: [],
    })
    // 报告正文、镜下所见、病理诊断与受体结果都不进入患者模型。
    expect(JSON.stringify(payload)).not.toMatch(/浸润性|导管癌|受体|ER：|HER2|免疫组化|synthetic-slide/)
  })
})
