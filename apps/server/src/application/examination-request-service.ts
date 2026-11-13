import { assertInpatientRequestScope, inpatientRequestOwner } from './clinical-request-context.ts'
import type { FhirResource } from '@clinmesh/contracts/fhir'
import {
  acknowledgeExaminationReportResponseSchema,
  caseExaminationServiceCatalogSchema,
  examinationReportSchema,
  examinationRequestActionResponseSchema,
  examinationRequestDraftResponseSchema,
  examinationRequestSchema,
  examinationRequestStateSchema,
  examinationServiceSnapshotSchema,
  issueExaminationRequestResponseSchema,
  type ApiConflict,
  type ExaminationServiceSnapshot,
} from '@clinmesh/contracts/his'
type ExaminationExamCode = ExaminationServiceSnapshot['examCode']
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { investigationResultContentSchema } from '@clinmesh/contracts/scenario'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
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
import { OutpatientInvestigationBilling, serviceOutpatientPrice } from './outpatient-investigation-billing.ts'

export const examinationRequestPolicy: ClinicalRequestPolicy = {
  dedupPrefix: 'examination-request',
  generationFailedStatusText: 'Examination result unavailable',
  generationRetryingStatusText: 'Examination result retrying',
  kind: 'examination',
  label: 'examination',
  notCancellableCode: 'EXAMINATION_REQUEST_NOT_CANCELLABLE',
  outbox: { report: 'examination.report-request', start: 'examination.start-request' },
  owner: 'examination-request',
  resourceType: 'ExaminationRequest',
  versionConflictCode: 'EXAMINATION_REQUEST_VERSION_CONFLICT',
}

/**
 * 版本固定的本院功能检查服务定义。服务明确部位、检查方式、执行科室、适用范围与报告结构；
 * 两项常备服务均输出结构化指标，不生成波形或影像像素。
 */
export const examinationServiceBaseline: ExaminationServiceSnapshot[] = [
  {
    id: 'examination-ecg-12-lead',
    code: 'ECG-12',
    name: '常规十二导联心电图',
    examCode: 'ecg-12-lead',
    modality: 'ECG',
    department: '心功能室',
    bodySite: '心脏',
    method: '静息十二导联心电图',
    applicability: '成人心血管疾病评估与随访',
    reportSections: ['technique', 'findings', 'impression'],
    outpatientBilling: serviceOutpatientPrice('examination', 'examination-ecg-12-lead'),
    version: 1,
  },
  {
    id: 'examination-tte',
    code: 'TTE',
    name: '经胸超声心动图',
    examCode: 'tte',
    modality: 'US',
    department: '超声科',
    bodySite: '心脏',
    method: '经胸超声心动图',
    applicability: '成人心脏结构和功能评估',
    reportSections: ['technique', 'findings', 'impression'],
    outpatientBilling: serviceOutpatientPrice('examination', 'examination-tte'),
    version: 1,
  },
]

const examinationServiceCodeSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/examination-service'
const freeTextIndicationCode = 'free-text'

const draftRowSchema = z
  .object({
    draft_indication: z.string().nullable(),
    draft_service_id: z.string().nullable(),
    draft_service_snapshot_json: z.string().nullable(),
    version: z.number().int().positive(),
  })
  .strict()

const requestRowSchema = z
  .object({
    authored_by: z.string().min(1),
    case_id: z.string().min(1),
    diagnostic_report_id: z.string().nullable(),
    encounter_id: z.string().min(1),
    exam_code: z.enum(['ecg-12-lead', 'tte']),
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
  })
  .strict()

const systemResponseSchema = z
  .object({
    requestId: z.string().min(1),
    status: z.enum(['accepted', 'cancelled', 'generation-failed', 'in-progress']),
  })
  .strict()

const reportSystemResponseSchema = z
  .object({
    diagnosticReportId: z.string().min(1),
    requestId: z.string().min(1),
    status: z.literal('reported'),
  })
  .strict()

/** 已核对服务为一次检查提供的报告内容；由执行器在命令之外解析并确认服务可用后传入。 */
export interface ExaminationResult {
  snapshotId: string
  content: import('@clinmesh/contracts/scenario').InvestigationResultContent
}

/** 功能检查适配器使用的门诊工作流能力：病例定位、责任校验与当前 Virtual Time。 */
export interface ExaminationRequestHost {
  assertCaseResponsibility(context: ActorContext, caseId: string): void
  assertExpectedVersions(expectedVersions: Record<string, string>, references: string[]): void
  caseByEncounter(context: ActorContext, encounterId: string): { case_id: string; patient_id: string; status: string }
  hasConsultation(context: ActorContext, caseId: string): boolean
  reportPublished(transaction: CommandTransaction, context: ActorContext, caseId: string, reportReference: string): void
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
    kind: resource.meta?.versionId === '1' ? ('created' as const) : ('updated' as const),
    reference: `${resource.resourceType}/${resource.id}`,
    versionId: resource.meta?.versionId ?? '1',
  }
}

