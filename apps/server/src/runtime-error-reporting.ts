type RuntimeErrorScope =
  | 'http'
  | 'laboratory-service-publication-dispatch'
  | 'outbox-dispatch'
  | 'patient-brief-dispatch'
  | 'scenario-generation-dispatch'

interface RuntimeErrorReportInput {
  correlationId?: string
  error: unknown
  method?: string
  path?: string
  scope: RuntimeErrorScope
}

function errorName(error: unknown): string {
  if (!(error instanceof Error) || !/^[A-Za-z][A-Za-z0-9]*$/.test(error.name)) return 'UnknownError'
  return error.name
}

function stackFrames(error: unknown): string[] {
  if (!(error instanceof Error) || error.stack === undefined) return []
  return error.stack
    .split('\n')
    .slice(1)
    .map(frame => frame.trim())
    .filter(frame => frame.startsWith('at '))
    .slice(0, 8)
}

function createRuntimeErrorReport(input: RuntimeErrorReportInput) {
  return {
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    error: {
      name: errorName(input.error),
      stackFrames: stackFrames(input.error),
    },
    event: 'runtime.error' as const,
    ...(input.method === undefined ? {} : { method: input.method }),
    ...(input.path === undefined ? {} : { path: input.path }),
    scope: input.scope,
    timestamp: new Date().toISOString(),
  }
}

export function reportRuntimeError(input: RuntimeErrorReportInput): void {
  console.error(JSON.stringify(createRuntimeErrorReport(input)))
}
