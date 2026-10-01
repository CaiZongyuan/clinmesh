import type { FhirResource } from '@clinmesh/contracts/fhir'
import {
  acknowledgeImagingReportResponseSchema,
  caseImagingServiceCatalogSchema,
  correctImagingReportResponseSchema,
  imagingReportSchema,
  imagingRequestActionResponseSchema,
  imagingRequestDraftResponseSchema,
  imagingRequestSchema,
  imagingRequestStateSchema,
  imagingServiceSnapshotSchema,
  issueImagingRequestResponseSchema,
  type ApiConflict,
  type ImagingServiceSnapshot,
} from '@clinmesh/contracts/his'
import type { ImagingExamCode } from '@clinmesh/contracts/imaging'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository } from '../infrastructure/sqlite/fhir-repository.ts'
import {
  reportAcknowledgementRowSchema,
  type ClinicalRequestKernel,
  type ClinicalRequestPolicy,
} from './clinical-request-kernel.ts'
import {
  ExpectedVersionConflictError,
  provenanceAgents,
  type ActorContext,
  type CommandExecutor,
  type CommandTransaction,
} from './command-executor.ts'
import { WorkflowError } from './workflow-error.ts'

export const imagingRequestPolicy: ClinicalRequestPolicy = {
  dedupPrefix: 'imaging-request',
  generationFailedStatusText: 'Imaging result unavailable',
  generationRetryingStatusText: 'Imaging result retrying',
  kind: 'imaging',
  label: 'imaging',
  notCancellableCode: 'IMAGING_REQUEST_NOT_CANCELLABLE',
  outbox: { report: 'imaging.report-request', start: 'imaging.start-request' },
  owner: 'imaging-request',
  resourceType: 'ImagingRequest',
  versionConflictCode: 'IMAGING_REQUEST_VERSION_CONFLICT',
}

/**
 * 版本固定的本院放射服务定义。服务明确部位、检查方式、执行科室、适用范围与报告结构；
 * 增强 CT、定位像等不相容的检查不属于这些服务。
 */
export const imagingServiceBaseline: ImagingServiceSnapshot[] = [
  {
    applicability: '成人胸部疾病的评估与随访；不含增强扫描',
    bodySite: '胸部',
    code: 'CT-CHEST-PLAIN',
    department: '放射科',
    examCode: 'chest-ct-plain',
    id: 'imaging-chest-ct-plain',
    method: '平扫（不使用造影剂）',
    modality: 'CT',
    name: '胸部 CT 平扫',
    reportSections: ['technique', 'findings', 'impression'],
    version: 1,
  },
  {
    applicability: '成人胸部疾病的初步评估',
    bodySite: '胸部',
    code: 'DX-CHEST',
    department: '放射科',
    examCode: 'chest-radiograph',
    id: 'imaging-chest-radiograph',
    method: 'X 线摄影（正位，素材含侧位时一并提供）',
    modality: 'DX',
    name: '胸片',
    reportSections: ['technique', 'findings', 'impression'],
    version: 1,
  },
]

const imagingServiceCodeSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/imaging-service'
const freeTextIndicationCode = 'free-text'

const draftRowSchema = z.object({
  draft_indication: z.string().nullable(),
  draft_service_id: z.string().nullable(),
  draft_service_snapshot_json: z.string().nullable(),
  version: z.number().int().positive(),
}).strict()

const requestRowSchema = z.object({
  authored_by: z.string().min(1),
  case_id: z.string().min(1),
  diagnostic_report_id: z.string().nullable(),
  encounter_id: z.string().min(1),
  exam_code: z.enum(['chest-ct-plain', 'chest-radiograph']),
  execution_task_id: z.string().min(1),
  generation_error_code: z.string().nullable(),
  generation_error_message: z.string().nullable(),
  indication: z.string().min(1),
  patient_id: z.string().min(1),
  request_id: z.string().min(1),
  service_request_id: z.string().min(1),
  service_snapshot_json: z.string().min(1),
  status: z.enum(['acknowledged', 'accepted', 'cancelled', 'generation-failed', 'in-progress', 'issued', 'reported']),
  version: z.number().int().positive(),
}).strict()

const reportContentRowSchema = z.object({
  diagnostic_report_id: z.string().min(1),
  findings: z.string().min(1),
  impression: z.string().min(1),
  issued_at: z.string().min(1),
  performed_at: z.string().min(1),
  report_revision: z.number().int().positive(),
  study_id: z.string().min(1),
  technique: z.string().min(1),
}).strict()

const reportRevisionRowSchema = z.object({
  reason: z.string().min(1),
  request_id: z.string().min(1),
  revision_of_diagnostic_report_id: z.string().min(1),
}).strict()

const systemResponseSchema = z.object({
  requestId: z.string().min(1),
  status: z.enum(['accepted', 'cancelled', 'generation-failed', 'in-progress']),
}).strict()

const reportSystemResponseSchema = z.object({
  diagnosticReportId: z.string().min(1),
  requestId: z.string().min(1),
  status: z.literal('reported'),
  studyId: z.string().min(1),
}).strict()

/** 已核对素材为一次检查提供的报告内容；由执行器在命令之外解析并确认素材可用后传入。 */
export interface ImagingResult {
  assetId: string
  assetOutput: unknown
  findings: string
  impression: string
  reportContentSha256: string
  reportRevision: number
  technique: string
}

