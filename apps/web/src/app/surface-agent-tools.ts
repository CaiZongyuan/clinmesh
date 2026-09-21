import {
  parseAgentToolInput,
  type AgentPageContextBinding,
  type AgentReviewDecisionRequest,
  type AgentToolAuthorizationRequest,
  type AgentToolAuthorizationResponse,
  type AgentToolDefinition,
  type AgentToolResultRequest,
} from '@clinmesh/contracts/agent'
import { z } from 'zod'
import type { WebSurfaceAgentTool } from './web-runtime.tsx'
import { isAgentReviewTask, type AgentReviewTask } from './agent-review.tsx'
import { ApiClientError } from './api-client.ts'

const editingInstruction = '每次调用 JSON 须显式传入当前 schema 的 contextId、scopeKey 的 const 值，不复用历史值；const 不会自动填入。读取不消耗绑定，无须把写入放在回合首位。缺参则补齐；绑定失效则等待工具定义更新。填写或保存草稿前用 clinmesh_read_current_context 读取当前授权页面及未保存内容，根据用户意图判断是否询问覆盖；这是沟通约定，不是强制覆盖授权或并发修改保护。正式医院动作仍须应用内人工审阅，聊天同意不能替代。'

export interface SurfaceAgentPageAction {
  description: string
  enabled?: boolean
  execute(input: unknown, signal: AbortSignal): unknown | Promise<unknown>
  parameters: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: readonly string[]
    additionalProperties?: boolean
  }
}

export interface AgentActionFeedback {
  id: string
  operationId: string
  input: unknown
  phase: 'executing' | 'completed' | 'awaiting-review' | 'submitting' | 'rejected' | 'failed' | 'unconfirmed'
  message?: string
}

interface BuildSurfaceAgentToolsInput {
  actions: Readonly<Record<string, SurfaceAgentPageAction>>
  authorize(request: AgentToolAuthorizationRequest, signal: AbortSignal): Promise<AgentToolAuthorizationResponse>
  binding: AgentPageContextBinding
  complete(request: AgentToolResultRequest, signal: AbortSignal): Promise<unknown>
  definitions: readonly AgentToolDefinition[]
  issueProof(input: {
    contextId: string
    scopeKey: string
    signal: AbortSignal
    toolName: string
  }): Promise<string>
  onExecutionSettled?(): void
  onExecutionStart?(): void
  onActionFeedback?(event: AgentActionFeedback): void
  readState(): unknown
  review(request: AgentReviewDecisionRequest, signal: AbortSignal): Promise<unknown>
  strictDefinitions?: boolean
}