/**
 * 功能检查申请适配器：草稿、开立、执行、报告与已阅。申请生命周期由共享申请内核承担，
 * 这里拥有功能检查的内容规则、确定性报告和本院检查记录。
 */
export class ExaminationRequestService {
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  readonly #fhir: FhirRepository
  readonly #host: ExaminationRequestHost
  readonly #requests: ClinicalRequestKernel

  constructor(input: {
    commands: CommandExecutor
    database: ClinMeshDatabase
    fhir: FhirRepository
    host: ExaminationRequestHost
    requests: ClinicalRequestKernel
  }) {
    this.#commands = input.commands
    this.#database = input.database
    this.#fhir = input.fhir
    this.#host = input.host
    this.#requests = input.requests
  }

  /** 把基线功能检查服务写入每个活动 Epoch 的本院服务目录；已存在的服务不改动。 */
  ensureServices(): void {
    const epochs = z.array(z.object({ epoch: z.string(), workspaceId: z.string() })).parse(
      this.#database.driver
        .prepare(
          `
        SELECT workspace_id AS workspaceId, active_epoch AS epoch FROM workspace
      `,
        )
        .all(),
    )
    const insert = this.#database.driver.prepare(`
      INSERT OR IGNORE INTO hospital_service_catalog (
        workspace_id, epoch, service_id, code, name_zh, name_en, version, active, config_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `)
    for (const current of epochs) {
      for (const service of examinationServiceBaseline) {
        insert.run(
          current.workspaceId,
          current.epoch,
          service.id,
          service.code,
          service.name,
          service.name,
          service.version,
          JSON.stringify({ examinationService: service }),
        )
        this.#database.driver
          .prepare(
            `UPDATE hospital_service_catalog
          SET config_json=json_set(config_json,'$.examinationService.outpatientBilling',json(?))
          WHERE workspace_id=? AND epoch=? AND service_id=? AND json_type(config_json,'$.examinationService.outpatientBilling') IS NULL`,
          )
          .run(JSON.stringify(service.outpatientBilling), current.workspaceId, current.epoch, service.id)
        const priceFen = service.examCode === 'ecg-12-lead' ? 3000 : 18000
        this.#database.driver
          .prepare(
            `UPDATE hospital_service_catalog SET config_json=json_set(config_json,
          '$.inpatientInvestigationBilling',json(?)) WHERE workspace_id=? AND epoch=? AND service_id=?
          AND json_type(config_json,'$.inpatientInvestigationBilling') IS NULL`,
          )
          .run(
            JSON.stringify({
              id: `charge-definition-inpatient-${service.id}`,
              version: 1,
              effectiveOn: '2026-08-24',
              display: service.name,
              priceFen,
              currency: 'CNY',
              trigger: 'execution-completed',
              source: 'synthetic-hospital-price-2026',
              availableScopes: ['inpatient'],
            }),
            current.workspaceId,
            current.epoch,
            service.id,
          )
      }
    }
  }

  /** 医生可开立的功能检查服务；是否开展由医院启用状态与服务就绪共同决定，不参考病例病情。 */
  serviceCatalog(
    context: ActorContext,
    readyExamCodes: ReadonlySet<ExaminationExamCode> = new Set(['ecg-12-lead', 'tte']),
  ) {
    assertRole(context, ['outpatient-doctor', 'inpatient-doctor', 'ward-nurse'])
    const services = z
      .array(z.object({ config_json: z.string() }))
      .parse(
        this.#database.driver
          .prepare(
            `
      SELECT config_json FROM hospital_service_catalog
      WHERE workspace_id = ? AND epoch = ? AND active = 1
        AND json_type(config_json, '$.examinationService') = 'object'
      ORDER BY service_id
    `,
          )
          .all(context.workspaceId, context.epoch),
      )
      .map((row) => examinationServiceSnapshotSchema.parse(JSON.parse(row.config_json).examinationService))
    return caseExaminationServiceCatalogSchema.parse({
      items: services.map((service) => ({ available: readyExamCodes.has(service.examCode), service })),
    })
  }

  /**
   * 读取当前 Workspace/Epoch 的申请状态；门诊由宿主责任校验，住院按当前岗位绑定。
   */
  state(context: ActorContext, caseId: string) {
    if (['inpatient-doctor', 'ward-nurse'].includes(context.roleCode))
      assertInpatientRequestScope(this.#database, context, caseId)
    const draft = this.#draft(context, caseId)
    return examinationRequestStateSchema.parse({
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
    return this.#commands.execute(
      {
        context: input.context,
        dataSchema: examinationRequestDraftResponseSchema.shape.data,
        expectedVersions: input.expectedVersions,
        idempotencyKey: input.idempotencyKey,
        input: {
          encounterId: input.encounterId,
          expectedDraftVersion: input.expectedDraftVersion,
          indication: input.indication,
          serviceId: input.serviceId,
        },
        operation: 'examination-request.save-draft',
        authorize: () => assertRole(input.context, ['outpatient-doctor']),
      },
      (transaction) => this.applySaveDraft(transaction, input),
    )
  }

  applySaveDraft(
    _transaction: CommandTransaction,
    input: {
      context: ActorContext
      encounterId: string
      expectedDraftVersion: number
      expectedVersions: Record<string, string>
      idempotencyKey: string
      indication: string
      serviceId: string
    },
  ) {
    const outpatientCase = this.#caseForAction(input.context, input.encounterId)
    this.#host.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
    const service = this.#activeService(input.context, input.serviceId)
    const current = this.#draft(input.context, outpatientCase.case_id)
    if ((current?.version ?? 0) !== input.expectedDraftVersion) throw this.#draftConflict()
    const draftVersion = input.expectedDraftVersion + 1
    const now = this.#host.virtualTime(input.context)
    if (current === undefined) {
      this.#database.driver
        .prepare(
          `
        INSERT INTO examination_request_state (
          workspace_id, epoch, case_id, version, draft_service_id, draft_indication,
          draft_service_snapshot_json, updated_by, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
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
  }

  deleteDraft(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }) {
    return this.#commands.execute(
      {
        context: input.context,
        dataSchema: examinationRequestDraftResponseSchema.shape.data,
        expectedVersions: input.expectedVersions,
        idempotencyKey: input.idempotencyKey,
        input: { encounterId: input.encounterId, expectedDraftVersion: input.expectedDraftVersion },
        operation: 'examination-request.delete-draft',
      },
      (transaction) => this.applyDeleteDraft(transaction, input),
    )
  }

