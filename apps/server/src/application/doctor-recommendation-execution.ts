import { z } from 'zod'
import { doctorRecommendationKindSchema } from '@clinmesh/contracts/doctor-recommendations'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import {
  ChatCompletionRequestControlError, ChatCompletionsError,
  type JsonChatCompletionInput, type JsonChatCompletionsProvider,
} from '../infrastructure/ai/openai-chat-completions.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

const stageSchema = z.enum(['history-selection', 'history-consolidation', 'catalog-selection', 'generation', 'verification'])
export type DoctorRecommendationExecutionStage = z.infer<typeof stageSchema>
const nameSchema = z.string().min(1).max(256)
const dependencySchema = z.object({ stage: stageSchema, batchId: nameSchema }).strict()
const batchSchema = dependencySchema.omit({ stage: true }).extend({
  inputHash: z.string().regex(/^[a-f0-9]{64}$/), dependencies: z.array(dependencySchema).max(25).default([]),
}).strict()
export interface DoctorRecommendationExecutionBatch {
  batchId: string
  inputHash: string
  dependencies?: Array<{ stage: DoctorRecommendationExecutionStage; batchId: string }>
}
const identitySchema = z.object({
  workspaceId: nameSchema, epoch: nameSchema, actorId: nameSchema, contextKey: nameSchema,
  caseId: nameSchema, kind: doctorRecommendationKindSchema, generation: z.number().int().positive(),
}).strict()
const bindingSchema = z.object({
  identity: identitySchema, inputFingerprint: nameSchema, model: z.string().min(1).max(1024), policyVersion: nameSchema,
}).strict()
const executionRowSchema = z.object({ binding_json: z.string(), extra_request_count: z.number().int().min(0).max(4) })
const unitRowSchema = z.object({
  stage: stageSchema, batch_id: nameSchema, input_hash: z.string().regex(/^[a-f0-9]{64}$/),
  dependencies_json: z.string(), status: z.enum(['pending', 'dispatching', 'succeeded', 'failed', 'unknown']),
  request_count: z.number().int().min(0).max(3), result_json: z.string().nullable(),
  error_code: z.string().nullable(), resume_available: z.union([z.literal(0), z.literal(1)]),
})
type UnitRow = z.infer<typeof unitRowSchema>
const activeUnits = new WeakMap<ClinMeshDatabase['driver'], Set<string>>()
export type DoctorRecommendationExecutionErrorKind = 'unknown' | 'exhausted' | 'plan-conflict' | 'failed' | 'dependency-pending' | 'running'
export class DoctorRecommendationExecutionError extends Error {
  readonly code: string
  constructor(readonly kind: DoctorRecommendationExecutionErrorKind, options?: ErrorOptions) {
    super(`The recommendation execution is ${kind}`, options)
    this.name = 'DoctorRecommendationExecutionError'
    this.code = `RECOMMENDATION_${kind.replaceAll('-', '_').toUpperCase()}`
  }
}

export function recommendationRequestHash(request: JsonChatCompletionInput): string {
  return canonicalJsonHash({ model: request.model, schemaName: request.schemaName, jsonSchema: request.jsonSchema,
    systemPrompt: request.systemPrompt, userPayload: request.userPayload,
    maxAttempts: request.maxAttempts, maxInputBytes: request.maxInputBytes })
}

export interface DoctorRecommendationExecutionStatus {
  status: 'pending' | 'running' | 'failed' | 'unknown' | 'exhausted' | 'completed'
  requestCount: number
  extraRequestCount: number
  maxRequestsPerUnit: 3
  maxExtraRequests: 4
  canContinue: boolean
  units: Array<{ stage: DoctorRecommendationExecutionStage; batchId: string; status: UnitRow['status']; requestCount: number; errorCode?: string }>
}

function executionUnits(database: ClinMeshDatabase, scope: readonly [string, string], key: string): UnitRow[] {
  return z.array(unitRowSchema).parse(database.driver.prepare(`SELECT stage, batch_id, input_hash,
    dependencies_json, status, request_count, result_json, error_code, resume_available
    FROM doctor_recommendation_execution_unit WHERE workspace_id = ? AND epoch = ? AND execution_key = ? ORDER BY rowid`).all(...scope, key))
}