/** 放射适配器使用的门诊工作流能力：病例定位、责任校验与当前 Virtual Time。 */
export interface ImagingRequestHost {
  assertCaseResponsibility(context: ActorContext, caseId: string): void
  assertExpectedVersions(expectedVersions: Record<string, string>, references: string[]): void
  caseByEncounter(context: ActorContext, encounterId: string): { case_id: string; patient_id: string; status: string }
  hasConsultation(context: ActorContext, caseId: string): boolean
  virtualTime(context: ActorContext): string
}

type RequestRow = z.infer<typeof requestRowSchema>

function assertRole(context: ActorContext, roles: string[]): void {
  if (!roles.includes(context.roleCode)) {
    throw new WorkflowError('ROLE_NOT_ALLOWED', 'The active Practitioner Role cannot perform this action')
  }
}

function resourceEffect(resource: FhirResource) {
  return {
    kind: resource.meta?.versionId === '1' ? 'created' as const : 'updated' as const,
    reference: `${resource.resourceType}/${resource.id}`,
    versionId: resource.meta?.versionId ?? '1',
  }
}

/**
 * 放射申请适配器：草稿、开立、执行、报告、已阅和更正。申请生命周期（受理、开始、失败、重试、取消、
 * 确认已阅与修订关联）由共享申请内核承担，这里只拥有放射的内容规则与本院检查记录。
 */
export class ImagingRequestService {
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  readonly #fhir: FhirRepository
  readonly #host: ImagingRequestHost
  readonly #requests: ClinicalRequestKernel

  constructor(input: {
    commands: CommandExecutor
    database: ClinMeshDatabase
    fhir: FhirRepository
    host: ImagingRequestHost
    requests: ClinicalRequestKernel
  }) {
    this.#commands = input.commands
    this.#database = input.database
    this.#fhir = input.fhir
    this.#host = input.host
    this.#requests = input.requests
  }

