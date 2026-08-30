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
      description: action.description,
      name: definition.toolName,
      parameters: bindContextParameters(
        action.parameters,
        input.binding.snapshot.id,
        input.binding.snapshot.scopeKey,
      ),
      execute: async (raw, signal) => {
        input.onExecutionStart?.()
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
          }, signal)
          try {
            const data = await action.execute(actionInput, signal)
            if (isAgentReviewTask(data)) {
              if (definition.mode !== 'proposal' || authorization.proposalId === undefined) {
                throw new Error('ClinMesh review requires an authorized Agent proposal')
              }
              settleAgentReview(
                data,
                authorization.receiptToken,
                input.review,
                input.complete,
              )
              return JSON.stringify({
                data: {
                  proposalId: authorization.proposalId,
                  status: 'awaiting-human-review',
                },
                ok: true,
              })
            }
            const result = z.json().parse(data)
            await input.complete({
              ok: true,
              receiptToken: authorization.receiptToken,
              result,
            }, signal)
            return JSON.stringify({ data: result, ok: true })
          } catch (error) {
            const message = error instanceof Error ? error.message : 'ClinMesh page action failed'
            await input.complete({
              error: message,
              ok: false,
              receiptToken: authorization.receiptToken,
            }, signal)
            throw new Error(message)
          }
        } finally {
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
): void {
  const completionSignal = new AbortController().signal
  task.bindDecisionGate(async decision => {
    await review({ decision, receiptToken }, completionSignal)
  })
  void task.decision.then(
    result => complete({
      ok: true,
      receiptToken,
      result: z.json().parse(result),
    }, completionSignal),
    error => complete({
      error: error instanceof Error ? error.message : 'ClinMesh Agent review was cancelled',
      ok: false,
      receiptToken,
    }, completionSignal),
  ).catch(() => undefined)
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

function bindContextParameters(
  parameters: SurfaceAgentPageAction['parameters'],
  contextId: string,
  scopeKey: string,
): Record<string, unknown> {
  return projectDshToolSchema({
    type: 'object',
    properties: {
      contextId: { type: 'string', enum: [contextId] },
      scopeKey: { type: 'string', enum: [scopeKey] },
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
  if (input.contextId !== contextId || input.scopeKey !== scopeKey) {
    throw new TypeError('ClinMesh Tool input does not match the active page scope')
  }
  return input
}