function executionStatus(units: UnitRow[], extraRequestCount: number): DoctorRecommendationExecutionStatus {
  const exhausted = extraRequestCount >= 4 || units.some(unit => unit.request_count >= 3)
  const status = units.length > 0 && units.every(unit => unit.status === 'succeeded') ? 'completed'
    : exhausted ? 'exhausted' : units.some(unit => unit.status === 'unknown') ? 'unknown'
      : units.some(unit => unit.status === 'dispatching') ? 'running'
        : units.some(unit => unit.status === 'failed') ? 'failed' : 'pending'
  return { status, requestCount: units.reduce((count, unit) => count + unit.request_count, 0), extraRequestCount,
    maxRequestsPerUnit: 3, maxExtraRequests: 4, canContinue: !exhausted && (status === 'unknown' || status === 'failed'),
    units: units.map(unit => ({ stage: unit.stage, batchId: unit.batch_id, status: unit.status, requestCount: unit.request_count,
      ...(unit.error_code === null ? {} : { errorCode: unit.error_code }) })) }
}

/** Read-only projection; never creates a task, changes its binding, or resolves a model. */
export function readDoctorRecommendationExecution(database: ClinMeshDatabase, identity: z.infer<typeof identitySchema>): {
  inputFingerprint: string; model: string; policyVersion: string; status: DoctorRecommendationExecutionStatus
} | undefined {
  const parsedIdentity = identitySchema.parse(identity)
  const scope = [parsedIdentity.workspaceId, parsedIdentity.epoch] as const
  const key = canonicalJsonHash(parsedIdentity)
  const row = executionRowSchema.optional().parse(database.driver.prepare(`SELECT binding_json, extra_request_count
    FROM doctor_recommendation_execution WHERE workspace_id = ? AND epoch = ? AND execution_key = ?`).get(...scope, key))
  if (row === undefined) return undefined
  const binding = bindingSchema.parse(JSON.parse(row.binding_json))
  if (canonicalJsonHash(binding.identity) !== key) throw new DoctorRecommendationExecutionError('plan-conflict')
  return { inputFingerprint: binding.inputFingerprint, model: binding.model, policyVersion: binding.policyVersion,
    status: executionStatus(executionUnits(database, scope, key), row.extra_request_count) }
}