  /** 把基线放射服务写入每个活动 Epoch 的本院服务目录；已存在的服务不改动。 */
  ensureServices(): void {
    const epochs = z.array(z.object({ epoch: z.string(), workspaceId: z.string() })).parse(
      this.#database.driver.prepare(`
        SELECT workspace_id AS workspaceId, active_epoch AS epoch FROM workspace
      `).all(),
    )
    const insert = this.#database.driver.prepare(`
      INSERT OR IGNORE INTO hospital_service_catalog (
        workspace_id, epoch, service_id, code, name_zh, name_en, version, active, config_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `)
    for (const current of epochs) {
      for (const service of imagingServiceBaseline) {
        insert.run(
          current.workspaceId,
          current.epoch,
          service.id,
          service.code,
          service.name,
          service.name,
          service.version,
          JSON.stringify({ imagingService: service }),
        )
      }
    }
  }

  /** 医生可开立的放射服务；是否开展由医院启用状态与素材就绪共同决定，不参考病例病情。 */
  serviceCatalog(context: ActorContext, readyExamCodes: ReadonlySet<ImagingExamCode>) {
    assertRole(context, ['outpatient-doctor'])
    const services = z.array(z.object({ config_json: z.string() })).parse(this.#database.driver.prepare(`
      SELECT config_json FROM hospital_service_catalog
      WHERE workspace_id = ? AND epoch = ? AND active = 1
        AND json_type(config_json, '$.imagingService') = 'object'
      ORDER BY service_id
    `).all(context.workspaceId, context.epoch))
      .map(row => imagingServiceSnapshotSchema.parse(JSON.parse(row.config_json).imagingService))
    return caseImagingServiceCatalogSchema.parse({
      items: services.map(service => ({ available: readyExamCodes.has(service.examCode), service })),
    })
  }

  /**
   * 阅片读取的授权：门诊医生、当前 Workspace/Epoch 内已发布且未取消的检查、并且是该病例的责任医生。
   * 检查不存在时返回 undefined；岗位或责任不符时抛出权限错误。
   */
  studyAccess(context: ActorContext, studyId: string) {
    assertRole(context, ['outpatient-doctor'])
    const study = z.object({
      asset_id: z.string().min(1),
      asset_output_json: z.string().min(1),
      case_id: z.string().min(1),
      exam_code: z.enum(['chest-ct-plain', 'chest-radiograph']),
    }).strict().optional().parse(this.#database.driver.prepare(`
      SELECT study.asset_id, study.asset_output_json, study.case_id, study.exam_code
      FROM imaging_study AS study
      JOIN laboratory_request AS request
        ON request.workspace_id = study.workspace_id
       AND request.epoch = study.epoch
       AND request.request_id = study.request_id
      WHERE study.workspace_id = ? AND study.epoch = ? AND study.study_id = ?
        AND request.status IN ('reported', 'acknowledged')
    `).get(context.workspaceId, context.epoch, studyId))
    if (study === undefined) return undefined
    this.#host.assertCaseResponsibility(context, study.case_id)
    return {
      assetId: study.asset_id,
      assetOutput: JSON.parse(study.asset_output_json) as unknown,
      examCode: study.exam_code,
    }
  }

  state(context: ActorContext, caseId: string) {
    const draft = this.#draft(context, caseId)
    return imagingRequestStateSchema.parse({
      ...(draft?.draft_service_snapshot_json === null || draft?.draft_service_snapshot_json === undefined
        ? {}
        : {
            draft: {
              indication: draft.draft_indication,
              service: JSON.parse(draft.draft_service_snapshot_json),
            },
          }),
      draftVersion: draft?.version ?? 0,
      requests: this.#projectedRequests(context, caseId),
    })
  }

  hasDraft(context: ActorContext, caseId: string): boolean {
    return typeof this.#draft(context, caseId)?.draft_service_id === 'string'
  }

  saveDraft(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    indication: string
    serviceId: string
  }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: imagingRequestDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
        indication: input.indication,
        serviceId: input.serviceId,
      },
      operation: 'imaging-request.save-draft',
    }, () => {
      const outpatientCase = this.#caseForAction(input.context, input.encounterId)
      this.#host.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const service = this.#activeService(input.context, input.serviceId)
      const current = this.#draft(input.context, outpatientCase.case_id)
      if ((current?.version ?? 0) !== input.expectedDraftVersion) throw this.#draftConflict()
      const draftVersion = input.expectedDraftVersion + 1
      const now = this.#host.virtualTime(input.context)
      if (current === undefined) {
        this.#database.driver.prepare(`
          INSERT INTO imaging_request_state (
            workspace_id, epoch, case_id, version, draft_service_id, draft_indication,
            draft_service_snapshot_json, updated_by, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.context.workspaceId,
          input.context.epoch,
          outpatientCase.case_id,
          draftVersion,
          service.id,
          input.indication,
          JSON.stringify(service),
          input.context.actorId,
          now,
        )
      } else {
        this.#updateDraft(input.context, outpatientCase.case_id, current.version, {
          indication: input.indication,
          now,
          service,
        })
      }
      return { data: { caseId: outpatientCase.case_id, draftVersion }, effects: [] }
    })
  }

  deleteDraft(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: imagingRequestDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId, expectedDraftVersion: input.expectedDraftVersion },
      operation: 'imaging-request.delete-draft',
    }, () => {
      const outpatientCase = this.#caseForAction(input.context, input.encounterId)
      this.#host.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const current = this.#draft(input.context, outpatientCase.case_id)
      if (current?.version !== input.expectedDraftVersion || current.draft_service_id === null) {
        throw this.#draftConflict({
          currentStatus: current === undefined ? 'missing' : current.draft_service_id === null ? 'empty' : 'draft',
          ...(current === undefined ? {} : { currentVersion: String(current.version) }),
          expectedVersion: String(input.expectedDraftVersion),
          owner: 'imaging-request-draft',
          resource: `ImagingRequestDraft/${outpatientCase.case_id}`,
        })
      }
      this.#updateDraft(input.context, outpatientCase.case_id, current.version, {
        now: this.#host.virtualTime(input.context),
      })
      const draftVersion = current.version + 1
      return {
        data: { caseId: outpatientCase.case_id, draftVersion },
        effects: [{
          kind: 'updated' as const,
          reference: `ImagingRequestDraft/${outpatientCase.case_id}`,
          versionId: String(draftVersion),
        }],
      }
    })
  }

  issue(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: issueImagingRequestResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId, expectedDraftVersion: input.expectedDraftVersion },
      operation: 'imaging-request.issue',
    }, (transaction) => {
      const outpatientCase = this.#caseForAction(input.context, input.encounterId)
      this.#host.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const draft = this.#draft(input.context, outpatientCase.case_id)
      if (draft?.version !== input.expectedDraftVersion
        || draft.draft_service_id === null
        || draft.draft_indication === null
        || draft.draft_service_snapshot_json === null) {
        throw this.#draftConflict()
      }
      // 开立使用草稿保存时冻结的服务定义；服务此后变更时要求重新保存草稿。
      const service = imagingServiceSnapshotSchema.parse(JSON.parse(draft.draft_service_snapshot_json))
      if (JSON.stringify(this.#activeService(input.context, service.id)) !== JSON.stringify(service)) {
        throw new WorkflowError('CATALOG_CONFLICT', 'The imaging service changed after the draft was saved')
      }
      const duplicate = this.#database.driver.prepare(`
        SELECT request_id FROM laboratory_request
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND catalog_item_id = ?
          AND status IN ('issued', 'accepted', 'in-progress', 'generation-failed')
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id, service.id)
      if (duplicate !== undefined) {
        throw new WorkflowError(
          'IMAGING_REQUEST_DUPLICATE',
          'An active imaging request already exists for this service',
        )
      }
      const now = this.#host.virtualTime(input.context)
      const requestId = uuidv7()
      const serviceRequest = transaction.fhir.create(input.context, {
        resourceType: 'ServiceRequest',
        id: uuidv7(),
        status: 'active',
        intent: 'order',
        category: [{
          coding: [{ code: '363679005', display: 'Imaging', system: 'http://snomed.info/sct' }],
        }],
        code: {
          concept: {
            coding: [{ code: service.code, display: service.name, system: imagingServiceCodeSystem }],
            text: service.name,
          },
        },
        subject: { reference: `Patient/${outpatientCase.patient_id}` },
        encounter: { reference: `Encounter/${input.encounterId}` },
        authoredOn: now,
        requester: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
        reason: [{ concept: { text: draft.draft_indication } }],
      })
      const task = transaction.fhir.create(input.context, {
        resourceType: 'Task',
        id: uuidv7(),
        status: 'requested',
        intent: 'order',
        code: {
          coding: [{
            code: 'imaging-request-execution',
            system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/task-kind',
          }],
          text: `${service.name}执行`,
        },
        focus: { reference: `ServiceRequest/${serviceRequest.id}` },
        for: { reference: `Patient/${outpatientCase.patient_id}` },
        encounter: { reference: `Encounter/${input.encounterId}` },
        authoredOn: now,
        requester: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
        owner: { reference: 'Organization/organization-clinmesh' },
      })
      this.#database.driver.prepare(`
        INSERT INTO laboratory_request (
          workspace_id, epoch, request_id, case_id, request_kind, catalog_item_id,
          service_snapshot_json, indication_code, service_request_id, execution_task_id,
          status, version, authored_by, authored_at
        ) VALUES (?, ?, ?, ?, 'imaging', ?, ?, ?, ?, ?, 'issued', 1, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        requestId,
        outpatientCase.case_id,
        service.id,
        JSON.stringify(service),
        freeTextIndicationCode,
        serviceRequest.id,
        task.id,
        input.context.practitionerId ?? input.context.actorId,
        now,
      )
      this.#database.driver.prepare(`
        INSERT INTO imaging_request_detail (workspace_id, epoch, request_id, exam_code, indication)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.context.workspaceId, input.context.epoch, requestId, service.examCode, draft.draft_indication)
      this.#updateDraft(input.context, outpatientCase.case_id, draft.version, { now })
      transaction.enqueue({
        dedupKey: `imaging-request:${requestId}:accept`,
        kind: 'imaging.accept-request',
        payload: { requestId },
      })
      return {
        data: {
          caseId: outpatientCase.case_id,
          draftVersion: draft.version + 1,
          request: this.#projectedRequest(input.context, requestId),
        },
        effects: [serviceRequest, task].map(resourceEffect),
      }
    })
  }

  cancel(input: {
    context: ActorContext
    expectedRequestVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    reasonCode: 'no-longer-needed'
    requestId: string
  }) {
    try {
      return this.#commands.execute({
        authorize: () => {
          assertRole(input.context, ['outpatient-doctor'])
          const request = this.#request(input.context, input.requestId)
          if (request === undefined
            || request.authored_by !== (input.context.practitionerId ?? input.context.actorId)) {
            throw new WorkflowError('WORKFLOW_CONFLICT', 'The imaging request was not found')
          }
          this.#host.assertCaseResponsibility(input.context, request.case_id)
        },
        context: input.context,
        dataSchema: imagingRequestActionResponseSchema.shape.data,
        expectedVersions: input.expectedVersions,
        idempotencyKey: input.idempotencyKey,
        input: {
          expectedRequestVersion: input.expectedRequestVersion,
          reasonCode: input.reasonCode,
          requestId: input.requestId,
        },
        operation: 'imaging-request.cancel',
      }, (transaction) => {
        const request = this.#requiredRequest(input.context, input.requestId)
        this.#host.assertExpectedVersions(input.expectedVersions, [
          `ServiceRequest/${request.service_request_id}`,
          `Task/${request.execution_task_id}`,
        ])
        const cancelled = this.#requests.cancel(imagingRequestPolicy, transaction, input.context, request, {
          expectedRequestVersion: input.expectedRequestVersion,
          now: this.#host.virtualTime(input.context),
          reasonCode: input.reasonCode,
        })
        return {
          data: { request: this.#projectedRequest(input.context, request.request_id) },
          effects: [cancelled.serviceRequest, cancelled.task].map(resourceEffect),
        }
      })
    } catch (error) {
      if (!(error instanceof ExpectedVersionConflictError)) throw error
      throw this.#requests.relatedVersionConflict(
        imagingRequestPolicy,
        this.#requiredRequest(input.context, input.requestId),
        input.expectedRequestVersion,
      )
    }
  }

  accept(input: { context: ActorContext; eventId: string; requestId: string }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: systemResponseSchema,
      expectedVersions: {},
      idempotencyKey: input.eventId,
      input: { requestId: input.requestId },
      operation: 'imaging-request.accept',
    }, (transaction) => {
      assertRole(input.context, ['ris-system'])
      const request = this.#requiredRequest(input.context, input.requestId)
      const accepted = this.#requests.accept(
        imagingRequestPolicy,
        transaction,
        input.context,
        request,
        this.#host.virtualTime(input.context),
      )
      return accepted.status === 'cancelled'
        ? { data: { requestId: request.request_id, status: 'cancelled' as const }, effects: [] }
        : { data: { requestId: request.request_id, status: 'accepted' as const }, effects: [resourceEffect(accepted.task)] }
    })
  }

  start(input: { context: ActorContext; eventId: string; requestId: string }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: systemResponseSchema,
      expectedVersions: {},
      idempotencyKey: input.eventId,
      input: { requestId: input.requestId },
      operation: 'imaging-request.start',
    }, (transaction) => {
      assertRole(input.context, ['ris-system'])
      const request = this.#requiredRequest(input.context, input.requestId)
      const task = this.#requests.start(imagingRequestPolicy, transaction, input.context, request, {
        enqueueReport: true,
        now: this.#host.virtualTime(input.context),
      })
      return { data: { requestId: request.request_id, status: 'in-progress' as const }, effects: [resourceEffect(task)] }
    })
  }

  /** 在同一事务发布本院检查记录、报告、Provenance 与申请完成效果。 */
  report(input: { context: ActorContext; eventId: string; requestId: string; result: ImagingResult }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: reportSystemResponseSchema,
      expectedVersions: {},
      idempotencyKey: input.eventId,
      input: {
        reportContentSha256: input.result.reportContentSha256,
        requestId: input.requestId,
      },
      operation: 'imaging-request.report',
    }, (transaction) => {
      assertRole(input.context, ['ris-system'])
      const request = this.#requiredRequest(input.context, input.requestId)
      if (request.status === 'reported' && request.diagnostic_report_id !== null) {
        return {
          data: {
            diagnosticReportId: request.diagnostic_report_id,
            requestId: request.request_id,
            status: 'reported' as const,
            studyId: this.#reportContent(input.context, request.diagnostic_report_id).study_id,
          },
          effects: [],
        }
      }
      if (request.status !== 'in-progress') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'Only an in-progress imaging request can be reported')
      }
      const serviceRequest = transaction.fhir.read(input.context, 'ServiceRequest', request.service_request_id)
      const task = transaction.fhir.read(input.context, 'Task', request.execution_task_id)
      if (serviceRequest.status !== 'active' || task.status !== 'in-progress') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The formal imaging request is not in progress')
      }
      const now = this.#host.virtualTime(input.context)
      const service = imagingServiceSnapshotSchema.parse(JSON.parse(request.service_snapshot_json))
      // 本院检查使用新生成的标识，不复用来源 UID；失败后重试沿用已创建的检查记录。
      const existingStudy = z.object({ study_id: z.string() }).optional().parse(this.#database.driver.prepare(`
        SELECT study_id FROM imaging_study WHERE workspace_id = ? AND epoch = ? AND request_id = ?
      `).get(input.context.workspaceId, input.context.epoch, request.request_id))
      const studyId = existingStudy?.study_id ?? uuidv7()
      const projections: FhirResource[] = []
      if (existingStudy === undefined) {
        const studyInstanceUid = `2.25.${BigInt(`0x${uuidv7().replaceAll('-', '')}`).toString()}`
        // ImagingStudy 是本院检查记录的只读投影，只携带本院标识，不含素材或来源信息。
        projections.push(transaction.fhir.createProjection(input.context, {
          resourceType: 'ImagingStudy',
          id: studyId,
          status: 'available',
          identifier: [{ system: 'urn:dicom:uid', value: `urn:oid:${studyInstanceUid}` }],
          modality: [{
            coding: [{ code: service.modality, system: 'http://dicom.nema.org/resources/ontology/DCM' }],
          }],
          subject: { reference: `Patient/${request.patient_id}` },
          encounter: { reference: `Encounter/${request.encounter_id}` },
          started: now,
          basedOn: [{ reference: `ServiceRequest/${request.service_request_id}` }],
          description: service.name,
        }))
        this.#database.driver.prepare(`
          INSERT INTO imaging_study (
            workspace_id, epoch, study_id, request_id, case_id, exam_code,
            study_instance_uid, asset_id, asset_output_json, performed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.context.workspaceId,
          input.context.epoch,
          studyId,
          request.request_id,
          request.case_id,
          request.exam_code,
          studyInstanceUid,
          input.result.assetId,
          JSON.stringify(input.result.assetOutput),
          now,
        )
      }
      const report = this.#createReport(transaction, input.context, request, {
        now,
        result: input.result,
        serviceName: service.name,
        serviceCode: service.code,
        studyId,
      })
      const completed = this.#requests.completeReport(imagingRequestPolicy, transaction, input.context, request, {
        diagnosticReportId: report.id,
        now,
        resultSnapshotId: null,
        serviceRequest,
        task,
      })
      const provenance = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Provenance',
        id: uuidv7(),
        target: [
          { reference: `DiagnosticReport/${report.id}` },
          { reference: `ServiceRequest/${request.service_request_id}` },
          { reference: `Task/${request.execution_task_id}` },
        ],
        recorded: now,
        activity: { text: 'Imaging report issuance from a reviewed imaging asset' },
        agent: provenanceAgents(input.context, 'Imaging report issuer'),
      })
      return {
        data: { diagnosticReportId: report.id, requestId: request.request_id, status: 'reported' as const, studyId },
        effects: [...projections, report, provenance, completed.serviceRequest, completed.task].map(resourceEffect),
      }
    })
  }

  fail(input: {
    context: ActorContext
    error: { code: string; message: string }
    eventId: string
    requestId: string
  }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: systemResponseSchema,
      expectedVersions: {},
      idempotencyKey: input.eventId,
      input: { errorCode: input.error.code, requestId: input.requestId },
      operation: 'imaging-request.fail',
    }, (transaction) => {
      assertRole(input.context, ['ris-system'])
      const request = this.#requiredRequest(input.context, input.requestId)
      const failedTask = this.#requests.failGeneration(imagingRequestPolicy, transaction, input.context, request, {
        error: input.error,
        now: this.#host.virtualTime(input.context),
      })
      return {
        data: { requestId: request.request_id, status: 'generation-failed' as const },
        effects: failedTask === undefined ? [] : [resourceEffect(failedTask)],
      }
    })
  }

  retry(input: {
    context: ActorContext
    expectedRequestVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    requestId: string
  }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: imagingRequestActionResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { expectedRequestVersion: input.expectedRequestVersion, requestId: input.requestId },
      operation: 'imaging-request.retry',
    }, (transaction) => {
      assertRole(input.context, ['outpatient-doctor'])
      const request = this.#requiredRequest(input.context, input.requestId)
      this.#requests.assertRetryable(imagingRequestPolicy, input.context, request, input.expectedRequestVersion)
      this.#host.assertExpectedVersions(input.expectedVersions, [`Task/${request.execution_task_id}`])
      const task = this.#requests.retryGeneration(
        imagingRequestPolicy,
        transaction,
        input.context,
        request,
        this.#host.virtualTime(input.context),
      )
      return {
        data: { request: this.#projectedRequest(input.context, request.request_id) },
        effects: [resourceEffect(task)],
      }
    })
  }

  acknowledge(input: {
    context: ActorContext
    diagnosticReportId: string
    expectedRequestVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    requestId: string
  }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: acknowledgeImagingReportResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        diagnosticReportId: input.diagnosticReportId,
        expectedRequestVersion: input.expectedRequestVersion,
        requestId: input.requestId,
      },
      operation: 'imaging-report.acknowledge',
    }, (transaction) => {
      assertRole(input.context, ['outpatient-doctor'])
      this.#host.assertExpectedVersions(input.expectedVersions, [`DiagnosticReport/${input.diagnosticReportId}`])
      const request = this.#requiredRequest(input.context, input.requestId)
      const acknowledgement = this.#requests.acknowledge(imagingRequestPolicy, transaction, input.context, request, {
        assertReportContent: () => { this.#reportContent(input.context, input.diagnosticReportId) },
        diagnosticReportId: input.diagnosticReportId,
        expectedRequestVersion: input.expectedRequestVersion,
        now: this.#host.virtualTime(input.context),
      })
      return {
        data: {
          acknowledgementId: acknowledgement.acknowledgementId,
          acknowledgedAt: acknowledgement.acknowledgedAt,
          acknowledgedBy: acknowledgement.acknowledgedBy,
          diagnosticReportId: acknowledgement.diagnosticReportId,
          requestId: acknowledgement.requestId,
          requestVersion: acknowledgement.requestVersion,
          status: 'acknowledged' as const,
        },
        effects: acknowledgement.created
          ? [{
              kind: 'created' as const,
              reference: `ReportAcknowledgement/${acknowledgement.acknowledgementId}`,
              versionId: '1',
            }]
          : [],
      }
    })
  }

  /** 管理员更正：用同一素材另一份已核对发布的报告内容修订签发新报告；原报告与原确认保留。 */
  correct(input: {
    context: ActorContext
    diagnosticReportId: string
    expectedRequestVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    reason: string
    requestId: string
    result: ImagingResult
  }) {
    return this.#commands.execute({
      authorize: () => assertRole(input.context, ['ris-system']),
      context: input.context,
      dataSchema: correctImagingReportResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        diagnosticReportId: input.diagnosticReportId,
        expectedRequestVersion: input.expectedRequestVersion,
        reason: input.reason,
        reportContentSha256: input.result.reportContentSha256,
        requestId: input.requestId,
      },
      operation: 'imaging-report.correct',
    }, (transaction) => {
      this.#host.assertExpectedVersions(input.expectedVersions, [`DiagnosticReport/${input.diagnosticReportId}`])
      const request = this.#requiredRequest(input.context, input.requestId)
      const conflict = (currentStatus: NonNullable<ApiConflict['currentStatus']>): ApiConflict => ({
        currentStatus,
        currentVersion: String(request.version),
        expectedVersion: String(input.expectedRequestVersion),
        owner: 'imaging-report',
        resource: `DiagnosticReport/${input.diagnosticReportId}`,
      })
      if (request.version !== input.expectedRequestVersion) {
        throw new WorkflowError(
          'IMAGING_REQUEST_VERSION_CONFLICT',
          `The imaging request is "${request.status}" at version ${request.version}; expected version ${input.expectedRequestVersion}`,
          conflict(request.status),
        )
      }
      if (request.diagnostic_report_id !== input.diagnosticReportId) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The imaging report is superseded; only the latest signed report can be corrected',
          conflict('superseded'),
        )
      }
      if (request.status !== 'reported' && request.status !== 'acknowledged') {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          `The imaging report cannot be corrected while the request status is "${request.status}"`,
          conflict(request.status),
        )
      }
      const current = this.#reportContent(input.context, input.diagnosticReportId)
      const study = z.object({ asset_id: z.string() }).parse(this.#database.driver.prepare(`
        SELECT asset_id FROM imaging_study WHERE workspace_id = ? AND epoch = ? AND study_id = ?
      `).get(input.context.workspaceId, input.context.epoch, current.study_id))
      // 更正不能更换像素，也不能重发同一份内容。
      if (study.asset_id !== input.result.assetId || current.report_revision === input.result.reportRevision) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The correction must use another reviewed report revision of the same imaging asset',
        )
      }
      const now = this.#host.virtualTime(input.context)
      const service = imagingServiceSnapshotSchema.parse(JSON.parse(request.service_snapshot_json))
      const report = this.#createReport(transaction, input.context, request, {
        now,
        result: input.result,
        serviceCode: service.code,
        serviceName: service.name,
        studyId: current.study_id,
      })
      const provenance = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Provenance',
        id: uuidv7(),
        target: [{ reference: `DiagnosticReport/${report.id}` }],
        recorded: now,
        activity: { text: 'Imaging report correction' },
        reason: [{ concept: { text: input.reason } }],
        agent: provenanceAgents(input.context, 'Imaging report corrector'),
        entity: [{ role: 'revision', what: { reference: `DiagnosticReport/${input.diagnosticReportId}` } }],
      })
      this.#requests.recordReportRevision(imagingRequestPolicy, input.context, request, {
        diagnosticReportId: report.id,
        now,
        provenanceId: provenance.id,
        reason: input.reason,
        revisionOfDiagnosticReportId: input.diagnosticReportId,
      })
      return {
        data: {
          diagnosticReportId: report.id,
          previousDiagnosticReportId: input.diagnosticReportId,
          provenanceId: provenance.id,
          requestId: request.request_id,
          requestVersion: request.version + 1,
          status: 'reported' as const,
        },
        effects: [report, provenance].map(resourceEffect),
      }
    })
  }

  #createReport(
    transaction: CommandTransaction,
    context: ActorContext,
    request: RequestRow,
    input: { now: string; result: ImagingResult; serviceCode: string; serviceName: string; studyId: string },
  ): FhirResource {
    const report = transaction.fhir.create(context, {
      resourceType: 'DiagnosticReport',
      id: uuidv7(),
      status: 'final',
      category: [{
        coding: [{ code: 'RAD', display: 'Radiology', system: 'http://terminology.hl7.org/CodeSystem/v2-0074' }],
      }],
      code: {
        coding: [{ code: input.serviceCode, display: input.serviceName, system: imagingServiceCodeSystem }],
        text: `${input.serviceName}报告`,
      },
      subject: { reference: `Patient/${request.patient_id}` },
      encounter: { reference: `Encounter/${request.encounter_id}` },
      basedOn: [{ reference: `ServiceRequest/${request.service_request_id}` }],
      effectiveDateTime: input.now,
      issued: input.now,
      study: [{ reference: `ImagingStudy/${input.studyId}` }],
      conclusion: input.result.impression,
    })
    this.#database.driver.prepare(`
      INSERT INTO imaging_report_content (
        workspace_id, epoch, diagnostic_report_id, request_id, study_id, report_revision,
        report_content_sha256, technique, findings, impression, issued_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      report.id,
      request.request_id,
      input.studyId,
      input.result.reportRevision,
      input.result.reportContentSha256,
      input.result.technique,
      input.result.findings,
      input.result.impression,
      input.now,
    )
    return report
  }

  #caseForAction(context: ActorContext, encounterId: string) {
    assertRole(context, ['outpatient-doctor'])
    const outpatientCase = this.#host.caseByEncounter(context, encounterId)
    this.#host.assertCaseResponsibility(context, outpatientCase.case_id)
    if (outpatientCase.status !== 'first-visit' || !this.#host.hasConsultation(context, outpatientCase.case_id)) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter cannot edit or issue an imaging request')
    }
    return outpatientCase
  }

  #activeService(context: ActorContext, serviceId: string): ImagingServiceSnapshot {
    const row = z.object({ config_json: z.string() }).optional().parse(this.#database.driver.prepare(`
      SELECT config_json FROM hospital_service_catalog
      WHERE workspace_id = ? AND epoch = ? AND service_id = ? AND active = 1
        AND json_type(config_json, '$.imagingService') = 'object'
    `).get(context.workspaceId, context.epoch, serviceId))
    if (row === undefined) throw new WorkflowError('CATALOG_CONFLICT', 'The imaging service is unavailable')
    return imagingServiceSnapshotSchema.parse(JSON.parse(row.config_json).imagingService)
  }

  #draft(context: ActorContext, caseId: string) {
    return draftRowSchema.optional().parse(this.#database.driver.prepare(`
      SELECT version, draft_service_id, draft_indication, draft_service_snapshot_json
      FROM imaging_request_state
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).get(context.workspaceId, context.epoch, caseId))
  }

  /** 以版本 CAS 更新草稿；不给内容时清空草稿。 */
  #updateDraft(
    context: ActorContext,
    caseId: string,
    currentVersion: number,
    input: { indication?: string; now: string; service?: ImagingServiceSnapshot },
  ): void {
    const update = this.#database.driver.prepare(`
      UPDATE imaging_request_state
      SET version = ?, draft_service_id = ?, draft_indication = ?, draft_service_snapshot_json = ?,
        updated_by = ?, updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND version = ?
    `).run(
      currentVersion + 1,
      input.service?.id ?? null,
      input.service === undefined ? null : input.indication ?? null,
      input.service === undefined ? null : JSON.stringify(input.service),
      context.actorId,
      input.now,
      context.workspaceId,
      context.epoch,
      caseId,
      currentVersion,
    )
    if (update.changes !== 1) throw this.#draftConflict()
  }

  #draftConflict(conflict?: ApiConflict): WorkflowError {
    return new WorkflowError(
      'IMAGING_REQUEST_VERSION_CONFLICT',
      'The imaging request draft version has changed',
      conflict,
    )
  }

  #request(context: ActorContext, requestId: string): RequestRow | undefined {
    return requestRowSchema.optional().parse(this.#database.driver.prepare(`${this.#requestSelect}
      WHERE request.workspace_id = ? AND request.epoch = ? AND request.request_id = ?
        AND request.request_kind = 'imaging'
    `).get(context.workspaceId, context.epoch, requestId))
  }

  #requiredRequest(context: ActorContext, requestId: string): RequestRow {
    const request = this.#request(context, requestId)
    if (request === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The imaging request was not found')
    return request
  }

  readonly #requestSelect = `
    SELECT request.request_id, request.case_id, request.service_snapshot_json,
      request.generation_error_code, request.generation_error_message,
      request.service_request_id, request.execution_task_id, request.diagnostic_report_id,
      request.status, request.version, request.authored_by,
      detail.exam_code, detail.indication,
      outpatient_case.patient_id, outpatient_case.encounter_id
    FROM laboratory_request AS request
    JOIN imaging_request_detail AS detail
      ON detail.workspace_id = request.workspace_id
     AND detail.epoch = request.epoch
     AND detail.request_id = request.request_id
    JOIN outpatient_case
      ON outpatient_case.workspace_id = request.workspace_id
     AND outpatient_case.epoch = request.epoch
     AND outpatient_case.case_id = request.case_id
  `

  #projectedRequests(context: ActorContext, caseId: string) {
    return z.array(requestRowSchema).parse(this.#database.driver.prepare(`${this.#requestSelect}
      WHERE request.workspace_id = ? AND request.epoch = ? AND request.case_id = ?
        AND request.request_kind = 'imaging'
      ORDER BY request.authored_at, request.request_id
    `).all(context.workspaceId, context.epoch, caseId)).map(request => this.#project(context, request))
  }

  #projectedRequest(context: ActorContext, requestId: string) {
    return this.#project(context, this.#requiredRequest(context, requestId))
  }

  #project(context: ActorContext, request: RequestRow) {
    const serviceRequest = this.#fhir.read(context, 'ServiceRequest', request.service_request_id)
    const task = this.#fhir.read(context, 'Task', request.execution_task_id)
    const reports = request.diagnostic_report_id === null
      ? []
      : this.#reportVersions(context, request.request_id, request.diagnostic_report_id)
    return imagingRequestSchema.parse({
      ...(request.generation_error_code === null || request.generation_error_message === null
        ? {}
        : { generationError: { code: request.generation_error_code, message: request.generation_error_message } }),
      id: request.request_id,
      indication: request.indication,
      previousReports: reports.slice(0, -1),
      ...(reports.length === 0 ? {} : { report: reports.at(-1) }),
      service: JSON.parse(request.service_snapshot_json),
      serviceRequestId: request.service_request_id,
      serviceRequestVersion: serviceRequest.meta?.versionId ?? '1',
      status: request.status,
      taskId: request.execution_task_id,
      taskVersion: task.meta?.versionId ?? '1',
      version: request.version,
    })
  }

  /** 从当前报告沿修订关系回溯到首份报告，按签发顺序返回。 */
  #reportVersions(context: ActorContext, requestId: string, diagnosticReportId: string) {
    const chain: Array<{ diagnosticReportId: string; revision?: z.infer<typeof reportRevisionRowSchema> }> = []
    let currentId: string | undefined = diagnosticReportId
    while (currentId !== undefined) {
      if (chain.some(entry => entry.diagnosticReportId === currentId)) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The imaging report revision chain is cyclic')
      }
      const revision = reportRevisionRowSchema.optional().parse(this.#database.driver.prepare(`
        SELECT reason, request_id, revision_of_diagnostic_report_id
        FROM laboratory_report_revision
        WHERE workspace_id = ? AND epoch = ? AND diagnostic_report_id = ?
      `).get(context.workspaceId, context.epoch, currentId))
      if (revision !== undefined && revision.request_id !== requestId) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The imaging report revision does not belong to its request')
      }
      chain.push({ diagnosticReportId: currentId, ...(revision === undefined ? {} : { revision }) })
      currentId = revision?.revision_of_diagnostic_report_id
    }
    return chain.reverse().map((entry, index) => {
      const content = this.#reportContent(context, entry.diagnosticReportId)
      const resource = this.#fhir.read(context, 'DiagnosticReport', entry.diagnosticReportId)
      const acknowledgement = reportAcknowledgementRowSchema.optional().parse(this.#database.driver.prepare(`
        SELECT acknowledgement_id, acknowledged_at, acknowledged_by,
          diagnostic_report_id, request_id, request_version
        FROM laboratory_report_acknowledgement
        WHERE workspace_id = ? AND epoch = ? AND diagnostic_report_id = ?
      `).get(context.workspaceId, context.epoch, entry.diagnosticReportId))
      return imagingReportSchema.parse({
        ...(acknowledgement === undefined
          ? {}
          : {
              acknowledgement: {
                acknowledgedAt: acknowledgement.acknowledged_at,
                acknowledgedBy: acknowledgement.acknowledged_by,
                id: acknowledgement.acknowledgement_id,
              },
            }),
        diagnosticReportId: entry.diagnosticReportId,
        diagnosticReportVersion: resource.meta?.versionId ?? '1',
        examinedAt: content.performed_at,
        findings: content.findings,
        impression: content.impression,
        issuedAt: content.issued_at,
        revisionNumber: index + 1,
        ...(entry.revision === undefined
          ? {}
          : {
              revisionOfDiagnosticReportId: entry.revision.revision_of_diagnostic_report_id,
              revisionReason: entry.revision.reason,
            }),
        status: 'final',
        studyId: content.study_id,
        technique: content.technique,
      })
    })
  }

  #reportContent(context: ActorContext, diagnosticReportId: string) {
    const row = reportContentRowSchema.optional().parse(this.#database.driver.prepare(`
      SELECT content.diagnostic_report_id, content.study_id, content.report_revision,
        content.technique, content.findings, content.impression, content.issued_at,
        study.performed_at
      FROM imaging_report_content AS content
      JOIN imaging_study AS study
        ON study.workspace_id = content.workspace_id
       AND study.epoch = content.epoch
       AND study.study_id = content.study_id
      WHERE content.workspace_id = ? AND content.epoch = ? AND content.diagnostic_report_id = ?
    `).get(context.workspaceId, context.epoch, diagnosticReportId))
    if (row === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The imaging report was not found')
    return row
  }
}
