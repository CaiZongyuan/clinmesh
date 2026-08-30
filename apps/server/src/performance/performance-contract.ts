import { z } from 'zod'

export const performanceProfileSchema = z.enum([
  'ci',
  'full-import',
  'saturation',
  'trajectory',
])

const durationSummarySchema = z.object({
  maximum: z.number().nonnegative(),
  mean: z.number().nonnegative(),
  minimum: z.number().nonnegative(),
  p50: z.number().nonnegative(),
  p95: z.number().nonnegative(),
  p99: z.number().nonnegative(),
}).strict()

export const performanceWorkloadResultSchema = z.object({
  actors: z.number().int().positive(),
  busyCount: z.number().int().nonnegative(),
  databaseBytes: z.object({
    after: z.number().int().nonnegative(),
    before: z.number().int().nonnegative(),
    growth: z.number().int(),
  }).strict(),
  errorCount: z.number().int().nonnegative(),
  iterations: z.number().int().positive(),
  latencyMs: durationSummarySchema,
  name: z.string().min(1),
  path: z.enum(['application', 'http', 'sqlite']),
  queryCount: z.number().int().nonnegative(),
  queryPlan: z.array(z.string().min(1)),
  retryCount: z.number().int().nonnegative(),
  rowsWritten: z.number().int().nonnegative(),
  statementCount: z.number().int().nonnegative(),
  throughputPerSecond: z.number().nonnegative(),
  trace: z.object({
    bytes: z.number().int().nonnegative(),
    rows: z.number().int().nonnegative(),
  }).strict(),
  transactionMs: durationSummarySchema,
  writeCount: z.number().int().nonnegative(),
}).strict()

export const performanceResultSchema = z.object({
  environment: z.object({
    node: z.string().min(1),
    platform: z.string().min(1),
    sqlite: z.string().min(1),
  }).strict(),
  finishedAt: z.iso.datetime({ offset: true }),
  profile: performanceProfileSchema,
  schemaVersion: z.literal('1'),
  startedAt: z.iso.datetime({ offset: true }),
  workloads: z.array(performanceWorkloadResultSchema).min(1),
}).strict()

export const performanceBaselineSchema = z.object({
  schemaVersion: z.literal('1'),
  workloads: z.record(z.string(), z.object({
    maximumBusyCount: z.number().int().nonnegative(),
    maximumDatabaseGrowthBytes: z.number().int().nonnegative(),
    maximumErrorCount: z.number().int().nonnegative(),
    maximumQueriesPerIteration: z.number().nonnegative(),
    maximumRetryCount: z.number().int().nonnegative(),
    maximumRowsWrittenPerIteration: z.number().nonnegative(),
    maximumStatementsPerIteration: z.number().nonnegative(),
    maximumTraceBytesPerIteration: z.number().nonnegative(),
    maximumTraceRowsPerIteration: z.number().nonnegative(),
    maximumWritesPerIteration: z.number().nonnegative(),
    minimumRowsWrittenPerIteration: z.number().nonnegative(),
    requiredQueryPlan: z.string().min(1).optional(),
  }).strict()),
}).strict()

export type PerformanceWorkloadResult = z.infer<typeof performanceWorkloadResultSchema>

function percentile(sorted: readonly number[], proportion: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.max(0, Math.ceil(sorted.length * proportion) - 1)] ?? 0
}

export function summarizeDurations(values: readonly number[]) {
  if (values.length === 0) {
    return { maximum: 0, mean: 0, minimum: 0, p50: 0, p95: 0, p99: 0 }
  }
  const sorted = [...values].toSorted((left, right) => left - right)
  return {
    maximum: sorted.at(-1) ?? 0,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    minimum: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  }
}

export function assertPerformanceBaseline(
  workloadInputs: readonly PerformanceWorkloadResult[],
  baselineInput: unknown,
): void {
  const baseline = performanceBaselineSchema.parse(baselineInput)
  const workloads = new Map(workloadInputs.map(workload => [workload.name, workload]))
  if (workloads.size !== workloadInputs.length) {
    throw new Error('Performance workload names must be unique')
  }
  for (const workload of workloadInputs) {
    if (baseline.workloads[workload.name] === undefined) {
      throw new Error(`Performance baseline is missing: ${workload.name}`)
    }
  }
  for (const [name, budget] of Object.entries(baseline.workloads)) {
    const workload = workloads.get(name)
    if (workload === undefined) throw new Error(`Performance workload is missing: ${name}`)
    if (workload.statementCount / workload.iterations > budget.maximumStatementsPerIteration) {
      throw new Error(`${name} exceeded its statement budget`)
    }
    if (workload.writeCount / workload.iterations > budget.maximumWritesPerIteration) {
      throw new Error(`${name} exceeded its write budget`)
    }
    if (workload.queryCount / workload.iterations > budget.maximumQueriesPerIteration) {
      throw new Error(`${name} exceeded its query budget`)
    }
    if (workload.rowsWritten / workload.iterations > budget.maximumRowsWrittenPerIteration) {
      throw new Error(`${name} exceeded its rows-written ceiling`)
    }
    if (workload.rowsWritten / workload.iterations < budget.minimumRowsWrittenPerIteration) {
      throw new Error(`${name} did not meet its rows-written floor`)
    }
    if (workload.databaseBytes.growth > budget.maximumDatabaseGrowthBytes) {
      throw new Error(`${name} exceeded its database-growth budget`)
    }
    if (workload.trace.rows / workload.iterations > budget.maximumTraceRowsPerIteration) {
      throw new Error(`${name} exceeded its Trace-row budget`)
    }
    if (workload.trace.bytes / workload.iterations > budget.maximumTraceBytesPerIteration) {
      throw new Error(`${name} exceeded its Trace-byte budget`)
    }
    if (workload.busyCount > budget.maximumBusyCount) {
      throw new Error(`${name} exceeded its busy budget`)
    }
    if (workload.errorCount > budget.maximumErrorCount) {
      throw new Error(`${name} exceeded its error budget`)
    }
    if (workload.retryCount > budget.maximumRetryCount) {
      throw new Error(`${name} exceeded its retry budget`)
    }
    if (budget.requiredQueryPlan !== undefined
      && (workload.queryPlan.length === 0
        || workload.queryPlan.some(detail => !detail.includes(budget.requiredQueryPlan!)))) {
      throw new Error(`${name} did not use its required query plan`)
    }
  }
}
