import { getHisOperation } from '@clinmesh/contracts/his-operations'
import { apiErrorSchema } from '@clinmesh/contracts/his'
import { operationOutcomeSchema } from '@clinmesh/contracts/fhir'
import { z } from 'zod'

export type HttpCredential =
  | { cookie: string; kind: 'human' }
  | { kind: 'agent'; token: string }

interface HttpExecutorOptions {
  baseUrl: string
  credential: HttpCredential
  fetch?: typeof globalThis.fetch
}

const plainHttpErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
}).loose()

export interface HttpExecutionContext {
  idempotencyKey?: string
}

export class HttpOperationError extends Error {
  readonly exitCode: number
  readonly problem: {
    code: string
    conflict?: unknown
    idempotencyKey?: string
    message: string
    operationId: string
    outcome: 'ambiguous' | 'definitely_not_sent'
    retryable: boolean
    type: string
  }

  constructor(
    exitCode: number,
    problem: HttpOperationError['problem'],
    options?: ErrorOptions,
  ) {
    super(problem.message, options)
    this.name = 'HttpOperationError'
    this.exitCode = exitCode
    this.problem = problem
  }
}

function ambiguousRecoveryMessage(operationId: string): string {
  if (operationId === 'agent.grant.create') {
    return 'The Grant may have been created without returning its token; inspect and revoke it, then mint a new Grant with a new idempotency key'
  }
  if (operationId.startsWith('agent.')) {
    return 'The control-plane mutation may have reached ClinMesh; inspect current state before retrying with the same idempotency key'
  }
  if (operationId.startsWith('auth.')) {
    return 'The authentication change may have reached ClinMesh; inspect the current authentication context before retrying'
  }
  return 'The request may have reached ClinMesh; query the Command receipt before retrying'
}

export function transportError(
  operationId: string,
  write: boolean,
  execution: HttpExecutionContext | undefined,
  cause: unknown,
): HttpOperationError {
  return new HttpOperationError(write ? 7 : 4, {
    code: write ? 'ambiguous_outcome' : 'transport_error',
    ...(execution?.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: execution.idempotencyKey }),
    message: write
      ? ambiguousRecoveryMessage(operationId)
      : 'The ClinMesh request failed before a complete response was received',
    operationId,
    outcome: write ? 'ambiguous' : 'definitely_not_sent',
    retryable: !write,
    type: 'network',
  }, { cause })
}

export function invalidResponseError(
  operationId: string,
  write: boolean,
  execution: HttpExecutionContext | undefined,
  cause: unknown,
): HttpOperationError {
  return new HttpOperationError(write ? 7 : 8, {
    code: 'invalid_response',
    ...(execution?.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: execution.idempotencyKey }),
    message: write
      ? ambiguousRecoveryMessage(operationId)
      : 'ClinMesh returned a response that does not match the operation contract',
    operationId,
    outcome: write ? 'ambiguous' : 'definitely_not_sent',
    retryable: false,
    type: 'protocol',
  }, { cause })
}

function httpResponseError(
  response: Response,
  payload: unknown,
  operationId: string,
  write: boolean,
  execution?: HttpExecutionContext,
): HttpOperationError {
  if (write && response.status >= 500) {
    return new HttpOperationError(7, {
      code: 'ambiguous_outcome',
      ...(execution?.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: execution.idempotencyKey }),
      message: ambiguousRecoveryMessage(operationId),
      operationId,
      outcome: 'ambiguous',
      retryable: false,
      type: 'api',
    })
  }
  const parsed = apiErrorSchema.safeParse(payload)
  const plainError = plainHttpErrorSchema.safeParse(payload)
  const operationOutcome = operationOutcomeSchema.safeParse(payload)
  const fhirIssue = operationOutcome.success ? operationOutcome.data.issue[0] : undefined
  const serverError = parsed.success
    ? parsed.data.error
    : plainError.success
      ? plainError.data
      : fhirIssue === undefined
        ? {
            code: `HTTP_${response.status}`,
            message: `ClinMesh operation failed with HTTP ${response.status}`,
          }
        : {
            code: fhirIssue.code,
            message: fhirIssue.diagnostics ?? 'The FHIR operation failed',
          }
  const classification = response.status === 400 || response.status === 422
    ? { exitCode: 2, type: 'validation' }
    : response.status === 401
      ? { exitCode: 3, type: 'authentication' }
      : response.status === 403
        ? { exitCode: 3, type: 'authorization' }
        : response.status === 409
          ? { exitCode: 5, type: 'conflict' }
          : { exitCode: 1, type: 'api' }
  return new HttpOperationError(classification.exitCode, {
    code: serverError.code,
    ...('conflict' in serverError && serverError.conflict !== undefined
      ? { conflict: serverError.conflict }
      : {}),
    ...(execution?.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: execution.idempotencyKey }),
    message: serverError.message,
    operationId,
    outcome: 'definitely_not_sent',
    retryable: response.status === 429,
    type: classification.type,
  })
}