  applyDeleteDraft(
    _transaction: CommandTransaction,
    input: {
      context: ActorContext
      encounterId: string
      expectedDraftVersion: number
      expectedVersions: Record<string, string>
      idempotencyKey: string
    },
  ) {
    const outpatientCase = this.#caseForAction(input.context, input.encounterId)
    this.#host.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
    const current = this.#draft(input.context, outpatientCase.case_id)
    if (current?.version !== input.expectedDraftVersion || current.draft_service_id === null) {
      throw this.#draftConflict({
        currentStatus: current === undefined ? 'missing' : current.draft_service_id === null ? 'empty' : 'draft',
        ...(current === undefined ? {} : { currentVersion: String(current.version) }),
        expectedVersion: String(input.expectedDraftVersion),
        owner: 'examination-request-draft',
        resource: `ExaminationRequestDraft/${outpatientCase.case_id}`,
      })
    }
    this.#updateDraft(input.context, outpatientCase.case_id, current.version, {
      now: this.#host.virtualTime(input.context),
    })
    const draftVersion = current.version + 1
    return {
      data: { caseId: outpatientCase.case_id, draftVersion },
      effects: [
        {
          kind: 'updated' as const,
          reference: `ExaminationRequestDraft/${outpatientCase.case_id}`,
          versionId: String(draftVersion),
        },
      ],
    }
  }

  issue(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    /** 当前至少有一套已发布且已安装服务的检查；本院未开展的服务不能开立。 */
    readyExamCodes: ReadonlySet<ExaminationExamCode>
  }) {
    return this.#commands.execute(
      {
        context: input.context,
        dataSchema: issueExaminationRequestResponseSchema.shape.data,
        expectedVersions: input.expectedVersions,
        idempotencyKey: input.idempotencyKey,
        input: { encounterId: input.encounterId, expectedDraftVersion: input.expectedDraftVersion },
        operation: 'examination-request.issue',
        authorize: () => assertRole(input.context, ['outpatient-doctor']),
      },
      (transaction) => this.applyIssue(transaction, input),
    )
  }

  applyIssue(
    transaction: CommandTransaction,
    input: {
      context: ActorContext
      encounterId: string
      expectedDraftVersion: number
      expectedVersions: Record<string, string>
      idempotencyKey: string
      /** 当前至少有一套已发布且已安装服务的检查；本院未开展的服务不能开立。 */
      readyExamCodes: ReadonlySet<ExaminationExamCode>
    },
  ) {
    const outpatientCase = this.#caseForAction(input.context, input.encounterId)
    this.#host.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
    const draft = this.#draft(input.context, outpatientCase.case_id)
    if (
      draft?.version !== input.expectedDraftVersion ||
      draft.draft_service_id === null ||
      draft.draft_indication === null ||
      draft.draft_service_snapshot_json === null
    ) {
      throw this.#draftConflict()
    }
    // 开立使用草稿保存时冻结的服务定义；服务此后变更时要求重新保存草稿。
    const service = examinationServiceSnapshotSchema.parse(JSON.parse(draft.draft_service_snapshot_json))
    if (JSON.stringify(this.#activeService(input.context, service.id)) !== JSON.stringify(service)) {
      throw new WorkflowError('CATALOG_CONFLICT', 'The examination service changed after the draft was saved')
    }
    if (!input.readyExamCodes.has(service.examCode)) {
      throw new WorkflowError('CATALOG_CONFLICT', 'The examination service is not currently offered')
    }
    const duplicate = this.#database.driver
      .prepare(
        `
      SELECT request_id FROM laboratory_request
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND catalog_item_id = ?
        AND status IN ('issued', 'accepted', 'in-progress', 'generation-failed')
    `,
      )
      .get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id, service.id)
    if (duplicate !== undefined) {
      throw new WorkflowError(
        'EXAMINATION_REQUEST_DUPLICATE',
        'An active examination request already exists for this service',
      )
    }
    const now = this.#host.virtualTime(input.context)
    const requestId = uuidv7()
    const serviceRequest = transaction.fhir.create(input.context, {
      resourceType: 'ServiceRequest',
      id: uuidv7(),
      status: 'active',
      intent: 'order',
      category: [
        {
          coding: [{ code: '363679005', display: 'Examination', system: 'http://snomed.info/sct' }],
        },
      ],
      code: {
        concept: {
          coding: [{ code: service.code, display: service.name, system: examinationServiceCodeSystem }],
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
        coding: [
          {
            code: 'examination-request-execution',
            system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/task-kind',
          },
        ],
        text: `${service.name}执行`,
      },
      focus: { reference: `ServiceRequest/${serviceRequest.id}` },
      for: { reference: `Patient/${outpatientCase.patient_id}` },
      encounter: { reference: `Encounter/${input.encounterId}` },
      authoredOn: now,
      requester: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
      owner: { reference: 'Organization/organization-clinmesh' },
    })
    this.#database.driver
      .prepare(
        `
      INSERT INTO laboratory_request (
        workspace_id, epoch, request_id, case_id, request_kind, catalog_item_id,
        service_snapshot_json, indication_code, service_request_id, execution_task_id,
        status, version, authored_by, authored_at
      ) VALUES (?, ?, ?, ?, 'examination', ?, ?, ?, ?, ?, 'issued', 1, ?, ?)
    `,
      )
      .run(
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
    this.#database.driver
      .prepare(
        `
      INSERT INTO examination_request_detail (workspace_id, epoch, request_id, exam_code, indication)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(input.context.workspaceId, input.context.epoch, requestId, service.examCode, draft.draft_indication)
    this.#updateDraft(input.context, outpatientCase.case_id, draft.version, { now })
    const billing =
      inpatientRequestOwner(this.#database, input.context, outpatientCase.case_id) === undefined
        ? new OutpatientInvestigationBilling(this.#database).issue(transaction, input.context, {
            requestId,
            serviceRequestId: serviceRequest.id!,
            caseId: outpatientCase.case_id,
            category: 'examination',
            descriptionZh: service.name,
            descriptionEn: service.name,
            price: service.outpatientBilling,
            now,
          })
        : undefined
    return {
      data: {
        caseId: outpatientCase.case_id,
        draftVersion: draft.version + 1,
        request: this.#projectedRequest(input.context, requestId),
      },
      effects: [...[serviceRequest, task].map(resourceEffect), ...(billing?.effects ?? [])],
    }
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
      return this.#commands.execute(
        {
          authorize: () => {
            assertRole(input.context, ['outpatient-doctor'])
            const request = this.#request(input.context, input.requestId)
            if (
              request === undefined ||
              request.authored_by !== (input.context.practitionerId ?? input.context.actorId)
            ) {
              throw new WorkflowError('WORKFLOW_CONFLICT', 'The examination request was not found')
            }
            this.#host.assertCaseResponsibility(input.context, request.case_id)
          },
          context: input.context,
          dataSchema: examinationRequestActionResponseSchema.shape.data,
          expectedVersions: input.expectedVersions,
          idempotencyKey: input.idempotencyKey,
          input: {
            expectedRequestVersion: input.expectedRequestVersion,
            reasonCode: input.reasonCode,
            requestId: input.requestId,
          },
          operation: 'examination-request.cancel',
        },
        (transaction) => {
          const request = this.#requiredRequest(input.context, input.requestId)
          this.#host.assertExpectedVersions(input.expectedVersions, [
            `ServiceRequest/${request.service_request_id}`,
            `Task/${request.execution_task_id}`,
          ])
          const cancelled = this.#requests.cancel(examinationRequestPolicy, transaction, input.context, request, {
            expectedRequestVersion: input.expectedRequestVersion,
            now: this.#host.virtualTime(input.context),
            reasonCode: input.reasonCode,
          })
          return {
            data: { request: this.#projectedRequest(input.context, request.request_id) },
            effects: [...[cancelled.serviceRequest, cancelled.task].map(resourceEffect), ...cancelled.chargeEffects],
          }
        },
      )
    } catch (error) {
      if (!(error instanceof ExpectedVersionConflictError)) throw error
      throw this.#requests.relatedVersionConflict(
        examinationRequestPolicy,
        this.#requiredRequest(input.context, input.requestId),
        input.expectedRequestVersion,
      )
    }
  }

  accept(input: { context: ActorContext; eventId: string; requestId: string }) {
    return this.#commands.execute(
      {
        context: input.context,
        dataSchema: systemResponseSchema,
        expectedVersions: {},
        idempotencyKey: input.eventId,
        input: { requestId: input.requestId },
        operation: 'examination-request.accept',
      },
      (transaction) => {
        assertRole(input.context, ['ris-system'])
        const request = this.#requiredRequest(input.context, input.requestId)
        const accepted = this.#requests.accept(
          examinationRequestPolicy,
          transaction,
          input.context,
          request,
          this.#host.virtualTime(input.context),
        )
        return accepted.status === 'cancelled'
          ? { data: { requestId: request.request_id, status: 'cancelled' as const }, effects: [] }
          : {
              data: { requestId: request.request_id, status: 'accepted' as const },
              effects: [resourceEffect(accepted.task)],
            }
      },
    )
  }

  start(input: { context: ActorContext; eventId: string; requestId: string }) {
    return this.#commands.execute(
      {
        context: input.context,
        dataSchema: systemResponseSchema,
        expectedVersions: {},
        idempotencyKey: input.eventId,
        input: { requestId: input.requestId },
        operation: 'examination-request.start',
      },
      (transaction) => {
        assertRole(input.context, ['ris-system'])
        const request = this.#requiredRequest(input.context, input.requestId)
        const task = this.#requests.start(examinationRequestPolicy, transaction, input.context, request, {
          enqueueReport: true,
          now: this.#host.virtualTime(input.context),
        })
        return {
          data: { requestId: request.request_id, status: 'in-progress' as const },
          effects: [resourceEffect(task)],
        }
      },
    )
  }

  /** 在同一事务发布本院检查记录、报告、Provenance 与申请完成效果。 */
  report(input: { context: ActorContext; eventId: string; requestId: string; result: ExaminationResult }) {
    return this.#commands.execute(
      {
        context: input.context,
        dataSchema: reportSystemResponseSchema,
        expectedVersions: {},
        idempotencyKey: input.eventId,
        input: { requestId: input.requestId, snapshotId: input.result.snapshotId },
        operation: 'examination-request.report',
      },
      (transaction) => {
        assertRole(input.context, ['ris-system'])
        const request = this.#requiredRequest(input.context, input.requestId)
        if (request.status === 'reported' && request.diagnostic_report_id !== null)
          return {
            data: {
              requestId: request.request_id,
              diagnosticReportId: request.diagnostic_report_id,
              status: 'reported' as const,
            },
            effects: [],
          }
        if (request.status !== 'in-progress')
          throw new WorkflowError('WORKFLOW_CONFLICT', 'Only an in-progress functional examination can be reported')
        const serviceRequest = transaction.fhir.read(input.context, 'ServiceRequest', request.service_request_id)
        const task = transaction.fhir.read(input.context, 'Task', request.execution_task_id)
        const now = this.#host.virtualTime(input.context)
        const service = examinationServiceSnapshotSchema.parse(JSON.parse(request.service_snapshot_json))
        const observations = input.result.content.results.map((result) =>
          transaction.fhir.create(input.context, {
            resourceType: 'Observation',
            id: uuidv7(),
            status: 'final',
            code: {
              coding: [{ system: examinationServiceCodeSystem, code: result.code, display: result.display }],
              text: result.display,
            },
            subject: { reference: 'Patient/' + request.patient_id },
            encounter: { reference: 'Encounter/' + request.encounter_id },
            effectiveDateTime: now,
            basedOn: [{ reference: 'ServiceRequest/' + request.service_request_id }],
            ...(typeof result.value === 'number'
              ? {
                  valueQuantity: {
                    value: result.value,
                    ...(result.unit === undefined
                      ? {}
                      : { unit: result.unit.display, system: result.unit.system, code: result.unit.code }),
                  },
                }
              : typeof result.value === 'boolean'
                ? { valueBoolean: result.value }
                : typeof result.value === 'string'
                  ? { valueString: result.value }
                  : { valueCodeableConcept: { coding: [result.value] } }),
            interpretation: [
              {
                coding: [
                  {
                    system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
                    code: { normal: 'N', high: 'H', low: 'L', abnormal: 'A' }[result.interpretation],
                  },
                ],
              },
            ],
            referenceRange: [{ text: result.referenceRange.text }],
          }),
        )
        const report = transaction.fhir.create(input.context, {
          resourceType: 'DiagnosticReport',
          id: uuidv7(),
          status: 'final',
          code: {
            coding: [{ system: examinationServiceCodeSystem, code: service.code, display: service.name }],
            text: service.name + '报告',
          },
          subject: { reference: 'Patient/' + request.patient_id },
          encounter: { reference: 'Encounter/' + request.encounter_id },
          basedOn: [{ reference: 'ServiceRequest/' + request.service_request_id }],
          effectiveDateTime: now,
          issued: now,
          result: observations.map((item) => ({ reference: 'Observation/' + item.id })),
          conclusion: input.result.content.conclusion,
        })
        this.#database.driver
          .prepare(
            'INSERT INTO examination_report_content(workspace_id,epoch,diagnostic_report_id,request_id,case_id,content_json,issued_at) VALUES(?,?,?,?,?,?,?)',
          )
          .run(
            input.context.workspaceId,
            input.context.epoch,
            report.id,
            request.request_id,
            request.case_id,
            JSON.stringify(input.result.content),
            now,
          )
        const completed = this.#requests.completeReport(examinationRequestPolicy, transaction, input.context, request, {
          diagnosticReportId: report.id,
          now,
          resultSnapshotId: input.result.snapshotId,
          serviceRequest,
          task,
        })
        this.#host.reportPublished(
          transaction,
          input.context,
          request.case_id,
          'DiagnosticReport/' + report.id + '/_history/' + report.meta!.versionId,
        )
        const provenance = transaction.fhir.createImmutable(input.context, {
          resourceType: 'Provenance',
          id: uuidv7(),
          target: [report, ...observations, completed.serviceRequest, completed.task].map((item) => ({
            reference: item.resourceType + '/' + item.id,
          })),
          recorded: now,
          activity: { text: 'Functional examination report issuance' },
          agent: provenanceAgents(input.context, 'Functional examination report issuer'),
        })
        return {
          data: { requestId: request.request_id, diagnosticReportId: report.id!, status: 'reported' as const },
          effects: [...observations, report, provenance, completed.serviceRequest, completed.task]
            .map(resourceEffect)
            .concat(completed.chargeEffects),
        }
      },
    )
  }

  fail(input: { context: ActorContext; error: { code: string; message: string }; eventId: string; requestId: string }) {
    return this.#commands.execute(
      {
        context: input.context,
        dataSchema: systemResponseSchema,
        expectedVersions: {},
        idempotencyKey: input.eventId,
        input: { errorCode: input.error.code, requestId: input.requestId },
        operation: 'examination-request.fail',
      },
      (transaction) => {
        assertRole(input.context, ['ris-system'])
        const request = this.#requiredRequest(input.context, input.requestId)
        const failedTask = this.#requests.failGeneration(
          examinationRequestPolicy,
          transaction,
          input.context,
          request,
          {
            error: input.error,
            now: this.#host.virtualTime(input.context),
          },
        )
        return {
          data: { requestId: request.request_id, status: 'generation-failed' as const },
          effects: failedTask === undefined ? [] : [resourceEffect(failedTask)],
        }
      },
    )
  }

  retry(input: {
    context: ActorContext
    expectedRequestVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    requestId: string
  }) {
    return this.#commands.execute(
      {
        context: input.context,
        dataSchema: examinationRequestActionResponseSchema.shape.data,
        expectedVersions: input.expectedVersions,
        idempotencyKey: input.idempotencyKey,
        input: { expectedRequestVersion: input.expectedRequestVersion, requestId: input.requestId },
        operation: 'examination-request.retry',
      },
      (transaction) => {
        assertRole(input.context, ['outpatient-doctor'])
        const request = this.#requiredRequest(input.context, input.requestId)
        this.#requests.assertRetryable(examinationRequestPolicy, input.context, request, input.expectedRequestVersion)
        if (
          request.generation_error_code === 'INVESTIGATION_UNSUPPORTED' ||
          request.generation_error_code === 'INVESTIGATION_TRUTH_INCOMPATIBLE'
        ) {
          throw new WorkflowError(
            'WORKFLOW_CONFLICT',
            'The examination source cannot produce a compatible result; cancel or revise the request',
          )
        }
        this.#host.assertExpectedVersions(input.expectedVersions, [`Task/${request.execution_task_id}`])
        const task = this.#requests.retryGeneration(
          examinationRequestPolicy,
          transaction,
          input.context,
          request,
          this.#host.virtualTime(input.context),
        )
        return {
          data: { request: this.#projectedRequest(input.context, request.request_id) },
          effects: [resourceEffect(task)],
        }
      },
    )
  }

  acknowledge(input: {
    context: ActorContext
    diagnosticReportId: string
    expectedRequestVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    requestId: string
  }) {
    return this.#commands.execute(
      {
        context: input.context,
        dataSchema: acknowledgeExaminationReportResponseSchema.shape.data,
        expectedVersions: input.expectedVersions,
        idempotencyKey: input.idempotencyKey,
        input: {
          diagnosticReportId: input.diagnosticReportId,
          expectedRequestVersion: input.expectedRequestVersion,
          requestId: input.requestId,
        },
        operation: 'examination-report.acknowledge',
      },
      (transaction) => {
        assertRole(input.context, ['outpatient-doctor'])
        this.#host.assertExpectedVersions(input.expectedVersions, [`DiagnosticReport/${input.diagnosticReportId}`])
        const request = this.#requiredRequest(input.context, input.requestId)
        const acknowledgement = this.#requests.acknowledge(
          examinationRequestPolicy,
          transaction,
          input.context,
          request,
          {
            assertReportContent: () => {
              this.#reportContent(input.context, input.diagnosticReportId)
            },
            diagnosticReportId: input.diagnosticReportId,
            expectedRequestVersion: input.expectedRequestVersion,
            now: this.#host.virtualTime(input.context),
          },
        )
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
            ? [
                {
                  kind: 'created' as const,
                  reference: `ReportAcknowledgement/${acknowledgement.acknowledgementId}`,
                  versionId: '1',
                },
              ]
            : [],
        }
      },
    )
  }

  #caseForAction(context: ActorContext, encounterId: string) {
    const admission = assertInpatientRequestScope(this.#database, context, encounterId, ['inpatient-doctor'])
    if (admission !== undefined) {
      if (admission.status !== 'admitted' || admission.source_case_id === null)
        throw new WorkflowError('WORKFLOW_CONFLICT', '本次住院缺少可用合成病例来源或不在院')
      return { case_id: admission.admission_id, patient_id: admission.patient_id, status: 'admitted' }
    }
    assertRole(context, ['outpatient-doctor'])
    const outpatientCase = this.#host.caseByEncounter(context, encounterId)
    this.#host.assertCaseResponsibility(context, outpatientCase.case_id)
    if (outpatientCase.status !== 'first-visit' || !this.#host.hasConsultation(context, outpatientCase.case_id)) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter cannot edit or issue an examination request')
    }
    return outpatientCase
  }

  #activeService(context: ActorContext, serviceId: string): ExaminationServiceSnapshot {
    const row = z
      .object({ config_json: z.string() })
      .optional()
      .parse(
        this.#database.driver
          .prepare(
            `
      SELECT config_json FROM hospital_service_catalog
      WHERE workspace_id = ? AND epoch = ? AND service_id = ? AND active = 1
        AND json_type(config_json, '$.examinationService') = 'object'
    `,
          )
          .get(context.workspaceId, context.epoch, serviceId),
      )
    if (row === undefined) throw new WorkflowError('CATALOG_CONFLICT', 'The examination service is unavailable')
    return examinationServiceSnapshotSchema.parse(JSON.parse(row.config_json).examinationService)
  }

  #draft(context: ActorContext, caseId: string) {
    return draftRowSchema.optional().parse(
      this.#database.driver
        .prepare(
          `
      SELECT version, draft_service_id, draft_indication, draft_service_snapshot_json
      FROM examination_request_state
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `,
        )
        .get(context.workspaceId, context.epoch, caseId),
    )
  }

  /** 以版本 CAS 更新草稿；不给内容时清空草稿。 */
  #updateDraft(
    context: ActorContext,
    caseId: string,
    currentVersion: number,
    input: { indication?: string; now: string; service?: ExaminationServiceSnapshot },
  ): void {
    const update = this.#database.driver
      .prepare(
        `
      UPDATE examination_request_state
      SET version = ?, draft_service_id = ?, draft_indication = ?, draft_service_snapshot_json = ?,
        updated_by = ?, updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND version = ?
    `,
      )
      .run(
        currentVersion + 1,
        input.service?.id ?? null,
        input.service === undefined ? null : (input.indication ?? null),
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
      'EXAMINATION_REQUEST_VERSION_CONFLICT',
      'The examination request draft version has changed',
      conflict,
    )
  }

  #request(context: ActorContext, requestId: string): RequestRow | undefined {
    return requestRowSchema.optional().parse(
      this.#database.driver
        .prepare(
          `${this.#requestSelect}
      WHERE request.workspace_id = ? AND request.epoch = ? AND request.request_id = ?
        AND request.request_kind = 'examination'
    `,
        )
        .get(context.workspaceId, context.epoch, requestId),
    )
  }

  #requiredRequest(context: ActorContext, requestId: string): RequestRow {
    const request = this.#request(context, requestId)
    if (request === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The examination request was not found')
    return request
  }

  readonly #requestSelect = `
    SELECT request.request_id, request.case_id, request.service_snapshot_json,
      request.generation_error_code, request.generation_error_message,
      request.service_request_id, request.execution_task_id, request.diagnostic_report_id,
      request.status, request.version, request.authored_by,
      detail.exam_code, detail.indication,
      clinical_request_context.patient_id, clinical_request_context.encounter_id
    FROM laboratory_request AS request
    JOIN examination_request_detail AS detail
      ON detail.workspace_id = request.workspace_id
     AND detail.epoch = request.epoch
     AND detail.request_id = request.request_id
    JOIN clinical_request_context
      ON clinical_request_context.workspace_id = request.workspace_id
     AND clinical_request_context.epoch = request.epoch
     AND clinical_request_context.case_id = request.case_id
  `

  #projectedRequests(context: ActorContext, caseId: string) {
    return z
      .array(requestRowSchema)
      .parse(
        this.#database.driver
          .prepare(
            `${this.#requestSelect}
      WHERE request.workspace_id = ? AND request.epoch = ? AND request.case_id = ?
        AND request.request_kind = 'examination'
      ORDER BY julianday(request.authored_at), request.request_id
    `,
          )
          .all(context.workspaceId, context.epoch, caseId),
      )
      .map((request) => this.#project(context, request))
  }

  #projectedRequest(context: ActorContext, requestId: string) {
    return this.#project(context, this.#requiredRequest(context, requestId))
  }

  #project(context: ActorContext, request: RequestRow) {
    const serviceRequest = this.#fhir.read(context, 'ServiceRequest', request.service_request_id)
    const task = this.#fhir.read(context, 'Task', request.execution_task_id)
    const reports =
      request.diagnostic_report_id === null
        ? []
        : this.#reportVersions(context, request.request_id, request.diagnostic_report_id)
    return examinationRequestSchema.parse({
      billing: new OutpatientInvestigationBilling(this.#database).read(context, request.request_id),
      authoredAt: serviceRequest.authoredOn,
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

  #reportVersions(context: ActorContext, requestId: string, diagnosticReportId: string) {
    const row = this.#reportContent(context, diagnosticReportId)
    if (row.request_id !== requestId) throw new WorkflowError('WORKFLOW_CONFLICT', '功能检查报告不属于该申请')
    const content = investigationResultContentSchema.parse(JSON.parse(row.content_json))
    const report = this.#fhir.read(context, 'DiagnosticReport', diagnosticReportId)
    const acknowledgement = reportAcknowledgementRowSchema
      .optional()
      .parse(
        this.#database.driver
          .prepare(
            'SELECT acknowledgement_id,acknowledged_at,acknowledged_by,diagnostic_report_id,request_id,request_version FROM laboratory_report_acknowledgement WHERE workspace_id=? AND epoch=? AND diagnostic_report_id=?',
          )
          .get(context.workspaceId, context.epoch, diagnosticReportId),
      )
    return [
      examinationReportSchema.parse({
        diagnosticReportId,
        diagnosticReportVersion: report.meta!.versionId,
        examinedAt: row.issued_at,
        issuedAt: row.issued_at,
        findings: content.results
          .map(
            (item) =>
              item.display +
              '：' +
              (typeof item.value === 'object' ? item.value.display : String(item.value)) +
              (item.unit?.display ?? ''),
          )
          .join('；'),
        impression: content.conclusion,
        technique: examinationServiceSnapshotSchema.parse(
          JSON.parse(this.#requiredRequest(context, requestId).service_snapshot_json),
        ).method,
        results: content.results,
        status: 'final',
        revisionNumber: 1,
        ...(acknowledgement === undefined
          ? {}
          : {
              acknowledgement: {
                id: acknowledgement.acknowledgement_id,
                acknowledgedAt: acknowledgement.acknowledged_at,
                acknowledgedBy: acknowledgement.acknowledged_by,
              },
            }),
      }),
    ]
  }

  publishedReportText(context: ActorContext, caseId: string, diagnosticReportId: string) {
    const row = this.#reportContent(context, diagnosticReportId)
    if (row.case_id !== caseId) throw new WorkflowError('WORKFLOW_CONFLICT', '功能检查报告不属于该病例')
    const report = this.#reportVersions(context, row.request_id, diagnosticReportId)[0]!
    return {
      text: [report.technique, report.findings, report.impression].join('\n'),
      reportContentHash: canonicalJsonHash(JSON.parse(row.content_json)),
    }
  }
  #reportContent(context: ActorContext, diagnosticReportId: string) {
    const row = z
      .object({ request_id: z.string(), case_id: z.string(), content_json: z.string(), issued_at: z.string() })
      .optional()
      .parse(
        this.#database.driver
          .prepare(
            'SELECT * FROM examination_report_content WHERE workspace_id=? AND epoch=? AND diagnostic_report_id=?',
          )
          .get(context.workspaceId, context.epoch, diagnosticReportId),
      )
    if (row === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', '功能检查报告不存在')
    return row
  }
}
