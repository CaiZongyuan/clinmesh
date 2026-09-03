type RuntimeErrorScope =
  | 'http'
  | 'laboratory-service-publication-dispatch'
  | 'outbox-dispatch'
  | 'patient-brief-dispatch'
  | 'scenario-generation-dispatch'

const safeErrorNames = new Set([
  'AggregateError',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
])

interface RuntimeErrorReportInput {
  correlationId?: string
  error: unknown
  method?: string
  route?: string
  scope: RuntimeErrorScope
}

function errorName(error: unknown): string {
  if (!(error instanceof Error) || !safeErrorNames.has(error.name)) return 'UnknownError'
  return error.name
}

function createRuntimeErrorReport(input: RuntimeErrorReportInput) {
  return {
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    error: { name: errorName(input.error) },
    event: 'runtime.error' as const,
    ...(input.method === undefined ? {} : { method: input.method }),
    ...(input.route === undefined ? {} : { route: input.route }),
    scope: input.scope,
    timestamp: new Date().toISOString(),
  }
}

export function reportRuntimeError(input: RuntimeErrorReportInput): void {
  console.error(JSON.stringify(createRuntimeErrorReport(input)))
}