export async function parseHttpResponse<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
  operationId: string,
  write: boolean,
  execution?: HttpExecutionContext,
): Promise<z.infer<Schema>> {
  let payload: unknown
  try {
    payload = await response.json() as unknown
  } catch (cause) {
    throw invalidResponseError(operationId, write, execution, cause)
  }
  if (!response.ok) {
    throw httpResponseError(response, payload, operationId, write, execution)
  }
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    throw invalidResponseError(operationId, write, execution, parsed.error)
  }
  return parsed.data
}

function encodePath(
  template: string,
  input: Record<string, unknown>,
): { path: string; remaining: Record<string, unknown> } {
  const remaining = { ...input }
  const path = template.replaceAll(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name: string) => {
    const value = remaining[name]
    if (typeof value !== 'string' || value === '') {
      throw new Error(`Missing path parameter: ${name}`)
    }
    Reflect.deleteProperty(remaining, name)
    return encodeURIComponent(value)
  })
  return { path, remaining }
}

function encodeQuery(input: Record<string, unknown>): URLSearchParams {
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) query.append(name, String(item))
    } else {
      query.set(name, String(value))
    }
  }
  return query
}

export function createHttpExecutor(options: HttpExecutorOptions) {
  const baseUrl = new URL(options.baseUrl)
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new Error('ClinMesh server URL must use HTTP or HTTPS')
  }
  const request = options.fetch ?? globalThis.fetch

  return async (
    operationId: string,
    rawInput: unknown,
    execution?: HttpExecutionContext,
  ): Promise<unknown> => {
    const operation = getHisOperation(operationId)
    const input = operation.input.parse(rawInput) as Record<string, unknown>
    const write = operation.http.method !== 'GET'
    const { path, remaining } = encodePath(operation.http.path, input)
    const url = new URL(path, baseUrl)
    if (operation.http.method === 'GET') {
      const query = operation.http.encodeQuery === undefined
        ? remaining
        : operation.http.encodeQuery(input)
      url.search = encodeQuery(query).toString()
    }
    const headers: Record<string, string> = { accept: 'application/json' }
    if (options.credential.kind === 'human') {
      headers.cookie = options.credential.cookie
    } else {
      headers.authorization = `Bearer ${options.credential.token}`
    }
    if (execution?.idempotencyKey !== undefined) {
      headers['idempotency-key'] = execution.idempotencyKey
    }

    let body: string | undefined
    if (operation.http.method !== 'GET') {
      if (operation.http.encodeBody === undefined) {
        throw new Error(`HIS operation is missing an HTTP body encoder: ${operation.id}`)
      }
      headers['content-type'] = 'application/json'
      if (options.credential.kind === 'human') headers.origin = baseUrl.origin
      body = JSON.stringify(operation.http.encodeBody(input))
    }

    let response: Response
    try {
      response = await request(url, {
        ...(body === undefined ? {} : { body }),
        headers,
        method: operation.http.method,
      })
    } catch (cause) {
      throw transportError(operationId, write, execution, cause)
    }
    let payload: unknown
    try {
      payload = await response.json() as unknown
    } catch (cause) {
      throw transportError(operationId, write, execution, cause)
    }
    if (!response.ok) {
      throw httpResponseError(response, payload, operationId, write, execution)
    }
    const parsed = operation.output.safeParse(payload)
    if (!parsed.success) {
      throw invalidResponseError(operationId, write, execution, parsed.error)
    }
    return parsed.data
  }
}
