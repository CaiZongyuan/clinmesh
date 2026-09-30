import type { FhirResource } from '@clinmesh/contracts/fhir'
import type { ApiConflict } from '@clinmesh/contracts/his'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ActorContext, CommandTransaction } from './command-executor.ts'
import { WorkflowError } from './workflow-error.ts'

export type ClinicalRequestKind = 'laboratory' | 'imaging'

export type ClinicalRequestStatus =
  | 'acknowledged'
  | 'accepted'
  | 'cancelled'
  | 'generation-failed'
  | 'in-progress'
  | 'issued'
  | 'reported'

/** 每类申请在共享生命周期中的差异：错误码、资源名、执行 outbox 与文案。 */
export interface ClinicalRequestPolicy {
  readonly dedupPrefix: string
  readonly generationFailedStatusText: string
  readonly generationRetryingStatusText: string
  readonly kind: ClinicalRequestKind
  readonly label: string
  readonly notCancellableCode: WorkflowError['code']
  readonly outbox: { readonly report: string; readonly start: string }
  readonly owner: ApiConflict['owner']
  readonly resourceType: string
  readonly versionConflictCode: WorkflowError['code']
}

export const laboratoryRequestPolicy: ClinicalRequestPolicy = {
  dedupPrefix: 'laboratory-request',
  generationFailedStatusText: 'Investigation result generation failed',
  generationRetryingStatusText: 'Investigation result generation retrying',
  kind: 'laboratory',
  label: 'laboratory',
  notCancellableCode: 'LABORATORY_REQUEST_NOT_CANCELLABLE',
  outbox: { report: 'laboratory.report-request', start: 'laboratory.start-request' },
  owner: 'laboratory-request',
  resourceType: 'LaboratoryRequest',
  versionConflictCode: 'LABORATORY_REQUEST_VERSION_CONFLICT',
}

/** 生命周期只依赖的申请行字段；各类申请适配器读取的行都满足该形状。 */
export interface ClinicalRequestRow {
  readonly authored_by: string
  readonly diagnostic_report_id: string | null
  readonly execution_task_id: string
  readonly request_id: string
  readonly service_request_id: string
  readonly status: ClinicalRequestStatus
  readonly version: number
}

export const reportAcknowledgementRowSchema = z.object({
  acknowledgement_id: z.string().min(1),
  acknowledged_at: z.string().datetime({ offset: true }),
  acknowledged_by: z.string().min(1),
  diagnostic_report_id: z.string().min(1),
  request_id: z.string().min(1),
  request_version: z.number().int().positive(),
}).strict()

export interface ReportAcknowledgement {
  acknowledgedAt: string
  acknowledgedBy: string
  acknowledgementId: string
  created: boolean
  diagnosticReportId: string
  requestId: string
  requestVersion: number
}

/**
 * 检验、放射等临床申请共用的生命周期：取消、受理、开始、失败与重试、完成执行、
 * 确认已阅、报告修订和完诊门禁汇总。调用方负责 Command 身份、角色、expected
 * version 与响应 DTO；内核负责状态前置条件、CAS、执行 Task 与后续 outbox。
 */
export class ClinicalRequestKernel {
  readonly #database: ClinMeshDatabase

  constructor(database: ClinMeshDatabase) {
    this.#database = database
  }

