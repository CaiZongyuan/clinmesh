import {
  agentOutputScoreResultSchema,
  evaluateAgentOutputInputSchema,
  type AgentOutputScoreResult,
} from '@clinmesh/contracts/agent-output-scorer'
import {
  AgentOutputScorerError,
  scoreAgentDraftOutput,
} from '@clinmesh/core/agent-output-scorer'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import { WorkspaceRepository } from '../infrastructure/sqlite/workspace-repository.ts'
import type { ClinicalFactLedgerService } from './clinical-fact-ledger-service.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import type { OutpatientWorkflowContext } from './outpatient-workflow-context.ts'
import { WorkflowError } from './workflow-error.ts'

export class AgentOutputScorerServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
    readonly reason?: string,
  ) {
    super(message)
    this.name = 'AgentOutputScorerServiceError'
  }
}

const SCORER_ALLOWED_ROLES = new Set([
  'administrator',
  'outpatient-doctor',
  'inpatient-doctor',
])

const outpatientCasePatientRowSchema = z.object({
  patient_id: z.string().min(1),
}).strict()

const inpatientAdmissionScopeRowSchema = z.object({
  organization_id: z.string().min(1),
  patient_id: z.string().min(1),
  ward_id: z.string().min(1),
}).strict()

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unwrapScorerRequestPayload(rawBody: unknown): unknown {
  if (
    isPlainRecord(rawBody)
    && Object.keys(rawBody).length === 1
    && Object.hasOwn(rawBody, 'input')
  ) {
    return rawBody['input']
  }
  return rawBody
}

function assertLiveModelGateBeforeValidation(candidate: unknown): void {
  if (!isPlainRecord(candidate)) return
  if (candidate['mode'] !== 'live-model') return
  const permit = candidate['liveRunPermit']
  const granted = isPlainRecord(permit) && permit['explicitUserPermissionGranted'] === true
  if (!granted) {
    throw new AgentOutputScorerError(
      'LIVE_MODEL_SCORING_PERMISSION_REQUIRED',
      '对真实模型输出评分必须获得用户针对当次运行的明确许可',
    )
  }
}

export class AgentOutputScorerService {
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  readonly #factLedger: ClinicalFactLedgerService
  readonly #outpatient: OutpatientWorkflowContext
  readonly #workspaces: WorkspaceRepository

  constructor(options: {
    commands: CommandExecutor
    database: ClinMeshDatabase
    factLedger: ClinicalFactLedgerService
    outpatientContext: OutpatientWorkflowContext
  }) {
    this.#commands = options.commands
    this.#database = options.database
    this.#factLedger = options.factLedger
    this.#outpatient = options.outpatientContext
    this.#workspaces = new WorkspaceRepository(options.database)
  }

  evaluateHttp(input: {
    context: ActorContext
    rawBody: unknown
  }): AgentOutputScoreResult {
    const auditInput: Record<string, unknown> = {}
    const { context } = input

    try {
      if (!SCORER_ALLOWED_ROLES.has(context.roleCode)) {
        throw new WorkflowError('ROLE_NOT_ALLOWED', '当前岗位无权调用 Agent 输出评测服务')
      }

      const payload = unwrapScorerRequestPayload(input.rawBody)
      if (isPlainRecord(payload)) {
        if (typeof payload['subjectKind'] === 'string') auditInput['subjectKind'] = payload['subjectKind']
        if (typeof payload['subjectId'] === 'string') auditInput['subjectId'] = payload['subjectId']
        if (typeof payload['mode'] === 'string') auditInput['mode'] = payload['mode']
      }

      assertLiveModelGateBeforeValidation(payload)
      const parsed = evaluateAgentOutputInputSchema.parse(payload)
      auditInput['rubricId'] = parsed.rubric.rubricId
      auditInput['packId'] = parsed.rubric.packId
      auditInput['taskId'] = parsed.rubric.taskId
      if (parsed.liveRunPermit !== undefined) {
        auditInput['runId'] = parsed.liveRunPermit.runId
      }

      if (parsed.subjectKind === undefined || parsed.subjectId === undefined) {
        throw new AgentOutputScorerServiceError(
          'SCORER_SUBJECT_REQUIRED',
          '评分接口必须提供有效的 subjectKind 与 subjectId 以加载临床事实总账',
          400,
        )
      }

      this.#workspaces.assertCurrent(context, context.scenarioRunId)

      let patientId: string
      if (parsed.subjectKind === 'outpatient') {
        if (context.roleCode === 'inpatient-doctor') {
          throw new WorkflowError('ROLE_NOT_ALLOWED', '住院医生无权评测门诊病例输出')
        }
        const caseRow = outpatientCasePatientRowSchema.optional().parse(
          this.#database.driver.prepare(`
            SELECT patient_id FROM outpatient_case
            WHERE workspace_id = ? AND epoch = ? AND case_id = ?
          `).get(context.workspaceId, context.epoch, parsed.subjectId),
        )
        if (caseRow === undefined) {
          throw new AgentOutputScorerServiceError(
            'OUTPATIENT_CASE_NOT_FOUND',
            `Outpatient case ${parsed.subjectId} was not found`,
            404,
          )
        }
        if (context.roleCode === 'outpatient-doctor') {
          this.#outpatient.requireDoctorCase(context, parsed.subjectId)
          this.#outpatient.assertCaseResponsibility(context, parsed.subjectId)
        }
        patientId = caseRow.patient_id
      } else {
        if (context.roleCode === 'outpatient-doctor') {
          throw new WorkflowError('ROLE_NOT_ALLOWED', '门诊医生无权评测住院病例输出')
        }
        const admRow = inpatientAdmissionScopeRowSchema.optional().parse(
          this.#database.driver.prepare(`
            SELECT patient_id, organization_id, ward_id FROM inpatient_admission
            WHERE workspace_id = ? AND epoch = ? AND admission_id = ?
          `).get(context.workspaceId, context.epoch, parsed.subjectId),
        )
        if (admRow === undefined) {
          throw new AgentOutputScorerServiceError('INPATIENT_NOT_FOUND', '未找到本次住院', 404)
        }
        if (
          context.roleCode === 'inpatient-doctor'
          && (context.organizationId !== admRow.organization_id || context.locationId !== admRow.ward_id)
        ) {
          throw new AgentOutputScorerServiceError(
            'INPATIENT_SCOPE_FORBIDDEN',
            '当前科室或病区不负责本次住院',
            403,
          )
        }
        patientId = admRow.patient_id
      }

      const asOf = parsed.asOf ?? this.#outpatient.virtualTime(context)
      auditInput['asOf'] = asOf

      const ledger = this.#factLedger.buildInternalLedger(
        context,
        { id: parsed.subjectId, kind: parsed.subjectKind, patientId },
        { asOf },
      )

      const result = agentOutputScoreResultSchema.parse(
        scoreAgentDraftOutput({
          evaluatedAt: asOf,
          input: parsed,
          ledger,
        }),
      )

      this.#commands.auditRead(context, 'evaluation.agent-output-score', auditInput, 'success')
      return result
    } catch (error) {
      try {
        this.#commands.auditRead(context, 'evaluation.agent-output-score', auditInput, 'failed')
      } catch {
        // preserve original error
      }
      throw error
    }
  }
}
