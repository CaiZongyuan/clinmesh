import type { FhirResource } from '@clinmesh/contracts/fhir'
import {
  acknowledgePathologyReportResponseSchema,
  casePathologyServiceCatalogSchema,
  correctPathologyReportResponseSchema,
  issuePathologyRequestResponseSchema,
  pathologyReportSchema,
  pathologyRequestActionResponseSchema,
  pathologyRequestDraftResponseSchema,
  pathologyRequestSchema,
  pathologyRequestStateSchema,
  pathologyServiceSnapshotSchema,
  type ApiConflict,
  type PathologyServiceSnapshot,
} from '@clinmesh/contracts/his'
import {
  pathologySourceProcedureSchema,
  type PathologyExamCode,
  type PathologySourceProcedure,
} from '@clinmesh/contracts/pathology'
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

export const pathologyRequestPolicy: ClinicalRequestPolicy = {
  dedupPrefix: 'pathology-request',
  generationFailedStatusText: 'Pathology result unavailable',
  generationRetryingStatusText: 'Pathology result retrying',
  kind: 'pathology',
  label: 'pathology',
  notCancellableCode: 'PATHOLOGY_REQUEST_NOT_CANCELLABLE',
  outbox: { report: 'pathology.report-request', start: 'pathology.start-request' },
  owner: 'pathology-request',
  resourceType: 'PathologyRequest',
  versionConflictCode: 'PATHOLOGY_REQUEST_VERSION_CONFLICT',
}

/**
 * 版本固定的本院病理服务定义。首期只有既往手术切片的会诊：患者携带既往乳腺手术的 H&E 切片来院复核；
 * 本院取材、冰冻、细胞学、免疫组化和分子检测不属于该服务。
 */
export const pathologyServiceBaseline: PathologyServiceSnapshot[] = [
  {
    applicability: '既往乳腺手术切除标本切片的会诊复核；不含本院取材、冰冻切片、细胞学、免疫组化与分子检测',
    bodySite: '乳腺',
    code: 'PATH-BREAST-SLIDE-CONSULT',
    department: '病理科',
    examCode: 'breast-slide-consultation',
    id: 'pathology-breast-slide-consultation',
    name: '乳腺切片病理会诊',
    reportSections: ['specimen', 'microscopy', 'diagnosis', 'immunohistochemistry', 'note'],
    specimenType: '既往手术切除标本的石蜡切片',
    stain: 'HE',
    version: 1,
  },
]

const pathologyServiceCodeSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/pathology-service'
const freeTextIndicationCode = 'free-text'
/** 一次会诊含一张切片，本院按送检顺序给出显示标签。 */
const slideLabel = '1'

const draftRowSchema = z.object({
  draft_purpose: z.string().nullable(),
  draft_service_id: z.string().nullable(),
  draft_service_snapshot_json: z.string().nullable(),
  draft_source_procedure_json: z.string().nullable(),
  version: z.number().int().positive(),
}).strict()

const requestRowSchema = z.object({
  authored_by: z.string().min(1),
  case_id: z.string().min(1),
  diagnostic_report_id: z.string().nullable(),
  encounter_id: z.string().min(1),
  exam_code: z.enum(['breast-slide-consultation']),
  execution_task_id: z.string().min(1),
  generation_error_code: z.string().nullable(),
  generation_error_message: z.string().nullable(),
  patient_id: z.string().min(1),
  purpose: z.string().min(1),
  request_id: z.string().min(1),
  service_request_id: z.string().min(1),
  service_snapshot_json: z.string().min(1),
  source_procedure_json: z.string().min(1),
  status: z.enum(['acknowledged', 'accepted', 'cancelled', 'generation-failed', 'in-progress', 'issued', 'reported']),
  version: z.number().int().positive(),
}).strict()