export function buildSurfaceAgentTools(
  input: BuildSurfaceAgentToolsInput,
): WebSurfaceAgentTool[] {
  if (input.strictDefinitions === true) {
    const missing = input.definitions.filter(definition => (
      input.binding.snapshot.allowedOperationIds.includes(definition.operationId)
      && definition.operationId !== 'ui.context.read'
      && input.actions[definition.operationId] === undefined
    ))
    if (missing.length > 0) {
      throw new Error(`ClinMesh page is missing Agent actions: ${missing
        .map(definition => definition.operationId).join(', ')}`)
    }
  }
  return input.definitions.flatMap(definition => {
    if (!input.binding.snapshot.allowedOperationIds.includes(definition.operationId)) return []
    const action = definition.operationId === 'ui.context.read'
      ? contextReadAction(input)
      : input.actions[definition.operationId]
    if (action === undefined || action.enabled === false) return []
    return [{
      description: [action.description, editingInstruction].join(' '),
      name: definition.toolName,
      parameters: bindContextParameters(
        action.parameters,
        input.binding.snapshot.id,
        input.binding.snapshot.scopeKey,
      ),
      execute: async (raw, signal) => {
        input.onExecutionStart?.()
        const id = crypto.randomUUID()
        let feedback: ((phase: AgentActionFeedback['phase'], message?: string) => void) | undefined
        const onAbort = (): void => feedback?.('unconfirmed', '操作已中断，结果尚未确认；请读取当前状态。')
        try {
          const values = requireBoundInput(
            raw,
            input.binding.snapshot.id,
            input.binding.snapshot.scopeKey,
          )
          const actionInput = z.json().parse(parseAgentToolInput(
            definition.operationId,
            Object.fromEntries(Object.entries(values).filter(([key]) => (
              key !== 'contextId' && key !== 'scopeKey'
            ))),
          ))
          const executionProof = await input.issueProof({
            contextId: input.binding.snapshot.id,
            signal,
            scopeKey: input.binding.snapshot.scopeKey,
            toolName: definition.toolName,
          })
          const authorization = await input.authorize({
            contextToken: input.binding.token,
            executionProof,
            input: actionInput,
            operationId: definition.operationId,
          }, signal).catch((error: unknown) => {
            if (error instanceof ApiClientError && [
              'AGENT_CONTEXT_EXPIRED', 'AGENT_CONTEXT_INVALID', 'AGENT_CONTEXT_STALE',
            ].includes(error.code)) {
              throw new Error(`${error.code}: ${error.message}。本次动作尚未执行。请等待 ClinMesh 页面更新工具定义，按当前工具 schema 的 const 重新传入 contextId、scopeKey，并读取当前页面状态后再决定是否重试。不要沿用历史消息中的绑定值；若工具持续未更新，请重新打开 ClinMesh 工作台。`, { cause: error })
            }
            throw error
          })
          signal.throwIfAborted()
          if (definition.operationId !== 'ui.context.read' && !definition.operationId.endsWith('.read')) {
            feedback = (phase, message) => input.onActionFeedback?.({
              id, operationId: definition.operationId, input: actionInput, phase,
              ...(message === undefined ? {} : { message }),
            })
          }
          feedback?.('executing')
          signal.addEventListener('abort', onAbort, { once: true })
          let actionResolved = false
          try {
            const data = await action.execute(actionInput, signal)
            actionResolved = true
            if (isAgentReviewTask(data)) {
              if (definition.mode !== 'proposal' || authorization.proposalId === undefined) {
                throw new Error('ClinMesh review requires an authorized Agent proposal')
              }
              settleAgentReview(
                data,
                authorization.receiptToken,
                input.review,
                input.complete,
                feedback,
                definition.operationId,
              )
              feedback?.('awaiting-review')
              return JSON.stringify({
                data: {
                  proposalId: authorization.proposalId,
                  status: 'awaiting-human-review',
                },
                ok: true,
              })
            }
            const result = normalizeJsonValue(data)
            await input.complete({
              ok: true,
              receiptToken: authorization.receiptToken,
              result,
            }, signal)
            feedback?.(signal.aborted ? 'unconfirmed' : 'completed')
            return JSON.stringify({ data: result, ok: true })
          } catch (error) {
            const message = error instanceof Error ? error.message : 'ClinMesh page action failed'
            const phase = signal.aborted || actionResolved ? 'unconfirmed' : errorFeedbackPhase(error)
            feedback?.(phase, feedbackErrorMessage(phase, message))
            if (!actionResolved) {
              await input.complete({
                error: message,
                ok: false,
                receiptToken: authorization.receiptToken,
              }, signal)
            }
            throw new Error(message)
          }
        } finally {
          signal.removeEventListener('abort', onAbort)
          input.onExecutionSettled?.()
        }
      },
    }]
  })
}

function settleAgentReview(
  task: AgentReviewTask,
  receiptToken: string,
  review: BuildSurfaceAgentToolsInput['review'],
  complete: BuildSurfaceAgentToolsInput['complete'],
  feedback?: (phase: AgentActionFeedback['phase'], message?: string) => void,
  operationId?: string,
): void {
  const completionSignal = new AbortController().signal
  task.bindDecisionGate(async decision => {
    if (decision === 'approved') feedback?.('submitting')
    await review({ decision, receiptToken }, completionSignal)
  })
  void task.decision.then(
    async result => {
      await complete({
        ok: true,
        receiptToken,
        result: z.json().parse(result),
      }, completionSignal)
      if (!result.approved) feedback?.('rejected')
      else if (operationId === 'billing.payment.confirm.propose') {
        feedback?.(paymentFeedbackPhase(result.data))
      } else feedback?.('completed')
    },
    async error => {
      const phase = errorFeedbackPhase(error)
      feedback?.(phase, feedbackErrorMessage(phase, error instanceof Error ? error.message : '人工审阅未完成'))
      await complete({
        error: error instanceof Error ? error.message : 'ClinMesh Agent review was cancelled',
        ok: false,
        receiptToken,
      }, completionSignal)
    },
  ).catch(() => feedback?.('unconfirmed', '操作结果尚未确认，请读取当前状态。'))
}