  /** 全部未取消申请的状态，与申请类型无关，供完诊门禁汇总。 */
  openRequestStatuses(context: ActorContext, caseId: string): ClinicalRequestStatus[] {
    const rows = this.#database.driver.prepare(`
      SELECT status FROM laboratory_request
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status <> 'cancelled'
    `).all(context.workspaceId, context.epoch, caseId) as Array<{ status: ClinicalRequestStatus }>
    return rows.map(row => row.status)
  }

  /** 相关 FHIR 资源版本变化时，按申请当前状态给出稳定冲突。 */
  relatedVersionConflict(
    policy: ClinicalRequestPolicy,
    current: ClinicalRequestRow,
    expectedRequestVersion: number,
  ): WorkflowError {
    return new WorkflowError(
      policy.versionConflictCode,
      `The ${policy.label} request is "${current.status}" at version ${current.version}; a related resource version has changed`,
      {
        currentStatus: current.status,
        currentVersion: String(current.version),
        expectedVersion: String(expectedRequestVersion),
        owner: policy.owner,
        resource: `${policy.resourceType}/${current.request_id}`,
      },
    )
  }

  cancel(
    policy: ClinicalRequestPolicy,
    transaction: CommandTransaction,
    context: ActorContext,
    request: ClinicalRequestRow,
    input: { expectedRequestVersion: number; now: string; reasonCode: string },
  ): { serviceRequest: FhirResource; task: FhirResource; version: number } {
    if (request.version !== input.expectedRequestVersion) {
      throw new WorkflowError(
        policy.versionConflictCode,
        `The ${policy.label} request is "${request.status}" at version ${request.version}; expected version ${input.expectedRequestVersion}`,
        {
          currentStatus: request.status,
          currentVersion: String(request.version),
          expectedVersion: String(input.expectedRequestVersion),
          owner: policy.owner,
          resource: `${policy.resourceType}/${request.request_id}`,
        },
      )
    }
    if (request.status !== 'issued' && request.status !== 'generation-failed') {
      throw new WorkflowError(
        policy.notCancellableCode,
        `The ${policy.label} request cannot be cancelled from status "${request.status}"`,
        {
          currentStatus: request.status,
          currentVersion: String(request.version),
          owner: policy.owner,
          resource: `${policy.resourceType}/${request.request_id}`,
        },
      )
    }
    const serviceRequest = transaction.fhir.read(context, 'ServiceRequest', request.service_request_id)
    const task = transaction.fhir.read(context, 'Task', request.execution_task_id)
    const updatedServiceRequest = transaction.fhir.update(context, {
      ...serviceRequest,
      status: 'revoked',
    }, serviceRequest.meta?.versionId ?? '1')
    const updatedTask = transaction.fhir.update(context, {
      ...task,
      status: 'cancelled',
      lastModified: input.now,
      statusReason: {
        concept: {
          coding: [{
            code: input.reasonCode,
            system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/request-status-reason',
          }],
        },
      },
    }, task.meta?.versionId ?? '1')
    const version = request.version + 1
    const update = this.#database.driver.prepare(`
      UPDATE laboratory_request
      SET status = 'cancelled', version = ?, cancelled_at = ?
      WHERE workspace_id = ? AND epoch = ? AND request_id = ?
        AND status IN ('issued', 'generation-failed') AND version = ?
    `).run(
      version,
      input.now,
      context.workspaceId,
      context.epoch,
      request.request_id,
      request.version,
    )
    if (update.changes !== 1) throw this.#versionChanged(policy)
    return { serviceRequest: updatedServiceRequest, task: updatedTask, version }
  }

  /** 受理执行；已取消申请收到晚到受理事件时无副作用完成。 */
  accept(
    policy: ClinicalRequestPolicy,
    transaction: CommandTransaction,
    context: ActorContext,
    request: ClinicalRequestRow,
    now: string,
  ): { status: 'accepted'; task: FhirResource } | { status: 'cancelled' } {
    if (request.status === 'cancelled') return { status: 'cancelled' }
    if (request.status !== 'issued') {
      throw new WorkflowError('WORKFLOW_CONFLICT', `The ${policy.label} request cannot be accepted`)
    }
    const task = transaction.fhir.read(context, 'Task', request.execution_task_id)
    const updatedTask = transaction.fhir.update(context, {
      ...task,
      status: 'accepted',
      lastModified: now,
    }, task.meta?.versionId ?? '1')
    const update = this.#database.driver.prepare(`
      UPDATE laboratory_request
      SET status = 'accepted', version = version + 1, accepted_at = ?
      WHERE workspace_id = ? AND epoch = ? AND request_id = ?
        AND status = 'issued' AND version = ?
    `).run(now, context.workspaceId, context.epoch, request.request_id, request.version)
    if (update.changes !== 1) throw this.#versionChanged(policy)
    transaction.enqueue({
      dedupKey: `${policy.dedupPrefix}:${request.request_id}:start`,
      kind: policy.outbox.start,
      payload: { requestId: request.request_id },
    })
    return { status: 'accepted', task: updatedTask }
  }

  start(
    policy: ClinicalRequestPolicy,
    transaction: CommandTransaction,
    context: ActorContext,
    request: ClinicalRequestRow,
    input: { enqueueReport: boolean; now: string },
  ): FhirResource {
    if (request.status !== 'accepted') {
      throw new WorkflowError('WORKFLOW_CONFLICT', `The ${policy.label} request cannot start execution`)
    }
    const task = transaction.fhir.read(context, 'Task', request.execution_task_id)
    const updatedTask = transaction.fhir.update(context, {
      ...task,
      status: 'in-progress',
      lastModified: input.now,
      executionPeriod: {
        ...((typeof task.executionPeriod === 'object' && task.executionPeriod !== null)
          ? task.executionPeriod as Record<string, unknown>
          : {}),
        start: input.now,
      },
    }, task.meta?.versionId ?? '2')
    const update = this.#database.driver.prepare(`
      UPDATE laboratory_request
      SET status = 'in-progress', version = version + 1, started_at = ?
      WHERE workspace_id = ? AND epoch = ? AND request_id = ?
        AND status = 'accepted' AND version = ?
    `).run(input.now, context.workspaceId, context.epoch, request.request_id, request.version)
    if (update.changes !== 1) throw this.#versionChanged(policy)
    if (input.enqueueReport) {
      transaction.enqueue({
        dedupKey: `${policy.dedupPrefix}:${request.request_id}:report`,
        kind: policy.outbox.report,
        payload: { requestId: request.request_id },
      })
    }
    return updatedTask
  }

  /** 报告内容由适配器创建；这里完成 ServiceRequest、执行 Task 并把申请推进到 reported。 */
  completeReport(
    policy: ClinicalRequestPolicy,
    transaction: CommandTransaction,
    context: ActorContext,
    request: ClinicalRequestRow,
    input: {
      diagnosticReportId: string
      now: string
      resultSnapshotId: string | null
      serviceRequest: FhirResource
      task: FhirResource
    },
  ): { serviceRequest: FhirResource; task: FhirResource } {
    const completedServiceRequest = transaction.fhir.update(context, {
      ...input.serviceRequest,
      status: 'completed',
    }, input.serviceRequest.meta?.versionId ?? '1')
    const completedTask = transaction.fhir.update(context, {
      ...input.task,
      status: 'completed',
      lastModified: input.now,
      executionPeriod: {
        ...((typeof input.task.executionPeriod === 'object' && input.task.executionPeriod !== null)
          ? input.task.executionPeriod as Record<string, unknown>
          : {}),
        end: input.now,
      },
    }, input.task.meta?.versionId ?? '3')
    const update = this.#database.driver.prepare(`
      UPDATE laboratory_request
      SET status = 'reported', version = version + 1, reported_at = ?,
        diagnostic_report_id = ?, result_snapshot_id = ?
      WHERE workspace_id = ? AND epoch = ? AND request_id = ?
        AND status = 'in-progress' AND version = ?
    `).run(
      input.now,
      input.diagnosticReportId,
      input.resultSnapshotId,
      context.workspaceId,
      context.epoch,
      request.request_id,
      request.version,
    )
    if (update.changes !== 1) throw this.#versionChanged(policy)
    return { serviceRequest: completedServiceRequest, task: completedTask }
  }

  /** 执行失败落为 generation-failed；重复失败事件无副作用完成。 */
  failGeneration(
    policy: ClinicalRequestPolicy,
    transaction: CommandTransaction,
    context: ActorContext,
    request: ClinicalRequestRow,
    input: { error: { code: string; message: string }; now: string },
  ): FhirResource | undefined {
    if (request.status === 'generation-failed') return undefined
    if (request.status !== 'in-progress') {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        `Only an in-progress ${policy.label} request can fail generation`,
      )
    }
    const task = transaction.fhir.read(context, 'Task', request.execution_task_id)
    const failedTask = transaction.fhir.update(context, {
      ...task,
      status: 'failed',
      businessStatus: { text: policy.generationFailedStatusText },
      statusReason: { text: input.error.message },
      lastModified: input.now,
    }, task.meta?.versionId ?? '3')
    const update = this.#database.driver.prepare(`
      UPDATE laboratory_request
      SET status = 'generation-failed', version = version + 1,
        generation_error_code = ?, generation_error_message = ?
      WHERE workspace_id = ? AND epoch = ? AND request_id = ?
        AND status = 'in-progress' AND version = ?
    `).run(
      input.error.code,
      input.error.message,
      context.workspaceId,
      context.epoch,
      request.request_id,
      request.version,
    )
    if (update.changes !== 1) throw this.#versionChanged(policy)
    return failedTask
  }

  /** 只有原开具医生能以当前版本重试失败申请。 */
  assertRetryable(
    policy: ClinicalRequestPolicy,
    context: ActorContext,
    request: ClinicalRequestRow,
    expectedRequestVersion: number,
  ): void {
    if (
      request.authored_by !== (context.practitionerId ?? context.actorId)
      || request.status !== 'generation-failed'
      || request.version !== expectedRequestVersion
    ) {
      throw new WorkflowError('WORKFLOW_CONFLICT', `The ${policy.label} generation cannot be retried`)
    }
  }

  /** 为同一冻结申请开启新的执行尝试窗口。 */
  retryGeneration(
    policy: ClinicalRequestPolicy,
    transaction: CommandTransaction,
    context: ActorContext,
    request: ClinicalRequestRow,
    now: string,
  ): FhirResource {
    const task = transaction.fhir.read(context, 'Task', request.execution_task_id)
    const retryTask = { ...task }
    Reflect.deleteProperty(retryTask, 'statusReason')
    const retriedTask = transaction.fhir.update(context, {
      ...retryTask,
      status: 'in-progress',
      businessStatus: { text: policy.generationRetryingStatusText },
      lastModified: now,
    }, task.meta?.versionId ?? '4')
    const update = this.#database.driver.prepare(`
      UPDATE laboratory_request
      SET status = 'in-progress', version = version + 1,
        generation_error_code = NULL, generation_error_message = NULL
      WHERE workspace_id = ? AND epoch = ? AND request_id = ?
        AND status = 'generation-failed' AND version = ?
    `).run(context.workspaceId, context.epoch, request.request_id, request.version)
    if (update.changes !== 1) throw this.#versionChanged(policy)
    transaction.enqueue({
      dedupKey: `${policy.dedupPrefix}:${request.request_id}:report:retry:${request.version + 1}`,
      kind: policy.outbox.report,
      payload: { requestId: request.request_id },
    })
    return retriedTask
  }

  /**
   * 原开具医生确认当前已签发报告。每个报告版本只保存一条确认事实，
   * 重复确认返回第一次确认；报告内容结构由调用方的 `assertReportContent` 校验。
   */
  acknowledge(
    policy: ClinicalRequestPolicy,
    transaction: CommandTransaction,
    context: ActorContext,
    request: ClinicalRequestRow,
    input: {
      assertReportContent: (report: FhirResource) => void
      diagnosticReportId: string
      expectedRequestVersion: number
      now: string
    },
  ): ReportAcknowledgement {
    const practitionerId = context.practitionerId
    if (practitionerId === undefined || request.authored_by !== practitionerId) {
      throw new WorkflowError(
        'ROLE_NOT_ALLOWED',
        `Only the doctor responsible for the ${policy.label} request can acknowledge its report`,
      )
    }
    const existing = reportAcknowledgementRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT acknowledgement_id, acknowledged_at, acknowledged_by,
          diagnostic_report_id, request_id, request_version
        FROM laboratory_report_acknowledgement
        WHERE workspace_id = ? AND epoch = ? AND diagnostic_report_id = ?
      `).get(context.workspaceId, context.epoch, input.diagnosticReportId),
    )
    if (existing !== undefined) {
      if (existing.request_id !== request.request_id || existing.acknowledged_by !== practitionerId) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          `The ${policy.label} report acknowledgement is invalid`,
        )
      }
      return {
        acknowledgedAt: existing.acknowledged_at,
        acknowledgedBy: existing.acknowledged_by,
        acknowledgementId: existing.acknowledgement_id,
        created: false,
        diagnosticReportId: existing.diagnostic_report_id,
        requestId: existing.request_id,
        requestVersion: existing.request_version,
      }
    }
    if (request.diagnostic_report_id !== input.diagnosticReportId || request.status !== 'reported') {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        `Only the current signed ${policy.label} report can be acknowledged`,
      )
    }
    if (request.version !== input.expectedRequestVersion) throw this.#versionChanged(policy)
    const report = transaction.fhir.read(context, 'DiagnosticReport', input.diagnosticReportId)
    if (report.status !== 'final') {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        `Only a signed ${policy.label} report can be acknowledged`,
      )
    }
    input.assertReportContent(report)
    const acknowledgementId = uuidv7()
    this.#database.driver.prepare(`
      INSERT INTO laboratory_report_acknowledgement (
        workspace_id, epoch, acknowledgement_id, request_id, diagnostic_report_id,
        acknowledged_by, acknowledged_by_practitioner_role_id, acknowledged_at,
        request_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      acknowledgementId,
      request.request_id,
      input.diagnosticReportId,
      practitionerId,
      context.practitionerRoleId,
      input.now,
      request.version + 1,
    )
    const update = this.#database.driver.prepare(`
      UPDATE laboratory_request
      SET status = 'acknowledged', version = version + 1, acknowledged_at = ?
      WHERE workspace_id = ? AND epoch = ? AND request_id = ?
        AND status = 'reported' AND version = ? AND diagnostic_report_id = ?
    `).run(
      input.now,
      context.workspaceId,
      context.epoch,
      request.request_id,
      request.version,
      input.diagnosticReportId,
    )
    if (update.changes !== 1) throw this.#versionChanged(policy)
    return {
      acknowledgedAt: input.now,
      acknowledgedBy: practitionerId,
      acknowledgementId,
      created: true,
      diagnosticReportId: input.diagnosticReportId,
      requestId: request.request_id,
      requestVersion: request.version + 1,
    }
  }

  /** 记录报告的线性修订，并让申请指向新报告、回到待确认。 */
  recordReportRevision(
    policy: ClinicalRequestPolicy,
    context: ActorContext,
    request: ClinicalRequestRow,
    input: {
      diagnosticReportId: string
      now: string
      provenanceId: string
      reason: string
      revisionOfDiagnosticReportId: string
    },
  ): void {
    this.#database.driver.prepare(`
      INSERT INTO laboratory_report_revision (
        workspace_id, epoch, revision_id, request_id, diagnostic_report_id,
        revision_of_diagnostic_report_id, provenance_id, reason, corrected_by, corrected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      uuidv7(),
      request.request_id,
      input.diagnosticReportId,
      input.revisionOfDiagnosticReportId,
      input.provenanceId,
      input.reason,
      context.actorId,
      input.now,
    )
    const update = this.#database.driver.prepare(`
      UPDATE laboratory_request
      SET status = 'reported', version = version + 1, reported_at = ?,
        acknowledged_at = NULL, diagnostic_report_id = ?
      WHERE workspace_id = ? AND epoch = ? AND request_id = ?
        AND version = ? AND diagnostic_report_id = ?
        AND status IN ('reported', 'acknowledged')
    `).run(
      input.now,
      input.diagnosticReportId,
      context.workspaceId,
      context.epoch,
      request.request_id,
      request.version,
      input.revisionOfDiagnosticReportId,
    )
    if (update.changes !== 1) throw this.#versionChanged(policy)
  }

  #versionChanged(policy: ClinicalRequestPolicy): WorkflowError {
    return new WorkflowError(
      policy.versionConflictCode,
      `The ${policy.label} request version has changed`,
    )
  }
}
