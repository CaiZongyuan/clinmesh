import type {
  SqlitePerformanceObserver,
  SqliteStatementMeasurement,
} from '../infrastructure/sqlite/performance-observer.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'

export interface SqlitePerformanceSnapshot {
  queryCount: number
  rowsWritten: number
  statementCount: number
  statementDurationsMs: number[]
  statementSources: string[]
  transactionDurationsMs: number[]
  writeCount: number
}

export function readActionTraceMetrics(
  database: ClinMeshDatabase,
): { bytes: number; rows: number } {
  return database.driver.prepare(`
    SELECT COUNT(*) AS rows,
      COALESCE(SUM(
        length(CAST(workspace_id AS BLOB))
        + length(CAST(epoch AS BLOB))
        + length(CAST(scenario_run_id AS BLOB))
        + length(CAST(trace_id AS BLOB))
        + length(CAST(actor_id AS BLOB))
        + length(CAST(operation AS BLOB))
        + length(CAST(outcome AS BLOB))
        + length(CAST(effect_json AS BLOB))
        + length(CAST(virtual_timestamp AS BLOB))
      ), 0) AS bytes
    FROM action_trace
  `).get() as { bytes: number; rows: number }
}

export class SqlitePerformanceProbe implements SqlitePerformanceObserver {
  #measurements: SqliteStatementMeasurement[] = []
  #transactionDurationsMs: number[] = []

  observeStatement(measurement: SqliteStatementMeasurement): void {
    this.#measurements.push(measurement)
  }

  observeTransaction(durationMs: number): void {
    this.#transactionDurationsMs.push(durationMs)
  }

  reset(): void {
    this.#measurements = []
    this.#transactionDurationsMs = []
  }

  snapshot(): SqlitePerformanceSnapshot {
    return {
      queryCount: this.#measurements.filter(item => item.kind === 'query').length,
      rowsWritten: this.#measurements.reduce((sum, item) => sum + item.rowsWritten, 0),
      statementCount: this.#measurements.length,
      statementDurationsMs: this.#measurements.map(item => item.durationMs),
      statementSources: this.#measurements.map(item => item.sql),
      transactionDurationsMs: [...this.#transactionDurationsMs],
      writeCount: this.#measurements.filter(item => item.kind === 'write').length,
    }
  }
}