function errorFeedbackPhase(error: unknown): 'failed' | 'unconfirmed' {
  if (error instanceof ApiClientError && (error.status === 0 || error.status >= 500
    || error.code === 'UNEXPECTED_RESPONSE')) return 'unconfirmed'
  return 'failed'
}

function feedbackErrorMessage(phase: AgentActionFeedback['phase'], message: string): string {
  return phase === 'unconfirmed' ? `${message}；结果尚未确认，请读取当前状态。` : message
}

function paymentFeedbackPhase(response: unknown): AgentActionFeedback['phase'] {
  const data = typeof response === 'object' && response !== null && 'data' in response ? response.data : undefined
  const outcome = typeof data === 'object' && data !== null && 'outcome' in data ? data.outcome : undefined
  if (outcome === 'success') return 'completed'
  if (outcome === 'declined') return 'failed'
  return 'unconfirmed'
}

function contextReadAction(input: BuildSurfaceAgentToolsInput): SurfaceAgentPageAction {
  return {
    description: 'Read the current authorized ClinMesh page context and visible UI state.',
    execute: () => ({
      pageState: input.readState(),
      snapshot: input.binding.snapshot,
    }),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }
}

function normalizeJsonValue(value: unknown) {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new TypeError('ClinMesh page action result must be JSON serializable')
  }
  return z.json().parse(JSON.parse(serialized))
}

function bindContextParameters(
  parameters: SurfaceAgentPageAction['parameters'],
  contextId: string,
  scopeKey: string,
): Record<string, unknown> {
  return projectDshToolSchema({
    type: 'object',
    properties: {
      contextId: { type: 'string', const: contextId, description: '必填：显式传入此处的 const 值，不复用历史 Context ID。' },
      scopeKey: { type: 'string', const: scopeKey, description: '必填：显式传入此处的 const 值，与当前 contextId 配对。' },
      ...parameters.properties,
    },
    required: ['contextId', 'scopeKey', ...(parameters.required ?? [])],
    additionalProperties: false,
  })
}

function projectDshToolSchema(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('ClinMesh Tool schemas must contain object nodes')
  }
  const schema = value as Record<string, unknown>
  const projected: Record<string, unknown> = {}
  for (const annotation of ['description', 'title', 'default', 'examples'] as const) {
    if (schema[annotation] !== undefined) projected[annotation] = schema[annotation]
  }
  if (schema.type !== undefined) projected.type = schema.type
  if (Array.isArray(schema.oneOf)) {
    projected.oneOf = schema.oneOf.map(projectDshToolSchema)
  }
  if (typeof schema.properties === 'object' && schema.properties !== null) {
    projected.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, child]) => [key, projectDshToolSchema(child)]),
    )
  }
  if (Array.isArray(schema.required)) projected.required = schema.required
  if (typeof schema.additionalProperties === 'boolean') {
    projected.additionalProperties = schema.additionalProperties
  }
  if (schema.items !== undefined) projected.items = projectDshToolSchema(schema.items)
  if (Array.isArray(schema.enum)) projected.enum = schema.enum
  if (schema.const !== undefined) projected.const = schema.const
  return projected
}

function requireBoundInput(
  value: unknown,
  contextId: string,
  scopeKey: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('ClinMesh Tool input must be an object')
  }
  const input = value as Record<string, unknown>
  const invalidFields = ['contextId', 'scopeKey'].filter(key => (
    typeof input[key] !== 'string' || input[key].length === 0
  ))
  if (invalidFields.length > 0) {
    throw new TypeError(`CLINMESH_BINDING_ARGUMENTS_INVALID: 调用 JSON 缺少或包含无效的绑定参数：${invalidFields.join(', ')}。尚未执行。请显式传入当前工具 schema 的 const 值；const 不会自动填入。`)
  }
  if (input.contextId !== contextId || input.scopeKey !== scopeKey) {
    throw new TypeError('CLINMESH_BINDING_MISMATCH: contextId 或 scopeKey 与当前页面不匹配，尚未执行。请使用当前工具 schema 的 const 值并读取当前页面状态后重试，不要沿用历史消息中的绑定值。')
  }
  return input
}