const reportContentRowSchema = z.object({
  diagnosis: z.string().min(1),
  diagnostic_report_id: z.string().min(1),
  immunohistochemistry: z.string().min(1),
  issued_at: z.string().min(1),
  microscopy: z.string().min(1),
  note: z.string().min(1),
  received_at: z.string().min(1),
  report_revision: z.number().int().positive(),
  slide_count: z.number().int().positive(),
  specimen_id: z.string().min(1),
  study_id: z.string().min(1),
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

/** 已核对切片素材为一次会诊提供的报告内容；由执行器在命令之外解析并确认素材可用后传入。 */
export interface PathologyResult {
  assetId: string
  assetOutput: unknown
  diagnosis: string
  immunohistochemistry: string
  microscopy: string
  note: string
  reportContentSha256: string
  reportRevision: number
  slideCount: number
}

/** 病理适配器使用的门诊工作流能力：病例定位、责任校验与当前 Virtual Time。 */
export interface PathologyRequestHost {
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
 * 病理会诊申请适配器：草稿、开立、执行、报告、已阅和更正。申请生命周期（受理即收片登记、开始即阅片中、
 * 失败、重试、取消、确认已阅与修订关联）由共享申请内核承担，这里只拥有会诊的内容规则、所选来源手术与本院检查记录。
 */
export class PathologyRequestService {
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  readonly #fhir: FhirRepository
  readonly #host: PathologyRequestHost
  readonly #requests: ClinicalRequestKernel

  constructor(input: {
    commands: CommandExecutor
    database: ClinMeshDatabase
    fhir: FhirRepository
    host: PathologyRequestHost
    requests: ClinicalRequestKernel
  }) {
    this.#commands = input.commands
    this.#database = input.database
    this.#fhir = input.fhir
    this.#host = input.host
    this.#requests = input.requests
  }

  /** 把基线病理服务写入每个活动 Epoch 的本院服务目录；已存在的服务不改动。 */
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
      for (const service of pathologyServiceBaseline) {
        insert.run(
          current.workspaceId,
          current.epoch,
          service.id,
          service.code,
          service.name,
          service.name,
          service.version,
          JSON.stringify({ pathologyService: service }),
        )
      }
    }
  }

  /**
   * 医生可开立的病理会诊服务；是否开展由医院启用状态与素材就绪共同决定，不参考病例病情。
   * `sourceProcedures` 是调用方从病例可见来源病史中取得的可送检手术。
   */
  serviceCatalog(
    context: ActorContext,
    readyExamCodes: ReadonlySet<PathologyExamCode>,
    sourceProcedures: ReadonlyMap<PathologyExamCode, PathologySourceProcedure[]>,
  ) {
    assertRole(context, ['outpatient-doctor'])
    const services = z.array(z.object({ config_json: z.string() })).parse(this.#database.driver.prepare(`
      SELECT config_json FROM hospital_service_catalog
      WHERE workspace_id = ? AND epoch = ? AND active = 1
        AND json_type(config_json, '$.pathologyService') = 'object'
      ORDER BY service_id
    `).all(context.workspaceId, context.epoch))
      .map(row => pathologyServiceSnapshotSchema.parse(JSON.parse(row.config_json).pathologyService))
    return casePathologyServiceCatalogSchema.parse({
      items: services.map(service => ({
        available: readyExamCodes.has(service.examCode),
        service,
        sourceProcedures: sourceProcedures.get(service.examCode) ?? [],
      })),
    })
  }

  /**
   * 阅片读取的授权：当前 Workspace/Epoch 内已发布且未取消的病理检查，执行者是门诊医生并且是该病例的责任医生。
   * 岗位不符时抛出权限错误；不是病理检查时返回 undefined，交给其他影像来源判断；责任不符时抛出权限错误。
   */
  studyAccess(context: ActorContext, studyId: string) {
    // 先校验岗位：其他岗位对存在与不存在的检查得到相同的拒绝。
    assertRole(context, ['outpatient-doctor'])
    const study = z.object({
      asset_id: z.string().min(1),
      asset_output_json: z.string().min(1),
      case_id: z.string().min(1),
      exam_code: z.enum(['breast-slide-consultation']),
    }).strict().optional().parse(this.#database.driver.prepare(`
      SELECT study.asset_id, study.asset_output_json, study.case_id, study.exam_code
      FROM pathology_study AS study
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
      slideLabel,
    }
  }

  state(context: ActorContext, caseId: string) {
    const draft = this.#draft(context, caseId)
    return pathologyRequestStateSchema.parse({
      ...(draft?.draft_service_snapshot_json === null || draft?.draft_service_snapshot_json === undefined
        || draft.draft_source_procedure_json === null
        ? {}
        : {
            draft: {
              purpose: draft.draft_purpose,
              service: JSON.parse(draft.draft_service_snapshot_json),
              sourceProcedure: JSON.parse(draft.draft_source_procedure_json),
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
    purpose: string
    serviceId: string
    sourceProcedureReference: string
    /** 该病例可见来源病史中各项会诊当前可送检的手术；只在命令真正执行时使用。 */
    sourceProcedures: ReadonlyMap<PathologyExamCode, PathologySourceProcedure[]>
  }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: pathologyRequestDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
        purpose: input.purpose,
        serviceId: input.serviceId,
        sourceProcedureReference: input.sourceProcedureReference,
      },
      operation: 'pathology-request.save-draft',
    }, () => {
      const outpatientCase = this.#caseForAction(input.context, input.encounterId)
      this.#host.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const service = this.#activeService(input.context, input.serviceId)
      const sourceProcedure = this.#selectableProcedure(input.sourceProcedures, service, input.sourceProcedureReference)
      const current = this.#draft(input.context, outpatientCase.case_id)
      if ((current?.version ?? 0) !== input.expectedDraftVersion) throw this.#draftConflict()
      const draftVersion = input.expectedDraftVersion + 1
      const now = this.#host.virtualTime(input.context)
      if (current === undefined) {
        this.#database.driver.prepare(`
          INSERT INTO pathology_request_state (
            workspace_id, epoch, case_id, version, draft_service_id, draft_purpose,
            draft_service_snapshot_json, draft_source_procedure_json, updated_by, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.context.workspaceId,
          input.context.epoch,
          outpatientCase.case_id,
          draftVersion,
          service.id,
          input.purpose,
          JSON.stringify(service),
          JSON.stringify(sourceProcedure),
          input.context.actorId,
          now,
        )
      } else {
        this.#updateDraft(input.context, outpatientCase.case_id, current.version, {
          content: { purpose: input.purpose, service, sourceProcedure },
          now,
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
      dataSchema: pathologyRequestDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId, expectedDraftVersion: input.expectedDraftVersion },
      operation: 'pathology-request.delete-draft',
    }, () => {
      const outpatientCase = this.#caseForAction(input.context, input.encounterId)
      this.#host.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const current = this.#draft(input.context, outpatientCase.case_id)
      if (current?.version !== input.expectedDraftVersion || current.draft_service_id === null) {
        throw this.#draftConflict({
          currentStatus: current === undefined ? 'missing' : current.draft_service_id === null ? 'empty' : 'draft',
          ...(current === undefined ? {} : { currentVersion: String(current.version) }),
          expectedVersion: String(input.expectedDraftVersion),
          owner: 'pathology-request-draft',
          resource: `PathologyRequestDraft/${outpatientCase.case_id}`,
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
          reference: `PathologyRequestDraft/${outpatientCase.case_id}`,
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
    /** 当前至少有一份已发布且已安装切片的会诊；本院未开展的服务不能开立。 */
    readyExamCodes: ReadonlySet<PathologyExamCode>
    /** 该病例可见来源病史中各项会诊当前可送检的手术；只在命令真正执行时使用。 */
    sourceProcedures: ReadonlyMap<PathologyExamCode, PathologySourceProcedure[]>
  }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: issuePathologyRequestResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId, expectedDraftVersion: input.expectedDraftVersion },
      operation: 'pathology-request.issue',
    }, (transaction) => {
      const outpatientCase = this.#caseForAction(input.context, input.encounterId)
      this.#host.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const draft = this.#draft(input.context, outpatientCase.case_id)
      if (draft?.version !== input.expectedDraftVersion
        || draft.draft_service_id === null
        || draft.draft_purpose === null
        || draft.draft_service_snapshot_json === null
        || draft.draft_source_procedure_json === null) {
        throw this.#draftConflict()
      }
      // 开立使用草稿保存时冻结的服务定义；服务此后变更时要求重新保存草稿。
      const service = pathologyServiceSnapshotSchema.parse(JSON.parse(draft.draft_service_snapshot_json))
      if (JSON.stringify(this.#activeService(input.context, service.id)) !== JSON.stringify(service)) {
        throw new WorkflowError('CATALOG_CONFLICT', 'The pathology service changed after the draft was saved')
      }
      if (!input.readyExamCodes.has(service.examCode)) {
        throw new WorkflowError('CATALOG_CONFLICT', 'The pathology service is not currently offered')
      }
      // 开立时所选手术必须仍在病例的可见清单内并与服务相容；保存的是来源引用快照，不引用本院资源。
      const sourceProcedure = this.#selectableProcedure(
        input.sourceProcedures,
        service,
        pathologySourceProcedureSchema.parse(JSON.parse(draft.draft_source_procedure_json)).sourceReference,
      )
      // 申请内核对同一病例的同一服务只允许一条进行中的申请；另一次既往手术的会诊在前一条出报告或取消后开立。
      const duplicate = this.#database.driver.prepare(`
        SELECT request_id FROM laboratory_request
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND catalog_item_id = ?
          AND status IN ('issued', 'accepted', 'in-progress', 'generation-failed')
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id, service.id)
      if (duplicate !== undefined) {
        throw new WorkflowError(
          'PATHOLOGY_REQUEST_DUPLICATE',
          'An active pathology consultation already exists for this service',
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
          coding: [{ code: 'SP', display: 'Surgical Pathology', system: 'http://terminology.hl7.org/CodeSystem/v2-0074' }],
        }],
        code: {
          concept: {
            coding: [{ code: service.code, display: service.name, system: pathologyServiceCodeSystem }],
            text: service.name,
          },
        },
        subject: { reference: `Patient/${outpatientCase.patient_id}` },
        encounter: { reference: `Encounter/${input.encounterId}` },
        authoredOn: now,
        requester: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
        reason: [{ concept: { text: draft.draft_purpose } }],
        // 送检标本来自既往来源手术；来源病史不是本院资源，这里只留文字说明。
        note: [{
          text: `送检既往手术：${sourceProcedure.display ?? sourceProcedure.code}（${sourceProcedure.performedAt.slice(0, 10)}）`,
        }],
      })
      const task = transaction.fhir.create(input.context, {
        resourceType: 'Task',
        id: uuidv7(),
        status: 'requested',
        intent: 'order',
        code: {
          coding: [{
            code: 'pathology-request-execution',
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
        ) VALUES (?, ?, ?, ?, 'pathology', ?, ?, ?, ?, ?, 'issued', 1, ?, ?)
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
        INSERT INTO pathology_request_detail (
          workspace_id, epoch, request_id, exam_code, purpose, source_procedure_reference, source_procedure_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        requestId,
        service.examCode,
        draft.draft_purpose,
        sourceProcedure.sourceReference,
        JSON.stringify(sourceProcedure),
      )
      this.#updateDraft(input.context, outpatientCase.case_id, draft.version, { now })
      transaction.enqueue({
        dedupKey: `pathology-request:${requestId}:accept`,
        kind: 'pathology.accept-request',
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
            throw new WorkflowError('WORKFLOW_CONFLICT', 'The pathology request was not found')
          }
          this.#host.assertCaseResponsibility(input.context, request.case_id)
        },
        context: input.context,
        dataSchema: pathologyRequestActionResponseSchema.shape.data,
        expectedVersions: input.expectedVersions,
        idempotencyKey: input.idempotencyKey,
        input: {
          expectedRequestVersion: input.expectedRequestVersion,
          reasonCode: input.reasonCode,
          requestId: input.requestId,
        },
        operation: 'pathology-request.cancel',
      }, (transaction) => {
        const request = this.#requiredRequest(input.context, input.requestId)
        this.#host.assertExpectedVersions(input.expectedVersions, [
          `ServiceRequest/${request.service_request_id}`,
          `Task/${request.execution_task_id}`,
        ])
        const cancelled = this.#requests.cancel(pathologyRequestPolicy, transaction, input.context, request, {
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
        pathologyRequestPolicy,
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
      operation: 'pathology-request.accept',
    }, (transaction) => {
      assertRole(input.context, ['pathology-system'])
      const request = this.#requiredRequest(input.context, input.requestId)
      const accepted = this.#requests.accept(
        pathologyRequestPolicy,
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
      operation: 'pathology-request.start',
    }, (transaction) => {
      assertRole(input.context, ['pathology-system'])
      const request = this.#requiredRequest(input.context, input.requestId)
      const task = this.#requests.start(pathologyRequestPolicy, transaction, input.context, request, {
        enqueueReport: true,
        now: this.#host.virtualTime(input.context),
      })
      return { data: { requestId: request.request_id, status: 'in-progress' as const }, effects: [resourceEffect(task)] }
    })
  }

  /** 在同一事务发布标本、本院检查记录、报告、Provenance 与申请完成效果。 */
  report(input: { context: ActorContext; eventId: string; requestId: string; result: PathologyResult }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: reportSystemResponseSchema,
      expectedVersions: {},
      idempotencyKey: input.eventId,
      input: {
        reportContentSha256: input.result.reportContentSha256,
        requestId: input.requestId,
      },
      operation: 'pathology-request.report',
    }, (transaction) => {
      assertRole(input.context, ['pathology-system'])
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
        throw new WorkflowError('WORKFLOW_CONFLICT', 'Only an in-progress pathology request can be reported')
      }
      const serviceRequest = transaction.fhir.read(input.context, 'ServiceRequest', request.service_request_id)
      const task = transaction.fhir.read(input.context, 'Task', request.execution_task_id)
      if (serviceRequest.status !== 'active' || task.status !== 'in-progress') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The formal pathology request is not in progress')
      }
      const now = this.#host.virtualTime(input.context)
      const service = pathologyServiceSnapshotSchema.parse(JSON.parse(request.service_snapshot_json))
      const sourceProcedure = pathologySourceProcedureSchema.parse(JSON.parse(request.source_procedure_json))
      // 标本是患者带来的既往手术切片：采集时间取所选来源手术的时间，接收时间是本院收片时间。
      // 来源手术没有本院 Procedure，不写 collection.procedure；R5 的容器须引用 Device，玻片数量写在说明中。
      const specimen = transaction.fhir.create(input.context, {
        resourceType: 'Specimen',
        id: uuidv7(),
        status: 'available',
        type: {
          coding: [{ code: 'TISS', display: 'Tissue', system: 'http://terminology.hl7.org/CodeSystem/v2-0487' }],
          text: `${service.bodySite}组织`,
        },
        subject: { reference: `Patient/${request.patient_id}` },
        request: [{ reference: `ServiceRequest/${request.service_request_id}` }],
        collection: { collectedDateTime: sourceProcedure.performedAt, bodySite: { concept: { text: service.bodySite } } },
        receivedTime: now,
        processing: [{ description: 'HE 染色', method: { text: '苏木精-伊红（HE）染色' } }],
        note: [{
          text: `既往手术切片会诊：${sourceProcedure.display ?? sourceProcedure.code}（${sourceProcedure.performedAt.slice(0, 10)}），玻片 ${input.result.slideCount} 张`,
        }],
      })
      // 本院检查使用新生成的标识，不复用来源 UID；标本、检查记录与报告在同一事务中创建。
      const studyId = uuidv7()
      const newDicomUid = () => `2.25.${BigInt(`0x${uuidv7().replaceAll('-', '')}`).toString()}`
      const studyInstanceUid = newDicomUid()
      // ImagingStudy 是本院检查记录的只读投影：每张切片一个序列，只携带本院标识，不含素材或来源信息。
      const projections: FhirResource[] = [transaction.fhir.createProjection(input.context, {
        resourceType: 'ImagingStudy',
        id: studyId,
        status: 'available',
        identifier: [{ system: 'urn:dicom:uid', value: `urn:oid:${studyInstanceUid}` }],
        modality: [{ coding: [{ code: 'SM', system: 'http://dicom.nema.org/resources/ontology/DCM' }] }],
        subject: { reference: `Patient/${request.patient_id}` },
        encounter: { reference: `Encounter/${request.encounter_id}` },
        started: now,
        basedOn: [{ reference: `ServiceRequest/${request.service_request_id}` }],
        numberOfSeries: input.result.slideCount,
        description: service.name,
        series: [{
          uid: newDicomUid(),
          number: 1,
          modality: { coding: [{ code: 'SM', system: 'http://dicom.nema.org/resources/ontology/DCM' }] },
          description: `HE 切片 ${slideLabel}`,
          specimen: [{ reference: `Specimen/${specimen.id}` }],
        }],
      })]
      this.#database.driver.prepare(`
        INSERT INTO pathology_study (
          workspace_id, epoch, study_id, request_id, case_id, exam_code,
          study_instance_uid, specimen_id, asset_id, asset_output_json, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        studyId,
        request.request_id,
        request.case_id,
        request.exam_code,
        studyInstanceUid,
        specimen.id,
        input.result.assetId,
        JSON.stringify(input.result.assetOutput),
        now,
      )
      const report = this.#createReport(transaction, input.context, request, {
        now,
        result: input.result,
        serviceName: service.name,
        serviceCode: service.code,
        specimenId: specimen.id,
        studyId,
      })
      const completed = this.#requests.completeReport(pathologyRequestPolicy, transaction, input.context, request, {
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
          { reference: `Specimen/${specimen.id}` },
          { reference: `ServiceRequest/${request.service_request_id}` },
          { reference: `Task/${request.execution_task_id}` },
        ],
        recorded: now,
        activity: { text: 'Pathology consultation report issuance from a reviewed slide asset' },
        agent: provenanceAgents(input.context, 'Pathology report issuer'),
      })
      return {
        data: { diagnosticReportId: report.id, requestId: request.request_id, status: 'reported' as const, studyId },
        effects: [specimen, ...projections, report, provenance, completed.serviceRequest, completed.task].map(resourceEffect),
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
      operation: 'pathology-request.fail',
    }, (transaction) => {
      assertRole(input.context, ['pathology-system'])
      const request = this.#requiredRequest(input.context, input.requestId)
      const failedTask = this.#requests.failGeneration(pathologyRequestPolicy, transaction, input.context, request, {
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
      dataSchema: pathologyRequestActionResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { expectedRequestVersion: input.expectedRequestVersion, requestId: input.requestId },
      operation: 'pathology-request.retry',
    }, (transaction) => {
      assertRole(input.context, ['outpatient-doctor'])
      const request = this.#requiredRequest(input.context, input.requestId)
      this.#requests.assertRetryable(pathologyRequestPolicy, input.context, request, input.expectedRequestVersion)
      this.#host.assertExpectedVersions(input.expectedVersions, [`Task/${request.execution_task_id}`])
      const task = this.#requests.retryGeneration(
        pathologyRequestPolicy,
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
    /** 本次会诊的切片当前是否可读；只约束新的确认，已有确认按原回执返回。 */
    studyAvailable: boolean
  }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: acknowledgePathologyReportResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        diagnosticReportId: input.diagnosticReportId,
        expectedRequestVersion: input.expectedRequestVersion,
        requestId: input.requestId,
      },
      operation: 'pathology-report.acknowledge',
    }, (transaction) => {
      assertRole(input.context, ['outpatient-doctor'])
      this.#host.assertExpectedVersions(input.expectedVersions, [`DiagnosticReport/${input.diagnosticReportId}`])
      const request = this.#requiredRequest(input.context, input.requestId)
      const acknowledgement = this.#requests.acknowledge(pathologyRequestPolicy, transaction, input.context, request, {
        assertReportContent: () => {
          this.#reportContent(input.context, input.diagnosticReportId)
          // 切片丢失或损坏时保留报告，但不开放新的确认。
          if (!input.studyAvailable) {
            throw new WorkflowError(
              'IMAGING_STUDY_UNAVAILABLE',
              'The slide is not available for viewing; the report cannot be acknowledged',
            )
          }
        },
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
    reportRevision: number
    requestId: string
    /**
     * 从当前素材清单解析出的报告内容，或解析失败的原因。清单可变，因此只在命令真正执行时使用：
     * 相同幂等键的重试先返回已提交的回执，不受清单此后变化影响。
     */
    resolution: { result: PathologyResult } | { error: unknown }
  }) {
    return this.#commands.execute({
      authorize: () => assertRole(input.context, ['pathology-system']),
      context: input.context,
      dataSchema: correctPathologyReportResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        diagnosticReportId: input.diagnosticReportId,
        expectedRequestVersion: input.expectedRequestVersion,
        reason: input.reason,
        reportRevision: input.reportRevision,
        requestId: input.requestId,
      },
      operation: 'pathology-report.correct',
    }, (transaction) => {
      if ('error' in input.resolution) throw input.resolution.error
      const { result } = input.resolution
      this.#host.assertExpectedVersions(input.expectedVersions, [`DiagnosticReport/${input.diagnosticReportId}`])
      const request = this.#requiredRequest(input.context, input.requestId)
      const conflict = (currentStatus: NonNullable<ApiConflict['currentStatus']>): ApiConflict => ({
        currentStatus,
        currentVersion: String(request.version),
        expectedVersion: String(input.expectedRequestVersion),
        owner: 'pathology-report',
        resource: `DiagnosticReport/${input.diagnosticReportId}`,
      })
      if (request.version !== input.expectedRequestVersion) {
        throw new WorkflowError(
          'PATHOLOGY_REQUEST_VERSION_CONFLICT',
          `The pathology request is "${request.status}" at version ${request.version}; expected version ${input.expectedRequestVersion}`,
          conflict(request.status),
        )
      }
      if (request.diagnostic_report_id !== input.diagnosticReportId) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The pathology report is superseded; only the latest signed report can be corrected',
          conflict('superseded'),
        )
      }
      if (request.status !== 'reported' && request.status !== 'acknowledged') {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          `The pathology report cannot be corrected while the request status is "${request.status}"`,
          conflict(request.status),
        )
      }
      const current = this.#reportContent(input.context, input.diagnosticReportId)
      const study = z.object({ asset_id: z.string() }).parse(this.#database.driver.prepare(`
        SELECT asset_id FROM pathology_study WHERE workspace_id = ? AND epoch = ? AND study_id = ?
      `).get(input.context.workspaceId, input.context.epoch, current.study_id))
      // 更正不能更换切片，也不能重发同一份内容。
      if (study.asset_id !== result.assetId || current.report_revision === result.reportRevision) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The correction must use another reviewed report revision of the same slide asset',
        )
      }
      const now = this.#host.virtualTime(input.context)
      const service = pathologyServiceSnapshotSchema.parse(JSON.parse(request.service_snapshot_json))
      const report = this.#createReport(transaction, input.context, request, {
        now,
        result,
        serviceCode: service.code,
        serviceName: service.name,
        specimenId: current.specimen_id,
        studyId: current.study_id,
      })
      const provenance = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Provenance',
        id: uuidv7(),
        target: [{ reference: `DiagnosticReport/${report.id}` }],
        recorded: now,
        activity: { text: 'Pathology report correction' },
        reason: [{ concept: { text: input.reason } }],
        agent: provenanceAgents(input.context, 'Pathology report corrector'),
        entity: [{ role: 'revision', what: { reference: `DiagnosticReport/${input.diagnosticReportId}` } }],
      })
      this.#requests.recordReportRevision(pathologyRequestPolicy, input.context, request, {
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
    input: {
      now: string
      result: PathologyResult
      serviceCode: string
      serviceName: string
      specimenId: string
      studyId: string
    },
  ): FhirResource {
    const report = transaction.fhir.create(context, {
      resourceType: 'DiagnosticReport',
      id: uuidv7(),
      status: 'final',
      category: [{
        coding: [{ code: 'SP', display: 'Surgical Pathology', system: 'http://terminology.hl7.org/CodeSystem/v2-0074' }],
      }],
      code: {
        coding: [{ code: input.serviceCode, display: input.serviceName, system: pathologyServiceCodeSystem }],
        text: `${input.serviceName}报告`,
      },
      subject: { reference: `Patient/${request.patient_id}` },
      encounter: { reference: `Encounter/${request.encounter_id}` },
      basedOn: [{ reference: `ServiceRequest/${request.service_request_id}` }],
      effectiveDateTime: input.now,
      issued: input.now,
      specimen: [{ reference: `Specimen/${input.specimenId}` }],
      study: [{ reference: `ImagingStudy/${input.studyId}` }],
      conclusion: input.result.diagnosis,
    })
    this.#database.driver.prepare(`
      INSERT INTO pathology_report_content (
        workspace_id, epoch, diagnostic_report_id, request_id, study_id, report_revision,
        report_content_sha256, microscopy, diagnosis, immunohistochemistry, note, slide_count, issued_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      report.id,
      request.request_id,
      input.studyId,
      input.result.reportRevision,
      input.result.reportContentSha256,
      input.result.microscopy,
      input.result.diagnosis,
      input.result.immunohistochemistry,
      input.result.note,
      input.result.slideCount,
      input.now,
    )
    return report
  }

  /** 所选来源手术必须在病例当前可送检的清单内；返回清单中的条目作为快照。 */
  #selectableProcedure(
    sourceProcedures: ReadonlyMap<PathologyExamCode, PathologySourceProcedure[]>,
    service: PathologyServiceSnapshot,
    sourceReference: string,
  ): PathologySourceProcedure {
    const found = sourceProcedures.get(service.examCode)?.find(item => item.sourceReference === sourceReference)
    if (found === undefined) {
      throw new WorkflowError(
        'PATHOLOGY_SOURCE_PROCEDURE_UNAVAILABLE',
        'The selected source procedure is not in the visible history or does not fit this consultation',
      )
    }
    return found
  }

  #caseForAction(context: ActorContext, encounterId: string) {
    assertRole(context, ['outpatient-doctor'])
    const outpatientCase = this.#host.caseByEncounter(context, encounterId)
    this.#host.assertCaseResponsibility(context, outpatientCase.case_id)
    if (outpatientCase.status !== 'first-visit' || !this.#host.hasConsultation(context, outpatientCase.case_id)) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter cannot edit or issue a pathology request')
    }
    return outpatientCase
  }

  #activeService(context: ActorContext, serviceId: string): PathologyServiceSnapshot {
    const row = z.object({ config_json: z.string() }).optional().parse(this.#database.driver.prepare(`
      SELECT config_json FROM hospital_service_catalog
      WHERE workspace_id = ? AND epoch = ? AND service_id = ? AND active = 1
        AND json_type(config_json, '$.pathologyService') = 'object'
    `).get(context.workspaceId, context.epoch, serviceId))
    if (row === undefined) throw new WorkflowError('CATALOG_CONFLICT', 'The pathology service is unavailable')
    return pathologyServiceSnapshotSchema.parse(JSON.parse(row.config_json).pathologyService)
  }

  #draft(context: ActorContext, caseId: string) {
    return draftRowSchema.optional().parse(this.#database.driver.prepare(`
      SELECT version, draft_service_id, draft_purpose, draft_service_snapshot_json, draft_source_procedure_json
      FROM pathology_request_state
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).get(context.workspaceId, context.epoch, caseId))
  }

  /** 以版本 CAS 更新草稿；不给内容时清空草稿。 */
  #updateDraft(
    context: ActorContext,
    caseId: string,
    currentVersion: number,
    input: {
      content?: { purpose: string; service: PathologyServiceSnapshot; sourceProcedure: PathologySourceProcedure }
      now: string
    },
  ): void {
    const update = this.#database.driver.prepare(`
      UPDATE pathology_request_state
      SET version = ?, draft_service_id = ?, draft_purpose = ?, draft_service_snapshot_json = ?,
        draft_source_procedure_json = ?, updated_by = ?, updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND version = ?
    `).run(
      currentVersion + 1,
      input.content?.service.id ?? null,
      input.content?.purpose ?? null,
      input.content === undefined ? null : JSON.stringify(input.content.service),
      input.content === undefined ? null : JSON.stringify(input.content.sourceProcedure),
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
      'PATHOLOGY_REQUEST_VERSION_CONFLICT',
      'The pathology request draft version has changed',
      conflict,
    )
  }

  #request(context: ActorContext, requestId: string): RequestRow | undefined {
    return requestRowSchema.optional().parse(this.#database.driver.prepare(`${this.#requestSelect}
      WHERE request.workspace_id = ? AND request.epoch = ? AND request.request_id = ?
        AND request.request_kind = 'pathology'
    `).get(context.workspaceId, context.epoch, requestId))
  }

  #requiredRequest(context: ActorContext, requestId: string): RequestRow {
    const request = this.#request(context, requestId)
    if (request === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The pathology request was not found')
    return request
  }

  readonly #requestSelect = `
    SELECT request.request_id, request.case_id, request.service_snapshot_json,
      request.generation_error_code, request.generation_error_message,
      request.service_request_id, request.execution_task_id, request.diagnostic_report_id,
      request.status, request.version, request.authored_by,
      detail.exam_code, detail.purpose, detail.source_procedure_json,
      outpatient_case.patient_id, outpatient_case.encounter_id
    FROM laboratory_request AS request
    JOIN pathology_request_detail AS detail
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
        AND request.request_kind = 'pathology'
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
      : this.#reportVersions(context, request, request.diagnostic_report_id)
    return pathologyRequestSchema.parse({
      ...(request.generation_error_code === null || request.generation_error_message === null
        ? {}
        : { generationError: { code: request.generation_error_code, message: request.generation_error_message } }),
      id: request.request_id,
      previousReports: reports.slice(0, -1),
      purpose: request.purpose,
      ...(reports.length === 0 ? {} : { report: reports.at(-1) }),
      service: JSON.parse(request.service_snapshot_json),
      serviceRequestId: request.service_request_id,
      serviceRequestVersion: serviceRequest.meta?.versionId ?? '1',
      sourceProcedure: JSON.parse(request.source_procedure_json),
      status: request.status,
      taskId: request.execution_task_id,
      taskVersion: task.meta?.versionId ?? '1',
      version: request.version,
    })
  }

  /** 从当前报告沿修订关系回溯到首份报告，按签发顺序返回。 */
  #reportVersions(context: ActorContext, request: RequestRow, diagnosticReportId: string) {
    const requestId = request.request_id
    const sourceProcedure = pathologySourceProcedureSchema.parse(JSON.parse(request.source_procedure_json))
    const chain: Array<{ diagnosticReportId: string; revision?: z.infer<typeof reportRevisionRowSchema> }> = []
    let currentId: string | undefined = diagnosticReportId
    while (currentId !== undefined) {
      if (chain.some(entry => entry.diagnosticReportId === currentId)) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The pathology report revision chain is cyclic')
      }
      const revision = reportRevisionRowSchema.optional().parse(this.#database.driver.prepare(`
        SELECT reason, request_id, revision_of_diagnostic_report_id
        FROM laboratory_report_revision
        WHERE workspace_id = ? AND epoch = ? AND diagnostic_report_id = ?
      `).get(context.workspaceId, context.epoch, currentId))
      if (revision !== undefined && revision.request_id !== requestId) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The pathology report revision does not belong to its request')
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
      return pathologyReportSchema.parse({
        ...(acknowledgement === undefined
          ? {}
          : {
              acknowledgement: {
                acknowledgedAt: acknowledgement.acknowledged_at,
                acknowledgedBy: acknowledgement.acknowledged_by,
                id: acknowledgement.acknowledgement_id,
              },
            }),
        diagnosis: content.diagnosis,
        diagnosticReportId: entry.diagnosticReportId,
        diagnosticReportVersion: resource.meta?.versionId ?? '1',
        immunohistochemistry: content.immunohistochemistry,
        issuedAt: content.issued_at,
        microscopy: content.microscopy,
        note: content.note,
        receivedAt: content.received_at,
        revisionNumber: index + 1,
        ...(entry.revision === undefined
          ? {}
          : {
              revisionOfDiagnosticReportId: entry.revision.revision_of_diagnostic_report_id,
              revisionReason: entry.revision.reason,
            }),
        specimen: {
          procedure: sourceProcedure,
          slideCount: content.slide_count,
          specimenId: content.specimen_id,
          stain: 'HE',
        },
        status: 'final',
        studyId: content.study_id,
      })
    })
  }

  #reportContent(context: ActorContext, diagnosticReportId: string) {
    const row = reportContentRowSchema.optional().parse(this.#database.driver.prepare(`
      SELECT content.diagnostic_report_id, content.study_id, content.report_revision,
        content.microscopy, content.diagnosis, content.immunohistochemistry, content.note,
        content.slide_count, content.issued_at, study.received_at, study.specimen_id
      FROM pathology_report_content AS content
      JOIN pathology_study AS study
        ON study.workspace_id = content.workspace_id
       AND study.epoch = content.epoch
       AND study.study_id = content.study_id
      WHERE content.workspace_id = ? AND content.epoch = ? AND content.diagnostic_report_id = ?
    `).get(context.workspaceId, context.epoch, diagnosticReportId))
    if (row === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The pathology report was not found')
    return row
  }
}
