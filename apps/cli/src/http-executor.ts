import { getHisOperation } from '@clinmesh/contracts/his-operations'
import { apiErrorSchema } from '@clinmesh/contracts/his'
import { operationOutcomeSchema } from '@clinmesh/contracts/fhir'

export type HttpCredential =
  | { cookie: string; kind: 'human' }
  | { kind: 'agent'; token: string }

interface HttpExecutorOptions {
  baseUrl: string
  credential: HttpCredential
  fetch?: typeof globalThis.fetch
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
    execution?: { idempotencyKey?: string },
  ): Promise<unknown> => {
    const operation = getHisOperation(operationId)
    const input = operation.input.parse(rawInput) as Record<string, unknown>
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
      const write = operation.http.method !== 'GET'
      throw new HttpOperationError(write ? 7 : 4, {
        code: write ? 'ambiguous_outcome' : 'transport_error',
        ...(execution?.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: execution.idempotencyKey }),
        message: write
          ? 'The request may have reached ClinMesh; query the Command receipt before retrying'
          : 'The ClinMesh request failed before a response was received',
        operationId,
        outcome: write ? 'ambiguous' : 'definitely_not_sent',
        retryable: !write,
        type: 'network',
      }, { cause })
    }
    const payload = await response.json() as unknown
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(payload)
      const operationOutcome = operationOutcomeSchema.safeParse(payload)
      const fhirIssue = operationOutcome.success ? operationOutcome.data.issue[0] : undefined
      const serverError = parsed.success
        ? parsed.data.error
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
      throw new HttpOperationError(classification.exitCode, {
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
        retryable: response.status === 429 || response.status >= 500,
        type: classification.type,
      })
    }
    return operation.output.parse(payload)
  }
}