/** Private checkpoints. Only the owning service may publish fully verified recommendations. */
export class DoctorRecommendationExecution {
  readonly #key: string
  readonly #scope: readonly [string, string]
  constructor(private readonly options: {
    database: ClinMeshDatabase
    identity: z.infer<typeof identitySchema>
    inputFingerprint: string
    model: string
    policyVersion: string
    provider: JsonChatCompletionsProvider
    assertCurrent: () => void
  }) {
    const binding = bindingSchema.parse({ identity: options.identity, inputFingerprint: options.inputFingerprint,
      model: options.model, policyVersion: options.policyVersion })
    this.#key = canonicalJsonHash(binding.identity)
    this.#scope = [binding.identity.workspaceId, binding.identity.epoch]
    this.options.database.driver.prepare(`INSERT OR IGNORE INTO doctor_recommendation_execution
      (workspace_id, epoch, execution_key, binding_json) VALUES (?, ?, ?, ?)`).run(...this.#scope, this.#key, JSON.stringify(binding))
    if (canonicalJsonHash(bindingSchema.parse(JSON.parse(this.#execution().binding_json))) !== canonicalJsonHash(binding)) {
      throw new DoctorRecommendationExecutionError('plan-conflict')
    }
    this.recoverUnknown()
  }

  #execution() {
    return executionRowSchema.parse(this.options.database.driver.prepare(`SELECT binding_json, extra_request_count
      FROM doctor_recommendation_execution WHERE workspace_id = ? AND epoch = ? AND execution_key = ?`).get(...this.#scope, this.#key))
  }

  #units(): UnitRow[] {
    return executionUnits(this.options.database, this.#scope, this.#key)
  }

  #selectionCheckpoint<T>(unit: UnitRow, parse: (value: unknown) => T): { value: T } | undefined {
    if (unit.stage !== 'history-selection' && unit.stage !== 'catalog-selection') return undefined
    const row = z.object({ execution_key: z.string(), binding_json: z.string(), result_json: z.string() }).optional().parse(
      this.options.database.driver.prepare(`SELECT execution.execution_key, execution.binding_json, unit.result_json
        FROM doctor_recommendation_execution_unit AS unit JOIN doctor_recommendation_execution AS execution
        ON execution.workspace_id = unit.workspace_id AND execution.epoch = unit.epoch AND execution.execution_key = unit.execution_key
        WHERE unit.workspace_id = ? AND unit.epoch = ? AND unit.stage = ? AND unit.input_hash = ? AND unit.status = 'succeeded'
          AND json_extract(execution.binding_json, '$.identity.actorId') = ?
          AND json_extract(execution.binding_json, '$.identity.contextKey') = ?
          AND json_extract(execution.binding_json, '$.identity.caseId') = ?
          AND json_extract(execution.binding_json, '$.model') = ?
          AND json_extract(execution.binding_json, '$.policyVersion') = ?
        ORDER BY unit.rowid LIMIT 1`)
        .get(...this.#scope, unit.stage, unit.input_hash, this.options.identity.actorId,
          this.options.identity.contextKey, this.options.identity.caseId, this.options.model, this.options.policyVersion))
    if (row !== undefined) {
      const binding = bindingSchema.parse(JSON.parse(row.binding_json))
      if (canonicalJsonHash(binding.identity) !== row.execution_key) throw new DoctorRecommendationExecutionError('plan-conflict')
      const { kind: _kind, generation: _generation, ...sourceScope } = binding.identity
      const { kind: _currentKind, generation: _currentGeneration, ...currentScope } = this.options.identity
      if (canonicalJsonHash(sourceScope) !== canonicalJsonHash(currentScope)
        || binding.model !== this.options.model || binding.policyVersion !== this.options.policyVersion) {
        throw new DoctorRecommendationExecutionError('plan-conflict')
      }
      return { value: parse(JSON.parse(row.result_json)) }
    }
    return undefined
  }

  #saveCheckpoint(stage: DoctorRecommendationExecutionStage, batchId: string, value: unknown): void {
    this.options.database.driver.prepare(`UPDATE doctor_recommendation_execution_unit
      SET status = 'succeeded', result_json = ?, error_code = NULL, resume_available = 0
      WHERE workspace_id = ? AND epoch = ? AND execution_key = ? AND stage = ? AND batch_id = ?`).run(JSON.stringify(value), ...this.#scope, this.#key, stage, batchId)
  }

  plan(stage: DoctorRecommendationExecutionStage, batches: DoctorRecommendationExecutionBatch[]): void {
    const parsedStage = stageSchema.parse(stage)
    const plan = z.array(batchSchema).max(parsedStage === 'generation' ? 1 : 8).parse(batches)
    if (new Set(plan.map(batch => batch.batchId)).size !== plan.length) throw new DoctorRecommendationExecutionError('plan-conflict')
    this.options.database.driver.transaction(() => {
      const existing = z.object({ plan_json: z.string() }).optional().parse(this.options.database.driver.prepare(`
        SELECT plan_json FROM doctor_recommendation_execution_plan WHERE workspace_id = ? AND epoch = ? AND execution_key = ? AND stage = ?`).get(...this.#scope, this.#key, parsedStage))
      if (existing !== undefined) {
        if (canonicalJsonHash(z.array(batchSchema).parse(JSON.parse(existing.plan_json))) !== canonicalJsonHash(plan)) {
          throw new DoctorRecommendationExecutionError('plan-conflict')
        }
        return
      }
      this.options.database.driver.prepare(`INSERT INTO doctor_recommendation_execution_plan
        (workspace_id, epoch, execution_key, stage, plan_json) VALUES (?, ?, ?, ?, ?)`).run(...this.#scope, this.#key, parsedStage, JSON.stringify(plan))
      for (const batch of plan) this.options.database.driver.prepare(`INSERT INTO doctor_recommendation_execution_unit
        (workspace_id, epoch, execution_key, stage, batch_id, input_hash, dependencies_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`)
        .run(...this.#scope, this.#key, parsedStage, batch.batchId, batch.inputHash, JSON.stringify(batch.dependencies))
    })()
  }

  status(): DoctorRecommendationExecutionStatus {
    return executionStatus(this.#units(), this.#execution().extra_request_count)
  }

  /** Use after a process restart, never to cancel an active dispatch in this process. */
  recoverUnknown(): number {
    let recovered = 0
    const active = activeUnits.get(this.options.database.driver)
    this.options.database.driver.transaction(() => {
      for (const unit of this.#units()) {
        if (unit.status !== 'dispatching' || active?.has(`${this.#key}:${unit.stage}:${unit.batch_id}`)) continue
        recovered += this.options.database.driver.prepare(`UPDATE doctor_recommendation_execution_unit
          SET status = 'unknown', error_code = 'EXECUTION_INTERRUPTED', resume_available = 0
          WHERE workspace_id = ? AND epoch = ? AND execution_key = ? AND stage = ? AND batch_id = ?`)
          .run(...this.#scope, this.#key, unit.stage, unit.batch_id).changes
      }
    })()
    return recovered
  }

  /** The owning Command validates its full input conflict and authorization contract first. */
  continue(intentKey: string): boolean {
    nameSchema.parse(intentKey)
    return this.options.database.driver.transaction(() => {
      const existing = this.options.database.driver.prepare(`SELECT 1 FROM doctor_recommendation_execution_continue
        WHERE workspace_id = ? AND epoch = ? AND execution_key = ? AND intent_key = ?`).get(...this.#scope, this.#key, intentKey)
      if (existing !== undefined) return false
      this.options.assertCurrent()
      const status = this.status()
      if (status.status === 'exhausted') throw new DoctorRecommendationExecutionError('exhausted')
      if (!status.canContinue) throw new DoctorRecommendationExecutionError(status.status === 'running' ? 'running' : 'failed')
      this.options.database.driver.prepare(`INSERT INTO doctor_recommendation_execution_continue
        (workspace_id, epoch, execution_key, intent_key) VALUES (?, ?, ?, ?)`).run(...this.#scope, this.#key, intentKey)
      const unknown = this.#units().find(unit => unit.status === 'unknown')
      if (unknown !== undefined) this.options.database.driver.prepare(`UPDATE doctor_recommendation_execution_unit
        SET resume_available = 1 WHERE workspace_id = ? AND epoch = ? AND execution_key = ? AND stage = ? AND batch_id = ?`)
        .run(...this.#scope, this.#key, unknown.stage, unknown.batch_id)
      this.options.database.driver.prepare(`UPDATE doctor_recommendation_execution_unit SET status = 'pending', error_code = NULL
        WHERE workspace_id = ? AND epoch = ? AND execution_key = ? AND status = 'failed'`).run(...this.#scope, this.#key)
      return true
    })()
  }

  async run<T>(input: { stage: DoctorRecommendationExecutionStage; batchId: string; request: JsonChatCompletionInput }, parse: (value: unknown) => T): Promise<T> {
    const unit = this.#units().find(unit => unit.stage === input.stage && unit.batch_id === input.batchId)
    if (unit === undefined || unit.input_hash !== recommendationRequestHash(input.request) || input.request.model !== this.options.model) {
      throw new DoctorRecommendationExecutionError('plan-conflict')
    }
    this.options.assertCurrent()
    if (unit.status === 'succeeded') return parse(JSON.parse(unit.result_json!))
    if (unit.status !== 'pending' && !(unit.status === 'unknown' && unit.resume_available === 1)) {
      throw new DoctorRecommendationExecutionError(unit.status === 'dispatching' ? 'running' : unit.status === 'unknown' ? 'unknown' : 'failed')
    }
    const dependencies = z.array(dependencySchema).parse(JSON.parse(unit.dependencies_json))
    if (dependencies.some(dependency => !this.#units().some(row => row.stage === dependency.stage
      && row.batch_id === dependency.batchId && row.status === 'succeeded'))) throw new DoctorRecommendationExecutionError('dependency-pending')
    const checkpoint = this.#selectionCheckpoint(unit, parse)
    if (checkpoint !== undefined) {
      this.options.assertCurrent()
      this.#saveCheckpoint(input.stage, input.batchId, checkpoint.value)
      return checkpoint.value
    }
    const active = activeUnits.get(this.options.database.driver) ?? new Set<string>()
    activeUnits.set(this.options.database.driver, active)
    const activeKey = `${this.#key}:${input.stage}:${input.batchId}`
    if (active.has(activeKey)) throw new DoctorRecommendationExecutionError('running')
    active.add(activeKey)
    try {
      while (true) {
        let outstanding = false
        let requests = 0
        let validityFailure = false
        const assertCurrent = () => {
          try { this.options.assertCurrent() } catch (error) { validityFailure = true; throw error }
        }
        try {
          const controlledRequest: JsonChatCompletionInput = { ...input.request,
            validate: value => { if (input.request.validate?.(value) === false) return false; parse(value); return true },
            onBeforeRequest: () => this.options.database.driver.transaction(() => {
              assertCurrent()
              input.request.signal?.throwIfAborted()
              const status = this.status()
              if (status.status === 'exhausted') throw new DoctorRecommendationExecutionError('exhausted')
              const row = this.#units().find(row => row.stage === input.stage && row.batch_id === input.batchId)!
              if (status.units.some(unit => unit.status === 'unknown') && !(row.status === 'unknown' && row.resume_available === 1)) {
                throw new DoctorRecommendationExecutionError('unknown')
              }
              if (row.request_count > 0) this.options.database.driver.prepare(`UPDATE doctor_recommendation_execution
                SET extra_request_count = extra_request_count + 1 WHERE workspace_id = ? AND epoch = ? AND execution_key = ?`).run(...this.#scope, this.#key)
              this.options.database.driver.prepare(`UPDATE doctor_recommendation_execution_unit
                SET status = 'dispatching', resume_available = 0, request_count = request_count + 1 WHERE workspace_id = ? AND epoch = ? AND execution_key = ? AND stage = ? AND batch_id = ?`)
                .run(...this.#scope, this.#key, input.stage, input.batchId)
              outstanding = true
              requests += 1
            })(),
            onRequestComplete: () => { outstanding = false },
          }
          const perFetchControl = this.options.provider.supportsRequestControl === true
          if (!perFetchControl) controlledRequest.onBeforeRequest!()
          const result = await this.options.provider.completeJson(perFetchControl ? controlledRequest : input.request).then(result => {
            if (!perFetchControl) controlledRequest.onRequestComplete!()
            return result
          }, (error: unknown) => {
            // Legacy adapters expose a single external call. No claim covers their hidden internal retries.
            if (!perFetchControl && error instanceof ChatCompletionsError && error.code !== 'AI_TIMEOUT'
              && (error.code !== 'AI_REQUEST_FAILED' || error.httpStatus !== undefined)) controlledRequest.onRequestComplete!()
            throw error
          })
          const value = parse(JSON.parse(result.content))
          assertCurrent()
          this.#saveCheckpoint(input.stage, input.batchId, value)
          return value
        } catch (caught) {
          const error: unknown = caught instanceof ChatCompletionRequestControlError ? caught.cause : caught
          const errorCode = error instanceof ChatCompletionsError ? error.code : error instanceof DoctorRecommendationExecutionError ? error.code : 'EXECUTION_FAILED'
          this.options.database.driver.prepare(`UPDATE doctor_recommendation_execution_unit SET status = ?, error_code = ?
            WHERE workspace_id = ? AND epoch = ? AND execution_key = ? AND stage = ? AND batch_id = ?`).run(outstanding ? 'unknown' : 'failed', errorCode, ...this.#scope, this.#key, input.stage, input.batchId)
          if (validityFailure) throw error
          if (outstanding) throw new DoctorRecommendationExecutionError('unknown', { cause: error })
          if (error instanceof DoctorRecommendationExecutionError) throw error
          const recoverable = error instanceof SyntaxError || error instanceof z.ZodError
            || error instanceof ChatCompletionsError && (error.code === 'AI_RESPONSE_INVALID'
              || (error.code === 'AI_REQUEST_FAILED' && (error.httpStatus === 429 || (error.httpStatus ?? 0) >= 500)))
          if (this.status().status === 'exhausted') throw new DoctorRecommendationExecutionError('exhausted', { cause: error })
          if (!recoverable || requests === 0) throw new DoctorRecommendationExecutionError('failed', { cause: error })
        }
      }
    } finally { active.delete(activeKey) }
  }
}
